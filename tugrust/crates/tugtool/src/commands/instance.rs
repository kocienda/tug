//! `tugtool host instance` — per-instance discovery + lifecycle management.
//!
//! Backed by `tugcore::registry`, which `tugcast` writes when it
//! binds. The subcommands here read that registry (plus the on-disk
//! data dirs at `~/Library/Application Support/Tug/instances/`) so a
//! user can answer questions like "which dev instances are running?"
//! and "are there orphaned data dirs from worktrees I removed?".
//!
//! See the plan's Step 14 for the contract: list / stop / current /
//! remove / prune. Cleanup primitives are conservative by default —
//! `remove` and `prune` confirm before they delete unless `--yes` is
//! passed.

use std::io::Read;
use std::path::{Path, PathBuf};

use clap::Subcommand;
use tugcore::registry;

#[derive(Subcommand, Debug)]
pub enum InstanceCommands {
    /// List every live Tug instance registered with this host.
    List,

    /// Send SIGTERM to a running instance and wait for it to exit.
    ///
    /// Looks the instance up in the registry, signals its PID, waits
    /// up to `--timeout` seconds, and escalates to SIGKILL if the
    /// process is still alive after the wait.
    Stop {
        /// Instance ID to stop (e.g. `release-main`,
        /// `debug-foo`).
        instance_id: String,

        /// Seconds to wait for graceful exit before escalating to SIGKILL.
        #[arg(long, default_value_t = 5)]
        timeout: u64,
    },

    /// Print the live instance whose bundle path covers the current
    /// working directory. Exits non-zero if no match is found.
    Current,

    /// Surgically remove all on-disk state for one instance.
    ///
    /// 1. Stop the running process if any (`tugtool host instance stop`).
    /// 2. Resolve the bundle path via the per-instance
    ///    `<data-dir>/bundle-path` marker.
    /// 3. If the bundle exists: `lsregister -u <bundle>` then
    ///    `rm -rf` the parent DerivedData directory and the bundle.
    /// 4. `rm -rf <data-dir>/<id>`.
    /// 5. With `--with-tcc`: `tccutil reset Accessibility <bundle-id>`.
    Remove {
        /// Instance ID to remove.
        instance_id: String,

        /// Also reset the TCC Accessibility entry for the bundle ID.
        /// Off by default — orphaned TCC entries are inert without
        /// the bundle they grant, and `tccutil` requires confirmation
        /// in System Settings on some macOS versions.
        #[arg(long)]
        with_tcc: bool,

        /// Reclaim only the per-instance data dir (and tmux session),
        /// leaving the bundle and its LaunchServices registration
        /// alone. This is the right mode for ephemeral `apptest-<uuid>`
        /// instances: every app-test launch mints a single-use ID but
        /// shares one long-lived `Tug-apptest.app` bundle, so removing
        /// the bundle on teardown would knock out sibling runs. Implies
        /// `--yes` is still honoured; `--with-tcc` is ignored (the
        /// bundle, and thus its grant, survives).
        #[arg(long)]
        data_only: bool,

        /// Skip the interactive confirmation prompt.
        #[arg(long)]
        yes: bool,
    },

    /// Discover and (optionally) remove orphaned data dirs.
    ///
    /// Walks `~/Library/Application Support/Tug/instances/*/`. A data
    /// dir is an orphan when either:
    ///   - its bundle-path marker points at a bundle that no longer
    ///     exists on disk (a removed worktree / deleted build), or
    ///   - it belongs to an ephemeral `apptest-<uuid>` instance that is
    ///     not currently live in the registry. App-test IDs are
    ///     single-use, so once the run ends the dir is garbage even
    ///     though its shared `Tug-apptest.app` bundle still exists —
    ///     the bundle-missing test alone never reclaims these, so they
    ///     accumulate without this rule.
    ///
    /// Ephemeral orphans are removed data-only (their shared bundle is
    /// left intact); bundle-missing orphans get the full removal.
    Prune {
        /// Skip the interactive confirmation prompt.
        #[arg(long)]
        yes: bool,

        /// Also reset TCC entries for each orphan's bundle ID
        /// (off by default; see `instance remove --with-tcc`).
        #[arg(long)]
        with_tcc: bool,

        /// Emit the orphan list as JSON without removing anything.
        #[arg(long)]
        json: bool,
    },
}

