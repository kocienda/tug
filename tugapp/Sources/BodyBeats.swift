import Foundation

/// The host's half of the card plan: what the shell's `cardPlan` says, the one
/// clock both sides agree on, and the one track per property per card the
/// host runs it as.
///
/// The shell plans each card's beats at the moment its settle plans the
/// stand-ins' (`lib/card-plan.ts`) and posts the rects each beat starts and
/// ends at, its delay and duration from the plan's wall-clock start, and the
/// progress samples the chrome beat was built from. The host does not
/// re-derive a curve: it plays the samples it was given, linearly between
/// them, so the whole card rides the chrome's own curve. A card's view is
/// the container whole: there is no inset body under a pane to carry
/// separately, and a placement names the plan it lands by `planId` rather
/// than by a rect the host would have to recognise ([B11]).
///
/// Foundation-only, so `TugTests` compiles it and checks it against the
/// shell's parity fixture; `BodyViewController` turns a `Track` into
/// `CAKeyframeAnimation`s.

/// A viewport rect as the plan carries it, `{x, y, width, height}` in px.
struct PlanRect: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// One beat of one card.
struct BodyBeat: Decodable, Equatable {
    var kind: String
    /// From the plan's `startWallMs`, already scaled by the shell's timing.
    var delayMs: Double
    var durationMs: Double
    var from: PlanRect
    var to: PlanRect
    /// Start and end opacity; nil means 1 → 1.
    var opacity: [Double]?
    /// Evenly spaced in time, first 0 and last 1; may overshoot.
    var progress: [Double]
    /// For a two-value `progress`: the chrome's keyword easing.
    var easing: String?
}

/// One card's beats in a plan.
struct PlannedCard: Decodable, Equatable {
    struct Size: Decodable, Equatable {
        var width: Double
        var height: Double
    }

    var cardId: String
    /// The view's rect at rest after the plan: the container's model value.
    var landing: PlanRect
    /// Present when the card's box changes size.
    var crossing: Size?
    /// The card was not shown before the plan: an arrival, which the host
    /// shows in the same transaction as its tracks.
    var arrives: Bool?
    var beats: [BodyBeat]
}

/// The `cardPlan` message body.
struct CardPlan: Decodable, Equatable {
    var planId: Int
    /// The settle's t = 0 on the wall clock, ms since 1970.
    var startWallMs: Double
    /// Some card's box changes size: the host lays each such page out at
    /// its crossing size before the plan starts, and says `planStarted`.
    var solves: Bool
    var cards: [PlannedCard]
}

/// One pair of readings of the two clocks, taken together when a plan
/// arrives: the wall clock the shell's start is on, and the media clock Core
/// Animation's `beginTime` is on. Taken afresh for every plan, so a wake
/// that moved one clock against the other is re-anchored by construction.
struct ClockAnchor: Equatable {
    /// Wall-clock ms since 1970.
    var wallMs: Double
    /// `CACurrentMediaTime()`, seconds.
    var mediaTime: Double

    /// The media time a beat begins at: the plan's start plus the beat's delay,
    /// moved onto the media clock through the anchor. No offset against the
    /// chrome: a card's chrome is in the card, so there is nothing to line the
    /// card up with ([B11]). A time already past is returned as it is: a beat
    /// that arrives late starts mid-curve, which is where the stand-in is.
    func beginTime(startWallMs: Double, delayMs: Double) -> Double {
        mediaTime + (startWallMs + delayMs - wallMs) / 1000
    }
}

/// How a container's frame, in the viewport's top-left points, maps to its
/// layer's `position` and `bounds` — the values a layer animation carries.
///
/// Solved from the layer itself rather than assumed: the container is set to
/// three frames (a base, the base moved by a point, the base grown by a
/// point) and its layer read after each, so whatever AppKit's flip and the
/// layer's anchor make of a frame is measured, not re-derived. Each axis is
/// affine: `position.x = x0 + xByMinX·minX + xByWidth·width`, and likewise
/// for y; `bounds` keeps the layer's origin and takes the frame's size.
struct LayerMapping: Equatable {
    var x0: Double
    var xByMinX: Double
    var xByWidth: Double
    var y0: Double
    var yByMinY: Double
    var yByHeight: Double
    var boundsOrigin: CGPoint

