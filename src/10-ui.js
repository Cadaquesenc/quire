"use strict";
// quire / ui primitives
//
// window.prompt is dead in this runtime, the host hijacked it as a synchronous
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
    toastEl.classList.add("q-open");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("q-open"), ms || 4000);
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
    // one shape for every button in the app: a filled secondary, an accent
    // primary, and a ghost for anything that is neither a decision nor a
    // cancel. the variant is a class, never a second set of paddings.
    (opts.buttons || []).forEach((b) => {
      const kind = b.primary ? " primary" : b.kind ? " " + b.kind : "";
      const el = Q.el("button", { class: "q-btn" + kind, type: "button" }, Q.esc(b.label));
      el.addEventListener("click", () => { if (!b.keepOpen) ui.closeModal(); b.run && b.run(); });
      foot.appendChild(el);
    });
    m.classList.add("q-open");
    m.dataset.wide = opts.wide ? "1" : "";
    setTimeout(() => {
      const f = body.querySelector("input, textarea, button");
      if (f) f.focus();
    }, 10);
    return m;
  };

  ui.closeModal = function () {
    if (!modal) return;
    modal.classList.remove("q-open");
    try { Q.ed().refocus(); } catch (_) {}
  };

  ui.isModalOpen = () => !!(modal && modal.classList.contains("q-open"));

  // ---- empty states ---------------------------------------------------------
  //
  // an empty panel is where an app either explains itself or shrugs. one shape
  // for all of them: an icon, the fact, and what to do about it, in the three
  // levels of text everything else here uses.

  ui.empty = function (icon, title, hint) {
    return '<div class="q-empty">' +
      (icon && Q.icon ? Q.icon(icon, 22) : "") +
      '<div class="q-empty-t">' + (title || "") + "</div>" +
      (hint ? '<div class="q-empty-h">' + hint + "</div>" : "") +
      "</div>";
  };

  // the same shape while something is still being read off the disk
  ui.loading = function (what) {
    return '<div class="q-empty"><span class="q-spinner"></span>' +
      '<div class="q-empty-t">' + (what || "reading…") + "</div></div>";
  };

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

  // ---- the sidebar ----------------------------------------------------------
  // one column on the right holding every section there is: files, backlinks,
  // tags, git, the terminal. the host owns the left sidebar; this one is ours.
  //
  // an icon rail, not a tab strip. the strip that was here only spelled out the
  // section you were already in, so four of the five tabs were bare icons
  // anyway, laid out sideways, competing for the same row as the title. the
  // rail puts them on the window edge the way discord does, gives the section
  // name a line of its own, and has room for as many sections as get written.
  //
  // each section owns its element and is hidden rather than destroyed. that is
  // what lets the terminal keep its scrollback, its cwd and whatever is
  // half-typed in it while you go and look at something else.

  const panels = {};
  const registered = [];
  let panelEl = null, stackEl = null, railEl = null, titleEl = null, activePanel = null;

  function sections() {
    return registered.map((id) => panels[id])
      .sort((a, b) => a.order - b.order || registered.indexOf(a.id) - registered.indexOf(b.id));
  }

  function applyWidth(w) {
    w = Math.max(220, Math.min(680, Math.round(w) || 300));
    document.documentElement.style.setProperty("--q-side-w", w + "px");
    return w;
  }

  function wireGrip(grip) {
    grip.addEventListener("mousedown", function (e) {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = panelEl.getBoundingClientRect().width;
      // the panel is on the right, so dragging left widens it
      const at = (ev) => applyWidth(w0 + (x0 - ev.clientX));
      const move = (ev) => { at(ev); };
      const up = (ev) => {
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", up, true);
        document.body.classList.remove("q-side-resizing");
        Q.setPref("sideWidth", at(ev));
        Q.emit("sidebar", activePanel);
      };
      document.body.classList.add("q-side-resizing");
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
    });
  }

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = Q.el("div", { id: "q-panel" },
      '<div class="q-side-grip" title="drag to resize"></div>' +
      '<div class="q-side-main">' +
        '<div class="q-side-head">' +
          '<span class="q-side-title"></span>' +
          '<span class="q-side-close q-iconbtn" title="Close the sidebar"></span>' +
        "</div>" +
        '<div class="q-side-stack"></div>' +
      "</div>" +
      '<div class="q-rail"></div>');
    document.body.appendChild(panelEl);
    stackEl = panelEl.querySelector(".q-side-stack");
    railEl = panelEl.querySelector(".q-rail");
    titleEl = panelEl.querySelector(".q-side-title");
    const close = panelEl.querySelector(".q-side-close");
    close.innerHTML = Q.icon ? Q.icon("close", 13) : "&times;";
    close.addEventListener("click", ui.hidePanel);
    wireGrip(panelEl.querySelector(".q-side-grip"));
    applyWidth(Q.prefs().sideWidth);
    renderRail();
    return panelEl;
  }

  function renderRail() {
    if (!railEl) return;
    railEl.innerHTML = sections().map((p) => {
      let k = "";
      try { k = Q.keys.pretty(Q.keys.forCommand(p.id)); } catch (_) {}
      return '<div class="q-rail-btn' + (p.id === activePanel ? " sel" : "") +
        '" data-id="' + p.id + '" title="' + Q.esc(p.title + (k ? "   " + k : "")) + '">' +
        (p.icon && Q.icon ? Q.icon(p.icon, 17) : Q.esc(p.title.slice(0, 1))) + "</div>";
    }).join("");
    railEl.querySelectorAll(".q-rail-btn").forEach((b) =>
      b.addEventListener("click", () => ui.showPanel(b.dataset.id)));
  }

  // order is explicit so the rail reads top to bottom in the order you use it
  // in, rather than in whatever order the source files happen to load.
  ui.registerPanel = function (id, title, render, icon, order) {
    const prev = panels[id];
    panels[id] = {
      id, title, render, icon: icon || null,
      order: order == null ? 50 : order,
      el: prev ? prev.el : null,
      drawn: false,
    };
    if (registered.indexOf(id) === -1) registered.push(id);
    if (panelEl) renderRail();
  };

  ui.sections = () => sections().map((p) => p.id);
  ui.sectionTitle = (id) => (panels[id] ? panels[id].title : "");
  ui.activePanel = () =>
    (panelEl && panelEl.classList.contains("q-open") ? activePanel : null);

  ui.showPanel = function (id, force) {
    const p = panels[id];
    if (!p) return;
    ensurePanel();
    activePanel = id;
    document.body.classList.add("q-panel-open");
    panelEl.classList.add("q-open");
    titleEl.textContent = p.title;

    if (!p.el) {
      p.el = Q.el("div", { class: "q-panel-body", "data-id": id });
      p.el.hidden = true;
      stackEl.appendChild(p.el);
    }
    sections().forEach((s) => {
      if (!s.el) return;
      const on = s.id === id;
      s.el.classList.toggle("q-active", on);
      s.el.hidden = !on;
    });

    if (!p.drawn || force) {
      p.drawn = true;
      // a section may have put its own class on the element last time round
      p.el.className = "q-panel-body q-active";
      p.el.innerHTML = "";
      const out = p.render(p.el);
      if (typeof out === "string") p.el.innerHTML = out;
      else if (out instanceof Node) p.el.appendChild(out);
    }
    renderRail();
    // only write when it actually changed: refreshPanel comes back through here
    // on every document change and every git poll, and each setPref is a
    // localStorage write plus a trip across the bridge.
    const pr = Q.prefs();
    if (!pr.sideOpen) Q.setPref("sideOpen", true);
    if (pr.sideSection !== id) Q.setPref("sideSection", id);
    Q.emit("sidebar", id);
  };

  ui.hidePanel = function () {
    if (!panelEl) return;
    panelEl.classList.remove("q-open");
    document.body.classList.remove("q-panel-open");
    activePanel = null;
    renderRail();
    if (Q.prefs().sideOpen) Q.setPref("sideOpen", false);
    Q.emit("sidebar", null);
  };

  ui.togglePanel = function (id) {
    if (ui.activePanel() === id) ui.hidePanel();
    else ui.showPanel(id);
  };

  // the sidebar itself, on whichever section it was left on
  ui.toggleSidebar = function () {
    if (ui.activePanel()) return ui.hidePanel();
    const want = Q.prefs().sideSection;
    ui.showPanel(panels[want] ? want : ui.sections()[0]);
  };

  ui.cycleSection = function (delta) {
    const ids = ui.sections();
    if (!ids.length) return;
    const at = ids.indexOf(activePanel);
    ui.showPanel(ids[at === -1 ? 0 : (at + delta + ids.length) % ids.length]);
  };

  // called once at boot, after every section has registered itself.
  //
  // never on a sticky. the preference is shared with the main window, so a note
  // opened while the sidebar was up restored a 300px panel into a 380px window
  // and squeezed the note into the 80px that were left.
  ui.restoreSidebar = function () {
    if (document.body.classList.contains("q-sticky")) return;
    // the rail has to exist even when the sidebar is shut, because the rail is
    // how you open it. it used to be built inside showPanel, so a launch with
    // the sidebar closed drew no rail at all and left the sections reachable
    // only by keyboard.
    ensurePanel();
    if (!Q.prefs().sideOpen) return;
    const want = Q.prefs().sideSection;
    const id = panels[want] ? want : ui.sections()[0];
    if (id) ui.showPanel(id);
  };

  ui.refreshPanel = function (id) {
    if (activePanel === id) ui.showPanel(id, true);
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
