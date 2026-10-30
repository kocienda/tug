//! The `--chart` door: a verb's data as one `TUG-CHART:` stdout line.
//!
//! A `TUG-CHART: ` line carries one layer 1 chart spec, which the Session
//! card's Bash block strips from the terminal text and renders as a figure
//! beneath it, the way a `TUG-FILE-RECEIPT:` line is read for attribution.
//! The spec is built here with `serde_json`, from what the verb already
//! read, and validated with the engine itself before it is printed — so a
//! line this module emits is a chart the deck will draw, never one it will
//! refuse.
//!
//! The verbs: `tugtool log --chart` (commits per committer day, a bar),
//! `tugtool test last --chart` (each suite's wall time over its newest runs,
//! a line), `tugtool apptest history --chart` (each file's newest outcomes,
//! dots). `--chart` and the global `--json` are two output shapes for one
//! stdout, so a handler refuses the pair before it reads anything.
//!
//! `tugtool chart render` is the standalone door: the same engine with no
//! page under it. Text is measured with the deck's own woff2 faces, embedded
//! here so the binary needs nothing beside it, and the SVG carries one
//! `<style>` resolving its classes to a theme's palette — the colours the
//! page would show, extracted from the themes by
//! `tugdeck/scripts/extract-chart-palette.ts`.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDate;
use serde_json::{Value, json};
use tugchanges_core::LogEntry;
use tuggraphics::chart::spec::MAX_ROWS;
use tuggraphics::{CompileOpts, FaceMeasurer, Layers, Palette, TypeRole, compile_with, validate};
use tugtool_core::apptest_ledger::FileRun;
use tugtool_core::test_ledger::SuiteRun;

use crate::changes::AppError;
use crate::output::print_ok;

/// The deck's faces, the very bytes the page serves.
const SANS_REGULAR: &[u8] =
    include_bytes!("../../../../tugdeck/public/fonts/IBMPlexSans-Regular.woff2");
const SANS_SEMIBOLD: &[u8] =
    include_bytes!("../../../../tugdeck/public/fonts/IBMPlexSans-SemiBold.woff2");
const MONO_REGULAR: &[u8] =
    include_bytes!("../../../../tugdeck/public/fonts/IBMPlexMono-Regular.woff2");

/// `{theme: {role: hex}}`, one resolved colour per chart role per theme.
const PALETTE_JSON: &str = include_str!("../../../../tugdeck/crates/tuggraphics/src/palette.json");

/// Each type role's face, px size and CSS `font` shorthand — the deck's
/// type scale (`--tug-font-size-sm`, `-xs`, `-2xs`) and weights, as
/// `chart-block.css` declares them for the `tgt-<role>` classes.
const ROLE_FACES: [(TypeRole, &[u8], f64, &str); 4] = [
    (
        TypeRole::Title,
        SANS_SEMIBOLD,
        13.0,
        "600 13px \"IBM Plex Sans\"",
    ),
    (
        TypeRole::Label,
        SANS_REGULAR,
        12.0,
        "400 12px \"IBM Plex Sans\"",
    ),
    (
        TypeRole::Value,
        SANS_REGULAR,
        11.0,
        "400 11px \"IBM Plex Sans\"",
    ),
    (
        TypeRole::Mono,
        MONO_REGULAR,
        11.0,
        "400 11px \"IBM Plex Mono\"",
    ),
];

/// The theme names the embedded palette carries, sorted.
pub fn theme_names() -> Vec<String> {
    serde_json::from_str::<Value>(PALETTE_JSON)
        .ok()
        .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect()))
        .unwrap_or_default()
}

/// The palette a standalone SVG's `<style>` resolves to: `theme`'s chart
/// colours from the embedded palette, and the four type roles' fonts.
pub fn palette_for(theme: &str) -> Result<Palette, AppError> {
    let palettes: Value = serde_json::from_str(PALETTE_JSON).map_err(|e| {
        AppError::Exit1(
            "failed",
            format!("the embedded chart palette is not JSON: {e}"),
        )
    })?;
    let Some(colours) = palettes.get(theme).and_then(Value::as_object) else {
        return Err(AppError::Exit1(
            "usage",
            format!(
                "unknown theme {theme:?}; the themes are {}",
                theme_names().join(", ")
            ),
        ));
    };
    let mut palette = Palette::default();
    for (role, hex) in colours {
        let hex = hex.as_str().ok_or_else(|| {
            AppError::Exit1(
                "failed",
                format!("palette colour {theme}/{role} is not a string"),
            )
        })?;
        palette.colours.insert(role.clone(), hex.to_string());
    }
    for (role, _, _, font) in ROLE_FACES {
        palette
            .fonts
            .insert(role.name().to_string(), font.to_string());
    }
    Ok(palette)
}

