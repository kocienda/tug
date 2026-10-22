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
//!
//! **A dev or release instance's data dir is user state** — its workspaces,
//! sessions, drafts — and nothing here deletes it. `prune` reclaims only
//! ephemeral app-test dirs; a dev/release dir whose bundle is missing is
//! a build that is missing, not data that is unwanted, and it is left
//! alone. `remove` is the one explicit door, and it retires the dir under
//! `<data root>/retired/` rather than deleting it, so a wrong call is
//! undone by moving a directory back. The 2026-10-21 loss — an app-test
//! run's `sweep --yes` pruned the live `release-main` dir while the
//! Release bundle was between a clean and a rebuild — is why ([L23]).

use std::io::Read;
use std::path::{Path, PathBuf};

use clap::Subcommand;
use tugcore::registry;

#[derive(Subcommand, Debug)]
pub enum InstanceCommands {
    /// List every live Tug instance registered with this host.
    List,

    /// Quit a running instance with the `quit` Apple Event, as the OS does.
    ///
    /// Sends `'aevt'/'quit'` to the host app's pid from the registry, so the
    /// deck's termination pipeline runs — live turns interrupted, every card
    /// persisted — and waits for the app to exit, saying so every 5 s. A
    /// reply that has not arrived after 3 s writes a stall directory under
    /// `instances/<id>/stalls/` and the wait goes on. Past `--timeout` it
    /// exits 1 and has signalled nothing. A tugcast that outlives the app is
    /// reaped as `stop` would. `--json` reports the send status, time to
    /// reply and time to exit.
    Quit {
        /// Instance ID to quit (e.g. `release-main`, `debug-foo`).
        instance_id: String,

        /// Seconds to wait for the app to exit.
        #[arg(long, default_value_t = 90)]
        timeout: u64,

        /// Skip the Apple Event and run the `stop` ladder instead: SIGTERM,
        /// then SIGKILL. The deck's termination pipeline does not run.
        #[arg(long)]
        force: bool,
    },

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
    /// 4. Retire the data dir to `<data root>/retired/<id>-<unix-secs>/`
    ///    (an app-test dir, which is ephemeral, is deleted instead).
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

    /// Discover and (optionally) remove orphaned app-test data dirs.
    ///
    /// Walks `~/Library/Application Support/Tug/instances/*/`. A data
    /// dir is an orphan only when it belongs to an ephemeral
    /// `apptest-<uuid>` instance that is not currently live in the
    /// registry. App-test IDs are single-use, so once the run ends the
    /// dir is garbage even though its shared `Tug-apptest.app` bundle
    /// still exists.
    ///
    /// A dev or release dir is never an orphan, whatever its bundle-path
    /// marker says: a missing bundle is a missing build, and the dir is
    /// the user's workspaces and sessions. Only `instance remove <id>`
    /// touches one, and it retires rather than deletes.
    Prune {
        /// Skip the interactive confirmation prompt.
        #[arg(long)]
        yes: bool,

        /// Also reset TCC entries for each orphan's bundle ID
        /// (off by default; see `instance remove --with-tcc`).
        #[arg(long)]
        with_tcc: bool,
    },
}

/// The name a `host instance` verb's `--json` envelope carries in `command`.
pub fn command_name(cmd: &InstanceCommands) -> &'static str {
    match cmd {
        InstanceCommands::List => "host instance list",
        InstanceCommands::Quit { .. } => "host instance quit",
        InstanceCommands::Stop { .. } => "host instance stop",
        InstanceCommands::Current => "host instance current",
        InstanceCommands::Remove { .. } => "host instance remove",
        InstanceCommands::Prune { .. } => "host instance prune",
    }
}

/// Entry point — dispatch to the right subcommand impl. `json` is the global
/// `--json`, which `prune` reads as "report the orphans, remove nothing".
pub fn run_instance(cmd: InstanceCommands, json: bool) -> Result<i32, String> {
    match cmd {
        InstanceCommands::List => run_list(json),
        InstanceCommands::Quit {
            instance_id,
            timeout,
            force,
        } => run_quit(&instance_id, timeout, force, json),
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
        InstanceCommands::Prune { yes, with_tcc } => run_prune(yes, with_tcc, json),
    }
}

// ── list ─────────────────────────────────────────────────────────────────────

