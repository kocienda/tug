//! External-session scanner — JSONL metadata extraction for sessions
//! that have no `SessionLedger` row (typically sessions created by the
//! Claude Code terminal app).
//!
//! The picker's `list_sessions` response is a union of ledger rows and
//! the on-disk reality under `~/.claude/projects/<encoded-dir>/`. This
//! module supplies the on-disk half: for each candidate `*.jsonl` it
//! extracts the metadata the picker renders (turn count, last user
//! prompt, auto-title, timestamps) in a single streaming pass — no
//! full-file buffering, so multi-hundred-MB transcripts stream in
//! bounded memory.
//!
//! Exclusion rules guard against two hazards of the lossy `/`→`-`
//! directory encoding and the shared-directory layout:
//!
//! - A record-level `cwd` that differs from the queried `project_dir`
//!   means the file belongs to a *different* project whose absolute
//!   path encodes to the same directory name; the file is skipped.
//! - A record-level `sessionId` that differs from the filename stem
//!   means the file is not a plain session transcript; skipped.
//!
//! The user-submission test mirrors tugcode's `isUserSubmissionContent`
//! (`tugcode/src/session.ts`): string `message.content`, or an array
//! carrying at least one non-`tool_result` block. Keep the two in sync.

#![allow(dead_code)]

use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::session_ledger::{
    ScanCacheRow, SessionLedger, SessionScanMetrics, USER_PROMPT_MAX_CHARS, claude_project_dir,
};
use crate::turn_engine::{Frontier, SigRecord, parse_significant, segment_turns, step_record};

/// Metadata extracted from one external session JSONL — the picker-
/// facing subset, plus the `(file_size, file_mtime)` validity pair the
/// scan cache keys on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalSessionMeta {
    pub session_id: String,
    pub turn_count: i64,
    pub last_user_prompt: Option<String>,
    /// Auto-title from the last `ai-title` record (`aiTitle` field),
    /// when the transcript carries one.
    pub name: Option<String>,
    pub created_at: i64,
    pub last_used_at: i64,
    pub file_size: i64,
    pub file_mtime: i64,
    /// The callsign of the line this session belongs to ([P07]), or `None`
    /// when the scan ran without a ledger to birth one against (the
    /// ledger-less [`scan_external_sessions`] path). Never derived from the
    /// session id — a real tag, permanent from the moment it is claimed.
    pub tag: Option<String>,
    /// That line's id, so a listing can fold a scanned session's segments the
    /// same way it folds a ledger row's.
    pub line_id: Option<String>,
}

/// Why a candidate file was excluded from the scan. Surfaced only via
/// tracing; the wire never carries exclusions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Exclusion {
    CwdMismatch,
    SessionIdMismatch,
    Unreadable,
}

/// Bytes of resumable-prefix tail covered by the fingerprint. Claude
/// session JSONLs are append-only in steady state; a rewind/compaction
/// rewrite that somehow preserves the final `TAIL_FINGERPRINT_BYTES`
/// at the recorded offset while changing earlier bytes would go
/// undetected — accepted: such a rewrite also restarts the file from
/// scratch in practice, changing the tail wholesale.
const TAIL_FINGERPRINT_BYTES: usize = 256;

/// FNV-1a 64 — the prefix fingerprint. Stored bit-cast to `i64` in the
/// scan cache.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Slide `bytes` into the fingerprint window, keeping only the last
/// `TAIL_FINGERPRINT_BYTES`.
fn push_tail(window: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() >= TAIL_FINGERPRINT_BYTES {
        window.clear();
        window.extend_from_slice(&bytes[bytes.len() - TAIL_FINGERPRINT_BYTES..]);
        return;
    }
    let overflow = (window.len() + bytes.len()).saturating_sub(TAIL_FINGERPRINT_BYTES);
    if overflow > 0 {
        window.drain(..overflow);
    }
    window.extend_from_slice(bytes);
}

/// The accumulator state a resumed parse starts from — the cached
/// tallies for the complete lines in `[0, offset)`, plus the
/// fingerprint that proves the prefix is unchanged.
#[derive(Debug, Clone)]
pub struct ResumeSeed {
    pub offset: i64,
    pub tail_hash: i64,
    pub cwd_checked: bool,
    pub created_at_found: bool,
    pub turn_count: i64,
    pub last_user_prompt: Option<String>,
    pub name: Option<String>,
    pub created_at: i64,
    /// The engine's open-turn state at `offset`. Carried so the resumed
    /// tail parse continues segmentation rather than re-deriving it.
    pub frontier: Frontier,
    /// The effective chain uuid set for `[0, offset)` — every uuid whose
    /// earliest non-dead occurrence lies in the prefix. An appended record
    /// whose uuid is in this set is a compaction re-append and is
    /// suppressed inline, which is what makes compacted sessions
    /// incrementally resumable at all: a re-append block that straddles the
    /// scan boundary arrives looking linear, and only this set can tell
    /// its records from genuinely new ones.
    pub effective_uuids: std::collections::HashSet<[u8; 16]>,
    /// Foreign session ids seen in `[0, offset)` — the pre-rotation
    /// lineage a resumed session's file opens with. Carried so a resumed
    /// slice accumulates onto the full-file set rather than forgetting the
    /// prefix's ancestors.
    pub lineage_ancestors: Vec<String>,
}

/// The 16-byte set key for a record uuid: FNV-1a-128 over the raw string.
/// Hashing rather than parsing keeps the key total over any uuid shape a
/// file might carry; the only comparison that must hold exactly — a
/// re-appended record against its original, byte-identical uuid — always
/// does, and a cross-collision between distinct uuids is a 2^-128 event.
/// The constants are FNV's published 128-bit offset basis and prime, so
/// persisted blobs stay stable across releases.
fn uuid_key(s: &str) -> [u8; 16] {
    const OFFSET: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;
    let mut hash = OFFSET;
    for &b in s.as_bytes() {
        hash ^= u128::from(b);
        hash = hash.wrapping_mul(PRIME);
    }
    hash.to_le_bytes()
}

/// Encode an effective-uuid set as the cache blob: concatenated 16-byte
/// uuids, sorted for deterministic bytes.
fn encode_uuid_set(set: &std::collections::HashSet<[u8; 16]>) -> Vec<u8> {
    let mut keys: Vec<&[u8; 16]> = set.iter().collect();
    keys.sort_unstable();
    let mut out = Vec::with_capacity(keys.len() * 16);
    for key in keys {
        out.extend_from_slice(key);
    }
    out
}

/// Comma-join lineage ancestor sids for the cache column, and back.
fn encode_lineage(ancestors: &[String]) -> Option<String> {
    (!ancestors.is_empty()).then(|| ancestors.join(","))
}

fn decode_lineage(column: Option<&str>) -> Vec<String> {
    column
        .map(|s| {
            s.split(',')
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Decode the cache blob back into the set. `None` on a malformed blob.
fn decode_uuid_set(blob: &[u8]) -> Option<std::collections::HashSet<[u8; 16]>> {
    if blob.len() % 16 != 0 {
        return None;
    }
    Some(
        blob.chunks_exact(16)
            .map(|c| {
                let mut key = [0u8; 16];
                key.copy_from_slice(c);
                key
            })
            .collect(),
    )
}

/// Build a resume seed from a non-excluded cache row. `None` when the
/// row carries no resumable frontier (`parse_offset == 0` — pre-
/// migration rows, or excluded entries).
pub fn resume_seed_from_cache(row: &ScanCacheRow) -> Option<ResumeSeed> {
    if row.excluded || row.parse_offset <= 0 {
        return None;
    }
    let effective_uuids = decode_uuid_set(row.effective_uuids.as_deref()?)?;
    Some(ResumeSeed {
        effective_uuids,
        lineage_ancestors: decode_lineage(row.lineage_ancestors.as_deref()),
        offset: row.parse_offset,
        tail_hash: row.tail_hash,
        cwd_checked: row.cwd_checked,
        created_at_found: row.created_at_found,
        turn_count: row.turn_count,
        last_user_prompt: row.last_user_prompt.clone(),
        name: row.name.clone(),
        created_at: row.created_at,
        frontier: Frontier {
            open: row.frontier_open,
            pending_close: row.frontier_pending_close,
            pending_close_msg_id: row.frontier_pending_close_msg_id.clone(),
            leaf_uuid: row.frontier_leaf_uuid.clone(),
        },
    })
}

/// The parse frontier recorded alongside a scan result, for the next
/// incremental resume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeMark {
    pub parse_offset: i64,
    pub tail_hash: i64,
    pub cwd_checked: bool,
    pub created_at_found: bool,
    /// The engine's open-turn state at `parse_offset`, persisted for the
    /// next incremental resume.
    pub frontier: Frontier,
    /// The encoded effective chain uuid set at `parse_offset`
    /// (see [`ResumeSeed::effective_uuids`]), or `None` when the parse
    /// recorded no resumable frontier.
    pub effective_uuids: Option<Vec<u8>>,
}

/// A parsed session: the picker-facing meta plus the resume frontier.
#[derive(Debug, Clone)]
pub struct ParsedSession {
    pub meta: ExternalSessionMeta,
    pub resume: ResumeMark,
    /// Whether this parse actually resumed from a verified frontier
    /// (vs streaming from byte 0). Drives the scan's `resumed` counter.
    pub resumed: bool,
    /// Whether this parse took the EOF second pass — re-deriving the
    /// effective sequence and re-segmenting — rather than letting the
    /// streamed count stand. Observable so tests can pin which path a
    /// given file takes.
    pub recounted: bool,
    /// Foreign session ids this file's records carry — the pre-rotation
    /// lineage embedded in a resumed session's file. The scan uses these
    /// to suppress superseded ancestor files from the listing.
    pub lineage_ancestors: Vec<String>,
}

/// True when `stem` looks like a claude session UUID
/// (8-4-4-4-12 lowercase hex). Anything else under the project dir is
/// not a session transcript.
fn is_uuid_stem(stem: &str) -> bool {
    let bytes = stem.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() || b.is_ascii_uppercase() {
                    return false;
                }
            }
        }
    }
    true
}

/// Mirror of tugcode's `isUserSubmissionContent`: a genuine user
/// submission is string content, or an array with at least one block
/// whose `type` is not `tool_result`.
fn is_user_submission_content(content: &serde_json::Value) -> bool {
    match content {
        serde_json::Value::String(_) => true,
        serde_json::Value::Array(blocks) => blocks.iter().any(|block| {
            block
                .as_object()
                .map(|o| o.get("type").and_then(|t| t.as_str()) != Some("tool_result"))
                .unwrap_or(false)
        }),
        _ => false,
    }
}

/// True when array content carries an `image` block. The interrupt-marker
/// sentinel never has one; a real submission with the marker text plus an
/// image is therefore not a marker (mirrors the `!hasImage` guard in
/// tugcode's `handleUserEntry`).
fn content_has_image(content: &serde_json::Value) -> bool {
    matches!(content, serde_json::Value::Array(blocks)
        if blocks.iter().any(|b| b
            .as_object()
            .and_then(|o| o.get("type"))
            .and_then(|t| t.as_str())
            == Some("image")))
}

/// Slash-command scaffolding prefixes Claude Code wraps a slash invocation
/// in when it persists the interaction as `user` JSONL. Mirror of tugcode's
/// `COMMAND_SCAFFOLDING_PREFIXES`.
const COMMAND_SCAFFOLDING_PREFIXES: [&str; 5] = [
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-caveat>",
];

/// The three tag names a slash-command envelope is built from.
const COMMAND_ENVELOPE_OPEN_TAGS: [&str; 3] =
    ["<command-message>", "<command-name>", "<command-args>"];

/// Mirror of tugcode's `isCommandEnvelope`: the `<command-message>` /
/// `<command-name>` / `<command-args>` envelope Claude Code persists in
/// place of the literal a user typed when they submitted a slash command.
/// It is the only record of that submission, so it opens a turn — unlike
/// every other `<command-*>`-prefixed scaffolding string.
///
/// Requires `<command-name>` and requires the whole string to be envelope
/// tags plus whitespace, so prose quoting the tags is not mistaken for one.
pub(crate) fn is_command_envelope(text: &str) -> bool {
    if !text.contains("<command-name>") {
        return false;
    }
    let mut rest = text;
    loop {
        let Some(start) = rest.find("<command-") else {
            return rest.trim().is_empty();
        };
        if !rest[..start].trim().is_empty() {
            return false;
        }
        let after_open = &rest[start..];
        let Some(open_len) = COMMAND_ENVELOPE_OPEN_TAGS
            .iter()
            .find(|tag| after_open.starts_with(**tag))
            .map(|tag| tag.len())
        else {
            return false;
        };
        let body = &after_open[open_len..];
        let Some(close_at) = body.find("</command-") else {
            return false;
        };
        let tail = &body[close_at..];
        let Some(gt) = tail.find('>') else {
            return false;
        };
        rest = &tail[gt + 1..];
    }
}

/// Slash commands the **bridge** issues on the user's behalf, so their
/// envelope is machinery rather than a submission. Mirror of tugcode's
/// `BRIDGE_ISSUED_COMMANDS`.
///
/// `/model` is the whole list. The session card never sends `/model` as a
/// prompt — the model change travels as a `set_model` control_request, and
/// claude writes a `/model` envelope into the JSONL anyway, once per change
/// and once more per card mount when the restore effect re-applies the
/// remembered model. Nothing of that reaches the live transcript, so nothing
/// of it may open a turn on replay either.
const BRIDGE_ISSUED_COMMANDS: [&str; 1] = ["/model"];

