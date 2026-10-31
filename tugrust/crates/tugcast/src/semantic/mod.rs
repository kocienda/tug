//! The on-device semantic index: everything of it that touches a clock, a
//! process or a database. `tugsem_core` decides the passages and the ranks, and
//! this module holds the `semantic.db` ledger, supervises `tugembed`, and feeds
//! sources through them.
//!
//! The index is an aid and never a dependency. A missing helper leaves it
//! lexical, and an unopenable ledger leaves tugcast without it, and neither one
//! fails anything else.

mod coverage;
mod documents;
mod embedder;
mod index;
mod ingest;
mod observer;
mod search;
mod transcript;

pub(crate) use coverage::coverage_channel;
pub(crate) use documents::DocumentWatch;
#[cfg(test)]
pub(crate) use embedder::fake;
pub(crate) use embedder::{EmbedderClient, HelperSpawner};
pub(crate) use index::SemanticIndex;
#[cfg(test)]
pub(crate) use ingest::Source;
pub(crate) use ingest::{
    DOCUMENT_KIND, FACT_KIND, HELP_KIND, INDEX_SETTLE, IndexStreams, Indexer, POST_KIND,
    SESSION_KINDS, TRANSCRIPT_KIND, index_history_now, remove_session_sources, run_index,
};
pub(crate) use search::{PassageHit, RankedPassages, SEARCH_SPAN_MAX_BYTES, SemanticSearch};
