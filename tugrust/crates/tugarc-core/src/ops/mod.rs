//! Arc orchestration — the `tugarc` library API.
//!
//! Lightweight, worktree-isolated work units driven entirely on git: an arc
//! *is* a branch (`tugarc/<name>`) plus a worktree
//! (`.tug/worktrees/<name>`; legacy arcs at `.tugtree/tugdash__<name>` migrate
//! on first touch). Its base branch and description live in git
//! config (`branch.tugarc/<name>.{tugbase,description}`); its activity is
//! recorded in the per-project append-only arc log. There is no database.
//!
//! Each verb (`create` / `commit` / `join` / `discard` / `list` / `show`)
//! returns a typed outcome and never prints — the `tugarc` CLI (and the
//! Changeset card, via tugcast) own presentation. Each verb takes its repo
//! root as an argument; the cwd-relative doors the CLI calls live in `cwd`.

mod commit;
mod create;
mod cwd;
mod discard;
mod documents;
mod git;
mod identity;
mod join;
mod listing;
mod show;
mod steps;
// Test-only by its own `#![cfg(test)]`, which the workspace's source scans read.
mod test_support;

pub use commit::*;
pub use create::*;
pub use cwd::*;
pub use discard::*;
pub use documents::*;
pub use git::*;
pub use identity::*;
pub use join::*;
pub(crate) use listing::*;
pub use show::*;
pub use steps::*;
