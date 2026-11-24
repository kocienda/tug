//! The recipes over the test ledgers.
//!
//! A ledger's open creates a missing file, and a chart that has nothing to
//! read must not leave one behind, so each recipe asks whether the file is
//! there first.

use std::path::Path;

use rusqlite::Connection;
use serde_json::{Value, json};
use tuggraphics::chart::spec::MAX_ROWS;
use tugtool_core::apptest_ledger::{self, FileRun, resolve_base_root};
use tugtool_core::test_ledger::{self, SuiteRun};

use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, row_label,
};
use crate::members::{
    FactKind, Member, MemberKey, MemberTable, SourceArgs, stamp_source, until_for,
};
use crate::refs::{RefBudget, command_ref, commit_ref, is_sha, one_line, set_slots};

/// How many newest runs per suite `test last --chart` reads.
pub const RUNS_PER_SUITE: usize = 30;
/// How many suites one line chart holds.
pub const MAX_SUITES: usize = 8;
/// How many newest outcomes per file a row of dots holds.
pub const RUNS_PER_FILE: usize = 20;

const DEFAULT_RED_FILES: usize = 20;

/// The base root a project's ledger rows are keyed by.
fn base_root(ctx: &RecipeContext) -> String {
    resolve_base_root(&test_ledger::run_root_for(&ctx.repo_root))
}

fn no_apptest_runs(base_root: &str) -> RecipeOutcome {
    RecipeOutcome::NoData {
        summary: format!("no recorded app-test runs for {base_root}"),
    }
}

fn no_suite_runs(base_root: &str) -> RecipeOutcome {
    RecipeOutcome::NoData {
        summary: format!("no recorded unit-suite runs for {base_root}"),
    }
}

fn open_apptest_ledger(path: &Path) -> Result<Connection, RecipeError> {
    apptest_ledger::open_ledger(path).map_err(|e| RecipeError::Ledger(e.to_string()))
}

fn ledger_error(err: impl std::fmt::Display) -> RecipeError {
    RecipeError::Ledger(err.to_string())
}

/// Each suite's wall time over its newest `per_suite` runs, as a line chart:
/// `x` is "runs ago", `per_suite - 1` … `0` as strings, oldest left; a suite
/// with fewer runs carries `null` for the older slots. Suites are ordered by
/// their most recent run, and at most `max_suites` are kept. `runs` is
/// newest first, as the ledger answers. `None` with no run at all.
pub fn suite_wall_times(
    runs: &[SuiteRun],
    per_suite: usize,
    max_suites: usize,
    title: &str,
) -> Option<Value> {
    if runs.is_empty() || per_suite == 0 {
        return None;
    }
    let mut suites = suite_names(runs);
    suites.truncate(max_suites);
    let x: Vec<String> = (0..per_suite).rev().map(|n| n.to_string()).collect();
    let series: Vec<Value> = suites
        .iter()
        .map(|suite| {
            // Newest first from the ledger; the chart reads oldest left.
            let mut secs: Vec<f64> = runs
                .iter()
                .filter(|r| r.suite == *suite)
                .take(per_suite)
                .map(|r| r.wall_secs)
                .collect();
            secs.reverse();
            let mut values: Vec<Value> = vec![Value::Null; per_suite - secs.len()];
            values.extend(secs.into_iter().map(|s| json!(s)));
            json!({ "name": suite, "values": values })
        })
        .collect();
    Some(json!({
        "tugchart": 1,
        "form": "line",
        "title": title,
        "subtitle": format!("newest {per_suite} runs per suite, runs ago"),
        "unit": "s",
        "format": "secs",
        "x": x,
        "series": series,
    }))
}

/// Suites in order of their newest run; `runs` is newest first.
fn suite_names(runs: &[SuiteRun]) -> Vec<String> {
    let mut suites: Vec<String> = Vec::new();
    for run in runs {
        if !suites.contains(&run.suite) {
            suites.push(run.suite.clone());
        }
    }
    suites
}

