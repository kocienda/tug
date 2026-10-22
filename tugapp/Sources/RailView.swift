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
/// **It carries a width drag.** While a hand holds the rail's edge
/// (`carriesDrag`), the gesture writes this view's frame and nothing else of
/// the rail's: AppKit's layout pass that the frame write runs
/// (`resizeSubviews`) widens each member in a crossing at its deck-facing
/// edge, its outer edge standing still, in the same transaction. No
/// autoresizing mask can say that of a right rail: its members' origins move
/// left as it grows, and the bounds origin moves under them.
final class RailView: NSView, StackedView {
    let side: RailSide
    /// Whether a hand holds the rail's edge: its frame lays its members out.
    var carriesDrag = false

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

    /// Carrying a drag, each member in a crossing takes the rail's growth at
    /// its deck-facing edge: a left rail's grows to the right, a right
    /// rail's to the left. Any other member is left where it stands.
    override func resizeSubviews(withOldSize oldSize: NSSize) {
        guard carriesDrag else { return super.resizeSubviews(withOldSize: oldSize) }
        let growth = bounds.width - oldSize.width
        for case let member as RailMemberView in subviews where member.railCrossing != nil {
            var frame = member.frame
            frame.size.width += growth
            if side == .right { frame.origin.x -= growth }
            member.frame = frame
        }
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

/// A view a rail can hold a member's page in for a width drag: a body's
/// container is one. It carries the crossing while one stands, and lays it
/// out again on every resize the rail makes.
class RailMemberView: NSView {
    /// A rail width drag's hold on the page, while one stands.
    var railCrossing: RailCrossing? {
        didSet {
            if oldValue !== railCrossing { oldValue?.remove() }
            railCrossing?.install(in: self)
        }
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        railCrossing?.layout(in: self)
    }
}

/// A rail member's page held at its press size while a hand drags the rail's
/// width: no web process is asked to lay anything out mid-drag, so nothing
/// on screen waits on one.
///
/// The container moves with the rail and the page stands still in it,
/// anchored at the rail's outer edge (its autoresizing mask). A mask on the
/// page's layer ends it at the pane's deck-facing edge less the border, and
/// `strip` draws what lies from there to the edge: the pane's surface, and
/// the border in the edge's colour. A shrink clips the page at the edge; a
/// grow shows the surface where the page does not reach, and the page's own
/// border, which stands where the press left it, is under the strip. Every
/// geometry here is a layer's, written in the transaction the rail's frame
/// is, so the edge is where the hand put it on the frame it is shown.
///
/// At the release the page takes its container's size once, and the
/// crossing stands until the page has painted at it, measured
/// against the content the page last painted: laid out at `contentWidth`,
/// from the page view's top-left.
final class RailCrossing {
    let side: RailSide
    /// The pane within its container, points.
    let insets: CardInsets
    /// The page's width when the press found it, at which its content stays
    /// laid out until it lands.
    let contentWidth: CGFloat
    /// The page's view.
    weak var page: NSView?
    let strip = RailEdgeView()
    let mask = CALayer()
    /// The colours the page said its edge paints in; nil until it answers.
    var colors: RailEdgeColors?
    /// Which of them the edge wears.
    var tint: Tint = .held

    enum Tint {
        case rest, held, limit
    }

    init(side: RailSide, insets: CardInsets, page: NSView) {
        self.side = side
        self.insets = insets
        self.page = page
        contentWidth = page.frame.width
        strip.side = side
        mask.backgroundColor = CGColor.black
    }

    /// Stand the strip and the mask in `container`, over its page.
    func install(in container: NSView) {
        container.addSubview(strip)
        page?.layer?.mask = mask
        layout(in: container)
    }

    func remove() {
        strip.removeFromSuperview()
        if page?.layer?.mask === mask { page?.layer?.mask = nil }
    }

    /// The strip and the mask for the container's bounds as they stand.
    /// Until the page has said its colours the page shows whole and the
    /// strip stands empty, so the press cuts away nothing the host cannot
    /// yet draw.
    func layout(in container: NSView) {
        guard let page else { return }
        guard colors != nil else {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            strip.frame = .zero
            mask.frame = page.bounds
            CATransaction.commit()
            return
        }
        let bounds = container.bounds
        let border = strip.edgeWidth
        let pageX = page.frame.minX
        // The pane's deck-facing edge, the content's own border's, and where
        // the page is cut: short of both, by the border the strip draws.
        let lo: CGFloat
        let hi: CGFloat
        let visible: ClosedRange<CGFloat>
        switch side {
        case .left:
            let pane = bounds.width - CGFloat(insets.right)
            let content = pageX + contentWidth - CGFloat(insets.right)
            let clip = min(pane, content) - border
            (lo, hi) = (clip, pane)
            visible = -CGFloat.greatestFiniteMagnitude...clip
        case .right:
            let pane = CGFloat(insets.left)
            let content = pageX + CGFloat(insets.left)
            let clip = max(pane, content) + border
            (lo, hi) = (pane, clip)
            visible = clip...CGFloat.greatestFiniteMagnitude
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let top = CGFloat(insets.top)
        strip.frame = CGRect(x: lo, y: top, width: max(0, hi - lo), height: max(0, bounds.height - top - CGFloat(insets.bottom)))
        let from = max(0, visible.lowerBound - pageX)
        let to = min(page.bounds.width, visible.upperBound - pageX)
        mask.frame = CGRect(x: from, y: 0, width: max(0, to - from), height: page.bounds.height)
        CATransaction.commit()
    }
}

/// The host's half of a rail member's deck-facing edge for a width drag:
/// the pane's surface, with the border drawn on its deck-facing side in the
/// edge's colour, and past it the shadow the rail casts into its gutter, as
/// the page draws it (`rail-shadow.css`): a gradient, not a blur, falling
/// from half the shadow colour's alpha to nothing over its reach. Answers no
/// point; the hand's events are the host's.
final class RailEdgeView: NSView {
    /// The pane's surface, or clear before the page has said it.
    var surface: CGColor? {
        didSet { needsDisplay = true }
    }
    /// The border's colour: at rest, held, or past a limit.
    var edgeColor: CGColor? {
        didSet { needsDisplay = true }
    }
    /// The border's width, points.
    var edgeWidth: CGFloat = 0 {
        didSet { placeEdge() }
    }
    /// The rail's side, which says which edge of the strip faces the deck:
    /// a left rail's right, a right rail's left.
    var side: RailSide = .left {
        didSet { placeEdge() }
    }
    /// The shadow's colour, and how far past the edge it reaches, points.
    var gutterShadow: (color: CGColor, reach: CGFloat)? {
        didSet { paintShadow() }
    }
    private let edge = CALayer()
    private let cast = CAGradientLayer()
    /// `rail-shadow.css`'s stops: where each falls, and its share of the
    /// shadow colour's alpha.
    private static let shadowStops: [(at: Double, alpha: CGFloat)] = [(0, 0.5), (0.35, 0.26), (0.65, 0.12), (1, 0)]

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.addSublayer(edge)
        layer?.addSublayer(cast)
        layer?.masksToBounds = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func updateLayer() {
        layer?.backgroundColor = surface
        edge.backgroundColor = edgeColor
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        placeEdge()
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func placeEdge() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let width = min(edgeWidth, bounds.width)
        let x = side == .left ? bounds.width - width : 0
        edge.frame = CGRect(x: x, y: 0, width: width, height: bounds.height)
        let reach = gutterShadow?.reach ?? 0
        cast.frame = CGRect(x: side == .left ? bounds.width : -reach, y: 0, width: reach, height: bounds.height)
        CATransaction.commit()
    }

    private func paintShadow() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let shadow = gutterShadow {
            cast.colors = Self.shadowStops.map { shadow.color.copy(alpha: shadow.color.alpha * $0.alpha) ?? shadow.color }
            cast.locations = Self.shadowStops.map { NSNumber(value: $0.at) }
            let outward = side == .left
            cast.startPoint = CGPoint(x: outward ? 0 : 1, y: 0.5)
            cast.endPoint = CGPoint(x: outward ? 1 : 0, y: 0.5)
        } else {
            cast.colors = nil
        }
        CATransaction.commit()
        placeEdge()
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
