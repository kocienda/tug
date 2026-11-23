//! `tugtool sketch record|keep|record-brief|for-brief|show` — a sketch's record, kept and read back.
//!
//! `record` keeps an arc's working `sketch.md` as a version under the
//! sketch's own id. `show` reads a version back by id, from any checkout's
//! store on this machine, so it needs no repository.
//!
//! `keep` keeps an idea's sketch from a file, `record-brief` keeps a brief
//! written from a sketch as one of its brief versions, and `for-brief` names
//! the sketch and brief version a brief file's bytes match.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use tugarc_core::ArcError;
use tugarc_core::sketch::{self, BriefVersion, SketchArc, SketchVersion};
use tugcore::instance::Paths;

use crate::changes::AppError;
use crate::cli::SketchCommands;
use crate::output::print_ok;

/// The exit `show` leaves when the id is not on this machine: a third
/// answer, not a failure, as `session show` answers an absent session.
const EXIT_ABSENT: u8 = 3;

pub fn dispatch(cmd: SketchCommands, json: bool) -> ExitCode {
    let paths = Paths::from_env();
    match cmd {
        SketchCommands::Record { arc, sketch } => {
            match run_record(&paths, &arc, sketch.as_deref(), json) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => e.report("sketch record", json),
            }
        }
        SketchCommands::Keep { idea, file } => match run_keep(&paths, &idea, &file, json) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => e.report("sketch keep", json),
        },
        SketchCommands::RecordBrief {
            id,
            path,
            from_version,
            session,
        } => match run_record_brief(&paths, &id, &path, from_version, session.as_deref(), json) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => e.report("sketch record-brief", json),
        },
        SketchCommands::ForBrief { path } => run_for_brief(&paths, &path, json),
        SketchCommands::Show {
            id,
            version,
            versions,
        } => run_show(&paths, &id, version, versions, json),
    }
}

/// A refusal is a writer's ordinary no — exit 1, as every sketch verb that
/// writes answers it — rather than the arc verbs' exit 3.
fn sketch_err(e: ArcError) -> AppError {
    match e {
        ArcError::Refused(message) => AppError::Exit1("sketch_refused", message),
        other => other.into(),
    }
}

fn repo_root() -> Result<PathBuf, AppError> {
    tugtool_core::find_repo_root().map_err(|e| AppError::Exit1("not_a_repository", e.to_string()))
}

/// A path the user typed, read against the shell's directory. The library
/// reads a relative path against the repo root it is handed, and from a
/// linked worktree that root is the main checkout, not the worktree the file
/// is in.
fn from_cwd(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

fn run_record(paths: &Paths, arc: &str, adopt: Option<&str>, json: bool) -> Result<(), AppError> {
    let repo = repo_root()?;
    let out = sketch::record_arc_sketch(paths, &repo, arc, adopt).map_err(sketch_err)?;
    if json {
        print_ok("sketch record", &out);
        return Ok(());
    }
    print_outcome(&out);
    Ok(())
}

fn print_outcome(out: &sketch::RecordOutcome) {
    let tail = if out.minted {
        " (minted)"
    } else if !out.appended {
        " (unchanged)"
    } else {
        ""
    };
    println!("sketch {} v{}{tail}", out.id, out.version);
}

fn run_keep(paths: &Paths, idea: &str, file: &Path, json: bool) -> Result<(), AppError> {
    let repo = repo_root()?;
    let file = from_cwd(file);
    let text = std::fs::read_to_string(&file).map_err(|e| {
        AppError::Exit1(
            "unreadable",
            format!("could not read {}: {e}", file.display()),
        )
    })?;
    let out = sketch::keep_sketch(paths, &repo, idea, &text).map_err(sketch_err)?;
    if json {
        print_ok("sketch keep", &out);
        return Ok(());
    }
    print_outcome(&out);
    Ok(())
}

fn run_record_brief(
    paths: &Paths,
    id: &str,
    path: &Path,
    from_version: u32,
    session: Option<&str>,
    json: bool,
) -> Result<(), AppError> {
    let repo = repo_root()?;
    let version = sketch::record_brief(paths, &repo, id, &from_cwd(path), from_version, session)
        .map_err(sketch_err)?;
    if json {
        print_ok("sketch record-brief", &version);
        return Ok(());
    }
    println!(
        "sketch {id} brief v{} from sketch v{}  {}",
        version.n, version.sketch_version, version.path
    );
    Ok(())
}

/// What `sketch for-brief --json` prints.
#[derive(Serialize)]
struct ForBriefPayload {
    sketch: String,
    sketch_version: u32,
    brief: BriefVersion,
}

fn run_for_brief(paths: &Paths, path: &Path, json: bool) -> ExitCode {
    let repo = match repo_root() {
        Ok(repo) => repo,
        Err(e) => return e.report("sketch for-brief", json),
    };
    let found = sketch::sketch_for_brief(paths, &repo, &from_cwd(path)).and_then(|(record, n)| {
        let brief = record.briefs.iter().find(|b| b.n == n)?.clone();
        Some(ForBriefPayload {
            sketch: record.id.clone(),
            sketch_version: record.latest(),
            brief,
        })
    });
    let Some(payload) = found else {
        let none = AppError::Exit3(
            "no_sketch",
            format!("no sketch in this checkout kept {}", path.display()),
        );
        if json {
            crate::output::print_error("sketch for-brief", &none);
        } else {
            eprintln!("none");
        }
        return ExitCode::from(EXIT_ABSENT);
    };
    if json {
        print_ok("sketch for-brief", &payload);
    } else {
        println!(
            "sketch {} brief v{} (from sketch v{}, now v{})",
            payload.sketch, payload.brief.n, payload.brief.sketch_version, payload.sketch_version
        );
    }
    ExitCode::SUCCESS
}

/// What `sketch show --json` prints.
#[derive(Serialize)]
struct ShowPayload {
    id: String,
    project_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    arc: Option<SketchArc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    idea: Option<String>,
    versions: Vec<SketchVersion>,
    briefs: Vec<BriefVersion>,
    version: u32,
    text: String,
}

fn run_show(paths: &Paths, id: &str, version: Option<u32>, list: bool, json: bool) -> ExitCode {
    let mut found = sketch::find_sketch(paths, id);
    if found.is_empty() {
        let absent = AppError::Exit3(
            "sketch_absent",
            format!("no sketch {id} is on this machine"),
        );
        if json {
            crate::output::print_error("sketch show", &absent);
        } else {
            eprintln!("absent");
        }
        return ExitCode::from(EXIT_ABSENT);
    }
    if found.len() > 1 {
        let projects: Vec<String> = found.iter().map(|(_, r)| r.project_dir.clone()).collect();
        return AppError::Exit1(
            "sketch_ambiguous",
            format!(
                "sketch {id} is in more than one checkout: {}",
                projects.join(", ")
            ),
        )
        .report("sketch show", json);
    }
    let (_, record) = found.remove(0);

    if list && !json {
        for v in &record.versions {
            println!("v{}  {}", v.n, v.at);
        }
        return ExitCode::SUCCESS;
    }
    let text = match sketch::read_version(&record, version) {
        Ok(text) => text,
        Err(e) => return AppError::from(e).report("sketch show", json),
    };
    if json {
        print_ok(
            "sketch show",
            ShowPayload {
                version: version.unwrap_or_else(|| record.latest()),
                id: record.id,
                project_dir: record.project_dir,
                arc: record.arc,
                idea: record.idea,
                versions: record.versions,
                briefs: record.briefs,
                text,
            },
        );
    } else {
        print!("{text}");
    }
    ExitCode::SUCCESS
}
