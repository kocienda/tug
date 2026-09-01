//! Dashes — worktree-isolated work units (`tugtool dash …`). A thin shell over
//! [`tugdash_core::ops`]: parse arguments, read commit round-metadata from stdin,
//! call the typed library API, and format the outcome as `--json` (the shared
//! envelope) or a plain human read-out.

use std::io::{self, IsTerminal, Read};
use std::process::ExitCode;

use serde::Serialize;

use tugdash_core::{
    ArcCourse, ArcRecord, DashRoundMeta, JoinOptions, JoinStrategy, MarkStage, ReplayOutcome, ops,
    replay, resolve,
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
            carry,
            base,
        } => run_create(&name, description, carry, base.as_deref(), json, quiet),
        DashCommands::Commit { name, message } => run_commit(&name, &message, json, quiet),
        DashCommands::Join {
            name,
            message,
            strategy,
            preview,
            continue_join,
            resolve,
            break_lease,
        } if resolve => run_join_resolve(&name, message, strategy.into(), break_lease, json, quiet),
        DashCommands::Join {
            name,
            message,
            strategy,
            preview,
            continue_join,
            resolve: _,
            break_lease,
        } => run_join(
            &name,
            JoinOptions {
                strategy: strategy.into(),
                message,
                preview,
                continue_join,
                candidate: None,
                origin: Some("cli".to_string()),
                // The CLI runs inside the session it belongs to, so its own
                // `TUG_SESSION_ID` is the answer and nothing needs passing.
                session_id: None,
                break_lease,
            },
            json,
            quiet,
        ),
        DashCommands::Replay { name } => return run_replay(&name, json, quiet),
        DashCommands::ResolveBase { name } => return run_resolve_base(&name, json, quiet),
        DashCommands::Verify { name, base, head } => {
            return run_verify(&name, base, head, json, quiet);
        }
        DashCommands::Undo { name, list } => {
            return run_undo(name.as_deref(), list, json, quiet);
        }
        DashCommands::Redo { name, list } => {
            return run_redo(name.as_deref(), list, json, quiet);
        }
        DashCommands::Discard { name, break_lease } => run_discard(&name, break_lease, json, quiet),
        DashCommands::Config => run_config(json, quiet),
        DashCommands::List => run_list(json, quiet),
        DashCommands::Show { name } => run_show(&name, json, quiet),
        DashCommands::Status { name } => run_status(&name, json, quiet),
        DashCommands::Doctor { name, repair } => run_doctor(&name, repair, json, quiet),
        DashCommands::Step { name, action } => run_step(&name, action, json, quiet),
        DashCommands::Mark { name, stage, note } => {
            run_mark(&name, stage.into(), note, json, quiet)
        }
        DashCommands::Run {
            name,
            course,
            project,
            session,
        } => run_arc_run(&name, &course, project, session, json, quiet),
        DashCommands::Documents { name, ensure } => run_documents(&name, ensure, json, quiet),
        DashCommands::Arc { name, project } => run_arc_report(&name, project, json, quiet),
        DashCommands::Bind {
            name,
            project,
            session,
            dry_run,
        } => {
            if dry_run {
                run_bind_dry_run(&name, session.as_deref(), json, quiet)
            } else {
                run_bind(&name, project, session.as_deref(), json, quiet)
            }
        }
        DashCommands::Stop {
            name,
            project,
            session,
        } => run_arc_stop(&name, project, session.as_deref(), json, quiet),
        DashCommands::Unbind { project, session } => {
            run_unbind(project, session.as_deref(), json, quiet)
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {}", e);
            ExitCode::from(1)
        }
    }
}

fn run_create(
    name: &str,
    description: Option<String>,
    carry: bool,
    base: Option<&str>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let data = ops::create(name, description, carry, base)?;
    let claim = claim_dash(name);
    if json {
        print_ok("dash create", merge_claim(&data, &claim)?);
    } else if !quiet {
        if data.created {
            println!("Created dash '{}'", data.name);
        } else {
            println!("Dash '{}' already exists (active)", data.name);
        }
        println!("  Worktree: {}", data.worktree);
        println!("  Branch: {}", data.branch);
        println!("  Base: {}", data.base_branch);
        print_base_census(&data);
    }
    // The worktree exists either way, and the receipt above says so. What did
    // not happen is the record of who is working it — and that is the half a
    // stderr warning on an exit-0 run used to swallow.
    match claim.refusal(name) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
}

