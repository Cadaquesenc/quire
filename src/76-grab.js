"use strict";
// quire / grab the last output
//
// one key, and the last thing the terminal did lands in the document as a fenced
// block with the command above it as a caption.
//
// the terminal it reads is quire's own, the one in the sidebar, because that is
// the only terminal anything here can see. a real terminal's scrollback lives in
// a pty this app has no handle on, and the routes to it are all worse than the
// problem: applescript at Terminal.app steals focus, and scraping a ghostty
// window means a screenshot and OCR.
//
// so the shape of the feature is: run it in quire, paste it into the note. the
// companion command runs something and grabs it in one step, which is what you
// actually want most of the time.

(function (Q) {
  const MAX_LINES = 200;

  // the last command in the scrollback, with everything printed after it
  function lastRun() {
    const lines = (Q.term && Q.term.state && Q.term.state.lines) || [];
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].kind === "cmd") { at = i; break; }
    }
    if (at === -1) return null;
    const out = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (lines[i].kind === "cmd") break;
      if (lines[i].kind === "busy") continue;
      out.push(lines[i].text);
    }
    return { cmd: lines[at].text, out: out.join("\n") };
  }

  // a fence has to be longer than the longest run of backticks inside it, or the
  // block ends early and the rest of the output becomes prose
  function fence(body) {
    let longest = 0;
    (String(body).match(/`+/g) || []).forEach((r) => { longest = Math.max(longest, r.length); });
    return "`".repeat(Math.max(3, longest + 1));
  }

  function block(cmd, out) {
    let body = String(out == null ? "" : out).replace(/\s+$/, "");
    const all = body ? body.split("\n") : [];
    let note = "";
    if (all.length > MAX_LINES) {
      note = "\n… " + (all.length - MAX_LINES) + " more lines";
      body = all.slice(0, MAX_LINES).join("\n");
    }
    if (!body) body = "(no output)";
    const f = fence(body);
    // the command is the caption, on its own line above the block, as inline
    // code. a fence's info string is a language, not a label: putting the
    // command there would make the highlighter try to read it as one.
    return "`" + cmd.replace(/`/g, "’") + "`\n\n" + f + "\n" + body + note + "\n" + f + "\n";
  }

  // `fence` is shared with the code runner, which folds command output back into
  // the document and has the same problem: output with backticks in it needs a
  // longer fence or the block ends inside itself.
  Q.grab = { lastRun, block, fence };

  Q.command({
    id: "grabOutput", title: "Grab the last command and its output", category: "Quire",
    keys: "mod+alt+'",
    run: () => {
      const r = lastRun();
      if (!r) {
        Q.ui.showPanel("terminal");
        return Q.ui.toast("nothing has run yet · type a command and press this again");
      }
      Q.doc.insert(block(r.cmd, r.out));
      Q.ui.toast("grabbed <code>" + Q.esc(r.cmd.slice(0, 40)) + "</code>");
    },
  });

  Q.command({
    id: "runAndGrab", title: "Run a command and put the output here", category: "Quire",
    run: () => Q.ui.prompt("Run and paste the output", "", "git log --oneline -5").then((cmd) => {
      if (!cmd || !cmd.trim()) return;
      Q.ui.showPanel("terminal");
      return Q.term.run(cmd).then(() => {
        const r = lastRun();
        if (r) Q.doc.insert(block(r.cmd, r.out));
      });
    }),
  });
})(window.Q);
