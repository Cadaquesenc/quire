"use strict";
// quire / claude code session viewer
//
// ~/.claude/projects is 1,542 .jsonl files and 1 GB on this machine, one json
// record per line with no line breaks inside a record. nothing reads them. the
// biggest one here is 47 MB, which is not a file you open in anything.
//
// the renderer is `qtranscript.py`, ported into the bundle rather than rewritten
// in javascript, and it stays python for a reason that is not laziness: it
// writes its markdown straight to a file. the bridge caps a command's stdout at
// 60,000 bytes and a 47 MB transcript renders to 1.27 MB, so a javascript port
// would have to pull the whole thing back through base64 in 42 KB chunks before
// it could show you anything. redirecting to a file means the only number that
// ever crosses the bridge is `wc -c`.
//
// what the python already gets right, and what took a pass to learn:
//   - message.content is EITHER a string OR a list of typed blocks, and both
//     shapes turn up in the same file
//   - a tool_result's content is sometimes itself a list of {type,text}
//   - file-history-snapshot, bridge-session, atis-latch, cost-state,
//     last-prompt, mode and permission-mode are junk and are skipped outright
//   - the session's real name is the ai-title record and it can appear late
//
// measured on this machine: 47 MB in, 1.27 MB of markdown out, 0.13s.

