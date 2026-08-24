//! Adopting durable ink that ended up under the wrong session id.
//!
//! A rewind-fork supersedes the session it forked from and the fork carries
//! the callsign on ([D154]); the ink transfer that rides along with it lives
//! in the fork arc. This module is the recovery half — what runs at ledger
//! open, for the rows that transfer never reached:
//!
//! - **The edge sweep** re-derives every ink session id's lineage head from
//!   the `forked_from_session_id` edges and re-keys anything sitting under a
//!   superseded id. The two ink databases are separate sqlite files with no
//!   shared transaction, so the fork-time transfer is best-effort by
//!   construction; this is what makes it eventually true.
//! - **The pre-provenance backfill** repairs the forks that happened before
//!   the provenance columns existed. Those edges are gone, but a fork's JSONL
//!   is a file copy that retains every ancestor turn's original `sessionId`,
//!   so a session whose own transcript *contains* an orphan's id is the line
//!   that continued it. It runs at most once per machine: a completion
//!   watermark in tugbank ends it, because an orphan no transcript claims
//!   would otherwise keep every boot re-reading hundreds of megabytes.
//!
//! Both are idempotent, and both re-key through the same
//! `ShellLedger::rekey_session` / `RefsLedger::rekey_session` the fork arc
//! uses.

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::Path;

use tracing::{info, warn};

use crate::refs_ledger::RefsLedger;
use crate::session_ledger::{SessionLedger, SessionRow, SessionState};
use crate::shell_ledger::ShellLedger;

/// The tugbank domain and key the backfill records its completion under. The
/// version segment is what lets a later phase deliberately re-run the pass.
const WATERMARK_DOMAIN: &str = "ink";
const WATERMARK_KEY: &str = "pre_provenance_backfill_v1";

/// The durable ink ledgers as the sweeps need them: borrowed, and either
/// present or not. A `None` ledger is a clean no-op rather than a branch at
/// every call site.
#[derive(Clone, Copy)]
pub struct InkStores<'a> {
    pub shell: Option<&'a ShellLedger>,
    pub refs: Option<&'a RefsLedger>,
}

impl InkStores<'_> {
    /// Every session id that currently owns at least one ink row, across both
    /// ledgers. A ledger that cannot be read contributes nothing and warns —
    /// adoption is repair work, and failing to repair must not fail a boot.
    fn session_ids_with_rows(&self) -> HashSet<String> {
        let mut ids = HashSet::new();
        if let Some(shell) = self.shell {
            match shell.session_ids_with_rows() {
                Ok(found) => ids.extend(found),
                Err(err) => warn!(error = %err, "ink adoption: cannot read shell ledger sessions"),
            }
        }
        if let Some(refs) = self.refs {
            match refs.session_ids_with_rows() {
                Ok(found) => ids.extend(found),
                Err(err) => warn!(error = %err, "ink adoption: cannot read refs ledger sessions"),
            }
        }
        ids
    }

    /// Move every ink row from `from` onto `to`. Returns `(shell, refs)` row
    /// counts; a failure on one ledger never stops the other, because they are
    /// independent databases.
    fn rekey(&self, from: &str, to: &str) -> (usize, usize) {
        let shell = self
            .shell
            .map(|ledger| match ledger.rekey_session(from, to) {
                Ok(moved) => moved,
                Err(err) => {
                    warn!(from, to, error = %err, "ink adoption: shell re-key failed");
                    0
                }
            })
            .unwrap_or(0);
        let refs = self
            .refs
            .map(|ledger| match ledger.rekey_session(from, to) {
                Ok(moved) => moved,
                Err(err) => {
                    warn!(from, to, error = %err, "ink adoption: refs re-key failed");
                    0
                }
            })
            .unwrap_or(0);
        (shell, refs)
    }
}

