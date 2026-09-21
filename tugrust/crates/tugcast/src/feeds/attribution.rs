//! attribution — file-event capture from the agent-bridge relay loop.
//!
//! Every tool call a session makes flows through one supervised point:
//! tugcast's stdout relay loop in [`super::agent_bridge::relay_session_io`].
//! This module is the parsing + bookkeeping the relay's attribution
//! intercept uses to concentrate a session's file knowledge down to the
//! moment of change — a `file_events` row written when the tool call lands
//! ([P03]–[P06]).
//!
//! Two shapes are recognized on the stream:
//!
//! - **Exact** — `Write` / `Edit` / `MultiEdit` / `NotebookEdit`. The
//!   changed path comes straight from the tool input. Recorded on the
//!   successful `tool_result` (never at `tool_use` time — a denied or
//!   errored call must not pollute the record, [P04]). Because
//!   `tool_result` frames carry only the `tool_use_id` (not the tool name
//!   or input), the relay keeps a [`PendingCalls`] map populated at
//!   `tool_use` time and consumed at `tool_result` time.
//! - **Bash** — the one opaque mutator; handled by the working-tree
//!   fingerprint bracket ([`OpenBracket`]), held relay-local by the relay
//!   loop. A Bash command's *text* is read too ([`declared_ops_for_command`]):
//!   the paths it literally names are proof, exactly as an exact tool's
//!   `file_path` is, so a delta row for a named path is promoted from
//!   correlation to `origin: "cmd"`.
//!
//! The pending map is size-capped with oldest-entry eviction and is
//! deliberately **not** cleared on `turn_complete`: a background agent's
//! child `tool_use`/`tool_result` pair can straddle a turn boundary
//! (`subagent-tail` re-emits child frames on a poll while the parent turn
//! may already be over), and clearing at the boundary would orphan
//! exactly the edits this feature exists to catch.

// Parts of this surface (accessors, diagnostic helpers) are consumed only
// by tests; suppress dead-code warnings the same way `session_ledger.rs`
// and the rest of the crate do.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

// The anchor's shape is the matcher's business, so it is built beside the
// matcher in tugchanges-core — the relay only decides which edits get one.
use tugchanges_core::anchors::{edit_anchor, whole_anchor};

use serde::Deserialize;
use tugchanges_core::shell_ops::{DeclaredKind, DeclaredOp, ParseOutcome, parse_shell_ops};

use crate::path_resolver::CanonicalPath;
use crate::session_ledger::FileEventRow;

/// Maximum number of in-flight `tool_use` entries a relay's
/// [`PendingCalls`] map holds before the oldest is evicted. Each entry is
/// tiny (a couple of short strings); a few hundred covers any realistic
/// depth of un-resolved concurrent tool calls (a background agent fan-out
/// plus the foreground turn) with generous headroom. The cap only exists
/// so a pathological stream that emits `tool_use` frames whose
/// `tool_result` never arrives can't grow the map without bound.
pub const PENDING_CALLS_CAP: usize = 512;

/// Partial-shape view of a `tool_use` stream-json frame — only the fields
/// attribution needs. Extra fields (`msg_id`, `seq`, `ipc_version`, …) are
/// ignored, so a wire-format addition never breaks this parse. `input` is
/// kept as a raw `Value` because the path field differs by tool
/// (`file_path` vs `notebook_path`), read via [`file_path_for_tool`].
#[derive(Debug, Clone, Deserialize)]
pub struct InspectedToolUse {
    pub tool_name: String,
    pub tool_use_id: String,
    #[serde(default)]
    pub input: serde_json::Value,
    /// Set when a subagent issued the call (the parent `Agent`
    /// `tool_use.id`). Recorded on the row so the changeset composition
    /// can attribute nested calls to the owning session.
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    /// Original JSONL entry time (epoch ms). Present only on the
    /// resume/replay path — used as the row's `at` there so a backfilled
    /// event keeps its historical time. Live frames omit it.
    #[serde(default)]
    pub timestamp: Option<i64>,
}

impl InspectedToolUse {
    /// Parse a `tool_use` line. `None` on malformed JSON or a payload
    /// missing the required `tool_name` / `tool_use_id` (e.g. a different
    /// frame type that merely contains the substring the relay pre-filters
    /// on) — the caller treats `None` as "not an attributable tool_use".
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }
}

/// Partial-shape view of a `tool_result` stream-json frame.
#[derive(Debug, Clone, Deserialize)]
pub struct InspectedToolResult {
    pub tool_use_id: String,
    /// Denied / errored calls (permission refusal, `old_string` not found)
    /// carry `is_error: true` and must not be attributed ([P04]).
    #[serde(default)]
    pub is_error: bool,
    /// The tool's output. Read for `tugtool file` receipts — a verb's own
    /// testimony of what it did, which is how a glob or variable operand
    /// becomes proof. Defaulted when absent and emptied when it arrives as
    /// something other than a string: an unexpected output shape must cost the
    /// receipt only, never the whole frame's attribution.
    #[serde(default, deserialize_with = "string_or_empty")]
    pub output: String,
    /// Original JSONL entry time (epoch ms); replay-only, live omits.
    #[serde(default)]
    pub timestamp: Option<i64>,
}

/// Accept any JSON for a field the wire declares as a string, yielding the
/// empty string for anything else — partial-shape tolerance, the same
/// principle the rest of these views follow.
fn string_or_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::String(s) => s,
        _ => String::new(),
    })
}

impl InspectedToolResult {
    /// Parse a `tool_result` line. `None` on malformed JSON or a payload
    /// missing the required `tool_use_id`.
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }
}

/// Partial-shape view of a `replay_batch` wire line — tugcode's replay
/// path flushes committed-turn content as one line carrying up to 256
/// inner frames (`{"type":"replay_batch","frames":[…]}`). The inner
/// frames keep their individual wire shapes, so each element re-parses
/// with [`InspectedToolUse`] / [`InspectedToolResult`]. Without this
/// unwrap the relay's per-line intercept sees the envelope, fails the
/// flat parse, and every batched `tool_use`/`tool_result` — the entire
/// replay backfill, plus any live frames a mid-turn replay swallowed
/// into its bracket — is invisible to attribution.
#[derive(Debug, Deserialize)]
pub struct InspectedReplayBatch {
    pub frames: Vec<Box<serde_json::value::RawValue>>,
}

impl InspectedReplayBatch {
    /// Parse a `replay_batch` line. `None` on malformed JSON or a missing
    /// `frames` array.
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }
}

/// The exact top-level `"type"` of a wire line, or `None` when the line is
/// not a JSON object with a string `type`. Used by the relay to tell a
/// frame that *is* a `tool_use`/`tool_result` but failed the inspected
/// parse (shape drift — must warn) from a frame of another type that merely
/// embeds the substring in its payload (streamed text quoting this very
/// codebase — silent).
pub fn top_level_type(bytes: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct TypeOnly {
        #[serde(rename = "type")]
        r#type: String,
    }
    serde_json::from_slice::<TypeOnly>(bytes)
        .ok()
        .map(|t| t.r#type)
}

/// The `op` verb recorded for an exact-attribution tool, or `None` for any
/// tool this module does not attribute exactly (`Bash` is bracketed in
/// Step 4; everything else is ignored). `MultiEdit` is the legacy multi-
/// hunk edit tool — still handled, same verb as `Edit`.
pub fn exact_op_for_tool(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        "Write" => Some("write"),
        "Edit" => Some("edit"),
        "MultiEdit" => Some("edit"),
        "NotebookEdit" => Some("notebook"),
        _ => None,
    }
}

/// The changed path an exact tool's `input` names, or `None` when the tool
/// is not exact-attributable or the expected key is absent / non-string.
/// `NotebookEdit` names its target `notebook_path`; the rest use
/// `file_path`. The path is returned as given by the tool (absolute);
/// [`PendingCall::into_row`] projects it to repo-relative in canonical space
/// at record time.
pub fn file_path_for_tool(tool_name: &str, input: &serde_json::Value) -> Option<String> {
    let key = match tool_name {
        "Write" | "Edit" | "MultiEdit" => "file_path",
        "NotebookEdit" => "notebook_path",
        _ => return None,
    };
    input
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_owned())
}

/// Anchors one tool call may record. Beyond it the call records a single
/// `whole` span instead: an edit touching more than this many regions is
/// effectively a rewrite, and widening to the whole file ([P12]) is both
/// cheaper and the conservative reading.
pub const SPANS_PER_EVENT_CAP: usize = 32;

/// The `whole` span — the anchor-free assertion that a call's evidence
/// covers the entire file. Written for `Write`/`NotebookEdit` (which replace
/// the file wholesale), for a claim (a whole-file assertion by hand), and
/// wherever a finer reading is unavailable.
pub fn whole_span() -> crate::session_ledger::FileEventSpan {
    crate::session_ledger::FileEventSpan {
        seq: 0,
        kind: "whole".to_owned(),
        anchor: "{}".to_owned(),
    }
}

/// The same `whole` span, recording what the call actually wrote ([P04]).
///
/// A whole-file write knows its own output exactly, and recording nothing
/// about it is what makes a ghost `Write` unfalsifiable: the row asserts the
/// file forever, with nothing the diff can ever contradict. With the content's
/// identity on the row, a dead owner's claim can be tested against the bytes
/// that are actually there.
pub fn whole_span_for(content: &str) -> crate::session_ledger::FileEventSpan {
    crate::session_ledger::FileEventSpan {
        seq: 0,
        kind: "whole".to_owned(),
        anchor: whole_anchor(content).to_string(),
    }
}

