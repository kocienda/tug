//! The `apptest` namespace — `tugtool apptest record|history`.
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

use tugtool_core::apptest_ledger::{self, RunRecord};

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

/// Answer each named file's history for the run root's base checkout.
pub fn run_history(root: Option<PathBuf>, files: Vec<String>) -> Result<(), AppError> {
    let root = match root {
        Some(r) => r,
        None => std::env::current_dir()
            .map_err(|err| AppError::Exit1(format!("cannot resolve the run root: {err}")))?,
    };
    let base_root = apptest_ledger::resolve_base_root(Path::new(&root));
    let conn = apptest_ledger::open_ledger(ledger_path())
        .map_err(|err| AppError::Exit1(format!("cannot open the results ledger: {err}")))?;
    let answers = apptest_ledger::file_history(&conn, &base_root, &files)
        .map_err(|err| AppError::Exit1(format!("cannot read the results ledger: {err}")))?;
    println!("{}", serde_json::json!({ "files": answers }));
    Ok(())
}
