//! `tugtool log --chart` and `tugtool test last --chart`: a verb's data as
//! one `TUG-CHART:` stdout line the deck draws. And `tugtool chart render`:
//! the same engine with no page under it, writing a standalone SVG.
//!
//! The log verb runs in a scratch repo whose commits carry set committer
//! dates, so the chart's day buckets — zero days included — are checked
//! against known history. The test verb reads a ledger redirected through
//! `TUG_TEST_RESULTS_DB`, seeded through the ledger's own `record_run`. Each
//! line's spec is handed back to the engine's validator, which is the one
//! reader that matters.

mod common;
use common::tugtool;

use std::io::Write;
use std::path::Path;
use std::process::{Output, Stdio};

use tugcore::test_fixtures::git::{GitFixture, command as git_command};
use tuggraphics::{Layers, validate};
use tugtool_core::apptest_ledger::{self, FileResult, RunRecord};
use tugtool_core::test_ledger::{self, TestRun};

const PREFIX: &str = "TUG-CHART: ";

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The one chart line of `stdout`, parsed, after the engine accepted it.
fn chart_of(stdout: &str) -> serde_json::Value {
    let lines: Vec<&str> = stdout.lines().filter(|l| l.starts_with(PREFIX)).collect();
    assert_eq!(lines.len(), 1, "one chart line in:\n{stdout}");
    let source = &lines[0][PREFIX.len()..];
    validate(source, Layers::Chart)
        .unwrap_or_else(|errs| panic!("the chart does not validate: {errs:?}"));
    serde_json::from_str(source).unwrap()
}

