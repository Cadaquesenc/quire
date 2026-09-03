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

---

## 2026-09-03 · the save bug was not the bug

pass two. live reload, a guard on the save, sticky notes, and one key that pulls
the last command into the document.

### the thing i was wrong about, and the measurement that killed it

i started this pass believing the editor mangles files on its own. it is written
down twice, in INTERNALS and in yesterday's entry: the app does not hold a
document as text, it parses markdown into a node tree and serialises the tree
back out on save, so a round trip is not one. `.txt` is kept out of the editor
for exactly that reason and that decision still stands.

so the save guard was built to measure the damage. serialise the buffer the
instant a file loads, before a keystroke, diff that against the bytes on disk,
and whatever falls out is what the writer will do to you unasked. cheap, and the
answer is known at load time, so the decision at save time is a boolean.

then i measured it. 43 lines written specifically to break it: setext headings,
a ragged table, a four-space indented code block, `+` bullets, `1)` numbering,
`___triple underscores___`, escaped stars, a two-space hard break, raw html, a
reference link, tasks.

**1053 bytes in. 1053 bytes out. zero lines changed.**

the writer keeps the source of every block nobody has been inside. open a file,
save it untouched, and it is byte identical. the guard i had written would have
sat there for the rest of its life reporting zero.

so what is the bug the owner reported as "when saving it goes a bit haywire"?
almost certainly the other one: an agent rewrites the file, the buffer is ten
minutes stale, and the next save puts the old version back over it. that is
problem one, not problem two, and it does not need a parser to happen.

the guard got rebuilt around what is actually true: **a save may only change what
you changed**. the line ranges you edit are tracked while you type, on the same
serialisation the status bar already asks for. at save time the bytes about to be
written are compared against the bytes on disk, and anything reaching outside the
ranges you touched holds the write.

four things hold it now: the file moved on disk under unsaved edits, the save
reaches past what you edited, one tick of typing moved eight lines when a
keystroke moves one, or the file genuinely did not round trip on the way in. the
last one is still measured, because it is free and because it was worth knowing
the answer is normally zero.

honest limit, and it is a real one: an edit tick folds your keystroke and
anything else that moved in the same 400ms into one range, so a reformat landing
on the same tick as a keystroke is inside the hull and passes. that case is what
the eight-line rule is for. and the hull is contiguous, not a union, so editing
line 5 and line 300 leaves everything between them unguarded. that is the wrong
answer in the safe direction: it warns less, never more.

### where a save actually comes from, and how i proved it

the write goes through one function. `bridge.registerHandler("File.getContent")`
is the handler native calls to ask javascript for the bytes, and its callback is
the file. that is the whole interception surface, and it is the last point on
this side that sees the content.

the handler has to be replaced rather than wrapped, because `registerHandler`
writes into a closure-local map in index.html with no getter. so the host's body
is reproduced faithfully and a decision is added. the decision is synchronous by
construction, no promise and no shell, because a handler that waits here leaves
native waiting for content mid-save, which is worse than the bug.

"cancel" is: hand back the bytes the file already has. a save that writes the
file's own content over itself changes nothing, and your edits stay in the
window.

which left the question that mattered: **does native actually use what the hook
returns, or does it write from a copy it already has?** i could not press ⌘S. it
is an NSDocument, the menu item goes straight to native, and there is no
javascript entry point to the save at all.

first attempt: `autosavesInPlace` is in the binary, so mark the document dirty
from javascript and wait for autosave. `File.sync()` then
`updateChangeCount(NSChangeDone)`, poll the file.

45 seconds. nothing. autosave never fired.

second attempt, and this one is decisive. arm three things and quit the app:
copy the file's bytes aside, put a marker in the buffer that is not on disk, and
make the hook return a sentinel that is neither. then `quit app id`, and read the
file. three outcomes, all distinguishable:

```
the sentinel   native uses what File.getContent returns
the marker     a write happened and went round the hook
neither        quitting does not write at all
```

the file came back 26 bytes long, containing exactly `quire-save-probe-sentinel`.
the hook is authoritative. cancel really cancels.

it also answers a thing from yesterday. the save panel that deadlocked the last
build was an *Untitled* document. a document with a path is written silently on
quit, no sheet, no question.

### the dirty dot that had never once appeared

