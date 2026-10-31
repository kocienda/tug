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
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tempfile::TempDir;
use tugcore::instance::Paths;
use tugcore::report_gaps::{GapRow, ReportGaps};
use tugcore::session_schema::{CREATE_LINES_SQL, CREATE_SESSIONS_SQL};
use tugcore::test_fixtures::git::{GitFixture, command as git_command};
use tuggraphics::{Layers, validate};
use tugtool_core::apptest_ledger::{self, FileResult, RunRecord};
use tugtool_core::paths::arc_log_path_at;

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

    fn apptest_ledger(&self) -> PathBuf {
        self.scratch.join("apptest_results.db")
    }

    fn sessions_db(&self) -> PathBuf {
        self.scratch.join("sessions.db")
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
            .env("TUG_APPTEST_RESULTS_DB", self.apptest_ledger())
            .env("TUG_REPORT_GAPS_DB", self.report_gaps())
            .env("TUG_SESSIONS_DB", self.sessions_db())
            .env("TUG_DATA_DIR", self.data_dir())
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

    /// A session ledger with one turn of `model` per entry, in `project_dir`,
    /// that many days ago. `turn_telemetry` and `session_metadata` are
    /// tugcast's own, so the columns read here are named here.
    fn seed_ledger(&self, turns: &[(&str, &str, i64)]) {
        let conn = rusqlite::Connection::open(self.sessions_db()).unwrap();
        conn.execute_batch(CREATE_LINES_SQL).unwrap();
        conn.execute_batch(CREATE_SESSIONS_SQL).unwrap();
        conn.execute_batch(
            "CREATE TABLE turn_telemetry (
                 session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
                 input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
                 cache_creation_input_tokens INTEGER NOT NULL,
                 cache_read_input_tokens INTEGER NOT NULL,
                 total_cost_usd REAL NOT NULL, ended_at INTEGER NOT NULL,
                 PRIMARY KEY (session_id, msg_id));
             CREATE TABLE session_metadata (
                 session_id TEXT PRIMARY KEY, payload BLOB NOT NULL, captured_at INTEGER NOT NULL);
             INSERT INTO lines (line_id, tag, project_dir, created_at, last_used_at)
                 VALUES ('line', 'odd-kiln', '/p', 0, 0);",
        )
        .unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        for (n, (project_dir, model, days_ago)) in turns.iter().enumerate() {
            let session = format!("s{n}");
            conn.execute(
                "INSERT INTO sessions (session_id, workspace_key, project_dir, created_at,
                                       last_used_at, state, line_id)
                 VALUES (?1, 'ws', ?2, 0, 0, 'closed', 'line')",
                rusqlite::params![session, project_dir],
            )
            .unwrap();
            let payload = json!({ "model": model }).to_string();
            conn.execute(
                "INSERT INTO session_metadata (session_id, payload, captured_at)
                 VALUES (?1, ?2, 0)",
                rusqlite::params![session, payload.as_bytes()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO turn_telemetry VALUES (?1, 'm', 2, 3, 7, 5, 0.5, ?2)",
                rusqlite::params![session, now_ms - days_ago * 86_400_000],
            )
            .unwrap();
        }
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
fn commits_by_week_buckets_on_mondays_and_a_stray_bucket_is_a_usage_error() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["commits", "--days", LONG_WINDOW, "--by", "week"]);
    assert_starts(&summary, "3 commit(s) over 1 week(s), ");
    assert_eq!(spec["title"], "Commits per week");
    assert_eq!(spec["categories"], json!(["2026-09-28"]));
    assert_eq!(spec["series"][0]["values"], json!([3]));

    let wrong = project.run(&["chart", "commits", "--by", "month"]);
    assert_eq!(wrong.status.code(), Some(2));
}

#[test]
fn velocity_sums_lines_per_week_and_net_subtracts_the_removed() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["velocity", "--days", LONG_WINDOW]);
    assert_starts(
        &summary,
        "11 line(s) changed over 1 week(s), median 11 a week, ",
    );
    assert_eq!(spec["form"], "area");
    assert_eq!(spec["title"], "Lines changed per week");
    assert_eq!(spec["x"], json!(["2026-09-28"]));
    assert_eq!(spec["series"][0]["values"], json!([11]));
    assert_eq!(spec["annotations"][0]["value"], 11.0);

    let (summary, spec) = project.chart(&["velocity", "--days", LONG_WINDOW, "--net"]);
    assert_starts(&summary, "7 net line(s) over 1 week(s), median 7 a week, ");
    assert_eq!(spec["title"], "Net lines per week");
    assert_eq!(spec["series"][0]["values"], json!([7]));
}