/// The content anchors an exact tool's input yields ([P11], Spec S04).
///
/// What the call *added*, never where it added it: line numbers die the
/// moment another edit lands above them, while added lines still match
/// against the current diff at read time. The anchor body itself is
/// [`edit_anchor`]'s business — an `Edit`'s strings carry unchanged context
/// lines the diff will render as context, so the evidence recorded is the
/// lines the edit actually added. `Write` and `NotebookEdit` replace
/// the file wholesale and so carry a single `whole` anchor — carrying the
/// written content's identity when the input holds it, so the assertion is
/// falsifiable ([P04]); `Edit` and `MultiEdit` carry one anchor per edit —
/// `replace` when it named an `old_string`, `insert` when it did not.
///
/// An empty result means this tool contributes no sub-file evidence, which
/// widens its owner to a whole-file claim by rule ([P12]) — the same answer
/// the system gave before spans existed.
pub fn spans_for_tool_input(
    tool_name: &str,
    input: &serde_json::Value,
) -> Vec<crate::session_ledger::FileEventSpan> {
    match tool_name {
        "Write" => vec![match input.get("content").and_then(|v| v.as_str()) {
            Some(content) => whole_span_for(content),
            None => whole_span(),
        }],
        "NotebookEdit" => vec![match input.get("new_source").and_then(|v| v.as_str()) {
            Some(content) => whole_span_for(content),
            None => whole_span(),
        }],
        "Edit" => edit_spans(std::slice::from_ref(input)),
        "MultiEdit" => match input.get("edits").and_then(|v| v.as_array()) {
            Some(edits) => edit_spans(edits),
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// One `insert`/`replace` anchor per edit object, or a single `whole` anchor
/// when there are more edits than [`SPANS_PER_EVENT_CAP`].
fn edit_spans(edits: &[serde_json::Value]) -> Vec<crate::session_ledger::FileEventSpan> {
    if edits.len() > SPANS_PER_EVENT_CAP {
        return vec![whole_span()];
    }
    let mut spans = Vec::new();
    for edit in edits {
        let Some(new_string) = edit.get("new_string").and_then(|v| v.as_str()) else {
            continue;
        };
        let old_string = edit.get("old_string").and_then(|v| v.as_str());
        let replaced = old_string.is_some_and(|s| !s.is_empty());
        spans.push(crate::session_ledger::FileEventSpan {
            seq: spans.len() as i64,
            kind: if replaced { "replace" } else { "insert" }.to_owned(),
            anchor: edit_anchor(old_string, new_string).to_string(),
        });
    }
    spans
}

/// The `hunk` anchors a verb receipt's applied-hunk ids yield (Spec S05) —
/// the strongest anchor kind there is, since the id is already the identity
/// the current diff's hunks are keyed by.
pub fn hunk_spans(ids: &[String]) -> Vec<crate::session_ledger::FileEventSpan> {
    if ids.len() > SPANS_PER_EVENT_CAP {
        return vec![whole_span()];
    }
    ids.iter()
        .enumerate()
        .map(|(seq, id)| crate::session_ledger::FileEventSpan {
            seq: seq as i64,
            kind: "hunk".to_owned(),
            anchor: serde_json::json!({ "hunk_id": id }).to_string(),
        })
        .collect()
}

/// A `tool_use` frame's attribution facts, held until its `tool_result`
/// arrives. Only exact-attributable calls with a resolvable path ever
/// become a `PendingCall`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCall {
    pub tool_name: String,
    pub file_path: String,
    pub op: &'static str,
    pub parent_tool_use_id: Option<String>,
    /// The `tool_use` frame's `timestamp` (replay path only). Used as the
    /// row's `at` on the replay path so a backfilled row keeps historical
    /// time; `None` on the live path, where frame-arrival time is used.
    pub timestamp: Option<i64>,
    /// The call's sub-file evidence, read from the tool input at `tool_use`
    /// time — the only moment it is on the stream. Written with the row on
    /// the successful `tool_result`. The replay path carries the same
    /// anchors, because the tool input replays.
    pub spans: Vec<crate::session_ledger::FileEventSpan>,
}

impl PendingCall {
    /// Build the [`FileEventRow`] this call resolves to on a successful
    /// `tool_result`. `origin` is `"exact"` live / `"replay"` on the
    /// replay path; `at` is the resolved event time.
    ///
    /// The tool's absolute `file_path` is projected to repo-relative in
    /// canonical space here (given the canonical `repo_root`), so both sides of
    /// the changeset join speak git's repo-relative language. When `repo_root`
    /// is `None` (non-repo project dir), the canonical absolute path is stored —
    /// there is nothing to strip against.
    ///
    /// `None` means the call named a file outside the project's repo: there is
    /// no row to write (see [`repo_relative_key`]).
    pub fn into_row(
        self,
        tug_session_id: &str,
        tool_use_id: &str,
        project_dir: &CanonicalPath,
        repo_root: Option<&CanonicalPath>,
        origin: &str,
        at: i64,
    ) -> Option<FileEventRow> {
        Some(FileEventRow {
            tug_session_id: tug_session_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
            file_path: project_repo_relative(repo_root, &self.file_path)?,
            tool_name: self.tool_name,
            op: self.op.to_owned(),
            origin: origin.to_owned(),
            ambiguous: false,
            parent_tool_use_id: self.parent_tool_use_id,
            project_dir: project_dir.as_str().to_owned(),
            at,
        })
    }
}

/// Canonicalize `file_path` through the gateway (a firmlink/synthetic spelling
/// of the same file collapses into the repo root's space) and project it with
/// [`repo_relative_key`].
fn project_repo_relative(repo_root: Option<&CanonicalPath>, file_path: &str) -> Option<String> {
    let canonical = CanonicalPath::from_raw(Path::new(file_path));
    repo_relative_key(repo_root.map(|r| r.as_path()), canonical.as_path())
}

/// Project an already-canonical captured path to the repo-relative key both
/// sides of the changeset join speak, or `None` when the path names a file the
/// changeset can never show.
///
/// A relative path is already that key and passes through. An absolute path is
/// stripped against the canonical `repo_root`. An absolute path that does not
/// lie under the root is **outside the repo**: the compose fold matches events
/// against git's repo-relative dirty paths, so such a row can never surface in
/// a changeset, a claim bucket, or a draft — it is not recorded at all. With no
/// repo root (a non-repo project dir) there is nothing to be outside of, and
/// the canonical absolute path is the key.
///
/// Every production site that builds a `FileEventRow` from a captured path
/// projects it through here, so "what `file_events` can hold" has one answer.
pub fn repo_relative_key(repo_root: Option<&Path>, canonical: &Path) -> Option<String> {
    if canonical.is_relative() {
        return Some(canonical.to_string_lossy().into_owned());
    }
    match repo_root {
        Some(root) => canonical
            .strip_prefix(root)
            .map(|rel| rel.to_string_lossy().into_owned())
            .ok(),
        None => Some(canonical.to_string_lossy().into_owned()),
    }
}

/// Relay-local map of in-flight `tool_use` calls keyed by `tool_use_id`,
/// with oldest-entry eviction at [`PENDING_CALLS_CAP`]. Not cleared on
/// `turn_complete` (see module docs — background-agent child frames
/// straddle turn boundaries).
#[derive(Debug)]
pub struct PendingCalls {
    map: HashMap<String, PendingCall>,
    /// Insertion order of live keys, for oldest-first eviction. A `take`
    /// leaves the id here as a tombstone; eviction skips ids already gone
    /// from `map`, so the deque self-cleans as it drains.
    order: VecDeque<String>,
    cap: usize,
}

impl Default for PendingCalls {
    fn default() -> Self {
        Self::with_cap(PENDING_CALLS_CAP)
    }
}

impl PendingCalls {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_cap(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap: cap.max(1),
        }
    }

    /// Number of live (un-resolved) calls currently held.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Record a `tool_use`. A repeat of the same `tool_use_id` overwrites
    /// in place without growing the eviction order (the replay path can
    /// re-emit the same `tool_use`). Inserting past the cap evicts the
    /// oldest still-live entry.
    pub fn insert(&mut self, tool_use_id: String, call: PendingCall) {
        if self.map.insert(tool_use_id.clone(), call).is_none() {
            self.order.push_back(tool_use_id);
            while self.map.len() > self.cap {
                match self.order.pop_front() {
                    // Only a still-present key counts as an eviction; a
                    // tombstone (already taken) is discarded and the loop
                    // continues. `order` always holds every live key, so
                    // this terminates.
                    Some(oldest) => {
                        self.map.remove(&oldest);
                    }
                    None => break,
                }
            }
        }
    }

    /// Resolve and remove a call by `tool_use_id`, or `None` if it was
    /// never recorded (a non-exact tool, or already evicted / taken).
    pub fn take(&mut self, tool_use_id: &str) -> Option<PendingCall> {
        self.map.remove(tool_use_id)
    }
}

// ---------------------------------------------------------------------------
// Bash fingerprint bracketing ([P05], #bracket-algorithm)
// ---------------------------------------------------------------------------

/// A single tracked path's working-tree state at snapshot time: its
/// porcelain-v2 `XY` status (`"?"` for untracked) plus mtime. Both axes
/// matter: status catches a file entering / leaving / changing category in
/// the dirty set, and mtime catches a same-status re-write within the
/// bracket window (a file already `M` before the command, modified again
/// by it — the status alone wouldn't move).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileState {
    pub status: String,
    pub mtime: Option<SystemTime>,
}

/// One open fingerprint bracket: the pre-command working-tree fingerprint,
/// held relay-local from open (Bash `tool_use`, or the turn's first
/// `user_message`) until close (`tool_result` / `turn_complete`), when the
/// delta is attributed. A bracket records provenance only — who, what, when
/// — never a cross-session judgment; contention between sessions is a
/// per-file fact the read side computes from ledger rows.
#[derive(Debug, Clone)]
pub struct OpenBracket {
    pub tug_session_id: String,
    pub tool_use_id: String,
    pub parent_tool_use_id: Option<String>,
    pub opened_at: i64,
    pub repo_root: PathBuf,
    pub pre: HashMap<PathBuf, FileState>,
}

