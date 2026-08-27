//! The turn-segmentation engine — the single producer of a session's
//! canonical turn count (`tuglaws/turn-metric.md`).
//!
//! A session JSONL is an ordered list of records; this engine walks them
//! and emits one origin-tagged [`TurnOrigin`] per *turn container*. The
//! count is the number of containers; each is `User` (a genuine user
//! submission) or `Assistant` (a wake, a `/compact` continuation, a
//! `--continue` leading orphan, or any orphan assistant output that
//! arrives with no open turn). There is no fabricated user message: an
//! assistant-originated turn simply has no user slot.
//!
//! ## Faithfulness to tugcode
//!
//! The engine reproduces tugcode's rendering segmentation
//! (`tugcode/src/replay.ts`, `computeTurns`) decision-for-decision so the
//! count it produces equals the highest rendered transcript address. A
//! turn opens at exactly the three sites where tugcode mints an opener id
//! (`mintOpenerId` → `orphanCounter` bump):
//!
//! 1. a genuine user submission (`handleUserEntry` text path) → `User`;
//! 2. a `<task-notification>` wake (`handleUserEntry` wake path) →
//!    `Assistant`;
//! 3. an `assistant` record arriving with no open turn
//!    (`handleAssistantEntry`'s former synth opener) → `Assistant`.
//!
//! The user-side classification is shared with the disk scanner via
//! [`crate::external_sessions::user_submission_opens_turn`] so the two can
//! never drift.
//!
//! ## The same-`message.id` continuation
//!
//! Claude's SDK occasionally splits one assistant message across two
//! consecutive JSONL records sharing a `message.id`, each carrying a
//! terminal `stop_reason`. tugcode's `continuationSuppressed` peeks the
//! next significant entry and defers the leading record's terminal so the
//! pair stays *one* turn. The engine reproduces this without lookahead by
//! a **one-entry deferred close**: a terminal assistant record sets
//! `pending_close`; the close takes effect only when the next significant
//! record is *not* an `assistant` continuing the same `message.id`. The
//! information consumed — the immediately-following significant record's
//! `(type, message.id)` — is identical to the lookahead's, so the count is
//! identical.
//!
//! ## Incremental resume
//!
//! Segmentation carries [`Frontier`] open-turn state across an append
//! boundary, not merely a count — so an incremental scan of a growing
//! session cannot undercount what a full re-segment would find. Feed the
//! new records with the prior [`Frontier`] as carry-in and the new turns
//! append to the running total.

#![allow(dead_code)]

use serde::Deserialize;

use crate::external_sessions::user_submission_opens_turn;

/// Origin of a turn container. `Shell` is reserved by the addressing
/// scheme (`#s`) but not emitted this phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOrigin {
    User,
    Assistant,
    Shell,
}

/// Open-turn state carried across an incremental append boundary. A fresh
/// session starts from [`Frontier::default`]; a resumed scan threads the
/// prior frontier as carry-in so a same-`message.id` continuation or an
/// orphan close that straddles the boundary is resolved correctly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontier {
    /// A turn is currently open (its container exists; more content may
    /// still extend it).
    pub open: bool,
    /// The open turn hit a terminal `stop_reason` and will close at the
    /// next significant record unless that record is an `assistant`
    /// continuing `pending_close_msg_id`.
    pub pending_close: bool,
    /// The `message.id` of the record that armed `pending_close`. `None`
    /// when that record carried no (or an empty) id — such a record can
    /// never be continued, mirroring `continuationSuppressed`'s
    /// non-empty-id requirement on both halves of the pair.
    pub pending_close_msg_id: Option<String>,
    /// The `uuid` of the last chain record (uuid-bearing, non-sidechain)
    /// seen at the frontier — the chain's leaf. The incremental scanner
    /// compares an appended record's `parentUuid` against this to detect a
    /// rewind branch, which it cannot segment incrementally and must
    /// re-stream in full. `None` before any chain record.
    pub leaf_uuid: Option<String>,
}

