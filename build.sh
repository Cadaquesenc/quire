#!/bin/bash
# build Quire.app from the base bundle.
#
# this is a fork, not a plugin. the base bundle in vendor/ is the runtime we
# inherited; everything under src/ is ours, and the branding, identity and
# defaults are rewritten so the result is its own application.
#
#   ./build.sh                 build + install to ~/Applications
#   ./build.sh --no-install    build into build/ only
#   ./build.sh --run           build, install, launch
#   ./build.sh --full          keep the localisations and bundled help docs
#
# the default strips the non-english localisations and the bundled help
# documents. nothing else: every library the editor actually loads stays,
# including ripgrep, mathjax and mermaid.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# ---- identity ---------------------------------------------------------------
# rename the app by changing these two lines. nothing else hardcodes the name.
NAME="Quire"
BUNDLE_ID="com.ethangiannaros.quire"

VERSION="0.1.0"
BASE="$HERE/vendor/base.app"
OUT="$HERE/build/$NAME.app"
INSTALL_DIR="$HOME/Applications"

DO_INSTALL=1
DO_RUN=0
DO_SLIM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) DO_INSTALL=0; shift ;;
    --full) DO_SLIM=0; shift ;;
    --run) DO_RUN=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -d "$BASE" ] || { echo "no base bundle at $BASE" >&2; exit 1; }

echo "==> $NAME $VERSION"

# quit a running copy so we are not editing a live bundle
pgrep -x "$NAME" >/dev/null && { osascript -e "quit app \"$NAME\"" >/dev/null 2>&1 || true; sleep 2; }

rm -rf "$HERE/build"
mkdir -p "$HERE/build"
echo "==> copying base"
cp -R "$BASE" "$OUT"

C="$OUT/Contents"
R="$C/Resources"
TM="$R/TypeMark"

# ---- identity ---------------------------------------------------------------
echo "==> identity"
P="$C/Info.plist"
plutil -replace CFBundleName            -string "$NAME"       "$P"
plutil -replace CFBundleDisplayName     -string "$NAME"       "$P"
plutil -replace CFBundleIdentifier      -string "$BUNDLE_ID"  "$P"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$P"
plutil -replace CFBundleVersion         -string "$VERSION"    "$P"
plutil -replace NSHumanReadableCopyright -string "$NAME"      "$P"
# sparkle stays off. the base build is not replaceable and an update would eat it.
plutil -replace SUEnableAutomaticChecks -bool false "$P" 2>/dev/null || true
plutil -remove  SUFeedURL "$P" 2>/dev/null || true
plutil -replace SUBundleName -string "$NAME" "$P" 2>/dev/null || true
# don't inherit the other app's crash reporting
plutil -remove  SentryDSN "$P" 2>/dev/null || true

# ---- icon -------------------------------------------------------------------
echo "==> icon"
if [ ! -f "$HERE/brand/icon-1024.png" ]; then
  swiftc -O "$HERE/brand/icon.swift" -o "$HERE/build/qicon" >/dev/null 2>&1
  "$HERE/build/qicon" "$HERE/brand/icon-1024.png" >/dev/null
fi
ICONSET="$HERE/build/$NAME.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for sz in 16 32 128 256 512; do
  sips -z $sz $sz            "$HERE/brand/icon-1024.png" --out "$ICONSET/icon_${sz}x${sz}.png"    >/dev/null
  sips -z $((sz*2)) $((sz*2)) "$HERE/brand/icon-1024.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$R/AppIcon.icns"
# Assets.car also carries an AppIcon, and CFBundleIconName makes macos prefer the
# asset catalog over the file. dropping the key sends it back to AppIcon.icns.
plutil -remove CFBundleIconName "$P" 2>/dev/null || true
rm -rf "$ICONSET"

# ---- strings ----------------------------------------------------------------
# menu titles and dialog copy live in .strings files, so the app can be renamed
# without touching the binary. license and activation copy is left alone.
echo "==> strings"
python3 - "$OUT" "$NAME" <<'PY'
import os, re, sys
app, name = sys.argv[1], sys.argv[2]
skip = re.compile(r'activat|licen[cs]|registered|purchase|deactivat|store\.', re.I)
kv   = re.compile(r'^(\s*"(?:[^"\\]|\\.)*"\s*=\s*)("(?:[^"\\]|\\.)*")(\s*;\s*)$')
touched = 0
for root, _, files in os.walk(os.path.join(app, "Contents", "Resources")):
    for f in files:
        if not f.endswith(".strings"):
            continue
        p = os.path.join(root, f)
        try:
            raw = open(p, "rb").read()
        except OSError:
            continue
        enc = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8"
        try:
            text = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        out, changed = [], False
        for line in text.splitlines(keepends=True):
            m = kv.match(line.rstrip("\r\n"))
            if m and "Typora" in m.group(2) and not skip.search(line):
                val = m.group(2).replace("Typora", name)
                nl = line[len(line.rstrip("\r\n")):]
                out.append(m.group(1) + val + m.group(3) + nl)
                changed = True
            else:
                out.append(line)
        if changed:
            open(p, "wb").write("".join(out).encode(enc))
            touched += 1
