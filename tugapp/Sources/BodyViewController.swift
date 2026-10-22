import AppKit
import QuartzCore
import WebKit

/// The view every body container lives in: flipped, so a container's frame is
/// the top-left viewport rect the shell measured, filling the window's
/// container over the shell's web view and beneath the overlay's.
///
/// Held at opacity zero until the window reveals the shell, then faded in on
/// the reveal's own clock: a card shown before the reveal would stand over
/// the splash. Opacity, never `isHidden`, so every body keeps painting.
final class BodyHostView: NSView {
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.opacity = 0
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// The container a point in this view's coordinates — the viewport's —
    /// belongs to, by the cards' hit shapes front to back, or nil when no
    /// card claims it.
    var containerAt: ((NSPoint) -> NSView?)?

    /// Never a hit of its own, and never a container's but by the cards' hit
    /// shapes: the shell's view lies beneath, so a point no card claims —
    /// between cards, on a card's bare apron, on a seam the shell keeps over
    /// a card, or under a claim the shell has posted — answers nil and
    /// AppKit carries it on to the shell. A whole card's view reaches past
    /// its pane by the apron, and two cards a gap apart overlap there, so
    /// which card a point is is its hit shape's answer (`CardHitShape`), not
    /// the frames': the band past a pane's edge is that card's only where it
    /// offers a grip, and a press on a card's grip is never taken by the
    /// bare apron of the card beside it.
    ///
    /// A container in a rail view is asked in the rail view's coordinates,
    /// which are the viewport's too (`RailView`), but converted all the same.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard let containerAt, let container = containerAt(local) else { return nil }
        guard let parent = container.superview, parent !== self else { return container.hitTest(local) }
        return container.hitTest(parent.convert(local, from: self))
    }
}

/// The window's content view, which holds the shell's web view, the cards
/// over it and the overlay over them. Its accessibility children are the
/// order VoiceOver reads the window in: subview order would put the cards
/// in stacking order. `accessibilityOrder` replaces that with the shell's
/// view, then each showing card in the shell's pane order, then the
/// overlay; nil leaves AppKit's own answer, as on a host that makes no
/// bodies.
final class DeckContainerView: NSView {
    var accessibilityOrder: [Any]? {
        didSet { NSAccessibility.post(element: self, notification: .layoutChanged) }
    }

    override func accessibilityChildren() -> [Any]? {
        accessibilityOrder ?? super.accessibilityChildren()
    }
}

/// A card's face while a departing view is handed over: a still picture of
/// the shell's stand-in, drawn from the display list the shell read off it
/// (`FaceDraw`) — a layer per box, a layer per icon drawn from its SVG, a
/// text layer per run — at the card's view rect, stacked at the card's
/// order. It stands from the transaction that
/// hides the departing view until the shell's own frame is on screen, and
/// answers no point.
///
/// Layer-hosting, its root layer flipped, so the list's top-left rects are
/// the layers' frames as they are.
final class BodyFaceView: NSView, StackedView {
    var order = 0
    let serial: Int
    let cardId: String
    /// The list drawn now, so a re-post carrying the same one redraws nothing.
    private(set) var drawn: FaceDraw?

    init(cardId: String, serial: Int) {
        self.cardId = cardId
        self.serial = serial
        super.init(frame: .zero)
        let root = CALayer()
        root.isGeometryFlipped = true
        root.masksToBounds = true
        layer = root
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Draw `list` at `scale` backing pixels per point, in place of whatever
    /// was drawn before.
    func draw(_ list: FaceDraw, scale: CGFloat) {
        guard let root = layer, list != drawn else { return }
        drawn = list
        root.sublayers = nil
        for box in list.boxes {
            let sub = CALayer()
            sub.frame = box.rect.cgRect
            sub.backgroundColor = box.fill.flatMap(BodyHandOver.color(rgba:))
            if let border = box.border, let color = BodyHandOver.color(rgba: border.color) {
                sub.borderWidth = border.width
                sub.borderColor = color
            }
            sub.cornerRadius = box.radius
            root.addSublayer(sub)
        }
        for icon in list.images {
            // AppKit reads SVG; markup it cannot read leaves the icon out.
            guard let image = NSImage(data: Data(icon.svg.utf8)) else { continue }
            let sub = CALayer()
            sub.frame = icon.rect.cgRect
            sub.contentsGravity = .resize
            sub.contentsScale = scale
            sub.contents = image.layerContents(forContentsScale: scale)
            root.addSublayer(sub)
        }
        for run in list.texts {
            let font = Self.font(run.font)
            let text = CATextLayer()
            text.string = run.text
            text.font = font
            text.fontSize = font.pointSize
            text.foregroundColor = BodyHandOver.color(rgba: run.color)
            text.contentsScale = scale
            text.truncationMode = .end
            text.isWrapped = false
            // The run's rect is its line box; the glyphs sit centred in it.
            let line = font.ascender - font.descender
            var frame = run.rect.cgRect
            frame.origin.y += max(0, (frame.height - line) / 2)
            frame.size.height = max(frame.height, line)
            frame.size.width += 1
            text.frame = frame
            root.addSublayer(text)
        }
    }

    /// The run's font: its family at its CSS weight when the system has it,
    /// else the system font at that weight.
    private static func font(_ font: FaceDraw.Font) -> NSFont {
        let size = CGFloat(font.size)
        // CSS 100–900 onto the font manager's 0–15, 400 → 5, 700 → 9.
        let managerWeight = Int(((font.weight - 400) / 100 * 1.33 + 5).rounded())
        if let named = NSFontManager.shared.font(
            withFamily: font.family, traits: [], weight: min(15, max(0, managerWeight)), size: size
        ) {
            return named
        }
        let weight: NSFont.Weight = switch font.weight {
        case ..<250: .ultraLight
        case ..<350: .light
        case ..<450: .regular
        case ..<550: .medium
        case ..<650: .semibold
        case ..<750: .bold
        default: .heavy
        }
        return NSFont.systemFont(ofSize: size, weight: weight)
    }
}

/// A body's container: layer-backed and clipped to its bounds, carrying its
/// stacking order and its creation serial for `sortStacked`. A rail member's
/// container stands in its rail's `RailView`; every other in the host view.
///
/// Flipped, so the web view's top-left is its origin: while a crossing
/// animates the container's bounds, the page stays pinned at the top and
/// the container clips its bottom edge, never its masthead edge.
final class BodyContainerView: NSView, StackedView {
    var order = 0
    let serial: Int
    override var isFlipped: Bool { true }
    /// The page's surface the container wears behind its web view, or nil
    /// before the page has said it. The web view draws no background of its
    /// own, so a remainder of the view the page's layout viewport does not
    /// reach reads this colour, never WebKit's white, and through a crossing
    /// a box larger than the page reads it too.
    /// A layer-backed view's layer is AppKit's to draw, so the colour goes
    /// on in `updateLayer` rather than straight onto the layer.
    var surface: CGColor? {
        didSet { needsDisplay = true }
    }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.backgroundColor = surface
    }
    /// Set while the container shows nothing but stays in the tree — a
    /// sibling behind its pane's active card, or a body not yet shown, each
    /// at opacity zero. Such a view stands where a showing one does, so a
    /// point there must reach the card that is seen, never the one that is not.
    var passesPointer = false
    override func hitTest(_ point: NSPoint) -> NSView? {
        passesPointer ? nil : super.hitTest(point)
    }
    init(serial: Int) {
        self.serial = serial
        super.init(frame: .zero)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
}

/// An evicted card's last frame, kept for the body that brings it back: taken
/// at one point a pixel, a placeholder rather than a document.
struct BodyCover {
    let image: CGImage
    /// The size it was taken at, points: the card's view as it went.
    let size: CGSize
    /// The page's surface as it went, which the cover wears where its frame
    /// does not reach once the pane has grown.
    let surface: CGColor?
    /// The pane's insets within the view as it went.
    let insets: CardInsets?
    /// When it was taken, wall-clock ms, for its age.
    let takenAt: Double
    /// What it holds resident.
    var bytes: Int { image.bytesPerRow * image.height }
}

/// The last frame of an evicted card, stood over the body made to bring it
/// back until that body has painted: the card shows as it last stood, never
/// the floor through a pane whose page is still loading. The frame is drawn
/// at its own size, pinned at the top-left as a crossing pins its page; a
/// pane grown since shows the page's surface beyond it, inside the pane's
/// rounded rect, and one shrunk clips it. Answers no point, so a press
/// reaches the page beneath it.
final class BodyCoverView: NSView {
    /// The pane's corner radius: the themes' `--tug-radius-md`.
    static let paneRadius: CGFloat = 6
    private let plate = CALayer()
    private let frameLayer = CALayer()
    private let frameSize: CGSize
    /// Where the pane stands within the view, from the latest placement.
    var paneInsets: CardInsets? {
        didSet { needsLayout = true }
    }
    override var isFlipped: Bool { true }
    init(cover: BodyCover, frame: NSRect) {
        frameSize = cover.size
        paneInsets = cover.insets
        super.init(frame: frame)
        wantsLayer = true
        plate.backgroundColor = cover.surface
        plate.cornerRadius = BodyCoverView.paneRadius
        frameLayer.contents = cover.image
        frameLayer.contentsGravity = .resize
        layer?.addSublayer(plate)
        layer?.addSublayer(frameLayer)
        needsLayout = true
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        frameLayer.frame = CGRect(origin: .zero, size: frameSize)
        // The plate is needed only where the frame no longer reaches.
        let grown = bounds.width > frameSize.width + 0.5 || bounds.height > frameSize.height + 0.5
        plate.isHidden = !grown
        if let i = paneInsets {
            plate.frame = CGRect(
                x: i.left, y: i.top,
                width: max(0, bounds.width - i.left - i.right),
                height: max(0, bounds.height - i.top - i.bottom)
            )
        } else {
            plate.frame = bounds
        }
        CATransaction.commit()
    }
}

/// Calls back when a body's position track stops: `finished` when it ran to
/// its end, not when a placement or a newer plan removed it.
final class BeatTrackDelegate: NSObject, CAAnimationDelegate {
    private let onStop: (Bool) -> Void
    init(onStop: @escaping (Bool) -> Void) {
        self.onStop = onStop
    }
    func animationDidStop(_ anim: CAAnimation, finished flag: Bool) {
        onStop(flag)
    }
}

/// Every body: a card's content in a WKWebView of its own, in its own
/// WebContent process, placed by the host over the shell's page.
///
/// A body's life (`loading → connected → bound → ready → painted → visible /
/// hidden → destroyed`, with `failed` from any state before ready at the
/// deadline and on a second WebContent termination within ten seconds) is
/// kept here, and the shell hears of every transition that matters to it
/// through `window.__tugBridge.onBodyState`. The shell decides what each body
/// is for (`bodyCreate`) and where it stands (`placeCards`); this object
/// makes the views, binds them, places them, shows them, and tears them down.
/// Its message handlers are `MainWindow`'s, which routes a message by the
/// view that sent it.
///
/// **A card shows once it has painted.** The cards stand over the shell's
/// page, which paints the canvas and its grid beneath them, so the host
/// shows a placed card the moment its page says `painted` — its first chrome
/// frame has gone to the compositor — and never before: `ready` alone is the
/// card mounted and quiet, and a container shown on `ready` can be
/// composited empty.
///
/// **A card moves with its stand-in.** A settle that moves a card's stand-in
/// posts a `cardPlan`, and `runPlan` carries the whole container through each
/// beat as Core Animation on the chrome's curve from the chrome's start: one
/// track per property per card over the whole plan, the container's model at
/// the landing. It reports `landed` when the track runs out, and
/// `beatsCancelled` when a placement that does not name the plan, or a newer
/// plan, takes it.
final class BodyViewController {
    enum State: String {
        case loading
        case connected
        case bound
        case ready
        case failed
    }

    /// One body. A spare has no card until it is bound to one.
    final class Body {
        var cardId: String?
        let webView: ClickThroughWebView
        let container: BodyContainerView
        var state: State = .loading
        /// What the body is to do once bound: the deck's `BodyIntent`.
        var intent: JSONObject?
        /// The kind of card it holds once bound: the deck's `componentId`.
        var componentId: String?
        /// When the body was bound to its card, for `readyMs`.
        var boundAt: CFTimeInterval?
        /// When the card's page was asked for — made cold, or the spare
        /// taken — for the ready line's `whole_ms`: the wall time the card
        /// was dark, which bind → ready leaves out.
        var askedAt: CFTimeInterval?
        /// Whether this body began as the spare, for the ready line's
        /// `warm` / `cold`.
        var warm = false
        /// Bind → ready, once ready.
        var readyMs: Double?
        /// The body has posted `painted`: its first frame of real content
        /// has gone to the compositor. Cleared when its page is reloaded.
        var painted = false
        /// The body outlived a shell reload: the reloaded shell has heard
        /// nothing of it, and is told where it stands when it asks for it.
        var keptAcrossShellReload = false
        /// Whether the body may be shown: it has painted, and its card is
        /// bound or ready. A card that draws its own chrome paints its first
        /// chrome frame before it is ready, and shows from there, its content
        /// lidded in its own page.
        ///
        /// A body brought back from an eviction may be shown from its
        /// hand-off: its cover stands until it has painted.
        var canShow: Bool {
            if cover != nil { return state != .failed }
            return painted && (state == .ready || state == .bound)
        }
        /// The card's last frame before its eviction, over the web view until
        /// the page paints; nil for any body not brought back from one.
        var cover: BodyCoverView?
        /// The body was made under a cover, for the harness: `cover` goes at the paint.
        var wasCovered = false
        /// The card draws its pane's chrome in its own page: its container
        /// is the pane's rect outset by the apron, wears no surface, and
        /// answers a point by the card's hit shape. Every placed card is.
        var whole = false
        /// An inactive card of a whole card's pane, placed at the pane and
        /// hidden by opacity, never `isHidden`, so it keeps painting and a
        /// tab switch shows a page that has drawn its new chrome.
        var sibling = false
        /// A whole card's pane within its view, as the last placement said
        /// it: the apron plus what the view's growth to whole points added.
        /// Handed to the page, which lays its pane out at exactly these.
        var insets: CardInsets?
        /// The frame the last placement gave it, viewport coordinates.
        var frame: CGRect = .zero
        /// The shell's own controls over the card from the last placement
        /// (the place seams), viewport coordinates: the shell's points.
        var shellControls: [CGRect] = []
        /// The stacking order the last placement gave it: the pane's
        /// `z-index`. Containers are kept in this order, so where two panes
        /// overlap the body in front is the pane in front.
        var z: Int = 0
        /// Where the last placement listed it: the shell's document order of
        /// its pane, which is the order the shell's own cards are read in.
        var deckIndex: Int = 0
        var visible = false
        /// Whether the body has been shown once. Until it has, a hidden body
        /// is hidden by layer opacity, never `isHidden`, so WebKit keeps
        /// painting the frame the showing will reveal.
        var shownOnce = false
        /// Whether the user can see the body — placed visible and showable,
        /// or a sibling at opacity 0 behind its pane's active card — and
        /// since when, wall-clock ms. A body not yet shown once is hidden by
        /// opacity rather than `isHidden`, so painting is not the reading.
        var shown: (value: Bool, since: Double)?
        /// What `shown` reads now: placed visible and showable, or a sibling.
        var seen: Bool { visible && canShow || sibling }
        /// The `shown` its page was last told; nil until the page is bound,
        /// and again when a reload binds a new one.
        var toldShown: Bool?
        /// The time trigger's eviction, armed while the body is hidden and
        /// due `evictAfterMs` after it was hidden.
        var evictDue: DispatchWorkItem?
        /// The page's surface as it last posted it, which the container wears
        /// behind a content box, never behind a whole card.
        var surface: CGColor?
        var deadline: DispatchWorkItem?
        var lastTermination: Date?
        /// The card plan carrying the body now, until it lands or is
        /// cancelled: the plan's id, the rect it lands at, and how late the
        /// plan reached the host.
        var beats: (planId: Int, landing: CGRect, lateMs: Double)?
        /// The size the plan carrying the body takes its page to, and when
        /// its first moving beat begins (media time), until the beats land or are
        /// cancelled; nil when the plan does not resize the body. The page
        /// keeps its old size until the body has pinned its scrollers and
        /// posted `crossingReady` — and to the land when `keepsPage`, a whole
        /// card that shrinks with no cover standing over it.
        var crossing: (size: CGSize, begin: CFTimeInterval, keepsPage: Bool)?
        /// A whole card that shrinks wears its last frame over its page for
        /// the crossing, while the page lays itself out at the landing size
        /// beneath it; nil for every other crossing, and after the land.
        var crossingCover: BodyCoverView?
        /// The last crossing's account, for the harness: its plan, its size,
        /// and how far ahead of the first beat the body was ready.
        var lastCrossing: CrossingAccount?
        /// How the container's frame maps to its layer's geometry, solved at
        /// the body's last plan; nil before one.
        var mapping: LayerMapping?
        /// The body's page is writing its card's state on the way to an
        /// eviction, which no second eviction may start over.
        var evicting = false
        /// The card was closed, or the body otherwise went: an eviction
        /// still in flight finds it here and touches neither the body nor
        /// the covers, so a closed card is removed once and holds no cover.
        var gone = false

