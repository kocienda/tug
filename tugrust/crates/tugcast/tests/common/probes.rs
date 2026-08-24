//! Shared probe table for the golden stream-json catalog.
//!
//! **Classification is tentative.** The `required_events` and
//! `optional_events` arrays seed from transport exploration prose
//! (captured against `claude 2.1.87`). Each probe is reconciled against
//! live `claude 2.1.104` captures — events the live run does not emit
//! get removed; events live runs add get folded in. Do not treat
//! anything in this file as the ground truth on its own.
//!
//! The capture binary in `tests/capture_stream_json_catalog.rs` iterates
//! `PROBES`, runs each one against a fresh `TestTugcast`, normalizes the
//! resulting event stream, and writes it to
//! `tests/fixtures/stream-json-catalog/v<version>/<probe.name>.jsonl`.
//! The drift test in `tests/stream_json_catalog_drift.rs` replays the
//! same probe table against live claude and shape-diffs the stream
//! against the committed golden.

#![allow(dead_code)]

/// A single probe in the catalog. Probes are static for per-probe
/// isolation under [D01] — running probe N with state from probe N-1
/// would contaminate the stream shape and defeat the golden catalog's
/// purpose.
#[derive(Debug)]
pub struct ProbeRecord {
    /// Filesystem-safe identifier, e.g. `"test-05-tool-use-read"`.
    /// Used as both the fixture filename stem and the manifest entry key.
    pub name: &'static str,
    /// Ordered sequence of inbound messages the capture binary sends
    /// to drive this probe. Each element maps 1:1 to a `TestWs::send_*`
    /// helper.
    pub input_script: &'static [ProbeMsg],
    /// Event types the probe is expected to emit in the CODE_OUTPUT
    /// feed. A missing required event causes the drift test to fail.
    /// Tentative — reclassified during Step 4.
    pub required_events: &'static [&'static str],
    /// Event types that sometimes appear and sometimes don't across
    /// stability runs. Tentative — reclassified during Step 4.
    pub optional_events: &'static [&'static str],
    /// Runtime prerequisites that must be satisfied before the probe
    /// is meaningful. If any prerequisite is not met, the probe is
    /// marked `Skipped` in the manifest with an explicit reason rather
    /// than running and producing misleading fixtures.
    pub prerequisites: &'static [ProbePrereq],
    /// Per-probe hard timeout. Defaults to 30 s for simple turns,
    /// 60 s for longer streaming, 90 s for subagent / `/tugplug:plan`
    /// multi-agent flows.
    pub timeout_secs: u64,
    /// If `Some`, the probe is unconditionally skipped at capture
    /// time with this reason. Used for probes blocked on a known
    /// upstream bug that has a `dev.md §T0.5` follow-up pointer —
    /// the reason string should name the specific follow-up so the
    /// manifest.json tells a future reader where to look.
    ///
    /// `None` means run the probe normally.
    pub skip_reason: Option<&'static str>,
}

