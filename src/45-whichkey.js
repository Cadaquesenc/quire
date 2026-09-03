"use strict";
// quire / which-key
//
// lazyvim's best idea: hold the leader and it shows you what the next key does,
// instead of making you remember. there is no leader key here, so the modifier
// pair is the leader, hold ⌘⌥ and the grid appears; press the third key and it
// runs; let go and it never happened.
//
// the delay matters. show it instantly and it flashes on every real shortcut you
// already know; wait too long and it stops being an answer to hesitation.

(function (Q) {
  const DELAY = 420;
  const PREFIX = "mod+alt+";

  let timer = null, el = null, armed = false, consumed = false;

  function bindings() {
    const all = Q.keys.all();
    return Object.keys(all)
      .filter((k) => k.indexOf(PREFIX) === 0)
      .map((k) => ({ key: k.slice(PREFIX.length), id: all[k], cmd: Q.getCommand(all[k]) }))
      .filter((b) => b.cmd)
      .sort((a, b) => a.cmd.category.localeCompare(b.cmd.category) || a.key.localeCompare(b.key));
  }

  function show() {
    if (el) return;
    const rows = bindings();
    if (!rows.length) return;

    // group by the command's own category, which is already how the palette
    // organises itself, no second taxonomy to keep in sync
    const groups = {};
    rows.forEach((b) => (groups[b.cmd.category] = groups[b.cmd.category] || []).push(b));

    el = Q.el("div", { id: "q-whichkey" },
      '<div class="q-wk-box">' +
      '<div class="q-wk-title">⌘⌥<span>then…</span></div>' +
      '<div class="q-wk-cols">' +
      Object.keys(groups).sort().map((cat) =>
        '<div class="q-wk-group"><div class="q-wk-cat">' + Q.esc(cat) + "</div>" +
        groups[cat].map((b) =>
          '<div class="q-wk-row"><kbd>' + Q.esc(b.key.toUpperCase()) + "</kbd>" +
          "<span>" + Q.esc(b.cmd.title) + "</span></div>").join("") +
        "</div>").join("") +
      "</div></div>");
    document.body.appendChild(el);
    requestAnimationFrame(() => el && el.classList.add("q-open"));
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    armed = false;
    if (el) { el.remove(); el = null; }
  }

  Q.whichKey = { show, hide };

  document.addEventListener("keydown", (e) => {
    const key = (e.key || "").toLowerCase();
    const holdingBoth = e.metaKey && e.altKey;

    // a third key was pressed: the grid did its job, or was never needed
    if (holdingBoth && key !== "meta" && key !== "alt") {
      consumed = true;
      hide();
      return;
    }
    if (holdingBoth && !armed && !consumed) {
      armed = true;
      timer = setTimeout(show, DELAY);
    }
  }, true);

  document.addEventListener("keyup", (e) => {
    if (!e.metaKey || !e.altKey) { hide(); consumed = false; }
  }, true);

  window.addEventListener("blur", () => { hide(); consumed = false; });

  Q.command({
    id: "whichkey", title: "Show the shortcut map", category: "Quire",
    run: () => (el ? hide() : show()),
  });
})(window.Q);
