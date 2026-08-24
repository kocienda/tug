//! Dashes — worktree-isolated work units (`tugutil dash …`). A thin shell over
//! [`tugdash_core::ops`]: parse arguments, read commit round-metadata from stdin,
//! call the typed library API, and format the outcome as `--json` (the shared
//! envelope) or a plain human read-out.

use std::io::{self, IsTerminal, Read};
use std::process::ExitCode;

use serde::Serialize;

use tugdash_core::{
    DashRoundMeta, JoinOptions, JoinStrategy, MarkStage, ReplayOutcome, ops, replay, resolve,
};

use crate::cli::{DashCommands, StepAction};
use crate::output::print_ok;

/// Dispatch a `dash` subcommand, mapping a `Result<(), String>` to an exit code
/// (exit 1 on any error, matching the former standalone tugdash binary).
pub fn dispatch(cmd: DashCommands, json: bool, quiet: bool) -> ExitCode {
    let result: Result<(), String> = match cmd {
        DashCommands::Create {
            name,
            description,
            plan,
            carry,
            base,
        } => run_create(
            &name,
            description,
            plan.as_deref(),
            carry,
            base.as_deref(),
            json,
            quiet,
        ),
        DashCommands::AdoptPlan { name, plan } => {
            run_adopt_plan(&name, plan.as_deref(), json, quiet)
        }
        DashCommands::Commit { name, message } => run_commit(&name, &message, json, quiet),
        DashCommands::Join {
            name,
            message,
            strategy,
            preview,
            continue_join,
            resolve,
        } if resolve => run_join_resolve(&name, message, strategy.into(), json, quiet),
        DashCommands::Join {
            name,
            message,
            strategy,
            preview,
            continue_join,
            resolve: _,
        } => run_join(
            &name,
            JoinOptions {
                strategy: strategy.into(),
                message,
                preview,
                continue_join,
                candidate: None,
                origin: Some("cli".to_string()),
            },
            json,
            quiet,
        ),
        DashCommands::Replay { name } => return run_replay(&name, json, quiet),
        DashCommands::Discard { name } => run_discard(&name, json, quiet),
        DashCommands::Config => run_config(json, quiet),
        DashCommands::DocsDir { set } => run_docs_dir(set, json, quiet),
        DashCommands::List => run_list(json, quiet),
        DashCommands::Show { name } => run_show(&name, json, quiet),
        DashCommands::Status { name } => run_status(&name, json, quiet),
        DashCommands::Step { name, action } => run_step(&name, action, json, quiet),
        DashCommands::Mark { name, stage, note } => {
            run_mark(&name, stage.into(), note, json, quiet)
        }
        DashCommands::Bind { name, project } => run_bind(&name, project, json, quiet),
        DashCommands::Unbind { project } => run_unbind(project, json, quiet),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {}", e);
            ExitCode::from(1)
        }
    }
}

/// One line naming what the transplant did with each copy of the plan.
fn adopt_receipt_line(data: &ops::AdoptOutcome) -> String {
    let commit = match data.commit.as_deref() {
        Some(sha) => format!("commit {sha}"),
        None => "no commit needed".to_string(),
    };
    let base = match data.base_copy.as_str() {
        "restored" => "base copy restored",
        "removed" => "base copy removed",
        _ => "base copy untouched",
    };
    format!("Adopted plan {} ({commit}, {base})", data.plan_path)
}

fn print_adopt_receipt(data: &ops::AdoptOutcome) {
    println!("{}", adopt_receipt_line(data));
    if !data.dropped_rows.is_empty() {
        println!(
            "  Ledger rows not replayed: {}",
            data.dropped_rows.join(", ")
        );
    }
    for warning in &data.warnings {
        println!("  warning: {warning}");
    }
}

fn run_adopt_plan(name: &str, plan: Option<&str>, json: bool, quiet: bool) -> Result<(), String> {
    let data = ops::adopt_plan(name, plan)?;
    if json {
        print_ok("dash adopt-plan", &data);
    } else if !quiet {
        print_adopt_receipt(&data);
    }
    Ok(())
}

