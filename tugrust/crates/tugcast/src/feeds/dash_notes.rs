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
//! **By watching, never by polling.** The dash-log lives under the data dir
//! rather than under a workspace root, so no watcher this process already runs
//! reaches it — `changeset_all`'s docblock says exactly that, and stats the
//! file on a timer because a *bump* is all it needs. A line on the card is not
//! a bump: it is the thing the user is watching for, and a second of latency
//! bought by burning a syscall a second on every open project is a bad trade
//! twice over.
//!
//! So this arms its own `notify` watch on the projects directory, recursively,
//! and the kernel says when a log grew. A watch that cannot be armed logs at
//! `error` and the observer stops; there is deliberately **no poll fallback**,
//! because a fallback is how a poll becomes permanent.
//!
//! # Which lines are news
//!
//! Two filters, and each closes a hole the other leaves open.
//!
//! A **byte cursor** per log, starting at zero, is what makes a line paint
//! *once*: every wake reads only what was appended since the last one, and a
//! line caught mid-write waits for its newline rather than arriving in halves.
//!
//! A **timestamp floor** at the observer's own start is what keeps the first
//! wake from painting a project's entire history. The dash-log's own first
//! field is a fixed-width UTC timestamp, so the comparison is a string compare
//! against the moment this process began. That is also the whole of the
//! restart story, and it falls out of a fact rather than a trick: a line
//! written before this process started is not news, so a restart paints
//! nothing retroactively and a project opened an hour later is on exactly the
//! same footing as one open at boot.
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

use notify::Watcher;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use super::agent_supervisor::AgentSupervisor;
use super::workspace_registry::WorkspaceRegistry;
use crate::session_ledger::SessionLedger;

/// The record every project keeps, and the one file name this watches for.
const DASH_LOG: &str = "dash-log.md";

/// The directory every project's dash-log lives under, created if absent so
/// the watch has something to attach to before the first dash exists.
fn logs_root() -> PathBuf {
    let root = tugcore::instance::base_data_dir().join("projects");
    let _ = std::fs::create_dir_all(&root);
    root
}

/// What the observer needs to run.
pub struct DashNotesContext {
    pub registry: Arc<WorkspaceRegistry>,
    pub supervisor: Arc<AgentSupervisor>,
    pub sessions: Arc<SessionLedger>,
    pub cancel: CancellationToken,
}

/// Watch every project's dash-log and paint each announceable line.
pub async fn run_dash_notes(ctx: DashNotesContext) {
    let root = logs_root();
    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel::<()>(1);
    // The callback runs on notify's own thread and must not block. `try_send`
    // on a depth-1 channel is exactly the coalescing this wants: a burst of
    // FSEvents leaves one pending wake, and a wake already pending is a wake
    // this event is covered by.
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if event
            .paths
            .iter()
            .any(|path| path.file_name().is_some_and(|name| name == DASH_LOG))
        {
            let _ = wake_tx.try_send(());
        }
    });
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(err) => {
            error!(error = %err, "the dash-note observer could not create a watcher — the card will show no run progress");
            return;
        }
    };
    if let Err(err) = watcher.watch(&root, notify::RecursiveMode::Recursive) {
        error!(dir = %root.display(), error = %err, "the dash-note observer could not watch the project state dirs — the card will show no run progress");
        return;
    }
    info!(dir = %root.display(), "dash-note observer watching");

    // `watcher` is held for the whole loop deliberately: dropping it
    // unregisters the OS watch, and a watcher bound only long enough to call
    // `watch` is the classic way to end up with no events and no error.
    //
    // Every line already on disk belongs to a run this process did not watch.
    let floor = tugtool_core::session::now_iso8601();
    let mut cursors: HashMap<PathBuf, u64> = HashMap::new();

    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                debug!("dash-note observer shutting down");
                return;
            }
            received = wake_rx.recv() => {
                if received.is_none() {
                    return;
                }
            }
        }
        sweep(&ctx, &floor, &mut cursors).await;
    }
}

