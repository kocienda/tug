//! The brief record: a brief's own id, every path it has had, the sketches it
//! came from, who wrote it, and the commits that changed it.
//!
//! ```text
//! <project_state_dir>/briefs/
//!     briefs.lock
//!     <id>/brief.json
//! ```
//!
//! A brief is a file in the project, and a path is what a person types, so a
//! cycle used to name its briefs by path, and a rename broke the link. The
//! record gives the brief an identity of its own, kept outside the project
//! beside the sketch store: eight lowercase hex characters, unique across
//! every checkout's store under the data root.
//!
//! The brief carries its id too, as one comment line at the top of the file
//! (`<!-- tug-brief: <id> -->`), written only by [`record`], which is what the
//! brief skill's verb runs. A brief is found by that line first, then by its
//! path, then by following git's rename detection from the record's last
//! path, because each alone fails: a hand edit drops the line, and heavy
//! edits defeat the detection.
//!
//! [`ensure`] is how every other writer reaches a brief's record. It finds or
//! mints one and never opens the brief for write, so a reader such as the
//! bring-forward of an old cycle never dirties a tracked file in the user's
//! tree.
//!
//! Locks are taken in the one order [`crate::record_lock`] states: the store's
//! `briefs.lock`, then one record's `brief.json.lock`, then the work log's.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::error::ArcError;
use crate::ops::{first_heading, main_repo_root};
use crate::record_lock::{LockMode, hold};
use crate::sketch::{valid_id, write_atomically};
use crate::work_log::{self, By, Privacy, WorkKind, WorkObject};

/// The record file in each brief's directory.
pub const BRIEF_JSON: &str = "brief.json";

/// The file a writer of one brief's record locks.
const BRIEF_LOCK: &str = "brief.json.lock";

/// The file a writer locks in the store root while it finds or mints a record,
/// so two writers recording one path end with one record.
const STORE_LOCK: &str = "briefs.lock";

/// One path a brief has had, and when it was first seen there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BriefPath {
    pub path: String,
    pub at: String,
}

/// One commit that changed the brief.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BriefVersion {
    pub sha: String,
    /// The commit's time, in UTC.
    pub at: String,
}

/// A brief's record: its `brief.json`, and where it lies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BriefRecord {
    pub id: String,
    pub created: String,
    /// The checkout the brief belongs to, in the gateway's canonical form.
    pub project_dir: String,
    /// The current path, relative to the project root.
    pub path: String,
    /// Every path it has had, oldest first, the current one last.
    #[serde(default)]
    pub paths: Vec<BriefPath>,
    /// The file's first heading, refreshed whenever the record is reached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The sketches it came from, by id.
    #[serde(default)]
    pub sketches: Vec<String>,
    /// The session that wrote it; `None` when that session is private or
    /// nothing said which session it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_by: Option<String>,
    /// One per commit that changed it, oldest first.
    #[serde(default)]
    pub versions: Vec<BriefVersion>,
    /// The record's directory. Read from where it was found, never stored.
    #[serde(skip)]
    pub dir: PathBuf,
}

impl BriefRecord {
    /// When the record last changed: its newest version, its newest path, or
    /// its creation, whichever is latest.
    pub fn updated(&self) -> &str {
        let mut latest = self.created.as_str();
        for at in self
            .versions
            .iter()
            .map(|v| v.at.as_str())
            .chain(self.paths.iter().map(|p| p.at.as_str()))
        {
            if at > latest {
                latest = at;
            }
        }
        latest
    }
}

/// What [`ensure`] or [`record`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BriefOutcome {
    pub id: String,
    /// The brief's current path, relative to the project root.
    pub path: String,
    /// Whether this call minted the record.
    pub minted: bool,
    /// The path the record held before this call found the brief at a new one.
    pub moved_from: Option<String>,
    /// Whether this call wrote the id line into the brief.
    pub id_line_written: bool,
}

/// `<project_state_dir>/briefs`.
pub fn brief_root(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join("briefs")
}

/// The id a brief's text carries, when its first non-empty line is exactly
/// `<!-- tug-brief: <id> -->`. Whitespace inside the comment is tolerated; a
/// line anywhere but first is not an id line.
pub fn id_line(text: &str) -> Option<&str> {
    let first = text.lines().find(|l| !l.trim().is_empty())?.trim();
    let inner = first.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    let id = inner.strip_prefix("tug-brief:")?.trim();
    valid_id(id).then_some(id)
}

