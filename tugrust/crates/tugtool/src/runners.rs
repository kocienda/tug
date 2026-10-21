//! The runners the PreToolUse hook knows: tugtool's own, and the ones a
//! project declares as `[[tugtool.report.runner]]` in `.tugtool/config.toml`.
//!
//! A runner is one row in one shape whichever list it came from — the words
//! its command starts with, and what the hook does in front of it. A row with
//! a kind is wrapped in `tugtool test run --kind <kind>`, which parses the
//! run's output into the block's report panel. A row with only a unit is a
//! command that reports itself through `tugtool report`, so the hook puts
//! the call id in front of it and nothing else, and its reports attach to the
//! block exactly instead of by needle.
//!
//! `tugtool report runners` prints the table the hook would use from the current
//! directory, and it is where a refused config is shown: the hook itself
//! falls back to the built-ins in silence, because a hook that failed would
//! block the call it was asked about.

use std::path::PathBuf;

use clap::ValueEnum;
use serde::Serialize;
use tugtool_core::config::{Config, Runner, find_project_root, find_project_root_from};

use crate::changes::AppError;
use crate::output::print_ok;
use crate::run_parsers::default_unit;
use crate::test_run::RunKind;

/// What names the test ledger's suite for a wrapped run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SuiteRule {
    /// Always this name.
    Fixed(String),
    /// The directory the command runs in — the last `cd <dir>` before it,
    /// else the call's own — or this name when that cannot be read.
    DirName(String),
}

/// What the hook puts in front of a matching command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunnerAction {
    /// `tugtool test run --kind <kind> … --`, with the flags a declared row
    /// carries.
    Wrap { kind: RunKind, flags: WrapFlags },
    /// Nothing: the call id every readable call already carries is all a
    /// command that reports itself needs.
    ExportId,
}

/// What a declared row adds to its wrap: a `lines` row's rule, and the unit
/// word a row names. A built-in row adds nothing — its rule is in the binary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct WrapFlags {
    pub item: Option<String>,
    pub total: Option<String>,
    pub stream: Option<String>,
    pub unit: Option<String>,
}

impl WrapFlags {
    /// The flags in the order `test run` documents them, each a flag and its
    /// value.
    pub fn pairs(&self) -> Vec<(&'static str, &str)> {
        [
            ("--item", &self.item),
            ("--total", &self.total),
            ("--stream", &self.stream),
            ("--unit", &self.unit),
        ]
        .into_iter()
        .filter_map(|(flag, value)| value.as_deref().map(|v| (flag, v)))
        .collect()
    }
}

/// Where a row came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Source {
    BuiltIn,
    Config,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::BuiltIn => "built-in",
            Source::Config => "config",
        }
    }
}

/// One runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunnerSpec {
    /// The command's leading words, matched whole after any environment
    /// assignments.
    pub head: Vec<String>,
    pub action: RunnerAction,
    /// What the run counts.
    pub unit: String,
    pub suite: SuiteRule,
    /// The panel's label; the head when absent.
    pub label: Option<String>,
    pub source: Source,
}

impl RunnerSpec {
    /// The head as one string, the way it is typed.
    pub fn head_text(&self) -> String {
        self.head.join(" ")
    }

    /// The panel's label for the run.
    pub fn label_text(&self) -> String {
        self.label.clone().unwrap_or_else(|| self.head_text())
    }

    /// Whether these words start with this runner's head.
    pub fn matches(&self, words: &[&str]) -> bool {
        words.len() >= self.head.len() && self.head.iter().zip(words).all(|(h, w)| h == w)
    }
}

/// A kind's `--kind` spelling.
pub(crate) fn kind_name(kind: RunKind) -> String {
    kind.to_possible_value()
        .map(|v| v.get_name().to_string())
        .unwrap_or_default()
}

