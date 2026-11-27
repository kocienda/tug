//! `tugtool cycle create|rename|add-entry|add-from|add-sketch|attach|drop|find|list|show|check` —
//! a cycle's record, written and read back.
//!
//! A cycle is a container of related arcs, briefs and sketches. The writing
//! verbs act on this checkout's cycles; `show` reads a cycle by id from any
//! checkout's store on this machine, so it needs no repository, and `check`
//! reads every cycle on the machine for a broken chain. Every entry's state
//! is derived from the arc log as it is read, never stored, and so is
//! whether the cycle is closed: `list` leaves a closed cycle out unless
//! `--all` is passed, and every other verb reads it like any other.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use tugarc_core::cycle::{
    self, ChainBreak, CycleArc, CycleView, DroppedItem, EntryState, NewEntry,
};
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
        CycleCommands::Find { brief, sketch } => (
            "cycle find",
            run_find(&paths, brief.as_deref(), sketch.as_deref(), json),
        ),
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
            (None, None) => println!("{}", found.id),
        }
    }
    Ok(())
}

/// The brief as the record keeps it: relative to the project root. An
/// absolute path inside the checkout is made relative; any other path is
/// passed on as given, for the record to accept or refuse.
fn brief_path(repo: &Path, brief: &str) -> String {
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
}

/// `cycle check`: every cycle on the machine that breaks the chain. Exits 1
/// when any does, so the verb is a check a script can branch on.
fn run_check(paths: &Paths, json: bool) -> ExitCode {
    let breaks = cycle::check_cycles(paths);
    let clean = breaks.is_empty();
    if json {
        print_ok("cycle check", CheckPayload { clean, breaks });
    } else if clean {
        println!("every cycle on this machine is whole");
    } else {
        for b in &breaks {
            println!("{}  {}  {}", b.id, b.name, b.project_dir);
            for problem in &b.problems {
                println!("  {problem}");
            }
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
