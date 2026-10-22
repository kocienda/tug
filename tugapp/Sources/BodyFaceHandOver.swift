import AppKit

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

/// The face hand-over: when a placement takes down a view over a card
/// arriving, the card's face stands in its place, drawn from its stand-in's
/// display list, until the shell's own frame with the live stand-ins is on
/// screen. It owns the faces standing, the hand-over pending, and the
/// account the harness reads; the controller hands it each placement.
final class BodyFaceHandOver {
    /// One hand-over's account, for the harness (`handOvers`): what it
    /// planned, how long the shell's snapshot took to answer — how long its
    /// faces stood before they began to retire — how it ended, and each
    /// face's title-band ink as the snapshot drew the shell beneath them.
    struct Record {
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
    private struct Pending {
        let serial: Int
        let plan: HandOverPlan
        /// When the placement that first stood its faces did: its horizon
        /// runs from here, however many hand-overs supersede it.
        let start: CFTimeInterval
    }

    /// How long a hand-over waits on the shell's snapshot before its faces
    /// retire regardless ([L33]): the placer's own landing guard.
    static let deadlineMs = 250
    /// How many host frames a landed hand-over's faces stand past the
    /// snapshot's answer: the shell's frame it answered for, presented.
    static let faceRetireFrames = 2
    /// How many hand-overs the account keeps, oldest dropped first.
    private static let accountLength = 16

    private unowned let controller: BodyViewController
    private unowned let window: MainWindow

    /// The last hand-over's serial; each takes the next.
    private var latest = 0
    private var records: [Record] = []
    private var pending: Pending?
    /// The faces standing now, by card.
    private var faces: [String: BodyFaceView] = [:]
    /// Counting the host frames to a landed hand-over's retirement.
    private var retireLink: CADisplayLink?

    init(controller: BodyViewController, window: MainWindow) {
        self.controller = controller
        self.window = window
    }

    private var hostView: BodyHostView { controller.hostView }

    /// The cards whose faces stand now, in card-id order.
    var standing: [String] { faces.keys.sorted() }

    /// Whether `cardId`'s face stands now.
    func isStanding(_ cardId: String) -> Bool {
        faces[cardId] != nil
    }

