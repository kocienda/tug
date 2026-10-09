//! The session lifecycle family of CONTROL actions: `spawn_session`,
//! `close_session`, `reset_session`, `list_sessions`, `list_card_bindings`,
//! `resolve_sessions`, and `request_replay`. The spawn itself
//! (`do_spawn_session`) lives in the parent with its spawn-state machinery.

use super::super::*;

fn parse_session_ids_payload(payload: &[u8]) -> Result<Vec<String>, ControlError> {
    /// The most ids one request may name.
    const MAX_IDS: usize = 512;
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let ids = value
        .get("ids")
        .and_then(|v| v.as_array())
        .ok_or(ControlError::Malformed)?;
    if ids.len() > MAX_IDS {
        warn!(
            asked = ids.len(),
            cap = MAX_IDS,
            "resolve_sessions: request over the cap, answering the first {MAX_IDS}"
        );
    }
    Ok(ids
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .take(MAX_IDS)
        .map(str::to_owned)
        .collect())
}

/// Extract the optional recency `window` from a `request_replay` CONTROL
/// payload. The supervisor forwards it verbatim into the `request_replay`
/// verb it pushes to tugcode, which validates the shape at its handler
/// boundary; an absent / null / malformed payload yields `None` ⇒ a full
/// replay (the legacy behavior). Parse failures are intentionally
/// swallowed here — `parse_tug_session_id_payload` already rejected a
/// truly malformed payload before this is called.
fn parse_request_replay_window(payload: &[u8]) -> Option<serde_json::Value> {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("window").cloned())
        .filter(|w| !w.is_null())
}

