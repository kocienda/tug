//! Refs in a chart spec: the slots the validator takes and refuses, the
//! table addresses they land at, and the hit targets and label rules the
//! figure carries for the deck to find them by.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tuggraphics::chart::{RefSlot, MAX_REFS, MAX_SET};
use tuggraphics::{
    compile_with, validate, ChartError, CompileOpts, Compiled, FixedMetrics, Layers,
};

fn opts() -> CompileOpts {
    CompileOpts {
        id_prefix: "g".into(),
        ..CompileOpts::default()
    }
}

fn compile(spec: &Value) -> Compiled {
    compile_with(&spec.to_string(), &opts(), &FixedMetrics)
        .unwrap_or_else(|e| panic!("does not compile: {e:?}\n{spec}"))
}

fn errors(spec: &Value) -> Vec<ChartError> {
    validate(&spec.to_string(), Layers::Chart).expect_err("should be refused")
}

/// The one error a spec earns, as (pointer, message).
fn one_error(spec: &Value) -> (String, String) {
    let errs = errors(spec);
    assert_eq!(errs.len(), 1, "{errs:?}");
    (errs[0].path.clone(), errs[0].message.clone())
}

fn one(r: &str) -> Option<RefSlot> {
    Some(RefSlot::One(r.to_string()))
}

fn set(kind: &str, members: &[&str]) -> Option<RefSlot> {
    Some(RefSlot::Set {
        kind: kind.to_string(),
        members: members.iter().map(|m| m.to_string()).collect(),
    })
}

fn count(kind: &str, n: u32) -> Option<RefSlot> {
    Some(RefSlot::Count {
        kind: kind.to_string(),
        count: n,
    })
}

fn bar(refs: Value) -> Value {
    json!({"tugchart": 1, "form": "bar", "title": "t",
        "categories": ["a", "b", "c"],
        "series": [{"name": "s", "values": [1, 2, 3]}],
        "refs": refs})
}

#[test]
fn every_slot_shape_and_kind_is_taken() {
    let out = compile(&bar(json!([
        "commit:63de5762a",
        ["file:src/a.ts", "file:src/b.ts"],
        {"kind": "session", "count": 3},
    ])));
    assert_eq!(
        out.table.refs.rows,
        vec![
            one("commit:63de5762a"),
            set("file", &["file:src/a.ts", "file:src/b.ts"]),
            count("session", 3),
        ]
    );
    for r in [
        "commit:abcd",
        "file:tugdeck/src/lib/chart/render-chart.ts",
        "dir:tugdeck/src",
        "session:tug/mighty-cabin",
        "session:048e4155",
        "session:048e4155-f644-46f7-a839-d22ac02a564f",
        "arc:chart-cross-references",
        "url:https://example.com/a?b=c",
        "command:just app-test-build",
    ] {
        let out = compile(&bar(json!([r, null, null])));
        assert_eq!(out.table.refs.rows[0], one(r), "{r}");
    }
}

#[test]
fn a_one_member_array_reads_as_its_ref() {
    let out = compile(&bar(json!([["commit:63de5762a"], null, null])));
    assert_eq!(out.table.refs.rows[0], one("commit:63de5762a"));
}

#[test]
fn each_ref_error_is_reported_at_its_pointer() {
    assert_eq!(
        one_error(&bar(json!(["x:y", null, null]))),
        (
            "/refs/0".to_string(),
            "unknown ref kind \"x\": expected commit, file, dir, session, arc, url or command"
                .to_string()
        )
    );
    for (r, why) in [
        ("commit:xyz", "a commit ref"),
        ("commit:abc", "a commit ref"),
        ("arc:Chart", "an arc ref"),
        ("session:nope", "a session ref"),
        ("url:ftp://x", "a url ref"),
        ("command:", "a command ref"),
        ("file:a\nb", "a file ref"),
    ] {
        let (path, message) = one_error(&bar(json!([r, null, null])));
        assert_eq!(path, "/refs/0", "{r}");
        assert!(message.starts_with(why), "{r}: {message}");
    }
    let (path, message) = one_error(&bar(json!([["commit:abcd", "file:a"], null, null])));
    assert_eq!(path, "/refs/0/1");
    assert!(
        message.starts_with("a set holds refs of one kind"),
        "{message}"
    );

    let big: Vec<String> = (0..=MAX_SET).map(|i| format!("commit:{i:04x}")).collect();
    let (path, message) = one_error(&bar(json!([big, null, null])));
    assert_eq!(path, "/refs/0");
    assert_eq!(message, format!("a set holds 1 to {MAX_SET} refs"));

    let (path, message) = one_error(&bar(json!(["commit:abcd", null])));
    assert_eq!(path, "/refs");
    assert_eq!(message, "refs has 2 entries for 3 categories");

    let (path, _) = one_error(&bar(json!([{"kind": "commit", "count": 0}, null, null])));
    assert_eq!(path, "/refs/0/count");
}