/// A commit on `root` dated `date` for both author and committer.
fn commit_on(root: &Path, file: &str, date: &str) {
    std::fs::write(root.join(file), date).unwrap();
    let status = git_command()
        .arg("-C")
        .arg(root)
        .args(["add", file])
        .status()
        .unwrap();
    assert!(status.success());
    let out = git_command()
        .arg("-C")
        .arg(root)
        .args(["commit", "-q", "-m", &format!("commit on {date}")])
        .env("GIT_AUTHOR_DATE", format!("{date}T12:00:00"))
        .env("GIT_COMMITTER_DATE", format!("{date}T12:00:00"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn log_chart_buckets_commits_per_committer_day_with_zero_days() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    commit_on(&root, "a.txt", "2026-10-01");
    commit_on(&root, "b.txt", "2026-10-01");
    commit_on(&root, "c.txt", "2026-10-03");

    let out = tugtool()
        // Ten years: git's approximate-date reader refuses a span of a
        // hundred, so a window that would swallow the fixture is this one.
        .args(["log", "--chart", "--days", "3650"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = stdout(&out);
    assert!(
        text.lines()
            .next()
            .unwrap()
            .starts_with("3 commit(s) over 3 day(s)"),
        "{text}"
    );
    let spec = chart_of(&text);
    assert_eq!(spec["form"], "bar");
    assert_eq!(
        spec["categories"],
        serde_json::json!(["2026-10-01", "2026-10-02", "2026-10-03"])
    );
    assert_eq!(spec["series"][0]["values"], serde_json::json!([2, 0, 1]));
}

#[test]
fn log_path_lists_only_the_commits_touching_it_and_carries_their_time() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::create_dir_all(root.join("a")).unwrap();
    std::fs::create_dir_all(root.join("b")).unwrap();
    commit_on(&root, "a/one.txt", "2026-01-01");
    commit_on(&root, "b/two.txt", "2026-01-02");
    commit_on(&root, "a/three.txt", "2026-01-03");

    let out = tugtool()
        .current_dir(&root)
        .args(["log", "--path", "a", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let commits = doc["data"]["commits"].as_array().unwrap();
    let dates: Vec<&str> = commits
        .iter()
        .map(|c| c["date"].as_str().unwrap())
        .collect();
    assert_eq!(dates, ["2026-01-03", "2026-01-01"]);
    assert!(
        commits[0]["at"]
            .as_str()
            .unwrap()
            .starts_with("2026-01-03T12:00:00")
    );
    assert!(doc["data"]["range"].as_str().unwrap().ends_with("under a"));
}

#[test]
fn log_chart_refuses_json() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    commit_on(&root, "a.txt", "2026-10-01");
    let out = tugtool()
        .args(["--json", "log", "--chart"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let text = format!("{}{}", stdout(&out), String::from_utf8_lossy(&out.stderr));
    assert!(
        text.contains("--chart and --json cannot be combined"),
        "{text}"
    );
}

fn seed_runs(db: &Path, root: &Path, suite: &str, secs: &[f64]) {
    let mut conn = test_ledger::open_ledger(db).unwrap();
    for (i, s) in secs.iter().enumerate() {
        let run = TestRun {
            started_at: 1_700_000_000 + i as i64,
            ended_at: 1_700_000_001 + i as i64,
            run_root: root.to_string_lossy().into_owned(),
            branch: "main".to_string(),
            head_sha: "abc".to_string(),
            dirty: false,
            suite: suite.to_string(),
            session_id: None,
            tool_use_id: None,
            command: "bun test".to_string(),
            exit_code: 0,
            wall_secs: *s,
        };
        test_ledger::record_run(&mut conn, &run, None).unwrap();
    }
}

#[test]
fn test_last_chart_plots_each_suites_wall_time_newest_right() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let db = root.join("ledger").join("test_results.db");
    seed_runs(&db, &root, "deck", &[2.0, 3.0]);
    seed_runs(&db, &root, "rust", &[50.0, 60.0, 70.0]);

    let out = tugtool()
        .args(["test", "last", "--chart"])
        .current_dir(&root)
        .env("TUG_TEST_RESULTS_DB", &db)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = stdout(&out);
    assert!(
        text.lines()
            .next()
            .unwrap()
            .starts_with("5 run(s) across 2 suite(s)"),
        "{text}"
    );
    let spec = chart_of(&text);
    assert_eq!(spec["form"], "line");
    assert_eq!(spec["format"], "secs");
    let x = spec["x"].as_array().unwrap();
    assert_eq!(x.len(), 30);
    assert_eq!(x[0], "29");
    assert_eq!(x[29], "0");
    // rust ran last, so it is the first series; the older slots are null.
    assert_eq!(spec["series"][0]["name"], "rust");
    let rust = spec["series"][0]["values"].as_array().unwrap();
    assert_eq!(rust.len(), 30);
    assert!(rust[26].is_null());
    assert_eq!(rust[27], 50.0);
    assert_eq!(rust[29], 70.0);
    assert_eq!(spec["series"][1]["name"], "deck");
    assert_eq!(spec["series"][1]["values"][29], 3.0);
}

#[test]
fn test_last_chart_with_nothing_recorded_says_so_and_exits_zero() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let db = root.join("test_results.db");
    let out = tugtool()
        .args(["test", "last", "--chart"])
        .current_dir(&root)
        .env("TUG_TEST_RESULTS_DB", &db)
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(stdout(&out).starts_with("no recorded test runs for"));
}

/// One app-test run of `file` with `status`, ended at `at`.
fn seed_apptest_run(db: &Path, root: &Path, at: i64, file: &str, status: &str) {
    let mut conn = apptest_ledger::open_ledger(db).unwrap();
    let run = RunRecord {
        started_at: at - 30,
        ended_at: at,
        run_root: root.to_string_lossy().into_owned(),
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
            secs: 5,
            foreground: false,
        }],
    };
    apptest_ledger::record_run(&mut conn, &run).unwrap();
}

#[test]
fn apptest_history_chart_plots_each_files_outcomes_oldest_left() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let db = root.join("apptest_results.db");
    let file = "at0766-bash-tug-chart.test.ts";
    seed_apptest_run(&db, &root, 1_700_000_100, file, "PASS");
    seed_apptest_run(&db, &root, 1_700_000_200, file, "FAIL");
    // A skipped run is not an outcome.
    seed_apptest_run(&db, &root, 1_700_000_250, file, "SKIP");
    seed_apptest_run(&db, &root, 1_700_000_300, file, "PASS");

    let out = tugtool()
        .args(["apptest", "history", "--chart", "--root"])
        .arg(&root)
        .args([file, "at0000-never-ran.test.ts"])
        .env("TUG_APPTEST_RESULTS_DB", &db)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = stdout(&out);
    let summary = text.lines().next().unwrap();
    assert!(
        summary.starts_with("1 of 2 file(s) with recorded runs"),
        "{text}"
    );
    assert!(summary.ends_with("; no runs: at0000-never-ran"), "{text}");
    let spec = chart_of(&text);
    assert_eq!(spec["form"], "dots");
    let rows = spec["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["label"], "at0766-bash-tug-chart");
    assert_eq!(rows[0]["items"], serde_json::json!(["good", "bad", "good"]));

    let none = tugtool()
        .args(["apptest", "history", "--chart", "--root"])
        .arg(&root)
        .arg("at0000-never-ran.test.ts")
        .env("TUG_APPTEST_RESULTS_DB", &db)
        .output()
        .unwrap();
    assert!(none.status.success());
    assert!(stdout(&none).starts_with("no recorded app-test runs for"));
}

#[test]
fn apptest_history_chart_refuses_json() {
    let dir = tempfile::tempdir().unwrap();
    let out = tugtool()
        .args(["--json", "apptest", "history", "--chart", "a.test.ts"])
        .current_dir(dir.path())
        .env("TUG_APPTEST_RESULTS_DB", dir.path().join("x.db"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let text = format!("{}{}", stdout(&out), String::from_utf8_lossy(&out.stderr));
    assert!(
        text.contains("--chart and --json cannot be combined"),
        "{text}"
    );
}

#[test]
fn test_last_chart_refuses_json() {
    let dir = tempfile::tempdir().unwrap();
    let out = tugtool()
        .args(["--json", "test", "last", "--chart"])
        .current_dir(dir.path())
        .env("TUG_TEST_RESULTS_DB", dir.path().join("x.db"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
}

/// `tugtool chart render - --out <out> [args…]` with `source` on stdin.
fn render(source: &str, out: &Path, args: &[&str]) -> Output {
    let mut child = tugtool()
        .args(["chart", "render", "-", "--out"])
        .arg(out)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(source.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

const BAR: &str = r#"{"tugchart": 1, "form": "bar", "title": "Commits per day", "format": "int",
  "categories": ["10-21", "10-22", "10-23"], "series": [{"name": "commits", "values": [4, 7, 0]}]}"#;

#[test]
fn chart_render_writes_a_standalone_svg_with_one_style_and_no_var() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("commits.svg");
    let run = render(BAR, &out, &["--width", "320"]);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert!(stdout(&run).starts_with("wrote "), "{}", stdout(&run));
    assert!(stdout(&run).contains("320×"), "{}", stdout(&run));
    assert!(stdout(&run).contains("theme ironclad"), "{}", stdout(&run));

    let svg = std::fs::read_to_string(&out).unwrap();
    assert!(
        svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""),
        "{svg}"
    );
    assert_eq!(svg.matches("<style>").count(), 1, "{svg}");
    assert!(!svg.contains("var("), "{svg}");
    // The palette's classes, resolved to the theme's colours and the deck's faces.
    assert!(svg.contains(".tgf-series-1{fill:#"), "{svg}");
    assert!(
        svg.contains(".tgt-title{font:600 13px &quot;IBM Plex Sans&quot;}"),
        "{svg}"
    );
    assert!(svg.contains(">Commits per day</text>"), "{svg}");
    assert!(svg.contains("<text x=\""), "{svg}");
    // A file plays no entrance.
    assert!(!svg.contains("tge-"), "{svg}");
}

#[test]
fn chart_render_takes_a_drawing_and_a_theme() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("mark.svg");
    let drawing =
        r#"{"tugdraw": 1, "frame": [40, 20], "ops": [["rect", 0, 0, 20, 20], ["fill", "good"]]}"#;
    let run = render(drawing, &out, &["--theme", "sloop"]);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let svg = std::fs::read_to_string(&out).unwrap();
    assert!(svg.contains(".tgf-good{fill:#"), "{svg}");
    assert!(svg.contains("class=\"tgf-good\""), "{svg}");
}

#[test]
fn chart_render_refuses_an_unknown_theme_and_an_invalid_source() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("x.svg");
    let run = render(BAR, &out, &["--theme", "mauve"]);
    assert_eq!(run.status.code(), Some(1));
    let text = format!("{}{}", stdout(&run), String::from_utf8_lossy(&run.stderr));
    assert!(text.contains("unknown theme \"mauve\""), "{text}");
    assert!(text.contains("ironclad"), "{text}");
    assert!(!out.exists());

    let run = render(r#"{"tugchart": 1, "form": "pie"}"#, &out, &[]);
    assert_eq!(run.status.code(), Some(1));
    let text = format!("{}{}", stdout(&run), String::from_utf8_lossy(&run.stderr));
    assert!(text.contains("not a valid chart or drawing"), "{text}");
    assert!(!out.exists());
}
