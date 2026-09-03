"use strict";
// quire / command registry and keymap
//
// there is no registerCommand anywhere in the host bundle. its menus are native
// NSMenu items whose actions are hardcoded javascript strings the binary evals,
// so nothing on the js side ever knew what commands existed. this file is that
// missing registry: one table every feature adds to, which the palette reads
// and the keymap binds against.

(function (Q) {
  const commands = {};
  const order = [];

  Q.command = function (spec) {
    if (!spec || !spec.id) return;
    if (!commands[spec.id]) order.push(spec.id);
    commands[spec.id] = Object.assign({ category: "Editor", when: null }, spec);
    if (spec.keys) Q.keys.bind(spec.keys, spec.id, true);
    return spec.id;
  };

  Q.commands = () => order.map((id) => commands[id]).filter(Boolean);
  Q.getCommand = (id) => commands[id];

  Q.run = function (id) {
    const c = commands[id];
    if (!c) return Q.warn("no such command:", id);
    try {
      const r = c.run();
      if (r && r.catch) r.catch((e) => { Q.warn(id, e); Q.ui.error(id + ": " + e.message); });
      return r;
    } catch (e) {
      Q.warn(id, e);
      Q.ui.error(id + ": " + e.message);
    }
  };

  // ---- keymap ---------------------------------------------------------------
  //
  // the host cannot bind a shortcut on macos at all. its own keybinding path is
  // guarded by `if (File.isNode)` and there is no node here, so the only stock
  // route is System Settings matching on menu titles. this is the replacement:
  // an editable table, persisted with the rest of our preferences.

  const KEY_PREF = "quireKeymap";
  const defaults = {};      // filled by each command's `keys`
  let userMap = {};

  try {
    const raw = localStorage.getItem(KEY_PREF);
    if (raw) userMap = JSON.parse(raw);
  } catch (_) {}

  const keys = (Q.keys = {});

  keys.bind = function (combo, id, isDefault) {
    combo = keys.normalize(combo);
    if (isDefault) { defaults[combo] = id; return; }
    userMap[combo] = id;
    try { localStorage.setItem(KEY_PREF, JSON.stringify(userMap)); } catch (_) {}
    Q.set(KEY_PREF, JSON.stringify(userMap));
  };

  keys.unbind = function (combo) {
    combo = keys.normalize(combo);
    userMap[combo] = null;      // an explicit null masks a default
    try { localStorage.setItem(KEY_PREF, JSON.stringify(userMap)); } catch (_) {}
  };

  keys.normalize = function (combo) {
    const parts = String(combo).toLowerCase().split("+").map((s) => s.trim());
    const mods = { mod: 0, ctrl: 0, alt: 0, shift: 0 };
    let base = "";
    parts.forEach((p) => {
      if (p === "cmd" || p === "meta" || p === "mod") mods.mod = 1;
      else if (p === "ctrl" || p === "control") mods.ctrl = 1;
      else if (p === "alt" || p === "opt" || p === "option") mods.alt = 1;
      else if (p === "shift") mods.shift = 1;
      else base = p;
    });
    const out = [];
    if (mods.mod) out.push("mod");
    if (mods.ctrl) out.push("ctrl");
    if (mods.alt) out.push("alt");
    if (mods.shift) out.push("shift");
    out.push(base);
    return out.join("+");
  };

  keys.lookup = function (combo) {
    if (Object.prototype.hasOwnProperty.call(userMap, combo)) return userMap[combo];
    return defaults[combo] || null;
  };

  keys.all = function () {
    const merged = Object.assign({}, defaults);
    for (const k in userMap) {
      if (userMap[k] === null) delete merged[k];
      else merged[k] = userMap[k];
    }
    return merged;
  };

  keys.forCommand = function (id) {
    const all = keys.all();
    for (const k in all) if (all[k] === id) return k;
    return "";
  };

  const GLYPH = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
  keys.pretty = function (combo) {
    if (!combo) return "";
    const parts = combo.split("+");
    const base = parts.pop();
    const label = { escape: "esc", enter: "↩", " ": "space", arrowup: "↑", arrowdown: "↓",
                    arrowleft: "←", arrowright: "→", backspace: "⌫", tab: "⇥" }[base] || base.toUpperCase();
    return parts.map((p) => GLYPH[p] || p).join("") + label;
  };

  // the combo for an event. e.code is used for letters and digits so that a
  // remapped or option-modified key still matches what the user pressed.
  function comboOf(e) {
    const k = (e.key || "").toLowerCase();
    if (k === "meta" || k === "control" || k === "alt" || k === "shift") return null;
    const p = [];
    if (e.metaKey) p.push("mod");
    if (e.ctrlKey) p.push("ctrl");
    if (e.altKey) p.push("alt");
    if (e.shiftKey) p.push("shift");
    let base = k;
    const d = /^Digit(\d)$/.exec(e.code || "");
    const l = /^Key([A-Z])$/.exec(e.code || "");
    if (d) base = d[1];
    else if (l) base = l[1].toLowerCase();
    p.push(base);
    return p.join("+");
  }

  document.addEventListener("keydown", function (e) {
    const combo = comboOf(e);
    if (!combo) return;
    const id = keys.lookup(combo);
    if (!id) return;
    const c = commands[id];
    if (!c) return;
    if (c.when && !c.when()) return;
    e.preventDefault();
    e.stopPropagation();
    Q.run(id);
  }, true);
})(window.Q);
