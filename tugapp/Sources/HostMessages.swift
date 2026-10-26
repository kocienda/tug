import Foundation

/// The host's twin of the page's host vocabulary (`tugdeck/src/host/`).
///
/// Every message a page posts is named here once, with whether only the
/// shell may post it, and decoded here once, from the JSON string the page
/// posts (`postToHost` in `host/channel.ts`): each decodes into its
/// `Decodable` struct or is refused whole. Every message the host sends a
/// page is named here too, as the `window.__tugBridge` member that receives
/// it (`ToPage`), and so is every call the host awaits (`PageCall`) with the
/// reply it reads (`PageReply`); each renders the one script that delivers
/// it from an `Encodable` payload. `TugTests/HostChannelTests.swift` checks
/// this file against the parity fixture the page's registry writes, so the
/// two sides cannot list different names or disagree about a sample.
///
/// Foundation-only, so `TugTests` compiles it. Logging a refusal and naming
/// the page that sent a message are `HostChannel.swift`'s.

// MARK: - The geometry family
//
// Every message the body controller reads or writes is typed field by field,
// with the field names the page's codec uses (`host/declarations/geometry.ts`,
// `lifecycle.ts`). A field the writer always writes is required; one it can
// omit is optional here too, and its handler names the default once. A
// payload that does not decode is refused whole.

/// A payload with nothing in it: `{}`. Anything but an object is refused,
/// which the synthesized decode, asking for no container, would not do.
struct EmptyPayload: Codable, Equatable {
    private enum CodingKeys: CodingKey {}

    init() {}

    init(from decoder: Decoder) throws {
        _ = try decoder.container(keyedBy: CodingKeys.self)
    }
}

extension KeyedDecodingContainer {
    /// A field the writer always writes, as a value or a null. Absent is
    /// refused, as the page's `nullable` codec refuses it; the synthesized
    /// decode of an optional would read it as nil.
    func decodeValueOrNull<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        guard contains(key) else {
            throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "no \(key.stringValue)"))
        }
        return try decodeNil(forKey: key) ? nil : decode(type, forKey: key)
    }
}

/// A JSON object, carried as is: a body's intent, which the body reads.
struct JSONObject: Codable, Equatable {
    var fields: [String: JSONValue]

    init(_ fields: [String: JSONValue]) {
        self.fields = fields
    }

    init(from decoder: Decoder) throws {
        fields = try decoder.singleValueContainer().decode([String: JSONValue].self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(fields)
    }

    subscript(key: String) -> JSONValue? { fields[key] }
}

/// A card's pane within its view, points per side.
struct CardInsets: Codable, Equatable {
    var top: Double
    var right: Double
    var bottom: Double
    var left: Double
}

/// A card's stand-in read into a short display list (`lib/face-draw.ts`):
/// what the host draws a face from while it hands a departing view over.
/// Rects are within the card's view, points; colours are `rgba()`.
struct FaceDraw: Decodable, Equatable {
    struct Border: Decodable, Equatable {
        var width: Double
        var color: String
    }

    struct Box: Decodable, Equatable {
        var rect: PlanRect
        var fill: String?
        var border: Border?
        var radius: Double
    }

    struct Font: Decodable, Equatable {
        var family: String
        var size: Double
        var weight: Double
    }

    struct Text: Decodable, Equatable {
        var rect: PlanRect
        var text: String
        var font: Font
        var color: String
    }

    struct Image: Decodable, Equatable {
        var rect: PlanRect
        /// Standalone SVG markup, every paint written in.
        var svg: String
    }

    /// The painted boxes, in paint order.
    var boxes: [Box]
    /// The runs of text, in paint order, over every box.
    var texts: [Text]
    /// The icons, over every box.
    var images: [Image]
}

/// One card in `placeCards`: its pane rect, its view and the pane's insets
/// within it, whether it shows, and what the hand carries it by.
struct CardPlacementEntry: Decodable, Equatable {
    var cardId: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    /// The card's view: the pane outset by the apron, grown to whole points.
    var view: PlanRect
    var insets: CardInsets
    /// The shell's own controls over the view (the place seams): points the
    /// host keeps for the shell.
    var shell: [PlanRect]
    var visible: Bool
    /// Present, and true, for an inactive card of a pane.
    var sibling: Bool?
    /// Present, and true, for a card hidden only because its page cannot
    /// show yet: the shell paints its stand-in, which a hand-over's face
    /// covers while a departing view goes (`BodyHandOver`).
    var face: Bool?
    /// What a face entry's face draws: its stand-in as the shell read it.
    var faceDraw: FaceDraw?
    /// The pane's computed `z-index`.
    var z: Double
    var grips: [ResizeEdge]
    var free: Bool
    var min: PlannedCard.Size
    /// The tallest a resize may make the pane, layout px, where the
    /// arrangement holds a ceiling the canvas does not (a slot's run).
    var maxHeight: Double?
    /// The plan whose landing this view is, while the host carries the card
    /// there: a placement naming a running plan leaves its beats alone, and
    /// one naming none takes the card from them.
    var planId: Int?
    /// The card's pane is a pinned rail member: its side, its order there,
    /// and how its content follows a width drag.
    var rail: RailMembership?
    /// An imposed content card's travel under a rail width change; absent
    /// for a rail member and for a free pane.
    var railTravel: RailTravel?

    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// Which edge of the deck a rail is pinned to.
enum RailSide: String, Codable, Equatable {
    case left, right
}

/// A pinned rail member's place on its side.
struct RailMembership: Decodable, Equatable {
    var side: RailSide
    /// The member's order on the side, top to bottom.
    var index: Int
}

/// What an imposed card's horizontal place depends on besides the rail
/// (`rail-width.ts`'s `RailTravel`): a fit card's travel fraction of the
/// band's slack over its slot width, or a flow card on the strip.
enum RailTravel: Decodable, Equatable {
    case fit(fraction: Double, slotWidth: Double)
    case flow

    private enum CodingKeys: String, CodingKey { case kind, fraction, slotWidth }
    private enum Kind: String, Decodable { case fit, flow }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .kind) {
        case .fit:
            self = .fit(fraction: try c.decode(Double.self, forKey: .fraction), slotWidth: try c.decode(Double.self, forKey: .slotWidth))
        case .flow:
            self = .flow
        }
    }
}

