//! `tugarc-core` — the arc engine, extracted from the `tugtool` grab bag.
//!
//! An arc *is* a git branch (`tugarc/<name>`) plus a worktree; its lifecycle
//! and status derive from git, not a database. This crate holds the shared
//! helpers ([`log`]) and the verb orchestration ([`ops`]) — a typed library
//! API that never prints. The `tugarc` CLI and the Changeset card (via
//! tugcast) are its two front ends.

/// Arc helpers — name validation, default-branch detection, the append-only
/// visibility log, and the stdin round-metadata shape.
pub mod log;

/// The arc record — the server-driven arc's stages, document, and plan, kept
/// as arc log lines keyed by name so the record exists before a branch does.
pub mod arc;

/// The arc engine's one error type — a variant per cause a caller can act on.
pub mod error;

/// Arc verb orchestration — `create` / `commit` / `join` / `discard` /
/// `list` / `show`, each returning a typed outcome.
pub mod ops;

/// The operation log — every mutating verb recorded before it acts, with the
/// keepalive refs that keep an undone operation's commits reachable.
pub mod oplog;

/// Base-motion replay — keeping a live arc current with a base that moved:
/// the preconditions, the branch move, and the record of where rounds went.
pub mod replay;

/// The join conflict resolution ladder ([P31]): replay probe, rerere, per-file
/// re-merge / structured-merge driver / AI seam, and the candidate builder.
pub mod resolve;

/// The workshop worktree — one stable checkout per arc where the merge is
/// performed for real, so an agent has a tree and verification has a build.
pub mod workshop;

/// `arc doctor` — the five records an arc keeps, compared, with every
/// disagreement named in a sentence and a reconciling append offered where one
/// record can be caught up to another without a judgment.
pub mod doctor;

/// Surface resolution and the fit check — a project's declared surfaces, the
/// touched paths each claims, the expanded commands that check them, and the
/// runner behind `tugtool arc verify`.
pub mod surfaces;

/// Crossings: live arcs on one base that touch the same paths, probed against
/// each other on every round.
pub mod crossing;

/// The crossing torture bench's scenario grammar and its tempdir executor,
/// shared by the bench test, the `crossing_torture` example and the live lab.
/// Behind the `torture` feature, so it rides no shipped binary.
#[cfg(feature = "torture")]
pub mod torture;

/// Join verification — the project's own declared build and test commands run
/// against the joined tree, recorded as a fact anchored to two commits.
pub mod verify;

/// An arc's time as its log recorded it — stage rotations, step spans, and the
/// marks between them — read for the TIME popup.
pub mod timeline;

pub use arc::{
    ArcKind, ArcRecord, ArcStage, ArcStageLine, append_arc_done, append_arc_kind, append_arc_note,
    append_arc_plan, append_arc_resume, append_arc_stage, append_arc_start, append_arc_stop,
    read_arc,
};
pub use doctor::{ArcDiagnosis, ArcFinding, ArcRepair, DoctorOutcome, diagnose, doctor};
pub use error::ArcError;
pub use log::{
    ArcDeclaration, ArcDeclarations, ArcRoundMeta, MarkStage, StepPhase, append_arc_log,
    arc_has_ended, detect_default_branch, is_terminal, read_declarations, split_log_line,
    validate_arc_name,
};
pub use oplog::{
    JoinPhase, JoinProgress, OpAfter, OpBefore, OpConfig, OpPayload, OpVerb, RedoOutcome,
    UndoOutcome, list_ops, redo_in, undo_in, undo_resolve_base_in,
};
pub use ops::{
    ArcDetail, ArcDetailFile, ArcDocuments, ArcDraftKey, ArcListItem, ArcStatus, BaseDirtPath,
    CommitOutcome, CreateOutcome, DeleteDocumentsOutcome, DiscardOutcome, DocumentArgument,
    JoinBlocker, JoinOptions, JoinOutcome, JoinStrategy, MarkOutcome, OpenOutcome, RoundItem,
    ShowOutcome, StepOutcome, arc_detail_entries_in, arc_draft_key, brief_file, commit_in,
    create_in, delete_documents_in, derive_stage, discard_in, document_arcs, documents_dir,
    ensure_tug_excluded, join_in, join_in_flight, join_in_with_progress, join_preflight_in,
    ledger_file, list_in, mark_in, open_arc, plan_file, show_in, status_in, step_done_in,
    step_start_in, tasks_file, worktree_path,
};
pub use replay::{REPLAY_PHASES, ReplayOutcome, ReplayedRounds, replay_onto, replay_watched};
pub use resolve::{
    FileMergeRequest, FileMerger, FileResolution, JoinShape, LadderEvent, ONE_SHOT_MERGE_CAP_CHARS,
    RESOLVE_LEASE, RESOLVE_SUBJECT_PREFIX, ResolveLease, ResolveObserver, ResolveOutcome,
    ResolvedBy, TOO_LARGE_FOR_ONE_SHOT, exceeds_one_shot_cap, mark_resolve_begun,
    mark_resolve_ended, resolve_conflicts, resolve_conflicts_observed, resolve_intent,
    resolve_lease, resolver_program,
};
pub use verify::clear_verification;
pub use workshop::{Workshop, workshop_branch, workshop_path};
