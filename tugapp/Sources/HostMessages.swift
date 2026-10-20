import Foundation

/// The host's twin of the page's host vocabulary (`tugdeck/src/host/`).
///
/// Every message a page posts is named here once, with whether only the
/// shell may post it, and decoded here once, from the JSON string the page
/// posts (`postToHost` in `host/channel.ts`). A payload the page carries
/// loose arrives as a `HostObject`; a typed one decodes into its `Decodable`
/// struct or is refused whole. Every message the host sends a page is named
/// here too, as the `window.__tugBridge` member that receives it (`ToPage`),
/// and so is every call the host awaits (`PageCall`); each renders the one
/// script that delivers it. `TugTests/HostChannelTests.swift` checks this
/// file against the parity fixture the page's registry writes, so the two
/// sides cannot list different names or disagree about a sample.
///
/// Foundation-only, so `TugTests` compiles it. Logging a refusal and naming
/// the page that sent a message are `HostChannel.swift`'s.

/// A loose payload: a JSON object, carried as `JSONSerialization` reads it.
/// Its fields mean what its handler reads; typing it is a later change.
struct HostObject {
    let fields: [String: Any]

    subscript(key: String) -> Any? { fields[key] }
}

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

/// A whole card's pane within its view, points per side.
struct CardInsets: Codable, Equatable {
    var top: Double
    var right: Double
    var bottom: Double
    var left: Double
}

/// One body's entry in `placeBodies`: a viewport rect and whether it shows.
struct BodyPlacementEntry: Decodable, Equatable {
    var cardId: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var visible: Bool
    /// The pane's resize handles, or a whole card's shell controls over it.
    var grips: [PlanRect]
    /// The pane's computed `z-index`.
    var z: Double
    /// Present, and true, for a card that draws its pane's chrome in its own page.
    var whole: Bool?
    /// Present, and true, for an inactive card of a whole card's pane.
    var sibling: Bool?
    var insets: CardInsets?

    var frame: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// The `placeBodies` message body.
struct PlaceBodies: Decodable, Equatable {
    /// The pane's corner radius, px.
    var radius: Double
    var bodies: [BodyPlacementEntry]
}

/// One whole card in `placeCards`: its pane rect and what the hand carries it by.
struct CardPlacementEntry: Decodable, Equatable {
    var cardId: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var visible: Bool
    var sibling: Bool?
    var z: Double
    var grips: [ResizeEdge]
    var free: Bool
    var min: PlannedBody.Size

    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// The `placeCards` message body: the whole cards, and the canvas they stand on.
struct PlaceCards: Decodable, Equatable {
    var apron: Double
    /// The canvas's viewport rect; nil when the shell shows none.
    var canvas: PlanRect?
    var zoom: Double
    var cards: [CardPlacementEntry]
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
}

/// `cardLand`: a drop the shell committed nothing for.
struct CardLand: Decodable, Equatable {
    var cardId: String
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

/// `bodyCreate`: the shell asks for a card's body.
struct BodyCreate: Decodable, Equatable {
    var cardId: String
    var componentId: String
    var intent: JSONObject
}

/// `bodyDestroy`: the shell is done with a card's body.
struct BodyDestroy: Decodable, Equatable {
    var cardId: String
    var save: Bool
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

    static let land = BodyCrossing(phase: .land)
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

/// `onBodyState`: what the host reports of a body, or of its floor, to the shell.
struct BodyStateReport: Codable, Equatable {
    enum State: String, Codable, Equatable {
        case ready, painted, shown, landed, beatsCancelled, failed, terminated, floorShown
    }

    enum Start: String, Codable, Equatable {
        case warm, cold
    }

    /// Absent only for `floorShown`, which names no card.
    var cardId: String?
    var state: State
    var readyMs: Double?
    var start: Start?
    var planId: Int?
    var lateMs: Double?
    var cause: String?
    var sinceRevealMs: Double?

    init(
        cardId: String?, state: State, readyMs: Double? = nil, start: Start? = nil, planId: Int? = nil,
        lateMs: Double? = nil, cause: String? = nil, sinceRevealMs: Double? = nil
    ) {
        self.cardId = cardId
        self.state = state
        self.readyMs = readyMs
        self.start = start
        self.planId = planId
        self.lateMs = lateMs
        self.cause = cause
        self.sinceRevealMs = sinceRevealMs
    }
}

/// Every page→host message name, as the page's `WKScriptMessageHandler`
/// names it.
enum ToHostName: String, CaseIterable {
    // Placement and gestures.
    case placeBodies, placeCards, cardGesture, cardLand, beatPlan, pointerClaim, floorGrid
    // Page lifecycle.
    case bodyHello, painted, frontendReady, frontendLaunchStalled, pageFault
    case crossingReady, bodySurface, bodyCreate, bodyDestroy, bodyFocus, hmrUpdate
    // The host's services.
    case sourceTree, choosePath, getSettings, setTheme, devBadge
    case clipboardRead, clipboardWrite, clipboardWriteImage, menuState
    case openPath, lookUpInDictionary, trashPath, restorePath, thumbnailPath
    case exportSession, updateAction, dictation, pageZoom, hostFrames