/// Fold a claim's verdict into a verb's own outcome document.
///
/// The claim is a second thing the verb did, so it belongs in the one object
/// the verb prints rather than in a sentence on another stream. A script that
/// reads `claimed` never has to infer it from an exit code, and the exit code
/// is not the only place a refusal shows.
fn merge_claim<T: serde::Serialize>(data: &T, claim: &Claim) -> Result<serde_json::Value, String> {
    let mut value = serde_json::to_value(data).map_err(|e| format!("cannot serialize: {e}"))?;
    let (Some(object), Some(extra)) = (value.as_object_mut(), claim.as_json().as_object().cloned())
    else {
        return Ok(value);
    };
    for (key, entry) in extra {
        object.insert(key, entry);
    }
    Ok(value)
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
    let repo = tugtool_core::find_repo_root().ok()?;
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
        broadcast_dash_gone(&repo, &owner_key, DashGone::Joined);
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

/// `tugtool dash join --resolve`: run the resolution ladder, then land the candidate
/// ([P31]). No AI rung from the CLI (the scribe lives in tugcast) — the ladder's
/// algorithmic rungs only.
fn run_join_resolve(
    name: &str,
    message: Option<String>,
    strategy: JoinStrategy,
    break_lease: bool,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    // The third cross-process door, and the one a lease check inside the join
    // would never see: the ladder clears the conflict chain on both its arms,
    // so by the time `ops::join` runs there is nothing left to protect. The
    // check belongs here rather than in the ladder itself — the ladder's other
    // callers are the join pilot and the supervisor, both already holding the
    // in-process guard, and a check in the core would wedge the pilot for the
    // whole window after any resolver crash ([P06]).
    let repo_root = tugtool_core::find_repo_root().map_err(|e| e.to_string())?;
    if !break_lease
        && let Some(lease) = resolve::resolve_lease(&repo_root, name, std::time::SystemTime::now())
    {
        return Err(ops::live_resolve_detail(name, &lease, "resolve"));
    }

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
            session_id: None,
            // The ladder already replaced whatever chain stood here, so the
            // join below sees no lease — carried anyway so the two halves of
            // one gesture cannot disagree.
            break_lease,
        },
    )?;
    if landed.conflicts.is_empty()
        && let Some((repo, owner_key)) = captured
    {
        broadcast_dash_gone(&repo, &owner_key, DashGone::Joined);
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

fn run_discard(name: &str, break_lease: bool, json: bool, quiet: bool) -> Result<(), String> {
    // Captured before the teardown, for the reason `capture_owner_key` states.
    let captured = capture_owner_key(name);
    let data = ops::discard(name, Some("cli"), break_lease)?;
    if let Some((repo, owner_key)) = captured {
        broadcast_dash_gone(&repo, &owner_key, DashGone::Discarded);
    }
    if json {
        print_ok("dash discard", &data);
    } else if !quiet {
        println!("Discarded dash '{}'", data.name);
        if let Some(dir) = data.documents_kept.as_deref() {
            println!(
                "  Documents kept at {dir} — tugtool dash run {} reopens on them",
                data.name
            );
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
        if let Some(fit) = &data.fit {
            let head: String = fit.head.chars().take(9).collect();
            if fit.current {
                println!("Fit: verified at {}", head);
            } else {
                println!("Fit: not verified since {}", head);
            }
        }
        println!("Draft: {}", if data.draft { "yes" } else { "no" });
        if let Some(phase) = &data.join_journal_phase {
            println!("Landing interrupted at: {}", phase);
        }
        if data.bound_sessions.is_empty() {
            println!("Sessions: none (unbound)");
        } else {
            println!("Sessions: {}", data.bound_sessions.join(", "));
        }
        // Last, and unmissable. A status that answered from one side of a
        // disagreement is how a desync goes unnoticed for a whole run.
        if !data.disagreements.is_empty() {
            println!();
            println!(
                "Records disagree ({}) — run `tugtool dash doctor {}`:",
                data.disagreements.len(),
                data.name
            );
            for sentence in &data.disagreements {
                println!("  - {sentence}");
            }
        }
    }
    Ok(())
}

/// Compare a dash's four records and say where they disagree ([P04]).
///
/// The exit code is the finding: 0 when the records agree, 1 when they do
/// not, so a script can gate on it without parsing anything. A `--repair` run
/// that reconciles every reconcilable finding still exits 1 if something was
/// left for a person — the dash is not healthy just because the doctor did
/// what it could.
fn run_doctor(name: &str, repair: bool, json: bool, quiet: bool) -> Result<(), String> {
    let outcome = tugdash_core::doctor::doctor_here(name, repair)?;

    if json {
        print_ok("dash doctor", &outcome);
    } else if !quiet {
        if let Some(ledger) = &outcome.diagnosis.ledger {
            println!("Ledger: {ledger}");
        }
        if outcome.diagnosis.healthy() {
            println!("The records agree.");
        } else {
            println!(
                "{} disagreement(s) between this dash's records:",
                outcome.diagnosis.findings.len()
            );
            for finding in &outcome.diagnosis.findings {
                println!("\n  [{}] {}", finding.code, finding.sentence);
                match (&finding.repair, repair) {
                    (Some(fix), false) => println!(
                        "      Repair (`--repair`): append `{}  {}` — {}",
                        fix.marker, fix.note, fix.effect
                    ),
                    (Some(_), true) => println!("      Repaired."),
                    (None, _) => println!("      No safe automatic repair; this one needs you."),
                }
            }
        }
        if !outcome.appended.is_empty() {
            println!("\nAppended {} dash-log line(s).", outcome.appended.len());
        }
    }

    // A repair that reconciled everything it could still reports the dash as
    // unhealthy if anything is left — the verb answers "do the records agree",
    // not "did I try".
    if outcome.diagnosis.healthy() || (repair && outcome.left_for_a_person == 0) {
        Ok(())
    } else {
        Err(format!(
            "'{name}' has {} record disagreement(s) no automatic repair can settle",
            outcome.left_for_a_person
        ))
    }
}

/// Drive one ledger row and its dash-log line (Spec S02).
///
/// Every refusal — an unknown dash, a dash with no plan, a document that does
/// not parse, a row that cannot make the transition — exits 1 with the plan and
/// the row named, and leaves the plan file untouched.
fn run_step(name: &str, action: StepAction, json: bool, quiet: bool) -> Result<(), String> {
    let mut claim = None;
    let data = match action {
        StepAction::Start { step, through } => {
            let through = through.ok_or_else(|| {
                "dash step start requires --through <m>: the final step of this run's selection \
                 (the machine arms the join from it)"
                    .to_string()
            })?;
            // Opening a step is the resume path's "I am working this dash".
            // A run that picks a plan up mid-way never calls `create`, so this
            // is the only place the claim can be made for it.
            let outcome = ops::step_start(name, step, through)?;
            claim = Some(claim_dash(name));
            outcome
        }
        StepAction::Done { step, commit } => ops::step_done(name, step, commit.as_deref())?,
        StepAction::Withdraw { step } => {
            // Withdrawing is a run act like opening a step, so it registers
            // the same claim: a run that picks a plan up mid-way to withdraw
            // one step has still taken the dash.
            let outcome = ops::step_withdraw(name, step)?;
            claim = Some(claim_dash(name));
            outcome
        }
        // Parking and reopening are run acts too, on the same grounds.
        StepAction::Reset { step, why } => {
            let outcome = ops::step_reset(name, step, why.as_deref())?;
            claim = Some(claim_dash(name));
            outcome
        }
        StepAction::Reopen { step, why } => {
            let outcome = ops::step_reopen(name, step, &why)?;
            claim = Some(claim_dash(name));
            outcome
        }
    };
    if json {
        match &claim {
            Some(claim) => print_ok("dash step", merge_claim(&data, claim)?),
            None => print_ok("dash step", &data),
        }
    } else if !quiet {
        let through = match data.through {
            Some(through) => format!(" (run through {through})"),
            None => String::new(),
        };
        println!(
            "Step {}/{} of {} is {}{through}",
            data.step, data.total, data.plan, data.status
        );
        if let Some(commit) = &data.commit {
            println!("Commit: {}", commit);
        }
    }
    // The row moved either way; what may not have happened is the claim.
    match claim.as_ref().and_then(|claim| claim.refusal(name)) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
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
        print_open_steps(&data);
    } else if !data.open_steps.is_empty() {
        // Quiet suppresses the receipt, not the disagreement.
        eprintln!(
            "warning: {} of {} ledger rows are still open ({})",
            data.open_steps.len(),
            data.total_steps,
            step_list(&data.open_steps),
        );
    }
    Ok(())
}

/// Say when a mark claims more than the ledger does.
///
/// `built` says the work is there and `audited` arms the join, so either one
/// over a table of `pending` rows is a claim about work nobody recorded doing.
/// A statement, not a refusal: marking ahead of the rows is a real gesture,
/// and the verb's job is to make the disagreement visible at the moment it is
/// made rather than at whatever reads the plan next.
fn print_open_steps(data: &ops::MarkOutcome) {
    if data.open_steps.is_empty() {
        return;
    }
    println!(
        "  warning: {} of {} ledger rows are still open — {}",
        data.open_steps.len(),
        data.total_steps,
        step_list(&data.open_steps),
    );
    println!("  The mark stands; the ledger does not say the work is finished.");
}

fn step_list(steps: &[u32]) -> String {
    steps
        .iter()
        .map(|step| format!("step {step}"))
        .collect::<Vec<_>>()
        .join(", ")
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

fn run_resolve_base(name: &str, json: bool, quiet: bool) -> ExitCode {
    let repo = match tugtool_core::find_repo_root() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {}", e);
            return ExitCode::from(1);
        }
    };
    // The CLI has no attribution view — that is the running instance's — so
    // every overlap here reads as the user's own, which is the right answer
    // for a person standing in their own checkout.
    let outcome =
        match tugdash_core::ops::resolve_base_in(&repo, name, &std::collections::BTreeMap::new()) {
            Ok(o) => o,
            Err(e) => {
                eprintln!("error: {}", e);
                return ExitCode::from(1);
            }
        };
    if json {
        print_ok("dash resolve-base", &outcome);
    } else if !quiet {
        for path in &outcome.dropped {
            println!("dropped  {path}  (the dash carries these bytes)");
        }
        for path in &outcome.folded {
            println!("committed  {path}");
        }
        if let Some(sha) = &outcome.committed {
            println!("Commit: {}", &sha[..sha.len().min(9)]);
        }
        for warning in &outcome.warnings {
            println!("{warning}");
        }
        println!("The join of '{name}' is no longer blocked by the base.");
    }
    ExitCode::SUCCESS
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

/// Verify the fit, and print the report the ending reads.
///
/// The report is a finished document: the per-surface table, then exactly one
/// receipt line. There is nothing a filter can extract that the receipt has
/// not already extracted.
fn run_verify(
    name: &str,
    base: Option<String>,
    head: Option<String>,
    json: bool,
    quiet: bool,
) -> ExitCode {
    let repo = match tugtool_core::find_repo_root() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {}", e);
            return ExitCode::from(1);
        }
    };
    let report =
        match tugdash_core::surfaces::verify_in(&repo, name, base.as_deref(), head.as_deref()) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("error: {}", e);
                return ExitCode::from(1);
            }
        };

    if json {
        print_ok("dash verify", &report);
    } else if !quiet {
        print_verify(&report);
    }
    ExitCode::from(report.exit_code())
}

fn print_verify(report: &tugdash_core::surfaces::VerifyReport) {
    if !report.unclaimed.is_empty() {
        println!(
            "{} paths match no declared surface:",
            report.unclaimed.len()
        );
        for path in &report.unclaimed {
            println!("  {}", path);
        }
        println!("\nDeclare a surface for them in .tugtool/config.toml:\n");
        println!("  [[tugtool.dash.surface]]");
        println!("  name  = \"<name>\"");
        println!("  paths = [{}]", declaration_hint(&report.unclaimed));
        println!("  check = []");
        println!();
    }

    if !report.surfaces.is_empty() {
        println!("surface      paths  checks  result");
        for surface in &report.surfaces {
            let ran = surface
                .commands
                .iter()
                .filter(|c| c.status == "ran")
                .count();
            let result = if surface.red {
                "red".to_string()
            } else if surface.commands.is_empty() {
                "claimed, unchecked".to_string()
            } else if surface.borrowed_from.is_empty() {
                "ok".to_string()
            } else {
                format!("ok (checked by {})", surface.borrowed_from.join(", "))
            };
            println!(
                "{:<12} {:>5}  {:>6}  {}",
                surface.name,
                surface.paths.len(),
                ran,
                result
            );
            for command in &surface.commands {
                match command.status.as_str() {
                    "already-run" => println!(
                        "               already run for {}: {}",
                        command.already_run_for.as_deref().unwrap_or("?"),
                        command.command
                    ),
                    "not-reached" => {
                        println!("               not reached: {}", command.command)
                    }
                    _ if command.exit_code.is_some_and(|code| code != 0) => println!(
                        "               failed (exit {}): {}",
                        command.exit_code.unwrap_or(-1),
                        command.command
                    ),
                    _ => {}
                }
            }
        }
        println!();
    }

    println!("{}", report.receipt);
}

