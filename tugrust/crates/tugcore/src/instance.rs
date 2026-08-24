//! Per-instance identity and path helpers.
//!
//! Every long-lived per-instance resource (tugbank DB, session
//! ledger, notify socket, log directory, bundle-path marker) derives
//! its path from a single environment variable: `TUG_INSTANCE_ID`,
//! set by Swift at launch and inherited by every spawned child
//! (see [D12]). When the variable is unset, callers see legacy
//! single-instance paths so the helpers are safe to drop into
//! existing code with no behavioral change for unmodified callers.
//!
//! The instance ID itself is `<profile>-<branch-slug>` — for
//! example `release-main` or `debug-dev-wake-1`. Tug code
//! does not parse the ID; downstream readers treat it as an opaque
//! filesystem-safe token.
//!
//! [D12]: dash/tug-multi-instance.md#d12-instance-env-var

use std::env;
use std::path::PathBuf;

/// Environment variable name carrying the runtime instance ID.
pub const ENV_INSTANCE_ID: &str = "TUG_INSTANCE_ID";

/// Environment variable relocating the application-data root that every
/// Tug path derives from. Set by test harnesses and by `.cargo/config.toml`
/// so no cargo-driven process resolves the user's live data.
pub const ENV_DATA_DIR: &str = "TUG_DATA_DIR";

/// Environment variable asserting that this process must never resolve a
/// path inside the user's real application-data directory. When set,
/// every path helper here checks its result and panics on a live path.
pub const ENV_TEST_ISOLATION: &str = "TUG_TEST_ISOLATION";

/// Environment variable name carrying the absolute path of the
/// running app bundle. Swift sets this when spawning tugcast so
/// tugcast can write the per-instance bundle-path marker.
pub const ENV_BUNDLE_PATH: &str = "TUG_BUNDLE_PATH";

/// File name of the per-instance bundle-path marker. The marker
/// anchors `tugutil host instance prune`'s orphan detection: a data dir
/// is reachable iff `cat <data-dir>/<MARKER>` points at an extant
/// bundle.
pub const BUNDLE_PATH_MARKER: &str = "bundle-path";

/// Resolve the runtime instance ID from `TUG_INSTANCE_ID`.
///
/// Returns `None` when the variable is unset or empty. An empty
/// value is treated the same as unset — neither a sensible default
/// nor an error — because `TUG_INSTANCE_ID=` from a shell would
/// otherwise resolve to a data dir under `instances//`.
pub fn instance_id() -> Option<String> {
    env::var(ENV_INSTANCE_ID).ok().filter(|s| !s.is_empty())
}

/// Short, fixed-width token for an arbitrary instance ID (FNV-1a
/// 32-bit, lower-hex). Pure function of the ID — use this to key
/// resources for an instance *other* than the current process's (e.g.
/// reaping a removed worktree's tmux server). Mirrors
/// `InstanceConfig.shortToken` in Swift (identical FNV-1a + `%08x`).
pub fn short_token_for(instance_id: &str) -> String {
    format!("{:08x}", crate::ports::fnv1a_32(instance_id.as_bytes()))
}

/// Short, fixed-width token derived from the *runtime* instance ID.
/// Returns `None` when no instance ID is set.
///
/// Fixed-length resource names that must stay under the Unix-domain
/// socket path limit (`sockaddr_un.sun_path` is ~104 bytes on macOS)
/// key on this rather than the raw ID: the app-test harness mints
/// `apptest-<uuid>`, whose full ID plus the `$TMPDIR` prefix overflows
/// `sun_path` and fails to bind. Same ID → same token.
pub fn short_token() -> Option<String> {
    instance_id().map(|id| short_token_for(&id))
}

/// Per-instance tmux server socket label for an arbitrary instance ID:
/// `tug-<short_token>`. Pure function of the ID.
pub fn tmux_socket_label_for(instance_id: &str) -> String {
    format!("tug-{}", short_token_for(instance_id))
}

/// Per-instance tmux server socket label for the runtime instance:
/// `tug-<short_token>`.
///
/// Passed as `tmux -L <label>` so every instance owns a private tmux
/// server — a tmux operation in one instance can never reach another
/// instance's sessions or server. Returns `None` when no instance ID
/// is set (legacy / standalone launches use the default tmux server).
pub fn tmux_socket_label() -> Option<String> {
    instance_id().map(|id| tmux_socket_label_for(&id))
}

