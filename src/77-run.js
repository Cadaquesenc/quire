"use strict";
// quire / runnable code blocks
//
// every other markdown editor renders a ```bash block as dead text. this one has
// a real shell wired to the same handler everything else here runs on, so the
// block can actually be a button.
//
// three rules, and they are the whole design:
//
// 1. **nothing ever runs on its own.** not on open, not on load, not on focus,
//    not on a reload, not on a poll. a document is untrusted input. anybody can
//    put `rm -rf ~` in a fence and mail it to you, and an editor that runs what
//    it renders is a remote code execution bug with syntax highlighting. the
//    only two callers of `exec` in this file are a click handler and a palette
//    command, and the selftest proves it by loading a fence whose command
//    writes a marker file and then checking the marker is not there.
// 2. **anything that could destroy something asks first.** the classifier below
//    is deliberately loud rather than clever: it would rather ask about a `mv`
//    that was fine than stay quiet about an `rm` that was not.
// 3. **the output goes back into the document**, in a ```quire-out fence right
//    under the block that produced it, so the note becomes a record of what
//    actually happened rather than a list of things you could type.
//
// the run happens in the sidebar terminal, not in a hidden shell, so you can
// see it happen and it inherits the same cwd as everything you type there.

(function (Q) {
  const SHELL_LANGS = { bash: 1, sh: 1, zsh: 1 };
  const OUT_LANG = "quire-out";
  const MAX_LINES = 200;          // lines of output folded into the document
  const MAX_BLOCK = 20000;        // characters of output folded in

  // ---- reading fences out of the source --------------------------------------
  //
  // the DOM knows where a fence is on screen; only the markdown knows where it
  // is in the file, and the file is what gets edited. so the affordance is
  // placed from the DOM and the edit is computed from the source, and the two
  // are joined by matching the code text rather than by trusting that the nth
  // <pre> is the nth fence. an indented code block renders as .md-fences too and
  // is not a fence in the source at all, which is exactly the kind of off by one
  // that would make a run button write its output under somebody else's block.

  function scan(md) {
    const text = String(md == null ? "" : md);
    const lines = text.split("\n");
    const offs = [];
    let at = 0;
    for (let k = 0; k < lines.length; k++) { offs.push(at); at += lines[k].length + 1; }
    const endOf = (k) => Math.min(text.length, offs[k] + lines[k].length + 1);

    const out = [];
    let i = 0;
    while (i < lines.length) {
      // commonmark: up to three spaces of indent, three or more backticks or
      // tildes, and an info string. a backtick fence's info string may not
      // itself contain a backtick.
      const m = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[i]);
      if (!m || (m[2].charAt(0) === "`" && m[3].indexOf("`") !== -1)) { i++; continue; }
      const marker = m[2].charAt(0);
      const len = m[2].length;
      const info = m[3].trim();
      const close = new RegExp("^ {0,3}\\" + marker + "{" + len + ",}[ \\t]*$");
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      const body = lines.slice(i + 1, Math.min(j, lines.length));
      // a fence nobody closed runs to the end of the document, and splitting a
      // text that ends in a newline leaves one empty element that is the split
      // artefact rather than a line of code.
      if (j >= lines.length && body.length && body[body.length - 1] === "") body.pop();
      out.push({
        index: out.length,
        lang: (info.split(/\s+/)[0] || "").toLowerCase(),
        info: info,
        code: body.join("\n"),
        openLine: i,
        closeLine: Math.min(j, lines.length - 1),
        start: offs[i],
        end: j < lines.length ? endOf(j) : text.length,
      });
      i = j + 1;
    }
    return out;
  }

  const isShell = (f) => !!SHELL_LANGS[f.lang];
  const isResult = (f) => f.lang === OUT_LANG;

  // the result fence belonging to a fence: the next fence in the document, if
  // nothing but blank lines separates them and it is one of ours.
  function resultFor(md, list, f) {
    const next = list[f.index + 1];
    if (!next || !isResult(next)) return null;
    const between = String(md).slice(f.end, next.start);
    return /^\s*$/.test(between) ? next : null;
  }

  // ---- what a run is allowed to do without asking ----------------------------
  //
  // this is a warning list, not a security boundary. there is no sandbox here:
  // the command runs as you, with your keys and your filesystem, the same as if
  // you had typed it. the list exists so that the common ways a pasted snippet
  // ruins your afternoon cannot happen without somebody reading the command
  // first.

  const RISKS = [
    [/(^|[;&|(\s])(sudo|doas)\s/, "runs as root"],
    [/(^|[;&|(\s])rm\s/, "deletes files"],
    [/(^|[;&|(\s])(rmdir|unlink|shred|srm)\s/, "deletes files"],
    [/(^|[;&|(\s])mv\s/, "moves files over each other"],
    [/-delete(\s|$)/, "find -delete"],
    [/-exec\s+rm\b/, "find -exec rm"],
    [/(^|[;&|(\s])(dd|mkfs|newfs|fdisk|diskutil)\s/, "writes to a device"],
    [/>\s*\/dev\/(disk|rdisk)/, "writes to a device"],
    [/\b(chmod|chown|chflags)\s+(-[a-zA-Z]*[rR][a-zA-Z]*)\b/, "recursive permission change"],
    [/(^|[;&|(\s])(kill|pkill|killall)\s/, "kills processes"],
    [/(^|[;&|(\s])(shutdown|reboot|halt)\b/, "shuts the machine down"],
    [/git\s+push/, "pushes to a remote"],
    [/git\s+(reset\s+--hard|clean\s+-\S*[dfx]|filter-branch|checkout\s+--\s)/, "throws away work in git"],
    [/git\s+branch\s+-D/, "deletes a branch"],
    [/(curl|wget)[^|]*\|\s*(sudo\s+)?(ba|z|)sh/, "pipes the network into a shell"],
    [/(^|[;&|(\s])(brew|npm|pnpm|yarn|pip3?|gem|cargo)\s+(install|uninstall|remove|add|publish)/, "installs or publishes packages"],
    [/(^|[;&|(\s])defaults\s+(write|delete)/, "changes a preference domain"],
    [/(^|[;&|(\s])(launchctl|crontab|security|systemsetup)\s/, "changes system state"],
    [/(^|[;&|(\s])(osascript|open\s+-a)\s/, "drives another application"],
    [/:\s*\(\s*\)\s*\{.*\|\s*:/, "fork bomb"],
    // a real redirect over a file, not `2>/dev/null` and not `2>&1`. a digit or
    // an & next to the arrow is a file descriptor, and /dev/null is a bin.
    [/(^|[^->&0-9])>>?\s*(?!\/dev\/null\b)(?!&)[^\s>|&;]+/, "redirects output over a file"],
  ];

  // what this cannot see, said out loud: it reads the literal text of the
  // command. `eval`, `$(...)`, a variable holding a path, a script invoked by
  // name, all of them defeat it, and flagging every `$(` would just teach you to
  // click through the question. so this is a seatbelt, not a sandbox, and the
  // dialog says as much.

  function classify(cmd) {
    const s = String(cmd || "");
    const why = [];
    RISKS.forEach((r) => { if (r[0].test(s) && why.indexOf(r[1]) === -1) why.push(r[1]); });
    return { risk: why.length ? "high" : "low", why: why };
  }

  // ---- the block that gets folded back in ------------------------------------

  function resultBlock(res) {
    let body = String(res.out == null ? "" : res.out);
    if (res.err) body = body ? body + "\n" + res.err : res.err;
    body = body.replace(/\s+$/, "");
    const all = body ? body.split("\n") : [];
    let note = "";
    if (all.length > MAX_LINES) {
      note = "\n… " + (all.length - MAX_LINES) + " more lines";
      body = all.slice(0, MAX_LINES).join("\n");
    }
    if (body.length > MAX_BLOCK) {
      note = "\n… " + (body.length - MAX_BLOCK) + " more characters";
      body = body.slice(0, MAX_BLOCK);
    }
    if (!body) body = "(no output)";
    // `ok` and `failed`, not `exit 3`. the bridge collapses a command's status to
    // a boolean on the way back, so a number here would be made up.
    const secs = (res.ms || 0) < 1000 ? (res.ms || 0) + "ms" : ((res.ms || 0) / 1000).toFixed(2) + "s";
    const head = (res.ok ? "ok" : "failed") + " · " + secs + " · " + Q.time() +
                 (all.length ? " · " + all.length + (all.length === 1 ? " line" : " lines") : "");
    const inner = head + "\n" + body + note;
    const f = Q.grab.fence(inner);
    return f + OUT_LANG + "\n" + inner + "\n" + f + "\n";
  }

  // put `block` under `f`, replacing the result that is already there if there
  // is one. returns the new markdown, or null if nothing would change.
  function splice(md, f, block) {
    const text = String(md);
    const list = scan(text);
    const me = list[f.index];
    if (!me || me.code !== f.code) return null;         // the document moved
    const old = resultFor(text, list, me);
    const from = me.end;
    const to = old ? old.end : me.end;
    let before = text.slice(0, from);
    const rest = text.slice(to);
    // a blank line above and below, because a fence welded to a paragraph is a
    // paragraph. usually `before` already ends in the newline that closed the
    // fence, but a document whose last character is the closing backtick does
    // not, and that is the case that produced ```` ```\n```quire-out ```` with
    // no blank line between them.
    if (before && before.charAt(before.length - 1) !== "\n") before += "\n";
    let ins = "\n" + block;
    if (rest && rest.charAt(0) !== "\n") ins += "\n";
    return before + ins + rest;
  }

  // ---- joining a <pre> on screen to a fence in the source --------------------

  function fenceEls() {
    const write = document.getElementById("write");
    if (!write) return [];
    return Array.prototype.slice.call(write.querySelectorAll("[mdtype='fences'][cid]"));
  }

  // the code inside a rendered fence. an untouched fence is a <pre> whose
  // innerText is the code; one that has been clicked into has been replaced by a
  // CodeMirror instance and the <pre> no longer holds the text at all, so the
  // node tree is asked instead. it is authoritative for both.
  function codeOf(el) {
    const cid = el.getAttribute("cid");
    try {
      const node = Q.ed().nodeMap.allNodes.get(cid);
      if (node) {
        const t = node.get("text");
        if (typeof t === "string") return t;
      }
    } catch (_) {}
    try {
      const cm = Q.ed().fences.queue[cid];
      if (cm) return cm.getValue();
    } catch (_) {}
    return el.innerText || "";
  }

  const norm = (s) => String(s == null ? "" : s).replace(/\s+$/, "");

  // find the source fence a rendered <pre> is showing. matched on lang plus the
  // code itself, and when a document has the same block twice, on which of the
  // matching ones this element is.
  function fenceFor(el, md) {
    const list = scan(md == null ? Q.doc.markdown() : md);
    const lang = (el.getAttribute("lang") || "").toLowerCase();
    const code = norm(codeOf(el));
    const same = fenceEls().filter((o) =>
      (o.getAttribute("lang") || "").toLowerCase() === lang && norm(codeOf(o)) === code);
    const nth = same.indexOf(el);
    const hits = list.filter((f) => f.lang === lang && norm(f.code) === code);
    if (!hits.length) return null;
    return hits[nth === -1 ? 0 : Math.min(nth, hits.length - 1)];
  }

  // ---- running ---------------------------------------------------------------

  let running = false;

  // our own confirm rather than Q.ui.confirm, because the useful part is the
  // command itself in monospace and the reason it was flagged. a native dialog
  // is out of the question anyway: a modal panel in this app blocks the app.
  function askRun(cmd, risk, where) {
    const body = Q.el("div", { class: "q-runask" });
    body.innerHTML =
      '<pre class="q-runask-cmd">' + Q.esc(cmd.length > 1200 ? cmd.slice(0, 1200) + "\n…" : cmd) + "</pre>" +
      (risk.why.length
        ? '<div class="q-runask-why"><b>it ' + Q.esc(risk.why.join(", ")) + "</b></div>"
        : "") +
      '<div class="q-runask-where">runs as you, in <code>' + Q.esc(where || "~") +
      "</code>. there is no sandbox, and this document is just a file somebody wrote.</div>";
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      Q.ui.modal({
        title: risk.risk === "high" ? "This command can destroy things" : "Run this?",
        body: body,
        buttons: [
          { label: "Cancel", run: () => finish(false) },
          { label: "Run it", primary: true, run: () => finish(true) },
        ],
      });
    });
  }

  function exec(f, opts) {
    const cmd = String(f.code || "").trim();
    if (!cmd) return Promise.resolve(null);
    if (running) { Q.ui.toast("one at a time · a command is already running"); return Promise.resolve(null); }

    const risk = classify(cmd);
    const always = Q.prefs().runConfirm === "always";
    const ask = (opts && opts.noConfirm) ? Promise.resolve(true)
      : (risk.risk === "high" || always) ? askRun(cmd, risk, Q.doc.dir())
      : Promise.resolve(true);

    return Promise.resolve(ask).then((yes) => {
      if (!yes) { Q.ui.toast("not run"); return null; }
      running = true;
      Q.ui.showPanel("terminal");
      return Q.term.run(cmd)
        .then((res) => {
          running = false;
          if (!res) return null;
          const md = Q.doc.markdown();
          const here = fenceAgain(md, f);
          if (!here) {
            Q.ui.toast("ran, but the block moved · output left in the terminal");
            return res;
          }
          const next = splice(md, here, resultBlock(res));
          if (next == null) {
            Q.ui.toast("ran, but the block moved · output left in the terminal");
            return res;
          }
          applyMarkdown(next);
          Q.ui.toast((res.ok ? "ran" : '<span class="q-bad">failed</span>') +
                     " · " + res.ms + "ms · output folded in");
          return res;
        }, (e) => { running = false; throw e; });
    });
  }

  // the document may have been typed into while the command ran, so the fence is
  // looked up again by content rather than by the index it had when it started.
  function fenceAgain(md, f) {
    const list = scan(md);
    if (list[f.index] && list[f.index].code === f.code && list[f.index].lang === f.lang) {
      return list[f.index];
    }
    const hit = list.filter((x) => x.lang === f.lang && x.code === f.code);
    return hit.length === 1 ? hit[0] : null;
  }

  // the whole document goes back through the parser. that is the one write path
  // this app has that lands text at an exact offset: insertText is a paste at
  // the caret, and the caret is wherever the person left it, which is not where
  // the output belongs. the cost is the scroll position, so it is put back.
  function applyMarkdown(next) {
    const content = document.querySelector("content");
    const top = content ? content.scrollTop : 0;
    try { Q.guard.deliberate(); } catch (_) {}
    window.File.reloadContent(next, {});
    // reloadContent registers one undo command tagged "reload", so ⌘Z takes the
    // output back out in a single step. it does not reliably mark the document
    // edited, and an edit that is not marked is an edit that is silently lost on
    // quit, so that is said explicitly.
    try { window.File.updateChangeCount(window.File.ChangeType.NSChangeDone); } catch (_) {}
    if (content) setTimeout(() => { content.scrollTop = top; }, 0);
    setTimeout(draw, 60);
  }

  // ---- the affordance --------------------------------------------------------
  //
  // a layer of absolutely positioned buttons over the fences rather than
  // anything inside them. a <pre> in this editor is either contenteditable=false
  // or a live CodeMirror, and putting a control inside either one means the
  // markdown writer eventually gets asked to serialise it.

  let layer = null;
  let raf = 0;

  function ensureLayer() {
    if (layer) return layer;
    layer = Q.el("div", { id: "q-run-layer" });
    document.body.appendChild(layer);
    return layer;
  }

  function shellEls() {
    return fenceEls().filter((el) => SHELL_LANGS[(el.getAttribute("lang") || "").toLowerCase()]);
  }

  // does this <pre> already have one of our result blocks under it? read off the
  // DOM, because the label is cosmetic and the source scan is not free.
  function hasResult(el) {
    let n = el.nextElementSibling;
    if (n && !n.getAttribute("cid")) n = n.nextElementSibling;
    return !!(n && (n.getAttribute("lang") || "").toLowerCase() === OUT_LANG);
  }

  function draw() {
    if (document.body.classList.contains("q-sticky")) { if (layer) layer.innerHTML = ""; return; }
    const els = shellEls();
    if (!els.length) { if (layer) layer.innerHTML = ""; return; }
    const wrap = ensureLayer();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const html = [];
    const keep = [];
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.width < 40) return;
      keep.push(el);
      const again = hasResult(el);
      // pinned by its right edge, not its left. the label is either "run" or
      // "re-run" and the pill is sized by its content, so anchoring the left
      // edge at a fixed offset put the two of them in different places.
      html.push('<button class="q-run-btn" data-i="' + (keep.length - 1) + '" tabindex="-1"' +
        ' style="top:' + Math.round(r.top + 7) + "px;right:" + Math.round(vw - r.right + 8) + 'px"' +
        ' title="' + (again ? "run it again and replace the output below" : "run this in the terminal") +
        '">' + Q.icon("play", 10) + "<span>" + (again ? "re-run" : "run") + "</span></button>");
    });
    wrap.innerHTML = html.join("");
    wrap.querySelectorAll(".q-run-btn").forEach((b) =>
      b.addEventListener("mousedown", (e) => {
        // mousedown, not click: clicking a <pre> in this editor hands focus to a
        // CodeMirror that gets created underneath the pointer, and the click
        // never arrives at the button that was there when the press started.
        e.preventDefault();
        e.stopPropagation();
        const el = keep[+b.dataset.i];
        if (!el) return;
        const f = fenceFor(el);
        if (!f) return Q.ui.error("could not find that block in the source");
        exec(f);
      }, true));
  }

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; try { draw(); } catch (_) {} });
  };
  const redraw = Q.debounce(schedule, 120);

  function wire() {
    const write = document.getElementById("write");
    const content = document.querySelector("content");
    if (!write || !content) return setTimeout(wire, 200);
    ensureLayer();
    content.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", redraw);
    write.addEventListener("input", redraw, true);
    Q.on("doc", () => setTimeout(schedule, 300));
    Q.on("sidebar", () => setTimeout(schedule, 220));
    // and nothing else. there is no timer here and no run on load: the only
    // thing this ever does by itself is move buttons around.
    setTimeout(schedule, 400);
  }

  // ---- commands --------------------------------------------------------------

  Q.runner = { scan, classify, resultBlock, splice, resultFor, exec, draw,
             fenceFor, fenceEls, shellEls, isShell, OUT_LANG };

  function fenceAtCursor() {
    let el = null;
    try {
      const focus = document.querySelector("#write .md-focus, #write .md-fences.ty-contain-cm.md-focus");
      el = focus && focus.closest("[mdtype='fences']");
    } catch (_) {}
    if (!el) {
      try {
        const cid = Q.ed().focusCid;
        if (cid) el = document.querySelector("[cid='" + cid + "']");
      } catch (_) {}
    }
    if (el && SHELL_LANGS[(el.getAttribute("lang") || "").toLowerCase()]) return fenceFor(el);
    return null;
  }

  Q.command({
    id: "runBlock", title: "Run the code block at the cursor", category: "Quire",
    keys: "mod+alt+enter",
    run: () => {
      const f = fenceAtCursor();
      if (!f) {
        const all = scan(Q.doc.markdown()).filter(isShell);
        return Q.ui.toast(all.length
          ? "put the cursor in a shell block · this document has " + all.length
          : "no bash, sh or zsh blocks in this document");
      }
      return exec(f);
    },
  });

  Q.command({
    id: "runList", title: "Run a code block from this document…", category: "Quire",
    run: () => {
      const list = scan(Q.doc.markdown()).filter(isShell);
      if (!list.length) return Q.ui.toast("no bash, sh or zsh blocks in this document");
      const items = list.map((f) => ({
        f: f,
        stem: (f.code.split("\n")[0] || "").slice(0, 60),
        rel: "line " + (f.openLine + 1) + "  ·  " + (f.code.split("\n")[0] || "").slice(0, 70),
      }));
      Q.pickNote(items, "Run a block", (it) => exec(it.f));
    },
  });

  Q.command({
    id: "runClear", title: "Remove every output block from this document", category: "Quire",
    run: () => {
      const md = Q.doc.markdown();
      const list = scan(md);
      const outs = list.filter(isResult);
      if (!outs.length) return Q.ui.toast("no output blocks here");
      let next = md;
      // back to front, so an earlier removal cannot move a later offset
      for (let i = outs.length - 1; i >= 0; i--) {
        const o = outs[i];
        let from = o.start;
        // eat the blank line that was put above it
        while (from > 0 && next.charAt(from - 1) === "\n" && next.charAt(from - 2) === "\n") from--;
        next = next.slice(0, from) + next.slice(o.end);
      }
      applyMarkdown(next);
      Q.ui.toast("removed " + outs.length + " output block" + (outs.length === 1 ? "" : "s"));
    },
  });

  Q.command({
    id: "runConfirm", title: "Toggle asking before every run", category: "Quire",
    run: () => {
      const always = Q.prefs().runConfirm === "always";
      Q.setPref("runConfirm", always ? "risky" : "always");
      Q.ui.toast(always ? "asking only about risky commands" : "asking before every run");
    },
  });

  wire();
})(window.Q);
