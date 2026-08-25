//! Resolving the chain of session ids a prompt corpus is read through.
//!
//! A prompt row is keyed by whichever session id was live when the user
//! pressed send, and that id does not survive: Tug forks a session, Claude
//! Code rotates its own on resume, and each rotation leaves the composer
//! asking for its history under an id nothing was ever written against. The
//! symptom is a card that comes back from a relaunch with an empty recall
//! stack, which reads as a broken feature rather than a mis-keyed read.
//!
//! Two things resolve it, and the split matters because the two databases have
//! different lifetimes:
//!
//! - **The live read.** `sessions.db` holds the fork edges and the scanner's
//!   resume ancestors, so it can answer "what has this line of work been
//!   called?" for a fork that happened a second ago. It is per-instance and it
//!   evicts, so it is the fresher source and the more forgetful one.
//! - **The durable record.** Every resolution is written into the corpus's own
//!   `session_lineage` table, which is machine-global and never trims. It
//!   cannot learn anything new on its own, but it does not forget, and it is
//!   what answers once the per-instance ledger has evicted the edge.
//!
//! Every read unions both and re-records the result, so the durable half keeps
//! catching up to the live half for as long as the live half still knows. What
//! never happens is re-keying: a prompt row records the session that actually
//! wrote it, and repairing a read is not grounds for rewriting that.

use std::collections::HashSet;
use std::sync::Arc;

use tracing::{info, warn};

use crate::prompt_ledger::PromptLedger;
use crate::session_ledger::SessionLedger;

/// The per-instance lineage evidence, as the prompt-history routes hold it.
///
/// `None` is a live tugcast whose session ledger did not open — a real state,
/// and one the corpus survives: reads fall back to whatever `session_lineage`
/// already records, which is degraded rather than blank.
#[derive(Clone)]
pub struct LineageSource(Option<Arc<SessionLedger>>);

impl LineageSource {
    pub fn new(sessions: Option<Arc<SessionLedger>>) -> Self {
        Self(sessions)
    }

    fn sessions(&self) -> Option<&SessionLedger> {
        self.0.as_deref()
    }
}