#[test]
fn a_sparkline_and_a_rule_take_no_refs() {
    let spark = json!({"tugchart": 1, "form": "sparkline", "values": [1, 2], "refs": [null, null]});
    assert_eq!(
        one_error(&spark),
        ("/refs".to_string(), "unknown field \"refs\"".to_string())
    );
    let rule = json!({"tugchart": 1, "form": "bar", "title": "t", "categories": ["a"],
        "series": [{"name": "s", "values": [1]}],
        "annotations": [{"kind": "rule", "value": 1, "ref": "commit:abcd"}]});
    assert_eq!(
        one_error(&rule),
        (
            "/annotations/0/ref".to_string(),
            "unknown field \"ref\"".to_string()
        )
    );
}

#[test]
fn past_the_spec_cap_is_an_error_at_the_spec() {
    // Nine sets of 89 make 801; each set is within its own cap.
    let n = 9;
    let per = MAX_REFS / 9 + 1;
    let categories: Vec<String> = (0..n).map(|i| format!("c{i}")).collect();
    let refs: Vec<Vec<String>> = (0..n)
        .map(|i| (0..per).map(|k| format!("commit:{i:02x}{k:04x}")).collect())
        .collect();
    assert!(n * per > MAX_REFS);
    let spec = json!({"tugchart": 1, "form": "bar", "title": "t",
        "categories": categories,
        "series": [{"name": "s", "values": vec![1; n]}],
        "refs": refs});
    let (path, message) = one_error(&spec);
    assert_eq!(path, "");
    assert!(
        message.contains(&format!("at most {MAX_REFS} refs")),
        "{message}"
    );
    // Count forms count nothing, so the same chart in counts is taken.
    let counts: Vec<Value> = (0..n)
        .map(|_| json!({"kind": "commit", "count": per}))
        .collect();
    let mut taken = spec.clone();
    taken["refs"] = json!(counts);
    compile(&taken);
}

#[test]
fn a_histogram_sample_is_one_ref_of_one_kind() {
    let hist = |refs: Value| {
        json!({"tugchart": 1, "form": "histogram", "title": "t",
            "values": [1, 2, 3], "refs": refs})
    };
    let (path, message) = one_error(&hist(json!([["commit:abcd", "commit:abce"], null, null])));
    assert_eq!(path, "/refs/0");
    assert_eq!(message, "a histogram sample's ref is a single ref");
    let (path, _) = one_error(&hist(json!([{"kind": "commit", "count": 2}, null, null])));
    assert_eq!(path, "/refs/0");
    let (path, message) = one_error(&hist(json!(["commit:abcd", "file:a", null])));
    assert_eq!(path, "/refs/1");
    assert!(message.starts_with("a histogram's refs are of one kind"));
}

#[test]
fn no_existing_fixture_grows_a_refs_key() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/chart-golden");
    let mut seen = 0;
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let source = fs::read_to_string(&path).unwrap();
        let out = compile_with(&source, &opts(), &FixedMetrics)
            .unwrap_or_else(|e| panic!("{path:?}: {e:?}"));
        let table = serde_json::to_value(&out.table).unwrap();
        assert!(table.get("refs").is_none(), "{path:?}");
        assert!(!out.svg.contains("class=\"tgl"), "{path:?}");
        assert!(!out.svg.contains("data-mark"), "{path:?}");
        seen += 1;
    }
    assert!(seen >= 8);
}

