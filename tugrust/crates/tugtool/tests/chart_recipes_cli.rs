//! `tugtool chart <recipe>` and `tugtool chart list`, end to end.
//!
//! The repository is a scratch one whose commits carry set dates and known
//! line counts under `a/` and `b/`. Every ledger is redirected to a scratch
//! file and seeded through its own writer, and the data dir holding the arc
//! log is scratch too. Each chart line is handed back to the engine's
//! validator, which is the one reader that matters.

mod common;
use common::tugtool;

use std::path::{Path, PathBuf};
use std::process::Output;

use serde_json::{Value, json};
use tempfile::TempDir;
use tugcore::instance::Paths;
use tugcore::report_gaps::{GapRow, ReportGaps};
use tugcore::test_fixtures::git::{GitFixture, command as git_command};
use tuggraphics::{Layers, validate};
use tugtool_core::apptest_ledger::{self, FileResult, RunRecord};
use tugtool_core::paths::arc_log_path_at;
use tugtool_core::test_ledger::{self, JunitFile, JunitRun, TestRun};

const PREFIX: &str = "TUG-CHART: ";
const LONG_WINDOW: &str = "3650";

/// A project and where its ledgers go, none of them there until seeded.
struct Project {
    _dir: TempDir,
    root: PathBuf,
    scratch: PathBuf,
}

impl Project {
    /// A directory that is no repository.
    fn bare() -> Project {
        let dir = tempfile::tempdir().unwrap();
        let top = dir.path().canonicalize().unwrap();
        let root = top.join("project");
        let scratch = top.join("scratch");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        Project {
            _dir: dir,
            root,
            scratch,
        }
    }

    /// A repository with three commits on three days: `a/` takes +3, `b/` +5,
    /// and `a/` again +1 −2.
    fn with_history() -> Project {
        let project = Project::bare();
        GitFixture::init(&project.root);
        project.commit(
            "a/one.txt",
            "l0\nl1\nl2\n",
            "tugtool(x): first",
            "2026-10-01T12:00:00",
        );
        project.commit(
            "b/two.txt",
            "1\n2\n3\n4\n5\n",
            "fix: second",
            "2026-10-02T12:00:00",
        );
        project.commit(
            "a/one.txt",
            "l0\nnew\n",
            "third thing",
            "2026-10-03T15:00:00",
        );
        project
    }

