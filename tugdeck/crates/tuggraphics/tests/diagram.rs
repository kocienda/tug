//! Layer 1: diagram goldens under `FixedMetrics`, their edge crossings,
//! the measure protocol's round count, the keyed table, the doors, and the
//! validator.
//!
//! Every `tests/diagram-golden/<name>.json` spec compiles to exactly
//! `tests/diagram-golden/<name>.svg`. After a deliberate change to the
//! output, rewrite them with
//! `TUGGRAPHICS_BLESS=1 cargo test -p tuggraphics --test diagram` and read
//! the diff before committing it.

use std::fs;
use std::path::{Path, PathBuf};

use tuggraphics::chart::{DIAGRAM_IN_CHART_FENCE, NOT_A_DIAGRAM};
use tuggraphics::{
    compile_round, compile_with, diagram, find_text, run_rounds, validate, ChartError, CompileOpts,
    Compiled, FixedMetrics, Layers, Measure, MeasureTable, Round, TypeRole,
};

fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/diagram-golden")
}

fn golden_names() -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(golden_dir())
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            (p.extension()? == "json")
                .then(|| p.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    names
}

fn golden(name: &str) -> String {
    fs::read_to_string(golden_dir().join(format!("{name}.json"))).unwrap()
}

fn opts() -> CompileOpts {
    CompileOpts {
        id_prefix: "d".into(),
        layers: Layers::Diagram,
        ..CompileOpts::default()
    }
}

#[test]
fn diagram_goldens() {
    let names = golden_names();
    assert!(
        names.len() >= 2,
        "expected the diagram goldens, found {names:?}"
    );
    let bless = std::env::var_os("TUGGRAPHICS_BLESS").is_some();
    let mut failed = Vec::new();
    for name in &names {
        let out = compile_with(&golden(name), &opts(), &FixedMetrics)
            .unwrap_or_else(|e| panic!("{name}.json does not compile: {e:?}"));
        let path = golden_dir().join(format!("{name}.svg"));
        if bless {
            fs::write(&path, &out.svg).unwrap();
        } else if fs::read_to_string(&path).ok().as_deref() != Some(out.svg.as_str()) {
            failed.push(format!("{name}:\n{}", out.svg));
        }
    }
    assert!(
        failed.is_empty(),
        "goldens differ:\n{}",
        failed.join("\n\n")
    );
}

/// The `tugdiagram` fences in the plugin's prompt doc, in order.
fn prompt_doc_examples() -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tugplug/diagrams.md");
    let doc = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    let mut examples = Vec::new();
    let mut open: Option<String> = None;
    for line in doc.lines() {
        match open.as_mut() {
            None if line == "```tugdiagram" => open = Some(String::new()),
            None => {}
            Some(_) if line == "```" => examples.push(open.take().unwrap()),
            Some(body) => {
                body.push_str(line);
                body.push('\n');
            }
        }
    }
    assert!(open.is_none(), "an example in diagrams.md is never closed");
    examples
}

/// Lays an example out and asserts it renders as the doc promises: no
/// error, no crossing, inside the width cap.
fn assert_example_renders(n: usize, source: &str, m: &dyn Measure) -> String {
    let spec = diagram::validate(source)
        .unwrap_or_else(|e| panic!("example {n} does not validate: {e:?}"));
    let laid = run_rounds(m, |m| diagram::layout(&spec, true, true, m)).unwrap();
    assert!(laid.errors.is_empty(), "example {n}: {:?}", laid.errors);
    assert_eq!(laid.crossings, 0, "example {n} crosses");
    assert!(
        laid.program.frame.0 <= diagram::MAX_W,
        "example {n} is too wide"
    );
    spec.form_name().to_string()
}

#[test]
fn every_example_in_the_prompt_doc_renders_and_each_form_has_one() {
    let examples = prompt_doc_examples();
    let forms: Vec<String> = examples
        .iter()
        .enumerate()
        .map(|(n, source)| {
            compile_with(source, &opts(), &FixedMetrics)
                .unwrap_or_else(|e| panic!("example {n} does not compile: {e:?}"));
            assert_example_renders(n, source, &FixedMetrics)
        })
        .collect();
    assert_eq!(
        forms,
        diagram::spec::FORM_NAMES,
        "one example per form, in order"
    );
}

#[cfg(feature = "font")]
#[test]
fn every_example_in_the_prompt_doc_renders_in_the_real_faces() {
    let faces = real_faces();
    for (n, source) in prompt_doc_examples().iter().enumerate() {
        assert_example_renders(n, source, &faces);
    }
}

