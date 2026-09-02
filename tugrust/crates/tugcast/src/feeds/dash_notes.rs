//! The run's quiet lines — **a derived view of the dash-log**, painted on the
//! card bound to the dash (W8 Task 3).
//!
//! The user watches a run from the card, and before this the only sign of one
//! moving was a stuck indicator. Every manipulation of a dash's step list now
//! draws one line there: a dash created, a run declared, a step started,
//! closed, withdrawn, parked or reopened, a `mark`, and each round.
//!
//! # Why the observer and not the verb
//!
//! The first cut had each `tugtool dash` verb post its own announcement. That
//! is the wrong binding twice over, and the second reason is the load-bearing
//! one:
//!
//! - **A post is a second fallible write** — the exact shape W2 spent a
//!   workstream closing. A verb whose row moved and whose announcement did not
//!   is a gesture that happened and was never seen, and nothing anywhere would
//!   know. Part II's second sentence: *verbs succeed while achieving nothing.*
//! - **A post is an act a caller performs, so a caller can omit it.** Every
//!   new call site, every second implementation, every hand-run verb is another
//!   chance for the announcement to be forgotten — and a forgotten announcement
//!   is precisely this incident's shape.
//!
//! Deriving it from the record inverts both. The dash-log is *already* what
//! every surface reads a dash's state from, so the announcement is skippable
//! only by not writing the record — at which point the mutation did not happen.
//! A verb run by hand in a bare terminal announces on the card identically,
//! because nothing about the caller is an input. There is one writer of the
//! fact and one reader of it.
//!
//! # How it observes
//!
//! By polling, and the poll is the same relationship `changeset_all`'s
//! drafts-and-dash-log probe already has to the same file: **the event is
//! real, only its observation is polled.** The dash-log lives under the data
//! dir rather than under a workspace root, so it reaches no file watcher this
//! process runs; a stat per open project per second is what stands in for one.
//!
//! Each project's log carries a byte cursor, **seeded at the file's current
//! end** the first time it is seen. So a restart paints nothing retroactively:
//! the card's view of a run begins where this process did. The alternative —
//! a persisted cursor that backfills — would paint a three-day-old gesture
//! onto whatever card is bound today, which is a worse wrong than a missing
//! line.
//!
//! # What it paints on
//!
//! `AgentSupervisor::record_dash_note`, which is the same server-authored
//! channel the arc's own stop receipt uses: a durable `shell_exchanges` row
//! keyed to the card's **line** (so a rotation carries it) plus one unsolicited
//! `dash_note` CONTROL frame so the card paints its live copy now rather than
//! at the next restore ([D111], [P12]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::agent_supervisor::AgentSupervisor;
use super::workspace_registry::WorkspaceRegistry;
use crate::session_ledger::SessionLedger;

/// How often each open project's dash-log is stat-ed for growth.
///
/// A second, because the point is to watch a run *move*: a step opening and a
/// round landing should reach the card while the reader is still looking at
/// where they came from. The cost is one `metadata` call per open project per
/// second, plus a short read only when the length actually grew — the same
/// order as the 2-second probe `changeset_all` already runs over this file.
const POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// What the observer needs to run.
pub struct DashNotesContext {
    pub registry: Arc<WorkspaceRegistry>,
    pub supervisor: Arc<AgentSupervisor>,
    pub sessions: Arc<SessionLedger>,
    pub cancel: CancellationToken,
}

/// Watch every open project's dash-log and paint each announceable line.
pub async fn run_dash_notes(ctx: DashNotesContext) {
    let mut cursors: HashMap<PathBuf, u64> = HashMap::new();
    let mut ticker = tokio::time::interval(POLL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                debug!("dash-note observer shutting down");
                return;
            }
            _ = ticker.tick() => {}
        }
        for (root, _key) in ctx.registry.project_dirs() {
            let path = tugtool_core::project_state_dir(&root).join("dash-log.md");
            let fresh = match read_fresh_lines(&path, &mut cursors) {
                Ok(lines) => lines,
                Err(err) => {
                    // A log that cannot be read is a log with nothing to say.
                    // The cursor is left where it was, so a transient error
                    // costs a tick rather than a run's worth of lines.
                    debug!(path = %path.display(), error = %err, "dash-log unreadable");
                    continue;
                }
            };
            for line in fresh {
                announce_line(&ctx, &root, &line).await;
            }
        }
    }
}