    fn commit(&self, file: &str, content: &str, subject: &str, at: &str) {
        let path = self.root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
        let status = git_command()
            .arg("-C")
            .arg(&self.root)
            .args(["add", file])
            .status()
            .unwrap();
        assert!(status.success());
        let out = git_command()
            .arg("-C")
            .arg(&self.root)
            .args(["commit", "-q", "-m", subject])
            .env("GIT_AUTHOR_DATE", at)
            .env("GIT_COMMITTER_DATE", at)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn test_ledger(&self) -> PathBuf {
        self.scratch.join("test_results.db")
    }

    fn apptest_ledger(&self) -> PathBuf {
        self.scratch.join("apptest_results.db")
    }

    fn report_gaps(&self) -> PathBuf {
        self.scratch.join("report_gaps.db")
    }

    fn data_dir(&self) -> PathBuf {
        self.scratch.join("data")
    }

    fn root_text(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// `tugtool <args>` in the project, every record redirected.
    fn run(&self, args: &[&str]) -> Output {
        tugtool()
            .args(args)
            .current_dir(&self.root)
            .env("TUG_TEST_RESULTS_DB", self.test_ledger())
            .env("TUG_APPTEST_RESULTS_DB", self.apptest_ledger())
            .env("TUG_REPORT_GAPS_DB", self.report_gaps())
            .env("TUG_DATA_DIR", self.data_dir())
            .env("TUG_APPTEST_FILE_BUDGET_SECS", "10")
            .output()
            .unwrap()
    }

    /// `tugtool chart <recipe> <args>`, which must exit 0: its summary line
    /// and its chart, after the engine accepted the chart.
    fn chart(&self, args: &[&str]) -> (String, Value) {
        let (summary, spec) = self.answer(args);
        let spec = spec.unwrap_or_else(|| panic!("no chart from {args:?}: {summary}"));
        (summary, spec)
    }

    /// The same, for a recipe that may have nothing to draw. Stdout is the
    /// summary line and at most one chart line.
    fn answer(&self, args: &[&str]) -> (String, Option<Value>) {
        let mut argv = vec!["chart"];
        argv.extend_from_slice(args);
        let out = self.run(&argv);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let lines: Vec<&str> = text.lines().collect();
        assert!(!lines.is_empty() && lines.len() <= 2, "{text}");
        assert!(!lines[0].starts_with(PREFIX), "{text}");
        let spec = lines.get(1).map(|line| {
            let source = line.strip_prefix(PREFIX).expect(&text);
            validate(source, Layers::Chart)
                .unwrap_or_else(|errs| panic!("the chart does not validate: {errs:?}"));
            serde_json::from_str(source).unwrap()
        });
        (lines[0].to_string(), spec)
    }

    /// One run of `suite` taking `wall_secs`, with `files` timed inside it.
    fn seed_suite(&self, suite: &str, at: i64, wall_secs: f64, files: &[(&str, f64)]) {
        let mut conn = test_ledger::open_ledger(self.test_ledger()).unwrap();
        let run = TestRun {
            started_at: at - 1,
            ended_at: at,
            run_root: self.root_text(),
            branch: "main".to_string(),
            head_sha: "abc".to_string(),
            dirty: false,
            suite: suite.to_string(),
            session_id: None,
            tool_use_id: None,
            command: "bun test".to_string(),
            exit_code: 0,
            wall_secs,
        };
        let junit = JunitRun {
            tests: 1,
            failed: 0,
            skipped: 0,
            files: files
                .iter()
                .map(|(file, secs)| JunitFile {
                    file: (*file).to_string(),
                    tests: 1,
                    failed: 0,
                    secs: *secs,
                })
                .collect(),
            failures: Vec::new(),
        };
        test_ledger::record_run(&mut conn, &run, Some(&junit)).unwrap();
    }

    /// One app-test run of `file`, ended at `at`.
    fn seed_apptest(&self, at: i64, file: &str, status: &str, secs: i64) {
        let mut conn = apptest_ledger::open_ledger(self.apptest_ledger()).unwrap();
        let run = RunRecord {
            started_at: at - 30,
            ended_at: at,
            run_root: self.root_text(),
            branch: "main".to_string(),
            head_sha: "abc".to_string(),
            dirty: false,
            sweep: "explicit-files".to_string(),
            selection: "explicit".to_string(),
            wall_secs: 30,
            verdict: if status == "PASS" { "PASS" } else { "FAIL" }.to_string(),
            files: vec![FileResult {
                file: file.to_string(),
                status: status.to_string(),
                passed: 1,
                total: 1,
                secs,
                foreground: false,
            }],
        };
        apptest_ledger::record_run(&mut conn, &run).unwrap();
    }

    fn seed_arc_log(&self, text: &str) {
        let path = arc_log_path_at(&Paths::under(&self.data_dir()), &self.root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

fn assert_starts(line: &str, head: &str) {
    assert!(line.starts_with(head), "{line:?} does not start {head:?}");
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn series_names(spec: &Value) -> Vec<&str> {
    spec["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect()
}

#[test]
fn commits_counts_each_day_and_narrows_to_a_path() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["commits", "--days", LONG_WINDOW]);
    assert_starts(&summary, "3 commit(s) over 3 day(s), ");
    assert_eq!(spec["form"], "bar");
    assert_eq!(spec["title"], "Commits per day");
    assert_eq!(
        spec["categories"],
        json!(["2026-10-01", "2026-10-02", "2026-10-03"])
    );
    assert_eq!(spec["series"][0]["values"], json!([1, 1, 1]));

    let (summary, spec) = project.chart(&["commits", "--days", LONG_WINDOW, "--path", "a"]);
    assert_starts(&summary, "2 commit(s) over 3 day(s), ");
    assert_eq!(spec["title"], "Commits per day under a");
    assert_eq!(spec["series"][0]["values"], json!([1, 0, 1]));
}

#[test]
fn churn_sums_the_numstat_and_only_under_the_path() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["churn", "--days", LONG_WINDOW]);
    assert_starts(&summary, "+9 −2 line(s) in 3 commit(s) over 3 day(s), ");
    assert_eq!(spec["form"], "area");
    assert_eq!(spec["layout"], "stacked");

    let (summary, spec) = project.chart(&["churn", "--path", "a", "--days", LONG_WINDOW]);
    assert_starts(&summary, "+4 −2 line(s) in 2 commit(s) over 3 day(s), ");
    assert_eq!(spec["title"], "Lines added and removed per day under a");
    assert_eq!(series_names(&spec), ["added", "removed"]);
    assert_eq!(spec["series"][0]["values"], json!([3, 0, 1]));
    assert_eq!(spec["series"][1]["values"], json!([0, 0, 2]));
}

#[test]
fn hotspots_ranks_paths_by_lines_changed() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["hotspots", "--days", LONG_WINDOW, "--depth", "1"]);
    assert_starts(&summary, "2 of 2 path(s) at depth 1, ");
    assert_eq!(spec["orient"], "horizontal");
    assert_eq!(spec["categories"], json!(["a", "b"]));
    assert_eq!(spec["series"][0]["values"], json!([6, 5]));
}

#[test]
fn landed_stacks_added_and_removed_over_a_range() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["landed", "--range", "HEAD~2..HEAD"]);
    assert_eq!(summary, "2 file(s) under 2 path(s), HEAD~2..HEAD");
    assert_eq!(spec["layout"], "stacked");
    assert_eq!(spec["categories"], json!(["b", "a"]));
    assert_eq!(spec["series"][0]["values"], json!([5, 1]));
    assert_eq!(spec["series"][1]["values"], json!([0, 2]));
}

