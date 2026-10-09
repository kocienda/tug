//! [`SessionsRecorder`]: the writer trait for the per-session ledger, its
//! [`LedgerSessionsRecorder`] implementation, and the CONTROL frames a row
//! change pushes.

use super::*;

/// Per-session metadata captured at session_init time.
///
/// The recorder uses `session_id` as the row key (the claude session id —
/// also the JSONL file name on disk). `card_id` populates the row's
/// `card_id` column on `record_spawn` and is preserved across
/// `mark_closed` / `mark_failed` so the persisted ledger retains the
/// binding for client-side restore.
#[derive(Debug, Clone, Copy)]
pub struct SessionRecord<'a> {
    pub session_id: &'a str,
    pub workspace_key: &'a str,
    pub project_dir: &'a str,
    pub card_id: &'a str,
    /// Provisional mnemonic tag carried from the `LedgerEntry`, claimed
    /// authoritatively by `record_spawn`. `None` when tugdeck sent none.
    pub tag: Option<&'a str>,
    /// The line this segment joins ([P04]). `None` where the caller has no
    /// line to name — a path that has not been taught about lines yet — and
    /// the segment then takes a line of its own.
    pub line_id: Option<&'a str>,
}

/// Writer for the per-session ledger.
///
/// Replaces the pre-ledger pair of `TugbankSessionsRecorder` (sessions
/// record) and `TugbankLiveSessionsTracker` (live-sessions broadcast). One
/// trait now expresses the full lifecycle: `record` (insert/promote to
/// live), `record_turn` (assistant turn complete), `mark_closed`
/// (close_session / clean exit), `mark_failed` (resume_failed / crash
/// budget exhausted), and `remove` (Trash UX in step 6).
///
/// No method has a default impl. Adding a method to this trait must force
/// every implementor to opt in explicitly — silently inheriting an old
/// behavior was the regression-shape that motivated the redesign.
pub trait SessionsRecorder: Send + Sync {
    /// Insert a fresh row, or transition an existing row back to `live` and
    /// rebind it to `record.card_id`. Called from the bridge on
    /// `session_init`, when the claude session id is first known.
    fn record(&self, record: SessionRecord<'_>);

    /// Increment turn count and bump `last_used_at`. No-op if the row is
    /// missing or not in `live` state — see the trash-vs-late-turn race
    /// note in the plan's risk table.
    fn record_turn(&self, session_id: &str);

    /// Overwrite the row's `turn_count` with the authoritative value — the
    /// `totalTurns` a successful replay reports. Unlike `record_turn` (which
    /// increments), this SETs, reconciling any prior estimate / `MAX` seed to
    /// the segmenter's exact count. Live `record_turn`s then build on this
    /// base. No-op if the row is missing or not in `live` state.
    fn set_turn_count(&self, session_id: &str, count: i64);

    /// `engine(session file)` for `session_id` under `project_dir` — the
    /// single count authority ([P08]). The resume reconcile reads this (the
    /// fingerprint-validated cached value, or the engine run on the resolved
    /// file when no cache entry exists) instead of the wire's `totalTurns`,
    /// so the picker count never shifts on open. `None` when the file is
    /// missing/unreadable or foreign (cwd/sessionId mismatch).
    fn engine_turn_count(&self, session_id: &str, project_dir: &str) -> Option<i64>;

    /// Capture the most-recent user-message text for a session,
    /// truncated to the picker-snippet length. Overwrites the previous
    /// snippet on every call — the picker shows the latest prompt so the
    /// user recognizes the most-recent thread of conversation.
    fn record_user_prompt(&self, session_id: &str, prompt: &str);

    /// Transition the row to `closed` and clear the live-card binding.
    /// Called on `close_session` and on bridge teardown after a successful
    /// `result` event.
    fn mark_closed(&self, session_id: &str);

    /// Transition the row to `failed` and clear the live-card binding.
    /// Called on `resume_failed` and crash-budget exhaustion. Replaces the
    /// pre-ledger semantic of removing the row entirely; the row survives
    /// as a diagnostic crumb until age eviction or explicit Trash.
    fn mark_failed(&self, session_id: &str);

    /// Insert a fresh row in the submission journal for this session.
    /// Called from the supervisor's `dispatch_one` intercept on every
    /// inbound `user_message`, BEFORE the frame is forwarded to tugcode.
    /// The "row-persisted-before-forwarded" invariant means a failure
    /// here drops the inbound frame (the supervisor emits an error frame
    /// on CONTROL); a forwarded frame with no row is structurally
    /// impossible because the forward only happens after this call
    /// returns `Ok`. The journal id is internal to tugcast — it is not
    /// surfaced on the wire and tugcode never sees it. See [DM08] in the
    /// mid-turn-replay plan for the never-drop chain audit.
    ///
    /// Returns `Result` because the dispatcher's decision to forward
    /// depends on insert success. Sibling
    /// `delete_oldest_pending_for_session` runs after the wire-side
    /// broadcast (forward-before-mutate), so its `Result` is treated as
    /// telemetry — the wire is the source of truth for the live UI; the
    /// journal lagging by one update is a warn, not a user-facing error.
    fn insert_pending_turn(
        &self,
        session_id: &str,
        journal_id: &str,
        user_text: &str,
        user_attachments: &[serde_json::Value],
        now: i64,
    ) -> Result<(), crate::session_ledger::LedgerError>;

    /// Delete the oldest pending journal row for `session_id` (FIFO match
    /// by `created_at` ASC). Called from the supervisor's merger
    /// intercept on every outbound `turn_complete` / `turn_cancelled` —
    /// claude has acknowledged the user's submission, so the journal
    /// row's reason for existing (rendering the submission as
    /// awaiting-response on resume) is gone.
    ///
    /// Returns the deleted row's content for logging, or `None` if
    /// there were no pending rows for the session. The frame has
    /// already been broadcast on the code_output feed before this fires
    /// (forward-before-mutate), so a `LedgerError` here is a
    /// telemetry warn, not a user-visible failure.
    fn delete_oldest_pending_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::session_ledger::JournalRow>, crate::session_ledger::LedgerError>;

    /// Record one prompt the **wheel** put on the wire, so a reload can say
    /// who wrote it.
    ///
    /// Claude's JSONL records a prompt the wheel sent exactly as it records
    /// one the user typed — that file is claude's, and Tug cannot stamp
    /// authorship into it. This is Tug's own record, and it is what the
    /// replay translator reads to state authorship instead of inferring it
    /// from where a prompt sits in the file.
    ///
    /// Called by the wheel itself, after the submission is away, from both
    /// doors it speaks through: a rotation's opening prompt and an arc's
    /// later prompts. Failure is telemetry — the submission has already been
    /// dispatched, and a missing record costs a name on one row of a resumed
    /// transcript, never the turn.
    fn record_wheel_prompt(&self, session_id: &str, text: &str);

    /// The ordered chain of claude session ids this session's line of work
    /// passed through — oldest ancestor first, `session_id` last ([P10]).
    ///
    /// A card with no fork edges answers with itself, which is what makes the
    /// restore path that reads this a no-op for every session that is not an
    /// arc. Best-effort by contract: a failed walk answers with what it
    /// walked, never an error, because a restore that shows less history is a
    /// worse restore and a restore that fails is no restore at all.
    fn lineage_chain(&self, session_id: &str) -> Vec<String>;

    /// The arc a session is bound to, if any — the key an arc record is read
    /// under, so the restore can name each stage in the chain.
    fn arc_name_for(&self, session_id: &str) -> Option<String>;

    /// What a rotation seated a session as — its stage label and the model it
    /// seated it on ([P10]).
    ///
    /// On the trait rather than reached for through a `SessionLedger` because
    /// the restore path takes a `&dyn SessionsRecorder`: a writer alone would
    /// leave the columns unreadable from the one place they exist to be read.
    fn stage_provenance(&self, session_id: &str) -> Option<(String, Option<String>)>;

    /// The project directory a session's ledger row records, if the ledger
    /// carries the row — what [`relocation_edge`] compares across a fork edge
    /// to find a directory change ([P05]). The default answers `None`, so a
    /// recorder with no rows finds no edge.
    fn project_dir_of(&self, _session_id: &str) -> Option<String> {
        None
    }
}

/// Production implementation backed by a shared [`SessionLedger`].
///
/// Optionally broadcasts a `session_updated` push frame on the CONTROL feed
/// after each successful write so connected clients can patch their local
/// caches without re-fetching. Production uses the broadcast-enabled
/// constructor; tests use the no-broadcast variant.
pub struct LedgerSessionsRecorder {
    ledger: Arc<crate::session_ledger::SessionLedger>,
    control_tx: Option<broadcast::Sender<Frame>>,
    /// The aggregate-changeset recomposition signal, when the recorder was
    /// given one. Only the rotation seat rings it — see [`SessionsRecorder::record`].
    changeset_all_bump: Option<Arc<tokio::sync::Notify>>,
}

impl LedgerSessionsRecorder {
    #[cfg(test)]
    pub fn new(ledger: Arc<crate::session_ledger::SessionLedger>) -> Self {
        Self {
            ledger,
            control_tx: None,
            changeset_all_bump: None,
        }
    }

