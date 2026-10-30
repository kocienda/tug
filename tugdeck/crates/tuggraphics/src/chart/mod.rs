//! Layer 1: charts.
//!
//! A chart spec (`{"tugchart": 1, "form": …}`) names a form and its data;
//! a form lays it out as a layer 0 program, drawn by the same renderer.
//! Text is laid out against exact measurements through the protocol in
//! [`crate::measure`]: natively [`compile_with`] runs it to the end
//! against any [`Measure`], and across the WASM boundary
//! [`compile_round`] runs one round against a table the deck measured.
//!
//! A door that takes a tool's output may hand the compiler a layer 0
//! program too ([`Layers::Any`]); it compiles in one round to its SVG
//! with an empty table, since a drawing has no findable text.

mod build;
pub mod format;
mod forms;
pub mod spec;
pub mod table;
pub mod ticks;

use serde::Serialize;
use serde_json::Value;

use crate::draw::{render_svg, Item, Palette, Program, RenderOpts};
use crate::measure::{measure_round, run_rounds, Measure, MeasureTable, RoundOutcome};

pub use format::Format;
pub use spec::{validate, ChartError, Layers, Source, Spec, LAYER0_IN_FENCE, MAX_SERIES};
pub use table::ChartTable;

/// How to compile: the width available, the prefix for the SVG's ids,
/// whether entrances are written at all, which layers the door takes, and
/// for a standalone file the palette its one `<style>` resolves to.
#[derive(Clone, Debug, PartialEq)]
pub struct CompileOpts {
    /// The width the chart may take; `None` takes the spec's or the form's.
    pub width: Option<f64>,
    pub id_prefix: String,
    pub motion: bool,
    pub layers: Layers,
    /// `Some` for a standalone render: the SVG carries a `<style>` resolving
    /// its classes to this palette. The deck passes `None` and styles the
    /// classes itself, so a theme switch restyles a chart in place.
    pub palette: Option<Palette>,
    /// Whether the figure draws its title. The deck passes `false`: its block
    /// header already shows the table's caption, and a title drawn in both
    /// reads twice. A file keeps it, having no other place for it.
    pub figure_title: bool,
}

impl Default for CompileOpts {
    fn default() -> Self {
        CompileOpts {
            width: None,
            id_prefix: String::new(),
            motion: true,
            layers: Layers::Chart,
            palette: None,
            figure_title: true,
        }
    }
}

impl CompileOpts {
    /// Reads the protocol's opts: `{"width", "id_prefix", "motion",
    /// "layers", "figure_title"}`, each optional.
    pub fn from_json(source: &str) -> Result<CompileOpts, ChartError> {
        let bad = |message: &str| ChartError {
            path: String::new(),
            message: format!("compile options: {message}"),
        };
        let value: Value =
            serde_json::from_str(source).map_err(|e| bad(&format!("not JSON: {e}")))?;
        let obj = value.as_object().ok_or_else(|| bad("an object"))?;
        let mut opts = CompileOpts::default();
        if let Some(w) = obj.get("width").filter(|v| !v.is_null()) {
            opts.width = Some(
                w.as_f64()
                    .filter(|w| *w > 0.0)
                    .ok_or_else(|| bad("width is a positive number"))?,
            );
        }
        if let Some(p) = obj.get("id_prefix") {
            opts.id_prefix = p
                .as_str()
                .ok_or_else(|| bad("id_prefix is a string"))?
                .to_string();
        }
        if let Some(m) = obj.get("motion") {
            opts.motion = m.as_bool().ok_or_else(|| bad("motion is a boolean"))?;
        }
        if let Some(l) = obj.get("layers") {
            opts.layers = l
                .as_str()
                .and_then(Layers::parse)
                .ok_or_else(|| bad("layers is \"chart\" or \"any\""))?;
        }
        if let Some(t) = obj.get("figure_title") {
            opts.figure_title = t
                .as_bool()
                .ok_or_else(|| bad("figure_title is a boolean"))?;
        }
        Ok(opts)
    }
}

/// A finished compile.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Compiled {
    pub svg: String,
    pub table: ChartTable,
    pub find_text: String,
    pub width: f64,
    pub height: f64,
}

