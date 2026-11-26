//! The cycle record: a container of related arcs, briefs and sketches.
//!
//! A cycle is one file beside the sketch store:
//!
//! ```text
//! <project_state_dir>/cycles/<id>/cycle.json
//! ```
//!
//! The id is eight lowercase hex characters, unique across every checkout's
//! `cycles/` under the data root, minted the way sketch ids are. A cycle holds
//! numbered **entries** — one brief each, and at most one arc once that brief's
//! arc opens — and lettered **sketches**, the sketch store's own ids. Entries
//! are numbered 1, 2, 3 and sketches lettered A, B, C in the order added, and
//! neither is ever renumbered, re-lettered or removed.
//!
//! An entry links its arc by name and generation start, the same shape a
//! sketch links its arc, because an arc name is unique only within one
//! generation. How far an entry has got is never stored: it is derived from
//! the arc log each time the record is read.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::arc::{ArcStageLine, read_arc_in};
use crate::error::ArcError;
use crate::log::{generation_started_at, is_terminal, split_log_line, validate_arc_name};
use crate::ops::main_repo_root;
use crate::sketch::{find_sketch, valid_id, write_atomically};

/// The record file in a cycle's directory.
pub const CYCLE_JSON: &str = "cycle.json";

/// The arc an entry is tied to: its name and its generation's start. The same
/// shape as a sketch's arc link.
pub type CycleArc = crate::sketch::SketchArc;

/// One entry: a brief, and the arc that carries it once it is opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleEntry {
    /// The entry's number, from 1, in the order added.
    pub n: u32,
    /// The brief's path, relative to the project root.
    pub brief: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc: Option<CycleArc>,
    /// The entries this one waits on, by number.
    #[serde(default)]
    pub waits: Vec<u32>,
    /// The letters of the cycle's sketches this entry came from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from: Vec<String>,
    /// Free text, for a gate that is not an entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub added: String,
}

/// One sketch on a cycle: the sketch store's id under the cycle's letter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleSketch {
    pub letter: String,
    pub id: String,
    pub added: String,
}

/// A cycle's record: its `cycle.json`, and where it lies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleRecord {
    pub id: String,
    pub name: String,
    pub created: String,
    /// When the record was last written; what a listing orders by.
    pub updated: String,
    /// The checkout the cycle belongs to, canonical ([L29]).
    pub project_dir: String,
    /// The session that created the cycle, when one was known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default)]
    pub entries: Vec<CycleEntry>,
    #[serde(default)]
    pub sketches: Vec<CycleSketch>,
    /// The record's directory. Read from where it was found, never stored.
    #[serde(skip)]
    pub dir: PathBuf,
}

impl CycleRecord {
    /// The entry numbered `n`.
    pub fn entry(&self, n: u32) -> Option<&CycleEntry> {
        self.entries.iter().find(|e| e.n == n)
    }
}

/// What a new entry carries, before it is numbered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewEntry {
    pub brief: String,
    pub waits: Vec<u32>,
    pub from: Vec<String>,
    pub note: Option<String>,
}

/// `<project_state_dir>/cycles`.
pub fn cycle_root(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join("cycles")
}

/// Create a cycle named `name` in this checkout, written by `created_by`.
pub fn create_cycle(
    paths: &Paths,
    repo: &Path,
    name: &str,
    created_by: Option<&str>,
) -> Result<CycleRecord, ArcError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ArcError::Refused("a cycle needs a name".into()));
    }
    let id = mint_id(paths);
    let now = now_iso8601();
    let record = CycleRecord {
        dir: cycle_root(paths, repo).join(&id),
        id,
        name: name.to_string(),
        created: now.clone(),
        updated: now,
        project_dir: project_dir_of(repo),
        created_by: created_by
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from),
        entries: Vec::new(),
        sketches: Vec::new(),
    };
    write_record(&record)?;
    Ok(record)
}

/// Rename cycle `id`, keeping its id, and return the record as written.
///
/// A cycle is renamed only by hand: the skills name a cycle once, when they
/// create it, and never call this on their own judgment. An empty name is
/// refused.
pub fn rename_cycle(
    paths: &Paths,
    repo: &Path,
    id: &str,
    name: &str,
) -> Result<CycleRecord, ArcError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ArcError::Refused("a cycle needs a name".into()));
    }
    let mut record = load(paths, repo, id)?;
    record.name = name.to_string();
    save(&mut record)?;
    Ok(record)
}

/// The entry in this checkout that holds brief `brief`, named relative to the
/// project root, as `(cycle id, entry number)`.
///
/// The most recently changed cycle is asked first, and within a cycle the
/// earliest entry. `None` when no entry holds the brief.
pub fn find_entry_by_brief(paths: &Paths, repo: &Path, brief: &str) -> Option<(String, u32)> {
    let wanted = normal_brief(brief);
    if wanted.is_empty() {
        return None;
    }
    cycles(paths, repo).into_iter().find_map(|record| {
        let n = record
            .entries
            .iter()
            .filter(|e| normal_brief(&e.brief) == wanted)
            .map(|e| e.n)
            .min()?;
        Some((record.id, n))
    })
}

/// This checkout's cycles that session `writer` created, the most recently
/// changed first. A cycle that recorded no writer belongs to nobody.
pub fn cycles_by(paths: &Paths, repo: &Path, writer: &str) -> Vec<CycleRecord> {
    cycles(paths, repo)
        .into_iter()
        .filter(|record| record.created_by.as_deref() == Some(writer))
        .collect()
}

