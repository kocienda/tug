import XCTest

// A speech recogniser does not hand out a transcript a piece at a time; it
// hands out its whole current reading, over and over, revising it as it hears
// more. Every claim tested here is about the difference between those
// readings, because that difference is the only thing the deck ever inserts:
// a growing reading yields one volatile per change and nothing for a
// re-reading that says the same thing; a final settles the tail and leaves it
// settled; a fresh utterance gets the one space that makes concatenated
// finals read as prose; a recogniser that revises text it already finalized
// does not get to retract it; and a stop drops a tail the recogniser was
// still unsure of. The last group is the wire shape, where a key the kind
// does not have is as wrong as a missing one — the deck's parser is a
// discriminated union.
final class DictationStateTests: XCTestCase {
    /// The reducer's output as a comparable list, so a whole feed's result reads
    /// as one assertion rather than three about counts and indices.
    private func flat(_ outputs: [DictationEventKindAndText]) -> [String] {
        outputs.map { "\($0.kind.rawValue):\($0.text)" }
    }

    func testAReadingThatGrows() {
        var reducer = DictationTranscriptReducer()

        check(
            "the first partial is the whole tail",
            flat(reducer.feed(cumulative: "hel", isFinal: false)) == ["volatile:hel"]
        )
        check(
            "a longer reading replaces it",
            flat(reducer.feed(cumulative: "hello", isFinal: false)) == ["volatile:hello"]
        )
        check(
            "and again",
            flat(reducer.feed(cumulative: "hello wor", isFinal: false)) == ["volatile:hello wor"]
        )
        check(
            "an unchanged re-reading emits nothing",
            reducer.feed(cumulative: "hello wor", isFinal: false).isEmpty
        )
        check("nothing is committed yet", reducer.committed == "", "got \(reducer.committed)")
        check("the volatile tail is held", reducer.volatile == "hello wor")
    }

    func testSettlingAReading() {
        var reducer = DictationTranscriptReducer()
        _ = reducer.feed(cumulative: "hello wor", isFinal: false)

        check(
            "the final carries the settled tail",
            flat(reducer.feed(cumulative: "hello world", isFinal: true)) == ["final:hello world"]
        )
        check("it is committed", reducer.committed == "hello world", "got \(reducer.committed)")
        check("the volatile tail is gone", reducer.volatile == "")
    }

    func testASecondUtterance() {
        var reducer = DictationTranscriptReducer()
        _ = reducer.feed(cumulative: "hello world", isFinal: true)

        check(
            "a fresh reading is spaced off the committed prefix",
            flat(reducer.feed(cumulative: "how are", isFinal: false)) == ["volatile: how are"]
        )
        check(
            "settling it takes the recogniser's own spacing",
            flat(reducer.feed(cumulative: "hello world how are you", isFinal: true))
                == ["final: how are you"]
        )
        check(
            "the transcript is the concatenation of the finals",
            reducer.committed == "hello world how are you",
            "got \(reducer.committed)"
        )
        check("nothing is left provisional", reducer.volatile == "")
    }

    func testARevisionOfSettledText() {
        var reducer = DictationTranscriptReducer()
        _ = reducer.feed(cumulative: "hello world", isFinal: true)

        check(
            "the tail starts past the shared prefix",
            flat(reducer.feed(cumulative: "hello there", isFinal: false)) == ["volatile: there"]
        )
        check(
            "settled text is not retracted",
            reducer.committed == "hello world",
            "got \(reducer.committed)"
        )
    }

    func testACoincidentalSharedLetterIsNotASharedPrefix() {
        var reducer = DictationTranscriptReducer()
        _ = reducer.feed(cumulative: "hello world", isFinal: true)

        check(
            "a coincidental shared letter is not a shared prefix",
            flat(reducer.feed(cumulative: "hats off", isFinal: false)) == ["volatile: hats off"]
        )
    }

