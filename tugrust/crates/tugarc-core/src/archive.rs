//! The arc archive: what an ended arc's documents become.
//!
//! An arc's working documents live at `.tug/arcs/<name>/` and are never
//! tracked. When the arc ends — a join, or a delete of a discarded arc's
//! paperwork — the working directory goes, and its files are kept here,
//! beside the arc log in the checkout's state dir:
//!
//! ```text
//! <project_state_dir>/arc-archive/<name>/<stamp>/
//!     arc.json
//!     brief.md  plan.md  tasks.md  sketch.md   (each present when the arc had it)
//! ```
//!
//! The store is plain files because what it keeps are markdown files: a copy
//! can be opened, diffed and read by any tool, where a ledger row holding a
//! file's text could not. An entry is keyed by the arc name and the start of
//! its generation ([`crate::log::generation_started_at`]), because names are
//! reused and a generation is the arc log's own unit of "one arc".
//!
//! **The archive is user state.** Nothing prunes it and nothing commits it.
//! Its one removal is [`replace_entry`]'s: the superseded copy of the same
//! generation, archived again.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::error::ArcError;
use crate::log::{generation_start, validate_arc_name};
use crate::ops::documents_dir;

/// The file each entry describes itself in.
pub const ARC_JSON: &str = "arc.json";

/// How an archived arc ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveFate {
    /// Its work landed on the base.
    Joined,
    /// Its branch was discarded, and its paperwork deleted later.
    Discarded,
    /// Its paperwork was deleted with no terminal line behind it: a door that
    /// never cut a branch, or one the log never heard of.
    Abandoned,
}

impl ArchiveFate {
    /// The wire and `arc.json` spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ArchiveFate::Joined => "joined",
            ArchiveFate::Discarded => "discarded",
            ArchiveFate::Abandoned => "abandoned",
        }
    }
}

/// One archived generation of an arc: its `arc.json`, and where it lies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveEntry {
    pub name: String,
    /// The generation's start, in the arc log's ISO form — or, for a name the
    /// log never recorded, the earliest mtime among its files.
    pub created: String,
    pub archived_at: String,
    pub fate: ArchiveFate,
    /// The squash commit, full sha. Only for [`ArchiveFate::Joined`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch_id: Option<String>,
    /// The top-level names the entry holds beside `arc.json`, sorted.
    #[serde(default)]
    pub files: Vec<String>,
    /// The entry's directory. Read from where it was found, never stored.
    #[serde(skip)]
    pub dir: PathBuf,
}

impl ArchiveEntry {
    /// The entry's key, `<name>/<stamp>`: what an op file records so an undo
    /// knows which entry to restore.
    pub fn key(&self) -> String {
        format!("{}/{}", self.name, compact_stamp(&self.created))
    }
}

/// What [`restore_documents`] put back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreOutcome {
    /// The recreated `.tug/arcs/<name>/`.
    pub dir: PathBuf,
    /// The top-level names copied into it, sorted.
    pub files: Vec<String>,
}

/// `<project_state_dir>/arc-archive`. The state dir folds a linked worktree
/// to its checkout, so an arc worktree and its checkout share one archive.
pub fn archive_root(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join("arc-archive")
}

/// An ISO timestamp reduced to the entry's directory name, `YYYYMMDDTHHMMSSZ`:
/// `-` and `:` dropped, fractional seconds dropped. A stamp already compact
/// reduces to itself, so either spelling can name an entry.
pub fn compact_stamp(created: &str) -> String {
    let whole = created.split('.').next().unwrap_or(created);
    let mut stamp: String = whole.chars().filter(|c| *c != '-' && *c != ':').collect();
    if !stamp.ends_with('Z') {
        stamp.push('Z');
    }
    stamp
}