#[test]
fn bar_refs_land_at_their_rows_columns_and_cells() {
    let spec = json!({"tugchart": 1, "form": "bar", "title": "t",
    "categories": ["a", "b"],
    "series": [
        {"name": "s", "values": [1, 2], "ref": "arc:one", "refs": ["commit:aaaa", null]},
        {"name": "u", "values": [3, 4]}
    ],
    "refs": [null, "dir:src"],
    "annotations": [
        {"kind": "rule", "value": 2},
        {"kind": "mark", "at": 1, "label": "freeze", "ref": "commit:bbbb"}
    ]});
    let refs = compile(&spec).table.refs;
    assert_eq!(refs.rows, vec![None, one("dir:src")]);
    assert_eq!(refs.cols, vec![None, one("arc:one"), None]);
    assert_eq!(
        refs.cells,
        vec![vec![None, one("commit:aaaa"), None], vec![None, None, None]]
    );
    assert!(refs.items.is_empty());
    assert_eq!(refs.marks.len(), 1);
    assert_eq!(refs.marks[0].index, 1);
    assert_eq!(refs.marks[0].at, 1);
    assert_eq!(refs.marks[0].label, "freeze");
    assert_eq!(Some(refs.marks[0].slot.clone()), one("commit:bbbb"));

    let wire = serde_json::to_value(&compile(&spec).table).unwrap();
    assert_eq!(wire["refs"]["rows"][1], "dir:src");
    assert_eq!(wire["refs"]["marks"][0]["slot"], "commit:bbbb");
}

#[test]
fn dots_carry_a_ref_per_dot_and_scatter_one_per_point_row() {
    let dots = json!({"tugchart": 1, "form": "dots", "title": "t",
    "rows": [
        {"label": "r", "items": ["good", "bad"], "ref": "file:tests/a.ts",
         "refs": ["commit:aaaa", "commit:bbbb"]},
        {"label": "s", "items": ["good"]}
    ]});
    let refs = compile(&dots).table.refs;
    assert_eq!(refs.rows, vec![one("file:tests/a.ts"), None]);
    assert_eq!(
        refs.items,
        vec![vec![one("commit:aaaa"), one("commit:bbbb")], vec![]]
    );

    let scatter = json!({"tugchart": 1, "form": "scatter", "title": "t",
    "series": [
        {"name": "a", "points": [{"x": 1, "y": 1, "ref": "commit:aaaa"}, {"x": 2, "y": 2}]},
        {"name": "b", "points": [{"x": 3, "y": 3, "ref": "commit:cccc"}]}
    ]});
    assert_eq!(
        compile(&scatter).table.refs.rows,
        vec![one("commit:aaaa"), None, one("commit:cccc")]
    );
}

#[test]
fn a_histogram_bin_unions_its_samples_or_counts_them() {
    // Four bins of five wide: 0–5, 5–10, 10–15, 15–20.
    let spec = json!({"tugchart": 1, "form": "histogram", "title": "t", "bins": 4,
        "values": [1, 2, 6, 7, null, 12, 16],
        "refs": ["commit:aaaa", "commit:aaaa", "commit:bbbb", "commit:cccc", "commit:ffff", null, null]});
    let out = compile(&spec);
    assert_eq!(out.table.rows.len(), 4, "{:?}", out.table.rows);
    assert_eq!(
        out.table.refs.rows,
        vec![
            // Two samples naming one commit read as that commit.
            one("commit:aaaa"),
            set("commit", &["commit:bbbb", "commit:cccc"]),
            // The gap's ref went with it, and no sample here carries one.
            None,
            None,
        ]
    );

    // A bin with a sample that carries no ref is a count of all its samples.
    let partial = json!({"tugchart": 1, "form": "histogram", "title": "t", "bins": 4,
        "values": [1, 2, 6, 12, 16],
        "refs": ["commit:aaaa", null, "commit:bbbb", null, null]});
    let rows = compile(&partial).table.refs.rows;
    assert_eq!(rows[0], count("commit", 2));
    assert_eq!(rows[1], one("commit:bbbb"));

    // A union past a set's cap is a count.
    let n = MAX_SET + 1;
    let mut values: Vec<f64> = vec![1.0; n];
    values.push(19.0);
    let mut refs: Vec<Value> = (0..n).map(|i| json!(format!("commit:{i:04x}"))).collect();
    refs.push(Value::Null);
    let wide = json!({"tugchart": 1, "form": "histogram", "title": "t", "bins": 4,
        "values": values, "refs": refs});
    assert_eq!(compile(&wide).table.refs.rows[0], count("commit", n as u32));
}

/// Every `(attribute, value)` pair of one SVG line.
fn attr(line: &str, name: &str) -> Option<String> {
    let rest = line.split(&format!(" {name}=\"")).nth(1)?;
    Some(rest.split('"').next()?.to_string())
}

