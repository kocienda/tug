//! The follower that turns every open project's work log into facts.
//!
//! The record writers in `tugarc-core` append one JSON line per change to
//! `<data>/projects/<state>/work-log.jsonl`: a sketch recorded, a brief
//! recorded or committed, an arc queued, opened, joined or discarded, an entry
//! dropped. They run out of process, in `tugtool` and the skills that drive
//! it, so this watches the file by name, recursively over the project state
//! dirs, and on each wake reads what every registry-open project's log has
//! grown by and records one fact per line.
//!
//! Facts are history rather than news, so there is no timestamp floor: a log
//! is read from byte 0 the first time it is seen, and a line written while
//! this process was down is still recorded. Each fact is keyed by its line's
//! id, so reading a log again from its start records nothing twice.
//!
//! **A line whose session has no row in this instance's ledger is skipped.**
//! The ledger reads a session with no row as public, and a project is often
//! open in two instances at once, each with its own ledger; recording the
//! other instance's line here would turn its private session into a public
//! fact in this one. The instance that owns the session records it. An arc
//! line names no session, so the session bound to the arc here fills it, and
//! an arc bound to none here records with no session, as an app-scoped fact.
//!
//! Only registry-open projects are read, so an `apptest-` instance, which
//! opens scratch projects, never ingests the user's real work. A watch that
//! cannot be armed logs at `error` and stops; there is no poll fallback.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use notify::Watcher;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};
use tugarc_core::work_log::{WorkKind, WorkLine, WorkObject};
use tugcore::instance::Paths;

use super::workspace_registry::WorkspaceRegistry;
use crate::session_ledger::SessionLedger;

/// The work log's file name, the one name this watches for.
const WORK_LOG: &str = tugarc_core::work_log::WORK_LOG;

/// The directory every project's state lives under, created if absent so
/// the watch has something to attach to before the first line exists.
fn logs_root() -> PathBuf {
    let root = tugcore::instance::base_data_dir().join("projects");
    let _ = std::fs::create_dir_all(&root);
    root
}

/// What the follower needs to run.
pub struct WorkLogContext {
    pub registry: Arc<WorkspaceRegistry>,
    pub sessions: Arc<SessionLedger>,
    pub cancel: CancellationToken,
}

/// Whether a write to `path` can add a line to a work log.
fn moves_a_log(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == WORK_LOG)
}

/// Watch every project's work log and record each new line as a fact.
pub async fn run_work_log_follower(ctx: WorkLogContext) {
    let root = logs_root();
    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel::<()>(1);
    // The callback runs on notify's own thread and must not block. `try_send`
    // on a depth-1 channel coalesces a burst into one pending wake.
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if event.paths.iter().any(|path| moves_a_log(path)) {
            let _ = wake_tx.try_send(());
        }
    });
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(err) => {
            error!(error = %err, "the work-log follower could not create a watcher — work records will leave no facts");
            return;
        }
    };
    if let Err(err) = watcher.watch(&root, notify::RecursiveMode::Recursive) {
        error!(dir = %root.display(), error = %err, "the work-log follower could not watch the project state dirs — work records will leave no facts");
        return;
    }
    info!(dir = %root.display(), "work-log follower watching");

    // `watcher` is held for the whole loop: dropping it unregisters the watch.
    let mut cursors: HashMap<PathBuf, u64> = HashMap::new();
    // One sweep before the first wake: lines written while this process was
    // down are history too.
    cursors = sweep_off_thread(&ctx, cursors).await;
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                debug!("work-log follower shutting down");
                return;
            }
            received = wake_rx.recv() => {
                if received.is_none() {
                    return;
                }
            }
        }
        cursors = sweep_off_thread(&ctx, cursors).await;
    }
}