/// Entry point — dispatch to the right subcommand impl.
pub fn run_instance(cmd: InstanceCommands) -> Result<i32, String> {
    match cmd {
        InstanceCommands::List => run_list(),
        InstanceCommands::Stop {
            instance_id,
            timeout,
        } => run_stop(&instance_id, timeout),
        InstanceCommands::Current => run_current(),
        InstanceCommands::Remove {
            instance_id,
            with_tcc,
            data_only,
            yes,
        } => run_remove(&instance_id, with_tcc, data_only, yes),
        InstanceCommands::Prune {
            yes,
            with_tcc,
            json,
        } => run_prune(yes, with_tcc, json),
    }
}

// ── list ─────────────────────────────────────────────────────────────────────

fn run_list() -> Result<i32, String> {
    let entries = registry::list_live().map_err(|e| format!("read registry: {e}"))?;
    if entries.is_empty() {
        println!("(no Tug instances running)");
        return Ok(0);
    }
    println!("{:<32}  {:>7}  {:>7}  BUNDLE", "INSTANCE", "PID", "PORT");
    for i in &entries {
        println!(
            "{:<32}  {:>7}  {:>7}  {}",
            i.instance_id,
            i.pid,
            i.tugcast_port,
            i.bundle_path.display()
        );
    }
    Ok(0)
}

// ── stop ─────────────────────────────────────────────────────────────────────

