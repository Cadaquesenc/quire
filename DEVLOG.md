# devlog

what actually happened while building this, in the order it went wrong.

---

## 2026-09-03 · one sidebar, and files that aren't markdown

### the thing i was wrong about for an hour

i assumed the punctuation shortcuts worked. `⌘⌥-` and `⌘⌥=` for transparency,
`⌘⌥/` for source mode. they're in the key table in INTERNALS.md. which-key draws
them in the grid when you hold the modifiers.

the keymap builds the combo it looks up out of the keyboard event. it reads
`e.code` for letters and digits, deliberately, with a comment saying so:

> e.code is used for letters and digits so that a remapped or option-modified
> key still matches what the user pressed

everything that isn't a letter or a digit falls through to `e.key`.

hold option on macos and `e.key` for punctuation is not the key you pressed.
`-` arrives as `–`. `=` arrives as `≠`. `/` arrives as `÷`. `[` arrives as `“`.
so the lookup key was `mod+alt+–` and the table has `mod+alt+-`. three bindings
that never fired once, advertised in a grid that reads the same table the lookup
misses, so the grid was confidently listing keys that did nothing.

the comment is the tell. whoever wrote it already knew option rewrites `e.key`.
they fixed it for letters and digits and stopped one character short.

fix is a `CODE_BASE` map, 11 entries, so `Minus` `Equal` `Slash` `BracketLeft`
`BracketRight` `Backslash` resolve by physical key the way letters already did.
that also freed up `⌘⌥[`, `⌘⌥]` and `⌘⌥\` for the sidebar, which is what i
wanted them for in the first place.

honest caveat: this is read off the code path, not off a keystroke. i can't type
into that window without stealing focus from whoever is at the keyboard, so i
never pressed `⌘⌥-` and watched it fail. what i have is the fallthrough and the
author's own comment about the exact mechanism.

### the one that ate a command

i registered a command with `id: "sidebar"`. `30-editing.js` has had one under
that id since the start, for the host's own left sidebar. `Q.command` does

```js
if (!commands[spec.id]) order.push(spec.id);
commands[spec.id] = ...
```

a second claim on an id doesn't warn. it replaces.

the symptom was one number. the source has 109 commands. the selftest said 108.
"Toggle sidebar" was gone from the palette and nothing anywhere said a word.

the selftest already checked for two commands on one key. it did not check for
two commands on one id, which is the worse of the two: a duplicate key means one
of them still runs, a duplicate id means the first one no longer exists.
`Q.command` records collisions now and the selftest fails on them. mine is
`quireSidebar`. back to 109.

### the class that leaked into everything

the terminal's render did `body.classList.add("q-term-body")` on the panel body.
one shared element, five sections, nothing ever took the class back off.
`.q-term-body` is `display:flex; padding:0 !important; height:100%;
overflow:hidden`. so the first time you opened the terminal, the files list and
the tag cloud started rendering into a padding-free flex column that can't
scroll, and stayed that way for the rest of the session.

it's gone, but not because i removed the line. sections own their own element
now instead of sharing one, so there's nothing left to leak into.

### why .txt was the dangerous one

the file panel counted `.txt` and `.text` as markdown and opened them in the
editor.

this editor doesn't hold a document as text. it parses markdown into a node tree
and writes the file back out of that tree on save. that's the reason the parser
can't be swapped (minified, no source map) and it's also the reason a round trip
isn't one. `*ptr` is emphasis. a line starting with `#` is a heading. four spaces
of indent is a fence. save a `.js` file that went in that way and what lands on
disk is what the markdown writer thought your code meant.

what convinced me it isn't paranoia: the save path is `File.sync()`, and
everything under it goes through `getMarkdown()`, which serialises the tree.
there is no original buffer kept anywhere to fall back to. the only input to the
write is the parse. lose it in the parse and it is lost.

so nothing that isn't markdown goes near the editor now, `.txt` included.

### the viewer, and why it doesn't save

