//! Plans — the `tugutil plan …` namespace. A thin shell over
//! [`tugutil_core::plan`]: read the document named on the command line, parse
//! it, run the rules, and format the outcome as `--json` (the shared
//! `{schema_version, command, status, data, issues}` envelope) or a plain
//! read-out.
//!
//! The path is explicit. There is no `resolve_plan` cascade here and no search
//! across the project's plan directories — a linter that guesses which document
//! you meant is worse than one that asks.

use std::path::Path;
use std::process::ExitCode;

use serde::Serialize;
use tugutil_core::plan::{self, Severity};

use crate::changes::{self, AppError};
use crate::cli::PlanCommands;
use crate::output::{JsonIssue, JsonResponse};

/// Dispatch a `plan` subcommand. Exit 0 clean-or-warnings, 1 on any error
/// diagnostic, 2 when the document cannot be read or is not a plan.
pub fn dispatch(cmd: PlanCommands, json: bool) -> ExitCode {
    changes::finish(match cmd {
        PlanCommands::Lint { path } => run_lint(Path::new(&path), json),
        PlanCommands::Status { path } => run_status(Path::new(&path), json),
        PlanCommands::Stamp { path } => run_stamp(Path::new(&path), json),
    })
}

/// `--json` payload for `plan lint`. The diagnostics themselves ride in the
/// envelope's `issues`, which already carries exactly a lint diagnostic's shape.
#[derive(Debug, Serialize)]
struct LintData {
    /// The document that was linted, as it was named on the command line.
    path: String,
    /// How many error-severity diagnostics the run produced.
    errors: usize,
    /// How many warning-severity diagnostics the run produced.
    warnings: usize,
}

fn run_lint(path: &Path, json: bool) -> Result<(), AppError> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| AppError::Exit2(format!("{}: {e}", path.display())))?;

    let doc =
        plan::parse(&source).map_err(|e| AppError::Exit2(format!("{}: {e}", path.display())))?;

    let diagnostics = plan::lint(&doc);
    let errors = diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .count();
    let warnings = diagnostics.len() - errors;

    if json {
        let data = LintData {
            path: path.display().to_string(),
            errors,
            warnings,
        };
        let issues: Vec<JsonIssue> = diagnostics
            .iter()
            .map(|d| JsonIssue {
                code: d.code.clone(),
                severity: d.severity.as_str().to_string(),
                message: d.message.clone(),
                file: Some(path.display().to_string()),
                line: d.line,
                anchor: d.anchor.as_ref().map(|a| format!("#{a}")),
            })
            .collect();
        // `print_ok` hardcodes `status: "ok"`, so a run carrying an error
        // diagnostic has to build its own envelope.
        let response = if errors > 0 {
            JsonResponse::error("plan lint", data, issues)
        } else {
            let mut ok = JsonResponse::ok("plan lint", data);
            ok.issues = issues;
            ok
        };
        println!("{}", serde_json::to_string_pretty(&response).unwrap());
    } else {
        for d in &diagnostics {
            match d.line {
                Some(line) => println!(
                    "{}:{}: {} {} {}",
                    path.display(),
                    line,
                    d.code,
                    d.severity,
                    d.message
                ),
                None => println!(
                    "{}: {} {} {}",
                    path.display(),
                    d.code,
                    d.severity,
                    d.message
                ),
            }
        }
        println!(
            "{}: {} error{}, {} warning{}",
            path.display(),
            errors,
            if errors == 1 { "" } else { "s" },
            warnings,
            if warnings == 1 { "" } else { "s" }
        );
    }

    if errors > 0 {
        return Err(AppError::Exit1(format!(
            "{}: {errors} error diagnostic{}",
            path.display(),
            if errors == 1 { "" } else { "s" }
        )));
    }
    Ok(())
}

/// `--json` payload for `plan status`.
#[derive(Debug, Serialize)]
struct StatusData {
    /// The document that was read, as it was named on the command line.
    path: String,
    /// `reviewed`, `stale`, or `never-reviewed`.
    review: String,
    /// The document's content stamp as of now — the value a round's stamp
    /// would have to equal to read `reviewed`.
    content_hash: String,
    /// How many rounds the Review Record declares.
    rounds: usize,
    /// The newest round, or `null` when there are none.
    last_round: Option<RoundData>,
    /// Lint counts, for the reader's convenience. `status` never gates on them.
    lint: LintCounts,
    /// Ledger progress.
    steps: StepCounts,
}

#[derive(Debug, Serialize)]
struct RoundData {
    number: usize,
    date: String,
    model: String,
    /// `null` when the round carries no content stamp.
    stamp: Option<String>,
}

#[derive(Debug, Serialize)]
struct LintCounts {
    errors: usize,
    warnings: usize,
}

#[derive(Debug, Serialize)]
struct StepCounts {
    total: usize,
    done: usize,
    in_progress: usize,
    pending: usize,
}

