//! The arc family of CONTROL actions: `bind_arc`, `arc_resume`, `arc_run`,
//! `arc_stop`, and `unbind_arc` — a card's mating to an arc and the
//! transport presses that start, resume, and stop it.

use super::super::*;

/// A `bind_arc` request: which session is taking up which arc, in which
/// project (Spec S03).
pub(in crate::feeds::agent_supervisor) struct BindArcPayload {
    pub(in crate::feeds::agent_supervisor) tug_session_id: String,
    pub(in crate::feeds::agent_supervisor) project_dir: String,
    pub(in crate::feeds::agent_supervisor) arc: String,
}

pub(in crate::feeds::agent_supervisor) fn parse_bind_arc_payload(
    payload: &[u8],
) -> Result<BindArcPayload, ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let tug_session_id = value
        .get("tug_session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::InvalidProjectDir {
            reason: "missing_project_dir",
        })?
        .to_string();
    let arc = value
        .get("arc")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::Malformed)?
        .to_string();
    Ok(BindArcPayload {
        tug_session_id,
        project_dir,
        arc,
    })
}

impl AgentSupervisor {
    /// The arc family's share of [`AgentSupervisor::handle_control`]: the
    /// same arms, the same replies, reached through one delegating arm there.
    pub(in crate::feeds::agent_supervisor) async fn handle_arc_control(
        &self,
        action: &str,
        payload: &[u8],
    ) -> ControlOutcome {
        let result: Result<(), ControlError> = match action {
            "bind_arc" => match parse_bind_arc_payload(payload) {
                Ok(parsed) => {
                    self.do_bind_arc(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            // Same payload as `bind_arc`, deliberately: a resume *is* a bind
            // with the stop cleared first, so a second shape would be a
            // second spelling of one fact.
            "arc_resume" => match parse_bind_arc_payload(payload) {
                Ok(parsed) => {
                    self.do_arc_resume(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            // The same payload, and nothing beside it. The open reads the
            // arc's kind off its documents ([P03]), so a press that computed
            // one and sent it would be a control owning a fact about the
            // responder's data.
            "arc_run" => match parse_bind_arc_payload(payload) {
                Ok(parsed) => {
                    self.do_arc_run(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            // And once more for the stop, which names no kind: the arc it
            // stops is the one the card is already running.
            "arc_stop" => match parse_bind_arc_payload(payload) {
                Ok(parsed) => {
                    self.do_arc_stop(&parsed).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            "unbind_arc" => match parse_tug_session_id_payload(payload) {
                Ok(session_id) => {
                    self.do_unbind_arc(session_id.as_str()).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            _ => return ControlOutcome::PassThrough,
        };

        match result {
            Ok(()) => ControlOutcome::Handled,
            Err(e) => ControlOutcome::Error(e),
        }
    }

    /// Handle a `bind_arc` CONTROL request (Spec S03): mate a session to an
    /// arc. Shares its ledger half with `POST /api/arc` so a bind issued
    /// from a card and one issued from the CLI cannot diverge.
    ///
    /// Broadcasts `bind_arc_ok {tug_session_id, arc_id, arc_name}` or
    /// `bind_arc_err {reason}`, and fires the aggregate changeset bump on
    /// success — the same bump a landing fires, so the Changes card recomposes
    /// with the new mating.
    async fn do_bind_arc(&self, request: &BindArcPayload) {
        let Some(ledger) = self.session_ledger.clone() else {
            Self::send_bind_arc_err(&self.control_tx, &request.tug_session_id, "no_ledger");
            return;
        };
        // The gateway ([L29]) — the same resolution `/api/arc` applies, so
        // both surfaces open the same repo for the same spelling.
        let project = crate::path_resolver::resolve_to_claude_form(std::path::Path::new(
            &request.project_dir,
        ));
        let session = request.tug_session_id.clone();
        let arc = request.arc.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            crate::arc_api::bind(&ledger, &project, &session, &arc)
        })
        .await;

        match outcome {
            Ok(crate::arc_api::ArcApiOutcome::Bound {
                session_id,
                arc_id,
                arc_name,
            }) => {
                self.registry.changeset_all_bump().notify_one();
                // The segment the write landed on, not the one the request
                // named — see the door's own note on the expansion.
                //
                // No routing halves: this door binds a segment the card is
                // already seated on, so the deck's own walk resolves it. The
                // seat is the one caller whose segment the deck has never met.
                broadcast_bind_arc_ok(
                    &self.control_tx,
                    &session_id,
                    &arc_id,
                    &arc_name,
                    None,
                    None,
                );
            }
            Ok(crate::arc_api::ArcApiOutcome::UnknownSession) => {
                Self::send_bind_arc_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    "unknown_session",
                );
            }
            Ok(crate::arc_api::ArcApiOutcome::Error(detail)) => {
                Self::send_bind_arc_err(&self.control_tx, &request.tug_session_id, &detail);
            }
            Ok(_) => {}
            Err(join_err) => {
                Self::send_bind_arc_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &format!("bind task failed: {join_err}"),
                );
            }
        }
    }

    /// Bind the calling session to the arc a door prompt named, at submit
    /// time — the same ledger half `do_bind_arc` and `/api/arc` share, so a
    /// bind from the keystroke, from the card, and from the CLI cannot
    /// diverge. A bind mints the arc's *id*, not its directory, and the
    /// aggregate lists an arc by its branch or its directory — neither of
    /// which a just-typed name has — so on success this also makes the
    /// documents directory, the same empty directory `arc documents
    /// --ensure` is about to make, which is what puts the arc on the wire
    /// for the card to read `ARC` against ([F03]).
    ///
    /// A refusal is logged and nothing else. This bind is a head start on the
    /// one the door's own first command makes with `arc documents --ensure
    /// --bind`, and that one reports its refusal on the transcript where the
    /// model reads it; raising a card bulletin here as well would say the
    /// same thing twice, once to nobody.
    pub(in crate::feeds::agent_supervisor) async fn bind_arc_at_the_door(
        &self,
        tug_session_id: &TugSessionId,
        entry_arc: &Arc<Mutex<LedgerEntry>>,
        arc: &str,
    ) {
        let Some(ledger) = self.session_ledger.clone() else {
            return;
        };
        let project_dir = entry_arc.lock().await.project_dir.clone();
        // The gateway ([L29]) — the same resolution every other bind applies.
        let project = crate::path_resolver::resolve_to_claude_form(&project_dir);
        let session = tug_session_id.as_str().to_string();
        let name = arc.to_string();
        let outcome = tokio::task::spawn_blocking(move || {
            let outcome = crate::arc_api::bind(&ledger, &project, &session, &name);
            if matches!(outcome, crate::arc_api::ArcApiOutcome::Bound { .. }) {
                let dir = tugarc_core::documents_dir(&project, &name);
                match std::fs::create_dir_all(&dir) {
                    Ok(()) => tugarc_core::ensure_tug_excluded(&project),
                    Err(err) => warn!(
                        error = %err,
                        dir = %dir.display(),
                        "door prompt: bound, but could not make the documents directory",
                    ),
                }
            }
            outcome
        })
        .await;
        match outcome {
            Ok(crate::arc_api::ArcApiOutcome::Bound {
                session_id,
                arc_id,
                arc_name,
            }) => {
                self.registry.changeset_all_bump().notify_one();
                broadcast_bind_arc_ok(
                    &self.control_tx,
                    &session_id,
                    &arc_id,
                    &arc_name,
                    None,
                    None,
                );
            }
            Ok(crate::arc_api::ArcApiOutcome::Error(detail)) => {
                warn!(
                    tug_session_id = %tug_session_id,
                    arc,
                    detail,
                    "door prompt: bind refused; the door's own bind will say so",
                );
            }
            Ok(_) => {}
            Err(join_err) => {
                warn!(
                    tug_session_id = %tug_session_id,
                    arc,
                    error = %join_err,
                    "door prompt: bind task failed",
                );
            }
        }
    }

    /// Handle an `arc_resume` CONTROL request: pick a stopped arc back up on
    /// the card that sent it — the Resume button in a stop receipt's own row.
    ///
    /// Broadcasts **two** frames on success, because two things happened.
    /// `bind_arc_ok` is the mating, and it is the same fact through either
    /// door — a deck that learned about a bind from one door and not the
    /// other wears a chip that disagrees with the ledger. `arc_resume_ok` is
    /// the answer to the press, which is what lets the button stop being
    /// pending. A refusal sends `arc_resume_err` only: nothing was mated, so
    /// there is no mating to announce.
    async fn do_arc_resume(&self, request: &BindArcPayload) {
        let Some(ledger) = self.session_ledger.clone() else {
            Self::send_arc_resume_err(
                &self.control_tx,
                &request.tug_session_id,
                &request.arc,
                "no_ledger",
            );
            return;
        };
        // The gateway ([L29]) — the same resolution `bind_arc` and
        // `/api/arc` apply, so all three open the same repo for one spelling.
        let project = crate::path_resolver::resolve_to_claude_form(std::path::Path::new(
            &request.project_dir,
        ));
        let session = request.tug_session_id.clone();
        let arc = request.arc.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            crate::arc_api::arc_resume(&ledger, &project, &session, &arc)
        })
        .await;

        match outcome {
            Ok(crate::arc_api::ArcApiOutcome::Bound {
                session_id,
                arc_id,
                arc_name,
            }) => {
                self.registry.changeset_all_bump().notify_one();
                broadcast_bind_arc_ok(
                    &self.control_tx,
                    &session_id,
                    &arc_id,
                    &arc_name,
                    None,
                    None,
                );
                Self::send_arc_resume_ok(&self.control_tx, &session_id, &arc_name);
            }
            Ok(crate::arc_api::ArcApiOutcome::UnknownSession) => {
                Self::send_arc_resume_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    "unknown_session",
                );
            }
            Ok(crate::arc_api::ArcApiOutcome::Error(detail)) => {
                Self::send_arc_resume_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    &detail,
                );
            }
            Ok(_) => {}
            Err(join_err) => {
                Self::send_arc_resume_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    &format!("resume task failed: {join_err}"),
                );
            }
        }
    }

    /// Perform a stop the blocking half already decided on — a protocol with
    /// an end, whose answer follows the stop rather than the decision.
    ///
    /// In order, each awaited ([P06]): mark the arc `stopping`; resolve the
    /// card; interrupt the turn if one is running; tell tugcode to end the
    /// session's background work and sweep its claude's process group; wait
    /// for the session to read [`LedgerEntry::is_quiet`]; evict the runner's
    /// memory; and only then hand the card back, send the receipt, and append
    /// the `arc-stop` line. The record is the **last** thing a stop writes,
    /// so `Ok(())` — and the `arc_stop_ok` the caller sends on it — means the
    /// arc has stopped rather than that a line was appended, which is the
    /// [L31] fault this control exists to remove.
    ///
    /// **The wait is bounded** by `[tugtool.arc] arc_stop_ceiling_secs`,
    /// thirty seconds by default — above tugcode's own teardown ladder with
    /// margin. A wait that runs out returns `Err("stop stalled at: quiet")`
    /// having appended the abandon line, so the mark never outlives the press
    /// ([P03]) and no `arc-stop` is written over an arc that may still be
    /// running. Every other refusal here leaves the record in the same state:
    /// marked, then abandoned, and stopped by nothing.
    ///
    /// Lifted here from `server.rs`'s `ArcStopped` arm so both doors — the
    /// HTTP route the CLI posts to and the CONTROL frame the transport
    /// control sends — take one path ([P03]).
    ///
    /// **`halt` is what makes Stop a button rather than a request.** With a
    /// turn running on the bound session, `arc_stop` dispatches the deck's own
    /// `interrupt` frame first, so the work ends now rather than at the end of
    /// a turn that may have minutes left in it ([B06]). `arc_ask` passes
    /// `false`: a stage ending its own turn over a question is mid-sentence,
    /// and interrupting it would truncate the very thing the receipt exists to
    /// carry.
    ///
    /// That claim — that `halt` dispatches the deck's own `interrupt` — is
    /// true only of the frame this function now addresses to the **card**.
    ///
    /// **The identity model: the decide half keeps the segment, the perform
    /// half addresses the card** ([P01]). `session` arrives as whatever
    /// `arc_api::arc_stop` resolved, which is the arc line's live *segment* —
    /// the vocabulary `bound_session_by_arc` is keyed by. The supervisor
    /// ledger is keyed by the **card's** own tug session id, which never
    /// moves; a rotation mints a segment and records it as the entry's
    /// `claude_session_id`, so after any stage dispatch the live segment is an
    /// id no supervisor entry wears. Every effect below — reading
    /// `turn_active`, the `interrupt` frame, the hand-back and the receipt
    /// `stop_arc_for_session` sends — therefore converts back through
    /// [`Self::card_entry_for_segment`] first, and a segment no live card
    /// wears is `Err("no_card")` ahead of every other act rather than a green
    /// answer over an arc still running.
    ///
    /// `question` is written as an `arc-note` **before** the stop, because the
    /// receipt is composed from the record the stop path re-reads — a note
    /// written after would arrive too late to be spoken. Best-effort like
    /// every other append: a note that does not land costs the receipt its
    /// question, never the stop.
    ///
    /// Returns `Err("no_wheel")` when the wheel was never set, having stopped
    /// nothing. That is not a formality: the caller has an answer frame to
    /// send, and a `_ok` over a stop that did not happen would settle the
    /// button green over an arc still running — the [L31] fault this control
    /// exists to remove.
    pub(crate) async fn stop_arc_now(
        &self,
        session: &str,
        project: &std::path::Path,
        arc: &str,
        terms: StopTerms<'_>,
    ) -> Result<(), &'static str> {
        // The mark, before anything else ([P02]). From here to the last line
        // the record says a stop is under way, so no reader has to infer it
        // from a silence that now lasts seconds rather than milliseconds, and
        // every exit below goes through `abandon` or through the `arc-stop`
        // line, both of which clear it ([P03]).
        if let Err(e) = tugarc_core::arc::append_arc_stopping(project, arc, terms.stage) {
            warn!(
                arc = %arc,
                error = %e,
                "could not mark the arc as stopping; the stop runs unguarded",
            );
        }
        let abandon = |reason: &'static str| -> Result<(), &'static str> {
            if let Err(e) =
                tugarc_core::arc::append_arc_stopping_abandoned(project, arc, terms.stage)
            {
                warn!(
                    arc = %arc,
                    error = %e,
                    "could not clear the stopping mark on an abandoned stop",
                );
            }
            Err(reason)
        };
        let Some((card_session, entry)) = self.card_entry_for_segment(session).await else {
            warn!(
                arc = %arc,
                segment = %session,
                "no live card wears this session, so the stop was not performed",
            );
            return abandon("no_card");
        };
        let Some(wheel) = self.wheel.get() else {
            warn!(
                arc = %arc,
                "no wheel is attached, so the stop was not performed",
            );
            return abandon("no_wheel");
        };
        if let Some(question) = terms.question {
            if let Err(e) = tugarc_core::arc::append_arc_note(project, arc, question) {
                warn!(
                    arc = %arc,
                    error = %e,
                    "could not record the question a stage stopped over",
                );
            }
        }

        if terms.halt {
            let turn_active = entry.lock().await.turn_active;
            if turn_active {
                tracing::info!(arc = %arc, "stop halts a running turn");
                self.dispatch_one(code_input_frame(&serde_json::json!({
                    "type": "interrupt",
                    "tug_session_id": card_session.as_str(),
                })))
                .await;
            }
        }

        // Rung two: tugcode ends the rest of it ([P04]). The open jobs ride
        // the verb because the supervisor is the only holder of that set —
        // tugcode keeps none — and each gets a best-effort `stop_task` before
        // the group is reaped ([P12]). Read under a short lock, with the
        // guard dropped before anything is awaited (Risk R01).
        let task_ids: Vec<String> = entry.lock().await.open_jobs.keys().cloned().collect();
        self.dispatch_one(code_input_frame(&serde_json::json!({
            "type": "stop_all_work",
            "tug_session_id": card_session.as_str(),
            "task_ids": task_ids,
        })))
        .await;

        // Rung three: wait for it to be true. The ceiling is the project's,
        // and a wait that runs out is an abandoned stop naming the rung it
        // stalled on — never a green answer over an arc still running.
        let ceiling = {
            let project = project.to_path_buf();
            tokio::task::spawn_blocking(move || {
                tugtool_core::config::Config::load_from_project(&project)
                    .unwrap_or_default()
                    .tugtool
                    .arc
                    .stop_ceiling()
            })
            .await
            .unwrap_or_else(|_| tugtool_core::config::ArcConfig::default().stop_ceiling())
        };
        if !Self::await_quiet(&entry, ceiling).await {
            warn!(
                arc = %arc,
                card = %card_session,
                ceiling_secs = ceiling.as_secs(),
                "the session never went quiet, so the stop is abandoned rather \
                 than reported as one that landed",
            );
            return abandon("stop stalled at: quiet");
        }

        // Only now is the card genuinely the user's again, which is what
        // earns the `HandBack::Send` below.
        //
        // Evict the runner's memory of the arc before the record moves, as
        // the wheel's own stops do ([P11]). There is no `ArcReading` here to
        // seed the marks from, so they are read from the entry and the arc's
        // ledger at stop time; an arc whose ledger cannot be read seeds
        // `None`, which the runner reads as a stop it did not watch and
        // invents no baseline for.
        let wake_turns_ended = entry.lock().await.wake_turns_ended;
        let done_count = {
            let (project, arc) = (project.to_path_buf(), arc.to_owned());
            tokio::task::spawn_blocking(move || {
                crate::feeds::arc_runner::done_count_for(&project, &arc)
            })
            .await
            .ok()
            .flatten()
        };
        crate::feeds::arc_runner::evict_for_stop(
            &wheel.arc_memory,
            &crate::feeds::arc_runner::arc_key_for(project, arc),
            done_count.map(|done_count| crate::feeds::arc_runner::StopMarks {
                wake_turns_ended,
                done_count,
            }),
        )
        .await;
        // And the wait board beside it. `evict_for_stop` is keyed by the arc
        // key and clears nothing there — the board is keyed by the seat ([P02])
        // — so this is its own line rather than something that verb could do.
        // Without it a stop taken through this path leaves the card and
        // `arc status` both saying the wheel is still waiting on a run that has
        // ended.
        crate::feeds::arc_runner::clear_wait(session);

        crate::feeds::arc_runner::stop_arc_for_session(
            self,
            wheel,
            &card_session,
            project,
            arc,
            terms.stage,
            terms.reason,
            crate::feeds::arc_runner::StopDelivery {
                hand_back: crate::feeds::arc_runner::HandBack::Send,
                record: true,
            },
        )
        .await;
        self.registry.changeset_all_bump().notify_one();
        Ok(())
    }

    /// Wait until `entry` reads [`LedgerEntry::is_quiet`], or until `ceiling`
    /// runs out. Answers whether it went quiet ([P05]).
    ///
    /// **Watched, not polled.** The two facts `is_quiet` reads move at exactly
    /// three edges, and every one of them notifies the entry's `quiesced`
    /// handle from inside the guard that moved them. A loop that re-read the
    /// entry on a timer would be the shape this project refuses, and it would
    /// answer later than this does.
    ///
    /// **Arm, then re-check, then await** — in that order, and the order is
    /// the whole of it. `Notify::notify_waiters` wakes only waiters already
    /// registered, so a check made before registering leaves a window in
    /// which the edge fires, wakes nobody, and the wait then sleeps to its
    /// ceiling over a session that went quiet milliseconds ago.
    /// [`tokio::sync::Notified::enable`] registers without waiting, which is
    /// what lets the check happen after registration and before the await.
    ///
    /// **No guard is held across an await** (Risk R01). The `Notify` handle
    /// and every read of `is_quiet` take the entry lock and drop it again;
    /// the map lock is never involved at all. The frames that make a session
    /// quiet are folded by the merger task, which needs both locks, so a wait
    /// holding either would be waiting on itself.
    ///
    /// A missed notify degrades to a late `false` rather than a hang, because
    /// the whole loop runs inside one `tokio::time::timeout`. That is the one
    /// direction this wait is allowed to fail in.
    pub(in crate::feeds::agent_supervisor) async fn await_quiet(
        entry: &Arc<Mutex<LedgerEntry>>,
        ceiling: std::time::Duration,
    ) -> bool {
        let quiesced = Arc::clone(&entry.lock().await.quiesced);
        tokio::time::timeout(ceiling, async {
            loop {
                let notified = quiesced.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if entry.lock().await.is_quiet() {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }

    /// Handle an `arc_run` CONTROL request (Spec S02): start an arc on the
    /// calling card, opening it first when it has never run.
    ///
    /// The mating is announced with the same `bind_arc_ok` a bind broadcasts,
    /// because it *is* one — the `arc_run_ok` beside it is the press's own
    /// answer, which the transport control settles on.
    async fn do_arc_run(&self, request: &BindArcPayload) {
        let Some(ledger) = self.session_ledger.clone() else {
            Self::send_arc_run_err(
                &self.control_tx,
                &request.tug_session_id,
                &request.arc,
                "no_ledger",
            );
            return;
        };
        // The gateway ([L29]) — the same resolution `bind_arc` and `/api/arc`
        // apply, so all three open the same repo for one spelling.
        let project = crate::path_resolver::resolve_to_claude_form(std::path::Path::new(
            &request.project_dir,
        ));
        let session = request.tug_session_id.clone();
        let arc = request.arc.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            crate::arc_api::arc_run(&ledger, &project, &session, &arc)
        })
        .await;

        match outcome {
            Ok(crate::arc_api::ArcApiOutcome::Bound {
                session_id,
                arc_id,
                arc_name,
            }) => {
                self.registry.changeset_all_bump().notify_one();
                broadcast_bind_arc_ok(
                    &self.control_tx,
                    &session_id,
                    &arc_id,
                    &arc_name,
                    None,
                    None,
                );
                Self::send_arc_run_ok(&self.control_tx, &session_id, &arc_name);
            }
            Ok(crate::arc_api::ArcApiOutcome::UnknownSession) => {
                Self::send_arc_run_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    "unknown_session",
                );
            }
            Ok(crate::arc_api::ArcApiOutcome::Error(detail)) => {
                Self::send_arc_run_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    &detail,
                );
            }
            Ok(_) => {}
            Err(join_err) => {
                Self::send_arc_run_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    &format!("run task failed: {join_err}"),
                );
            }
        }
    }

    /// Handle an `arc_stop` CONTROL request (Spec S02): stop the arc this
    /// card is running, and keep the arc.
    ///
    /// **The answer follows the stop, not the decision to stop.** The blocking
    /// half names the stage; the async half performs it; and `arc_stop_ok` is
    /// sent only when [`Self::stop_arc_now`] reports the stop landed. The HTTP
    /// route cannot reach the other case — it refuses with 503 when the wheel
    /// is absent — but the CONTROL route can, and a green button over a
    /// running arc is exactly the [L31] fault this control exists to remove.
    ///
    /// **The answer frame is an effect, so it is addressed to the card**
    /// ([P01]). The blocking half answers in segments; `arc_stop_ok` survives
    /// that either way, because `action-dispatch.ts` settles the press on
    /// `payload.arc` rather than on the session. `arc_stop_err` does not:
    /// `arcPressStore.refuse` parks by session and `ArcPressNoticeController`
    /// reads the card's bound id, so a segment-addressed refusal lands in a
    /// slot no reader subscribes to — invisible on exactly the rotated arcs
    /// this path is about. Both frames go through the same
    /// [`Self::card_entry_for_segment`] walk, falling back to the segment when
    /// no card wears it: a refusal that cannot be routed is still better sent
    /// than swallowed.
    pub(in crate::feeds::agent_supervisor) async fn do_arc_stop(&self, request: &BindArcPayload) {
        let Some(ledger) = self.session_ledger.clone() else {
            Self::send_arc_stop_err(
                &self.control_tx,
                &request.tug_session_id,
                &request.arc,
                "no_ledger",
            );
            return;
        };
        let project = crate::path_resolver::resolve_to_claude_form(std::path::Path::new(
            &request.project_dir,
        ));
        let session = request.tug_session_id.clone();
        let arc = request.arc.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            crate::arc_api::arc_stop(&ledger, &project, &session, &arc)
        })
        .await;

        match outcome {
            Ok(crate::arc_api::ArcApiOutcome::ArcStopped {
                arc,
                stage,
                session_id,
                project_dir,
                reason,
                question,
            }) => {
                // Resolved before the stop, from the same walk `stop_arc_now`
                // makes: the card this press is to be answered on.
                let answer_to = match self.card_entry_for_segment(&session_id).await {
                    Some((card, _)) => card.as_str().to_string(),
                    None => session_id.clone(),
                };
                match self
                    .stop_arc_now(
                        &session_id,
                        std::path::Path::new(&project_dir),
                        &arc,
                        StopTerms {
                            stage,
                            reason,
                            question: question.as_deref(),
                            halt: true,
                        },
                    )
                    .await
                {
                    Ok(()) => Self::send_arc_stop_ok(&self.control_tx, &answer_to, &arc),
                    Err(reason) => {
                        Self::send_arc_stop_err(&self.control_tx, &answer_to, &arc, reason)
                    }
                }
            }
            Ok(crate::arc_api::ArcApiOutcome::UnknownSession) => {
                Self::send_arc_stop_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    "unknown_session",
                );
            }
            Ok(crate::arc_api::ArcApiOutcome::Error(detail)) => {
                Self::send_arc_stop_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    &detail,
                );
            }
            Ok(_) => {}
            Err(join_err) => {
                Self::send_arc_stop_err(
                    &self.control_tx,
                    &request.tug_session_id,
                    &request.arc,
                    &format!("stop task failed: {join_err}"),
                );
            }
        }
    }

    /// The Start press was answered. Named from the outcome's session for the
    /// reason [`Self::send_arc_resume_ok`] is.
    fn send_arc_run_ok(control_tx: &broadcast::Sender<Frame>, tug_session_id: &str, arc: &str) {
        let body = serde_json::json!({
            "action": "arc_run_ok",
            "tug_session_id": tug_session_id,
            "arc": arc,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_run_ok serializes"),
        ));
    }

    /// The Start press was refused, and `reason` is what the deck speaks
    /// through the pane bulletin ([L31]).
    fn send_arc_run_err(
        control_tx: &broadcast::Sender<Frame>,
        tug_session_id: &str,
        arc: &str,
        reason: &str,
    ) {
        let body = serde_json::json!({
            "action": "arc_run_err",
            "tug_session_id": tug_session_id,
            "arc": arc,
            "reason": reason,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_run_err serializes"),
        ));
    }

    /// The Stop press was answered, and the stop really landed.
    fn send_arc_stop_ok(control_tx: &broadcast::Sender<Frame>, tug_session_id: &str, arc: &str) {
        let body = serde_json::json!({
            "action": "arc_stop_ok",
            "tug_session_id": tug_session_id,
            "arc": arc,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_stop_ok serializes"),
        ));
    }

    /// The Stop press was refused — or was decided on and could not be
    /// performed, which is the same fact to the user and must read as one.
    fn send_arc_stop_err(
        control_tx: &broadcast::Sender<Frame>,
        tug_session_id: &str,
        arc: &str,
        reason: &str,
    ) {
        let body = serde_json::json!({
            "action": "arc_stop_err",
            "tug_session_id": tug_session_id,
            "arc": arc,
            "reason": reason,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_stop_err serializes"),
        ));
    }

    /// Handle an `unbind_arc` CONTROL request (Spec S03): drop the calling
    /// session's binding. Broadcasts `unbind_arc_ok {tug_session_id}`.
    async fn do_unbind_arc(&self, tug_session_id: &str) {
        let Some(ledger) = self.session_ledger.clone() else {
            Self::send_bind_arc_err(&self.control_tx, tug_session_id, "no_ledger");
            return;
        };
        let session = tug_session_id.to_string();
        let outcome =
            tokio::task::spawn_blocking(move || crate::arc_api::unbind(&ledger, &session)).await;

        match outcome {
            Ok(crate::arc_api::ArcApiOutcome::Unbound { session_id }) => {
                self.registry.changeset_all_bump().notify_one();
                broadcast_unbind_arc_ok(&self.control_tx, &session_id);
            }
            Ok(crate::arc_api::ArcApiOutcome::UnknownSession) => {
                Self::send_bind_arc_err(&self.control_tx, tug_session_id, "unknown_session");
            }
            Ok(crate::arc_api::ArcApiOutcome::Error(detail)) => {
                Self::send_bind_arc_err(&self.control_tx, tug_session_id, &detail);
            }
            Ok(_) => {}
            Err(join_err) => {
                Self::send_bind_arc_err(
                    &self.control_tx,
                    tug_session_id,
                    &format!("unbind task failed: {join_err}"),
                );
            }
        }
    }

    /// The press was answered. Named from the outcome's session, never the
    /// request's: the door expands a frozen id to its line's live segment,
    /// and a frame naming the posted id reaches no card.
    fn send_arc_resume_ok(control_tx: &broadcast::Sender<Frame>, tug_session_id: &str, arc: &str) {
        let body = serde_json::json!({
            "action": "arc_resume_ok",
            "tug_session_id": tug_session_id,
            "arc": arc,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_resume_ok serializes"),
        ));
    }

    /// The press was refused, and `reason` is what the deck speaks through
    /// the pane bulletin ([B08]). It names the arc as well as the session,
    /// because a card can hold several stop receipts and only one of them
    /// was pressed.
    fn send_arc_resume_err(
        control_tx: &broadcast::Sender<Frame>,
        tug_session_id: &str,
        arc: &str,
        reason: &str,
    ) {
        let body = serde_json::json!({
            "action": "arc_resume_err",
            "tug_session_id": tug_session_id,
            "arc": arc,
            "reason": reason,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("arc_resume_err serializes"),
        ));
    }

    fn send_bind_arc_err(
        control_tx: &broadcast::Sender<Frame>,
        tug_session_id: &str,
        reason: &str,
    ) {
        let body = serde_json::json!({
            "action": "bind_arc_err",
            "tug_session_id": tug_session_id,
            "reason": reason,
        });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("bind_arc_err serializes"),
        ));
    }
}