/// A brief path in the one spelling entries are compared in: trimmed, with
/// any leading `./` taken off.
fn normal_brief(brief: &str) -> &str {
    let mut path = brief.trim();
    while let Some(rest) = path.strip_prefix("./") {
        path = rest;
    }
    path
}

/// Add an entry to cycle `id` and return its number.
///
/// Refused when the brief path is empty or absolute, when a wait names an
/// entry that does not exist, and when a `from` letter names no sketch on the
/// cycle. A wait can only name an entry already there, so a new entry cannot
/// close a loop; the whole graph is checked all the same.
pub fn add_entry(paths: &Paths, repo: &Path, id: &str, entry: NewEntry) -> Result<u32, ArcError> {
    let mut record = load(paths, repo, id)?;
    let brief = entry.brief.trim();
    if brief.is_empty() {
        return Err(ArcError::Refused("an entry needs a brief".into()));
    }
    if Path::new(brief).is_absolute() {
        return Err(ArcError::Refused(format!(
            "the brief is named relative to the project root, not as {brief}"
        )));
    }
    let n = record.entries.iter().map(|e| e.n).max().unwrap_or(0) + 1;
    let mut waits: Vec<u32> = Vec::new();
    for w in entry.waits {
        if w == n {
            return Err(ArcError::Refused(format!(
                "entry {n} cannot wait on itself"
            )));
        }
        if record.entry(w).is_none() {
            return Err(ArcError::Refused(format!(
                "cycle {id} has no entry {w} to wait on"
            )));
        }
        if !waits.contains(&w) {
            waits.push(w);
        }
    }
    let mut from: Vec<String> = Vec::new();
    for letter in entry.from {
        let letter = letter.trim().to_ascii_uppercase();
        if !record.sketches.iter().any(|s| s.letter == letter) {
            return Err(ArcError::Refused(format!(
                "cycle {id} has no sketch {letter}"
            )));
        }
        if !from.contains(&letter) {
            from.push(letter);
        }
    }
    let mut entries = record.entries.clone();
    entries.push(CycleEntry {
        n,
        brief: brief.to_string(),
        arc: None,
        waits,
        from,
        note: entry
            .note
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        added: now_iso8601(),
    });
    if let Some(at) = wait_loop(&entries) {
        return Err(ArcError::Refused(format!(
            "the waits would close a loop through entry {at}"
        )));
    }
    record.entries = entries;
    save(&mut record)?;
    Ok(n)
}

/// Add sketch `sketch_id` from the sketch store to cycle `id` and return its
/// letter. A sketch already on the cycle keeps the letter it has.
pub fn add_sketch(
    paths: &Paths,
    repo: &Path,
    id: &str,
    sketch_id: &str,
) -> Result<String, ArcError> {
    let mut record = load(paths, repo, id)?;
    if let Some(s) = record.sketches.iter().find(|s| s.id == sketch_id) {
        return Ok(s.letter.clone());
    }
    if find_sketch(paths, sketch_id).is_empty() {
        return Err(ArcError::Refused(format!(
            "sketch {sketch_id} is not in the sketch store"
        )));
    }
    let letter = letter_for(record.sketches.len());
    record.sketches.push(CycleSketch {
        letter: letter.clone(),
        id: sketch_id.to_string(),
        added: now_iso8601(),
    });
    save(&mut record)?;
    Ok(letter)
}

/// Tie entry `n` of cycle `id` to arc `arc`'s current generation.
///
/// Refused when the arc log never recorded the arc, and when the entry already
/// links a different arc generation that is still open. Attaching the link an
/// entry already holds changes nothing; a link to a generation that has ended
/// is replaced, so an entry whose arc was discarded can be carried by a new
/// one.
pub fn attach(
    paths: &Paths,
    repo: &Path,
    id: &str,
    n: u32,
    arc: &str,
) -> Result<CycleArc, ArcError> {
    validate_arc_name(arc).map_err(ArcError::InvalidName)?;
    let mut record = load(paths, repo, id)?;
    let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
    let log = fs::read_to_string(&log_path).unwrap_or_default();
    let Some(start) = generation_started_at(&log, arc) else {
        return Err(ArcError::Refused(format!(
            "the arc log has no arc named {arc}"
        )));
    };
    let link = CycleArc {
        name: arc.to_string(),
        created: Some(start),
    };
    let Some(entry) = record.entries.iter_mut().find(|e| e.n == n) else {
        return Err(ArcError::Refused(format!("cycle {id} has no entry {n}")));
    };
    match &entry.arc {
        Some(held) if *held == link => return Ok(link),
        Some(held) if link_status(&log, held) == LinkStatus::Open => {
            return Err(ArcError::Refused(format!(
                "entry {n} is already carried by arc {}, which is still open",
                held.name
            )));
        }
        _ => {}
    }
    entry.arc = Some(link.clone());
    save(&mut record)?;
    Ok(link)
}