/// The engine's output for a (possibly incremental) run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentOutput {
    /// Ordered origins, one per turn opened in this run. The canonical
    /// count for a full run is `turns.len()`; for an incremental run it is
    /// the carry-in count plus `turns.len()`.
    pub turns: Vec<TurnOrigin>,
    /// Carry-out open-turn state for the next incremental append.
    pub frontier: Frontier,
}

/// A *significant* record the engine acts on: a parsed JSONL line that is
/// neither blank/malformed nor a skipped bookkeeping type. Non-significant
/// lines are dropped before the engine sees them (mirroring tugcode's
/// `nextSignificantIndex`, which skips nulls and `SKIPPED_TOP_LEVEL_TYPES`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SigRecord {
    /// A `type:"user"` record, pre-classified by
    /// `user_submission_opens_turn`. `opens` is whether it opens a turn;
    /// `is_wake` distinguishes a wake opener (assistant origin) from a
    /// genuine submission (user origin).
    User { opens: bool, is_wake: bool },
    /// A `type:"assistant"` record. `msg_id` is `None` for an empty/absent
    /// `message.id`; `terminal` is whether `stop_reason` is a clean
    /// terminal.
    Assistant {
        msg_id: Option<String>,
        terminal: bool,
    },
    /// A significant record that opens nothing (an unknown/absent top-level
    /// type). It still counts as an intervening significant entry, so it
    /// breaks a same-`message.id` continuation pair.
    Other,
}

/// Top-level `type` values tugcode skips silently
/// (`SKIPPED_TOP_LEVEL_TYPES`). A line of one of these types is not a
/// significant record and never breaks a continuation pair.
const SKIPPED_TOP_LEVEL_TYPES: [&str; 8] = [
    "attachment",
    "queue-operation",
    "last-prompt",
    "file-history-snapshot",
    "ai-title",
    "system",
    "permission-mode",
    "mode",
];

/// `assistant` `stop_reason` values that close a cycle cleanly. Mirror of
/// tugcode's `TERMINAL_STOP_REASONS`.
const TERMINAL_STOP_REASONS: [&str; 4] = ["end_turn", "stop_sequence", "max_tokens", "refusal"];

/// The fields the engine reads from a JSONL line. `message` is captured
/// unparsed ([`serde_json::value::RawValue`]) so the bulk assistant
/// content tree is never built; only `type:"user"` lines parse it to read
/// `content`, and `type:"assistant"` lines parse the small `id` /
/// `stop_reason` pair.
#[derive(Deserialize)]
struct EngineRecord<'a> {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(rename = "isMeta", default)]
    is_meta: Option<bool>,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: Option<bool>,
    #[serde(rename = "permissionMode", default, borrow)]
    permission_mode: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    message: Option<&'a serde_json::value::RawValue>,
}

/// The small `assistant` `message` projection: id + stop_reason, content
/// ignored.
#[derive(Deserialize, Default)]
struct AssistantMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    stop_reason: Option<String>,
}

/// Parse one JSONL line into a [`SigRecord`], or `None` when the line is
/// blank, malformed, or a skipped bookkeeping type — i.e. not significant.
pub fn parse_significant(line: &str) -> Option<SigRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let rec = serde_json::from_str::<EngineRecord>(trimmed).ok()?;
    match rec.kind.as_deref() {
        Some(k) if SKIPPED_TOP_LEVEL_TYPES.contains(&k) => None,
        Some("user") => {
            // Parse the small user `message` to read `content`. A user
            // record with no parseable content opens nothing but is still
            // significant.
            let content = rec
                .message
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).ok())
                .and_then(|msg| msg.get("content").cloned());
            let (opens, is_wake) = match content {
                Some(content) => user_submission_opens_turn(
                    rec.is_meta == Some(true),
                    rec.is_compact_summary == Some(true),
                    rec.permission_mode.is_some(),
                    &content,
                ),
                None => (false, false),
            };
            Some(SigRecord::User { opens, is_wake })
        }
        Some("assistant") => {
            let msg: AssistantMessage = rec
                .message
                .and_then(|raw| serde_json::from_str(raw.get()).ok())
                .unwrap_or_default();
            let msg_id = msg.id.filter(|id| !id.is_empty());
            let terminal = msg
                .stop_reason
                .as_deref()
                .map(|sr| TERMINAL_STOP_REASONS.contains(&sr))
                .unwrap_or(false);
            Some(SigRecord::Assistant { msg_id, terminal })
        }
        // An unknown or absent top-level type: significant, opens nothing.
        _ => Some(SigRecord::Other),
    }
}