    pub fn with_broadcast(
        ledger: Arc<crate::session_ledger::SessionLedger>,
        control_tx: broadcast::Sender<Frame>,
    ) -> Self {
        Self {
            ledger,
            control_tx: Some(control_tx),
            changeset_all_bump: None,
        }
    }

    /// Give the recorder the registry's aggregate-changeset bump, so a seated
    /// binding refreshes the masthead's arc index the way every other binding
    /// writer does. A builder rather than a constructor argument because the
    /// registry outranks the recorder in main's construction order and every
    /// test that wants a recorder wants it without one.
    pub fn with_changeset_bump(mut self, bump: Arc<tokio::sync::Notify>) -> Self {
        self.changeset_all_bump = Some(bump);
        self
    }

    /// Broadcast the current state of `session_id`'s ledger row, if a
    /// control feed is configured. No-op if the row was already deleted by
    /// the time we look it up (eviction race) — the deletion path emits its
    /// own `session_updated { removed: true }` push.
    fn broadcast_row(&self, session_id: &str) {
        let Some(tx) = self.control_tx.as_ref() else {
            return;
        };
        // A push names the line of work, not whichever segment is seated —
        // which is what the row already holds, by the join ([P02]).
        match self.ledger.get(session_id) {
            Ok(Some(row)) => {
                let _ = tx.send(build_session_updated_frame(
                    &row,
                    self.scan_metrics(session_id),
                    self.usage(session_id),
                ));
            }
            Ok(None) => {}
            Err(err) => warn!(error = %err, session_id, "ledger get for broadcast failed"),
        }
    }

