//! The telemetry and listings family of CONTROL actions: the deck's
//! `record_*` writes (turn telemetry, context breakdowns, session state
//! changes) and the restore-time reads (`list_session_state_changes`,
//! `list_digest_lines`, `list_overview_posts`, `list_shell_exchanges`,
//! `list_refs`).

use super::super::*;

/// Parsed payload of the `record_turn_telemetry` CONTROL action.
/// Tugdeck → tugcast: the reducer dispatches this from
/// `handleTurnComplete` (live path only — replayed turns aren't
/// re-persisted) carrying the per-turn telemetry block the reducer
/// just computed. The supervisor's `do_record_turn_telemetry` resolves
/// `tug_session_id` to the claude `session_id` (the ledger PK) and
/// writes the row.
///
/// Field names mirror the wire-shape of tugdeck's `TurnTelemetry`
/// (camelCase nested inside `telemetry`). The outer envelope uses
/// snake_case to match the rest of the CONTROL action conventions.
#[derive(Debug)]
struct RecordTurnTelemetryPayload {
    tug_session_id: TugSessionId,
    msg_id: String,
    cost_input_tokens: i64,
    cost_output_tokens: i64,
    cost_cache_creation_input_tokens: i64,
    cost_cache_read_input_tokens: i64,
    cost_total_cost_usd: f64,
    wall_clock_ms: i64,
    awaiting_approval_ms: i64,
    transport_downtime_ms: i64,
    active_ms: i64,
    ttft_ms: Option<i64>,
    ttftc_ms: Option<i64>,
    reconnect_count: i64,
    max_stream_gap_ms: i64,
    /// Session-level `window(0)`; carried on every turn's telemetry so
    /// a resumed session restores it. `None` when the client never
    /// captured a first iteration.
    session_init_tokens: Option<i64>,
    ended_at: i64,
}

