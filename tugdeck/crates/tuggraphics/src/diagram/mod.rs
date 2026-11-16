//! Layer 1: diagrams of code.
//!
//! A diagram spec (`{"tugdiagram": 1, "form": …}`) names one of a closed
//! set of forms and gives names, relations and order; the form gives every
//! coordinate, and lays the figure out as a layer 0 program drawn by the
//! same renderer as a chart. It is a sibling of the chart spec rather than
//! a chart form because none of a chart's fields mean anything here.
//!
//! A diagram that parses always draws. What would make a figure hard to
//! read — too wide, too full, a name too long, edges that cross — is a
//! warning beside the finished figure, never a reason to withhold it: the
//! reader gets the figure, and whoever wrote the spec gets told what to
//! split or shorten ([`budget`], [`wrap`], [`MAX_W`]).
//!
//! Each numbered mark — a key — has a row in the diagram's keyed table:
//! the number, the mark's name, what it does and where it is in the code.
//! The table is the diagram's table alternative and what Find counts.
//!
//! Text is laid out against exact measurements through the same two-request
//! protocol a chart's is ([`crate::measure`]); names stay on one line and
//! secondary text wraps to two, each cut with an ellipsis past its cap
//! ([`wrap`]).

pub mod budget;
mod flow;
mod layers;
mod pen;
mod sequence;
pub mod spec;
mod stack;
mod wrap;

use serde_json::{Map, Value};

use crate::chart::{ChartError, ChartTable};
use crate::draw::Program;
use crate::measure::Measure;

pub use spec::{validate_object, Spec};

/// The widest a figure should lay itself out. Past it the figure is drawn
/// at its own width, for the door to scale or scroll, with a warning that
/// says to split it. Set so the widest reference subject, a four-column
/// flow whose turning edges need three lanes in one gap, fits in the real
/// faces with a little to spare.
pub const MAX_W: f64 = 1040.0;

/// A laid-out figure: its program, how many times its edges cross, and the
/// warnings its measured text and its size raised.
#[derive(Clone, Debug, PartialEq)]
pub struct Laid {
    pub program: Program,
    pub crossings: usize,
    pub warnings: Vec<ChartError>,
}

/// Validates a diagram spec read from JSON.
pub fn validate(source: &str) -> Result<Spec, Vec<ChartError>> {
    let value: Value =
        serde_json::from_str(source).map_err(|e| vec![spec::err("", format!("not JSON: {e}"))])?;
    let Value::Object(obj) = &value else {
        return Err(vec![spec::err("", "a diagram spec is a JSON object")]);
    };
    validate_object(obj)
}

/// Whether a parsed JSON object is a diagram spec rather than a chart or a
/// drawing.
pub fn is_diagram(obj: &Map<String, Value>) -> bool {
    obj.contains_key("tugdiagram")
}

/// Lays `spec` out against `m`, with its title drawn in the figure when
/// `figure_title`. The figure takes its natural size: a diagram is never
/// narrowed to a door, only warned of past [`MAX_W`].
pub fn layout(spec: &Spec, figure_title: bool, animate: bool, m: &dyn Measure) -> Laid {
    let title = figure_title.then_some(spec.title.as_str());
    let mut laid = match &spec.form {
        spec::Form::Flow(f) => flow::layout(f, title, animate && spec.motion, m),
        spec::Form::Sequence(s) => sequence::layout(s, title, animate && spec.motion, m),
        spec::Form::Layers(l) => layers::layout(l, title, animate && spec.motion, m),
        spec::Form::Stack(s) => stack::layout(s, title, animate && spec.motion, m),
    };
    let w = laid.program.frame.0;
    if laid.crossings > budget::MAX_CROSSINGS {
        laid.warnings.push(spec::err(
            "/edges",
            format!(
                "this {}'s edges cross {} times; a diagram reads well with at most {}, so reorder its boxes or split it into two figures",
                spec.form_name(),
                laid.crossings,
                budget::MAX_CROSSINGS
            ),
        ));
    }
    if w > MAX_W {
        laid.warnings.push(spec::err(
            "",
            format!(
                "this {} is {w} px wide, past the {MAX_W} px a diagram reads well at; split it into two figures",
                spec.form_name()
            ),
        ));
    }
    laid
}

/// The keyed table: one row per key, in key order. A figure with no key
/// has no table, only its caption, so a door draws no empty table.
pub fn table(spec: &Spec) -> ChartTable {
    let rows: Vec<Vec<String>> = spec
        .keyed()
        .into_iter()
        .map(|r| vec![r.n.to_string(), r.name, r.what, r.r#where])
        .collect();
    let head = if rows.is_empty() {
        Vec::new()
    } else {
        ["#", "Step", "What it does", "Where it is"]
            .map(String::from)
            .to_vec()
    };
    ChartTable {
        caption: spec.title.clone(),
        head,
        rows,
    }
}