/// Each file's recent outcomes as a `dots` chart: a row per file that has
/// any, oldest left, `PASS` good, a `FAIL`, `ERR` or `OVERTIME` bad, and
/// anything else neutral. `runs` are newest first, as the ledger answers;
/// at most the chart's row limit of files is kept, in the order given.
/// Each row links its file (`ref`) and each dot the commit its run stood on
/// (`refs`, in the dots' order), all through one budget; a run whose
/// recorded sha is not one carries no ref. `None` when no file has an
/// outcome.
///
/// Beside the spec comes its member table: each dot (`Item`) is its one
/// run, and each row (`Row`) is the file's runs newest first. A run's member
/// carries what the ledger holds of it, and the commit it stood on as its
/// ref when the recorded sha is one.
pub fn file_outcomes(
    files: &[(String, Vec<FileRun>)],
    title: &str,
    subtitle: &str,
) -> Option<(Value, MemberTable)> {
    let mut budget = RefBudget::new();
    let mut members = MemberTable::default();
    let rows: Vec<Value> = files
        .iter()
        .filter(|(_, runs)| !runs.is_empty())
        .take(MAX_ROWS)
        .enumerate()
        .map(|(row, (file, runs))| {
            let run_member = |r: &FileRun| {
                Member::fact(
                    FactKind::Run,
                    is_sha(&r.head_sha).then(|| commit_ref(&r.head_sha)),
                    json!({
                        "status": r.status,
                        "ended_at": r.ended_at,
                        "secs": r.secs,
                        "passed": r.passed,
                        "total": r.total,
                        "head_sha": r.head_sha,
                    }),
                )
            };
            members.set(MemberKey::Row(row), runs.iter().map(run_member).collect());
            for (item, r) in runs.iter().rev().enumerate() {
                members.set(MemberKey::Item { row, item }, vec![run_member(r)]);
            }
            let items: Vec<&str> = runs
                .iter()
                .rev()
                .map(|r| match r.status.as_str() {
                    "PASS" => "good",
                    "FAIL" | "ERR" | "OVERTIME" => "bad",
                    _ => "neutral",
                })
                .collect();
            let file_ref = format!(
                "file:tests/app-test/{}",
                apptest_ledger::ledger_file_name(file)
            );
            let row_ref = set_slots("file", vec![vec![file_ref]], &mut budget).remove(0);
            let dots: Vec<Vec<String>> = runs
                .iter()
                .rev()
                .map(|r| {
                    if is_sha(&r.head_sha) {
                        vec![commit_ref(&r.head_sha)]
                    } else {
                        Vec::new()
                    }
                })
                .collect();
            let refs = set_slots("commit", dots, &mut budget);
            json!({ "label": row_label(file), "items": items, "ref": row_ref, "refs": refs })
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    Some((
        json!({
            "tugchart": 1,
            "form": "dots",
            "title": title,
            "subtitle": subtitle,
            "rows": rows,
        }),
        members,
    ))
}

/// Each suite's recent runs as a `dots` chart: a row per suite in order of
/// its newest run, at most the chart's row limit, each row its newest
/// [`RUNS_PER_FILE`] runs oldest left, `PASS` good, `FAIL` bad, anything
/// else neutral. `runs` are newest first, as the ledger answers. Each row
/// links the command its newest run ran, and each dot the commit its run
/// stood on when the recorded sha is one. The members mirror
/// [`file_outcomes`]: a row is its runs newest first and a dot its one run,
/// each a run fact. `None` with no run.
pub fn suite_outcomes(runs: &[SuiteRun]) -> Option<(Value, MemberTable)> {
    let mut budget = RefBudget::new();
    let mut members = MemberTable::default();
    let suites = suite_names(runs);
    let rows: Vec<Value> = suites
        .iter()
        .take(MAX_ROWS)
        .enumerate()
        .map(|(row, suite)| {
            let mine: Vec<&SuiteRun> = runs
                .iter()
                .filter(|r| r.suite == *suite)
                .take(RUNS_PER_FILE)
                .collect();
            let run_member = |r: &SuiteRun| {
                Member::fact(
                    FactKind::Run,
                    is_sha(&r.head_sha).then(|| commit_ref(&r.head_sha)),
                    json!({
                        "status": r.verdict,
                        "ended_at": r.ended_at,
                        "secs": r.wall_secs.round() as i64,
                        "passed": (r.tests - r.failed - r.skipped).max(0),
                        "total": r.tests,
                        "head_sha": r.head_sha,
                    }),
                )
            };
            members.set(
                MemberKey::Row(row),
                mine.iter().map(|r| run_member(r)).collect(),
            );
            for (item, r) in mine.iter().rev().enumerate() {
                members.set(MemberKey::Item { row, item }, vec![run_member(r)]);
            }
            let items: Vec<&str> = mine
                .iter()
                .rev()
                .map(|r| match r.verdict.as_str() {
                    "PASS" => "good",
                    "FAIL" => "bad",
                    _ => "neutral",
                })
                .collect();
            let command = command_ref(&one_line(&mine[0].command));
            let row_ref = set_slots("command", vec![vec![command]], &mut budget).remove(0);
            let dots: Vec<Vec<String>> = mine
                .iter()
                .rev()
                .map(|r| {
                    if is_sha(&r.head_sha) {
                        vec![commit_ref(&r.head_sha)]
                    } else {
                        Vec::new()
                    }
                })
                .collect();
            let refs = set_slots("commit", dots, &mut budget);
            json!({ "label": suite, "items": items, "ref": row_ref, "refs": refs })
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    Some((
        json!({
            "tugchart": 1,
            "form": "dots",
            "title": "Unit-suite history",
            "subtitle": format!("newest {RUNS_PER_FILE} runs per suite, oldest left"),
            "rows": rows,
        }),
        members,
    ))
}

/// The clause of a summary line naming every file `file_outcomes` leaves off
/// the chart: those with no runs, and those past the row limit. Empty when the
/// chart carries every file.
pub fn dropped_files(files: &[(String, Vec<FileRun>)]) -> String {
    let names = |rows: Vec<&String>| {
        rows.into_iter()
            .map(|file| row_label(file))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let (with_runs, no_runs): (Vec<_>, Vec<_>) =
        files.iter().partition(|(_, runs)| !runs.is_empty());
    let mut clause = String::new();
    if !no_runs.is_empty() {
        let no_runs = names(no_runs.into_iter().map(|(file, _)| file).collect());
        clause.push_str(&format!("; no runs: {no_runs}"));
    }
    if with_runs.len() > MAX_ROWS {
        let cut = names(with_runs[MAX_ROWS..].iter().map(|(file, _)| file).collect());
        clause.push_str(&format!("; past the {MAX_ROWS}-row limit: {cut}"));
    }
    clause
}

pub(crate) fn test_history(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let base = base_root(ctx);
    if !ctx.apptest_ledger.exists() {
        return Ok(no_apptest_runs(&base));
    }
    let conn = open_apptest_ledger(&ctx.apptest_ledger)?;
    // A source's `until` re-chooses the files and the runs the chart drew.
    let until_secs = args.until.as_deref().and_then(|until| {
        chrono::DateTime::parse_from_rfc3339(until)
            .ok()
            .map(|at| at.timestamp())
    });
    let files = if args.subjects.is_empty() {
        apptest_ledger::recent_red_files_until(&conn, &base, DEFAULT_RED_FILES, until_secs)
            .map_err(ledger_error)?
    } else {
        args.subjects.clone()
    };
    let mut rows = Vec::with_capacity(files.len());
    for file in &files {
        let runs =
            apptest_ledger::recent_file_runs_until(&conn, &base, file, RUNS_PER_FILE, until_secs)
                .map_err(ledger_error)?;
        rows.push((file.clone(), runs));
    }
    let subtitle = format!("newest {RUNS_PER_FILE} runs per file, oldest left");
    let Some((mut spec, members)) = file_outcomes(&rows, "App-test history", &subtitle) else {
        return Ok(no_apptest_runs(&base));
    };
    apply_title(&mut spec, args);
    // The default files are re-chosen by recency at `until`; only a list the
    // user typed rides along.
    let mut source = SourceArgs::until(&until_for(args));
    if !args.subjects.is_empty() {
        source = source.with("files", &args.subjects);
    }
    stamp_source(&mut spec, "test-history", source);
    let plotted = spec["rows"].as_array().map_or(0, Vec::len);
    let summary = format!(
        "{plotted} of {} file(s) with recorded runs for {base}, newest {RUNS_PER_FILE} each{}",
        files.len(),
        dropped_files(&rows)
    );
    Ok(RecipeOutcome::Chart {
        summary,
        spec,
        members,
    })
}

pub(crate) fn suite_history(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let base = base_root(ctx);
    if !ctx.test_ledger.exists() {
        return Ok(no_suite_runs(&base));
    }
    let conn = test_ledger::open_ledger(&ctx.test_ledger).map_err(ledger_error)?;
    // A source's `until` re-reads the runs the chart drew.
    let until_secs = args.until.as_deref().and_then(|until| {
        chrono::DateTime::parse_from_rfc3339(until)
            .ok()
            .map(|at| at.timestamp())
    });
    let runs = test_ledger::recent_runs_until(&conn, &base, None, RUNS_PER_FILE, until_secs)
        .map_err(ledger_error)?;
    let Some((mut spec, members)) = suite_outcomes(&runs) else {
        return Ok(no_suite_runs(&base));
    };
    apply_title(&mut spec, args);
    stamp_source(
        &mut spec,
        "suite-history",
        SourceArgs::until(&until_for(args)),
    );
    let plotted = spec["rows"].as_array().map_or(0, Vec::len);
    let suites = suite_names(&runs).len();
    let cut = if suites > plotted {
        format!(
            "; past the {MAX_ROWS}-row limit: {} suite(s)",
            suites - plotted
        )
    } else {
        String::new()
    };
    let summary = format!(
        "{plotted} suite(s) with recorded runs for {base}, newest {RUNS_PER_FILE} each{cut}"
    );
    Ok(RecipeOutcome::Chart {
        summary,
        spec,
        members,
    })
}

#[cfg(test)]
mod unit {
    use super::*;
    use crate::context::test_support::{assert_source, assert_valid, context_at};
    use tugtool_core::apptest_ledger::{FileResult, RunRecord};

    fn seed_apptest(ctx: &RecipeContext, at: i64, files: &[(&str, &str, i64)]) {
        let mut conn = apptest_ledger::open_ledger(&ctx.apptest_ledger).unwrap();
        let run = RunRecord {
            started_at: at - 60,
            ended_at: at,
            run_root: ctx.repo_root.to_string_lossy().into_owned(),
            branch: "main".into(),
            head_sha: "abc1234".into(),
            dirty: false,
            sweep: "explicit-files".into(),
            selection: "explicit".into(),
            wall_secs: 60,
            verdict: "PASS".into(),
            stopped_reason: None,
            files: files
                .iter()
                .map(|(file, status, secs)| FileResult {
                    file: (*file).to_string(),
                    status: (*status).to_string(),
                    passed: 1,
                    total: 1,
                    secs: *secs,
                    foreground: false,
                })
                .collect(),
        };
        apptest_ledger::record_run(&mut conn, &run).unwrap();
    }

    fn run_recipe(name: &str, ctx: &RecipeContext, args: &RecipeArgs) -> RecipeOutcome {
        crate::find(name).unwrap().run(ctx, args).unwrap()
    }

    #[test]
    fn test_history_defaults_to_the_files_most_recently_red() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        seed_apptest(
            &ctx,
            100,
            &[("old.test.ts", "FAIL", 1), ("green.test.ts", "PASS", 1)],
        );
        seed_apptest(&ctx, 101, &[("new.test.ts", "OVERTIME", 1)]);

        let RecipeOutcome::Chart { spec, summary, .. } =
            run_recipe("test-history", &ctx, &RecipeArgs::default())
        else {
            panic!("expected a chart");
        };
        assert_valid(&spec);
        assert_source(&spec, "test-history");
        assert!(spec["source"]["args"].get("files").is_none(), "{spec}");
        let labels: Vec<&str> = spec["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["new", "old"]);
        // Each row links its file, and each dot the tree its run stood on.
        let rows = spec["rows"].as_array().unwrap();
        assert_eq!(rows[0]["ref"], "file:tests/app-test/new.test.ts");
        assert_eq!(rows[0]["refs"], json!(["commit:abc1234"]));
        assert_eq!(rows[1]["ref"], "file:tests/app-test/old.test.ts");
        assert_eq!(rows[1]["refs"], json!(["commit:abc1234"]));
        assert!(summary.starts_with("2 of 2 file(s)"), "{summary}");
    }

    #[test]
    fn test_history_names_a_named_file_with_no_runs() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        seed_apptest(&ctx, 100, &[("a.test.ts", "PASS", 1)]);
        let args = RecipeArgs {
            subjects: vec!["a.test.ts".to_string(), "b.test.ts".to_string()],
            ..Default::default()
        };
        let RecipeOutcome::Chart { summary, spec, .. } = run_recipe("test-history", &ctx, &args)
        else {
            panic!("expected a chart");
        };
        assert!(summary.starts_with("1 of 2 file(s)"), "{summary}");
        assert!(summary.ends_with("; no runs: b"), "{summary}");
        // A list the user typed rides along.
        assert_source(&spec, "test-history");
        assert_eq!(
            spec["source"]["args"]["files"],
            json!(["a.test.ts", "b.test.ts"])
        );
    }

    #[test]
    fn a_missing_ledger_has_no_data_and_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        assert!(matches!(
            run_recipe("test-history", &ctx, &RecipeArgs::default()),
            RecipeOutcome::NoData { .. }
        ));
        assert!(!ctx.apptest_ledger.exists());
    }

    #[test]
    fn suite_history_over_a_missing_ledger_has_no_data_and_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        let RecipeOutcome::NoData { summary } =
            run_recipe("suite-history", &ctx, &RecipeArgs::default())
        else {
            panic!("a missing ledger drew a chart");
        };
        assert!(
            summary.starts_with("no recorded unit-suite runs for"),
            "{summary}"
        );
        assert!(!ctx.test_ledger.exists());
    }

    #[test]
    fn suite_history_reads_the_recorded_runs_and_stamps_its_source() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        let root = test_ledger::run_root_for(&ctx.repo_root);
        let mut conn = test_ledger::open_ledger(&ctx.test_ledger).unwrap();
        for (at, suite) in [(100, "rust"), (200, "tugdeck")] {
            let run = test_ledger::TestRun {
                started_at: at - 10,
                ended_at: at,
                run_root: root.to_string_lossy().into_owned(),
                branch: "main".into(),
                head_sha: "abc1234".into(),
                dirty: false,
                suite: suite.into(),
                session_id: None,
                tool_use_id: None,
                input_key: None,
                command: format!("just test-{suite}"),
                exit_code: 0,
                wall_secs: 10.0,
            };
            test_ledger::record_run(&mut conn, &run, None).unwrap();
        }
        drop(conn);
        let RecipeOutcome::Chart { spec, summary, .. } =
            run_recipe("suite-history", &ctx, &RecipeArgs::default())
        else {
            panic!("suite-history drew nothing");
        };
        assert_source(&spec, "suite-history");
        assert_eq!(spec["rows"].as_array().unwrap().len(), 2);
        assert!(summary.starts_with("2 suite(s)"), "{summary}");
    }

    /// A run of `suite` with a real sha, failing when `red`.
    fn suite_run(suite: &str, id: i64, red: bool, sha: &str) -> SuiteRun {
        SuiteRun {
            head_sha: sha.to_string(),
            command: format!("just  test-{suite}\n --fast"),
            verdict: if red { "FAIL" } else { "PASS" }.to_string(),
            tests: 10,
            failed: if red { 2 } else { 0 },
            skipped: 1,
            wall_secs: 12.6,
            ..run(suite, id, 0.0)
        }
    }

    #[test]
    fn suite_outcomes_read_each_suite_oldest_left_with_runs_as_facts() {
        // Newest first, as the ledger answers.
        let runs = [
            suite_run("rust", 4, false, "abc1234"),
            suite_run("tugdeck", 3, true, "def5678"),
            suite_run("rust", 2, true, "placeholder"),
            suite_run("tugdeck", 1, false, "def5678"),
        ];
        let (spec, members) = suite_outcomes(&runs).unwrap();
        assert_valid(&spec);
        assert_eq!(spec["title"], "Unit-suite history");
        let rows = spec["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["label"], "rust");
        assert_eq!(rows[0]["items"], json!(["bad", "good"]));
        assert_eq!(rows[1]["items"], json!(["good", "bad"]));
        // The row links its newest command, on one line; a dot links its
        // commit only where the sha is one.
        assert_eq!(rows[0]["ref"], "command:just test-rust --fast");
        assert_eq!(rows[0]["refs"], json!([null, "commit:abc1234"]));
        // A row is its runs newest first; a dot is its one run.
        let row = members.get(MemberKey::Row(0));
        assert_eq!(row.len(), 2);
        assert!(row.iter().all(|m| m.fact_kind == Some(FactKind::Run)));
        assert_eq!(row[0].r#ref.as_deref(), Some("commit:abc1234"));
        let oldest = &members.get(MemberKey::Item { row: 0, item: 0 })[0];
        assert_eq!(oldest.r#ref, None);
        assert_eq!(
            oldest.facts,
            Some(json!({
                "status": "FAIL", "ended_at": 2, "secs": 13, "passed": 7,
                "total": 10, "head_sha": "placeholder",
            }))
        );
        assert!(suite_outcomes(&[]).is_none());
    }

    fn run(suite: &str, id: i64, secs: f64) -> SuiteRun {
        SuiteRun {
            run_id: id,
            suite: suite.to_string(),
            started_at: id,
            ended_at: id,
            run_root: "/r".to_string(),
            branch: "main".to_string(),
            head_sha: "h".to_string(),
            dirty: false,
            session_id: None,
            tool_use_id: None,
            command: "c".to_string(),
            exit_code: 0,
            wall_secs: secs,
            tests: 1,
            failed: 0,
            skipped: 0,
            has_record: true,
            verdict: "PASS".to_string(),
            files: Vec::new(),
            failures: Vec::new(),
        }
    }

    #[test]
    fn suite_wall_times_pads_short_suites_and_orders_by_recency() {
        // Newest first, as the ledger answers: deck ran last.
        let runs = vec![
            run("deck", 5, 3.0),
            run("rust", 4, 70.0),
            run("deck", 3, 2.0),
            run("rust", 2, 60.0),
            run("rust", 1, 50.0),
        ];
        let spec = suite_wall_times(&runs, 3, 8, "Wall time").unwrap();
        assert_eq!(spec["x"], json!(["2", "1", "0"]));
        assert_eq!(spec["series"][0]["name"], "deck");
        assert_eq!(spec["series"][0]["values"], json!([null, 2.0, 3.0]));
        assert_eq!(spec["series"][1]["values"], json!([50.0, 60.0, 70.0]));
        assert_valid(&spec);
    }

    #[test]
    fn suite_wall_times_with_no_run_draws_nothing() {
        assert!(suite_wall_times(&[], 3, MAX_SUITES, "t").is_none());
    }

    #[test]
    fn suite_wall_times_keeps_at_most_max_suites() {
        let runs: Vec<SuiteRun> = (0..10)
            .map(|i| run(&format!("s{i}"), 10 - i, 1.0))
            .collect();
        let spec = suite_wall_times(&runs, 2, 3, "t").unwrap();
        assert_eq!(spec["series"].as_array().unwrap().len(), 3);
        assert_eq!(spec["series"][0]["name"], "s0");
    }

    #[test]
    fn file_outcomes_reads_oldest_left_and_drops_files_without_runs() {
        let files = vec![
            (
                "a.test.ts".to_string(),
                vec![
                    outcome("PASS", 3),
                    outcome("OVERTIME", 2),
                    outcome("ERR", 1),
                ],
            ),
            ("b.test.ts".to_string(), Vec::new()),
            ("c.test.ts".to_string(), vec![outcome("PENDING", 1)]),
        ];
        let (spec, members) = file_outcomes(&files, "t", "s").unwrap();
        assert_eq!(spec["form"], "dots");
        assert_eq!(spec["rows"].as_array().unwrap().len(), 2);
        assert_eq!(spec["rows"][0]["label"], "a");
        assert_eq!(spec["rows"][0]["items"], json!(["bad", "bad", "good"]));
        assert_eq!(spec["rows"][0]["ref"], "file:tests/app-test/a.test.ts");
        // The dots' commits read in the dots' order, oldest left.
        assert_eq!(
            spec["rows"][0]["refs"],
            json!(["commit:00010000", "commit:00020000", "commit:00030000"])
        );
        assert_eq!(spec["rows"][1]["items"], json!(["neutral"]));
        assert_valid(&spec);
        assert!(file_outcomes(&[("x".to_string(), Vec::new())], "t", "s").is_none());

        // A dot is its one run, counted from the oldest as the dots are.
        let dot = members.get(MemberKey::Item { row: 0, item: 0 });
        assert_eq!(dot.len(), 1);
        assert_eq!(dot[0].r#ref.as_deref(), Some("commit:00010000"));
        assert_eq!(dot[0].fact_kind, Some(FactKind::Run));
        assert_eq!(
            dot[0].facts,
            Some(json!({
                "status": "ERR", "ended_at": 1, "secs": 7, "passed": 2, "total": 3,
                "head_sha": "00010000",
            }))
        );
        // A row is the file's runs, newest first.
        let row: Vec<i64> = members
            .get(MemberKey::Row(0))
            .iter()
            .map(|m| m.facts.as_ref().unwrap()["ended_at"].as_i64().unwrap())
            .collect();
        assert_eq!(row, [3, 2, 1]);
        // The second row drawn is the third file given: the table counts
        // rows as the chart does.
        assert_eq!(members.get(MemberKey::Row(1)).len(), 1);
        assert!(members.get(MemberKey::Row(2)).is_empty());
    }

    #[test]
    fn a_run_on_a_placeholder_sha_has_its_facts_and_no_ref() {
        let mut run = outcome("FAIL", 5);
        run.head_sha = "unknown".to_string();
        let (_, members) =
            file_outcomes(&[("a.test.ts".to_string(), vec![run])], "t", "s").unwrap();
        let dot = &members.get(MemberKey::Item { row: 0, item: 0 })[0];
        assert_eq!(dot.r#ref, None);
        assert_eq!(dot.facts.as_ref().unwrap()["status"], "FAIL");
        assert_eq!(dot.facts.as_ref().unwrap()["head_sha"], "unknown");
    }

    #[test]
    fn dropped_files_names_files_without_runs_and_files_past_the_row_limit() {
        let with_runs = |n: usize| {
            (0..n)
                .map(|i| (format!("f{i}.test.ts"), vec![outcome("PASS", 1)]))
                .collect::<Vec<_>>()
        };
        assert_eq!(dropped_files(&with_runs(MAX_ROWS)), "");

        let mut files = with_runs(MAX_ROWS + 2);
        files.insert(1, ("gone.test.ts".to_string(), Vec::new()));
        let last = MAX_ROWS + 1;
        assert_eq!(
            dropped_files(&files),
            format!("; no runs: gone; past the {MAX_ROWS}-row limit: f{MAX_ROWS}, f{last}")
        );
        // The clause and the chart agree on which rows were cut.
        let (spec, _) = file_outcomes(&files, "t", "s").unwrap();
        let rows = spec["rows"].as_array().unwrap();
        assert_eq!(rows.len(), MAX_ROWS);
        assert_eq!(rows[MAX_ROWS - 1]["label"], format!("f{}", MAX_ROWS - 1));
    }

    fn outcome(status: &str, ended_at: i64) -> FileRun {
        FileRun {
            status: status.to_string(),
            ended_at,
            head_sha: format!("{ended_at:04x}0000"),
            secs: 7,
            passed: 2,
            total: 3,
        }
    }

    #[test]
    fn outcomes_read_oldest_left_and_past_the_row_limit_are_named() {
        let files: Vec<(String, Vec<FileRun>)> = (0..=MAX_ROWS)
            .map(|k| {
                (
                    format!("f{k}.test.ts"),
                    vec![outcome("PASS", 2), outcome("ERR", 1)],
                )
            })
            .collect();
        let (spec, _) = file_outcomes(&files, "t", "s").unwrap();
        assert_eq!(spec["rows"].as_array().unwrap().len(), MAX_ROWS);
        assert_eq!(spec["rows"][0]["items"], json!(["bad", "good"]));
        assert_eq!(
            dropped_files(&files),
            format!("; past the {MAX_ROWS}-row limit: f{MAX_ROWS}")
        );
    }
}