    /// Whether only the shell may post it: the deck's own chrome, the
    /// window's settings, and the commands that direct bodies. `pageZoom` is
    /// not one: the Layout card's Zoom row asks for a level from the Layout
    /// card's own body, and the answer is the window's whole zoom either way.
    var shellOnly: Bool {
        switch self {
        case .sourceTree, .setTheme, .devBadge, .updateAction, .frontendLaunchStalled, .hmrUpdate,
             .bodyCreate, .placeBodies, .bodyDestroy, .bodyFocus, .pointerClaim, .hostFrames,
             .floorGrid, .beatPlan, .placeCards, .cardLand:
            return true
        default:
            return false
        }
    }
}

/// Why a posted message was refused.
enum HostDecodeError: Error, CustomStringConvertible {
    case unknownName(String)
    case notJSON
    case notObject
    case notString
    case typed(String)

    /// `error`, thrown decoding a typed payload, as the refusal it is: a body
    /// that is not JSON at all is `notJSON`, as it is for a loose one.
    init(decoding error: Error) {
        if case DecodingError.dataCorrupted(let context) = error, context.codingPath.isEmpty {
            self = .notJSON
        } else {
            self = .typed(String(describing: error))
        }
    }

    var description: String {
        switch self {
        case .unknownName(let name): return "no message is named \(name)"
        case .notJSON: return "the body is not JSON"
        case .notObject: return "the body is not a JSON object"
        case .notString: return "the body is not a JSON string"
        case .typed(let reason): return reason
        }
    }
}

/// One page→host message, decoded.
enum ToHost {
    case placeBodies(PlaceBodies)
    case placeCards(PlaceCards)
    case cardGesture(CardGestureBegin)
    case cardLand(CardLand)
    case beatPlan(BeatPlan)
    case pointerClaim(BodyHitRegion.Claim)
    case floorGrid(FloorGrid)
    case bodyHello
    case painted
    case frontendReady
    case frontendLaunchStalled(HostObject)
    case pageFault(HostObject)
    case crossingReady(BodySurface)
    case bodySurface(BodySurface)
    case bodyCreate(BodyCreate)
    case bodyDestroy(BodyDestroy)
    case bodyFocus(BodyFocus)
    case hmrUpdate(HostObject)
    case sourceTree(HostObject)
    case choosePath(HostObject)
    case getSettings(HostObject)
    case setTheme(HostObject)
    case devBadge(HostObject)
    case clipboardRead(HostObject)
    case clipboardWrite(HostObject)
    case clipboardWriteImage(HostObject)
    case menuState(HostObject)
    case openPath(HostObject)
    case lookUpInDictionary(HostObject)
    case trashPath(HostObject)
    case restorePath(HostObject)
    case thumbnailPath(HostObject)
    case exportSession(HostObject)
    case updateAction(String)
    case dictation(HostObject)
    case pageZoom(HostObject)
    case hostFrames(HostObject)

    /// The message `name` carries in `data`, the UTF-8 of the JSON the page
    /// posted, or why it does not decode.
    static func decode(name: String, data: Data) -> Result<ToHost, HostDecodeError> {
        guard let which = ToHostName(rawValue: name) else { return .failure(.unknownName(name)) }
        do {
            if let decoded = try typed(which, data) { return .success(decoded) }
        } catch {
            return .failure(HostDecodeError(decoding: error))
        }
        guard let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return .failure(.notJSON)
        }
        if which == .updateAction {
            guard let action = value as? String else { return .failure(.notString) }
            return .success(.updateAction(action))
        }
        guard let fields = value as? [String: Any] else { return .failure(.notObject) }
        return .success(loose(which, HostObject(fields: fields)))
    }