/// Archive `.tug/arcs/<name>/` as the entry for its newest generation.
///
/// The files are copied into a dot-named scratch directory, `arc.json` is
/// written last, and the scratch directory is renamed into place, so a reader
/// never sees half an entry; a crash leaves a dot-named directory every reader
/// skips. Archiving a generation that already has an entry replaces it — the
/// newer copy holds everything the older did.
///
/// The working directory is left exactly as it was: removing it is the
/// caller's, and only after this returned `Ok`.
pub fn archive_documents(
    paths: &Paths,
    repo: &Path,
    name: &str,
    fate: ArchiveFate,
    join_sha: Option<&str>,
    base_branch: Option<&str>,
) -> Result<ArchiveEntry, ArcError> {
    validate_arc_name(name).map_err(ArcError::InvalidName)?;
    let source = documents_dir(repo, name);
    if !source.is_dir() {
        return Err(ArcError::Refused(format!(
            "nothing to archive: .tug/arcs/{name}/ does not exist"
        )));
    }
    crate::log::refuse_unredirected_temp_repo(paths, repo);

    let created = match generation_start(paths, repo, name) {
        Some(start) => start,
        None => earliest_mtime_iso(&source).unwrap_or_else(now_iso8601),
    };
    // The last text is always a version: the stage that wrote it may not have
    // recorded it. A sketch that cannot be recorded leaves the entry without
    // an id, never the archive unwritten.
    let sketch_id = if source.join("sketch.md").is_file() {
        crate::sketch::record_arc_sketch(
            paths,
            repo,
            name,
            &crate::work_log::By::none(),
            crate::sketch::Written::AtTheTime,
        )
        .ok()
        .map(|r| r.id)
    } else {
        None
    };
    let stamp = compact_stamp(&created);
    let name_dir = archive_root(paths, repo).join(name);
    fs::create_dir_all(&name_dir)
        .map_err(|e| ArcError::io("could not create the archive", &name_dir, e))?;

    let tmp = name_dir.join(format!(".{stamp}.tmp-{}", unique_suffix()));
    let files = copy_tree(&source, &tmp, true)?;

    let mut entry = ArchiveEntry {
        name: name.to_string(),
        created,
        archived_at: now_iso8601(),
        fate,
        join_sha: join_sha
            .filter(|_| fate == ArchiveFate::Joined)
            .map(str::to_owned),
        base_branch: base_branch.map(str::to_owned),
        sketch_id,
        files,
        dir: PathBuf::new(),
    };
    let json = serde_json::to_string_pretty(&entry)
        .map_err(|e| ArcError::Refused(format!("could not serialize {ARC_JSON}: {e}")))?;
    let json_path = tmp.join(ARC_JSON);
    fs::write(&json_path, json + "\n")
        .map_err(|e| ArcError::io("could not write the archive record", &json_path, e))?;

    let dir = name_dir.join(&stamp);
    replace_entry(&name_dir, &stamp, &tmp, &dir)?;
    entry.dir = dir;
    Ok(entry)
}

/// Move a finished scratch directory into place as `<name_dir>/<stamp>`.
///
/// **This is the archive's one removal, and it removes only the superseded
/// copy of the same generation.** When `<stamp>` already exists (a join undone
/// and joined again), the old copy is first renamed aside to a dot-named
/// directory, the new one renamed into place, and only then is the old one
/// removed. Every other path in this module adds and never takes away; a
/// future removal on the archive belongs here, where it can be reviewed.
fn replace_entry(name_dir: &Path, stamp: &str, tmp: &Path, dir: &Path) -> Result<(), ArcError> {
    let old = if dir.exists() {
        let old = name_dir.join(format!(".{stamp}.old-{}", unique_suffix()));
        fs::rename(dir, &old)
            .map_err(|e| ArcError::io("could not set the earlier archive aside", dir, e))?;
        Some(old)
    } else {
        None
    };
    fs::rename(tmp, dir).map_err(|e| ArcError::io("could not place the archive", dir, e))?;
    if let Some(old) = old {
        // The new copy is in place; the old one is the same generation's and
        // superseded. A failure here leaves a dot-named directory readers skip.
        let _ = fs::remove_dir_all(&old);
    }
    Ok(())
}

/// Every archived generation of `name`, newest first.
pub fn entries(paths: &Paths, repo: &Path, name: &str) -> Vec<ArchiveEntry> {
    if validate_arc_name(name).is_err() {
        return Vec::new();
    }
    let mut found = entries_in(&archive_root(paths, repo).join(name));
    found.sort_by_key(|e| std::cmp::Reverse(stamp_of(e)));
    found
}

