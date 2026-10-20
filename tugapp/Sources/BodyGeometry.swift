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
}