/// Every record of `id` under the data root, each with the project state dir
/// it was found in. More than one is an ambiguity the caller reports.
pub fn find_cycle(paths: &Paths, id: &str) -> Vec<(PathBuf, CycleRecord)> {
    if !valid_id(id) {
        return Vec::new();
    }
    let projects = paths.base_data_dir.join("projects");
    let Ok(read) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, CycleRecord)> = read
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter_map(|state| {
            let record = read_record(&state.join("cycles").join(id))?;
            Some((state, record))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// This checkout's cycles, the most recently changed first.
pub fn cycles(paths: &Paths, repo: &Path) -> Vec<CycleRecord> {
    let root = cycle_root(paths, repo);
    let Ok(read) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut all: Vec<CycleRecord> = read
        .filter_map(|e| e.ok())
        .filter(|e| valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| read_record(&e.path()))
        .collect();
    all.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    all
}

/// The letter of the sketch at 0-based `index`: A … Z, then AA, AB, ….
pub fn letter_for(index: usize) -> String {
    let mut n = index + 1;
    let mut out = Vec::new();
    while n > 0 {
        n -= 1;
        out.push(b'A' + (n % 26) as u8);
        n /= 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// The first entry found on a loop through the waits, if the waits hold one.
pub fn wait_loop(entries: &[CycleEntry]) -> Option<u32> {
    // 0 unvisited, 1 on the current path, 2 finished.
    fn visit(n: u32, entries: &[CycleEntry], mark: &mut Vec<(u32, u8)>) -> Option<u32> {
        match mark.iter().find(|(m, _)| *m == n).map(|(_, s)| *s) {
            Some(1) => return Some(n),
            Some(2) => return None,
            _ => {}
        }
        mark.push((n, 1));
        let waits = entries
            .iter()
            .find(|e| e.n == n)
            .map(|e| e.waits.clone())
            .unwrap_or_default();
        for w in waits {
            if let Some(at) = visit(w, entries, mark) {
                return Some(at);
            }
        }
        if let Some(slot) = mark.iter_mut().find(|(m, _)| *m == n) {
            slot.1 = 2;
        }
        None
    }
    let mut mark = Vec::new();
    let numbers: BTreeSet<u32> = entries.iter().map(|e| e.n).collect();
    numbers
        .into_iter()
        .find_map(|n| visit(n, entries, &mut mark))
}

/// How far an entry has got, derived from the arc log each time it is read
/// and never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryState {
    /// The linked arc's generation ended in a join.
    Joined,
    /// The linked arc's generation is open.
    Running,
    /// Neither, and some wait is not joined.
    Waiting,
    /// Neither, and every wait is joined.
    Ready,
}

impl EntryState {
    /// The state's wire spelling, the same word its serde form writes.
    pub fn as_str(self) -> &'static str {
        match self {
            EntryState::Joined => "joined",
            EntryState::Running => "running",
            EntryState::Waiting => "waiting",
            EntryState::Ready => "ready",
        }
    }
}

/// What the arc log says about one linked arc generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStatus {
    /// The generation is open.
    Open,
    /// The generation ended in a join that still stands.
    Joined,
    /// No such generation is under way: the log never recorded it, or it was
    /// discarded. A link that reads this way is kept, so the history is not
    /// lost, and its entry reads as not started.
    NotStarted,
}

/// Read the generation `link` names out of the arc log text.
///
/// The walk is the arc log's own: a name's first line opens its first
/// generation, a terminal line ([`is_terminal`]) ends it, and only an
/// `arc-start` after a terminal line opens the next. The generation is found
/// by its start, so a reused name never answers for an older link — the same
/// walk [`generation_started_at`] makes, which is what `attach` linked by.
///
/// Within the generation, the arc log's undo and redo lines move its ending:
/// an undo of a join or a discard rebuilds the arc, so the generation reads
/// open again, and a redo re-applies the ending it undid. Neither opens a new
/// generation, because the rebuilt arc is the same one.
pub fn link_status(log_text: &str, link: &CycleArc) -> LinkStatus {
    let Some(want) = link.created.as_deref() else {
        return LinkStatus::NotStarted;
    };
    // (start of the generation being walked, whether a terminal line ended
    // it, how it stands now)
    let mut generation: Option<(&str, bool, Option<LinkStatus>)> = None;
    let mut found: Option<Option<LinkStatus>> = None;
    for line in log_text.lines() {
        let Some((timestamp, name, marker, note)) = split_log_line(line) else {
            continue;
        };
        if name != link.name {
            continue;
        }
        let opens = match generation {
            None => true,
            Some((_, terminated, _)) => terminated && marker == "arc-start",
        };
        if opens {
            if let Some((start, _, ending)) = generation {
                if start == want {
                    found = Some(ending);
                }
            }
            generation = Some((timestamp, false, None));
        }
        let Some((_, terminated, ending)) = generation.as_mut() else {
            continue;
        };
        if is_terminal(marker, note) {
            *terminated = true;
            *ending = Some(if marker == "discarded" || marker == "released" {
                LinkStatus::NotStarted
            } else {
                LinkStatus::Joined
            });
        } else if marker == "undone" {
            let reverses = match *ending {
                Some(LinkStatus::Joined) => note.starts_with("reversed join"),
                Some(LinkStatus::NotStarted) => note.starts_with("reversed discard"),
                _ => false,
            };
            if reverses {
                *ending = None;
            }
        } else if marker == "redone" && ending.is_none() {
            if note.starts_with("re-applied join") {
                *ending = Some(LinkStatus::Joined);
            } else if note.starts_with("re-applied discard") {
                *ending = Some(LinkStatus::NotStarted);
            }
        }
    }
    if let Some((start, _, ending)) = generation {
        if start == want {
            found = Some(ending);
        }
    }
    match found {
        None => LinkStatus::NotStarted,
        Some(None) => LinkStatus::Open,
        Some(Some(status)) => status,
    }
}

/// Every entry's state, in entry order, derived from the arc log text.
///
/// Pure over its inputs, so it is the whole of the rule: an entry whose arc
/// joined is joined, one whose arc is open is running, and any other is
/// waiting while some entry it waits on is not joined and ready once all are.
pub fn entry_states(log_text: &str, record: &CycleRecord) -> Vec<(u32, EntryState)> {
    let status = |e: &CycleEntry| {
        e.arc
            .as_ref()
            .map_or(LinkStatus::NotStarted, |link| link_status(log_text, link))
    };
    let joined: BTreeSet<u32> = record
        .entries
        .iter()
        .filter(|e| status(e) == LinkStatus::Joined)
        .map(|e| e.n)
        .collect();
    record
        .entries
        .iter()
        .map(|e| {
            let state = match status(e) {
                LinkStatus::Joined => EntryState::Joined,
                LinkStatus::Open => EntryState::Running,
                LinkStatus::NotStarted if e.waits.iter().all(|w| joined.contains(w)) => {
                    EntryState::Ready
                }
                LinkStatus::NotStarted => EntryState::Waiting,
            };
            (e.n, state)
        })
        .collect()
}

/// One entry as a reader sees it: the record's entry, its derived state, and
/// the stage rotations of its arc's generation when that generation is the
/// one the arc record holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EntryView {
    #[serde(flatten)]
    pub entry: CycleEntry,
    pub state: EntryState,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<ArcStageLine>,
}

