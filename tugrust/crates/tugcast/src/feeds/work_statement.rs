//! The follower that reads a session's arc statement when its answer ends.
//!
//! A session that lays out a run of arcs states it in its answer, as a
//! `tugarcs` fence or as whole `/arc <name> @<brief>` command lines. The
//! supervisor's merger sends the session id here at the live edge where a
//! turn ends (never for a replayed, cancelled or API-error turn), and this
//! reads the turn that ended from the session's transcript and hands the
//! statement it makes to `tugarc_core::statement::state_arcs`, which queues
//! the arcs on their cycle and appends the one `arcs.stated` work line the
//! work-log follower turns into a fact.
//!
//! The transcript, not the frames the merger forwards, is what is read: the
//! bridge sends a turn's settled text only for its last message, and sends
//! every block again on a reconnect, so text written before a tool call
//! would be missed and a reconnect would read a statement twice. The
//! transcript holds every assistant block of the turn once.
//!
//! **A private session states nothing**, and its words never reach the
//! core. Only a registry-open project is written to, so an `apptest-`
//! instance never writes the user's records. Nothing is sent to the card:
//! the cycle's file watch redraws it when the record moves.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};
use tugarc_core::statement::{Stated, read_answer, state_arcs};
use tugarc_core::work_log::{By, Privacy};
use tugcore::instance::Paths;
use tugcore::session_transcript::{self, Transcript};

use super::workspace_registry::WorkspaceRegistry;
use crate::session_ledger::SessionLedger;

/// What the follower needs to run.
pub struct StatementContext {
    pub registry: Arc<WorkspaceRegistry>,
    pub sessions: Arc<SessionLedger>,
    pub cancel: CancellationToken,
}

/// Read each session whose turn ended, as the merger names them, and state
/// the arcs its answer declares.
pub async fn run_statement_follower(ctx: StatementContext, mut ticks: mpsc::Receiver<String>) {
    loop {
        let session = tokio::select! {
            _ = ctx.cancel.cancelled() => {
                debug!("statement follower shutting down");
                return;
            }
            received = ticks.recv() => match received {
                Some(session) => session,
                None => return,
            },
        };
        let roots: Vec<PathBuf> = ctx
            .registry
            .project_dirs()
            .into_iter()
            .map(|(root, _)| root)
            .collect();
        let ledger = Arc::clone(&ctx.sessions);
        let id = session.clone();
        match tokio::task::spawn_blocking(move || {
            state_session(&ledger, &Paths::from_env(), &roots, &id)
        })
        .await
        {
            Ok(Read::Stated(stated)) => {
                debug!(session = %session, status = ?stated.status, arcs = stated.arcs.len(), "arc statement applied")
            }
            Ok(Read::Failed(err)) => {
                warn!(session = %session, error = %err, "arc statement could not be applied")
            }
            Ok(other) => debug!(session = %session, read = ?other, "no arc statement"),
            Err(err) => warn!(session = %session, error = %err, "arc statement read failed"),
        }
    }
}

/// What reading one session's ended turn came to.
#[derive(Debug)]
enum Read {
    /// The session is private: nothing of it was read.
    Private,
    /// The session has no row in this instance's ledger.
    Unknown,
    /// The session's project is not open in this instance.
    NotOpen,
    /// No transcript on disk, or one with no turn.
    NoTranscript,
    /// The turn's answer states no arcs.
    NoStatement,
    /// The statement was applied.
    Stated(Stated),
    /// The statement could not be applied.
    Failed(String),
}

/// Read session `session`'s last turn and apply the statement it makes, in
/// a project among `roots`.
fn state_session(ledger: &SessionLedger, paths: &Paths, roots: &[PathBuf], session: &str) -> Read {
    if ledger.is_session_private(session).unwrap_or(true) {
        return Read::Private;
    }
    let Ok(Some(row)) = ledger.get(session) else {
        return Read::Unknown;
    };
    let project_dir = PathBuf::from(&row.project_dir);
    if !is_open(paths, roots, &project_dir) {
        return Read::NotOpen;
    }
    let path =
        crate::session_ledger::transcript_path(ledger.claude_home(), &row.project_dir, session);
    if !path.is_file() {
        return Read::NoTranscript;
    }
    let Some((turn, text)) = last_turn_text(&session_transcript::read(&path)) else {
        return Read::NoTranscript;
    };
    // The cheap test first: most answers name no arc at all.
    if !text.contains("/arc") && !text.contains(tugarc_core::statement::FENCE_LANG) {
        return Read::NoStatement;
    }
    let Some((statement, warnings)) = read_answer(&text) else {
        return Read::NoStatement;
    };
    for warning in &warnings {
        debug!(session, warning = %warning, "arc statement repaired");
    }
    let by = By {
        session: Some(session.to_owned()),
        turn: Some(turn),
        privacy: Privacy::Public,
        segments: ledger
            .line_segments_of(session)
            .into_iter()
            .filter(|id| id != session)
            .collect(),
    };
    match state_arcs(paths, &project_dir, &statement, &by) {
        Ok(stated) => Read::Stated(stated),
        Err(err) => Read::Failed(err.to_string()),
    }
}

