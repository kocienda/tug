import CoreGraphics
import Foundation

/// The host's plan for handing the screen over from a departing card's view
/// to faces the host draws from each arriving card's stand-in.
///
/// The shell marks an entry `face` when its card is hidden only because its
/// page cannot show yet: the shell paints the card's stand-in meanwhile, and
/// the shell's page lies beneath every card view, so a departing view left
/// standing covers that stand-in. Only the host knows what is on screen now,
/// so the host plans: a departing view whose rect meets a face is handed
/// over, and while any is, every face is drawn.
///
/// Foundation- and CoreGraphics-only, so `TugTests` compiles it beside the
/// planner's and the ink reading's tests; `BodyViewController` stands the
/// faces, and takes the shell's snapshot that says when they may retire.

/// One card's face: its card and its view rect, viewport points.
struct HandOverFace: Equatable {
    var cardId: String
    var rect: CGRect
}

/// What one placement hands over.
struct HandOverPlan: Equatable {
    /// Cards whose views are on screen now and that this placement does not show.
    var leaving: [String]
    /// Every face entry's card and view rect, when a hand-over is due; empty otherwise.
    var faces: [HandOverFace]
    /// Leaving views that meet a face: hidden only in the hand-over's transaction.
    var handedOver: [String]
}

enum BodyHandOver {
    /// The hand-over a placement asks for.
    ///
    /// `onScreen` is every body showing now, card id → view rect; `entries`
    /// the placement's. A card is leaving when `entries` does not name it
    /// visible, and handed over when its rect meets some face entry's view
    /// rect. Faces are listed only when something is handed over: with
    /// nothing to cover, the shell's stand-ins show as they are and no
    /// snapshot is taken.
    static func plan(onScreen: [String: CGRect], entries: [CardPlacementEntry]) -> HandOverPlan {
        let shown = Set(entries.filter(\.visible).map(\.cardId))
        let leaving = onScreen.keys.filter { !shown.contains($0) }.sorted()
        let faces = faceEntries(entries)
        let handedOver = leaving.filter { cardId in
            guard let rect = onScreen[cardId] else { return false }
            return faces.contains { meets(rect, $0.rect) }
        }
        return HandOverPlan(leaving: leaving, faces: handedOver.isEmpty ? [] : faces, handedOver: handedOver)
    }

    /// Every entry the shell marked `face` and read a display list for, in
    /// the placement's order: a face with no list is one the host cannot
    /// draw, and the shell holds a view over it for its paint instead.
    static func faceEntries(_ entries: [CardPlacementEntry]) -> [HandOverFace] {
        entries.filter { $0.face == true && $0.faceDraw != nil }.map { HandOverFace(cardId: $0.cardId, rect: $0.view.cgRect) }
    }

    /// Whether a placement's hand-over is the one already pending, re-posted:
    /// the same views handed over, to the same faces at the same rects. A
    /// pending hand-over goes on untouched under such a placement — same
    /// serial, same snapshot, same horizon — so a stream of re-measurements
    /// cannot hold the faces up past their horizon.
    static func continues(pending: HandOverPlan, next: HandOverPlan) -> Bool {
        let byCard = { (faces: [HandOverFace]) in faces.sorted { $0.cardId < $1.cardId } }
        return Set(pending.handedOver) == Set(next.handedOver) && byCard(pending.faces) == byCard(next.faces)
    }

    /// A face's colour, from the `rgba(r, g, b, a)` the shell writes; nil
    /// for anything else.
    static func color(rgba: String) -> CGColor? {
        let s = rgba.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("rgba("), s.hasSuffix(")") else { return nil }
        let parts = s.dropFirst(5).dropLast().split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4, let r = parts[0], let g = parts[1], let b = parts[2], let a = parts[3] else { return nil }
        return CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }

    /// Whether two rects share some area: an edge in common is not a meeting.
    static func meets(_ a: CGRect, _ b: CGRect) -> Bool {
        let i = a.intersection(b)
        return !i.isNull && i.width > 0 && i.height > 0
    }