`90-boot.js` read `window.File.isEdited` to decide whether to draw the dot next
to the filename. there is no such property. grep the host bundle for `isEdited`
and you get `isDocumentEdited`, a method, and nothing else. so the expression was
`!!undefined` on every build since it was written and the dot has never rendered.

it is worse than a missing dot, because the reload guard needs the same answer:
reloading a file over unsaved edits is exactly the thing it exists to prevent.

and `isDocumentEdited()` on macos is `bridge.callSync`, which is
`prompt("__bridge__", ...)`, the same window.prompt the host hijacked and whose
else branch returns null. if that channel ever answers null the host reads it as
"not edited". so the guard does not trust it alone: it also compares the
serialisation now against the serialisation at load. if they differ there are
edits in the buffer, whatever the document says about itself.

### the session behind a sticky, and the permission that is not there

stickies carry which claude code session was in front when you made them. the
resolver was ported from the scratchpad rather than rewritten, and the four
mistakes already burned into its comments stayed burned in: match the `aiTitle`
record and not a substring, read `cwd` and `sessionId` out of the transcript and
never off the directory name, filter the window list by owner, and `sed -n 1p`
instead of `head -1` because pipefail plus head is exit 141.

from my shell it resolves perfectly. `qsession` printed
`957a300b-a2d1-4643-9bc1-7e65192bb584` for the window that is driving this, which
is the same uuid as the scratchpad path it is writing into.

from inside quire it finds **zero terminal windows**.

`kCGWindowName` needs Screen Recording permission. my terminal has it. quire does
not, and asking for it means a system dialog in front of whoever is typing, which
is not a thing this app is going to do for a sticky note. so the resolver falls
through to newest-writer-wins, which is the fallback the plan already allowed for
and which is the right answer anyway: the session that just asked for a note is
the session that wrote last. the frontmatter records which route was used, so a
note never claims to know something it guessed.

### floating a window from a dylib, and how to check it without touching it

`NSWindow.level` and the window frame are AppKit. there is no node here, so
javascript cannot reach either. the glass dylib is already walking every window
twice a second, so it does the rest: if a window's `representedFilename` is under
`~/.quire/stickies`, it goes to `NSFloatingWindowLevel`, joins all spaces, and
gets a 380 by 320 frame once and never again, so a note you drag somewhere stays
where you dragged it.

`representedFilename` and not the title, because the title is whatever the host
feels like putting there and the path is the document.

checking it is the good part. `kCGWindowLayer` in the window list *is* the window
level as the window server sees it, and `kCGWindowBounds` is the frame. so
`qwindows` grew two columns and the check is a grep:

```
25937  Quire  sticky-2026-09-03-060000.md  3  988,40,380,320
25934  Quire  quire-scratch.md             0  0,8,1400,865
```

layer 3, 380 wide, and the ordinary document window untouched at layer 0. no
focus stolen, no screenshot needed to believe it.

one snag worth writing down: the first capture of a sticky had a dark unpainted
strip across the top right of the titlebar. the dylib resizes a window that is
still in the background, and a background window is not asked to repaint, so the
titlebar kept a strip of the size it used to be. `setFrame:display:` was already
passing YES; the fix was an explicit `display` after it.

### the modal i built the whole pass to avoid, raised by the host, at me

the live reload worked first try. wrote over the open file from a shell, waited
eight seconds, photographed the window: new content on screen, toast in the
corner saying `reloaded from disk`.

and a dialog in the middle of it.

> File content is changed by external applications. Reload content from disk ?
> You could undo this operation later via `Edit` → `Undo`.

that is the host's own external-change handler. it is one line:

```js
File.isDocumentEdited() && !confirm("File content is changed…")
  || bridge.callHandler("document.refreshContentFromDisk")
```

and the reason it fired is my fault twice over. `File.reloadContent` registers an
undo command, which marks the NSDocument dirty. so my reload of a *clean* buffer
left the titlebar saying Edited, and then the host's presenter came along, read
that flag, and asked the question. a modal, over the document, raised by the app
at itself, in the exact scenario this pass exists for.

two fixes. `updateChangeCount(NSChangeCleared)` right after the reload, so a file
nobody edited is not marked edited. and the confirm goes away: there is **exactly
one** `confirm(` in the entire host bundle and this is it, so it is answered
"keep what is in the buffer" without ever being drawn, and quire's bar handles
the change instead. one call site is what makes that safe rather than reckless.

the question it asked was the wrong one anyway. reload or nothing, no way to see
what changed, no way to keep both.