/// The measurer over the embedded faces, at the deck's sizes.
fn face_measurer() -> Result<FaceMeasurer<'static>, AppError> {
    let faces: Vec<(TypeRole, &[u8], f64)> =
        ROLE_FACES.iter().map(|(r, b, s, _)| (*r, *b, *s)).collect();
    FaceMeasurer::from_woff2(&faces)
        .map_err(|e| AppError::Exit1("failed", format!("cannot read the embedded faces: {e}")))
}

/// Render a chart spec or a drawing, read from `spec` (`-` for stdin), to
/// a standalone SVG at `out`, coloured by `theme`, at most `width` px wide.
/// Prints where it wrote and the figure's size, or the same as a `--json`
/// envelope.
pub fn run_render(
    spec: &str,
    out: &Path,
    theme: &str,
    width: Option<f64>,
    json: bool,
) -> Result<(), AppError> {
    if width.is_some_and(|w| !(w > 0.0 && w.is_finite())) {
        return Err(AppError::Exit1(
            "usage",
            "--width is a positive number of px".to_string(),
        ));
    }
    let source = if spec == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).map_err(|e| {
            AppError::Exit1("failed", format!("cannot read the source from stdin: {e}"))
        })?;
        text
    } else {
        std::fs::read_to_string(spec)
            .map_err(|e| AppError::Exit1("failed", format!("cannot read {spec}: {e}")))?
    };
    let palette = palette_for(theme)?;
    let measurer = face_measurer()?;
    let opts = CompileOpts {
        width,
        id_prefix: "tg".to_string(),
        // A file has no stylesheet to play an entrance, so none is written.
        motion: false,
        layers: Layers::Any,
        palette: Some(palette),
    };
    let compiled = compile_with(&source, &opts, &measurer).map_err(|errors| {
        let listed: Vec<String> = errors
            .iter()
            .map(|e| {
                if e.path.is_empty() {
                    e.message.clone()
                } else {
                    format!("{}: {}", e.path, e.message)
                }
            })
            .collect();
        AppError::Exit1(
            "invalid",
            format!("not a valid chart or drawing: {}", listed.join("; ")),
        )
    })?;
    std::fs::write(out, &compiled.svg)
        .map_err(|e| AppError::Exit1("failed", format!("cannot write {}: {e}", out.display())))?;
    if json {
        print_ok(
            "chart render",
            json!({
                "out": out,
                "theme": theme,
                "width": compiled.width,
                "height": compiled.height,
            }),
        );
    } else {
        println!(
            "wrote {} ({}×{} px, theme {theme})",
            out.display(),
            compiled.width,
            compiled.height
        );
    }
    Ok(())
}

/// The head of the stdout line the deck reads.
pub const CHART_LINE_PREFIX: &str = "TUG-CHART: ";

/// How many runs per suite `test last --chart` plots, newest at the right.
pub const RUNS_PER_SUITE: usize = 30;

/// How many suites one wall-time chart carries — the series tokens a theme has.
pub const MAX_SUITES: usize = 8;

/// How many runs per file `apptest history --chart` plots, oldest left.
pub const RUNS_PER_FILE: usize = 20;

/// Refuse `--chart` beside the global `--json`: both shape the whole of stdout.
pub fn refuse_json(json: bool) -> Result<(), AppError> {
    if json {
        return Err(AppError::Exit1(
            "usage",
            "--chart and --json cannot be combined".to_string(),
        ));
    }
    Ok(())
}

