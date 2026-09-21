//! Per-host Tug instance registry.
//!
//! Each running tugcast writes a single JSON record into
//! `$TMPDIR/tug-instances.json` describing its identity, claimed
//! ports, and parent bundle. The registry is the authoritative
//! "what's running right now" lookup for external tools — `tugtool host
//! tell`, `tugtool host instance list`, and Swift's CLI-discovery path
//! all read it without re-hashing.
//!
//! # Concurrency
//!
//! Read path: open the file read-only, `flock(LOCK_SH)`, parse,
//! prune dead entries on the in-memory copy, release the lock, return
//! the live set. The on-disk file is not modified.
//!
//! Write path: open the file read-write (creating it if necessary),
//! `flock(LOCK_EX)`, read current contents, prune dead entries,
//! upsert the supplied record, serialize to `<path>.tmp`, fsync,
//! `rename(2)` over the original. The rename is atomic on POSIX so
//! a reader cannot observe a half-written file. See [Q01] for the
//! decision rationale.
//!
//! # Liveness
//!
//! "Live" means `kill(pid, 0) == 0`. A `ESRCH` reply means the PID is
//! gone (process exited, system rebooted, …) and the entry is pruned.
//!
//! See `#registry-format` in the multi-instance design record
//! for the on-disk schema.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Filename used inside the per-user runtime directory.
pub const REGISTRY_FILENAME: &str = "tug-instances.json";

/// Filename of the advisory lockfile that serializes registry writes.
///
/// Concurrent writers all flock this file — never the data file
/// itself. `flock(2)` operates on the inode behind a file descriptor,
/// and `rename(2)` (used by `write_atomically`) replaces the data
/// file's inode. Locking the data file directly would silently allow
/// two writers to think they held the exclusive lock — each holding
/// it on a different (and possibly unlinked) inode. The lockfile is
/// never renamed, so flock semantics survive the atomic-rename.
pub const REGISTRY_LOCKFILE: &str = "tug-instances.json.lock";

/// Current on-disk schema version. Bumped only on incompatible
/// changes; readers tolerate forward-compatible additions inside the
/// `Instance` record.
pub const REGISTRY_VERSION: u32 = 1;

/// A single registered tugcast instance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Instance {
    /// Canonical per-instance identifier (`<profile>-<branch-slug>`).
    pub instance_id: String,
    /// Build profile (`release` or `debug`).
    pub profile: String,
    /// Branch the bundle was built from.
    pub branch: String,
    /// `CFBundleIdentifier` of the parent app bundle.
    pub bundle_id: String,
    /// Absolute path to the parent app bundle.
    pub bundle_path: PathBuf,
    /// Tugcast process PID.
    pub pid: i32,
    /// PID of the GUI host app (`Tug.app`) that spawned tugcast — its
    /// parent process. `0` when tugcast runs standalone (no GUI host)
    /// or when read from a registry entry written before this field
    /// existed. Teardown (`tugtool host instance stop`) signals the host so
    /// the app runs its own shutdown and tugcast follows via its
    /// parent-watch; signalling tugcast alone leaves the host window
    /// alive and stuck reconnecting.
    #[serde(default)]
    pub host_pid: i32,
    /// TCP port tugcast bound for HTTP/WS.
    pub tugcast_port: u16,
    /// TCP port Vite bound (or `0` when Vite is not running).
    pub vite_port: u16,
    /// Tmux session name tugcast attached to.
    pub tmux_session: String,
    /// Per-instance data directory.
    pub data_dir: PathBuf,
    /// ISO-8601 UTC timestamp of registration.
    pub started_at: String,
}

/// On-disk schema. Wrapped so the version is explicit.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    #[serde(default)]
    instances: Vec<Instance>,
}

impl Default for OnDisk {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            instances: Vec::new(),
        }
    }
}

/// Errors that can be returned by registry operations.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("unsupported registry version {0} (this build understands {REGISTRY_VERSION})")]
    UnsupportedVersion(u32),
}

/// Resolve the registry file path.
///
/// Lives next to other runtime sockets in `$TMPDIR` so the registry
/// is per-user and per-host. `$TMPDIR` is the macOS per-user runtime
/// directory; on Linux it resolves via `std::env::temp_dir`.
pub fn registry_path() -> PathBuf {
    std::env::temp_dir().join(REGISTRY_FILENAME)
}

