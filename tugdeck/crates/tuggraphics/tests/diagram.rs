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
        // A figure's width is the real faces' to judge: these stand-in
        // metrics set every grapheme at 0.6 em, wider than Plex, so the cap
        // is asserted in the real faces, below.
        let others: Vec<_> = laid
            .warnings
            .iter()
            .filter(|w| !(w.path.is_empty() && w.message.contains("px wide")))
            .collect();
        assert!(others.is_empty(), "{name}: {others:?}");
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
fn a_sequence_key_sits_on_its_senders_lifeline_where_the_arrow_starts() {
    use tuggraphics::draw::{ColourRole, Item, PaintKind, Seg};
    let name = "sequence-chart-fence";
    let laid = laid(name, &FixedMetrics);
    let start = |p: &tuggraphics::draw::PaintOp| match p.path.first() {
        Some(Seg::Move(x, y)) => Some((*x, *y)),
        _ => None,
    };
    // Each disc's centre: a circle's path starts a radius right of it.
    let discs: Vec<(f64, f64)> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if p.kind == PaintKind::Fill && p.role == ColourRole::Accent => {
                start(p).map(|(x, y)| (x - 8.0, y))
            }
            _ => None,
        })
        .collect();
    assert_eq!(discs.len(), 6);
    // The lifelines are the dashed 1 px rules, and the arrows the
    // round-or-butt-capped strokes.
    let mut lifelines: Vec<f64> = Vec::new();
    let mut arrows: Vec<(f64, f64)> = Vec::new();
    for i in &laid.program.items {
        if let Item::Paint(p) = i {
            if let PaintKind::Stroke { cap, .. } = p.kind {
                let Some(at) = start(p) else { continue };
                if cap.is_none() && p.width == 1.0 && !p.dash.is_empty() {
                    lifelines.push(at.0);
                } else if cap.is_some() {
                    arrows.push(at);
                }
            }
        }
    }
    for (x, y) in &discs {
        assert!(lifelines.contains(x), "disc at {x} is on no lifeline");
        assert!(
            arrows
                .iter()
                .any(|(ax, ay)| ay == y && (ax - x).abs() == 8.0),
            "no arrow leaves the disc at ({x}, {y})"
        );
    }
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
fn a_reply_is_dashed_with_an_open_head_and_a_call_is_solid_with_a_filled_one() {
    use tuggraphics::draw::{Cap, ColourRole, Item, PaintKind};
    let source = sequence(
        PQ,
        r#"[{"from": "p", "to": "q", "label": "ask"}, {"from": "q", "to": "p", "label": "answer", "reply": true}, {"from": "q", "to": "q", "label": "think"}]"#,
    );
    let spec = diagram::validate(&source).unwrap();
    let laid = run_rounds(&FixedMetrics, |m| diagram::layout(&spec, false, false, m)).unwrap();
    assert!(laid.warnings.is_empty(), "{:?}", laid.warnings);
    // The connectors' strokes, in order, as (colour, dashed, round-capped):
    // the call, the reply and its open head, the self-loop. Every one is in
    // full ink, and only the reply is dashed and ends in a stroked V.
    let edges: Vec<(ColourRole, bool, bool)> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) => match p.kind {
                PaintKind::Stroke { cap: Some(cap), .. } => {
                    Some((p.role, !p.dash.is_empty(), cap == Cap::Round))
                }
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(
        edges,
        [
            (ColourRole::Ink, false, false),
            (ColourRole::Ink, true, false),
            (ColourRole::Ink, false, true),
            (ColourRole::Ink, false, false)
        ]
    );
    // Heads: the call and the self-loop are filled; the reply's is not. The
    // call's origin dot is a filled arc, not a head.
    let filled_heads = laid
        .program
        .items
        .iter()
        .filter(|i| {
            matches!(i, Item::Paint(p)
                if p.kind == PaintKind::Fill && p.role == ColourRole::Ink && p.path.len() == 4
                    && !p.path.iter().any(|s| matches!(s, tuggraphics::draw::Seg::Arc { .. })))
        })
        .count();
    assert_eq!(filled_heads, 2);
}

/// The bounds of a path's end points, as (x0, y0, x1, y1).
fn bounds(path: &[tuggraphics::draw::Seg]) -> (f64, f64, f64, f64) {
    use tuggraphics::draw::Seg;
    let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for s in path {
        let (x, y) = match s {
            Seg::Move(x, y) | Seg::Line(x, y) | Seg::Arc { x, y, .. } => (*x, *y),
            Seg::Curve(c) => (c[4], c[5]),
            Seg::Close => continue,
        };
        b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
    }
    b
}

