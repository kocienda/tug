import AppKit
import QuartzCore
import WebKit

/// The request a body or overlay page is loaded with: revalidate, never
/// trust a cached copy. The page's URL is the same across launches
/// (`/?body=<cardId>`), and the page names a script by a hash that changes
/// with every build, so a copy WebKit kept from the previous build names a
/// script the dist no longer has, the body fails its deadline, and the deck
/// sits for a minute per launch. tugcast marks the page `no-cache` too, but
/// a copy cached before that header existed carries no such instruction;
/// the policy on the request holds whatever the cache remembers.
func bodyPageRequest(_ url: URL) -> URLRequest {
    URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData)
}

/// The view every stage lives in: flipped, so a container's frame is the
/// top-left viewport rect the shell measured, filling the window's container
/// over the shell's web view and beneath the overlay's. It holds one stage per
/// workspace — the workspace's ground and its cards' containers, each card
/// showing its live page, its last frame or a skeleton — of which the host
/// shows exactly one, and the window's rail cards beside them, outside every
/// stage ([D230], [D231]). A switch is the host's cut: one transaction that
/// hides one stage and shows another (`BodyStages.swift`).
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
    convenience init(cover: BodyCover, frame: NSRect) {
        self.init(contents: cover.image, size: cover.size, surface: cover.surface, insets: cover.insets, frame: frame)
    }
    private init(contents: Any?, size: CGSize, surface: CGColor?, insets: CardInsets?, frame: NSRect) {
        frameSize = size
        paneInsets = insets
        super.init(frame: frame)
        wantsLayer = true
        plate.backgroundColor = surface
        plate.cornerRadius = BodyCoverView.paneRadius
        frameLayer.contents = contents
        frameLayer.contentsGravity = .resize
        layer?.addSublayer(plate)
        layer?.addSublayer(frameLayer)
        needsLayout = true
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    /// A second view of the same frame, at the same place: for a crossing
    /// that rides one part of the picture apart from the rest
    /// (`BodyBeatsRunner.rideSplit`).
    func twin() -> BodyCoverView {
        BodyCoverView(contents: frameLayer.contents, size: frameSize, surface: plate.backgroundColor, insets: paneInsets, frame: frame)
    }
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
/// A body's life is a `BodyState` (`loading → connected → bound → ready`,
/// `evicting` on the way to giving up its process, `gone` once its card
/// closes, the paint and the first showing facts of the phase), moved only
/// through `BodyLifecycle.move`. It `fail`s from any live phase: at its
/// ready deadline while it is not yet ready, and on a second WebContent
/// termination within ten seconds, ready or not. The shell hears of every
/// transition that matters to it
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
    /// One body. A spare has no card until it is bound to one.
    final class Body {
        var cardId: String?
        let webView: ClickThroughWebView
        let container: BodyContainerView
        /// Its lifecycle: the phase its page is in and the facts that ride
        /// with it, moved only through `BodyLifecycle.move`.
        var life = BodyState()
        var state: BodyState.Phase { life.phase }
        /// The body's serial, which no later body takes.
        var serial: Int { container.serial }
        /// What the body is to do once bound: the deck's `BodyIntent`.
        var intent: JSONObject?
        /// The kind of card it holds once bound: the deck's `componentId`.
        var componentId: String?
        /// The kind may veto its close, which only its page can answer: the
        /// clock and a warning pass it over, and critical pressure alone
        /// takes it.
        var guardsClose = false
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
        var painted: Bool { life.painted }
        /// Whether the body may be shown: it has painted, and its card is
        /// bound or ready. A card that draws its own chrome paints its first
        /// chrome frame before it is ready, and shows from there, its content
        /// lidded in its own page.
        ///
        /// A body brought back from an eviction may be shown from its
        /// hand-off: its cover stands until it has painted.
        var canShow: Bool {
            if covered { return state != .failed }
            return painted && (state == .ready || state == .bound)
        }
        /// Brought back from an eviction and not yet painted: its cover
        /// stands for that.
        var covered: Bool { stand?.kinds.contains(.eviction) == true }
        /// The one cover over the web view, for whichever reasons `stand`
        /// names: the card's last frame before its eviction, until the page
        /// paints, and a whole card's frame through a crossing, until it
        /// lands. Nil while neither holds.
        var cover: BodyCoverView?
        /// Why `cover` stands: the covers' own record of it, shared.
        var stand: BodyCovers.Stand?
        /// The cover while a crossing holds it: a whole card's frame over its
        /// page, which lays itself out at the landing size beneath it.
        var crossingCover: BodyCoverView? { stand?.kinds.contains(.crossing) == true ? cover : nil }
        /// The body was made under a cover, for the harness: `covered` goes at the paint.
        var wasCovered = false
        /// The theme the page last said it wears (`bodySurface`, `bodyThemed`).
        var theme: String?
        /// The page has said its content painted, not only its chrome: what a
        /// switch's faced set waits on. Cleared when the page is bound afresh.
        var contentPainted = false
        /// The page has said `bodyStale` since it was hidden: a value it draws
        /// moved while it was, so its picture is not what it would draw.
        /// Cleared at its next paint as shown.
        var stale = false
        /// The page was declared dormant since it was last shown: asleep, it
        /// heard nothing, so its picture may be behind. Cleared when shown.
        var sleptSinceShown = false
        /// Whether the page's picture stands for what it would draw now: not
        /// stale, and not slept since it was shown.
        var current: Bool { !stale && !sleptSinceShown }
        /// Shown while it was not current, and not painted as shown since:
        /// what its layer holds is behind until its next content paint.
        var owedPaint = false
        /// Its content has painted only hidden — a page made ahead for a
        /// parked or pending workspace — and not yet as shown: what it drew
        /// was drawn for a workspace nobody was looking at, and settles once
        /// it is shown, so it is not current until it says it has painted
        /// as shown, which it does at its first show.
        var paintedOnlyHidden = false
        /// When the page last said `bodyStale`, wall-clock ms: a last frame
        /// taken after it stands for what the page draws now.
        var staleAt: Double?
        /// The picture standing over its painted page outlived its horizon
        /// ([P11]): the page is shown as it stands. Cleared when it is hidden.
        var pastHorizon = false
        /// The card's picture while it is not `live`: its skeleton or last
        /// frame, over its page in its container. Nil while live.
        var picture: StageCardPicture?
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
        /// Whether the user can see the body — placed visible and showable,
        /// or a sibling at opacity 0 behind its pane's active card — and
        /// since when, wall-clock ms. A body not yet shown once is hidden by
        /// opacity rather than `isHidden`, so painting is not the reading.
        var shown: (value: Bool, since: Double)?
        /// What `shown` reads now: placed visible and showable, or a sibling.
        /// A page that reloaded itself while on show reads as seen until its
        /// new paint shows it, so it is told `shown` once, at its bind.
        var seen: Bool { visible && (canShow || life.rebound) || sibling }
        /// The `shown` its page was last told; nil until the page is bound,
        /// and again when a reload binds a new one.
        var toldShown: Bool?
        /// The `dormant` its page was last told, beside `toldShown` and reset
        /// with it. Kept so a declaration made while the page could not hear
        /// reaches it once it can, rather than waiting for a rebind.
        var toldDormant: Bool?
        /// The time trigger's eviction, armed while the body is hidden and
        /// due `evictAfterMs` after it was hidden.
        var evictDue: DispatchWorkItem?
        /// The dormant clock, armed while the body is hidden and due
        /// `dormantAfterMs` after it was hidden (`BodyLifecycle.armDormancy`).
        var dormantDue: DispatchWorkItem?
        /// Whether the host has declared this body dormant, to tugcast and to
        /// its page: hidden past the dormant delay, and not shown since.
        var declaredDormant = false
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
        /// The folded form's bottom band a covered fold carries from its
        /// open place to the closing edge, as its page named it when solved;
        /// nil for every other crossing, and after the land.
        var crossingBand: BodyBeats.CrossingBand?
        /// Where a covered whole card's picture splits for a change of
        /// height that is not a fold, and the cover's tail — a second cover
        /// cut above the split, riding the bottom edge — standing over the
        /// first; nil for every other crossing, and after the land.
        var crossingSplit: BodyBeats.CoverSplit?
        /// Where a whole card whose width grows cuts its end face's right
        /// strip, which rides the right edge as `crossingTail` once the
        /// solved page's snapshot stands; nil for every other crossing, and
        /// after the land.
        var crossingEdge: BodyBeats.EdgeStrip?
        var crossingTail: BodyCoverView?
        /// The ground a centered split's page rides on: the scroller's own
        /// background, where a page smaller than its box does not reach;
        /// nil for every other crossing, and after the land.
        var crossingGround: NSView?
        /// The last crossing's account, for the harness: its plan, its size,
        /// and how far ahead of the first beat the body was ready.
        var lastCrossing: CrossingAccount?
        /// How the container's frame maps to its layer's geometry, solved at
        /// the body's last plan; nil before one.
        var mapping: LayerMapping?

        init(cardId: String?, webView: ClickThroughWebView, container: BodyContainerView) {
            self.cardId = cardId
            self.webView = webView
            self.container = container
        }
    }

    /// How long a body has to report ready after it is asked for.
    static let readyDeadlineMs = 10_000
    /// The deadline a body made now is held to: `readyDeadlineMs`, unless
    /// the harness has shortened it (`setDelays`).
    private var readyDeadline = BodyViewController.readyDeadlineMs
    /// A second WebContent termination inside this window fails the body.
    static let terminationWindow: TimeInterval = 10

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
    /// A tell to tugcast over the app's control socket, set by the app
    /// delegate: how the host declares a body dormant, or withdraws it.
    var tellTugcast: ((String, ControlParams) -> Void)?
    /// A control for the shell, over the same socket, set by the app
    /// delegate: how a host cut tells the shell to follow ([P06]).
    var tellShell: ((String, ControlParams) -> Void)?
    /// Each card the last placement named, with its index in the deck's
    /// reading order: the lane's order after whether a card is shown, and
    /// where a page made from the lane after that placement stands.
    private(set) var placedEntries: [String: (entry: CardPlacementEntry, deckIndex: Int)] = [:]
    /// Creation order, for a stable stacking among bodies at one z.
    private var serials = 0

    /// The next view's creation serial: a body's container's, or a face's.
    func nextSerial() -> Int {
        serials += 1
        return serials
    }
    typealias PressureLevel = MemoryPressureLevel
    /// Every move of a body's state, and eviction, pressure, covers and
    /// declines: what decides whether a body's page lives.
    private(set) var lifecycle: BodyLifecycle!
    /// The cards waiting for a page, and the spare.
    private(set) var lane: BodyLane!
    /// Every workspace's stage, and which one is shown.
    private(set) var stages: StageSet!
    /// A workspace the shell switched onto before any placement named it —
    /// one just made — cut onto when a placement first does.
    private var pendingShellCut: String?

    /// A cut onto a workspace of another theme, held while the shared rail
    /// re-skins ahead of it. The rail is the window's and follows the shown
    /// workspace's theme, and a rail page is another process: it cannot
    /// repaint inside the cut's transaction. So its live pages are told the
    /// arriving theme at the gesture, nothing on screen changes, and the cut
    /// is made when every one has answered, or at the horizon. No skeleton
    /// ever stands over a live rail card for a cut.
    private struct HeldCut {
        let spaceId: String
        let door: CutDoor
        let theme: String
        /// The rail cards told and not yet answered.
        var waiting: Set<String>
        let gestureWall: Double
        let horizon: DispatchWorkItem
    }
    private var heldCut: HeldCut?
    /// The theme each live rail page was last told and when, until it
    /// answers: its answer logs the `rail re-skin` line.
    private var railTold: [String: (theme: String, at: CFTimeInterval)] = [:]
    /// How long a cut waits on the rail, ms. A rail page answers one paint
    /// after applying the theme; the slowest measured, on a rail whose
    /// Overview held 150 posts, is well inside it.
    static let railReskinHorizonMs = 80
    /// Cards whose page failed and that have not been asked for since: the
    /// shell's placard is their face, so no picture stands over them.
    private var failedCards: Set<String> = []
    /// The host's hand: a card carried, a rail's edge dragged.
    private(set) var carrier: CardGestureCarrier!
    /// The beats a settle carries each card through.
    private(set) var beats: BodyBeatsRunner!

    init(window: MainWindow, hostView: BodyHostView) {
        self.window = window
        self.hostView = hostView
        hostView.containerAt = { [weak self] point in
            self?.body(atViewportPoint: CGPoint(x: point.x, y: point.y))?.container
        }
        lifecycle = BodyLifecycle(controller: self, window: window)
        lane = BodyLane(controller: self)
        carrier = CardGestureCarrier(controller: self, window: window)
        beats = BodyBeatsRunner(controller: self, window: window)
        stages = StageSet(hostView: hostView, grounds: window.stageGrounds, palettes: window.palettes) { [unowned self] in
            self.nextSerial()
        }
    }

    // MARK: - Lookup

    func body(for webView: WKWebView?) -> Body? {
        guard let webView else { return nil }
        return bodies.first { $0.webView === webView }
    }

    /// The card's body. A closed card's body still saving is not it: a card
    /// asked for again gets a body of its own.
    func body(forCard cardId: String) -> Body? {
        bodies.first { $0.cardId == cardId && $0.state != .gone }
    }

    var spare: Body? {
        bodies.first { $0.cardId == nil && $0.state != .failed && $0.state != .gone }
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
        view.load(bodyPageRequest(url))
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
    func create(cardId: String, componentId: String, intent: JSONObject, guardsClose: Bool = false) {
        failedCards.remove(cardId)
        if let existing = body(forCard: cardId), existing.state != .failed {
            if existing.life.keptAcrossShellReload {
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
            spare.guardsClose = guardsClose
            spare.warm = true
            spare.askedAt = CACurrentMediaTime()
            // The card's hidden clock starts now, not when the spare was
            // made: every placement since then named the spare hidden, and a
            // `since` carried over would let a spare older than the eviction
            // delay be evicted the moment its card is ready — before its
            // first paint can place it visible — taking a Run in New
            // Session's opening command with the page.
            spare.shown = nil
            lifecycle.standCover(over: spare)
            armDeadline(spare)
            if spare.state == .connected { bind(spare) }
            // The shell placed the card while it had no page: the page stands
            // there now, under the card's picture, as a lane-made one does.
            if let (placed, deckIndex) = placedEntries[cardId] {
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                place(spare, placed, deckIndex: deckIndex)
                reconcileRails()
                CATransaction.commit()
                refreshRegion()
            }
            return
        }
        lane.ask(cardId: cardId, componentId: componentId, intent: intent, guardsClose: guardsClose)
    }

    /// A body kept across a shell reload, asked for by the reloaded shell:
    /// it is told what the shell before it was, a ready page and its paint,
    /// since the body will not say either again. Its stores and facts reach
    /// the shell on the bus's hello, and its focus follows the `ready`.
    private func reportKept(_ body: Body, cardId: String) {
        lifecycle.move(body, .reportKept)
        TugLog.info("bodies", "kept across the shell's reload", [
            TugLog.field("card", cardId),
            TugLog.field("state", body.state.rawValue),
            TugLog.field("painted", body.painted ? "yes" : "no"),
        ])
        // An evicting page is still ready: its eviction says the rest.
        guard body.life.isLive else { return }
        notifyShell(BodyStateReport(cardId: cardId, state: .ready, readyMs: body.readyMs ?? 0, start: body.warm ? .warm : .cold))
        if body.painted { notifyShell(BodyStateReport(cardId: cardId, state: .painted)) }
    }

    /// Make the spare a beat from now (`BodyLane`).
    func scheduleSpare() {
        lane.scheduleSpare()
    }

    func make(cardId: String?, path: String) -> Body? {
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

        let container = BodyContainerView(serial: nextSerial())
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
        webView.load(bodyPageRequest(url))
        return body
    }

    /// A body's page is connected and ready to be told what it is for.
    func didSayHello(_ body: Body) {
        if body.state == .loading { lifecycle.move(body, .hello) }
        if body.cardId != nil, body.intent != nil { bind(body) }
    }

    private func bind(_ body: Body) {
        guard let cardId = body.cardId, let componentId = body.componentId,
              let intent = body.intent, lifecycle.move(body, .bind) else { return }
        body.boundAt = CACurrentMediaTime()
        body.contentPainted = false
        send(.bodyBind(BodyBind(
            cardId: cardId, componentId: componentId, intent: intent, facts: window.bodyFacts(),
            contentPaintDelayMs: contentPaintDelays[cardId]
        )), to: body)
        // A page bound afresh has not heard whether it is shown.
        body.toldShown = nil
        body.toldDormant = nil
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
        guard let cardId = body.cardId, body.state == .bound else { return }
        body.deadline?.cancel()
        body.deadline = nil
        lifecycle.move(body, .ready)
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
        lifecycle.armEviction(body)
        // And whatever the host declared while its page could not hear is
        // said now, so tugcast's half and the page's half stand together.
        tellVisibility(body)
        // Its page has left the lane; the next waiting card's may start.
        lane.drain()
        // The spare this body may have taken is replaced once it has painted.
        scheduleSpare()
    }

    /// A hidden body's page said `bodyStale`: what it would draw moved while
    /// it was hidden, so a switch onto it cannot show it as it stands. Its
    /// last frame is behind too, and goes: the card stands as a skeleton
    /// until its page paints as shown. No snapshot is taken for it — a page
    /// is pictured only when it parks ([B07]).
    func noteStale(_ body: Body) {
        guard let cardId = body.cardId else { return }
        // A page the host has shown — a cut onto its workspace, made before
        // the shell moved the deck's keyboard to it — paints as shown in a
        // moment: what it said stale is drawn there, and it keeps its picture.
        if body.visible, body.canShow {
            TugLog.info("bodies", "stale while shown, kept", [TugLog.field("card", cardId)])
            return
        }
        if !body.stale {
            body.stale = true
            TugLog.info("bodies", "stale", [TugLog.field("card", cardId)])
        }
        body.staleAt = Date().timeIntervalSince1970 * 1000
        lifecycle.covers.dropParked(cardId)
        refreshPicture(body)
        // A page made ahead and never shown has not parked yet: its first
        // picture is still settling (its own title coming back to it), so it
        // is owed its last frame once more. A page says it is stale once in a
        // hidden period, so this is one frame more, never a retake per move.
        if !body.life.shownOnce { lifecycle.queueParkCover(body) }
    }

    /// A body posted `painted`: a frame of its chrome, or of its content
    /// (`content`), has gone to the compositor. From here a placement that
    /// names it visible shows it.
    func didPaint(_ body: Body, content: Bool) {
        guard let cardId = body.cardId else { return }
        if content {
            if !body.contentPainted, !body.seen, !body.life.shownOnce { body.paintedOnlyHidden = true }
            body.contentPainted = true
        }
        // Its paint as shown draws what it would draw now: the last frame
        // kept for it is behind, and goes, and the picture over it with it.
        if content, body.seen {
            body.stale = false
            body.owedPaint = false
            body.paintedOnlyHidden = false
            lifecycle.paintTakesDownParkCover(body)
        }
        // Every paint lands alone: a card whose picture still stands keeps
        // it, and its page beneath it, until its own content paints ([B05]).
        landPaint(body)
        if content { lifecycle.paintTakesDownCover(body) }
        // A page made ahead goes to sleep once its content is up: this is its
        // park, so its last frame is taken now.
        if content, madeAhead(body) {
            applyVisibility(body)
            lifecycle.queueParkCover(body)
        }
        refreshPicture(body)
    }

    /// A page made ahead of its workspace's first visit: never shown, its
    /// content painted, and its card a workspace's whose stage is not the one
    /// on screen — not one waiting on its paint to be shown, and not a
    /// sibling standing for its pane. A card the shell places nowhere is in
    /// no stage, so it is one made ahead too; a rail card is the window's and
    /// always shown, and an arriving card is the active stage's by the cut.
    private func madeAhead(_ body: Body) -> Bool {
        guard !body.life.shownOnce, body.contentPainted, !body.visible, !body.sibling,
              let cardId = body.cardId else { return false }
        guard let (entry, _) = placedEntries[cardId] else { return true }
        guard let spaceId = entry.spaceId else { return false }
        return spaceId != (stages.activeId ?? placedActiveSpaceId)
    }

    /// A paint landing: the body is its own page from here, the shell hears
    /// it painted, and a placement that names it visible shows it.
    private func landPaint(_ body: Body) {
        guard let cardId = body.cardId, lifecycle.move(body, .paint, quietly: true) else { return }
        // A body brought back from an eviction is its own page once its
        // content has painted, its cover off unless a crossing still holds
        // it: its chrome alone is not the card.
        if body.contentPainted { lifecycle.paintTakesDownCover(body) }
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

    /// Show a body placed visible, at once and in full, when it is painted or
    /// a picture stands for it over its page; hide anything else. Nothing
    /// here animates.
    func applyVisibility(_ body: Body) {
        let showing = body.visible && (body.canShow || body.picture != nil)
        guard let layer = body.container.layer else { return }
        defer { reportVisibility(body) }
        if showing {
            let wasHidden = body.container.isHidden
            body.container.isHidden = false
            body.container.passesPointer = false
            // A page beneath its picture that has not painted is not shown
            // yet: hidden again before it paints, it stays a page that runs
            // its frames, never a hidden one.
            if body.canShow { lifecycle.move(body, .show, quietly: true) }
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
        } else if body.life.shownOnce {
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
        } else if madeAhead(body) {
            // Made ahead for a parked workspace: its content has painted and
            // no placement wants it shown, so it sleeps as a parked page
            // does — hidden, so WebKit throttles it, and dormant now rather
            // than at the hidden clock, since nobody has ever seen it.
            body.container.isHidden = true
            declareDormant(body, true)
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
            lifecycle.armEviction(body)
            lifecycle.armDormancy(body)
            // Shown again: tugcast hears first, so the body's catch-up is
            // answered on a wire that sends it its session again. A page
            // shown while it was not current owes a paint before its own
            // layer is its picture.
            if shown {
                if !body.current, body.contentPainted { body.owedPaint = true }
                declareDormant(body, false)
                body.sleptSinceShown = false
            } else {
                body.pastHorizon = false
            }
        }
        tellVisibility(body)
    }

    /// Tell a body's page whether it is shown and whether it is dormant, when
    /// either differs from what it was last told and the page can hear. Every
    /// change to either goes through here, so the page's half of a dormant
    /// declaration is said whenever it can be, never only at the moment of it.
    private func tellVisibility(_ body: Body) {
        guard let told = visibilityToTell(
            shown: body.shown,
            canHear: body.state == .bound || body.life.isLive,
            declaredDormant: body.declaredDormant,
            toldShown: body.toldShown,
            toldDormant: body.toldDormant
        ) else { return }
        body.toldShown = told.shown
        body.toldDormant = told.dormant
        send(.bodyVisibility(told), to: body)
    }

    /// Declare `body` dormant, or withdraw the declaration ([B05]): tugcast
    /// first, which then sends the body nothing of any session and never cuts
    /// its quiet socket, then the page, which sleeps on the host's word even
    /// when WebKit has stopped its own clock. A no-op when nothing changes.
    ///
    /// The two halves cannot part: a page that cannot hear yet is told by
    /// `tellVisibility` the moment it can — at its bind, or at `ready` — from
    /// the same `declaredDormant` tugcast was told.
    func declareDormant(_ body: Body, _ dormant: Bool) {
        guard body.declaredDormant != dormant, let cardId = body.cardId else { return }
        body.declaredDormant = dormant
        if dormant { body.sleptSinceShown = true }
        TugLog.info("bodies", "dormant", [TugLog.field("card", cardId), TugLog.field("dormant", dormant ? "yes" : "no")])
        tellTugcast?("body_dormant", ["card_id": cardId, "dormant": dormant])
        tellVisibility(body)
        // Asleep, its page may fall behind: its picture is chosen again now,
        // in its hidden stage, so the stage is right the moment it is shown.
        if dormant { refreshPicture(body) }
    }

    /// Say every standing declaration again, for a tugcast that has just
    /// started and holds none.
    func redeclareDormancy() {
        for body in bodies where body.declaredDormant {
            guard let cardId = body.cardId else { continue }
            tellTugcast?("body_dormant", ["card_id": cardId, "dormant": true])
        }
    }

    func refreshRegion() {
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
            body.whole && (body.beats != nil || body === self.carrier.pressedOutOfBeats)
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
        /// The card's workspace; nil for a rail member.
        var spaceId: String?
        /// Whether the card would show were its workspace the shown one.
        var staged: Bool
        var title: String
        var kind: String
        var folded: Bool
    }

    /// The cards the last `placeCards` named, by card id. Read by the
    /// gesture tracker for its envelope; nothing is shown from it yet.
    private(set) var cardPlacements: [String: CardPlacement] = [:]
    /// The canvas the cards stand on, viewport points, and the zoom its
    /// layout is drawn at; nil before the shell has said.
    private(set) var cardCanvas: CGRect?
    private(set) var cardZoom: CGFloat = 1
    /// Every workspace the last `placeCards` named, in the list's order, and
    /// the one the shell showed then.
    private(set) var placedSpaces: [StageSpace] = []
    private(set) var placedActiveSpaceId: String?
    /// The deck's card gap the last `placeCards` named, layout px.
    private(set) var cardGap: CGFloat = 0
    private(set) var cardApron: CGFloat = CardGeometry.apron
    /// Each standing rail's width bounds, layout px, as the last `placeCards` named them.
    private(set) var railLimits = RailLimitsBySide()
    /// One view per shown rail, holding its members' containers.
    private var rails: [RailSide: RailView] = [:]
    /// The cards the last placement says the shell's rail draft holds: the
    /// host's, until the shell's release, though the hand has let go.
    private(set) var placementHeld: Set<String> = []

    /// Whether the body is in the host's hand (`CardGestureCarrier`).
    func isInHand(_ body: Body) -> Bool {
        carrier.isInHand(body)
    }

    /// Whether the host is tracking a card's drag or resize.
    var gestureLive: Bool { carrier.isLive }

    func noteLeftButton(down: Bool, atViewport point: CGPoint? = nil) {
        carrier.noteLeftButton(down: down, atViewport: point)
    }

    // MARK: - The cut

    /// Cut onto `spaceId`'s stage, through `door` ([P06], Spec S04): in one
    /// transaction the departing stage and its ground hide and the
    /// arriving ones show, every body's visibility is derived from the stage
    /// now shown ([P04]), and every picture stands as the policy chose it,
    /// which it did before the cut ([P05]). After the commit the arriving
    /// workspace's focused card takes the keyboard if its page is live, a
    /// cut the host began tells the shell to follow with its serial, and
    /// each departing card that was live is owed its last frame. False when
    /// the stage set did not admit the cut, which then moves nothing.
    @discardableResult
    func cut(to spaceId: String, door: CutDoor) -> Bool {
        let gestureWall = Date().timeIntervalSince1970 * 1000
        guard stages.wouldCut(spaceId, door: door) else {
            // Not a cut: the stage set says why. Unless it is the shell's
            // echo, or a switch of the shell's that a host cut outranks, it
            // is still the newest word on where to be, and a held cut gives
            // way to it.
            var passes = false
            if case .shell(let serial) = door { passes = serial != nil || stages.toldSerial != nil }
            if !passes { dropHeldCut() }
            return makeCut(to: spaceId, door: door, gestureWall: gestureWall)
        }
        // The newest target wins: a cut held for an earlier one is replaced.
        let wasHeld = heldCut != nil
        heldCut?.horizon.cancel()
        heldCut = nil
        let shown = stages.active?.theme
        if let theme = stages.stage(spaceId)?.theme, let shown, theme != shown {
            let waiting = tellRail(theme)
            if !waiting.isEmpty {
                let horizon = DispatchWorkItem { [weak self] in self?.makeHeldCut(atHorizon: true) }
                heldCut = HeldCut(spaceId: spaceId, door: door, theme: theme, waiting: waiting, gestureWall: gestureWall, horizon: horizon)
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Self.railReskinHorizonMs), execute: horizon)
                return true
            }
        } else if wasHeld, let shown {
            // The rail was told another theme for the cut this replaces.
            tellRail(shown)
        }
        return makeCut(to: spaceId, door: door, gestureWall: gestureWall)
    }

    /// Tell each live rail page `theme`, and name the cards told. A rail
    /// card under a picture, or not shown, is not told: its page takes the
    /// theme from the shell as every other page does.
    @discardableResult
    private func tellRail(_ theme: String) -> Set<String> {
        let at = CACurrentMediaTime()
        var told: Set<String> = []
        for body in bodies {
            guard let cardId = body.cardId, cardPlacements[cardId]?.rail != nil else { continue }
            guard body.visible, body.picture == nil, body.contentPainted else { continue }
            railTold[cardId] = (theme, at)
            send(.bodyTheme(BodyTheme(theme: theme)), to: body)
            told.insert(cardId)
        }
        return told
    }

    /// `bodyThemed`: a rail page wears the theme it was told, and has
    /// rendered a frame in it. The line times the re-skin on the host's clock,
    /// told to answered, beside the page's own time to apply the theme. The
    /// last answer a held cut waits on makes the cut.
    func didTheme(_ body: Body, theme: String, appliedMs: Double) {
        guard let cardId = body.cardId else { return }
        if let told = railTold[cardId], told.theme == theme {
            railTold[cardId] = nil
            TugLog.info("bodies", "rail re-skin", [
                TugLog.field("card", cardId), TugLog.field("theme", theme),
                TugLog.field("ms", String(format: "%.1f", (CACurrentMediaTime() - told.at) * 1000)),
                TugLog.field("applied", String(format: "%.1f", appliedMs)),
            ])
        }
        // An answer to a telling since replaced: the page is on its way to
        // another theme.
        guard railTold[cardId] == nil else { return }
        body.theme = theme
        guard heldCut?.theme == theme, heldCut?.waiting.remove(cardId) != nil else { return }
        if heldCut?.waiting.isEmpty == true { makeHeldCut(atHorizon: false) }
    }

    /// Make the held cut: every rail page told has answered, or the horizon
    /// has come, and then the cut goes anyway and each rail card still to
    /// answer finishes its re-skin after it.
    private func makeHeldCut(atHorizon: Bool) {
        guard let held = heldCut else { return }
        heldCut = nil
        held.horizon.cancel()
        if atHorizon {
            for cardId in held.waiting.sorted() {
                TugLog.warn("bodies", "rail re-skin past its horizon", [TugLog.field("card", cardId), TugLog.field("theme", held.theme)])
            }
        }
        if makeCut(to: held.spaceId, door: held.door, gestureWall: held.gestureWall) { return }
        // The stage set no longer admits it: the rail goes back to the shown
        // theme, and a cut the host began is the shell's to make, as it is
        // for a caller the host refuses at once.
        if let shown = stages.active?.theme { tellRail(shown) }
        if held.door.hostOriginated { tellShell?("activate-space", ["spaceId": held.spaceId]) }
    }

    /// Let go of the held cut, unmade, and put the rail back in the shown theme.
    private func dropHeldCut() {
        guard let held = heldCut else { return }
        heldCut = nil
        held.horizon.cancel()
        TugLog.info("bodies", "stage cut dropped", [TugLog.field("to", held.spaceId), TugLog.field("door", held.door.name)])
        if let shown = stages.active?.theme { tellRail(shown) }
    }

    /// Make the cut onto `spaceId` now, if the stage set admits it.
    private func makeCut(to spaceId: String, door: CutDoor, gestureWall: Double) -> Bool {
        let began = CACurrentMediaTime()
        let serial: Int
        switch stages.admit(spaceId, door: door) {
        case .cut(let admitted):
            serial = admitted
        case .pending:
            pendingShellCut = spaceId
            TugLog.info("bodies", "stage cut pending", [TugLog.field("to", spaceId), TugLog.field("door", door.name)])
            return false
        case .ignored(let why):
            TugLog.info("bodies", "stage cut ignored", [
                TugLog.field("to", spaceId), TugLog.field("door", door.name), TugLog.field("why", why),
            ])
            return false
        }
        pendingShellCut = nil
        let from = stages.activeId
        let liveBefore = liveCards()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        stages.setCutting(true)
        stages.show(spaceId)
        for body in bodies {
            guard let cardId = body.cardId, let placed = cardPlacements[cardId] else { continue }
            if carrier.isHeld(body) || body === carrier.pressedOutOfBeats { continue }
            let visible = placedShown(cardId)
            guard visible != body.visible else { continue }
            if !visible { beats.cancel(body) }
            body.visible = visible
            body.sibling = placed.sibling && visible
            applyVisibility(body)
            refreshPicture(body)
        }
        refreshAlonePictures()
        stages.setCutting(false)
        CATransaction.commit()
        refreshRegion()
        if let focused = stages.active?.focusedCardId, pictureOf(focused) == .live, body(forCard: focused) != nil {
            focus(cardId: focused)
        }
        if door.hostOriginated {
            stages.told(serial)
            tellShell?("activate-space", ["spaceId": spaceId, "cut": serial])
        }
        noteCut(serial: serial, from: from, door: door, gestureWall: gestureWall, began: began, liveBefore: liveBefore)
        return true
    }

    /// The shell page reloaded: a host cut it was told is answered by
    /// nothing now, and holds no switch of the shell's back ([P06]).
    func shellReloaded() {
        stages.shellReloaded()
    }

    /// The cards live on screen now: the ones a cut parks are owed a last frame.
    private func liveCards() -> Set<String> {
        Set(bodies.compactMap { body -> String? in
            guard body.visible, body.canShow, body.picture == nil, !body.sibling else { return nil }
            return body.cardId
        })
    }

    /// `placeCards`: every card's view, whether it shows, how it stacks, and
    /// how the hand holds it. The rect is the pane's, which the gesture
    /// carries; the view is the pane outset by `apron`, grown to whole
    /// points. A body the placement does not name is hidden.
    ///
    /// Every workspace the placement names has a stage, and each card's
    /// visibility is derived from the stage the host shows ([P04]), which a
    /// placement never moves: only a cut does. The placement's own shown
    /// workspace seeds the first stage at launch, or after the shown one's
    /// workspace has gone; and a cut the shell asked for onto a workspace no
    /// placement had named yet is made once this one names it.
    func placeCards(_ placement: PlaceCards) {
        placementHeld = Set(placement.held ?? [])
        cardApron = CGFloat(placement.apron)
        // A canvas the shell does not show leaves the last one standing.
        if let canvas = placement.canvas { cardCanvas = canvas.cgRect }
        if placement.zoom > 0 { cardZoom = CGFloat(placement.zoom) }
        if placement.gap >= 0 { cardGap = CGFloat(placement.gap) }
        railLimits = placement.rails
        placedSpaces = placement.spaces
        placedActiveSpaceId = placement.activeSpaceId
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
                z: Int(entry.z),
                grips: Set(entry.grips),
                free: entry.free,
                min: CGSize(width: entry.min.width, height: entry.min.height),
                maxHeight: entry.maxHeight.map { CGFloat($0) },
                rail: entry.rail,
                railTravel: entry.railTravel,
                spaceId: entry.spaceId,
                staged: entry.staged,
                title: entry.title,
                kind: entry.kind,
                folded: entry.folded == true
            )
        }
        cardPlacements = placements
        placedEntries = named
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        stages.setCutting(true)
        // A workspace gone from the list takes its stage: any body still in
        // its view goes to the host view first, where its next placement, or
        // its close, finds it.
        let listed = Set(placement.spaces.map(\.id))
        for stage in stages.stages where !listed.contains(stage.id) {
            for body in bodies where body.container.superview === stage.view { reparent(body, into: hostView) }
            for picture in stage.alone.values { picture.takeDown() }
        }
        stages.sync(placement.spaces)
        if stages.activeId == nil { stages.show(placement.activeSpaceId) }
        for body in bodies {
            // A card in the host's hand is the host's until its gesture ends:
            // the placement that lands it is the shell's commit, after.
            if carrier.isHeld(body) { continue }
            // And so is one a press took from its beats, until the press
            // becomes a gesture or comes up.
            if body === carrier.pressedOutOfBeats { continue }
            guard let cardId = body.cardId, let (entry, deckIndex) = named[cardId] else {
                beats.cancel(body)
                body.visible = false
                body.sibling = false
                setPicture(nil, on: body)
                applyVisibility(body)
                continue
            }
            place(body, entry, deckIndex: deckIndex)
        }
        // Each rail's members into its rail view, each other card into its
        // stage, and the containers in the panes' order, back to front,
        // moved in place.
        reconcileRails()
        refreshAlonePictures()
        stages.setCutting(false)
        CATransaction.commit()
        refreshRegion()
        if let pending = pendingShellCut, stages.stage(pending) != nil { cut(to: pending, door: .shell(serial: nil)) }
        // The lane's order is the placement's: a card waiting on it may go.
        if !lane.isEmpty { lane.drain() }
    }

    /// A cut has committed: its account and its line, and each departing
    /// card that was live owed its last frame, taken one at a time once the
    /// cut's quiet has passed.
    private func noteCut(serial: Int, from: String?, door: CutDoor, gestureWall: Double, began: CFTimeInterval, liveBefore: Set<String>) {
        guard let to = stages.activeId else { return }
        var pictures: [String: String] = [:]
        var counts: [StagePicture: Int] = [:]
        for (cardId, placed) in cardPlacements where placed.spaceId == to && placed.rail == nil {
            guard let kind = pictureOf(cardId) else { continue }
            pictures[cardId] = kind.rawValue
            counts[kind, default: 0] += 1
        }
        let ms = (CACurrentMediaTime() - began) * 1000
        stages.record(StageSet.Cut(
            serial: serial, from: from, to: to, door: door.name, gestureWall: gestureWall,
            committedWall: Date().timeIntervalSince1970 * 1000, pictures: pictures
        ))
        TugLog.info("bodies", "stage cut", [
            TugLog.field("serial", serial),
            TugLog.field("from", from ?? "none"),
            TugLog.field("to", to),
            TugLog.field("door", door.name),
            TugLog.field("live", counts[.live] ?? 0),
            TugLog.field("last_frame", counts[.lastFrame] ?? 0),
            TugLog.field("skeleton", counts[.skeleton] ?? 0),
            TugLog.field("ms", String(format: "%.1f", ms)),
        ])
        lifecycle.cutCommitted()
        for body in bodies {
            guard let cardId = body.cardId, liveBefore.contains(cardId), !body.visible,
                  cardPlacements[cardId]?.spaceId == from else { continue }
            lifecycle.queueParkCover(body)
        }
    }

    // MARK: - Pictures

    /// Whether the last placement names `cardId` and it shows in the stage
    /// on screen now ([P04]).
    func placedShown(_ cardId: String) -> Bool {
        guard let placed = cardPlacements[cardId] else { return false }
        return StagePicture.visible(
            staged: placed.staged, rail: placed.rail != nil && placed.spaceId == nil, spaceId: placed.spaceId,
            activeId: stages.activeId ?? placedActiveSpaceId
        )
    }

    /// A last frame was kept or let go for `cardId`: what it can show moved.
    func lastFrameMoved(_ cardId: String) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let body = body(forCard: cardId) {
            refreshPicture(body)
        } else if cardPlacements[cardId] != nil {
            refreshAlonePictures()
        }
        CATransaction.commit()
    }

    /// The picture `cardId` shows now, or nil for a sibling or a card the
    /// last placement did not name.
    func pictureOf(_ cardId: String) -> StagePicture? {
        guard let placed = cardPlacements[cardId] else { return nil }
        if let body = body(forCard: cardId) {
            if placed.sibling { return nil }
            if let picture = body.picture { return picture.kind }
            return body.covered ? .lastFrame : .live
        }
        if let stage = stageOf(placed), let picture = stage.alone[cardId] { return picture.kind }
        return StagePicture.choose(pictureFacts(cardId, body: nil, placed: placed))
    }

    /// The host's facts about `cardId` that its picture is chosen from.
    private func pictureFacts(_ cardId: String, body: Body?, placed: CardPlacement) -> StagePicture.Facts {
        var facts = StagePicture.Facts()
        facts.sibling = placed.sibling
        let kept = lifecycle.covers.parkedCover(for: cardId) ?? lifecycle.covers.keptCover(for: cardId)
        facts.hasLastFrame = kept != nil || body?.covered == true
        if let body {
            facts.hasBody = true
            facts.contentPainted = body.contentPainted
            // Stale since its last frame was taken: that frame is behind too.
            // A frame taken after the page said so stands for it; its layer
            // is still behind until it paints as shown.
            facts.stale = body.stale && (kept.map { cover in (body.staleAt ?? 0) >= cover.takenAt } ?? true)
            facts.slept = body.sleptSinceShown || body.owedPaint || body.stale || body.paintedOnlyHidden
            facts.evicted = body.covered
            facts.pastHorizon = body.pastHorizon
        }
        facts.failed = failedCards.contains(cardId) || body?.state == .failed
        return facts
    }

    /// The stage `placed` stands in: its workspace's, or nil for a rail member.
    private func stageOf(_ placed: CardPlacement) -> Stage? {
        guard placed.rail == nil else { return nil }
        return stages.stage(placed.spaceId) ?? stages.active
    }

    /// The palette `placed`'s pictures draw in: its workspace's, or the
    /// shown stage's for a rail member, which follows the workspace the host
    /// shows rather than the theme the shell has caught up to ([B10]).
    private func paletteOf(_ placed: CardPlacement) -> SkeletonPalette? {
        if let stage = stageOf(placed) ?? stages.active { return stages.palette(of: stage) }
        return window.palettes.onScreen
    }

    /// Choose `body`'s picture again from its facts, and stand it.
    func refreshPicture(_ body: Body) {
        guard let cardId = body.cardId, let placed = cardPlacements[cardId], let entry = placedEntries[cardId]?.entry else {
            setPicture(nil, on: body)
            return
        }
        // A picture that stood alone for the card before its body was made
        // is the body's from here: the same skeleton, its wave running on.
        var adopted: StageCardPicture?
        for stage in stages.stages {
            guard let alone = stage.alone.removeValue(forKey: cardId) else { continue }
            if adopted == nil, body.picture == nil { adopted = alone } else { alone.takeDown() }
        }
        let facts = pictureFacts(cardId, body: body, placed: placed)
        let kind = StagePicture.choose(facts)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        switch kind {
        case .skeleton?, .lastFrame?:
            // A card brought back under its eviction cover shows that cover:
            // it is the card's last frame, standing in its container already.
            if kind == .lastFrame, body.covered {
                setPicture(nil, on: body)
            } else {
                let frame = body.container.bounds
                let standing = body.picture ?? adopted
                let picture = pictureView(kind!, cardId: cardId, placed: placed, entry: entry, facts: facts, frame: frame, standing: standing)
                if picture !== body.picture { setPicture(picture, on: body) }
                picture.skeleton?.keepWave()
            }
        default:
            setPicture(nil, on: body)
        }
        if let adopted, adopted !== body.picture { adopted.takeDown() }
        if let picture = body.picture { arm(picture, onScreen: body.visible, horizon: StagePicture.hasHorizon(facts), cardId: cardId) }
        CATransaction.commit()
    }

    /// The picture for each placed card that has no body: standing alone in
    /// its stage — or in the host view, for a rail member — at its view rect
    /// and order. A card with a body has its picture in its container.
    private func refreshAlonePictures() {
        var wanted: [ObjectIdentifier: Set<String>] = [:]
        for (cardId, placed) in cardPlacements where body(forCard: cardId) == nil {
            guard let entry = placedEntries[cardId]?.entry else { continue }
            let parent: NSView = stageOf(placed)?.view ?? hostView
            let facts = pictureFacts(cardId, body: nil, placed: placed)
            guard let kind = StagePicture.choose(facts), kind != .live, let stage = stageOf(placed) ?? stages.active else { continue }
            let standing = stage.alone[cardId]
            let picture = pictureView(kind, cardId: cardId, placed: placed, entry: entry, facts: facts, frame: entry.view.cgRect, standing: standing)
            picture.frame = entry.view.cgRect
            picture.order = Int(entry.z)
            if picture !== standing {
                standing?.takeDown()
                stage.alone[cardId] = picture
            }
            if picture.superview !== parent { parent.addSubview(picture) }
            wanted[ObjectIdentifier(stage), default: []].insert(cardId)
            // Shown only while its card is: a card its stage does not show,
            // or a rail of a workspace not shown, stands nothing.
            let shown = placedShown(cardId)
            // By opacity, never `isHidden`: AppKit draws no hidden view, so a
            // skeleton made in a parked stage and unhidden at the cut would
            // stand empty for the frames before its first draw.
            picture.isHidden = false
            picture.layer?.opacity = shown ? 1 : 0
            arm(picture, onScreen: shown, horizon: false, cardId: cardId)
        }
        for stage in stages.stages {
            let keep = wanted[ObjectIdentifier(stage)] ?? []
            for (cardId, picture) in stage.alone where !keep.contains(cardId) {
                picture.takeDown()
                stage.alone[cardId] = nil
            }
        }
        sortStacking()
    }

    /// The picture of `kind` for a card, reusing `standing` when it is the
    /// same picture: a skeleton of the same loading-ness takes the card's
    /// latest facts in place.
    private func pictureView(
        _ kind: StagePicture, cardId: String, placed: CardPlacement, entry: CardPlacementEntry,
        facts: StagePicture.Facts, frame: CGRect, standing: StageCardPicture?
    ) -> StageCardPicture {
        let loading = StagePicture.loading(facts)
        if let standing, standing.kind == kind {
            if let skeleton = standing.skeleton, (skeleton.wavesAfterFrames != nil) == loading {
                if let palette = paletteOf(placed) { skeleton.palette = palette }
                skeleton.title = placed.title
                skeleton.insets = entry.insets
                skeleton.folded = placed.folded
                skeleton.zoom = cardZoom
                return standing
            }
            if kind == .lastFrame {
                (standing.content as? BodyCoverView)?.paneInsets = entry.insets
                return standing
            }
        }
        let bounds = CGRect(origin: .zero, size: frame.size)
        let content: NSView
        if kind == .lastFrame, let cover = lifecycle.covers.parkedCover(for: cardId) ?? lifecycle.covers.keptCover(for: cardId) {
            let view = BodyCoverView(cover: cover, frame: bounds)
            view.paneInsets = entry.insets
            content = view
        } else {
            let palette = paletteOf(placed) ?? SkeletonPalette(
                theme: "", canvas: "#000000", grid: "#000000", surface: "#202020", band: "#2a2a2a", ink: "#cccccc", border: "#3a3a3a"
            )
            content = StageSkeletonView(
                frame: bounds, palette: palette, title: placed.title, insets: entry.insets,
                folded: placed.folded, zoom: cardZoom, loading: loading
            )
        }
        let made = kind == .lastFrame && content is StageSkeletonView ? StagePicture.skeleton : kind
        return StageCardPicture(kind: made, content: content, frame: frame, serial: nextSerial())
    }

    /// Stand `picture` over `body`'s page, in its container above everything
    /// in it, or take down the one standing when nil; the body's visibility
    /// follows, since a picture shows a container whose page cannot yet.
    private func setPicture(_ picture: StageCardPicture?, on body: Body) {
        guard picture !== body.picture else { return }
        body.picture?.takeDown()
        body.picture = picture
        if let picture {
            // An adopted alone picture may have been hidden while its card
            // was not shown; in the container, the container's own
            // visibility is what shows it.
            picture.isHidden = false
            picture.layer?.opacity = 1
            picture.frame = body.container.bounds
            picture.autoresizingMask = [.width, .height]
            body.container.addSubview(picture, positioned: .above, relativeTo: nil)
        }
        // The picture is the card's face while it stands, and the page
        // beneath it is not seen: a page still loading paints the deck's
        // own canvas across its whole view before its body styles apply,
        // and in its apron that would lie over the neighbouring card. Kept
        // by opacity, so the page runs its frames and paints all the same.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.webView.layer?.opacity = picture == nil ? 1 : 0
        CATransaction.commit()
        applyVisibility(body)
    }

    /// A picture is on screen, or no longer: a loading skeleton's wave runs
    /// while it is, and a picture over a painted page comes down at its
    /// horizon if the page has not painted by then ([P11]).
    private func arm(_ picture: StageCardPicture, onScreen: Bool, horizon: Bool, cardId: String) {
        let shown = onScreen && picture.superview != nil
        picture.skeleton?.setOnScreen(shown)
        guard shown else {
            picture.horizon?.cancel()
            picture.horizon = nil
            picture.onScreenSince = nil
            return
        }
        if picture.onScreenSince == nil { picture.onScreenSince = CACurrentMediaTime() }
        guard horizon, picture.horizon == nil else { return }
        let work = DispatchWorkItem { [weak self, weak picture] in
            guard let self, let picture, let body = self.body(forCard: cardId), body.picture === picture else { return }
            TugLog.warn("bodies", "stage picture past its horizon", [
                TugLog.field("card", cardId), TugLog.field("kind", picture.kind.rawValue),
            ])
            body.pastHorizon = true
            self.refreshPicture(body)
        }
        picture.horizon = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(BodyLifecycle.parkCoverHorizonMs)), execute: work)
    }

    /// A palette arrived: every stage's ground re-wears its theme's, and so
    /// does every skeleton standing.
    func paletteArrived() {
        stages.paletteArrived()
        for body in bodies {
            guard let skeleton = body.picture?.skeleton, let cardId = body.cardId,
                  let placed = cardPlacements[cardId] else { continue }
            guard let palette = paletteOf(placed) else { continue }
            skeleton.palette = palette
        }
        for stage in stages.stages {
            guard let palette = stages.palette(of: stage) else { continue }
            for picture in stage.alone.values { picture.skeleton?.palette = palette }
        }
    }

    /// The stages, for the harness (`stages`): which is shown, each one's
    /// cards with their pictures, and the last cuts.
    func stagesAccount() -> JSONValue {
        let ordered = cardPlacements.sorted { (placedEntries[$0.key]?.deckIndex ?? 0) < (placedEntries[$1.key]?.deckIndex ?? 0) }
        let rows: [JSONValue] = stages.stages.map { stage in
            let cards = ordered.filter { $0.value.rail == nil && stageOf($0.value) === stage }.map { cardRecord($0.key, $0.value) }
            return .object([
                "id": .string(stage.id),
                "theme": stage.theme.map(JSONValue.string) ?? .null,
                "shown": .bool(stage.view.isShown),
                "grounded": .bool(stage.ground != nil),
                "cards": .array(cards),
            ])
        }
        return .object([
            "active": stages.activeId.map(JSONValue.string) ?? .null,
            "stages": .array(rows),
            "rail": .array(ordered.filter { $0.value.rail != nil }.map { cardRecord($0.key, $0.value) }),
            "cuts": .array(stages.cuts.map(\.json)),
            // The last frames kept for parked workspaces' cards, by card.
            "parkCovers": .object([
                "cards": .object(lifecycle.covers.parkedCovers.mapValues {
                    .object(["bytes": .number(Double($0.bytes)), "takenAt": .number($0.takenAt)])
                }),
                "bytes": .number(Double(lifecycle.covers.parkedBytes)),
                "budgetBytes": .number(Double(BodyLifecycle.parkCoverBudgetBytes)),
            ]),
        ])
    }

    /// One card's record in the `stages` account.
    private func cardRecord(_ cardId: String, _ placed: CardPlacement) -> JSONValue {
        let body = self.body(forCard: cardId)
        let standing = body?.picture ?? stages.stages.lazy.compactMap { $0.alone[cardId] }.first
        return .object([
            "cardId": .string(cardId),
            "picture": pictureOf(cardId).map { .string($0.rawValue) } ?? .null,
            "wave": .bool(standing?.skeleton?.waveRunning == true),
            "waveDelayFrames": standing?.skeleton?.wavesAfterFrames.map { .number(Double($0)) } ?? .null,
            "onScreenWall": standing?.skeleton?.onScreenWall.map(JSONValue.number) ?? .null,
            "waveWall": standing?.skeleton?.waveWall.map(JSONValue.number) ?? .null,
            "visible": .bool(body?.visible ?? placedShown(cardId)),
            "staged": .bool(placed.staged),
            "hasBody": .bool(body != nil),
        ])
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

    /// A rect as `x,y w×h` in whole points, flipped to a top-left origin
    /// within `window` when one is given.
    private static func rectText(_ r: CGRect, in window: NSWindow?) -> String {
        let y = window.map { ($0.contentView?.bounds.height ?? 0) - r.maxY } ?? r.minY
        return "\(Int(r.minX.rounded())),\(Int(y.rounded())) \(Int(r.width.rounded()))×\(Int(r.height.rounded()))"
    }

    /// One row per bound body: its state, whether it has painted, stands
    /// under a cover, and is hidden; its container's presented opacity;
    /// whether the host shows it; the picture standing for it; and where
    /// its container and its skeleton's pane stand.
    private func sampleLayers() {
        let wall = Date().timeIntervalSince1970 * 1000
        for body in bodies {
            guard let cardId = body.cardId else { continue }
            let layer = body.container.layer
            layerRows.append(.object([
                "wall": .number(wall),
                "cardId": .string(cardId),
                "state": .string(body.life.reported),
                "painted": .bool(body.painted),
                "covered": .bool(body.covered),
                "hidden": .bool(body.container.isHidden),
                "opacity": .number(Double(layer?.presentation()?.opacity ?? layer?.opacity ?? 0)),
                "shown": .bool(body.visible && body.canShow),
                "start": .string(body.warm ? "warm" : "cold"),
                "lastFrame": .bool(body.picture?.kind == .lastFrame),
                "picture": .string(pictureOf(cardId)?.rawValue ?? "none"),
                // The theme the page last said it wears, beside the shown stage's.
                "theme": body.theme.map { .string($0) } ?? .null,
                "stageTheme": stages.active?.theme.map { .string($0) } ?? .null,
                // Where the container stands in the window, top-left origin,
                // and the pane its picture's skeleton draws within it.
                "frame": .string(Self.rectText(body.container.convert(body.container.bounds, to: nil), in: window)),
                "pane": body.picture?.skeleton.map { .string("\(Self.rectText($0.bounds, in: nil)) pane \(Self.rectText($0.paneRect, in: nil))") } ?? .null,
            ]))
        }
    }

    /// Stand `body` where its placement entry puts it.
    func place(_ body: Body, _ entry: CardPlacementEntry, deckIndex: Int) {
        let frame = entry.view.cgRect
        // Shown when its workspace's stage is the one on screen and it would
        // show there ([P04]): the host's own answer, never the shell's
        // `visible`, which follows the host's cut.
        // A rail card names no workspace: it is the window's, and shows
        // whichever stage is on screen.
        let visible = StagePicture.visible(
            staged: entry.staged, rail: entry.rail != nil && entry.spaceId == nil, spaceId: entry.spaceId,
            activeId: stages.activeId ?? placedActiveSpaceId
        )
        setWhole(body, true)
        body.sibling = entry.sibling == true && (visible || !entry.visible)
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
            self.beats.cancel(body)
        }
        body.frame = frame
        body.shellControls = entry.shell.map(\.cgRect)
        body.container.frame = frame
        body.visible = visible
        body.z = Int(entry.z)
        body.container.order = body.z
        body.deckIndex = deckIndex
        applyVisibility(body)
        refreshPicture(body)
    }

    /// Stand every rail member's container in its rail's view and every other
    /// container in the host view, place each rail view at the union of its
    /// members, and sort. A body whose beats are running, one in the hand,
    /// and one a press took from its beats are left where they are, since a
    /// reparent ends their layer's animation: the landing reconciles them.
    /// A rail view whose member's beats run stands still, since the mapping
    /// its beats were solved against reads the rail view's bounds origin.
    func reconcileRails() {
        for body in bodies {
            if body.beats != nil || body === carrier.pressedOutOfBeats || carrier.isHeld(body) { continue }
            let placed = body.cardId.flatMap { cardPlacements[$0] }
            let target: NSView
            if let side = placed?.rail?.side {
                target = railView(for: side)
            } else if let placed, let stage = stageOf(placed) {
                target = stage.view
            } else {
                target = hostView
            }
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
    func railView(for side: RailSide) -> RailView {
        if let view = rails[side] { return view }
        let view = RailView(side: side)
        hostView.addSubview(view)
        rails[side] = view
        return view
    }

    /// Move `body`'s container into `parent`, at the same viewport frame,
    /// with the first responder inside it kept: a removal resigns it to the
    /// window, so it is given back.
    func reparent(_ body: Body, into parent: NSView) {
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

    /// The host view's stage views beneath its rail views and cards, each
    /// stage's containers and pictures in the panes' order, and each rail's
    /// members in theirs, moved in place.
    func sortStacking() {
        sortStacked(in: hostView)
        for stage in stages.stages { sortStacked(in: stage.view) }
        for view in rails.values { sortStacked(in: view) }
    }

    // MARK: - Gestures

    /// `cardGesture` `begin` (`CardGestureCarrier`).
    func claimGesture(from body: Body, begin: CardGestureBegin) {
        carrier.claim(from: body, begin: begin)
    }

    /// A mouse event while a gesture is live.
    func track(_ event: NSEvent) {
        carrier.track(event)
    }

    /// End the gesture with nothing committed.
    func cancelGesture() {
        carrier.cancel()
    }

    // MARK: - Beats

    /// `cardPlan` (`BodyBeatsRunner`).
    func runPlan(_ plan: CardPlan) {
        beats.run(plan)
    }

    /// `crossingReady` (`BodyBeatsRunner`).
    func crossingReady(_ body: Body, surface: [Double]?) {
        beats.crossingReady(body, surface: surface)
    }

    /// `crossingSolved` (`BodyBeatsRunner`).
    func crossingSolved(_ body: Body, band: CrossingSolved.Band?, anchor: CrossingSolved.Anchor?) {
        beats.crossingSolved(body, band: band, anchor: anchor)
    }

    /// `bodySurface`: the page's background as sRGB bytes, posted when it
    /// paints and whenever its theme changes. The container wears it behind
    /// the web view for as long as the body stands. The page's theme's
    /// skeleton palette goes to the window's store by its theme's name.
    func setSurface(_ body: Body, surface: [Double]?, palette: SkeletonPalette? = nil) {
        if let palette {
            let known = window.palettes.known(palette.theme) == palette
            window.palettes.note(palette)
            if !known { paletteArrived() }
            // A page told a theme says it wears it with `bodyThemed`.
            if let cardId = body.cardId, railTold[cardId] == nil { body.theme = palette.theme }
        }
        guard let surface else { return }
        body.surface = Self.color(surface)
        if !body.whole { body.container.surface = body.surface }
    }

    /// Four sRGB bytes, which the surface's decode has checked, as a colour.
    static func color(_ bytes: [Double]) -> CGColor {
        let c = bytes.map { CGFloat($0) / 255 }
        return CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: c[3])
    }

    /// Hold the body's container as a whole card's view: its page draws its
    /// own corners and surface, and its apron must show what is beneath it.
    private func setWhole(_ body: Body, _ whole: Bool) {
        body.whole = whole
        body.container.surface = whole ? nil : body.surface
    }

    /// The display period of the screen the window is on, seconds, which the
    /// harness reads beside a body's frames. 60 Hz when the window has no
    /// screen yet.
    var displayPeriodSec: Double {
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
    /// The card is gone from here: an eviction in flight leaves it alone,
    /// its ready deadline reports nothing, and a page that does not answer
    /// the save within `saveDeadline` is removed all the same.
    func destroy(cardId: String, save: Bool) {
        lifecycle.covers.drop(cardId)
        lifecycle.covers.dropParked(cardId)
        // A card still waiting in the lane has no page to save.
        lane.forget(cardId: cardId)
        failedCards.remove(cardId)
        // The card is gone: no picture stands for it, alone or over its page,
        // before the shell's next placement says so.
        cardPlacements[cardId] = nil
        placedEntries[cardId] = nil
        for stage in stages.stages {
            stage.alone.removeValue(forKey: cardId)?.takeDown()
        }
        guard let body = body(forCard: cardId) else { return }
        setPicture(nil, on: body)
        lifecycle.move(body, .close)
        body.deadline?.cancel()
        body.deadline = nil
        body.evictDue?.cancel()
        body.evictDue = nil
        body.dormantDue?.cancel()
        body.dormantDue = nil
        guard save else {
            remove(body)
            return
        }
        // `remove` takes a body once; whichever of the answer and the
        // deadline comes second finds it gone.
        window.hostChannel.call(.saveState, in: body.webView) { [weak self] _ in self?.remove(body) }
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyLifecycle.saveDeadline) { [weak self] in
            self?.remove(body)
        }
    }

    /// Every body, at once, and the overlay with them. Used where the
    /// window's bridge is taken down.
    func destroyAll() {
        lane.clear()
        stopBodyLayers()
        lifecycle.covers.clear()
        for stage in stages.stages {
            for picture in stage.alone.values { picture.takeDown() }
            stage.alone = [:]
        }
        for body in bodies { remove(body) }
        // After the removals, which leave the lane idle and would ask for a
        // spare the window going away has no use for.
        lane.cancelPendingSpare()
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
            guard lifecycle.move(body, .keepAcrossReload, quietly: true) else { continue }
            if body.state == .ready { window.hostChannel.call(.saveState, in: body.webView) { _ in } }
        }
    }

    /// The bodies that can answer `prepareForTermination()`: bound and ready.
    var terminable: [(cardId: String, webView: WKWebView)] {
        bodies.compactMap { body in
            guard let cardId = body.cardId, body.life.isLive else { return nil }
            return (cardId, body.webView)
        }
    }

    func remove(_ body: Body) {
        guard bodies.contains(where: { $0 === body }) else { return }
        lifecycle.move(body, .close)
        body.deadline?.cancel()
        body.deadline = nil
        body.evictDue?.cancel()
        body.evictDue = nil
        body.dormantDue?.cancel()
        body.dormantDue = nil
        // The card's next body starts undeclared, so tugcast must too.
        declareDormant(body, false)
        // A card going away mid-gesture takes its gesture with it: a rail's
        // drag takes its ghost away, or commits the spring the hand released.
        carrier.letGo(of: body)
        bodies.removeAll { $0 === body }
        body.picture?.takeDown()
        body.picture = nil
        if let cardId = body.cardId, let stand = body.stand { lifecycle.covers.release(stand, for: cardId) }
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
        // A closed body still saving leaves after its card may have been asked
        // for again: the card's new body holds its menu state now.
        if let cardId = body.cardId, self.body(forCard: cardId) == nil {
            window.bodyDidGoAway(cardId: cardId)
        }
        refreshRegion()
        // A card still placed with no page — evicted, or its process gone —
        // stands alone in its stage, as its last frame or its skeleton.
        if let cardId = body.cardId, cardPlacements[cardId] != nil, self.body(forCard: cardId) == nil {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            refreshAlonePictures()
            CATransaction.commit()
        }
        // A page gone, failed at its deadline or destroyed, has left the lane.
        if !lane.isEmpty { lane.drain() }
        // The last page to leave the lane may have left it by failing, with
        // no ready to make the spare after it.
        if lane.isIdle, spare == nil { scheduleSpare() }
    }

    // MARK: - Eviction

    /// The machine says how short of memory it is (`BodyLifecycle`).
    func memoryPressure(_ level: PressureLevel) {
        lifecycle.memoryPressure(level)
    }

    /// The harness's seam on the body clocks (`bodyDelays`), which the
    /// product never sends: how long a hidden body keeps its process, and how
    /// long a body made from now has to say it is ready; nil puts the
    /// constant back. Refused outside the harness.
    func setDelays(_ delays: BodyDelays) {
        guard ProcessInfo.processInfo.environment["TUGAPP_TEST_SOCKET"] != nil else {
            TugLog.warn("bodies", "bodyDelays outside the harness; ignored")
            return
        }
        lifecycle.setEvictAfter(ms: delays.evictAfterMs ?? BodyLifecycle.evictAfter)
        lifecycle.setDormantAfter(ms: delays.dormantAfterMs ?? BodyLifecycle.dormantAfter)
        readyDeadline = BodyGeometry.readyDeadlineMs(harness: delays.readyDeadlineMs, fallback: BodyViewController.readyDeadlineMs)
        contentPaintDelays = delays.contentPaintDelayMs ?? [:]
    }

    /// The harness's slow pages (`bodyDelays`): per card, how long its page
    /// waits once its content is quiet, told in each bind. Empty in the product.
    private var contentPaintDelays: [String: Double] = [:]

    /// The body's frame as it stands, drawn at `size` points and `scale`
    /// pixels a point: `done` gets it, or nil when the snapshot failed or did
    /// not answer within `deadline`, and runs once. `purpose` names it in the
    /// log. A page WebKit is not painting still answers a snapshot, which it
    /// paints for the asking. The eviction's cover and a crossing's both
    /// take theirs here.
    func snapshotFrame(
        of body: Body, cardId: String, size: CGSize, scale: CGFloat, deadline: DispatchTimeInterval,
        purpose: String, then done: @escaping (CGImage?) -> Void
    ) {
        let answer = AnswerOrDeadline<CGImage>(deadline: deadline) { frame, timedOut in
            if timedOut {
                TugLog.warn("bodies", "the snapshot for \(purpose) did not answer; it goes without one", [
                    TugLog.field("card", cardId),
                ])
            }
            done(frame)
        }
        body.webView.takeSnapshot(with: nil) { image, error in
            guard let frame = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                TugLog.warn("bodies", "no frame for \(purpose)", [
                    TugLog.field("card", cardId),
                    TugLog.field("error", error.map { String(describing: $0) } ?? "none"),
                ])
                answer.answer(nil)
                return
            }
            answer.answer(Self.drawn(frame, size: size, scale: scale))
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

    // MARK: - Failure

    func armDeadline(_ body: Body) {
        body.deadline?.cancel()
        let work = DispatchWorkItem { [weak self, weak body] in
            guard let self, let body, body.state == .loading || body.state == .connected || body.state == .bound else { return }
            self.fail(body, cause: "deadline")
        }
        body.deadline = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(readyDeadline),
            execute: work
        )
    }

    /// Give up on a body: it is destroyed, and the shell decides whether to
    /// ask for the card's body again.
    private func fail(_ body: Body, cause: String) {
        // A closed body is not failed: nothing of its card is left to report.
        guard lifecycle.move(body, .fail) else { return }
        let cardId = body.cardId
        TugLog.error("bodies", "failed", [
            TugLog.field("card", cardId ?? "spare"),
            TugLog.field("cause", cause),
        ])
        // No picture stands over a failed card: the shell's placard saying
        // it needs reloading is its face, until the card is asked for again.
        if let cardId { failedCards.insert(cardId) }
        remove(body)
        if let cardId {
            notifyShell(BodyStateReport(cardId: cardId, state: .failed, cause: cause))
        }
    }

    /// A body's WebContent process died. A card the user can see is loaded
    /// afresh and re-bound to restore it — `load`, not `reload()`, which a
    /// terminated view with a nil `url` ignores — once per window; a second
    /// death inside the window fails it. A card nobody sees is evicted with
    /// no cover rather than reloaded, and a closed card's page, still
    /// saving, is let go. An eviction in flight is abandoned either way.
    /// Returns false for a view that is not a body.
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
                overlayView.load(bodyPageRequest(url))
            }
            return true
        }
        guard let body = body(for: webView) else { return false }
        let now = Date()
        let again = body.lastTermination.map { now.timeIntervalSince($0) < BodyViewController.terminationWindow } ?? false
        switch body.life.onTermination(hasCard: body.cardId != nil, seen: body.visible || body.sibling, again: again) {
        case .ignore:
            return true
        case .fail:
            fail(body, cause: "terminated twice")
            return true
        case .dropSpare:
            // A spare holds nothing; drop it, and let the next one be made.
            remove(body)
            scheduleSpare()
            return true
        case .evict:
            lifecycle.evictTerminated(body, cardId: body.cardId ?? "")
            return true
        case .reload:
            body.lastTermination = now
            let cardId = body.cardId ?? ""
            TugLog.warn("bodies", "WebContent process terminated — reloading", [
                TugLog.field("card", cardId),
            ])
            loadAfresh(body, cardId: cardId)
            return true
        }
    }

    /// A body's page asked to reload itself: the dev server named the bodies'
    /// entry in a scoped reload (`tugdeck/src/lib/scoped-reload.ts`). Its
    /// card's state is written first, as a shell reload writes every body's,
    /// and the page is then loaded afresh under the same card. The spare,
    /// which holds nothing, reloads as itself. Returns false for a view that
    /// is not a card's body, whose reload the caller lets through.
    func reloadForEdit(_ webView: WKWebView) -> Bool {
        guard let body = body(for: webView), let cardId = body.cardId else { return false }
        // A closed card's page, still saving, is going anyway.
        if body.state == .gone { return true }
        TugLog.info("bodies", "reloading for an edit", [TugLog.field("card", cardId)])
        guard body.life.isLive else {
            // Not bound yet: nothing of the card's is in the page to write.
            loadAfresh(body, cardId: cardId)
            return true
        }
        var reloaded = false
        let reload = { [weak self, weak body] in
            guard !reloaded, let self, let body, body.state != .gone, self.bodies.contains(where: { $0 === body }) else { return }
            reloaded = true
            self.loadAfresh(body, cardId: cardId)
        }
        window.hostChannel.call(.saveState, in: webView) { _ in reload() }
        DispatchQueue.main.asyncAfter(deadline: .now() + BodyLifecycle.saveDeadline) { reload() }
        return true
    }

    /// Load a body's page afresh under the card it holds, and bind it again as
    /// it would be at launch. An eviction in flight is abandoned: the page it
    /// was saving is the one this replaces.
    private func loadAfresh(_ body: Body, cardId: String) {
        guard let origin = window.shellOrigin,
              let url = URL(string: origin + "/?body=\(cardId)") else {
            fail(body, cause: "no origin to reload from")
            return
        }
        // The page is taken back to loading, unpainted and never shown: the
        // new page paints into a view that was shown, unhidden and
        // transparent until it says `painted`, as a page never shown is —
        // hidden, it would never get the frames `painted` waits on.
        guard lifecycle.move(body, .reload) else { return }
        // Its card restores as it would at launch: a Session card from the
        // ledger, a kind with no session by mounting again. The kind is kept.
        body.intent = JSONObject(["kind": .string(body.intent?["kind"] == .string("mount") ? "mount" : "restore")])
        body.warm = false
        body.askedAt = CACurrentMediaTime()
        applyVisibility(body)
        notifyShell(BodyStateReport(cardId: cardId, state: .terminated))
        armDeadline(body)
        body.webView.load(bodyPageRequest(url))
    }

    // MARK: - Harness

    /// Every body as the harness reports it, the spare included.
    func snapshot() -> [JSONValue] {
        bodies.map { body -> JSONValue in
            let opacity = body.container.layer?.presentation()?.opacity ?? body.container.layer?.opacity ?? 0
            var entry: [String: JSONValue] = [:]
            entry["cardId"] = body.cardId.map(JSONValue.string) ?? .null
            entry["componentId"] = body.componentId.map(JSONValue.string) ?? .null
            entry["state"] = .string(body.life.reported)
            entry["frame"] = Self.json(body.frame)
            entry["visible"] = .bool(body.visible && body.canShow)
            entry["shown"] = .bool(body.seen)
            entry["painted"] = .bool(body.painted)
            entry["covered"] = .bool(body.covered)
            entry["wasCovered"] = .bool(body.wasCovered)
            // Whether the clock's eviction is armed for it: what tells a body
            // the clock will take from one it passes over, without waiting.
            entry["evictDue"] = .bool(body.evictDue != nil)
            // The page's identity: a body torn down and made again, the spare
            // remade after a warning took it, reads as another page.
            entry["page"] = .number(Double(body.serial))
            // Its WebContent process, for a harness that must kill exactly it
            // (row 37); WebKit's SPI, read only where the view answers it.
            entry["pid"] = body.webView.responds(to: NSSelectorFromString("_webProcessIdentifier"))
                ? ((body.webView.value(forKey: "_webProcessIdentifier") as? NSNumber).map { .number($0.doubleValue) } ?? .null)
                : .null
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
            entry["inHand"] = .bool(carrier.holds(body))
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
    func presentedRect(_ body: Body) -> CGRect {
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

    func notifyShell(_ report: BodyStateReport) {
        window.sendToShell(.bodyState(report))
    }

    func send(_ message: ToPage, to body: Body) {
        window.hostChannel.send(message, to: body.webView)
    }
}

/// A body's last crossing, as the harness reads it: its plan and size, how
/// far ahead of the first moving beat the body was ready, whether it said
/// `crossingSolved` before its plan started and how long after the plan's
/// receipt, where a whole card's cover came from, how long it took to
/// snapshot and its size in pixels, the surface it wore, and whether the
/// page follows its container again.
struct CrossingAccount: Equatable {
    /// Where a covered crossing's cover came from.
    enum Cover: String {
        /// The cover the body already stood under, brought back from an eviction.
        case standing
        /// A snapshot of the page, taken for the crossing.
        case snapshot
        /// None: the page is kept to the land.
        case keptPage = "kept-page"
    }

    var planId: Int
    var size: CGSize
    /// When the plan carrying it was received (media time).
    var receivedAt: CFTimeInterval?
    var readyLeadMs: Double?
    var solved = false
    var solveMs: Double?
    /// Whether the plan started by its guard running out rather than by every awaited card solving.
    var timedOut: Bool?
    /// Whether the plan was still waiting on this body when it started: never, for a page that cannot answer.
    var awaited: Bool?
    var cover: Cover?
    var snapshotMs: Double?
    var coverPixels: CGSize?
    var band: BodyBeats.CrossingBand?
    var split: BodyBeats.CoverSplit?
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
            "timedOut": timedOut.map(JSONValue.bool) ?? .null,
            "awaited": awaited.map(JSONValue.bool) ?? .null,
            "cover": cover.map { .string($0.rawValue) } ?? .null,
            "snapshotMs": snapshotMs.map(JSONValue.number) ?? .null,
            "coverPixels": coverPixels.map { .object(["width": .number($0.width), "height": .number($0.height)]) } ?? .null,
            "band": band.map {
                .object(["restTop": .number($0.restTop), "height": .number($0.height), "reach": .number($0.reach)])
            } ?? .null,
            "split": split.map { .object(["splitY": .number($0.splitY), "follows": .bool($0.follows), "centerY": $0.centerY.map(JSONValue.number) ?? .null]) } ?? .null,
        ]
        if let surface { fields["surface"] = .array(surface.map(JSONValue.number)) }
        if restored { fields["restored"] = .bool(true) }
        return .object(fields)
    }
}