/// The widths a rail may stand at, layout px.
struct RailWidthLimits: Decodable, Equatable {
    var min: Double
    var max: Double
}

/// Each standing rail's bounds; a side with no rail is absent.
struct RailLimitsBySide: Decodable, Equatable {
    var left: RailWidthLimits?
    var right: RailWidthLimits?
}

/// The band and the flow strip as a measurement read them: what a carried
/// card's travel is a function of.
struct RailTravelBand: Decodable, Equatable {
    struct Flow: Decodable, Equatable {
        var offset: Double
        var strip: Double
    }

    var band: Double
    var flow: Flow?
}

/// The `placeCards` message body: every card, in the deck's reading order,
/// and the canvas they stand on.
struct PlaceCards: Decodable, Equatable {
    var apron: Double
    /// The canvas's viewport rect; nil when the shell shows none.
    var canvas: PlanRect?
    var zoom: Double
    /// The deck's live card gap, layout px: what an Option-snap leaves
    /// between two adjacent card edges, so a hand-snapped pane lands on the
    /// imposer's rhythm.
    var gap: Double
    var cards: [CardPlacementEntry]
    /// Each standing rail's width bounds, layout px.
    var rails: RailLimitsBySide
    /// The band and the flow strip, layout px.
    var band: RailTravelBand
    /// The cards the host is holding while the shell's rail width draft
    /// holds them; the host leaves every body this names where it stands.
    var held: [String]?
}

/// What a card's gesture is: a drag, a resize, or a rail's edge.
enum CardGestureKind: String, Codable, Equatable {
    case move, resize, rail
}

/// `cardGesture`: a card's page has taken a title-bar or grip press for the
/// host to carry.
struct CardGestureBegin: Decodable, Equatable {
    enum Phase: String, Decodable, Equatable {
        case begin
    }

    var phase: Phase
    var kind: CardGestureKind
    var edge: ResizeEdge?
    /// Where the press landed, in the page's viewport.
    var x: Double
    var y: Double
    var meta: Bool
    var alt: Bool
    /// A rail's edge: how long a release past a limit springs back, ms, at
    /// the page's timing scale; 0 or absent for none.
    var springMs: Double?
}

/// `crossingReady` and `bodySurface`: the page's own surface as sRGB bytes,
/// or nil when it paints none. Anything but four bytes is refused.
struct BodySurface: Decodable, Equatable {
    var surface: [Double]?

    private enum CodingKeys: String, CodingKey { case surface }

    init(surface: [Double]?) {
        self.surface = surface
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.surface) else {
            throw DecodingError.keyNotFound(CodingKeys.surface, .init(codingPath: [], debugDescription: "no surface"))
        }
        let bytes = try container.decode([Double]?.self, forKey: .surface)
        if let bytes, bytes.count != 4 || bytes.contains(where: { !(0...255).contains($0) }) {
            throw DecodingError.dataCorruptedError(
                forKey: .surface, in: container, debugDescription: "not four bytes"
            )
        }
        surface = bytes
    }
}

/// `bodyCreate`: the shell asks for a card's body. `guardsClose`: the kind
/// may veto its close, which only its page can answer.
struct BodyCreate: Decodable, Equatable {
    var cardId: String
    var componentId: String
    var intent: JSONObject
    var guardsClose: Bool?
}

/// `bodyDestroy`: the shell is done with a card's body.
struct BodyDestroy: Decodable, Equatable {
    var cardId: String
    var save: Bool
}

/// `bodyDelays`: the harness's seam on the host's body clocks, never sent by
/// the product — how long a hidden body waits before it is declared dormant,
/// how long it keeps its process, and how long a new page has to say it is
/// ready, ms; nil for the host's own constant.
struct BodyDelays: Decodable, Equatable {
    var dormantAfterMs: Double?
    var evictAfterMs: Double?
    var readyDeadlineMs: Double?
}

/// `bodyFocus`: the card whose body takes the keyboard, or nil for the shell.
struct BodyFocus: Decodable, Equatable {
    var cardId: String?
}

/// `onCardGesture`: where a gesture the host carries stands, told to the shell.
struct CardGestureReport: Codable, Equatable {
    enum Phase: String, Codable, Equatable {
        case move, end, cancel
    }

    struct Point: Codable, Equatable {
        var x: Double
        var y: Double
    }

    /// The guides a step snapped to; an axis that snapped to none is null.
    struct Snap: Codable, Equatable {
        var x: Double?
        var y: Double?

        private enum CodingKeys: String, CodingKey { case x, y }

        init(x: Double?, y: Double?) {
            self.x = x
            self.y = y
        }

        func encode(to encoder: Encoder) throws {
            // Both axes, a null for the one that did not snap: the page's
            // codec reads each as a number or null.
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
        }
    }

    var cardId: String
    var kind: CardGestureKind
    var phase: Phase
    /// The pane's rect, not the apron, in viewport points.
    var rect: PlanRect
    var pointer: Point
    /// Where the press landed.
    var start: Point
    var moved: Bool
    var meta: Bool
    var alt: Bool
    var edge: ResizeEdge?
    var snap: Snap?
    /// A rail's edge: the aim the host drew the rail at, layout px.
    var rail: RailAimReport?
}

/// Where the host has drawn a rail in its width drag: the width a release
/// commits, the width the edge stands at, and the limit it presses past.
struct RailAimReport: Codable, Equatable {
    var width: Double
    var shown: Double
    var limit: String?

    private enum CodingKeys: String, CodingKey { case width, shown, limit }

    init(width: Double, shown: Double, limit: String?) {
        self.width = width
        self.shown = shown
        self.limit = limit
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        width = try c.decode(Double.self, forKey: .width)
        shown = try c.decode(Double.self, forKey: .shown)
        limit = try c.decodeIfPresent(String.self, forKey: .limit)
        if let limit, limit != "floor", limit != "ceiling" {
            throw DecodingError.dataCorruptedError(forKey: .limit, in: c, debugDescription: "not a limit")
        }
    }

    func encode(to encoder: Encoder) throws {
        // The limit as a string or a null: the page's codec reads it so.
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(width, forKey: .width)
        try c.encode(shown, forKey: .shown)
        try c.encode(limit, forKey: .limit)
    }
}

/// `onBodyCrossing`: a crossing's beats begin over the body, or have landed.
struct BodyCrossing: Codable, Equatable {
    enum Phase: String, Codable, Equatable {
        case begin, land
    }

