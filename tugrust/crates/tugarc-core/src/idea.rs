//! The idea store: a one-line idea as a record of its own.
//!
//! An idea is the seed of a line of work, written on a docket before anything
//! has been made from it. It lives outside any docket so it can move between
//! dockets and outlive one, as a sketch does:
//!
//! ```text
//! <project_state_dir>/ideas/
//!     .lock          flock target, empty
//!     <id>/idea.json
//! ```
//!
//! The id is eight lowercase hex characters, unique across every checkout's
//! store under the data root. `sessions` lists the conversations the idea was
//! sketched in, oldest first. Every write goes through a dot-named sibling
//! renamed into place under an exclusive `flock` on `ideas/.lock`, and nothing
//! deletes an idea.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::error::ArcError;
use crate::sketch::{project_dir_of, write_atomically};

/// The record file in an idea's directory.
pub const IDEA_JSON: &str = "idea.json";

/// The longest an idea's one line may be, in characters.
pub const IDEA_TEXT_LIMIT: usize = 300;

/// A conversation an idea was sketched in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdeaSession {
    pub uuid: String,
    pub at: String,
}

/// An idea's record: its `idea.json`, and where it lies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdeaRecord {
    pub id: String,
    pub created: String,
    /// The checkout the idea belongs to. Stored because a state dir's name
    /// cannot be turned back into a path.
    pub project_dir: String,
    /// The one line that says what the idea is.
    pub text: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub sessions: Vec<IdeaSession>,
    /// Where the idea came from when the user did not type it: a brief
    /// decision a Keep going filed, or an audit follow-up accepted. `None`
    /// for an idea the user wrote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<IdeaOrigin>,
    /// The record's directory. Read from where it was found, never stored.
    #[serde(skip)]
    pub dir: PathBuf,
}

/// The arc an idea was filed from, and what of it the idea carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdeaOrigin {
    pub arc: String,
    /// The arc generation's start.
    pub created: String,
    pub kind: IdeaOriginKind,
}

/// What of an arc an idea carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IdeaOriginKind {
    /// An audit follow-up the user accepted.
    FollowUp { k: u32 },
    /// A decision a newer brief version added, filed by a Keep going.
    BriefDecision { label: String, version: u32 },
}

/// `<project_state_dir>/ideas`.
pub fn idea_root(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join("ideas")
}

/// Make an idea in this checkout from its one line and an optional body.
///
/// The line is trimmed, and refused when empty, longer than
/// [`IDEA_TEXT_LIMIT`] characters, or more than one line.
pub fn create_idea(
    paths: &Paths,
    repo: &Path,
    text: &str,
    body: Option<&str>,
) -> Result<IdeaRecord, ArcError> {
    create_idea_from(paths, repo, text, body, None)
}

/// [`create_idea`], naming the arc the idea was filed from.
pub fn create_idea_from(
    paths: &Paths,
    repo: &Path,
    text: &str,
    body: Option<&str>,
    origin: Option<IdeaOrigin>,
) -> Result<IdeaRecord, ArcError> {
    let text = clean_text(text)?;
    let body = body
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_owned);
    let root = idea_root(paths, repo);
    let _lock = crate::docket::flock_in(&root, "idea")?;
    let id = mint_id(paths);
    let dir = root.join(&id);
    let record = IdeaRecord {
        id,
        created: now_iso8601(),
        project_dir: project_dir_of(repo),
        text,
        body,
        sessions: Vec::new(),
        origin,
        dir,
    };
    write_record(&record)?;
    Ok(record)
}

/// Record that the idea was sketched in session `uuid`. A uuid the idea
/// already lists is recorded once.
pub fn add_session(
    paths: &Paths,
    repo: &Path,
    id: &str,
    uuid: &str,
) -> Result<IdeaRecord, ArcError> {
    let uuid = uuid.trim();
    if uuid.is_empty() || uuid.chars().any(char::is_whitespace) {
        return Err(ArcError::Refused(format!(
            "\"{uuid}\" is not a session id."
        )));
    }
    let root = idea_root(paths, repo);
    let _lock = crate::docket::flock_in(&root, "idea")?;
    let mut record = idea_in(paths, repo, id).ok_or_else(|| no_idea(id))?;
    if !record.sessions.iter().any(|s| s.uuid == uuid) {
        record.sessions.push(IdeaSession {
            uuid: uuid.to_string(),
            at: now_iso8601(),
        });
        write_record(&record)?;
    }
    Ok(record)
}

/// Every record of `id` under the data root, each with the project state dir
/// it was found in. More than one is an ambiguity the caller reports.
pub fn find_idea(paths: &Paths, id: &str) -> Vec<(PathBuf, IdeaRecord)> {
    if !valid_id(id) {
        return Vec::new();
    }
    let projects = paths.base_data_dir.join("projects");
    let Ok(read) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, IdeaRecord)> = read
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter_map(|state| {
            let record = read_record(&state.join("ideas").join(id))?;
            Some((state, record))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// The idea `id` when this checkout holds it.
pub fn idea_in(paths: &Paths, repo: &Path, id: &str) -> Option<IdeaRecord> {
    if !valid_id(id) {
        return None;
    }
    read_record(&idea_root(paths, repo).join(id))
}

/// This checkout's ideas, the newest first.
pub fn ideas(paths: &Paths, repo: &Path) -> Vec<IdeaRecord> {
    let Ok(read) = fs::read_dir(idea_root(paths, repo)) else {
        return Vec::new();
    };
    let mut all: Vec<IdeaRecord> = read
        .filter_map(|e| e.ok())
        .filter(|e| valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| read_record(&e.path()))
        .collect();
    all.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
    all
}

/// An id is eight lowercase hex characters, which also keeps it from naming
/// anything but a directory under `ideas/`.
pub fn valid_id(id: &str) -> bool {
    id.len() == 8 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// A fresh id no checkout's idea store under the data root already holds.
fn mint_id(paths: &Paths) -> String {
    loop {
        let id = format!("{:08x}", rand::random::<u32>());
        if find_idea(paths, &id).is_empty() {
            return id;
        }
    }
}

fn clean_text(text: &str) -> Result<String, ArcError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ArcError::Refused("An idea needs a line of text.".into()));
    }
    if text.contains(['\n', '\r']) {
        return Err(ArcError::Refused(
            "An idea is one line; put the rest in its body.".into(),
        ));
    }
    if text.chars().count() > IDEA_TEXT_LIMIT {
        return Err(ArcError::Refused(format!(
            "An idea's line is at most {IDEA_TEXT_LIMIT} characters; put the rest in its body."
        )));
    }
    Ok(text.to_string())
}

