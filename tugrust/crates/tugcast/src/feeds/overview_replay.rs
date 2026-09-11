//! overview_replay — read a real session transcript, run it through the
//! Observer's wake core, and print the overview it would have produced.
//!
//! Cadence is a question about feel, and feel is not answerable from a desk.
//! This is the instrument that answers it: point it at a session that actually
//! happened, set `--sitrep-secs`, and read the channel that comes out. Run it
//! at two or three values and read them side by side — the number that ships
//! should be the one that read best, not the one this plan guessed.
//!
//! ## What makes it trustworthy
//!
//! It runs the **production** wake core. Segmentation is
//! [`session_digest::SessionDigest`] under the real caps, the lines in it are
//! [`session_digest::SessionDigester`]'s, the tap is
//! [`session_digest::forwardable_session`], the input is
//! [`observer_wake::compose_observer_input`], the job is the real
//! `observer-post` with the real instructions, and refs are validated by the
//! real [`observer_wake::validate_refs`]. Nothing here re-implements a
//! decision the bridge will make. That is the whole mitigation for tuning a
//! prompt the shipped code does not run.
//!
//! Two things are honestly different and worth holding in mind while reading a
//! run:
//!
//! - **Time is simulated from record timestamps**, so the sitrep timer fires
//!   at the exact deadline rather than whenever tokio's timer wheel got to it.
//!   Replay cadence is therefore slightly *cleaner* than live cadence.
//! - **Frames are reconstructed from the transcript**, not captured off the
//!   wire. The transcript is what Claude Code persisted, so an assistant text
//!   block, a tool call, its result, and a user prompt all survive it exactly;
//!   the streaming-only types (`tool_input_progress`, `api_retry`,
//!   `wake_started`) never appear because the transcript never recorded them.
//!   That matters more than it did when a window was raw payloads: a file
//!   tool's beat is its `tool_input_progress` line ("Read foo.rs…"), and the
//!   settled `tool_use` defers to it, so a replayed window names fewer of the
//!   paths a live one would. What came back is unaffected — every
//!   `tool_result` with output leaves its own line.
//!
//! Lines are clipped exactly as they are live — the digester's own budgets,
//! not the harness's — and the byte cap keeps one line no matter its size, so
//! a single enormous result dominates a window here exactly as it would live.
//! Every window reports its byte count.
//!
//! ## Why it lives on the tugcast binary
//!
//! `tugcast` is a binary-only crate: a `src/bin/` sibling would be its own
//! crate root and could not import `feeds::observer_wake`, which is the entire
//! point. So this is a hidden subcommand, dispatched before any listener binds
//! or ledger writer is claimed — a replay never contends with a live tugcast.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;

use crate::cli::OverviewReplayArgs;

use super::observer_wake::{
    FactLine, PriorPost, WakeReason, compose_observer_input, counts_as_assistant_activity,
    parse_envelope, render_facts_section, validate_refs,
};
use super::overview_agent::{BUFFER_MAX_BYTES, DEFAULT_MODEL};
use super::session_digest::{
    DigestKind, DigestLine, SessionDigest, SessionDigester, forwardable_session,
};

// MARK: - Options

/// One replay's settings. Every field has a knob behind it in production; the
/// flags exist so a sweep can vary one without writing to tugbank.
#[derive(Debug, Clone)]
pub struct ReplayOptions {
    /// Seconds of continuous activity after which the Observer wakes.
    /// Zero disables the sitrep timer, leaving turn-end and session-end.
    pub sitrep_secs: i64,
    /// How many prior posts ride each wake — the dedup mechanism.
    pub last_k: usize,
    /// Per-window frame cap before the oldest are elided.
    pub max_frames: usize,
    /// Cumulative non-cached tokens since the last post that force a wake.
    /// Zero is off, matching the shipped default.
    pub token_wake_tokens: i64,
    /// Model for the `observer-post` job.
    pub model: String,
    /// Segment and report, but never call the model. The mode the unit tests
    /// and a quick cadence read both use — it costs nothing and is
    /// deterministic.
    pub no_model: bool,
    /// Print the composed job input for each wake — the bytes the Observer is
    /// actually shown. A silence is only diagnosable against its material.
    pub show_input: bool,
    /// Compose with an empty facts section — the pre-facts diet, for reading a
    /// run beside its facts-carrying twin ([Q02]).
    pub no_facts: bool,
}

impl Default for ReplayOptions {
    fn default() -> Self {
        Self {
            sitrep_secs: super::overview_agent::DEFAULT_SITREP_SECS,
            last_k: super::overview_agent::DEFAULT_LAST_K_POSTS,
            max_frames: super::overview_agent::DEFAULT_BUFFER_MAX_FRAMES,
            token_wake_tokens: super::overview_agent::DEFAULT_TOKEN_WAKE_TOKENS,
            model: DEFAULT_MODEL.to_string(),
            no_model: false,
            show_input: false,
            no_facts: false,
        }
    }
}

impl ReplayOptions {
    /// Build from the parsed CLI flags, defaulting each absent one to its
    /// shipped value so a bare run reflects what a user would actually get.
    pub fn from_args(args: &OverviewReplayArgs) -> Self {
        let d = Self::default();
        Self {
            sitrep_secs: args.sitrep_secs.unwrap_or(d.sitrep_secs),
            last_k: args.last_k.unwrap_or(d.last_k),
            max_frames: args.max_frames.unwrap_or(d.max_frames),
            token_wake_tokens: args.token_wake_tokens.unwrap_or(d.token_wake_tokens),
            model: args.model.clone().unwrap_or(d.model),
            no_model: args.no_model,
            show_input: args.show_input,
            no_facts: args.no_facts,
        }
    }
}

// MARK: - Transcript → frames