/// The id line for `id`, as it is written.
fn id_line_text(id: &str) -> String {
    format!("<!-- tug-brief: {id} -->")
}

/// Write the id line above the first line of `file`, unless the file already
/// carries one. Returns whether it wrote.
fn write_id_line(file: &Path, id: &str) -> Result<bool, ArcError> {
    let text =
        fs::read_to_string(file).map_err(|e| ArcError::io("could not read the brief", file, e))?;
    if id_line(&text).is_some() {
        return Ok(false);
    }
    let written = format!("{}\n{text}", id_line_text(id));
    write_atomically(file, written.as_bytes(), "brief")?;
    Ok(true)
}

/// A brief path as the record keeps it: trimmed, any leading `./` taken off,
/// and an absolute path inside the checkout made relative to its root.
/// Refused when empty or outside the checkout.
fn relative_path(repo: &Path, brief: &str) -> Result<String, ArcError> {
    let brief = crate::cycle::normal_brief(brief);
    if brief.is_empty() {
        return Err(ArcError::Refused("no brief path was given".into()));
    }
    let given = Path::new(brief);
    if !given.is_absolute() {
        return Ok(brief.to_string());
    }
    let root = main_repo_root(repo);
    let canonical = |p: &Path| tugcore::pathform::resolve_to_claude_form(p);
    let inside = given
        .strip_prefix(&root)
        .ok()
        .map(Path::to_path_buf)
        .or_else(|| {
            canonical(given)
                .strip_prefix(canonical(&root))
                .ok()
                .map(Path::to_path_buf)
        });
    match inside {
        Some(rel) if !rel.as_os_str().is_empty() => Ok(rel.to_string_lossy().into_owned()),
        _ => Err(ArcError::Refused(format!(
            "{brief} is outside the checkout at {}",
            root.display()
        ))),
    }
}

/// Find the record of the brief at `path`, without minting one: by the
/// file's id line, then by the record's current path, then by following a
/// rename from a record whose path is gone from disk. A record found at a
/// new path is recorded as moved there.
pub fn resolve(paths: &Paths, repo: &Path, path: &str) -> Option<BriefRecord> {
    resolve_moving(paths, repo, path).map(|(record, _)| record)
}

/// [`resolve`], and the path the record held before when it moved.
fn resolve_moving(
    paths: &Paths,
    repo: &Path,
    path: &str,
) -> Option<(BriefRecord, Option<String>)> {
    let rel = relative_path(repo, path).ok()?;
    let root = main_repo_root(repo);
    let file = root.join(&rel);
    let text = fs::read_to_string(&file).ok();
    let carried = text.as_deref().and_then(id_line);
    let here = project_dir_of(repo);

    if let Some(id) = carried {
        let found = read_record(&brief_root(paths, repo).join(id))
            .or_else(|| find_brief(paths, id).into_iter().next().map(|(_, r)| r));
        if let Some(record) = found {
            return Some(moved_if_new(record, &rel, &here));
        }
    }

    let records = briefs(paths, repo);
    if let Some(record) = records.iter().find(|r| r.path == rel) {
        return Some((record.clone(), None));
    }

    text.as_ref()?;
    // Only a record whose path is gone can have been renamed, and nothing
    // under `.tug/` is tracked: every joined arc's own brief is gone from disk.
    let candidates: Vec<&BriefRecord> = records
        .iter()
        .filter(|r| !r.path.starts_with(".tug/") && !root.join(&r.path).exists())
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let since = candidates
        .iter()
        .filter_map(|r| r.paths.last().map(|p| p.at.as_str()))
        .min();
    let froms: Vec<&str> = candidates.iter().map(|r| r.path.as_str()).collect();
    let followed = follow_renames(&root, &froms, since);
    let record = candidates
        .iter()
        .zip(followed)
        .find(|(r, to)| {
            to.as_deref() == Some(rel.as_str()) && carried.is_none_or(|id| id == r.id)
        })
        .map(|(r, _)| (*r).clone())?;
    Some(moved_if_new(record, &rel, &here))
}

/// `record` found at `rel`: when that is not its path and it belongs to this
/// checkout, the move is written and the old path returned beside it.
fn moved_if_new(
    record: BriefRecord,
    rel: &str,
    here: &str,
) -> (BriefRecord, Option<String>) {
    if record.path == rel || record.project_dir != here {
        return (record, None);
    }
    let from = record.path.clone();
    let dir = record.dir.clone();
    let moved = update(&dir, |r| {
        if r.path == rel {
            return false;
        }
        r.path = rel.to_string();
        r.paths.push(BriefPath {
            path: rel.to_string(),
            at: now_iso8601(),
        });
        true
    });
    match moved {
        Ok(Some(record)) => (record, Some(from)),
        Ok(None) => (record, None),
        Err(e) => {
            eprintln!("could not record the brief's move to {rel}: {e}");
            (record, None)
        }
    }
}

