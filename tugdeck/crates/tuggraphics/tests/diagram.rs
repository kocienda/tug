//! Layer 1: diagram goldens under `FixedMetrics`, their edge crossings,
//! the measure protocol's round count, the keyed table, the doors, and the
//! validator.
//!
//! A diagram that parses always draws. The limits a figure should stay
//! inside — its width, its budgets, a name's one line, two lines of
//! secondary text, one edge crossing — are asserted here as warnings on a
//! figure that still compiles, and so are the repairs validation makes:
//! an unknown field ignored, a dangling edge dropped, a key number given
//! twice kept by its first mark. They were refusals until a figure of
//! five ordinary columns came out 56 px over the width cap and the reader
//! was shown no figure at all.
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
/// warning, no crossing, inside the width cap.
fn assert_example_renders(n: usize, source: &str, m: &dyn Measure) -> String {
    let spec = diagram::validate(source)
        .unwrap_or_else(|e| panic!("example {n} does not validate: {e:?}"));
    let laid = run_rounds(m, |m| diagram::layout(&spec, true, true, m)).unwrap();
    assert!(spec.warnings.is_empty(), "example {n}: {:?}", spec.warnings);
    assert!(laid.warnings.is_empty(), "example {n}: {:?}", laid.warnings);
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
        assert!(laid.warnings.is_empty(), "{name}: {:?}", laid.warnings);
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
        assert!(laid.warnings.is_empty(), "{name}: {:?}", laid.warnings);
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
            Round::Done(out) => return (requests, Ok(*out)),
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

/// A spec that draws, through the deck's rounds and natively: the two
/// agree, and neither asks a third time.
fn drawn(source: &str) -> Compiled {
    let (_, out) = drive(source, &opts());
    let out = out.unwrap_or_else(|e| panic!("does not draw: {e:?}"));
    assert_eq!(out, compile_with(source, &opts(), &FixedMetrics).unwrap());
    assert!(out.svg.starts_with("<svg"), "{}", out.svg);
    out
}

/// The warnings of a spec that still draws, as `(path, message)` pairs.
fn warnings(source: &str) -> Vec<(String, String)> {
    drawn(source)
        .warnings
        .into_iter()
        .map(|e| (e.path, e.message))
        .collect()
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
    let w = warnings(
        r#"{"tugdiagram": 1, "form": "flow", "title": "t", "motion": "fast", "columns": [[{"id": "a", "name": "A"}]]}"#,
    );
    has(&w, "/motion", "enter, none");
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
    let w = warnings(&format!(
        r#"{{"tugdiagram": 1, "form": "sequence", "title": "t", "columns": [], "actors": {PQ}, "messages": [{{"from": "p", "to": "q", "label": "x"}}]}}"#
    ));
    has(&w, "/columns", "unknown field \"columns\"");
    let e = errors(&sequence(
        r#"[{"id": "p", "name": "P"}, {"name": "Q"}]"#,
        r#"[{"from": "p", "to": "p", "label": "x"}]"#,
    ));
    has(&e, "/actors/1/id", "id is required");
    // An id used twice names its first actor.
    let w = warnings(&sequence(
        r#"[{"id": "p", "name": "P", "x": 3}, {"id": "p", "name": "R"}]"#,
        r#"[{"from": "p", "to": "p", "label": "x"}]"#,
    ));
    has(&w, "/actors/0/x", "unknown field \"x\"");
    has(&w, "/actors/1/id", "already used at /actors/0");
}

#[test]
fn messages_join_actors_that_exist_and_carry_their_keys() {
    let e = errors(&sequence(PQ, r#"[{"from": "p", "to": "q"}]"#));
    has(&e, "/messages/0/label", "label is required");
    // A message naming an actor that does not exist is dropped, and the
    // rest are drawn.
    let source = sequence(
        PQ,
        r#"[{"from": "p", "to": "r", "label": "lost"}, {"from": "z", "to": "q", "label": "astray"}, {"from": "p", "to": "q", "label": "kept", "via": 1}]"#,
    );
    let w = warnings(&source);
    has(&w, "/messages/0/to", "no actor has the id \"r\"");
    has(&w, "/messages/1/from", "no actor has the id \"z\"");
    has(&w, "/messages/2/via", "unknown field \"via\"");
    let svg = drawn(&source).svg;
    assert!(svg.contains("kept") && !svg.contains("lost") && !svg.contains("astray"));
    // With every message dropped there is nothing left to draw.
    let e = errors(&sequence(
        PQ,
        r#"[{"from": "p", "to": "r", "label": "lost"}]"#,
    ));
    has(&e, "/messages", "nothing to draw");

    let source = sequence(
        PQ,
        r#"[{"from": "p", "to": "q", "label": "x", "tone": "accent", "reply": "yes", "what": "w"}, {"key": 1, "from": "q", "to": "p", "label": "first"}, {"key": 1, "from": "q", "to": "q", "label": "second"}]"#,
    );
    let w = warnings(&source);
    has(&w, "/messages/0/tone", "the accent is the key discs' alone");
    has(&w, "/messages/0/reply", "true or false");
    has(&w, "/messages/0/what", "belongs to a keyed mark");
    has(
        &w,
        "/messages/2/key",
        "key 1 is already given at /messages/1/key",
    );
    // The number's first mark keeps it.
    let rows = drawn(&source).table.rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][1], "first");
}

#[test]
fn a_message_label_stays_on_one_line() {
    // 60 value graphemes at 6.6 px under FixedMetrics: 396 px.
    let label = "x".repeat(60);
    let source = sequence(
        PQ,
        &format!(r#"[{{"from": "p", "to": "q", "label": "{label}"}}]"#),
    );
    has(
        &warnings(&source),
        "/messages/0/label",
        "396 px wide; it stays on one line",
    );
    // 320 px holds 48 value graphemes: 47 of the label and the ellipsis.
    let svg = drawn(&source).svg;
    assert!(svg.contains(&format!("{}…", "x".repeat(47))), "{svg}");
    assert!(!svg.contains(&label));
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
    assert!(laid.warnings.is_empty(), "{:?}", laid.warnings);
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
        r#"[{"name": "A", "cells": []}, {"sub": "s", "cells": [{"name": "c"}]}, {"name": "C"}]"#,
    ));
    has(&e, "/layers/0/cells", "at least one");
    has(&e, "/layers/1/name", "name is required");
    has(&e, "/layers/2/cells", "cells is required");
    let w = warnings(&layers(
        r#"[{"name": "A", "cells": [{"name": "c", "y": 2}], "x": 1}]"#,
    ));
    has(&w, "/layers/0/x", "unknown field \"x\"");
    has(&w, "/layers/0/cells/0/y", "unknown field \"y\"");
    let source = layers(
        r#"[{"name": "A", "below": "calls", "cells": [{"name": "a", "key": 1, "mono": "yes"}]}, {"name": "B", "below": "nothing beneath", "cells": [{"name": "b", "where": "src", "sub": ""}, {"name": "b2", "key": 1}]}]"#,
    );
    let w = warnings(&source);
    has(&w, "/layers/0/cells/0/mono", "true or false");
    has(
        &w,
        "/layers/1/below",
        "the last layer has nothing beneath it",
    );
    has(&w, "/layers/1/cells/0/where", "belongs to a keyed mark");
    has(&w, "/layers/1/cells/0/sub", "non-empty");
    has(
        &w,
        "/layers/1/cells/1/key",
        "key 1 is already given at /layers/0/cells/0/key",
    );
    // What crosses from the last layer has nowhere to be drawn.
    let svg = drawn(&source).svg;
    assert!(svg.contains("calls") && !svg.contains("nothing beneath"));
}