    /// The scan-cache pair for a push, best-effort: a read failure degrades to
    /// `None`, which the frame builder turns into "no size, the ledger's own
    /// count" rather than into a failed broadcast.
    fn scan_metrics(&self, session_id: &str) -> Option<crate::session_ledger::SessionScanMetrics> {
        match self.ledger.scan_metrics_for(session_id) {
            Ok(metrics) => metrics,
            Err(err) => {
                warn!(error = %err, session_id, "ledger scan_metrics_for for broadcast failed");
                None
            }
        }
    }

    /// The segment's usage for a push, on the same best-effort terms as
    /// [`Self::scan_metrics`]: a read failure degrades to `None` — the same
    /// value a segment with no telemetry carries — rather than to no push.
    fn usage(&self, session_id: &str) -> Option<crate::session_ledger::SessionUsage> {
        match self.ledger.usage_for(session_id) {
            Ok(usage) => usage,
            Err(err) => {
                warn!(error = %err, session_id, "ledger usage_for for broadcast failed");
                None
            }
        }
    }

    /// The handle a fact files a session under: its callsign when it has one,
    /// else the session id. Read before the transition that prompted the fact,
    /// since some of those transitions are the last moment the row is legible.
    fn session_handle(&self, session_id: &str) -> String {
        self.ledger
            .get(session_id)
            .ok()
            .flatten()
            .and_then(|row| row.tag)
            .unwrap_or_else(|| session_id.to_owned())
    }

    /// Revive a demoted row on live-borne evidence, best-effort. The caller
    /// vouches the event could not have come from replay backfill; the
    /// ledger's own write primitives stay non-resurrecting. A failed revive
    /// warns and the activity write proceeds — it may then no-op on the
    /// still-closed row, which is the pre-existing behavior, not a new hole.
    fn revive_on_activity(&self, session_id: &str, now: i64) {
        match self.ledger.revive_on_activity(session_id, now) {
            Ok(true) => {
                tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "ledger.revive_on_activity",
                    session_id,
                );
                self.broadcast_row(session_id);
            }
            Ok(false) => {}
            Err(err) => {
                warn!(error = %err, session_id, "ledger revive_on_activity failed");
            }
        }
    }

    /// Write one lifecycle fact, best-effort. A failed write warns; it never
    /// gates the transition it describes.
    fn record_lifecycle_fact(&self, fact: &crate::session_ledger::NewFact) {
        if let Err(err) = self.ledger.record_fact(fact) {
            warn!(
                error = %err,
                kind = %fact.kind,
                "lifecycle fact write failed; the session row is unaffected"
            );
        }
    }
}