fn run_create(
    name: &str,
    description: Option<String>,
    plan: Option<&str>,
    carry: bool,
    base: Option<&str>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let data = ops::create(name, description, plan, carry, base)?;
    claim_dash(name);
    if json {
        print_ok("dash create", &data);
    } else if !quiet {
        if data.created {
            println!("Created dash '{}'", data.name);
        } else {
            println!("Dash '{}' already exists (active)", data.name);
        }
        println!("  Worktree: {}", data.worktree);
        println!("  Branch: {}", data.branch);
        println!("  Base: {}", data.base_branch);
        if let Some(adopted) = data.plan.as_ref() {
            print_adopt_receipt(adopted);
        }
        print_base_census(&data);
    }
    Ok(())
}

/// What create leaves behind on the base checkout ([P05]). Reported, never
/// acted on: taking the work is the explicit `--carry` gesture, and the default
/// is to take nothing.
fn print_base_census(data: &ops::CreateOutcome) {
    if let Some(branch) = data.off_base.as_deref() {
        println!(
            "  warning: the base checkout is on '{branch}', not '{}' — \
             the join will refuse until it is back on the base branch",
            data.base_branch
        );
    }
    if data.base_dirt.is_empty() {
        return;
    }
    let carried = data.base_dirt.iter().filter(|d| d.carried).count();
    let left = data.base_dirt.len() - carried;
    if carried > 0 {
        println!("  Carried {carried} uncommitted path(s) into the worktree:");
        for entry in data.base_dirt.iter().filter(|d| d.carried) {
            let note = if entry.deleted { " (deleted)" } else { "" };
            println!("    {} [{}]{note}", entry.path, entry.state);
        }
    }
    if left > 0 {
        println!("  Base checkout holds {left} uncommitted path(s), left untouched:");
        for entry in data.base_dirt.iter().filter(|d| !d.carried) {
            let note = if entry.deleted { " (deleted)" } else { "" };
            println!("    {} [{}]{note}", entry.path, entry.state);
        }
    }
}

fn run_commit(name: &str, message: &str, json: bool, quiet: bool) -> Result<(), String> {
    // Round metadata arrives on stdin (the one datum git lacks: the verbatim
    // instruction). A terminal stdin means none was piped.
    let round_meta: Option<DashRoundMeta> = if !io::stdin().is_terminal() {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("failed to read stdin: {}", e))?;
        if buf.trim().is_empty() {
            None
        } else {
            Some(
                serde_json::from_str(&buf)
                    .map_err(|e| format!("failed to parse round metadata JSON: {}", e))?,
            )
        }
    } else {
        None
    };

    let data = ops::commit(name, message, round_meta)?;
    // Deliberately no `claim_dash` here. A round is the plainest statement
    // that this session is working this dash, but the claim costs an HTTP walk
    // over every live instance, and `commit` is the one dash verb that runs on
    // every round and from inside a Shell-route turn — paying that per round,
    // in front of the user, to re-assert a fact `create` and `step start`
    // already recorded is a cost with no reader.
    if json {
        print_ok("dash commit", &data);
    } else if !quiet {
        if data.committed {
            println!("Committed changes to dash '{}'", name);
            if let Some(hash) = &data.commit_hash {
                println!("  Commit: {}", hash);
            }
        } else {
            println!("No changes to commit for dash '{}'", name);
        }
    }
    Ok(())
}

/// The dash's owner key and the repo it lives in, resolved for a landing.
///
/// Called **before** the verb runs, always. `join`/`discard` end in
/// `git branch -D`, which deletes `branch.tugdash/<name>.tugid` with the
/// branch — a key read afterwards is the legacy form and names none of the
/// id-keyed rows the `dash_gone` sweep must reach ([L23], [P05], Risk R02).
fn capture_owner_key(name: &str) -> Option<(std::path::PathBuf, String)> {
    let repo = tugutil_core::find_repo_root().ok()?;
    let key = tugdash_core::ops::dash_owner_key(&repo, name);
    Some((repo, key))
}

