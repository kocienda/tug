import AppKit

// The host's stages: what it knows about each workspace's picture without
// asking any web process — the palettes it draws a workspace's ground and its
// cards' skeletons in, learned by theme name, the grounds beneath the shell's
// page, one per workspace, and the stage views above it holding each
// workspace's cards — and the policy that picks, from the host's own facts,
// what each card shows: its live page, its last frame, or a skeleton.

/// The palettes the host knows, by theme name. The shell reports its
/// on-screen theme's (`setTheme`), and every body page its own theme's
/// (`bodySurface`), so a workspace whose theme is not on screen has a palette
/// as soon as one of its cards has a page. A theme with none yet falls back
/// to the on-screen palette, and `onMissing` hears it once per theme.
final class ThemePalettes {
    private var byTheme: [String: SkeletonPalette] = [:]
    private var onScreenTheme: String?
    private var saidMissing: Set<String> = []

    /// Told the name of a theme asked for with no palette of its own, once per theme.
    var onMissing: ((String) -> Void)?

    /// The shell's on-screen theme's palette, which is also the fallback.
    func noteOnScreen(_ palette: SkeletonPalette) {
        byTheme[palette.theme] = palette
        onScreenTheme = palette.theme
    }

    /// The palette kept for `theme` itself, with no fallback.
    func known(_ theme: String) -> SkeletonPalette? { byTheme[theme] }

    /// A page's own theme's palette.
    func note(_ palette: SkeletonPalette) {
        byTheme[palette.theme] = palette
    }

    /// The on-screen theme's palette, or nil before the shell has said one.
    var onScreen: SkeletonPalette? {
        onScreenTheme.flatMap { byTheme[$0] }
    }

    /// `theme`'s palette, or the on-screen one when none is known for it;
    /// nil when neither is known.
    func palette(for theme: String?) -> SkeletonPalette? {
        guard let theme else { return onScreen }
        if let known = byTheme[theme] { return known }
        if !saidMissing.contains(theme) {
            saidMissing.insert(theme)
            onMissing?(theme)
        }
        return onScreen
    }
}

/// A workspace's ground: the canvas colour and its grid, drawn by the host.
/// The shell's document paints no canvas of its own (`globals.css`), so this
/// is the canvas every card stands on. The grid is the deck's lattice — a
/// line every 24 layout px from the deck root's corner, one layout px wide,
/// scaled by View › Zoom. The deck root is the shell's `#deck-container`,
/// whose corner is the viewport's, so the lattice starts at this view's.
/// Answers no point.
final class StageGroundView: NSView {
    /// The grid's cell, layout px (`globals.css`).
    static let cell: CGFloat = 24
    var canvas: NSColor { didSet { needsDisplay = true } }
    var grid: NSColor { didSet { needsDisplay = true } }
    var zoom: CGFloat { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }

    init(frame: NSRect, canvas: NSColor, grid: NSColor, zoom: CGFloat) {
        self.canvas = canvas
        self.grid = grid
        self.zoom = zoom
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Wear `palette`'s canvas and grid. False when either does not parse.
    @discardableResult
    func wear(_ palette: SkeletonPalette) -> Bool {
        guard let canvas = SkeletonPalette.srgb(palette.canvas),
              let grid = SkeletonPalette.srgb(palette.grid) else { return false }
        self.canvas = canvas
        self.grid = grid
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        canvas.setFill()
        bounds.fill()
        grid.setFill()
        let pitch = Self.cell * zoom
        guard pitch > 0 else { return }
        var x: CGFloat = 0
        while x < bounds.width {
            NSRect(x: x, y: 0, width: zoom, height: bounds.height).fill()
            x += pitch
        }
        var y: CGFloat = 0
        while y < bounds.height {
            NSRect(x: 0, y: y, width: bounds.width, height: zoom).fill()
            y += pitch
        }
    }
}

/// The layer of grounds beneath the shell's page and above the splash: one
/// ground per workspace's stage, only the active one's shown, each in its
/// workspace's palette. Before the first placement names any workspace it
/// holds one boot ground in the on-screen palette, which the first stage's
/// ground replaces; it is empty until the shell has said a palette. Answers
/// no point.
final class StageGroundHostView: NSView {
    /// The boot ground, standing until a stage stands its own.
    private var boot: StageGroundView?
    private var zoom: CGFloat = 1

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// The ground shown now: the active stage's, or the boot ground.
    var ground: StageGroundView? {
        subviews.lazy.compactMap { $0 as? StageGroundView }.first { !$0.isHidden }
    }

