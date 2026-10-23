import JavaScriptCore
import XCTest

// The host's half of the host vocabulary agrees with the page's: the parity
// fixture the page's registry writes names the same messages `ToHostName`
// lists, with the same shell-only set, every sample decodes, and every
// refusal the page's codec makes the host makes too. The way back agrees the
// same way: the same `__tugBridge` members, every sample decoding and
// re-encoding to itself, and the same calls the host awaits, each made with
// a payload the page reads and answered with a reply the host reads.
final class HostChannelTests: XCTestCase {
    private struct ToHostEntry {
        var name: String
        var from: String
        var samples: [Any]
        var refused: [Any]
    }

    private struct ToPageEntry {
        var member: String
        var samples: [Any]
        var refused: [Any]
    }

    /// The fixture `host-parity.test.ts` writes from `tugdeck/src/host/registry.ts`.
    private func fixture(file: StaticString = #filePath) throws -> [String: Any] {
        let url = URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .appendingPathComponent("../../tugdeck/src/host/__tests__/fixtures/host-parity.json")
            .standardizedFileURL
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func toPageEntries() throws -> [ToPageEntry] {
        let rows = try XCTUnwrap(try fixture()["toPage"] as? [[String: Any]])
        return try rows.map { row in
            ToPageEntry(
                member: try XCTUnwrap(row["member"] as? String),
                samples: try XCTUnwrap(row["samples"] as? [Any]),
                refused: try XCTUnwrap(row["refused"] as? [Any])
            )
        }
    }

    private func toHostEntries() throws -> [ToHostEntry] {
        let rows = try XCTUnwrap(try fixture()["toHost"] as? [[String: Any]])
        return try rows.map { row in
            ToHostEntry(
                name: try XCTUnwrap(row["name"] as? String),
                from: try XCTUnwrap(row["from"] as? String),
                samples: try XCTUnwrap(row["samples"] as? [Any]),
                refused: try XCTUnwrap(row["refused"] as? [Any])
            )
        }
    }

    private func json(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    }

    func testTheNamesAreThePagesNames() throws {
        let entries = try toHostEntries()
        let fixtureNames = Set(entries.map(\.name))
        let hostNames = Set(ToHostName.allCases.map(\.rawValue))
        check("the page and the host name the same messages", fixtureNames == hostNames,
              "page only: \(fixtureNames.subtracting(hostNames).sorted()); host only: \(hostNames.subtracting(fixtureNames).sorted())")
        check("no name is declared twice", entries.count == fixtureNames.count)
    }

    func testTheShellOnlySetAgrees() throws {
        for entry in try toHostEntries() {
            guard let name = ToHostName(rawValue: entry.name) else { continue }
            check("\(entry.name) is shell-only exactly when the page says it is from the shell",
                  name.shellOnly == (entry.from == "shell"), "from: \(entry.from)")
        }
    }

    func testTheOverlayOnlySetAgrees() throws {
        for entry in try toHostEntries() {
            guard let name = ToHostName(rawValue: entry.name) else { continue }
            check("\(entry.name) is overlay-only exactly when the page says it is from the overlay",
                  name.overlayOnly == (entry.from == "overlay"), "from: \(entry.from)")
        }
    }

    func testEverySampleDecodes() throws {
        for entry in try toHostEntries() {
            for (i, sample) in entry.samples.enumerated() {
                let decoded = ToHost.decode(name: entry.name, data: try json(sample))
                if case .failure(let error) = decoded {
                    check("\(entry.name) sample \(i) decodes", false, error.description)
                }
            }
        }
    }

    func testEveryRefusalIsRefused() throws {
        let entries = try toHostEntries()
        check("every message names a refusal", entries.allSatisfy { !$0.refused.isEmpty })
        for entry in entries {
            for (i, value) in entry.refused.enumerated() {
                let decoded = ToHost.decode(name: entry.name, data: try json(value))
                if case .success = decoded {
                    check("\(entry.name) refused \(i) is refused", false)
                }
            }
        }
    }

    func testABodyThatIsNotJSONIsRefused() {
        let decoded = ToHost.decode(name: "openPath", data: Data("not json".utf8))
        guard case .failure(.notJSON) = decoded else { return XCTFail("\(decoded)") }
    }

    func testAnUnknownNameIsRefused() {
        let decoded = ToHost.decode(name: "spikeReady", data: Data("{}".utf8))
        guard case .failure(.unknownName) = decoded else { return XCTFail("\(decoded)") }
    }

    // MARK: Host → page

    /// `value` with every null-valued key dropped, at every depth.
    private func droppingNulls(_ value: Any) -> Any {
        if let fields = value as? [String: Any] {
            return fields.filter { !($0.value is NSNull) }.mapValues(droppingNulls)
        }
        if let array = value as? [Any] { return array.map(droppingNulls) }
        return value
    }

    func testTheMembersAreThePagesMembers() throws {
        let entries = try toPageEntries()
        let fixtureMembers = Set(entries.map(\.member))
        let hostMembers = Set(ToPageMember.allCases.map(\.rawValue))
        check("the page and the host name the same members", fixtureMembers == hostMembers,
              "page only: \(fixtureMembers.subtracting(hostMembers).sorted()); host only: \(hostMembers.subtracting(fixtureMembers).sorted())")
        check("no member is declared twice", entries.count == fixtureMembers.count)
    }

    func testEveryToPageSampleDecodesAndReencodesToItself() throws {
        for entry in try toPageEntries() {
            for (i, sample) in entry.samples.enumerated() {
                switch ToPage.decode(member: entry.member, data: try json(sample)) {
                case .failure(let error):
                    check("\(entry.member) sample \(i) decodes", false, error.description)
                case .success(let message):
                    let encoded = try XCTUnwrap(message.payloadJSON())
                    let back = try JSONSerialization.jsonObject(with: encoded, options: [.fragmentsAllowed])
                    let same = NSDictionary(dictionary: ["v": droppingNulls(back)])
                        .isEqual(to: ["v": droppingNulls(sample)])
                    check("\(entry.member) sample \(i) re-encodes to itself", same, "\(back) vs \(sample)")
                }
            }
        }
    }

    func testEveryToPageRefusalIsRefused() throws {
        let entries = try toPageEntries()
        check("every member names a refusal", entries.allSatisfy { !$0.refused.isEmpty })
        for entry in entries {
            for (i, value) in entry.refused.enumerated() {
                if case .success = ToPage.decode(member: entry.member, data: try json(value)) {
                    check("\(entry.member) refused \(i) is refused", false)
                }
            }
        }
    }

    func testAFieldThePageReadsAsValueOrNullIsWrittenAsNull() throws {
        func object(_ message: ToPage) throws -> [String: Any] {
            let json = try XCTUnwrap(message.payloadJSON())
            return try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        }
        check("no source tree", try object(.settingsLoaded(SettingsLoaded(makerMode: false, sourceTree: nil)))["sourceTree"] is NSNull)
        check("a dismissed picker", try object(.pathChosen(PathChosen(id: "p1", paths: [])))["path"] is NSNull)
        check("no thumbnail", try object(.thumbnail(Thumbnail(requestId: "t1", dataUrl: nil)))["dataUrl"] is NSNull)
        let layer = HostFrameReading.Layer(samples: [], active: [], activeTicks: 0, advancedRatio: nil, worstStillMs: 0)
        let reading = HostFrameReading(
            summary: FrameMeterStats.summarize(timestampsMs: [], periodMs: 8, windowStartMs: 0, windowEndMs: 16),
            armedWallMs: 0, tickMs: [], samples: nil, layers: ["c1": layer]
        )
        let sent = try object(.hostFrames(HostFramesReply(requestId: "f1", reading: reading)))
        let layers = try XCTUnwrap((sent["reading"] as? [String: Any])?["layers"] as? [String: Any])
        check("a layer with no active ticks", (layers["c1"] as? [String: Any])?["advancedRatio"] is NSNull)
    }

    func testASnapCarriesTheAxisThatDidNotSnapAsNull() throws {
        let report = CardGestureReport(
            cardId: "c1", kind: .resize, phase: .end,
            rect: PlanRect(x: 0, y: 0, width: 10, height: 10),
            pointer: .init(x: 1, y: 2), start: .init(x: 1, y: 2),
            moved: true, meta: false, alt: false, edge: .se, snap: .init(x: 40, y: nil)
        )
        let json = try XCTUnwrap(ToPage.cardGesture(report).payloadJSON())
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        let snap = try XCTUnwrap(object["snap"] as? [String: Any])
        check("the axis that snapped", snap["x"] as? Double == 40)
        check("the axis that did not is null, as the page's codec reads it", snap["y"] is NSNull)
        check("no snap at all is absent", try {
            var unsnapped = report
            unsnapped.snap = nil
            let data = try XCTUnwrap(ToPage.cardGesture(unsnapped).payloadJSON())
            return (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["snap"] == nil
        }())
    }

    /// Risk R01's trigger: a `placeCards` of 40 cards decoding in over half a
    /// millisecond. The reading is the measure block's average over 1,000
    /// decodes, so one decode is that over 1,000.
    func testPlaceCardsDecodeCost() throws {
        let card = #"{"cardId":"CARD","x":121,"y":96,"width":398,"height":483,"view":{"x":111,"y":86,"width":418,"height":503},"insets":{"top":10,"right":10,"bottom":10,"left":10},"shell":[{"x":117,"y":96,"width":8,"height":483}],"visible":true,"z":1,"grips":["e","s","se"],"free":true,"min":{"width":240,"height":160}}"#
        let cards = (0..<40).map { card.replacingOccurrences(of: "CARD", with: "c\($0)") }.joined(separator: ",")
        let head = #"{"apron":10,"canvas":{"x":0,"y":28,"width":1440,"height":872},"zoom":1,"gap":15,"cards":["#
        let tail = #"],"rails":{"left":{"min":240,"max":675}},"band":{"band":980,"flow":null}}"#
        let data = Data((head + cards + tail).utf8)
        guard case .success(.placeCards(let placement)) = ToHost.decode(name: "placeCards", data: data) else {
            return XCTFail("the placement does not decode")
        }
        check("all forty cards", placement.cards.count == 40)
        measure {
            for _ in 0..<1_000 {
                _ = ToHost.decode(name: "placeCards", data: data)
            }
        }
    }

    func testThePageCallsAreThePagesCalls() throws {
        let rows = try XCTUnwrap(try fixture()["pageCalls"] as? [[String: Any]])
        let fixtureCalls = Set(rows.compactMap { row -> String? in
            guard let receiver = row["receiver"] as? String, let member = row["member"] as? String else { return nil }
            return "\(receiver).\(member)"
        })
        let hostCalls = Set(PageCall.declared.map { "\($0.receiver).\($0.member)" })
        check("the page and the host name the same calls", fixtureCalls == hostCalls,
              "page only: \(fixtureCalls.subtracting(hostCalls).sorted()); host only: \(hostCalls.subtracting(fixtureCalls).sorted())")
        let made: [PageCall] = [.saveState, .prepareForTermination, .reauthenticate(token: "t"), .pageZoomApply(factor: 1), .railEdge]
        check("every call the host makes is declared",
              Set(made.map { "\($0.receiver).\($0.member)" }) == hostCalls)
    }

    /// The fixture's page-call row for `member`.
    private func pageCallRow(_ member: String) throws -> [String: Any] {
        let rows = try XCTUnwrap(try fixture()["pageCalls"] as? [[String: Any]])
        return try XCTUnwrap(rows.first { $0["member"] as? String == member }, "no row for \(member)")
    }

    func testEveryPageCallIsMadeWithAPayloadThePageReads() throws {
        let made: [PageCall] = [.saveState, .prepareForTermination, .reauthenticate(token: "t0k3n"), .pageZoomApply(factor: 1.25), .railEdge]
        for call in made {
            let samples = try XCTUnwrap(try pageCallRow(call.member)["samples"] as? [Any])
            let sent = try JSONSerialization.jsonObject(with: try XCTUnwrap(call.payloadJSON()), options: [.fragmentsAllowed])
            check("\(call.member)'s payload is one of the page's samples",
                  samples.contains { NSDictionary(dictionary: ["v": $0]).isEqual(to: ["v": sent]) }, "\(sent)")
        }
    }

    func testEveryPageCallReplyIsReadAndEveryRefusedReplyIsRefused() throws {
        for (receiver, member) in PageCall.declared {
            let row = try pageCallRow(member)
            let replies = try XCTUnwrap(row["replies"] as? [Any])
            let refused = try XCTUnwrap(row["refusedReplies"] as? [Any])
            check("\(receiver).\(member) names a reply and a refused reply", !replies.isEmpty && !refused.isEmpty)
            for (i, reply) in replies.enumerated() {
                if case .failure(let error) = PageReply.decode(member: member, data: try json(reply)) {
                    check("\(member) reply \(i) is read", false, error.description)
                }
            }
            for (i, value) in refused.enumerated() {
                if case .success = PageReply.decode(member: member, data: try json(value)) {
                    check("\(member) refused reply \(i) is refused", false)
                }
            }
        }
    }

    func testAPageThatAnswersNothingAnswersNothing() {
        guard case .success(.nothing) = PageReply.decode(member: "prepareForTermination", data: Data("null".utf8)) else {
            return XCTFail("a call with no member to answer it is not nothing")
        }
        let verdict = #"{"ok":true,"interrupted":["s1"],"unacknowledged":[],"flushedCards":2,"failedCards":[],"layoutSaved":true,"elapsedMs":12.5}"#
        guard case .success(.verdict(let read)) = PageReply.decode(member: "prepareForTermination", data: Data(verdict.utf8)) else {
            return XCTFail("the verdict does not decode")
        }
        check("the verdict's fields", read.interrupted == ["s1"] && read.flushedCards == 2 && read.elapsedMs == 12.5)
    }

    func testAScriptCarriesQuotesAndLineSeparatorsIntact() throws {
        let text = "it's \"quoted\"\u{2028}and\u{2029}split\\ here\n"
        let message = ToPage.clipboardRead(ClipboardContents(requestId: "clip-1", text: text, html: "", atoms: ""))
        let script = try XCTUnwrap(message.script())
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("var received = null; var window = { __tugBridge: { onClipboardRead: function (p) { received = p; } } };")
        context.evaluateScript(script)
        check("the script ran", context.exception == nil, "\(String(describing: context.exception))")
        let received = context.objectForKeyedSubscript("received")
        check("the member got its text back", received?.objectForKeyedSubscript("text")?.toString() == text)
    }

    func testAPageCallRendersItsMemberAndPayload() throws {
        let source = try XCTUnwrap(PageCall.reauthenticate(token: "t0k3n").source())
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("var seen = null; var window = { tugdeck: { reauthenticate: function (p) { seen = p.token; return 7; } } };")
        let result = context.evaluateScript("(function () { \(source.replacingOccurrences(of: "await ", with: "")) })()")
        check("the call returns the member's reply", result?.toInt32() == 7)
        check("the member got its payload", context.objectForKeyedSubscript("seen")?.toString() == "t0k3n")
    }
}
