//! `boot::early` — everything that runs before the server claims anything.

use tracing::{info, warn};
use tugcore::instance as tug_instance;

use crate::cli;
use crate::feeds;
use crate::session_ledger::{self, SessionLedger};

/// What the early stage hands on: the parsed command line, and the log guard
/// that keeps `tugcast.log` flushing for the life of the process.
pub(crate) struct Early {
    pub(crate) log_guard: tuglog::LogGuard,
    pub(crate) cli: cli::Cli,
}

/// Install the panic hook, write the bundle-path marker, start the debris
/// sweep, take our own process group, and parse the command line. A developer
/// subcommand or a ledger seed runs here and exits; neither returns.
pub(crate) async fn early(log_guard: tuglog::LogGuard) -> Early {
    // Every panic from here on reaches `tugcast.log`, whichever thread or
    // task it happens on. Installed straight after tracing so nothing the
    // server does runs without it.
    crate::panic_hook::install();

    // Write the per-instance bundle-path marker. When Swift launched
    // us it passed TUG_INSTANCE_ID and TUG_BUNDLE_PATH; the marker
    // anchors `tugtool host instance prune` orphan detection. When either
    // var is unset (standalone harness launches, dev iteration) the
    // helper no-ops.
    match tug_instance::write_bundle_path_marker() {
        Ok(tug_instance::MarkerWrite::Written) => info!("bundle-path marker written"),
        Ok(tug_instance::MarkerWrite::Unchanged | tug_instance::MarkerWrite::Skipped) => {}
        Err(e) => warn!(error = %e, "failed to write bundle-path marker"),
    }

    // Reclaim leaked runtime debris machine-wide. A dev/release launch is
    // the only routine event on a machine where app-tests never run, so
    // hooking it means merely using Tug keeps the machine clean —
    // otherwise nothing runs and dead sockets accumulate by the thousand.
    //
    // Detached: the sweep must never delay serving. Only for a real
    // instance (a test-spawned tugcast has no instance id), and
    // additionally excluded for app-test instances — there are dozens per
    // run, and mid-run sweeps of sibling instances are risk without gain.
    //
    // This runs before we register ourselves, which is harmless: only
    // `apptest-` data dirs are candidates, so a dev/release instance is
    // never its own. An app-test instance booting elsewhere is protected
    // by the janitor's minimum-age floor.
    if tugcore::instance::instance_id().is_some_and(|id| !tugcore::ports::is_apptest_id(&id)) {
        std::thread::spawn(|| {
            let r = tugcore::janitor::sweep_all(tugcore::janitor::SweepMode::Apply);
            if !r.is_empty() {
                info!(
                    sockets = r.dead_sockets.len(),
                    tmux_servers = r.tmux_servers_killed.len(),
                    tmux_sockets = r.tmux_sockets_unlinked.len(),
                    tmp_files = r.tmp_files_removed.len(),
                    tmp_dirs = r.tmp_dirs_removed.len(),
                    data_dirs = r.apptest_data_dirs_removed.len(),
                    seeded_transcripts = r.seeded_transcripts_removed.len(),
                    processes = r.processes_killed.len(),
                    legacy_sessions = r.legacy_sessions_killed.len(),
                    "janitor: swept leaked runtime debris"
                );
            }
        });
    }

    // Create own process group so the app can kill tugcast + all children
    // (tugcode, bun) with a single kill(-pgid, SIGTERM). Without this,
    // children become orphans when the app force-kills tugcast.
    unsafe {
        libc::setpgid(0, 0);
    }

    // Parse CLI arguments
    let cli = cli::Cli::parse();

    // Developer subcommands run before anything the server owns is claimed —
    // no port bound, no instance registered, no ledger writer taken — so one
    // can be run against a machine with a live tugcast on it without the two
    // ever meeting.
    if let Some(command) = cli.command.as_ref() {
        let code = match command {
            cli::Command::OverviewReplay(args) => {
                let opts = feeds::overview_replay::ReplayOptions::from_args(args);
                feeds::overview_replay::run(&args.jsonl, &opts).await
            }
            cli::Command::OperatorAsk(args) => feeds::operator_ask::run(args).await,
        };
        // `process::exit` runs no destructors, and the log writer is
        // non-blocking — without this drop every line a subcommand logged is
        // still in the buffer when the process disappears, which is how a run
        // that logged one INFO line per verb leaves an empty log file.
        drop(log_guard);
        std::process::exit(code);
    }

    // Ledger seeding runs before everything else and never returns — it must
    // not bind a port, register an instance, or touch tmux.
    if let Some(spec) = cli.seed_ledger.as_deref() {
        seed_ledger(spec);
    }

    Early { log_guard, cli }
}