### the conflict path, end to end, on a real document

the last stage is the whole pass in one: dirty the buffer without touching disk,
have a shell write the file the way an agent would, wait for the poller.

```
conflict: ok · poller caught it, bar conflict, buffer kept my edit,
          a save would write their bytes, not mine
```

that is the bug the owner reported, reproduced deliberately and then not
happening. the file came back byte identical afterwards.

### the build told me it had restarted the app, again

yesterday's entry ends with `build.sh` swallowing an osascript failure and
installing over a live bundle. it was still doing it. now it asks nicely, waits
five seconds, sends TERM, waits four more, and if the process is still there it
**stops** rather than installing over it. an install over a running app is
silent, and `open` on an already-running app does nothing, so the failure mode is
a build that looks fine and changes nothing.

`--run` uses `open -g` now too. a build should never take the keyboard.

### small things that cost real time

`$TMPDIR` is `/var/folders/...`, `/var` is a symlink to `/private/var`, and
`File.filePath` reports the resolved one. the save probe compares the open
document's path against the scratch directory before it will touch anything, and
it refused its own file over exactly that. `cd "$TMPDIR" && pwd -P`.

the fence a grabbed command goes into has to be longer than the longest run of
backticks inside it. the test grabs a command whose output *contains* ```` ``` ````
so the block has to open with four, and the naive way of counting fence-shaped
lines in the result finds three of them, not two.

### what i decided against

no rewriting of the lines the writer changes. a surgical save that keeps your
edits and puts everybody else's lines back is possible now that the hook is
proven authoritative, and it is a bad idea: a bad merge is worse than a warning,
and the warning already tells you exactly what it was going to do.

no scraping a real terminal for the grab. the last command in ghostty lives in a
pty this app has no handle on, and the routes to it are applescript at
Terminal.app, which steals focus, or a screenshot and OCR. so the terminal it
reads is quire's own, and there is a companion command that runs something and
grabs it in one step, which is what you want most of the time anyway.

no explicit file writing for stickies. they save through the same NSDocument
everything else does, which given that autosave never fired in 45 seconds means
they save when the window closes or the app quits, not as you type. that is worse
than advertised and it is the one thing in this pass i would fix first.

no asking for Screen Recording. the window-title route stays in the code because
it works from a terminal and because it is how you would resolve a session from
outside the app, but nothing prompts for it.

### verified, and what is not

34 selftest stages, 13 of them new, all passing, against a scratch document
opened deliberately so nothing in a repo was ever open in the editor.

proven with numbers rather than asserted: a file read back through the shell
hashes the same as `shasum` on disk. a file that changes size inside one second
is still detected, because size is checked as well as mtime. `diff` on identical
input gives 0 changed lines and on two edits plus an addition gives 3. the save
hook answers synchronously twice, hands back the buffer unchanged when it is
happy, and hands back a substitute when it is not. a clean save is silent, a one
line edit is silent, sixteen lines moving in one tick is held, and a file that
moved on disk is held with its own bytes handed back. the host's confirm answers
without drawing. an external rewrite over a clean buffer reloads in place with no
dialog and the titlebar does not say Edited: 200 words became 49 without anybody
touching the window. the sticky's frontmatter
keeps a colon inside a quoted window title. both symlink pointers resolve to the
note that made them.

not verified: the guard has never held a save that a person actually pressed ⌘S
for. everything about the hook is proven, including that native uses its return
value, but the path from a keystroke to that handler is inference. the eight-line
rule has never fired on a real reformat, because i could not make the writer do
one. and the sticky's save-as-you-type is debounced and wired but never watched
under a real hand, only reasoned about from the fact that autosave did not fire.

---

## 2026-09-03 · a fence you can press

pass three. the code blocks run, the claude transcripts are readable, and the
docs say how far behind the code they are.

### the thing i was wrong about, and the measurement that killed it

i went in believing the session viewer's hard problem was getting the markdown
across the bridge. it is written into the plan i inherited: 152 KB of output
blows the 60,000 byte cap on `Q.shell`, so page it or pull it back through
`Q.shellBig` with `{raw:true}`.

then i measured the actual corpus instead of the example. `~/.claude/projects`
on this machine is **1,542 transcripts and 1.0 GB**. the biggest single file is
**47 MB**, and the renderer turns it into **1.27 MB of markdown in 0.13s**. not
152 KB. shellBig would have pulled that back in 31 base64 chunks at 42 KB each,
one shell round trip per chunk, to build a string that then has to become a
document anyway.

the cap was never the problem. the problem was that i had decided the markdown
must arrive in javascript.

it must not. python writes it straight to a file and the editor opens the file.
the only thing that crosses the bridge is `wc -c`. one number. the whole paging
apparatus in the plan exists to solve a constraint that disappears the moment
you stop moving the bytes.

paging is still in there, but for a different reason and with a different
trigger: 1.27 MB is not a document, it is a stress test, so anything over 600 KB
renders as the first 400 records and the python's own "rerun with --from N" line
is the next page.

### the record the plan told me to key on is missing from 29 of 40 files

same plan, next assumption. the session's real name is the `ai-title` record.
that is how the sticky resolver works and it is correct there.

so i checked it on the 40 newest transcripts before building the list around it:

```
29 NOTITLE subagent
11 TITLE   main
```

every subagent transcript has no `ai-title` record at all. every main session
has one. it is not "sometimes late in the file", which is what the note warns
about. for a subagent it is never there.

that changed two things. a subagent row is labelled by what it is rather than
handed a title it does not have, and the expensive column is skipped for them
entirely: 29 of 40 files no longer get grepped end to end to find nothing.

i also tried being clever about the grep. `tail -c 262144 | grep` instead of
scanning the whole file: 0.46s for 40 files. the full scan: 0.41s. the tail was
**slower**, and it missed titles that the full scan finds, because the tail
still has to seek and the grep dies on the first match anyway. clever lost to
plain by 12%.

### insertText is a paste, so it cannot put text where the output goes

the run affordance needs to fold output in **under the block that produced it**.
that is a write at an exact offset in the document.

there isn't one. the host's editor has exactly this:

```js
insertText(t){ this.UserOp.pasteHandler(this, t, !0, !0, !0) }
```

it is a paste at the caret, and the caret is wherever the person left it, which
is not where the output belongs. `jumpIntoElemEnd` exists, but a fence on screen
is either a `contenteditable=false` <pre> or a live CodeMirror, and jumping into
the second one puts the caret **inside the code**, so the output would land in
the command.

so the write is the whole document. compute the new markdown, hand it to
`File.reloadContent`, put the scroll position back. it registers one undo command
tagged `reload`, so ⌘Z takes the output back out in a single step, which is
better than what a paste would have given.

one thing it does not do reliably is mark the document edited, and an edit that
is not marked is an edit that is silently lost on quit. so `updateChangeCount`
is called explicitly right after.

### the DOM knows where a fence is, only the source knows which fence it is

the button is placed from the DOM. the edit is computed from the markdown. they
are joined by matching the code text, never by trusting that the nth `<pre>` is
the nth fence, because an indented code block renders as `.md-fences` too and is
not a fence in the source at all.

the scanner cost me two bugs, both caught by tests before the app ever saw them:

- a fence nobody closed runs to the end of the document, and splitting a text
  that ends in a newline leaves an empty last element. that empty string was
  being handed to the shell as the last line of the command.
- a document whose final character is the closing backtick has no newline after
  it, so the result block got welded on as ```` ```\n```quire-out ```` with no
  blank line between them. one fence, not two.

47 assertions run outside the app against a stub host. that is where both of
those died, in about a second each, instead of inside a signed bundle.

### the half of the flagship that matters is the half where nothing happens

a document is untrusted input. anybody can put `rm -rf ~` in a fence and send it
to you, and an editor that runs what it renders is remote code execution with
syntax highlighting. so nothing ever runs on its own: not on open, not on load,
not on focus, not on a poll.

that is easy to write in a comment and worth nothing until it is measured. the
selftest puts a shell block into a real document, the command in it creates a
file, and the document is rendered, redrawn and laid out for 2.4 seconds. then
it checks the file is not there. only after that does it run the block on
purpose and check it is.

```
runBlock  ok · did not run on its own after 2.4s of rendering · 1 run button
          drawn · ran when asked · output folded in under the block ·
          a re-run replaced it, still one block