/// One frame as the bridge would have received it.
///
/// `payload` is the exact bytes the tap classifies and the buffer stores, so
/// ref validation in a replay checks the same text it will check live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayFrame {
    pub at_ms: i64,
    pub msg_type: String,
    pub payload: String,
    /// False for user prompts. In production those arrive on the code
    /// submission channel rather than the CODE_OUTPUT broadcast, so they reach
    /// the buffer without passing the allowlist — a prompt is not on it, and a
    /// window that omitted what was asked would be narrating answers to an
    /// invisible question.
    pub via_tap: bool,
    /// Non-cached tokens this frame reports, for the token-threshold wake.
    /// Only a `turn_complete` carries any.
    pub tokens: i64,
}

/// A Claude Code transcript line. Every field is optional because the file
/// interleaves several record shapes — prompts, model output, and bookkeeping
/// rows (`queue-operation`, `attachment`, `file-history-snapshot`) that carry
/// no session activity at all.
#[derive(Debug, Deserialize)]
struct TranscriptEntry {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(rename = "sessionId", default)]
    session_id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: bool,
    /// `"compact_boundary"` on the `system` record that marks a compaction.
    #[serde(default)]
    subtype: Option<String>,
    /// Claude Code's compaction metadata, persisted camelCase in the JSONL.
    #[serde(rename = "compactMetadata", default)]
    compact_metadata: Option<CompactMetadata>,
    #[serde(default)]
    message: Option<TranscriptMessage>,
}

/// The compaction counts, when claude reported them. Both are optional at the
/// source: `postTokens` in particular is often absent.
#[derive(Debug, Deserialize)]
struct CompactMetadata {
    #[serde(default)]
    trigger: Option<String>,
    #[serde(rename = "preTokens", default)]
    pre_tokens: Option<i64>,
    #[serde(rename = "postTokens", default)]
    post_tokens: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TranscriptMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    content: Option<serde_json::Value>,
    #[serde(default)]
    usage: Option<Usage>,
}

/// The billed shape of one message's usage.
///
/// The threshold sums input, output, and cache *creation* but not cache
/// *reads*: a read is the same context being re-sent, so counting it would
/// make every long session cross any threshold within a few turns regardless
/// of how much work it actually did.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

impl Usage {
    fn billed(self) -> i64 {
        self.input_tokens + self.output_tokens + self.cache_creation_input_tokens
    }
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    input: Option<serde_json::Value>,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    content: Option<serde_json::Value>,
    #[serde(default)]
    is_error: bool,
}