/// Read what every open project's log has grown by, and paint it.
///
/// The registry is enumerated per wake rather than watched, because a wake
/// already means a log moved and the set of open projects is a handful of
/// entries behind a mutex. A project the registry does not hold has no card to
/// paint on, so its log is not read at all.
async fn sweep(ctx: &DashNotesContext, floor: &str, cursors: &mut HashMap<PathBuf, u64>) {
    for (root, _key) in ctx.registry.project_dirs() {
        let path = tugtool_core::project_state_dir(&root).join(DASH_LOG);
        let fresh = match read_fresh_lines(&path, cursors) {
            Ok(lines) => lines,
            Err(err) => {
                // A log that cannot be read is a log with nothing to say. The
                // cursor is left where it was, so a transient error costs a
                // wake rather than a run's worth of lines.
                debug!(path = %path.display(), error = %err, "dash-log unreadable");
                continue;
            }
        };
        for line in fresh {
            if !is_news(&line, floor) {
                continue;
            }
            announce_line(ctx, &root, &line).await;
        }
    }
}

/// Whether a dash-log line was written after this observer started.
///
/// The log's first field is a fixed-width UTC timestamp, so "after" is a
/// string compare. A line whose shape this cannot read is **not** news: an
/// unparseable line is one nothing else in the machine reads either, and
/// painting it would be guessing.
fn is_news(line: &str, floor: &str) -> bool {
    tugdash_core::dash::split_log_line(line).is_some_and(|(timestamp, _, _, _)| timestamp >= floor)
}