fn built_in_row(head: &[&str], kind: RunKind, suite: SuiteRule) -> RunnerSpec {
    RunnerSpec {
        head: head.iter().map(|w| w.to_string()).collect(),
        action: RunnerAction::Wrap {
            kind,
            flags: WrapFlags::default(),
        },
        unit: "test".into(),
        suite,
        label: None,
        source: Source::BuiltIn,
    }
}

/// The runners tugtool knows without being told, each read by a parser
/// tested against the runner's own captured output. Rust runs share the
/// `rust` suite with the workspace recipe, so a crate run and the workspace
/// run are one history; every other run takes the name of the directory it
/// runs in.
pub(crate) fn built_in() -> Vec<RunnerSpec> {
    let rust = || SuiteRule::Fixed("rust".into());
    let dir = |name: &str| SuiteRule::DirName(name.into());
    let mut rows = vec![
        built_in_row(&["cargo", "nextest", "run"], RunKind::Nextest, rust()),
        built_in_row(&["cargo", "test"], RunKind::CargoTest, rust()),
        built_in_row(&["bun", "test"], RunKind::Bun, dir("bun")),
    ];
    let named: &[(&[&str], RunKind, &str)] = &[
        (&["go", "test"], RunKind::Go, "go"),
        (&["pytest"], RunKind::Pytest, "pytest"),
        (&["python", "-m", "pytest"], RunKind::Pytest, "pytest"),
        (&["python3", "-m", "pytest"], RunKind::Pytest, "pytest"),
        (&["jest"], RunKind::Jest, "jest"),
        (&["npx", "jest"], RunKind::Jest, "jest"),
        (&["bunx", "jest"], RunKind::Jest, "jest"),
        (&["vitest"], RunKind::Vitest, "vitest"),
        (&["vitest", "run"], RunKind::Vitest, "vitest"),
        (&["npx", "vitest"], RunKind::Vitest, "vitest"),
        (&["bunx", "vitest"], RunKind::Vitest, "vitest"),
        (&["mocha"], RunKind::Mocha, "mocha"),
        (&["npx", "mocha"], RunKind::Mocha, "mocha"),
        (&["node", "--test"], RunKind::Tap, "node"),
        (&["swift", "test"], RunKind::Swift, "swift"),
        (&["ctest"], RunKind::Ctest, "ctest"),
    ];
    for (head, kind, suite) in named {
        rows.push(RunnerSpec {
            unit: default_unit(*kind).into(),
            ..built_in_row(head, *kind, dir(suite))
        });
    }
    // Builds and checks: no tests, so the units are what the tool reads —
    // crates, type errors, the build — and each records under its own
    // suite, never the directory's, so a check never stands as the last
    // run of a project's tests.
    let builds: &[(&[&str], RunKind, &str)] = &[
        (&["cargo", "build"], RunKind::Cargo, "cargo"),
        (&["cargo", "check"], RunKind::Cargo, "cargo"),
        (&["cargo", "clippy"], RunKind::Cargo, "cargo"),
        (&["tsc"], RunKind::Tsc, "tsc"),
        (&["bunx", "tsc"], RunKind::Tsc, "tsc"),
        (&["npx", "tsc"], RunKind::Tsc, "tsc"),
        (&["vite", "build"], RunKind::Vite, "vite"),
        (&["bunx", "vite", "build"], RunKind::Vite, "vite"),
        (&["npx", "vite", "build"], RunKind::Vite, "vite"),
    ];
    for (head, kind, suite) in builds {
        rows.push(RunnerSpec {
            unit: default_unit(*kind).into(),
            ..built_in_row(head, *kind, SuiteRule::Fixed((*suite).into()))
        });
    }
    // Longest head first, as `merged` orders the table, so `vitest run` is
    // found before `vitest`.
    rows.sort_by_key(|r| std::cmp::Reverse(r.head.len()));
    rows
}

