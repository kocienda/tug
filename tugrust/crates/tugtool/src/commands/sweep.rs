//! `tugtool host sweep` — the machine-wide janitor verb.
//!
//! Runs every `tugcore::janitor` pass and then the bundle-missing half
//! of `instance prune`, so one command reclaims every class of leaked
//! runtime debris: dead control/notify sockets, orphaned app-test tmux
//! servers, aged `$TMPDIR` test litter, finished app-test data dirs, and
//! `tugcode`/`claude` processes reparented to launchd.
//!
//! Nothing here deletes by name pattern alone. Each class is gated by
//! the strongest liveness signal it has — see `tugcore::janitor`.

use tugcore::janitor::{self, SweepMode, SweepReport};

/// Per-section print cap. A backlog of ten thousand dead sockets must
/// not bury the rest of the report; everything is still swept.
const CAP: usize = 12;

pub fn run_sweep(yes: bool, json: bool, quiet: bool, dry_run: bool) -> Result<i32, String> {
    // `--json` reports without removing, mirroring `instance prune --json`.
    // Deliberately uncapped: a machine-readable report that silently
    // truncated would be worse than a long one.
    if json {
        let report = janitor::sweep_all(SweepMode::Report);
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
        return Ok(0);
    }

    // `--dry-run` is the human read of the same thing: capped, sectioned,
    // and non-interactive, so a recipe can print it without prompting.
    if dry_run {
        let report = janitor::sweep_all(SweepMode::Report);
        if report.is_empty() {
            println!("nothing to sweep");
            return Ok(0);
        }
        print_report(&report, "would sweep", quiet);
        return Ok(0);
    }

    if !yes {
        let preview = janitor::sweep_all(SweepMode::Report);
        if preview.is_empty() {
            println!("nothing to sweep");
            return Ok(0);
        }
        print_report(&preview, "would sweep", quiet);
        if !super::instance::confirm("Sweep all of the above?")? {
            println!("aborted");
            return Ok(0);
        }
    }

    let report = janitor::sweep_all(SweepMode::Apply);
    if report.is_empty() {
        if !quiet {
            println!("nothing to sweep");
        }
        return Ok(0);
    }
    print_report(&report, "swept", quiet);

    // Bundle-missing dirs need the full removal path, which also has
    // LaunchServices bookkeeping to do — that stays in `prune`.
    super::instance::run_prune_bundle_missing(true, false)?;
    Ok(0)
}

fn print_report(r: &SweepReport, verb: &str, quiet: bool) {
    fn strs(v: &[std::path::PathBuf]) -> Vec<String> {
        v.iter().map(|p| p.display().to_string()).collect()
    }
    section(verb, "dead sockets", &strs(&r.dead_sockets), quiet);
    section(verb, "tmux servers", &r.tmux_servers_killed, quiet);
    section(
        verb,
        "tmux socket files",
        &strs(&r.tmux_sockets_unlinked),
        quiet,
    );
    section(verb, "temp files", &strs(&r.tmp_files_removed), quiet);
    section(verb, "temp dirs", &strs(&r.tmp_dirs_removed), quiet);
    section(
        verb,
        "app-test data dirs",
        &r.apptest_data_dirs_removed,
        quiet,
    );
    section(
        verb,
        "legacy default-server sessions",
        &r.legacy_sessions_killed,
        quiet,
    );
    let procs: Vec<String> = r
        .processes_killed
        .iter()
        .map(|(pid, cmd)| format!("{pid} {cmd}"))
        .collect();
    section(verb, "reparented processes", &procs, quiet);
}

fn section(verb: &str, label: &str, items: &[String], quiet: bool) {
    if items.is_empty() {
        return;
    }
    println!("{verb} {} {label}", items.len());
    if quiet {
        return;
    }
    for item in items.iter().take(CAP) {
        println!("  {item}");
    }
    if items.len() > CAP {
        println!(
            "  … and {} more (cap reached; every item is still swept)",
            items.len() - CAP
        );
    }
}
