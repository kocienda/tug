//! What every recipe reads from and hands back.

use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tugchanges_core::{LineKinds, git_output, repo_root_for};
use tugcore::host_tools;
use tugcore::instance::Paths;
use tugcore::report_gaps::ReportGaps;
use tuggraphics::chart::{Layers, Source, histogram_bins, validate};
use tugtool_core::{apptest_ledger, test_ledger};
use tugtool_core::config::Config;

use crate::members::MemberTable;

/// Where a recipe's data lives, for one project.
#[derive(Debug, Clone)]
pub struct RecipeContext {
    pub repo_root: PathBuf,
    pub paths: Paths,
    pub apptest_ledger: PathBuf,
    /// The unit-test ledger: every suite run `tugtool test run` recorded.
    pub test_ledger: PathBuf,
    pub report_gaps: PathBuf,
    /// How the line recipes classify a path: the project's `[tugtool.lines]`
    /// over the built-in patterns. A config that fails to load, or a pattern
    /// that does not compile, is the error, and only the recipes that count
    /// lines answer it.
    pub line_kinds: Result<LineKinds, String>,
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
        RecipeContext {
            line_kinds: line_kinds_for(&repo_root),
            repo_root,
            paths: Paths::from_env(),
            apptest_ledger: apptest_ledger::default_path(),
            test_ledger: test_ledger::default_path(),
            report_gaps: ReportGaps::default_path(),
        }
    }
}

/// The classifier `repo_root` declares in its `.tugtool/config.toml`, or the
/// built-in one when it declares none.
fn line_kinds_for(repo_root: &Path) -> Result<LineKinds, String> {
    let config = Config::load_from_project(repo_root).map_err(|e| e.to_string())?;
    let lines = config.tugtool.lines;
    LineKinds::from_patterns(
        lines.tests.as_deref(),
        lines.data.as_deref(),
        lines.docs.as_deref(),
    )
}

/// Every argument any recipe takes. A recipe's `args` list says which of these
/// its parser accepts. `since` and `until` are set only from a chart's
/// `source`, never from a flag: a re-run reads by the window the first run
/// stamped, and the command line keeps `days`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecipeArgs {
    pub days: Option<u32>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub path: Option<String>,
    pub range: Option<String>,
    pub staged: bool,
    pub session: bool,
    pub title: Option<String>,
    pub by: Option<String>,
    pub net: bool,
    /// One series per kind of file, for a line recipe that splits.
    pub split: bool,
    pub depth: Option<u32>,
    pub limit: Option<usize>,
    pub kind: Option<String>,
    pub form: Option<String>,
    pub subjects: Vec<String>,
    /// Which kinds of file a line recipe counts (`code` when absent).
    pub lines: Option<String>,
}

/// A recipe's answer: a chart with the line that sums it up, or the line that
/// says why there is none. Having nothing to draw is not an error. A chart
/// comes with its member table: the full list behind every mark, from the
/// same buckets the spec's refs were cut from.
#[derive(Debug, Clone, PartialEq)]
pub enum RecipeOutcome {
    Chart {
        summary: String,
        spec: Value,
        members: MemberTable,
    },
    NoData {
        summary: String,
    },
}

/// A read that should have worked, such as a `--range` naming no commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecipeError {
    Git(String),
    Ledger(String),
    /// A `--form` the recipe's chart cannot be redrawn in.
    Form(String),
    /// A project config the line classifier cannot be built from.
    Config(String),
}

impl fmt::Display for RecipeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecipeError::Git(message)
            | RecipeError::Ledger(message)
            | RecipeError::Form(message)
            | RecipeError::Config(message) => f.write_str(message),
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

/// `text` within `max` characters, losing its end, for a label whose front is
/// the part that says what it is.
pub(crate) fn clip_back(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// `values` binned as the engine bins a histogram of them written in
/// `format`: each bin's label and the indices of the values in it. A recipe
/// that draws its own bars over these bins draws the histogram's figure and
/// can add a bar no range describes. `None` for an empty sample, or one the
/// engine would not draw.
pub(crate) fn binned(values: &[f64], format: &str) -> Option<(Vec<String>, Vec<Vec<usize>>)> {
    if values.is_empty() {
        return None;
    }
    let spec = json!({
        "tugchart": 1,
        "form": "histogram",
        "title": "t",
        "format": format,
        "values": values,
    });
    let Source::Chart(spec) = validate(&spec.to_string(), Layers::Chart).ok()? else {
        return None;
    };
    histogram_bins(&spec)
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
        let mut paths = Paths::from_env();
        paths.sessions_db = dir.join("sessions.db");
        RecipeContext {
            repo_root: dir.to_path_buf(),
            paths,
            apptest_ledger: dir.join("apptest_results.db"),
            test_ledger: dir.join("test_results.db"),
            report_gaps: dir.join("report_gaps.db"),
            line_kinds: Ok(LineKinds::defaults()),
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

    /// `spec` is valid and carries the source of `recipe`: every key of its
    /// row of `SOURCE_KEYS` is stamped, save the ones that ride only when
    /// given (`path`, `files`), nothing outside the row is, and the whole
    /// stamp stays within the 400-character budget a `files` list aside.
    pub(crate) fn assert_source(spec: &Value, recipe: &str) {
        assert_valid(spec);
        let source = &spec["source"];
        assert_eq!(source["recipe"], recipe, "{recipe}: {source}");
        let keys = crate::members::source_keys(recipe);
        let stamped = source["args"]
            .as_object()
            .unwrap_or_else(|| panic!("{recipe}: source has no args: {source}"));
        for key in stamped.keys() {
            assert!(keys.contains(&key.as_str()), "{recipe} stamped {key}");
        }
        for key in keys {
            assert!(
                stamped.contains_key(*key) || ["path", "files"].contains(key),
                "{recipe} did not stamp {key}: {source}"
            );
        }
        let mut counted = source.clone();
        counted["args"].as_object_mut().unwrap().remove("files");
        let text = serde_json::to_string(&counted).unwrap();
        assert!(text.len() <= 400, "{recipe}: {} chars: {text}", text.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binned_agrees_with_the_engines_own_histogram_bins() {
        let values = [4.0, 12.0, 30.0, 95.0];
        let (labels, bins) = binned(&values, "secs").unwrap();
        let spec = json!({
            "tugchart": 1, "form": "histogram", "title": "t", "format": "secs",
            "values": values,
        });
        let Source::Chart(spec) = validate(&spec.to_string(), Layers::Chart).unwrap() else {
            panic!("not a chart");
        };
        assert_eq!(Some((labels.clone(), bins.clone())), histogram_bins(&spec));
        assert_eq!(labels.len(), bins.len());
        assert_eq!(bins.iter().map(Vec::len).sum::<usize>(), values.len());
        assert_eq!(binned(&[], "count"), None);
    }

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
