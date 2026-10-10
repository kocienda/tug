//! Pure-logic merge for `system_metadata` payloads.
//!
//! The supervisor bridge intercepts every outbound `system_metadata`
//! line and merges the incoming payload against the persisted one
//! before rewriting the wire. This module is the *rule*; the bridge is
//! the *trigger*; the `SessionLedger` is the *backing store*.
//!
//! See plan `#step-20-3-6` for the full design. The merge rule shape
//! is shared with `tugdeck/src/lib/session-metadata-store.ts`'s
//! retired in-memory version; this is the durable replacement.
//!
//! # Wire-format key reality
//!
//! The `system_metadata` JSON uses a mixed casing convention,
//! fixed by tugproto's `SystemMetadata` interface
//! (`tugproto/src/outbound.ts`) and emitted by tugcode's
//! `routeTopLevelEvent` (`event-mapping.ts`, the live `system/init`),
//! `emitInitialSessionCwd` (`session.ts`, the spawn-time `cwd`-only
//! frame), and `translateJsonlSession` (`replay.ts`, the resumed model):
//!
//! - **camelCase keys:** `permissionMode`, `apiKeySource`.
//! - **snake_case keys:** `session_id`, `cwd`, `tools`, `model`,
//!   `slash_commands`, `plugins`, `agents`, `skills`, `mcp_servers`,
//!   `version`, `output_style`, `fast_mode_state`, `ipc_version`.
//!
//! All key constants below use the on-wire names verbatim — using the
//! wrong case silently no-ops the merge on that field.
//! `keys_match_the_tugproto_interface` holds them to the interface.

use serde_json::{Map, Value};

/// JSON key names used in `system_metadata` payloads. Centralized so
/// the merge code is the one place that knows the exact wire vocabulary
/// — adding a new Anthropic field is one constant + one entry in
/// `SCALAR_FIELDS` or `ARRAY_FIELDS`.
mod keys {
    pub const TYPE: &str = "type";
    pub const SESSION_ID: &str = "session_id";
    pub const MODEL: &str = "model";
    pub const IPC_VERSION: &str = "ipc_version";

    // Scalar string fields: take incoming if non-empty, else keep
    // current. The empty-string-treated-as-absent rule defends against
    // the replay path's synthesized payload, which sets every scalar to
    // "" rather than omitting it.
    pub const CWD: &str = "cwd";
    pub const PERMISSION_MODE: &str = "permissionMode";
    pub const OUTPUT_STYLE: &str = "output_style";
    pub const FAST_MODE_STATE: &str = "fast_mode_state";
    pub const API_KEY_SOURCE: &str = "apiKeySource";
    pub const VERSION: &str = "version";

    // Array fields: take incoming if non-empty, else keep current.
    pub const TOOLS: &str = "tools";
    pub const SLASH_COMMANDS: &str = "slash_commands";
    pub const PLUGINS: &str = "plugins";
    pub const AGENTS: &str = "agents";
    pub const SKILLS: &str = "skills";
    pub const MCP_SERVERS: &str = "mcp_servers";
}

const SCALAR_FIELDS: &[&str] = &[
    keys::CWD,
    keys::PERMISSION_MODE,
    keys::OUTPUT_STYLE,
    keys::FAST_MODE_STATE,
    keys::API_KEY_SOURCE,
    keys::VERSION,
];

const ARRAY_FIELDS: &[&str] = &[
    keys::TOOLS,
    keys::SLASH_COMMANDS,
    keys::PLUGINS,
    keys::AGENTS,
    keys::SKILLS,
    keys::MCP_SERVERS,
];

