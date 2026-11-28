//! `tugtool cycle create|rename|add-entry|add-from|add-sketch|attach|place|queue|statement|stated|drop|find|list|show|check` —
//! a cycle's record, written and read back, and the arc statements that
//! queue its arcs: checked before they are written, and listed after.
//!
//! A cycle is a container of related arcs, briefs and sketches. The writing
//! verbs act on this checkout's cycles; `show` reads a cycle by id from any
//! checkout's store on this machine, so it needs no repository, and `check`
//! reads every cycle on the machine for a broken chain, and every checkout
//! that keeps cycles for a live arc on none of them. Every entry's state
//! is derived from the arc log as it is read, never stored, and so is
//! whether the cycle is closed: `list` leaves a closed cycle out unless
//! `--all` is passed, and every other verb reads it like any other.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use tugarc_core::cycle::{
    self, ChainBreak, CycleArc, CycleView, DroppedItem, EntryState, NewEntry, Outcome, PlaceArc,
    Placed, QueueArc, UnattachedArc,
};
use tugarc_core::statement::{self, StatedArc};
use tugcore::instance::Paths;

use crate::changes::AppError;
use crate::cli::CycleCommands;
use crate::output::print_ok;

/// The exit `show` leaves when the id is not on this machine: a third
/// answer, not a failure, as `sketch show` answers an absent sketch.
const EXIT_ABSENT: u8 = 3;

pub fn dispatch(cmd: CycleCommands, json: bool) -> ExitCode {
    let paths = Paths::from_env();
    let (command, result) = match cmd {
        CycleCommands::Create { name } => ("cycle create", run_create(&paths, &name, json)),
        CycleCommands::AddEntry {
            id,
            brief,
            wait,
            from,
            note,
        } => (
            "cycle add-entry",
            run_add_entry(&paths, &id, &brief, wait, from, note, json),
        ),
        CycleCommands::AddFrom { id, n, from } => {
            ("cycle add-from", run_add_from(&paths, &id, n, from, json))
        }
        CycleCommands::AddSketch { id, sketch, brief } => (
            "cycle add-sketch",
            run_add_sketch(&paths, &id, &sketch, brief.as_deref(), json),
        ),
        CycleCommands::Attach { id, n, arc } => {
            ("cycle attach", run_attach(&paths, &id, n, &arc, json))
        }
        CycleCommands::Rename { id, name } => {
            ("cycle rename", run_rename(&paths, &id, &name, json))
        }
        CycleCommands::Find { brief, sketch, arc } => (
            "cycle find",
            match arc {
                Some(arc) => run_find_arc(&paths, &arc, json),
                None => run_find(&paths, brief.as_deref(), sketch.as_deref(), json),
            },
        ),
        CycleCommands::Place {
            arc,
            brief,
            sketch,
            name,
        } => (
            "cycle place",
            run_place(
                &paths,
                &arc,
                &brief,
                sketch.as_deref(),
                name.as_deref(),
                json,
            ),
        ),
        CycleCommands::Queue {
            arc,
            brief,
            cycle,
            label,
            wait,
            after,
            from,
            turn,
        } => {
            let req = QueueRequest {
                arc: &arc,
                brief: &brief,
                cycle: cycle.as_deref(),
                label: label.as_deref(),
                waits: wait,
                after: after.as_deref(),
                from,
                turn,
            };
            ("cycle queue", run_queue(&paths, req, json))
        }
        CycleCommands::Statement { source } => {
            ("cycle statement", run_statement(&paths, &source, json))
        }
        CycleCommands::Stated => ("cycle stated", run_stated(&paths, json)),
        CycleCommands::Drop { id, item } => ("cycle drop", run_drop(&paths, &id, &item, json)),
        CycleCommands::List { all } => ("cycle list", run_list(&paths, all, json)),
        CycleCommands::Show { id } => return run_show(&paths, &id, json),
        CycleCommands::Check => return run_check(&paths, json),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => e.report(command, json),
    }
}