impl SessionsRecorder for LedgerSessionsRecorder {
    fn record(&self, record: SessionRecord<'_>) {
        let now = crate::session_ledger::now_millis();
        if let Err(err) = self.ledger.record_spawn(
            record.session_id,
            record.workspace_key,
            record.project_dir,
            record.card_id,
            now,
            record.line_id.unwrap_or(record.session_id),
            record.tag,
        ) {
            warn!(error = %err, session_id = record.session_id, "ledger record_spawn failed");
            return;
        }
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "ledger.record_spawn",
            session_id = record.session_id,
            workspace_key = record.workspace_key,
            project_dir = record.project_dir,
            card_id = record.card_id,
        );
        // A rotation mints this segment on a card that may be mid-arc, and
        // the binding is on the segment it just replaced. Carry it forward
        // and announce the mating so the card wears it — the deck's binding
        // store has no other mover, and the surface a rotation blanked could
        // not be repaired by any gesture from inside the seated session
        // ([D167]).
        //
        // The row push goes **before** the `bind_arc_ok`, because the deck
        // routes that announcement by walking segment → line → card and this
        // segment is seconds old: the push carrying `(session_id, line_id)`
        // is how the deck learns the pair at all. Announced first, the walk
        // resolves nothing and the deck drops the frame — the card wears
        // "unbound" for the rest of its arc with no gesture able to repair it.
        // Two frames on one ordered channel, and the order is the whole fix.
        // The announcement carries the line and the card itself as well, so a
        // deck that missed the push still routes: belt and braces, on the one
        // surface nobody inside the card can put right.
        let seated = match self.ledger.seat_line_binding(record.session_id) {
            Ok(seated) => seated,
            Err(err) => {
                warn!(error = %err, session_id = record.session_id, "seat_line_binding failed");
                None
            }
        };
        self.broadcast_row(record.session_id);
        if let Some((arc_id, arc_name)) = seated {
            if let Some(tx) = self.control_tx.as_ref() {
                broadcast_bind_arc_ok(
                    tx,
                    record.session_id,
                    &arc_id,
                    &arc_name,
                    record.line_id,
                    Some(record.card_id),
                );
            }
            // The masthead's arc index derives from `CHANGESET_ALL`, and a
            // seat moves which session an arc reports as bound — the same
            // fact every other binding writer bumps for. Without it the index
            // keeps naming the retired segment until something unrelated
            // happens to recompose it.
            if let Some(bump) = self.changeset_all_bump.as_ref() {
                bump.notify_one();
            }
            tracing::info!(
                target: "dev::ledger",
                event = "ledger.seat_line_binding",
                session_id = record.session_id,
                card_id = record.card_id,
                arc_id = arc_id.as_str(),
            );
        }
    }

    fn record_turn(&self, session_id: &str) {
        let now = crate::session_ledger::now_millis();
        // A live turn is proof of a running subprocess — the bridge only
        // calls this outside replay. A row the startup demote closed under
        // a surviving agent revives here, or the live-gated write below
        // silently no-ops and the ledger goes on misreporting the session.
        self.revive_on_activity(session_id, now);
        if let Err(err) = self.ledger.record_turn(session_id, now) {
            warn!(error = %err, session_id, "ledger record_turn failed");
            return;
        }
        tracing::debug!(
            target: "dev::session-lifecycle",
            event = "ledger.record_turn",
            session_id,
        );
        self.broadcast_row(session_id);
    }

    fn set_turn_count(&self, session_id: &str, count: i64) {
        let now = crate::session_ledger::now_millis();
        if let Err(err) = self.ledger.set_turn_count(session_id, count, now) {
            warn!(error = %err, session_id, count, "ledger set_turn_count failed");
            return;
        }
        tracing::debug!(
            target: "dev::session-lifecycle",
            event = "ledger.set_turn_count",
            session_id,
            count,
        );
        self.broadcast_row(session_id);
    }

    fn engine_turn_count(&self, session_id: &str, project_dir: &str) -> Option<i64> {
        crate::external_sessions::engine_turn_count(&self.ledger, project_dir, session_id)
    }

    fn record_user_prompt(&self, session_id: &str, prompt: &str) {
        // A prompt only arrives on the live input relay — never from replay
        // backfill — so it is proof of activity the same way a turn is.
        self.revive_on_activity(session_id, crate::session_ledger::now_millis());
        if let Err(err) = self.ledger.record_user_prompt(session_id, prompt) {
            // `NotFound` means the row was never created (claude_session_id
            // was missing from `session_init`). Other errors are real
            // sqlite failures worth logging at warn level.
            match err {
                crate::session_ledger::LedgerError::NotFound(_) => {}
                _ => warn!(error = %err, session_id, "ledger record_user_prompt failed"),
            }
            return;
        }
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "ledger.record_user_prompt",
            session_id,
            len = prompt.chars().count(),
        );
        self.broadcast_row(session_id);
    }

    fn mark_closed(&self, session_id: &str) {
        let handle = self.session_handle(session_id);
        let transitioned = match self.ledger.mark_closed(session_id) {
            Ok(transitioned) => transitioned,
            Err(err) => {
                warn!(error = %err, session_id, "ledger mark_closed failed");
                return;
            }
        };
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "ledger.mark_closed",
            session_id,
        );
        // The fact rides the durable transition rather than any one of the
        // several `closed` publish sites, and only when a row really moved —
        // so a session that ended once has one ending in the fact base however
        // many paths call this for it.
        if transitioned {
            self.record_lifecycle_fact(&crate::feeds::facts_library::session_end_fact(
                crate::session_ledger::now_millis(),
                session_id,
                false,
                &handle,
                None,
            ));
        }
        self.broadcast_row(session_id);
    }

    fn mark_failed(&self, session_id: &str) {
        let handle = self.session_handle(session_id);
        let transitioned = match self.ledger.mark_failed(session_id) {
            Ok(transitioned) => transitioned,
            Err(err) => {
                warn!(error = %err, session_id, "ledger mark_failed failed");
                return;
            }
        };
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "ledger.mark_failed",
            session_id,
        );
        if transitioned {
            self.record_lifecycle_fact(&crate::feeds::facts_library::session_end_fact(
                crate::session_ledger::now_millis(),
                session_id,
                true,
                &handle,
                None,
            ));
        }
        self.broadcast_row(session_id);
    }

    fn insert_pending_turn(
        &self,
        session_id: &str,
        journal_id: &str,
        user_text: &str,
        user_attachments: &[serde_json::Value],
        now: i64,
    ) -> Result<(), crate::session_ledger::LedgerError> {
        self.ledger.insert_pending_turn(
            session_id,
            journal_id,
            user_text,
            user_attachments,
            now,
        )?;
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "ledger.insert_pending_turn",
            session_id,
            journal_id,
        );
        Ok(())
    }

    fn delete_oldest_pending_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::session_ledger::JournalRow>, crate::session_ledger::LedgerError> {
        let popped = self.ledger.delete_oldest_pending_for_session(session_id)?;
        if let Some(row) = popped.as_ref() {
            tracing::info!(
                target: "dev::ledger",
                event = "turn_seen_journal_row_deleted",
                session_id,
                journal_id = %row.journal_id,
            );
        }
        Ok(popped)
    }

    fn record_wheel_prompt(&self, session_id: &str, text: &str) {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        match self.ledger.record_wheel_prompt(
            session_id,
            &prompt_id,
            text,
            crate::session_ledger::now_millis(),
        ) {
            Ok(true) => tracing::info!(
                target: "dev::session-lifecycle",
                event = "ledger.record_wheel_prompt",
                session_id,
                prompt_id,
            ),
            Ok(false) => tracing::warn!(
                target: "dev::session-lifecycle",
                event = "ledger.record_wheel_prompt_unknown_session",
                session_id,
                "the wheel spoke on a session the ledger does not carry; a reload \
                 will attribute this prompt to the user",
            ),
            Err(err) => tracing::warn!(
                target: "dev::session-lifecycle",
                event = "ledger.record_wheel_prompt_failed",
                session_id,
                error = %err,
            ),
        }
    }

    fn lineage_chain(&self, session_id: &str) -> Vec<String> {
        self.ledger.lineage_chain(session_id)
    }

    fn stage_provenance(&self, session_id: &str) -> Option<(String, Option<String>)> {
        self.ledger.stage_provenance(session_id)
    }

    fn project_dir_of(&self, session_id: &str) -> Option<String> {
        match self.ledger.get(session_id) {
            Ok(row) => row.map(|r| r.project_dir),
            Err(err) => {
                warn!(error = %err, session_id, "ledger get for the project dir failed");
                None
            }
        }
    }

    fn arc_name_for(&self, session_id: &str) -> Option<String> {
        match self.ledger.get(session_id) {
            Ok(row) => row.and_then(|r| r.arc_name),
            Err(err) => {
                warn!(error = %err, session_id, "ledger get for the arc binding failed");
                None
            }
        }
    }
}