#[test]
fn a_crossing_label_wraps_to_two_lines_and_no_more() {
    // At 6.6 px a value grapheme, 240 px holds 36 of them a line.
    let two = "what crosses here is said in words that need two lines";
    let source = layers(&format!(
        r#"[{{"name": "A", "below": "{two}", "cells": [{{"name": "a"}}]}}, {{"name": "B", "cells": [{{"name": "b"}}]}}]"#
    ));
    assert_eq!(errors(&source), Vec::new());
    assert_eq!(warnings(&source), Vec::new());
    let four = "what crosses here is said in so many words that it would take four lines at the width a crossing wraps at";
    let source = layers(&format!(
        r#"[{{"name": "A", "below": "{four}", "cells": [{{"name": "a"}}]}}, {{"name": "B", "cells": [{{"name": "b"}}]}}]"#
    ));
    has(
        &warnings(&source),
        "/layers/0/below",
        "it may take at most 2",
    );
    // The second line ends where the third would have begun.
    let svg = drawn(&source).svg;
    assert!(
        svg.contains("…") && !svg.contains("crossing wraps at"),
        "{svg}"
    );
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
        r#""layers": [{"name": "L", "rows": [[{"name": "c"}], []]}, {"name": "M"}],
           "below": [{"sub": "s"}]"#,
    ));
    has(&e, "/layers/0/rows/1", "at least one");
    has(&e, "/layers/1/rows", "rows is required");
    has(&e, "/below/0/name", "name is required");
    // A span off the grid takes every column.
    let w = warnings(&stack(
        4,
        r#""above": [{"name": "A", "span": [3, 5]}, {"name": "B", "span": [3, 2]}, {"name": "C", "span": 2}],
           "layers": [{"name": "L", "span": [0, 1], "rows": [[{"name": "c", "x": 1}]]}]"#,
    ));
    has(&w, "/above/0/span", "from 1 to 4");
    has(&w, "/above/1/span", "first no later than last");
    has(&w, "/above/2/span", "span is [first, last]");
    has(&w, "/layers/0/span", "from 1 to 4");
    has(&w, "/layers/0/rows/0/0/x", "unknown field \"x\"");
    let w = warnings(&stack(
        2,
        r#""layers": [{"name": "L", "rows": [[{"name": "c", "key": 1}, {"name": "d", "key": 1, "what": "w"}]]}]"#,
    ));
    has(&w, "/layers/0/rows/0/1/key", "key 1 is already given");
    let e = errors(&stack(
        2,
        &format!(r#"{ONE_LAYER}, "across": {{"title": "Shared", "names": []}}"#),
    ));
    has(&e, "/across/names", "at least one");
}