    var phase: Phase
    var width: Double?
    var height: Double?
    var durationMs: Double?
    /// The page is to lay itself out at the crossing size before the motion
    /// starts and say `crossingSolved`; nil for a page kept at its size to
    /// the land.
    var solve: Bool?

    static let land = BodyCrossing(phase: .land)
}

/// `crossingSolved`: the page is laid out at its crossing's size, with the
/// folded form's bottom band in CSS px when the card is folding and has one
/// (`lib/crossing-band.ts`), or where a whole card's picture splits for any
/// other change of height. Both keys must be present, null or not.
struct CrossingSolved: Decodable, Equatable {
    struct Band: Codable, Equatable {
        /// Its top's distance from the viewport's bottom in the open form.
        var restFromBottom: Double
        /// Its top in the folded form.
        var top: Double
        var height: Double
        /// The viewport's height in the folded form.
        var viewport: Double
    }

    struct Anchor: Codable, Equatable {
        /// The row the picture splits at, in the solved form: above it hangs
        /// from the top, below it from the bottom.
        var splitTop: Double
        /// The split is the scroller's top, the content following the
        /// bottom; else the bottom band's top.
        var follows: Bool
        var viewport: Double
    }

    var band: Band?
    var anchor: Anchor?

    private enum CodingKeys: String, CodingKey { case band, anchor }

    init(band: Band?, anchor: Anchor?) {
        self.band = band
        self.anchor = anchor
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.band) else {
            throw DecodingError.keyNotFound(CodingKeys.band, .init(codingPath: [], debugDescription: "no band"))
        }
        guard container.contains(.anchor) else {
            throw DecodingError.keyNotFound(CodingKeys.anchor, .init(codingPath: [], debugDescription: "no anchor"))
        }
        band = try container.decode(Band?.self, forKey: .band)
        anchor = try container.decode(Anchor?.self, forKey: .anchor)
    }
}

/// `onWindowResize`: the window's own resize is bracketed — a live drag of
/// its edge or a full-screen transition began, or ended.
struct WindowResize: Codable, Equatable {
    enum Phase: String, Codable, Equatable {
        case begin, end
    }

    var phase: Phase
}

/// `onPlanStarted`: a solving plan has started — its wall-clock start, ms
/// since 1970, how long its solve took from the plan's receipt, and whether
/// the guard started it rather than the last card's report.
struct PlanStarted: Codable, Equatable {
    var planId: Int
    var startWallMs: Double
    var solveMs: Double
    var timedOut: Bool
}

/// What the host knows of the window when it binds a body.
struct BindFacts: Codable, Equatable {
    var theme: String
    var zoom: Double
    var keyboardAccess: Bool
    var appActive: Bool
}

/// `onBodyBind`: a body is told its card.
struct BodyBind: Codable, Equatable {
    var cardId: String
    var componentId: String
    var intent: JSONObject
    var facts: BindFacts
}

/// `onBodyState`: what the host reports of a body to the shell.
struct BodyStateReport: Codable, Equatable {
    enum State: String, Codable, Equatable {
        case ready, painted, landed, beatsCancelled, failed, terminated, evicted, covered
    }

    enum Start: String, Codable, Equatable {
        case warm, cold
    }

    var cardId: String
    var state: State
    var readyMs: Double?
    var start: Start?
    var planId: Int?
    var lateMs: Double?
    var cause: String?

    init(
        cardId: String, state: State, readyMs: Double? = nil, start: Start? = nil, planId: Int? = nil,
        lateMs: Double? = nil, cause: String? = nil
    ) {
        self.cardId = cardId
        self.state = state
        self.readyMs = readyMs
        self.start = start
        self.planId = planId
        self.lateMs = lateMs
        self.cause = cause
    }
}

/// `onBodyVisibility`: whether the body is shown — its container paints, a
/// sibling's included — and since when, wall-clock ms; and whether the host
/// has declared it dormant, hidden past the dormant delay by the host's own
/// clock. Never dormant while shown.
struct BodyVisibility: Codable, Equatable {
    var shown: Bool
    var since: Double
    var dormant: Bool
}

// MARK: - The host's services
//
// The pickers, the clipboard, the OS, the window's settings, the launch's
// own reports and the frame meter, typed under the geometry family's rule
// with the field names the page's codecs use (`host/declarations/services.ts`,
// `lifecycle.ts`). A host→page payload is encoded from the value its sender
// holds; a field the page reads as a value or null is written as a null,
// never left out.

/// `choosePath`: open a picker, answered with `onPathChosen` under `id`.
struct ChoosePath: Decodable, Equatable {
    /// The panel: `save` names a new file, `insert` takes any file.
    enum Kind: String, Decodable, Equatable {
        case directory, file, save, insert
    }

    var id: String
    var kind: Kind
    /// Where the panel starts; nil for its own default.
    var initialPath: String?
    /// A `save` panel's filename.
    var suggestedName: String?

    private enum CodingKeys: String, CodingKey { case id, kind, initialPath, suggestedName }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(Kind.self, forKey: .kind)
        initialPath = try container.decodeValueOrNull(String.self, forKey: .initialPath)
        suggestedName = try container.decodeValueOrNull(String.self, forKey: .suggestedName)
    }
}

/// `setTheme`: the window's background, as the theme's canvas colour.
struct SetTheme: Decodable, Equatable {
    var color: String
}

/// `clipboardRead`: read the pasteboard, answered with `onClipboardRead`.
struct ClipboardReadRequest: Decodable, Equatable {
    var requestId: String
}

/// `clipboardWrite`: a copy's plain text, its atom sidecar and its rich text,
/// `""` for a flavour it has none of.
struct ClipboardWrite: Decodable, Equatable {
    var text: String
    var atoms: String
    var html: String
}

/// `clipboardWriteImage`: image bytes, base64-encoded.
struct ClipboardWriteImage: Decodable, Equatable {
    var base64: String
}

/// `openPath`: hand a path to the OS.
struct OpenPath: Decodable, Equatable {
    /// `file` opens it in its editor, `folder` in Finder, and `reveal`
    /// selects it in its folder.
    enum Kind: String, Decodable, Equatable {
        case file, folder, reveal
    }

    var path: String
    var kind: Kind
}