    /// The last hand-overs, oldest first, and the faces standing now.
    func account() -> JSONValue {
        .object([
            "handOvers": .array(records.map(\.json)),
            "standing": .array(standing.map(JSONValue.string)),
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
    func handOver(_ plan: HandOverPlan, _ placement: PlaceCards) {
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
        if let pending {
            if BodyHandOver.continues(pending: pending.plan, next: plan) { return }
            setOutcome(pending.serial, "superseded")
            if !faces.isEmpty { start = pending.start }
        }
        let scale = window.backingScaleFactor
        for face in plan.faces {
            guard let entry = named[face.cardId], let draw = entry.faceDraw else { continue }
            // A card whose own page is on screen needs no face, and no later
            // show would take one down.
            if let body = controller.body(forCard: face.cardId), body.visible, body.canShow { continue }
            let view: BodyFaceView
            if let standing = faces[face.cardId] {
                view = standing
            } else {
                view = BodyFaceView(cardId: face.cardId, serial: controller.nextSerial())
                hostView.addSubview(view)
                faces[face.cardId] = view
            }
            view.frame = face.rect
            view.order = Int(entry.z)
            view.draw(draw, scale: scale)
        }
        controller.sortStacking()
        // A newer hand-over owns every face standing: a retirement counting
        // for an older one stops.
        retireLink?.invalidate()
        retireLink = nil
        latest += 1
        let serial = latest
        pending = Pending(serial: serial, plan: plan, start: start)
        records.append(Record(
            serial: serial,
            leaving: plan.leaving,
            handedOver: plan.handedOver,
            faces: plan.faces.map(\.cardId),
            snapshotMs: nil,
            outcome: "pending",
            faceInk: [:]
        ))
        if records.count > Self.accountLength {
            records.removeFirst(records.count - Self.accountLength)
        }
        let remaining = max(0, Double(Self.deadlineMs) / 1000 - (CACurrentMediaTime() - start))
        DispatchQueue.main.asyncAfter(deadline: .now() + remaining) { [weak self] in
            guard let self, self.pending?.serial == serial else { return }
            self.pending = nil
            self.setOutcome(serial, "deadline")
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
    /// the live stand-ins has rendered. Record what it took, and retire the
    /// faces two host frames on; with no image, retire them at once. What it
    /// drew beneath each face is read only for the harness, after the retire
    /// is armed and off its turn (`measureFaceInk`).
    private func snapshotAnswered(serial: Int, ms: Double, image: CGImage?, union: CGRect, entries: [CardPlacementEntry]) {
        guard pending?.serial == serial else { return }
        pending = nil
        let index = records.firstIndex(where: { $0.serial == serial })
        if let index { records[index].snapshotMs = ms }
        guard let image else {
            if let index { records[index].outcome = "failed" }
            TugLog.warn("bodies", "hand-over snapshot failed", [TugLog.field("serial", serial)])
            retireFaces()
            return
        }
        if let index { records[index].outcome = "landed" }
        TugLog.info("bodies", "hand-over", [
            TugLog.field("serial", serial),
            TugLog.field("snapshot_ms", Int(ms.rounded())),
            TugLog.field("faces", faces.count),
        ])
        var frames = 0
        let tick = RailSpringTick { [weak self] link in
            guard let self, link === self.retireLink, self.latest == serial else {
                link.invalidate()
                return
            }
            frames += 1
            if frames >= Self.faceRetireFrames { self.retireFaces() }
        }
        let link = hostView.displayLink(target: tick, selector: #selector(RailSpringTick.fire(_:)))
        link.add(to: .main, forMode: .common)
        retireLink = link
        if Self.harnessReadsInk {
            DispatchQueue.main.async { [weak self] in
                self?.measureFaceInk(serial: serial, image: image, union: union, entries: entries)
            }
        }
    }

    /// Whether a harness is attached to read `faceInk` (`handOvers`): the
    /// only reader, so the product never pays for it.
    private static let harnessReadsInk = ProcessInfo.processInfo.environment["TUGAPP_TEST_SOCKET"] != nil

    /// The title-band ink the shell's snapshot drew beneath each face of
    /// hand-over `serial`, for the harness (row 44): its own turn, after the
    /// faces' retire is armed, so the measurement never holds the hand-over.
    private func measureFaceInk(serial: Int, image: CGImage, union: CGRect, entries: [CardPlacementEntry]) {
        guard let index = records.firstIndex(where: { $0.serial == serial }) else { return }
        let scale = CGFloat(image.width) / max(union.width, 1)
        var ink: [String: Double] = [:]
        for entry in entries {
            let rect = entry.view.cgRect
            guard let crop = image.cropping(to: BodyHandOver.cropRect(of: rect, in: union, scale: scale)) else { continue }
            let band = BodyHandOver.titleBand(viewSize: rect.size, insets: entry.insets, scale: scale)
            ink[entry.cardId] = BodyHandOver.inkShare(image: crop, band: band)
        }
        records[index].faceInk = ink
    }

    private func setOutcome(_ serial: Int, _ outcome: String) {
        guard let index = records.firstIndex(where: { $0.serial == serial }) else { return }
        records[index].outcome = outcome
    }

    /// Every face goes, at once, and the live stand-ins beneath them show.
    func retireFaces() {
        retireLink?.invalidate()
        retireLink = nil
        guard !faces.isEmpty else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for cardId in Array(faces.keys) { removeFace(cardId) }
        CATransaction.commit()
    }

    /// Take `cardId`'s face down, within the caller's transaction.
    func removeFace(_ cardId: String) {
        faces.removeValue(forKey: cardId)?.removeFromSuperview()
    }

    /// The window is going: a hand-over in flight ends with it — its answer,
    /// horizon and retirement find a serial moved on — and every face goes.
    func endAll() {
        latest += 1
        pending = nil
        retireFaces()
    }
}