/// Run one [`sweep`] on a blocking thread: it reads files and writes the
/// ledger, neither of which belongs on the async runtime.
async fn sweep_off_thread(
    ctx: &WorkLogContext,
    cursors: HashMap<PathBuf, u64>,
) -> HashMap<PathBuf, u64> {
    let roots: Vec<PathBuf> = ctx
        .registry
        .project_dirs()
        .into_iter()
        .map(|(root, _)| root)
        .collect();
    let ledger = Arc::clone(&ctx.sessions);
    let fallback = cursors.clone();
    match tokio::task::spawn_blocking(move || {
        let mut cursors = cursors;
        sweep(&ledger, &Paths::from_env(), &roots, &mut cursors);
        cursors
    })
    .await
    {
        Ok(cursors) => cursors,
        Err(err) => {
            warn!(error = %err, "work-log sweep failed");
            fallback
        }
    }
}

/// Read what each project's log has grown by and record a fact per line.
/// Returns how many facts were recorded.
fn sweep(
    ledger: &SessionLedger,
    paths: &Paths,
    roots: &[PathBuf],
    cursors: &mut HashMap<PathBuf, u64>,
) -> usize {
    let mut recorded = 0;
    let mut bound: Option<HashMap<String, String>> = None;
    for root in roots {
        let path = tugarc_core::work_log::work_log_path(paths, root);
        let fresh = match read_fresh_lines(&path, cursors) {
            Ok(text) => text,
            Err(err) => {
                debug!(path = %path.display(), error = %err, "work log unreadable");
                continue;
            }
        };
        for line in tugarc_core::work_log::read_lines(&fresh) {
            let bound =
                bound.get_or_insert_with(|| ledger.bound_session_by_arc().unwrap_or_default());
            let Some(session) = session_for(ledger, root, &line, bound) else {
                continue;
            };
            let fact = crate::feeds::facts_library::work_fact(&line, session.as_deref());
            match ledger.record_fact(&fact) {
                Ok(Some(_)) => recorded += 1,
                Ok(None) => {}
                Err(err) => warn!(error = %err, line = %line.id, "work fact write failed"),
            }
        }
    }
    recorded
}

/// The session a line's fact is recorded under: `Some(None)` for an
/// app-scoped fact, `None` for a line to skip because its session belongs to
/// another instance's ledger.
fn session_for(
    ledger: &SessionLedger,
    root: &Path,
    line: &WorkLine,
    bound: &HashMap<String, String>,
) -> Option<Option<String>> {
    let session = match (&line.session, &line.object) {
        (Some(session), _) => Some(session.clone()),
        (None, WorkObject::Arc { arc, .. }) if is_arc_kind(line.kind) => {
            let key = tugarc_core::ops::arc_owner_key(root, arc);
            bound.get(&key).cloned()
        }
        (None, _) => None,
    };
    match session {
        None => Some(None),
        Some(session) => match ledger.get(&session) {
            Ok(Some(_)) => Some(Some(session)),
            _ => None,
        },
    }
}

fn is_arc_kind(kind: WorkKind) -> bool {
    matches!(
        kind,
        WorkKind::ArcOpened | WorkKind::ArcJoined | WorkKind::ArcDiscarded
    )
}