        init(cardId: String?, webView: ClickThroughWebView, container: BodyContainerView) {
            self.cardId = cardId
            self.webView = webView
            self.container = container
        }
    }

    /// How long a body has to report ready after it is asked for, unless
    /// the harness shortens it (`BodyGeometry.readyDeadlineMs`).
    static let readyDeadlineMs = BodyGeometry.readyDeadlineMs(
        environment: ProcessInfo.processInfo.environment,
        fallback: 10_000
    )
    /// How long after the shell's launch, and after each bound body's ready,
    /// the spare is made: late enough to stay out of the way of the page
    /// that just painted.
    static let spareDelay: DispatchTimeInterval = .seconds(1)
    /// A second WebContent termination inside this window fails the body.
    static let terminationWindow: TimeInterval = 10
    /// How many cards' pages load at once. Every page fetches the deck's
    /// whole module graph through the one connection pool the app's pages
    /// share, so a page's load grows with how many are loading beside it:
    /// on a warm six-card launch, six at once all painted at 4.8 s; two at
    /// a time painted the first two at 2.2 s and the last at 5.5 s, three
    /// at a time the first three at 2.9 s and the last at 5.2 s. The whole
    /// is the same either way; the width decides how soon the first cards
    /// are live. Read against the launch's `deck-populated` lap.
    static let laneWidth = 2
    /// How long a card asked for before the shell has placed it waits for
    /// that placement, which says whether it is shown and where it reads,
    /// before the lane takes it in the order it was asked for.
    static let lanePlacementWait: DispatchTimeInterval = .milliseconds(100)

    private unowned let window: MainWindow
    let hostView: BodyHostView
    /// When the window began revealing the shell over the splash, or nil
    /// before it has: until then the overlay is held transparent, or it
    /// would stand over the splash.
    private var revealedAt: CFTimeInterval?
    private(set) var bodies: [Body] = [] {
        // The host state probe reports the count off the main thread.
        didSet { HostRunLoopWatch.shared.noteBodyCount(bodies.count) }
    }
    private(set) var region = CardHitRegion()
    /// The spare's pending creation, so a burst of readies makes one.
    private var pendingSpare: DispatchWorkItem?
    /// A card whose page is not yet made: asked for, and waiting in the lane.
    private struct LaneEntry {
        let cardId: String
        var componentId: String
        var intent: JSONObject
        let askedAt: CFTimeInterval
        let serial: Int
    }
    /// The cards waiting for a page, in the order they were asked for.
    private var lane: [LaneEntry] = []
    private var laneSerials = 0
    /// The lane's wait for a placement (`lanePlacementWait`).
    private var pendingDrain: DispatchWorkItem?
    /// Each card the last placement named, with its index in the deck's
    /// reading order: the lane's order after whether a card is shown, and
    /// where a page made from the lane after that placement stands.
    private var placedEntries: [String: (entry: CardPlacementEntry, deckIndex: Int)] = [:]
    /// Creation order, for a stable stacking among bodies at one z.
    private var serials = 0
    #if DEBUG
    /// `TUG_BODY_FORCE_STALL=<n>` suppresses the first `n` bodies'
    /// `frontendReady`, so a test can watch the deadline fail them — once
    /// for the shell's own retry, twice for the card's placard. DEBUG-only.
    private var readiesToStall = Int(ProcessInfo.processInfo.environment["TUG_BODY_FORCE_STALL"] ?? "") ?? 0

    /// Ignore the next `count` bodies' `frontendReady`, from a harness verb.
    func stallReadies(_ count: Int) {
        readiesToStall = count
    }
    #endif

    /// How short of memory the machine says it is: the level the shell is
    /// told, one type on both sides of the send.
    typealias PressureLevel = BodyPressure.Level
    /// The level the host last heard, and when, wall-clock ms: from the
    /// dispatch source, or from the harness standing in for it.
    private(set) var pressure: (level: PressureLevel, at: Double) = (.normal, 0)
    private let pressureSource = DispatchSource.makeMemoryPressureSource(
        eventMask: [.normal, .warning, .critical], queue: .main
    )
    /// The warning's next eviction, a beat after the last one finished —
    /// its process gone, or the body kept: a level change cancels it.
    private var pendingWarningStep: DispatchWorkItem?
    /// Bodies a warning step could not evict — shown while saving, or a
    /// save that did not answer — which its next step asks only once no
    /// other hidden body is left to ask, and which critical does not ask
    /// again.
    private var declined: Set<ObjectIdentifier> = []
    /// The last frame of each card evicted and not yet asked for again, taken
    /// as its process went: the cover its next body stands under. Bounded:
    /// a cover older than `evictAfterMs` goes, and past `coverBudgetBytes`
    /// the oldest go first. Critical pressure takes none and drops them all.
    private var covers: [String: BodyCover] = [:]
    /// What the covers may hold together, counted in pixel bytes — the most
    /// they could hold resident. Twenty covers of a 640 × 480 pane at one
    /// point a pixel are 25.3 MB of pixels (100.7 MB at the backing's two),
    /// and moved the footprint 1.4 MB as CoreGraphics images against 26.7 MB
    /// for the same bytes malloc'd: so twenty ordinary panes keep theirs, and
    /// window-sized ones, 5 MB each, give way past six.
    static let coverBudgetBytes = 32 << 20
    #if DEBUG
    /// `TUG_BODY_STALL_SNAPSHOTS=<n>`: the first `n` evictions' snapshots
    /// never answer, so a row can watch the eviction go on without a cover
    /// at the snapshot's deadline. DEBUG-only.
    private var snapshotsToStall = Int(ProcessInfo.processInfo.environment["TUG_BODY_STALL_SNAPSHOTS"] ?? "") ?? 0
    #endif
    /// How long a body may stay hidden before it gives up its process, ms:
    /// the reader's `evictAfterMs`, which the shell tells the host. Nil until
    /// it has, and no body is evicted by time before then.
    private(set) var evictAfterMs: Double?
    /// How long a warning waits after one eviction before it takes the next:
    /// time for the process the last one gave up to be gone, and for the
    /// level to say whether that was enough.
    static let warningStepDelay: DispatchTimeInterval = .seconds(1)
    /// How soon the clock asks again a hidden body whose page did not answer
    /// its eviction's save, ms, when that is sooner than `evictAfterMs`: a
    /// page busy for a moment is asked in a moment, not a whole delay later.
    static let unsavedRetryMs: Double = 30_000

    init(window: MainWindow, hostView: BodyHostView) {
        self.window = window
        self.hostView = hostView
        hostView.containerAt = { [weak self] point in
            self?.body(atViewportPoint: CGPoint(x: point.x, y: point.y))?.container
        }
        pressureSource.setEventHandler { [weak self] in
            guard let self else { return }
            let event = self.pressureSource.data
            self.memoryPressure(
                event.contains(.critical) ? .critical : event.contains(.warning) ? .warning : .normal
            )
        }
        pressureSource.activate()
    }

    deinit {
        pressureSource.cancel()
    }

    // MARK: - Lookup

    func body(for webView: WKWebView?) -> Body? {
        guard let webView else { return nil }
        return bodies.first { $0.webView === webView }
    }

    func body(forCard cardId: String) -> Body? {
        bodies.first { $0.cardId == cardId }
    }

    var spare: Body? {
        bodies.first { $0.cardId == nil && $0.state != .failed }
    }

    var webViews: [WKWebView] { bodies.map(\.webView) }

    /// The web view of the card's body, whatever its state — what the
    /// harness evaluates and clicks in when a verb names a card.
    func view(for cardId: String) -> WKWebView? {
        if cardId == Self.overlayCardId { return overlayView }
        return body(forCard: cardId)?.webView
    }

    // MARK: - The overlay

    /// The card id the overlay page answers to — on the bus, and to the
    /// harness's `card` — which no card of the deck ever takes
    /// (`tugdeck/src/lib/overlay-card.ts`).
    static let overlayCardId = "deck-overlay"

    /// The overlay's view: above the shell and every card, transparent, and
    /// passing every point outside its claim to the view beneath ([B07]).
    private(set) var overlayView: ClickThroughWebView?
    /// Where the overlay takes the pointer, as it last posted (`overlayClaim`).
    private var overlayClaim: CardHitRegion.Claim = .none
    /// What had the keyboard when a modal in the overlay took it, to give it back to.
    private weak var keysBeforeOverlay: NSResponder?

    /// `overlayCreate`: make the overlay's view and load its page. Idempotent.
    ///
    /// It draws no background, and until the window reveals the shell its
    /// layer is transparent: a hidden view is a hidden page to WebKit, which
    /// would stop painting it, so it is held by opacity as a body is. It
    /// stands over every card, so every drag into the window reaches it, and
    /// it hands each one on to the view a click there would reach.
    func createOverlay() {
        guard overlayView == nil else { return }
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + "/?overlay=\(Self.overlayCardId)") else {
            TugLog.error("bodies", "no shell origin to load the overlay from", [])
            return
        }
        let config = window.makeWebViewConfiguration(forShell: false)
        let view = ClickThroughWebView(frame: .zero, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = window
        view.uiDelegate = window
        view.allowsBackForwardNavigationGestures = false
        view.passesThrough = { [weak self] point in
            guard let self else { return true }
            return !self.overlayClaims(self.window.viewportPoint(point))
        }
        view.dragTarget = { [weak self] locationInWindow in
            guard let self, let container = self.hostView.superview else { return nil }
            let point = container.convert(locationInWindow, from: nil)
            if self.overlayClaims(self.window.viewportPoint(point)) { return nil }
            return self.window.dragTargetBeneathOverlay(at: locationInWindow)
        }
        view.wantsLayer = true
        if revealedAt == nil { view.layer?.opacity = 0 }
        window.placeOverCards(view, above: hostView)
        overlayView = view
        refreshAccessibilityOrder(force: true)
        view.load(URLRequest(url: url))
    }

    /// Whether the overlay takes the pointer at a viewport point.
    func overlayClaims(_ point: CGPoint) -> Bool {
        switch overlayClaim {
        case .all: return true
        case .rects(let rects): return rects.contains { $0.contains(point) }
        case .none: return false
        }
    }

    /// `overlayClaim`: where the overlay takes the pointer now. A claim of
    /// the whole window is a modal standing, and the modal takes the
    /// keyboard for its span; when it goes, the keyboard goes back to what
    /// had it, or to whoever the shell last named.
    func overlayClaimed(_ claim: CardHitRegion.Claim) {
        let wasAll = overlayClaim == .all
        overlayClaim = claim
        guard let view = overlayView else { return }
        let isAll = claim == .all
        if isAll && !wasAll {
            if window.firstResponder !== view { keysBeforeOverlay = window.firstResponder }
            window.makeFirstResponder(view)
        } else if wasAll && !isAll, window.firstResponder === view {
            if let before = keysBeforeOverlay, (before as? NSView)?.window === window {
                window.makeFirstResponder(before)
            } else {
                focus(cardId: keyboardCardId)
            }
            keysBeforeOverlay = nil
        }
    }

    /// Take the overlay's view down: its handlers off, its page stopped.
    private func removeOverlay() {
        guard let view = overlayView else { return }
        overlayView = nil
        if overlayClaim == .all, window.firstResponder === view { window.focusWebView() }
        overlayClaim = .none
        keysBeforeOverlay = nil
        HostChannel.unregister(from: view.configuration.userContentController)
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.stopLoading()
        view.removeFromSuperview()
        refreshAccessibilityOrder(force: true)
    }

    /// The overlay and the cards are shown with the shell, on the reveal's
    /// own clock.
    private func revealOverlay(fade: CAAnimation) {
        if let layer = hostView.layer, layer.opacity == 0 {
            layer.add(fade, forKey: "revealFade")
            layer.opacity = 1
        }
        guard let layer = overlayView?.layer, layer.opacity == 0 else { return }
        layer.add(fade, forKey: "revealFade")
        layer.opacity = 1
    }

    // MARK: - Create and bind

    /// The shell asks for a card's body. The waiting spare takes it when
    /// there is one, its page already loaded; otherwise the card waits in the
    /// lane for a cold body at `/?body=<cardId>`. A card that already has a
    /// body is re-bound only if it failed.
    func create(cardId: String, componentId: String, intent: JSONObject) {
        if let existing = body(forCard: cardId), existing.state != .failed {
            if existing.keptAcrossShellReload {
                reportKept(existing, cardId: cardId)
                return
            }
            TugLog.warn("bodies", "bodyCreate for a card that has a body; ignoring", [
                TugLog.field("card", cardId),
            ])
            return
        }
        if let spare {
            spare.cardId = cardId
            spare.componentId = componentId
            spare.intent = intent
            spare.warm = true
            spare.askedAt = CACurrentMediaTime()
            standCover(over: spare)
            armDeadline(spare)
            if spare.state == .connected { bind(spare) }
            return
        }
        if let index = lane.firstIndex(where: { $0.cardId == cardId }) {
            lane[index].componentId = componentId
            lane[index].intent = intent
            return
        }
        laneSerials += 1
        lane.append(LaneEntry(
            cardId: cardId, componentId: componentId, intent: intent,
            askedAt: CACurrentMediaTime(), serial: laneSerials
        ))
        if cardPlacements[cardId] != nil { drainLane() } else { scheduleDrain() }
    }

    /// A body kept across a shell reload, asked for by the reloaded shell:
    /// it is told what the shell before it was, a ready page and its paint,
    /// since the body will not say either again. Its stores and facts reach
    /// the shell on the bus's hello, and its focus follows the `ready`.
    private func reportKept(_ body: Body, cardId: String) {
        body.keptAcrossShellReload = false
        TugLog.info("bodies", "kept across the shell's reload", [
            TugLog.field("card", cardId),
            TugLog.field("state", body.state.rawValue),
            TugLog.field("painted", body.painted ? "yes" : "no"),
        ])
        guard body.state == .ready else { return }
        notifyShell(BodyStateReport(cardId: cardId, state: .ready, readyMs: body.readyMs ?? 0, start: body.warm ? .warm : .cold))
        if body.painted { notifyShell(BodyStateReport(cardId: cardId, state: .painted)) }
    }

    /// The cards whose pages are loading: made, not yet ready. The spare is
    /// not one: it holds no card.
    private var inFlight: Int {
        bodies.filter { body in
            body.cardId != nil && (body.state == .loading || body.state == .connected || body.state == .bound)
        }.count
    }

    /// The next card the lane makes a page for: a shown card before a hidden
    /// one, then the deck's reading order, then the order it was asked for.
    /// A card the shell has not placed yet reads as hidden and last.
    private func nextInLane() -> Int? {
        func key(_ entry: LaneEntry) -> (Int, Int, Int) {
            let shown = cardPlacements[entry.cardId]?.visible == true ? 0 : 1
            return (shown, placedEntries[entry.cardId]?.deckIndex ?? Int.max, entry.serial)
        }
        return lane.indices.min { key(lane[$0]) < key(lane[$1]) }
    }

    /// Make pages for waiting cards while fewer than `laneWidth` are loading.
    /// Run when a card is asked for, when a placement lands, and when a page
    /// leaves the lane: ready, failed at its deadline, or gone.
    private func drainLane() {
        pendingDrain?.cancel()
        pendingDrain = nil
        while inFlight < BodyViewController.laneWidth, let index = nextInLane() {
            let entry = lane.remove(at: index)
            makeFromLane(entry)
        }
    }

