//! payload_inspector — single-pass partial-shape parser for stream-json
//! payloads on the CODE_INPUT and CODE_OUTPUT feeds.
//!
//! The supervisor's dispatcher (`dispatch_one`) reads the derived
//! legacy-shape `text` + `attachments` view off every inbound
//! `user_message` to seed the submission journal row, and the merger
//! (`apply_outbound_turn_intercept`) reads only `msg_type` to decide
//! whether a frame is a `turn_complete` / `turn_cancelled` that should
//! pop the journal's oldest pending row. One `serde_json::from_slice`
//! reads everything both sites need.
//!
//! Post-Step-5c, inbound `user_message` payloads carry Anthropic-API
//! `content: ContentBlock[]` blocks; the legacy `text` + `attachments`
//! columns the journal still uses are **derived** via
//! [`derive_legacy_journal_view`] from the content blocks. Only the
//! never-drop synthetic emit path consumes the legacy view (the
//! JSONL-replay path operates on the raw blocks via tugcode), so the
//! lossy text-concat / image-attachment-reshape projection is the
//! gap-bridge cost — accepted.
//!
//! All fields are optional. A payload with no `type` (malformed,
//! truncated, or just a different shape than we expected) yields a
//! struct whose `msg_type` is `None`; the dispatcher treats that as
//! "pass through unchanged" and the merger treats it as "no-op".

// The inspector surface is authored ahead of the supervisor wiring
// that consumes it; suppress dead-code warnings for the public API
// until the dispatch + merger intercepts land. Same pattern
// `session_ledger.rs` and the rest of the crate use for phased rollouts.
#![allow(dead_code)]

use serde::Deserialize;

/// Partial-shape view into a CODE_INPUT or CODE_OUTPUT frame's JSON
/// payload. Fields are populated only if the payload carries them; a
/// missing or non-string value yields `None`. Constructed via
/// [`InspectedPayload::from_slice`]; the deserializer ignores any
/// other top-level fields the payload may carry, so adding a new
/// field to the wire format never breaks this struct's parse.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct InspectedPayload {
    /// Top-level `type` discriminator (e.g. `"user_message"`,
    /// `"turn_complete"`, `"turn_cancelled"`). `None` on a payload
    /// missing the field or a non-string value.
    #[serde(rename = "type", default)]
    pub msg_type: Option<String>,

    /// The session id tugcast spliced into the line
    /// (`splice_tug_session_id`) before the CODE_OUTPUT broadcast.
    /// `None` on inbound payloads and anything not yet spliced. The
    /// digest bridge keys its replay-mute set and per-scope forwarding
    /// on this.
    #[serde(default)]
    pub tug_session_id: Option<String>,

    /// `content` blocks on inbound `user_message` post-Step-5c. The
    /// dispatcher uses [`derive_legacy_journal_view`] to project this
    /// into the legacy `text` + `attachments` columns the journal
    /// stores. Stored as raw `Vec<serde_json::Value>` so the inspector
    /// is agnostic to the inner block shape (text / image / future
    /// block types).
    #[serde(default)]
    pub content: Option<Vec<serde_json::Value>>,

    /// Derived `text` field for the journal. Post-Step-5c this is no
    /// longer read directly off the payload; it's populated by
    /// [`derive_legacy_journal_view`] (run by the dispatcher) from
    /// `content`. The dispatcher persists this on the journal row.
    #[serde(default)]
    pub text: Option<String>,

    /// Derived `attachments` array for the journal. Post-Step-5c this
    /// is populated by [`derive_legacy_journal_view`] from the
    /// `content` blocks — each `image` block becomes a wire-Attachment
    /// JSON object (`filename: ""`, `media_type`, `content`). The
    /// dispatcher persists these onto the journal row as a JSON BLOB.
    #[serde(default)]
    pub attachments: Option<Vec<serde_json::Value>>,
}

impl InspectedPayload {
    /// Parse `payload` into an [`InspectedPayload`]. Returns `None`
    /// for malformed JSON; the supervisor treats that as "pass
    /// through unchanged" so a corrupted byte stream doesn't
    /// short-circuit the dispatch routing logic.
    ///
    /// On a successful parse with `msg_type == Some("user_message")`
    /// and `content` present, the legacy `text` + `attachments` view
    /// is populated via [`derive_legacy_journal_view`] before
    /// returning. Pre-5c payloads carrying raw `text` + `attachments`
    /// (e.g. wire-shape echoes from a non-upgraded source) keep the
    /// values they carry — the helper only fires when `content` is
    /// the source.
    pub fn from_slice(payload: &[u8]) -> Option<Self> {
        let mut inspected: Self = serde_json::from_slice(payload).ok()?;
        if inspected.msg_type.as_deref() == Some("user_message") {
            if let Some(blocks) = inspected.content.as_ref() {
                let (text, attachments) = derive_legacy_journal_view(blocks);
                inspected.text = Some(text);
                inspected.attachments = Some(attachments);
            }
        }
        Some(inspected)
    }