    /// The boot ground wears `palette`, standing it when none stands yet.
    /// Once a stage has stood a ground there is no boot ground, and this
    /// does nothing: each stage wears its own.
    func show(_ palette: SkeletonPalette) {
        if let boot {
            boot.wear(palette)
            return
        }
        guard !subviews.contains(where: { $0 is StageGroundView }), let made = makeGround(palette) else { return }
        made.isHidden = false
        boot = made
    }

    /// A ground in `palette`, standing hidden in this view, at the current
    /// zoom; nil when the palette does not parse. The boot ground goes.
    func makeGround(_ palette: SkeletonPalette) -> StageGroundView? {
        guard let canvas = SkeletonPalette.srgb(palette.canvas),
              let grid = SkeletonPalette.srgb(palette.grid) else { return nil }
        let made = StageGroundView(frame: bounds, canvas: canvas, grid: grid, zoom: zoom)
        made.autoresizingMask = [.width, .height]
        made.isHidden = true
        addSubview(made)
        return made
    }

    /// The boot ground goes: a stage's ground stands for the canvas now.
    func dropBoot() {
        boot?.removeFromSuperview()
        boot = nil
    }

    /// View › Zoom moved: every lattice's pitch and line width follow it.
    func setZoom(_ zoom: CGFloat) {
        self.zoom = zoom
        for case let ground as StageGroundView in subviews { ground.zoom = zoom }
    }
}

// MARK: - The picture policy

/// What a card shows, chosen from the host's own facts (Table T01).
enum StagePicture: String {
    /// The card's own page, shown in its stage with nothing over it.
    case live
    /// The card's last frame, kept when it parked or when it was evicted.
    case lastFrame
    /// The card's pane drawn by the host from the facts it was placed with.
    case skeleton

    /// The host's facts about one card that the choice reads.
    struct Facts: Equatable {
        /// The card has a body (a page, loading or loaded).
        var hasBody = false
        /// Its page has said its content painted.
        var contentPainted = false
        /// Its page said `bodyStale` while hidden, and has not painted as
        /// shown since: what it would draw moved, and any last frame kept
        /// for it is behind too.
        var stale = false
        /// Its page slept since it was shown, or was shown since without
        /// painting again: its layer may be behind, its last frame is not.
        var slept = false
        /// Its body was brought back from an eviction and stands under that
        /// cover until its new page paints.
        var evicted = false
        /// A last frame is kept for it: a parked page's, or an eviction's.
        var hasLastFrame = false
        /// An inactive tab: its pane's active card has the picture.
        var sibling = false
        /// Its page failed: nothing a picture could stand for is coming.
        var failed = false
        /// A picture over its painted page outlived its horizon ([P11]).
        var pastHorizon = false

        /// Its page's picture stands for what it would draw now.
        var current: Bool { !stale && !slept }
    }

    /// The card's picture, or nil for a sibling, which has none of its own.
    static func choose(_ facts: Facts) -> StagePicture? {
        if facts.sibling { return nil }
        // A failed card shows what the shell draws for it: nothing stands over it.
        if facts.failed { return .live }
        if facts.hasBody, facts.contentPainted, !facts.evicted, facts.current || facts.pastHorizon { return .live }
        if facts.hasLastFrame, !facts.stale { return .lastFrame }
        return .skeleton
    }

    /// Whether a skeleton chosen on `facts` stands for a card still loading
    /// — no content painted yet — and so wears the progress wave.
    static func loading(_ facts: Facts) -> Bool {
        !(facts.hasBody && facts.contentPainted)
    }

    /// Whether a picture chosen on `facts` comes down at the horizon: it
    /// stands over a page that has painted content before. A skeleton over a
    /// page that never has stays until it paints or its deadline fails it.
    static func hasHorizon(_ facts: Facts) -> Bool {
        facts.hasBody && facts.contentPainted && !facts.evicted
    }

