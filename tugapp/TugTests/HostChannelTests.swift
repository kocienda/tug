import JavaScriptCore
import XCTest

// The host's half of the host vocabulary agrees with the page's: the parity
// fixture the page's registry writes names the same messages `ToHostName`
// lists, with the same shell-only set, every sample decodes, and every
// refusal the page's codec makes on a typed message the host makes too. The
// way back agrees the same way: the same `__tugBridge` members, every sample
// decoding and re-encoding to itself, and the same calls the host awaits.
final class HostChannelTests: XCTestCase {
    private struct ToHostEntry {
        var name: String
        var from: String
        var typed: Bool
        var samples: [Any]
        var refused: [Any]
    }

    private struct ToPageEntry {
        var member: String
        var typed: Bool
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
                typed: try XCTUnwrap(row["typed"] as? Bool),
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
                typed: try XCTUnwrap(row["typed"] as? Bool),
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

    func testEveryTypedRefusalIsRefused() throws {
        let typed = try toHostEntries().filter(\.typed)
        check("the fixture carries a typed message", !typed.isEmpty)
        for entry in typed {
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

    func testATypedMessageThatIsNotJSONIsRefusedAsNotJSON() {
        let decoded = ToHost.decode(name: "cardPlan", data: Data("not json".utf8))
        guard case .failure(.notJSON) = decoded else { return XCTFail("\(decoded)") }
    }

    func testALooseObjectMessageRefusesAString() {
        let decoded = ToHost.decode(name: "openPath", data: Data(#""c1""#.utf8))
        guard case .failure(.notObject) = decoded else { return XCTFail("\(decoded)") }
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

    func testEveryTypedToPageRefusalIsRefused() throws {
        let typed = try toPageEntries().filter(\.typed)
        check("the fixture carries a typed member", !typed.isEmpty)
        for entry in typed {
            for (i, value) in entry.refused.enumerated() {
                if case .success = ToPage.decode(member: entry.member, data: try json(value)) {
                    check("\(entry.member) refused \(i) is refused", false)
                }
            }
        }
    }

    func testTheTypedMembersAreThePagesTypedMembers() throws {
        for entry in try toPageEntries() {
            guard let member = ToPageMember(rawValue: entry.member) else { continue }
            check("\(entry.member) is typed exactly when the page types it", member.typed == entry.typed)
        }
    }

    func testATypedMemberIsNotMadeLoose() {
        check("a typed member's payload is never built loose", ToPage.make(.onBodyState, ["state": "ready"]) == nil)
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
        let head = #"{"apron":10,"canvas":{"x":0,"y":28,"width":1440,"height":872},"zoom":1,"cards":["#
        let data = Data((head + cards + "]}").utf8)
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
        let made: [PageCall] = [.saveState, .prepareForTermination, .reauthenticate(token: "t"), .pageZoomApply(factor: 1)]
        check("every call the host makes is declared",
              Set(made.map { "\($0.receiver).\($0.member)" }) == hostCalls)
    }

    func testAScriptCarriesQuotesAndLineSeparatorsIntact() throws {
        let text = "it's \"quoted\"\u{2028}and\u{2029}split\\ here\n"
        let message = ToPage.loose(.onClipboardRead, .object(["requestId": .string("clip-1"), "text": .string(text)]))
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
