//! The `apptest` namespace — `tugtool apptest record|history|reach`.
//!
//! The app-test recipe's only way into the results ledger. The recipe holds
//! the run's arrays and shells them here; nothing in bash ever opens SQLite,
//! so no foreign SQLite build ever participates in a live ledger's WAL.
//!
//! Both verbs print bare JSON rather than the `--json` envelope the other
//! namespaces use: the recipe pipes them straight into `jq`, and a wrapper it
//! would only have to unwrap is a shape with no reader.

use std::io::Read;
use std::path::{Path, PathBuf};

use tugtool_core::apptest_ledger::{self, ReachRecord, RunRecord};

use crate::changes::AppError;

/// Where the ledger lives for this invocation — the env override first, so
/// the CLI suite and the recipe's own integration checks never touch the
/// real record.
fn ledger_path() -> PathBuf {
    apptest_ledger::default_path()
}

/// Record one run, read as S02 JSON on stdin.
pub fn run_record() -> Result<(), AppError> {
    let mut payload = String::new();
    std::io::stdin()
        .read_to_string(&mut payload)
        .map_err(|err| AppError::Exit1(format!("cannot read the run payload: {err}")))?;
    let run: RunRecord = serde_json::from_str(&payload)
        .map_err(|err| AppError::Exit1(format!("malformed run payload: {err}")))?;
    let mut conn = apptest_ledger::open_ledger(ledger_path())
        .map_err(|err| AppError::Exit1(format!("cannot open the results ledger: {err}")))?;
    let recorded = apptest_ledger::record_run(&mut conn, &run)
        .map_err(|err| AppError::Exit1(format!("cannot record the run: {err}")))?;
    println!(
        "{}",
        serde_json::json!({
            "recorded": true,
            "runId": recorded.run_id,
            "pruned": recorded.pruned,
        })
    );
    Ok(())
}

/// The run root's base checkout, every query's key.
fn base_root(root: Option<PathBuf>) -> Result<String, AppError> {
    let root = match root {
        Some(r) => r,
        None => std::env::current_dir()
            .map_err(|err| AppError::Exit1(format!("cannot resolve the run root: {err}")))?,
    };
    Ok(apptest_ledger::resolve_base_root(Path::new(&root)))
}

/// Answer each named file's history for the run root's base checkout.
pub fn run_history(root: Option<PathBuf>, files: Vec<String>) -> Result<(), AppError> {
    let base_root = base_root(root)?;
    let conn = apptest_ledger::open_ledger(ledger_path())
        .map_err(|err| AppError::Exit1(format!("cannot open the results ledger: {err}")))?;
    let answers = apptest_ledger::file_history(&conn, &base_root, &files)
        .map_err(|err| AppError::Exit1(format!("cannot read the results ledger: {err}")))?;
    println!("{}", serde_json::json!({ "files": answers }));
    Ok(())
}

/// Store one run's reach maps, read as JSON on stdin.
pub fn run_reach_record() -> Result<(), AppError> {
    let mut payload = String::new();
    std::io::stdin()
        .read_to_string(&mut payload)
        .map_err(|err| AppError::Exit1(format!("cannot read the reach payload: {err}")))?;
    let rec: ReachRecord = serde_json::from_str(&payload)
        .map_err(|err| AppError::Exit1(format!("malformed reach payload: {err}")))?;
    let mut conn = apptest_ledger::open_ledger(ledger_path())
        .map_err(|err| AppError::Exit1(format!("cannot open the results ledger: {err}")))?;
    let stored = apptest_ledger::record_reach(&mut conn, &rec)
        .map_err(|err| AppError::Exit1(format!("cannot record the reach maps: {err}")))?;
    println!(
        "{}",
        serde_json::json!({ "recorded": true, "files": stored })
    );
    Ok(())
}

/// Print each named file's stored reach map, for the run root's base checkout.
pub fn run_reach_show(root: Option<PathBuf>, files: Vec<String>) -> Result<(), AppError> {
    let base_root = base_root(root)?;
    let conn = apptest_ledger::open_ledger(ledger_path())
        .map_err(|err| AppError::Exit1(format!("cannot open the results ledger: {err}")))?;
    let rows = apptest_ledger::reach_for(&conn, &base_root, &files)
        .map_err(|err| AppError::Exit1(format!("cannot read the results ledger: {err}")))?;
    // Serialized directly rather than through `json!`, which would parse each
    // stored map into a `Value` and re-order its keys; the map prints verbatim.
    let rows = serde_json::to_string(&rows)
        .map_err(|err| AppError::Exit1(format!("cannot render the reach maps: {err}")))?;
    println!("{{\"files\":{rows}}}");
    Ok(())
}
