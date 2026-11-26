//! `tugtool sketch record|show` — a sketch's record, kept and read back.
//!
//! `record` keeps an arc's working `sketch.md` as a version under the
//! sketch's own id, or, with no arc, the sketch text it reads on stdin as a
//! sketch tied to no arc. `show` reads a version back by id, from any checkout's
//! store on this machine, so it needs no repository.

use serde::Serialize;
use std::io::{IsTerminal, Read};
use std::process::ExitCode;
use tugarc_core::sketch::{self, SketchArc, SketchVersion};
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
        SketchCommands::Record { arc, id } => match run_record(&paths, arc, id, json) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => e.report("sketch record", json),
        },
        SketchCommands::Show {
            id,
            version,
            versions,
        } => run_show(&paths, &id, version, versions, json),
    }
}

fn run_record(
    paths: &Paths,
    arc: Option<String>,
    id: Option<String>,
    json: bool,
) -> Result<(), AppError> {
    let repo = tugtool_core::find_repo_root()
        .map_err(|e| AppError::Exit1("not_a_repository", e.to_string()))?;
    let out = match arc {
        Some(arc) => sketch::record_arc_sketch(paths, &repo, &arc)?,
        None => {
            if std::io::stdin().is_terminal() {
                return Err(AppError::Exit1(
                    "no_sketch",
                    "name an arc, or pipe the sketch text on stdin".into(),
                ));
            }
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).map_err(|e| {
                AppError::Exit1(
                    "stdin_unreadable",
                    format!("could not read the sketch: {e}"),
                )
            })?;
            sketch::record_free_sketch(paths, &repo, &text, id.as_deref())?
        }
    };
    if json {
        print_ok("sketch record", &out);
        return Ok(());
    }
    let tail = if out.minted {
        " (minted)"
    } else if !out.appended {
        " (unchanged)"
    } else {
        ""
    };
    println!("sketch {} v{}{tail}", out.id, out.version);
    Ok(())
}

/// What `sketch show --json` prints.
#[derive(Serialize)]
struct ShowPayload {
    id: String,
    project_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    arc: Option<SketchArc>,
    versions: Vec<SketchVersion>,
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
                versions: record.versions,
                text,
            },
        );
    } else {
        print!("{text}");
    }
    ExitCode::SUCCESS
}
