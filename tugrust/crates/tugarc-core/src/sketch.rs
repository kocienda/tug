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
//! of the tie once the generation has ended. A sketch a conversation settled
//! before any arc opened is recorded with no arc at all, by
//! [`record_free_sketch`]. The text is stored whole and is
//! never given an id line or a header; the id lives outside the file.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::error::ArcError;
use crate::log::{
    append_arc_log, arc_has_ended, generation_sketch_id, generation_started_at, validate_arc_name,
};
use crate::ops::{documents_dir, main_repo_root, record_body};
use crate::work_log::{self, By, Privacy, WorkKind, WorkObject};

/// The record file beside the versions.
pub const SKETCH_JSON: &str = "sketch.json";

/// The file a writer of one sketch's record locks.
const SKETCH_LOCK: &str = "sketch.json.lock";

/// The arc a sketch was recorded for: its name and its generation's start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchArc {
    pub name: String,
    /// The generation's start in the arc log's ISO form; `None` when the log
    /// never recorded the arc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

/// One kept version of a sketch's text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchVersion {
    pub n: u32,
    pub at: String,
}

/// Whether a sketch was written while its conversation was going on, or
/// filled in afterwards from what was left of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Written {
    #[default]
    AtTheTime,
    Afterwards,
}

impl Written {
    fn is_at_the_time(&self) -> bool {
        *self == Written::AtTheTime
    }
}

/// One turn of a session the sketch came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchSource {
    pub session: String,
    pub turn: u32,
    /// What the user said in that turn, when it could be read and the session
    /// is one whose words may be kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<String>,
    pub read_at: String,
}

/// What a sketch's `Source:` line names: a session and some of its turns, or
/// a brief.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedSource {
    pub session: Option<String>,
    pub turns: Vec<u32>,
    pub brief: Option<String>,
}

/// The most of a turn's words a source keeps.
const WORDS_LIMIT: usize = 500;

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
    #[serde(default)]
    pub versions: Vec<SketchVersion>,
    /// The turns the sketch came from. `None` until they were read; an empty
    /// list when the sketch names none, or came from a private session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<SketchSource>>,
    /// The brief the sketch was written from, by id, when its `Source:` line
    /// names a brief rather than a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_brief: Option<String>,
    #[serde(default, skip_serializing_if = "Written::is_at_the_time")]
    pub written: Written,
    /// The record's directory. Read from where it was found, never stored.
    #[serde(skip)]
    pub dir: PathBuf,
}