    func testStopping() {
        var reducer = DictationTranscriptReducer()
        _ = reducer.feed(cumulative: "hello world", isFinal: true)
        _ = reducer.feed(cumulative: "hello world and th", isFinal: false)

        check("finish emits nothing", reducer.finish().isEmpty)
        check("the unsettled tail is dropped", reducer.volatile == "")
        check(
            "the transcript is what was settled",
            reducer.committed == "hello world",
            "got \(reducer.committed)"
        )
    }

    func testTheWireShape() {
        let keys = { (event: DictationEvent) -> [String] in self.wire(event).keys.sorted() }

        check(
            "preparing carries only id and kind",
            keys(.preparing(id: "d1")) == ["id", "kind"]
        )
        check(
            "ready carries only id and kind",
            keys(.ready(id: "d1")) == ["id", "kind"]
        )
        check(
            "the kind crosses as its wire string",
            wire(.ready(id: "d1"))["kind"] as? String == "ready"
        )
        check("the id crosses", wire(.ready(id: "d1"))["id"] as? String == "d1")

        let volatileEvent = DictationEvent.volatile(id: "d1", text: "hel")
        check("volatile carries text", keys(volatileEvent) == ["id", "kind", "text"])
        check("and the text is it", wire(volatileEvent)["text"] as? String == "hel")

        let finalEvent = DictationEvent.final(id: "d1", text: "hello world")
        check("final carries text", keys(finalEvent) == ["id", "kind", "text"])
        check("final's kind is final", wire(finalEvent)["kind"] as? String == "final")
        check(
            "the reducer's output picks the case",
            DictationEvent.transcript("d1", .volatile("hel")) == volatileEvent
                && DictationEvent.transcript("d1", .final("hello world")) == finalEvent
        )

        let ended = DictationEvent.ended(id: "d1", reason: .stopped)
        check("ended carries a reason", keys(ended) == ["id", "kind", "reason"])
        check("and no text", wire(ended)["text"] == nil)
        check("the reason is the wire string", wire(ended)["reason"] as? String == "stopped")
        check(
            "a hyphenated reason keeps its hyphen",
            wire(.ended(id: "d1", reason: .deviceLost))["reason"] as? String == "device-lost"
        )

        let endedWithMessage = DictationEvent.ended(id: "d1", reason: .error, message: "the tap fell over")
        check(
            "an ended error carries its message",
            keys(endedWithMessage) == ["id", "kind", "message", "reason"]
        )
        check(
            "and the message is it",
            wire(endedWithMessage)["message"] as? String == "the tap fell over"
        )

        let refused = DictationEvent.refused(id: "d1", reason: .microphonePermission)
        check("refused carries a reason", keys(refused) == ["id", "kind", "reason"])
        check(
            "the refusal is the wire string",
            wire(refused)["reason"] as? String == "microphone-permission"
        )
        check(
            "a one-word refusal has no hyphen to keep",
            wire(.refused(id: "d1", reason: .unavailable))["reason"] as? String == "unavailable"
        )

        let refusedWithMessage = DictationEvent.refused(id: "d1", reason: .error, message: "no such locale")
        check(
            "a refused error carries its message",
            keys(refusedWithMessage) == ["id", "kind", "message", "reason"]
        )

        check(
            "the reserved level carries only its level",
            keys(.level(id: "d1", level: 0.4)) == ["id", "kind", "level"]
        )
    }

    func testThePayloadCrossesTheWire() {
        let event = DictationEvent.final(id: "d1", text: "quotes \" and \\ and a newline\n")
        guard let data = try? JSONEncoder().encode(event) else {
            check("awkward text serializes", false)
            return
        }
        check("awkward text serializes", true)
        check(
            "and survives the round trip",
            (try? JSONDecoder().decode(DictationEvent.self, from: data)) == event
        )
    }

    /// The event as it crosses to the deck: encoded, then read back as JSON.
    /// Empty when it does not encode.
    private func wire(_ event: DictationEvent) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(event),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}