    /// The smallest rect holding every face, or nil for none.
    static func union(_ faces: [HandOverFace]) -> CGRect? {
        guard let first = faces.first else { return nil }
        return faces.dropFirst().reduce(first.rect) { $0.union($1.rect) }
    }

    /// `face`'s crop of a snapshot taken over `union` at `scale` image pixels
    /// per point, in the image's pixels, top-left origin.
    static func cropRect(of face: CGRect, in union: CGRect, scale: CGFloat) -> CGRect {
        CGRect(
            x: (face.minX - union.minX) * scale,
            y: (face.minY - union.minY) * scale,
            width: face.width * scale,
            height: face.height * scale
        ).integral
    }

    // MARK: - The title band's ink

    /// The title line, from the pane's top edge, in points: inside the
    /// one-line bar every masthead begins with. Row 44's `TITLE_TOP` and
    /// `TITLE_HEIGHT`.
    static let titleTop: CGFloat = 6
    static let titleHeight: CGFloat = 20
    /// How far in from each side of the pane the band runs, points.
    static let titleSideInset: CGFloat = 8
    /// How far, in any one channel, from the band's commonest colour a pixel
    /// must lie to be the title's ink: row 44's `INK_REACH`.
    static let inkReach = 60

    /// A face's title band within its crop, in the crop's pixels: from
    /// `titleTop` to `titleTop + titleHeight` below the pane's top, and
    /// `titleSideInset` inside each side of the pane, the pane standing at
    /// `insets` within a view `viewSize` points wide.
    static func titleBand(viewSize: CGSize, insets: CardInsets, scale: CGFloat) -> CGRect {
        let x0 = CGFloat(insets.left) + titleSideInset
        let x1 = viewSize.width - CGFloat(insets.right) - titleSideInset
        let y0 = CGFloat(insets.top) + titleTop
        return CGRect(x: x0 * scale, y: y0 * scale, width: max(0, x1 - x0) * scale, height: titleHeight * scale)
    }

    /// The share of `band`'s pixels lying farther than `inkReach` from the
    /// band's commonest colour, in any channel: ink on its surface. Reads
    /// every second pixel each way, as row 44 does. `rgba` is `width` ×
    /// `height` pixels of 8-bit RGBA, rows top to bottom.
    static func inkShare(rgba: [UInt8], width: Int, height: Int, band: CGRect) -> Double {
        let x0 = max(0, Int(band.minX.rounded(.down)))
        let y0 = max(0, Int(band.minY.rounded(.down)))
        let x1 = min(width, Int(band.maxX.rounded(.up)))
        let y1 = min(height, Int(band.maxY.rounded(.up)))
        guard x0 < x1, y0 < y1 else { return 0 }
        var pixels: [UInt32] = []
        var counts: [UInt32: Int] = [:]
        for y in stride(from: y0, to: y1, by: 2) {
            for x in stride(from: x0, to: x1, by: 2) {
                let i = (y * width + x) * 4
                let key = UInt32(rgba[i]) << 16 | UInt32(rgba[i + 1]) << 8 | UInt32(rgba[i + 2])
                pixels.append(key)
                counts[key, default: 0] += 1
            }
        }
        guard let fill = counts.max(by: { $0.value < $1.value })?.key else { return 0 }
        let channel = { (key: UInt32, shift: UInt32) in Int((key >> shift) & 255) }
        let ink = pixels.filter { p in
            [16, 8, 0].contains { abs(channel(p, $0) - channel(fill, $0)) > inkReach }
        }.count
        return Double(ink) / Double(max(1, pixels.count))
    }

    /// `image`'s ink share over `band` (`inkShare(rgba:…)`), its pixels drawn
    /// into an RGBA buffer first; nil when the image cannot be drawn.
    static func inkShare(image: CGImage, band: CGRect) -> Double? {
        guard let rgba = rgbaBytes(of: image) else { return nil }
        return inkShare(rgba: rgba, width: image.width, height: image.height, band: band)
    }

    /// `image`'s pixels as 8-bit RGBA, rows top to bottom.
    static func rgbaBytes(of image: CGImage) -> [UInt8]? {
        let width = image.width
        let height = image.height
        guard width > 0, height > 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? bytes : nil
    }
}
