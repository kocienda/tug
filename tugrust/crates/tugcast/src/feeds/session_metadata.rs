//! Session metadata detection helper.
//!
//! Historically this module latched `system_metadata` frames from the shared
//! CODE_OUTPUT broadcast onto a single `watch::channel<Frame>` owned by the
//! router. Under the multi-session router, latching a single slot would
//! clobber concurrent per-session metadata updates — see [D14]. The supervisor now owns the
//! detection inline in its merger task and stores the frame on
//! `LedgerEntry::latest_metadata` (per-session) AND publishes it on a
//! dedicated SESSION_SIDEBAND broadcast sender.
//!
//! All that remains of this module is the byte-level needle-scan helper:
//! scanning the payload for `"type":"system_metadata"` is significantly
//! cheaper than a full JSON parse on every CODE_OUTPUT frame, and the
//! merger is called per-token so the hot-path micro-optimization still
//! matters.

/// Needle bytes for identifying `system_metadata` events without a full
/// JSON parse.
const SYSTEM_METADATA_NEEDLE: &[u8] = b"\"type\":\"system_metadata\"";

/// Check if a payload contains a `system_metadata` event by scanning for
/// the type field. Avoids a full JSON parse on every CODE_OUTPUT frame.
pub fn is_system_metadata(payload: &[u8]) -> bool {
    payload
        .windows(SYSTEM_METADATA_NEEDLE.len())
        .any(|w| w == SYSTEM_METADATA_NEEDLE)
}

/// Needle bytes for identifying `session_capabilities` events — the
/// turn-free `initialize`-handshake capabilities tugcode emits once per
/// spawn (model list, command catalog, …).
const SESSION_CAPABILITIES_NEEDLE: &[u8] = b"\"type\":\"session_capabilities\"";

/// Check if a payload is a `session_capabilities` event. Like
/// `system_metadata`, these are routed onto the low-churn
/// SESSION_SIDEBAND feed (the FeedStore keeps only the latest payload
/// per feed, so a CODE_OUTPUT consumer would lose it amid transcript
/// frames). The client store discriminates the two by their `type`.
pub fn is_session_capabilities(payload: &[u8]) -> bool {
    payload
        .windows(SESSION_CAPABILITIES_NEEDLE.len())
        .any(|w| w == SESSION_CAPABILITIES_NEEDLE)
}

/// Needle bytes for identifying `rate_limit_event` frames — the
/// per-turn subscription-quota broadcast tugcode forwards from claude
/// 2.1.x (status / resetsAt / overage).
const RATE_LIMIT_EVENT_NEEDLE: &[u8] = b"\"type\":\"rate_limit_event\"";

/// Check if a payload is a `rate_limit_event` frame. Routed onto the
/// SESSION_SIDEBAND feed for the same reason as `system_metadata` and
/// `session_capabilities`: the per-turn quota broadcast carries the
/// chrome state the Z4B rate-limit chip reads, and the FeedStore keeps
/// only the latest payload per feed, so leaving it on the high-churn
/// CODE_OUTPUT stream would clobber it amid transcript frames before
/// the metadata store could observe it. The client store discriminates
/// all three by their `type`.
pub fn is_rate_limit_event(payload: &[u8]) -> bool {
    payload
        .windows(RATE_LIMIT_EVENT_NEEDLE.len())
        .any(|w| w == RATE_LIMIT_EVENT_NEEDLE)
}

/// Needle bytes for identifying `activity_delta` frames — the binned
/// per-channel work samples tugcode emits from `dispatchEventToTurn`
/// ([P13]).
const ACTIVITY_DELTA_NEEDLE: &[u8] = b"\"type\":\"activity_delta\"";

/// Check if a payload is an `activity_delta` frame. The merger diverts
/// these off the CODE_OUTPUT transcript stream onto the ACTIVITY feed
/// ([P15]) — re-tagged, splice preserved — so per-session activity
/// samples never ride CODE_OUTPUT or its shared replay buffer.
pub fn is_activity_delta(payload: &[u8]) -> bool {
    payload
        .windows(ACTIVITY_DELTA_NEEDLE.len())
        .any(|w| w == ACTIVITY_DELTA_NEEDLE)
}

/// Needle bytes for the two turn-closing frame types. The merger flips the
/// session's `turn_active` flag off when either crosses the pipe, so the
/// activity sampler stops attributing OS work the moment the turn ends —
/// an idle session's Pulse reads zero, not the claude process's idle
/// event-loop heartbeat.
const TURN_COMPLETE_NEEDLE: &[u8] = b"\"type\":\"turn_complete\"";
const TURN_CANCELLED_NEEDLE: &[u8] = b"\"type\":\"turn_cancelled\"";

/// Needle bytes for `wake_started` — a wake turn opens with no inbound
/// `user_message`, so this outbound marker is its turn-open signal.
const WAKE_STARTED_NEEDLE: &[u8] = b"\"type\":\"wake_started\"";