/// One session row to seed. Mirrors `record_spawn`'s arguments.
#[derive(serde::Deserialize)]
struct SeedSession {
    session_id: String,
    workspace_key: String,
    project_dir: String,
    #[serde(default)]
    card_id: String,
    /// Display name for the entry's title, applied via `rename`.
    #[serde(default)]
    name: Option<String>,
    /// The session's callsign. Written by `record_spawn` exactly as the real
    /// spawn path writes it, so a seeded session is addressable by the name a
    /// citation or a session atom carries.
    #[serde(default)]
    tag: Option<String>,
    /// The arc this session is mated to, as `(owner key, short name)`.
    ///
    /// Applied through the same `set_arc_binding` a real `bind_arc` uses, so
    /// the seeded row is indistinguishable from a bound one — which is what
    /// makes it possible to stand up "another live session is holding this
    /// arc" without launching a second card and a second agent.
    #[serde(default)]
    arc_id: Option<String>,
    #[serde(default)]
    arc_name: Option<String>,
    /// The session this one was rewind-forked from, written through the same
    /// `set_fork_provenance` the fork arc uses. This is the edge every durable
    /// ink read resolves along, so seeding it is how a test can stand up the
    /// post-fork ledger state a relaunch actually binds to — without needing a
    /// live `claude` to perform a real fork.
    #[serde(default)]
    forked_from_session_id: Option<String>,
    /// The prompt uuid of the rewind point. Only meaningful alongside
    /// `forked_from_session_id`; a placeholder is fine, since nothing reads it
    /// except a human looking at the row.
    #[serde(default)]
    fork_point: Option<String>,
    /// The line of work this session is a **segment** of ([P01]). Two seeded
    /// sessions sharing a `line_id` are two segments of one line, which is
    /// how a test stands up a card that has rotated — without a live `claude`
    /// to perform the rotation. Defaults to the session's own id, i.e. a line
    /// of one.
    #[serde(default)]
    line_id: Option<String>,
    /// What a rotation seated this session as, written through the same
    /// `set_stage_provenance` a real rotation uses.
    #[serde(default)]
    stage_label: Option<String>,
    #[serde(default)]
    stage_model: Option<String>,
    /// The row's lifecycle state. `record_spawn` writes `live`; a seed that
    /// says `closed` is marked closed afterwards, which is how a test seeds a
    /// line whose older segments are done and whose newest one is not.
    #[serde(default)]
    state: Option<String>,
}

/// One file event to seed, with the sub-file evidence that decides whether
/// two owners of the path contend ([P12]). `spans` is optional and flattened
/// alongside the row's own fields, so a spec written before spans existed
/// still reads.
#[derive(serde::Deserialize)]
struct SeedFileEvent {
    #[serde(flatten)]
    row: session_ledger::FileEventRow,
    #[serde(default)]
    spans: Vec<session_ledger::FileEventSpan>,
}

/// One prompt the wheel is to be recorded as having sent. Written through the
/// same `record_wheel_prompt` the wheel itself calls, so a seeded row is what
/// a real arc leaves behind — which is how a test can stand up "the wheel
/// spoke, then the app was relaunched" without a live arc and a live claude.
#[derive(serde::Deserialize)]
struct SeedWheelPrompt {
    /// A session on the line the prompt belongs to. The line is resolved from
    /// this row, exactly as it is on the real write.
    session_id: String,
    /// The prompt as it went on the wire — what the replay matches against.
    text: String,
}

/// The seed spec's whole shape: live sessions and the file events that make
/// them own something.
#[derive(serde::Deserialize)]
struct SeedSpec {
    #[serde(default)]
    sessions: Vec<SeedSession>,
    #[serde(default)]
    file_events: Vec<SeedFileEvent>,
    #[serde(default)]
    wheel_prompts: Vec<SeedWheelPrompt>,
}

