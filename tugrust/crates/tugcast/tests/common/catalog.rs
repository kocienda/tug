//! Shared catalog capture machinery: normalization, schema derivation,
//! and per-probe execution. Used by both the capture binary
//! (`tests/capture_stream_json_catalog.rs`) and the drift test
//! (`tests/stream_json_catalog_drift.rs`).
//!
//! Originally lived in the capture binary; extracted into `common/` so
//! the drift test can call `execute_probe` and `derive_schema` without
//! duplicating ~500 lines. Each integration test file compiles to its
//! own crate so "just import from the other test file" is not an
//! option — the `mod common;` pattern is the canonical share
//! mechanism.
//!
//! This file is the source of truth for all normalization and
//! schema semantics that the drift test needs to match bit-for-bit.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::time::{Instant, sleep};

use crate::common::probes::{ProbeMsg, ProbePrereq, ProbeRecord, ProbeStatus};
use crate::common::{TestTugcast, TestWs};

// -----------------------------------------------------------------------
// Subscription-auth scrub list + pre-flight refusal
// -----------------------------------------------------------------------

/// Environment variables that override claude CLI's subscription auth
/// resolution. If any of these is set in the parent environment, claude
/// authenticates against per-token API billing instead of the
/// developer's `~/.claude.json` subscription login. The capture binary
/// and the drift regression test both `env_remove` these from the
/// spawned tugcast subprocess, and both pre-flight-refuse to run if any
/// of them is set in the test-invoker's shell (so the developer sees a
/// loud failure up front rather than discovering an `apiKeySource`
/// contamination in a committed fixture later).
///
/// - `ANTHROPIC_API_KEY` — the classic API key, per-token billing.
/// - `ANTHROPIC_AUTH_TOKEN` — alternate API auth header some Anthropic
///   SDKs and wrappers use; also per-token.
/// - `CLAUDE_CODE_OAUTH_TOKEN` — long-lived token from `claude
///   setup-token`. Subscription-tied, so technically safe in isolation,
///   but we scrub it defensively to keep all subscription auth flowing
///   through `~/.claude.json` / the macOS Keychain instead of a shell
///   variable whose provenance the test can't easily audit.
pub const AUTH_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// Pre-flight refusal: panic with a loud, specific message if any of
/// [`AUTH_ENV_VARS`] is set in the current environment. Called at the
/// top of every real-claude test body so the developer sees the
/// problem before we spawn a subprocess chain that would silently fall
/// through to per-token billing.
///
/// The spawn-site `env_remove` calls also defend against leakage (belt
/// and suspenders), but failing loudly up front lets the developer
/// `unset` the variable and retry rather than discovering the leak by
/// reading an `apiKeySource` field in committed output later.
pub fn refuse_if_auth_env_set() {
    for var in AUTH_ENV_VARS {
        if std::env::var_os(var).is_some() {
            panic!(
                "{var} is set in the environment. This test spawns real \
                 claude and this variable would cause claude to authenticate \
                 via per-token API billing instead of your Max/Pro \
                 subscription at ~/.claude.json. Run `unset {var}` in this \
                 shell and re-run.\n\
                 \n\
                 (Spawn sites also scrub this variable defensively, so this \
                 refusal is a warning — not a hard dependency — but we prefer \
                 to fail loudly rather than silently change auth mode.)"
            );
        }
    }
}

/// Fixture root: `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`.
/// Both the capture binary (as the writer of `v<version>/`) and the drift
/// regression test (as the reader of `v<version>/schema.json`) resolve
/// fixtures through this function. Centralized so a future restructure
/// (e.g., moving fixtures up or down in the tree) touches exactly one
/// line.
pub fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("stream-json-catalog")
}

/// Repo-root `capabilities/` directory: the product-facing home for the
/// `system_metadata` snapshots consumed by Tug.app + tugdeck at build
/// time. Layout is documented in `capabilities/README.md`. Computed as a
/// sibling of `tugrust/` via `CARGO_MANIFEST_DIR` (= `<repo>/tugrust/crates/tugcast`).
pub fn capabilities_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("capabilities")
}

// -----------------------------------------------------------------------
// Normalization — leaf-only placeholder substitution per [D04]/[D14]
// -----------------------------------------------------------------------

/// Fields whose string values are rewritten to `{{uuid}}` regardless
/// of whether the content parses as a UUID. This covers the
/// `session_id: "pending-cont-..."` case where the sentinel is not a
/// real UUID but still varies between runs.
const LEAF_ID_KEYS: &[&str] = &[
    "session_id",
    "tool_use_id",
    "msg_id",
    "request_id",
    "task_id",
    "tug_session_id",
];

/// Fields whose string values are collapsed to `{{text:len=N}}` so
/// fixture diffs survive any actual content drift. Covers streamed
/// text deltas, tool output, and file content.
const TEXT_CONTENT_KEYS: &[&str] = &["text", "output"];

/// Fields whose numeric values are collapsed to `{{f64}}` or `{{i64}}`.
/// Explicit allowlist — most numeric fields (`seq`, `is_partial`)
/// carry semantic meaning and must not be erased.
const NUMERIC_ALLOWLIST: &[&str] = &[
    "total_cost_usd",
    "duration_ms",
    "duration_api_ms",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "runtime_ms",
];

fn is_uuid_like(s: &str) -> bool {
    // 8-4-4-4-12 hex layout.
    let bytes = s.as_bytes();
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
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

fn is_iso_timestamp(s: &str) -> bool {
    // Quick shape check: YYYY-MM-DDTHH:MM:SS with optional fractional
    // seconds and timezone. We intentionally don't pull a regex crate
    // for this per [D03]'s no-external-dependency spirit.
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return false;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return false;
    }
    for &idx in &[0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !bytes[idx as usize].is_ascii_digit() {
            return false;
        }
    }
    true
}

fn cwd_prefix() -> Option<String> {
    std::env::var("HOME").ok()
}

fn normalize_string(key: Option<&str>, value: &str, home: Option<&str>) -> String {
    if let Some(k) = key {
        if LEAF_ID_KEYS.contains(&k) {
            return "{{uuid}}".to_string();
        }
        if TEXT_CONTENT_KEYS.contains(&k) {
            return format!("{{{{text:len={}}}}}", value.len());
        }
    }
    if is_iso_timestamp(value) {
        return "{{iso}}".to_string();
    }
    if is_uuid_like(value) {
        return "{{uuid}}".to_string();
    }
    if let Some(h) = home {
        if !h.is_empty() && value.starts_with(h) {
            let suffix = &value[h.len()..];
            return format!("{{{{cwd}}}}{suffix}");
        }
    }
    value.to_string()
}

