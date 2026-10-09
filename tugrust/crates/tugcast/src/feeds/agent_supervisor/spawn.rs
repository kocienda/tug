//! The spawn path: `do_spawn_session` and the machinery it leans on — the
//! bind-time replays of persisted metadata and capabilities, the
//! content-empty check that routes a resume to a fresh spawn, the
//! directory-change origin, and the attach to a bridge the card already holds.

use super::*;

impl AgentSupervisor {
    /// Build a `SESSION_SIDEBAND` replay frame from the persisted ledger
    /// row, for a bind whose in-memory `latest_metadata` slot is empty.
    ///
    /// claude is silent in stream-json mode until the first user message,
    /// so a resumed / known session would otherwise show no live model /
    /// version / mode until the user types. The sqlite `session_metadata`
    /// table holds the last-known merged payload (keyed by claude's
    /// session id), so we surface it the moment the card binds; the next
    /// live `system/init` replaces it wholesale on the first turn.
    ///
    /// Tries `claude_session_id` first (the metadata PK), then the tug
    /// session id (equal for un-forked sessions, where the binding's
    /// claude id may not yet be populated in memory). Returns `None` when
    /// there is no sqlite ledger handle or no persisted row (a genuinely
    /// brand-new session), so a fresh flow fires no replay — matching the
    /// `latest_metadata: None` behavior it falls back from. Payload is
    /// rewrapped as `FeedId::SESSION_SIDEBAND` (the wire byte the client's
    /// `register_stream(FeedId::SESSION_SIDEBAND, …)` subscription keys on,
    /// same as the live merger publish).
    ///
    /// The persisted payload carries no `tug_session_id`: the bridge merges
    /// and persists the RAW stdout line, splicing the id only onto the
    /// emitted wire copy (`agent_bridge.rs` — merge precedes the splice at
    /// the emit site). Clients filter SESSION_SIDEBAND by `tug_session_id`
    /// per [D06]/[D11], so an unstamped replay would be silently dropped
    /// and a resumed card would show no model / version / mode until its
    /// first turn. Stamp the BOUND session's id here ([`stamp_tug_session_id`]);
    /// stamping at replay time also keeps the frame correct when a claude
    /// session is re-bound under a different tug id.
    fn persisted_metadata_replay_frame(
        &self,
        claude_session_id: Option<&str>,
        tug_session_id: &str,
    ) -> Option<Frame> {
        let ledger = self.session_ledger.as_ref()?;
        // Try claude id first (the metadata PK), then the tug id — but only
        // the tug id when it differs (un-forked sessions share one id).
        let mut candidates: Vec<&str> = Vec::with_capacity(2);
        if let Some(id) = claude_session_id {
            candidates.push(id);
        }
        if !candidates.contains(&tug_session_id) {
            candidates.push(tug_session_id);
        }
        for candidate in candidates {
            match ledger.get_session_metadata(candidate) {
                Ok(Some(row)) => {
                    return Some(Frame::new(
                        FeedId::SESSION_SIDEBAND,
                        stamp_tug_session_id(row.payload, tug_session_id),
                    ));
                }
                Ok(None) => {}
                Err(e) => {
                    warn!(
                        error = %e,
                        session_id = candidate,
                        "get_session_metadata failed during bind replay (ignored)"
                    );
                }
            }
        }
        None
    }

    /// Build a `SESSION_SIDEBAND` replay frame from the persisted
    /// `session_capabilities` row, for a bind whose in-memory
    /// `latest_capabilities` slot is empty — the app-restart case: the
    /// slot died with the old process, and a resumed session's next
    /// handshake is health-gated (it answers seconds after spawn at the
    /// earliest). Without this fallback the card has no `/` command
    /// catalog and no version in that window; with it, the last-known
    /// catalog is on screen from the drop and the live handshake
    /// replaces it wholesale when it lands.
    ///
    /// Keyed by the tug session id only — capabilities are spawn-scoped
    /// (unlike `session_metadata`, which is keyed by claude's JSONL id).
    /// The persisted payload is the tagged wire copy, but the tag is the
    /// id of the ORIGINAL spawn; stamp the BOUND session's id so a
    /// claude session re-bound under a different tug id still passes the
    /// client-side [D06]/[D11] session filter
    /// ([`stamp_tug_session_id`] overwrites a stale tag).
    fn persisted_capabilities_replay_frame(&self, tug_session_id: &str) -> Option<Frame> {
        let ledger = self.session_ledger.as_ref()?;
        match ledger.get_session_capabilities(tug_session_id) {
            Ok(Some(row)) => Some(Frame::new(
                FeedId::SESSION_SIDEBAND,
                stamp_tug_session_id(row.payload, tug_session_id),
            )),
            Ok(None) => None,
            Err(e) => {
                warn!(
                    error = %e,
                    session_id = tug_session_id,
                    "get_session_capabilities failed during bind replay (ignored)"
                );
                None
            }
        }
    }

    /// Does this session hold nothing at all — nothing in the ledger
    /// ([`is_empty_session`]) AND no transcript on disk?
    ///
    /// Both signals must agree before a spawn is routed away from `resume`.
    /// The ledger side is the same emptiness the picker filters on; the disk
    /// side is the exact file a `--resume` would open. Requiring both means a
    /// path-encoding miss can never route a session that really has a
    /// transcript into a `--session-id` collision, and a ledger row that
    /// under-reports its content (turn counts that never flowed through a live
    /// `turn_complete`) is still protected by the file being there.
    ///
    /// `false` when there is no ledger to consult — with no way to tell empty
    /// from populated, the request's own mode stands.
    pub(in crate::feeds::agent_supervisor) fn session_is_content_empty(
        &self,
        tug_session_id: &TugSessionId,
        project_dir: &str,
    ) -> bool {
        let Some(ledger) = self.session_ledger.as_ref() else {
            return false;
        };
        let Ok(Some(row)) = ledger.get(&tug_session_id.0) else {
            return false;
        };
        if !is_empty_session(&row) {
            return false;
        }
        let (dir, _canonical) =
            crate::session_ledger::claude_project_dir(ledger.claude_home(), project_dir);
        let jsonl = dir.join(format!("{}.jsonl", tug_session_id.0));
        crate::external_sessions::stat_size_mtime(&jsonl).is_none()
    }

