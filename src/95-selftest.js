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

  // a real file on disk that is definitely not markdown: our own source, which
  // sits next to index.html inside the bundle.
  function quireFile(name) {
    let href = location.href;
    try { href = decodeURI(href); } catch (_) {}
    const i = href.indexOf("/TypeMark/");
    if (i === -1) return "";
    return href.slice(0, i).replace(/^file:\/\//, "") + "/TypeMark/quire/" + name;
  }

  function boot() {
    if (!window.File || !window.File.editor || !Q.ui) return setTimeout(boot, 200);
    Q.checkShell()
      .then((ok) => (ok ? Q.shell('[ -f "$HOME/.quire-selftest" ] && echo yes') : { out: "" }))
      .then((r) => { if (r.out.trim() === "yes") suite(); });
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

      .then(() => {
        Q.ui.hidePanel();
        record("done", !fails.length, fails.length ? fails.length + " failed" : "all passed");
      })
      .catch((e) => record("done", false, String(e)));
  }

  boot();
})(window.Q);
