import Foundation

/// Where the pointer goes when bodies sit beneath the shell, and the one
/// coordinate flip the host needs to answer it.
///
/// The shell's web view covers the whole window and is transparent where a
/// body shows through. A point inside a visible body's frame is the body's,
/// unless the shell has claimed it: a sheet, popover, scrim or dialog the shell
/// raises over a card posts `pointerClaim` with the rects it covers, or `all`
/// when it covers the window. This is that rule over plain rects, so it is
/// tested without a window. Frames and claims are in the shell's viewport
/// coordinates — top-left origin, CSS px, which equal the shell view's points
/// because the shell's `pageZoom` stays 1.0. Foundation-only, so `TugTests`
/// compiles it.
struct BodyHitRegion: Equatable {
    /// What the shell has claimed over the bodies.
    enum Claim: Equatable {
        case none
        case rects([CGRect])
        case all
    }

    /// The frames of the bodies placed visible. A hidden body is never here.
    var visibleFrames: [CGRect] = []
    /// Each visible body's pane grips — the resize handles, which lie half
    /// over the body — parallel to `visibleFrames`. In a document the handle
    /// is above the content, so a point on one is the shell's.
    var visibleGrips: [[CGRect]] = []
    /// Each visible body's card hit shape when the card draws its own chrome,
    /// parallel to `visibleFrames`, or nil for a content box under the
    /// shell's chrome. A whole card's view reaches the apron past its pane,
    /// and a point there is the card's only along an edge it grips; its grips
    /// are its own page's DOM, so of it the shell keeps only its own controls
    /// standing over the card (the place seams), which its `visibleGrips`
    /// carry.
    var visibleShapes: [CardHitShape?] = []
    var claim: Claim = .none

    /// Whether a viewport point belongs to a body rather than to the shell.
    func passesThrough(_ point: CGPoint) -> Bool {
        frameIndex(at: point) != nil
    }

    /// The index into `visibleFrames` of the body a point passes through to,
    /// or nil when the point is the shell's. Front to back, the first body
    /// whose grips or frame hold the point answers: a grip keeps the point
    /// in the shell — a front pane's handle hanging over the body behind it
    /// included — and a frame passes it through.
    func frameIndex(at point: CGPoint) -> Int? {
        switch claim {
        case .all:
            return nil
        case .rects(let rects):
            if rects.contains(where: { $0.contains(point) }) { return nil }
        case .none:
            break
        }
        for (index, frame) in visibleFrames.enumerated() {
            if index < visibleShapes.count, let shape = visibleShapes[index] {
                if index < visibleGrips.count, visibleGrips[index].contains(where: { $0.contains(point) }) { return nil }
                if shape.contains(point) { return index }
                continue
            }
            if index < visibleGrips.count, visibleGrips[index].contains(where: { $0.contains(point) }) { return nil }
            if frame.contains(point) { return index }
        }
        return nil
    }
}

/// A `pointerClaim` body: `{all: true}`, or `{rects: [...]}`, where an empty
/// list is no claim. Anything else — a rect that is not one, neither field —
/// is refused whole.
extension BodyHitRegion.Claim: Decodable {
    private enum CodingKeys: String, CodingKey { case all, rects }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decodeIfPresent(Bool.self, forKey: .all) == true {
            self = .all
            return
        }
        let rects = try container.decode([PlanRect].self, forKey: .rects).map(\.cgRect)
        self = rects.isEmpty ? .none : .rects(rects)
    }
}

/// The flip between AppKit's bottom-left coordinates and the viewport's
/// top-left ones, within a view of a given height. Its own inverse.
enum BodyGeometry {
    static func flipped(_ point: CGPoint, inHeight height: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: height - point.y)
    }

    static func flipped(_ rect: CGRect, inHeight height: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
    }

    /// The tugbank domain the host's deck settings live in. Every card is a
    /// body; there is no setting that turns them off.
    static let deckDomain = "dev.tugapp.deck"

    /// How long a body has to report ready: `fallback` (the decided ten
    /// seconds), unless the harness shortens it with
    /// `TUG_BODY_READY_DEADLINE_MS` so a fallback case does not wait the
    /// whole deadline. Outside the harness the variable is not read, and a
    /// value that is not a positive whole number is ignored.
    static func readyDeadlineMs(environment: [String: String], fallback: Int) -> Int {
        guard environment["TUGAPP_TEST_SOCKET"] != nil,
              let raw = environment["TUG_BODY_READY_DEADLINE_MS"],
              let ms = Int(raw), ms > 0 else { return fallback }
        return ms
    }

    /// Where a body's beats begin against the chrome's, in display periods:
    /// the render server shows a host layer change a little before the
    /// shell's composite shows the chrome's, and this late start is what
    /// lines the two up. Shipped as the median lead read at an offset of 0
    /// (`row-15-skew`): 0.20 periods at 60 Hz, the body a few ms ahead of
    /// the chrome; `dev.tugapp.deck` / `bodyBeatOffsetPeriods` is the user's
    /// override of it, never where it lives.
    static let shippedBeatOffsetPeriods: Double = 0.2
    static let beatOffsetKey = "bodyBeatOffsetPeriods"

    /// The offset the host runs beats at: `TUG_BODY_BEAT_OFFSET_PERIODS`
    /// under the harness, so a test reads the skew at any offset without
    /// writing tugbank; else the tugbank setting; else the shipped value.
    /// A value that is not a finite number is ignored at either level.
    static func beatOffsetPeriods(environment: [String: String], setting: Double?) -> Double {
        if environment["TUGAPP_TEST_SOCKET"] != nil,
           let raw = environment["TUG_BODY_BEAT_OFFSET_PERIODS"],
           let periods = Double(raw), periods.isFinite {
            return periods
        }
        if let setting, setting.isFinite { return setting }
        return shippedBeatOffsetPeriods
    }
}

