//! Machine-wide janitor for vestigial Tug runtime debris.
//!
//! Every runtime resource a Tug instance creates — its data dir, its
//! control socket, its private tmux server, the temp files its tests
//! mint — has an owner that releases it on *graceful* shutdown. But the
//! routine ending for an app-test instance is SIGKILL (the harness's
//! escalation ladder, the recipe's `pkill` backstop), which skips every
//! owner epilogue. And because each launch mints a unique name
//! (`apptest-<slug>-<uuid>` → per-launch sockets, data dirs, and tmux
//! tokens), a leak never collides with a future run, so nothing ever
//! notices it.
//!
//! A 2026-08-02 audit of one developer machine found what that adds up
//! to: 9,833 dead `tugcast-ctl-*.sock` files, 8,765 stray test changes
//! DBs (146 MB), 188 of 201 instance data dirs orphaned (726 MB), 130
//! screenshot PNGs (121 MB), and a live orphan tmux server that had been
//! idling for 20 hours.
//!
//! This module is the backstop for the case ownership cannot cover. Its
//! discipline: **never delete by name pattern alone.** Each class is
//! gated by the strongest liveness signal available to it — a
//! `connect()` probe for sockets, a registry lookup for tmux servers and
//! data dirs — and age is a gate only for inert litter that nothing can
//! be asked about. Registry-gated deletions additionally sit behind
//! [`MIN_DEBRIS_AGE_SECS`], because a booting instance is invisible to
//! the registry until after its port bind and would otherwise look
//! exactly like an orphan.

use std::fs;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// What one sweep pass removed.
#[derive(Debug, Default, serde::Serialize)]
pub struct SweepReport {
    pub dead_sockets: Vec<PathBuf>,
    pub tmux_servers_killed: Vec<String>,
    /// Socket inodes with no server behind them. A socket removed as
    /// part of killing a live server is not counted here — that server
    /// appears in `tmux_servers_killed` instead.
    pub tmux_sockets_unlinked: Vec<PathBuf>,
    pub tmp_files_removed: Vec<PathBuf>,
    pub tmp_dirs_removed: Vec<PathBuf>,
    pub apptest_data_dirs_removed: Vec<String>,
    pub processes_killed: Vec<(i32, String)>,
    pub legacy_sessions_killed: Vec<String>,
}

impl SweepReport {
    /// True when the sweep found nothing to reclaim.
    pub fn is_empty(&self) -> bool {
        self.dead_sockets.is_empty()
            && self.tmux_servers_killed.is_empty()
            && self.tmux_sockets_unlinked.is_empty()
            && self.tmp_files_removed.is_empty()
            && self.tmp_dirs_removed.is_empty()
            && self.apptest_data_dirs_removed.is_empty()
            && self.processes_killed.is_empty()
            && self.legacy_sessions_killed.is_empty()
    }
}

/// Whether a sweep pass acts on its findings or only names them.
///
/// Classification is identical in both modes — `Report` runs every
/// probe and every gate, then stops short of the deletion — so a report
/// is an honest preview of what an apply would do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweepMode {
    Report,
    Apply,
}

impl SweepMode {
    fn applies(self) -> bool {
        matches!(self, SweepMode::Apply)
    }
}

/// What a registered temp artifact is, which decides how it is probed
/// and how it is removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmpKind {
    File,
    Dir,
    /// Either — the class changed shape over time and both forms may
    /// still be on disk.
    Any,
    Socket,
}

/// One registered temp-artifact class.
pub struct TmpPrefix {
    /// Leading characters of the artifact's basename.
    pub prefix: &'static str,
    pub kind: TmpKind,
    /// Require four ASCII digits immediately after the prefix. Set for
    /// the short prefixes minted from app-test numbers (`at0275-…`),
    /// which would otherwise match unrelated names like `atelier-…`.
    pub numbered: bool,
}

const fn any(prefix: &'static str) -> TmpPrefix {
    TmpPrefix {
        prefix,
        kind: TmpKind::Any,
        numbered: false,
    }
}

const fn file(prefix: &'static str) -> TmpPrefix {
    TmpPrefix {
        prefix,
        kind: TmpKind::File,
        numbered: false,
    }
}

const fn dir(prefix: &'static str) -> TmpPrefix {
    TmpPrefix {
        prefix,
        kind: TmpKind::Dir,
        numbered: false,
    }
}

const fn socket(prefix: &'static str) -> TmpPrefix {
    TmpPrefix {
        prefix,
        kind: TmpKind::Socket,
        numbered: false,
    }
}

const fn numbered_dir(prefix: &'static str) -> TmpPrefix {
    TmpPrefix {
        prefix,
        kind: TmpKind::Dir,
        numbered: true,
    }
}

/// The registered temp-artifact manifest. Every Tug component that
/// mints a path under `$TMPDIR` declares its prefix here; the sweep and
/// the `no_unregistered_tmp_prefixes` tripwire both read this list, so a
/// new debris class cannot be invented unswept.
///
/// Matching is longest-prefix-first, which is what keeps
/// `tugapp-test-tugbank-*.db` files out of the `tugapp-test-*.sock`
/// candidate set.
pub const TMP_PREFIXES: &[TmpPrefix] = &[
    // Sockets — probed, never age-gated.
    socket("tugcast-ctl-"),
    socket("tugbank-notify-"),
    // `notify_socket_path()` falls back to this bare name when no
    // instance id is set, which the dashed prefix does not match.
    socket("tugbank-notify.sock"),
    socket("tugapp-test-"),
    // Files.
    // A per-spawn directory today; a bare `.db` triple in anything
    // left over from before the tests owned their own TempDir.
    any("tugcast-test-changes-"),
    file("tugcode-test-tugbank-"),
    file("tugapp-test-tugbank-"),
    file("tugapp-screenshot-"),
    file("tugcast-prompt-cache-"),
    file("drift-differ-test-"),
    file("tuggram-files-positional-"),
    // The PreToolUse gate's "the running instance predates the turn-boundary
    // op" notice, said once per boot rather than on every edit. Sweeping it is
    // correct: the notice returning after a sweep costs a line and points at
    // the restart that would fix the skew for good.
    file("tug-turn-boundary-skew-warned"),
    // Directories.
    dir("tug-probe-"),
    // `testTmpDir()` in the app-test harness.
    dir("tug-scratch-"),
    dir("tugcast-capture-"),
    dir("tugcast-local-model-test-"),
    dir("tugcast-overview-"),
    dir("tugcast-l29-root-"),
    dir("tugcast-retro-dedup-"),
    dir("tugcast-drift-"),
    dir("tugcast-dispatch-test-models"),
    numbered_dir("tug-at"),
    numbered_dir("at"),
];

