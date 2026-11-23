//! The docket store: a named, per-checkout list of filed work.
//!
//! A docket gathers the pieces of one line of work — briefs, sketches, arcs,
//! sessions and commits — so they can be seen together. It holds only what
//! the user filed; everything a filed piece links to is derived from the
//! records that already keep those links (the arc log, the arc archive, the
//! sketch store, commit trailers), never copied here. The store is plain
//! files beside the arc archive and the sketch store:
//!
//! ```text
//! <project_state_dir>/dockets/
//!     .lock                 flock target, empty
//!     <id>/
//!         docket.json       the docket and its filed items
//!         briefs/
//!             <snapshot>.md a filed brief's bytes, verbatim
//! ```
//!
//! A docket is user state. Nothing here deletes a docket's directory or a
//! brief snapshot: retiring is a field, and removing an item drops it from
//! `items` and keeps whatever bytes it brought. An object is on at most one
//! docket of its checkout, retired ones included, so filing it onto another
//! docket moves it, and the outcome says where it came from.
//!
//! Every write runs under an exclusive `flock` on `dockets/.lock`, held for
//! the whole read-check-write, because the one-docket rule spans files and
//! several processes (each tugcast instance, the CLI) share one store. Each
//! file is written to a dot-named sibling and renamed into place, and every
//! reader skips dot-named entries, so a crashed write is invisible.
//!
//! Resolving what the user placed into what is stored ([`resolve_item`])
//! reads the arc log, the sketch store, the session index and git, and runs
//! before the lock is taken, so the locked section does no git.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::error::ArcError;
use crate::log::{arc_generations, generation_started_at, validate_arc_name};
use crate::ops::{first_heading, main_repo_root, write_atomic};

/// The record file in each docket's directory.
pub const DOCKET_JSON: &str = "docket.json";

/// The schema version this module writes and reads.
pub const DOCKET_VERSION: u32 = 1;

/// How many hex characters of a brief's SHA-256 name its snapshot.
const SNAPSHOT_HEX: usize = 12;

/// One filed object, as `docket.json` holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DocketItem {
    /// One generation of an arc: its name and that generation's start.
    Arc {
        name: String,
        created: String,
        filed_at: String,
    },
    Sketch {
        id: String,
        filed_at: String,
    },
    /// A session segment, with the line it belongs to; `line_id` is empty
    /// when the session index never recorded one.
    Session {
        uuid: String,
        #[serde(default)]
        line_id: String,
        filed_at: String,
    },
    /// A commit, by its full sha.
    Commit {
        sha: String,
        filed_at: String,
    },
    /// A snapshot of a markdown file taken when it was filed.
    Brief {
        snapshot: String,
        source_path: String,
        sha256: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        filed_at: String,
    },
}

impl DocketItem {
    /// The item's identity across the checkout's dockets — what the
    /// one-docket rule compares, and what a removal names.
    pub fn key(&self) -> String {
        match self {
            DocketItem::Arc { name, created, .. } => format!("arc:{name}@{created}"),
            DocketItem::Sketch { id, .. } => format!("sketch:{id}"),
            DocketItem::Session { uuid, line_id, .. } => {
                if line_id.is_empty() {
                    format!("session:{uuid}")
                } else {
                    format!("session:{line_id}")
                }
            }
            DocketItem::Commit { sha, .. } => format!("commit:{sha}"),
            DocketItem::Brief { snapshot, .. } => format!("brief:{snapshot}"),
        }
    }

    /// When the item was filed.
    pub fn filed_at(&self) -> &str {
        match self {
            DocketItem::Arc { filed_at, .. }
            | DocketItem::Sketch { filed_at, .. }
            | DocketItem::Session { filed_at, .. }
            | DocketItem::Commit { filed_at, .. }
            | DocketItem::Brief { filed_at, .. } => filed_at,
        }
    }

    fn set_filed_at(&mut self, at: String) {
        match self {
            DocketItem::Arc { filed_at, .. }
            | DocketItem::Sketch { filed_at, .. }
            | DocketItem::Session { filed_at, .. }
            | DocketItem::Commit { filed_at, .. }
            | DocketItem::Brief { filed_at, .. } => *filed_at = at,
        }
    }
}