/// Re-key every ink row sitting under a superseded session id onto its
/// lineage head. Returns the number of session ids adopted.
///
/// Runs synchronously at open, **before** `ShellLedger::reconcile_orphaned_rows`
/// and before the supervisor serves any restore read. The order is
/// load-bearing: that reconciler adopts a lost session's rows onto whichever
/// session its *card* currently holds, a heuristic that predates provenance
/// and cannot tell a fork from a coincidence. A provenance edge is direct
/// evidence, so it decides first; afterwards the rows sit on a head with
/// turns, and the card-shaped pass correctly declines to move them again.
pub fn adopt_by_lineage(sessions: &SessionLedger, ink: InkStores<'_>) -> usize {
    let ids = ink.session_ids_with_rows();
    if ids.is_empty() {
        return 0;
    }
    let mut adopted = 0;
    for id in ids {
        let head = sessions.resolve_to_lineage_head(&id);
        if head == id {
            continue;
        }
        let (shell, refs) = ink.rekey(&id, &head);
        if shell > 0 || refs > 0 {
            info!(
                from = %id,
                to = %head,
                shell,
                refs,
                "ink adoption: stranded rows moved to the lineage head"
            );
            adopted += 1;
        }
    }
    if adopted > 0 {
        info!(adopted, "ink adoption: edge sweep repaired stranded ink");
    }
    adopted
}

/// Adopt ink orphaned by a fork that predates the provenance columns, using
/// each candidate transcript's own contents as the evidence.
///
/// A **candidate** is a session id that owns ink, whose `sessions` row is
/// closed or absent, and which no fork edge already resolves away — a line
/// nothing claims. An **adopter** is any other session whose JSONL contains
/// the candidate's id as a turn `sessionId`, which only happens when the
/// adopter's transcript is a copy of the candidate's. Tag-wearers are tried
/// first, mirroring [D154]'s own tie-break: among siblings, the branch that
/// inherited the callsign is the line of work.
///
/// Provenance is never fabricated — only rows move.
///
/// The pass writes a completion watermark to `bank` and returns without doing
/// any file I/O on a later boot. `bank` absent means it runs each boot, which
/// is degraded but no worse than not having the pass at all.
pub fn adopt_pre_provenance_orphans(
    sessions: &SessionLedger,
    ink: InkStores<'_>,
    bank: Option<&tugbank_core::TugbankClient>,
) -> usize {
    if backfill_already_ran(bank) {
        return 0;
    }
    let rows = match sessions.list_all_sessions() {
        Ok(rows) => rows,
        Err(err) => {
            warn!(error = %err, "ink adoption: cannot list sessions for the backfill");
            return 0;
        }
    };
    let adopted = run_backfill(sessions, &rows, ink);
    record_backfill_ran(bank);
    adopted
}

fn backfill_already_ran(bank: Option<&tugbank_core::TugbankClient>) -> bool {
    let Some(bank) = bank else {
        return false;
    };
    match bank.get(WATERMARK_DOMAIN, WATERMARK_KEY) {
        Ok(Some(tugbank_core::Value::Bool(done))) => done,
        Ok(_) => false,
        Err(err) => {
            warn!(error = %err, "ink adoption: cannot read the backfill watermark; running the pass");
            false
        }
    }
}

fn record_backfill_ran(bank: Option<&tugbank_core::TugbankClient>) {
    let Some(bank) = bank else {
        return;
    };
    if let Err(err) = bank.set(
        WATERMARK_DOMAIN,
        WATERMARK_KEY,
        tugbank_core::Value::Bool(true),
    ) {
        warn!(error = %err, "ink adoption: cannot write the backfill watermark; the pass will re-run");
    }
}