/// The ordered lineage a `request_replay` carries, or `None` when there is
/// nothing to carry ([P10]).
///
/// An arc spreads one line of work across a JSONL per stage, and a card that
/// replays only its own shows a transcript that begins in the middle. This
/// walks the fork edges parent-ward and names each session in the chain,
/// attaching the stage each one runs from the arc log's `arc-stage` lines —
/// the same record the runner drives the arc from, so what the transcript
/// says a stage was and what the arc actually did cannot drift.
///
/// `None` on the two cases that are the same case: a chain of one (no forks,
/// which is nearly every card) and a chain with no arc record behind it (a
/// rewind-fork lineage, which tugcode already replays correctly by resuming
/// the tip). Both leave the request byte-identical to today's.
pub(super) fn replay_lineage(
    recorder: &dyn SessionsRecorder,
    claude_session_id: &str,
    project_dir: &Path,
) -> Option<Vec<serde_json::Value>> {
    let chain = recorder.lineage_chain(claude_session_id);
    // A directory change forks the conversation into another directory, and
    // the fork's own JSONL already carries what it inherited ([P04]). So the
    // lineage stops at the first cross-directory edge: only the same-directory
    // ancestors below it are this card's to replay.
    let chain = match directory_edge_index(recorder, &chain) {
        Some(child) => chain[child..].to_vec(),
        None => chain,
    };
    if chain.len() < 2 {
        return None;
    }
    // The binding lives on the card's own row — the tug session id the deck
    // spawned with, which is the chain's oldest entry. A stage row never
    // carries it: a rotation's `session_init` records a fresh row, and only
    // `arc bind` / `arc run` ever write a binding — so asking the head alone
    // would find nothing on every arc that has rotated once.
    // An arc, if there is one. There need not be: a rotation with nothing
    // driving it has no arc binding and no arc record, and its transcript is
    // just as much an invariant of the rotation as an arc's ([B05]). So
    // the arc supplies only the two facts that are genuinely its — the arc
    // name and the document it opened on — and the rest comes off the row.
    let arc = chain
        .iter()
        .find_map(|id| recorder.arc_name_for(id))
        .and_then(|arc| tugarc_core::arc::read_arc(project_dir, &arc).map(|record| (arc, record)));
    let entries: Vec<serde_json::Value> = chain
        .iter()
        .map(|session_id| {
            let recorded = recorder.stage_provenance(session_id);
            let logged = arc
                .as_ref()
                .and_then(|(_, record)| record.stages.iter().find(|s| &s.session_id == session_id));
            // The row is the answer; the arc record is the fallback for a row
            // written before the columns existed, so an arc that rotated on an
            // older build replays exactly as it did.
            let seated = recorded
                .map(|(label, model)| (label, model.unwrap_or_default()))
                .or_else(|| {
                    logged.map(|stage| {
                        (
                            stage.stage.as_str().to_string(),
                            stage.model.clone().unwrap_or_default(),
                        )
                    })
                });
            let mut entry = serde_json::Map::new();
            entry.insert("sessionId".into(), serde_json::json!(session_id));
            if let Some((label, model)) = seated {
                entry.insert("stage".into(), serde_json::json!(label));
                entry.insert("model".into(), serde_json::json!(model));
                // The arc's own two facts, and only where an arc seated this
                // entry — an arcless rotation names neither.
                if let (Some((arc, record)), Some(_)) = (arc.as_ref(), logged) {
                    entry.insert("arc".into(), serde_json::json!(arc));
                    if let Some(document) = record.plan.as_ref().or(record.document.as_ref()) {
                        entry.insert("document".into(), serde_json::json!(document));
                    }
                }
            }
            serde_json::Value::Object(entry)
        })
        .collect();
    // A chain whose every entry is stage-less is a fork lineage, not a
    // rotation's — nothing to divide, so nothing to send.
    if entries.iter().all(|e| e.get("stage").is_none()) {
        return None;
    }
    Some(entries)
}

