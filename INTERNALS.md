# quire

a markdown editor. forked from the runtime of typora 0.11.18, rebuilt around it.

---

## the hook

i took that app apart to learn how ([typora-teardown](https://github.com/Cadaquesenc/typora-teardown)),
then went to build a better editor from scratch, got 800 lines of swift in, and
threw it away — because the teardown had answered a question i hadn't asked.

**five of the six features i wanted were already in the app, switched off.**

file tree, pandoc export, math, diagrams, image-paste-to-assets. all shipped in
2021, all sitting behind a flag that defaults to zero.

so quire isn't a rewrite. it's nine settings, a shell, and about 2,000 lines of
things that were never in the box.

## what was already there

| | status in stock 0.11.18 |
|---|---|
| file tree | `editor.library`, 75 methods, plus ripgrep 12.1.1. off (`useTreeStyle: 0`) |
| pandoc export | native `PandocBridge`. docx/epub/rst. needs `pandocPath`, which the app only ever looks for with a bare `which pandoc` |
| math | mathjax 3.2.0, eager-loaded. `enable_inline_math: 0` |
| diagrams | mermaid 8.8.3 + flowchart.js + sequence-diagrams |
| highlight, sub, sup | `==mark==`, `~sub~`, `^sup^`, all behind flags |

## the thing that made everything else possible

there is no node here. `File.isNode` is false and index.html nulls out
`require`, `module` and `exports`. so javascript in this app can't read a file,
can't run a command, can't do anything filesystem-shaped.

except there's one handler that launches a process — `controller.runCommand`,
which exists to run pandoc. i spent an hour assuming it took an argv array,
because that's what its only caller passes:

```js
bridge.callHandler("controller.runCommand", { args: t, cwd: e }, cb)
```

it doesn't. **`args` is a single string, handed to a shell.** an array gets
stringified somewhere on the way across and arrives as a mangled two-line
script:

```
/bin/bash: line 1: --quire-exec,: command not found
```

that error is what gave it away. and worse, my first probe *passed* — it checked
whether the response contained the string it had sent, and the shell's error
message quotes the command it failed to run. the test matched its own input.

as a string it's a plain shell. so backlinks, tags, git and the note index all
run on grep, find and git — through a handler written to run pandoc.

## what quire adds as of now

**command palette** — `⌘⌥P`. 91 commands. the host has no command registry at
all: its menus are native `NSMenu` items whose actions are hardcoded javascript
strings the binary evals, so nothing on the js side ever knew what existed.

**rebindable shortcuts** — macos typora cannot bind a key in-app. its keybinding
path is guarded by `if (File.isNode)`, which never passes, so the only stock
route is System Settings matching on menu titles. quire has a table you click.

**backlinks + tags** — a right-hand panel. greps the open folder for `[[note]]`
and for `#tag`. `[[` links resolve by name, and offer to create the note if it
doesn't exist.

**git** — branch and dirty count in the status bar, commit/diff/log from the
palette.

**notes** — daily note, quick capture to today, templates with `{{date}}`.

**status bar** — file, git, words, tasks, reading time. it drops into the 25px
gutter the host already reserves at the bottom, so nothing reflows.

**terminal** — a real shell in a panel, on the same handler as everything else.
one caveat that is inherent, not a bug: each command is a separate
non-interactive `bash -c` run to completion, so there is no pty. nothing
interactive works, and there is no output until a command finishes. `cd` is
handled in the panel rather than the shell, because the shell that ran it is
gone by the time the next command starts.

**files** — every file under the folder, flat, grouped by directory, filterable.
markdown opens in the editor, anything else goes to the system. the folder path
in the status bar is clickable: each segment opens this panel scoped to it.

**20 text transforms** — sort, dedupe, slugify, selection-to-table, all routed
through `undo.exeCommand` so each is one undo step.

## the look

four things were pulled from, and it matters which part came from where.

**ghostty** — the ground and the colours. the palette is the exact ansi values
out of `~/.config/ghostty/config`, so the editor and the terminal next to it are
the same room. same translucency model too: a tinted background plus a real
window blur.

**discord** — the text hierarchy. three levels, normal/muted/faint, and almost
everything that isn't the words you wrote sits on the bottom two. that is why
the chrome disappears when you're reading. also their section labels: 10px,
uppercase, bold, 40% opacity — they stop being read as content and start being
read as structure.

**apple** — restraint and motion. one accent for anything selected, focused or
active, and nothing else. prose stays a single colour: no rainbow headings,
because an editor is for reading. the easing is apple's spring, which overshoots
a hair and settles, so a panel feels pushed rather than switched on.

**lazyvim** — the structures, not the colour scheme. floats have a 1px edge with
their name sitting in the top border. the picker is telescope's two-pane layout.
the status bar opens with a lualine mode block. and hold ⌘⌥ for 400ms and
which-key appears, showing every third key and what it does.

typeface is Inter by default, bundled — the same face obsidian ships. Victor Mono
is bundled too, as the free stand-in for Operator Mono and MonoLisa: it is the
only openly licensed face with operator's cursive italics. the picker probes what
is actually installed by measuring text width against a fallback, so a font that
isn't there is never silently offered.

## glass

the window is translucent with a real blur behind it, the same way ghostty does
it. that isn't something javascript can reach, so it's a small rust dylib in
`native/quire-glass`:

- the window goes non-opaque with a clear background
- every view that answers `setDrawsBackground:` stops painting
- `CGSSetWindowBackgroundBlurRadius` sets the blur

that last one is private CoreGraphics, and it's the only way to set a blur
radius on macos — `NSVisualEffectView` has fixed materials and no radius. it's
what ghostty uses too.

two details cost me a crash each: `colorWithRed:green:blue:alpha:` is a class
method and i sent it to an instance, and `_setDrawsTransparentBackground:` takes
the *opposite* boolean from `setDrawsBackground:`, so passing the same value to
both undoes one with the other.

the tint itself is deliberately not in the dylib. the page paints it, so opacity
is a css variable — `⌘⌥-` and `⌘⌥=` change it live, no restart.

it loads via `DYLD_INSERT_LIBRARIES` in the app's own Info.plist, which only
works because the bundle is signed with `allow-dyld-environment-variables` and
`disable-library-validation`.

## size

| | |
|---|---|
| bundle | 27 MB (32 MB before slimming) |
| resident | ~80 MB with a document open |

it was never electron. the host is objective-c with a web view, which is why it
starts at 41 MB idle instead of 400. the slimming drops 34 localisations and the
bundled help docs and nothing else — `--full` keeps them. ripgrep, mathjax and
mermaid all stay, because the editor actually loads them.

## build

```sh
./build.sh              # build, slim, sign, install to ~/Applications
./build.sh --full       # keep the localisations
./build.sh --no-install # leave it in build/
```

rename the whole app by editing two lines at the top of `build.sh`. nothing else
hardcodes the name — the branding is 87 `.strings` files, rewritten at build
time, so the menus say Quire without patching the binary.

**sparkle auto-update is off.** it was live and had checked the day before this
started; `SUSkippedVersion` was 7785 against this build's 5941. one misclick and
the last free build is gone.

## keys

| | |
|---|---|
| `⌘⌥P` | command palette |
| `⌘⌥B` | backlinks |
| `⌘⌥G` | tags |
| `⌘⌥D` | today's note |
| `⌘⌥N` | quick capture |
| `⌘⌥K` | link to a note |
| `⌘⌥O` | follow the link under the cursor |
| `⌘⌥C` | git commit |
| `⌘⌥Y` | toggle transparency |
| `⌘⌥-` / `⌘⌥=` | more / less transparent |
| `⌘⌥Z` | zen |
| `⌘⌥W` | prose typography |

every one of them is rebindable. `⌥↩` on any row in the palette sets a key.

## verified

- math, math blocks, mermaid, highlight, sub/sup, tasks, tables, line-numbered
  code all rendered in a real document
- palette opened and filtered — 8 matches for "table", shortcut badge on the one
  that has one
- backlinks and tags panels populated from real greps
- shell returned `git version 2.50.1` and the os version
- the dylib maps into the process and the window blurs what's behind it

checked by photographing the window through `CGWindowListCopyWindowInfo` rather
than by activating it, because stealing focus to test a window wrecks whatever
the person at the keyboard was doing.

## building it

you supply the runtime. `vendor/base.app` is not in this repo and never will be —
committing it would be redistributing someone else's application. put a copy of
typora 0.11.18 there yourself:

```
cp -R "/Applications/Typora.app" vendor/base.app
./build.sh --run
```

everything under `src/`, `native/` and `brand/` is mine. the bundle it gets copied
onto is not, which is why this builds on your machine instead of shipping as a
download. `resign.sh` handles the ad-hoc signing an edited bundle needs to launch
at all.

the two bundled typefaces are Inter and Victor Mono, both SIL OFL 1.1 — see
`src/FONTS.md`.

## what came out of what

the teardown that made this possible is a separate repo:
[typora-teardown](https://github.com/Cadaquesenc/typora-teardown). it's where the
nine flags, the 166 bridge handlers and the `runCommand` shell-string discovery
come from.

## what's still not possible

no node, no `fs`. anything filesystem-shaped goes through the shell or the 166
bridge handlers. you cannot add a native menu item from javascript —
`menu.updateMenu` only toggles items that already exist. and the markdown parser
is minified with no source map, so the live-preview engine is the one part that
can't be replaced. that's the reason this is a fork and not a rewrite.
