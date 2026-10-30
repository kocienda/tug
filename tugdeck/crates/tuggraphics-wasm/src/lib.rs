//! tuggraphics-wasm — the page's shell over `tuggraphics`.
//!
//! # API
//!
//! Every export returns a plain JS object tagged by `status`:
//!
//! ```ts
//! render_program(source, id_prefix)
//!   → { status: "done", svg } | { status: "invalid", errors: { op: number | null, message }[] }
//! compile_round(source, opts_json, table_json)
//!   → { status: "measure", texts: [role, text][] }
//!   | { status: "done", svg, table, find_text, width, height }
//!   | { status: "invalid", errors: { path, message }[] }
//! validate(source, layers) → { status: "valid" } | { status: "invalid", errors: { path, message }[] }
//! find_text(source, layers) → string
//! ```
//!
//! The work lives in plain functions returning [`serde::Serialize`] values,
//! tested natively; the `#[wasm_bindgen]` exports only serialize them.

use serde::Serialize;
use tuggraphics::draw::DrawError;
use tuggraphics::{render_program as render, ChartError, CompileOpts, Layers, MeasureTable, RenderOpts, Round};
use wasm_bindgen::prelude::*;

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum RenderOutcome {
    Done { svg: String },
    Invalid { errors: Vec<DrawError> },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ValidateOutcome {
    Valid,
    Invalid { errors: Vec<ChartError> },
}

pub fn render_program_outcome(source: &str, id_prefix: &str) -> RenderOutcome {
    let opts = RenderOpts {
        id_prefix,
        standalone: None,
    };
    match render(source, &opts) {
        Ok(svg) => RenderOutcome::Done { svg },
        Err(errors) => RenderOutcome::Invalid { errors },
    }
}

/// A door's layers by name; anything but `"any"` is the fence's `"chart"`,
/// the stricter reading.
fn layers(name: &str) -> Layers {
    Layers::parse(name).unwrap_or(Layers::Chart)
}

/// One round of the measure protocol against the table the deck measured.
pub fn compile_round_outcome(source: &str, opts_json: &str, table_json: &str) -> Round {
    let opts = match CompileOpts::from_json(opts_json) {
        Ok(opts) => opts,
        Err(e) => return Round::Invalid { errors: vec![e] },
    };
    match MeasureTable::from_json(table_json) {
        Ok(table) => tuggraphics::compile_round(source, &opts, &table),
        Err(message) => Round::Invalid {
            errors: vec![ChartError {
                path: String::new(),
                message,
            }],
        },
    }
}

pub fn validate_outcome(source: &str, layers_name: &str) -> ValidateOutcome {
    match tuggraphics::validate(source, layers(layers_name)) {
        Ok(_) => ValidateOutcome::Valid,
        Err(errors) => ValidateOutcome::Invalid { errors },
    }
}

/// The text Find counts for a source at a door.
pub fn find_text_of(source: &str, layers_name: &str) -> String {
    tuggraphics::find_text(source, layers(layers_name))
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    // JSON-compatible: `None` becomes `null`, not `undefined`, and maps
    // become plain objects.
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

/// Validates and renders a layer 0 program in deck mode.
#[wasm_bindgen]
pub fn render_program(source: &str, id_prefix: &str) -> Result<JsValue, JsValue> {
    to_js(&render_program_outcome(source, id_prefix))
}

/// One round of the chart compile: the texts still to measure, the
/// finished chart, or every error.
#[wasm_bindgen]
pub fn compile_round(source: &str, opts_json: &str, table_json: &str) -> Result<JsValue, JsValue> {
    to_js(&compile_round_outcome(source, opts_json, table_json))
}

/// Every error in a source, for a door taking `layers` (`"chart"` or
/// `"any"`).
#[wasm_bindgen]
pub fn validate(source: &str, layers: &str) -> Result<JsValue, JsValue> {
    to_js(&validate_outcome(source, layers))
}

/// The text transcript Find counts for a source.
#[wasm_bindgen]
pub fn find_text(source: &str, layers: &str) -> String {
    find_text_of(source, layers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_program() {
        let src = r#"{"tugdraw": 1, "frame": [10, 10], "ops": [["rect", 0, 0, 5, 5], ["fill", "ink"]]}"#;
        let RenderOutcome::Done { svg } = render_program_outcome(src, "p") else {
            panic!("expected svg");
        };
        assert!(svg.contains("class=\"tgf-ink\""));
    }

    #[test]
    fn reports_every_error() {
        let src = r#"{"tugdraw": 1, "frame": [10, 10], "ops": [["paint"], ["end"]]}"#;
        let RenderOutcome::Invalid { errors } = render_program_outcome(src, "p") else {
            panic!("expected errors");
        };
        assert_eq!(errors.iter().map(|e| e.op).collect::<Vec<_>>(), vec![Some(0), Some(1)]);
    }

    const BAR: &str = r#"{"tugchart": 1, "form": "bar", "title": "T", "categories": ["a"], "series": [{"name": "n", "values": [3]}]}"#;

    #[test]
    fn compile_round_speaks_the_protocol() {
        let opts = r#"{"width": 400, "id_prefix": "c1", "motion": true, "layers": "chart"}"#;
        let Round::Measure { texts } = compile_round_outcome(BAR, opts, "{}") else {
            panic!("round 1 should ask");
        };
        assert!(texts.contains(&("title".to_string(), "T".to_string())));
        let table: Vec<String> = texts
            .iter()
            .map(|(role, text)| format!("\"{role}\\u0000{text}\": {{\"w\": 1, \"a\": 1, \"d\": 1}}"))
            .collect();
        let table = format!("{{{}}}", table.join(", "));
        let Round::Done(out) = compile_round_outcome(BAR, opts, &table) else {
            panic!("round 2 should finish");
        };
        assert_eq!(out.width, 400.0);
        assert_eq!(out.find_text, "Tna3");
        assert!(out.svg.starts_with("<svg "));
    }

    #[test]
    fn bad_opts_and_tables_are_invalid() {
        assert!(matches!(compile_round_outcome(BAR, "[]", "{}"), Round::Invalid { .. }));
        assert!(matches!(compile_round_outcome(BAR, "{}", "[]"), Round::Invalid { .. }));
    }

    #[test]
    fn validate_and_find_text_take_the_door() {
        let draw = r#"{"tugdraw": 1, "frame": [10, 10], "ops": []}"#;
        assert_eq!(validate_outcome(BAR, "chart"), ValidateOutcome::Valid);
        assert!(matches!(validate_outcome(draw, "chart"), ValidateOutcome::Invalid { .. }));
        assert_eq!(validate_outcome(draw, "any"), ValidateOutcome::Valid);
        assert_eq!(find_text_of(BAR, "chart"), "Tna3");
        assert_eq!(find_text_of(draw, "any"), "");
        assert_eq!(find_text_of(draw, "chart"), draw);
    }
}
