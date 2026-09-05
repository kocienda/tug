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
//!
//! The second pass here, [`reanchor_rotated_lines`], repairs the **anchor**
//! of rows written under a rotated card. Until 2026-09-04 every ink gateway
//! read the anchor off the transcript of the id it was handed — the card's
//! own, which the Wheel leaves pointing at a line's *first* segment — so every
//! row written after a card's first rotation carried the door's last turn as
//! its anchor and restored seated there, above every later stage. The
//! gateways read the live head now; this pass gives the rows already on disk
//! the anchor they would have carried, and runs once.

use crate::refs_ledger::RefsLedger;
use crate::session_ledger::{LineSegment, SessionLedger};
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

/// The name the re-anchoring pass is marked done under, in each ink ledger.
const REANCHOR_PASS: &str = "reanchor-rotated-lines-2026-09-04";

/// How many anchors the repair rewrote in each ledger.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReanchorCounts {
    pub shell: usize,
    pub refs: usize,
}

/// Re-anchor every ink row a rotated card wrote under a retired segment's id.
///
/// A row is affected when its line has more than one segment and the segment
/// that was **seated when the row was written** — the newest one recorded
/// before the row's own timestamp — is not the segment the row names. Such a
/// row's anchor was read off the wrong file. The repair reads the seated
/// segment's transcript and takes the newest assistant message stamped at or
/// before the row's moment, which is exactly the anchor a correct gateway
/// would have written then. A row written under the seated segment's own id
/// was anchored correctly and is not read at all, which is what keeps this
/// pass to the affected rows rather than to every transcript on disk.
///
/// An anchor that cannot be recomputed — a transcript gone, a segment with
/// no assistant line before that moment — is left as it was: a stale seat is
/// still a seat, and [L23] says placement degrades, never the row.
///
/// Runs once per ledger, marked in the ledger it repaired, because the read
/// is over transcripts rather than rows and a boot should not pay for it
/// twice. Idempotent within a run: a second call finds every affected anchor
/// already equal to what it would write.
pub fn reanchor_rotated_lines(
    sessions: &SessionLedger,
    shell: Option<&ShellLedger>,
    refs: Option<&RefsLedger>,
    now_ms: i64,
) -> ReanchorCounts {
    let mut counts = ReanchorCounts::default();
    let mut segments_by_line: std::collections::HashMap<String, Vec<LineSegment>> =
        std::collections::HashMap::new();
    let mut segments_of = |line_id: &str| -> Vec<LineSegment> {
        segments_by_line
            .entry(line_id.to_owned())
            .or_insert_with(|| {
                sessions.segments_of_line(line_id).unwrap_or_else(|err| {
                    tracing::warn!(line = %line_id, error = %err, "reanchor: segments read failed");
                    Vec::new()
                })
            })
            .clone()
    };

    if let Some(shell) = shell {
        match shell.backfill_done(REANCHOR_PASS) {
            Ok(true) => {}
            Ok(false) => match shell.anchored_rows() {
                Ok(rows) => {
                    for row in rows {
                        let segments = segments_of(&row.line_id);
                        let Some(anchor) = corrected_anchor(
                            sessions,
                            &segments,
                            &row.tug_session_id,
                            row.at_ms,
                            &row.anchor_msg_id,
                        ) else {
                            continue;
                        };
                        match shell.set_anchor(row.id, &anchor) {
                            Ok(moved) => counts.shell += moved,
                            Err(err) => tracing::warn!(
                                id = row.id,
                                error = %err,
                                "reanchor: shell anchor write failed"
                            ),
                        }
                    }
                    if let Err(err) = shell.mark_backfill(REANCHOR_PASS, now_ms) {
                        tracing::warn!(error = %err, "reanchor: shell pass mark failed");
                    }
                }
                Err(err) => tracing::warn!(error = %err, "reanchor: shell rows read failed"),
            },
            Err(err) => tracing::warn!(error = %err, "reanchor: shell pass mark read failed"),
        }
    }

    if let Some(refs) = refs {
        match refs.backfill_done(REANCHOR_PASS) {
            Ok(true) => {}
            Ok(false) => match refs.anchored_runs() {
                Ok(runs) => {
                    for run in runs {
                        let segments = segments_of(&run.line_id);
                        let Some(anchor) = corrected_anchor(
                            sessions,
                            &segments,
                            &run.tug_session_id,
                            run.at_ms,
                            &run.anchor_msg_id,
                        ) else {
                            continue;
                        };
                        match refs.set_anchor(&run.line_id, &anchor) {
                            Ok(moved) => counts.refs += moved,
                            Err(err) => tracing::warn!(
                                line = %run.line_id,
                                error = %err,
                                "reanchor: refs anchor write failed"
                            ),
                        }
                    }
                    if let Err(err) = refs.mark_backfill(REANCHOR_PASS, now_ms) {
                        tracing::warn!(error = %err, "reanchor: refs pass mark failed");
                    }
                }
                Err(err) => tracing::warn!(error = %err, "reanchor: refs runs read failed"),
            },
            Err(err) => tracing::warn!(error = %err, "reanchor: refs pass mark read failed"),
        }
    }

    if counts != ReanchorCounts::default() {
        tracing::info!(
            shell = counts.shell,
            refs = counts.refs,
            "durable ink re-anchored to the segment seated when it was written"
        );
    }
    counts
}