print(f"    rebranded {touched} strings files")
PY

# ---- native ------------------------------------------------------------------
# the transparency is not something javascript can do: it needs the NSWindow to
# stop being opaque and the web view to stop painting. that is a small rust
# dylib, loaded through the app's own Info.plist.
echo "==> native"
( cd "$HERE/native/quire-glass" && cargo build --release >/dev/null 2>&1 ) \
  || { echo "    cargo build failed" >&2; exit 1; }
DYLIB="$HERE/native/quire-glass/target/release/libquire_glass.dylib"
[ -f "$DYLIB" ] || { echo "    no dylib produced" >&2; exit 1; }
mkdir -p "$C/Frameworks"
cp "$DYLIB" "$C/Frameworks/libquire_glass.dylib"
echo "    $(du -h "$DYLIB" | cut -f1) dylib"

# DYLD_INSERT_LIBRARIES only survives the hardened runtime because resign.sh
# grants allow-dyld-environment-variables and disable-library-validation.
plutil -replace LSEnvironment -json '{}' "$P"
plutil -replace LSEnvironment.DYLD_INSERT_LIBRARIES \
  -string '@executable_path/../Frameworks/libquire_glass.dylib' "$P"

# ---- our source -------------------------------------------------------------
echo "==> installing src"
DEST="$TM/quire"
rm -rf "$DEST"; mkdir -p "$DEST"
cp -R "$HERE/src/." "$DEST/"

python3 - "$TM/index.html" "$DEST" <<'PY'
import os, re, sys
target, dest = sys.argv[1], sys.argv[2]
s = open(target, encoding="utf-8").read()
s = re.sub(r"<!-- quire:begin -->.*?<!-- quire:end -->\n?", "", s, flags=re.S)

css = sorted(f for f in os.listdir(dest) if f.endswith(".css"))
js  = sorted(f for f in os.listdir(dest) if f.endswith(".js"))
lines = ["<!-- quire:begin -->"]
lines += [f'<link rel="stylesheet" href="./quire/{f}">' for f in css]
# defer keeps document order and runs after appsrc/main.js has initialised
lines += [f'<script src="./quire/{f}" defer></script>' for f in js]
lines += ["<!-- quire:end -->", ""]
block = "\n".join(lines)

if "</body>" in s:
    s = s.replace("</body>", block + "</body>", 1)
else:
    s += "\n" + block
open(target, "w", encoding="utf-8").write(s)
print(f"    loaded {len(css)} css + {len(js)} js")
PY

# ---- defaults ---------------------------------------------------------------
echo "==> seeding defaults"
python3 - "$BUNDLE_ID" <<'PY'
import subprocess, sys
domain = sys.argv[1]
b = lambda k, v: ["defaults", "write", domain, k, "-bool", v]
s = lambda k, v: ["defaults", "write", domain, k, "-string", v]
i = lambda k, v: ["defaults", "write", domain, k, "-int", str(v)]
cmds = [
    b("enable_inline_math", "true"),
    b("enable_diagram", "true"),
    b("enable_highlight", "true"),
    b("enable_sub", "true"),
    b("enable_sup", "true"),
    b("useTreeStyle", "true"),
    b("showLineNumbersForFence", "true"),
    b("useRelativePathForImg", "true"),
    s("defaultImageStorage", "per-file-assert"),
    b("SUEnableAutomaticChecks", "false"),
    b("send_usage_info", "false"),
]
for c in cmds:
    subprocess.run(c, check=False, capture_output=True)
print(f"    {len(cmds)} keys")
PY

# ---- slim -------------------------------------------------------------------
# the only removals are the 34 localisations this machine will never display and
# the bundled help documents. every library the editor loads stays: ripgrep is
# what the search and backlinks run on, mathjax and mermaid are the renderers.
if [ "$DO_SLIM" = "1" ]; then
  echo "==> slimming"
  before=$(du -sk "$OUT" | cut -f1)
  rm -rf "$TM/Docs"
  find "$R" -maxdepth 1 -name '*.lproj' ! -name 'Base.lproj' ! -name 'en.lproj' -exec rm -rf {} + 2>/dev/null || true
  find "$TM/locales" -maxdepth 1 -name '*.lproj' ! -name 'Base.lproj' ! -name 'en.lproj' -exec rm -rf {} + 2>/dev/null || true
  after=$(du -sk "$OUT" | cut -f1)
  echo "    $(( (before - after) / 1024 ))MB removed, now $(( after / 1024 ))MB"
fi

# ---- seal -------------------------------------------------------------------
"$HERE/resign.sh" "$OUT"

# ---- install ----------------------------------------------------------------
if [ "$DO_INSTALL" = "1" ]; then
  echo "==> installing to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/$NAME.app"
  cp -R "$OUT" "$INSTALL_DIR/$NAME.app"
  # let Launch Services notice the new identity
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$INSTALL_DIR/$NAME.app" >/dev/null 2>&1 || true
  echo "    $INSTALL_DIR/$NAME.app"
fi

[ "$DO_RUN" = "1" ] && open "$INSTALL_DIR/$NAME.app"
echo "==> done"