fn run_list(json: bool) -> Result<i32, String> {
    let entries = registry::list_live().map_err(|e| format!("read registry: {e}"))?;
    if json {
        // The whole entry, host pid included: the recipes that read an
        // instance's app (`app-log`, `app-sample`, `app-state`) resolve it
        // from here rather than from a process search.
        crate::output::print_ok(
            "host instance list",
            serde_json::json!({ "instances": entries }),
        );
        return Ok(0);
    }
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

// ── quit ─────────────────────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
fn run_quit(_instance_id: &str, _timeout: u64, _force: bool, _json: bool) -> Result<i32, String> {
    Err("`host instance quit` sends an Apple Event and needs macOS".to_string())
}

#[cfg(target_os = "macos")]
fn run_quit(instance_id: &str, timeout_secs: u64, force: bool, json: bool) -> Result<i32, String> {
    use super::instance_quit::{QuitOutcome, QuitTarget, quit_host};

    if force {
        return run_stop(instance_id, 5);
    }
    let Some(entry) =
        registry::find_by_id(instance_id).map_err(|e| format!("read registry: {e}"))?
    else {
        // Quitting what is not running is done already: the recipes call
        // this unconditionally before a build.
        if json {
            crate::output::print_ok(
                "host instance quit",
                serde_json::json!({ "instance": instance_id, "outcome": "not-running" }),
            );
        } else {
            println!("instance '{instance_id}' is not running");
        }
        return Ok(0);
    };

    let host_needle = host_needle(&entry.bundle_path);
    let host_pid = entry.host_pid;
    let have_host =
        host_pid > 0 && pid_alive(host_pid) && pid_is(host_pid, &host_needle, "host app");
    if !have_host {
        // The GUI is gone already; what can be left is a tugcast, and
        // reaping that is `stop`'s job.
        if !json {
            println!("instance '{instance_id}' has no running host app; reaping what is left");
        }
        return run_stop(instance_id, 5);
    }

    let target = QuitTarget {
        instance_id: instance_id.to_string(),
        host_pid,
        tugcast_port: entry.tugcast_port,
        stall_root: tugcore::instance_data_dir_for(instance_id).join("stalls"),
    };
    if !json {
        println!("quitting {instance_id} — quit Apple Event to host app (PID {host_pid})");
    }
    let mut say = |line: String| {
        if json {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    };
    let mut report = quit_host(
        &target,
        std::time::Duration::from_secs(timeout_secs.max(1)),
        &mut say,
    );

    if report.outcome == QuitOutcome::Quit {
        // tugcast follows its parent within its 2 s parent-watch; one that
        // outlives that is reaped the way `stop` reaps it.
        let tugcast_pid = entry.pid;
        let grace = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while pid_alive(tugcast_pid) && std::time::Instant::now() < grace {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if pid_alive(tugcast_pid) && pid_is(tugcast_pid, "tugcast", "tugcast") {
            say(format!(
                "tugcast (PID {tugcast_pid}) outlived the app — reaping it"
            ));
            report.tugcast_reaped = true;
            run_stop(instance_id, 5)?;
        }
    }

    let failure = match report.outcome {
        QuitOutcome::Quit => None,
        QuitOutcome::Refused | QuitOutcome::Stalled => Some(format!(
            "quit of '{instance_id}' {}: {}",
            if report.outcome == QuitOutcome::Refused {
                "refused"
            } else {
                "stalled"
            },
            report.error.clone().unwrap_or_default()
        )),
    };
    if json {
        match &failure {
            None => crate::output::print_ok("host instance quit", &report),
            Some(message) => crate::output::print_error_with(
                "host instance quit",
                &report,
                &crate::changes::AppError::from(message.clone()),
            ),
        }
        return Ok(if failure.is_some() { 1 } else { 0 });
    }
    match failure {
        None => {
            println!(
                "quit {instance_id}: exited in {:.1}s",
                report.exit_ms.unwrap_or(0) as f64 / 1000.0
            );
            Ok(0)
        }
        Some(message) => Err(match &report.stall_dir {
            Some(dir) => format!("{message} — evidence in {}", dir.display()),
            None => message,
        }),
    }
}

/// The host app's executable name, which its command line contains: the
/// bundle's stem (`Tug`, `Tug-debug-foo`).
fn host_needle(bundle_path: &Path) -> String {
    bundle_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Tug")
        .to_string()
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
    let host_needle = host_needle(&entry.bundle_path);
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
        if tugcore::ports::is_apptest_id(instance_id) {
            println!("removing data dir: {}", data_dir.display());
            std::fs::remove_dir_all(&data_dir).map_err(|e| format!("rm data dir: {e}"))?;
        } else {
            let dest = retire_data_dir(&data_dir, instance_id)?;
            println!(
                "retired data dir: {} → {}",
                data_dir.display(),
                dest.display()
            );
        }
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

/// Move a dev/release instance's data dir aside instead of deleting it:
/// `<data root>/retired/<id>-<unix-secs>/`, a rename on the same volume.
/// What `remove` takes away is the user's workspaces and sessions, and a
/// rename is the one removal a wrong call can undo by hand.
pub(crate) fn retire_data_dir(data_dir: &Path, instance_id: &str) -> Result<PathBuf, String> {
    let root = data_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| format!("data dir has no data root: {}", data_dir.display()))?;
    retire_data_dir_under(data_dir, instance_id, &root.join("retired"))
}

fn retire_data_dir_under(
    data_dir: &Path,
    instance_id: &str,
    retired: &Path,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(retired).map_err(|e| format!("mkdir {}: {e}", retired.display()))?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut dest = retired.join(format!("{instance_id}-{secs}"));
    let mut n = 1;
    while dest.exists() {
        dest = retired.join(format!("{instance_id}-{secs}-{n}"));
        n += 1;
    }
    std::fs::rename(data_dir, &dest)
        .map_err(|e| format!("retire {} → {}: {e}", data_dir.display(), dest.display()))?;
    Ok(dest)
}

/// Whether a data dir may be reclaimed by `prune`: only an app-test id
/// with no live registry entry. A dev or release dir never is, whether or
/// not its bundle still exists.
pub(crate) fn prunable(instance_id: &str, live: bool) -> bool {
    tugcore::ports::is_apptest_id(instance_id) && !live
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
            crate::output::print_ok("host instance prune", serde_json::json!([]));
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

        // Only an ephemeral app-test id that is no longer live is
        // reclaimable, and only data-only (its bundle is shared). A live
        // instance has a registry entry (filtered to live PIDs by
        // `find_by_id`), so an in-flight app-test run is never swept out
        // from under itself. A dev/release dir is never an orphan: its
        // bundle being gone means a build is gone, not that the user's
        // workspaces and sessions are. A registry read that fails counts
        // as live — the safe side.
        let live = registry::find_by_id(&id)
            .map(|e| e.is_some())
            .unwrap_or(true);
        if !prunable(&id, live) {
            continue;
        }
        let data_only = true;

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
        crate::output::print_ok("host instance prune", &report);
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

pub(crate) fn pid_alive(pid: i32) -> bool {
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

    /// The 2026-10-21 loss: a dev/release dir whose bundle was missing was
    /// an orphan, and a scripted `sweep --yes` deleted it. Never again —
    /// only a dead app-test id is prunable, bundle or no bundle.
    #[test]
    fn prune_never_reclaims_a_dev_or_release_dir() {
        assert!(!prunable("release-main", false));
        assert!(!prunable("release-main", true));
        assert!(!prunable("debug-main", false));
        assert!(!prunable("debug-tugarc-foo", false));
        assert!(prunable("apptest-tugarc-foo-1234", false));
        assert!(!prunable("apptest-tugarc-foo-1234", true));
    }

    /// `remove` retires a data dir by rename; the bytes survive under
    /// `retired/` and nothing is deleted.
    #[test]
    fn remove_retires_a_data_dir_instead_of_deleting_it() {
        let root = tempfile::tempdir().expect("tempdir");
        let data_dir = root.path().join("instances").join("release-main");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("tugbank.db"), b"workspaces").unwrap();
        let retired = root.path().join("retired");
        let dest = retire_data_dir_under(&data_dir, "release-main", &retired).unwrap();
        assert!(!data_dir.exists(), "the original path is vacated");
        assert!(dest.starts_with(&retired));
        assert_eq!(
            std::fs::read(dest.join("tugbank.db")).unwrap(),
            b"workspaces",
            "every byte survives the retirement"
        );
        // The data-root form resolves `<root>/retired` from the dir itself.
        std::fs::create_dir_all(&data_dir).unwrap();
        let dest2 = retire_data_dir(&data_dir, "release-main").unwrap();
        assert!(dest2.starts_with(&retired));
        assert_ne!(
            dest, dest2,
            "a second retirement never overwrites the first"
        );
    }
}
