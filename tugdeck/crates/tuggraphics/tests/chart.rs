//! Layer 1: chart goldens under `FixedMetrics`, the measure protocol's
//! round count, Find text, and the validator.
//!
//! Every `tests/chart-golden/<name>.json` spec compiles to exactly
//! `tests/chart-golden/<name>.svg`. After a deliberate change to the
//! output, rewrite them with
//! `TUGGRAPHICS_BLESS=1 cargo test -p tuggraphics --test chart` and read
//! the diff before committing it.

use std::fs;
use std::path::{Path, PathBuf};

use tuggraphics::chart::LAYER0_IN_FENCE;
use tuggraphics::measure::table_key;
use tuggraphics::{
    compile_round, compile_with, find_text, validate, ChartError, CompileOpts, Compiled, FixedMetrics, Layers,
    Measure, MeasureTable, Round, TypeRole,
};

fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/chart-golden")
}

fn golden_names() -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(golden_dir())
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            (p.extension()? == "json").then(|| p.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    names
}

fn opts() -> CompileOpts {
    CompileOpts {
        id_prefix: "g".into(),
        ..CompileOpts::default()
    }
}

#[test]
fn chart_goldens() {
    let names = golden_names();
    assert!(names.len() >= 8, "expected the chart goldens, found {names:?}");
    let bless = std::env::var_os("TUGGRAPHICS_BLESS").is_some();
    let mut failed = Vec::new();
    for name in &names {
        let source = fs::read_to_string(golden_dir().join(format!("{name}.json"))).unwrap();
        let out = compile_with(&source, &opts(), &FixedMetrics)
            .unwrap_or_else(|e| panic!("{name}.json does not compile: {e:?}"));
        let golden = golden_dir().join(format!("{name}.svg"));
        if bless {
            fs::write(&golden, &out.svg).unwrap();
        } else if fs::read_to_string(&golden).ok().as_deref() != Some(out.svg.as_str()) {
            failed.push(format!("{name}:\n{}", out.svg));
        }
    }
    assert!(failed.is_empty(), "goldens differ:\n{}", failed.join("\n\n"));
}

#[test]
fn find_text_is_the_table_text() {
    for name in golden_names() {
        let source = fs::read_to_string(golden_dir().join(format!("{name}.json"))).unwrap();
        let out = compile_with(&source, &opts(), &FixedMetrics).unwrap();
        let t = &out.table;
        let mut joined = t.caption.clone();
        joined.extend(t.head.iter().cloned());
        joined.extend(t.rows.iter().flatten().cloned());
        assert_eq!(out.find_text, joined, "{name}");
        assert_eq!(find_text(&source, Layers::Chart), joined, "{name}");
    }
}

