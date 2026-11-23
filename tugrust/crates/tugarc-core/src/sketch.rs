//! The sketch record: a sketch's own id, and every version of its text.
//!
//! An arc's `sketch.md` is the working copy the panels read. Each time a stage
//! writes it, `tugtool sketch record <arc>` keeps the text as a version under
//! the sketch's id, so a sketch can be named and read back after its arc has
//! gone:
//!
//! ```text
//! <project_state_dir>/sketches/<id>/
//!     sketch.json
//!     v1.md  v2.md  …
//! ```
//!
//! The id is eight lowercase hex characters, unique across every checkout's
//! store under the data root, and it belongs to the sketch rather than to any
//! arc. A sketch recorded for an arc is tied to it twice: an `arc-sketch <id>`
//! line in the arc log, written while the generation is open, and the store's
//! `arc` link (the arc's name and its generation's start), which is the whole
//! of the tie once the generation has ended. The text is stored whole and is
//! never given an id line or a header; the id lives outside the file.
//!
//! Each version records its author. A stage's version is the model's; a
//! version saved by hand in the Docket card is the user's, and no stage may
//! write over it: [`record_arc_sketch`] puts the user's text back and refuses.
//! Only [`keep_sketch`], which the user asks for, writes a model version after
//! a user one. A sketch kept from an idea names it, and the briefs written
//! from a sketch are kept on it as versions of their own, each with the
//! sketch version it came from and a snapshot of its bytes:
//!
//! ```text
//! <project_state_dir>/sketches/<id>/briefs/v1.md  v2.md  …
//! ```

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::archive::compact_stamp;
use crate::error::ArcError;
use crate::log::{
    append_arc_log, arc_has_ended, generation_sketch_id, generation_start, generation_started_at,
    validate_arc_name,
};
use crate::ops::{documents_dir, first_heading, main_repo_root, record_body};

/// The record file beside the versions.
pub const SKETCH_JSON: &str = "sketch.json";

/// What [`record_arc_sketch`] says when a stage tries to write over a version
/// the user wrote.
pub const USER_VERSION_REFUSAL: &str = "The sketch's latest version was written by the user, and a stage never rewrites it. sketch.md holds the user's text again; if it is out of date, stop and ask.";

/// The arc a sketch was recorded for: its name and its generation's start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchArc {
    pub name: String,
    /// The generation's start in the arc log's ISO form; `None` when the log
    /// never recorded the arc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

/// Who wrote a version: a stage (the model), or the user by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SketchAuthor {
    /// Every version recorded before authors were, too.
    #[default]
    Model,
    User,
}

/// The conversation a version was written from, read off its `Source:` line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchSource {
    pub session: String,
    /// The line's turn text verbatim: `1–8`, `3`.
    pub turns: String,
}

/// One kept version of a sketch's text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchVersion {
    pub n: u32,
    pub at: String,
    #[serde(default)]
    pub author: SketchAuthor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SketchSource>,
}

/// One kept version of a brief written from the sketch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BriefVersion {
    pub n: u32,
    pub at: String,
    /// The brief's file, relative to its checkout when it lies inside it.
    pub path: String,
    pub sha256: String,
    pub title: String,
    /// The sketch version the brief was written from.
    pub sketch_version: u32,
    /// The session that wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// A sketch's record: its `sketch.json`, and where it lies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchRecord {
    pub id: String,
    pub created: String,
    /// The checkout the sketch belongs to. Stored because a state dir's name
    /// cannot be turned back into a path.
    pub project_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc: Option<SketchArc>,
    /// The idea the sketch was kept from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea: Option<String>,
    #[serde(default)]
    pub versions: Vec<SketchVersion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub briefs: Vec<BriefVersion>,
    /// The record's directory. Read from where it was found, never stored.
    #[serde(skip)]
    pub dir: PathBuf,
}

impl SketchRecord {
    /// The newest version's number; 0 for a record with none.
    pub fn latest(&self) -> u32 {
        self.versions.iter().map(|v| v.n).max().unwrap_or(0)
    }

    /// The newest version, if there is one.
    pub fn latest_version(&self) -> Option<&SketchVersion> {
        self.versions.iter().max_by_key(|v| v.n)
    }

    /// The newest brief version, if there is one.
    pub fn latest_brief(&self) -> Option<&BriefVersion> {
        self.briefs.iter().max_by_key(|b| b.n)
    }

    /// When the newest version was written; the record's own creation for a
    /// record with none.
    pub fn updated(&self) -> &str {
        self.versions
            .iter()
            .max_by_key(|v| v.n)
            .map(|v| v.at.as_str())
            .unwrap_or(&self.created)
    }
}

/// What [`record_arc_sketch`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecordOutcome {
    pub id: String,
    /// The version the text now is.
    pub version: u32,
    /// Whether this call minted the id.
    pub minted: bool,
    /// Whether this call wrote a new version; `false` when the text was
    /// byte-identical to the latest.
    pub appended: bool,
}