impl SketchRecord {
    /// The newest version's number; 0 for a record with none.
    pub fn latest(&self) -> u32 {
        self.versions.iter().map(|v| v.n).max().unwrap_or(0)
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
/// appended as a new version unless it is byte-identical to the latest.
///
/// `by` is the session recording it, and decides which of its sources keep
/// their words; `written` says whether the sketch was written at the time.
pub fn record_arc_sketch(
    paths: &Paths,
    repo: &Path,
    arc: &str,
    by: &By,
    written: Written,
) -> Result<RecordOutcome, ArcError> {
    record_arc_sketch_in(paths, repo, arc, by, written, &process_words)
}

/// [`record_arc_sketch`], reading turns' words through `words`.
pub(crate) fn record_arc_sketch_in(
    paths: &Paths,
    repo: &Path,
    arc: &str,
    by: &By,
    written: Written,
    words: &Words,
) -> Result<RecordOutcome, ArcError> {
    validate_arc_name(arc).map_err(ArcError::InvalidName)?;
    let source = documents_dir(repo, arc).join("sketch.md");
    let text = fs::read_to_string(&source).map_err(|_| {
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

    let known = generation_sketch_id(&log, arc).or_else(|| {
        records_in(&root)
            .into_iter()
            .find(|r| r.arc.as_ref() == Some(&link))
            .map(|r| r.id)
    });
    let (id, minted) = match known {
        Some(id) if valid_id(&id) => (id, false),
        _ => (mint_id(paths), true),
    };

    let dir = root.join(&id);
    let mut record = match read_record(&dir) {
        Some(record) => record,
        None => SketchRecord {
            id: id.clone(),
            created: now_iso8601(),
            project_dir: project_dir_of(repo),
            arc: Some(link),
            versions: Vec::new(),
            sources: None,
            from_brief: None,
            written,
            dir: dir.clone(),
        },
    };

    if minted && !arc_has_ended(paths, repo, arc) {
        append_arc_log(paths, repo, arc, "arc-sketch", &id).map_err(|e| {
            ArcError::Refused(format!("could not record the sketch in the arc log: {e}"))
        })?;
    }

    let keep = Keep {
        paths,
        repo,
        by,
        written,
        words,
    };
    let (version, appended) = keep_version(&mut record, &text, &keep)?;
    Ok(RecordOutcome {
        id,
        version,
        minted,
        appended,
    })
}

/// Keep `text` as a sketch tied to no arc, as a conversation with no arc
/// records the sketch it settled.
///
/// With no `id`, a fresh id is minted. With one, the text is kept as the
/// newest version of that sketch, which must be in this checkout's store and
/// tied to no arc: an arc's sketch is kept through its arc. Either way the
/// text is appended unless it is byte-identical to the latest, and empty text
/// is refused.
pub fn record_free_sketch(
    paths: &Paths,
    repo: &Path,
    text: &str,
    id: Option<&str>,
    by: &By,
    written: Written,
) -> Result<RecordOutcome, ArcError> {
    record_free_sketch_in(paths, repo, text, id, by, written, &process_words)
}

/// [`record_free_sketch`], reading turns' words through `words`.
pub(crate) fn record_free_sketch_in(
    paths: &Paths,
    repo: &Path,
    text: &str,
    id: Option<&str>,
    by: &By,
    written: Written,
    words: &Words,
) -> Result<RecordOutcome, ArcError> {
    if text.trim().is_empty() {
        return Err(ArcError::Refused(
            "no sketch to record: the text is empty".into(),
        ));
    }
    crate::log::refuse_unredirected_temp_repo(paths, repo);
    let root = sketch_root(paths, repo);
    let (mut record, minted) = match id {
        Some(id) => {
            let record = valid_id(id)
                .then(|| read_record(&root.join(id)))
                .flatten()
                .ok_or_else(|| {
                    ArcError::Refused(format!("sketch {id} is not in this checkout's store"))
                })?;
            if let Some(arc) = &record.arc {
                return Err(ArcError::Refused(format!(
                    "sketch {id} belongs to arc {}; record it through the arc",
                    arc.name
                )));
            }
            (record, false)
        }
        None => {
            let id = mint_id(paths);
            let record = SketchRecord {
                dir: root.join(&id),
                id,
                created: now_iso8601(),
                project_dir: project_dir_of(repo),
                arc: None,
                versions: Vec::new(),
                sources: None,
                from_brief: None,
                written,
            };
            (record, true)
        }
    };
    let keep = Keep {
        paths,
        repo,
        by,
        written,
        words,
    };
    let (version, appended) = keep_version(&mut record, text, &keep)?;
    Ok(RecordOutcome {
        id: record.id,
        version,
        minted,
        appended,
    })
}

/// Append `text` to `record` as its newest version and write the record,
/// unless the text is byte-identical to the latest. Returns the version the
/// text now is and whether it was appended.
///
/// The read, the compare and the write are held under the sketch's lock, and
/// the record is read again under it, so a version another writer appended
/// between this caller's read and its write is kept rather than overwritten.
///
/// An appended version sets the record's sources from the new text's
/// `Source:` line, per [`sources_of`], and writes a `sketch.recorded` line.
fn keep_version(
    record: &mut SketchRecord,
    text: &str,
    keep: &Keep,
) -> Result<(u32, bool), ArcError> {
    let dir = record.dir.clone();
    fs::create_dir_all(&dir).map_err(|e| ArcError::io("could not create the sketch", &dir, e))?;
    let _held = crate::record_lock::hold(&dir, SKETCH_LOCK, crate::record_lock::LockMode::Wait)?;
    if let Some(current) = read_record(&dir) {
        *record = current;
    }
    let latest = record.latest();
    if latest > 0 && read_version(record, Some(latest)).is_ok_and(|t| t == text) {
        return Ok((latest, false));
    }
    let n = latest + 1;
    write_atomically(&dir.join(format!("v{n}.md")), text.as_bytes(), "sketch")?;
    record.versions.push(SketchVersion {
        n,
        at: now_iso8601(),
    });
    let parsed = parse_source_line(text);
    record.sources = Some(sources_of(&parsed, keep.by, keep.words));
    record.written = keep.written;
    record.from_brief = parsed.brief.as_deref().and_then(|path| {
        crate::brief::ensure(keep.paths, keep.repo, path, keep.by)
            .map_err(|e| eprintln!("could not record the sketch's brief {path}: {e}"))
            .ok()
            .map(|o| o.id)
    });
    let json = serde_json::to_string_pretty(&*record)
        .map_err(|e| ArcError::Refused(format!("could not serialize {SKETCH_JSON}: {e}")))?;
    write_atomically(&dir.join(SKETCH_JSON), (json + "\n").as_bytes(), "sketch")?;
    let detail = match &record.arc {
        Some(arc) => serde_json::json!({ "version": n, "arc": arc.name }),
        None => serde_json::json!({ "version": n }),
    };
    let object = WorkObject::Sketch {
        sketch: record.id.clone(),
    };
    if let Err(e) = work_log::append(
        keep.paths,
        keep.repo,
        WorkKind::SketchRecorded,
        object,
        detail,
        keep.by,
    ) {
        eprintln!("could not append sketch.recorded to the work log: {e}");
    }
    Ok((n, true))
}

/// Reads the words a session said in one turn: `(session, turn)` to the
/// user's text, or `None` when it cannot be read.
pub(crate) type Words = dyn Fn(&str, u32) -> Option<String>;

/// What a version is kept with: where, by whom, how, and how words are read.
struct Keep<'a> {
    paths: &'a Paths,
    repo: &'a Path,
    by: &'a By,
    written: Written,
    words: &'a Words,
}

/// Words read through the transcript this process's finder locates.
fn process_words(session: &str, turn: u32) -> Option<String> {
    turn_words(
        session,
        turn,
        &tugcore::session_finder::FinderEnv::from_process(),
    )
}

/// What the user said in `turn` of `session`, cut to [`WORDS_LIMIT`]
/// characters with an ellipsis; `None` when the finder cannot locate the
/// session's transcript or it has no such turn.
pub fn turn_words(
    session: &str,
    turn: u32,
    env: &tugcore::session_finder::FinderEnv,
) -> Option<String> {
    let tugcore::session_finder::Finding::Found(found) =
        tugcore::session_finder::find(session, env)
    else {
        return None;
    };
    let transcript = tugcore::session_transcript::read(&found.transcript?);
    let text = transcript
        .turns
        .iter()
        .find(|t| t.number == turn as usize)?
        .user
        .trim()
        .to_string();
    if text.chars().count() <= WORDS_LIMIT {
        return Some(text);
    }
    let cut: String = text.chars().take(WORDS_LIMIT).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// The sources a parsed `Source:` line yields for a writer `by`: none for a
/// private session; each named turn otherwise, with its words only when the
/// turn is in the writer's own session and that session is public, since a
/// writer can know only its own session's privacy.
fn sources_of(parsed: &ParsedSource, by: &By, words: &Words) -> Vec<SketchSource> {
    if by.privacy == Privacy::Private {
        return Vec::new();
    }
    let Some(session) = &parsed.session else {
        return Vec::new();
    };
    let own = by.privacy == Privacy::Public && by.is_own(session);
    let read_at = now_iso8601();
    parsed
        .turns
        .iter()
        .map(|&turn| SketchSource {
            session: session.clone(),
            turn,
            words: if own { words(session, turn) } else { None },
            read_at: read_at.clone(),
        })
        .collect()
}

/// Read a sketch's last `Source:` line: `session <uuid>, turn N`,
/// `session <uuid>, turns A–B` (an en dash or a hyphen), or `brief <path>`.
/// Anything else names nothing.
pub fn parse_source_line(text: &str) -> ParsedSource {
    let Some(line) = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with("Source:"))
    else {
        return ParsedSource::default();
    };
    let rest = line["Source:".len()..].trim().trim_end_matches('.');
    if let Some(path) = rest.strip_prefix("brief ") {
        let path = path.trim();
        return ParsedSource {
            brief: (!path.is_empty()).then(|| path.to_string()),
            ..ParsedSource::default()
        };
    }
    let Some(named) = rest.strip_prefix("session ") else {
        return ParsedSource::default();
    };
    let Some((session, turns)) = named.split_once(',') else {
        return ParsedSource::default();
    };
    let session = session.trim();
    let turns = turns.trim();
    let numbers = if let Some(range) = turns.strip_prefix("turns ") {
        let (a, b) = range
            .split_once('–')
            .or_else(|| range.split_once('-'))
            .unwrap_or((range, range));
        match (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
            (Ok(a), Ok(b)) if a >= 1 && a <= b => (a..=b).collect(),
            _ => Vec::new(),
        }
    } else if let Some(n) = turns.strip_prefix("turn ") {
        n.trim()
            .parse::<u32>()
            .ok()
            .filter(|&n| n >= 1)
            .into_iter()
            .collect()
    } else {
        Vec::new()
    };
    if session.is_empty() || numbers.is_empty() {
        return ParsedSource::default();
    }
    ParsedSource {
        session: Some(session.to_string()),
        turns: numbers,
        brief: None,
    }
}

/// Whether a sketch came from a brief alone: it holds no sources and its
/// newest text's `Source:` line names a brief. Read from the line rather than
/// from `from_brief`, which a record brought forward on read has not filled.
pub fn brief_sourced(record: &SketchRecord) -> bool {
    if record.sources.as_ref().is_some_and(|s| !s.is_empty()) {
        return false;
    }
    read_version(record, None).is_ok_and(|text| parse_source_line(&text).brief.is_some())
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

/// The newest text of sketch `id`, verbatim: from this checkout's store, else
/// from the first other checkout's under the data root that holds it, since a
/// cycle may name a sketch from either. `None` when no store holds the id or
/// the record has no version to read.
pub fn latest_text(paths: &Paths, repo: &Path, id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    let record = read_record(&sketch_root(paths, repo).join(id))
        .or_else(|| find_sketch(paths, id).into_iter().next().map(|(_, r)| r))?;
    read_version(&record, None).ok()
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
pub(crate) fn valid_id(id: &str) -> bool {
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

fn project_dir_of(repo: &Path) -> String {
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
    // A record written before sources were kept has them derived from its
    // newest text, in memory only: no words, no git, no brief resolved. The
    // next version persists what that write reads.
    if record.sources.is_none() {
        let parsed = read_version(&record, None)
            .map(|t| parse_source_line(&t))
            .unwrap_or_default();
        let no_words: &Words = &|_, _| None;
        record.sources = Some(sources_of(&parsed, &By::none(), no_words));
    }
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
/// never sees half a file. `what` names the thing written, for the error.
pub(crate) fn write_atomically(path: &Path, bytes: &[u8], what: &str) -> Result<(), ArcError> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", std::process::id()));
    let lead = format!("could not write the {what}");
    fs::write(&tmp, bytes).map_err(|e| ArcError::io(&lead, &tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| ArcError::io(&lead, path, e))
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

        let first =
            record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
        assert!(first.minted && first.appended && first.version == 1);
        assert!(valid_id(&first.id));
        assert_eq!(sketch_lines(&paths, &repo), 1, "one arc-sketch line");

        let again =
            record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
        assert_eq!(again.id, first.id);
        assert!(!again.minted && !again.appended && again.version == 1);

        write_sketch(&repo, "sk", V2);
        let second =
            record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
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
        let first =
            record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
        log_append(&paths, &repo, "2026-11-01T01:00:00Z  sk  discarded");
        log_append(
            &paths,
            &repo,
            "2026-11-02T00:00:00Z  sk  arc-start  brief.md",
        );

        let reused =
            record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
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
            let first =
                record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
            for line in &ending {
                log_append(&paths, &repo, line);
            }
            write_sketch(&repo, "sk", V2);
            let after =
                record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
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

        let first =
            record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
        assert!(first.minted);
        assert_eq!(sketch_lines(&paths, &repo), 0, "no line after the end");
        write_sketch(&repo, "sk", V2);
        let again =
            record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
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

        let made = record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
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
        let err =
            record_arc_sketch(&paths, &repo, "none", &By::none(), Written::AtTheTime).unwrap_err();
        assert!(matches!(err, ArcError::Refused(_)), "{err:?}");
    }

    #[test]
    fn a_free_sketch_mints_then_keeps_versions_under_its_id() {
        let (_t, repo, paths) = scratch();
        let first =
            record_free_sketch(&paths, &repo, V1, None, &By::none(), Written::AtTheTime).unwrap();
        assert!(first.minted && first.appended && first.version == 1);
        assert!(valid_id(&first.id));
        assert_eq!(sketch_lines(&paths, &repo), 0, "no arc, no log line");

        let same = record_free_sketch(
            &paths,
            &repo,
            V1,
            Some(&first.id),
            &By::none(),
            Written::AtTheTime,
        )
        .unwrap();
        assert!(!same.minted && !same.appended && same.version == 1);
        let next = record_free_sketch(
            &paths,
            &repo,
            V2,
            Some(&first.id),
            &By::none(),
            Written::AtTheTime,
        )
        .unwrap();
        assert_eq!(next.id, first.id);
        assert!(next.appended && next.version == 2);

        let found = find_sketch(&paths, &first.id);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.arc, None);
        assert_eq!(read_version(&found[0].1, Some(1)).unwrap(), V1);
        assert_eq!(read_version(&found[0].1, None).unwrap(), V2);

        let other =
            record_free_sketch(&paths, &repo, V1, None, &By::none(), Written::AtTheTime).unwrap();
        assert_ne!(other.id, first.id, "no id means a new sketch");
    }

    #[test]
    fn writers_at_once_each_keep_their_version() {
        let (_t, repo, paths) = scratch();
        let first =
            record_free_sketch(&paths, &repo, V1, None, &By::none(), Written::AtTheTime).unwrap();
        std::thread::scope(|scope| {
            for i in 0..8 {
                let (paths, repo, id) = (&paths, &repo, &first.id);
                scope.spawn(move || {
                    let text = format!("# Sketch\n\nWant number {i}.\n");
                    record_free_sketch(
                        paths,
                        repo,
                        &text,
                        Some(id),
                        &By::none(),
                        Written::AtTheTime,
                    )
                    .unwrap();
                });
            }
        });
        let record = find_sketch(&paths, &first.id).remove(0).1;
        assert_eq!(record.versions.len(), 9, "no writer's version was lost");
        let texts: std::collections::BTreeSet<String> = (1..=9)
            .map(|n| read_version(&record, Some(n)).unwrap())
            .collect();
        assert_eq!(texts.len(), 9, "every version holds its own text");
        for i in 0..8 {
            assert!(texts.contains(&format!("# Sketch\n\nWant number {i}.\n")));
        }
    }

    const UUID: &str = "048e4155-f644-46f7-a839-d22ac02a564f";

    fn sourced(line: &str) -> String {
        format!("# Sketch\n\nWant the archive.\n\n{line}\n")
    }

    #[test]
    fn a_source_line_names_turns_or_a_brief() {
        let four = parse_source_line(&sourced(&format!("Source: session {UUID}, turns 1–4")));
        assert_eq!(four.session.as_deref(), Some(UUID));
        assert_eq!(four.turns, [1, 2, 3, 4]);
        let hyphen = parse_source_line(&sourced(&format!("Source: session {UUID}, turns 2-3")));
        assert_eq!(hyphen.turns, [2, 3]);
        let one = parse_source_line(&sourced(&format!("Source: session {UUID}, turn 7")));
        assert_eq!(one.turns, [7]);
        let brief = parse_source_line(&sourced("Source: brief briefs/x.md"));
        assert_eq!(brief.brief.as_deref(), Some("briefs/x.md"));
        assert!(brief.session.is_none() && brief.turns.is_empty());
        assert_eq!(
            parse_source_line(&sourced("Source: x")),
            ParsedSource::default()
        );
        assert_eq!(
            parse_source_line("# Sketch\n\nNo line.\n"),
            ParsedSource::default()
        );
    }

    fn work_lines(paths: &Paths, repo: &Path) -> Vec<work_log::WorkLine> {
        work_log::read_lines(
            &fs::read_to_string(work_log::work_log_path(paths, repo)).unwrap_or_default(),
        )
    }

    /// Words that name the turn they were asked for.
    fn said(session: &str, turn: u32) -> Option<String> {
        Some(format!("{session} said {turn}"))
    }

    fn by(session: &str, privacy: Privacy) -> By {
        By {
            session: Some(session.into()),
            turn: Some(5),
            privacy,
            segments: Vec::new(),
        }
    }

    #[test]
    fn privacy_decides_what_a_source_keeps() {
        let (_t, repo, paths) = scratch();
        let text = sourced(&format!("Source: session {UUID}, turns 1–2"));
        let record_by = |by: &By| {
            let out =
                record_free_sketch_in(&paths, &repo, &text, None, by, Written::AtTheTime, &said)
                    .unwrap();
            find_sketch(&paths, &out.id).remove(0).1
        };

        let own = record_by(&by(UUID, Privacy::Public));
        let sources = own.sources.unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(
            sources[1].words.as_deref(),
            Some(&*format!("{UUID} said 2"))
        );

        let private = record_by(&by(UUID, Privacy::Private));
        assert_eq!(private.sources, Some(Vec::new()));
        let line = work_lines(&paths, &repo)
            .into_iter()
            .find(|l| {
                l.object
                    == WorkObject::Sketch {
                        sketch: private.id.clone(),
                    }
            })
            .unwrap();
        assert_eq!(line.kind, WorkKind::SketchRecorded);
        assert_eq!(
            line.session.as_deref(),
            Some(UUID),
            "the line names the session"
        );

        let unknown = record_by(&by(UUID, Privacy::Unknown));
        let sources = unknown.sources.unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().all(|s| s.words.is_none()));

        let other = record_by(&by("another-session", Privacy::Public));
        let sources = other.sources.unwrap();
        assert_eq!(sources[0].session, UUID);
        assert!(
            sources.iter().all(|s| s.words.is_none()),
            "not the caller's turns"
        );

        // A session that rotated since it wrote the line is still its own.
        let rotated = record_by(&By {
            segments: vec![UUID.into()],
            ..by("the-live-segment", Privacy::Public)
        });
        let sources = rotated.sources.unwrap();
        assert_eq!(
            sources[0].words.as_deref(),
            Some(&*format!("{UUID} said 1"))
        );
    }

    /// A record as it was written before sources were kept.
    fn old_record(paths: &Paths, repo: &Path, id: &str, text: &str) -> PathBuf {
        let dir = sketch_root(paths, repo).join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("v1.md"), text).unwrap();
        let json = format!(
            "{{\n  \"id\": \"{id}\",\n  \"created\": \"2026-11-01T00:00:00Z\",\n  \
             \"project_dir\": \"{}\",\n  \"versions\": [\n    {{\n      \"n\": 1,\n      \
             \"at\": \"2026-11-01T00:00:00Z\"\n    }}\n  ]\n}}\n",
            repo.display()
        );
        fs::write(dir.join(SKETCH_JSON), json).unwrap();
        dir
    }

    #[test]
    fn an_old_record_reads_with_its_sources_and_is_not_rewritten() {
        let (_t, repo, paths) = scratch();
        let dir = old_record(
            &paths,
            &repo,
            "1234abcd",
            &sourced(&format!("Source: session {UUID}, turns 1–3")),
        );
        let before = fs::read(dir.join(SKETCH_JSON)).unwrap();
        let record = find_sketch(&paths, "1234abcd").remove(0).1;
        let sources = record.sources.unwrap();
        assert_eq!(
            sources.iter().map(|s| s.turn).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert!(sources.iter().all(|s| s.words.is_none()));
        assert_eq!(record.written, Written::AtTheTime);
        assert_eq!(
            fs::read(dir.join(SKETCH_JSON)).unwrap(),
            before,
            "a read writes nothing"
        );

        let next = sourced(&format!("Source: session {UUID}, turns 1–4"));
        record_free_sketch(
            &paths,
            &repo,
            &next,
            Some("1234abcd"),
            &By::none(),
            Written::Afterwards,
        )
        .unwrap();
        let after = fs::read_to_string(dir.join(SKETCH_JSON)).unwrap();
        assert!(
            after.contains("\"sources\"") && after.contains("\"afterwards\""),
            "{after}"
        );
    }

    #[test]
    fn a_brief_sourced_sketch_is_found_before_its_brief_is_recorded() {
        let (_t, repo, paths) = scratch();
        old_record(
            &paths,
            &repo,
            "5678abcd",
            &sourced("Source: brief briefs/x.md"),
        );
        old_record(
            &paths,
            &repo,
            "9abcdef0",
            &sourced(&format!("Source: session {UUID}, turn 1")),
        );
        let sourced_ids: Vec<String> = sketches(&paths, &repo)
            .into_iter()
            .filter(brief_sourced)
            .map(|r| r.id)
            .collect();
        assert_eq!(sourced_ids, ["5678abcd"]);
        assert!(
            crate::brief::briefs(&paths, &repo).is_empty(),
            "no brief record was made"
        );
        assert_eq!(find_sketch(&paths, "5678abcd")[0].1.from_brief, None);
    }

    #[test]
    fn recording_a_brief_sourced_sketch_links_the_brief_record() {
        let (_t, repo, paths) = scratch();
        let out = record_free_sketch(
            &paths,
            &repo,
            &sourced("Source: brief briefs/x.md"),
            None,
            &By::none(),
            Written::Afterwards,
        )
        .unwrap();
        let record = find_sketch(&paths, &out.id).remove(0).1;
        let brief = crate::brief::resolve(&paths, &repo, "briefs/x.md").expect("recorded");
        assert_eq!(record.from_brief.as_deref(), Some(brief.id.as_str()));
        assert_eq!(record.sources, Some(Vec::new()));
        assert!(brief_sourced(&record));
    }

    #[test]
    fn a_turns_words_come_from_its_transcript() {
        let temp = TempDir::new().unwrap();
        let claude = temp.path().join("claude");
        let project = claude.join("projects").join("-scratch-project");
        fs::create_dir_all(&project).unwrap();
        let user = |text: &str| {
            serde_json::json!({ "type": "user", "message": { "role": "user", "content": text } })
                .to_string()
        };
        let long = "x".repeat(600);
        let transcript = [user("First, the archive."), user(&long)].join("\n");
        fs::write(project.join(format!("{UUID}.jsonl")), transcript + "\n").unwrap();
        let env = tugcore::session_finder::FinderEnv {
            sessions_db: None,
            index_db: temp.path().join("no-index.db"),
            claude_home: tugcore::claude_home::ClaudeHome::at(&claude),
            instance: String::new(),
        };
        assert_eq!(
            turn_words(UUID, 1, &env).as_deref(),
            Some("First, the archive.")
        );
        let cut = turn_words(UUID, 2, &env).unwrap();
        assert_eq!(cut.chars().count(), WORDS_LIMIT + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(turn_words(UUID, 3, &env), None);
        assert_eq!(
            turn_words("0f3c1e5a-9b27-4c1d-8e36-5a7f2d4b6c90", 1, &env),
            None
        );
    }

    #[test]
    fn a_free_sketch_refuses_empty_text_an_unknown_id_and_an_arcs_sketch() {
        let (temp, repo, paths) = scratch();
        assert!(matches!(
            record_free_sketch(&paths, &repo, " \n", None, &By::none(), Written::AtTheTime),
            Err(ArcError::Refused(_))
        ));
        assert!(
            record_free_sketch(
                &paths,
                &repo,
                V1,
                Some("0000beef"),
                &By::none(),
                Written::AtTheTime
            )
            .is_err()
        );
        assert!(
            record_free_sketch(
                &paths,
                &repo,
                V1,
                Some("../etc"),
                &By::none(),
                Written::AtTheTime
            )
            .is_err()
        );

        write_sketch(&repo, "sk", V1);
        let arcs = record_arc_sketch(&paths, &repo, "sk", &By::none(), Written::AtTheTime).unwrap();
        let err = record_free_sketch(
            &paths,
            &repo,
            V2,
            Some(&arcs.id),
            &By::none(),
            Written::AtTheTime,
        )
        .unwrap_err();
        assert!(err.to_string().contains("arc sk"), "{err}");

        let other = temp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let elsewhere =
            record_free_sketch(&paths, &other, V1, None, &By::none(), Written::AtTheTime).unwrap();
        assert!(
            record_free_sketch(
                &paths,
                &repo,
                V2,
                Some(&elsewhere.id),
                &By::none(),
                Written::AtTheTime
            )
            .is_err(),
            "another checkout's sketch is not versioned here"
        );
    }
}
