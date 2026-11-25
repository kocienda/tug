//! `tugtool docket list|show` — a checkout's dockets and their threads, read.
//!
//! Both verbs are read-only. A docket is made, renamed, retired and filed
//! onto by the user's own gestures on the Docket card, never by a model, so
//! the CLI offers nothing that writes. `list` reads one checkout's dockets;
//! `show` finds a docket by its id under every checkout on this machine, so
//! it needs no repository, and prints each thread as the cells it holds,
//! each with the command that reads that cell further.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use tugarc_core::docket::{self, Docket};
use tugarc_core::docket_threads::{
    ArcFate, BriefSource, CommitRole, Thread, derive_threads, gather_inputs,
};
use tugarc_core::sketch::SketchAuthor;
use tugcore::instance::Paths;

use crate::changes::AppError;
use crate::cli::DocketCommands;
use crate::output::print_ok;

/// The exit `show` leaves when the id is not on this machine: a third
/// answer, not a failure, as `sketch show` answers an absent sketch.
const EXIT_ABSENT: u8 = 3;

pub fn dispatch(cmd: DocketCommands, json: bool) -> ExitCode {
    let paths = Paths::from_env();
    match cmd {
        DocketCommands::List { project, all } => match run_list(&paths, project, all, json) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => e.report("docket list", json),
        },
        DocketCommands::Show { id } => run_show(&paths, &id, json),
    }
}

/// One row of `docket list --json`.
#[derive(Serialize)]
struct ListRow {
    id: String,
    name: String,
    created: String,
    project_dir: String,
    retired: bool,
    items: usize,
    threads: usize,
}

fn run_list(
    paths: &Paths,
    project: Option<PathBuf>,
    all: bool,
    json: bool,
) -> Result<(), AppError> {
    let repo = match project {
        Some(dir) => tugtool_core::worktree::find_repo_root_from(&dir),
        None => tugtool_core::find_repo_root(),
    }
    .map_err(|e| AppError::Exit1("not_a_repository", e.to_string()))?;
    let rows: Vec<ListRow> = docket::dockets(paths, &repo, all)
        .into_iter()
        .map(|d| {
            let threads = derive_threads(&gather_inputs(paths, &repo, &d)).len();
            ListRow {
                id: d.id.clone(),
                name: d.name.clone(),
                created: d.created.clone(),
                project_dir: d.project_dir.clone(),
                retired: d.retired(),
                items: d.items.len(),
                threads,
            }
        })
        .collect();
    if json {
        print_ok("docket list", &rows);
        return Ok(());
    }
    if rows.is_empty() {
        println!("no dockets");
        return Ok(());
    }
    for row in &rows {
        let plural = if row.threads == 1 { "" } else { "s" };
        let retired = if row.retired { "  retired" } else { "" };
        println!(
            "{}  {}  {} thread{plural}{retired}",
            row.id, row.name, row.threads
        );
    }
    Ok(())
}

/// What `docket show --json` prints.
#[derive(Serialize)]
struct ShowPayload {
    id: String,
    name: String,
    created: String,
    project_dir: String,
    retired: bool,
    threads: Vec<Thread>,
}

fn run_show(paths: &Paths, id: &str, json: bool) -> ExitCode {
    let mut found = docket::find_docket(paths, id);
    if found.is_empty() {
        let absent = AppError::Exit3(
            "docket_absent",
            format!("no docket {id} is on this machine"),
        );
        if json {
            crate::output::print_error("docket show", &absent);
        } else {
            eprintln!("absent");
        }
        return ExitCode::from(EXIT_ABSENT);
    }
    if found.len() > 1 {
        let projects: Vec<String> = found.iter().map(|(_, d)| d.project_dir.clone()).collect();
        return AppError::Exit1(
            "docket_ambiguous",
            format!(
                "docket {id} is in more than one checkout: {}",
                projects.join(", ")
            ),
        )
        .report("docket show", json);
    }
    let (_, d) = found.remove(0);
    let repo = PathBuf::from(&d.project_dir);
    let threads = derive_threads(&gather_inputs(paths, &repo, &d));
    if json {
        print_ok(
            "docket show",
            ShowPayload {
                id: d.id.clone(),
                name: d.name.clone(),
                created: d.created.clone(),
                project_dir: d.project_dir.clone(),
                retired: d.retired(),
                threads,
            },
        );
    } else {
        print!("{}", render(&d, &threads, &repo));
    }
    ExitCode::SUCCESS
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

fn mark(filed: bool) -> &'static str {
    if filed { "  (filed)" } else { "" }
}