/// A docket: its `docket.json`, and where it lies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Docket {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created: String,
    /// The checkout the docket belongs to, in the path gateway's form. Stored
    /// because a state dir's name cannot be turned back into a path.
    pub project_dir: String,
    /// When the docket was retired; `None` while it is live.
    #[serde(default)]
    pub retired_at: Option<String>,
    #[serde(default)]
    pub items: Vec<DocketItem>,
    /// The docket's directory. Read from where it was found, never stored.
    #[serde(skip)]
    pub dir: PathBuf,
}

impl Docket {
    pub fn retired(&self) -> bool {
        self.retired_at.is_some()
    }

    /// Whether the docket holds the item with this key.
    pub fn holds(&self, key: &str) -> bool {
        self.items.iter().any(|i| i.key() == key)
    }

    /// The path a brief snapshot of this docket is kept at.
    pub fn snapshot_path(&self, snapshot: &str) -> PathBuf {
        self.dir.join("briefs").join(format!("{snapshot}.md"))
    }
}

/// What the user placed to be filed — the shape an atom carries, before it is
/// resolved against the checkout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileItem {
    /// An arc by name; `created` picks a generation, else the newest.
    Arc {
        name: String,
        #[serde(default)]
        project_dir: Option<String>,
        #[serde(default)]
        created: Option<String>,
    },
    Sketch {
        id: String,
    },
    /// A session by uuid or by callsign.
    Session {
        #[serde(default)]
        uuid: Option<String>,
        #[serde(default)]
        callsign: Option<String>,
        #[serde(default)]
        project_dir: Option<String>,
    },
    /// A commit by any unambiguous prefix.
    Commit {
        sha: String,
    },
    /// A markdown file, absolute or relative to the checkout.
    Brief {
        path: String,
    },
    /// Any kind a docket does not hold.
    #[serde(other)]
    Unfileable,
}

/// A [`FileItem`] resolved into what the docket stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedItem {
    /// The stored item; its `filed_at` is set when it is filed.
    pub item: DocketItem,
    /// A brief's text, read once at resolution and written as its snapshot.
    pub brief_text: Option<String>,
}

impl ResolvedItem {
    pub fn key(&self) -> String {
        self.item.key()
    }
}

/// A docket named by its id and its name, as an outcome reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocketRef {
    pub id: String,
    pub name: String,
}

/// What filing one item did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Filed,
    Moved,
    Already,
    Refused,
}

/// One item's outcome. `from` is the docket a moved item left; `reason` is
/// the sentence a refusal gives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileOutcome {
    pub key: String,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<DocketRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl FileOutcome {
    /// A refusal of an item that never resolved, keyed by what was placed.
    pub fn refused(key: impl Into<String>, reason: impl Into<String>) -> Self {
        FileOutcome {
            key: key.into(),
            outcome: Outcome::Refused,
            from: None,
            reason: Some(reason.into()),
        }
    }
}

/// The refusal for an item from another checkout.
pub const NOT_THIS_CHECKOUT: &str =
    "It belongs to another checkout, and a docket holds only its own checkout's work.";

/// `<project_state_dir>/dockets`.
pub fn docket_root(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join("dockets")
}

/// Take the store's lock: an exclusive `flock` on `dockets/.lock`, released
/// when the returned file is dropped. The lock dies with its process, so a
/// crash leaves nothing stale.
pub fn store_lock(paths: &Paths, repo: &Path) -> Result<fs::File, ArcError> {
    let root = docket_root(paths, repo);
    fs::create_dir_all(&root)
        .map_err(|e| ArcError::io("could not create the docket store", &root, e))?;
    let path = root.join(".lock");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| ArcError::io("cannot open the docket lock", &path, e))?;
    // SAFETY: `file.as_raw_fd()` is a valid fd for the lifetime of `file`;
    // `flock` records the lock in the kernel and retains nothing.
    let ret = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), libc::LOCK_EX) };
    if ret != 0 {
        let e = std::io::Error::last_os_error();
        return Err(ArcError::io("cannot take the docket lock", &path, e));
    }
    Ok(file)
}

/// Make a docket named `name` in this checkout.
///
/// The name is trimmed, and refused when empty or equal, ignoring case, to a
/// live docket's; a retired docket's name is free to reuse.
pub fn create_docket(paths: &Paths, repo: &Path, name: &str) -> Result<Docket, ArcError> {
    let name = clean_name(name)?;
    let _lock = store_lock(paths, repo)?;
    let all = dockets_in(&docket_root(paths, repo));
    refuse_duplicate_name(&all, &name, None)?;
    let id = mint_docket_id(paths);
    let docket = Docket {
        version: DOCKET_VERSION,
        id: id.clone(),
        name,
        created: now_iso8601(),
        project_dir: project_dir_of(repo),
        retired_at: None,
        items: Vec::new(),
        dir: docket_root(paths, repo).join(&id),
    };
    write_docket(&docket)?;
    Ok(docket)
}