/// Merge `incoming` over `current`, preferring the more-informationally-
/// rich value per field. Returns the merged payload as a fresh
/// `Map<String, Value>` ready to be wrapped in `Value::Object`.
///
/// When `current` is `None` (first-observation case) the function
/// returns `incoming` verbatim — the merge has no baseline to consult,
/// so the incoming payload is the only signal.
///
/// The merge rules per field:
/// - `model` → [`prefer_more_specific_model`] (preserves the `[1m]`
///   suffix across resume).
/// - Scalar string fields → [`as_present`]; empty string is treated as
///   absent.
/// - Array fields → non-empty incoming wins, otherwise current is kept.
/// - `session_id`, `ipc_version`, `type` → pass through from incoming
///   (PK + wire housekeeping; never merged).
///
/// Any field present in `current` but missing from both the per-field
/// rule list and `incoming` is preserved verbatim — future Anthropic
/// fields land here without code changes.
pub fn merge_session_metadata(current: Option<&Value>, incoming: &Value) -> Map<String, Value> {
    let Some(incoming_obj) = incoming.as_object() else {
        // Defensive: an incoming non-object is malformed wire. Surface
        // an empty object so the caller can decide whether to forward.
        return Map::new();
    };

    let Some(current_obj) = current.and_then(|v| v.as_object()) else {
        // First-observation: take incoming verbatim.
        return incoming_obj.clone();
    };

    // Start from incoming so PK + wire housekeeping + any
    // unknown-future fields ride through unchanged.
    let mut merged = incoming_obj.clone();

    // model — suffix-preserving merge.
    let current_model = current_obj.get(keys::MODEL).and_then(|v| v.as_str());
    let incoming_model = incoming_obj.get(keys::MODEL).and_then(|v| v.as_str());
    if let Some(chosen) = prefer_more_specific_model(current_model, incoming_model) {
        merged.insert(keys::MODEL.to_owned(), Value::String(chosen.to_owned()));
    }

    // Scalar string fields — empty-string-treated-as-absent.
    for field in SCALAR_FIELDS {
        let incoming_v = incoming_obj.get(*field).and_then(|v| v.as_str());
        let current_v = current_obj.get(*field).and_then(|v| v.as_str());
        match (as_present(incoming_v), as_present(current_v)) {
            (Some(v), _) => {
                merged.insert((*field).to_owned(), Value::String(v.to_owned()));
            }
            (None, Some(v)) => {
                merged.insert((*field).to_owned(), Value::String(v.to_owned()));
            }
            (None, None) => {
                // Neither has a present value. Leave whatever incoming
                // had (empty-string or missing) in place.
            }
        }
    }

    // Array fields — non-empty incoming wins, else keep current.
    for field in ARRAY_FIELDS {
        let incoming_arr = incoming_obj.get(*field).and_then(|v| v.as_array());
        let incoming_nonempty = incoming_arr.is_some_and(|a| !a.is_empty());
        if !incoming_nonempty && let Some(current_v) = current_obj.get(*field) {
            merged.insert((*field).to_owned(), current_v.clone());
        }
    }

    // Future-field preservation: any key in `current` that the rule
    // list doesn't name AND that `incoming` doesn't carry should
    // survive the merge. The merge starts from `incoming`, so we only
    // need to copy missing keys.
    for (key, value) in current_obj.iter() {
        if !merged.contains_key(key) {
            merged.insert(key.clone(), value.clone());
        }
    }

    // PK + wire housekeeping — always taken from incoming. These are
    // already present in `merged` (we cloned `incoming_obj`), so this
    // is a no-op enforcement of the contract; explicit for the reader.
    if let Some(v) = incoming_obj.get(keys::SESSION_ID) {
        merged.insert(keys::SESSION_ID.to_owned(), v.clone());
    }
    if let Some(v) = incoming_obj.get(keys::IPC_VERSION) {
        merged.insert(keys::IPC_VERSION.to_owned(), v.clone());
    }
    if let Some(v) = incoming_obj.get(keys::TYPE) {
        merged.insert(keys::TYPE.to_owned(), v.clone());
    }

    merged
}