#[test]
fn a_called_actor_is_busy_until_it_answers_and_a_reply_sits_close_under_its_call() {
    use tuggraphics::draw::{ColourRole, Item, PaintKind, Seg, TypeRole};
    let source = sequence(
        PQ,
        r#"[{"from": "p", "to": "q", "label": "ask"}, {"from": "q", "to": "p", "label": "answer", "reply": true}, {"from": "p", "to": "q", "label": "again"}]"#,
    );
    assert_eq!(warnings(&source), Vec::new());
    let laid = laid_source(&source);
    let items = &laid.program.items;
    // The arrows' rows, top to bottom.
    let rows: Vec<f64> = items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if matches!(p.kind, PaintKind::Stroke { cap: Some(_), .. }) => {
                match p.path.first() {
                    Some(Seg::Move(_, y)) if p.path.len() == 2 => Some(*y),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    assert_eq!(rows.len(), 3);
    assert!(
        rows[1] - rows[0] < rows[2] - rows[1],
        "a reply is closer under its call than the next call: {rows:?}"
    );
    // One activation bar, 10 px wide, on Q from the call to the answer.
    let bars: Vec<(f64, f64, f64, f64)> = items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if p.kind == PaintKind::Fill && p.role == ColourRole::Surface => {
                Some(bounds(&p.path))
            }
            _ => None,
        })
        .filter(|b| b.2 - b.0 == 10.0)
        .collect();
    assert_eq!(bars.len(), 1, "{bars:?}");
    assert!(bars[0].1 < rows[0] && bars[0].3 > rows[1] && bars[0].3 < rows[2]);
    // Both unkeyed calls start at a dot on P's lifeline; the reply has none.
    let dots = items
        .iter()
        .filter(|i| {
            matches!(i, Item::Paint(p) if p.kind == PaintKind::Fill
                && p.role == ColourRole::Ink
                && matches!(p.path.first(), Some(Seg::Move(..)))
                && p.path.iter().any(|s| matches!(s, Seg::Arc { r, .. } if *r == 3.5)))
        })
        .count();
    assert_eq!(dots, 2);
    // Each actor's name is said again at the foot, below every arrow.
    for name in ["P", "Q"] {
        let foot = items.iter().find_map(|i| match i {
            Item::Text(t) if t.text == name && t.role == TypeRole::Value => Some(t.y),
            _ => None,
        });
        assert!(foot.is_some_and(|y| y > rows[2]), "{name} at {foot:?}");
    }
}

#[test]
fn a_phase_is_a_band_behind_its_run_named_in_the_gutter() {
    use tuggraphics::draw::{ColourRole, Item, PaintKind, Seg};
    let source = format!(
        r#"{{"tugdiagram": 1, "form": "sequence", "title": "t", "actors": {PQ}, "messages": [{{"from": "p", "to": "q", "label": "one"}}, {{"from": "q", "to": "p", "label": "two", "reply": true}}, {{"from": "p", "to": "q", "label": "three"}}], "phases": [{{"label": "Round", "note": "repeats", "from": 0, "to": 1}}]}}"#
    );
    assert_eq!(warnings(&source), Vec::new());
    let laid = laid_source(&source);
    let items = &laid.program.items;
    let bands: Vec<(f64, f64, f64, f64)> = items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p)
                if p.kind == PaintKind::Fill
                    && p.role == ColourRole::InkMuted
                    && p.opacity < 0.1 =>
            {
                Some(bounds(&p.path))
            }
            _ => None,
        })
        .collect();
    assert_eq!(bands.len(), 1);
    let rows: Vec<f64> = items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if matches!(p.kind, PaintKind::Stroke { cap: Some(_), .. }) => {
                match p.path.first() {
                    Some(Seg::Move(_, y)) if p.path.len() == 2 => Some(*y),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    let (_, top, _, bottom) = bands[0];
    assert!(top < rows[0] && bottom > rows[1] && bottom < rows[2]);
    // The label and note stand in the gutter, left of every lifeline.
    let x_of = |s: &str| {
        items.iter().find_map(|i| match i {
            Item::Text(t) if t.text == s => Some(t.x),
            _ => None,
        })
    };
    let p_x = x_of("P").unwrap();
    assert!(x_of("Round").unwrap() < p_x - 40.0);
    assert!(x_of("repeats").unwrap() < p_x - 40.0);
}

#[test]
fn a_phase_off_the_end_is_cut_and_one_that_cannot_be_drawn_is_left_out() {
    let source = format!(
        r#"{{"tugdiagram": 1, "form": "sequence", "title": "t", "actors": {PQ}, "messages": [{{"from": "p", "to": "q", "label": "a"}}, {{"from": "p", "to": "q", "label": "b"}}, {{"from": "p", "to": "q", "label": "c"}}], "phases": [{{"label": "A", "from": 0, "to": 1}}, {{"label": "B", "from": 1, "to": 9}}, {{"label": "C", "from": 5, "to": 6}}, {{"label": "D", "from": 2, "to": 1}}, {{"from": 0, "to": 0}}, {{"label": "F", "from": "x", "to": 0}}, {{"label": "G", "from": 2, "to": 2, "tone": "good"}}]}}"#
    );
    let w = warnings(&source);
    has(&w, "/phases/1", "overlaps the one before it");
    has(&w, "/phases/1/to", "ends at the last, 2");
    has(&w, "/phases/2/from", "there is no message 5");
    has(&w, "/phases/3/to", "to is before from");
    has(&w, "/phases/4/label", "a phase needs a label");
    has(&w, "/phases/5/from", "0-based index");
    has(&w, "/phases/6/tone", "unknown field \"tone\"");
    let spec = diagram::validate(&source).unwrap();
    let diagram::spec::Form::Sequence(seq) = &spec.form else {
        panic!("a sequence");
    };
    let kept: Vec<(&str, usize, usize)> = seq
        .phases
        .iter()
        .map(|p| (p.label.as_str(), p.from, p.to))
        .collect();
    assert_eq!(kept, [("A", 0, 1), ("G", 2, 2)]);
    let w = warnings(&format!(
        r#"{{"tugdiagram": 1, "form": "sequence", "title": "t", "actors": {PQ}, "messages": [{{"from": "p", "to": "q", "label": "a"}}], "phases": {{"label": "A"}}}}"#
    ));
    has(&w, "/phases", "phases is an array");
}

/// A flow program's strokes in `role`, 2 px wide: an edge's line.
fn edge_paths(
    laid: &diagram::Laid,
    role: tuggraphics::draw::ColourRole,
) -> Vec<(f64, f64, f64, f64)> {
    use tuggraphics::draw::{Item, PaintKind};
    laid.program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p)
                if p.role == role
                    && p.width == 2.0
                    && matches!(p.kind, PaintKind::Stroke { cap: Some(_), .. }) =>
            {
                Some(bounds(&p.path))
            }
            _ => None,
        })
        .collect()
}