/// The `TUG-CHART: ` line for `spec`, after the engine has accepted it.
/// A spec the engine refuses is a defect in the verb that built it, and is
/// reported as one rather than printed for the deck to refuse later.
pub fn chart_line(spec: &Value) -> Result<String, AppError> {
    let source = serde_json::to_string(spec)
        .map_err(|e| AppError::Exit1("failed", format!("cannot serialize the chart: {e}")))?;
    if let Err(errors) = validate(&source, Layers::Chart) {
        let listed: Vec<String> = errors
            .iter()
            .map(|e| {
                if e.path.is_empty() {
                    e.message.clone()
                } else {
                    format!("{}: {}", e.path, e.message)
                }
            })
            .collect();
        return Err(AppError::Exit1(
            "failed",
            format!(
                "the chart this verb built is not valid: {}",
                listed.join("; ")
            ),
        ));
    }
    Ok(format!("{CHART_LINE_PREFIX}{source}"))
}

/// Commits per committer day, as a bar chart: one category per day from the
/// first to the last dated commit, zero days included, oldest left.
/// `None` when no commit carries a date the chart can place.
pub fn commits_per_day(commits: &[LogEntry], title: &str, subtitle: &str) -> Option<Value> {
    let mut by_day: BTreeMap<NaiveDate, u32> = BTreeMap::new();
    for commit in commits {
        if let Ok(day) = NaiveDate::parse_from_str(&commit.date, "%Y-%m-%d") {
            *by_day.entry(day).or_insert(0) += 1;
        }
    }
    let first = *by_day.keys().next()?;
    let last = *by_day.keys().next_back()?;
    let mut categories = Vec::new();
    let mut values = Vec::new();
    let mut day = first;
    loop {
        categories.push(day.format("%Y-%m-%d").to_string());
        values.push(json!(by_day.get(&day).copied().unwrap_or(0)));
        if day == last {
            break;
        }
        day = day.succ_opt()?;
    }
    Some(json!({
        "tugchart": 1,
        "form": "bar",
        "title": title,
        "subtitle": subtitle,
        "unit": "commits",
        "format": "int",
        "categories": categories,
        "series": [{ "name": "commits", "values": values }],
    }))
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
    // Suites in order of their newest run; `runs` is newest first.
    let mut suites: Vec<&str> = Vec::new();
    for run in runs {
        if !suites.iter().any(|s| *s == run.suite) {
            suites.push(&run.suite);
        }
    }
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
            json!({ "label": file, "items": items })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(status: &str, ended_at: i64) -> FileRun {
        FileRun {
            status: status.to_string(),
            ended_at,
        }
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
        assert_eq!(spec["rows"][0]["label"], "a.test.ts");
        assert_eq!(spec["rows"][0]["items"], json!(["bad", "bad", "good"]));
        assert_eq!(spec["rows"][1]["items"], json!(["neutral"]));
        assert!(chart_line(&spec).is_ok());
        assert!(file_outcomes(&[("x".to_string(), Vec::new())], "t", "s").is_none());
    }

    fn entry(date: &str) -> LogEntry {
        LogEntry {
            sha: "abc1234".to_string(),
            subject: "s".to_string(),
            date: date.to_string(),
        }
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
    fn commits_per_day_fills_the_zero_days_and_validates() {
        let spec = commits_per_day(
            &[
                entry("2026-10-27"),
                entry("2026-10-29"),
                entry("2026-10-29"),
            ],
            "Commits",
            "last 30 days",
        )
        .unwrap();
        assert_eq!(
            spec["categories"],
            json!(["2026-10-27", "2026-10-28", "2026-10-29"])
        );
        assert_eq!(spec["series"][0]["values"], json!([1, 0, 2]));
        assert!(chart_line(&spec).unwrap().starts_with(CHART_LINE_PREFIX));
    }

    #[test]
    fn commits_per_day_is_none_without_a_dated_commit() {
        assert!(commits_per_day(&[], "t", "s").is_none());
        assert!(commits_per_day(&[entry("")], "t", "s").is_none());
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
        assert!(chart_line(&spec).is_ok());
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
    fn chart_line_refuses_an_invalid_spec() {
        let err = chart_line(&json!({ "tugchart": 1, "form": "pie" })).unwrap_err();
        assert!(matches!(err, AppError::Exit1("failed", _)));
    }

    #[test]
    fn refuse_json_names_the_pair() {
        assert!(refuse_json(false).is_ok());
        assert!(matches!(
            refuse_json(true),
            Err(AppError::Exit1("usage", _))
        ));
    }
}
