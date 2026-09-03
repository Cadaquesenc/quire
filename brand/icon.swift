// draws the app icon at 1024. dark ground, one lowercase serif q, a folded corner.
// run: swiftc -O icon.swift -o /tmp/qicon && /tmp/qicon out.png
import AppKit
import CoreGraphics
import CoreText

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let S: CGFloat = 1024

let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: Int(S), height: Int(S),
                          bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("no context")
}
func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat(r)/255, green: CGFloat(g)/255, blue: CGFloat(b)/255, alpha: a)
}

let inset: CGFloat = 100
let box = CGRect(x: inset, y: inset, width: S - inset*2, height: S - inset*2)
let radius: CGFloat = box.width * 0.2237

// ---- ground -----------------------------------------------------------------
let ground = CGPath(roundedRect: box, cornerWidth: radius, cornerHeight: radius, transform: nil)

// everything below stays inside the squircle, so the corner never goes square
ctx.saveGState()
ctx.addPath(ground)
ctx.clip()

let grad = CGGradient(colorsSpace: cs,
                      colors: [rgb(44, 46, 51), rgb(14, 15, 17)] as CFArray,
                      locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: box.maxY), end: CGPoint(x: 0, y: box.minY), options: [])

// bottom-right corner turned up. the light triangle is the underside of the page.
let fold: CGFloat = 210
let under = CGMutablePath()
under.move(to: CGPoint(x: box.maxX, y: box.minY + fold))
under.addLine(to: CGPoint(x: box.maxX - fold, y: box.minY))
under.addLine(to: CGPoint(x: box.maxX + 4, y: box.minY - 4))
under.closeSubpath()

ctx.saveGState()
ctx.addPath(under)
ctx.clip()
let pgrad = CGGradient(colorsSpace: cs,
                       colors: [rgb(243, 241, 235), rgb(150, 148, 140)] as CFArray,
                       locations: [0, 1])!
ctx.drawLinearGradient(pgrad,
                       start: CGPoint(x: box.maxX - fold, y: box.minY),
                       end: CGPoint(x: box.maxX, y: box.minY + fold), options: [])
ctx.restoreGState()

// the crease
ctx.setStrokeColor(rgb(0, 0, 0, 0.35))
ctx.setLineWidth(3)
ctx.move(to: CGPoint(x: box.maxX, y: box.minY + fold))
ctx.addLine(to: CGPoint(x: box.maxX - fold, y: box.minY))
ctx.strokePath()

ctx.restoreGState()

// ---- the q ------------------------------------------------------------------
let base = NSFont.systemFont(ofSize: 620, weight: .regular)
let serif = base.fontDescriptor.withDesign(.serif) ?? base.fontDescriptor
let font = CTFontCreateWithFontDescriptor(serif as CTFontDescriptor, 620, nil)

let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: rgb(243, 241, 235),
]
let line = CTLineCreateWithAttributedString(NSAttributedString(string: "q", attributes: attrs))
let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)

ctx.saveGState()
// optically centred: sit the glyph's own ink box in the middle, nudged up off the fold
let tx = box.midX - bounds.width/2 - bounds.minX - 34
let ty = box.midY - bounds.height/2 - bounds.minY + 52
ctx.textPosition = CGPoint(x: tx, y: ty)
CTLineDraw(line, ctx)
ctx.restoreGState()

// hairline edge
ctx.saveGState()
ctx.addPath(ground)
ctx.setStrokeColor(rgb(255, 255, 255, 0.10))
ctx.setLineWidth(3)
ctx.strokePath()
ctx.restoreGState()

guard let img = ctx.makeImage() else { fatalError("no image") }
let rep = NSBitmapImageRep(cgImage: img)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")
