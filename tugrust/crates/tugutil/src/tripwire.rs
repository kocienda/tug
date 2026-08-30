//! Tripwires — standing watchers (`tugutil tripwire …`). A thin shell over
//! [`tugutil_core::tripwire_ledger`]: compile the command line's trigger spelling
//! to Spec S01 JSON, call the typed ledger API, and format the outcome as
//! `--json` (the shared envelope) or a plain human read-out.
//!
//! **The spelling is the CLI's, the JSON is the record's.** `--on
//! fact:edit_failed --where route=claude` is what a person types; the stored
//! trigger is `{"fact":{"kind":"edit_failed","where":{"route":"claude"}}}`,
//! and the engine reads only the JSON. Two grammars, one direction: nothing
//! ever compiles back the other way, so the shorthand can grow without the
//! record having to.

use std::collections::BTreeMap;
use std::process::ExitCode;

use serde::Serialize;

use tugutil_core::tripwire_ledger::{
    self as ledger, Claim, NewTripwire, Resolution, Settlement, TripStatus, Tripwire, TripwireEdit,
    TripwireLedgerError,
};
use tugutil_core::tripwire_predicate::{FactTrigger, Matcher, Predicate};

use crate::cli::TripwireCommands;
use crate::output::print_ok;

/// Dispatch a `tripwire` subcommand, mapping a `Result<(), String>` to an exit
/// code — 1 on any refusal, the shape every other verb group here uses.
pub fn dispatch(cmd: TripwireCommands, json: bool, quiet: bool) -> ExitCode {
    let result: Result<(), String> = match cmd {
        TripwireCommands::Lay {
            name,
            on,
            clauses,
            branch,
            scope,
            probe,
            brief,
            model,
            permission_mode,
            preview,
        } => run_lay(
            LayArgs {
                name,
                on,
                clauses,
                branch,
                scope,
                probe,
                brief,
                model,
                permission_mode,
            },
            preview,
            json,
            quiet,
        ),
        TripwireCommands::List => run_list(json, quiet),
        TripwireCommands::Edit {
            name,
            on,
            clauses,
            scope,
            branch,
            probe,
            brief,
            model,
            permission_mode,
            clear,
            preview,
        } => run_edit(
            EditArgs {
                name,
                on,
                clauses,
                scope,
                branch,
                probe,
                brief,
                model,
                permission_mode,
                clear,
            },
            preview,
            json,
            quiet,
        ),
        TripwireCommands::Rm { name } => run_rm(&name, json, quiet),
        TripwireCommands::Pause { name } => run_paused(&name, true, json, quiet),
        TripwireCommands::Resume { name } => run_paused(&name, false, json, quiet),
        TripwireCommands::Log { name, limit } => run_log(&name, limit, json, quiet),
        TripwireCommands::Trip { name } => run_trip(&name, json, quiet),
        TripwireCommands::Resolve {
            name,
            quiet: is_quiet,
            awaiting,
            headline,
            author,
        } => run_resolve(
            &name,
            is_quiet,
            awaiting,
            headline.as_deref(),
            author.as_deref(),
            json,
            quiet,
        ),
        TripwireCommands::Dismiss { name } => run_dismiss(&name, json, quiet),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::from(1)
        }
    }
}

// MARK: - The trigger spelling

/// Compile `--on` and `--where` to a Spec S01 predicate.
///
/// A refusal names the token it choked on rather than the whole spelling: a
/// tripwire is typed once and read for months, and "unknown trigger source
/// `factt`" is the sentence that gets it laid on the second try.
fn compile_trigger(on: &str, clauses: &[String]) -> Result<Predicate, String> {
    let (source, rest) = match on.split_once(':') {
        Some((source, rest)) => (source, Some(rest)),
        None => (on, None),
    };
    match source {
        "fact" => {
            let kind = rest.filter(|k| !k.is_empty()).ok_or_else(|| {
                "a fact trigger names its kind: --on fact:<kind>, e.g. fact:edit_failed".to_string()
            })?;
            let r#where = compile_clauses(clauses)?;
            Ok(Predicate::Fact(FactTrigger {
                kind: kind.to_string(),
                r#where,
            }))
        }
        "commit" => Err(
            "a wire no longer watches commits directly: it fires on a landing onto the branch \
             it names, so say --branch <name> and watch a fact with --on fact:<kind>"
                .to_string(),
        ),
        other => Err(format!(
            "unknown trigger source `{other}` — a tripwire watches `fact:<kind>`"
        )),
    }
}

