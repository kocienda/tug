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

/// Plan resolution logic
pub mod resolve;

/// Per-project runtime-state directory resolution
pub mod paths;

/// Devise-skeleton plan parsing and linting
pub mod plan;

/// The app-test results ledger
pub mod apptest_ledger;

// Re-exports — exactly the surface consumed by the `tugutil` binary.
pub use config::{Config, find_project_root, find_tugplans, tugplan_name_from_path};
pub use error::TugError;
pub use paths::project_state_dir;
pub use plan::{
    Diagnostic, NotAPlan, PlanDoc, ReviewRound, ReviewState, Severity, StampError, content_stamp,
    has_errors, lint, parse, review_state, set_review_stamp,
};
pub use resolve::{ResolveResult, ResolveStage, resolve_plan};
pub use worktree::{REPO_UNIVERSE_ENV, find_repo_root, find_repo_root_from, sanitize_branch_name};