fn normalize_number(key: Option<&str>, value: &serde_json::Number) -> Value {
    if let Some(k) = key {
        if NUMERIC_ALLOWLIST.contains(&k) {
            if value.is_f64() {
                return Value::String("{{f64}}".to_string());
            }
            return Value::String("{{i64}}".to_string());
        }
    }
    Value::Number(value.clone())
}

/// Leaf-only normalize. Walks `value` in place, replacing leaf strings
/// and leaf numbers according to [#deep-normalization]. Object keys and
/// array structure are preserved exactly.
pub fn normalize_event(value: &mut Value) {
    let home = cwd_prefix();
    normalize_inner(value, None, home.as_deref());
}

fn normalize_inner(value: &mut Value, parent_key: Option<&str>, home: Option<&str>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                let k_owned = k.clone();
                normalize_inner(v, Some(k_owned.as_str()), home);
            }
        }
        Value::Array(arr) => {
            for v in arr.iter_mut() {
                normalize_inner(v, parent_key, home);
            }
        }
        Value::String(s) => {
            *value = Value::String(normalize_string(parent_key, s, home));
        }
        Value::Number(n) => {
            *value = normalize_number(parent_key, n);
        }
        Value::Bool(_) | Value::Null => {}
    }
}

// -----------------------------------------------------------------------
// Schema derivation — per
// -----------------------------------------------------------------------

/// Captured per-probe outcome: ordered event sequence.
#[derive(Debug, Clone)]
pub struct CapturedProbe {
    pub name: String,
    pub events: Vec<Value>,
    pub status: ProbeStatus,
    pub runtime_ms: u128,
}

/// Shape schema derived from one full capture run. Serializes to
/// `schema.json` per.
#[derive(Debug, Default, Clone)]
pub struct Schema {
    pub claude_version: String,
    pub event_types: BTreeMap<String, EventShape>,
    /// Polymorphic `tool_use_structured` keyed by `tool_name` per [D09].
    pub tool_use_structured_by_tool: BTreeMap<String, EventShape>,
    /// Per-probe required event sequence. Optional slots (events that
    /// appear in some runs and not others) are not recorded here yet;
    /// Step 4 stability analysis flags those and demotes them.
    pub probe_sequences: BTreeMap<String, Vec<String>>,
}

/// Per-event-type field summary.
#[derive(Debug, Default, Clone)]
pub struct EventShape {
    pub required_fields: BTreeMap<String, String>,
    pub optional_fields: BTreeMap<String, String>,
}

pub fn describe_value(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) => "boolean".into(),
        Value::Number(n) => {
            if n.is_f64() {
                "number".into()
            } else {
                "integer".into()
            }
        }
        Value::String(_) => "string".into(),
        Value::Array(a) => {
            if let Some(first) = a.first() {
                format!("array<{}>", describe_value(first))
            } else {
                "array<unknown>".into()
            }
        }
        Value::Object(_) => "object".into(),
    }
}

pub fn event_type_of(event: &Value) -> Option<&str> {
    event.get("type").and_then(|v| v.as_str())
}

/// Derive a [`Schema`] from a set of captured probe runs. Aggregates
/// across all probes; a field that is present in every instance of an
/// event type goes to `required_fields`, present in some goes to
/// `optional_fields`.
pub fn derive_schema(claude_version: &str, captures: &[CapturedProbe]) -> Schema {
    let mut schema = Schema {
        claude_version: claude_version.to_string(),
        ..Default::default()
    };

    // Per-event-type accumulators.
    // field_counts[event_type][field_name] = (count, type_description)
    let mut field_counts: BTreeMap<&str, BTreeMap<String, (usize, String)>> = BTreeMap::new();
    let mut event_counts: BTreeMap<&str, usize> = BTreeMap::new();

    // Polymorphic tool_use_structured: key by tool_name.
    let mut tool_field_counts: BTreeMap<String, BTreeMap<String, (usize, String)>> =
        BTreeMap::new();
    let mut tool_counts: BTreeMap<String, usize> = BTreeMap::new();

    for probe in captures {
        // Probe sequence: ordered list of event types.
        let mut seq = Vec::new();
        for event in &probe.events {
            let Some(et) = event_type_of(event) else {
                continue;
            };
            seq.push(et.to_string());

            if et == "tool_use_structured" {
                // Key by tool_name if present, else "unknown".
                let tool_name = event
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                *tool_counts.entry(tool_name.clone()).or_insert(0) += 1;
                let shape = tool_field_counts.entry(tool_name).or_default();
                if let Some(obj) = event.as_object() {
                    for (k, v) in obj {
                        let entry = shape.entry(k.clone()).or_insert((0, describe_value(v)));
                        entry.0 += 1;
                    }
                }
                continue;
            }

            *event_counts.entry(et).or_insert(0) += 1;
            let shape = field_counts.entry(et).or_default();
            if let Some(obj) = event.as_object() {
                for (k, v) in obj {
                    let entry = shape.entry(k.clone()).or_insert((0, describe_value(v)));
                    entry.0 += 1;
                }
            }
        }
        schema.probe_sequences.insert(probe.name.clone(), seq);
    }

    for (et, fields) in field_counts {
        let total = *event_counts.get(et).unwrap_or(&0);
        let mut shape = EventShape::default();
        for (field, (count, ty)) in fields {
            if total > 0 && count == total {
                shape.required_fields.insert(field, ty);
            } else {
                shape.optional_fields.insert(field, ty);
            }
        }
        schema.event_types.insert(et.to_string(), shape);
    }

    for (tool, fields) in tool_field_counts {
        let total = *tool_counts.get(&tool).unwrap_or(&0);
        let mut shape = EventShape::default();
        for (field, (count, ty)) in fields {
            if total > 0 && count == total {
                shape.required_fields.insert(field, ty);
            } else {
                shape.optional_fields.insert(field, ty);
            }
        }
        schema.tool_use_structured_by_tool.insert(tool, shape);
    }

    schema
}