/// `lookUpInDictionary`: the selected text, the viewport point of its first
/// character's baseline origin, and the font its callout is redrawn in.
struct DictionaryLookup: Decodable, Equatable {
    var text: String
    var x: Double
    var y: Double
    var fontFamily: String
    /// Layout px; the host scales it by the zoom factor.
    var fontSize: Double
    var bold: Bool
    var italic: Bool
}

/// `spellingGuesses`: a word for the system spell checker, answered with
/// `onSpellingGuesses` under `requestId`.
struct SpellingGuessesRequest: Decodable, Equatable {
    var requestId: String
    var word: String
}

/// `rememberSpelling`: stop flagging `word` — `learn` adds it to the user's
/// dictionary, `ignore` accepts it until the app quits.
struct RememberSpelling: Decodable, Equatable {
    enum Kind: String, Decodable, Equatable {
        case learn, ignore
    }

    var word: String
    var kind: Kind
}

/// `trashPath`: move a file to the Trash, answered with `onTrashResult`.
struct TrashPath: Decodable, Equatable {
    var requestId: String
    var path: String
}

/// `restorePath`: move a trashed file back, answered with `onTrashResult`.
struct RestorePath: Decodable, Equatable {
    var requestId: String
    var trashedPath: String
    var destination: String
}

/// `thumbnailPath`: a QuickLook thumbnail `size` points on an edge,
/// answered with `onThumbnail`.
struct ThumbnailPath: Decodable, Equatable {
    var requestId: String
    var path: String
    var size: Double
}

/// `exportSession`: a session's two renderings, which the save panel's
/// format popup chooses between, answered with `onExportDone` under `id`.
struct ExportSession: Decodable, Equatable {
    var id: String
    /// The default filename, without an extension.
    var baseName: String
    var markdown: String
    var jsonl: String
}

/// `pageZoom` and `onPageZoom`: a zoom factor.
struct PageZoom: Codable, Equatable {
    var factor: Double
}

/// `hostFrames`: meter the window's frames for `windowMs`, answered with
/// `onHostFrames` under `requestId`.
struct HostFramesRequest: Decodable, Equatable {
    var requestId: String
    var windowMs: Double
}

/// `frontendLaunchStalled`: the boot await that ran past its horizon.
struct FrontendLaunchStalled: Decodable, Equatable {
    var waitingOn: String
}

/// `launchLap`: one step of the shell's boot, on the page's clock (ms since
/// its navigation started), with at most one line of detail.
struct LaunchLap: Decodable, Equatable {
    var name: String
    var ms: Double
    var detail: String?
}

/// `hmrUpdate`: an incremental update has landed in the posting page — any
/// page — with Vite's stamp for it (ms since the epoch) and how many modules
/// it carried.
struct HmrUpdate: Decodable, Equatable {
    var viteAt: Double
    var modules: Int
}

/// `pageFault`: what `PageFaultScript` saw, its text, and where (`""` when
/// it said nowhere).
struct PageFault: Decodable, Equatable {
    enum Kind: String, Decodable, Equatable {
        case error, resource, unhandledrejection, stall
        case consoleError = "console.error"
    }

    var kind: Kind
    var message: String
    var source: String
}

/// `onSettingsLoaded`: the maker-mode gate and the source tree, nil when unset.
struct SettingsLoaded: Codable, Equatable {
    var makerMode: Bool
    var sourceTree: String?

    private enum CodingKeys: String, CodingKey { case makerMode, sourceTree }

    init(makerMode: Bool, sourceTree: String?) {
        self.makerMode = makerMode
        self.sourceTree = sourceTree
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        makerMode = try container.decode(Bool.self, forKey: .makerMode)
        sourceTree = try container.decodeValueOrNull(String.self, forKey: .sourceTree)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(makerMode, forKey: .makerMode)
        try container.encode(sourceTree, forKey: .sourceTree)
    }
}

/// `onPathChosen`: the paths a picker chose, in its order, and the first of
/// them as `path` — nil and empty when it was dismissed.
struct PathChosen: Codable, Equatable {
    var id: String
    var path: String?
    var paths: [String]

    private enum CodingKeys: String, CodingKey { case id, path, paths }

    init(id: String, paths: [String]) {
        self.id = id
        self.path = paths.first
        self.paths = paths
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        path = try container.decodeValueOrNull(String.self, forKey: .path)
        paths = try container.decode([String].self, forKey: .paths)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(path, forKey: .path)
        try container.encode(paths, forKey: .paths)
    }
}

/// `onExportDone`: whether the export was written.
struct ExportDone: Codable, Equatable {
    enum Result: String, Codable, Equatable {
        case saved, canceled
    }

    var id: String
    var result: Result
}

/// `onClipboardRead`: the pasteboard's plain text, rich text and atom
/// sidecar, `""` for a flavour it has none of.
struct ClipboardContents: Codable, Equatable {
    var requestId: String
    var text: String
    var html: String
    var atoms: String
}

/// `onSpellingGuesses`: whether the checker flags the word, and its guesses,
/// best first; `[]` when it has none or the word is spelled correctly.
struct SpellingGuessesReply: Codable, Equatable {
    var requestId: String
    var misspelled: Bool
    var guesses: [String]
}

/// `onTrashResult`: where a trashed or restored file went, or why it did
/// not move. `ok` is the tag; a success names the one path its verb made.
enum TrashResult: Codable, Equatable {
    case trashed(requestId: String, trashedPath: String)
    case restored(requestId: String, restoredPath: String)
    case failed(requestId: String, error: String)

    private enum CodingKeys: String, CodingKey { case requestId, ok, trashedPath, restoredPath, error }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let requestId = try container.decode(String.self, forKey: .requestId)
        if try container.decode(Bool.self, forKey: .ok) {
            if let trashedPath = try container.decodeIfPresent(String.self, forKey: .trashedPath) {
                self = .trashed(requestId: requestId, trashedPath: trashedPath)
            } else {
                self = .restored(requestId: requestId, restoredPath: try container.decode(String.self, forKey: .restoredPath))
            }
        } else {
            self = .failed(requestId: requestId, error: try container.decode(String.self, forKey: .error))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .trashed(let requestId, let trashedPath):
            try container.encode(requestId, forKey: .requestId)
            try container.encode(true, forKey: .ok)
            try container.encode(trashedPath, forKey: .trashedPath)
        case .restored(let requestId, let restoredPath):
            try container.encode(requestId, forKey: .requestId)
            try container.encode(true, forKey: .ok)
            try container.encode(restoredPath, forKey: .restoredPath)
        case .failed(let requestId, let error):
            try container.encode(requestId, forKey: .requestId)
            try container.encode(false, forKey: .ok)
            try container.encode(error, forKey: .error)
        }
    }
}

