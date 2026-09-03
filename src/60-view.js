"use strict";
// quire / plain text view
//
// the reason this exists is a hazard, not a feature request.
//
// the file panel used to hand everything that wasn't markdown to the system,
// and everything that was, including .txt, to the editor. that second half is
// the dangerous one. this editor does not hold a document as text: it parses
// markdown into a node tree and *re-serialises* that tree on save. round-trip a
// .js file through it and what lands on disk is what the markdown writer thinks
// your code meant. `*ptr` becomes emphasis. a line starting with `#` becomes a
// heading. indented blocks become code fences. the file is gone.
//
// so non-markdown never goes near the editor. it opens here instead: a flat,
// monospaced, read-only pane over the document area. there is no save path in
// this file at all, no File.sync, no `cat >`, no write of any kind, which is
// the only guarantee of byte preservation worth making. see `q-view` in the
// selftest for the proof that what it shows is what is on disk, byte for byte.

(function (Q) {
  // read-only, so this cap is only about not building a million dom nodes
  const MAX_BYTES = 1500000;
  const MAX_LINES = 6000;

  const TEXT_EXT = [
    // plain
    "txt", "text", "log", "csv", "tsv", "rst", "org", "adoc", "tex", "bib",
    // config
    "json", "jsonc", "json5", "yml", "yaml", "toml", "ini", "cfg", "conf",
    "properties", "env", "plist", "xml", "svg", "lock", "editorconfig",
    "gitignore", "gitattributes", "gitmodules", "npmrc", "nvmrc", "babelrc",
    "eslintrc", "prettierrc", "dockerignore",
    // shell and make
    "sh", "bash", "zsh", "fish", "command", "mk", "make", "cmake", "bat", "ps1",
    // code
    "c", "h", "cc", "cpp", "hpp", "m", "mm", "swift", "rs", "go", "java", "kt",
    "kts", "scala", "cs", "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
    "py", "pyi", "rb", "erb", "php", "pl", "pm", "lua", "r", "jl", "hs", "ml",
    "elm", "ex", "exs", "erl", "clj", "cljs", "zig", "nim", "dart", "sql", "graphql",
    "gql", "proto", "sol", "vim", "el", "asm", "s", "gradle", "groovy",
    // web
    "css", "scss", "sass", "less", "styl", "html", "htm", "hbs", "ejs", "pug",
    "diff", "patch",
  ];
  const TEXT_SET = {};
  TEXT_EXT.forEach((e) => (TEXT_SET[e] = 1));

  // files that are text but carry no extension at all
  const BARE = /^(makefile|dockerfile|rakefile|gemfile|procfile|justfile|brewfile|cargo\.lock|license|licence|copying|authors|notice|changelog|todo|readme|\.[a-z0-9_-]+rc|\.env(\..+)?|\.gitignore|\.gitattributes|\.editorconfig|\.zshrc|\.bashrc|\.profile|config|hosts)$/i;

  const MD = /\.(md|markdown|mdown|mkd|mmd)$/i;

  Q.isMarkdownPath = (p) => MD.test(String(p));

  Q.isTextPath = function (p) {
    const name = String(p).slice(String(p).lastIndexOf("/") + 1);
    if (MD.test(name)) return false;                 // markdown belongs in the editor
    const dot = name.lastIndexOf(".");
    if (dot > 0) return !!TEXT_SET[name.slice(dot + 1).toLowerCase()];
    return BARE.test(name);
  };

  // ---- the pane -------------------------------------------------------------

  const state = { path: "", wrap: false, doc: null, el: null };

  function contentBox() {
    const c = document.querySelector("content");
    if (c) {
      const r = c.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) return r;
    }
    const side = document.body.classList.contains("q-panel-open")
      ? parseInt(getComputedStyle(document.documentElement).getPropertyValue("--q-side-w"), 10) || 300
      : 0;
    return {
      top: 28, left: 0,
      width: window.innerWidth - side,
      height: window.innerHeight - 28 - (document.body.classList.contains("q-status-on") ? 25 : 0),
    };
  }

  function place() {
    if (!state.el) return;
    const r = contentBox();
    state.el.style.top = r.top + "px";
    state.el.style.left = r.left + "px";
    state.el.style.width = r.width + "px";
    state.el.style.height = r.height + "px";
  }

  function ensureEl() {
    if (state.el) return state.el;
    state.el = Q.el("div", { id: "q-view" },
      '<div class="q-view-head">' +
        '<span class="q-view-icon"></span>' +
        '<span class="q-view-name"></span>' +
        '<span class="q-view-meta"></span>' +
        '<span class="q-view-ro" title="this pane never writes. nothing here can ' +
          'change the file.">read-only</span>' +
        '<span class="q-view-acts"></span>' +
      "</div>" +
      '<div class="q-view-note" hidden></div>' +
      '<div class="q-view-body"><div class="q-view-code"></div></div>');
    document.body.appendChild(state.el);
    window.addEventListener("resize", place);
    Q.on("sidebar", () => setTimeout(place, 20));
    try { new ResizeObserver(place).observe(document.querySelector("content")); } catch (_) {}
    return state.el;
  }

  function act(label, title, fn) {
    return { label, title, fn };
  }

  function drawActions() {
    const wrap = state.el.querySelector(".q-view-acts");
    const acts = [
      act(state.wrap ? "no wrap" : "wrap", "toggle soft wrapping", () => {
        state.wrap = !state.wrap;
        Q.setPref("viewWrap", state.wrap);
        state.el.querySelector(".q-view-body").classList.toggle("wrap", state.wrap);
        drawActions();
      }),
      act("copy", "copy the whole file to the clipboard", () => {
        if (!state.doc) return;
        try {
          navigator.clipboard.writeText(state.doc.text);
          Q.ui.toast("copied <b>" + Q.esc(state.doc.name) + "</b>");
        } catch (_) { Q.ui.error("clipboard refused"); }
      }),
      act("path", "copy the path", () => {
        try { navigator.clipboard.writeText(state.path); Q.ui.toast("path copied"); } catch (_) {}
      }),
      act("open", "hand it to whatever owns this file type", () =>
        Q.shell(`open ${Q.sh(state.path)}`)),
      act("close", "close (esc)", () => Q.view.close()),
    ];
    wrap.innerHTML = acts.map((a, i) =>
      '<span class="q-view-act" data-i="' + i + '" title="' + Q.esc(a.title) + '">' +
      Q.esc(a.label) + "</span>").join("");
    wrap.querySelectorAll(".q-view-act").forEach((el) =>
      el.addEventListener("click", () => acts[+el.dataset.i].fn()));
  }

  function render() {
    const d = state.doc;
    const el = state.el;
    el.querySelector(".q-view-icon").innerHTML = Q.icon(Q.iconForPath(state.path), 14);
    el.querySelector(".q-view-name").textContent = d.rel || d.name;
    el.querySelector(".q-view-meta").textContent =
      d.lines + (d.lines === 1 ? " line" : " lines") + " · " + human(d.size) + " · " + d.encoding;

    const note = el.querySelector(".q-view-note");
    if (d.note) { note.hidden = false; note.textContent = d.note; }
    else note.hidden = true;

    const body = el.querySelector(".q-view-body");
    body.classList.toggle("wrap", state.wrap);
    body.scrollTop = 0;

    const shown = d.rows.slice(0, MAX_LINES);
    const width = String(shown.length).length;
    el.querySelector(".q-view-code").innerHTML = shown.map((l, i) =>
      '<div class="q-view-row"><span class="q-view-n" style="width:' + (width * 0.62 + 1.4) +
      'em">' + (i + 1) + "</span><span class=\"q-view-l\">" +
      (l === "" ? "&nbsp;" : Q.esc(l)) + "</span></div>").join("");

    drawActions();
  }

  const human = (n) =>
    n < 1024 ? n + " B" :
    n < 1048576 ? (n / 1024).toFixed(1) + " KB" :
    (n / 1048576).toFixed(1) + " MB";

  const view = (Q.view = {});

  view.isOpen = () => !!(state.el && state.el.classList.contains("q-open"));
  view.path = () => (view.isOpen() ? state.path : "");
  view.doc = () => state.doc;

  view.close = function () {
    if (!state.el) return;
    state.el.classList.remove("q-open");
    document.body.classList.remove("q-view-open");
    state.doc = null;
    state.path = "";
    try { Q.ed().refocus(); } catch (_) {}
  };

  // the whole contract of this function: it reads. it does not write, it does
  // not hand the bytes to the editor, and nothing it returns can be saved.
  view.open = function (path) {
    const el = ensureEl();
    state.path = path;
    state.wrap = !!Q.prefs().viewWrap;
    const name = path.slice(path.lastIndexOf("/") + 1);

    el.classList.add("q-open");
    document.body.classList.add("q-view-open");
    place();
    el.querySelector(".q-view-name").textContent = name;
    el.querySelector(".q-view-meta").textContent = "reading…";
    el.querySelector(".q-view-code").innerHTML = "";
    el.querySelector(".q-view-note").hidden = true;
    drawActions();

    // encoding first. a binary file rendered as text is a wall of noise and a
    // hung layout, and `file` already knows the answer.
    return Q.shell(
      `file -b --mime-encoding ${Q.sh(path)} 2>/dev/null; wc -c < ${Q.sh(path)} 2>/dev/null`
    ).then((probe) => {
      const bits = (probe.out || "").split("\n");
      const encoding = (bits[0] || "unknown").trim();
      const size = parseInt(bits[1], 10) || 0;

      if (/binary/i.test(encoding)) {
        view.close();
        return Q.ui.confirm("Not a text file",
          name + " is " + encoding + ". open it with whatever owns it instead?")
          .then((yes) => { if (yes) Q.shell(`open ${Q.sh(path)}`); });
      }

      const cap = Math.min(size, MAX_BYTES);
      // raw: no trim. a viewer that quietly strips the blank line at the end of
      // a file is already not showing you the file.
      return Q.shellBig(`cat ${Q.sh(path)}`, path.slice(0, path.lastIndexOf("/")), cap, { raw: true })
        .then((r) => {
          const text = r.out;
          // a file that ends in a newline has N lines, not N+1. the trailing
          // empty element is the split artefact, not a line of the file, and
          // `text` itself is untouched, so nothing about the bytes changes.
          const rows = text === "" ? [] : text.split("\n");
          if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
          const lines = rows.length;
          const notes = [];
          if (size > MAX_BYTES) notes.push("showing the first " + human(MAX_BYTES) + " of " + human(size));
          if (lines > MAX_LINES) notes.push("showing the first " + MAX_LINES + " lines of " + lines);
          state.doc = {
            path, name, text, rows, size, encoding, lines,
            bytes: r.bytes,
            rel: Q.rel(path, Q.doc.root()),
            note: notes.join(" · "),
          };
          render();
          return state.doc;
        });
    });
  };

  // ---- keys and commands ----------------------------------------------------

  // opening a markdown document puts the editor back in front of you. leaving
  // the pane on top of a document that just changed underneath it is the kind
  // of thing that makes an app feel haunted.
  Q.on("doc", () => { if (view.isOpen()) view.close(); });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !view.isOpen()) return;
    if (Q.ui.isModalOpen()) return;
    if (document.querySelector("#q-palette.q-open")) return;
    e.preventDefault();
    e.stopPropagation();
    view.close();
  }, true);

  Q.command({
    id: "viewFile", title: "Open a file as plain text…", category: "Navigate", keys: "mod+alt+r",
    run: function () {
      return Q.files().then((rows) => {
        const items = rows.filter((f) => Q.isTextPath(f.path)).map((f) => ({
          path: f.path, stem: f.name, rel: f.reldir ? f.reldir + "/" + f.name : f.name,
        }));
        if (!items.length) return Q.ui.toast("no text files under this folder");
        Q.pickNote(items, "Open as plain text", (f) => view.open(f.path));
      });
    },
  });

  Q.command({
    id: "viewClose", title: "Close the plain text view", category: "Navigate",
    when: () => view.isOpen(),
    run: () => view.close(),
  });

  // the escape hatch, and it says out loud what it costs. the only way a file
  // reaches the markdown editor from here is a person reading this and saying
  // yes.
  Q.command({
    id: "viewAsMarkdown", title: "Open this file in the editor anyway (unsafe)", category: "Navigate",
    when: () => view.isOpen(),
    run: function () {
      const p = state.path;
      return Q.ui.confirm("Open in the markdown editor?",
        "the editor holds a document as a parsed markdown tree and rewrites the file " +
        "from that tree on save. saving " + state.doc.name + " after this will not " +
        "give you back the same bytes. open it read-only, or copy it somewhere first.")
        .then((yes) => { if (yes) { view.close(); Q.doc.open(p); } });
    },
  });
})(window.Q);
