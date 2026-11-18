import XCTest

final class LaunchHandoffTests: XCTestCase {
    private let bundle = "/Applications/Tug.app"
    private let ownPid: Int32 = 500
    private let runningPid: Int32 = 400

    private func entry(hostPid: Int32? = nil, bundlePath: String? = nil) -> LaunchHandoff.Entry {
        LaunchHandoff.Entry(
            instanceId: "release-main",
            bundlePath: bundlePath ?? bundle,
            hostPid: hostPid ?? runningPid,
            tugcastPort: 55312
        )
    }

    /// The decision with a world where `live` pids are alive and each runs
    /// the executable `paths` names.
    private func decide(
        _ entry: LaunchHandoff.Entry?,
        live: Set<Int32> = [400, 500],
        paths: [Int32: String] = [400: "/Applications/Tug.app/Contents/MacOS/Tug"],
        isAppTest: Bool = false,
        optedIn: Bool = false,
        canonical: @escaping (String) -> String = { $0 }
    ) -> LaunchHandoff.Decision {
        LaunchHandoff.decide(
            entry: entry,
            ownPid: ownPid,
            isAppTest: isAppTest,
            optedIn: optedIn,
            isAlive: { live.contains($0) },
            executablePath: { paths[$0] },
            canonical: canonical
        )
    }

    func testNoEntryProceeds() {
        XCTAssertEqual(decide(nil), .proceed)
    }

    func testDeadHostProceeds() {
        XCTAssertEqual(decide(entry(), live: [500]), .proceed)
    }

    func testOwnPidProceeds() {
        let mine = entry(hostPid: ownPid)
        XCTAssertEqual(decide(mine, paths: [500: "/Applications/Tug.app/Contents/MacOS/Tug"]), .proceed)
    }

    func testEntryWithoutHostPidProceeds() {
        XCTAssertEqual(decide(entry(hostPid: 0)), .proceed)
    }

    func testHostRunningFromAnotherBundleProceeds() {
        let reused = [runningPid: "/Users/me/DerivedData/Tug.app/Contents/MacOS/Tug"]
        XCTAssertEqual(decide(entry(), paths: reused), .proceed)
    }

    func testBundlePathPrefixOfAnotherBundleProceeds() {
        let sibling = [runningPid: "/Applications/Tug.app.old/Contents/MacOS/Tug"]
        XCTAssertEqual(decide(entry(), paths: sibling), .proceed)
    }

    func testUnreadableExecutableProceeds() {
        XCTAssertEqual(decide(entry(), paths: [:]), .proceed)
    }

    func testLiveMatchHandsOff() {
        XCTAssertEqual(decide(entry()), .handOff(entry()))
    }

    func testTrailingSlashOnBundlePathStillMatches() {
        let slashed = entry(bundlePath: bundle + "/")
        XCTAssertEqual(decide(slashed), .handOff(slashed))
    }

    func testBundlePathIsComparedCanonically() {
        let viaLink = entry(bundlePath: "/link/Tug.app")
        let canonical: (String) -> String = { $0.replacingOccurrences(of: "/link", with: "/Applications") }
        XCTAssertEqual(decide(viaLink, canonical: canonical), .handOff(viaLink))
    }

    func testAppTestWithoutOptInProceeds() {
        XCTAssertEqual(decide(entry(), isAppTest: true), .proceed)
    }

    func testAppTestWithOptInHandsOff() {
        XCTAssertEqual(decide(entry(), isAppTest: true, optedIn: true), .handOff(entry()))
    }

    func testEntryIsReadByInstanceId() throws {
        let doc = """
        {"version":1,"instances":[
          {"instance_id":"debug-main","bundle_path":"/tmp/Debug.app","pid":1,"host_pid":2,"tugcast_port":55301},
          {"instance_id":"release-main","bundle_path":"/Applications/Tug.app","pid":3,"host_pid":400,"tugcast_port":55312}
        ]}
        """
        let found = LaunchHandoff.entry(in: Data(doc.utf8), instanceId: "release-main")
        XCTAssertEqual(found, entry())
        XCTAssertNil(LaunchHandoff.entry(in: Data(doc.utf8), instanceId: "apptest-x"))
    }

    func testEntryWithoutHostPidReadsAsZero() {
        let doc = #"{"instances":[{"instance_id":"release-main","bundle_path":"/Applications/Tug.app","pid":3,"tugcast_port":55312}]}"#
        XCTAssertEqual(LaunchHandoff.entry(in: Data(doc.utf8), instanceId: "release-main")?.hostPid, 0)
    }

    func testUnparseableRegistryReadsAsNoEntry() {
        XCTAssertNil(LaunchHandoff.entry(in: Data("not json".utf8), instanceId: "release-main"))
    }

    func testThisProcessIsAliveAndHasAnExecutable() {
        let me = getpid()
        XCTAssertTrue(LaunchHandoff.processIsAlive(me))
        XCTAssertNotNil(LaunchHandoff.executablePath(of: me))
        XCTAssertFalse(LaunchHandoff.processIsAlive(0))
    }
}
