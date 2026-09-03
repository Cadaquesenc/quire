"use strict";
// quire / the frontmatter card
//
// every sticky note this app makes carries yaml at the top: which claude code
// session was in front, that session's cwd, the window title it came from, when
// it was written, and how the session was resolved. that is provenance and it is
// worth keeping. eight lines of raw yaml above the two lines you actually wrote
// is not worth looking at.
//
// so the block gets drawn as a card. three things make that safe:
//
// 1. **nothing is inserted into `#write`.** the card is a fixed overlay
//    positioned over the block's own rectangle, the same trick the run buttons
//    use, for the same reason: anything put inside the document eventually gets
//    handed to the markdown writer to serialise, and this editor writes the file
//    out of its node tree rather than out of the text you typed.
// 2. **the raw block is still the only thing that gets saved.** it goes
//    transparent and lends its height to the card. it is still in the document,
//    still selectable, still what `getMarkdown()` reads.
// 3. **the caret wins.** click into it and the card steps out of the way and the
//    yaml comes back, because a card you cannot edit is a wall.
//
// the host renders frontmatter as `<pre mdtype="meta_block" class="md-meta-block">`
// holding the yaml without its `---` fences, and base.css paints that pre `#ccc`,
// which is a light grey slab across the top of a dark document. that goes too,
// card or no card.

