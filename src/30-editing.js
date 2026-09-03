"use strict";
// quire / editor commands
//
// every verb below already existed in the host runtime — File.editor.stylize,
// .tableEdit, .library and friends. what did not exist was any list of them.
// this is that list.

(function (Q) {
  const E = () => Q.ed();
  const c = (id, title, run, extra) =>
    Q.command(Object.assign({ id, title, run }, extra || {}));

  const FMT = "Format", BLK = "Block", TBL = "Table", NAV = "Navigate",
        VIEW = "View", FILE = "File", TEXT = "Text";

  // ---- inline formatting ----------------------------------------------------
  const style = (name) => () => E().stylize.toggleStyle(name);
  c("bold", "Bold", style("strong"), { category: FMT });
  c("italic", "Italic", style("em"), { category: FMT });
  c("strike", "Strikethrough", style("del"), { category: FMT });
  c("code", "Inline code", style("code"), { category: FMT });
  c("highlight", "Highlight", style("highlight"), { category: FMT, keys: "mod+shift+h" });
  c("underline", "Underline", style("underline"), { category: FMT });
  c("link", "Link", style("link"), { category: FMT });
  c("inlineMath", "Inline math", style("inline_math"), { category: FMT });
  c("clearStyle", "Clear formatting", () => E().stylize.clearStyle(), { category: FMT });

  // ---- blocks ---------------------------------------------------------------
  const block = (name) => () => E().stylize.changeBlock(name);
  c("h1", "Heading 1", block("header1"), { category: BLK, keys: "mod+alt+1" });
  c("h2", "Heading 2", block("header2"), { category: BLK, keys: "mod+alt+2" });
  c("h3", "Heading 3", block("header3"), { category: BLK, keys: "mod+alt+3" });
  c("h4", "Heading 4", block("header4"), { category: BLK, keys: "mod+alt+4" });
  c("h5", "Heading 5", block("header5"), { category: BLK });
  c("h6", "Heading 6", block("header6"), { category: BLK });
  c("para", "Paragraph", block("paragraph"), { category: BLK, keys: "mod+alt+0" });
  c("hUp", "Increase heading level", () => E().stylize.increaseHeaderLevel(), { category: BLK });
  c("hDown", "Decrease heading level", () => E().stylize.decreaseHeaderLevel(), { category: BLK });

  c("ul", "Bulleted list", () => E().stylize.toggleIndent("ul"), { category: BLK });
  c("ol", "Numbered list", () => E().stylize.toggleIndent("ol"), { category: BLK });
  c("task", "Task list", () => E().stylize.toggleIndent("tasklist"), { category: BLK, keys: "mod+shift+x" });
  c("quote", "Blockquote", () => E().stylize.toggleIndent("blockquote"), { category: BLK });
  c("fences", "Code block", () => E().stylize.toggleFences(), { category: BLK });
  c("mathBlock", "Math block", () => E().stylize.toggleMathBlock(), { category: BLK });
  c("hr", "Horizontal rule", () => E().stylize.insertBlock("hr"), { category: BLK });
  c("toc", "Table of contents", () => E().stylize.insertBlock("toc"), { category: BLK });
  c("meta", "YAML front matter", () => E().stylize.insertMetaBlock(), { category: BLK });

  // ---- tables ---------------------------------------------------------------
  c("tableInsert", "Insert table", () => E().tableEdit.insertTable(), { category: TBL, keys: "mod+alt+t" });
  c("rowAdd", "Add row", () => E().tableEdit.addRow(), { category: TBL });
  c("colAdd", "Add column", () => E().tableEdit.addCol(), { category: TBL });
  c("rowDel", "Delete row", () => E().tableEdit.deleteRow(), { category: TBL });
  c("colDel", "Delete column", () => E().tableEdit.deleteCol(), { category: TBL });
  c("tableFmt", "Reformat table", () => E().tableEdit.reformatTable(), { category: TBL });

  // ---- navigation -----------------------------------------------------------
  c("sidebar", "Toggle sidebar", () => E().library.toggleSidebar(), { category: NAV });
  c("fileTree", "Sidebar: file tree", () => E().library.togglePanel("file-tree"), { category: NAV });
  c("fileList", "Sidebar: file list", () => E().library.togglePanel("file-list"), { category: NAV });
  c("outline", "Sidebar: outline", () => E().library.togglePanel("outline"), { category: NAV, keys: "mod+shift+o" });
  c("reveal", "Reveal in file tree", () => E().library.revealInSidebar(), { category: NAV });
  c("newFile", "New file here", () => E().library.newFileCommand(), { category: FILE });
  c("newFolder", "New folder", () => E().library.newFolderCommand(), { category: FILE });
  c("quickOpen", "Quick open file", () => E().quickOpenPanel.show(), { category: NAV });
  c("find", "Find in document", () => E().searchPanel.showPanel(), { category: NAV });
  c("outlineExpand", "Outline: expand all", () => E().library.outline.expandAll(), { category: NAV });
  c("outlineCollapse", "Outline: collapse all", () => E().library.outline.collapseAll(), { category: NAV });

  // ---- view -----------------------------------------------------------------
  c("source", "Toggle source mode", () => window.File.toggleSourceMode(), { category: VIEW, keys: "mod+alt+/" });
  c("focus", "Toggle focus mode", () => E().toggleFocusMode(), { category: VIEW });
  c("typewriter", "Toggle typewriter mode", () => E().toggleTypeWriterMode(), { category: VIEW });

  c("prose", "Toggle prose typography", () => {
    const on = !Q.prefs().proseStyle;
    Q.setPref("proseStyle", on);
    document.body.classList.toggle("q-prose", on);
    Q.ui.toast("prose typography " + (on ? "on" : "off"));
  }, { category: VIEW, keys: "mod+alt+w" });

  c("statusBar", "Toggle status bar", () => {
    const on = !Q.prefs().statusBar;
    Q.setPref("statusBar", on);
    document.body.classList.toggle("q-status-on", on);
    Q.ui.redrawStatus();
  }, { category: VIEW });

  c("zen", "Zen mode", () => {
    const on = !document.body.classList.contains("q-zen");
    document.body.classList.toggle("q-zen", on);
    if (on) {
      try { if (!E().focusMode) E().toggleFocusMode(); } catch (_) {}
      try { E().library.toggleSidebar(false); } catch (_) {}
      Q.ui.hidePanel();
    }
    Q.ui.toast("zen " + (on ? "on" : "off"));
  }, { category: VIEW, keys: "mod+alt+z" });

  // ---- file -----------------------------------------------------------------
  c("save", "Save", () => Q.doc.save(), { category: FILE });
  c("exportHTML", "Export HTML", () => E().export.exportToHTML(), { category: FILE });
  c("finder", "Reveal in Finder", () => E().library.revealFileInFinderCommand(), { category: FILE });
  c("copyPath", "Copy full path", () => E().library.copyFullPathCommand(), { category: FILE });

  c("copyMarkdown", "Copy document as markdown", () => {
    const md = Q.doc.markdown();
    return Q.invoke("clipboard.write", md)
      .then(() => Q.ui.toast("copied " + md.length.toLocaleString() + " chars"));
  }, { category: FILE });

  // ---- text transforms ------------------------------------------------------
  // routed through undo.exeCommand so each one is a single undo step

  function transform(fn) {
    return function () {
      const sel = Q.doc.selection();
      if (!sel) return Q.ui.toast("nothing selected");
      Q.doc.replaceSelection(fn(sel));
    };
  }

  c("upper", "Uppercase selection", transform((s) => s.toUpperCase()), { category: TEXT, keys: "mod+alt+u" });
  c("lower", "Lowercase selection", transform((s) => s.toLowerCase()), { category: TEXT });
  c("title", "Title Case selection", transform((s) =>
    s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())), { category: TEXT });
  c("sortLines", "Sort selected lines", transform((s) =>
    s.split("\n").sort((a, b) => a.localeCompare(b)).join("\n")), { category: TEXT });
  c("sortLinesDesc", "Sort selected lines, reversed", transform((s) =>
    s.split("\n").sort((a, b) => b.localeCompare(a)).join("\n")), { category: TEXT });
  c("dedupe", "Remove duplicate lines", transform((s) => {
    const seen = new Set();
    return s.split("\n").filter((l) => !seen.has(l) && seen.add(l)).join("\n");
  }), { category: TEXT });
  c("trimLines", "Trim trailing whitespace", transform((s) =>
    s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n")), { category: TEXT });
  c("joinLines", "Join lines", transform((s) =>
    s.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")), { category: TEXT });
  c("slug", "Slugify selection", transform((s) =>
    s.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-|-$/g, "")),
    { category: TEXT });
  c("numberLines", "Number selected lines", transform((s) =>
    s.split("\n").map((l, i) => (i + 1) + ". " + l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")).join("\n")),
    { category: TEXT });
  c("bulletLines", "Bullet selected lines", transform((s) =>
    s.split("\n").map((l) => l.trim() ? "- " + l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "") : l).join("\n")),
    { category: TEXT });
  c("tableFromLines", "Selection to table", transform((s) => {
    const rows = s.trim().split("\n").map((l) => l.split(/\t|\s*\|\s*|\s{2,}|,\s*/).filter((x) => x !== ""));
    if (!rows.length) return s;
    const n = Math.max(...rows.map((r) => r.length));
    const pad = (r) => r.concat(Array(n - r.length).fill(""));
    const line = (r) => "| " + pad(r).join(" | ") + " |";
    return [line(rows[0]), "|" + Array(n).fill(" --- ").join("|") + "|"]
      .concat(rows.slice(1).map(line)).join("\n");
  }), { category: TEXT });

  // ---- document statistics --------------------------------------------------
  c("stats", "Document statistics", () => {
    const s = Q.stats();
    Q.ui.modal({
      title: "Statistics",
      body:
        '<table class="q-stats">' +
        [["Words", s.words], ["Characters", s.chars], ["Characters, no spaces", s.charsNoSpace],
         ["Lines", s.lines], ["Paragraphs", s.paras], ["Headings", s.headings],
         ["Links", s.links], ["Images", s.images], ["Code blocks", s.code],
         ["Tasks done", s.tasksDone + " / " + s.tasks],
         ["Reading time", "~" + s.minutes + " min"]]
          .map(([k, v]) => "<tr><td>" + k + "</td><td>" + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "</td></tr>")
          .join("") + "</table>",
      buttons: [{ label: "Done", primary: true }],
    });
  }, { category: FILE, keys: "mod+alt+s" });

  Q.stats = function () {
    const md = Q.doc.markdown();
    const words = (md.trim().match(/[^\s]+/g) || []).length;
    const wpm = Q.opt().wordsPerMinute || 200;
    const tasks = (md.match(/^\s*[-*+]\s+\[[ xX]\]/gm) || []).length;
    return {
      words,
      chars: md.length,
      charsNoSpace: md.replace(/\s/g, "").length,
      lines: md.split("\n").length,
      paras: md.split(/\n\s*\n/).filter((p) => p.trim()).length,
      headings: (md.match(/^#{1,6}\s/gm) || []).length,
      links: (md.match(/\[[^\]]*\]\([^)]*\)/g) || []).length,
      images: (md.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length,
      code: ((md.match(/^```/gm) || []).length / 2) | 0,
      tasks,
      tasksDone: (md.match(/^\s*[-*+]\s+\[[xX]\]/gm) || []).length,
      minutes: Math.max(1, Math.round(words / wpm)),
    };
  };
})(window.Q);