    /// The mapping from the layer's position at `base`, at `base` moved by
    /// (1, 1), and at `base` grown by (1, 1); nil when a frame did not move
    /// the layer, which would leave the mapping with no inverse.
    static func solve(
        base: CGRect, at basePosition: CGPoint, moved movedPosition: CGPoint,
        grown grownPosition: CGPoint, boundsOrigin: CGPoint
    ) -> LayerMapping? {
        let xByMinX = Double(movedPosition.x - basePosition.x)
        let yByMinY = Double(movedPosition.y - basePosition.y)
        guard abs(xByMinX) > 0.5, abs(yByMinY) > 0.5 else { return nil }
        let xByWidth = Double(grownPosition.x - basePosition.x)
        let yByHeight = Double(grownPosition.y - basePosition.y)
        return LayerMapping(
            x0: Double(basePosition.x) - xByMinX * Double(base.minX) - xByWidth * Double(base.width),
            xByMinX: xByMinX,
            xByWidth: xByWidth,
            y0: Double(basePosition.y) - yByMinY * Double(base.minY) - yByHeight * Double(base.height),
            yByMinY: yByMinY,
            yByHeight: yByHeight,
            boundsOrigin: boundsOrigin
        )
    }

    func position(of frame: CGRect) -> CGPoint {
        CGPoint(
            x: x0 + xByMinX * Double(frame.minX) + xByWidth * Double(frame.width),
            y: y0 + yByMinY * Double(frame.minY) + yByHeight * Double(frame.height)
        )
    }

    func bounds(of frame: CGRect) -> CGRect {
        CGRect(origin: boundsOrigin, size: frame.size)
    }

    /// The viewport frame a layer at `position` with `bounds` stands at: the
    /// inverse, for reading a presentation layer back as a rect.
    func frame(position: CGPoint, bounds: CGRect) -> CGRect {
        let w = Double(bounds.width)
        let h = Double(bounds.height)
        return CGRect(
            x: (Double(position.x) - x0 - xByWidth * w) / xByMinX,
            y: (Double(position.y) - y0 - yByHeight * h) / yByMinY,
            width: w,
            height: h
        )
    }
}

/// How a body's beats become layer animations.
enum BodyBeats {
    /// How one segment of a track is timed: linear between samples, or a
    /// fade's keyword easing.
    enum Timing: Equatable {
        case linear
        case easing(String)
    }

    /// One track per property for one body over the whole plan: every beat's
    /// samples placed on one timeline, held across any gap between beats, so
    /// the container never shows its model value (the landing) before the
    /// last beat ends.
    struct Track: Equatable {
        /// The first beat's delay: where the track begins on the plan's clock.
        var delayMs: Double
        /// From the first beat's start to the last beat's end.
        var durationMs: Double
        /// 0…1, non-decreasing, ending at 1; one per value.
        var keyTimes: [Double]
        var rects: [CGRect]
        /// One per value, when any beat carries an opacity; nil otherwise.
        var opacities: [Double]?
        /// One per segment (`rects.count - 1`).
        var timings: [Timing]
    }

    /// The rect at each progress sample between `from` and `to`. The ends are
    /// pinned to `from` and `to` exactly; the samples between keep any
    /// overshoot, as the chrome's keyframes do.
    static func layerValues(from: CGRect, to: CGRect, progress: [Double]) -> [CGRect] {
        guard progress.count >= 2 else { return [from, to] }
        let last = progress.count - 1
        return progress.enumerated().map { i, raw in
            let p = CGFloat(i == 0 ? 0 : i == last ? 1 : raw)
            return CGRect(
                x: from.minX + (to.minX - from.minX) * p,
                y: from.minY + (to.minY - from.minY) * p,
                width: from.width + (to.width - from.width) * p,
                height: from.height + (to.height - from.height) * p
            )
        }
    }