/// The `paths = [...]` line a refusal suggests: the directories the unclaimed
/// paths sit in, so the reader edits a declaration rather than composing one.
fn declaration_hint(unclaimed: &[String]) -> String {
    let mut prefixes: Vec<String> = Vec::new();
    for path in unclaimed {
        let prefix = match path.find('/') {
            Some(at) => path[..=at].to_string(),
            None => path.clone(),
        };
        if !prefixes.contains(&prefix) {
            prefixes.push(prefix);
        }
    }
    prefixes
        .iter()
        .map(|p| format!("\"{}\"", p))
        .collect::<Vec<_>>()
        .join(", ")
}
fn run_undo(name: Option<&str>, list: bool, json: bool, quiet: bool) -> ExitCode {
    let repo = match tugtool_core::find_repo_root() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {}", e);
            return ExitCode::from(1);
        }
    };

    if list {
        let ops: Vec<_> = tugdash_core::list_ops(&repo)
            .into_iter()
            .filter(|op| name.is_none_or(|n| op.dash == n))
            .collect();
        if json {
            print_ok("dash undo", &ops);
        } else if !quiet {
            print_oplog(&ops);
        }
        return ExitCode::from(0);
    }

    let outcome = match tugdash_core::undo_in(&repo, name) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: {}", e);
            return ExitCode::from(1);
        }
    };
    if json {
        print_ok("dash undo", &outcome);
    } else if !quiet {
        print_undo(&outcome);
    }
    ExitCode::from(0)
}

fn print_oplog(ops: &[tugdash_core::OpPayload]) {
    if ops.is_empty() {
        println!("No operations recorded.");
        return;
    }
    for op in ops {
        // Say why an operation cannot be undone, rather than only whether —
        // "died mid-flight" and "already reversed" are different facts and the
        // difference is what a reader acts on. The undoable case asks
        // `is_undoable` rather than re-deriving it, so the list cannot promise
        // an undo the verb would then decline.
        //
        // An undo that nothing has reversed reads `redoable`, asking
        // `is_redoable` for the same reason: one predicate decides, and the
        // list reports what it says.
        let state = match (&op.after, op.undone_by) {
            (_, Some(by)) => format!("undone by {}", by),
            // An incomplete join carrying progress is not a mystery: it is a
            // teardown waiting for `--continue`, and the list says how far it
            // got rather than leaving the reader to guess what half happened.
            (None, _) => match &op.join {
                Some(progress) => format!("incomplete (teardown at {:?})", progress.phase),
                None => "incomplete".to_string(),
            },
            _ if op.is_redoable() => "redoable".to_string(),
            _ if op.is_undoable() => "undoable".to_string(),
            _ => "not undoable".to_string(),
        };
        // A broken resolve lease is part of what this operation *was*, so the
        // list says so beside the state rather than leaving it to the payload.
        let state = match op.before.broke_lease {
            Some(secs) => format!(
                "{state}, broke lease ({})",
                ops::human_age(std::time::Duration::from_secs(secs))
            ),
            None => state,
        };
        println!(
            "  {:>4}  {:<8} {:<20} {}  ({})",
            op.seq,
            op.verb.as_str(),
            op.dash,
            op.recorded_at,
            state
        );
    }
}

fn run_redo(name: Option<&str>, list: bool, json: bool, quiet: bool) -> ExitCode {
    let repo = match tugtool_core::find_repo_root() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {}", e);
            return ExitCode::from(1);
        }
    };

    // One printer, two flags: `undo --list` and `redo --list` are the same
    // question about the same log, and two spellings of it would drift.
    if list {
        let ops: Vec<_> = tugdash_core::list_ops(&repo)
            .into_iter()
            .filter(|op| name.is_none_or(|n| op.dash == n))
            .collect();
        if json {
            print_ok("dash redo", &ops);
        } else if !quiet {
            print_oplog(&ops);
        }
        return ExitCode::from(0);
    }

    let outcome = match tugdash_core::redo_in(&repo, name) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: {}", e);
            return ExitCode::from(1);
        }
    };
    if json {
        print_ok("dash redo", &outcome);
    } else if !quiet {
        print_redo(&outcome);
    }
    ExitCode::from(0)
}

fn print_redo(outcome: &tugdash_core::RedoOutcome) {
    println!(
        "Redid the {} of {} (operation {})",
        outcome.verb.as_str(),
        outcome.dash,
        outcome.original_seq
    );
    if let Some(base) = &outcome.base_tip {
        println!("  base back at {}", short(base));
    }
    if let Some(tip) = &outcome.dash_tip {
        println!("  {} at {}", outcome.dash, short(tip));
    }
    if !outcome.handed_back_left_in_place.is_empty() {
        println!(
            "  left in the base checkout (handed back by the original discard): {}",
            outcome.handed_back_left_in_place.join(", ")
        );
    }
    for w in &outcome.warnings {
        println!("  warning: {}", w);
    }
}

fn print_undo(outcome: &tugdash_core::UndoOutcome) {
    println!(
        "Undid the {} of {} (operation {})",
        outcome.verb.as_str(),
        outcome.dash,
        outcome.seq
    );
    if let Some(base) = &outcome.base_tip {
        println!("  base back at {}", short(base));
    }
    if let Some(tip) = &outcome.dash_tip {
        println!("  {} restored at {}", outcome.dash, short(tip));
    }
    if !outcome.handed_back_left_in_place.is_empty() {
        println!(
            "  left in the base checkout (handed back by the discard, not clawed back): {}",
            outcome.handed_back_left_in_place.join(", ")
        );
    }
    if outcome.restored_unbound {
        println!("  restored unbound — bind it to resume piloting");
    }
    for w in &outcome.warnings {
        println!("  warning: {}", w);
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(9)]
}

fn print_replay(name: &str, outcome: &ReplayOutcome) {
    match outcome {
        ReplayOutcome::Replayed { base_head, mapping } => {
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
                 `tugtool dash replay {}` to record the moved rounds.",
                name
            );
        }
        ReplayOutcome::Deferred { reason, detail } => {
            println!("{} was not replayed ({}): {}", name, reason, detail);
        }
    }
}

// --- the arc ([P01], Spec S06, Spec S07) -----------------------------------

/// What `dash run` did, and what the arc says afterwards.
#[derive(Serialize)]
struct ArcRunPayload {
    dash: String,
    /// An `arc-start` line was written — a new arc opened.
    started: bool,
    /// A stopped arc was picked back up ([P11]).
    resumed: bool,
    arc: ArcRecord,
    /// The session the arc was actually seated against — the server's
    /// answer, not the id this process was born with ([P01]).
    tug_session_id: String,
}

#[derive(Serialize)]
struct ArcReportPayload {
    dash: String,
    /// `null` for a dash with no arc, which is every dash created by hand.
    arc: Option<ArcRecord>,
}

/// The project root the arc's record lives under: `--project` as the user
/// spelled it ([L29] — the CLI never canonicalizes), else the enclosing
/// project. Not the cwd: a verb run from a subdirectory reads the same log.
fn arc_project_root(project: Option<std::path::PathBuf>) -> Result<std::path::PathBuf, String> {
    match project {
        Some(_) => binding_project(project),
        None => tugtool_core::config::find_project_root().map_err(|e| e.to_string()),
    }
}