fn lines_with<'a>(svg: &'a str, needle: &str) -> Vec<&'a str> {
    svg.lines().filter(|l| l.contains(needle)).collect()
}

#[test]
fn a_dot_hit_names_its_index() {
    let dots = json!({"tugchart": 1, "form": "dots", "title": "t",
        "rows": [{"label": "r", "items": ["good", "bad", "neutral"]}]});
    let svg = compile(&dots).svg;
    let items: Vec<String> = lines_with(&svg, "class=\"tgh\"")
        .iter()
        .map(|l| attr(l, "data-item").expect("a dot hit names its item"))
        .collect();
    assert_eq!(items, ["0", "1", "2"]);
}

#[test]
fn a_labelled_mark_with_a_ref_has_one_hit_over_its_label() {
    let spec = |label: Option<&str>| {
        let mut mark = json!({"kind": "mark", "at": 1, "ref": "commit:bbbb"});
        if let Some(l) = label {
            mark["label"] = json!(l);
        }
        json!({"tugchart": 1, "form": "bar", "title": "t",
            "categories": ["a", "b", "c"],
            "series": [{"name": "s", "values": [1, 2, 3]}],
            "annotations": [{"kind": "rule", "value": 2, "label": "median"}, mark]})
    };
    let svg = compile(&spec(Some("freeze"))).svg;
    let hits = lines_with(&svg, "class=\"tgh\"");
    let marks: Vec<&&str> = hits.iter().filter(|l| l.contains("data-mark")).collect();
    assert_eq!(marks.len(), 1, "{svg}");
    assert_eq!(attr(marks[0], "data-mark").as_deref(), Some("1"));
    assert_eq!(attr(marks[0], "data-row").as_deref(), Some("1"));
    // It sits after every row hit, so it is on top.
    assert!(hits.last().unwrap().contains("data-mark"));
    // It covers the label's box: no taller than one value row.
    let d = attr(marks[0], "d").unwrap();
    let ys: Vec<f64> = d
        .split(|c: char| c.is_ascii_alphabetic())
        .filter_map(|pair| pair.trim().split([' ', ',']).nth(1)?.parse().ok())
        .collect();
    let tall =
        ys.iter().cloned().fold(f64::MIN, f64::max) - ys.iter().cloned().fold(f64::MAX, f64::min);
    assert!(tall > 0.0 && tall <= 14.0, "{d}");

    let unlabelled = compile(&spec(None)).svg;
    assert!(!unlabelled.contains("data-mark"));
}

#[test]
fn a_row_with_a_ref_rules_its_drawn_label_and_a_thinned_one_does_not() {
    let rows = json!({"tugchart": 1, "form": "spans", "title": "t",
    "items": [
        {"label": "compile", "start": 0, "end": 4, "ref": "session:048e4155"},
        {"label": "bundle", "start": 4, "end": 9}
    ]});
    let svg = compile(&rows).svg;
    let rules = lines_with(&svg, "class=\"tgl tgs-ink\"");
    assert_eq!(rules.len(), 1, "{svg}");
    assert_eq!(attr(rules[0], "data-row").as_deref(), Some("0"));
    assert!(rules[0].contains("visibility=\"hidden\""));
    assert!(rules[0].contains("pointer-events=\"none\""));

    // Sixty crowded categories: only every k-th label is drawn, and only a
    // drawn label is ruled.
    let n = 60;
    let categories: Vec<String> = (1..=n).map(|i| format!("day {i:02}")).collect();
    let refs: Vec<String> = (0..n).map(|i| format!("commit:{i:04x}")).collect();
    let crowded = json!({"tugchart": 1, "form": "bar", "title": "t",
        "categories": categories,
        "series": [{"name": "s", "values": vec![1; n]}],
        "refs": refs});
    let svg = compile(&crowded).svg;
    let drawn: Vec<usize> = (0..n)
        .filter(|i| svg.contains(&format!(">day {:02}</text>", i + 1)))
        .collect();
    assert!(drawn.len() < n, "every label drawn");
    let ruled: Vec<usize> = lines_with(&svg, "class=\"tgl ")
        .iter()
        .map(|l| attr(l, "data-row").unwrap().parse().unwrap())
        .collect();
    assert_eq!(ruled, drawn);
}
