import Foundation

/// The flip between AppKit's bottom-left coordinates and the viewport's
/// top-left ones, within a view of a given height — its own inverse — and
/// how long a body has to report ready. Which card a point is lives with the
/// card's geometry (`CardHitRegion`, `CardGeometry.swift`). Foundation-only,
/// so `TugTests` compiles it.
enum BodyGeometry {
    static func flipped(_ point: CGPoint, inHeight height: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: height - point.y)
    }

    static func flipped(_ rect: CGRect, inHeight height: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
    }

    /// How long a body has to report ready: `fallback` (the decided ten
    /// seconds), unless the harness set a deadline of its own through
    /// `bodyDelays` so a fallback case does not wait the whole deadline. A
    /// harness deadline is held to at least a millisecond.
    static func readyDeadlineMs(harness: Double?, fallback: Int) -> Int {
        harness.map { max(1, Int($0)) } ?? fallback
    }
}