/// Where each of `froms` went, following renames through committed history
/// since `since` and then through what is staged, in one walk for all of
/// them. A destination that is not on disk is no answer. A git failure is no
/// answer for any.
pub fn follow_renames(root: &Path, froms: &[&str], since: Option<&str>) -> Vec<Option<String>> {
    #[cfg(test)]
    tests::RENAME_WALKS.with(|n| n.set(n.get() + 1));
    let mut current: Vec<String> = froms.iter().map(|f| f.to_string()).collect();
    let since_arg = since.map(|s| format!("--since={s}"));
    let mut log_args = vec![
        "log",
        "-M",
        "--diff-filter=R",
        "--name-status",
        "--format=",
        "--reverse",
    ];
    if let Some(arg) = since_arg.as_deref() {
        log_args.push(arg);
    }
    log_args.push("HEAD");
    let staged = ["diff", "--cached", "-M", "--diff-filter=R", "--name-status"];
    for args in [&log_args[..], &staged[..]] {
        let Some(out) = git_text(root, args) else {
            continue;
        };
        for line in out.lines() {
            let mut fields = line.split('\t');
            let (Some(status), Some(old), Some(new)) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            if !status.starts_with('R') {
                continue;
            }
            for c in current.iter_mut().filter(|c| c.as_str() == old) {
                *c = new.to_string();
            }
        }
    }
    current
        .into_iter()
        .zip(froms)
        .map(|(to, from)| (to != *from && root.join(&to).exists()).then_some(to))
        .collect()
}

/// Where the brief at `from` went, by [`follow_renames`] over all of history.
pub fn follow_rename(root: &Path, from: &str) -> Option<String> {
    follow_renames(root, &[from], None).pop().flatten()
}

/// Find or mint the record of the brief at `path`, never writing the brief.
///
/// A miss mints a record, adopting the id the file's id line carries when no
/// store holds it. A path with no file is recorded all the same: an entry may
/// name a brief that has since been deleted, or an arc's own brief after its
/// join. `written_by` is set only when the record is minted, and never for a
/// private session.
pub fn ensure(paths: &Paths, repo: &Path, path: &str, by: &By) -> Result<BriefOutcome, ArcError> {
    let rel = relative_path(repo, path)?;
    crate::log::refuse_unredirected_temp_repo(paths, repo);
    let store = brief_root(paths, repo);
    fs::create_dir_all(&store).map_err(|e| ArcError::io("could not create the brief store", &store, e))?;
    let held = hold(&store, STORE_LOCK, LockMode::Wait)?;

    let file = main_repo_root(repo).join(&rel);
    let text = fs::read_to_string(&file).ok();
    let title = text.as_deref().and_then(first_heading);

    let outcome = match resolve_moving(paths, repo, &rel) {
        Some((record, moved_from)) => {
            let id = record.id.clone();
            if text.is_some() && record.title != title && record.project_dir == project_dir_of(repo) {
                let title = title.clone();
                if let Err(e) = update(&record.dir, move |r| {
                    let changed = r.title != title;
                    r.title = title.clone();
                    changed
                }) {
                    eprintln!("could not refresh brief {id}'s title: {e}");
                }
            }
            if let Some(from) = &moved_from {
                log_line(
                    paths,
                    repo,
                    WorkKind::BriefRecorded,
                    &id,
                    serde_json::json!({ "path": record.path, "moved_from": from, "title": title.as_ref().or(record.title.as_ref()) }),
                    by,
                );
            }
            BriefOutcome {
                id,
                path: record.path,
                minted: false,
                moved_from,
                id_line_written: false,
            }
        }
        None => {
            let carried = text
                .as_deref()
                .and_then(id_line)
                .filter(|id| find_brief(paths, id).is_empty())
                .map(str::to_string);
            let id = carried.unwrap_or_else(|| mint_id(paths));
            let now = now_iso8601();
            let record = BriefRecord {
                id: id.clone(),
                created: now.clone(),
                project_dir: project_dir_of(repo),
                path: rel.clone(),
                paths: vec![BriefPath {
                    path: rel.clone(),
                    at: now,
                }],
                title,
                sketches: Vec::new(),
                written_by: match by.privacy {
                    Privacy::Private => None,
                    _ => by.session.clone(),
                },
                versions: Vec::new(),
                dir: store.join(&id),
            };
            write_record(&record)?;
            log_line(
                paths,
                repo,
                WorkKind::BriefRecorded,
                &id,
                serde_json::json!({ "path": rel, "title": record.title }),
                by,
            );
            BriefOutcome {
                id,
                path: rel,
                minted: true,
                moved_from: None,
                id_line_written: false,
            }
        }
    };
    drop(held);
    Ok(outcome)
}