/// Give a docket a new name, under the same rule [`create_docket`] keeps.
pub fn rename_docket(paths: &Paths, repo: &Path, id: &str, name: &str) -> Result<Docket, ArcError> {
    let name = clean_name(name)?;
    let _lock = store_lock(paths, repo)?;
    let all = dockets_in(&docket_root(paths, repo));
    let mut docket = take(&all, id)?;
    if !docket.retired() {
        refuse_duplicate_name(&all, &name, Some(id))?;
    }
    docket.name = name;
    write_docket(&docket)?;
    Ok(docket)
}

/// Retire a docket, or restore a retired one. Retiring sets `retired_at` and
/// never removes anything; restoring is refused when a live docket has taken
/// the name meanwhile.
pub fn retire_docket(
    paths: &Paths,
    repo: &Path,
    id: &str,
    retired: bool,
) -> Result<Docket, ArcError> {
    let _lock = store_lock(paths, repo)?;
    let all = dockets_in(&docket_root(paths, repo));
    let mut docket = take(&all, id)?;
    if retired == docket.retired() {
        return Ok(docket);
    }
    if retired {
        docket.retired_at = Some(now_iso8601());
    } else {
        refuse_duplicate_name(&all, &docket.name, Some(id))?;
        docket.retired_at = None;
    }
    write_docket(&docket)?;
    Ok(docket)
}

/// File resolved items onto docket `id`, one outcome per item, in order.
///
/// An item the docket already holds is `already`; one another docket of the
/// checkout holds is taken off that docket and reported `moved` with where it
/// came from; anything else is `filed`. Filing onto a retired docket is
/// refused item by item, though an item on a retired docket may still be
/// moved off it. A brief's snapshot is written into the docket when absent.
pub fn file_items(
    paths: &Paths,
    repo: &Path,
    id: &str,
    items: &[ResolvedItem],
) -> Result<Vec<FileOutcome>, ArcError> {
    let _lock = store_lock(paths, repo)?;
    let mut all: BTreeMap<String, Docket> = dockets_in(&docket_root(paths, repo))
        .into_iter()
        .map(|d| (d.id.clone(), d))
        .collect();
    let Some(target) = all.get(id) else {
        return Err(no_docket(id));
    };
    if target.retired() {
        return Ok(items
            .iter()
            .map(|i| {
                FileOutcome::refused(
                    i.key(),
                    "The docket is retired; restore it to file onto it.",
                )
            })
            .collect());
    }

    let mut touched: Vec<String> = Vec::new();
    let mut outcomes = Vec::with_capacity(items.len());
    for resolved in items {
        let key = resolved.key();
        if all[id].holds(&key) {
            outcomes.push(FileOutcome {
                key,
                outcome: Outcome::Already,
                from: None,
                reason: None,
            });
            continue;
        }
        let mut from = None;
        if let Some(other) = all.values_mut().find(|d| d.id != id && d.holds(&key)) {
            other.items.retain(|i| i.key() != key);
            from = Some(DocketRef {
                id: other.id.clone(),
                name: other.name.clone(),
            });
            touched.push(other.id.clone());
        }
        let target = all.get_mut(id).expect("checked above");
        if let (DocketItem::Brief { snapshot, .. }, Some(text)) =
            (&resolved.item, &resolved.brief_text)
        {
            let path = target.snapshot_path(snapshot);
            if !path.exists() {
                let dir = path.parent().expect("a snapshot path has a parent");
                fs::create_dir_all(dir)
                    .map_err(|e| ArcError::io("could not keep the brief", dir, e))?;
                write_atomic(&path, text)?;
            }
        }
        let mut item = resolved.item.clone();
        item.set_filed_at(now_iso8601());
        target.items.push(item);
        outcomes.push(FileOutcome {
            key,
            outcome: if from.is_some() {
                Outcome::Moved
            } else {
                Outcome::Filed
            },
            from,
            reason: None,
        });
    }
    touched.push(id.to_string());
    touched.sort();
    touched.dedup();
    for changed in touched {
        write_docket(&all[&changed])?;
    }
    Ok(outcomes)
}