/// `onThumbnail`: a PNG data URL, or nil when QuickLook had nothing — sent
/// all the same, so the page settles rather than timing out.
struct Thumbnail: Codable, Equatable {
    var requestId: String
    var dataUrl: String?

    private enum CodingKeys: String, CodingKey { case requestId, dataUrl }

    init(requestId: String, dataUrl: String?) {
        self.requestId = requestId
        self.dataUrl = dataUrl
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try container.decode(String.self, forKey: .requestId)
        dataUrl = try container.decodeValueOrNull(String.self, forKey: .dataUrl)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(requestId, forKey: .requestId)
        try container.encode(dataUrl, forKey: .dataUrl)
    }
}

/// `onHostFrames`: what the display link read over the window a page asked for.
struct HostFramesReply: Codable, Equatable {
    var requestId: String
    var reading: HostFrameReading
}

/// `onActivationClick`: a click on an inactive window, at its viewport point.
struct ActivationClick: Codable, Equatable {
    var x: Double
    var y: Double
}

/// `onNetworkPath`: the host's network-path hint, `NetworkPathMonitor`'s
/// report. `unknown` is a status this build does not know, which the deck
/// reads as no evidence.
struct NetworkPathReport: Codable, Equatable {
    enum Status: String, Codable, Equatable {
        case satisfied, unsatisfied, requiresConnection, unknown
    }

    var status: Status
    var isExpensive: Bool
    var isConstrained: Bool
}

/// `dictation`: a verb for the session `id`. `start` claims the mic, `stop`
/// truncates, `finish` asks for the settled reading of what was heard.
struct DictationRequest: Codable, Equatable {
    enum Verb: String, Codable, Equatable {
        case start, stop, finish
    }

    var id: String
    var verb: Verb
}

/// `onScrollPhase`: a trackpad scroll's phase edge, posted bare.
enum ScrollPhaseEdge: String, Codable, Equatable {
    /// Fingers down.
    case touched
    /// Fingers up.
    case lifted
    /// The first delta macOS sends on the hand's behalf.
    case momentum
}

/// Every page→host message name, as the page's `WKScriptMessageHandler`
/// names it.
enum ToHostName: String, CaseIterable {
    // Placement and gestures.
    case placeCards, cardGesture, cardPlan
    // The overlay's view.
    case overlayCreate, overlayClaim
    // Page lifecycle.
    case bodyHello, painted, frontendReady, frontendLaunchStalled, launchLap, pageFault
    case crossingReady, crossingSolved, bodySurface, bodyCreate, bodyDestroy, bodyDelays, bodyFocus, hmrUpdate
    // The host's services.
    case sourceTree, choosePath, getSettings, setTheme
    case clipboardRead, clipboardWrite, clipboardWriteImage, menuState
    case openPath, lookUpInDictionary, spellingGuesses, rememberSpelling, trashPath, restorePath, thumbnailPath
    case exportSession, updateAction, dictation, pageZoom, hostFrames

    /// Whether only the shell may post it: the deck's own chrome, the
    /// window's settings, and the commands that direct bodies. `pageZoom` is
    /// not one: the Layout card's Zoom row asks for a level from the Layout
    /// card's own body, and the answer is the window's whole zoom either way.
    var shellOnly: Bool {
        switch self {
        case .sourceTree, .setTheme, .updateAction, .frontendLaunchStalled, .launchLap,
             .bodyCreate, .bodyDestroy, .bodyDelays, .bodyFocus, .hostFrames,
             .cardPlan, .placeCards, .overlayCreate:
            return true
        default:
            return false
        }
    }

    /// Whether only the overlay page may post it: where it takes the pointer.
    var overlayOnly: Bool {
        self == .overlayClaim
    }
}

/// Why a posted message was refused.
enum HostDecodeError: Error, CustomStringConvertible {
    case unknownName(String)
    case notJSON
    case typed(String)

    /// `error`, thrown decoding a typed payload, as the refusal it is: a body
    /// that is not JSON at all is `notJSON`. A bare value no case names fails
    /// at the root too, but with no underlying parse error, and that is a
    /// refusal of the value rather than the JSON.
    init(decoding error: Error) {
        if case DecodingError.dataCorrupted(let context) = error, context.codingPath.isEmpty, context.underlyingError != nil {
            self = .notJSON
        } else {
            self = .typed(String(describing: error))
        }
    }

    var description: String {
        switch self {
        case .unknownName(let name): return "no message is named \(name)"
        case .notJSON: return "the body is not JSON"
        case .typed(let reason): return reason
        }
    }
}

/// One page→host message, decoded.
enum ToHost {
    case placeCards(PlaceCards)
    case cardGesture(CardGestureBegin)
    case cardPlan(CardPlan)
    case overlayCreate
    case overlayClaim(CardHitRegion.Claim)
    case bodyHello
    case painted
    case frontendReady
    case frontendLaunchStalled(FrontendLaunchStalled)
    case launchLap(LaunchLap)
    case pageFault(PageFault)
    case crossingReady(BodySurface)
    case crossingSolved(CrossingSolved)
    case bodySurface(BodySurface)
    case bodyCreate(BodyCreate)
    case bodyDestroy(BodyDestroy)
    case bodyDelays(BodyDelays)
    case bodyFocus(BodyFocus)
    case hmrUpdate(HmrUpdate)
    case sourceTree
    case choosePath(ChoosePath)
    case getSettings
    case setTheme(SetTheme)
    case clipboardRead(ClipboardReadRequest)
    case clipboardWrite(ClipboardWrite)
    case clipboardWriteImage(ClipboardWriteImage)
    case menuState(MenuStatePost)
    case openPath(OpenPath)
    case lookUpInDictionary(DictionaryLookup)
    case spellingGuesses(SpellingGuessesRequest)
    case rememberSpelling(RememberSpelling)
    case trashPath(TrashPath)
    case restorePath(RestorePath)
    case thumbnailPath(ThumbnailPath)
    case exportSession(ExportSession)
    case updateAction(UpdateAction)
    case dictation(DictationRequest)
    case pageZoom(PageZoom)
    case hostFrames(HostFramesRequest)

