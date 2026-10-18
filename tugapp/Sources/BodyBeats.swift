import Foundation

/// The host's half of the beat plan: what the shell's `beatPlan` says, the one
/// clock both sides agree on, and the one track per property per body the
/// host runs it as.
///
/// The shell plans each body's beats at the moment its settle plans the
/// chrome's (`lib/body-beat-plan.ts`) and posts the rects each beat starts and
/// ends at, its delay and duration from the plan's wall-clock start, and the
/// progress samples the chrome beat was built from. The host does not
/// re-derive a curve: it plays the samples it was given, linearly between
/// them, so the body rides the chrome's own curve.
///
/// Foundation-only, so `TugTests` compiles it and checks it against the
/// shell's parity fixture; `BodyViewController` turns a `Track` into
/// `CAKeyframeAnimation`s.

/// A viewport rect as the plan carries it, `{x, y, width, height}` in px.
struct PlanRect: Decodable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// One beat of one body.
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

/// One body's beats in a plan.
struct PlannedBody: Decodable, Equatable {
    struct Size: Decodable, Equatable {
        var width: Double
        var height: Double
    }

    var cardId: String
    /// The rect at rest after the plan: the container's model value.
    var landing: PlanRect
    /// Present when the body's box changes size.
    var crossing: Size?
    /// The body was not shown before the plan: an arrival, which the host
    /// shows in the same transaction as its tracks.
    var arrives: Bool?
    var beats: [BodyBeat]
}

/// The `beatPlan` message body.
struct BeatPlan: Decodable, Equatable {
    var planId: Int
    /// The settle's t = 0 on the wall clock, ms since 1970.
    var startWallMs: Double
    var bodies: [PlannedBody]

    /// Read a `beatPlan` body as WebKit hands it over, or nil when it does not decode.
    static func from(payload: [String: Any]) -> BeatPlan? {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return try? JSONDecoder().decode(BeatPlan.self, from: data)
    }
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
    /// moved onto the media clock through the anchor, plus the host's offset.
    /// A time already past is returned as it is: a beat that arrives late
    /// starts mid-curve, which is where the chrome is.
    func beginTime(startWallMs: Double, delayMs: Double, offsetSec: Double) -> Double {
        mediaTime + (startWallMs + delayMs - wallMs) / 1000 + offsetSec
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
}