/// `<project_state_dir>/sketches`.
pub fn sketch_root(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join("sketches")
}

/// Keep `.tug/arcs/<arc>/sketch.md` as the newest version of the arc's sketch.
///
/// The id is the newest generation's: the log's `arc-sketch` line for that
/// generation, else the store entry linked to this name and this generation's
/// start. When neither holds one, an id is minted, and while the generation
/// is still open its `arc-sketch` line is appended to the log. The text is
/// appended as a model version unless it is byte-identical to the latest.
///
/// `adopt` names a sketch already in this checkout's store — one kept from an
/// idea before the arc opened — and ties the arc's generation to it: the
/// generation's `arc-sketch` line is written while it is open, and the
/// record's `arc` link is set to it.
///
/// Every caller is a stage or the door, so when the latest version is the
/// user's and the working copy differs from it, the user's text is written
/// back to the working copy and the call is refused with
/// [`USER_VERSION_REFUSAL`]. Only [`keep_sketch`] writes over a user version.
pub fn record_arc_sketch(
    paths: &Paths,
    repo: &Path,
    arc: &str,
    adopt: Option<&str>,
) -> Result<RecordOutcome, ArcError> {
    validate_arc_name(arc).map_err(ArcError::InvalidName)?;
    let working = documents_dir(repo, arc).join("sketch.md");
    let text = fs::read_to_string(&working).map_err(|_| {
        ArcError::Refused(format!(
            "no sketch to record: .tug/arcs/{arc}/sketch.md does not exist"
        ))
    })?;
    crate::log::refuse_unredirected_temp_repo(paths, repo);

    let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
    let log = fs::read_to_string(&log_path).unwrap_or_default();
    let start = generation_started_at(&log, arc);
    let root = sketch_root(paths, repo);
    let link = SketchArc {
        name: arc.to_string(),
        created: start.clone(),
    };
    let ended = arc_has_ended(paths, repo, arc);

    let (id, minted) = match adopt {
        Some(id) => {
            if sketch_in(paths, repo, id).is_none() {
                return Err(no_sketch(id));
            }
            (id.to_string(), false)
        }
        None => {
            let known = generation_sketch_id(&log, arc).or_else(|| {
                records_in(&root)
                    .into_iter()
                    .find(|r| r.arc.as_ref() == Some(&link))
                    .map(|r| r.id)
            });
            match known {
                Some(id) if valid_id(&id) => (id, false),
                _ => (mint_id(paths), true),
            }
        }
    };

    let dir = root.join(&id);
    let mut record = match read_record(&dir) {
        Some(record) => record,
        None => SketchRecord {
            id: id.clone(),
            created: now_iso8601(),
            project_dir: project_dir_of(repo),
            arc: Some(link.clone()),
            idea: None,
            versions: Vec::new(),
            briefs: Vec::new(),
            dir: dir.clone(),
        },
    };
    restore_user_version(&record, &working, &text)?;

    let mut relinked = false;
    if adopt.is_some() {
        if !ended && generation_sketch_id(&log, arc).as_deref() != Some(id.as_str()) {
            append_arc_log(paths, repo, arc, "arc-sketch", &id).map_err(|e| {
                ArcError::Refused(format!("could not record the sketch in the arc log: {e}"))
            })?;
        }
        if record.arc.as_ref() != Some(&link) {
            record.arc = Some(link);
            relinked = true;
        }
    } else if minted && !ended {
        append_arc_log(paths, repo, arc, "arc-sketch", &id).map_err(|e| {
            ArcError::Refused(format!("could not record the sketch in the arc log: {e}"))
        })?;
    }

    let appended = push_version(&mut record, &text, SketchAuthor::Model, source_of(&text))?;
    if appended || relinked {
        save_record(&record)?;
    }
    Ok(RecordOutcome {
        version: record.latest(),
        id,
        minted,
        appended,
    })
}

/// Keep `text` as the newest version of the sketch kept from idea `idea_id`.
///
/// The user asks for this, so it is the one writer that may put a model
/// version after a user one. The idea must be in this checkout and the text
/// must name its source conversation on a `Source:` line. The idea's sketch is
/// its newest one, or one minted with the idea link and no arc. A sketch an
/// open arc holds has its working copy rewritten to match.
pub fn keep_sketch(
    paths: &Paths,
    repo: &Path,
    idea_id: &str,
    text: &str,
) -> Result<RecordOutcome, ArcError> {
    if crate::idea::idea_in(paths, repo, idea_id).is_none() {
        return Err(ArcError::Refused(format!(
            "No idea {idea_id} in this checkout."
        )));
    }
    let Some(source) = source_of(text) else {
        return Err(ArcError::Refused(
            "A sketch is kept from the conversation that shaped it; this text names none.".into(),
        ));
    };
    let root = sketch_root(paths, repo);
    let existing = records_in(&root)
        .into_iter()
        .filter(|r| r.idea.as_deref() == Some(idea_id))
        .max_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    let (mut record, minted) = match existing {
        Some(record) => (record, false),
        None => {
            let id = mint_id(paths);
            let record = SketchRecord {
                dir: root.join(&id),
                id,
                created: now_iso8601(),
                project_dir: project_dir_of(repo),
                arc: None,
                idea: Some(idea_id.to_string()),
                versions: Vec::new(),
                briefs: Vec::new(),
            };
            (record, true)
        }
    };
    let appended = push_version(&mut record, text, SketchAuthor::Model, Some(source))?;
    if appended {
        save_record(&record)?;
    }
    write_through(paths, repo, &record, text)?;
    Ok(RecordOutcome {
        id: record.id.clone(),
        version: record.latest(),
        minted,
        appended,
    })
}