/// The complete lines appended to `path` since this process last looked.
///
/// The cursor advances only past bytes that ended in a newline, so a line
/// caught mid-write is read whole on the next wake rather than split in two.
/// A file that shrank was replaced rather than appended to — the cursor is
/// reset to its end, because there is no telling which bytes moved.
///
/// A log seen for the first time reads from **zero**, and what keeps that from
/// painting a whole history is the timestamp floor rather than a seeded
/// cursor: a seed would swallow the first line of any project that opened
/// after this process did.
fn read_fresh_lines(
    path: &Path,
    cursors: &mut HashMap<PathBuf, u64>,
) -> std::io::Result<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};

    let length = match std::fs::metadata(path) {
        Ok(meta) => meta.len(),
        // No log yet. The first append creates it, and creating it is itself
        // an event this observer is watching for.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let cursor = cursors.get(path).copied().unwrap_or(0);
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
        // landed still reaches the boundary here, one watch event late. Late
        // is the right failure — the gate would otherwise be open for the
        // whole turn.
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
///
/// **Both sides pass through [`canonical_repo_root`] first**, because the two
/// spellings arrive from different writers: `root` is the registry's original
/// pre-canonicalized project path (`/u/src/tug`, say — the spelling the
/// workspace was opened by), while `project_dir` is what the binding row
/// recorded (`/Users/…/Mounts/u/src/tug`). A raw `starts_with` across those
/// filtered every line of the course machinery's first fully-instrumented run
/// — silently, because a non-member is not an error — and with it the gate's
/// record-side backstop. One repo, one spelling, is the state dir's own rule
/// ([`project_state_dir`]); the membership test follows it.
pub(crate) fn session_works_in(project_dir: &str, root: &Path) -> bool {
    let session = tugtool_core::paths::canonical_repo_root(Path::new(project_dir));
    let root = tugtool_core::paths::canonical_repo_root(root);
    session.starts_with(&root)
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
    fn the_cursor_reads_from_zero_and_then_only_what_arrives() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        std::fs::write(&path, "2026-09-01T00:00:00.000Z  demo  created  \n").expect("write");
        let mut cursors = HashMap::new();

        // A log seen for the first time is read whole. What keeps its history
        // off the card is the timestamp floor, not the cursor — a seeded
        // cursor would swallow the first line of a project opened later.
        let first = read_fresh_lines(&path, &mut cursors).unwrap();
        assert_eq!(first.len(), 1);

        std::fs::write(
            &path,
            "2026-09-01T00:00:00.000Z  demo  created  \n\
             2026-09-01T00:00:01.000Z  demo  step-start  1/7 The first step\n",
        )
        .expect("append");
        let fresh = read_fresh_lines(&path, &mut cursors).unwrap();
        assert_eq!(fresh.len(), 1);
        assert!(fresh[0].contains("step-start"), "{fresh:?}");

        // And nothing twice.
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());
    }

    #[test]
    fn only_lines_written_since_the_observer_started_are_news() {
        let floor = "2026-09-01T12:00:00.000Z";
        assert!(!is_news(
            "2026-09-01T11:59:59.999Z  demo  step-done  1/7 abc1234",
            floor
        ));
        assert!(is_news(
            "2026-09-01T12:00:00.001Z  demo  step-done  1/7 abc1234",
            floor
        ));
        // A restart reads the whole log and paints none of it, which is the
        // whole of the restart story — a fact rather than a seeded cursor.
        assert!(is_news("2026-09-01T12:00:00.000Z  demo  created  ", floor));
        // A line whose shape cannot be read is not news: nothing else in the
        // machine reads it either, and painting it would be guessing.
        assert!(!is_news("not a dash-log line", floor));
        assert!(!is_news("", floor));
    }

    #[test]
    fn a_line_caught_mid_write_is_read_whole_on_the_next_wake() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        std::fs::write(&path, "").expect("write");
        let mut cursors = HashMap::new();
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());

        std::fs::write(&path, "2026-09-01T00:00:01.000Z  demo  step-done  1/7").expect("half");
        assert!(
            read_fresh_lines(&path, &mut cursors).unwrap().is_empty(),
            "bytes with no newline in them are half a line"
        );

        std::fs::write(
            &path,
            "2026-09-01T00:00:01.000Z  demo  step-done  1/7 abc1234\n",
        )
        .expect("whole");
        let fresh = read_fresh_lines(&path, &mut cursors).unwrap();
        assert_eq!(fresh.len(), 1);
        assert!(fresh[0].ends_with("abc1234"), "{fresh:?}");
    }

    #[test]
    fn a_log_that_shrank_was_replaced_and_the_cursor_follows_it() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        std::fs::write(&path, "2026-09-01T00:00:00.000Z  demo  created  \n").expect("write");
        let mut cursors = HashMap::new();
        assert_eq!(read_fresh_lines(&path, &mut cursors).unwrap().len(), 1);

        std::fs::write(&path, "").expect("truncate");
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());
        assert_eq!(cursors.get(&path), Some(&0));
    }

    #[test]
    fn an_absent_log_is_not_an_error() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("dash-log.md");
        let mut cursors = HashMap::new();
        assert!(read_fresh_lines(&path, &mut cursors).unwrap().is_empty());
        assert!(
            cursors.is_empty(),
            "the first append creates the file, and creating it is itself an event"
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

    /// The registry keeps the spelling a workspace was opened by; the binding
    /// row keeps the spelling the verb ran under. One repo, two names — the
    /// field case is a `/u/src/tug` symlink over `/Users/…/Mounts/u/src/tug`,
    /// and a raw prefix compare across them silenced every quiet line of the
    /// first fully-instrumented run. Membership resolves both spellings first.
    #[cfg(unix)]
    #[test]
    fn membership_survives_an_alias_spelling_of_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("repo");
        std::fs::create_dir_all(real.join(".tug/worktrees/demo")).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();

        // The registry says the alias; the binding row says the real path.
        let worktree = real.join(".tug/worktrees/demo");
        assert!(session_works_in(worktree.to_str().unwrap(), &alias));
        assert!(session_works_in(real.to_str().unwrap(), &alias));
        // And the reverse arrival order resolves the same way.
        let alias_worktree = alias.join(".tug/worktrees/demo");
        assert!(session_works_in(alias_worktree.to_str().unwrap(), &real));
        // A different tree is still not a member under any spelling.
        assert!(!session_works_in("/checkouts/other", &alias));
    }

    #[test]
    fn the_rendered_command_is_verb_shaped_per_marker() {
        assert_eq!(command_for_line("demo", "step-done"), "dash step demo done");
        assert_eq!(command_for_line("demo", "created"), "dash create demo");
        assert_eq!(command_for_line("demo", "built"), "dash mark demo built");
        assert_eq!(command_for_line("demo", "999353ca1"), "dash commit demo");
    }
}