/// The `<command-name>` an envelope names, or `None` when no occurrence
/// holds a single bare token. Mirror of tugcode's
/// `COMMAND_ENVELOPE_NAME_RE` — `<command-name>\s*([^<\s]+)\s*</command-name>`
/// scanned from the front, so a malformed first occurrence does not veto a
/// well-formed later one.
fn command_envelope_name(text: &str) -> Option<&str> {
    const OPEN: &str = "<command-name>";
    const CLOSE: &str = "</command-name>";
    let mut rest = text;
    loop {
        let start = rest.find(OPEN)? + OPEN.len();
        let after_open = &rest[start..];
        if let Some(close_at) = after_open.find(CLOSE) {
            let name = after_open[..close_at].trim();
            if !name.is_empty() && !name.contains('<') && !name.contains(char::is_whitespace) {
                return Some(name);
            }
        }
        rest = after_open;
    }
}

/// Mirror of tugcode's `isBridgeIssuedCommandEnvelope`: a well-formed
/// command envelope naming a [`BRIDGE_ISSUED_COMMANDS`] command.
fn is_bridge_issued_command_envelope(text: &str) -> bool {
    if !is_command_envelope(text) {
        return false;
    }
    command_envelope_name(text).is_some_and(|name| BRIDGE_ISSUED_COMMANDS.contains(&name))
}

/// Mirror of tugcode's `isNonSubmissionUserString`: bare-string `user`
/// content that is NOT a genuine submission — a `/compact` summary
/// continuation, slash-command scaffolding, or a `<task-notification>` wake
/// envelope. (The wake envelope is non-submission here, but is counted
/// separately as a wake opener by the scan loop.)
fn is_non_submission_user_string(is_compact_summary: bool, text: &str) -> bool {
    if is_compact_summary {
        return true;
    }
    let trimmed = text.trim_start();
    if is_bridge_issued_command_envelope(trimmed) {
        return true;
    }
    if !is_command_envelope(trimmed)
        && COMMAND_SCAFFOLDING_PREFIXES
            .iter()
            .any(|p| trimmed.starts_with(p))
    {
        return true;
    }
    is_task_notification_wake(text)
}

/// Mirror of tugcode's `extractTaskNotificationWake` recognizer: a
/// `<task-notification>` envelope, anchored at the start after optional
/// leading whitespace. A wake opener counts as a turn.
fn is_task_notification_wake(text: &str) -> bool {
    text.trim_start().starts_with("<task-notification>")
}

/// The SDK's interrupt-marker text prefix. Mirror of tugcode's
/// `INTERRUPT_MARKER_PREFIX`.
const INTERRUPT_MARKER_PREFIX: &str = "[Request interrupted by user";

/// Mirror of tugcode's `isInterruptMarkerEntry`: the SDK's
/// `[Request interrupted by user…]` sentinel, which tugcode drops (it opens
/// no turn). Both signals must agree — the text pattern AND an absent
/// `permissionMode` field — and the entry must carry no image, so a user who
/// literally types the marker text (their submission carries
/// `permissionMode`) still counts.
fn is_interrupt_marker(text: &str, has_image: bool, has_permission_mode: bool) -> bool {
    if has_image || has_permission_mode {
        return false;
    }
    if !text.starts_with(INTERRUPT_MARKER_PREFIX) || !text.ends_with(']') {
        return false;
    }
    if text != "[Request interrupted by user]" {
        // Suffix form: a space-led suffix between the prefix and the closing
        // `]` (distinguishes the marker from `[Request interrupted by userX]`).
        let after = &text[INTERRUPT_MARKER_PREFIX.len()..text.len() - 1];
        if !after.starts_with(' ') || after.chars().count() <= 1 {
            return false;
        }
    }
    true
}

/// Decide whether a parsed `type:"user"` record opens a turn under S01
/// (`tuglaws/turn-metric.md`). Shared by the live scan loop and the corpus
/// contract test so the two can never drift. Returns `(counts, is_wake)`:
/// `counts` is whether it opens a turn; `is_wake` distinguishes a wake
/// opener (a turn, but not a user prompt) from a genuine submission.
///
/// Mirrors tugcode's `handleUserEntry`: `isMeta` records and interrupt
/// markers never count; a bare string additionally must clear the
/// non-submission gate (compact / scaffolding); array content with a
/// non-`tool_result` block is always a genuine submission; wake envelopes
/// count.
pub(crate) fn user_submission_opens_turn(
    is_meta: bool,
    is_compact_summary: bool,
    has_permission_mode: bool,
    content: &serde_json::Value,
) -> (bool, bool) {
    if is_meta || !is_user_submission_content(content) {
        return (false, false);
    }
    let is_string = matches!(content, serde_json::Value::String(_));
    let text = submission_text(content);
    let is_wake = is_string && is_task_notification_wake(&text);
    if is_interrupt_marker(&text, content_has_image(content), has_permission_mode) {
        return (false, false);
    }
    let counts = is_wake || !is_string || !is_non_submission_user_string(is_compact_summary, &text);
    (counts, is_wake)
}