fn repo() -> Result<PathBuf, AppError> {
    tugtool_core::find_repo_root().map_err(|e| AppError::Exit1("not_a_repository", e.to_string()))
}

#[derive(Serialize)]
struct CreatePayload {
    id: String,
    name: String,
}

/// The calling session's live segment, through the one reader of the
/// variable ([P01]); with no instance to ask, the posted id is the answer.
/// `create` records it as the cycle's author, which nothing reads to find a
/// cycle: a session works on records and never owns one ([L41]).
fn writer() -> Option<String> {
    crate::session_identity::resolve_soft(None).map(|r| r.session_id)
}

fn run_create(paths: &Paths, name: &str, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let made = cycle::create_cycle(paths, &repo, name, writer().as_deref())?;
    if json {
        print_ok(
            "cycle create",
            CreatePayload {
                id: made.id,
                name: made.name,
            },
        );
    } else {
        println!("{}", made.id);
    }
    Ok(())
}

fn run_rename(paths: &Paths, id: &str, name: &str, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let renamed = cycle::rename_cycle(paths, &repo, id, name)?;
    if json {
        print_ok(
            "cycle rename",
            CreatePayload {
                id: renamed.id,
                name: renamed.name,
            },
        );
    } else {
        println!("{}", renamed.name);
    }
    Ok(())
}

fn run_find(
    paths: &Paths,
    brief: Option<&str>,
    sketch: Option<&str>,
    json: bool,
) -> Result<(), AppError> {
    let repo = repo()?;
    let found = match (brief, sketch) {
        (Some(brief), _) => cycle::find_by_brief(paths, &repo, &brief_path(&repo, brief)),
        (None, Some(sketch)) => cycle::find_by_sketch(paths, &repo, sketch),
        (None, None) => None,
    };
    if json {
        print_ok("cycle find", found);
    } else if let Some(found) = found {
        match (found.n, found.letter) {
            (Some(n), _) => println!("{}  {n}", found.id),
            (None, Some(letter)) => println!("{}  {letter}", found.id),
            (None, None) if !found.from.is_empty() => {
                println!("{}  from {}", found.id, found.from.join(","))
            }
            (None, None) => println!("{}", found.id),
        }
    }
    Ok(())
}

/// The entry in this checkout queued for arc `arc`, or carrying it: the
/// most recently changed cycle first, and within it the latest entry, so a
/// rerun answers before the run it repeats.
fn run_find_arc(paths: &Paths, arc: &str, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let found = cycle::cycles(paths, &repo).into_iter().find_map(|record| {
        record
            .entries
            .iter()
            .rev()
            .find(|e| {
                e.arc_name.as_deref() == Some(arc) || e.arc.as_ref().is_some_and(|a| a.name == arc)
            })
            .map(|e| cycle::BriefFound {
                id: record.id.clone(),
                n: Some(e.n),
                letter: None,
                from: Vec::new(),
            })
    });
    if json {
        print_ok("cycle find", found);
    } else if let Some(found) = found {
        println!("{}  {}", found.id, found.n.unwrap_or_default());
    }
    Ok(())
}

/// Print a placement: `<cycle>  <n or letter>  <outcome>`.
fn print_placed(command: &str, placed: Placed, json: bool) {
    if json {
        print_ok(command, placed);
        return;
    }
    let at = match (placed.n, &placed.letter) {
        (Some(n), _) => n.to_string(),
        (None, Some(letter)) => letter.clone(),
        (None, None) => "-".to_string(),
    };
    println!("{}  {at}  {}", placed.cycle, outcome_word(placed.outcome));
}

fn outcome_word(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Already => "already",
        Outcome::Filled => "filled",
        Outcome::Added => "added",
        Outcome::Started => "started",
        Outcome::Named => "named",
        Outcome::Linked => "linked",
    }
}

