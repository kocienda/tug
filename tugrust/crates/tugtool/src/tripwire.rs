//! Tripwires — standing watchers (`tugtool tripwire …`). A thin shell over
//! [`tugtool_core::tripwire_ledger`]: compile the command line's trigger spelling
//! to Spec S01 JSON, call the typed ledger API, and format the outcome as
//! `--json` (the shared JSON shape) or a plain human read-out.
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

use tugarc_core::tripwire_remove::RemoveRefusal;
use tugcore::facts::FactKind;
use tugtool_core::tripwire_ledger::{
    self as ledger, NewTripwire, Tripwire, TripwireEdit, TripwireLedgerError, tripwire_arc,
};
use tugtool_core::tripwire_predicate::{FactTrigger, Matcher, Predicate};
use tugtool_core::tripwire_roster;

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
            scope,
            probe,
            brief,
            description,
            model,
            permission_mode,
            max_seconds,
            max_tool_calls,
            preview,
        } => run_lay(
            LayArgs {
                name,
                on,
                clauses,
                scope,
                probe,
                brief,
                description,
                model,
                permission_mode,
                max_seconds,
                max_tool_calls,
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
            probe,
            brief,
            description,
            model,
            permission_mode,
            max_seconds,
            max_tool_calls,
            clear,
            preview,
        } => run_edit(
            EditArgs {
                name,
                on,
                clauses,
                scope,
                probe,
                brief,
                description,
                model,
                permission_mode,
                max_seconds,
                max_tool_calls,
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
                format!(
                    "a fact trigger names its kind: --on fact:<kind>, one of {}",
                    FactKind::all_spelled()
                )
            })?;
            if FactKind::parse(kind).is_none() {
                return Err(format!(
                    "`{kind}` is not a fact kind the ledger records — a tripwire watches one of {}",
                    FactKind::all_spelled()
                ));
            }
            let r#where = compile_clauses(clauses)?;
            Ok(Predicate::Fact(FactTrigger {
                kind: kind.to_string(),
                r#where,
            }))
        }
        "commit" => Err(
            "a tripwire watches a fact, not a source of its own: a commit is the `commit` fact, \
             so say --on fact:commit (and --where branch=main to narrow it to one branch)"
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

/// A scope as the engine will compare it ([P12]): in the Claude form the
/// canonicalization gateway produces ([L29]), because the fact's `repo_root`
/// is the deck's project dir in that same form and the scope is a prefix
/// compared against it. A bare `canonicalize` would store the
/// `/System/Volumes/Data/…` spelling and the prefix guard would put every
/// fact out of scope. Deliberately **not** folded to its base checkout —
/// a trip commits on the tripwire's own arc worktree, and folding worktrees
/// into their base would make those commits re-trip the tripwire that made
/// them. A path that does not exist keeps its literal form rather than failing
/// the lay.
fn canonical_scope(scope: &str) -> String {
    tugcore::pathform::resolve_to_claude_form(std::path::Path::new(scope))
        .display()
        .to_string()
}

/// The checkout a tripwire's arc lives in ([P02]).
///
/// `--scope` first, because a scoped tripwire has already said which part of
/// which project it watches, and the arc belongs beside the work rather than
/// beside whichever shell laid it. The scope may name a directory anywhere
/// inside a checkout, so the walk goes upward until a repository answers.
/// Unscoped, the `lay` process's own cwd is the only thing that knows which
/// project the user means.
///
/// The refusal names both attempts, because a tripwire laid from the wrong
/// directory and one laid with an unusable scope are different mistakes and
/// only the sentence can tell them apart.
fn home_checkout(scope: Option<&str>) -> Result<std::path::PathBuf, String> {
    if let Some(scope) = scope {
        if let Some(root) = repo_root_at_or_above(std::path::Path::new(scope)) {
            return Ok(root);
        }
    }
    let cwd = std::env::current_dir()
        .map_err(|e| format!("this shell's directory could not be read: {e}"))?;
    if let Some(root) = repo_root_at_or_above(&cwd) {
        return Ok(root);
    }
    Err(match scope {
        Some(scope) => format!(
            "a tripwire's arc needs a checkout to live in, and neither answered: \
             --scope `{scope}` is in no repository, and `{}` is not in one either",
            cwd.display()
        ),
        None => format!(
            "a tripwire's arc needs a checkout to live in: `{}` is not in one, \
             and no --scope named another",
            cwd.display()
        ),
    })
}

/// The repository `start` is in, walking upward until one answers.
///
/// `find_repo_root_from` asks about one directory, and both the scope and the
/// shell's cwd are ordinarily somewhere *inside* a checkout rather than at its
/// root.
fn repo_root_at_or_above(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let start = std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
    let mut at = start.as_path();
    loop {
        if let Ok(root) = tugtool_core::worktree::find_repo_root_from(at) {
            return Some(root);
        }
        at = at.parent()?;
    }
}

fn open() -> Result<rusqlite::Connection, String> {
    ledger::open().map_err(|e| e.to_string())
}

// MARK: - lay

struct LayArgs {
    name: String,
    on: String,
    clauses: Vec<String>,
    scope: Option<String>,
    probe: Option<String>,
    brief: String,
    description: String,
    model: Option<String>,
    permission_mode: Option<String>,
    max_seconds: Option<i64>,
    max_tool_calls: Option<i64>,
}

/// A cap is a ceiling, so it has to be a number a session can run up against.
///
/// Zero and below are refused rather than stored: a tripwire capped at zero
/// seconds is one whose every trip fails the instant it starts, which reads on
/// the card as a broken facility rather than as the setting somebody typed.
/// There is no spelling here for "no ceiling" on purpose ([P06]).
fn check_cap(flag: &str, value: i64) -> Result<i64, String> {
    if value <= 0 {
        return Err(format!(
            "{flag} is {value}; a cap is a ceiling a trip runs up against, so it has to be above zero"
        ));
    }
    Ok(value)
}

fn run_lay(args: LayArgs, preview: bool, json: bool, quiet: bool) -> Result<(), String> {
    let predicate = compile_trigger(&args.on, &args.clauses)?;
    let trigger = serde_json::to_string(&predicate).map_err(|e| e.to_string())?;
    let scope = args.scope.as_deref().map(canonical_scope);

    let mut tripwire = NewTripwire::new(
        &args.name,
        &trigger,
        read_brief(&args.brief)?,
        args.description.trim(),
    );
    tripwire.scope = scope;
    tripwire.probe = args.probe;
    tripwire.model = args.model;
    if let Some(mode) = args.permission_mode {
        tripwire.permission_mode = mode;
    }
    if let Some(seconds) = args.max_seconds {
        tripwire.max_seconds = check_cap("--max-seconds", seconds)?;
    }
    if let Some(calls) = args.max_tool_calls {
        tripwire.max_tool_calls = check_cap("--max-tool-calls", calls)?;
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
    ledger::check_description(&tripwire.name, &tripwire.description).map_err(|e| e.to_string())?;
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
    // The arc needs git, and this is where `lay` acquires that dependency.
    // The one implementation, never a bare `git --version` ([D171]).
    if let Some(refusal) = tugcore::host_tools::refusal(&tugcore::host_tools::probe()) {
        return Err(refusal);
    }
    let repo_root = home_checkout(tripwire.scope.as_deref())?;
    tripwire.repo_root = repo_root.display().to_string();

    let laid = ledger::lay(&conn, &tripwire, now_ms()).map_err(|e| e.to_string())?;

    // After the row, so a tripwire that could not be laid leaves no worktree
    // behind — and before the report, so what it says is true.
    let arc = tripwire_arc(&laid.name);
    tugarc_core::ops::create_in(
        &repo_root,
        &arc,
        Some(format!("tripwire {}", laid.name)),
        false,
        None,
    )?;
    tugarc_core::ops::set_laid_by(&repo_root, &arc, &format!("tripwire/{}", laid.name));

    let payload = TripwirePayload::of(&laid);
    bump_live_instance();
    if json {
        print_ok("tripwire lay", &payload);
    } else if !quiet {
        payload.print("laid");
        // The hydration a project declares in `[tugtool.arc].post_create` runs
        // inside `create_in`, and in this project that is three `bun install`s.
        // A user watching `lay` sit there for half a minute is owed the reason.
        println!(
            "arc {arc} created in {} (post_create ran)",
            repo_root.display()
        );
    }
    Ok(())
}

// MARK: - list / edit / rm / pause

fn run_list(json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    // The roster rather than the bare rows: the CLI reads the same projection
    // the card and the `TRIPWIRES` feed read, so "is it running" has one
    // answer wherever it is asked — and this verb has to work with the app
    // closed, which is why the projection is a library function.
    let payload = tripwire_roster::roster(&conn, tugarc_core::ops::worktree_path)
        .map_err(|e| e.to_string())?;
    if json {
        print_ok("tripwire list", &payload);
    } else if !quiet {
        if payload.is_empty() {
            println!("no tripwires laid");
        }
        for tripwire in &payload {
            println!(
                "{}{}  {}{}{}",
                tripwire.name,
                if tripwire.paused { " (paused)" } else { "" },
                tripwire.trigger,
                tripwire
                    .scope
                    .as_deref()
                    .map(|s| format!("  scope={s}"))
                    .unwrap_or_default(),
                if tripwire.running { " running" } else { "" },
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
    probe: Option<String>,
    brief: Option<String>,
    description: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    max_seconds: Option<i64>,
    max_tool_calls: Option<i64>,
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
    // Checked here as well as in the ledger, so a `--preview` that would be
    // refused says so rather than echoing a change that cannot happen — the
    // same reason the brief is checked before the preview branch in `lay`.
    if let Some(description) = &args.description {
        let text = description.trim().to_string();
        ledger::check_description(&args.name, &text).map_err(|e| e.to_string())?;
        edit.description = Some(text);
    }
    if let Some(model) = args.model {
        edit.model = Some(Some(model));
    }
    if let Some(mode) = args.permission_mode {
        edit.permission_mode = Some(mode);
    }
    if let Some(seconds) = args.max_seconds {
        edit.max_seconds = Some(check_cap("--max-seconds", seconds)?);
    }
    if let Some(calls) = args.max_tool_calls {
        edit.max_tool_calls = Some(check_cap("--max-tool-calls", calls)?);
    }
    for column in &args.clear {
        match column.as_str() {
            "scope" => edit.scope = Some(None),
            "probe" => edit.probe = Some(None),
            "model" => edit.model = Some(None),
            other => {
                return Err(format!(
                    "`{other}` is not a clearable column — scope, probe, or model. A description is not among them: it is the line the Tripwires card leads with, so a tripwire that lost it would be one the rail cannot name."
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
    bump_live_instance();
    if json {
        print_ok("tripwire edit", &payload);
    } else if !quiet {
        payload.print("edited");
    }
    Ok(())
}

/// Remove a tripwire through the operation the card removes through ([B07]).
///
/// Not `ledger::remove` directly: the rule that a running trip refuses the
/// removal, and that the tripwire's own arc is discarded rather than orphaned
/// by the cascade, has to be the same rule at both doors, and
/// `tugarc_core::tripwire_remove` is where it lives once.
fn run_rm(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;
    let removed = match tugarc_core::tripwire_remove::remove(&conn, &tripwire) {
        Ok(removed) => removed,
        Err(RemoveRefusal::TripRunning) => {
            return Err(format!(
                "tripwire {name} has a trip running, so it cannot be removed — a session is working in the tripwire's arc worktree. Open it or wait for it to settle, then remove the tripwire."
            ));
        }
        Err(RemoveRefusal::Ledger(e)) => return Err(e.to_string()),
    };
    let payload = RemovedPayload {
        tripwire: name.to_string(),
        removed: true,
        arc: removed.arc.clone(),
        discarded: removed.discarded,
        discard_error: removed.discard_error.clone(),
    };
    bump_live_instance();
    if json {
        print_ok("tripwire rm", &payload);
    } else if !quiet {
        println!("removed tripwire {name} and its trip log");
        match (&removed.arc, &removed.discard_error) {
            (Some(arc), None) if removed.discarded => println!("  discarded arc {arc}"),
            (Some(arc), Some(why)) => println!("  arc {arc} is still standing: {why}"),
            (Some(arc), None) => println!("  arc {arc} is still standing"),
            (None, _) => {}
        }
    }
    Ok(())
}

fn run_paused(name: &str, paused: bool, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::set_paused(&conn, name, paused).map_err(|e| e.to_string())?;
    let payload = TripwirePayload::of(&tripwire);
    bump_live_instance();
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
            // The skipped firings print too. A tripwire that skipped a hundred
            // and a tripwire that never saw one look identical from outside, and
            // only one of them is working.
            println!(
                "{}  {}  {}{}{}{}{}",
                trip.at_ms,
                trip.status,
                trip.event_key,
                trip.reason
                    .as_deref()
                    .map(|r| format!("  ({r})"))
                    .unwrap_or_default(),
                trip.headline
                    .as_deref()
                    .map(|h| format!("  {h}"))
                    .unwrap_or_default(),
                // The report is what the trip amounted to ([P04]), so it
                // prints beside the row rather than only in `--json`.
                trip.report
                    .as_deref()
                    .filter(|r| !r.trim().is_empty())
                    .map(|r| format!("  {r}"))
                    .unwrap_or_default(),
                trip.rounds
                    .filter(|r| *r > 0)
                    .map(|r| format!("  ({r} round{})", if r == 1 { "" } else { "s" }))
                    .unwrap_or_default(),
            );
        }
    }
    Ok(())
}

/// Fire a tripwire by hand.
///
/// This verb writes no row ([P08]). With no queue there is nothing a later
/// engine could pick up, so a row written here would be one nobody would ever
/// see fire — the engine on a live instance is the only thing that can mint
/// one, and with no live instance the firing is refused rather than deferred.
///
/// The refusal has two forms and the instance decides which: no engine at all,
/// or a tripwire with no `--scope` for a hand-fired trip to stand in. The
/// message the API returns is printed verbatim rather than guessed at here.
fn run_trip(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let _tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;

    let served = fire_on_live_instance(name)?;
    let payload = TripFiredPayload {
        tripwire: name.to_string(),
        status: "running".to_string(),
        served,
    };
    if json {
        print_ok("tripwire trip", &payload);
    } else if !quiet {
        println!("tripwire {name} fired; a live instance is running its trip");
    }
    bump_live_instance();
    Ok(())
}

/// Ask the live instance to fire the tripwire, and hand back its refusal when
/// it has one.
///
/// The HTTP route rather than the `tell` door, because a tell is
/// fire-and-forget and this verb has an answer to report: the engine is what
/// mints the row, and "it did not happen, and here is why" is the whole of
/// what the user needs.
fn fire_on_live_instance(tripwire: &str) -> Result<bool, String> {
    let port = crate::commands::tell::resolve_port(None, None).map_err(|_| {
        format!("tripwire {tripwire} cannot be fired: no Tug instance is running to fire it in")
    })?;
    let response = ureq::post(&format!(
        "http://127.0.0.1:{port}/api/tripwires/{tripwire}/trip"
    ))
    .send_empty()
    .map_err(|_| {
        format!("tripwire {tripwire} cannot be fired: no Tug instance is running to fire it in")
    })?;
    let status = response.status().as_u16();
    if status == 200 {
        return Ok(true);
    }
    // The instance's own sentence, which is the one that knows which refusal
    // this is — a missing scope and a missing engine are different problems
    // and send the user to different places.
    let body: serde_json::Value = response
        .into_body()
        .read_json()
        .unwrap_or(serde_json::Value::Null);
    Err(body
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("tripwire {tripwire} could not be fired (status {status})")))
}

/// Nudge a live instance that the roster moved, so the Tripwires card
/// recomposes now rather than on its next ledger probe.
///
/// Carries no payload on purpose: it says the roster moved, not which
/// tripwire moved. The result is ignored everywhere it is called — the ledger
/// write is the act, this is latency, and no instance running is the ordinary
/// case for a machine with the app closed.
fn bump_live_instance() {
    let _ = crate::commands::tell::tell_quietly("tripwire_bump", &[]);
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
    description: String,
    model: Option<String>,
    permission_mode: String,
    paused: bool,
    /// The checkout the tripwire's arc lives in ([P02]). Empty on a preview,
    /// which resolves nothing and creates nothing.
    repo_root: String,
    /// The two caps a trip of it runs under ([P06]).
    max_seconds: i64,
    max_tool_calls: i64,
}

impl TripwirePayload {
    fn of(tripwire: &Tripwire) -> Self {
        TripwirePayload {
            name: tripwire.name.clone(),
            trigger: tripwire.trigger.clone(),
            scope: tripwire.scope.clone(),
            probe: tripwire.probe.clone(),
            brief: tripwire.brief.clone(),
            description: tripwire.description.clone(),
            model: tripwire.model.clone(),
            permission_mode: tripwire.permission_mode.clone(),
            paused: tripwire.paused,
            repo_root: tripwire.repo_root.clone(),
            max_seconds: tripwire.max_seconds,
            max_tool_calls: tripwire.max_tool_calls,
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
            description: tripwire.description.clone(),
            model: tripwire.model.clone(),
            permission_mode: tripwire.permission_mode.clone(),
            paused: false,
            repo_root: tripwire.repo_root.clone(),
            max_seconds: tripwire.max_seconds,
            max_tool_calls: tripwire.max_tool_calls,
        }
    }

    fn print(&self, verb: &str) {
        println!("{verb} tripwire {}", self.name);
        println!("  what:     {}", self.description);
        println!("  on:       {}", self.trigger);
        println!(
            "  scope:    {}",
            self.scope.as_deref().unwrap_or("(machine-wide)")
        );
        println!("  probe:    {}", self.probe.as_deref().unwrap_or("(none)"));
        println!(
            "  caps:     {}s, {} tool calls",
            self.max_seconds, self.max_tool_calls
        );
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
        if let Some(v) = &edit.description {
            set("description", Some(v.clone()));
        }
        if let Some(v) = &edit.model {
            set("model", v.clone());
        }
        if let Some(v) = &edit.permission_mode {
            set("permission_mode", Some(v.clone()));
        }
        if let Some(v) = edit.max_seconds {
            set("max_seconds", Some(v.to_string()));
        }
        if let Some(v) = edit.max_tool_calls {
            set("max_tool_calls", Some(v.to_string()));
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
    /// The arc a finished run was holding, discarded on the way out rather
    /// than orphaned by the cascade.
    arc: Option<String>,
    discarded: bool,
    discard_error: Option<String>,
}

#[derive(Debug, Serialize)]
struct TripFiredPayload {
    tripwire: String,
    status: String,
    /// Always true: a firing that was not served is a refusal, and this verb
    /// errors rather than reporting one.
    served: bool,
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
    reason: Option<String>,
    repo_root: Option<String>,
    probe_exit: Option<i64>,
    session_id: Option<String>,
    arc: Option<String>,
    headline: Option<String>,
    settled_at_ms: Option<i64>,
    /// The session's last words ([P04]) and what it committed. Both `None` on
    /// a trip that ran no session, and on any trip taken before v11.
    report: Option<String>,
    rounds: Option<i64>,
}

impl TripPayload {
    fn of(trip: &ledger::Trip) -> Self {
        TripPayload {
            id: trip.id,
            event_key: trip.event_key.clone(),
            at_ms: trip.at_ms,
            instance: trip.instance.clone(),
            status: trip.status.clone(),
            reason: trip.reason.clone(),
            repo_root: trip.repo_root.clone(),
            probe_exit: trip.probe_exit,
            session_id: trip.session_id.clone(),
            arc: trip.arc.clone(),
            headline: trip.headline.clone(),
            settled_at_ms: trip.settled_at_ms,
            report: trip.report.clone(),
            rounds: trip.rounds,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
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
            compiled("fact:shell", &["f~=a=b"]),
            r#"{"fact":{"kind":"shell","where":{"f":{"contains":"a=b"}}}}"#
        );
        assert_eq!(
            compiled("fact:shell", &["f^=a=b"]),
            r#"{"fact":{"kind":"shell","where":{"f":{"prefix":"a=b"}}}}"#
        );
        assert_eq!(
            compiled("fact:shell", &["f=a~=b"]),
            r#"{"fact":{"kind":"shell","where":{"f":"a~=b"}}}"#,
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
        let unknown = err("fact:not_a_kind", &[]);
        assert!(unknown.contains("not_a_kind"), "{unknown}");
        assert!(
            unknown.contains("shell") && unknown.contains("edit_failed"),
            "a refusal names the kinds that would have been accepted: {unknown}"
        );
        assert!(err("fact:shell", &["nonsense"]).contains("nonsense"));
        assert!(err("fact:shell", &["=v"]).contains("names no field"));
        assert!(
            err("fact:shell", &["f=1", "f=2"]).contains("twice"),
            "one matcher per field in v1, and a silent overwrite would hide the second"
        );
        assert!(
            err("commit:main", &[]).contains("fact:commit"),
            "a v1 commit spelling is steered at the fact that replaced it"
        );
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

    /// An arc worktree is not its base checkout, and folding it into one would
    /// make a tripwire re-trip on its own commits.
    #[test]
    fn a_scope_is_canonicalized_and_never_folded_to_a_base_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let real = tugcore::pathform::resolve_to_claude_form(dir.path());
        let nested = real.join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        let dotted = format!("{}/a/./b", real.display());
        assert_eq!(canonical_scope(&dotted), nested.display().to_string());
        assert_eq!(
            canonical_scope("/no/such/path"),
            "/no/such/path",
            "a path that does not exist keeps its literal form"
        );
    }

    /// [L29]: the stored scope is the Claude form, never the data-volume
    /// spelling `realpath(3)` expands to, because the checkout it is compared
    /// against arrives in the Claude form.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_scope_never_stores_the_data_volume_spelling() {
        let home = std::env::var("HOME").unwrap();
        if !home.starts_with("/Users/") {
            return;
        }
        let stored = canonical_scope(&format!("/System/Volumes/Data{home}"));
        assert!(
            !stored.starts_with("/System/Volumes/Data/"),
            "stored {stored}, which is the spelling no fact ever carries"
        );
    }
}
