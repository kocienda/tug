//! The recipes over the test ledgers.
//!
//! A ledger's open creates a missing file, and a chart that has nothing to
//! read must not leave one behind, so each recipe asks whether the file is
//! there first.

use std::path::Path;

use rusqlite::Connection;
use serde_json::{Value, json};
use tuggraphics::chart::spec::{MAX_ROWS, MAX_VALUES};
use tugtool_core::apptest_ledger::{self, FileMedian, FileRun, resolve_base_root};
use tugtool_core::test_ledger::{self, SuiteRun};

use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, row_label,
};

/// How many newest runs per suite `suite-times` and `test last --chart` read.
pub const RUNS_PER_SUITE: usize = 30;
/// How many suites one line chart holds.
pub const MAX_SUITES: usize = 8;
/// How many newest outcomes per file a row of dots holds.
pub const RUNS_PER_FILE: usize = 20;

/// Under this share of the slowest suite's median, a suite lies flat on its
/// scale and says nothing there.
const SCALE_FLOOR: f64 = 0.05;
/// How many newest runs a file's median and history are read from.
const RUNS_PER_MEDIAN: usize = 20;
const DEFAULT_BUDGET_ROWS: usize = 12;
const DEFAULT_RED_FILES: usize = 20;

/// The base root a project's ledger rows are keyed by.
fn base_root(ctx: &RecipeContext) -> String {
    resolve_base_root(&test_ledger::run_root_for(&ctx.repo_root))
}

fn no_runs(base_root: &str) -> RecipeOutcome {
    RecipeOutcome::NoData {
        summary: format!("no recorded test runs for {base_root}"),
    }
}

fn no_apptest_runs(base_root: &str) -> RecipeOutcome {
    RecipeOutcome::NoData {
        summary: format!("no recorded app-test runs for {base_root}"),
    }
}

fn open_test_ledger(path: &Path) -> Result<Connection, RecipeError> {
    test_ledger::open_ledger(path).map_err(|e| RecipeError::Ledger(e.to_string()))
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

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.is_empty() {
        0.0
    } else if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    }
}

/// The suites on the slowest suite's scale, and those too small to read on it,
/// each in order of their newest run.
fn on_the_scale(runs: &[SuiteRun], per_suite: usize) -> (Vec<String>, Vec<String>) {
    let medians: Vec<(String, f64)> = suite_names(runs)
        .into_iter()
        .map(|suite| {
            let mut secs: Vec<f64> = runs
                .iter()
                .filter(|r| r.suite == suite)
                .take(per_suite)
                .map(|r| r.wall_secs)
                .collect();
            let m = median(&mut secs);
            (suite, m)
        })
        .collect();
    let slowest = medians.iter().map(|(_, m)| *m).fold(0.0_f64, f64::max);
    let (kept, cut): (Vec<_>, Vec<_>) = medians
        .into_iter()
        .partition(|(_, m)| *m >= slowest * SCALE_FLOOR);
    let names = |rows: Vec<(String, f64)>| rows.into_iter().map(|(s, _)| s).collect();
    (names(kept), names(cut))
}

/// Which suites a `suite-times` chart plots, those it left out, and those named
/// with no recorded run.
fn chosen_suites(
    runs: &[SuiteRun],
    per_suite: usize,
    args: &RecipeArgs,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let known = suite_names(runs);
    let (mut kept, mut left_out, missing) = if !args.suites.is_empty() {
        let kept: Vec<String> = known
            .iter()
            .filter(|s| args.suites.contains(s))
            .cloned()
            .collect();
        let missing = args
            .suites
            .iter()
            .filter(|s| !known.contains(s))
            .cloned()
            .collect();
        (kept, Vec::new(), missing)
    } else if args.all {
        (known, Vec::new(), Vec::new())
    } else {
        let (kept, cut) = on_the_scale(runs, per_suite);
        (kept, cut, Vec::new())
    };
    if kept.len() > MAX_SUITES {
        left_out.extend(kept.split_off(MAX_SUITES));
    }
    (kept, left_out, missing)
}