/// A cycle as a reader sees it: the record, with every entry's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CycleView {
    pub id: String,
    pub name: String,
    pub created: String,
    pub updated: String,
    pub project_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    pub entries: Vec<EntryView>,
    pub sketches: Vec<CycleSketch>,
    /// How many entries have joined.
    pub landed: usize,
}

/// Read `record` against its own checkout's arc log.
///
/// The log is the one in the cycle's `project_dir`, so a cycle found in
/// another checkout reads its own arcs, not this one's.
pub fn view_cycle(paths: &Paths, record: &CycleRecord) -> CycleView {
    let repo = Path::new(&record.project_dir);
    let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
    let log = fs::read_to_string(&log_path).unwrap_or_default();
    view_cycle_in(&log, record)
}

/// Read `record` against arc log text already in hand.
///
/// The text must be the log of the cycle's own `project_dir`. Every cycle of
/// one checkout reads the same log, so a caller composing all of them reads
/// it once and passes it to each; [`view_cycle`] is this over a fresh read.
pub fn view_cycle_in(log: &str, record: &CycleRecord) -> CycleView {
    let states = entry_states(log, record);
    let entries: Vec<EntryView> = record
        .entries
        .iter()
        .zip(states)
        .map(|(entry, (_, state))| {
            let stages = entry
                .arc
                .as_ref()
                .filter(|link| generation_started_at(log, &link.name) == link.created)
                .and_then(|link| read_arc_in(log, &link.name))
                .map(|arc| arc.stages)
                .unwrap_or_default();
            EntryView {
                entry: entry.clone(),
                state,
                stages,
            }
        })
        .collect();
    CycleView {
        id: record.id.clone(),
        name: record.name.clone(),
        created: record.created.clone(),
        updated: record.updated.clone(),
        project_dir: record.project_dir.clone(),
        created_by: record.created_by.clone(),
        landed: entries
            .iter()
            .filter(|e| e.state == EntryState::Joined)
            .count(),
        entries,
        sketches: record.sketches.clone(),
    }
}

/// This checkout's cycle `id`; refused when it is not here.
fn load(paths: &Paths, repo: &Path, id: &str) -> Result<CycleRecord, ArcError> {
    if !valid_id(id) {
        return Err(ArcError::Refused(format!(
            "{id} is not a cycle id: eight lowercase hex characters"
        )));
    }
    read_record(&cycle_root(paths, repo).join(id))
        .ok_or_else(|| ArcError::Refused(format!("this checkout has no cycle {id}")))
}

fn save(record: &mut CycleRecord) -> Result<(), ArcError> {
    record.updated = now_iso8601();
    write_record(record)
}

fn write_record(record: &CycleRecord) -> Result<(), ArcError> {
    fs::create_dir_all(&record.dir)
        .map_err(|e| ArcError::io("could not create the cycle", &record.dir, e))?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| ArcError::Refused(format!("could not serialize {CYCLE_JSON}: {e}")))?;
    write_atomically(
        &record.dir.join(CYCLE_JSON),
        (json + "\n").as_bytes(),
        "cycle",
    )
}