/// Read all live instances. Returns an empty vec when the file does
/// not yet exist.
pub fn load() -> Result<Vec<Instance>, Error> {
    load_from(&registry_path())
}

/// Read live instances from an arbitrary registry path. Public for
/// tests; production code uses [`load`].
pub fn load_from(path: &Path) -> Result<Vec<Instance>, Error> {
    // Acquire a shared lock on the lockfile so we don't read a half-
    // written registry while a writer is in the middle of its
    // rename. Missing lockfile is treated as "no contention" — we
    // proceed to the read without locking; the worst case is a single
    // failed parse on the next call.
    let lock_path = lockfile_path(path);
    let _guard = LockFile::open_shared(&lock_path).ok();

    let file = match OpenOptions::new().read(true).open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let on_disk = read_on_disk(&file)?;
    Ok(on_disk
        .instances
        .into_iter()
        .filter(|i| is_pid_live(i.pid))
        .collect())
}

fn lockfile_path(registry_path: &Path) -> PathBuf {
    registry_path.with_file_name(REGISTRY_LOCKFILE)
}

/// Find the live instance with `instance_id`, if any.
pub fn find_by_id(instance_id: &str) -> Result<Option<Instance>, Error> {
    Ok(load()?.into_iter().find(|i| i.instance_id == instance_id))
}

/// Find the live instance whose `bundle_path` is an ancestor of `cwd`.
///
/// Used by `tugtool host tell` / `host ask` when no `--instance` flag is passed
/// and the shell is inside a worktree owned by a running dev instance. The
/// match is purely path-prefix based; the more sophisticated CLI
/// discovery resolution in [D09] layers on top of this primitive.
///
/// **Both sides are resolved before comparing.** A prefix test between one
/// resolved path and one raw path is not a comparison, it is a coin flip: on
/// macOS `realpath(3)` expands the APFS data-volume firmlink, so a `cwd` of
/// `/u/src/tugtool` resolves to `/System/Volumes/Data/Users/…` while a
/// `bundle_path` recorded as `/Users/…` stays put, and the two never match
/// however plainly they name the same directory. Resolving only the `cwd` — as
/// this did — turned that into a silent "no instance found" whenever the two
/// spellings disagreed.
///
/// This is bare `canonicalize` rather than [L29]'s `CanonicalPath::from_raw`
/// gateway because that gateway lives in `tugcast`, which depends on this crate.
/// It is safe here for the reason the law is strict elsewhere: these paths are
/// compared and discarded within the call — never persisted as a key, never
/// handed to Claude, whose on-disk layout is the form the gateway exists to
/// agree with. Symmetry is what makes the comparison sound.
pub fn find_for_cwd(cwd: &Path) -> Result<Option<Instance>, Error> {
    let resolved = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let base = linked_worktree_base(cwd).map(|p| resolved(&p));
    let cwd = resolved(cwd);
    Ok(load()?.into_iter().find(|i| {
        let bundle = resolved(&i.bundle_path);
        let touches = |c: &Path| c.starts_with(&bundle) || bundle.starts_with(c);
        touches(&cwd) || base.as_deref().is_some_and(touches)
    }))
}

/// The main checkout behind `cwd` when `cwd` sits inside a **linked git
/// worktree** — an arc — else `None`.
///
/// An arc worktree lives outside the checkout the instance was built from,
/// so the bundle-path prefix test in [`find_for_cwd`] can never match from
/// inside one: neither path contains the other. Discovery would fall
/// through to the sole-instance rule and error out with a second instance
/// running, which is how a shell in an arc lost its instance entirely.
///
/// The translation is pure filesystem, deliberately: a registry lookup must
/// not depend on `git` being on `PATH`. A linked worktree records
/// `gitdir: <path>` in a `.git` **file** (the main checkout's `.git` is a
/// directory, and `read_to_string` on it fails — the `None` that correctly
/// says "not a linked worktree"); that gitdir holds a `commondir` pointing
/// at the shared `.git`, whose parent is the main checkout.
///
/// Public because instance discovery is not its only consumer: `same_project`
/// in `tugcast::arc_api` resolves both sides of a bind through it, so a
/// session spawned in a checkout and a `tugtool arc` call made from inside
/// that checkout's arc worktree read as one project rather than two. One
/// translation, two callers — a second implementation would be a second
/// quiet path resolver.
pub fn linked_worktree_base(cwd: &Path) -> Option<PathBuf> {
    let dot_git = cwd
        .ancestors()
        .map(|d| d.join(".git"))
        .find(|p| p.exists())?;
    let gitdir = std::fs::read_to_string(&dot_git)
        .ok()?
        .lines()
        .find_map(|line| {
            line.strip_prefix("gitdir:")
                .map(|p| PathBuf::from(p.trim()))
        })?;
    let gitdir = match gitdir.is_absolute() {
        true => gitdir,
        false => dot_git.parent()?.join(gitdir),
    };
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = gitdir.join(common.trim()).canonicalize().ok()?;
    Some(common.parent()?.to_path_buf())
}