/// Extract the submission's display text: string content verbatim, or
/// the concatenated `text` fields of array content.
pub(crate) fn submission_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                let o = block.as_object()?;
                if o.get("type").and_then(|t| t.as_str()) == Some("text") {
                    o.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Char-boundary-safe truncation to `USER_PROMPT_MAX_CHARS`.
fn truncate_prompt(text: &str) -> String {
    text.chars().take(USER_PROMPT_MAX_CHARS).collect()
}

/// Parse an ISO-8601 record timestamp to unix millis.
pub(crate) fn parse_timestamp_millis(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// The fields the scanner reads from each JSONL record. Everything else
/// in the line (the often multi-MB assistant `content`, `toolUseResult`,
/// usage blocks, …) is skipped without allocation: unknown keys go to
/// serde's `IgnoredAny`, and `message` is captured as an **unparsed**
/// slice ([`RawValue`]) — only the rare `type: "user"` lines pay to parse
/// it into a tree. The scalar fields are `Option<String>` (so a missing
/// or `null` value is `None`, never a parse error). This typed extraction
/// replaces a full `serde_json::Value` DOM build per line — the dominant
/// cost of a cold scan over a multi-GB project dir.
#[derive(Deserialize)]
struct ScanRecord<'a> {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(rename = "sessionId", default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(rename = "aiTitle", default)]
    ai_title: Option<String>,
    /// `/compact` continuation flag. Honoured only for bare-string content
    /// (mirrors tugcode's `handleUserEntry`), where it marks the injected
    /// "This session is being continued…" summary as non-submission.
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: Option<bool>,
    /// SDK bookkeeping flag (image hints, skill-body loaders, `/loop`
    /// imports). tugcode skips `isMeta` records outright — they never open
    /// a turn regardless of content shape.
    #[serde(rename = "isMeta", default)]
    is_meta: Option<bool>,
    /// Present on every real user submission (the input layer stamps it),
    /// absent on the SDK's auto-injected interrupt marker. Captured unparsed
    /// purely to test *presence* — the structural half of the interrupt
    /// disambiguator (mirrors `isInterruptMarkerEntry`).
    #[serde(rename = "permissionMode", default, borrow)]
    permission_mode: Option<&'a serde_json::value::RawValue>,
    /// Unparsed — only `type: "user"` lines parse this to read `content`.
    #[serde(default, borrow)]
    message: Option<&'a serde_json::value::RawValue>,
}

/// Verify a resume seed against the file: read the fingerprint window
/// ending at `seed.offset` and compare. On a match the file is left
/// positioned at the offset and the window is returned (it primes the
/// rolling fingerprint); on a mismatch the prefix was rewritten and the
/// caller falls back to a full parse.
fn try_resume(
    file: &mut fs::File,
    seed: &ResumeSeed,
    file_size: i64,
) -> std::io::Result<Option<Vec<u8>>> {
    if seed.offset <= 0 || seed.offset > file_size {
        return Ok(None);
    }
    let k = (seed.offset as usize).min(TAIL_FINGERPRINT_BYTES);
    file.seek(SeekFrom::Start(seed.offset as u64 - k as u64))?;
    let mut window = vec![0u8; k];
    file.read_exact(&mut window)?;
    if fnv1a64(&window) as i64 != seed.tail_hash {
        return Ok(None);
    }
    Ok(Some(window))
}

/// Stream one candidate JSONL and extract its metadata.
///
/// `Ok(None)` means the file was deliberately excluded (cwd mismatch,
/// sessionId mismatch); `Err` means it could not be read at all.
/// Malformed lines are skipped silently, matching the permissiveness of
/// tugcode's translator.
///
/// With a verified `resume` seed the stream starts at the cached parse
/// frontier instead of byte 0 — the dominant repeat cost of the scan is
/// a live multi-hundred-MB session re-streaming in full on every
/// append, and this drops it to just the appended tail. Only complete
/// (newline-terminated) lines advance the frontier; an unterminated
/// final line is a write in progress and is left for the next scan.
///
/// ## Two-pass on demand
///
/// The count this produces is the count authority: it feeds
/// [`engine_turn_count`], which `agent_bridge.rs` stamps onto
/// `replay_complete`. It must therefore count the **effective record
/// sequence** — the same thing tugcode's replay renders — and that cannot
/// be done in a single forward pass, because the live chain walk starts at
/// the newest leaf, which a forward stream does not know until EOF.
///
/// So the parse runs unbuffered and watches for the shapes that make the
/// effective sequence diverge from the raw one — a compaction marker, a
/// repeated uuid, a record that doesn't parent to the carried leaf:
///
/// - **None seen** → the streamed count stands, and the cost is exactly a
///   single allocation-free pass. This is the common session.
/// - **Any seen** → restart once as a buffered full stream; at EOF,
///   re-derive the effective indices over the buffer and re-run
///   segmentation across them.
///
/// On an incremental resume, the seed's effective-uuid set absorbs the one
/// append shape that is invisible to the slice-local triggers: a
/// compaction re-append block straddling the scan boundary, whose tail
/// arrives looking perfectly linear. Records whose uuid is already in the
/// set are suppressed inline; the shapes the set cannot absorb (a new
/// compaction boundary, a rewind branch, a record re-attaching below the
/// carried frontier) restart as the buffered full stream above — once,
/// after which the fresh seed resumes incrementally again.
fn parse_session_file(
    path: &Path,
    project_dir: &str,
    expected_stem: &str,
    file_size: i64,
    file_mtime: i64,
    resume: Option<&ResumeSeed>,
) -> std::io::Result<Option<ParsedSession>> {
    // First pass runs unbuffered: the common session is linear and
    // duplicate-free, and for it the second-pass buffers are pure wasted
    // allocation. The first trigger restarts buffered.
    parse_session_file_inner(
        path,
        project_dir,
        expected_stem,
        file_size,
        file_mtime,
        resume,
        false,
    )
}

fn parse_session_file_inner(
    path: &Path,
    project_dir: &str,
    expected_stem: &str,
    file_size: i64,
    file_mtime: i64,
    resume: Option<&ResumeSeed>,
    buffering: bool,
) -> std::io::Result<Option<ParsedSession>> {
    let mut file = fs::File::open(path)?;

    // The second-pass buffer, index-aligned: one slot per line read in this
    // stream. Only populated when `buffering` (a prior pass hit a trigger);
    // dropped at EOF unless the recount runs.
    let mut chain_buf: Vec<Option<crate::dead_branch::ChainRecord>> = Vec::new();
    let mut sig_buf: Vec<Option<SigRecord>> = Vec::new();
    let mut seen_uuids: std::collections::HashSet<String> = std::collections::HashSet::new();
    // The effective chain uuid set: seeded from the cache on a resume,
    // accumulated as records stream, rebuilt from the recount when one
    // runs. Persisted with the resume mark.
    let mut effective_seen: std::collections::HashSet<[u8; 16]> = std::collections::HashSet::new();
    let mut saw_compaction = false;
    let mut saw_duplicate_uuid = false;
    // A chain record whose parent is not the leaf we carried in — the
    // rewind-branch shape, only meaningful on a resumed (partial) stream.
    let mut saw_branch = false;
    // Every non-sidechain uuid this slice itself carried, and the leaf it
    // resumed from. Together they say whether an off-leaf record attaches
    // inside the slice (a spur among the appended records) or reaches back
    // into the prefix at a point other than the frontier — the shape that
    // relocates the live chain and so can resurrect buried prefix records.
    // Only populated on a resumed slice; a full stream triggers on any
    // off-leaf record and never consults them.
    let mut slice_uuids: std::collections::HashSet<[u8; 16]> = std::collections::HashSet::new();
    let mut seed_leaf_key: Option<[u8; 16]> = None;

    let mut turn_count: i64 = 0;
    let mut last_prompt: Option<String> = None;
    let mut name: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut cwd_checked = false;
    // Session-id accounting. A resumed session's file legitimately opens
    // with records stamped with the pre-rotation session id (the embedded
    // lineage), so a foreign sid is not grounds for exclusion on sight —
    // the file is foreign only if the stem NEVER appears (decided at EOF).
    let mut saw_expected_sid = false;
    let mut lineage_ancestors: Vec<String> = Vec::new();
    let mut consumed: u64 = 0;
    let mut window: Vec<u8> = Vec::with_capacity(TAIL_FINGERPRINT_BYTES);
    let mut resumed = false;
    // The segmentation engine's open-turn state. `turn_count` is the
    // engine's running count of opened turn containers; `frontier` carries
    // the open-turn state across an incremental resume so the tail parse
    // continues segmentation rather than re-deriving it (the original
    // incremental-undercount bug, Risk R02).
    let mut frontier = Frontier::default();

    if let Some(seed) = resume {
        if let Some(verified_window) = try_resume(&mut file, seed, file_size)? {
            turn_count = seed.turn_count;
            last_prompt = seed.last_user_prompt.clone();
            name = seed.name.clone();
            created_at = seed.created_at_found.then_some(seed.created_at);
            cwd_checked = seed.cwd_checked;
            consumed = seed.offset as u64;
            window = verified_window;
            resumed = true;
            frontier = seed.frontier.clone();
            seed_leaf_key = seed.frontier.leaf_uuid.as_deref().map(uuid_key);
            effective_seen = seed.effective_uuids.clone();
            lineage_ancestors = seed.lineage_ancestors.clone();
            // The prefix was accepted when the seed's row was written, so
            // the stem is known to appear; the slice need not see it again.
            saw_expected_sid = true;
        } else {
            file.seek(SeekFrom::Start(0))?;
        }
    }

    let mut reader = BufReader::new(file);
    let mut line = String::new();

    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        // An unterminated final line is a write in progress. It is deferred
        // whole — not consumed, not counted, not shown to the engine or the
        // triggers — so the frontier stops at the last complete record and
        // the parse stays resumable. The next scan, once the line is
        // terminated, resumes from that frontier and counts it exactly once.
        // Active sessions race the scanner constantly; poisoning
        // resumability here would re-stream the whole file on every append,
        // on precisely the busiest sessions ([P05]).
        //
        // Accepted edge: if a writer dies mid-line and the file never changes
        // again, the cache hit hides the truncated JSON indefinitely. It was
        // never a complete record, and any future append moves `(size,
        // mtime)` and picks it up.
        if !line.ends_with('\n') {
            break;
        }
        consumed += line.len() as u64;
        push_tail(&mut window, line.as_bytes());
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Typed extraction: scans the line structurally but builds no tree
        // for the bulk fields. A non-object or malformed line fails here
        // and is skipped — same tolerance as the prior `Value` path.
        let Ok(rec) = serde_json::from_str::<ScanRecord>(trimmed) else {
            continue;
        };

        if let Some(sid) = rec.session_id.as_deref() {
            if sid == expected_stem {
                saw_expected_sid = true;
            } else if !lineage_ancestors.iter().any(|s| s == sid) {
                lineage_ancestors.push(sid.to_owned());
            }
        }
        if !cwd_checked {
            if let Some(cwd) = rec.cwd.as_deref() {
                cwd_checked = true;
                if cwd != project_dir {
                    tracing::debug!(
                        path = %path.display(),
                        record_cwd = cwd,
                        "external scan: cwd mismatch (encoding collision), excluded",
                    );
                    return Ok(None);
                }
            }
        }
        if created_at.is_none() {
            if let Some(ts) = rec.timestamp.as_deref() {
                created_at = parse_timestamp_millis(ts);
            }
        }

        // The canonical count is produced by the segmentation engine (the
        // single count authority, `tuglaws/turn-metric.md` S03). Drive it
        // one record per line, carrying the open-turn frontier: a record
        // that opens a turn container grows the count. This sees
        // assistant-originated openers (wakes, `/compact` continuations,
        // leading orphans) the prior user-record-only rule could not.
        let chain_rec = crate::dead_branch::parse_chain_record(trimmed);
        // Inline suppression, the resumed case only: an appended record
        // whose uuid is already effective is a compaction re-append — the
        // straddle shape the seed's uuid set exists to catch. It re-states
        // history the seed already counted, so it feeds neither the engine
        // nor the triggers; it does become the raw chain leaf, because its
        // successors parent to it.
        let mut suppressed = false;
        if let Some(chain) = chain_rec.as_ref() {
            let known = resumed
                && !chain.is_sidechain
                && chain
                    .uuid
                    .as_deref()
                    .is_some_and(|uuid| effective_seen.contains(&uuid_key(uuid)));
            // Every chain record the slice carries — suppressed re-appends
            // included, since a later record may parent to one of them.
            if resumed && !chain.is_sidechain {
                if let Some(uuid) = chain.uuid.as_deref() {
                    slice_uuids.insert(uuid_key(uuid));
                }
            }
            if known {
                suppressed = true;
                frontier.leaf_uuid = chain.uuid.clone();
            } else {
                if chain.is_compaction {
                    saw_compaction = true;
                }
                if let Some(uuid) = chain.uuid.as_deref() {
                    if !chain.is_sidechain {
                        if !seen_uuids.insert(uuid.to_owned()) {
                            saw_duplicate_uuid = true;
                        }
                        // Trigger (b): this record's parent is not the chain leaf
                        // we were carrying.
                        //
                        // On a full stream the trigger stays broad — there it only
                        // decides whether the EOF recount runs over buffered
                        // records, which is cheap and never wrong.
                        //
                        // On a resumed slice the trigger costs a full re-stream of
                        // the file, so it fires only for the shapes that can edit
                        // history. Two of them:
                        //
                        // - An off-leaf USER SUBMISSION — the rewind /
                        //   Escape-orphan shape. `compute_dead_entry_indices`
                        //   roots dead branches exclusively at user submissions,
                        //   so only this shape can bury records.
                        // - An off-leaf record whose parent lies in the PREFIX
                        //   rather than in this slice. Deadness is not a local
                        //   property: `compute_live_indices` walks up from the
                        //   file's newest leaf, and a record that re-attaches
                        //   below the frontier moves that walk onto a different
                        //   prefix branch. Off-chain user submissions that rooted
                        //   dead branches then lose their live parent and stop
                        //   qualifying, so prefix records the head parse buried
                        //   come back. Such a record cannot root a dead branch,
                        //   but it can un-kill one, and the recount is the only
                        //   thing that sees it.
                        //
                        // A spur that attaches WITHIN the slice — a hook
                        // attachment, a `tool_result` whose sibling carried the
                        // chain forward, an abandoned API-retry spur — leaves the
                        // prefix's live closure untouched and is effective in the
                        // full pass too, so absorbing it inline (leaf + engine, no
                        // trigger) keeps incremental ≡ full.
                        match chain.parent_uuid.as_deref() {
                            Some(parent) => {
                                let reaches_into_prefix = {
                                    let key = uuid_key(parent);
                                    !slice_uuids.contains(&key) && seed_leaf_key != Some(key)
                                };
                                if frontier.leaf_uuid.as_deref() != Some(parent)
                                    && (!resumed || chain.is_user_submission || reaches_into_prefix)
                                {
                                    saw_branch = true;
                                }
                            }
                            // A null parent mid-file roots a new segment — a
                            // restart, or the record right after a compaction
                            // boundary. Only the very first chain record of a
                            // file legitimately has no leaf before it.
                            None => {
                                if frontier.leaf_uuid.is_some() {
                                    saw_branch = true;
                                }
                            }
                        }
                        frontier.leaf_uuid = Some(uuid.to_owned());
                        effective_seen.insert(uuid_key(uuid));
                    }
                }
            }
        }

        // A trigger on an unbuffered pass: restart as a buffered full
        // stream, so the EOF recount has the records it needs. For a full
        // stream this re-reads the file once, which only sessions that
        // actually carry a compaction, duplicate, or branch ever pay. For a
        // resumed slice it is the append shapes inline suppression cannot
        // absorb — a NEW compaction boundary, a rewind branch — which can
        // rewrite the prefix's effective membership and so genuinely need
        // the whole file (once; the buffered pass records a fresh seed).
        if !buffering && (saw_compaction || saw_duplicate_uuid || saw_branch) {
            if resumed {
                tracing::debug!(
                    path = %path.display(),
                    saw_compaction,
                    saw_duplicate_uuid,
                    saw_branch,
                    "external scan: appended slice needs a full re-segment",
                );
            }
            return parse_session_file_inner(
                path,
                project_dir,
                expected_stem,
                file_size,
                file_mtime,
                None,
                true,
            );
        }

        let sig = if suppressed {
            None
        } else {
            parse_significant(trimmed)
        };
        if let Some(sig) = sig.as_ref() {
            if step_record(&mut frontier, sig).is_some() {
                turn_count += 1;
            }
        }
        if buffering {
            chain_buf.push(chain_rec);
            sig_buf.push(sig);
        }

        match rec.kind.as_deref() {
            Some("user") => {
                // The engine owns the count; this arm only tracks the last
                // genuine user prompt (a non-count picker output). Parse the
                // small user `message` to inspect its `content`.
                let content = rec
                    .message
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).ok())
                    .and_then(|msg| msg.get("content").cloned());
                if let Some(content) = content {
                    let (counts, is_wake) = user_submission_opens_turn(
                        rec.is_meta == Some(true),
                        rec.is_compact_summary == Some(true),
                        rec.permission_mode.is_some(),
                        &content,
                    );
                    // `last_user_prompt` tracks the last genuine prompt — a
                    // wake envelope opens a turn but is not a prompt, and a
                    // slash-command envelope opens a turn but is a command:
                    // its raw `<command-name>` markup is not description
                    // text, and the previous prose prompt stays the row's
                    // human-meaningful line.
                    if counts && !is_wake {
                        let text = submission_text(&content);
                        if !text.is_empty() && !is_command_envelope(text.trim_start()) {
                            last_prompt = Some(truncate_prompt(&text));
                        }
                    }
                }
            }
            Some("ai-title") => {
                if let Some(title) = rec.ai_title.as_deref() {
                    if !title.is_empty() {
                        name = Some(title.to_owned());
                    }
                }
            }
            _ => {}
        }
    }

    // The foreign-file verdict, deferred from the per-record gate: a file
    // whose records claim session ids but never the stem is another
    // session's content under this filename (an encoding collision or a
    // stray copy). A resumed-lineage file — foreign ids first, the stem's
    // own records later — is the stem's newest file and must be listed.
    if !saw_expected_sid && !lineage_ancestors.is_empty() {
        tracing::debug!(
            path = %path.display(),
            foreign = %lineage_ancestors.join(","),
            "external scan: no record carries the filename's sessionId, excluded",
        );
        return Ok(None);
    }

    // The effective sequence can only differ from the raw one when the file
    // holds a compaction (which breaks the chain and re-appends duplicates)
    // or a chain record that does not parent to its predecessor (the branch
    // shape a rewind leaves). A stream that saw neither is provably linear
    // and duplicate-free, so its streamed count is already the effective
    // count. Only a buffered pass can reach EOF with a trigger set — the
    // unbuffered passes restart the moment one fires.
    let needs_effective_recount = saw_compaction || saw_duplicate_uuid || saw_branch;

    if needs_effective_recount {
        let effective = crate::dead_branch::effective_indices(&chain_buf);
        // The streamed uuid set was accumulated raw; the recount knows
        // which occurrences are actually effective, so rebuild from it.
        effective_seen.clear();
        for &i in &effective {
            let Some(Some(chain)) = chain_buf.get(i) else {
                continue;
            };
            if chain.is_sidechain {
                continue;
            }
            if let Some(uuid) = chain.uuid.as_deref() {
                effective_seen.insert(uuid_key(uuid));
            }
        }
        let records = effective
            .into_iter()
            .filter_map(|i| sig_buf.get(i).and_then(|s| s.clone()));
        let out = segment_turns(records, Frontier::default());
        turn_count = out.turns.len() as i64;
        frontier = Frontier {
            leaf_uuid: frontier.leaf_uuid,
            ..out.frontier
        };
    }

    // A recounted file hands out a resumable seed like any other: the
    // persisted effective-uuid set is what makes the next append's
    // re-append records (including a straddled block's tail, which arrives
    // looking perfectly linear) detectable without the prefix.
    let resume = if consumed > 0 {
        ResumeMark {
            parse_offset: consumed as i64,
            tail_hash: fnv1a64(&window) as i64,
            cwd_checked,
            created_at_found: created_at.is_some(),
            // The frontier reflects exactly the complete (terminated) lines
            // in `[0, consumed)` — an unterminated tail was deferred before
            // it could touch any of this state.
            frontier: frontier.clone(),
            effective_uuids: Some(encode_uuid_set(&effective_seen)),
        }
    } else {
        ResumeMark {
            parse_offset: 0,
            tail_hash: 0,
            cwd_checked,
            created_at_found: created_at.is_some(),
            // No resumable frontier (offset 0 means a full re-stream next
            // time); the value is unused but the struct must be complete.
            frontier: Frontier::default(),
            effective_uuids: None,
        }
    };
    Ok(Some(ParsedSession {
        recounted: needs_effective_recount,
        lineage_ancestors,
        meta: ExternalSessionMeta {
            session_id: expected_stem.to_owned(),
            turn_count,
            last_user_prompt: last_prompt,
            name,
            created_at: created_at.unwrap_or(file_mtime),
            last_used_at: file_mtime,
            file_size,
            file_mtime,
            // The parse never births a line; the ledger-backed scan attaches
            // one afterwards and reads the callsign off it ([P07]).
            tag: None,
            line_id: None,
        },
        resume,
        resumed,
    }))
}

/// `(size, mtime-millis)` of a file, for cache-validity checks and the
/// meta fields. `None` when the file vanished between listing and stat.
pub fn stat_size_mtime(path: &Path) -> Option<(i64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let size = meta.len() as i64;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some((size, mtime))
}

/// One candidate session file: stem + path + stat pair. The cached
/// scan path stats candidates first and only parses on cache miss.
#[derive(Debug, Clone)]
pub struct SessionFileCandidate {
    pub session_id: String,
    pub path: std::path::PathBuf,
    pub file_size: i64,
    pub file_mtime: i64,
}

