import XCTest

final class InstanceAdoptionTests: XCTestCase {
    private var root: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = fm.temporaryDirectory
            .appendingPathComponent("instance-adoption-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: root)
    }

    private var instances: URL { root.appendingPathComponent("instances", isDirectory: true) }
    private var stranded: URL { instances.appendingPathComponent(InstanceAdoption.strandedInstanceId) }
    private var home: URL { instances.appendingPathComponent(InstanceAdoption.releaseInstanceId) }

    /// A data dir holding one file that says whose it was.
    private func makeDir(_ dir: URL, holding text: String) throws {
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try text.write(to: dir.appendingPathComponent("tugbank.db"), atomically: true, encoding: .utf8)
    }

    private func contents(_ dir: URL) -> String? {
        try? String(contentsOf: dir.appendingPathComponent("tugbank.db"), encoding: .utf8)
    }

    private func adopt(
        as instanceId: String = InstanceAdoption.releaseInstanceId,
        live: Set<String> = []
    ) -> InstanceAdoption.Outcome {
        InstanceAdoption.adopt(
            dataRoot: root,
            instanceId: instanceId,
            isLive: { live.contains($0) },
            now: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }

    func testNoStrandedDirAdoptsNothing() throws {
        try makeDir(home, holding: "home")
        XCTAssertEqual(adopt(), .nothingToAdopt)
        XCTAssertEqual(contents(home), "home")
    }

    /// A v0.9.5 first install: there was never a `release-main`.
    func testStrandedDirBecomesTheReleaseDir() throws {
        try makeDir(stranded, holding: "v0.9.5")
        XCTAssertEqual(adopt(), .adopted(retired: nil))
        XCTAssertEqual(contents(home), "v0.9.5")
    }

    /// An update to v0.9.5: what the user has now wins, and what they had
    /// before it is retired, not deleted.
    func testAnEarlierReleaseDirIsRetiredNotDeleted() throws {
        try makeDir(home, holding: "before")
        try makeDir(stranded, holding: "v0.9.5")
        guard case .adopted(let retired?) = adopt() else {
            return XCTFail("expected an adoption that retired the earlier dir")
        }
        XCTAssertEqual(contents(home), "v0.9.5")
        XCTAssertEqual(contents(retired), "before")
        XCTAssertEqual(retired.deletingLastPathComponent().lastPathComponent, "retired")
        XCTAssertEqual(retired.lastPathComponent, "release-main-1800000000")
    }

    /// Absolute paths recorded under the stranded name still resolve.
    func testPathsUnderTheStrandedNameStillResolve() throws {
        try makeDir(stranded, holding: "v0.9.5")
        let attachments = stranded.appendingPathComponent("draft-attachments", isDirectory: true)
        try fm.createDirectory(at: attachments, withIntermediateDirectories: true)
        let recorded = attachments.appendingPathComponent("a.png")
        try "bytes".write(to: recorded, atomically: true, encoding: .utf8)

        XCTAssertEqual(adopt(), .adopted(retired: nil))
        XCTAssertEqual(try String(contentsOf: recorded, encoding: .utf8), "bytes")
        XCTAssertEqual(
            try fm.destinationOfSymbolicLink(atPath: stranded.path),
            InstanceAdoption.releaseInstanceId
        )
    }

    /// The symlink left behind is not a stranded dir: a second launch, and
    /// every launch after, adopts nothing and retires nothing.
    func testASecondLaunchAdoptsNothing() throws {
        try makeDir(home, holding: "before")
        try makeDir(stranded, holding: "v0.9.5")
        _ = adopt()
        try "after".write(to: home.appendingPathComponent("tugbank.db"), atomically: true, encoding: .utf8)

        XCTAssertEqual(adopt(), .nothingToAdopt)
        XCTAssertEqual(contents(home), "after")
        let retired = try fm.contentsOfDirectory(atPath: root.appendingPathComponent("retired").path)
        XCTAssertEqual(retired, ["release-main-1800000000"])
    }

    func testOnlyTheReleaseInstanceAdopts() throws {
        try makeDir(stranded, holding: "v0.9.5")
        for id in ["debug-main", "release-some-branch", "apptest-main-1234"] {
            XCTAssertEqual(adopt(as: id), .nothingToAdopt, id)
        }
        XCTAssertEqual(contents(stranded), "v0.9.5")
        XCTAssertFalse(fm.fileExists(atPath: home.path))
    }

    func testARunningInstanceDefersTheAdoption() throws {
        try makeDir(home, holding: "before")
        try makeDir(stranded, holding: "v0.9.5")
        for id in [InstanceAdoption.strandedInstanceId, InstanceAdoption.releaseInstanceId] {
            XCTAssertEqual(adopt(live: [id]), .deferredWhileLive, id)
        }
        XCTAssertEqual(contents(home), "before")
        XCTAssertEqual(contents(stranded), "v0.9.5")
    }

    func testStrandedPreferencesAreLaidOverOwn() {
        let merged = InstanceAdoption.mergedDefaults(
            own: ["pageZoom": 1.0, "onlyOwn": true],
            stranded: ["pageZoom": 1.25, "onlyStranded": "x"]
        )
        XCTAssertEqual(merged["pageZoom"] as? Double, 1.25)
        XCTAssertEqual(merged["onlyOwn"] as? Bool, true)
        XCTAssertEqual(merged["onlyStranded"] as? String, "x")
    }

    /// The whole dir moves as one: a database keeps its WAL and shm beside
    /// it, and nested state comes along.
    func testEveryFileMovesTogether() throws {
        try makeDir(stranded, holding: "v0.9.5")
        let names = ["tugbank.db-wal", "tugbank.db-shm", "sessions.db", "sessions.db-wal", "draft-docs/d1/assets/a.png"]
        for name in names {
            let url = stranded.appendingPathComponent(name)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try name.write(to: url, atomically: true, encoding: .utf8)
        }
        XCTAssertEqual(adopt(), .adopted(retired: nil))
        for name in names {
            XCTAssertEqual(
                try String(contentsOf: home.appendingPathComponent(name), encoding: .utf8), name, name
            )
        }
    }

    /// A retired dir of the same second does not overwrite an earlier one.
    func testARetiredNameAlreadyTakenIsNotOverwritten() throws {
        let taken = root.appendingPathComponent("retired/release-main-1800000000", isDirectory: true)
        try makeDir(taken, holding: "an earlier retirement")
        try makeDir(home, holding: "before")
        try makeDir(stranded, holding: "v0.9.5")
        guard case .adopted(let retired?) = adopt() else {
            return XCTFail("expected an adoption that retired the earlier dir")
        }
        XCTAssertEqual(retired.lastPathComponent, "release-main-1800000000-1")
        XCTAssertEqual(contents(taken), "an earlier retirement")
        XCTAssertEqual(contents(retired), "before")
    }

    // MARK: - Liveness

    private func registry(_ instanceId: String, hostPid: Int?) -> Data {
        var item: [String: Any] = ["instance_id": instanceId, "bundle_path": "/Applications/Tug.app"]
        if let hostPid { item["host_pid"] = hostPid }
        return try! JSONSerialization.data(withJSONObject: ["version": 1, "instances": [item]])
    }

    private func isLive(_ id: String, registry: Data?, alive: Set<Int32> = [400, 500]) -> Bool {
        InstanceAdoption.isLive(id, registry: registry, ownPid: 500, isAlive: { alive.contains($0) })
    }

    func testALiveHostHoldsItsInstance() {
        XCTAssertTrue(isLive("release-main", registry: registry("release-main", hostPid: 400)))
    }

    func testNothingRunningReadsAsNotLive() {
        XCTAssertFalse(isLive("release-main", registry: nil))
        XCTAssertFalse(isLive("release-main", registry: Data("not json".utf8)))
        XCTAssertFalse(isLive("release-main", registry: registry("debug-main", hostPid: 400)))
        XCTAssertFalse(isLive("release-main", registry: registry("release-main", hostPid: 400), alive: [500]))
        XCTAssertFalse(isLive("release-main", registry: registry("release-main", hostPid: nil)))
    }

    /// This process's own entry, left by an earlier run under a reused pid
    /// or written by its own tugcast, does not defer its own adoption.
    func testThisProcessDoesNotHoldItsOwnInstance() {
        XCTAssertFalse(isLive("release-main", registry: registry("release-main", hostPid: 500)))
    }

    // MARK: - Preferences

    /// Scratch domains, so the test never reads or writes the real ones.
    private func withScratchDomains(_ body: (_ released: String, _ stranded: String, UserDefaults) -> Void) {
        let tag = UUID().uuidString
        let released = "dev.tugapp.tests.adoption.released.\(tag)"
        let stranded = "dev.tugapp.tests.adoption.stranded.\(tag)"
        let defaults = UserDefaults.standard
        defer {
            defaults.removePersistentDomain(forName: released)
            defaults.removePersistentDomain(forName: stranded)
        }
        body(released, stranded, defaults)
    }

    func testTheReleasedBundleTakesStrandedPreferences() {
        withScratchDomains { released, stranded, defaults in
            defaults.setPersistentDomain(["pageZoom": 1.0, "onlyOwn": true], forName: released)
            defaults.setPersistentDomain(["pageZoom": 1.25], forName: stranded)
            InstanceAdoption.adoptDefaults(bundleId: released, released: released, stranded: stranded, defaults: defaults)
            let own = defaults.persistentDomain(forName: released)
            XCTAssertEqual(own?["pageZoom"] as? Double, 1.25)
            XCTAssertEqual(own?["onlyOwn"] as? Bool, true)
        }
    }

    /// A nightly or a developer's build shares the data dir and keeps its
    /// own preferences.
    func testAnotherBundleKeepsItsOwnPreferences() {
        withScratchDomains { released, stranded, defaults in
            let nightly = released + ".nightly"
            defer { defaults.removePersistentDomain(forName: nightly) }
            defaults.setPersistentDomain(["pageZoom": 1.0], forName: nightly)
            defaults.setPersistentDomain(["pageZoom": 1.25], forName: stranded)
            InstanceAdoption.adoptDefaults(bundleId: nightly, released: released, stranded: stranded, defaults: defaults)
            XCTAssertEqual(defaults.persistentDomain(forName: nightly)?["pageZoom"] as? Double, 1.0)
        }
    }

    func testNoStrandedPreferencesChangesNothing() {
        withScratchDomains { released, stranded, defaults in
            defaults.setPersistentDomain(["pageZoom": 1.0], forName: released)
            InstanceAdoption.adoptDefaults(bundleId: released, released: released, stranded: stranded, defaults: defaults)
            XCTAssertEqual(defaults.persistentDomain(forName: released)?["pageZoom"] as? Double, 1.0)
        }
    }
}