    /// Convenience: borrow the type discriminator as a `&str` so
    /// callers can pattern-match without a clone.
    pub fn msg_type(&self) -> Option<&str> {
        self.msg_type.as_deref()
    }
}

/// Project Anthropic-API content blocks into the journal's legacy
/// `(text, attachments)` shape.
///
/// - `text` is the concatenation of every `text` block's `text`
///   string in order. Block separators are not introduced; a
///   `text/image/text` interleaving becomes `text || text` in the
///   journal, losing the gap between them. Acceptable lossy
///   projection: the journal's only consumer is the never-drop
///   synthetic emit path (which fires on the rare gap between
///   submit-ack and JSONL-write), and that path doesn't need
///   interleaving fidelity.
/// - `attachments` is one wire-shape `Attachment` JSON object per
///   `image` block: `{filename: "", media_type, content}`. The
///   `filename` field is left blank — the journal layer has no
///   filename source post-Step-5c (the wire shape doesn't carry
///   filenames; the legacy JSONL-replay path also hardcoded
///   `filename: ""`).
///
/// Non-text, non-image blocks (e.g. future block types) are skipped
/// silently. Pure on inputs; no allocation beyond the output.
pub fn derive_legacy_journal_view(
    blocks: &[serde_json::Value],
) -> (String, Vec<serde_json::Value>) {
    let mut text = String::new();
    let mut attachments: Vec<serde_json::Value> = Vec::new();
    for block in blocks {
        let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if block_type == "text" {
            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                text.push_str(t);
            }
        } else if block_type == "image" {
            let source = block.get("source");
            let media_type = source
                .and_then(|s| s.get("media_type"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let data = source
                .and_then(|s| s.get("data"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            attachments.push(serde_json::json!({
                "filename": "",
                "content": data,
                "media_type": media_type,
            }));
        }
        // Any other block type is silently skipped — defensive against
        // future wire shapes.
    }
    (text, attachments)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── derive_legacy_journal_view — pure helper ────────────────────────────

    #[test]
    fn derive_legacy_text_only() {
        let blocks = vec![
            serde_json::json!({"type": "text", "text": "hello"}),
            serde_json::json!({"type": "text", "text": " world"}),
        ];
        let (text, atts) = derive_legacy_journal_view(&blocks);
        assert_eq!(text, "hello world");
        assert!(atts.is_empty());
    }

    #[test]
    fn derive_legacy_interleaved_text_image_text() {
        // `text/image/text` collapses to `text || text` for the
        // journal; the image becomes a wire-shape Attachment JSON
        // object with `filename: ""`.
        let blocks = vec![
            serde_json::json!({"type": "text", "text": "before "}),
            serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "iVBORw0KGgo=",
                },
            }),
            serde_json::json!({"type": "text", "text": " after"}),
        ];
        let (text, atts) = derive_legacy_journal_view(&blocks);
        assert_eq!(text, "before  after");
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0]["filename"], "");
        assert_eq!(atts[0]["media_type"], "image/png");
        assert_eq!(atts[0]["content"], "iVBORw0KGgo=");
    }

    #[test]
    fn derive_legacy_image_only() {
        let blocks = vec![serde_json::json!({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAA="},
        })];
        let (text, atts) = derive_legacy_journal_view(&blocks);
        assert_eq!(text, "");
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0]["media_type"], "image/jpeg");
    }

    #[test]
    fn derive_legacy_empty_blocks() {
        let (text, atts) = derive_legacy_journal_view(&[]);
        assert_eq!(text, "");
        assert!(atts.is_empty());
    }

    #[test]
    fn derive_legacy_skips_unknown_block_types() {
        // Defensive: a block type the inspector doesn't recognize is
        // silently dropped — no panic, no journal corruption.
        let blocks = vec![
            serde_json::json!({"type": "text", "text": "keep me"}),
            serde_json::json!({"type": "future_block", "data": "ignore"}),
        ];
        let (text, atts) = derive_legacy_journal_view(&blocks);
        assert_eq!(text, "keep me");
        assert!(atts.is_empty());
    }

    // ── round-trip across the three intercept-relevant message types ─────────

    #[test]
    fn inspects_user_message_with_content_blocks_derives_legacy_view() {
        let payload = br#"{
            "tug_session_id": "sess-abc",
            "type": "user_message",
            "content": [
                {"type": "text", "text": "describe "},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "PNG"}},
                {"type": "text", "text": " this"}
            ]
        }"#;
        let i = InspectedPayload::from_slice(payload).expect("parses");
        assert_eq!(i.msg_type(), Some("user_message"));
        // Derived legacy text concatenates text blocks (no image
        // separator); derived attachments carry one entry per image
        // block, `filename: ""`.
        assert_eq!(i.text.as_deref(), Some("describe  this"));
        let atts = i.attachments.as_deref().expect("attachments derived");
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0]["media_type"], "image/png");
        assert_eq!(atts[0]["content"], "PNG");
        assert_eq!(atts[0]["filename"], "");
    }

    #[test]
    fn inspects_turn_complete_msg_type_only() {
        // The merger only branches on `msg_type` post-Step-5.3; the
        // outbound payload's other fields are unread.
        let payload = br#"{
            "type": "turn_complete",
            "msg_id": "msg_01ABC",
            "seq": 3,
            "result": "",
            "ipc_version": 2
        }"#;
        let i = InspectedPayload::from_slice(payload).expect("parses");
        assert_eq!(i.msg_type(), Some("turn_complete"));
        // Inbound-only fields stay None on outbound payloads.
        assert_eq!(i.text, None);
        assert_eq!(i.attachments, None);
        assert_eq!(i.content, None);
    }

    #[test]
    fn inspects_turn_cancelled_msg_type_only() {
        let payload = br#"{
            "type": "turn_cancelled",
            "msg_id": "msg_01XYZ",
            "seq": 4,
            "partial_result": "so far the assistant said...",
            "ipc_version": 2
        }"#;
        let i = InspectedPayload::from_slice(payload).expect("parses");
        assert_eq!(i.msg_type(), Some("turn_cancelled"));
        assert_eq!(i.text, None);
        assert_eq!(i.attachments, None);
    }

    // ── unknown-type pass-through ────────────────────────────────────────────

    #[test]
    fn inspects_unknown_type_fields_are_none() {
        let payload = br#"{"type":"tool_approval","request_id":"r","decision":"allow"}"#;
        let i = InspectedPayload::from_slice(payload).expect("parses");
        assert_eq!(i.msg_type(), Some("tool_approval"));
        // None of the user_message fields apply.
        assert_eq!(i.text, None);
        assert_eq!(i.attachments, None);
        assert_eq!(i.content, None);
    }

    #[test]
    fn inspects_extra_unknown_fields_are_ignored() {
        // A future wire-shape addition (e.g. a new top-level field
        // tugcast doesn't yet know about) must not break the parse.
        let payload = br#"{
            "type": "user_message",
            "content": [{"type": "text", "text": "hi"}],
            "future_field": {"nested": 42}
        }"#;
        let i = InspectedPayload::from_slice(payload).expect("parses");
        assert_eq!(i.msg_type(), Some("user_message"));
        assert_eq!(i.text.as_deref(), Some("hi"));
    }

    // ── error paths return None, never panic ─────────────────────────────────

    #[test]
    fn malformed_json_returns_none() {
        assert_eq!(InspectedPayload::from_slice(b"not json"), None);
        assert_eq!(InspectedPayload::from_slice(b"{not even close"), None);
        assert_eq!(InspectedPayload::from_slice(b""), None);
    }

    #[test]
    fn non_string_type_field_yields_none_msg_type() {
        // serde rejects a non-string for `Option<String>`, so the
        // overall parse fails. The dispatcher treats `None` as
        // "pass through unchanged", which is what we want here.
        assert_eq!(InspectedPayload::from_slice(br#"{"type":42}"#), None);
    }

    #[test]
    fn payload_with_only_type_parses_with_other_fields_none() {
        let i = InspectedPayload::from_slice(br#"{"type":"user_message"}"#).expect("parses");
        assert_eq!(i.msg_type(), Some("user_message"));
        assert_eq!(i.text, None);
        assert_eq!(i.attachments, None);
        assert_eq!(i.content, None);
    }
}
