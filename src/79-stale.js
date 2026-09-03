"use strict";
// quire / doc staleness
//
// the failure mode this is for: an agent rewrites twelve source files, does not
// touch the README, and nothing anywhere says the README is now a description of
// a program that no longer exists. the doc does not rot loudly. it just quietly
// stops being true.
//
// so: for every .md in the folder, when was it last committed, and when was the
// code it sits next to last committed. if the code is newer, the doc is behind,
// and by how many commits is a number you can act on.
//
// "the code it describes" is the directory it lives in, including everything
// under it. that is a heuristic and it is the honest one available: nothing in a
// markdown file says which functions it is about. a README at the top of a repo
// is about the repo, and a doc in src/parser/ is about the parser. where the
// heuristic is wrong it is wrong in the direction of asking a question, not of
// hiding one.
//
// one git call, not one per file. `git log --name-only` newest first means the
// first time a path appears is the last time it changed, so a single pass over
// the log answers every question here at once. the log can be far bigger than
// the 60,000 byte bridge cap, so it goes through shellBig.

(function (Q) {
  const COMMITS = 400;            // depth of history read
  const RECENT_DAYS = 7;
  const MAX_ROWS = 60;

  const SEP = "\u0001";           // the commit-header marker, see history()
  const MD = /\.(md|markdown|mdown|mkd)$/i;
  const dirOf = (p) => (p.indexOf("/") === -1 ? "" : p.slice(0, p.lastIndexOf("/")));
  const under = (p, dir) => (dir === "" ? true : p.indexOf(dir + "/") === 0);

  // ---- the one pass over git -------------------------------------------------

  function history(root) {
    // \x01 in front of the timestamp so a filename that happens to be all
    // digits cannot be mistaken for a commit header. git's own separator
    // options do not survive --name-only cleanly.
    const cmd = "git -C " + Q.sh(root) + " log -n " + COMMITS +
      " --no-merges --format=%x01%ct --name-only 2>/dev/null";
    return Q.shellBig(cmd, root, 4000000, { raw: true }).then((r) => {
      const commits = [];         // [{ts, files:[...]}], newest first
      let cur = null;
      (r.out || "").split("\n").forEach((line) => {
        if (line.charAt(0) === SEP) {
          cur = { ts: parseInt(line.slice(1), 10) || 0, files: [] };
          commits.push(cur);
        } else if (line && cur) {
          cur.files.push(line);
        }
      });
      return commits;
    });
  }

  // uncommitted work, because the whole point is to notice what changed in the
  // last ten minutes and git only knows about what was committed.
  function working(root) {
    return Q.shell("git -C " + Q.sh(root) + " status --porcelain 2>/dev/null | head -400", root)
      .then((r) => {
        const out = {};
        (r.out ? r.out.split("\n") : []).forEach((line) => {
          if (line.length < 4) return;
          let p = line.slice(3);
          const arrow = p.indexOf(" -> ");        // a rename reports both names
          if (arrow !== -1) p = p.slice(arrow + 4);
          p = p.replace(/^"|"$/g, "");
          out[p] = line.slice(0, 2).trim() || "?";
        });
        return out;
      });
  }

  function isRepo(root) {
    return Q.shell("git -C " + Q.sh(root) + " rev-parse --show-toplevel 2>/dev/null", root)
      .then((r) => (r.ok && r.out.charAt(0) === "/" ? r.out.split("\n")[0] : ""));
  }

  // ---- the report ------------------------------------------------------------

  function report(root) {
    root = root || Q.doc.root();
    if (!root) return Promise.resolve({ ok: false, why: "no folder open" });
    return isRepo(root).then((top) => {
      if (!top) return { ok: false, why: "not a git repository", root: root };
      return Promise.all([history(top), working(top)]).then((got) => {
        const commits = got[0], dirty = got[1];
        if (!commits.length) return { ok: false, why: "no commits yet", root: top };

        // newest commit that touched each path, and the docs we know about
        const lastTouch = {};
        commits.forEach((c) => c.files.forEach((f) => {
          if (lastTouch[f] == null) lastTouch[f] = c.ts;
        }));

        const docs = Object.keys(lastTouch).filter((p) => MD.test(p));
        const now = Date.now() / 1000;
        const minGap = Math.max(0, (Q.prefs().staleDays || 1)) * 86400;

        const rows = docs.map((doc) => {
          const dir = dirOf(doc);
          // the newest commit under this doc's directory that is not a doc, and
          // how many such commits landed after the doc was last touched.
          let codeTs = 0, behind = 0, sample = "";
          for (let i = 0; i < commits.length; i++) {
            const c = commits[i];
            let hit = null;
            for (let k = 0; k < c.files.length; k++) {
              const f = c.files[k];
              if (MD.test(f) || !under(f, dir)) continue;
              hit = f;
              break;
            }
            if (!hit) continue;
            if (!codeTs) { codeTs = c.ts; sample = hit; }
            if (c.ts > lastTouch[doc]) behind++;
          }
          return {
            path: doc,
            docTs: lastTouch[doc],
            codeTs: codeTs,
            behind: behind,
            sample: sample,
            dirty: !!dirty[doc],
            gap: codeTs - lastTouch[doc],
          };
        });

        const stale = rows.filter((r) => r.behind > 0 && r.gap > minGap)
          .sort((a, b) => b.behind - a.behind || b.gap - a.gap)
          .slice(0, MAX_ROWS);

        const recent = rows.filter((r) => r.dirty || now - r.docTs < RECENT_DAYS * 86400)
          .sort((a, b) => (b.dirty ? 1 : 0) - (a.dirty ? 1 : 0) || b.docTs - a.docTs)
          .slice(0, MAX_ROWS);

        // an untracked .md is new work nobody has committed, which is exactly
        // the kind of thing you want on this list.
        Object.keys(dirty).forEach((p) => {
          if (!MD.test(p) || lastTouch[p] != null) return;
          recent.unshift({ path: p, docTs: now, codeTs: 0, behind: 0,
                           dirty: true, gap: 0, isNew: true });
        });

        return { ok: true, root: top, commits: commits.length, docs: docs.length,
                 stale: stale, recent: recent.slice(0, MAX_ROWS), now: now };
      });
    });
  }

  Q.docs = { report, history, working };

  // ---- the panel -------------------------------------------------------------

  let cache = null;

  Q.ui.registerPanel("docs", "Docs", function (body) {
    body.innerHTML = '<div class="q-stale-head"></div><div class="q-stale-body">' +
      Q.ui.loading("reading git…") + "</div>";
    const head = body.querySelector(".q-stale-head");
    const out = body.querySelector(".q-stale-body");

    function row(r, kind) {
      const name = r.path.slice(r.path.lastIndexOf("/") + 1);
      const dir = dirOf(r.path);
      const meta = kind === "stale"
        ? r.behind + (r.behind === 1 ? " commit" : " commits") + " of code since · doc is " +
          Q.ago(r.gap) + " older"
        : (r.isNew ? "untracked" : (r.dirty ? "uncommitted · " : "") +
           "last committed " + Q.since(cache.now - r.docTs));
      return '<div class="q-stale-row" data-p="' + Q.esc(r.path) + '">' +
        '<div class="q-stale-n">' + Q.esc(name) +
        (dir ? '<span class="q-stale-d">' + Q.esc(dir) + "</span>" : "") + "</div>" +
        '<div class="q-stale-m">' + Q.esc(meta) + "</div>" +
        (kind === "stale" && r.sample
          ? '<div class="q-stale-s">newest: ' + Q.esc(r.sample) + "</div>" : "") +
        "</div>";
    }

    function draw(rep) {
      cache = rep;
      if (!rep.ok) {
        head.innerHTML = "";
        out.innerHTML = Q.ui.empty("doc", rep.why,
          "this panel reads one <code>git log</code> and asks which docs the code " +
          "has moved past.");
        return;
      }
      head.innerHTML = '<span class="q-sess-count">' + rep.docs + " docs · " +
        rep.commits + " commits read</span>" +
        '<span class="q-sess-act" data-act="refresh">refresh</span>';
      head.querySelector('[data-act="refresh"]').addEventListener("click", () => {
        out.innerHTML = Q.ui.loading("reading git…");
        report().then(draw);
      });
      out.innerHTML =
        '<div class="q-side-label">behind the code</div>' +
        (rep.stale.length ? rep.stale.map((r) => row(r, "stale")).join("")
                          : Q.ui.empty("check", "nothing is behind",
                              "every doc here was committed after the code next to it.")) +
        '<div class="q-side-label">touched lately</div>' +
        (rep.recent.length ? rep.recent.map((r) => row(r, "recent")).join("")
                           : Q.ui.empty("clock", "nothing this week", ""));
      out.querySelectorAll(".q-stale-row").forEach((el) =>
        el.addEventListener("click", () => Q.doc.open(rep.root + "/" + el.dataset.p)));
    }

    if (cache) draw(cache);
    report().then(draw, (e) =>
      (out.innerHTML = '<div class="q-pal-empty">' + Q.esc(String(e)) + "</div>"));
  }, "doc", 65);

  // ---- commands --------------------------------------------------------------

  Q.command({
    id: "docsPanel", title: "Docs: what is behind the code", category: "Quire",
    keys: "mod+alt+.",
    run: () => Q.ui.togglePanel("docs"),
  });

  Q.command({
    id: "docsInsert", title: "Docs: insert a staleness table here", category: "Quire",
    run: () => report().then((rep) => {
      if (!rep.ok) return Q.ui.toast(rep.why);
      if (!rep.stale.length) return Q.ui.toast("nothing is behind its code");
      const lines = ["| doc | commits behind | doc older by |", "| --- | --- | --- |"];
      rep.stale.forEach((r) =>
        lines.push("| `" + r.path + "` | " + r.behind + " | " + Q.ago(r.gap) + " |"));
      Q.doc.insert(lines.join("\n") + "\n");
      Q.ui.toast("inserted " + rep.stale.length + " rows");
    }),
  });
})(window.Q);