#[test]
fn commit_size_draws_the_lines_of_each_commit() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["commit-size", "--days", LONG_WINDOW]);
    assert_starts(&summary, "3 commit(s), median 3 line(s) changed, ");
    assert_eq!(spec["form"], "histogram");
    // Newest first: the third commit, then the second, then the first.
    assert_eq!(spec["values"], json!([3, 5, 3]));
}

#[test]
fn commit_days_buckets_by_the_committers_weekday() {
    let project = Project::with_history();
    let (summary, spec) = project.chart(&["commit-days", "--days", LONG_WINDOW]);
    assert_starts(&summary, "3 commit(s) by committer's local weekday, ");
    assert_eq!(spec["form"], "heat");
    assert_eq!(spec["categories"][0], "Mon");
    assert_eq!(spec["values"], json!([0, 0, 0, 1, 1, 1, 0]));
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
    assert_eq!(
        summary,
        "arc old: 1 of 1 step(s) finished, 1 stage(s), 1 step span(s)"
    );
    assert_eq!(spec["form"], "spans");
    assert_starts(spec["title"].as_str().unwrap(), "Arc old: 1 step, ");
    assert_eq!(spec["items"][0]["label"], "Implement");
    assert_eq!(spec["items"][1]["label"], "1/1 Only");
    assert_eq!(spec["items"][1]["start"], 10.0);
    assert_eq!(spec["items"][1]["end"], 20.0);
    assert_eq!(spec["items"][1]["status"], "good");

    let (summary, _) = project.chart(&["arc-timeline"]);
    assert_eq!(
        summary,
        "arc new: 0 of 0 step(s) finished, 1 stage(s), 0 step span(s)"
    );

    let (summary, spec) = project.answer(&["arc-timeline", "nosuch"]);
    assert_eq!(summary, "no arc named nosuch in the log");
    assert!(spec.is_none());
}

#[test]
fn arcs_counts_per_week_within_the_window() {
    let project = Project::bare();
    project.seed_arc_log(concat!(
        "2026-10-07T12:00:00.000Z  a  arc-start  brief.md\n",
        "2026-10-07T12:30:00.000Z  a  abc123  joined via card\n",
        "2026-10-14T12:00:00.000Z  b  arc-start  brief.md\n",
        "2026-10-14T12:30:00.000Z  b  discarded\n",
    ));
    let (summary, spec) = project.chart(&["arcs", "--days", LONG_WINDOW]);
    assert_eq!(
        summary,
        format!("2 started, 1 joined, 1 discarded over 2 week(s), last {LONG_WINDOW} days")
    );
    assert_eq!(spec["form"], "bar");
    assert_eq!(spec["categories"], json!(["2026-10-05", "2026-10-12"]));
    assert_eq!(series_names(&spec), ["started", "joined", "discarded"]);

    // A window older than any calendar reads the whole log.
    let (summary, _) = project.chart(&["arcs", "--days", "4294967295"]);
    assert_starts(
        &summary,
        "2 started, 1 joined, 1 discarded over 2 week(s), ",
    );
}