/// Inert litter older than this is debris. Nothing reads a test
/// artifact across a day-long gap: the machine-wide gate serializes
/// app-test runs and a cargo test is minutes.
pub const TMP_DEBRIS_MAX_AGE_SECS: u64 = 24 * 60 * 60;

/// Nothing younger than this is a candidate for a deletion gated by a
/// registry lookup rather than by a probe.
///
/// A socket answers for itself instantly; the registry does not. A
/// booting instance writes its bundle-path marker near the top of
/// tugcast startup but cannot register until after its port bind, so
/// for a real interval it owns a data dir and a tmux server while
/// looking exactly like an orphan. This floor is what keeps an
/// unattended sweep from deleting it.
pub const MIN_DEBRIS_AGE_SECS: u64 = 10 * 60;

/// Suffix marking a data dir that has passed every gate and is being
/// deleted. The rename is what makes an interrupted deletion recoverable
/// — see [`sweep_apptest_data_dirs`].
pub const CONDEMNED_SUFFIX: &str = ".tug-deleting";

/// Remove age-expired inert litter under `tmp` for every `File`/`Dir`
/// manifest entry. `Socket` entries are skipped here — they are probed,
/// not aged.
pub fn sweep_tmp_debris(
    tmp: &Path,
    max_age: Duration,
    mode: SweepMode,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let Ok(entries) = fs::read_dir(tmp) else {
        return (files, dirs);
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(spec) = match_prefix(name) else {
            continue;
        };
        if spec.kind == TmpKind::Socket {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !older_than(&meta, max_age) {
            continue;
        }
        match spec.kind {
            TmpKind::File if meta.is_file() => {
                if !mode.applies() || fs::remove_file(&path).is_ok() {
                    files.push(path);
                }
            }
            TmpKind::Dir if meta.is_dir() => {
                if !mode.applies() || fs::remove_dir_all(&path).is_ok() {
                    dirs.push(path);
                }
            }
            TmpKind::Any if meta.is_dir() => {
                if !mode.applies() || fs::remove_dir_all(&path).is_ok() {
                    dirs.push(path);
                }
            }
            TmpKind::Any if meta.is_file() => {
                if !mode.applies() || fs::remove_file(&path).is_ok() {
                    files.push(path);
                }
            }
            _ => {}
        }
    }
    (files, dirs)
}

/// Unlink socket files under `tmp` that no listener answers for.
///
/// Three gates, not one. The `connect()` probe alone is **not** a
/// sufficient liveness test on macOS: a live `AF_UNIX` listener whose
/// backlog is full answers `connect()` with `ECONNREFUSED`, exactly as a
/// dead socket file does (measured — the errno is indistinguishable, and
/// it appears at backlog+1 connections). So a candidate must also (a)
/// not belong to a live registered instance's namespace and (b) be older
/// than `min_age`, which is what rules out both a saturated live server
/// and one that is still mid-boot.
///
/// A failed registry read aborts the pass rather than treating every
/// instance as absent — a blind sweep is worse than no sweep.
pub fn sweep_dead_sockets(tmp: &Path, min_age: Duration, mode: SweepMode) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let Ok(live) = crate::registry::list_live() else {
        return removed;
    };
    let protected = live_socket_names(&live);

    let Ok(entries) = fs::read_dir(tmp) else {
        return removed;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(spec) = match_prefix(name) else {
            continue;
        };
        if spec.kind != TmpKind::Socket || protected.contains(name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        // A non-socket file wearing a socket prefix is not ours to probe.
        if !meta.file_type().is_socket() || !older_than(&meta, min_age) {
            continue;
        }
        match UnixStream::connect(&path) {
            // Answered — drop the connection immediately and move on.
            Ok(stream) => drop(stream),
            Err(e) => {
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) && (!mode.applies() || fs::remove_file(&path).is_ok())
                {
                    removed.push(path);
                }
            }
        }
    }
    removed
}

/// Remove data dirs of app-test instances that are provably finished.
///
/// Mirrors the data-only branch of `tugtool host instance prune`: the
/// dir name must be an app-test id, the registry must have no live
/// entry, the bundle-path marker must resolve to a bundle that still
/// exists, and the dir must have aged past `min_age`. Marker-missing and
/// bundle-missing dirs are deliberately left alone — those need the
/// *full* removal path, which also has LaunchServices bookkeeping to do.
///
/// The age floor is not belt-and-braces. `write_bundle_path_marker()`
/// runs near the top of tugcast startup while `registry::register` waits
/// on the port bind, so between the two a live, booting instance owns a
/// data dir and has no registry entry — the orphan signature exactly.
pub fn sweep_apptest_data_dirs(
    instances_root: &Path,
    min_age: Duration,
    mode: SweepMode,
) -> Vec<String> {
    let mut removed = Vec::new();
    let Ok(live) = crate::registry::list_live() else {
        return removed;
    };
    let live_ids: std::collections::HashSet<String> =
        live.into_iter().map(|i| i.instance_id).collect();
    let Ok(entries) = fs::read_dir(instances_root) else {
        return removed;
    };

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        // Finish a removal something interrupted. A condemned directory
        // was already gated when it was renamed, so it needs no further
        // checks — and it must NOT be age-gated, because the rename
        // freshened its mtime.
        if id.ends_with(CONDEMNED_SUFFIX) {
            if mode.applies() {
                let _ = fs::remove_dir_all(&dir);
            }
            continue;
        }
        if !crate::ports::is_apptest_id(&id) || live_ids.contains(&id) {
            continue;
        }
        let marker = dir.join(crate::instance::BUNDLE_PATH_MARKER);
        let Ok(bundle) = fs::read_to_string(&marker) else {
            continue;
        };
        if !Path::new(bundle.trim()).exists() {
            continue;
        }
        let old_enough = fs::symlink_metadata(&dir)
            .map(|m| older_than(&m, min_age))
            .unwrap_or(false);
        if !old_enough {
            continue;
        }
        if !mode.applies() {
            removed.push(id);
            continue;
        }
        crate::instance::reap_instance_tmux(&id);
        // Condemn by rename first, then delete. `remove_dir_all` walks
        // in readdir order, so an interrupted delete can take the
        // bundle-path marker out before the bulk of the tree — and a
        // marker-less `apptest-*` directory is skipped by this sweep AND
        // by `instance prune`, which would leave a directory nothing
        // could ever reclaim. Renaming is atomic: after it, the entry is
        // out of the instance namespace and self-evidently condemned, so
        // the next sweep finishes the job whatever happened to us.
        let condemned = dir.with_file_name(format!("{id}{CONDEMNED_SUFFIX}"));
        if fs::rename(&dir, &condemned).is_ok() {
            let _ = fs::remove_dir_all(&condemned);
            removed.push(id);
        } else if fs::remove_dir_all(&dir).is_ok() {
            removed.push(id);
        }
    }
    removed
}