    /// Whether a card placed with `staged` in workspace `spaceId` (nil for a
    /// rail member, `rail` true) is shown while `activeId`'s stage is ([P04]).
    /// A card the placement names no workspace for is in the shown one.
    static func visible(staged: Bool, rail: Bool, spaceId: String?, activeId: String?) -> Bool {
        guard staged else { return false }
        if rail { return true }
        guard let spaceId else { return true }
        return spaceId == activeId
    }
}

// MARK: - Skeletons

/// A card's pane drawn by the host from its placement and its workspace's
/// palette (Spec S03): the pane's rounded rect inset by the view's insets,
/// filled `surface` with a one-pixel `border`; a title band of the chrome's
/// height filled `band`; the title in `ink`, one line, truncated at its tail.
/// A folded card draws the band alone. A loading card's skeleton wears the
/// progress wave over its body, from its third display frame on screen.
/// Answers no point.
final class StageSkeletonView: NSView {
    /// The pane's corner radius: the themes' `--tug-radius-md`.
    static let paneRadius: CGFloat = 6
    /// The chrome's height, layout px: the themes' `--tug-chrome-height`.
    static let chromeHeight: CGFloat = 36
    /// The title's size, layout px.
    static let titleSize: CGFloat = 13
    /// The display frames a loading skeleton stands before its wave runs.
    static let waveDelayFrames = 2
    /// How long one sweep of the wave takes.
    static let waveSeconds: CFTimeInterval = 1.4

    var palette: SkeletonPalette { didSet { if palette != oldValue { needsDisplay = true; tintWave() } } }
    var title: String { didSet { if title != oldValue { needsDisplay = true } } }
    var insets: CardInsets? { didSet { if insets != oldValue { needsDisplay = true; needsLayout = true } } }
    var folded: Bool { didSet { if folded != oldValue { needsDisplay = true; needsLayout = true } } }
    var zoom: CGFloat { didSet { if zoom != oldValue { needsDisplay = true; needsLayout = true } } }
    /// The display frames the wave waits on screen before it runs, or nil
    /// for a skeleton that wears none (one over a page that has painted).
    let wavesAfterFrames: Int?
    /// Whether the wave is running now.
    private(set) var waveRunning = false
    /// When the skeleton last came on screen, and when its wave then began,
    /// wall-clock ms: the harness reads the delay between them.
    private(set) var onScreenWall: Double?
    private(set) var waveWall: Double?
    private let wave = CAGradientLayer()
    private var waveLink: CADisplayLink?
    override var isFlipped: Bool { true }