/// Check if a payload ends a turn (`turn_complete` / `turn_cancelled`).
pub fn is_turn_end(payload: &[u8]) -> bool {
    payload
        .windows(TURN_COMPLETE_NEEDLE.len())
        .any(|w| w == TURN_COMPLETE_NEEDLE)
        || payload
            .windows(TURN_CANCELLED_NEEDLE.len())
            .any(|w| w == TURN_CANCELLED_NEEDLE)
}

/// Check if a payload is a `wake_started` marker (opens a wake turn).
pub fn is_wake_started(payload: &[u8]) -> bool {
    payload
        .windows(WAKE_STARTED_NEEDLE.len())
        .any(|w| w == WAKE_STARTED_NEEDLE)
}

/// Needle bytes for the two frames that open and close a background job.
///
/// `task_started` fires when a `Bash` or `Agent` is launched with
/// `run_in_background: true` (and for foreground subagents, which are
/// shape-identical on the wire); `task_updated` carries the status flip that
/// ends one. The pair is what tells a session that has merely *stopped
/// speaking* from one that is actually finished: a turn ends the moment the
/// model stops, while the tests it backgrounded keep running, and their
/// completion wakes a new turn seconds later.
const TASK_STARTED_NEEDLE: &[u8] = b"\"type\":\"task_started\"";
const TASK_UPDATED_NEEDLE: &[u8] = b"\"type\":\"task_updated\"";

/// Check if a payload could open or close a background job — a cheap needle
/// gate in front of the parse that reads its task id ([P08]).
pub fn is_task_edge(payload: &[u8]) -> bool {
    payload
        .windows(TASK_STARTED_NEEDLE.len())
        .any(|w| w == TASK_STARTED_NEEDLE)
        || payload
            .windows(TASK_UPDATED_NEEDLE.len())
            .any(|w| w == TASK_UPDATED_NEEDLE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_system_metadata() {
        let payload =
            br#"{"type":"system_metadata","session_id":"abc","cwd":"/tmp","slash_commands":[]}"#;
        assert!(is_system_metadata(payload));
    }

    #[test]
    fn rejects_non_metadata() {
        let payload = br#"{"type":"assistant","content":"hello"}"#;
        assert!(!is_system_metadata(payload));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_system_metadata(b""));
    }

    #[test]
    fn rejects_other_type() {
        let payload = br#"{"type":"system","subtype":"init"}"#;
        assert!(!is_system_metadata(payload));
    }

    #[test]
    fn detects_session_capabilities() {
        let payload = br#"{"type":"session_capabilities","models":[],"commands":[]}"#;
        assert!(is_session_capabilities(payload));
        assert!(!is_system_metadata(payload));
    }

    #[test]
    fn rejects_capabilities_for_non_capabilities() {
        let payload = br#"{"type":"system_metadata","model":"x"}"#;
        assert!(!is_session_capabilities(payload));
    }

    #[test]
    fn detects_rate_limit_event() {
        let payload = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"warning","resetsAt":1234567890}}"#;
        assert!(is_rate_limit_event(payload));
        assert!(!is_system_metadata(payload));
        assert!(!is_session_capabilities(payload));
    }

    #[test]
    fn rejects_rate_limit_for_non_rate_limit() {
        let payload = br#"{"type":"system_metadata","model":"x"}"#;
        assert!(!is_rate_limit_event(payload));
    }

    #[test]
    fn detects_activity_delta() {
        let payload = br#"{"tug_session_id":"s1","type":"activity_delta","channels":{"text":42}}"#;
        assert!(is_activity_delta(payload));
        assert!(!is_system_metadata(payload));
        assert!(!is_session_capabilities(payload));
        assert!(!is_rate_limit_event(payload));
    }

    #[test]
    fn rejects_activity_delta_for_non_activity() {
        let payload = br#"{"type":"assistant_text","text":"hi"}"#;
        assert!(!is_activity_delta(payload));
    }

    #[test]
    fn detects_turn_end_for_both_closers() {
        assert!(is_turn_end(
            br#"{"type":"turn_complete","msg_id":"m","seq":3}"#
        ));
        assert!(is_turn_end(
            br#"{"type":"turn_cancelled","msg_id":"m","seq":4}"#
        ));
        assert!(!is_turn_end(br#"{"type":"assistant_text","text":"hi"}"#));
    }

    #[test]
    fn detects_wake_started() {
        assert!(is_wake_started(
            br#"{"type":"wake_started","session_id":"x"}"#
        ));
        assert!(!is_wake_started(br#"{"type":"turn_complete"}"#));
    }

    #[test]
    fn detects_both_ends_of_a_background_job() {
        assert!(is_task_edge(
            br#"{"type":"task_started","task_id":"t1","task_type":"local_bash"}"#
        ));
        assert!(is_task_edge(
            br#"{"type":"task_updated","task_id":"t1","status":"completed"}"#
        ));
        // The progress tick is neither end — a job ticking is a job still open.
        assert!(!is_task_edge(br#"{"type":"task_progress","task_id":"t1"}"#));
        assert!(!is_task_edge(br#"{"type":"turn_complete"}"#));
    }
}