fn parse_record_turn_telemetry_payload(
    payload: &[u8],
) -> Result<RecordTurnTelemetryPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let tug_session_id = value
        .get("tug_session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    let msg_id = value
        .get("msg_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let telemetry = value.get("telemetry").ok_or(ControlError::Malformed)?;
    let cost = telemetry.get("cost").ok_or(ControlError::Malformed)?;
    let ended_at = value
        .get("ended_at")
        .and_then(|v| v.as_i64())
        .ok_or(ControlError::Malformed)?;
    let i64_or = |obj: &serde_json::Value, key: &str| -> Result<i64, ControlError> {
        obj.get(key)
            .and_then(|v| v.as_i64())
            .ok_or(ControlError::Malformed)
    };
    let optional_i64 = |obj: &serde_json::Value, key: &str| -> Option<i64> {
        match obj.get(key) {
            Some(v) if v.is_null() => None,
            Some(v) => v.as_i64(),
            None => None,
        }
    };
    Ok(RecordTurnTelemetryPayload {
        tug_session_id: TugSessionId::new(tug_session_id),
        msg_id,
        cost_input_tokens: i64_or(cost, "inputTokens")?,
        cost_output_tokens: i64_or(cost, "outputTokens")?,
        cost_cache_creation_input_tokens: i64_or(cost, "cacheCreationInputTokens")?,
        cost_cache_read_input_tokens: i64_or(cost, "cacheReadInputTokens")?,
        cost_total_cost_usd: cost
            .get("totalCostUsd")
            .and_then(|v| v.as_f64())
            .ok_or(ControlError::Malformed)?,
        wall_clock_ms: i64_or(telemetry, "wallClockMs")?,
        awaiting_approval_ms: i64_or(telemetry, "awaitingApprovalMs")?,
        transport_downtime_ms: i64_or(telemetry, "transportDowntimeMs")?,
        active_ms: i64_or(telemetry, "activeMs")?,
        ttft_ms: optional_i64(telemetry, "ttftMs"),
        ttftc_ms: optional_i64(telemetry, "ttftcMs"),
        reconnect_count: i64_or(telemetry, "reconnectCount")?,
        max_stream_gap_ms: i64_or(telemetry, "maxStreamGapMs")?,
        session_init_tokens: optional_i64(telemetry, "sessionInitTokens"),
        ended_at,
    })
}

/// Parsed payload of the `record_context_breakdown` CONTROL action.
/// Tugdeck → tugcast: the reducer dispatches this for every
/// `context_breakdown` event it consumes (live frames from tugcode +
/// the supervisor's bind-time re-emit). The supervisor's
/// `do_record_context_breakdown` resolves `tug_session_id` to the
/// claude `session_id` (the ledger PK) and writes the row.
///
/// `payload_bytes` is the serialized JSON of the wire-frame body
/// (the `payload` sub-object of the CONTROL frame, NOT the full
/// CONTROL envelope). The supervisor stores it verbatim in the
/// `context_breakdown_latest.payload` BLOB; the next bind reads it
/// back and re-emits it as a synthetic `context_breakdown` wire
/// frame.
struct RecordContextBreakdownPayload {
    tug_session_id: TugSessionId,
    payload_bytes: Vec<u8>,
    captured_at: i64,
}

/// Parsed payload of the `record_session_state_change` CONTROL action.
/// Tugdeck → tugcast: the per-card store wrapper compares the prev/new
/// indicator-tone triple after every `reduce()` and dispatches this
/// when any axis changed.
///
/// `do_record_session_state_change` resolves `tug_session_id` to the
/// claude `session_id` (the ledger PK) and writes one
/// `session_state_changes` row. The sqlite layer dedupes against the
/// most-recent persisted triple as a race safety-net; the per-card
/// pre-check is the primary dedupe.
struct RecordSessionStateChangePayload {
    tug_session_id: TugSessionId,
    at_ms: i64,
    phase: String,
    transport_state: String,
    interrupt_in_flight: bool,
}

fn parse_record_session_state_change_payload(
    payload: &[u8],
) -> Result<RecordSessionStateChangePayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let tug_session_id = value
        .get("tug_session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    let at_ms = value
        .get("at_ms")
        .and_then(|v| v.as_i64())
        .ok_or(ControlError::Malformed)?;
    let phase = value
        .get("phase")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let transport_state = value
        .get("transport_state")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    let interrupt_in_flight = value
        .get("interrupt_in_flight")
        .and_then(|v| v.as_bool())
        .ok_or(ControlError::Malformed)?;
    Ok(RecordSessionStateChangePayload {
        tug_session_id: TugSessionId::new(tug_session_id),
        at_ms,
        phase,
        transport_state,
        interrupt_in_flight,
    })
}

/// Parsed payload of the `list_session_state_changes` CONTROL action.
/// Tugdeck → tugcast read: the popover-side reader asks the supervisor
/// for the persisted history of triples for a given session. The
/// supervisor resolves `tug_session_id → claude_session_id`, reads
/// every row from `session_state_changes`, and broadcasts
/// `list_session_state_changes_ok` back on CONTROL.
struct ListSessionStateChangesPayload {
    tug_session_id: TugSessionId,
}

fn parse_list_session_state_changes_payload(
    payload: &[u8],
) -> Result<ListSessionStateChangesPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let tug_session_id = value
        .get("tug_session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    Ok(ListSessionStateChangesPayload {
        tug_session_id: TugSessionId::new(tug_session_id),
    })
}

fn parse_record_context_breakdown_payload(
    payload: &[u8],
) -> Result<RecordContextBreakdownPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let tug_session_id = value
        .get("tug_session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    let captured_at = value
        .get("captured_at")
        .and_then(|v| v.as_i64())
        .ok_or(ControlError::Malformed)?;
    // Re-serialize the `payload` sub-object so the supervisor stores
    // it as a stable blob shape (it round-trips back through
    // `serde_json` even if the CONTROL frame's whitespace / key order
    // differed). The sub-object must be present and an object.
    let payload_obj = value.get("payload").ok_or(ControlError::Malformed)?;
    if !payload_obj.is_object() {
        return Err(ControlError::Malformed);
    }
    let payload_bytes = serde_json::to_vec(payload_obj).map_err(|_| ControlError::Malformed)?;
    Ok(RecordContextBreakdownPayload {
        tug_session_id: TugSessionId::new(tug_session_id),
        payload_bytes,
        captured_at,
    })
}