/// A declared row as a runner, or `None` for one the loader should already
/// have refused.
fn declared(runner: &Runner) -> Option<RunnerSpec> {
    let head: Vec<String> = runner
        .r#match
        .split_whitespace()
        .map(String::from)
        .collect();
    let last = head.last()?.clone();
    let action = match &runner.kind {
        Some(kind) => {
            let kind = <RunKind as ValueEnum>::from_str(kind, false).ok()?;
            // `item`, `total` and `stream` are a `lines` row's alone, and the
            // loader refuses them on any other kind, so what a row carries
            // here is what its wrap passes on.
            RunnerAction::Wrap {
                kind,
                flags: WrapFlags {
                    item: runner.item.clone(),
                    total: runner.total.clone(),
                    stream: runner.stream.clone(),
                    unit: runner.unit.clone(),
                },
            }
        }
        None => {
            runner.unit.as_ref()?;
            RunnerAction::ExportId
        }
    };
    Some(RunnerSpec {
        head,
        action,
        unit: runner.unit.clone().unwrap_or_else(|| "test".into()),
        suite: SuiteRule::Fixed(runner.suite.clone().unwrap_or(last)),
        label: runner.label.clone(),
        source: Source::Config,
    })
}

/// The project's declared rows and the built-ins as one table, longest head
/// first so the most specific row wins. A declared head equal to a built-in's
/// replaces it, and among equal lengths a declared row comes first.
pub(crate) fn merged(config: &Config) -> Vec<RunnerSpec> {
    let mut rows: Vec<RunnerSpec> = config
        .tugtool
        .report
        .runners
        .iter()
        .filter_map(declared)
        .collect();
    for row in built_in() {
        if !rows.iter().any(|r| r.head == row.head) {
            rows.push(row);
        }
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.head.len()));
    rows
}

/// The table for a call made from `cwd`: its project's declarations beside
/// the built-ins. A directory in no project, or a project whose config does
/// not load, gets the built-ins alone and no word about it — the hook must
/// never fail the call it was asked about.
pub(crate) fn for_cwd(cwd: Option<&str>) -> Vec<RunnerSpec> {
    let Some(cwd) = cwd else {
        return built_in();
    };
    let Ok(root) = find_project_root_from(PathBuf::from(cwd)) else {
        return built_in();
    };
    match Config::load_from_project(&root) {
        Ok(config) => merged(&config),
        Err(_) => built_in(),
    }
}

/// One row of `tugtool report runners --json`.
#[derive(Serialize)]
struct Row {
    head: String,
    /// The `--kind` a wrapped row runs under; absent on a self-reporting row.
    kind: Option<String>,
    unit: String,
    /// The suite a wrapped row records under; absent when it is the
    /// directory the command runs in, and on a self-reporting row.
    suite: Option<String>,
    label: String,
    source: Source,
}

impl Row {
    fn of(spec: &RunnerSpec) -> Self {
        let (kind, suite) = match &spec.action {
            RunnerAction::Wrap { kind, .. } => (
                Some(kind_name(*kind)),
                match &spec.suite {
                    SuiteRule::Fixed(name) => Some(name.clone()),
                    SuiteRule::DirName(_) => None,
                },
            ),
            RunnerAction::ExportId => (None, None),
        };
        Row {
            head: spec.head_text(),
            kind,
            unit: spec.unit.clone(),
            suite,
            label: spec.label_text(),
            source: spec.source,
        }
    }
}

