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
///
/// **It owns its width drag's ghost.** While a hand holds the rail's edge,
/// nothing of the rail moves: the hand moves `ghost`, the footprint the rail
/// will stand at when the hand lets go (`ghostFrame`). The ghost stands in
/// the host view rather than in the rail, above every card, so a card beside
/// the rail that stacks in front of it does not cover the footprint where a
/// grow reaches into it.
final class RailView: NSView, StackedView {
    let side: RailSide
    /// The footprint a width drag aims, while a hand drags the rail's edge.
    let ghost = RailEdgeView()

    override var isFlipped: Bool { true }

    init(side: RailSide) {
        self.side = side
        super.init(frame: .zero)
        ghost.side = side
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

    /// The ghost's frame, viewport points: `panes`, the union of the
    /// members' panes at the press, grown by `growth` points at the
    /// deck-facing edge with the outer edge fixed. It narrows to nothing,
    /// never past it.
    static func ghostFrame(side: RailSide, panes: CGRect, growth: CGFloat) -> CGRect {
        var frame = panes
        frame.size.width = max(0, panes.width + growth)
        if side == .right { frame.origin.x = panes.maxX - frame.width }
        return frame
    }

    /// Stand the ghost at `frame`, viewport points, in `host`, with nothing
    /// animating.
    func standGhost(_ frame: CGRect, in host: NSView) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if ghost.superview !== host { host.addSubview(ghost) }
        ghost.frame = frame
        CATransaction.commit()
    }

    /// The drag is over: the ghost goes, and wears nothing the next press
    /// has not asked for.
    func removeGhost() {
        ghost.removeFromSuperview()
        ghost.pastLimit = false
    }
}

/// A rail width drag's ghost: the footprint the rail will stand at when the
/// hand lets go, drawn by the host so it stands where the hand is on the
/// frame it is shown. A translucent fill of the theme's tint, with an edge on
/// its deck-facing side in the tint, or in the limit colour while the hand
/// presses past one, in the colours the rail's page said it paints
/// (`onRailEdge`). Until the page has answered it draws nothing. Answers no
/// point; the hand's events are the host's.
final class RailEdgeView: NSView {
    /// The colours the rail's page said its edge paints in; nil until it answers.
    var colors: RailEdgeColors? {
        didSet { if oldValue != colors { paint() } }
    }
    /// Whether the hand presses past a limit: the edge wears the limit's colour.
    var pastLimit = false {
        didSet { if oldValue != pastLimit { paint() } }
    }
    /// The rail's side, which says which edge of the ghost faces the deck:
    /// a left rail's right, a right rail's left.
    var side: RailSide = .left {
        didSet { place() }
    }
    private let fill = CALayer()
    private let edge = CALayer()

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.addSublayer(fill)
        layer?.addSublayer(edge)
        // Above every card's container, beneath nothing the host view holds.
        layer?.zPosition = 1
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        place()
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func paint() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fill.backgroundColor = colors.map { Self.color($0.fill) }
        edge.backgroundColor = colors.map { Self.color(pastLimit ? $0.limit : $0.ghostEdge) }
        CATransaction.commit()
        place()
    }

    private func place() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fill.frame = bounds
        let width = min(CGFloat(colors?.width ?? 0), bounds.width)
        edge.frame = CGRect(x: side == .left ? bounds.width - width : 0, y: 0, width: width, height: bounds.height)
        CATransaction.commit()
    }

    /// Four sRGB bytes, which the colours' decode has checked, as a colour.
    private static func color(_ bytes: [Double]) -> CGColor {
        let c = bytes.map { CGFloat($0) / 255 }
        return CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: c[3])
    }
}

/// A display link's target that calls back with the link on every frame: a
/// rail's spring, stepped through the same frame write a hand's move takes.
final class RailSpringTick: NSObject {
    private let tick: (CADisplayLink) -> Void

    init(_ tick: @escaping (CADisplayLink) -> Void) {
        self.tick = tick
    }

    @objc func fire(_ link: CADisplayLink) {
        tick(link)
    }
}