(function (Q) {
  const LIST_N = 40;              // transcripts listed, newest first
  const BIG_OUTPUT = 600000;      // past this the render is paged instead
  const PAGE = 400;               // records per page when paging

  let PY = null;                  // resolved python, once

  function script() {
    let href = location.href;
    try { href = decodeURI(href); } catch (_) {}
    const i = href.indexOf("/TypeMark/");
    if (i === -1) return "";
    return href.slice(0, i).replace(/^file:\/\//, "") + "/TypeMark/qtranscript/qtranscript.py";
  }

  // the app inherits launchd's PATH, which is /usr/bin:/bin:/usr/sbin:/sbin and
  // nothing else, so a homebrew python3 is not on it. /usr/bin/python3 is, and
  // is the one the build validated the script against.
  function python() {
    if (PY) return Promise.resolve(PY);
    return Q.shell('command -v python3 || echo /usr/bin/python3').then((r) => {
      PY = (r.out || "/usr/bin/python3").split("\n")[0].trim() || "/usr/bin/python3";
      return PY;
    });
  }

  // ---- listing ---------------------------------------------------------------
  //
  // two round trips rather than one nested shell script. the first is the cheap
  // walk, 0.03s for all 1,542 files. the second is handed the chosen paths on
  // stdin, which is the only way
  // to loop over filenames from here without a quoting accident. a filename with
  // a quote in it inside a `while read` inside a `case` inside a `$( )` inside a
  // javascript string is four levels of escaping and one of them is always wrong.
  function list(limit) {
    const n = 0 | (limit || LIST_N);
    const walk =
      'd="$HOME/.claude/projects"; [ -d "$d" ] || exit 0; ' +
      'find "$d" -name "*.jsonl" -type f -exec stat -f "%m %z %N" {} + 2>/dev/null | ' +
      "sort -rn | head -" + n;
    return Q.shell(walk, "/").then((r) => {
      const rows = (r.out ? r.out.split("\n") : []).map((line) => {
        const sp = line.indexOf(" ");
        const sp2 = line.indexOf(" ", sp + 1);
        if (sp < 1 || sp2 < 1) return null;
        return {
          mtime: parseInt(line.slice(0, sp), 10) || 0,
          size: parseInt(line.slice(sp + 1, sp2), 10) || 0,
          path: line.slice(sp2 + 1),
        };
      }).filter((x) => x && x.path);
      if (!rows.length) return [];

      // the title is the expensive column, so it is only asked for on main
      // sessions. that is measured, not assumed: of the 40 newest transcripts on
      // this machine, 29 are subagent transcripts and not one of them has an
      // ai-title record, while all 11 main sessions do. the cwd is always in the
      // first record, so 64 KB off the front is enough for it.
      const loop =
        "while IFS= read -r f; do " +
        '  t=""; ' +
        '  case "$f" in */subagents/*) ;; ' +
        "    *) t=$(grep -ao '\"aiTitle\":\"[^\"]*\"' \"$f\" 2>/dev/null | sed -n '$p');; esac; " +
        "  c=$(head -c 65536 \"$f\" 2>/dev/null | grep -ao '\"cwd\":\"[^\"]*\"' | sed -n '1p'); " +
        '  printf "%s\\t%s\\t%s\\n" "$f" "$t" "$c"; ' +
        "done";
      return Q.shellIn(loop, rows.map((x) => x.path).join("\n") + "\n", "/").then((res) => {
        const meta = {};
        (res.out ? res.out.split("\n") : []).forEach((line) => {
          const p = line.split("\t");
          if (!p[0]) return;
          const grab = (s, k) => {
            const m = new RegExp('"' + k + '":"([^"]*)"').exec(s || "");
            return m ? m[1] : "";
          };
          meta[p[0]] = { title: grab(p[1], "aiTitle"), cwd: grab(p[2], "cwd") };
        });
        const now = Date.now() / 1000;
        return rows.map((x) => {
          const m = meta[x.path] || {};
          const sub = /\/subagents\//.test(x.path);
          const sid = x.path.slice(x.path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
          return Object.assign(x, {
            sid: sid,
            sub: sub,
            // a subagent transcript has no ai-title, so it is labelled by what it
            // is rather than given a title it does not have.
            title: (m.title || "").trim() ||
                   (sub ? "subagent · " + sid.replace(/^agent-/, "").slice(0, 12) : sid.slice(0, 8)),
            cwd: (m.cwd || "").trim(),
            ago: Q.since(now - x.mtime),
          });
        });
      });
    });
  }

  // ---- rendering -------------------------------------------------------------

  const slug = (s) => String(s || "session").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "session";

  // render a transcript to a markdown file and hand back where it landed.
  // opts.from / opts.limit page it; without them the whole thing is rendered and
  // then re-rendered as one page if it came out too big to be a document.
  //
  // stderr is folded into the file rather than thrown away, so a python that
  // fails leaves its traceback where you can read it instead of an empty note.
  function render(rec, opts) {
    opts = opts || {};
    const name = slug(rec.title) + "-" + rec.sid.slice(0, 8) +
      (opts.from ? "-from" + opts.from : "") + ".md";
    return Promise.all([python(), Q.expand(Q.prefs().transcriptDir || "~/.quire/transcripts")])
      .then((got) => {
        const py = got[0], dir = got[1];
        const out = dir + "/" + name;
        const run = (a) =>
          Q.shell("mkdir -p " + Q.sh(dir) + " && " + Q.sh(py) + " " + Q.sh(script()) + " " +
                  Q.sh(rec.path) + a + " > " + Q.sh(out) + " 2>&1 && wc -c < " + Q.sh(out), "/");
        const args = (opts.limit ? " --limit " + (0 | opts.limit) : "") +
                     (opts.from ? " --from " + (0 | opts.from) : "");
        return run(args).then((r) => {
          if (!r.ok) return { ok: false, path: "", size: 0, detail: r.err || r.out };
          const size = parseInt(r.out, 10) || 0;
          // a 1.27 MB markdown document is not a document, it is a stress test.
          // so anything that renders that big is rendered again as one page, and
          // the python's own "rerun with --from N" line is the next page.
          if (size > BIG_OUTPUT && !opts.limit && !opts.from) {
            return run(" --limit " + PAGE).then((r2) => ({
              ok: r2.ok, paged: true, path: out, name: name,
              size: parseInt(r2.out, 10) || 0, full: size,
            }));
          }
          return { ok: true, paged: !!(opts.limit || opts.from), size: size,
                   path: out, name: name };
        });
      });
  }

  // ---- what you do with one --------------------------------------------------

  function openRendered(rec) {
    Q.ui.toast("rendering <b>" + Q.esc(rec.title) + "</b>…", 8000);
    return render(rec).then((res) => {
      if (!res.ok || !res.path) return Q.ui.error("qtranscript failed: " + (res.detail || "?"));
      // its own window. this is a reading document, and it must not take the
      // place of whatever you were writing.
      return Q.call("controller.openInNewWindow", res.path)
        .catch(() => Q.invoke("app.openFileOrFolder", res.path, { forceCreateWindow: true }))
        .then(() => Q.ui.toast("opened <b>" + Q.esc(res.name) + "</b> · " +
          Math.round(res.size / 1024) + " KB" + (res.paged ? " · first " + PAGE + " records" : "")));
    });
  }

  function preview(rec) {
    Q.ui.toast("rendering <b>" + Q.esc(rec.title) + "</b>…", 8000);
    return render(rec).then((res) => {
      if (!res.ok || !res.path) return Q.ui.error("qtranscript failed: " + (res.detail || "?"));
      // the read-only pane. it pulls the file back through shellBig with
      // {raw:true}, which is the path that does not trim the bytes.
      return Q.view.open(res.path);
    });
  }

  Q.sessions = { list, render, openRendered, preview, python, script, slug };

  // ---- the panel -------------------------------------------------------------

  const human = (n) =>
    n < 1024 ? n + " B" :
    n < 1048576 ? Math.round(n / 1024) + " KB" :
    (n / 1048576).toFixed(1) + " MB";

  let cache = null;

  Q.ui.registerPanel("sessions", "Sessions", function (body) {
    body.innerHTML = '<div class="q-sess-head"></div><div class="q-sess-list">' +
      Q.ui.loading("reading ~/.claude/projects…") + "</div>";
    const head = body.querySelector(".q-sess-head");
    const listEl = body.querySelector(".q-sess-list");

    function draw(rows) {
      cache = rows;
      head.innerHTML = '<span class="q-sess-count">' + rows.length + " newest</span>" +
        '<span class="q-sess-act" data-act="refresh">refresh</span>';
      head.querySelector('[data-act="refresh"]').addEventListener("click", () => {
        listEl.innerHTML = Q.ui.loading("reading…");
        list().then(draw);
      });
      if (!rows.length) {
        listEl.innerHTML = Q.ui.empty("clock", "no transcripts",
          "nothing under <code>~/.claude/projects</code> yet.");
        return;
      }
      listEl.innerHTML = rows.map((r, i) =>
        '<div class="q-sess-row' + (r.sub ? " sub" : "") + '" data-i="' + i + '">' +
        '<div class="q-sess-t">' + Q.esc(r.title) + "</div>" +
        '<div class="q-sess-m">' + Q.esc(r.ago) + " · " + human(r.size) +
        (r.cwd ? " · " + Q.esc(r.cwd.replace(/^\/Users\/[^/]+/, "~")) : "") + "</div>" +
        '<div class="q-sess-acts">' +
          '<span class="q-sess-act" data-do="open">open</span>' +
          '<span class="q-sess-act" data-do="peek">peek</span>' +
        "</div></div>").join("");
      listEl.querySelectorAll(".q-sess-row").forEach((el) => {
        const rec = rows[+el.dataset.i];
        el.querySelector('[data-do="open"]').addEventListener("click", (e) => {
          e.stopPropagation(); openRendered(rec);
        });
        el.querySelector('[data-do="peek"]').addEventListener("click", (e) => {
          e.stopPropagation(); preview(rec);
        });
        el.addEventListener("click", () => openRendered(rec));
      });
    }

    if (cache) draw(cache);
    list().then(draw, (e) => {
      listEl.innerHTML = Q.ui.empty("close", "could not read them", Q.esc(String(e)));
    });
  }, "clock", 70);

  // ---- commands --------------------------------------------------------------

  Q.command({
    id: "sessions", title: "Claude sessions", category: "Quire", keys: "mod+alt+h",
    run: () => Q.ui.togglePanel("sessions"),
  });

  Q.command({
    id: "sessionPick", title: "Render a claude session as markdown…", category: "Quire",
    run: () => list(120).then((rows) => {
      if (!rows.length) return Q.ui.toast("no transcripts under ~/.claude/projects");
      Q.pickNote(rows.map((r) => ({
        rec: r,
        stem: r.title,
        rel: r.ago + " · " + human(r.size) + (r.cwd ? " · " + r.cwd.replace(/^\/Users\/[^/]+/, "~") : ""),
      })), "Render a session", (it) => openRendered(it.rec));
    }),
  });

  Q.command({
    id: "sessionHere", title: "Render the newest session for this folder", category: "Quire",
    run: () => {
      const root = Q.doc.root();
      return list(200).then((rows) => {
        const hit = rows.filter((r) => !r.sub && r.cwd && (r.cwd === root || root.indexOf(r.cwd + "/") === 0));
        if (!hit.length) return Q.ui.toast("no session recorded with a cwd under " + root);
        return openRendered(hit[0]);
      });
    },
  });
})(window.Q);
