//! The resolve run's ledger: one recorder per run, owning its sequence, its
//! events and its broadcast ([P04]).
//!
//! Three writers share one run — the ladder on a blocking thread, the scribe's
//! stream forwarder, and the resolver in a detached task — so the sequence and
//! the event list live behind one lock here rather than in any of them. A delta
//! the deck draws is a delta the ledger holds, apart from the live-only
//! `streaming` beats, which go out and are never kept.
//!
//! The broadcast is the `changeset_join_resolve_delta` CONTROL frame (Spec
//! S02): `{ action, project_dir, arc, run, event }`, where `event` is the
//! [`ArcJoinLedgerEvent`] itself, so the live frame and the record are one type.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tugarc_core::{LadderEvent, ResolveObserver};
use tugcast_core::protocol::Frame;
use tugcast_core::types::{
    ArcConflictCommit, ArcConflictHistory, ArcJoinLedger, ArcJoinLedgerEvent,
    ArcJoinLedgerEventBody, ArcResolvedFile,
};

use crate::control::send_control;

/// Wall clock, ms since the epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// One resolve run's ledger.
pub struct LedgerRecorder {
    project_dir: String,
    arc: String,
    /// Where the durable ledger is written: the project the run belongs to.
    repo: PathBuf,
    /// The run's id: `started_ms` as a decimal string. A deck that sees a new
    /// one drops what it held of the last run.
    run: String,
    started_ms: u64,
    /// Set by the run's one `ended`.
    ended_ms: Mutex<Option<u64>>,
    control_tx: broadcast::Sender<Frame>,
    events: Mutex<Vec<ArcJoinLedgerEvent>>,
}

impl LedgerRecorder {
    /// A fresh run, started now.
    pub fn new(project_dir: &str, arc: &str, control_tx: broadcast::Sender<Frame>) -> Self {
        let started_ms = now_ms();
        Self {
            project_dir: project_dir.to_string(),
            arc: arc.to_string(),
            repo: PathBuf::from(project_dir),
            run: started_ms.to_string(),
            started_ms,
            ended_ms: Mutex::new(None),
            control_tx,
            events: Mutex::new(Vec::new()),
        }
    }

    #[cfg(test)]
    pub fn run(&self) -> &str {
        &self.run
    }

    /// Every persisted event so far, in `seq` order.
    #[cfg(test)]
    pub fn events(&self) -> Vec<ArcJoinLedgerEvent> {
        self.events.lock().clone()
    }

    /// Keep an event, persist the run's ledger, and broadcast the event, with
    /// the next `seq`.
    ///
    /// The broadcast happens under the lock, so two writers on two threads can
    /// never send their deltas in the opposite order to their sequence — and
    /// the write does too, so a slower writer can never put back a ledger
    /// shorter than one already on disk. A write that fails is logged and the
    /// run goes on: the live frames still carry it, and the ledger is the
    /// account of a run rather than a condition of it.
    pub fn record(&self, body: ArcJoinLedgerEventBody) -> ArcJoinLedgerEvent {
        let mut events = self.events.lock();
        let event = ArcJoinLedgerEvent {
            seq: events.len() as u32,
            at_ms: now_ms(),
            body,
        };
        if matches!(event.body, ArcJoinLedgerEventBody::Ended { .. }) {
            *self.ended_ms.lock() = Some(event.at_ms);
        }
        events.push(event.clone());
        self.persist(&events);
        self.broadcast(&event);
        event
    }

    /// Broadcast a live-only beat without keeping it. It carries the last
    /// persisted `seq`, so it never advances the sequence a deck orders by.
    pub fn stream(&self, body: ArcJoinLedgerEventBody) {
        let events = self.events.lock();
        let event = ArcJoinLedgerEvent {
            seq: events.len().saturating_sub(1) as u32,
            at_ms: now_ms(),
            body,
        };
        self.broadcast(&event);
    }

    /// [`Self::record`] from async code. Recording writes git state, so it
    /// runs on the blocking pool rather than on a runtime thread.
    pub async fn record_blocking(self: &Arc<Self>, body: ArcJoinLedgerEventBody) {
        let this = self.clone();
        let _ = tokio::task::spawn_blocking(move || this.record(body)).await;
    }