/// Open an arc on the dash's own documents, or resume one that stopped.
///
/// The document is the dash's brief, or its plan when only that exists — the
/// arc has no address to be given, because a dash's documents live at one
/// place. An arc that already exists is resumed whatever its document, since
/// the record is the arc's identity and a second `arc-start` would make one arc
/// read as two.
///
/// `course` is the progression to record ([B08]) and is written only on the
/// opening. A resume ignores it for the same reason a second `arc-start` is
/// refused: the arc's kind is part of what the record *is*, and a resume that
/// could change it would let one arc run two progressions.
///
/// Separated from the verb so the decision is testable over a synthesized log
/// with no session and no instance.
fn open_arc(
    root: &std::path::Path,
    dash: &str,
    course: ArcCourse,
) -> Result<(bool, bool, ArcRecord), String> {
    tugdash_core::validate_dash_name(dash).map_err(|e| e.to_string())?;
    if let Some(arc) = tugdash_core::read_arc(root, dash) {
        return resume_arc(root, dash, arc);
    }

    let file = if tugdash_core::brief_file(root, dash).is_file() {
        "brief.md"
    } else if tugdash_core::plan_file(root, dash).is_file() {
        "plan.md"
    } else if tugdash_core::tasks_file(root, dash).is_file() {
        // A task list with no brief beside it: unusual, since the `/dash`
        // door writes both, but it is a document the wheel can open on and
        // refusing it would be a rule with no reason behind it.
        "tasks.md"
    } else {
        return Err(format!(
            "dash '{dash}' has no brief, plan, or task list at {} — write one first",
            tugdash_core::documents_dir(root, dash).display()
        ));
    };
    // Repo-relative in the record, which is what the stage divider shows and
    // what the runner resolves against the main root.
    let relative = format!(".tug/dashes/{dash}/{file}");

    tugdash_core::append_arc_start(root, dash, &relative).map_err(|e| e.to_string())?;
    // Written after `arc-start`, so a reader that stops at the first marker
    // still finds the document. Both lines are this opening's.
    tugdash_core::append_arc_course(root, dash, course).map_err(|e| e.to_string())?;
    let arc = tugdash_core::read_arc(root, dash)
        .ok_or_else(|| format!("wrote the arc for '{dash}' but could not read it back"))?;
    Ok((true, false, arc))
}

/// Report where a dash's documents live and which of them exist ([P01]).
///
/// A dash with no directory is a state rather than an error: exit 0, both
/// absent. `--ensure` creates the directory and keeps `.tug/` out of git, so a
/// skill that is about to write a brief needs one call, not three.
fn run_documents(name: &str, ensure: bool, json: bool, quiet: bool) -> Result<(), String> {
    tugdash_core::validate_dash_name(name).map_err(|e| e.to_string())?;
    let root = tugtool_core::find_repo_root().map_err(|e| e.to_string())?;
    let dir = tugdash_core::documents_dir(&root, name);

    if ensure {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        tugdash_core::ensure_tug_excluded(&root);
    }

    let brief = tugdash_core::brief_file(&root, name);
    let plan = tugdash_core::plan_file(&root, name);
    let tasks = tugdash_core::tasks_file(&root, name);
    let payload = DocumentsPayload {
        dash: name.to_string(),
        dir: dir.display().to_string(),
        brief: brief.display().to_string(),
        plan: plan.display().to_string(),
        tasks: tasks.display().to_string(),
        brief_exists: brief.is_file(),
        plan_exists: plan.is_file(),
        tasks_exists: tasks.is_file(),
    };

    if json {
        print_ok("dash documents", &payload);
    } else if !quiet {
        let mark = |there: bool| if there { "exists" } else { "absent" };
        println!("dash:   {}", payload.dash);
        println!("dir:    {}", payload.dir);
        println!("brief:  {} ({})", payload.brief, mark(payload.brief_exists));
        println!("plan:   {} ({})", payload.plan, mark(payload.plan_exists));
        println!("tasks:  {} ({})", payload.tasks, mark(payload.tasks_exists));
    }
    Ok(())
}

/// `dash documents` — the directory and every document, with existence.
#[derive(Debug, Serialize)]
struct DocumentsPayload {
    dash: String,
    dir: String,
    brief: String,
    plan: String,
    tasks: String,
    brief_exists: bool,
    plan_exists: bool,
    tasks_exists: bool,
}

/// Pick a stopped arc back up: write `arc-resume` naming the stage it stopped
/// in, which clears the stop and tells the runner which stage to rotate again
/// on the calling session's next idle ([P11]). An arc that is not stopped is
/// left as it is — its record is already what the runner reads.
fn resume_arc(
    root: &std::path::Path,
    dash: &str,
    arc: ArcRecord,
) -> Result<(bool, bool, ArcRecord), String> {
    let Some((stage, _)) = arc.stopped else {
        return Ok((false, false, arc));
    };
    tugdash_core::append_arc_resume(root, dash, stage).map_err(|e| e.to_string())?;
    let arc = tugdash_core::read_arc(root, dash)
        .ok_or_else(|| format!("resumed the arc for '{dash}' but could not read it back"))?;
    Ok((false, true, arc))
}

/// Hand a document to the arc (Spec S06).
///
/// Writes the record, then tells the instance that owns the calling session
/// about it over the same `POST /api/dash` route the other session-addressed
/// verbs use. The server binds the session to the dash and returns; the first
/// stage rotates on that session's own turn end ([P05]), never on arrival.
fn run_arc_run(
    name: &str,
    course: &str,
    project: Option<std::path::PathBuf>,
    session: Option<String>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    // The arc runs on a card: every stage is a rotation of the calling
    // session's own tugcode ([B05]). Without a session there is nowhere for a
    // stage to go, so this refuses rather than recording an arc nobody can run.
    let session = calling_session_id("an arc", session.as_deref())?;
    let root = arc_project_root(project.clone())?;
    let course = ArcCourse::parse(course)
        .ok_or_else(|| format!("unknown course '{course}' — expected 'dash' or 'plan'"))?;
    let (started, resumed, arc) = open_arc(&root, name, course)?;

    // The record is written before the kick, so a tugcast that never hears
    // about the arc still has one to find on its next pass.
    let response = post_dash_api(serde_json::json!({
        "op": "arc_run",
        "tug_session_id": session.session_id,
        "project_dir": binding_project(project)?.to_string_lossy(),
        "dash": name,
    }))
    .map_err(|e| refuse(&session, e))?;
    // The server resolves once more at its own door, so its answer is the
    // last word on which session the arc was seated against — never the id
    // that was posted ([P01]).
    let seated = answered_session(&response, &session);

    if json {
        print_ok(
            "dash run",
            ArcRunPayload {
                dash: name.to_string(),
                started,
                resumed,
                arc,
                tug_session_id: seated.clone(),
            },
        );
    } else if !quiet {
        match (started, resumed) {
            (true, _) => println!(
                "Arc opened on '{}' for {}",
                name,
                arc.document.as_deref().unwrap_or("(no document)")
            ),
            (false, true) => println!(
                "Arc on '{}' is stopped in {} — resuming",
                name,
                arc.resume
                    .map(|stage| stage.as_str())
                    .unwrap_or("an unrecorded stage")
            ),
            (false, false) => println!("Arc on '{}' is already open", name),
        }
        println!("Session {seated} is bound to it; the first stage rotates when this turn ends.");
        print_rotation_note(&session, &seated);
    }
    Ok(())
}

/// Report the arc (Spec S07). No arc exits 0 with `arc: null`: a dash without
/// an arc is a state, not an error.
fn run_arc_report(
    name: &str,
    project: Option<std::path::PathBuf>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let root = arc_project_root(project)?;
    let arc = tugdash_core::read_arc(&root, name);

    if json {
        print_ok(
            "dash arc",
            ArcReportPayload {
                dash: name.to_string(),
                arc,
            },
        );
    } else if !quiet {
        match arc {
            None => println!("arc: (none)"),
            Some(arc) => print_arc(&arc),
        }
    }
    Ok(())
}