/// The complete lines a log has grown by since the cursor, as one string.
///
/// A log seen for the first time reads from zero. Bytes after the last
/// newline are half a line and wait for the next wake; a log that shrank was
/// replaced, and the cursor moves to its end.
fn read_fresh_lines(path: &Path, cursors: &mut HashMap<PathBuf, u64>) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};

    let length = match std::fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(err) => return Err(err),
    };
    let cursor = cursors.get(path).copied().unwrap_or(0);
    if length < cursor {
        cursors.insert(path.to_path_buf(), length);
        return Ok(String::new());
    }
    if length == cursor {
        return Ok(String::new());
    }
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(cursor))?;
    let mut tail = String::new();
    file.take(length - cursor).read_to_string(&mut tail)?;
    let Some(last) = tail.rfind('\n') else {
        return Ok(String::new());
    };
    let complete = &tail[..=last];
    cursors.insert(path.to_path_buf(), cursor + complete.len() as u64);
    Ok(complete.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::facts_library::work_fact;
    use tugarc_core::work_log::{By, Privacy};

    fn ledger_with(sessions: &[&str]) -> SessionLedger {
        let l = SessionLedger::open_in_memory().expect("ledger");
        for (i, s) in sessions.iter().enumerate() {
            l.record_spawn(
                s,
                "ws",
                "/proj",
                &format!("card-{i}"),
                1_000,
                &format!("line-{i}"),
                None,
            )
            .unwrap();
        }
        l
    }

    /// The work facts in the ledger, leaving out the session facts a spawn
    /// records on its own.
    fn work_facts(ledger: &SessionLedger) -> Vec<crate::session_ledger::FactRow> {
        ledger
            .facts_after(0, 100)
            .unwrap()
            .into_iter()
            .filter(|f| WorkKind::ALL.iter().any(|k| k.as_str() == f.kind))
            .collect()
    }

    fn line(kind: WorkKind, object: WorkObject, detail: serde_json::Value) -> WorkLine {
        WorkLine {
            v: tugarc_core::work_log::WORK_LOG_VERSION,
            id: format!("{:016x}", kind as u8 as u64 + 1),
            at: "2026-11-27T10:00:00.000Z".into(),
            kind,
            session: Some("sess-a".into()),
            turn: None,
            object,
            detail,
        }
    }

    #[test]
    fn each_kind_records_one_fact_with_its_sentence_and_never_twice() {
        let ledger = ledger_with(&["sess-a"]);
        let cycle = || WorkObject::Cycle {
            cycle: "3f9a1c2e".into(),
            n: 2,
        };
        let arc = || WorkObject::Arc {
            arc: "alpha".into(),
            created: None,
        };
        let cases = [
            (
                line(
                    WorkKind::SketchRecorded,
                    WorkObject::Sketch {
                        sketch: "0a1b2c3d".into(),
                    },
                    serde_json::json!({ "version": 3 }),
                ),
                "sketch 0a1b2c3d recorded, version 3",
            ),
            (
                line(
                    WorkKind::BriefRecorded,
                    WorkObject::Brief {
                        brief: "11223344".into(),
                    },
                    serde_json::json!({ "path": "briefs/a.md", "title": "The store" }),
                ),
                "brief The store recorded at briefs/a.md",
            ),
            (
                line(
                    WorkKind::BriefCommitted,
                    WorkObject::Brief {
                        brief: "11223344".into(),
                    },
                    serde_json::json!({ "path": "briefs/a.md", "sha": "302d43b5d1aa" }),
                ),
                "brief briefs/a.md committed in 302d43b5",
            ),
            (
                line(
                    WorkKind::ArcQueued,
                    cycle(),
                    serde_json::json!({ "arc": "alpha", "brief": "11223344" }),
                ),
                "arc alpha queued as entry 2 of cycle 3f9a1c2e",
            ),
            (
                line(WorkKind::ArcOpened, arc(), serde_json::json!({})),
                "arc alpha opened",
            ),
            (
                line(
                    WorkKind::ArcJoined,
                    arc(),
                    serde_json::json!({ "sha": "302d43b5d1" }),
                ),
                "arc alpha joined",
            ),
            (
                line(WorkKind::ArcDiscarded, arc(), serde_json::json!({})),
                "arc alpha discarded",
            ),
            (
                line(
                    WorkKind::EntryDropped,
                    cycle(),
                    serde_json::json!({ "brief": "briefs/a.md" }),
                ),
                "entry 2 of cycle 3f9a1c2e dropped",
            ),
            (
                line(
                    WorkKind::ArcsStated,
                    WorkObject::Stated {
                        stated: "sess-a".into(),
                    },
                    serde_json::json!({ "arcs": ["alpha", "beta"], "source": "fence" }),
                ),
                "2 arcs stated",
            ),
        ];
        assert_eq!(cases.len(), WorkKind::ALL.len(), "every kind is covered");
        for (line, text) in &cases {
            let fact = work_fact(line, line.session.as_deref());
            assert_eq!(fact.kind, line.kind.as_str());
            assert_eq!(fact.text, *text);
            assert!(
                ledger.record_fact(&fact).unwrap().is_some(),
                "{text} records"
            );
            assert!(
                ledger.record_fact(&fact).unwrap().is_none(),
                "{text} records once"
            );
        }
        assert_eq!(work_facts(&ledger).len(), cases.len());
    }

    #[test]
    fn a_private_session_and_another_instances_session_leave_no_fact() {
        let data = tempfile::tempdir().unwrap();
        let paths = Paths::under(data.path());
        let repo = tempfile::tempdir().unwrap();
        let root = tugcore::pathform::resolve_to_claude_form(repo.path());
        let ledger = ledger_with(&["sess-a", "sess-p"]);
        ledger.set_session_private("sess-p", true).unwrap();
        let by = |s: &str| By {
            session: Some(s.into()),
            turn: None,
            privacy: Privacy::Unknown,
            segments: Vec::new(),
        };
        for session in ["sess-p", "sess-elsewhere", "sess-a"] {
            tugarc_core::work_log::append(
                &paths,
                &root,
                WorkKind::SketchRecorded,
                WorkObject::Sketch {
                    sketch: "0a1b2c3d".into(),
                },
                serde_json::json!({ "version": 1 }),
                &by(session),
            )
            .unwrap();
        }
        let mut cursors = HashMap::new();
        assert_eq!(
            sweep(&ledger, &paths, std::slice::from_ref(&root), &mut cursors),
            1
        );
        let facts = work_facts(&ledger);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].session_id.as_deref(), Some("sess-a"));
    }

    #[test]
    fn a_sweep_reads_each_line_once_and_an_arc_line_takes_its_bound_session() {
        let data = tempfile::tempdir().unwrap();
        let paths = Paths::under(data.path());
        let repo = tempfile::tempdir().unwrap();
        let root = tugcore::pathform::resolve_to_claude_form(repo.path());
        let ledger = ledger_with(&["sess-a"]);
        let append = |n: u32| {
            tugarc_core::work_log::append(
                &paths,
                &root,
                WorkKind::SketchRecorded,
                WorkObject::Sketch {
                    sketch: "0a1b2c3d".into(),
                },
                serde_json::json!({ "version": n }),
                &By {
                    session: Some("sess-a".into()),
                    turn: None,
                    privacy: Privacy::Public,
                    segments: Vec::new(),
                },
            )
            .unwrap()
        };
        for n in 1..=3 {
            append(n);
        }
        let mut cursors = HashMap::new();
        let roots = [root.clone()];
        assert_eq!(sweep(&ledger, &paths, &roots, &mut cursors), 3);
        assert_eq!(
            sweep(&ledger, &paths, &roots, &mut cursors),
            0,
            "nothing new"
        );
        append(4);
        append(5);
        assert_eq!(
            sweep(&ledger, &paths, &roots, &mut cursors),
            2,
            "only the two new lines"
        );
        assert_eq!(work_facts(&ledger).len(), 5);

        // A log read again from its start records nothing twice.
        assert_eq!(sweep(&ledger, &paths, &roots, &mut HashMap::new()), 0);

        // An arc line names no session: an arc bound to none here records
        // app-scoped.
        tugarc_core::work_log::append(
            &paths,
            &root,
            WorkKind::ArcOpened,
            WorkObject::Arc {
                arc: "alpha".into(),
                created: None,
            },
            serde_json::json!({}),
            &By::none(),
        )
        .unwrap();
        assert_eq!(sweep(&ledger, &paths, &roots, &mut cursors), 1);
        let facts = work_facts(&ledger);
        let opened = facts.iter().find(|f| f.kind == "arc.opened").unwrap();
        assert_eq!(opened.session_id, None);
    }

    #[test]
    fn the_watched_name_is_the_work_log() {
        assert_eq!(WORK_LOG, "work-log.jsonl");
        assert!(moves_a_log(Path::new("/data/projects/abc/work-log.jsonl")));
        assert!(!moves_a_log(Path::new(
            "/data/projects/abc/work-log.jsonl.lock"
        )));
    }
}