/// Seed this instance's ledger from a JSON spec and exit.
///
/// The app-test harness's pre-launch hook, and the answer to a gap that had
/// been recorded as unreachable: a `sessions` row is written only by the real
/// spawn path (`session_init` from a live tugcode subprocess), so an app-test
/// could compose *unattributed* changeset rows but never a **session entry** —
/// leaving every affordance that hangs off one uncovered.
///
/// Writing through the real [`SessionLedger`] rather than raw SQL is the whole
/// point: the schema, the migrations, and the change journal come along, so a
/// seeded ledger is one the server would have written itself. A hand-mirrored
/// `CREATE TABLE` in the harness would drift the first time the schema moved.
///
/// **Refused outside an app-test instance.** The gate is the instance id, the
/// same signal the janitor and the startup sweep already trust: seeding is a
/// test affordance, and pointing it at a developer's real ledger would forge
/// attribution rows in the ledger the Changes card reads.
fn seed_ledger(spec_path: &std::path::Path) -> ! {
    let instance = tugcore::instance::instance_id();
    if !instance
        .as_deref()
        .is_some_and(tugcore::ports::is_apptest_id)
    {
        eprintln!(
            "tugcast: error: --seed-ledger requires an app-test instance \
             (TUG_INSTANCE_ID is {:?}); refusing to seed a real ledger",
            instance.as_deref().unwrap_or("<unset>")
        );
        std::process::exit(2);
    }

    let raw = match std::fs::read_to_string(spec_path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!(
                "tugcast: error: cannot read seed spec {}: {e}",
                spec_path.display()
            );
            std::process::exit(1);
        }
    };
    let spec: SeedSpec = match serde_json::from_str(&raw) {
        Ok(spec) => spec,
        Err(e) => {
            eprintln!("tugcast: error: malformed seed spec: {e}");
            std::process::exit(1);
        }
    };

    let Some(path) = SessionLedger::default_path() else {
        eprintln!("tugcast: error: cannot resolve the session ledger path");
        std::process::exit(1);
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("tugcast: error: cannot create {}: {e}", parent.display());
            std::process::exit(1);
        }
    }
    // Port 0: the seeder serves nothing, and the value only rides the row's
    // liveness bookkeeping.
    let ledger = match SessionLedger::open(&path, 0) {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "tugcast: error: cannot open the ledger at {}: {e}",
                path.display()
            );
            std::process::exit(1);
        }
    };

    let now = session_ledger::now_millis();
    for session in &spec.sessions {
        if let Err(e) = ledger.record_spawn(
            &session.session_id,
            &session.workspace_key,
            &session.project_dir,
            &session.card_id,
            now,
            // Empty when the spec names none — the ledger then answers the
            // question itself, and the row becomes a line of one.
            session.line_id.as_deref().unwrap_or(""),
            session.tag.as_deref(),
        ) {
            eprintln!("tugcast: error: record_spawn failed: {e}");
            std::process::exit(1);
        }
        if let Some(name) = session.name.as_deref() {
            let Some(line_id) = ledger.line_of(&session.session_id) else {
                eprintln!("tugcast: error: rename failed: the seeded session has no line");
                std::process::exit(1);
            };
            if let Err(e) = ledger.rename(&line_id, Some(name)) {
                eprintln!("tugcast: error: rename failed: {e}");
                std::process::exit(1);
            }
        }
        if let Some(parent) = session.forked_from_session_id.as_deref() {
            // A seeded row's fork point passes through as it was given,
            // including absent: the column takes `NULL` now, so a stand-in
            // value would be inventing a branch point the seed never named.
            if let Err(e) = ledger.set_fork_provenance(
                &session.session_id,
                parent,
                session.fork_point.as_deref(),
            ) {
                eprintln!("tugcast: error: set_fork_provenance failed: {e}");
                std::process::exit(1);
            }
        }
        if let Some(arc_id) = session.arc_id.as_deref() {
            let arc_name = session.arc_name.as_deref().unwrap_or(arc_id);
            if let Err(e) = ledger.set_arc_binding(&session.session_id, Some((arc_id, arc_name))) {
                eprintln!("tugcast: error: set_arc_binding failed: {e}");
                std::process::exit(1);
            }
        }
        if let Some(label) = session.stage_label.as_deref() {
            if let Err(e) = ledger.set_stage_provenance(
                &session.session_id,
                label,
                session.stage_model.as_deref(),
            ) {
                eprintln!("tugcast: error: set_stage_provenance failed: {e}");
                std::process::exit(1);
            }
        }
        if session.state.as_deref() == Some("closed") {
            if let Err(e) = ledger.mark_closed(&session.session_id) {
                eprintln!("tugcast: error: mark_closed failed: {e}");
                std::process::exit(1);
            }
        }
    }
    for event in &spec.file_events {
        if let Err(e) = ledger.record_file_event_with_spans(&event.row, &event.spans) {
            eprintln!("tugcast: error: record_file_event failed: {e}");
            std::process::exit(1);
        }
    }
    for (i, prompt) in spec.wheel_prompts.iter().enumerate() {
        match ledger.record_wheel_prompt(
            &prompt.session_id,
            &format!("seed-wheel-{i}"),
            &prompt.text,
            session_ledger::now_millis() + i as i64,
        ) {
            Ok(true) => {}
            Ok(false) => {
                eprintln!(
                    "tugcast: error: record_wheel_prompt: no session {}",
                    prompt.session_id
                );
                std::process::exit(1);
            }
            Err(e) => {
                eprintln!("tugcast: error: record_wheel_prompt failed: {e}");
                std::process::exit(1);
            }
        }
    }

    println!(
        "seeded {} session(s), {} file event(s), and {} wheel prompt(s) into {}",
        spec.sessions.len(),
        spec.file_events.len(),
        spec.wheel_prompts.len(),
        path.display()
    );
    std::process::exit(0);
}