```

the classifier gets the same treatment. 15 ordinary commands have to run without
a question and 16 destructive ones have to be held, and the dialog itself is
opened, read and cancelled by the test:

```
runAsk  ok · asked ("This command can destroy things"), cancel returned nothing
        and ran nothing
```

it is a seatbelt, not a sandbox, and the dialog says so. it reads the literal
text of the command. `eval`, a variable holding a path, a script called by name,
all of them walk straight past it. i took `$(` off the list on purpose: flagging
every command substitution flags almost every real command, and a question you
always answer yes to is not a question.

the one regex that took three tries is the redirect. `2>/dev/null` is not a
command overwriting a file and neither is `2>&1`, but both look exactly like one
until you exclude a digit or an ampersand next to the arrow.

### a command's exit status does not survive the trip

i wanted the result block to say `exit 3`. it cannot. `parseResult` in the core
turns the array form of a result into `code: r[0] ? 0 : 1`, so anything that is
not zero arrives as 1, and the object form's `code` is not always populated
either. a number there would be invented.

so the block says `ok` or `failed`, plus the duration, plus the line count. three
things that are true beats one that reads better.

### the docs panel is one git call, not one per doc

`git log --name-only` is newest first, so the first time a path appears is the
last time it changed. one pass over 400 commits answers every question at once:
when each doc was last committed, when the code next to it was, and how many
commits of code landed in between.

"the code it describes" is the directory the doc lives in. that is a heuristic
and it is the honest one available, because nothing in a markdown file says which
functions it is about. where it is wrong it is wrong in the direction of asking a
question.

the test builds its own repo so the answer is known before the code is asked:
one doc, then two commits of code after it, then an uncommitted second doc.

```
stale  ok · README.md 2 commits behind (built it to be 2), newest code
       src/a.js, uncommitted NOTES.md listed, 3 commits read
```

it only says 2 because the commit dates are pinned. three commits made back to
back land in the same second, `%ct` has one second of resolution, and the first
version of that test built a repo specifically to be two commits behind and got
zero.

### what i could not check

i could not press the button. the selftest calls `exec` directly, so the click
handler is wired and unproven. what i do have is a photograph: the window
captured by id, no focus taken, and the run pill sitting in the top right corner
of the bash fence at 32% opacity, exactly where the code puts it. drawn is
proven. pressed is not.

the sessions and docs panels are proven at the DOM level only. the `panels`
stage renders every registered section and fails on an empty one, and it says
`7 render` now instead of 5. i never got a photograph of either one, because
getting one means driving the sidebar, and driving the sidebar means the
keyboard.

i tried to cheat that with `defaults write com.ethangiannaros.quire quirePrefs`
to make the sidebar come back on the sessions section. nothing happened. the
plist key is written and the app never reads it, which is the same thing the
selftest's own header warns about: the host only reloads preference keys it
already knows about. localStorage is what actually persists our preferences, and
there is no way in from outside.

and `saveWrite` still fails when you arm it. 45 seconds, autosave never fires.
that is unchanged from yesterday and it is why that stage is behind a marker file
and reports `skipped` in an ordinary run.

### what i decided against

no running every block in a document with one key. it is four lines of code and
it is the feature that turns one careless press into twelve commands, half of
them with the output of the first three baked into a note somebody sent you.

no javascript port of the renderer. the instruction was to port it and not
rewrite it, and after measuring the corpus that stopped being an instruction and
started being the right call: python renders 47 MB in 0.13s straight to a file,
and the javascript version's first act would have been to defeat the reason it
is fast.

no run buttons in the read-only pane, in zen, or on a sticky. the pane sits at
z-index 10 over the document, so the fences behind it still have rectangles and
would have put run buttons on top of somebody else's file.

no exit code, see above. no `git blame` for staleness either: it answers a
different question, which is who wrote a line, not whether the paragraph around
it is still true.

### verified

42 selftest stages, 8 of them new, all passing, against a scratch document under
`$TMPDIR` so nothing in a repo was ever open in the editor. 127 commands, 38
keys, no duplicate key and no duplicate id. `seal OK`.

proven with numbers rather than asserted: a fence scanner that finds 4 fences in
a document written to break it, with offsets that slice the source back exactly,
a nested fence counted once and an unterminated one running to the end. 15 safe
commands through and 16 destructive ones held. output that lands under its own
block, a re-run that replaces rather than stacks, a 3-backtick output that gets a
4-backtick fence, and the right one of two identical blocks getting the result.
seven transcript record shapes handled and seven junk record types dropped, with
the title read off the last line of the file. 7,356 KB of real transcript in, 193
KB of markdown out, 4,327 lines, 260ms. a README two commits behind a repo built
to put it exactly two commits behind.

the scratch document came back byte identical after every run, including the one
that deliberately dirtied it. the dialog watchdog logged nothing, because no
dialog ever appeared.

---

## 2026-09-03 · the pass where i had to look

pass four. every button, every pill, rounder corners, the frontmatter drawn as a
card, and a polish pass over the whole thing. it is the pass i could do least of
from the code, because the complaint was "the buttons" and you cannot read a
button off a stylesheet.

### nine radii, arrived at one feature at a time

the old `quire.css` had `border-radius` written out in pixels in ten places:
2, 3, 4, 7, 8, 9, 10, 12, 14 and 999. none of them wrong on their own. all of
them decided while writing the feature they belong to, which is how a file ends
up with a 7px file row next to a 9px badge next to an 8px input.

buttons were worse. a modal button was `padding: 7px 16px`, a git action was
`3px 9px`, a files chip `2px 9px`, a session action `2px 8px`, a view action
`3px 9px`. five paddings, no heights, so nothing lined up with anything and the
only reason it looked survivable is that they never appear in the same row.

so the file is in three parts now. tokens, then controls, then features, and the
features are only allowed to do layout. four control shapes: a button at 30px, a
pill at 22px, an icon button at 26px, a badge at 18px. four radii, 6/10/14/18,
one step rounder than before at every level, plus a pill. **there is no longer a
single `border-radius` in the file with a number next to it.** 41 uses, all of
them a token.

### the stage that caught it before i did

a design system is a claim, and a claim in css rots the moment somebody adds a
section. so `controls` builds one of every control off screen and measures it:

```
controls  ok · 7 pill shapes all 22px and all fully round, 3 control shapes
          all 30px, radii 10/6/10 on the 6/10/14/18 scale
```

the first time it ran it failed, and it was right. i had written the shared pill
at 22px and then, forty lines further down, given `.q-sess-act` and
`.q-view-act` a height of 20px because they looked slightly better in a header.
two of the seven. that is the whole failure mode, reproduced by me, in the same
file, within an hour of writing the rule down.

it also failed for a stupider reason first. the detail line printed "7 pill
shapes all 22px" unconditionally, so a failing stage reported its own success in
the same string. and the roundness check was `radius >= height`, which is wrong:
webkit hands back the **used** radius here, not the computed one, so
`border-radius: 999px` on a 22px pill reads back as 11. both fixed, and the
detail line now prints the array when the array is not uniform.

### the window cannot be round, so the sidebar became a card

the frame is capped by `NSVisualEffectView`, which has fixed materials and no
radius. that is already in INTERNALS and i did not spend a minute on it.

what i did instead: the sidebar is a card now. the panel keeps its position and
its width, gets 6px of padding, and the column inside it is a rounded surface
with the icon rail sitting outside it on the window edge. the glass shows down
both sides of the card, which is the first time the transparency has been doing
anything other than tinting.

### the frontmatter card, and the three rules that made it safe

a sticky carries yaml: session, cwd, window, created, and how the session was
resolved. eight lines of it above the two lines you wrote.

the card is an overlay, not markup. nothing goes inside `#write`, because this
editor serialises its node tree on save and anything you put in the document
eventually gets handed to the markdown writer. so: a fixed div over the block's
own rectangle, the same trick the run buttons already use. the raw `<pre>` stays
exactly where it was, goes transparent, and lends its height to the card. it is
still the only thing that gets saved. click into it and the card steps aside and
the yaml comes back, because a card you cannot edit is a wall.

the height is a handshake: the card is measured after it renders and the number
goes back to the block as `--q-fm-h`. one direction only, so it cannot oscillate.

```
frontmatter  ok · 3 keys parsed off 4 lines, a quoted colon survived, 3 rows
             drawn (session, cwd, window), raw yaml transparent, block 82px
             against a 82px card
```

the base stylesheet paints `pre.md-meta-block` with `background:#ccc`. a light
grey slab across the top of a dark document, in the app since 2021, and the only
reason nobody noticed is that almost nothing here has frontmatter.

### seven things that were only findable by looking

i took 30-odd photographs of the window this pass. every one of these came out
of one of them and not one of them came out of reading the code.

- **an empty `<kbd>` is a box.** the palette renders `<kbd></kbd>` for a command
  with no shortcut. at the old padding that was a sliver. at a real min-width it
  is an empty grey rectangle on two thirds of the rows. `kbd:empty` now hides.
- **`--q-radius` does not exist.** the toast asked for `var(--q-radius)` and has
  had square corners since it was written. there is no such token and there never
  was; every other float uses `--q-r3`.
- **`--tn-bg` does not exist either.** a tokyonight pass left `background:
  var(--tn-bg)` on the float titles. an undefined var in a shorthand is invalid
  at computed-value time, so the background fell back to transparent and the
  box's own border ran straight through the word "commands".
- **the rail's active indicator was off the edge of the window.** a 2px accent
  bar at `right: -7px` on a 28px button in a 38px rail, and the rail is against
  the window edge. it has never once been visible. the selected section is a
  filled rounded square now, which is a thing i can see.
- **the read-only pane was see-through.** `body.q-glass #q-view` was
  `background: transparent !important`, written to match the document, except the
  pane covers the document rather than replacing it. so opening `build.sh` gave
  37 numbered lines of shell with an `<h1>` reading "Quire" straight through the
  middle of them. two passes old. proven at the dom level, never once looked at.
- **a sticky note was 80px wide.** the sidebar preference is shared with the main
  window, so a note opened while the sidebar was up inherited
  `content { right: 300px }` in a 380px window. the whole note wrapped one word
  per line and it looked like the frontmatter card was broken. two fixes:
  `restoreSidebar` refuses on a sticky, and the sticky rule pins `right: 0`.
- **the terminal prompt pointed the wrong way.** the path ellipsises from the
  left, which needs `direction: rtl`, and a neutral character like `›` inside an
  rtl run gets mirrored and moved to the other end. it read `‹ quire-demo/~`.
  the caret is its own element now.

plus three panels printing **"just now ago"**, because `Q.ago` answers "just now"
as well as "3 minutes" and three call sites appended " ago" to both. there is a
`Q.since` now and it is the only thing allowed to phrase it as a sentence.

### how you photograph an app you are not allowed to touch

macos stops painting an occluded web view, so a background `screencapture` gives
you the last frame it painted. pass one got 70 captures over 28 seconds and 58 of
them were byte identical.

what works: keep the window unoccluded, capture by window id with
`screencapture -x -o -l`, and drive the app from inside. a temporary `97-shot.js`
polled a scene name out of a file every 500ms and put the app into it: open the
palette with this query, show that panel, run this command in the terminal. it is
deleted now and it was never part of the app.

it also wrote 18 sticky notes. `last` is per window, so the note window's own
copy of the driver read the same scene file, decided it had not seen it yet, and
made another note. every six seconds until i changed the scene. deleted.

one honest note about the screenshot: the window is 65% opaque by default and the
desktop behind it right now is bright, so a straight capture came out mid grey.
the shot was taken at 90%, which is a live setting on `⌘⌥-` and `⌘⌥=`, and it is
what the app looks like over a dark desktop at the default.

### what i decided against

no rounding the host's left sidebar. its width is set inline by the host when you
drag it and overriding that with `!important` breaks the drag. so the left column
is square and ours is a card, and the rail is the seam between them.

no converting the pills to real `<button>` elements. it is the correct markup and
it costs you the caret: clicking a `<button>` moves focus out of the editor, and
these all sit in a panel next to a document you are typing into. they are divs
with hover, active and disabled states and no focus ring, which is a real
tradeoff and not an oversight.

no fade mask on the palette list. it looks good and it hides the fact that the
list scrolls.

### verified, and what is not

44 selftest stages, 2 of them new, all passing, against a scratch document under
`$TMPDIR`. 128 commands, 38 keys, no duplicate key and no duplicate id. `seal
OK`. the scratch document came back byte identical and the dialog watchdog logged
nothing.

photographed, at 2800x1730, by window id, with no focus taken: the palette over a
document, the files panel, the git panel's empty state, the sessions list, the
docs panel, the tags cloud, the terminal with real output in it, the read-only
pane over `build.sh`, which-key with all 38 bindings in five columns, the about
dialog with its three buttons, and a sticky note with its frontmatter card.

not verified: i cannot press anything. every hover, active and focus state in
this pass is drawn in css and has never been photographed under a pointer,
because a pointer means the keyboard and the keyboard belongs to whoever is at
the machine. the same goes for the drag handle on the sidebar and the caret
landing in the frontmatter block, which is the one gesture the card is built
around.