(function (Q) {
  const MAX_ROWS = 8;

  // ---- reading it ------------------------------------------------------------
  //
  // top level `key: value` only, which is all any frontmatter this app writes
  // has in it. a nested block or a list is left as its own line and shown as
  // typed rather than half-parsed into something it isn't.

  function parse(text) {
    const out = [];
    String(text == null ? "" : text).split("\n").forEach((line) => {
      if (!line.trim() || /^-{3,}\s*$/.test(line)) return;
      const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) return;
      out.push({ key: m[1], value: unquote(m[2]) });
    });
    return out;
  }

  // the writer quotes every value, because a window title is arbitrary text and
  // a bare colon in one ends the value early
  function unquote(v) {
    const s = String(v == null ? "" : v).trim();
    if (s.length > 1 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return s;
  }

  const home = () => Q.homeNow() || "";
  const tilde = (p) => {
    const h = home();
    return h && String(p).indexOf(h) === 0 ? "~" + String(p).slice(h.length) : String(p);
  };

  // a timestamp is only interesting as a distance from now
  function whenText(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return iso || "";
    const secs = (Date.now() - t) / 1000;
    if (secs < 0) return Q.date(new Date(t));
    return Q.since(secs);
  }

  // ---- what a row says -------------------------------------------------------

  // keys that are said in the header rather than repeated as a row
  const HEADER_KEYS = { kind: 1, created: 1, resolved: 1 };

  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

  function display(key, value) {
    if (!value) return { text: "not resolved", mute: true };
    switch (key) {
      case "session":  return { text: value.slice(0, 8) };
      case "cwd":      return { text: tilde(value) };
      default:
        // a timestamp in a row is the same thing as a timestamp in the header
        // and gets the same treatment. nobody reads an offset-aware iso string.
        return { text: ISO.test(value) ? whenText(value) : value };
    }
  }

  function model(pairs) {
    const map = {};
    pairs.forEach((p) => { if (map[p.key] === undefined) map[p.key] = p.value; });
    const sticky = map.kind === "sticky";
    const rows = pairs
      .filter((p) => !HEADER_KEYS[p.key])
      .slice(0, MAX_ROWS)
      .map((p) => Object.assign({ key: p.key }, display(p.key, p.value)));
    return {
      sticky: sticky,
      icon: sticky ? "pencil" : "list",
      title: sticky ? "sticky note" : "frontmatter",
      when: map.created ? whenText(map.created) : "",
      // how the session was worked out. a note never claims to know something it
      // guessed, so the route is shown rather than dropped.
      via: map.resolved || "",
      rows: rows,
    };
  }

  function html(m) {
    return '<div class="q-fm-head">' +
      Q.icon(m.icon, 12) +
      "<span>" + Q.esc(m.title) + "</span>" +
      (m.via ? '<span class="q-badge">' + Q.esc(m.via) + "</span>" : "") +
      (m.when ? '<span class="q-fm-when">' + Q.esc(m.when) + "</span>" : "") +
      "</div>" +
      (m.rows.length
        ? '<div class="q-fm-rows">' + m.rows.map((r) =>
            '<div class="q-fm-row"><span class="q-fm-k">' + Q.esc(r.key) + "</span>" +
            '<span class="q-fm-v' + (r.mute ? " mute" : "") + '">' + Q.esc(r.text) +
            "</span></div>").join("") + "</div>"
        : "");
  }

  // ---- drawing it ------------------------------------------------------------

  let layer = null, card = null, lastKey = "", lastH = 0;

  function ensureLayer() {
    if (layer) return layer;
    layer = Q.el("div", { id: "q-fm-layer" });
    card = Q.el("div", { class: "q-fm-card" });
    layer.appendChild(card);
    document.body.appendChild(layer);
    return layer;
  }

  function blockEl() {
    const write = document.getElementById("write");
    return write ? write.querySelector("pre.md-meta-block, [mdtype='meta_block']") : null;
  }

  // is the caret inside the block? both answers are asked for, because the host
  // only sets md-focus on some block types and a selection can be in a node the
  // class never lands on.
  function editing(el) {
    if (!el) return false;
    if (el.classList.contains("md-focus")) return true;
    try {
      const sel = window.getSelection();
      if (sel && sel.anchorNode && el.contains(sel.anchorNode)) return true;
    } catch (_) {}
    return false;
  }

  function off() {
    document.body.classList.remove("q-fm-on", "q-fm-edit");
    document.documentElement.style.removeProperty("--q-fm-h");
    if (card) card.style.display = "none";
    lastKey = ""; lastH = 0;
  }

  function draw() {
    // one command turns the card off for good, and it has to survive the next
    // scroll frame or it is not a toggle, it is a flicker
    if (document.body.classList.contains("q-fm-raw")) return off();
    const el = blockEl();
    if (!el) return off();

    const text = el.textContent || "";
    const pairs = parse(text);
    if (!pairs.length) return off();

    ensureLayer();
    document.body.classList.add("q-fm-on");

    const edit = editing(el);
    document.body.classList.toggle("q-fm-edit", edit);
    if (edit) { card.style.display = "none"; return; }

    // only rebuild the dom when the yaml actually changed. this runs on every
    // scroll frame, and rewriting the card each time is a layout thrash on the
    // one element that sits over the top of the document.
    const key = text + "|" + document.body.classList.contains("q-sticky");
    if (key !== lastKey) {
      lastKey = key;
      card.innerHTML = html(model(pairs));
      lastH = 0;
    }

    // the card is capped rather than stretched. the block runs the full width of
    // the text column and four short key/value pairs across 900px is a header
    // with a hole in it. the block underneath is transparent, so the part of it
    // the card does not cover is not there to see.
    const r = el.getBoundingClientRect();
    card.style.display = "";
    card.style.left = Math.round(r.left) + "px";
    card.style.width = Math.round(Math.min(r.width, 620)) + "px";
    card.style.top = Math.round(r.top) + "px";

    // the block gives up its height to the card. measured rather than guessed,
    // because the rows wrap and how many lines they wrap onto depends on how
    // wide the window is.
    const h = card.offsetHeight;
    if (h && Math.abs(h - lastH) > 1) {
      lastH = h;
      document.documentElement.style.setProperty("--q-fm-h", h + "px");
    }
  }

  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; try { draw(); } catch (_) {} });
  }

  function wire() {
    const write = document.getElementById("write");
    const content = document.querySelector("content");
    if (!write || !content) return setTimeout(wire, 200);
    content.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    write.addEventListener("input", schedule, true);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("mouseup", schedule, true);
    Q.on("doc", () => setTimeout(schedule, 300));
    Q.on("sidebar", () => setTimeout(schedule, 220));
    setTimeout(schedule, 400);
    setTimeout(schedule, 1200);
    // $HOME comes back over the shell. until it does, tilde() has nothing to
    // shorten a cwd against and the card prints the full /Users/... path.
    Q.home().then(schedule, () => {});
  }

  Q.frontmatter = { parse, model, html, draw, schedule, blockEl };

  Q.command({
    id: "frontmatterRaw", title: "Show the frontmatter as yaml", category: "View",
    run: () => {
      const el = blockEl();
      if (!el) return Q.ui.toast("this document has no frontmatter");
      const on = document.body.classList.toggle("q-fm-raw");
      if (on) { off(); Q.ui.toast("frontmatter shown as yaml"); }
      else { schedule(); Q.ui.toast("frontmatter shown as a card"); }
    },
  });

  wire();
})(window.Q);
