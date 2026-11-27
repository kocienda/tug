//! Briefs — the `tugtool brief …` namespace.
//!
//! `record` gives a brief its record and id line and, when it came from a
//! sketch or a brief, puts it on its cycle; `show`, `find` and `list` read
//! the records back.
//!
//! `dir` answers where a brief is written. The answer is the
//! project's own `briefs/` unless the user set a different one, and the
//! setting lives where every other app-wide preference does — the instance's
//! tugbank, under `dev.tugapp.app` / `briefs-path`.
//!
//! The default lives here, in the binary, and is never written back to the
//! store: an unset key means "the project's `briefs/`", which is a sentence
//! the caption in Settings can state and the CLI can honor without either of
//! them holding a copy of the other's answer.
//!
//! **A brief is never refused over a setting.** No instance, no database file,
//! an unreadable store, a key of the wrong type — every one of them is a state
//! rather than an error, and every one resolves to the default with a line on
//! stderr naming what was skipped.

use std::path::PathBuf;
use std::process::ExitCode;

use serde::Serialize;
use tugarc_core::brief::{self as record, BriefOutcome, BriefRecord};
use tugarc_core::cycle::{self, PlaceBrief, Placed};
use tugcore::instance::Paths;
use tugtool_core::briefs::{
    BRIEFS_PATH_DOMAIN, BRIEFS_PATH_KEY, DEFAULT_BRIEFS_TEMPLATE, resolve_briefs_dir,
};

use crate::changes::{self, AppError};
use crate::cli::BriefCommands;
use crate::output::print_ok;

/// The `--json` payload of `brief dir`.
#[derive(Serialize)]
struct BriefDirData {
    dir: String,
    exists: bool,
    /// `"setting"` when the template came from tugbank, `"default"` otherwise.
    source: &'static str,
    project_dir: String,
    template: String,
}

/// Dispatch a `brief` subcommand.
pub fn dispatch(cmd: BriefCommands, json: bool) -> ExitCode {
    let paths = Paths::from_env();
    let (command, result) = match cmd {
        BriefCommands::Dir { ensure } => ("brief dir", run_dir(ensure, json)),
        BriefCommands::Record {
            path,
            sketch,
            from_brief,
            cycle,
            name,
            wait,
            note,
        } => {
            let req = RecordRequest {
                path: &path,
                sketches: sketch,
                from_brief: from_brief.as_deref(),
                cycle: cycle.as_deref(),
                name: name.as_deref(),
                waits: wait,
                note: note.as_deref(),
            };
            ("brief record", run_record(&paths, req, json))
        }
        BriefCommands::Show { brief } => ("brief show", run_show(&paths, &brief, json)),
        BriefCommands::Find {
            path,
            sketch,
            session,
        } => (
            "brief find",
            run_find(&paths, path.as_deref(), sketch.as_deref(), session.as_deref(), json),
        ),
        BriefCommands::List => ("brief list", run_find(&paths, None, None, None, json)),
    };
    changes::finish(command, json, result)
}

fn repo() -> Result<PathBuf, AppError> {
    tugtool_core::find_repo_root().map_err(|e| AppError::Exit1("not_a_repository", e.to_string()))
}

/// What `brief record` was given.
struct RecordRequest<'a> {
    path: &'a str,
    sketches: Vec<String>,
    from_brief: Option<&'a str>,
    cycle: Option<&'a str>,
    name: Option<&'a str>,
    waits: Vec<u32>,
    note: Option<&'a str>,
}

/// The `--json` payload of `brief record`.
#[derive(Serialize)]
struct RecordPayload {
    brief: BriefOutcome,
    placed: Option<Placed>,
}