    /// The message `name` carries in `data`, the UTF-8 of the JSON the page
    /// posted, or why it does not decode.
    static func decode(name: String, data: Data) -> Result<ToHost, HostDecodeError> {
        guard let which = ToHostName(rawValue: name) else { return .failure(.unknownName(name)) }
        do {
            return .success(try typed(which, data))
        } catch {
            return .failure(HostDecodeError(decoding: error))
        }
    }

    /// The message `name` carries in `data`.
    private static func typed(_ name: ToHostName, _ data: Data) throws -> ToHost {
        let decoder = JSONDecoder()
        func read<T: Decodable>(_ type: T.Type) throws -> T { try decoder.decode(type, from: data) }
        switch name {
        case .placeCards: return .placeCards(try read(PlaceCards.self))
        case .cardGesture: return .cardGesture(try read(CardGestureBegin.self))
        case .cardPlan: return .cardPlan(try read(CardPlan.self))
        case .overlayCreate: _ = try read(EmptyPayload.self); return .overlayCreate
        case .overlayClaim: return .overlayClaim(try read(CardHitRegion.Claim.self))
        case .bodyHello: _ = try read(EmptyPayload.self); return .bodyHello
        case .painted: _ = try read(EmptyPayload.self); return .painted
        case .frontendReady: _ = try read(EmptyPayload.self); return .frontendReady
        case .crossingReady: return .crossingReady(try read(BodySurface.self))
        case .crossingSolved: return .crossingSolved(try read(CrossingSolved.self))
        case .bodySurface: return .bodySurface(try read(BodySurface.self))
        case .bodyCreate: return .bodyCreate(try read(BodyCreate.self))
        case .bodyDestroy: return .bodyDestroy(try read(BodyDestroy.self))
        case .bodyDelays: return .bodyDelays(try read(BodyDelays.self))
        case .bodyFocus: return .bodyFocus(try read(BodyFocus.self))
        case .frontendLaunchStalled: return .frontendLaunchStalled(try read(FrontendLaunchStalled.self))
        case .launchLap: return .launchLap(try read(LaunchLap.self))
        case .pageFault: return .pageFault(try read(PageFault.self))
        case .hmrUpdate: return .hmrUpdate(try read(HmrUpdate.self))
        case .sourceTree: _ = try read(EmptyPayload.self); return .sourceTree
        case .choosePath: return .choosePath(try read(ChoosePath.self))
        case .getSettings: _ = try read(EmptyPayload.self); return .getSettings
        case .setTheme: return .setTheme(try read(SetTheme.self))
        case .clipboardRead: return .clipboardRead(try read(ClipboardReadRequest.self))
        case .clipboardWrite: return .clipboardWrite(try read(ClipboardWrite.self))
        case .clipboardWriteImage: return .clipboardWriteImage(try read(ClipboardWriteImage.self))
        case .openPath: return .openPath(try read(OpenPath.self))
        case .lookUpInDictionary: return .lookUpInDictionary(try read(DictionaryLookup.self))
        case .spellingGuesses: return .spellingGuesses(try read(SpellingGuessesRequest.self))
        case .rememberSpelling: return .rememberSpelling(try read(RememberSpelling.self))
        case .trashPath: return .trashPath(try read(TrashPath.self))
        case .restorePath: return .restorePath(try read(RestorePath.self))
        case .thumbnailPath: return .thumbnailPath(try read(ThumbnailPath.self))
        case .exportSession: return .exportSession(try read(ExportSession.self))
        case .pageZoom: return .pageZoom(try read(PageZoom.self))
        case .hostFrames: return .hostFrames(try read(HostFramesRequest.self))
        case .updateAction: return .updateAction(try read(UpdateAction.self))
        case .dictation: return .dictation(try read(DictationRequest.self))
        case .menuState: return .menuState(try read(MenuStatePost.self))
        }
    }
}

// MARK: - Host → page

/// A JSON value: what a body's intent carries, and what a page call's reply
/// is read through on its way to its `Decodable` type.
enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// A value as `JSONSerialization` reads it, or a Foundation value built
    /// for it (`NSNull`, a number, a string, arrays and string-keyed
    /// dictionaries of those); nil when anything in it is none of those.
    init?(any value: Any) {
        switch value {
        case is NSNull:
            self = .null
        case let string as String:
            self = .string(string)
        case let number as NSNumber:
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        case let array as [Any]:
            var values: [JSONValue] = []
            for element in array {
                guard let value = JSONValue(any: element) else { return nil }
                values.append(value)
            }
            self = .array(values)
        case let dictionary as NSDictionary:
            var fields: [String: JSONValue] = [:]
            for (key, element) in dictionary {
                guard let key = key as? String, let value = JSONValue(any: element) else { return nil }
                fields[key] = value
            }
            self = .object(fields)
        default:
            return nil
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let bool): try container.encode(bool)
        case .number(let number): try container.encode(number)
        case .string(let string): try container.encode(string)
        case .array(let array): try container.encode(array)
        case .object(let fields): try container.encode(fields)
        }
    }

    /// The JS expression that evaluates to the value `json` encodes:
    /// `JSON.parse("<value as a JSON string>")`. Serialized twice so any
    /// string, U+2028 and quotes included, survives as a JS string literal.
    static func parseExpression(json: Data) -> String? {
        guard let jsonString = String(data: json, encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: jsonString, options: [.fragmentsAllowed]),
              let quotedString = String(data: quoted, encoding: .utf8) else { return nil }
        return "JSON.parse(\(quotedString))"
    }

    /// The value as Foundation builds it for `JSONSerialization`: `NSNull`,
    /// a number, a string, and arrays and string-keyed dictionaries of those.
    var foundation: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let bool): return bool
        case .number(let number): return number
        case .string(let string): return string
        case .array(let values): return values.map(\.foundation)
        case .object(let fields): return fields.mapValues(\.foundation)
        }
    }
}

/// Every host→page message, as the `window.__tugBridge` member that receives it.
enum ToPageMember: String, CaseIterable {
    // Placement and gestures.
    case onCardGesture, onCardInsets, onBodyCrossing, onWindowResize
    // Page lifecycle.
    case onBodyBind, onBodyState, onBodyVisibility, onPlanStarted
    // The host's services.
    case onSettingsLoaded, onPathChosen, onExportDone, onClipboardRead, onSpellingGuesses, onTrashResult, onThumbnail, onHostFrames
    case onDictation, onUpdateState, onPageZoom, onActivationClick, onNetworkPath, onScrollPhase
}