impl OpenBracket {
    /// Compute the file-event rows this bracket attributes, given the
    /// post-command snapshot. Each path whose state differs between `pre`
    /// and `post` becomes one row on `project_dir` (the owning session's
    /// checkout root, so a session's bracket and exact events share a project
    /// bucket), tagged with the caller's `tool_name`/`origin`. A per-call
    /// Bash bracket passes `("Bash", "bash")`; the turn-scoped fallback
    /// bracket ([P05]) passes `("Turn", "turn")`.
    ///
    /// `file_path` is stored repo-relative (stripped against the bracket's
    /// `repo_root`), matching the exact-tool path's capture-time projection.
    ///
    /// `declared` holds the canonical absolute paths the command literally
    /// named, split by how far the naming reaches ([P02]). A delta path the
    /// declaration covers was both named by the tool input and observed to
    /// change, which is proof — that row is promoted to `origin: "cmd"`.
    /// Everything else keeps the caller's correlation origin; the turn bracket
    /// passes an empty set.
    pub fn into_delta_rows(
        self,
        post: &HashMap<PathBuf, FileState>,
        project_dir: &CanonicalPath,
        tool_name: &str,
        origin: &str,
        claims: &CommandClaims<'_>,
        at: i64,
    ) -> Vec<FileEventRow> {
        let mut paths: HashSet<&PathBuf> = HashSet::new();
        paths.extend(self.pre.keys());
        paths.extend(post.keys());

        let mut rows = Vec::new();
        for path in paths {
            let post_state = post.get(path);
            // A path that left the dirty set is ambiguous on the status axis
            // alone — committed/reverted and *deleted while untracked* both
            // read as "gone". Disk existence is the discriminator, and it is
            // probed only for that case.
            let still_on_disk = post_state.is_some() || path.exists();
            let op = match classify_op(self.pre.get(path), post_state, still_on_disk) {
                Some(op) => op,
                None => continue,
            };
            // The command declared it wrote this path and put it back
            // byte-identical. The delta still sees a change on the mtime axis
            // — the bytes were rewritten, and honestly so — but there is
            // nothing to attribute: the file's content is what it was before
            // the bracket opened. Suppression is read whether or not the
            // command succeeded, because a probe restores on every exit path
            // including a failing one, and a hint is only ever dropped here,
            // never minted.
            // Compared in canonical space: the receipt's paths come from a
            // `tugtool` process that resolved them its own way, while the
            // delta's keys are `bracket.repo_root.join(rel)` — the same file
            // can reach here under `/Users/…` and `/private/var/…` spellings.
            if !claims.restored.is_empty()
                && claims.restored.contains(&CanonicalPath::from_raw(path))
            {
                continue;
            }
            // The pre/post fingerprint keys are `repo_root.join(rel)`, so the
            // strip always recovers git's repo-relative key.
            let Some(file_path) = repo_relative_key(Some(&self.repo_root), path) else {
                continue;
            };
            let row_origin = if claims.declared.covers(path) {
                CMD_ORIGIN
            } else {
                origin
            };
            rows.push(FileEventRow {
                tug_session_id: self.tug_session_id.clone(),
                tool_use_id: self.tool_use_id.clone(),
                file_path,
                tool_name: tool_name.to_owned(),
                op: op.to_owned(),
                origin: row_origin.to_owned(),
                ambiguous: false,
                parent_tool_use_id: self.parent_tool_use_id.clone(),
                project_dir: project_dir.as_str().to_owned(),
                at,
            });
        }
        rows
    }
}

/// Everything a command said about the paths in its own bracket — the two
/// halves of "what the command claimed", which pull in opposite directions.
///
/// `declared` **promotes**: a path the tool input named and the tree observed
/// change is proof, so its row is minted `cmd` instead of the caller's weak
/// correlation origin. `restored` **suppresses**: a path the verb wrote and
/// put back byte-identical gets no row at all, because the bytes at the close
/// are the bytes at the open and the delta only sees the mtime it honestly
/// moved (see [`ReceiptScan::restored`]).
///
/// They ride together in one argument because they answer one question at one
/// place — the single loop that decides a path's row — and because splitting
/// them into two positional parameters pushed `into_delta_rows` past the arity
/// the lint allows, which was the lint being right about the shape.
#[derive(Debug, Clone, Copy)]
pub struct CommandClaims<'a> {
    pub declared: &'a DeclaredPromotions,
    pub restored: &'a HashSet<CanonicalPath>,
}

impl<'a> CommandClaims<'a> {
    /// A command that claimed nothing either way — the turn bracket's case,
    /// which spans arbitrarily many commands so no single one can speak for
    /// its delta, and every test that is not about promotion.
    pub fn none() -> Self {
        static NOTHING_DECLARED: std::sync::LazyLock<DeclaredPromotions> =
            std::sync::LazyLock::new(DeclaredPromotions::default);
        static NOTHING_RESTORED: std::sync::LazyLock<HashSet<CanonicalPath>> =
            std::sync::LazyLock::new(HashSet::new);
        Self {
            declared: &NOTHING_DECLARED,
            restored: &NOTHING_RESTORED,
        }
    }

    /// Promotions without any restore — a parsed Bash call that named files.
    pub fn declaring(declared: &'a DeclaredPromotions) -> Self {
        Self {
            declared,
            ..Self::none()
        }
    }

    /// Restores without any promotion — a probe, whose whole receipt is the
    /// restore.
    pub fn restoring(restored: &'a HashSet<CanonicalPath>) -> Self {
        Self {
            restored,
            ..Self::none()
        }
    }
}

/// The origin of a row whose file the command itself named — proof class, on
/// the same footing as an exact tool's `file_path`.
pub const CMD_ORIGIN: &str = "cmd";

/// The canonical absolute paths a command declared, split by how far the
/// declaration reaches into the tree ([P02]).
///
/// Reaching beneath a declared path is a **lifecycle** privilege: `rm -rf dir/`
/// names the directory while `--untracked-files=all` reports the files inside
/// it, so the removal's proof has to descend to meet them. An edit-class verb
/// names files — `sed -i`, `perl -i`, `tugtool file edit`, a redirect target all
/// require a literal file operand — so an edit declaration promotes on path
/// equality only. A directory operand reaching an edit-class declaration is the
/// checkout-pathspec shape that minted proof over a whole subtree on
/// 2026-08-13; keeping the sets apart makes that structurally impossible rather
/// than incidentally avoided.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeclaredPromotions {
    /// Promote a delta path only when it equals one of these.
    pub exact: HashSet<PathBuf>,
    /// Promote a delta path equal to or beneath one of these.
    pub subtree: HashSet<PathBuf>,
}

impl DeclaredPromotions {
    /// Partition a parse's declared operations by promotion reach, in canonical
    /// space so the paths join against delta keys. Lifecycle kinds
    /// (`Remove`/`Move`/`Copy`) reach into subtrees; edit kinds
    /// (`EditInPlace`/`WriteTarget`/`Touch`) promote on equality only; `Restore`
    /// contributes to neither — restored bytes are the repository's ([P01]).
    pub fn from_ops<'a>(ops: impl Iterator<Item = &'a DeclaredOp>) -> Self {
        let mut promotions = Self::default();
        for op in ops {
            let path = canonicalize_declared(op.path.as_path());
            match op.kind {
                DeclaredKind::Remove | DeclaredKind::Move { .. } | DeclaredKind::Copy => {
                    promotions.subtree.insert(path);
                }
                DeclaredKind::EditInPlace | DeclaredKind::WriteTarget | DeclaredKind::Touch => {
                    promotions.exact.insert(path);
                }
                DeclaredKind::Restore => {}
            }
        }
        promotions
    }

    /// Whether a declaration names `path` closely enough to promote its row.
    pub fn covers(&self, path: &Path) -> bool {
        self.exact.contains(path)
            || self
                .subtree
                .iter()
                .any(|d| path == d.as_path() || path.starts_with(d))
    }
}

/// Canonicalize a declared path that may no longer exist. The gateway resolves
/// symlinks by asking the filesystem, which a deleted or moved-away path cannot
/// answer — and a delete is precisely the case this join exists for. So resolve
/// the nearest ancestor that *does* still exist and re-attach the tail.
pub fn canonicalize_declared(path: &Path) -> PathBuf {
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    loop {
        if cursor.exists() {
            let mut resolved = CanonicalPath::from_raw(cursor).as_path().to_path_buf();
            for part in tail.iter().rev() {
                resolved.push(part);
            }
            return resolved;
        }
        match (cursor.parent(), cursor.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                cursor = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// A parsed Bash command's declared operations, held from its `tool_use` frame
/// until the paired `tool_result` — the command-text half of the parse∩delta
/// rule, and the whole of the replay rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCmd {
    pub ops: Vec<DeclaredOp>,
    pub parent_tool_use_id: Option<String>,
    /// The `tool_use` frame's historical `timestamp` (replay only).
    pub timestamp: Option<i64>,
}

/// Relay-local map of parsed Bash commands keyed by `tool_use_id`, with the
/// same oldest-first eviction discipline as [`PendingCalls`].
#[derive(Debug)]
pub struct PendingCmds {
    map: HashMap<String, PendingCmd>,
    order: VecDeque<String>,
    cap: usize,
}

impl Default for PendingCmds {
    fn default() -> Self {
        Self::with_cap(PENDING_CALLS_CAP)
    }
}

impl PendingCmds {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_cap(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap: cap.max(1),
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn insert(&mut self, tool_use_id: String, cmd: PendingCmd) {
        if self.map.insert(tool_use_id.clone(), cmd).is_none() {
            self.order.push_back(tool_use_id);
            while self.map.len() > self.cap {
                match self.order.pop_front() {
                    Some(oldest) => {
                        self.map.remove(&oldest);
                    }
                    None => break,
                }
            }
        }
    }

    pub fn take(&mut self, tool_use_id: &str) -> Option<PendingCmd> {
        self.map.remove(tool_use_id)
    }
}

/// The declared operations a Bash command's text yields, or `None` when the
/// grammar reads no file operation in it (including its refusals — a refusal
/// mints nothing and the paths stay bracket hints).
pub fn declared_ops_for_command(command: &str, base_dir: &Path) -> Option<Vec<DeclaredOp>> {
    match parse_shell_ops(command, base_dir) {
        ParseOutcome::Ops(ops) => Some(ops),
        ParseOutcome::NoFileOps | ParseOutcome::Unparseable { .. } => None,
    }
}

/// The `command` string of a Bash `tool_use` frame's input.
pub fn bash_command_for_tool(tool_name: &str, input: &serde_json::Value) -> Option<String> {
    if tool_name != "Bash" {
        return None;
    }
    input
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_owned())
}

/// The `op` a declared operation records when there is no delta to read it
/// from (the replay path): advisory precision only — git status decides how the
/// file actually renders at read time.
pub fn op_for_declared_kind(kind: &DeclaredKind) -> &'static str {
    match kind {
        DeclaredKind::Remove => "deleted",
        DeclaredKind::Move { .. } => "renamed",
        DeclaredKind::Copy => "created",
        DeclaredKind::EditInPlace
        | DeclaredKind::WriteTarget
        | DeclaredKind::Touch
        | DeclaredKind::Restore => "modified",
    }
}

/// The stdout marker a `tugtool file` verb prints to report what it did.
pub const RECEIPT_MARKER: &str = "TUG-FILE-RECEIPT: ";

/// One operation a verb receipt reports, with absolute paths.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReceiptOp {
    pub op: String,
    pub path: String,
    #[serde(default)]
    pub orig_path: Option<String>,
    /// The [P06] ids of the hunks the verb actually applied (Spec S05).
    /// Additive and optional — a receipt without it mints a span-less row,
    /// which widens to a whole-file claim exactly as before.
    #[serde(default)]
    pub hunks: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Receipt {
    #[serde(default)]
    ops: Vec<ReceiptOp>,
    #[serde(default)]
    restored: Vec<String>,
}

/// The result of scanning a tool result's output for receipts.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReceiptScan {
    pub ops: Vec<ReceiptOp>,
    /// Absolute paths the verb wrote and then put back **byte-identical** —
    /// `tugtool file probe`'s restore. They are the receipt's negative space:
    /// not an operation to attribute but an operation to *un*-attribute, so the
    /// bracket delta drops its rows for them.
    ///
    /// A probe used to keep the ledger quiet by restoring the original **mtime**
    /// along with the bytes, which made the status+mtime fingerprint read
    /// identical across the bracket. That lie was told to the filesystem, and
    /// every build system that decides staleness by mtime believed it: cargo
    /// recorded the patched source at the probe's build, then saw an *older*
    /// source afterwards and concluded its artifacts were current, so a probe
    /// left stale rlibs behind a tree that looked clean (2026-09-14). Declaring
    /// the restore instead lets the probe leave honest mtimes and keeps the
    /// hint away on the one axis that was ever at stake.
    pub restored: Vec<String>,
    /// A line carried the marker but its JSON did not parse. Capture failure is
    /// loud (invariant 12) — the caller warns rather than dropping it silently.
    pub malformed: bool,
}

