"use strict";
// quire / files
//
// the host's sidebar is a tree of the one folder you opened, and it only ever
// shows markdown. this is the other view: every file under the folder, flat,
// grouped by directory, filterable, with the path visible — which is the thing
// you actually want when you are looking for where something lives.
//
// it opens markdown in the editor and hands anything else to the system, so it
// works as a browser for a mixed folder rather than a markdown-only list.

(function (Q) {
  const MARKDOWN = /\.(md|markdown|mdown|mkd|mmd|txt|text)$/i;

  const state = { all: [], filter: "", showAll: false, at: 0, root: "" };

  function scan(force) {
    const root = Q.doc.root();
    if (!root) return Promise.resolve([]);
    if (state.root === root && !force && Date.now() - state.at < 20000) {
      return Promise.resolve(state.all);
    }
    // one find, everything, size and mtime included. the sort is by directory
    // then name so the grouping below is a single pass.
    const globs = Q.SKIP.map((d) => `-g ${Q.sh("!" + d + "/")}`).join(" ");
    // shellBig, not shell: 8000 rows of `mtime|size|path` is a quarter of a
    // megabyte, and anything over one pipe buffer never comes back at all.
    return Q.shellBig(
      `${Q.sh(Q.rg())} --files --no-messages ${globs} ${Q.sh(root)} 2>/dev/null | head -8000 | ` +
      `tr '\\n' '\\0' | xargs -0 stat -f '%m|%z|%N' 2>/dev/null | sort -t'|' -k3`
    ).then((r) => {
      const rows = (r.out ? r.out.split("\n") : []).filter(Boolean).map((line) => {
        const i1 = line.indexOf("|"), i2 = line.indexOf("|", i1 + 1);
        if (i1 < 0 || i2 < 0) return null;
        const path = line.slice(i2 + 1);
        const slash = path.lastIndexOf("/");
        const dir = path.slice(0, slash);
        return {
          path,
          name: path.slice(slash + 1),
          dir,
          reldir: Q.rel(dir, root),
          mtime: +line.slice(0, i1) * 1000,
          size: +line.slice(i1 + 1, i2),
          md: MARKDOWN.test(path),
        };
      }).filter(Boolean);
      state.all = rows; state.at = Date.now(); state.root = root;
      return rows;
    });
  }

  Q.files = scan;

  const human = (n) =>
    n < 1024 ? n + " B" :
    n < 1048576 ? (n / 1024).toFixed(0) + " KB" :
    (n / 1048576).toFixed(1) + " MB";

  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + "m";
    if (s < 129600) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }

  function open(f) {
    if (f.md) return Q.doc.open(f.path);
    // not markdown: let the system decide what owns it
    return Q.shell(`open ${Q.sh(f.path)}`).then(() => Q.ui.toast("opened " + Q.esc(f.name)));
  }

  Q.ui.registerPanel("files", "Files", function (body) {
    body.innerHTML = '<div class="q-panel-loading">scanning…</div>';
    const root = Q.doc.root();
    if (!root) {
      body.innerHTML = '<div class="q-panel-empty">open a folder first.</div>';
      return;
    }

    scan().then((rows) => {
      body.innerHTML =
        '<div class="q-files-head">' +
        '<input class="q-input q-files-filter" placeholder="filter…" spellcheck="false">' +
        '<div class="q-files-toggle" id="q-files-toggle"></div>' +
        "</div><div class="+'"q-files-list"'+"></div>";

      const input = body.querySelector(".q-files-filter");
      const toggle = body.querySelector("#q-files-toggle");
      const list = body.querySelector(".q-files-list");

      function draw() {
        const q = state.filter.toLowerCase();
        let rowsShown = rows.filter((f) => state.showAll || f.md);
        if (q) rowsShown = rowsShown.filter((f) => (f.reldir + "/" + f.name).toLowerCase().includes(q));

        const mdCount = rows.filter((f) => f.md).length;
        toggle.innerHTML =
          '<span class="q-files-chip' + (state.showAll ? "" : " on") + '" data-all="0">markdown ' + mdCount + "</span>" +
          '<span class="q-files-chip' + (state.showAll ? " on" : "") + '" data-all="1">all ' + rows.length + "</span>";
        toggle.querySelectorAll(".q-files-chip").forEach((c) =>
          c.addEventListener("click", () => { state.showAll = c.dataset.all === "1"; draw(); }));

        if (!rowsShown.length) {
          list.innerHTML = '<div class="q-panel-empty">nothing matches</div>';
          return;
        }

        // group by directory, folders in path order, current file marked
        const groups = {};
        rowsShown.slice(0, 1200).forEach((f) => (groups[f.reldir] = groups[f.reldir] || []).push(f));
        const here = Q.doc.path();

        list.innerHTML = Object.keys(groups).sort().map((dir) =>
          '<div class="q-fgroup">' +
          '<div class="q-fgroup-name">' + Q.icon("files", 12) +
          "<span>" + Q.esc(dir || "·") + "</span>" +
          '<i>' + groups[dir].length + "</i></div>" +
          groups[dir].map((f) =>
            '<div class="q-file' + (f.path === here ? " here" : "") + '" data-p="' + Q.esc(f.path) + '">' +
            Q.icon(Q.iconForPath(f.path), 14) +
            '<span class="q-file-name">' + Q.esc(f.name) + "</span>" +
            '<span class="q-file-meta">' + ago(f.mtime) + " · " + human(f.size) + "</span>" +
            "</div>").join("") +
          "</div>").join("");

        list.querySelectorAll(".q-file").forEach((el, i) =>
          el.addEventListener("click", () => {
            const f = rowsShown.find((x) => x.path === el.dataset.p);
            if (f) open(f);
          }));
      }

      input.value = state.filter;
      input.addEventListener("input", () => { state.filter = input.value; draw(); });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { input.value = ""; state.filter = ""; draw(); }
        if (e.key === "Enter") {
          const first = list.querySelector(".q-file");
          if (first) first.click();
        }
      }, true);

      draw();
    }).catch((e) => {
      body.innerHTML = '<div class="q-panel-empty">' + Q.esc(e.message) + "</div>";
    });
  }, "files");

  // clicking a folder in the status bar opens this panel scoped to it
  Q.on("navigate", function (dir) {
    const root = Q.doc.root();
    state.filter = Q.rel(dir, root) || "";
    state.showAll = true;
    Q.ui.showPanel("files");
  });

  Q.command({
    id: "files", title: "Files", category: "Navigate", keys: "mod+alt+e",
    run: () => Q.ui.togglePanel("files"),
  });

  Q.on("vault", () => { state.at = 0; Q.ui.refreshPanel("files"); });

  Q.command({
    id: "setRoot", title: "Set the default folder", category: "Navigate",
    run: () => Q.ui.prompt("Default folder", Q.prefs().vaultRoot || "~/Code", "~/Code")
      .then((v) => {
        if (!v) return;
        Q.setVaultRoot(v.trim());
        state.at = 0;
        // the path may need the shell to expand ~, so give it a beat
        setTimeout(() => {
          Q.ui.showPanel("files");
          Q.ui.toast("default folder: <b>" + Q.esc(Q.doc.root() || v) + "</b>");
        }, 250);
      }),
  });

  Q.command({
    id: "rescan", title: "Rescan the folder", category: "Navigate",
    run: () => scan(true).then((r) => {
      Q.ui.refreshPanel("files");
      Q.ui.toast("found <b>" + r.length + "</b> files");
    }),
  });
})(window.Q);
