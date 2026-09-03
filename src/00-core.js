"use strict";
// quire / core
//
// every script under quire/ is loaded with defer, in filename order, from the
// end of index.html. by the time this runs the host runtime has already
// initialised, so window.File and File.editor exist. the document *text* does
// not — that arrives later over the bridge — so anything reading content waits.
//
// this file is the only place that talks to the native side directly. the rest
// of the app goes through Q.

window.Q = (function () {
  const Q = {};

  Q.name = "Quire";
  Q.log = (...a) => console.log("%c[quire]", "color:#8ab4f8", ...a);
  Q.warn = (...a) => console.warn("[quire]", ...a);

  // ---- runtime handles ------------------------------------------------------

  Q.file = () => window.File;
  Q.ed = () => window.File && window.File.editor;
  Q.opt = () => (window.File && window.File.option) || {};

  // ---- the bridge -----------------------------------------------------------
  //
  // two channels exist. JSBridge.invoke returns a promise; bridge.callHandler
  // takes a callback. some handlers are only on one of them, so both are
  // wrapped and both come back as promises.

  Q.invoke = function (name, ...args) {
    try {
      return Promise.resolve(window.JSBridge.invoke(name, ...args));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  Q.call = function (name, arg) {
    return new Promise((resolve, reject) => {
      try {
        window.bridge.callHandler(name, arg, resolve);
      } catch (e) {
        reject(e);
      }
    });
  };

  // ---- shell ----------------------------------------------------------------
  //
  // there is no node here: File.isNode is false and index.html nulls out
  // require/module/exports. the one process-launching handler is
  // controller.runCommand, which exists to run pandoc for export.
  //
  // its `args` is a single string, not an argv array, and the native side hands
  // it to a shell. an array gets stringified on the way across and comes back as
  // a mangled two-line script, which is what made this look impossible at first.
  // as a string it is a plain shell, so the whole toolchain on this machine —
  // git, grep, curl, find — is reachable from the editor.

  let shellPromise = null;
  Q.shellAvailable = null;
  Q.channel = "callback";

  function parseResult(r) {
    if (Array.isArray(r)) {
      return { ok: !!r[0], code: r[0] ? 0 : 1,
               out: String(r[1] == null ? "" : r[1]).trim(),
               err: String(r[2] == null ? "" : r[2]).trim() };
    }
    if (r && typeof r === "object") {
      return { ok: !r.error, code: r.code || 0,
               out: String(r.output || r.message || "").trim(),
               err: String(r.error || "").trim() };
    }
    return { ok: r != null, code: 0, out: String(r == null ? "" : r).trim(), err: "" };
  }

  Q.shell = function (cmd, cwd) {
    const payload = { args: String(cmd), cwd: cwd || Q.doc.dir() || "" };
    const p = Q.channel === "invoke"
      ? Q.invoke("controller.runCommand", payload)
      : Q.call("controller.runCommand", payload);
    return p.then(parseResult);
  };

  // run a command and hand it stdin without any quoting problems.
  // base64 in, decode in the shell, pipe to the command.
  Q.shellIn = function (cmd, stdin, cwd) {
    const b64 = btoa(unescape(encodeURIComponent(stdin)));
    return Q.shell(`printf %s ${JSON.stringify(b64)} | base64 --decode | ${cmd}`, cwd);
  };

  // the probe has to use a command whose *output* cannot appear in its own
  // text — the first version tested for a literal echoed back, and matched the
  // shell's own error message quoting the command it had failed to run.
  Q.checkShell = function () {
    if (shellPromise) return shellPromise;
    shellPromise = Q.shell("expr 6 \\* 7")
      .then((r) => (Q.shellAvailable = r.out === "42"))
      .catch(() => (Q.shellAvailable = false));
    return shellPromise;
  };

  // ---- settings -------------------------------------------------------------
  //
  // File.option is the live copy; JSBridge.putSetting persists through the
  // app's own native path, which keeps the plist key mapping correct.

  Q.set = function (k, v) {
    const F = Q.file();
    if (!F || !F.option) return false;
    if (F.option[k] === v) return false;
    F.option[k] = v;
    try { window.JSBridge.putSetting(k, v); } catch (_) {}
    return true;
  };

  // our own preferences live in one json blob so we never collide with theirs
  const PREF_KEY = "quirePrefs";
  const DEFAULTS = {
    // the folder everything without a mounted sidebar falls back to. panels
    // that search — files, tags, backlinks — need somewhere to look, and the
    // host only ever gives them a root once you have explicitly opened a folder.
    vaultRoot: "~/Code",
    notesDir: "",              // for daily notes / capture. empty = ask once
    dailyFormat: "YYYY-MM-DD",
    ollamaModel: "",           // empty = first model ollama reports
    ollamaHost: "http://127.0.0.1:11434",
    statusBar: true,
    proseStyle: false,         // our typography pass over the editor
    gitInStatusBar: true,
  };

  let prefs = null;
  Q.prefs = function () {
    if (prefs) return prefs;
    prefs = Object.assign({}, DEFAULTS);
    try {
      const raw = Q.opt()[PREF_KEY] || localStorage.getItem(PREF_KEY);
      if (raw) Object.assign(prefs, JSON.parse(raw));
    } catch (_) {}
    return prefs;
  };

  Q.setPref = function (k, v) {
    const p = Q.prefs();
    p[k] = v;
    const raw = JSON.stringify(p);
    try { localStorage.setItem(PREF_KEY, raw); } catch (_) {}
    Q.set(PREF_KEY, raw);
    Q.emit("pref", k, v);
    return v;
  };

  // ---- the open document ----------------------------------------------------

  Q.doc = {
    path() {
      try { return (window.File && window.File.filePath) || ""; } catch (_) { return ""; }
    },
    dir() {
      const p = Q.doc.path();
      return p ? p.slice(0, p.lastIndexOf("/")) : "";
    },
    name() {
      const p = Q.doc.path();
      return p ? p.slice(p.lastIndexOf("/") + 1) : "";
    },
    stem() {
      return Q.doc.name().replace(/\.[^.]+$/, "");
    },
    markdown() {
      try { return window.getMarkdown ? window.getMarkdown() : ""; } catch (_) { return ""; }
    },
    // the folder open in the sidebar if there is one, then the configured
    // default, then wherever the current file happens to live. without the
    // middle step every search panel is empty until you remember to open a
    // folder, which is most of the time.
    root() {
      let mounted = "";
      try {
        const F = window.File;
        mounted = (F.editor.library && F.editor.library.rootPath) || F.mountFolder || "";
      } catch (_) {}
      if (mounted) return mounted;
      const v = Q.vaultRoot();
      if (v) return v;
      return Q.doc.dir();
    },
    open(path) {
      return Q.call("controller.openInTypora", { path: path, forceInNewWindow: false })
        .catch(() => Q.invoke("path.openFile", path));
    },
    selection() {
      try { return Q.ed().selection.getTextInSelection() || ""; } catch (_) { return ""; }
    },
    // replace the selection in a single undo step
    replaceSelection(text) {
      const ed = Q.ed();
      try {
        ed.undo.exeCommand(() => ed.insertText(text, true));
      } catch (_) {
        ed.insertText(text, true);
      }
    },
    insert(text) {
      const ed = Q.ed();
      try {
        ed.undo.exeCommand(() => ed.insertText(text, false));
      } catch (_) {
        ed.insertText(text, false);
      }
    },
    save() {
      try { window.File.sync(); } catch (_) {}
    },
  };

  // the configured default, with ~ resolved once and remembered
  let vaultResolved = null;
  Q.vaultRoot = function () {
    if (vaultResolved !== null) return vaultResolved;
    const raw = (Q.prefs().vaultRoot || "").trim();
    if (!raw) return (vaultResolved = "");
    if (raw.charAt(0) !== "~") return (vaultResolved = raw.replace(/\/$/, ""));
    vaultResolved = "";                       // until the shell answers
    Q.shell("printf %s \"$HOME\"", "/").then((r) => {
      if (r.out) {
        vaultResolved = (r.out + raw.slice(1)).replace(/\/$/, "");
        Q.emit("vault", vaultResolved);
      }
    });
    return vaultResolved;
  };
  Q.setVaultRoot = function (path) {
    vaultResolved = null;
    Q.setPref("vaultRoot", path);
    return Q.vaultRoot();
  };

  // ---- events ---------------------------------------------------------------

  const listeners = {};
  Q.on = (evt, fn) => ((listeners[evt] = listeners[evt] || []).push(fn), fn);
  Q.emit = function (evt, ...args) {
    (listeners[evt] || []).forEach((fn) => {
      try { fn(...args); } catch (e) { Q.warn(evt, e); }
    });
  };

  // ---- helpers --------------------------------------------------------------

  Q.el = function (tag, attrs, html) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (html != null) e.innerHTML = html;
    return e;
  };

  Q.esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  Q.sh = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";   // single-quote for bash

  // the host bundles ripgrep 12.1.1 to power its own search. every scan here
  // uses it too, and the difference is not small: `find` over ~/Code took over
  // two minutes and rg does the same walk in 1.4 seconds. it also honours
  // .gitignore, so build output excludes itself without a list to maintain.
  let rgPath = null;
  Q.rg = function () {
    if (rgPath !== null) return rgPath;
    let href = location.href;
    try { href = decodeURI(href); } catch (_) {}
    const i = href.indexOf("/TypeMark/");
    if (i === -1) return (rgPath = "rg");
    const base = href.slice(0, i).replace(/^file:\/\//, "");
    rgPath = base.charAt(0) === "/" ? base + "/TypeMark/lib/bin/rg" : "rg";
    return rgPath;
  };

  // .gitignore covers most of it; these are the ones that are not ignored but
  // are still never what you are looking for.
  Q.SKIP = [
    ".git", "node_modules", "target", "build", "dist", ".build", "DerivedData",
    "Pods", ".venv", "venv", "__pycache__", ".next", ".cache", "vendor",
  ];
  // for find: prune the directory before descending into it, which is the part
  // that actually saves the time — -not -path still walks the whole tree.
  Q.FIND_PRUNE =
    "\\( -type d \\( " + Q.SKIP.map((d) => "-name " + JSON.stringify(d)).join(" -o ") +
    " \\) -prune \\) -o";
  Q.GREP_EXCL = Q.SKIP.map((d) => "--exclude-dir=" + JSON.stringify(d)).join(" ");

  Q.debounce = function (fn, ms) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
  };

  Q.date = function (d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  return Q;
})();