/// Alias for [`load`] — every instance returned by `load` is live by
/// definition. Provided so call sites can read more naturally.
pub fn list_live() -> Result<Vec<Instance>, Error> {
    load()
}

/// Upsert `instance` into the registry.
///
/// Replaces any existing entry that shares `instance.instance_id` —
/// e.g. a record left behind by a crashed predecessor whose PID has
/// since been recycled. The write is atomic; readers see either the
/// pre-call or post-call snapshot, never a partial write.
pub fn register(instance: Instance) -> Result<(), Error> {
    register_at(&registry_path(), instance)
}

/// Same as [`register`] but targets an arbitrary path. Tests use this
/// to avoid touching the real `$TMPDIR/tug-instances.json`.
pub fn register_at(path: &Path, instance: Instance) -> Result<(), Error> {
    let _guard = LockFile::open_exclusive(&lockfile_path(path))?;
    let mut on_disk = read_or_default(path)?;
    on_disk.version = REGISTRY_VERSION;
    on_disk.instances.retain(|i| {
        // Drop any prior entry for this identity AND any entry whose
        // PID no longer exists. The combination keeps the file small
        // and the listing accurate after a crash-and-recover cycle.
        i.instance_id != instance.instance_id && is_pid_live(i.pid)
    });
    on_disk.instances.push(instance);
    write_atomically(path, &on_disk)
}

/// Remove the entry whose `instance_id` matches, if present.
///
/// Used during graceful shutdown so a `tugtool host instance list`
/// immediately after the crash window does not show a stale entry
/// that would otherwise survive until the next register cycle.
pub fn unregister(instance_id: &str) -> Result<(), Error> {
    unregister_at(&registry_path(), instance_id)
}

/// Same as [`unregister`] but targets an arbitrary path.
pub fn unregister_at(path: &Path, instance_id: &str) -> Result<(), Error> {
    if !path.exists() {
        return Ok(());
    }
    let _guard = LockFile::open_exclusive(&lockfile_path(path))?;
    let mut on_disk = read_or_default(path)?;
    on_disk.version = REGISTRY_VERSION;
    let before = on_disk.instances.len();
    on_disk
        .instances
        .retain(|i| i.instance_id != instance_id && is_pid_live(i.pid));
    if on_disk.instances.len() == before
        && !on_disk
            .instances
            .iter()
            .any(|i| i.instance_id == instance_id)
    {
        // Nothing changed semantically; skip the rewrite to keep
        // mtime stable for observers.
        return Ok(());
    }
    write_atomically(path, &on_disk)
}

// ── Internals ────────────────────────────────────────────────────────────────

fn read_on_disk(mut file: &File) -> Result<OnDisk, Error> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if bytes.is_empty() {
        return Ok(OnDisk::default());
    }
    let parsed: OnDisk = serde_json::from_slice(&bytes)?;
    if parsed.version != REGISTRY_VERSION {
        return Err(Error::UnsupportedVersion(parsed.version));
    }
    Ok(parsed)
}

/// Read the registry file at `path`. Returns `OnDisk::default()`
/// when the file does not exist or is empty. Bubbles JSON parse and
/// version-mismatch errors so callers can surface them.
fn read_or_default(path: &Path) -> Result<OnDisk, Error> {
    match OpenOptions::new().read(true).open(path) {
        Ok(file) => read_on_disk(&file),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(OnDisk::default()),
        Err(e) => Err(e.into()),
    }
}

