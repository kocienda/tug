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
//! neither is ever renumbered or re-lettered. One that will never run is
//! marked dropped by hand and stays where it is. The one removal is a queued
//! entry a session's statement added and a later statement of that session
//! no longer names ([`crate::statement`]); its number is never given again.
//!
//! An entry links its arc by name and generation start, the same shape a
//! sketch links its arc, because an arc name is unique only within one
//! generation. How far an entry has got is never stored: it is derived from
//! the arc log each time the record is read, and so is whether the cycle is
//! closed: every entry settled and no sketch still pending.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::arc::{ArcStageLine, read_arc_in};
use crate::error::ArcError;
use crate::log::{
    ArcFate, arc_fates, generation_started_at, is_terminal, split_log_line, validate_arc_name,
};
use crate::ops::main_repo_root;
use crate::record_lock::{LockMode, hold};
use crate::sketch::{find_sketch, valid_id, write_atomically};
use crate::work_log::{self, By, Privacy, WorkKind, WorkObject};

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
    /// The brief's path, relative to the project root: a display cache,
    /// refreshed from the brief record whenever the core writes the entry.
    pub brief: String,
    /// The brief record's id: the link every comparison goes through.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub brief_id: String,
    /// The arc this entry was queued for, or the arc that carries it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc_name: Option<String>,
    /// A short label a person gave the queued arc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The session, and its turn, that stated the queued arc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stated_by: Option<StatedBy>,
    /// Whether the entry was put on the cycle as planned work. An entry added
    /// because an arc opened on work no entry held is unlisted: it waits on
    /// nothing and is not counted against the run.
    #[serde(default = "listed_by_default")]
    pub listed: bool,
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
    /// When the entry was dropped by hand, as one that will never run. The
    /// one stored fact about how far an entry has got, because only the user
    /// knows it; an arc that is open or joined outranks it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<String>,
}

/// Every entry written before the mark existed was planned work.
fn listed_by_default() -> bool {
    true
}

impl Default for CycleEntry {
    fn default() -> Self {
        CycleEntry {
            n: 0,
            brief: String::new(),
            brief_id: String::new(),
            arc_name: None,
            label: None,
            stated_by: None,
            listed: true,
            arc: None,
            waits: Vec::new(),
            from: Vec::new(),
            note: None,
            added: String::new(),
            dropped: None,
        }
    }
}

/// Who stated a queued arc: a session and, when known, its turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatedBy {
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
    /// Whether the statement added the entry, rather than naming one the
    /// brief skill had recorded. A statement that no longer names the arc
    /// removes an entry it added and returns one it named to what it was.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub added: bool,
}

/// One sketch on a cycle: the sketch store's id under the cycle's letter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleSketch {
    pub letter: String,
    pub id: String,
    /// The brief that wrote this sketch up, when that brief led to further
    /// briefs and has no arc of its own. It is a link to the sketch, never
    /// an entry: an entry with no arc would read as ready forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    /// The record id of that brief: the link, beside the path it caches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief_id: Option<String>,
    pub added: String,
    /// When the sketch was dropped by hand, as one no entry will come from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<String>,
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
    /// The number the next entry is given. A removed entry's number is never
    /// given again, so this runs past every number the record has held.
    #[serde(default)]
    pub next_n: u32,
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
    /// The arc the entry is queued for.
    pub arc_name: Option<String>,
    pub label: Option<String>,
    pub stated_by: Option<StatedBy>,
    /// `Some(false)` for an entry nobody listed; `None` is listed.
    pub listed: Option<bool>,
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
        next_n: 1,
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
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    record.name = name.to_string();
    save(&mut record)?;
    Ok(record)
}

/// Where a brief sits on a cycle: an entry that holds it, or a sketch it
/// wrote up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BriefFound {
    /// The cycle's id.
    pub id: String,
    /// The entry that holds the brief, when one does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    /// The letter of the sketch the brief wrote up, when no entry holds it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub letter: Option<String>,
    /// The letters a new entry for the brief comes from, when every entry
    /// that holds it already has an arc, open or joined: the brief is being
    /// run again, and the run is a new entry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from: Vec<String>,
}

/// The cycle in this checkout that holds brief `brief`, named relative to
/// the project root: through an entry that holds it, or through a sketch
/// that carries it as the brief that wrote it up.
///
/// The path is resolved to its brief record first and every comparison is by
/// the record's id, so a brief that was renamed is still found; a path no
/// record answers for finds nothing.
///
/// The most recently changed cycle is asked first. Within a cycle the
/// earliest entry that can still take an arc answers: one with no arc, or
/// one whose arc was discarded. When every entry holding the brief already
/// has an arc, open or joined, no entry answers and `from` carries the
/// letters of the latest of them, for the new entry another run of the
/// brief is. A sketch answers only when no entry holds the brief. `None`
/// when neither does on any cycle.
pub fn find_by_brief(paths: &Paths, repo: &Path, brief: &str) -> Option<BriefFound> {
    let wanted = normal_brief(brief);
    if wanted.is_empty() {
        return None;
    }
    let id = crate::brief::resolve(paths, repo, wanted)?.id;
    let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
    let log = fs::read_to_string(&log_path).unwrap_or_default();
    cycles(paths, repo).into_iter().find_map(|record| {
        let holding: Vec<&CycleEntry> = record
            .entries
            .iter()
            .filter(|e| e.brief_id == id)
            .collect();
        let free = holding
            .iter()
            .filter(|e| !is_carried(&log, e))
            .map(|e| e.n)
            .min();
        let letter = || {
            record
                .sketches
                .iter()
                .find(|s| s.brief_id.as_deref() == Some(id.as_str()))
                .map(|s| s.letter.clone())
        };
        let (n, letter, from) = match (free, holding.iter().max_by_key(|e| e.n)) {
            (Some(n), _) => (Some(n), None, Vec::new()),
            (None, Some(last)) => (None, None, last.from.clone()),
            (None, None) => (None, Some(letter()?), Vec::new()),
        };
        Some(BriefFound {
            id: record.id.clone(),
            n,
            letter,
            from,
        })
    })
}

/// Whether an arc already carries `entry`: its linked generation is open or
/// ended in a join. A discarded link is history, and leaves the entry free.
pub(crate) fn is_carried(log: &str, entry: &CycleEntry) -> bool {
    entry.arc.as_ref().is_some_and(|link| {
        matches!(
            link_status(log, link),
            LinkStatus::Open | LinkStatus::Joined
        )
    })
}

/// The cycle in this checkout that holds sketch `sketch_id`, with the
/// letter it holds it under, the most recently changed cycle first. This is
/// how a brief finds its cycle from the sketch it comes from, never from the
/// session that writes it.
pub fn find_by_sketch(paths: &Paths, repo: &Path, sketch_id: &str) -> Option<BriefFound> {
    let wanted = sketch_id.trim();
    if wanted.is_empty() {
        return None;
    }
    cycles(paths, repo).into_iter().find_map(|record| {
        let letter = record
            .sketches
            .iter()
            .find(|s| s.id == wanted)
            .map(|s| s.letter.clone())?;
        Some(BriefFound {
            id: record.id.clone(),
            n: None,
            letter: Some(letter),
            from: Vec::new(),
        })
    })
}

/// A brief path in the one spelling entries are compared in: trimmed, with
/// any leading `./` taken off.
pub(crate) fn normal_brief(brief: &str) -> &str {
    let mut path = brief.trim();
    while let Some(rest) = path.strip_prefix("./") {
        path = rest;
    }
    path
}

/// Add an entry to cycle `id` and return its number.
///
/// Refused when the brief path is empty or absolute, when the entry names no
/// sketch it came from, when a wait names an entry that does not exist, and
/// when a `from` letter names no sketch on the cycle. Every link of the chain
/// is refused here, by the record's one writer ([L40]), so no skill has to
/// remember it. A wait can only name an entry already there, so a new entry
/// cannot close a loop; the whole graph is checked all the same.
pub fn add_entry(paths: &Paths, repo: &Path, id: &str, entry: NewEntry) -> Result<u32, ArcError> {
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    let n = add_entry_held(paths, repo, &mut record, entry, &By::none())?;
    save(&mut record)?;
    Ok(n)
}

/// [`add_entry`] on a record whose lock the caller holds, without the save.
/// The entry's brief is reached through its record ([`crate::brief::ensure`]),
/// so it carries the brief's id and its current path. The entry is numbered
/// past every number the record has given, removed entries' included.
pub(crate) fn add_entry_held(
    paths: &Paths,
    repo: &Path,
    record: &mut CycleRecord,
    entry: NewEntry,
    by: &By,
) -> Result<u32, ArcError> {
    let id = record.id.clone();
    let brief = relative_brief(&entry.brief)?;
    let n = next_number(record);
    let waits = checked_waits(record, n, entry.waits)?;
    let mut from: Vec<String> = Vec::new();
    merge_letters(record, &mut from, entry.from)?;
    if from.is_empty() {
        return Err(ArcError::Refused(format!(
            "an entry needs the sketch it came from: add one to cycle {id} and name its letter"
        )));
    }
    let mut entries = record.entries.clone();
    entries.push(CycleEntry {
        n,
        brief: brief.to_string(),
        brief_id: String::new(),
        arc_name: entry.arc_name,
        label: entry
            .label
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        stated_by: entry.stated_by,
        listed: entry.listed.unwrap_or(true),
        arc: None,
        waits,
        from,
        note: entry
            .note
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        added: now_iso8601(),
        dropped: None,
    });
    if let Some(at) = wait_loop(&entries) {
        return Err(ArcError::Refused(format!(
            "the waits would close a loop through entry {at}"
        )));
    }
    let found = crate::brief::ensure(paths, repo, &brief, by)?;
    if let Some(last) = entries.last_mut() {
        last.brief = found.path;
        last.brief_id = found.id;
    }
    record.entries = entries;
    record.next_n = n + 1;
    undrop_sketches(record, n);
    Ok(n)
}

/// The number a new entry of `record` is given: past every number it holds
/// and every number it has given.
pub(crate) fn next_number(record: &CycleRecord) -> u32 {
    let past = record.entries.iter().map(|e| e.n).max().unwrap_or(0) + 1;
    past.max(record.next_n)
}

/// `waits` for entry `n` of `record`, each once. Refused when one names `n`
/// itself or an entry the record does not have.
pub(crate) fn checked_waits(record: &CycleRecord, n: u32, waits: Vec<u32>) -> Result<Vec<u32>, ArcError> {
    let mut out: Vec<u32> = Vec::new();
    for w in waits {
        if w == n {
            return Err(ArcError::Refused(format!(
                "entry {n} cannot wait on itself"
            )));
        }
        if record.entry(w).is_none() {
            return Err(ArcError::Refused(format!(
                "cycle {} has no entry {w} to wait on",
                record.id
            )));
        }
        if !out.contains(&w) {
            out.push(w);
        }
    }
    Ok(out)
}

/// Add `letters` to the sketches entry `n` of cycle `id` came from, and
/// return the entry's letters as written.
///
/// It only adds: a letter already named is kept where it is, nothing is
/// removed, and nothing is renumbered. Refused when no letter is given, when
/// the cycle has no entry `n`, and when a letter names no sketch on the
/// cycle. This is how an entry written before every entry had to name a
/// sketch is repaired.
pub fn add_from(
    paths: &Paths,
    repo: &Path,
    id: &str,
    n: u32,
    letters: Vec<String>,
) -> Result<Vec<String>, ArcError> {
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    if letters.iter().all(|l| l.trim().is_empty()) {
        return Err(ArcError::Refused(
            "name the letter of a sketch to add".into(),
        ));
    }
    let Some(at) = record.entries.iter().position(|e| e.n == n) else {
        return Err(ArcError::Refused(format!("cycle {id} has no entry {n}")));
    };
    let mut from = record.entries[at].from.clone();
    merge_letters(&record, &mut from, letters)?;
    if from != record.entries[at].from {
        record.entries[at].from = from.clone();
        undrop_sketches(&mut record, n);
        save(&mut record)?;
    }
    Ok(from)
}