/// Empty-string-treated-as-absent. Returns `None` for `None`, `Some("")`,
/// and `Some(s)` only when `s` is non-empty.
fn as_present(s: Option<&str>) -> Option<&str> {
    match s {
        Some(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

/// Pick the more-specific model name between the persisted and incoming
/// values. Defends against the resume-replay regression where Claude
/// emits the suffixed model (e.g. `claude-opus-4-7[1m]`) on live
/// `system_init` but records the bare name (`claude-opus-4-7`) on every
/// `assistant.message.model` field in JSONL — the replay path synthesizes
/// `system_metadata` from the JSONL bare name, which would otherwise
/// overwrite the live suffixed value and downgrade the window-utilization
/// gauge from 1M → 200k.
///
/// Rules:
/// - either side empty/None → take the non-empty one
/// - exact match → take incoming (no-op)
/// - `current == incoming + "[1m]"` → keep current (no downgrade)
/// - `incoming == current + "[1m]"` → take incoming (upgrade)
/// - otherwise (genuine model change) → take incoming
///
/// The `[1m]` suffix is a Claude Code CLI convention, not an Anthropic
/// API contract. If Anthropic changes the format (`[ctx-1m]`, `(1M)`,
/// a separate `context_window` field, etc.), the literal-string check
/// silently fails over to "take incoming" and the regression returns.
/// Mitigation: re-vet this rule when bumping the Claude Code SDK or
/// when CI fixtures show a model-name format change.
pub fn prefer_more_specific_model<'a>(
    current: Option<&'a str>,
    incoming: Option<&'a str>,
) -> Option<&'a str> {
    match (as_present(current), as_present(incoming)) {
        (None, None) => None,
        (Some(c), None) => Some(c),
        (None, Some(i)) => Some(i),
        (Some(c), Some(i)) if c == i => Some(i),
        (Some(c), Some(i)) if c == format!("{i}[1m]") => Some(c),
        (Some(c), Some(i)) if i == format!("{c}[1m]") => Some(i),
        (Some(_), Some(i)) => Some(i),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn live_payload() -> Value {
        // Mirror what tugcode's `routeTopLevelEvent` emits on a live
        // `system/init` — rich payload, suffixed model.
        json!({
            "type": "system_metadata",
            "session_id": "sess-1",
            "cwd": "/home/user/project",
            "tools": ["Read", "Bash"],
            "model": "claude-opus-4-7[1m]",
            "permissionMode": "default",
            "slash_commands": ["help", "context"],
            "plugins": ["tugplug"],
            "agents": ["claude"],
            "skills": ["tugplug:plan"],
            "mcp_servers": ["fs"],
            "version": "2.1.105",
            "output_style": "default",
            "fast_mode_state": "off",
            "apiKeySource": "anthropic",
            "ipc_version": 2,
        })
    }

    fn replay_payload() -> Value {
        // Mirror what tugcode's `translateJsonlSession` synthesizes on
        // resume — bare model, every other scalar empty, every array
        // empty. This is the exact shape that without this merge would
        // clobber the live values.
        json!({
            "type": "system_metadata",
            "session_id": "sess-1",
            "cwd": "",
            "tools": [],
            "model": "claude-opus-4-7",
            "permissionMode": "",
            "slash_commands": [],
            "plugins": [],
            "agents": [],
            "skills": [],
            "mcp_servers": [],
            "version": "",
            "output_style": "",
            "fast_mode_state": "",
            "apiKeySource": "",
            "ipc_version": 2,
        })
    }

    // ---- merge_session_metadata --------------------------------------

    /// Every key the merge names, whether it merges it or passes it through.
    fn merged_keys() -> std::collections::BTreeSet<&'static str> {
        [keys::TYPE, keys::SESSION_ID, keys::MODEL, keys::IPC_VERSION]
            .into_iter()
            .chain(SCALAR_FIELDS.iter().copied())
            .chain(ARRAY_FIELDS.iter().copied())
            .collect()
    }

    /// The fields of `SystemMetadata` in `tugproto/src/outbound.ts`, read as
    /// text, each with whether its type is an array.
    fn tugproto_fields() -> Vec<(String, bool)> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tugproto/src/outbound.ts");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let start = source
            .find("export interface SystemMetadata {")
            .expect("outbound.ts declares SystemMetadata");
        let body = &source[start..];
        let body = &body[body.find('{').unwrap() + 1..body.find("\n}").unwrap()];
        body.lines()
            .filter_map(|line| {
                let line = line.trim();
                // Line and block comments, JSDoc included: a `* Note: …`
                // line would otherwise read as a field named `* Note`.
                if line.starts_with("//") || line.starts_with("/*") || line.starts_with('*') {
                    return None;
                }
                let (name, ty) = line.split_once(':')?;
                let name = name.trim_end_matches('?');
                Some((name.to_owned(), ty.trim().ends_with("[];")))
            })
            .collect()
    }

    #[test]
    fn keys_match_the_tugproto_interface() {
        let fields = tugproto_fields();
        assert!(!fields.is_empty(), "no fields read from SystemMetadata");
        let interface: std::collections::BTreeSet<&str> =
            fields.iter().map(|(name, _)| name.as_str()).collect();
        let merged = merged_keys();
        assert_eq!(
            merged, interface,
            "session_metadata_merge.rs keys and tugproto SystemMetadata disagree.\n  merge keys: {merged:?}\n  interface:  {interface:?}"
        );

        let interface_arrays: std::collections::BTreeSet<&str> = fields
            .iter()
            .filter(|(_, is_array)| *is_array)
            .map(|(name, _)| name.as_str())
            .collect();
        let arrays: std::collections::BTreeSet<&str> = ARRAY_FIELDS.iter().copied().collect();
        assert_eq!(
            arrays, interface_arrays,
            "ARRAY_FIELDS and SystemMetadata's array-typed fields disagree.\n  ARRAY_FIELDS: {arrays:?}\n  interface:    {interface_arrays:?}"
        );
    }

    #[test]
    fn first_observation_returns_incoming_verbatim() {
        let incoming = live_payload();
        let merged = merge_session_metadata(None, &incoming);
        assert_eq!(Value::Object(merged), incoming);
    }

    #[test]
    fn replay_after_live_keeps_model_suffix() {
        // The canary case: live rich payload first, then replay bare
        // payload arrives. Without the merge, model drops to bare and
        // the window-utilization gauge regresses 1M → 200k.
        let live = live_payload();
        let replay = replay_payload();
        let merged = merge_session_metadata(Some(&live), &replay);
        assert_eq!(merged.get("model").unwrap(), "claude-opus-4-7[1m]");
    }

    #[test]
    fn replay_after_live_keeps_non_empty_scalar_fields() {
        let live = live_payload();
        let replay = replay_payload();
        let merged = merge_session_metadata(Some(&live), &replay);
        assert_eq!(merged.get("cwd").unwrap(), "/home/user/project");
        assert_eq!(merged.get("permissionMode").unwrap(), "default");
        assert_eq!(merged.get("version").unwrap(), "2.1.105");
        assert_eq!(merged.get("output_style").unwrap(), "default");
        assert_eq!(merged.get("fast_mode_state").unwrap(), "off");
        assert_eq!(merged.get("apiKeySource").unwrap(), "anthropic");
    }

    #[test]
    fn replay_after_live_keeps_non_empty_array_fields() {
        let live = live_payload();
        let replay = replay_payload();
        let merged = merge_session_metadata(Some(&live), &replay);
        assert_eq!(merged.get("tools").unwrap().as_array().unwrap().len(), 2);
        assert_eq!(
            merged
                .get("slash_commands")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2,
        );
        assert_eq!(merged.get("plugins").unwrap().as_array().unwrap().len(), 1);
        assert_eq!(merged.get("agents").unwrap().as_array().unwrap().len(), 1);
        assert_eq!(merged.get("skills").unwrap().as_array().unwrap().len(), 1);
        assert_eq!(
            merged.get("mcp_servers").unwrap().as_array().unwrap().len(),
            1,
        );
    }

    #[test]
    fn live_after_live_replaces_non_empty_incoming() {
        // Two live payloads arrive (e.g., the user explicitly
        // re-initialized the session with different settings). The
        // newer one wins because every field is present and non-empty.
        let earlier = live_payload();
        let mut later = live_payload();
        later["cwd"] = json!("/home/user/other-project");
        later["permissionMode"] = json!("plan");
        later["tools"] = json!(["Read"]);
        let merged = merge_session_metadata(Some(&earlier), &later);
        assert_eq!(merged.get("cwd").unwrap(), "/home/user/other-project");
        assert_eq!(merged.get("permissionMode").unwrap(), "plan");
        assert_eq!(merged.get("tools").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn genuine_model_change_replaces_current() {
        // User switched models mid-session (e.g., opus → sonnet). Not
        // a suffix variant of the same base name; the merge must take
        // incoming, not silently keep current.
        let live = live_payload();
        let mut next = replay_payload();
        next["model"] = json!("claude-sonnet-4-6");
        let merged = merge_session_metadata(Some(&live), &next);
        assert_eq!(merged.get("model").unwrap(), "claude-sonnet-4-6");
    }

    #[test]
    fn future_field_unknown_to_rules_passes_through_from_incoming() {
        // A field this code doesn't know about (e.g., a future
        // Anthropic addition) must ride through on incoming — that's
        // what makes the BLOB-store design absorbable.
        let live = live_payload();
        let mut next = live.clone();
        next["new_unknown_field"] = json!({"k": "v"});
        let merged = merge_session_metadata(Some(&live), &next);
        assert_eq!(merged.get("new_unknown_field").unwrap(), &json!({"k": "v"}));
    }

    #[test]
    fn future_field_in_current_but_absent_from_incoming_survives() {
        // Symmetric case: a persisted payload from a newer client has
        // a field that the incoming replay-synthesized payload lacks.
        // Without preservation the field would silently vanish.
        let mut live = live_payload();
        live["future_field"] = json!("preserved");
        let replay = replay_payload();
        let merged = merge_session_metadata(Some(&live), &replay);
        assert_eq!(merged.get("future_field").unwrap(), "preserved");
    }

    #[test]
    fn pk_and_ipc_version_always_taken_from_incoming() {
        // PK and wire housekeeping are never "merged" — they're always
        // sourced from the live wire. Pin this so a future refactor
        // doesn't accidentally preserve a stale session_id.
        let mut live = live_payload();
        live["session_id"] = json!("stale-id");
        live["ipc_version"] = json!(1);
        let replay = replay_payload();
        let merged = merge_session_metadata(Some(&live), &replay);
        assert_eq!(merged.get("session_id").unwrap(), "sess-1");
        assert_eq!(merged.get("ipc_version").unwrap(), 2);
    }

    #[test]
    fn malformed_incoming_returns_empty_map() {
        // The bridge should fall back to pass-through if the merge
        // returns an empty map (caller's responsibility). Pin the
        // contract here so the bridge knows what an "I refuse to
        // merge" signal looks like.
        let live = live_payload();
        let incoming = json!("not an object");
        let merged = merge_session_metadata(Some(&live), &incoming);
        assert!(merged.is_empty());
    }

    // ---- prefer_more_specific_model ----------------------------------

    #[test]
    fn prefer_more_specific_keeps_suffix_when_incoming_is_bare() {
        assert_eq!(
            prefer_more_specific_model(Some("claude-opus-4-7[1m]"), Some("claude-opus-4-7")),
            Some("claude-opus-4-7[1m]"),
        );
    }

    #[test]
    fn prefer_more_specific_upgrades_to_suffix_when_current_is_bare() {
        assert_eq!(
            prefer_more_specific_model(Some("claude-opus-4-7"), Some("claude-opus-4-7[1m]")),
            Some("claude-opus-4-7[1m]"),
        );
    }

    #[test]
    fn prefer_more_specific_takes_incoming_on_exact_match() {
        assert_eq!(
            prefer_more_specific_model(Some("claude-opus-4-7[1m]"), Some("claude-opus-4-7[1m]"),),
            Some("claude-opus-4-7[1m]"),
        );
    }

    #[test]
    fn prefer_more_specific_takes_incoming_on_genuine_change() {
        assert_eq!(
            prefer_more_specific_model(Some("claude-opus-4-7[1m]"), Some("claude-sonnet-4-6")),
            Some("claude-sonnet-4-6"),
        );
    }

    #[test]
    fn prefer_more_specific_handles_empty_and_none() {
        assert_eq!(prefer_more_specific_model(None, None), None);
        assert_eq!(prefer_more_specific_model(Some(""), Some("")), None);
        assert_eq!(
            prefer_more_specific_model(None, Some("claude-opus-4-7")),
            Some("claude-opus-4-7"),
        );
        assert_eq!(
            prefer_more_specific_model(Some("claude-opus-4-7"), None),
            Some("claude-opus-4-7"),
        );
        assert_eq!(
            prefer_more_specific_model(Some("claude-opus-4-7"), Some("")),
            Some("claude-opus-4-7"),
        );
        assert_eq!(
            prefer_more_specific_model(Some(""), Some("claude-opus-4-7")),
            Some("claude-opus-4-7"),
        );
    }
}