fn clause(label: &str, names: &[String]) -> String {
    if names.is_empty() {
        String::new()
    } else {
        format!("; {label}: {}", names.join(", "))
    }
}

pub(crate) fn suite_times(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let base = base_root(ctx);
    if !ctx.test_ledger.exists() {
        return Ok(no_runs(&base));
    }
    let per_suite = args.runs.unwrap_or(RUNS_PER_SUITE).clamp(1, MAX_VALUES);
    let conn = open_test_ledger(&ctx.test_ledger)?;
    let runs = test_ledger::recent_runs(&conn, &base, None, per_suite).map_err(ledger_error)?;
    let (kept, left_out, missing) = chosen_suites(&runs, per_suite, args);
    let plotted: Vec<SuiteRun> = runs
        .into_iter()
        .filter(|r| kept.contains(&r.suite))
        .collect();
    let title = format!("Suite wall time, newest {per_suite} runs");
    let Some(mut spec) = suite_wall_times(&plotted, per_suite, MAX_SUITES, &title) else {
        return Ok(RecipeOutcome::NoData {
            summary: format!(
                "no recorded test runs for {base}{}",
                clause("no runs", &missing)
            ),
        });
    };
    apply_title(&mut spec, args);
    let summary = format!(
        "{} run(s) across {} suite(s) for {base}, newest {per_suite} per suite{}{}",
        plotted.len(),
        kept.len(),
        clause("left out", &left_out),
        clause("no runs", &missing),
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

pub(crate) fn test_distribution(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let base = base_root(ctx);
    if !ctx.test_ledger.exists() {
        return Ok(no_runs(&base));
    }
    let conn = open_test_ledger(&ctx.test_ledger)?;
    let suite = args.suites.first().map(String::as_str);
    let runs = test_ledger::latest_per_suite(&conn, &base, suite).map_err(ledger_error)?;
    let suites = runs.iter().filter(|r| !r.files.is_empty()).count();
    let secs: Vec<f64> = runs
        .iter()
        .flat_map(|r| r.files.iter().map(|f| f.secs))
        .collect();
    if secs.is_empty() {
        return Ok(RecipeOutcome::NoData {
            summary: format!("no per-file times recorded for {base}"),
        });
    }
    let kept = &secs[..secs.len().min(MAX_VALUES)];
    let left_out = secs.len() - kept.len();
    let mut spec = json!({
        "tugchart": 1,
        "form": "histogram",
        "title": "Test file wall times, latest run",
        "unit": "wall time",
        "format": "secs",
        "values": kept,
    });
    apply_title(&mut spec, args);
    let left_out = if left_out == 0 {
        String::new()
    } else {
        format!("; left out: {left_out} file(s)")
    };
    let summary = format!(
        "{} file(s) across {suites} suite(s), latest runs{left_out}",
        kept.len()
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

/// The `limit` files nearest the budget as a bullet: the newest time against
/// the budget, on a range half again as long, with the newest runs beside it.
/// `medians` come slowest first, which against one budget is nearest first.
fn budget_chart(medians: &[FileMedian], budget: f64, limit: usize) -> Value {
    let items: Vec<Value> = medians
        .iter()
        .take(limit)
        .map(|m| {
            json!({
                "label": row_label(&m.file),
                "value": m.latest_secs,
                "range": [0.0, budget * 1.5],
                "target": budget,
                "history": m.history,
            })
        })
        .collect();
    json!({
        "tugchart": 1,
        "form": "bullet",
        "title": "App-test files nearest the budget",
        "unit": "seconds",
        "format": "secs",
        "items": items,
    })
}

pub(crate) fn test_budget(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let base = base_root(ctx);
    if !ctx.apptest_ledger.exists() {
        return Ok(no_apptest_runs(&base));
    }
    let conn = open_apptest_ledger(&ctx.apptest_ledger)?;
    let medians =
        apptest_ledger::file_medians(&conn, &base, RUNS_PER_MEDIAN).map_err(ledger_error)?;
    if medians.is_empty() {
        return Ok(no_apptest_runs(&base));
    }
    let limit = args.limit.unwrap_or(DEFAULT_BUDGET_ROWS).clamp(1, MAX_ROWS);
    let budget = ctx.apptest_budget_secs;
    let mut spec = budget_chart(&medians, budget, limit);
    apply_title(&mut spec, args);
    let over = medians.iter().filter(|m| m.median_secs > budget).count();
    let summary = format!(
        "{} of {} file(s) with recorded times for {base}, budget {budget}s, {over} over it by median",
        limit.min(medians.len()),
        medians.len(),
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

/// Each file's recent outcomes as a `dots` chart: a row per file that has
/// any, oldest left, `PASS` good, a `FAIL`, `ERR` or `OVERTIME` bad, and
/// anything else neutral. `runs` are newest first, as the ledger answers;
/// at most the chart's row limit of files is kept, in the order given.
/// `None` when no file has an outcome.
pub fn file_outcomes(
    files: &[(String, Vec<FileRun>)],
    title: &str,
    subtitle: &str,
) -> Option<Value> {
    let rows: Vec<Value> = files
        .iter()
        .filter(|(_, runs)| !runs.is_empty())
        .take(MAX_ROWS)
        .map(|(file, runs)| {
            let items: Vec<&str> = runs
                .iter()
                .rev()
                .map(|r| match r.status.as_str() {
                    "PASS" => "good",
                    "FAIL" | "ERR" | "OVERTIME" => "bad",
                    _ => "neutral",
                })
                .collect();
            json!({ "label": row_label(file), "items": items })
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    Some(json!({
        "tugchart": 1,
        "form": "dots",
        "title": title,
        "subtitle": subtitle,
        "rows": rows,
    }))
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
    let files = if args.subjects.is_empty() {
        apptest_ledger::recent_red_files(&conn, &base, DEFAULT_RED_FILES).map_err(ledger_error)?
    } else {
        args.subjects.clone()
    };
    let mut rows = Vec::with_capacity(files.len());
    for file in &files {
        let runs = apptest_ledger::recent_file_runs(&conn, &base, file, RUNS_PER_FILE)
            .map_err(ledger_error)?;
        rows.push((file.clone(), runs));
    }
    let subtitle = format!("newest {RUNS_PER_FILE} runs per file, oldest left");
    let Some(mut spec) = file_outcomes(&rows, "App-test history", &subtitle) else {
        return Ok(no_apptest_runs(&base));
    };
    apply_title(&mut spec, args);
    let plotted = spec["rows"].as_array().map_or(0, Vec::len);
    let summary = format!(
        "{plotted} of {} file(s) with recorded runs for {base}, newest {RUNS_PER_FILE} each{}",
        files.len(),
        dropped_files(&rows)
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

#[cfg(test)]
mod unit {
    use super::*;
    use crate::context::test_support::{assert_valid, context_at};
    use tugtool_core::apptest_ledger::{FileResult, RunRecord};
    use tugtool_core::test_ledger::{JunitFile, JunitRun, TestRun};

    fn seed_suite(ctx: &RecipeContext, suite: &str, at: i64, secs: f64, files: &[(&str, f64)]) {
        let mut conn = test_ledger::open_ledger(&ctx.test_ledger).unwrap();
        let run = TestRun {
            started_at: at - 1,
            ended_at: at,
            run_root: ctx.repo_root.to_string_lossy().into_owned(),
            branch: "main".to_string(),
            head_sha: "abc".to_string(),
            dirty: false,
            suite: suite.to_string(),
            session_id: None,
            tool_use_id: None,
            command: "c".to_string(),
            exit_code: 0,
            wall_secs: secs,
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

    fn seed_apptest(ctx: &RecipeContext, at: i64, files: &[(&str, &str, i64)]) {
        let mut conn = apptest_ledger::open_ledger(&ctx.apptest_ledger).unwrap();
        let run = RunRecord {
            started_at: at - 60,
            ended_at: at,
            run_root: ctx.repo_root.to_string_lossy().into_owned(),
            branch: "main".into(),
            head_sha: "abc".into(),
            dirty: false,
            sweep: "explicit-files".into(),
            selection: "explicit".into(),
            wall_secs: 60,
            verdict: "PASS".into(),
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
    fn a_suite_too_small_for_the_scale_is_left_out_and_named() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        seed_suite(&ctx, "rust", 100, 110.0, &[]);
        seed_suite(&ctx, "rust", 101, 112.0, &[]);
        seed_suite(&ctx, "tugproto", 102, 0.07, &[]);

        let RecipeOutcome::Chart { spec, summary } =
            run_recipe("suite-times", &ctx, &RecipeArgs::default())
        else {
            panic!("expected a chart");
        };
        assert_valid(&spec);
        let series = spec["series"].as_array().unwrap();
        assert_eq!(series.len(), 1);
        assert_eq!(series[0]["name"], "rust");
        assert_eq!(series[0]["values"][29], 112.0);
        assert_eq!(series[0]["values"][27], Value::Null);
        assert!(summary.ends_with("; left out: tugproto"), "{summary}");

        let all = RecipeArgs {
            all: true,
            ..Default::default()
        };
        let RecipeOutcome::Chart { spec, summary } = run_recipe("suite-times", &ctx, &all) else {
            panic!("expected a chart");
        };
        assert_eq!(spec["series"].as_array().unwrap().len(), 2);
        assert!(!summary.contains("left out"), "{summary}");
    }

    #[test]
    fn a_named_suite_is_plotted_however_small_and_a_missing_one_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        seed_suite(&ctx, "rust", 100, 110.0, &[]);
        seed_suite(&ctx, "tugproto", 101, 0.07, &[]);
        let args = RecipeArgs {
            suites: vec!["tugproto".to_string(), "nosuch".to_string()],
            runs: Some(3),
            ..Default::default()
        };
        let RecipeOutcome::Chart { spec, summary } = run_recipe("suite-times", &ctx, &args) else {
            panic!("expected a chart");
        };
        assert_eq!(spec["series"].as_array().unwrap().len(), 1);
        assert_eq!(spec["series"][0]["name"], "tugproto");
        assert_eq!(spec["x"].as_array().unwrap().len(), 3);
        assert!(summary.ends_with("; no runs: nosuch"), "{summary}");
    }

    #[test]
    fn past_the_suite_limit_a_suite_is_left_out_and_named() {
        let runs: Vec<SuiteRun> = Vec::new();
        assert!(suite_wall_times(&runs, 3, MAX_SUITES, "t").is_none());

        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        for k in 0..=MAX_SUITES {
            seed_suite(&ctx, &format!("s{k}"), 100 + k as i64, 10.0, &[]);
        }
        let all = RecipeArgs {
            all: true,
            ..Default::default()
        };
        let RecipeOutcome::Chart { spec, summary } = run_recipe("suite-times", &ctx, &all) else {
            panic!("expected a chart");
        };
        assert_eq!(spec["series"].as_array().unwrap().len(), MAX_SUITES);
        // Newest first, so the oldest suite is the one past the limit.
        assert!(summary.ends_with("; left out: s0"), "{summary}");
    }

    #[test]
    fn the_distribution_reads_every_file_of_each_latest_run() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        seed_suite(&ctx, "rust", 100, 1.0, &[("old", 500.0)]);
        seed_suite(&ctx, "rust", 101, 1.0, &[("a", 1.0), ("b", 2.0)]);
        seed_suite(&ctx, "ts", 102, 1.0, &[("c", 4.0)]);

        let RecipeOutcome::Chart { spec, summary } =
            run_recipe("test-distribution", &ctx, &RecipeArgs::default())
        else {
            panic!("expected a chart");
        };
        assert_valid(&spec);
        assert_eq!(spec["form"], "histogram");
        assert_eq!(spec["format"], "secs");
        let mut values: Vec<f64> = spec["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        values.sort_by(f64::total_cmp);
        assert_eq!(values, vec![1.0, 2.0, 4.0]);
        assert_eq!(summary, "3 file(s) across 2 suite(s), latest runs");

        let one = RecipeArgs {
            suites: vec!["ts".to_string()],
            ..Default::default()
        };
        let RecipeOutcome::Chart { summary, .. } = run_recipe("test-distribution", &ctx, &one)
        else {
            panic!("expected a chart");
        };
        assert_eq!(summary, "1 file(s) across 1 suite(s), latest runs");
    }

    #[test]
    fn the_budget_chart_ranks_by_median_and_reads_the_latest_against_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        seed_apptest(
            &ctx,
            100,
            &[
                ("t/at1-slow.test.ts", "PASS", 30),
                ("t/at2-near.test.ts", "PASS", 18),
                ("t/at3-quick.test.ts", "PASS", 2),
            ],
        );
        seed_apptest(&ctx, 101, &[("t/at1-slow.test.ts", "OVERTIME", 24)]);

        let args = RecipeArgs {
            limit: Some(2),
            ..Default::default()
        };
        let RecipeOutcome::Chart { spec, summary } = run_recipe("test-budget", &ctx, &args) else {
            panic!("expected a chart");
        };
        assert_valid(&spec);
        let items = spec["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["label"], "at1-slow");
        assert_eq!(items[0]["value"], 24.0);
        assert_eq!(items[0]["target"], 20.0);
        assert_eq!(items[0]["range"], json!([0.0, 30.0]));
        assert_eq!(items[0]["history"], json!([30.0, 24.0]));
        assert_eq!(items[1]["label"], "at2-near");
        assert!(summary.starts_with("2 of 3 file(s)"), "{summary}");
        assert!(summary.ends_with("1 over it by median"), "{summary}");
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

        let RecipeOutcome::Chart { spec, summary } =
            run_recipe("test-history", &ctx, &RecipeArgs::default())
        else {
            panic!("expected a chart");
        };
        assert_valid(&spec);
        let labels: Vec<&str> = spec["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["new", "old"]);
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
        let RecipeOutcome::Chart { summary, .. } = run_recipe("test-history", &ctx, &args) else {
            panic!("expected a chart");
        };
        assert!(summary.starts_with("1 of 2 file(s)"), "{summary}");
        assert!(summary.ends_with("; no runs: b"), "{summary}");
    }

    #[test]
    fn a_missing_ledger_has_no_data_and_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        for name in [
            "suite-times",
            "test-distribution",
            "test-budget",
            "test-history",
        ] {
            assert!(
                matches!(
                    run_recipe(name, &ctx, &RecipeArgs::default()),
                    RecipeOutcome::NoData { .. }
                ),
                "{name}"
            );
        }
        assert!(!ctx.test_ledger.exists());
        assert!(!ctx.apptest_ledger.exists());
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
        let spec = file_outcomes(&files, "t", "s").unwrap();
        assert_eq!(spec["form"], "dots");
        assert_eq!(spec["rows"].as_array().unwrap().len(), 2);
        assert_eq!(spec["rows"][0]["label"], "a");
        assert_eq!(spec["rows"][0]["items"], json!(["bad", "bad", "good"]));
        assert_eq!(spec["rows"][1]["items"], json!(["neutral"]));
        assert_valid(&spec);
        assert!(file_outcomes(&[("x".to_string(), Vec::new())], "t", "s").is_none());
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
        let spec = file_outcomes(&files, "t", "s").unwrap();
        let rows = spec["rows"].as_array().unwrap();
        assert_eq!(rows.len(), MAX_ROWS);
        assert_eq!(rows[MAX_ROWS - 1]["label"], format!("f{}", MAX_ROWS - 1));
    }

    fn outcome(status: &str, ended_at: i64) -> FileRun {
        FileRun {
            status: status.to_string(),
            ended_at,
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
        let spec = file_outcomes(&files, "t", "s").unwrap();
        assert_eq!(spec["rows"].as_array().unwrap().len(), MAX_ROWS);
        assert_eq!(spec["rows"][0]["items"], json!(["bad", "good"]));
        assert_eq!(
            dropped_files(&files),
            format!("; past the {MAX_ROWS}-row limit: f{MAX_ROWS}")
        );
    }
}