#[test]
fn a_stack_cell_key_sits_in_its_corner_and_an_upright_name_is_cut_to_its_bar() {
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

    // A name longer than the stack is tall is cut to its bar.
    let long = "a name far too long to stand upright in three short layers";
    let layer = r#"{"name": "L", "rows": [[{"name": "c"}]]}"#;
    let source = stack(
        1,
        &format!(
            r#""layers": [{layer}, {layer}, {layer}], "across": {{"title": "Shared", "names": ["{long}"]}}"#
        ),
    );
    has(
        &warnings(&source),
        "/across/names/0",
        "runs upright in a bar",
    );
    let svg = drawn(&source).svg;
    assert!(svg.contains(">a name far") && svg.contains("…<"), "{svg}");
    assert!(!svg.contains(long), "{svg}");
}

#[test]
fn each_form_warns_of_a_figure_over_its_budget_and_draws_it() {
    let errors = warnings;
    let boxes: Vec<String> = (0..11)
        .map(|i| format!(r#"{{"id": "b{i}", "name": "B{i}"}}"#))
        .collect();
    let e = errors(&flow(&format!("[[{}]]", boxes.join(", ")), "[]"));
    has(
        &e,
        "/columns",
        "this flow has 11 boxes; it reads well with at most 10, so split it into two figures",
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
fn a_flow_whose_edges_cross_more_than_once_is_warned_of_and_drawn() {
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
    has(&warnings(&source), "/edges", "edges cross");
}

#[test]
fn unknown_keys_and_coordinates_are_ignored_with_a_warning_wherever_they_are() {
    let errors = warnings;
    // A coordinate moves nothing: the form still gives every one.
    let plain = drawn(&flow(r#"[[{"id": "a", "name": "A"}]]"#, "[]"));
    let placed = drawn(&flow(r#"[[{"id": "a", "name": "A", "x": 10}]]"#, "[]"));
    assert_eq!(placed.svg, plain.svg);
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
    // What is optional and malformed is left out, and the box is drawn.
    has(
        &warnings(&flow(r#"[[{"id": "a.b", "name": "A"}]]"#, "[]")),
        "/columns/0/0/id",
        "no dot",
    );
    has(
        &warnings(&flow(
            r#"[[{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]]"#,
            "[]",
        )),
        "/columns/0/1/id",
        "already used at /columns/0/0",
    );
    // A box given no rows is a box without rows.
    assert_eq!(
        drawn(&flow(r#"[[{"id": "a", "name": "A", "rows": []}]]"#, "[]")),
        drawn(&flow(r#"[[{"id": "a", "name": "A"}]]"#, "[]"))
    );
    has(
        &warnings(&flow(r#"[[{"id": "a", "name": "A", "notes": "n"}]]"#, "[]")),
        "/columns/0/0/notes",
        "an array",
    );
    has(
        &warnings(&flow(
            r#"[[{"id": "a", "name": "A", "rows": [{"name": "r", "mono": "yes"}]}]]"#,
            "[]",
        )),
        "/columns/0/0/rows/0/mono",
        "true or false",
    );
    has(
        &warnings(&flow(
            r#"[[{"id": "a", "name": "A", "rows": [{"name": "r", "lit": "red"}]}]]"#,
            "[]",
        )),
        "/columns/0/0/rows/0/lit",
        "good, bad, caution, outside",
    );
}

#[test]
fn a_key_is_numbered_once_and_its_first_mark_keeps_the_table_row() {
    let errors = warnings;
    let rows = |rows: &str| {
        flow(
            &format!(r#"[[{{"id": "a", "name": "A", "rows": {rows}}}]]"#),
            "[]",
        )
    };
    let twice = drawn(&rows(
        r#"[{"name": "r", "key": 1}, {"name": "s", "key": 1}]"#,
    ));
    assert_eq!(twice.table.rows.len(), 1);
    assert_eq!(twice.table.rows[0][1], "r");
    assert_eq!(twice.svg.matches("data-row=").count(), 1, "{}", twice.svg);
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
fn an_edge_naming_a_box_or_row_that_does_not_exist_is_dropped() {
    /// How many edges a flow keeps.
    fn kept(source: &str) -> usize {
        match diagram::validate(source).unwrap().form {
            diagram::spec::Form::Flow(f) => f.edges.len(),
            _ => panic!("a flow"),
        }
    }
    let dropped = |edges: &str, path: &str, says: &str| {
        let source = flow(AB, edges);
        has(&warnings(&source), path, says);
        assert_eq!(kept(&source), 0, "{edges}");
        // The boxes are drawn as they are with no edge at all.
        assert_eq!(drawn(&source).svg, drawn(&flow(AB, "[]")).svg);
    };
    dropped(
        r#"[{"from": "a", "to": "c"}]"#,
        "/edges/0/to",
        "no box has the id \"c\"",
    );
    dropped(
        r#"[{"from": "a.1", "to": "b"}]"#,
        "/edges/0/from",
        "box \"a\" has no rows",
    );
    dropped(
        r#"[{"from": "a", "to": "b.2"}]"#,
        "/edges/0/to",
        "rows 1 to 1",
    );
    dropped(
        r#"[{"from": "b.1", "to": "b"}]"#,
        "/edges/0",
        "two different boxes",
    );
    dropped(r#"{"from": "a"}"#, "/edges", "an array");
    // One edge astray does not take the others with it.
    let source = flow(
        AB,
        r#"[{"from": "a", "to": "c"}, {"from": "a", "to": "b"}]"#,
    );
    assert_eq!(kept(&source), 1);
    assert_eq!(warnings(&source).len(), 1);
    has(
        &errors(&flow(AB, r#"[{"to": "b"}]"#)),
        "/edges/0/from",
        "from is required",
    );
    has(
        &warnings(&flow(AB, r#"[{"from": "a", "to": "b", "tone": "accent"}]"#)),
        "/edges/0/tone",
        "key discs' alone",
    );
    has(
        &warnings(&flow(AB, r#"[{"from": "a", "to": "b", "dashed": 1}]"#)),
        "/edges/0/dashed",
        "true or false",
    );
}

#[test]
fn a_name_too_wide_for_one_line_is_cut_and_warned_of_with_its_width() {
    // 50 title graphemes at 7.8 px under FixedMetrics.
    let name = "N".repeat(50);
    let source = flow(&format!(r#"[[{{"id": "a", "name": "{name}"}}]]"#), "[]");
    has(
        &warnings(&source),
        "/columns/0/0/name",
        "390 px wide on its one line",
    );
    // 320 px holds 41: 40 of the name and the ellipsis.
    let out = drawn(&source);
    assert!(out.svg.contains(&format!("{}…", "N".repeat(40))));
    assert!(!out.svg.contains(&name));
    // The box is as wide as the cap and its padding, not as the name was.
    assert!(out.width < 390.0, "{}", out.width);

    // A keyed row's name is cut in the figure and whole in its table row.
    // 50 label graphemes at 7.2 px are 360 px.
    let row = "r".repeat(50);
    let out = drawn(&flow(
        &format!(r#"[[{{"id": "a", "name": "A", "rows": [{{"name": "{row}", "key": 1}}]}}]]"#),
        "[]",
    ));
    assert!(!out.svg.contains(&row), "{}", out.svg);
    assert_eq!(out.table.rows[0][1], row);
}

#[test]
fn secondary_text_past_two_lines_ends_its_second_in_an_ellipsis() {
    let label = "word ".repeat(24);
    let source = flow(
        AB,
        &format!(
            r#"[{{"from": "a", "to": "b", "label": "{}"}}]"#,
            label.trim()
        ),
    );
    has(
        &warnings(&source),
        "/edges/0/label",
        "it may take at most 2",
    );
    // 120 px holds 18 value graphemes: three words a line, and the
    // ellipsis beside the second line's three.
    let svg = drawn(&source).svg;
    assert!(svg.contains(">word word word<"), "{svg}");
    assert!(svg.contains(">word word word…<"), "{svg}");
    assert_eq!(svg.matches("word").count(), 6, "{svg}");
    let note = "note ".repeat(24);
    let w = warnings(&flow(
        &format!(
            r#"[[{{"id": "a", "name": "A", "notes": ["{}"]}}]]"#,
            note.trim()
        ),
        "[]",
    ));
    has(&w, "/columns/0/0/notes/0", "it may take at most 2");
}

#[test]
fn a_string_past_the_character_limit_is_kept_and_warned_of() {
    let what = "w".repeat(121);
    let source = flow(
        &format!(
            r#"[[{{"id": "a", "name": "A", "rows": [{{"name": "r", "key": 1, "what": "{what}"}}]}}]]"#
        ),
        "[]",
    );
    has(
        &warnings(&source),
        "/columns/0/0/rows/0/what",
        "over 120 characters",
    );
    assert_eq!(drawn(&source).table.rows[0][2], what);
}

#[test]
fn a_figure_wider_than_the_cap_is_drawn_at_its_width_and_says_to_split_it() {
    // As many columns as a flow should hold, of boxes as wide as a name may be.
    let name = "N".repeat(40);
    let columns: Vec<String> = (0..diagram::budget::FLOW_COLUMNS)
        .map(|i| format!(r#"[{{"id": "n{i}", "name": "{name}"}}]"#))
        .collect();
    let source = flow(&format!("[{}]", columns.join(",")), "[]");
    let w = warnings(&source);
    assert_eq!(w.len(), 1, "{w:?}");
    has(
        &w,
        "",
        "past the 1040 px a diagram reads well at; split it into two figures",
    );
    assert!(drawn(&source).width > diagram::MAX_W);
}

/// The figure that was withheld: five ordinary columns that lay out 56 px
/// past the width cap in the deck's faces.
const FIVE_COLUMNS: &str = r#"{"tugdiagram": 1, "form": "flow",
 "title": "Claude Code is made to work Tug's way by a plugin, and the plugin hands every decision to tugtool",
 "columns": [
  [{"id": "code", "name": "tugcode", "sub": "starts claude with --plugin-dir"}],
  [{"id": "claude", "name": "claude", "sub": "about to run a tool",
    "rows": [{"name": "Bash", "mono": true}, {"name": "Skill", "mono": true}]}],
  [{"id": "hooks", "name": "tugplug hooks",
    "rows": [{"key": 1, "name": "hooks.json", "mono": true, "what": "Registers a PreToolUse hook on Bash and Skill calls.", "where": "tugplug/hooks/hooks.json"},
             {"key": 2, "name": "pre-tool-use.sh", "mono": true, "what": "Finds tugtool and passes it the hook payload on stdin.", "where": "tugplug/hooks/pre-tool-use.sh"}]}],
  [{"id": "tool", "name": "tugtool hook pre-tool-use",
    "rows": [{"key": 3, "name": "decide", "sub": "allow, rewrite or deny", "what": "Approves safe calls, wraps test runners to report, refuses unattributable edits.", "where": "tugrust/crates/tugtool/src/commands/hook.rs"}]}],
  [{"id": "run", "name": "Runs", "sub": "maybe rewritten to report progress"},
   {"id": "deny", "name": "Refused", "sub": "with the form to write instead"}]
 ],
 "edges": [
  {"from": "code", "to": "claude"},
  {"from": "claude", "to": "hooks.1"},
  {"from": "hooks.2", "to": "tool"},
  {"from": "tool.1", "to": "run", "tone": "good", "label": "allowed"},
  {"from": "tool.1", "to": "deny", "tone": "bad", "dashed": true, "label": "denied"}
 ]}"#;

#[test]
fn the_five_column_flow_that_was_withheld_draws_with_its_table() {
    let out = drawn(FIVE_COLUMNS);
    let keys: Vec<&str> = out.table.rows.iter().map(|r| r[0].as_str()).collect();
    assert_eq!(keys, ["1", "2", "3"]);
    // Whatever it measures, the one thing it can be warned of is its width.
    assert!(
        out.warnings.iter().all(|w| w.path.is_empty()),
        "{:?}",
        out.warnings
    );
}

#[cfg(feature = "font")]
#[test]
fn the_five_column_flow_has_exactly_one_warning_in_the_real_faces_its_width() {
    let out = compile_with(FIVE_COLUMNS, &opts(), &real_faces()).unwrap();
    assert!(out.width > diagram::MAX_W, "{}", out.width);
    assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
    assert!(out.warnings[0].path.is_empty());
    assert!(
        out.warnings[0]
            .message
            .contains("px wide, past the 1040 px a diagram reads well at"),
        "{}",
        out.warnings[0].message
    );
}
