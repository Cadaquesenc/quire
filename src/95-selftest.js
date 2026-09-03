"use strict";
// quire / self test
//
// off unless the marker file exists:
//
//   touch ~/.quire-selftest
//
// gated on a file rather than a preference because the host only reloads
// preference keys it already knows about at startup — putSetting will happily
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
        const ids = ["files", "backlinks", "tags", "terminal"];
        const missing = [];
        ids.forEach((id) => {
          Q.ui.showPanel(id);
          const body = document.querySelector("#q-panel .q-panel-body");
          if (!body || !body.innerHTML.trim()) missing.push(id);
        });
        return { ok: !missing.length, detail: missing.length ? "empty: " + missing : ids.length + " render" };
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
        return {
          ok: !bad.length && !dupes.length,
          detail: cmds.length + " commands, " + Object.keys(all).length + " keys" +
                  (bad.length ? ", broken: " + bad : "") +
                  (dupes.length ? ", duplicate: " + dupes : ""),
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
