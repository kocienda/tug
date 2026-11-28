//! The work log: one JSON line for each change to a sketch, a brief, a queued
//! arc or an arc.
//!
//! ```text
//! <project_state_dir>/work-log.jsonl
//! ```
//!
//! Every verb that changes one of those records runs in a `tugtool` process,
//! and tugcast is the only writer of the facts ledger, so the record writers
//! say what changed here and tugcast follows the file into facts. A line is
//! evidence, never the decision: the record is the decision, so an append that
//! fails is reported by its caller and never fails the record write it
//! follows.
//!
//! Each line carries an id of its own, which becomes the fact's dedupe key,
//! so a follower that reads the file again from its start records nothing
//! twice.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::error::ArcError;
use crate::record_lock::{LockMode, hold};

/// The log's file name, beside the arc log in the project state dir.
pub const WORK_LOG: &str = "work-log.jsonl";

/// The file a writer of the work log locks for its one write.
const WORK_LOG_LOCK: &str = "work-log.jsonl.lock";

/// The line format's version.
pub const WORK_LOG_VERSION: u32 = 1;

/// What changed. Each kind is one fact kind of the same spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkKind {
    #[serde(rename = "sketch.recorded")]
    SketchRecorded,
    #[serde(rename = "brief.recorded")]
    BriefRecorded,
    #[serde(rename = "brief.committed")]
    BriefCommitted,
    #[serde(rename = "arc.queued")]
    ArcQueued,
    #[serde(rename = "arc.opened")]
    ArcOpened,
    #[serde(rename = "arc.joined")]
    ArcJoined,
    #[serde(rename = "arc.discarded")]
    ArcDiscarded,
    #[serde(rename = "entry.dropped")]
    EntryDropped,
    #[serde(rename = "arcs.stated")]
    ArcsStated,
}

impl WorkKind {
    /// Every kind, in the order they are documented.
    pub const ALL: [WorkKind; 9] = [
        WorkKind::SketchRecorded,
        WorkKind::BriefRecorded,
        WorkKind::BriefCommitted,
        WorkKind::ArcQueued,
        WorkKind::ArcOpened,
        WorkKind::ArcJoined,
        WorkKind::ArcDiscarded,
        WorkKind::EntryDropped,
        WorkKind::ArcsStated,
    ];

    /// The kind as it is spelled on the line and as a fact kind.
    pub fn as_str(self) -> &'static str {
        match self {
            WorkKind::SketchRecorded => "sketch.recorded",
            WorkKind::BriefRecorded => "brief.recorded",
            WorkKind::BriefCommitted => "brief.committed",
            WorkKind::ArcQueued => "arc.queued",
            WorkKind::ArcOpened => "arc.opened",
            WorkKind::ArcJoined => "arc.joined",
            WorkKind::ArcDiscarded => "arc.discarded",
            WorkKind::EntryDropped => "entry.dropped",
            WorkKind::ArcsStated => "arcs.stated",
        }
    }
}

/// The one record a line is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorkObject {
    Sketch {
        sketch: String,
    },
    Brief {
        brief: String,
    },
    Cycle {
        cycle: String,
        n: u32,
    },
    /// An arc by its name and its generation's start, since a name can be
    /// reused once a generation ends.
    Arc {
        arc: String,
        created: Option<String>,
    },
    /// A session's arc statement, by the session that stated it.
    Stated {
        stated: String,
    },
}

/// One line of the work log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkLine {
    pub v: u32,
    /// Sixteen lowercase hex characters; the fact's dedupe key is `work:<id>`.
    pub id: String,
    pub at: String,
    pub kind: WorkKind,
    /// The session that caused the change, when one did.
    pub session: Option<String>,
    /// The turn of that session, when it is known.
    pub turn: Option<u32>,
    pub object: WorkObject,
    /// A few small fields per kind. Never a file's body.
    pub detail: serde_json::Value,
}

/// How much of a session may be kept as a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Privacy {
    /// The session is public: its turns and their words may be kept.
    Public,
    /// The session is private: nothing of it is kept on a record.
    Private,
    /// Nothing said which; its session and turn are kept, never its words.
    #[default]
    Unknown,
}

/// Who caused a change: a session, its turn, and how private it is.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct By {
    pub session: Option<String>,
    pub turn: Option<u32>,
    pub privacy: Privacy,
    /// Every other id the same session has worn: the id it was posted under
    /// and the earlier segments of its line. A `Source:` line names whichever
    /// id the session wore when the sketch was written, so a turn in any of
    /// them is the writer's own.
    pub segments: Vec<String>,
}

impl By {
    /// Whether `session` is the writer's own session, under any id it wore.
    pub fn is_own(&self, session: &str) -> bool {
        self.session.as_deref() == Some(session) || self.segments.iter().any(|s| s == session)
    }
}

impl By {
    /// No session caused the change.
    pub fn none() -> By {
        By::default()
    }
}

/// `<project_state_dir>/work-log.jsonl`.
pub fn work_log_path(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join(WORK_LOG)
}