/// Save `text`, written by hand, as the newest version of sketch `id`.
///
/// `base_version` is the version the editor opened on; when the sketch has
/// moved past it the save is refused rather than writing over the newer text.
/// A sketch an open arc holds has its working copy rewritten to match.
pub fn edit_sketch(
    paths: &Paths,
    repo: &Path,
    id: &str,
    text: &str,
    base_version: u32,
) -> Result<RecordOutcome, ArcError> {
    let mut record = sketch_in(paths, repo, id).ok_or_else(|| no_sketch(id))?;
    let latest = record.latest();
    if base_version != latest {
        return Err(ArcError::Refused(format!(
            "The sketch moved to v{latest} while you were editing."
        )));
    }
    if text.trim().is_empty() {
        return Err(ArcError::Refused("A sketch cannot be empty.".into()));
    }
    let appended = push_version(&mut record, text, SketchAuthor::User, None)?;
    if appended {
        save_record(&record)?;
    }
    write_through(paths, repo, &record, text)?;
    Ok(RecordOutcome {
        id: record.id.clone(),
        version: record.latest(),
        minted: false,
        appended,
    })
}

/// Keep the brief at `path` as the newest brief version of sketch
/// `sketch_id`, written from its version `from_version` by `session`.
///
/// The path is relative to `repo` or absolute, and names a `.md` file. Bytes
/// identical to the latest brief version append nothing and answer that
/// version.
pub fn record_brief(
    paths: &Paths,
    repo: &Path,
    sketch_id: &str,
    path: &Path,
    from_version: u32,
    session: Option<&str>,
) -> Result<BriefVersion, ArcError> {
    let mut record = sketch_in(paths, repo, sketch_id).ok_or_else(|| no_sketch(sketch_id))?;
    let file = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo.join(path)
    };
    if file.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err(ArcError::Refused(format!(
            "A brief is a .md file; {} is not.",
            path.display()
        )));
    }
    let text = fs::read_to_string(&file)
        .map_err(|e| ArcError::io("could not read the brief", &file, e))?;
    if !record.versions.iter().any(|v| v.n == from_version) {
        return Err(ArcError::Refused(format!(
            "sketch {sketch_id} has no version {from_version}"
        )));
    }
    let sha256 = hash_hex(&text);
    if let Some(latest) = record.latest_brief()
        && latest.sha256 == sha256
    {
        return Ok(latest.clone());
    }

    let n = record.briefs.iter().map(|b| b.n).max().unwrap_or(0) + 1;
    let dir = record.dir.join("briefs");
    fs::create_dir_all(&dir).map_err(|e| ArcError::io("could not keep the brief", &dir, e))?;
    write_atomically(&dir.join(format!("v{n}.md")), text.as_bytes())?;
    let version = BriefVersion {
        n,
        at: now_iso8601(),
        path: checkout_relative(repo, &file),
        sha256,
        title: first_heading(&text).unwrap_or_else(|| {
            file.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        }),
        sketch_version: from_version,
        session: session
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    };
    record.briefs.push(version.clone());
    save_record(&record)?;
    Ok(version)
}

/// One brief version's bytes, from its snapshot.
pub fn read_brief_version(record: &SketchRecord, n: u32) -> Result<String, ArcError> {
    if !record.briefs.iter().any(|b| b.n == n) {
        return Err(ArcError::Refused(format!(
            "sketch {} has no brief version {n}",
            record.id
        )));
    }
    let path = record.dir.join("briefs").join(format!("v{n}.md"));
    fs::read_to_string(&path).map_err(|e| ArcError::io("could not read the brief", &path, e))
}

/// The sketch in this checkout one of whose brief versions holds exactly the
/// bytes of the file at `path`, with that version's number.
pub fn sketch_for_brief(paths: &Paths, repo: &Path, path: &Path) -> Option<(SketchRecord, u32)> {
    let file = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo.join(path)
    };
    let sha256 = hash_hex(&fs::read_to_string(file).ok()?);
    sketches(paths, repo).into_iter().find_map(|record| {
        let n = record
            .briefs
            .iter()
            .filter(|b| b.sha256 == sha256)
            .map(|b| b.n)
            .max()?;
        Some((record, n))
    })
}