/// Enumerate candidate session JSONLs for `project_dir` under
/// `claude_projects_root`: regular `*.jsonl` files whose stem is a
/// session UUID. Subdirectories (`.tug-trash`, `<id>/subagents/`),
/// dotfiles, and non-UUID names are skipped. Missing project dir →
/// empty vec.
///
/// `project_dir` may be any alias of the project (user-typed, possibly
/// through symlinks); resolution to claude's directory goes through the
/// [`claude_project_dir`] chokepoint. Returns the canonical project-dir
/// string alongside the candidates — record `cwd` comparisons must use
/// it, never the raw input.
pub fn list_session_file_candidates(
    claude_projects_root: &Path,
    project_dir: &str,
) -> (Vec<SessionFileCandidate>, String) {
    let (dir, canonical) = claude_project_dir(claude_projects_root, project_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (Vec::new(), canonical);
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                dir = %dir.display(),
                "external scan: read_dir failed",
            );
            return (Vec::new(), canonical);
        }
    };
    let mut candidates = Vec::new();
    for entry_result in entries {
        let Ok(entry) = entry_result else {
            continue;
        };
        let path = entry.path();
        let is_file = entry.file_type().map(|ft| ft.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_uuid_stem(stem) {
            continue;
        }
        let Some((file_size, file_mtime)) = stat_size_mtime(&path) else {
            continue;
        };
        candidates.push(SessionFileCandidate {
            session_id: stem.to_owned(),
            path,
            file_size,
            file_mtime,
        });
    }
    (candidates, canonical)
}

/// Uncached scan: enumerate candidates and parse every one. The
/// supervisor uses the cached variant on `SessionLedger`; this entry
/// point exists for tests and for callers without a ledger handle.
pub fn scan_external_sessions(
    claude_projects_root: &Path,
    project_dir: &str,
) -> Vec<ExternalSessionMeta> {
    let (candidates, canonical) = list_session_file_candidates(claude_projects_root, project_dir);
    let parsed: Vec<ParsedSession> = candidates
        .into_iter()
        .filter_map(|c| parse_candidate(&c, &canonical, None))
        .collect();
    let claims: Vec<(i64, Vec<String>)> = parsed
        .iter()
        .map(|p| (p.meta.file_mtime, p.lineage_ancestors.clone()))
        .collect();
    let mut metas: Vec<ExternalSessionMeta> = parsed.into_iter().map(|p| p.meta).collect();
    suppress_superseded_lineage(&mut metas, &claims);
    metas
}

/// Parse one already-stat'ed candidate, optionally resuming from a
/// cached frontier. Exposed for the cached scan path on
/// `SessionLedger`.
pub fn parse_candidate(
    candidate: &SessionFileCandidate,
    project_dir: &str,
    resume: Option<&ResumeSeed>,
) -> Option<ParsedSession> {
    parse_session_file(
        &candidate.path,
        project_dir,
        &candidate.session_id,
        candidate.file_size,
        candidate.file_mtime,
        resume,
    )
    .ok()
    .flatten()
}

/// `engine(file)` for one session — the single count authority ([P08],
/// `tuglaws/turn-metric.md` S03). Prefers the fingerprint-validated cached
/// engine count (the picker scan already wrote it); when there is no cache
/// entry (a resume that bypassed a picker scan), runs the engine on the
/// resolved file path. `None` when the file is missing/unreadable or
/// excluded (cwd/sessionId mismatch) — the caller then skips the reconcile
/// rather than zeroing a real count.
///
/// This is what the resume reconcile reads instead of the wire's
/// `totalTurns`, so the picker count and the resumed count are equal by
/// construction (the picker-never-shifts invariant, [P06]).
pub fn engine_turn_count(
    ledger: &SessionLedger,
    project_dir: &str,
    claude_session_id: &str,
) -> Option<i64> {
    let (dir, canonical) = claude_project_dir(ledger.claude_projects_root(), project_dir);
    let path = dir.join(format!("{claude_session_id}.jsonl"));
    let (file_size, file_mtime) = stat_size_mtime(&path)?;
    // Cached engine(file), validated by (file_size, file_mtime); the cache
    // read is already epoch-gated.
    if let Ok(Some(row)) = ledger.get_scan_cache(claude_session_id) {
        if !row.excluded && row.file_size == file_size && row.file_mtime == file_mtime {
            return Some(row.turn_count);
        }
    }
    // No usable cache entry: run the engine on the file directly. The
    // canonical project dir is what the cwd-exclusion compares against, so a
    // genuinely foreign file (encoding collision) returns `None` here too.
    let candidate = SessionFileCandidate {
        session_id: claude_session_id.to_owned(),
        path,
        file_size,
        file_mtime,
    };
    parse_candidate(&candidate, &canonical, None).map(|p| p.meta.turn_count)
}

/// Outcome of a cached scan: the metas, plus counters that make cache
/// behavior assertable (a warm scan of an unchanged directory reports
/// `parsed == 0`; an append-only growth reports `resumed > 0`).
#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub metas: Vec<ExternalSessionMeta>,
    /// Candidate files streamed this scan (cache misses).
    pub parsed: usize,
    /// Of `parsed`, how many resumed from a cached frontier instead of
    /// re-streaming from byte 0.
    pub resumed: usize,
    /// Candidate files served from the cache.
    pub cache_hits: usize,
    /// The canonical project dir the scan resolved (via the
    /// [`claude_project_dir`] chokepoint). Consumers synthesizing rows
    /// or deriving JSONL paths must use this, never the raw input.
    pub canonical_project_dir: String,
}

fn cache_row_from_parsed(parsed: &ParsedSession, project_dir: &str) -> ScanCacheRow {
    let meta = &parsed.meta;
    ScanCacheRow {
        session_id: meta.session_id.clone(),
        project_dir: project_dir.to_owned(),
        file_size: meta.file_size,
        file_mtime: meta.file_mtime,
        excluded: false,
        turn_count: meta.turn_count,
        last_user_prompt: meta.last_user_prompt.clone(),
        name: meta.name.clone(),
        created_at: meta.created_at,
        last_used_at: meta.last_used_at,
        parse_offset: parsed.resume.parse_offset,
        tail_hash: parsed.resume.tail_hash,
        cwd_checked: parsed.resume.cwd_checked,
        created_at_found: parsed.resume.created_at_found,
        frontier_open: parsed.resume.frontier.open,
        frontier_pending_close: parsed.resume.frontier.pending_close,
        frontier_pending_close_msg_id: parsed.resume.frontier.pending_close_msg_id.clone(),
        frontier_leaf_uuid: parsed.resume.frontier.leaf_uuid.clone(),
        effective_uuids: parsed.resume.effective_uuids.clone(),
        lineage_ancestors: encode_lineage(&parsed.lineage_ancestors),
        // Not a parse product — `upsert_scan_cache` carries the stored line
        // across so a re-parse cannot orphan the row from it.
        line_id: None,
    }
}

/// Re-derive one session's scan metrics from its JSONL and write both back —
/// the turn-end freshness path ([D132]).
///
/// The activity line on a Session card's masthead reads a turn count and an
/// on-disk size the instant a turn ends, which is exactly when the scan-derived
/// numbers were most stale: the only production writer of either was the picker
/// scan. This is that same write for one session, composed from the same
/// incremental entry points, so no second counting rule appears anywhere.
///
/// Returns the fresh `(file_size, turn_count)` when it wrote, and `None` when
/// there was nothing to do: the file is missing or unreadable, the parse
/// excluded it, or `(size, mtime)` already matches the cached pair. `None` is
/// therefore "no push needed" as much as it is "no answer".
///
/// Never a naive full parse. A file that only grew past a recorded frontier
/// resumes from it, which is the append-only steady state a turn ending leaves.
/// A turn that lands a compaction or a rewind does force a re-stream, by the
/// engine's own rules.
pub fn refresh_session_metrics(
    ledger: &SessionLedger,
    project_dir: &str,
    claude_session_id: &str,
) -> Option<SessionScanMetrics> {
    let (dir, canonical) = claude_project_dir(ledger.claude_projects_root(), project_dir);
    let path = dir.join(format!("{claude_session_id}.jsonl"));
    let (file_size, file_mtime) = stat_size_mtime(&path)?;
    let cached = ledger
        .get_scan_cache(claude_session_id)
        .unwrap_or_else(|err| {
            tracing::warn!(error = %err, "turn-end refresh: cache read failed");
            None
        });
    let mut seed = None;
    if let Some(row) = cached.as_ref() {
        if row.file_size == file_size && row.file_mtime == file_mtime {
            return None;
        }
        // Same rule the scan uses: seed only when the file GREW past the
        // recorded frontier. A shrunk or rewritten file re-streams.
        if file_size > row.file_size {
            seed = resume_seed_from_cache(row);
        }
    }
    let candidate = SessionFileCandidate {
        session_id: claude_session_id.to_owned(),
        path,
        file_size,
        file_mtime,
    };
    let parsed = parse_candidate(&candidate, &canonical, seed.as_ref())?;
    let row = cache_row_from_parsed(&parsed, &canonical);
    if let Err(err) = ledger.upsert_scan_cache(&row) {
        tracing::warn!(error = %err, "turn-end refresh: cache write failed");
        return None;
    }
    if let Err(err) =
        ledger.reconcile_turn_count_from_engine(&parsed.meta.session_id, parsed.meta.turn_count)
    {
        tracing::warn!(error = %err, "turn-end refresh: ledger count reconcile failed");
    }
    Some(SessionScanMetrics {
        file_size,
        turn_count: parsed.meta.turn_count,
    })
}

/// Drop superseded lineage ancestors from a listing. A resumed session's
/// file embeds its pre-rotation history under the old session ids; the old
/// files are then stale prefixes of the new one and listing them alongside
/// it offers the user two versions of one conversation — the older of
/// which silently missing everything since the rotation. An ancestor is
/// suppressed only while it is genuinely superseded (not modified since
/// the descendant was): an ancestor file that has grown PAST the
/// descendant's mtime has forked into its own live conversation and stays
/// visible.
fn suppress_superseded_lineage(
    metas: &mut Vec<ExternalSessionMeta>,
    claims: &[(i64, Vec<String>)],
) {
    if claims.iter().all(|(_, ancestors)| ancestors.is_empty()) {
        return;
    }
    let mut newest_claim: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for (descendant_mtime, ancestors) in claims {
        for sid in ancestors {
            let entry = newest_claim
                .entry(sid.as_str())
                .or_insert(*descendant_mtime);
            *entry = (*entry).max(*descendant_mtime);
        }
    }
    metas.retain(|meta| match newest_claim.get(meta.session_id.as_str()) {
        Some(&descendant_mtime) => meta.file_mtime > descendant_mtime,
        None => true,
    });
}

fn meta_from_cache_row(row: ScanCacheRow) -> ExternalSessionMeta {
    ExternalSessionMeta {
        session_id: row.session_id,
        turn_count: row.turn_count,
        last_user_prompt: row.last_user_prompt,
        name: row.name,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        file_size: row.file_size,
        file_mtime: row.file_mtime,
        line_id: row.line_id,
        // Filled from the line below, which is the only place a scanned
        // session's callsign comes from now.
        tag: None,
    }
}

/// Cache-backed scan: stat every candidate, serve unchanged files from
/// the ledger's `external_scan_cache`, stream only the misses, and
/// prune cache rows whose backing file is gone. Cache I/O failures are
/// logged and degrade to an uncached parse — the scan itself never
/// fails.
/// Parse a batch of cache-miss candidates across all available cores via
/// rayon's work-stealing pool, returning results index-aligned with
/// `misses` (`None` = deliberately excluded or unreadable). Work-stealing
/// (rather than fixed chunks) keeps every core busy despite wildly uneven
/// per-file sizes — a cold scan's JSONLs range from a few KB to tens of MB,
/// so a straggler chunk would otherwise dominate wall-clock. `par_iter`
/// preserves input order in the collected `Vec`.
fn parse_candidates_parallel(
    misses: &[(&SessionFileCandidate, Option<ResumeSeed>)],
    project_dir: &str,
    progress: &(impl Fn(usize, usize) + Sync),
) -> Vec<Option<ParsedSession>> {
    let total = misses.len();
    let done = std::sync::atomic::AtomicUsize::new(0);
    misses
        .par_iter()
        .map(|(c, seed)| {
            let parsed = parse_candidate(c, project_dir, seed.as_ref());
            let d = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            progress(d, total);
            parsed
        })
        .collect()
}

pub fn scan_external_sessions_cached(ledger: &SessionLedger, project_dir: &str) -> ScanOutcome {
    scan_external_sessions_cached_with_progress(ledger, project_dir, |_, _| {})
}