    /// Tell a phase tugcast owns — the workshop, a resolver turn, the commit,
    /// the anchor — before its work begins, in the sentence the deck shows.
    /// `turn` is zero for every phase but a resolver turn.
    pub fn phase(&self, phase: &str, turn: u32, said: &str) -> ArcJoinLedgerEvent {
        self.record(ArcJoinLedgerEventBody::Phase {
            phase: phase.to_string(),
            rung: None,
            path: None,
            turn,
            said: said.to_string(),
        })
    }

    /// [`Self::phase`] from async code, on the blocking pool for the reason
    /// [`Self::record_blocking`] gives.
    pub async fn phase_blocking(self: &Arc<Self>, phase: &'static str, turn: u32, said: String) {
        let this = self.clone();
        let _ = tokio::task::spawn_blocking(move || this.phase(phase, turn, &said)).await;
    }

    /// Write the whole ledger as it stands, replacing the last write.
    fn persist(&self, events: &[ArcJoinLedgerEvent]) {
        let ledger = ArcJoinLedger {
            run: self.run.clone(),
            started_ms: self.started_ms,
            ended_ms: *self.ended_ms.lock(),
            events: events.to_vec(),
        };
        let json = match serde_json::to_string(&ledger) {
            Ok(json) => json,
            Err(err) => {
                tracing::warn!(arc = %self.arc, error = %err, "join-ledger: could not serialise");
                return;
            }
        };
        if let Err(err) = tugarc_core::resolve::write_ledger(&self.repo, &self.arc, &json) {
            tracing::warn!(arc = %self.arc, error = %err, "join-ledger: could not persist");
        }
    }

    fn broadcast(&self, event: &ArcJoinLedgerEvent) {
        send_control(
            &self.control_tx,
            serde_json::json!({
                "action": "changeset_join_resolve_delta",
                "project_dir": self.project_dir,
                "arc": self.arc,
                "run": self.run,
                "event": event,
            }),
        );
    }
}

impl ResolveObserver for LedgerRecorder {
    fn ladder(&self, event: LadderEvent) {
        let body = match event {
            LadderEvent::Probe { paths, archaeology } => ArcJoinLedgerEventBody::Probe {
                paths,
                archaeology: archaeology
                    .into_iter()
                    .map(|h| ArcConflictHistory {
                        path: h.path,
                        commits: h
                            .commits
                            .into_iter()
                            .map(|c| ArcConflictCommit {
                                sha: c.sha,
                                subject: c.subject,
                            })
                            .collect(),
                        total: h.total,
                    })
                    .collect(),
            },
            LadderEvent::RungStarted { rung, path } => ArcJoinLedgerEventBody::Phase {
                said: match &path {
                    Some(p) => format!("trying {} on {p}", rung.as_str()),
                    None => format!("trying {}", rung.as_str()),
                },
                phase: "rung".to_string(),
                rung: Some(rung.as_str().to_string()),
                path,
                turn: 0,
            },
            LadderEvent::Rung {
                rung,
                path,
                resolved,
                said,
            } => ArcJoinLedgerEventBody::Rung {
                rung: rung.as_str().to_string(),
                path,
                outcome: outcome(resolved),
                said,
            },
            // `started` is kept, so it is recorded here, on the ladder's
            // thread and in the ladder's order; the merger only streams.
            LadderEvent::ScribeStarted { path } => ArcJoinLedgerEventBody::Scribe {
                path,
                status: "started".to_string(),
                text: None,
                said: None,
                added: None,
                removed: None,
            },
            LadderEvent::ScribeEnded {
                path,
                resolved,
                said,
                added,
                removed,
            } => ArcJoinLedgerEventBody::Scribe {
                path,
                status: outcome(resolved),
                text: None,
                said: Some(said),
                added,
                removed,
            },
            LadderEvent::Candidate {
                sha,
                base_sha,
                files,
            } => ArcJoinLedgerEventBody::Candidate {
                sha,
                base_sha,
                files: files
                    .into_iter()
                    .map(|(path, by)| ArcResolvedFile {
                        path,
                        resolved_by: by.as_str().to_string(),
                        diff: None,
                        added: None,
                        removed: None,
                    })
                    .collect(),
            },
        };
        self.record(body);
    }
}

