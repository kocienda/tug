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

use tugarc_core::tripwire_dismiss::DismissRefusal;
use tugarc_core::tripwire_remove::RemoveRefusal;
use tugcore::facts::FactKind;
use tugtool_core::tripwire_ledger::{
    self as ledger, NewTripwire, Resolution, Settlement, TripStatus, Tripwire, TripwireEdit,
    TripwireLedgerError,
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
/// an authoring trip commits on its own arc worktree, and folding worktrees
/// into their base would make those commits re-trip the tripwire that made
/// them. A path that does not exist keeps its literal form rather than failing
/// the lay.
fn canonical_scope(scope: &str) -> String {
    tugcore::pathform::resolve_to_claude_form(std::path::Path::new(scope))
        .display()
        .to_string()
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
    let laid = ledger::lay(&conn, &tripwire, now_ms()).map_err(|e| e.to_string())?;
    let payload = TripwirePayload::of(&laid);
    bump_live_instance();
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
    // The roster rather than the bare rows: the CLI reads the same projection
    // the card and the `TRIPWIRES` feed read, so "is it running" has one
    // answer wherever it is asked — and this verb has to work with the app
    // closed, which is why the projection is a library function.
    let payload = tripwire_roster::roster(&conn).map_err(|e| e.to_string())?;
    if json {
        print_ok("tripwire list", &payload);
    } else if !quiet {
        if payload.is_empty() {
            println!("no tripwires laid");
        }
        for tripwire in &payload {
            println!(
                "{}{}  {}{}{}{}{}",
                tripwire.name,
                if tripwire.paused { " (paused)" } else { "" },
                tripwire.trigger,
                tripwire
                    .scope
                    .as_deref()
                    .map(|s| format!("  scope={s}"))
                    .unwrap_or_default(),
                if tripwire.running { " running" } else { "" },
                if tripwire.awaiting { " awaiting" } else { "" },
                if tripwire.adopted { " adopted" } else { "" },
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
/// removal, and that an awaiting or adopted trip's arc is discarded rather
/// than orphaned by the cascade, has to be the same rule at both doors, and
/// `tugarc_core::tripwire_remove` is where it lives once.
fn run_rm(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;
    let removed = match tugarc_core::tripwire_remove::remove(&conn, &tripwire, now_ms()) {
        Ok(removed) => removed,
        Err(RemoveRefusal::TripRunning) => {
            return Err(format!(
                "tripwire {name} has a trip running, so it cannot be removed — a headless session is working in an inspection tree. Open it or wait for it to settle, then remove the tripwire."
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
                "{}  {}  {}{}{}",
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

/// Settle the tripwire's running trip (Spec S02) — the only settle a live session
/// has, and the whole of what replaced the prose scraper.
///
/// The ledger write is the resolution and the tell is a nudge, in that order
/// for the same reason `trip` orders them that way: the row is what the Tripwires
/// card eventually reads, and no instance running is the ordinary case for a
/// machine with the app closed. What the tell buys is the card repainting now
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
                "--awaiting needs --headline: the headline is the one line the Tripwires row shows, \
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
        TripStatus::Quiet
    };
    let settlement = Settlement {
        headline: headline.map(str::to_owned),
        ..Settlement::default()
    };
    // The running trip first, so a genuinely running one wins over an older
    // adopted one; a session a card took over can still run this verb, and
    // resolving from `adopted` is how its trip settles.
    let mut resolution =
        ledger::resolve_running(&conn, tripwire.id, status, &settlement, author, now_ms())
            .map_err(|e| e.to_string())?;
    if matches!(resolution, Resolution::NoLiveTrip { .. }) {
        resolution =
            ledger::resolve_adopted(&conn, tripwire.id, status, &settlement, author, now_ms())
                .map_err(|e| e.to_string())?;
    }
    let Resolution::Resolved { trip_id, .. } = resolution else {
        let Resolution::NoLiveTrip { state } = resolution else {
            unreachable!("a resolution is one of two things")
        };
        return Err(match state {
            Some(state) => format!(
                "tripwire {name} has no running or adopted trip to resolve — its newest trip is {state}"
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
    // A settle changes the roster, and `tripwire_tell` reaches the engine's
    // republish rather than the roster feed.
    bump_live_instance();
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

/// Settle an awaiting trip by hand and discard the arc it was holding
/// ([P07], [P09]).
///
/// The discard is the dismissal's other half rather than a courtesy: an
/// awaiting trip holds an arc the user is being asked about, and settling the
/// row while leaving the worktree standing is exactly the leak this rebuild
/// exists to close.
fn run_dismiss(name: &str, json: bool, quiet: bool) -> Result<(), String> {
    let conn = open()?;
    let tripwire = ledger::get(&conn, name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| TripwireLedgerError::NoSuchTripwire(name.to_string()).to_string())?;
    // The refusal's two shapes are what the CLI turns into its two sentences:
    // a tripwire that already settled and one that never fired want different
    // words, and a caller told only "refused" could not tell them apart.
    let dismissed = match tugarc_core::tripwire_dismiss::dismiss(&conn, &tripwire, now_ms()) {
        Ok(dismissed) => dismissed,
        Err(DismissRefusal::Ledger(e)) => return Err(e.to_string()),
        Err(DismissRefusal::NoLiveTrip { state }) => {
            return Err(match state {
                Some(state) => format!(
                    "tripwire {name} has no awaiting or adopted trip to dismiss — its newest trip is {state}"
                ),
                None => format!("tripwire {name} has never fired, so there is nothing to dismiss"),
            });
        }
    };
    let trip_id = dismissed.trip_id;
    let discard_error = dismissed.discard_error.clone();
    let payload = DismissedPayload {
        tripwire: name.to_string(),
        trip_id,
        arc: dismissed.arc,
        discarded: dismissed.discarded,
        discard_error: discard_error.clone(),
        told: tell_live_instance(name),
    };
    bump_live_instance();
    if json {
        print_ok("tripwire dismiss", &payload);
    } else if !quiet {
        println!("tripwire {name} dismissed trip {trip_id}");
    }
    // The settle is written whatever happened next, so a discard that could
    // not run is reported rather than hidden: an arc left standing is the
    // leak this verb exists to close, and silence about it is how nobody
    // finds out.
    if let Some(e) = discard_error {
        eprintln!("tripwire {name}: the arc it was holding was not discarded — {e}");
    }
    Ok(())
}

/// Nudge a live instance to re-read a settled trip and republish it. A failure
/// is not the verb's failure: the settle is written either way.
fn tell_live_instance(tripwire: &str) -> bool {
    crate::commands::tell::tell_quietly("tripwire_tell", &[format!("tripwire={tripwire}")]).is_ok()
}

/// Nudge a live instance that the roster moved, so the Tripwires card
/// recomposes now rather than on its next ledger probe.
///
/// Carries no payload on purpose: it says the roster moved, not which
/// tripwire moved. Distinct from [`tell_live_instance`], which reaches the
/// engine's republish of one settled trip rather than the roster feed. The
/// result is ignored everywhere it is called — the ledger write is the act,
/// this is latency, and no instance running is the ordinary case for a
/// machine with the app closed.
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

/// A dismissal as `--json` reports it. `discarded` is separate from `arc`
/// because an arc that could not be removed is a fact worth reading.
#[derive(Debug, Serialize)]
struct DismissedPayload {
    tripwire: String,
    trip_id: i64,
    #[serde(rename = "arc")]
    arc: Option<String>,
    discarded: bool,
    /// Why the arc it was holding is still standing, when it is. The settle
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
    reason: Option<String>,
    repo_root: Option<String>,
    head_sha: Option<String>,
    probe_exit: Option<i64>,
    session_id: Option<String>,
    arc: Option<String>,
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
            reason: trip.reason.clone(),
            repo_root: trip.repo_root.clone(),
            head_sha: trip.head_sha.clone(),
            probe_exit: trip.probe_exit,
            session_id: trip.session_id.clone(),
            arc: trip.arc.clone(),
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

    /// `dismiss` moved its body into `tugarc_core::tripwire_dismiss`, so what
    /// this pins is that the verb still does what it did: settles the awaiting
    /// row, and refuses with prose that tells an already-settled tripwire from
    /// one that never fired.
    #[serial_test::serial]
    #[test]
    fn dismiss_settles_the_awaiting_row_and_keeps_its_two_refusals_apart() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("tripwires.db");
        // SAFETY: serial test; nothing else reads the variable concurrently.
        unsafe { std::env::set_var("TUG_TRIPWIRES_DB", &db) };

        let conn = ledger::open_ledger(&db).unwrap();
        let tripwire = ledger::lay(
            &conn,
            &NewTripwire::new(
                "ci",
                r#"{"fact":{"kind":"edit_failed"}}"#,
                "report anything that looks wrong",
                "Reports anything that looks wrong on main",
            ),
            1,
        )
        .unwrap();

        let refusal = run_dismiss("ci", true, true).unwrap_err();
        assert!(
            refusal.contains("never fired"),
            "a tripwire that never fired says so: {refusal}"
        );

        let trip_id = ledger::insert_trip(
            &conn,
            &ledger::NewTrip {
                tripwire_id: tripwire.id,
                event_key: "fact:inst:1".to_string(),
                at_ms: 10,
                instance: "inst".to_string(),
                status: TripStatus::Running,
                reason: None,
                event_payload: None,
                repo_root: None,
            },
        )
        .unwrap()
        .expect("this tripwire has no row for that key yet");
        ledger::record_run(&conn, trip_id, Some("sess-1"), None).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            TripStatus::Awaiting,
            &Settlement {
                headline: Some("something to look at".to_string()),
                ..Settlement::default()
            },
            20,
        )
        .unwrap();

        run_dismiss("ci", true, true).expect("the awaiting trip is dismissed");
        assert_eq!(
            ledger::trip(&conn, trip_id).unwrap().unwrap().status,
            "quiet"
        );

        let refusal = run_dismiss("ci", true, true).unwrap_err();
        assert!(
            refusal.contains("its newest trip is quiet"),
            "an already-settled tripwire names the state it is in: {refusal}"
        );

        // SAFETY: serial test.
        unsafe { std::env::remove_var("TUG_TRIPWIRES_DB") };
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
