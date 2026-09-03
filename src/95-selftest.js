"use strict";
// quire / self test
//
// off unless the marker file exists:
//
//   touch ~/.quire-selftest
//
// gated on a file rather than a preference because the host only reloads
// preference keys it already knows about at startup, putSetting will happily
// write a new key to the plist, but File.option never reads it back.
//
// it exists because there is no way to drive this app from outside. it is a
// window with no scripting interface, and stealing focus to press keys at it
// wrecks whatever the person at the keyboard was doing. so the app checks
// itself and writes the result where `defaults read` can pick it up.

(function (Q) {
  const results = {};
  const fails = [];

  function record(name, ok, detail) {
    results[name] = (ok ? "ok" : "FAIL") + (detail ? " · " + detail : "");
    if (!ok) fails.push(name + (detail ? ": " + detail : ""));
    Q.set("quireSelfTestResult", JSON.stringify(
      Object.assign({ stage: name, fails: fails.length }, results)).slice(0, 4000));
  }

  const check = (name, fn) => Promise.resolve()
    .then(fn)
    .then((r) => record(name, r && r.ok !== false, r && r.detail))
    .catch((e) => record(name, false, String(e && e.message || e)));

  const later = (ms) => new Promise((r) => setTimeout(r, ms));

  // a run still in flight makes exec return before it asks anything, so a stage
  // that needs the confirm has to wait for the previous one to let go. without
  // this, "no dialog appeared" and "a command was already running" look the same.
  function idleRunner(tries) {
    const n = tries == null ? 40 : tries;
    if (n <= 0) return Promise.resolve();
    let b = false;
    try { b = Q.runner && Q.runner.busy && Q.runner.busy(); } catch (_) {}
    if (!b) return Promise.resolve();
    return later(100).then(() => idleRunner(n - 1));
  }

  // a real file on disk that is definitely not markdown: our own source, which
  // sits next to index.html inside the bundle.
  function quireFile(name) {
    let href = location.href;
    try { href = decodeURI(href); } catch (_) {}
    const i = href.indexOf("/TypeMark/");
    if (i === -1) return "";
    return href.slice(0, i).replace(/^file:\/\//, "") + "/TypeMark/quire/" + name;
  }

  // a scratch directory to make files in. never the repo, never the vault: a
  // test that writes where you work is a test that eventually deletes something.
  let TMP = "";
  const t = (name) => TMP + "/quire-st-" + name;

  // the destructive stage is behind a second marker file. it makes the open
  // document dirty on purpose to watch what the writer does with it, and that is
  // not something to do to somebody's document because a marker file from last
  // week is still lying around.
  let SAVE_PROBE = false;
  // and a third marker for the one probe that cannot clean up after itself: it
  // arms the buffer and stops, because the thing it is measuring only happens
  // when the app is asked to quit.
  let QUIT_PROBE = false;

  function boot() {
    if (!window.File || !window.File.editor || !Q.ui) return setTimeout(boot, 200);
    Q.checkShell()
      .then((ok) => (ok ? Q.shell('[ -f "$HOME/.quire-selftest" ] && echo yes') : { out: "" }))
      .then((r) => {
        if (r.out.trim() !== "yes") return;
        // `pwd -P`, not $TMPDIR. on macos $TMPDIR is /var/folders/... and /var
        // is a symlink to /private/var, so the shell says one path and
        // File.filePath says the other. the save probe compares them and
        // refused its own scratch document over exactly that.
        return Q.shell('cd "${TMPDIR:-/tmp}" && printf %s "$(pwd -P)"; ' +
                       '[ -f "$HOME/.quire-selftest-save" ] && printf "\\tSAVE"; ' +
                       '[ -f "$HOME/.quire-selftest-quitprobe" ] && printf "\\tQUIT"')
          .then((s) => {
            const parts = s.out.split("\t");
            TMP = (parts[0] || "/tmp").replace(/\/+$/, "");
            SAVE_PROBE = parts.indexOf("SAVE") !== -1;
            QUIT_PROBE = parts.indexOf("QUIT") !== -1;
            suite();
          });
      });
  }

  // poll a promise-returning predicate until it says yes or the clock runs out
  function waitFor(fn, ms, step) {
    const until = Date.now() + ms;
    const once = () => Promise.resolve().then(fn).then((ok) => {
      if (ok) return true;
      if (Date.now() > until) return false;
      return later(step || 400).then(once);
    });
    return once();
  }

  // does the native writer actually use the string the hook hands back?
  //
  // there is no way to press ⌘S from here and no javascript entry point to the
  // save: on macos it is an NSDocument and the menu item goes straight to
  // native. but the document autosaves in place, and updateChangeCount marks it
  // dirty without touching a single character of the buffer. so: mark it dirty,
  // make the hook return a sentinel, and watch the file.
  //
  // it only ever runs against a document under the scratch directory, and it
  // puts the file back byte for byte whether it passes or fails.
  function saveWriteProbe() {
    const path = Q.doc.path();
    if (!path) return { ok: false, detail: "no document open" };
    if (!TMP || path.indexOf(TMP + "/") !== 0) {
      return { ok: false, detail: "refusing: " + path + " is not under " + TMP };
    }
    const sentinel = "quire-save-probe-" + Date.now().toString(36) + "\n";
    let original = null, hit = false;
    const restore = () => {
      Q.guard._force = null;
      Q.guard.ack();
      return Q.shellIn(`cat > ${Q.sh(path)}`, original == null ? "" : original)
        .then(() => {
          try { window.File.reloadContent(original, { fromDiskChange: true }); } catch (_) {}
          try { window.File.updateChangeCount(window.File.ChangeType.NSChangeCleared); } catch (_) {}
        })
        .then(() => Q.guard.snapshot(path));
    };

    return Q.guard.readFile(path)
      .then((orig) => {
        original = orig;
        Q.guard._force = sentinel;
        // sync() pushes the buffer to the NSDocument, updateChangeCount marks it
        // edited. neither of those touches a character of what is on screen.
        try { window.File.sync(); } catch (_) {}
        try { window.File.updateChangeCount(window.File.ChangeType.NSChangeDone); } catch (_) {}
        return waitFor(() => Q.guard.readFile(path).then((txt) => txt === sentinel), 45000, 1000);
      })
      .then((got) => { hit = got; return restore(); }, (e) => restore().then(() => { throw e; }))
      .then(() => Q.guard.readFile(path))
      .then((back) => ({
        ok: hit && back === original,
        detail: (hit ? "the writer used the hook's string"
                     : "no write in 45s: autosave did not fire, interception unverified") +
                ", file " + (back === original ? "restored byte for byte" : "NOT RESTORED"),
      }));
  }

  // the whole point of the pass, end to end, on a real document.
  //
  // dirty the buffer without touching disk, then have a shell write the file the
  // way an agent would, then wait for the poller. what has to be true after
  // that: the buffer still holds the unsaved edit, the bar says conflict, and a
  // save at that moment hands native the bytes that landed rather than ours.
  //
  // it dirties the open document, so it is behind the same marker file as the
  // other destructive probe and refuses to run outside the scratch directory.
  function conflictProbe() {
    const path = Q.doc.path();
    if (!TMP || !path || path.indexOf(TMP + "/") !== 0) {
      return { ok: false, detail: "refusing: " + path + " is not under " + TMP };
    }
    const theirs = "their version, written by somebody else\n";
    const mine = "\n\nmy unsaved edit\n";
    let original = null;

    const restore = () => Q.shellIn(`cat > ${Q.sh(path)}`, original == null ? "" : original)
      .then(() => {
        Q.guard.state.conflict = null;
        try {
          window.File.reloadContent(original, { fromDiskChange: true });
          window.File.updateChangeCount(window.File.ChangeType.NSChangeCleared);
        } catch (_) {}
        Q.guard.hideBar();
      })
      .then(() => Q.guard.snapshot(path));

    return Q.guard.readFile(path)
      .then((orig) => {
        original = orig;
        try {
          window.File.reloadContent(orig + mine, {});
          window.File.updateChangeCount(window.File.ChangeType.NSChangeDone);
        } catch (e) { throw new Error("could not dirty the buffer: " + e.message); }
        return Q.shellIn(`cat > ${Q.sh(path)}`, theirs);
      })
      .then(() => waitFor(() => !!Q.guard.state.conflict, 14000, 600))
      .then((saw) => {
        const bar = document.querySelector("#q-guardbar.q-open");
        const kind = bar ? bar.dataset.kind : "(no bar)";
        const buf = Q.guard.expected() || "";
        const kept = buf.indexOf("my unsaved edit") !== -1;
        const held = Q.guard.why(buf);
        const ok = saw && kind === "conflict" && kept &&
                   !!held && held.kind === "conflict" && held.text === theirs;
        return restore().then(() => ({
          ok: ok,
          detail: (saw ? "poller caught it" : "poller MISSED it") +
                  ", bar " + kind +
                  ", buffer " + (kept ? "kept my edit" : "LOST my edit") +
                  ", a save would write " +
                  (held && held.text === theirs ? "their bytes, not mine" : "OURS"),
        }));
      }, (e) => restore().then(() => { throw e; }));
  }

  // the other half of the same question, for when autosave never fires.
  //
  // it arms three things and stops: the file's original bytes are copied to
  // <file>.orig, the buffer gets a marker that is not on disk, and the hook is
  // made to return a sentinel. then whoever is driving quits the app and reads
  // the file, and the answer is which of three things is in it:
  //
  //   the sentinel  the native writer uses what File.getContent hands back
  //   the marker    a write happened and went round the hook
  //   neither       quitting does not write at all
  //
  // it leaves the document dirty on purpose, which is why it is behind its own
  // marker file and refuses to run on anything outside the scratch directory.
  function saveArmProbe() {
    const path = Q.doc.path();
    if (!TMP || !path || path.indexOf(TMP + "/") !== 0) {
      return { ok: false, detail: "refusing: " + path + " is not under " + TMP };
    }
    const sentinel = "quire-save-probe-sentinel\n";
    return Q.guard.readFile(path).then((orig) => {
      const body = orig == null ? "" : orig;
      return Q.shellIn(`cat > ${Q.sh(path + ".orig")}`, body).then(() => {
        Q.guard.ack();
        Q.guard._force = sentinel;
        try {
          window.File.reloadContent(body + "\n<!-- quire probe marker -->\n", {});
          window.File.sync();
          window.File.updateChangeCount(window.File.ChangeType.NSChangeDone);
        } catch (e) { return { ok: false, detail: "could not dirty the buffer: " + e.message }; }
        return { ok: true, detail: "armed · buffer holds a marker, the hook returns a sentinel, " +
                                   "original saved beside it as .orig" };
      });
    });
  }

  // the flagship, against the open scratch document, and the important half is
  // the negative one.
  //
  // a shell block is put into a real document and the document is rendered. the
  // command in it creates a file. if anything anywhere in this app runs a fence
  // on load, on render, on focus or on a poll, that file appears without anybody
  // asking, and a markdown document turns into remote code execution. so the
  // marker is checked before the block is ever clicked, and it has to be absent.
  //
  // it only ever runs against a document under the scratch directory, and it
  // puts the buffer back the way it found it, clean, whether it passes or fails.
  function runBlockProbe() {
    const path = Q.doc.path();
    if (!TMP || !path || path.indexOf(TMP + "/") !== 0) {
      return { ok: false, detail: "refusing: " + path + " is not under " + TMP };
    }
    const tag = Date.now().toString(36);
    const marker = t("ran-" + tag);
    const cmd = "touch " + Q.sh(marker) + " && echo quire-ran-" + tag;
    let original = null;
    const notes = [];

    const restore = () => Q.shell("rm -f " + Q.sh(marker)).then(() => {
      try {
        window.File.reloadContent(original == null ? "" : original, { fromDiskChange: true });
        window.File.updateChangeCount(window.File.ChangeType.NSChangeCleared);
      } catch (_) {}
      return Q.guard.snapshot(path);
    });

    const exists = () => Q.shell("[ -e " + Q.sh(marker) + " ] && echo yes || echo no")
      .then((r) => r.out.trim() === "yes");

    return Q.guard.readFile(path)
      .then((orig) => {
        original = orig == null ? "" : orig;
        const doc = original.replace(/\s*$/, "") + "\n\n```bash\n" + cmd + "\n```\n";
        window.File.reloadContent(doc, {});
        // the block goes on the end of the document, and a button is only drawn
        // for a fence that is actually on screen. a longer scratch document put
        // the fence below the fold and the stage read "0 run buttons drawn".
        const c = document.querySelector("content");
        if (c) c.scrollTop = c.scrollHeight;
        // rendered, redrawn, scrolled, and asked to lay its buttons out. every
        // path that touches a fence gets a turn before the marker is checked.
        Q.runner.draw();
        return later(1200);
      })
      .then(() => { Q.runner.draw(); return later(1200); })
      .then(() => exists())
      .then((ranByItself) => {
        notes.push(ranByItself ? "IT RAN ON ITS OWN" : "did not run on its own after 2.4s of rendering");
        const btns = document.querySelectorAll("#q-run-layer .q-run-btn").length;
        notes.push(btns + " run button" + (btns === 1 ? "" : "s") + " drawn");
        const f = Q.runner.scan(Q.doc.markdown()).filter((x) => x.code === cmd)[0];
        if (!f) return { ok: false, detail: notes.concat("the block never reached the buffer").join(" · ") };
        // and now on purpose, which is the only way it is ever allowed to happen
        return Q.runner.exec(f, { noConfirm: true })
          .then(() => later(300))
          .then(() => exists())
          .then((ranOnPurpose) => {
            const md = Q.doc.markdown();
            const outs = Q.runner.scan(md).filter((x) => x.lang === Q.runner.OUT_LANG);
            const folded = outs.length === 1 && outs[0].code.indexOf("quire-ran-" + tag) !== -1;
            notes.push(ranOnPurpose ? "ran when asked" : "DID NOT run when asked");
            notes.push(folded ? "output folded in under the block" : "output NOT folded in");
            // a second run must replace the first result, not stack another one
            const f2 = Q.runner.scan(md).filter((x) => x.code === cmd)[0];
            return Q.runner.exec(f2, { noConfirm: true }).then(() => later(200)).then(() => {
              const again = Q.runner.scan(Q.doc.markdown())
                .filter((x) => x.lang === Q.runner.OUT_LANG);
              notes.push(again.length === 1 ? "a re-run replaced it, still one block"
                                            : again.length + " output blocks after a re-run");
              return {
                ok: !ranByItself && btns >= 1 && ranOnPurpose && folded && again.length === 1,
                detail: notes.join(" · "),
              };
            });
          });
      })
      .then((res) => restore().then(() => res), (e) => restore().then(() => { throw e; }));
  }

  // the frontmatter card, against the open scratch document.
  //
  // three things have to be true at once and the third is the one that would
  // otherwise rot silently: the yaml parses, the card holds a row per key, and
  // the raw <pre> is actually giving up its height to the card rather than the
  // card being drawn on top of eight visible lines of yaml.
  function frontmatterProbe() {
    const path = Q.doc.path();
    if (!TMP || !path || path.indexOf(TMP + "/") !== 0) {
      return { ok: false, detail: "refusing: " + path + " is not under " + TMP };
    }
    let original = null;
    const restore = () => {
      try {
        window.File.reloadContent(original == null ? "" : original, { fromDiskChange: true });
        window.File.updateChangeCount(window.File.ChangeType.NSChangeCleared);
      } catch (_) {}
      return Q.guard.snapshot(path);
    };
    // a colon inside a quoted window title is the case the writer quotes for,
    // so the reader has to survive it too
    const yaml = [
      "---",
      "kind: sticky",
      'session: "957a300b-a2d1-4643-9bc1-7e65192bb584"',
      'cwd: "/Users/x/Code/quire"',
      'window: "quire: pass 4"',
      'resolved: "newest"',
      'created: "' + new Date().toISOString() + '"',
      "---",
      "",
    ].join("\n");

    return Q.guard.readFile(path)
      .then((orig) => {
        original = orig == null ? "" : orig;
        window.File.reloadContent(yaml + original.replace(/^\s*/, ""), {});
        return later(500);
      })
      .then(() => {
        Q.frontmatter.draw();
        return later(300);
      })
      .then(() => {
        Q.frontmatter.draw();
        const pairs = Q.frontmatter.parse(
          'kind: sticky\nwindow: "quire: pass 4"\nnope\ncwd: "/tmp"');
        const title = pairs.filter((p) => p.key === "window")[0];
        const el = Q.frontmatter.blockEl();
        const card = document.querySelector("#q-fm-layer .q-fm-card");
        const rows = document.querySelectorAll("#q-fm-layer .q-fm-row").length;
        const on = document.body.classList.contains("q-fm-on");
        const cs = el ? getComputedStyle(el) : null;
        const cardH = card ? card.offsetHeight : 0;
        const blockH = el ? el.getBoundingClientRect().height : 0;
        // the raw block is transparent and exactly as tall as the card
        const hidden = !!cs && cs.color.replace(/\s/g, "").indexOf("rgba(0,0,0,0)") === 0;
        const shrunk = cardH > 0 && Math.abs(blockH - cardH) <= 2;
        return {
          ok: !!el && !!card && on && rows === 3 && hidden && shrunk &&
              pairs.length === 3 && !!title && title.value === "quire: pass 4",
          detail: pairs.length + " keys parsed off 4 lines, a quoted colon survived, " +
                  rows + " rows drawn (session, cwd, window), raw yaml " +
                  (hidden ? "transparent" : "STILL VISIBLE") + ", block " +
                  Math.round(blockH) + "px against a " + cardH + "px card",
        };
      })
      .then((res) => restore().then(() => res), (e) => restore().then(() => { throw e; }));
  }

  // the design system, asserted rather than admired.
  //
  // every interactive thing in the app is one of four shapes and every shape has
  // one height and one radius. that is easy to write down and easy to lose: the
  // first version of this chrome had five button paddings, three pill heights
  // and radii of 3, 4, 7, 8, 9, 10 and 12px, all of them arrived at one feature
  // at a time. so the controls are built off screen and measured.
  function controlsProbe() {
    const box = Q.el("div", { class: "q-probe-controls" });
    box.style.cssText = "position:fixed;left:-9999px;top:0;display:flex";
    box.innerHTML =
      '<button class="q-btn">a</button>' +
      '<button class="q-btn primary">b</button>' +
      '<span class="q-pill">c</span>' +
      '<span class="q-files-chip">d</span>' +
      '<span class="q-git-act">e</span>' +
      '<span class="q-sess-act">f</span>' +
      '<span class="q-view-act">g</span>' +
      '<span class="q-tag">h</span>' +
      '<button class="q-run-btn" style="position:static">i</button>' +
      '<span class="q-iconbtn">j</span>' +
      '<input class="q-input">';
    document.body.appendChild(box);
    const px = (el, prop) => parseFloat(getComputedStyle(el).getPropertyValue(prop)) || 0;
    const h = (sel) => Math.round(px(box.querySelector(sel), "height"));
    const r = (sel) => Math.round(px(box.querySelector(sel), "border-top-left-radius"));

    const pills = [".q-pill", ".q-files-chip", ".q-git-act", ".q-sess-act",
                   ".q-view-act", ".q-tag", ".q-run-btn"];
    const pillH = pills.map(h);
    const btnH = [h(".q-btn"), h(".q-btn.primary"), h(".q-input")];
    // the boxes are on the 6/10/14/18 scale; a pill is round by definition and
    // is checked for being at least as round as it is tall instead.
    const radii = [r(".q-btn"), r(".q-iconbtn"), r(".q-input")];
    const scale = [6, 10, 14, 18];
    const strays = radii.filter((v) => scale.indexOf(v) === -1);
    // webkit hands back the *used* radius here, not the computed one, so a
    // `border-radius: 999px` pill reads as half its own height rather than 999.
    // that took a failing stage whose own detail line said it had passed.
    const round = pills.every((s) => r(s) * 2 >= h(s) - 1);
    const oneHeight = (a) => a.every((v) => v === a[0]);
    box.remove();
    return {
      ok: oneHeight(pillH) && pillH[0] === 22 && oneHeight(btnH) && btnH[0] === 30 &&
          !strays.length && round,
      detail: pills.length + " pill shapes " +
              (oneHeight(pillH) ? "all " + pillH[0] + "px" : "AT " + pillH.join("/") + "px") +
              (round ? " and all fully round" : ", NOT all round: " + pills.map(r)) + ", " +
              btnH.length + " control shapes " +
              (oneHeight(btnH) ? "all " + btnH[0] + "px" : "AT " + btnH.join("/") + "px") + ", radii " +
              radii.join("/") + (strays.length ? " OFF SCALE: " + strays : " on the 6/10/14/18 scale"),
    };
  }

  function suite() {
    Promise.resolve()
      .then(() => check("shell", () =>
        Q.shell("expr 6 \\* 7").then((r) => ({ ok: r.out === "42", detail: r.out || r.err }))))

      .then(() => check("ripgrep", () =>
        Q.shell(`${Q.sh(Q.rg())} --version | head -1`)
          .then((r) => ({ ok: /ripgrep/.test(r.out), detail: r.out || r.err || Q.rg() }))))

      .then(() => check("vaultRoot", () => {
        const v = Q.vaultRoot();
        return { ok: !!v && v.charAt(0) === "/", detail: v || "(unresolved)" };
      }))

      .then(() => check("root", () => {
        const r = Q.doc.root();
        return { ok: !!r, detail: r };
      }))

      .then(() => check("files", () =>
        Q.files(true).then((f) => ({ ok: f.length > 0, detail: f.length + " files" }))))

      .then(() => check("notes", () =>
        Q.notes(true).then((n) => ({ ok: n.length > 0, detail: n.length + " markdown" }))))

      .then(() => check("backlinks", () =>
        Q.backlinks().then((b) => ({ ok: true, detail: b.length + " refs" }))))

      .then(() => check("tags", () =>
        Q.shell(`${Q.sh(Q.rg())} -o --no-filename --no-messages -g '*.md' ` +
                `${Q.sh("(^|\\s)#[A-Za-z][A-Za-z0-9_/-]*")} ${Q.sh(Q.doc.root())} | head -20`)
          .then((r) => ({ ok: true, detail: (r.out ? r.out.split("\n").length : 0) + " tags" }))))

      .then(() => check("terminal", () => {
        Q.ui.showPanel("terminal");
        return Q.term.run("pwd").then(() => ({
          ok: Q.term.state.lines.some((l) => l.kind === "out" && l.text.charAt(0) === "/"),
          detail: (Q.term.state.lines.slice(-1)[0] || {}).text,
        }));
      }))

      .then(() => later(400))
      .then(() => check("panels", () => {
        // every registered section, not a hardcoded list: a section that
        // forgets to render is exactly what this is here to catch
        const ids = Q.ui.sections();
        const missing = [];
        ids.forEach((id) => {
          Q.ui.showPanel(id, true);
          const body = document.querySelector("#q-panel .q-panel-body.q-active");
          if (!body || !body.innerHTML.trim()) missing.push(id);
        });
        return { ok: !missing.length && ids.length >= 5,
                 detail: missing.length ? "empty: " + missing : ids.length + " render" };
      }))

      // the sidebar is one column with a rail, and switching sections must not
      // throw a section's dom away, the terminal is the one where that shows.
      .then(() => check("sidebar", () => {
        const ids = Q.ui.sections();
        const marker = "echo quire-selftest-kept";
        Q.ui.showPanel("terminal");
        const input = document.querySelector(".q-term-input");
        if (!input) return { ok: false, detail: "no terminal input" };
        input.value = marker;
        Q.ui.cycleSection(1);
        const away = Q.ui.activePanel();
        Q.ui.showPanel("terminal");
        const back = document.querySelector(".q-term-input");
        const kept = !!back && back.value === marker;
        if (back) back.value = "";
        const rail = document.querySelectorAll("#q-panel .q-rail-btn").length;
        const head = (document.querySelector(".q-side-title") || {}).textContent || "";
        return {
          ok: rail === ids.length && kept && away !== "terminal" &&
              head.toLowerCase() === "terminal",
          detail: rail + " rail buttons / " + ids.length + " sections, title \u201c" + head +
                  "\u201d, terminal " + (kept ? "kept its input" : "LOST its input"),
        };
      }))

      .then(() => check("sidebarKeys", () => {
        const all = Q.keys.all();
        const want = {
          "mod+alt+\\": "quireSidebar", "mod+alt+]": "sidebarNext", "mod+alt+[": "sidebarPrev",
          "mod+alt+v": "git", "mod+alt+r": "viewFile", "mod+alt+e": "files",
          "mod+alt+j": "terminal", "mod+alt+b": "backlinks", "mod+alt+g": "tags",
        };
        const bad = Object.keys(want).filter((k) => all[k] !== want[k]);
        return { ok: !bad.length,
                 detail: bad.length ? "not bound: " + bad.join(" ") : Object.keys(want).length + " section keys" };
      }))

      // which destination a file gets. markdown to the editor, other text to
      // the read-only pane, everything else to the system.
      .then(() => check("filetypes", () => {
        const text = ["a.js", "b.json", "c.sh", "d.css", "e.yml", "f.toml", "g.txt",
                      "h.py", "i.rs", "Makefile", ".gitignore", ".zshrc", "x/y/config",
                      "deep/dir/settings.ini", "n.log", "s.svg"];
        const notText = ["a.md", "b.markdown", "c.png", "d.pdf", "e.zip", "f.mov", "g.woff2"];
        const bad = text.filter((p) => !Q.isTextPath(p))
          .concat(notText.filter((p) => Q.isTextPath(p)));
        return { ok: !bad.length,
                 detail: bad.length ? "misfiled: " + bad.join(" ")
                                    : (text.length + notText.length) + " paths classified" };
      }))

      // the byte-preservation proof. the pane holds the file as text; hand that
      // text back to the shell and hash it, and it has to come out as the hash
      // of the file on disk. read-only is the guarantee; this is the evidence
      // that what it shows is not a lossy version of what is there.
      .then(() => check("textview", () => {
        const self = quireFile("60-view.js");
        if (!self) return { ok: false, detail: "cannot locate the bundle" };
        return Q.view.open(self).then((d) => {
          if (!d) return { ok: false, detail: "did not open" };
          return Q.shell(`shasum -a 256 ${Q.sh(self)} | cut -d' ' -f1`).then((disk) =>
            Q.shellIn("shasum -a 256 | cut -d' ' -f1", d.text).then((pane) => {
              const rows = document.querySelectorAll("#q-view .q-view-row").length;
              const ro = !!document.querySelector("#q-view .q-view-ro");
              const same = !!disk.out && disk.out === pane.out;
              return {
                ok: same && ro && rows === d.lines && d.lines > 50,
                detail: d.lines + " lines, " + rows + " rendered, sha " +
                        (same ? "matches disk" : disk.out.slice(0, 12) + " vs " + pane.out.slice(0, 12)),
              };
            }));
        });
      }))

      // and the other half of the guarantee: nothing in the viewer writes.
      .then(() => check("viewReadOnly", () => {
        const self = quireFile("60-view.js");
        // comments stripped first: the file talks about the very calls it must
        // not contain, and a grep that matches its own warning proves nothing
        return Q.shell(
          `sed -e ${Q.sh("s://.*::")} ${Q.sh(self)} | ` +
          `grep -c -E ${Q.sh("File\\.sync|cat *>|tee |shellIn|writeFile|putFile")} || true`
        ).then((r) => {
          const n = parseInt(r.out, 10) || 0;
          Q.view.close();
          return { ok: n === 0 && !Q.view.isOpen(),
                   detail: n === 0 ? "no write path in 60-view.js" : n + " suspect line(s)" };
        });
      }))

      .then(() => later(600))
      .then(() => check("palette", () => {
        Q.run("palette");
        const input = document.querySelector(".q-pal-input");
        if (!input) return { ok: false, detail: "no input" };
        input.value = "table";
        input.dispatchEvent(new Event("input"));
        const rows = document.querySelectorAll(".q-pal-item").length;
        const detailPane = document.querySelector(".q-pal-detail");
        const open = !!document.querySelector("#q-palette.q-open");
        return {
          ok: open && rows > 0 && detailPane && detailPane.innerHTML.trim().length > 0,
          detail: rows + " rows",
        };
      }))

      .then(() => later(300))
      .then(() => check("whichkey", () => {
        Q.run("palette");                    // close it
        Q.whichKey.show();
        const rows = document.querySelectorAll(".q-wk-row").length;
        return { ok: rows > 0, detail: rows + " bindings" };
      }))

      .then(() => later(2500))
      .then(() => { Q.whichKey.hide(); })

      .then(() => check("commands", () => {
        const cmds = Q.commands();
        const bad = cmds.filter((c) => typeof c.run !== "function").map((c) => c.id);
        // two commands on one key is a silent bug: only one of them ever runs
        const all = Q.keys.all();
        const seen = {}, dupes = [];
        Object.keys(all).forEach((k) => {
          if (seen[all[k]]) dupes.push(all[k]);
          seen[all[k]] = k;
        });
        // and two commands on one *id* is worse than two on one key: the second
        // one replaces the first outright and the first is simply gone
        const clash = Q.commandCollisions ? Q.commandCollisions() : [];
        return {
          ok: !bad.length && !dupes.length && !clash.length,
          detail: cmds.length + " commands, " + Object.keys(all).length + " keys" +
                  (bad.length ? ", broken: " + bad : "") +
                  (dupes.length ? ", duplicate key: " + dupes : "") +
                  (clash.length ? ", duplicate id: " + clash : ""),
        };
      }))

      // ---- pass 4: the chrome -----------------------------------------------

      .then(() => check("controls", controlsProbe))

      .then(() => check("theme", () => {
        const b = document.body.classList;
        const font = getComputedStyle(document.documentElement).getPropertyValue("--q-font");
        return {
          ok: b.contains("q-theme") && b.contains("q-glass") && b.contains("q-font-on") && !!font.trim(),
          detail: [b.contains("q-theme") && "theme", b.contains("q-glass") && "glass",
                   b.contains("q-status-on") && "status"].filter(Boolean).join("+"),
        };
      }))

      .then(() => check("stats", () => {
        const s = Q.stats();
        return { ok: s.words > 0, detail: s.words + " words" };
      }))

      .then(() => check("git", () =>
        Q.git.status().then((g) => ({ ok: true, detail: g ? g.branch + " +" + g.dirty : "not a repo" }))))

      // ---- pass 2: the file guard ------------------------------------------
      //
      // reading a file and writing it back has to be byte exact or nothing
      // downstream means anything, so that is what gets proven first, with a
      // hash, against a file this stage made itself.
      .then(() => check("diskRead", () => {
        const f = t("read.md");
        const body = "# read back\n\n- one\n- two\n\ntrailing spaces here   \nand a tab\there\n";
        return Q.shellIn(`cat > ${Q.sh(f)}`, body)
          .then(() => Q.guard.readFile(f))
          .then((text) =>
            Q.shell(`shasum -a 256 ${Q.sh(f)} | cut -d' ' -f1`).then((disk) =>
              Q.shellIn("shasum -a 256 | cut -d' ' -f1", text == null ? "" : text).then((back) => ({
                ok: text === body && !!disk.out && disk.out === back.out,
                detail: (text === body ? "identical" : "DIFFERS") + ", sha " +
                        (disk.out === back.out ? "matches disk" : disk.out.slice(0, 12)),
              }))));
      }))

      // the watcher's whole job is noticing a file moved. mtime has one second
      // resolution on some filesystems, so size is checked too, which is what
      // catches an agent rewriting a file twice inside the same second.
      .then(() => check("diskWatch", () => {
        const f = t("watch.md");
        return Q.shellIn(`cat > ${Q.sh(f)}`, "one\n")
          .then(() => Q.guard.stat(f))
          .then((before) =>
            Q.shellIn(`cat > ${Q.sh(f)}`, "one\ntwo\n")
              .then(() => Q.guard.stat(f))
              .then((after) => ({
                ok: !!before && !!after &&
                    (after.mtime !== before.mtime || after.size !== before.size) &&
                    after.size === 8,
                detail: before && after
                  ? before.size + "b -> " + after.size + "b, mtime " +
                    (after.mtime === before.mtime ? "same second" : "moved")
                  : "no stat",
              })));
      }))

      // the save guard is a diff, so the diff is what gets tested: a file that
      // round trips has to come back clean, and one that does not has to come
      // back with the lines named.
      .then(() => check("saveDiff", () => {
        const same = t("same.md"), diff = t("diff.md");
        const body = "# title\n\nplain paragraph.\n";
        return Q.shellIn(`cat > ${Q.sh(same)}`, body)
          .then(() => Q.guard.diffAgainst(same, body, "disk", "save"))
          .then((d0) => {
            const clean = Q.guard.changedLines(d0);
            return Q.shellIn(`cat > ${Q.sh(diff)}`, "a\nb\nc\nd\n")
              .then(() => Q.guard.diffAgainst(diff, "a\nB\nc\nd\ne\n", "disk", "save"))
              .then((d1) => {
                const n = Q.guard.changedLines(d1);
                return {
                  ok: clean === 0 && n === 3 && /^@@ /m.test(d1),
                  detail: "identical -> " + clean + " changed, two edits and an added line -> " + n,
                };
              });
          });
      }))

      // and the model of what a save writes: getMarkdown plus the line ending
      // and the final newline the host tracks per document. if this is wrong
      // every file looks damaged and the warning becomes noise.
      .then(() => check("saveModel", () => {
        const exp = Q.guard.expected();
        const st = Q.guard.state;
        if (exp == null) return { ok: false, detail: "expected() gave nothing" };
        const p = st.phantom;
        return {
          ok: typeof exp === "string" && !!st.path && !!p,
          detail: st.path
            ? Q.doc.name() + ": " + exp.length + " bytes out, " +
              (p ? (p.big ? "too big to check"
                          : p.count + " line(s) rewritten by the writer alone" +
                            (p.lines.length ? " at " + p.lines.join(",") : "")) : "unmeasured")
            : "no document open",
        };
      }))

      // the hook itself. this is the handler native calls to ask for the bytes
      // it is about to write, so what it hands back is the file. it must always
      // hand back a string, synchronously, and it must hand back the file's own
      // bytes when it is holding a save.
      .then(() => check("saveHook", () => {
        const h = Q.guard._handler;
        if (typeof h !== "function") return { ok: false, detail: "not installed" };
        let got = null, calls = 0;
        h(false, (v) => { calls++; got = v; });
        const passthrough = got;
        const sentinel = "quire-selftest-sentinel\n";
        Q.guard._force = sentinel;
        h(false, (v) => { calls++; got = v; });
        Q.guard._force = null;
        return {
          ok: calls === 2 && typeof passthrough === "string" &&
              passthrough === Q.guard.expected() && got === sentinel,
          detail: calls + " synchronous answers, pass-through " +
                  (passthrough === Q.guard.expected() ? "matches the buffer" : "DIFFERS") +
                  ", substitution " + (got === sentinel ? "honoured" : "IGNORED"),
        };
      }))

      // the host has exactly one confirm() and it is its external-change
      // handler, which raises a modal over the document whenever an agent
      // rewrites a file you have unsaved edits in. a modal in this app blocks
      // the app and everything talking to it, so it must not exist.
      .then(() => check("noHostModal", () => {
        const swapped = window.confirm !== window.__quireConfirm;
        const answer = window.confirm("File content is changed by external applications.");
        return {
          ok: swapped && answer === false && typeof window.__quireConfirm === "function",
          detail: swapped ? "host confirm answered “keep the buffer” without drawing"
                          : "NOT suppressed",
        };
      }))

      // the hull of a change. this is what "outside the part you edited" is
      // measured with, so it gets its own stage with hand-made inputs rather
      // than being inferred from whatever document happens to be open.
      .then(() => check("editSpan", () => {
        const sp = Q.guard.span;
        const cases = [
          ["same", sp("a\nb\nc\n", "a\nb\nc\n"), null],
          ["one line", sp("a\nb\nc\nd\n", "a\nB\nc\nd\n"), { from: 1, to: 1, delta: 0 }],
          ["insert two", sp("a\nb\n", "a\nX\nY\nb\n"), { from: 1, to: 2, delta: 2 }],
          ["delete one", sp("a\nb\nc\n", "a\nc\n"), { from: 1, to: 1, delta: -1 }],
          ["last line", sp("a\nb\nc\n", "a\nb\nC\n"), { from: 2, to: 2, delta: 0 }],
        ];
        const bad = cases.filter(([, got, want]) => {
          if (want === null) return got !== null;
          return !got || got.from !== want.from || got.to !== want.to || got.delta !== want.delta;
        }).map(([n]) => n);
        return { ok: !bad.length,
                 detail: bad.length ? "wrong: " + bad.join(", ") : cases.length + " spans" };
      }))

      // and the decision itself. a clean save has to be silent, a normal edit
      // has to be silent, a page moving in one tick has to be held, and a file
      // that changed on disk has to be held with its own bytes handed back.
      .then(() => check("guardHold", () => {
        const path = Q.doc.path();
        const st = Q.guard.state;
        if (!path || !st.disk || typeof st.disk.text !== "string") {
          return { ok: false, detail: "no snapshot for " + path };
        }
        const base = st.disk.text;
        const L = base.split("\n");
        if (L.length < 24) return { ok: false, detail: "document too short to test on" };
        const at = (i, v) => { const c = L.slice(); c[i] = v; return c.join("\n"); };

        const clean = Q.guard.why(base);
        const narrow = Q.guard.why(at(6, L[6] + " x"));
        const bigLines = L.slice();
        for (let i = 4; i < 20; i++) bigLines[i] = "rewritten " + i;
        const big = Q.guard.why(bigLines.join("\n"));

        st.conflict = { text: "theirs\n", mtime: 1, size: 7 };
        const clash = Q.guard.why(base);
        st.conflict = null;

        const ok = clean === null && narrow === null &&
                   !!big && big.kind === "wide" && big.text === base &&
                   !!clash && clash.kind === "conflict" && clash.text === "theirs\n";
        return { ok: ok, detail: "clean " + (clean === null ? "silent" : clean.kind) +
                 ", one line " + (narrow === null ? "silent" : narrow.kind) +
                 ", sixteen lines " + (big ? big.kind : "silent") +
                 ", disk moved " + (clash ? clash.kind : "silent") };
      }))
      // put the state back: the stage above widened the hull and armed `wide`
      .then(() => Q.guard.snapshot(Q.doc.path()))

      // stickies. the file, the frontmatter and both pointers, in a scratch
      // directory so a test run never leaves a note in the real one.
      .then(() => check("sticky", () => {
        const dir = t("stickies");
        const real = Q.sticky.dirNow();
        Q.sticky._useDir(dir);
        return Q.sticky.create({ session: { id: "0000-test", cwd: "/tmp", window: "w: x", how: "test" },
                                 body: "note body" })
          .then((r) =>
            Q.shell(
              `cat ${Q.sh(r.path)}; echo "--"; readlink ${Q.sh(dir + "/latest.md")}; ` +
              `echo "--"; readlink ${Q.sh(dir + "/by-session/0000-test.md")}`
            ).then((s) => {
              Q.sticky._useDir(real);
              const parts = s.out.split("\n--\n");
              const head = parts[0] || "";
              const ok =
                /^---\n/.test(head) &&
                /\nkind: sticky\n/.test(head) &&
                head.indexOf('window: "w: x"') !== -1 &&      // the colon survived quoting
                head.indexOf('session: "0000-test"') !== -1 &&
                head.indexOf("note body") !== -1 &&
                (parts[1] || "").trim() === r.path &&
                (parts[2] || "").trim() === r.path &&
                Q.sticky.isSticky(r.path) === false;           // dir is back to the real one
              return { ok: ok, detail: r.path.split("/").pop() + ", latest + by-session both point at it" };
            }), (e) => { Q.sticky._useDir(real); throw e; });
      }))

      // the session resolver, run the way the app runs it: the copy inside the
      // bundle, through the same shell everything else uses.
      .then(() => check("qsession", () => {
        const bin = quireFile("../qsession/qsession.sh");
        return Q.shell(`${Q.sh(bin)} --newest 2>&1 | head -1`).then((r) =>
          Q.shell(`${Q.sh(bin)} --list 2>/dev/null | wc -l`).then((l) => {
            const f = (r.out || "").split("\t");
            const uuid = /^[0-9a-f-]{20,}$/i.test(f[0] || "");
            const wins = parseInt(l.out, 10) || 0;
            return {
              ok: uuid && (f[3] || "").trim() === "newest",
              // the window count is the interesting number, not a pass or a
              // fail: zero means the app has no Screen Recording permission and
              // every title comes back nil, which is why newest-writer exists.
              detail: (uuid ? f[0].slice(0, 8) + " · " + (f[1] || "no cwd") : "no session: " + r.out) +
                      " · " + wins + " terminal window(s) visible to the app",
            };
          }));
      }))

      // grabbing the last command. run something real, then check the block it
      // would insert, fence length included: output with backticks in it needs a
      // longer fence or the block ends inside itself.
      .then(() => check("grab", () => {
        Q.ui.showPanel("terminal");
        return Q.term.run("printf 'a\\n```\\nb\\n'").then(() => {
          const r = Q.grab.lastRun();
          if (!r) return { ok: false, detail: "nothing to grab" };
          const b = Q.grab.block(r.cmd, r.out);
          const lines = b.split("\n");
          // the output has a bare ``` in it, so a naive count of fence-shaped
          // lines finds three. the two that matter are the first and the last.
          const first = lines[2], last = lines[lines.length - 2];
          // a command with backticks in it cannot be inline code as it stands:
          // the caption escapes them, which is why this compares against the
          // escaped form rather than against the command
          const caption = "`" + r.cmd.replace(/`/g, "’") + "`";
          return {
            ok: lines[0] === caption && first === "````" && last === "````" &&
                b.indexOf("\na\n```\nb\n") !== -1,
            detail: "caption escaped, " + first.length + "-backtick fence around " +
                    (r.out ? r.out.split("\n").length : 0) + " lines that contain a fence",
          };
        });
      }))

      // ---- pass 3: runnable code blocks -------------------------------------
      //
      // the scanner first, on markdown written to break it. everything else in
      // this feature is built on knowing exactly which bytes are a fence, and
      // an off-by-one here writes a command's output under somebody else's
      // block.
      .then(() => check("runScan", () => {
        const md = [
          "# title", "", "```bash", "echo hi", "```", "", "text", "",
          "~~~sh", "ls", "~~~", "", "```", "no lang", "```", "",
          "````markdown", "```bash", "not a real one", "```", "````", "",
          "    four spaces is not a fence", "",
        ].join("\n");
        const f = Q.runner.scan(md);
        const langs = f.map((x) => x.lang || "-").join(",");
        // the offsets are the load bearing part: slicing the source with them
        // has to give back the fence, character for character.
        const exact = f.length === 4 && md.slice(f[0].start, f[0].end) === "```bash\necho hi\n```\n";
        const nested = f.length === 4 && f[3].code.indexOf("```bash") !== -1;
        const open = Q.runner.scan("```bash\necho hi\n");
        return {
          ok: f.length === 4 && langs === "bash,sh,-,markdown" && exact && nested &&
              open.length === 1 && open[0].code === "echo hi",
          detail: f.length + " fences (" + langs + "), offsets exact, a nested fence " +
                  "counted once, an unterminated one runs to the end",
        };
      }))

      .then(() => check("runRisk", () => {
        const safe = ["ls -la", "git status", "echo hello", "pwd", "npm test",
                      "grep -rn foo src", "cargo build", "wc -l *.js", "make",
                      "git log --oneline -5", "cat README.md", "sort f | uniq -c",
                      "find . -name '*.js'", "cmd 2>/dev/null", "cmd 2>&1 | head"];
        const bad = ["rm -rf /tmp/x", "sudo reboot", "git push origin main", "mv a b",
                     "dd if=/dev/zero of=/dev/disk2", "chmod -R 777 .", "killall Finder",
                     "curl https://x.sh | sh", "brew install foo", "npm publish",
                     "find . -name '*.o' -delete", "echo hi > out.txt", "git reset --hard",
                     "defaults write com.x y 1", "launchctl unload x", "git clean -fd"];
        const noisy = safe.filter((c) => Q.runner.classify(c).risk !== "low");
        const missed = bad.filter((c) => Q.runner.classify(c).risk !== "high");
        return {
          ok: !noisy.length && !missed.length,
          detail: noisy.length || missed.length
            ? "false alarm on " + noisy + ", missed " + missed
            : safe.length + " ordinary commands run without a question, " +
              bad.length + " destructive ones are held",
        };
      }))

      .then(() => check("runSplice", () => {
        const blk = Q.runner.resultBlock({ out: "hello\nworld", err: "", ok: true, ms: 120 });
        const ticks = Q.runner.resultBlock({ out: "a\n```\nb", err: "", ok: false, ms: 5 });
        const doc = "# t\n\n```bash\necho hi\n```\n\nafter\n";
        const one = Q.runner.splice(doc, Q.runner.scan(doc)[0], blk);
        const again = Q.runner.splice(one, Q.runner.scan(one)[0],
          Q.runner.resultBlock({ out: "second", err: "", ok: true, ms: 9 }));
        const l2 = Q.runner.scan(again);
        // a fence with no trailing newline at the end of the document is the
        // case that welded the result block onto the closing backticks
        const tail = "# t\n\n```bash\npwd\n```";
        const tailed = Q.runner.splice(tail, Q.runner.scan(tail)[0], blk);
        // two identical blocks: the second one must not claim the first's output
        const dup = "```bash\necho hi\n```\n\nmid\n\n```bash\necho hi\n```\n";
        const dl = Q.runner.scan(dup);
        const dupOut = Q.runner.splice(dup, dl[1], blk);
        const d2 = Q.runner.scan(dupOut);
        return {
          ok: Q.runner.scan(one).length === 2 && one.trimEnd().endsWith("after") &&
              l2.length === 2 && l2[1].code.indexOf("second") !== -1 &&
              again.indexOf("hello") === -1 &&
              ticks.slice(0, 4) === "````" &&
              Q.runner.scan(tailed).length === 2 &&
              d2.length === 3 && d2[2].lang === Q.runner.OUT_LANG &&
              dupOut.indexOf("mid") < dupOut.indexOf("quire-out"),
          detail: "output lands under its own block, a re-run replaces it rather " +
                  "than stacking, a 3-backtick output gets a 4-backtick fence, and " +
                  "of two identical blocks the right one gets the result",
        };
      }))

      // the confirm actually appears, and cancelling actually cancels. this is
      // the whole safety story for a feature that runs shell commands out of a
      // file somebody else wrote, so it is proven rather than asserted.
      .then(() => idleRunner())
      .then(() => check("runAsk", () => {
        const f = { index: 0, lang: "bash", code: "rm -rf /tmp/quire-nope", start: 0, end: 0 };
        const p = Q.runner.exec(f);
        return later(120).then(() => {
          const open = Q.ui.isModalOpen();
          const sheet = document.querySelector("#q-modal .q-sheet-title");
          const title = sheet ? sheet.textContent : "";
          const btns = Array.prototype.slice.call(
            document.querySelectorAll("#q-modal .q-sheet-foot .q-btn"));
          const cancel = btns.filter((b) => /cancel/i.test(b.textContent))[0];
          if (cancel) cancel.click();
          return p.then((res) => ({
            ok: open && /destroy/i.test(title) && !!cancel && res === null,
            detail: open ? "asked (“" + title + "”), cancel returned nothing and ran nothing"
                         : "NO dialog for rm -rf",
          }));
        });
      }))

      // the flagship, end to end, and the half that matters most is the half
      // that proves nothing happened: a document with a shell block in it is
      // loaded, redrawn, and left alone, and the command in it must not have
      // run. only then is it run on purpose.
      .then(() => (TMP && Q.doc.path() && Q.doc.path().indexOf(TMP + "/") === 0
        ? check("runBlock", runBlockProbe)
        : check("runBlock", () => ({
            ok: true,
            detail: "skipped · needs a scratch document under " + (TMP || "$TMPDIR"),
          }))))

      // the frontmatter card, drawn over a real block in a real document
      .then(() => (TMP && Q.doc.path() && Q.doc.path().indexOf(TMP + "/") === 0
        ? check("frontmatter", frontmatterProbe)
        : check("frontmatter", () => ({
            ok: true,
            detail: "skipped · needs a scratch document under " + (TMP || "$TMPDIR"),
          }))))

      // ---- pass 3: the session viewer ---------------------------------------
      //
      // the record shapes the ported renderer has to survive, in one synthetic
      // transcript: content as a string and content as a list of typed blocks,
      // a tool_result whose content is itself a list of dicts, every junk record
      // type, and an ai-title that turns up at the very end of the file.
      .then(() => check("transcript", () => {
        const f = t("t.jsonl");
        const out = t("t.md");
        const recs = [
          { type: "user", timestamp: "2026-09-03T06:00:00Z",
            message: { content: "content as a plain string" } },
          { type: "assistant", timestamp: "2026-09-03T06:00:01Z",
            message: { model: "test-model", content: [
              { type: "thinking", thinking: "thought in a details block" },
              { type: "text", text: "content as a list of blocks" },
              { type: "tool_use", name: "Bash", input: { command: "echo probe" } }] } },
          { type: "user", timestamp: "2026-09-03T06:00:02Z",
            message: { content: [
              { type: "tool_result", is_error: false,
                content: [{ type: "text", text: "result nested as a list of dicts" }] }] } },
          { type: "file-history-snapshot", junk: "skipme-fhs" },
          { type: "bridge-session", junk: "skipme-bridge" },
          { type: "atis-latch", junk: "skipme-atis" },
          { type: "cost-state", junk: "skipme-cost" },
          { type: "last-prompt", junk: "skipme-lastprompt" },
          { type: "mode", junk: "skipme-mode" },
          { type: "permission-mode", junk: "skipme-permission" },
          // late on purpose: the title record can appear anywhere in the file
          { type: "ai-title", aiTitle: "the real session name" },
        ];
        const jsonl = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
        return Q.shellIn(`cat > ${Q.sh(f)}`, jsonl)
          .then(() => Q.sessions.python())
          .then((py) => Q.shell(
            `${Q.sh(py)} ${Q.sh(Q.sessions.script())} ${Q.sh(f)} > ${Q.sh(out)} 2>&1; ` +
            `wc -c < ${Q.sh(out)}; cat ${Q.sh(out)}`))
          .then((r) => {
            const body = r.out;
            const junk = ["skipme-fhs", "skipme-bridge", "skipme-atis", "skipme-cost",
                          "skipme-lastprompt", "skipme-mode", "skipme-permission"]
              .filter((k) => body.indexOf(k) !== -1);
            const want = {
              "the title came off the ai-title record": body.indexOf("# the real session name") !== -1,
              "a string content rendered": body.indexOf("content as a plain string") !== -1,
              "a list content rendered": body.indexOf("content as a list of blocks") !== -1,
              "thinking folded into details":
                /<details><summary>thinking<\/summary>[\s\S]*thought in a details block/.test(body),
              "a tool call became a line": body.indexOf("**→ Bash**") !== -1,
              "a nested tool_result unwrapped": body.indexOf("result nested as a list of dicts") !== -1,
              "3 records counted, the junk uncounted": body.indexOf("3 records") !== -1,
            };
            const miss = Object.keys(want).filter((k) => !want[k]);
            return {
              ok: !miss.length && !junk.length,
              detail: miss.length || junk.length
                ? "missing: " + miss.join("; ") + (junk.length ? " · junk leaked: " + junk : "")
                : "7 record shapes handled, 7 junk types dropped, ai-title read from the last line",
            };
          });
      }))

      // and the same renderer against a real transcript, for the numbers
      .then(() => check("transcriptReal", () => {
        const was = Q.prefs().transcriptDir;
        Q.setPref("transcriptDir", TMP || "/tmp");
        const t0 = Date.now();
        return Q.sessions.list(6)
          .then((rows) => {
            if (!rows.length) {
              Q.setPref("transcriptDir", was);
              return { ok: true, detail: "no transcripts under ~/.claude/projects on this machine" };
            }
            const main = rows.filter((x) => !x.sub)[0] || rows[0];
            return Q.sessions.render(main).then((res) => {
              Q.setPref("transcriptDir", was);
              if (!res.ok) return { ok: false, detail: "render failed: " + (res.detail || "?") };
              return Q.shell(`head -1 ${Q.sh(res.path)}; grep -c '' ${Q.sh(res.path)}`)
                .then((r) => {
                  const bits = r.out.split("\n");
                  const head = bits[0] || "";
                  const lines = parseInt(bits[bits.length - 1], 10) || 0;
                  return {
                    ok: head.charAt(0) === "#" && res.size > 0 && lines > 1,
                    detail: rows.length + " listed, " + Math.round(main.size / 1024) + " KB in → " +
                      Math.round(res.size / 1024) + " KB of markdown, " + lines + " lines, " +
                      (Date.now() - t0) + "ms" + (res.paged ? ", paged" : "") +
                      ", " + rows.filter((x) => x.sub).length + " of them subagent transcripts",
                  };
                });
            });
          })
          .catch((e) => { Q.setPref("transcriptDir", was); throw e; });
      }))

      // ---- pass 3: doc staleness --------------------------------------------
      //
      // against a repo this stage builds itself, so the answer is known before
      // the code is asked: one doc, then two commits of code after it, and a
      // second doc left uncommitted.
      .then(() => check("stale", () => {
        if (!TMP) return { ok: false, detail: "no scratch directory" };
        const repo = t("repo");
        const git = "git -C " + Q.sh(repo) + " -c user.email=q@q -c user.name=q " +
                    "-c commit.gpgsign=false -c init.defaultBranch=main ";
        // the dates are pinned. three commits made back to back land in the same
        // second, and "how many commits of code since the doc" would come out
        // zero against a repo built specifically to make it two.
        const at = (n) => "GIT_AUTHOR_DATE=@" + n + " GIT_COMMITTER_DATE=@" + n + " ";
        const script = [
          "rm -rf " + Q.sh(repo), "mkdir -p " + Q.sh(repo) + "/src",
          "git init -q " + Q.sh(repo),
          "printf 'doc\\n' > " + Q.sh(repo) + "/README.md",
          "printf 'a\\n' > " + Q.sh(repo) + "/src/a.js",
          git + "add -A", at(1700000000) + git + "commit -qm one",
          "printf 'b\\n' >> " + Q.sh(repo) + "/src/a.js",
          git + "add -A", at(1700086400) + git + "commit -qm two",
          "printf 'c\\n' >> " + Q.sh(repo) + "/src/a.js",
          git + "add -A", at(1700172800) + git + "commit -qm three",
          "printf 'new\\n' > " + Q.sh(repo) + "/NOTES.md",
        ].join(" && ");
        return Q.shell(script, TMP).then((r) => {
          if (!r.ok) return { ok: false, detail: "could not build the repo: " + (r.err || r.out) };
          return Q.docs.report(repo).then((rep) => {
            if (!rep.ok) return { ok: false, detail: rep.why };
            const readme = rep.stale.filter((x) => x.path === "README.md")[0];
            const notes = rep.recent.filter((x) => x.path === "NOTES.md")[0];
            // three commits, the doc was in the first, so two of code came after
            return {
              ok: !!readme && readme.behind === 2 && !!notes && !!notes.isNew &&
                  rep.commits === 3,
              detail: readme
                ? "README.md " + readme.behind + " commits behind (built it to be 2), " +
                  "newest code " + readme.sample + ", uncommitted NOTES.md " +
                  (notes ? "listed" : "MISSED") + ", " + rep.commits + " commits read"
                : "README.md not flagged at all",
            };
          });
        });
      }))

      // the one stage that makes the open document dirty. off unless
      // ~/.quire-selftest-save exists, because it is the only way to find out
      // whether the native writer actually uses what the hook hands it, and
      // finding out means letting it write.
      .then(() => (SAVE_PROBE && !QUIT_PROBE ? check("conflict", conflictProbe)
                              : check("conflict", () => ({
                                  ok: true,
                                  detail: "skipped · touch ~/.quire-selftest-save to run it",
                                }))))

      .then(() => (QUIT_PROBE ? check("saveWrite", saveArmProbe)
                 : SAVE_PROBE ? check("saveWrite", saveWriteProbe)
                              : check("saveWrite", () => ({
                                  ok: true,
                                  detail: "skipped · touch ~/.quire-selftest-save to run it",
                                }))))

      // the scratch files this suite made, and only those: the prefix is quoted
      // and the glob is outside the quotes, so an empty TMP cannot turn into /*
      .then(() => (TMP ? Q.shell(`rm -rf ${Q.sh(t(""))}*`).catch(() => {}) : null))

      .then(() => {
        Q.ui.hidePanel();
        record("done", !fails.length, fails.length ? fails.length + " failed" : "all passed");
      })
      .catch((e) => record("done", false, String(e)));
  }

  boot();
})(window.Q);