/// One archived generation of `name`: the one whose start is `created` (the
/// ISO form or the compact stamp), or the newest when `created` is `None`.
pub fn entry(
    paths: &Paths,
    repo: &Path,
    name: &str,
    created: Option<&str>,
) -> Option<ArchiveEntry> {
    let all = entries(paths, repo, name);
    match created {
        None => all.into_iter().next(),
        Some(created) => {
            let want = compact_stamp(created);
            all.into_iter().find(|e| stamp_of(e) == want)
        }
    }
}

/// Every archived generation of every name in this checkout, newest first.
pub fn all_entries(paths: &Paths, repo: &Path) -> Vec<ArchiveEntry> {
    let root = archive_root(paths, repo);
    let mut found: Vec<ArchiveEntry> = visible_dirs(&root)
        .into_iter()
        .flat_map(|d| entries_in(&d))
        .collect();
    found.sort_by_key(|e| std::cmp::Reverse(stamp_of(e)));
    found
}

/// Put an archived entry's documents back at `.tug/arcs/<name>/`.
///
/// `key` is `<name>/<stamp>` ([`ArchiveEntry::key`]). Every file is copied
/// except `arc.json`, which describes the entry rather than belonging to the
/// arc. Refuses, touching nothing, when `.tug/arcs/<name>/` already exists:
/// a restore never overwrites documents somebody may since have written. The
/// entry itself stays, because it is a record.
pub fn restore_documents(
    paths: &Paths,
    repo: &Path,
    key: &str,
) -> Result<RestoreOutcome, ArcError> {
    let Some((name, stamp)) = key.split_once('/') else {
        return Err(ArcError::Refused(format!(
            "not an archive key: {key} (expected <name>/<stamp>)"
        )));
    };
    validate_arc_name(name).map_err(ArcError::InvalidName)?;
    let Some(found) = entry(paths, repo, name, Some(stamp)) else {
        return Err(ArcError::NotFound {
            name: key.to_string(),
        });
    };
    let target = documents_dir(repo, name);
    if target.exists() {
        return Err(ArcError::Refused(format!(
            "documents not restored: .tug/arcs/{name}/ already exists"
        )));
    }
    let files = copy_tree(&found.dir, &target, true)?;
    Ok(RestoreOutcome { dir: target, files })
}

/// Archive `.tug/arcs/<name>/` as a joined arc's documents, then remove it.
///
/// Removal is conditional on the archive: an archive that failed keeps the
/// directory and says so in `warnings`, because the documents are the only
/// copy. Shared by the join's teardown and by a redo of an undone join, which
/// re-lands the join onto the documents the undo restored.
pub(crate) fn archive_joined_then_remove(
    paths: &Paths,
    repo: &Path,
    name: &str,
    join_sha: &str,
    base_branch: &str,
    warnings: &mut Vec<String>,
) {
    let documents = documents_dir(repo, name);
    match archive_documents(
        paths,
        repo,
        name,
        ArchiveFate::Joined,
        Some(join_sha),
        Some(base_branch),
    ) {
        Ok(entry) => match fs::remove_dir_all(&documents) {
            Ok(()) => warnings.push(format!(
                "archived .tug/arcs/{name}/ to {}",
                entry.dir.display()
            )),
            Err(e) => warnings.push(format!(
                "archived .tug/arcs/{name}/ to {} but could not remove it: {e}",
                entry.dir.display()
            )),
        },
        Err(e) => warnings.push(format!(
            "could not archive .tug/arcs/{name}/: {e}; the documents were kept"
        )),
    }
}

// --- reading -----------------------------------------------------------------

/// The directory's subdirectories whose names do not begin with `.`, which is
/// how every reader skips a scratch or set-aside copy a crash left behind.
fn visible_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    read.flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect()
}

/// The entries under one name's directory, unsorted. An entry whose
/// `arc.json` is missing or does not parse is not an entry.
fn entries_in(name_dir: &Path) -> Vec<ArchiveEntry> {
    visible_dirs(name_dir)
        .into_iter()
        .filter_map(|dir| {
            let text = fs::read_to_string(dir.join(ARC_JSON)).ok()?;
            let mut entry: ArchiveEntry = serde_json::from_str(&text).ok()?;
            entry.dir = dir;
            Some(entry)
        })
        .collect()
}