/// One row of `ps` output, as the process classifier sees it.
pub(crate) struct ProcRow {
    pub pid: i32,
    pub ppid: i32,
    pub elapsed: Duration,
    pub command: String,
}

/// True when a process is Tug's to reap: a `tugcode` or stream-json
/// `claude` that has been reparented to launchd, meaning whatever
/// spawned it is gone.
///
/// PPID 1 is a liveness-adjacent fact, not a heuristic — these binaries
/// are always spawned as children of tugcast or the GUI host, so
/// reparenting means the owner died. It is the process-world analogue of
/// a socket with no listener.
pub(crate) fn is_reparented_orphan(row: &ProcRow, min_age: Duration) -> bool {
    if row.ppid != 1 || row.pid <= 1 {
        return false;
    }
    if row.elapsed < min_age {
        return false;
    }
    is_orphan_command(&row.command)
}

/// Match on the **executable**, never on the whole command line.
///
/// `ps … command=` prints the binary followed by its arguments, and a
/// substring test over that whole string is far too eager: `~/.claude/`
/// appears in the path of anything Claude Code runs, and an argument can
/// name `tugcode` without being it (`bun build ./tugcode`). Either would
/// take a SIGKILL. Only the first token is the process's identity.
fn is_orphan_command(command: &str) -> bool {
    let exe = command
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .rsplit('/')
        .next()
        .unwrap_or_default();
    if exe == "tugcode" {
        return true;
    }
    // The stream-json arm stays argument-sensitive on purpose: an
    // interactive `claude` is a user's session, and only the
    // stream-json flavour is ours to reap.
    exe == "claude" && command.contains("stream-json")
}

/// SIGTERM (then SIGKILL) reparented tugcode/claude processes.
pub fn sweep_reparented_processes(min_age: Duration, mode: SweepMode) -> Vec<(i32, String)> {
    let mut killed = Vec::new();
    for row in ps_rows() {
        if !is_reparented_orphan(&row, min_age) {
            continue;
        }
        if !mode.applies() {
            killed.push((row.pid, row.command));
            continue;
        }
        // Identity-checked kills: a PID is recycled the instant its
        // process dies, so re-read the command immediately before
        // signalling rather than trusting the snapshot.
        if !process_command(row.pid).is_some_and(|c| is_orphan_command(&c)) {
            continue;
        }
        // SAFETY: kill(2) on a pid we just verified; a failure is
        // reported through errno, which we ignore deliberately.
        unsafe { libc::kill(row.pid, libc::SIGTERM) };
        std::thread::sleep(Duration::from_millis(500));
        if process_command(row.pid).is_some_and(|c| is_orphan_command(&c)) {
            unsafe { libc::kill(row.pid, libc::SIGKILL) };
        }
        killed.push((row.pid, row.command));
    }
    killed
}

fn ps_rows() -> Vec<ProcRow> {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-eo", "pid=,ppid=,etime=,command="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_ps_row)
        .collect()
}

/// Parse one `pid ppid etime command` line.
pub(crate) fn parse_ps_row(line: &str) -> Option<ProcRow> {
    // `ps` pads its numeric columns, so fields are taken one at a time
    // and the command is whatever remains — it contains spaces itself.
    let mut rest = line;
    let pid = next_field(&mut rest)?.parse().ok()?;
    let ppid = next_field(&mut rest)?.parse().ok()?;
    let elapsed = parse_etime(next_field(&mut rest)?)?;
    let command = rest.trim();
    (!command.is_empty()).then(|| ProcRow {
        pid,
        ppid,
        elapsed,
        command: command.to_string(),
    })
}

/// Take the next whitespace-delimited field, advancing `s` past it.
fn next_field<'a>(s: &mut &'a str) -> Option<&'a str> {
    let trimmed = s.trim_start();
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let (field, tail) = trimmed.split_at(end);
    *s = tail;
    (!field.is_empty()).then_some(field)
}

/// `ps` elapsed time: `[[DD-]HH:]MM:SS`.
pub(crate) fn parse_etime(raw: &str) -> Option<Duration> {
    let (days, clock) = match raw.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().ok()?, rest),
        None => (0, raw),
    };
    let mut secs = 0u64;
    for field in clock.split(':') {
        secs = secs * 60 + field.parse::<u64>().ok()?;
    }
    Some(Duration::from_secs(days * 86_400 + secs))
}

fn process_command(pid: i32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let cmd = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!cmd.is_empty()).then_some(cmd)
}

/// The tmux socket directory tmux itself would use.
pub fn tmux_socket_dir() -> PathBuf {
    let base = std::env::var_os("TMUX_TMPDIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    // SAFETY: getuid is always safe.
    base.join(format!("tmux-{}", unsafe { libc::getuid() }))
}

/// Production composition: every pass, bound to the real roots and the
/// real age constants.
pub fn sweep_all(mode: SweepMode) -> SweepReport {
    let tmp = std::env::temp_dir();
    let max_age = Duration::from_secs(TMP_DEBRIS_MAX_AGE_SECS);
    let min_age = Duration::from_secs(MIN_DEBRIS_AGE_SECS);

    let (tmp_files_removed, tmp_dirs_removed) = sweep_tmp_debris(&tmp, max_age, mode);
    let dead_sockets = sweep_dead_sockets(&tmp, min_age, mode);
    let (tmux_servers_killed, tmux_sockets_unlinked) =
        sweep_tmux_servers(&tmux_socket_dir(), min_age, mode);
    let apptest_data_dirs_removed =
        sweep_apptest_data_dirs(&crate::instances_root(), min_age, mode);
    let processes_killed = sweep_reparented_processes(min_age, mode);
    let legacy_sessions_killed = sweep_legacy_default_sessions(min_age, mode);

    SweepReport {
        dead_sockets,
        tmux_servers_killed,
        tmux_sockets_unlinked,
        tmp_files_removed,
        tmp_dirs_removed,
        apptest_data_dirs_removed,
        processes_killed,
        legacy_sessions_killed,
    }
}

/// What the tmux ladder decided about one `tug-*` socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TmuxVerdict {
    /// No server answers — the socket file is a dead inode.
    UnlinkDeadSocket,
    /// Every session is an app-test session, none of them belongs to a
    /// live instance, and the socket has aged past the floor.
    KillServer,
    Skip,
}

