//! `tugtool-core` — core library for tugtool.
//!
//! Provides the foundational logic the `tugtool` binary builds on: config,
//! plan resolution, git/worktree helpers, the arc flow, and per-project
//! runtime-state paths.

/// Core error types for tug operations
pub mod error;

/// Configuration handling
pub mod config;

/// Timestamp utilities
pub mod session;

/// Worktree management for plan implementations
pub mod worktree;

/// Per-project runtime-state directory resolution
pub mod paths;

/// Devise-skeleton plan parsing and linting
pub mod plan;

/// The app-test results ledger
pub mod apptest_ledger;

/// The tripwire ledger, and the predicates a tripwire's trigger compiles to.
pub mod tripwire_ledger;
pub mod tripwire_predicate;

/// The one roster projection over the tripwire ledger — what the card, the
/// `TRIPWIRES` feed and `tugtool tripwire list` all read.
pub mod tripwire_roster;

// Re-exports — exactly the surface consumed by the `tugtool` binary.
pub use config::{Config, find_project_root};
pub use error::TugError;
pub use paths::{arc_log_path, project_state_dir};
pub use plan::{
    Diagnostic, NotAPlan, PlanDoc, ReviewRound, ReviewState, Severity, StampError, content_stamp,
    has_errors, lint, parse, review_state, set_review_stamp,
};
pub use worktree::{REPO_UNIVERSE_ENV, find_repo_root, find_repo_root_from, sanitize_branch_name};
