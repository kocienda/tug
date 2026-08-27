//! `tugrev-core` — the `.rev` edit language.
//!
//! A rev is a small program that edits text files: literal and regex
//! substitution with a count guard, unified-diff hunks, line-addressed
//! insert/delete/move, and whole-file create/write, grouped into blocks that
//! name the files they act on. The language and its semantics are specified
//! in `tuglaws/tugrev.md`; this crate is the interpreter's language half.
//!
//! The crate performs **no I/O**. It reads through a [`FileSource`] and
//! returns the content each file would have, so every semantic — addresses,
//! guards, overlap, dedent, line endings — is provable against in-memory
//! content, and write policy stays where it belongs: in the CLI that owns the
//! receipt.

mod apply;
mod diff;
mod lex;
mod parse;
mod resolve;

pub use apply::{FileOutcome, resolve_and_apply};
pub use diff::unified_diff;
pub use parse::{
    Addr, Block, Count, DeleteTarget, Hunk, Op, OpKind, Program, Range, RegexLit, Side, Text, parse,
};
pub use resolve::{
    Edit, FileSource, OutcomeKind, ResolveErrors, ResolveFailure, ResolvedFile, resolve,
};

/// Where a program failed to parse: 1-based line and column, as an editor
/// counts them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub line: usize,
    pub col: usize,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.col, self.message)
    }
}

impl std::error::Error for ParseError {}
