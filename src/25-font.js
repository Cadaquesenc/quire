"use strict";
// quire / typeface
//
// discord's own face is gg sans, which discord streams from its cdn and does not
// ship on disk — it is theirs, not redistributable, and it is not installed
// here. so the stack asks for it by name first, in case it ever is, and falls
// back to Inter, which is what gg sans is closest to and is openly licensed.
//
// deferred scripts all run before the first paint, so setting the face here
// rather than first in the list still costs nothing visually.

(function (Q) {
  const FONTS = [
    // the default. obsidian ships inter and sets it at 16px with generous
    // leading; that is what the rest of the ui is tuned against.
    { id: "obsidian", label: "Obsidian — Inter",
      stack: '"Inter", "InterVariable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
    { id: "operator", label: "Operator / MonoLisa mix",
      stack: '"Operator Mono", "Operator Mono Lig", "MonoLisa", "Victor Mono", "JetBrains Mono", ui-monospace, monospace' },
    { id: "discord", label: "Discord — gg sans, else Inter",
      stack: '"gg sans", "ggsans", "Inter", "InterVariable", -apple-system, sans-serif' },
    // the rounded system face. warmer than SF, and already on every mac.
    { id: "cosy", label: "Cosy — SF Rounded",
      stack: '"SF Pro Rounded", "SFProRounded-Regular", ui-rounded, "Nunito", "Inter", -apple-system, sans-serif' },
    // what the app's own bundled themes reach for
    { id: "typora", label: "Typora — Lato, Open Sans",
      stack: '"Lato", "Open Sans", "Helvetica Neue", Helvetica, sans-serif' },
    { id: "book", label: "Book — PT Serif",
      stack: '"PT Serif", "Merriweather", "New York", Georgia, serif' },
    { id: "system", label: "System", stack: '-apple-system, BlinkMacSystemFont, sans-serif' },
    { id: "mono", label: "Mono", stack: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace' },
  ];

  // faces worth offering if the machine happens to have them. checked, not
  // assumed — a css font-family that isn't installed fails silently, which is
  // the worst kind of setting.
  const CANDIDATES = [
    "Operator Mono", "MonoLisa", "Victor Mono",
    "gg sans", "Inter", "SF Pro Rounded", "SF Pro Text", "Helvetica Neue",
    "Avenir Next", "Lato", "Open Sans", "PT Serif", "Merriweather",
    "Optima", "Charter", "Iowan Old Style", "Palatino", "New York",
    "JetBrains Mono", "SF Mono", "Menlo", "Monaco",
  ];

  // measure a string in the face against a known-different fallback. if the
  // width moves, the face resolved; if it doesn't, it silently fell back.
  const probe = (function () {
    const span = document.createElement("span");
    span.textContent = "mmmmmmmmmmlliWWWW@%$";
    span.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;font-size:72px;white-space:nowrap;visibility:hidden";
    let base = null;
    return function (name) {
      if (!document.body) return false;
      document.body.appendChild(span);
      if (!base) {
        base = {};
        ["monospace", "serif", "sans-serif"].forEach((g) => {
          span.style.fontFamily = g;
          base[g] = span.offsetWidth;
        });
      }
      let found = false;
      for (const g of ["monospace", "serif", "sans-serif"]) {
        span.style.fontFamily = '"' + name + '",' + g;
        if (span.offsetWidth !== base[g]) { found = true; break; }
      }
      span.remove();
      return found;
    };
  })();

  Q.fontInstalled = probe;

  function current() {
    const want = Q.prefs().font || "obsidian";
    if (want === "custom") {
      const name = Q.prefs().fontCustom || "";
      return { id: "custom", label: name || "Custom",
               stack: '"' + name + '", -apple-system, BlinkMacSystemFont, sans-serif' };
    }
    return FONTS.find((f) => f.id === want) || FONTS[0];
  }

  function apply() {
    const f = current();
    document.documentElement.style.setProperty("--q-font", f.stack);
    document.body.classList.toggle("q-font-on", true);
    // a mono ui means code should not be swapped to a second mono
    document.body.classList.toggle("q-font-mono", /mono|Operator|MonoLisa/i.test(f.stack));
  }

  Q.font = { apply, list: FONTS, current };

  function pick(id, custom) {
    if (custom !== undefined) Q.setPref("fontCustom", custom);
    Q.setPref("font", id);
    apply();
    Q.ui.closeModal();
    Q.ui.toast("typeface: <b>" + Q.esc(current().label) + "</b>");
  }

  Q.command({
    id: "font", title: "Typeface", category: "View", keys: "mod+alt+f",
    run: () => {
      const cur = Q.prefs().font || "obsidian";
      const custom = Q.prefs().fontCustom || "";
      const wrap = Q.el("div", { class: "q-fontpick" });

      const preset = FONTS.map((f) =>
        '<div class="q-model' + (f.id === cur ? " sel" : "") + '" data-id="' + f.id +
        '" style="font-family:' + f.stack.replace(/"/g, "'") + '">' +
        Q.esc(f.label) + "</div>").join("");

      const installed = CANDIDATES.filter(probe);
      const detected = installed.map((n) =>
        '<div class="q-model' + (cur === "custom" && custom === n ? " sel" : "") +
        '" data-name="' + Q.esc(n) + '" style="font-family:\'' + n + '\'">' +
        Q.esc(n) + "</div>").join("");

      wrap.innerHTML =
        '<div class="q-fontsec">preset</div><div class="q-modellist">' + preset + "</div>" +
        '<div class="q-fontsec">installed on this mac · ' + installed.length + "</div>" +
        '<div class="q-modellist">' + detected + "</div>" +
        '<div class="q-fontsec">anything else</div>' +
        '<input class="q-input" id="q-font-custom" placeholder="exact family name, e.g. gg sans" value="' +
        Q.esc(cur === "custom" ? custom : "") + '">' +
        '<div class="q-fontnote" id="q-font-note"></div>';

      wrap.querySelectorAll(".q-model[data-id]").forEach((el) =>
        el.addEventListener("click", () => pick(el.dataset.id)));
      wrap.querySelectorAll(".q-model[data-name]").forEach((el) =>
        el.addEventListener("click", () => pick("custom", el.dataset.name)));

      const input = wrap.querySelector("#q-font-custom");
      const note = wrap.querySelector("#q-font-note");
      const check = () => {
        const v = input.value.trim();
        if (!v) { note.textContent = ""; note.className = "q-fontnote"; return; }
        const ok = probe(v);
        note.innerHTML = ok
          ? "found — <span style=\"font-family:'" + v.replace(/'/g, "") + "'\">the quick brown fox</span>"
          : "not installed on this mac";
        note.className = "q-fontnote " + (ok ? "ok" : "bad");
      };
      input.addEventListener("input", check);
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); if (input.value.trim()) pick("custom", input.value.trim()); }
      }, true);
      check();

      Q.ui.modal({ title: "Typeface", body: wrap, wide: true, buttons: [{ label: "Cancel" }] });
    },
  });

  apply();
})(window.Q);
