"use strict";
// quire / boot
//
// runs last. turns on the parts of the host runtime that ship switched off,
// makes sure the shell shim is wired, fills the status bar, and watches for the
// open document changing so everything downstream can react.

(function (Q) {
  // ---- settings the host ships off ------------------------------------------
  //
  // none of this is new code. math, diagrams, the file tree and image handling
  // are all already in the bundle, sitting behind a flag that defaults to zero.

  const WANT = {
    enableInlineMath: true,
    enableDiagram: true,
    enableHighlight: true,
    enableSubscript: true,
    enableSuperscript: true,
    showLineNumbersForFence: true,
    useTreeStyle: true,
    useRelativePathForImg: true,
    defaultImageStorage: "per-file-assert",
  };

  function applySettings() {
    let n = 0;
    for (const k in WANT) if (Q.set(k, WANT[k])) n++;
    if (n) Q.log("applied", n, "settings");
  }

  // ---- pandoc ---------------------------------------------------------------
  //
  // export to docx/epub/rst goes through the native PandocBridge, which needs a
  // path. the host only auto-detects with `which pandoc`, from a process whose
  // PATH does not include homebrew, so it comes up empty on this machine. a
  // login shell finds it.

  function findPandoc() {
    if (Q.opt().pandocPath) return;
    Q.shell("command -v pandoc").then((r) => {
      if (r.out && r.out.charAt(0) === "/") {
        Q.set("pandocPath", r.out);
        Q.log("pandoc ->", r.out);
      }
    });
  }

  // ---- status bar -----------------------------------------------------------

  let slotMode, slotFile, slotWords;

  function setupStatus() {
    slotMode  = Q.ui.slot("mode",  { order: 1,  side: "left", extraClass: "mode", onClick: () => Q.run("source") });
    slotFile  = Q.ui.slot("file",  { order: 10, side: "left", extraClass: "path", onClick: () => Q.run("copyPath") });
    slotWords = Q.ui.slot("words", { order: 10, side: "right", onClick: () => Q.run("stats") });
    updateStatus();
  }

  const updateStatus = Q.debounce(function () {
    if (!slotFile) return;

    // the folder is dimmed and the file is not, so the pair reads as one label
    // rather than two competing pieces of text
    const name = Q.doc.name();
    const root = Q.doc.root();
    const dir = Q.doc.dir();
    // the root is already the first crumb; when the file sits directly in it
    // there is no relative part to add, or the folder appears twice. and when
    // the file is not under the root at all, an open document from anywhere
    // else, the root is not its parent and must not be the first crumb, or the
    // bar claims the file lives somewhere it does not.
    const inRoot = !!(root && dir && (dir === root || dir.indexOf(root + "/") === 0));
    const base = inRoot ? root : dir;
    const rel = inRoot ? Q.rel(dir, root) : "";

    // File.isEdited does not exist. it never did: the property this used to read
    // is undefined on every build, so the dirty dot has never once appeared. the
    // real accessor is a method, and on macos it goes over the bridge's
    // synchronous channel to ask the NSDocument.
    let edited = false;
    try { edited = !!(Q.guard && Q.guard.dirty && Q.guard.dirty()); } catch (_) {}

    // the mode block, lualine's leftmost segment. source mode and read-only are
    // the only two states this editor really has, so it says which one.
    let mode = "WRITE";
    try {
      if (window.File && window.File.isSourceMode) mode = "SOURCE";
      else if (document.body.classList.contains("q-zen")) mode = "ZEN";
    } catch (_) {}
    slotMode.set(mode, "click to toggle source mode");

    const crumbs = [];
    if (base) {
      const rootName = base.slice(base.lastIndexOf("/") + 1);
      crumbs.push({ label: rootName, dir: base });
      if (rel) {
        let acc = base;
        rel.split("/").forEach((seg) => {
          acc += "/" + seg;
          crumbs.push({ label: seg, dir: acc });
        });
      }
    }

    slotFile.set(
      (Q.icon ? Q.icon(Q.iconForPath(name || "x.md"), 13) : "") +
      crumbs.map((c) =>
        '<span class="q-crumb" data-qdir="' + Q.esc(c.dir) + '">' + Q.esc(c.label) + "</span>" +
        '<span class="q-crumb-sep">/</span>').join("") +
      '<span class="q-crumb file">' + (name ? Q.esc(name) : "untitled") + "</span>" +
      (edited ? '<span class="q-dirty"></span>' : ""),
      Q.doc.path()
    );

    const s = Q.stats();
    slotWords.set(
      s.words.toLocaleString() + " words" +
      (s.tasks ? ' <span class="q-sep">/</span> ' + s.tasksDone + " of " + s.tasks : "") +
      ' <span class="q-sep">/</span> ' + s.minutes + " min",
      s.chars.toLocaleString() + " characters"
    );
  }, 250);

  // ---- watching the open document -------------------------------------------

  let lastPath = null;
  function watch() {
    const p = Q.doc.path();
    if (p !== lastPath) {
      lastPath = p;
      Q.emit("doc", p);
      Q.ui.refreshPanel("backlinks");
    }
    updateStatus();
  }

  // ---- the sidebar ----------------------------------------------------------
  //
  // every section has its own key already (⌘⌥E files, ⌘⌥B backlinks, ⌘⌥G tags,
  // ⌘⌥V git, ⌘⌥J terminal). these three are for the column itself: open it
  // where you left it, and walk the rail without aiming at anything.
  //
  // the brackets and the backslash are free, the digits are not, ⌘⌥1-4 are the
  // heading levels.

  Q.command({
    // not "sidebar": 30-editing already owns that id for the host's left one
    id: "quireSidebar", title: "Sidebar", category: "Navigate", keys: "mod+alt+\\",
    run: () => Q.ui.toggleSidebar(),
  });

  Q.command({
    id: "sidebarNext", title: "Sidebar: next section", category: "Navigate", keys: "mod+alt+]",
    run: () => Q.ui.cycleSection(1),
  });

  Q.command({
    id: "sidebarPrev", title: "Sidebar: previous section", category: "Navigate", keys: "mod+alt+[",
    run: () => Q.ui.cycleSection(-1),
  });

  // ---- diagnostics ----------------------------------------------------------

  Q.command({
    id: "diagnostics", title: "Diagnostics", category: "Quire",
    run: function () {
      const F = Q.file();
      const keysOf = (o) => { try { return Object.keys(o).length; } catch (_) { return 0; } };
      const rows = [
        ["page", location.href],
        ["shell", Q.shellAvailable === null ? "unchecked" : Q.shellAvailable ? "yes" : "no"],
        ["pandoc", Q.opt().pandocPath || "(not found)"],
        ["file", Q.doc.path() || "(none)"],
        ["folder", Q.doc.root() || "(none)"],
        ["notes", Q.prefs().notesDir || "(unset)"],
        ["commands", Q.commands().length],
        ["shortcuts", Object.keys(Q.keys.all()).length],
        ["File.editor", keysOf(F.editor) + " submodules"],
        ["MathJax", (window.MathJax && window.MathJax.version) || "-"],
        ["mermaid", window.mermaid ? (window.mermaid.version || "loaded") : "not yet"],
        ["CodeMirror", (window.CodeMirror && window.CodeMirror.version) || "-"],
        ["JSBridge", keysOf(window.JSBridge) + " methods"],
      ];
      const body = Q.el("div");
      body.innerHTML = '<table class="q-stats">' + rows.map(([k, v]) =>
        "<tr><td>" + Q.esc(k) + "</td><td>" + Q.esc(String(v)) + "</td></tr>").join("") + "</table>";
      Q.ui.modal({
        title: "Quire diagnostics", body, wide: true,
        buttons: [
          { label: "Test shell", keepOpen: true, run: () =>
              Q.shell("echo $SHELL; sw_vers -productVersion; git --version 2>/dev/null | head -1")
                .then((r) => Q.ui.toast("<pre>" + Q.esc(r.out || r.err || "(nothing)") + "</pre>", 8000)) },
          { label: "Done", primary: true },
        ],
      });
    },
  });

  Q.command({
    id: "about", title: "About Quire", category: "Quire",
    run: () => Q.ui.modal({
      title: "Quire",
      body:
        "<p>a markdown editor built on the runtime of a 2021 build, with the parts " +
        "that shipped switched off turned back on, and the parts that were never " +
        "there written.</p>" +
        "<p><b>" + Q.commands().length + "</b> commands · <b>" +
        Object.keys(Q.keys.all()).length + "</b> shortcuts · press <kbd>⌘⌥P</kbd></p>",
      buttons: [
        { label: "Shortcuts", run: () => Q.run("keymap") },
        { label: "Diagnostics", run: () => Q.run("diagnostics") },
        { label: "Done", primary: true },
      ],
    }),
  });

  // ---- health ---------------------------------------------------------------
  //
  // written through the host's own setting path, so it lands in the preferences
  // plist. that makes the app inspectable from a terminal without opening it,
  // which is the only way to check a windowed app without stealing focus.

  const healthState = {};
  function health(k, v) {
    healthState[k] = v;
    healthState.at = new Date().toISOString();
    healthState.commands = Q.commands().length;
    healthState.shortcuts = Object.keys(Q.keys.all()).length;
    Q.set("quireHealth", JSON.stringify(healthState));
  }
  Q.health = health;

  // ---- go -------------------------------------------------------------------

  function boot() {
    if (!window.File || !window.File.editor) return setTimeout(boot, 80);

    applySettings();

    if (Q.prefs().statusBar) document.body.classList.add("q-status-on");
    if (Q.prefs().proseStyle) document.body.classList.add("q-prose");
    setupStatus();

    // one timer, not a timer plus a keyup listener. the word count does not
    // need to be correct within a keystroke.
    setInterval(watch, 1500);
    watch();

    Q.checkShell().then((ok) => {
      Q.log("shell", ok ? "ready" : "unavailable");
      health("shell", ok ? "ok" : "unavailable");
      if (ok) {
        Q.git.refresh();
        findPandoc();
        Q.vaultRoot();   // resolves ~ over the shell, once
        // the sidebar comes back where it was left. after the shell is up,
        // because every section it could restore to needs one.
        setTimeout(() => Q.ui.restoreSidebar(), 400);
      } else {
        Q.ui.slot("shell", { order: 99, side: "left", onClick: () => Q.run("diagnostics") })
          .set('<span class="q-bad">no shell</span>', "controller.runCommand did not answer");
      }
    });

    Q.log("ready:", Q.commands().length, "commands");
    // not on a sticky. a note is two lines you wrote in a 380px window and the
    // greeting lands on top of them. the class is set from the document path a
    // moment after boot, so this asks late rather than early.
    setTimeout(() => {
      if (document.body.classList.contains("q-sticky")) return;
      Q.ui.toast("<b>Quire</b> · press <kbd>⌘⌥P</kbd>");
    }, 700);
  }

  boot();
})(window.Q);
