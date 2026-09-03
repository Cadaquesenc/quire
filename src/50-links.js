"use strict";
// quire / wiki links and backlinks
//
// the host has no concept of a note linking to another note. it also has no
// filesystem access from js. both are solved the same way: the shell shim.
// links are written as [[Note]] and resolved by name against the open folder.

(function (Q) {
  const cache = { root: "", files: [], at: 0 };

  // ---- the file index -------------------------------------------------------

  function listNotes(force) {
    const root = Q.doc.root();
    if (!root) return Promise.resolve([]);
    const fresh = cache.root === root && Date.now() - cache.at < 15000;
    if (fresh && !force) return Promise.resolve(cache.files);
    return Q.shell(
      `${Q.sh(Q.rg())} --files --no-messages -g '*.md' -g '*.markdown' ${Q.sh(root)} ` +
      `2>/dev/null | head -5000`
    ).then((r) => {
      const files = (r.out ? r.out.split("\n") : []).filter(Boolean).map((p) => ({
        path: p,
        name: p.slice(p.lastIndexOf("/") + 1),
        stem: p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
        rel: p.startsWith(root) ? p.slice(root.length + 1) : p,
      }));
      cache.root = root; cache.files = files; cache.at = Date.now();
      return files;
    });
  }

  Q.notes = listNotes;

  function resolve(name) {
    const want = name.trim().toLowerCase();
    return listNotes().then((files) =>
      files.find((f) => f.stem.toLowerCase() === want) ||
      files.find((f) => f.name.toLowerCase() === want) ||
      files.find((f) => f.stem.toLowerCase().indexOf(want) === 0) || null);
  }

  // ---- inserting a link -----------------------------------------------------

  Q.command({
    id: "wikiLink", title: "Link to a note", category: "Links", keys: "mod+alt+k",
    run: function () {
      return listNotes().then((files) => {
        if (!files.length) return Q.ui.toast("open a folder first — no notes found");
        pickNote(files, "Link to a note", (f) => {
          Q.doc.replaceSelection("[[" + f.stem + "]]");
        });
      });
    },
  });

  Q.command({
    id: "followLink", title: "Follow the link under the cursor", category: "Links", keys: "mod+alt+o",
    run: function () {
      const name = wikiNameNearCursor();
      if (!name) return Q.ui.toast("no [[link]] near the cursor");
      return resolve(name).then((f) => {
        if (f) return Q.doc.open(f.path);
        return Q.ui.confirm("Create note", "“" + name + "” doesn't exist. Create it?")
          .then((yes) => {
            if (!yes) return;
            const path = (Q.doc.root() || Q.doc.dir()) + "/" + name + ".md";
            return Q.shellIn(`cat > ${Q.sh(path)}`, "# " + name + "\n\n")
              .then(() => { cache.at = 0; return Q.doc.open(path); });
          });
      });
    },
  });

  // read the text around the caret and pull out the [[...]] it sits in or next to
  function wikiNameNearCursor() {
    let text = "", pos = 0;
    try {
      const sel = window.getSelection();
      if (sel && sel.anchorNode) {
        const node = sel.anchorNode;
        const block = node.nodeType === 3 ? node.parentElement : node;
        const holder = block && block.closest ? (block.closest("p, li, h1, h2, h3, h4, h5, h6, td") || block) : block;
        text = holder ? holder.textContent : "";
        pos = text.indexOf(node.nodeValue || "") + (sel.anchorOffset || 0);
      }
    } catch (_) {}
    if (!text) return null;
    const re = /\[\[([^\]]+)\]\]/g;
    let m, best = null;
    while ((m = re.exec(text))) {
      const a = m.index, b = m.index + m[0].length;
      if (pos >= a && pos <= b) return m[1];
      if (best === null) best = m[1];
    }
    return best;
  }

  // ---- a picker, reused by everything that needs to choose a note -----------

  function pickNote(files, title, onPick) {
    const input = Q.el("input", { class: "q-input", type: "text", placeholder: "filter…", spellcheck: "false" });
    const list = Q.el("div", { class: "q-picklist" });
    const wrap = Q.el("div", { class: "q-pick" });
    wrap.appendChild(input); wrap.appendChild(list);
    let shown = [], idx = 0;

    function draw() {
      list.innerHTML = shown.map((f, i) =>
        '<div class="q-pick-item' + (i === idx ? " sel" : "") + '" data-i="' + i + '">' +
        '<span class="q-pick-name">' + Q.esc(f.stem) + "</span>" +
        '<span class="q-pick-path">' + Q.esc(f.rel) + "</span></div>").join("") ||
        '<div class="q-pal-empty">nothing matches</div>';
      list.querySelectorAll(".q-pick-item").forEach((el) =>
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          Q.ui.closeModal();
          onPick(shown[+el.dataset.i]);
        }));
    }

    function refilter() {
      const q = input.value.toLowerCase().trim();
      shown = files.filter((f) => !q || f.rel.toLowerCase().includes(q)).slice(0, 200);
      idx = 0; draw();
    }

    input.addEventListener("input", refilter);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(idx + 1, shown.length - 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(idx - 1, 0); draw(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const f = shown[idx];
        Q.ui.closeModal();
        if (f) onPick(f);
      } else if (e.key === "Escape") { e.preventDefault(); Q.ui.closeModal(); }
      const sel = list.querySelector(".sel");
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }, true);

    refilter();
    Q.ui.modal({ title, body: wrap, buttons: [{ label: "Cancel" }] });
    setTimeout(() => input.focus(), 10);
  }

  Q.pickNote = pickNote;

  // ---- backlinks ------------------------------------------------------------

  function findBacklinks() {
    const root = Q.doc.root();
    const stem = Q.doc.stem();
    const name = Q.doc.name();
    if (!root || !stem) return Promise.resolve([]);
    // grep for both link spellings: the wiki form and a plain markdown target
    const cmd =
      `${Q.sh(Q.rg())} -n --no-heading --no-messages -F -g '*.md' -g '*.markdown' ` +
      `-e ${Q.sh("[[" + stem + "]]")} -e ${Q.sh("](" + name)} -e ${Q.sh("/" + name)} ` +
      `${Q.sh(root)} 2>/dev/null | head -300`;
    return Q.shell(cmd).then((r) => {
      const byFile = {};
      (r.out ? r.out.split("\n") : []).filter(Boolean).forEach((line) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!m) return;
        if (m[1] === Q.doc.path()) return;            // don't count the file itself
        (byFile[m[1]] = byFile[m[1]] || []).push({ line: +m[2], text: m[3].trim() });
      });
      return Object.keys(byFile).map((p) => ({
        path: p,
        rel: p.startsWith(root) ? p.slice(root.length + 1) : p,
        stem: p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
        hits: byFile[p],
      }));
    });
  }

  Q.backlinks = findBacklinks;

  Q.ui.registerPanel("backlinks", "Backlinks", function (body) {
    body.innerHTML = '<div class="q-panel-loading">searching…</div>';
    findBacklinks().then((refs) => {
      if (!refs.length) {
        body.innerHTML = '<div class="q-panel-empty">nothing links here yet.<br><br>' +
          'write <code>[[' + Q.esc(Q.doc.stem() || "Note") + ']]</code> in another note and it will show up.</div>';
        return;
      }
      body.innerHTML = refs.map((r) =>
        '<div class="q-back" data-path="' + Q.esc(r.path) + '">' +
        '<div class="q-back-name">' + Q.esc(r.stem) +
        '<span class="q-back-count">' + r.hits.length + "</span></div>" +
        '<div class="q-back-path">' + Q.esc(r.rel) + "</div>" +
        r.hits.slice(0, 4).map((h) =>
          '<div class="q-back-hit">' + Q.esc(h.text.slice(0, 160)) + "</div>").join("") +
        "</div>").join("");
      body.querySelectorAll(".q-back").forEach((el) =>
        el.addEventListener("click", () => Q.doc.open(el.dataset.path)));
    }).catch((e) => {
      body.innerHTML = '<div class="q-panel-empty">' + Q.esc(e.message) + "</div>";
    });
  }, "link");

  Q.command({
    id: "backlinks", title: "Backlinks", category: "Links", keys: "mod+alt+b",
    run: () => Q.ui.togglePanel("backlinks"),
  });

  Q.command({
    id: "reindex", title: "Reindex notes", category: "Links",
    run: () => listNotes(true).then((f) => Q.ui.toast("indexed <b>" + f.length + "</b> notes")),
  });

  // ---- unlinked mentions ----------------------------------------------------

  Q.command({
    id: "mentions", title: "Find unlinked mentions of this note", category: "Links",
    run: function () {
      const root = Q.doc.root(), stem = Q.doc.stem();
      if (!root || !stem) return Q.ui.toast("save the file first");
      return Q.shell(
        `${Q.sh(Q.rg())} -n --no-heading --no-messages -F -g '*.md' ${Q.sh(stem)} ${Q.sh(root)} ` +
        `2>/dev/null | grep -v ${Q.sh("[[" + stem + "]]")} | head -200`
      ).then((r) => {
        const lines = (r.out ? r.out.split("\n") : []).filter(Boolean)
          .filter((l) => !l.startsWith(Q.doc.path() + ":"));
        Q.ui.modal({
          title: "Unlinked mentions of “" + stem + "”",
          wide: true,
          body: lines.length
            ? '<div class="q-mentions">' + lines.map((l) => {
                const m = /^(.*?):(\d+):(.*)$/.exec(l) || [];
                const p = m[1] || l;
                return '<div class="q-mention" data-path="' + Q.esc(p) + '">' +
                  '<span class="q-mention-file">' + Q.esc(p.slice(root.length + 1)) + ":" + (m[2] || "") + "</span>" +
                  '<span class="q-mention-text">' + Q.esc((m[3] || "").trim().slice(0, 200)) + "</span></div>";
              }).join("") + "</div>"
            : "<p>no unlinked mentions.</p>",
          buttons: [{ label: "Done", primary: true }],
        });
        document.querySelectorAll(".q-mention").forEach((el) =>
          el.addEventListener("click", () => { Q.ui.closeModal(); Q.doc.open(el.dataset.path); }));
      });
    },
  });
})(window.Q);