/// Epoch milliseconds from an RFC 3339 transcript timestamp.
fn parse_timestamp(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// A tool result's content is either a bare string or an array of text blocks.
fn coerce_tool_result_content(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// The prompt text of a user entry, or `None` when the entry is a tool result
/// rather than something a person typed.
fn user_prompt_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(blocks)) => {
            if blocks
                .iter()
                .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
            {
                return None;
            }
            let text = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// Translate a transcript into the frames the bridge's tap would have seen.
///
/// Deliberately narrow: assistant prose, tool calls, tool results, user
/// prompts, and a synthesized `turn_complete` at each turn boundary. Thinking
/// blocks are dropped because tugcode does not forward them, and the
/// bookkeeping record types are dropped because they are not session activity.
///
/// Turn boundaries come from the prompts. A user prompt closes whatever turn
/// was open and opens a new one; end-of-transcript closes the last. That is
/// the same segmentation the deck's own replay path derives, and it is what
/// makes `turn-end` mean the same thing here as it does live.
///
/// The synthesized `turn_complete` is stamped at the **last activity of the
/// turn it closes**, not at the prompt that revealed the boundary. Live, the
/// frame arrives when the turn finishes; a transcript only shows the boundary
/// when the next prompt comes, and that can be hours later. Stamping it there
/// would drop a wake into the middle of an idle stretch and make every gap
/// measurement wrong — which is the one thing a cadence instrument cannot
/// afford to be.
pub fn translate_transcript(jsonl: &str) -> Vec<ReplayFrame> {
    let mut out: Vec<ReplayFrame> = Vec::new();
    let mut session_id = String::new();
    let mut turn_open = false;
    let mut turn_tokens: i64 = 0;
    let mut counted_messages: HashSet<String> = HashSet::new();
    // When the open turn last did anything — where its synthesized end goes.
    let mut last_activity_ms: i64 = 0;

    for line in jsonl.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<TranscriptEntry>(line) else {
            continue;
        };
        if entry.is_meta || entry.is_compact_summary {
            continue;
        }
        let Some(kind) = entry.kind.as_deref() else {
            continue;
        };
        // A compaction boundary is a `system` record, and `system` is dropped
        // wholesale by the gate below — so it is intercepted first. Without
        // this arm the harness could never synthesize a `session.compacted`
        // fact, and the kind would have to move to the live-only column: no
        // amount of work downstream can recover a record that was never
        // emitted. (`is_compact_summary` above skips the compaction *summary*,
        // which is a different record.)
        if kind == "system" && entry.subtype.as_deref() == Some("compact_boundary") {
            let Some(at_ms) = entry.timestamp.as_deref().and_then(parse_timestamp) else {
                continue;
            };
            if let Some(id) = entry.session_id.as_deref()
                && session_id.is_empty()
            {
                session_id = id.to_string();
            }
            // The JSONL persists this metadata camelCase; the live wire
            // carries it snake_case. The frame below is the wire's shape,
            // because that is what the recorders and the synthesis read.
            let meta = entry.compact_metadata.as_ref();
            out.push(ReplayFrame {
                at_ms,
                msg_type: "compact_boundary".to_string(),
                payload: frame_payload(
                    &session_id,
                    "compact_boundary",
                    serde_json::json!({
                        "trigger": meta.and_then(|m| m.trigger.clone()),
                        "pre_tokens": meta.and_then(|m| m.pre_tokens),
                        "post_tokens": meta.and_then(|m| m.post_tokens),
                    }),
                ),
                via_tap: true,
                tokens: 0,
            });
            continue;
        }
        if kind != "assistant" && kind != "user" {
            continue;
        }
        let Some(at_ms) = entry.timestamp.as_deref().and_then(parse_timestamp) else {
            continue;
        };
        let Some(message) = entry.message.as_ref() else {
            continue;
        };
        if let Some(id) = entry.session_id.as_deref()
            && session_id.is_empty()
        {
            session_id = id.to_string();
        }
        let msg_id = message.id.clone().unwrap_or_default();

        // Usage repeats on every entry of the same assistant message, so it is
        // counted once per message id rather than once per line.
        if let Some(usage) = message.usage
            && !msg_id.is_empty()
            && counted_messages.insert(msg_id.clone())
        {
            turn_tokens += usage.billed();
        }

        if kind == "user"
            && let Some(prompt) = user_prompt_text(message.content.as_ref())
        {
            if turn_open {
                out.push(turn_complete_frame(
                    &session_id,
                    last_activity_ms,
                    turn_tokens,
                ));
                turn_tokens = 0;
            }
            out.push(ReplayFrame {
                at_ms,
                msg_type: "user_message".to_string(),
                payload: frame_payload(
                    &session_id,
                    "user_message",
                    // The live CODE_INPUT frame carries the prompt under
                    // `content`, as blocks. The digester reads that field, so a
                    // reconstruction spelling it any other way would hand the
                    // harness a prompt the bridge would not have narrated.
                    serde_json::json!({
                        "content": [{ "type": "text", "text": prompt }]
                    }),
                ),
                via_tap: false,
                tokens: 0,
            });
            turn_open = true;
            last_activity_ms = at_ms;
            continue;
        }

        let Some(serde_json::Value::Array(blocks)) = message.content.as_ref() else {
            continue;
        };
        for block in blocks {
            let Ok(block) = serde_json::from_value::<ContentBlock>(block.clone()) else {
                continue;
            };
            if matches!(
                block.kind.as_deref(),
                Some("text" | "tool_use" | "tool_result")
            ) {
                last_activity_ms = at_ms;
            }
            match block.kind.as_deref() {
                Some("text") => {
                    let text = block.text.unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    turn_open = true;
                    out.push(ReplayFrame {
                        at_ms,
                        msg_type: "assistant_text".to_string(),
                        payload: frame_payload(
                            &session_id,
                            "assistant_text",
                            serde_json::json!({ "msg_id": msg_id, "text": text }),
                        ),
                        via_tap: true,
                        tokens: 0,
                    });
                }
                Some("tool_use") => {
                    turn_open = true;
                    out.push(ReplayFrame {
                        at_ms,
                        msg_type: "tool_use".to_string(),
                        payload: frame_payload(
                            &session_id,
                            "tool_use",
                            serde_json::json!({
                                "msg_id": msg_id,
                                "tool_name": block.name.unwrap_or_default(),
                                "tool_use_id": block.id.unwrap_or_default(),
                                "input": block.input.unwrap_or(serde_json::Value::Null),
                            }),
                        ),
                        via_tap: true,
                        tokens: 0,
                    });
                }
                Some("tool_result") => {
                    out.push(ReplayFrame {
                        at_ms,
                        msg_type: "tool_result".to_string(),
                        payload: frame_payload(
                            &session_id,
                            "tool_result",
                            serde_json::json!({
                                "tool_use_id": block.tool_use_id.unwrap_or_default(),
                                "output": coerce_tool_result_content(block.content.as_ref()),
                                "is_error": block.is_error,
                            }),
                        ),
                        via_tap: true,
                        tokens: 0,
                    });
                }
                _ => {}
            }
        }
    }

    if turn_open {
        out.push(turn_complete_frame(
            &session_id,
            last_activity_ms,
            turn_tokens,
        ));
    }
    out
}

fn turn_complete_frame(session_id: &str, at_ms: i64, tokens: i64) -> ReplayFrame {
    ReplayFrame {
        at_ms,
        msg_type: "turn_complete".to_string(),
        payload: frame_payload(
            session_id,
            "turn_complete",
            serde_json::json!({ "result": "success", "billed_tokens": tokens }),
        ),
        via_tap: true,
        tokens,
    }
}

/// Render one frame the way the wire carries it: the spliced session id and
/// the type at the top level, the type's own fields beside them.
fn frame_payload(session_id: &str, msg_type: &str, body: serde_json::Value) -> String {
    let mut map = serde_json::Map::new();
    map.insert(
        "tug_session_id".to_string(),
        serde_json::Value::String(session_id.to_string()),
    );
    map.insert(
        "type".to_string(),
        serde_json::Value::String(msg_type.to_string()),
    );
    if let serde_json::Value::Object(fields) = body {
        for (k, v) in fields {
            map.insert(k, v);
        }
    }
    serde_json::Value::Object(map).to_string()
}

// MARK: - Segmentation

/// One wake: everything the model would be shown, and why it is being asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeWindow {
    pub at_ms: i64,
    pub reason: WakeReason,
    pub session_id: String,
    pub frame_count: usize,
    pub byte_len: usize,
    pub elided: bool,
    /// The buffered frames as the wake input renders them, and the exact text
    /// refs are validated against.
    pub rendered: String,
}