fn print_arc(arc: &ArcRecord) {
    let undeclared = "(not recorded)";
    println!(
        "document:  {}",
        arc.document.as_deref().unwrap_or(undeclared)
    );
    println!("plan:      {}", arc.plan.as_deref().unwrap_or(undeclared));
    let stage = match (&arc.stopped, arc.current_stage()) {
        (Some((stage, reason)), _) => format!("{} (stopped: {})", stage.as_str(), reason),
        (None, Some(stage)) if arc.done => format!("{} (done)", stage.as_str()),
        (None, Some(stage)) => stage.as_str().to_string(),
        (None, None) => "(none rotated yet)".to_string(),
    };
    println!("stage:     {}", stage);
    for line in &arc.stages {
        println!(
            "  {}  {}  {}  {}",
            line.at,
            line.stage.as_str(),
            line.session_id,
            line.model.as_deref().unwrap_or("(account default)")
        );
    }
    for note in &arc.notes {
        println!("note:      {}", note);
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
    post_instance_api("/api/dash", "dash binding", body)
}

/// The same try-each-instance POST, for any per-instance tugcast API.
///
/// `subject` is what the "no instance was found" failure names. It is a
/// parameter rather than a literal because the text is read by whoever ran the
/// verb, and a rotation must not report a dash binding it never asked for
/// ([P03]).
pub(crate) fn post_instance_api(
    path: &str,
    subject: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
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
        return Err(format!(
            "{subject} goes through a running Tug instance, but none was found"
        ));
    }

    // A non-2xx must stay readable: `unknown_session` arrives as a 404 whose
    // *body* is the answer the loop branches on, and ureq's default turns a
    // non-2xx into an error that discards it.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();

    let mut last_error = None;
    // **A refusal outranks a shrug.** `unknown_session` is one instance
    // saying "not mine, keep walking"; anything else is the instance that
    // *owns* the session telling the caller why it said no. Keeping only the
    // last error let a bystander's shrug overwrite the owner's sentence, so a
    // bind displaced by a running course reported `unknown_session` instead
    // of naming the course — on any machine with a second instance live,
    // which is every machine running an app-test beside a real app.
    let mut owner_error: Option<String> = None;
    for port in ports {
        let url = format!("http://127.0.0.1:{port}{path}");
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
        let message = value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error")
            .to_string();
        if message != "unknown_session" && owner_error.is_none() {
            owner_error = Some(message.clone());
        }
        last_error = Some(message);
    }
    Err(owner_error
        .or(last_error)
        .unwrap_or_else(|| "no instance accepted the request".to_string()))
}

/// The calling session, **resolved** to its line's live segment, or the
/// actionable error naming what to do.
///
/// Every session-addressed dash verb starts here. The raw `$TUG_SESSION_ID`
/// is not an answer: it is frozen at spawn, and a card mid-arc rotates its
/// session on purpose, so the id a stage's shell holds names a segment that
/// closed rotations ago. Resolution happens once, here, before any use — see
/// [`crate::session_identity`] for why this is a chokepoint rather than a
/// per-caller courtesy.
pub(crate) fn calling_session_id(
    subject: &str,
    session: Option<&str>,
) -> Result<crate::session_identity::Resolved, String> {
    crate::session_identity::resolve(subject, session)
}

/// The session the server says it acted on, preferring its answer over
/// anything this process resolved or posted.
///
/// `/api/dash` re-resolves at its own door and names the segment it wrote
/// onto. Echoing the posted id instead is how a bind came to report success
/// about a session the server had deliberately not written.
fn answered_session(
    response: &serde_json::Value,
    resolved: &crate::session_identity::Resolved,
) -> String {
    response
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| resolved.session_id.clone())
}

/// Say so when the verb landed somewhere other than where it was aimed.
///
/// A rotation is meant to be invisible to the work, but a receipt that hides
/// it leaves the reader with no way to tell a stale id from a live one — the
/// silence the whole workstream is about.
fn print_rotation_note(resolved: &crate::session_identity::Resolved, landed: &str) {
    if resolved.resolved && landed != resolved.posted {
        println!(
            "  (this shell holds {}, which has rotated — the verb landed on {landed})",
            resolved.posted
        );
    }
}

/// A refusal that names the session it is about.
///
/// The old text said only what the caller had asked for, so a reader could
/// not tell whether the verb had been aimed at a live card, at a segment two
/// rotations dead, or at nothing at all — which is the whole of why the
/// documented repair gesture read as a success. Every session-addressed dash
/// refusal now carries the **resolved** id and the ledger's word for it.
fn refuse(resolved: &crate::session_identity::Resolved, message: String) -> String {
    let state = resolved
        .state
        .as_deref()
        .unwrap_or("unknown to any instance");
    let mut out = format!("{message} (session {}, {state}", resolved.session_id);
    if resolved.rotated {
        out.push_str(&format!("; this shell holds {}", resolved.posted));
    }
    if let Some(line) = resolved.line_id.as_deref() {
        out.push_str(&format!("; line {line}"));
    }
    out.push(')');
    out
}

fn run_bind(
    name: &str,
    project: Option<std::path::PathBuf>,
    session: Option<&str>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let session = calling_session_id("dash binding", session)?;
    let project = binding_project(project)?;
    let response = post_dash_api(serde_json::json!({
        "op": "bind",
        "tug_session_id": session.session_id,
        "project_dir": project.to_string_lossy(),
        "dash": name,
    }))
    .map_err(|e| refuse(&session, e))?;
    let bound = answered_session(&response, &session);
    if json {
        print_ok(
            "dash bind",
            serde_json::json!({
                "dash": name,
                "dash_id": response.get("dash_id"),
                "tug_session_id": bound,
            }),
        );
    } else if !quiet {
        println!("Bound session {bound} to dash '{name}'");
        print_rotation_note(&session, &bound);
    }
    Ok(())
}

/// Stop the arc running on this card, and keep the dash.
///
/// It runs from a terminal, so it reaches the card through the server: the
/// stop hands the card back, leaves the receipt every other stop leaves, and
/// records `arc-stop <stage> stopped by user`. `tugtool dash run <name>`
/// afterwards resumes through the ordinary `arc-resume` path.
fn run_arc_stop(
    name: &str,
    project: Option<std::path::PathBuf>,
    session: Option<&str>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let session = calling_session_id("dash stop", session)?;
    let project = binding_project(project)?;
    let response = post_dash_api(serde_json::json!({
        "op": "arc_stop",
        "tug_session_id": session.session_id,
        "project_dir": project.to_string_lossy(),
        "dash": name,
    }))
    .map_err(|e| refuse(&session, e))?;
    let stage = response
        .get("stage")
        .and_then(|s| s.as_str())
        .unwrap_or("its stage");
    let stopped = answered_session(&response, &session);
    if json {
        print_ok("dash stop", response);
    } else if !quiet {
        println!("Stopped the arc on '{name}' in {stage} (session {stopped})");
        print_rotation_note(&session, &stopped);
        println!("Resume with tugtool dash run {name}");
    }
    Ok(())
}

/// Answer "which session would this bind land on, and what does the ledger
/// call it" — and write nothing.
///
/// The dry run is a **read**, which is why it exists. A session that wants to
/// know whether its frozen `$TUG_SESSION_ID` still names anything had, until
/// now, exactly one way to find out: bind, and read the receipt. That is a
/// write standing in for a question, and it is the gesture the postmortem
/// found succeeding in both failure modes.
///
/// It resolves through the same chokepoint the real bind does, so the answer
/// is the answer — not a second implementation that could drift from it. The
/// dash name is echoed but never looked up: what would be written is a
/// property of the session, and refusing here for an unknown dash would make
/// the read fail where the write would have.
fn run_bind_dry_run(
    name: &str,
    session: Option<&str>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let resolved = calling_session_id("dash binding", session)?;
    let state = resolved
        .state
        .as_deref()
        .unwrap_or("unknown to any instance");
    if json {
        print_ok(
            "dash bind",
            serde_json::json!({
                "dash": name,
                "dry_run": true,
                "posted_session_id": resolved.posted,
                "tug_session_id": resolved.session_id,
                "state": resolved.state,
                "line_id": resolved.line_id,
                "rotated": resolved.rotated,
                "resolved": resolved.resolved,
            }),
        );
    } else if !quiet {
        println!(
            "Would bind session {} to dash '{name}'",
            resolved.session_id
        );
        println!("  State: {state}");
        if let Some(line) = resolved.line_id.as_deref() {
            println!("  Line: {line}");
        }
        if resolved.rotated {
            println!(
                "  (this shell holds {}, which has rotated)",
                resolved.posted
            );
        }
        if !resolved.resolved {
            println!(
                "  (no live instance answered, so this is the id in the environment, unexpanded)"
            );
        }
        println!("Nothing was written.");
    }
    Ok(())
}