    /// The origin a directory change forks from, resolved from the tug
    /// session the card is moving away from ([P07]).
    ///
    /// The live entry is the authority for the claude id — a rotation or
    /// rewind may have moved it off the tug id, and the deck's copy can lag.
    /// `None` when there is no such entry, or when the parent has no JSONL on
    /// disk: `--resume` on it would exit "No conversation found", and a card
    /// that never held a conversation has no context to carry, so it simply
    /// spawns fresh in the target directory.
    ///
    /// The one parent with no JSONL that still holds a conversation is a
    /// session that itself moved and has not taken a turn since: its fork is
    /// unwritten, so its whole context is still its own origin's. A second
    /// move before that first turn forks from that origin instead.
    async fn resolve_relocation(&self, relocate_from: &TugSessionId) -> Option<RelocateOrigin> {
        let entry_arc = self.ledger.lock().await.get(relocate_from)?.clone();
        let (parent_session_id, parent_project_dir, unwritten_origin) = {
            let entry = entry_arc.lock().await;
            (
                entry
                    .claude_session_id
                    .clone()
                    .unwrap_or_else(|| relocate_from.0.clone()),
                entry.project_dir.to_str()?.to_owned(),
                entry.relocate_from.clone(),
            )
        };
        let root = self.session_ledger.as_ref()?.claude_home();
        let (dir, _canonical) =
            crate::session_ledger::claude_project_dir(root, &parent_project_dir);
        if crate::external_sessions::stat_size_mtime(
            &dir.join(format!("{parent_session_id}.jsonl")),
        )
        .is_none()
        {
            return unwritten_origin;
        }
        Some(RelocateOrigin {
            parent_session_id,
            parent_project_dir,
        })
    }

    /// The origin of a directory change whose fork is still unwritten, read
    /// back from the sessions ledger — how a relaunch, which has no spawn
    /// payload naming the move, keeps forking ([P03]).
    ///
    /// Answers when this session's row was forked from a row in another
    /// directory (the `relocate` edge, [P05]) and this session's own JSONL is
    /// absent — the same file test `session_is_content_empty` makes. Once
    /// claude writes the fork the session is an ordinary one, and this answers
    /// `None`.
    pub(in crate::feeds::agent_supervisor) fn pending_relocation_from_ledger(
        &self,
        tug_session_id: &TugSessionId,
        project_dir: &str,
    ) -> Option<RelocateOrigin> {
        let ledger = self.session_ledger.as_ref()?;
        let chain = ledger.lineage_chain(&tug_session_id.0);
        let parent = chain.len().checked_sub(2).map(|i| chain[i].clone())?;
        let parent_row = ledger.get(&parent).ok().flatten()?;
        let root = ledger.claude_home();
        let (own_dir, own_canonical) = crate::session_ledger::claude_project_dir(root, project_dir);
        let (_, parent_canonical) =
            crate::session_ledger::claude_project_dir(root, &parent_row.project_dir);
        if own_canonical == parent_canonical {
            return None;
        }
        let own_jsonl = own_dir.join(format!("{}.jsonl", tug_session_id.0));
        if crate::external_sessions::stat_size_mtime(&own_jsonl).is_some() {
            return None;
        }
        Some(RelocateOrigin {
            parent_session_id: parent,
            parent_project_dir: parent_row.project_dir,
        })
    }