fn run_place(
    paths: &Paths,
    arc: &str,
    brief: &str,
    sketch: Option<&str>,
    name: Option<&str>,
    json: bool,
) -> Result<(), AppError> {
    let repo = repo()?;
    let by = crate::session_identity::work_by(None);
    let brief = brief_path(&repo, brief);
    let placed = cycle::place_arc(
        paths,
        &repo,
        PlaceArc {
            arc,
            brief: &brief,
            sketch,
            name,
            by: &by,
        },
    )?;
    print_placed("cycle place", placed, json);
    Ok(())
}

/// What `cycle queue` was given.
struct QueueRequest<'a> {
    arc: &'a str,
    brief: &'a str,
    cycle: Option<&'a str>,
    label: Option<&'a str>,
    waits: Vec<u32>,
    after: Option<&'a str>,
    from: Vec<String>,
    turn: Option<u32>,
}

fn run_queue(paths: &Paths, req: QueueRequest, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let by = crate::session_identity::work_by(req.turn);
    let brief = brief_path(&repo, req.brief);
    let placed = cycle::queue_arc(
        paths,
        &repo,
        QueueArc {
            arc: req.arc,
            brief: &brief,
            cycle: req.cycle,
            label: req.label,
            waits: req.waits,
            after: req.after,
            from: req.from,
            by: &by,
        },
    )?;
    print_placed("cycle queue", placed, json);
    Ok(())
}

/// The brief as the record keeps it: relative to the project root. An
/// absolute path inside the checkout is made relative; any other path is
/// passed on as given, for the record to accept or refuse.
pub(crate) fn brief_path(repo: &Path, brief: &str) -> String {
    let path = Path::new(brief);
    if path.is_absolute() {
        let root = tugcore::pathform::resolve_to_claude_form(repo);
        let given = tugcore::pathform::resolve_to_claude_form(path);
        if let Ok(rel) = given.strip_prefix(&root) {
            return rel.to_string_lossy().into_owned();
        }
    }
    brief.to_string()
}

#[derive(Serialize)]
struct EntryPayload {
    id: String,
    n: u32,
}

fn run_add_entry(
    paths: &Paths,
    id: &str,
    brief: &str,
    waits: Vec<u32>,
    from: Vec<String>,
    note: Option<String>,
    json: bool,
) -> Result<(), AppError> {
    let repo = repo()?;
    let n = cycle::add_entry(
        paths,
        &repo,
        id,
        NewEntry {
            brief: brief_path(&repo, brief),
            waits,
            from,
            note,
            ..NewEntry::default()
        },
    )?;
    if json {
        print_ok(
            "cycle add-entry",
            EntryPayload {
                id: id.to_string(),
                n,
            },
        );
    } else {
        println!("{n}");
    }
    Ok(())
}

#[derive(Serialize)]
struct SketchPayload {
    id: String,
    sketch: String,
    letter: String,
}

#[derive(Serialize)]
struct FromPayload {
    id: String,
    n: u32,
    from: Vec<String>,
}

fn run_add_from(
    paths: &Paths,
    id: &str,
    n: u32,
    letters: Vec<String>,
    json: bool,
) -> Result<(), AppError> {
    let repo = repo()?;
    let from = cycle::add_from(paths, &repo, id, n, letters)?;
    if json {
        print_ok(
            "cycle add-from",
            FromPayload {
                id: id.to_string(),
                n,
                from,
            },
        );
    } else {
        println!("{}", from.join(","));
    }
    Ok(())
}

fn run_add_sketch(
    paths: &Paths,
    id: &str,
    sketch: &str,
    brief: Option<&str>,
    json: bool,
) -> Result<(), AppError> {
    let repo = repo()?;
    let brief = brief.map(|b| brief_path(&repo, b));
    let letter = cycle::add_sketch(paths, &repo, id, sketch, brief.as_deref())?;
    if json {
        print_ok(
            "cycle add-sketch",
            SketchPayload {
                id: id.to_string(),
                sketch: sketch.to_string(),
                letter,
            },
        );
    } else {
        println!("{letter}");
    }
    Ok(())
}

#[derive(Serialize)]
struct AttachPayload {
    id: String,
    n: u32,
    arc: CycleArc,
}

