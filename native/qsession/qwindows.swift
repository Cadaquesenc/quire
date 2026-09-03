// qwindows: one line per on-screen window, as
//
//   <window-id>\t<owner>\t<title>\t<layer>\t<x>,<y>,<w>,<h>
//
// layer and bounds are on the end because they are the only way to check what
// the dylib did to a window without touching it. a sticky note is supposed to
// come up at NSFloatingWindowLevel in a 380 point frame, and `layer` is that
// level as the window server sees it. reading it here means never having to
// activate the app to find out.
//
// this exists because a claude code session has no api. what it does have is a
// terminal window whose title it sets itself, and CGWindowListCopyWindowInfo is
// the only way to read that title without asking the terminal, which would mean
// applescript, which would mean stealing focus.
//
// pid is useless here. every claude session on this machine runs in ghostty, so
// they all share one pid. kCGWindowName is per window, and it is the session's
// own title, which is the link into ~/.claude/projects.
//
// the leading status glyph is stripped: claude rotates a spinner character into
// the front of the title while it is working, so the same session has a
// different title second to second unless that character comes off.

import CoreGraphics
import Foundation

let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly)
guard let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}

let glyphs = ["\u{2733}", "\u{25D0}", "\u{25D3}", "\u{25D1}", "\u{25D2}",
              "\u{273B}", "\u{273D}", "\u{00B7}"]

func box(_ w: [String: Any]) -> String {
    guard let b = w[kCGWindowBounds as String] as? [String: Any],
          let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return "" }
    return "\(Int(r.origin.x)),\(Int(r.origin.y)),\(Int(r.size.width)),\(Int(r.size.height))"
}

for w in windows {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let num = w[kCGWindowNumber as String] as? Int ?? 0
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    var title = w[kCGWindowName as String] as? String ?? ""
    if title.isEmpty { continue }
    for g in glyphs { title = title.replacingOccurrences(of: g, with: "") }
    title = title.trimmingCharacters(in: .whitespaces)
    if title.isEmpty { continue }
    print("\(num)\t\(owner)\t\(title)\t\(layer)\t\(box(w))")
}
