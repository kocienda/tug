//! The well-known charts of a project.
//!
//! A recipe answers one question about a project by reading its commits, its
//! test ledgers, its arc record or its session ledger, and hands back a
//! one-line summary and a `tugchart` spec. The catalog is one array, and
//! `tugtool chart`, its list
//! and tugcast's routes are all built from it, so a recipe has one name and
//! one set of arguments wherever it is reached from.
//!
//! This crate builds specs and draws nothing: whoever prints or renders one
//! validates it. `tugtool` and `tugcast` both link it, and neither links the
//! other.

mod arcs;
pub mod catalog;
pub mod commits;
pub mod context;
mod gaps;
mod models;
pub mod tests;

pub use catalog::{
    Arg, ArgKind, RECIPES, Recipe, args_from_matches, catalog_json, clap_command, find,
};
pub use context::{RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, git_gate};