fn run_backfill(sessions: &SessionLedger, rows: &[SessionRow], ink: InkStores<'_>) -> usize {
    let with_rows = ink.session_ids_with_rows();
    if with_rows.is_empty() {
        return 0;
    }
    let live: HashSet<&str> = rows
        .iter()
        .filter(|row| row.state == SessionState::Live)
        .map(|row| row.session_id.as_str())
        .collect();

    // A candidate is unclaimed twice over: nothing living answers to its id,
    // and no fork edge resolves it anywhere else.
    let mut candidates: HashSet<String> = with_rows
        .iter()
        .filter(|id| !live.contains(id.as_str()))
        .filter(|id| sessions.resolve_to_lineage_head(id) == **id)
        .cloned()
        .collect();
    if candidates.is_empty() {
        return 0;
    }

    // Tag-wearers first, then most recently used. A candidate never adopts.
    let mut adopters: Vec<&SessionRow> = rows
        .iter()
        .filter(|row| !candidates.contains(&row.session_id))
        .collect();
    adopters.sort_by(|a, b| {
        a.tag
            .is_none()
            .cmp(&b.tag.is_none())
            .then(b.last_used_at.cmp(&a.last_used_at))
    });

    let root = sessions.claude_projects_root().to_path_buf();
    let mut adopted = 0;
    for adopter in adopters {
        if candidates.is_empty() {
            break;
        }
        let (dir, _canonical) =
            crate::session_ledger::claude_project_dir(&root, &adopter.project_dir);
        let path = dir.join(format!("{}.jsonl", adopter.session_id));
        let found = contained_session_ids(&path, &candidates);
        for candidate in found {
            let (shell, refs) = ink.rekey(&candidate, &adopter.session_id);
            candidates.remove(&candidate);
            if shell > 0 || refs > 0 {
                info!(
                    from = %candidate,
                    to = %adopter.session_id,
                    shell,
                    refs,
                    "ink adoption: pre-provenance orphan adopted on transcript evidence"
                );
                adopted += 1;
            }
        }
    }
    info!(
        adopted,
        unclaimed = candidates.len(),
        "ink adoption: pre-provenance backfill complete"
    );
    adopted
}

