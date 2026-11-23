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
}