fn write_atomically(path: &Path, on_disk: &OnDisk) -> Result<(), Error> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut tmp_file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        let bytes = serde_json::to_vec_pretty(on_disk)?;
        tmp_file.write_all(&bytes)?;
        tmp_file.write_all(b"\n")?;
        tmp_file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn is_pid_live(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // `kill(pid, 0)` is the canonical "does this PID exist" probe
    // on POSIX: it sends no signal but returns ESRCH iff the PID
    // is gone. EPERM also implies "exists" (we're not allowed to
    // signal it, but the process is there).
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    let err = std::io::Error::last_os_error();
    err.raw_os_error() == Some(libc::EPERM)
}

/// RAII guard that opens a lockfile, holds an `flock` on it, and
/// releases the lock when dropped.
///
/// `LockFile` is the *only* correct way to serialize registry
/// writers because `flock(2)` operates on the inode behind a file
/// descriptor. The data file's inode is replaced by every
/// `write_atomically` (rename swaps inodes), so locking the data
/// file directly is a footgun: two writers can each "hold the
/// exclusive lock" on different inodes that the path used to point
/// at. The lockfile is never renamed, so its inode is stable across
/// writes and `flock` actually serializes.
struct LockFile {
    file: File,
}

impl LockFile {
    fn open_exclusive(path: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        flock(&file, libc::LOCK_EX)?;
        Ok(Self { file })
    }

    fn open_shared(path: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        flock(&file, libc::LOCK_SH)?;
        Ok(Self { file })
    }
}

impl Drop for LockFile {
    fn drop(&mut self) {
        let _ = flock(&self.file, libc::LOCK_UN);
    }
}