/// Clear the dropped mark on every sketch entry `n` came from: a sketch an
/// entry names is not one nothing will come from.
fn undrop_sketches(record: &mut CycleRecord, n: u32) {
    let from = record.entry(n).map(|e| e.from.clone()).unwrap_or_default();
    for sketch in &mut record.sketches {
        if from.contains(&sketch.letter) {
            sketch.dropped = None;
        }
    }
}

/// Append each of `letters`, normalized, to `from`, keeping one of each.
/// Refused when a letter names no sketch on `record`.
fn merge_letters(
    record: &CycleRecord,
    from: &mut Vec<String>,
    letters: Vec<String>,
) -> Result<(), ArcError> {
    for letter in letters {
        let letter = letter.trim().to_ascii_uppercase();
        if letter.is_empty() {
            continue;
        }
        if !record.sketches.iter().any(|s| s.letter == letter) {
            return Err(ArcError::Refused(format!(
                "cycle {} has no sketch {letter}",
                record.id
            )));
        }
        if !from.contains(&letter) {
            from.push(letter);
        }
    }
    Ok(())
}

/// A brief path as the record keeps it: trimmed, relative to the project
/// root. Refused when empty or absolute.
fn relative_brief(brief: &str) -> Result<String, ArcError> {
    let brief = normal_brief(brief);
    if brief.is_empty() {
        return Err(ArcError::Refused("an entry needs a brief".into()));
    }
    if Path::new(brief).is_absolute() {
        return Err(ArcError::Refused(format!(
            "the brief is named relative to the project root, not as {brief}"
        )));
    }
    Ok(brief.to_string())
}

/// Add sketch `sketch_id` from the sketch store to cycle `id` and return its
/// letter. A sketch already on the cycle keeps the letter it has.
///
/// `brief` is the brief that wrote the sketch up, when that brief has no arc
/// of its own. It is added to a sketch that carries none; the brief a sketch
/// already carries is never replaced, so naming a different one is refused.
pub fn add_sketch(
    paths: &Paths,
    repo: &Path,
    id: &str,
    sketch_id: &str,
    brief: Option<&str>,
) -> Result<String, ArcError> {
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    let brief = brief.map(relative_brief).transpose()?;
    let brief_id = brief
        .as_deref()
        .map(|b| crate::brief::ensure(paths, repo, b, &By::none()))
        .transpose()?
        .map(|o| o.id);
    if let Some(at) = record.sketches.iter().position(|s| s.id == sketch_id) {
        let letter = record.sketches[at].letter.clone();
        let held_id = record.sketches[at].brief_id.clone();
        match (&record.sketches[at].brief, brief) {
            (_, None) => {}
            (Some(held), Some(given)) if *held == given || held_id == brief_id => {}
            (Some(held), Some(_)) => {
                return Err(ArcError::Refused(format!(
                    "sketch {letter} already carries the brief {held}"
                )));
            }
            (None, Some(given)) => {
                record.sketches[at].brief = Some(given);
                record.sketches[at].brief_id = brief_id;
                save(&mut record)?;
            }
        }
        return Ok(letter);
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
        brief,
        brief_id,
        added: now_iso8601(),
        dropped: None,
    });
    save(&mut record)?;
    Ok(letter)
}

/// Tie entry `n` of cycle `id` to arc `arc`'s current generation.
///
/// Refused when the arc log never recorded the arc, when the entry already
/// links a different arc generation that is open or has joined, and when
/// another entry of this checkout's cycles already carries the arc: an entry
/// has one arc and an arc one entry. Attaching the link an entry already
/// holds changes nothing; a link to a generation that was discarded is
/// replaced, so an entry whose arc was discarded can be carried by a new
/// one. A joined link is never replaced, because it is the record of what
/// landed: a brief run again is a new entry. Attaching clears a dropped
/// mark: an entry that is run after all is carried like any other.
pub fn attach(
    paths: &Paths,
    repo: &Path,
    id: &str,
    n: u32,
    arc: &str,
) -> Result<CycleArc, ArcError> {
    validate_arc_name(arc).map_err(ArcError::InvalidName)?;
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
    let log = fs::read_to_string(&log_path).unwrap_or_default();
    let (link, changed) = attach_held(paths, repo, &mut record, n, arc, &log)?;
    if changed {
        save(&mut record)?;
    }
    Ok(link)
}

/// [`attach`] on a record whose lock the caller holds, against arc log text
/// already read, without the save. Returns the link and whether the record
/// changed. The entry takes the arc's name as its own.
fn attach_held(
    paths: &Paths,
    repo: &Path,
    record: &mut CycleRecord,
    n: u32,
    arc: &str,
    log: &str,
) -> Result<(CycleArc, bool), ArcError> {
    let id = record.id.clone();
    let Some(start) = generation_started_at(log, arc) else {
        return Err(ArcError::Refused(format!(
            "the arc log has no arc named {arc}"
        )));
    };
    let link = CycleArc {
        name: arc.to_string(),
        created: Some(start),
    };
    for other in cycles(paths, repo) {
        let held = other
            .entries
            .iter()
            .find(|e| e.arc.as_ref() == Some(&link) && !(other.id == record.id && e.n == n));
        if let Some(e) = held {
            return Err(ArcError::Refused(format!(
                "arc {arc} is already carried by entry {} of cycle {}",
                e.n, other.id
            )));
        }
    }
    let Some(entry) = record.entries.iter_mut().find(|e| e.n == n) else {
        return Err(ArcError::Refused(format!("cycle {id} has no entry {n}")));
    };
    match &entry.arc {
        Some(held) if *held == link && entry.dropped.is_none() => {
            let named = entry.arc_name.as_deref() != Some(arc);
            entry.arc_name = Some(arc.to_string());
            return Ok((link, named));
        }
        Some(held) if *held == link => {}
        Some(held) => match link_status(log, held) {
            LinkStatus::Open => {
                return Err(ArcError::Refused(format!(
                    "entry {n} is already carried by arc {}, which is still open",
                    held.name
                )));
            }
            LinkStatus::Joined => {
                return Err(ArcError::Refused(format!(
                    "entry {n} landed with arc {}: a brief run again is a new entry, so add one with `tugtool cycle add-entry {id} --brief {} --from {}` and attach {arc} to the number it prints",
                    held.name,
                    entry.brief,
                    entry.from.join(" --from ")
                )));
            }
            LinkStatus::Discarded | LinkStatus::NotStarted => {}
        },
        None => {}
    }
    entry.arc = Some(link.clone());
    entry.arc_name = Some(arc.to_string());
    entry.dropped = None;
    Ok((link, true))
}

/// What a placement did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// The work was already where it was asked to go; nothing was written.
    Already,
    /// An entry already on a cycle took the arc.
    Filled,
    /// A new entry was added to a cycle already there.
    Added,
    /// A new cycle was started for the work.
    Started,
    /// An entry already holding the brief was named for a queued arc.
    Named,
    /// A brief was recorded on a sketch as the brief that wrote it up.
    Linked,
}

/// Where a placement put the work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Placed {
    /// The cycle's id.
    pub cycle: String,
    /// The cycle's name.
    pub name: String,
    /// The entry the work is, when it is one.
    pub n: Option<u32>,
    /// The first letter the entry came from, or the sketch a brief was linked to.
    pub letter: Option<String>,
    pub outcome: Outcome,
}

/// What the `/arc` door says when an arc opens: the arc, the brief it opened
/// on, the sketch it came from, and a name for a cycle it may have to start.
#[derive(Debug, Clone, Copy)]
pub struct PlaceArc<'a> {
    pub arc: &'a str,
    pub brief: &'a str,
    pub sketch: Option<&'a str>,
    pub name: Option<&'a str>,
    pub by: &'a By,
}

/// What the brief skill says when it writes a brief: the brief, the sketch it
/// came from or the brief it followed, the cycle when the caller knows it, a
/// name for a cycle it may have to start, and the entry's waits and note.
#[derive(Debug, Clone)]
pub struct PlaceBrief<'a> {
    pub brief: &'a str,
    pub sketch: Option<&'a str>,
    pub from_brief: Option<&'a str>,
    pub cycle: Option<&'a str>,
    pub name: Option<&'a str>,
    pub waits: Vec<u32>,
    pub note: Option<&'a str>,
    pub by: &'a By,
}

/// What a statement of queued work says: the arc to run, the brief it runs,
/// the cycle when the caller knows it, a label, what it waits on, and the
/// letters it came from.
#[derive(Debug, Clone)]
pub struct QueueArc<'a> {
    pub arc: &'a str,
    pub brief: &'a str,
    pub cycle: Option<&'a str>,
    pub label: Option<&'a str>,
    pub waits: Vec<u32>,
    /// The arc whose entry this one waits on, by name.
    pub after: Option<&'a str>,
    pub from: Vec<String>,
    pub by: &'a By,
}

/// Put an opened arc on the entry that is its work, the first rule that
/// answers winning:
///
/// 1. An entry already links the arc's current generation: nothing changes.
/// 2. An entry is queued under the arc's name and nothing carries it: the arc
///    fills it. The name is the match, never the brief, and an entry queued
///    for this name with another brief is refused rather than guessed past.
/// 3. The brief is on a cycle: a free entry nobody queued takes the arc; a
///    sketch the brief wrote up, or the latest entry holding it, gives the
///    letters of a new entry. An entry queued under another name is never
///    taken.
/// 4. The sketch is on a cycle: a new entry from its letter.
/// 5. Otherwise a new cycle named `name`, with the sketch as A and the arc's
///    entry as 1.
///
/// An entry added by rules 3 and 4 was on nobody's list, so it is unlisted
/// and waits on nothing.
///
/// A placement that moved anything grounds every held statement naming the
/// arc ([`crate::statement::ground_statements`]): the rest of its list joins
/// the cycle the arc is now on. A failure there is said on stderr and never
/// fails the placement.
pub fn place_arc(paths: &Paths, repo: &Path, req: PlaceArc) -> Result<Placed, ArcError> {
    let placed = place_arc_held(paths, repo, req)?;
    if placed.outcome != Outcome::Already {
        if let Err(e) = crate::statement::ground_statements(paths, repo, req.arc) {
            eprintln!("could not place the statements holding arc {}: {e}", req.arc);
        }
    }
    Ok(placed)
}

/// [`place_arc`]'s rules; every branch has released its cycle lock when it
/// returns.
fn place_arc_held(paths: &Paths, repo: &Path, req: PlaceArc) -> Result<Placed, ArcError> {
    validate_arc_name(req.arc).map_err(ArcError::InvalidName)?;
    let log = arc_log_text(paths, repo);
    let Some(start) = generation_started_at(&log, req.arc) else {
        return Err(ArcError::Refused(format!(
            "the arc log has no arc named {}",
            req.arc
        )));
    };
    let link = CycleArc {
        name: req.arc.to_string(),
        created: Some(start),
    };
    let all = cycles(paths, repo);
    for record in &all {
        if let Some(e) = record.entries.iter().find(|e| e.arc.as_ref() == Some(&link)) {
            return Ok(placed(record, Some(e.n), Outcome::Already));
        }
    }

    let brief = crate::brief::ensure(paths, repo, req.brief, req.by)?;
    refresh_brief(paths, repo, &brief.id);

    for record in &all {
        let queued = record
            .entries
            .iter()
            .find(|e| e.arc_name.as_deref() == Some(req.arc) && !is_carried(&log, e));
        if let Some(e) = queued {
            if e.brief_id != brief.id {
                return Err(ArcError::Refused(format!(
                    "entry {} of cycle {} is queued for arc {} with the brief {}, not {}",
                    e.n, record.id, req.arc, e.brief, brief.path
                )));
            }
            return fill(paths, repo, &record.id, e.n, req.arc, &log);
        }
    }

    for record in &all {
        let holding: Vec<&CycleEntry> = record
            .entries
            .iter()
            .filter(|e| e.brief_id == brief.id)
            .collect();
        let free = holding
            .iter()
            .filter(|e| e.arc_name.is_none() && !is_carried(&log, e))
            .min_by_key(|e| e.n);
        if let Some(e) = free {
            return fill(paths, repo, &record.id, e.n, req.arc, &log);
        }
        let from = match holding.iter().max_by_key(|e| e.n) {
            Some(last) => last.from.clone(),
            None => match record
                .sketches
                .iter()
                .find(|s| s.brief_id.as_deref() == Some(brief.id.as_str()))
            {
                Some(s) => vec![s.letter.clone()],
                None => continue,
            },
        };
        return add_carried(paths, repo, &record.id, &brief.path, from, req.arc, false, &log);
    }

    if let Some(found) = req.sketch.and_then(|s| find_by_sketch(paths, repo, s)) {
        let from = found.letter.into_iter().collect();
        return add_carried(paths, repo, &found.id, &brief.path, from, req.arc, false, &log);
    }

    let Some(sketch) = req.sketch else {
        return Err(ArcError::Refused(format!(
            "arc {} is on no cycle: name the sketch it came from to start one",
            req.arc
        )));
    };
    let Some(name) = req.name else {
        return Err(ArcError::Refused(format!(
            "arc {} is on no cycle: name the cycle to start for it",
            req.arc
        )));
    };
    let record = create_cycle(paths, repo, name, creator(req.by))?;
    let letter = add_sketch(paths, repo, &record.id, sketch, None)?;
    let mut out = add_carried(paths, repo, &record.id, &brief.path, vec![letter], req.arc, true, &log)?;
    out.outcome = Outcome::Started;
    Ok(out)
}

