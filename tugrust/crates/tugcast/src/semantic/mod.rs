//! The on-device semantic index: everything of it that touches a clock, a
//! process or a database. `tugsem_core` decides the passages and the ranks, and
//! this module holds the `semantic.db` ledger, supervises `tugembed`, and feeds
//! sources through them.
//!
//! The index is an aid and never a dependency. A missing helper leaves it
//! lexical, and an unopenable ledger leaves tugcast without it, and neither one
//! fails anything else.

mod embedder;
mod index;
mod ingest;
mod search;

#[cfg(test)]
pub(crate) use embedder::fake;
pub(crate) use embedder::{EmbedderClient, HelperSpawner};
pub(crate) use index::SemanticIndex;
pub(crate) use ingest::{
    HELP_INDEX_SETTLE, HELP_KIND, Indexer, remove_session_sources, run_help_index,
};
pub(crate) use search::SemanticSearch;