/// One host→page message, carrying its member's `Encodable` payload.
enum ToPage {
    case cardGesture(CardGestureReport)
    case cardInsets(CardInsets)
    case bodyCrossing(BodyCrossing)
    case windowResize(WindowResize)
    case bodyBind(BodyBind)
    case bodyState(BodyStateReport)
    case bodyVisibility(BodyVisibility)
    case planStarted(PlanStarted)
    case settingsLoaded(SettingsLoaded)
    case pathChosen(PathChosen)
    case exportDone(ExportDone)
    case clipboardRead(ClipboardContents)
    case spellingGuesses(SpellingGuessesReply)
    case trashResult(TrashResult)
    case thumbnail(Thumbnail)
    case hostFrames(HostFramesReply)
    case pageZoom(PageZoom)
    case activationClick(ActivationClick)
    case networkPath(NetworkPathReport)
    case dictation(DictationEvent)
    case updateState(UpdateSnapshot)
    case scrollPhase(ScrollPhaseEdge)

    var member: ToPageMember {
        switch self {
        case .cardGesture: return .onCardGesture
        case .cardInsets: return .onCardInsets
        case .bodyCrossing: return .onBodyCrossing
        case .windowResize: return .onWindowResize
        case .bodyBind: return .onBodyBind
        case .bodyState: return .onBodyState
        case .bodyVisibility: return .onBodyVisibility
        case .planStarted: return .onPlanStarted
        case .settingsLoaded: return .onSettingsLoaded
        case .pathChosen: return .onPathChosen
        case .exportDone: return .onExportDone
        case .clipboardRead: return .onClipboardRead
        case .spellingGuesses: return .onSpellingGuesses
        case .trashResult: return .onTrashResult
        case .thumbnail: return .onThumbnail
        case .hostFrames: return .onHostFrames
        case .pageZoom: return .onPageZoom
        case .activationClick: return .onActivationClick
        case .networkPath: return .onNetworkPath
        case .dictation: return .onDictation
        case .updateState: return .onUpdateState
        case .scrollPhase: return .onScrollPhase
        }
    }

    /// The payload's JSON; nil when it does not encode.
    func payloadJSON() -> Data? {
        let encoder = JSONEncoder()
        switch self {
        case .cardGesture(let report): return try? encoder.encode(report)
        case .cardInsets(let insets): return try? encoder.encode(insets)
        case .bodyCrossing(let crossing): return try? encoder.encode(crossing)
        case .windowResize(let resize): return try? encoder.encode(resize)
        case .bodyBind(let bind): return try? encoder.encode(bind)
        case .bodyState(let report): return try? encoder.encode(report)
        case .bodyVisibility(let visibility): return try? encoder.encode(visibility)
        case .planStarted(let started): return try? encoder.encode(started)
        case .settingsLoaded(let settings): return try? encoder.encode(settings)
        case .pathChosen(let chosen): return try? encoder.encode(chosen)
        case .exportDone(let done): return try? encoder.encode(done)
        case .clipboardRead(let contents): return try? encoder.encode(contents)
        case .spellingGuesses(let reply): return try? encoder.encode(reply)
        case .trashResult(let result): return try? encoder.encode(result)
        case .thumbnail(let thumbnail): return try? encoder.encode(thumbnail)
        case .hostFrames(let reply): return try? encoder.encode(reply)
        case .pageZoom(let zoom): return try? encoder.encode(zoom)
        case .activationClick(let click): return try? encoder.encode(click)
        case .networkPath(let report): return try? encoder.encode(report)
        case .dictation(let event): return try? encoder.encode(event)
        case .updateState(let snapshot): return try? encoder.encode(snapshot)
        case .scrollPhase(let edge): return try? encoder.encode(edge)
        }
    }

    /// The message `member` carries in `data`, the UTF-8 of its JSON payload.
    static func decode(member name: String, data: Data) -> Result<ToPage, HostDecodeError> {
        guard let member = ToPageMember(rawValue: name) else { return .failure(.unknownName(name)) }
        let decoder = JSONDecoder()
        func read<T: Decodable>(_ type: T.Type) throws -> T { try decoder.decode(type, from: data) }
        do {
            switch member {
            case .onCardGesture: return .success(.cardGesture(try read(CardGestureReport.self)))
            case .onCardInsets: return .success(.cardInsets(try read(CardInsets.self)))
            case .onBodyCrossing: return .success(.bodyCrossing(try read(BodyCrossing.self)))
            case .onWindowResize: return .success(.windowResize(try read(WindowResize.self)))
            case .onBodyBind: return .success(.bodyBind(try read(BodyBind.self)))
            case .onBodyState: return .success(.bodyState(try read(BodyStateReport.self)))
            case .onBodyVisibility: return .success(.bodyVisibility(try read(BodyVisibility.self)))
            case .onPlanStarted: return .success(.planStarted(try read(PlanStarted.self)))
            case .onSettingsLoaded: return .success(.settingsLoaded(try read(SettingsLoaded.self)))
            case .onPathChosen: return .success(.pathChosen(try read(PathChosen.self)))
            case .onExportDone: return .success(.exportDone(try read(ExportDone.self)))
            case .onClipboardRead: return .success(.clipboardRead(try read(ClipboardContents.self)))
            case .onSpellingGuesses: return .success(.spellingGuesses(try read(SpellingGuessesReply.self)))
            case .onTrashResult: return .success(.trashResult(try read(TrashResult.self)))
            case .onThumbnail: return .success(.thumbnail(try read(Thumbnail.self)))
            case .onHostFrames: return .success(.hostFrames(try read(HostFramesReply.self)))
            case .onPageZoom: return .success(.pageZoom(try read(PageZoom.self)))
            case .onActivationClick: return .success(.activationClick(try read(ActivationClick.self)))
            case .onNetworkPath: return .success(.networkPath(try read(NetworkPathReport.self)))
            case .onDictation: return .success(.dictation(try read(DictationEvent.self)))
            case .onUpdateState: return .success(.updateState(try read(UpdateSnapshot.self)))
            case .onScrollPhase: return .success(.scrollPhase(try read(ScrollPhaseEdge.self)))
            }
        } catch {
            return .failure(HostDecodeError(decoding: error))
        }
    }

