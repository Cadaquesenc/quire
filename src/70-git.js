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
      Q.ui.refreshPanel("git");
    });
  }, 400);

  git.refresh = refresh;
  Q.on("doc", refresh);
  Q.on("saved", refresh);

  // ---- the sidebar section --------------------------------------------------
  //
  // git was the one feature here with nowhere to live: a cell in the status bar
  // and three modals off the palette. now it is a section like the rest, the
  // branch, what has changed, and a click through to any of it.

  const CODES = {
    "?": "new", "A": "added", "M": "modified", "D": "deleted",
    "R": "renamed", "C": "copied", "U": "conflict", "!": "ignored",
  };

  function statusRow(line) {
    // porcelain: two status columns, a space, then the path
    const x = line.charAt(0), y = line.charAt(1);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    if (path.charAt(0) === '"') { try { path = JSON.parse(path); } catch (_) {} }
    const code = (x !== " " && x !== "?" ? x : y !== " " ? y : x);
    return {
      path, staged: x !== " " && x !== "?",
      code, label: CODES[code] || code,
    };
  }

  Q.ui.registerPanel("git", "Git", function (body) {
    body.innerHTML = '<div class="q-panel-loading">reading…</div>';
    Promise.all([git.status(), git.root()]).then(([s, top]) => {
      if (!s) {
        body.innerHTML = '<div class="q-panel-empty">' +
          Q.esc(Q.doc.dir() || "this folder") + "<br>is not a git repository.</div>";
        return;
      }
      // porcelain paths are relative to the repo root
      const rows = s.files.map(statusRow);
      const abs = (p) => (top ? top + "/" + p : p);
      body.innerHTML =
        '<div class="q-git-head">' +
          '<span class="q-git-b">' + Q.icon("branch", 13) + Q.esc(s.branch) + "</span>" +
          '<span class="q-git-n">' + (s.dirty ? s.dirty + " changed" : "clean") + "</span>" +
        "</div>" +
        '<div class="q-git-acts">' +
          '<span class="q-git-act" data-cmd="gitCommit">commit all…</span>' +
          '<span class="q-git-act" data-cmd="gitDiff">diff this file</span>' +
          '<span class="q-git-act" data-cmd="gitLog">history</span>' +
        "</div>" +
        (rows.length
          ? '<div class="q-git-list">' + rows.map((r) =>
              '<div class="q-git-row' + (r.staged ? " staged" : "") + '" data-p="' +
              Q.esc(abs(r.path)) + '">' +
              '<span class="q-git-code ' + Q.esc(r.label) + '">' + Q.esc(r.code) + "</span>" +
              '<span class="q-git-path">' + Q.esc(r.path) + "</span>" +
              '<span class="q-git-what">' + Q.esc(r.label) + "</span>" +
              "</div>").join("") + "</div>"
          : '<div class="q-panel-empty">working tree clean.</div>');

      body.querySelectorAll(".q-git-act").forEach((el) =>
        el.addEventListener("click", () => Q.run(el.dataset.cmd)));
      // a changed file opens the same way it would from the files section:
      // markdown to the editor, anything else to the read-only pane.
      body.querySelectorAll(".q-git-row").forEach((el) =>
        el.addEventListener("click", () => Q.openPath(el.dataset.p)));
    }).catch((e) => {
      body.innerHTML = '<div class="q-panel-empty">' + Q.esc(e.message) + "</div>";
    });
  }, "branch", 40);

  Q.command({
    id: "git", title: "Git", category: "Git", keys: "mod+alt+v",
    run: () => Q.ui.togglePanel("git"),
  });

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