/// Cache-backed scan with a parse-progress callback: invoked with
/// `(0, total)` once the cache-miss set is known, then `(done, total)`
/// after each miss finishes streaming (from rayon worker threads — the
/// callback must be cheap and `Sync`). Not called at all when the scan
/// is a pure cache hit, so a warm picker open emits no progress noise.
pub fn scan_external_sessions_cached_with_progress(
    ledger: &SessionLedger,
    project_dir: &str,
    progress: impl Fn(usize, usize) + Sync,
) -> ScanOutcome {
    let (candidates, canonical) =
        list_session_file_candidates(ledger.claude_projects_root(), project_dir);
    // Everything below operates on the canonical form — the cache keys,
    // the cwd comparisons, and the prune scope all agree regardless of
    // which alias the caller typed.
    let project_dir = canonical.as_str();
    let mut outcome = ScanOutcome {
        canonical_project_dir: canonical.clone(),
        ..ScanOutcome::default()
    };
    // Pass 1 (sequential, fast): stat-validate each candidate against the
    // sqlite cache. Cache hits resolve here; misses are collected for the
    // parallel parse below — carrying a resume seed when the file only
    // GREW past a recorded frontier (the append-only steady state), so
    // pass 2 streams just the tail. Cache I/O stays single-threaded — the
    // ledger owns one connection behind a mutex.
    let mut seen_ids: Vec<String> = Vec::with_capacity(candidates.len());
    let mut misses: Vec<(&SessionFileCandidate, Option<ResumeSeed>)> = Vec::new();
    // `(descendant file_mtime, embedded ancestor sids)` per listed file,
    // for the superseded-lineage sweep after pass 3.
    let mut lineage_claims: Vec<(i64, Vec<String>)> = Vec::new();
    for candidate in &candidates {
        seen_ids.push(candidate.session_id.clone());
        let cached = ledger
            .get_scan_cache(&candidate.session_id)
            .unwrap_or_else(|err| {
                tracing::warn!(error = %err, "external scan: cache read failed");
                None
            });
        if let Some(row) = cached {
            if row.file_size == candidate.file_size && row.file_mtime == candidate.file_mtime {
                outcome.cache_hits += 1;
                if !row.excluded {
                    lineage_claims.push((
                        row.file_mtime,
                        decode_lineage(row.lineage_ancestors.as_deref()),
                    ));
                    outcome.metas.push(meta_from_cache_row(row));
                }
                continue;
            }
            let seed = (candidate.file_size > row.file_size)
                .then(|| resume_seed_from_cache(&row))
                .flatten();
            misses.push((candidate, seed));
            continue;
        }
        misses.push((candidate, None));
    }
    outcome.parsed = misses.len();

    // Pass 2 (parallel): stream + parse the cache misses across all cores.
    // Parsing is pure (no ledger access) and embarrassingly parallel — one
    // multi-GB cold scan is dominated by per-line JSON work, not disk, so
    // fanning out across cores is the dominant speedup. Results stay
    // index-aligned with `misses` for the write-back below.
    if !misses.is_empty() {
        progress(0, misses.len());
    }
    let parsed = parse_candidates_parallel(&misses, project_dir, &progress);

    // Pass 3 (sequential): write parse results back to the cache and
    // collect surfaced rows. Exclusions are cached too (with `excluded:
    // true`) so a cwd/sessionId-mismatch file isn't re-streamed every scan;
    // the (size, mtime) key still invalidates if the file changes.
    for ((candidate, _seed), parsed_opt) in misses.iter().zip(parsed) {
        match parsed_opt {
            Some(parsed) => {
                if parsed.resumed {
                    outcome.resumed += 1;
                }
                let row = cache_row_from_parsed(&parsed, project_dir);
                if let Err(err) = ledger.upsert_scan_cache(&row) {
                    tracing::warn!(error = %err, "external scan: cache write failed");
                }
                // Migration / refresh ([P08], S03): a re-parsed session is a
                // fresh `engine(file)` — re-`set` any ledger row for it (any
                // state, live rows included) so a stale pre-epoch count is
                // corrected without opening the session. A cache HIT is
                // skipped (its ledger row was corrected on the parse that
                // wrote the cache), so the steady state writes nothing.
                if let Err(err) = ledger.reconcile_turn_count_from_engine(
                    &parsed.meta.session_id,
                    parsed.meta.turn_count,
                ) {
                    tracing::warn!(error = %err, "external scan: ledger count reconcile failed");
                }
                lineage_claims.push((parsed.meta.file_mtime, parsed.lineage_ancestors.clone()));
                outcome.metas.push(parsed.meta);
            }
            None => {
                let row = ScanCacheRow {
                    session_id: candidate.session_id.clone(),
                    project_dir: project_dir.to_owned(),
                    file_size: candidate.file_size,
                    file_mtime: candidate.file_mtime,
                    excluded: true,
                    turn_count: 0,
                    last_user_prompt: None,
                    name: None,
                    created_at: 0,
                    last_used_at: 0,
                    parse_offset: 0,
                    tail_hash: 0,
                    cwd_checked: false,
                    created_at_found: false,
                    frontier_open: false,
                    frontier_pending_close: false,
                    frontier_pending_close_msg_id: None,
                    frontier_leaf_uuid: None,
                    effective_uuids: None,
                    lineage_ancestors: None,
                    line_id: None,
                };
                if let Err(err) = ledger.upsert_scan_cache(&row) {
                    tracing::warn!(error = %err, "external scan: cache write failed");
                }
            }
        }
    }
    match ledger.prune_scan_cache_except(project_dir, &seen_ids) {
        Ok(pruned) if pruned > 0 => {
            tracing::debug!(
                pruned,
                project_dir,
                "external scan: pruned stale cache rows"
            );
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(error = %err, "external scan: cache prune failed");
        }
    }
    suppress_superseded_lineage(&mut outcome.metas, &lineage_claims);
    // Pass 4: give every surfaced session a line, and read its callsign off
    // it ([P07]). Runs after the lineage sweep so a suppressed ancestor file
    // never births a line of its own. Idempotent — a session that already has
    // one reads it back, so a warm rescan mints nothing. A failure here is not
    // a scan failure: the row simply surfaces tagless and the next scan
    // retries.
    let now = crate::session_ledger::now_millis();
    for meta in &mut outcome.metas {
        if meta.tag.is_some() {
            continue;
        }
        match ledger.ensure_scan_line(&meta.session_id, now) {
            Ok(Some(line_id)) => {
                match ledger.get_line(&line_id) {
                    Ok(Some(line)) => meta.tag = Some(line.tag),
                    Ok(None) => {}
                    Err(err) => {
                        tracing::warn!(error = %err, "external scan: line read failed");
                    }
                }
                meta.line_id = Some(line_id);
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(error = %err, "external scan: line birth failed");
            }
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    // Tests seed fixtures under already-canonical paths, so the raw
    // encoder is the right tool here (production code routes through
    // the `claude_project_dir` chokepoint instead).
    use crate::session_ledger::encode_claude_project_name;

    const SESSION_A: &str = "11111111-2222-3333-4444-555555555555";
    const PROJECT: &str = "/tmp/scan-test-project";

    // The sanitized golden-corpus contract (`scanner_turn_counts_match_golden_corpus`,
    // over `tests/fixtures/turns/`) was deleted with that corpus ([P07]):
    // its tidy, privacy-redacted shapes masked the real gaps (assistant-
    // originated turns, `/compact`, incremental tails). The anti-drift gate
    // is now the real-corpus contract (`turn_engine.rs`,
    // `engine_matches_tugcode_segmentation_over_real_corpus`), which compares
    // the engine to tugcode per-turn over the user's actual local sessions.

    /// Build a TUI-shaped transcript: bookkeeping records around two
    /// user submissions (one string-content, one array-content), a
    /// tool_result echo that must NOT count, and an ai-title.
    fn tui_shaped_jsonl(session_id: &str, cwd: &str) -> String {
        [
            format!(r#"{{"type":"mode","mode":"normal","sessionId":"{session_id}"}}"#),
            format!(r#"{{"type":"permission-mode","permissionMode":"default","sessionId":"{session_id}"}}"#),
            r#"{"type":"file-history-snapshot","messageId":"m1","snapshot":{}}"#.to_owned(),
            format!(
                r#"{{"type":"user","sessionId":"{session_id}","cwd":"{cwd}","timestamp":"2026-06-01T10:00:00.000Z","message":{{"role":"user","content":"first prompt"}}}}"#
            ),
            format!(
                r#"{{"type":"assistant","sessionId":"{session_id}","timestamp":"2026-06-01T10:00:05.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}]}}}}"#
            ),
            format!(
                r#"{{"type":"user","sessionId":"{session_id}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","content":"ok"}}]}}}}"#
            ),
            format!(r#"{{"type":"ai-title","aiTitle":"Scan fixture session","sessionId":"{session_id}"}}"#),
            format!(
                r#"{{"type":"user","sessionId":"{session_id}","message":{{"role":"user","content":[{{"type":"text","text":"second "}},{{"type":"text","text":"prompt"}}]}}}}"#
            ),
        ]
        .join("\n")
            + "\n"
    }

    fn seed(root: &Path, project_dir: &str, session_id: &str, content: &str) {
        let dir = root.join(encode_claude_project_name(project_dir));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{session_id}.jsonl")), content).unwrap();
    }

    /// A session id rotation: the new file embeds the old lineage's records
    /// (old sessionId stamps first, the stem's own later). The newest file
    /// must be listed — not excluded at the first foreign record — and the
    /// superseded ancestor file must be suppressed while it is a stale
    /// prefix, but stay visible once it has forked past the descendant.
    #[test]
    fn a_rotated_lineage_lists_the_newest_file_and_suppresses_the_stale_ancestor() {
        const OLD: &str = "aaaaaaaa-1111-2222-3333-444444444444";
        let root = tempfile::tempdir().unwrap();
        let old_content = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{OLD}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{OLD}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
"#
        );
        // The rotated file: the old lineage's records verbatim, then the
        // stem's own post-rotation records.
        let new_content = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{OLD}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{OLD}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
"#
        );
        seed(root.path(), PROJECT, OLD, &old_content);
        seed(root.path(), PROJECT, SESSION_A, &new_content);
        let dir = root.path().join(encode_claude_project_name(PROJECT));

        // The ancestor stopped growing before the descendant: suppressed.
        let set_mtime = |name: &str, secs: u64| {
            let f = fs::OpenOptions::new()
                .write(true)
                .open(dir.join(format!("{name}.jsonl")))
                .unwrap();
            f.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs))
                .unwrap();
        };
        set_mtime(OLD, 1_000);
        set_mtime(SESSION_A, 2_000);
        let metas = scan_external_sessions(root.path(), PROJECT);
        let ids: Vec<&str> = metas.iter().map(|m| m.session_id.as_str()).collect();
        assert_eq!(
            ids,
            vec![SESSION_A],
            "newest lineage listed, stale ancestor suppressed"
        );
        assert_eq!(metas[0].turn_count, 2, "the rotated file counts normally");

        // The ancestor grew past the descendant (a fork): both visible.
        set_mtime(OLD, 3_000);
        let metas = scan_external_sessions(root.path(), PROJECT);
        let mut ids: Vec<&str> = metas.iter().map(|m| m.session_id.as_str()).collect();
        ids.sort_unstable();
        let mut expected = vec![OLD, SESSION_A];
        expected.sort_unstable();
        assert_eq!(ids, expected, "a forked ancestor stays visible");
    }

    /// A file whose records claim session ids but never the filename's stem
    /// is another session's content under this name — still excluded.
    #[test]
    fn a_file_that_never_claims_its_stem_is_excluded() {
        const OTHER: &str = "bbbbbbbb-1111-2222-3333-444444444444";
        let root = tempfile::tempdir().unwrap();
        let content = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{OTHER}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
"#
        );
        seed(root.path(), PROJECT, SESSION_A, &content);
        let metas = scan_external_sessions(root.path(), PROJECT);
        assert!(metas.is_empty(), "foreign-only file must be excluded");
    }

    /// The seed a cache round-trip would hand the next scan for `parsed` —
    /// what `resume_seed_from_cache` builds from the row this parse writes.
    fn seed_from(parsed: &ParsedSession) -> ResumeSeed {
        ResumeSeed {
            offset: parsed.resume.parse_offset,
            tail_hash: parsed.resume.tail_hash,
            cwd_checked: parsed.resume.cwd_checked,
            created_at_found: parsed.resume.created_at_found,
            turn_count: parsed.meta.turn_count,
            last_user_prompt: parsed.meta.last_user_prompt.clone(),
            name: parsed.meta.name.clone(),
            created_at: parsed.meta.created_at,
            frontier: parsed.resume.frontier.clone(),
            effective_uuids: parsed
                .resume
                .effective_uuids
                .as_deref()
                .and_then(decode_uuid_set)
                .expect("parse recorded a resumable uuid set"),
            lineage_ancestors: parsed.lineage_ancestors.clone(),
        }
    }

    #[test]
    fn extracts_turn_count_prompt_and_title() {
        let root = tempfile::tempdir().unwrap();
        seed(
            root.path(),
            PROJECT,
            SESSION_A,
            &tui_shaped_jsonl(SESSION_A, PROJECT),
        );
        let metas = scan_external_sessions(root.path(), PROJECT);
        assert_eq!(metas.len(), 1);
        let m = &metas[0];
        assert_eq!(m.session_id, SESSION_A);
        assert_eq!(m.turn_count, 2, "tool_result echo must not count");
        assert_eq!(m.last_user_prompt.as_deref(), Some("second prompt"));
        assert_eq!(m.name.as_deref(), Some("Scan fixture session"));
        assert_eq!(m.created_at, 1780308000000, "first record timestamp");
        assert!(m.last_used_at > 0);
    }

    /// A slash command persists as a `<command-name>` envelope and opens a
    /// turn, but it is a command, not a prompt: the row's human-meaningful
    /// line stays the last PROSE prompt, and raw envelope markup never
    /// becomes `last_user_prompt`.
    #[test]
    fn a_command_envelope_does_not_replace_the_last_prompt() {
        let root = tempfile::tempdir().unwrap();
        let envelope = "<command-name>/compact</command-name> \
                        <command-message>compact</command-message> \
                        <command-args></command-args>";
        let content = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"real ask"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"done"}}]}}}}
{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"{envelope}"}}}}
"#
        );
        seed(root.path(), PROJECT, SESSION_A, &content);
        let metas = scan_external_sessions(root.path(), PROJECT);
        assert_eq!(metas.len(), 1);
        assert_eq!(
            metas[0].last_user_prompt.as_deref(),
            Some("real ask"),
            "the envelope opened a turn but must not become the prompt"
        );
        assert_eq!(metas[0].turn_count, 2, "the command still counts as a turn");
    }

    #[test]
    fn empty_session_yields_zero_turns() {
        let root = tempfile::tempdir().unwrap();
        let content = format!(r#"{{"type":"mode","mode":"normal","sessionId":"{SESSION_A}"}}"#);
        seed(root.path(), PROJECT, SESSION_A, &content);
        let metas = scan_external_sessions(root.path(), PROJECT);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].turn_count, 0);
        assert_eq!(metas[0].last_user_prompt, None);
        // No timestamp-bearing record: created_at falls back to mtime.
        assert_eq!(metas[0].created_at, metas[0].last_used_at);
    }

    #[test]
    fn cwd_mismatch_is_excluded() {
        let root = tempfile::tempdir().unwrap();
        seed(
            root.path(),
            PROJECT,
            SESSION_A,
            &tui_shaped_jsonl(SESSION_A, "/tmp/other-project"),
        );
        assert!(scan_external_sessions(root.path(), PROJECT).is_empty());
    }

    #[test]
    fn session_id_mismatch_is_excluded() {
        let root = tempfile::tempdir().unwrap();
        seed(
            root.path(),
            PROJECT,
            SESSION_A,
            &tui_shaped_jsonl("99999999-8888-7777-6666-555555555555", PROJECT),
        );
        assert!(scan_external_sessions(root.path(), PROJECT).is_empty());
    }

    #[test]
    fn non_session_files_and_dirs_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(encode_claude_project_name(PROJECT));
        fs::create_dir_all(dir.join(".tug-trash/123")).unwrap();
        fs::create_dir_all(dir.join(format!("{SESSION_A}/subagents"))).unwrap();
        fs::write(dir.join(".DS_Store"), "x").unwrap();
        fs::write(dir.join("notes.jsonl"), "{}").unwrap();
        fs::write(
            dir.join("UPPERCASE-2222-3333-4444-555555555555.jsonl"),
            "{}",
        )
        .unwrap();
        assert!(scan_external_sessions(root.path(), PROJECT).is_empty());
    }

    #[test]
    fn missing_project_dir_yields_empty() {
        let root = tempfile::tempdir().unwrap();
        assert!(scan_external_sessions(root.path(), "/never/created").is_empty());
    }

    #[test]
    fn prompt_truncates_at_cap_on_char_boundary() {
        let root = tempfile::tempdir().unwrap();
        let long = "é".repeat(USER_PROMPT_MAX_CHARS + 50);
        let content = format!(
            "{}\n",
            format_args!(
                r#"{{"type":"user","sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"{long}"}}}}"#
            )
        );
        seed(root.path(), PROJECT, SESSION_A, &content);
        let metas = scan_external_sessions(root.path(), PROJECT);
        let prompt = metas[0].last_user_prompt.as_ref().unwrap();
        assert_eq!(prompt.chars().count(), USER_PROMPT_MAX_CHARS);
    }

    fn ledger_with_root(root: &Path) -> SessionLedger {
        SessionLedger::open_with_claude_root(root.join("sessions.db"), root.join("projects"))
            .unwrap()
    }

    #[test]
    fn warm_scan_of_unchanged_dir_parses_nothing() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        seed(
            &root.path().join("projects"),
            PROJECT,
            SESSION_A,
            &tui_shaped_jsonl(SESSION_A, PROJECT),
        );
        let cold = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(cold.parsed, 1);
        assert_eq!(cold.cache_hits, 0);
        assert_eq!(cold.metas.len(), 1);

        let warm = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(warm.parsed, 0, "unchanged file must be served from cache");
        assert_eq!(warm.cache_hits, 1);
        assert_eq!(warm.metas, cold.metas);
    }

    #[test]
    fn changed_file_reparses_and_deleted_file_prunes() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &tui_shaped_jsonl(SESSION_A, PROJECT),
        );
        scan_external_sessions_cached(&ledger, PROJECT);

        // Append a third submission: size changes → re-parse.
        let path = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        let mut content = fs::read_to_string(&path).unwrap();
        content.push_str(&format!(
            "{{\"type\":\"user\",\"sessionId\":\"{SESSION_A}\",\"message\":{{\"role\":\"user\",\"content\":\"third prompt\"}}}}\n"
        ));
        fs::write(&path, content).unwrap();
        let rescan = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(rescan.parsed, 1);
        assert_eq!(rescan.metas[0].turn_count, 3);
        assert_eq!(
            rescan.metas[0].last_user_prompt.as_deref(),
            Some("third prompt")
        );

        // Delete the file: candidate gone, cache row pruned.
        fs::remove_file(&path).unwrap();
        let empty = scan_external_sessions_cached(&ledger, PROJECT);
        assert!(empty.metas.is_empty());
        assert!(ledger.get_scan_cache(SESSION_A).unwrap().is_none());
    }

    #[test]
    fn turn_end_refresh_is_a_no_op_on_an_unchanged_file() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        seed(
            &root.path().join("projects"),
            PROJECT,
            SESSION_A,
            &tui_shaped_jsonl(SESSION_A, PROJECT),
        );
        scan_external_sessions_cached(&ledger, PROJECT);
        // `(size, mtime)` still matches the cached pair, so there is nothing to
        // re-derive and nothing to announce.
        assert!(refresh_session_metrics(&ledger, PROJECT, SESSION_A).is_none());
        // A session with no file at all is the same answer, not a panic.
        assert!(
            refresh_session_metrics(&ledger, PROJECT, "00000000-0000-0000-0000-000000000000")
                .is_none()
        );
    }

    #[test]
    fn turn_end_refresh_writes_the_new_count_and_size() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &terminated_jsonl(SESSION_A, PROJECT, &["first prompt", "second prompt"]),
        );
        // A ledger row for the session, so the count reconcile has something to
        // write. Its own `turn_count` starts sparse.
        ledger
            .record_spawn(SESSION_A, "ws", PROJECT, "card-1", 1, SESSION_A, None)
            .unwrap();
        scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(ledger.get(SESSION_A).unwrap().unwrap().turn_count, 2);

        // A turn lands: the file grows by one submission.
        let path = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        let mut content = fs::read_to_string(&path).unwrap();
        content.push_str(&format!(
            "{{\"type\":\"user\",\"sessionId\":\"{SESSION_A}\",\"cwd\":\"{PROJECT}\",\"message\":{{\"role\":\"user\",\"content\":\"third prompt\"}}}}\n"
        ));
        fs::write(&path, &content).unwrap();

        let metrics = refresh_session_metrics(&ledger, PROJECT, SESSION_A).expect("refreshed");
        assert_eq!(metrics.turn_count, 3);
        assert_eq!(metrics.file_size, content.len() as i64);
        // Both writes landed: the ledger row's count and the scan cache the
        // next push will read its pair from.
        assert_eq!(ledger.get(SESSION_A).unwrap().unwrap().turn_count, 3);
        assert_eq!(
            ledger.scan_metrics_for(SESSION_A).unwrap(),
            Some(SessionScanMetrics {
                file_size: content.len() as i64,
                turn_count: 3,
            })
        );
        // And it is idempotent — a second refresh with no further append has
        // nothing to say.
        assert!(refresh_session_metrics(&ledger, PROJECT, SESSION_A).is_none());
    }

    /// Terminated-lines fixture (every record ends in `\n`) so the
    /// scan records a resumable frontier.
    fn terminated_jsonl(session_id: &str, cwd: &str, prompts: &[&str]) -> String {
        let mut out =
            format!("{{\"type\":\"mode\",\"mode\":\"normal\",\"sessionId\":\"{session_id}\"}}\n");
        for p in prompts {
            out.push_str(&format!(
                "{{\"type\":\"user\",\"sessionId\":\"{session_id}\",\"cwd\":\"{cwd}\",\"timestamp\":\"2026-06-01T10:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{p}\"}}}}\n"
            ));
        }
        out
    }

    /// Set a file's mtime far enough from the previous write that the
    /// `(size, mtime)` validity key always misses — appends within the
    /// same filesystem-timestamp granule would otherwise read as
    /// "unchanged".
    fn bump_mtime(path: &Path, unix_secs: i64) {
        let t =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(unix_secs as u64);
        let f = fs::File::options().append(true).open(path).unwrap();
        f.set_modified(t).unwrap();
    }

    #[test]
    fn grown_file_resumes_from_cached_frontier() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &terminated_jsonl(SESSION_A, PROJECT, &["first", "second"]),
        );
        let path = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        bump_mtime(&path, 1_000_000);

        let cold = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(cold.parsed, 1);
        assert_eq!(cold.resumed, 0);
        assert_eq!(cold.metas[0].turn_count, 2);
        let cached = ledger.get_scan_cache(SESSION_A).unwrap().unwrap();
        assert!(cached.parse_offset > 0, "frontier recorded: {cached:?}");

        // Append a turn (append-only growth) → the rescan resumes.
        let mut content = fs::read_to_string(&path).unwrap();
        content.push_str(&format!(
            "{{\"type\":\"user\",\"sessionId\":\"{SESSION_A}\",\"message\":{{\"role\":\"user\",\"content\":\"third\"}}}}\n"
        ));
        fs::write(&path, content).unwrap();
        bump_mtime(&path, 2_000_000);

        let warm = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(warm.parsed, 1);
        assert_eq!(warm.resumed, 1, "tail-only parse: {warm:?}");
        assert_eq!(warm.metas[0].turn_count, 3);
        assert_eq!(warm.metas[0].last_user_prompt.as_deref(), Some("third"));
        // The frontier advanced; a further unchanged scan is a pure hit.
        let again = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(again.parsed, 0);
        assert_eq!(again.cache_hits, 1);
        assert_eq!(again.metas[0].turn_count, 3);
    }

    const SESSION_B: &str = "66666666-7777-8888-9999-aaaaaaaaaaaa";

    #[test]
    fn a_scan_mints_a_persistent_tag_for_every_external_session() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &terminated_jsonl(SESSION_A, PROJECT, &["first"]),
        );
        seed(
            &projects,
            PROJECT,
            SESSION_B,
            &terminated_jsonl(SESSION_B, PROJECT, &["first"]),
        );

        let cold = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(cold.metas.len(), 2);
        let mut tags: Vec<String> = cold
            .metas
            .iter()
            .map(|m| m.tag.clone().expect("every scanned session gets a tag"))
            .collect();
        tags.sort();
        tags.dedup();
        assert_eq!(tags.len(), 2, "two sessions, two distinct callsigns");

        // A rescan serves from cache and must not re-mint: a callsign is
        // permanent from the moment it is claimed ([P12]).
        let warm = scan_external_sessions_cached(&ledger, PROJECT);
        let mut warm_tags: Vec<String> = warm
            .metas
            .iter()
            .map(|m| m.tag.clone().expect("tag survives the rescan"))
            .collect();
        warm_tags.sort();
        assert_eq!(warm_tags, tags);
    }

    #[test]
    fn a_scan_creates_no_sessions_rows() {
        // Minting at scan time must not smuggle in a provenance change: a
        // discovered session stays `external` until it is first resumed
        // ([Q04]), which is exactly what `SessionRow.provenance` reports.
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &terminated_jsonl(SESSION_A, PROJECT, &["first"]),
        );

        scan_external_sessions_cached(&ledger, PROJECT);
        assert!(
            ledger.get(SESSION_A).unwrap().is_none(),
            "the scan minted a sessions row"
        );
    }

    #[test]
    fn adoption_carries_the_scan_time_tag_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &terminated_jsonl(SESSION_A, PROJECT, &["first"]),
        );
        let scan = scan_external_sessions_cached(&ledger, PROJECT);
        let scanned = scan.metas[0].tag.clone().expect("minted at scan");

        // First resume adopts the session into the ledger. The client's
        // optimistic candidate loses to the callsign the picker already
        // showed — "mine is not taken" makes the re-claim idempotent rather
        // than a collision (Spec S08).
        //
        // The empty `line_id` is the adoption case saying so: the client has
        // no line for a session it has never seen, and the scan-born line
        // ([P07]) is the one the picker has been showing it under.
        ledger
            .record_spawn(
                SESSION_A,
                "ws",
                PROJECT,
                "card-1",
                1_700_000_000_000,
                "",
                Some("some-other"),
            )
            .unwrap();
        assert_eq!(
            ledger.get(SESSION_A).unwrap().unwrap().tag.as_deref(),
            Some(scanned.as_str())
        );
    }

    #[test]
    fn a_restored_session_keeps_the_callsign_it_was_minted() {
        // The cache row is not the arbiter. `prune_scan_cache_except` drops it
        // when the JSONL vanishes, and trashing a session is recoverable by
        // design — so a restore must not hand one session a second callsign.
        // Every commit already citing the first one would otherwise name a tag
        // the session no longer wears ([P12]).
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        let jsonl = terminated_jsonl(SESSION_A, PROJECT, &["first"]);
        seed(&projects, PROJECT, SESSION_A, &jsonl);
        let minted = scan_external_sessions_cached(&ledger, PROJECT).metas[0]
            .tag
            .clone()
            .expect("minted at scan");

        // The file goes away; the next scan prunes its cache row (and with it
        // the stored tag), and the session stops being listed at all.
        let file = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        fs::remove_file(&file).unwrap();
        assert!(
            scan_external_sessions_cached(&ledger, PROJECT)
                .metas
                .is_empty(),
            "the pruned session is no longer listed"
        );

        // The user moves it back. `minted_tags` still names it, so the scan
        // re-reads that callsign rather than rolling a fresh one.
        fs::write(&file, &jsonl).unwrap();
        let restored = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(
            restored.metas[0].tag.as_deref(),
            Some(minted.as_str()),
            "a restored session wears the callsign it was minted"
        );
    }

    #[test]
    fn rewritten_prefix_falls_back_to_full_parse() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &terminated_jsonl(SESSION_A, PROJECT, &["first", "second"]),
        );
        let path = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        bump_mtime(&path, 1_000_000);
        scan_external_sessions_cached(&ledger, PROJECT);

        // Rewrite history (a rewind/compaction): the file GROWS but the
        // bytes at the old frontier change — the fingerprint must catch
        // it and the parse must restart from byte 0, not double-count.
        fs::write(
            &path,
            terminated_jsonl(SESSION_A, PROJECT, &["rewritten", "history", "entirely"]),
        )
        .unwrap();
        bump_mtime(&path, 2_000_000);

        let rescan = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(rescan.parsed, 1);
        assert_eq!(rescan.resumed, 0, "fingerprint mismatch: {rescan:?}");
        assert_eq!(rescan.metas[0].turn_count, 3);
        assert_eq!(
            rescan.metas[0].last_user_prompt.as_deref(),
            Some("entirely")
        );
    }

    #[test]
    fn shrunken_file_falls_back_to_full_parse() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &terminated_jsonl(SESSION_A, PROJECT, &["first", "second", "third"]),
        );
        let path = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        bump_mtime(&path, 1_000_000);
        scan_external_sessions_cached(&ledger, PROJECT);

        fs::write(&path, terminated_jsonl(SESSION_A, PROJECT, &["only"])).unwrap();
        bump_mtime(&path, 2_000_000);
        let rescan = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(rescan.parsed, 1);
        assert_eq!(rescan.resumed, 0);
        assert_eq!(rescan.metas[0].turn_count, 1);
        assert_eq!(rescan.metas[0].last_user_prompt.as_deref(), Some("only"));
    }

    /// A partial final line is deferred whole: invisible to this scan's meta
    /// and frontier, and no bar to resumability. Once the writer terminates
    /// it, the next scan resumes from the frontier and counts it exactly
    /// once ([P05]).
    #[test]
    fn unterminated_tail_line_is_deferred_to_the_next_scan() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        // Mid-write capture: the final line has no trailing newline.
        let mut content = terminated_jsonl(SESSION_A, PROJECT, &["first"]);
        let partial = format!(
            "{{\"type\":\"user\",\"sessionId\":\"{SESSION_A}\",\"message\":{{\"role\":\"user\",\"content\":\"partial\"}}}}"
        );
        content.push_str(&partial);
        seed(&projects, PROJECT, SESSION_A, &content);
        let path = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        bump_mtime(&path, 1_000_000);

        let cold = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(
            cold.metas[0].turn_count, 1,
            "the in-flight line is deferred, not counted"
        );
        assert_eq!(
            cold.metas[0].last_user_prompt.as_deref(),
            Some("first"),
            "the deferred line must not reach the meta arm either"
        );
        let cached = ledger.get_scan_cache(SESSION_A).unwrap().unwrap();
        assert!(
            cached.parse_offset > 0,
            "a partial tail must not poison resumability"
        );
        assert_eq!(
            cached.parse_offset as usize,
            content.len() - partial.len(),
            "the frontier stops at the last terminated line"
        );

        // The writer finishes the line; the rescan resumes from the frontier
        // and picks it up exactly once.
        let mut content = fs::read_to_string(&path).unwrap();
        content.push('\n');
        fs::write(&path, content).unwrap();
        bump_mtime(&path, 2_000_000);
        let warm = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(warm.resumed, 1, "tail-only resume, no re-stream");
        assert_eq!(warm.metas[0].turn_count, 2);
        assert_eq!(warm.metas[0].last_user_prompt.as_deref(), Some("partial"));
    }

    /// Two scans across a partial write: seed, append a complete line plus a
    /// partial one, resume, then complete the partial line and resume again.
    /// The end state must equal a from-scratch parse of the finished file.
    #[test]
    fn a_completed_partial_line_resumes_to_the_full_parse_result() {
        let root = tempfile::tempdir().unwrap();
        let path = session_file(root.path());
        let head = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
"#
        );
        let complete = format!(
            r#"{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
"#
        );
        let last = format!(
            r#"{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}"#
        );
        let whole = format!("{head}{complete}{last}\n");

        let full = parse_content(&path, &whole, None);

        let first = parse_content(&path, &head, None);
        // Mid-write: one complete line and one still being written.
        let mid = parse_content(
            &path,
            &format!("{head}{complete}{last}"),
            Some(&seed_from(&first)),
        );
        assert!(mid.resumed, "a partial tail still resumes");
        assert_eq!(
            mid.meta.turn_count, 2,
            "only the terminated append counts this scan"
        );
        // The writer terminates the line.
        let done = parse_content(&path, &whole, Some(&seed_from(&mid)));
        assert!(done.resumed, "the completed line resumes from the frontier");
        assert_eq!(done.meta.turn_count, full.meta.turn_count);
        assert_eq!(done.resume.frontier, full.resume.frontier);
        assert_eq!(done.resume.effective_uuids, full.resume.effective_uuids);
    }

    #[test]
    fn excluded_file_is_cached_and_not_restreamed() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        seed(
            &root.path().join("projects"),
            PROJECT,
            SESSION_A,
            &tui_shaped_jsonl(SESSION_A, "/tmp/other-project"),
        );
        let cold = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(cold.parsed, 1);
        assert!(cold.metas.is_empty());
        let warm = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(warm.parsed, 0, "exclusion must be remembered");
        assert_eq!(warm.cache_hits, 1);
        assert!(warm.metas.is_empty());
    }

    /// The scanner's engine-driven count reproduces the opened-session
    /// authority for the real reference session (`49e9aec6`, expected 81)
    /// — the picker's pre-open count now equals what the session shows once
    /// opened. Local-only ([P07]): reads the user's real JSONL where it
    /// sits and skips when absent. Drives `parse_candidate` directly with
    /// `project_dir` set to the file's own `cwd`, so the directory-encoding
    /// / firmlink machinery is out of the picture — just the scan → engine
    /// path under test.
    #[test]
    fn engine_scanner_counts_reference_session_81() {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = std::path::PathBuf::from(home).join(
            ".claude/projects/-Users-kocienda-Mounts-u-src-tugtool/\
             49e9aec6-7c3a-4c0c-9f74-5a9a0551812e.jsonl",
        );
        let Some((file_size, file_mtime)) = stat_size_mtime(&path) else {
            eprintln!("skipping: reference session not present (local-only fixture)");
            return;
        };
        let candidate = SessionFileCandidate {
            session_id: "49e9aec6-7c3a-4c0c-9f74-5a9a0551812e".into(),
            path,
            file_size,
            file_mtime,
        };
        // The record `cwd` is the project path; pass it verbatim so the
        // direct cwd compare in `parse_session_file` does not exclude it.
        let parsed = parse_candidate(&candidate, "/Users/kocienda/Mounts/u/src/tugtool", None)
            .expect("reference session parses");
        assert_eq!(
            parsed.meta.turn_count, 81,
            "scanner engine count for 49e9aec6 must be 81 (the opened-session authority)"
        );
    }

    /// The incremental resume carries the engine's open-turn frontier across
    /// an append boundary — not merely an offset + count (Risk R02). The
    /// cold file ends mid-turn with a deferred terminal close
    /// (`pending_close`); the appended record is a same-`message.id`
    /// continuation, which a faithful full re-segment keeps as ONE turn.
    /// Without carrying the frontier the resumed parse would synth-open a
    /// phantom second turn — exactly the original incremental undercount in
    /// reverse.
    #[test]
    fn incremental_resume_carries_engine_frontier_across_append() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        let cold = format!(
            "{{\"type\":\"user\",\"sessionId\":\"{SESSION_A}\",\"cwd\":\"{PROJECT}\",\"timestamp\":\"2026-06-01T10:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"q1\"}}}}\n\
             {{\"type\":\"assistant\",\"sessionId\":\"{SESSION_A}\",\"message\":{{\"id\":\"m1\",\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{{\"type\":\"text\",\"text\":\"a1\"}}]}}}}\n"
        );
        seed(&projects, PROJECT, SESSION_A, &cold);
        let path = projects
            .join(encode_claude_project_name(PROJECT))
            .join(format!("{SESSION_A}.jsonl"));
        bump_mtime(&path, 1_000_000);

        let cold_scan = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(cold_scan.metas[0].turn_count, 1, "one user turn so far");
        let cached = ledger.get_scan_cache(SESSION_A).unwrap().unwrap();
        assert!(cached.parse_offset > 0, "resumable frontier recorded");
        assert!(cached.frontier_open, "turn still open at the frontier");
        assert!(
            cached.frontier_pending_close,
            "terminal close deferred at the frontier"
        );

        // Append a same-msg_id continuation half.
        let mut content = fs::read_to_string(&path).unwrap();
        content.push_str(&format!(
            "{{\"type\":\"assistant\",\"sessionId\":\"{SESSION_A}\",\"message\":{{\"id\":\"m1\",\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{{\"type\":\"text\",\"text\":\"a1-cont\"}}]}}}}\n"
        ));
        fs::write(&path, content).unwrap();
        bump_mtime(&path, 2_000_000);

        let warm = scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(warm.resumed, 1, "tail-only resume from the frontier");
        assert_eq!(
            warm.metas[0].turn_count, 1,
            "same-message.id continuation stays one turn across the resume boundary"
        );
    }

    /// A two-turn fixture: a genuine user turn, then an orphan
    /// assistant-originated turn (no user submission before it) — the
    /// engine counts 2, where the old user-record-only rule saw 1.
    fn two_turn_jsonl(session_id: &str, cwd: &str) -> String {
        [
            format!(
                r#"{{"type":"user","sessionId":"{session_id}","cwd":"{cwd}","timestamp":"2026-06-01T10:00:00.000Z","message":{{"role":"user","content":"q1"}}}}"#
            ),
            format!(
                r#"{{"type":"assistant","sessionId":"{session_id}","message":{{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{{"type":"text","text":"a1"}}]}}}}"#
            ),
            format!(
                r#"{{"type":"assistant","sessionId":"{session_id}","message":{{"id":"m2","role":"assistant","stop_reason":"end_turn","content":[{{"type":"text","text":"orphan"}}]}}}}"#
            ),
        ]
        .join("\n")
            + "\n"
    }

    /// `engine_turn_count` runs the engine when there is no cache entry (a
    /// resume that bypassed a picker scan), then serves the cached value
    /// after a scan populates it — the [Q01] no-cache fallback.
    #[test]
    fn engine_turn_count_runs_engine_then_serves_cache() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &two_turn_jsonl(SESSION_A, PROJECT),
        );

        // No scan yet → no cache entry → the engine runs on the file.
        assert_eq!(engine_turn_count(&ledger, PROJECT, SESSION_A), Some(2));

        // After a scan caches the engine output, the cached value is served.
        scan_external_sessions_cached(&ledger, PROJECT);
        assert_eq!(engine_turn_count(&ledger, PROJECT, SESSION_A), Some(2));

        // A session with no file resolves to None (caller skips reconcile).
        assert_eq!(
            engine_turn_count(&ledger, PROJECT, "00000000-0000-0000-0000-000000000000"),
            None
        );
    }

    /// Migration ([P08], S03): a ledger row carrying a stale count is
    /// corrected to `engine(file)` on re-scan, without opening the session
    /// — including a row left in `live` state.
    #[test]
    fn scan_migrates_stale_ledger_count_to_engine() {
        let root = tempfile::tempdir().unwrap();
        let ledger = ledger_with_root(root.path());
        let projects = root.path().join("projects");
        seed(
            &projects,
            PROJECT,
            SESSION_A,
            &two_turn_jsonl(SESSION_A, PROJECT),
        );

        // A ledger row with an inflated stale count, left live.
        ledger
            .record_spawn(SESSION_A, "ws", PROJECT, "card-1", 1_000, SESSION_A, None)
            .unwrap();
        ledger.set_turn_count(SESSION_A, 59, 1_000).unwrap();
        assert_eq!(ledger.get(SESSION_A).unwrap().unwrap().turn_count, 59);

        // The scan produces engine(file)=2 and re-sets the ledger row.
        let scan = scan_external_sessions_cached(&ledger, PROJECT);
        let meta = scan
            .metas
            .iter()
            .find(|m| m.session_id == SESSION_A)
            .unwrap();
        assert_eq!(
            meta.turn_count, 2,
            "engine counts the orphan assistant turn"
        );
        let row = ledger.get(SESSION_A).unwrap().unwrap();
        assert_eq!(
            row.turn_count, 2,
            "stale ledger count migrated to engine(file) on re-scan, live row included"
        );
    }

    /// A linear session — one uuid per record, each parenting to its
    /// predecessor, no compaction — is provably free of dead branches and
    /// duplicates, so the streamed count stands and the buffer is dropped.
    #[test]
    fn a_linear_session_keeps_the_single_pass_count() {
        let root = tempfile::tempdir().unwrap();
        let content = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
"#
        );
        seed(root.path(), PROJECT, SESSION_A, &content);
        let dir = root.path().join(encode_claude_project_name(PROJECT));
        let path = dir.join(format!("{SESSION_A}.jsonl"));
        let md = fs::metadata(&path).unwrap();
        let parsed = parse_session_file(&path, PROJECT, SESSION_A, md.len() as i64, 0, None)
            .unwrap()
            .unwrap();
        assert!(
            !parsed.recounted,
            "a linear session must not need the EOF second pass"
        );
        assert_eq!(parsed.meta.turn_count, 2);
        assert_eq!(parsed.resume.frontier.leaf_uuid.as_deref(), Some("a2"));
    }

    /// A compaction re-append duplicates uuids, so the second pass runs and
    /// counts each preserved turn once — the whole point of the effective
    /// sequence. Splitting the same file at an incremental boundary INSIDE
    /// the re-append block must reach the identical count — the case the
    /// per-slice triggers cannot see, because the tail of a straddled
    /// re-append looks perfectly linear. What saves it is the seed's
    /// effective-uuid set: every record of the straddled tail is a known
    /// uuid and is suppressed inline, so the resume neither re-counts a
    /// preserved turn nor re-streams the file.
    #[test]
    fn an_incremental_split_inside_a_re_append_matches_a_full_segment() {
        let root = tempfile::tempdir().unwrap();
        // Two turns, a compaction, then those two turns re-appended
        // verbatim, then a third turn.
        let head = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
{{"type":"system","uuid":"c1","parentUuid":null,"subtype":"compact_boundary","sessionId":"{SESSION_A}"}}
{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","message":{{"role":"user","content":"first"}}}}
"#
        );
        let tail = format!(
            r#"{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u3","parentUuid":"a2","sessionId":"{SESSION_A}","message":{{"role":"user","content":"third"}}}}
{{"type":"assistant","uuid":"a3","parentUuid":"u3","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"done"}}],"id":"m3","stop_reason":"end_turn"}}}}
"#
        );
        let whole = format!("{head}{tail}");

        let dir = root.path().join(encode_claude_project_name(PROJECT));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{SESSION_A}.jsonl"));

        // Full segment of the whole file.
        fs::write(&path, &whole).unwrap();
        let full = parse_session_file(&path, PROJECT, SESSION_A, whole.len() as i64, 0, None)
            .unwrap()
            .unwrap();
        assert!(full.recounted, "a re-append must take the second pass");
        // u1/u2 preserved once each plus u3 — the /compact continuation
        // opens no separate container here because the summary is absent.
        assert_eq!(full.meta.turn_count, 3);

        // Now the same file assembled incrementally: scan the head, then
        // resume across the boundary that sits inside the re-append block.
        fs::write(&path, &head).unwrap();
        let first = parse_session_file(&path, PROJECT, SESSION_A, head.len() as i64, 0, None)
            .unwrap()
            .unwrap();
        let seed = seed_from(&first);
        fs::write(&path, &whole).unwrap();
        let resumed = parse_session_file(
            &path,
            PROJECT,
            SESSION_A,
            whole.len() as i64,
            0,
            Some(&seed),
        )
        .unwrap()
        .unwrap();
        assert!(
            resumed.resumed,
            "the straddled tail must resume incrementally — its re-appends are \
             suppressed against the seed's effective-uuid set"
        );
        assert_eq!(
            resumed.meta.turn_count, full.meta.turn_count,
            "incremental resume with suppression must equal the full segment"
        );
        assert_eq!(
            resumed.resume.frontier, full.resume.frontier,
            "the resumed frontier must equal the full segment's"
        );
        assert_eq!(
            resumed.resume.effective_uuids, full.resume.effective_uuids,
            "the resumed uuid set must equal the full segment's"
        );
    }

    /// Write `content` to a fresh session file and parse it, optionally from
    /// a seed. Returns the parse; the path is reused across calls so a head
    /// parse and the resume that follows it see the same file.
    fn parse_content(path: &Path, content: &str, seed: Option<&ResumeSeed>) -> ParsedSession {
        fs::write(path, content).unwrap();
        parse_session_file(path, PROJECT, SESSION_A, content.len() as i64, 0, seed)
            .unwrap()
            .unwrap()
    }

    fn session_file(root: &Path) -> std::path::PathBuf {
        let dir = root.join(encode_claude_project_name(PROJECT));
        fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{SESSION_A}.jsonl"))
    }

    /// An appended non-user record whose parent is not the carried leaf, but
    /// which attaches AT the frontier or inside the slice — a `tool_result`
    /// sibling, a hook attachment, an API-retry spur. It strands no prefix
    /// record, so the prefix's live closure (and therefore its dead set) is
    /// untouched and the resumed slice absorbs it inline instead of
    /// re-streaming the file ([P04]).
    #[test]
    fn a_resumed_slice_absorbs_an_off_leaf_non_user_record() {
        let root = tempfile::tempdir().unwrap();
        let path = session_file(root.path());
        let head = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
"#
        );
        // `t1` and `t2` are tool_result-only user records (not submissions)
        // that both parent to `a1`, the carried leaf: once `t1` has moved the
        // leaf, `t2` is off-leaf but re-attaches exactly AT the frontier.
        // `t3` is off-leaf too and re-attaches to `t1`, inside the slice.
        let tail = format!(
            r#"{{"type":"user","uuid":"t1","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"x1","content":"ok"}}]}}}}
{{"type":"user","uuid":"t2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"x2","content":"ok"}}]}}}}
{{"type":"user","uuid":"t3","parentUuid":"t1","sessionId":"{SESSION_A}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"x3","content":"ok"}}]}}}}
{{"type":"user","uuid":"u2","parentUuid":"t3","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
"#
        );
        let whole = format!("{head}{tail}");

        let full = parse_content(&path, &whole, None);
        let first = parse_content(&path, &head, None);
        let seed = seed_from(&first);
        let resumed = parse_content(&path, &whole, Some(&seed));

        assert!(
            resumed.resumed,
            "an off-leaf non-user record must be absorbed, not re-streamed"
        );
        assert_eq!(
            resumed.meta.turn_count, full.meta.turn_count,
            "absorbed inline must equal the full parse's count"
        );
        assert_eq!(
            resumed.resume.frontier, full.resume.frontier,
            "absorbed inline must equal the full parse's frontier"
        );
        assert_eq!(
            resumed.resume.effective_uuids, full.resume.effective_uuids,
            "absorbed inline must equal the full parse's uuid set"
        );
    }

    /// A non-user record re-attaching BELOW the carried frontier strands the
    /// prefix records that followed its parent. That relocates the newest
    /// leaf's ancestor walk onto another prefix branch, and any prefix dead
    /// root whose parent was stranded stops qualifying — so records the head
    /// parse buried come back. Only a full re-stream sees that, and the count
    /// it produces is the one that must win.
    #[test]
    fn a_resumed_slice_re_streams_when_a_record_re_attaches_below_the_frontier() {
        let root = tempfile::tempdir().unwrap();
        let path = session_file(root.path());
        // The head buries the two-turn `u2` branch: `u2` is an off-chain user
        // submission whose parent `a1` is live, so the head counts `u1` and
        // the one-turn `u3` branch — two turns, not four.
        let head = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u2b","parentUuid":"a2","sessionId":"{SESSION_A}","message":{{"role":"user","content":"carry on"}}}}
{{"type":"assistant","uuid":"a2b","parentUuid":"u2b","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"will do"}}],"id":"m2b","stop_reason":"end_turn"}}}}
{{"type":"user","uuid":"u3","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"third"}}}}
{{"type":"assistant","uuid":"a3","parentUuid":"u3","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"sure"}}],"id":"m3","stop_reason":"end_turn"}}}}
"#
        );
        // `t1` is not a submission, and it re-attaches to `a2b` — below the
        // carried leaf `a3`. The live chain now runs through the `u2` branch,
        // so `u2` is no longer an off-chain submission with a live parent and
        // its two turns are resurrected; the one-turn `u3` branch is stranded
        // and buried instead. The count moves, which is the whole defect.
        let tail = format!(
            r#"{{"type":"user","uuid":"t1","parentUuid":"a2b","sessionId":"{SESSION_A}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"x1","content":"ok"}}]}}}}
{{"type":"assistant","uuid":"a4","parentUuid":"t1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"onward"}}],"id":"m4","stop_reason":"end_turn"}}}}
"#
        );
        let whole = format!("{head}{tail}");

        let full = parse_content(&path, &whole, None);
        let first = parse_content(&path, &head, None);
        let seed = seed_from(&first);
        let resumed = parse_content(&path, &whole, Some(&seed));

        // The fixture only bites if the re-attachment actually moves the
        // count. The head buries the two-turn `u2` branch and counts `u1` plus
        // the `u3` branch; the whole file resurrects `u2`/`u2b`, buries `u3`
        // instead, and `a4` opens a container of its own after `a2b` closed.
        assert_eq!(first.meta.turn_count, 2, "the head buries the `u2` branch");
        assert_eq!(
            full.meta.turn_count, 4,
            "the whole file resurrects it and buries `u3` instead"
        );
        assert!(
            !resumed.resumed,
            "re-attaching below the frontier must re-stream so the prefix's \
             dead set is recomputed"
        );
        assert_eq!(resumed.meta.turn_count, full.meta.turn_count);
        assert_eq!(resumed.resume.frontier, full.resume.frontier);
        assert_eq!(resumed.resume.effective_uuids, full.resume.effective_uuids);
    }

    /// The shape the trigger exists for: an off-leaf USER submission is a
    /// rewind, which kills the abandoned branch and so changes the prefix's
    /// effective membership. The resumed slice must give up and re-stream.
    #[test]
    fn a_resumed_slice_re_streams_on_an_off_leaf_user_submission() {
        let root = tempfile::tempdir().unwrap();
        let path = session_file(root.path());
        let head = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
"#
        );
        // `u2` re-parents to `u1`, abandoning `a1` — the rewind shape.
        let tail = format!(
            r#"{{"type":"user","uuid":"u2","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"instead, this"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
"#
        );
        let whole = format!("{head}{tail}");

        let full = parse_content(&path, &whole, None);
        let first = parse_content(&path, &head, None);
        let seed = seed_from(&first);
        let resumed = parse_content(&path, &whole, Some(&seed));

        assert!(
            !resumed.resumed,
            "a rewind must re-stream so the dead branch is recomputed"
        );
        assert_eq!(resumed.meta.turn_count, full.meta.turn_count);
        assert_eq!(resumed.resume.frontier, full.resume.frontier);
        assert_eq!(resumed.resume.effective_uuids, full.resume.effective_uuids);
    }

    /// A row written before the leaf uuid existed carries `None`, so the
    /// first appended chain record cannot match it: the seed is effectively
    /// non-resumable and the file re-streams once, after which the recorded
    /// leaf lets ordinary appends resume incrementally.
    #[test]
    fn a_seed_without_a_leaf_uuid_re_streams_once_then_resumes() {
        let root = tempfile::tempdir().unwrap();
        let head = format!(
            r#"{{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"{SESSION_A}","cwd":"{PROJECT}","message":{{"role":"user","content":"first"}}}}
{{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"id":"m1","stop_reason":"end_turn"}}}}
"#
        );
        let appended = format!(
            r#"{{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"{SESSION_A}","message":{{"role":"user","content":"second"}}}}
{{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"{SESSION_A}","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}}],"id":"m2","stop_reason":"end_turn"}}}}
"#
        );
        let dir = root.path().join(encode_claude_project_name(PROJECT));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{SESSION_A}.jsonl"));
        fs::write(&path, &head).unwrap();
        let first = parse_session_file(&path, PROJECT, SESSION_A, head.len() as i64, 0, None)
            .unwrap()
            .unwrap();

        let mut stale = seed_from(&first);
        // What an epoch-2 row deserializes to: no leaf uuid.
        stale.frontier.leaf_uuid = None;

        let whole = format!("{head}{appended}");
        fs::write(&path, &whole).unwrap();
        let re_streamed = parse_session_file(
            &path,
            PROJECT,
            SESSION_A,
            whole.len() as i64,
            0,
            Some(&stale),
        )
        .unwrap()
        .unwrap();
        assert!(
            !re_streamed.resumed,
            "a leaf-less seed must fall back to a full re-stream"
        );
        assert_eq!(re_streamed.meta.turn_count, 2);
        assert_eq!(
            re_streamed.resume.frontier.leaf_uuid.as_deref(),
            Some("a2"),
            "the re-stream records a real leaf"
        );

        // With that leaf recorded, an ordinary append resumes incrementally.
        let good = seed_from(&re_streamed);
        let more = format!(
            r#"{{"type":"user","uuid":"u3","parentUuid":"a2","sessionId":"{SESSION_A}","message":{{"role":"user","content":"third"}}}}
"#
        );
        let grown = format!("{whole}{more}");
        fs::write(&path, &grown).unwrap();
        let incremental = parse_session_file(
            &path,
            PROJECT,
            SESSION_A,
            grown.len() as i64,
            0,
            Some(&good),
        )
        .unwrap()
        .unwrap();
        assert!(incremental.resumed, "an ordinary append resumes");
        assert_eq!(incremental.meta.turn_count, 3);
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let root = tempfile::tempdir().unwrap();
        let content = format!(
            "not json\n{{\"type\":\"user\",\"sessionId\":\"{SESSION_A}\",\"cwd\":\"{PROJECT}\",\"message\":{{\"role\":\"user\",\"content\":\"ok\"}}}}\n[1,2,3]"
        );
        seed(root.path(), PROJECT, SESSION_A, &content);
        let metas = scan_external_sessions(root.path(), PROJECT);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].turn_count, 1);
    }
}