/// One inbound message the capture binary sends to drive a probe.
/// Each variant corresponds to a `TestWs::send_*` helper.
#[derive(Debug)]
pub enum ProbeMsg {
    /// Plain `user_message` with text and no attachments.
    UserMessage { text: &'static str },
    /// `user_message` with one or more attachments.
    UserMessageWithAttachments {
        text: &'static str,
        attachments: &'static [Attachment],
    },
    /// `interrupt` — stop the current turn.
    Interrupt,
    /// `tool_approval` — answer a `control_request_forward` permission
    /// gate. `request_id` is captured at runtime from the in-flight
    /// `control_request_forward` event, so the capture binary looks up
    /// the `request_id` rather than using a static value. `decision` is
    /// `"allow"` or `"deny"`.
    ToolApproval {
        decision: &'static str,
        message: Option<&'static str>,
    },
    /// `question_answer` — answer a `control_request_forward` with
    /// `is_question: true`. Like `ToolApproval`, `request_id` is
    /// captured at runtime. `answers` is a slice of `(key, value)`
    /// tuples; the capture binary converts it to a JSON object.
    QuestionAnswer {
        answers: &'static [(&'static str, &'static str)],
    },
    /// `session_command` — `"new"`, `"continue"`, or `"fork"`.
    SessionCommand { command: &'static str },
    /// `model_change` — switch models without restarting the session.
    ModelChange { model: &'static str },
    /// `permission_mode` — `"default"`, `"acceptEdits"`, `"plan"`, etc.
    PermissionMode { mode: &'static str },
    /// Wait for a specific event type before sending the next message.
    /// Used by probes that need to see a `control_request_forward`
    /// before responding with a `tool_approval`/`question_answer`, or
    /// by interrupt probes that want to wait for streaming to begin
    /// before firing.
    WaitForEvent {
        event_type: &'static str,
        max_secs: u64,
    },
    /// Sleep for a fixed duration. Used by interrupt probes to wait a
    /// short time after driving a long prompt so streaming has started
    /// before the interrupt fires.
    Sleep { millis: u64 },
    /// `rewind_preview` — the `/rewind` diff-stat preview ([#step-7-1]).
    /// The anchor `promptUuid` is NOT static: it is captured at runtime
    /// from the `prompt_anchor` CODE_OUTPUT event of a preceding turn
    /// (via a `WaitForEvent{event_type:"prompt_anchor"}`), just as
    /// `ToolApproval` captures its `request_id` from a
    /// `control_request_forward`. Requires file checkpointing
    /// (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`, set by tugcode
    /// at spawn) and an idle session (issue after `turn_complete`).
    RewindPreview,
    /// Consume the next `prompt_anchor` CODE_OUTPUT event and stash its
    /// `promptUuid` as the rewind anchor ([#step-7-2]). Unlike
    /// `WaitForEvent{event_type:"prompt_anchor"}` (a non-consuming peek that
    /// always returns the FIRST buffered anchor — turn 1's), this REMOVES the
    /// matched anchor from the buffer, so a multi-turn probe can target a
    /// LATER turn: consume turn 1's anchor, then consume turn 2's, leaving
    /// `captured_prompt_uuid` pointing at turn 2. The consumed anchors do not
    /// appear in the fixture (deterministic, so drift-stable).
    CaptureAnchor { max_secs: u64 },
    /// Consume CODE_OUTPUT events up to and including the next one of
    /// `event_type`, removing it from the buffer. The consuming counterpart
    /// to `WaitForEvent` (a non-consuming peek). Needed at a TURN BOUNDARY in
    /// a multi-turn probe: the peek-based `WaitForEvent{turn_complete}` would
    /// keep matching turn 1's buffered `turn_complete`, firing the next step
    /// while a later turn is still mid-flight. Consuming turn 1's
    /// `turn_complete` makes the next `WaitForEvent{turn_complete}` gate on
    /// turn 2's. The consumed event is omitted from the fixture (deterministic).
    ConsumeEvent {
        event_type: &'static str,
        max_secs: u64,
    },
    /// `session_rewind` — apply a `/rewind` ([#step-7-1]/[#step-7-2]).
    /// `scope` ∈ {`"code"`, `"conversation"`, `"both"`}. Uses the same
    /// runtime-captured `promptUuid` as `RewindPreview`. `fork` controls the
    /// conversation dimension ([#step-7-2]): `None` omits the flag (tugcode's
    /// default = fork into a new session id), `Some(false)` requests the
    /// destructive in-place `--resume` (same id).
    SessionRewind {
        scope: &'static str,
        fork: Option<bool>,
    },
}

/// Inline attachment for `UserMessageWithAttachments` probes.
#[derive(Debug)]
pub struct Attachment {
    pub filename: &'static str,
    /// Base64-encoded content.
    pub content: &'static str,
    pub media_type: &'static str,
}

/// Runtime prerequisite for a probe. The capture binary checks each
/// prerequisite before running the probe; if any fails the probe is
/// skipped with an explicit reason rather than run-and-fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbePrereq {
    /// The tugplug plugin must be loaded in the tugcode subprocess.
    /// Used by probes 25, 26, 28, 34, 35 which enumerate or invoke
    /// tugplug skills/agents. When tugcast does not pass
    /// `--plugin-dir tugplug/` to tugcode, these probes are skipped.
    TugplugPluginLoaded,
    /// The probe requires a tool call that can be denied at the
    /// permission gate. Used by probe 11 (deny round-trip). Assumed
    /// available in the default `acceptEdits` mode for filesystem
    /// reads outside the project root.
    DenialCapableTool,
}

/// Outcome of running a single probe.
#[derive(Debug, Clone)]
pub enum ProbeStatus {
    /// All required events observed, stability runs agreed on the
    /// shape, fixture written.
    Passed,
    /// One or more prerequisites not met at runtime. Carries the
    /// reason (e.g., `"tugplug plugin not loaded"`).
    Skipped(&'static str),
    /// Probe executed but a required event was missing, or the
    /// transport emitted an unexpected error event. Carries a
    /// human-readable diagnostic.
    Failed(String),
    /// Stability runs disagreed on the event shape across runs.
    /// Carries a diagnostic pointing at the flapping event type.
    ShapeUnstable(String),
}

// -----------------------------------------------------------------------
// Probe table — 45 entries
// -----------------------------------------------------------------------

/// The full probe table. Order matches `transport-exploration.md` tests 1–36.
///
/// **Tentative classification.** Reconcile against live `claude 2.1.104`
/// before treating `required_events` as ground truth — the capture
/// binary collects whatever claude actually emits; review decides
/// required vs optional.
pub static PROBES: &[ProbeRecord] = &[
    // --- Test 1: Basic round-trip ---
    ProbeRecord {
        name: "test-01-basic-round-trip",
        input_script: &[ProbeMsg::UserMessage {
            text: "Say hello in exactly 5 words.",
        }],
        required_events: &[
            "session_init",
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 2: Longer response / streaming behavior ---
    ProbeRecord {
        name: "test-02-longer-response-streaming",
        input_script: &[ProbeMsg::UserMessage {
            text: "Write a short paragraph (about 100 words) explaining why the sky is blue.",
        }],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 3: Slash command /cost ---
    ProbeRecord {
        name: "test-03-slash-cost",
        input_script: &[ProbeMsg::UserMessage { text: "/cost" }],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 4: Slash command /status ---
    ProbeRecord {
        name: "test-04-slash-status",
        input_script: &[ProbeMsg::UserMessage { text: "/status" }],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 5: Tool use (Read file) ---
    ProbeRecord {
        name: "test-05-tool-use-read",
        input_script: &[ProbeMsg::UserMessage {
            text: "Read the first 3 lines of CLAUDE.md and tell me what they say.",
        }],
        required_events: &[
            "system_metadata",
            "tool_use",
            "tool_result",
            "tool_use_structured",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 6: Interrupt mid-stream ---
    ProbeRecord {
        name: "test-06-interrupt-mid-stream",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Write a 500-word essay about the history of the printing press.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "assistant_text",
                max_secs: 15,
            },
            ProbeMsg::Sleep { millis: 500 },
            ProbeMsg::Interrupt,
        ],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 7: Multiple tool calls in one turn ---
    ProbeRecord {
        name: "test-07-multiple-tool-calls",
        input_script: &[ProbeMsg::UserMessage {
            text: "Read the first line of CLAUDE.md and the first line of tugrust/Cargo.toml. Tell me both.",
        }],
        required_events: &[
            "system_metadata",
            "tool_use",
            "tool_result",
            "tool_use_structured",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 8: Tool error (nonexistent file) ---
    // NOTE: The canary found that `control_request_forward` is in
    // practice only emitted when the WaitForEvent path peeks rather
    // than consumes the frame. It's required — the capture binary's
    // Step 4 canary proved that when `peek_code_output_event` is used
    // instead of `await_code_output_event`, the forward makes it
    // into the fixture. Kept required here.
    ProbeRecord {
        name: "test-08-tool-error-nonexistent",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Read the file /nonexistent/path/that/does/not/exist.txt",
            },
            ProbeMsg::WaitForEvent {
                event_type: "control_request_forward",
                max_secs: 20,
            },
            ProbeMsg::ToolApproval {
                decision: "deny",
                message: Some("Denied by capture probe"),
            },
        ],
        required_events: &[
            "system_metadata",
            "tool_use",
            "control_request_forward",
            "tool_result",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["tool_use_structured", "thinking_text"],
        prerequisites: &[ProbePrereq::DenialCapableTool],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 9: Bash tool (auto-approved) ---
    ProbeRecord {
        name: "test-09-bash-auto-approved",
        input_script: &[ProbeMsg::UserMessage {
            text: "Run this bash command: echo 'hello from bash'",
        }],
        required_events: &[
            "system_metadata",
            "tool_use",
            "tool_result",
            "tool_use_structured",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 10: Long streaming (300 words) ---
    // P19 (45 s router heartbeat reset) was resolved by the TestWs
    // client-side heartbeat task in `tests/common/mod.rs`. This probe
    // — the canonical long-streaming trigger whose ~54 s collect phase
    // used to hit `Connection reset without closing handshake` — now
    // captures cleanly and is re-enabled as of the P19 landing.
    ProbeRecord {
        name: "test-10-long-streaming-300-words",
        input_script: &[ProbeMsg::UserMessage {
            text: "Write exactly 300 words about the history of the internet. Count carefully.",
        }],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 180,
        skip_reason: None,
    },
    // --- Test 11: Permission approval round-trip (deny) ---
    ProbeRecord {
        name: "test-11-permission-deny-roundtrip",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Read the file /nonexistent/file.txt",
            },
            ProbeMsg::WaitForEvent {
                event_type: "control_request_forward",
                max_secs: 20,
            },
            ProbeMsg::ToolApproval {
                decision: "deny",
                message: Some("Denied by probe script"),
            },
        ],
        required_events: &[
            "system_metadata",
            "tool_use",
            "control_request_forward",
            "tool_result",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["tool_use_structured", "thinking_text"],
        prerequisites: &[ProbePrereq::DenialCapableTool],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 12: /compact and /model ---
    ProbeRecord {
        name: "test-12-slash-compact-model",
        input_script: &[
            ProbeMsg::UserMessage { text: "/compact" },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 30,
            },
            ProbeMsg::UserMessage { text: "/model" },
        ],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text"],
        prerequisites: &[],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 13: session_command new ---
    // Blocked on dev.md §T0.5 P16 (session_command routing bug).
    // The Step 4 canary confirmed test-13/17/20 all hit the same
    // 45s connection reset as test-10/25/35 — sibling symptom of
    // P19. Skipped until the supervisor is fixed.
    ProbeRecord {
        name: "test-13-session-command-new",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Say 'first session'.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 15,
            },
            ProbeMsg::SessionCommand { command: "new" },
        ],
        required_events: &["session_init"],
        optional_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
            "error",
        ],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: Some("blocked on dev.md §T0.5 P16 — session_command routing bug"),
    },
    // --- Test 14: Message during active turn ---
    ProbeRecord {
        name: "test-14-message-during-turn",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Write 200 words about the ocean.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "assistant_text",
                max_secs: 15,
            },
            ProbeMsg::Sleep { millis: 500 },
            ProbeMsg::UserMessage {
                text: "Stop. Just say 'INTERRUPTED'.",
            },
        ],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 90,
        skip_reason: None,
    },
    // --- Test 15: /btw side question ---
    ProbeRecord {
        name: "test-15-slash-btw",
        input_script: &[ProbeMsg::UserMessage {
            text: "/btw What is 2+2?",
        }],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 16: model_change round-trip ---
    ProbeRecord {
        name: "test-16-model-change-roundtrip",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "What Anthropic model are you? Answer in one short sentence.",
            },
            // Turn 1 runs on the default model (opus 4.8, 1M context),
            // whose first-token + completion latency on a cold session
            // routinely exceeds 20 s — the old value timed out here and
            // mislabeled the probe a "flake". The intermediate wait only
            // needs to outlast a single default-model turn; 75 s does,
            // with headroom for thinking. The overall `timeout_secs`
            // budget below must exceed this plus turn 2.
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 75,
            },
            ProbeMsg::ModelChange {
                model: "claude-sonnet-4-6",
            },
            ProbeMsg::UserMessage {
                text: "What Anthropic model are you now? Answer in one short sentence.",
            },
        ],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 150,
        skip_reason: None,
    },
    // --- Test 17: session_command continue ---
    // Blocked on dev.md §T0.5 P16 — multi-session router hangs on
    // continue's post-command probe turn. Canary also confirms
    // the 45s reset (P19 sibling). Skipped.
    ProbeRecord {
        name: "test-17-session-command-continue",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Remember the marker PROBE_MARKER_17.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 15,
            },
            ProbeMsg::SessionCommand {
                command: "continue",
            },
            ProbeMsg::UserMessage {
                text: "What was the marker?",
            },
        ],
        required_events: &["session_init", "assistant_text", "turn_complete"],
        optional_events: &["system_metadata", "cost_update", "thinking_text"],
        prerequisites: &[],
        timeout_secs: 60,
        skip_reason: Some("blocked on dev.md §T0.5 P16 — session_command routing bug"),
    },
    // --- Test 18: Message during turn (detailed variant of 14) ---
    // Test 14 and Test 18 probe the same behavior in transport-exploration.md;
    // we keep them as separate fixtures so a future prose revision can
    // split them without disturbing the catalog index.
    ProbeRecord {
        name: "test-18-message-during-turn-detailed",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Count from one to ten slowly, one number per line.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "assistant_text",
                max_secs: 15,
            },
            ProbeMsg::Sleep { millis: 300 },
            ProbeMsg::UserMessage {
                text: "Actually, say 'DONE' instead.",
            },
        ],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 90,
        skip_reason: None,
    },
    // --- Test 19: /compact (rich cost_update) ---
    ProbeRecord {
        name: "test-19-slash-compact",
        input_script: &[
            ProbeMsg::UserMessage { text: "Say 'one'." },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 20,
            },
            ProbeMsg::UserMessage { text: "/compact" },
        ],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text", "thinking_text", "compact_boundary"],
        prerequisites: &[],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 20: session_command fork ---
    // Blocked on dev.md §T0.5 P16 — same supervisor-routing class
    // as tests 13/17. Canary confirms 45s connection reset.
    ProbeRecord {
        name: "test-20-session-command-fork",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Say 'pre-fork'.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 15,
            },
            ProbeMsg::SessionCommand { command: "fork" },
        ],
        required_events: &["session_init"],
        optional_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
            "error",
        ],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: Some("blocked on dev.md §T0.5 P16 — session_command routing bug"),
    },
    // --- Test 21: Glob tool (auto-approved) ---
    ProbeRecord {
        name: "test-21-glob-tool",
        input_script: &[ProbeMsg::UserMessage {
            text: "Use the Glob tool to find all .md files in the dash/ directory.",
        }],
        required_events: &[
            "system_metadata",
            "tool_use",
            "tool_result",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["tool_use_structured", "thinking_text"],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 22: Subagent spawn (Agent tool) ---
    ProbeRecord {
        name: "test-22-subagent-spawn",
        input_script: &[ProbeMsg::UserMessage {
            text: "Use an Explore agent to find where the string 'FeedId::CODE_INPUT' appears in the tugrust workspace. Report just the file paths.",
        }],
        required_events: &[
            "system_metadata",
            "tool_use",
            "tool_result",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["tool_use_structured", "thinking_text"],
        prerequisites: &[],
        timeout_secs: 120,
        skip_reason: None,
    },
    // --- Test 23: Image attachment ---
    // 1x1 transparent PNG, base64-encoded. Pure static data.
    ProbeRecord {
        name: "test-23-image-attachment",
        input_script: &[ProbeMsg::UserMessageWithAttachments {
            text: "I'm attaching a tiny image. What can you see? One short sentence.",
            attachments: &[Attachment {
                filename: "test-pixel.png",
                // 1x1 transparent PNG.
                content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
                media_type: "image/png",
            }],
        }],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 24: @ file references ---
    ProbeRecord {
        name: "test-24-at-file-references",
        input_script: &[ProbeMsg::UserMessage {
            text: "What's in @CLAUDE.md? Answer in one short sentence.",
        }],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &[
            "thinking_text",
            "tool_use",
            "tool_result",
            "tool_use_structured",
        ],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 25: Tugplug skill invocation (/plan) ---
    // P19 (45 s heartbeat reset) is resolved. Un-skipping this probe
    // during the P19 landing revealed a *different* problem: the
    // `/tugplug:plan` skill is an interactive orchestrator that asks
    // clarifying questions via AskUserQuestion before producing
    // `turn_complete`. The probe script only sends the initial
    // UserMessage and never answers the question forwards, so the
    // skill hangs for the full 180 s timeout. Fixing this requires
    // a probe-script redesign — either answer clarifying questions
    // inline (like `test-35-askuserquestion-flow` does) or narrow
    // `required_events` to "first few events" and exit without
    // turn_complete. Tracked as a follow-on to P19. (Plugin IS loaded
    // at capture time since project_dir is the tugtool repo root.)
    ProbeRecord {
        name: "test-25-tugplug-plan-invocation",
        input_script: &[ProbeMsg::UserMessage {
            text: "/tugplug:devise Add a --no-auth flag to tugcast for development testing",
        }],
        required_events: &["system_metadata", "turn_complete"],
        optional_events: &[
            "assistant_text",
            "tool_use",
            "tool_result",
            "cost_update",
            "thinking_text",
        ],
        prerequisites: &[ProbePrereq::TugplugPluginLoaded],
        timeout_secs: 180,
        skip_reason: Some(
            "probe script incomplete — /tugplug:devise asks clarifying questions the script never answers; needs redesign (not P19)",
        ),
    },
    // --- Test 26: /dash and /tugplug:dash ---
    ProbeRecord {
        name: "test-26-slash-dash",
        input_script: &[ProbeMsg::UserMessage {
            text: "/tugplug:dash status",
        }],
        required_events: &["system_metadata", "turn_complete"],
        optional_events: &[
            "assistant_text",
            "tool_use",
            "tool_result",
            "cost_update",
            "thinking_text",
        ],
        prerequisites: &[ProbePrereq::TugplugPluginLoaded],
        timeout_secs: 60,
        skip_reason: None,
    },
    // --- Test 27: @ file references (24a/24b variant) ---
    ProbeRecord {
        name: "test-27-at-file-references-variant",
        input_script: &[ProbeMsg::UserMessage {
            text: "What's in @tugrust/Cargo.toml? Answer in one short sentence.",
        }],
        required_events: &[
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &[
            "thinking_text",
            "tool_use",
            "tool_result",
            "tool_use_structured",
        ],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 28: system_metadata deep dive (plugin skill visibility) ---
    // The capture binary records the first `system_metadata` event of
    // any probe as the source-of-truth dump. This probe is a dedicated
    // hello-world whose only purpose is to harvest `system_metadata`
    // fields for the schema.
    ProbeRecord {
        name: "test-28-system-metadata-deep-dive",
        input_script: &[ProbeMsg::UserMessage { text: "Say 'ok'." }],
        required_events: &[
            "session_init",
            "system_metadata",
            "assistant_text",
            "cost_update",
            "turn_complete",
        ],
        optional_events: &["thinking_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 29: /tugplug:ping with correct --plugin-dir ---
    ProbeRecord {
        name: "test-29-tugplug-ping",
        input_script: &[ProbeMsg::UserMessage {
            text: "/tugplug:ping",
        }],
        required_events: &["system_metadata", "turn_complete"],
        optional_events: &["assistant_text", "cost_update", "thinking_text"],
        prerequisites: &[ProbePrereq::TugplugPluginLoaded],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 30: /tugplug:dash status (full orchestrator run) ---
    ProbeRecord {
        name: "test-30-tugplug-dash-status",
        input_script: &[ProbeMsg::UserMessage {
            text: "/tugplug:dash status",
        }],
        required_events: &["system_metadata", "turn_complete"],
        optional_events: &[
            "assistant_text",
            "tool_use",
            "tool_result",
            "tool_use_structured",
            "cost_update",
            "thinking_text",
        ],
        prerequisites: &[ProbePrereq::TugplugPluginLoaded],
        timeout_secs: 90,
        skip_reason: None,
    },
    // --- Test 31: /cost classification ---
    ProbeRecord {
        name: "test-31-slash-cost-classification",
        input_script: &[ProbeMsg::UserMessage { text: "/cost" }],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 32: /compact classification ---
    ProbeRecord {
        name: "test-32-slash-compact-classification",
        input_script: &[ProbeMsg::UserMessage { text: "/compact" }],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text"],
        prerequisites: &[],
        timeout_secs: 45,
        skip_reason: None,
    },
    // --- Test 33: /model classification ---
    ProbeRecord {
        name: "test-33-slash-model-classification",
        input_script: &[ProbeMsg::UserMessage { text: "/model" }],
        required_events: &["system_metadata", "cost_update", "turn_complete"],
        optional_events: &["assistant_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 34: Plugin agent enumeration ---
    // Requires tugplug plugin loaded to show the 12 tugplug agents in
    // `system_metadata.agents`. Default spawn has only 5 built-in
    // agents.
    ProbeRecord {
        name: "test-34-plugin-agent-enumeration",
        input_script: &[ProbeMsg::UserMessage { text: "Say 'ok'." }],
        required_events: &[
            "session_init",
            "system_metadata",
            "assistant_text",
            "turn_complete",
        ],
        optional_events: &["cost_update", "thinking_text"],
        prerequisites: &[ProbePrereq::TugplugPluginLoaded],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 35: Live /tugplug:plan with AskUserQuestion flow ---
    ProbeRecord {
        name: "test-35-askuserquestion-flow",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "/tugplug:plan Add a --no-auth flag to tugcast for development testing",
            },
            ProbeMsg::WaitForEvent {
                event_type: "control_request_forward",
                max_secs: 90,
            },
            ProbeMsg::QuestionAnswer {
                answers: &[("q1", "first option")],
            },
        ],
        required_events: &[
            "system_metadata",
            "tool_use",
            "control_request_forward",
            "turn_complete",
        ],
        optional_events: &[
            "assistant_text",
            "tool_result",
            "tool_use_structured",
            "cost_update",
            "thinking_text",
        ],
        prerequisites: &[ProbePrereq::TugplugPluginLoaded],
        timeout_secs: 180,
        // P19 is resolved. Un-skipping this probe during the P19
        // landing revealed it is flaky at `TUG_STABILITY>=2`: the
        // first capture run returns 0 events in ~90 s (below both
        // the 180 s timeout and the 90 s
        // `WaitForEvent control_request_forward` budget) while
        // subsequent runs capture the full 27-event sequence
        // including `control_request_forward`. The socket does
        // not reset — the probe simply exits without seeing the
        // forward. Likely a tugplug-side cold-start effect around
        // the plan-skill agent. Needs root-cause investigation
        // separate from the heartbeat fix.
        skip_reason: Some(
            "first-run flake at stability>=2 — probe returns 0 events intermittently; needs root-cause investigation separate from P19",
        ),
    },
    // --- Test 36: Slash command /rewind (terminal-local; bounces) ---
    // Empirical capture for session-card `/rewind` ([#step-7a], [D10]). The
    // terminal's `/rewind` is an interactive checkpoint picker rendered
    // entirely client-side — it is NOT a wire verb. Driven over
    // stream-json as a `user_message`, claude bounces it with a
    // *synthetic* assistant turn (`model: "<synthetic>"`, `num_turns: 0`,
    // `total_cost_usd: 0`, zero tokens): "/rewind isn't available in this
    // environment." — the same terminal-rendered-locally class as
    // `/permissions`, `/diff`, etc.
    //
    // This probe pins that bounce so a future claude that DID add a real
    // rewind verb (or changed the bounce text/shape) surfaces as drift.
    // The session-card `/rewind` ([#step-7]) is therefore necessarily
    // client-driven: tugcode truncates the session JSONL at the chosen
    // message uuid and respawns `--resume` (the [R07] respawn pattern) —
    // there is nothing to forward to claude.
    ProbeRecord {
        name: "test-36-slash-rewind",
        input_script: &[ProbeMsg::UserMessage { text: "/rewind" }],
        required_events: &["system_metadata", "assistant_text", "turn_complete"],
        optional_events: &["session_init", "cost_update", "thinking_text"],
        prerequisites: &[],
        timeout_secs: 30,
        skip_reason: None,
    },
    // --- Test 37: `rewind_files` round-trip through tugcode ([#step-7-1]) ---
    // The code-restore half of session-card `/rewind`, driven END-TO-END through
    // tugcast → tugcode → claude (the [#step-7a] capture was direct against
    // claude; this is the bridge). Sequence:
    //   1. Ask claude to Write a file → creates a file checkpoint
    //      (acceptEdits auto-approves the Write; tugcode spawns claude with
    //      `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`).
    //   2. `prompt_anchor` fires early in the turn — the capture binary
    //      stashes its `promptUuid` (the rewind anchor) at runtime.
    //   3. Wait for `turn_complete` so the session is idle (rewind requires
    //      idle — the bridge's gate).
    //   4. `rewind_preview` → `rewind_files{dry_run:true}` → the captured
    //      `rewind_preview_result` carries the per-turn diff stat
    //      (`canRewind`, `filesChanged`, `insertions`, `deletions`) —
    //      matching `fixtures/control-requests/rewind-files.v2.1.158.json`.
    //   5. `session_rewind{scope:"code"}` → `rewind_files{dry_run:false}` →
    //      `rewind_result{canRewind:true}`; the written file is reverted on
    //      disk (the apply side-effect, as in the fixture).
    ProbeRecord {
        name: "test-37-rewind-files-roundtrip",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Use the Write tool to create a file named rewind-probe.txt in the current directory containing exactly the single word HELLO. Do nothing else.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "prompt_anchor",
                max_secs: 30,
            },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 90,
            },
            ProbeMsg::RewindPreview,
            ProbeMsg::WaitForEvent {
                event_type: "rewind_preview_result",
                max_secs: 30,
            },
            ProbeMsg::SessionRewind {
                scope: "code",
                fork: None,
            },
            ProbeMsg::WaitForEvent {
                event_type: "rewind_result",
                max_secs: 30,
            },
        ],
        required_events: &[
            "prompt_anchor",
            "turn_complete",
            "rewind_preview_result",
            "rewind_result",
        ],
        optional_events: &["tool_use", "tool_result", "assistant_text", "cost_update"],
        prerequisites: &[],
        timeout_secs: 120,
        // Skipped at 2.1.197: the setup turn uses the Write tool, and the
        // turn does not complete through tugcode — `turn_complete` never
        // arrives after `prompt_anchor` (0 events, 90 s timeout), even in
        // isolation. Healthy at 2.1.158; the conversation-only rewind
        // probes (test-38/40, no file write) still pass, so the trigger
        // is the Write-tool turn, not rewind.
        //
        // Investigated (see the session writeup): it is NOT raw claude —
        // a raw `claude --permission-mode {bypassPermissions,acceptEdits}`
        // with file checkpointing on completes the identical Write turn
        // in a small AND a 2000-file repo. It is NOT the product in
        // Auto/default mode — the live Session card (Auto mode, checkpointing
        // on) runs Write/Edit turns to completion. The hang is specific
        // to the capture path in **acceptEdits** mode at 2.1.197 — i.e. a
        // tugcode SDK-control-protocol interaction with an
        // acceptEdits-auto-approved Write that needs a frame-level trace
        // (RUST_LOG on the spawned tugcode) to pin, plus a live
        // acceptEdits-mode write test to rule out a product impact for
        // users in that mode. Un-skip once root-caused + the probe path
        // handles the new 2.1.197 control exchange.
        skip_reason: Some(
            "2.1.197: Write-tool turn does not complete through tugcode in \
             acceptEdits mode (raw claude + the Auto-mode Session card are fine); \
             pending frame-level root-cause",
        ),
    },
    // --- Test 38: conversation rewind, FORK (default) ([#step-7-2]) ---
    // The conversation half of session-card `/rewind`, end-to-end through the
    // bridge. A two-turn session is rewound to turn 2: tugcode copies the
    // truncated history under a freshly-minted claude session id, silent-
    // respawns `--resume` against the fork, and acks `rewind_result`
    // carrying `newSessionId` (the card→session rebind). The respawn emits a
    // `session_init` for the new id and NO transcript replay (the [L26]
    // precondition — survivors keep their mounts). Two turns are required: a
    // rewind that drops the only turn yields a near-empty fork that
    // `--resume` rejects ("No conversation found"), so turn 1 is retained.
    // `CaptureAnchor` consumes turn 1's anchor, then turn 2's, leaving the
    // rewind target on turn 2.
    ProbeRecord {
        name: "test-38-rewind-conversation-fork",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Remember the word PINECONE. Reply with only: ok",
            },
            ProbeMsg::CaptureAnchor { max_secs: 30 },
            ProbeMsg::ConsumeEvent {
                event_type: "turn_complete",
                max_secs: 90,
            },
            ProbeMsg::UserMessage {
                text: "Remember the word WALRUS. Reply with only: ok",
            },
            ProbeMsg::CaptureAnchor { max_secs: 30 },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 90,
            },
            ProbeMsg::SessionRewind {
                scope: "conversation",
                fork: None,
            },
            ProbeMsg::WaitForEvent {
                event_type: "rewind_result",
                max_secs: 30,
            },
        ],
        required_events: &["turn_complete", "session_init", "rewind_result"],
        optional_events: &["assistant_text", "cost_update", "system_metadata"],
        prerequisites: &[],
        timeout_secs: 240,
        skip_reason: None,
    },
    // --- Test 39: `scope:"both"` composition — code revert THEN fork ---
    // The one untested interaction from [#step-7a]: `rewind_files` on the
    // live session followed by a conversation fork. Turn 1 is a plain turn;
    // turn 2 writes a file (a checkpoint). Rewinding to turn 2 with
    // `scope:"both"` reverts turn 2's file write (live `fileHistory`) FIRST,
    // then forks the conversation back to turn 1. The single `rewind_result`
    // ack reports the combined outcome + the fork's `newSessionId`.
    ProbeRecord {
        name: "test-39-rewind-both-composition",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Remember the word OTTER. Reply with only: ok",
            },
            ProbeMsg::CaptureAnchor { max_secs: 30 },
            ProbeMsg::ConsumeEvent {
                event_type: "turn_complete",
                max_secs: 90,
            },
            ProbeMsg::UserMessage {
                text: "Use the Write tool to create a file named rewind-both-probe.txt in the current directory containing exactly the single word HELLO. Do nothing else.",
            },
            ProbeMsg::CaptureAnchor { max_secs: 30 },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 120,
            },
            ProbeMsg::SessionRewind {
                scope: "both",
                fork: None,
            },
            ProbeMsg::WaitForEvent {
                event_type: "rewind_result",
                max_secs: 30,
            },
        ],
        required_events: &["turn_complete", "session_init", "rewind_result"],
        optional_events: &[
            "tool_use",
            "tool_result",
            "assistant_text",
            "cost_update",
            "system_metadata",
        ],
        prerequisites: &[],
        timeout_secs: 300,
        // Skipped at 2.1.197 for the same reason as test-37: the `both`
        // composition's setup writes a file, and a Write-tool turn hangs
        // (no `turn_complete`) under acceptEdits + file checkpointing.
        // See test-37's note; un-skip once the Write-turn hang is
        // root-caused.
        skip_reason: Some(
            "2.1.197: Write-tool setup turn never completes (see test-37); \
             healthy at 2.1.158 — pending root-cause",
        ),
    },
    // --- Test 40: conversation rewind, destructive IN-PLACE (fork:false) ---
    // The opt-in variant: truncate the live session's own JSONL and resume
    // it in place (same session id, tail dropped permanently). The ack
    // carries NO `newSessionId` (no rebind — the id is unchanged), and the
    // `session_init` reports the same live id rather than a fresh fork.
    ProbeRecord {
        name: "test-40-rewind-conversation-in-place",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Remember the word BADGER. Reply with only: ok",
            },
            ProbeMsg::CaptureAnchor { max_secs: 30 },
            ProbeMsg::ConsumeEvent {
                event_type: "turn_complete",
                max_secs: 90,
            },
            ProbeMsg::UserMessage {
                text: "Remember the word HERON. Reply with only: ok",
            },
            ProbeMsg::CaptureAnchor { max_secs: 30 },
            ProbeMsg::WaitForEvent {
                event_type: "turn_complete",
                max_secs: 90,
            },
            ProbeMsg::SessionRewind {
                scope: "conversation",
                fork: Some(false),
            },
            ProbeMsg::WaitForEvent {
                event_type: "rewind_result",
                max_secs: 30,
            },
        ],
        required_events: &["turn_complete", "session_init", "rewind_result"],
        optional_events: &["assistant_text", "cost_update", "system_metadata"],
        prerequisites: &[],
        timeout_secs: 240,
        skip_reason: None,
    },
    // --- Test 41: background Bash, clean completion + wake ---
    // Promotes the v2.1.173-jobs-spike P1 lifecycle into the recurring
    // catalog: a backgrounded Bash launches (`task_started{local_bash}`
    // mid-turn), the launch turn ends, the job completes while claude is
    // idle (`task_updated{completed}` inter-turn), and its
    // `task_notification` drives a `wake_started` wake turn. The
    // terminator is the final `WaitForEvent` (`wake_started`), so the
    // collect pass captures the whole launch→terminal→wake arc.
    ProbeRecord {
        name: "test-41-bg-bash-clean",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Use the Bash tool exactly once with run_in_background set to \
                       true and the command `sleep 5 && echo JOBS_OK`. After the tool \
                       returns, end your turn immediately with the single word: \
                       launched. Do not poll, do not read the output file, do not call \
                       any other tools.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "task_started",
                max_secs: 60,
            },
            ProbeMsg::WaitForEvent {
                event_type: "wake_started",
                max_secs: 60,
            },
        ],
        required_events: &[
            "system_metadata",
            "tool_use",
            "task_started",
            "turn_complete",
            "task_updated",
            "wake_started",
        ],
        optional_events: &[
            "thinking_text",
            "assistant_text",
            "cost_update",
            "tool_result",
            "session_init",
        ],
        prerequisites: &[],
        timeout_secs: 120,
        skip_reason: None,
    },
    // --- Test 42: background Agent, progress ticks + wake ---
    // Promotes the v2.1.173-jobs-spike P6 lifecycle: a backgrounded
    // subagent emits `task_started{local_agent}`, one or more
    // `task_progress` ticks as it works (its most recent tool + usage —
    // the frame tugcode dropped before this change), then
    // `task_updated{completed}` + a `wake_started` wake. `task_progress`
    // is optional because a fast agent can finish in a single step with
    // no intermediate tick; the golden pins its shape whenever it fires.
    ProbeRecord {
        name: "test-42-bg-agent-progress",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Use the Agent tool exactly once with run_in_background set to \
                       true, subagent_type \"general-purpose\", and a prompt instructing \
                       it to run the Bash command `sleep 4 && echo AGENT_OK` and then \
                       report the single word done. After the Agent tool returns its \
                       async-launch acknowledgement, end your turn immediately with the \
                       single word: launched. Do not poll, do not read the output file, \
                       do not call any other tools.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "task_started",
                max_secs: 60,
            },
            ProbeMsg::WaitForEvent {
                event_type: "wake_started",
                max_secs: 90,
            },
        ],
        required_events: &[
            "system_metadata",
            "tool_use",
            "task_started",
            "task_progress",
            "turn_complete",
            "wake_started",
        ],
        // `task_updated` is OPTIONAL, not required: for a background
        // AGENT the terminal status rides the `wake_started` (from the
        // agent's `task_notification`), and the sibling `task_updated`
        // lands AFTER it — past the `wake_started` terminator, so it is
        // not in the captured window. The bash lifecycle (test-41) is
        // where `task_updated` is the load-bearing terminal frame; here
        // the load-bearing new frame is `task_progress`.
        optional_events: &[
            "thinking_text",
            "assistant_text",
            "cost_update",
            "tool_result",
            "session_init",
            "task_updated",
        ],
        prerequisites: &[],
        timeout_secs: 150,
        skip_reason: None,
    },
    // --- Test 43: ScheduleWakeup — scheduled re-init wake ---
    // The harness-owned scheduler (Cohort B): no `task_started` frame, a
    // task-id-less re-init delivers the wake, which tugcode brackets as
    // `session_init` + `wake_started{task_id:""}`. Pins the scheduled
    // lifecycle shape distinct from the background-job tiers above.
    ProbeRecord {
        name: "test-43-schedulewakeup-wake",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Use the ScheduleWakeup tool exactly once with delaySeconds 5, \
                       reason \"jobs probe wake\", and prompt \"continue\". After the \
                       tool returns, end your turn immediately with the single word: \
                       scheduled. Do not call any other tools.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "wake_started",
                max_secs: 60,
            },
        ],
        required_events: &[
            "system_metadata",
            "tool_use",
            "turn_complete",
            "session_init",
            "wake_started",
        ],
        optional_events: &[
            "thinking_text",
            "assistant_text",
            "cost_update",
            "tool_result",
        ],
        prerequisites: &[],
        timeout_secs: 120,
        // Skipped in the recurring suite: a 5 s `ScheduleWakeup` does not
        // reliably fire its harness-timer re-init wake within the probe
        // window in a spawned stream-json session — the live capture
        // returned 0 events (the `wake_started` wait timed out). The
        // scheduled (Cohort B, task-id-less re-init) wake shape stays
        // pinned at `v2.1.173-jobs-spike` / the wake-investigation
        // captures; un-skip if a future claude exposes a deterministic
        // scheduled wake over stream-json. (bg-bash test-41 still
        // exercises the `wake_started` bracket via a task_notification.)
        skip_reason: Some(
            "ScheduleWakeup re-init wake is not deterministic over stream-json; \
             shape pinned at v2.1.173-jobs-spike",
        ),
    },
    // --- Test 44: Monitor — short-timeout terminal ---
    // Promotes the v2.1.173-jobs-spike M2 lifecycle: a watcher whose
    // script outlives its `timeout_ms` is killed on timeout, pinning the
    // timeout terminal status (`task_updated{killed}` +
    // `task_notification{stopped}` — the spike found a stopped-status
    // notification does NOT drive a wake turn, so `wake_started` is
    // optional here). Deterministic: the `sleep 120` never beats the
    // 6 s timeout.
    ProbeRecord {
        name: "test-44-monitor-timeout",
        input_script: &[
            ProbeMsg::UserMessage {
                text: "Use the Monitor tool exactly once with command `sleep 120`, \
                       description \"Timeout probe\", timeout_ms 6000, persistent false. \
                       After the tool returns, end your turn immediately with the single \
                       word: monitoring. Do not call any other tools.",
            },
            ProbeMsg::WaitForEvent {
                event_type: "task_started",
                max_secs: 60,
            },
            ProbeMsg::WaitForEvent {
                event_type: "task_updated",
                max_secs: 60,
            },
        ],
        required_events: &[
            "system_metadata",
            "tool_use",
            "task_started",
            "turn_complete",
            "task_updated",
        ],
        optional_events: &[
            "thinking_text",
            "assistant_text",
            "cost_update",
            "tool_result",
            "session_init",
            "wake_started",
        ],
        prerequisites: &[],
        timeout_secs: 120,
        skip_reason: None,
    },
    // --- Test 45: Background-agent transcript restore on resume ---
    // A backgrounded Agent persists its child calls out-of-band in
    // `subagents/agent-<id>.jsonl`; on resume tugcode splices them back
    // under the parent Agent (this suite's subject). Verifying it
    // end-to-end needs a launch → await-completion → RESUME capture, which
    // the recurring single-session probe harness does not model: resume
    // re-spawns tugcode in replay mode reading the prior session's JSONL —
    // a different artifact than a live stream-json turn — and awaiting a
    // background agent's completion is nondeterministic (cf. test-43). The
    // DETERMINISTIC gating coverage lives in the tugcode + tugdeck
    // real-fixture tests (`tugcode/src/__tests__/subagent-resume.test.ts`
    // and `tugdeck/src/__tests__/subagent-resume-replay.test.ts`), which
    // drive the actual captured subagent transcript through the real
    // translator and reducer. Registered here (skipped) so the recurring
    // suite carries the intent; un-skip if the harness gains resume capture.
    ProbeRecord {
        name: "test-45-bg-agent-resume",
        input_script: &[ProbeMsg::UserMessage {
            text: "Use the Agent tool exactly once with run_in_background set to \
                   true, subagent_type \"general-purpose\", and a prompt instructing \
                   it to run the Bash command `sleep 4 && echo AGENT_OK` and then \
                   report the single word done. After the Agent tool returns its \
                   async-launch acknowledgement, end your turn immediately with the \
                   single word: launched. Do not poll, do not read the output file, \
                   do not call any other tools.",
        }],
        required_events: &[
            "system_metadata",
            "tool_use",
            "task_started",
            "turn_complete",
        ],
        optional_events: &[
            "thinking_text",
            "assistant_text",
            "cost_update",
            "tool_result",
            "task_progress",
            "wake_started",
            "task_updated",
            "session_init",
        ],
        prerequisites: &[],
        timeout_secs: 150,
        skip_reason: Some(
            "resume-replay restore needs a launch->await->resume capture the \
             recurring single-session harness does not model, and awaiting bg-agent \
             completion is nondeterministic; deterministic coverage is the \
             tugcode/tugdeck real-fixture tests (subagent-resume*.test)",
        ),
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_table_has_45_entries() {
        assert_eq!(PROBES.len(), 45, "probe table must contain all 45 probes");
    }

    #[test]
    fn probe_names_are_unique() {
        let mut names: Vec<&str> = PROBES.iter().map(|p| p.name).collect();
        names.sort();
        let original_len = names.len();
        names.dedup();
        assert_eq!(
            names.len(),
            original_len,
            "probe names must be unique — duplicates break fixture filenames"
        );
    }

    #[test]
    fn probe_names_are_filesystem_safe() {
        for probe in PROBES {
            for ch in probe.name.chars() {
                assert!(
                    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_',
                    "probe name {:?} contains non-filesystem-safe character {:?}",
                    probe.name,
                    ch
                );
            }
        }
    }

    #[test]
    fn every_probe_has_an_input_script() {
        for probe in PROBES {
            assert!(
                !probe.input_script.is_empty(),
                "probe {:?} has an empty input_script",
                probe.name
            );
        }
    }

    #[test]
    fn every_probe_has_at_least_one_required_event() {
        for probe in PROBES {
            assert!(
                !probe.required_events.is_empty(),
                "probe {:?} has no required_events — at minimum the probe \
                 should expect session_init or turn_complete",
                probe.name
            );
        }
    }

    #[test]
    fn timeouts_are_sensible() {
        for probe in PROBES {
            assert!(
                probe.timeout_secs >= 10,
                "probe {:?} timeout {} s is too short",
                probe.name,
                probe.timeout_secs
            );
            assert!(
                probe.timeout_secs <= 300,
                "probe {:?} timeout {} s is too long — real-claude cap is 5 min",
                probe.name,
                probe.timeout_secs
            );
        }
    }
}
