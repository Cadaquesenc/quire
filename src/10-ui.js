"use strict";
// quire / ui primitives
//
// window.prompt is dead in this runtime — the host hijacked it as a synchronous
// channel to native, and its else branch returns null. so every dialog here is
// built from scratch rather than borrowed from the browser.

(function (Q) {
  const ui = (Q.ui = {});

  // ---- toast ----------------------------------------------------------------

  let toastEl, toastTimer;
  ui.toast = function (html, ms) {
    if (!toastEl) {
      toastEl = Q.el("div", { id: "q-toast" });
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = html;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms || 4000);
  };

  ui.error = (msg) => ui.toast('<span class="q-bad">' + Q.esc(msg) + "</span>", 6000);

  // ---- a modal that can hold anything ---------------------------------------

  let modal = null;

  function ensureModal() {
    if (modal) return modal;
    modal = Q.el("div", { id: "q-modal" },
      '<div class="q-sheet"><div class="q-sheet-title"></div>' +
      '<div class="q-sheet-body"></div>' +
      '<div class="q-sheet-foot"></div></div>');
    document.body.appendChild(modal);
    modal.addEventListener("mousedown", (e) => { if (e.target === modal) ui.closeModal(); });
    return modal;
  }

  ui.modal = function (opts) {
    const m = ensureModal();
    m.querySelector(".q-sheet-title").textContent = opts.title || "";
    const body = m.querySelector(".q-sheet-body");
    body.innerHTML = "";
    if (typeof opts.body === "string") body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    const foot = m.querySelector(".q-sheet-foot");
    foot.innerHTML = "";
    (opts.buttons || []).forEach((b) => {
      const el = Q.el("button", { class: "q-btn" + (b.primary ? " primary" : "") }, Q.esc(b.label));
      el.addEventListener("click", () => { if (!b.keepOpen) ui.closeModal(); b.run && b.run(); });
      foot.appendChild(el);
    });
    m.classList.add("show");
    m.dataset.wide = opts.wide ? "1" : "";
    setTimeout(() => {
      const f = body.querySelector("input, textarea, button");
      if (f) f.focus();
    }, 10);
    return m;
  };

  ui.closeModal = function () {
    if (!modal) return;
    modal.classList.remove("show");
    try { Q.ed().refocus(); } catch (_) {}
  };

  ui.isModalOpen = () => !!(modal && modal.classList.contains("show"));

  // a replacement for the prompt() the host took away
  ui.prompt = function (title, initial, placeholder) {
    return new Promise((resolve) => {
      const input = Q.el("input", {
        class: "q-input", type: "text", placeholder: placeholder || "", spellcheck: "false",
      });
      input.value = initial || "";
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };

      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); ui.closeModal(); finish(input.value); }
        if (e.key === "Escape") { e.preventDefault(); ui.closeModal(); finish(null); }
      }, true);

      ui.modal({
        title: title,
        body: input,
        buttons: [
          { label: "Cancel", run: () => finish(null) },
          { label: "OK", primary: true, run: () => finish(input.value) },
        ],
      });
      setTimeout(() => { input.focus(); input.select(); }, 10);
    });
  };

  ui.confirm = function (title, message) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      ui.modal({
        title: title,
        body: "<p>" + Q.esc(message) + "</p>",
        buttons: [
          { label: "Cancel", run: () => finish(false) },
          { label: "OK", primary: true, run: () => finish(true) },
        ],
      });
    });
  };

  // ---- side panel -----------------------------------------------------------
  // a second, right-hand sidebar. the host owns the left one; this one is ours,
  // and it holds backlinks, the assistant, whatever else wants a column.

  const panels = {};
  let panelEl = null, activePanel = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = Q.el("div", { id: "q-panel" },
      '<div class="q-panel-tabs"></div>' +
      '<div class="q-panel-body"></div>');
    document.body.appendChild(panelEl);
    return panelEl;
  }

  ui.registerPanel = function (id, title, render, icon) {
    panels[id] = { id, title, render, icon: icon || null, el: null };
    if (panelEl) renderTabs();
  };

  function renderTabs() {
    const tabs = panelEl.querySelector(".q-panel-tabs");
    tabs.innerHTML = Object.keys(panels)
      .map((id) => '<div class="q-panel-tab' + (id === activePanel ? " sel" : "") +
        '" data-id="' + id + '" title="' + Q.esc(panels[id].title) + '">' +
        (panels[id].icon && Q.icon ? Q.icon(panels[id].icon, 14) : "") +
        "<span>" + Q.esc(panels[id].title) + "</span></div>")
      .join("") + '<div class="q-panel-close" title="Close">' +
      (Q.icon ? Q.icon("close", 14) : "&times;") + "</div>";
    tabs.querySelectorAll(".q-panel-tab").forEach((t) =>
      t.addEventListener("click", () => ui.showPanel(t.dataset.id)));
    tabs.querySelector(".q-panel-close").addEventListener("click", ui.hidePanel);
  }

  ui.showPanel = function (id) {
    const p = panels[id];
    if (!p) return;
    ensurePanel();
    activePanel = id;
    document.body.classList.add("q-panel-open");
    panelEl.classList.add("show");
    renderTabs();
    const body = panelEl.querySelector(".q-panel-body");
    body.innerHTML = "";
    const out = p.render(body);
    if (typeof out === "string") body.innerHTML = out;
    else if (out instanceof Node) body.appendChild(out);
  };

  ui.hidePanel = function () {
    if (!panelEl) return;
    panelEl.classList.remove("show");
    document.body.classList.remove("q-panel-open");
    activePanel = null;
  };

  ui.togglePanel = function (id) {
    if (activePanel === id && panelEl && panelEl.classList.contains("show")) ui.hidePanel();
    else ui.showPanel(id);
  };

  ui.refreshPanel = function (id) {
    if (activePanel === id) ui.showPanel(id);
  };

  // ---- status bar -----------------------------------------------------------
  // the host has a word count in the footer and nothing else. this is a real
  // bar: it holds slots, and any feature can claim one.

  const slots = {};
  let barEl = null;

  function ensureBar() {
    if (barEl) return barEl;
    barEl = Q.el("div", { id: "q-status" });
    document.body.appendChild(barEl);
    document.body.classList.add("q-status-on");
    return barEl;
  }

  ui.slot = function (id, opts) {
    slots[id] = Object.assign({ id, order: 50, side: "left", text: "", title: "", onClick: null, extraClass: "" }, opts);
    drawBar();
    return {
      set(text, title) {
        slots[id].text = text;
        if (title != null) slots[id].title = title;
        drawBar();
      },
      hide() { delete slots[id]; drawBar(); },
    };
  };

  let lastBar = "";
  const drawBar = Q.debounce(function () {
    if (!Q.prefs().statusBar) { if (barEl) barEl.style.display = "none"; return; }
    const bar = ensureBar();
    bar.style.display = "";
    const pick = (side) => Object.values(slots)
      .filter((s) => s.side === side && s.text !== "" && s.text != null)
      .sort((a, b) => a.order - b.order);
    const cell = (s) =>
      '<div class="q-cell' + (s.onClick ? " click" : "") + (s.extraClass ? " " + s.extraClass : "") + '" data-id="' + s.id +
      '" title="' + Q.esc(s.title || "") + '">' + s.text + "</div>";
    const html =
      '<div class="q-status-left">' + pick("left").map(cell).join("") + "</div>" +
      '<div class="q-status-right">' + pick("right").map(cell).join("") + "</div>";
    // the watcher ticks every second and every keyup asks for a redraw. without
    // this the bar rebuilds its dom constantly for no visible change, and every
    // one of those repaints composites against the blurred window.
    if (html === lastBar) return;
    lastBar = html;
    bar.innerHTML = html;
    bar.querySelectorAll(".q-cell.click").forEach((c) =>
      c.addEventListener("click", (e) => {
        if (e.target.closest("[data-qdir]")) return;   // the path handles itself
        const s = slots[c.dataset.id];
        if (s && s.onClick) s.onClick();
      }));
    bar.querySelectorAll("[data-qdir]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        Q.emit("navigate", el.dataset.qdir);
      }));
  }, 30);

  ui.redrawStatus = drawBar;
})(window.Q);