/// `tugtool report runners`: the table the hook would use from here.
pub(crate) fn run_runners(json: bool) -> Result<(), AppError> {
    let rows = match find_project_root() {
        Ok(root) => merged(&Config::load_from_project(&root).map_err(|e| e.to_string())?),
        Err(_) => built_in(),
    };
    let rows: Vec<Row> = rows.iter().map(Row::of).collect();
    if json {
        #[derive(Serialize)]
        struct Report {
            runners: Vec<Row>,
        }
        print_ok("report runners", Report { runners: rows });
        return Ok(());
    }
    let cells: Vec<[String; 3]> = rows
        .iter()
        .map(|row| {
            let action = match &row.kind {
                Some(kind) => format!("kind={kind}"),
                None => format!("unit={}", row.unit),
            };
            let suite = match (&row.kind, &row.suite) {
                (None, _) => "-".to_string(),
                (Some(_), Some(suite)) => format!("suite={suite}"),
                (Some(_), None) => "suite=<dir>".to_string(),
            };
            [row.head.clone(), action, suite]
        })
        .collect();
    let width = |i: usize| cells.iter().map(|c| c[i].len()).max().unwrap_or(0);
    let (w0, w1, w2) = (width(0), width(1), width(2));
    for (cell, row) in cells.iter().zip(&rows) {
        println!(
            "{:<w0$}  {:<w1$}  {:<w2$}  source={}",
            cell[0],
            cell[1],
            cell[2],
            row.source.name()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(text: &str) -> Config {
        let config: Config = toml::from_str(text).expect("parse");
        config.tugtool.validate().expect("valid");
        config
    }

    #[test]
    fn the_kind_names_the_config_accepts_are_the_kinds_test_run_has() {
        let names: Vec<String> = RunKind::value_variants()
            .iter()
            .map(|k| kind_name(*k))
            .collect();
        assert_eq!(names, tugtool_core::config::RUN_KIND_NAMES);
    }

    #[test]
    fn declared_rows_join_the_built_ins_longest_head_first() {
        let rows = merged(&config(
            "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"cargo-test\"\n\n\
             [[tugtool.report.runner]]\nmatch = \"just app-test\"\nunit = \"file\"\n",
        ));
        let heads: Vec<String> = rows.iter().map(RunnerSpec::head_text).collect();
        let at = |head: &str| heads.iter().position(|h| h == head).unwrap();
        // Longest head first, and a declared row ahead of a built-in of its
        // length.
        assert!(at("cargo nextest run") < at("make check"));
        assert!(at("make check") < at("just app-test"));
        assert!(at("just app-test") < at("cargo test"));
        assert!(at("cargo test") < at("pytest"));
        assert!(rows.windows(2).all(|w| w[0].head.len() >= w[1].head.len()));
        let check = &rows[at("make check")];
        assert_eq!(check.source, Source::Config);
        assert_eq!(check.suite, SuiteRule::Fixed("check".into()));
        assert_eq!(check.label_text(), "make check");
        assert_eq!(rows[at("just app-test")].action, RunnerAction::ExportId);
        assert_eq!(rows[at("just app-test")].unit, "file");
    }

    #[test]
    fn a_declared_head_replaces_the_built_in_it_equals() {
        let rows = merged(&config(
            "[[tugtool.report.runner]]\nmatch = \"bun test\"\nkind = \"bun\"\nsuite = \"web\"\n",
        ));
        let bun: Vec<&RunnerSpec> = rows
            .iter()
            .filter(|r| r.head_text() == "bun test")
            .collect();
        assert_eq!(bun.len(), 1);
        assert_eq!(bun[0].source, Source::Config);
        assert_eq!(bun[0].suite, SuiteRule::Fixed("web".into()));
    }

    #[test]
    fn the_per_file_runners_count_files() {
        let rows = built_in();
        let unit = |head: &str| {
            rows.iter()
                .find(|r| r.head_text() == head)
                .map(|r| r.unit.clone())
                .unwrap()
        };
        assert_eq!(unit("npx jest"), "file");
        assert_eq!(unit("vitest run"), "file");
        assert_eq!(unit("pytest"), "test");
        assert_eq!(unit("cargo clippy"), "crate");
        assert_eq!(unit("bunx tsc"), "error");
        assert_eq!(unit("bunx vite build"), "build");
    }

    #[test]
    fn a_head_matches_whole_leading_words_only() {
        let rows = built_in();
        let cargo_test = rows.iter().find(|r| r.head_text() == "cargo test").unwrap();
        assert!(cargo_test.matches(&["cargo", "test", "-p", "x"]));
        assert!(!cargo_test.matches(&["cargo"]));
        assert!(!cargo_test.matches(&["cargo", "tests"]));
    }
}
