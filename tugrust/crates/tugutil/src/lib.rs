//! The `tugutil` package's library half — the two pieces a second binary needs.
//!
//! `tugutil` is a CLI, and almost all of it is private to `main.rs`. Two things
//! are not: the `TUG-FILE-RECEIPT` machinery, which `tugedit` must emit
//! identically to `tugutil file edit` because the relay reads one grammar, and
//! the edit verb itself, which both `tugutil file edit` and the `tugedit`
//! binary run. Everything else stays in the binary's private module tree.

pub mod edit;
pub mod receipt;