/// Scan a Bash `tool_result`'s output for `tugtool file` receipts. The verb
/// performed the expansion a glob or variable hid from the grammar and reports
/// exactly which files it touched — testimony from a tool we own, which is what
/// makes those operations provable at all. Unknown JSON fields are ignored, so
/// the receipt can grow additively.
pub fn parse_receipt_line(output: &str) -> ReceiptScan {
    let mut scan = ReceiptScan::default();
    for line in output.lines() {
        let Some(payload) = line.trim_start().strip_prefix(RECEIPT_MARKER) else {
            continue;
        };
        match serde_json::from_str::<Receipt>(payload.trim()) {
            Ok(receipt) => {
                scan.ops.extend(receipt.ops);
                scan.restored.extend(receipt.restored);
            }
            Err(_) => scan.malformed = true,
        }
    }
    scan
}

/// The row `op` a receipt op records, or `None` for a verb this relay does not
/// know — an unknown op is ignored rather than guessed at.
pub fn op_for_receipt(op: &str) -> Option<&'static str> {
    match op {
        "deleted" => Some("deleted"),
        "renamed" => Some("renamed"),
        "created" => Some("created"),
        "modified" => Some("modified"),
        _ => None,
    }
}

/// The stderr marker `tugtool file edit` and `tugedit` print when a program
/// failed — the receipt's counterpart, and the reason `tugtool` can testify to
/// a failure without ever opening a session ledger.
pub const EDIT_ERROR_MARKER: &str = "TUG-EDIT-ERROR: ";

/// Scan a tool result's output for the first edit-error marker, returning its
/// JSON whole.
///
/// Whole, because the block *is* the evidence bundle: the class, the exit, the
/// report, the op counts, the files, and the program the model wrote. A
/// projection here would decide for every later reader which of those matters,
/// and the reader that matters most — a wire diagnosing why the edit failed —
/// wants all of it.
///
/// The first, because a compound command stops at its first failure, and the
/// fact this feeds is keyed one-per-tool-call.
///
/// Timid, in the `parse_shell_ops` posture: a line carrying the prefix whose
/// payload is not a JSON object with a `class` string yields `None`, and
/// nothing is recorded. A guessed failure reads exactly like a real one.
pub fn parse_edit_error_line(output: &str) -> Option<serde_json::Value> {
    output.lines().find_map(|line| {
        let payload = line.trim_start().strip_prefix(EDIT_ERROR_MARKER)?;
        let value: serde_json::Value = serde_json::from_str(payload.trim()).ok()?;
        value.get("class")?.as_str()?;
        Some(value)
    })
}

/// Classify the working-tree transition of one path across the bracket
/// window, or `None` when its state is unchanged (identical status AND
/// mtime — no attribution). `still_on_disk` disambiguates the disappearance
/// case and is only consulted there.
fn classify_op(
    pre: Option<&FileState>,
    post: Option<&FileState>,
    still_on_disk: bool,
) -> Option<&'static str> {
    match (pre, post) {
        (Some(a), Some(b)) if a == b => None,
        (_, Some(b)) => Some(op_from_status(&b.status)),
        // Fell out of the dirty set. An untracked file that was deleted leaves
        // no ` D` status behind — it simply stops being listed — so without the
        // disk check the row would claim a file still exists.
        (Some(_), None) if !still_on_disk => Some("deleted"),
        // Still on disk: the command committed or reverted it.
        (Some(_), None) => Some("modified"),
        (None, None) => None,
    }
}

/// Map a porcelain-v2 `XY` status (or `"?"` untracked) to a file-event
/// `op`. Deletions and renames dominate a plain modify; a fresh add /
/// untracked file is a create.
fn op_from_status(status: &str) -> &'static str {
    if status == "?" || status.contains('A') {
        "created"
    } else if status.contains('D') {
        "deleted"
    } else if status.contains('R') {
        "renamed"
    } else {
        "modified"
    }
}

/// Whether a row's `origin` is **proof** of authorship — the tool input named
/// the file (`exact` live, `replay` backfill of the same, `cmd` for a Bash
/// command whose literal operands or verb receipt named it), or a session
/// **`claim`**ed it outright (the explicit, intentional promotion of a file
/// the session touched but never proof-edited — e.g. a `perl`/`sed` edit that
/// only left a bracket hint). `bash`/`turn` bracket rows are correlation (a
/// whole-tree fingerprint delta), never proof.
pub fn origin_is_proof(origin: &str) -> bool {
    matches!(origin, "exact" | "replay" | "claim" | "cmd")
}

/// The canonical repo root **of the file itself** — resolved by walking up
/// from the file's own directory, in canonical space. Repo membership is a
/// per-file fact, not a per-session fact: a session whose project dir is one
/// checkout can exact-edit a file inside a nested worktree (an arc session
/// does exactly this), and the row must be keyed by the worktree's root, not
/// the session's. `None` when the file is outside any repo.
pub async fn file_repo_root(file_path: &str) -> Option<CanonicalPath> {
    let canonical = CanonicalPath::from_raw(Path::new(file_path));
    let parent = canonical.as_path().parent()?;
    let root = repo_root_for(parent).await?;
    Some(CanonicalPath::from_raw(&root))
}

/// The canonical repo root for `dir` — the nearest ancestor (inclusive)
/// containing a `.git` entry (a directory for a normal repo, a file for a
/// worktree/submodule). `None` for a non-repo path, which never opens a
/// bracket. Mirrors the ancestor walk `feeds/git.rs::is_within_git_worktree`
/// uses, but returns the root so the snapshot and path resolution share it.
pub async fn repo_root_for(dir: &Path) -> Option<PathBuf> {
    let mut cursor = Some(dir);
    while let Some(current) = cursor {
        if tokio::fs::metadata(current.join(".git")).await.is_ok() {
            return Some(current.to_path_buf());
        }
        cursor = current.parent();
    }
    None
}

/// Snapshot the working tree at `repo_root` into a `path → FileState`
/// fingerprint (absolute paths). Runs `git status --porcelain=v2
/// --untracked-files=all` and stats each listed path for its mtime. A git
/// failure degrades to an empty snapshot (the bracket then attributes nothing,
/// never a wrong guess). `--untracked-files=all` ([P06]) expands a fully- or
/// newly-untracked directory into its individual files, so a new file inside one
/// changes the fingerprint (a bare `? dir/` line would not) and the delta rows
/// name the file, not the directory.
pub async fn snapshot_worktree(repo_root: &Path) -> HashMap<PathBuf, FileState> {
    let mut map = HashMap::new();
    let Some(output) = run_git_status_porcelain(repo_root).await else {
        return map;
    };
    for (rel, status) in parse_worktree_states(&output) {
        let abs = repo_root.join(&rel);
        let mtime = tokio::fs::metadata(&abs)
            .await
            .ok()
            .and_then(|m| m.modified().ok());
        map.insert(abs, FileState { status, mtime });
    }
    map
}

/// Run `git -C <repo_root> status --porcelain=v2 --untracked-files=all`,
/// returning stdout on success or `None` on any failure (non-repo, git error,
/// spawn failure) — the caller degrades to an empty snapshot.
async fn run_git_status_porcelain(repo_root: &Path) -> Option<String> {
    let output = tokio::process::Command::from(tugcore::git_command())
        .args([
            "-C",
            &repo_root.to_string_lossy(),
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
        ])
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        None
    }
}