    /// The bridge a spawn should attach to when the id the card asked for is
    /// not the one the supervisor keyed that bridge by ([B03]).
    ///
    /// A card is a **line**; a bridge is keyed by whichever segment id the
    /// card first spawned under, and that key never moves while the process
    /// lives. A reload, though, seats the card on the line's tip — a segment
    /// a rotation minted inside the bridge — and asks to resume *that* id.
    /// The lookup used to be the requested id alone, so the ask missed, a
    /// second `tugcode` spawned for a session the first one was already
    /// hosting, and closing the card killed whichever of the two it named.
    ///
    /// Three ways in, and only an all-three miss spawns:
    ///
    /// 1. the requested id keys an entry — the ordinary path, and `None`
    ///    here because there is nothing to re-point;
    /// 2. an entry whose `claude_session_id` is the requested id — the card
    ///    asked under the name claude knows the conversation by;
    /// 3. an entry on the requested id's **line** held by the requesting
    ///    card — the reload above.
    ///
    /// Only a resume can attach. A `mode=new` spawn is a line being born
    /// ([P03]) and has nothing to re-enter, so it is left to insert.
    async fn attachable_bridge_for(
        &self,
        requested: &TugSessionId,
        card_id: &str,
        line_id: Option<&str>,
    ) -> Option<TugSessionId> {
        // A snapshot, so no entry is locked under the ledger lock. The window
        // it opens is the one every spawn already runs in: phase 1's
        // `entry().or_insert_with` is still the atomic decision, and this only
        // ever tells it a different key to ask about.
        let entries: Vec<(TugSessionId, Arc<Mutex<LedgerEntry>>)> = {
            let ledger = self.ledger.lock().await;
            if ledger.contains_key(requested) {
                return None;
            }
            ledger
                .iter()
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect()
        };
        // The line the requested id belongs to: the one the payload named,
        // else the one the sessions ledger files that segment under. A reload
        // carries the line it is seating on, so the ledger read is the
        // fallback rather than the path.
        let line = line_id
            .map(str::to_owned)
            .filter(|id| !id.is_empty())
            .or_else(|| {
                self.session_ledger
                    .as_ref()
                    .and_then(|l| l.get(&requested.0).ok().flatten())
                    .map(|row| row.line_id)
                    .filter(|id| !id.is_empty())
            });
        let mut by_line: Option<TugSessionId> = None;
        for (key, entry_arc) in entries {
            let entry = entry_arc.lock().await;
            if entry.claude_session_id.as_deref() == Some(requested.as_str()) {
                // The strongest match there is — the same conversation, named
                // the way claude names it. Taken at once.
                return Some(key);
            }
            if by_line.is_none()
                && entry.card_id.as_deref() == Some(card_id)
                && line.is_some()
                && entry.line_id == line
            {
                by_line = Some(key);
            }
        }
        by_line
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::feeds::agent_supervisor) async fn do_spawn_session(
        &self,
        card_id: &str,
        tug_session_id: TugSessionId,
        project_dir_str: String,
        session_mode: SessionMode,
        permission_mode: Option<String>,
        tag: Option<String>,
        line_id: Option<String>,
        relocate_from: Option<TugSessionId>,
        client_id: ClientId,
    ) -> Result<(), ControlError> {
        let project_dir = PathBuf::from(&project_dir_str);
        // A fresh spawn births a line, and the deck mints its id from the drop
        // ([P03]). Refused here, before the workspace refcount is acquired, so
        // the refusal costs nothing and releases nothing.
        if session_mode == SessionMode::New && line_id.as_deref().unwrap_or_default().is_empty() {
            warn!(
                card_id,
                session = %tug_session_id,
                "spawn_session: a mode=new spawn carried no line_id"
            );
            return Err(ControlError::MissingLineId);
        }
        // **One card, one bridge ([B03]).** Before anything is acquired or
        // inserted, ask whether this card is already hosting the session it
        // is asking for under another of its line's ids. A hit re-points the
        // whole of the rest of this function at the bridge that exists; the
        // miss is the ordinary spawn, unchanged.
        //
        // The id as asked for is kept: the attach re-keys the spawn at the
        // bridge's own first id, which is a segment a rotation may have left
        // behind, and the ack still owes the deck the seat ([B01]).
        let requested_session_id = tug_session_id.clone();
        let tug_session_id = match session_mode {
            SessionMode::Resume => {
                match self
                    .attachable_bridge_for(&tug_session_id, card_id, line_id.as_deref())
                    .await
                {
                    Some(held) => {
                        tracing::info!(
                            target: "dev::session-lifecycle",
                            event = "spawn.attached_to_held_bridge",
                            card_id = card_id,
                            requested = %tug_session_id,
                            attached = %held,
                            "the card already hosts this session; re-holding its bridge",
                        );
                        held
                    }
                    None => tug_session_id,
                }
            }
            SessionMode::New => tug_session_id,
        };
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "spawn.supervisor_recv",
            card_id = card_id,
            tug_session_id = %tug_session_id,
            project_dir = %project_dir_str,
            session_mode = session_mode.as_wire_str(),
        );

        // Phase 0: validate + canonicalize + acquire workspace.
        // This must happen before we touch the ledger so validation errors
        // short-circuit with no ledger or client_sessions mutation. On
        // success the workspace refcount is bumped by 1; every error path
        // below that returns after this point must release the extra
        // refcount before returning ([D05]).
        let workspace_entry = self
            .registry
            .get_or_create(&project_dir, self.cancel.clone())
            .map_err(|e| match e {
                WorkspaceError::InvalidProjectDir { reason, .. } => {
                    warn!(
                        card_id,
                        session = %tug_session_id,
                        path = ?project_dir,
                        reason,
                        "spawn_session: invalid project_dir"
                    );
                    ControlError::InvalidProjectDir { reason }
                }
                WorkspaceError::UnknownKey(_) => {
                    unreachable!("get_or_create never returns UnknownKey")
                }
            })?;
        let workspace_key = workspace_entry.workspace_key.clone();
        drop(workspace_entry);

        // An empty session has nothing to resume. Claude writes a session's
        // JSONL only once a turn lands, so a session abandoned before its
        // first prompt leaves no transcript at all and `--resume` on its id
        // exits with "No conversation found" — surfacing a "couldn't resume"
        // alert for a session that never held a conversation. Those rows are
        // the same ones `build_listed_union` drops as empty, so spawn them
        // fresh instead, under the SAME id: the card opens on its project and
        // the id keeps keying the session's durable non-JSONL content — the
        // shell ledger's receipts and the refs ledger's last run — exactly as
        // the client's own zero-turn restore path does.
        //
        // That invariant needs no enforcing now: durable ink is keyed by
        // **line** ([P09]), so an id change moves nothing out from under it
        // and there is nothing to repair afterwards.
        //
        // `spawn_mode` is what the entry gets stamped with; `session_mode`
        // stays the mode the client asked for, so the ownership gates below
        // still read a resume request as a resume request.
        //
        // A directory change is answered first ([P03], [P07]). A `mode=new`
        // spawn carrying `relocate_from` is the move itself; any spawn of a
        // session whose `relocate` edge crosses directories and whose fork is
        // still unwritten is a relaunch or reload of one. Either way it is a
        // `New` spawn with the origin beside it — tugcode forks from the
        // parent — and never a resume, because the id it would resume has no
        // transcript yet. This is decided before the empty-session rule on
        // purpose: the pending replay stamps the parent's turn count onto this
        // session's row, so the row does not read empty.
        let relocation = match (&relocate_from, session_mode) {
            (Some(from), SessionMode::New) => match self.resolve_relocation(from).await {
                Some(origin) => Some(origin),
                None => self.pending_relocation_from_ledger(&tug_session_id, &project_dir_str),
            },
            _ => self.pending_relocation_from_ledger(&tug_session_id, &project_dir_str),
        };
        if let Some(origin) = relocation.as_ref() {
            tracing::info!(
                target: "dev::session-lifecycle",
                event = "spawn.relocate",
                card_id = card_id,
                tug_session_id = %tug_session_id,
                parent_session_id = %origin.parent_session_id,
                from_dir = %origin.parent_project_dir,
                to_dir = %project_dir_str,
            );
        }
        let content_empty = self.session_is_content_empty(&tug_session_id, &project_dir_str);
        let spawn_mode = if relocation.is_some() {
            SessionMode::New
        } else if content_empty && session_mode == SessionMode::Resume {
            tracing::info!(
                target: "dev::session-lifecycle",
                event = "spawn.empty_session_spawned_fresh",
                card_id = card_id,
                tug_session_id = %tug_session_id,
            );
            SessionMode::New
        } else {
            session_mode
        };