/// Path to the tmux binary every Tug process should invoke.
///
/// Tug.app bundles a self-contained tmux and points `TUG_TMUX` at it, so
/// the user needs nothing installed. Returns that path when set, otherwise
/// falls back to `"tmux"` resolved from `PATH` (dev builds, standalone
/// launches). Setting `TUG_USE_SYSTEM_TMUX` forces the `PATH` lookup even
/// when `TUG_TMUX` is set — the escape hatch for users who deliberately
/// want their own tmux. All tmux invocations route through here so the
/// bundled client and the bundled server are always the same version.
pub fn tmux_bin() -> String {
    if std::env::var_os("TUG_USE_SYSTEM_TMUX").is_none() {
        if let Some(path) = std::env::var_os("TUG_TMUX") {
            if !path.is_empty() {
                return path.to_string_lossy().into_owned();
            }
        }
    }
    "tmux".to_string()
}

/// Reap the tmux server/session belonging to `instance_id`. A running
/// instance owns a private `tug-<token>` server (current scheme) hosting a
/// `cc-<id>` session; pre-isolation builds put `cc-<id>` on the shared default
/// server. Both are killed best-effort so a removed instance's tmux never
/// outlives it. tmux's "no server"/"no session" errors when the instance never
/// launched an app are expected and ignored.
///
/// Shared home for the reaper so both `tugutil host instance` and `tugutil dash`'s
/// worktree teardown drive the exact same identity math.
pub fn reap_instance_tmux(instance_id: &str) {
    let label = tmux_socket_label_for(instance_id);
    let _ = std::process::Command::new(tmux_bin())
        .args(["-L", &label, "kill-server"])
        .output();
    let _ = std::process::Command::new(tmux_bin())
        .args(["kill-session", "-t", &format!("cc-{instance_id}")])
        .output();
}