/// The index of the child in the tip-most fork edge whose two rows record
/// different project directories, if any.
///
/// Directories compare by canonical path, where one resolves, so a symlinked
/// spelling of the same directory is not a move.
fn directory_edge_index(recorder: &dyn SessionsRecorder, chain: &[String]) -> Option<usize> {
    let canonical = |dir: String| {
        std::fs::canonicalize(&dir)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(dir)
    };
    let dirs: Vec<Option<String>> = chain
        .iter()
        .map(|id| recorder.project_dir_of(id).map(canonical))
        .collect();
    (1..chain.len())
        .rev()
        .find(|&child| match (&dirs[child - 1], &dirs[child]) {
            (Some(parent), Some(child)) => parent != child,
            _ => false,
        })
}

/// The directory change a session's line of work passed through — its
/// `(parent session, from dir, to dir)` — or `None` for a line that never
/// left its directory ([P05]).
///
/// Walks the lineage from the tip parent-ward and answers the first fork
/// edge whose two rows record different project directories. That edge is
/// what a `request_replay` names as its `relocation`, so tugcode can draw the
/// `Directory changed` divider on every replay after the first turn.
pub(super) fn relocation_edge(
    recorder: &dyn SessionsRecorder,
    session_id: &str,
) -> Option<(String, String, String)> {
    let chain = recorder.lineage_chain(session_id);
    let child = directory_edge_index(recorder, &chain)?;
    let parent = chain[child - 1].clone();
    let from_dir = recorder.project_dir_of(&parent)?;
    let to_dir = recorder.project_dir_of(&chain[child])?;
    Some((parent, from_dir, to_dir))
}

/// Build the `session_updated` push payload for a row's current state.
/// Public so the `do_trash_session` / `do_trash_project_dir_sessions`
/// handlers can emit the matching frame after their batch writes.
///
/// `metrics` is the session's `external_scan_cache` pair, and **every** caller
/// looks it up — not just the one pushing after a turn. The client replaces its
/// cached row wholesale on a push, so a push that omits a fact downgrades it:
/// without the lookup, an unrelated rename push would null a known `file_size`
/// and knock a scan-derived `turn_count` to whatever sparse `0` the `sessions`
/// row happens to hold. `None` (no scan-cache row — a session the scanner has
/// never seen) emits a null size and the ledger row's own count, which is the
/// right answer for that case.
///
/// Kept pure — it takes the pair, not a ledger handle — so each caller does its
/// own lookup beside the `ledger.get` it already performs.
pub fn build_session_updated_frame(
    row: &crate::session_ledger::SessionRow,
    metrics: Option<crate::session_ledger::SessionScanMetrics>,
    usage: Option<crate::session_ledger::SessionUsage>,
) -> Frame {
    let body = serde_json::json!({
        "action": "session_updated",
        "session_id": row.session_id,
        "fields": {
            "session_id": row.session_id,
            "workspace_key": row.workspace_key,
            "project_dir": row.project_dir,
            "created_at": row.created_at,
            "last_used_at": row.last_used_at,
            "turn_count": metrics.map_or(row.turn_count, |m| m.turn_count),
            "file_size": metrics.map(|m| m.file_size),
            "last_user_prompt": row.last_user_prompt,
            "state": row.state,
            "card_id": row.card_id,
            // The line this segment belongs to ([P01]). Every identity field
            // beside it is the line's, read through the join, so a push that
            // omitted this would hand the deck a name it could not key.
            "line_id": row.line_id,
            "name": row.name,
            "name_user_set": row.name_user_set,
            "tag": row.tag,
            "synopsis": row.synopsis,
            // Privacy is a resting state, so it has to reach the deck: a chip
            // that only showed the transition ack would go quiet on reload and
            // leave a session silently un-narrated with nothing saying why
            // ([P05]).
            "private": row.private,
        },
        // What the segment cost, beside the row rather than on it: `usage` is
        // a `SUM` over another table, not a `sessions` column, and the arc
        // receipt's stage row is the surface that reads it. Looked up by every
        // caller for the same reason `metrics` is — the client replaces its
        // cached entry wholesale, so a push that omitted it would blank a
        // figure the reader is looking at.
        "usage": usage,
    });
    Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("session_updated serializes"),
    )
}