/// What became of a verb's attempt to claim the dash for its session.
///
/// Three outcomes, and the whole point is that the third is not the other two.
/// A run with no session and a run with no instance genuinely have nothing to
/// claim, and never had. A run that *had* both and was told no is a claim that
/// did not happen on a machine that could have made it — and that used to be a
/// stderr warning on an exit-0 run, so the caller was told the verb worked.
enum Claim {
    /// No calling session — a headless run, a fixture, a plain terminal.
    NoSession,
    /// No live Tug instance to hold the fact. A binding lives in the ledger,
    /// not in the worktree, so there is nowhere to put it.
    NoInstance,
    /// The calling session works a different checkout. A session may only bind
    /// a dash in its own project (`dash_api::bind`), so this claim was never
    /// this session's to make — the same kind of no-op as having no session at
    /// all, reached from the other direction. The ordinary shape is a CLI
    /// fixture creating a scratch dash in a temp repo from inside a card.
    OtherProject,
    /// A refusal this side cannot classify, because the instance is older than
    /// the `project_dir` the resolve now answers with. Warned about, not
    /// failed on: a claim that may not have been this session's to make is not
    /// evidence that a claim was lost, and refusing to install a build until
    /// the app restarts is the version-skew mistake W1 already paid for.
    Unclassified(String),
    /// Bound, onto the segment the server named.
    Claimed(String),
    /// A session and an instance were both there, and the bind was refused.
    Refused(String),
}

impl Claim {
    /// The JSON half every claiming verb merges into its own outcome, so a
    /// script reads what happened rather than inferring it from an exit code.
    fn as_json(&self) -> serde_json::Value {
        match self {
            Claim::Claimed(session) => serde_json::json!({
                "claimed": true,
                "claimed_by": session,
            }),
            Claim::NoSession => serde_json::json!({
                "claimed": false,
                "claim_skipped": "no calling session",
            }),
            Claim::NoInstance => serde_json::json!({
                "claimed": false,
                "claim_skipped": "no running Tug instance",
            }),
            Claim::OtherProject => serde_json::json!({
                "claimed": false,
                "claim_skipped": "the calling session works another checkout",
            }),
            Claim::Unclassified(detail) | Claim::Refused(detail) => serde_json::json!({
                "claimed": false,
                "claim_error": detail,
            }),
        }
    }

    /// The refusal, when the claim is one the verb must fail on — and, on the
    /// way past, the stderr warning for the one it must not.
    fn refusal(&self, name: &str) -> Option<String> {
        match self {
            Claim::Refused(detail) => Some(format!(
                "could not bind this session to dash '{name}': {detail}. The dash is on disk and \
                 the work can go on, but nothing records who is doing it — `tugtool dash bind \
                 {name}` once the refusal above is dealt with, or `--dry-run` to see which \
                 session this shell resolves to"
            )),
            Claim::Unclassified(detail) => {
                eprintln!("warning: could not bind this session to dash '{name}': {detail}");
                None
            }
            _ => None,
        }
    }
}

/// Say that the calling session is working this dash.
///
/// **The verbs that start or resume work on a dash call this** — `create` and
/// `step start` — because a run that resumes an existing plan never creates
/// one, and leaving the claim to whoever remembered to type `dash bind` is the
/// same mistake [D147] removed from the join's other end. `commit` is
/// deliberately not among them: see the note there. A dash whose worker
/// nobody recorded shows no worker on its Lens row, on the session masthead or
/// in the shade, and — since the pilot works only for bound dashes — is never
/// offered for joining at all.
///
/// Two of the three no-ops are real and stay silent: there is nothing to claim
/// without a calling session, and nowhere to put it without a live instance.
/// A **refusal** is neither, and the caller is handed it rather than a warning
/// on an otherwise-successful run.
fn claim_dash(name: &str) -> Claim {
    if !crate::session_identity::have_calling_session() {
        return Claim::NoSession;
    }
    if !any_live_instance() {
        return Claim::NoInstance;
    }
    let resolved = match crate::session_identity::resolve("dash binding", None) {
        Ok(resolved) => resolved,
        Err(detail) => return Claim::Refused(detail),
    };
    let project = match binding_project(None) {
        Ok(project) => project,
        Err(detail) => return Claim::Refused(detail),
    };
    // Skip a claim that was never this session's to make, before making it.
    // A session may only bind a dash in its own checkout, and a mismatch here
    // is not a claim that failed — it is one that never applied.
    match same_checkout(resolved.project_dir.as_deref(), &project) {
        Some(false) => return Claim::OtherProject,
        Some(true) => {}
        // An instance older than the `project_dir` field cannot be asked, so
        // the attempt goes ahead and a refusal from it is warned about rather
        // than failed on.
        None => {
            return match run_bind_reporting_as(&resolved, &project, name) {
                Ok(session) => Claim::Claimed(session),
                Err(detail) => Claim::Unclassified(detail),
            };
        }
    }
    match run_bind_reporting_as(&resolved, &project, name) {
        Ok(session) => Claim::Claimed(session),
        Err(detail) => Claim::Refused(detail),
    }
}

/// Whether the session's checkout and the dash's are the same one — or `None`
/// when there is no way to tell.
///
/// The two spellings come from different processes and may differ by
/// symlink (`/var` against `/private/var` is the everyday case), so both are
/// canonicalized before they are compared. A canonicalization that fails
/// answers `None` rather than guessing: the caller downgrades an unknown to
/// "attempt and warn", which is what it did before the field existed, so a bad
/// guess here can only ever lose a refusal it never used to make.
fn same_checkout(session_project: Option<&str>, dash_project: &std::path::Path) -> Option<bool> {
    let session_project = session_project?;
    let canonical = |path: &std::path::Path| std::fs::canonicalize(path).ok();
    let session = canonical(std::path::Path::new(session_project))?;
    let dash = canonical(dash_project)?;
    Some(session == dash)
}

/// Whether any Tug instance is running to hold a binding.
///
/// The same registry read `post_instance_api` opens with. Asked separately so
/// "nobody is running" can be told apart from "somebody said no" without
/// matching on the text of an error message.
fn any_live_instance() -> bool {
    if let Ok(Some(_)) = std::env::current_dir()
        .map_err(|_| ())
        .and_then(|cwd| tugcore::registry::find_for_cwd(&cwd).map_err(|_| ()))
    {
        return true;
    }
    !tugcore::registry::list_live()
        .unwrap_or_default()
        .is_empty()
}

/// The bind a claim makes: silent on success, and it answers with the segment
/// the server wrote onto rather than printing it. The session and the project
/// are resolved by the caller, which needed both to decide whether to make the
/// attempt at all.
fn run_bind_reporting_as(
    session: &crate::session_identity::Resolved,
    project: &std::path::Path,
    name: &str,
) -> Result<String, String> {
    let response = post_dash_api(serde_json::json!({
        "op": "bind",
        "tug_session_id": session.session_id,
        "project_dir": project.to_string_lossy(),
        "dash": name,
    }))
    .map_err(|e| refuse(session, e))?;
    Ok(answered_session(&response, session))
}

fn run_unbind(
    project: Option<std::path::PathBuf>,
    session: Option<&str>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    let session = calling_session_id("dash binding", session)?;
    let _project = binding_project(project)?;
    let response = post_dash_api(serde_json::json!({
        "op": "unbind",
        "tug_session_id": session.session_id,
    }))
    .map_err(|e| refuse(&session, e))?;
    let unbound = answered_session(&response, &session);
    if json {
        print_ok(
            "dash unbind",
            serde_json::json!({ "tug_session_id": unbound }),
        );
    } else if !quiet {
        println!("Unbound session {unbound} from its dash");
        print_rotation_note(&session, &unbound);
    }
    Ok(())
}

/// Which gesture ended a dash.
///
/// `dash_gone` is the teardown of *any* ending — a discard and both join paths
/// broadcast it — so the server is told which one happened and the card can
/// say the truth rather than the discard's story about a join.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DashGone {
    Discarded,
    Joined,
}

impl DashGone {
    fn as_str(&self) -> &'static str {
        match self {
            DashGone::Discarded => "discarded",
            DashGone::Joined => "joined",
        }
    }
}

/// The `dash_gone` request body, as one value the broadcast sends to every
/// live instance.
fn dash_gone_body(project: &std::path::Path, dash_id: &str, reason: DashGone) -> serde_json::Value {
    serde_json::json!({
        "op": "dash_gone",
        "project_dir": project.to_string_lossy(),
        "dash_id": dash_id,
        "reason": reason.as_str(),
    })
}