/// A flow program's boxes, left to right: the shapes outlined in muted ink
/// at 0.9, which is a box's outline and nothing else's.
fn flow_boxes(laid: &diagram::Laid) -> Vec<(f64, f64, f64, f64)> {
    use tuggraphics::draw::{ColourRole, Item, PaintKind};
    let mut out: Vec<(f64, f64, f64, f64)> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p)
                if matches!(p.kind, PaintKind::Stroke { .. })
                    && p.role == ColourRole::InkMuted
                    && p.opacity == 0.9 =>
            {
                Some(bounds(&p.path))
            }
            _ => None,
        })
        .collect();
    out.sort_by(|p, q| p.0.total_cmp(&q.0));
    out
}

#[test]
fn a_back_edge_to_the_neighbour_crosses_the_one_gap_from_its_facing_side() {
    use tuggraphics::draw::ColourRole;
    let source = flow(
        r#"[[{"id": "a", "name": "A"}], [{"id": "b", "name": "B", "rows": [{"name": "one"}, {"name": "two"}]}]]"#,
        r#"[{"from": "a", "to": "b.1"}, {"from": "b.2", "to": "a", "tone": "bad", "label": "no"}]"#,
    );
    assert_eq!(warnings(&source), Vec::new());
    let laid = laid_source(&source);
    let boxes = flow_boxes(&laid);
    let (a, b) = (boxes[0], boxes[1]);
    let back = edge_paths(&laid, ColourRole::Bad);
    assert_eq!(back.len(), 1);
    let (x0, y0, x1, y1) = back[0];
    // It stays in the gap between the two, never under or around them.
    assert!(
        x0 >= a.2 && x1 <= b.0 + 12.0,
        "{back:?} between {a:?} and {b:?}"
    );
    assert!(y0 >= b.1 && y1 <= b.3, "{back:?} within {b:?}");
}

