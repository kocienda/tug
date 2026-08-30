//! `tugchanges-core` — the print-free library that owns "git changes & commits".
//!
//! A synchronous library over `std::process::Command` git, mirroring
//! `tugdash-core`'s shape: the `tugtool` CLI is a thin `--json` shell over it,
//! and tugcast links it directly in-process (via `spawn_blocking`) to retire
//! its duplicate commit/parse code. All real logic lives here; the binary only
//! parses args, calls the library, and formats output.

pub mod anchors;
pub mod changes;
pub mod commit;
pub mod contention;
pub mod git;
pub mod hunks;
mod ledger;
pub mod preflight;
pub mod shell_ops;
pub mod trailer;

pub use anchors::{
    ANCHOR_LINE_HASH_CAP, ANCHOR_MIN_LINE_BYTES, SPAN_HEAD_CAP, containment_probes,
    edit_added_lines, edit_anchor, head_excerpt, head_was_truncated, line_is_distinctive,
};
pub use changes::{Change, ChangesError, ChangesOptions, ChangesReport, ForeignChange, changes};
pub use commit::{Aggregate, CommitError, CommitOptions, CommitReceipt, LeftBehind, commit};
pub use contention::{Anchor, Claim, ContentionVerdict, OwnerAnchors, classify_contention};
pub use git::{
    DiffFile, DiffFileStatus, FileStat, NumstatEntry, StatusEntry, StatusReport, file_stats,
    git_output, git_stdout, normalize_xy, parse_name_status, parse_numstat,
    parse_status_porcelain_v2, parse_unified_diff, repo_root_for,
};
pub use hunks::{
    HUNK_DIFF_FLAGS, Hunk, HunkDrift, content_hash, file_diff_hunks, file_header, file_hunks,
    filtered_patch, hunk_id, parse_hunks,
};
pub use preflight::{
    DiffOptions, DiffReport, LogEntry, LogOptions, LogReport, PreflightOptions, PreflightReport,
    diff, log, preflight,
};
pub use shell_ops::{DeclaredKind, DeclaredOp, ParseOutcome, parse_shell_ops};
pub use trailer::{SHORT_SESSION_ID_LEN, append_trailers, session_citation};