    /// The typed message `name` carries in `data`, or nil when `name` is loose.
    private static func typed(_ name: ToHostName, _ data: Data) throws -> ToHost? {
        let decoder = JSONDecoder()
        func read<T: Decodable>(_ type: T.Type) throws -> T { try decoder.decode(type, from: data) }
        switch name {
        case .placeBodies: return .placeBodies(try read(PlaceBodies.self))
        case .placeCards: return .placeCards(try read(PlaceCards.self))
        case .cardGesture: return .cardGesture(try read(CardGestureBegin.self))
        case .cardLand: return .cardLand(try read(CardLand.self))
        case .beatPlan: return .beatPlan(try read(BeatPlan.self))
        case .pointerClaim: return .pointerClaim(try read(BodyHitRegion.Claim.self))
        case .floorGrid: return .floorGrid(try read(FloorGrid.self))
        case .bodyHello: _ = try read(EmptyPayload.self); return .bodyHello
        case .painted: _ = try read(EmptyPayload.self); return .painted
        case .frontendReady: _ = try read(EmptyPayload.self); return .frontendReady
        case .crossingReady: return .crossingReady(try read(BodySurface.self))
        case .bodySurface: return .bodySurface(try read(BodySurface.self))
        case .bodyCreate: return .bodyCreate(try read(BodyCreate.self))
        case .bodyDestroy: return .bodyDestroy(try read(BodyDestroy.self))
        case .bodyFocus: return .bodyFocus(try read(BodyFocus.self))
        default: return nil
        }
    }

    private static func loose(_ name: ToHostName, _ body: HostObject) -> ToHost {
        switch name {
        case .frontendLaunchStalled: return .frontendLaunchStalled(body)
        case .pageFault: return .pageFault(body)
        case .hmrUpdate: return .hmrUpdate(body)
        case .sourceTree: return .sourceTree(body)
        case .choosePath: return .choosePath(body)
        case .getSettings: return .getSettings(body)
        case .setTheme: return .setTheme(body)
        case .devBadge: return .devBadge(body)
        case .clipboardRead: return .clipboardRead(body)
        case .clipboardWrite: return .clipboardWrite(body)
        case .clipboardWriteImage: return .clipboardWriteImage(body)
        case .menuState: return .menuState(body)
        case .openPath: return .openPath(body)
        case .lookUpInDictionary: return .lookUpInDictionary(body)
        case .trashPath: return .trashPath(body)
        case .restorePath: return .restorePath(body)
        case .thumbnailPath: return .thumbnailPath(body)
        case .exportSession: return .exportSession(body)
        case .dictation: return .dictation(body)
        case .pageZoom: return .pageZoom(body)
        case .hostFrames: return .hostFrames(body)
        case .placeBodies, .placeCards, .cardGesture, .cardLand, .beatPlan, .pointerClaim, .floorGrid,
             .bodyHello, .painted, .frontendReady, .crossingReady, .bodySurface, .bodyCreate,
             .bodyDestroy, .bodyFocus, .updateAction:
            preconditionFailure("\(name.rawValue) is typed, not loose")
        }
    }
}

// MARK: - Host → page

/// A JSON value the host builds for a page: what a loose payload carries.
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
        case let dictionary as [String: Any]:
            var fields: [String: JSONValue] = [:]
            for (key, element) in dictionary {
                guard let value = JSONValue(any: element) else { return nil }
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

    /// `value` as the source of a JS expression that evaluates to it:
    /// `JSON.parse("<value as a JSON string>")`. Serialized twice so any
    /// string, U+2028 and quotes included, survives as a JS string literal.
    var parseExpression: String? {
        guard let json = try? JSONEncoder().encode(self) else { return nil }
        return Self.parseExpression(json: json)
    }

    /// The JS expression that evaluates to the value `json` encodes.
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
    case onCardGesture, onCardInsets, onBodyCrossing
    // Page lifecycle.
    case onBodyBind, onBodyState
    // The host's services.
    case onSettingsLoaded, onDevModeError, onSourceTreeSelected, onSourceTreeCancelled
    case onPathChosen, onExportDone, onClipboardRead, onTrashResult, onThumbnail, onHostFrames
    case onDictation, onUpdateState, onPageZoom, onActivationClick, onNetworkPath, onScrollPhase

    /// Whether the member's payload is one JSON string rather than an object.
    var carriesString: Bool {
        switch self {
        case .onDevModeError, .onSourceTreeSelected, .onScrollPhase: return true
        default: return false
        }
    }

    /// Whether the member's payload is typed field by field: the geometry
    /// family's, which only a typed `ToPage` case carries.
    var typed: Bool {
        switch self {
        case .onCardGesture, .onCardInsets, .onBodyCrossing, .onBodyBind, .onBodyState: return true
        default: return false
        }
    }
}

/// One host→page message. The geometry family's members carry their typed
/// payloads; of the rest, a string member carries its string, and every other
/// member a loose JSON object.
enum ToPage {
    case loose(ToPageMember, JSONValue)
    case text(ToPageMember, String)
    case cardGesture(CardGestureReport)
    case cardInsets(CardInsets)
    case bodyCrossing(BodyCrossing)
    case bodyBind(BodyBind)
    case bodyState(BodyStateReport)