fn run_stop(instance_id: &str, timeout_secs: u64) -> Result<i32, String> {
    let entry = registry::find_by_id(instance_id)
        .map_err(|e| format!("read registry: {e}"))?
        .ok_or_else(|| format!("no live instance '{instance_id}'"))?;
    let tugcast_pid = entry.pid;
    let host_pid = entry.host_pid;

    // Identity guard against PID reuse. The registry records PIDs, but a
    // PID is recycled the moment its process dies — so a stale entry can
    // name a PID the OS has since handed to an unrelated process (even
    // another instance's Claude). Before signalling, confirm the live
    // PID is still the process we registered by matching its command:
    // `tugcast` for the tugcast PID, the bundle executable for the host.
    // A confirmed mismatch is NEVER signalled — that is how an app-test
    // teardown could otherwise SIGKILL a live debug instance's child.
    let host_needle = entry
        .bundle_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Tug")
        .to_string();
    let have_host =
        host_pid > 0 && pid_alive(host_pid) && pid_is(host_pid, &host_needle, "host app");
    let tugcast_ours = pid_alive(tugcast_pid) && pid_is(tugcast_pid, "tugcast", "tugcast");

    // If neither registered PID is still ours, the instance is already
    // gone (or its PIDs were reused) — nothing safe to signal.
    if !have_host && !tugcast_ours {
        println!("instance '{instance_id}' is no longer running (registered PIDs not ours)");
        return Ok(0);
    }

    // Signal the GUI host app (`Tug.app`) — the process whose window
    // the user sees. tugcast runs in its own process group (setpgid)
    // and supervises tugcode; signalling tugcast alone leaves the host
    // app alive and stuck on "Disconnected — reconnecting…". Killing
    // the host instead lets it run its own teardown, and tugcast
    // follows via its parent-watch. We also signal tugcast directly:
    // it handles SIGTERM with a clean unregister, so the instance
    // disappears promptly rather than waiting out the parent-watch
    // poll. (Pre-`host_pid` registry entries carry `host_pid == 0`;
    // those fall back to the tugcast-only path the old code took.)
    if have_host {
        println!(
            "stopping {instance_id} — SIGTERM host app (PID {host_pid}) + tugcast (PID {tugcast_pid})"
        );
        send_signal(host_pid, libc::SIGTERM);
    } else if tugcast_ours {
        println!("stopping {instance_id} — SIGTERM tugcast (PID {tugcast_pid})");
    }
    if tugcast_ours {
        send_signal(tugcast_pid, libc::SIGTERM);
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs.max(1));
    while std::time::Instant::now() < deadline {
        let host_gone = !have_host || !pid_alive(host_pid);
        let tugcast_gone = !tugcast_ours || !pid_alive(tugcast_pid);
        if host_gone && tugcast_gone {
            println!("stopped cleanly");
            return Ok(0);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    println!(
        "still alive after {}s — escalating to SIGKILL",
        timeout_secs.max(1)
    );
    if have_host && pid_alive(host_pid) {
        send_signal(host_pid, libc::SIGKILL);
    }
    if tugcast_ours && pid_alive(tugcast_pid) {
        send_signal(tugcast_pid, libc::SIGKILL);
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
    let host_alive = have_host && pid_alive(host_pid);
    let tugcast_alive = tugcast_ours && pid_alive(tugcast_pid);
    if tugcast_alive || host_alive {
        Err(format!(
            "instance '{instance_id}' still alive after SIGKILL (tugcast {tugcast_pid}, host {host_pid})"
        ))
    } else {
        Ok(0)
    }
}

/// Best-effort identity check for a registry PID, guarding against PID
/// reuse. Returns `true` when the live process's command line contains
/// `needle` (so it is still the process we registered), or when the
/// command cannot be read (rare — preserve liveness rather than strand a
/// stuck instance). Returns `false` only on a *confirmed* mismatch, and
/// logs it, so a recycled PID is never signalled.
fn pid_is(pid: i32, needle: &str, role: &str) -> bool {
    match pid_command(pid) {
        Some(cmd) if cmd.contains(needle) => true,
        Some(cmd) => {
            println!(
                "  skipping {role} PID {pid}: command '{cmd}' is not '{needle}' (PID reused — not signalling)"
            );
            false
        }
        None => true,
    }
}

/// Read a live process's full command line via `ps -p <pid> -o command=`.
/// Returns `None` when the process is gone or `ps` produces no output.
fn pid_command(pid: i32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let cmd = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if cmd.is_empty() { None } else { Some(cmd) }
}

// ── current ──────────────────────────────────────────────────────────────────

fn run_current() -> Result<i32, String> {
    let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
    match registry::find_for_cwd(&cwd) {
        Ok(Some(i)) => {
            println!("{}", i.instance_id);
            Ok(0)
        }
        Ok(None) => Err("no live Tug instance owns the current working directory".to_owned()),
        Err(e) => Err(format!("read registry: {e}")),
    }
}

// ── remove ───────────────────────────────────────────────────────────────────

fn run_remove(
    instance_id: &str,
    with_tcc: bool,
    data_only: bool,
    yes: bool,
) -> Result<i32, String> {
    // `--data-only` reclaims just the data dir + tmux; the bundle and
    // its TCC grant survive, so a `--with-tcc` request makes no sense
    // in that mode — drop it rather than silently half-honouring.
    let with_tcc = with_tcc && !data_only;
    let data_dir = tugcore::instance_data_dir_for(instance_id);
    let marker = data_dir.join(tugcore::instance::BUNDLE_PATH_MARKER);
    let bundle_path = std::fs::read_to_string(&marker)
        .ok()
        .map(|s| PathBuf::from(s.trim()));

    println!("removing instance '{instance_id}'");
    println!("  data dir: {}", data_dir.display());
    if data_only {
        println!("  bundle:   (data-only; leaving bundle + LaunchServices intact)");
    } else if let Some(bp) = &bundle_path {
        println!("  bundle:   {} (from marker)", bp.display());
    } else {
        println!("  bundle:   (no marker; unable to clean LaunchServices entry)");
    }
    if with_tcc {
        println!("  +tcc:     reset Accessibility entry");
    }
    if !yes && !confirm("Proceed?")? {
        println!("aborted");
        return Ok(0);
    }

    // 1. Stop if running. Ignore "not running" errors.
    if let Ok(Some(entry)) = registry::find_by_id(instance_id) {
        println!("stopping running PID {}", entry.pid);
        let _ = run_stop(instance_id, 5);
    }

    // 1b. Reap the instance's tmux server/session. A tmux server is a
    // daemon outside tugcast's process group, so stopping the instance
    // does not take it down — without this, removing a dev/release
    // instance would leak its `tug-<token>` server (and `cc-<id>`
    // session) until tmux is killed by hand. App-test instances reap
    // their own server on graceful shutdown, but this is the catch-all.
    tugcore::instance::reap_instance_tmux(instance_id);

    // 2-4. Bundle + LaunchServices + data dir cleanup. `--data-only`
    // skips the bundle/LaunchServices teardown — the shared
    // `Tug-apptest.app` outlives any single `apptest-<uuid>` instance.
    if !data_only
        && let Some(bp) = &bundle_path
        && bp.exists()
    {
        println!("unregistering bundle from LaunchServices: {}", bp.display());
        let _ = std::process::Command::new(
            "/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister",
        )
        .args(["-u"])
        .arg(bp)
        .status();
        println!("removing bundle: {}", bp.display());
        let _ = std::fs::remove_dir_all(bp);
    }

    if data_dir.exists() {
        println!("removing data dir: {}", data_dir.display());
        std::fs::remove_dir_all(&data_dir).map_err(|e| format!("rm data dir: {e}"))?;
    }

    // 5. TCC reset (optional).
    if with_tcc {
        if let Some(bp) = &bundle_path {
            if let Some(bundle_id) = read_bundle_id_from_app(bp) {
                println!("tccutil reset Accessibility {bundle_id}");
                let _ = std::process::Command::new("tccutil")
                    .args(["reset", "Accessibility"])
                    .arg(&bundle_id)
                    .status();
            } else {
                eprintln!("warning: could not read CFBundleIdentifier; skipping tccutil");
            }
        } else {
            eprintln!("warning: no bundle marker; skipping tccutil");
        }
    }

    println!("instance '{instance_id}' removed");
    Ok(0)
}

// ── prune ────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct OrphanReport<'a> {
    instance_id: &'a str,
    data_dir: &'a Path,
    bundle_path: &'a Path,
    /// Why this dir is an orphan: `"bundle-missing"` (full removal) or
    /// `"ephemeral-dead"` (data-only removal — shared bundle survives).
    reason: &'a str,
    last_modified_unix: Option<i64>,
}

struct Orphan {
    id: String,
    data_dir: PathBuf,
    bundle_path: PathBuf,
    /// True for dead `apptest-<uuid>` instances whose bundle still
    /// exists — remove the data dir only, never the shared bundle.
    data_only: bool,
    mtime: Option<i64>,
}

/// Remove only the bundle-missing orphans — the half of `prune` that
/// needs the full removal path (and its LaunchServices bookkeeping).
///
/// `tugtool host sweep` runs this after the janitor, which has already
/// reclaimed the data-only class.
pub(crate) fn run_prune_bundle_missing(yes: bool, with_tcc: bool) -> Result<i32, String> {
    let Some(orphans) = discover_orphans(false)? else {
        return Ok(0);
    };
    let orphans: Vec<Orphan> = orphans.into_iter().filter(|o| !o.data_only).collect();
    if orphans.is_empty() {
        return Ok(0);
    }
    remove_orphans(&orphans, yes, with_tcc)
}

fn run_prune(yes: bool, with_tcc: bool, json: bool) -> Result<i32, String> {
    let Some(orphans) = discover_orphans(json)? else {
        return Ok(0);
    };
    report_and_remove_prune(orphans, yes, with_tcc, json)
}

/// Walk the instances root and classify every orphaned data dir.
/// `None` means there is no instances directory at all (already
/// reported to the caller's chosen surface).
fn discover_orphans(json: bool) -> Result<Option<Vec<Orphan>>, String> {
    let base = tugcore::instances_root();
    if !base.exists() {
        if json {
            println!("[]");
        } else {
            println!("no instances directory at {}", base.display());
        }
        return Ok(None);
    }

    let mut orphans: Vec<Orphan> = Vec::new();
    for entry in std::fs::read_dir(&base).map_err(|e| format!("read {}: {e}", base.display()))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let marker = dir.join(tugcore::instance::BUNDLE_PATH_MARKER);
        let Ok(bundle_path_str) = std::fs::read_to_string(&marker) else {
            // No marker — predate Step 7, skip per Step 14 contract.
            continue;
        };
        let bundle_path = PathBuf::from(bundle_path_str.trim());

        // Bundle gone → orphan regardless of identity (full removal).
        // Bundle present → only ephemeral app-test IDs that are no
        // longer live are reclaimable (data-only). A live instance has
        // a registry entry (filtered to live PIDs by `find_by_id`), so
        // an in-flight app-test run is never swept out from under
        // itself. Dev/release dirs with a present bundle are kept.
        let data_only = if bundle_path.exists() {
            let is_dead_apptest = tugcore::ports::is_apptest_id(&id)
                && registry::find_by_id(&id)
                    .map(|e| e.is_none())
                    .unwrap_or(false);
            if !is_dead_apptest {
                continue;
            }
            true
        } else {
            false
        };

        let mtime = std::fs::metadata(&dir)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        orphans.push(Orphan {
            id,
            data_dir: dir,
            bundle_path,
            data_only,
            mtime,
        });
    }
    Ok(Some(orphans))
}

fn report_and_remove_prune(
    orphans: Vec<Orphan>,
    yes: bool,
    with_tcc: bool,
    json: bool,
) -> Result<i32, String> {
    if json {
        let report: Vec<OrphanReport> = orphans
            .iter()
            .map(|o| OrphanReport {
                instance_id: &o.id,
                data_dir: &o.data_dir,
                bundle_path: &o.bundle_path,
                reason: if o.data_only {
                    "ephemeral-dead"
                } else {
                    "bundle-missing"
                },
                last_modified_unix: o.mtime,
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
        return Ok(0);
    }

    if orphans.is_empty() {
        println!("no orphaned data dirs");
        return Ok(0);
    }

    remove_orphans(&orphans, yes, with_tcc)
}

fn remove_orphans(orphans: &[Orphan], yes: bool, with_tcc: bool) -> Result<i32, String> {
    println!("orphaned data dirs ({}):", orphans.len());
    for o in orphans {
        println!("  {}", o.id);
        println!("    data dir: {}", o.data_dir.display());
        if o.data_only {
            println!(
                "    bundle:   {} (shared; kept — data-only)",
                o.bundle_path.display()
            );
        } else {
            println!("    bundle:   {} (missing)", o.bundle_path.display());
        }
    }
    if !yes && !confirm("Remove all of the above?")? {
        println!("aborted");
        return Ok(0);
    }
    for o in orphans {
        // `instance remove` already prints its own progress; pass
        // `--yes` so we don't re-prompt for each orphan.
        if let Err(e) = run_remove(&o.id, with_tcc, o.data_only, true) {
            eprintln!("warning: removing '{}' failed: {e}", o.id);
        }
    }
    Ok(0)
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn send_signal(pid: i32, sig: i32) {
    unsafe {
        let _ = libc::kill(pid as libc::pid_t, sig);
    }
}

fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    let err = std::io::Error::last_os_error();
    err.raw_os_error() == Some(libc::EPERM)
}

pub(crate) fn confirm(prompt: &str) -> Result<bool, String> {
    print!("{prompt} [y/N]: ");
    use std::io::Write;
    std::io::stdout().flush().ok();
    let mut buf = [0u8; 16];
    let n = std::io::stdin()
        .read(&mut buf)
        .map_err(|e| format!("read stdin: {e}"))?;
    let s = std::str::from_utf8(&buf[..n])
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Ok(s == "y" || s == "yes")
}

fn read_bundle_id_from_app(bundle_path: &Path) -> Option<String> {
    let plist = bundle_path.join("Contents/Info.plist");
    let output = std::process::Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIdentifier"])
        .arg(&plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_alive_recognises_init() {
        assert!(pid_alive(1));
    }

    #[test]
    fn pid_alive_rejects_zero_or_negative() {
        assert!(!pid_alive(0));
        assert!(!pid_alive(-1));
    }
}