        // Phase 1: ledger get-or-insert + per-client affinity insert, atomic
        // under the outer ledger lock AND the client_sessions lock. Holding
        // both together closes the TOCTOU window per [R06] — a concurrent
        // close cannot interleave between the ledger insert and the
        // client_sessions insert. Lock order invariant: ledger first, then
        // client_sessions; applied everywhere in this module.
        //
        // If the ledger already has an entry for this tug_session_id (a
        // reconnect), the or_insert_with closure does not run and we
        // reuse the existing entry. In that case the workspace refcount
        // bumped in Phase 0 is excess and must be released (the existing
        // ledger entry already holds its own refcount).
        //
        // P13: for fresh inserts only, enforce `max_concurrent_sessions`
        // (counting Spawning+Live entries via try_lock) and the
        // `max_spawns_per_minute` leaky bucket. Both checks run inside
        // the ledger critical section so the decision is atomic with the
        // insert. Reconnects bypass — the existing entry is already
        // counted and re-inserting it would not produce a new subprocess.
        let phase1 = {
            let mut ledger = self.ledger.lock().await;
            let was_inserted = !ledger.contains_key(&tug_session_id);
            if was_inserted {
                if let Some(reason) = cap_check_reason(
                    &ledger,
                    self.config.max_concurrent_sessions,
                    &self.spawn_timestamps,
                    self.config.max_spawns_per_minute,
                ) {
                    drop(ledger);
                    // Release the workspace refcount acquired in Phase 0;
                    // the ledger never saw this entry so no later Phase
                    // will release it for us.
                    if let Err(e) = self.registry.release(&workspace_key) {
                        warn!(
                            card_id,
                            session = %tug_session_id,
                            error = %e,
                            "spawn_session: cap-reject workspace release failed (ignored)"
                        );
                    }
                    // Broadcast SESSION_STATE errored so any observer of
                    // this session sees the failure, not just the client
                    // whose CONTROL frame we're about to reject.
                    self.session_state.publish_tagged(build_session_state_frame(
                        &tug_session_id,
                        "errored",
                        Some(reason),
                    ));
                    warn!(
                        card_id,
                        session = %tug_session_id,
                        reason,
                        "spawn_session: rejected by spawn budget"
                    );
                    return Err(ControlError::CapExceeded { reason });
                }
            }
            let arc = ledger
                .entry(tug_session_id.clone())
                .or_insert_with(|| {
                    Arc::new(Mutex::new(LedgerEntry::new(
                        tug_session_id.clone(),
                        workspace_key.clone(),
                        project_dir.clone(),
                        spawn_mode,
                        CrashBudget::new(3, Duration::from_secs(60)),
                    )))
                })
                .clone();
            let mut cs = self.client_sessions.lock().await;
            // Capture whether *any* live client connection already held
            // this session BEFORE this call's affinity insert. This is
            // the genuine "session_live_elsewhere" signal: a session
            // re-materialized by `rebind_from_ledger` is in no client's
            // set, while one another connected client is using is. Read
            // it here, pre-insert, so the resume check below isn't
            // fooled by the row this very call is about to add.
            let held_by_live_client_before = cs.values().any(|set| set.contains(&tug_session_id));
            cs.entry(client_id)
                .or_default()
                .insert(tug_session_id.clone());
            (arc, was_inserted, held_by_live_client_before)
        };
        let (entry_arc, inserted, held_by_live_client_before) = phase1;