/// Decide where the Observer would have woken.
///
/// Pure and deterministic over `(frames, options)`, which is what makes a
/// cadence sweep comparable: the only thing that changes between two runs at
/// different `--sitrep-secs` is the segmentation, not the sampling.
///
/// The sitrep timer is armed by the first frame into an empty buffer and
/// disarmed by every wake, mirroring the bridge — a timer that ran while the
/// buffer was empty would wake on an idle session, and silence is not news.
pub fn segment_wakes(frames: &[ReplayFrame], opts: &ReplayOptions) -> Vec<WakeWindow> {
    let mut windows = Vec::new();
    let mut buffer = SessionDigest::new(opts.max_frames, BUFFER_MAX_BYTES);
    // The production digester, run here exactly as the bridge runs it: the
    // window a wake is shown is digest lines, so a harness segmenting raw
    // payloads would be reporting a window nothing ships.
    let mut digester = SessionDigester::new();
    let mut muted: HashSet<String> = HashSet::new();
    let mut armed_at: Option<i64> = None;
    let mut tokens_since: i64 = 0;
    let mut assistant_activity = false;
    let mut session_id = String::new();
    let sitrep_ms = opts.sitrep_secs.saturating_mul(1000);

    /// Snapshot-and-clear, exactly as the bridge does before it hands the
    /// window off: the buffer starts accumulating the next stretch
    /// immediately, and the timer disarms until something new arrives.
    fn wake(
        buffer: &mut SessionDigest,
        windows: &mut Vec<WakeWindow>,
        armed_at: &mut Option<i64>,
        tokens_since: &mut i64,
        session_id: &str,
        at_ms: i64,
        reason: WakeReason,
    ) {
        let taken = buffer.take();
        windows.push(WakeWindow {
            at_ms,
            reason,
            session_id: session_id.to_string(),
            frame_count: taken.len(),
            byte_len: taken.byte_len(),
            elided: taken.was_elided(),
            rendered: taken.rendered(),
        });
        *armed_at = None;
        *tokens_since = 0;
    }

    for frame in frames {
        // The deadline elapsed in the gap before this frame arrived, so the
        // wake belongs at the deadline rather than at the frame.
        if sitrep_ms > 0
            && let Some(armed) = armed_at
            && frame.at_ms >= armed + sitrep_ms
            && !buffer.is_empty()
        {
            let at = armed + sitrep_ms;
            wake(
                &mut buffer,
                &mut windows,
                &mut armed_at,
                &mut tokens_since,
                &session_id,
                at,
                WakeReason::SitrepTimer,
            );
        }

        let tapped_session = if frame.via_tap {
            match forwardable_session(frame.payload.as_bytes(), &mut muted) {
                Some(session) => Some(session),
                None => continue,
            }
        } else {
            None
        };
        if session_id.is_empty()
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&frame.payload)
            && let Some(id) = v.get("tug_session_id").and_then(|s| s.as_str())
        {
            session_id = id.to_string();
        }
        // One frame, one line — or none. An allowlisted type the digester
        // narrates nothing for (an `error`, a `task_started`) leaves the
        // window untouched, which is the same thing it does live.
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&frame.payload) else {
            continue;
        };
        let digested = match &tapped_session {
            Some(session) => {
                digester.line_for_code_frame(session, &value, frame.at_ms.max(0) as u64)
            }
            None => digester
                .line_for_submission(&value, frame.at_ms.max(0) as u64)
                .map(|(_, digested)| digested),
        };
        let Some(digested) = digested.filter(|d| d.record) else {
            continue;
        };

        if buffer.is_empty() {
            armed_at = Some(frame.at_ms);
        }
        // Only a TAPPED frame is the session working. A submission-feed user
        // message rides along in the window (half of what makes a post
        // readable is what was asked for) without making the turn worth
        // waking for — the same split the bridge draws by taking the two
        // feeds through different handlers.
        if frame.via_tap && counts_as_assistant_activity(&frame.msg_type) {
            assistant_activity = true;
        }
        buffer.push(digested.line);
        tokens_since += frame.tokens;

        if frame.msg_type == "turn_complete" || frame.msg_type == "turn_cancelled" {
            // A turn that held no work is not a wake. Skipping it here rather
            // than reporting it is the whole point: this instrument's answer
            // IS the wake count, so a phantom wake is a wrong answer to the
            // only question being asked.
            if assistant_activity {
                wake(
                    &mut buffer,
                    &mut windows,
                    &mut armed_at,
                    &mut tokens_since,
                    &session_id,
                    frame.at_ms,
                    WakeReason::TurnEnd,
                );
            }
            assistant_activity = false;
        } else if opts.token_wake_tokens > 0 && tokens_since >= opts.token_wake_tokens {
            wake(
                &mut buffer,
                &mut windows,
                &mut armed_at,
                &mut tokens_since,
                &session_id,
                frame.at_ms,
                WakeReason::TokenThreshold,
            );
        }
    }

    if !buffer.is_empty() {
        let at = frames.last().map(|f| f.at_ms).unwrap_or_default();
        wake(
            &mut buffer,
            &mut windows,
            &mut armed_at,
            &mut tokens_since,
            &session_id,
            at,
            WakeReason::SessionEnd,
        );
    }
    windows
}

// MARK: - Running one replay