fn run_join(name: &str, opts: JoinOptions, json: bool, quiet: bool) -> Result<(), String> {
    let previewing = opts.preview;
    let captured = (!previewing).then(|| capture_owner_key(name)).flatten();
    let data = ops::join(name, opts)?;
    // Only a real join that landed tore the dash down.
    if !data.previewed
        && data.conflicts.is_empty()
        && let Some((repo, owner_key)) = captured
    {
        broadcast_dash_gone(&repo, &owner_key);
    }
    if json {
        print_ok("dash join", &data);
    } else if !quiet {
        if data.previewed {
            if data.conflicts.is_empty() {
                println!(
                    "Preview: dash '{}' joins cleanly into '{}'.",
                    data.name, data.base_branch
                );
            } else {
                println!(
                    "Preview: joining dash '{}' into '{}' conflicts in {} file(s):",
                    data.name,
                    data.base_branch,
                    data.conflicts.len()
                );
                for path in &data.conflicts {
                    println!("  {}", path);
                }
            }
            if !data.blockers.is_empty() {
                println!("Blocked:");
                for blocker in &data.blockers {
                    println!("  {} — {}", blocker.kind, blocker.detail);
                }
            }
        } else if data.conflicts.is_empty() {
            println!(
                "Joined dash '{}' to branch '{}'",
                data.name, data.base_branch
            );
            if let Some(hash) = &data.commit_hash {
                println!("  Commit: {}", hash);
            }
            for warning in &data.warnings {
                println!("  Warning: {}", warning);
            }
        } else {
            println!(
                "Join aborted: dash '{}' conflicts with '{}' in {} file(s) (working tree restored):",
                data.name,
                data.base_branch,
                data.conflicts.len()
            );
            for path in &data.conflicts {
                println!("  {}", path);
            }
        }
    }
    // A real (non-preview) join that hit conflicts is a failure exit for scripts.
    if !data.previewed && !data.conflicts.is_empty() {
        return Err(format!(
            "join conflicts in {} file(s); working tree restored",
            data.conflicts.len()
        ));
    }
    Ok(())
}

/// `tugutil dash join --resolve`: run the resolution ladder, then land the candidate
/// ([P31]). No AI rung from the CLI (the scribe lives in tugcast) — the ladder's
/// algorithmic rungs only.
fn run_join_resolve(
    name: &str,
    message: Option<String>,
    strategy: JoinStrategy,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let outcome = resolve::resolve_conflicts_cwd(name, None)?;

    let Some(candidate) = outcome.candidate_commit.clone() else {
        // Some files could not be resolved algorithmically.
        if json {
            print_ok("dash join --resolve", &outcome);
        } else if !quiet {
            println!(
                "Could not fully resolve dash '{}': {} file(s) still conflict:",
                name,
                outcome.unresolved.len()
            );
            for path in &outcome.unresolved {
                println!("  {}", path);
            }
            for r in &outcome.resolved {
                println!("  resolved {} ({:?})", r.path, r.resolved_by);
            }
        }
        return Err(format!(
            "{} file(s) unresolved; run the join from a Session card for AI assist",
            outcome.unresolved.len()
        ));
    };

    // Captured before the teardown, for the reason `capture_owner_key` states.
    let captured = capture_owner_key(name);
    let landed = ops::join(
        name,
        JoinOptions {
            strategy,
            message,
            preview: false,
            continue_join: false,
            candidate: Some(candidate),
            origin: Some("cli".to_string()),
        },
    )?;
    if landed.conflicts.is_empty()
        && let Some((repo, owner_key)) = captured
    {
        broadcast_dash_gone(&repo, &owner_key);
    }

    if json {
        // Report the ladder outcome and the landed join together.
        print_ok(
            "dash join --resolve",
            serde_json::json!({ "resolve": outcome, "join": landed }),
        );
    } else if !quiet {
        println!(
            "Resolved and joined dash '{}' into '{}' ({:?} shape)",
            landed.name, landed.base_branch, outcome.shape
        );
        if let Some(hash) = &landed.commit_hash {
            println!("  Commit: {}", hash);
        }
        for r in &outcome.resolved {
            println!("  resolved {} ({:?})", r.path, r.resolved_by);
        }
        for warning in outcome.warnings.iter().chain(landed.warnings.iter()) {
            println!("  Warning: {}", warning);
        }
    }
    Ok(())
}