/// A fresh id no checkout's cycles under the data root already hold.
fn mint_id(paths: &Paths) -> String {
    loop {
        let id = format!("{:08x}", rand::random::<u32>());
        if find_cycle(paths, &id).is_empty() {
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

fn read_record(dir: &Path) -> Option<CycleRecord> {
    let text = fs::read_to_string(dir.join(CYCLE_JSON)).ok()?;
    let mut record: CycleRecord = serde_json::from_str(&text).ok()?;
    record.dir = dir.to_path_buf();
    record.project_dir = canonical_dir(Path::new(&record.project_dir));
    Some(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::documents_dir;
    use tempfile::TempDir;

    fn scratch() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        (temp, repo, paths)
    }

    fn log_append(paths: &Paths, repo: &Path, line: &str) {
        let log = tugtool_core::paths::arc_log_path_at(paths, repo);
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        let mut text = fs::read_to_string(&log).unwrap_or_default();
        text.push_str(line);
        text.push('\n');
        fs::write(log, text).unwrap();
    }

    fn entry(brief: &str, waits: &[u32]) -> NewEntry {
        NewEntry {
            brief: brief.into(),
            waits: waits.to_vec(),
            ..NewEntry::default()
        }
    }

    fn record_sketch(paths: &Paths, repo: &Path, arc: &str) -> String {
        let dir = documents_dir(repo, arc);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sketch.md"), format!("# Sketch\n\n{arc}\n")).unwrap();
        crate::sketch::record_arc_sketch(paths, repo, arc)
            .unwrap()
            .id
    }

    #[test]
    fn create_writes_a_record_that_reads_back_from_anywhere() {
        let (_t, repo, paths) = scratch();
        let made = create_cycle(&paths, &repo, "  Cycles  ", Some("sess-1")).unwrap();
        assert!(valid_id(&made.id));
        assert_eq!(made.name, "Cycles");
        assert_eq!(made.created_by.as_deref(), Some("sess-1"));
        assert!(made.dir.join(CYCLE_JSON).is_file());

        let found = find_cycle(&paths, &made.id);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, made);
        assert_eq!(
            PathBuf::from(&found[0].1.project_dir),
            tugcore::pathform::resolve_to_claude_form(&repo)
        );
        assert_eq!(cycles(&paths, &repo), vec![made]);

        let anon = create_cycle(&paths, &repo, "Other", None).unwrap();
        assert_eq!(anon.created_by, None);
        assert!(matches!(
            create_cycle(&paths, &repo, "  ", None),
            Err(ArcError::Refused(_))
        ));
        assert!(find_cycle(&paths, "../etc").is_empty());
    }

    #[test]
    fn entries_number_in_order_and_waits_are_validated() {
        let (_t, repo, paths) = scratch();
        let id = create_cycle(&paths, &repo, "C", None).unwrap().id;
        assert_eq!(
            add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap(),
            1
        );
        assert_eq!(
            add_entry(&paths, &repo, &id, entry("briefs/b.md", &[1, 1])).unwrap(),
            2
        );

        for (bad, why) in [
            (entry("briefs/c.md", &[3]), "itself"),
            (entry("briefs/c.md", &[9]), "missing"),
            (entry("", &[]), "no brief"),
            (entry("/abs/brief.md", &[]), "absolute"),
        ] {
            let err = add_entry(&paths, &repo, &id, bad).unwrap_err();
            assert!(matches!(err, ArcError::Refused(_)), "{why}: {err:?}");
        }

        let mut noted = entry("briefs/c.md", &[1, 2]);
        noted.note = Some("after the release".into());
        assert_eq!(add_entry(&paths, &repo, &id, noted).unwrap(), 3);

        let record = &find_cycle(&paths, &id)[0].1;
        let numbers: Vec<u32> = record.entries.iter().map(|e| e.n).collect();
        assert_eq!(numbers, vec![1, 2, 3], "refusals consume no number");
        assert_eq!(
            record.entry(2).unwrap().waits,
            vec![1],
            "a repeat wait is kept once"
        );
        assert_eq!(
            record.entry(3).unwrap().note.as_deref(),
            Some("after the release")
        );
    }

    #[test]
    fn a_loop_through_the_waits_is_found() {
        let at = |n: u32, waits: &[u32]| CycleEntry {
            n,
            brief: format!("b{n}.md"),
            arc: None,
            waits: waits.to_vec(),
            from: Vec::new(),
            note: None,
            added: String::new(),
        };
        assert_eq!(wait_loop(&[at(1, &[]), at(2, &[1]), at(3, &[1, 2])]), None);
        assert!(wait_loop(&[at(1, &[3]), at(2, &[1]), at(3, &[2])]).is_some());
        assert!(wait_loop(&[at(1, &[]), at(2, &[2])]).is_some());
    }

    #[test]
    fn sketches_letter_in_order_and_must_be_in_the_store() {
        let (_t, repo, paths) = scratch();
        let id = create_cycle(&paths, &repo, "C", None).unwrap().id;
        let s1 = record_sketch(&paths, &repo, "one");
        let s2 = record_sketch(&paths, &repo, "two");

        assert_eq!(add_sketch(&paths, &repo, &id, &s1).unwrap(), "A");
        assert_eq!(add_sketch(&paths, &repo, &id, &s2).unwrap(), "B");
        assert_eq!(
            add_sketch(&paths, &repo, &id, &s1).unwrap(),
            "A",
            "kept letter"
        );
        assert!(matches!(
            add_sketch(&paths, &repo, &id, "00000000"),
            Err(ArcError::Refused(_))
        ));

        let mut from = entry("briefs/a.md", &[]);
        from.from = vec!["b".into(), "A".into()];
        add_entry(&paths, &repo, &id, from).unwrap();
        let mut stray = entry("briefs/b.md", &[]);
        stray.from = vec!["C".into()];
        assert!(add_entry(&paths, &repo, &id, stray).is_err());

        let record = &find_cycle(&paths, &id)[0].1;
        assert_eq!(record.sketches.len(), 2);
        assert_eq!(record.entry(1).unwrap().from, vec!["B", "A"]);
    }

    #[test]
    fn letters_run_past_z() {
        assert_eq!(letter_for(0), "A");
        assert_eq!(letter_for(25), "Z");
        assert_eq!(letter_for(26), "AA");
        assert_eq!(letter_for(27), "AB");
        assert_eq!(letter_for(26 + 26 * 26), "AAA");
    }

    #[test]
    fn attach_links_the_current_generation_and_guards_an_open_one() {
        let (_t, repo, paths) = scratch();
        let id = create_cycle(&paths, &repo, "C", None).unwrap().id;
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();

        assert!(
            attach(&paths, &repo, &id, 1, "alpha").is_err(),
            "no such arc"
        );
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  alpha  arc-start  brief.md",
        );
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:01Z  beta  arc-start  brief.md",
        );
        assert!(
            attach(&paths, &repo, &id, 7, "alpha").is_err(),
            "no such entry"
        );

        let link = attach(&paths, &repo, &id, 1, "alpha").unwrap();
        assert_eq!(link.created.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert_eq!(
            attach(&paths, &repo, &id, 1, "alpha").unwrap(),
            link,
            "idempotent"
        );
        assert!(
            attach(&paths, &repo, &id, 1, "beta").is_err(),
            "alpha is still open"
        );

        log_append(&paths, &repo, "2026-11-01T01:00:00Z  alpha  discarded");
        let beta = attach(&paths, &repo, &id, 1, "beta").unwrap();
        assert_eq!(beta.name, "beta");

        // A reused name is a new generation, and a new link.
        log_append(&paths, &repo, "2026-11-01T02:00:00Z  beta  discarded");
        log_append(
            &paths,
            &repo,
            "2026-11-02T00:00:00Z  alpha  arc-start  brief.md",
        );
        let again = attach(&paths, &repo, &id, 1, "alpha").unwrap();
        assert_eq!(again.created.as_deref(), Some("2026-11-02T00:00:00Z"));
        let record = &find_cycle(&paths, &id)[0].1;
        assert_eq!(record.entry(1).unwrap().arc.as_ref(), Some(&again));
    }

    #[test]
    fn a_cycle_in_another_checkout_is_not_written_here() {
        let (temp, repo, paths) = scratch();
        let other = temp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let id = create_cycle(&paths, &other, "C", None).unwrap().id;
        assert!(add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).is_err());
        assert!(cycles(&paths, &repo).is_empty());
        assert_eq!(find_cycle(&paths, &id).len(), 1);
    }

    #[test]
    fn the_most_recently_changed_cycle_lists_first() {
        let (_t, repo, paths) = scratch();
        create_cycle(&paths, &repo, "first", None).unwrap();
        let second = create_cycle(&paths, &repo, "second", None).unwrap();
        // Force the order rather than racing the clock.
        let mut older = second.clone();
        older.updated = "2000-01-01T00:00:00Z".into();
        write_record(&older).unwrap();
        let listed: Vec<String> = cycles(&paths, &repo).into_iter().map(|c| c.name).collect();
        assert_eq!(listed, vec!["first", "second"]);
    }

    #[test]
    fn rename_keeps_the_id_and_moves_updated() {
        let (_t, repo, paths) = scratch();
        let made = create_cycle(&paths, &repo, "Old name", Some("sess-1")).unwrap();
        let mut older = made.clone();
        older.updated = "2000-01-01T00:00:00Z".into();
        write_record(&older).unwrap();

        let renamed = rename_cycle(&paths, &repo, &made.id, "  New name ").unwrap();
        assert_eq!(renamed.id, made.id);
        assert_eq!(renamed.name, "New name");
        assert!(renamed.updated.as_str() > "2000-01-01T00:00:00Z");
        assert_eq!(renamed.created_by.as_deref(), Some("sess-1"));
        assert_eq!(find_cycle(&paths, &made.id)[0].1.name, "New name");

        assert!(matches!(
            rename_cycle(&paths, &repo, &made.id, "  "),
            Err(ArcError::Refused(_))
        ));
        assert_eq!(find_cycle(&paths, &made.id)[0].1.name, "New name");
        assert!(rename_cycle(&paths, &repo, "0000beef", "X").is_err());
    }

    #[test]
    fn an_entry_is_found_by_its_brief_in_the_most_recent_cycle() {
        let (temp, repo, paths) = scratch();
        let first = create_cycle(&paths, &repo, "first", None).unwrap().id;
        add_entry(&paths, &repo, &first, entry("briefs/a.md", &[])).unwrap();
        add_entry(&paths, &repo, &first, entry("briefs/b.md", &[])).unwrap();
        assert_eq!(
            find_entry_by_brief(&paths, &repo, "briefs/b.md"),
            Some((first.clone(), 2))
        );
        assert_eq!(
            find_entry_by_brief(&paths, &repo, " ./briefs/a.md "),
            Some((first.clone(), 1)),
            "one spelling of the path"
        );
        assert_eq!(find_entry_by_brief(&paths, &repo, "briefs/none.md"), None);
        assert_eq!(find_entry_by_brief(&paths, &repo, ""), None);

        let mut older = find_cycle(&paths, &first).remove(0).1;
        older.updated = "2000-01-01T00:00:00Z".into();
        write_record(&older).unwrap();
        let second = create_cycle(&paths, &repo, "second", None).unwrap().id;
        add_entry(&paths, &repo, &second, entry("briefs/a.md", &[])).unwrap();
        assert_eq!(
            find_entry_by_brief(&paths, &repo, "briefs/a.md"),
            Some((second, 1)),
            "the most recently changed cycle answers"
        );

        let other = temp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(
            find_entry_by_brief(&paths, &other, "briefs/a.md"),
            None,
            "another checkout's entries are not found here"
        );
    }

    #[test]
    fn cycles_by_keeps_only_the_writers_cycles() {
        let (_t, repo, paths) = scratch();
        let mine = create_cycle(&paths, &repo, "mine", Some("sess-1")).unwrap();
        create_cycle(&paths, &repo, "theirs", Some("sess-2")).unwrap();
        create_cycle(&paths, &repo, "nobody's", None).unwrap();
        let names: Vec<String> = cycles_by(&paths, &repo, "sess-1")
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec![mine.name]);
        assert!(cycles_by(&paths, &repo, "sess-3").is_empty());
    }

    fn linked(n: u32, waits: &[u32], arc: Option<(&str, &str)>) -> CycleEntry {
        CycleEntry {
            n,
            brief: format!("briefs/{n}.md"),
            arc: arc.map(|(name, created)| CycleArc {
                name: name.into(),
                created: Some(created.into()),
            }),
            waits: waits.to_vec(),
            from: Vec::new(),
            note: None,
            added: String::new(),
        }
    }

    fn of(entries: Vec<CycleEntry>) -> CycleRecord {
        CycleRecord {
            id: "00000001".into(),
            name: "C".into(),
            created: String::new(),
            updated: String::new(),
            project_dir: String::new(),
            created_by: None,
            entries,
            sketches: Vec::new(),
            dir: PathBuf::new(),
        }
    }

    const T0: &str = "2026-11-01T00:00:00Z";
    const T2: &str = "2026-11-02T00:00:00Z";

    #[test]
    fn states_follow_joined_open_and_unstarted_arcs() {
        let log = "\
2026-11-01T00:00:00Z  a  arc-start  brief.md
2026-11-01T00:00:00Z  b  arc-start  brief.md
2026-11-01T00:00:00Z  c  arc-start  brief.md
2026-11-01T01:00:00Z  a  302d43b5d1  joined via card
2026-11-01T01:00:00Z  c  discarded
";
        let record = of(vec![
            linked(1, &[], Some(("a", T0))),
            linked(2, &[1], Some(("b", T0))),
            linked(3, &[1], Some(("c", T0))),
            linked(4, &[1], None),
            linked(5, &[1, 2], None),
            linked(6, &[], Some(("never", T0))),
        ]);
        assert_eq!(
            entry_states(log, &record),
            vec![
                (1, EntryState::Joined),
                (2, EntryState::Running),
                (3, EntryState::Ready),
                (4, EntryState::Ready),
                (5, EntryState::Waiting),
                (6, EntryState::Ready),
            ],
            "a discarded arc and a never-logged one read as not started"
        );
    }

    #[test]
    fn a_reused_name_answers_only_for_its_own_generation() {
        let log = "\
2026-11-01T00:00:00Z  a  arc-start  brief.md
2026-11-01T01:00:00Z  a  discarded
2026-11-01T01:00:01Z  a  note  a late note for the ended generation
2026-11-02T00:00:00Z  a  arc-start  brief.md
2026-11-02T01:00:00Z  a  9ac1e0f2aa  joined
";
        let old = CycleArc {
            name: "a".into(),
            created: Some(T0.into()),
        };
        let new = CycleArc {
            name: "a".into(),
            created: Some(T2.into()),
        };
        assert_eq!(link_status(log, &old), LinkStatus::NotStarted);
        assert_eq!(link_status(log, &new), LinkStatus::Joined);
        let stale = CycleArc {
            name: "a".into(),
            created: Some("2026-10-01T00:00:00Z".into()),
        };
        assert_eq!(link_status(log, &stale), LinkStatus::NotStarted);
        let unstamped = CycleArc {
            name: "a".into(),
            created: None,
        };
        assert_eq!(link_status(log, &unstamped), LinkStatus::NotStarted);

        let open_again = format!("{log}2026-11-03T00:00:00Z  a  arc-start  brief.md\n");
        assert_eq!(link_status(&open_again, &new), LinkStatus::Joined);
        let newest = CycleArc {
            name: "a".into(),
            created: Some("2026-11-03T00:00:00Z".into()),
        };
        assert_eq!(link_status(&open_again, &newest), LinkStatus::Open);
    }

    #[test]
    fn an_undone_ending_reopens_the_arc_and_a_redo_restores_it() {
        let link = CycleArc {
            name: "a".into(),
            created: Some(T0.into()),
        };
        // Undoing a join rebuilds the arc's branch and worktree, so the work
        // is off the base and the arc is live again.
        let joined = "\
2026-11-01T00:00:00Z  a  arc-start  brief.md
2026-11-01T01:00:00Z  a  302d43b5d1  joined
2026-11-01T02:00:00Z  a  undone  reversed join (operation 4)
";
        assert_eq!(link_status(joined, &link), LinkStatus::Open);
        let rejoined =
            format!("{joined}2026-11-01T03:00:00Z  a  redone  re-applied join (operation 4)\n");
        assert_eq!(link_status(&rejoined, &link), LinkStatus::Joined);

        let discarded = "\
2026-11-01T00:00:00Z  a  arc-start  brief.md
2026-11-01T01:00:00Z  a  discarded
2026-11-01T02:00:00Z  a  undone  reversed discard (operation 5)
";
        assert_eq!(link_status(discarded, &link), LinkStatus::Open);
        let rediscarded = format!(
            "{discarded}2026-11-01T03:00:00Z  a  redone  re-applied discard (operation 5)\n"
        );
        assert_eq!(link_status(&rediscarded, &link), LinkStatus::NotStarted);

        // An undo of anything else leaves the ending as it was.
        let replayed = "\
2026-11-01T00:00:00Z  a  arc-start  brief.md
2026-11-01T01:00:00Z  a  302d43b5d1  joined
2026-11-01T02:00:00Z  a  undone  reversed replay (operation 3)
";
        assert_eq!(link_status(replayed, &link), LinkStatus::Joined);
    }

    #[test]
    fn a_wait_on_a_running_or_waiting_entry_keeps_waiting() {
        let log = "2026-11-01T00:00:00Z  a  arc-start  brief.md\n";
        let record = of(vec![
            linked(1, &[], Some(("a", T0))),
            linked(2, &[], None),
            linked(3, &[1], None),
            linked(4, &[3], None),
        ]);
        assert_eq!(
            entry_states(log, &record),
            vec![
                (1, EntryState::Running),
                (2, EntryState::Ready),
                (3, EntryState::Waiting),
                (4, EntryState::Waiting),
            ]
        );
    }

    #[test]
    fn view_reads_the_cycles_own_log_and_its_arcs_stages() {
        let (_t, repo, paths) = scratch();
        let id = create_cycle(&paths, &repo, "C", None).unwrap().id;
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();
        add_entry(&paths, &repo, &id, entry("briefs/b.md", &[1])).unwrap();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  aa  arc-start  brief.md",
        );
        crate::arc::append_arc_stage(
            &paths,
            &repo,
            "aa",
            crate::arc::ArcStage::Implement,
            "sess-9",
            None,
        )
        .unwrap();
        attach(&paths, &repo, &id, 1, "aa").unwrap();

        let record = find_cycle(&paths, &id).remove(0).1;
        let view = view_cycle(&paths, &record);
        assert_eq!(view.landed, 0);
        assert_eq!(view.entries[0].state, EntryState::Running);
        assert_eq!(view.entries[0].stages[0].session_id, "sess-9");
        assert_eq!(view.entries[1].state, EntryState::Waiting);

        log_append(
            &paths,
            &repo,
            "2026-11-01T02:00:00Z  aa  302d43b5d1  joined",
        );
        let view = view_cycle(&paths, &record);
        assert_eq!(view.landed, 1);
        assert_eq!(view.entries[0].state, EntryState::Joined);
        assert_eq!(view.entries[1].state, EntryState::Ready);
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["entries"][0]["state"], "joined");
        assert_eq!(json["entries"][0]["n"], 1, "the entry is flattened");
    }

    #[test]
    fn several_cycles_view_from_one_log_text() {
        let (_t, repo, paths) = scratch();
        let first = create_cycle(&paths, &repo, "First", None).unwrap().id;
        let second = create_cycle(&paths, &repo, "Second", None).unwrap().id;
        add_entry(&paths, &repo, &first, entry("briefs/a.md", &[])).unwrap();
        add_entry(&paths, &repo, &second, entry("briefs/b.md", &[])).unwrap();
        add_entry(&paths, &repo, &second, entry("briefs/c.md", &[1])).unwrap();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  aa  arc-start  brief.md",
        );
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:10:00Z  bb  arc-start  brief.md",
        );
        crate::arc::append_arc_stage(
            &paths,
            &repo,
            "bb",
            crate::arc::ArcStage::Implement,
            "sess-b",
            None,
        )
        .unwrap();
        attach(&paths, &repo, &first, 1, "aa").unwrap();
        attach(&paths, &repo, &second, 1, "bb").unwrap();
        log_append(
            &paths,
            &repo,
            "2026-11-01T02:00:00Z  aa  302d43b5d1  joined",
        );

        let log_path = tugtool_core::paths::arc_log_path_at(&paths, &repo);
        let log = fs::read_to_string(&log_path).unwrap();
        let records = cycles(&paths, &repo);
        assert_eq!(records.len(), 2);
        for record in &records {
            assert_eq!(
                view_cycle_in(&log, record),
                view_cycle(&paths, record),
                "the one-text view is the file-reading view"
            );
        }

        let by_id = |id: &str| records.iter().find(|r| r.id == id).unwrap();
        let one = view_cycle_in(&log, by_id(&first));
        assert_eq!(one.landed, 1);
        assert_eq!(one.entries[0].state, EntryState::Joined);
        assert!(one.entries[0].stages.is_empty());
        let two = view_cycle_in(&log, by_id(&second));
        assert_eq!(two.landed, 0);
        assert_eq!(two.entries[0].state, EntryState::Running);
        assert_eq!(two.entries[0].stages[0].session_id, "sess-b");
        assert_eq!(two.entries[1].state, EntryState::Waiting);
    }
}