        // Compute the *effective* session mode — the mode the bridge
        // will actually use when it spawns tugcode. For a fresh insert
        // (Phase 1's `or_insert_with` fired) the effective mode is the
        // request's mode. For an existing entry that's still `Idle`
        // (rebound from the ledger but not yet spawned), we propagate
        // the request's mode into the entry. The defense-in-depth is
        // gated on `Idle` so we never silently switch the mode of a
        // running subprocess: the running tugcode subprocess was
        // spawned with the original mode and silently switching it
        // client-side would misrepresent live state.
        let effective_session_mode = {
            let mut entry = entry_arc.lock().await;
            // Retry-clears-error: a spawn request for an `Errored` entry IS the
            // user asking to (re)spawn it — the picker's Retry. Clear the error
            // back to `Idle` so the eager-spawn + replay below fire, instead of
            // the dispatcher dropping every frame and `request_replay` skipping
            // in a terminal state (the 2026-07-22 commit-xp regression: Retry
            // re-spawned but the entry stayed `Errored`, so the card came back
            // empty even though the JSONL was intact). Crucially this preserves
            // `claude_session_id` + `session_mode` — unlike `reset_session`,
            // which wipes them to start fresh — so the respawn resumes the
            // intact transcript. `Closed` is genuinely terminal and left alone.
            if !inserted && entry.spawn_state == SpawnState::Errored {
                tracing::info!(
                    target: "dev::session-lifecycle",
                    event = "spawn.clear_errored_for_retry",
                    card_id = card_id,
                    tug_session_id = %tug_session_id,
                    had_claude_id = entry.claude_session_id.is_some(),
                );
                entry.spawn_state = SpawnState::Idle;
                // The retry is a spawn about to happen, and the `Idle` it
                // parks in is a step on the way to `Spawning` — not a death.
                // Cleared so a sweep landing in that window reads the wait it
                // is rather than stopping the arc; the promote below sets it
                // again, and a retry that fails lands back in `Errored`, which
                // already reads gone.
                entry.ever_live_here = false;
            }
            if !inserted
                && entry.spawn_state == SpawnState::Idle
                && entry.session_mode != spawn_mode
            {
                entry.session_mode = reconcile_idle_session_mode(
                    entry.session_mode,
                    spawn_mode,
                    // A pending relocation is by definition a session whose
                    // own JSONL is absent, so there is no transcript for a
                    // `New` spawn to collide with — and holding `Resume` would
                    // run `--resume <id>` into "No conversation found".
                    entry.claude_session_id.is_some() && !content_empty && relocation.is_none(),
                );
            }
            // Stamp the resolved permission mode onto the entry the same way:
            // on the fresh insert, or while still `Idle` (rebound but not yet
            // spawned). This is the mode the session is *born* in; the entry
            // tracks the mode it is *in*, so a live `permission_mode` frame
            // moves the field too (see the stamp in `dispatch_one`). Not from
            // here while running — a spawn payload's mode is what the deck
            // remembered for the card, and the live frame is the later word.
            // The bridge reads this field at spawn time, so the mode is correct
            // from claude's first instant and a respawn carries the mode the
            // session is in rather than the one it was born in.
            if inserted || entry.spawn_state == SpawnState::Idle {
                entry.permission_mode = permission_mode;
                // The directory change's origin, stamped on the same path: the
                // bridge reads it on every spawn while the fork is unwritten.
                entry.relocate_from = relocation;
                // The provisional tag is stamped on the same fresh/Idle path and
                // preserved across reconnects; `record_spawn` claims it
                // authoritatively when the bridge promotes the session.
                entry.tag = tag;
            }
            // The line the entry is on ([P03]/[P04]). The payload's is the
            // authority — the deck mints it from the drop on a fresh spawn and
            // sends the binding's on a resume. A resume that carries none
            // (every client before this model) reads it off the row it is
            // resuming, so a card restored by an older deck still lands on its
            // own line rather than starting a second one.
            if let Some(line_id) = line_id.filter(|id| !id.is_empty()) {
                entry.line_id = Some(line_id);
            } else if entry.line_id.is_none() {
                entry.line_id = entry
                    .claude_session_id
                    .as_deref()
                    .or(Some(tug_session_id.as_str()))
                    .and_then(|id| self.session_ledger.as_ref()?.line_of(id));
            }
            entry.session_mode
        };
        tracing::info!(
            target: "dev::session-lifecycle",
            event = "spawn.effective_mode",
            card_id = card_id,
            tug_session_id = %tug_session_id,
            requested_mode = session_mode.as_wire_str(),
            effective_mode = effective_session_mode.as_wire_str(),
            inserted,
            mode_mismatch =
                session_mode != effective_session_mode && !inserted,
        );

        // Workspace refcount ownership. Phase 0's `get_or_create` bumped the
        // workspace refcount; exactly one refcount belongs to this ledger entry
        // for its lifetime (`do_close_session` releases it). Decide who owns the
        // one we just acquired — keyed on the entry's OWN record of ownership,
        // never on `inserted`:
        //   - the entry already owns one (a genuine reconnect of a live entry)
        //     → the Phase-0 refcount is excess, release it;
        //   - the entry owns none (a fresh insert, OR an entry rebound from the
        //     ledger making its first real spawn) → the entry adopts it.
        // A rebind entry is present in the ledger (`inserted == false`) yet holds
        // no refcount, so `!inserted` must NOT drive the release — reading it as
        // "a refcount is held" tore down a resumed project's workspace on restore.
        let phase0_refcount_is_excess = {
            let mut entry = entry_arc.lock().await;
            if entry.holds_workspace_refcount {
                true
            } else {
                entry.holds_workspace_refcount = true;
                false
            }
        };
        if phase0_refcount_is_excess {
            if let Err(e) = self.registry.release(&workspace_key) {
                warn!(
                    card_id,
                    session = %tug_session_id,
                    error = %e,
                    "spawn_session: reconnect release returned error (ignored)"
                );
            }
        }