/// One round of the measure protocol.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Round {
    /// The `(role, text)` pairs still to measure.
    Measure {
        texts: Vec<(String, String)>,
    },
    Done(Compiled),
    Invalid {
        errors: Vec<ChartError>,
    },
}

/// The frame a spec is laid out in: its own or its form's width, narrowed
/// to what the door has room for, never below the narrowest frame.
fn frame(spec: &Spec, width: Option<f64>) -> (f64, f64) {
    let (dw, dh) = spec.default_size();
    let w = spec.w.unwrap_or(dw);
    let w = width.map_or(w, |avail| w.min(avail)).max(spec::MIN_W);
    (w, spec.h.unwrap_or(dh))
}

fn layout(spec: &Spec, opts: &CompileOpts, m: &dyn Measure) -> Program {
    if !opts.figure_title {
        // A copy, as `histogram::layout` makes for its counts: no form learns
        // of the option, and `finish` still reads the title for the table.
        let untitled = Spec {
            title: None,
            ..spec.clone()
        };
        let (w, h) = frame(&untitled, opts.width);
        return forms::layout(&untitled, w, h, opts.motion && spec.motion, m);
    }
    let (w, h) = frame(spec, opts.width);
    forms::layout(spec, w, h, opts.motion && spec.motion, m)
}

fn finish(spec: &Spec, program: &Program, opts: &CompileOpts) -> Compiled {
    let table = table::table(spec);
    Compiled {
        svg: render(program, opts),
        find_text: table.find_text(),
        table,
        width: program.frame.0,
        height: program.frame.1,
    }
}

fn render(program: &Program, opts: &CompileOpts) -> String {
    render_svg(
        program,
        &RenderOpts {
            id_prefix: &opts.id_prefix,
            standalone: opts.palette.as_ref(),
        },
    )
}

/// A layer 0 program as a finished compile: its SVG, no table, and no
/// findable text. Entrances are dropped when the door writes none.
fn drawing(mut program: Program, opts: &CompileOpts) -> Compiled {
    if !opts.motion {
        for item in &mut program.items {
            match item {
                Item::Paint(p) => p.motion = None,
                Item::Text(t) => t.motion = None,
                Item::Group(g) => g.motion = None,
                Item::End => {}
                Item::Hit(_) => {}
            }
        }
    }
    Compiled {
        svg: render(&program, opts),
        table: ChartTable::default(),
        find_text: String::new(),
        width: program.frame.0,
        height: program.frame.1,
    }
}

/// Compiles natively, running the measure protocol to completion against
/// `m` with the same rounds and limit the deck's loop has.
pub fn compile_with(
    source: &str,
    opts: &CompileOpts,
    m: &dyn Measure,
) -> Result<Compiled, Vec<ChartError>> {
    match validate(source, opts.layers)? {
        Source::Draw(program) => Ok(drawing(program, opts)),
        Source::Chart(spec) => {
            let program = run_rounds(m, |m| layout(&spec, opts, m)).map_err(|message| {
                vec![ChartError {
                    path: String::new(),
                    message,
                }]
            })?;
            Ok(finish(&spec, &program, opts))
        }
    }
}

/// One round against a measured table: the pairs the table lacks, or the
/// finished chart. The caller counts the rounds.
pub fn compile_round(source: &str, opts: &CompileOpts, table: &MeasureTable) -> Round {
    match validate(source, opts.layers) {
        Err(errors) => Round::Invalid { errors },
        Ok(Source::Draw(program)) => Round::Done(drawing(program, opts)),
        Ok(Source::Chart(spec)) => match measure_round(table, |m| layout(&spec, opts, m)) {
            RoundOutcome::Done(program) => Round::Done(finish(&spec, &program, opts)),
            RoundOutcome::Measure(texts) => Round::Measure {
                texts: texts
                    .into_iter()
                    .map(|(r, t)| (r.name().to_string(), t))
                    .collect(),
            },
        },
    }
}

/// The text transcript Find counts for a source: a chart's table text, a
/// drawing's nothing, and an invalid source's own text, which is what
/// its error surface shows.
pub fn find_text(source: &str, layers: Layers) -> String {
    match validate(source, layers) {
        Ok(Source::Chart(spec)) => table::table(&spec).find_text(),
        Ok(Source::Draw(_)) => String::new(),
        Err(_) => source.to_string(),
    }
}