/// Record the brief, then, when it came from a sketch or a brief, put it on
/// its cycle. The record is written first so a placement that is refused
/// still leaves the brief with its id.
fn run_record(paths: &Paths, req: RecordRequest, json: bool) -> Result<(), AppError> {
    let repo = repo()?;
    let by = crate::session_identity::work_by(None);
    let path = crate::cycle::brief_path(&repo, req.path);
    let outcome = record::record(paths, &repo, &path, &req.sketches, &by)?;
    let from_brief = req.from_brief.map(|b| crate::cycle::brief_path(&repo, b));
    let placed = if req.sketches.is_empty() && from_brief.is_none() {
        None
    } else {
        Some(cycle::place_brief(
            paths,
            &repo,
            PlaceBrief {
                brief: &path,
                sketch: req.sketches.first().map(String::as_str),
                from_brief: from_brief.as_deref(),
                cycle: req.cycle,
                name: req.name,
                waits: req.waits,
                note: req.note,
                by: &by,
            },
        )?)
    };
    if json {
        print_ok(
            "brief record",
            RecordPayload {
                brief: outcome,
                placed,
            },
        );
    } else {
        println!("{}", outcome.id);
    }
    Ok(())
}

/// Where a brief sits on a cycle: an entry that holds it, or a sketch it
/// wrote up.
#[derive(Serialize)]
struct Placement {
    cycle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    n: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    letter: Option<String>,
}

/// The `--json` payload of `brief show`.
#[derive(Serialize)]
struct ShowPayload {
    #[serde(flatten)]
    record: BriefRecord,
    placements: Vec<Placement>,
}

/// Whether `text` is shaped like a record id: eight lowercase hex characters.
fn looks_like_id(text: &str) -> bool {
    text.len() == 8 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn run_show(paths: &Paths, brief: &str, json: bool) -> Result<(), AppError> {
    let found = if looks_like_id(brief) {
        record::find_brief(paths, brief).into_iter().next().map(|(_, r)| r)
    } else {
        let repo = repo()?;
        record::resolve(paths, &repo, &crate::cycle::brief_path(&repo, brief))
    };
    let Some(mut found) = found else {
        return Err(AppError::Exit3(
            "brief_absent",
            format!("no brief record answers for {brief}"),
        ));
    };
    let project = PathBuf::from(&found.project_dir);
    if let Err(e) = record::refresh_versions(paths, &project, &mut found) {
        eprintln!("brief show: could not read the brief's commits: {e}");
    }
    let mut placements = Vec::new();
    for c in cycle::all_cycles(paths)
        .into_iter()
        .filter(|c| c.project_dir == found.project_dir)
    {
        for e in c.entries.iter().filter(|e| e.brief_id == found.id) {
            placements.push(Placement {
                cycle: c.id.clone(),
                n: Some(e.n),
                letter: None,
            });
        }
        for s in c
            .sketches
            .iter()
            .filter(|s| s.brief_id.as_deref() == Some(found.id.as_str()))
        {
            placements.push(Placement {
                cycle: c.id.clone(),
                n: None,
                letter: Some(s.letter.clone()),
            });
        }
    }
    if json {
        print_ok(
            "brief show",
            ShowPayload {
                record: found,
                placements,
            },
        );
        return Ok(());
    }
    println!("{}  {}", found.id, found.path);
    if let Some(title) = &found.title {
        println!("title     {title}");
    }
    if !found.sketches.is_empty() {
        println!("sketches  {}", found.sketches.join(", "));
    }
    for v in &found.versions {
        println!("version   {}  {}", v.sha, v.at);
    }
    for p in &placements {
        match (p.n, &p.letter) {
            (Some(n), _) => println!("entry     {}  {n}", p.cycle),
            (None, Some(letter)) => println!("sketch    {}  {letter}", p.cycle),
            (None, None) => {}
        }
    }
    Ok(())
}

/// One brief in a `find` or `list` answer.
#[derive(Serialize)]
struct ListedBrief {
    id: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    updated: String,
}

/// This checkout's briefs that match, the most recently changed first: the
/// one at `path`, the ones `sketch` led to, the ones `session` wrote, or
/// every one when nothing narrows it.
fn run_find(
    paths: &Paths,
    path: Option<&str>,
    sketch: Option<&str>,
    session: Option<&str>,
    json: bool,
) -> Result<(), AppError> {
    let repo = repo()?;
    let found: Vec<BriefRecord> = match path {
        Some(path) => record::resolve(paths, &repo, &crate::cycle::brief_path(&repo, path))
            .into_iter()
            .collect(),
        None => record::briefs(paths, &repo)
            .into_iter()
            .filter(|b| sketch.is_none_or(|s| b.sketches.iter().any(|k| k == s)))
            .filter(|b| session.is_none_or(|s| b.written_by.as_deref() == Some(s)))
            .collect(),
    };
    let listed: Vec<ListedBrief> = found
        .into_iter()
        .map(|b| ListedBrief {
            updated: b.updated().to_string(),
            id: b.id,
            path: b.path,
            title: b.title,
        })
        .collect();
    let command = if path.is_none() && sketch.is_none() && session.is_none() {
        "brief list"
    } else {
        "brief find"
    };
    if json {
        print_ok(command, listed);
        return Ok(());
    }
    for b in &listed {
        println!("{}  {}  {}", b.id, b.path, b.title.as_deref().unwrap_or(""));
    }
    Ok(())
}

/// Read the briefs-path template out of the instance's tugbank.
///
/// `None` for every state that is not a stored non-empty string: no instance,
/// no database file yet, a store that will not open, a missing key, a value of
/// another type. The store is opened only when the file already exists, so a
/// short-lived CLI never creates one.
fn read_briefs_template() -> Option<String> {
    let path = tugcore::instance::tugbank_db_path()?;
    if !path.is_file() {
        return None;
    }
    let store = match tugbank_core::DefaultsStore::open(&path) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("brief dir: reading the briefs-path setting: {e}; using the default");
            return None;
        }
    };
    let domain = match store.domain(BRIEFS_PATH_DOMAIN) {
        Ok(domain) => domain,
        Err(e) => {
            eprintln!("brief dir: reading the briefs-path setting: {e}; using the default");
            return None;
        }
    };
    match domain.get(BRIEFS_PATH_KEY) {
        Ok(Some(tugbank_core::Value::String(s))) if !s.is_empty() => Some(s),
        Ok(_) => None,
        Err(e) => {
            eprintln!("brief dir: reading the briefs-path setting: {e}; using the default");
            None
        }
    }
}