fn flock(file: &File, op: i32) -> std::io::Result<()> {
    // SAFETY: `file.as_raw_fd()` is a valid borrowed fd for the
    // lifetime of `file`; `flock` only stores the lock in the kernel
    // and does not retain the fd.
    let ret = unsafe { libc::flock(file.as_raw_fd(), op) };
    if ret == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Format a UTC RFC-3339 / ISO-8601 timestamp for the `started_at`
/// field. Free function so external callers do not need to take a
/// dependency on chrono to build an `Instance`.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::tempdir;

    fn fixture(instance_id: &str, pid: i32) -> Instance {
        Instance {
            instance_id: instance_id.to_owned(),
            profile: "debug".to_owned(),
            branch: instance_id.trim_start_matches("debug-").to_owned(),
            bundle_id: format!("dev.tugapp.app.{instance_id}"),
            bundle_path: PathBuf::from("/tmp/Tug.app"),
            pid,
            host_pid: 0,
            tugcast_port: 55300,
            vite_port: 55200,
            tmux_session: format!("cc-{instance_id}"),
            data_dir: PathBuf::from(format!("/tmp/data/{instance_id}")),
            started_at: now_rfc3339(),
        }
    }

    /// `kill(pid, 0)` against PID 1 is guaranteed to exist on POSIX
    /// (it's launchd / init) but the current process can't actually
    /// signal it — exercising the EPERM branch of `is_pid_live`.
    const ALIVE_PID: i32 = 1;
    const DEAD_PID: i32 = 0x3FFF_FFFE; // very unlikely to exist

    #[test]
    fn is_pid_live_recognises_init() {
        assert!(is_pid_live(ALIVE_PID));
    }

    #[test]
    fn is_pid_live_rejects_zero_or_negative() {
        assert!(!is_pid_live(0));
        assert!(!is_pid_live(-1));
    }

    #[test]
    fn round_trip_empty_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        // No file yet — load returns empty.
        assert!(load_from(&path).unwrap().is_empty());
    }

    #[test]
    fn register_then_find() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        register_at(&path, fixture("debug-foo", ALIVE_PID)).unwrap();
        let listed = load_from(&path).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instance_id, "debug-foo");
    }

    #[test]
    fn loads_legacy_entry_without_host_pid() {
        // A registry written by a binary that predates `host_pid` has
        // no such key. `#[serde(default)]` must let it deserialize with
        // `host_pid == 0` rather than failing the whole parse — during
        // an upgrade, old and new binaries share one registry file.
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        let legacy = r#"{"version":1,"instances":[{
            "instance_id":"debug-legacy","profile":"debug","branch":"legacy",
            "bundle_id":"dev.tugapp.app.debug","bundle_path":"/tmp/Tug.app",
            "pid":1,"tugcast_port":55300,"vite_port":55200,
            "tmux_session":"cc-legacy","data_dir":"/tmp/data/legacy",
            "started_at":"2026-01-01T00:00:00Z"}]}"#;
        std::fs::write(&path, legacy).unwrap();

        let listed = load_from(&path).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instance_id, "debug-legacy");
        assert_eq!(listed[0].host_pid, 0, "missing host_pid must default to 0");
    }

    #[test]
    fn register_replaces_existing_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        let mut a = fixture("debug-foo", ALIVE_PID);
        a.tugcast_port = 55310;
        register_at(&path, a).unwrap();

        let mut b = fixture("debug-foo", ALIVE_PID);
        b.tugcast_port = 55320;
        register_at(&path, b).unwrap();

        let listed = load_from(&path).unwrap();
        assert_eq!(listed.len(), 1, "expected upsert, got {listed:?}");
        assert_eq!(listed[0].tugcast_port, 55320);
    }

    #[test]
    fn load_prunes_dead_pids_in_memory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        // Write a dead entry directly (bypassing register, which
        // would prune at write time too).
        let on_disk = OnDisk {
            version: REGISTRY_VERSION,
            instances: vec![fixture("debug-foo", DEAD_PID)],
        };
        write_atomically(&path, &on_disk).unwrap();

        let listed = load_from(&path).unwrap();
        assert!(listed.is_empty(), "dead PID should be pruned");
        // The on-disk copy is untouched by a read-only load.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("debug-foo"));
    }

    #[test]
    fn register_prunes_dead_predecessors() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        let on_disk = OnDisk {
            version: REGISTRY_VERSION,
            instances: vec![
                fixture("debug-foo", DEAD_PID),
                fixture("debug-bar", DEAD_PID),
            ],
        };
        write_atomically(&path, &on_disk).unwrap();

        register_at(&path, fixture("debug-baz", ALIVE_PID)).unwrap();

        let listed = load_from(&path).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instance_id, "debug-baz");

        // After the write the dead entries should be physically gone.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("debug-foo"));
        assert!(!raw.contains("debug-bar"));
    }

    #[test]
    fn unregister_removes_entry() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        register_at(&path, fixture("debug-foo", ALIVE_PID)).unwrap();
        register_at(&path, fixture("debug-bar", ALIVE_PID)).unwrap();
        unregister_at(&path, "debug-foo").unwrap();

        let listed = load_from(&path).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instance_id, "debug-bar");
    }

    #[test]
    fn unregister_missing_is_noop() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        unregister_at(&path, "debug-foo").unwrap();
        assert!(load_from(&path).unwrap().is_empty());
    }

    #[test]
    fn load_returns_unsupported_version_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        std::fs::write(&path, br#"{"version": 9999, "instances": []}"#).unwrap();
        match load_from(&path) {
            Err(Error::UnsupportedVersion(9999)) => {}
            other => panic!("expected UnsupportedVersion, got {other:?}"),
        }
    }

    #[test]
    fn now_rfc3339_parses() {
        let s = now_rfc3339();
        chrono::DateTime::parse_from_rfc3339(&s).expect("parses");
    }

    /// `find_by_id` and `find_for_cwd` go through the public
    /// `registry_path()` so they touch the user's real `$TMPDIR`
    /// file. Serialize and snapshot so we don't leak state across
    /// runs.
    #[test]
    #[serial]
    fn find_by_id_round_trip_in_tmpdir() {
        let real = registry_path();
        let backup = std::fs::read(&real).ok();
        let _restore = scopeguard(|| match &backup {
            Some(bytes) => {
                let _ = std::fs::write(&real, bytes);
            }
            None => {
                let _ = std::fs::remove_file(&real);
            }
        });

        register(fixture("debug-find-by-id-test", ALIVE_PID)).unwrap();
        let got = find_by_id("debug-find-by-id-test").unwrap();
        assert!(got.is_some());
        unregister("debug-find-by-id-test").unwrap();
    }

    /// A shell inside an arc worktree still belongs to the instance
    /// built from the main checkout. Real `git worktree add` output, not
    /// a hand-built `.git` file: the pointer/`commondir` layout is
    /// exactly what this resolution reads, so a fixture that drifted
    /// from git's would test nothing.
    #[test]
    #[serial]
    fn find_for_cwd_reaches_through_a_linked_worktree() {
        let dir = tempdir().unwrap();
        let main = dir.path().join("checkout");
        let worktree = dir.path().join("arcs/tugcast-perf");
        std::fs::create_dir_all(&main).unwrap();
        let git = |args: &[&str]| {
            let ok = crate::git_command()
                .arg("-C")
                .arg(&main)
                .args(args)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(main.join("seed"), b"seed").unwrap();
        git(&["add", "seed"]);
        git(&["commit", "-qm", "seed"]);
        git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugarc/tugcast-perf",
            worktree.to_str().unwrap(),
        ]);

        let base = linked_worktree_base(&worktree).expect("worktree resolves to its checkout");
        assert_eq!(base.canonicalize().unwrap(), main.canonicalize().unwrap());
        // The main checkout is not a linked worktree and must say so.
        assert!(linked_worktree_base(&main).is_none());

        let real = registry_path();
        let backup = std::fs::read(&real).ok();
        let _restore = scopeguard(|| match &backup {
            Some(bytes) => {
                let _ = std::fs::write(&real, bytes);
            }
            None => {
                let _ = std::fs::remove_file(&real);
            }
        });
        // The bundle lives inside the checkout, as a dev build does —
        // the prefix match the worktree path alone could never satisfy.
        let bundle = main.join("tugapp/build/Tug.app");
        std::fs::create_dir_all(&bundle).unwrap();
        let mut instance = fixture("debug-worktree-test", ALIVE_PID);
        instance.bundle_path = bundle;
        register(instance).unwrap();

        let got = find_for_cwd(&worktree).unwrap();
        assert_eq!(
            got.map(|i| i.instance_id).as_deref(),
            Some("debug-worktree-test"),
            "an arc worktree must resolve to the instance holding its checkout"
        );
        unregister("debug-worktree-test").unwrap();
    }

    /// Tiny scoped-defer helper: returns a guard that runs `f` on
    /// drop. Local to this module to keep the public API surface
    /// clean.
    struct Guard<F: FnMut()>(Option<F>);
    impl<F: FnMut()> Drop for Guard<F> {
        fn drop(&mut self) {
            if let Some(mut f) = self.0.take() {
                f();
            }
        }
    }
    fn scopeguard<F: FnMut()>(f: F) -> Guard<F> {
        Guard(Some(f))
    }

    /// Two threads racing on `register_at` against the same path
    /// must both end up in the resulting file. This is the
    /// regression test for the rename-breaks-flock bug — a previous
    /// implementation locked the data file directly, which silently
    /// allowed both writers to think they held the exclusive lock
    /// (each on a different inode after the atomic rename).
    #[test]
    fn concurrent_register_keeps_both_entries() {
        use std::thread;

        let dir = tempdir().unwrap();
        let path = dir.path().join("reg.json");
        // Spawn many writer pairs so contention is high; flake-free
        // even at very high contention is the point.
        for round in 0..16 {
            std::fs::remove_file(&path).ok();
            let path_a = path.clone();
            let path_b = path.clone();
            let t_a = thread::spawn(move || {
                let mut inst = fixture("debug-A", ALIVE_PID);
                inst.tugcast_port = 10000 + round;
                register_at(&path_a, inst).unwrap();
            });
            let t_b = thread::spawn(move || {
                let mut inst = fixture("debug-B", ALIVE_PID);
                inst.tugcast_port = 20000 + round;
                register_at(&path_b, inst).unwrap();
            });
            t_a.join().unwrap();
            t_b.join().unwrap();
            let listed = load_from(&path).unwrap();
            let ids: std::collections::BTreeSet<_> =
                listed.iter().map(|i| i.instance_id.clone()).collect();
            assert!(
                ids.contains("debug-A") && ids.contains("debug-B"),
                "round {round}: lost an entry — got {ids:?}"
            );
        }
    }
}