#[test]
fn landed_with_a_range_that_names_no_commit_is_an_error() {
    let project = Project::with_history();
    let out = project.run(&["chart", "landed", "--range", "nosuch..alsonot"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stdout(&out).is_empty(), "{}", stdout(&out));
    assert!(!stderr(&out).is_empty());
}

#[test]
fn commit_kinds_reads_each_subject_prefix() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["commit-kinds", "--days", LONG_WINDOW]);
    assert_starts(&summary, "3 commit(s) over 3 day(s), ");
    assert_eq!(series_names(&spec), ["fix", "tugtool", "other"]);
    assert_eq!(spec["series"][0]["values"], json!([0, 1, 0]));
    assert_eq!(spec["series"][1]["values"], json!([1, 0, 0]));
    assert_eq!(spec["series"][2]["values"], json!([0, 0, 1]));
}

#[test]
fn commit_hours_buckets_by_the_committers_hour() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["commit-hours", "--days", LONG_WINDOW]);
    assert_starts(&summary, "3 commit(s) by committer's local hour, ");
    assert_eq!(spec["form"], "heat");
    assert_eq!(spec["categories"].as_array().unwrap().len(), 24);
    assert_eq!(spec["values"][12], 2);
    assert_eq!(spec["values"][15], 1);
}

#[test]
fn arc_timeline_draws_the_named_arc_and_defaults_to_the_newest() {
    let project = Project::bare();
    project.seed_arc_log(concat!(
        "2026-10-27T16:00:00.000Z  old  arc-start  brief.md\n",
        "2026-10-27T16:00:10.000Z  old  arc-stage  implement s1 -\n",
        "2026-10-27T16:00:20.000Z  old  step-start  1/1 Step 1: Only\n",
        "2026-10-27T16:00:30.000Z  old  step-done  1/1 aaa\n",
        "2026-10-27T17:00:00.000Z  new  arc-start  brief.md\n",
        "2026-10-27T17:00:10.000Z  new  arc-stage  devise s2 -\n",
    ));

    let (summary, spec) = project.chart(&["arc-timeline", "old"]);
    assert_eq!(summary, "arc old: 1 stage(s), 1 step span(s)");
    assert_eq!(spec["form"], "spans");
    assert_eq!(spec["title"], "Arc old: stages and steps");
    assert_eq!(spec["items"][1]["label"], "Only");
    assert_eq!(spec["items"][1]["start"], 10.0);
    assert_eq!(spec["items"][1]["end"], 20.0);
    assert_eq!(spec["items"][1]["status"], "good");

    let (summary, _) = project.chart(&["arc-timeline"]);
    assert_eq!(summary, "arc new: 1 stage(s), 0 step span(s)");

    let (summary, spec) = project.answer(&["arc-timeline", "nosuch"]);
    assert_eq!(summary, "no arc named nosuch in the log");
    assert!(spec.is_none());
}