impl AgentSupervisor {
    /// The session lifecycle family's share of
    /// [`AgentSupervisor::handle_control`]: the same arms, the same replies,
    /// reached through one delegating arm there.
    pub(in crate::feeds::agent_supervisor) async fn handle_session_control(
        &self,
        action: &str,
        payload: &[u8],
        client_id: ClientId,
    ) -> ControlOutcome {
        let result: Result<(), ControlError> = match action {
            "spawn_session" => {
                let parsed = match parse_control_payload_owned(payload) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected spawn_session");
                        return ControlOutcome::Error(e);
                    }
                };
                // project_dir is required on spawn per.
                let project_dir_str =
                    match parsed.project_dir.ok_or(ControlError::InvalidProjectDir {
                        reason: "missing_project_dir",
                    }) {
                        Ok(s) => s,
                        Err(e) => return ControlOutcome::Error(e),
                    };
                self.do_spawn_session(
                    &parsed.card_id,
                    parsed.tug_session_id,
                    project_dir_str,
                    parsed.session_mode,
                    parsed.permission_mode,
                    parsed.tag,
                    parsed.line_id,
                    parsed.relocate_from.map(TugSessionId::new),
                    client_id,
                )
                .await
            }
            "close_session" => {
                let parsed = match parse_control_payload_owned(payload) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected close_session");
                        return ControlOutcome::Error(e);
                    }
                };
                self.close_card_session(&parsed.card_id, &parsed.tug_session_id)
                    .await;
                Ok(())
            }
            "reset_session" => {
                let parsed = match parse_control_payload_owned(payload) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected reset_session");
                        return ControlOutcome::Error(e);
                    }
                };
                // W2 [D11]: reset preserves the workspace binding. We do NOT
                // close-then-spawn here because that would release the
                // workspace and (potentially) tear down its feeds.
                self.do_reset_session(&parsed.card_id, &parsed.tug_session_id, client_id)
                    .await;
                Ok(())
            }
            "list_sessions" => match parse_project_dir_payload(payload) {
                Ok(project_dir) => {
                    self.do_list_sessions(&project_dir).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "list_card_bindings" => {
                self.do_list_card_bindings().await;
                Ok(())
            }
            "resolve_sessions" => match parse_session_ids_payload(payload) {
                Ok(ids) => {
                    self.do_resolve_sessions(&ids).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "request_replay" => {
                let tug_session_id = match parse_tug_session_id_payload(payload) {
                    Ok(id) => id,
                    Err(e) => {
                        warn!(action, error = %e, "handle_control: rejected request_replay");
                        return ControlOutcome::Error(e);
                    }
                };
                let window = parse_request_replay_window(payload);
                self.do_request_replay(&tug_session_id, window).await;
                Ok(())
            }
            _ => return ControlOutcome::PassThrough,
        };

        match result {
            Ok(()) => ControlOutcome::Handled,
            Err(e) => ControlOutcome::Error(e),
        }
    }

    pub(in crate::feeds::agent_supervisor) async fn do_close_session(
        &self,
        card_id: &str,
        tug_session_id: &TugSessionId,
    ) {
        // Phase 1: remove the ledger entry AND drop the id from every client's
        // affinity set, atomically under ledger_lock + client_sessions_lock.
        // Cleaning across all clients (not just `_client_id`) guarantees the
        // close/spawn race test's self-consistency invariant: after a close,
        // NO client_sessions set references the removed id. An unknown id
        // short-circuits here with no side effects (no tugbank interaction,
        // no SESSION_STATE publish, no lock on `client_sessions`).
        let entry_arc = {
            let mut ledger = self.ledger.lock().await;
            let removed = ledger.remove(tug_session_id);
            if removed.is_some() {
                let mut cs = self.client_sessions.lock().await;
                for set in cs.values_mut() {
                    set.remove(tug_session_id);
                }
            }
            removed
        };

        let Some(entry_arc) = entry_arc else {
            return;
        };

        // Phase 2: per-session mutation. Cancel the worker token AND flip
        // `spawn_state` to `Closed`. Flipping the state matters even though
        // the entry has just been removed from the map: a `spawn_session_worker`
        // that raced us — dispatcher flipped `Idle → Spawning`, called
        // `spawn_session_worker`, and the worker grabbed its own `Arc` clone
        // via `ledger.get(id)` BEFORE our `HashMap::remove` — is still
        // holding an `Arc<Mutex<LedgerEntry>>` clone and would otherwise
        // observe `spawn_state == Spawning` and proceed to publish
        // `SESSION_STATE = spawning` AFTER our `closed`. Setting the state to
        // `Closed` here lets the worker's early-bail check (`if state !=
        // Spawning { return }`) catch the close and skip its publish,
        // preserving frame order on the wire.
        //
        // Also snapshot the `workspace_key` and `claude_session_id` under
        // this same lock so Phase 3 can call `registry.release` and Phase 5
        // can mark the ledger row closed without re-acquiring it.
        let (workspace_key, claude_session_id, held_refcount) = {
            let mut entry = entry_arc.lock().await;
            entry.cancel.cancel();
            // Bare assignment (not `try_transition`) because the entry is
            // about to be dropped; we only care that any Arc-clone holder
            // observes `Closed` on its next lock acquire.
            entry.spawn_state = SpawnState::Closed;
            // Take the refcount ownership: release it below iff this entry
            // adopted one. A rebind entry closed before it ever spawned holds
            // none — releasing then would decrement another card's refcount for
            // the same workspace, or error on `UnknownKey`.
            let held = entry.holds_workspace_refcount;
            entry.holds_workspace_refcount = false;
            // `card_id` is preserved across close so the persisted
            // ledger row retains the binding for client-side restore;
            // liveness is encoded in `spawn_state`.
            (
                entry.workspace_key.clone(),
                entry.claude_session_id.clone(),
                held,
            )
        };

        // Phase 3: release the workspace refcount this entry owned. Errors on
        // this path (e.g. `UnknownKey` from a double-close race) are logged and
        // swallowed — they indicate a caller-side logic error, not a condition
        // worth propagating to the wire.
        if held_refcount {
            if let Err(e) = self.registry.release(&workspace_key) {
                warn!(
                    card_id,
                    session = %tug_session_id,
                    error = %e,
                    "close_session: workspace release failed, continuing"
                );
            }
        }

        // The persisted ledger row is preserved across close — a
        // closed card can be reopened with history through
        // `rebind_from_ledger` on the next startup. The explicit
        // `reset_session` flow is the only path that invalidates the
        // session_id; close is a "stop the subprocess but keep the
        // history pointer" operation.

        // Phase 5: publish `closed`. (The `Arc<Mutex<LedgerEntry>>` we hold
        // is dropped at the end of this scope.)
        self.session_state.publish_tagged(build_session_state_frame(
            tug_session_id,
            "closed",
            None,
        ));

        // Phase 6: transition the ledger row to `closed`. Pre-handshake
        // sessions never reached `session_init` and have no row, so the
        // `claude_session_id` snapshot is `None` — nothing to mark closed.
        if let Some(claude_id) = claude_session_id {
            // Before the row goes closed, while the binding still names the
            // arc: a card seated by a stage takes its arc out of the sweep
            // when it closes, and an arc that left with no record would say
            // `review` forever with nothing running.
            if let Some(ledger) = self.session_ledger.as_ref() {
                crate::arc_api::stop_an_on_arc_cards_arc_as_closed(ledger, &claude_id);
            }
            self.sessions_recorder.mark_closed(&claude_id);
        }
    }

    /// Broadcast a `list_sessions_ok` frame. `scanning` is `true` for the
    /// cheap phase-1 emit (ledger rows only, external scan still running)
    /// and `false` for the settled phase-2 emit carrying the full union —
    /// the picker shows a scanning indicator while `true` and clears it
    /// when the `false` frame replaces the snapshot.
    fn send_list_sessions_ok(
        control_tx: &broadcast::Sender<Frame>,
        project_dir: &str,
        dir_exists: bool,
        sessions: &[ListedSession],
        scanning: bool,
    ) {
        let body = serde_json::json!({
            "action": "list_sessions_ok",
            "project_dir": project_dir,
            "dir_exists": dir_exists,
            "scanning": scanning,
            "sessions": sessions,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_sessions_ok serializes"),
        ));
    }

    fn send_list_sessions_err(control_tx: &broadcast::Sender<Frame>, project_dir: &str) {
        let body = serde_json::json!({
            "action": "list_sessions_err",
            "project_dir": project_dir,
            "reason": "ledger_read_failed",
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_sessions_err serializes"),
        ));
    }

    /// Handle a `list_sessions` CONTROL request. Broadcasts a
    /// `list_sessions_ok` response carrying the **union** of:
    ///
    /// - sqlite ledger rows whose `project_dir` matches the requested
    ///   path (`origin: "tug"`), and
    /// - on-disk session JSONLs discovered under the encoded claude
    ///   project directory that have no ledger row
    ///   (`origin: "external"` — typically terminal-created sessions).
    ///
    /// Deduped by session id (ledger wins — it carries richer,
    /// Tug-authored metadata), sorted newest-first by `last_used_at`.
    /// Every row — both origins — is annotated with `terminal_live`
    /// when a live process registered in `~/.claude/sessions/`
    /// currently holds it.
    ///
    /// Emitted in **two phases** so the picker never blocks on the scan
    /// (see the inline phase comments and Risk R03): a cheap phase-1
    /// `list_sessions_ok { scanning: true }` with the ledger rows lands
    /// immediately, then a settled phase-2 `{ scanning: false }` with the
    /// full union lands once the off-loop JSONL scan completes. The client
    /// replaces its snapshot on each, so external rows stream in.
    ///
    /// The response also carries `dir_exists` — a filesystem check on
    /// `project_dir` — so the picker can disable its Open button before
    /// a doomed `spawn_session` is ever sent. tugdeck has no filesystem
    /// access of its own, so this read piggybacks on the per-path query
    /// the picker already issues.
    async fn do_list_sessions(&self, project_dir: &str) {
        // `false` covers both a missing path and a non-directory — the
        // picker only needs the binary "is this an openable directory"
        // signal.
        let dir_exists = tokio::fs::metadata(project_dir)
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);
        let Some(ledger) = self.session_ledger.as_ref() else {
            // No ledger wired — emit an empty, settled response so a
            // confused client doesn't sit on a pending state forever.
            Self::send_list_sessions_ok(&self.control_tx, project_dir, dir_exists, &[], false);
            return;
        };

        let ledger_arc = Arc::clone(ledger);
        let registry_root = self.terminal_registry_root();
        let control_tx = self.control_tx.clone();
        let pd = project_dir.to_owned();

        // ── Phase 1: cheap reads (sqlite ledger + the handful of tiny
        //    `~/.claude/sessions` registry files). Emitted IMMEDIATELY so
        //    the picker shows "New session" plus every resumable ledger
        //    row without waiting on the JSONL scan — which on a large
        //    project dir (this repo's claude dir is ~1k files / multi-GB)
        //    can take many seconds (Risk R03). Pressing Cmd-N must never
        //    block on the scan; before this split it froze the dialog for
        //    the full scan duration.
        let phase1 = tokio::task::spawn_blocking({
            let ledger_arc = Arc::clone(&ledger_arc);
            let registry_root = registry_root.clone();
            let pd = pd.clone();
            move || {
                let rows = ledger_arc.list_for_project_dir(&pd)?;
                let live = Self::read_terminal_live_sessions(registry_root.as_deref());
                Ok::<_, crate::session_ledger::LedgerError>((rows, live))
            }
        })
        .await;
        let (rows, live) = match phase1 {
            Ok(Ok(t)) => t,
            Ok(Err(err)) => {
                warn!(error = %err, project_dir, "list_sessions phase 1 failed");
                Self::send_list_sessions_err(&control_tx, project_dir);
                return;
            }
            Err(join_err) => {
                warn!(error = %join_err, project_dir, "list_sessions worker panicked");
                Self::send_list_sessions_err(&control_tx, project_dir);
                return;
            }
        };

        // Phase 1 emit: ledger-only preview, scan still pending.
        let ledger_preview = build_listed_union(rows, &live, None);
        Self::send_list_sessions_ok(&control_tx, project_dir, dir_exists, &ledger_preview, true);

        // ── Phase 2: the expensive JSONL scan, run off the control loop in
        //    a detached task. Re-reads the ledger + liveness **fresh**
        //    alongside the scan, so any `session_updated` that lands during
        //    the scan window is reflected in the settled frame instead of
        //    being clobbered by the stale phase-1 snapshot. Emits the
        //    authoritative union (scanning: false); the client replaces its
        //    snapshot, so external/terminal rows stream in and the scanning
        //    indicator clears. The scan resolves the typed path to claude's
        //    canonical directory internally (the `claude_project_dir`
        //    chokepoint).
        let project_dir_owned = project_dir.to_owned();
        // Phase-1 preview, retained only as the settle-with-rows fallback if
        // the phase-2 worker panics (effectively unreachable — its body
        // cannot panic on well-formed input — but keeps the indicator from
        // ever spinning forever).
        let preview_fallback = ledger_preview;
        tokio::spawn(async move {
            let progress_tx = control_tx.clone();
            let built = tokio::task::spawn_blocking(move || {
                let rows = ledger_arc.list_for_project_dir(&pd).unwrap_or_else(|err| {
                    warn!(error = %err, "list_sessions phase 2 ledger re-read failed");
                    Vec::new()
                });
                let live = Self::read_terminal_live_sessions(registry_root.as_deref());
                // Throttled scan progress: `list_sessions_progress` frames
                // (≤ ~10 Hz, first and last ticks always) keyed by the
                // typed path — the client's cache key — so a cold or
                // whale-heavy scan reads as a moving count in the picker
                // instead of a silent stall. Pure-hit warm scans emit
                // nothing.
                let progress_pd = pd.clone();
                let last_emit: parking_lot::Mutex<Option<std::time::Instant>> =
                    parking_lot::Mutex::new(None);
                let scan = crate::external_sessions::scan_external_sessions_cached_with_progress(
                    &ledger_arc,
                    &pd,
                    |done, total| {
                        let now = std::time::Instant::now();
                        {
                            let mut last = last_emit.lock();
                            let boundary = done == 0 || done == total;
                            let due = last.is_none_or(|t| {
                                now.duration_since(t) >= std::time::Duration::from_millis(100)
                            });
                            if !boundary && !due {
                                return;
                            }
                            *last = Some(now);
                        }
                        let body = serde_json::json!({
                            "action": "list_sessions_progress",
                            "project_dir": progress_pd,
                            "parsed": done,
                            "total": total,
                        });
                        let _ = progress_tx.send(Frame::new(
                            FeedId::CONTROL,
                            serde_json::to_vec(&body).expect("list_sessions_progress serializes"),
                        ));
                    },
                );
                build_listed_union(rows, &live, Some(scan))
            })
            .await;
            match built {
                Ok(union) => {
                    Self::send_list_sessions_ok(
                        &control_tx,
                        &project_dir_owned,
                        dir_exists,
                        &union,
                        false,
                    );
                }
                Err(join_err) => {
                    warn!(
                        error = %join_err,
                        project_dir = %project_dir_owned,
                        "list_sessions phase 2 worker panicked",
                    );
                    // Settle with the phase-1 preview so the indicator clears
                    // and the user keeps their resumable rows.
                    Self::send_list_sessions_ok(
                        &control_tx,
                        &project_dir_owned,
                        dir_exists,
                        &preview_fallback,
                        false,
                    );
                }
            }
        });
    }

    /// Answer "which of these sessions does this ledger hold?" ([D132]).
    ///
    /// The read path behind every citation chip. A commit's trailers name a
    /// session by full uuid or by the citation's 8-char short id, and whether
    /// that session is *findable* has to be a ledger answer: deciding it from
    /// whatever the client happened to have cached makes the same commit's chip
    /// resolvable or slashed depending on which listings ran this run, which is
    /// not a fact about the reference.
    ///
    /// Answers positively and negatively in one frame — the `unknown` list is
    /// what lets the client cache a miss instead of re-asking forever. A
    /// ledger-less build answers everything unknown rather than staying silent,
    /// for the same reason `list_card_bindings` answers empty: a client sitting
    /// on `pending` forever is the one outcome with no rendering.
    pub(in crate::feeds::agent_supervisor) async fn do_resolve_sessions(&self, ids: &[String]) {
        let mut sessions = Vec::new();
        let mut unknown: Vec<String> = Vec::new();
        // The ledger knows nothing of a project half — none of its arms
        // filters by project — so a `project/callsign` spelling is split
        // for the ask and the project half is checked against the row
        // afterwards. A mismatch is a ledger miss, because the callsign the
        // user meant belongs to some other ledger under that project.
        let ledger_spellings: Vec<String> = ids
            .iter()
            .map(|id| session_ref_callsign_half(id.trim()).to_owned())
            .collect();
        match self.session_ledger.as_ref() {
            Some(ledger) => match ledger.resolve_session_ids(&ledger_spellings) {
                Ok(resolved) => {
                    for id in ids {
                        let queried = id.trim();
                        let half = session_ref_callsign_half(queried);
                        let hit = resolved
                            .iter()
                            .find(|(answered, _)| answered == half)
                            .map(|(_, row)| row)
                            .filter(|row| session_ref_project_agrees(queried, &row.project_dir));
                        let Some(row) = hit else {
                            unknown.push(queried.to_owned());
                            continue;
                        };
                        // The segment's usage rides the answer, so a surface
                        // that resolves a cited id gets the numbers in the same
                        // round trip rather than asking a second time. `None`
                        // for a segment that recorded no telemetry.
                        let usage = ledger.usage_for(&row.session_id).unwrap_or(None);
                        sessions.push(serde_json::json!({
                            // Keyed by what was asked, so the client can match
                            // an answer back to the citation it read — a short
                            // id and the row's full id are different strings.
                            "queried": queried,
                            "session": row,
                            "usage": usage,
                        }));
                    }
                }
                Err(err) => {
                    warn!(error = %err, "resolve_sessions: ledger read failed");
                    let body = serde_json::json!({
                        "action": "resolve_sessions_err",
                        "ids": ids,
                        "reason": "ledger_read_failed",
                    });
                    let _ = self.control_tx.send(Frame::new(
                        FeedId::CONTROL,
                        serde_json::to_vec(&body).expect("resolve_sessions_err serializes"),
                    ));
                    return;
                }
            },
            None => unknown.extend(ids.iter().map(|id| id.trim().to_owned())),
        }
        // Everything this ledger missed goes to the machine-wide arms, which
        // are the only ones that can tell "somewhere else on this machine"
        // from "nowhere" ([P05]). They read sqlite and walk a directory, so
        // they run off the reactor.
        let elsewhere = self.resolve_elsewhere(&mut unknown).await;
        let body = serde_json::json!({
            "action": "resolve_sessions_ok",
            "sessions": sessions,
            "elsewhere": elsewhere,
            "unknown": unknown,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("resolve_sessions_ok serializes"),
        ));
    }

    /// Ask the finder's machine-wide arms about every spelling the ledger
    /// missed, draining the ones it places out of `misses` and returning
    /// them as [Spec S04] `elsewhere` entries. What stays in `misses` is
    /// genuinely absent — not on this machine at all.
    ///
    /// The whole spelling goes to the finder, project half included: the
    /// index *does* filter by project, which is what lets
    /// `eucit/curly-apple` find the foreign session rather than the local
    /// callsign that merely spells the same.
    async fn resolve_elsewhere(&self, misses: &mut Vec<String>) -> Vec<serde_json::Value> {
        if misses.is_empty() {
            return Vec::new();
        }
        let refs = std::mem::take(misses);
        let findings = tokio::task::spawn_blocking(move || {
            let env = tugcore::session_finder::FinderEnv::from_process();
            refs.into_iter()
                .map(|reference| {
                    let finding = tugcore::session_finder::find_beyond_here(&reference, &env);
                    (reference, finding)
                })
                .collect::<Vec<_>>()
        })
        .await;
        let findings = match findings {
            Ok(findings) => findings,
            Err(err) => {
                // A panicked or cancelled probe is not an error the client
                // can act on: every spelling simply stays unknown, which is
                // the answer this build gave before the arm existed.
                warn!(error = %err, "resolve_sessions: elsewhere probe failed");
                return Vec::new();
            }
        };
        let mut elsewhere = Vec::new();
        for (queried, finding) in findings {
            match finding {
                tugcore::session_finder::Finding::Found(found) => {
                    elsewhere.push(serde_json::json!({
                        "queried": queried,
                        "session_id": found.session_id,
                        "project_dir": found.project_dir,
                        "callsign": found.callsign,
                        "title": found.title,
                        "instance": found.instance,
                    }));
                }
                tugcore::session_finder::Finding::Absent => misses.push(queried),
            }
        }
        elsewhere
    }

    /// Handle a `list_card_bindings` CONTROL request. Reads every
    /// resumable ledger row (see `list_with_card_id` for the filter)
    /// and broadcasts a `list_card_bindings_ok` response. The
    /// client-side `restoreDevSessions` consumes this on startup and
    /// reconnect to re-assert per-card bindings. Multiple rows can
    /// share a `card_id` (sequential sessions on that card); the
    /// client picks the newest per card.
    pub(in crate::feeds::agent_supervisor) async fn do_list_card_bindings(&self) {
        let Some(ledger) = self.session_ledger.as_ref() else {
            // No ledger wired — emit an empty response so a confused
            // client doesn't sit on a pending state forever.
            let body = serde_json::json!({
                "action": "list_card_bindings_ok",
                "bindings": serde_json::Value::Array(Vec::new()),
            });
            let _ = self.control_tx.send(Frame::new(
                FeedId::CONTROL,
                serde_json::to_vec(&body).expect("list_card_bindings_ok serializes"),
            ));
            return;
        };
        // One row per **line** ([P06]), each seated on the segment a restore
        // should resume. A card that has lived through eight id changes is one
        // binding here, not eight.
        let lines = match ledger.list_lines_with_card() {
            Ok(l) => l,
            Err(err) => {
                warn!(error = %err, "list_card_bindings failed");
                let body = serde_json::json!({
                    "action": "list_card_bindings_err",
                    "reason": "ledger_read_failed",
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("list_card_bindings_err serializes"),
                ));
                return;
            }
        };
        // Snapshot the live-session map so we can answer `is_alive` for
        // each row without N round-trip lock acquisitions. A session is
        // "alive" when its in-memory ledger entry is `Spawning` or
        // `Live` — i.e. there is (or imminently will be) a tugcode
        // subprocess holding the session's runtime state, including any
        // in-flight turn or pending control_request. `Idle`, `Errored`,
        // and `Closed` are all "not alive" — there's no subprocess to
        // resume into, so the client should fall through to the
        // `turn_count > 0` JSONL-replay path or to a fresh spawn.
        //
        // This flag is the missing signal that lets the client tell
        // "in-flight first turn" (resume-able, no JSONL yet) apart from
        // "Start Fresh + quit" (fresh-spawn-and-bind-project). Both have
        // `turn_count == 0`; only the live one has `is_alive == true`.
        let live_session_ids: std::collections::HashSet<String> = {
            let live = self.ledger.lock().await;
            let mut alive = std::collections::HashSet::with_capacity(live.len());
            for (sid, entry_arc) in live.iter() {
                let entry = entry_arc.lock().await;
                if matches!(entry.spawn_state, SpawnState::Spawning | SpawnState::Live) {
                    alive.insert(sid.0.clone());
                }
            }
            alive
        };
        // Direct JSONL-presence signal. `turn_count` (the ledger's live
        // `record_turn` counter) is an unreliable proxy for "has a transcript
        // to resume": claude writes the JSONL itself, so a session can carry a
        // full on-disk transcript while the ledger count stays 0 (the turns
        // never flowed through a live `turn_complete`). A restore that trusts
        // `turn_count` then mis-routes such a session to a `new`-mode spawn,
        // whose `--session-id` collides with the existing JSONL and crash-loops
        // the card to `errored`. `has_jsonl` stats the exact file the resume
        // would target, so the client can gate on the real thing. Targeted
        // per-card stats (not a boot walk) under a directory the app already
        // reads — no new TCC surface.
        let claude_home = ledger.claude_home().clone();
        // One pair of git reads per distinct repo among the bound rows, so a
        // binding whose arc has since been joined or discarded reads as
        // unbound ([P05]) without a git call per row.
        let arc_records_by_project: std::collections::HashMap<String, ArcRecords> = {
            let projects: std::collections::HashSet<String> = lines
                .iter()
                .filter(|(_, segment, _)| segment.arc_id.is_some())
                .map(|(_, segment, _)| segment.project_dir.clone())
                .collect();
            tokio::task::spawn_blocking(move || {
                projects
                    .into_iter()
                    .map(|project| {
                        let records = Self::live_arc_records(&project);
                        (project, records)
                    })
                    .collect()
            })
            .await
            .unwrap_or_default()
        };
        // A project the map has no entry for was never asked — a panicked
        // blocking task, or a row whose spelling drifted out of the set. That
        // is `Unreadable`, not "no arcs": the old empty-set default here was
        // the second way a valid binding got nulled.
        let unasked = ArcRecords::Unreadable;
        let bindings: Vec<serde_json::Value> = lines
            .into_iter()
            .filter_map(|(line, segment, turn_count)| {
                let card_id = line.card_id.clone()?;
                let (arc_id, arc_name) = Self::reported_binding(
                    arc_records_by_project
                        .get(&segment.project_dir)
                        .unwrap_or(&unasked),
                    segment.arc_id,
                    segment.arc_name,
                );
                // Liveness and the transcript are the **seated segment's**:
                // they are facts about the file a resume would open, not about
                // the line.
                let is_alive = live_session_ids.contains(&segment.session_id);
                let has_jsonl = {
                    let (dir, _canonical) = crate::session_ledger::claude_project_dir(
                        &claude_home,
                        &segment.project_dir,
                    );
                    let path = dir.join(format!("{}.jsonl", segment.session_id));
                    crate::external_sessions::stat_size_mtime(&path)
                        .is_some_and(|(size, _mtime)| size > 0)
                };
                Some(serde_json::json!({
                    "card_id": card_id,
                    "line_id": line.line_id,
                    "session_id": segment.session_id,
                    "project_dir": segment.project_dir,
                    "state": segment.state,
                    // The line's turns, summed across its segments: what the
                    // conversation holds, not what its newest id holds.
                    "turn_count": turn_count,
                    "is_alive": is_alive,
                    "has_jsonl": has_jsonl,
                    "name": line.name,
                    "name_user_set": line.name_user_set,
                    "tag": line.tag,
                    "synopsis": segment.synopsis,
                    "arc_id": arc_id,
                    "arc_name": arc_name,
                }))
            })
            .collect();
        let body = serde_json::json!({
            "action": "list_card_bindings_ok",
            "bindings": bindings,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("list_card_bindings_ok serializes"),
        ));
    }

    /// Handle a `request_replay` CONTROL request per [D12]. Forwards
    /// `{"type":"request_replay"}` to the per-session tugcode subprocess
    /// over its existing CODE_INPUT channel (the same `input_tx` the
    /// dispatcher uses for `user_message`). Tugcode's IPC loop dispatches
    /// the verb to its `runReplay()` method, whose re-entrancy guard
    /// (Step R1a) drops a redundant request that arrives mid-replay.
    ///
    /// State-dependent delivery:
    ///
    /// * `Live` — forward immediately to `input_tx`.
    /// * `Spawning` — push at the **front** of `entry.queue`; the
    ///   bridge's `session_init` promote-and-drain critical section
    ///   forwards it to `input_tx` before any user input that may
    ///   have been buffered alongside (Step R4 / [D12]).
    /// * `Idle` — log skipped(idle); no claude to send to.
    /// * `Errored` — log skipped(errored); subprocess gone.
    /// * `Closed` — log skipped(closed); subprocess gone.
    ///
    /// **Front-push rationale**: cold boot races a `request_replay`
    /// dispatch against the user's first submit. If the dispatch
    /// arrives during the Spawning window and the user types
    /// instantly afterward, the dispatcher will queue the user's
    /// CODE_INPUT into the same per-session queue. FIFO drain would
    /// deliver the user_message first, putting tugcode in an
    /// in-flight turn that races with the request_replay — exactly
    /// the Smoke D shape that [Phase A-R3](arc/tugplan-dev-transcript-resume.md#phase-a-r3)
    /// owns. Front-push ensures replay always precedes user input
    /// from the same Spawning window — the natural ordering since
    /// the verb is "rehydrate the freshly-mounted store" and the
    /// store should be rehydrated before user-facing work begins.
    async fn do_request_replay(
        &self,
        tug_session_id: &TugSessionId,
        window: Option<serde_json::Value>,
    ) {
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            match ledger.get(tug_session_id) {
                Some(e) => e.clone(),
                None => {
                    tracing::info!(
                        target: "dev::session-lifecycle",
                        event = "request_replay.skipped",
                        tug_session_id = %tug_session_id,
                        reason = "unknown",
                    );
                    return;
                }
            }
        };

        // An arc's history is spread across one JSONL per stage, so a card
        // that replays only its own shows a transcript beginning in the
        // middle. Walk the fork edges parent-ward and hand tugcode the chain
        // ([P10]). `None` for every card that is not an arc — which is nearly
        // all of them, and their request stays byte-identical.
        let (lineage, relocation) = {
            let (claude_session_id, project_dir) = {
                let entry = entry_arc.lock().await;
                (entry.claude_session_id.clone(), entry.project_dir.clone())
            };
            // Seed the lookup with the id the spawn actually resumes. A resume
            // onto a card the ledger has never seen inserts a fresh entry whose
            // `claude_session_id` is still `None` — tugcode's `session_init`
            // fills it, and the replay is queued during the spawning window,
            // before that. The tug id is the right seed there for the same
            // reason the spawner and the `line_id` derivation already take it:
            // for an un-forked session the two ids are equal, and a resume names
            // the segment it wants by its tug id. Ownership does not move — this
            // is a read, and `session_init` stays the one writer.
            let seed = claude_session_id.unwrap_or_else(|| tug_session_id.to_string());
            let recorder = self.sessions_recorder.as_ref();
            // A card that changed directory names the move, from the same
            // seed, so every replay draws the divider — not only the first,
            // which tugcode can answer from its own argv ([P04]).
            (
                replay_lineage(recorder, &seed, &project_dir),
                relocation_edge(recorder, &seed),
            )
        };

        // Remember what this request walked, so the `replay_complete` stamp
        // can sum the turn counts of exactly these files rather than
        // recomputing a chain and hoping it matches ([B02]). Written before
        // the frame is forwarded *or* queued, because the queued path is the
        // relaunch one — the very path a rotated card restores by. A request
        // that carries no lineage writes `None`, which is the tip-alone sum
        // and today's behaviour exactly.
        {
            let mut entry = entry_arc.lock().await;
            entry.replayed_lineage = lineage.as_ref().map(|entries| {
                entries
                    .iter()
                    .filter_map(|e| {
                        e.get("sessionId")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                    })
                    .collect()
            });
        }

        // Build the wire frame once; the body is the same regardless of
        // whether we forward immediately (Live) or queue (Spawning). The
        // optional recency `window` is forwarded verbatim — the supervisor
        // doesn't interpret it; tugcode validates the shape at its handler
        // boundary. The no-window, no-lineage, no-relocation path stays byte-identical to
        // the legacy full-replay request.
        let body: Vec<u8> = if window.is_none() && lineage.is_none() && relocation.is_none() {
            b"{\"type\":\"request_replay\"}".to_vec()
        } else {
            let mut payload = serde_json::Map::new();
            payload.insert("type".into(), serde_json::json!("request_replay"));
            if let Some(w) = &window {
                payload.insert("window".into(), w.clone());
            }
            if let Some(l) = &lineage {
                payload.insert("lineage".into(), serde_json::json!(l));
            }
            if let Some((parent, from_dir, to_dir)) = &relocation {
                payload.insert(
                    "relocation".into(),
                    serde_json::json!({
                        "parentSessionId": parent,
                        "fromDir": from_dir,
                        "toDir": to_dir,
                    }),
                );
            }
            serde_json::to_vec(&serde_json::Value::Object(payload))
                .expect("request_replay payload serializes")
        };
        let frame = Frame::new(FeedId::CODE_INPUT, body);

        // For the Spawning branch we need the entry mutex held while we
        // mutate `queue`. For the Live branch we want to release the
        // mutex before the (potentially blocking) mpsc send. Branch
        // inside the lock: Spawning enqueues here; Live takes a snapshot
        // of `input_tx` and sends after dropping the lock.
        let snapshot = {
            let mut entry = entry_arc.lock().await;
            match entry.spawn_state {
                SpawnState::Spawning => {
                    let push_result = entry.queue.push_front(frame);
                    if push_result == QueuePush::Overflow {
                        // Per-session queue capacity is bounded; an
                        // overflowing front-push means the dispatcher
                        // already crammed the queue with user input
                        // during the Spawning window. Log loudly — this
                        // is rare and indicates the user is typing
                        // faster than tugcode can spawn. The verb is
                        // dropped; the cold-boot transcript may show
                        // empty until the next dispatch (e.g. a
                        // subsequent reload).
                        tracing::warn!(
                            target: "dev::session-lifecycle",
                            event = "request_replay.skipped",
                            tug_session_id = %tug_session_id,
                            reason = "spawning_queue_overflow",
                        );
                        return;
                    }
                    tracing::info!(
                        target: "dev::session-lifecycle",
                        event = "request_replay.queued",
                        tug_session_id = %tug_session_id,
                        reason = "spawning_window",
                    );
                    return;
                }
                SpawnState::Live => entry.input_tx.clone(),
                SpawnState::Idle | SpawnState::Errored | SpawnState::Closed => {
                    let reason = match entry.spawn_state {
                        SpawnState::Idle => "idle",
                        SpawnState::Errored => "errored",
                        SpawnState::Closed => "closed",
                        _ => unreachable!(),
                    };
                    tracing::info!(
                        target: "dev::session-lifecycle",
                        event = "request_replay.skipped",
                        tug_session_id = %tug_session_id,
                        reason = reason,
                    );
                    return;
                }
            }
        };

        // Live branch continues here with the entry lock released.
        // `snapshot` is `Option<mpsc::Sender<Frame>>`.
        //
        // Live but no `input_tx` is a programming error — `Live` means
        // the bridge promoted the entry past `session_init` and the
        // worker installs `input_tx` before that promotion. Treat as
        // a skip on the user-visible path and warn loudly so the
        // condition surfaces in tracing.
        let Some(tx) = snapshot else {
            tracing::warn!(
                target: "dev::session-lifecycle",
                event = "request_replay.skipped",
                tug_session_id = %tug_session_id,
                reason = "no_input_tx",
            );
            return;
        };

        if let Err(e) = tx.send(frame).await {
            warn!(
                tug_session_id = %tug_session_id,
                error = %e,
                "request_replay: send to input_tx failed",
            );
            return;
        }
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "request_replay.dispatched",
            tug_session_id = %tug_session_id,
        );
    }

    /// Handle a `reset_session` CONTROL action.
    ///
    /// [D11]: reset preserves the workspace binding. We kill the current
    /// tugcode bridge (so a hung or misbehaving subprocess is torn down)
    /// but do NOT call `registry.release` or `registry.get_or_create`.
    /// The ledger entry stays in place — same `workspace_key`, same
    /// `project_dir`, same crash budget, same latest_metadata replay — so
    /// that the user's workspace feeds (file watcher, git poller) are
    /// never observably interrupted.
    ///
    /// On the wire we publish `closed` then `pending`, matching the
    /// historical close-then-spawn shape. The subsequent `spawning` /
    /// `live` frames are published by `spawn_session_worker` when the
    /// next CODE_INPUT frame arrives and the dispatcher transitions
    /// `Idle → Spawning`.
    async fn do_reset_session(
        &self,
        card_id: &str,
        tug_session_id: &TugSessionId,
        _client_id: ClientId,
    ) {
        let entry_arc = {
            let ledger = self.ledger.lock().await;
            match ledger.get(tug_session_id) {
                Some(e) => e.clone(),
                None => return,
            }
        };

        // Cancel the current bridge worker and reset the per-session
        // state so the next CODE_INPUT can re-drive Idle → Spawning. The
        // workspace_key, project_dir, crash_budget, and latest_metadata
        // fields are intentionally preserved.
        //
        // Reset invalidates `claude_session_id` (in-memory clear +
        // tugbank delete) and flips `session_mode` back to `New` so the
        // next spawn is fresh. Without the mode flip, a card whose
        // session_mode was `Resume` would still spawn `--session-mode
        // resume`, and tugcode would fall back to `--resume <session_id>`
        // — finding the JSONL still on disk and restoring the
        // conversation the user explicitly asked to discard. The
        // invalidate-then-cancel ordering closes the persistence gap
        // before the bridge can be re-spawned: even if the cancel races
        // an overlapping CODE_INPUT, the next spawn sees `New` mode and
        // no claude_session_id, so it spawns truly fresh.
        //
        // Terminal-state guard: if a concurrent `close_session` won the
        // race and flipped the entry to `Closed`, reset must not
        // resurrect it. Bail out silently — the caller's reset is
        // meaningless for a dead session, and flipping back to `Idle`
        // would confuse any worker that later observed the stale Arc.
        // Captured before the clear below: the reset fact names the session
        // being discarded, and after this block there is no id left to name it
        // by.
        let mut cleared_claude_id: Option<String> = None;
        let resurrected = {
            let mut entry = entry_arc.lock().await;
            if entry.spawn_state == SpawnState::Closed {
                false
            } else {
                cleared_claude_id = entry.claude_session_id.clone();
                entry.claude_session_id = None;
                entry.session_mode = crate::feeds::agent_bridge::SessionMode::New;
                entry.cancel.cancel();
                entry.cancel = CancellationToken::new();
                entry.spawn_state = SpawnState::Idle;
                // Reset makes the entry fresh, and that includes forgetting
                // that a child ever ran on it: a `/clear` is the user taking
                // the card, which the arc's taken-card arm has a better
                // receipt for than "its session ended". Without this the
                // gesture would read as a death at the very next sweep.
                entry.ever_live_here = false;
                entry.input_tx = None;
                true
            }
        };
        if !resurrected {
            return;
        }

        tracing::info!(
            target: "dev::session-lifecycle",
            event = "reset_session.cleared",
            card_id = card_id,
            tug_session_id = %tug_session_id,
        );

        // One fact for the reset. The closed→pending pair published below is
        // the card's state machine talking, not two more events — and the
        // ledger row is not transitioned here, so no `session.closed` fact
        // fires alongside it.
        if let (Some(ledger), Some(claude_id)) = (self.session_ledger.as_ref(), &cleared_claude_id)
        {
            let handle = ledger
                .get(claude_id)
                .ok()
                .flatten()
                .and_then(|row| row.tag)
                .unwrap_or_else(|| claude_id.clone());
            if let Err(err) = ledger.record_fact(&crate::feeds::facts_library::session_reset_fact(
                crate::session_ledger::now_millis(),
                claude_id,
                &handle,
            )) {
                warn!(error = %err, "reset fact write failed");
            }
        }

        self.session_state.publish_tagged(build_session_state_frame(
            tug_session_id,
            "closed",
            None,
        ));
        self.session_state.publish_tagged(build_session_state_frame(
            tug_session_id,
            "pending",
            None,
        ));
    }
}