/// The complete lines appended to `path` since this process last looked.
///
/// The cursor advances only past bytes that ended in a newline, so a line
/// caught mid-write is read whole on the next tick rather than split in two.
/// A file that shrank was replaced rather than appended to — the cursor is
/// reset to its end, which is the same answer as seeing it for the first time.
fn read_fresh_lines(
    path: &Path,
    cursors: &mut HashMap<PathBuf, u64>,
) -> std::io::Result<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};

    let length = match std::fs::metadata(path) {
        Ok(meta) => meta.len(),
        // No log yet. Nothing to seed and nothing to read: the first append
        // creates it, and this arm sees it on the tick after.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let Some(&cursor) = cursors.get(path) else {
        // Seeded at the end, never at zero — see the module docblock.
        cursors.insert(path.to_path_buf(), length);
        return Ok(Vec::new());
    };
    if length < cursor {
        cursors.insert(path.to_path_buf(), length);
        return Ok(Vec::new());
    }
    if length == cursor {
        return Ok(Vec::new());
    }
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(cursor))?;
    let mut tail = String::new();
    file.take(length - cursor).read_to_string(&mut tail)?;
    let complete = match tail.rfind('\n') {
        Some(last) => &tail[..=last],
        // Bytes with no newline in them are half a line. Leave the cursor.
        None => return Ok(Vec::new()),
    };
    cursors.insert(path.to_path_buf(), cursor + complete.len() as u64);
    Ok(complete
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect())
}

/// Paint one dash-log line on every live card bound to the dash it names.
async fn announce_line(ctx: &DashNotesContext, root: &Path, line: &str) {
    let Some((_timestamp, dash, marker, note)) = tugdash_core::dash::split_log_line(line) else {
        return;
    };
    let Some(sentence) = note_for_line(dash, marker, note) else {
        return;
    };
    let command = command_for_line(dash, marker);
    let mut painted: std::collections::HashSet<String> = std::collections::HashSet::new();
    let bound = match ctx.sessions.live_sessions_on_dash_named(dash) {
        Ok(bound) => bound,
        Err(err) => {
            warn!(dash, error = %err, "could not resolve the cards a dash-log line belongs to");
            return;
        }
    };
    for (session, project_dir) in bound {
        if !session_works_in(&project_dir, root) {
            continue;
        }
        // **One line per card, not per bound row.** A rotation leaves the
        // retired segment's row `live` on the same line until the card closes,
        // and `seat_line_binding` is what keeps only one of them bound — a
        // belt to that brace, because two rows resolving to one card would
        // draw the gesture twice on it.
        //
        // Resolved *before* painting, not after: a check that runs after the
        // row is written is not a guard, it is a count.
        let card = match ctx.supervisor.card_entry_for_segment(&session).await {
            Some((card, _)) => card.as_str().to_string(),
            None => session.clone(),
        };
        if !painted.insert(card) {
            continue;
        }
        ctx.supervisor
            .record_dash_note(&session, &project_dir, &command, &sentence)
            .await;
        // **The record is the gate's backstop.** The close's own report to the
        // server (`POST /api/session {op:"step_closed"}`) is the timely path
        // and this is the one that cannot be skipped: a report that never
        // landed still reaches the boundary here, a tick late. Late is the
        // right failure — the gate would otherwise be open for the whole turn.
        if let Some(step) = closed_step(marker, note) {
            ctx.supervisor
                .mark_step_closed_this_turn(&session, step)
                .await;
        }
    }
}

/// Whether a session working `project_dir` belongs to the checkout `root`,
/// whose dash-log this line came from.
///
/// A dash's *name* does not place it — two checkouts may each have a
/// `refactor` — so the record's own tree is what decides which cards hear
/// about it. Containment rather than equality, because a dash's stage session
/// works the **worktree** (`<root>/.tug/worktrees/<dash>`) and never the root.
pub(crate) fn session_works_in(project_dir: &str, root: &Path) -> bool {
    Path::new(project_dir).starts_with(root)
}

/// The step a line closed, when it closed one.
fn closed_step(marker: &str, note: &str) -> Option<u32> {
    matches!(marker, "step-done" | "step-withdrawn")
        .then(|| tugdash_core::dash::read_step_fields(note).map(|(current, _)| current))
        .flatten()
}