#[test]
fn suite_times_leaves_out_a_suite_too_small_to_read() {
    let project = Project::bare();
    project.seed_suite("tiny", 100, 0.1, &[]);
    project.seed_suite("deck", 101, 20.0, &[]);
    project.seed_suite("rust", 102, 50.0, &[]);
    project.seed_suite("rust", 103, 70.0, &[]);

    let (summary, spec) = project.chart(&["suite-times"]);
    assert_eq!(
        summary,
        format!(
            "3 run(s) across 2 suite(s) for {}, newest 30 per suite; left out: tiny",
            project.root_text()
        )
    );
    assert_eq!(spec["format"], "secs");
    assert_eq!(series_names(&spec), ["rust", "deck"]);
    assert_eq!(spec["series"][0]["values"][29], 70.0);
    assert_eq!(spec["series"][0]["values"][28], 50.0);

    let (_, spec) = project.chart(&["suite-times", "--all"]);
    assert_eq!(series_names(&spec), ["rust", "deck", "tiny"]);

    let (_, spec) = project.chart(&["suite-times", "--suite", "deck", "--title", "Deck alone"]);
    assert_eq!(series_names(&spec), ["deck"]);
    assert_eq!(spec["title"], "Deck alone");
}

#[test]
fn test_distribution_bins_the_latest_run_of_each_suite() {
    let project = Project::bare();
    project.seed_suite("rust", 100, 9.0, &[("old.rs", 99.0)]);
    project.seed_suite("rust", 101, 9.0, &[("a.rs", 1.0), ("b.rs", 2.0)]);
    project.seed_suite("deck", 102, 9.0, &[("c.ts", 3.0)]);

    let (summary, spec) = project.chart(&["test-distribution"]);
    assert_eq!(summary, "3 file(s) across 2 suite(s), latest runs");
    assert_eq!(spec["form"], "histogram");
    let mut values: Vec<f64> = spec["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    values.sort_by(f64::total_cmp);
    assert_eq!(values, [1.0, 2.0, 3.0]);
}

#[test]
fn test_budget_measures_each_file_against_the_budget() {
    let project = Project::bare();
    project.seed_apptest(100, "tests/quick.test.ts", "PASS", 5);
    project.seed_apptest(101, "tests/slow.test.ts", "PASS", 15);

    let (summary, spec) = project.chart(&["test-budget"]);
    assert_eq!(
        summary,
        format!(
            "2 of 2 file(s) with recorded times for {}, budget 10s, 1 over it by median",
            project.root_text()
        )
    );
    assert_eq!(spec["form"], "bullet");
    assert_eq!(spec["items"][0]["label"], "slow");
    assert_eq!(spec["items"][0]["value"], 15.0);
    assert_eq!(spec["items"][0]["target"], 10.0);
    assert_eq!(spec["items"][0]["range"], json!([0.0, 15.0]));
    assert_eq!(spec["items"][1]["label"], "quick");
}

#[test]
fn test_history_defaults_to_red_files_and_names_a_file_with_no_runs() {
    let project = Project::bare();
    project.seed_apptest(100, "tests/red.test.ts", "PASS", 5);
    project.seed_apptest(101, "tests/red.test.ts", "FAIL", 5);
    project.seed_apptest(102, "tests/green.test.ts", "PASS", 5);

    let (summary, spec) = project.chart(&["test-history"]);
    assert_eq!(
        summary,
        format!(
            "1 of 1 file(s) with recorded runs for {}, newest 20 each",
            project.root_text()
        )
    );
    assert_eq!(spec["form"], "dots");
    assert_eq!(spec["rows"][0]["label"], "red");
    assert_eq!(spec["rows"][0]["items"], json!(["good", "bad"]));

    let (summary, spec) =
        project.chart(&["test-history", "tests/green.test.ts", "tests/ghost.test.ts"]);
    assert_eq!(
        summary,
        format!(
            "1 of 2 file(s) with recorded runs for {}, newest 20 each; no runs: ghost",
            project.root_text()
        )
    );
    assert_eq!(spec["rows"][0]["label"], "green");
}

#[test]
fn gaps_ranks_the_silent_heads_by_total_time() {
    let project = Project::bare();
    let gaps = ReportGaps::open(project.report_gaps()).unwrap();
    for (head, wall_ms) in [("cargo build", 25_000), ("just ci", 30_000)] {
        gaps.record(&GapRow {
            head: head.to_string(),
            command: head.to_string(),
            project_dir: project.root_text(),
            session_id: "s".to_string(),
            wall_ms,
            ended_at_ms: 1_000,
        })
        .unwrap();
    }
    drop(gaps);

    let (summary, spec) = project.chart(&["gaps"]);
    assert_eq!(
        summary,
        "2 command head(s), 2 long call(s) that reported nothing"
    );
    assert_eq!(spec["orient"], "horizontal");
    assert_eq!(spec["categories"], json!(["just ci", "cargo build"]));
    assert_eq!(spec["series"][0]["values"], json!([30.0, 25.0]));
}

/// One plain line, no chart, exit 0, and the record it looked for left
/// uncreated.
#[test]
fn a_recipe_over_an_empty_record_says_so_in_one_line() {
    let project = Project::bare();
    let cases: [(&str, &Path, &str); 6] = [
        (
            "suite-times",
            &project.test_ledger(),
            "no recorded test runs for",
        ),
        (
            "test-distribution",
            &project.test_ledger(),
            "no recorded test runs for",
        ),
        (
            "test-budget",
            &project.apptest_ledger(),
            "no recorded app-test runs for",
        ),
        (
            "test-history",
            &project.apptest_ledger(),
            "no recorded app-test runs for",
        ),
        (
            "gaps",
            &project.report_gaps(),
            "no long calls recorded that reported nothing",
        ),
        (
            "arc-timeline",
            &arc_log_path_at(&Paths::under(&project.data_dir()), &project.root),
            "no arc log for",
        ),
    ];
    for (recipe, record, head) in cases {
        let (summary, spec) = project.answer(&[recipe]);
        assert_starts(&summary, head);
        assert!(spec.is_none(), "{recipe}");
        assert!(!record.exists(), "{recipe} created {}", record.display());
    }
}

#[test]
fn a_commit_recipe_outside_any_history_says_so_in_one_line() {
    let project = Project::bare();
    for recipe in [
        "commits",
        "churn",
        "hotspots",
        "landed",
        "commit-kinds",
        "commit-hours",
    ] {
        let (summary, spec) = project.answer(&[recipe]);
        assert_starts(&summary, "no commits in ");
        assert!(spec.is_none(), "{recipe}");
    }
}

#[test]
fn json_reads_the_answer_without_drawing_it() {
    let project = Project::with_history();
    let flag_after = project.run(&["chart", "commits", "--days", LONG_WINDOW, "--json"]);
    let flag_before = project.run(&["--json", "chart", "commits", "--days", LONG_WINDOW]);
    for out in [flag_after, flag_before] {
        assert!(out.status.success(), "{}", stderr(&out));
        let text = stdout(&out);
        assert!(!text.contains(PREFIX), "{text}");
        let envelope: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(envelope["command"], "chart commits");
        assert_eq!(envelope["status"], "ok");
        assert_eq!(envelope["data"]["recipe"], "commits");
        assert_starts(
            envelope["data"]["summary"].as_str().unwrap(),
            "3 commit(s) over 3 day(s), ",
        );
        assert_eq!(envelope["data"]["spec"]["form"], "bar");
    }

    let bare = Project::bare();
    let out = bare.run(&["chart", "gaps", "--json"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let envelope: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert!(envelope["data"]["spec"].is_null());
}

#[test]
fn list_names_every_recipe_with_its_arguments() {
    let project = Project::bare();
    let out = project.run(&["chart", "list", "--json"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let envelope: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(envelope["command"], "chart list");
    let recipes = envelope["data"].as_array().unwrap();
    assert_eq!(recipes.len(), 12);
    assert_eq!(recipes[0]["name"], "commits");

    let out = project.run(&["chart", "list"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let text = stdout(&out);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 24, "{text}");
    assert_eq!(lines[0], "commits  bar  How active has this been?");
    assert_eq!(lines[1], "    --days N  --path TEXT  --title TEXT");
    assert!(
        text.contains("    [name]  --title TEXT"),
        "the arc's positional: {text}"
    );
    assert!(
        text.contains("    --suite TEXT...  --all  --runs N  --title TEXT"),
        "{text}"
    );
}

#[test]
fn an_unknown_recipe_points_at_the_list() {
    let project = Project::bare();
    let out = project.run(&["chart", "nosuch"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("tugtool chart list"), "{out:?}");
}

#[test]
fn a_recipes_help_and_usage_errors_come_from_its_own_parser() {
    let project = Project::bare();
    let help = project.run(&["chart", "commits", "--help"]);
    assert_eq!(help.status.code(), Some(0));
    let text = stdout(&help);
    assert!(text.contains("How active has this been?"), "{text}");
    assert!(text.contains("--days"), "{text}");
    assert!(text.contains("tugtool chart commits"), "{text}");

    let wrong = project.run(&["chart", "commits", "--staged"]);
    assert_eq!(wrong.status.code(), Some(2));
    assert!(stderr(&wrong).contains("--staged"), "{wrong:?}");
}

#[test]
fn the_chart_help_names_the_list() {
    let project = Project::bare();
    let out = project.run(&["chart", "--help"]);
    assert!(out.status.success());
    assert!(stdout(&out).contains("tugtool chart list"), "{out:?}");
}