fn no_idea(id: &str) -> ArcError {
    ArcError::Refused(format!("No idea {id} in this checkout."))
}

fn read_record(dir: &Path) -> Option<IdeaRecord> {
    let text = fs::read_to_string(dir.join(IDEA_JSON)).ok()?;
    let mut record: IdeaRecord = serde_json::from_str(&text).ok()?;
    record.dir = dir.to_path_buf();
    Some(record)
}

fn write_record(record: &IdeaRecord) -> Result<(), ArcError> {
    fs::create_dir_all(&record.dir)
        .map_err(|e| ArcError::io("could not create the idea", &record.dir, e))?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| ArcError::Refused(format!("could not serialize {IDEA_JSON}: {e}")))?;
    write_atomically(&record.dir.join(IDEA_JSON), (json + "\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn scratch() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        (temp, repo, paths)
    }

    #[test]
    fn create_refuses_empty_multi_line_and_overlong_text() {
        let (_t, repo, paths) = scratch();
        for bad in ["", "   ", "one\ntwo", &"x".repeat(IDEA_TEXT_LIMIT + 1)] {
            let err = create_idea(&paths, &repo, bad, None).unwrap_err();
            assert!(matches!(err, ArcError::Refused(_)), "{bad:?}: {err:?}");
        }
        assert!(ideas(&paths, &repo).is_empty(), "nothing was written");

        let made = create_idea(
            &paths,
            &repo,
            &format!("  {}  ", "x".repeat(IDEA_TEXT_LIMIT)),
            Some("  the rest  "),
        )
        .unwrap();
        assert_eq!(made.text.chars().count(), IDEA_TEXT_LIMIT, "trimmed");
        assert_eq!(made.body.as_deref(), Some("the rest"));
        assert!(valid_id(&made.id));
        assert_eq!(idea_in(&paths, &repo, &made.id), Some(made));
    }

    #[test]
    fn ids_are_unique_across_checkouts_and_found_from_anywhere() {
        let temp = TempDir::new().unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();

        let mut ids = std::collections::BTreeSet::new();
        for i in 0..20 {
            let repo = if i % 2 == 0 { &a } else { &b };
            let made = create_idea(&paths, repo, &format!("idea {i}"), None).unwrap();
            assert!(ids.insert(made.id.clone()), "a repeated id");
            let found = find_idea(&paths, &made.id);
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].1.text, format!("idea {i}"));
        }
        assert_eq!(ideas(&paths, &a).len(), 10);
        assert_eq!(ideas(&paths, &b).len(), 10);
        assert!(find_idea(&paths, "../etc").is_empty());
    }

    #[test]
    fn ideas_list_newest_first() {
        let (_t, repo, paths) = scratch();
        let first = create_idea(&paths, &repo, "first", None).unwrap();
        let mut second = create_idea(&paths, &repo, "second", None).unwrap();
        // Two ideas made in one second share a stamp; date the second later.
        second.created = "2999-01-01T00:00:00Z".into();
        write_record(&second).unwrap();
        let listed: Vec<String> = ideas(&paths, &repo).into_iter().map(|i| i.id).collect();
        assert_eq!(listed, vec![second.id, first.id]);
    }

    #[test]
    fn add_session_records_a_uuid_once() {
        let (_t, repo, paths) = scratch();
        let made = create_idea(&paths, &repo, "sketch me", None).unwrap();
        add_session(&paths, &repo, &made.id, "u-1").unwrap();
        let again = add_session(&paths, &repo, &made.id, "u-1").unwrap();
        assert_eq!(again.sessions.len(), 1);
        let more = add_session(&paths, &repo, &made.id, "u-2").unwrap();
        let uuids: Vec<&str> = more.sessions.iter().map(|s| s.uuid.as_str()).collect();
        assert_eq!(uuids, vec!["u-1", "u-2"], "oldest first");
        assert!(add_session(&paths, &repo, "00000000", "u-3").is_err());
        assert!(add_session(&paths, &repo, &made.id, "  ").is_err());
    }

    #[test]
    fn concurrent_add_session_keeps_every_uuid() {
        let (_t, repo, paths) = scratch();
        let made = create_idea(&paths, &repo, "busy", None).unwrap();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let paths = paths.clone();
                let repo = repo.clone();
                let id = made.id.clone();
                std::thread::spawn(move || {
                    add_session(&paths, &repo, &id, &format!("u-{i}")).unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let read = idea_in(&paths, &repo, &made.id).unwrap();
        assert_eq!(read.sessions.len(), 8, "{:?}", read.sessions);
    }

    #[test]
    fn nothing_in_the_store_removes_a_file_or_a_directory() {
        let source = include_str!("idea.rs");
        let body = source.split("#[cfg(test)]").next().unwrap();
        for call in [concat!("remove", "_dir"), concat!("remove", "_file")] {
            assert!(!body.contains(call), "the idea store calls {call}");
        }
    }
}