/// Which of `candidates` appear as a turn `sessionId` anywhere in the JSONL at
/// `path`.
///
/// Streamed line by line and matched as a substring: these files run to
/// hundreds of megabytes, so neither the file nor a parsed JSON DOM is ever
/// held in memory. A missing or unreadable file simply names nobody.
fn contained_session_ids(path: &Path, candidates: &HashSet<String>) -> Vec<String> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let needles: Vec<(String, String)> = candidates
        .iter()
        .map(|id| (id.clone(), format!("\"sessionId\":\"{id}\"")))
        .collect();
    let mut found: HashSet<String> = HashSet::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        for (id, needle) in &needles {
            if !found.contains(id) && line.contains(needle.as_str()) {
                found.insert(id.clone());
            }
        }
        if found.len() == needles.len() {
            break;
        }
    }
    found.into_iter().collect()
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_ledger::NewShellExchange;

    fn shell_row(session: &str, command: &str) -> NewShellExchange {
        NewShellExchange {
            tug_session_id: session.to_string(),
            command: command.to_string(),
            output: "out\n".to_string(),
            exit_code: Some(0),
            cwd: "/proj".to_string(),
            cwd_after: None,
            started_at_ms: 1,
            settled_at_ms: 2,
        }
    }

    fn refs_row(session: &str, run_id: &str) -> crate::refs_ledger::NewRefsRun {
        crate::refs_ledger::NewRefsRun {
            tug_session_id: session.to_string(),
            run_id: run_id.to_string(),
            op_kind: "match".to_string(),
            command: "/match foo".to_string(),
            refs: Vec::new(),
            settled_at_ms: 10,
        }
    }

    // ── the edge sweep ───────────────────────────────────────────────────────

    #[test]
    fn stranded_rows_move_to_the_head_and_stay_there() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        sessions
            .record_spawn("parent", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        sessions
            .record_spawn("fork", "ws", "/proj", "card-1", 2, Some("stocky-pixie"))
            .unwrap();
        sessions
            .set_fork_provenance("fork", "parent", "point")
            .unwrap();

        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&shell_row("parent", "/commit"))
            .unwrap();
        let refs = RefsLedger::open_in_memory().unwrap();
        refs.record_run(&refs_row("parent", "run-1")).unwrap();
        let ink = InkStores {
            shell: Some(&shell),
            refs: Some(&refs),
        };

        assert_eq!(adopt_by_lineage(&sessions, ink), 1);
        assert_eq!(shell.list_exchanges_since("fork", None).unwrap().len(), 1);
        assert_eq!(refs.list_refs("fork").unwrap().unwrap().run_id, "run-1");
        // Idempotent: nothing is left stranded, so a second boot is read-only.
        assert_eq!(adopt_by_lineage(&sessions, ink), 0);
    }

    #[test]
    fn rows_already_on_a_head_are_left_alone() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        sessions
            .record_spawn("solo", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        let shell = ShellLedger::open_in_memory().unwrap();
        shell.record_exchange(&shell_row("solo", "ls")).unwrap();

        let ink = InkStores {
            shell: Some(&shell),
            refs: None,
        };
        assert_eq!(adopt_by_lineage(&sessions, ink), 0);
        assert_eq!(shell.list_exchanges_since("solo", None).unwrap().len(), 1);
    }

    #[test]
    fn an_absent_ink_ledger_is_a_clean_no_op() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        let ink = InkStores {
            shell: None,
            refs: None,
        };
        assert_eq!(adopt_by_lineage(&sessions, ink), 0);
    }

    /// The lineage sweep must decide before `reconcile_orphaned_rows`, which
    /// would otherwise pull the same rows onto whichever session the card
    /// currently holds. This fixture satisfies both — provenance says `fork`,
    /// the card heuristic says `stranger` — and the rows must land on `fork`.
    #[test]
    fn provenance_outranks_the_card_heuristic() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        sessions
            .record_spawn("parent", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        sessions
            .record_spawn("fork", "ws", "/proj", "card-2", 2, Some("stocky-pixie"))
            .unwrap();
        // `stranger` is the card's newest session and is empty — exactly what
        // the pre-F1 reconciler adopts onto.
        sessions
            .record_spawn("stranger", "ws", "/proj", "card-1", 3, None)
            .unwrap();
        sessions
            .set_fork_provenance("fork", "parent", "point")
            .unwrap();

        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&shell_row("parent", "/commit"))
            .unwrap();

        adopt_by_lineage(
            &sessions,
            InkStores {
                shell: Some(&shell),
                refs: None,
            },
        );
        // Then the card-shaped pass, in the order `main.rs` runs them.
        let for_reconcile: Vec<crate::shell_ledger::SessionForReconcile> = sessions
            .list_with_card_id()
            .unwrap()
            .into_iter()
            .filter_map(|row| {
                row.card_id
                    .map(|card_id| crate::shell_ledger::SessionForReconcile {
                        session_id: row.session_id,
                        card_id,
                        turn_count: row.turn_count,
                    })
            })
            .collect();
        shell.reconcile_orphaned_rows(&for_reconcile).unwrap();

        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            HashSet::from(["fork".to_string()]),
            "direct evidence decided, and the heuristic found nothing left to move"
        );
    }

    // ── the pre-provenance backfill ──────────────────────────────────────────

    /// A ledger whose Claude transcripts live in `dir`, plus a bank for the
    /// watermark. `write_jsonl` puts a transcript on disk for a session.
    struct Fixture {
        sessions: SessionLedger,
        bank: tugbank_core::TugbankClient,
        _dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let sessions = SessionLedger::open_with_claude_root(
                dir.path().join("sessions.db"),
                dir.path().join("projects"),
            )
            .unwrap();
            let bank = tugbank_core::TugbankClient::open(dir.path().join("bank.db")).expect("bank");
            Self {
                sessions,
                bank,
                _dir: dir,
            }
        }

        /// Write `<root>/<encoded project>/<session>.jsonl` containing one
        /// turn per named ancestor — the shape a fork's file copy has.
        fn write_jsonl(&self, session: &str, project_dir: &str, ancestor_ids: &[&str]) {
            let (dir, _) = crate::session_ledger::claude_project_dir(
                self.sessions.claude_projects_root(),
                project_dir,
            );
            std::fs::create_dir_all(&dir).expect("create project dir");
            let body: String = ancestor_ids
                .iter()
                .map(|id| format!("{{\"type\":\"user\",\"sessionId\":\"{id}\"}}\n"))
                .collect();
            std::fs::write(dir.join(format!("{session}.jsonl")), body).expect("write jsonl");
        }
    }

    #[test]
    fn an_orphan_is_adopted_by_the_transcript_that_contains_it() {
        let fx = Fixture::new();
        // The orphan: closed, tagless, no edge, but owning ink.
        fx.sessions
            .record_spawn("orphan", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        fx.sessions.mark_closed("orphan").unwrap();
        fx.sessions
            .record_spawn("head", "ws", "/proj", "card-1", 2, Some("stocky-pixie"))
            .unwrap();
        fx.write_jsonl("head", "/proj", &["orphan", "head"]);

        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&shell_row("orphan", "/commit"))
            .unwrap();
        let ink = InkStores {
            shell: Some(&shell),
            refs: None,
        };

        assert_eq!(
            adopt_pre_provenance_orphans(&fx.sessions, ink, Some(&fx.bank)),
            1
        );
        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            HashSet::from(["head".to_string()])
        );
    }

    #[test]
    fn the_watermark_stops_a_second_pass_from_reading_anything() {
        let fx = Fixture::new();
        fx.sessions
            .record_spawn("orphan", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        fx.sessions.mark_closed("orphan").unwrap();
        fx.sessions
            .record_spawn("head", "ws", "/proj", "card-1", 2, Some("stocky-pixie"))
            .unwrap();
        fx.write_jsonl("head", "/proj", &["orphan"]);

        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&shell_row("orphan", "/commit"))
            .unwrap();
        let ink = InkStores {
            shell: Some(&shell),
            refs: None,
        };
        adopt_pre_provenance_orphans(&fx.sessions, ink, Some(&fx.bank));

        // Re-strand the rows and re-run: the pass is over, so nothing moves.
        shell.rekey_session("head", "orphan").unwrap();
        assert_eq!(
            adopt_pre_provenance_orphans(&fx.sessions, ink, Some(&fx.bank)),
            0,
            "the watermark ended the pass"
        );
        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            HashSet::from(["orphan".to_string()])
        );
    }

    #[test]
    fn a_live_session_is_never_adopted_from() {
        let fx = Fixture::new();
        // `alive` owns ink and is still live — its receipts are its own, even
        // though `head`'s transcript names it.
        fx.sessions
            .record_spawn("alive", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        fx.sessions
            .record_spawn("head", "ws", "/proj", "card-2", 2, Some("stocky-pixie"))
            .unwrap();
        fx.write_jsonl("head", "/proj", &["alive"]);

        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&shell_row("alive", "/commit"))
            .unwrap();
        let ink = InkStores {
            shell: Some(&shell),
            refs: None,
        };

        assert_eq!(
            adopt_pre_provenance_orphans(&fx.sessions, ink, Some(&fx.bank)),
            0
        );
        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            HashSet::from(["alive".to_string()])
        );
    }

    #[test]
    fn an_orphan_no_transcript_names_stays_put() {
        let fx = Fixture::new();
        fx.sessions
            .record_spawn("orphan", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        fx.sessions.mark_closed("orphan").unwrap();
        fx.sessions
            .record_spawn("head", "ws", "/proj", "card-1", 2, Some("stocky-pixie"))
            .unwrap();
        fx.write_jsonl("head", "/proj", &["head"]);

        let shell = ShellLedger::open_in_memory().unwrap();
        shell.record_exchange(&shell_row("orphan", "ls")).unwrap();
        let ink = InkStores {
            shell: Some(&shell),
            refs: None,
        };

        assert_eq!(
            adopt_pre_provenance_orphans(&fx.sessions, ink, Some(&fx.bank)),
            0
        );
        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            HashSet::from(["orphan".to_string()])
        );
    }

    #[test]
    fn the_tagged_adopter_wins_when_two_transcripts_name_the_orphan() {
        let fx = Fixture::new();
        fx.sessions
            .record_spawn("orphan", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        fx.sessions.mark_closed("orphan").unwrap();
        // The sibling is newer, so only the tag can decide.
        fx.sessions
            .record_spawn("tagged", "ws", "/proj", "card-1", 2, Some("stocky-pixie"))
            .unwrap();
        fx.sessions
            .record_spawn("sibling", "ws", "/proj", "card-2", 9, None)
            .unwrap();
        fx.write_jsonl("tagged", "/proj", &["orphan"]);
        fx.write_jsonl("sibling", "/proj", &["orphan"]);

        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&shell_row("orphan", "/commit"))
            .unwrap();
        let ink = InkStores {
            shell: Some(&shell),
            refs: None,
        };

        adopt_pre_provenance_orphans(&fx.sessions, ink, Some(&fx.bank));
        assert_eq!(
            shell.session_ids_with_rows().unwrap(),
            HashSet::from(["tagged".to_string()]),
            "the line that inherited the callsign is the line of work"
        );
    }
}
