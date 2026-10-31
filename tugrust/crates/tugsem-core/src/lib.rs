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
//! is ranked twice: BM25 over the store's text shadow, and [`rank_by_similarity`]
//! over its vectors. [`fuse`] combines the two rank lists, and [`reassemble`]
//! turns the winning passages back into the spans a person reads.

mod chunk;
mod reassemble;
mod score;
mod store;

pub use chunk::{CHUNKING_VERSION, MAX_TOKENS, Passage, chunk, estimate_tokens};
pub use reassemble::{Hit, Span, reassemble};
pub use score::{Candidate, Fused, Query, Scored, cosine, fuse, rank_by_similarity};
pub use store::{CREATE_SCHEMA, MIGRATIONS, SCHEMA_VERSION, decode_vector, encode_vector};