/// The deck canvas's grid as the host's floor draws it, from the shell's
/// `floorGrid`: the canvas colour, the grid colour, and lines every
/// `cellPx × zoom` points from the deck root's viewport origin, each
/// `linePx × zoom` wide, on the top and left edge of each cell — what
/// `linear-gradient(grid 1px, transparent 1px)` at `background-size: 24px
/// 24px` paints inside the deck root's `scale(zoom)`. Pure arithmetic over
/// viewport points, so `TugTests` checks it without a window; the floor
/// view only fills what `lines(in:scale:)` returns.
struct FloorGrid: Equatable {
    /// A colour in sRGB components, 0…1.
    struct RGBA: Equatable {
        var r: Double
        var g: Double
        var b: Double
        var a: Double
    }

    /// Where the lines fall, in viewport points, and how wide each is.
    struct Lines: Equatable {
        /// The left edge of each vertical line.
        var xs: [CGFloat]
        /// The top edge of each horizontal line.
        var ys: [CGFloat]
        var width: CGFloat
    }

    var canvas = RGBA(r: 0, g: 0, b: 0, a: 1)
    var grid = RGBA(r: 0, g: 0, b: 0, a: 0)
    var cellPx: Double = 24
    var linePx: Double = 1
    var zoom: Double = 1
    var originX: Double = 0
    var originY: Double = 0

    /// The one rounding rule: a position or width in points, on the device
    /// pixel nearest it at `scale`. Named so the composite reading against
    /// the page's own grid has one place to change it.
    static func roundToDevicePixel(_ value: CGFloat, scale: CGFloat) -> CGFloat {
        guard scale > 0 else { return value }
        return (value * scale).rounded() / scale
    }

    /// Every line inside `size`, from the origin onward, at `scale`. A line
    /// is never narrower than one device pixel, as the page's never is.
    func lines(in size: CGSize, scale: CGFloat) -> Lines {
        let step = CGFloat(cellPx * zoom)
        let onePixel = scale > 0 ? 1 / scale : 1
        let width = max(onePixel, FloorGrid.roundToDevicePixel(CGFloat(linePx * zoom), scale: scale))
        guard step > 0 else { return Lines(xs: [], ys: [], width: width) }
        func positions(from origin: CGFloat, to end: CGFloat) -> [CGFloat] {
            var out: [CGFloat] = []
            var k: CGFloat = 0
            while origin + k * step < end {
                out.append(FloorGrid.roundToDevicePixel(origin + k * step, scale: scale))
                k += 1
            }
            return out
        }
        return Lines(
            xs: positions(from: CGFloat(originX), to: size.width),
            ys: positions(from: CGFloat(originY), to: size.height),
            width: width
        )
    }

    /// `#rrggbb` or `rgba(r, g, b, a)` — the two forms the shell posts — as
    /// components, or nil.
    static func color(from text: String) -> RGBA? {
        let s = text.trimmingCharacters(in: .whitespaces).lowercased()
        if s.hasPrefix("#"), s.count == 7, let v = UInt32(s.dropFirst(), radix: 16) {
            return RGBA(
                r: Double((v >> 16) & 0xff) / 255,
                g: Double((v >> 8) & 0xff) / 255,
                b: Double(v & 0xff) / 255,
                a: 1
            )
        }
        guard s.hasPrefix("rgba("), s.hasSuffix(")") else { return nil }
        let parts = s.dropFirst(5).dropLast().split(separator: ",").map {
            Double($0.trimmingCharacters(in: .whitespaces))
        }
        guard parts.count == 4, let r = parts[0], let g = parts[1], let b = parts[2], let a = parts[3] else {
            return nil
        }
        return RGBA(r: r / 255, g: g / 255, b: b / 255, a: a)
    }
}

/// A `floorGrid` body. A field missing, or a colour in neither form the
/// shell posts, refuses it whole.
extension FloorGrid: Decodable {
    private enum CodingKeys: String, CodingKey { case canvas, grid, cellPx, linePx, zoom, originX, originY }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func color(_ key: CodingKeys) throws -> RGBA {
            guard let rgba = FloorGrid.color(from: try container.decode(String.self, forKey: key)) else {
                throw DecodingError.dataCorruptedError(
                    forKey: key, in: container, debugDescription: "not #rrggbb or rgba(r, g, b, a)"
                )
            }
            return rgba
        }
        self.init(
            canvas: try color(.canvas),
            grid: try color(.grid),
            cellPx: try container.decode(Double.self, forKey: .cellPx),
            linePx: try container.decode(Double.self, forKey: .linePx),
            zoom: try container.decode(Double.self, forKey: .zoom),
            originX: try container.decode(Double.self, forKey: .originX),
            originY: try container.decode(Double.self, forKey: .originY)
        )
    }
}