/// The conversation a sketch's text names on its last non-empty line:
/// `Source: session <uuid>, turns <turns>` (or `turn <n>`).
pub fn source_of(text: &str) -> Option<SketchSource> {
    let line = text.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    let rest = line.strip_prefix("Source:")?.trim();
    let rest = rest.strip_prefix("session")?.trim_start();
    let (session, turns) = rest.split_once(',')?;
    let turns = turns.trim();
    let turns = turns
        .strip_prefix("turns")
        .or_else(|| turns.strip_prefix("turn"))?
        .trim();
    let session = session.trim();
    if session.is_empty() || turns.is_empty() {
        return None;
    }
    Some(SketchSource {
        session: session.to_string(),
        turns: turns.to_string(),
    })
}

/// The sketch `id` when this checkout holds it.
pub fn sketch_in(paths: &Paths, repo: &Path, id: &str) -> Option<SketchRecord> {
    if !valid_id(id) {
        return None;
    }
    read_record(&sketch_root(paths, repo).join(id))
}

fn no_sketch(id: &str) -> ArcError {
    ArcError::Refused(format!("No sketch {id} in this checkout."))
}

/// When the latest version is the user's and `text` differs from it, put the
/// user's text back at `working` and refuse.
fn restore_user_version(record: &SketchRecord, working: &Path, text: &str) -> Result<(), ArcError> {
    let Some(latest) = record.latest_version() else {
        return Ok(());
    };
    if latest.author != SketchAuthor::User {
        return Ok(());
    }
    let kept = read_version(record, Some(latest.n))?;
    if kept == text {
        return Ok(());
    }
    write_atomically(working, kept.as_bytes())?;
    Err(ArcError::Refused(USER_VERSION_REFUSAL.into()))
}

/// Write `text` as the record's next version unless it is byte-identical to
/// the latest. Answers whether a version was written; the caller saves the
/// record.
fn push_version(
    record: &mut SketchRecord,
    text: &str,
    author: SketchAuthor,
    source: Option<SketchSource>,
) -> Result<bool, ArcError> {
    let latest = record.latest();
    if latest > 0 && read_version(record, Some(latest)).is_ok_and(|t| t == text) {
        return Ok(false);
    }
    fs::create_dir_all(&record.dir)
        .map_err(|e| ArcError::io("could not create the sketch", &record.dir, e))?;
    let n = latest + 1;
    write_atomically(&record.dir.join(format!("v{n}.md")), text.as_bytes())?;
    record.versions.push(SketchVersion {
        n,
        at: now_iso8601(),
        author,
        source,
    });
    Ok(true)
}

fn save_record(record: &SketchRecord) -> Result<(), ArcError> {
    fs::create_dir_all(&record.dir)
        .map_err(|e| ArcError::io("could not create the sketch", &record.dir, e))?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| ArcError::Refused(format!("could not serialize {SKETCH_JSON}: {e}")))?;
    write_atomically(&record.dir.join(SKETCH_JSON), (json + "\n").as_bytes())
}

/// Write `text` to the working copy of the arc the record is linked to, when
/// the link names that name's current generation, the generation is still
/// open, and its documents directory is there. A link to an older generation
/// of a reused name writes nothing.
fn write_through(
    paths: &Paths,
    repo: &Path,
    record: &SketchRecord,
    text: &str,
) -> Result<(), ArcError> {
    let Some(SketchArc {
        name,
        created: Some(created),
    }) = &record.arc
    else {
        return Ok(());
    };
    let Some(current) = generation_start(paths, repo, name) else {
        return Ok(());
    };
    if compact_stamp(created) != compact_stamp(&current) || arc_has_ended(paths, repo, name) {
        return Ok(());
    }
    let dir = documents_dir(repo, name);
    if !dir.is_dir() {
        return Ok(());
    }
    write_atomically(&dir.join("sketch.md"), text.as_bytes())
}

/// `file` relative to the checkout when it lies inside it, else as given.
fn checkout_relative(repo: &Path, file: &Path) -> String {
    let main = main_repo_root(repo);
    file.strip_prefix(repo)
        .or_else(|_| file.strip_prefix(&main))
        .unwrap_or(file)
        .to_string_lossy()
        .into_owned()
}