/// The text form: a header, then each thread as one line per cell, in the
/// order the work ran, each naming what reads it.
fn render(d: &Docket, threads: &[Thread], repo: &Path) -> String {
    let mut out = format!("{}  {}\n", d.name, d.id);
    out.push_str(&format!("  project  {}\n", repo.display()));
    out.push_str(&format!("  created  {}\n", d.created));
    if let Some(at) = &d.retired_at {
        out.push_str(&format!("  retired  {at}\n"));
    }
    if threads.is_empty() {
        out.push_str("\nnothing filed\n");
        return out;
    }
    for t in threads {
        out.push_str(&format!("\nthread {}\n", t.key));
        if let Some(i) = &t.idea {
            out.push_str(&format!(
                "  idea     {} \"{}\"{}  · tugtool idea show {}\n",
                i.id,
                i.text,
                mark(i.filed),
                i.id
            ));
        }
        if let Some(s) = &t.sketch {
            let want = s
                .want
                .as_deref()
                .map(|w| format!(" — {w}"))
                .unwrap_or_default();
            let author = match s.author {
                SketchAuthor::User => " (yours)",
                SketchAuthor::Model => "",
            };
            out.push_str(&format!(
                "  sketch   {} v{}{author}{want}{}  · tugtool sketch show {}\n",
                s.id,
                s.versions,
                mark(s.filed),
                s.id
            ));
        }
        if let Some(b) = &t.brief {
            let title = b.title.as_deref().unwrap_or("(untitled)");
            let read = match (b.source, &t.arc) {
                (BriefSource::Arc, Some(a)) => format!(
                    "tugtool arc show {} --created {} --document brief",
                    a.name, a.created
                ),
                (BriefSource::Sketch, _) => format!(
                    "kept from {}",
                    b.source_path.as_deref().unwrap_or("an unknown path")
                ),
                _ => format!(
                    "filed from {}",
                    b.source_path.as_deref().unwrap_or("an unknown path")
                ),
            };
            let version = match b.version {
                Some(n) => {
                    let stale = match (b.stale, b.sketch_version, &t.sketch) {
                        (true, Some(from), Some(s)) => {
                            format!(" (stale: from sketch v{from}, now v{})", s.versions)
                        }
                        (true, _, _) => " (stale)".to_string(),
                        _ => String::new(),
                    };
                    format!(" v{n}{stale}")
                }
                None => String::new(),
            };
            out.push_str(&format!(
                "  brief   {version} {title}{}  · {read}\n",
                mark(b.filed)
            ));
        }
        if let Some(a) = &t.arc {
            let fate = match a.fate {
                ArcFate::Live => "live".to_string(),
                ArcFate::Joined => match &a.join_sha {
                    Some(sha) => format!("joined {}", short(sha)),
                    None => "joined".to_string(),
                },
                ArcFate::Discarded => "discarded".to_string(),
                ArcFate::Unknown => "not in the arc log".to_string(),
            };
            let on = match a.brief_version {
                Some(n) => {
                    let of = t.brief.as_ref().map(|b| b.versions).unwrap_or(n);
                    let stale = if a.stale { " (stale)" } else { "" };
                    format!(" on brief v{n} of {of}{stale}")
                }
                None => String::new(),
            };
            let runs = if a.runs > 1 {
                format!(" · run {}", a.runs)
            } else {
                String::new()
            };
            out.push_str(&format!(
                "  arc      {} {fate}{on}{runs}{}  · tugtool arc show {} --created {}\n",
                a.name,
                mark(a.filed),
                a.name,
                a.created
            ));
        }
        for s in &t.sessions {
            let who = s.callsign.as_deref().unwrap_or(&s.uuid);
            let stage = s
                .stage
                .as_deref()
                .map(|st| format!(" {st}"))
                .unwrap_or_default();
            out.push_str(&format!(
                "  session  {who}{stage}{}  · tugtool session show {}\n",
                mark(s.filed),
                s.uuid
            ));
        }
        for c in &t.commits {
            let role = match c.role {
                CommitRole::Round => "round",
                CommitRole::Join => "join",
                CommitRole::Arc => "arc",
                CommitRole::Session => "session",
                CommitRole::Filed => "filed",
            };
            out.push_str(&format!(
                "  commit   {} {role} {}{}  · git show {}\n",
                short(&c.sha),
                c.subject,
                mark(c.filed),
                c.sha
            ));
        }
    }
    out
}