fn run_dir(ensure: bool, json: bool) -> Result<(), AppError> {
    let project_dir = tugtool_core::find_project_root().map_err(|_| {
        AppError::Exit1(
            "failed",
            "not inside a project — run from a checkout".to_string(),
        )
    })?;

    let (template, source) = match read_briefs_template() {
        Some(t) => (t, "setting"),
        None => (DEFAULT_BRIEFS_TEMPLATE.to_string(), "default"),
    };
    let dir = resolve_briefs_dir(&project_dir, &template);

    if ensure {
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::Exit1("failed", format!("cannot create {}: {e}", dir.display()))
        })?;
    }

    if json {
        print_ok(
            "brief dir",
            BriefDirData {
                dir: dir.to_string_lossy().into_owned(),
                exists: dir.is_dir(),
                source,
                project_dir: project_dir.to_string_lossy().into_owned(),
                template,
            },
        );
    } else {
        println!("{}", dir.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn the_default_template_is_the_projects_own_briefs() {
        let dir = resolve_briefs_dir(Path::new("/tmp/proj"), DEFAULT_BRIEFS_TEMPLATE);
        assert_eq!(dir, PathBuf::from("/tmp/proj/briefs"));
    }

    #[test]
    fn an_absolute_template_is_used_as_written() {
        let dir = resolve_briefs_dir(Path::new("/tmp/proj"), "/Users/x/all-briefs");
        assert_eq!(dir, PathBuf::from("/Users/x/all-briefs"));
    }

    #[test]
    fn a_relative_template_resolves_under_the_project() {
        let dir = resolve_briefs_dir(Path::new("/tmp/proj"), "writing");
        assert_eq!(dir, PathBuf::from("/tmp/proj/writing"));
    }

    #[test]
    fn every_placeholder_is_replaced() {
        let dir = resolve_briefs_dir(
            Path::new("/tmp/proj"),
            "{project_dir}/docs/{project_dir}/briefs",
        );
        assert_eq!(dir, PathBuf::from("/tmp/proj/docs/tmp/proj/briefs"));
    }
}
