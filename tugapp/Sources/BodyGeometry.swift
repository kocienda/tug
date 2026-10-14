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
    var claim: Claim = .none

    /// Whether a viewport point belongs to a body rather than to the shell.
    func passesThrough(_ point: CGPoint) -> Bool {
        switch claim {
        case .all:
            return false
        case .rects(let rects):
            if rects.contains(where: { $0.contains(point) }) { return false }
        case .none:
            break
        }
        return visibleFrames.contains(where: { $0.contains(point) })
    }

    /// The index into `visibleFrames` of the body a point passes through to,
    /// or nil when the point is the shell's.
    func frameIndex(at point: CGPoint) -> Int? {
        guard passesThrough(point) else { return nil }
        return visibleFrames.firstIndex(where: { $0.contains(point) })
    }

    /// Read a `pointerClaim` body: `{all: true}`, `{rects: [...]}`; anything
    /// else (an empty list included) is no claim.
    static func claim(fromPayload payload: [String: Any]) -> Claim {
        if payload["all"] as? Bool == true { return .all }
        let rects = (payload["rects"] as? [[String: Any]] ?? []).compactMap(rect(fromPayload:))
        return rects.isEmpty ? .none : .rects(rects)
    }

    /// A `{x, y, width, height}` dictionary as a rect, or nil when a field is
    /// missing or not a number.
    static func rect(fromPayload payload: [String: Any]) -> CGRect? {
        guard let x = (payload["x"] as? NSNumber)?.doubleValue,
              let y = (payload["y"] as? NSNumber)?.doubleValue,
              let width = (payload["width"] as? NSNumber)?.doubleValue,
              let height = (payload["height"] as? NSNumber)?.doubleValue else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
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

    /// Whether this host makes body views: yes in an ordinary launch; under
    /// the app-test harness (`TUGAPP_TEST_SOCKET` set) only when the test asks
    /// for them with `TUG_BODY_VIEWS=1`, so the harness corpus keeps running
    /// every card in the shell until it opts in.
    static func bodyViewsEnabled(environment: [String: String]) -> Bool {
        guard environment["TUGAPP_TEST_SOCKET"] != nil else { return true }
        return environment["TUG_BODY_VIEWS"] == "1"
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