fn run_discard(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    // Captured before the teardown, for the reason `capture_owner_key` states.
    let captured = capture_owner_key(name);
    let data = ops::discard(name, Some("cli"))?;
    if let Some((repo, owner_key)) = captured {
        broadcast_dash_gone(&repo, &owner_key);
    }
    if json {
        print_ok("dash discard", &data);
    } else if !quiet {
        println!("Discarded dash '{}'", data.name);
        if let Some(plan) = data.plan_restored.as_deref() {
            println!("  Plan returned to the base checkout: {plan}");
        }
        if !data.work_restored.is_empty() {
            println!(
                "  Uncommitted work returned to the base checkout: {}",
                data.work_restored.join(", ")
            );
        }
        for warning in &data.warnings {
            println!("  Warning: {}", warning);
        }
    }
    Ok(())
}

fn run_status(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let data = ops::status(name)?;
    if json {
        print_ok("dash status", &data);
    } else if !quiet {
        println!("Dash: {}", data.name);
        println!("Id: {}", data.id);
        println!("Stage: {}", data.stage);
        if let (Some(current), Some(total)) = (data.step_current, data.step_total) {
            match &data.step_title {
                Some(title) => println!("Step: {}/{} — {}", current, total, title),
                None => println!("Step: {}/{}", current, total),
            }
        }
        if let Some(last) = &data.last_activity {
            println!("Last activity: {}", last);
        }
        println!("Branch: {}", data.branch);
        println!("Base: {}", data.base_branch);
        println!("Rounds: {}", data.rounds);
        println!(
            "Worktree: {}{}",
            data.worktree,
            if data.worktree_dirty {
                " (uncommitted changes)"
            } else {
                ""
            }
        );
        println!("Draft: {}", if data.draft { "yes" } else { "no" });
        if let Some(phase) = &data.join_journal_phase {
            println!("Landing interrupted at: {}", phase);
        }
        if data.bound_sessions.is_empty() {
            println!("Sessions: none (unbound)");
        } else {
            println!("Sessions: {}", data.bound_sessions.join(", "));
        }
    }
    Ok(())
}

/// Drive one ledger row and its dash-log line (Spec S02).
///
/// Every refusal — an unknown dash, an unrecorded plan, a document that does
/// not parse, a row that cannot make the transition — exits 1 with the plan and
/// the row named, and leaves the plan file untouched.
fn run_step(name: &str, action: StepAction, json: bool, quiet: bool) -> Result<(), String> {
    let data = match action {
        StepAction::Start {
            step,
            plan,
            through,
        } => {
            let through = through.ok_or_else(|| {
                "dash step start requires --through <m>: the final step of this run's selection \
                 (the machine arms the join from it)"
                    .to_string()
            })?;
            // Opening a step is the resume path's "I am working this dash".
            // A run that picks a plan up mid-way never calls `create`, so this
            // is the only place the claim can be made for it.
            let outcome = ops::step_start(name, step, plan.as_deref(), through)?;
            claim_dash(name);
            outcome
        }
        StepAction::Done { step, commit } => ops::step_done(name, step, commit.as_deref())?,
    };
    if json {
        print_ok("dash step", &data);
    } else if !quiet {
        let through = match data.through {
            Some(through) => format!(" (run through {through})"),
            None => String::new(),
        };
        println!(
            "Step {}/{} of {} is {}{through}",
            data.step, data.total, data.plan_path, data.status
        );
        if let Some(commit) = &data.commit {
            println!("Commit: {}", commit);
        }
    }
    Ok(())
}

/// Declare a stage git cannot see ([P09]) — one dash-log line, nothing else.
fn run_mark(
    name: &str,
    stage: MarkStage,
    note: Option<String>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let data = ops::mark(name, stage, note.as_deref())?;
    if json {
        print_ok("dash mark", &data);
    } else if !quiet {
        println!("{} is {}", data.dash, data.stage);
    }
    Ok(())
}

// --- replay ----------------------------------------------------------------