/// The sentence one dash-log line paints, or `None` for a line the card has
/// nothing to say about.
///
/// **The closed set is the nine gestures W8 names**, and the omissions are
/// deliberate rather than pending: a join or a discard already paints its own
/// landing receipt, an `arc-*` marker is the course's own record and ends in
/// the arc receipt, and `replayed` / `verified` are their own verbs with their
/// own read-outs. A tenth line about the same event is noise, not visibility.
pub fn note_for_line(dash: &str, marker: &str, note: &str) -> Option<String> {
    // A teardown is not a step gesture, and its marker is a sha — so this test
    // comes first, or a join would read as a round.
    if tugdash_core::dash::is_terminal(marker, note) {
        return None;
    }
    match marker {
        "created" => Some(format!("{dash}: dash created")),
        "run-through" => {
            let through = note.trim();
            (!through.is_empty()).then(|| format!("{dash}: run declared through step {through}"))
        }
        "step-start" | "step-done" | "step-withdrawn" | "step-reset" | "step-reopen" => {
            let (current, total) = tugdash_core::dash::read_step_fields(note)?;
            let tail = tugdash_core::dash::read_step_title(note, current);
            let tail = tail.as_deref();
            Some(match marker {
                // A start's tail is the step's title, which is the one thing
                // the card cannot get from anywhere else while the step runs.
                "step-start" => with_tail(format!("{dash}: step {current}/{total} started"), tail),
                // A done's tail is the round's sha.
                "step-done" => match tail {
                    Some(sha) => format!("{dash}: step {current}/{total} closed ({sha})"),
                    None => format!("{dash}: step {current}/{total} closed"),
                },
                "step-withdrawn" => format!("{dash}: step {current}/{total} withdrawn"),
                "step-reset" => format!("{dash}: step {current}/{total} parked back to pending"),
                _ => with_tail(format!("{dash}: step {current}/{total} reopened"), tail),
            })
        }
        "built" | "audited" => Some(format!("{dash}: marked {marker}")),
        // A round: the marker *is* the short sha and the note is the verbatim
        // instruction. `-` is `dash commit` finding nothing to commit, which
        // moved no record and says nothing.
        sha if is_short_sha(sha) => Some(with_tail(
            format!("{dash}: round {sha}"),
            Some(note).filter(|n| !n.is_empty()),
        )),
        _ => None,
    }
}

/// The `$` command a row shows, **rendered from the record** rather than
/// echoed from an invocation.
///
/// The record does not keep how a verb was spelled — which flags it carried,
/// whether the sha was passed or derived — so this is a faithful rendering of
/// what happened and not a transcript of what was typed. It is verb-shaped
/// because that is what a reader recognizes; the sentence beside it carries
/// the truth.
fn command_for_line(dash: &str, marker: &str) -> String {
    match marker {
        "created" => format!("dash create {dash}"),
        "run-through" => format!("dash step {dash} start --through"),
        "step-start" => format!("dash step {dash} start"),
        "step-done" => format!("dash step {dash} done"),
        "step-withdrawn" => format!("dash step {dash} withdraw"),
        "step-reset" => format!("dash step {dash} reset"),
        "step-reopen" => format!("dash step {dash} reopen"),
        "built" | "audited" => format!("dash mark {dash} {marker}"),
        _ => format!("dash commit {dash}"),
    }
}

/// Whether a marker is a round's short sha — hex, and long enough that no
/// word in the marker vocabulary can be mistaken for one.
fn is_short_sha(marker: &str) -> bool {
    marker.len() >= 7 && marker.len() <= 40 && marker.chars().all(|c| c.is_ascii_hexdigit())
}

