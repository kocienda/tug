import Foundation

/// The dictation bridge's event model and transcript reducer, with no audio
/// in it.
///
/// Dictation's moving parts are a microphone, a speech recogniser, and an
/// audio engine, none of which can be reasoned about in a test. What *can*
/// be is the shape of what crosses the bridge and the arithmetic that turns
/// a recogniser's re-readings into a stream of provisional and settled text.
/// That is this file: `DictationEvent` out, `DictationTranscriptReducer` in
/// the middle, and nothing imported but Foundation. `DictationEngine` is the
/// glue that owns the `AVAudioEngine` and the recogniser adapters, and it
/// holds no transcript state of its own.
///
/// Foundation-only is load-bearing rather than tidy: the host-less TugTests
/// bundle compiles this exact source (`tugapp/TugTests/DictationStateTests.swift`),
/// and an AVFoundation or Speech import here would end that.
///
/// References: the dictation brief, [P02] one protocol, Spec S02, Spec S03,
/// Spec S04, Risk R01.

/// Every kind of event the host can send the deck about a dictation session.
///
/// One vocabulary, fixed by the deck's `DictationEvent` type — the raw values
/// are the wire strings, so the two sides cannot drift apart without a build
/// failure on one of them.
enum DictationEventKind: String, Codable {
    /// Work is happening before the mic is live — an asset download, most
    /// often. Zero or more of these precede `ready`.
    case preparing
    /// The mic is live and the recogniser is listening.
    case ready
    /// Reserved for an input level meter. Never emitted ([P03]): the live
    /// face is the wave, which needs no samples.
    case level
    /// The provisional tail since the last `final`. Each replaces the
    /// previous one.
    case volatile
    /// Settled text. The concatenation of every `final` is the transcript.
    case final
    /// The session is over. Exactly one per `ready`, and nothing follows it.
    case ended
    /// The session never started. Terminal, and it replaces `ready`.
    case refused
}

/// Why a session never started. Mapped from a host condition by Table T02
/// and spoken to the user by Table T01.
enum DictationRefusal: String, Error, Codable {
    /// `AVCaptureDevice.requestAccess(for: .audio)` said no.
    case microphonePermission = "microphone-permission"
    /// Speech recognition authorization is anything but `.authorized`.
    case speechPermission = "speech-permission"
    /// No on-device model for this locale, or its install failed.
    case noModel = "no-model"
    /// The input format reports no channels, so there is nothing to record.
    case noInputDevice = "no-input-device"
    /// No recogniser class applies on this machine.
    case unavailable
    /// Something threw while preparing or starting. Carries a message.
    case error
}

/// Why a live session ended.
enum DictationEndReason: String, Codable {
    /// The deck asked for it — the button, Escape, a submit, a card going
    /// modal, the app resigning active.
    case stopped
    /// A second composer claimed the mic. Only one session is ever live.
    case superseded
    /// The audio route changed under us.
    case deviceLost = "device-lost"
    /// Something threw mid-session. Carries a message.
    case error
}

/// One event, as the deck receives it through `__tugBridge.onDictation`: the
/// deck's `DictationEvent` union, keyed on `kind`.
///
/// Each kind carries its own payload on its case, so a `volatile` cannot
/// omit its text and a `ready` cannot carry one — the shape Spec S02's
/// discriminated union requires is the only one this can build. The id on
/// every case is the session it belongs to: the deck drops any event whose
/// id is not the claim it is holding, which is how a superseded session's
/// late callbacks land nowhere.
enum DictationEvent: Equatable {
    case preparing(id: String)
    case ready(id: String)
    /// Reserved; never sent ([P03]).
    case level(id: String, level: Double)
    case volatile(id: String, text: String)
    case final(id: String, text: String)
    /// The terminal event for a session that started; an `error` may say why.
    case ended(id: String, reason: DictationEndReason, message: String? = nil)
    /// The terminal event for a session that never did.
    case refused(id: String, reason: DictationRefusal, message: String? = nil)

    /// The reducer's output for the session `id`: a `volatile` or a `final`.
    static func transcript(_ id: String, _ output: DictationEventKindAndText) -> DictationEvent {
        output.kind == .final ? .final(id: id, text: output.text) : .volatile(id: id, text: output.text)
    }

    var id: String {
        switch self {
        case .preparing(let id), .ready(let id), .level(let id, _), .volatile(let id, _), .final(let id, _),
             .ended(let id, _, _), .refused(let id, _, _):
            return id
        }
    }

    var kind: DictationEventKind {
        switch self {
        case .preparing: return .preparing
        case .ready: return .ready
        case .level: return .level
        case .volatile: return .volatile
        case .final: return .final
        case .ended: return .ended
        case .refused: return .refused
        }
    }
}

extension DictationEvent: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, kind, text, level, reason, message
    }

    /// Only the keys the kind has. A `message`, when there is one, is a
    /// string: absent is no message, and `null` is refused, as the deck's
    /// `optional(str)` refuses it.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        func message() throws -> String? {
            container.contains(.message) ? try container.decode(String.self, forKey: .message) : nil
        }
        switch try container.decode(DictationEventKind.self, forKey: .kind) {
        case .preparing: self = .preparing(id: id)
        case .ready: self = .ready(id: id)
        case .level: self = .level(id: id, level: try container.decode(Double.self, forKey: .level))
        case .volatile: self = .volatile(id: id, text: try container.decode(String.self, forKey: .text))
        case .final: self = .final(id: id, text: try container.decode(String.self, forKey: .text))
        case .ended:
            self = .ended(id: id, reason: try container.decode(DictationEndReason.self, forKey: .reason), message: try message())
        case .refused:
            self = .refused(id: id, reason: try container.decode(DictationRefusal.self, forKey: .reason), message: try message())
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        switch self {
        case .preparing, .ready:
            break
        case .level(_, let level):
            try container.encode(level, forKey: .level)
        case .volatile(_, let text), .final(_, let text):
            try container.encode(text, forKey: .text)
        case .ended(_, let reason, let message):
            try container.encode(reason, forKey: .reason)
            try container.encodeIfPresent(message, forKey: .message)
        case .refused(_, let reason, let message):
            try container.encode(reason, forKey: .reason)
            try container.encodeIfPresent(message, forKey: .message)
        }
    }
}

