#!/bin/bash
# re-seal a modified Typora bundle.
#
# editing anything under Contents/Resources invalidates the code signature —
# the bundle is signed with a hardened runtime, so the seal covers resources,
# not just the binary. macos then refuses to launch it.
#
# ad-hoc re-signing the main binary alone is not enough either. library
# validation requires every loaded library to carry the same Team ID as the
# process. an ad-hoc main binary (no team) next to the original Developer-ID
# frameworks is a mismatch, and dyld rejects the framework with:
#
#   "mapping process and mapped file (non-platform) have different Team IDs"
#
# so: sign inside-out, everything ad-hoc, and grant
# disable-library-validation. the app's original entitlements are preserved —
# it needs allow-jit and allow-unsigned-executable-memory for its web view.
set -euo pipefail

APP="${1:?usage: resign.sh /path/to/Typora.app}"
ENT="$(mktemp -t quire-ents).plist"

cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
PLIST

sign() { codesign --force --sign - --options runtime --entitlements "$ENT" --timestamp=none "$1" >/dev/null 2>&1; }

echo "==> signing nested code (inside out)"
# deepest first: helper apps inside frameworks, then the frameworks themselves
while IFS= read -r item; do
  [ -e "$item" ] || continue
  echo "    $(basename "$item")"
  sign "$item"
done < <(find "$APP/Contents/Frameworks" -maxdepth 4 \( -name "*.app" -o -name "*.xpc" \) 2>/dev/null)

for fw in "$APP"/Contents/Frameworks/*.framework; do
  [ -d "$fw" ] || continue
  echo "    $(basename "$fw")"
  sign "$fw"
done

# any loose dylibs / mach-o helpers under Resources (fileop, etc.)
while IFS= read -r bin; do
  echo "    $(basename "$bin")"
  sign "$bin"
done < <(find "$APP/Contents" -type f \( -name "*.dylib" -o -name "*.so" \) 2>/dev/null)

echo "==> signing app"
sign "$APP"

rm -f "$ENT"
echo "==> verifying"
codesign --verify --deep --strict "$APP" && echo "    seal OK"