fn run_attach(paths: &Paths, id: &str, n: u32, arc: &str, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let link = cycle::attach(paths, &repo, id, n, arc)?;
    if json {
        print_ok(
            "cycle attach",
            AttachPayload {
                id: id.to_string(),
                n,
                arc: link,
            },
        );
    } else {
        println!("{n}  {}", link.name);
    }
    Ok(())
}

#[derive(Serialize)]
struct DropPayload {
    id: String,
    #[serde(flatten)]
    item: DroppedItem,
}

fn run_drop(paths: &Paths, id: &str, item: &str, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let item = cycle::drop_item(paths, &repo, id, item)?;
    if json {
        print_ok(
            "cycle drop",
            DropPayload {
                id: id.to_string(),
                item,
            },
        );
    } else {
        match item {
            DroppedItem::Entry(n) => println!("{n}  dropped"),
            DroppedItem::Sketch(letter) => println!("{letter}  dropped"),
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct StatementPayload {
    arcs: Vec<StatedArc>,
    warnings: Vec<String>,
}

/// `cycle statement`: parse a spec and check it against the disk. It
/// writes nothing and appends nothing, so it can be run on any draft.
fn run_statement(paths: &Paths, source: &str, json: bool) -> Result<(), AppError> {
    let text = if source == "-" {
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
            .map_err(|e| AppError::Exit1("failed", format!("cannot read stdin: {e}")))?;
        text
    } else {
        std::fs::read_to_string(source)
            .map_err(|e| AppError::Exit1("failed", format!("cannot read {source}: {e}")))?
    };
    // The refusal is the check's answer, so it is printed as the answer is,
    // with no `error:` before it.
    let (parsed, mut warnings) = match statement::parse_fence(&statement::spec_text(&text)) {
        Ok(parsed) => parsed,
        Err(e) => {
            let refused = AppError::Exit2(
                "invalid_statement",
                format!("not a valid arc statement: {e}"),
            );
            if json {
                return Err(refused);
            }
            println!("{}", refused.message());
            return Err(AppError::Reported(2));
        }
    };
    let repo = repo()?;
    warnings.extend(statement::check(paths, &repo, &parsed));
    if json {
        print_ok(
            "cycle statement",
            StatementPayload {
                arcs: parsed.arcs,
                warnings,
            },
        );
    } else {
        let n = parsed.arcs.len();
        println!("ok: {n} {}", if n == 1 { "arc" } else { "arcs" });
        for warning in &warnings {
            println!("warning: {warning}");
        }
    }
    Ok(())
}

/// `cycle stated`: every statement record of this checkout.
fn run_stated(paths: &Paths, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let records = statement::statements(paths, &repo);
    if json {
        print_ok("cycle stated", records);
        return Ok(());
    }
    for record in &records {
        let turn = record
            .turn
            .map(|t| format!("  turn {t}"))
            .unwrap_or_default();
        println!("{}{turn}", record.session);
        for arc in &record.arcs {
            match (&arc.cycle, arc.n) {
                (Some(cycle), Some(n)) => println!("  {}  {cycle} {n}", arc.name),
                _ => println!("  {}  held", arc.name),
            }
        }
    }
    Ok(())
}

/// One row of `cycle list`.
#[derive(Serialize)]
struct ListRow {
    id: String,
    name: String,
    updated: String,
    landed: usize,
    total: usize,
    closed: bool,
}

fn run_list(paths: &Paths, all: bool, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let records = cycle::cycles(paths, &repo);
    let rows: Vec<ListRow> = records
        .iter()
        .map(|record| {
            let view = cycle::view_cycle(paths, record);
            ListRow {
                total: view.entries.len(),
                landed: view.landed,
                closed: view.closed,
                id: view.id,
                name: view.name,
                updated: view.updated,
            }
        })
        .filter(|row| all || !row.closed)
        .collect();
    if json {
        print_ok("cycle list", rows);
        return Ok(());
    }
    for row in &rows {
        let closed = if row.closed { "  closed" } else { "" };
        println!(
            "{}  {}/{}  {}{closed}",
            row.id, row.landed, row.total, row.name
        );
    }
    Ok(())
}

fn run_show(paths: &Paths, id: &str, json: bool) -> ExitCode {
    let mut found = cycle::find_cycle(paths, id);
    if found.is_empty() {
        let absent = AppError::Exit3("cycle_absent", format!("no cycle {id} is on this machine"));
        if json {
            crate::output::print_error("cycle show", &absent);
        } else {
            eprintln!("absent");
        }
        return ExitCode::from(EXIT_ABSENT);
    }
    if found.len() > 1 {
        let projects: Vec<String> = found.iter().map(|(_, r)| r.project_dir.clone()).collect();
        return AppError::Exit1(
            "cycle_ambiguous",
            format!(
                "cycle {id} is in more than one checkout: {}",
                projects.join(", ")
            ),
        )
        .report("cycle show", json);
    }
    let (_, record) = found.remove(0);
    let view = cycle::view_cycle(paths, &record);
    if json {
        print_ok("cycle show", &view);
    } else {
        print!("{}", render(&view));
    }
    ExitCode::SUCCESS
}

#[derive(Serialize)]
struct CheckPayload {
    clean: bool,
    breaks: Vec<ChainBreak>,
    /// Live arcs no cycle's entry carries.
    unattached: Vec<UnattachedArc>,
}

/// `cycle check`: every cycle on the machine that breaks the chain, and every
/// live arc on no cycle. Exits 1 when there is either, so the verb is a check
/// a script can branch on.
fn run_check(paths: &Paths, json: bool) -> ExitCode {
    let breaks = cycle::check_cycles(paths);
    let unattached = cycle::unattached_arcs(paths);
    let clean = breaks.is_empty() && unattached.is_empty();
    if json {
        print_ok(
            "cycle check",
            CheckPayload {
                clean,
                breaks,
                unattached,
            },
        );
    } else if clean {
        println!("every cycle on this machine is whole, and every live arc is on one");
    } else {
        for b in &breaks {
            println!("{}  {}  {}", b.id, b.name, b.project_dir);
            for problem in &b.problems {
                println!("  {problem}");
            }
        }
        for u in &unattached {
            println!("arc {}  {}  is on no cycle", u.arc, u.project_dir);
        }
    }
    if clean {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn state_word(state: EntryState) -> &'static str {
    match state {
        EntryState::Joined => "joined",
        EntryState::Running => "running",
        EntryState::Dropped => "dropped",
        EntryState::Waiting => "waiting",
        EntryState::Ready => "ready",
    }
}

/// The plain-text form of `cycle show`.
fn render(view: &CycleView) -> String {
    let mut out = format!(
        "{}  {}  {}/{} landed{}\n",
        view.id,
        view.name,
        view.landed,
        view.entries.len(),
        if view.closed { "  closed" } else { "" }
    );
    for s in &view.sketches {
        let dropped = if s.dropped.is_some() { "  dropped" } else { "" };
        out.push_str(&format!("  {}  sketch {}{dropped}\n", s.letter, s.id));
    }
    for e in &view.entries {
        let mut line = format!(
            "  {}  {:<7}  {}",
            e.entry.n,
            state_word(e.state),
            e.entry.brief
        );
        if let Some(arc) = &e.entry.arc {
            line.push_str(&format!("  arc {}", arc.name));
        }
        if !e.entry.waits.is_empty() {
            let waits: Vec<String> = e.entry.waits.iter().map(u32::to_string).collect();
            line.push_str(&format!("  waits {}", waits.join(",")));
        }
        if !e.entry.from.is_empty() {
            line.push_str(&format!("  from {}", e.entry.from.join(",")));
        }
        if let Some(note) = &e.entry.note {
            line.push_str(&format!("  — {note}"));
        }
        out.push_str(&line);
        out.push('\n');
        for stage in &e.stages {
            out.push_str(&format!(
                "       {} session {}\n",
                stage.stage.as_str(),
                stage.session_id
            ));
        }
    }
    out
}
