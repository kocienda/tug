import Foundation

/// Per-instance identity and path helpers — Swift mirror of
/// `tugcore::instance` on the Rust side.
///
/// Every long-lived per-instance resource (tugbank DB, session
/// ledger, notify socket, log directory, bundle-path marker) derives
/// its path from a single identifier — `instanceId`. At runtime Swift
/// owns the computation: it resolves the identity from `BuildInfo`
/// (which read it from Info.plist at first access) and propagates it
/// to every spawned child via the `TUG_INSTANCE_ID` environment
/// variable (per [D12]).
///
/// A harness override is supported: setting `TUG_INSTANCE_ID` in the
/// app's environment before launch makes `InstanceConfig` use that
/// value instead of `BuildInfo.instanceId`. The override exists so
/// test rigs can construct synthetic identities pointing at temp
/// data dirs without rebuilding the bundle.
///
/// The override is **gated on the app-test harness marker**
/// (`TUGAPP_TEST_SOCKET`), and deliberately so. Every running Tug
/// instance exports its own `TUG_INSTANCE_ID` into the environment of
/// its tugcast child, which propagates it to every Session-card shell (see
/// `ProcessManager.startProcess`). `open` then propagates the caller's
/// environment to whatever app it launches — so a `just app-debug`
/// run from inside a release-main Session card would otherwise launch a
/// brand-new worktree/debug bundle that silently adopts `release-main`,
/// colliding with the very instance that spawned it (exit-73, the
/// "Another release-main instance is already running" dialog). A built
/// bundle's identity is its OWN baked-in `BuildInfo.instanceId`; an
/// inherited `TUG_INSTANCE_ID` is honored only when the app-test
/// harness is genuinely driving the launch — which it signals with
/// `TUGAPP_TEST_SOCKET` (set on every harness launch, passed via
/// `open --env`). The tugcast integration-test harness scrubs the same
/// vars on its side (`tugcast/tests/common/mod.rs`).
///
/// References: the multi-instance design record, [D04], [D05], [D12].
enum InstanceConfig {
    /// Environment variable name carrying the runtime instance ID.
    /// Kept in sync with `tugcore::instance::ENV_INSTANCE_ID`.
    static let envInstanceID = "TUG_INSTANCE_ID"

    /// App-test harness marker. Present iff the app-test driver
    /// launched this process (`tests/app-test/_harness` sets it on
    /// every launch and passes it via `open --env`). Gates the
    /// `TUG_INSTANCE_ID` override so only a genuine harness launch may
    /// override the bundle's baked-in identity. Kept in sync with the
    /// harness and `TestHarnessBridge`.
    static let envTestSocket = "TUGAPP_TEST_SOCKET"

    /// Environment variable name carrying the absolute path of the
    /// running app bundle. Swift sets this when spawning tugcast so
    /// tugcast can write the per-instance bundle-path marker. Kept
    /// in sync with `tugcore::instance::ENV_BUNDLE_PATH`.
    static let envBundlePath = "TUG_BUNDLE_PATH"

    /// File name of the per-instance bundle-path marker. Kept in
    /// sync with `tugcore::instance::BUNDLE_PATH_MARKER`.
    static let bundlePathMarkerName = "bundle-path"

    /// Canonical per-instance identifier for this process. Frozen on
    /// first access.
    ///
    /// The bundle's baked-in `BuildInfo.instanceId` is authoritative.
    /// An inherited `TUG_INSTANCE_ID` is honored only under the
    /// app-test harness (`TUGAPP_TEST_SOCKET` present) — see the type
    /// doc for why an ungated override would make Session-card-launched
    /// builds adopt the launching instance's identity.
    static let instanceId: String = {
        let env = ProcessInfo.processInfo.environment
        if env[envTestSocket] != nil,
           let override = env[envInstanceID],
           !override.isEmpty {
            return override
        }
        return BuildInfo.instanceId
    }()

    /// Per-instance data directory: `<base>/Tug/instances/<id>/`.
    /// On macOS `<base>` is `~/Library/Application Support`.
    static var dataDir: URL {
        baseDataDir
            .appendingPathComponent("instances", isDirectory: true)
            .appendingPathComponent(instanceId, isDirectory: true)
    }

    // ── tug-quiesce ladder ───────────────────────────────────────────
    //
    // Swift mirror of `tugcore::quiesce`, which is the source of truth.
    // Its `quiesce_constants_are_mirrored` test reads these exact lines
    // and fails the Rust build if they drift. Tug.app is the shutdown supervisor:
    // it asks each service to stop, gives the group its drain deadline,
    // and only then escalates — recording any escalation as a defect.

    /// How long the tugcast process group gets to exit on its own after
    /// SIGTERM before the supervisor escalates to SIGKILL. Each service
    /// enforces a 2 s flush budget on itself, so a healthy group is
    /// always gone well inside this.
    static let quiesceDrainDeadline: TimeInterval = 4.0

    /// Grace between SIGTERM and SIGKILL when reclaiming a stale
    /// process holding a port we need — enough for its own flush.
    static let quiesceStaleReclaimGrace: TimeInterval = 1.0

    /// Filename of the per-shutdown quiesce report in `dataDir`.
    static let quiesceReportName = "quiesce-report.json"

    /// Absolute path of this instance's quiesce report.
    static var quiesceReportPath: URL {
        dataDir.appendingPathComponent(quiesceReportName, isDirectory: false)
    }