pub fn shape_to_json(shape: &EventShape) -> Value {
    let required: Map<String, Value> = shape
        .required_fields
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    let optional: Map<String, Value> = shape
        .optional_fields
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    json!({
        "required_fields": required,
        "optional_fields": optional,
    })
}

pub fn schema_to_json(schema: &Schema) -> Value {
    let event_types: Map<String, Value> = schema
        .event_types
        .iter()
        .map(|(k, v)| (k.clone(), shape_to_json(v)))
        .collect();

    let tool_by_name: Map<String, Value> = schema
        .tool_use_structured_by_tool
        .iter()
        .map(|(k, v)| (k.clone(), shape_to_json(v)))
        .collect();

    let probe_sequences: Map<String, Value> = schema
        .probe_sequences
        .iter()
        .map(|(k, seq)| {
            let seq_val: Vec<Value> = seq.iter().map(|s| Value::String(s.clone())).collect();
            (
                k.clone(),
                json!({
                    "required_sequence": seq_val,
                }),
            )
        })
        .collect();

    // tool_use_structured under event_types is a thin shell pointing at
    // the polymorphic `by_tool_name` table.
    let mut event_types = event_types;
    if !tool_by_name.is_empty() {
        event_types.insert(
            "tool_use_structured".to_string(),
            json!({
                "by_tool_name": tool_by_name,
            }),
        );
    }

    json!({
        "claude_version": schema.claude_version,
        "event_types": event_types,
        "probe_sequences": probe_sequences,
    })
}

// -----------------------------------------------------------------------
// Execute / stability helpers (real-claude path)
// -----------------------------------------------------------------------

