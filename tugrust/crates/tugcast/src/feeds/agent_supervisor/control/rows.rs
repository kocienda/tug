//! The session-rows family of CONTROL actions: `trash_session`,
//! `rename_session`, `set_session_private`, and `trash_project_dir_sessions`
//! — the picker's edits to persisted session records.

use super::super::*;
use tugcast_core::ControlAction;

/// Parse a `trash_session` CONTROL payload: `{ session_id, project_dir? }`.
/// `project_dir` is optional — the picker supplies it for external rows
/// (sessions with no ledger row) so the JSONL can be located without a
/// `project_dir` column to consult.
fn parse_trash_session_payload(payload: &[u8]) -> Result<(String, Option<String>), ControlError> {
    let session_id = parse_session_id_payload(payload)?;
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok((session_id, project_dir))
}

/// Parse a `rename_session` CONTROL payload: `{ line_id, name }`. A missing /
/// empty / whitespace-only `name` clears the name (`None`); otherwise the
/// trimmed name is kept.
///
/// **A rename names a line, not a segment** ([P11]). The name is the line's
/// title, so the address is the line's id — an id the deck holds for every
/// card it has a binding for, and one that does not move when the card's
/// claude id rotates mid-rename.
fn parse_rename_session_payload(payload: &[u8]) -> Result<(String, Option<String>), ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let id = value
        .get("line_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingLineId)?
        .to_string();
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((id, name))
}

/// Parse a `set_session_private` CONTROL payload: `{ session_id, private }`.
/// A missing or non-boolean `private` reads as `true` — the payload's only
/// reason to exist is to mark a session, and defaulting the other way would
/// silently do nothing to a session the user just asked to hide.
fn parse_set_session_private_payload(payload: &[u8]) -> Result<(String, bool), ControlError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ControlError::Malformed)?;
    let id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(ControlError::MissingSessionId)?
        .to_string();
    let private = value
        .get("private")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    Ok((id, private))
}