/// The classification half of the tmux sweep, pure so the ladder can be
/// tested without a registry or a real tmux server.
///
/// `sessions` is `None` when `list-sessions` failed (no server).
pub(crate) fn classify_tmux_server(
    sessions: Option<&[String]>,
    is_live: &dyn Fn(&str) -> bool,
    old_enough: bool,
) -> TmuxVerdict {
    let Some(sessions) = sessions else {
        return TmuxVerdict::UnlinkDeadSocket;
    };
    // A dev/release/user server is never a candidate, whatever its age.
    if sessions.iter().any(|s| !s.starts_with("cc-apptest-")) {
        return TmuxVerdict::Skip;
    }
    // An in-flight run owns its server.
    if sessions
        .iter()
        .any(|s| is_live(s.strip_prefix("cc-").unwrap_or(s)))
    {
        return TmuxVerdict::Skip;
    }
    // A session-less server is reapable ONLY because of this gate. The
    // recipe's old shell reaper treated an empty server as reapable
    // outright, justified by the app-test gate guaranteeing no other run
    // was live during a sweep. The sweep now also runs from tugcast
    // startup, outside that gate, so the guarantee is gone and the age
    // floor is what replaces it.
    if !old_enough {
        return TmuxVerdict::Skip;
    }
    TmuxVerdict::KillServer
}