    /// Per-instance log directory: `<data-dir>/Logs/`.
    static var logDir: URL {
        dataDir.appendingPathComponent("Logs", isDirectory: true)
    }

    /// Per-instance tugbank SQLite path: `<data-dir>/tugbank.db`.
    static var tugbankDbPath: URL {
        dataDir.appendingPathComponent("tugbank.db")
    }

    /// Per-instance session ledger SQLite path: `<data-dir>/sessions.db`.
    static var sessionsDbPath: URL {
        dataDir.appendingPathComponent("sessions.db")
    }

    /// Per-instance tugbank notify socket:
    /// `$TMPDIR/tugbank-notify-<shortToken>.sock`.
    ///
    /// Keyed on `shortToken` rather than the raw `instanceId` so the
    /// path stays under `sockaddr_un.sun_path` (~104 bytes) even for the
    /// long `apptest-<uuid>` IDs the test harness mints. Rust's
    /// `tugcore::instance::notify_socket_path` resolves the identical
    /// path (same FNV-1a token), so the binder (tugcast) and this
    /// connector agree.
    static var notifySocketPath: URL {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return tmp.appendingPathComponent("tugbank-notify-\(shortToken).sock")
    }

    /// Per-instance bundle-path marker: `<data-dir>/bundle-path`.
    static var bundlePathMarker: URL {
        dataDir.appendingPathComponent(bundlePathMarkerName)
    }

    /// Instance-independent data root: `<base>/Tug/`.
    ///
    /// Content under here is shared by every instance on the machine, being
    /// the same whoever asked for it. Per-instance state belongs in `dataDir`.
    static var sharedDataDir: URL {
        baseDataDir
    }

    /// Short, stable, fixed-width token derived from `instanceId`
    /// (FNV-1a 32-bit, hex). For keying fixed-length resource names that
    /// must stay under the Unix-domain socket path limit
    /// (`sockaddr_un.sun_path` is ~104 bytes on macOS) even when the
    /// instance id is long — the app-test harness mints
    /// `apptest-<uuid>`, whose full id plus the `$TMPDIR` prefix
    /// overflows `sun_path` and fails to bind. Same id → same token, and
    /// 32-bit collisions across the handful of live instances are
    /// negligible. Used for the app↔tugcast control socket name.
    static var shortToken: String {
        String(format: "%08x", fnv1a32(Array(instanceId.utf8)))
    }

    /// Absolute path of the running app bundle. Used as the value
    /// passed via `TUG_BUNDLE_PATH` to spawned children.
    static var bundlePath: String {
        Bundle.main.bundlePath
    }

    // MARK: - Port allocation

    /// Tugcast HTTP port window base.
    /// Mirrors `tugcore::ports::TUGCAST_PORT_BASE`.
    static let tugcastPortBase: Int = 55300
    /// Tugcast HTTP port window size.
    static let tugcastPortWindow: Int = 100

    /// Vite dev-server port window base.
    /// Mirrors `tugcore::ports::VITE_PORT_BASE`.
    static let vitePortBase: Int = 55200
    /// Vite dev-server port window size.
    static let vitePortWindow: Int = 100

    /// Dedicated app-test port windows. Mirror
    /// `tugcore::ports::APPTEST_*`. App-test instances draw from these so
    /// their ports can never overlap a live dev/release instance's.
    static let apptestTugcastPortBase: Int = 55400
    static let apptestVitePortBase: Int = 55500
    /// Instance-ID prefix marking the app-test family.
    /// Mirrors `tugcore::ports::APPTEST_ID_PREFIX`.
    static let apptestIDPrefix: String = "apptest-"

    /// True when this instance draws from the dedicated app-test windows.
    static var isAppTest: Bool { instanceId.hasPrefix(apptestIDPrefix) }

    /// Deterministic tugcast HTTP port for this instance — app-test
    /// window for `apptest-*`, shared dev/release window otherwise.
    /// Tugcast may still bind a different port if the derived one is
    /// taken — consult the registry for the authoritative value.
    static var tugcastPort: Int {
        derivePort(base: isAppTest ? apptestTugcastPortBase : tugcastPortBase,
                   window: tugcastPortWindow)
    }

    /// Deterministic Vite dev-server port for this instance.
    static var vitePort: Int {
        derivePort(base: isAppTest ? apptestVitePortBase : vitePortBase,
                   window: vitePortWindow)
    }

    /// FNV-1a 32-bit hash mirroring `tugcore::ports::fnv1a_32`.
    private static func fnv1a32(_ bytes: [UInt8]) -> UInt32 {
        var hash: UInt32 = 0x811c_9dc5
        for byte in bytes {
            hash ^= UInt32(byte)
            hash = hash &* 0x0100_0193
        }
        return hash
    }

    private static func derivePort(base: Int, window: Int) -> Int {
        let bytes = Array(instanceId.utf8)
        let offset = Int(fnv1a32(bytes) % UInt32(max(window, 1)))
        return base + offset
    }

    // MARK: - Internals

    private static var baseDataDir: URL {
        // Application Support directory. On macOS this resolves to
        // `~/Library/Application Support`; this matches what the
        // Rust `dirs::data_dir()` crate returns on macOS, keeping
        // the two sides agreeing on the same root path.
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support")
        return appSupport.appendingPathComponent("Tug", isDirectory: true)
    }
}