    /// Drain once the shell's placement has had a moment to arrive.
    private func scheduleDrain() {
        guard pendingDrain == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.pendingDrain = nil
            self?.drainLane()
        }
        pendingDrain = work
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.lanePlacementWait, execute: work)
    }

    private func makeFromLane(_ entry: LaneEntry) {
        guard let made = make(cardId: entry.cardId, path: "/?body=\(entry.cardId)") else { return }
        made.componentId = entry.componentId
        made.intent = entry.intent
        // The card has been dark since it was asked for, not since its page
        // left the lane.
        made.askedAt = entry.askedAt
        standCover(over: made)
        armDeadline(made)
        // The shell placed the card while it waited, and will not again
        // until something moves: the page stands where that placement put it.
        if let (placed, deckIndex) = placedEntries[entry.cardId] {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            place(made, placed, deckIndex: deckIndex)
            // Into its rail's view if it is a rail member, and stacked.
            reconcileRails()
            CATransaction.commit()
            refreshRegion()
        }
    }

    /// A card brought back from an eviction stands under its last frame
    /// until its new page paints, and the shell is told `covered`, which is
    /// what lets it show the card from the hand-off. A card with no cover —
    /// critical pressure, a snapshot that failed or did not answer, a cover
    /// aged or budgeted out — is told nothing and arrives as any card does,
    /// under the shell's stand-in until its page paints.
    private func standCover(over body: Body) {
        guard let cardId = body.cardId, let kept = covers.removeValue(forKey: cardId) else { return }
        let cover = BodyCoverView(cover: kept, frame: body.container.bounds)
        if let insets = body.insets { cover.paneInsets = insets }
        cover.autoresizingMask = [.width, .height]
        body.container.addSubview(cover, positioned: .above, relativeTo: body.webView)
        body.cover = cover
        body.wasCovered = true
        notifyShell(BodyStateReport(cardId: cardId, state: .covered))
    }

    /// Make the spare: a body loaded at `/?body=spare`, connected and waiting
    /// for the next card. The caller decides when, and the lane has the last
    /// word: while a card's page is waiting or loading the spare would compete
    /// with the page the user is waiting for, so it is not made until the lane
    /// has drained, and the lane's last departure schedules it again.
    func createSpare() {
        // Critical pressure took the spare; the next arrival is cold.
        guard spare == nil, pressure.level != .critical else { return }
        guard laneIsIdle else { return }
        _ = make(cardId: nil, path: "/?body=spare")
    }

    /// No card's page is waiting in the lane or loading.
    private var laneIsIdle: Bool { lane.isEmpty && inFlight == 0 }

    /// Make the spare a beat from now, if there is none by then: after the
    /// shell's launch, after a bound body's ready, after the lane's last page
    /// leaves it, and after the spare is lost.
    func scheduleSpare() {
        pendingSpare?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.pendingSpare = nil
            self?.createSpare()
        }
        pendingSpare = work
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.spareDelay, execute: work)
    }

    private func make(cardId: String?, path: String) -> Body? {
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + path) else {
            TugLog.error("bodies", "no shell origin to load a body from", [
                TugLog.field("card", cardId ?? "spare"),
            ])
            return nil
        }
        let config = window.makeWebViewConfiguration(forShell: false)
        let webView = ClickThroughWebView(frame: .zero, configuration: config)
        // No backing of its own: what the page does not paint is the
        // container's surface, the pane's colour, rather than white.
        webView.setValue(false, forKey: "drawsBackground")
        // The harness's visible tier reads frames off bodies too, and a body
        // is its own web view with its own occlusion switch.
        if AppDelegate.harnessPidMode { MainWindow.keepRenderingWhenCovered(webView) }
        webView.navigationDelegate = window
        webView.uiDelegate = window
        webView.allowsBackForwardNavigationGestures = false
        webView.onActivationClick = { [weak window] location in
            window?.forwardActivationClick(at: location)
        }
        webView.keyboardNamed = { [weak self, weak webView] in
            guard let self, let webView, let cardId = self.body(for: webView)?.cardId else { return false }
            return self.keyboardCardId == cardId
        }

        serials += 1
        let container = BodyContainerView(serial: serials)
        container.wantsLayer = true
        container.layer?.masksToBounds = true
        // Hidden by opacity until the first fade: a hidden view is a hidden
        // page to WebKit, which would stop painting it.
        container.layer?.opacity = 0
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        hostView.addSubview(container)

        let body = Body(cardId: cardId, webView: webView, container: container)
        bodies.append(body)
        webView.load(URLRequest(url: url))
        return body
    }

    /// A body's page is connected and ready to be told what it is for.
    func didSayHello(_ body: Body) {
        if body.state == .loading { body.state = .connected }
        if body.cardId != nil, body.intent != nil { bind(body) }
    }

    private func bind(_ body: Body) {
        guard let cardId = body.cardId, let componentId = body.componentId,
              let intent = body.intent else { return }
        body.state = .bound
        body.boundAt = CACurrentMediaTime()
        send(.bodyBind(BodyBind(cardId: cardId, componentId: componentId, intent: intent, facts: window.bodyFacts())), to: body)
        // A page bound afresh has not heard whether it is shown.
        body.toldShown = nil
        reportVisibility(body)
        // A page bound afresh — a reload, a spare taking a card — has not
        // been told where its pane stands in its view.
        if let insets = body.insets {
            send(.cardInsets(insets), to: body)
        }
    }

    /// A body posted `frontendReady`: its card is mounted and quiet. It is
    /// not shown yet — that waits for `painted`.
    func didBecomeReady(_ body: Body) {
        guard let cardId = body.cardId, body.state != .failed else { return }
        #if DEBUG
        if readiesToStall > 0 {
            readiesToStall -= 1
            NSLog("BodyViewController: TUG_BODY_FORCE_STALL — ignoring a body's frontendReady")
            return
        }
        #endif
        body.deadline?.cancel()
        body.deadline = nil
        body.state = .ready
        let readyMs = body.boundAt.map { (CACurrentMediaTime() - $0) * 1000 } ?? 0
        body.readyMs = readyMs
        let wholeMs = body.askedAt.map { (CACurrentMediaTime() - $0) * 1000 } ?? readyMs
        TugLog.info("bodies", "ready", [
            TugLog.field("card", cardId),
            TugLog.field("ms", String(format: "%.1f", readyMs)),
            TugLog.field("whole_ms", String(format: "%.1f", wholeMs)),
            TugLog.field("start", body.warm ? "warm" : "cold"),
        ])
        notifyShell(BodyStateReport(cardId: cardId, state: .ready, readyMs: readyMs, start: body.warm ? .warm : .cold))
        // A body hidden before it was ready has had its clock running.
        armEviction(body)
        // Its page has left the lane; the next waiting card's may start.
        drainLane()
        // The spare this body may have taken is replaced once it has painted.
        scheduleSpare()
    }

    /// A body posted `painted`: the frame carrying its card's content has
    /// gone to the compositor. From here a placement that names it visible
    /// shows it.
    func didPaint(_ body: Body) {
        guard let cardId = body.cardId, body.state == .ready || body.state == .bound, !body.painted else { return }
        body.painted = true
        // A body brought back from an eviction is its own page from here.
        body.cover?.removeFromSuperview()
        body.cover = nil
        TugLog.info("bodies", "painted", [TugLog.field("card", cardId)])
        notifyShell(BodyStateReport(cardId: cardId, state: .painted))
        // The show and its face's removal land together.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        applyVisibility(body)
        CATransaction.commit()
        // A revived body is shown by opacity under its cover and was never
        // `isHidden`, so `applyVisibility`'s re-take never fires for it: the
        // card the shell names for the keyboard takes it on its paint.
        if keyboardCardId == cardId, body.visible, body.canShow,
           !(overlayClaim == .all && overlayView != nil), window.firstResponder !== body.webView {
            window.makeFirstResponder(body.webView)
        }
    }

    // MARK: - Placement

    /// Show a painted body placed visible, at once and in full; hide
    /// anything else. Nothing here animates.
    private func applyVisibility(_ body: Body) {
        let showing = body.visible && body.canShow
        guard let layer = body.container.layer else { return }
        defer { reportVisibility(body) }
        if showing {
            // The card's own page is on screen: its face goes in this same transaction.
            if let cardId = body.cardId { removeFace(cardId) }
            let wasHidden = body.container.isHidden
            body.container.isHidden = false
            body.container.passesPointer = false
            body.shownOnce = true
            layer.opacity = 1
            // Hiding a view that held the keyboard made AppKit hand it to
            // the window, and nothing in the shell changed for it to hand
            // it back: the deck's first responder is still this card. So a
            // body the shell last named for the keyboard takes it again the
            // moment it is shown — a fold's unfold, a slide's land — unless
            // the shell has since named another owner (row 6's reading).
            if wasHidden, let cardId = body.cardId, keyboardCardId == cardId,
               window.firstResponder !== body.webView {
                window.makeFirstResponder(body.webView)
            }
        } else if body.shownOnce {
            if body.sibling {
                // A sibling behind the pane's active card: transparent, still
                // painting, never a hidden page.
                body.container.isHidden = false
                body.container.passesPointer = true
                layer.opacity = 0
                refreshRegion()
                return
            }
            // Shown before: hide it as any hidden page is, so WebKit
            // throttles a parked or folded body.
            body.container.isHidden = true
        } else {
            // Not shown yet: transparent, still painting, never a hidden
            // page. A page loaded into a hidden view runs no frame callback,
            // and `painted` is said after two of them.
            body.container.isHidden = false
            body.container.passesPointer = true
            layer.opacity = 0
        }
        refreshRegion()
    }

    /// Tell a bound body's page whether it is shown, when that has changed
    /// since it was last told. Shown is what the user can see: a body placed
    /// visible that can show, or a sibling at opacity 0, which stands for its
    /// pane. A body hidden before its first showing paints at opacity 0 and
    /// is not shown, so it goes dormant and is evicted like any hidden body.
    private func reportVisibility(_ body: Body) {
        let shown = body.seen
        if body.shown?.value != shown {
            body.shown = (shown, Date().timeIntervalSince1970 * 1000)
            armEviction(body)
        }
        guard let current = body.shown, body.state == .bound || body.state == .ready,
              body.toldShown != current.value else { return }
        body.toldShown = current.value
        send(.bodyVisibility(BodyVisibility(shown: current.value, since: current.since)), to: body)
    }

    private func refreshRegion() {
        region.visibleFrames = visibleBodies.map(\.frame)
        region.visibleGrips = visibleBodies.map(\.shellControls)
        region.visibleShapes = visibleBodies.map { body in
            guard body.whole, let cardId = body.cardId else { return nil }
            return CardHitShape(
                paneRect: body.frame.insetBy(dx: cardApron, dy: cardApron),
                apron: cardApron,
                grips: cardPlacements[cardId]?.grips ?? []
            )
        }
        refreshAccessibilityOrder()
    }

    /// The showing bodies in the order the shell posts them — the deck's
    /// reading order — which the window reads after the shell's own view.
    var bodiesInDeckOrder: [Body] {
        bodies
            .filter { $0.visible && $0.canShow }
            .sorted { $0.deckIndex < $1.deckIndex }
    }

    private var orderedAccessibility: [String] = []

    /// Hand the window its reading order, only when it changed.
    private func refreshAccessibilityOrder(force: Bool = false) {
        let ordered = bodiesInDeckOrder
        let ids = ordered.compactMap(\.cardId)
        if !force && ids == orderedAccessibility { return }
        orderedAccessibility = ids
        window.setAccessibilityOrder(bodies: ordered.map(\.webView), overlay: overlayView)
    }

    private var visibleBodies: [Body] {
        // Front to back, so a point over two bodies answers the one in front.
        bodies.enumerated()
            .filter { $0.element.visible && $0.element.canShow }
            .sorted { a, b in a.element.z != b.element.z ? a.element.z > b.element.z : a.offset > b.offset }
            .map(\.element)
    }

    /// The body a viewport point passes through to, if any.
    func body(atViewportPoint point: CGPoint) -> Body? {
        guard let index = regionNow.frameIndex(at: point) else { return nil }
        let visible = visibleBodies
        return index < visible.count ? visible[index] : nil
    }

    /// The hit region as the screen shows it now. A whole card a settle is
    /// carrying, or that a press has taken out of one, answers where it stands
    /// on screen, not at the landing its placement names: a press on its title
    /// bar mid-slide is a press on the card, as the user sees it there.
    private var regionNow: CardHitRegion {
        let visible = visibleBodies
        let shownElsewhere = { (body: Body) -> Bool in
            body.whole && (body.beats != nil || body === self.pressedOutOfBeats)
        }
        guard visible.contains(where: shownElsewhere) else { return region }
        var now = region
        for (index, body) in visible.enumerated() where shownElsewhere(body) {
            let shown = presentedRect(body)
            if index < now.visibleFrames.count { now.visibleFrames[index] = shown }
            if index < now.visibleShapes.count, var shape = now.visibleShapes[index] {
                shape.paneRect = shown.insetBy(dx: cardApron, dy: cardApron)
                now.visibleShapes[index] = shape
            }
        }
        return now
    }

    // MARK: - Cards in hand

    /// What the last `placeCards` said of one card: its pane rect, whether
    /// it shows, its stacking, the edges its pane offers as grips, whether
    /// the pane is free, and its resize floor.
    struct CardPlacement: Equatable {
        var rect: CGRect
        var visible: Bool
        var sibling: Bool
        /// The card is hidden only because its page cannot show yet: a
        /// hand-over draws its face (`BodyHandOver`).
        var face: Bool
        var z: Int
        var grips: Set<ResizeEdge>
        var free: Bool
        var min: CGSize
        /// The resize ceiling, when the arrangement holds one (a slot's run).
        var maxHeight: CGFloat?
        /// The card's pane is a pinned rail member: its side, order and reflow.
        var rail: RailMembership?
        /// An imposed content card's travel under a rail width change.
        var railTravel: RailTravel?
    }

    /// The cards the last `placeCards` named, by card id. Read by the
    /// gesture tracker for its envelope; nothing is shown from it yet.
    private(set) var cardPlacements: [String: CardPlacement] = [:]
    /// The canvas the cards stand on, viewport points, and the zoom its
    /// layout is drawn at; nil before the shell has said.
    private(set) var cardCanvas: CGRect?
    private var cardZoom: CGFloat = 1
    /// The deck's card gap the last `placeCards` named, layout px.
    private var cardGap: CGFloat = 0
    private(set) var cardApron: CGFloat = CardGeometry.apron
    /// Each standing rail's width bounds, layout px, as the last `placeCards` named them.
    private(set) var railLimits = RailLimitsBySide()
    /// One view per shown rail, holding its members' containers.
    private var rails: [RailSide: RailView] = [:]
    /// The cards the last placement says the shell's rail draft holds: the
    /// host's, until the shell's release, though the hand has let go.
    private var placementHeld: Set<String> = []

    /// The gesture the host is tracking now, one at a time. Every kind
    /// carries its views: a move or a resize the card in hand's, and a
    /// rail's edge (`rail`) every member of the rail and every content card
    /// beside it, drawn at the aim the host reports with each step, which
    /// the shell's rail draft previews its stand-ins at.
    private struct Gesture {
        let body: Body
        let cardId: String
        let kind: CardGestureKind
        let edge: ResizeEdge?
        /// A move's or a resize's arithmetic; for a rail's edge it answers
        /// only the press point, and `rail` carries the steps.
        var tracker: CardGestureTracker
        /// The container's frame at the press, which every step moves by the
        /// pane rect's own travel.
        let containerStart: CGRect
        var meta: Bool
        var alt: Bool
        var last: CardGestureTracker.Step
        var pointer: CGPoint
        /// A rail's edge in hand; nil for a move or a resize.
        var rail: RailHand?
        /// Every body the gesture holds: the card in hand, or every card of
        /// the rail's panes and of the panes beside it, siblings included. A
        /// placement and a plan leave them where the hand has them.
        let held: [Body]

        func holds(_ body: Body) -> Bool { held.contains { $0 === body } }
    }
    private var gesture: Gesture?

    /// A rail width drag in the host's hand: the aim it tracks, the footprint
    /// its ghost grows from, and the spring a release past a limit runs. It
    /// moves no card: the release commits the width, and the settle the
    /// commit runs carries the members and the cards beside the rail.
    private struct RailHand {
        var tracker: RailWidthTracker
        let view: RailView
        /// The pane rect of the member pressed, viewport points.
        let startRect: CGRect
        /// The union of the moving members' pane rects at the press, viewport
        /// points: the footprint the ghost grows from.
        let panes: CGRect
        /// How long a release past a limit springs back, ms; 0 for none.
        let springMs: Double
        var springing = false
        var last: RailWidthTracker.Step
    }

    /// The spring's curve, `rail-width.ts`'s `LIMIT_SPRING_EASING`: a cubic
    /// Bézier's control points.
    private static let railSpringCurve = (x1: 0.33, y1: 1.0, x2: 0.68, y2: 1.0)
    /// The spring running now, so a tick that outlived its spring does nothing.
    private var springSerial = 0
    /// The display link stepping the spring, while one runs.
    private var springLink: CADisplayLink?

    /// Whether a placement or a plan leaves `body` alone: the gesture holds
    /// it, or the shell's rail draft does and the shell has not yet released.
    private func isHeld(_ body: Body) -> Bool {
        if gesture?.holds(body) == true { return true }
        return body.cardId.map(placementHeld.contains) ?? false
    }

    /// Whether the host is tracking a card's drag or resize.
    var gestureLive: Bool { gesture != nil }

    /// Whether the left button is down, as the window last saw it: every
    /// press and release passes `MainWindow.sendEvent`, whatever posted it,
    /// where `NSEvent.pressedMouseButtons` reads only the hardware's state.
    private var leftButtonDown = false

    func noteLeftButton(down: Bool, atViewport point: CGPoint? = nil) {
        leftButtonDown = down
        if down, let point {
            takeFromBeats(at: point)
        } else if !down, let body = pressedOutOfBeats, gesture?.body !== body {
            // The press never became a gesture (a click in the content, or a
            // title-bar click whose `begin` has yet to arrive): the card goes
            // on to the landing its settle was bound for.
            pressedOutOfBeats = nil
            returnToLanding(body)
        }
    }

    /// A whole card a press took out of its beats, held where the press
    /// found it until a gesture claims it or the mouse comes up.
    private weak var pressedOutOfBeats: Body?

    /// A press on a whole card a settle is carrying stops it where the user
    /// sees it, before the press is dispatched: AppKit routes the press by
    /// the view's frame, which a beat leaves at the landing while only the
    /// layer moves, so a card left in its beats would not get the press that
    /// lands on it.
    private func takeFromBeats(at point: CGPoint) {
        guard let body = body(atViewportPoint: point), body.whole, body.beats != nil else { return }
        let shown = presentedRect(body)
        cancelBeats(body)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.container.frame = shown
        CATransaction.commit()
        pressedOutOfBeats = body
    }

    /// Carry a card a press held, and nothing then moved, on to its landing.
    private func returnToLanding(_ body: Body) {
        guard body.container.frame != body.frame else { return }
        let landing = body.frame
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            body.container.animator().frame = landing
        }
    }

    /// `placeCards`: every card's view, whether it shows, how it stacks, and
    /// how the hand holds it. The rect is the pane's, which the gesture
    /// carries; the view is the pane outset by `apron`, grown to whole
    /// points. A body the placement does not name is hidden.
    func placeCards(_ placement: PlaceCards) {
        // What is on screen before this placement moves anything, which the
        // hand-over is planned against.
        let handOverPlan = BodyHandOver.plan(onScreen: onScreenRects(), entries: placement.cards)
        placementHeld = Set(placement.held ?? [])
        cardApron = CGFloat(placement.apron)
        // A canvas the shell does not show leaves the last one standing.
        if let canvas = placement.canvas { cardCanvas = canvas.cgRect }
        if placement.zoom > 0 { cardZoom = CGFloat(placement.zoom) }
        if placement.gap >= 0 { cardGap = CGFloat(placement.gap) }
        railLimits = placement.rails
        var placements: [String: CardPlacement] = [:]
        // Each named card with where the placement lists it: the deck's
        // reading order, which is the window's VoiceOver order.
        var named: [String: (entry: CardPlacementEntry, deckIndex: Int)] = [:]
        for (index, entry) in placement.cards.enumerated() {
            named[entry.cardId] = (entry, index)
            placements[entry.cardId] = CardPlacement(
                rect: entry.rect,
                visible: entry.visible,
                sibling: entry.sibling == true,
                face: entry.face == true,
                z: Int(entry.z),
                grips: Set(entry.grips),
                free: entry.free,
                min: CGSize(width: entry.min.width, height: entry.min.height),
                maxHeight: entry.maxHeight.map { CGFloat($0) },
                rail: entry.rail,
                railTravel: entry.railTravel
            )
        }
        cardPlacements = placements
        placedEntries = named
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for body in bodies {
            // A card in the host's hand is the host's until its gesture ends:
            // the placement that lands it is the shell's commit, after.
            if isHeld(body) { continue }
            // And so is one a press took from its beats, until the press
            // becomes a gesture or comes up.
            if body === pressedOutOfBeats { continue }
            guard let cardId = body.cardId, let (entry, deckIndex) = named[cardId] else {
                cancelBeats(body)
                body.visible = false
                body.sibling = false
                applyVisibility(body)
                continue
            }
            place(body, entry, deckIndex: deckIndex)
        }
        // Each rail's members into its rail view, and the containers in the
        // panes' order, back to front, moved in place.
        reconcileRails()
        // The views it takes down over an arriving card are handed to faces
        // in this same transaction.
        handOver(handOverPlan, placement)
        CATransaction.commit()
        refreshRegion()
        // The lane's order is the placement's: a card waiting on it may go.
        if !lane.isEmpty { drainLane() }
    }

    // MARK: - Hand-over

    /// One hand-over's account, for the harness (`handOvers`): what it
    /// planned, how long the shell's snapshot took to answer — how long its
    /// faces stood before they began to retire — how it ended, and each
    /// face's title-band ink as the snapshot drew the shell beneath them.
    struct HandOverRecord {
        let serial: Int
        let leaving: [String]
        let handedOver: [String]
        let faces: [String]
        var snapshotMs: Double?
        /// `pending` until the snapshot answers; then `landed`, `failed`,
        /// `deadline` at the horizon, or `superseded` by a newer hand-over.
        var outcome: String
        var faceInk: [String: Double]

        var json: JSONValue {
            let strings = { (list: [String]) in JSONValue.array(list.map(JSONValue.string)) }
            return .object([
                "serial": .number(Double(serial)),
                "leaving": strings(leaving),
                "handedOver": strings(handedOver),
                "faces": strings(faces),
                "snapshotMs": snapshotMs.map(JSONValue.number) ?? .null,
                "outcome": .string(outcome),
                "faceInk": .object(faceInk.mapValues(JSONValue.number)),
            ])
        }
    }

    /// A hand-over whose snapshot has not answered yet.
    private struct PendingHandOver {
        let serial: Int
        let plan: HandOverPlan
        /// When the placement that first stood its faces did: its horizon
        /// runs from here, however many hand-overs supersede it.
        let start: CFTimeInterval
    }

    /// How long a hand-over waits on the shell's snapshot before its faces
    /// retire regardless ([L33]): the placer's own landing guard.
    static let handOverDeadlineMs = 250
    /// How many host frames a landed hand-over's faces stand past the
    /// snapshot's answer: the shell's frame it answered for, presented.
    static let faceRetireFrames = 2
    /// How many hand-overs the account keeps, oldest dropped first.
    private static let handOverAccountLength = 16
    /// The last hand-over's serial; each takes the next.
    private var handOverSerial = 0
    private var handOverRecords: [HandOverRecord] = []
    private var pendingHandOver: PendingHandOver?
    /// The faces standing now, by card.
    private var faces: [String: BodyFaceView] = [:]
    /// Counting the host frames to a landed hand-over's retirement.
    private var retireLink: CADisplayLink?

    /// The last hand-overs, oldest first, and the faces standing now.
    func handOverAccount() -> JSONValue {
        .object([
            "handOvers": .array(handOverRecords.map(\.json)),
            "standing": .array(faces.keys.sorted().map(JSONValue.string)),
        ])
    }

    /// Hand over what `plan` names, inside `placement`'s own transaction:
    /// every view it hands over hides there by its placement, and here each
    /// card it faces gets a face drawn from its stand-in's display list, so
    /// the hide and the faces land in one commit. The shell's snapshot then
    /// says when the shell's own frame, with the live stand-ins, has
    /// rendered, and the faces retire two host frames after it answers.
    ///
    /// A face whose card the placement no longer marks, and does not place
    /// visible, goes; the rest follow their cards. A placement handing
    /// nothing over leaves a pending hand-over alone, and one re-posting the
    /// pending hand-over (`continues`) leaves it untouched; any other
    /// supersedes it, its horizon running from the first one's start.
    private func handOver(_ plan: HandOverPlan, _ placement: PlaceCards) {
        let named = Dictionary(placement.cards.map { ($0.cardId, $0) }, uniquingKeysWith: { first, _ in first })
        for (cardId, face) in faces {
            guard let entry = named[cardId], entry.face == true || entry.visible else {
                removeFace(cardId)
                continue
            }
            face.frame = entry.view.cgRect
            face.order = Int(entry.z)
        }
        guard !plan.handedOver.isEmpty else { return }
        var start = CACurrentMediaTime()
        if let pending = pendingHandOver {
            if BodyHandOver.continues(pending: pending.plan, next: plan) { return }
            setHandOverOutcome(pending.serial, "superseded")
            if !faces.isEmpty { start = pending.start }
        }
        let scale = window.backingScaleFactor
        for face in plan.faces {
            guard let entry = named[face.cardId], let draw = entry.faceDraw else { continue }
            // A card whose own page is on screen needs no face, and no later
            // show would take one down.
            if let body = body(forCard: face.cardId), body.visible, body.canShow { continue }
            let view: BodyFaceView
            if let standing = faces[face.cardId] {
                view = standing
            } else {
                serials += 1
                view = BodyFaceView(cardId: face.cardId, serial: serials)
                hostView.addSubview(view)
                faces[face.cardId] = view
            }
            view.frame = face.rect
            view.order = Int(entry.z)
            view.draw(draw, scale: scale)
        }
        sortStacking()
        // A newer hand-over owns every face standing: a retirement counting
        // for an older one stops.
        retireLink?.invalidate()
        retireLink = nil
        handOverSerial += 1
        let serial = handOverSerial
        pendingHandOver = PendingHandOver(serial: serial, plan: plan, start: start)
        handOverRecords.append(HandOverRecord(
            serial: serial,
            leaving: plan.leaving,
            handedOver: plan.handedOver,
            faces: plan.faces.map(\.cardId),
            snapshotMs: nil,
            outcome: "pending",
            faceInk: [:]
        ))
        if handOverRecords.count > Self.handOverAccountLength {
            handOverRecords.removeFirst(handOverRecords.count - Self.handOverAccountLength)
        }
        let remaining = max(0, Double(Self.handOverDeadlineMs) / 1000 - (CACurrentMediaTime() - start))
        DispatchQueue.main.asyncAfter(deadline: .now() + remaining) { [weak self] in
            guard let self, self.pendingHandOver?.serial == serial else { return }
            self.pendingHandOver = nil
            self.setHandOverOutcome(serial, "deadline")
            TugLog.warn("bodies", "hand-over past its horizon", [TugLog.field("serial", serial)])
            self.retireFaces()
        }
        guard let union = BodyHandOver.union(plan.faces) else { return }
        let faceEntries = placement.cards.filter { $0.face == true }
        let asked = CACurrentMediaTime()
        window.snapshotShell(rect: union) { [weak self] image in
            self?.snapshotAnswered(serial: serial, ms: (CACurrentMediaTime() - asked) * 1000, image: image, union: union, entries: faceEntries)
        }
    }

    /// The shell's snapshot answered for hand-over `serial`: its frame with
    /// the live stand-ins has rendered. Record what it took and what it drew
    /// beneath each face, and retire the faces two host frames on; with no
    /// image, retire them at once.
    private func snapshotAnswered(serial: Int, ms: Double, image: CGImage?, union: CGRect, entries: [CardPlacementEntry]) {
        guard pendingHandOver?.serial == serial else { return }
        pendingHandOver = nil
        let index = handOverRecords.firstIndex(where: { $0.serial == serial })
        if let index { handOverRecords[index].snapshotMs = ms }
        guard let image else {
            if let index { handOverRecords[index].outcome = "failed" }
            TugLog.warn("bodies", "hand-over snapshot failed", [TugLog.field("serial", serial)])
            retireFaces()
            return
        }
        if let index {
            let scale = CGFloat(image.width) / max(union.width, 1)
            var ink: [String: Double] = [:]
            for entry in entries {
                let rect = entry.view.cgRect
                guard let crop = image.cropping(to: BodyHandOver.cropRect(of: rect, in: union, scale: scale)) else { continue }
                let band = BodyHandOver.titleBand(viewSize: rect.size, insets: entry.insets, scale: scale)
                ink[entry.cardId] = BodyHandOver.inkShare(image: crop, band: band)
            }
            handOverRecords[index].faceInk = ink
            handOverRecords[index].outcome = "landed"
        }
        TugLog.info("bodies", "hand-over", [
            TugLog.field("serial", serial),
            TugLog.field("snapshot_ms", Int(ms.rounded())),
            TugLog.field("faces", faces.count),
        ])
        var frames = 0
        let tick = RailSpringTick { [weak self] link in
            guard let self, link === self.retireLink, self.handOverSerial == serial else {
                link.invalidate()
                return
            }
            frames += 1
            if frames >= Self.faceRetireFrames { self.retireFaces() }
        }
        let link = hostView.displayLink(target: tick, selector: #selector(RailSpringTick.fire(_:)))
        link.add(to: .main, forMode: .common)
        retireLink = link
    }

    private func setHandOverOutcome(_ serial: Int, _ outcome: String) {
        guard let index = handOverRecords.firstIndex(where: { $0.serial == serial }) else { return }
        handOverRecords[index].outcome = outcome
    }

    /// Every face goes, at once, and the live stand-ins beneath them show.
    private func retireFaces() {
        retireLink?.invalidate()
        retireLink = nil
        guard !faces.isEmpty else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for cardId in Array(faces.keys) { removeFace(cardId) }
        CATransaction.commit()
    }

    /// Take `cardId`'s face down, within the caller's transaction.
    private func removeFace(_ cardId: String) {
        faces.removeValue(forKey: cardId)?.removeFromSuperview()
    }

    // MARK: - Layers, tick by tick

    /// Every body's host layers, one row per body per display-link tick,
    /// while the harness's `bodyLayers` window runs: what the host put on
    /// screen for each card, frame by frame, beside what it believed of it.
    private var layerRows: [JSONValue] = []
    /// The display link sampling the layers, while a window runs.
    private var layerLink: CADisplayLink?
    /// When the window running now ends, in `CACurrentMediaTime`.
    private var layerUntil: CFTimeInterval = 0

    /// Sample every body's layers on each host frame for `windowMs`,
    /// beginning now, the rows of any earlier window dropped.
    func armBodyLayers(windowMs: Int) {
        layerLink?.invalidate()
        layerRows = []
        layerUntil = CACurrentMediaTime() + Double(windowMs) / 1000
        let tick = RailSpringTick { [weak self] link in
            guard let self, link === self.layerLink else {
                link.invalidate()
                return
            }
            self.sampleLayers()
            if CACurrentMediaTime() >= self.layerUntil { self.stopBodyLayers() }
        }
        let link = hostView.displayLink(target: tick, selector: #selector(RailSpringTick.fire(_:)))
        link.add(to: .main, forMode: .common)
        layerLink = link
        sampleLayers()
    }

    /// The window's rows so far, and whether it has ended.
    func readBodyLayers() -> JSONValue {
        .object(["done": .bool(layerLink == nil), "rows": .array(layerRows)])
    }

    private func stopBodyLayers() {
        layerLink?.invalidate()
        layerLink = nil
    }

    /// One row per bound body: its state, whether it has painted, stands
    /// under a cover, and is hidden; its container's presented opacity;
    /// whether a face stands for it; and whether the host shows it.
    private func sampleLayers() {
        let wall = Date().timeIntervalSince1970 * 1000
        var sampled = Set<String>()
        for body in bodies {
            guard let cardId = body.cardId else { continue }
            sampled.insert(cardId)
            let layer = body.container.layer
            layerRows.append(.object([
                "wall": .number(wall),
                "cardId": .string(cardId),
                "state": .string(body.state.rawValue),
                "painted": .bool(body.painted),
                "covered": .bool(body.cover != nil),
                "hidden": .bool(body.container.isHidden),
                "opacity": .number(Double(layer?.presentation()?.opacity ?? layer?.opacity ?? 0)),
                "faced": .bool(faces[cardId] != nil),
                "shown": .bool(body.visible && body.canShow),
                "start": .string(body.warm ? "warm" : "cold"),
            ]))
        }
        // A face for a card whose page is not made yet: the card has no
        // layers of its own to read, but the face is on screen for it.
        for cardId in faces.keys.sorted() where !sampled.contains(cardId) {
            layerRows.append(.object([
                "wall": .number(wall),
                "cardId": .string(cardId),
                "state": .string("unmade"),
                "painted": .bool(false),
                "covered": .bool(false),
                "hidden": .bool(true),
                "opacity": .number(0),
                "faced": .bool(true),
                "shown": .bool(false),
                "start": .string("cold"),
            ]))
        }
    }

    /// Every body the user can see now — its container on screen and its
    /// placement showing it — by card, at its view rect.
    private func onScreenRects() -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        for body in bodies {
            guard let cardId = body.cardId, !body.container.isHidden,
                  (body.container.layer?.opacity ?? 0) > 0, body.visible, body.canShow else { continue }
            out[cardId] = body.frame
        }
        return out
    }

    /// Stand `body` where its placement entry puts it.
    private func place(_ body: Body, _ entry: CardPlacementEntry, deckIndex: Int) {
        let frame = entry.view.cgRect
        let visible = entry.visible
        setWhole(body, true)
        body.sibling = entry.sibling == true
        if entry.insets != body.insets {
            body.insets = entry.insets
            send(.cardInsets(entry.insets), to: body)
        }
        body.cover?.paneInsets = entry.insets
        // A placement that names the plan carrying the card is its
        // landing, which the shell adopted as posted: the beats run on.
        // One that names no plan, or another — a drag taking its frame
        // mid-settle, a measurement after the plan — takes the card from
        // its beats. The id decides, never the rect ([B11]).
        if let beats = body.beats, !visible || entry.planId != beats.planId {
            cancelBeats(body)
        }
        body.frame = frame
        body.shellControls = entry.shell.map(\.cgRect)
        body.container.frame = frame
        body.visible = visible
        body.z = Int(entry.z)
        body.container.order = body.z
        body.deckIndex = deckIndex
        applyVisibility(body)
    }

    /// Stand every rail member's container in its rail's view and every other
    /// container in the host view, place each rail view at the union of its
    /// members, and sort. A body whose beats are running, one in the hand,
    /// and one a press took from its beats are left where they are, since a
    /// reparent ends their layer's animation: the landing reconciles them.
    /// A rail view whose member's beats run stands still, since the mapping
    /// its beats were solved against reads the rail view's bounds origin.
    private func reconcileRails() {
        for body in bodies {
            if body.beats != nil || body === pressedOutOfBeats || isHeld(body) { continue }
            let side = body.cardId.flatMap { cardPlacements[$0]?.rail?.side }
            let target: NSView = side.map(railView(for:)) ?? hostView
            if body.container.superview !== target { reparent(body, into: target) }
        }
        for (side, view) in rails where view.members.isEmpty {
            view.removeFromSuperview()
            rails[side] = nil
        }
        for view in rails.values {
            let members = bodies.filter { $0.container.superview === view }
            if members.contains(where: { $0.beats != nil }) { continue }
            let shown = members.filter { $0.visible && $0.canShow }
            view.place(RailView.union(of: (shown.isEmpty ? members : shown).map(\.container.frame)))
        }
        sortStacking()
    }

    /// The rail view for `side`, made in the host view when there is none.
    private func railView(for side: RailSide) -> RailView {
        if let view = rails[side] { return view }
        let view = RailView(side: side)
        hostView.addSubview(view)
        rails[side] = view
        return view
    }

    /// Move `body`'s container into `parent`, at the same viewport frame,
    /// with the first responder inside it kept: a removal resigns it to the
    /// window, so it is given back.
    private func reparent(_ body: Body, into parent: NSView) {
        let responder = window.firstResponder as? NSView
        let held = responder.map { $0.isDescendant(of: body.container) } ?? false
        let frame = body.container.frame
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        parent.addSubview(body.container)
        body.container.frame = frame
        CATransaction.commit()
        if held, let responder, window.firstResponder !== responder { window.makeFirstResponder(responder) }
    }

    /// The host view's containers and rail views in the panes' order, and
    /// each rail's members in theirs, moved in place.
    private func sortStacking() {
        sortStacked(in: hostView)
        for view in rails.values { sortStacked(in: view) }
    }

    /// `cardGesture` `begin`: a card's page has taken a title-bar or grip
    /// press, and the host is to carry the card until the mouse comes up. A
    /// press whose mouse-up beat the message here ends at once, as a click,
    /// so no gesture is left open waiting for an up that has already passed.
    func claimGesture(from body: Body, begin: CardGestureBegin) {
        guard let cardId = body.cardId, gesture == nil else { return }
        let kind = begin.kind
        let edge = begin.edge
        if kind != .move && edge == nil { return }
        // A rail's edge is carried over the rail the placement seats the
        // card on, within the bounds it names for that rail.
        let seat = cardPlacements[cardId]?.rail
        let limits = seat.flatMap { $0.side == .left ? railLimits.left : railLimits.right }
        if kind == .rail, limits == nil {
            TugLog.warn("bodies", "a rail's edge pressed on a card the placement seats on no rail; ignoring", [
                TugLog.field("card", cardId),
            ])
            return
        }
        // The press brings its card forward at once, as the shell's
        // activation of it will: until that placement arrives, a card pressed
        // from under a neighbour would travel under it. A Cmd-press moves a
        // card without raising it, as a background window moves.
        if !begin.meta { raise(body) }
        let placement = cardPlacements[cardId]
        // A card a settle is carrying is taken where the user sees it: its
        // beats stop, its container holds the presented frame, and the hand
        // moves it from there rather than from the landing it was bound for.
        let containerStart = standOutOfBeats(body)
        // A card lifted out of a rail by its title bar or a grip travels
        // above the rail, as a card of the host view: reparented now that
        // nothing animates on its layer, and stacked where `raise` put it.
        if kind != .rail, body.container.superview is RailView {
            reparent(body, into: hostView)
            sortStacking()
        }
        let startRect = body.whole
            ? containerStart.insetBy(dx: cardApron, dy: cardApron)
            : (placement?.rect ?? body.frame)
        // Where the press landed, as the page saw it: the window's mouse
        // location has moved on by the time `begin` arrives, and a press the
        // window was sent rather than the hand made never moves it at all.
        let pointer = body.webView.convert(CGPoint(x: begin.x, y: begin.y), to: hostView)
        let others = cardPlacements
            .filter { $0.key != cardId && $0.value.visible && !$0.value.sibling }
            .map(\.value.rect)
        let tracker = CardGestureTracker(
            kind: kind == .resize ? edge.map { .resize($0) } ?? .move : .move,
            startRect: startRect,
            startPointer: pointer,
            canvas: cardCanvas ?? hostView.bounds,
            zoom: cardZoom,
            minSize: placement?.min ?? .zero,
            // A card holding a height in its slot stops at its run's end,
            // not the canvas's: held past it, the edge stands there.
            maxSize: placement?.maxHeight.map { CGSize(width: CGFloat.greatestFiniteMagnitude, height: $0) },
            free: placement?.free ?? true,
            gap: cardGap,
            others: others
        )
        var hand: RailHand?
        var held = [body]
        if kind == .rail, let seat, let limits {
            let built = railHand(side: seat.side, limits: limits, startRect: startRect, pointer: pointer, springMs: begin.springMs ?? 0)
            hand = built.hand
            held = built.held
        }
        let pressed = Gesture(
            body: body, cardId: cardId, kind: kind, edge: edge, tracker: tracker,
            containerStart: containerStart, meta: begin.meta, alt: begin.alt,
            last: CardGestureTracker.Step(rect: startRect, moved: false), pointer: pointer,
            rail: hand, held: held
        )
        guard leftButtonDown else {
            report(pressed, phase: .end)
            if pressedOutOfBeats === body {
                pressedOutOfBeats = nil
                returnToLanding(body)
            }
            return
        }
        gesture = pressed
        if let hand { askRailEdge(hand, page: body) }
    }

    /// Take `body` from any beats running on it, its container standing
    /// where the user sees it; answers that frame.
    private func standOutOfBeats(_ body: Body) -> CGRect {
        guard body.beats != nil else { return body.container.frame }
        let shown = presentedRect(body)
        cancelBeats(body)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.container.frame = shown
        CATransaction.commit()
        return shown
    }

    /// The hand for a rail's edge pressed on `side` with the pressed member's
    /// pane at `startRect`, and every body it holds. The members are every
    /// card the placement seats on the side, the carried cards every one
    /// with a travel; both are held with their inactive siblings, which are
    /// not moved. The snap targets are the visible panes neither moves.
    private func railHand(
        side: RailSide, limits: RailWidthLimits, startRect: CGRect, pointer: CGPoint, springMs: Double
    ) -> (hand: RailHand, held: [Body]) {
        var held: [Body] = []
        var panes: [CGRect] = []
        for other in bodies {
            guard let id = other.cardId, let placement = cardPlacements[id] else { continue }
            let moves = placement.visible && !placement.sibling
            // A card a settle is carrying stands still where the press finds it.
            if let seat = placement.rail, seat.side == side {
                held.append(other)
                if moves {
                    _ = standOutOfBeats(other)
                    panes.append(placement.rect)
                }
            } else if placement.rail == nil, placement.railTravel != nil {
                held.append(other)
                if moves { _ = standOutOfBeats(other) }
            }
        }
        let others = CardGeometry.railSnapTargets(side: side, cardPlacements.values.map {
            .init(rect: $0.rect, visible: $0.visible, sibling: $0.sibling, rail: $0.rail, travel: $0.railTravel)
        })
        let tracker = RailWidthTracker(
            side: side, startWidth: startRect.width / cardZoom,
            pinnedEdge: side == .left ? startRect.minX : startRect.maxX,
            startPointer: pointer, limits: limits, canvas: cardCanvas ?? hostView.bounds,
            zoom: cardZoom, gap: cardGap, others: others
        )
        let hand = RailHand(
            tracker: tracker, view: railView(for: side), startRect: startRect,
            panes: panes.isEmpty ? startRect : RailView.union(of: panes),
            springMs: springMs,
            last: RailWidthTracker.Step(aim: tracker.startAim, moved: false)
        )
        return (hand, held)
    }

    /// Stack `body`'s container in front of every other, ahead of the
    /// placement that will say so: the next `placeCards` restores the
    /// shell's order, which by then has this card in front.
    private func raise(_ body: Body) {
        let top = bodies.filter { $0 !== body }.map(\.container.order).max() ?? body.container.order
        if body.container.order > top { return }
        // Its stacking with it: a placement skips a card in the hand, so
        // this is the card's order until the gesture's commit places it.
        body.z = top + 1
        body.container.order = body.z
        sortStacking()
    }

    /// A mouse event while a gesture is live: a drag steps it, an up ends it.
    func track(_ event: NSEvent) {
        // A rail springing back is the hand's no longer: the mouse it let go
        // of is done, and a new press's drag is not this gesture's to step.
        guard var live = gesture, live.rail?.springing != true else { return }
        switch event.type {
        case .leftMouseDragged:
            live.pointer = hostView.convert(event.locationInWindow, from: nil)
            live.meta = event.modifierFlags.contains(.command)
            live.alt = event.modifierFlags.contains(.option)
            if var hand = live.rail {
                hand.last = hand.tracker.step(pointer: live.pointer, alt: live.alt)
                live.rail = hand
                gesture = live
                if hand.last.moved { moveRail(hand, shown: hand.last.aim.shown, limit: hand.last.aim.limit != nil) }
            } else {
                live.last = live.tracker.step(pointer: live.pointer, alt: live.alt)
                gesture = live
                move(live)
            }
            report(live, phase: .move)
        case .leftMouseUp:
            // The release is where the hand let go, which a quick drag's
            // merged moves may never have reported: step to it first, so a
            // press and a release apart with nothing between them is a drag.
            live.pointer = hostView.convert(event.locationInWindow, from: nil)
            var springs = false
            if var hand = live.rail {
                hand.last = hand.tracker.step(pointer: live.pointer, alt: live.alt)
                if hand.last.moved { moveRail(hand, shown: hand.last.aim.shown, limit: hand.last.aim.limit != nil) }
                // Released past a limit, the ghost springs back to it, and the
                // hand keeps the rail until it arrives: the release is said
                // to the shell, and the width committed, when the spring lands.
                let aim = hand.last.aim
                springs = hand.last.moved && aim.limit != nil && hand.springMs > 0 && abs(aim.shown - aim.width) > 0.5
                hand.springing = springs
                live.rail = hand
            } else {
                live.last = live.tracker.step(pointer: live.pointer, alt: live.alt)
                move(live)
            }
            gesture = springs ? live : nil
            report(live, phase: springs ? .move : .end)
            if springs, let hand = live.rail { springRail(hand) }
            if !springs, let hand = live.rail { landRail(hand) }
            if pressedOutOfBeats === live.body {
                pressedOutOfBeats = nil
                // A hold that went nowhere commits nothing, so no placement
                // will come to land the card: it lands itself.
                // A rail's travel is its own tracker's, not the press's.
                if !(live.rail?.last.moved ?? live.last.moved) { returnToLanding(live.body) }
            }
        default:
            break
        }
    }

    /// End the gesture with nothing committed: Escape, or the window losing
    /// the mouse. The card goes back where the press found it.
    func cancelGesture() {
        guard let live = gesture else { return }
        // The hand already let go of a springing rail: what it released is
        // owed its commit, whatever interrupts the spring.
        if live.rail?.springing == true {
            finishSpring()
            return
        }
        gesture = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let hand = live.rail {
            landRail(hand)
        } else {
            live.body.container.frame = live.containerStart
        }
        CATransaction.commit()
        report(live, phase: .cancel)
        if pressedOutOfBeats === live.body {
            pressedOutOfBeats = nil
            returnToLanding(live.body)
        }
    }

    /// Carry the card's container by the pane rect's travel, in one
    /// transaction with nothing animating.
    private func move(_ live: Gesture) {
        let start = live.tracker.startRect
        let rect = live.last.rect
        let from = live.containerStart
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        live.body.container.frame = CGRect(
            x: from.minX + (rect.minX - start.minX),
            y: from.minY + (rect.minY - start.minY),
            width: from.width + (rect.width - start.width),
            height: from.height + (rect.height - start.height)
        )
        CATransaction.commit()
    }

    /// Tell the shell where the gesture stands (`onCardGesture`).
    private func report(_ live: Gesture, phase: CardGestureReport.Phase) {
        var r = live.last.rect
        var moved = live.last.moved
        var snapX = live.last.snapX
        var snapY = live.last.snapY
        var aim: RailAimReport?
        // A rail's edge: the pressed member's pane at the width drawn, and the aim.
        if let hand = live.rail {
            r = railFrame(hand.startRect, hand, shown: hand.last.aim.shown)
            moved = hand.last.moved
            snapX = hand.last.snapX
            snapY = nil
            let a = hand.last.aim
            aim = RailAimReport(width: Double(a.width), shown: Double(a.shown), limit: a.limit?.rawValue)
        }
        let snapped = snapX != nil || snapY != nil
        let report = CardGestureReport(
            cardId: live.cardId,
            kind: live.kind,
            phase: phase,
            rect: PlanRect(x: r.minX, y: r.minY, width: r.width, height: r.height),
            pointer: .init(x: live.pointer.x, y: live.pointer.y),
            start: .init(x: live.tracker.startPointer.x, y: live.tracker.startPointer.y),
            moved: moved,
            meta: live.meta,
            alt: live.alt,
            edge: live.edge,
            snap: snapped ? .init(x: snapX.map(Double.init), y: snapY.map(Double.init)) : nil,
            rail: aim
        )
        window.sendToShell(.cardGesture(report))
    }

    /// A member's frame, `start` at the press, with the rail drawn at
    /// `shown`: widened at the deck-facing edge by the rail's growth.
    private func railFrame(_ start: CGRect, _ hand: RailHand, shown: CGFloat) -> CGRect {
        let points = (shown - hand.tracker.startWidth) * hand.tracker.zoom
        var r = start
        r.size.width += points
        if hand.tracker.side == .right { r.origin.x -= points }
        return r
    }

    /// The press on a rail's edge: the pressed member's page is asked for the
    /// colours its edge paints in, which the ghost wears once they arrive.
    private func askRailEdge(_ hand: RailHand, page body: Body) {
        let ghost = hand.view.ghost
        window.hostChannel.call(.railEdge, in: body.webView) { result in
            guard case .success(.railEdge(let colors)) = result else { return }
            ghost.colors = colors
        }
    }

    /// A step of the hand on a rail's edge, or of the spring a release past a
    /// limit runs: the ghost stands at the footprint the rail would take at
    /// `shown`, its edge in the limit's colour for a hand pressing past one.
    /// Nothing on the deck moves while the hand is down: not a member, not
    /// its page, not the cards beside the rail.
    private func moveRail(_ hand: RailHand, shown: CGFloat, limit: Bool) {
        let growth = (shown - hand.tracker.startWidth) * hand.tracker.zoom
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        hand.view.ghost.pastLimit = limit
        hand.view.standGhost(RailView.ghostFrame(side: hand.tracker.side, panes: hand.panes, growth: growth), in: hostView)
        CATransaction.commit()
    }

    /// The hand has let go, or the gesture was cancelled: the ghost goes, and
    /// every card still stands where the press found it. A release's commit
    /// lands the width through the settle it runs (`runPlan`), whose beats
    /// carry each member and each card beside the rail, every page that
    /// changes size pinned at its landing and clipped as it moves; a cancel
    /// commits nothing, and nothing moved to be put back.
    private func landRail(_ hand: RailHand) {
        springLink?.invalidate()
        springLink = nil
        hand.view.removeGhost()
    }

    /// A release past a limit: the ghost springs from where the hand left it
    /// to the limit, over the span the body page posted at the press, on the
    /// shell's spring curve, through the same step the hand's moves take, so
    /// the spring is in step as the drag is. The hand keeps the rail until
    /// the spring arrives.
    private func springRail(_ hand: RailHand) {
        springSerial += 1
        let serial = springSerial
        let from = hand.last.aim.shown
        let to = hand.last.aim.width
        let begin = CACurrentMediaTime()
        let duration = hand.springMs / 1000
        let curve = Self.railSpringCurve
        let tick = RailSpringTick { [weak self] link in
            guard let self, serial == self.springSerial, let hand = self.gesture?.rail, hand.springing else {
                link.invalidate()
                return
            }
            let t = min(1, max(0, (link.targetTimestamp - begin) / duration))
            let eased = CardGeometry.cubicBezier(t, x1: curve.x1, y1: curve.y1, x2: curve.x2, y2: curve.y2)
            self.moveRail(hand, shown: from + (to - from) * CGFloat(eased), limit: false)
            if t >= 1 { self.finishSpring(serial: serial) }
        }
        let link = hostView.displayLink(target: tick, selector: #selector(RailSpringTick.fire(_:)))
        link.add(to: .main, forMode: .common)
        springLink = link
    }

    /// The spring is over, naturally or cut short: the ghost goes, the hand
    /// lets go, and the release is said to the shell at the limit, which
    /// commits it. `serial` names the spring a tick is for; nil finishes the
    /// one running now.
    private func finishSpring(serial: Int? = nil) {
        guard var live = gesture, var hand = live.rail, hand.springing else { return }
        if let serial, serial != springSerial { return }
        gesture = nil
        landRail(hand)
        hand.last.aim.shown = hand.last.aim.width
        live.rail = hand
        report(live, phase: .end)
    }

    // MARK: - Beats

    /// The animation keys a plan's tracks run under: one per property, so a
    /// later plan's track replaces an earlier one's, and cancelling is
    /// removing three keys.
    private static let beatKeys = ["beats-position", "beats-bounds", "beats-opacity"]

    /// How long a solving plan waits for its cards to say `crossingSolved`
    /// before it starts without them, ms — and a crossing cover's snapshot
    /// deadline. The shell's `SOLVE_GUARD_MS` mirrors it.
    static let solveGuardMs: Double = 250

    /// A solving plan between its receipt and its start: every card it put
    /// tracks on, the cards it still awaits, when it arrived (media time),
    /// and the guard that starts it without them ([L27]: cancelled when the
    /// plan starts).
    private final class PlanSolve {
        let planId: Int
        let receivedAt: CFTimeInterval
        var carried: [Carried] = []
        var awaited: Set<ObjectIdentifier> = []
        var guardItem: DispatchWorkItem?
        init(planId: Int, receivedAt: CFTimeInterval) {
            self.planId = planId
            self.receivedAt = receivedAt
        }
    }

    /// One card a solving plan put tracks on, with what re-adding them takes.
    private struct Carried {
        weak var body: Body?
        let layer: CALayer
        let planned: PlannedCard
        let track: BodyBeats.Track
        let mapping: LayerMapping
    }

    /// Every solving plan not yet started, by its id.
    private var solves: [Int: PlanSolve] = [:]

    /// `cardPlan`: carry each named card through its beats as Core
    /// Animation, on the chrome's clock. One anchor pair of the wall and
    /// media clocks is read for the whole plan, so every body's start is the
    /// shell's start moved onto the render server's clock.
    ///
    /// Each body runs one track per property over the whole plan — never an
    /// animation per beat, which would show the container's model value,
    /// the landing, between beats and through a prepare delay. The track
    /// holds the first beat's opening rect from now until it begins
    /// (`fillMode = .backwards`), and the container's model is the landing,
    /// so when the track ends nothing moves.
    ///
    /// A plan that `solves` lays each crossing card's page out at its
    /// landing size before the motion: the card is told `begin` with
    /// `solve`, and the plan starts once every such card has said
    /// `crossingSolved`, or at `solveGuardMs`. A whole card that shrinks is
    /// told only once its last frame stands over it as a cover, so the
    /// page's resize is never seen. Its tracks are added here all the same,
    /// with a provisional begin at the guard's horizon, so `.backwards`
    /// holds every container at First and `body.beats` claims it from the
    /// receipt — the placement naming the plan, `reconcileRails` and the
    /// press path all see it as the plan's — and `startPlan` re-adds them
    /// with the real begin. The provisional track is the guard: a solve
    /// that never answers starts at its horizon.
    func runPlan(_ plan: CardPlan) {
        let anchor = ClockAnchor(wallMs: Date().timeIntervalSince1970 * 1000, mediaTime: CACurrentMediaTime())
        let solve = plan.solves ? PlanSolve(planId: plan.planId, receivedAt: anchor.mediaTime) : nil
        // A solving plan's provisional begin is two display periods past the
        // guard, so the guard's own start, a period ahead of now, always
        // replaces the tracks before they have begun.
        let startWallMs = solve == nil
            ? plan.startWallMs
            : anchor.wallMs + Self.solveGuardMs + 2 * displayPeriodSec * 1000
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for planned in plan.cards {
            guard let body = body(forCard: planned.cardId) else { continue }
            // A card in the host's hand is the hand's until the gesture ends.
            if isHeld(body) { continue }
            // An arrival rides its frame's arrive beat in: the shell posts it
            // visible from the plan, so it is shown here, in this
            // transaction, at its landing. Its tracks
            // hold their opening values until they begin (`.backwards`), so
            // no frame shows it before the fade; and a plan the host cannot
            // run still leaves it shown where it lands.
            if planned.arrives == true, !body.visible, body.canShow {
                body.visible = true
                body.frame = planned.landing.cgRect
                body.container.frame = planned.landing.cgRect
                applyVisibility(body)
            }
            guard body.visible, body.canShow,
                  let layer = body.container.layer,
                  let track = BodyBeats.planTrack(planned.beats) else {
                decline(body, planId: plan.planId, landing: planned.landing.cgRect)
                continue
            }
            // A track of no duration — a split's revealed member, landing at
            // its tile before the first frame — has nothing to run. In a
            // solving plan its page is solved all the same: its container
            // stands at its landing at once, behind the survivor that z-order
            // keeps in front, and its crossing ends when the plan starts, its
            // track's end being its start. Anywhere else it is declined.
            let instant = track.durationMs <= 0
            guard !instant || (solve != nil && planned.crossing != nil) else {
                decline(body, planId: plan.planId, landing: planned.landing.cgRect)
                continue
            }
            cancelBeats(body)
            let landing = planned.landing.cgRect
            let crossing = planned.crossing.map { CGSize(width: $0.width, height: $0.height) }
            guard let mapping = probeMapping(body, landing: landing, holdPage: crossing != nil) else {
                NSLog("BodyViewController: no layer mapping for %@; its beats are not run", planned.cardId)
                decline(body, planId: plan.planId, landing: landing)
                continue
            }
            body.mapping = mapping
            let planId = plan.planId
            let lateMs = instant ? 0 : addTracks(
                body, layer: layer, planned: planned, track: track, mapping: mapping,
                anchor: anchor, startWallMs: startWallMs, planId: planId
            )
            solve?.carried.append(Carried(body: body, layer: layer, planned: planned, track: track, mapping: mapping))
            body.beats = (planId, landing, lateMs)
            body.frame = landing
            if let crossing {
                let moveBegin = anchor.beginTime(startWallMs: startWallMs, delayMs: Self.firstMoveMs(planned, track))
                // A whole card's page is the card, chrome and all, and it
                // wears no surface behind it: given its smaller landing size
                // bare, the card would stand at its landing for the whole
                // motion over the canvas the container still spans. So a
                // whole card that shrinks takes its new size only under its
                // cover, and with none it keeps its page to the land.
                //
                // A card that stands at First for the whole motion and lands
                // only at its end — a stack's retiring member, held at its
                // tile while the survivor grows over it — shows its First face
                // throughout, whatever its size does, so it takes its new size
                // under a cover too.
                let page = body.webView.frame.size
                let shrinksWhole = body.whole
                    && (crossing.width < page.width - 0.5 || crossing.height < page.height - 0.5)
                let holdsFirst = !instant && Self.firstMoveMs(planned, track) >= track.delayMs + track.durationMs
                let covers = shrinksWhole || holdsFirst
                body.crossing = (crossing, moveBegin, covers && solve == nil)
                body.lastCrossing = CrossingAccount(planId: planId, size: crossing)
                // Tell the body now, in this task, so it pins its scrollers
                // and acknowledges inside a display period: one hop to its
                // page and one back, never a round trip through tugcast.
                let spanMs = planned.beats.map { $0.delayMs + $0.durationMs }.max() ?? 0
                let begin = BodyCrossing(phase: .begin, width: crossing.width, height: crossing.height, durationMs: spanMs)
                if let solve {
                    solve.awaited.insert(ObjectIdentifier(body))
                    if covers {
                        coverForCrossing(body, planId: planId, begin: begin)
                    } else {
                        var solving = begin
                        solving.solve = true
                        send(.bodyCrossing(solving), to: body)
                    }
                } else {
                    send(.bodyCrossing(begin), to: body)
                }
            }
        }
        CATransaction.commit()
        refreshRegion()
        if let solve {
            solves[solve.planId] = solve
            if solve.awaited.isEmpty {
                // Every card was declined or carried no crossing: nothing to wait for.
                startPlan(solve.planId, timedOut: false)
            } else {
                let planId = solve.planId
                let item = DispatchWorkItem { [weak self] in self?.startPlan(planId, timedOut: true) }
                solve.guardItem = item
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(Self.solveGuardMs)), execute: item)
            }
        }
    }

    /// Stand a whole card's last frame over its page, then tell it its
    /// solving crossing: in the snapshot's completion, so the page's
    /// `crossingReady`, and the resize it permits, can never come before the
    /// cover stands. The frame is the page's First size — the web view's,
    /// which `probeMapping` held, never the container's, already the landing
    /// — at the screen's backing scale, and the cover does not clip: the
    /// container's own clip, which its bounds track drives, shrinks it. A
    /// snapshot that fails or misses `solveGuardMs` stands no cover: the card
    /// is told `begin` without `solve`, is not awaited, and keeps its page to
    /// the land.
    private func coverForCrossing(_ body: Body, planId: Int, begin: BodyCrossing) {
        guard let cardId = body.cardId else { return }
        let size = body.webView.frame.size
        let asked = CACurrentMediaTime()
        snapshotFrame(
            of: body, cardId: cardId, size: size, scale: window.backingScaleFactor,
            deadline: .milliseconds(Int(Self.solveGuardMs)), purpose: "a crossing's cover"
        ) { [weak self, weak body] image in
            guard let self, let body, !body.gone else { return }
            // Cancelled or carried on by a newer plan while the snapshot ran:
            // there is no crossing of this plan's left to cover.
            guard body.crossing != nil, body.lastCrossing?.planId == planId else { return }
            guard let image else {
                body.crossing?.keepsPage = true
                self.send(.bodyCrossing(begin), to: body)
                self.dropFromSolve(body, planId: planId)
                return
            }
            body.lastCrossing?.snapshotMs = (CACurrentMediaTime() - asked) * 1000
            body.lastCrossing?.coverPixels = CGSize(width: image.width, height: image.height)
            let cover = BodyCoverView(
                cover: BodyCover(
                    image: image, size: size, surface: body.surface, insets: body.insets,
                    takenAt: Date().timeIntervalSince1970 * 1000
                ),
                frame: CGRect(origin: .zero, size: size)
            )
            cover.autoresizingMask = []
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            body.container.addSubview(cover, positioned: .above, relativeTo: body.webView)
            CATransaction.commit()
            body.crossingCover = cover
            var solving = begin
            solving.solve = true
            self.send(.bodyCrossing(solving), to: body)
        }
    }

    /// `crossingSolved`: the body is laid out at its crossing size. Its plan
    /// starts once it awaits no other card. Late — the plan started or the
    /// crossing was cancelled — it is ignored.
    func crossingSolved(_ body: Body) {
        guard body.crossing != nil, let planId = body.lastCrossing?.planId, let solve = solves[planId],
              solve.awaited.remove(ObjectIdentifier(body)) != nil else { return }
        body.lastCrossing?.solved = true
        body.lastCrossing?.solveMs = (CACurrentMediaTime() - solve.receivedAt) * 1000
        if solve.awaited.isEmpty { startPlan(planId, timedOut: false) }
    }

    /// The plan no longer waits on `body`: its crossing was cancelled, or its
    /// cover could not be taken.
    private func dropFromSolve(_ body: Body, planId: Int) {
        guard let solve = solves[planId], solve.awaited.remove(ObjectIdentifier(body)) != nil else { return }
        if solve.awaited.isEmpty { startPlan(planId, timedOut: false) }
    }

    /// Add `planned`'s tracks to `body`'s container under the beat keys —
    /// replacing any there, whose delegate is then told `finished: false` and
    /// does nothing — beginning at `startWallMs` through `anchor`, and arm
    /// the window's frame meters on the beats that move it. Returns how late
    /// the start reached the host, ms.
    private func addTracks(
        _ body: Body, layer: CALayer, planned: PlannedCard, track: BodyBeats.Track, mapping: LayerMapping,
        anchor: ClockAnchor, startWallMs: Double, planId: Int
    ) -> Double {
        let begin = anchor.beginTime(startWallMs: startWallMs, delayMs: track.delayMs)
        let lateMs = max(0, anchor.mediaTime - begin) * 1000
        let localBegin = layer.convertTime(begin, from: nil)
        let position = Self.keyframes(
            "position", values: track.rects.map { NSValue(point: mapping.position(of: $0)) },
            track: track, begin: localBegin
        )
        position.delegate = BeatTrackDelegate { [weak self, weak body] (finished: Bool) in
            guard let self, let body, finished, let beats = body.beats, beats.planId == planId,
                  let cardId = body.cardId else { return }
            body.beats = nil
            self.endCrossing(body)
            self.notifyShell(BodyStateReport(cardId: cardId, state: .landed, planId: planId, lateMs: beats.lateMs))
            // A card a settle carried into or out of a rail joins its
            // rail's view, or leaves it, now that nothing animates on it.
            self.reconcileRails()
        }
        layer.add(position, forKey: Self.beatKeys[0])
        layer.add(Self.keyframes(
            "bounds", values: track.rects.map { NSValue(rect: mapping.bounds(of: $0)) },
            track: track, begin: localBegin
        ), forKey: Self.beatKeys[1])
        if let opacities = track.opacities {
            layer.add(Self.keyframes(
                "opacity", values: opacities.map { NSNumber(value: $0) }, track: track, begin: localBegin
            ), forKey: Self.beatKeys[2])
        }
        // A reading of the window armed now samples this container under
        // its card id, over the beats that move it; tracks added again drop
        // the spans of the ones they replace, none of which had begun.
        let moving = planned.beats.filter { $0.from != $0.to }.map { beat in
            let from = anchor.beginTime(startWallMs: startWallMs, delayMs: beat.delayMs)
            return (from: from, to: from + beat.durationMs / 1000)
        }
        for meter in window.armedFrameMeters {
            meter.cut(named: planned.cardId, at: anchor.mediaTime)
            meter.track(layer, named: planned.cardId, active: moving)
        }
        return lateMs
    }

    /// The delay of the first beat that moves the box: a prepare beat ahead
    /// of it holds First, and the page at its final size is clipped there
    /// exactly as before the plan. A crossing's lead is measured to it.
    private static func firstMoveMs(_ planned: PlannedCard, _ track: BodyBeats.Track) -> Double {
        planned.beats.first { $0.from != $0.to }?.delayMs ?? track.delayMs
    }

    /// The solve is over — every card answered or dropped out, or the guard
    /// ran out — and the plan starts: one display period from now, so the
    /// shell hears `planStarted` before the start rather than after it, and
    /// every card the plan still carries has its tracks added again on that
    /// begin, in one transaction, replacing the provisional ones.
    ///
    /// A card with a track of no duration lands here instead: its container
    /// already stands at its landing, so its crossing ends in the same
    /// transaction — the cover off, the page following its container — and
    /// the shell is told it landed.
    private func startPlan(_ planId: Int, timedOut: Bool) {
        guard let solve = solves.removeValue(forKey: planId) else { return }
        solve.guardItem?.cancel()
        let anchor = ClockAnchor(wallMs: Date().timeIntervalSince1970 * 1000, mediaTime: CACurrentMediaTime())
        let solveMs = (anchor.mediaTime - solve.receivedAt) * 1000
        let startWallMs = anchor.wallMs + displayPeriodSec * 1000
        var landed: [String] = []
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for carried in solve.carried {
            // A card a newer plan or a placement took since is not this plan's.
            guard let body = carried.body, let beats = body.beats, beats.planId == planId else { continue }
            if carried.track.durationMs <= 0 {
                body.beats = nil
                endCrossing(body)
                if let cardId = body.cardId { landed.append(cardId) }
                continue
            }
            let lateMs = addTracks(
                body, layer: carried.layer, planned: carried.planned, track: carried.track,
                mapping: carried.mapping, anchor: anchor, startWallMs: startWallMs, planId: planId
            )
            body.beats = (planId, beats.landing, lateMs)
            body.crossing?.begin = anchor.beginTime(
                startWallMs: startWallMs, delayMs: Self.firstMoveMs(carried.planned, carried.track)
            )
        }
        CATransaction.commit()
        for cardId in landed {
            notifyShell(BodyStateReport(cardId: cardId, state: .landed, planId: planId, lateMs: 0))
        }
        if !landed.isEmpty { reconcileRails() }
        if timedOut {
            TugLog.warn("bodies", "a plan's solve ran out its guard; it starts without every card", [
                TugLog.field("plan", "\(planId)"),
                TugLog.field("awaited", "\(solve.awaited.count)"),
                TugLog.field("guard_ms", "\(Int(Self.solveGuardMs))"),
            ])
        }
        window.sendToShell(.planStarted(PlanStarted(
            planId: planId, startWallMs: startWallMs, solveMs: solveMs, timedOut: timedOut
        )))
    }

    /// Take a body's beats off, and tell the shell when a plan was carrying it.
    private func cancelBeats(_ body: Body) {
        guard let beats = body.beats else { return }
        body.beats = nil
        for key in Self.beatKeys { body.container.layer?.removeAnimation(forKey: key) }
        endCrossing(body)
        dropFromSolve(body, planId: beats.planId)
        if let cardId = body.cardId {
            // A reading of the window stops judging the beats the body lost.
            for meter in window.armedFrameMeters {
                meter.cut(named: cardId, at: CACurrentMediaTime())
            }
            notifyShell(BodyStateReport(cardId: cardId, state: .beatsCancelled, planId: beats.planId))
        }
    }

    /// A body the plan names that the host cannot carry — not shown, not
    /// painted, or with no track or mapping to run — is placed at its
    /// landing at once, and the shell is told its beats were cancelled.
    /// The shell adopted the landing as posted when it sent the plan, so
    /// the land's measurement reads the same rect and posts nothing: left
    /// where it stood, the body would stay at First under a pane that has
    /// moved, until some later placement happened to differ.
    private func decline(_ body: Body, planId: Int, landing: CGRect) {
        cancelBeats(body)
        body.frame = landing
        body.container.frame = landing
        body.webView.frame = body.container.bounds
        body.webView.autoresizingMask = Self.pageResizing
        if let cardId = body.cardId {
            notifyShell(BodyStateReport(cardId: cardId, state: .beatsCancelled, planId: planId))
        }
    }

    /// Solve the container's frame-to-layer mapping by setting it to three
    /// frames about `landing` and reading its layer after each, and leave it
    /// at `landing`, its model value for the plan. The web view's
    /// autoresizing is off for the probe, so the page is never resized by
    /// it: the web view is set once, to the landing's bounds — or, for a
    /// body the plan carries to a new size (`holdPage`), left at the size it
    /// has, with autoresizing off, until the body is ready for the new one.
    private func probeMapping(_ body: Body, landing: CGRect, holdPage: Bool) -> LayerMapping? {
        guard let layer = body.container.layer else { return nil }
        let container = body.container
        let held = body.webView.frame.size
        body.webView.autoresizingMask = []
        defer {
            container.frame = landing
            if holdPage {
                body.webView.frame = CGRect(origin: .zero, size: held)
            } else {
                body.webView.frame = container.bounds
                body.webView.autoresizingMask = Self.pageResizing
            }
        }
        container.frame = landing
        let base = layer.position
        let origin = layer.bounds.origin
        container.frame = landing.offsetBy(dx: 1, dy: 1)
        let moved = layer.position
        container.frame = CGRect(x: landing.minX, y: landing.minY, width: landing.width + 1, height: landing.height + 1)
        let grown = layer.position
        return LayerMapping.solve(base: landing, at: base, moved: moved, grown: grown, boundsOrigin: origin)
    }

    /// How a body's page follows its container outside a crossing.
    static let pageResizing: NSView.AutoresizingMask = [.width, .height]

    /// `crossingReady`: the body has pinned its scrollers for the crossing
    /// its plan began. Its page takes the landing size now, once, top-left
    /// pinned in the flipped container, growing or shrinking, while the
    /// container's own track holds First; the container clips it to the
    /// rect the track has reached, and a whole card that shrinks does so
    /// under its cover. One that keeps its page — no cover could be taken —
    /// is resized at the land. Late or stale — the beats already landed or
    /// were cancelled — it is ignored, the page already restored.
    ///
    /// `surface` is the page's own background as sRGB bytes. The container
    /// wears it already (`setSurface`), and the crossing re-reads it: a box
    /// that shrinks is larger than the page until its track lands, and the
    /// strip the page does not reach is the body's surface rather than the
    /// canvas beneath.
    func crossingReady(_ body: Body, surface: [Double]?) {
        guard let crossing = body.crossing else { return }
        let leadMs = (crossing.begin - CACurrentMediaTime()) * 1000
        body.lastCrossing?.readyLeadMs = leadMs
        if crossing.keepsPage { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let surface, !body.whole {
            body.container.surface = Self.color(surface)
            body.container.displayIfNeeded()
            body.lastCrossing?.surface = surface
        }
        body.webView.autoresizingMask = []
        body.webView.frame = CGRect(origin: .zero, size: crossing.size)
        CATransaction.commit()
    }

    /// The crossing is over: the cover comes off and the page follows its
    /// container again. A solved page is the landing size already, so the
    /// land resizes nothing; only a page that never took its crossing size —
    /// one kept to the land, or one that never said ready — is given the
    /// container's bounds here.
    private func endCrossing(_ body: Body) {
        guard let crossing = body.crossing else { return }
        body.crossing = nil
        body.lastCrossing?.restored = true
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let bounds = body.container.bounds
        let page = body.webView.frame.size
        if crossing.keepsPage || abs(page.width - bounds.width) > 0.5 || abs(page.height - bounds.height) > 0.5 {
            body.webView.frame = bounds
        }
        body.webView.autoresizingMask = Self.pageResizing
        body.crossingCover?.removeFromSuperview()
        body.crossingCover = nil
        CATransaction.commit()
        send(.bodyCrossing(.land), to: body)
    }

    /// `bodySurface`: the page's background as sRGB bytes, posted when it
    /// paints and whenever its theme changes. The container wears it behind
    /// the web view for as long as the body stands.
    func setSurface(_ body: Body, surface: [Double]?) {
        guard let surface else { return }
        body.surface = Self.color(surface)
        if !body.whole { body.container.surface = body.surface }
    }

    /// Four sRGB bytes, which the surface's decode has checked, as a colour.
    private static func color(_ bytes: [Double]) -> CGColor {
        let c = bytes.map { CGFloat($0) / 255 }
        return CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: c[3])
    }

    /// Hold the body's container as a whole card's view: its page draws its
    /// own corners and surface, and its apron must show what is beneath it.
    private func setWhole(_ body: Body, _ whole: Bool) {
        body.whole = whole
        body.container.surface = whole ? nil : body.surface
    }

    private static func keyframes(_ keyPath: String, values: [Any], track: BodyBeats.Track, begin: CFTimeInterval) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.keyTimes = track.keyTimes.map { NSNumber(value: $0) }
        animation.timingFunctions = track.timings.map(timingFunction)
        animation.calculationMode = .linear
        animation.duration = track.durationMs / 1000
        animation.beginTime = begin
        animation.fillMode = .backwards
        animation.isRemovedOnCompletion = true
        return animation
    }

    /// A segment's timing: linear between samples, or a fade's CSS keyword.
    private static func timingFunction(_ timing: BodyBeats.Timing) -> CAMediaTimingFunction {
        switch timing {
        case .linear:
            return CAMediaTimingFunction(name: .linear)
        case .easing(let keyword):
            switch keyword {
            case "ease": return CAMediaTimingFunction(name: .default)
            case "ease-in": return CAMediaTimingFunction(name: .easeIn)
            case "ease-out": return CAMediaTimingFunction(name: .easeOut)
            case "ease-in-out": return CAMediaTimingFunction(name: .easeInEaseOut)
            default: return CAMediaTimingFunction(name: .linear)
            }
        }
    }

    /// The display period of the screen the window is on, seconds, which the
    /// harness reads beside a body's frames. 60 Hz when the window has no
    /// screen yet.
    private var displayPeriodSec: Double {
        let fps = window.screen?.maximumFramesPerSecond ?? 60
        return 1 / Double(max(1, fps))
    }

    // MARK: - The reveal

    /// The window is revealing the shell over the splash with `fade`. The
    /// cards and the overlay fade in with it, on the fade's own clock, so
    /// the splash gives way to the deck as one picture.
    func shellDidReveal(fade: CAAnimation) {
        revealedAt = CACurrentMediaTime()
        revealOverlay(fade: fade)
    }

    // MARK: - Focus

    /// `bodyFocus`: the named card's body takes the keyboard, or the shell
    /// does when the card has none.
    func focus(cardId: String?) {
        keyboardCardId = cardId
        // A modal standing in the overlay keeps the keyboard: the card named
        // now has it once the modal goes (`overlayClaimed`).
        if overlayClaim == .all, overlayView != nil { return }
        if let cardId, let body = body(forCard: cardId) {
            window.makeFirstResponder(body.webView)
        } else {
            window.focusWebView()
        }
    }

    /// The card whose body the shell last gave the keyboard to, or nil for
    /// the shell. What the host's own focus moves — the launch reveal's —
    /// defer to, so they do not take the keyboard back from a body.
    private(set) var keyboardCardId: String?

    /// Give the keyboard to whoever the shell last named: that card's
    /// body, or the shell — or the overlay, while a modal stands in it.
    func focusKeyboardOwner() {
        if overlayClaim == .all, let overlayView {
            window.makeFirstResponder(overlayView)
            return
        }
        focus(cardId: keyboardCardId)
    }

    // MARK: - Teardown

    /// `bodyDestroy`. With `save`, the body writes its card's state first.
    /// The card is gone from here: an eviction in flight leaves it alone.
    func destroy(cardId: String, save: Bool) {
        removeFace(cardId)
        covers.removeValue(forKey: cardId)
        // A card still waiting in the lane has no page to save.
        lane.removeAll { $0.cardId == cardId }
        guard let body = body(forCard: cardId) else { return }
        body.gone = true
        body.evicting = false
        body.evictDue?.cancel()
        body.evictDue = nil
        guard save else {
            remove(body)
            return
        }
        window.hostChannel.call(.saveState, in: body.webView) { [weak self] _ in
            self?.remove(body)
        }
    }

    /// Every body, at once, and the overlay with them. Used where the
    /// window's bridge is taken down.
    func destroyAll() {
        clearLane()
        stopBodyLayers()
        // A hand-over in flight ends with the window: its answer, horizon
        // and retirement find a serial moved on.
        handOverSerial += 1
        pendingHandOver = nil
        retireFaces()
        covers.removeAll()
        for body in bodies { remove(body) }
        // After the removals, which leave the lane idle and would ask for a
        // spare the window going away has no use for.
        pendingSpare?.cancel()
        pendingSpare = nil
        removeOverlay()
    }

    /// The shell is about to reload, and its bodies stay: each is still its
    /// card's page, bound and on screen. Each ready one still writes its
    /// card's state, as a reload always has, so a reload leaves every card on
    /// disk; nothing waits on the save, which finishes in a page the reload
    /// does not touch. What goes is what the shell's page held: the overlay,
    /// which the reloaded shell asks for again (`overlayCreate`), and a
    /// gesture in the host's hand, whose shell is going. The reloaded shell's
    /// restore pass asks for every card again, and a kept body is told then
    /// where it stands (`reportKept`).
    ///
    /// An evicted card has no body to keep. The reloaded shell hands it off
    /// as it hands off any card it does not show — no page asked for, the
    /// card standing evicted until the deck wants it shown
    /// (`releaseDeferredBody`) — so a reload does not bring the evicted
    /// cards back at once.
    func keepAcrossShellReload() {
        if gestureLive { cancelGesture() }
        removeOverlay()
        for body in bodies where body.cardId != nil {
            body.keptAcrossShellReload = true
            if body.state == .ready { window.hostChannel.call(.saveState, in: body.webView) { _ in } }
        }
    }

    /// How long a body's save may hold its reload for an edit, or its eviction.
    static let saveDeadline: DispatchTimeInterval = .seconds(2)

    /// Nothing waits in the lane: the bodies are all going.
    private func clearLane() {
        pendingDrain?.cancel()
        pendingDrain = nil
        lane.removeAll()
    }

    /// The bodies that can answer `prepareForTermination()`: bound and ready.
    var terminable: [(cardId: String, webView: WKWebView)] {
        bodies.compactMap { body in
            guard let cardId = body.cardId, body.state == .ready else { return nil }
            return (cardId, body.webView)
        }
    }

    private func remove(_ body: Body) {
        guard bodies.contains(where: { $0 === body }) else { return }
        body.gone = true
        body.evicting = false
        body.deadline?.cancel()
        body.deadline = nil
        body.evictDue?.cancel()
        body.evictDue = nil
        // A card going away mid-gesture takes its gesture with it: a rail's
        // drag takes its ghost away, or commits the spring the hand released.
        if let live = gesture, live.holds(body) {
            if live.rail != nil { cancelGesture() } else { gesture = nil }
        }
        bodies.removeAll { $0 === body }
        // A body that held the keyboard takes it with it; AppKit hands it to
        // the window, so give it to whoever the shell names — another card's
        // body, the shell, or a modal standing in the overlay.
        let heldKeys = (window.firstResponder as? NSView)?.isDescendant(of: body.container) ?? false
        let controller = body.webView.configuration.userContentController
        HostChannel.unregister(from: controller)
        body.webView.navigationDelegate = nil
        body.webView.uiDelegate = nil
        body.webView.stopLoading()
        body.container.removeFromSuperview()
        // A rail left with no member goes with its last one.
        reconcileRails()
        if heldKeys { focusKeyboardOwner() }
        if let cardId = body.cardId {
            window.bodyDidGoAway(cardId: cardId)
        }
        refreshRegion()
        // A page gone, failed at its deadline or destroyed, has left the lane.
        if !lane.isEmpty { drainLane() }
        // The last page to leave the lane may have left it by failing, with
        // no ready to make the spare after it.
        if laneIsIdle, spare == nil { scheduleSpare() }
    }

    // MARK: - Eviction

    /// The machine says how short of memory it is. On `warning` hidden
    /// bodies give up their processes oldest-hidden first, one at a time,
    /// until the warning clears or none is left; on `critical` every body
    /// the last placement did not name visible goes at once, a pane's
    /// siblings and the spare with them, and the spare is made again once
    /// the level eases. A body placed visible is never evicted, and nothing
    /// here counts bodies.
    func memoryPressure(_ level: PressureLevel) {
        let was = pressure.level
        pressure = (level, Date().timeIntervalSince1970 * 1000)
        TugLog.info("bodies", "memory pressure", [TugLog.field("level", level.rawValue)])
        window.sendToShell(.bodyPressure(BodyPressure(level: level, at: pressure.at)))
        pendingWarningStep?.cancel()
        pendingWarningStep = nil
        declined = []
        switch level {
        case .normal:
            if was == .critical { scheduleSpare() }
            return
        case .warning:
            // A warning keeps the spare: one critical took is made again.
            if was == .critical { scheduleSpare() }
            evictOldestHidden()
        case .critical:
            pendingSpare?.cancel()
            pendingSpare = nil
            if let spare { remove(spare) }
            // The covers are memory too: their cards come back under the
            // shell's stand-in.
            covers.removeAll()
            for body in bodies where evictable(body, siblings: true) {
                evict(body, cause: "pressure-critical")
            }
        }
    }

    /// Whether pressure may take the body's process: a ready card the last
    /// placement did not name visible ([B06]), not in the host's hand, not
    /// already going. A warning takes only a hidden page — one WebKit
    /// throttles — never a sibling, which paints behind its pane's active
    /// card. A pressure step passes over a body it was refused while it has
    /// another to ask; the clock, outside any episode, asks it regardless.
    /// A closed card's body is never asked.
    private func evictable(_ body: Body, siblings: Bool, episode: Bool = true) -> Bool {
        guard body.cardId != nil, body.state == .ready, !body.visible, !body.evicting, !body.gone,
              !(episode && declined.contains(ObjectIdentifier(body))) else { return false }
        if gesture?.holds(body) == true || body === pressedOutOfBeats { return false }
        return siblings || body.shown?.value == false
    }

    /// The reader's `evictAfterMs`, from the shell: every hidden body's clock
    /// is set again against when it was hidden.
    func setEvictAfter(ms: Double) {
        guard ms > 0, ms != evictAfterMs else { return }
        evictAfterMs = ms
        TugLog.info("bodies", "evict after", [TugLog.field("ms", String(format: "%.0f", ms))])
        for body in bodies { armEviction(body) }
    }

    /// Set the time trigger's eviction for `body`: due `evictAfterMs` after
    /// it was hidden, while it stays hidden, and nothing while it is shown.
    /// Only a hidden page — a sibling paints, and keeps its process until
    /// pressure says otherwise. When it falls due the body is asked as
    /// pressure asks, so one the placement named visible is never taken
    /// ([B06]); one that cannot be asked yet — in the host's hand, or
    /// mid-eviction — is asked again a whole delay on.
    private func armEviction(_ body: Body) {
        body.evictDue?.cancel()
        body.evictDue = nil
        guard let ms = evictAfterMs, body.cardId != nil, let shown = body.shown, !shown.value else { return }
        scheduleEviction(body, inMs: max(0, ms - (Date().timeIntervalSince1970 * 1000 - shown.since)))
    }

    /// The time trigger's eviction for a hidden `body`, `delay` ms from now.
    private func scheduleEviction(_ body: Body, inMs delay: Double) {
        body.evictDue?.cancel()
        body.evictDue = nil
        guard let ms = evictAfterMs, !body.gone, body.cardId != nil, body.shown?.value == false else { return }
        let work = DispatchWorkItem { [weak self, weak body] in
            guard let self, let body else { return }
            body.evictDue = nil
            guard self.evictable(body, siblings: false, episode: false) else {
                // An eviction already going settles its own re-arm.
                if !body.evicting { self.scheduleEviction(body, inMs: ms) }
                return
            }
            self.evict(body, cause: "hidden")
        }
        body.evictDue = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(delay.rounded())), execute: work)
    }

    /// One step of a warning: the body hidden longest gives up its process,
    /// and a beat after that eviction has finished, the next, while the
    /// warning stands. A body that declined is asked again at a later step
    /// once every other hidden body has been asked.
    private func evictOldestHidden() {
        guard pressure.level == .warning else { return }
        let byAge = { (a: Body, b: Body) in (a.shown?.since ?? 0) < (b.shown?.since ?? 0) }
        var oldest = bodies.filter { evictable($0, siblings: false) }.min(by: byAge)
        if oldest == nil, !declined.isEmpty {
            declined = []
            oldest = bodies.filter { evictable($0, siblings: false) }.min(by: byAge)
        }
        guard let oldest else { return }
        evict(oldest, cause: "pressure-warning") { [weak self] in
            guard let self, self.pressure.level == .warning else { return }
            let work = DispatchWorkItem { [weak self] in
                self?.pendingWarningStep = nil
                self?.evictOldestHidden()
            }
            self.pendingWarningStep = work
            DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.warningStepDelay, execute: work)
        }
    }

    /// Give a hidden body's process up: its page writes its card's state, as
    /// `destroy(save: true)` has it, the host keeps its last frame for the
    /// cover the card comes back under — except under critical pressure, or
    /// when the snapshot fails or misses its deadline — and the view goes. The shell is told
    /// `evicted` and keeps the card, which comes back as an arrival when a
    /// placement next wants it shown. A body the placement named visible
    /// while it was saving is kept, and so is one whose page did not answer
    /// the save within `saveDeadline`: an eviction loses nothing unwritten,
    /// and a kept body's clock is set again. A card closed while it goes
    /// is left to its close. `done` runs once, when the eviction has
    /// finished whichever way it went — the body removed, kept or closed —
    /// so a warning's next step is timed from there.
    private func evict(_ body: Body, cause: String, then done: (() -> Void)? = nil) {
        guard let cardId = body.cardId else { return }
        body.evicting = true
        TugLog.info("bodies", "evicting", [TugLog.field("card", cardId), TugLog.field("cause", cause)])
        var settled = false
        let settle = { [weak self, weak body] (saved: Bool) in
            guard !settled else { return }
            settled = true
            guard let self, let body, !body.gone else {
                self?.abandon(cardId: cardId)
                done?()
                return
            }
            guard saved, !body.visible else {
                self.decline(body, cardId: cardId, why: saved ? "shown" : "unsaved")
                done?()
                return
            }
            // The last frame, for the cover — none under critical pressure,
            // which would make every sleeping page paint when memory is
            // shortest; the card comes back under the shell's stand-in.
            let finish = { [weak self, weak body] (cover: BodyCover?) in
                defer { done?() }
                guard let self, let body, !body.gone else {
                    self?.abandon(cardId: cardId)
                    return
                }
                body.evicting = false
                guard !body.visible else {
                    self.decline(body, cardId: cardId, why: "shown")
                    return
                }
                if let cover { self.keep(cover, for: cardId) }
                self.remove(body)
                TugLog.info("bodies", "evicted", [
                    TugLog.field("card", cardId),
                    TugLog.field("cause", cause),
                    TugLog.field("cover", cover.map { "\($0.bytes)" } ?? "none"),
                ])
                self.notifyShell(BodyStateReport(cardId: cardId, state: .evicted, cause: cause))
            }
            if self.pressure.level == .critical {
                finish(nil)
            } else {
                self.takeCover(of: body, cardId: cardId, then: finish)
            }
        }
        window.hostChannel.call(.saveState, in: body.webView) { result in
            if case .success = result { settle(true) } else { settle(false) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.saveDeadline) { settle(false) }
    }

    /// The body's last frame as a cover, at one point a pixel: `done` gets
    /// it, or nil when the snapshot failed or did not answer within
    /// `saveDeadline` — an eviction goes on without a cover rather than
    /// standing `evicting` for ever. `done` runs once. A page WebKit is not
    /// painting still answers a snapshot, which it paints for the asking.
    private func takeCover(of body: Body, cardId: String, then done: @escaping (BodyCover?) -> Void) {
        let size = body.container.bounds.size
        let surface = body.surface
        let insets = body.insets
        var stalled = false
        #if DEBUG
        if snapshotsToStall > 0 {
            snapshotsToStall -= 1
            stalled = true
            NSLog("BodyViewController: TUG_BODY_STALL_SNAPSHOTS — leaving an eviction's snapshot unanswered")
        }
        #endif
        snapshotFrame(
            of: body, cardId: cardId, size: size, scale: 1, deadline: BodyViewController.saveDeadline,
            purpose: "an evicted card's cover", stalled: stalled
        ) { frame in
            done(frame.map {
                BodyCover(image: $0, size: size, surface: surface, insets: insets, takenAt: Date().timeIntervalSince1970 * 1000)
            })
        }
    }

    /// The body's frame as it stands, drawn at `size` points and `scale`
    /// pixels a point: `done` gets it, or nil when the snapshot failed or did
    /// not answer within `deadline`, and runs once. `purpose` names it in the
    /// log. A page WebKit is not painting still answers a snapshot, which it
    /// paints for the asking; `stalled` leaves it unasked, for the harness.
    private func snapshotFrame(
        of body: Body, cardId: String, size: CGSize, scale: CGFloat, deadline: DispatchTimeInterval,
        purpose: String, stalled: Bool = false, then done: @escaping (CGImage?) -> Void
    ) {
        var answered = false
        let answer = { (frame: CGImage?) in
            guard !answered else { return }
            answered = true
            done(frame)
        }
        if !stalled {
            body.webView.takeSnapshot(with: nil) { image, error in
                guard let frame = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    TugLog.warn("bodies", "no frame for \(purpose)", [
                        TugLog.field("card", cardId),
                        TugLog.field("error", error.map { String(describing: $0) } ?? "none"),
                    ])
                    answer(nil)
                    return
                }
                answer(Self.drawn(frame, size: size, scale: scale))
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + deadline) {
            guard !answered else { return }
            TugLog.warn("bodies", "the snapshot for \(purpose) did not answer; it goes without one", [
                TugLog.field("card", cardId),
            ])
            answer(nil)
        }
    }

    /// `image` drawn down to `size` points at `scale` pixels a point, or as
    /// it is when it is no larger.
    private static func drawn(_ image: CGImage, size: CGSize, scale: CGFloat) -> CGImage {
        let width = Int((size.width * scale).rounded()), height = Int((size.height * scale).rounded())
        guard width > 0, height > 0, image.width > width || image.height > height,
              let space = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
              ) else { return image }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage() ?? image
    }

    /// Hold `cover` for `cardId`'s next body: the oldest covers go first
    /// past the budget, and this one goes once it is older than
    /// `evictAfterMs`, a card that long unasked-for being one the user has
    /// left.
    private func keep(_ cover: BodyCover, for cardId: String) {
        covers[cardId] = cover
        var held = covers.values.reduce(0) { $0 + $1.bytes }
        while held > BodyViewController.coverBudgetBytes,
              let oldest = covers.min(by: { $0.value.takenAt < $1.value.takenAt }) {
            covers.removeValue(forKey: oldest.key)
            held -= oldest.value.bytes
            TugLog.info("bodies", "cover dropped", [TugLog.field("card", oldest.key), TugLog.field("why", "budget")])
        }
        guard let ms = evictAfterMs else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(ms.rounded()))) { [weak self] in
            guard let self, self.covers[cardId]?.takenAt == cover.takenAt else { return }
            self.covers.removeValue(forKey: cardId)
            TugLog.info("bodies", "cover dropped", [TugLog.field("card", cardId), TugLog.field("why", "aged")])
        }
    }

    /// The eviction is over and the body stays: a warning's next step asks
    /// it only once no other hidden body is left, and its clock is set
    /// again from now — sooner for a save that did not answer.
    private func decline(_ body: Body, cardId: String, why: String) {
        body.evicting = false
        declined.insert(ObjectIdentifier(body))
        TugLog.info("bodies", "eviction declined", [
            TugLog.field("card", cardId),
            TugLog.field("why", why),
        ])
        if let ms = evictAfterMs {
            scheduleEviction(body, inMs: why == "unsaved" ? min(ms, BodyViewController.unsavedRetryMs) : ms)
        }
    }

    /// The card went while its eviction was in flight: the close removed it,
    /// and the eviction keeps no cover and tells the shell nothing.
    private func abandon(cardId: String) {
        TugLog.info("bodies", "eviction abandoned", [TugLog.field("card", cardId), TugLog.field("why", "closed")])
    }

    // MARK: - Failure

    private func armDeadline(_ body: Body) {
        body.deadline?.cancel()
        let work = DispatchWorkItem { [weak self, weak body] in
            guard let self, let body, body.state != .ready else { return }
            self.fail(body, cause: "deadline")
        }
        body.deadline = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(BodyViewController.readyDeadlineMs),
            execute: work
        )
    }

    /// Give up on a body: it is destroyed, and the shell decides whether to
    /// ask for the card's body again.
    private func fail(_ body: Body, cause: String) {
        let cardId = body.cardId
        TugLog.error("bodies", "failed", [
            TugLog.field("card", cardId ?? "spare"),
            TugLog.field("cause", cause),
        ])
        body.state = .failed
        remove(body)
        if let cardId {
            notifyShell(BodyStateReport(cardId: cardId, state: .failed, cause: cause))
        }
    }

    /// A body's WebContent process died. It is loaded afresh and re-bound to
    /// restore its card — `load`, not `reload()`, which a terminated view
    /// with a nil `url` ignores — once per window; a second death inside the
    /// window fails it. Returns false for a view that is not a body.
    func webContentProcessDidTerminate(_ webView: WKWebView) -> Bool {
        // The overlay holds nothing a reload loses: its page asks the shell
        // for everything it shows again when it says hello. Loaded afresh, as
        // a body is, since a terminated view's `reload()` may find no URL;
        // and a modal that held the keyboard is gone with the page, so the
        // keyboard goes back to whoever the shell last named.
        if let overlayView, webView === overlayView {
            let heldKeys = overlayClaim == .all && window.firstResponder === overlayView
            overlayClaim = .none
            keysBeforeOverlay = nil
            if heldKeys { focus(cardId: keyboardCardId) }
            if let origin = window.shellOrigin,
               let url = URL(string: origin + "/?overlay=\(Self.overlayCardId)") {
                overlayView.load(URLRequest(url: url))
            }
            return true
        }
        guard let body = body(for: webView) else { return false }
        let now = Date()
        if let previous = body.lastTermination,
           now.timeIntervalSince(previous) < BodyViewController.terminationWindow {
            fail(body, cause: "terminated twice")
            return true
        }
        body.lastTermination = now
        guard let cardId = body.cardId else {
            // A spare holds nothing; drop it, and let the next one be made.
            remove(body)
            scheduleSpare()
            return true
        }
        TugLog.warn("bodies", "WebContent process terminated — reloading", [
            TugLog.field("card", cardId),
        ])
        loadAfresh(body, cardId: cardId)
        return true
    }

    /// A body's page asked to reload itself: the dev server named the bodies'
    /// entry in a scoped reload (`tugdeck/src/lib/scoped-reload.ts`). Its
    /// card's state is written first, as a shell reload writes every body's,
    /// and the page is then loaded afresh under the same card. The spare,
    /// which holds nothing, reloads as itself. Returns false for a view that
    /// is not a card's body, whose reload the caller lets through.
    func reloadForEdit(_ webView: WKWebView) -> Bool {
        guard let body = body(for: webView), let cardId = body.cardId else { return false }
        TugLog.info("bodies", "reloading for an edit", [TugLog.field("card", cardId)])
        guard body.state == .ready else {
            // Not bound yet: nothing of the card's is in the page to write.
            loadAfresh(body, cardId: cardId)
            return true
        }
        var reloaded = false
        let reload = { [weak self, weak body] in
            guard !reloaded, let self, let body, self.bodies.contains(where: { $0 === body }) else { return }
            reloaded = true
            self.loadAfresh(body, cardId: cardId)
        }
        window.hostChannel.call(.saveState, in: webView) { _ in reload() }
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyViewController.saveDeadline) { reload() }
        return true
    }

    /// Load a body's page afresh under the card it holds, and bind it again as
    /// it would be at launch.
    private func loadAfresh(_ body: Body, cardId: String) {
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + "/?body=\(cardId)") else {
            fail(body, cause: "no origin to reload from")
            return
        }
        body.state = .loading
        // Its card restores as it would at launch: a Session card from the
        // ledger, a kind with no session by mounting again. The kind is kept.
        body.intent = JSONObject(["kind": .string(body.intent?["kind"] == .string("mount") ? "mount" : "restore")])
        body.warm = false
        body.askedAt = CACurrentMediaTime()
        body.painted = false
        // The new page paints into a view that was shown: unhidden and
        // transparent until it says `painted`, as a page never shown is —
        // hidden, it would never get the frames `painted` waits on.
        body.shownOnce = false
        applyVisibility(body)
        notifyShell(BodyStateReport(cardId: cardId, state: .terminated))
        armDeadline(body)
        body.webView.load(URLRequest(url: url))
    }

    // MARK: - Harness

    /// Every body as the harness reports it, the spare included.
    func snapshot() -> [JSONValue] {
        bodies.map { body -> JSONValue in
            let opacity = body.container.layer?.presentation()?.opacity ?? body.container.layer?.opacity ?? 0
            var entry: [String: JSONValue] = [:]
            entry["cardId"] = body.cardId.map(JSONValue.string) ?? .null
            entry["componentId"] = body.componentId.map(JSONValue.string) ?? .null
            entry["state"] = .string(body.state.rawValue)
            entry["frame"] = Self.json(body.frame)
            entry["visible"] = .bool(body.visible && body.canShow)
            entry["shown"] = .bool(body.seen)
            entry["painted"] = .bool(body.painted)
            entry["covered"] = .bool(body.cover != nil)
            entry["wasCovered"] = .bool(body.wasCovered)
            entry["z"] = .number(Double(body.z))
            entry["firstResponder"] = .bool(window.firstResponder === body.webView)
            entry["start"] = .string(body.warm ? "warm" : "cold")
            entry["readyMs"] = body.readyMs.map(JSONValue.number) ?? .null
            entry["opacity"] = .number(Double(opacity))
            entry["presentedFrame"] = Self.json(presentedRect(body))
            entry["beatsPlanId"] = body.beats.map { .number(Double($0.planId)) } ?? .null
            entry["crossing"] = body.lastCrossing?.json ?? .null
            entry["pageSize"] = .object([
                "width": .number(body.webView.frame.width), "height": .number(body.webView.frame.height),
            ])
            entry["displayPeriodMs"] = .number(displayPeriodSec * 1000)
            entry["url"] = body.webView.url.map { .string($0.absoluteString) } ?? .null
            // Its rail membership as the last placement named it, and the
            // frame of the rail view its container stands in (null outside one),
            // and that rail's width drag ghost while one stands.
            if let rail = body.cardId.flatMap({ cardPlacements[$0]?.rail }) {
                let railView = body.container.superview as? RailView
                let ghost = railView.flatMap { $0.ghost.superview == nil ? nil : $0.ghost }
                entry["rail"] = .object([
                    "side": .string(rail.side.rawValue),
                    "index": .number(Double(rail.index)),
                    "railFrame": railView.map { Self.json($0.frame) } ?? .null,
                    "ghost": ghost.map { .object(["frame": Self.json($0.frame), "pastLimit": .bool($0.pastLimit)]) } ?? .null,
                ])
            } else {
                entry["rail"] = .null
            }
            entry["inHand"] = .bool(gesture?.holds(body) ?? false)
            return .object(entry)
        }
    }

    /// A rect as the harness reads one: `{x, y, width, height}`.
    private static func json(_ rect: CGRect) -> JSONValue {
        .object([
            "x": .number(rect.minX), "y": .number(rect.minY),
            "width": .number(rect.width), "height": .number(rect.height),
        ])
    }

    /// The container where the user sees it: its live frame, which a card in
    /// the host's hand holds away from its last placement, or its
    /// presentation layer's read through the mapping a plan solved.
    private func presentedRect(_ body: Body) -> CGRect {
        // The container as it stands, which a card in the host's hand holds
        // away from its last placement; the presentation layer's, mapped,
        // once a plan has solved the mapping.
        var rect = body.container.frame
        if let mapping = body.mapping, let presented = body.container.layer?.presentation() {
            rect = mapping.frame(position: presented.position, bounds: presented.bounds)
        }
        return rect
    }

    // MARK: - Calls into pages

    private func notifyShell(_ report: BodyStateReport) {
        window.sendToShell(.bodyState(report))
    }

    private func send(_ message: ToPage, to body: Body) {
        window.hostChannel.send(message, to: body.webView)
    }
}