    /// The one track a body's beats play as. Each beat's samples sit at its
    /// delay plus their even share of its duration; where one beat ends as
    /// the next begins the shared point is written once; where a gap lies
    /// between them the earlier beat's `to` holds until the later begins.
    static func planTrack(_ beats: [BodyBeat]) -> Track? {
        let ordered = beats.sorted { $0.delayMs < $1.delayMs }
        guard let first = ordered.first else { return nil }
        let start = first.delayMs
        let end = ordered.map { $0.delayMs + $0.durationMs }.max() ?? start
        let total = end - start
        let carriesOpacity = ordered.contains { $0.opacity != nil }

        var times: [Double] = []
        var rects: [CGRect] = []
        var opacities: [Double] = []
        var timings: [Timing] = []
        // A beat that carries no opacity holds whatever the last fade left.
        var running = ordered.first?.opacity?.first ?? 1
        for beat in ordered {
            let values = layerValues(from: beat.from.cgRect, to: beat.to.cgRect, progress: beat.progress)
            let fades = beat.opacity ?? [running, running]
            let o0 = fades.first ?? running
            let o1 = fades.count > 1 ? fades[1] : o0
            running = o1
            let last = values.count - 1
            let segment: Timing = beat.progress.count == 2 ? .easing(beat.easing ?? "linear") : .linear
            for (i, rect) in values.enumerated() {
                let t = beat.delayMs + beat.durationMs * Double(i) / Double(max(1, last))
                let p = i == 0 ? 0 : i == last ? 1 : beat.progress[i]
                let opacity = o0 + (o1 - o0) * p
                if i == 0, let prior = times.last {
                    if abs(t - prior) < 1e-9 { continue }
                    // A gap: what the last beat left holds until this one begins.
                    timings.append(.linear)
                } else if i > 0 {
                    timings.append(segment)
                }
                times.append(t)
                rects.append(rect)
                opacities.append(opacity)
            }
        }
        let keyTimes = times.map { total > 0 ? ($0 - start) / total : 1 }
        return Track(
            delayMs: start,
            durationMs: total,
            keyTimes: keyTimes,
            rects: rects,
            opacities: carriesOpacity ? opacities : nil,
            timings: timings
        )
    }

    /// The band a folding whole card's bottom edge carries
    /// (`lib/crossing-band.ts`), in the container's points: the folded form's
    /// bottom band, which the page names, and where it stood in the open
    /// form the card's cover shows.
    struct CrossingBand: Equatable {
        /// The band's top in the open form — in the cover — from the top.
        var restTop: Double
        /// The band's own height.
        var height: Double
        /// From the band's top to the page's bottom in the folded form: the
        /// band and the card's bottom edge below it.
        var reach: Double

        /// The card's bottom edge alone, below the band: it rides the closing
        /// edge from the first frame.
        var cap: Double { max(0, reach - height) }

        /// The band from the page's own reading, CSS px, scaled by the
        /// page's points per CSS px; nil for a reading that cannot be
        /// carried.
        init?(restFromBottom: Double, top: Double, height: Double, viewport: Double, scale: Double, coverHeight: Double) {
            guard viewport > 0, scale > 0, height >= 0, top >= 0, top <= viewport else { return nil }
            self.restTop = coverHeight - restFromBottom * scale
            self.height = height * scale
            self.reach = (viewport - top) * scale
            guard restTop > 0, restTop + reach <= coverHeight + 0.5 else { return nil }
        }

        init(restTop: Double, height: Double, reach: Double) {
            self.restTop = restTop
            self.height = height
            self.reach = reach
        }
    }

    /// The band's ride over one track: at each key, where the page stands
    /// below its model place — its bottom on the container's, `height` less
    /// the landing's — and how much of the cover shows above the live page.
    struct BandRide: Equatable {
        var keyTimes: [Double]
        var pageOffsets: [Double]
        var coverHeights: [Double]
        var timings: [Timing]
    }

    /// How long the cover's step at the hand-over lasts, as a fraction of
    /// the track: short enough to land inside one frame.
    static let bandStep = 1e-6