/// Compile the `--where` spellings.
///
/// The **first `=` decides**, and the character before it says which operator
/// it is. Scanning for `~=` first would read `route=a~=b` as a field named
/// `route=a`, because the two-character operators both end in the `=` that
/// spells the exact match. A field name never contains `=`, so the first one
/// is always the operator, and only its left neighbour is in question.
fn compile_clauses(clauses: &[String]) -> Result<Option<BTreeMap<String, Matcher>>, String> {
    if clauses.is_empty() {
        return Ok(None);
    }
    let mut out = BTreeMap::new();
    for clause in clauses {
        let Some(eq) = clause.find('=') else {
            return Err(format!(
                "`{clause}` is not a --where clause — spell it field=value, \
                 field~=substring, or field^=prefix"
            ));
        };
        let value = clause[eq + 1..].to_string();
        let (field, matcher) = match clause[..eq].chars().last() {
            Some('~') => (&clause[..eq - 1], Matcher::Contains { contains: value }),
            Some('^') => (&clause[..eq - 1], Matcher::Prefix { prefix: value }),
            _ => (&clause[..eq], Matcher::Exact(value)),
        };
        if field.is_empty() {
            return Err(format!("`{clause}` names no field"));
        }
        if out.insert(field.to_string(), matcher).is_some() {
            return Err(format!(
                "--where names `{field}` twice, and a v1 predicate holds one \
                 matcher per field"
            ));
        }
    }
    Ok(Some(out))
}

/// A brief, or the file `@path` names. A brief is prose that will be read by a
/// model months from now, so it earns a file the moment it outgrows a line.
fn read_brief(brief: &str) -> Result<String, String> {
    match brief.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}")),
        None => Ok(brief.to_string()),
    }
}

/// A scope as the engine will compare it ([P12]): canonical, and deliberately
/// **not** folded to its base checkout — an authoring trip commits on its own
/// dash worktree, and folding worktrees into their base would make those
/// commits re-trip the tripwire that made them. A path that cannot be
/// canonicalized keeps its literal form rather than failing the lay.
fn canonical_scope(scope: &str) -> String {
    std::fs::canonicalize(scope)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| scope.to_string())
}

/// The branch a wire watches: what `--branch` said, or the default branch of
/// the repository the wire is scoped to.
///
/// The sugar is worth having and the storing is not optional ([P02]): a wire
/// laid without a branch it can resolve is refused here rather than written as
/// a wire nothing will ever trip.
fn resolve_branch(branch: Option<&str>, scope: Option<&str>) -> Result<String, String> {
    if let Some(named) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        return Ok(named.to_string());
    }
    let repo = scope.unwrap_or(".");
    git_default_branch(repo).ok_or_else(|| {
        format!(
            "no --branch given and `{repo}` has no default branch to read one from — \
             a wire fires on a landing onto a named branch, so name it"
        )
    })
}