/// Record a brief the brief skill wrote, and put it on its cycle as listed
/// work.
///
/// The brief is recorded first ([`crate::brief::record`], which writes its id
/// line and names the sketch it came from). Its cycle is `cycle` when given,
/// else the one holding `sketch`, else the one holding `from_brief`, else a
/// new cycle named `name`. A `from_brief` that is on no cycle and is no arc's
/// brief is recorded on the sketch as the brief that wrote it up. The brief
/// then gets an entry from the sketch's letter, or from `from_brief`'s,
/// unless a free entry already holds it.
pub fn place_brief(paths: &Paths, repo: &Path, req: PlaceBrief) -> Result<Placed, ArcError> {
    let sketches: Vec<String> = req.sketch.map(str::to_string).into_iter().collect();
    let brief = crate::brief::record(paths, repo, req.brief, &sketches, req.by)?;
    let from_brief = req
        .from_brief
        .map(|p| crate::brief::ensure(paths, repo, p, req.by))
        .transpose()?;
    let all = cycles(paths, repo);
    let holds = |record: &CycleRecord, id: &str| {
        record.entries.iter().any(|e| e.brief_id == id)
            || record.sketches.iter().any(|s| s.brief_id.as_deref() == Some(id))
    };
    let from_placed = from_brief
        .as_ref()
        .and_then(|f| all.iter().find(|r| holds(r, &f.id)))
        .map(|r| r.id.clone());

    let mut started = false;
    let cycle_id = if let Some(id) = req.cycle {
        load(paths, repo, id)?.id
    } else if let Some(found) = req.sketch.and_then(|s| find_by_sketch(paths, repo, s)) {
        found.id
    } else if let Some(id) = &from_placed {
        id.clone()
    } else {
        // A new cycle's entry comes from its sketch, and only `sketch` can
        // be one, so a cycle with nothing to come from is never started.
        if req.sketch.is_none() {
            return Err(ArcError::Refused(format!(
                "brief {} is on no cycle: name the sketch it was written from to start one",
                brief.path
            )));
        }
        let Some(name) = req.name else {
            return Err(ArcError::Refused(format!(
                "brief {} is on no cycle: name the cycle to start for it",
                brief.path
            )));
        };
        started = true;
        create_cycle(paths, repo, name, creator(req.by))?.id
    };
    let letter = req
        .sketch
        .map(|s| add_sketch(paths, repo, &cycle_id, s, None))
        .transpose()?;

    let _held = hold_cycle(paths, repo, &cycle_id)?;
    let mut record = load(paths, repo, &cycle_id)?;
    let log = arc_log_text(paths, repo);

    let mut linked = false;
    if let Some(f) = &from_brief {
        if from_placed.is_none() && !holds(&record, &f.id) && !is_arcs_brief(repo, &log, &f.path) {
            let Some(letter) = &letter else {
                return Err(ArcError::Refused(format!(
                    "brief {} follows {}, which is on no cycle: name the sketch {} wrote up",
                    brief.path, f.path, f.path
                )));
            };
            let Some(s) = record.sketches.iter_mut().find(|s| &s.letter == letter) else {
                return Err(ArcError::Refused(format!("cycle {cycle_id} has no sketch {letter}")));
            };
            match &s.brief_id {
                None => {
                    s.brief = Some(f.path.clone());
                    s.brief_id = Some(f.id.clone());
                    linked = true;
                }
                Some(held) if *held == f.id => {}
                Some(_) => {
                    return Err(ArcError::Refused(format!(
                        "sketch {letter} already carries the brief {}",
                        s.brief.clone().unwrap_or_default()
                    )));
                }
            }
        }
    }

    let free = record
        .entries
        .iter()
        .find(|e| e.brief_id == brief.id && e.arc_name.is_none() && !is_carried(&log, e))
        .map(|e| e.n);
    if let Some(n) = free {
        if linked {
            save(&mut record)?;
        }
        let outcome = if linked { Outcome::Linked } else { Outcome::Already };
        return Ok(placed(&record, Some(n), outcome));
    }

    let from: Vec<String> = match (&letter, &from_brief) {
        (Some(l), _) => vec![l.clone()],
        (None, Some(f)) => letters_of(&record, &f.id),
        (None, None) => Vec::new(),
    };
    if from.is_empty() {
        return Err(ArcError::Refused(format!(
            "brief {} has no sketch to come from: name the sketch it was written from",
            brief.path
        )));
    }
    let n = add_entry_held(
        paths,
        repo,
        &mut record,
        NewEntry {
            brief: brief.path.clone(),
            waits: req.waits,
            from,
            note: req.note.map(str::to_string),
            listed: Some(true),
            ..NewEntry::default()
        },
        req.by,
    )?;
    save(&mut record)?;
    let outcome = if started {
        Outcome::Started
    } else if linked {
        Outcome::Linked
    } else {
        Outcome::Added
    };
    Ok(placed(&record, Some(n), outcome))
}

/// Queue arc `arc` to run brief `brief` on its cycle, as listed work.
///
/// Refused when the name is not an arc name, or another entry of this
/// checkout holds it and is neither joined nor dropped: a name is held by one
/// unsettled entry at a time. The cycle is `cycle` when given, else the one
/// holding the brief. `after` names the arc whose entry this one waits on.
/// A free entry nobody queued that holds the brief is named in place;
/// otherwise a new entry is added, from `from` or from the letters the brief
/// already came from.
pub fn queue_arc(paths: &Paths, repo: &Path, req: QueueArc) -> Result<Placed, ArcError> {
    validate_arc_name(req.arc).map_err(ArcError::InvalidName)?;
    let log = arc_log_text(paths, repo);
    let all = cycles(paths, repo);
    for record in &all {
        let states = entry_states(&log, record);
        for (e, (_, state)) in record.entries.iter().zip(states) {
            if e.arc_name.as_deref() == Some(req.arc) && !state.is_settled() {
                return Err(ArcError::Refused(format!(
                    "arc {} is already queued as entry {} of cycle {}",
                    req.arc, e.n, record.id
                )));
            }
        }
    }
    let brief = crate::brief::ensure(paths, repo, req.brief, req.by)?;
    let cycle_id = match req.cycle {
        Some(id) => load(paths, repo, id)?.id,
        None => all
            .iter()
            .find(|r| {
                r.entries.iter().any(|e| e.brief_id == brief.id)
                    || r.sketches.iter().any(|s| s.brief_id.as_deref() == Some(brief.id.as_str()))
            })
            .map(|r| r.id.clone())
            .ok_or_else(|| {
                ArcError::Refused(format!("no cycle holds {}; name one", brief.path))
            })?,
    };

    let _held = hold_cycle(paths, repo, &cycle_id)?;
    let mut record = load(paths, repo, &cycle_id)?;
    let mut waits = req.waits;
    if let Some(after) = req.after {
        let Some(e) = record.entries.iter().find(|e| e.arc_name.as_deref() == Some(after)) else {
            return Err(ArcError::Refused(format!(
                "cycle {cycle_id} has no entry queued for arc {after}"
            )));
        };
        if !waits.contains(&e.n) {
            waits.push(e.n);
        }
    }
    let stated_by = match req.by.privacy {
        Privacy::Private => None,
        _ => req.by.session.clone().map(|session| StatedBy {
            session,
            turn: req.by.turn,
            added: false,
        }),
    };
    let label = req
        .label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let free = record
        .entries
        .iter()
        .position(|e| e.brief_id == brief.id && e.arc_name.is_none() && !is_carried(&log, e));
    let (n, outcome) = if let Some(at) = free {
        let n = record.entries[at].n;
        let waits = checked_waits(&record, n, waits)?;
        let mut entries = record.entries.clone();
        let e = &mut entries[at];
        e.arc_name = Some(req.arc.to_string());
        e.label = label.clone();
        e.stated_by = stated_by;
        e.listed = true;
        for w in waits {
            if !e.waits.contains(&w) {
                e.waits.push(w);
            }
        }
        if let Some(at) = wait_loop(&entries) {
            return Err(ArcError::Refused(format!(
                "the waits would close a loop through entry {at}"
            )));
        }
        record.entries = entries;
        (n, Outcome::Named)
    } else {
        let from = if req.from.is_empty() {
            queued_letters(paths, &record, &brief.id)
        } else {
            req.from
        };
        let stated_by = stated_by.map(|s| StatedBy { added: true, ..s });
        let n = add_entry_held(
            paths,
            repo,
            &mut record,
            NewEntry {
                brief: brief.path.clone(),
                waits,
                from,
                arc_name: Some(req.arc.to_string()),
                label: label.clone(),
                stated_by,
                listed: Some(true),
                ..NewEntry::default()
            },
            req.by,
        )?;
        (n, Outcome::Added)
    };
    save(&mut record)?;
    let mut detail = serde_json::json!({ "arc": req.arc, "brief": brief.id });
    if let Some(label) = &label {
        detail["label"] = serde_json::Value::String(label.clone());
    }
    log_work(
        paths,
        repo,
        WorkKind::ArcQueued,
        WorkObject::Cycle {
            cycle: record.id.clone(),
            n,
        },
        detail,
        req.by,
    );
    Ok(placed(&record, Some(n), outcome))
}

/// The letters a queued arc for brief `brief_id` comes from on `record`: the
/// latest entry already holding the brief, else a sketch the brief's record
/// names as one it came from, else the sketch the brief wrote up.
pub(crate) fn queued_letters(paths: &Paths, record: &CycleRecord, brief_id: &str) -> Vec<String> {
    if let Some(e) = record
        .entries
        .iter()
        .filter(|e| e.brief_id == brief_id)
        .max_by_key(|e| e.n)
    {
        return e.from.clone();
    }
    let came_from: Vec<String> = crate::brief::find_brief(paths, brief_id)
        .into_iter()
        .flat_map(|(_, r)| r.sketches)
        .collect();
    if let Some(s) = record.sketches.iter().find(|s| came_from.contains(&s.id)) {
        return vec![s.letter.clone()];
    }
    letters_of(record, brief_id)
}

/// The letters brief `brief_id` came from on `record`: the latest entry
/// holding it, else the sketch it wrote up.
fn letters_of(record: &CycleRecord, brief_id: &str) -> Vec<String> {
    if let Some(e) = record
        .entries
        .iter()
        .filter(|e| e.brief_id == brief_id)
        .max_by_key(|e| e.n)
    {
        return e.from.clone();
    }
    record
        .sketches
        .iter()
        .find(|s| s.brief_id.as_deref() == Some(brief_id))
        .map(|s| vec![s.letter.clone()])
        .unwrap_or_default()
}

