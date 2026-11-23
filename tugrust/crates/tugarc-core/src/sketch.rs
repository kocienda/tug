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

/// The record file beside the versions.
pub const SKETCH_JSON: &str = "sketch.json";

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
pub fn record_arc_sketch(paths: &Paths, repo: &Path, arc: &str) -> Result<RecordOutcome, ArcError> {
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
            dir: dir.clone(),
        },
    };

    if minted && !arc_has_ended(paths, repo, arc) {
        append_arc_log(paths, repo, arc, "arc-sketch", &id).map_err(|e| {
            ArcError::Refused(format!("could not record the sketch in the arc log: {e}"))
        })?;
    }

    let latest = record.latest();
    if latest > 0 && read_version(&record, Some(latest)).is_ok_and(|t| t == text) {
        return Ok(RecordOutcome {
            id,
            version: latest,
            minted,
            appended: false,
        });
    }

    fs::create_dir_all(&dir).map_err(|e| ArcError::io("could not create the sketch", &dir, e))?;
    let n = latest + 1;
    write_atomically(&dir.join(format!("v{n}.md")), text.as_bytes())?;
    record.versions.push(SketchVersion {
        n,
        at: now_iso8601(),
    });
    let json = serde_json::to_string_pretty(&record)
        .map_err(|e| ArcError::Refused(format!("could not serialize {SKETCH_JSON}: {e}")))?;
    write_atomically(&dir.join(SKETCH_JSON), (json + "\n").as_bytes())?;
    Ok(RecordOutcome {
        id,
        version: n,
        minted,
        appended: true,
    })
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

fn project_dir_of(repo: &Path) -> String {
    let root = main_repo_root(repo);
    fs::canonicalize(&root)
        .unwrap_or(root)
        .to_string_lossy()
        .into_owned()
}

fn read_record(dir: &Path) -> Option<SketchRecord> {
    let text = fs::read_to_string(dir.join(SKETCH_JSON)).ok()?;
    let mut record: SketchRecord = serde_json::from_str(&text).ok()?;
    record.dir = dir.to_path_buf();
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
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), ArcError> {
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

        let first = record_arc_sketch(&paths, &repo, "sk").unwrap();
        assert!(first.minted && first.appended && first.version == 1);
        assert!(valid_id(&first.id));
        assert_eq!(sketch_lines(&paths, &repo), 1, "one arc-sketch line");

        let again = record_arc_sketch(&paths, &repo, "sk").unwrap();
        assert_eq!(again.id, first.id);
        assert!(!again.minted && !again.appended && again.version == 1);

        write_sketch(&repo, "sk", V2);
        let second = record_arc_sketch(&paths, &repo, "sk").unwrap();
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
        let first = record_arc_sketch(&paths, &repo, "sk").unwrap();
        log_append(&paths, &repo, "2026-11-01T01:00:00Z  sk  discarded");
        log_append(
            &paths,
            &repo,
            "2026-11-02T00:00:00Z  sk  arc-start  brief.md",
        );

        let reused = record_arc_sketch(&paths, &repo, "sk").unwrap();
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
            let first = record_arc_sketch(&paths, &repo, "sk").unwrap();
            for line in &ending {
                log_append(&paths, &repo, line);
            }
            write_sketch(&repo, "sk", V2);
            let after = record_arc_sketch(&paths, &repo, "sk").unwrap();
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

        let first = record_arc_sketch(&paths, &repo, "sk").unwrap();
        assert!(first.minted);
        assert_eq!(sketch_lines(&paths, &repo), 0, "no line after the end");
        write_sketch(&repo, "sk", V2);
        let again = record_arc_sketch(&paths, &repo, "sk").unwrap();
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

        let made = record_arc_sketch(&paths, &repo, "sk").unwrap();
        let found = find_sketch(&paths, &made.id);
        assert_eq!(found.len(), 1);
        assert_eq!(
            PathBuf::from(&found[0].1.project_dir),
            fs::canonicalize(&repo).unwrap(),
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
        let err = record_arc_sketch(&paths, &repo, "none").unwrap_err();
        assert!(matches!(err, ArcError::Refused(_)), "{err:?}");
    }
}