/// The exit status for a replay outcome — `0` for everything except a
/// conflict.
///
/// A **deferral** is the command declining to act and saying why: the worktree
/// was dirty, a join was in flight, a bound session was mid-turn. Its own JSON
/// reports `status: ok` / `outcome: deferred`, and nothing failed, so exiting
/// non-zero beside that made one command give two verdicts about whether
/// anything went wrong. The JSON was the truthful one.
///
/// A **conflict** is different in kind. The replay stopped mid-application and
/// the dash cannot move until a person resolves the round it named, so the
/// non-zero exit is a script's one cheap signal that work is required.
///
/// Returns `u8` rather than `ExitCode` so a test can compare it:
/// `std::process::ExitCode` implements neither `PartialEq` nor a stable
/// `Debug` (its `Debug` is the platform internal `ExitCode(unix_exit_status(0))`).
fn replay_exit_status(outcome: &ReplayOutcome) -> u8 {
    match outcome {
        ReplayOutcome::Replayed { .. }
        | ReplayOutcome::Recorded { .. }
        | ReplayOutcome::Current
        | ReplayOutcome::Deferred { .. } => 0,
        ReplayOutcome::Conflicted { .. } => 1,
    }
}

/// `dash replay` owns its exit code rather than borrowing the dispatcher's;
/// [`replay_exit_status`] states which outcome means what.
fn run_replay(name: &str, json: bool, quiet: bool) -> ExitCode {
    let outcome = match replay::replay(name) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: {}", e);
            return ExitCode::from(1);
        }
    };
    if json {
        print_ok("dash replay", &outcome);
    } else if !quiet {
        print_replay(name, &outcome);
    }
    ExitCode::from(replay_exit_status(&outcome))
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(9)]
}

fn print_replay(name: &str, outcome: &ReplayOutcome) {
    match outcome {
        ReplayOutcome::Replayed {
            base_head,
            mapping,
            bookkeeping_commit,
        } => {
            println!(
                "Replayed {} round{} of {} onto {}",
                mapping.len(),
                if mapping.len() == 1 { "" } else { "s" },
                name,
                short(base_head)
            );
            for (old, new) in mapping {
                println!("  {} → {}", short(old), short(new));
            }
            if let Some(sha) = bookkeeping_commit {
                println!("  plan ledger remapped in {}", short(sha));
            }
        }
        ReplayOutcome::Recorded {
            base_head,
            remapped,
            unmapped,
        } => {
            println!("Recorded {}'s rebase onto {}", name, short(base_head));
            if !remapped.is_empty() {
                println!("  remapped: {}", remapped.join(", "));
            }
            if !unmapped.is_empty() {
                println!(
                    "  unmapped (no unique match — left as they were): {}",
                    unmapped.join(", ")
                );
            }
        }
        ReplayOutcome::Current => println!("{} is current with its base", name),
        ReplayOutcome::Conflicted {
            base_head,
            round,
            round_subject,
            paths,
        } => {
            println!(
                "{} cannot replay onto {}: round {} \"{}\" conflicts in:",
                name,
                short(base_head),
                short(round),
                round_subject
            );
            for path in paths {
                println!("  {}", path);
            }
            println!(
                "Rebase it in the dash worktree (`git rebase <base>`), then run \
                 `tugutil dash replay {}` to record the moved rounds.",
                name
            );
        }
        ReplayOutcome::Deferred { reason, detail } => {
            println!("{} was not replayed ({}): {}", name, reason, detail);
        }
    }
}

// --- session↔dash binding ([P04], Spec S04) --------------------------------

/// Resolve `--project` (default cwd) to an absolute path, as the user spelled
/// it. The CLI never canonicalizes ([L29]) — `/api/dash` is the gateway.
fn binding_project(project: Option<std::path::PathBuf>) -> Result<std::path::PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?;
    Ok(match project {
        Some(p) if p.is_absolute() => p,
        Some(p) => cwd.join(p),
        None => cwd,
    })
}

