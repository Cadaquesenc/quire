"use strict";
// quire / command palette and shortcut editor

(function (Q) {
  const P = { open: false, el: null, input: null, list: null, items: [], idx: 0, mode: "cmd" };

  // ---- fuzzy ----------------------------------------------------------------
  // subsequence match scored on run length and word starts, which is enough to
  // put "insert table" above "reformat table" when you type "it".

  function score(q, text) {
    if (!q) return 1;
    const t = text.toLowerCase();
    let ti = 0, s = 0, run = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      const at = t.indexOf(ch, ti);
      if (at === -1) return 0;
      if (at === ti && qi > 0) { run++; s += 4 + run; }
      else { run = 0; s += 1; }
      if (at === 0 || /[\s:_-]/.test(t[at - 1])) s += 6;   // word start
      ti = at + 1;
    }
    if (t.startsWith(q)) s += 20;
    s -= Math.min(10, (t.length - q.length) * 0.05);
    return Math.max(s, 0.1);
  }

  function build() {
    const el = Q.el("div", { id: "q-palette" },
      '<div class="q-pal-box">' +
      '<div class="q-float-title">commands</div>' +
      '<div class="q-pal-prompt"><span class="q-pal-caret">&rsaquo;</span>' +
      '<input class="q-pal-input" type="text" spellcheck="false" autocomplete="off"></div>' +
      '<div class="q-pal-cols"><div class="q-pal-list"></div>' +
      '<div class="q-pal-detail"></div></div>' +
      '<div class="q-pal-foot"><span><kbd>↑↓</kbd> move</span><span><kbd>↩</kbd> run</span>' +
      '<span><kbd>⌥↩</kbd> bind key</span><span><kbd>esc</kbd> close</span></div>' +
      "</div>");
    document.body.appendChild(el);
    P.el = el;
    P.input = el.querySelector(".q-pal-input");
    P.list = el.querySelector(".q-pal-list");

    P.input.addEventListener("input", () => filter(P.input.value));
    P.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const it = P.items[P.idx];
        if (!it) return;
        if (e.altKey) { close(); rebind(it.id); }
        else { close(); Q.run(it.id); }
      } else if (e.key === "Escape") { e.preventDefault(); close(); }
      e.stopPropagation();
    }, true);
    el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });
  }

  function filter(q) {
    q = (q || "").toLowerCase().trim();
    const all = Q.commands();
    P.items = all
      .map((c) => ({ c, s: Math.max(score(q, c.title), score(q, c.category + " " + c.title) * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.c);
    P.idx = 0;
    render();
  }

  function detail() {
    const c = P.items[P.idx];
    const box = P.el && P.el.querySelector(".q-pal-detail");
    if (!box) return;
    if (!c) { box.innerHTML = ""; return; }
    const key = Q.keys.forCommand(c.id);
    box.innerHTML =
      '<div class="q-pd-title">' + Q.esc(c.title) + "</div>" +
      '<div class="q-pd-row"><span>category</span><b>' + Q.esc(c.category) + "</b></div>" +
      '<div class="q-pd-row"><span>id</span><b>' + Q.esc(c.id) + "</b></div>" +
      '<div class="q-pd-row"><span>key</span><b>' +
        (key ? "<kbd>" + Q.keys.pretty(key) + "</kbd>" : "&mdash;") + "</b></div>" +
      '<div class="q-pd-hint">⌥↩ to bind a key</div>';
  }

  function render() {
    P.list.innerHTML = P.items.map((c, i) =>
      '<div class="q-pal-item' + (i === P.idx ? " sel" : "") + '" data-i="' + i + '">' +
      '<span class="q-pal-cat">' + Q.esc(c.category) + "</span>" +
      '<span class="q-pal-title">' + Q.esc(c.title) + "</span>" +
      "<kbd>" + Q.keys.pretty(Q.keys.forCommand(c.id)) + "</kbd></div>").join("") ||
      '<div class="q-pal-empty">no command matches</div>';
    detail();
    P.list.querySelectorAll(".q-pal-item").forEach((el) => {
      el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const it = P.items[+el.dataset.i];
        close();
        if (it) ev.altKey ? rebind(it.id) : Q.run(it.id);
      });
    });
  }

  function move(d) {
    if (!P.items.length) return;
    P.idx = (P.idx + d + P.items.length) % P.items.length;
    render();
    const sel = P.list.querySelector(".sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function open() {
    if (!P.el) build();
    P.open = true;
    P.el.classList.add("q-open");
    P.input.value = "";
    filter("");
    P.input.focus();
  }

  function close() {
    if (!P.el) return;
    P.open = false;
    P.el.classList.remove("q-open");
    try { Q.ed().refocus(); } catch (_) {}
  }

  Q.command({
    id: "palette", title: "Command palette", category: "Quire", keys: "mod+alt+p",
    run: () => (P.open ? close() : open()),
  });

  // ---- capturing a new shortcut ---------------------------------------------

  function rebind(id) {
    const cmd = Q.getCommand(id);
    if (!cmd) return;
    const box = Q.el("div", { class: "q-capture" },
      '<div class="q-capture-key">press a shortcut</div>' +
      '<div class="q-capture-hint">esc to cancel · delete to unbind</div>');
    let captured = null;

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();
      const k = (e.key || "").toLowerCase();
      if (k === "meta" || k === "control" || k === "alt" || k === "shift") return;
      if (k === "escape") { finish(false); return; }
      if (k === "backspace" || k === "delete") {
        const cur = Q.keys.forCommand(id);
        if (cur) Q.keys.unbind(cur);
        finish(true, null);
        return;
      }
      const p = [];
      if (e.metaKey) p.push("mod");
      if (e.ctrlKey) p.push("ctrl");
      if (e.altKey) p.push("alt");
      if (e.shiftKey) p.push("shift");
      let base = k;
      const d = /^Digit(\d)$/.exec(e.code || "");
      const l = /^Key([A-Z])$/.exec(e.code || "");
      if (d) base = d[1]; else if (l) base = l[1].toLowerCase();
      p.push(base);
      captured = p.join("+");
      box.querySelector(".q-capture-key").textContent = Q.keys.pretty(captured);
    }

    function finish(apply, forceNull) {
      document.removeEventListener("keydown", onKey, true);
      Q.ui.closeModal();
      if (!apply) return;
      if (forceNull === null) { Q.ui.toast(Q.esc(cmd.title) + " unbound"); return; }
      if (!captured) return;
      const taken = Q.keys.lookup(captured);
      if (taken && taken !== id) {
        const other = Q.getCommand(taken);
        Q.ui.toast(Q.keys.pretty(captured) + " taken by <b>" + Q.esc(other ? other.title : taken) + "</b> — rebound");
      }
      const prev = Q.keys.forCommand(id);
      if (prev && prev !== captured) Q.keys.unbind(prev);
      Q.keys.bind(captured, id);
      Q.ui.toast("<b>" + Q.esc(cmd.title) + "</b> → " + Q.keys.pretty(captured));
    }

    document.addEventListener("keydown", onKey, true);
    Q.ui.modal({
      title: "Shortcut for “" + cmd.title + "”",
      body: box,
      buttons: [
        { label: "Cancel", run: () => finish(false) },
        { label: "Set", primary: true, run: () => finish(true) },
      ],
    });
  }

  Q.rebind = rebind;

  // ---- the whole keymap, as a table ----------------------------------------

  Q.command({
    id: "keymap", title: "Keyboard shortcuts", category: "Quire",
    run: function () {
      const bound = Q.keys.all();
      const rows = Q.commands().map((c) => {
        const k = Q.keys.forCommand(c.id);
        return { c, k };
      }).sort((a, b) => (b.k ? 1 : 0) - (a.k ? 1 : 0) ||
                        a.c.category.localeCompare(b.c.category) ||
                        a.c.title.localeCompare(b.c.title));
      const wrap = Q.el("div", { class: "q-keymap" });
      wrap.innerHTML =
        '<p class="q-note">the host application cannot bind a shortcut on macos at all — ' +
        'its keybinding path is guarded by a node check that never passes here. ' +
        'click any row to set one.</p>' +
        '<table>' + rows.map((r) =>
          '<tr data-id="' + r.c.id + '"><td class="cat">' + Q.esc(r.c.category) + "</td>" +
          "<td>" + Q.esc(r.c.title) + "</td>" +
          '<td class="k"><kbd>' + (Q.keys.pretty(r.k) || "—") + "</kbd></td></tr>").join("") +
        "</table>";
      wrap.querySelectorAll("tr").forEach((tr) =>
        tr.addEventListener("click", () => { Q.ui.closeModal(); rebind(tr.dataset.id); }));
      Q.ui.modal({
        title: "Keyboard shortcuts — " + Object.keys(bound).length + " bound",
        body: wrap, wide: true,
        buttons: [{ label: "Done", primary: true }],
      });
    },
  });
})(window.Q);
