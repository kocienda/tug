#if DEBUG
import AppKit
import Foundation
import WebKit

// MARK: - CoordMapping
//
// Converts a WebView viewport (CSS) point into a CoreGraphics screen
// point suitable for `CGEvent.post`. The conversion touches four
// coordinate systems:
//
//   1. Viewport / CSS       — Y-down, origin top-left of WKWebView content.
//   2. WKWebView view-local — AppKit Y-up, origin bottom-left of the view.
//   3. Window-local         — AppKit Y-up, origin bottom-left of the window.
//   4. Screen AppKit        — Y-up, origin bottom-left of the PRIMARY screen.
//   5. Screen CG            — Y-down, origin top-left of the PRIMARY screen.
//
// The multi-step transform is load-bearing for Phase A: every native
// CGEvent posted by the harness passes through this function to
// translate a selector's `getBoundingClientRect()` center into the
// screen coordinate `CGEvent.post` expects.
//
// ## Multi-display note
//
// Viewport→screen flip reference is the PRIMARY screen (the one that
// contains the menu bar — `NSScreen.screens.first`), NOT the screen
// containing the key window (`NSScreen.main`). On a single-display
// setup the two are identical; on a multi-display rig Tug.app may
// sit on a secondary display, but AppKit→CG flip math still uses the
// primary screen's height as the reference.
//
// ## Out-of-bounds policy
//
// Viewport points outside the WKWebView's CSS viewport return nil.
// Callers (the CGEvent verb dispatchers) translate nil
// into the `CoordinateOutOfBoundsError` RPC response so the TS
// harness can surface a typed error. Out-of-bounds on the window or
// display also return nil — there is no ambiguity about which
// failure mode; the caller just retries with a valid point.
//
// ## Pure-math split
//
// Two halves are pure and testable without AppKit objects:
//
//   - `viewportToViewLocalPure` (step 1→2, Y-flip inside the view)
//   - `appKitScreenToCGPure` (step 4→5, Y-flip on the primary screen)
//
// The full-chain `viewportToScreen` composes the pure halves with
// the `webView.convert(_:to:)` and `window.convertToScreen(_:)`
// AppKit calls. The pure halves have regression cases pinned in
// `runPureMathUnitTests()`; the full chain is exercised end-to-end
// by the coord-round-trip experiment.

enum CoordMapping {

    // MARK: - Pure math (unit-testable, no AppKit objects)

    /// Viewport (CSS, Y-down, origin top-left of view) →
    /// view-local AppKit (Y-up, origin bottom-left of view). Returns
    /// nil when `p` is outside `[0, viewSize.width] × [0, viewSize.height]`.
    static func viewportToViewLocalPure(_ p: CGPoint, viewSize: CGSize) -> CGPoint? {
        guard p.x >= 0, p.x <= viewSize.width,
              p.y >= 0, p.y <= viewSize.height else {
            return nil
        }
        return CGPoint(x: p.x, y: viewSize.height - p.y)
    }

    /// Screen AppKit (Y-up, origin bottom-left of primary
    /// screen) → CG screen (Y-down, origin top-left of primary
    /// screen). Y-flip uses the primary screen's height regardless
    /// of which display `p` logically sits on — the CG coordinate
    /// space is rooted at the primary screen.
    static func appKitScreenToCGPure(_ p: CGPoint, primaryScreenHeight: CGFloat) -> CGPoint {
        return CGPoint(x: p.x, y: primaryScreenHeight - p.y)
    }

    // MARK: - Full chain (composes pure halves with AppKit calls)

    /// Convert a viewport (CSS) point to a CG screen point that
    /// `CGEvent.post` accepts. Returns nil if the point is outside
    /// the WKWebView's viewport, or the webView is detached from a
    /// window.
    ///
    /// Strategy: WKWebView's default coordinate system for its
    /// content is Y-down (matches web / CSS convention, not AppKit
    /// Y-up). `webView.convert(point, to: nil)` understands the
    /// input as Y-down view-local and returns AppKit Y-up window
    /// coords — the Y-flip is baked into the convert call. We
    /// pass viewport (CSS) coords directly, then translate window →
    /// screen AppKit → screen CG.
    ///
    /// The older version of this function pre-flipped viewport to
    /// view-local Y-up, which double-flipped and produced wildly
    /// wrong coords on multi-display rigs (the empirically-observed
    /// bug was clicks landing near the window's BOTTOM instead of
    /// near the TOP). The fix is "don't pre-flip; trust convert".
    ///
    /// A viewport coord is already a view point. View › Zoom is a CSS
    /// transform on the deck root and `pageZoom` stays 1.0, so a DOM rect
    /// or pointer coordinate is measured in the window's own space with
    /// the zoom applied, and nothing scales it on the way in.
    ///
    /// - Parameter viewportPoint: DOM-space coord, Y-down origin top-left.
    /// - Parameter webView: the live WKWebView owning the document.
    /// - Returns: CG-space screen coord ready for `CGEvent.post`, or
    ///   nil for out-of-bounds or detached-window cases.
    static func viewportToScreen(_ viewportPoint: CGPoint, in webView: WKWebView) -> CGPoint? {
        let viewSize = webView.bounds.size
        let viewLocal = viewportPoint
        guard viewLocal.x >= 0, viewLocal.x <= viewSize.width,
              viewLocal.y >= 0, viewLocal.y <= viewSize.height else {
            return nil
        }
        guard let window = webView.window else { return nil }

        // Pass viewport (Y-down) directly to convert. WKWebView's
        // content coordinate system is Y-down, so the `convert` call
        // flips Y into the window's Y-up system for us.
        let windowPoint = webView.convert(viewLocal, to: nil)
        let screenAppKitPoint = window.convertToScreen(
            NSRect(origin: windowPoint, size: .zero),
        ).origin
        let primaryScreenHeight = NSScreen.screens.first?.frame.height ?? 0
        return appKitScreenToCGPure(
            screenAppKitPoint,
            primaryScreenHeight: primaryScreenHeight,
        )
    }