#[test]
fn tables_per_form() {
    let bar = compile_with(&golden("bar-single"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(bar.table.caption, "Commits per day");
    assert_eq!(bar.table.head, vec!["", "commits"]);
    assert_eq!(bar.table.rows[0], vec!["10-21", "4"]);
    // A gap is an empty cell.
    assert_eq!(bar.table.rows[5], vec!["10-26", ""]);

    let spark = compile_with(&golden("sparkline-min-max"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(spark.table.head, vec!["", "latency"]);
    assert_eq!(spark.table.rows[0], vec!["1", "300ms"]);
    let untitled = compile_with(&golden("sparkline-last"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(untitled.table.caption, "");
    assert_eq!(untitled.table.head, vec!["", "value"]);
}

fn golden(name: &str) -> String {
    fs::read_to_string(golden_dir().join(format!("{name}.json"))).unwrap()
}

/// Drives `compile_round` the way the deck does, measuring with
/// `FixedMetrics`, and returns how many measure requests it made.
fn drive(source: &str, opts: &CompileOpts) -> (usize, Result<Compiled, Vec<ChartError>>) {
    let mut table = MeasureTable::new();
    let mut requests = 0;
    loop {
        match compile_round(source, opts, &table) {
            Round::Done(out) => return (requests, Ok(out)),
            Round::Invalid { errors } => return (requests, Err(errors)),
            Round::Measure { texts } => {
                requests += 1;
                assert!(requests <= 2, "a third measure request");
                for (role, text) in texts {
                    let role = TypeRole::parse(&role).unwrap();
                    table.insert(role, &text, FixedMetrics.measure(role, &text).unwrap());
                }
            }
        }
    }
}

#[test]
fn a_spec_needing_no_truncation_takes_one_measure_round() {
    let (requests, out) = drive(&golden("bar-single"), &opts());
    assert_eq!(requests, 1);
    let out = out.unwrap();
    assert_eq!(out, compile_with(&golden("bar-single"), &opts(), &FixedMetrics).unwrap());
    assert!(!out.svg.contains('…'));
}

#[test]
fn a_spec_needing_truncation_takes_two() {
    let spec = r#"{"tugchart": 1, "form": "bar", "title": "A title far too long to fit across a narrow chart frame",
        "categories": ["a", "b"], "series": [{"name": "n", "values": [1, 2]}], "size": {"w": 120}}"#;
    let (requests, out) = drive(spec, &opts());
    assert_eq!(requests, 2);
    let out = out.unwrap();
    assert!(out.svg.contains('…'), "{}", out.svg);
    assert_eq!(out, compile_with(spec, &opts(), &FixedMetrics).unwrap());
}

#[test]
fn a_sparkline_needs_no_measurement() {
    let (requests, out) = drive(&golden("sparkline-last"), &opts());
    assert_eq!(requests, 0);
    assert_eq!((out.unwrap().width, 24.0), (120.0, 24.0));
}

#[test]
fn round_one_asks_for_full_strings_only() {
    let Round::Measure { texts } = compile_round(&golden("bar-single"), &opts(), &MeasureTable::new()) else {
        panic!("round 1 should ask");
    };
    assert!(texts.contains(&("title".into(), "Commits per day".into())));
    assert!(texts.contains(&("label".into(), "main, last week · commits".into())));
    assert!(texts.contains(&("label".into(), "10-24".into())));
    assert!(texts.contains(&("value".into(), "12".into())));
    assert!(texts.iter().all(|(_, t)| !t.contains('…')));
    assert_eq!(table_key(TypeRole::Title, "x"), "title\u{0}x");
}

#[test]
fn the_frame_narrows_to_the_room_given() {
    let narrow = CompileOpts {
        width: Some(300.0),
        ..opts()
    };
    let out = compile_with(&golden("bar-single"), &narrow, &FixedMetrics).unwrap();
    assert_eq!((out.width, out.height), (300.0, 240.0));
    assert!(out.svg.contains("viewBox=\"0 0 300 240\""));
    // A spec narrower than the room keeps its own width.
    let out = compile_with(&golden("sparkline-none"), &narrow, &FixedMetrics).unwrap();
    assert_eq!(out.width, 200.0);
}

#[test]
fn crowded_categories_are_thinned() {
    let out = compile_with(&golden("bar-crowded"), &opts(), &FixedMetrics).unwrap();
    assert!(out.svg.contains(">day 01</text>"));
    assert!(!out.svg.contains(">day 02</text>"), "every label shown:\n{}", out.svg);
    let shown = (1..=60).filter(|i| out.svg.contains(&format!(">day {i:02}</text>"))).count();
    assert!((2..=15).contains(&shown), "{shown} labels shown");
    assert!(!out.svg.contains('…'));
}

#[test]
fn motion_none_writes_no_entrances() {
    let still = compile_with(&golden("bar-rule"), &opts(), &FixedMetrics).unwrap();
    assert!(!still.svg.contains("tge-"));
    let off = CompileOpts { motion: false, ..opts() };
    let out = compile_with(&golden("bar-single"), &off, &FixedMetrics).unwrap();
    assert!(!out.svg.contains("tge-"));
    let on = compile_with(&golden("bar-single"), &opts(), &FixedMetrics).unwrap();
    assert!(on.svg.contains("tge-grow tge-from-bottom"));
}

fn errors(source: &str) -> Vec<ChartError> {
    validate(source, Layers::Chart).unwrap_err()
}

fn one_error(source: &str) -> ChartError {
    let errs = errors(source);
    assert_eq!(errs.len(), 1, "{errs:?}");
    errs.into_iter().next().unwrap()
}

#[test]
fn too_many_series() {
    let series: Vec<String> = (0..9).map(|i| format!("{{\"name\": \"s{i}\", \"values\": [1]}}")).collect();
    let src = format!(
        r#"{{"tugchart": 1, "form": "bar", "title": "t", "categories": ["a"], "series": [{}]}}"#,
        series.join(", ")
    );
    let e = one_error(&src);
    assert_eq!(e.path, "/series");
    assert_eq!(e.message, "a chart has 1 to 8 series");
}

#[test]
fn unknown_form() {
    let e = one_error(r#"{"tugchart": 1, "form": "pie", "title": "t"}"#);
    assert_eq!(e.path, "/form");
    assert_eq!(
        e.message,
        "unknown form \"pie\": expected bar, line, area, sparkline, dots, histogram, spans, heat or bullet"
    );
}

#[test]
fn tables_for_the_other_forms() {
    let dots = compile_with(&golden("dots"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(dots.table.head, vec!["", "good", "bad", "neutral"]);
    assert_eq!(dots.table.rows[0], vec!["at0602-find-fidelity-sweep.test.ts", "5", "1", "1"]);

    let spans = compile_with(&golden("spans"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(spans.table.head, vec!["", "start", "end", "status"]);
    assert_eq!(spans.table.rows[0], vec!["Spec and validator", "0", "18", "good"]);
    assert_eq!(spans.table.rows[1], vec!["Forms", "18", "55", ""]);

    let bullet = compile_with(&golden("bullet"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(bullet.table.head, vec!["", "value", "range", "target"]);
    assert_eq!(bullet.table.rows[0], vec!["rust", "1m12s", "1m00s–1m30s", "1m20s"]);
    assert_eq!(bullet.table.rows[2], vec!["app-tests", "5m10s", "", "4m00s"]);

    let heat = compile_with(&golden("heat"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(heat.table.head, vec!["", "Commits per day"]);
    assert_eq!(heat.table.rows[4], vec!["05", ""]);
    assert_eq!(heat.table.rows[8], vec!["09", "12"]);

    let hist = compile_with(&golden("histogram"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(hist.table.head, vec!["", "count"]);
    assert_eq!(hist.table.rows.len(), 6);
    assert_eq!(hist.table.rows[0], vec!["2s–5s", "6"]);

    let area = compile_with(&golden("area-stacked"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(area.table.head, vec!["", "rust", "deck", "app"]);
    // A gap stacks as zero in the figure and stays an empty cell here.
    assert_eq!(area.table.rows[1], vec!["2,022", "650", "", "20"]);
}

#[test]
fn histogram_bins_follow_freedman_diaconis_or_the_spec() {
    let auto = compile_with(&golden("histogram"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(auto.table.rows.len(), 6);
    assert_eq!(auto.table.rows.iter().map(|r| r[1].parse::<u32>().unwrap()).sum::<u32>(), 20);
    let given = compile_with(&golden("histogram-bins"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(given.table.rows.len(), 6);
    assert_eq!(given.table.rows[3], vec!["7–7.17", "4"]);
    for bins in [3, 41] {
        let e = one_error(&format!(
            r#"{{"tugchart": 1, "form": "histogram", "title": "t", "bins": {bins}, "values": [1, 2]}}"#
        ));
        assert_eq!((e.path.as_str(), e.message.as_str()), ("/bins", "bins is an integer from 4 to 40"));
    }
    let e = one_error(r#"{"tugchart": 1, "form": "histogram", "title": "t", "values": [null]}"#);
    assert_eq!((e.path.as_str(), e.message.as_str()), ("/values", "a histogram needs at least one number"));
}

#[test]
fn each_form_names_its_required_fields() {
    let cases: [(&str, &str, &str); 11] = [
        (r#"{"tugchart": 1, "form": "dots", "title": "t"}"#, "/rows", "rows is required"),
        (
            r#"{"tugchart": 1, "form": "dots", "title": "t", "rows": [{"label": "a", "items": ["good", "ok"]}]}"#,
            "/rows/0/items/1",
            "an item is good, bad or neutral",
        ),
        (
            r#"{"tugchart": 1, "form": "spans", "title": "t", "items": [{"label": "a", "start": 1}]}"#,
            "/items/0/end",
            "end is required",
        ),
        (
            r#"{"tugchart": 1, "form": "spans", "title": "t", "items": [{"label": "a", "start": 5, "end": 1}]}"#,
            "/items/0/end",
            "end is at least start",
        ),
        (
            r#"{"tugchart": 1, "form": "heat", "title": "t", "categories": ["a", "b", "c"], "values": [1, 2]}"#,
            "/values",
            "values has 2 entries for 3 categories",
        ),
        (
            r#"{"tugchart": 1, "form": "bullet", "title": "t", "items": [{"label": "a"}]}"#,
            "/items/0/value",
            "value is required",
        ),
        (
            r#"{"tugchart": 1, "form": "bullet", "title": "t", "items": [{"label": "a", "value": 1, "range": [3, 2]}]}"#,
            "/items/0/range",
            "a range is [lo, hi] with lo at most hi",
        ),
        (
            r#"{"tugchart": 1, "form": "area", "title": "t", "layout": "grouped", "series": [{"values": [1]}]}"#,
            "/layout",
            "layout is one of overlap, stacked",
        ),
        (
            r#"{"tugchart": 1, "form": "bar", "title": "t", "orient": "diagonal", "categories": ["a"], "series": [{"values": [1]}]}"#,
            "/orient",
            "orient is one of vertical, horizontal",
        ),
        (
            r#"{"tugchart": 1, "form": "dots", "title": "t", "rows": [{"label": "a", "items": ["good"]}], "annotations": []}"#,
            "/annotations",
            "a dots takes no annotations",
        ),
        (
            r#"{"tugchart": 1, "form": "spans", "title": "t", "items": [{"label": "a", "start": 0, "end": 1, "status": "late"}]}"#,
            "/items/0/status",
            "a status is good, bad or accent",
        ),
    ];
    for (source, path, message) in cases {
        let e = one_error(source);
        assert_eq!((e.path.as_str(), e.message.as_str()), (path, message), "{source}");
    }
    let rows: Vec<String> = (0..41).map(|i| format!("\"c{i}\"")).collect();
    let values = vec!["1"; 41].join(", ");
    let e = one_error(&format!(
        r#"{{"tugchart": 1, "form": "bar", "orient": "horizontal", "title": "t", "categories": [{}], "series": [{{"values": [{values}]}}]}}"#,
        rows.join(", ")
    ));
    assert_eq!(e.path, "/categories");
    assert_eq!(e.message, "a horizontal bar chart has at most 40 categories");
}

#[test]
fn default_frames_follow_the_rows() {
    let frame = |name: &str| {
        let out = compile_with(&golden(name), &opts(), &FixedMetrics).unwrap();
        (out.width, out.height)
    };
    assert_eq!(frame("bar-horizontal"), (560.0, 5.0 * 24.0 + 56.0));
    assert_eq!(frame("dots"), (560.0, 3.0 * 18.0 + 40.0));
    assert_eq!(frame("spans"), (560.0, 4.0 * 20.0 + 48.0));
    assert_eq!(frame("bullet"), (560.0, 3.0 * 28.0 + 40.0));
    assert_eq!(frame("heat"), (560.0, 64.0));
    assert_eq!(frame("histogram"), (560.0, 200.0));
    assert_eq!(frame("area-overlap"), (560.0, 240.0));
    // A row form is not held to the axis chart's minimum height.
    let short = r#"{"tugchart": 1, "form": "heat", "title": "t", "categories": ["a"], "values": [1], "size": {"h": 40}}"#;
    assert!(validate(short, Layers::Chart).is_ok());
    let e = one_error(
        r#"{"tugchart": 1, "form": "histogram", "title": "t", "values": [1, 2, 3], "size": {"h": 100}}"#,
    );
    assert_eq!(e.path, "/size/h");
    assert_eq!(e.message, "size.h is a number from 120 to 1200 for a histogram");
}

#[test]
fn stacked_bars_label_totals_only() {
    let out = compile_with(&golden("bar-stacked"), &opts(), &FixedMetrics).unwrap();
    assert!(out.svg.contains(">140</text>"), "{}", out.svg);
    assert!(out.svg.contains(">-30</text>"));
    assert!(!out.svg.contains(">120</text>"), "a segment was labelled:\n{}", out.svg);
    assert!(out.svg.contains("tge-grow tge-from-top"));
}

#[test]
fn overlapping_areas_are_translucent_and_stacked_ones_are_not() {
    let overlap = compile_with(&golden("area-overlap"), &opts(), &FixedMetrics).unwrap();
    assert!(overlap.svg.contains("opacity=\"0.35\""));
    let stacked = compile_with(&golden("area-stacked"), &opts(), &FixedMetrics).unwrap();
    assert!(!stacked.svg.contains("opacity="));
    // The row forms grow from the left and the dots fade by column.
    let spans = compile_with(&golden("spans"), &opts(), &FixedMetrics).unwrap();
    assert!(spans.svg.contains("tge-grow tge-from-left"));
    let dots = compile_with(&golden("dots"), &opts(), &FixedMetrics).unwrap();
    assert!(dots.svg.contains("tgf-good tge-fade"));
    assert!(dots.svg.contains("tgf-ink-muted tge-fade"));
}

#[test]
fn missing_title() {
    let e = one_error(r#"{"tugchart": 1, "form": "line", "series": [{"name": "a", "values": [1, 2]}]}"#);
    assert_eq!(e.path, "/title");
    assert_eq!(e.message, "title is required");
    // A sparkline needs none.
    assert!(validate(r#"{"tugchart": 1, "form": "sparkline", "values": [1]}"#, Layers::Chart).is_ok());
}

#[test]
fn a_121_grapheme_label() {
    // Each family emoji is one grapheme of five code points.
    let long = "👨\u{200d}👩\u{200d}👧".repeat(121);
    let ok = "👨\u{200d}👩\u{200d}👧".repeat(120);
    let src = |c: &str| {
        format!(r#"{{"tugchart": 1, "form": "bar", "title": "t", "categories": ["{c}"], "series": [{{"values": [1]}}]}}"#)
    };
    let e = one_error(&src(&long));
    assert_eq!(e.path, "/categories/0");
    assert_eq!(e.message, "a category is at most 120 characters");
    assert!(validate(&src(&ok), Layers::Chart).is_ok());
}

#[test]
fn every_error_is_reported_with_its_path() {
    let errs = errors(
        r#"{"tugchart": 2, "form": "bar", "title": 5, "colour": "red", "categories": ["a", "b"],
            "series": [{"name": "x", "values": [1, "two"]}, {"values": [1]}], "size": {"w": 10}}"#,
    );
    let paths: Vec<&str> = errs.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["/tugchart", "/colour", "/title", "/size/w", "/series/0/values/1"],
        "{errs:?}"
    );
    let errs = errors(r#"{"tugchart": 1, "form": "bar", "title": "t", "categories": ["a", "b"], "series": [{"values": [1]}]}"#);
    assert_eq!(errs[0].path, "/series/0/values");
    assert_eq!(errs[0].message, "series has 1 values for 2 categories");
}

const DRAWING: &str = r#"{"tugdraw": 1, "frame": [40, 20], "ops": [["rect", 0, 0, 10, 10], ["fill", "series-1", {"enter": "fade"}],
    ["text", 20, 10, "hi"]]}"#;

#[test]
fn a_drawing_is_refused_by_a_fence_and_taken_by_a_tool() {
    let e = one_error(DRAWING);
    assert_eq!((e.path.as_str(), e.message.as_str()), ("", LAYER0_IN_FENCE));
    // A fence shows an invalid source as itself, so Find counts it.
    assert_eq!(find_text(DRAWING, Layers::Chart), DRAWING);

    let any = CompileOpts {
        layers: Layers::Any,
        ..opts()
    };
    // One round, no measurement, an empty table and no findable text.
    let (requests, out) = drive(DRAWING, &any);
    let out = out.unwrap();
    assert_eq!(requests, 0);
    assert_eq!((out.width, out.height), (40.0, 20.0));
    assert_eq!(out.table, Default::default());
    assert_eq!(out.find_text, "");
    assert_eq!(find_text(DRAWING, Layers::Any), "");
    assert!(out.svg.contains("tge-fade"));
    let still = CompileOpts { motion: false, ..any };
    assert!(!compile_with(DRAWING, &still, &FixedMetrics).unwrap().svg.contains("tge-"));
    // A drawing's errors point into its ops.
    let bad = r#"{"tugdraw": 1, "frame": [40, 20], "ops": [["fill", "red"]]}"#;
    let errs = validate(bad, Layers::Any).unwrap_err();
    assert_eq!(errs[0].path, "/ops/0");
}

#[test]
fn opts_read_the_protocol_shape() {
    // A finished round serializes flat, tagged by status, as the deck reads it.
    let out = compile_with(&golden("sparkline-last"), &opts(), &FixedMetrics).unwrap();
    let json = serde_json::to_value(Round::Done(out)).unwrap();
    assert_eq!(json["status"], "done");
    assert_eq!(json["width"], 120.0);
    assert_eq!(json["table"]["head"][1], "value");
    let o = CompileOpts::from_json(r#"{"width": 320, "id_prefix": "c7", "motion": false, "layers": "any"}"#).unwrap();
    assert_eq!(
        o,
        CompileOpts {
            width: Some(320.0),
            id_prefix: "c7".into(),
            motion: false,
            layers: Layers::Any,
            palette: None,
        }
    );
    assert!(CompileOpts::from_json(r#"{"layers": "all"}"#).is_err());
}