/// The default branch of the checkout at `path`, as git reports it.
fn git_default_branch(path: &str) -> Option<String> {
    let symref = std::process::Command::new("git")
        .args([
            "-C",
            path,
            "symbolic-ref",
            "--short",
            "refs/remotes/origin/HEAD",
        ])
        .output()
        .ok()?;
    if symref.status.success() {
        let text = String::from_utf8_lossy(&symref.stdout);
        let branch = text.trim().rsplit('/').next().unwrap_or_default();
        if !branch.is_empty() {
            return Some(branch.to_string());
        }
    }
    for candidate in ["main", "master"] {
        let verified = std::process::Command::new("git")
            .args(["-C", path, "rev-parse", "--verify", "--quiet", candidate])
            .output()
            .ok()?;
        if verified.status.success() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn open() -> Result<rusqlite::Connection, String> {
    ledger::open().map_err(|e| e.to_string())
}

// MARK: - lay

struct LayArgs {
    name: String,
    on: String,
    clauses: Vec<String>,
    branch: Option<String>,
    scope: Option<String>,
    probe: Option<String>,
    brief: String,
    model: Option<String>,
    permission_mode: Option<String>,
}

fn run_lay(args: LayArgs, preview: bool, json: bool, quiet: bool) -> Result<(), String> {
    let predicate = compile_trigger(&args.on, &args.clauses)?;
    let trigger = serde_json::to_string(&predicate).map_err(|e| e.to_string())?;
    let scope = args.scope.as_deref().map(canonical_scope);
    let branch = resolve_branch(args.branch.as_deref(), scope.as_deref())?;

    let mut tripwire = NewTripwire::new(&args.name, &trigger, read_brief(&args.brief)?, branch);
    tripwire.scope = scope;
    tripwire.probe = args.probe;
    tripwire.model = args.model;
    if let Some(mode) = args.permission_mode {
        tripwire.permission_mode = mode;
    }

    // A preview is syntax and nothing else ([P13]): it parses, normalizes, and
    // echoes what would be stored, touching no ledger. Whether the tripwire ever
    // fires is a question only a real event answers, and `tripwire trip` is how
    // that question gets asked.
    //
    // The brief is checked before the preview branch, not after it: a preview
    // that showed a tripwire the lay would refuse would be a preview of
    // something that cannot happen.
    ledger::check_brief(&tripwire.name, &tripwire.brief).map_err(|e| e.to_string())?;
    if preview {
        let payload = TripwirePayload::preview(&tripwire);
        if json {
            print_ok("tripwire lay --preview", &payload);
        } else if !quiet {
            payload.print("would lay");
        }
        return Ok(());
    }

    let conn = open()?;
    let laid = ledger::lay(&conn, &tripwire, now_ms()).map_err(|e| e.to_string())?;
    let payload = TripwirePayload::of(&laid);
    if json {
        print_ok("tripwire lay", &payload);
    } else if !quiet {
        payload.print("laid");
    }
    Ok(())
}

// MARK: - list / edit / rm / pause

fn run_list(json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwires = ledger::list(&conn).map_err(|e| e.to_string())?;
    let payload: Vec<TripwirePayload> = tripwires.iter().map(TripwirePayload::of).collect();
    if json {
        print_ok("tripwire list", &payload);
    } else if !quiet {
        if payload.is_empty() {
            println!("no tripwires laid");
        }
        for tripwire in &payload {
            println!(
                "{}{}  {}  branch={}{}",
                tripwire.name,
                if tripwire.paused { " (paused)" } else { "" },
                tripwire.trigger,
                tripwire.branch,
                tripwire
                    .scope
                    .as_deref()
                    .map(|s| format!("  scope={s}"))
                    .unwrap_or_default(),
            );
        }
    }
    Ok(())
}

struct EditArgs {
    name: String,
    on: Option<String>,
    clauses: Vec<String>,
    scope: Option<String>,
    branch: Option<String>,
    probe: Option<String>,
    brief: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    clear: Vec<String>,
}

fn run_edit(args: EditArgs, preview: bool, json: bool, quiet: bool) -> Result<(), String> {
    let mut edit = TripwireEdit::default();

    // `--where` without `--on` would have to merge new clauses into a trigger
    // this verb never parsed, and a half-replaced predicate is the one shape
    // nobody could reason about later. So a trigger is edited whole.
    if args.on.is_none() && !args.clauses.is_empty() {
        return Err("--where narrows a trigger, so it comes with the --on it narrows".to_string());
    }
    if let Some(on) = &args.on {
        let predicate = compile_trigger(on, &args.clauses)?;
        edit.trigger = Some(serde_json::to_string(&predicate).map_err(|e| e.to_string())?);
    }
    if let Some(scope) = &args.scope {
        edit.scope = Some(Some(canonical_scope(scope)));
    }
    if let Some(probe) = args.probe {
        edit.probe = Some(Some(probe));
    }
    if let Some(brief) = &args.brief {
        let text = read_brief(brief)?;
        ledger::check_brief(&args.name, &text).map_err(|e| e.to_string())?;
        edit.brief = Some(text);
    }
    if let Some(model) = args.model {
        edit.model = Some(Some(model));
    }
    if let Some(branch) = args.branch.as_deref() {
        let named = branch.trim();
        if named.is_empty() {
            return Err(
                "--branch names the branch a landing has to be onto, so it is not empty"
                    .to_string(),
            );
        }
        edit.branch = Some(named.to_string());
    }
    if let Some(mode) = args.permission_mode {
        edit.permission_mode = Some(mode);
    }
    for column in &args.clear {
        match column.as_str() {
            "scope" => edit.scope = Some(None),
            "probe" => edit.probe = Some(None),
            "model" => edit.model = Some(None),
            other => {
                return Err(format!(
                    "`{other}` is not a clearable column — scope, probe, or model"
                ));
            }
        }
    }

    if preview {
        if json {
            print_ok(
                "tripwire edit --preview",
                EditPreview::of(&args.name, &edit),
            );
        } else if !quiet {
            EditPreview::of(&args.name, &edit).print();
        }
        return Ok(());
    }

    let conn = open()?;
    let edited = ledger::update(&conn, &args.name, &edit).map_err(|e| e.to_string())?;
    let payload = TripwirePayload::of(&edited);
    if json {
        print_ok("tripwire edit", &payload);
    } else if !quiet {
        payload.print("edited");
    }
    Ok(())
}

fn run_rm(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    ledger::remove(&conn, name).map_err(|e| e.to_string())?;
    if json {
        print_ok(
            "tripwire rm",
            &RemovedPayload {
                tripwire: name.to_string(),
                removed: true,
            },
        );
    } else if !quiet {
        println!("removed tripwire {name} and its trip log");
    }
    Ok(())
}

fn run_paused(name: &str, paused: bool, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::set_paused(&conn, name, paused).map_err(|e| e.to_string())?;
    let payload = TripwirePayload::of(&tripwire);
    if json {
        print_ok(
            if paused {
                "tripwire pause"
            } else {
                "tripwire resume"
            },
            &payload,
        );
    } else if !quiet {
        payload.print(if paused { "paused" } else { "resumed" });
    }
    Ok(())
}

// MARK: - log / trip

fn run_log(name: &str, limit: i64, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;
    let trips = ledger::trips_for_tripwire(&conn, tripwire.id, limit).map_err(|e| e.to_string())?;
    let payload: Vec<TripPayload> = trips.iter().map(TripPayload::of).collect();
    if json {
        print_ok("tripwire log", &payload);
    } else if !quiet {
        if payload.is_empty() {
            println!("tripwire {name} has never fired");
        }
        for trip in &payload {
            // The swallowed firings print too. A tripwire that swallowed a hundred
            // and a tripwire that never saw one look identical from outside, and
            // only one of them is working.
            println!(
                "{}  {}  {}{}{}",
                trip.at_ms,
                trip.status,
                trip.event_key,
                trip.swallow_reason
                    .as_deref()
                    .map(|r| format!("  ({r})"))
                    .unwrap_or_default(),
                trip.headline
                    .as_deref()
                    .map(|h| format!("  {h}"))
                    .unwrap_or_default(),
            );
        }
    }
    Ok(())
}

/// Fire a tripwire by hand.
///
/// The queued row is written first and the live instance is told second, in
/// that order on purpose: the row is the firing, and the tell is only a nudge
/// that says not to wait out the engine's tick. With no instance listening the
/// row still stands and the next engine to run picks it up, so the verb
/// reports which of the two happened rather than claiming the firing was lost.
fn run_trip(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;

    // A manual key is unique by construction, so a hand-fired trip bypasses
    // the guard a real landing meets: the permanent `landing:<sha>` claim,
    // which would let a wire be hand-fired on one commit exactly once. Firing
    // by hand is how a tripwire is tested, and a test that could be swallowed
    // would test nothing.
    let event_key = format!("manual:{}", uuid::Uuid::new_v4());
    let claimed = ledger::claim_trip(
        &conn,
        tripwire.id,
        &event_key,
        now_ms(),
        &instance_label(),
        None,
    )
    .map_err(|e| e.to_string())?;
    let Claim::Claimed { trip_id } = claimed else {
        return Err("a manual event key collided, which should not be possible".to_string());
    };
    ledger::queue_trip(&conn, tripwire.id, trip_id).map_err(|e| e.to_string())?;

    let payload = TripQueuedPayload {
        tripwire: name.to_string(),
        trip_id,
        event_key,
        status: "queued".to_string(),
        served: kick_live_instance(name),
    };
    if json {
        print_ok("tripwire trip", &payload);
    } else if !quiet {
        if payload.served {
            println!("tripwire {name} queued trip {trip_id} and a live instance took it up");
        } else {
            println!(
                "tripwire {name} queued trip {trip_id} ({}) — the next engine to run picks it up",
                payload.event_key
            );
        }
    }
    Ok(())
}

/// Nudge a live instance to work the queued row now, reporting whether one
/// answered. A failure here is not the verb's failure: the row is written, and
/// no instance running is the ordinary case for a machine with the app closed.
fn kick_live_instance(tripwire: &str) -> bool {
    crate::commands::tell::tell_quietly("tripwire_trip", &[format!("tripwire={tripwire}")]).is_ok()
}

/// Settle the wire's running trip (Spec S02) — the only settle a live session
/// has, and the whole of what replaced the envelope parser.
///
/// The ledger write is the resolution and the tell is a nudge, in that order
/// for the same reason `trip` orders them that way: the row is what the Lens
/// eventually reads, and no instance running is the ordinary case for a
/// machine with the app closed. What the tell buys is the Lens repainting now
/// rather than on the engine's next tick.
fn run_resolve(
    name: &str,
    quiet_resolution: bool,
    awaiting: bool,
    headline: Option<&str>,
    author: Option<&str>,
    json: bool,
    quiet: bool,
) -> Result<(), String> {
    if quiet_resolution == awaiting {
        return Err(
            "say which resolution this is: --quiet when nothing is actionable, or --awaiting \
             --headline \"<one line>\" when there is something the user should see"
                .to_string(),
        );
    }
    let headline = match (awaiting, headline) {
        (true, None) | (true, Some("")) => {
            return Err(
                "--awaiting needs --headline: the headline is the one line the Lens row shows, \
                 and an awaiting trip with none says nothing to the person it is waiting for"
                    .to_string(),
            );
        }
        (_, headline) => headline,
    };
    let conn = open()?;
    let tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;

    let status = if awaiting {
        TripStatus::Awaiting
    } else {
        TripStatus::Settled
    };
    let settlement = Settlement {
        headline: headline.map(str::to_owned),
        ..Settlement::default()
    };
    let resolution =
        ledger::resolve_running(&conn, tripwire.id, status, &settlement, author, now_ms())
            .map_err(|e| e.to_string())?;
    let Resolution::Resolved { trip_id, .. } = resolution else {
        let Resolution::NoLiveTrip { state } = resolution else {
            unreachable!("a resolution is one of two things")
        };
        return Err(match state {
            Some(state) => format!(
                "tripwire {name} has no running trip to resolve — its newest trip is {state}"
            ),
            None => format!("tripwire {name} has never fired, so there is nothing to resolve"),
        });
    };

    let payload = ResolvedPayload {
        tripwire: name.to_string(),
        trip_id,
        status: status.as_str().to_string(),
        headline: headline.map(str::to_owned),
        author: author.map(str::to_owned),
        told: tell_live_instance(name),
    };
    if json {
        print_ok("tripwire resolve", &payload);
    } else if !quiet {
        println!(
            "tripwire {name} resolved trip {trip_id} as {}",
            status.as_str()
        );
    }
    Ok(())
}

/// Settle an awaiting trip by hand and discard the dash it was holding
/// ([P07], [P09]).
///
/// The discard is the dismissal's other half rather than a courtesy: an
/// awaiting trip holds a dash the user is being asked about, and settling the
/// row while leaving the worktree standing is exactly the leak this rebuild
/// exists to close.
fn run_dismiss(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;
    let resolution =
        ledger::resolve_awaiting(&conn, tripwire.id, now_ms()).map_err(|e| e.to_string())?;
    let Resolution::Resolved { trip_id, dash } = resolution else {
        let Resolution::NoLiveTrip { state } = resolution else {
            unreachable!("a resolution is one of two things")
        };
        return Err(match state {
            Some(state) => format!(
                "tripwire {name} has no awaiting trip to dismiss — its newest trip is {state}"
            ),
            None => format!("tripwire {name} has never fired, so there is nothing to dismiss"),
        });
    };

    let discarded = dash
        .as_deref()
        .map(|dash| discard_tripwire_dash(&conn, &tripwire, trip_id, dash));
    let discard_error = match &discarded {
        Some(Err(e)) => Some(e.clone()),
        _ => None,
    };
    let payload = DismissedPayload {
        tripwire: name.to_string(),
        trip_id,
        dash,
        discarded: matches!(discarded, Some(Ok(()))),
        discard_error: discard_error.clone(),
        told: tell_live_instance(name),
    };
    if json {
        print_ok("tripwire dismiss", &payload);
    } else if !quiet {
        println!("tripwire {name} dismissed trip {trip_id}");
    }
    // The settle is written whatever happened next, so a discard that could
    // not run is reported rather than swallowed: a dash left standing is the
    // leak this verb exists to close, and silence about it is how nobody
    // finds out.
    if let Some(e) = discard_error {
        eprintln!("tripwire {name}: the dash it was holding was not discarded — {e}");
    }
    Ok(())
}

/// Remove a dismissed trip's dash, handing nothing back to the base checkout
/// ([P09]).
///
/// Addressed by the **landing's** repository rather than by the wire's scope,
/// because that is where the engine cut the dash: a scope is a path prefix a
/// wire is confined to, which may be an ancestor of the checkout or absent
/// altogether, and an unscoped wire's dash is still a dash. The scope is the
/// fallback for a trip whose row carries no landing — a hand-fired one.
fn discard_tripwire_dash(
    conn: &rusqlite::Connection,
    tripwire: &Tripwire,
    trip_id: i64,
    dash: &str,
) -> Result<(), String> {
    let root = landing_repo_root(conn, trip_id)
        .or_else(|| tripwire.scope.clone())
        .ok_or_else(|| {
            format!(
                "the trip names no repository and tripwire {} has no scope, so there is no \
                 checkout to remove `{dash}` from",
                tripwire.name
            )
        })?;
    tugdash_core::ops::discard_agent_dash_in(std::path::Path::new(&root), dash, Some("tripwire"))
        .map(|_| ())
}

/// The repository a trip's landing happened in, read off the evidence the row
/// carries — the same place the engine reads it from when it sweeps.
fn landing_repo_root(conn: &rusqlite::Connection, trip_id: i64) -> Option<String> {
    let payload = ledger::trip(conn, trip_id).ok().flatten()?.event_payload?;
    let value: serde_json::Value = serde_json::from_str(&payload).ok()?;
    value
        .get("landing")?
        .get("repo_root")?
        .as_str()
        .filter(|root| !root.is_empty())
        .map(str::to_owned)
}

/// Nudge a live instance to re-read a settled trip and republish it. A failure
/// is not the verb's failure: the settle is written either way.
fn tell_live_instance(tripwire: &str) -> bool {
    crate::commands::tell::tell_quietly("tripwire_tell", &[format!("tripwire={tripwire}")]).is_ok()
}

// MARK: - Payloads

/// One tripwire as `--json` reports it — the stored row, field for field, so a
/// preview and a lay can be compared against each other and against the table.
#[derive(Debug, Serialize)]
struct TripwirePayload {
    name: String,
    trigger: String,
    scope: Option<String>,
    probe: Option<String>,
    brief: String,
    model: Option<String>,
    branch: String,
    permission_mode: String,
    paused: bool,
}

impl TripwirePayload {
    fn of(tripwire: &Tripwire) -> Self {
        TripwirePayload {
            name: tripwire.name.clone(),
            trigger: tripwire.trigger.clone(),
            scope: tripwire.scope.clone(),
            probe: tripwire.probe.clone(),
            brief: tripwire.brief.clone(),
            model: tripwire.model.clone(),
            branch: tripwire.branch.clone(),
            permission_mode: tripwire.permission_mode.clone(),
            paused: tripwire.paused,
        }
    }

    /// The same shape for a tripwire that was never written, so a preview and a
    /// lay report identically and a reader can compare them field by field.
    fn preview(tripwire: &NewTripwire) -> Self {
        TripwirePayload {
            name: tripwire.name.clone(),
            trigger: tripwire.trigger.clone(),
            scope: tripwire.scope.clone(),
            probe: tripwire.probe.clone(),
            brief: tripwire.brief.clone(),
            model: tripwire.model.clone(),
            branch: tripwire.branch.clone(),
            permission_mode: tripwire.permission_mode.clone(),
            paused: false,
        }
    }

    fn print(&self, verb: &str) {
        println!("{verb} tripwire {}", self.name);
        println!("  on:       {}", self.trigger);
        println!(
            "  scope:    {}",
            self.scope.as_deref().unwrap_or("(machine-wide)")
        );
        println!("  probe:    {}", self.probe.as_deref().unwrap_or("(none)"));
        println!("  branch:   {}", self.branch);
    }
}

/// What an `edit --preview` would move — only the named columns, because only
/// the named columns move.
#[derive(Debug, Serialize)]
struct EditPreview {
    tripwire: String,
    changes: BTreeMap<String, Option<String>>,
}

impl EditPreview {
    fn of(name: &str, edit: &TripwireEdit) -> Self {
        let mut changes: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut set = |k: &str, v: Option<String>| {
            changes.insert(k.to_string(), v);
        };
        if let Some(v) = &edit.trigger {
            set("trigger", Some(v.clone()));
        }
        if let Some(v) = &edit.scope {
            set("scope", v.clone());
        }
        if let Some(v) = &edit.probe {
            set("probe", v.clone());
        }
        if let Some(v) = &edit.brief {
            set("brief", Some(v.clone()));
        }
        if let Some(v) = &edit.model {
            set("model", v.clone());
        }
        if let Some(v) = &edit.branch {
            set("branch", Some(v.clone()));
        }
        if let Some(v) = &edit.permission_mode {
            set("permission_mode", Some(v.clone()));
        }
        EditPreview {
            tripwire: name.to_string(),
            changes,
        }
    }

    fn print(&self) {
        println!("would edit tripwire {}", self.tripwire);
        if self.changes.is_empty() {
            println!("  (nothing named — every column left alone)");
        }
        for (column, value) in &self.changes {
            println!("  {column}: {}", value.as_deref().unwrap_or("(cleared)"));
        }
    }
}

#[derive(Debug, Serialize)]
struct RemovedPayload {
    tripwire: String,
    removed: bool,
}

#[derive(Debug, Serialize)]
struct TripQueuedPayload {
    tripwire: String,
    trip_id: i64,
    event_key: String,
    status: String,
    /// Whether a live instance took the nudge. `false` means the row waits.
    served: bool,
}

/// A resolution as `--json` reports it — what was written and whether anybody
/// was told, which are two different facts and only the first is durable.
#[derive(Debug, Serialize)]
struct ResolvedPayload {
    tripwire: String,
    trip_id: i64,
    status: String,
    headline: Option<String>,
    author: Option<String>,
    told: bool,
}

/// A dismissal as `--json` reports it. `discarded` is separate from `dash`
/// because a dash that could not be removed is a fact worth reading.
#[derive(Debug, Serialize)]
struct DismissedPayload {
    tripwire: String,
    trip_id: i64,
    dash: Option<String>,
    discarded: bool,
    /// Why the dash it was holding is still standing, when it is. The settle
    /// happens either way, so the failure has to be reportable rather than
    /// inferred from `discarded: false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    discard_error: Option<String>,
    told: bool,
}

/// One trip as `tripwire log --json` reports it — the full workings, because the
/// log is the record and a reader asking why a tripwire did nothing is asking
/// about a row it would otherwise have to guess at.
#[derive(Debug, Serialize)]
struct TripPayload {
    id: i64,
    event_key: String,
    at_ms: i64,
    instance: String,
    status: String,
    swallow_reason: Option<String>,
    probe_exit: Option<i64>,
    session_id: Option<String>,
    dash: Option<String>,
    headline: Option<String>,
    settled_at_ms: Option<i64>,
}

impl TripPayload {
    fn of(trip: &ledger::Trip) -> Self {
        TripPayload {
            id: trip.id,
            event_key: trip.event_key.clone(),
            at_ms: trip.at_ms,
            instance: trip.instance.clone(),
            status: trip.status.clone(),
            swallow_reason: trip.swallow_reason.clone(),
            probe_exit: trip.probe_exit,
            session_id: trip.session_id.clone(),
            dash: trip.dash.clone(),
            headline: trip.headline.clone(),
            settled_at_ms: trip.settled_at_ms,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Which instance wrote a row. The CLI is not an instance, so a hand-fired
/// trip says so rather than borrowing an id it does not own.
fn instance_label() -> String {
    match std::env::var("TUG_INSTANCE_ID") {
        Ok(id) if !id.is_empty() => format!("cli:{id}"),
        _ => "cli".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compiled(on: &str, clauses: &[&str]) -> String {
        let clauses: Vec<String> = clauses.iter().map(|c| (*c).to_string()).collect();
        serde_json::to_string(&compile_trigger(on, &clauses).expect("compiles")).unwrap()
    }

    #[test]
    fn the_cli_spelling_compiles_to_the_stored_json() {
        assert_eq!(
            compiled("fact:edit_failed", &[]),
            r#"{"fact":{"kind":"edit_failed"}}"#
        );
        assert_eq!(
            compiled(
                "fact:shell",
                &["route=claude", "command~=file edit", "cwd^=/proj"]
            ),
            r#"{"fact":{"kind":"shell","where":{"command":{"contains":"file edit"},"cwd":{"prefix":"/proj"},"route":"claude"}}}"#
        );
    }

    /// The first `=` is the operator, and the character before it says which
    /// one — otherwise a value containing `~=` renames the field.
    #[test]
    fn the_first_equals_is_the_operator_and_its_neighbour_says_which() {
        assert_eq!(
            compiled("fact:x", &["f~=a=b"]),
            r#"{"fact":{"kind":"x","where":{"f":{"contains":"a=b"}}}}"#
        );
        assert_eq!(
            compiled("fact:x", &["f^=a=b"]),
            r#"{"fact":{"kind":"x","where":{"f":{"prefix":"a=b"}}}}"#
        );
        assert_eq!(
            compiled("fact:x", &["f=a~=b"]),
            r#"{"fact":{"kind":"x","where":{"f":"a~=b"}}}"#,
            "a bare = earlier than a ~= is still the exact match"
        );
    }

    #[test]
    fn a_bad_spelling_refuses_and_names_the_token() {
        let err = |on: &str, clauses: &[&str]| {
            let clauses: Vec<String> = clauses.iter().map(|c| (*c).to_string()).collect();
            compile_trigger(on, &clauses).expect_err("refuses")
        };
        assert!(err("factt:x", &[]).contains("factt"));
        assert!(err("fact", &[]).contains("names its kind"));
        assert!(err("fact:", &[]).contains("names its kind"));
        assert!(err("fact:x", &["nonsense"]).contains("nonsense"));
        assert!(err("fact:x", &["=v"]).contains("names no field"));
        assert!(
            err("fact:x", &["f=1", "f=2"]).contains("twice"),
            "one matcher per field in v1, and a silent overwrite would hide the second"
        );
        assert!(
            err("commit:main", &[]).contains("--branch"),
            "a v1 commit spelling is steered at the column that replaced it"
        );
    }

    #[test]
    fn a_named_branch_wins_and_an_unresolvable_one_refuses() {
        assert_eq!(resolve_branch(Some("release"), None).unwrap(), "release");
        assert_eq!(
            resolve_branch(Some("  release  "), None).unwrap(),
            "release",
            "the stored branch is the trimmed one"
        );
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().display().to_string();
        let refusal = resolve_branch(None, Some(&outside)).unwrap_err();
        assert!(refusal.contains("no --branch given"), "{refusal}");
    }

    #[test]
    fn a_brief_reads_from_a_file_when_it_is_spelled_with_an_at() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("brief.md");
        std::fs::write(&path, "diagnose the failure\n").unwrap();
        assert_eq!(
            read_brief(&format!("@{}", path.display())).unwrap(),
            "diagnose the failure\n"
        );
        assert_eq!(read_brief("inline text").unwrap(), "inline text");
        assert!(read_brief("@/nonexistent/brief.md").is_err());
    }

    /// A dash worktree is not its base checkout, and folding it into one would
    /// make a work-tier tripwire re-trip on its own commits.
    #[test]
    fn a_scope_is_canonicalized_and_never_folded_to_a_base_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().canonicalize().unwrap();
        let nested = real.join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        let dotted = format!("{}/a/./b", real.display());
        assert_eq!(canonical_scope(&dotted), nested.display().to_string());
        assert_eq!(
            canonical_scope("/no/such/path"),
            "/no/such/path",
            "a path that cannot be canonicalized keeps its literal form"
        );
    }

    /// The resolution verb's grammar, refused before the ledger is ever opened
    /// (Spec S02).
    ///
    /// Both refusals matter to a session rather than to a person: the session
    /// reads the message and tries again, so each one has to say which of the
    /// two resolutions was missing rather than that something was wrong.
    #[test]
    fn a_resolution_names_which_one_it_is_and_an_awaiting_one_carries_a_headline() {
        let neither = run_resolve("ci", false, false, None, None, false, true).unwrap_err();
        assert!(
            neither.contains("--quiet") && neither.contains("--awaiting"),
            "{neither}"
        );

        let both = run_resolve("ci", true, true, Some("h"), None, false, true).unwrap_err();
        assert!(
            both.contains("--quiet") && both.contains("--awaiting"),
            "{both}"
        );

        let headless = run_resolve("ci", false, true, None, None, false, true).unwrap_err();
        assert!(headless.contains("--headline"), "{headless}");

        let blank = run_resolve("ci", false, true, Some(""), None, false, true).unwrap_err();
        assert!(blank.contains("--headline"), "{blank}");
    }
}