/// Non-destructively test whether the `cc-<instance_id>` session is live on the
/// instance's private `tug-<token>` server. Used to decide whether it is safe to
/// touch a worktree an instance's app might still be holding (e.g. the
/// `.tugtree/` → `.tug/worktrees/` migration): `has-session` exits 0 only when
/// the session exists, so a dead/never-launched instance reads as not-live.
pub fn instance_tmux_live(instance_id: &str) -> bool {
    let label = tmux_socket_label_for(instance_id);
    std::process::Command::new(tmux_bin())
        .args([
            "-L",
            &label,
            "has-session",
            "-t",
            &format!("cc-{instance_id}"),
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Per-instance data directory.
///
/// - With `TUG_INSTANCE_ID=<id>`: `<base>/Tug/instances/<id>/`
/// - Without: legacy `<base>/Tug/`
///
/// where `<base>` is `dirs::data_dir()` on macOS, `~/Library/
/// Application Support`. Falls back to the system temp directory
/// if no home directory is resolvable.
///
/// This function does *not* create the directory — callers that
/// need a writable path on disk should `fs::create_dir_all` it.
pub fn data_dir() -> PathBuf {
    let base = base_data_dir();
    guard_isolated(match instance_id() {
        Some(id) => base.join("instances").join(id),
        None => base,
    })
}

/// Per-instance log directory: `<data-dir>/Logs/`.
///
/// With `TUG_INSTANCE_ID` set this is per-instance; without it,
/// callers see the legacy single-instance log path
/// (`~/Library/Application Support/Tug/Logs/`).
pub fn log_dir() -> PathBuf {
    data_dir().join("Logs")
}

/// Per-instance tugbank database path.
///
/// Returns `Some(<data-dir>/tugbank.db)` when `TUG_INSTANCE_ID` is
/// set, otherwise `None`. Callers fall back to their existing
/// path resolution (e.g. `~/.tugbank.db`) when this returns `None`.
pub fn tugbank_db_path() -> Option<PathBuf> {
    instance_id().map(|_| data_dir().join("tugbank.db"))
}

/// Environment variable overriding the per-instance session-ledger path.
/// Set by test harnesses (the tugutil CLI suite) so isolated runs read a
/// seeded `sessions.db` without depending on platform data-dir resolution
/// (`dirs::data_dir()` keys off `XDG_DATA_HOME` on Linux, so a bare `HOME`
/// override is not enough). Mirrors [`ENV_CHANGES_DB`].
pub const ENV_SESSIONS_DB: &str = "TUG_SESSIONS_DB";

/// Per-instance session ledger database path.
///
/// Returns `Some(<data-dir>/sessions.db)` when `TUG_INSTANCE_ID`
/// is set, otherwise `None`.
pub fn sessions_db_path() -> Option<PathBuf> {
    instance_id().map(|_| data_dir().join("sessions.db"))
}

/// Full resolution order for the session ledger, shared by every reader in
/// the workspace: the [`ENV_SESSIONS_DB`] override, then the per-instance
/// path, then the legacy single-instance location a standalone tugcast
/// launch used before instances existed.
///
/// `None` only when the platform has no resolvable data directory. Callers
/// treat that as a misconfigured environment.
pub fn resolve_sessions_db_path() -> Option<PathBuf> {
    if let Some(p) = env::var_os(ENV_SESSIONS_DB).filter(|v| !v.is_empty()) {
        return Some(guard_isolated(PathBuf::from(p)));
    }
    if let Some(p) = sessions_db_path() {
        return Some(p);
    }
    Some(guard_isolated(legacy_data_dir().join("sessions.db")))
}

/// The pre-instances data directory. macOS has always used `Tug`; other
/// platforms named it after the process that owned the ledger.
fn legacy_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        base_data_dir()
    }
    #[cfg(not(target_os = "macos"))]
    {
        base_data_dir().with_file_name("tugcast")
    }
}

/// Environment variable overriding the shared changes-ledger path.
/// Set by test harnesses (the app-test driver, the tugutil CLI suite)
/// so isolated runs never touch the user's real ledger.
pub const ENV_CHANGES_DB: &str = "TUG_CHANGES_DB";

/// The **machine-global** changes-ledger database path: one `changes.db`
/// for every app instance, holding the `file_events` attribution rows
/// keyed by canonical repo root. Deliberately independent of
/// `TUG_INSTANCE_ID` — the working tree is machine-global, so splitting
/// attribution per instance splits the truth (a second instance on the
/// same checkout would see the first's work as ownerless). Honors the
/// [`ENV_CHANGES_DB`] override for isolated test runs.
pub fn changes_db_path() -> PathBuf {
    if let Some(p) = env::var_os(ENV_CHANGES_DB).filter(|v| !v.is_empty()) {
        return guard_isolated(PathBuf::from(p));
    }
    guard_isolated(base_data_dir().join("changes.db"))
}

/// Environment variable overriding the shared prompt-history ledger path.
/// Set by test harnesses (the app-test driver, the tugutil CLI suite)
/// so isolated runs never touch the user's real prompt corpus.
pub const ENV_PROMPT_HISTORY_DB: &str = "TUG_PROMPT_HISTORY_DB";

/// The **machine-global** prompt-history ledger path: one
/// `prompt_history.db` for every app instance, holding one append-only row
/// per prompt the user has submitted. Deliberately independent of
/// `TUG_INSTANCE_ID` — the prompts are the user's corpus, not an
/// instance's, so partitioning per instance splits the truth (switching
/// from release to a debug build would present an empty recall history
/// while the release instance holds it all). Honors the
/// [`ENV_PROMPT_HISTORY_DB`] override for isolated test runs.
pub fn prompt_history_db_path() -> PathBuf {
    if let Some(p) = env::var_os(ENV_PROMPT_HISTORY_DB).filter(|v| !v.is_empty()) {
        return guard_isolated(PathBuf::from(p));
    }
    guard_isolated(base_data_dir().join("prompt_history.db"))
}

/// Environment variable overriding the shared app-test results ledger path.
/// Set by test harnesses (the tugutil CLI suite, the recipe's own
/// integration checks) so isolated runs never touch the real record.
pub const ENV_APPTEST_RESULTS_DB: &str = "TUG_APPTEST_RESULTS_DB";

/// The **machine-global** app-test results ledger path: one
/// `apptest_results.db` for every app instance, holding one row per file
/// per app-test run. Deliberately independent of `TUG_INSTANCE_ID` — the
/// question it answers ("was this file already red before I touched it?")
/// is about the checkout, not about which build was driving, so a run
/// recorded from a debug instance must answer a query made from the
/// release one. Honors the [`ENV_APPTEST_RESULTS_DB`] override for
/// isolated test runs.
pub fn apptest_results_db_path() -> PathBuf {
    if let Some(p) = env::var_os(ENV_APPTEST_RESULTS_DB).filter(|v| !v.is_empty()) {
        return guard_isolated(PathBuf::from(p));
    }
    guard_isolated(base_data_dir().join("apptest_results.db"))
}

/// Environment variable overriding the shared jots-file path.
/// Set by test harnesses so isolated runs never touch the user's real
/// jots file.
pub const ENV_JOTS_PATH: &str = "TUG_JOTS_PATH";

/// The **machine-global** jots file path: one `jots.json` for
/// every app instance, holding the user's reusable prompt fragments.
/// Deliberately independent of `TUG_INSTANCE_ID` — jots are the
/// user's phrasebook, the same across every build (debug, release, any
/// branch), so partitioning per instance would split the truth (a second
/// instance would see an empty list while the first holds the jots).
/// Honors the [`ENV_JOTS_PATH`] override for isolated test runs.
pub fn jots_path() -> PathBuf {
    if let Some(p) = env::var_os(ENV_JOTS_PATH).filter(|v| !v.is_empty()) {
        return guard_isolated(PathBuf::from(p));
    }
    guard_isolated(base_data_dir().join("jots.json"))
}

/// Per-instance tugbank notify socket path.
///
/// - With `TUG_INSTANCE_ID=<id>`: `$TMPDIR/tugbank-notify-<short_token>.sock`
/// - Without: legacy `$TMPDIR/tugbank-notify.sock`
///
/// Keyed on [`short_token`] rather than the raw ID so the path stays
/// under `sun_path`'s ~104-byte limit even for long IDs (the app-test
/// harness mints `apptest-<uuid>`). Swift's
/// `InstanceConfig.notifySocketPath` resolves the identical path.
///
/// `$TMPDIR` is the per-user runtime directory on macOS, picked up
/// via `std::env::temp_dir()`.
pub fn notify_socket_path() -> PathBuf {
    let dir = env::temp_dir();
    match short_token() {
        Some(tok) => dir.join(format!("tugbank-notify-{tok}.sock")),
        None => dir.join("tugbank-notify.sock"),
    }
}

/// Path to the per-instance bundle-path marker file.
///
/// Tugcast writes the absolute path of its containing app bundle to
/// this file on first launch when `TUG_BUNDLE_PATH` is set in the
/// environment. `tugutil host instance prune` later compares the marker
/// against the live filesystem to identify orphaned data dirs whose
/// bundles have been moved or removed.
///
/// The marker lives inside the data dir; without `TUG_INSTANCE_ID`
/// this returns the legacy `Tug/bundle-path` path, which no normal
/// flow writes — it exists for symmetry only.
pub fn bundle_path_marker() -> PathBuf {
    data_dir().join(BUNDLE_PATH_MARKER)
}

/// Read the path Swift passed via `TUG_BUNDLE_PATH`, if any.
///
/// Returns `None` when the variable is unset or empty.
pub fn bundle_path_from_env() -> Option<PathBuf> {
    env::var(ENV_BUNDLE_PATH)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Outcome of a [`write_bundle_path_marker`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerWrite {
    /// The marker did not exist (or differed from `path`) and was written.
    Written,
    /// The marker already contained `path` byte-for-byte; no write was performed.
    Unchanged,
    /// `TUG_INSTANCE_ID` or `TUG_BUNDLE_PATH` was unset; nothing was written.
    /// Tugcast launched standalone for testing falls into this branch.
    Skipped,
}

/// Write the per-instance bundle-path marker if both
/// `TUG_INSTANCE_ID` and `TUG_BUNDLE_PATH` are set.
///
/// Tugcast calls this once at startup, after creating the per-instance
/// data dir, so `tugutil host instance prune` (Step 14) has an anchor to
/// detect orphaned data dirs whose owning bundle has been moved or
/// removed.
///
/// To avoid needless filesystem churn (and to keep mtimes stable for
/// observers), the function reads the existing marker and skips the
/// write when its content already matches the desired path. Any I/O
/// error during the existence-check is treated as "marker absent" so
/// the next write attempt proceeds.
///
/// Returns a [`MarkerWrite`] describing what happened.
pub fn write_bundle_path_marker() -> std::io::Result<MarkerWrite> {
    let Some(bundle) = bundle_path_from_env() else {
        return Ok(MarkerWrite::Skipped);
    };
    if instance_id().is_none() {
        return Ok(MarkerWrite::Skipped);
    }

    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    let marker = dir.join(BUNDLE_PATH_MARKER);
    let desired = bundle.to_string_lossy().into_owned();

    if let Ok(existing) = std::fs::read_to_string(&marker)
        && existing == desired
    {
        return Ok(MarkerWrite::Unchanged);
    }

    std::fs::write(&marker, desired.as_bytes())?;
    Ok(MarkerWrite::Written)
}

/// The Tug application-data root — `<platform-data-dir>/Tug` — and the
/// single origin of every path in this module.
///
/// [`ENV_DATA_DIR`] relocates the platform data dir when set and non-empty;
/// `Tug` is still appended, so an override of `/tmp/x` yields `/tmp/x/Tug`.
/// Every other resolver in the workspace routes through here rather than
/// calling `dirs::data_dir()` itself, so one variable moves the whole tree
/// and a test run cannot reach live state through a forgotten call site.
pub fn base_data_dir() -> PathBuf {
    match env::var_os(ENV_DATA_DIR).filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir).join("Tug"),
        None => platform_data_root(),
    }
}

/// The user's real data root, ignoring [`ENV_DATA_DIR`]. The tripwire
/// measures against this; nothing else should call it.
fn platform_data_root() -> PathBuf {
    dirs::data_dir().unwrap_or_else(env::temp_dir).join("Tug")
}

/// Enforce [`ENV_TEST_ISOLATION`]: when the caller has asserted isolation,
/// a resolved path inside the user's real data root is a bug in the test's
/// environment, not something to write through.
///
/// Returns `path` unchanged in every other case, so the check costs one
/// env lookup on the normal path and is a no-op in the shipping app.
fn guard_isolated(path: PathBuf) -> PathBuf {
    if env::var_os(ENV_TEST_ISOLATION).is_none_or(|v| v.is_empty()) {
        return path;
    }
    let live = platform_data_root();
    assert!(
        !path.starts_with(&live),
        "{ENV_TEST_ISOLATION} is set, but {} resolved inside the live data root {}. \
         Set {ENV_DATA_DIR} to a scratch directory before resolving Tug paths.",
        path.display(),
        live.display(),
    );
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::ffi::OsString;

    /// RAII guard that restores `TUG_INSTANCE_ID` and `TUG_BUNDLE_PATH`
    /// to their original values when dropped. Tests that mutate the
    /// process environment use this so a panic mid-test cannot leak
    /// state into the next.
    struct EnvGuard {
        instance: Option<OsString>,
        bundle: Option<OsString>,
    }

    impl EnvGuard {
        fn snapshot() -> Self {
            Self {
                instance: env::var_os(ENV_INSTANCE_ID),
                bundle: env::var_os(ENV_BUNDLE_PATH),
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.instance {
                    Some(v) => env::set_var(ENV_INSTANCE_ID, v),
                    None => env::remove_var(ENV_INSTANCE_ID),
                }
                match &self.bundle {
                    Some(v) => env::set_var(ENV_BUNDLE_PATH, v),
                    None => env::remove_var(ENV_BUNDLE_PATH),
                }
            }
        }
    }

    fn set_instance(id: Option<&str>) {
        unsafe {
            match id {
                Some(v) => env::set_var(ENV_INSTANCE_ID, v),
                None => env::remove_var(ENV_INSTANCE_ID),
            }
        }
    }

    fn set_bundle(path: Option<&str>) {
        unsafe {
            match path {
                Some(v) => env::set_var(ENV_BUNDLE_PATH, v),
                None => env::remove_var(ENV_BUNDLE_PATH),
            }
        }
    }

    #[test]
    #[serial]
    fn instance_id_reads_env() {
        let _g = EnvGuard::snapshot();
        set_instance(Some("test-id"));
        assert_eq!(instance_id().as_deref(), Some("test-id"));
    }

    #[test]
    #[serial]
    fn instance_id_none_when_unset() {
        let _g = EnvGuard::snapshot();
        set_instance(None);
        assert_eq!(instance_id(), None);
    }

    #[test]
    #[serial]
    fn instance_id_none_when_empty() {
        let _g = EnvGuard::snapshot();
        set_instance(Some(""));
        assert_eq!(instance_id(), None);
    }

    #[test]
    #[serial]
    fn data_dir_with_instance_id_uses_instances_subdir() {
        let _g = EnvGuard::snapshot();
        set_instance(Some("debug-foo"));
        let dir = data_dir();
        assert!(
            dir.ends_with("Tug/instances/debug-foo"),
            "expected .../Tug/instances/debug-foo, got {}",
            dir.display()
        );
    }

    #[test]
    #[serial]
    fn data_dir_legacy_when_instance_id_unset() {
        let _g = EnvGuard::snapshot();
        set_instance(None);
        let dir = data_dir();
        assert!(
            dir.ends_with("Tug"),
            "expected legacy .../Tug, got {}",
            dir.display()
        );
    }

    #[test]
    #[serial]
    fn log_dir_is_under_data_dir() {
        let _g = EnvGuard::snapshot();
        set_instance(Some("debug-bar"));
        let dir = log_dir();
        assert!(dir.ends_with("Tug/instances/debug-bar/Logs"));
    }

    #[test]
    #[serial]
    fn log_dir_legacy_when_instance_id_unset() {
        let _g = EnvGuard::snapshot();
        set_instance(None);
        let dir = log_dir();
        assert!(dir.ends_with("Tug/Logs"));
    }

    #[test]
    #[serial]
    fn tugbank_and_sessions_db_paths_none_when_unset() {
        let _g = EnvGuard::snapshot();
        set_instance(None);
        assert_eq!(tugbank_db_path(), None);
        assert_eq!(sessions_db_path(), None);
    }

    #[test]
    #[serial]
    fn tugbank_and_sessions_db_paths_some_when_set() {
        let _g = EnvGuard::snapshot();
        set_instance(Some("debug-baz"));
        let tb = tugbank_db_path().expect("expected Some when ID set");
        let sl = sessions_db_path().expect("expected Some when ID set");
        assert!(tb.ends_with("Tug/instances/debug-baz/tugbank.db"));
        assert!(sl.ends_with("Tug/instances/debug-baz/sessions.db"));
    }

    /// Snapshot/restore for one arbitrary variable.
    struct VarGuard(&'static str, Option<OsString>);

    impl VarGuard {
        fn set(key: &'static str, value: Option<&std::path::Path>) -> Self {
            let g = Self(key, env::var_os(key));
            unsafe {
                match value {
                    Some(v) => env::set_var(key, v),
                    None => env::remove_var(key),
                }
            }
            g
        }
    }

    impl Drop for VarGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.1 {
                    Some(v) => env::set_var(self.0, v),
                    None => env::remove_var(self.0),
                }
            }
        }
    }

    /// The data root must be resolved in exactly one place. A crate that
    /// calls `dirs::data_dir()` or `dirs::home_dir()` itself is invisible
    /// to [`ENV_DATA_DIR`], so a test run resolves the user's live
    /// databases and a second process maps a live SQLite `-shm` — the
    /// shape of the tugcast SIGBUS crashes of 2026-08-02.
    #[test]
    fn no_ad_hoc_data_dir_resolution() {
        let crates_root = crate::source_scan::crates_root();
        let chokepoint = crates_root.join("tugcore/src/instance.rs");
        let mut offenders = Vec::new();
        for (path, production) in crate::source_scan::production_sources() {
            if path == chokepoint {
                continue;
            }
            // Comments and doc prose legitimately spell these out; only
            // code counts. `dirs::home_dir()` is deliberately NOT banned —
            // tilde expansion in path completion and permissions is a
            // different concern from the data root.
            for line in production.lines() {
                let code = line.trim_start();
                if code.starts_with("//") || code.starts_with('*') {
                    continue;
                }
                for call in ["dirs::data_dir(", "Application Support/Tug"] {
                    if code.contains(call) {
                        offenders.push(format!("{} ({call})", path.display()));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "data-root resolution outside tugcore::instance::base_data_dir — \
             route these through it so {ENV_DATA_DIR} moves the whole tree: {offenders:#?}"
        );
    }

    #[test]
    #[serial]
    fn data_dir_override_relocates_the_whole_tree() {
        let _e = EnvGuard::snapshot();
        let tmp = tempfile::tempdir().unwrap();
        let _d = VarGuard::set(ENV_DATA_DIR, Some(tmp.path()));
        let _i = VarGuard::set(ENV_TEST_ISOLATION, None);
        set_instance(Some("debug-relocated"));

        // `Tug` is still appended, so an override of `/x` yields `/x/Tug` —
        // the same contract tugcode's `tugDataRoot()` implements.
        assert_eq!(base_data_dir(), tmp.path().join("Tug"));
        for p in [
            data_dir(),
            changes_db_path(),
            jots_path(),
            prompt_history_db_path(),
        ] {
            assert!(p.starts_with(tmp.path()), "{} escaped", p.display());
        }
        assert!(
            sessions_db_path().unwrap().starts_with(tmp.path()),
            "sessions.db escaped the override"
        );
    }

    #[test]
    #[serial]
    #[should_panic(expected = "resolved inside the live data root")]
    fn tripwire_fires_when_isolation_is_asserted_but_unconfigured() {
        let _e = EnvGuard::snapshot();
        let _d = VarGuard::set(ENV_DATA_DIR, None);
        let _i = VarGuard::set(ENV_TEST_ISOLATION, Some(std::path::Path::new("1")));
        set_instance(Some("debug-tripwire"));
        // No ENV_DATA_DIR, so this resolves the user's real ledger directory.
        let _ = data_dir();
    }

    #[test]
    #[serial]
    fn tripwire_is_silent_when_the_path_is_redirected() {
        let _e = EnvGuard::snapshot();
        let tmp = tempfile::tempdir().unwrap();
        let _d = VarGuard::set(ENV_DATA_DIR, Some(tmp.path()));
        let _i = VarGuard::set(ENV_TEST_ISOLATION, Some(std::path::Path::new("1")));
        set_instance(Some("debug-quiet"));
        assert!(data_dir().starts_with(tmp.path()));
    }

    #[test]
    #[serial]
    fn resolve_sessions_db_prefers_override_then_instance() {
        let _e = EnvGuard::snapshot();
        let tmp = tempfile::tempdir().unwrap();
        let _d = VarGuard::set(ENV_DATA_DIR, Some(tmp.path()));
        let _i = VarGuard::set(ENV_TEST_ISOLATION, None);
        let seeded = tmp.path().join("seeded.db");
        let _s = VarGuard::set(ENV_SESSIONS_DB, Some(&seeded));
        set_instance(Some("debug-resolve"));
        assert_eq!(resolve_sessions_db_path(), Some(seeded));

        let _s2 = VarGuard::set(ENV_SESSIONS_DB, None);
        assert_eq!(resolve_sessions_db_path(), sessions_db_path());

        // With no instance, the legacy single-instance location — still
        // inside the override, so a test run never reaches the real one.
        set_instance(None);
        let legacy = resolve_sessions_db_path().unwrap();
        assert!(legacy.starts_with(tmp.path()), "{}", legacy.display());
        assert!(legacy.ends_with("sessions.db"));
    }

    /// Snapshot/restore for `TUG_JOTS_PATH` (not covered by `EnvGuard`).
    struct JotsEnvGuard(Option<OsString>);
    impl JotsEnvGuard {
        fn snapshot() -> Self {
            Self(env::var_os(ENV_JOTS_PATH))
        }
    }
    impl Drop for JotsEnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.0 {
                    Some(v) => env::set_var(ENV_JOTS_PATH, v),
                    None => env::remove_var(ENV_JOTS_PATH),
                }
            }
        }
    }

    #[test]
    #[serial]
    fn jots_path_default_is_machine_global_and_instance_independent() {
        let _g = EnvGuard::snapshot();
        let _s = JotsEnvGuard::snapshot();
        unsafe { env::remove_var(ENV_JOTS_PATH) };
        // Independent of TUG_INSTANCE_ID: same path with the ID set or unset.
        set_instance(None);
        let unset = jots_path();
        set_instance(Some("debug-foo"));
        let set = jots_path();
        assert_eq!(unset, set);
        assert!(set.ends_with("Tug/jots.json"));
    }

    #[test]
    #[serial]
    fn jots_path_env_override_wins() {
        let _s = JotsEnvGuard::snapshot();
        unsafe { env::set_var(ENV_JOTS_PATH, "/tmp/custom-jots.json") };
        assert_eq!(jots_path(), PathBuf::from("/tmp/custom-jots.json"));
    }

    #[test]
    #[serial]
    fn jots_path_ignores_empty_env() {
        let _s = JotsEnvGuard::snapshot();
        unsafe { env::set_var(ENV_JOTS_PATH, "") };
        assert!(jots_path().ends_with("Tug/jots.json"));
    }

    #[test]
    #[serial]
    fn prompt_history_db_path_default_is_machine_global_and_instance_independent() {
        let _g = EnvGuard::snapshot();
        let _s = VarGuard::set(ENV_PROMPT_HISTORY_DB, None);
        // Independent of TUG_INSTANCE_ID: same path with the ID set or unset.
        set_instance(None);
        let unset = prompt_history_db_path();
        set_instance(Some("debug-foo"));
        let set = prompt_history_db_path();
        assert_eq!(unset, set);
        assert!(set.ends_with("Tug/prompt_history.db"));
    }

    #[test]
    #[serial]
    fn prompt_history_db_path_env_override_wins() {
        let _s = VarGuard::set(
            ENV_PROMPT_HISTORY_DB,
            Some(std::path::Path::new("/tmp/custom-prompts.db")),
        );
        assert_eq!(
            prompt_history_db_path(),
            PathBuf::from("/tmp/custom-prompts.db")
        );
    }

    #[test]
    #[serial]
    fn prompt_history_db_path_ignores_empty_env() {
        let _s = VarGuard::set(ENV_PROMPT_HISTORY_DB, Some(std::path::Path::new("")));
        assert!(prompt_history_db_path().ends_with("Tug/prompt_history.db"));
    }

    #[test]
    #[serial]
    fn apptest_results_db_path_default_is_machine_global_and_instance_independent() {
        let _g = EnvGuard::snapshot();
        let _s = VarGuard::set(ENV_APPTEST_RESULTS_DB, None);
        set_instance(None);
        let unset = apptest_results_db_path();
        set_instance(Some("debug-foo"));
        let set = apptest_results_db_path();
        assert_eq!(unset, set);
        assert!(set.ends_with("Tug/apptest_results.db"));
    }

    #[test]
    #[serial]
    fn apptest_results_db_path_env_override_wins() {
        let _s = VarGuard::set(
            ENV_APPTEST_RESULTS_DB,
            Some(std::path::Path::new("/tmp/custom-apptest.db")),
        );
        assert_eq!(
            apptest_results_db_path(),
            PathBuf::from("/tmp/custom-apptest.db")
        );
    }

    #[test]
    #[serial]
    fn apptest_results_db_path_ignores_empty_env() {
        let _s = VarGuard::set(ENV_APPTEST_RESULTS_DB, Some(std::path::Path::new("")));
        assert!(apptest_results_db_path().ends_with("Tug/apptest_results.db"));
    }

    #[test]
    #[serial]
    fn notify_socket_path_suffixed_when_id_set() {
        let _g = EnvGuard::snapshot();
        set_instance(Some("debug-qux"));
        let sock = notify_socket_path();
        let name = sock.file_name().unwrap().to_str().unwrap();
        // Keyed on the short token, not the raw ID, so the path stays
        // under sun_path even for long IDs.
        let tok = short_token().unwrap();
        assert_eq!(name, format!("tugbank-notify-{tok}.sock"));
        // The token is fixed-width 8-hex, so the socket name length is
        // bounded regardless of how long the instance ID grows.
        assert_eq!(tok.len(), 8);
    }

    #[test]
    #[serial]
    fn short_token_and_tmux_label_track_instance_id() {
        let _g = EnvGuard::snapshot();
        set_instance(Some("apptest-27b5400c-7d5e-4a9a-99a0-4f787deb6d80"));
        let tok = short_token().expect("token when ID set");
        assert_eq!(tok.len(), 8);
        // Pinned vector. Swift's `InstanceConfig.shortToken` and the
        // app-test harness's `fnv1a.ts` must produce this same string
        // for this same id — three implementations addressing one
        // instance's resources cannot be allowed to drift silently.
        assert_eq!(tok, "a419f8f0");
        assert_eq!(tmux_socket_label().unwrap(), format!("tug-{tok}"));
        set_instance(None);
        assert_eq!(short_token(), None);
        assert_eq!(tmux_socket_label(), None);
    }

    #[test]
    #[serial]
    fn notify_socket_path_legacy_when_id_unset() {
        let _g = EnvGuard::snapshot();
        set_instance(None);
        let sock = notify_socket_path();
        let name = sock.file_name().unwrap().to_str().unwrap();
        assert_eq!(name, "tugbank-notify.sock");
    }

    #[test]
    #[serial]
    fn bundle_path_marker_under_data_dir() {
        let _g = EnvGuard::snapshot();
        set_instance(Some("debug-marker"));
        let marker = bundle_path_marker();
        assert!(marker.ends_with("Tug/instances/debug-marker/bundle-path"));
    }

    #[test]
    #[serial]
    fn bundle_path_from_env_reads_var() {
        let _g = EnvGuard::snapshot();
        set_bundle(Some("/Applications/Tug.app"));
        assert_eq!(
            bundle_path_from_env(),
            Some(PathBuf::from("/Applications/Tug.app"))
        );
    }

    #[test]
    #[serial]
    fn bundle_path_from_env_none_when_unset_or_empty() {
        let _g = EnvGuard::snapshot();
        set_bundle(None);
        assert_eq!(bundle_path_from_env(), None);
        set_bundle(Some(""));
        assert_eq!(bundle_path_from_env(), None);
    }

    #[test]
    #[serial]
    fn write_marker_skipped_when_env_unset() {
        let _e = EnvGuard::snapshot();
        let tmp = tempfile::tempdir().unwrap();
        let _h = VarGuard::set(ENV_DATA_DIR, Some(tmp.path()));
        set_instance(None);
        set_bundle(None);
        assert_eq!(write_bundle_path_marker().unwrap(), MarkerWrite::Skipped);
        set_instance(Some("debug-foo"));
        set_bundle(None);
        assert_eq!(write_bundle_path_marker().unwrap(), MarkerWrite::Skipped);
        set_instance(None);
        set_bundle(Some("/Applications/Tug.app"));
        assert_eq!(write_bundle_path_marker().unwrap(), MarkerWrite::Skipped);
    }

    #[test]
    #[serial]
    fn write_marker_writes_then_no_op_on_repeat() {
        let _e = EnvGuard::snapshot();
        let tmp = tempfile::tempdir().unwrap();
        let _h = VarGuard::set(ENV_DATA_DIR, Some(tmp.path()));
        set_instance(Some("debug-write"));
        set_bundle(Some("/Applications/Tug.app"));

        assert_eq!(write_bundle_path_marker().unwrap(), MarkerWrite::Written);
        let marker = bundle_path_marker();
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            "/Applications/Tug.app"
        );

        assert_eq!(write_bundle_path_marker().unwrap(), MarkerWrite::Unchanged);
    }

    #[test]
    #[serial]
    fn write_marker_rewrites_when_path_changes() {
        let _e = EnvGuard::snapshot();
        let tmp = tempfile::tempdir().unwrap();
        let _h = VarGuard::set(ENV_DATA_DIR, Some(tmp.path()));
        set_instance(Some("debug-rewrite"));
        set_bundle(Some("/Applications/Tug.app"));
        assert_eq!(write_bundle_path_marker().unwrap(), MarkerWrite::Written);

        set_bundle(Some("/Users/x/build/Tug.app"));
        assert_eq!(write_bundle_path_marker().unwrap(), MarkerWrite::Written);
        let marker = bundle_path_marker();
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            "/Users/x/build/Tug.app"
        );
    }
}
