//! What every recipe reads from and hands back.

use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tugchanges_core::{git_output, repo_root_for};
use tugcore::host_tools;
use tugcore::instance::Paths;
use tugcore::report_gaps::ReportGaps;
use tugtool_core::{apptest_ledger, test_ledger};

/// The per-file budget an app-test runs under when the environment names none.
const DEFAULT_APPTEST_BUDGET_SECS: f64 = 20.0;

/// Where a recipe's data lives, for one project.
#[derive(Debug, Clone)]
pub struct RecipeContext {
    pub repo_root: PathBuf,
    pub paths: Paths,
    pub test_ledger: PathBuf,
    pub apptest_ledger: PathBuf,
    pub report_gaps: PathBuf,
    pub apptest_budget_secs: f64,
}

impl RecipeContext {
    /// The context for `project_dir`. Finding the repository root runs git, so
    /// on a machine with no usable git the directory stands in for it, and
    /// [`git_gate`] is what then answers every commit recipe.
    pub fn for_project(project_dir: &Path) -> RecipeContext {
        let repo_root = if host_tools::cached_probe().is_usable() {
            repo_root_for(project_dir)
        } else {
            project_dir.to_path_buf()
        };
        let apptest_budget_secs = std::env::var("TUG_APPTEST_FILE_BUDGET_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|secs: &f64| *secs > 0.0)
            .unwrap_or(DEFAULT_APPTEST_BUDGET_SECS);
        RecipeContext {
            repo_root,
            paths: Paths::from_env(),
            test_ledger: test_ledger::default_path(),
            apptest_ledger: apptest_ledger::default_path(),
            report_gaps: ReportGaps::default_path(),
            apptest_budget_secs,
        }
    }
}

/// Every argument any recipe takes. A recipe's `args` list says which of these
/// its parser accepts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecipeArgs {
    pub days: Option<u32>,
    pub path: Option<String>,
    pub range: Option<String>,
    pub staged: bool,
    pub session: bool,
    pub title: Option<String>,
    pub suites: Vec<String>,
    pub all: bool,
    pub runs: Option<usize>,
    pub depth: Option<u32>,
    pub limit: Option<usize>,
    pub subjects: Vec<String>,
}

/// A recipe's answer: a chart with the line that sums it up, or the line that
/// says why there is none. Having nothing to draw is not an error.
#[derive(Debug, Clone, PartialEq)]
pub enum RecipeOutcome {
    Chart { summary: String, spec: Value },
    NoData { summary: String },
}

/// A read that should have worked, such as a `--range` naming no commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecipeError {
    Git(String),
    Ledger(String),
}

impl fmt::Display for RecipeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecipeError::Git(message) | RecipeError::Ledger(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for RecipeError {}

/// `text` within `max` characters, losing its front, since the end of a path
/// is the part that says where it is.
pub(crate) fn clip_front(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let kept: String = text.chars().skip(count - max.saturating_sub(1)).collect();
    format!("…{kept}")
}

/// A file's row label: its last path component without `.test.ts`.
pub fn row_label(file: &str) -> String {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.strip_suffix(".test.ts").unwrap_or(name).to_string()
}

/// `--title`, over the title the recipe chose.
pub fn apply_title(spec: &mut Value, args: &RecipeArgs) {
    if let Some(title) = &args.title {
        spec["title"] = json!(title);
    }
}

/// The answer a commit recipe gives before reading anything, when there is
/// nothing it could read: no usable git on this machine, or no history at
/// `repo_root`, which is the same answer for a directory that is not a
/// repository and a repository with no commits.
pub fn git_gate(ctx: &RecipeContext) -> Option<RecipeOutcome> {
    if !host_tools::cached_probe().is_usable() {
        return Some(RecipeOutcome::NoData {
            summary: "no usable git on this machine".to_string(),
        });
    }
    let has_history = git_output(&ctx.repo_root, &["rev-parse", "--verify", "-q", "HEAD"])
        .is_ok_and(|out| out.status.success());
    (!has_history).then(|| RecipeOutcome::NoData {
        summary: format!("no commits in {}", ctx.repo_root.display()),
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use tuggraphics::{Layers, validate};

    /// A context whose ledgers are all under `dir`, none of them there yet.
    pub(crate) fn context_at(dir: &Path) -> RecipeContext {
        RecipeContext {
            repo_root: dir.to_path_buf(),
            paths: Paths::from_env(),
            test_ledger: dir.join("test_results.db"),
            apptest_ledger: dir.join("apptest_results.db"),
            report_gaps: dir.join("report_gaps.db"),
            apptest_budget_secs: DEFAULT_APPTEST_BUDGET_SECS,
        }
    }

    pub(crate) fn assert_valid(spec: &Value) {
        let source = serde_json::to_string(spec).unwrap();
        if let Err(errors) = validate(&source, Layers::Chart) {
            let listed: Vec<String> = errors
                .iter()
                .map(|e| format!("{}: {}", e.path, e.message))
                .collect();
            panic!("{}", listed.join("; "));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_that_is_no_repository_has_no_data() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = RecipeContext::for_project(dir.path());
        assert!(matches!(git_gate(&ctx), Some(RecipeOutcome::NoData { .. })));
    }

    #[test]
    fn a_title_argument_replaces_the_title() {
        let mut spec = json!({ "title": "chosen" });
        apply_title(&mut spec, &RecipeArgs::default());
        assert_eq!(spec["title"], "chosen");
        let args = RecipeArgs {
            title: Some("named".to_string()),
            ..Default::default()
        };
        apply_title(&mut spec, &args);
        assert_eq!(spec["title"], "named");
    }

    #[test]
    fn a_row_label_is_the_file_name_without_its_suffix() {
        assert_eq!(row_label("tests/app-test/at0001-a.test.ts"), "at0001-a");
        assert_eq!(row_label("plain"), "plain");
    }
}