#[test]
fn each_edge_that_skips_a_column_has_a_lane_of_its_own_and_one_to_a_row_comes_up_beside_it() {
    use tuggraphics::draw::ColourRole;
    let source = flow(
        r#"[[{"id": "a", "name": "A"}], [{"id": "b", "name": "B"}], [{"id": "c", "name": "C", "rows": [{"name": "one"}, {"name": "two"}]}]]"#,
        r#"[{"from": "a", "to": "c", "tone": "good", "label": "to the box"}, {"from": "a", "to": "c.2", "tone": "bad", "label": "to the row"}]"#,
    );
    assert_eq!(warnings(&source), Vec::new());
    let laid = laid_source(&source);
    assert_eq!(laid.crossings, 0);
    let boxes = flow_boxes(&laid);
    let (b, c) = (boxes[1], boxes[2]);
    let bottom = boxes.iter().map(|r| r.3).fold(0.0, f64::max);
    let good = edge_paths(&laid, ColourRole::Good)[0];
    let bad = edge_paths(&laid, ColourRole::Bad)[0];
    // Both run under the boxes, each in a lane of its own, 30 px apart.
    assert!(good.3 > bottom && bad.3 > bottom);
    assert_eq!((good.3 - bad.3).abs(), 30.0, "{good:?} {bad:?}");
    // The one to the box comes up into it from below; the one to the row
    // comes up in the gap before C and turns into the row.
    assert!(good.0 < c.2 && good.2 > c.0, "{good:?} under {c:?}");
    assert!(bad.2 <= c.0 + 12.0, "{bad:?} stays left of {c:?}'s rows");
    assert!(bad.2 > b.2, "{bad:?} reaches past {b:?}");
    assert!(bad.1 < bottom, "{bad:?} rises to the row");
}

#[test]
fn a_lit_row_wears_a_wash_an_outline_and_a_dot_in_its_tone() {
    use tuggraphics::draw::{ColourRole, Item, PaintKind, Seg};
    let laid = laid_source(&flow(
        r#"[[{"id": "a", "name": "A", "rows": [{"name": "kept", "lit": "good"}, {"name": "plain"}]}]]"#,
        "[]",
    ));
    let good: Vec<&tuggraphics::draw::PaintOp> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) if p.role == ColourRole::Good => Some(p),
            _ => None,
        })
        .collect();
    let wash = good
        .iter()
        .any(|p| p.kind == PaintKind::Fill && p.opacity < 0.2 && p.path.len() > 8);
    let outline = good
        .iter()
        .any(|p| matches!(p.kind, PaintKind::Stroke { .. }) && p.path.len() > 8);
    let dot = good.iter().any(|p| {
        p.kind == PaintKind::Fill
            && p.opacity == 1.0
            && p.path
                .iter()
                .any(|s| matches!(s, Seg::Arc { r, .. } if *r == 4.0))
    });
    assert!(
        wash && outline && dot,
        "wash {wash}, outline {outline}, dot {dot}"
    );
}

#[test]
fn a_legend_names_the_tones_in_one_line_under_the_figure() {
    use tuggraphics::draw::Item;
    let source = format!(
        r#"{{"tugdiagram": 1, "form": "flow", "title": "t", "columns": {AB}, "edges": [{{"from": "a", "to": "b", "tone": "good"}}], "legend": [{{"tone": "good", "text": "kept"}}, {{"tone": "bad", "text": "not here"}}, {{"tone": "good", "text": "twice"}}, {{"tone": "good"}}, {{"tone": "accent", "text": "x"}}, "nope"]}}"#
    );
    let w = warnings(&source);
    has(&w, "/legend/1/tone", "no edge or row in this figure is bad");
    has(&w, "/legend/2/tone", "good is already in the legend");
    has(&w, "/legend/3", "needs a tone and a text");
    has(&w, "/legend/4/tone", "the accent is the key discs' alone");
    has(&w, "/legend/5", "a legend entry is");
    let laid = laid_source(&source);
    let ys = |s: &str| {
        laid.program.items.iter().find_map(|i| match i {
            Item::Text(t) if t.text == s => Some(t.y),
            _ => None,
        })
    };
    assert!(ys("not here").is_none() && ys("twice").is_none());
    let kept = ys("kept").expect("the kept entry is drawn");
    let bottom = flow_boxes(&laid).iter().map(|r| r.3).fold(0.0, f64::max);
    assert!(kept > bottom, "{kept} under {bottom}");
}

#[cfg(feature = "font")]
#[test]
fn the_edit_gate_flow_fits_the_width_cap_in_the_real_faces() {
    let out = compile_with(&golden("flow-edit-gate"), &opts(), &real_faces()).unwrap();
    assert!(out.width <= diagram::MAX_W, "{}", out.width);
    assert!(out.warnings.is_empty(), "{:?}", out.warnings);
}

/// A states figure with these states and transitions.
fn states(states: &str, transitions: &str) -> String {
    format!(
        r#"{{"tugdiagram": 1, "form": "states", "title": "t", "states": {states}, "transitions": {transitions}}}"#
    )
}

const ABCS: &str = r#"[{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}, {"id": "s", "name": "S", "under": "a"}]"#;

