//! `tugedit-core` — the edit-program language.
//!
//! An edit program is a small program that edits text files: literal and regex
//! substitution with a count guard, unified-diff hunks, line-addressed
//! insert/delete/move, and whole-file create/write, grouped into blocks that
//! name the files they act on. The language and its semantics are specified
//! in `tuglaws/tugedit.md`; this crate is the interpreter's language half.
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

impl ParseError {
    /// The refusal as a caller reads it: the `line:col: message` header, then
    /// the program's own line with a caret under the column.
    ///
    /// A program arrives on stdin as a heredoc, so there is no file the caller
    /// can open at line 15 — a bare position is a line number for a document
    /// that exists only in the message that sent it. The excerpt is how the
    /// caller sees which of two `patch` ops the parser is talking about.
    pub fn report(&self, source: &str) -> String {
        let Some(text) = source.lines().nth(self.line.saturating_sub(1)) else {
            return self.to_string();
        };
        let before = self.col.saturating_sub(1);
        let mut caret: String = text
            .chars()
            .take(before)
            .map(|ch| if ch == '\t' { '\t' } else { ' ' })
            .collect();
        // A column past the line's last byte — an error reported at end of
        // line — pads out to it.
        for _ in text.chars().count()..before {
            caret.push(' ');
        }
        format!("{self}\n   | {text}\n   | {caret}^")
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.col, self.message)
    }
}

impl std::error::Error for ParseError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_shows_the_program_line_it_names() {
        // The live shape: two `patch` ops, the second a context-only hunk. The
        // position alone does not say which of the two refused.
        let source = concat!(
            "file a.ts\n",
            "  patch <<\n",
            "-was\n",
            "+is\n",
            ">>\n",
            "  patch <<\n",
            " function f(): void {\n",
            ">>\n",
        );
        let err = parse(source).expect_err("program is refused");
        assert_eq!((err.line, err.col), (7, 1));
        assert_eq!(
            err.report(source),
            concat!(
                "7:1: this hunk has no `-` or `+` line, so it would change nothing\n",
                "   |  function f(): void {\n",
                "   | ^",
            )
        );
    }

    #[test]
    fn a_caret_past_the_line_pads_out_to_its_column() {
        let err = ParseError {
            line: 1,
            col: 8,
            message: "expected a `<<` body".into(),
        };
        assert_eq!(
            err.report("  patch\n"),
            concat!(
                "1:8: expected a `<<` body\n",
                "   |   patch\n",
                "   |        ^",
            )
        );
    }

    #[test]
    fn a_position_past_the_last_line_reports_the_header_alone() {
        let err = ParseError {
            line: 9,
            col: 1,
            message: "unterminated body".into(),
        };
        assert_eq!(err.report("file a.txt\n"), "9:1: unterminated body");
    }
}