/// Every session id whose prompts belong to `session_id`'s line of work,
/// including `session_id` itself, and record what was resolved.
///
/// The union runs one hop past the live answer on purpose. `resume_lineage_chain`
/// reports the chain the per-instance ledger can still see; each of *those* ids
/// may in turn have a recorded prefix reaching further back, from a boot when
/// the ledger knew more. Expanding through them is what lets a chain reassemble
/// across an eviction that cut it in the middle.
///
/// Total by construction: the answer always contains `session_id`, so a
/// resolution that finds nothing degrades to the pre-lineage behaviour rather
/// than to an empty page. A failed write is logged and ignored — recording is
/// how the next read gets better, never a precondition for this one.
pub fn chain_for(lineage: &LineageSource, ledger: &PromptLedger, session_id: &str) -> Vec<String> {
    let live = match lineage.sessions() {
        Some(sessions) => sessions.resume_lineage_chain(session_id),
        None => Vec::new(),
    };
    if !live.is_empty() {
        match ledger.record_chain(&live, crate::session_ledger::now_millis()) {
            Ok(0) => {}
            Ok(rows) => info!(
                session_id = %session_id,
                rows,
                depth = live.len(),
                "prompt lineage: recorded a resolved chain"
            ),
            Err(err) => warn!(
                session_id = %session_id,
                error = %err,
                "prompt lineage: cannot record the chain; the read still proceeds"
            ),
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut chain: Vec<String> = Vec::new();
    // The trailing id is belt and braces: a live answer always contains it, and
    // an absent session ledger gives no live answer at all.
    let walk = live.iter().cloned().chain(std::iter::once(session_id.to_owned()));
    for id in walk {
        // A member's recorded ancestors are older than the member, so they go
        // in ahead of it and the whole chain stays in age order.
        for ancestor in recorded_prefix(ledger, &id) {
            if seen.insert(ancestor.clone()) {
                chain.push(ancestor);
            }
        }
        if seen.insert(id.clone()) {
            chain.push(id);
        }
    }
    chain
}

/// The chain `id` itself has on record, or nothing when it has never been
/// resolved or the read fails. Its own id is dropped — the caller adds it back
/// in the position the outer walk wants it.
fn recorded_prefix(ledger: &PromptLedger, id: &str) -> Vec<String> {
    match ledger.lineage_of(id) {
        Ok(stored) => stored.into_iter().filter(|stored| stored != id).collect(),
        Err(err) => {
            warn!(
                session_id = %id,
                error = %err,
                "prompt lineage: recorded chain unreadable; using the live answer alone"
            );
            Vec::new()
        }
    }
}

/// Resolve and record a lineage for every session that owns prompts but has
/// none on record. Returns the number of sessions resolved.
///
/// This is the part that runs once and matters most, because it is a race
/// against eviction rather than a repair of anything broken. Today's
/// `sessions.db` still holds the edges for a corpus going back years; a
/// session evicted from it tomorrow takes its ancestry with it, and no later
/// pass can reconstruct what nothing recorded. Copying the evidence into the
/// machine-global corpus while it is still there is the whole point.
///
/// Idempotent and cheap on a second run: a session with a recorded chain is
/// not in the work list at all, and a resolution that finds no ancestors still
/// writes the session's own depth-0 row, so it does not come back either.
pub fn backfill_at_startup(sessions: &SessionLedger, ledger: &PromptLedger) -> usize {
    let pending = match ledger.sessions_missing_lineage() {
        Ok(pending) => pending,
        Err(err) => {
            warn!(error = %err, "prompt lineage: cannot list sessions needing a lineage");
            return 0;
        }
    };
    if pending.is_empty() {
        return 0;
    }
    let now = crate::session_ledger::now_millis();
    let mut resolved = 0;
    let mut with_ancestors = 0;
    for session_id in &pending {
        let chain = sessions.resume_lineage_chain(session_id);
        if chain.len() > 1 {
            with_ancestors += 1;
        }
        match ledger.record_chain(&chain, now) {
            Ok(_) => resolved += 1,
            Err(err) => warn!(
                session_id = %session_id,
                error = %err,
                "prompt lineage: cannot record a backfilled chain"
            ),
        }
    }
    info!(
        resolved,
        with_ancestors,
        pending = pending.len(),
        "prompt lineage: backfill recorded what the session ledger still knows"
    );
    resolved
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt_ledger::NewPromptEntry;

    fn prompt(session: &str, text: &str, entry_id: &str) -> NewPromptEntry {
        NewPromptEntry {
            session_id: session.to_string(),
            route: "claude".to_string(),
            text: text.to_string(),
            atoms_json: "[]".to_string(),
            project_path: "/proj".to_string(),
            submitted_at_ms: 1,
            client_entry_id: entry_id.to_string(),
        }
    }

    fn texts(rows: &[crate::prompt_ledger::PromptRow]) -> Vec<&str> {
        rows.iter().map(|row| row.text.as_str()).collect()
    }

    /// The bug this module exists for: a card relaunches, its session id
    /// rotates, and the prompts written under the old id must still page.
    #[test]
    fn a_rotated_session_reads_its_predecessors_prompts() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        sessions
            .record_spawn("old", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        sessions
            .record_spawn("new", "ws", "/proj", "card-1", 2, Some("juicy-roach"))
            .unwrap();
        sessions.set_fork_provenance("new", "old", None).unwrap();

        let ledger = PromptLedger::open_in_memory().unwrap();
        ledger.append(&prompt("old", "before", "e1")).unwrap();
        ledger.append(&prompt("new", "after", "e2")).unwrap();

        let lineage = LineageSource::new(Some(Arc::new(sessions)));
        let chain = chain_for(&lineage, &ledger, "new");
        assert_eq!(chain, vec!["old".to_string(), "new".to_string()]);

        let (rows, has_more) = ledger.list_page(&chain, None, 50).unwrap();
        assert!(!has_more);
        assert_eq!(texts(&rows), vec!["before", "after"], "oldest first");
    }

    /// Reads must not depend on the session ledger still being able to answer.
    /// Once a chain has been recorded, an evicted `sessions` row leaves the
    /// corpus intact.
    #[test]
    fn a_recorded_chain_outlives_the_evidence_it_came_from() {
        let sessions = Arc::new(SessionLedger::open_in_memory().unwrap());
        sessions
            .record_spawn("old", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        sessions
            .record_spawn("new", "ws", "/proj", "card-1", 2, None)
            .unwrap();
        sessions.set_fork_provenance("new", "old", None).unwrap();

        let ledger = PromptLedger::open_in_memory().unwrap();
        ledger.append(&prompt("old", "before", "e1")).unwrap();

        let lineage = LineageSource::new(Some(Arc::clone(&sessions)));
        assert_eq!(chain_for(&lineage, &ledger, "new").len(), 2);

        // The per-instance ledger forgets; the corpus does not.
        let forgetful = LineageSource::new(None);
        let chain = chain_for(&forgetful, &ledger, "new");
        assert_eq!(chain, vec!["old".to_string(), "new".to_string()]);
        let (rows, _) = ledger.list_page(&chain, None, 50).unwrap();
        assert_eq!(texts(&rows), vec!["before"]);
    }

    /// The redundancy in `record_chain`: a later rotation that can only see one
    /// hop back still reassembles the whole chain, because the hop it can see
    /// carries its own recorded prefix.
    #[test]
    fn a_chain_cut_in_the_middle_reassembles_from_the_surviving_hop() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        ledger.append(&prompt("a", "oldest", "e1")).unwrap();
        ledger
            .record_chain(&["a".to_string(), "b".to_string()], 1)
            .unwrap();

        // A fresh instance knows only b → c; everything older was evicted.
        let sessions = SessionLedger::open_in_memory().unwrap();
        sessions
            .record_spawn("b", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        sessions
            .record_spawn("c", "ws", "/proj", "card-1", 2, None)
            .unwrap();
        sessions.set_fork_provenance("c", "b", None).unwrap();

        let lineage = LineageSource::new(Some(Arc::new(sessions)));
        let chain = chain_for(&lineage, &ledger, "c");
        assert_eq!(
            chain,
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            "b's recorded prefix carried a across the gap"
        );
        let (rows, _) = ledger.list_page(&chain, None, 50).unwrap();
        assert_eq!(texts(&rows), vec!["oldest"]);
    }

    /// The keyset cursor has to stay meaningful across the union — a page
    /// boundary that falls inside an ancestor must not skip or repeat a row.
    #[test]
    fn paging_backward_across_the_union_is_contiguous() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        for (i, session) in ["a", "a", "b", "b", "c"].iter().enumerate() {
            ledger
                .append(&prompt(session, &format!("p{i}"), &format!("e{i}")))
                .unwrap();
        }
        let chain = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        ledger.record_chain(&chain, 1).unwrap();

        let (newest, has_more) = ledger.list_page(&chain, None, 2).unwrap();
        assert!(has_more);
        assert_eq!(texts(&newest), vec!["p3", "p4"]);

        let cursor = newest[0].id;
        let (older, has_more) = ledger.list_page(&chain, Some(cursor), 2).unwrap();
        assert!(has_more);
        assert_eq!(texts(&older), vec!["p1", "p2"], "no gap, no repeat");

        let (oldest, has_more) = ledger.list_page(&chain, Some(older[0].id), 2).unwrap();
        assert!(!has_more);
        assert_eq!(texts(&oldest), vec!["p0"]);
    }

    #[test]
    fn the_backfill_records_what_the_session_ledger_knows_and_then_stops() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        sessions
            .record_spawn("old", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        sessions
            .record_spawn("new", "ws", "/proj", "card-1", 2, None)
            .unwrap();
        sessions.set_fork_provenance("new", "old", None).unwrap();

        let ledger = PromptLedger::open_in_memory().unwrap();
        ledger.append(&prompt("old", "before", "e1")).unwrap();
        ledger.append(&prompt("solo", "unrelated", "e2")).unwrap();

        assert_eq!(backfill_at_startup(&sessions, &ledger), 2);
        assert_eq!(ledger.lineage_of("old").unwrap(), vec!["old".to_string()]);
        assert_eq!(ledger.lineage_of("solo").unwrap(), vec!["solo".to_string()]);
        // An ancestorless session is resolved, not re-resolved every boot.
        assert_eq!(
            backfill_at_startup(&sessions, &ledger),
            0,
            "the depth-0 self row is what ends the work list"
        );
    }

    /// `record_chain` skips the write when a chain is already on record, and
    /// that shortcut must not swallow a chain that has since grown — the common
    /// case, since a line of work gains an id on every relaunch.
    #[test]
    fn a_lengthening_chain_is_recorded_past_the_already_recorded_check() {
        let ledger = PromptLedger::open_in_memory().unwrap();
        let short = vec!["a".to_string(), "b".to_string()];
        assert!(ledger.record_chain(&short, 1).unwrap() > 0);
        assert_eq!(ledger.record_chain(&short, 2).unwrap(), 0, "nothing new");

        let grown = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert!(ledger.record_chain(&grown, 3).unwrap() > 0, "c is new");
        assert_eq!(
            ledger.lineage_of("c").unwrap(),
            vec!["c".to_string(), "b".to_string(), "a".to_string()],
            "nearest first"
        );
        // A later, poorer resolution must not overwrite the fuller one.
        assert_eq!(ledger.record_chain(&["c".to_string()], 4).unwrap(), 0);
        assert_eq!(ledger.lineage_of("c").unwrap().len(), 3);
    }

    /// A session nothing has ever forked reads exactly its own prompts — the
    /// resolution must not widen a page into somebody else's corpus.
    #[test]
    fn an_unforked_session_reads_only_its_own() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        sessions
            .record_spawn("solo", "ws", "/proj", "card-1", 1, None)
            .unwrap();
        sessions
            .record_spawn("stranger", "ws", "/proj", "card-2", 2, None)
            .unwrap();

        let ledger = PromptLedger::open_in_memory().unwrap();
        ledger.append(&prompt("solo", "mine", "e1")).unwrap();
        ledger.append(&prompt("stranger", "theirs", "e2")).unwrap();

        let lineage = LineageSource::new(Some(Arc::new(sessions)));
        let chain = chain_for(&lineage, &ledger, "solo");
        assert_eq!(chain, vec!["solo".to_string()]);
        let (rows, _) = ledger.list_page(&chain, None, 50).unwrap();
        assert_eq!(texts(&rows), vec!["mine"]);
    }
}