#[test]
fn a_state_transition_is_placed_by_where_its_two_ends_stand() {
    use tuggraphics::draw::ColourRole;
    let source = states(
        ABCS,
        r#"[{"from": "a", "to": "b", "label": "next"}, {"from": "c", "to": "a", "tone": "good", "label": "again"}, {"from": "a", "to": "s", "tone": "bad", "label": "fails"}, {"from": "s", "to": "a", "tone": "caution", "label": "retries"}, {"from": "s", "to": "b", "tone": "outside", "label": "skips"}]"#,
    );
    assert_eq!(warnings(&source), Vec::new());
    let laid = laid_source(&source);
    assert_eq!(laid.crossings, 0);
    // The states, main line first: the side state stands lower.
    let mut boxes = flow_boxes(&laid);
    boxes.sort_by(|p, q| (p.1, p.0).partial_cmp(&(q.1, q.0)).unwrap());
    let (a, b, c, s) = (boxes[0], boxes[1], boxes[2], boxes[3]);
    assert!(a.1 == b.1 && b.1 == c.1 && s.1 > a.3, "{boxes:?}");
    assert!(s.0 < a.2 && s.2 > a.0, "{s:?} hangs beneath {a:?}");
    let one = |role| {
        let paths = edge_paths(&laid, role);
        assert_eq!(paths.len(), 1, "{role:?}: {paths:?}");
        paths[0]
    };
    // Back to the first state on the line: over the top, end to end.
    let over = one(ColourRole::Good);
    assert!(over.1 < a.1, "{over:?} runs over the line");
    assert!(over.0 > a.0 && over.2 < c.2, "{over:?} from {c:?} to {a:?}");
    // Down to the side state and back up: two straight verticals in the
    // gap between the rows.
    let down = one(ColourRole::Bad);
    let up = one(ColourRole::Caution);
    for v in [down, up] {
        assert_eq!(v.0, v.2, "{v:?} is straight");
        assert!(v.1 >= a.3 && v.3 <= s.1, "{v:?} between {a:?} and {s:?}");
    }
    assert_ne!(down.0, up.0);
    // From the side state to another: out of its side, along the bottom
    // row, and up into the target's lower edge.
    let back = one(ColourRole::Outside);
    assert!(
        back.0 >= s.2 && back.3 > s.1 && back.3 < s.3,
        "{back:?} leaves {s:?}"
    );
    // The line stops where its filled head begins.
    assert!(back.1 > b.3 && back.1 <= b.3 + 11.0, "{back:?} into {b:?}");
    assert!(back.2 > b.0 && back.2 < b.2, "{back:?} into {b:?}");
}

#[test]
fn a_short_state_many_transitions_reach_keeps_their_ends_apart() {
    use tuggraphics::draw::ColourRole;
    // Three lanes over the top all end on A, whose name is one letter.
    let source = states(
        r#"[{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}, {"id": "d", "name": "D"}]"#,
        r#"[{"from": "b", "to": "a", "tone": "caution"}, {"from": "c", "to": "a", "tone": "good"}, {"from": "d", "to": "a", "tone": "bad"}]"#,
    );
    let laid = laid_source(&source);
    // Each lane runs leftwards into A, so its end is its leftmost point.
    let mut ends: Vec<f64> = [ColourRole::Caution, ColourRole::Good, ColourRole::Bad]
        .into_iter()
        .map(|role| {
            let paths = edge_paths(&laid, role);
            assert_eq!(paths.len(), 1, "{role:?}: {paths:?}");
            paths[0].0
        })
        .collect();
    ends.sort_by(f64::total_cmp);
    for pair in ends.windows(2) {
        assert!(
            pair[1] - pair[0] >= 20.0,
            "ends crowd one another: {ends:?}"
        );
    }
}

#[test]
fn a_state_that_names_nothing_and_a_transition_no_rule_places_are_repaired() {
    let source = r#"{"tugdiagram": 1, "form": "states", "title": "t", "start": "nowhere", "states": [{"id": "a", "name": "A"}, {"id": "b", "name": "B", "under": "ghost"}, {"id": "s", "name": "S", "under": "a"}, {"id": "t", "name": "T", "under": "s"}, {"id": "u", "name": "U", "under": "b"}], "transitions": [{"from": "a", "to": "missing"}, {"from": "a", "to": "a"}, {"from": "s", "to": "u"}, {"from": "b", "to": "s"}, {"from": "a", "to": "b"}]}"#;
    let w = warnings(source);
    has(&w, "/start", "no state has the id \"nowhere\"");
    has(
        &w,
        "/states/1/under",
        "no state has the id \"ghost\", so this state stands on the main line",
    );
    has(&w, "/states/3/under", "\"s\" hangs beneath another state");
    has(
        &w,
        "/transitions/0/to",
        "no state has the id \"missing\", so this transition is dropped",
    );
    has(&w, "/transitions/1", "from a state to itself is not drawn");
    has(
        &w,
        "/transitions/2",
        "a side state's transitions go to the main line",
    );
    has(
        &w,
        "/transitions/3",
        "reached only from the state it hangs beneath",
    );
    let spec = diagram::validate(source).unwrap();
    let diagram::spec::Form::States(st) = &spec.form else {
        panic!("not states");
    };
    // B and T stand on the main line; U hangs beneath B, which now does.
    let names: Vec<&str> = st
        .main()
        .iter()
        .map(|&i| st.states[i].name.as_str())
        .collect();
    assert_eq!(names, ["A", "B", "T"]);
    assert_eq!(st.states[4].under, Some(1));
    assert_eq!(st.start, 0);
    assert_eq!(st.transitions.len(), 1);
}