    // MARK: - Pure-math unit tests (hand-rolled; no XCTest dependency)

    /// Regression cases pinning the pure-math halves. Invoked from
    /// the spike harness; becomes XCTest's fixture source when wired to a test target.
    ///
    /// Returns a list of (case name, passed) pairs. Empty = every
    /// case passed. Callers NSLog the failures for diagnosis.
    static func runPureMathUnitTests() -> [(String, Bool)] {
        var results: [(String, Bool)] = []

        // viewportToViewLocalPure — inside-bounds round trip.
        do {
            let got = viewportToViewLocalPure(
                CGPoint(x: 100, y: 50),
                viewSize: CGSize(width: 400, height: 300),
            )
            let expected = CGPoint(x: 100, y: 250)
            let ok = got == expected
            results.append(("viewportToViewLocal inside-bounds (100,50)/(400,300) -> (100,250)", ok))
        }

        // viewportToViewLocalPure — top-left CSS origin.
        do {
            let got = viewportToViewLocalPure(
                CGPoint(x: 0, y: 0),
                viewSize: CGSize(width: 400, height: 300),
            )
            let expected = CGPoint(x: 0, y: 300)
            let ok = got == expected
            results.append(("viewportToViewLocal top-left (0,0)/(400,300) -> (0,300)", ok))
        }

        // viewportToViewLocalPure — bottom-right CSS extent.
        do {
            let got = viewportToViewLocalPure(
                CGPoint(x: 400, y: 300),
                viewSize: CGSize(width: 400, height: 300),
            )
            let expected = CGPoint(x: 400, y: 0)
            let ok = got == expected
            results.append(("viewportToViewLocal bottom-right (400,300)/(400,300) -> (400,0)", ok))
        }

        // viewportToViewLocalPure — out-of-bounds returns nil.
        do {
            let gotRight = viewportToViewLocalPure(
                CGPoint(x: 500, y: 150),
                viewSize: CGSize(width: 400, height: 300),
            )
            let gotBottom = viewportToViewLocalPure(
                CGPoint(x: 100, y: 400),
                viewSize: CGSize(width: 400, height: 300),
            )
            let gotNegative = viewportToViewLocalPure(
                CGPoint(x: -1, y: 50),
                viewSize: CGSize(width: 400, height: 300),
            )
            let ok = gotRight == nil && gotBottom == nil && gotNegative == nil
            results.append(("viewportToViewLocal out-of-bounds returns nil (right/bottom/negative)", ok))
        }

        // appKitScreenToCGPure — bottom-up-to-top-down conversion.
        do {
            let got = appKitScreenToCGPure(
                CGPoint(x: 100, y: 500),
                primaryScreenHeight: 900,
            )
            let expected = CGPoint(x: 100, y: 400)
            let ok = got == expected
            results.append(("appKitScreenToCG (100,500)/h=900 -> (100,400)", ok))
        }

        // appKitScreenToCGPure — origin (bottom-left of AppKit) maps
        // to (0, height) in CG (top-left at (0, 0) implies
        // bottom-left is (0, height)).
        do {
            let got = appKitScreenToCGPure(
                CGPoint(x: 0, y: 0),
                primaryScreenHeight: 900,
            )
            let expected = CGPoint(x: 0, y: 900)
            let ok = got == expected
            results.append(("appKitScreenToCG bottom-left (0,0)/h=900 -> (0,900)", ok))
        }

        // appKitScreenToCGPure — top-left of AppKit (0, height) maps
        // to CG origin (0, 0).
        do {
            let got = appKitScreenToCGPure(
                CGPoint(x: 0, y: 900),
                primaryScreenHeight: 900,
            )
            let expected = CGPoint(x: 0, y: 0)
            let ok = got == expected
            results.append(("appKitScreenToCG top-left (0,900)/h=900 -> (0,0)", ok))
        }

        // Keep only the failing cases so the return value is empty on
        // a fully-green run. Empty-is-passing is the contract.
        return results.filter { !$0.1 }
    }
}
#endif