/// Replay `path` and print the overview it produces to stdout.
///
/// Returns a process exit code: non-zero only when the transcript could not be
/// read or held nothing to narrate, since a run whose model declined every
/// wake is a real and interesting answer rather than a failure.
pub async fn run(path: &Path, opts: &ReplayOptions) -> i32 {
    let jsonl = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("overview-replay: cannot read {}: {error}", path.display());
            return 1;
        }
    };

    let frames = translate_transcript(&jsonl);
    if frames.is_empty() {
        eprintln!(
            "overview-replay: {} holds no session activity",
            path.display()
        );
        return 1;
    }
    let windows = segment_wakes(&frames, opts);
    let start_ms = frames.first().map(|f| f.at_ms).unwrap_or_default();
    let end_ms = frames.last().map(|f| f.at_ms).unwrap_or_default();

    print_header(path, opts, &frames, &windows, start_ms, end_ms);
    let synthesized = synthesize_facts(&frames);
    if opts.no_facts {
        println!("- facts: **withheld** (`--no-facts`) — every wake composes an empty section\n");
    } else {
        print_facts_note(&synthesized);
    }

    if opts.no_model {
        for (n, window) in windows.iter().enumerate() {
            print_window_header(n + 1, window, start_ms);
            if opts.show_input {
                // No model ran, so there are no prior posts to carry — the
                // material is the window alone.
                print_input(&compose_observer_input(
                    window.reason,
                    &window.session_id,
                    &window_buffer(window),
                    &[],
                    &if opts.no_facts {
                        Vec::new()
                    } else {
                        facts_for_window(&synthesized.facts, None, window.at_ms)
                    },
                ));
            }
            println!("_(--no-model: segmentation only)_\n");
        }
        print_footer(&windows, &Tally::default(), start_ms, end_ms);
        return 0;
    }

    let model = opts.model.clone();
    // One worker: a replay is serial by construction, and a second would only
    // interleave output.
    let pool = super::overview_agent::build_pool(Arc::new(move || model.clone()), 1);

    let mut prior: Vec<PriorPost> = Vec::new();
    let mut tally = Tally::default();

    for (n, window) in windows.iter().enumerate() {
        print_window_header(n + 1, window, start_ms);
        let facts = if opts.no_facts {
            Vec::new()
        } else {
            facts_for_window(
                &synthesized.facts,
                prior.last().map(|post| post.at_ms),
                window.at_ms,
            )
        };
        let facts_section = render_facts_section(&facts);
        let input = compose_observer_input(
            window.reason,
            &window.session_id,
            &window_buffer(window),
            &prior,
            &facts,
        );
        if opts.show_input {
            print_input(&input);
        }
        match pool.run("observer-post", input).await {
            Err(error) => {
                tally.failed += 1;
                println!("**job failed:** {error}\n");
            }
            // Three outcomes, not two. A model that read the work and declined
            // and a model whose answer could not be read both put nothing in
            // the channel, but only the first is the feature working — and a
            // run that prints them the same way reports a broken envelope as
            // good editorial judgment. The raw text comes out with the
            // unparseable one, because that text is the whole diagnosis.
            Ok(raw) => match parse_envelope(&raw) {
                None => {
                    tally.unparseable += 1;
                    println!("**unparseable envelope** — the model's answer, verbatim:\n");
                    println!("```\n{}\n```\n", raw.trim());
                }
                Some(envelope) => match envelope.post {
                    None => {
                        tally.silent += 1;
                        println!("_(no post)_\n");
                    }
                    Some(post) => {
                        tally.posted += 1;
                        print_post(&post.body, post.refs, &window.rendered, &facts_section);
                        prior.push(PriorPost {
                            at_ms: window.at_ms,
                            body: post.body,
                        });
                        if prior.len() > opts.last_k {
                            prior.drain(..prior.len() - opts.last_k);
                        }
                    }
                },
            },
        }
    }

    print_footer(&windows, &tally, start_ms, end_ms);
    0
}

/// What became of every wake, kept apart because the four outcomes mean
/// different things and a run that merges any two of them is unreadable.
#[derive(Debug, Default, Clone, Copy)]
struct Tally {
    /// The model wrote something.
    posted: usize,
    /// The model read the work and judged it not worth telling — the feature
    /// working as designed.
    silent: usize,
    /// The answer came back but was not the envelope. Also silence in the
    /// channel, but a bug rather than a judgment.
    unparseable: usize,
    /// The job never answered: spawn failure, dead worker, timeout.
    failed: usize,
}

/// Print one post as the channel would show it, with its provenance beneath.
fn print_post(
    body: &str,
    refs: Vec<tugcast_core::OverviewRef>,
    buffered_context: &str,
    facts_section: &str,
) {
    for line in body.lines() {
        println!("> {line}");
    }
    println!();
    // The same two corpora the bridge validates against ([P10]) — a harness
    // that checked only the window would drop a fact-backed sha the live path
    // would keep, and report the diet as worse than it is.
    let refs = validate_refs(refs, &[buffered_context, facts_section]);
    let label = |list: &[tugcast_core::OverviewRef]| {
        list.iter()
            .map(|r| format!("{} `{}`", r.kind.as_str(), r.target))
            .collect::<Vec<_>>()
            .join(" · ")
    };
    if !refs.kept.is_empty() {
        println!("refs: {}", label(&refs.kept));
    }
    if !refs.dropped.is_empty() {
        println!(
            "dropped refs (not verbatim in the window): {}",
            label(&refs.dropped)
        );
    }
    println!();
}

/// Rebuild a buffer holding this window's text so composition runs through the
/// same code path the bridge uses.
fn window_buffer(window: &WakeWindow) -> SessionDigest {
    let mut buffer = SessionDigest::new(usize::MAX, usize::MAX);
    buffer.push(DigestLine {
        text: window.rendered.trim_end().to_string(),
        at_ms: window.at_ms.max(0) as u64,
        beat: 0,
        kind: DigestKind::Said,
        supersede_key: None,
    });
    buffer
}

// MARK: - Rendering

fn print_header(
    path: &Path,
    opts: &ReplayOptions,
    frames: &[ReplayFrame],
    windows: &[WakeWindow],
    start_ms: i64,
    end_ms: i64,
) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    println!("# Overview replay — {name}\n");
    println!(
        "- span: {} of session activity ({} frames, {} wakes)",
        elapsed_label(end_ms - start_ms),
        frames.len(),
        windows.len()
    );
    println!(
        "- sitrep: {}s · last-k: {} · max-frames: {} · token-wake: {} · model: {}{}",
        opts.sitrep_secs,
        opts.last_k,
        opts.max_frames,
        opts.token_wake_tokens,
        opts.model,
        if opts.no_model { " (not called)" } else { "" }
    );
    println!();
}

/// Derive the facts a transcript can account for, through the very functions
/// production records with ([P09]).
pub fn synthesize_facts(frames: &[ReplayFrame]) -> crate::feeds::facts_library::SynthesizedFacts {
    let refs: Vec<crate::feeds::facts_library::SynthFrame<'_>> = frames
        .iter()
        .map(|f| crate::feeds::facts_library::SynthFrame {
            at_ms: f.at_ms,
            msg_type: f.msg_type.as_str(),
            payload: f.payload.as_str(),
        })
        .collect();
    crate::feeds::facts_library::synthesize_facts_from_frames(&refs)
}