#[test]
fn a_states_figure_starts_at_a_dot_and_an_end_wears_a_second_outline() {
    use tuggraphics::draw::{ColourRole, Item, PaintKind, Seg};
    let laid = laid_source(&states(
        r#"[{"id": "a", "name": "A"}, {"id": "z", "name": "Z", "end": true}]"#,
        r#"[{"from": "a", "to": "z"}]"#,
    ));
    let paints: Vec<&tuggraphics::draw::PaintOp> = laid
        .program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p) => Some(p),
            _ => None,
        })
        .collect();
    let start = paints.iter().any(|p| {
        p.kind == PaintKind::Fill
            && p.role == ColourRole::Ink
            && p.path
                .iter()
                .any(|s| matches!(s, Seg::Arc { r, .. } if *r == 5.0))
    });
    let second = paints
        .iter()
        .filter(|p| matches!(p.kind, PaintKind::Stroke { cap: None, .. }) && p.opacity == 0.6)
        .count();
    assert!(start, "no start dot");
    assert_eq!(second, 1, "one second outline, on the end state");
}

#[test]
fn a_states_figure_past_its_budget_still_draws_and_says_so() {
    let main: Vec<String> = (0..7)
        .map(|i| format!(r#"{{"id": "m{i}", "name": "M{i}"}}"#))
        .collect();
    let overs: Vec<String> = (2..6)
        .map(|i| format!(r#"{{"from": "m{i}", "to": "m0"}}"#))
        .collect();
    let source = states(
        &format!(
            r#"[{}, {{"id": "x", "name": "X", "under": "m1"}}, {{"id": "y", "name": "Y", "under": "m1"}}]"#,
            main.join(", ")
        ),
        &format!("[{}]", overs.join(", ")),
    );
    let w = warnings(&source);
    has(&w, "/states", "7 states on the main line");
    has(&w, "/states/1", "2 states beneath one state");
    has(&w, "/transitions", "4 transitions over the top");
}

/// A tree figure with this root.
fn tree(root: &str) -> String {
    format!(r#"{{"tugdiagram": 1, "form": "tree", "title": "t", "root": {root}}}"#)
}

/// A tree program's nodes, as (bounds, outline opacity): the shapes
/// outlined with no cap, which a node's outline is and a line is not.
fn tree_nodes(laid: &diagram::Laid) -> Vec<((f64, f64, f64, f64), f64)> {
    use tuggraphics::draw::{ColourRole, Item, PaintKind};
    laid.program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p)
                if matches!(p.kind, PaintKind::Stroke { cap: None, .. })
                    && p.role == ColourRole::InkMuted =>
            {
                Some((bounds(&p.path), p.opacity))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn a_tree_stands_a_level_in_each_column_and_a_parent_centred_on_its_children() {
    use tuggraphics::draw::{ColourRole, Item, PaintKind};
    let source = tree(
        r#"{"name": "root", "children": [{"name": "a", "children": [{"name": "a1"}, {"name": "a2 is longer"}]}, {"name": "b"}, {"name": "c"}]}"#,
    );
    assert_eq!(warnings(&source), Vec::new());
    let laid = laid_source(&source);
    assert_eq!(laid.crossings, 0);
    // Pre-order: root, a, a1, a2, b, c.
    let nodes = tree_nodes(&laid);
    assert_eq!(nodes.len(), 6, "{nodes:?}");
    let (root, a, a1, a2, b, c) = (
        nodes[0].0, nodes[1].0, nodes[2].0, nodes[3].0, nodes[4].0, nodes[5].0,
    );
    // One column per level, every node in it the column's width.
    assert!(root.2 < a.0 && a.2 < a1.0, "{nodes:?}");
    assert_eq!((a.0, a.2), (b.0, b.2));
    assert_eq!((b.0, b.2), (c.0, c.2));
    assert_eq!((a1.0, a1.2), (a2.0, a2.2));
    // A parent is centred on its children.
    let mid = |r: (f64, f64, f64, f64)| (r.1 + r.3) / 2.0;
    assert!(
        (mid(a) - (mid(a1) + mid(a2)) / 2.0).abs() <= 1.0,
        "{a:?} on {a1:?} {a2:?}"
    );
    assert!(
        (mid(root) - (mid(a) + mid(c)) / 2.0).abs() <= 1.0,
        "{root:?} on {a:?} {c:?}"
    );
    // A parent wears the full outline and a leaf a fainter one.
    let outlines: Vec<f64> = nodes.iter().map(|n| n.1).collect();
    assert_eq!(outlines, [0.9, 0.9, 0.4, 0.4, 0.4, 0.4]);
    // The joining lines are lighter, muted and headless.
    let mut lines = 0;
    for i in &laid.program.items {
        if let Item::Paint(p) = i {
            if matches!(p.kind, PaintKind::Stroke { cap: Some(_), .. }) {
                assert_eq!((p.role, p.width), (ColourRole::InkMuted, 1.5));
                lines += 1;
            }
            assert!(
                !(p.kind == PaintKind::Fill && p.path.len() == 4),
                "a line has a head"
            );
        }
    }
    assert_eq!(lines, 5);
}

#[test]
fn a_toned_node_colours_only_the_stub_into_it() {
    use tuggraphics::draw::ColourRole;
    let laid = laid_source(&tree(
        r#"{"name": "root", "children": [{"name": "a"}, {"name": "b", "tone": "bad"}, {"name": "c"}]}"#,
    ));
    let bad = edge_paths_of_width(&laid, ColourRole::Bad, 1.5);
    assert_eq!(bad.len(), 1, "{bad:?}");
    let (x0, y0, x1, y1) = bad[0];
    assert_eq!(y0, y1, "the stub is level");
    let root = tree_nodes(&laid)[0].0;
    assert!(x0 > root.2 + 22.0, "{bad:?} starts past the trunk's lane");
    assert!(x1 > x0);
}

#[test]
fn a_tree_past_its_budget_still_draws_and_says_so() {
    let deep = tree(
        r#"{"name": "1", "children": [{"name": "2", "children": [{"name": "3", "children": [{"name": "4", "children": [{"name": "5"}]}]}]}]}"#,
    );
    has(&warnings(&deep), "/root", "5 levels");
    let leaves: Vec<String> = (0..20).map(|i| format!(r#"{{"name": "n{i}"}}"#)).collect();
    let wide = tree(&format!(
        r#"{{"name": "root", "children": [{}]}}"#,
        leaves.join(", ")
    ));
    has(&warnings(&wide), "/root", "21 nodes");
    let errs = errors(&tree(
        r#"{"name": "root", "children": [{"sub": "no name"}]}"#,
    ));
    has(&errs, "/root/children/0/name", "name is required");
}

/// A program's strokes in `role` and `width` with a cap: a connector's line.
fn edge_paths_of_width(
    laid: &diagram::Laid,
    role: tuggraphics::draw::ColourRole,
    width: f64,
) -> Vec<(f64, f64, f64, f64)> {
    use tuggraphics::draw::{Item, PaintKind};
    laid.program
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Paint(p)
                if p.role == role
                    && p.width == width
                    && matches!(p.kind, PaintKind::Stroke { cap: Some(_), .. }) =>
            {
                Some(bounds(&p.path))
            }
            _ => None,
        })
        .collect()
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

/// Lays `source` out natively under `FixedMetrics`.
fn laid_source(source: &str) -> diagram::Laid {
    let spec = diagram::validate(source).unwrap();
    run_rounds(&FixedMetrics, |m| diagram::layout(&spec, false, false, m)).unwrap()
}

/// A program's connector strokes (2 px, butt-capped) and filled heads.
fn connectors(laid: &diagram::Laid) -> (usize, usize) {
    use tuggraphics::draw::{Cap, ColourRole, Item, PaintKind};
    let mut strokes = 0;
    let mut heads = 0;
    for i in &laid.program.items {
        if let Item::Paint(p) = i {
            match p.kind {
                PaintKind::Stroke {
                    cap: Some(Cap::Butt),
                    ..
                } if p.width == 2.0 => strokes += 1,
                PaintKind::Fill if p.role == ColourRole::Ink && p.path.len() == 4 => heads += 1,
                _ => {}
            }
        }
    }
    (strokes, heads)
}

#[test]
fn a_crossing_says_what_goes_each_way_about_the_band_centre() {
    use tuggraphics::draw::{Anchor, Item, TypeRole};
    let two = |below: &str| {
        layers(&format!(
            r#"[{{"name": "A", "below": {below}, "cells": [{{"name": "a"}}]}}, {{"name": "B", "cells": [{{"name": "b"}}]}}]"#
        ))
    };
    // A string still draws as it did: one two-headed arrow, its label on it.
    let both = laid_source(&two(r#""calls""#));
    assert_eq!(connectors(&both), (1, 2));
    // Down and up: two one-way arrows, one head each, down's label to the
    // left of the pair and up's to the right, the channel in a code chip.
    let source = two(r#"{"via": "pipe", "down": "asks", "up": "answers"}"#);
    assert_eq!(warnings(&source), Vec::new());
    let ways = laid_source(&source);
    assert_eq!(connectors(&ways), (2, 2));
    let text = |s: &str| {
        ways.program
            .items
            .iter()
            .find_map(|i| match i {
                Item::Text(t) if t.text == s => Some(t.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no text {s:?}"))
    };
    let (down, up, via) = (text("asks"), text("answers"), text("pipe"));
    assert_eq!(down.anchor, Anchor::End);
    assert_eq!(up.anchor, Anchor::Start);
    assert_eq!(via.role, TypeRole::Mono);
    // Laid out symmetrically about the centre the chip sits on.
    assert_eq!(via.x - down.x, up.x - via.x);
    // One direction alone is a single one-way arrow.
    assert_eq!(
        connectors(&laid_source(&two(r#"{"down": "asks"}"#))),
        (1, 1)
    );
    // A channel alone crosses both ways.
    assert_eq!(connectors(&laid_source(&two(r#"{"via": "pipe"}"#))), (1, 2));
}

#[test]
fn a_crossing_or_a_tone_of_the_wrong_shape_is_left_out() {
    let source = layers(
        r#"[{"name": "A", "tone": "good", "below": {"sideways": "x"}, "cells": [{"name": "a"}]},
            {"name": "B", "tone": "outside", "below": 3, "cells": [{"name": "b"}]},
            {"name": "C", "cells": [{"name": "c"}]}]"#,
    );
    assert_eq!(errors(&source), Vec::new());
    let w = warnings(&source);
    has(&w, "/layers/0/tone", "a layer's tone is outside alone");
    has(&w, "/layers/0/below/sideways", "unknown field");
    has(&w, "/layers/0/below", "at least one of via, down and up");
    has(&w, "/layers/1/below", "a string or");
    let spec = diagram::validate(&source).unwrap();
    let diagram::spec::Form::Layers(l) = &spec.form else {
        panic!("a layers figure");
    };
    let outside: Vec<bool> = l.layers.iter().map(|l| l.outside).collect();
    assert_eq!(outside, [false, true, false]);
    assert!(l.layers.iter().all(|l| l.below.is_none()));
}

#[test]
fn a_stack_arrow_carries_its_link_and_a_layer_says_what_passes_below_it() {
    let source = stack(
        2,
        r#""above": [{"name": "You", "link": "keys"}],
           "layers": [{"name": "L", "below": "frames", "rows": [[{"name": "c"}]]},
                      {"name": "M", "below": "nothing beneath", "rows": [[{"name": "d"}]]}],
           "below": [{"name": "Disk", "link": "SQLite"}]"#,
    );
    has(
        &warnings(&source),
        "/layers/1/below",
        "the last layer has no layer beneath it",
    );
    let svg = drawn(&source).svg;
    for label in ["keys", "frames", "SQLite"] {
        assert!(svg.contains(&format!(">{label}<")), "{label}: {svg}");
    }
    assert!(!svg.contains("nothing beneath"), "{svg}");
    // Three two-headed connectors: above, between the layers, below.
    assert_eq!(connectors(&laid_source(&source)), (3, 6));
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
fn a_stack_cell_key_stands_just_before_its_name_and_an_upright_name_is_cut_to_its_bar() {
    use tuggraphics::draw::{Anchor, ColourRole, Item, PaintKind, Seg};
    let name = "stack-architecture";
    let laid = laid(name, &FixedMetrics);
    // A key and its name are one group: the disc stands just before the
    // name, on its line, and the name starts where the key's room ends.
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
    let names: Vec<f64> = ["Session card", "Feeds", "Semantic index", "Spawn config"]
        .iter()
        .map(|n| {
            laid.program
                .items
                .iter()
                .find_map(|i| match i {
                    Item::Text(t) if t.text == *n && t.anchor == Anchor::Start => Some(t.x),
                    _ => None,
                })
                .unwrap()
        })
        .collect();
    // A disc's path starts at its rightmost point, one disc's width right
    // of where the key's room begins; the room is the disc and a 7 px gap.
    for ((dx, _), name_x) in discs.iter().zip(&names) {
        assert_eq!(name_x - dx, 7.0, "the name starts 7 px past its disc");
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
    // A chip in a gap wraps at 96 px, which holds 14 value graphemes:
    // three words a line, and the ellipsis takes the room of the second
    // line's third.
    let svg = drawn(&source).svg;
    assert!(svg.contains(">word word word<"), "{svg}");
    assert!(svg.contains(">word word…<"), "{svg}");
    assert_eq!(svg.matches("word").count(), 5, "{svg}");
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