#[test]
fn arc_stages_draws_the_newest_arcs_first() {
    let project = Project::bare();
    project.seed_arc_log(concat!(
        "2026-10-27T16:00:00.000Z  old  arc-start  brief.md\n",
        "2026-10-27T16:00:00.000Z  old  arc-stage  implement s1 -\n",
        "2026-10-27T16:01:00.000Z  old  arc-stage  audit s2 opus\n",
        "2026-10-27T16:02:00.000Z  old  abc123  joined via card\n",
        "2026-10-27T17:00:00.000Z  new  arc-start  brief.md\n",
        "2026-10-27T17:00:00.000Z  new  arc-stage  implement s3 -\n",
        "2026-10-27T17:00:30.000Z  new  abc124  joined via card\n",
    ));
    let (summary, spec) = project.chart(&["arc-stages"]);
    assert_eq!(
        summary,
        "2 newest arc(s), 2m30s of wall time in their stages"
    );
    assert_eq!(spec["categories"], json!(["new", "old"]));
    assert_eq!(series_names(&spec), ["Implement", "Audit"]);
    assert_eq!(spec["series"][0]["values"], json!([30.0, 60.0]));
    assert_eq!(spec["series"][1]["values"], json!([0.0, 60.0]));

    let (_, spec) = project.chart(&["arc-stages", "--limit", "1"]);
    assert_eq!(spec["categories"], json!(["new"]));
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

#[test]
fn calls_draws_a_histogram_of_the_recorded_wall_times() {
    let project = Project::bare();
    let gaps = ReportGaps::open(project.report_gaps()).unwrap();
    for (ended_at_ms, wall_ms) in [(1, 1_000), (2, 3_000), (3, 2_000)] {
        gaps.time("git status", wall_ms, ended_at_ms).unwrap();
    }
    drop(gaps);

    let (summary, spec) = project.chart(&["calls"]);
    assert_eq!(summary, "3 call(s), median 2s");
    assert_eq!(spec["form"], "histogram");
    assert_eq!(spec["values"], json!([2.0, 3.0, 1.0]));
}

#[test]
fn the_model_recipes_read_this_projects_turns_by_family() {
    let project = Project::bare();
    let here = project.root_text();
    project.seed_ledger(&[
        (&here, "claude-opus-5-5[1m]", 0),
        (&here, "opus", 0),
        (&here, "claude-fable-5-1", 0),
        // Past the default window, and only inside a longer one.
        (&here, "claude-opus-5-5", 40),
        ("/somewhere/else", "claude-opus-5-5", 0),
    ]);

    let (summary, spec) = project.chart(&["tokens"]);
    assert_eq!(
        summary,
        "9 output tokens over 1 day(s), 2 model(s), last 30 days, each turn's last API call"
    );
    assert_eq!(spec["form"], "bar");
    assert_eq!(spec["layout"], "stacked");
    assert_eq!(spec["series"][0]["name"], "fable");
    assert_eq!(spec["series"][0]["values"], json!([3.0]));
    assert_eq!(spec["series"][1]["name"], "opus");
    assert_eq!(spec["series"][1]["values"], json!([6.0]));

    let (_, spec) = project.chart(&["tokens", "--kind", "cache-read"]);
    assert_eq!(spec["title"], "Cache-read tokens per day");
    assert_eq!(spec["series"][1]["values"], json!([10.0]));

    let (summary, spec) = project.chart(&["cost"]);
    assert_starts(&summary, "$1.50 over 1 day(s), 2 model(s)");
    assert_eq!(spec["series"][1]["values"], json!([1.0]));

    let (summary, _) = project.chart(&["turns", "--days", "60"]);
    assert_starts(&summary, "4 turn(s) over ");

    let out = project.run(&["chart", "tokens", "--kind", "nonsense"]);
    assert!(!out.status.success());
}

/// One plain line, no chart, exit 0, and the record it looked for left
/// uncreated.
#[test]
fn a_recipe_over_an_empty_record_says_so_in_one_line() {
    let project = Project::bare();
    let cases: [(&str, &Path, &str); 9] = [
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
        ("calls", &project.report_gaps(), "no call times recorded"),
        ("tokens", &project.sessions_db(), "no model usage in the"),
        ("cost", &project.sessions_db(), "no model usage in the"),
        ("turns", &project.sessions_db(), "no model usage in the"),
        (
            "arc-timeline",
            &arc_log_path_at(&Paths::under(&project.data_dir()), &project.root),
            "no arc log for",
        ),
        (
            "arcs",
            &arc_log_path_at(&Paths::under(&project.data_dir()), &project.root),
            "no arc log for",
        ),
        (
            "arc-stages",
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
        "commit-size",
        "commit-days",
        "velocity",
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
    assert_eq!(recipes.len(), 18);
    assert_eq!(recipes[0]["name"], "commits");
    assert_eq!(recipes[0]["group"], "Activity");
    assert_eq!(recipes[0]["sample"]["form"], "bar");

    let out = project.run(&["chart", "list"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let text = stdout(&out);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 54, "{text}");
    assert_eq!(lines[0], "commits  bar  How active has this been?");
    assert_eq!(
        lines[1],
        "    --days N  --path TEXT  --by day|week  --title TEXT"
    );
    assert_eq!(lines[2], "    Activity: Commits per day.");
    assert!(
        text.contains("    [name]  --title TEXT"),
        "the arc's positional: {text}"
    );
    assert!(text.contains("    [files...]  --title TEXT"), "{text}");
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
