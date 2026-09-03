"use strict";
// quire / git
//
// notes that live in a repo should say so. this puts the branch and the dirty
// count in the status bar and gives the palette enough verbs to commit without
// leaving the editor.

(function (Q) {
  const git = (Q.git = {});
  let slot = null;
  let inRepo = false;

  const run = (args) => {
    const dir = Q.doc.dir();
    if (!dir) return Promise.resolve({ ok: false, out: "", err: "no file" });
    return Q.shell(`git -C ${Q.sh(dir)} ` + args, dir);
  };

  git.root = () => run("rev-parse --show-toplevel").then((r) => (r.ok ? r.out : ""));

  git.status = function () {
    return run("rev-parse --abbrev-ref HEAD").then((b) => {
      if (!b.ok || !b.out) { inRepo = false; return null; }
      inRepo = true;
      return run("status --porcelain").then((s) => {
        const lines = s.out ? s.out.split("\n").filter(Boolean) : [];
        return {
          branch: b.out,
          dirty: lines.length,
          staged: lines.filter((l) => l[0] !== " " && l[0] !== "?").length,
          files: lines,
        };
      });
    }).catch(() => null);
  };

  const refresh = Q.debounce(function () {
    if (!Q.prefs().gitInStatusBar) { if (slot) slot.set(""); return; }
    git.status().then((s) => {
      if (!slot) slot = Q.ui.slot("git", { order: 30, side: "left", onClick: () => Q.run("gitStatus") });
      if (!s) return slot.set("");
      slot.set(
        (Q.icon ? Q.icon("branch", 13) : "") +
        '<span class="q-git-branch">' + Q.esc(s.branch) + "</span>" +
        (s.dirty ? '<span class="q-git-dirty">' + s.dirty + "</span>" : ""),
        s.dirty ? s.dirty + " changed file(s) on " + s.branch : "clean · " + s.branch
      );
    });
  }, 400);

  git.refresh = refresh;
  Q.on("doc", refresh);
  Q.on("saved", refresh);

  // ---- commands -------------------------------------------------------------

  Q.command({
    id: "gitStatus", title: "Git: status", category: "Git",
    run: () => git.status().then((s) => {
      if (!s) return Q.ui.toast("not a git repository");
      Q.ui.modal({
        title: "git · " + s.branch,
        wide: true,
        body: s.files.length
          ? '<pre class="q-pre">' + Q.esc(s.files.join("\n")) + "</pre>"
          : "<p>working tree clean.</p>",
        buttons: s.files.length
          ? [{ label: "Commit all…", primary: true, run: () => Q.run("gitCommit") }]
          : [],
      });
    }),
  });

  Q.command({
    id: "gitCommit", title: "Git: commit everything", category: "Git", keys: "mod+alt+c",
    run: function () {
      return git.status().then((s) => {
        if (!s) return Q.ui.toast("not a git repository");
        if (!s.dirty) return Q.ui.toast("nothing to commit");
        return Q.ui.prompt("Commit " + s.dirty + " file(s) on " + s.branch, "", "message").then((msg) => {
          if (!msg) return;
          // the message goes in through stdin so quoting can't bite
          return Q.shellIn(
            `git -C ${Q.sh(Q.doc.dir())} add -A && git -C ${Q.sh(Q.doc.dir())} commit -F -`,
            msg
          ).then((r) => {
            refresh();
            if (r.ok) Q.ui.toast("committed <b>" + s.dirty + "</b> file(s)");
            else Q.ui.error(r.err || r.out || "commit failed");
          });
        });
      });
    },
  });

  Q.command({
    id: "gitDiff", title: "Git: diff this file", category: "Git",
    run: () => run(`diff -- ${Q.sh(Q.doc.path())}`).then((r) => {
      Q.ui.modal({
        title: "diff · " + Q.doc.name(),
        wide: true,
        body: r.out
          ? '<pre class="q-pre q-diff">' + colorDiff(r.out) + "</pre>"
          : "<p>no unstaged changes to this file.</p>",
        buttons: [{ label: "Done", primary: true }],
      });
    }),
  });

  Q.command({
    id: "gitLog", title: "Git: history of this file", category: "Git",
    run: () => run(`log --oneline -n 40 -- ${Q.sh(Q.doc.path())}`).then((r) => {
      Q.ui.modal({
        title: "history · " + Q.doc.name(),
        wide: true,
        body: r.out ? '<pre class="q-pre">' + Q.esc(r.out) + "</pre>" : "<p>no history for this file.</p>",
        buttons: [{ label: "Done", primary: true }],
      });
    }),
  });

  function colorDiff(text) {
    return text.split("\n").map((l) => {
      const cls = l[0] === "+" && l[1] !== "+" ? "add"
                : l[0] === "-" && l[1] !== "-" ? "del"
                : l.startsWith("@@") ? "hunk" : "";
      return cls ? '<span class="' + cls + '">' + Q.esc(l) + "</span>" : Q.esc(l);
    }).join("\n");
  }

  Q.command({
    id: "gitToggle", title: "Git: show branch in status bar", category: "Git",
    run: () => {
      const on = !Q.prefs().gitInStatusBar;
      Q.setPref("gitInStatusBar", on);
      refresh();
      Q.ui.toast("git in status bar " + (on ? "on" : "off"));
    },
  });

  git.inRepo = () => inRepo;
})(window.Q);