/// The anchor a row written at `at_ms` under `writer` should carry, when the
/// one it carries is not it. `None` when the row is not affected — its line
/// has one segment, or the writer *was* the seated segment — or when the
/// right anchor cannot be recomputed.
fn corrected_anchor(
    sessions: &SessionLedger,
    segments: &[LineSegment],
    writer: &str,
    at_ms: i64,
    stored: &str,
) -> Option<String> {
    if segments.len() < 2 {
        return None;
    }
    // The segment seated at the row's moment: the newest recorded at or
    // before it. A row older than every segment — a clock the ledger never
    // saw — belongs to the first.
    let seated = segments
        .iter()
        .rev()
        .find(|segment| segment.created_at <= at_ms)
        .unwrap_or(&segments[0]);
    if seated.session_id == writer {
        return None;
    }
    let anchor = sessions.assistant_msg_id_at(&seated.session_id, &seated.project_dir, at_ms)?;
    if anchor == stored {
        return None;
    }
    Some(anchor)
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

    /// A rotated line on disk: the door at 1s, the head seated at 5s, each
    /// with its own transcript, stamped so the repair can read "as of".
    fn rotated_line_with_transcripts() -> (SessionLedger, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions = SessionLedger::open_in_memory_with_root(&dir.path().join("projects"))
            .expect("sessions ledger");
        let (project, _) =
            crate::session_ledger::claude_project_dir(sessions.claude_projects_root(), "/proj");
        std::fs::create_dir_all(&project).expect("project dir");
        let assistant = |id: &str, stamp: &str| {
            format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{stamp}\",\"message\":{{\"id\":\"{id}\"}}}}\n"
            )
        };
        sessions
            .record_spawn("door", "ws", "/proj", "card-1", 1_000, "line-1", None)
            .expect("spawn the door");
        std::fs::write(
            project.join("door.jsonl"),
            assistant("msg_DOOR", "1970-01-01T00:00:01.500Z"),
        )
        .expect("door jsonl");
        sessions.demote_live_to_closed().expect("rotate");
        sessions
            .record_spawn("head", "ws", "/proj", "card-1", 5_000, "line-1", None)
            .expect("spawn the head");
        std::fs::write(
            project.join("head.jsonl"),
            format!(
                "{}{}{}",
                assistant("msg_HEAD_EARLY", "1970-01-01T00:00:06.000Z"),
                // A sidechain line replay drops: never an anchor.
                "{\"type\":\"assistant\",\"isSidechain\":true,\"timestamp\":\"1970-01-01T00:00:06.500Z\",\"message\":{\"id\":\"msg_SIDE\"}}\n",
                assistant("msg_HEAD_LATE", "1970-01-01T00:00:09.000Z"),
            ),
        )
        .expect("head jsonl");
        (sessions, dir)
    }

    fn anchored(session: &str, at_ms: i64, anchor: &str, command: &str) -> NewShellExchange {
        NewShellExchange {
            anchor_msg_id: Some(anchor.to_string()),
            started_at_ms: at_ms,
            settled_at_ms: at_ms,
            ..exchange(session, "line-1", command)
        }
    }

    #[test]
    fn the_repair_reanchors_rows_a_rotated_card_wrote_under_its_door() {
        let (sessions, _dir) = rotated_line_with_transcripts();
        let shell = ShellLedger::open_in_memory().unwrap();
        // Written before the rotation, under the door: correct as it stands.
        shell
            .record_exchange(&anchored("door", 2_000, "msg_DOOR", "ls"))
            .unwrap();
        // Written after the rotation, still under the door's id — the shape
        // every `tugtool arc` note and every join receipt had — carrying the
        // door's last word as its anchor.
        shell
            .record_exchange(&anchored("door", 7_000, "msg_DOOR", "arc commit x"))
            .unwrap();
        shell
            .record_exchange(&anchored("door", 10_000, "msg_DOOR", "/arc-join"))
            .unwrap();
        // Written under the head's own id: anchored right at the time.
        shell
            .record_exchange(&anchored("head", 9_500, "msg_HEAD_EARLY", "pwd"))
            .unwrap();

        let refs = RefsLedger::open_in_memory().unwrap();
        refs.record_run(&NewRefsRun {
            anchor_msg_id: Some("msg_DOOR".to_string()),
            ..run("door", "line-1", 8_000)
        })
        .unwrap();

        let counts = reanchor_rotated_lines(&sessions, Some(&shell), Some(&refs), 99_000);
        assert_eq!(counts, ReanchorCounts { shell: 2, refs: 1 });

        let rows = shell.list_exchanges_since("line-1", None).unwrap();
        let anchor_of = |command: &str| -> String {
            rows.iter()
                .find(|r| r.command == command)
                .and_then(|r| r.anchor_msg_id.clone())
                .expect(command)
        };
        // Before the rotation the door was the seat; nothing to correct.
        assert_eq!(anchor_of("ls"), "msg_DOOR");
        // At 7s the head was seated and its newest turn by then was the early
        // one — not the late one that came afterwards, and not the sidechain.
        assert_eq!(anchor_of("arc commit x"), "msg_HEAD_EARLY");
        // At 10s the late turn had been said.
        assert_eq!(anchor_of("/arc-join"), "msg_HEAD_LATE");
        // A row the head wrote itself is not touched.
        assert_eq!(anchor_of("pwd"), "msg_HEAD_EARLY");
        assert_eq!(
            refs.list_refs("line-1")
                .unwrap()
                .expect("the run")
                .anchor_msg_id
                .as_deref(),
            Some("msg_HEAD_EARLY"),
        );

        // Marked done: a second boot reads no transcript and rewrites nothing.
        assert_eq!(
            reanchor_rotated_lines(&sessions, Some(&shell), Some(&refs), 99_001),
            ReanchorCounts::default()
        );
    }

    #[test]
    fn the_repair_leaves_a_row_alone_when_the_seated_transcript_cannot_answer() {
        let (sessions, dir) = rotated_line_with_transcripts();
        let (project, _) =
            crate::session_ledger::claude_project_dir(sessions.claude_projects_root(), "/proj");
        std::fs::remove_file(project.join("head.jsonl")).expect("lose the head's file");
        let shell = ShellLedger::open_in_memory().unwrap();
        shell
            .record_exchange(&anchored("door", 7_000, "msg_DOOR", "/arc-join"))
            .unwrap();

        assert_eq!(
            reanchor_rotated_lines(&sessions, Some(&shell), None, 99_000),
            ReanchorCounts::default()
        );
        // A stale seat is still a seat ([L23]): the anchor stands rather than
        // being blanked.
        let rows = shell.list_exchanges_since("line-1", None).unwrap();
        assert_eq!(rows[0].anchor_msg_id.as_deref(), Some("msg_DOOR"));
        drop(dir);
    }
}