fn outcome(resolved: bool) -> String {
    if resolved { "resolved" } else { "declined" }.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorder() -> (LedgerRecorder, broadcast::Receiver<Frame>) {
        let (tx, rx) = broadcast::channel(16);
        (LedgerRecorder::new("/p", "demo", tx), rx)
    }

    fn ended() -> ArcJoinLedgerEventBody {
        ArcJoinLedgerEventBody::Ended {
            outcome: "candidate".to_string(),
            detail: None,
        }
    }

    fn streaming(text: &str) -> ArcJoinLedgerEventBody {
        ArcJoinLedgerEventBody::Scribe {
            path: "a".to_string(),
            status: "streaming".to_string(),
            text: Some(text.to_string()),
            said: None,
            added: None,
            removed: None,
        }
    }

    fn body(rx: &mut broadcast::Receiver<Frame>) -> serde_json::Value {
        serde_json::from_slice(&rx.try_recv().expect("a frame went out").payload).unwrap()
    }

    #[test]
    fn record_assigns_increasing_seq_and_stream_does_not_advance_it() {
        let (rec, mut rx) = recorder();
        assert_eq!(rec.record(ended()).seq, 0);
        rec.stream(streaming("x"));
        assert_eq!(rec.record(ended()).seq, 1);
        assert_eq!(rec.events().len(), 2, "the stream beat is not kept");

        let seqs: Vec<u64> = (0..3)
            .map(|_| body(&mut rx)["event"]["seq"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, vec![0, 0, 1], "a beat carries the last kept seq");
    }

    #[test]
    fn the_broadcast_is_the_spec_s02_frame() {
        let (rec, mut rx) = recorder();
        rec.record(ended());
        let frame = body(&mut rx);
        assert_eq!(frame["action"], "changeset_join_resolve_delta");
        assert_eq!(frame["project_dir"], "/p");
        assert_eq!(frame["arc"], "demo");
        assert_eq!(frame["run"], rec.run());
        assert_eq!(frame["event"]["kind"], "ended");
        assert_eq!(frame["event"]["outcome"], "candidate");
        assert!(frame.get("path").is_none() && frame.get("rung").is_none());
    }

    #[test]
    fn the_observer_maps_a_rung_onto_its_wire_spelling() {
        let (rec, mut rx) = recorder();
        rec.ladder(LadderEvent::Rung {
            rung: tugarc_core::ResolvedBy::MergeFile,
            path: Some("a".to_string()),
            resolved: false,
            said: "conflict blocks remain after a three-way merge".to_string(),
        });
        let event = &body(&mut rx)["event"];
        assert_eq!(event["kind"], "rung");
        assert_eq!(event["rung"], "merge-file");
        assert_eq!(event["outcome"], "declined");
    }

    #[test]
    fn a_rung_taken_up_is_a_kept_phase_in_its_own_words() {
        let (rec, mut rx) = recorder();
        rec.ladder(LadderEvent::RungStarted {
            rung: tugarc_core::ResolvedBy::Driver,
            path: Some("a.rs".to_string()),
        });
        rec.ladder(LadderEvent::RungStarted {
            rung: tugarc_core::ResolvedBy::Replay,
            path: None,
        });
        let driver = &body(&mut rx)["event"];
        assert_eq!(driver["kind"], "phase");
        assert_eq!(driver["phase"], "rung");
        assert_eq!(driver["rung"], "driver");
        assert_eq!(driver["path"], "a.rs");
        assert_eq!(driver["said"], "trying driver on a.rs");
        assert!(driver.get("turn").is_none(), "a rung has no turn on the wire");
        let replay = &body(&mut rx)["event"];
        assert_eq!(replay["said"], "trying replay");
        assert!(replay.get("path").is_none());
        assert_eq!(rec.events().len(), 2, "a phase is kept, not streamed");
    }

    #[test]
    fn tugcast_phases_are_kept_in_sequence_with_their_turn() {
        let (rec, mut rx) = recorder();
        rec.phase("workshop", 0, "opening the workshop");
        rec.phase("resolver-turn", 2, "resolver turn 2");
        rec.phase("committing", 0, "committing the candidate");
        rec.phase("anchoring", 0, "anchoring the candidate");
        let frames: Vec<serde_json::Value> = (0..4).map(|_| body(&mut rx)["event"].clone()).collect();
        let phases: Vec<&str> = frames.iter().map(|e| e["phase"].as_str().unwrap()).collect();
        assert_eq!(phases, vec!["workshop", "resolver-turn", "committing", "anchoring"]);
        let seqs: Vec<u64> = frames.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, vec![0, 1, 2, 3]);
        assert_eq!(frames[1]["turn"], 2);
        assert_eq!(frames[1]["said"], "resolver turn 2");
        assert!(frames[0].get("turn").is_none());
        assert!(frames.iter().all(|e| e.get("rung").is_none()));
    }
}