/// Attach `arc` to entry `n` of cycle `id` under the cycle's lock.
fn fill(
    paths: &Paths,
    repo: &Path,
    id: &str,
    n: u32,
    arc: &str,
    log: &str,
) -> Result<Placed, ArcError> {
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    let (_, changed) = attach_held(paths, repo, &mut record, n, arc, log)?;
    if changed {
        save(&mut record)?;
    }
    Ok(placed(&record, Some(n), Outcome::Filled))
}

/// Add an entry for `brief` from `from` to cycle `id` and attach `arc` to it,
/// under one hold of the cycle's lock and in one write. An entry nobody
/// listed waits on nothing.
#[allow(clippy::too_many_arguments)]
fn add_carried(
    paths: &Paths,
    repo: &Path,
    id: &str,
    brief: &str,
    from: Vec<String>,
    arc: &str,
    listed: bool,
    log: &str,
) -> Result<Placed, ArcError> {
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    let n = add_entry_held(
        paths,
        repo,
        &mut record,
        NewEntry {
            brief: brief.to_string(),
            from,
            arc_name: Some(arc.to_string()),
            listed: Some(listed),
            ..NewEntry::default()
        },
        &By::none(),
    )?;
    attach_held(paths, repo, &mut record, n, arc, log)?;
    save(&mut record)?;
    Ok(placed(&record, Some(n), Outcome::Added))
}

/// A placement's answer for entry `n` of `record`.
fn placed(record: &CycleRecord, n: Option<u32>, outcome: Outcome) -> Placed {
    Placed {
        cycle: record.id.clone(),
        name: record.name.clone(),
        n,
        letter: n
            .and_then(|n| record.entry(n))
            .and_then(|e| e.from.first().cloned()),
        outcome,
    }
}

/// Who a new cycle is created by: the caller's session, unless it is private.
fn creator(by: &By) -> Option<&str> {
    match by.privacy {
        Privacy::Private => None,
        _ => by.session.as_deref(),
    }
}

/// Add every commit that changed brief `id` and its record does not hold.
fn refresh_brief(paths: &Paths, repo: &Path, id: &str) {
    let root = crate::brief::brief_root(paths, repo);
    let found = crate::brief::find_brief(paths, id)
        .into_iter()
        .map(|(_, r)| r)
        .find(|r| r.dir.starts_with(&root));
    if let Some(mut record) = found {
        if let Err(e) = crate::brief::refresh_versions(paths, repo, &mut record) {
            eprintln!("could not read brief {id}'s commits: {e}");
        }
    }
}

/// Whether some arc in `log` was opened on the brief at `path`.
fn is_arcs_brief(repo: &Path, log: &str, path: &str) -> bool {
    let root = main_repo_root(repo);
    log.lines().filter_map(split_log_line).any(|(_, _, marker, note)| {
        if marker != "arc-start" {
            return false;
        }
        let note = normal_brief(note);
        let rel = Path::new(note)
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| note.to_string());
        rel == path
    })
}

/// This checkout's arc log, as text.
pub(crate) fn arc_log_text(paths: &Paths, repo: &Path) -> String {
    fs::read_to_string(tugtool_core::paths::arc_log_path_at(paths, repo)).unwrap_or_default()
}

/// What [`drop_item`] marked: an entry by its number, or a sketch by its
/// letter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DroppedItem {
    Entry(u32),
    Sketch(String),
}

/// Mark entry `n` or sketch `letter` of cycle `id` as dropped: one that will
/// never run. `item` is the entry's number or the sketch's letter.
///
/// Nothing is removed and nothing is renumbered. An entry whose arc is open
/// or joined is refused: a running arc is ended by discarding it, and a
/// joined one is already settled. A sketch an entry came from is refused
/// too, because that entry is what there is to drop. Dropping what is
/// already dropped changes nothing.
pub fn drop_item(
    paths: &Paths,
    repo: &Path,
    id: &str,
    item: &str,
) -> Result<DroppedItem, ArcError> {
    let _held = hold_cycle(paths, repo, id)?;
    let mut record = load(paths, repo, id)?;
    let item = item.trim();
    if let Ok(n) = item.parse::<u32>() {
        let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
        let log = fs::read_to_string(&log_path).unwrap_or_default();
        let Some(at) = record.entries.iter().position(|e| e.n == n) else {
            return Err(ArcError::Refused(format!("cycle {id} has no entry {n}")));
        };
        let link = record.entries[at].arc.clone();
        let held = link.as_ref().map(|a| a.name.as_str()).unwrap_or_default();
        match link
            .as_ref()
            .map_or(LinkStatus::NotStarted, |link| link_status(&log, link))
        {
            LinkStatus::Open => {
                return Err(ArcError::Refused(format!(
                    "entry {n} is carried by arc {held}, which is still open: discard the arc instead"
                )));
            }
            LinkStatus::Joined => {
                return Err(ArcError::Refused(format!(
                    "entry {n} has landed: arc {held} joined"
                )));
            }
            LinkStatus::Discarded | LinkStatus::NotStarted => {}
        }
        if record.entries[at].dropped.is_none() {
            record.entries[at].dropped = Some(now_iso8601());
            save(&mut record)?;
            let detail = serde_json::json!({ "brief": record.entries[at].brief_id });
            log_work(
                paths,
                repo,
                WorkKind::EntryDropped,
                WorkObject::Cycle {
                    cycle: record.id.clone(),
                    n,
                },
                detail,
                &By::none(),
            );
        }
        return Ok(DroppedItem::Entry(n));
    }
    let letter = item.to_ascii_uppercase();
    let Some(at) = record.sketches.iter().position(|s| s.letter == letter) else {
        return Err(ArcError::Refused(format!(
            "cycle {id} has no entry or sketch {item}"
        )));
    };
    if let Some(e) = record.entries.iter().find(|e| e.from.contains(&letter)) {
        return Err(ArcError::Refused(format!(
            "sketch {letter} has entry {}: drop the entry instead",
            e.n
        )));
    }
    if record.sketches[at].dropped.is_none() {
        record.sketches[at].dropped = Some(now_iso8601());
        save(&mut record)?;
    }
    Ok(DroppedItem::Sketch(letter))
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
            let record = read_current(paths, &state.join("cycles").join(id))?;
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
        .filter_map(|e| read_current(paths, &e.path()))
        .collect();
    all.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    all
}

/// Every cycle on this machine, in every checkout's store, ordered by
/// checkout and then by id.
pub fn all_cycles(paths: &Paths) -> Vec<CycleRecord> {
    let projects = paths.base_data_dir.join("projects");
    let Ok(read) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut all: Vec<CycleRecord> = read
        .filter_map(|e| e.ok())
        .map(|e| e.path().join("cycles"))
        .filter_map(|root| fs::read_dir(root).ok())
        .flat_map(|dirs| dirs.filter_map(|e| e.ok()))
        .filter(|e| valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| read_current(paths, &e.path()))
        .collect();
    all.sort_by(|a, b| {
        a.project_dir
            .cmp(&b.project_dir)
            .then_with(|| a.id.cmp(&b.id))
    });
    all
}

/// A cycle that breaks the chain, and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChainBreak {
    pub id: String,
    pub name: String,
    pub project_dir: String,
    /// One sentence per broken link.
    pub problems: Vec<String>,
}

/// The links `record` breaks by itself: an entry with no brief, an entry
/// that names no sketch, an entry whose brief has no record, and a letter
/// that names no sketch on the cycle.
pub fn chain_breaks(record: &CycleRecord) -> Vec<String> {
    let mut problems = Vec::new();
    for e in &record.entries {
        if e.brief.trim().is_empty() {
            problems.push(format!("entry {} has no brief", e.n));
        } else if e.brief_id.is_empty() {
            problems.push(format!("entry {} has no brief record", e.n));
        }
        if e.from.is_empty() {
            problems.push(format!("entry {} names no sketch", e.n));
        }
        for letter in &e.from {
            if !record.sketches.iter().any(|s| &s.letter == letter) {
                problems.push(format!(
                    "entry {} names sketch {letter}, which the cycle does not have",
                    e.n
                ));
            }
        }
    }
    problems
}

/// Every cycle on this machine that breaks the chain: what each breaks by
/// itself ([`chain_breaks`]), a sketch the sketch store no longer holds, and
/// an arc generation carried by more than one entry, on one cycle or across
/// a checkout's cycles. Empty when every record is whole.
pub fn check_cycles(paths: &Paths) -> Vec<ChainBreak> {
    let records = all_cycles(paths);
    // (checkout, arc, generation) → every (cycle id, entry) carrying it.
    let mut carriers: std::collections::BTreeMap<(String, String, String), Vec<(String, u32)>> =
        std::collections::BTreeMap::new();
    for record in &records {
        for e in &record.entries {
            if let Some(arc) = &e.arc {
                carriers
                    .entry((
                        record.project_dir.clone(),
                        arc.name.clone(),
                        arc.created.clone().unwrap_or_default(),
                    ))
                    .or_default()
                    .push((record.id.clone(), e.n));
            }
        }
    }
    records
        .iter()
        .filter_map(|record| {
            let mut problems = chain_breaks(record);
            for s in &record.sketches {
                if find_sketch(paths, &s.id).is_empty() {
                    problems.push(format!(
                        "sketch {} ({}) is not in the sketch store",
                        s.letter, s.id
                    ));
                }
            }
            for ((dir, arc, _), held) in &carriers {
                if held.len() < 2 || *dir != record.project_dir {
                    continue;
                }
                if !held.iter().any(|(id, _)| *id == record.id) {
                    continue;
                }
                let all: Vec<String> = held
                    .iter()
                    .map(|(id, n)| format!("{id} entry {n}"))
                    .collect();
                problems.push(format!(
                    "arc {arc} is carried by more than one entry: {}",
                    all.join(", ")
                ));
            }
            (!problems.is_empty()).then(|| ChainBreak {
                id: record.id.clone(),
                name: record.name.clone(),
                project_dir: record.project_dir.clone(),
                problems,
            })
        })
        .collect()
}

/// A live arc that no cycle's entry carries: the gap between `arc run` and
/// `cycle attach` that a cycle of one's attach never closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnattachedArc {
    pub arc: String,
    /// The open generation's start, when the log records one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// The checkout whose arc log holds it, canonical ([L29]).
    pub project_dir: String,
}

/// Every live arc on this machine that no cycle's entry carries, ordered by
/// checkout and then by name.
///
/// The checkouts read are the ones that keep cycles, each read against its
/// own arc log once. A checkout with no cycle record at all has never used
/// them, so its arcs are not a gap in a chain it keeps; and a state dir's slug
/// cannot be turned back into the checkout it keys, so there is no other way
/// to name one.
pub fn unattached_arcs(paths: &Paths) -> Vec<UnattachedArc> {
    let records = all_cycles(paths);
    let mut dirs: Vec<&str> = records.iter().map(|r| r.project_dir.as_str()).collect();
    dirs.dedup();
    dirs.into_iter()
        .flat_map(|dir| {
            let log_path = tugtool_core::paths::arc_log_path_at(paths, Path::new(dir));
            let log = fs::read_to_string(&log_path).unwrap_or_default();
            let here: Vec<&CycleRecord> = records.iter().filter(|r| r.project_dir == dir).collect();
            unattached_arcs_in(&log, dir, &here)
        })
        .collect()
}

/// The live arcs in `log`, the arc log of `project_dir`, that no entry of
/// `records` carries. An entry carries an arc when it links the arc's name
/// and the open generation's start; a link with no start answers for the
/// name alone.
pub fn unattached_arcs_in(
    log: &str,
    project_dir: &str,
    records: &[&CycleRecord],
) -> Vec<UnattachedArc> {
    arc_fates(log)
        .into_iter()
        .filter(|(_, fate)| *fate == ArcFate::Live)
        .filter_map(|(name, _)| {
            let created = generation_started_at(log, &name);
            let carried = records.iter().flat_map(|r| &r.entries).any(|e| {
                e.arc.as_ref().is_some_and(|link| {
                    link.name == name && (link.created.is_none() || link.created == created)
                })
            });
            (!carried).then(|| UnattachedArc {
                arc: name,
                created,
                project_dir: project_dir.to_owned(),
            })
        })
        .collect()
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
    /// The linked arc's generation was discarded, or the entry was dropped
    /// by hand and no arc carries it.
    Dropped,
    /// None of those, and some wait is not joined.
    Waiting,
    /// None of those, and every wait is joined.
    Ready,
}

