//! Implementation of the `tugtool host state-dir` command.
//!
//! Prints the per-project runtime-state directory (`project_state_dir`) so
//! shell consumers — the `Justfile`, the host — resolve the path without
//! re-deriving the project slug. The directory is created if absent, so callers
//! can write into it immediately.

use std::fs;

use tugtool_core::{find_repo_root, project_state_dir};

use crate::output::JsonResponse;

#[derive(serde::Serialize)]
struct StateDirData {
    path: String,
}

/// Run the `state-dir` command.
pub fn run_state_dir(json: bool, quiet: bool) -> Result<i32, String> {
    let repo_root = find_repo_root().map_err(|e| e.to_string())?;
    let dir = project_state_dir(&repo_root);
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create state dir: {}", e))?;

    let path = dir.to_string_lossy().into_owned();
    if json {
        let response = JsonResponse::ok("state-dir", StateDirData { path: path.clone() });
        println!("{}", serde_json::to_string_pretty(&response).unwrap());
    } else if !quiet {
        println!("{}", path);
    }
    Ok(0)
}