/// Tell every live instance that a dash is gone, so its bindings and its
/// authored draft are swept ([P05]).
///
/// Best-effort by design: a landing must never fail because no instance was
/// listening. Broadcast rather than try-until-owned — any instance may hold
/// bindings to the dead dash.
///
/// `reason` is the gesture that ended the dash. A typed one rather than a
/// word, because there is exactly one way to get this wrong — naming the other
/// gesture — and a `&str` would let a call site spell it.
/// This is the teardown of *any* ending, not the discard's alone, and a card
/// whose stage was seated on the dash is told which one happened. A card that
/// said "arc discarded" when the user had just joined their work would be
/// worse than the silence it replaces.
///
/// `dash_id` is the owner key the caller captured **before** the landing.
/// `git branch -D` takes the branch's config with it, so a key resolved after
/// the verb returns is the legacy form and matches none of the id-keyed rows
/// this sweep exists to remove ([L23], Risk R02).
fn broadcast_dash_gone(project: &std::path::Path, dash_id: &str, reason: DashGone) {
    let body = dash_gone_body(project, dash_id, reason);
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
/// Every key is `null` when undeclared rather than absent, so a consumer reads
/// the same fields whatever the project says.
#[derive(Serialize)]
struct SurfacePayload {
    name: String,
    paths: Vec<String>,
    check: Vec<String>,
    checked_by: Vec<String>,
}

#[derive(Serialize)]
struct ConfigPayload {
    surfaces: Vec<SurfacePayload>,
    build: Option<String>,
    post_create: Vec<String>,
    devise_model: Option<String>,
    review_model: Option<String>,
    implement_model: Option<String>,
    audit_model: Option<String>,
    implement_compact_tokens: Option<u64>,
}

/// Read the declarations the run's ending and the build offer consume.
///
/// The project root is the standard `.tugtool/` upward walk, so from a dash
/// worktree this reads the worktree's own committed copy — the copy the run is
/// about. A missing config file is the all-undeclared state, not an error.
fn run_config(json: bool, quiet: bool) -> Result<(), String> {
    let root = tugtool_core::config::find_project_root().map_err(|e| e.to_string())?;
    let config =
        tugtool_core::config::Config::load_from_project(&root).map_err(|e| e.to_string())?;
    let dash = config.tugtool.dash;
    let payload = ConfigPayload {
        surfaces: dash
            .surfaces
            .into_iter()
            .map(|s| SurfacePayload {
                name: s.name,
                paths: s.paths,
                check: s.check,
                checked_by: s.checked_by,
            })
            .collect(),
        build: dash.build,
        post_create: dash.post_create,
        devise_model: dash.devise_model,
        review_model: dash.review_model,
        implement_model: dash.implement_model,
        audit_model: dash.audit_model,
        implement_compact_tokens: dash.implement_compact_tokens,
    };

    if json {
        print_ok("dash config", &payload);
    } else if !quiet {
        let undeclared = "(not declared)";
        if payload.surfaces.is_empty() {
            println!("surfaces:     (none declared)");
        } else {
            for surface in &payload.surfaces {
                let checks = if !surface.checked_by.is_empty() {
                    format!("checked by {}", surface.checked_by.join(", "))
                } else if surface.check.is_empty() {
                    "claimed, unchecked".to_string()
                } else if surface.check.len() == 1 {
                    "1 check".to_string()
                } else {
                    format!("{} checks", surface.check.len())
                };
                println!(
                    "surface:      {}  {}  ({})",
                    surface.name,
                    surface.paths.join(" "),
                    checks
                );
            }
        }
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
            "devise_model:    {}",
            payload.devise_model.as_deref().unwrap_or(undeclared)
        );
        println!(
            "review_model:    {}",
            payload.review_model.as_deref().unwrap_or(undeclared)
        );
        println!(
            "implement_model: {}",
            payload.implement_model.as_deref().unwrap_or(undeclared)
        );
        println!(
            "audit_model:     {}",
            payload.audit_model.as_deref().unwrap_or(undeclared)
        );
        match payload.implement_compact_tokens {
            Some(tokens) => println!("implement_compact_tokens: {}", tokens),
            None => println!(
                "implement_compact_tokens: {} (defaults to {})",
                undeclared,
                tugtool_core::config::IMPLEMENT_COMPACT_TOKENS_DEFAULT
            ),
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

    /// `withdraw` takes no `--through` — it inherits the run's declared
    /// selection the way `done` does — so no argument check stands between the
    /// arm and the op, which is the symmetric fact to the `start` refusal
    /// above. The claim the arm makes beside the call is env-gated on a
    /// calling session and best-effort by construction, so a headless run like
    /// this one takes its early return.
    #[test]
    fn step_withdraw_needs_no_through() {
        let err = run_step("any-dash", StepAction::Withdraw { step: 1 }, false, true).unwrap_err();
        assert!(
            !err.contains("--through"),
            "a withdrawal inherits the run's selection rather than declaring one: {err}"
        );
    }

    // --- the arc record (Spec S06, Spec S07) -------------------------------

    /// A scratch data dir plus the repo root whose dash-log it holds. Both
    /// live as long as the fixture; the data dir is redirected off the user's
    /// real one, which is why every arc test here is `#[serial]`.
    struct ArcFixture {
        _home: tempfile::TempDir,
        repo: tempfile::TempDir,
    }

    impl ArcFixture {
        fn root(&self) -> &std::path::Path {
            self.repo.path()
        }

        /// The dash-log's lines, so a test can count what was written rather
        /// than infer it from what was read back.
        fn log_lines(&self) -> Vec<String> {
            let path = tugtool_core::paths::project_state_dir(self.root()).join("dash-log.md");
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        /// Write a brief into the dash's own documents home.
        fn write_brief(&self, dash: &str) {
            self.write_document(dash, "brief.md");
        }

        /// Write a plan there.
        fn write_plan(&self, dash: &str) {
            self.write_document(dash, "plan.md");
        }

        fn write_document(&self, dash: &str, file: &str) {
            let dir = self.root().join(".tug").join("dashes").join(dash);
            std::fs::create_dir_all(&dir).expect("documents dir");
            std::fs::write(dir.join(file), "# Fixture\n").expect("write document");
        }

        fn write_log(&self, lines: &str) {
            let state = tugtool_core::paths::project_state_dir(self.root());
            std::fs::create_dir_all(&state).expect("state dir");
            std::fs::write(state.join("dash-log.md"), lines).expect("write log");
        }
    }

    fn arc_fixture() -> ArcFixture {
        let home = tempfile::tempdir().expect("tempdir");
        // SAFETY: these tests are #[serial]; no other thread reads the
        // environment concurrently while this runs.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        ArcFixture {
            _home: home,
            repo: tempfile::tempdir().expect("tempdir"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn opening_an_arc_writes_one_start_line() {
        let fixture = arc_fixture();
        fixture.write_brief("demo");
        let (started, resumed, arc) =
            open_arc(fixture.root(), "demo", ArcCourse::Plan).expect("opened");
        assert!(started);
        assert!(!resumed);
        assert_eq!(arc.document.as_deref(), Some(".tug/dashes/demo/brief.md"));
        let starts = fixture
            .log_lines()
            .iter()
            .filter(|line| line.contains("arc-start"))
            .count();
        assert_eq!(starts, 1);
    }

    #[test]
    #[serial_test::serial]
    fn opening_the_same_dash_twice_is_one_arc() {
        let fixture = arc_fixture();
        fixture.write_brief("demo");
        open_arc(fixture.root(), "demo", ArcCourse::Plan).expect("opened");
        let (started, _, _) = open_arc(fixture.root(), "demo", ArcCourse::Plan).expect("reopened");
        assert!(!started, "a second run on the same dash opens nothing");
        let starts = fixture
            .log_lines()
            .iter()
            .filter(|line| line.contains("arc-start"))
            .count();
        assert_eq!(starts, 1);
    }

    /// The document is the dash's own, and the brief comes first — a dash that
    /// has reached devise opens on what it was briefed with, not on its output.
    #[test]
    #[serial_test::serial]
    fn open_arc_opens_on_the_brief_then_the_plan() {
        let fixture = arc_fixture();
        fixture.write_plan("plan-only");
        let (_, _, arc) = open_arc(fixture.root(), "plan-only", ArcCourse::Plan).expect("opened");
        assert_eq!(
            arc.document.as_deref(),
            Some(".tug/dashes/plan-only/plan.md")
        );

        let fixture = arc_fixture();
        fixture.write_brief("both");
        fixture.write_plan("both");
        let (_, _, arc) = open_arc(fixture.root(), "both", ArcCourse::Plan).expect("opened");
        assert_eq!(arc.document.as_deref(), Some(".tug/dashes/both/brief.md"));
    }

    /// The `/dash` door writes a brief and a task list, and the arc opens on
    /// the brief — the task list is the ledger, not the document the stages
    /// read for intent.
    #[test]
    #[serial_test::serial]
    fn a_dash_course_opens_its_arc_on_the_brief() {
        let fixture = arc_fixture();
        fixture.write_document("course", "brief.md");
        fixture.write_document("course", "tasks.md");
        let (_, _, arc) = open_arc(fixture.root(), "course", ArcCourse::Plan).unwrap();
        assert_eq!(arc.document.as_deref(), Some(".tug/dashes/course/brief.md"));
    }

    /// **The opening records the course kind ([B08]).** `--course` defaults
    /// to `plan`, so an ordinary `dash run` writes the progression every dash
    /// already had; asking for `dash` writes the shorter one.
    #[test]
    #[serial_test::serial]
    fn opening_an_arc_records_the_course_kind_it_was_asked_for() {
        let fixture = arc_fixture();
        fixture.write_document("shortcut", "brief.md");
        let (_, _, arc) = open_arc(fixture.root(), "shortcut", ArcCourse::Dash).unwrap();
        assert_eq!(arc.course, Some(ArcCourse::Dash));

        let fixture = arc_fixture();
        fixture.write_document("settled", "brief.md");
        let (_, _, arc) = open_arc(fixture.root(), "settled", ArcCourse::Plan).unwrap();
        assert_eq!(arc.course, Some(ArcCourse::Plan));
    }

    /// **A resume cannot change the kind.** The record is the arc's identity,
    /// and a `dash run --course dash` over an arc opened as a plan course is
    /// a resume of that arc, not a second one wearing a different
    /// progression.
    #[test]
    #[serial_test::serial]
    fn a_resume_keeps_the_kind_the_opening_recorded() {
        let fixture = arc_fixture();
        fixture.write_document("settled", "brief.md");
        open_arc(fixture.root(), "settled", ArcCourse::Plan).unwrap();
        let (started, _, arc) = open_arc(fixture.root(), "settled", ArcCourse::Dash).unwrap();
        assert!(!started);
        assert_eq!(arc.course, Some(ArcCourse::Plan));
    }

    /// A task list alone still opens an arc: the wheel has a document to read
    /// and a ledger to walk, which is all opening requires.
    #[test]
    #[serial_test::serial]
    fn a_task_list_alone_opens_an_arc() {
        let fixture = arc_fixture();
        fixture.write_document("tasks-only", "tasks.md");
        let (_, _, arc) = open_arc(fixture.root(), "tasks-only", ArcCourse::Plan).unwrap();
        assert_eq!(
            arc.document.as_deref(),
            Some(".tug/dashes/tasks-only/tasks.md")
        );
    }

    #[test]
    #[serial_test::serial]
    fn a_dash_with_no_documents_says_to_write_one() {
        let fixture = arc_fixture();
        let err = open_arc(fixture.root(), "empty", ArcCourse::Plan).unwrap_err();
        assert!(
            err.contains("has no brief, plan, or task list") && err.contains(".tug/dashes/empty"),
            "the refusal must name the address to write to: {err}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn resuming_a_stopped_arc_writes_the_resume_and_clears_the_stop() {
        let fixture = arc_fixture();
        fixture.write_log(&format!(
            "{}{}",
            "2026-08-24T10:00:00Z  demo  arc-start  dash/idea.md\n",
            "2026-08-24T10:05:00Z  demo  arc-stop  review lint failed\n"
        ));
        let before = fixture.log_lines().len();
        let (started, resumed, arc) =
            open_arc(fixture.root(), "demo", ArcCourse::Plan).expect("resumed");
        assert!(!started);
        assert!(resumed);
        assert_eq!(arc.stopped, None, "the stop is cleared");
        assert_eq!(
            arc.resume,
            Some(tugdash_core::ArcStage::Review),
            "and the stage it stopped in is the one to rotate again"
        );
        assert_eq!(
            fixture.log_lines().len(),
            before + 1,
            "one `arc-resume` line"
        );

        // An arc that is not stopped has nothing to resume, and a second run
        // on it writes nothing.
        let after = fixture.log_lines().len();
        let (_, resumed, _) =
            open_arc(fixture.root(), "demo", ArcCourse::Plan).expect("still open");
        assert!(!resumed);
        assert_eq!(fixture.log_lines().len(), after);
    }

    #[test]
    #[serial_test::serial]
    fn an_unknown_dash_has_no_arc() {
        let fixture = arc_fixture();
        assert!(tugdash_core::read_arc(fixture.root(), "nonexistent").is_none());
    }

    #[test]
    #[serial_test::serial]
    fn a_synthesized_log_round_trips_into_the_reported_payload() {
        let fixture = arc_fixture();
        fixture.write_log(
            "2026-08-24T10:00:00Z  demo  arc-start  dash/idea.md\n\
             2026-08-24T10:01:00Z  demo  arc-plan  dash/d.md\n\
             2026-08-24T10:02:00Z  demo  arc-stage  devise sess-1 opus\n\
             2026-08-24T11:00:00Z  demo  arc-stage  review sess-2 -\n",
        );
        let payload = ArcReportPayload {
            dash: "demo".to_string(),
            arc: tugdash_core::read_arc(fixture.root(), "demo"),
        };
        let value = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(value["dash"], "demo");
        assert_eq!(value["arc"]["document"], "dash/idea.md");
        assert_eq!(value["arc"]["plan"], "dash/d.md");
        assert_eq!(value["arc"]["stages"][0]["stage"], "devise");
        assert_eq!(value["arc"]["stages"][0]["model"], "opus");
        assert_eq!(value["arc"]["stages"][1]["stage"], "review");
        assert!(value["arc"]["stages"][1]["model"].is_null());
        assert_eq!(value["arc"]["done"], false);
    }

    #[test]
    fn the_config_payload_reports_every_stage_key_as_null_when_undeclared() {
        // A project that declares none must still report all four, so a
        // consumer reads the same shape whatever the project says.
        let payload = ConfigPayload {
            surfaces: Vec::new(),
            build: None,
            post_create: Vec::new(),
            devise_model: None,
            review_model: None,
            implement_model: None,
            audit_model: None,
            implement_compact_tokens: None,
        };
        let value = serde_json::to_value(&payload).expect("serialize");
        for key in [
            "devise_model",
            "review_model",
            "implement_model",
            "implement_compact_tokens",
        ] {
            assert!(
                value.get(key).is_some_and(serde_json::Value::is_null),
                "{key} must be reported as null, not absent"
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn an_arc_stopped_by_a_closing_card_resumes_from_a_fresh_one() {
        // The accidental resume, made the designed one: a card that closed
        // mid-stage leaves `arc-stop … card closed`, and the ordinary resume
        // path picks the arc back up from wherever the user asks next.
        let home = tempfile::tempdir().unwrap();
        // SAFETY: `#[serial]`; no other thread reads the environment here.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        tugdash_core::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::append_arc_stage(
            root,
            "demo",
            tugdash_core::ArcStage::Review,
            "claude-1",
            None,
        )
        .unwrap();
        tugdash_core::arc::append_arc_stop(
            root,
            "demo",
            tugdash_core::ArcStage::Review,
            tugdash_core::arc::ArcStopReason::CardClosed,
        )
        .unwrap();

        let (opened, resumed, arc) = open_arc(root, "demo", ArcCourse::Plan).expect("resume");
        assert!(!opened, "the arc is the same one, not a second");
        assert!(
            resumed,
            "and it resumes rather than reporting nothing to do"
        );
        assert_eq!(arc.stopped, None, "the resume clears the stop");
        assert_eq!(
            arc.resume,
            Some(tugdash_core::ArcStage::Review),
            "and names the stage to rotate again",
        );
    }

    #[test]
    fn an_endings_broadcast_names_the_gesture_that_ended_the_dash() {
        let discard = dash_gone_body(
            std::path::Path::new("/p"),
            "tugdash/demo#1",
            DashGone::Discarded,
        );
        assert_eq!(discard["op"], "dash_gone");
        assert_eq!(discard["reason"], "discarded");
        assert_eq!(discard["dash_id"], "tugdash/demo#1");

        let join = dash_gone_body(
            std::path::Path::new("/p"),
            "tugdash/demo#1",
            DashGone::Joined,
        );
        assert_eq!(join["reason"], "joined");
    }

    #[test]
    #[serial_test::serial]
    fn no_arc_serializes_as_null_rather_than_an_absent_key() {
        let payload = ArcReportPayload {
            dash: "demo".to_string(),
            arc: None,
        };
        let value = serde_json::to_value(&payload).expect("serialize");
        assert!(value["arc"].is_null());
    }
}
