//! `tugtool idea show|list` — an idea's record, read.
//!
//! Both verbs are read-only. An idea is made by the user's capture on the
//! Docket card, never by a model, so the CLI offers nothing that writes.
//! `show` finds an idea by its id under every checkout on this machine, so it
//! needs no repository, and names the docket it is on, the sketch kept from
//! it, and the sessions it was sketched in.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use tugarc_core::docket::{self, DocketItem};
use tugarc_core::idea::{self, IdeaRecord, IdeaSession};
use tugarc_core::sketch::{self, SketchRecord};
use tugcore::instance::Paths;

use crate::changes::AppError;
use crate::cli::IdeaCommands;
use crate::output::print_ok;

/// The exit `show` leaves when the id is not on this machine: a third
/// answer, not a failure, as `sketch show` answers an absent sketch.
const EXIT_ABSENT: u8 = 3;

pub fn dispatch(cmd: IdeaCommands, json: bool) -> ExitCode {
    let paths = Paths::from_env();
    match cmd {
        IdeaCommands::Show { id } => run_show(&paths, &id, json),
        IdeaCommands::List { project } => match run_list(&paths, project, json) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => e.report("idea list", json),
        },
    }
}

/// The docket an idea is filed on.
#[derive(Serialize)]
struct DocketRef {
    id: String,
    name: String,
}

/// The sketch kept from an idea.
#[derive(Serialize)]
struct SketchRef {
    id: String,
    version: u32,
}

/// What `idea show --json` prints.
#[derive(Serialize)]
struct ShowPayload {
    id: String,
    created: String,
    project_dir: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    docket: Option<DocketRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sketch: Option<SketchRef>,
    sessions: Vec<IdeaSession>,
}

/// The newest sketch kept from idea `id` in checkout `repo`.
fn idea_sketch(paths: &Paths, repo: &Path, id: &str) -> Option<SketchRecord> {
    sketch::sketches(paths, repo)
        .into_iter()
        .filter(|s| s.idea.as_deref() == Some(id))
        .max_by(|a, b| a.created.cmp(&b.created))
}

/// The docket in checkout `repo` that holds `idea:<id>`, retired or not.
fn idea_docket(paths: &Paths, repo: &Path, id: &str) -> Option<DocketRef> {
    docket::dockets(paths, repo, true)
        .into_iter()
        .find(|d| {
            d.items
                .iter()
                .any(|item| matches!(item, DocketItem::Idea { id: held, .. } if held == id))
        })
        .map(|d| DocketRef {
            id: d.id,
            name: d.name,
        })
}

fn run_show(paths: &Paths, id: &str, json: bool) -> ExitCode {
    let mut found = idea::find_idea(paths, id);
    if found.is_empty() {
        let absent = AppError::Exit3("idea_absent", format!("no idea {id} is on this machine"));
        if json {
            crate::output::print_error("idea show", &absent);
        } else {
            eprintln!("absent");
        }
        return ExitCode::from(EXIT_ABSENT);
    }
    if found.len() > 1 {
        let projects: Vec<String> = found.iter().map(|(_, r)| r.project_dir.clone()).collect();
        return AppError::Exit1(
            "idea_ambiguous",
            format!(
                "idea {id} is in more than one checkout: {}",
                projects.join(", ")
            ),
        )
        .report("idea show", json);
    }
    let (_, record) = found.remove(0);
    let repo = PathBuf::from(&record.project_dir);
    let payload = ShowPayload {
        docket: idea_docket(paths, &repo, &record.id),
        sketch: idea_sketch(paths, &repo, &record.id).map(|s| SketchRef {
            version: s.latest(),
            id: s.id,
        }),
        id: record.id,
        created: record.created,
        project_dir: record.project_dir,
        text: record.text,
        body: record.body,
        sessions: record.sessions,
    };
    if json {
        print_ok("idea show", &payload);
    } else {
        print!("{}", render(&payload));
    }
    ExitCode::SUCCESS
}

/// The text form: the idea's line and body, then one line per fact, ending
/// with the command that reads the sketch when there is one.
fn render(p: &ShowPayload) -> String {
    let mut out = format!("idea {}  {}\n", p.id, p.text);
    if let Some(body) = p.body.as_deref().filter(|b| !b.trim().is_empty()) {
        out.push('\n');
        out.push_str(body.trim_end());
        out.push_str("\n\n");
    }
    out.push_str(&format!("project: {}\n", p.project_dir));
    out.push_str(&format!("created: {}\n", p.created));
    match &p.docket {
        Some(d) => out.push_str(&format!("docket: {} ({})\n", d.name, d.id)),
        None => out.push_str("docket: none\n"),
    }
    match &p.sketch {
        Some(s) => out.push_str(&format!("sketch: {} v{}\n", s.id, s.version)),
        None => out.push_str("sketch: none\n"),
    }
    for s in &p.sessions {
        out.push_str(&format!("session: {}\n", s.uuid));
    }
    if let Some(s) = &p.sketch {
        out.push_str(&format!("read: tugtool sketch show {}\n", s.id));
    }
    out
}

/// One row of `idea list --json`.
#[derive(Serialize)]
struct ListRow {
    id: String,
    created: String,
    text: String,
    sessions: usize,
}

fn run_list(paths: &Paths, project: Option<PathBuf>, json: bool) -> Result<(), AppError> {
    let repo = match project {
        Some(dir) => tugtool_core::worktree::find_repo_root_from(&dir),
        None => tugtool_core::find_repo_root(),
    }
    .map_err(|e| AppError::Exit1("not_a_repository", e.to_string()))?;
    let rows: Vec<ListRow> = idea::ideas(paths, &repo)
        .into_iter()
        .map(|r: IdeaRecord| ListRow {
            sessions: r.sessions.len(),
            id: r.id,
            created: r.created,
            text: r.text,
        })
        .collect();
    if json {
        print_ok("idea list", &rows);
        return Ok(());
    }
    if rows.is_empty() {
        println!("no ideas");
        return Ok(());
    }
    for row in &rows {
        println!("{}  {}  {}", row.id, row.created, row.text);
    }
    Ok(())
}