/// POST one binding request to the instance that owns the session.
///
/// Unlike `/api/draft` — whose target is the machine-global changes ledger, so
/// any live instance is a valid conduit — `sessions.db` is **per-instance**. A
/// bind must land on the instance holding the session, so this tries the
/// cwd-derived instance first (`find_for_cwd` reaches through a dash worktree
/// to its main checkout, so it is usually right on the first try) and then
/// walks every live instance, taking `unknown_session` as "not this one" and
/// moving on.
///
/// `resolve_port_*` is deliberately not used here: it collapses the registry to
/// a single port by design ([D09]), which is the right answer for a
/// machine-global write and the wrong one for a per-instance ledger.
fn post_dash_api(body: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut ports: Vec<u16> = Vec::new();
    if let Ok(Some(instance)) = std::env::current_dir()
        .map_err(|_| ())
        .and_then(|cwd| tugcore::registry::find_for_cwd(&cwd).map_err(|_| ()))
    {
        ports.push(instance.tugcast_port);
    }
    for instance in tugcore::registry::list_live().unwrap_or_default() {
        if !ports.contains(&instance.tugcast_port) {
            ports.push(instance.tugcast_port);
        }
    }
    if ports.is_empty() {
        return Err(
            "dash binding goes through a running Tug instance, but none was found".to_string(),
        );
    }

    // A non-2xx must stay readable: `unknown_session` arrives as a 404 whose
    // *body* is the answer the loop branches on, and ureq's default turns a
    // non-2xx into an error that discards it.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();

    let mut last_error = None;
    for port in ports {
        let url = format!("http://127.0.0.1:{port}/api/dash");
        let response = match agent.post(&url).send_json(body.clone()) {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(format!("cannot reach tugcast at {url}: {e}"));
                continue;
            }
        };
        let value: serde_json::Value = match response.into_body().read_json() {
            Ok(v) => v,
            Err(e) => {
                last_error = Some(format!("bad response from tugcast: {e}"));
                continue;
            }
        };
        if value.get("status").and_then(|s| s.as_str()) == Some("ok") {
            return Ok(value);
        }
        last_error = Some(
            value
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
                .to_string(),
        );
    }
    Err(last_error.unwrap_or_else(|| "no instance accepted the request".to_string()))
}

/// The calling session's id, or the actionable error naming what to do.
fn calling_session_id() -> Result<String, String> {
    std::env::var("TUG_SESSION_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "no session — dash binding names the calling session, so run this from a Session card or set TUG_SESSION_ID"
                .to_string()
        })
}

fn run_bind(
    name: &str,
    project: Option<std::path::PathBuf>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let session = calling_session_id()?;
    let project = binding_project(project)?;
    let response = post_dash_api(serde_json::json!({
        "op": "bind",
        "tug_session_id": session,
        "project_dir": project.to_string_lossy(),
        "dash": name,
    }))?;
    if json {
        print_ok(
            "dash bind",
            serde_json::json!({
                "dash": name,
                "dash_id": response.get("dash_id"),
                "tug_session_id": session,
            }),
        );
    } else if !quiet {
        println!("Bound this session to dash '{}'", name);
    }
    Ok(())
}

/// Say that the calling session is working this dash.
///
/// **The verbs that start or resume work on a dash call this** — `create` and
/// `step start` — because a run that resumes an existing plan never creates
/// one, and leaving the claim to whoever remembered to type `dash bind` is the
/// same mistake [D147] removed from the join arc's other end. `commit` is
/// deliberately not among them: see the note there. A dash whose worker
/// nobody recorded shows no worker on its Lens row, on the session masthead or
/// in the shade, and — since the pilot works only for bound dashes — is never
/// offered for joining at all.
///
/// Best-effort by construction, and silent on both no-op paths. There is
/// nothing to claim without a calling session (a headless run, a fixture), and
/// nothing to claim it *on* without a live instance, since a binding is a fact
/// the ledger holds rather than something the worktree needs. A failure warns
/// on stderr and never fails the verb the user actually asked for.
fn claim_dash(name: &str) {
    if !std::env::var("TUG_SESSION_ID").is_ok_and(|s| !s.is_empty()) {
        return;
    }
    if let Err(e) = run_bind(name, None, false, true) {
        eprintln!("warning: could not bind this session to dash '{name}': {e}");
    }
}

fn run_unbind(project: Option<std::path::PathBuf>, json: bool, quiet: bool) -> Result<(), String> {
    let session = calling_session_id()?;
    let _project = binding_project(project)?;
    post_dash_api(serde_json::json!({
        "op": "unbind",
        "tug_session_id": session,
    }))?;
    if json {
        print_ok(
            "dash unbind",
            serde_json::json!({ "tug_session_id": session }),
        );
    } else if !quiet {
        println!("Unbound this session from its dash");
    }
    Ok(())
}

