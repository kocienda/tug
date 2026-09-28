// Test driver for DictationTranscriptReducer and DictationEvent. Run via
// tests/dictation/test-dictation-state.sh, which concatenates this file with
// tugapp/Sources/DictationState.swift and pipes the pair to `swift -`. The
// driver runs against the source the app builds against — no duplicated
// reducer, and no XCTest bundle in the Xcode project.
//
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

import Foundation

var failures = 0

func check(_ label: String, _ condition: Bool, _ detail: @autoclosure () -> String = "") {
    if condition {
        print("  ok    \(label)")
    } else {
        failures += 1
        let extra = detail()
        print("  FAIL  \(label)\(extra.isEmpty ? "" : " — \(extra)")")
    }
}

/// The reducer's output as a comparable list, so a whole feed's result reads
/// as one assertion rather than three about counts and indices.
func flat(_ outputs: [DictationEventKindAndText]) -> [String] {
    outputs.map { "\($0.kind.rawValue):\($0.text)" }
}

// MARK: - a growing reading

print("a reading that grows")

do {
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

// MARK: - settling

print("settling a reading")

do {
    var reducer = DictationTranscriptReducer()
    _ = reducer.feed(cumulative: "hello wor", isFinal: false)

    check(
        "the final carries the settled tail",
        flat(reducer.feed(cumulative: "hello world", isFinal: true)) == ["final:hello world"]
    )
    check("it is committed", reducer.committed == "hello world", "got \(reducer.committed)")
    check("the volatile tail is gone", reducer.volatile == "")
}

// MARK: - a second utterance

print("a second utterance")

do {
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

// MARK: - a revision of settled text

print("a revision of settled text")

do {
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

do {
    var reducer = DictationTranscriptReducer()
    _ = reducer.feed(cumulative: "hello world", isFinal: true)

    check(
        "a coincidental shared letter is not a shared prefix",
        flat(reducer.feed(cumulative: "hats off", isFinal: false)) == ["volatile: hats off"]
    )
}

// MARK: - stopping

print("stopping")

do {
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

// MARK: - the wire shape

print("the wire shape")

do {
    let keys = { (event: DictationEvent) -> [String] in event.jsonObject.keys.sorted() }

    check(
        "preparing carries only id and kind",
        keys(DictationEvent.plain("d1", .preparing)) == ["id", "kind"]
    )
    check(
        "ready carries only id and kind",
        keys(DictationEvent.plain("d1", .ready)) == ["id", "kind"]
    )
    check(
        "the kind crosses as its wire string",
        DictationEvent.plain("d1", .ready).jsonObject["kind"] as? String == "ready"
    )
    check("the id crosses", DictationEvent.plain("d1", .ready).jsonObject["id"] as? String == "d1")

    let volatileEvent = DictationEvent.text("d1", .volatile, "hel")
    check("volatile carries text", keys(volatileEvent) == ["id", "kind", "text"])
    check("and the text is it", volatileEvent.jsonObject["text"] as? String == "hel")

    let finalEvent = DictationEvent.text("d1", .final, "hello world")
    check("final carries text", keys(finalEvent) == ["id", "kind", "text"])
    check("final's kind is final", finalEvent.jsonObject["kind"] as? String == "final")

    let ended = DictationEvent.ended("d1", .stopped)
    check("ended carries a reason", keys(ended) == ["id", "kind", "reason"])
    check("and no text", ended.jsonObject["text"] == nil)
    check("the reason is the wire string", ended.jsonObject["reason"] as? String == "stopped")
    check(
        "a hyphenated reason keeps its hyphen",
        DictationEvent.ended("d1", .deviceLost).jsonObject["reason"] as? String == "device-lost"
    )

    let endedWithMessage = DictationEvent.ended("d1", .error, message: "the tap fell over")
    check(
        "an ended error carries its message",
        keys(endedWithMessage) == ["id", "kind", "message", "reason"]
    )
    check(
        "and the message is it",
        endedWithMessage.jsonObject["message"] as? String == "the tap fell over"
    )

    let refused = DictationEvent.refused("d1", .microphonePermission)
    check("refused carries a reason", keys(refused) == ["id", "kind", "reason"])
    check(
        "the refusal is the wire string",
        refused.jsonObject["reason"] as? String == "microphone-permission"
    )
    check(
        "a one-word refusal has no hyphen to keep",
        DictationEvent.refused("d1", .unavailable).jsonObject["reason"] as? String == "unavailable"
    )

    let refusedWithMessage = DictationEvent.refused("d1", .error, message: "no such locale")
    check(
        "a refused error carries its message",
        keys(refusedWithMessage) == ["id", "kind", "message", "reason"]
    )

    check(
        "level is a kind, not something we send",
        DictationEvent.plain("d1", .level).jsonObject["level"] == nil
    )
}

// MARK: - the payload survives serialization

print("the payload crosses the wire")

do {
    let event = DictationEvent.text("d1", .final, "quotes \" and \\ and a newline\n")
    guard let data = try? JSONSerialization.data(withJSONObject: event.jsonObject),
        let round = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        check("awkward text serializes", false)
        exit(1)
    }
    check("awkward text serializes", true)
    check(
        "and survives the round trip",
        round["text"] as? String == "quotes \" and \\ and a newline\n"
    )
}

print(failures == 0 ? "PASS — DictationState" : "FAIL — \(failures) failure(s)")
if failures > 0 { exit(1) }