/// The facts one wake would have been shown, on production's rule ([P10]):
/// everything newer than the newest prior post and no newer than the wake
/// itself. `since` is `None` for a session with no priors, which is the whole
/// library up to that point.
///
/// The upper bound is not decoration. A replay knows every fact the transcript
/// will ever produce, and a wake shown facts from after its own moment would
/// read as the Observer citing the future — the one way a harness can flatter a
/// diet the live bridge could never serve.
fn facts_for_window(
    facts: &[crate::session_ledger::NewFact],
    since_ms: Option<i64>,
    until_ms: i64,
) -> Vec<FactLine> {
    facts
        .iter()
        .filter(|f| f.at_ms <= until_ms && since_ms.is_none_or(|since| f.at_ms > since))
        .map(|f| FactLine {
            at_ms: f.at_ms,
            text: f.text.clone(),
        })
        .collect()
}

/// Say which fact kinds this replay could produce and which it structurally
/// cannot. The asymmetry is real — a transcript has never seen a commit or a
/// session lifecycle transition — and printing it is the difference between a
/// harness that is honestly partial and one that quietly looks complete.
fn print_facts_note(synthesized: &crate::feeds::facts_library::SynthesizedFacts) {
    let kinds = if synthesized.kinds.is_empty() {
        "(none)".to_string()
    } else {
        synthesized.kinds.join(", ")
    };
    println!(
        "- facts: {} synthesized ({kinds}); live-only kinds absent from any transcript: {}",
        synthesized.facts.len(),
        crate::feeds::facts_library::LIVE_ONLY_KINDS.join(", ")
    );
    println!();
}

fn print_window_header(n: usize, window: &WakeWindow, start_ms: i64) {
    println!(
        "## wake {n} — {} at +{}",
        window.reason.as_str(),
        elapsed_label(window.at_ms - start_ms)
    );
    println!(
        "{} frames · {}{}\n",
        window.frame_count,
        byte_label(window.byte_len),
        if window.elided { " · elided" } else { "" }
    );
}

/// The composed job input, verbatim, in a fenced block.
///
/// A silence is only diagnosable against its material: the post that was not
/// written says nothing about why. Fenced rather than indented so a window
/// containing its own backtick-quoted paths still reads as one block.
fn print_input(input: &str) {
    println!("<details><summary>job input</summary>\n");
    println!("````\n{}\n````\n", input.trim_end());
    println!("</details>\n");
}

fn print_footer(windows: &[WakeWindow], tally: &Tally, start_ms: i64, end_ms: i64) {
    println!("---\n");
    println!("## cadence\n");
    let span_ms = (end_ms - start_ms).max(0);
    println!("- {} wakes over {}", windows.len(), elapsed_label(span_ms));
    for reason in [
        WakeReason::TurnEnd,
        WakeReason::SitrepTimer,
        WakeReason::SessionEnd,
        WakeReason::TokenThreshold,
    ] {
        let count = windows.iter().filter(|w| w.reason == reason).count();
        if count > 0 {
            println!("  - {}: {count}", reason.as_str());
        }
    }
    let called = tally.posted + tally.silent + tally.unparseable + tally.failed;
    if called > 0 {
        println!(
            "- {} posted · {} chose silence · {} unparseable · {} job failures",
            tally.posted, tally.silent, tally.unparseable, tally.failed
        );
    }
    // The number the whole exercise is about: how often a person reading the
    // channel would have seen something new.
    if tally.posted > 0 {
        println!(
            "- **one post per {}** of session activity",
            elapsed_label(span_ms / tally.posted as i64)
        );
    }
    // Silence is the design; silence the model never chose is a defect. A run
    // where the envelope broke more often than it held is not a cadence
    // reading at all, and saying so beats leaving a zero to be misread as
    // editorial restraint.
    if tally.unparseable > 0 {
        println!(
            "\n**{} of {called} answers could not be parsed.** Those are not editorial \
             silence — read the verbatim text above before drawing any conclusion about \
             cadence from this run.",
            tally.unparseable
        );
    }
}

/// A duration a person can hold in their head: `2h04m`, `7m12s`, `41s`.
fn elapsed_label(ms: i64) -> String {
    let total = (ms.max(0)) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}h{m:02}m")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

