"use strict";
// quire / terminal
//
// a real shell, in a panel. it runs on the same controller.runCommand handler
// everything else here does, which means one important limitation: each command
// is a separate non-interactive `bash -c`, run to completion, output collected
// at the end.
//
// so there is no pty. nothing that expects a terminal works, no vim, no top,
// no password prompts, no ctrl-c, and no output until the command finishes.
// `cd` is handled here rather than by the shell, because the shell that ran it
// is already gone by the time the next command starts.

(function (Q) {
  // `last` is what the code runner reads: the scrollback carries the text but
  // not the exit status, and a result block that cannot say `exit 1` is a
  // result block that hides the failure.
  const state = { cwd: "", history: [], hi: -1, lines: [], busy: false, last: null };
  const MAX_LINES = 400;

  function cwd() {
    return state.cwd || Q.doc.dir() || Q.doc.root() || "";
  }

  function push(kind, text) {
    state.lines.push({ kind, text });
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  }

  function shortCwd() {
    const home = "/Users/";
    let c = cwd();
    const i = c.indexOf(home);
    if (i === 0) {
      const rest = c.slice(home.length);
      const slash = rest.indexOf("/");
      c = "~" + (slash === -1 ? "" : rest.slice(slash));
    }
    return c || "/";
  }

  // `cd` has to be intercepted: every command runs in its own shell, so a real
  // cd would be forgotten the moment it exited.
  function handleCd(arg) {
    const target = (arg || "~").trim();
    const abs = target.startsWith("/") ? target
      : target.startsWith("~") ? "$HOME" + target.slice(1)
      : cwd() + "/" + target;
    return Q.shell(`cd ${abs.startsWith("$HOME") ? abs : Q.sh(abs)} 2>/dev/null && pwd`).then((r) => {
      if (r.out && r.out.startsWith("/")) {
        state.cwd = r.out;
        push("info", "→ " + shortCwd());
      } else {
        push("err", "cd: no such directory: " + target);
      }
    });
  }

  function run(cmd, render) {
    cmd = cmd.trim();
    if (!cmd) return Promise.resolve(null);
    push("cmd", cmd);
    state.history.push(cmd);
    state.hi = state.history.length;

    const started = Date.now();
    const where = cwd();
    // a `cd` or a `clear` is bookkeeping, not a command that ran, so it does not
    // become `last`. only a real shell run does.
    const cd = /^cd(\s+(.*))?$/.exec(cmd);
    let job;
    if (cd) {
      job = handleCd(cd[2]).then(() => null);
    } else if (cmd === "clear") {
      state.lines = [];
      job = Promise.resolve(null);
    } else {
      state.busy = true;
      render();
      job = Q.shell(cmd, where).then((r) => {
        if (r.out) push("out", r.out);
        if (r.err) push("err", r.err);
        if (!r.out && !r.err) push("info", r.ok ? "(no output)" : "(failed, no output)");
        // `code` is whatever the bridge chose to hand back. it is not reliably
        // the process's exit status: parseResult collapses the array form of a
        // result to a boolean, so anything that is not zero arrives as 1. that
        // is why a result block says `ok` or `failed` and not `exit 3`.
        const res = { cmd: cmd, cwd: where, out: r.out, err: r.err, ok: !!r.ok,
                      code: r.code == null ? (r.ok ? 0 : 1) : r.code,
                      ms: Date.now() - started };
        state.last = res;
        return res;
      });
    }
    return job.then((res) => { state.busy = false; render(); return res; },
                    (e) => {
                      state.busy = false;
                      push("err", String(e));
                      render();
                      state.last = { cmd: cmd, cwd: where, out: "", err: String(e),
                                     ok: false, code: -1, ms: Date.now() - started };
                      return state.last;
                    });
  }

  // the section keeps its element while you are off looking at something else,
  // so this is the live redraw for the dom that is already built. going back
  // through refreshPanel would rebuild it and throw away the scrollback, the
  // cwd and whatever is half-typed in the input, which is the whole reason the
  // terminal was worth moving into the sidebar in the first place.
  let liveRender = null;
  let liveInput = null;

  Q.term = {
    state,
    run(c) {
      if (!liveRender) Q.ui.showPanel("terminal");
      return run(c, () => liveRender && liveRender());
    },
    focus() { if (liveInput && !liveInput.disabled) liveInput.focus(); },
  };

  Q.ui.registerPanel("terminal", "Terminal", function (body) {
    body.classList.add("q-term-body");
    body.innerHTML =
      '<div class="q-term-out"></div>' +
      '<div class="q-term-input-row">' +
      // the path and the caret are two elements on purpose. the path ellipsises
      // from the left, which needs direction:rtl, and a neutral character like
      // "›" inside an rtl run gets mirrored and moved to the other end: the
      // prompt read "‹ quire-demo/~" instead of "quire-demo/~ ›".
      '<span class="q-term-prompt"></span><span class="q-term-caret">›</span>' +
      '<input class="q-term-input" spellcheck="false" autocomplete="off" placeholder="a command…">' +
      "</div>";

    const out = body.querySelector(".q-term-out");
    const input = body.querySelector(".q-term-input");
    const prompt = body.querySelector(".q-term-prompt");
    liveInput = input;

    function render() {
      prompt.textContent = shortCwd();
      out.innerHTML = state.lines.map((l) =>
        l.kind === "cmd"
          ? '<div class="q-term-line cmd"><span class="q-term-ps">›</span>' + Q.esc(l.text) + "</div>"
          : '<div class="q-term-line ' + l.kind + '">' + Q.esc(l.text) + "</div>").join("") +
        (state.busy ? '<div class="q-term-line busy"><span class="q-spinner sm"></span>running…</div>' : "");
      out.scrollTop = out.scrollHeight;
      input.disabled = state.busy;
      // only take the caret if the terminal is the section on screen. a command
      // finishing in the background must not pull focus out of the document.
      if (!state.busy && !body.hidden) input.focus();
    }
    liveRender = render;

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = input.value;
        input.value = "";
        run(cmd, render);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!state.history.length) return;
        state.hi = Math.max(0, state.hi - 1);
        input.value = state.history[state.hi] || "";
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        state.hi = Math.min(state.history.length, state.hi + 1);
        input.value = state.history[state.hi] || "";
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = "";
      } else if (e.key === "l" && e.ctrlKey) {
        e.preventDefault();
        state.lines = [];
        render();
      }
    }, true);

    if (!state.lines.length) {
      push("info", "a real shell, one command at a time. no pty, nothing interactive,");
      push("info", "and no output until a command finishes. ⌃L clears, ↑ recalls.");
    }
    render();
    setTimeout(() => { if (!body.hidden) input.focus(); }, 30);
  }, "terminal", 60);

  // switching back to the terminal puts the caret where you expect it
  Q.on("sidebar", (id) => { if (id === "terminal") setTimeout(() => Q.term.focus(), 20); });

  Q.command({
    id: "terminal", title: "Terminal", category: "Quire", keys: "mod+alt+j",
    run: () => Q.ui.togglePanel("terminal"),
  });

  // run whatever is selected in the document, which is the thing you actually
  // want when a note has a command in it
  Q.command({
    id: "runSelection", title: "Run the selection as a command", category: "Quire",
    run: () => {
      const sel = Q.doc.selection().trim();
      if (!sel) return Q.ui.toast("nothing selected");
      Q.ui.showPanel("terminal");
      return Q.term.run(sel);
    },
  });
})(window.Q);
