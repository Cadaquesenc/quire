# quire

a markdown editor, built on the bones of an old one.

![quire](brand/screenshot.png)

---

## why this exists

i took typora 0.11.18 apart to learn how
([typora-teardown](https://github.com/Cadaquesenc/typora-teardown)). then i
started writing my own editor from scratch, got about 800 lines in, and threw it
away.

the teardown had already answered the question.

**five of the six features i wanted were already in the app, finished, switched
off.** file tree, pandoc export, math, diagrams, paste an image and it saves it.
all shipped in 2021, all sitting behind a setting that defaults to zero. nobody
ever turned them on.

so quire isn't a rewrite. it's nine settings flipped, a new shell around the app,
and about 2,000 lines of the things that really weren't there.

## the one door

the app is a web page in a costume. web pages can't touch your files or run
programs, and this one is locked down tight.

but it has a leftover door. one function that runs a program, put there so the
app could export files with pandoc.

i assumed it took a list of arguments. it doesn't. **it takes a plain string and
hands it to a shell.**

so it isn't a pandoc button. it's a shell.

backlinks, tags, git, the file list, the terminal. all of it is `grep`, `find`
and `git`, going out through a door built for one export format.

## built for writing next to claude

most markdown editors assume nobody else touches your files. claude code rewrites
them constantly, so quire is built around that.

- **run a shell block.** put a `bash` block in a note, press run. it runs in the
  sidebar terminal and the output folds back into the document underneath it.
  no other markdown editor can do this, because no other one has a real shell.
- **sticky notes claude can read** (`⌘⌥;`). a small note that floats over
  everything, including your claude code windows. it's a plain `.md` on disk with
  the session id in its frontmatter, so claude just reads the file. no plugin, no
  integration, nothing to set up.
- **it notices when claude edits the file you have open.** reloads if you haven't
  touched it, and if you have, it asks instead of picking a winner.
- **a save can only change what you changed.** if a save is about to rewrite lines
  you never touched, it stops and shows you which.
- **read a past session.** claude's transcripts are megabytes of unreadable json.
  quire renders them as normal documents. 1,542 of them here, 1.0 GB, the biggest
  47 MB.
- **docs that admit they're stale.** flags the `.md` files that are older than the
  code in their folder, and by how many commits.
- **grab the last command** (`⌘⌥'`). pulls it and its output into the note as a
  code block.

## the rest

- **command palette** (`⌘⌥P`). every command, searchable.
- **shortcuts you can rebind.** click a row, press a key. typora on mac can't do
  this at all. 39 of them.
- **one sidebar** with files, backlinks, tags, git, terminal, sessions and docs.
  each keeps its place when you switch away.
- **backlinks and tags.** write `[[a note]]` or `#tag` and it finds every mention.
- **git.** branch and unsaved count in the status bar, commit and diff from the
  palette.
- **daily notes.** one per day, quick capture, templates.
- **20 text transforms.** sort, dedupe, turn a selection into a table.
- **other files open read-only.** a `.js` file put through a markdown parser and
  saved is destroyed, so quire shows it and refuses to write it.

plus the five that were already in there, now switched on.

## the look

dark, frosted, quiet. colours from ghostty, text hierarchy from discord,
restraint from apple, palette and key hints shaped like lazyvim's.

the window blur isn't something javascript can ask for, so a small rust library
turns it on.

## building it

you supply the runtime. `vendor/base.app` isn't in this repo and never will be.
shipping it would mean redistributing someone else's app.

```
cp -R "/Applications/Typora.app" vendor/base.app
./build.sh --run
```

that builds `Quire.app` into `~/Applications`. an edited app won't launch on
apple silicon until it's signed again, which `resign.sh` does.

everything in `src/`, `native/` and `brand/` is mine. the app underneath isn't.
that's why you build it yourself instead of downloading it.

fonts are Inter and Victor Mono, both openly licensed. see `src/FONTS.md`.

## what it can't do

no filesystem except through that one door. no new menu items, since the app can
only switch on menus it already has. and the markdown engine can't be replaced,
which is why this is a fork and not a rewrite.

the window frame can't be rounded either. `NSVisualEffectView` ships fixed
materials with no radius, so the rounding stops one layer in.

## honest about what's tested

there's a self test in the app, 44 stages, all passing. it proves the things that
would quietly destroy a file: that the read-only pane hands back the same bytes
that are on disk, that nothing in it can write, that a shell block never runs on
its own, and that a save that reaches outside your edits gets held.

what it does not prove is anything involving a pointer. every hover and press
state is drawn but has never been clicked, because clicking means taking the
keyboard off whoever is using the machine.

## more detail

[`INTERNALS.md`](INTERNALS.md).
