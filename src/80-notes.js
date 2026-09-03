"use strict";
// quire / notes
//
// daily notes, quick capture, templates and a tag index. all of it rests on the
// shell shim, because the host gives javascript no way to touch the filesystem.

(function (Q) {
  // ---- where notes live -----------------------------------------------------

  function notesDir() {
    const d = Q.prefs().notesDir;
    if (d) return Promise.resolve(d);
    const guess = Q.doc.root() || (Q.opt().documentsPath || "");
    return Q.ui.prompt("Where do your notes live?", guess, "/Users/you/Notes").then((v) => {
      if (!v) return "";
      const clean = v.replace(/\/$/, "");
      Q.setPref("notesDir", clean);
      return Q.shell(`mkdir -p ${Q.sh(clean)}`).then(() => clean);
    });
  }

  Q.notesDir = notesDir;

  function ensureFile(path, seed) {
    // create only if missing; never clobber
    return Q.shellIn(
      `[ -f ${Q.sh(path)} ] || cat > ${Q.sh(path)}`,
      seed || ""
    ).then(() => path);
  }

  function appendTo(path, text) {
    return Q.shellIn(`cat >> ${Q.sh(path)}`, text);
  }

  // ---- daily note -----------------------------------------------------------

  function dailyPath(dir, d) {
    return dir + "/" + Q.date(d) + ".md";
  }

  function openDaily(offsetDays) {
    return notesDir().then((dir) => {
      if (!dir) return;
      const d = new Date();
      if (offsetDays) d.setDate(d.getDate() + offsetDays);
      const path = dailyPath(dir, d);
      const heading = "# " + d.toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      }) + "\n\n";
      return ensureFile(path, heading).then(() => Q.doc.open(path));
    });
  }

  Q.command({
    id: "daily", title: "Today's note", category: "Notes", keys: "mod+alt+d",
    run: () => openDaily(0),
  });
  Q.command({
    id: "dailyPrev", title: "Yesterday's note", category: "Notes",
    run: () => openDaily(-1),
  });
  Q.command({
    id: "dailyNext", title: "Tomorrow's note", category: "Notes",
    run: () => openDaily(1),
  });

  // ---- quick capture --------------------------------------------------------
  // a line goes into today's note without leaving the file you're in

  Q.command({
    id: "capture", title: "Quick capture to today", category: "Notes", keys: "mod+alt+n",
    run: function () {
      return Q.ui.prompt("Capture", "", "a thought, a task, a link…").then((text) => {
        if (!text) return;
        return notesDir().then((dir) => {
          if (!dir) return;
          const path = dailyPath(dir);
          const now = new Date();
          const hh = String(now.getHours()).padStart(2, "0");
          const mm = String(now.getMinutes()).padStart(2, "0");
          const line = `- ${hh}:${mm} ${text}\n`;
          return ensureFile(path, "# " + Q.date() + "\n\n")
            .then(() => appendTo(path, line))
            .then(() => Q.ui.toast("captured to <b>" + Q.date() + ".md</b>"));
        });
      });
    },
  });

  // ---- new note -------------------------------------------------------------

  Q.command({
    id: "newNote", title: "New note…", category: "Notes",
    run: function () {
      return Q.ui.prompt("New note", "", "title").then((title) => {
        if (!title) return;
        const dir = Q.doc.root() || Q.doc.dir();
        if (!dir) return Q.ui.toast("open a folder first");
        const slug = title.trim().replace(/[\/:]/g, "-");
        const path = dir + "/" + slug + ".md";
        const seed = "---\ntitle: " + title + "\ndate: " + Q.date() + "\n---\n\n# " + title + "\n\n";
        return ensureFile(path, seed).then(() => Q.doc.open(path));
      });
    },
  });

  // ---- templates ------------------------------------------------------------
  // any .md under <notes>/templates shows up here and is inserted at the cursor

  Q.command({
    id: "template", title: "Insert template", category: "Notes",
    run: function () {
      return notesDir().then((dir) => {
        if (!dir) return;
        const tdir = dir + "/templates";
        return Q.shell(`mkdir -p ${Q.sh(tdir)} && find ${Q.sh(tdir)} -name '*.md' | head -100`)
          .then((r) => {
            const files = (r.out ? r.out.split("\n") : []).filter(Boolean);
            if (!files.length) {
              return Q.ui.modal({
                title: "No templates",
                body: "<p>drop markdown files into</p><pre class='q-pre'>" + Q.esc(tdir) + "</pre>" +
                      "<p>and they show up here. <code>{{date}}</code>, <code>{{time}}</code> and " +
                      "<code>{{title}}</code> get filled in.</p>",
                buttons: [{ label: "Done", primary: true }],
              });
            }
            const items = files.map((p) => ({
              path: p, rel: p.slice(tdir.length + 1),
              stem: p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, ""),
            }));
            Q.pickNote(items, "Insert template", (f) =>
              Q.shell(`cat ${Q.sh(f.path)}`).then((r) => {
                const now = new Date();
                const out = r.out
                  .replace(/\{\{date\}\}/g, Q.date())
                  .replace(/\{\{time\}\}/g, now.toTimeString().slice(0, 5))
                  .replace(/\{\{title\}\}/g, Q.doc.stem());
                Q.doc.insert(out);
              }));
          });
      });
    },
  });

  // ---- tags -----------------------------------------------------------------

  Q.ui.registerPanel("tags", "Tags", function (body) {
    body.innerHTML = '<div class="q-panel-loading">scanning…</div>';
    const root = Q.doc.root();
    if (!root) { body.innerHTML = '<div class="q-panel-empty">open a folder first.</div>'; return; }
    Q.shell(
      `${Q.sh(Q.rg())} -o --no-filename --no-messages -g '*.md' ` +
      `${Q.sh("(^|\\s)#[A-Za-z][A-Za-z0-9_/-]*")} ${Q.sh(root)} ` +
      `2>/dev/null | tr -d '[:blank:]' | sort | uniq -c | sort -rn | head -200`
    ).then((r) => {
      const rows = (r.out ? r.out.split("\n") : []).filter(Boolean).map((l) => {
        const m = /^\s*(\d+)\s+(#\S+)$/.exec(l);
        return m ? { n: +m[1], tag: m[2] } : null;
      }).filter(Boolean).filter((t) => !/^#{2,}/.test(t.tag));   // headings aren't tags
      if (!rows.length) {
        body.innerHTML = '<div class="q-panel-empty">no <code>#tags</code> found under<br>' +
          Q.esc(root) + "</div>";
        return;
      }
      body.innerHTML = '<div class="q-tags">' + rows.map((t) =>
        '<span class="q-tag" data-tag="' + Q.esc(t.tag) + '">' + Q.esc(t.tag) +
        '<i>' + t.n + "</i></span>").join("") + "</div>";
      body.querySelectorAll(".q-tag").forEach((el) =>
        el.addEventListener("click", () => searchTag(el.dataset.tag)));
    });
  }, "tag");

  function searchTag(tag) {
    const root = Q.doc.root();
    return Q.shell(
      `${Q.sh(Q.rg())} -n --no-heading --no-messages -F -g '*.md' ${Q.sh(tag)} ${Q.sh(root)} ` +
      `2>/dev/null | head -200`
    ).then((r) => {
      const lines = (r.out ? r.out.split("\n") : []).filter(Boolean);
      Q.ui.modal({
        title: tag + " · " + lines.length,
        wide: true,
        body: '<div class="q-mentions">' + lines.map((l) => {
          const m = /^(.*?):(\d+):(.*)$/.exec(l) || [];
          const p = m[1] || l;
          return '<div class="q-mention" data-path="' + Q.esc(p) + '">' +
            '<span class="q-mention-file">' + Q.esc(p.slice(root.length + 1)) + "</span>" +
            '<span class="q-mention-text">' + Q.esc((m[3] || "").trim().slice(0, 200)) + "</span></div>";
        }).join("") + "</div>",
        buttons: [{ label: "Done", primary: true }],
      });
      document.querySelectorAll(".q-mention").forEach((el) =>
        el.addEventListener("click", () => { Q.ui.closeModal(); Q.doc.open(el.dataset.path); }));
    });
  }

  Q.command({
    id: "tags", title: "Tags", category: "Notes", keys: "mod+alt+g",
    run: () => Q.ui.togglePanel("tags"),
  });

  Q.command({
    id: "setNotesDir", title: "Set the notes folder", category: "Notes",
    run: () => Q.ui.prompt("Notes folder", Q.prefs().notesDir || Q.doc.root(), "/Users/you/Notes")
      .then((v) => {
        if (!v) return;
        const clean = v.replace(/\/$/, "");
        Q.setPref("notesDir", clean);
        return Q.shell(`mkdir -p ${Q.sh(clean)}`).then(() => Q.ui.toast("notes: " + Q.esc(clean)));
      }),
  });
})(window.Q);