/// Take the items with these keys off docket `id`, answering the keys it
/// held. A removed brief's snapshot stays on disk.
pub fn remove_items(
    paths: &Paths,
    repo: &Path,
    id: &str,
    keys: &[String],
) -> Result<Vec<String>, ArcError> {
    let _lock = store_lock(paths, repo)?;
    let all = dockets_in(&docket_root(paths, repo));
    let mut docket = take(&all, id)?;
    let mut removed = Vec::new();
    docket.items.retain(|item| {
        let key = item.key();
        if keys.contains(&key) {
            removed.push(key);
            false
        } else {
            true
        }
    });
    if !removed.is_empty() {
        write_docket(&docket)?;
    }
    Ok(removed)
}

/// This checkout's dockets, newest first; retired ones only when asked for.
pub fn dockets(paths: &Paths, repo: &Path, include_retired: bool) -> Vec<Docket> {
    let mut all: Vec<Docket> = dockets_in(&docket_root(paths, repo))
        .into_iter()
        .filter(|d| include_retired || !d.retired())
        .collect();
    all.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
    all
}

/// Every docket `id` under the data root, each with the project state dir it
/// was found in. More than one is an ambiguity the caller reports.
pub fn find_docket(paths: &Paths, id: &str) -> Vec<(PathBuf, Docket)> {
    if !valid_id(id) {
        return Vec::new();
    }
    let projects = paths.base_data_dir.join("projects");
    let Ok(read) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, Docket)> = read
        .filter_map(|e| e.ok())
        .filter(|e| !is_dot_named(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .filter_map(|state| {
            let docket = read_docket(&state.join("dockets").join(id))?;
            Some((state, docket))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// Resolve what the user placed into what the docket stores, or the one
/// sentence that refuses it.
///
/// An arc resolves to a generation the arc log records (its newest unless
/// `created` names one); a sketch to a record in this checkout's store; a
/// session through the session index to its uuid and line; a commit through
/// `git rev-parse` to its full sha; a brief to the text of an existing `.md`
/// file. Anything that belongs to another checkout is refused.
pub fn resolve_item(paths: &Paths, repo: &Path, item: &FileItem) -> Result<ResolvedItem, String> {
    let here = project_state_dir_at(paths, repo);
    let elsewhere = |dir: &Option<String>| {
        dir.as_deref()
            .is_some_and(|d| project_state_dir_at(paths, Path::new(d)) != here)
    };
    let plain = |item: DocketItem| ResolvedItem {
        item,
        brief_text: None,
    };
    match item {
        FileItem::Arc {
            name,
            project_dir,
            created,
        } => {
            if elsewhere(project_dir) {
                return Err(NOT_THIS_CHECKOUT.into());
            }
            validate_arc_name(name).map_err(|e| e.to_string())?;
            let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
            let log = fs::read_to_string(&log_path).unwrap_or_default();
            let created = match created {
                Some(c) => {
                    if !arc_generations(&log, name)
                        .iter()
                        .any(|g| &g.started_at == c)
                    {
                        return Err(format!("No arc {name} started at {c} in this checkout."));
                    }
                    c.clone()
                }
                None => generation_started_at(&log, name)
                    .ok_or_else(|| format!("No arc named {name} in this checkout."))?,
            };
            Ok(plain(DocketItem::Arc {
                name: name.clone(),
                created,
                filed_at: String::new(),
            }))
        }
        FileItem::Sketch { id } => {
            let found = crate::sketch::find_sketch(paths, id);
            if found.is_empty() {
                return Err(format!("No sketch {id} on this machine."));
            }
            if !found.iter().any(|(state, _)| *state == here) {
                return Err(NOT_THIS_CHECKOUT.into());
            }
            Ok(plain(DocketItem::Sketch {
                id: id.clone(),
                filed_at: String::new(),
            }))
        }
        FileItem::Session {
            uuid,
            callsign,
            project_dir,
        } => {
            if elsewhere(project_dir) {
                return Err(NOT_THIS_CHECKOUT.into());
            }
            let index = &paths.session_index_db;
            let rows = match (uuid, callsign) {
                (Some(u), _) if !u.is_empty() => {
                    tugcore::session_index::lookup_uuid(index, &u.to_ascii_lowercase())
                }
                (_, Some(c)) if !c.is_empty() => {
                    tugcore::session_index::lookup_callsign(index, c, None)
                }
                _ => return Err("A session is filed by its uuid or its callsign.".into()),
            };
            if rows.is_empty() {
                return Err("No such session on this machine.".into());
            }
            let ours: Vec<_> = rows
                .iter()
                .filter(|r| project_state_dir_at(paths, Path::new(&r.project_dir)) == here)
                .collect();
            let Some(first) = ours.first() else {
                return Err(NOT_THIS_CHECKOUT.into());
            };
            if ours.iter().any(|r| r.line_id != first.line_id) {
                return Err(
                    "That callsign names more than one session here; file it by its uuid.".into(),
                );
            }
            Ok(plain(DocketItem::Session {
                uuid: first.session_id.clone(),
                line_id: first.line_id.clone(),
                filed_at: String::new(),
            }))
        }
        FileItem::Commit { sha } => {
            let sha = resolve_commit(repo, sha)
                .ok_or_else(|| format!("No commit {sha} in this checkout."))?;
            Ok(plain(DocketItem::Commit {
                sha,
                filed_at: String::new(),
            }))
        }
        FileItem::Brief { path } => resolve_brief(repo, path),
        FileItem::Unfileable => Err("That kind of thing cannot be filed on a docket.".into()),
    }
}

/// A brief is an existing `.md` file, read once: its SHA-256 names the
/// snapshot, and its first heading is its title.
fn resolve_brief(repo: &Path, path: &str) -> Result<ResolvedItem, String> {
    let given = Path::new(path);
    let full = if given.is_absolute() {
        given.to_path_buf()
    } else {
        repo.join(given)
    };
    let is_md = full
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md || !full.is_file() {
        return Err(format!("{path} is not a markdown file."));
    }
    let text = fs::read_to_string(&full).map_err(|_| format!("{path} is not a markdown file."))?;
    let sha256: String = Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let source_path = full
        .strip_prefix(repo)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| full.to_string_lossy().into_owned());
    Ok(ResolvedItem {
        item: DocketItem::Brief {
            snapshot: sha256[..SNAPSHOT_HEX].to_string(),
            source_path,
            sha256,
            title: first_heading(&text),
            filed_at: String::new(),
        },
        brief_text: Some(text),
    })
}

/// The full sha of `rev` in `repo`, when it names a commit.
fn resolve_commit(repo: &Path, rev: &str) -> Option<String> {
    if rev.is_empty() || !rev.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let output = tugcore::git_command()
        .current_dir(main_repo_root(repo))
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("{rev}^{{commit}}"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (sha.len() == 40).then_some(sha)
}

/// A fresh id no checkout's store under the data root already holds.
pub fn mint_docket_id(paths: &Paths) -> String {
    loop {
        let id = format!("{:08x}", rand::random::<u32>());
        if find_docket(paths, &id).is_empty() {
            return id;
        }
    }
}

/// An id is eight lowercase hex characters, which also keeps it from naming
/// anything but a directory under `dockets/`.
fn valid_id(id: &str) -> bool {
    id.len() == 8 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

fn is_dot_named(name: &str) -> bool {
    name.starts_with('.')
}

fn clean_name(name: &str) -> Result<String, ArcError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ArcError::Refused("A docket needs a name.".into()));
    }
    Ok(name.to_string())
}

fn refuse_duplicate_name(all: &[Docket], name: &str, except: Option<&str>) -> Result<(), ArcError> {
    let taken = all.iter().any(|d| {
        !d.retired()
            && Some(d.id.as_str()) != except
            && d.name.to_lowercase() == name.to_lowercase()
    });
    if taken {
        return Err(ArcError::Refused(format!(
            "A docket named {name} already exists in this checkout."
        )));
    }
    Ok(())
}

fn no_docket(id: &str) -> ArcError {
    ArcError::Refused(format!("No docket {id} in this checkout."))
}

fn take(all: &[Docket], id: &str) -> Result<Docket, ArcError> {
    all.iter()
        .find(|d| d.id == id)
        .cloned()
        .ok_or_else(|| no_docket(id))
}

fn project_dir_of(repo: &Path) -> String {
    // [L29]: a persisted and compared path goes through the gateway, never a
    // bare `canonicalize`.
    canonical_dir(&main_repo_root(repo))
}

fn canonical_dir(dir: &Path) -> String {
    tugcore::pathform::resolve_to_claude_form(dir)
        .to_string_lossy()
        .into_owned()
}

fn read_docket(dir: &Path) -> Option<Docket> {
    let text = fs::read_to_string(dir.join(DOCKET_JSON)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let version = value.get("version").and_then(|v| v.as_u64());
    if version != Some(u64::from(DOCKET_VERSION)) {
        tracing::warn!(
            dir = %dir.display(),
            ?version,
            "skipping a docket of an unknown version"
        );
        return None;
    }
    let mut docket: Docket = serde_json::from_value(value).ok()?;
    docket.dir = dir.to_path_buf();
    docket.project_dir = canonical_dir(Path::new(&docket.project_dir));
    Some(docket)
}

fn dockets_in(root: &Path) -> Vec<Docket> {
    let Ok(read) = fs::read_dir(root) else {
        return Vec::new();
    };
    read.filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            !is_dot_named(&name) && valid_id(&name)
        })
        .filter_map(|e| read_docket(&e.path()))
        .collect()
}

fn write_docket(docket: &Docket) -> Result<(), ArcError> {
    fs::create_dir_all(&docket.dir)
        .map_err(|e| ArcError::io("could not create the docket", &docket.dir, e))?;
    let json = serde_json::to_string_pretty(docket)
        .map_err(|e| ArcError::Refused(format!("could not serialize {DOCKET_JSON}: {e}")))?;
    write_atomic(&docket.dir.join(DOCKET_JSON), &(json + "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tugcore::session_index::{IndexEntry, SessionIndex};

    fn scratch() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("src").join("repo");
        fs::create_dir_all(&repo).unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        (temp, repo, paths)
    }

    fn commit(sha: &str) -> ResolvedItem {
        ResolvedItem {
            item: DocketItem::Commit {
                sha: sha.to_string(),
                filed_at: String::new(),
            },
            brief_text: None,
        }
    }

    fn log_append(paths: &Paths, repo: &Path, line: &str) {
        let log = tugtool_core::paths::arc_log_path_at(paths, repo);
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        let mut text = fs::read_to_string(&log).unwrap_or_default();
        text.push_str(line);
        text.push('\n');
        fs::write(log, text).unwrap();
    }

    fn reread(paths: &Paths, repo: &Path, id: &str) -> Docket {
        dockets(paths, repo, true)
            .into_iter()
            .find(|d| d.id == id)
            .unwrap()
    }

    #[test]
    fn create_rename_retire_and_restore_round_trip() {
        let (_t, repo, paths) = scratch();
        let made = create_docket(&paths, &repo, "  Rail work ").unwrap();
        assert_eq!(made.name, "Rail work");
        assert!(valid_id(&made.id));
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(made.dir.join(DOCKET_JSON)).unwrap()).unwrap();
        assert_eq!(on_disk["version"], 1);
        assert_eq!(on_disk["retired_at"], serde_json::Value::Null);

        let dup = create_docket(&paths, &repo, "rail WORK").unwrap_err();
        assert!(matches!(dup, ArcError::Refused(_)), "{dup:?}");
        assert!(create_docket(&paths, &repo, "   ").is_err());

        let renamed = rename_docket(&paths, &repo, &made.id, "Rails").unwrap();
        assert_eq!(reread(&paths, &repo, &made.id).name, "Rails");
        assert_eq!(renamed.name, "Rails");

        retire_docket(&paths, &repo, &made.id, true).unwrap();
        assert!(reread(&paths, &repo, &made.id).retired());
        assert!(dockets(&paths, &repo, false).is_empty());
        assert_eq!(dockets(&paths, &repo, true).len(), 1);

        let reuse = create_docket(&paths, &repo, "Rails").unwrap();
        assert!(
            retire_docket(&paths, &repo, &made.id, false).is_err(),
            "a restore whose name a live docket took is refused"
        );
        retire_docket(&paths, &repo, &reuse.id, true).unwrap();
        retire_docket(&paths, &repo, &made.id, false).unwrap();
        assert!(!reread(&paths, &repo, &made.id).retired());

        let found = find_docket(&paths, &made.id);
        assert_eq!(found.len(), 1);
        assert_eq!(
            PathBuf::from(&found[0].1.project_dir),
            tugcore::pathform::resolve_to_claude_form(&repo)
        );
        assert!(find_docket(&paths, "../etc").is_empty());
    }

    #[test]
    fn filing_twice_is_already_and_onto_a_second_docket_is_a_move() {
        let (_t, repo, paths) = scratch();
        let a = create_docket(&paths, &repo, "A").unwrap();
        let b = create_docket(&paths, &repo, "B").unwrap();
        let sha = "1".repeat(40);

        let first = file_items(&paths, &repo, &a.id, &[commit(&sha)]).unwrap();
        assert_eq!(first[0].outcome, Outcome::Filed);
        assert_eq!(first[0].key, format!("commit:{sha}"));
        let again = file_items(&paths, &repo, &a.id, &[commit(&sha)]).unwrap();
        assert_eq!(again[0].outcome, Outcome::Already);

        let moved = file_items(&paths, &repo, &b.id, &[commit(&sha)]).unwrap();
        assert_eq!(moved[0].outcome, Outcome::Moved);
        assert_eq!(
            moved[0].from,
            Some(DocketRef {
                id: a.id.clone(),
                name: "A".into()
            })
        );
        assert!(reread(&paths, &repo, &a.id).items.is_empty());
        assert_eq!(reread(&paths, &repo, &b.id).items.len(), 1);
        assert!(!reread(&paths, &repo, &b.id).items[0].filed_at().is_empty());

        let removed =
            remove_items(&paths, &repo, &b.id, &[format!("commit:{sha}"), "x".into()]).unwrap();
        assert_eq!(removed, vec![format!("commit:{sha}")]);
        assert!(reread(&paths, &repo, &b.id).items.is_empty());
    }

    #[test]
    fn a_retired_docket_refuses_filing_but_lets_an_item_move_off() {
        let (_t, repo, paths) = scratch();
        let old = create_docket(&paths, &repo, "Old").unwrap();
        let new = create_docket(&paths, &repo, "New").unwrap();
        let sha = "2".repeat(40);
        file_items(&paths, &repo, &old.id, &[commit(&sha)]).unwrap();
        retire_docket(&paths, &repo, &old.id, true).unwrap();

        let refused = file_items(&paths, &repo, &old.id, &[commit(&"3".repeat(40))]).unwrap();
        assert_eq!(refused[0].outcome, Outcome::Refused);
        assert!(refused[0].reason.as_deref().unwrap().contains("retired"));

        let moved = file_items(&paths, &repo, &new.id, &[commit(&sha)]).unwrap();
        assert_eq!(moved[0].outcome, Outcome::Moved);
        assert!(reread(&paths, &repo, &old.id).items.is_empty());
    }

    #[test]
    fn a_brief_snapshot_is_written_once_and_only_markdown_is_filed() {
        let (_t, repo, paths) = scratch();
        let docket = create_docket(&paths, &repo, "Briefs").unwrap();
        fs::create_dir_all(repo.join("briefs")).unwrap();
        let text = "# The rail brief\n\nBody.\n";
        fs::write(repo.join("briefs/rail-brief.md"), text).unwrap();
        fs::write(repo.join("briefs/notes.txt"), "no").unwrap();

        let item = FileItem::Brief {
            path: "briefs/rail-brief.md".into(),
        };
        let resolved = resolve_item(&paths, &repo, &item).unwrap();
        let DocketItem::Brief {
            snapshot,
            source_path,
            title,
            sha256,
            ..
        } = &resolved.item
        else {
            panic!("a brief");
        };
        assert_eq!(snapshot.len(), SNAPSHOT_HEX);
        assert_eq!(sha256.len(), 64);
        assert_eq!(source_path, "briefs/rail-brief.md");
        assert_eq!(title.as_deref(), Some("The rail brief"));

        let out = file_items(&paths, &repo, &docket.id, std::slice::from_ref(&resolved)).unwrap();
        assert_eq!(out[0].outcome, Outcome::Filed);
        let kept = reread(&paths, &repo, &docket.id).snapshot_path(snapshot);
        assert_eq!(fs::read_to_string(&kept).unwrap(), text);
        let again = file_items(&paths, &repo, &docket.id, std::slice::from_ref(&resolved)).unwrap();
        assert_eq!(again[0].outcome, Outcome::Already);

        // An edited source is a new snapshot; the first is kept as it was.
        fs::write(
            repo.join("briefs/rail-brief.md"),
            "# The rail brief\n\nMore.\n",
        )
        .unwrap();
        let edited = resolve_item(&paths, &repo, &item).unwrap();
        let out = file_items(&paths, &repo, &docket.id, &[edited]).unwrap();
        assert_eq!(out[0].outcome, Outcome::Filed);
        assert_eq!(fs::read_to_string(&kept).unwrap(), text);

        // Removing the item keeps its bytes.
        remove_items(&paths, &repo, &docket.id, &[format!("brief:{snapshot}")]).unwrap();
        assert!(kept.exists());

        for bad in ["briefs/notes.txt", "briefs/missing.md", "briefs"] {
            let err = resolve_item(&paths, &repo, &FileItem::Brief { path: bad.into() });
            assert!(err.unwrap_err().contains("not a markdown file"), "{bad}");
        }
    }

    #[test]
    fn work_from_another_checkout_is_refused() {
        let (temp, repo, paths) = scratch();
        let other = temp.path().join("src").join("other");
        fs::create_dir_all(&other).unwrap();
        let other_dir = other.to_string_lossy().into_owned();

        // An arc placed with another checkout's directory.
        log_append(
            &paths,
            &repo,
            "2026-11-20T10:00:00Z  rail  arc-start  brief.md",
        );
        let arc = FileItem::Arc {
            name: "rail".into(),
            project_dir: Some(other_dir.clone()),
            created: None,
        };
        assert_eq!(
            resolve_item(&paths, &repo, &arc).unwrap_err(),
            NOT_THIS_CHECKOUT
        );
        // The same arc placed from here resolves to its generation.
        let here = FileItem::Arc {
            name: "rail".into(),
            project_dir: None,
            created: None,
        };
        assert_eq!(
            resolve_item(&paths, &repo, &here).unwrap().key(),
            "arc:rail@2026-11-20T10:00:00Z"
        );

        // A session the index records under another checkout.
        let index = SessionIndex::open(&paths.session_index_db).unwrap();
        index
            .upsert(&IndexEntry {
                session_id: "048e4155-f644-46f7-a839-d22ac02a564f".into(),
                line_id: "line-1".into(),
                callsign: Some("odd-kiln".into()),
                project_dir: other_dir.clone(),
                project_leaf: String::new(),
                instance: String::new(),
                title: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .unwrap();
        let session = FileItem::Session {
            uuid: None,
            callsign: Some("odd-kiln".into()),
            project_dir: None,
        };
        assert_eq!(
            resolve_item(&paths, &repo, &session).unwrap_err(),
            NOT_THIS_CHECKOUT
        );
        let resolved_there = resolve_item(&paths, &other, &session).unwrap();
        assert_eq!(resolved_there.key(), "session:line-1");

        // A sketch recorded in another checkout.
        let docs = crate::ops::documents_dir(&other, "sk");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("sketch.md"), "# Sketch\n\nWant.\n").unwrap();
        let made = crate::sketch::record_arc_sketch(&paths, &other, "sk").unwrap();
        let sketch = FileItem::Sketch { id: made.id };
        assert_eq!(
            resolve_item(&paths, &repo, &sketch).unwrap_err(),
            NOT_THIS_CHECKOUT
        );
        assert!(resolve_item(&paths, &other, &sketch).is_ok());

        assert!(resolve_item(&paths, &repo, &FileItem::Unfileable).is_err());
    }

    #[test]
    fn no_code_path_removes_a_directory() {
        let source = include_str!("docket.rs");
        let code = source
            .split("#[cfg(test)]")
            .next()
            .expect("the file has code above its tests");
        let needle = ["remove", "_dir"].concat();
        assert!(
            !code.contains(&needle),
            "the docket store is user state; nothing removes a directory under dockets/"
        );
    }

    #[test]
    fn concurrent_filing_under_the_lock_keeps_every_item() {
        let (_t, repo, paths) = scratch();
        let docket = create_docket(&paths, &repo, "Busy").unwrap();
        let handles: Vec<_> = (0..2)
            .map(|t| {
                let (paths, repo, id) = (paths.clone(), repo.clone(), docket.id.clone());
                std::thread::spawn(move || {
                    for i in 0..20 {
                        let sha = format!("{t}{i:039}");
                        file_items(&paths, &repo, &id, &[commit(&sha)]).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let kept = reread(&paths, &repo, &docket.id);
        assert_eq!(kept.items.len(), 40, "no write lost another's");
    }
}