    /// The script that delivers it: `window.__tugBridge?.<member>?.(<payload>)`.
    func script() -> String? {
        guard let json = payloadJSON(), let argument = JSONValue.parseExpression(json: json) else { return nil }
        return "window.__tugBridge?.\(member.rawValue)?.(\(argument))"
    }
}

/// A call the host makes into a page and awaits (`callAsyncJavaScript`).
enum PageCall {
    /// Write every card's state now, synchronously.
    case saveState
    /// The page's half of a quit; the reply is its verdict.
    case prepareForTermination
    /// Tugcast restarted: take its new cookie for `token`, and reconnect.
    case reauthenticate(token: String)
    /// Write the deck root's zoom; resolves once the factor has painted.
    case pageZoomApply(factor: Double)
    /// A rail member's page, as a hand presses its rail's edge: the colours
    /// its deck-facing edge paints in; the reply is `RailEdgeColors`.
    case railEdge

    /// Every call, by its receiver and member, as the page's registry lists them.
    static let declared: [(receiver: String, member: String)] = [
        ("tugdeck", "saveState"),
        ("tugdeck", "prepareForTermination"),
        ("tugdeck", "reauthenticate"),
        ("bridge", "onPageZoomApply"),
        ("bridge", "onRailEdge"),
    ]

    var receiver: String {
        switch self {
        case .saveState, .prepareForTermination, .reauthenticate: return "tugdeck"
        case .pageZoomApply, .railEdge: return "bridge"
        }
    }

    var member: String {
        switch self {
        case .saveState: return "saveState"
        case .prepareForTermination: return "prepareForTermination"
        case .reauthenticate: return "reauthenticate"
        case .pageZoomApply: return "onPageZoomApply"
        case .railEdge: return "onRailEdge"
        }
    }

    /// `reauthenticate`'s payload.
    private struct Token: Encodable {
        var token: String
    }

    /// The payload's JSON; nil when it does not encode.
    func payloadJSON() -> Data? {
        let encoder = JSONEncoder()
        switch self {
        case .saveState, .prepareForTermination, .railEdge: return try? encoder.encode(EmptyPayload())
        case .reauthenticate(let token): return try? encoder.encode(Token(token: token))
        case .pageZoomApply(let factor): return try? encoder.encode(factor)
        }
    }

    /// The body of the async function that makes the call and returns its reply.
    func source() -> String? {
        guard let json = payloadJSON(), let argument = JSONValue.parseExpression(json: json) else { return nil }
        let object = receiver == "tugdeck" ? "window.tugdeck" : "window.__tugBridge"
        return "return await \(object)?.\(member)?.(\(argument));"
    }
}

/// A page's account of its half of a quit (`prepareForTermination`'s reply),
/// with the field names the page's codec uses (`host/declarations/lifecycle.ts`).
struct TerminationVerdict: Decodable, Equatable {
    /// Every phase below came back clean.
    var ok: Bool
    /// Sessions interrupted and observed to settle.
    var interrupted: [String]
    /// Sessions interrupted that had not settled when the bound expired.
    var unacknowledged: [String]
    /// Card bags written and confirmed.
    var flushedCards: Int
    /// Card ids whose writes still failed.
    var failedCards: [String]
    var layoutSaved: Bool
    var elapsedMs: Double
}

/// A rail member's deck-facing edge as its page paints it (`onRailEdge`'s
/// reply): the pane's surface, the border's colour at rest, held and past a
/// limit, each as four sRGB bytes, and the border's width in view points;
/// the shadow the rail casts off it (`rail-shadow.css`), its colour and its
/// reach in view points; and the fill a width drag's ghost paints its
/// footprint in, and the colour of its deck-facing edge.
struct RailEdgeColors: Decodable, Equatable {
    var surface: [Double]
    var rest: [Double]
    var held: [Double]
    var limit: [Double]
    var width: Double
    var shadow: [Double]
    var reach: Double
    var fill: [Double]
    var ghostEdge: [Double]

    private enum CodingKeys: String, CodingKey { case surface, rest, held, limit, width, shadow, reach, fill, ghostEdge }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func bytes(_ key: CodingKeys) throws -> [Double] {
            let value = try c.decode([Double].self, forKey: key)
            guard value.count == 4, value.allSatisfy({ (0...255).contains($0) }) else {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "not four sRGB bytes")
            }
            return value
        }
        surface = try bytes(.surface)
        rest = try bytes(.rest)
        held = try bytes(.held)
        limit = try bytes(.limit)
        shadow = try bytes(.shadow)
        fill = try bytes(.fill)
        ghostEdge = try bytes(.ghostEdge)
        width = try c.decode(Double.self, forKey: .width)
        reach = try c.decode(Double.self, forKey: .reach)
        guard width >= 0, reach >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .width, in: c, debugDescription: "a negative width or reach")
        }
    }
}

/// What a page answers a `PageCall` with.
enum PageReply: Equatable {
    /// Nothing: a call that answers `null`, or a page with no such member,
    /// whose optional call returns nothing.
    case nothing
    /// `prepareForTermination`'s verdict.
    case verdict(TerminationVerdict)
    /// `onRailEdge`'s colours.
    case railEdge(RailEdgeColors)

    /// The reply `member`'s call answered with, from its JSON. Every call
    /// may answer nothing; `prepareForTermination` may answer its verdict
    /// and `onRailEdge` its colours, and any other value is refused.
    static func decode(member: String, data: Data) -> Result<PageReply, HostDecodeError> {
        let decoder = JSONDecoder()
        do {
            if try decoder.decode(NullProbe.self, from: data).isNull { return .success(.nothing) }
            switch member {
            case "prepareForTermination":
                return .success(.verdict(try decoder.decode(TerminationVerdict.self, from: data)))
            case "onRailEdge":
                return .success(.railEdge(try decoder.decode(RailEdgeColors.self, from: data)))
            default:
                return .failure(.typed("\(member) answers nothing, and the page answered a value"))
            }
        } catch {
            return .failure(HostDecodeError(decoding: error))
        }
    }

    /// Whether a JSON value is `null`, decoding any value at all.
    private struct NullProbe: Decodable {
        var isNull: Bool

        init(from decoder: Decoder) throws {
            isNull = try decoder.singleValueContainer().decodeNil()
        }
    }
}