    init(frame: NSRect, palette: SkeletonPalette, title: String, insets: CardInsets?, folded: Bool, zoom: CGFloat, loading: Bool) {
        self.palette = palette
        self.title = title
        self.insets = insets
        self.folded = folded
        self.zoom = zoom
        wavesAfterFrames = loading ? Self.waveDelayFrames : nil
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        // A bitmap a resize has not redrawn yet keeps its title band at the top.
        layerContentsPlacement = .topLeft
        wave.startPoint = CGPoint(x: 0, y: 0.5)
        wave.endPoint = CGPoint(x: 1, y: 0.5)
        wave.isHidden = true
        tintWave()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// The pane's rect within the view.
    var paneRect: CGRect {
        guard let i = insets else { return bounds }
        return CGRect(
            x: i.left, y: i.top,
            width: max(0, bounds.width - i.left - i.right),
            height: max(0, bounds.height - i.top - i.bottom)
        )
    }

    /// The pane's body below its title band: where the wave runs.
    var bodyRect: CGRect {
        let pane = paneRect
        let band = min(pane.height, Self.chromeHeight * zoom)
        return CGRect(x: pane.minX, y: pane.minY + band, width: pane.width, height: max(0, pane.height - band))
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let surface = SkeletonPalette.srgb(palette.surface), let band = SkeletonPalette.srgb(palette.band),
              let ink = SkeletonPalette.srgb(palette.ink), let border = SkeletonPalette.srgb(palette.border) else { return }
        let pane = paneRect
        let bandHeight = min(pane.height, Self.chromeHeight * zoom)
        let shape = folded ? CGRect(x: pane.minX, y: pane.minY, width: pane.width, height: bandHeight) : pane
        let path = NSBezierPath(roundedRect: shape.insetBy(dx: 0.5, dy: 0.5), xRadius: Self.paneRadius, yRadius: Self.paneRadius)
        surface.setFill()
        path.fill()
        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        band.setFill()
        CGRect(x: shape.minX, y: shape.minY, width: shape.width, height: bandHeight).fill()
        NSGraphicsContext.restoreGraphicsState()
        border.setStroke()
        path.lineWidth = 1
        path.stroke()
        let font = NSFont.systemFont(ofSize: Self.titleSize * zoom, weight: .semibold)
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .paragraphStyle: style]
        let pad = 12 * zoom
        let lineHeight = ceil(font.ascender - font.descender)
        let titleRect = CGRect(
            x: shape.minX + pad, y: shape.minY + (bandHeight - lineHeight) / 2,
            width: max(0, shape.width - 2 * pad), height: lineHeight
        )
        (title as NSString).draw(with: titleRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
    }

    override func setFrameSize(_ newSize: NSSize) {
        let moved = newSize != frame.size
        super.setFrameSize(newSize)
        if moved { needsDisplay = true }
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        wave.frame = folded ? .zero : bodyRect
        CATransaction.commit()
    }

    /// The skeleton is on screen now, or no longer: a loading skeleton's
    /// wave runs from its `wavesAfterFrames`th display frame on screen, and
    /// stops when it leaves the screen.
    func setOnScreen(_ onScreen: Bool) {
        guard let delay = wavesAfterFrames else { return }
        if !onScreen {
            waveLink?.invalidate()
            waveLink = nil
            stopWave()
            return
        }
        guard waveLink == nil, !waveRunning else { return }
        onScreenWall = Date().timeIntervalSince1970 * 1000
        waveWall = nil
        var frames = 0
        let tick = StageTick { [weak self] link in
            frames += 1
            guard frames >= delay else { return }
            link.invalidate()
            guard let self else { return }
            self.waveLink = nil
            self.startWave()
        }
        let link = displayLink(target: tick, selector: #selector(StageTick.fire(_:)))
        link.add(to: .main, forMode: .common)
        waveLink = link
    }

    /// A running wave whose layer was moved with its view to a new parent
    /// keeps running: its animation is put back if the move took it off.
    func keepWave() {
        guard waveRunning, wave.animation(forKey: "wave") == nil else { return }
        waveRunning = false
        let wall = waveWall
        startWave()
        waveWall = wall
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { setOnScreen(false) }
    }

    private func tintWave() {
        guard let ink = SkeletonPalette.srgb(palette.ink)?.cgColor else { return }
        let clear = ink.copy(alpha: 0) ?? ink
        let lit = ink.copy(alpha: 0.08) ?? ink
        wave.colors = [clear, lit, clear]
    }

    private func startWave() {
        guard let layer, !folded else { return }
        if wave.superlayer == nil { layer.addSublayer(wave) }
        needsLayout = true
        layoutSubtreeIfNeeded()
        wave.isHidden = false
        let sweep = CABasicAnimation(keyPath: "locations")
        sweep.fromValue = [-1.0, -0.5, 0.0]
        sweep.toValue = [1.0, 1.5, 2.0]
        sweep.duration = Self.waveSeconds
        sweep.repeatCount = .infinity
        wave.add(sweep, forKey: "wave")
        waveRunning = true
        waveWall = Date().timeIntervalSince1970 * 1000
    }

    private func stopWave() {
        wave.removeAnimation(forKey: "wave")
        wave.isHidden = true
        waveRunning = false
    }
}

/// A display-link target calling back on each frame.
final class StageTick: NSObject {
    private let tick: (CADisplayLink) -> Void
    init(_ tick: @escaping (CADisplayLink) -> Void) { self.tick = tick }
    @objc func fire(_ link: CADisplayLink) { tick(link) }
}

/// A card's picture where it stands: its skeleton or its last frame, at the
/// card's view rect and stacking order. Over a body it stands in the body's
/// container above the page; for a card with no body it stands alone in its
/// stage. Answers no point.
final class StageCardPicture: NSView, StackedView {
    let kind: StagePicture
    var order = 0
    let serial: Int
    /// The view drawing it: a `StageSkeletonView`, or the host's cover view.
    let content: NSView
    /// When it first stood on screen, media time; nil until then.
    var onScreenSince: CFTimeInterval?
    /// Its horizon, armed once it stood on screen over a painted page.
    var horizon: DispatchWorkItem?
    override var isFlipped: Bool { true }

    init(kind: StagePicture, content: NSView, frame: NSRect, serial: Int) {
        self.kind = kind
        self.content = content
        self.serial = serial
        super.init(frame: frame)
        wantsLayer = true
        content.frame = bounds
        content.autoresizingMask = [.width, .height]
        addSubview(content)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    var skeleton: StageSkeletonView? { content as? StageSkeletonView }

    /// The picture leaves: its wave and its horizon with it.
    func takeDown() {
        horizon?.cancel()
        horizon = nil
        skeleton?.setOnScreen(false)
        removeFromSuperview()
    }
}

// MARK: - Stages

/// One workspace's cards above the shell's page: their containers, and the
/// pictures standing alone for cards with no body. The host view's stage
/// views stack beneath every rail view. Hidden by opacity, never `isHidden`,
/// so a page made ahead in a hidden stage still runs its frames and paints;
/// a page that has been shown is hidden by its own container. Answers no
/// point of its own: the host view hit-tests the cards inside it.
final class StageView: NSView, StackedView {
    /// Beneath every rail view and every card stacked in the host view.
    var order: Int { Int.min / 2 }
    let serial: Int
    override var isFlipped: Bool { true }

    init(frame: NSRect, serial: Int) {
        self.serial = serial
        super.init(frame: frame)
        wantsLayer = true
        autoresizingMask = [.width, .height]
        layer?.opacity = 0
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Whether this stage is the one on screen.
    var isShown: Bool { (layer?.opacity ?? 0) > 0 }
}

/// A workspace's stage: its view above the shell's page, its ground beneath,
/// and what it was last placed with.
final class Stage {
    let id: String
    var theme: String?
    var focusedCardId: String?
    let view: StageView
    /// Nil until a palette for its theme, or the on-screen one, is known.
    var ground: StageGroundView?
    /// Pictures standing alone in the stage, for cards with no body, by card.
    var alone: [String: StageCardPicture] = [:]

    init(space: StageSpace, view: StageView) {
        id = space.id
        theme = space.theme
        focusedCardId = space.focusedCardId
        self.view = view
    }
}

/// Where a cut came from ([P06]): the host's own Window menu row, a body
/// page's `activate-space` (the Workspaces card), or the shell — carrying
/// the serial of the host cut it echoes, or none for an activation that
/// began in the shell.
enum CutDoor: Equatable {
    case menu
    case page
    case shell(serial: Int?)

    var name: String {
        switch self {
        case .menu: "menu"
        case .page: "page"
        case .shell: "shell"
        }
    }

    /// Whether the host began this cut, and so tells the shell of it.
    var hostOriginated: Bool {
        if case .shell = self { return false }
        return true
    }
}

/// What the stage set says to a cut asked for ([P06]).
enum CutAdmission: Equatable {
    /// Cut now, with this serial.
    case cut(serial: Int)
    /// Not now, for the reason named; nothing moves.
    case ignored(String)
    /// The shell has switched onto a workspace the host holds no stage for
    /// yet — one just made — and the cut is made when a placement names it.
    case pending
}

/// Every workspace's stage, in the placement's list order, and which one is
/// shown. The views go in `hostView` (stages) and `grounds` (their grounds);
/// a stage is made when a placement first names its workspace and goes when
/// one no longer does.
final class StageSet {
    /// One record of a stage cut, for the harness's `stages` account.
    struct Cut {
        var serial: Int?
        var from: String?
        var to: String
        var door: String
        var gestureWall: Double
        var committedWall: Double
        var pictures: [String: String]

        var json: JSONValue {
            .object([
                "serial": serial.map { .number(Double($0)) } ?? .null,
                "from": from.map(JSONValue.string) ?? .null,
                "to": .string(to),
                "door": .string(door),
                "gestureWall": .number(gestureWall),
                "committedWall": .number(committedWall),
                "pictures": .object(pictures.mapValues(JSONValue.string)),
            ])
        }
    }

    static let accountLength = 16

    private unowned let hostView: NSView
    private unowned let grounds: StageGroundHostView
    private let palettes: ThemePalettes
    private let nextSerial: () -> Int
    private(set) var order: [String] = []
    private(set) var byId: [String: Stage] = [:]
    private(set) var activeId: String?
    /// A cut is in its transaction now: a last frame's snapshot waits it out.
    private(set) var cutting = false
    private(set) var cuts: [Cut] = []
    /// The last cut's serial: every cut takes the next.
    private(set) var cutSerial = 0
    /// The serial of the host cut last told to the shell, until the shell
    /// echoes it or reloads: while it stands, a switch that began in the
    /// shell is the shell's, made before it read the host's, and is not
    /// followed ([P06]).
    private(set) var toldSerial: Int?

    init(hostView: NSView, grounds: StageGroundHostView, palettes: ThemePalettes, nextSerial: @escaping () -> Int) {
        self.hostView = hostView
        self.grounds = grounds
        self.palettes = palettes
        self.nextSerial = nextSerial
    }

    var stages: [Stage] { order.compactMap { byId[$0] } }
    var active: Stage? { activeId.flatMap { byId[$0] } }

    func stage(_ id: String?) -> Stage? { id.flatMap { byId[$0] } }

    /// Stand a stage for every workspace `spaces` names, in its order, and
    /// let go of each it no longer names. Each stage takes its workspace's
    /// theme and focused card. Returns the stages let go, whose pictures the
    /// caller has taken down.
    @discardableResult
    func sync(_ spaces: [StageSpace]) -> [Stage] {
        var dropped: [Stage] = []
        let named = Set(spaces.map(\.id))
        for id in order where !named.contains(id) {
            guard let stage = byId.removeValue(forKey: id) else { continue }
            stage.view.removeFromSuperview()
            stage.ground?.removeFromSuperview()
            dropped.append(stage)
            if activeId == id { activeId = nil }
        }
        for space in spaces {
            if let stage = byId[space.id] {
                let themeMoved = stage.theme != space.theme
                stage.theme = space.theme
                stage.focusedCardId = space.focusedCardId
                if themeMoved { wear(stage) }
                continue
            }
            let view = StageView(frame: hostView.bounds, serial: nextSerial())
            hostView.addSubview(view)
            let stage = Stage(space: space, view: view)
            byId[space.id] = stage
            wear(stage)
        }
        order = spaces.map(\.id)
        return dropped
    }

    /// Show `id`'s stage and hide the rest, its ground with it: the caller
    /// holds the transaction. False when `id` is already shown or has no stage.
    @discardableResult
    func show(_ id: String) -> Bool {
        guard id != activeId, let stage = byId[id] else { return false }
        activeId = id
        for other in byId.values where other !== stage {
            other.view.layer?.opacity = 0
            other.ground?.isHidden = true
        }
        stage.view.layer?.opacity = 1
        stage.ground?.isHidden = false
        return true
    }

    /// Mark the cut's transaction open or closed.
    func setCutting(_ cutting: Bool) { self.cutting = cutting }

    /// Whether a cut onto `spaceId` through `door` is made, and with what
    /// serial ([P06]). The shell's echo of a host cut is never one, and
    /// clears the told serial it answers; a switch that began in the shell
    /// is followed only while no host cut's word is outstanding. Every
    /// workspace a placement names has a stage, so one with none is either
    /// the shell's just-made workspace, its placement still to come, or no
    /// workspace at all.
    func admit(_ spaceId: String, door: CutDoor) -> CutAdmission {
        if case .shell(let serial?) = door {
            if toldSerial == serial { toldSerial = nil }
            return .ignored("echo")
        }
        if case .shell(nil) = door, toldSerial != nil { return .ignored("host cut outstanding") }
        if spaceId == activeId { return .ignored("already active") }
        guard byId[spaceId] != nil else {
            if case .shell = door { return .pending }
            return .ignored("unknown space")
        }
        cutSerial += 1
        return .cut(serial: cutSerial)
    }

    /// The host told the shell of cut `serial`.
    func told(_ serial: Int) { toldSerial = serial }

    /// The shell page reloaded: no word it was told is coming back.
    func shellReloaded() { toldSerial = nil }

    /// Keep `cut` in the account, the last `accountLength` only.
    func record(_ cut: Cut) {
        cuts.append(cut)
        if cuts.count > Self.accountLength { cuts.removeFirst(cuts.count - Self.accountLength) }
    }

    /// A palette arrived: every stage's ground wears its theme's palette,
    /// standing one where none stood. Before any stage, the boot ground wears
    /// the on-screen palette.
    func paletteArrived() {
        if byId.isEmpty {
            if let onScreen = palettes.onScreen { grounds.show(onScreen) }
            return
        }
        for stage in byId.values { wear(stage) }
    }

    /// The palette `stage` draws in now.
    func palette(of stage: Stage) -> SkeletonPalette? { palettes.palette(for: stage.theme) }

    private func wear(_ stage: Stage) {
        guard let palette = palettes.palette(for: stage.theme) else { return }
        if let ground = stage.ground {
            ground.wear(palette)
            return
        }
        guard let made = grounds.makeGround(palette) else { return }
        made.isHidden = stage.id != activeId
        stage.ground = made
        grounds.dropBoot()
    }
}