    var member: ToPageMember {
        switch self {
        case .loose(let member, _), .text(let member, _): return member
        case .cardGesture: return .onCardGesture
        case .cardInsets: return .onCardInsets
        case .bodyCrossing: return .onBodyCrossing
        case .bodyBind: return .onBodyBind
        case .bodyState: return .onBodyState
        }
    }

    /// The payload's JSON; nil when it does not encode.
    func payloadJSON() -> Data? {
        let encoder = JSONEncoder()
        switch self {
        case .loose(_, let value): return try? encoder.encode(value)
        case .text(_, let string): return try? encoder.encode(JSONValue.string(string))
        case .cardGesture(let report): return try? encoder.encode(report)
        case .cardInsets(let insets): return try? encoder.encode(insets)
        case .bodyCrossing(let crossing): return try? encoder.encode(crossing)
        case .bodyBind(let bind): return try? encoder.encode(bind)
        case .bodyState(let report): return try? encoder.encode(report)
        }
    }

    /// `member` carrying `value`, a Foundation value built for it (see
    /// `JSONValue.init(any:)`); nil when the value is not JSON, or is not the
    /// kind of value the member carries. A typed member is sent only as its
    /// typed case, so it is nil for one of those too.
    static func make(_ member: ToPageMember, _ value: Any) -> ToPage? {
        if member.typed { return nil }
        if member.carriesString {
            guard let string = value as? String else { return nil }
            return .text(member, string)
        }
        guard let json = JSONValue(any: value), case .object = json else { return nil }
        return .loose(member, json)
    }

    /// The message `member` carries in `data`, the UTF-8 of its JSON payload.
    static func decode(member name: String, data: Data) -> Result<ToPage, HostDecodeError> {
        guard let member = ToPageMember(rawValue: name) else { return .failure(.unknownName(name)) }
        if member.typed {
            let decoder = JSONDecoder()
            do {
                switch member {
                case .onCardGesture: return .success(.cardGesture(try decoder.decode(CardGestureReport.self, from: data)))
                case .onCardInsets: return .success(.cardInsets(try decoder.decode(CardInsets.self, from: data)))
                case .onBodyCrossing: return .success(.bodyCrossing(try decoder.decode(BodyCrossing.self, from: data)))
                case .onBodyBind: return .success(.bodyBind(try decoder.decode(BodyBind.self, from: data)))
                case .onBodyState: return .success(.bodyState(try decoder.decode(BodyStateReport.self, from: data)))
                default: preconditionFailure("\(name) is not typed")
                }
            } catch {
                return .failure(HostDecodeError(decoding: error))
            }
        }
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return .failure(.notJSON) }
        switch (member.carriesString, value) {
        case (true, .string(let string)): return .success(.text(member, string))
        case (true, _): return .failure(.notString)
        case (false, .object): return .success(.loose(member, value))
        case (false, _): return .failure(.notObject)
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

    /// Every call, by its receiver and member, as the page's registry lists them.
    static let declared: [(receiver: String, member: String)] = [
        ("tugdeck", "saveState"),
        ("tugdeck", "prepareForTermination"),
        ("tugdeck", "reauthenticate"),
        ("bridge", "onPageZoomApply"),
    ]

    var receiver: String {
        switch self {
        case .saveState, .prepareForTermination, .reauthenticate: return "tugdeck"
        case .pageZoomApply: return "bridge"
        }
    }

    var member: String {
        switch self {
        case .saveState: return "saveState"
        case .prepareForTermination: return "prepareForTermination"
        case .reauthenticate: return "reauthenticate"
        case .pageZoomApply: return "onPageZoomApply"
        }
    }

    var payload: JSONValue {
        switch self {
        case .saveState, .prepareForTermination: return .object([:])
        case .reauthenticate(let token): return .object(["token": .string(token)])
        case .pageZoomApply(let factor): return .number(factor)
        }
    }

    /// The body of the async function that makes the call and returns its reply.
    func source() -> String? {
        guard let argument = payload.parseExpression else { return nil }
        let object = receiver == "tugdeck" ? "window.tugdeck" : "window.__tugBridge"
        return "return await \(object)?.\(member)?.(\(argument));"
    }
}