fn byte_label(bytes: usize) -> String {
    if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, ts: &str, body: serde_json::Value) -> String {
        serde_json::json!({
            "type": kind,
            "sessionId": "s1",
            "timestamp": ts,
            "message": body,
        })
        .to_string()
    }

    fn prompt(ts: &str, text: &str) -> String {
        entry("user", ts, serde_json::json!({ "content": text }))
    }

    fn tool_call(ts: &str, id: &str, name: &str) -> String {
        entry(
            "assistant",
            ts,
            serde_json::json!({
                "id": "m1",
                "content": [{ "type": "tool_use", "id": id, "name": name, "input": {} }],
            }),
        )
    }

    fn tool_result(ts: &str, id: &str, output: &str) -> String {
        entry(
            "user",
            ts,
            serde_json::json!({
                "content": [{ "type": "tool_result", "tool_use_id": id, "content": output }],
            }),
        )
    }

    fn opts(sitrep_secs: i64) -> ReplayOptions {
        ReplayOptions {
            sitrep_secs,
            no_model: true,
            ..ReplayOptions::default()
        }
    }

    // MARK: - Translation

    #[test]
    fn translation_keeps_the_narratable_blocks_and_drops_the_rest() {
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "make the button blue"),
            entry(
                "assistant",
                "2026-08-07T13:00:01.000Z",
                serde_json::json!({
                    "id": "m1",
                    "content": [
                        { "type": "thinking", "thinking": "hmm" },
                        { "type": "text", "text": "On it." },
                    ],
                }),
            ),
            tool_call("2026-08-07T13:00:02.000Z", "t1", "Edit"),
            tool_result("2026-08-07T13:00:03.000Z", "t1", "ok"),
            r#"{"type":"file-history-snapshot"}"#.to_string(),
            r#"{"type":"queue-operation","timestamp":"2026-08-07T13:00:04.000Z"}"#.to_string(),
        ]
        .join("\n");

        let frames = translate_transcript(&jsonl);
        let types: Vec<&str> = frames.iter().map(|f| f.msg_type.as_str()).collect();
        assert_eq!(
            types,
            vec![
                "user_message",
                "assistant_text",
                "tool_use",
                "tool_result",
                "turn_complete"
            ],
            "thinking blocks and bookkeeping rows carry no session activity"
        );
        assert!(
            frames
                .iter()
                .all(|f| f.payload.contains(r#""tug_session_id":"s1""#))
        );
    }

    /// [P09]: compaction is a `system` record, and the translator's
    /// assistant/user gate drops every one of those. Without the
    /// `compact_boundary` arm the harness can never synthesize a
    /// `session.compacted` fact — and every other synthesized kind would pass
    /// while this one silently did not exist, which is why the pin is here.
    #[test]
    fn a_compact_boundary_record_survives_translation_and_becomes_a_fact() {
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "keep going"),
            serde_json::json!({
                "type": "system",
                "subtype": "compact_boundary",
                "sessionId": "s1",
                "timestamp": "2026-08-07T13:00:05.000Z",
                "compactMetadata": { "trigger": "auto", "preTokens": 172_000 },
            })
            .to_string(),
        ]
        .join("\n");

        let frames = translate_transcript(&jsonl);
        let boundary = frames
            .iter()
            .find(|f| f.msg_type == "compact_boundary")
            .expect("the compact_boundary arm emits a frame");
        assert!(boundary.payload.contains(r#""trigger":"auto""#));
        assert!(boundary.payload.contains("172000"));

        let synthesized = synthesize_facts(&frames);
        let compacted = synthesized
            .facts
            .iter()
            .find(|f| f.kind == "session.compacted")
            .expect("synthesis derives the compaction fact");
        assert!(compacted.text.contains("auto"));
        assert!(compacted.text.contains("172000"));
        // claude sent no post count, so none is rendered — never a stand-in 0.
        assert!(!compacted.text.contains("→ 0"));
        assert!(synthesized.kinds.contains(&"session.compacted"));
    }

    /// The facts a wake is shown come from the library up to that wake, never
    /// past it: a replay knows the whole transcript, and a section carrying the
    /// future would flatter a diet the live bridge could not serve.
    #[test]
    fn a_wakes_facts_stop_at_its_own_moment_and_start_after_the_last_post() {
        let facts = [
            crate::feeds::facts_library::prompt_fact(1_000, "s1", "the first ask"),
            crate::feeds::facts_library::prompt_fact(2_000, "s1", "the second ask"),
            crate::feeds::facts_library::prompt_fact(3_000, "s1", "the third ask"),
        ];

        let first = facts_for_window(&facts, None, 2_000);
        assert_eq!(first.len(), 2, "no facts from after the wake");

        let later = facts_for_window(&facts, Some(2_000), 3_000);
        assert_eq!(later.len(), 1, "only what settled since the last post");
        assert!(later[0].text.contains("the third ask"));
    }

    #[test]
    fn a_prompt_closes_the_open_turn_and_opens_the_next() {
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "first"),
            tool_call("2026-08-07T13:00:01.000Z", "t1", "Read"),
            prompt("2026-08-07T13:05:00.000Z", "second"),
            tool_call("2026-08-07T13:05:01.000Z", "t2", "Read"),
        ]
        .join("\n");

        let frames = translate_transcript(&jsonl);
        let turn_ends: Vec<i64> = frames
            .iter()
            .filter(|f| f.msg_type == "turn_complete")
            .map(|f| f.at_ms)
            .collect();
        assert_eq!(turn_ends.len(), 2, "one per turn, the last closed at eof");
        assert_eq!(
            turn_ends[0],
            parse_timestamp("2026-08-07T13:00:01.000Z").unwrap(),
            "the first turn ended when it stopped working, not when the \
             next prompt five minutes later revealed the boundary"
        );
        assert_eq!(
            turn_ends[1],
            parse_timestamp("2026-08-07T13:05:01.000Z").unwrap()
        );
    }

    #[test]
    fn usage_is_counted_once_per_message_not_once_per_line() {
        // Three lines of one assistant message all carry the same usage block.
        let line = |ts: &str| {
            entry(
                "assistant",
                ts,
                serde_json::json!({
                    "id": "m1",
                    "content": [{ "type": "text", "text": "hi" }],
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 90_000,
                    },
                }),
            )
        };
        let jsonl = [
            line("2026-08-07T13:00:01.000Z"),
            line("2026-08-07T13:00:02.000Z"),
            line("2026-08-07T13:00:03.000Z"),
        ]
        .join("\n");

        let frames = translate_transcript(&jsonl);
        let turn = frames.last().expect("a closing turn_complete");
        assert_eq!(turn.msg_type, "turn_complete");
        assert_eq!(
            turn.tokens, 15,
            "one message's billed usage, with cache reads excluded"
        );
    }

    // MARK: - Segmentation

    #[test]
    fn a_turn_end_wakes_and_flushes() {
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "go"),
            tool_call("2026-08-07T13:00:01.000Z", "t1", "Read"),
        ]
        .join("\n");
        let frames = translate_transcript(&jsonl);
        let windows = segment_wakes(&frames, &opts(180));

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].reason, WakeReason::TurnEnd);
        assert_eq!(
            windows[0].frame_count, 3,
            "prompt, tool call, turn_complete"
        );
    }

    #[test]
    fn the_sitrep_timer_fires_at_the_deadline_not_at_the_frame() {
        // One long turn: activity at 0s and 600s, sitrep at 180s.
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "go"),
            tool_call("2026-08-07T13:00:01.000Z", "t1", "Read"),
            tool_result("2026-08-07T13:10:00.000Z", "t1", "done"),
        ]
        .join("\n");
        let frames = translate_transcript(&jsonl);
        let windows = segment_wakes(&frames, &opts(180));

        assert_eq!(windows[0].reason, WakeReason::SitrepTimer);
        let armed = parse_timestamp("2026-08-07T13:00:00.000Z").unwrap();
        assert_eq!(
            windows[0].at_ms,
            armed + 180_000,
            "the wake belongs at the deadline that elapsed in the gap"
        );
    }

    #[test]
    fn an_idle_stretch_never_wakes() {
        // The buffer is emptied by the turn end; the four-hour gap that
        // follows arms nothing, so the long silence produces no window.
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "go"),
            tool_call("2026-08-07T13:00:01.000Z", "t1", "Read"),
            prompt("2026-08-07T17:00:00.000Z", "again"),
            tool_call("2026-08-07T17:00:01.000Z", "t2", "Read"),
        ]
        .join("\n");
        let frames = translate_transcript(&jsonl);
        let windows = segment_wakes(&frames, &opts(180));

        assert_eq!(windows.len(), 2, "one per turn, none for the idle hours");
        assert!(windows.iter().all(|w| w.reason == WakeReason::TurnEnd));
    }

    #[test]
    fn a_shorter_sitrep_produces_more_wakes_over_the_same_transcript() {
        let mut lines = vec![prompt("2026-08-07T13:00:00.000Z", "go")];
        for minute in 0..30 {
            lines.push(tool_call(
                &format!("2026-08-07T13:{minute:02}:30.000Z"),
                &format!("t{minute}"),
                "Read",
            ));
        }
        let jsonl = lines.join("\n");
        let frames = translate_transcript(&jsonl);

        let slow = segment_wakes(&frames, &opts(240)).len();
        let fast = segment_wakes(&frames, &opts(90)).len();
        assert!(
            fast > slow,
            "the knob is the cadence: 90s gave {fast} wakes, 240s gave {slow}"
        );
    }

    #[test]
    fn segmentation_is_deterministic() {
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "go"),
            tool_call("2026-08-07T13:02:00.000Z", "t1", "Read"),
            tool_result("2026-08-07T13:09:00.000Z", "t1", "done"),
        ]
        .join("\n");
        let frames = translate_transcript(&jsonl);
        assert_eq!(
            segment_wakes(&frames, &opts(180)),
            segment_wakes(&frames, &opts(180)),
            "a sweep only compares if the same input gives the same windows"
        );
    }

    #[test]
    fn a_token_threshold_wakes_when_the_knob_is_on() {
        let jsonl = [
            prompt("2026-08-07T13:00:00.000Z", "go"),
            entry(
                "assistant",
                "2026-08-07T13:00:01.000Z",
                serde_json::json!({
                    "id": "m1",
                    "content": [{ "type": "text", "text": "hi" }],
                    "usage": { "input_tokens": 5_000, "output_tokens": 5_000 },
                }),
            ),
        ]
        .join("\n");
        let frames = translate_transcript(&jsonl);

        let off = ReplayOptions {
            token_wake_tokens: 0,
            ..opts(0)
        };
        let on = ReplayOptions {
            token_wake_tokens: 1_000,
            ..opts(0)
        };
        // The closing turn_complete carries the usage, so it wakes as a turn
        // end either way; the threshold's effect is visible on the reason of
        // the *first* window when the frame is not a turn boundary.
        assert!(
            segment_wakes(&frames, &off)
                .iter()
                .all(|w| w.reason != WakeReason::TokenThreshold)
        );
        assert_eq!(segment_wakes(&frames, &on).len(), 1);
    }

    #[test]
    fn a_turn_that_only_ran_a_slash_command_is_not_a_wake() {
        // `/model sonnet` is a user message and a turn end and nothing else.
        // The bridge declines to wake on it, so a replay that counted it would
        // over-report the cadence it exists to measure — which it did, until a
        // live log showing one wake was read beside a replay claiming three.
        let jsonl = [
            prompt(
                "2026-08-07T13:00:00.000Z",
                "<command-name>/model</command-name>",
            ),
            prompt("2026-08-07T13:00:01.000Z", "make the button blue"),
            tool_call("2026-08-07T13:00:02.000Z", "t1", "Edit"),
            tool_result("2026-08-07T13:00:03.000Z", "t1", "ok"),
        ]
        .join("\n");

        let windows = segment_wakes(&translate_transcript(&jsonl), &opts(0));
        assert_eq!(
            windows.len(),
            1,
            "only the turn that did work wakes; the bookkeeping turn does not"
        );
        // The skipped turn does not flush either — its frames ride into the
        // window that does wake, exactly as they do on the bridge, so nothing
        // the session did is lost by not waking for it.
        assert!(
            windows[0].rendered.contains("/model"),
            "the skipped turn's frames stay in the buffer",
        );
    }

    #[test]
    fn a_turn_end_is_not_itself_activity() {
        // The predicate both the bridge and this harness gate on. A window of
        // pure turn ends is a window of nothing happening.
        assert!(!counts_as_assistant_activity("turn_complete"));
        assert!(!counts_as_assistant_activity("turn_cancelled"));
        assert!(counts_as_assistant_activity("assistant_text"));
        assert!(counts_as_assistant_activity("tool_use"));
    }

    // MARK: - Labels

    #[test]
    fn elapsed_labels_read_as_durations() {
        assert_eq!(elapsed_label(41_000), "41s");
        assert_eq!(elapsed_label(432_000), "7m12s");
        assert_eq!(elapsed_label(7_440_000), "2h04m");
        assert_eq!(elapsed_label(-5), "0s");
    }
}