#[cfg(feature = "font")]
fn real_faces() -> tuggraphics::FaceMeasurer<'static> {
    use tuggraphics::FaceMeasurer;
    const SANS_REGULAR: &[u8] = include_bytes!("../../../public/fonts/IBMPlexSans-Regular.woff2");
    const SANS_SEMIBOLD: &[u8] = include_bytes!("../../../public/fonts/IBMPlexSans-SemiBold.woff2");
    const MONO_REGULAR: &[u8] = include_bytes!("../../../public/fonts/IBMPlexMono-Regular.woff2");
    FaceMeasurer::from_woff2(&[
        (TypeRole::Title, SANS_SEMIBOLD, 13.0),
        (TypeRole::Label, SANS_REGULAR, 12.0),
        (TypeRole::Value, SANS_REGULAR, 11.0),
        (TypeRole::Mono, MONO_REGULAR, 11.0),
    ])
    .unwrap()
}

/// Lays a golden out natively and returns it.
fn laid(name: &str, m: &dyn Measure) -> diagram::Laid {
    let spec = diagram::validate(&golden(name)).unwrap();
    run_rounds(m, |m| diagram::layout(&spec, true, true, m)).unwrap()
}

#[test]
fn every_golden_lays_out_with_no_edge_crossing_inside_the_width_cap() {
    for name in golden_names() {
        let laid = laid(&name, &FixedMetrics);
        assert_eq!(laid.crossings, 0, "{name} crosses");
        assert!(laid.errors.is_empty(), "{name}: {:?}", laid.errors);
        assert!(laid.program.frame.0 <= diagram::MAX_W, "{name} is too wide");
    }
}

#[cfg(feature = "font")]
#[test]
fn every_golden_lays_out_with_no_edge_crossing_in_the_real_faces() {
    let faces = real_faces();
    for name in golden_names() {
        let laid = laid(&name, &faces);
        assert_eq!(laid.crossings, 0, "{name} crosses");
        assert!(laid.errors.is_empty(), "{name}: {:?}", laid.errors);
        assert!(laid.program.frame.0 <= diagram::MAX_W, "{name} is too wide");
    }
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
            Round::Measure { texts, ink } => {
                requests += 1;
                assert!(requests <= 2, "a third measure request");
                for (role, text) in texts {
                    let role = TypeRole::parse(&role).unwrap();
                    let pair = (role.name().to_string(), text.clone());
                    let m = if ink.contains(&pair) {
                        FixedMetrics.measure_ink(role, &text)
                    } else {
                        FixedMetrics.measure(role, &text)
                    };
                    table.insert(role, &text, m.unwrap());
                }
            }
        }
    }
}

#[test]
fn every_golden_settles_within_two_requests_and_matches_the_native_compile() {
    for name in golden_names() {
        let (requests, out) = drive(&golden(&name), &opts());
        // A figure whose text wraps asks twice; one whose text all stays
        // on its line has its answer after the first. Never a third.
        assert!((1..=2).contains(&requests), "{name}: {requests} requests");
        assert_eq!(
            out.unwrap(),
            compile_with(&golden(&name), &opts(), &FixedMetrics).unwrap(),
            "{name}"
        );
    }
}

#[test]
fn the_first_request_asks_ink_for_the_key_numbers_only() {
    let Round::Measure { ink, .. } =
        compile_round(&golden("flow-edit-gate"), &opts(), &MeasureTable::new())
    else {
        panic!("expected a measure round");
    };
    let mut keys: Vec<String> = ink
        .into_iter()
        .map(|(role, text)| format!("{role}:{text}"))
        .collect();
    keys.sort();
    assert_eq!(keys, ["value:1", "value:2", "value:3", "value:4"]);
}

#[test]
fn the_keyed_table_is_in_key_order_and_is_what_find_counts() {
    let out = compile_with(&golden("flow-edit-gate"), &opts(), &FixedMetrics).unwrap();
    assert_eq!(out.table.head, ["#", "Step", "What it does", "Where it is"]);
    let first: Vec<&str> = out.table.rows.iter().map(|r| r[0].as_str()).collect();
    assert_eq!(first, ["1", "2", "3", "4"]);
    assert_eq!(out.table.rows[2][1], "Find the receipt");
    assert_eq!(
        out.table.rows[2][3],
        "tugrust/crates/tugcast/src/feeds/attribution.rs"
    );
    assert_eq!(out.find_text, out.table.find_text());
    assert_eq!(
        out.find_text,
        find_text(&golden("flow-edit-gate"), Layers::Diagram)
    );
    // A keyed mark carries a hit target naming its row.
    assert_eq!(out.svg.matches("data-row=").count(), 4, "{}", out.svg);
}