/// The stamp an entry is filed under: its directory's name, which sorts by
/// time within and across names.
fn stamp_of(entry: &ArchiveEntry) -> String {
    entry
        .dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| compact_stamp(&entry.created))
}

// --- copying -----------------------------------------------------------------

/// Copy `from` into a new directory `to`, recursively, skipping symlinks and
/// (when `skip_record`) a top-level `arc.json`. Returns the top-level names
/// copied, sorted.
fn copy_tree(from: &Path, to: &Path, skip_record: bool) -> Result<Vec<String>, ArcError> {
    fs::create_dir_all(to).map_err(|e| ArcError::io("could not create a directory", to, e))?;
    let read = fs::read_dir(from).map_err(|e| ArcError::io("could not read", from, e))?;
    let mut names = Vec::new();
    for item in read {
        let item = item.map_err(|e| ArcError::io("could not read", from, e))?;
        let file_name = item.file_name();
        let name = file_name.to_string_lossy().into_owned();
        if skip_record && name == ARC_JSON {
            continue;
        }
        let kind = item
            .file_type()
            .map_err(|e| ArcError::io("could not read", item.path(), e))?;
        let dest = to.join(&file_name);
        if kind.is_dir() {
            copy_tree(&item.path(), &dest, false)?;
        } else if kind.is_file() {
            fs::copy(item.path(), &dest)
                .map_err(|e| ArcError::io("could not copy", item.path(), e))?;
        } else {
            // A symlink (or anything stranger) is not a document.
            continue;
        }
        names.push(name);
    }
    names.sort();
    Ok(names)
}

