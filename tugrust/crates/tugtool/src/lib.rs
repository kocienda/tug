//! The `tugtool` package's library half — the two pieces a second binary needs.
//!
//! `tugtool` is a CLI, and almost all of it is private to `main.rs`. What is
//! not: the `TUG-FILE-RECEIPT` machinery and its `TUG-EDIT-ERROR` counterpart,
//! which `tugedit` must emit identically to `tugtool file edit` because the
//! relay reads one grammar each, and the edit verb itself, which both
//! spellings run. Everything else stays in the binary's private module tree.

pub mod edit;
pub mod edit_error_marker;
pub mod receipt;