/// Advance the engine by one significant record, mutating `frontier` in
/// place. Returns `Some(origin)` when this record opens a new turn
/// container (the one place the count grows), else `None`. The streaming
/// disk scanner drives the engine through this entry point — one call per
/// line, no buffering.
pub fn step_record(frontier: &mut Frontier, rec: &SigRecord) -> Option<TurnOrigin> {
    // Resolve a deferred terminal close against this significant record.
    // The close takes effect unless this record is an `assistant`
    // continuing the same (non-empty) `message.id`.
    if frontier.pending_close {
        let continues = matches!(
            rec,
            SigRecord::Assistant { msg_id: Some(m), .. }
                if frontier.pending_close_msg_id.as_deref() == Some(m.as_str())
        );
        if !continues {
            frontier.open = false;
        }
        frontier.pending_close = false;
        frontier.pending_close_msg_id = None;
    }

    match rec {
        SigRecord::User { opens, is_wake } => {
            if *opens {
                // A new opener closes any prior open turn (already counted)
                // and opens its own.
                frontier.open = true;
                return Some(if *is_wake {
                    TurnOrigin::Assistant
                } else {
                    TurnOrigin::User
                });
            }
        }
        SigRecord::Assistant { msg_id, terminal } => {
            let opened = if !frontier.open {
                // Orphan assistant content with no open turn opens an
                // assistant-originated turn (the honest replacement for the
                // old synthesized empty `add_user_message`).
                frontier.open = true;
                true
            } else {
                // Extends the open turn — no new turn.
                false
            };
            if *terminal {
                frontier.pending_close = true;
                frontier.pending_close_msg_id = msg_id.clone();
            }
            if opened {
                return Some(TurnOrigin::Assistant);
            }
        }
        SigRecord::Other => {}
    }
    None
}

/// Segment a stream of pre-parsed significant records into ordered,
/// origin-tagged turns, carrying [`Frontier`] state in and out for
/// incremental resume. Pure: the only inputs are the records and the
/// carry-in frontier.
pub fn segment_turns<I>(records: I, carry_in: Frontier) -> SegmentOutput
where
    I: IntoIterator<Item = SigRecord>,
{
    let mut frontier = carry_in;
    let mut turns: Vec<TurnOrigin> = Vec::new();
    for rec in records {
        if let Some(origin) = step_record(&mut frontier, &rec) {
            turns.push(origin);
        }
    }
    SegmentOutput { turns, frontier }
}