impl EntryState {
    /// The state's wire spelling, the same word its serde form writes.
    pub fn as_str(self) -> &'static str {
        match self {
            EntryState::Joined => "joined",
            EntryState::Running => "running",
            EntryState::Dropped => "dropped",
            EntryState::Waiting => "waiting",
            EntryState::Ready => "ready",
        }
    }

    /// Whether the entry is finished with: landed, or given up. A cycle
    /// closes when every entry is.
    pub fn is_settled(self) -> bool {
        matches!(self, EntryState::Joined | EntryState::Dropped)
    }
}

/// What the arc log says about one linked arc generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStatus {
    /// The generation is open.
    Open,
    /// The generation ended in a join that still stands.
    Joined,
    /// The generation ended in a discard that still stands. The link is
    /// kept, so the history is not lost, and its entry reads as dropped.
    Discarded,
    /// The log never recorded the generation, so its entry reads as not
    /// started.
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
                LinkStatus::Discarded
            } else {
                LinkStatus::Joined
            });
        } else if marker == "undone" {
            let reverses = match *ending {
                Some(LinkStatus::Joined) => note.starts_with("reversed join"),
                Some(LinkStatus::Discarded) => note.starts_with("reversed discard"),
                _ => false,
            };
            if reverses {
                *ending = None;
            }
        } else if marker == "redone" && ending.is_none() {
            if note.starts_with("re-applied join") {
                *ending = Some(LinkStatus::Joined);
            } else if note.starts_with("re-applied discard") {
                *ending = Some(LinkStatus::Discarded);
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
/// joined is joined, one whose arc is open is running, one whose arc was
/// discarded or that was dropped by hand is dropped, and any other is
/// waiting while some entry it waits on is not joined and ready once all
/// are. A dropped entry satisfies no wait.
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
                LinkStatus::Discarded => EntryState::Dropped,
                LinkStatus::NotStarted if e.dropped.is_some() => EntryState::Dropped,
                LinkStatus::NotStarted if e.waits.iter().all(|w| joined.contains(w)) => {
                    EntryState::Ready
                }
                LinkStatus::NotStarted => EntryState::Waiting,
            };
            (e.n, state)
        })
        .collect()
}

/// The letters of the sketches still pending on `record`: no entry came from
/// one, and it has not been dropped.
pub fn pending_sketches(record: &CycleRecord) -> Vec<String> {
    record
        .sketches
        .iter()
        .filter(|s| s.dropped.is_none())
        .filter(|s| !record.entries.iter().any(|e| e.from.contains(&s.letter)))
        .map(|s| s.letter.clone())
        .collect()
}

/// Whether a cycle whose entries read `states` is closed: it has at least
/// one entry, every entry is settled ([`EntryState::is_settled`]), and no
/// sketch is pending ([`pending_sketches`]).
///
/// Derived on every read, beside [`entry_states`], and never stored, so a
/// cycle cannot disagree with its arcs: adding an entry, relinking a dropped
/// one or undoing a join makes it false again with no reopening gesture. The
/// rule counts entries, never arcs, so a cycle with one entry landed and the
/// next not started stays open; and a cycle with no entries yet is open, or
/// it would close between its creation and its first entry.
pub fn cycle_closed(record: &CycleRecord, states: &[(u32, EntryState)]) -> bool {
    !states.is_empty()
        && states.iter().all(|(_, state)| state.is_settled())
        && pending_sketches(record).is_empty()
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
    /// How many listed entries have joined: the run's progress, which an
    /// entry nobody listed does not count toward.
    pub run_landed: usize,
    /// How many listed entries there are that were not dropped.
    pub run_total: usize,
    /// Whether the cycle's work is finished ([`cycle_closed`]).
    pub closed: bool,
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
    let closed = cycle_closed(record, &states);
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
        run_landed: entries
            .iter()
            .filter(|e| e.entry.listed && e.state == EntryState::Joined)
            .count(),
        run_total: entries
            .iter()
            .filter(|e| e.entry.listed && e.state != EntryState::Dropped)
            .count(),
        closed,
        entries,
        sketches: record.sketches.clone(),
    }
}

/// The file a writer locks for the length of one read, change and write.
const CYCLE_LOCK: &str = "cycle.json.lock";

/// Hold cycle `id` against every other writer until the returned file drops.
///
/// Each verb that changes a record reads it, changes it and writes it whole,
/// and the write replaces the file, so two writers that both read before
/// either wrote would leave only the second one's change. The `/arc` door in
/// two sessions can do that, and so can anything else that keeps a cycle. The
/// lock is on a sibling file, never on `cycle.json` itself, because the write
/// renames a new file into place and a lock on the old one would guard
/// nothing. A cycle that is not here is not locked; `load` refuses it next.
pub(crate) fn hold_cycle(
    paths: &Paths,
    repo: &Path,
    id: &str,
) -> Result<Option<crate::record_lock::Held>, ArcError> {
    let dir = cycle_root(paths, repo).join(id);
    if !valid_id(id) || !dir.is_dir() {
        return Ok(None);
    }
    crate::record_lock::hold(&dir, CYCLE_LOCK, crate::record_lock::LockMode::Wait)
}

/// This checkout's cycle `id`; refused when it is not here.
///
/// The caller holds the cycle's lock, so a record that predates the brief
/// record is brought forward and written here.
pub(crate) fn load(paths: &Paths, repo: &Path, id: &str) -> Result<CycleRecord, ArcError> {
    if !valid_id(id) {
        return Err(ArcError::Refused(format!(
            "{id} is not a cycle id: eight lowercase hex characters"
        )));
    }
    let mut record = read_record(&cycle_root(paths, repo).join(id))
        .ok_or_else(|| ArcError::Refused(format!("this checkout has no cycle {id}")))?;
    if needs_bring_forward(&record) && bring_forward(paths, &mut record) {
        write_record(&record)?;
    }
    Ok(record)
}

/// Whether `record` names a brief by path alone, as records written before
/// the brief record did.
fn needs_bring_forward(record: &CycleRecord) -> bool {
    record
        .entries
        .iter()
        .any(|e| e.brief_id.is_empty() && !e.brief.trim().is_empty())
        || record
            .sketches
            .iter()
            .any(|s| s.brief.is_some() && s.brief_id.is_none())
}

/// Give every entry and sketch that names a brief by path alone the brief's
/// record ([`crate::brief::ensure`], which never touches the brief), and the
/// record's current path. Returns whether anything changed.
fn bring_forward(paths: &Paths, record: &mut CycleRecord) -> bool {
    let repo = PathBuf::from(&record.project_dir);
    let mut changed = false;
    for e in &mut record.entries {
        if !e.brief_id.is_empty() || e.brief.trim().is_empty() {
            continue;
        }
        match crate::brief::ensure(paths, &repo, &e.brief, &By::none()) {
            Ok(found) => {
                e.brief = found.path;
                e.brief_id = found.id;
                changed = true;
            }
            Err(err) => eprintln!("could not record the brief of entry {}: {err}", e.n),
        }
    }
    for s in &mut record.sketches {
        let (Some(brief), None) = (&s.brief, &s.brief_id) else {
            continue;
        };
        match crate::brief::ensure(paths, &repo, brief, &By::none()) {
            Ok(found) => {
                s.brief = Some(found.path);
                s.brief_id = Some(found.id);
                changed = true;
            }
            Err(err) => eprintln!("could not record the brief of sketch {}: {err}", s.letter),
        }
    }
    changed
}

/// The record in `dir`, brought forward for a reader that holds no lock.
///
/// The record's own lock is only tried, never waited on: a reader may hold
/// another cycle's lock already, and waiting here could leave two processes
/// each waiting on the other. When the lock is free the record is read again
/// under it, brought forward and written; when it is not, the record is
/// brought forward in memory and the write is left to its writer.
fn read_current(paths: &Paths, dir: &Path) -> Option<CycleRecord> {
    let mut record = read_record(dir)?;
    if !needs_bring_forward(&record) {
        return Some(record);
    }
    if let Ok(Some(_held)) = hold(dir, CYCLE_LOCK, LockMode::Try) {
        let mut fresh = read_record(dir)?;
        if bring_forward(paths, &mut fresh) {
            if let Err(e) = write_record(&fresh) {
                eprintln!("could not write cycle {} brought forward: {e}", fresh.id);
            }
        }
        return Some(fresh);
    }
    bring_forward(paths, &mut record);
    Some(record)
}

/// Append a work-log line, saying so on stderr rather than failing when it
/// cannot: the record is the decision, the line is evidence.
pub(crate) fn log_work(
    paths: &Paths,
    repo: &Path,
    kind: WorkKind,
    object: WorkObject,
    detail: serde_json::Value,
    by: &By,
) {
    if let Err(e) = work_log::append(paths, repo, kind, object, detail, by) {
        eprintln!("could not append {} to the work log: {e}", kind.as_str());
    }
}