/// Whether `project_dir` is one of the projects this instance holds open.
/// Compared by the state dir each keeps its records in, so a worktree of an
/// open checkout counts as that checkout.
fn is_open(paths: &Paths, roots: &[PathBuf], project_dir: &Path) -> bool {
    let state = tugtool_core::paths::project_state_dir_at(paths, project_dir);
    roots
        .iter()
        .any(|root| tugtool_core::paths::project_state_dir_at(paths, root) == state)
}

/// The last turn's number and its assistant text, every block of it joined
/// by a blank line, or `None` for a transcript with no turn.
fn last_turn_text(transcript: &Transcript) -> Option<(u32, String)> {
    let turn = transcript.turns.last()?;
    let number = u32::try_from(turn.number).ok()?;
    Some((number, turn.assistant.join("\n\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    use tugarc_core::cycle::{NewEntry, add_entry, add_sketch, create_cycle, cycles};
    use tugarc_core::work_log::{WorkKind, read_lines, work_log_path};
    use tugcore::claude_home::ClaudeHome;

    const SESSION: &str = "0f3c1e5a-9b27-4c1d-8e36-5a7f2d4b6c90";

    struct Scratch {
        _temp: TempDir,
        repo: PathBuf,
        paths: Paths,
        ledger: SessionLedger,
        cycle: String,
    }

    /// A project with one cycle holding brief `a` in a free entry,
    /// briefs `b` and `c` on disk, and a ledger row for [`SESSION`].
    fn scratch() -> Scratch {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repo = root.join("repo");
        fs::create_dir_all(repo.join("briefs")).unwrap();
        for stem in ["a", "b", "c"] {
            fs::write(
                repo.join(format!("briefs/{stem}-brief.md")),
                format!("# {stem}\n"),
            )
            .unwrap();
        }
        let paths = Paths::under(&root.join("state"));
        let cycle = create_cycle(&paths, &repo, "Run", None).unwrap().id;
        let dir = tugarc_core::documents_dir(&repo, "seed");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sketch.md"), "# Sketch\n\nseed\n").unwrap();
        let sketch = tugarc_core::sketch::record_arc_sketch(
            &paths,
            &repo,
            "seed",
            &By::none(),
            tugarc_core::sketch::Written::AtTheTime,
        )
        .unwrap()
        .id;
        add_sketch(&paths, &repo, &cycle, &sketch, None).unwrap();
        add_entry(
            &paths,
            &repo,
            &cycle,
            NewEntry {
                brief: "briefs/a-brief.md".into(),
                from: vec!["A".into()],
                ..NewEntry::default()
            },
        )
        .unwrap();
        let ledger =
            SessionLedger::open_in_memory_with_home(ClaudeHome::at(root.join("claude"))).unwrap();
        ledger
            .record_spawn(
                SESSION,
                "ws",
                repo.to_str().unwrap(),
                "card-0",
                1_000,
                "line-0",
                None,
            )
            .unwrap();
        Scratch {
            _temp: temp,
            repo,
            paths,
            ledger,
            cycle,
        }
    }

    impl Scratch {
        /// Write the session's transcript, one JSON record per line.
        fn transcript(&self, records: &[serde_json::Value]) {
            let path = crate::session_ledger::transcript_path(
                self.ledger.claude_home(),
                self.repo.to_str().unwrap(),
                SESSION,
            );
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let text: Vec<String> = records.iter().map(|r| r.to_string()).collect();
            fs::write(path, text.join("\n") + "\n").unwrap();
        }

        fn read(&self) -> Read {
            state_session(
                &self.ledger,
                &self.paths,
                std::slice::from_ref(&self.repo),
                SESSION,
            )
        }

        /// The arc names the cycle's entries carry, in entry order.
        fn named(&self) -> Vec<String> {
            let record = cycles(&self.paths, &self.repo)
                .into_iter()
                .find(|c| c.id == self.cycle)
                .unwrap();
            record
                .entries
                .iter()
                .filter_map(|e| e.arc_name.clone())
                .collect()
        }

        fn stated_lines(&self) -> Vec<tugarc_core::work_log::WorkLine> {
            let text =
                fs::read_to_string(work_log_path(&self.paths, &self.repo)).unwrap_or_default();
            read_lines(&text)
                .into_iter()
                .filter(|l| l.kind == WorkKind::ArcsStated)
                .collect()
        }
    }

    fn user(text: &str) -> serde_json::Value {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": text}})
    }

    fn says(text: &str) -> serde_json::Value {
        serde_json::json!({"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "text", "text": text}]}})
    }

    fn calls_a_tool() -> serde_json::Value {
        serde_json::json!({"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}})
    }

    fn tool_answer() -> serde_json::Value {
        serde_json::json!({"type": "user", "message": {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}})
    }

    const FENCE: &str = "The run:\n\n```tugarcs\n{\"tugarcs\": 1, \"arcs\": [\n  \
        {\"name\": \"alpha\", \"brief\": \"briefs/a-brief.md\"},\n  \
        {\"name\": \"beta\", \"brief\": \"briefs/b-brief.md\"}\n]}\n```";

    #[test]
    fn a_public_sessions_fence_queues_its_arcs_and_leaves_one_line() {
        let s = scratch();
        s.transcript(&[
            user("lay out the run"),
            says("one moment"),
            user("go on"),
            says(FENCE),
        ]);
        assert!(matches!(s.read(), Read::Stated(_)));
        assert_eq!(s.named(), ["alpha", "beta"]);
        let lines = s.stated_lines();
        assert_eq!(lines.len(), 1, "one line for one statement");
        assert_eq!(lines[0].session.as_deref(), Some(SESSION));
        assert_eq!(lines[0].turn, Some(2), "the transcript's own turn number");

        // The same answer read again is the same statement: nothing more.
        assert!(matches!(s.read(), Read::Stated(_)));
        assert_eq!(s.stated_lines().len(), 1);
    }

    #[test]
    fn text_before_a_tool_call_is_read() {
        let s = scratch();
        s.transcript(&[
            user("lay out the run"),
            says(FENCE),
            calls_a_tool(),
            tool_answer(),
            says("Done."),
        ]);
        assert!(matches!(s.read(), Read::Stated(_)));
        assert_eq!(s.named(), ["alpha", "beta"]);
    }

    #[test]
    fn only_the_last_turn_is_read() {
        let s = scratch();
        s.transcript(&[
            user("lay out the run"),
            says(FENCE),
            user("thanks"),
            says("You are welcome."),
        ]);
        assert!(matches!(s.read(), Read::NoStatement));
        assert!(s.named().is_empty());
        assert!(s.stated_lines().is_empty());
    }

    #[test]
    fn a_private_sessions_fence_writes_nothing() {
        let s = scratch();
        s.ledger.set_session_private(SESSION, true).unwrap();
        s.transcript(&[user("lay out the run"), says(FENCE)]);
        assert!(matches!(s.read(), Read::Private));
        assert!(s.named().is_empty());
        assert!(s.stated_lines().is_empty());
        assert!(
            tugarc_core::statement::statements(&s.paths, &s.repo).is_empty(),
            "no statement record either"
        );
    }

    #[test]
    fn an_answer_with_no_statement_writes_nothing() {
        let s = scratch();
        s.transcript(&[
            user("how do I open one?"),
            says("Type `/arc alpha @briefs/a-brief.md` in the composer to open it."),
        ]);
        assert!(matches!(s.read(), Read::NoStatement));
        assert!(s.named().is_empty());
        assert!(s.stated_lines().is_empty());
    }

    #[test]
    fn a_project_that_is_not_open_is_refused() {
        let s = scratch();
        s.transcript(&[user("lay out the run"), says(FENCE)]);
        let elsewhere = s.repo.parent().unwrap().join("other");
        fs::create_dir_all(&elsewhere).unwrap();
        assert!(matches!(
            state_session(&s.ledger, &s.paths, &[elsewhere], SESSION),
            Read::NotOpen
        ));
        assert!(s.named().is_empty());
        assert!(s.stated_lines().is_empty());
    }
}