    /// Carry `band` over `track`, whose rects are the container's. The page
    /// rides bottom-pinned from the first frame, so the card's bottom edge
    /// is always its own. The band holds its open place in the cover — the
    /// cover shows down to the cap — until the closing edge reaches it, and
    /// from then the live band rides the edge — the cover shows down to the
    /// band's top. The hand-over is a step at the moment the edge passes the
    /// band's rest, when the live band stands exactly where the cover's did,
    /// so it shows nothing; a key is put at it, on a linear segment, which a
    /// fold's spring samples always are.
    static func bandRide(_ track: Track, band: CrossingBand, landingHeight: Double) -> BandRide {
        let heights = track.rects.map { Double($0.height) }
        let riding = { (h: Double) in h - band.reach <= band.restTop }
        let cover = { (h: Double) in riding(h) ? h - band.reach : h - band.cap }
        var keyTimes: [Double] = []
        var offsets: [Double] = []
        var covers: [Double] = []
        var timings: [Timing] = []
        for (i, h) in heights.enumerated() {
            if i > 0 {
                let h0 = heights[i - 1]
                if riding(h0) != riding(h), abs(h0 - h) > 1e-9 {
                    // The edge passes the band's rest inside this segment.
                    let edge = band.restTop + band.reach
                    let f = min(1, max(0, (h0 - edge) / (h0 - h)))
                    let t = keyTimes[keyTimes.count - 1] + (track.keyTimes[i] - track.keyTimes[i - 1]) * f
                    let step = min(bandStep, max(0, track.keyTimes[i] - t) / 2)
                    let before = riding(h0) ? band.restTop : band.restTop + band.height
                    let after = riding(h) ? band.restTop : band.restTop + band.height
                    keyTimes += [t, t + step]
                    offsets += [edge - landingHeight, edge - landingHeight]
                    covers += [before, after]
                    // A split segment is linear, whatever it was.
                    timings += [.linear, .linear, .linear]
                } else {
                    timings.append(i - 1 < track.timings.count ? track.timings[i - 1] : .linear)
                }
            }
            keyTimes.append(track.keyTimes[i])
            offsets.append(h - landingHeight)
            covers.append(cover(h))
        }
        return BandRide(keyTimes: keyTimes, pageOffsets: offsets, coverHeights: covers, timings: timings)
    }

    /// How a covered whole card rides a change of height that is not a fold
    /// (`lib/crossing-band.ts`'s anchor), in the container's points: the
    /// cover splits at `splitY`; its head hangs from the top and its tail
    /// from the moving bottom edge, and the page hangs from the bottom too
    /// when its content follows it, so composer and band ride the edge from
    /// the first frame and the land shows what the last frame did.
    struct CoverSplit: Equatable {
        var splitY: Double
        var follows: Bool

        /// From the page's reading, CSS px in the solved form, scaled by the
        /// page's points per CSS px. A following card splits at its
        /// scroller's top, the same in both forms; one that does not splits
        /// at its bottom band, fixed from the bottom. Nil for a split the
        /// cover cannot carry.
        init?(splitTop: Double, follows: Bool, viewport: Double, scale: Double, coverHeight: Double) {
            guard viewport > 0, scale > 0, splitTop >= 0, splitTop <= viewport else { return nil }
            self.follows = follows
            self.splitY = follows ? splitTop * scale : coverHeight - (viewport - splitTop) * scale
            guard splitY > 0, splitY < coverHeight else { return nil }
        }

        init(splitY: Double, follows: Bool) {
            self.splitY = splitY
            self.follows = follows
        }
    }

    /// Where a split cover's tail and the page stand at each key of a
    /// track: the tail's top — the whole frame's, bottom-pinned, of which
    /// the rows below the split show — and the page's offset below its
    /// model place, both from the container's top.
    struct SplitRide: Equatable {
        var tailTops: [Double]
        var pageOffsets: [Double]
    }

    /// Carry `split` over `track`, whose rects are the container's: the
    /// tail's bottom on the edge throughout, and the page's bottom on it
    /// when the content follows, else the page where it stands.
    static func splitRide(_ track: Track, split: CoverSplit, coverHeight: Double, landingHeight: Double) -> SplitRide {
        let heights = track.rects.map { Double($0.height) }
        return SplitRide(
            tailTops: heights.map { $0 - coverHeight },
            pageOffsets: heights.map { split.follows ? $0 - landingHeight : 0 }
        )
    }
}
