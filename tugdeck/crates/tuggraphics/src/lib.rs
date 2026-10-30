//! Tug's graphics language.
//!
//! [`draw`] is layer 0: a JSON drawing language and its SVG renderer.
//! [`chart`] is layer 1: chart specs, compiled through closed forms into
//! layer 0 programs.
//! [`measure`] is the contract text layout is measured against. Every
//! number this crate writes goes through its own formatter, never through
//! `f64`'s `Display` or `serde_json`'s number printing, so the page's WASM
//! build and a native build resolved from a different lockfile write the
//! same bytes.

pub mod chart;
pub mod draw;
#[cfg(feature = "font")]
pub mod face;
pub mod measure;
mod num;

pub use chart::{
    compile_round, compile_with, find_text, validate, ChartError, CompileOpts, Compiled, Layers,
    Round,
};
pub use draw::{
    parse_program, render_program, render_svg, DrawError, Palette, Program, RenderOpts,
};
#[cfg(feature = "font")]
pub use face::FaceMeasurer;
pub use measure::{
    fit_text, run_rounds, Fit, FixedMetrics, Measure, MeasureTable, Metrics, RoundOutcome, TypeRole,
};