/// Tell every live instance that a dash is gone, so its bindings and its
/// authored draft are swept ([P05]).
///
/// Best-effort by design: a landing must never fail because no instance was
/// listening. Broadcast rather than try-until-owned — any instance may hold
/// bindings to the dead dash.
///
/// `dash_id` is the owner key the caller captured **before** the landing.
/// `git branch -D` takes the branch's config with it, so a key resolved after
/// the verb returns is the legacy form and matches none of the id-keyed rows
/// this sweep exists to remove ([L23], Risk R02).
fn broadcast_dash_gone(project: &std::path::Path, dash_id: &str) {
    let body = serde_json::json!({
        "op": "dash_gone",
        "project_dir": project.to_string_lossy(),
        "dash_id": dash_id,
    });
    let live = tugcore::registry::list_live().unwrap_or_default();
    if live.is_empty() {
        // Nothing is running, so nothing holds a binding to sweep — not a
        // condition worth a warning.
        return;
    }
    let mut reached = false;
    for instance in live {
        let url = format!("http://127.0.0.1:{}/api/dash", instance.tugcast_port);
        if ureq::post(&url).send_json(body.clone()).is_ok() {
            reached = true;
        }
    }
    if !reached {
        eprintln!(
            "warning: no running Tug instance was told that dash '{}' is gone; \
             its bindings clear lazily on the next read",
            dash_id
        );
    }
}

/// The list `--json` payload — `{ "dashes": [...] }`.
#[derive(Serialize)]
struct ListPayload {
    dashes: Vec<tugdash_core::DashListItem>,
}

/// The project's `[tugtool.dash]` declarations, as one payload.
///
/// `verify` and `build` are `null` when undeclared rather than absent, so a
/// consumer reads the same three fields whatever the project says.
#[derive(Serialize)]
struct ConfigPayload {
    verify: Option<String>,
    build: Option<String>,
    post_create: Vec<String>,
    docs: Option<String>,
}

#[derive(Serialize)]
struct DocsDirPayload {
    /// The declared value, verbatim, or null when the project declares none.
    docs: Option<String>,
    /// The absolute directory the declaration names, or null.
    path: Option<String>,
    /// False when the project declares nothing — a state, not an error.
    declared: bool,
}

#[derive(Serialize)]
struct DocsDirSetPayload {
    docs: String,
    path: String,
    config_path: String,
    /// True when the directory did not exist and this write created it.
    created_dir: bool,
}

/// Read the declarations the run's ending and the build offer consume.
///
/// The project root is the standard `.tugtool/` upward walk, so from a dash
/// worktree this reads the worktree's own committed copy — the copy the run is
/// about. A missing config file is the all-undeclared state, not an error.
fn run_config(json: bool, quiet: bool) -> Result<(), String> {
    let root = tugutil_core::config::find_project_root().map_err(|e| e.to_string())?;
    let config =
        tugutil_core::config::Config::load_from_project(&root).map_err(|e| e.to_string())?;
    let dash = config.tugtool.dash;
    let payload = ConfigPayload {
        verify: dash.verify,
        build: dash.build,
        post_create: dash.post_create,
        docs: dash.docs,
    };

    if json {
        print_ok("dash config", &payload);
    } else if !quiet {
        let undeclared = "(not declared)";
        println!(
            "verify:       {}",
            payload.verify.as_deref().unwrap_or(undeclared)
        );
        println!(
            "build:        {}",
            payload.build.as_deref().unwrap_or(undeclared)
        );
        if payload.post_create.is_empty() {
            println!("post_create:  {}", undeclared);
        } else {
            println!("post_create:  {}", payload.post_create.join("; "));
        }
        println!(
            "docs:         {}",
            payload.docs.as_deref().unwrap_or(undeclared)
        );
    }
    Ok(())
}

