//! One-time assignment of a **line** to every durable-ink row written before
//! lines existed ([P09], Spec S04).
//!
//! The two ink ledgers are separate databases from `sessions.db` and cannot
//! join against it, so each one's own migration lands `line_id` as a
//! placeholder — `''` for a shell exchange, the segment's own id for a refs
//! run — and this pass is the only place that can resolve them. It runs once
//! at boot, guarded by a count of unresolved rows, and does nothing on every
//! later start.
//!
//! This is not adoption. Nothing here chases a row from one id to another:
//! every row already names the segment that wrote it, and all this does is
//! record which line that segment belongs to. Once written it never moves
//! again, which is the whole point of keying ink by line.

use crate::refs_ledger::RefsLedger;
use crate::session_ledger::SessionLedger;
use crate::shell_ledger::ShellLedger;

/// How many rows each ledger's backfill touched.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackfillCounts {
    pub shell: usize,
    pub refs: usize,
}

/// Resolve every unresolved ink row to its line.
///
/// A row whose session the ledger has never heard of takes **its own id** as
/// its line — a line of one. That case is reachable and common: an ink row
/// outlives its `sessions` row, its scan row, and its spelling all at once, and
/// on the live corpus thirty sessions were in exactly that state. The id is the
/// only honest key for them, and it is the same one `resolve_ink_line` falls
/// back to on the read side, so those rows stay findable by exactly the reader
/// that wrote them — and, decisively, findable *apart* from each other. Left on
/// the shared `''` placeholder they would have read back as one conversation's
/// receipts.
pub fn assign_lines(
    sessions: &SessionLedger,
    shell: Option<&ShellLedger>,
    refs: Option<&RefsLedger>,
) -> BackfillCounts {
    let mut counts = BackfillCounts::default();
    let mut line_less = 0usize;
    let mut resolve = |session_id: &str| -> String {
        match sessions.line_of(session_id) {
            Some(line) => line,
            None => {
                line_less += 1;
                session_id.to_owned()
            }
        }
    };

    if let Some(shell) = shell {
        match shell.sessions_awaiting_a_line() {
            Ok(ids) => {
                for session_id in ids {
                    let line = resolve(&session_id);
                    match shell.assign_line(&session_id, &line) {
                        Ok(moved) => counts.shell += moved,
                        Err(err) => {
                            tracing::warn!(session = %session_id, error = %err, "shell ink line assignment failed")
                        }
                    }
                }
            }
            Err(err) => tracing::warn!(error = %err, "shell ink backfill read failed"),
        }
    }

    if let Some(refs) = refs {
        match refs.sessions_awaiting_a_line() {
            Ok(ids) => {
                for session_id in ids {
                    let line = resolve(&session_id);
                    match refs.assign_line(&session_id, &line) {
                        Ok(moved) => counts.refs += moved,
                        Err(err) => {
                            tracing::warn!(session = %session_id, error = %err, "refs ink line assignment failed")
                        }
                    }
                }
            }
            Err(err) => tracing::warn!(error = %err, "refs ink backfill read failed"),
        }
    }

    if counts != BackfillCounts::default() || line_less > 0 {
        tracing::info!(
            shell = counts.shell,
            refs = counts.refs,
            line_less,
            "durable ink assigned to lines"
        );
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs_ledger::NewRefsRun;
    use crate::shell_ledger::NewShellExchange;

    fn exchange(session: &str, line: &str, command: &str) -> NewShellExchange {
        NewShellExchange {
            tug_session_id: session.to_string(),
            line_id: line.to_string(),
            command: command.to_string(),
            output: String::new(),
            exit_code: Some(0),
            cwd: "/proj".to_string(),
            cwd_after: None,
            started_at_ms: 1,
            settled_at_ms: 2,
            anchor_msg_id: None,
        }
    }

    fn run(session: &str, line: &str, settled_at_ms: i64) -> NewRefsRun {
        NewRefsRun {
            tug_session_id: session.to_string(),
            line_id: line.to_string(),
            run_id: format!("run-{session}"),
            op_kind: "search".to_string(),
            command: "rg lines".to_string(),
            refs: Vec::new(),
            settled_at_ms,
            anchor_msg_id: None,
        }
    }

    /// The shape a pre-lines ledger arrives in: rows written under two
    /// segments of what is now one line, with placeholder keys.
    #[test]
    fn the_backfill_gathers_a_lines_ink_under_one_key() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        for id in ["root", "stage"] {
            sessions
                .record_spawn(id, "ws", "/proj", "card-1", 1, "line-1", None)
                .unwrap();
        }
        let shell = ShellLedger::open_in_memory().unwrap();
        // The placeholder a pre-lines row carries.
        shell.record_exchange(&exchange("root", "", "ls")).unwrap();
        shell
            .record_exchange(&exchange("stage", "", "just build"))
            .unwrap();

        let refs = RefsLedger::open_in_memory().unwrap();
        refs.record_run(&run("root", "root", 10)).unwrap();
        refs.record_run(&run("stage", "stage", 20)).unwrap();

        let counts = assign_lines(&sessions, Some(&shell), Some(&refs));
        assert_eq!(counts.shell, 2);
        assert_eq!(counts.refs, 2);

        // Both segments' receipts read back as the line's, in one stream.
        let rows = shell.list_exchanges_since("line-1", None).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].command, "ls");
        assert_eq!(rows[1].command, "just build");
        // And the anchor survives: which segment wrote each row is still a fact.
        assert_eq!(rows[0].tug_session_id, "root");
        assert_eq!(rows[1].tug_session_id, "stage");

        // One run per line, and the newest wins — `/ref N` means something
        // definite only because there is exactly one to number against.
        let run = refs.list_refs("line-1").unwrap().expect("the line's run");
        assert_eq!(run.run_id, "run-stage");

        // Idempotent: a second boot finds nothing left to resolve.
        assert_eq!(
            assign_lines(&sessions, Some(&shell), Some(&refs)),
            BackfillCounts::default()
        );
    }

    #[test]
    fn a_row_whose_session_the_ledger_never_saw_becomes_a_line_of_one() {
        let sessions = SessionLedger::open_in_memory().unwrap();
        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&exchange("evicted", "", "ls"))
            .unwrap();
        shell
            .record_exchange(&exchange("also-evicted", "", "pwd"))
            .unwrap();

        assert_eq!(assign_lines(&sessions, Some(&shell), None).shell, 2);
        // Each keeps its own id as its line. Left on the shared placeholder
        // they would read back as one conversation's receipts, which is the
        // failure this fallback exists to prevent.
        assert_eq!(
            shell.list_exchanges_since("evicted", None).unwrap().len(),
            1
        );
        assert_eq!(
            shell
                .list_exchanges_since("also-evicted", None)
                .unwrap()
                .len(),
            1
        );
        assert!(shell.list_exchanges_since("", None).unwrap().is_empty());
    }
}
