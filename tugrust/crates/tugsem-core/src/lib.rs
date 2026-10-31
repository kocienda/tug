//! The semantic search facility, with no IO.
//!
//! A caller submits a source and asks a question, and this crate decides the
//! passages, ranks them, and hands back readable spans with refs. Whatever
//! touches a clock, a process or a database lives in the caller: this crate
//! never spawns the embedder or opens the ledger, it only says what to embed,
//! what to store, and how the answers rank.
//!
//! A source goes through [`chunk()`], and each passage's
//! [`embedding_text`](Passage::embedding_text) goes to the embedder. A question
//! is ranked twice: BM25 over the store's text shadow, and a [`VectorArena`] scan
//! over its vectors, stored [`quantize`]d. [`fuse`] combines the two rank lists, and
//! [`reassemble`] turns the winning passages back into the spans a person reads.

mod arena;
mod chunk;
mod markdown;
mod reassemble;
mod reduce;
mod score;
mod store;

pub use arena::{ArenaRow, VectorArena, dequantize, quantize};
pub use chunk::{CHUNKING_VERSION, MAX_TOKENS, Passage, chunk, estimate_tokens};
pub use markdown::{Section, markdown_sections};
pub use reassemble::{Hit, Span, reassemble};
pub use reduce::{ReducedTool, lexical_spans, reduce_tool_result};
pub use score::{Fused, Scored, TopK, cosine, fuse};
pub use store::{CREATE_SCHEMA, MIGRATIONS, SCHEMA_VERSION, decode_vector, encode_vector};