#[test]
fn a_figure_with_no_key_has_no_table() {
    let source = flow(AB, r#"[{"from": "a", "to": "b"}]"#);
    let out = compile_with(&source, &opts(), &FixedMetrics).unwrap();
    assert!(out.table.head.is_empty() && out.table.rows.is_empty());
    assert_eq!(out.find_text, "t");
}

#[test]
fn the_figure_title_is_drawn_only_when_asked() {
    let titled = compile_with(&golden("flow-benchmark"), &opts(), &FixedMetrics).unwrap();
    let untitled = compile_with(
        &golden("flow-benchmark"),
        &CompileOpts {
            figure_title: false,
            ..opts()
        },
        &FixedMetrics,
    )
    .unwrap();
    assert!(titled
        .svg
        .contains("How nai-memory keeps users apart today"));
    assert!(!untitled
        .svg
        .contains("How nai-memory keeps users apart today"));
    assert!(untitled.height < titled.height);
}

#[test]
fn each_door_takes_only_its_own_spec() {
    let diagram = golden("flow-benchmark");
    let chart = r#"{"tugchart": 1, "form": "sparkline", "values": [1, 2]}"#;
    let drawing = r#"{"tugdraw": 1, "frame": [10, 10], "ops": []}"#;
    let only = |source: &str, layers| validate(source, layers).unwrap_err()[0].message.clone();
    assert_eq!(only(&diagram, Layers::Chart), DIAGRAM_IN_CHART_FENCE);
    assert_eq!(only(chart, Layers::Diagram), NOT_A_DIAGRAM);
    assert_eq!(only(drawing, Layers::Diagram), NOT_A_DIAGRAM);
    assert!(validate(&diagram, Layers::Diagram).is_ok());
    assert!(validate(&diagram, Layers::Any).is_ok());
}

/// The errors of a spec, as `(path, message)` pairs, through the door a
/// `tugdiagram` fence uses, compiled to the end.
fn errors(source: &str) -> Vec<(String, String)> {
    match compile_with(source, &opts(), &FixedMetrics) {
        Ok(_) => Vec::new(),
        Err(errors) => errors.into_iter().map(|e| (e.path, e.message)).collect(),
    }
}

/// A one-column flow with these boxes and edges.
fn flow(columns: &str, edges: &str) -> String {
    format!(
        r#"{{"tugdiagram": 1, "form": "flow", "title": "t", "columns": {columns}, "edges": {edges}}}"#
    )
}

fn has(errors: &[(String, String)], path: &str, says: &str) {
    assert!(
        errors.iter().any(|(p, m)| p == path && m.contains(says)),
        "no error at {path} saying {says:?}: {errors:?}"
    );
}

const AB: &str =
    r#"[[{"id": "a", "name": "A"}], [{"id": "b", "name": "B", "rows": [{"name": "r"}]}]]"#;

#[test]
fn the_head_is_checked() {
    let e = errors(
        r#"{"tugdiagram": 2, "form": "flow", "title": "t", "columns": [[{"id": "a", "name": "A"}]]}"#,
    );
    has(&e, "/tugdiagram", "starts with \"tugdiagram\": 1");
    let e = errors(r#"{"tugdiagram": 1, "form": "pie", "title": "t"}"#);
    has(&e, "/form", "unknown form \"pie\": expected flow");
    let e = errors(r#"{"tugdiagram": 1, "title": "t"}"#);
    has(&e, "/form", "form is required");
    let e = errors(r#"{"tugdiagram": 1, "form": "flow", "columns": [[{"id": "a", "name": "A"}]]}"#);
    has(&e, "/title", "title is required");
    let e = errors(
        r#"{"tugdiagram": 1, "form": "flow", "title": "t", "motion": "fast", "columns": [[{"id": "a", "name": "A"}]]}"#,
    );
    has(&e, "/motion", "enter, none");
    let e = errors("[1]");
    has(&e, "", "a diagram spec is a JSON object");
}

/// A sequence with these actors and messages.
fn sequence(actors: &str, messages: &str) -> String {
    format!(
        r#"{{"tugdiagram": 1, "form": "sequence", "title": "t", "actors": {actors}, "messages": {messages}}}"#
    )
}

const PQ: &str = r#"[{"id": "p", "name": "P"}, {"id": "q", "name": "Q", "sub": "the other"}]"#;

#[test]
fn a_sequence_names_its_actors_and_messages() {
    let e = errors(r#"{"tugdiagram": 1, "form": "sequence", "title": "t"}"#);
    has(&e, "/actors", "actors is required");
    let e = errors(&sequence(PQ, "[]"));
    has(&e, "/messages", "at least one");
    let e = errors(&sequence(
        "[]",
        r#"[{"from": "p", "to": "q", "label": "x"}]"#,
    ));
    has(&e, "/actors", "at least one");
    // A flow's fields are not a sequence's.
    let e = errors(&format!(
        r#"{{"tugdiagram": 1, "form": "sequence", "title": "t", "columns": [], "actors": {PQ}, "messages": [{{"from": "p", "to": "q", "label": "x"}}]}}"#
    ));
    has(&e, "/columns", "unknown field \"columns\"");
    let e = errors(&sequence(
        r#"[{"id": "p", "name": "P", "x": 3}, {"name": "Q"}, {"id": "p", "name": "R"}, {"id": "a b", "name": "S"}]"#,
        r#"[{"from": "p", "to": "p", "label": "x"}]"#,
    ));
    has(&e, "/actors/0/x", "unknown field \"x\"");
    has(&e, "/actors/1/id", "id is required");
    has(&e, "/actors/2/id", "already used at /actors/0");
    has(&e, "/actors/3/id", "no space");
}

#[test]
fn messages_join_actors_that_exist_and_carry_their_keys() {
    let e = errors(&sequence(
        PQ,
        r#"[{"from": "p", "to": "r", "label": "x"}, {"from": "z", "to": "q"}, {"from": "p", "to": "q", "label": "y", "via": 1}]"#,
    ));
    has(&e, "/messages/0/to", "no actor has the id \"r\"");
    has(&e, "/messages/1/from", "no actor has the id \"z\"");
    has(&e, "/messages/1/label", "label is required");
    has(&e, "/messages/2/via", "unknown field \"via\"");
    let e = errors(&sequence(
        PQ,
        r#"[{"from": "p", "to": "q", "label": "x", "tone": "accent", "reply": "yes", "what": "w"}, {"key": 1, "from": "q", "to": "p", "label": "y"}, {"key": 1, "from": "q", "to": "q", "label": "z"}]"#,
    ));
    has(&e, "/messages/0/tone", "the accent is the key discs' alone");
    has(&e, "/messages/0/reply", "true or false");
    has(&e, "/messages/0/what", "give it a key");
    has(
        &e,
        "/messages/2/key",
        "key 1 is already given at /messages/1/key",
    );
}

#[test]
fn a_message_label_stays_on_one_line() {
    // 60 value graphemes at 6.6 px under FixedMetrics: 396 px.
    let label = "x".repeat(60);
    let e = errors(&sequence(
        PQ,
        &format!(r#"[{{"from": "p", "to": "q", "label": "{label}"}}]"#),
    ));
    has(&e, "/messages/0/label", "396 px wide; it stays on one line");
}

#[test]
fn a_sequence_key_sits_on_its_label_line_and_its_table_row_is_the_label() {
    use tuggraphics::draw::{Baseline, ColourRole, Item, PaintKind, Seg};
    let name = "sequence-chart-fence";
    let laid = laid(name, &FixedMetrics);
    let spec = diagram::validate(&golden(name)).unwrap();
    let diagram::spec::Form::Sequence(seq) = &spec.form else {
        panic!("{name} is a sequence");
    };
    let label_y: Vec<f64> = seq
        .messages
        .iter()
        .filter(|m| m.key.is_some())
        .map(|m| {
            laid.program
                .items
                .iter()
                .find_map(|i| match i {
                    Item::Text(t) if t.text == m.label && t.baseline == Baseline::Middle => {
                        Some(t.y)
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("no label {:?}", m.label))
        })
        .collect();
    let disc_y: Vec<f64> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if p.kind == PaintKind::Fill && p.role == ColourRole::Accent => {
                match p.path.first() {
                    Some(Seg::Move(_, y)) => Some(*y),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    assert_eq!(disc_y, label_y, "each disc is on its label's line");
    let hits = laid
        .program
        .items
        .iter()
        .filter(|i| matches!(i, Item::Hit(_)))
        .count();
    assert_eq!(hits, 6);

    let out = compile_with(&golden(name), &opts(), &FixedMetrics).unwrap();
    let first: Vec<&str> = out.table.rows[0].iter().map(String::as_str).collect();
    assert_eq!(
        first,
        [
            "1",
            "fence closed: source",
            "Promotes a closed tugchart fence to a figure; an open one stays code.",
            "tugdeck/src/lib/markdown/block-transformers/tugchart.ts"
        ]
    );
    let keys: Vec<&str> = out.table.rows.iter().map(|r| r[0].as_str()).collect();
    assert_eq!(keys, ["1", "2", "3", "4", "5", "6"]);
}

#[test]
fn a_reply_is_dashed_and_a_call_is_not() {
    use tuggraphics::draw::{ColourRole, Item, PaintKind};
    let source = sequence(
        PQ,
        r#"[{"from": "p", "to": "q", "label": "ask"}, {"from": "q", "to": "p", "label": "answer", "reply": true}, {"from": "q", "to": "q", "label": "think"}]"#,
    );
    let spec = diagram::validate(&source).unwrap();
    let laid = run_rounds(&FixedMetrics, |m| diagram::layout(&spec, false, false, m)).unwrap();
    assert!(laid.errors.is_empty(), "{:?}", laid.errors);
    // The edges' strokes, in order: the call, the reply, the self-loop.
    let edges: Vec<(ColourRole, bool)> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if matches!(p.kind, PaintKind::Stroke { cap: Some(_), .. }) => {
                Some((p.role, !p.dash.is_empty()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        edges,
        [
            (ColourRole::Ink, false),
            (ColourRole::InkMuted, true),
            (ColourRole::Ink, false)
        ]
    );
}

/// A layers figure with these layers.
fn layers(layers: &str) -> String {
    format!(r#"{{"tugdiagram": 1, "form": "layers", "title": "t", "layers": {layers}}}"#)
}

#[test]
fn layers_hold_cells_and_say_what_crosses_only_where_something_is_beneath() {
    let e = errors(r#"{"tugdiagram": 1, "form": "layers", "title": "t"}"#);
    has(&e, "/layers", "layers is required");
    has(&errors(&layers("[]")), "/layers", "at least one");
    let e = errors(&layers(
        r#"[{"name": "A", "cells": [], "x": 1}, {"sub": "s", "cells": [{"name": "c", "y": 2}]}, {"name": "C"}]"#,
    ));
    has(&e, "/layers/0/cells", "at least one");
    has(&e, "/layers/0/x", "unknown field \"x\"");
    has(&e, "/layers/1/name", "name is required");
    has(&e, "/layers/1/cells/0/y", "unknown field \"y\"");
    has(&e, "/layers/2/cells", "cells is required");
    let e = errors(&layers(
        r#"[{"name": "A", "below": "calls", "cells": [{"name": "a", "key": 1, "mono": "yes"}]}, {"name": "B", "below": "nothing", "cells": [{"name": "b", "where": "src", "sub": ""}, {"name": "b2", "key": 1}]}]"#,
    ));
    has(&e, "/layers/0/cells/0/mono", "true or false");
    has(
        &e,
        "/layers/1/below",
        "the last layer has nothing beneath it",
    );
    has(&e, "/layers/1/cells/0/where", "give it a key");
    has(&e, "/layers/1/cells/0/sub", "non-empty");
    has(
        &e,
        "/layers/1/cells/1/key",
        "key 1 is already given at /layers/0/cells/0/key",
    );
}

#[test]
fn a_crossing_label_wraps_to_two_lines_and_no_more() {
    // At 6.6 px a value grapheme, 240 px holds 36 of them a line.
    let two = "what crosses here is said in words that need two lines";
    let source = layers(&format!(
        r#"[{{"name": "A", "below": "{two}", "cells": [{{"name": "a"}}]}}, {{"name": "B", "cells": [{{"name": "b"}}]}}]"#
    ));
    assert_eq!(errors(&source), Vec::new());
    let four = "what crosses here is said in so many words that it would take four lines at the width a crossing wraps at";
    let e = errors(&layers(&format!(
        r#"[{{"name": "A", "below": "{four}", "cells": [{{"name": "a"}}]}}, {{"name": "B", "cells": [{{"name": "b"}}]}}]"#
    )));
    has(&e, "/layers/0/below", "it may take at most 2");
}

#[test]
fn a_layer_cell_key_sits_on_its_name_line() {
    use tuggraphics::draw::{Baseline, ColourRole, Item, PaintKind, Seg};
    let name = "layers-suite";
    let laid = laid(name, &FixedMetrics);
    let spec = diagram::validate(&golden(name)).unwrap();
    let diagram::spec::Form::Layers(l) = &spec.form else {
        panic!("{name} is a layers figure");
    };
    let name_y: Vec<f64> = l
        .layers
        .iter()
        .flat_map(|l| &l.cells)
        .filter(|c| c.key.is_some())
        .map(|c| {
            laid.program
                .items
                .iter()
                .find_map(|i| match i {
                    Item::Text(t) if t.text == c.name && t.baseline == Baseline::Middle => {
                        Some(t.y)
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("no name {:?}", c.name))
        })
        .collect();
    let disc_y: Vec<f64> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if p.kind == PaintKind::Fill && p.role == ColourRole::Accent => {
                match p.path.first() {
                    Some(Seg::Move(_, y)) => Some(*y),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    assert_eq!(disc_y, name_y, "each disc is on its cell's name line");
    let out = compile_with(&golden(name), &opts(), &FixedMetrics).unwrap();
    let names: Vec<&str> = out.table.rows.iter().map(|r| r[1].as_str()).collect();
    assert_eq!(
        names,
        [
            "Windows and menus",
            "Session card",
            "Feeds",
            "Spawn config",
            "tugplug"
        ]
    );
}

/// A stack with these fields after `"columns"`.
fn stack(columns: u64, rest: &str) -> String {
    format!(r#"{{"tugdiagram": 1, "form": "stack", "title": "t", "columns": {columns}, {rest}}}"#)
}

const ONE_LAYER: &str = r#""layers": [{"name": "L", "rows": [[{"name": "c"}]]}]"#;

#[test]
fn a_stack_is_ruled_on_a_grid_its_spans_stay_inside() {
    let e = errors(r#"{"tugdiagram": 1, "form": "stack", "title": "t", "layers": []}"#);
    has(&e, "/columns", "columns is required");
    has(&e, "/layers", "at least one");
    has(&errors(&stack(0, ONE_LAYER)), "/columns", "from 1 to 12");
    has(&errors(&stack(13, ONE_LAYER)), "/columns", "from 1 to 12");
    let e = errors(&stack(
        4,
        r#""above": [{"name": "A", "span": [3, 5]}, {"name": "B", "span": [3, 2]}, {"name": "C", "span": 2}],
           "layers": [{"name": "L", "span": [0, 1], "rows": [[{"name": "c", "x": 1}], []]}, {"name": "M"}],
           "below": [{"sub": "s"}]"#,
    ));
    has(&e, "/above/0/span", "from 1 to 4");
    has(&e, "/above/1/span", "first no later than last");
    has(&e, "/above/2/span", "span is [first, last]");
    has(&e, "/layers/0/span", "from 1 to 4");
    has(&e, "/layers/0/rows/0/0/x", "unknown field \"x\"");
    has(&e, "/layers/0/rows/1", "at least one");
    has(&e, "/layers/1/rows", "rows is required");
    has(&e, "/below/0/name", "name is required");
    let e = errors(&stack(
        2,
        r#""layers": [{"name": "L", "rows": [[{"name": "c", "key": 1}, {"name": "d", "key": 1, "what": "w"}]]}],
           "across": {"title": "Shared", "names": []}"#,
    ));
    has(&e, "/layers/0/rows/0/1/key", "key 1 is already given");
    has(&e, "/across/names", "at least one");
}

#[test]
fn a_stack_cell_key_sits_in_its_corner_and_upright_names_must_fit_their_bar() {
    use tuggraphics::draw::{Anchor, ColourRole, Item, PaintKind, Seg};
    let name = "stack-architecture";
    let laid = laid(name, &FixedMetrics);
    // Each disc sits in the top-left corner of its cell, clear of the
    // cell's centred name, which the cell keeps centred.
    let discs: Vec<(f64, f64)> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if p.kind == PaintKind::Fill && p.role == ColourRole::Accent => {
                match p.path.first() {
                    Some(Seg::Move(x, y)) => Some((*x, *y)),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    assert_eq!(discs.len(), 4);
    let names: Vec<(f64, usize)> = ["Session card", "Feeds", "Semantic index", "Spawn config"]
        .iter()
        .map(|n| {
            laid.program
                .items
                .iter()
                .find_map(|i| match i {
                    Item::Text(t) if t.text == *n && t.anchor == Anchor::Middle => {
                        Some((t.x, n.chars().count()))
                    }
                    _ => None,
                })
                .unwrap()
        })
        .collect();
    // A disc's path starts at its rightmost point; a label grapheme is
    // 7.2 px under FixedMetrics.
    for ((dx, _), (cx, len)) in discs.iter().zip(&names) {
        let name_left = cx - *len as f64 * 7.2 / 2.0;
        assert!(
            *dx < name_left,
            "disc at {dx} runs into a name starting at {name_left}"
        );
    }
    // The upright names are drawn in turned groups.
    let turned = laid
        .program
        .items
        .iter()
        .filter(|i| matches!(i, Item::Group(g) if g.rotate == Some(-90.0)))
        .count();
    assert_eq!(turned, 3);

    // A name longer than the stack is tall is refused.
    let long = "a name far too long to stand upright in one short layer";
    let e = errors(&stack(
        1,
        &format!(r#"{ONE_LAYER}, "across": {{"title": "Shared", "names": ["{long}"]}}"#),
    ));
    has(&e, "/across/names/0", "runs upright in a bar");
}

#[test]
fn each_form_refuses_a_figure_over_its_budget() {
    let boxes: Vec<String> = (0..11)
        .map(|i| format!(r#"{{"id": "b{i}", "name": "B{i}"}}"#))
        .collect();
    let e = errors(&flow(&format!("[[{}]]", boxes.join(", ")), "[]"));
    has(
        &e,
        "/columns",
        "this flow has 11 boxes; it may hold at most 10, so split it into two figures",
    );
    let rows: Vec<String> = (0..7).map(|i| format!(r#"{{"name": "r{i}"}}"#)).collect();
    let e = errors(&flow(
        &format!(
            r#"[[{{"id": "a", "name": "A", "rows": [{}]}}]]"#,
            rows.join(", ")
        ),
        "[]",
    ));
    has(&e, "/columns/0/0/rows", "7 rows in one box");
    let edges: Vec<&str> = (0..11).map(|_| r#"{"from": "a", "to": "b"}"#).collect();
    let e = errors(&flow(AB, &format!("[{}]", edges.join(", "))));
    has(&e, "/edges", "11 edges");

    let actors: Vec<String> = (0..7)
        .map(|i| format!(r#"{{"id": "a{i}", "name": "A{i}"}}"#))
        .collect();
    let e = errors(&sequence(
        &format!("[{}]", actors.join(", ")),
        r#"[{"from": "a0", "to": "a1", "label": "x"}]"#,
    ));
    has(&e, "/actors", "this sequence has 7 actors");
    let messages: Vec<&str> = (0..17)
        .map(|_| r#"{"from": "p", "to": "q", "label": "x"}"#)
        .collect();
    let e = errors(&sequence(PQ, &format!("[{}]", messages.join(", "))));
    has(&e, "/messages", "17 messages");

    let cell = r#"{"name": "c"}"#;
    let six = [cell; 6].join(", ");
    let e = errors(&layers(&format!(r#"[{{"name": "A", "cells": [{six}]}}]"#)));
    has(
        &e,
        "/layers/0/cells",
        "this layers has 6 cells in one layer",
    );
    let layer = format!(r#"{{"name": "L", "cells": [{cell}]}}"#);
    let e = errors(&layers(&format!("[{}]", [layer.as_str(); 8].join(", "))));
    has(&e, "/layers", "8 layers");

    let seven = [cell; 7].join(", ");
    let e = errors(&stack(
        4,
        &format!(r#""layers": [{{"name": "L", "rows": [[{seven}]]}}]"#),
    ));
    has(&e, "/layers/0/rows/0", "this stack has 7 cells in one row");
    let block = r#"{"name": "B"}"#;
    let e = errors(&stack(
        4,
        &format!(
            r#"{ONE_LAYER}, "below": [{}], "across": {{"title": "S", "names": ["a", "b", "c", "d", "e"]}}"#,
            [block; 5].join(", ")
        ),
    ));
    has(&e, "/below", "5 blocks beneath");
    has(&e, "/across/names", "5 bars across");
}

#[test]
fn a_flow_whose_edges_cross_more_than_once_is_refused() {
    // Three boxes a column, each edge reaching the far row: the turning
    // edges run across each other in the gap.
    let source = flow(
        r#"[[{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}],
            [{"id": "x", "name": "X"}, {"id": "y", "name": "Y"}, {"id": "z", "name": "Z"}]]"#,
        r#"[{"from": "a", "to": "z"}, {"from": "b", "to": "y"}, {"from": "c", "to": "x"}]"#,
    );
    let spec = diagram::validate(&source).unwrap();
    let laid = run_rounds(&FixedMetrics, |m| diagram::layout(&spec, false, false, m)).unwrap();
    assert!(
        laid.crossings > diagram::budget::MAX_CROSSINGS,
        "{}",
        laid.crossings
    );
    has(&errors(&source), "/edges", "edges cross");
}

#[test]
fn unknown_keys_and_coordinates_are_errors_wherever_they_are() {
    let e = errors(&flow(r#"[[{"id": "a", "name": "A", "x": 10}]]"#, "[]"));
    has(&e, "/columns/0/0/x", "unknown field \"x\"");
    let e = errors(&flow(
        r#"[[{"id": "a", "name": "A", "rows": [{"name": "r", "y": 3}]}]]"#,
        "[]",
    ));
    has(&e, "/columns/0/0/rows/0/y", "unknown field \"y\"");
    let e = errors(
        r#"{"tugdiagram": 1, "form": "flow", "title": "t", "width": 400, "columns": [[{"id": "a", "name": "A"}]]}"#,
    );
    has(&e, "/width", "unknown field \"width\"");
    let e = errors(&flow(AB, r#"[{"from": "a", "to": "b", "via": "c"}]"#));
    has(&e, "/edges/0/via", "unknown field \"via\"");
}

#[test]
fn columns_boxes_and_rows_are_checked() {
    has(&errors(&flow("[]", "[]")), "/columns", "at least one");
    has(&errors(&flow("[[]]", "[]")), "/columns/0", "at least one");
    has(
        &errors(&flow(r#"[[{"name": "A"}]]"#, "[]")),
        "/columns/0/0/id",
        "id is required",
    );
    has(
        &errors(&flow(r#"[[{"id": "a"}]]"#, "[]")),
        "/columns/0/0/name",
        "name is required",
    );
    has(
        &errors(&flow(r#"[[{"id": "a", "name": ""}]]"#, "[]")),
        "/columns/0/0/name",
        "non-empty",
    );
    has(
        &errors(&flow(r#"[[{"id": "a.b", "name": "A"}]]"#, "[]")),
        "/columns/0/0/id",
        "no dot",
    );
    has(
        &errors(&flow(
            r#"[[{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]]"#,
            "[]",
        )),
        "/columns/0/1/id",
        "already used at /columns/0/0",
    );
    has(
        &errors(&flow(r#"[[{"id": "a", "name": "A", "rows": []}]]"#, "[]")),
        "/columns/0/0/rows",
        "at least one",
    );
    has(
        &errors(&flow(r#"[[{"id": "a", "name": "A", "notes": "n"}]]"#, "[]")),
        "/columns/0/0/notes",
        "an array",
    );
    has(
        &errors(&flow(
            r#"[[{"id": "a", "name": "A", "rows": [{"name": "r", "mono": "yes"}]}]]"#,
            "[]",
        )),
        "/columns/0/0/rows/0/mono",
        "true or false",
    );
    has(
        &errors(&flow(
            r#"[[{"id": "a", "name": "A", "rows": [{"name": "r", "lit": "red"}]}]]"#,
            "[]",
        )),
        "/columns/0/0/rows/0/lit",
        "good, bad, caution, outside",
    );
}

#[test]
fn keys_are_numbered_once_and_carry_the_table_row() {
    let rows = |rows: &str| {
        flow(
            &format!(r#"[[{{"id": "a", "name": "A", "rows": {rows}}}]]"#),
            "[]",
        )
    };
    has(
        &errors(&rows(r#"[{"name": "r", "key": 0}]"#)),
        "/columns/0/0/rows/0/key",
        "1 to 99",
    );
    has(
        &errors(&rows(r#"[{"name": "r", "key": 100}]"#)),
        "/columns/0/0/rows/0/key",
        "1 to 99",
    );
    has(
        &errors(&rows(r#"[{"name": "r", "key": 1.5}]"#)),
        "/columns/0/0/rows/0/key",
        "whole number",
    );
    has(
        &errors(&rows(
            r#"[{"name": "r", "key": 1}, {"name": "s", "key": 1}]"#,
        )),
        "/columns/0/0/rows/1/key",
        "key 1 is already given at /columns/0/0/rows/0/key",
    );
    has(
        &errors(&rows(r#"[{"name": "r", "where": "src/a.rs"}]"#)),
        "/columns/0/0/rows/0/where",
        "belongs to a keyed mark",
    );
    has(
        &errors(&rows(r#"[{"name": "r", "what": "does it"}]"#)),
        "/columns/0/0/rows/0/what",
        "belongs to a keyed mark",
    );
}

#[test]
fn edges_name_boxes_and_rows_that_exist() {
    has(
        &errors(&flow(AB, r#"[{"from": "a", "to": "c"}]"#)),
        "/edges/0/to",
        "no box has the id \"c\"",
    );
    has(
        &errors(&flow(AB, r#"[{"from": "a.1", "to": "b"}]"#)),
        "/edges/0/from",
        "box \"a\" has no rows",
    );
    has(
        &errors(&flow(AB, r#"[{"from": "a", "to": "b.2"}]"#)),
        "/edges/0/to",
        "rows 1 to 1",
    );
    has(
        &errors(&flow(AB, r#"[{"from": "b.1", "to": "b"}]"#)),
        "/edges/0",
        "two different boxes",
    );
    has(
        &errors(&flow(AB, r#"[{"to": "b"}]"#)),
        "/edges/0/from",
        "from is required",
    );
    has(
        &errors(&flow(AB, r#"[{"from": "a", "to": "b", "tone": "accent"}]"#)),
        "/edges/0/tone",
        "key discs' alone",
    );
    has(
        &errors(&flow(AB, r#"[{"from": "a", "to": "b", "dashed": 1}]"#)),
        "/edges/0/dashed",
        "true or false",
    );
    has(&errors(&flow(AB, r#"{"from": "a"}"#)), "/edges", "an array");
}

#[test]
fn a_name_too_wide_for_one_line_is_refused_with_its_width() {
    // 50 title graphemes at 7.8 px under FixedMetrics.
    let name = "N".repeat(50);
    let e = errors(&flow(
        &format!(r#"[[{{"id": "a", "name": "{name}"}}]]"#),
        "[]",
    ));
    has(&e, "/columns/0/0/name", "390 px wide on its one line");
}

#[test]
fn secondary_text_past_two_lines_is_refused() {
    let label = "word ".repeat(24);
    let e = errors(&flow(
        AB,
        &format!(
            r#"[{{"from": "a", "to": "b", "label": "{}"}}]"#,
            label.trim()
        ),
    ));
    has(&e, "/edges/0/label", "it may take at most 2");
    let note = "note ".repeat(24);
    let e = errors(&flow(
        &format!(
            r#"[[{{"id": "a", "name": "A", "notes": ["{}"]}}]]"#,
            note.trim()
        ),
        "[]",
    ));
    has(&e, "/columns/0/0/notes/0", "it may take at most 2");
}

#[test]
fn a_figure_wider_than_the_cap_says_to_split_it() {
    // As many columns as a flow may hold, of boxes as wide as a name may be.
    let name = "N".repeat(40);
    let columns: Vec<String> = (0..diagram::budget::FLOW_COLUMNS)
        .map(|i| format!(r#"[{{"id": "n{i}", "name": "{name}"}}]"#))
        .collect();
    let e = errors(&flow(&format!("[{}]", columns.join(",")), "[]"));
    has(
        &e,
        "",
        "past the 1040 px a diagram may take; split it into two figures",
    );
}