impl AgentSupervisor {
    /// The session-rows family's share of [`AgentSupervisor::handle_control`]:
    /// the same arms, the same replies, reached through one delegating arm there.
    pub(in crate::feeds::agent_supervisor) async fn handle_rows_control(
        &self,
        action: ControlAction,
        payload: &[u8],
    ) -> ControlOutcome {
        let result: Result<(), ControlError> = match action {
            ControlAction::TrashSession => match parse_trash_session_payload(payload) {
                Ok((session_id, project_dir)) => {
                    self.do_trash_session(&session_id, project_dir.as_deref())
                        .await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            ControlAction::RenameSession => match parse_rename_session_payload(payload) {
                Ok((line_id, name)) => {
                    self.do_rename_session(&line_id, name.as_deref()).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            ControlAction::SetSessionPrivate => match parse_set_session_private_payload(payload) {
                Ok((session_id, private)) => {
                    self.do_set_session_private(&session_id, private).await;
                    Ok(())
                }
                Err(e) => return ControlOutcome::Error(e),
            },
            ControlAction::TrashProjectDirSessions => match parse_project_dir_payload(payload) {
                Ok(project_dir) => {
                    self.do_trash_project_dir_sessions(&project_dir).await;
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

    /// Handle a `trash_session` CONTROL request. For ledger rows this
    /// deletes the row and moves the JSONL to in-place trash (the
    /// ledger refuses live rows). For external sessions — no ledger
    /// row, `project_dir` supplied by the picker — the JSONL move is
    /// the whole operation. Both paths are gated on terminal liveness.
    async fn do_trash_session(&self, session_id: &str, project_dir: Option<&str>) {
        let Some(ledger) = self.session_ledger.as_ref() else {
            let body = serde_json::json!({
                "action": "trash_session_err",
                "session_id": session_id,
                "reason": "no_ledger",
            });
            let _ = self.control_tx.send(Frame::new(
                FeedId::CONTROL,
                serde_json::to_vec(&body).expect("trash_session_err serializes"),
            ));
            return;
        };
        // Terminal-liveness gate: trashing moves the JSONL out from
        // under any process holding the session — refuse while a live
        // terminal process is registered against it, mirroring the
        // ledger's own live-row refusal.
        let registry_root = self.terminal_registry_root();
        let sid = session_id.to_owned();
        let held = tokio::task::spawn_blocking(move || {
            Self::read_terminal_live_sessions(registry_root.as_deref()).contains_key(&sid)
        })
        .await
        .unwrap_or(false);
        if held {
            let body = serde_json::json!({
                "action": "trash_session_err",
                "session_id": session_id,
                "reason": "session_live_in_terminal",
            });
            let _ = self.control_tx.send(Frame::new(
                FeedId::CONTROL,
                serde_json::to_vec(&body).expect("trash_session_err serializes"),
            ));
            return;
        }
        match ledger.trash(session_id) {
            Ok(_) => {
                let _ = self
                    .control_tx
                    .send(build_session_removed_frame(session_id));
                let body = serde_json::json!({
                    "action": "trash_session_ok",
                    "session_id": session_id,
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("trash_session_ok serializes"),
                ));
            }
            Err(crate::session_ledger::LedgerError::InvalidState(_)) => {
                let body = serde_json::json!({
                    "action": "trash_session_err",
                    "session_id": session_id,
                    "reason": "session_is_live",
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("trash_session_err serializes"),
                ));
            }
            Err(crate::session_ledger::LedgerError::NotFound(_)) => {
                // No ledger row. With a project_dir in the payload this
                // is an external session: the JSONL move is the whole
                // trash operation.
                if let Some(pd) = project_dir {
                    let ledger_arc = Arc::clone(ledger);
                    let pd_owned = pd.to_owned();
                    let sid = session_id.to_owned();
                    let moved = tokio::task::spawn_blocking(move || {
                        ledger_arc.trash_external_jsonl(&pd_owned, &sid)
                    })
                    .await
                    .unwrap_or(None);
                    if moved.is_some() {
                        let _ = self
                            .control_tx
                            .send(build_session_removed_frame(session_id));
                        let body = serde_json::json!({
                            "action": "trash_session_ok",
                            "session_id": session_id,
                        });
                        let _ = self.control_tx.send(Frame::new(
                            FeedId::CONTROL,
                            serde_json::to_vec(&body).expect("trash_session_ok serializes"),
                        ));
                        return;
                    }
                }
                let body = serde_json::json!({
                    "action": "trash_session_err",
                    "session_id": session_id,
                    "reason": "not_found",
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("trash_session_err serializes"),
                ));
            }
            Err(err) => {
                warn!(error = %err, session_id, "trash_session ledger error");
                let body = serde_json::json!({
                    "action": "trash_session_err",
                    "session_id": session_id,
                    "reason": "ledger_write_failed",
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("trash_session_err serializes"),
                ));
            }
        }
    }

    /// Handle a `rename_session` CONTROL request. Writes the name to the
    /// **line** ([P11]) and broadcasts a `session_updated` for the segment a
    /// restore would seat, so the chooser + the Z4B session chip pick it up
    /// live, then acks `rename_session_ok` / `_err`.
    ///
    /// Both acks carry the name they were asked for. CONTROL is a broadcast and
    /// the client renames optimistically, so the name is what lets it tell this
    /// ack from the one for a rename it has already superseded — and a refusal
    /// no client can place is a refusal it cannot undo.
    ///
    /// **The newest naming gesture wins**: a spelling another line already
    /// wears is taken from it rather than refused ([P11]). Each displaced line
    /// gets the same treatment the renamed one does — a `session_renamed` fact
    /// recording the loss, and a `session_updated` push so its chip falls back
    /// to its callsign without a re-fetch — and the ack's `displaced` list
    /// names them so the gesture can say whose name it took.
    async fn do_rename_session(&self, line_id: &str, name: Option<&str>) {
        let refuse = |reason: &str| {
            let body = serde_json::json!({
                "action": "rename_session_err",
                "line_id": line_id,
                "name": name,
                "reason": reason,
            });
            let _ = self.control_tx.send(Frame::new(
                FeedId::CONTROL,
                serde_json::to_vec(&body).expect("rename_session_err serializes"),
            ));
        };
        let Some(ledger) = self.session_ledger.as_ref() else {
            refuse("no_ledger");
            return;
        };
        // Read the name being replaced before it is gone — a rename fact that
        // said only the new name would be half the event.
        let Some(line) = ledger.get_line(line_id).ok().flatten() else {
            refuse("not_found");
            return;
        };
        let old_name = line.name;
        match ledger.rename(line_id, name) {
            Ok(displaced) => {
                // The fact files under the segment a resume would seat. The
                // fact base is keyed by session id, and that segment is the id
                // every other fact about this conversation is landing under.
                let segment = ledger.resume_segment_for_line(line_id).ok().flatten();
                if let Some(segment) = segment.as_ref() {
                    if let Err(err) =
                        ledger.record_fact(&crate::feeds::facts_library::session_renamed_fact(
                            crate::session_ledger::now_millis(),
                            &segment.session_id,
                            old_name.as_deref(),
                            name,
                        ))
                    {
                        warn!(error = %err, line_id, "rename fact write failed");
                    }
                    // Push the updated row so the chooser + chip reflect the
                    // rename without a re-fetch. The row is re-read rather than
                    // reused: the name reaches it through the line join ([P02]),
                    // so the copy taken before the write still carries the old
                    // one.
                    if let Ok(Some(row)) = ledger.get(&segment.session_id) {
                        // The scan-cache lookup rides the rename push too — see
                        // `build_session_updated_frame` for why omitting it
                        // would blank a known size and zero a scan-derived turn
                        // count. The usage lookup rides it for the same reason.
                        let metrics = ledger.scan_metrics_for(&segment.session_id).unwrap_or(None);
                        let usage = ledger.usage_for(&segment.session_id).unwrap_or(None);
                        let _ = self
                            .control_tx
                            .send(build_session_updated_frame(&row, metrics, usage));
                    }
                }
                // Every line the name was taken from is un-taught the same way
                // the renamed one is taught: the loss is a fact on its own
                // conversation, and the push is what makes its chip fall back
                // to the callsign live. The name it lost is the spelling that
                // was asked for — there is nothing else it could have been.
                for holder in &displaced {
                    let Some(segment) = ledger
                        .resume_segment_for_line(&holder.line_id)
                        .ok()
                        .flatten()
                    else {
                        continue;
                    };
                    if let Err(err) =
                        ledger.record_fact(&crate::feeds::facts_library::session_renamed_fact(
                            crate::session_ledger::now_millis(),
                            &segment.session_id,
                            name,
                            None,
                        ))
                    {
                        warn!(
                            error = %err,
                            line_id = holder.line_id.as_str(),
                            "displaced-rename fact write failed"
                        );
                    }
                    if let Ok(Some(row)) = ledger.get(&segment.session_id) {
                        let metrics = ledger.scan_metrics_for(&segment.session_id).unwrap_or(None);
                        let usage = ledger.usage_for(&segment.session_id).unwrap_or(None);
                        let _ = self
                            .control_tx
                            .send(build_session_updated_frame(&row, metrics, usage));
                    }
                }
                let body = serde_json::json!({
                    "action": "rename_session_ok",
                    "line_id": line_id,
                    "name": name,
                    // The lines that lost this name to the gesture, so the
                    // bulletin can say who it was taken from ([P11]).
                    "displaced": displaced
                        .iter()
                        .map(|holder| serde_json::json!({
                            "line_id": holder.line_id,
                            "tag": holder.tag,
                        }))
                        .collect::<Vec<_>>(),
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("rename_session_ok serializes"),
                ));
            }
            Err(crate::session_ledger::LedgerError::NotFound(_)) => refuse("not_found"),
            Err(err) => {
                warn!(error = %err, line_id, "rename_session ledger error");
                refuse("ledger_write_failed");
            }
        }
    }

    /// Handle a `set_session_private` CONTROL request ([P05], [Q01]).
    ///
    /// Writes the flag, pushes the row so the chip shows the resting state, and
    /// acks `set_session_private_ok` / `_err`. **No fact is recorded for the
    /// toggle itself** — recording the act of hiding would leak the hiding.
    ///
    /// The refusal carries the value it refused, the way the ack carries the
    /// value it wrote. The client toggles from what it holds, so a refused
    /// write's prior state is the negation of the request — and without that
    /// value on the wire the client cannot tell a refused "make it private"
    /// from a refused "make it public", which are opposite states to put back.
    async fn do_set_session_private(&self, session_id: &str, private: bool) {
        let err = |reason: &str| {
            serde_json::json!({
                "action": "set_session_private_err",
                "session_id": session_id,
                "private": private,
                "reason": reason,
            })
        };
        let Some(ledger) = self.session_ledger.as_ref() else {
            let _ = self.control_tx.send(Frame::new(
                FeedId::CONTROL,
                serde_json::to_vec(&err("no_ledger")).expect("set_session_private_err serializes"),
            ));
            return;
        };
        match ledger.set_session_private(session_id, private) {
            Ok(()) => {
                if let Ok(Some(row)) = ledger.get(session_id) {
                    let metrics = ledger.scan_metrics_for(session_id).unwrap_or(None);
                    let usage = ledger.usage_for(session_id).unwrap_or(None);
                    let _ = self
                        .control_tx
                        .send(build_session_updated_frame(&row, metrics, usage));
                }
                let body = serde_json::json!({
                    "action": "set_session_private_ok",
                    "session_id": session_id,
                    "private": private,
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("set_session_private_ok serializes"),
                ));
            }
            Err(crate::session_ledger::LedgerError::NotFound(_)) => {
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&err("not_found"))
                        .expect("set_session_private_err serializes"),
                ));
            }
            Err(e) => {
                warn!(error = %e, session_id, "set_session_private ledger error");
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&err("ledger_write_failed"))
                        .expect("set_session_private_err serializes"),
                ));
            }
        }
    }

    /// Handle a `trash_project_dir_sessions` CONTROL request. Drops every
    /// non-live row whose `project_dir` matches the request, broadcasts a
    /// `session_updated { removed: true }` per dropped id, and returns a
    /// count via `trash_project_dir_sessions_ok`. Used by the recents-
    /// eviction → ledger-eviction coupling.
    async fn do_trash_project_dir_sessions(&self, project_dir: &str) {
        let Some(ledger) = self.session_ledger.as_ref() else {
            let body = serde_json::json!({
                "action": "trash_project_dir_sessions_err",
                "project_dir": project_dir,
                "reason": "no_ledger",
            });
            let _ = self.control_tx.send(Frame::new(
                FeedId::CONTROL,
                serde_json::to_vec(&body).expect("trash_project_dir_sessions_err serializes"),
            ));
            return;
        };
        match ledger.trash_for_project_dir(project_dir) {
            Ok(dropped) => {
                for id in &dropped {
                    let _ = self.control_tx.send(build_session_removed_frame(id));
                }
                let body = serde_json::json!({
                    "action": "trash_project_dir_sessions_ok",
                    "project_dir": project_dir,
                    "count": dropped.len(),
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("trash_project_dir_sessions_ok serializes"),
                ));
            }
            Err(err) => {
                warn!(error = %err, project_dir, "trash_for_project_dir failed");
                let body = serde_json::json!({
                    "action": "trash_project_dir_sessions_err",
                    "project_dir": project_dir,
                    "reason": "ledger_write_failed",
                });
                let _ = self.control_tx.send(Frame::new(
                    FeedId::CONTROL,
                    serde_json::to_vec(&body).expect("trash_project_dir_sessions_err serializes"),
                ));
            }
        }
    }
}
