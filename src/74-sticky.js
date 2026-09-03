"use strict";
// quire / stickies
//
// one key, and a small note floats over everything until you close it.
//
// the note is a real markdown file under ~/.quire/stickies, not a record in a
// database, because the whole point is that the other thing on this machine
// that writes markdown can read it. its frontmatter carries which claude code
// session was in front when you pressed the key, that session's cwd, and the
// window title it came from, so a note can be found again by the session that
// caused it rather than only by when it was written.
//
// resolving the session is `native/qsession`, ported whole rather than written
// again. the mechanism, verified on this machine:
//
//   window title  ->  the `ai-title` record in ~/.claude/projects/*/<uuid>.jsonl
//   that file     ->  its own sessionId and cwd, read from the records
//
// with one caveat that decides the design: reading a window's title needs
// Screen Recording permission, and quire does not have it and will not ask for
// it, because asking means a system dialog in front of whoever is typing. so
// from inside the app the title lookup returns nothing and the resolver falls
// through to newest-writer-wins, which is the right answer anyway: the session
// that just asked for a note is the session that wrote last.
//
// three pointers are maintained so a note can be found without knowing its name:
//   stickies/latest.md               the last one made
//   stickies/by-session/<uuid>.md    the last one made from that session
// both are symlinks, so `cat` follows them and an editor writes through them.