non-markdown text opens in a flat monospaced pane over the document area. line
numbers, a read-only badge, wrap, copy, and a hand-off to whatever owns the file
type. 302 lines of code, zero of which write anything.

it reads through `shellBig`, which pulls the file back in 42KB base64 chunks
because a pipe over 64KB deadlocks the handler and the editor just stops.
`shellBig` trimmed its output. for a file listing that's fine. for a file it's a
lie: `60-view.js` is 12,621 bytes, trimmed it's 12,620, and the sha goes from
`de2bb717` to `0ecc6c25` over one missing newline. a reader that quietly eats the
end of a file is one step away from a writer that does. `shellBig` takes
`{raw:true}` now and hands back the bytes as well as the text.

the selftest proves the read rather than asserting it. it opens `60-view.js` in
the pane, hands the pane's own string back to the shell as base64, hashes what
comes out the other side, and compares that to `shasum -a 256` of the file:

```
textview: ok · 302 lines, 302 rendered, sha matches disk
```

that's a proof about reading. it says nothing about writing, so the pane ships
read-only. i could have shipped editing on the strength of that hash and decided
not to. the utf-8 decoder turns bytes it can't read into U+FFFD and writing those
back destroys them. nothing in the round trip distinguishes CRLF from LF. and the
write would have to go back out through a shell whose stdout caps at 60,000
bytes. read-only is a guarantee i can actually make. byte-exact writing, for
arbitrary files, is not.

there's an escape hatch in the palette that opens the current file in the editor
anyway. it asks first, and the question says what it costs.

a second stage greps the viewer source for write calls and expects nothing. it
strips comments first, because the file talks about the very calls it must not
contain and a grep that matches its own warning proves nothing.

### the rail, and the strip it replaced

the panels were already in one container. the strip across the top only spelled
out the section you were already in, so four of the five tabs were bare icons
laid out sideways, sharing a row with the one label. that's a rail rotated 90
degrees and given less room.

so it's a rail now. vertical, on the window edge, section name on its own line,
five sections in it: files, backlinks, tags, git, terminal. a drag handle on the
inner edge, and it comes back on the section you left it on.

git had no panel at all before today. a status bar cell and three modals.

### what i decided against

no rail when the sidebar is closed. discord and vscode both keep theirs up, and
it costs 38px of editor forever, on a window already sharing its width with the
host's own left sidebar.

no syntax highlighting in the viewer, even though the host bundles CodeMirror and
it would have been close to free. a CodeMirror instance is an editor. the entire
point of that pane is that it isn't one, and a `<pre>` can't be typed into by
accident.

no attempt at a pty. every command is a separate non-interactive `bash -c`
through a handler written to run pandoc. that isn't fixable from this side.

### the build told me it had restarted the app

`./build.sh` quits the running copy before it replaces the bundle. it does that
with `osascript -e 'quit app id ...'`, waits up to 5 seconds, then carries on
regardless.

there was an unsaved Untitled document open, so the quit raised a save sheet and
came back with:

```
0:38: execution error: Quire got an error: User cancelled. (-128)
```

build.sh swallows that with `|| true` and installs over the live bundle anyway.
then `open -g` on an app that's already running does nothing at all. so i built,
launched, read the selftest and was reading the old code's answers.

the pid was 21648 before the build and 21648 after. `quireHealth` still said 102
commands while the source said 109. that's twice in one session that a count was
the only thing that noticed anything was wrong.

### what's verified and what isn't

22 selftest stages, all passing, against a real document in a real repo. 5 rail
buttons for 5 sections. the terminal keeps what's half-typed in it across a
section switch, which is the whole reason sections stopped being destroyed. 23
paths classified into editor / read-only / system. 109 commands, 33 keys, no
duplicate key and no duplicate id.

the layout is not verified. `screencapture` on a background window gives you the
last frame it painted, and macos stops the web view painting once the window is
occluded. 70 captures over 28 seconds while the suite drove the sidebar open and
shut: 58 of them byte-identical, not one showing the sidebar. so the sidebar and
the viewer are proven at the dom level and unproven as pixels.
