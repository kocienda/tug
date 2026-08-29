//! `tugutil-core` — core library for tugutil.
//!
//! Provides the foundational logic the `tugutil` binary builds on: config,
//! plan resolution, git/worktree helpers, the dash flow, and per-project
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

/// The standing-wire ledger, and the predicates a wire's trigger compiles to.
pub mod wire_ledger;
pub mod wire_predicate;

// Re-exports — exactly the surface consumed by the `tugutil` binary.
pub use config::{Config, find_project_root};
pub use error::TugError;
pub use paths::project_state_dir;
pub use plan::{
    Diagnostic, NotAPlan, PlanDoc, ReviewRound, ReviewState, Severity, StampError, content_stamp,
    has_errors, lint, parse, review_state, set_review_stamp,
};
pub use worktree::{REPO_UNIVERSE_ENV, find_repo_root, find_repo_root_from, sanitize_branch_name};