(function (Q) {
  const SAVE_MS = 700;

  let dirResolved = null;

  function resolveDir() {
    if (dirResolved !== null) return Promise.resolve(dirResolved);
    const raw = (Q.prefs().stickyDir || "~/.quire/stickies").replace(/\/+$/, "");
    if (raw.charAt(0) !== "~") return Promise.resolve((dirResolved = raw));
    return Q.shell('printf %s "$HOME"', "/").then((r) => {
      dirResolved = r.out ? r.out + raw.slice(1) : raw;
      return dirResolved;
    });
  }

  // the synchronous answer, for the places that cannot wait: the save guard asks
  // this on every save. it is empty until the shell has answered once, which it
  // does at boot.
  function dirNow() { return dirResolved || ""; }

  function isSticky(path) {
    const d = dirNow();
    if (!d || !path) return false;
    return String(path).indexOf(d + "/") === 0;
  }

  // ---- the session behind the keystroke --------------------------------------

  function qsessionPath() {
    let href = location.href;
    try { href = decodeURI(href); } catch (_) {}
    const i = href.indexOf("/TypeMark/");
    if (i === -1) return "";
    return href.slice(0, i).replace(/^file:\/\//, "") + "/TypeMark/qsession/qsession.sh";
  }

  function resolveSession() {
    const bin = qsessionPath();
    if (!bin) return Promise.resolve(null);
    return Q.shell(`${Q.sh(bin)} 2>/dev/null`).then((r) => {
      const parts = (r.out || "").split("\n")[0].split("\t");
      if (!parts[0]) return null;
      return { id: parts[0], cwd: parts[1] || "", window: parts[2] || "", how: parts[3] || "" };
    }, () => null);
  }
  Q.stickySession = resolveSession;

  // ---- making one ------------------------------------------------------------

  function stamp(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // offset-aware, because a note that says it was made at 05:22Z when the clock
  // on the wall said 07:22 is a note you cannot line up against a transcript
  function isoLocal(d) {
    const p = (n) => String(n).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    const sign = off < 0 ? "-" : "+";
    const a = Math.abs(off);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" +
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) +
      sign + p((a / 60) | 0) + ":" + p(a % 60);
  }

  // yaml, so anything that reads frontmatter can read it. quoted, because a
  // window title is arbitrary text and a bare colon in it ends the value.
  function yaml(v) {
    return '"' + String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function create(opts) {
    opts = opts || {};
    const now = new Date();
    let dir = "", file = "", path = "";
    return resolveDir()
      .then((d) => { dir = d; })
      .then(() => (opts.session === undefined ? resolveSession() : opts.session))
      .then((sess) => {
        file = "sticky-" + stamp(now) + ".md";
        path = dir + "/" + file;
        const head = [
          "---",
          "kind: sticky",
          "session: " + yaml(sess && sess.id),
          "cwd: " + yaml(sess && sess.cwd),
          "window: " + yaml(sess && sess.window),
          "resolved: " + yaml(sess && sess.how),
          "created: " + yaml(isoLocal(now)),
          "---",
          "",
          opts.body || "",
          "",
        ].join("\n");
        return Q.shell(`mkdir -p ${Q.sh(dir)} ${Q.sh(dir + "/by-session")}`)
          .then(() => Q.shellIn(`cat > ${Q.sh(path)}`, head))
          .then(() => {
            // ln -sfn, not ln -sf: without -n, a symlink that already points at
            // a directory gets the new link created *inside* it
            let cmd = `ln -sfn ${Q.sh(path)} ${Q.sh(dir + "/latest.md")}`;
            if (sess && sess.id) {
              cmd += ` && ln -sfn ${Q.sh(path)} ${Q.sh(dir + "/by-session/" + sess.id + ".md")}`;
            }
            return Q.shell(cmd);
          })
          .then(() => ({ path: path, dir: dir, session: sess }));
      });
  }

  function open(path) {
    // a separate window, not this one. openInTypora would replace the document
    // you are looking at, and a note that eats your document is not a note.
    return Q.call("controller.openInNewWindow", path)
      .catch(() => Q.invoke("app.openFileOrFolder", path, { forceCreateWindow: true }));
  }

  // ---- chrome ----------------------------------------------------------------
  //
  // a sticky is the same app in a smaller window, so everything that makes the
  // editor an editor is taken off it: no status bar, no sidebar, no rail. the
  // detection is the path, which means it survives a reload and cannot be
  // toggled into by accident.

  function applyChrome() {
    const on = isSticky(Q.doc.path());
    document.body.classList.toggle("q-sticky", on);
    if (!on) return;
    try { Q.ui.hidePanel(); } catch (_) {}
    try { Q.ed().library.toggleSidebar(false); } catch (_) {}
  }

  // ---- saving as you type ----------------------------------------------------
  //
  // File.sync() is not the write. it serialises the buffer and hands it to the
  // NSDocument, which writes it on its own schedule, autosaving in place. so
  // this pushes on a debounce and marks the document changed, and the write
  // follows. nothing here opens a file handle, because nothing on this side can.

  const flush = Q.debounce(function () {
    if (!isSticky(Q.doc.path())) return;
    try {
      window.File.sync();
      window.File.updateChangeCount(window.File.ChangeType.NSChangeDone);
    } catch (e) { Q.warn("sticky save", e); }
  }, SAVE_MS);

  function wireSaving() {
    const write = document.getElementById("write");
    if (!write) return setTimeout(wireSaving, 200);
    write.addEventListener("input", () => { if (isSticky(Q.doc.path())) flush(); }, true);
    window.addEventListener("blur", () => {
      if (!isSticky(Q.doc.path())) return;
      try {
        window.File.sync();
        window.File.updateChangeCount(window.File.ChangeType.NSChangeDone);
      } catch (_) {}
    });
  }

  // ---- commands --------------------------------------------------------------

  Q.command({
    id: "sticky", title: "New sticky note", category: "Quire", keys: "mod+alt+;",
    run: () => create({}).then((r) => {
      Q.ui.toast("sticky · " + r.path.split("/").pop() +
        (r.session && r.session.id ? " · " + r.session.id.slice(0, 8) : ""));
      return open(r.path);
    }),
  });

  Q.command({
    id: "stickyFromSelection", title: "Sticky note from the selection", category: "Quire",
    run: () => {
      const sel = Q.doc.selection();
      return create({ body: sel }).then((r) => open(r.path));
    },
  });

  Q.command({
    id: "stickyLatest", title: "Open the last sticky", category: "Quire",
    run: () => resolveDir().then((d) =>
      Q.shell(`readlink ${Q.sh(d + "/latest.md")} 2>/dev/null`).then((r) => {
        if (!r.out) return Q.ui.toast("no stickies yet");
        return open(r.out.trim());
      })),
  });

  Q.command({
    id: "stickyList", title: "Stickies…", category: "Quire",
    run: () => resolveDir().then((d) =>
      Q.shell(`ls -t ${Q.sh(d)}/sticky-*.md 2>/dev/null | head -40`).then((r) => {
        const files = (r.out || "").split("\n").filter(Boolean);
        if (!files.length) return Q.ui.toast("no stickies yet");
        const body = Q.el("div", { class: "q-picklist" });
        body.innerHTML = files.map((f) =>
          '<div class="q-pick-item" data-p="' + Q.esc(f) + '">' +
          '<span class="q-pick-name">' + Q.esc(f.split("/").pop()) + "</span></div>").join("");
        body.querySelectorAll(".q-pick-item").forEach((el) =>
          el.addEventListener("click", () => { Q.ui.closeModal(); open(el.dataset.p); }));
        Q.ui.modal({ title: "Stickies", body: body, buttons: [{ label: "Done", primary: true }] });
      })),
  });

  Q.sticky = {
    create, open, isSticky, dir: resolveDir, dirNow, session: resolveSession,
    flush: () => flush(),
    // the selftest points this at a scratch directory so a test run does not
    // leave notes in the real one, and points it back afterwards
    _useDir: (d) => { dirResolved = d; },
  };

  resolveDir().then(applyChrome);
  Q.on("doc", applyChrome);
  wireSaving();
})(window.Q);
