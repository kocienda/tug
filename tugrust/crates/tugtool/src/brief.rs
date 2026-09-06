//! Briefs — the `tugtool brief …` namespace.
//!
//! One verb: `dir`, which answers where a brief is written. The answer is the
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

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde::Serialize;

use crate::changes::{self, AppError};
use crate::cli::BriefCommands;
use crate::output::print_ok;

/// The tugbank domain the briefs directory is stored under — the app's own,
/// beside `default-project-path`.
pub const BRIEFS_PATH_DOMAIN: &str = "dev.tugapp.app";

/// The tugbank key holding the briefs-directory template.
pub const BRIEFS_PATH_KEY: &str = "briefs-path";

/// The template used when the key is unset. Held in the binary and never
/// written to the store, so an unset key keeps meaning "the project's own".
pub const DEFAULT_BRIEFS_TEMPLATE: &str = "{project_dir}/briefs";

/// The one placeholder a template may carry, spelled like the `{paths}` and
/// `{base}` of the arc surface contract.
const PROJECT_DIR_PLACEHOLDER: &str = "{project_dir}";

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
    changes::finish(match cmd {
        BriefCommands::Dir { ensure } => run_dir(ensure, json),
    })
}

/// Resolve a template against a project directory.
///
/// Every `{project_dir}` is replaced; a result that is still relative is
/// joined under the project, so a bare `writing` means the project's own
/// `writing/` and an absolute path means itself — one directory for every
/// project, if that is what the user wants.
fn resolve_briefs_dir(project_dir: &Path, template: &str) -> PathBuf {
    let expanded = template.replace(PROJECT_DIR_PLACEHOLDER, &project_dir.to_string_lossy());
    let candidate = PathBuf::from(expanded);
    if candidate.is_absolute() {
        candidate
    } else {
        project_dir.join(candidate)
    }
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
    let project_dir = tugtool_core::find_project_root()
        .map_err(|_| AppError::Exit1("not inside a project — run from a checkout".to_string()))?;

    let (template, source) = match read_briefs_template() {
        Some(t) => (t, "setting"),
        None => (DEFAULT_BRIEFS_TEMPLATE.to_string(), "default"),
    };
    let dir = resolve_briefs_dir(&project_dir, &template);

    if ensure {
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Exit1(format!("cannot create {}: {e}", dir.display())))?;
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