fn hash_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Every record of `id` under the data root, each with the project state dir
/// it was found in. More than one is an ambiguity the caller reports.
pub fn find_sketch(paths: &Paths, id: &str) -> Vec<(PathBuf, SketchRecord)> {
    if !valid_id(id) {
        return Vec::new();
    }
    let projects = paths.base_data_dir.join("projects");
    let Ok(read) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, SketchRecord)> = read
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter_map(|state| {
            let record = read_record(&state.join("sketches").join(id))?;
            Some((state, record))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// One version's text, verbatim; `None` reads the latest.
pub fn read_version(record: &SketchRecord, n: Option<u32>) -> Result<String, ArcError> {
    let n = n.unwrap_or_else(|| record.latest());
    if !record.versions.iter().any(|v| v.n == n) {
        return Err(ArcError::Refused(format!(
            "sketch {} has no version {n}",
            record.id
        )));
    }
    let path = record.dir.join(format!("v{n}.md"));
    fs::read_to_string(&path).map_err(|e| ArcError::io("could not read the sketch", &path, e))
}

/// This checkout's sketches, the most recently written first.
pub fn sketches(paths: &Paths, repo: &Path) -> Vec<SketchRecord> {
    let mut all = records_in(&sketch_root(paths, repo));
    all.sort_by(|a, b| b.updated().cmp(a.updated()));
    all
}

/// What a sketch says is wanted: the first paragraph of its body, with the
/// `# Sketch` heading and the `Source:` line taken off.
pub fn want_of(text: &str) -> Option<String> {
    let body = record_body(text)?;
    let first = body.split("\n\n").next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// An id is eight lowercase hex characters, which also keeps it from naming
/// anything but a directory under `sketches/`.
fn valid_id(id: &str) -> bool {
    id.len() == 8 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// A fresh id no checkout's store under the data root already holds.
fn mint_id(paths: &Paths) -> String {
    loop {
        let id = format!("{:08x}", rand::random::<u32>());
        if find_sketch(paths, &id).is_empty() {
            return id;
        }
    }
}

pub(crate) fn project_dir_of(repo: &Path) -> String {
    // [L29]: a persisted and compared path goes through the gateway, never a
    // bare `canonicalize`, whose firmlink-expanded `/System/Volumes/Data/…`
    // form matches no workspace key the deck holds.
    canonical_dir(&main_repo_root(repo))
}

fn canonical_dir(dir: &Path) -> String {
    tugcore::pathform::resolve_to_claude_form(dir)
        .to_string_lossy()
        .into_owned()
}

fn read_record(dir: &Path) -> Option<SketchRecord> {
    let text = fs::read_to_string(dir.join(SKETCH_JSON)).ok()?;
    let mut record: SketchRecord = serde_json::from_str(&text).ok()?;
    record.dir = dir.to_path_buf();
    // A record written under another spelling of its checkout reads back in
    // the gateway's, so every comparison against it is canonical to canonical.
    record.project_dir = canonical_dir(Path::new(&record.project_dir));
    Some(record)
}

fn records_in(root: &Path) -> Vec<SketchRecord> {
    let Ok(read) = fs::read_dir(root) else {
        return Vec::new();
    };
    read.filter_map(|e| e.ok())
        .filter(|e| valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| read_record(&e.path()))
        .collect()
}

/// Write through a dot-named sibling and rename it into place, so a reader
/// never sees half a file.
pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), ArcError> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| ArcError::io("could not write the sketch", &tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| ArcError::io("could not write the sketch", path, e))
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

    fn write_sketch(repo: &Path, arc: &str, text: &str) {
        let dir = documents_dir(repo, arc);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sketch.md"), text).unwrap();
    }

    fn log_append(paths: &Paths, repo: &Path, line: &str) {
        let log = tugtool_core::paths::arc_log_path_at(paths, repo);
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        let mut text = fs::read_to_string(&log).unwrap_or_default();
        text.push_str(line);
        text.push('\n');
        fs::write(log, text).unwrap();
    }

    fn log_text(paths: &Paths, repo: &Path) -> String {
        fs::read_to_string(tugtool_core::paths::arc_log_path_at(paths, repo)).unwrap_or_default()
    }

    fn sketch_lines(paths: &Paths, repo: &Path) -> usize {
        log_text(paths, repo)
            .lines()
            .filter(|l| l.contains("  arc-sketch  "))
            .count()
    }

    const V1: &str = "# Sketch\n\nWant the archive.\n\nSource: session abc, turns 1–3\n";
    const V2: &str =
        "# Sketch\n\nWant the archive, and the atoms.\n\nSource: session abc, turns 1–5\n";

    #[test]
    fn record_arc_sketch_mints_once_then_appends_only_changed_text() {
        let (_t, repo, paths) = scratch();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  sk  arc-start  brief.md",
        );
        write_sketch(&repo, "sk", V1);

        let first = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        assert!(first.minted && first.appended && first.version == 1);
        assert!(valid_id(&first.id));
        assert_eq!(sketch_lines(&paths, &repo), 1, "one arc-sketch line");

        let again = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        assert_eq!(again.id, first.id);
        assert!(!again.minted && !again.appended && again.version == 1);

        write_sketch(&repo, "sk", V2);
        let second = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        assert_eq!(second.id, first.id);
        assert!(second.appended && second.version == 2);
        assert_eq!(sketch_lines(&paths, &repo), 1);

        let found = find_sketch(&paths, &first.id);
        assert_eq!(found.len(), 1);
        let record = &found[0].1;
        assert_eq!(read_version(record, Some(1)).unwrap(), V1, "whole file");
        assert_eq!(read_version(record, None).unwrap(), V2);
        assert_eq!(
            record.arc,
            Some(SketchArc {
                name: "sk".into(),
                created: Some("2026-11-01T00:00:00Z".into()),
            })
        );
        assert_eq!(
            want_of(V2).as_deref(),
            Some("Want the archive, and the atoms.")
        );
    }

    #[test]
    fn a_reused_name_after_a_discard_mints_a_new_sketch() {
        let (_t, repo, paths) = scratch();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  sk  arc-start  brief.md",
        );
        write_sketch(&repo, "sk", V1);
        let first = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        log_append(&paths, &repo, "2026-11-01T01:00:00Z  sk  discarded");
        log_append(
            &paths,
            &repo,
            "2026-11-02T00:00:00Z  sk  arc-start  brief.md",
        );

        let reused = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        assert!(reused.minted);
        assert_ne!(reused.id, first.id);
        assert_eq!(sketch_lines(&paths, &repo), 2);
    }

    #[test]
    fn the_id_survives_a_terminal_line_and_nothing_is_written_after_it() {
        for ending in [
            vec!["2026-11-01T01:00:00Z  sk  discarded"],
            vec![
                "2026-11-01T01:00:00Z  sk  302d43b5d1  joined",
                "2026-11-01T02:00:00Z  sk  undone  join 302d43b5d1",
            ],
        ] {
            let (_t, repo, paths) = scratch();
            log_append(
                &paths,
                &repo,
                "2026-11-01T00:00:00Z  sk  arc-start  brief.md",
            );
            write_sketch(&repo, "sk", V1);
            let first = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
            for line in &ending {
                log_append(&paths, &repo, line);
            }
            write_sketch(&repo, "sk", V2);
            let after = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
            assert_eq!(after.id, first.id, "{ending:?}");
            assert!(!after.minted && after.version == 2);
            let log = log_text(&paths, &repo);
            let last = log.lines().last().unwrap();
            assert!(
                !last.contains("arc-sketch"),
                "nothing after the terminal line: {log}"
            );
        }
    }

    #[test]
    fn a_sketch_minted_after_its_generation_ended_is_found_by_its_arc_link() {
        let (_t, repo, paths) = scratch();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  sk  arc-start  brief.md",
        );
        log_append(&paths, &repo, "2026-11-01T01:00:00Z  sk  discarded");
        write_sketch(&repo, "sk", V1);

        let first = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        assert!(first.minted);
        assert_eq!(sketch_lines(&paths, &repo), 0, "no line after the end");
        write_sketch(&repo, "sk", V2);
        let again = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        assert_eq!(again.id, first.id);
        assert!(!again.minted && again.version == 2);
    }

    #[test]
    fn find_sketch_reports_another_checkouts_project_dir() {
        let temp = TempDir::new().unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        let repo = temp.path().join("src").join("my-tool");
        fs::create_dir_all(&repo).unwrap();
        let other = temp.path().join("src").join("other");
        fs::create_dir_all(&other).unwrap();
        write_sketch(&repo, "sk", V1);

        let made = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        let found = find_sketch(&paths, &made.id);
        assert_eq!(found.len(), 1);
        assert_eq!(
            PathBuf::from(&found[0].1.project_dir),
            tugcore::pathform::resolve_to_claude_form(&repo),
            "the hyphenated checkout path, read from the record"
        );
        assert!(
            sketches(&paths, &other).is_empty(),
            "the other checkout holds none"
        );
        assert_eq!(sketches(&paths, &repo).len(), 1);
        assert!(find_sketch(&paths, "../etc").is_empty());
    }

    #[test]
    fn record_without_a_sketch_file_is_refused() {
        let (_t, repo, paths) = scratch();
        let err = record_arc_sketch(&paths, &repo, "none", None).unwrap_err();
        assert!(matches!(err, ArcError::Refused(_)), "{err:?}");
    }

    fn working_copy(repo: &Path, arc: &str) -> String {
        fs::read_to_string(documents_dir(repo, arc).join("sketch.md")).unwrap()
    }

    fn idea(paths: &Paths, repo: &Path) -> String {
        crate::idea::create_idea(paths, repo, "Keep the idea", None)
            .unwrap()
            .id
    }

    const KEPT: &str = "# Sketch\n\nWant it kept.\n\nSource: session u-1, turns 1–8\n";
    const KEPT2: &str = "# Sketch\n\nWant it kept, twice.\n\nSource: session u-1, turns 1–9\n";
    const HAND: &str = "# Sketch\n\nWant it written by hand.\n";

    #[test]
    fn a_record_from_before_authors_reads_as_the_models() {
        let (_t, repo, paths) = scratch();
        let dir = sketch_root(&paths, &repo).join("0a1b2c3d");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("v1.md"), V1).unwrap();
        fs::write(
            dir.join(SKETCH_JSON),
            r#"{"id":"0a1b2c3d","created":"2026-11-01T00:00:00Z","project_dir":"/x",
               "versions":[{"n":1,"at":"2026-11-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let record = sketch_in(&paths, &repo, "0a1b2c3d").unwrap();
        assert_eq!(record.versions[0].author, SketchAuthor::Model);
        assert_eq!(record.versions[0].source, None);
        assert_eq!(record.idea, None);
        assert!(record.briefs.is_empty());
    }

    #[test]
    fn source_of_reads_turns_and_a_single_turn() {
        assert_eq!(
            source_of(KEPT),
            Some(SketchSource {
                session: "u-1".into(),
                turns: "1–8".into()
            })
        );
        assert_eq!(
            source_of("# Sketch\n\nWant.\n\nSource: session abc, turn 3\n\n"),
            Some(SketchSource {
                session: "abc".into(),
                turns: "3".into()
            })
        );
        assert_eq!(source_of(HAND), None);
        assert_eq!(source_of("Source: x\n"), None);
    }

    #[test]
    fn keep_sketch_mints_with_its_idea_then_appends() {
        let (_t, repo, paths) = scratch();
        let idea_id = idea(&paths, &repo);
        let first = keep_sketch(&paths, &repo, &idea_id, KEPT).unwrap();
        assert!(first.minted && first.appended && first.version == 1);
        let again = keep_sketch(&paths, &repo, &idea_id, KEPT).unwrap();
        assert!(!again.minted && !again.appended && again.version == 1);
        let second = keep_sketch(&paths, &repo, &idea_id, KEPT2).unwrap();
        assert_eq!(second.id, first.id);
        assert!(second.appended && second.version == 2);

        let record = sketch_in(&paths, &repo, &first.id).unwrap();
        assert_eq!(record.idea.as_deref(), Some(idea_id.as_str()));
        assert_eq!(record.arc, None);
        assert_eq!(record.versions[1].author, SketchAuthor::Model);
        assert_eq!(
            record.versions[1].source.as_ref().map(|s| s.turns.as_str()),
            Some("1–9")
        );
    }

    #[test]
    fn keep_sketch_refuses_a_text_with_no_source_and_an_unknown_idea() {
        let (_t, repo, paths) = scratch();
        let idea_id = idea(&paths, &repo);
        let err = keep_sketch(&paths, &repo, &idea_id, HAND).unwrap_err();
        assert!(
            matches!(err, ArcError::Refused(ref m) if m.contains("names none")),
            "{err:?}"
        );
        assert!(keep_sketch(&paths, &repo, "00000000", KEPT).is_err());
        assert!(sketches(&paths, &repo).is_empty(), "nothing was minted");
    }

    #[test]
    fn edit_sketch_appends_a_user_version_and_writes_the_open_arcs_copy() {
        let (_t, repo, paths) = scratch();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  sk  arc-start  brief.md",
        );
        write_sketch(&repo, "sk", V1);
        let made = record_arc_sketch(&paths, &repo, "sk", None).unwrap();

        let edited = edit_sketch(&paths, &repo, &made.id, HAND, 1).unwrap();
        assert!(edited.appended && edited.version == 2);
        assert_eq!(working_copy(&repo, "sk"), HAND);
        let record = sketch_in(&paths, &repo, &made.id).unwrap();
        assert_eq!(record.versions[1].author, SketchAuthor::User);
        assert_eq!(record.versions[1].source, None);

        let err = edit_sketch(&paths, &repo, &made.id, V2, 1).unwrap_err();
        assert!(
            matches!(err, ArcError::Refused(ref m) if m == "The sketch moved to v2 while you were editing."),
            "{err:?}"
        );
        assert_eq!(sketch_in(&paths, &repo, &made.id).unwrap().latest(), 2);
    }

    #[test]
    fn a_stage_cannot_rewrite_a_user_version() {
        let (_t, repo, paths) = scratch();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  sk  arc-start  brief.md",
        );
        write_sketch(&repo, "sk", V1);
        let made = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        edit_sketch(&paths, &repo, &made.id, HAND, 1).unwrap();

        write_sketch(&repo, "sk", V2);
        let err = record_arc_sketch(&paths, &repo, "sk", None).unwrap_err();
        assert!(
            matches!(err, ArcError::Refused(ref m) if m == USER_VERSION_REFUSAL),
            "{err:?}"
        );
        assert_eq!(
            working_copy(&repo, "sk"),
            HAND,
            "the user's text, byte for byte"
        );
        assert_eq!(sketch_in(&paths, &repo, &made.id).unwrap().latest(), 2);

        let same = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        assert!(!same.appended, "the user's own text records nothing");

        // Keep sketch is the user's ask, so it may follow a user version.
        let idea_id = idea(&paths, &repo);
        let kept = keep_sketch(&paths, &repo, &idea_id, KEPT).unwrap();
        assert_ne!(kept.id, made.id, "an idea's sketch is its own");
    }

    #[test]
    fn adopting_a_kept_sketch_ties_the_arc_and_keep_writes_through() {
        let (_t, repo, paths) = scratch();
        let idea_id = idea(&paths, &repo);
        let kept = keep_sketch(&paths, &repo, &idea_id, KEPT).unwrap();

        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  ad  arc-start  brief.md",
        );
        write_sketch(&repo, "ad", KEPT);
        let adopted = record_arc_sketch(&paths, &repo, "ad", Some(&kept.id)).unwrap();
        assert_eq!(adopted.id, kept.id);
        assert!(!adopted.minted && !adopted.appended);
        assert_eq!(sketch_lines(&paths, &repo), 1, "the generation names it");
        assert!(log_text(&paths, &repo).contains(&format!("arc-sketch  {}", kept.id)));
        let record = sketch_in(&paths, &repo, &kept.id).unwrap();
        assert_eq!(
            record.arc,
            Some(SketchArc {
                name: "ad".into(),
                created: Some("2026-11-01T00:00:00Z".into())
            })
        );
        let again = record_arc_sketch(&paths, &repo, "ad", Some(&kept.id)).unwrap();
        assert!(!again.appended);
        assert_eq!(sketch_lines(&paths, &repo), 1, "once");

        let second = keep_sketch(&paths, &repo, &idea_id, KEPT2).unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(
            working_copy(&repo, "ad"),
            KEPT2,
            "the arc reads what was kept"
        );
        let after = record_arc_sketch(&paths, &repo, "ad", None).unwrap();
        assert!(
            !after.appended && after.version == 2,
            "nothing older lands on top"
        );

        assert!(record_arc_sketch(&paths, &repo, "ad", Some("00000000")).is_err());
    }

    #[test]
    fn an_ended_or_older_generation_gets_no_working_copy() {
        let (_t, repo, paths) = scratch();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  sk  arc-start  brief.md",
        );
        write_sketch(&repo, "sk", V1);
        let made = record_arc_sketch(&paths, &repo, "sk", None).unwrap();
        log_append(&paths, &repo, "2026-11-01T01:00:00Z  sk  discarded");
        edit_sketch(&paths, &repo, &made.id, HAND, 1).unwrap();
        assert_eq!(working_copy(&repo, "sk"), V1, "the generation has ended");

        log_append(
            &paths,
            &repo,
            "2026-11-02T00:00:00Z  sk  arc-start  brief.md",
        );
        edit_sketch(&paths, &repo, &made.id, V2, 2).unwrap();
        assert_eq!(
            working_copy(&repo, "sk"),
            V1,
            "the name's newer generation is not this sketch's"
        );
    }

    #[test]
    fn brief_versions_are_kept_and_found_by_their_bytes() {
        let (_t, repo, paths) = scratch();
        let idea_id = idea(&paths, &repo);
        let kept = keep_sketch(&paths, &repo, &idea_id, KEPT).unwrap();
        keep_sketch(&paths, &repo, &idea_id, KEPT2).unwrap();
        fs::create_dir_all(repo.join("briefs")).unwrap();
        let brief = repo.join("briefs/thing-brief.md");
        fs::write(&brief, "# The thing\n\nOne.\n").unwrap();

        let rel = Path::new("briefs/thing-brief.md");
        let v1 = record_brief(&paths, &repo, &kept.id, rel, 1, Some("u-2")).unwrap();
        assert_eq!(v1.n, 1);
        assert_eq!(v1.path, "briefs/thing-brief.md");
        assert_eq!(v1.title, "The thing");
        assert_eq!(v1.sketch_version, 1);
        assert_eq!(v1.session.as_deref(), Some("u-2"));
        let same = record_brief(&paths, &repo, &kept.id, &brief, 2, None).unwrap();
        assert_eq!(same, v1, "identical bytes append nothing");
        assert!(record_brief(&paths, &repo, &kept.id, rel, 9, None).is_err());
        assert!(record_brief(&paths, &repo, &kept.id, Path::new("briefs/x.txt"), 1, None).is_err());

        fs::write(&brief, "# The thing\n\nTwo.\n").unwrap();
        let v2 = record_brief(&paths, &repo, &kept.id, rel, 2, None).unwrap();
        assert_eq!((v2.n, v2.sketch_version), (2, 2));

        let record = sketch_in(&paths, &repo, &kept.id).unwrap();
        assert_eq!(record.latest_brief().map(|b| b.n), Some(2));
        assert_eq!(
            read_brief_version(&record, 1).unwrap(),
            "# The thing\n\nOne.\n"
        );
        let (found, n) = sketch_for_brief(&paths, &repo, rel).unwrap();
        assert_eq!((found.id.as_str(), n), (kept.id.as_str(), 2));
        fs::write(&brief, "# The thing\n\nOne.\n").unwrap();
        assert_eq!(
            sketch_for_brief(&paths, &repo, &brief).map(|(_, n)| n),
            Some(1)
        );
        fs::write(&brief, "# Edited by hand\n").unwrap();
        assert!(sketch_for_brief(&paths, &repo, rel).is_none());
    }
}