/// Record the brief at `path`: [`ensure`] its record, write the id line into
/// the file when it has none, and add `sketches` to the ones it came from.
/// Refused when there is no file at the path.
///
/// This is the one writer of the id line, and the brief skill's verb is the
/// one caller that should reach it.
pub fn record(
    paths: &Paths,
    repo: &Path,
    path: &str,
    sketches: &[String],
    by: &By,
) -> Result<BriefOutcome, ArcError> {
    let rel = relative_path(repo, path)?;
    let file = main_repo_root(repo).join(&rel);
    if !file.is_file() {
        return Err(ArcError::Refused(format!("no brief at {rel}")));
    }
    for sketch in sketches {
        if !valid_id(sketch) {
            return Err(ArcError::Refused(format!(
                "{sketch} is not a sketch id: eight lowercase hex characters"
            )));
        }
    }
    let mut outcome = ensure(paths, repo, &rel, by)?;
    let found = find_brief(paths, &outcome.id);
    let dir = found
        .into_iter()
        .map(|(_, r)| r.dir)
        .find(|d| d.starts_with(brief_root(paths, repo)))
        .unwrap_or_else(|| brief_root(paths, repo).join(&outcome.id));
    let _held = hold(&dir, BRIEF_LOCK, LockMode::Wait)?;
    outcome.id_line_written = write_id_line(&file, &outcome.id)?;
    if let Some(mut current) = read_record(&dir) {
        let before = current.sketches.len();
        for sketch in sketches {
            if !current.sketches.contains(sketch) {
                current.sketches.push(sketch.clone());
            }
        }
        if current.sketches.len() != before {
            write_record(&current)?;
        }
    }
    Ok(outcome)
}

/// Add commit `sha` as a version of every brief record whose path is among
/// `files`. Returns the ids that gained a version.
pub fn note_commit(
    paths: &Paths,
    repo: &Path,
    sha: &str,
    files: &[String],
    by: &By,
) -> Vec<String> {
    let files: Vec<&str> = files.iter().map(|f| crate::cycle::normal_brief(f)).collect();
    let mut noted = Vec::new();
    let mut at: Option<String> = None;
    for record in briefs(paths, repo) {
        if !files.contains(&record.path.as_str()) || record.versions.iter().any(|v| v.sha == sha) {
            continue;
        }
        let when = at
            .get_or_insert_with(|| commit_time(&main_repo_root(repo), sha).unwrap_or_else(now_iso8601))
            .clone();
        let version = BriefVersion {
            sha: sha.to_string(),
            at: when,
        };
        match update(&record.dir, |r| add_versions(r, std::slice::from_ref(&version))) {
            Ok(Some(_)) => {
                log_line(
                    paths,
                    repo,
                    WorkKind::BriefCommitted,
                    &record.id,
                    serde_json::json!({ "sha": sha, "path": record.path }),
                    by,
                );
                noted.push(record.id);
            }
            Ok(None) => {}
            Err(e) => eprintln!("could not note commit {sha} on brief {}: {e}", record.id),
        }
    }
    noted
}