/// A body's last crossing, as the harness reads it: its plan and size, how
/// far ahead of the first moving beat the body was ready, whether it said
/// `crossingSolved` before its plan started and how long after the plan's
/// receipt, how long a whole card's cover took to snapshot and its size in
/// pixels, the surface it wore, and whether the page follows its container
/// again.
struct CrossingAccount: Equatable {
    var planId: Int
    var size: CGSize
    var readyLeadMs: Double?
    var solved = false
    var solveMs: Double?
    var snapshotMs: Double?
    var coverPixels: CGSize?
    var surface: [Double]?
    var restored = false

    init(planId: Int, size: CGSize) {
        self.planId = planId
        self.size = size
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "planId": .number(Double(planId)),
            "width": .number(size.width),
            "height": .number(size.height),
            "readyLeadMs": readyLeadMs.map(JSONValue.number) ?? .null,
            "solved": .bool(solved),
            "solveMs": solveMs.map(JSONValue.number) ?? .null,
            "snapshotMs": snapshotMs.map(JSONValue.number) ?? .null,
            "coverPixels": coverPixels.map { .object(["width": .number($0.width), "height": .number($0.height)]) } ?? .null,
        ]
        if let surface { fields["surface"] = .array(surface.map(JSONValue.number)) }
        if restored { fields["restored"] = .bool(true) }
        return .object(fields)
    }
}
