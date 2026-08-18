//! `tugdash-core` — the dash engine, extracted from the `tugutil` grab bag.
//!
//! A dash *is* a git branch (`tugdash/<name>`) plus a worktree; its lifecycle
//! and status derive from git, not a database. This crate holds the shared
//! helpers ([`dash`]) and the verb orchestration ([`ops`]) — a typed library
//! API that never prints. The `tugdash` CLI and the Changeset card (via
//! tugcast) are its two front ends.

/// Dash helpers — name validation, default-branch detection, the append-only
/// visibility log, and the stdin round-metadata shape.
pub mod dash;

/// Dash verb orchestration — `create` / `commit` / `join` / `discard` /
/// `list` / `show`, each returning a typed outcome.
pub mod ops;

/// Base-motion replay — keeping a live dash current with a base that moved:
/// the preconditions, the branch move, and the record of where rounds went.
pub mod replay;

/// The join conflict resolution ladder ([P31]): replay probe, rerere, per-file
/// re-merge / structured-merge driver / AI seam, and the candidate builder.
pub mod resolve;

pub use dash::{
    DashDeclaration, DashDeclarations, DashRoundMeta, MarkStage, StepPhase, append_dash_log,
    detect_default_branch, is_terminal, read_declarations, split_log_line, validate_dash_name,
};
pub use ops::{
    BaseDirtPath, CommitOutcome, CreateOutcome, DashDetail, DashDetailFile, DashDraftKey,
    DashListItem, DashStatus, DiscardOutcome, JoinBlocker, JoinOptions, JoinOutcome, JoinStrategy,
    MarkOutcome, RoundItem, ShowOutcome, StepOutcome, commit, create, dash_detail_entries_in,
    dash_draft_key, dash_plan_path, derive_stage, discard, discard_in, join, join_in,
    join_in_flight, join_preflight_in, list, mark, show, status, status_in, step_done, step_start,
};
pub use replay::{ReplayOutcome, ReplayedRounds, replay, replay_onto};
pub use resolve::{
    FileMergeRequest, FileMerger, FileResolution, JoinShape, ResolveOutcome, ResolvedBy,
    resolve_conflicts, resolve_conflicts_cwd, resolve_intent,
};
