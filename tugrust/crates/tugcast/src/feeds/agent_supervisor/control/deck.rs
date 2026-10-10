//! The deck family of CONTROL actions: `deck_seatings`, the deck's report of
//! which sessions its open cards are seated on, and `deck_log`, its warnings
//! mirrored into `tugcast.log`.

use super::super::*;
use tugcast_core::ControlAction;

/// A `deck_seatings` CONTROL request: the deck's full-replacement report of
/// which tug sessions its open Session cards are seated on. Only the session
/// ids matter server-side (the changeset compose folds them into liveness);
/// the `card_id` each entry carries is observability the payload keeps for
/// the wire log. An empty list is a valid report — "seated on nothing".
fn parse_deck_seatings_payload(payload: &[u8]) -> Result<HashSet<String>, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let seatings = value
        .get("seatings")
        .and_then(|v| v.as_array())
        .ok_or(ControlError::Malformed)?;
    let mut session_ids = HashSet::new();
    for entry in seatings {
        let id = entry
            .get("tug_session_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or(ControlError::Malformed)?;
        session_ids.insert(id.to_string());
    }
    Ok(session_ids)
}

impl AgentSupervisor {
    /// The deck family's share of [`AgentSupervisor::handle_control`]: the
    /// same arms, the same replies, reached through one delegating arm there.
    pub(in crate::feeds::agent_supervisor) async fn handle_deck_control(
        &self,
        action: ControlAction,
        payload: &[u8],
        client_id: ClientId,
    ) -> ControlOutcome {
        let result: Result<(), ControlError> = match action {
            ControlAction::DeckSeatings => {
                // Full-replacement report of which sessions this deck client
                // has seated on open Session cards. Keyed by the WebSocket
                // client id, so the state can never outlive the deck that
                // reported it (`on_client_disconnect` drops it; a reconnect
                // is a fresh id that starts empty).
                match parse_deck_seatings_payload(payload) {
                    Ok(session_ids) => {
                        if crate::feeds::deck_seatings::set_deck_seatings(client_id, session_ids) {
                            self.registry.changeset_all_bump().notify_one();
                        }
                        Ok(())
                    }
                    Err(e) => return ControlOutcome::Error(e),
                }
            }
            ControlAction::DeckLog => {
                // The deck's `warn`/`error` dev-log entries, mirrored here so
                // they survive into `tugcast.log`. The DevTools Log tab is only
                // readable live, and a release build exposes no handle onto
                // that store — so without this a warning about, say, a restore
                // that came back short is written nowhere anyone can read
                // afterwards. Diagnostic echo only: never trusted, never acted
                // on, and bounded by the client's own 2000-char detail cap.
                let v = serde_json::from_slice::<serde_json::Value>(payload)
                    .unwrap_or(serde_json::Value::Null);
                let str_at = |k: &str| {
                    v.get(k)
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_owned()
                };
                let (level, source, message, detail) = (
                    str_at("level"),
                    str_at("source"),
                    str_at("message"),
                    v.get("data")
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_owned(),
                );
                if level == "error" {
                    tracing::error!(source, detail, "deck: {message}");
                } else {
                    warn!(source, detail, "deck: {message}");
                }
                Ok(())
            }
            _ => return ControlOutcome::PassThrough,
        };

        match result {
            Ok(()) => ControlOutcome::Handled,
            Err(e) => ControlOutcome::Error(e),
        }
    }
}