/// Build the `session_line_rebound` push — a card's line changed under it.
///
/// Sent on exactly one gesture: a plain `/new`, which is the one id change
/// that means "a different conversation" and so births a line rather than
/// joining the card's ([P03]). Everything else is another segment of the line
/// the card already has, and needs no push because nothing moved.
///
/// The deck's binding follows this, and with it every store keyed by line —
/// the name, the callsign, the description, the side-question history.
pub fn build_session_line_rebound_frame(
    card_id: &str,
    tug_session_id: &str,
    line: &crate::session_ledger::LineRow,
) -> Frame {
    let body = serde_json::json!({
        "action": "session_line_rebound",
        "card_id": card_id,
        "tug_session_id": tug_session_id,
        "line_id": line.line_id,
        "tag": line.tag,
        "name": line.name,
        "name_user_set": line.name_user_set,
    });
    Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("session_line_rebound serializes"),
    )
}

/// Build the `session_line_seated` push — the card's line moved to a new
/// segment, and the card's seat must move with it.
///
/// **`session_line_rebound`'s twin, for the case that is not a new line.** A
/// plain `/new` births a line and has its own frame; every other id change — a
/// rotation above all — is another segment of the line the card already has,
/// and the comment on that frame used to say such a change "needs no push
/// because nothing moved". Something did move: which segment the card is
/// seated on, which is what every identity read of a live card resolves
/// through. Without this frame the deck's answer was derived from whichever
/// row push landed last, and two live rows on one line — which is exactly what
/// a rotation leaves, since the retired segment's row stays `live` until the
/// card closes — made that answer a coin toss (`at0503` caught it as one).
///
/// So the seat is announced rather than inferred: the card by name, the
/// segment, and the line, from the one place that knows all three at once.
/// Skew is free in both directions — an older deck ignores an action it has no
/// handler for, and a newer deck against an older server simply never learns
/// the seat moved, which is where it was before this frame existed.
pub fn build_session_line_seated_frame(
    card_id: &str,
    tug_session_id: &str,
    session_id: &str,
    line_id: &str,
) -> Frame {
    let body = serde_json::json!({
        "action": "session_line_seated",
        "card_id": card_id,
        "tug_session_id": tug_session_id,
        "session_id": session_id,
        "line_id": line_id,
    });
    Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("session_line_seated serializes"),
    )
}