/// Read `TUG_STABILITY` from the env. Defaults to 1 per [D15].
pub fn stability_runs() -> usize {
    std::env::var("TUG_STABILITY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1)
}

/// Extract the `version` field from the first `system_metadata` event
/// in a probe's captured events, per [D11].
pub fn extract_version(captures: &[CapturedProbe]) -> Option<String> {
    for probe in captures {
        for event in &probe.events {
            if event_type_of(event) == Some("system_metadata") {
                if let Some(v) = event.get("version").and_then(|v| v.as_str()) {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Drive one probe against a fresh tugcast subprocess. Returns the
/// collected normalized events plus the probe status.
pub async fn execute_probe(
    probe: &ProbeRecord,
    bank_path: PathBuf,
    project_dir: &std::path::Path,
) -> CapturedProbe {
    // Known-bug skip gate — probes with a `skip_reason` pointer at
    // a dev.md §T0.5 follow-up bypass execution entirely. This is
    // how blocked-on-upstream-bug probes stay in the fixture catalog
    // (with an explicit `skipped` status + reason in manifest.json)
    // without corrupting the baseline with half-captured events.
    if let Some(reason) = probe.skip_reason {
        return CapturedProbe {
            name: probe.name.to_string(),
            events: Vec::new(),
            status: ProbeStatus::Skipped(reason),
            runtime_ms: 0,
        };
    }

    // Prerequisite gate — capture-time skip per [D10].
    for pre in probe.prerequisites {
        match pre {
            ProbePrereq::TugplugPluginLoaded => {
                // The harness points tugcode's `--plugin-dir` at
                // `<project_dir>/tugplug/` via the `TUG_PLUGIN_DIR`
                // override set in `TestTugcast::spawn` (tugcode no longer
                // falls back to a per-project path — it resolves the
                // override first, else a bundled app-resource path absent
                // in the dev tree). The prerequisite is met iff that
                // directory actually exists on disk — true when
                // `project_dir` is the tugtool repo root (the capture
                // binary case), false for a crate-level cwd (the
                // multi_session_real_claude case). Checking on disk keeps
                // the probe table environment-agnostic.
                if !project_dir.join("tugplug").is_dir() {
                    return CapturedProbe {
                        name: probe.name.to_string(),
                        events: Vec::new(),
                        status: ProbeStatus::Skipped("tugplug plugin not loaded"),
                        runtime_ms: 0,
                    };
                }
            }
            ProbePrereq::DenialCapableTool => {
                // Default spawn is acceptEdits mode; reads to paths
                // outside the project root still trigger the permission
                // gate, so this prerequisite is considered satisfied.
            }
        }
    }

    let start = Instant::now();

    let tugcast = TestTugcast::spawn(project_dir, bank_path).await;
    let mut ws = TestWs::connect(tugcast.port).await;

    let card_id = format!("probe-{}", probe.name);
    // claude 2.1.x rejects non-UUID --session-id values; the probe name
    // rides through logs via `card_id`, so a raw UUID here costs no
    // debuggability. See `fresh_session_id` for the full rationale.
    let tug_session_id = crate::common::fresh_session_id();
    ws.send_spawn_session(&card_id, &tug_session_id, project_dir)
        .await;

    // Wait for the pending confirmation only. The router's state
    // machine is Pending → Spawning → Live, and the transition out of
    // Pending requires the first UserMessage to arrive — waiting for
    // `live` here would deadlock forever since we haven't sent anything
    // yet. The input_script below sends the first message which drives
    // the spawn, and `collect_code_output` at the end naturally waits
    // for the real events to arrive.
    if let Err(e) = ws
        .await_session_state(&tug_session_id, "pending", Duration::from_secs(10))
        .await
    {
        return CapturedProbe {
            name: probe.name.to_string(),
            events: Vec::new(),
            status: ProbeStatus::Failed(format!("session never reached pending: {e}")),
            runtime_ms: start.elapsed().as_millis(),
        };
    }

    // Drive the input script.
    //
    // `request_id_by_tool_use_id` is the correlation store for the
    // permission / AskUserQuestion flow: every `control_request_forward`
    // we observe during `WaitForEvent` carries its own `request_id`
    // and — when the forward is gating a tool call — a `tool_use_id`
    // pointing back at the preceding `tool_use` event. Stashing both
    // lets a future probe answer a specific forward by tool_use_id
    // rather than "whichever was most recent".
    //
    // `most_recent_request_id` is the fallback used by the current
    // `ToolApproval` / `QuestionAnswer` variants, which don't yet
    // specify which forward to answer. When a probe eventually needs
    // targeted correlation, the variant can grow a `target_tool_use_id`
    // field and `execute_probe` will look it up in the map.
    let mut request_id_by_tool_use_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut most_recent_request_id: Option<String> = None;
    // `/rewind` anchor captured at runtime from a `prompt_anchor`
    // CODE_OUTPUT event ([#step-7-1]) — the `promptUuid` the subsequent
    // `RewindPreview` / `SessionRewind` messages target. Same
    // capture-from-a-waited-event pattern as `most_recent_request_id`.
    let mut captured_prompt_uuid: Option<String> = None;
    for msg in probe.input_script {
        match msg {
            ProbeMsg::UserMessage { text } => {
                ws.send_code_input(&tug_session_id, text).await;
            }
            ProbeMsg::UserMessageWithAttachments { text, attachments } => {
                let attachment_values: Vec<Value> = attachments
                    .iter()
                    .map(|a| {
                        json!({
                            "filename": a.filename,
                            "content": a.content,
                            "media_type": a.media_type,
                        })
                    })
                    .collect();
                ws.send_user_message_with_attachments(&tug_session_id, text, attachment_values)
                    .await;
            }
            ProbeMsg::Interrupt => ws.send_interrupt(&tug_session_id).await,
            ProbeMsg::ToolApproval { decision, message } => {
                let Some(rid) = most_recent_request_id.as_deref() else {
                    return CapturedProbe {
                        name: probe.name.to_string(),
                        events: Vec::new(),
                        status: ProbeStatus::Failed(
                            "tool_approval without prior control_request_forward".to_string(),
                        ),
                        runtime_ms: start.elapsed().as_millis(),
                    };
                };
                ws.send_tool_approval(&tug_session_id, rid, decision, None, *message)
                    .await;
            }
            ProbeMsg::QuestionAnswer { answers } => {
                let Some(rid) = most_recent_request_id.as_deref() else {
                    return CapturedProbe {
                        name: probe.name.to_string(),
                        events: Vec::new(),
                        status: ProbeStatus::Failed(
                            "question_answer without prior control_request_forward".to_string(),
                        ),
                        runtime_ms: start.elapsed().as_millis(),
                    };
                };
                let mut map = Map::new();
                for (k, v) in *answers {
                    map.insert((*k).to_string(), Value::String((*v).to_string()));
                }
                ws.send_question_answer(&tug_session_id, rid, Value::Object(map))
                    .await;
            }
            ProbeMsg::SessionCommand { command } => {
                ws.send_session_command(&tug_session_id, command).await;
            }
            ProbeMsg::ModelChange { model } => {
                ws.send_model_change(&tug_session_id, model).await;
            }
            ProbeMsg::PermissionMode { mode } => {
                ws.send_permission_mode(&tug_session_id, mode).await;
            }
            ProbeMsg::RewindPreview => {
                let Some(uuid) = captured_prompt_uuid.as_deref() else {
                    return CapturedProbe {
                        name: probe.name.to_string(),
                        events: Vec::new(),
                        status: ProbeStatus::Failed(
                            "rewind_preview without a prior prompt_anchor".to_string(),
                        ),
                        runtime_ms: start.elapsed().as_millis(),
                    };
                };
                ws.send_rewind_preview(&tug_session_id, uuid).await;
            }
            ProbeMsg::CaptureAnchor { max_secs } => {
                // Consume the next `prompt_anchor` so a later turn's anchor
                // can be targeted (the non-consuming `WaitForEvent` peek would
                // keep returning turn 1's). The matched frame is removed from
                // the buffer and thus omitted from the fixture.
                match ws
                    .await_code_output_event(
                        &tug_session_id,
                        "prompt_anchor",
                        Duration::from_secs(*max_secs),
                    )
                    .await
                {
                    Ok(payload) => {
                        if let Some(uuid) = payload.get("promptUuid").and_then(|v| v.as_str()) {
                            captured_prompt_uuid = Some(uuid.to_string());
                        }
                    }
                    Err(e) => {
                        return CapturedProbe {
                            name: probe.name.to_string(),
                            events: Vec::new(),
                            status: ProbeStatus::Failed(format!("capture_anchor failed: {e}")),
                            runtime_ms: start.elapsed().as_millis(),
                        };
                    }
                }
            }
            ProbeMsg::ConsumeEvent {
                event_type,
                max_secs,
            } => {
                // Consuming wait at a turn boundary (see `ConsumeEvent` doc):
                // removes the matched event so a later non-consuming
                // `WaitForEvent` gates on the NEXT turn's instance.
                if let Err(e) = ws
                    .await_code_output_event(
                        &tug_session_id,
                        event_type,
                        Duration::from_secs(*max_secs),
                    )
                    .await
                {
                    return CapturedProbe {
                        name: probe.name.to_string(),
                        events: Vec::new(),
                        status: ProbeStatus::Failed(format!("consume {event_type} failed: {e}")),
                        runtime_ms: start.elapsed().as_millis(),
                    };
                }
            }
            ProbeMsg::SessionRewind { scope, fork } => {
                let Some(uuid) = captured_prompt_uuid.as_deref() else {
                    return CapturedProbe {
                        name: probe.name.to_string(),
                        events: Vec::new(),
                        status: ProbeStatus::Failed(
                            "session_rewind without a prior prompt_anchor".to_string(),
                        ),
                        runtime_ms: start.elapsed().as_millis(),
                    };
                };
                ws.send_session_rewind(&tug_session_id, uuid, scope, *fork)
                    .await;
            }
            ProbeMsg::WaitForEvent {
                event_type,
                max_secs,
            } => {
                // Non-consuming peek: the waited-for event is part
                // of the fixture shape the collect pass records. An
                // `await_code_output_event` here would remove the
                // frame from the buffer, and `collect_code_output`
                // would never emit it — the captured JSONL would be
                // missing an event claude actually sent.
                match ws
                    .peek_code_output_event(
                        &tug_session_id,
                        event_type,
                        Duration::from_secs(*max_secs),
                    )
                    .await
                {
                    Ok(payload) => {
                        if *event_type == "control_request_forward" {
                            if let Some(rid) = payload.get("request_id").and_then(|v| v.as_str()) {
                                most_recent_request_id = Some(rid.to_string());
                                if let Some(tuid) =
                                    payload.get("tool_use_id").and_then(|v| v.as_str())
                                {
                                    request_id_by_tool_use_id
                                        .insert(tuid.to_string(), rid.to_string());
                                }
                            }
                        }
                        // `/rewind` anchor capture ([#step-7-1]): stash the
                        // `promptUuid` from a `prompt_anchor` so a later
                        // `RewindPreview` / `SessionRewind` can target it.
                        if *event_type == "prompt_anchor" {
                            if let Some(uuid) = payload.get("promptUuid").and_then(|v| v.as_str()) {
                                captured_prompt_uuid = Some(uuid.to_string());
                            }
                        }
                    }
                    Err(e) => {
                        return CapturedProbe {
                            name: probe.name.to_string(),
                            events: Vec::new(),
                            status: ProbeStatus::Failed(format!(
                                "wait for {event_type} failed: {e}"
                            )),
                            runtime_ms: start.elapsed().as_millis(),
                        };
                    }
                }
            }
            ProbeMsg::Sleep { millis } => sleep(Duration::from_millis(*millis)).await,
        }
    }

    // Collect events until the terminal event or timeout. The terminator
    // is `turn_complete` UNLESS the script's final message is a
    // `WaitForEvent`, in which case it is that event type — so a probe
    // that continues past its turn's `turn_complete` (the `/rewind`
    // round-trip ends on `rewind_result`, [#step-7-1]) captures the full
    // tail into the fixture instead of truncating at `turn_complete`.
    let terminator: &str = match probe.input_script.last() {
        Some(ProbeMsg::WaitForEvent { event_type, .. }) => event_type,
        _ => "turn_complete",
    };
    let events = match ws
        .collect_code_output_until_partial(
            &tug_session_id,
            terminator,
            Duration::from_secs(probe.timeout_secs),
        )
        .await
    {
        (mut events, None) => {
            for event in events.iter_mut() {
                normalize_event(event);
            }
            events
        }
        // The partial prefix stays OUT of `events` — a half-captured turn
        // must never reach the fixture writer. It rides in the reason
        // instead, which is what a human reads when the probe stalls: the
        // tail names where the stream stopped, and the count distinguishes
        // "the turn hung mid-stream" from "the session emitted nothing".
        (partial, Some(e)) => {
            return CapturedProbe {
                name: probe.name.to_string(),
                events: Vec::new(),
                status: ProbeStatus::Failed(format!(
                    "collect_code_output: {e} — {} event(s) before the stall, tail: {:?}",
                    partial.len(),
                    partial
                        .iter()
                        .rev()
                        .take(12)
                        .rev()
                        .filter_map(|e| event_type_of(e))
                        .collect::<Vec<_>>(),
                )),
                runtime_ms: start.elapsed().as_millis(),
            };
        }
    };

    // Validate required events present.
    let observed: BTreeSet<String> = events
        .iter()
        .filter_map(|e| event_type_of(e).map(String::from))
        .collect();
    let mut missing: Vec<&str> = Vec::new();
    for req in probe.required_events {
        if !observed.contains(*req) {
            missing.push(*req);
        }
    }

    let status = if missing.is_empty() {
        ProbeStatus::Passed
    } else {
        ProbeStatus::Failed(format!("missing required events: {missing:?}"))
    };

    drop(ws);
    drop(tugcast);

    CapturedProbe {
        name: probe.name.to_string(),
        events,
        status,
        runtime_ms: start.elapsed().as_millis(),
    }
}

/// Canonicalize an event list for shape-stability comparison:
/// collapse consecutive duplicates.
///
/// Claude's streaming protocol emits a **variable** number of
/// `assistant_text` and `thinking_text` partials per turn — count
/// depends on token batching, network flushing, and LLM-side chunk
/// boundaries, all of which are non-deterministic run-to-run. The
/// *shape* of the event sequence is defined by the ordering of
/// distinct event types, not the count. Two runs where one emits 8
/// `assistant_text` partials and the other 10 are the same shape.
///
/// Collapsing consecutive duplicates preserves genuine ordering
/// drift (`[a, b, c]` vs `[a, x, b, c]` still compares unequal)
/// while erasing the benign count variance. `[a, a, a]` collapses
/// to `[a]`; `[a, b, a]` stays as `[a, b, a]`.
pub fn canonical_sequence(events: &[Value]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for event in events {
        if let Some(et) = event_type_of(event) {
            if out.last().copied() != Some(et) {
                out.push(et);
            }
        }
    }
    out
}

/// Canonicalize an already-derived type sequence. Collapses consecutive
/// duplicates, same semantics as [`canonical_sequence`] but operating on
/// the string sequence stored in `Schema::probe_sequences`.
pub fn canonical_type_sequence(types: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in types {
        if out.last().map(String::as_str) != Some(t.as_str()) {
            out.push(t.clone());
        }
    }
    out
}

/// Event types whose *position* in a probe's sequence is not
/// reducer-relevant: status / accounting frames the transport flushes
/// at non-deterministic points. [`shape_sequence`] drops them before
/// the order comparison. Their existence and field shape are still
/// pinned — by the event-type *set* comparison in `diff_probe_sequence`
/// and by the per-event-type schema — so dropping them here loses
/// nothing.
///
/// - `streaming_usage`: per-message token-usage flushes, position
///   varies with transport batching; the reducer reads them by
///   recency, not by position.
/// - `rate_limit_event`: subscription-quota broadcast claude 2.1.x
///   emits once per turn alongside the first stream events. Its
///   interleaving relative to `content_block_start` / `assistant_text`
///   is non-deterministic across runs of the same probe (empirically
///   surfaced as `ReorderedSequence` FAILs in test-14 / test-19 /
///   test-22 against v2.1.154). The consumer (`SessionMetadataStore`
///   adjacent) reads it by recency for quota chrome, not by position.
/// - `prompt_anchor`: the `/rewind` anchor for the live turn
///   ([#step-7-1]). tugcode emits it from claude's user-echo event,
///   which races the first assistant stream events — so its position
///   relative to `content_block_start` / `assistant_text` is
///   non-deterministic run-to-run (empirically: `ReorderedSequence`
///   FAILs in test-14 / test-23, `OptionalSequenceVariance` in
///   test-05 / test-09 / test-11 / test-22 against v2.1.158 — the same
///   class as `rate_limit_event`). The consumer (`CodeSessionStore`,
///   [#step-7-3]) attaches `promptUuid` to the active pending turn
///   regardless of where the frame lands, never by position.
pub const INTERSTITIAL_EVENT_TYPES: &[&str] =
    &["streaming_usage", "rate_limit_event", "prompt_anchor"];

/// Event types that constitute a tool-call cycle. [`shape_sequence`]
/// collapses a contiguous run of these to a single
/// [`TOOL_ACTIVITY_MARKER`]: how many tool calls the agent made,
/// whether it batched them in parallel, and how their
/// `tool_use` / `tool_result` / `tool_use_structured` events
/// interleave is agent non-determinism, not protocol shape —
/// `CodeSessionStore` pairs those events by `tool_use_id`, never by
/// sequence position.
pub const TOOL_ACTIVITY_EVENT_TYPES: &[&str] = &["tool_use", "tool_result", "tool_use_structured"];

/// The single token a contiguous tool-activity run reduces to in
/// [`shape_sequence`].
pub const TOOL_ACTIVITY_MARKER: &str = "tool_activity";

/// Event types that, when interleaved WITHIN a tool-using turn body,
/// fold into its [`TOOL_ACTIVITY_MARKER`]. An agent — especially a
/// subagent — chooses freely whether to narrate (`assistant_text`)
/// before, between, or after its tool calls, and each block (text or
/// tool) opens with a `content_block_start`; that interleaving is model
/// non-determinism, not protocol shape (`test-22-subagent-spawn`
/// captured one order and the next run produced another). [`shape_sequence`]
/// therefore collapses a contiguous run of {these ∪ tool-activity} that
/// contains at least one tool call to a single marker. A run with NO
/// tool call (a pure-text turn) is preserved, so a real text→tool or
/// `cost_update`→`assistant_text` transposition still surfaces.
pub const TOOL_BODY_FILLER_EVENT_TYPES: &[&str] = &["assistant_text", "content_block_start"];

/// Event types whose *presence* is per-turn model behavior, not a
/// protocol contract — so BOTH their appearance and their absence in a
/// given capture are run-to-run variance, not drift. The differ is
/// fully transparent to them: it strips them from every probe-sequence
/// comparison (no `RemovedSequenceSlots`, `NewSequenceSlots`,
/// `OptionalSequenceVariance`, or `ReorderedSequence` ever originates
/// from them) and never raises `MissingEventType` / `NewEventType` for
/// them at the event-type level. Their *field shape*, when a capture
/// does carry them, is still pinned by `diff_event_shape` (the shape
/// diff runs whenever both golden and current have the type).
///
/// This symmetry is the point: a WARN that fires on inherent,
/// never-stabilizing nondeterminism is noise, not signal — it can't be
/// "resolved by a refresh" because the next capture is equally likely
/// to flip. Pinning the shape (not the presence) is the right contract.
///
/// - `thinking_text`: extended-thinking deltas. Claude chooses whether
///   to think per turn; short or simple prompts often elicit none, and
///   the choice flips run-to-run on the same prompt. The probe table
///   also lists it in every probe's `optional_events` for capture-time
///   stability checks; this constant is the differ's counterpart.
/// - `task_progress`: background-agent progress heartbeats. A subagent
///   emits one per observable step, so the COUNT is inherently variable
///   (a fast step elides it, a slow one repeats it), and the frame fires
///   for FOREGROUND subagents too — the wire carries no backgrounded
///   discriminant, so e.g. `test-22-subagent-spawn` captures a
///   `task_progress` on one run and none the next. Its add/remove is
///   therefore benign variance. Where its PRESENCE is load-bearing (the
///   background-agent lifecycle probe) it is pinned the right way — via
///   that probe's `required_events` at capture time — not via the drift
///   sequence comparison.
/// - `tool_progress`: the engine's heartbeat for a running tool call,
///   which tugcode forwards so the deck can tick the running block's
///   clock. The engine emits one roughly per second of a tool's run, so
///   whether a probe's Bash call runs long enough to produce any — and how
///   many — is timing, not protocol. A capture that carries one and a
///   capture that does not are the same contract.
pub const MODEL_OPTIONAL_EVENT_TYPES: &[&str] =
    &["thinking_text", "task_progress", "tool_progress"];

/// Reduce a probe's event-type sequence to its **order-comparison
/// shape**: drop position-insensitive interstitial events
/// ([`INTERSTITIAL_EVENT_TYPES`]), collapse each contiguous
/// tool-activity run ([`TOOL_ACTIVITY_EVENT_TYPES`]) to one
/// [`TOOL_ACTIVITY_MARKER`], and collapse consecutive duplicates.
///
/// This is the order-sensitive complement to the event-type *set*
/// check in `diff_probe_sequence`. The set check pins *which* event
/// types a probe emits — a vanished or new type still fails or warns.
/// This reduction pins their *order* while tolerating the two large
/// sources of run-to-run non-determinism: variable streaming-partial
/// and usage-frame counts, and variable tool-call counts. A genuine
/// transposition — `cost_update` moving before `assistant_text`, say —
/// still surfaces as a difference between two reduced sequences.
///
/// Generalizes [`canonical_type_sequence`]'s consecutive-duplicate
/// collapse: where that erases a variable `assistant_text` *partial*
/// count, this additionally erases a variable tool-call *cycle* count
/// and usage-frame interleaving.
pub fn shape_sequence(types: &[String]) -> Vec<String> {
    // Pass 1: drop interstitials; map each tool-activity type to the
    // marker, leave everything else as its raw type.
    let toks: Vec<&str> = types
        .iter()
        .map(String::as_str)
        .filter(|t| !INTERSTITIAL_EVENT_TYPES.contains(t))
        .map(|t| {
            if TOOL_ACTIVITY_EVENT_TYPES.contains(&t) {
                TOOL_ACTIVITY_MARKER
            } else {
                t
            }
        })
        .collect();

    // Pass 2: collapse each contiguous "tool-using turn body" run — a
    // maximal span of {tool_activity ∪ TOOL_BODY_FILLER} that contains
    // at least one tool_activity — to a single marker, erasing the
    // model's narrate-vs-tool ordering. A filler-only run (a pure-text
    // turn) is preserved as its own tokens. Non-body tokens
    // (`session_init`, `task_started`, `cost_update`, `turn_complete`, …)
    // pass through, so a genuine skeleton transposition still surfaces.
    let is_body = |t: &str| t == TOOL_ACTIVITY_MARKER || TOOL_BODY_FILLER_EVENT_TYPES.contains(&t);
    let mut out: Vec<String> = Vec::new();
    let push = |out: &mut Vec<String>, tok: &str| {
        if out.last().map(String::as_str) != Some(tok) {
            out.push(tok.to_string());
        }
    };
    let mut i = 0;
    while i < toks.len() {
        if is_body(toks[i]) {
            let start = i;
            let mut has_tool = false;
            while i < toks.len() && is_body(toks[i]) {
                has_tool |= toks[i] == TOOL_ACTIVITY_MARKER;
                i += 1;
            }
            if has_tool {
                push(&mut out, TOOL_ACTIVITY_MARKER);
            } else {
                for &t in &toks[start..i] {
                    push(&mut out, t);
                }
            }
        } else {
            push(&mut out, toks[i]);
            i += 1;
        }
    }
    out
}

/// Compare the first stability run against the rest. Returns a
/// diagnostic string if any subsequent run's **shape sequence** (see
/// [`shape_sequence`]) differs from the first, otherwise `None`.
///
/// The comparison is on the shape reduction, not the raw sequence, so
/// a probe whose only run-to-run variance is streaming-partial count,
/// usage-frame interleaving, or tool-call count is *stable* — it does
/// not flap to `ShapeUnstable`. Genuine shape divergence across runs
/// still surfaces.
///
/// Extracted as a pure helper so the shape-comparison logic is
/// unit-testable without driving real claude.
pub fn stability_outcome(first: &CapturedProbe, rest: &[CapturedProbe]) -> Option<String> {
    if rest.is_empty() {
        return None;
    }
    let shape_of = |probe: &CapturedProbe| -> Vec<String> {
        shape_sequence(
            &probe
                .events
                .iter()
                .filter_map(event_type_of)
                .map(str::to_string)
                .collect::<Vec<_>>(),
        )
    };
    let first_seq = shape_of(first);
    for (idx, run) in rest.iter().enumerate() {
        let seq = shape_of(run);
        if seq != first_seq {
            return Some(format!(
                "event-type shape sequence differs at stability run {}/{} for {}: \
                 first={:?}, run={:?}",
                idx + 2,
                rest.len() + 1,
                first.name,
                first_seq,
                seq,
            ));
        }
    }
    None
}

/// Stability-check wrapper: runs each probe `n` times and verifies
/// that the normalized event-type sequence is identical across runs.
/// If [`stability_outcome`] reports divergence, the probe's status is
/// replaced with [`ProbeStatus::ShapeUnstable`] carrying the diagnostic
/// and the first run's events remain as the stored capture. Otherwise
/// the first run is pushed unchanged.
pub async fn capture_with_stability(
    n: usize,
    bank_dir: &std::path::Path,
    project_dir: &std::path::Path,
) -> Vec<CapturedProbe> {
    use crate::common::probes::PROBES;

    // `TUG_PROBE_FILTER` (substring match on probe name) narrows the run to a
    // single probe (or a few) for fast de-risking of a new probe without the
    // full ~5-minute suite. `capture_all_probes` REFUSES to overwrite the
    // committed golden when a filter is active (a partial run would corrupt
    // the manifest/schema) — it captures + prints + returns. Unset → full run.
    let filter = std::env::var("TUG_PROBE_FILTER")
        .ok()
        .filter(|s| !s.is_empty());
    let selected: Vec<&ProbeRecord> = match &filter {
        Some(f) => PROBES
            .iter()
            .filter(|p| p.name.contains(f.as_str()))
            .collect(),
        None => PROBES.iter().collect(),
    };

    let total_probes = selected.len();
    if let Some(f) = &filter {
        println!(
            "[capture] TUG_PROBE_FILTER={f} → {total_probes} of {} probes",
            PROBES.len()
        );
    }
    println!(
        "[capture] starting — {total_probes} probes × {n} stability run(s) = {} total invocations",
        total_probes * n
    );
    let overall_start = std::time::Instant::now();

    let mut results: Vec<CapturedProbe> = Vec::with_capacity(total_probes);
    for (i, probe) in selected.into_iter().enumerate() {
        let probe_start = std::time::Instant::now();
        println!(
            "[capture] [{idx}/{total}] {name} — starting",
            idx = i + 1,
            total = total_probes,
            name = probe.name,
        );
        let mut runs: Vec<CapturedProbe> = Vec::with_capacity(n);
        for run_idx in 0..n {
            let bank = bank_dir.join(format!("probe-{i}-run-{run_idx}.db"));
            let run_start = std::time::Instant::now();
            let captured = execute_probe(probe, bank, project_dir).await;
            let tag = match &captured.status {
                ProbeStatus::Passed => "ok",
                ProbeStatus::Skipped(_) => "skip",
                ProbeStatus::Failed(_) => "FAIL",
                ProbeStatus::ShapeUnstable(_) => "unstable",
            };
            println!(
                "[capture]   run {r}/{n}: {tag} ({ms} ms, {ev} events)",
                r = run_idx + 1,
                n = n,
                ms = run_start.elapsed().as_millis(),
                ev = captured.events.len(),
            );
            // A failure's reason is the whole diagnosis — without it the log
            // says only that a probe produced no events, which reads as a
            // dead session no matter which way it actually died.
            if let ProbeStatus::Failed(reason) = &captured.status {
                println!("[capture]     reason: {reason}");
            }
            runs.push(captured);
        }
        let first = runs.remove(0);
        let capture = match stability_outcome(&first, &runs) {
            Some(diagnostic) => CapturedProbe {
                name: first.name.clone(),
                events: first.events,
                status: ProbeStatus::ShapeUnstable(diagnostic),
                runtime_ms: first.runtime_ms,
            },
            None => first,
        };
        println!(
            "[capture] [{idx}/{total}] {name} — done in {ms} ms (elapsed {elapsed}s)",
            idx = i + 1,
            total = total_probes,
            name = probe.name,
            ms = probe_start.elapsed().as_millis(),
            elapsed = overall_start.elapsed().as_secs(),
        );
        results.push(capture);
    }
    println!(
        "[capture] done — {total_probes} probes in {elapsed}s",
        elapsed = overall_start.elapsed().as_secs(),
    );
    results
}

// -----------------------------------------------------------------------
// Capabilities snapshot extraction (D6.a)
// -----------------------------------------------------------------------

/// Name of the probe that carries the canonical `system_metadata` event
/// we want to expose to Tug.app / tugdeck via the `capabilities/` tree.
pub const CAPABILITIES_PROBE_NAME: &str = "test-28-system-metadata-deep-dive";

/// Extract the single `system_metadata` line from the given probe JSONL
/// and write it (verbatim, still normalized) to
/// `capabilities_dir/<version>/system-metadata.jsonl`, then update
/// `capabilities_dir/LATEST` to `<version>\n`.
///
/// Called from the real-claude capture binary after `write_fixtures` so
/// the version-bump runbook is a single operation. Also callable
/// directly with an existing catalog fixture dir to re-derive the
/// artifact without re-running probes.
///
/// Fails fast if the source probe file is missing or contains no
/// `system_metadata` event. The returned path points at the newly
/// written snapshot file.
pub fn extract_capabilities(
    probe28_jsonl: &std::path::Path,
    capabilities_dir: &std::path::Path,
    version: &str,
) -> std::io::Result<PathBuf> {
    use std::io::{BufRead, Write};

    let file = std::fs::File::open(probe28_jsonl).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!(
                "extract_capabilities: cannot open {}: {e}",
                probe28_jsonl.display()
            ),
        )
    })?;

    // Pick the RICHEST system_metadata event, not the first. As of
    // claude 2.1.197 the probe stream carries an empty leading
    // system_metadata scaffold (cwd / ipc_version / tug_session_id /
    // type only — tugcode's all-defaults emit ahead of the real init)
    // followed by the populated one (slash_commands / skills / tools /
    // …). The old "first match" grabbed the empty scaffold and shipped a
    // 0-command capabilities snapshot, breaking every downstream
    // consumer (e.g. tugdeck's system-metadata-fixture test). Top-level
    // key count is a stable richness proxy: the scaffold has ~4 keys,
    // the real init ~17.
    let mut found: Option<String> = None;
    let mut best_keys = 0usize;
    for line in std::io::BufReader::new(file).lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if event_type_of(&parsed) == Some("system_metadata") {
            let keys = parsed.as_object().map_or(0, |o| o.len());
            if found.is_none() || keys > best_keys {
                best_keys = keys;
                found = Some(trimmed.to_string());
            }
        }
    }

    let payload = found.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "extract_capabilities: no system_metadata event in {}",
                probe28_jsonl.display()
            ),
        )
    })?;

    let dest_dir = capabilities_dir.join(version);
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join("system-metadata.jsonl");
    let mut f = std::fs::File::create(&dest)?;
    f.write_all(payload.as_bytes())?;
    f.write_all(b"\n")?;

    let latest = capabilities_dir.join("LATEST");
    std::fs::write(&latest, format!("{version}\n"))?;

    Ok(dest)
}