impl AgentSupervisor {
    /// The telemetry and listings family's share of
    /// [`AgentSupervisor::handle_control`]: the same arms, the same replies,
    /// reached through one delegating arm there.
    pub(in crate::feeds::agent_supervisor) async fn handle_telemetry_control(
        &self,
        action: &str,
        payload: &[u8],
    ) -> ControlOutcome {
        let result: Result<(), ControlError> = match action {
            "record_turn_telemetry" => {
                let parsed = match parse_record_turn_telemetry_payload(payload) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected record_turn_telemetry");
                        return ControlOutcome::Error(e);
                    }
                };
                self.do_record_turn_telemetry(parsed).await;
                Ok(())
            }
            "record_context_breakdown" => {
                let parsed = match parse_record_context_breakdown_payload(payload) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected record_context_breakdown");
                        return ControlOutcome::Error(e);
                    }
                };
                self.do_record_context_breakdown(parsed).await;
                Ok(())
            }
            "record_session_state_change" => {
                let parsed = match parse_record_session_state_change_payload(payload) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected record_session_state_change");
                        return ControlOutcome::Error(e);
                    }
                };
                self.do_record_session_state_change(parsed).await;
                Ok(())
            }
            "list_session_state_changes" => {
                let parsed = match parse_list_session_state_changes_payload(payload) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected list_session_state_changes");
                        return ControlOutcome::Error(e);
                    }
                };
                self.do_list_session_state_changes(parsed).await;
                Ok(())
            }
            "list_digest_lines" => {
                // App-scoped read — no session id, no payload fields.
                self.do_list_digest_lines().await;
                Ok(())
            }
            "list_overview_posts" => {
                // App-scoped read — the Overview card's tail on mount, and
                // each older page as the reader scrolls back. Both arguments
                // are optional, and absent means "the tail", so a client that
                // sends neither is the pre-paging client and is served
                // identically.
                let args = serde_json::from_slice::<serde_json::Value>(payload).ok();
                let before_id = args
                    .as_ref()
                    .and_then(|v| v.get("before_id"))
                    .and_then(serde_json::Value::as_i64);
                let limit = args
                    .as_ref()
                    .and_then(|v| v.get("limit"))
                    .and_then(serde_json::Value::as_u64)
                    .map(|n| n as usize);
                self.do_list_overview_posts(before_id, limit).await;
                Ok(())
            }
            "list_shell_exchanges" => {
                // Session-scoped read — the deck's shell-restore tail fetch.
                // `since_ms` is the replay window's oldest-turn timestamp when
                // the deck knows it, so ink rows span what the turns span.
                let parsed = serde_json::from_slice::<serde_json::Value>(payload).ok();
                let tug_session_id = parsed
                    .as_ref()
                    .and_then(|v| {
                        v.get("tug_session_id")
                            .and_then(|s| s.as_str())
                            .map(String::from)
                    })
                    .unwrap_or_default();
                let since_ms = parsed
                    .as_ref()
                    .and_then(|v| v.get("since_ms"))
                    .and_then(|s| s.as_i64());
                self.do_list_shell_exchanges(&tug_session_id, since_ms)
                    .await;
                Ok(())
            }
            "list_refs" => {
                // Session-scoped read — the deck's refs-restore fetch.
                let tug_session_id = serde_json::from_slice::<serde_json::Value>(payload)
                    .ok()
                    .and_then(|v| {
                        v.get("tug_session_id")
                            .and_then(|s| s.as_str())
                            .map(String::from)
                    })
                    .unwrap_or_default();
                self.do_list_refs(&tug_session_id).await;
                Ok(())
            }
            _ => return ControlOutcome::PassThrough,
        };

        match result {
            Ok(()) => ControlOutcome::Handled,
            Err(e) => ControlOutcome::Error(e),
        }
    }

    /// Persist a per-turn telemetry block. Tugdeck → tugcast inbound
    /// CONTROL action driven by the reducer's `handleTurnComplete`
    /// (live path only — replayed turns aren't re-persisted). The
    /// claude `session_id` is the row's PK; we resolve it from the
    /// ledger entry keyed by `tug_session_id` (the wire-side
    /// identifier the client uses).
    ///
    /// The write is fire-and-forget at the wire level — no ack frame
    /// is broadcast. The client doesn't wait on confirmation; the
    /// row's reason for existing is to survive the next reload, not
    /// the next render. A `LedgerError` here is logged at `warn`
    /// (telemetry, not a user-visible failure).
    ///
    /// Three quietly-dropped cases — all benign:
    ///   1. No `SessionLedger` configured (test harnesses without
    ///      persistence). Nothing to do.
    ///   2. Ledger entry not found for `tug_session_id` (the session
    ///      was already evicted or never spawned through this
    ///      supervisor). Nothing to write to.
    ///   3. Ledger entry exists but `claude_session_id` is `None`
    ///      (handshake not yet complete). The reducer should never
    ///      reach `handleTurnComplete` before `session_init` lands,
    ///      so this branch is defensive — if it ever fires, log and
    ///      drop. The next live turn whose `session_init` precedes
    ///      it will write a fresh row.
    async fn do_record_turn_telemetry(&self, parsed: RecordTurnTelemetryPayload) {
        let Some(ledger) = self.session_ledger.as_ref() else {
            return;
        };
        let claude_id = {
            let outer = self.ledger.lock().await;
            let Some(entry_arc) = outer.get(&parsed.tug_session_id) else {
                tracing::warn!(
                    target: "dev::telemetry",
                    event = "record_turn_telemetry.skipped",
                    tug_session_id = %parsed.tug_session_id,
                    msg_id = %parsed.msg_id,
                    reason = "session_not_found",
                );
                return;
            };
            let entry = entry_arc.lock().await;
            entry.claude_session_id.clone()
        };
        let Some(claude_id) = claude_id else {
            tracing::warn!(
                target: "dev::telemetry",
                event = "record_turn_telemetry.skipped",
                tug_session_id = %parsed.tug_session_id,
                msg_id = %parsed.msg_id,
                reason = "no_claude_session_id",
            );
            return;
        };
        let row = crate::session_ledger::TurnTelemetryRow {
            session_id: claude_id,
            msg_id: parsed.msg_id,
            input_tokens: parsed.cost_input_tokens,
            output_tokens: parsed.cost_output_tokens,
            cache_creation_input_tokens: parsed.cost_cache_creation_input_tokens,
            cache_read_input_tokens: parsed.cost_cache_read_input_tokens,
            total_cost_usd: parsed.cost_total_cost_usd,
            wall_clock_ms: parsed.wall_clock_ms,
            awaiting_approval_ms: parsed.awaiting_approval_ms,
            transport_downtime_ms: parsed.transport_downtime_ms,
            active_ms: parsed.active_ms,
            ttft_ms: parsed.ttft_ms,
            ttftc_ms: parsed.ttftc_ms,
            reconnect_count: parsed.reconnect_count,
            max_stream_gap_ms: parsed.max_stream_gap_ms,
            ended_at: parsed.ended_at,
            session_init_tokens: parsed.session_init_tokens,
        };
        if let Err(err) = ledger.record_turn_telemetry(&row) {
            crate::ledger_integrity::health::note_error("sessions", &err);
            tracing::warn!(
                target: "dev::telemetry",
                error = %err,
                session_id = %row.session_id,
                msg_id = %row.msg_id,
                "record_turn_telemetry ledger write failed",
            );
            return;
        }
        // Every ledger write pushes the row it changed, and this is the write
        // that was exempt. It is also the one whose fact a receipt reads: the
        // deck records telemetry after the turn commits, one round trip past
        // the after-turn push, so without this the stage that just finished
        // would carry a total missing its last turn until something else moved.
        // The push is built after the write, so it carries the row it made.
        if let Ok(Some(session_row)) = ledger.get(&row.session_id) {
            let metrics = ledger.scan_metrics_for(&row.session_id).unwrap_or(None);
            let usage = ledger.usage_for(&row.session_id).unwrap_or(None);
            let _ = self
                .control_tx
                .send(build_session_updated_frame(&session_row, metrics, usage));
        }
    }

    /// Persist the latest `/context`-style breakdown payload for a
    /// session via the SessionLedger. Mirrors
    /// {@link do_record_turn_telemetry} structurally: resolve
    /// `tug_session_id → claude_session_id`, UPSERT one row keyed by
    /// claude session id. The three quietly-dropped cases — no
    /// ledger configured, no session entry, no claude_session_id —
    /// log at telemetry level and return without raising.
    async fn do_record_context_breakdown(&self, parsed: RecordContextBreakdownPayload) {
        let Some(ledger) = self.session_ledger.as_ref() else {
            return;
        };
        let claude_id = {
            let outer = self.ledger.lock().await;
            let Some(entry_arc) = outer.get(&parsed.tug_session_id) else {
                tracing::warn!(
                    target: "dev::telemetry",
                    event = "record_context_breakdown.skipped",
                    tug_session_id = %parsed.tug_session_id,
                    reason = "session_not_found",
                );
                return;
            };
            let entry = entry_arc.lock().await;
            entry.claude_session_id.clone()
        };
        let Some(claude_id) = claude_id else {
            tracing::warn!(
                target: "dev::telemetry",
                event = "record_context_breakdown.skipped",
                tug_session_id = %parsed.tug_session_id,
                reason = "no_claude_session_id",
            );
            return;
        };
        if let Err(err) =
            ledger.record_context_breakdown(&claude_id, &parsed.payload_bytes, parsed.captured_at)
        {
            tracing::warn!(
                target: "dev::telemetry",
                error = %err,
                session_id = %claude_id,
                "record_context_breakdown ledger write failed",
            );
        }
    }

    /// Persist one indicator-tone triple transition via the
    /// SessionLedger. Structurally mirrors
    /// {@link do_record_context_breakdown}: resolve
    /// `tug_session_id → claude_session_id`, hand the row to the
    /// ledger. The ledger's per-session dedupe is the SQL-layer
    /// safety net for races where the client-side prev/new compare
    /// in `dispatch()` doesn't get the chance to skip a redundant
    /// write (e.g., two near-simultaneous dispatches that both see
    /// the same previous state).
    ///
    /// The three quietly-dropped cases — no ledger configured, no
    /// session entry, no claude_session_id — log at telemetry level
    /// and return without raising; mirrors the context-breakdown
    /// handler.
    async fn do_record_session_state_change(&self, parsed: RecordSessionStateChangePayload) {
        let Some(ledger) = self.session_ledger.as_ref() else {
            return;
        };
        let claude_id = {
            let outer = self.ledger.lock().await;
            let Some(entry_arc) = outer.get(&parsed.tug_session_id) else {
                tracing::warn!(
                    target: "dev::telemetry",
                    event = "record_session_state_change.skipped",
                    tug_session_id = %parsed.tug_session_id,
                    reason = "session_not_found",
                );
                return;
            };
            let entry = entry_arc.lock().await;
            entry.claude_session_id.clone()
        };
        let Some(claude_id) = claude_id else {
            tracing::warn!(
                target: "dev::telemetry",
                event = "record_session_state_change.skipped",
                tug_session_id = %parsed.tug_session_id,
                reason = "no_claude_session_id",
            );
            return;
        };
        if let Err(err) = ledger.record_session_state_change(
            &claude_id,
            parsed.at_ms,
            &parsed.phase,
            &parsed.transport_state,
            parsed.interrupt_in_flight,
        ) {
            tracing::warn!(
                target: "dev::telemetry",
                error = %err,
                session_id = %claude_id,
                "record_session_state_change ledger write failed",
            );
        }
    }

    /// Handle a `list_session_state_changes` CONTROL request. Reads
    /// every persisted triple-transition row for the resolved claude
    /// session id and broadcasts a `list_session_state_changes_ok`
    /// response carrying the rows oldest-first by `id`. The client-
    /// side reader correlates by the `tug_session_id` field, which
    /// is echoed verbatim from the request.
    ///
    /// Empty arrays are valid responses: a fresh session that has
    /// never had a triple change yet has no rows; the client should
    /// render a "no history" state.
    ///
    /// Errors broadcast `list_session_state_changes_err
    /// { tug_session_id, reason }`. When no `session_ledger` is wired
    /// the response is an empty array. When the in-memory map cannot
    /// resolve a `claude_session_id` (no session entry, or a resumed
    /// entry whose id has not landed yet) the read falls back to
    /// `tug_session_id` as the ledger key — identical to the claude
    /// id by the post-Phase-B invariant — so the persisted history
    /// survives a tugdeck reload that races the resume handshake. A
    /// genuinely unknown id still reads as an empty array; the popover
    /// renders the same "no history yet" state either way.
    async fn do_list_session_state_changes(&self, parsed: ListSessionStateChangesPayload) {
        let tug_session_id_str = parsed.tug_session_id.as_str().to_owned();
        let Some(ledger) = self.session_ledger.as_ref() else {
            let body = serde_json::json!({
                "action": "list_session_state_changes_ok",
                "tug_session_id": tug_session_id_str,
                "rows": serde_json::Value::Array(Vec::new()),
            });
            let _ = self.control_tx.send(Frame::new(
                FeedId::CONTROL,
                serde_json::to_vec(&body).expect("list_session_state_changes_ok serializes"),
            ));
            return;
        };
        let resolved_claude_id = {
            let outer = self.ledger.lock().await;
            match outer.get(&parsed.tug_session_id) {
                Some(entry_arc) => {
                    let entry = entry_arc.lock().await;
                    entry.claude_session_id.clone()
                }
                None => None,
            }
        };
        // Resolve the ledger key. The in-memory entry may not yet carry
        // the resumed session's claude id — after a tugdeck reload the
        // popover's `list_session_state_changes` request can race ahead
        // of the resume handshake that sets `claude_session_id`. Post-
        // Phase-B the tug and claude session ids are identical by
        // invariant, and `session_state_changes` rows are keyed by the
        // claude id, so falling back to `tug_session_id` recovers the
        // persisted history instead of returning a spurious empty array
        // (the popover's "no state changes recorded" bug after reload).
        // A genuinely unknown id still yields an empty ledger read —
        // the same "no history yet" the client renders either way.
        let claude_id = resolved_claude_id.unwrap_or_else(|| tug_session_id_str.clone());
        let rows = match ledger.list_session_state_changes(&claude_id) {
            Ok(r) => r,
            Err(err) => {
                warn!(error = %err, session_id = %claude_id, "list_session_state_changes failed");
                let body = serde_json::json!({
                    "action": "list_session_state_changes_err",
                    "tug_session_id": tug_session_id_str,
                    "reason": "ledger_read_failed",
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("list_session_state_changes_err serializes"),
                ));
                return;
            }
        };
        let wire_rows: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "at_ms": r.at_ms,
                    "phase": r.phase,
                    "transport_state": r.transport_state,
                    "interrupt_in_flight": r.interrupt_in_flight,
                })
            })
            .collect();
        let body = serde_json::json!({
            "action": "list_session_state_changes_ok",
            "tug_session_id": tug_session_id_str,
            "rows": wire_rows,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_session_state_changes_ok serializes"),
        ));
    }

    /// Handle a `list_digest_lines` CONTROL request — the deck's mount-time
    /// tail (the digest store sends it once, then stays live off the DIGEST
    /// feed). App-scoped: no session id. Broadcasts
    /// `list_digest_lines_ok { lines }`, oldest-first; no digester yields an
    /// empty array (the "no history yet" state, same conduct as the
    /// state-changes read).
    ///
    /// **Answered from memory, never from disk.** The digester's per-session
    /// deque (Spec S03) is the one account of what a session has said, and it
    /// is already per-scope — which is what the read has to be, because the
    /// deck filters by session and a flat app-wide tail hands one chatty
    /// session's lines to every card and leaves the quiet ones blank. The
    /// rolling ledger table this used to read is gone; nothing survives a
    /// restart, and nothing should: a beat describes work that is running.
    async fn do_list_digest_lines(&self) {
        let lines: Vec<serde_json::Value> = self
            .digester
            .as_ref()
            .map(|digester| {
                let guard = crate::feeds::session_digest::lock_digester(digester);
                let mut rows: Vec<(u64, serde_json::Value)> = Vec::new();
                for (scope, state) in guard.scopes() {
                    for line in state
                        .digest()
                        .tail(crate::feeds::digest_bridge::DIGEST_TAIL_LEN)
                    {
                        rows.push((
                            line.beat,
                            serde_json::json!({
                                // The beat is the row's identity: monotonic
                                // within the process and across scopes, which
                                // is exactly what the retired table's rowid
                                // was standing in for.
                                "id": line.beat,
                                "at_ms": line.at_ms,
                                "beat": line.beat,
                                "text": line.text,
                                // The kind rides the tail exactly as it rides
                                // the live frame: the masthead's ladder reads
                                // it to tell an Ask line from a tool line and
                                // an ended turn from a live one, and a card
                                // mounting mid-turn reads this rather than the
                                // feed ([D187]).
                                "kind": line.kind.as_str(),
                                "scopes": [scope],
                            }),
                        ));
                    }
                }
                // Oldest-first across every scope, which is the order the
                // deck appends in.
                rows.sort_by_key(|(beat, _)| *beat);
                rows.into_iter().map(|(_, row)| row).collect()
            })
            .unwrap_or_default();
        let body = serde_json::json!({
            "action": "list_digest_lines_ok",
            "lines": lines,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_digest_lines_ok serializes"),
        ));
    }

    /// Handle a `list_overview_posts` CONTROL request — the Overview card's
    /// history read, both the mount-time tail and each older page the reader
    /// scrolls back for. App-scoped: the channel belongs to the app, not to a
    /// session, even though a Observer post names the session it narrates.
    ///
    /// Request: `{ before_id?, limit? }`. No `before_id` is the tail (the
    /// original behavior, so an older client asking for nothing gets exactly
    /// what it always got); a `before_id` is the page immediately older than
    /// that row. `limit` defaults to the standard tail length.
    ///
    /// Broadcasts `list_overview_posts_ok { posts, has_more, before_id? }`,
    /// posts oldest-first; a missing ledger yields an empty array — the "no
    /// history yet" state, same conduct as the digest read.
    ///
    /// **`before_id` is echoed verbatim, and that echo is load-bearing.** This
    /// response goes out on the CONTROL *broadcast* bus with no request
    /// correlation of any kind — which cost nothing while the only read was an
    /// idempotent tail that replaced the list with itself. A page is not
    /// idempotent: applied twice it prepends twice. The echo is what lets the
    /// client tell a tail from a page, and its own page from anyone else's.
    async fn do_list_overview_posts(&self, before_id: Option<i64>, limit: Option<usize>) {
        let limit = limit
            .filter(|n| *n > 0)
            .unwrap_or(crate::feeds::observer::OVERVIEW_TAIL_LEN);
        let (posts, has_more) = self
            .session_ledger
            .as_ref()
            .map(|ledger| {
                ledger
                    .list_overview_posts_page(before_id, limit)
                    .unwrap_or_else(|err| {
                        warn!(error = %err, "list_overview_posts failed");
                        (Vec::new(), false)
                    })
            })
            .unwrap_or_default();
        let body = serde_json::json!({
            "action": "list_overview_posts_ok",
            "posts": posts,
            "has_more": has_more,
            "before_id": before_id,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_overview_posts_ok serializes"),
        ));
    }

    /// Handle a `list_shell_exchanges { tug_session_id, since_ms? }` CONTROL
    /// request — the deck's shell-restore read. Broadcasts
    /// `list_shell_exchanges_ok { tug_session_id, exchanges, total, max_seq,
    /// answered }`, oldest-first.
    ///
    /// `total` and `max_seq` are the completeness pair: the deck compares
    /// `exchanges.length` against `total` and only settles its restore when
    /// they agree. Without them an empty array from a mistimed request is
    /// indistinguishable from a session that genuinely has no rows — which is
    /// exactly how a transcript comes back short and silent. `answered` is
    /// false when there is no ledger at all, so "no ledger" never reads as
    /// "no rows".
    pub(in crate::feeds::agent_supervisor) async fn do_list_shell_exchanges(
        &self,
        tug_session_id: &str,
        since_ms: Option<i64>,
    ) {
        let started = std::time::Instant::now();
        // Read the line of work, answer the asker. The deck routes a response
        // back to the store that asked by matching the echoed
        // `tug_session_id`, so the query resolves and the echo does not.
        let head = self.resolve_ink_line(tug_session_id);
        let read = self.shell_ledger.as_ref().map(|ledger| {
            let rows = ledger
                .list_exchanges_since(&head, since_ms)
                .unwrap_or_else(|err| {
                    warn!(error = %err, %tug_session_id, "list_shell_exchanges failed");
                    Vec::new()
                });
            let (total, max_seq) = ledger
                .exchange_census(&head, since_ms)
                .unwrap_or_else(|err| {
                    warn!(error = %err, %tug_session_id, "shell exchange census failed");
                    (rows.len() as i64, 0)
                });
            (rows, total, max_seq)
        });
        let answered = read.is_some();
        let (exchanges, total, max_seq) = read.unwrap_or_else(|| (Vec::new(), 0, 0));
        // The load-bearing diagnostic for a transcript that came back short:
        // ground truth for "what did the server actually hand this session".
        debug!(
            %tug_session_id,
            since_ms = ?since_ms,
            rows = exchanges.len(),
            total,
            max_seq,
            answered,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "list_shell_exchanges"
        );
        let body = serde_json::json!({
            "action": "list_shell_exchanges_ok",
            "tug_session_id": tug_session_id,
            "exchanges": exchanges,
            "total": total,
            "max_seq": max_seq,
            "answered": answered,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_shell_exchanges_ok serializes"),
        ));
    }

    /// Handle a `list_refs { tug_session_id }` CONTROL request — the deck's
    /// refs-restore read. Broadcasts `list_refs_ok { tug_session_id, run }`,
    /// where `run` is the session's latest completed run or `null` (a missing
    /// ledger, or a session that has never searched).
    async fn do_list_refs(&self, tug_session_id: &str) {
        // Resolved query, unresolved echo — see `do_list_shell_exchanges`.
        let head = self.resolve_ink_line(tug_session_id);
        let run = self.refs_ledger.as_ref().and_then(|ledger| {
            ledger.list_refs(&head).unwrap_or_else(|err| {
                warn!(error = %err, %tug_session_id, "list_refs failed");
                None
            })
        });
        let body = serde_json::json!({
            "action": "list_refs_ok",
            "tug_session_id": tug_session_id,
            "run": run,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_refs_ok serializes"),
        ));
    }
}