/// Build the `session_updated { removed: true }` push for a deleted row.
pub fn build_session_removed_frame(session_id: &str) -> Frame {
    let body = serde_json::json!({
        "action": "session_updated",
        "session_id": session_id,
        "removed": true,
    });
    Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("session_updated removed serializes"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Notify;

    // ── LedgerSessionsRecorder lifecycle ─────────────────────────────────────
    //
    // These tests exercise the recorder against a real in-memory
    // [`SessionLedger`] — no mocks, no call-count assertions. The contract
    // under test is "when the trait method runs, the ledger row reaches the
    // expected state." Each test traces one CRUD trajectory.

    use crate::session_ledger::{SessionLedger, SessionState as LedgerState};

    fn fresh_ledger_recorder() -> (Arc<SessionLedger>, Arc<dyn SessionsRecorder>) {
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
        let recorder: Arc<dyn SessionsRecorder> =
            Arc::new(LedgerSessionsRecorder::new(Arc::clone(&ledger)));
        (ledger, recorder)
    }

    #[test]
    fn ledger_recorder_record_inserts_live_row() {
        let (ledger, recorder) = fresh_ledger_recorder();
        recorder.record(SessionRecord {
            session_id: "claude-abc",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: None,
        });
        let row = ledger.get("claude-abc").unwrap().expect("row");
        assert_eq!(row.workspace_key, "ws-1");
        assert_eq!(row.project_dir, "/proj/x");
        assert_eq!(row.card_id.as_deref(), Some("card-1"));
        assert_eq!(row.state, LedgerState::Live);
        assert_eq!(row.turn_count, 0);
    }

    /// The ledger (the source of truth for sessions) publishes a "sessions
    /// changed" signal on every session-lifecycle write, so a delegate — the
    /// CHANGESET_ALL aggregate — recomputes on a spawn / turn / close with no
    /// poll. Driven through the recorder (the production write path) to prove
    /// the whole chain: recorder → ledger write → published signal.
    #[tokio::test]
    async fn ledger_publishes_change_on_session_lifecycle() {
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("ledger open"));
        let signal = Arc::new(Notify::new());
        ledger.set_change_signal(Arc::clone(&signal));
        let recorder = LedgerSessionsRecorder::new(Arc::clone(&ledger));

        let expect_ping = |signal: Arc<Notify>, what: &'static str| async move {
            tokio::time::timeout(std::time::Duration::from_millis(200), signal.notified())
                .await
                .unwrap_or_else(|_| panic!("{what} must publish a sessions-changed signal"));
        };

        recorder.record(SessionRecord {
            session_id: "claude-abc",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: None,
        });
        expect_ping(Arc::clone(&signal), "record (spawn)").await;

        recorder.record_turn("claude-abc");
        expect_ping(Arc::clone(&signal), "record_turn").await;

        recorder.mark_closed("claude-abc");
        expect_ping(Arc::clone(&signal), "mark_closed").await;
    }

    #[test]
    fn ledger_recorder_record_user_prompt_overwrites_snippet() {
        let (ledger, recorder) = fresh_ledger_recorder();
        recorder.record(SessionRecord {
            session_id: "claude-abc",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: None,
        });
        recorder.record_user_prompt("claude-abc", "hello world");
        let row = ledger.get("claude-abc").unwrap().unwrap();
        assert_eq!(row.last_user_prompt.as_deref(), Some("hello world"));

        // Subsequent calls overwrite — the picker shows the latest prompt.
        recorder.record_user_prompt("claude-abc", "second turn");
        let row = ledger.get("claude-abc").unwrap().unwrap();
        assert_eq!(row.last_user_prompt.as_deref(), Some("second turn"));
    }

    #[test]
    fn ledger_recorder_record_turn_then_close_full_lifecycle() {
        let (ledger, recorder) = fresh_ledger_recorder();
        recorder.record(SessionRecord {
            session_id: "claude-abc",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: None,
        });
        // Live turns touch recency only; the count is the engine reconcile
        // ([P08]). Reconcile to 3, then live turns leave the count untouched.
        recorder.set_turn_count("claude-abc", 3);
        recorder.record_turn("claude-abc");
        recorder.record_turn("claude-abc");
        recorder.mark_closed("claude-abc");

        let row = ledger.get("claude-abc").unwrap().expect("row");
        assert_eq!(row.turn_count, 3);
        assert_eq!(row.state, LedgerState::Closed);
        // card_id is preserved across mark_closed under the new
        // semantics — the persisted row keeps the binding so client-side
        // restore can reconstruct it.
        assert_eq!(row.card_id.as_deref(), Some("card-1"));
    }

    /// A session ends once. Several paths call `mark_closed` for one ending —
    /// a close after a startup demote, a teardown after the close — and the
    /// lifecycle fact hangs off whether a row really moved, not off the call.
    #[test]
    fn ledger_recorder_records_one_ending_however_often_close_is_called() {
        let (ledger, recorder) = fresh_ledger_recorder();
        recorder.record(SessionRecord {
            session_id: "claude-abc",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: None,
        });

        recorder.mark_closed("claude-abc");
        recorder.mark_closed("claude-abc");
        recorder.mark_closed("claude-abc");

        let endings = ledger
            .facts_for_test()
            .into_iter()
            .filter(|(kind, _, _)| kind == "session.closed")
            .count();
        assert_eq!(endings, 1, "one ending in the fact base");
        assert_eq!(
            ledger.get("claude-abc").unwrap().unwrap().state,
            LedgerState::Closed
        );
    }

    #[test]
    fn ledger_recorder_mark_failed_retains_row() {
        let (ledger, recorder) = fresh_ledger_recorder();
        recorder.record(SessionRecord {
            session_id: "claude-abc",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: None,
        });
        recorder.mark_failed("claude-abc");

        let row = ledger.get("claude-abc").unwrap().expect("row retained");
        assert_eq!(row.state, LedgerState::Failed);
        assert_eq!(row.card_id.as_deref(), Some("card-1"));
    }

    #[test]
    fn ledger_recorder_record_turn_no_op_after_close() {
        // Late `result` events that arrive after the user closes the card
        // must not mutate the ledger row — the row is "done."
        let (ledger, recorder) = fresh_ledger_recorder();
        recorder.record(SessionRecord {
            session_id: "claude-abc",
            workspace_key: "ws-1",
            project_dir: "/proj/x",
            card_id: "card-1",
            tag: None,
            line_id: None,
        });
        recorder.mark_closed("claude-abc");
        recorder.record_turn("claude-abc");
        let row = ledger.get("claude-abc").unwrap().expect("row");
        assert_eq!(row.turn_count, 0);
        assert_eq!(row.state, LedgerState::Closed);
    }
}