/// Extract `(repo-relative path, status)` pairs from porcelain-v2 output.
/// `1 ` ordinary and `2 ` rename/copy entries yield their `XY` status
/// (rename's `X` is `R`); `? ` untracked entries yield `"?"`. Unmerged
/// (`u `) and header (`# `) lines are ignored. Mirrors the field layout
/// `feeds/git.rs::parse_porcelain_v2` reads.
pub(crate) fn parse_worktree_states(output: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("1 ") {
            // XY sub mH mI mW hH hI path
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            if fields.len() >= 8 && !fields[0].is_empty() && !fields[7].is_empty() {
                out.push((fields[7].to_owned(), fields[0].to_owned()));
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // XY sub mH mI mW hH hI Xscore path\torig
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            if fields.len() >= 9 {
                let new_path = fields[8].split('\t').next().unwrap_or(fields[8]);
                if !new_path.is_empty() {
                    out.push((new_path.to_owned(), fields[0].to_owned()));
                }
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            out.push((path.to_owned(), "?".to_owned()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugchanges_core::anchors::{ANCHOR_LINE_HASH_CAP, SPAN_HEAD_CAP};

    #[test]
    fn parses_write_tool_use_and_resolves_file_path() {
        let line = br#"{"type":"tool_use","msg_id":"m1","seq":0,"tool_name":"Write","tool_use_id":"tu-1","input":{"file_path":"/proj/a.rs","content":"x"},"ipc_version":1}"#;
        let tu = InspectedToolUse::from_slice(line).expect("parse");
        assert_eq!(tu.tool_name, "Write");
        assert_eq!(tu.tool_use_id, "tu-1");
        assert_eq!(
            file_path_for_tool(&tu.tool_name, &tu.input).as_deref(),
            Some("/proj/a.rs")
        );
        assert_eq!(exact_op_for_tool(&tu.tool_name), Some("write"));
        assert_eq!(tu.parent_tool_use_id, None);
        assert_eq!(tu.timestamp, None);
    }

    #[test]
    fn notebook_edit_reads_notebook_path() {
        let input = serde_json::json!({ "notebook_path": "/proj/nb.ipynb" });
        assert_eq!(
            file_path_for_tool("NotebookEdit", &input).as_deref(),
            Some("/proj/nb.ipynb")
        );
        assert_eq!(exact_op_for_tool("NotebookEdit"), Some("notebook"));
    }

    #[test]
    fn claim_is_proof_bash_and_turn_are_not() {
        // An explicit session claim is proof of authorship, alongside the
        // exact-tool origins; bracket correlations never are.
        assert!(origin_is_proof("exact"));
        assert!(origin_is_proof("replay"));
        assert!(origin_is_proof("claim"));
        assert!(origin_is_proof(CMD_ORIGIN));
        assert!(!origin_is_proof("bash"));
        assert!(!origin_is_proof("turn"));
    }

    #[test]
    fn bash_and_unknown_tools_are_not_exact() {
        assert_eq!(exact_op_for_tool("Bash"), None);
        assert_eq!(exact_op_for_tool("Read"), None);
        let input = serde_json::json!({ "command": "sed -i s/a/b/ x" });
        assert_eq!(file_path_for_tool("Bash", &input), None);
    }

    #[test]
    fn parses_subagent_tool_use_parent_id_and_replay_timestamp() {
        let line = br#"{"type":"tool_use","tool_name":"Edit","tool_use_id":"tu-child","input":{"file_path":"/proj/x.rs"},"parent_tool_use_id":"agent-1","timestamp":1700000000123}"#;
        let tu = InspectedToolUse::from_slice(line).expect("parse");
        assert_eq!(tu.parent_tool_use_id.as_deref(), Some("agent-1"));
        assert_eq!(tu.timestamp, Some(1_700_000_000_123));
    }

    #[test]
    fn tool_result_defaults_is_error_false_when_absent() {
        let line = br#"{"type":"tool_result","tool_use_id":"tu-1","output":"ok"}"#;
        let tr = InspectedToolResult::from_slice(line).expect("parse");
        assert!(!tr.is_error);
    }

    #[test]
    fn a_frame_missing_required_fields_does_not_parse_as_tool_use() {
        // A user_message that merely embeds a nested tool_use block (so the
        // relay's substring pre-filter fires) has no top-level tool_name —
        // it must not parse into an attributable InspectedToolUse.
        let line = br#"{"type":"user_message","content":[{"type":"tool_use","id":"nested"}]}"#;
        assert!(InspectedToolUse::from_slice(line).is_none());
    }

    fn call(path: &str) -> PendingCall {
        PendingCall {
            tool_name: "Write".to_owned(),
            file_path: path.to_owned(),
            op: "write",
            parent_tool_use_id: None,
            timestamp: None,
            spans: Vec::new(),
        }
    }

    #[test]
    fn pending_calls_insert_then_take_round_trips() {
        let mut p = PendingCalls::new();
        p.insert("tu-1".to_owned(), call("/a"));
        assert_eq!(p.len(), 1);
        let taken = p.take("tu-1").expect("present");
        assert_eq!(taken.file_path, "/a");
        assert_eq!(p.len(), 0);
        assert!(p.take("tu-1").is_none(), "a second take misses");
    }

    #[test]
    fn pending_calls_evicts_oldest_at_cap() {
        let mut p = PendingCalls::with_cap(2);
        p.insert("tu-1".to_owned(), call("/a"));
        p.insert("tu-2".to_owned(), call("/b"));
        p.insert("tu-3".to_owned(), call("/c")); // evicts tu-1
        assert_eq!(p.len(), 2);
        assert!(p.take("tu-1").is_none(), "oldest evicted");
        assert!(p.take("tu-2").is_some());
        assert!(p.take("tu-3").is_some());
    }

    #[test]
    fn pending_calls_reinsert_same_id_does_not_double_count_order() {
        // A re-emitted tool_use (replay) overwrites in place; the eviction
        // order must not treat it as a second live key.
        let mut p = PendingCalls::with_cap(2);
        p.insert("tu-1".to_owned(), call("/a"));
        p.insert("tu-1".to_owned(), call("/a2"));
        p.insert("tu-2".to_owned(), call("/b"));
        // tu-1 was re-inserted, not duplicated, so tu-2 fits without
        // evicting tu-1.
        assert_eq!(p.len(), 2);
        assert_eq!(p.take("tu-1").expect("still present").file_path, "/a2");
        assert!(p.take("tu-2").is_some());
    }

    #[test]
    fn into_row_carries_origin_and_at() {
        let project_dir = CanonicalPath::from_test_str("/proj");
        let row = call("/proj/a.rs")
            .into_row("tug-1", "tu-1", &project_dir, None, "replay", 42)
            .expect("no repo root, nothing to be outside of");
        assert_eq!(row.tug_session_id, "tug-1");
        assert_eq!(row.tool_use_id, "tu-1");
        // No repo root → the canonical absolute path is stored.
        assert_eq!(row.file_path, "/proj/a.rs");
        assert_eq!(row.project_dir, "/proj");
        assert_eq!(row.origin, "replay");
        assert_eq!(row.at, 42);
        assert!(!row.ambiguous);
    }

    /// An exact tool call under a canonical repo root records its file
    /// repo-relative at capture time.
    #[test]
    fn into_row_stores_repo_relative() {
        let project_dir = CanonicalPath::from_test_str("/repo");
        let repo_root = CanonicalPath::from_test_str("/repo");
        let row = call("/repo/arc/rail-frame.md")
            .into_row("tug-1", "tu-1", &project_dir, Some(&repo_root), "exact", 1)
            .expect("in-repo file records");
        assert_eq!(row.file_path, "arc/rail-frame.md");
        assert_eq!(row.project_dir, "/repo");
    }

    /// A repo project's session writing a file outside the checkout — a memory
    /// file under `~/.claude/…` is the everyday case — records nothing. The
    /// compose fold matches events against git's repo-relative dirty paths, so
    /// the row could never surface anywhere; it would only accumulate.
    #[test]
    fn into_row_skips_a_file_outside_the_repo() {
        let project_dir = CanonicalPath::from_test_str("/repo");
        let repo_root = CanonicalPath::from_test_str("/repo");
        assert!(
            call("/elsewhere/memory/note.md")
                .into_row("tug-1", "tu-1", &project_dir, Some(&repo_root), "exact", 1)
                .is_none()
        );
    }

    /// The skip is measured after gateway canonicalization, so an in-repo file
    /// reached through a symlinked spelling still records — the skip can only
    /// eat files that are genuinely elsewhere.
    #[cfg(unix)]
    #[test]
    fn into_row_records_an_in_repo_file_spelled_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/a.rs"), "x").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let root = CanonicalPath::from_raw(&repo);
        let row = call(&link.join("src/a.rs").to_string_lossy())
            .into_row("tug-1", "tu-1", &root, Some(&root), "exact", 1)
            .expect("the symlinked spelling canonicalizes into the repo");
        assert_eq!(row.file_path, "src/a.rs");
    }

    /// Repo membership is a per-file fact: a file inside a nested worktree
    /// (a `.git` FILE under an outer repo's `.git` DIRECTORY — the arc
    /// layout, `.tug/worktrees/<name>/…`) resolves to the worktree's own
    /// root, never the outer checkout's. This is the pinned regression for
    /// the misfiled arc-session rows (`.tug/worktrees/…` paths keyed to the
    /// main root, invisible to every reader).
    #[tokio::test]
    async fn file_repo_root_resolves_the_nested_worktrees_own_root() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        std::fs::create_dir_all(outer.join(".git")).unwrap();
        let wt = outer.join(".tug/worktrees/demo");
        std::fs::create_dir_all(wt.join("src")).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: elsewhere\n").unwrap();
        let file = wt.join("src/a.rs");
        std::fs::write(&file, "x").unwrap();

        let root = file_repo_root(&file.to_string_lossy())
            .await
            .expect("inside a repo");
        assert!(
            root.as_path().ends_with(".tug/worktrees/demo"),
            "the worktree's own root wins: {root:?}"
        );
        let row = call(&file.to_string_lossy())
            .into_row("tug-1", "tu-1", &root, Some(&root), "exact", 1)
            .expect("the worktree file records against the worktree root");
        assert_eq!(row.file_path, "src/a.rs", "worktree-relative, not .tug/…");
        assert_eq!(row.project_dir, root.as_str());

        // A file directly in the outer checkout still resolves there.
        let outer_file = outer.join("b.rs");
        std::fs::write(&outer_file, "x").unwrap();
        let outer_root = file_repo_root(&outer_file.to_string_lossy())
            .await
            .expect("inside a repo");
        assert!(outer_root.as_path().ends_with("outer"), "{outer_root:?}");
    }

    /// A non-repo project dir has no root to strip against, so the canonical
    /// absolute path is stored — compose then treats it as unattributed
    /// against git, same as before.
    #[test]
    fn into_row_no_repo_root_keeps_absolute_canonical() {
        let project_dir = CanonicalPath::from_test_str("/nonrepo");
        let row = call("/nonrepo/a.rs")
            .into_row("tug-1", "tu-1", &project_dir, None, "exact", 1)
            .expect("a non-repo project keeps recording absolute paths");
        assert_eq!(row.file_path, "/nonrepo/a.rs");
    }

    // ---- Bash bracketing --------------------------------------------

    fn state(status: &str) -> FileState {
        FileState {
            status: status.to_owned(),
            mtime: None,
        }
    }

    /// A bracket whose command named nothing this grammar reads — every row
    /// stays correlation.
    fn nothing_declared() -> DeclaredPromotions {
        DeclaredPromotions::default()
    }

    /// Promotions as a real parse would build them, so the test exercises the
    /// kind → reach mapping rather than restating it.
    fn promotions(ops: &[(DeclaredKind, &str)]) -> DeclaredPromotions {
        let ops: Vec<DeclaredOp> = ops
            .iter()
            .map(|(kind, path)| DeclaredOp {
                kind: kind.clone(),
                path: PathBuf::from(path),
            })
            .collect();
        DeclaredPromotions::from_ops(ops.iter())
    }

    #[test]
    fn op_from_status_maps_transitions() {
        assert_eq!(op_from_status("?"), "created");
        assert_eq!(op_from_status("A."), "created");
        assert_eq!(op_from_status(".M"), "modified");
        assert_eq!(op_from_status("M."), "modified");
        assert_eq!(op_from_status(".D"), "deleted");
        assert_eq!(op_from_status("R."), "renamed");
    }

    #[test]
    fn classify_op_detects_appear_disappear_and_no_change() {
        // Appeared in the dirty set.
        assert_eq!(classify_op(None, Some(&state("?")), true), Some("created"));
        assert_eq!(
            classify_op(None, Some(&state(".M")), true),
            Some("modified")
        );
        // Fell out of the dirty set but still on disk (reverted / committed).
        assert_eq!(
            classify_op(Some(&state(".M")), None, true),
            Some("modified")
        );
        // Fell out of the dirty set and off the disk: an untracked file the
        // command deleted, which never earns a ` D` status.
        assert_eq!(classify_op(Some(&state("?")), None, false), Some("deleted"));
        // Unchanged status AND mtime → no attribution.
        assert_eq!(
            classify_op(Some(&state(".M")), Some(&state(".M")), true),
            None
        );
    }

    #[test]
    fn classify_op_same_status_different_mtime_is_a_change() {
        // A file already `M` before the command, modified again by it: the
        // status doesn't move but mtime does, so it must still attribute.
        let pre = FileState {
            status: ".M".to_owned(),
            mtime: Some(SystemTime::UNIX_EPOCH),
        };
        let post = FileState {
            status: ".M".to_owned(),
            mtime: Some(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1)),
        };
        assert_eq!(classify_op(Some(&pre), Some(&post), true), Some("modified"));
    }

    #[test]
    fn into_delta_rows_covers_create_modify_delete_rename() {
        let mut pre = HashMap::new();
        pre.insert(PathBuf::from("/r/mod.rs"), state(".M")); // stays, mtime same → no row
        pre.insert(PathBuf::from("/r/gone.rs"), state(".M")); // disappears, no disk file → deleted
        let mut post = HashMap::new();
        post.insert(PathBuf::from("/r/mod.rs"), state(".M"));
        post.insert(PathBuf::from("/r/new.rs"), state("?")); // created
        post.insert(PathBuf::from("/r/del.rs"), state(".D")); // deleted
        post.insert(PathBuf::from("/r/ren.rs"), state("R.")); // renamed

        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: Some("agent-1".to_owned()),
            opened_at: 10,
            repo_root: PathBuf::from("/r"),
            pre,
        };
        let project_dir = CanonicalPath::from_test_str("/proj");
        let mut rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::none(),
            99,
        );
        rows.sort_by(|a, b| a.file_path.cmp(&b.file_path));

        // file_path is repo-relative (stripped against the bracket's repo_root).
        let by_path: HashMap<&str, &str> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), r.op.as_str()))
            .collect();
        assert_eq!(by_path.get("new.rs"), Some(&"created"));
        assert_eq!(by_path.get("del.rs"), Some(&"deleted"));
        assert_eq!(by_path.get("ren.rs"), Some(&"renamed"));
        assert_eq!(by_path.get("gone.rs"), Some(&"deleted"));
        assert!(!by_path.contains_key("mod.rs"), "unchanged path has no row");
        // Every row carries Bash/bash provenance, the parent id, and the
        // owning session's project_dir. `ambiguous` is always false: a
        // bracket records provenance only, never a cross-session judgment.
        for r in &rows {
            assert_eq!(r.tool_name, "Bash");
            assert_eq!(r.origin, "bash");
            assert_eq!(r.tug_session_id, "tug-1");
            assert_eq!(r.parent_tool_use_id.as_deref(), Some("agent-1"));
            assert_eq!(r.project_dir, "/proj");
            assert!(!r.ambiguous);
        }
    }

    #[test]
    fn a_declared_path_promotes_its_delta_row_to_proof() {
        let mut post = HashMap::new();
        post.insert(PathBuf::from("/r/named.rs"), state(".D"));
        post.insert(PathBuf::from("/r/swept.rs"), state(".M"));
        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: PathBuf::from("/r"),
            pre: HashMap::new(),
        };
        let declared = promotions(&[(DeclaredKind::EditInPlace, "/r/named.rs")]);
        let project_dir = CanonicalPath::from_test_str("/r");
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::declaring(&declared),
            1,
        );
        let by_path: HashMap<&str, &str> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), r.origin.as_str()))
            .collect();
        // The command named this one: proof.
        assert_eq!(by_path.get("named.rs"), Some(&"cmd"));
        // This one only moved during the window — it could as easily be a build
        // or the user's own save, so it stays a hint.
        assert_eq!(by_path.get("swept.rs"), Some(&"bash"));
    }

    #[test]
    fn a_declared_directory_promotes_the_files_beneath_it() {
        // `rm -rf out/` names the directory; `-uall` reports the files inside.
        let mut post = HashMap::new();
        post.insert(PathBuf::from("/r/out/a.rs"), state(".D"));
        post.insert(PathBuf::from("/r/out/nested/b.rs"), state(".D"));
        post.insert(PathBuf::from("/r/outside.rs"), state(".M"));
        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: PathBuf::from("/r"),
            pre: HashMap::new(),
        };
        let declared = promotions(&[(DeclaredKind::Remove, "/r/out")]);
        let project_dir = CanonicalPath::from_test_str("/r");
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::declaring(&declared),
            1,
        );
        let by_path: HashMap<&str, &str> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), r.origin.as_str()))
            .collect();
        assert_eq!(by_path.get("out/a.rs"), Some(&"cmd"));
        assert_eq!(by_path.get("out/nested/b.rs"), Some(&"cmd"));
        // A sibling whose name merely shares the prefix is not beneath it.
        assert_eq!(by_path.get("outside.rs"), Some(&"bash"));
    }

    /// Reaching beneath a declared path is a lifecycle privilege. An
    /// edit-class verb names files, so a directory operand promotes nothing
    /// under it — the shape that minted proof over a whole subtree.
    #[test]
    fn an_edit_class_directory_promotes_nothing_beneath_it() {
        let mut post = HashMap::new();
        post.insert(PathBuf::from("/r/dir/a.ts"), state(".M"));
        post.insert(PathBuf::from("/r/dir"), state(".M"));
        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: PathBuf::from("/r"),
            pre: HashMap::new(),
        };
        let project_dir = CanonicalPath::from_test_str("/r");
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::declaring(&promotions(&[(DeclaredKind::EditInPlace, "/r/dir")])),
            1,
        );
        let by_path: HashMap<&str, &str> = rows
            .iter()
            .map(|r| (r.file_path.as_str(), r.origin.as_str()))
            .collect();
        assert_eq!(by_path.get("dir/a.ts"), Some(&"bash"));
        // The declared path itself still promotes on equality.
        assert_eq!(by_path.get("dir"), Some(&"cmd"));
    }

    /// The 2026-08-13 incident: `git checkout <sha> -- tugdeck` observed a
    /// whole subtree change and minted proof over all of it. A restore
    /// declares its operands for the gate but promotes nothing.
    #[test]
    fn a_restore_promotes_nothing_even_over_the_paths_it_named() {
        let mut post = HashMap::new();
        post.insert(PathBuf::from("/r/tugdeck/src/a.tsx"), state(".M"));
        post.insert(PathBuf::from("/r/tugdeck/src/b.css"), state(".M"));
        post.insert(PathBuf::from("/r/tugdeck"), state(".M"));
        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: PathBuf::from("/r"),
            pre: HashMap::new(),
        };
        let project_dir = CanonicalPath::from_test_str("/r");
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::declaring(&promotions(&[(DeclaredKind::Restore, "/r/tugdeck")])),
            1,
        );
        assert!(!rows.is_empty(), "the delta is still observed");
        for row in &rows {
            assert_eq!(
                row.origin, "bash",
                "{} is a bracket hint, not authorship",
                row.file_path
            );
        }
    }

    #[test]
    fn declared_ops_come_only_from_readable_commands() {
        let base = Path::new("/repo");
        assert!(declared_ops_for_command("rm a.ts", base).is_some());
        // A refusal mints nothing — the paths stay bracket hints.
        assert!(declared_ops_for_command("rm -rf apptest-*", base).is_none());
        assert!(declared_ops_for_command("cargo build", base).is_none());
    }

    #[test]
    fn tool_result_output_survives_absence_and_wrong_shapes() {
        let with_output = InspectedToolResult::from_slice(
            br#"{"tool_use_id":"tu-1","is_error":false,"output":"TUG-FILE-RECEIPT: {}"}"#,
        )
        .expect("parses");
        assert_eq!(with_output.output, "TUG-FILE-RECEIPT: {}");

        let legacy = InspectedToolResult::from_slice(br#"{"tool_use_id":"tu-1"}"#).expect("parses");
        assert_eq!(legacy.output, "");

        // A structured output costs the receipt, never the frame.
        let structured =
            InspectedToolResult::from_slice(br#"{"tool_use_id":"tu-1","output":{"a":1}}"#)
                .expect("parses");
        assert_eq!(structured.output, "");
    }

    #[test]
    fn an_edit_error_line_parses_whole() {
        let marker = parse_edit_error_line(
            "error: nothing was written\nTUG-EDIT-ERROR: {\"class\":\"resolve\",\"exit\":3,\"ops_resolved\":1,\"ops_total\":3,\"files\":[\"a.rs\"],\"program\":\"file a.rs\\n\"}\n",
        )
        .expect("the marker parses");
        assert_eq!(marker["class"], "resolve");
        assert_eq!(marker["exit"], 3);
        assert_eq!(marker["ops_total"], 3);
        assert_eq!(
            marker["program"], "file a.rs\n",
            "the block is kept whole, program and all"
        );
    }

    /// The timid posture: a line that carries the prefix but not a readable
    /// marker records nothing at all. A guessed failure reads exactly like a
    /// real one.
    #[test]
    fn a_malformed_edit_error_line_yields_nothing() {
        assert!(parse_edit_error_line("TUG-EDIT-ERROR: {\"class\":").is_none());
        assert!(parse_edit_error_line("TUG-EDIT-ERROR: 42").is_none());
        assert!(
            parse_edit_error_line("TUG-EDIT-ERROR: {\"exit\":3}").is_none(),
            "a marker with no class names no failure"
        );
        assert!(parse_edit_error_line("just some output").is_none());
    }

    /// A compound command stops at its first failure, so the first marker is
    /// the one that explains the run.
    #[test]
    fn the_first_of_several_edit_error_lines_wins() {
        let out =
            "TUG-EDIT-ERROR: {\"class\":\"parse\"}\nTUG-EDIT-ERROR: {\"class\":\"resolve\"}\n";
        assert_eq!(parse_edit_error_line(out).unwrap()["class"], "parse");
    }

    #[test]
    fn a_receipt_is_read_out_of_the_surrounding_output() {
        let output = "removing 2 files\nTUG-FILE-RECEIPT: {\"ops\":[{\"op\":\"deleted\",\"path\":\"/abs/a.ts\"},{\"op\":\"renamed\",\"path\":\"/abs/new.ts\",\"orig_path\":\"/abs/old.ts\"}]}\ndone\n";
        let scan = parse_receipt_line(output);
        assert!(!scan.malformed);
        assert_eq!(
            scan.ops,
            vec![
                ReceiptOp {
                    op: "deleted".to_owned(),
                    path: "/abs/a.ts".to_owned(),
                    orig_path: None,
                    hunks: Vec::new(),
                },
                ReceiptOp {
                    op: "renamed".to_owned(),
                    path: "/abs/new.ts".to_owned(),
                    orig_path: Some("/abs/old.ts".to_owned()),
                    hunks: Vec::new(),
                },
            ]
        );
    }

    /// A probe's receipt carries no operation and a restore list — the
    /// receipt's negative space. An older relay ignored the unknown field
    /// entirely, which is why it could be added at all.
    #[test]
    fn a_probe_receipt_declares_what_it_put_back() {
        let output = concat!(
            "running 1 test\n",
            "TUG-FILE-RECEIPT: {\"ops\":[],\"restored\":[\"/abs/a.rs\",\"/abs/b.rs\"]}\n",
        );
        let scan = parse_receipt_line(output);
        assert!(!scan.malformed);
        assert!(
            scan.ops.is_empty(),
            "a restore is not an operation to attribute"
        );
        assert_eq!(scan.restored, vec!["/abs/a.rs", "/abs/b.rs"]);
    }

    /// The suppression, at the one place that decides whether a path gets a
    /// row. This is the regression the mtime rewind used to hide: the probe
    /// now leaves an honest (newer) mtime, so the delta genuinely sees a
    /// change and the declaration is the only thing keeping the hint away.
    #[test]
    fn a_declared_restore_drops_the_hint_its_mtime_change_would_have_minted() {
        let mut pre = HashMap::new();
        pre.insert(PathBuf::from("/r/probed.rs"), state(".M"));
        pre.insert(PathBuf::from("/r/edited.rs"), state(".M"));
        // Both files were rewritten during the bracket — same status, newer
        // mtime — which is exactly what a probe's restore looks like now.
        let touched = FileState {
            status: ".M".to_owned(),
            mtime: Some(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(9)),
        };
        let mut post = HashMap::new();
        post.insert(PathBuf::from("/r/probed.rs"), touched.clone());
        post.insert(PathBuf::from("/r/edited.rs"), touched);

        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: PathBuf::from("/r"),
            pre,
        };
        let project_dir = CanonicalPath::from_test_str("/r");
        let restored: HashSet<CanonicalPath> = [CanonicalPath::from_test_str("/r/probed.rs")]
            .into_iter()
            .collect();
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::restoring(&restored),
            7,
        );
        let paths: Vec<&str> = rows.iter().map(|r| r.file_path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["edited.rs"],
            "the restored path is dropped; the genuinely rewritten one is not"
        );
    }

    #[test]
    fn receipt_scanning_tolerates_absence_and_growth_but_flags_malformed_json() {
        assert_eq!(
            parse_receipt_line("just some output"),
            ReceiptScan::default()
        );

        // Unknown fields are ignored, so the receipt can grow additively.
        let future = "TUG-FILE-RECEIPT: {\"ops\":[{\"op\":\"deleted\",\"path\":\"/abs/a.ts\",\"mode\":\"100644\"}],\"emitted_by\":\"v2\"}";
        let scan = parse_receipt_line(future);
        assert_eq!(scan.ops.len(), 1);
        assert!(!scan.malformed);

        // Broken JSON is loud, not silent (invariant 12).
        let broken = parse_receipt_line("TUG-FILE-RECEIPT: {\"ops\":[");
        assert!(broken.ops.is_empty());
        assert!(broken.malformed);
    }

    // ---- span capture ([P11], Spec S04, Spec S05) -----------------------

    fn anchor_of(span: &crate::session_ledger::FileEventSpan) -> serde_json::Value {
        serde_json::from_str(&span.anchor).expect("anchor is JSON")
    }

    #[test]
    fn a_write_asserts_the_whole_file_and_records_what_it_wrote() {
        let content = "fn main() {\n    println!(\"distinctive\");\n}\n";
        let input = serde_json::json!({"file_path": "/p/a.rs", "content": content});
        let spans = spans_for_tool_input("Write", &input);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "whole");
        // The assertion is whole-file, but it says which bytes it is about,
        // so a later diff can contradict it ([P04]).
        let anchor = anchor_of(&spans[0]);
        assert_eq!(
            anchor["file_hash"],
            serde_json::json!(tugchanges_core::content_hash(content))
        );
        assert_eq!(
            anchor["line_hashes"],
            serde_json::json!(vec![
                tugchanges_core::content_hash("fn main() {"),
                tugchanges_core::content_hash("    println!(\"distinctive\");"),
            ]),
            "the closing-brace line is not distinctive and contributes no hash"
        );
        assert_eq!(anchor["added_lines"], serde_json::json!(3));

        // A notebook edit replaces its cell wholesale, same reading.
        let notebook = serde_json::json!({
            "notebook_path": "/p/a.ipynb",
            "new_source": "import distinctive\n",
        });
        let notebook_spans = spans_for_tool_input("NotebookEdit", &notebook);
        assert_eq!(notebook_spans[0].kind, "whole");
        assert_eq!(
            anchor_of(&notebook_spans[0])["file_hash"],
            serde_json::json!(tugchanges_core::content_hash("import distinctive\n"))
        );
    }

    #[test]
    fn a_write_with_no_content_to_record_keeps_the_bare_shape() {
        // Nothing to be falsified by, so nothing is claimed about the bytes —
        // the unfalsifiable floor, decoded as a plain whole-file claim.
        let input = serde_json::json!({"file_path": "/p/a.rs"});
        let spans = spans_for_tool_input("Write", &input);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "whole");
        assert_eq!(anchor_of(&spans[0]), serde_json::json!({}));
        assert_eq!(
            tugchanges_core::Anchor::from_span(&spans[0].kind, &spans[0].anchor),
            tugchanges_core::Anchor::Whole
        );
    }

    #[test]
    fn a_recorded_write_decodes_as_the_falsifiable_shape() {
        // Writer and decoder are two crates apart; pin the round trip rather
        // than the JSON on either side alone.
        let content = "the distinctive line\n";
        let input = serde_json::json!({"file_path": "/p/a.rs", "content": content});
        let span = &spans_for_tool_input("Write", &input)[0];
        assert_eq!(
            tugchanges_core::Anchor::from_span(&span.kind, &span.anchor),
            tugchanges_core::Anchor::WholeFile {
                file_hash: tugchanges_core::content_hash(content),
                line_hashes: vec![tugchanges_core::content_hash("the distinctive line")],
                added_head: "the distinctive line".to_owned(),
            }
        );
    }

    #[test]
    fn an_edit_anchors_on_what_it_added_not_where() {
        let input = serde_json::json!({
            "file_path": "/p/a.rs",
            "old_string": "let x = 1;",
            "new_string": "let x = 2;",
        });
        let spans = spans_for_tool_input("Edit", &input);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "replace");
        assert_eq!(spans[0].seq, 0);
        let anchor = anchor_of(&spans[0]);
        assert_eq!(
            anchor["line_hashes"],
            serde_json::json!([tugchanges_core::hunks::content_hash("let x = 2;")])
        );
        assert_eq!(anchor["added_lines"], 1);
        assert_eq!(anchor["added_head"], "let x = 2;");
        // Nothing in the anchor is a line number — that is the whole point.
        assert!(anchor.get("line").is_none() && anchor.get("offset").is_none());
    }

    #[test]
    fn context_lines_stay_out_of_the_recorded_anchor() {
        // The shape the field actually produces: an Edit quoting a neighbour
        // line for uniqueness. That line is context in the diff, so an anchor
        // carrying it could never match the hunk it belongs to.
        let input = serde_json::json!({
            "file_path": "/p/a.tsx",
            "old_string": "            glyphPosition=\"both\"\n            size={12}",
            "new_string": "            glyphPosition=\"both\"\n            size={14}",
        });
        let anchor = anchor_of(&spans_for_tool_input("Edit", &input)[0]);
        assert_eq!(
            anchor["line_hashes"],
            serde_json::json!([tugchanges_core::hunks::content_hash(
                "            size={14}"
            )]),
            "only the changed line is evidence"
        );
        assert_eq!(anchor["added_head"], "            size={14}");
    }

    #[test]
    fn an_edit_with_no_old_string_is_an_insert() {
        let input = serde_json::json!({
            "file_path": "/p/a.rs",
            "old_string": "",
            "new_string": "added line one\nadded line two\n",
        });
        let spans = spans_for_tool_input("Edit", &input);
        assert_eq!(spans[0].kind, "insert");
        let anchor = anchor_of(&spans[0]);
        assert_eq!(
            anchor["line_hashes"],
            serde_json::json!([
                tugchanges_core::hunks::content_hash("added line one"),
                tugchanges_core::hunks::content_hash("added line two"),
            ]),
            "with nothing replaced, every distinctive line is added"
        );
        assert!(anchor.get("old_hash").is_none());
    }

    #[test]
    fn a_multi_edit_anchors_every_edit_in_order() {
        let input = serde_json::json!({
            "file_path": "/p/a.rs",
            "edits": [
                {"old_string": "a", "new_string": "A"},
                {"old_string": "", "new_string": "B"},
            ],
        });
        let spans = spans_for_tool_input("MultiEdit", &input);
        assert_eq!(spans.len(), 2);
        assert_eq!((spans[0].seq, spans[0].kind.as_str()), (0, "replace"));
        assert_eq!((spans[1].seq, spans[1].kind.as_str()), (1, "insert"));
        for span in &spans {
            assert!(
                anchor_of(span).get("line_hashes").is_some(),
                "every edit records the added-lines shape"
            );
        }
    }

    #[test]
    fn an_edit_past_the_anchor_cap_widens_to_whole() {
        let edits: Vec<serde_json::Value> = (0..=SPANS_PER_EVENT_CAP)
            .map(|n| serde_json::json!({"old_string": format!("a{n}"), "new_string": format!("b{n}")}))
            .collect();
        let input = serde_json::json!({"file_path": "/p/a.rs", "edits": edits});
        let spans = spans_for_tool_input("MultiEdit", &input);
        assert_eq!(spans.len(), 1, "past the cap the call claims the file");
        assert_eq!(spans[0].kind, "whole");
    }

    #[test]
    fn a_long_insertion_keeps_a_capped_head_and_full_line_hashes() {
        let long: String = (0..40)
            .map(|n| format!("inserted line {n} of a long block\n"))
            .collect();
        let input = serde_json::json!({
            "file_path": "/p/a.rs",
            "old_string": "",
            "new_string": long,
        });
        let anchor = anchor_of(&spans_for_tool_input("Edit", &input)[0]);
        assert!(anchor["added_head"].as_str().unwrap().len() <= SPAN_HEAD_CAP);
        assert_eq!(anchor["added_lines"], 40, "the count is not capped");
        assert_eq!(
            anchor["line_hashes"].as_array().unwrap().len(),
            ANCHOR_LINE_HASH_CAP,
            "the hashes are"
        );
        assert_eq!(
            anchor["line_hashes"][0],
            tugchanges_core::hunks::content_hash("inserted line 0 of a long block")
        );
    }

    #[test]
    fn a_bash_call_yields_no_spans() {
        // A parsed command names files, not regions ([Q03]) — span-less
        // evidence widens to the whole file by rule, today's exact behavior.
        let input = serde_json::json!({"command": "sed -i '' s/a/b/ x.rs"});
        assert!(spans_for_tool_input("Bash", &input).is_empty());
    }

    #[test]
    fn a_receipts_hunk_ids_become_hunk_anchors() {
        let spans = hunk_spans(&["aaaa1111bbbb2222".to_owned(), "cccc3333dddd4444".to_owned()]);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[1].kind, "hunk");
        assert_eq!(anchor_of(&spans[1])["hunk_id"], "cccc3333dddd4444");
    }

    #[test]
    fn a_receipt_carries_its_hunk_ids_and_still_reads_without_them() {
        let with = "TUG-FILE-RECEIPT: {\"ops\":[{\"op\":\"modified\",\"path\":\"/abs/a.ts\",\"hunks\":[\"aaaa1111bbbb2222\"]}]}";
        let scan = parse_receipt_line(with);
        assert_eq!(scan.ops[0].hunks, vec!["aaaa1111bbbb2222".to_owned()]);

        // A receipt from a build that predates Spec S05 still reads — it just
        // has nothing to say about regions.
        let without = "TUG-FILE-RECEIPT: {\"ops\":[{\"op\":\"modified\",\"path\":\"/abs/a.ts\"}]}";
        assert!(parse_receipt_line(without).ops[0].hunks.is_empty());
    }

    #[test]
    fn only_known_receipt_ops_record() {
        assert_eq!(op_for_receipt("deleted"), Some("deleted"));
        assert_eq!(op_for_receipt("renamed"), Some("renamed"));
        assert_eq!(op_for_receipt("created"), Some("created"));
        assert_eq!(op_for_receipt("teleported"), None);
    }

    #[test]
    fn the_bash_command_is_read_from_the_tool_input() {
        let input = serde_json::json!({ "command": "rm a.ts" });
        assert_eq!(
            bash_command_for_tool("Bash", &input).as_deref(),
            Some("rm a.ts")
        );
        assert_eq!(bash_command_for_tool("Write", &input), None);
    }

    #[test]
    fn parse_worktree_states_reads_ordinary_rename_untracked() {
        let output = "\
# branch.oid abc
# branch.head main
1 .M N... 100644 100644 100644 aaa bbb src/mod.rs
2 R. N... 100644 100644 100644 aaa bbb R100 dst.rs\tsrc.rs
? new.txt
u UU N... 0 0 0 0 unmerged.rs
";
        let states = parse_worktree_states(output);
        let by: HashMap<&str, &str> = states
            .iter()
            .map(|(p, s)| (p.as_str(), s.as_str()))
            .collect();
        assert_eq!(by.get("src/mod.rs"), Some(&".M"));
        assert_eq!(by.get("dst.rs"), Some(&"R."), "rename reports the new path");
        assert_eq!(by.get("new.txt"), Some(&"?"));
        assert!(!by.contains_key("unmerged.rs"), "unmerged entries skipped");
    }

    // ---- real-git integration (snapshot + repo-root walk) -----------

    /// Init a git repo in a fresh tempdir with one committed file, so
    /// snapshots start from a clean working tree.
    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let run = |args: &[&str]| {
            let ok = tugcore::git_command()
                .args(args)
                .current_dir(root)
                .output()
                .expect("git")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t.test"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").expect("write a.txt");
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        dir
    }

    #[tokio::test]
    async fn snapshot_and_delta_over_a_real_repo() {
        let repo = init_repo();
        let root = repo.path().to_path_buf();

        // Clean tree → empty fingerprint.
        let pre = snapshot_worktree(&root).await;
        assert!(pre.is_empty(), "committed clean tree has no dirty paths");

        // A "Bash command" modifies a tracked file and creates a new one.
        std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("modify a.txt");
        std::fs::write(root.join("b.txt"), "new\n").expect("create b.txt");

        let post = snapshot_worktree(&root).await;
        assert!(post.contains_key(&root.join("a.txt")));
        assert!(post.contains_key(&root.join("b.txt")));

        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: root.clone(),
            pre,
        };
        let project_dir = CanonicalPath::from_test_str(root.to_str().unwrap());
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::none(),
            5,
        );
        let by_path: HashMap<String, String> = rows
            .iter()
            .map(|r| (r.file_path.clone(), r.op.clone()))
            .collect();
        // Repo-relative paths, stripped against the bracket's repo_root.
        assert_eq!(by_path.get("a.txt"), Some(&"modified".to_owned()));
        assert_eq!(by_path.get("b.txt"), Some(&"created".to_owned()));
    }

    #[tokio::test]
    async fn a_deleted_untracked_file_is_deleted_and_a_committed_one_is_modified() {
        let repo = init_repo();
        let root = repo.path().to_path_buf();
        let run = |args: &[&str]| {
            tugcore::git_command()
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git");
        };

        // Both paths are dirty pre-command: one untracked, one modified.
        std::fs::write(root.join("scratch.txt"), "temp\n").expect("write scratch");
        std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("modify a.txt");
        let pre = snapshot_worktree(&root).await;
        assert!(pre.contains_key(&root.join("scratch.txt")));

        // The command deletes the untracked file and commits the tracked one —
        // both leave the dirty set, only one leaves the disk.
        std::fs::remove_file(root.join("scratch.txt")).expect("rm scratch");
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "landed"]);

        let post = snapshot_worktree(&root).await;
        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "tu-bash".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: root.clone(),
            pre,
        };
        let project_dir = CanonicalPath::from_test_str(root.to_str().unwrap());
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::none(),
            5,
        );
        let by_path: HashMap<String, String> = rows
            .iter()
            .map(|r| (r.file_path.clone(), r.op.clone()))
            .collect();
        assert_eq!(by_path.get("scratch.txt"), Some(&"deleted".to_owned()));
        assert_eq!(by_path.get("a.txt"), Some(&"modified".to_owned()));
    }

    #[tokio::test]
    async fn repo_root_for_finds_root_and_rejects_non_repo() {
        let repo = init_repo();
        let root = repo.path();
        // From the root and from a subdir, the walk lands on the repo root.
        assert_eq!(repo_root_for(root).await.as_deref(), Some(root));
        let sub = root.join("nested/deeper");
        std::fs::create_dir_all(&sub).expect("mkdir");
        assert_eq!(repo_root_for(&sub).await.as_deref(), Some(root));

        // A tempdir with no `.git` ancestor is not a repo.
        let non_repo = tempfile::tempdir().expect("tempdir");
        assert_eq!(repo_root_for(non_repo.path()).await, None);
    }

    #[test]
    fn into_delta_rows_carries_the_given_tool_name_and_origin() {
        // The turn-scoped fallback bracket ([P05]) reuses this with
        // ("Turn", "turn"); the same delta machinery, a different provenance.
        let mut post = HashMap::new();
        post.insert(PathBuf::from("/r/a.rs"), state("?"));
        let bracket = OpenBracket {
            tug_session_id: "tug-1".to_owned(),
            tool_use_id: "turn:1000".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: PathBuf::from("/r"),
            pre: HashMap::new(),
        };
        let project_dir = CanonicalPath::from_test_str("/proj");
        let rows = bracket.into_delta_rows(
            &post,
            &project_dir,
            "Turn",
            "turn",
            &CommandClaims::none(),
            7,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tool_name, "Turn");
        assert_eq!(rows[0].origin, "turn");
        assert_eq!(rows[0].op, "created");
    }

    #[tokio::test]
    async fn snapshot_lists_a_file_inside_an_untracked_directory() {
        // -uall ([P06]/G5): a file inside a brand-new untracked directory is
        // listed as itself, not collapsed to a bare `newdir/` entry the join
        // can't use.
        let repo = init_repo();
        let root = repo.path().to_path_buf();
        std::fs::create_dir(root.join("newdir")).unwrap();
        std::fs::write(root.join("newdir/inner.rs"), "x\n").unwrap();

        let snap = snapshot_worktree(&root).await;
        assert!(
            snap.contains_key(&root.join("newdir/inner.rs")),
            "the file inside the untracked dir is fingerprinted: {snap:?}"
        );
        assert!(
            !snap.contains_key(&root.join("newdir")),
            "the bare directory is not a fingerprint entry"
        );
    }

    #[tokio::test]
    async fn snapshot_of_non_repo_is_empty() {
        // git fails outside a repo → degrade to an empty snapshot, never a
        // wrong guess.
        let non_repo = tempfile::tempdir().expect("tempdir");
        assert!(snapshot_worktree(non_repo.path()).await.is_empty());
    }

    #[tokio::test]
    async fn overlapping_brackets_on_one_repo_never_mark_ambiguous() {
        // The pinned regression: two sessions bracket the same checkout with
        // overlapping windows, each touching a DIFFERENT file. Wall-clock
        // overlap is not evidence of contention — every delta row records
        // provenance only, never a cross-session judgment. (Genuine same-file
        // contention surfaces at read time, when both sessions hold rows for
        // the same path.)
        let repo = init_repo();
        let root = repo.path().to_path_buf();

        // Session A opens; then B opens (overlap) while A is still open.
        let pre_a = snapshot_worktree(&root).await;
        let a = OpenBracket {
            tug_session_id: "tug-A".to_owned(),
            tool_use_id: "tu-A".to_owned(),
            parent_tool_use_id: None,
            opened_at: 0,
            repo_root: root.clone(),
            pre: pre_a,
        };
        let pre_b = snapshot_worktree(&root).await;
        let b = OpenBracket {
            tug_session_id: "tug-B".to_owned(),
            tool_use_id: "tu-B".to_owned(),
            parent_tool_use_id: None,
            opened_at: 1,
            repo_root: root.clone(),
            pre: pre_b,
        };

        // Each session's command touches a different file.
        std::fs::write(root.join("from_a.txt"), "a\n").unwrap();
        std::fs::write(root.join("from_b.txt"), "b\n").unwrap();

        let project_dir = CanonicalPath::from_test_str(root.to_str().unwrap());
        let post_a = snapshot_worktree(&root).await;
        let rows_a = a.into_delta_rows(
            &post_a,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::none(),
            2,
        );
        let post_b = snapshot_worktree(&root).await;
        let rows_b = b.into_delta_rows(
            &post_b,
            &project_dir,
            "Bash",
            "bash",
            &CommandClaims::none(),
            3,
        );

        assert!(!rows_a.is_empty() && !rows_b.is_empty());
        assert!(
            rows_a.iter().all(|r| !r.ambiguous) && rows_b.iter().all(|r| !r.ambiguous),
            "no bracket row is ever marked ambiguous"
        );
    }
}
