"use strict";
// quire / the file guard
//
// two problems, one file, because they share a snapshot.
//
// 1. LIVE RELOAD. this editor was written in 2021 for a world where the file on
//    disk only changed when you changed it. it isn't that world any more: an
//    agent rewrites the same .md every few seconds, and a buffer loaded ten
//    minutes ago is a time machine pointed at someone else's work. the host does
//    have an NSFilePresenter path, `document.refreshContentFromDisk`, but it
//    only runs when the presenter fires and it asks with a native confirm(),
//    which is a modal, which is a thing this app must never raise. so: poll
//    mtime+size through the shell, reload when the buffer is clean, and put up a
//    bar when it is not.
//
// 2. THE SAVE REACHES PAST WHAT YOU EDITED. the editor does not hold a document
//    as text. it parses markdown into a node tree and serialises the tree back
//    out on save, so what lands on disk is what the markdown writer thinks you
//    meant, and the parser is minified with no source map so it cannot be
//    replaced.
//
//    how bad that is turned out to be a measurable question with a surprising
//    answer, and the measurement is in the devlog. a document written to break
//    it, 43 lines of setext headings, ragged tables, indented code, `+` bullets,
//    `1)` lists, ___underscores___, escapes, hard breaks, raw html and a
//    reference link, went in at 1053 bytes and came back out at 1053 bytes. zero
//    lines changed. the writer keeps the source of every block nobody has been
//    inside, so a file you open and save untouched is byte identical.
//
//    so the guard is not "the parser eats files". it is: a save may only change
//    what you changed. the line ranges you edited are tracked while you type,
//    the bytes about to be written are compared against the bytes on disk, and
//    anything reaching outside the ranges you touched holds the save.
//
// the save is intercepted at `File.getContent`, which is the handler native
// calls to ask javascript for the bytes it is about to write. that is the last
// point where anything on this side can still see them.