/// Append one line saying `kind` happened to `object`, caused by `by`.
///
/// The session is written whatever the privacy, so the ledger's refusal of a
/// private session's fact applies to it. Returns the line written.
pub fn append(
    paths: &Paths,
    repo: &Path,
    kind: WorkKind,
    object: WorkObject,
    detail: serde_json::Value,
    by: &By,
) -> Result<WorkLine, ArcError> {
    crate::log::refuse_unredirected_temp_repo(paths, repo);
    let line = WorkLine {
        v: WORK_LOG_VERSION,
        id: format!("{:016x}", rand::random::<u64>()),
        at: now_iso8601(),
        kind,
        session: by.session.clone(),
        turn: by.turn,
        object,
        detail,
    };
    let mut text = serde_json::to_string(&line)
        .map_err(|e| ArcError::Refused(format!("could not serialize a work-log line: {e}")))?;
    text.push('\n');

    let dir = project_state_dir_at(paths, repo);
    fs::create_dir_all(&dir).map_err(|e| ArcError::io("could not create the state dir", &dir, e))?;
    let _held = hold(&dir, WORK_LOG_LOCK, LockMode::Wait)?;
    let path = dir.join(WORK_LOG);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| ArcError::io("could not open the work log", &path, e))?;
    file.write_all(text.as_bytes())
        .map_err(|e| ArcError::io("could not write the work log", &path, e))?;
    Ok(line)
}

/// Every line of `text` that parses, in order; a line that does not is
/// skipped.
pub fn read_lines(text: &str) -> Vec<WorkLine> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use tempfile::TempDir;

    fn scratch() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        (temp, repo, paths)
    }

    #[test]
    fn writers_at_once_each_keep_every_line() {
        let (_t, repo, paths) = scratch();
        std::thread::scope(|scope| {
            for t in 0..8 {
                let (paths, repo) = (&paths, &repo);
                scope.spawn(move || {
                    for i in 0..50 {
                        let by = By {
                            session: Some(format!("s{t}")),
                            turn: Some(i),
                            privacy: Privacy::Public,
                            segments: Vec::new(),
                        };
                        append(
                            paths,
                            repo,
                            WorkKind::SketchRecorded,
                            WorkObject::Sketch {
                                sketch: "3f9a1c2e".into(),
                            },
                            serde_json::json!({ "version": i }),
                            &by,
                        )
                        .unwrap();
                    }
                });
            }
        });
        let text = fs::read_to_string(work_log_path(&paths, &repo)).unwrap();
        assert_eq!(text.lines().count(), 400);
        let lines = read_lines(&text);
        assert_eq!(lines.len(), 400, "every line parses");
        let ids: BTreeSet<&str> = lines.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids.len(), 400, "every id is distinct");
    }

    #[test]
    fn a_line_carries_exactly_its_fields_and_round_trips() {
        let line = WorkLine {
            v: 1,
            id: "9c1e0f2aa3b4c5d6".into(),
            at: "2026-11-27T21:23:40.405Z".into(),
            kind: WorkKind::BriefCommitted,
            session: Some("048e4155-f644-46f7-a839-d22ac02a564f".into()),
            turn: None,
            object: WorkObject::Brief {
                brief: "3f9a1c2e".into(),
            },
            detail: serde_json::json!({ "sha": "63de5762a1", "path": "briefs/x-brief.md" }),
        };
        let text = serde_json::to_string(&line).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let keys: BTreeSet<&str> = value.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(
            keys,
            ["v", "id", "at", "kind", "session", "turn", "object", "detail"]
                .into_iter()
                .collect()
        );
        assert_eq!(value["kind"], "brief.committed");
        assert_eq!(value["turn"], serde_json::Value::Null);
        assert_eq!(value["object"], serde_json::json!({ "brief": "3f9a1c2e" }));
        assert_eq!(read_lines(&text), vec![line]);
    }

    #[test]
    fn each_object_shape_reads_back_as_itself() {
        let objects = [
            WorkObject::Sketch {
                sketch: "aaaaaaaa".into(),
            },
            WorkObject::Brief {
                brief: "bbbbbbbb".into(),
            },
            WorkObject::Cycle {
                cycle: "cccccccc".into(),
                n: 3,
            },
            WorkObject::Arc {
                arc: "gpu-wedge".into(),
                created: Some("2026-11-22T14:59:33.128Z".into()),
            },
            WorkObject::Stated {
                stated: "048e4155-f644-46f7-a839-d22ac02a564f".into(),
            },
        ];
        for object in objects {
            let text = serde_json::to_string(&object).unwrap();
            assert_eq!(serde_json::from_str::<WorkObject>(&text).unwrap(), object);
        }
    }

    #[test]
    fn every_kind_spells_itself_the_same_on_the_line() {
        for kind in WorkKind::ALL {
            let text = serde_json::to_string(&kind).unwrap();
            assert_eq!(text, format!("\"{}\"", kind.as_str()));
        }
    }

    #[test]
    fn a_line_that_does_not_parse_is_skipped() {
        let good = r#"{"v":1,"id":"0000000000000001","at":"2026-11-27T00:00:00Z","kind":"arc.opened","session":null,"turn":null,"object":{"arc":"x","created":null},"detail":{}}"#;
        let text = format!("{good}\nnot json\n{{\"v\":1}}\n\n{good}\n");
        let lines = read_lines(&text);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].kind, WorkKind::ArcOpened);
    }
}
