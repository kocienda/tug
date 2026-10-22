import AppKit
import QuartzCore

/// A view the host stacks among the cards: by its `order` (the pane's
/// `z-index`), then by its creation `serial`. A body's container is one, and
/// so is a rail view, which stacks at its frontmost member's order.
protocol StackedView: NSView {
    var order: Int { get }
    var serial: Int { get }
}

/// Put `view`'s stacked subviews in their order, in place, and only when the
/// order has changed. `sortSubviews` moves nothing out of the hierarchy, so a
/// body web view that is the window's first responder stays it —
/// `addSubview(_:positioned:relativeTo:)` on a view already present removes it
/// first, and a removal resigns the first responder inside it to the window.
/// And a sort that changes nothing is skipped outright: re-ordering
/// layer-backed subviews re-parents their layers, which ends any animation
/// running on them, and every placement used to pay that whether or not a
/// pane had moved in front of another.
func sortStacked(in view: NSView) {
    let current = view.subviews.compactMap { $0 as? StackedView }
    let sorted = current.sorted(by: stackedBefore)
    if current.elementsEqual(sorted, by: ===) { return }
    view.sortSubviews({ a, b, _ in
        guard let sa = a as? StackedView, let sb = b as? StackedView else { return .orderedSame }
        if stackedBefore(sa, sb) { return .orderedAscending }
        if stackedBefore(sb, sa) { return .orderedDescending }
        return .orderedSame
    }, context: nil)
}

/// Whether `a` stacks behind `b`.
func stackedBefore(_ a: StackedView, _ b: StackedView) -> Bool {
    a.order != b.order ? a.order < b.order : a.serial < b.serial
}

/// One shown sidebar rail's member containers, held together so the rail is
/// one thing in the host's hierarchy.
///
/// **Viewport coordinates, inside and out.** Its `bounds.origin` is kept
/// equal to its `frame.origin` (`place`), so a member container's `frame`
/// inside it is the same viewport rect it was as a subview of the host view,
/// and every frame the host writes, reads, hit-tests or probes a layer at
/// means what it meant there. Flipped, as the host view is, so a member's
/// top-left is its origin.
///
/// **It clips nothing and is never hidden.** Its frame is the union of its
/// members' landings, while a settle carries a member's layer from where it
/// stood to its landing — outside that union, mid-motion — and each member's
/// container already clips its own page. And the host view's rule is opacity,
/// never `isHidden`, so every body keeps painting: a hidden superview would
/// stop its members' pages drawing the frame a show is about to reveal.
///
/// Its frame is written only by `place`, never through `animator()`: an
/// animated frame would move while the bounds origin jumped, and shift every
/// member by the difference for the length of the animation.
final class RailView: NSView, StackedView {
    let side: RailSide

    override var isFlipped: Bool { true }

    init(side: RailSide) {
        self.side = side
        super.init(frame: .zero)
        wantsLayer = true
        clipsToBounds = false
        layer?.masksToBounds = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// The members, by their containers, in subview order.
    var members: [StackedView] { subviews.compactMap { $0 as? StackedView } }

    /// The rail stacks at its frontmost member's order.
    var order: Int { members.map(\.order).max() ?? 0 }

    /// And among equals, at its oldest member's serial.
    var serial: Int { members.map(\.serial).min() ?? 0 }

    /// Stand the rail at `frame`, viewport coordinates, keeping its bounds
    /// origin at the same point, with nothing animating.
    func place(_ frame: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        self.frame = frame
        setBoundsOrigin(frame.origin)
        CATransaction.commit()
    }

    /// The rail answers no point of its own: a point is a member's, by the
    /// cards' hit shapes, or it passes on to the shell.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }

    /// The frame a rail stands at: the union of `frames`, its members'.
    static func union(of frames: [CGRect]) -> CGRect {
        guard let first = frames.first else { return .zero }
        return frames.dropFirst().reduce(first) { $0.union($1) }
    }
}