/// The earliest modification time among the directory's files, as ISO —
/// the start of a generation the arc log never recorded.
fn earliest_mtime_iso(dir: &Path) -> Option<String> {
    fn walk(dir: &Path, earliest: &mut Option<SystemTime>) {
        let Ok(read) = fs::read_dir(dir) else {
            return;
        };
        for item in read.flatten() {
            let Ok(kind) = item.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&item.path(), earliest);
            } else if kind.is_file()
                && let Ok(modified) = item.metadata().and_then(|m| m.modified())
            {
                *earliest = Some(earliest.map_or(modified, |e| e.min(modified)));
            }
        }
    }
    let mut earliest = None;
    walk(dir, &mut earliest);
    earliest.map(|t| {
        chrono::DateTime::<chrono::Utc>::from(t)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
}

/// A suffix no other scratch directory of this process shares.
fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A checkout and a redirected data root, side by side in one scratch
    /// directory. The checkout needs no git: the documents home and the state
    /// dir both resolve a plain directory to itself.
    fn scratch() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        (temp, repo, paths)
    }

    fn write_docs(repo: &Path, name: &str, files: &[(&str, &str)]) {
        let dir = documents_dir(repo, name);
        fs::create_dir_all(&dir).unwrap();
        for (file, text) in files {
            fs::write(dir.join(file), text).unwrap();
        }
    }

    fn log_lines(paths: &Paths, repo: &Path, text: &str) {
        let log = tugtool_core::paths::arc_log_path_at(paths, repo);
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(log, text).unwrap();
    }

    #[test]
    fn compact_stamp_drops_separators_and_fractions() {
        assert_eq!(
            compact_stamp("2026-11-22T14:59:33.128Z"),
            "20261122T145933Z"
        );
        assert_eq!(compact_stamp("2026-11-22T14:59:33Z"), "20261122T145933Z");
        assert_eq!(compact_stamp("20261122T145933Z"), "20261122T145933Z");
    }

    #[test]
    fn an_archive_round_trips_its_record_and_its_bytes() {
        let (_temp, repo, paths) = scratch();
        log_lines(
            &paths,
            &repo,
            "2026-11-22T14:59:33.128Z  wedge  arc-start  arc/wedge-brief.md\n",
        );
        write_docs(
            &repo,
            "wedge",
            &[
                ("brief.md", "# Brief\n\nbody\n"),
                ("plan.md", "# Plan\n"),
                ("sketch.md", "# Sketch\n\nWant it kept.\n"),
            ],
        );
        fs::create_dir_all(documents_dir(&repo, "wedge").join("notes")).unwrap();
        fs::write(documents_dir(&repo, "wedge").join("notes/a.md"), "a").unwrap();

        let made = archive_documents(
            &paths,
            &repo,
            "wedge",
            ArchiveFate::Joined,
            Some("a3406190155c"),
            Some("main"),
        )
        .unwrap();
        assert_eq!(made.key(), "wedge/20261122T145933Z");
        assert!(
            documents_dir(&repo, "wedge").is_dir(),
            "the source is the caller's"
        );

        let read = entry(&paths, &repo, "wedge", None).unwrap();
        assert_eq!(read, made);
        assert_eq!(read.created, "2026-11-22T14:59:33.128Z");
        assert_eq!(read.fate, ArchiveFate::Joined);
        assert_eq!(read.join_sha.as_deref(), Some("a3406190155c"));
        assert_eq!(read.base_branch.as_deref(), Some("main"));
        let sketch_id = read
            .sketch_id
            .clone()
            .expect("the archive records the sketch");
        let sketch = crate::sketch::find_sketch(&paths, &sketch_id);
        assert_eq!(
            crate::sketch::read_version(&sketch[0].1, None).unwrap(),
            fs::read_to_string(read.dir.join("sketch.md")).unwrap(),
            "the sketch's latest version is the archived text"
        );
        assert_eq!(
            read.files,
            vec!["brief.md", "notes", "plan.md", "sketch.md"]
        );
        assert_eq!(
            fs::read(read.dir.join("brief.md")).unwrap(),
            b"# Brief\n\nbody\n"
        );
        assert_eq!(fs::read(read.dir.join("notes/a.md")).unwrap(), b"a");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(read.dir.join(ARC_JSON)).unwrap()).unwrap();
        assert_eq!(json["fate"], "joined");
        assert!(json.get("dir").is_none(), "where it lies is never stored");

        assert_eq!(
            entry(&paths, &repo, "wedge", Some("2026-11-22T14:59:33.128Z")),
            Some(made.clone())
        );
        assert_eq!(
            entry(&paths, &repo, "wedge", Some("20261122T145933Z")),
            Some(made)
        );
        assert_eq!(
            entry(&paths, &repo, "wedge", Some("20250101T000000Z")),
            None
        );
    }

    #[test]
    fn a_join_sha_is_kept_only_for_a_join() {
        let (_temp, repo, paths) = scratch();
        write_docs(&repo, "gone", &[("brief.md", "b")]);
        let made = archive_documents(
            &paths,
            &repo,
            "gone",
            ArchiveFate::Discarded,
            Some("abc"),
            None,
        )
        .unwrap();
        assert_eq!(made.join_sha, None);
    }

    #[test]
    fn archiving_a_generation_again_replaces_its_entry() {
        let (_temp, repo, paths) = scratch();
        log_lines(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  again  arc-start  arc/again-brief.md\n",
        );
        write_docs(&repo, "again", &[("brief.md", "first")]);
        archive_documents(&paths, &repo, "again", ArchiveFate::Joined, None, None).unwrap();
        fs::write(documents_dir(&repo, "again").join("brief.md"), "second").unwrap();
        let second =
            archive_documents(&paths, &repo, "again", ArchiveFate::Joined, None, None).unwrap();

        let listed = fs::read_dir(archive_root(&paths, &repo).join("again"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            vec!["20261101T000000Z"],
            "exactly one entry, no leftovers"
        );
        assert_eq!(fs::read(second.dir.join("brief.md")).unwrap(), b"second");
    }

    #[test]
    fn two_generations_are_two_entries_newest_first() {
        let (_temp, repo, paths) = scratch();
        log_lines(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  twice  arc-start  arc/twice-brief.md\n",
        );
        write_docs(&repo, "twice", &[("brief.md", "older")]);
        archive_documents(&paths, &repo, "twice", ArchiveFate::Joined, None, None).unwrap();
        log_lines(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  twice  arc-start  arc/twice-brief.md\n\
             2026-11-01T00:05:00Z  twice  1111222  joined\n\
             2026-11-02T00:00:00Z  twice  arc-start  arc/twice-brief.md\n\
             2026-11-02T00:05:00Z  twice  discarded\n",
        );
        fs::write(documents_dir(&repo, "twice").join("brief.md"), "newer").unwrap();
        archive_documents(&paths, &repo, "twice", ArchiveFate::Discarded, None, None).unwrap();

        let all = entries(&paths, &repo, "twice");
        assert_eq!(
            all.iter().map(|e| e.created.as_str()).collect::<Vec<_>>(),
            vec!["2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z"]
        );
        assert_eq!(fs::read(all[0].dir.join("brief.md")).unwrap(), b"newer");
        assert_eq!(fs::read(all[1].dir.join("brief.md")).unwrap(), b"older");

        write_docs(&repo, "other", &[("brief.md", "x")]);
        log_lines(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  twice  arc-start  arc/twice-brief.md\n\
             2026-11-03T00:00:00Z  other  arc-start  arc/other-brief.md\n",
        );
        archive_documents(&paths, &repo, "other", ArchiveFate::Abandoned, None, None).unwrap();
        let every = all_entries(&paths, &repo);
        assert_eq!(
            every.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["other", "twice", "twice"]
        );
    }

    #[test]
    fn a_name_the_log_never_recorded_dates_from_its_files() {
        let (_temp, repo, paths) = scratch();
        write_docs(&repo, "unlogged", &[("brief.md", "b")]);
        let made = archive_documents(
            &paths,
            &repo,
            "unlogged",
            ArchiveFate::Abandoned,
            None,
            None,
        )
        .unwrap();
        let brief = documents_dir(&repo, "unlogged").join("brief.md");
        let mtime =
            chrono::DateTime::<chrono::Utc>::from(fs::metadata(brief).unwrap().modified().unwrap())
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert_eq!(made.created, mtime);
    }

    #[test]
    fn a_missing_source_is_refused() {
        let (_temp, repo, paths) = scratch();
        let err = archive_documents(&paths, &repo, "nothing", ArchiveFate::Joined, None, None)
            .unwrap_err();
        assert!(matches!(err, ArcError::Refused(_)), "{err}");
    }

    #[test]
    fn leftover_scratch_and_set_aside_dirs_are_ignored() {
        let (_temp, repo, paths) = scratch();
        write_docs(&repo, "crashy", &[("brief.md", "b")]);
        let made =
            archive_documents(&paths, &repo, "crashy", ArchiveFate::Joined, None, None).unwrap();
        let name_dir = archive_root(&paths, &repo).join("crashy");
        for leftover in [".20260101T000000Z.tmp-1-2", ".20991231T000000Z.old-1-2"] {
            let dir = name_dir.join(leftover);
            fs::create_dir_all(&dir).unwrap();
            fs::copy(made.dir.join(ARC_JSON), dir.join(ARC_JSON)).unwrap();
        }
        fs::create_dir_all(archive_root(&paths, &repo).join(".tmp-name")).unwrap();
        assert_eq!(entries(&paths, &repo, "crashy"), vec![made.clone()]);
        assert_eq!(all_entries(&paths, &repo), vec![made]);
    }

    #[test]
    fn a_restore_refuses_over_existing_documents_and_copies_otherwise() {
        let (_temp, repo, paths) = scratch();
        write_docs(
            &repo,
            "back",
            &[("brief.md", "the brief"), ("sketch.md", "the sketch")],
        );
        let made =
            archive_documents(&paths, &repo, "back", ArchiveFate::Joined, None, None).unwrap();

        let err = restore_documents(&paths, &repo, &made.key()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "documents not restored: .tug/arcs/back/ already exists"
        );

        fs::remove_dir_all(documents_dir(&repo, "back")).unwrap();
        let restored = restore_documents(&paths, &repo, &made.key()).unwrap();
        assert_eq!(restored.files, vec!["brief.md", "sketch.md"]);
        assert!(
            !restored.dir.join(ARC_JSON).exists(),
            "arc.json is the entry's"
        );
        assert_eq!(
            fs::read(restored.dir.join("brief.md")).unwrap(),
            b"the brief"
        );
        assert_eq!(
            fs::read(restored.dir.join("sketch.md")).unwrap(),
            b"the sketch"
        );
        assert!(made.dir.is_dir(), "the entry stays, because it is a record");

        assert!(matches!(
            restore_documents(&paths, &repo, "back/20000101T000000Z"),
            Err(ArcError::NotFound { .. })
        ));
    }
}