/// Read a plan's review state.
///
/// The verdict is data, never an exit code: the callers are a skill's setup
/// gate and a feed projection, and both want to *read* the answer. An exit code
/// that encoded staleness would force every caller to tell "stale" apart from
/// "broken", which is the distinction exit 2 already draws.
fn run_status(path: &Path, json: bool) -> Result<(), AppError> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| AppError::Exit2(format!("{}: {e}", path.display())))?;
    let doc =
        plan::parse(&source).map_err(|e| AppError::Exit2(format!("{}: {e}", path.display())))?;

    let diagnostics = plan::lint(&doc);
    let errors = diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .count();

    let count = |status: &str| {
        doc.ledger_rows
            .iter()
            .filter(|r| r.status == status)
            .count()
    };
    let data = StatusData {
        path: path.display().to_string(),
        review: plan::review_state(&doc, &source).as_str().to_string(),
        content_hash: plan::content_stamp(&doc, &source),
        rounds: doc.review_rounds.len(),
        last_round: doc.review_rounds.last().map(|r| RoundData {
            number: r.number,
            date: r.date.clone(),
            model: r.model.clone(),
            stamp: r.stamp.clone(),
        }),
        lint: LintCounts {
            errors,
            warnings: diagnostics.len() - errors,
        },
        steps: StepCounts {
            total: doc.ledger_rows.len(),
            done: count("done"),
            in_progress: count("in progress"),
            pending: count("pending"),
        },
    };

    if json {
        crate::output::print_ok("plan status", &data);
    } else {
        println!("path: {}", data.path);
        println!("content hash: {}", data.content_hash);
        println!("rounds: {}", data.rounds);
        match &data.last_round {
            Some(round) => println!(
                "last round: {} — {}, {} ({})",
                round.number,
                round.date,
                round.model,
                round.stamp.as_deref().unwrap_or("no stamp")
            ),
            None => println!("last round: none"),
        }
        println!(
            "lint: {} error{}, {} warning{}",
            data.lint.errors,
            if data.lint.errors == 1 { "" } else { "s" },
            data.lint.warnings,
            if data.lint.warnings == 1 { "" } else { "s" }
        );
        println!(
            "steps: {} total, {} done, {} in progress, {} pending",
            data.steps.total, data.steps.done, data.steps.in_progress, data.steps.pending
        );
        println!("review: {}", data.review);
    }
    Ok(())
}

/// `--json` payload for `plan stamp`.
#[derive(Debug, Serialize)]
struct StampData {
    /// The document that was stamped.
    path: String,
    /// The stamp that was written.
    stamp: String,
    /// The round it was written into.
    round: usize,
}

/// Write the content stamp into a plan's newest Review Record round.
///
/// The file is written only after [`plan::set_review_stamp`] has re-parsed its
/// own output and confirmed the stamp reads back — a refusal leaves the
/// document byte-identical.
fn run_stamp(path: &Path, json: bool) -> Result<(), AppError> {
    use plan::StampError;

    let source = std::fs::read_to_string(path)
        .map_err(|e| AppError::Exit2(format!("{}: {e}", path.display())))?;

    let edited = plan::set_review_stamp(&source).map_err(|e| match e {
        StampError::NotAPlan => AppError::Exit2(format!("{}: {e}", path.display())),
        StampError::NoRecord => AppError::Exit1(format!(
            "{}: no Review Record section — a stamp records what a review read, \
             so there has to be a review",
            path.display()
        )),
        StampError::NoRound => AppError::Exit1(format!(
            "{}: no review round to stamp — write the round paragraph first",
            path.display()
        )),
        StampError::AlreadyStamped { round, stamp } => AppError::Exit1(format!(
            "{}: round {round} is already stamped `plan:{stamp}` — two stamps on one round \
             cannot both be true, so append a new round instead",
            path.display()
        )),
        StampError::RoundTrip => AppError::Exit1(format!(
            "{}: the stamped round did not read back; nothing was written",
            path.display()
        )),
    })?;

    let doc =
        plan::parse(&edited).map_err(|e| AppError::Exit1(format!("{}: {e}", path.display())))?;
    let round = doc.review_rounds.last().ok_or_else(|| {
        AppError::Exit1(format!("{}: the stamped round vanished", path.display()))
    })?;
    let data = StampData {
        path: path.display().to_string(),
        stamp: round.stamp.clone().unwrap_or_default(),
        round: round.number,
    };

    std::fs::write(path, &edited)
        .map_err(|e| AppError::Exit1(format!("{}: {e}", path.display())))?;

    if json {
        crate::output::print_ok("plan stamp", &data);
    } else {
        println!(
            "{}: round {} stamped `plan:{}`",
            data.path, data.round, data.stamp
        );
    }
    Ok(())
}