/// Add every commit that changed the brief's path, following renames, that
/// the record does not already hold. Returns how many were added and leaves
/// `record` as it now is.
pub fn refresh_versions(
    paths: &Paths,
    repo: &Path,
    record: &mut BriefRecord,
) -> Result<usize, ArcError> {
    let root = main_repo_root(repo);
    let Some(out) = git_text(
        &root,
        &[
            "log",
            "--follow",
            "--format=%H%x09%cd",
            UTC_DATE,
            "--",
            &record.path,
        ],
    ) else {
        return Ok(0);
    };
    let mut found: Vec<BriefVersion> = out
        .lines()
        .filter_map(|l| {
            let (sha, at) = l.split_once('\t')?;
            Some(BriefVersion {
                sha: sha.trim().to_string(),
                at: at.trim().to_string(),
            })
        })
        .collect();
    found.reverse();
    let fresh: Vec<BriefVersion> = found
        .into_iter()
        .filter(|v| !record.versions.iter().any(|h| h.sha == v.sha))
        .collect();
    if fresh.is_empty() {
        return Ok(0);
    }
    let before: Vec<String> = record.versions.iter().map(|v| v.sha.clone()).collect();
    let Some(updated) = update(&record.dir, |r| add_versions(r, &fresh))? else {
        return Ok(0);
    };
    let added: Vec<&BriefVersion> = updated
        .versions
        .iter()
        .filter(|v| !before.contains(&v.sha) && fresh.iter().any(|f| f.sha == v.sha))
        .collect();
    for v in &added {
        log_line(
            paths,
            repo,
            WorkKind::BriefCommitted,
            &updated.id,
            serde_json::json!({ "sha": v.sha, "path": updated.path }),
            &By::none(),
        );
    }
    let n = added.len();
    *record = updated;
    Ok(n)
}

/// Add each of `versions` the record does not hold, keeping them oldest
/// first. Returns whether any was added.
fn add_versions(record: &mut BriefRecord, versions: &[BriefVersion]) -> bool {
    let mut added = false;
    for v in versions {
        if !record.versions.iter().any(|h| h.sha == v.sha) {
            record.versions.push(v.clone());
            added = true;
        }
    }
    if added {
        record.versions.sort_by(|a, b| a.at.cmp(&b.at));
    }
    added
}

