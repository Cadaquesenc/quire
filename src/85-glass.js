"use strict";
// quire / glass
//
// the native half of this lives in native/quire-glass: it makes the window
// non-opaque, stops the web view painting its own background, and sets the blur
// radius behind the glass.
//
// the tint itself is deliberately on this side. the page paints it, so opacity
// is a css variable that can change live without touching native code or
// restarting anything.

(function (Q) {
  const DEFAULTS = { glass: true, glassAlpha: 0.65, glassTint: "28,28,28" };

  function conf() {
    const p = Q.prefs();
    return {
      on: p.glass === undefined ? DEFAULTS.glass : p.glass,
      alpha: p.glassAlpha === undefined ? DEFAULTS.glassAlpha : p.glassAlpha,
      tint: p.glassTint || DEFAULTS.glassTint,
    };
  }

  function apply() {
    const c = conf();
    const p = Q.prefs();
    document.body.classList.toggle("q-theme", p.theme === undefined ? true : !!p.theme);
    document.body.classList.toggle("q-glass", !!c.on);
    document.documentElement.style.setProperty("--q-glass-alpha", String(c.alpha));
    document.documentElement.style.setProperty("--q-glass-tint", c.tint);
  }

  Q.glass = { apply, conf };

  Q.command({
    id: "glass", title: "Toggle transparency", category: "View", keys: "mod+alt+y",
    run: () => {
      Q.setPref("glass", !conf().on);
      apply();
      Q.ui.toast("transparency " + (conf().on ? "on" : "off"));
    },
  });

  Q.command({
    id: "theme", title: "Toggle the Quire palette", category: "View",
    run: () => {
      const p = Q.prefs();
      Q.setPref("theme", p.theme === undefined ? false : !p.theme);
      apply();
      Q.ui.toast("quire palette " + (Q.prefs().theme ? "on" : "off"));
    },
  });

  Q.command({
    id: "glassOpacity", title: "Window opacity…", category: "View",
    run: () => {
      const c = conf();
      return Q.ui.prompt("Opacity — 0 is clear, 1 is solid", String(c.alpha), "0.65").then((v) => {
        if (v === null) return;
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 1) return Q.ui.error("give a number between 0 and 1");
        Q.setPref("glassAlpha", n);
        if (!conf().on) Q.setPref("glass", true);
        apply();
        Q.ui.toast("opacity <b>" + n + "</b>");
      });
    },
  });

  // nudging is more useful than typing a number
  const step = (d) => () => {
    const c = conf();
    const n = Math.min(1, Math.max(0.15, Math.round((c.alpha + d) * 100) / 100));
    Q.setPref("glassAlpha", n);
    if (!conf().on) Q.setPref("glass", true);
    apply();
    Q.ui.toast("opacity <b>" + n + "</b>");
  };
  Q.command({ id: "glassMore", title: "More transparent", category: "View", keys: "mod+alt+-", run: step(-0.05) });
  Q.command({ id: "glassLess", title: "Less transparent", category: "View", keys: "mod+alt+=", run: step(0.05) });

  apply();
  Q.on("doc", apply);
})(window.Q);
