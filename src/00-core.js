"use strict";
// quire / core
//
// every script under quire/ is loaded with defer, in filename order, from the
// end of index.html. by the time this runs the host runtime has already
// initialised, so window.File and File.editor exist. the document *text* does
// not, that arrives later over the bridge, so anything reading content waits.
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
  // as a string it is a plain shell, so the whole toolchain on this machine
  // git, grep, curl, find, is reachable from the editor.

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

  function raw(cmd, cwd) {
    const payload = { args: String(cmd), cwd: cwd || Q.doc.dir() || "" };
    const p = Q.channel === "invoke"
      ? Q.invoke("controller.runCommand", payload)
      : Q.call("controller.runCommand", payload);
    return p.then(parseResult);
  }

  // the native handler waits for the command to exit and only then reads what
  // it wrote. a unix pipe holds 64 KB; past that the child blocks on write, the
  // handler blocks on the child, and the promise never settles, the editor
  // just stops, with a stuck bash left behind. measured: 64000 bytes comes back
  // in 69ms, 70000 never comes back at all.
  //
  // so every command is capped below one buffer, on both streams. stderr goes
  // to a file rather than a second pipe because a pipe would deadlock the same
  // way, and PIPESTATUS carries the real exit status past the truncation.
  Q.OUT_MAX = 60000;

  function cap(cmd) {
    return '__qerr=$(mktemp -t quire 2>/dev/null) || __qerr="${TMPDIR:-/tmp}/quire-err.$$"; ( ' + cmd +
      '\n) 2>"$__qerr" | head -c ' + Q.OUT_MAX + '; __qst=${PIPESTATUS[0]}; ' +
      'head -c ' + Q.OUT_MAX + ' "$__qerr" >&2; rm -f "$__qerr"; exit $__qst';
  }

  Q.shell = function (cmd, cwd) {
    return raw(cap(cmd), cwd);
  };

  // for the one thing that genuinely needs more than a bufferful: a whole-vault
  // file listing. the command writes to a file and the result is read back in
  // chunks that each fit, base64'd so the trim in parseResult cannot eat a
  // newline on a chunk boundary.
  const CHUNK = 42000;                    // 42000 raw -> ~56000 base64

  // opts.raw keeps the bytes exactly as they came back: no trim, and the
  // Uint8Array is handed over alongside the text. the file viewer needs that
  // trimming a source file is a lie about its contents, and a reader that
  // silently edits what it shows is the first step towards a writer that
  // silently edits what it saves.
  Q.shellBig = function (cmd, cwd, limit, opts) {
    const max = limit || 4000000;
    const tmp = '"${TMPDIR:-/tmp}/quire-' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8) + '"';
    const bin = [];
    let total = 0;
    const done = (r) => Q.shell("rm -f " + tmp, cwd).then(() => r);

    function chunk(off, size) {
      if (off >= size) return Promise.resolve();
      return Q.shell(`tail -c +${off + 1} ${tmp} | head -c ${CHUNK} | base64`, cwd)
        .then((r) => {
          const b64 = r.out.replace(/\s+/g, "");
          if (!b64) return;
          bin.push(atob(b64));
          return chunk(off + CHUNK, size);
        });
    }

    return Q.shell(`( ${cmd}\n) > ${tmp} 2>/dev/null; wc -c < ${tmp}`, cwd)
      .then((r) => {
        total = parseInt(r.out, 10) || 0;
        const size = Math.min(total, max);
        return chunk(0, size);
      })
      .then(() => {
        const s = bin.join("");
        const bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
        const text = new TextDecoder("utf-8").decode(bytes);
        return { ok: true, code: 0, err: "", bytes: bytes,
                 size: total, truncated: total > bytes.length,
                 out: opts && opts.raw ? text : text.trim() };
      })
      .then(done, (e) => done(null).then(() => { throw e; }));
  };

  // run a command and hand it stdin without any quoting problems.
  // base64 in, decode in the shell, pipe to the command.
  Q.shellIn = function (cmd, stdin, cwd) {
    const b64 = btoa(unescape(encodeURIComponent(stdin)));
    return Q.shell(`printf %s ${JSON.stringify(b64)} | base64 --decode | ${cmd}`, cwd);
  };

  // the probe has to use a command whose *output* cannot appear in its own
  // text, the first version tested for a literal echoed back, and matched the
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
    // that search, files, tags, backlinks, need somewhere to look, and the
    // host only ever gives them a root once you have explicitly opened a folder.
    vaultRoot: "~/Code",
    notesDir: "",              // for daily notes / capture. empty = ask once
    dailyFormat: "YYYY-MM-DD",
    ollamaModel: "",           // empty = first model ollama reports
    ollamaHost: "http://127.0.0.1:11434",
    statusBar: true,
    proseStyle: false,         // our typography pass over the editor
    gitInStatusBar: true,
    // the sidebar is one column with sections, and it remembers where it was.
    // a workspace that forgets which panel you were in every launch is a popup.
    sideOpen: false,
    sideSection: "files",
    sideWidth: 300,
    // "block" holds a save that would rewrite lines nobody touched until the
    // answer is yes. "off" is the 2021 behaviour: whatever the writer produces
    // goes straight to disk.
    saveGuard: "block",
    stickyDir: "~/.quire/stickies",
    // a code block in a document is somebody else's text. "risky" asks before
    // anything on the destructive list, "always" asks before every run. there
    // is deliberately no "never": running is a human action, every time.
    runConfirm: "risky",
    transcriptDir: "~/.quire/transcripts",
    staleDays: 1,               // a doc is only behind if it is behind by this
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
        // the host's accessor is a method, not a property. reading
        // F.mountFolder or F.editor.library.rootPath returns undefined every
        // time, which is why every search panel used to ignore the folder you
        // had actually opened and fall through to the configured default.
        if (typeof F.getMountFolder === "function") mounted = F.getMountFolder() || "";
        if (!mounted) mounted = (F.editor.library && F.editor.library.rootPath) || F.mountFolder || "";
      } catch (_) {}
      if (mounted) mounted = String(mounted).replace(/\/+$/, "");
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
    // replace the selection in a single undo step.
    //
    // the save guard watches how many lines move per keystroke and gets loud
    // when a lot of them move at once, so anything that changes a page on
    // purpose says so first. a sort or a selection-to-table is not the writer
    // going haywire, it is the thing you asked for.
    replaceSelection(text) {
      const ed = Q.ed();
      try { Q.guard.deliberate(); } catch (_) {}
      try {
        ed.undo.exeCommand(() => ed.insertText(text, true));
      } catch (_) {
        ed.insertText(text, true);
      }
    },
    insert(text) {
      const ed = Q.ed();
      try { Q.guard.deliberate(); } catch (_) {}
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

  // $HOME, asked for once. javascript here has no environment: no node, no
  // process.env, and `~` is a shell thing, not a path thing. so anything that
  // wants a path under home has to go and ask.
  let homeResolved = null;
  Q.home = function () {
    if (homeResolved) return Promise.resolve(homeResolved);
    return Q.shell('printf %s "$HOME"', "/").then((r) => (homeResolved = r.out || ""));
  };
  Q.homeNow = () => homeResolved || "";
  Q.expand = function (p) {
    const raw = String(p == null ? "" : p);
    if (raw.charAt(0) !== "~") return Promise.resolve(raw.replace(/\/+$/, ""));
    return Q.home().then((h) => (h ? h + raw.slice(1) : raw).replace(/\/+$/, ""));
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

  // a path shown relative to a folder, but only when it really is inside it.
  // `startsWith(root)` is not that test: /Users/me/Code matches /Users/me/Codex
  // too, and slicing then eats the wrong first character.
  Q.rel = function (path, root) {
    path = String(path || "");
    if (!root) return path;
    if (path === root) return "";
    return path.indexOf(root + "/") === 0 ? path.slice(root.length + 1) : path;
  };

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
  // that actually saves the time, -not -path still walks the whole tree.
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

  Q.time = function (d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  // "3 days", "6 hours", "just now". used wherever a timestamp is only
  // interesting as a distance from now, which is most places.
  Q.ago = function (seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 90) return "just now";
    const mins = Math.round(s / 60);
    if (mins < 90) return mins + (mins === 1 ? " minute" : " minutes");
    const hrs = Math.round(mins / 60);
    if (hrs < 36) return hrs + (hrs === 1 ? " hour" : " hours");
    const days = Math.round(hrs / 24);
    if (days < 45) return days + (days === 1 ? " day" : " days");
    const months = Math.round(days / 30);
    if (months < 24) return months + (months === 1 ? " month" : " months");
    return Math.round(months / 12) + " years";
  };

  // the same distance phrased as a sentence. Q.ago answers "just now" as well as
  // "3 minutes", so three panels were printing "just now ago" at anything under
  // ninety seconds.
  Q.since = function (seconds) {
    const a = Q.ago(seconds);
    return a === "just now" ? a : a + " ago";
  };

  return Q;
})();