/// Every record of `id` under the data root, each with the project state dir
/// it was found in.
pub fn find_brief(paths: &Paths, id: &str) -> Vec<(PathBuf, BriefRecord)> {
    if !valid_id(id) {
        return Vec::new();
    }
    let projects = paths.base_data_dir.join("projects");
    let Ok(read) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, BriefRecord)> = read
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter_map(|state| {
            let record = read_record(&state.join("briefs").join(id))?;
            Some((state, record))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// This checkout's briefs, the most recently changed first.
pub fn briefs(paths: &Paths, repo: &Path) -> Vec<BriefRecord> {
    let mut all = records_in(&brief_root(paths, repo));
    all.sort_by(|a, b| b.updated().cmp(a.updated()));
    all
}

/// Change the record in `dir` under its lock: re-read it, let `change` say
/// whether it changed anything, and write it when it did. `Ok(None)` when it
/// did not, or when no record is there.
fn update(
    dir: &Path,
    change: impl FnOnce(&mut BriefRecord) -> bool,
) -> Result<Option<BriefRecord>, ArcError> {
    if !dir.is_dir() {
        return Ok(None);
    }
    let _held = hold(dir, BRIEF_LOCK, LockMode::Wait)?;
    let Some(mut record) = read_record(dir) else {
        return Ok(None);
    };
    if !change(&mut record) {
        return Ok(None);
    }
    write_record(&record)?;
    Ok(Some(record))
}

/// Append a work-log line about brief `id`, saying so on stderr rather than
/// failing when it cannot: the record is the decision, the line is evidence.
fn log_line(
    paths: &Paths,
    repo: &Path,
    kind: WorkKind,
    id: &str,
    detail: serde_json::Value,
    by: &By,
) {
    let object = WorkObject::Brief {
        brief: id.to_string(),
    };
    if let Err(e) = work_log::append(paths, repo, kind, object, detail, by) {
        eprintln!("could not append {} to the work log: {e}", kind.as_str());
    }
}

/// The date format every version is written in: UTC, so versions compare
/// with each other and with the record's own times as strings.
const UTC_DATE: &str = "--date=format-local:%Y-%m-%dT%H:%M:%SZ";

/// When commit `sha` was made, in UTC.
fn commit_time(root: &Path, sha: &str) -> Option<String> {
    let out = git_text(root, &["show", "-s", "--format=%cd", UTC_DATE, sha])?;
    let at = out.trim();
    (!at.is_empty()).then(|| at.to_string())
}

/// What git printed for `args` in `root`, or `None` when it failed.
fn git_text(root: &Path, args: &[&str]) -> Option<String> {
    let out = tugcore::git_command()
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .current_dir(root)
        .env("TZ", "UTC")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// A fresh id no checkout's store under the data root already holds.
fn mint_id(paths: &Paths) -> String {
    loop {
        let id = format!("{:08x}", rand::random::<u32>());
        if find_brief(paths, &id).is_empty() {
            return id;
        }
    }
}

fn project_dir_of(repo: &Path) -> String {
    // [L29]: a persisted and compared path goes through the gateway.
    canonical_dir(&main_repo_root(repo))
}

fn canonical_dir(dir: &Path) -> String {
    tugcore::pathform::resolve_to_claude_form(dir)
        .to_string_lossy()
        .into_owned()
}

fn read_record(dir: &Path) -> Option<BriefRecord> {
    let text = fs::read_to_string(dir.join(BRIEF_JSON)).ok()?;
    let mut record: BriefRecord = serde_json::from_str(&text).ok()?;
    record.dir = dir.to_path_buf();
    record.project_dir = canonical_dir(Path::new(&record.project_dir));
    Some(record)
}

fn write_record(record: &BriefRecord) -> Result<(), ArcError> {
    fs::create_dir_all(&record.dir)
        .map_err(|e| ArcError::io("could not create the brief record", &record.dir, e))?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| ArcError::Refused(format!("could not serialize {BRIEF_JSON}: {e}")))?;
    write_atomically(&record.dir.join(BRIEF_JSON), (json + "\n").as_bytes(), "brief record")
}

fn records_in(root: &Path) -> Vec<BriefRecord> {
    let Ok(read) = fs::read_dir(root) else {
        return Vec::new();
    };
    read.filter_map(|e| e.ok())
        .filter(|e| valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| read_record(&e.path()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_support::{commit_all, git, init_git_repo};
    use std::cell::Cell;
    use tempfile::TempDir;

    thread_local! {
        /// How many rename walks this thread has run.
        pub(super) static RENAME_WALKS: Cell<usize> = const { Cell::new(0) };
    }

    fn walks() -> usize {
        RENAME_WALKS.with(Cell::get)
    }

    /// A repository with its state dir beside it, not inside it.
    fn scratch_repo() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        init_git_repo(&repo);
        let paths = Paths::under(&temp.path().join("state"));
        (temp, repo, paths)
    }

    fn write(repo: &Path, rel: &str, text: &str) {
        let file = repo.join(rel);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }

    fn public(session: &str) -> By {
        By {
            session: Some(session.into()),
            turn: Some(3),
            privacy: Privacy::Public,
            segments: Vec::new(),
        }
    }

    fn work_lines(paths: &Paths, repo: &Path) -> Vec<work_log::WorkLine> {
        work_log::read_lines(
            &fs::read_to_string(work_log::work_log_path(paths, repo)).unwrap_or_default(),
        )
    }

    const BODY: &str = "# The archive brief\n\nWhat was found.\n";

    #[test]
    fn record_mints_writes_the_id_line_once_and_keeps_the_id() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        let first = record(&paths, &repo, "briefs/a-brief.md", &[], &public("s1")).unwrap();
        assert!(first.minted && first.id_line_written);
        let text = fs::read_to_string(repo.join("briefs/a-brief.md")).unwrap();
        assert_eq!(text, format!("<!-- tug-brief: {} -->\n{BODY}", first.id));
        assert_eq!(id_line(&text), Some(first.id.as_str()));

        let again = record(&paths, &repo, "./briefs/a-brief.md", &[], &public("s1")).unwrap();
        assert_eq!(again.id, first.id);
        assert!(!again.minted && !again.id_line_written);
        assert_eq!(fs::read_to_string(repo.join("briefs/a-brief.md")).unwrap(), text);

        let found = find_brief(&paths, &first.id);
        assert_eq!(found.len(), 1);
        let r = &found[0].1;
        assert_eq!(r.title.as_deref(), Some("The archive brief"));
        assert_eq!(r.written_by.as_deref(), Some("s1"));
        assert_eq!(r.path, "briefs/a-brief.md");
    }

    #[test]
    fn a_brief_whose_id_line_was_edited_away_is_found_by_path() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        let first = record(&paths, &repo, "briefs/a-brief.md", &[], &By::none()).unwrap();
        write(&repo, "briefs/a-brief.md", BODY);
        assert_eq!(resolve(&paths, &repo, "briefs/a-brief.md").unwrap().id, first.id);
    }

    #[test]
    fn a_renamed_brief_that_lost_its_id_line_is_found_through_git() {
        let (_t, repo, paths) = scratch_repo();
        let body = "# Renamed brief\n\nA long enough body that git sees a rename.\n\
                    One line.\nTwo lines.\nThree lines.\nFour lines.\nFive lines.\n";
        write(&repo, "briefs/old-brief.md", body);
        let first = record(&paths, &repo, "briefs/old-brief.md", &[], &By::none()).unwrap();
        commit_all(&repo, "Add the brief");

        git(&repo, &["mv", "briefs/old-brief.md", "briefs/new-brief.md"]);
        write(&repo, "briefs/new-brief.md", &format!("{body}Six lines.\n"));
        commit_all(&repo, "Rename the brief and drop its id line");
        assert!(id_line(&fs::read_to_string(repo.join("briefs/new-brief.md")).unwrap()).is_none());

        let found = resolve(&paths, &repo, "briefs/new-brief.md").expect("found by rename");
        assert_eq!(found.id, first.id);
        assert_eq!(found.path, "briefs/new-brief.md");
        let all: Vec<&str> = found.paths.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(all, ["briefs/old-brief.md", "briefs/new-brief.md"]);
    }

    #[test]
    fn ensure_never_touches_the_file_and_record_refuses_a_missing_one() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        let file = repo.join("briefs/a-brief.md");
        let before = fs::metadata(&file).unwrap().modified().unwrap();
        let out = ensure(&paths, &repo, "briefs/a-brief.md", &By::none()).unwrap();
        assert!(out.minted && !out.id_line_written);
        assert_eq!(fs::read_to_string(&file).unwrap(), BODY);
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), before);

        let gone = ensure(&paths, &repo, "briefs/gone-brief.md", &By::none()).unwrap();
        assert!(gone.minted);
        assert_eq!(resolve(&paths, &repo, "briefs/gone-brief.md").unwrap().id, gone.id);
        let refused = record(&paths, &repo, "briefs/gone-brief.md", &[], &By::none());
        assert!(matches!(refused, Err(ArcError::Refused(m)) if m.contains("no brief at")));
    }

    #[test]
    fn a_miss_walks_the_history_once_and_never_for_an_arcs_own_brief() {
        let (_t, repo, paths) = scratch_repo();
        for rel in ["briefs/one.md", "briefs/two.md", ".tug/arcs/x/brief.md"] {
            ensure(&paths, &repo, rel, &By::none()).unwrap();
        }
        write(&repo, "briefs/fresh.md", BODY);
        let before = walks();
        assert!(resolve(&paths, &repo, "briefs/fresh.md").is_none());
        assert_eq!(walks() - before, 1, "one walk for both gone records");

        let only_tug = {
            let (_t2, repo2, paths2) = scratch_repo();
            ensure(&paths2, &repo2, ".tug/arcs/x/brief.md", &By::none()).unwrap();
            write(&repo2, "briefs/fresh.md", BODY);
            let before = walks();
            assert!(resolve(&paths2, &repo2, "briefs/fresh.md").is_none());
            walks() - before
        };
        assert_eq!(only_tug, 0, "an arc's own brief is never a candidate");
    }

    #[test]
    fn a_rename_onto_another_records_id_line_is_not_followed() {
        let (_t, repo, paths) = scratch_repo();
        let body = "# Brief\n\nLine one.\nLine two.\nLine three.\nLine four.\nLine five.\n";
        write(&repo, "briefs/old.md", body);
        let old = ensure(&paths, &repo, "briefs/old.md", &By::none()).unwrap();
        commit_all(&repo, "Add the brief");
        let other = ensure(&paths, &repo, "briefs/elsewhere.md", &By::none()).unwrap();

        git(&repo, &["mv", "briefs/old.md", "briefs/new.md"]);
        write(
            &repo,
            "briefs/new.md",
            &format!("<!-- tug-brief: {} -->\n{body}", "0badc0de"),
        );
        commit_all(&repo, "Rename onto a foreign id line");
        assert_ne!(old.id, "0badc0de");
        assert!(resolve(&paths, &repo, "briefs/new.md").is_none());
        assert_eq!(resolve(&paths, &repo, "briefs/elsewhere.md").unwrap().id, other.id);
    }

    #[test]
    fn note_commit_adds_one_version_and_refresh_adds_no_second() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        write(&repo, "src/other.rs", "fn main() {}\n");
        let out = record(&paths, &repo, "briefs/a-brief.md", &[], &By::none()).unwrap();
        commit_all(&repo, "Add the brief");
        let sha = git(&repo, &["rev-parse", "HEAD"]).trim().to_string();

        let files = vec!["briefs/a-brief.md".to_string(), "src/other.rs".to_string()];
        assert_eq!(note_commit(&paths, &repo, &sha, &files, &public("s9")), vec![out.id.clone()]);
        assert!(note_commit(&paths, &repo, &sha, &files, &public("s9")).is_empty());

        let mut record = find_brief(&paths, &out.id).remove(0).1;
        assert_eq!(record.versions.len(), 1);
        assert_eq!(refresh_versions(&paths, &repo, &mut record).unwrap(), 0);
        assert_eq!(record.versions.len(), 1);

        let committed = work_lines(&paths, &repo)
            .into_iter()
            .filter(|l| l.kind == WorkKind::BriefCommitted)
            .count();
        assert_eq!(committed, 1);
        assert_eq!(briefs(&paths, &repo).len(), 1, "no record for the other file");
    }

    #[test]
    fn refresh_reads_the_commits_a_terminal_made() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        let out = record(&paths, &repo, "briefs/a-brief.md", &[], &By::none()).unwrap();
        commit_all(&repo, "Add the brief");
        let text = fs::read_to_string(repo.join("briefs/a-brief.md")).unwrap();
        write(&repo, "briefs/a-brief.md", &format!("{text}More.\n"));
        commit_all(&repo, "Edit the brief");

        let mut record = find_brief(&paths, &out.id).remove(0).1;
        assert_eq!(refresh_versions(&paths, &repo, &mut record).unwrap(), 2);
        assert_eq!(record.versions.len(), 2);
        assert!(record.versions[0].at <= record.versions[1].at);
        let head = git(&repo, &["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(record.versions[1].sha, head, "oldest first");
    }

    #[test]
    fn writers_at_once_end_with_one_record() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let (paths, repo) = (&paths, &repo);
                scope.spawn(move || {
                    record(paths, repo, "briefs/a-brief.md", &[], &By::none()).unwrap();
                });
            }
        });
        let all = briefs(&paths, &repo);
        assert_eq!(all.len(), 1, "one record for one path");
        let text = fs::read_to_string(repo.join("briefs/a-brief.md")).unwrap();
        assert_eq!(text, format!("<!-- tug-brief: {} -->\n{BODY}", all[0].id));
    }

    #[test]
    fn a_private_session_is_named_on_the_line_and_nowhere_else() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        let by = By {
            session: Some("secret-session".into()),
            turn: Some(2),
            privacy: Privacy::Private,
            segments: Vec::new(),
        };
        let out = record(&paths, &repo, "briefs/a-brief.md", &[], &by).unwrap();
        assert_eq!(find_brief(&paths, &out.id)[0].1.written_by, None);
        let line = work_lines(&paths, &repo).remove(0);
        assert_eq!(line.kind, WorkKind::BriefRecorded);
        assert_eq!(line.session.as_deref(), Some("secret-session"));
    }

    #[test]
    fn sketches_merge_and_a_carried_unknown_id_is_adopted() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", &format!("<!-- tug-brief:  1234abcd -->\n{BODY}"));
        let one = vec!["aaaaaaaa".to_string()];
        let out = record(&paths, &repo, "briefs/a-brief.md", &one, &By::none()).unwrap();
        assert_eq!(out.id, "1234abcd");
        assert!(!out.id_line_written, "an existing id line is left as it is");
        let two = vec!["aaaaaaaa".to_string(), "bbbbbbbb".to_string()];
        record(&paths, &repo, "briefs/a-brief.md", &two, &By::none()).unwrap();
        assert_eq!(find_brief(&paths, "1234abcd")[0].1.sketches, two);
    }

    #[test]
    fn the_id_line_is_only_ever_the_first_line() {
        assert_eq!(id_line("<!-- tug-brief: 0f3c1e5a -->\n# T\n"), Some("0f3c1e5a"));
        assert_eq!(id_line("\n  <!--tug-brief:0f3c1e5a-->\n"), Some("0f3c1e5a"));
        assert_eq!(id_line("# T\n<!-- tug-brief: 0f3c1e5a -->\n"), None);
        assert_eq!(id_line("<!-- tug-brief: 0F3C1E5A -->\n"), None);
        assert_eq!(id_line("<!-- tug-sketch: 0f3c1e5a -->\n"), None);
    }

    #[test]
    fn an_absolute_path_inside_the_checkout_is_made_relative() {
        let (_t, repo, paths) = scratch_repo();
        write(&repo, "briefs/a-brief.md", BODY);
        let abs = repo.join("briefs/a-brief.md");
        let out = ensure(&paths, &repo, &abs.to_string_lossy(), &By::none()).unwrap();
        assert_eq!(out.path, "briefs/a-brief.md");
        assert!(ensure(&paths, &repo, "/elsewhere/brief.md", &By::none()).is_err());
    }
}
