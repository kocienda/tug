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
    self as ledger, Claim, NewTripwire, PostPolicy, Tier, Tripwire, TripwireEdit,
    TripwireLedgerError,
};
use tugutil_core::tripwire_predicate::{CommitTrigger, FactTrigger, Matcher, Predicate};

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
            model,
            tier,
            permission_mode,
            post,
            cooldown,
            preview,
        } => run_lay(
            LayArgs {
                name,
                on,
                clauses,
                scope,
                probe,
                brief,
                model,
                tier,
                permission_mode,
                post,
                cooldown,
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
            model,
            tier,
            permission_mode,
            post,
            cooldown,
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
                model,
                tier,
                permission_mode,
                post,
                cooldown,
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
                "a fact trigger names its kind: --on fact:<kind>, e.g. fact:edit_failed".to_string()
            })?;
            let r#where = compile_clauses(clauses)?;
            Ok(Predicate::Fact(FactTrigger {
                kind: kind.to_string(),
                r#where,
            }))
        }
        "commit" => {
            if !clauses.is_empty() {
                return Err(
                    "--where reads a fact's payload, and a commit trigger has none; \
                     narrow it with --on commit:<branch>"
                        .to_string(),
                );
            }
            Ok(Predicate::Commit(CommitTrigger {
                branch: rest.filter(|b| !b.is_empty()).map(str::to_owned),
            }))
        }
        other => Err(format!(
            "unknown trigger source `{other}` — a tripwire watches `fact:<kind>`, \
             `commit`, or `commit:<branch>`"
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
/// **not** folded to its base checkout — a work-tier tripwire commits on its own
/// dash worktree, and folding worktrees into their base would make those
/// commits re-trip the tripwire that made them. A path that cannot be
/// canonicalized keeps its literal form rather than failing the lay.
fn canonical_scope(scope: &str) -> String {
    std::fs::canonicalize(scope)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| scope.to_string())
}

fn parse_tier(tier: &str) -> Result<Tier, String> {
    Tier::parse(tier).ok_or_else(|| format!("unknown tier `{tier}` — auto, verdict, or work"))
}

fn parse_post(post: &str) -> Result<PostPolicy, String> {
    PostPolicy::parse(post)
        .ok_or_else(|| format!("unknown post policy `{post}` — auto, always, or never"))
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
    model: Option<String>,
    tier: Option<String>,
    permission_mode: Option<String>,
    post: Option<String>,
    cooldown: Option<i64>,
}

fn run_lay(args: LayArgs, preview: bool, json: bool, quiet: bool) -> Result<(), String> {
    let predicate = compile_trigger(&args.on, &args.clauses)?;
    let trigger = serde_json::to_string(&predicate).map_err(|e| e.to_string())?;
    let tier = args.tier.as_deref().map(parse_tier).transpose()?;
    let post = args.post.as_deref().map(parse_post).transpose()?;

    let mut tripwire = NewTripwire::new(&args.name, &trigger, read_brief(&args.brief)?);
    tripwire.scope = args.scope.as_deref().map(canonical_scope);
    tripwire.probe = args.probe;
    tripwire.model = args.model;
    if let Some(tier) = tier {
        tripwire.tier = tier;
    }
    if let Some(mode) = args.permission_mode {
        tripwire.permission_mode = mode;
    }
    if let Some(post) = post {
        tripwire.post = post;
    }
    if let Some(cooldown) = args.cooldown {
        if cooldown < 0 {
            return Err("--cooldown is a number of seconds, so it is not negative".to_string());
        }
        tripwire.cooldown_secs = cooldown;
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
                "{}{}  {}  tier={}  post={}{}",
                tripwire.name,
                if tripwire.paused { " (paused)" } else { "" },
                tripwire.trigger,
                tripwire.tier,
                tripwire.post,
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
    probe: Option<String>,
    brief: Option<String>,
    model: Option<String>,
    tier: Option<String>,
    permission_mode: Option<String>,
    post: Option<String>,
    cooldown: Option<i64>,
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
    if let Some(tier) = args.tier.as_deref() {
        edit.tier = Some(parse_tier(tier)?);
    }
    if let Some(mode) = args.permission_mode {
        edit.permission_mode = Some(mode);
    }
    if let Some(post) = args.post.as_deref() {
        edit.post = Some(parse_post(post)?);
    }
    if let Some(cooldown) = args.cooldown {
        if cooldown < 0 {
            return Err("--cooldown is a number of seconds, so it is not negative".to_string());
        }
        edit.cooldown_secs = Some(cooldown);
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
    // both guards a real event meets: the permanent event-key claim and the
    // cooldown window. Firing by hand is how a tripwire is tested, and a test that
    // could be swallowed would test nothing.
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

// MARK: - Payloads

/// One tripwire as `--json` reports it. The resolved tier rides beside the stored
/// one, because `auto` is the value most tripwires carry and the resolution is
/// what a reader actually wants to know.
#[derive(Debug, Serialize)]
struct TripwirePayload {
    name: String,
    trigger: String,
    scope: Option<String>,
    probe: Option<String>,
    brief: String,
    model: Option<String>,
    tier: String,
    resolved_tier: String,
    permission_mode: String,
    post: String,
    paused: bool,
    cooldown_secs: i64,
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
            tier: tripwire.tier.clone(),
            resolved_tier: tripwire.resolved_tier().as_str().to_string(),
            permission_mode: tripwire.permission_mode.clone(),
            post: tripwire.post.as_str().to_string(),
            paused: tripwire.paused,
            cooldown_secs: tripwire.cooldown_secs,
        }
    }

    /// The same shape for a tripwire that was never written, so a preview and a
    /// lay report identically and a reader can compare them field by field.
    fn preview(tripwire: &NewTripwire) -> Self {
        let resolved = match tripwire.tier {
            Tier::Auto if tripwire.probe.is_some() => Tier::Work,
            Tier::Auto => Tier::Verdict,
            explicit => explicit,
        };
        TripwirePayload {
            name: tripwire.name.clone(),
            trigger: tripwire.trigger.clone(),
            scope: tripwire.scope.clone(),
            probe: tripwire.probe.clone(),
            brief: tripwire.brief.clone(),
            model: tripwire.model.clone(),
            tier: tripwire.tier.as_str().to_string(),
            resolved_tier: resolved.as_str().to_string(),
            permission_mode: tripwire.permission_mode.clone(),
            post: tripwire.post.as_str().to_string(),
            paused: false,
            cooldown_secs: tripwire.cooldown_secs,
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
        println!("  tier:     {} → {}", self.tier, self.resolved_tier);
        println!("  post:     {}", self.post);
        println!("  cooldown: {}s", self.cooldown_secs);
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
        if let Some(v) = edit.tier {
            set("tier", Some(v.as_str().to_string()));
        }
        if let Some(v) = &edit.permission_mode {
            set("permission_mode", Some(v.clone()));
        }
        if let Some(v) = edit.post {
            set("post", Some(v.as_str().to_string()));
        }
        if let Some(v) = edit.cooldown_secs {
            set("cooldown_secs", Some(v.to_string()));
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
    interest: Option<String>,
    outcome: Option<String>,
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
            interest: trip.interest.clone(),
            outcome: trip.outcome.clone(),
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
        assert_eq!(compiled("commit", &[]), r#"{"commit":{}}"#);
        assert_eq!(
            compiled("commit:main", &[]),
            r#"{"commit":{"branch":"main"}}"#
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
            err("commit:main", &["f=1"]).contains("payload"),
            "a commit has no payload for --where to read"
        );
    }

    #[test]
    fn a_tier_or_post_this_build_does_not_know_refuses_by_name() {
        assert!(parse_tier("verdict").is_ok());
        assert!(parse_tier("hands").unwrap_err().contains("hands"));
        assert!(parse_post("never").is_ok());
        assert!(parse_post("sometimes").unwrap_err().contains("sometimes"));
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
}