(function (Q) {
  const POLL_MS = 2500;
  const MAX_GUARD_BYTES = 400000;   // past this the base64 hop is the slow part

  const st = {
    path: "",
    disk: null,          // { text, mtime, size } as last read
    diskFresh: false,    // the last stat agreed with the snapshot
    base: null,          // what a save would have written at load, before edits
    phantom: null,       // { count, lines, diff } from disk vs base
    ack: false,          // the user said save it anyway
    conflict: null,      // { text, mtime, size } that landed while we were dirty
    lastServed: null,    // the string handed to native on the last save
    busy: false,
    hooked: false,
  };

  Q.guard = { state: st };

  // ---- the bytes a save would write -----------------------------------------
  //
  // getMarkdown() is the serialisation. the two things layered on top of it are
  // the line ending and the final newline, both of which the host tracks per
  // document and applies on the way out.

  function expected() {
    let md = "";
    if (!window.getMarkdown) return null;
    try { md = window.getMarkdown(); } catch (_) { return null; }
    if (typeof md !== "string") return null;
    const F = window.File || {};
    if (F.useCRLF) md = md.replace(/\r?\n/g, "\r\n");
    if (F.finalNewline && md && !/\n$/.test(md)) md += F.useCRLF ? "\r\n" : "\n";
    return md;
  }
  Q.guard.expected = expected;

  function isMarkdownDoc() {
    const p = Q.doc.path();
    return !!p && /\.(md|markdown|mmd|mkd|mdwn|mdown|mdx)$/i.test(p);
  }

  // two answers, and the second one is the one that is trusted.
  //
  // File.isDocumentEdited() asks the NSDocument over the bridge's synchronous
  // channel, which on this build is window.prompt, which the host has already
  // hijacked once. if that channel ever answers null the host reads it as "not
  // edited", and a guard that believes that would reload over unsaved work.
  //
  // so the real test is content. `base` is the serialisation of the buffer at
  // load, before anybody typed. if serialising it now gives something else, the
  // buffer has edits in it, whatever the document says about itself.
  function askedDirty() {
    try {
      const F = window.File;
      if (F && typeof F.isDocumentEdited === "function") return F.isDocumentEdited() === true;
    } catch (_) {}
    return false;
  }

  function dirty() {
    if (askedDirty()) return true;
    if (st.base == null) return false;
    const now = expected();
    if (now == null) return false;
    return now !== st.base;
  }
  Q.guard.dirty = dirty;
  Q.guard.askedDirty = askedDirty;

  // ---- reading the file -----------------------------------------------------

  function stat(path) {
    return Q.shell(`stat -f '%m %z' ${Q.sh(path)} 2>/dev/null`).then((r) => {
      const m = /^(\d+)\s+(\d+)$/.exec(r.out.trim());
      return m ? { mtime: +m[1], size: +m[2] } : null;
    });
  }

  function readFile(path) {
    // raw:true because trimming a file is a lie about its contents, and this
    // string is compared byte for byte against what a save would write
    return Q.shellBig(`cat ${Q.sh(path)}`, null, 4000000, { raw: true })
      .then((r) => (r && typeof r.out === "string" ? r.out : null));
  }

  // ---- diffs ----------------------------------------------------------------
  //
  // through the real `diff`, not a hand written one. it is on the machine, it is
  // correct, and the output is the format everyone already reads.

  function tmpName(tag) {
    return '"${TMPDIR:-/tmp}/quire-' + tag + "-" +
      Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + '"';
  }

  // diff a file on disk against a string in memory
  function diffAgainst(path, text, leftLabel, rightLabel) {
    if (text == null) return Promise.resolve(null);
    const tmp = tmpName("diff");
    return Q.shellIn("cat > " + tmp, text)
      .then(() => Q.shell(
        `diff -u --label ${Q.sh(leftLabel)} --label ${Q.sh(rightLabel)} ` +
        `${Q.sh(path)} ${tmp}; rm -f ${tmp}`))
      .then((r) => r.out || "");
  }

  // how many lines a unified diff actually changes, headers excluded
  function changedLines(diff) {
    if (!diff) return 0;
    let n = 0;
    diff.split("\n").forEach((l) => {
      if (l.charAt(0) === "-" && l.slice(0, 3) !== "---") n++;
      else if (l.charAt(0) === "+" && l.slice(0, 3) !== "+++") n++;
    });
    return n;
  }

  // the line numbers on the left side of the diff, so the bar can name them
  function hunkLines(diff) {
    const out = [];
    (diff || "").split("\n").forEach((l) => {
      const m = /^@@ -(\d+)(?:,(\d+))? /.exec(l);
      if (m) out.push(+m[1]);
    });
    return out;
  }

  // ---- what you actually touched --------------------------------------------
  //
  // this is the part the first version of this file got wrong, and the
  // measurement that killed it is in the devlog. the assumption was that
  // parse-then-serialise damages a file on its own, so opening one and saving it
  // untouched would rewrite lines. it does not. a 43 line document of setext
  // headings, ragged tables, indented code, `+` bullets, `1)` lists,
  // ___underscores___, escapes, hard breaks, raw html and a reference link went
  // in at 1053 bytes and came back out at 1053 bytes, zero lines changed. the
  // writer keeps the source of every block nobody has been inside.
  //
  // so the thing worth catching is not "the file drifted", it is "this save
  // reaches past what i edited". which means knowing what was edited, and the
  // only way to know that here is to watch the serialisation move: take it on a
  // debounce while you type and record the line range that changed each time.
  //
  // the honest limit: an edit tick folds your keystroke and anything the writer
  // did in the same tick into one range, so a reformat that lands on the same
  // 400ms as a keystroke is inside the hull and passes. that case is caught by
  // the other half instead, the width of a single tick: a person typing does not
  // move eight lines at once, and a command that legitimately does is flagged as
  // deliberate before it runs.

  const TICK_MS = 400;
  const WIDE_TICK = 8;      // lines moved by one tick of typing before it is odd
  const SLACK = 1;          // a block boundary either side of what you touched

  let hull = null;          // union of edited line ranges, current coordinates
  let lastSnap = null;      // the serialisation at the last tick
  let wide = null;          // a tick that moved far more than a keystroke should
  let deliberate = 0;       // a paste, an undo or one of our own transforms

  function splitLines(s) { return String(s).split("\n"); }

  // the first and last line where two texts differ, in b's coordinates.
  // common prefix and common suffix are trimmed, which is not a diff, it is the
  // hull of one, and the hull is what this needs.
  function span(a, b) {
    if (a == null || b == null || a === b) return null;
    const A = splitLines(a), B = splitLines(b);
    let i = 0;
    while (i < A.length && i < B.length && A[i] === B[i]) i++;
    let j = 0;
    while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
    return { from: i, to: Math.max(i, B.length - 1 - j), delta: B.length - A.length };
  }
  Q.guard.span = span;

  function widen(sp) {
    if (!hull) { hull = { from: sp.from, to: sp.to }; return; }
    // an edit above the hull moves the hull down by however many lines it added
    if (sp.to < hull.from) { hull.from += sp.delta; hull.to += sp.delta; }
    else if (sp.from <= hull.to) { hull.to += sp.delta; }
    hull.from = Math.min(hull.from, sp.from);
    hull.to = Math.max(hull.to, sp.to, hull.from);
  }

  function noteEdit(text) {
    const now = text == null ? expected() : text;
    if (now == null) return;
    if (lastSnap == null) lastSnap = st.base == null ? now : st.base;
    const sp = span(lastSnap, now);
    lastSnap = now;
    if (!sp) return;
    const width = Math.max(sp.to - sp.from + 1, Math.abs(sp.delta));
    if (width > WIDE_TICK && !deliberate) {
      // and it does NOT widen the hull. folding a suspicious tick into the set
      // of lines you are allowed to change is how the check gets talked out of
      // firing: the save asks "is this inside what i edited", and if the answer
      // came from the same change it is asking about, it is always yes.
      if (!wide) wide = { from: sp.from, to: sp.to, width: width };
      return;
    }
    if (deliberate > 0) deliberate--;
    widen(sp);
  }
  Q.guard.noteEdit = noteEdit;

  // a paste, an undo, or one of the twenty text transforms is allowed to move a
  // lot of lines at once. it is only surprising when nobody asked for it.
  Q.guard.deliberate = function () { deliberate = 2; };

  function resetEdits() { hull = null; lastSnap = null; wide = null; deliberate = 0; }

  // ---- the snapshot ---------------------------------------------------------
  //
  // taken once per document, after the parse has settled. `base` is the
  // serialisation of a buffer nobody has typed into yet, so disk vs base is
  // exactly the damage the writer does on its own.

  function snapshot(path) {
    if (!path) return Promise.resolve();
    st.path = path;
    st.disk = null; st.base = null; st.phantom = null;
    st.ack = false; st.conflict = null; st.diskFresh = false;
    resetEdits();
    hideBar();

    // stat before read. a file too big to hold twice in memory and push through
    // a base64 pipe is a file this guard says nothing about, out loud, rather
    // than one it spends ten shell round trips on every time it changes.
    return stat(path).then((s) => {
      if (!s || Q.doc.path() !== path) return;
      if (s.size > MAX_GUARD_BYTES) {
        st.disk = { text: null, mtime: s.mtime, size: s.size };
        st.diskFresh = true;
        st.phantom = { count: -1, lines: [], diff: "", big: true };
        return status();
      }
      return readFile(path).then((text) => {
        if (Q.doc.path() !== path) return;
        st.disk = { text: text == null ? "" : text, mtime: s.mtime, size: s.size };
        st.diskFresh = true;
        return measure(path);
      });
    });
  }

  // wait for the editor to have parsed something before serialising it, or the
  // "damage" measured is just an empty buffer against a full file
  function measure(path, tries) {
    tries = tries || 0;
    const exp = expected();
    if ((exp === null || (exp === "" && st.disk.text !== "")) && tries < 12) {
      return new Promise((r) => setTimeout(r, 250)).then(() => measure(path, tries + 1));
    }
    if (Q.doc.path() !== path) return;
    st.base = exp;
    if (exp === st.disk.text) {
      st.phantom = { count: 0, lines: [], diff: "" };
      return status();
    }
    if (exp == null || exp.length > MAX_GUARD_BYTES) {
      st.phantom = { count: -1, lines: [], diff: "", big: true };
      return status();
    }
    return diffAgainst(path, exp, "on disk", "after a save").then((diff) => {
      if (Q.doc.path() !== path) return;
      st.phantom = { count: changedLines(diff), lines: hunkLines(diff), diff: diff };
      status();
      if (st.phantom.count > 0) {
        showBar("rewrite",
          "<b>" + st.phantom.count + "</b> line" + (st.phantom.count === 1 ? "" : "s") +
          " you have not touched change when this file is saved",
          [{ label: "dismiss", run: hideBar },
           { label: "show what changes", run: showSaveDiff, primary: true }]);
      }
    });
  }

  // ---- the poller -----------------------------------------------------------

  function tick() {
    // deliberately not gated on document.hidden. the window being in the
    // background is exactly when a file gets rewritten under it, and this
    // window spends most of its life behind a terminal. one `stat` every two
    // and a half seconds is the price.
    if (st.busy) return;
    const path = Q.doc.path();
    if (!path) return;
    if (path !== st.path) { st.busy = true; return snapshot(path).then(() => { st.busy = false; }); }
    if (!st.disk || st.disk.mtime == null) return;

    st.busy = true;
    stat(path).then((s) => {
      if (!s) { st.busy = false; return; }          // file went away, leave it alone
      if (s.mtime === st.disk.mtime && s.size === st.disk.size) {
        st.diskFresh = true;
        st.busy = false;
        return;
      }
      st.diskFresh = false;
      if (s.size > MAX_GUARD_BYTES) {
        st.disk = { text: null, mtime: s.mtime, size: s.size };
        st.busy = false;
        return;
      }
      return readFile(path).then((text) => {
        st.busy = false;
        if (Q.doc.path() !== path) return;
        if (text == null) return;
        onDiskChanged(path, text, s);
      });
    }, () => { st.busy = false; });
  }

  function onDiskChanged(path, text, s) {
    // the buffer already holds what landed. either the host's own presenter got
    // there first and reloaded, or this is a save of ours coming back. nothing
    // to reconcile, just move the baseline.
    const now = expected();
    if (now != null && now === text) {
      st.disk = { text: text, mtime: s.mtime, size: s.size };
      st.diskFresh = true;
      st.base = text;
      st.conflict = null;
      st.ack = false;
      st.lastServed = null;
      st.phantom = { count: 0, lines: [], diff: "" };
      resetEdits();
      status();
      return;
    }

    // our own save coming back at us. the bytes we handed native are the bytes
    // that landed, so this is not somebody else's edit.
    if (st.lastServed != null && text === st.lastServed) {
      st.disk = { text: text, mtime: s.mtime, size: s.size };
      st.diskFresh = true;
      st.base = text;                       // saved output is the new baseline
      st.phantom = { count: 0, lines: [], diff: "" };
      st.ack = false;
      st.lastServed = null;
      // and the edit ranges start again from here. carrying them across a save
      // would leave the hull covering the whole file after an afternoon.
      resetEdits();
      status();
      return;
    }

    if (!dirty()) {
      // clean buffer, take it. the scroll position is restored because losing
      // your place every time an agent writes a file is its own kind of damage.
      const c = document.querySelector("content");
      const top = c ? c.scrollTop : 0;
      try { window.File.reloadContent(text, { fromDiskChange: true }); } catch (e) { Q.warn("reload", e); }
      // and put the document back to unedited. reloadContent registers an undo
      // command, which marks the NSDocument dirty, which is wrong twice: the
      // titlebar says Edited for a file nobody edited, and the host's own
      // external-change handler reads the same flag and raises a modal over it.
      try { window.File.updateChangeCount(window.File.ChangeType.NSChangeCleared); } catch (_) {}
      setTimeout(() => { if (c) c.scrollTop = top; }, 60);
      st.disk = { text: text, mtime: s.mtime, size: s.size };
      st.diskFresh = true;
      st.conflict = null;
      st.ack = false;
      st.lastServed = null;
      // the reload re-parses, so the damage measurement has to be retaken
      setTimeout(() => measure(path), 200);
      Q.ui.toast("reloaded from disk · " + Q.doc.name());
      status();
      return;
    }

    // dirty buffer and the file moved under it. nothing is written from here
    // until somebody chooses.
    st.conflict = { text: text, mtime: s.mtime, size: s.size };
    status();
    showBar("conflict",
      "<b>" + Q.esc(Q.doc.name()) + "</b> changed on disk while you had unsaved edits",
      [{ label: "keep mine", run: keepMine },
       { label: "take theirs", run: takeTheirs },
       { label: "show diff", run: showConflictDiff, primary: true }]);
  }

  // ---- the three answers ----------------------------------------------------

  function keepMine() {
    if (!st.conflict) return hideBar();
    // the snapshot moves forward to their bytes so the next save is not blocked
    // again by the same change, but the buffer is untouched: yours wins.
    st.disk = { text: st.conflict.text, mtime: st.conflict.mtime, size: st.conflict.size };
    st.diskFresh = true;
    st.conflict = null;
    st.ack = true;
    hideBar();
    status();
    Q.ui.toast("keeping your version · save to write it over theirs");
  }

  function takeTheirs() {
    if (!st.conflict) return hideBar();
    const path = Q.doc.path();
    const c = document.querySelector("content");
    const top = c ? c.scrollTop : 0;
    try { window.File.reloadContent(st.conflict.text, { fromDiskChange: true }); }
    catch (e) { return Q.ui.error("reload failed: " + e.message); }
    setTimeout(() => { if (c) c.scrollTop = top; }, 60);
    st.disk = { text: st.conflict.text, mtime: st.conflict.mtime, size: st.conflict.size };
    st.diskFresh = true;
    st.conflict = null;
    st.ack = false;
    hideBar();
    setTimeout(() => measure(path), 200);
    Q.ui.toast("took the version on disk · <kbd>⌘Z</kbd> undoes it");
  }

  function showConflictDiff() {
    if (!st.conflict) return;
    const mine = expected();
    const tmp = tmpName("mine");
    Q.shellIn("cat > " + tmp, mine == null ? "" : mine)
      .then(() => Q.shell(
        `diff -u --label ${Q.sh("theirs, on disk")} --label ${Q.sh("mine, in the editor")} ` +
        `${Q.sh(Q.doc.path())} ${tmp}; rm -f ${tmp}`))
      .then((r) => showDiff("What changed on disk", r.out || "(identical)"));
  }

  function showSaveDiff() {
    const path = Q.doc.path();
    const exp = expected();
    if (!path || exp == null) return Q.ui.toast("no document to compare");
    if (exp.length > MAX_GUARD_BYTES) return Q.ui.toast("too big to check");
    return diffAgainst(path, exp, "on disk now", "what a save writes").then((diff) => {
      if (!diff) return Q.ui.toast("a save writes exactly what is already there");
      showDiff("What a save writes", diff);
    });
  }

  function showDiff(title, text) {
    const body = Q.el("div", { class: "q-diff" });
    body.innerHTML = text.split("\n").map((l) => {
      const c = l.charAt(0);
      const cls = l.slice(0, 3) === "---" || l.slice(0, 3) === "+++" ? "f"
        : c === "@" ? "h" : c === "-" ? "d" : c === "+" ? "a" : "";
      return '<div class="q-diff-l ' + cls + '">' + Q.esc(l || " ") + "</div>";
    }).join("");
    Q.ui.modal({
      title: title, body: body, wide: true,
      buttons: [
        { label: "Copy", keepOpen: true, run: () => Q.invoke("clipboard.write", text)
            .then(() => Q.ui.toast("copied")) },
        { label: "Done", primary: true },
      ],
    });
  }

  // ---- the bar --------------------------------------------------------------
  //
  // a bar and not a modal on purpose. a modal in this app is a trap: the host
  // raises its own native panels and two of those at once is how an agent lost
  // twenty one minutes. this one sits under the titlebar and can be ignored.

  let barEl = null;

  function ensureBar() {
    if (barEl) return barEl;
    barEl = Q.el("div", { id: "q-guardbar" },
      '<span class="q-guardbar-dot"></span>' +
      '<span class="q-guardbar-msg"></span>' +
      '<span class="q-guardbar-acts"></span>' +
      '<span class="q-guardbar-x q-iconbtn" title="dismiss">' +
        (Q.icon ? Q.icon("close", 12) : "&times;") + "</span>");
    document.body.appendChild(barEl);
    barEl.querySelector(".q-guardbar-x").addEventListener("click", hideBar);
    return barEl;
  }

  function showBar(kind, html, actions) {
    const b = ensureBar();
    b.dataset.kind = kind;
    b.querySelector(".q-guardbar-msg").innerHTML = html;
    const acts = b.querySelector(".q-guardbar-acts");
    acts.innerHTML = "";
    (actions || []).forEach((a) => {
      const el = Q.el("button", {
        class: "q-guardbar-btn" + (a.primary ? " primary" : ""), type: "button",
      }, Q.esc(a.label));
      el.addEventListener("click", a.run);
      acts.appendChild(el);
    });
    b.classList.add("q-open");
  }

  function hideBar() {
    if (barEl) barEl.classList.remove("q-open");
  }
  Q.guard.hideBar = hideBar;

  // ---- the status bar cell --------------------------------------------------

  let slot = null;
  function status() {
    if (!slot) {
      slot = Q.ui.slot("guard", { order: 20, side: "right", onClick: () => Q.run("saveDiff") });
    }
    if (st.conflict) {
      return slot.set('<span class="q-bad">disk changed</span>',
        "the file moved under your edits, nothing is written until you choose");
    }
    if (st.phantom && st.phantom.count > 0 && !st.ack) {
      return slot.set('<span class="q-warn">' + st.phantom.count + " rewritten</span>",
        "this file did not survive being read: " + st.phantom.count +
        " lines came back different before you touched anything");
    }
    if (st.ack) return slot.set('<span class="q-warn">guard off here</span>',
      "you said write it anyway, so saves on this file go straight through");
    slot.set("", "");
  }

  // ---- the save hook --------------------------------------------------------
  //
  // this replaces the host's own File.getContent handler. the body is a faithful
  // copy of it, because there is no way to read the previous handler back out of
  // the bridge: registerHandler writes into a closure-local map with no getter.
  // the host's version is:
  //
  //   bridge.registerHandler("File.getContent", function (t, e) {
  //     if (File.validateContentForSave() === false) File.showDataLostError();
  //     e(File.sync(true, false, true, t));
  //   });
  //
  // the only thing added is a decision about which string goes back, and that
  // decision is synchronous by construction: everything it reads was computed
  // when the document loaded. no promise, no shell, no delay. a handler that
  // waited here would leave native waiting for content mid-save, which is the
  // one failure mode worse than the bug it is fixing.

  // why can it decide to hold a save?
  //   the file moved on disk and nobody has looked at what landed
  //   the save reaches into lines no edit ever went near
  //   one tick of typing moved eight lines, so something else was typing
  //   the file did not round trip on the way in, before anybody touched it
  // and the answer to all four is the same: give native back the bytes the file
  // already has, which is a save that writes nothing, and then ask.
  function why(content) {
    if (st.conflict && typeof st.conflict.text === "string") {
      return { kind: "conflict", text: st.conflict.text };
    }
    if (st.ack || !st.diskFresh || !st.disk || typeof st.disk.text !== "string") return null;

    if (st.phantom && st.phantom.count > 0) {
      return { kind: "phantom", text: st.disk.text, n: st.phantom.count };
    }
    // fold the last keystroke in first. the edit watcher runs on a debounce and
    // a save lands between ticks more often than not, so without this the very
    // change you just made looks like it came from nowhere.
    noteEdit(content);
    if (wide) return { kind: "wide", text: st.disk.text, at: wide };

    const sp = span(st.disk.text, content);
    if (!sp) return null;
    if (!hull) return { kind: "untouched", text: st.disk.text, at: sp };
    if (sp.from < hull.from - SLACK || sp.to > hull.to + SLACK) {
      return { kind: "outside", text: st.disk.text, at: sp };
    }
    return null;
  }

  function substitute(content) {
    if (!isMarkdownDoc()) return null;
    if (Q.prefs().saveGuard === "off") return null;
    if (Q.sticky && Q.sticky.isSticky && Q.sticky.isSticky(Q.doc.path())) return null;
    if (Q.guard._force != null) return Q.guard._force;      // selftest only

    const held = why(content);
    if (!held) return null;
    st.held = held.kind;
    setTimeout(() => ask(held), 0);
    return held.text;                 // the file's own bytes: a save that writes nothing
  }
  Q.guard.why = why;

  const REASON = {
    conflict: (h) => "<b>" + Q.esc(Q.doc.name()) + "</b> changed on disk while you were editing " +
      "it. writing now would put your copy over whatever landed.",
    phantom: (h) => "this file did not survive being read. <b>" + h.n + "</b> line" +
      (h.n === 1 ? "" : "s") + " came back out of the parser different from the way they " +
      "went in, before you touched anything, and a save writes the parser's version.",
    wide: (h) => "one moment of typing moved <b>" + h.at.width + "</b> lines at once, around " +
      "line " + (h.at.from + 1) + ". a keystroke moves one.",
    untouched: (h) => "nothing was edited in this window, but a save would still change the " +
      "file, from line " + (h.at.from + 1) + ".",
    outside: (h) => "this save changes lines " + (h.at.from + 1) + " to " + (h.at.to + 1) +
      ", and the part you edited is lines " + ((hull ? hull.from : 0) + 1) + " to " +
      ((hull ? hull.to : 0) + 1) + ". the rest is the writer, not you.",
  };

  let asking = false;
  function ask(held) {
    if (asking || Q.ui.isModalOpen()) return;
    asking = true;
    Q.ui.modal({
      title: "Nothing was written",
      body:
        "<p>" + REASON[held.kind](held) + "</p>" +
        "<p>the file on disk is exactly as it was. your edits are still in the window.</p>",
      buttons: [
        { label: "Show the diff", keepOpen: true,
          run: () => (held.kind === "conflict" ? showConflictDiff() : showSaveDiff()) },
        { label: "Cancel", run: () => { asking = false; } },
        { label: "Write it anyway", primary: true, run: () => {
            asking = false;
            st.ack = true;
            st.conflict = null;
            status();
            hideBar();
            try { window.File.updateChangeCount(window.File.ChangeType.NSChangeDone); } catch (_) {}
            Q.ui.toast("press <kbd>⌘S</kbd> again and it will write");
          } },
      ],
    });
  }

  function installSaveHook() {
    if (st.hooked) return true;
    const F = window.File;
    if (!window.bridge || !window.bridge.registerHandler || !F || typeof F.sync !== "function") {
      return false;
    }
    const handler = function (t, e) {
      let content = "";
      try {
        if (F.validateContentForSave() === false) F.showDataLostError();
      } catch (err) { Q.warn("validateContentForSave", err); }
      try {
        content = F.sync(true, false, true, t);
      } catch (err) {
        Q.warn("sync", err);
        // whatever happens, native gets an answer. a save that hangs waiting for
        // javascript is worse than a save that writes the wrong thing.
        try { content = window.getMarkdown(); } catch (_) { content = ""; }
      }
      let out = content;
      try {
        const sub = substitute(content);
        if (sub !== null && sub !== undefined) out = sub;
      } catch (err) { Q.warn("guard", err); out = content; }
      st.lastServed = out;
      e(out);
    };
    window.bridge.registerHandler("File.getContent", handler);
    Q.guard._handler = handler;      // the selftest calls it directly
    st.hooked = true;
    return true;
  }

  // ---- commands -------------------------------------------------------------

  Q.command({
    id: "reloadDisk", title: "Reload this file from disk", category: "File",
    run: () => {
      const path = Q.doc.path();
      if (!path) return Q.ui.toast("no file open");
      return readFile(path).then((text) =>
        stat(path).then((s) => {
          if (text == null || !s) return Q.ui.error("could not read " + path);
          if (text === expected() && !dirty()) return Q.ui.toast("already the same");
          st.conflict = { text: text, mtime: s.mtime, size: s.size };
          takeTheirs();
        }));
    },
  });

  Q.command({
    id: "saveDiff", title: "Show what saving would rewrite", category: "File",
    run: () => {
      const path = Q.doc.path();
      if (!path) return Q.ui.toast("no file open");
      const exp = expected();
      if (exp == null) return Q.ui.error("the editor has not parsed this document yet");
      if (exp.length > MAX_GUARD_BYTES) {
        return Q.ui.toast("too big to check · " + exp.length.toLocaleString() + " bytes");
      }
      return diffAgainst(path, exp, "on disk", "after a save").then((diff) => {
        if (!diff) return Q.ui.toast("a save writes exactly what is on disk plus your edits");
        showDiff("What a save writes", diff);
      });
    },
  });

  Q.command({
    id: "saveGuard", title: "Toggle the save guard", category: "File",
    run: () => {
      const off = Q.prefs().saveGuard === "off";
      Q.setPref("saveGuard", off ? "block" : "off");
      Q.ui.toast("save guard " + (off ? "on · a rewrite is held until you say so"
                                     : "off · saves go straight through"));
    },
  });

  // ---- go -------------------------------------------------------------------

  // the edit watcher. one listener, one debounce, and the serialisation it takes
  // is the same one the status bar already asks for every second and a half, so
  // this is not new work, it is the same work with the result kept.
  const tickEdit = Q.debounce(() => noteEdit(null), TICK_MS);

  function wireEdits() {
    const write = document.getElementById("write");
    if (!write) return setTimeout(wireEdits, 200);
    write.addEventListener("input", tickEdit, true);
    // a paste and an undo are allowed to move a page at once. so is every one of
    // the twenty text transforms, which is why they say so before they run.
    write.addEventListener("paste", () => Q.guard.deliberate(), true);
    document.addEventListener("keydown", (e) => {
      if (e.metaKey && (e.key === "z" || e.key === "Z" || e.key === "v" || e.key === "V")) {
        Q.guard.deliberate();
      }
    }, true);
  }

  // the host's own external-change handler ends in a confirm():
  //
  //   File.isDocumentEdited() && !confirm("File content is changed by external
  //   applications. Reload content from disk ?") ||
  //     bridge.callHandler("document.refreshContentFromDisk")
  //
  // that is a modal, raised over the document, by the web view, whenever an
  // agent writes a file you have unsaved edits in. a modal in this app blocks
  // the app, and everything talking to the app blocks with it. it is also the
  // wrong question: it offers reload or nothing, with no way to see what
  // changed and no way to keep both.
  //
  // there is exactly one confirm() in the entire host bundle and this is it. so
  // it is answered "keep what is in the buffer" without ever being drawn, and
  // the bar takes it from there.
  function silenceHostConfirm() {
    if (window.__quireConfirm) return;
    window.__quireConfirm = window.confirm;
    window.confirm = function (msg) {
      Q.log("host confirm suppressed:", String(msg || "").slice(0, 60));
      return false;
    };
  }

  function start() {
    if (!window.File || !window.File.editor) return setTimeout(start, 120);
    if (!installSaveHook()) setTimeout(start, 200);
    wireEdits();
    Q.checkShell().then((ok) => {
      if (!ok) return;
      Q.on("doc", (p) => { if (p) { st.busy = true; snapshot(p).then(() => { st.busy = false; }); } });
      const p = Q.doc.path();
      if (p) { st.busy = true; snapshot(p).then(() => { st.busy = false; }); }
      setInterval(tick, POLL_MS);
      // the window being in the background is exactly when a file gets rewritten
      // under it, and it is also when the web view stops running timers on time.
      // so the moment it comes back, look before anything else can happen.
      window.addEventListener("focus", () => setTimeout(tick, 0));
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) setTimeout(tick, 0);
      });
    });
  }

  // before anything else waits on anything. the presenter can fire the moment
  // the window opens, and a modal that gets drawn once is already too late.
  silenceHostConfirm();

  Q.guard.ack = function () { st.ack = true; status(); };
  Q.guard.snapshot = snapshot;
  Q.guard.tick = tick;
  Q.guard.readFile = readFile;
  Q.guard.stat = stat;
  Q.guard.diffAgainst = diffAgainst;
  Q.guard.changedLines = changedLines;

  start();
})(window.Q);