/// Kill orphaned per-instance tmux servers under `tmux_dir` and unlink
/// dead socket inodes, per [`classify_tmux_server`].
///
/// `tmux_dir` is the `tmux-<uid>` directory itself — a *different*
/// directory from `$TMPDIR`. `tmux -L <label>` resolves its socket
/// directory from the `TMUX_TMPDIR` environment variable, never from an
/// argument, so every spawned command carries `TMUX_TMPDIR` set to
/// `tmux_dir`'s parent. Without that the parameter would be decorative
/// and a test aimed at a fixture would operate on the developer's real
/// servers.
pub fn sweep_tmux_servers(
    tmux_dir: &Path,
    min_age: Duration,
    mode: SweepMode,
) -> (Vec<String>, Vec<PathBuf>) {
    let mut killed = Vec::new();
    let mut unlinked = Vec::new();
    let Ok(live) = crate::registry::list_live() else {
        return (killed, unlinked);
    };
    let live_ids: std::collections::HashSet<String> =
        live.into_iter().map(|i| i.instance_id).collect();
    let Some(tmpdir) = tmux_dir.parent().map(Path::to_path_buf) else {
        return (killed, unlinked);
    };
    let Ok(entries) = fs::read_dir(tmux_dir) else {
        return (killed, unlinked);
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(label) = name.to_str() else { continue };
        if !label.starts_with("tug-") {
            continue;
        }
        let path = entry.path();
        let old_enough = fs::symlink_metadata(&path)
            .map(|m| older_than(&m, min_age))
            .unwrap_or(false);
        let sessions = tmux_sessions(&tmpdir, label);
        let verdict = classify_tmux_server(
            sessions.as_deref(),
            &|id: &str| live_ids.contains(id),
            old_enough,
        );
        match verdict {
            TmuxVerdict::Skip => {}
            TmuxVerdict::UnlinkDeadSocket => {
                if !mode.applies() || fs::remove_file(&path).is_ok() {
                    unlinked.push(path);
                }
            }
            TmuxVerdict::KillServer => {
                killed.push(label.to_string());
                if !mode.applies() {
                    continue;
                }
                let _ = tmux(&tmpdir).args(["-L", label, "kill-server"]).output();
                // Not recorded in `tmux_sockets_unlinked`: killing the
                // server is the reclamation, and whether tmux tidies its
                // own socket on the way out is an implementation detail
                // nobody can predict from Report mode. Reporting it
                // there and not here — or the reverse — would make the
                // preview disagree with the run.
                if path.exists() {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    (killed, unlinked)
}

/// True when a `cc-*` session on the shared *default* tmux server has
/// no live owner and has aged past the floor.
pub(crate) fn legacy_session_reapable(
    name: &str,
    age: Duration,
    min_age: Duration,
    is_live: &dyn Fn(&str) -> bool,
) -> bool {
    let Some(id) = name.strip_prefix("cc-") else {
        return false;
    };
    !is_live(id) && age >= min_age
}

/// Kill `cc-<id>` sessions left on the shared default tmux server by
/// pre-isolation builds. Every current instance owns a private
/// `tug-<token>` server, so anything still here outlived the scheme.
pub fn sweep_legacy_default_sessions(min_age: Duration, mode: SweepMode) -> Vec<String> {
    let mut killed = Vec::new();
    let Ok(live) = crate::registry::list_live() else {
        return killed;
    };
    let live_ids: std::collections::HashSet<String> =
        live.into_iter().map(|i| i.instance_id).collect();

    let Ok(out) = std::process::Command::new(crate::instance::tmux_bin())
        .args(["list-sessions", "-F", "#S #{session_created}"])
        .output()
    else {
        return killed;
    };
    if !out.status.success() {
        return killed;
    }
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((name, created)) = line.trim().rsplit_once(' ') else {
            continue;
        };
        let age = created
            .parse::<u64>()
            .map(|c| Duration::from_secs(now.saturating_sub(c)))
            .unwrap_or_default();
        if !legacy_session_reapable(name, age, min_age, &|id| live_ids.contains(id)) {
            continue;
        }
        killed.push(name.to_string());
        if mode.applies() {
            let _ = std::process::Command::new(crate::instance::tmux_bin())
                .args(["kill-session", "-t", name])
                .output();
        }
    }
    killed
}

/// A tmux command pointed at `tmpdir` (the parent of `tmux-<uid>`).
fn tmux(tmpdir: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(crate::instance::tmux_bin());
    cmd.env("TMUX_TMPDIR", tmpdir);
    cmd
}

/// Session names on the server behind `label`, or `None` when no server
/// answers.
fn tmux_sessions(tmpdir: &Path, label: &str) -> Option<Vec<String>> {
    let out = tmux(tmpdir)
        .args(["-L", label, "list-sessions", "-F", "#S"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// Socket basenames belonging to live registered instances, which are
/// never candidates whatever a probe says.
fn live_socket_names(live: &[crate::registry::Instance]) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    for inst in live {
        let token = crate::instance::short_token_for(&inst.instance_id);
        names.insert(format!("tugcast-ctl-{token}.sock"));
        names.insert(format!("tugbank-notify-{token}.sock"));
        // tugexec keys its control socket by port rather than token.
        names.insert(format!("tugcast-ctl-{}.sock", inst.tugcast_port));
    }
    names
}

/// The manifest entry governing `name`, longest prefix first.
pub(crate) fn match_prefix(name: &str) -> Option<&'static TmpPrefix> {
    TMP_PREFIXES
        .iter()
        .filter(|p| name.starts_with(p.prefix))
        .filter(|p| !p.numbered || has_four_digits(&name[p.prefix.len()..]))
        .max_by_key(|p| p.prefix.len())
}

fn has_four_digits(rest: &str) -> bool {
    rest.len() >= 4 && rest.as_bytes()[..4].iter().all(u8::is_ascii_digit)
}

/// True when the artifact's mtime is at least `min_age` in the past.
/// An unreadable or future mtime reads as young — the conservative
/// answer for a janitor.
pub(crate) fn older_than(meta: &fs::Metadata, min_age: Duration) -> bool {
    if min_age.is_zero() {
        return true;
    }
    meta.modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|age| age >= min_age)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    /// Backdate `path` so an age gate sees it as debris.
    fn age(path: &Path, secs: u64) {
        let when = SystemTime::now() - Duration::from_secs(secs);
        let times = fs::FileTimes::new().set_modified(when);
        File::options()
            .write(true)
            .open(path)
            .or_else(|_| File::options().read(true).open(path))
            .expect("open for times")
            .set_times(times)
            .expect("set times");
    }

    #[test]
    fn aged_registered_litter_goes_and_fresh_litter_stays() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path();

        let old_file = tmp.join("tugcast-test-changes-1234.db");
        fs::write(&old_file, b"x").unwrap();
        age(&old_file, 48 * 60 * 60);

        let old_wal = tmp.join("tugcast-test-changes-1234.db-wal");
        fs::write(&old_wal, b"x").unwrap();
        age(&old_wal, 48 * 60 * 60);

        let fresh_file = tmp.join("tugcast-test-changes-9999.db");
        fs::write(&fresh_file, b"x").unwrap();

        let unregistered = tmp.join("random-junk.txt");
        fs::write(&unregistered, b"x").unwrap();
        age(&unregistered, 48 * 60 * 60);

        let old_dir = tmp.join("tugcast-drift-77");
        fs::create_dir(&old_dir).unwrap();
        fs::write(old_dir.join("inner"), b"x").unwrap();
        age(&old_dir, 48 * 60 * 60);

        let (files, dirs) = sweep_tmp_debris(
            tmp,
            Duration::from_secs(TMP_DEBRIS_MAX_AGE_SECS),
            SweepMode::Apply,
        );

        assert!(!old_file.exists(), "aged registered file must go");
        assert!(!old_wal.exists(), "the WAL sibling shares the prefix");
        assert!(!old_dir.exists(), "aged registered dir must go");
        assert!(fresh_file.exists(), "fresh litter is not debris");
        assert!(unregistered.exists(), "unregistered names are untouched");
        assert_eq!(files.len(), 2);
        assert_eq!(dirs, vec![old_dir]);
    }

    #[test]
    fn the_numbered_constraint_separates_test_dirs_from_lookalikes() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path();

        let test_dir = tmp.join("at0275-scratch-abc");
        fs::create_dir(&test_dir).unwrap();
        age(&test_dir, 48 * 60 * 60);

        let lookalike = tmp.join("atelier-cache");
        fs::create_dir(&lookalike).unwrap();
        age(&lookalike, 48 * 60 * 60);

        let prefixed = tmp.join("tug-at9997-scratch-xyz");
        fs::create_dir(&prefixed).unwrap();
        age(&prefixed, 48 * 60 * 60);

        sweep_tmp_debris(
            tmp,
            Duration::from_secs(TMP_DEBRIS_MAX_AGE_SECS),
            SweepMode::Apply,
        );

        assert!(!test_dir.exists(), "atNNNN- dirs are registered debris");
        assert!(!prefixed.exists(), "tug-atNNNN- dirs are registered debris");
        assert!(lookalike.exists(), "a non-numbered `at…` name is not ours");
    }

    #[test]
    fn sockets_are_left_for_the_probe() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path();
        let sock = tmp.join("tugcast-ctl-deadbeef.sock");
        fs::write(&sock, b"").unwrap();
        age(&sock, 48 * 60 * 60);

        sweep_tmp_debris(
            tmp,
            Duration::from_secs(TMP_DEBRIS_MAX_AGE_SECS),
            SweepMode::Apply,
        );

        assert!(sock.exists(), "socket classes are probed, never aged out");
    }

    #[test]
    fn a_dead_socket_goes_and_a_bound_one_survives() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path();

        let dead = tmp.join("tugcast-ctl-deadbeef.sock");
        {
            // Bind, then drop the listener without unlinking — the exact
            // corpse a SIGKILLed instance leaves behind.
            let l = std::os::unix::net::UnixListener::bind(&dead).unwrap();
            drop(l);
        }
        assert!(dead.exists());

        let alive = tmp.join("tugcast-ctl-livebeef.sock");
        let listener = std::os::unix::net::UnixListener::bind(&alive).unwrap();

        let removed = sweep_dead_sockets(tmp, Duration::ZERO, SweepMode::Apply);

        assert_eq!(removed, vec![dead.clone()]);
        assert!(!dead.exists());
        assert!(alive.exists(), "a bound socket must survive");
        // And it still works.
        let client = UnixStream::connect(&alive).expect("connect after sweep");
        listener.accept().expect("accept after sweep");
        drop(client);
    }

    /// The regression that shaped `sweep_dead_sockets`: on macOS a live
    /// listener with a saturated backlog fails `connect()` with
    /// `ECONNREFUSED` — the same errno a corpse gives. Errno discipline
    /// alone cannot tell them apart, so the age floor is what saves it.
    ///
    /// The premise is the macOS kernel's: Linux queues past a full backlog
    /// instead of refusing, so the saturation the test needs cannot be built
    /// there and the assertion below would be testing nothing.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_saturated_live_listener_survives() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path();
        let path = tmp.join("tugcast-ctl-saturated.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();

        // Fill the backlog without ever accepting.
        let mut held = Vec::new();
        for _ in 0..256 {
            match UnixStream::connect(&path) {
                Ok(s) => held.push(s),
                Err(_) => break,
            }
        }
        assert!(
            UnixStream::connect(&path).is_err(),
            "the backlog must actually be saturated for this test to mean anything"
        );

        let removed = sweep_dead_sockets(
            tmp,
            Duration::from_secs(MIN_DEBRIS_AGE_SECS),
            SweepMode::Apply,
        );

        assert!(removed.is_empty());
        assert!(path.exists(), "a live listener must survive a full backlog");
    }

    #[test]
    fn the_socket_pass_ignores_files_that_are_not_sockets() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path();
        let db = tmp.join("tugapp-test-tugbank-x.db");
        fs::write(&db, b"x").unwrap();
        // A plain file wearing a socket-kind prefix.
        let impostor = tmp.join("tugapp-test-notasocket.sock");
        fs::write(&impostor, b"x").unwrap();

        let removed = sweep_dead_sockets(tmp, Duration::ZERO, SweepMode::Apply);

        assert!(removed.is_empty());
        assert!(db.exists());
        assert!(impostor.exists());
    }

    #[test]
    fn the_tmux_ladder_protects_everything_that_could_be_alive() {
        let none_live = |_: &str| false;
        let apptest =
            |names: &[&str]| -> Vec<String> { names.iter().map(|s| s.to_string()).collect() };

        assert_eq!(
            classify_tmux_server(None, &none_live, true),
            TmuxVerdict::UnlinkDeadSocket
        );
        assert_eq!(
            classify_tmux_server(Some(&apptest(&["cc-debug-main"])), &none_live, true),
            TmuxVerdict::Skip,
            "a dev server is never a candidate"
        );
        assert_eq!(
            classify_tmux_server(
                Some(&apptest(&["cc-apptest-a", "cc-release-main"])),
                &none_live,
                true
            ),
            TmuxVerdict::Skip,
            "one non-apptest session protects the whole server"
        );
        assert_eq!(
            classify_tmux_server(
                Some(&apptest(&["cc-apptest-live"])),
                &|id: &str| id == "apptest-live",
                true
            ),
            TmuxVerdict::Skip,
            "an in-flight run owns its server"
        );
        assert_eq!(
            classify_tmux_server(Some(&apptest(&["cc-apptest-dead"])), &none_live, false),
            TmuxVerdict::Skip,
            "the age floor outranks registry absence"
        );
        assert_eq!(
            classify_tmux_server(Some(&[]), &none_live, false),
            TmuxVerdict::Skip,
            "an empty server is only reapable via the age floor"
        );
        assert_eq!(
            classify_tmux_server(Some(&apptest(&["cc-apptest-dead"])), &none_live, true),
            TmuxVerdict::KillServer
        );
        assert_eq!(
            classify_tmux_server(Some(&[]), &none_live, true),
            TmuxVerdict::KillServer
        );
    }

    /// A fixture tmux root tmux will actually accept: `tmux-<uid>` under
    /// a TempDir, mode 0700, owned by the caller.
    fn tmux_fixture() -> Option<(tempfile::TempDir, PathBuf)> {
        let out = std::process::Command::new(crate::instance::tmux_bin())
            .arg("-V")
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let root = tempfile::tempdir().ok()?;
        // SAFETY: getuid is always safe.
        let uid = unsafe { libc::getuid() };
        let dir = root.path().join(format!("tmux-{uid}"));
        fs::create_dir(&dir).ok()?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).ok()?;
        Some((root, dir))
    }

    #[test]
    fn an_orphan_apptest_server_dies_and_a_dev_server_lives() {
        let Some((root, dir)) = tmux_fixture() else {
            eprintln!("tmux unavailable — skipping");
            return;
        };
        let tmpdir = root.path();

        let start = |label: &str, session: &str| {
            std::process::Command::new(crate::instance::tmux_bin())
                .env("TMUX_TMPDIR", tmpdir)
                .args(["-L", label, "new-session", "-d", "-s", session])
                .output()
                .expect("start tmux server");
        };
        start("tug-jtest1", "cc-apptest-janitor-orphan");
        start("tug-jtest2", "cc-debug-janitor");

        let dead = dir.join("tug-deadsock");
        fs::write(&dead, b"").unwrap();

        let (killed, unlinked) = sweep_tmux_servers(&dir, Duration::ZERO, SweepMode::Apply);

        assert!(
            killed.contains(&"tug-jtest1".to_string()),
            "killed: {killed:?}"
        );
        assert!(!killed.contains(&"tug-jtest2".to_string()));
        assert!(unlinked.contains(&dead));
        assert!(
            tmux_sessions(tmpdir, "tug-jtest1").is_none(),
            "the orphan server must be gone"
        );
        assert!(
            tmux_sessions(tmpdir, "tug-jtest2").is_some(),
            "the dev server must survive"
        );

        let _ = std::process::Command::new(crate::instance::tmux_bin())
            .env("TMUX_TMPDIR", tmpdir)
            .args(["-L", "tug-jtest2", "kill-server"])
            .output();
    }

    /// The mid-boot regression: a freshly created app-test server with
    /// no registry entry is exactly what a booting instance looks like.
    #[test]
    fn a_fresh_apptest_server_survives_the_age_floor() {
        let Some((root, dir)) = tmux_fixture() else {
            eprintln!("tmux unavailable — skipping");
            return;
        };
        let tmpdir = root.path();
        std::process::Command::new(crate::instance::tmux_bin())
            .env("TMUX_TMPDIR", tmpdir)
            .args([
                "-L",
                "tug-jtest3",
                "new-session",
                "-d",
                "-s",
                "cc-apptest-janitor-booting",
            ])
            .output()
            .expect("start tmux server");

        let (killed, _) = sweep_tmux_servers(
            &dir,
            Duration::from_secs(MIN_DEBRIS_AGE_SECS),
            SweepMode::Apply,
        );

        assert!(
            killed.is_empty(),
            "a booting instance must survive: {killed:?}"
        );
        assert!(tmux_sessions(tmpdir, "tug-jtest3").is_some());

        let _ = std::process::Command::new(crate::instance::tmux_bin())
            .env("TMUX_TMPDIR", tmpdir)
            .args(["-L", "tug-jtest3", "kill-server"])
            .output();
    }

    /// Build an instances-root fixture entry.
    fn plant_instance(root: &Path, id: &str, bundle: Option<&Path>) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        if let Some(bundle) = bundle {
            fs::write(
                dir.join(crate::instance::BUNDLE_PATH_MARKER),
                bundle.to_string_lossy().as_bytes(),
            )
            .unwrap();
        }
        dir
    }

    #[test]
    fn dead_apptest_data_dirs_go_and_everything_else_stays() {
        let root = tempfile::tempdir().unwrap();
        let bundle = tempfile::tempdir().unwrap();

        let dead = plant_instance(root.path(), "apptest-dead-abc123", Some(bundle.path()));
        let dev = plant_instance(root.path(), "debug-main", Some(bundle.path()));
        let nomarker = plant_instance(root.path(), "apptest-nomarker-abc", None);
        let bundle_gone = plant_instance(
            root.path(),
            "apptest-bundlegone-abc",
            Some(Path::new("/nonexistent/Tug.app")),
        );

        let removed = sweep_apptest_data_dirs(root.path(), Duration::ZERO, SweepMode::Apply);

        assert_eq!(removed, vec!["apptest-dead-abc123".to_string()]);
        assert!(!dead.exists());
        assert!(dev.exists(), "dev dirs are never candidates");
        assert!(nomarker.exists(), "a marker-less dir is not classifiable");
        assert!(
            bundle_gone.exists(),
            "bundle-missing dirs belong to prune's full-removal path"
        );
    }

    /// An interrupted removal must be finishable, not permanent debris.
    /// The condemned dir carries no marker and a fresh mtime — the exact
    /// combination that both this sweep and `instance prune` otherwise
    /// skip forever.
    #[test]
    fn an_interrupted_removal_is_finished_by_the_next_sweep() {
        let root = tempfile::tempdir().unwrap();
        let half_deleted = root
            .path()
            .join(format!("apptest-interrupted-abc{CONDEMNED_SUFFIX}"));
        fs::create_dir_all(half_deleted.join("Logs")).unwrap();
        fs::write(half_deleted.join("Logs/tugcast.log"), b"leftovers").unwrap();

        // Real floor, no marker, mtime of a moment ago: still goes.
        sweep_apptest_data_dirs(
            root.path(),
            Duration::from_secs(MIN_DEBRIS_AGE_SECS),
            SweepMode::Apply,
        );

        assert!(
            !half_deleted.exists(),
            "a condemned dir must be reclaimed regardless of age or marker"
        );
    }

    #[test]
    fn a_condemned_dir_is_left_alone_in_report_mode() {
        let root = tempfile::tempdir().unwrap();
        let condemned = root
            .path()
            .join(format!("apptest-interrupted-xyz{CONDEMNED_SUFFIX}"));
        fs::create_dir(&condemned).unwrap();

        sweep_apptest_data_dirs(root.path(), Duration::ZERO, SweepMode::Report);

        assert!(condemned.exists(), "report mode removes nothing");
    }

    /// The mid-boot signature: a valid marker, no registry entry, and a
    /// fresh mtime. It must survive.
    #[test]
    fn a_booting_instance_data_dir_survives_the_age_floor() {
        let root = tempfile::tempdir().unwrap();
        let bundle = tempfile::tempdir().unwrap();
        let booting = plant_instance(root.path(), "apptest-booting-abc", Some(bundle.path()));

        let removed = sweep_apptest_data_dirs(
            root.path(),
            Duration::from_secs(MIN_DEBRIS_AGE_SECS),
            SweepMode::Apply,
        );

        assert!(removed.is_empty());
        assert!(booting.exists(), "a booting instance must survive");
    }

    #[test]
    fn only_aged_reparented_tug_processes_are_reapable() {
        let row = |pid: i32, ppid: i32, secs: u64, command: &str| ProcRow {
            pid,
            ppid,
            elapsed: Duration::from_secs(secs),
            command: command.to_string(),
        };
        let floor = Duration::from_secs(MIN_DEBRIS_AGE_SECS);

        assert!(is_reparented_orphan(
            &row(42, 1, 3600, "/path/to/tugcode --session x"),
            floor
        ));
        assert!(is_reparented_orphan(
            &row(42, 1, 3600, "claude --output-format stream-json"),
            floor
        ));
        assert!(
            !is_reparented_orphan(&row(42, 1, 3600, "claude --resume abc"), floor),
            "an interactive claude is a user's session, not debris"
        );
        assert!(
            !is_reparented_orphan(&row(42, 900, 3600, "/path/to/tugcode"), floor),
            "a parented tugcode has a live owner"
        );
        assert!(
            !is_reparented_orphan(&row(42, 1, 5, "/path/to/tugcode"), floor),
            "a just-reparented process may be mid-handoff"
        );

        // Identity is the executable, not any token on the line. Each of
        // these was reapable when the match was a whole-line substring
        // test — a detached build and anything running out of ~/.claude
        // are the realistic victims.
        for command in [
            "/opt/homebrew/bin/bun build ./tugcode",
            "tail -f /tmp/tugcode.log",
            "/bin/sh -c 'cargo build -p tugcode'",
            "/Users/x/.claude/local/node --output-format stream-json",
            "rg --files-with-matches stream-json /Users/x/.claude",
            // Not hypothetical: a process can carry "tugcode" in its
            // command line purely because a session's text ended up in
            // one of its arguments. Reparent it and the old matcher
            // killed it.
            "/opt/homebrew/bin/nvim /tmp/why-405-tugcode-dbs-accumulated.md",
        ] {
            assert!(
                !is_reparented_orphan(&row(42, 1, 3600, command), floor),
                "not ours to kill: {command}"
            );
        }

        // Still reaped when the executable really is ours, bare name or
        // absolute path.
        assert!(is_reparented_orphan(&row(42, 1, 3600, "tugcode"), floor));
        assert!(is_reparented_orphan(
            &row(
                42,
                1,
                3600,
                "/opt/tug/bin/claude --output-format stream-json"
            ),
            floor
        ));
    }

    #[test]
    fn legacy_default_server_sessions_need_a_dead_owner_and_some_age() {
        let floor = Duration::from_secs(MIN_DEBRIS_AGE_SECS);
        let hour = Duration::from_secs(3600);
        let none_live = |_: &str| false;

        assert!(legacy_session_reapable(
            "cc-apptest-old",
            hour,
            floor,
            &none_live
        ));
        assert!(
            !legacy_session_reapable("cc-debug-main", hour, floor, &|id: &str| id == "debug-main"),
            "a live instance's legacy session is still its own"
        );
        assert!(
            !legacy_session_reapable("cc-apptest-new", Duration::from_secs(5), floor, &none_live),
            "the age floor applies here too"
        );
        assert!(
            !legacy_session_reapable("my-editor", hour, floor, &none_live),
            "a user's own session is never touched"
        );
    }

    #[test]
    fn ps_rows_parse() {
        let row = parse_ps_row("  501     1    03-18:09:36 /usr/bin/tugcode --flag a b").unwrap();
        assert_eq!(row.pid, 501);
        assert_eq!(row.ppid, 1);
        assert_eq!(
            row.elapsed,
            Duration::from_secs(3 * 86400 + 18 * 3600 + 9 * 60 + 36)
        );
        assert_eq!(row.command, "/usr/bin/tugcode --flag a b");

        assert_eq!(parse_etime("01:30"), Some(Duration::from_secs(90)));
        assert_eq!(parse_etime("02:01:30"), Some(Duration::from_secs(7290)));
        assert_eq!(parse_etime("garbage"), None);
    }

    /// `sweep_all` against the machine's real roots. Ignored by default
    /// — running the test suite must never sweep as a side effect.
    #[test]
    #[ignore = "sweeps the real machine; run deliberately"]
    fn sweep_all_runs_against_real_roots() {
        let report = sweep_all(SweepMode::Report);
        eprintln!("{report:#?}");
    }

    /// A report must name exactly what an apply would take, and take
    /// nothing itself — otherwise `just reap`'s preview is a lie.
    #[test]
    fn report_mode_names_the_same_things_it_does_not_remove() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path();
        let litter = tmp.join("tugcast-test-changes-4242.db");
        fs::write(&litter, b"x").unwrap();
        age(&litter, 48 * 60 * 60);
        let dead_sock = tmp.join("tugcast-ctl-reportmode.sock");
        drop(std::os::unix::net::UnixListener::bind(&dead_sock).unwrap());

        let max = Duration::from_secs(TMP_DEBRIS_MAX_AGE_SECS);
        let (files, _) = sweep_tmp_debris(tmp, max, SweepMode::Report);
        let sockets = sweep_dead_sockets(tmp, Duration::ZERO, SweepMode::Report);
        assert_eq!(files, vec![litter.clone()]);
        assert_eq!(sockets, vec![dead_sock.clone()]);
        assert!(litter.exists(), "report mode removes nothing");
        assert!(dead_sock.exists(), "report mode removes nothing");

        let (applied_files, _) = sweep_tmp_debris(tmp, max, SweepMode::Apply);
        let applied_sockets = sweep_dead_sockets(tmp, Duration::ZERO, SweepMode::Apply);
        assert_eq!(applied_files, files);
        assert_eq!(applied_sockets, sockets);
        assert!(!litter.exists());
        assert!(!dead_sock.exists());
    }

    /// The same guarantee for the two passes that reach outside
    /// `$TMPDIR`. A preview that disagrees with the run is worse than no
    /// preview, because `just reap` is read as a promise.
    #[test]
    fn report_and_apply_agree_for_data_dirs() {
        let root = tempfile::tempdir().unwrap();
        let bundle = tempfile::tempdir().unwrap();
        plant_instance(root.path(), "apptest-symmetry-abc", Some(bundle.path()));

        let reported = sweep_apptest_data_dirs(root.path(), Duration::ZERO, SweepMode::Report);
        assert_eq!(reported, vec!["apptest-symmetry-abc".to_string()]);
        assert!(root.path().join("apptest-symmetry-abc").exists());

        let applied = sweep_apptest_data_dirs(root.path(), Duration::ZERO, SweepMode::Apply);
        assert_eq!(applied, reported);
        assert!(!root.path().join("apptest-symmetry-abc").exists());
    }

    #[test]
    fn report_and_apply_agree_for_tmux_servers() {
        let Some((root, dir)) = tmux_fixture() else {
            eprintln!("tmux unavailable — skipping");
            return;
        };
        let tmpdir = root.path();
        std::process::Command::new(crate::instance::tmux_bin())
            .env("TMUX_TMPDIR", tmpdir)
            .args([
                "-L",
                "tug-jsym1",
                "new-session",
                "-d",
                "-s",
                "cc-apptest-symmetry",
            ])
            .output()
            .expect("start tmux server");
        let dead = dir.join("tug-jsymdead");
        fs::write(&dead, b"").unwrap();

        let (r_killed, r_unlinked) = sweep_tmux_servers(&dir, Duration::ZERO, SweepMode::Report);
        assert!(
            tmux_sessions(tmpdir, "tug-jsym1").is_some(),
            "report mode kills nothing"
        );
        assert!(dead.exists(), "report mode unlinks nothing");

        let (a_killed, a_unlinked) = sweep_tmux_servers(&dir, Duration::ZERO, SweepMode::Apply);
        assert_eq!(a_killed, r_killed);
        assert_eq!(a_unlinked, r_unlinked);
        assert!(tmux_sessions(tmpdir, "tug-jsym1").is_none());
        assert!(!dead.exists());
    }

    #[test]
    fn longest_prefix_wins() {
        assert_eq!(
            match_prefix("tugapp-test-tugbank-abc.db").map(|p| p.kind),
            Some(TmpKind::File)
        );
        assert_eq!(
            match_prefix("tugapp-test-abc.sock").map(|p| p.kind),
            Some(TmpKind::Socket)
        );
    }

    /// The manifest is only self-maintaining if inventing a new temp
    /// class without registering it fails the build. Modeled on
    /// `ledger_db::no_ad_hoc_ledger_opens`.
    ///
    /// Known limitation, stated so nobody mistakes the scan for proof:
    /// it reads *literal* leading segments out of `join(…)`/`push(…)`
    /// calls near a `temp_dir()`. A path assembled through a variable
    /// escapes it — review catches those.
    #[test]
    fn no_unregistered_tmp_prefixes() {
        // Live state, not debris: the registry and its advisory
        // lockfile live in `$TMPDIR` and must never be swept.
        const ALLOWLIST: &[&str] = &[
            crate::registry::REGISTRY_FILENAME,
            crate::registry::REGISTRY_LOCKFILE,
        ];

        let crates_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crates dir")
            .to_path_buf();
        let this_file = crates_root.join("tugcore/src/janitor.rs");

        let mut offenders = Vec::new();
        let mut stack = vec![crates_root];
        while let Some(d) = stack.pop() {
            for entry in fs::read_dir(&d).expect("read_dir") {
                let entry = entry.expect("dir entry");
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    // `tests/` is deliberately in scope — the biggest
                    // single offender in the audit was a test harness.
                    if name == "target" || name == "fixtures" {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") || path == this_file {
                    continue;
                }
                let text = fs::read_to_string(&path).expect("read source");
                for literal in temp_path_literals(&text) {
                    if ALLOWLIST.contains(&literal.as_str()) {
                        continue;
                    }
                    if match_prefix(&literal).is_none() {
                        offenders.push(format!("{}: {literal:?}", path.display()));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "temp paths minted under an unregistered prefix — add them to \
             `TMP_PREFIXES` so the janitor sweeps them: {offenders:#?}"
        );
    }

    /// Leading literal segments of paths built under a `temp_dir()`.
    fn temp_path_literals(text: &str) -> Vec<String> {
        const WINDOW: usize = 200;
        let mut out = Vec::new();
        for (at, _) in text.match_indices("temp_dir()") {
            let mut end = text.len().min(at + WINDOW);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let window = &text[at..end];
            for call in ["join(", "push("] {
                for (rel, _) in window.match_indices(call) {
                    let after = &window[rel + call.len()..];
                    let after = after.strip_prefix("format!(").unwrap_or(after);
                    let Some(body) = after.strip_prefix('"') else {
                        continue;
                    };
                    let Some(end) = body.find('"') else { continue };
                    // The literal stops at the first interpolation.
                    let literal = &body[..end];
                    let literal = literal.split('{').next().unwrap_or(literal);
                    if !literal.is_empty() {
                        out.push(literal.to_string());
                    }
                }
            }
        }
        out.extend(builder_prefix_literals(text));
        out
    }

    /// Leading literals from `tempfile::Builder::new().prefix("…")`.
    ///
    /// This idiom never mentions `temp_dir()`, so the scan above cannot
    /// see it — and it is exactly how the changes-DB tempdir is named.
    /// `tempfile` removes its own directories on drop, but a SIGKILLed
    /// test binary never drops anything, which is the case the manifest
    /// exists to cover.
    fn builder_prefix_literals(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (at, _) in text.match_indices(".prefix(\"") {
            // `strip_prefix("…")` ends in the same eight characters and
            // is not a temp path.
            if text[..at].ends_with("strip") {
                continue;
            }
            let body = &text[at + ".prefix(\"".len()..];
            let Some(end) = body.find('"') else { continue };
            let literal = body[..end].split('{').next().unwrap_or_default();
            if !literal.is_empty() {
                out.push(literal.to_string());
            }
        }
        out
    }
}