pub(crate) fn save(record: &mut CycleRecord) -> Result<(), ArcError> {
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
            from: vec!["A".into()],
            ..NewEntry::default()
        }
    }

    fn record_sketch(paths: &Paths, repo: &Path, arc: &str) -> String {
        let dir = documents_dir(repo, arc);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sketch.md"), format!("# Sketch\n\n{arc}\n")).unwrap();
        crate::sketch::record_arc_sketch(
            paths,
            repo,
            arc,
            &crate::work_log::By::none(),
            crate::sketch::Written::AtTheTime,
        )
            .unwrap()
            .id
    }

    /// A cycle named `name` with one sketch, A, for its entries to come from.
    fn sketched(paths: &Paths, repo: &Path, name: &str) -> String {
        let id = create_cycle(paths, repo, name, None).unwrap().id;
        let sketch = record_sketch(paths, repo, &format!("sketch-{id}"));
        assert_eq!(add_sketch(paths, repo, &id, &sketch, None).unwrap(), "A");
        id
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
        let id = sketched(&paths, &repo, "C");
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
            (
                NewEntry {
                    brief: "briefs/c.md".into(),
                    ..NewEntry::default()
                },
                "no sketch",
            ),
            (
                NewEntry {
                    brief: "briefs/c.md".into(),
                    from: vec!["  ".into()],
                    ..NewEntry::default()
                },
                "a blank letter is no sketch",
            ),
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
            waits: waits.to_vec(),
            ..CycleEntry::default()
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

        assert_eq!(add_sketch(&paths, &repo, &id, &s1, None).unwrap(), "A");
        assert_eq!(add_sketch(&paths, &repo, &id, &s2, None).unwrap(), "B");
        assert_eq!(
            add_sketch(&paths, &repo, &id, &s1, None).unwrap(),
            "A",
            "kept letter"
        );
        assert!(matches!(
            add_sketch(&paths, &repo, &id, "00000000", None),
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
        let id = sketched(&paths, &repo, "C");
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
    fn writers_at_once_each_keep_their_change() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
        std::thread::scope(|scope| {
            for i in 0..8 {
                let (paths, repo, id) = (&paths, &repo, &id);
                scope.spawn(move || {
                    add_entry(paths, repo, id, entry(&format!("briefs/{i}.md"), &[])).unwrap();
                });
            }
        });
        let record = cycles(&paths, &repo).remove(0);
        let mut numbers: Vec<u32> = record.entries.iter().map(|e| e.n).collect();
        numbers.sort_unstable();
        assert_eq!(
            numbers,
            (1..=8).collect::<Vec<u32>>(),
            "no writer's entry was lost"
        );
    }

    #[test]
    fn a_brief_run_again_is_a_new_entry_and_never_takes_a_landed_one() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  first  arc-start  brief.md",
        );
        let first = attach(&paths, &repo, &id, 1, "first").unwrap();
        assert_eq!(
            find_by_brief(&paths, &repo, "briefs/a.md"),
            Some(BriefFound {
                id: id.clone(),
                n: None,
                letter: None,
                from: vec!["A".into()],
            }),
            "an entry an open arc carries is not offered to another"
        );

        // The first arc lands, and the same brief is run as a second arc.
        log_append(
            &paths,
            &repo,
            "2026-11-01T01:00:00Z  first  abc1234  joined",
        );
        log_append(
            &paths,
            &repo,
            "2026-11-01T02:00:00Z  second  arc-start  brief.md",
        );
        let refused = attach(&paths, &repo, &id, 1, "second").unwrap_err();
        assert!(
            refused.to_string().contains("landed with arc first"),
            "{refused}"
        );
        let found = find_by_brief(&paths, &repo, "briefs/a.md").unwrap();
        assert_eq!((found.n, found.from.clone()), (None, vec!["A".to_string()]));
        let n = add_entry(
            &paths,
            &repo,
            &id,
            NewEntry {
                brief: "briefs/a.md".into(),
                from: found.from,
                ..NewEntry::default()
            },
        )
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            find_by_brief(&paths, &repo, "briefs/a.md"),
            Some(at_entry(&id, 2)),
            "the entry with no arc answers before the landed one"
        );
        let second = attach(&paths, &repo, &id, 2, "second").unwrap();

        // One arc, one entry: the second arc cannot be put on a third entry.
        add_entry(&paths, &repo, &id, entry("briefs/b.md", &[])).unwrap();
        let twice = attach(&paths, &repo, &id, 3, "second").unwrap_err();
        assert!(
            twice.to_string().contains("already carried by entry 2"),
            "{twice}"
        );
        let record = &find_cycle(&paths, &id)[0].1;
        assert_eq!(record.entry(1).unwrap().arc.as_ref(), Some(&first));
        assert_eq!(record.entry(2).unwrap().arc.as_ref(), Some(&second));
        assert_eq!(record.entry(3).unwrap().arc, None);
        assert_eq!(check_cycles(&paths), Vec::new());
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
        let first = sketched(&paths, &repo, "first");
        add_entry(&paths, &repo, &first, entry("briefs/a.md", &[])).unwrap();
        add_entry(&paths, &repo, &first, entry("briefs/b.md", &[])).unwrap();
        assert_eq!(
            find_by_brief(&paths, &repo, "briefs/b.md"),
            Some(at_entry(&first, 2))
        );
        assert_eq!(
            find_by_brief(&paths, &repo, " ./briefs/a.md "),
            Some(at_entry(&first, 1)),
            "one spelling of the path"
        );
        assert_eq!(find_by_brief(&paths, &repo, "briefs/none.md"), None);
        assert_eq!(find_by_brief(&paths, &repo, ""), None);

        let mut older = find_cycle(&paths, &first).remove(0).1;
        older.updated = "2000-01-01T00:00:00Z".into();
        write_record(&older).unwrap();
        let second = sketched(&paths, &repo, "second");
        add_entry(&paths, &repo, &second, entry("briefs/a.md", &[])).unwrap();
        assert_eq!(
            find_by_brief(&paths, &repo, "briefs/a.md"),
            Some(at_entry(&second, 1)),
            "the most recently changed cycle answers"
        );

        let other = temp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(
            find_by_brief(&paths, &other, "briefs/a.md"),
            None,
            "another checkout's entries are not found here"
        );
    }

    fn at_entry(id: &str, n: u32) -> BriefFound {
        BriefFound {
            id: id.into(),
            n: Some(n),
            letter: None,
            from: Vec::new(),
        }
    }

    #[test]
    fn a_sketch_carries_the_brief_that_wrote_it_up_and_find_reaches_it() {
        let (_t, repo, paths) = scratch();
        let id = create_cycle(&paths, &repo, "C", None).unwrap().id;
        let s1 = record_sketch(&paths, &repo, "one");
        let s2 = record_sketch(&paths, &repo, "two");
        assert_eq!(
            add_sketch(&paths, &repo, &id, &s1, Some("./briefs/index.md")).unwrap(),
            "A"
        );
        assert_eq!(add_sketch(&paths, &repo, &id, &s2, None).unwrap(), "B");
        let record = &find_cycle(&paths, &id)[0].1;
        assert_eq!(record.sketches[0].brief.as_deref(), Some("briefs/index.md"));
        assert_eq!(record.sketches[1].brief, None);

        // A sketch already on the cycle takes a brief it lacks, keeps the one
        // it has, and refuses to trade it for another.
        assert_eq!(
            add_sketch(&paths, &repo, &id, &s2, Some("briefs/later.md")).unwrap(),
            "B"
        );
        assert_eq!(
            add_sketch(&paths, &repo, &id, &s1, Some("briefs/index.md")).unwrap(),
            "A"
        );
        assert!(add_sketch(&paths, &repo, &id, &s1, Some("briefs/other.md")).is_err());
        assert!(add_sketch(&paths, &repo, &id, &s1, Some("/abs/brief.md")).is_err());
        let record = &find_cycle(&paths, &id)[0].1;
        assert_eq!(record.sketches[0].brief.as_deref(), Some("briefs/index.md"));
        assert_eq!(record.sketches[1].brief.as_deref(), Some("briefs/later.md"));

        assert_eq!(
            find_by_brief(&paths, &repo, "briefs/index.md"),
            Some(BriefFound {
                id: id.clone(),
                n: None,
                letter: Some("A".into()),
                from: Vec::new(),
            }),
            "found through the sketch it wrote up"
        );

        // An entry holding the same brief answers before the sketch does.
        add_entry(&paths, &repo, &id, entry("briefs/later.md", &[])).unwrap();
        assert_eq!(
            find_by_brief(&paths, &repo, "briefs/later.md"),
            Some(at_entry(&id, 1))
        );
    }

    #[test]
    fn add_from_only_adds_letters_an_entry_came_from() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
        let s2 = record_sketch(&paths, &repo, "two");
        assert_eq!(add_sketch(&paths, &repo, &id, &s2, None).unwrap(), "B");
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();

        assert_eq!(
            add_from(&paths, &repo, &id, 1, vec!["b".into(), "A".into()]).unwrap(),
            vec!["A", "B"],
            "a letter already named keeps its place"
        );
        assert_eq!(
            add_from(&paths, &repo, &id, 1, vec!["B".into()]).unwrap(),
            vec!["A", "B"]
        );
        for (letters, n, why) in [
            (vec!["C".to_string()], 1, "no sketch C"),
            (vec![" ".to_string()], 1, "no letter"),
            (Vec::new(), 1, "nothing named"),
            (vec!["A".to_string()], 9, "no entry 9"),
        ] {
            assert!(add_from(&paths, &repo, &id, n, letters).is_err(), "{why}");
        }
        let record = &find_cycle(&paths, &id)[0].1;
        assert_eq!(record.entry(1).unwrap().from, vec!["A", "B"]);
        assert_eq!(record.entries.len(), 1, "nothing is renumbered or added");
    }

    #[test]
    fn check_lists_every_cycle_on_the_machine_that_breaks_the_chain() {
        let (temp, repo, paths) = scratch();
        let whole = sketched(&paths, &repo, "Whole");
        add_entry(&paths, &repo, &whole, entry("briefs/a.md", &[])).unwrap();
        assert_eq!(check_cycles(&paths), Vec::new(), "a whole record is clean");

        // An entry written before every entry had to name a sketch, in
        // another checkout: the check reads the whole machine.
        let other = temp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let old = create_cycle(&paths, &other, "Old", None).unwrap();
        let mut written = old.clone();
        written.entries.push(linked(1, &[], None));
        written.entries.push(CycleEntry {
            from: vec!["Q".into()],
            ..linked(2, &[], None)
        });
        write_record(&written).unwrap();

        // Two entries carrying one arc generation, on two cycles.
        log_append(
            &paths,
            &repo,
            "2026-11-01T00:00:00Z  aa  arc-start  brief.md",
        );
        attach(&paths, &repo, &whole, 1, "aa").unwrap();
        let twin = sketched(&paths, &repo, "Twin");
        add_entry(&paths, &repo, &twin, entry("briefs/b.md", &[])).unwrap();
        let mut doubled = find_cycle(&paths, &twin).remove(0).1;
        doubled.entries[0].arc = find_cycle(&paths, &whole)[0].1.entries[0].arc.clone();
        write_record(&doubled).unwrap();

        let breaks = check_cycles(&paths);
        let by_id = |id: &str| {
            breaks
                .iter()
                .find(|b| b.id == id)
                .map(|b| b.problems.clone())
        };
        assert_eq!(
            by_id(&old.id).unwrap(),
            vec![
                "entry 1 names no sketch".to_string(),
                "entry 2 names sketch Q, which the cycle does not have".to_string(),
            ]
        );
        for id in [&whole, &twin] {
            let problems = by_id(id).unwrap();
            assert_eq!(problems.len(), 1, "{problems:?}");
            assert!(problems[0].starts_with("arc aa is carried by more than one entry"));
        }
        assert_eq!(breaks.len(), 3);

        // The repair verb mends the old record, and only what it was told.
        let s = record_sketch(&paths, &other, "old-sketch");
        assert_eq!(add_sketch(&paths, &other, &old.id, &s, None).unwrap(), "A");
        add_from(&paths, &other, &old.id, 1, vec!["A".into()]).unwrap();
        assert_eq!(
            by_id(&old.id).map(|p| p.len()),
            Some(2),
            "the earlier reading is unchanged"
        );
        let after = check_cycles(&paths);
        let old_after = after.iter().find(|b| b.id == old.id).unwrap();
        assert_eq!(
            old_after.problems,
            vec!["entry 2 names sketch Q, which the cycle does not have".to_string()]
        );
    }

    #[test]
    fn chain_breaks_reads_one_record_alone() {
        let mut record = of(vec![linked(1, &[], None)]);
        assert_eq!(chain_breaks(&record), vec!["entry 1 names no sketch"]);
        record.sketches.push(CycleSketch {
            letter: "A".into(),
            id: "0000aaaa".into(),
            brief: None,
            brief_id: None,
            added: String::new(),
            dropped: None,
        });
        record.entries[0].from = vec!["A".into()];
        assert!(chain_breaks(&record).is_empty());
        record.entries[0].brief = " ".into();
        assert_eq!(chain_breaks(&record), vec!["entry 1 has no brief"]);
    }

    #[test]
    fn check_lists_a_live_arc_no_entry_carries_and_only_that() {
        let (_t, repo, paths) = scratch();
        assert!(
            unattached_arcs(&paths).is_empty(),
            "no cycles, nothing read"
        );
        let id = sketched(&paths, &repo, "Gap");
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();
        // The fixture's sketch was recorded by an arc of its own; end it, so
        // the log's arcs are the ones below.
        let sketch_arc = format!("2026-11-01T00:00:00Z  sketch-{id}  discarded  by hand");
        log_append(&paths, &repo, &sketch_arc);
        for line in [
            "2026-11-01T00:00:00Z  attached  arc-start  briefs/a.md",
            "2026-11-01T00:01:00Z  loose  arc-start  briefs/b.md",
            "2026-11-01T00:02:00Z  landed  arc-start  briefs/c.md",
            "2026-11-01T00:03:00Z  landed  abc1234  joined",
        ] {
            log_append(&paths, &repo, line);
        }
        attach(&paths, &repo, &id, 1, "attached").unwrap();

        let found = unattached_arcs(&paths);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].arc, "loose");
        assert_eq!(found[0].created.as_deref(), Some("2026-11-01T00:01:00Z"));
        let record = find_cycle(&paths, &id).remove(0).1;
        assert_eq!(found[0].project_dir, record.project_dir);

        // A reused name whose open generation is not the one an entry links
        // is on no cycle, though an older generation of it was.
        log_append(
            &paths,
            &repo,
            "2026-11-02T00:00:00Z  attached  discarded  by hand",
        );
        log_append(
            &paths,
            &repo,
            "2026-11-02T00:01:00Z  attached  arc-start  briefs/a.md",
        );
        let names: Vec<String> = unattached_arcs(&paths).into_iter().map(|u| u.arc).collect();
        assert_eq!(names, vec!["attached", "loose"]);
    }

    #[test]
    fn find_by_sketch_reads_the_record_not_the_session() {
        let (_t, repo, paths) = scratch();
        let one = create_cycle(&paths, &repo, "one", Some("sess-1")).unwrap();
        create_cycle(&paths, &repo, "two", Some("sess-2")).unwrap();
        let a = record_sketch(&paths, &repo, "first");
        let b = record_sketch(&paths, &repo, "second");
        add_sketch(&paths, &repo, &one.id, &a, None).unwrap();
        add_sketch(&paths, &repo, &one.id, &b, None).unwrap();
        let found = find_by_sketch(&paths, &repo, &b).unwrap();
        assert_eq!(found.id, one.id);
        assert_eq!(found.letter.as_deref(), Some("B"));
        assert_eq!(found.n, None);
        assert!(find_by_sketch(&paths, &repo, "0000cccc").is_none());
        assert!(find_by_sketch(&paths, &repo, " ").is_none());
    }

    fn linked(n: u32, waits: &[u32], arc: Option<(&str, &str)>) -> CycleEntry {
        CycleEntry {
            n,
            brief: format!("briefs/{n}.md"),
            brief_id: format!("0000{n:04x}"),
            arc: arc.map(|(name, created)| CycleArc {
                name: name.into(),
                created: Some(created.into()),
            }),
            waits: waits.to_vec(),
            ..CycleEntry::default()
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
            next_n: 0,
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
                (3, EntryState::Dropped),
                (4, EntryState::Ready),
                (5, EntryState::Waiting),
                (6, EntryState::Ready),
            ],
            "a discarded arc reads as dropped, a never-logged one as not started"
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
        assert_eq!(link_status(log, &old), LinkStatus::Discarded);
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
        assert_eq!(link_status(&rediscarded, &link), LinkStatus::Discarded);

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

    fn sketch(letter: &str, dropped: bool) -> CycleSketch {
        CycleSketch {
            letter: letter.into(),
            id: "0000aaaa".into(),
            brief: None,
            brief_id: None,
            added: String::new(),
            dropped: dropped.then(|| T0.to_string()),
        }
    }

    #[test]
    fn a_cycle_closes_when_every_entry_is_settled_and_reopens_with_work() {
        let closed = |log: &str, record: &CycleRecord| view_cycle_in(log, record).closed;
        let start = "2026-11-01T00:00:00Z  a  arc-start  brief.md\n";
        let joined = format!("{start}2026-11-01T01:00:00Z  a  302d43b5d1  joined\n");
        let undone =
            format!("{joined}2026-11-01T02:00:00Z  a  undone  reversed join (operation 4)\n");
        let redone =
            format!("{undone}2026-11-01T03:00:00Z  a  redone  re-applied join (operation 4)\n");

        // No entries yet: open, or it would close before its first entry.
        assert!(!closed(&joined, &of(Vec::new())));

        // A cycle of one follows its arc: open while it runs, closed when it
        // joins, open again when the join is undone.
        let one = of(vec![linked(1, &[], Some(("a", T0)))]);
        assert!(!closed(start, &one));
        assert!(closed(&joined, &one));
        assert!(!closed(&undone, &one));
        assert!(closed(&redone, &one));

        // The rule counts entries, not arcs: one landed and the next not
        // started has no open arc and stays open.
        let mut two = of(vec![linked(1, &[], Some(("a", T0))), linked(2, &[1], None)]);
        assert!(!closed(&joined, &two));
        // Dropped by hand, the second is settled, and is not landed.
        two.entries[1].dropped = Some(T0.into());
        let view = view_cycle_in(&joined, &two);
        assert_eq!(view.entries[1].state, EntryState::Dropped);
        assert!(view.closed);
        assert_eq!(view.landed, 1);
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["closed"], true);
        assert_eq!(json["entries"][1]["state"], "dropped");
        assert!(json["entries"][0].get("dropped").is_none());

        // A discarded arc settles its entry, and undoing the discard runs it.
        let discarded = format!("{start}2026-11-01T01:00:00Z  a  discarded\n");
        assert_eq!(
            entry_states(&discarded, &one),
            vec![(1, EntryState::Dropped)]
        );
        assert!(closed(&discarded, &one));
        let revived =
            format!("{discarded}2026-11-01T02:00:00Z  a  undone  reversed discard (operation 5)\n");
        assert_eq!(entry_states(&revived, &one), vec![(1, EntryState::Running)]);
        assert!(!closed(&revived, &one));

        // A wait on a dropped entry is not satisfied, so the waiter holds the
        // cycle open until it is settled too.
        let waiting = of(vec![linked(1, &[], Some(("a", T0))), linked(2, &[1], None)]);
        assert_eq!(
            entry_states(&discarded, &waiting),
            vec![(1, EntryState::Dropped), (2, EntryState::Waiting)]
        );
        assert!(!closed(&discarded, &waiting));

        // An open arc outranks a mark left on its entry.
        let mut marked = one.clone();
        marked.entries[0].dropped = Some(T0.into());
        assert_eq!(entry_states(start, &marked), vec![(1, EntryState::Running)]);
    }

    #[test]
    fn a_pending_sketch_holds_a_cycle_open() {
        let joined = "\
2026-11-01T00:00:00Z  a  arc-start  brief.md
2026-11-01T01:00:00Z  a  302d43b5d1  joined
";
        let mut record = of(vec![linked(1, &[], Some(("a", T0)))]);
        record.sketches = vec![sketch("A", false)];
        assert_eq!(pending_sketches(&record), vec!["A"]);
        assert!(
            !view_cycle_in(joined, &record).closed,
            "nothing came from A"
        );

        record.entries[0].from = vec!["A".into()];
        assert!(pending_sketches(&record).is_empty());
        assert!(view_cycle_in(joined, &record).closed);

        record.sketches.push(sketch("B", false));
        assert!(!view_cycle_in(joined, &record).closed);
        record.sketches[1] = sketch("B", true);
        assert!(
            view_cycle_in(joined, &record).closed,
            "a dropped sketch is not pending"
        );
    }

    #[test]
    fn drop_marks_what_will_never_run_and_running_it_after_all_clears_the_mark() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
        let b = record_sketch(&paths, &repo, "second");
        assert_eq!(add_sketch(&paths, &repo, &id, &b, None).unwrap(), "B");
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();
        add_entry(&paths, &repo, &id, entry("briefs/b.md", &[])).unwrap();
        let view = || view_cycle(&paths, &find_cycle(&paths, &id).remove(0).1);
        let refused = |item: &str| {
            let err = drop_item(&paths, &repo, &id, item).unwrap_err();
            assert!(matches!(err, ArcError::Refused(_)), "{item}: {err:?}");
            err.to_string()
        };
        let log = |line: &str| log_append(&paths, &repo, line);

        // A running arc is discarded, not dropped; a joined one is settled.
        log("2026-11-01T00:00:00Z  aa  arc-start  brief.md");
        attach(&paths, &repo, &id, 1, "aa").unwrap();
        assert!(refused("1").contains("still open"));
        log("2026-11-01T01:00:00Z  aa  302d43b5d1  joined");
        assert!(refused("1").contains("landed"));
        refused("9");
        refused("Z");
        assert!(refused("a").contains("entry 1"), "A has entries to drop");

        // Entry 2 is dropped where it stands; sketch B still holds the cycle.
        assert_eq!(
            drop_item(&paths, &repo, &id, " 2 ").unwrap(),
            DroppedItem::Entry(2)
        );
        let v = view();
        assert_eq!(v.entries.len(), 2, "nothing is removed or renumbered");
        assert_eq!(v.entries[1].state, EntryState::Dropped);
        assert!(!v.closed);
        assert_eq!(
            drop_item(&paths, &repo, &id, "b").unwrap(),
            DroppedItem::Sketch("B".into())
        );
        let v = view();
        assert!(v.sketches[1].dropped.is_some());
        assert!(v.closed);

        // Dropping the dropped writes nothing.
        let before = find_cycle(&paths, &id).remove(0).1;
        drop_item(&paths, &repo, &id, "2").unwrap();
        drop_item(&paths, &repo, &id, "B").unwrap();
        assert_eq!(find_cycle(&paths, &id).remove(0).1, before);

        // Run after all, the entry is carried like any other.
        log("2026-11-02T00:00:00Z  bb  arc-start  brief.md");
        attach(&paths, &repo, &id, 2, "bb").unwrap();
        let v = view();
        assert_eq!(v.entries[1].entry.dropped, None);
        assert_eq!(v.entries[1].state, EntryState::Running);
        assert!(!v.closed);

        // Its arc discarded, it is settled again; a new arc on the same
        // brief relinks it and reopens the cycle.
        log("2026-11-02T01:00:00Z  bb  discarded");
        let v = view();
        assert_eq!(v.entries[1].state, EntryState::Dropped);
        assert!(v.closed);
        drop_item(&paths, &repo, &id, "2").unwrap();
        log("2026-11-03T00:00:00Z  bb  arc-start  brief.md");
        attach(&paths, &repo, &id, 2, "bb").unwrap();
        let v = view();
        assert_eq!(v.entries[1].entry.dropped, None);
        assert_eq!(v.entries[1].state, EntryState::Running);
        assert!(!v.closed);
        log("2026-11-03T01:00:00Z  bb  9ac1e0f2aa  joined");
        assert!(view().closed);

        // An entry written from the dropped sketch reopens the cycle, and
        // the sketch is no longer one nothing came from.
        let mut from_b = entry("briefs/c.md", &[]);
        from_b.from = vec!["B".into()];
        assert_eq!(add_entry(&paths, &repo, &id, from_b).unwrap(), 3);
        let v = view();
        assert_eq!(v.sketches[1].dropped, None);
        assert_eq!(v.entries[2].state, EntryState::Ready);
        assert!(!v.closed);
    }

    #[test]
    fn view_reads_the_cycles_own_log_and_its_arcs_stages() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
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
        let first = sketched(&paths, &repo, "First");
        let second = sketched(&paths, &repo, "Second");
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

    /// A cycle record in the shape written before entries carried a brief
    /// record: briefs by path alone, no listed mark.
    fn old_cycle(paths: &Paths, repo: &Path, id: &str, sketch: &str) -> PathBuf {
        let dir = cycle_root(paths, repo).join(id);
        fs::create_dir_all(&dir).unwrap();
        let json = format!(
            r#"{{
  "id": "{id}",
  "name": "Old",
  "created": "2026-11-01T00:00:00Z",
  "updated": "2026-11-01T00:00:00Z",
  "project_dir": "{}",
  "entries": [
    {{ "n": 1, "brief": "briefs/a.md", "waits": [], "from": ["A"], "added": "2026-11-01T00:00:00Z",
       "arc": {{ "name": "aa", "created": "2026-11-01T00:00:00Z" }} }},
    {{ "n": 2, "brief": "briefs/b.md", "waits": [1], "from": ["A"], "added": "2026-11-01T00:00:00Z" }}
  ],
  "sketches": [
    {{ "letter": "A", "id": "{sketch}", "brief": "briefs/up.md", "added": "2026-11-01T00:00:00Z" }}
  ]
}}
"#,
            repo.display()
        );
        fs::write(dir.join(CYCLE_JSON), json).unwrap();
        dir
    }

    fn work_kinds(paths: &Paths, repo: &Path) -> Vec<WorkKind> {
        work_log::read_lines(
            &fs::read_to_string(work_log::work_log_path(paths, repo)).unwrap_or_default(),
        )
        .into_iter()
        .map(|l| l.kind)
        .collect()
    }

    #[test]
    fn an_old_record_is_brought_forward_once_and_reads_the_same() {
        let (_t, repo, paths) = scratch();
        fs::create_dir_all(repo.join("briefs")).unwrap();
        fs::write(repo.join("briefs/a.md"), "# A\n").unwrap();
        let sketch = record_sketch(&paths, &repo, "old-sketch");
        log_append(&paths, &repo, "2026-11-01T00:00:00Z  aa  arc-start  briefs/a.md");
        let dir = old_cycle(&paths, &repo, "0ddc0de1", &sketch);
        let before = fs::read_to_string(dir.join(CYCLE_JSON)).unwrap();
        let log = fs::read_to_string(tugtool_core::paths::arc_log_path_at(&paths, &repo)).unwrap();
        let old: CycleRecord = serde_json::from_str(&before).unwrap();
        let old_states = entry_states(&log, &old);

        let record = cycles(&paths, &repo).remove(0);
        assert!(record.entries.iter().all(|e| !e.brief_id.is_empty() && e.listed));
        assert!(record.sketches[0].brief_id.is_some());
        assert_eq!(entry_states(&log, &record), old_states);
        let after = fs::read_to_string(dir.join(CYCLE_JSON)).unwrap();
        assert_ne!(after, before, "the record is written brought forward");
        assert!(after.contains("\"brief_id\""));
        assert_eq!(fs::read_to_string(repo.join("briefs/a.md")).unwrap(), "# A\n");

        let minted = crate::brief::briefs(&paths, &repo).len();
        assert_eq!(minted, 3, "one record for each brief named");
        let again = cycles(&paths, &repo).remove(0);
        assert_eq!(again.entries, record.entries);
        assert_eq!(crate::brief::briefs(&paths, &repo).len(), minted, "a second read mints nothing");
    }

    #[test]
    fn a_record_another_holds_is_brought_forward_in_memory_only() {
        let (_t, repo, paths) = scratch();
        let sketch = record_sketch(&paths, &repo, "held-sketch");
        let dir = old_cycle(&paths, &repo, "0ddc0de2", &sketch);
        let before = fs::read_to_string(dir.join(CYCLE_JSON)).unwrap();
        let held = hold(&dir, CYCLE_LOCK, LockMode::Wait).unwrap();
        let record = std::thread::scope(|scope| {
            scope
                .spawn(|| cycles(&paths, &repo).remove(0))
                .join()
                .unwrap()
        });
        assert!(record.entries.iter().all(|e| !e.brief_id.is_empty()));
        assert_eq!(fs::read_to_string(dir.join(CYCLE_JSON)).unwrap(), before);
        drop(held);
    }

    #[test]
    fn queue_names_an_arc_once_and_after_becomes_a_wait() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();
        let by = By {
            session: Some("sess-q".into()),
            turn: Some(4),
            privacy: Privacy::Public,
            segments: Vec::new(),
        };
        let first = queue_arc(
            &paths,
            &repo,
            QueueArc {
                arc: "first-arc",
                brief: "briefs/a.md",
                cycle: None,
                label: Some("The first"),
                waits: Vec::new(),
                after: None,
                from: Vec::new(),
                by: &by,
            },
        )
        .unwrap();
        assert_eq!((first.n, first.outcome), (Some(1), Outcome::Named), "the free entry is named");

        let second = queue_arc(
            &paths,
            &repo,
            QueueArc {
                arc: "second-arc",
                brief: "briefs/a.md",
                cycle: Some(&id),
                label: None,
                waits: Vec::new(),
                after: Some("first-arc"),
                from: Vec::new(),
                by: &by,
            },
        )
        .unwrap();
        assert_eq!((second.n, second.outcome), (Some(2), Outcome::Added));
        let record = cycles(&paths, &repo).remove(0);
        let e = record.entry(2).unwrap();
        assert_eq!(e.arc_name.as_deref(), Some("second-arc"));
        assert!(e.listed);
        assert_eq!(e.waits, [1]);
        assert_eq!(e.from, ["A"]);
        assert_eq!(
            e.stated_by,
            Some(StatedBy {
                session: "sess-q".into(),
                turn: Some(4),
                added: true,
            })
        );
        assert_eq!(record.entry(1).unwrap().label.as_deref(), Some("The first"));

        let again = queue_arc(
            &paths,
            &repo,
            QueueArc {
                arc: "second-arc",
                brief: "briefs/a.md",
                cycle: None,
                label: None,
                waits: Vec::new(),
                after: None,
                from: Vec::new(),
                by: &by,
            },
        );
        assert!(matches!(again, Err(ArcError::Refused(m)) if m.contains("already queued")));
        let queued = work_kinds(&paths, &repo)
            .into_iter()
            .filter(|k| *k == WorkKind::ArcQueued)
            .count();
        assert_eq!(queued, 2);
    }

    fn place<'a>(arc: &'a str, brief: &'a str, by: &'a By) -> PlaceArc<'a> {
        PlaceArc {
            arc,
            brief,
            sketch: None,
            name: None,
            by,
        }
    }

    #[test]
    fn place_fills_the_entry_queued_by_name_and_refuses_another_brief() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();
        add_entry(&paths, &repo, &id, entry("briefs/b.md", &[])).unwrap();
        let by = By::none();
        let queued = QueueArc {
            arc: "named-arc",
            brief: "briefs/b.md",
            cycle: Some(&id),
            label: None,
            waits: Vec::new(),
            after: None,
            from: Vec::new(),
            by: &by,
        };
        queue_arc(&paths, &repo, queued).unwrap();

        log_append(&paths, &repo, "2026-11-02T00:00:00Z  named-arc  arc-start  briefs/b.md");
        let wrong = place_arc(&paths, &repo, place("named-arc", "briefs/a.md", &by));
        assert!(
            matches!(&wrong, Err(ArcError::Refused(m)) if m.contains("briefs/b.md") && m.contains("briefs/a.md")),
            "{wrong:?}"
        );
        let filled = place_arc(&paths, &repo, place("named-arc", "briefs/b.md", &by)).unwrap();
        assert_eq!((filled.n, filled.outcome), (Some(2), Outcome::Filled));
        let again = place_arc(&paths, &repo, place("named-arc", "briefs/b.md", &by)).unwrap();
        assert_eq!((again.n, again.outcome), (Some(2), Outcome::Already));
        let record = cycles(&paths, &repo).remove(0);
        assert!(record.entry(1).unwrap().arc.is_none(), "the free entry is untouched");
    }

    #[test]
    fn place_adds_an_unlisted_entry_for_a_brief_run_again_and_starts_a_cycle_of_one() {
        let (_t, repo, paths) = scratch();
        let id = sketched(&paths, &repo, "C");
        add_entry(&paths, &repo, &id, entry("briefs/a.md", &[])).unwrap();
        let by = By::none();
        log_append(&paths, &repo, "2026-11-01T00:00:00Z  aa  arc-start  briefs/a.md");
        assert_eq!(place_arc(&paths, &repo, place("aa", "briefs/a.md", &by)).unwrap().outcome, Outcome::Filled);
        log_append(&paths, &repo, "2026-11-01T01:00:00Z  aa  abc123  joined");

        log_append(&paths, &repo, "2026-11-02T00:00:00Z  again  arc-start  briefs/a.md");
        let rerun = place_arc(&paths, &repo, place("again", "briefs/a.md", &by)).unwrap();
        assert_eq!((rerun.n, rerun.outcome), (Some(2), Outcome::Added));
        let record = cycles(&paths, &repo).remove(0);
        let e = record.entry(2).unwrap();
        assert!(!e.listed && e.waits.is_empty());
        assert_eq!(e.from, ["A"]);
        let view = view_cycle(&paths, &record);
        assert_eq!((view.run_landed, view.run_total), (1, 1), "the rerun is not counted");

        let fresh = record_sketch(&paths, &repo, "fresh-sketch");
        log_append(&paths, &repo, "2026-11-03T00:00:00Z  lone  arc-start  briefs/lone.md");
        let refused = place_arc(&paths, &repo, place("lone", "briefs/lone.md", &by));
        assert!(matches!(refused, Err(ArcError::Refused(m)) if m.contains("sketch")));
        let started = place_arc(
            &paths,
            &repo,
            PlaceArc {
                sketch: Some(&fresh),
                name: Some("Lone"),
                ..place("lone", "briefs/lone.md", &by)
            },
        )
        .unwrap();
        assert_eq!((started.n, started.outcome), (Some(1), Outcome::Started));
        assert_eq!(started.name, "Lone");
        let lone = find_cycle(&paths, &started.cycle).remove(0).1;
        assert!(lone.entry(1).unwrap().listed);
        assert_eq!(lone.entry(1).unwrap().arc_name.as_deref(), Some("lone"));
    }

    #[test]
    fn place_brief_adds_listed_work_once_and_links_an_unplaced_brief() {
        let (_t, repo, paths) = scratch();
        fs::create_dir_all(repo.join("briefs")).unwrap();
        fs::write(repo.join("briefs/next.md"), "# Next\n").unwrap();
        fs::write(repo.join("briefs/up.md"), "# Up\n").unwrap();
        let id = sketched(&paths, &repo, "C");
        let sketch = cycles(&paths, &repo).remove(0).sketches[0].id.clone();
        let by = By::none();
        let req = PlaceBrief {
            brief: "briefs/next.md",
            sketch: Some(&sketch),
            from_brief: Some("briefs/up.md"),
            cycle: None,
            name: None,
            waits: Vec::new(),
            note: None,
            by: &by,
        };
        let first = place_brief(&paths, &repo, req.clone()).unwrap();
        assert_eq!((first.cycle.as_str(), first.n, first.outcome), (id.as_str(), Some(1), Outcome::Linked));
        let record = cycles(&paths, &repo).remove(0);
        assert!(record.entry(1).unwrap().listed);
        assert_eq!(record.sketches[0].brief.as_deref(), Some("briefs/up.md"));
        assert!(
            crate::brief::id_line(&fs::read_to_string(repo.join("briefs/next.md")).unwrap()).is_some(),
            "the brief skill's verb writes the id line"
        );
        assert_eq!(fs::read_to_string(repo.join("briefs/up.md")).unwrap(), "# Up\n");

        let again = place_brief(&paths, &repo, req).unwrap();
        assert_eq!((again.n, again.outcome), (Some(1), Outcome::Already));
        assert_eq!(cycles(&paths, &repo).remove(0).entries.len(), 1);
    }

    #[test]
    fn place_brief_with_nothing_to_come_from_starts_no_cycle() {
        let (_t, repo, paths) = scratch();
        fs::create_dir_all(repo.join("briefs")).unwrap();
        fs::write(repo.join("briefs/next.md"), "# Next\n").unwrap();
        fs::write(repo.join("briefs/up.md"), "# Up\n").unwrap();
        let by = By::none();
        let refused = place_brief(
            &paths,
            &repo,
            PlaceBrief {
                brief: "briefs/next.md",
                sketch: None,
                from_brief: Some("briefs/up.md"),
                cycle: None,
                name: Some("Nowhere"),
                waits: Vec::new(),
                note: None,
                by: &by,
            },
        );
        assert!(refused.is_err(), "a new cycle needs a sketch for its entry");
        assert!(cycles(&paths, &repo).is_empty(), "the refusal leaves no empty cycle");
    }

    #[test]
    fn opening_and_joining_an_arc_each_leave_one_work_line() {
        let (_t, repo, paths) = scratch();
        crate::log::append_arc_log(&paths, &repo, "wl", "arc-start", "briefs/a.md").unwrap();
        crate::log::append_arc_log(&paths, &repo, "wl", "abc1234", "a round").unwrap();
        crate::log::append_arc_log(&paths, &repo, "wl", "def5678", "joined").unwrap();
        let lines = work_log::read_lines(
            &fs::read_to_string(work_log::work_log_path(&paths, &repo)).unwrap(),
        );
        let kinds: Vec<WorkKind> = lines.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, [WorkKind::ArcOpened, WorkKind::ArcJoined]);
        let log = fs::read_to_string(tugtool_core::paths::arc_log_path_at(&paths, &repo)).unwrap();
        let start = generation_started_at(&log, "wl");
        for line in &lines {
            assert_eq!(
                line.object,
                WorkObject::Arc {
                    arc: "wl".into(),
                    created: start.clone()
                },
                "both name the generation by its start"
            );
        }
        assert_eq!(lines[1].detail["sha"], "def5678");
    }

    #[test]
    fn an_entry_with_no_brief_record_breaks_the_chain() {
        let mut record = of(vec![CycleEntry {
            from: vec!["A".into()],
            brief_id: String::new(),
            ..linked(1, &[], None)
        }]);
        record.sketches.push(sketch("A", false));
        assert_eq!(chain_breaks(&record), vec!["entry 1 has no brief record"]);
    }
}