/// Report the project's dash paperwork directory, or record it.
///
/// Undeclared reports as such and exits 0: a project that has not chosen a
/// paperwork home is in a state, not in error, and the ask-once contract in
/// the authoring skills is built on being able to read that state cheaply.
fn run_docs_dir(set: Option<String>, json: bool, quiet: bool) -> Result<(), String> {
    let root = tugutil_core::config::find_project_root().map_err(|e| e.to_string())?;

    if let Some(value) = set {
        let write = tugutil_core::config::set_docs_dir(&root, &value).map_err(|e| e.to_string())?;
        let payload = DocsDirSetPayload {
            docs: write.docs,
            path: write.path.display().to_string(),
            config_path: write.config_path.display().to_string(),
            created_dir: write.created_dir,
        };
        if json {
            print_ok("dash docs-dir", payload);
        } else if !quiet {
            println!("docs: {} ({})", payload.docs, payload.path);
            println!("recorded in {}", payload.config_path);
            if payload.created_dir {
                println!("created {}", payload.path);
            }
        }
        return Ok(());
    }

    let config =
        tugutil_core::config::Config::load_from_project(&root).map_err(|e| e.to_string())?;
    let path = config.docs_dir(&root);
    let payload = DocsDirPayload {
        docs: config.tugtool.dash.docs.clone(),
        path: path.as_ref().map(|p| p.display().to_string()),
        declared: path.is_some(),
    };

    if json {
        print_ok("dash docs-dir", payload);
    } else if !quiet {
        match (&payload.docs, &payload.path) {
            (Some(docs), Some(path)) => println!("docs: {} ({})", docs, path),
            _ => println!("docs: (not declared)"),
        }
    }
    Ok(())
}

fn run_list(json: bool, quiet: bool) -> Result<(), String> {
    let items = ops::list()?;
    if json {
        print_ok("dash list", ListPayload { dashes: items });
    } else if !quiet {
        if items.is_empty() {
            println!("No dashes found");
        } else {
            for item in &items {
                println!("{} (active, {} rounds)", item.name, item.round_count);
                match &item.worktree {
                    Some(worktree) => println!("  Worktree: {}", worktree),
                    None => println!("  Worktree: (missing)"),
                }
                println!("  Base: {}", item.base_branch);
            }
        }
    }
    Ok(())
}

fn run_show(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let data = ops::show(name)?;
    if json {
        print_ok("dash show", &data);
    } else if !quiet {
        println!("Dash: {}", data.name);
        if let Some(desc) = &data.description {
            println!("Description: {}", desc);
        }
        println!("Status: {}", data.status);
        println!("Branch: {}", data.branch);
        println!("Worktree: {}", data.worktree);
        println!("Base: {}", data.base_branch);
        if let Some(has_changes) = data.uncommitted_changes {
            println!(
                "Uncommitted changes: {}",
                if has_changes { "yes" } else { "no" }
            );
        }
        println!("\nRounds ({}):", data.rounds.len());
        for round in &data.rounds {
            println!("  {} {}", round.commit_hash, round.started_at);
            if !round.summary.is_empty() {
                println!("    {}", round.summary);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// All five outcomes, so the one that means "work is required" cannot be
    /// widened by accident: a deferral that exited 1 was the command
    /// contradicting its own `status: ok` JSON.
    #[test]
    fn only_a_conflicted_replay_exits_non_zero() {
        assert_eq!(
            replay_exit_status(&ReplayOutcome::Replayed {
                base_head: "abc".into(),
                mapping: Vec::new(),
                bookkeeping_commit: None,
            }),
            0
        );
        assert_eq!(
            replay_exit_status(&ReplayOutcome::Recorded {
                base_head: "abc".into(),
                remapped: Vec::new(),
                unmapped: Vec::new(),
            }),
            0
        );
        assert_eq!(replay_exit_status(&ReplayOutcome::Current), 0);
        assert_eq!(
            replay_exit_status(&ReplayOutcome::Deferred {
                reason: "worktree-dirty".into(),
                detail: "the dash worktree has uncommitted changes".into(),
            }),
            0,
            "a deferral is the command declining to act, not a failure"
        );
        assert_eq!(
            replay_exit_status(&ReplayOutcome::Conflicted {
                base_head: "abc".into(),
                round: "def".into(),
                round_subject: "a round".into(),
                paths: vec!["src/a.rs".into()],
            }),
            1,
            "a conflict stops mid-application and demands a person"
        );
    }

    #[test]
    fn step_start_refuses_without_through() {
        let err = run_step(
            "any-dash",
            StepAction::Start {
                step: 1,
                plan: None,
                through: None,
            },
            false,
            true,
        )
        .unwrap_err();
        assert!(
            err.contains("--through"),
            "the refusal must name the flag: {err}"
        );
    }
}