// Helper: pull a sorted BTreeSet of string names from a JSON array field,
// accepting either bare strings or `{ "name": "..." }` objects (matches the
// SessionMetadataStore parser's tolerance).
fn names_of(payload: &Value, field: &str) -> BTreeSet<String> {
    payload
        .get(field)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    if let Some(s) = entry.as_str() {
                        Some(s.to_string())
                    } else {
                        entry.get("name").and_then(|n| n.as_str()).map(String::from)
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Human-readable summary of a one-line `system_metadata` payload: version,
/// model, permission_mode, and sorted lists of slash_commands / skills /
/// agents / plugins with counts. Used by the capture binary to report what
/// it just wrote into `capabilities/<ver>/system-metadata.jsonl`.
pub fn summarize_capabilities(snapshot_line: &str) -> String {
    let payload: Value = match serde_json::from_str(snapshot_line.trim()) {
        Ok(v) => v,
        Err(e) => return format!("  <failed to parse capabilities snapshot: {e}>\n"),
    };

    let mut out = String::new();
    let field_or = |field: &str| -> String {
        payload
            .get(field)
            .and_then(|v| v.as_str())
            .unwrap_or("<absent>")
            .to_string()
    };
    out.push_str(&format!("  version:         {}\n", field_or("version")));
    out.push_str(&format!("  model:           {}\n", field_or("model")));
    out.push_str(&format!(
        "  permission_mode: {}\n",
        field_or("permission_mode")
    ));

    for field in ["slash_commands", "skills", "agents", "plugins"] {
        let names = names_of(&payload, field);
        out.push_str(&format!("  {field} ({count})\n", count = names.len()));
        for name in &names {
            out.push_str(&format!("    - {name}\n"));
        }
    }
    out
}

/// Structured diff between two `system_metadata` snapshots. Reports lost /
/// gained entries for slash_commands, skills, agents, and plugins, plus
/// version/model/permission_mode changes when they differ. Returns an empty
/// string if the two payloads are byte-identical (no-op).
pub fn diff_capabilities(old_line: &str, new_line: &str) -> String {
    if old_line.trim() == new_line.trim() {
        return String::new();
    }
    let old: Value = match serde_json::from_str(old_line.trim()) {
        Ok(v) => v,
        Err(e) => return format!("  <failed to parse previous capabilities snapshot: {e}>\n"),
    };
    let new: Value = match serde_json::from_str(new_line.trim()) {
        Ok(v) => v,
        Err(e) => return format!("  <failed to parse new capabilities snapshot: {e}>\n"),
    };

    let mut out = String::new();

    for field in ["version", "model", "permission_mode"] {
        let o = old
            .get(field)
            .and_then(|v| v.as_str())
            .unwrap_or("<absent>");
        let n = new
            .get(field)
            .and_then(|v| v.as_str())
            .unwrap_or("<absent>");
        if o != n {
            out.push_str(&format!("  {field}: {o} → {n}\n"));
        }
    }

    for field in ["slash_commands", "skills", "agents", "plugins"] {
        let old_set = names_of(&old, field);
        let new_set = names_of(&new, field);
        let lost: Vec<&String> = old_set.difference(&new_set).collect();
        let gained: Vec<&String> = new_set.difference(&old_set).collect();
        if lost.is_empty() && gained.is_empty() {
            continue;
        }
        out.push_str(&format!(
            "  {field} (−{lost} +{gained})\n",
            lost = lost.len(),
            gained = gained.len(),
        ));
        for name in &lost {
            out.push_str(&format!("    - {name}\n"));
        }
        for name in &gained {
            out.push_str(&format!("    + {name}\n"));
        }
    }

    if out.is_empty() {
        out.push_str("  <no change in summarized fields>\n");
    }
    out
}