        if !inserted {
            // Reject a `resume` only when a live client connection is
            // genuinely holding this session on a *different* card.
            //
            // The `card_id` field is the persistent "last bound"
            // record, preserved across close/errored — but the ledger
            // remembering a different card is NOT by itself a
            // conflict. After a tugcast restart, `rebind_from_ledger`
            // re-materializes every prior session as `Idle` carrying
            // its recorded `card_id`, and deliberately does NOT
            // populate `client_sessions` (there is no WebSocket client
            // behind a rebind). Likewise a page reload drops the old
            // WebSocket, and `on_client_disconnect` removes that
            // client's `client_sessions` row. In both cases the
            // recorded card is gone; a new card must be free to adopt
            // the session via `mode=resume`.
            //
            // The genuine conflict is "a connected client is holding
            // this session right now" — captured in
            // `held_by_live_client_before` (read in Phase 1 *before*
            // this call's own affinity insert, so it is not fooled by
            // the row we just added). A resume is rejected only when
            // all of:
            //   (a) the entry is in a not-closed `spawn_state`
            //       (Idle/Spawning/Live),
            //   (b) the ledger's `card_id` differs from the resuming
            //       card, AND
            //   (c) a live client connection already held this session
            //       before this call.
            // Same-card reconnects (WS drop + reconnect) clear (b);
            // rebind-from-ledger / post-reload adoptions clear (c);
            // `new` payloads never enter this block.
            if session_mode == SessionMode::Resume {
                let entry = entry_arc.lock().await;
                let still_held = matches!(
                    entry.spawn_state,
                    SpawnState::Idle | SpawnState::Spawning | SpawnState::Live
                );
                let holder_opt = if still_held {
                    entry.card_id.as_deref()
                } else {
                    None
                };
                if let Some(holder) = holder_opt {
                    if holder != card_id && held_by_live_client_before {
                        let holder_owned = holder.to_owned();
                        drop(entry);
                        // Drop the per-client affinity row we just
                        // inserted above so the rejected card doesn't
                        // appear bound.
                        let mut cs = self.client_sessions.lock().await;
                        if let Some(set) = cs.get_mut(&client_id) {
                            set.remove(&tug_session_id);
                        }
                        drop(cs);
                        warn!(
                            card_id,
                            session = %tug_session_id,
                            holder = %holder_owned,
                            "spawn_session: resume rejected — session live on another card"
                        );
                        self.session_state.publish_tagged(build_session_state_frame(
                            &tug_session_id,
                            "errored",
                            Some("session_live_elsewhere"),
                        ));
                        return Err(ControlError::CapExceeded {
                            reason: "session_live_elsewhere",
                        });
                    }
                }
            }
        }

        // Terminal-liveness gate: a resume whose target session is
        // currently held by a live process outside this supervisor —
        // the Claude Code terminal app, or another Tug instance — is
        // refused outright. Double-holding makes both processes append
        // divergent parentUuid branches into one JSONL; closing the
        // terminal frees the session immediately (its registry entry
        // is removed on exit).
        //
        // This check runs for BOTH Phase-1 outcomes. The fresh-insert
        // path is the primary case: the first-ever resume of an
        // external (terminal-created) session mints a new entry, so a
        // gate placed inside the `!inserted` reconnect branch above
        // would miss it entirely. Only resume mode is gated — a `new`
        // session has a fresh id no other process can hold. The
        // registry read shells out to `ps` and walks a directory, so
        // it runs on a blocking thread.
        if effective_session_mode == SessionMode::Resume {
            let registry_root = self.terminal_registry_root();
            let sid = tug_session_id.as_str().to_owned();
            let held = tokio::task::spawn_blocking(move || {
                Self::read_terminal_live_sessions(registry_root.as_deref()).contains_key(&sid)
            })
            .await
            .unwrap_or(false);
            if held {
                // Undo this call's bookkeeping. A fresh insert takes
                // its just-minted Idle entry and the Phase-0 workspace
                // refcount with it; a reconnect already released the
                // extra refcount above and keeps its pre-existing
                // entry. The affinity row this call added goes either
                // way. Lock order: ledger, then client_sessions.
                {
                    let mut ledger = self.ledger.lock().await;
                    if inserted {
                        ledger.remove(&tug_session_id);
                    }
                    let mut cs = self.client_sessions.lock().await;
                    if let Some(set) = cs.get_mut(&client_id) {
                        set.remove(&tug_session_id);
                    }
                }
                if inserted {
                    if let Err(e) = self.registry.release(&workspace_key) {
                        warn!(
                            card_id,
                            session = %tug_session_id,
                            error = %e,
                            "spawn_session: terminal-gate workspace release failed (ignored)"
                        );
                    }
                }
                warn!(
                    card_id,
                    session = %tug_session_id,
                    "spawn_session: resume rejected — session live in terminal"
                );
                self.session_state.publish_tagged(build_session_state_frame(
                    &tug_session_id,
                    "errored",
                    Some("session_live_in_terminal"),
                ));
                return Err(ControlError::CapExceeded {
                    reason: "session_live_in_terminal",
                });
            }
        }

        // Persistence of the (card_id → session) binding happens
        // through the sqlite-backed `SessionLedger` row that the bridge
        // writes on `session_init` (in `relay_session_io`). The
        // supervisor's in-memory `LedgerEntry` carries `card_id` and
        // `session_mode` for the lifetime of the entry; the bridge's
        // atomic-promote block calls `sessions_recorder.record(...)`
        // under a single lock, and the `LedgerSessionsRecorder`
        // translates that into a `record_spawn` ledger write keyed by
        // claude's session id. The client-side restore consults that
        // ledger via the `list_card_bindings` CONTROL verb.
        //
        // Phase 3: per-session mutation + publish + replay, under the
        // per-session lock. Reconnect flows observe the existing entry and
        // its `latest_metadata`; fresh flows observe a just-minted Idle
        // entry with `latest_metadata: None`.
        let (replay_frame, capabilities_frame, rate_limit_frame) = {
            let mut entry = entry_arc.lock().await;
            // Record the binding card. `card_id` is preserved across
            // lifecycle transitions (close/errored/crash-exhausted),
            // so this assignment is durable. The live-elsewhere check
            // gates on `spawn_state` instead of nullity. Same-card
            // reconnects overwrite with the same value (no-op).
            entry.card_id = Some(card_id.to_owned());
            // Prefer the in-memory slot (freshest — captured this process);
            // fall back to the persisted ledger row so a resumed/known
            // session surfaces its last-known model / version / mode the
            // moment the card binds, before any turn. claude is silent in
            // stream-json mode until the first user message, so without this
            // a fresh-process resume shows nothing live until the user types.
            // Keyed by claude's session id (the metadata PK); falls back to
            // the tug id for un-forked sessions where the two are equal.
            let metadata = match entry.latest_metadata.clone() {
                Some(frame) => Some(frame),
                None => self.persisted_metadata_replay_frame(
                    entry.claude_session_id.as_deref(),
                    tug_session_id.as_str(),
                ),
            };
            // Capabilities (the turn-free `initialize` model list +
            // command catalog) prefer the in-memory slot (freshest —
            // captured this process); fall back to the persisted
            // `session_capabilities` row so a resumed session's `/`
            // catalog and version survive an app restart — the slot dies
            // with the process, and the health-gated resume handshake
            // answers seconds after spawn at the earliest. The next live
            // capabilities frame replaces both wholesale.
            let capabilities = match entry.latest_capabilities.clone() {
                Some(frame) => Some(frame),
                None => self.persisted_capabilities_replay_frame(tug_session_id.as_str()),
            };
            // Rate-limit (the per-turn quota broadcast) is in-memory
            // only — replayed on reconnect / HMR remount so the Z4B
            // rate-limit chip keeps its state even though the last
            // per-turn broadcast already flew. Absent until the first turn
            // emits one.
            (metadata, capabilities, entry.latest_rate_limit.clone())
        };
        // Live-elsewhere visibility for cross-card pickers is driven by
        // the ledger row the bridge writes on `session_init` (with
        // `state="live"` and `card_id`). Pre-handshake spawns don't
        // appear in any picker — by then the user has already chosen.