/// One reducer output: the kind to emit and the text to emit it with.
///
/// The reducer produces only `volatile` and `final`, and it does not know the
/// session id — the engine pairs each of these with the live id on its way to
/// `emit`, which keeps the id out of the one piece of this that is arithmetic.
struct DictationEventKindAndText: Equatable {
    let kind: DictationEventKind
    let text: String

    static func volatile(_ text: String) -> DictationEventKindAndText {
        DictationEventKindAndText(kind: .volatile, text: text)
    }

    static func final(_ text: String) -> DictationEventKindAndText {
        DictationEventKindAndText(kind: .final, text: text)
    }
}

/// Turns a recogniser's successive re-readings into the event stream Spec S03
/// describes.
///
/// A recogniser does not hand out a transcript a piece at a time; it hands
/// out its whole current reading, over and over, revising it as it hears
/// more. So the arithmetic that matters is the difference between what has
/// already been settled and what the recogniser now says — that difference is
/// the tail, and the tail is what the deck inserts (Risk R01).
///
/// Settled text is never retracted. A recogniser that revises a word it
/// already finalized gets the revision treated as new text past the shared
/// prefix, because the deck has already put the old word in the document and
/// pulling it back out would fight the user's own edits for a span they may
/// have moved on from.
struct DictationTranscriptReducer {
    /// Text already emitted as `final`. The transcript, in other words.
    private(set) var committed: String = ""
    /// The tail last emitted as `volatile`, so an unchanged re-reading can be
    /// recognised and dropped.
    private(set) var volatile: String = ""

    /// Feed one recogniser reading.
    ///
    /// `cumulative` is the recogniser's whole transcript so far for this
    /// session; `isFinal` marks it settled. Returns the events to emit, in
    /// order — zero or one, in practice, since a reading is either a revision
    /// of the tail or a settling of it.
    mutating func feed(cumulative: String, isFinal: Bool) -> [DictationEventKindAndText] {
        let tail = spaced(tailOf(cumulative))

        if !isFinal {
            if tail == volatile { return [] }
            volatile = tail
            return [.volatile(tail)]
        }

        volatile = ""
        guard !tail.isEmpty else { return [] }
        committed += tail
        return [.final(tail)]
    }

    /// Session end. A volatile tail the recogniser never finalized is
    /// dropped rather than promoted (Spec S03 rule 5): the user pressed stop,
    /// and text the recogniser was still unsure of is not what they asked to
    /// keep.
    mutating func finish() -> [DictationEventKindAndText] {
        volatile = ""
        return []
    }

    /// `cumulative` with everything already committed taken off the front.
    ///
    /// The ordinary case is a plain prefix. The other case is a revision: the
    /// recogniser now reads the settled text differently, so the shared
    /// prefix is all that can be trusted and the rest is the tail.
    private func tailOf(_ cumulative: String) -> String {
        if cumulative.hasPrefix(committed) {
            return String(cumulative.dropFirst(committed.count))
        }
        return String(cumulative.dropFirst(sharedPrefixLength(with: cumulative)))
    }

    /// How much of `cumulative` agrees with `committed`, rounded down to a
    /// word boundary.
    ///
    /// The boundary matters. Splitting at the raw character where two
    /// readings diverge turns "hello world" revised to "how are" into a tail
    /// of "ow are" — the shared "h" is a coincidence of spelling, not of
    /// meaning. Backing off to the last point where both readings were
    /// between words gives "how are", which is the whole of what the
    /// recogniser is now saying.
    private func sharedPrefixLength(with cumulative: String) -> Int {
        let a = Array(committed)
        let b = Array(cumulative)

        var n = 0
        while n < a.count, n < b.count, a[n] == b[n] { n += 1 }

        while n > 0, !isWordBoundary(n, a, b) { n -= 1 }
        return n
    }

    /// True when index `n` is a point both readings were between words: the
    /// character before it is whitespace, or each reading either ends there
    /// or continues with whitespace.
    private func isWordBoundary(_ n: Int, _ a: [Character], _ b: [Character]) -> Bool {
        if n == 0 { return true }
        if a[n - 1].isWhitespace { return true }
        let aBreaks = n == a.count || a[n].isWhitespace
        let bBreaks = n == b.count || b[n].isWhitespace
        return aBreaks && bBreaks
    }

    /// The spacing rule, Spec S03 rule 7: one space between a non-empty
    /// committed prefix and a new segment when neither side supplies one.
    ///
    /// The host owns this because the host is the only side that can see both
    /// segments at once. A recogniser starting a fresh utterance reports it
    /// with no leading space, and concatenating finals without this would
    /// read "hello worldhow are you".
    private func spaced(_ tail: String) -> String {
        guard !tail.isEmpty, !committed.isEmpty else { return tail }
        guard let last = committed.last, let first = tail.first else { return tail }
        if last.isWhitespace || first.isWhitespace { return tail }
        return " " + tail
    }
}
