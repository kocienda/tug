//! `tugdash-core` — the dash engine, extracted from the `tugtool` grab bag.
//!
//! A dash *is* a git branch (`tugdash/<name>`) plus a worktree; its lifecycle
//! and status derive from git, not a database. This crate holds the shared
//! helpers ([`dash`]) and the verb orchestration ([`ops`]) — a typed library
//! API that never prints. The `tugdash` CLI and the Changeset card (via
//! tugcast) are its two front ends.

/// Dash helpers — name validation, default-branch detection, the append-only
/// visibility log, and the stdin round-metadata shape.
pub mod dash;

/// The arc record — the server-driven arc's stages, document, and plan, kept
/// as dash-log lines keyed by name so the record exists before a branch does.
pub mod arc;

/// Dash verb orchestration — `create` / `commit` / `join` / `discard` /
/// `list` / `show`, each returning a typed outcome.
pub mod ops;

/// The operation log — every mutating verb recorded before it acts, with the
/// keepalive refs that keep an undone operation's commits reachable.
pub mod oplog;

/// Base-motion replay — keeping a live dash current with a base that moved:
/// the preconditions, the branch move, and the record of where rounds went.
pub mod replay;

/// The join conflict resolution ladder ([P31]): replay probe, rerere, per-file
/// re-merge / structured-merge driver / AI seam, and the candidate builder.
pub mod resolve;

/// The workshop worktree — one stable checkout per dash where the merge is
/// performed for real, so an agent has a tree and verification has a build.
pub mod workshop;

/// `dash doctor` — the four records a dash keeps, compared, with every
/// disagreement named in a sentence and a reconciling append offered where one
/// record can be caught up to another without a judgment.
pub mod doctor;

/// Surface resolution and the fit check — a project's declared surfaces, the
/// touched paths each claims, the expanded commands that check them, and the
/// runner behind `tugtool dash verify`.
pub mod surfaces;

/// Join verification — the project's own declared build and test commands run
/// against the joined tree, recorded as a fact anchored to two commits.
pub mod verify;

pub use arc::{
    ArcRecord, ArcStage, ArcStageLine, append_arc_done, append_arc_note, append_arc_plan,
    append_arc_resume, append_arc_stage, append_arc_start, append_arc_stop, read_arc,
};
pub use dash::{
    DashDeclaration, DashDeclarations, DashRoundMeta, MarkStage, StepPhase, append_dash_log,
    detect_default_branch, is_terminal, read_declarations, split_log_line, validate_dash_name,
};
pub use doctor::{DashDiagnosis, DashFinding, DashRepair, DoctorOutcome, diagnose, doctor};
pub use oplog::{
    JoinPhase, JoinProgress, OpAfter, OpBefore, OpConfig, OpPayload, OpVerb, RedoOutcome,
    UndoOutcome, list_ops, redo_in, undo_in,
};
pub use ops::{
    BaseDirtPath, CommitOutcome, CreateOutcome, DashDetail, DashDetailFile, DashDocuments,
    DashDraftKey, DashListItem, DashStatus, DiscardOutcome, DocumentArgument, JoinBlocker,
    JoinOptions, JoinOutcome, JoinStrategy, MarkOutcome, RoundItem, ShowOutcome, StepOutcome,
    brief_file, commit, create, dash_detail_entries_in, dash_draft_key, derive_stage, discard,
    discard_in, document_dashes, documents_dir, ensure_tug_excluded, join, join_in, join_in_flight,
    join_in_with_progress, join_preflight_in, ledger_file, list, mark, plan_file, show, status,
    status_in, step_done, step_start, tasks_file,
};
pub use replay::{ReplayOutcome, ReplayedRounds, replay, replay_onto};
pub use resolve::{
    FileMergeRequest, FileMerger, FileResolution, JoinShape, RESOLVE_LEASE, RESOLVE_SUBJECT_PREFIX,
    ResolveLease, ResolveOutcome, ResolvedBy, mark_resolve_begun, mark_resolve_ended,
    resolve_conflicts, resolve_conflicts_cwd, resolve_intent, resolve_lease, resolver_program,
};
pub use verify::clear_verification;
pub use workshop::{Workshop, workshop_branch, workshop_path};