/// Segment a whole JSONL string from an empty frontier — the shared
/// kernel behind the contract test and every full-file count.
///
/// The engine counts the **effective record sequence**, not the raw file:
/// records on an abandoned branch and re-appended duplicate occurrences
/// are dropped first (`crate::dead_branch`). This is what keeps the
/// turn-metric law true — `engine(file)` has to equal what the transcript
/// renders, and tugcode's replay renders exactly this sequence. Counting
/// the raw file instead overcounts by every dead-branch turn and every
/// compaction re-append, and `agent_bridge.rs` would then stamp that
/// inflated value over the translator's honest `totalTurns`.
///
/// The canonical count is `output.turns.len()`.
pub fn segment_str(jsonl: &str) -> SegmentOutput {
    let chain = crate::dead_branch::parse_chain_records(jsonl);
    let effective: std::collections::HashSet<usize> = crate::dead_branch::effective_indices(&chain)
        .into_iter()
        .collect();
    let records = jsonl
        .lines()
        .enumerate()
        .filter(|(i, _)| effective.contains(i))
        .filter_map(|(_, line)| parse_significant(line));
    segment_turns(records, Frontier::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The canonical real-data anchor (`tuglaws/turn-metric.md`,
    /// `dash/canonical-turns-redux.md` landmarks). Local-only ([P07]):
    /// the test reads the user's real session JSONL where it sits and
    /// skips gracefully when absent (CI / another machine), so the real
    /// corpus is the gate without committing a 37 MB fixture.
    fn reference_session_path() -> PathBuf {
        reference_corpus_dir().join("49e9aec6-7c3a-4c0c-9f74-5a9a0551812e.jsonl")
    }

    use crate::live_corpus::{StillFiles, reference_corpus_dir, tugcode_bin};

    fn origin_str(o: TurnOrigin) -> &'static str {
        match o {
            TurnOrigin::User => "user",
            TurnOrigin::Assistant => "assistant",
            TurnOrigin::Shell => "shell",
        }
    }

    #[test]
    fn engine_counts_reference_session_81() {
        let path = reference_session_path();
        let Ok(jsonl) = std::fs::read_to_string(&path) else {
            eprintln!(
                "skipping: reference session not present at {} (local-only fixture)",
                path.display()
            );
            return;
        };
        let out = segment_str(&jsonl);
        assert_eq!(
            out.turns.len(),
            81,
            "engine must count 81 turns for the opened-session authority of 49e9aec6"
        );
    }

    #[test]
    fn engine_incremental_matches_full_on_reference_session() {
        let path = reference_session_path();
        let Ok(jsonl) = std::fs::read_to_string(&path) else {
            eprintln!("skipping: reference session not present (local-only fixture)");
            return;
        };
        let lines: Vec<&str> = jsonl.lines().collect();
        let split = lines.len() / 2;
        let prefix = &lines[..split];
        let suffix = &lines[split..];

        // Full segmentation.
        let full = segment_turns(
            lines.iter().filter_map(|l| parse_significant(l)),
            Frontier::default(),
        );

        // Incremental: prefix → frontier → suffix carried forward.
        let pre = segment_turns(
            prefix.iter().filter_map(|l| parse_significant(l)),
            Frontier::default(),
        );
        let post = segment_turns(
            suffix.iter().filter_map(|l| parse_significant(l)),
            pre.frontier.clone(),
        );

        let mut incremental = pre.turns.clone();
        incremental.extend(post.turns.iter().copied());

        assert_eq!(
            incremental, full.turns,
            "incremental (prefix+suffix) segmentation must equal a full re-segment, \
             origins and count"
        );
        assert_eq!(
            post.frontier, full.frontier,
            "carry-out frontier must agree"
        );
    }

    // ---- Pure state-machine units (real JSONL shapes, minimal) ----
    //
    // These assert the engine's origin tagging and the deferred-close
    // continuation logic directly. They are not a sanitized golden corpus
    // (the deleted kind, [P07]); they pin the state machine that the
    // real-corpus contract (#step-7) then validates against tugcode over
    // the user's actual sessions.

    fn origins(jsonl: &str) -> Vec<TurnOrigin> {
        segment_str(jsonl).turns
    }

    #[test]
    fn user_submission_opens_user_turn() {
        let jsonl = r#"
{"type":"user","message":{"role":"user","content":"hello","id":"x"},"permissionMode":"default"}
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::User]);
    }

    #[test]
    fn wake_opens_assistant_turn_no_user_row() {
        let jsonl = r#"
{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>t1</task-id>\n<summary>Monitor</summary>\n</task-notification>"}}
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"woke"}]}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::Assistant]);
    }

    #[test]
    fn leading_orphan_assistant_opens_assistant_turn() {
        // A `--continue` leading orphan: assistant content with no user
        // submission before it. The honest replacement for the old
        // synthesized empty `add_user_message`.
        let jsonl = r#"
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"orphan"}]}}
{"type":"user","message":{"role":"user","content":"now a real one"},"permissionMode":"default"}
{"type":"assistant","message":{"id":"m2","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]}}
"#;
        assert_eq!(
            origins(jsonl),
            vec![TurnOrigin::Assistant, TurnOrigin::User]
        );
    }

    #[test]
    fn same_msg_id_split_is_one_turn() {
        // Two consecutive assistant records sharing message.id, each with a
        // terminal stop_reason — one logical turn, not two.
        let jsonl = r#"
{"type":"user","message":{"role":"user","content":"go"},"permissionMode":"default"}
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"hmm"}]}}
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::User]);
    }

    #[test]
    fn distinct_back_to_back_assistant_terminals_are_two_turns() {
        // Two assistant responses with different message.ids and no user
        // between them — two assistant-originated turns.
        let jsonl = r#"
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"one"}]}}
{"type":"assistant","message":{"id":"m2","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"two"}]}}
"#;
        assert_eq!(
            origins(jsonl),
            vec![TurnOrigin::Assistant, TurnOrigin::Assistant]
        );
    }

    #[test]
    fn tool_use_cycle_is_one_turn() {
        // Non-terminal tool_use stop_reason keeps the turn open across the
        // tool_result and the follow-on assistant text.
        let jsonl = r#"
{"type":"user","message":{"role":"user","content":"use a tool"},"permissionMode":"default"}
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file"}]}}
{"type":"assistant","message":{"id":"m2","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"read it"}]}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::User]);
    }

    #[test]
    fn meta_compact_scaffolding_interrupt_open_nothing() {
        let jsonl = r#"
{"type":"user","isMeta":true,"message":{"role":"user","content":"[Image: source: /x]"}}
{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}
{"type":"user","message":{"role":"user","content":"<local-command-stdout>done</local-command-stdout>"}}
{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"}}
"#;
        // The compact summary + the following orphan assistant would open
        // an assistant turn, but here there is no assistant content, so
        // nothing opens.
        assert_eq!(origins(jsonl), Vec::<TurnOrigin>::new());
    }

    #[test]
    fn command_envelope_opens_a_user_turn() {
        // The `<command-*>` envelope is the only record of a slash-command
        // submission, so it opens a user turn — unlike the surrounding
        // caveat / stdout scaffolding. Mirrors tugcode's `isCommandEnvelope`.
        let jsonl = r#"
{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat</local-command-caveat>"}}
{"type":"user","message":{"role":"user","content":"<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args>keep X</command-args>"}}
{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted</local-command-stdout>"}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::User]);
    }

    #[test]
    fn prose_quoting_the_envelope_tags_is_an_ordinary_submission() {
        let jsonl = r#"
{"type":"user","message":{"role":"user","content":"I ran <command-name>/help</command-name> earlier"}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::User]);
    }

    #[test]
    fn bridge_issued_model_envelope_opens_nothing() {
        // `/model` travels as a `set_model` control_request; claude writes
        // the envelope anyway, once per change and again per card mount.
        // It is machinery, not a submission — only the real prompt after it
        // opens a turn. Mirrors tugcode's `isBridgeIssuedCommandEnvelope`.
        let jsonl = r#"
{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus[1m]</command-args>"}}
{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to opus[1m]</local-command-stdout>"}}
{"type":"user","permissionMode":"default","message":{"role":"user","content":"now do the thing"}}
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::User]);
    }

    #[test]
    fn compact_continuation_renders_assistant_origin() {
        // A /compact summary (skipped) followed by assistant continuation
        // content opens an assistant-originated turn.
        let jsonl = r#"
{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}
{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"continuing"}]}}
"#;
        assert_eq!(origins(jsonl), vec![TurnOrigin::Assistant]);
    }

    #[test]
    fn empty_session_zero_turns() {
        assert_eq!(origins(""), Vec::<TurnOrigin>::new());
        assert_eq!(
            origins(r#"{"type":"mode","mode":"normal"}"#),
            Vec::<TurnOrigin>::new()
        );
    }

    /// The real-corpus contract ([P05], [P07], Risk R01): for every session
    /// JSONL under the user's real local corpus, the Rust engine's ordered
    /// per-turn origin list equals tugcode's (`tugcode segment <dir>`),
    /// **per-turn (origin + ordinal), not just total count**. This is the
    /// anti-drift gate that the deleted sanitized golden corpus could never
    /// be. Local-only: skips when the corpus or the bun-compiled tugcode
    /// binary is absent; on divergence it names the exact sessions + index.
    #[test]
    fn engine_matches_tugcode_segmentation_over_real_corpus() {
        let dir = reference_corpus_dir();
        if !dir.is_dir() {
            eprintln!("skipping: real corpus not present at {}", dir.display());
            return;
        }
        let bin = tugcode_bin();
        if !bin.exists() {
            eprintln!(
                "skipping: tugcode binary not present at {} (set TUGCODE_BIN or build it)",
                bin.display()
            );
            return;
        }

        // The corpus is live: stamp it before the spawn so a session written
        // during the run is skipped rather than read as a divergence.
        let mut still = StillFiles::stamp(&dir);

        // One spawn: tugcode segments the whole directory to a
        // `{ basename: ["user" | "assistant", …] }` map on stdout.
        let output = std::process::Command::new(&bin)
            .arg("segment")
            .arg(&dir)
            .output()
            .expect("spawn tugcode segment");
        assert!(
            output.status.success(),
            "tugcode segment failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let tugcode_map: std::collections::BTreeMap<String, Vec<String>> =
            serde_json::from_slice(&output.stdout).expect("parse tugcode segment JSON");
        assert!(
            !tugcode_map.is_empty(),
            "tugcode segmented zero files — corpus empty or unreadable"
        );

        let mut divergences: Vec<String> = Vec::new();
        let mut compared = 0usize;
        for (base, tugcode_origins) in &tugcode_map {
            let path = dir.join(base);
            let Ok(jsonl) = std::fs::read_to_string(&path) else {
                continue;
            };
            if !still.still(&path) {
                continue;
            }
            let engine_origins: Vec<&str> = segment_str(&jsonl)
                .turns
                .into_iter()
                .map(origin_str)
                .collect();
            compared += 1;

            if engine_origins.len() != tugcode_origins.len() {
                divergences.push(format!(
                    "{base}: count engine={} tugcode={}",
                    engine_origins.len(),
                    tugcode_origins.len()
                ));
                continue;
            }
            for (i, (e, t)) in engine_origins.iter().zip(tugcode_origins).enumerate() {
                if e != t {
                    divergences.push(format!("{base}: turn #{i} engine={e} tugcode={t}"));
                    break;
                }
            }
        }

        eprintln!(
            "real-corpus contract: compared {compared} sessions, {} divergent, \
             {} skipped (written during the run)",
            divergences.len(),
            still.skipped()
        );
        assert!(
            divergences.is_empty(),
            "engine != tugcode segmentation on {} session(s):\n{}",
            divergences.len(),
            divergences.join("\n")
        );
    }

    #[test]
    fn incremental_split_mid_continuation_pair_matches_full() {
        // Split the stream right between the two halves of a same-msg_id
        // continuation pair: the frontier must carry the pending-close
        // state so the suffix resolves the pair as one turn.
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"go"},"permissionMode":"default"}"#,
            r#"{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"x"}]}}"#,
            r#"{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"y"}]}}"#,
        ];
        let full = segment_turns(
            lines.iter().filter_map(|l| parse_significant(l)),
            Frontier::default(),
        );
        let pre = segment_turns(
            lines[..2].iter().filter_map(|l| parse_significant(l)),
            Frontier::default(),
        );
        let post = segment_turns(
            lines[2..].iter().filter_map(|l| parse_significant(l)),
            pre.frontier.clone(),
        );
        let mut incr = pre.turns.clone();
        incr.extend(post.turns.iter().copied());
        assert_eq!(incr, full.turns);
        assert_eq!(incr, vec![TurnOrigin::User]);
    }
}