        self.session_state.publish_tagged(build_session_state_frame(
            &tug_session_id,
            "pending",
            None,
        ));

        if let Some(frame) = replay_frame {
            self.session_sideband.publish_tagged(frame);
        }
        if let Some(frame) = capabilities_frame {
            self.session_sideband.publish_tagged(frame);
        }
        if let Some(frame) = rate_limit_frame {
            self.session_sideband.publish_tagged(frame);
        }

        // Eager spawn: transition Idle→Spawning and launch the tugcode
        // subprocess now, before the ack goes out. Resume failures
        // surface within ~1s of card open (claude exits fast on a
        // stale id), not 8+s after the user types and submits.
        //
        // The dispatcher's lazy Idle→Spawn branch stays in place as a
        // defense-in-depth path for ledger entries rebound from
        // tugbank at startup; in normal client flow it is unreachable
        // because do_spawn_session promotes Idle→Spawning before any
        // CODE_INPUT frame can arrive.
        let should_spawn = {
            let mut entry = entry_arc.lock().await;
            if entry.spawn_state == SpawnState::Idle {
                entry.spawn_state.try_transition(SpawnState::Spawning).ok();
                true
            } else {
                false
            }
        };
        if should_spawn {
            tracing::info!(
                target: "dev::session-lifecycle",
                event = "supervisor.eager_spawn",
                tug_session_id = %tug_session_id,
                card_id = card_id,
            );

            // (Migration bootstrap and supervisor-side spawn-time
            // reconciliation both removed by mid-turn-replay
            // [Step 5.2](#step-5-2) / [Step 5.6](#step-5-6).
            // Tug has no production users, so historical JSONL
            // → ledger migration is unneeded; the journal only ever
            // holds *currently pending* submissions, never historical
            // ones. Per-session pending rows are surfaced directly
            // by tugcode's `runReplay` via `injectPendingRowSynthetics`,
            // which reads the journal through the cross-process
            // bun:sqlite handle and emits a synthetic
            // `user_message_replay` for each pending row whose
            // `user_text` doesn't appear in JSONL — no supervisor
            // sweep step needed.)
            self.spawn_session_worker(&tug_session_id).await;
        }

