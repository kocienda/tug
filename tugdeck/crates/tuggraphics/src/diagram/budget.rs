//! The budgets that say a figure is too full to read.
//!
//! Each form carries a ceiling on what it should hold — boxes, rows,
//! edges, actors, messages, layers, cells — and a figure over one is drawn
//! all the same, with a warning at the part that overflowed saying to
//! split the figure in two. Names are capped by their measured width
//! ([`super::wrap`]) and the whole figure by its width ([`super::MAX_W`]);
//! edge crossings are counted at layout ([`MAX_CROSSINGS`]). The numbers
//! are set so the reference subjects pass with room, and a figure past
//! them is one a reader would have to work at. None of them withholds a
//! figure: a reader is better served by a crowded figure than by none, and
//! the warning is how whoever wrote the spec learns to split it.

use crate::chart::ChartError;

use super::spec::{err, Form, Move, Spec};

/// The most columns, boxes, rows in one box, rows in all, and edges a
/// `flow` should hold.
pub const FLOW_COLUMNS: usize = 5;
pub const FLOW_BOXES: usize = 10;
pub const FLOW_BOX_ROWS: usize = 6;
pub const FLOW_ROWS: usize = 18;
pub const FLOW_EDGES: usize = 10;
/// The most actors and messages a `sequence` may hold.
pub const SEQUENCE_ACTORS: usize = 6;
pub const SEQUENCE_MESSAGES: usize = 16;
/// The most layers a `layers` figure may hold, and cells in one layer.
pub const LAYERS_LAYERS: usize = 7;
pub const LAYERS_CELLS: usize = 5;
/// The most layers, rows in one layer, cells in one row, cells in all,
/// blocks above or beneath, and bars across a `stack` may hold.
pub const STACK_LAYERS: usize = 7;
pub const STACK_ROWS: usize = 3;
pub const STACK_ROW_CELLS: usize = 6;
pub const STACK_CELLS: usize = 24;
pub const STACK_BLOCKS: usize = 4;
pub const STACK_ACROSS: usize = 4;
/// The most states on a `states` figure's main line, side states beneath
/// one state, transitions, and lanes over the top.
pub const STATES_MAIN: usize = 6;
pub const STATES_UNDER: usize = 1;
pub const STATES_TRANSITIONS: usize = 12;
pub const STATES_LANES: usize = 3;
/// The most levels and nodes a `tree` should hold.
pub const TREE_LEVELS: usize = 4;
pub const TREE_NODES: usize = 20;
/// The most times a figure's edges may cross. One is sometimes the price
/// of an order that reads well; two means the boxes want reordering.
pub const MAX_CROSSINGS: usize = 1;

/// Each budget `spec` is over, as a warning at the part that overflowed.
pub(crate) fn check(spec: &Spec) -> Vec<ChartError> {
    let form = spec.form_name();
    let mut errors = Vec::new();
    let mut over = |path: String, what: &str, have: usize, most: usize| {
        if have > most {
            errors.push(err(
                path,
                format!(
                    "this {form} has {have} {what}; it reads well with at most {most}, so split it into two figures"
                ),
            ));
        }
    };
    match &spec.form {
        Form::Flow(f) => {
            over("/columns".into(), "columns", f.columns.len(), FLOW_COLUMNS);
            let boxes = f.columns.iter().map(Vec::len).sum();
            over("/columns".into(), "boxes", boxes, FLOW_BOXES);
            let rows = f.columns.iter().flatten().map(|n| n.rows.len()).sum();
            over("/columns".into(), "rows", rows, FLOW_ROWS);
            for (c, col) in f.columns.iter().enumerate() {
                for (k, node) in col.iter().enumerate() {
                    over(
                        format!("/columns/{c}/{k}/rows"),
                        "rows in one box",
                        node.rows.len(),
                        FLOW_BOX_ROWS,
                    );
                }
            }
            over("/edges".into(), "edges", f.edges.len(), FLOW_EDGES);
        }
        Form::Sequence(s) => {
            over("/actors".into(), "actors", s.actors.len(), SEQUENCE_ACTORS);
            over(
                "/messages".into(),
                "messages",
                s.messages.len(),
                SEQUENCE_MESSAGES,
            );
        }
        Form::Layers(l) => {
            over("/layers".into(), "layers", l.layers.len(), LAYERS_LAYERS);
            for (i, layer) in l.layers.iter().enumerate() {
                over(
                    format!("/layers/{i}/cells"),
                    "cells in one layer",
                    layer.cells.len(),
                    LAYERS_CELLS,
                );
            }
        }
        Form::Stack(s) => {
            over("/layers".into(), "layers", s.layers.len(), STACK_LAYERS);
            let cells = s.layers.iter().flat_map(|l| &l.rows).map(Vec::len).sum();
            over("/layers".into(), "cells", cells, STACK_CELLS);
            for (i, layer) in s.layers.iter().enumerate() {
                over(
                    format!("/layers/{i}/rows"),
                    "rows in one layer",
                    layer.rows.len(),
                    STACK_ROWS,
                );
                for (r, row) in layer.rows.iter().enumerate() {
                    over(
                        format!("/layers/{i}/rows/{r}"),
                        "cells in one row",
                        row.len(),
                        STACK_ROW_CELLS,
                    );
                }
            }
            over("/above".into(), "blocks above", s.above.len(), STACK_BLOCKS);
            over(
                "/below".into(),
                "blocks beneath",
                s.below.len(),
                STACK_BLOCKS,
            );
            if let Some(a) = &s.across {
                over(
                    "/across/names".into(),
                    "bars across",
                    a.names.len(),
                    STACK_ACROSS,
                );
            }
        }
        Form::States(s) => {
            let main = s.main();
            over(
                "/states".into(),
                "states on the main line",
                main.len(),
                STATES_MAIN,
            );
            for m in main {
                let under = s.states.iter().filter(|st| st.under == Some(m)).count();
                over(
                    format!("/states/{m}"),
                    "states beneath one state",
                    under,
                    STATES_UNDER,
                );
            }
            over(
                "/transitions".into(),
                "transitions",
                s.transitions.len(),
                STATES_TRANSITIONS,
            );
            let lanes = s.moves().iter().filter(|m| **m == Move::Over).count();
            over(
                "/transitions".into(),
                "transitions over the top",
                lanes,
                STATES_LANES,
            );
        }
        Form::Tree(t) => {
            over("/root".into(), "levels", t.root.depth(), TREE_LEVELS);
            over("/root".into(), "nodes", t.root.walk().len(), TREE_NODES);
        }
    }
    errors
}