fn with_tail(head: String, tail: Option<&str>) -> String {
    match tail {
        Some(tail) => format!("{head} — {tail}"),
        None => head,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nine_gestures_each_get_a_sentence() {
        assert_eq!(
            note_for_line("demo", "created", "").as_deref(),
            Some("demo: dash created")
        );
        assert_eq!(
            note_for_line("demo", "run-through", "7").as_deref(),
            Some("demo: run declared through step 7")
        );
        assert_eq!(
            note_for_line("demo", "step-start", "1/7 The first step").as_deref(),
            Some("demo: step 1/7 started — The first step")
        );
        assert_eq!(
            note_for_line("demo", "step-done", "1/7 999353ca1").as_deref(),
            Some("demo: step 1/7 closed (999353ca1)")
        );
        assert_eq!(
            note_for_line("demo", "step-withdrawn", "2/7 A step nobody walked").as_deref(),
            Some("demo: step 2/7 withdrawn")
        );
        assert_eq!(
            note_for_line("demo", "step-reset", "2/7 Put down").as_deref(),
            Some("demo: step 2/7 parked back to pending")
        );
        assert_eq!(
            note_for_line("demo", "step-reopen", "2/7 The audit rejected it").as_deref(),
            Some("demo: step 2/7 reopened — The audit rejected it")
        );
        assert_eq!(
            note_for_line("demo", "built", "").as_deref(),
            Some("demo: marked built")
        );
        assert_eq!(
            note_for_line("demo", "audited", "").as_deref(),
            Some("demo: marked audited")
        );
        assert_eq!(
            note_for_line("demo", "999353ca1", "Step 1: The first step").as_deref(),
            Some("demo: round 999353ca1 — Step 1: The first step")
        );
    }

    #[test]
    fn a_close_with_no_round_still_says_it_closed() {
        assert_eq!(
            note_for_line("demo", "step-done", "3/7").as_deref(),
            Some("demo: step 3/7 closed")
        );
    }

    #[test]
    fn a_teardown_is_not_a_round_even_though_its_marker_is_a_sha() {
        // The join and the discard already paint their own landing receipts.
        // Reading the terminal test after the sha test would give each of them
        // a second row calling it a round.
        assert_eq!(note_for_line("demo", "999353ca1", "joined"), None);
        assert_eq!(note_for_line("demo", "999353ca1", "joined via card"), None);
        assert_eq!(note_for_line("demo", "discarded", "via card"), None);
    }

    #[test]
    fn the_markers_that_already_have_a_surface_paint_nothing() {
        for (marker, note) in [
            ("arc-start", "dash/plan.md"),
            ("arc-stage", "implement opus"),
            ("arc-stop", "implement idle"),
            ("arc-course", "plan"),
            ("replayed", "onto abc1234: d->e"),
            ("verified", "clean"),
            ("-", "nothing to commit"),
        ] {
            assert_eq!(note_for_line("demo", marker, note), None, "{marker}");
        }
    }

    #[test]
    fn only_a_close_reaches_the_gates_backstop() {
        assert_eq!(closed_step("step-done", "3/7 abc1234"), Some(3));
        assert_eq!(closed_step("step-withdrawn", "4/7 A title"), Some(4));
        assert_eq!(closed_step("step-start", "3/7 A title"), None);
        assert_eq!(closed_step("step-reset", "3/7 A title"), None);
        assert_eq!(closed_step("step-reopen", "3/7 A title"), None);
        assert_eq!(closed_step("999353ca1", "Step 1"), None);
    }

    #[test]
    fn the_cursor_seeds_at_the_end_and_then_reads_only_what_arrives() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        std::fs::write(&path, "2026-09-01T00:00:00Z  demo  created  \n").expect("write");
        let mut cursors = HashMap::new();

        // Seeded at the end: a restart paints nothing retroactively.
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());

        std::fs::write(
            &path,
            "2026-09-01T00:00:00Z  demo  created  \n\
             2026-09-01T00:00:01Z  demo  step-start  1/7 The first step\n",
        )
        .expect("append");
        let fresh = read_fresh_lines(&path, &mut cursors).unwrap();
        assert_eq!(fresh.len(), 1);
        assert!(fresh[0].contains("step-start"), "{fresh:?}");

        // And nothing twice.
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());
    }

    #[test]
    fn a_line_caught_mid_write_is_read_whole_on_the_next_tick() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        std::fs::write(&path, "").expect("write");
        let mut cursors = HashMap::new();
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());

        std::fs::write(&path, "2026-09-01T00:00:01Z  demo  step-done  1/7").expect("half");
        assert!(
            read_fresh_lines(&path, &mut cursors).unwrap().is_empty(),
            "bytes with no newline in them are half a line"
        );

        std::fs::write(
            &path,
            "2026-09-01T00:00:01Z  demo  step-done  1/7 abc1234\n",
        )
        .expect("whole");
        let fresh = read_fresh_lines(&path, &mut cursors).unwrap();
        assert_eq!(fresh.len(), 1);
        assert!(fresh[0].ends_with("abc1234"), "{fresh:?}");
    }

    #[test]
    fn a_log_that_shrank_was_replaced_and_is_reseeded() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        std::fs::write(&path, "2026-09-01T00:00:00Z  demo  created  \n").expect("write");
        let mut cursors = HashMap::new();
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());

        std::fs::write(&path, "").expect("truncate");
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());
        assert_eq!(cursors.get(&path), Some(&0));
    }

    #[test]
    fn an_absent_log_is_neither_an_error_nor_a_seed() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        let mut cursors = HashMap::new();
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());
        assert!(
            cursors.is_empty(),
            "the first append creates the file, and is read on the tick after"
        );
    }

    #[test]
    fn a_line_reaches_the_cards_working_the_tree_it_came_from() {
        let root = Path::new("/checkouts/tug");
        // The root itself, and the dash worktree under it — a stage session
        // works the worktree and never the root.
        assert!(session_works_in("/checkouts/tug", root));
        assert!(session_works_in("/checkouts/tug/.tug/worktrees/demo", root));
        // A second checkout with a dash of the same name hears nothing.
        assert!(!session_works_in("/checkouts/other", root));
        // And a prefix that is not a path component is not containment.
        assert!(!session_works_in("/checkouts/tug-site", root));
    }

    #[test]
    fn the_rendered_command_is_verb_shaped_per_marker() {
        assert_eq!(command_for_line("demo", "step-done"), "dash step demo done");
        assert_eq!(command_for_line("demo", "created"), "dash create demo");
        assert_eq!(command_for_line("demo", "built"), "dash mark demo built");
        assert_eq!(command_for_line("demo", "999353ca1"), "dash commit demo");
    }
}