        //
        // `workspace_key` so tugdeck can stamp it into the per-card binding
        // store without attempting client-side canonicalization (which
        // would miss macOS firmlinks). W1 had no explicit ack frame on this
        // code path — a successful `spawn_session` simply returned Ok(())
        // and the wire observation was the subsequent `pending`/`spawning`
        // SESSION_STATE transitions. Emitting the ack as an explicit CONTROL
        // frame here lets tugdeck's spawn-session handler populate the
        // binding store in the same round-trip.
        // The ack also echoes `session_mode` so tugdeck's
        // `cardSessionBindingStore` stamps the user's new-vs-resume choice
        // into the binding. Pre-4.5 clients ignore the extra field.
        //
        // For reconnects (entry already existed), echo the mode the ledger
        // *already* holds — not the one the incoming payload carried —
        // because the running tugcode subprocess was spawned with the
        // original mode and silently switching it client-side would
        // misrepresent live state.
        let effective_mode = if inserted {
            session_mode
        } else {
            entry_arc.lock().await.session_mode
        };
        // Carry the ledger's name/tag on the ack so tugdeck seeds the Z4B
        // chip's caches at bind time. A resume (row already exists) binds via
        // this ack alone: `session_updated` only pushes at turn boundaries, so
        // without this a mid-turn resume shows the id-hash for the whole
        // in-flight turn even though the ledger holds a good name/tag. A fresh
        // spawn's row doesn't exist yet (the bridge writes it on
        // `session_init`) — `None`/`false` here, which the client seeds
        // non-clobberingly so it can't wipe the optimistic tag.
        let row = self
            .session_ledger
            .as_ref()
            .and_then(|ledger| ledger.get(tug_session_id.as_str()).ok().flatten());
        let (row_name, row_name_user_set, row_tag, row_synopsis, row_private) = row
            .as_ref()
            .map(|row| {
                (
                    row.name.clone(),
                    row.name_user_set,
                    row.tag.clone(),
                    row.synopsis.clone(),
                    row.private,
                )
            })
            .unwrap_or((None, false, None, None, false));
        // The line the ack reports is the entry's — the row does not exist yet
        // on a fresh spawn, and the entry is where the payload's line landed.
        let row_line_id = match row.as_ref() {
            Some(row) if !row.line_id.is_empty() => Some(row.line_id.clone()),
            _ => {
                let entry = entry_arc.lock().await;
                entry.line_id.clone()
            }
        };
        // **The seat ([B01]).** `tug_session_id` above is the bridge's key —
        // the id the card first spawned under — and after a rotation that is
        // a closed segment. The line's live segment is what the deck's arc
        // index, the masthead marker and the Z2 cell are keyed by, and
        // nothing else on a reconnect announces it ([F05]): the seat frame
        // fires only on a fresh claude id. So the ack carries it.
        //
        // `live_segment_of` answers for the line, so the attached key is
        // enough whenever the ledger has seen it; the requested id is the
        // fall-through for an attach whose key the ledger does not know.
        // `None` on a fresh spawn — the row is written at `session_init` —
        // and the deck reads a missing seat as the address, which is what it
        // did before this field existed.
        let seated_session_id = self.session_ledger.as_ref().and_then(|ledger| {
            ledger
                .live_segment_of(tug_session_id.as_str())
                .ok()
                .flatten()
                .or_else(|| {
                    ledger
                        .live_segment_of(requested_session_id.as_str())
                        .ok()
                        .flatten()
                })
        });
        // The arc binding rides the ack the same way `workspace_key` does —
        // it is what a card wears the moment it opens — and reads as unbound
        // when the arc's record is gone ([P05]). The ack is no longer the
        // binding store's only writer: `bind_arc_ok` moves it too, which is
        // what carries a rotation's seated binding onto the fresh segment.
        //
        // And the pair is read off the *seat's* row, not the address's: a
        // rotation moves the binding onto the fresh segment and takes it off
        // the one it retired, so the address's row says unbound for a card
        // that is working an arc ([F04]).
        let arc_row = match seated_session_id.as_deref() {
            Some(seat) if seat != tug_session_id.as_str() => self
                .session_ledger
                .as_ref()
                .and_then(|ledger| ledger.get(seat).ok().flatten()),
            _ => row.clone(),
        };
        let (row_arc_id, row_arc_name) = match arc_row.filter(|r| r.arc_id.is_some()) {
            Some(row) => {
                let project = row.project_dir.clone();
                // A panicked blocking task is not evidence the arc is gone
                // either — it reads as `Unreadable` for the same reason a
                // failed `git` does.
                let records = tokio::task::spawn_blocking(move || Self::live_arc_records(&project))
                    .await
                    .unwrap_or(ArcRecords::Unreadable);
                Self::reported_binding(&records, row.arc_id, row.arc_name)
            }
            None => (None, None),
        };
        // The prompt history follows a move before the move is acknowledged:
        // the ack re-binds the card, and its composer asks for history at once.
        if let Some(from) = relocate_from
            .as_ref()
            .filter(|from| **from != tug_session_id)
        {
            self.record_relocated_prompt_lineage(from, &tug_session_id);
        }
        let ack = serde_json::json!({
            "action": "spawn_session_ok",
            "card_id": card_id,
            "tug_session_id": tug_session_id.as_str(),
            // The seat ([B01]): the live segment of this card's line, when it
            // differs from the address the bridge is keyed by. Absent means
            // the seat *is* the address.
            "seated_session_id": seated_session_id,
            "workspace_key": workspace_key.as_ref(),
            // Echo the pre-canonical path the client sent so tugdeck's
            // binding store carries the form the user actually chose.
            // The filter identity comes from `workspace_key`, not this
            // field — `project_dir` is informational for UI display.
            "project_dir": project_dir_str,
            "session_mode": effective_mode.as_wire_str(),
            // The line this card is on ([P03]). Every identity-shaped store on
            // the deck keys by it, and the ack is where a fresh spawn learns
            // the id the ledger actually settled on.
            "line_id": row_line_id,
            "name": row_name,
            "name_user_set": row_name_user_set,
            "tag": row_tag,
            // The description rides the ack for the same reason the callsign
            // does: a resumed card must not sit on an empty line waiting for
            // the next listing.
            "synopsis": row_synopsis,
            // Overview privacy rides the ack for the same reason: a resumed card
            // must show the marker immediately, not wait for the next push.
            "private": row_private,
            // The arc this session is working on, or null when unbound.
            "arc_id": row_arc_id,
            "arc_name": row_arc_name,
        });
        let _ = self.control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&ack).expect("spawn_session_ok serializes"),
        ));

        // **The swap's second half ([P01]).** A directory change leaves the
        // session it moved away from, and closes it here, after the new one is
        // acknowledged and its origin resolved from the old entry — never
        // before, so a refused target leaves the card on its old session, and
        // never from the deck, whose `close_session` sweeps every bridge the
        // card holds and would take the new session with it. Only a session
        // this card holds is closed: the payload names it, and a name is not
        // authority over another card's conversation. A session already gone
        // (a reconnect re-sending the move) closes nothing.
        if let Some(from) = relocate_from.filter(|from| *from != tug_session_id) {
            let entry_arc = self.ledger.lock().await.get(&from).cloned();
            let held_by = match entry_arc {
                Some(entry_arc) => Some(entry_arc.lock().await.card_id.clone()),
                None => None,
            };
            if let Some(held_by) = held_by {
                if held_by.as_deref().is_none_or(|held| held == card_id) {
                    self.close_card_session_keeping(card_id, &from, Some(&tug_session_id))
                        .await;
                } else {
                    warn!(
                        card_id,
                        relocate_from = %from,
                        held_by = %held_by.as_deref().unwrap_or(""),
                        "spawn_session: relocate_from names another card's session; leaving it open"
                    );
                }
            }
        }

        Ok(())
    }
}
