//! A docket's threads: what each filed piece of work brings into view.
//!
//! A docket holds only what the user filed ([`crate::docket`]). A thread is
//! derived: filing an arc brings its sketch, its brief, the sessions its
//! stages ran in and the commits its rounds and its join made, because the
//! arc log, the archive and the sketch store already record every one of
//! those links. Filing any one of them — the sketch, the join commit, a copy
//! of the brief — reaches the same thread. A main-lane session and the
//! commits that name it in a `Tug-Session-Id` trailer are a thread with no
//! arc, and anything that links to nothing is a thread of its own.
//!
//! The work is split in two so every reader derives the same threads.
//! [`gather_inputs`] does all the IO — the arc log, the archive, the live
//! documents, the sketch store, the session index and git — and
//! [`derive_threads`] is a pure function over what it gathered, so the
//! `tugtool docket` verbs, the tugcast feed and the tests cannot disagree
//! about one docket.
//!
//! Every item anchors on one thing, in order of precedence: the arc
//! generation it belongs to, else the session line it belongs to, else
//! itself. Items with one anchor are one thread, and a filed item is never
//! shown twice. After a join the round commits are unreachable, so their
//! subjects come from the arc log's round lines, never from git.
//!
//! Lineage anchors too, after every direct arc tie. An idea's sketch, the
//! brief versions written from that sketch and the sessions the idea was
//! sketched in all join the idea's thread, and once an arc adopts the sketch
//! the whole lineage joins the arc's newest generation. Only the idea is ever
//! filed; the rest arrives by derivation. A brief version written from an
//! older sketch version is marked stale, and so is an arc whose brief is an
//! older brief version.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use tugcore::instance::Paths;
use tugcore::session_index::IndexEntry;

use crate::archive::{ArchiveEntry, compact_stamp};
use crate::docket::{Docket, DocketItem};
use crate::log::{GenerationEnd, arc_generations, is_round_line, is_yield_note, split_log_line};
use crate::sketch::{SketchArc, SketchAuthor};

/// The stage a session an idea lists is shown with.
pub const SKETCH_STAGE: &str = "sketch";

/// One commit, as `git log` describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitFact {
    /// The full sha.
    pub sha: String,
    pub subject: String,
    /// Every `Tug-Session-Id` trailer value.
    pub session_ids: Vec<String>,
    /// The `Tug-Arc` trailer, `tugarc/<name> onto <base>`.
    pub arc_trailer: Option<String>,
    /// The committer date, ISO 8601.
    pub date: String,
}

/// An arc's brief, hashed: an archived generation's (`created` set) or a live
/// arc's (`created` `None`, which is the name's newest generation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArcBrief {
    pub name: String,
    pub created: Option<String>,
    pub sha256: String,
    pub title: Option<String>,
}

/// A sketch record, with the want its newest version states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SketchFact {
    pub id: String,
    pub versions: u32,
    pub want: Option<String>,
    pub created: String,
    pub arc: Option<SketchArc>,
    /// The idea the sketch was kept from.
    pub idea: Option<String>,
    /// Who wrote the newest version.
    pub latest_author: SketchAuthor,
    /// The brief versions written from the sketch, oldest first.
    pub briefs: Vec<BriefVersionFact>,
}

/// One brief version a sketch keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BriefVersionFact {
    pub n: u32,
    pub sha256: String,
    pub title: String,
    pub path: String,
    /// The sketch version it was written from.
    pub sketch_version: u32,
}

/// An idea record: its line, and the sessions it was sketched in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdeaFact {
    pub id: String,
    pub text: String,
    pub created: String,
    /// Session uuids, oldest first.
    pub sessions: Vec<String>,
}

/// Everything [`derive_threads`] reads.
#[derive(Debug, Clone)]
pub struct DocketInputs {
    pub docket: Docket,
    /// The checkout's arc log, whole.
    pub log: String,
    /// Every archive entry of the checkout.
    pub archive: Vec<ArchiveEntry>,
    pub arc_briefs: Vec<ArcBrief>,
    pub sketches: Vec<SketchFact>,
    /// Every idea of the checkout.
    pub ideas: Vec<IdeaFact>,
    /// Session-index rows for every filed session's line and every stage
    /// session the log names, and every session an idea lists.
    pub sessions: Vec<IndexEntry>,
    /// Every commit the derivation may name.
    pub commits: Vec<CommitFact>,
}

/// What became of a thread's arc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArcFate {
    Live,
    Joined,
    Discarded,
    /// The log records no generation of the filed arc.
    Unknown,
}

/// Where a thread's brief came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BriefSource {
    /// The arc's own `brief.md`, live or archived.
    Arc,
    /// A snapshot filed on the docket.
    Filed,
    /// The newest brief version kept on the thread's sketch.
    Sketch,
}

/// The part a commit plays in its thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommitRole {
    /// One of the arc's rounds.
    Round,
    /// The arc's join.
    Join,
    /// A commit whose `Tug-Arc` trailer names the arc.
    Arc,
    /// A commit a session of the thread made.
    Session,
    /// A commit filed on its own.
    Filed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchCell {
    pub id: String,
    pub versions: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub want: Option<String>,
    /// Who wrote the newest version.
    #[serde(default)]
    pub author: SketchAuthor,
    pub filed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BriefCell {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub source: BriefSource,
    /// The filed snapshot, for a brief filed on its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub filed: bool,
    /// The newest brief version kept on the thread's sketch; `None` when the
    /// brief is only an arc's copy or a filed snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// How many brief versions the sketch keeps.
    #[serde(default)]
    pub versions: u32,
    /// The sketch version the newest brief version was written from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch_version: Option<u32>,
    /// The sketch has moved on since the newest brief version was written.
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArcCell {
    pub name: String,
    pub created: String,
    pub fate: ArcFate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_sha: Option<String>,
    pub filed: bool,
    /// The brief version whose bytes the arc's `brief.md` holds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief_version: Option<u32>,
    /// A newer brief version than the arc's has been written.
    #[serde(default)]
    pub stale: bool,
    /// How many generations ran on the thread's sketch: 1, or more after a
    /// reopen.
    #[serde(default = "one")]
    pub runs: u32,
}

fn one() -> u32 {
    1
}

/// A thread's idea.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdeaCell {
    pub id: String,
    /// Its one line; the id when the record is missing.
    pub text: String,
    pub filed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCell {
    pub uuid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callsign: Option<String>,
    /// The arc stage the session ran, for an arc's stage session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    pub filed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitCell {
    /// The full sha where it is known; a round's is the arc log's short one.
    pub sha: String,
    pub subject: String,
    pub role: CommitRole,
    pub filed: bool,
}

/// One thread: a line of work as far as it has gone, in the order it ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thread {
    /// `arc:<name>@<created>`, `idea:<id>`, `session:<line>`, or the lone
    /// item's key.
    pub key: String,
    /// When the thread began, ISO 8601; empty when nothing says.
    pub start: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea: Option<IdeaCell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch: Option<SketchCell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<BriefCell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc: Option<ArcCell>,
    #[serde(default)]
    pub sessions: Vec<SessionCell>,
    #[serde(default)]
    pub commits: Vec<CommitCell>,
    /// The store keys of the docket items this thread holds — what a removal
    /// names. A cell's identity is not always its item's key: a session is
    /// filed by its line, and a round's cell carries the log's short sha.
    #[serde(default)]
    pub filed_keys: Vec<String>,
}

/// One generation of an arc name, with what the log says happened in it.
#[derive(Debug, Clone)]
struct Generation {
    name: String,
    started_at: String,
    ended_at: Option<String>,
    end: GenerationEnd,
    sketch_id: Option<String>,
    /// Stage sessions, `(uuid, stage)`, deduped by uuid, in log order.
    stages: Vec<(String, String)>,
    /// Round lines, `(short sha, title)`, in log order.
    rounds: Vec<(String, String)>,
}

impl Generation {
    fn key(&self) -> String {
        format!("arc:{}@{}", self.name, self.started_at)
    }

    /// The log's short join marker.
    fn join_marker(&self) -> Option<&str> {
        match &self.end {
            GenerationEnd::Joined { sha } => Some(sha),
            _ => None,
        }
    }
}

/// Every generation the log records, grouped by name and read through the
/// log's own walk ([`arc_generations`]).
fn generations(log: &str) -> Vec<Generation> {
    let mut by_name: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for line in log.lines() {
        if let Some((_, name, _, _)) = split_log_line(line) {
            by_name.entry(name).or_default().push(line);
        }
    }
    let mut all = Vec::new();
    for (name, lines) in by_name {
        let text = lines.join("\n");
        let mut gens: Vec<Generation> = arc_generations(&text, name)
            .into_iter()
            .map(|g| Generation {
                name: name.to_string(),
                started_at: g.started_at,
                ended_at: g.ended_at,
                end: g.end,
                sketch_id: None,
                stages: Vec::new(),
                rounds: Vec::new(),
            })
            .collect();
        if gens.is_empty() {
            continue;
        }
        // A later generation opens on the `arc-start` line its start names,
        // after the one before it ended; every other line belongs to the
        // generation already open.
        let mut current = 0;
        for line in lines {
            let Some((timestamp, _, marker, note)) = split_log_line(line) else {
                continue;
            };
            if current + 1 < gens.len()
                && marker == "arc-start"
                && gens[current].end != GenerationEnd::Open
                && timestamp == gens[current + 1].started_at
            {
                current += 1;
            }
            let g = &mut gens[current];
            match marker {
                "arc-sketch" if !note.is_empty() => g.sketch_id = Some(note.to_string()),
                "arc-stage" => {
                    if let Some(stage) = crate::arc::read_stage_line(note, timestamp) {
                        if !g.stages.iter().any(|(u, _)| *u == stage.session_id) {
                            g.stages
                                .push((stage.session_id, stage.stage.as_str().to_string()));
                        }
                    }
                }
                _ if is_round_line(marker, note) && !is_yield_note(note) => {
                    g.rounds.push((marker.to_string(), note.to_string()));
                }
                _ => {}
            }
        }
        all.extend(gens);
    }
    all
}

/// Every session uuid an `arc-stage` line of the log names — the stage
/// sessions whose callsigns a thread may show.
pub fn stage_session_ids(log: &str) -> BTreeSet<String> {
    generations(log)
        .into_iter()
        .flat_map(|g| g.stages.into_iter().map(|(uuid, _)| uuid))
        .collect()
}

/// What an item anchors on.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Anchor {
    /// An index into the generations.
    Arc(usize),
    /// An idea with no arc yet, by its id.
    Idea(String),
    /// A session line's key: its line id, or the uuid when it has none.
    Line(String),
    /// The item itself, by its key.
    Own(String),
}

/// A sha and a possibly-short marker name one commit.
fn same_commit(sha: &str, marker: &str) -> bool {
    !marker.is_empty() && (sha.starts_with(marker) || marker.starts_with(sha))
}

fn millis(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn iso_of_millis(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn line_key(uuid: &str, line_id: &str) -> String {
    if line_id.is_empty() {
        uuid.to_string()
    } else {
        line_id.to_string()
    }
}

/// The derivation's lookups over its inputs.
struct Index<'a> {
    inputs: &'a DocketInputs,
    gens: Vec<Generation>,
    /// Brief SHA-256 → the generation whose brief it is.
    brief_gen: BTreeMap<&'a str, usize>,
    /// Generation → its brief.
    gen_brief: BTreeMap<usize, &'a ArcBrief>,
    /// Filed session lines → every uuid of the line.
    filed_lines: BTreeMap<String, BTreeSet<String>>,
    /// Brief-version SHA-256 → the sketch that keeps it.
    brief_sketch: BTreeMap<&'a str, &'a str>,
    /// Idea → its newest sketch.
    idea_sketch: BTreeMap<&'a str, &'a str>,
    /// A session an idea lists → the idea.
    session_idea: BTreeMap<&'a str, &'a str>,
}

impl<'a> Index<'a> {
    fn new(inputs: &'a DocketInputs) -> Self {
        let gens = generations(&inputs.log);
        let mut brief_gen = BTreeMap::new();
        let mut gen_brief = BTreeMap::new();
        for brief in &inputs.arc_briefs {
            let found = match &brief.created {
                Some(created) => {
                    let want = compact_stamp(created);
                    gens.iter()
                        .position(|g| g.name == brief.name && compact_stamp(&g.started_at) == want)
                }
                None => gens.iter().rposition(|g| g.name == brief.name),
            };
            if let Some(i) = found {
                brief_gen.entry(brief.sha256.as_str()).or_insert(i);
                gen_brief.entry(i).or_insert(brief);
            }
        }
        let mut filed_lines: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for item in &inputs.docket.items {
            if let DocketItem::Session { uuid, line_id, .. } = item {
                let segments = filed_lines.entry(line_key(uuid, line_id)).or_default();
                segments.insert(uuid.clone());
                if !line_id.is_empty() {
                    segments.extend(
                        inputs
                            .sessions
                            .iter()
                            .filter(|e| &e.line_id == line_id)
                            .map(|e| e.session_id.clone()),
                    );
                }
            }
        }
        let mut brief_sketch = BTreeMap::new();
        for sketch in &inputs.sketches {
            for b in &sketch.briefs {
                brief_sketch
                    .entry(b.sha256.as_str())
                    .or_insert(sketch.id.as_str());
            }
        }
        let mut kept: Vec<&SketchFact> = inputs
            .sketches
            .iter()
            .filter(|s| s.idea.is_some())
            .collect();
        kept.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
        let mut idea_sketch = BTreeMap::new();
        for s in kept {
            if let Some(idea) = s.idea.as_deref() {
                idea_sketch.insert(idea, s.id.as_str());
            }
        }
        let mut session_idea = BTreeMap::new();
        for idea in &inputs.ideas {
            for uuid in &idea.sessions {
                session_idea
                    .entry(uuid.as_str())
                    .or_insert(idea.id.as_str());
            }
        }
        Index {
            inputs,
            gens,
            brief_gen,
            gen_brief,
            filed_lines,
            brief_sketch,
            idea_sketch,
            session_idea,
        }
    }

    fn gen_of_arc(&self, name: &str, created: &str) -> Option<usize> {
        let want = compact_stamp(created);
        self.gens
            .iter()
            .position(|g| g.name == name && compact_stamp(&g.started_at) == want)
    }

    fn archive_of(&self, g: &Generation) -> Option<&'a ArchiveEntry> {
        let want = compact_stamp(&g.started_at);
        self.inputs
            .archive
            .iter()
            .find(|e| e.name == g.name && compact_stamp(&e.created) == want)
    }

    fn fact(&self, sha: &str) -> Option<&'a CommitFact> {
        self.inputs
            .commits
            .iter()
            .find(|c| same_commit(&c.sha, sha))
    }

    fn sketch(&self, id: &str) -> Option<&'a SketchFact> {
        self.inputs.sketches.iter().find(|s| s.id == id)
    }

    fn idea(&self, id: &str) -> Option<&'a IdeaFact> {
        self.inputs.ideas.iter().find(|i| i.id == id)
    }

    /// The newest generation a sketch is tied to, by the log or by its link.
    fn sketch_gen(&self, id: &str) -> Option<usize> {
        let by_log = self
            .gens
            .iter()
            .rposition(|g| g.sketch_id.as_deref() == Some(id));
        let by_link = self.sketch(id).and_then(|s| {
            let link = s.arc.as_ref()?;
            self.gen_of_arc(&link.name, link.created.as_deref()?)
        });
        by_log.max(by_link)
    }

    /// A sketch's anchor: its generation, else its idea's.
    fn sketch_anchor(&self, id: &str) -> Option<Anchor> {
        if let Some(g) = self.sketch_gen(id) {
            return Some(Anchor::Arc(g));
        }
        self.idea_anchor(self.sketch(id)?.idea.as_deref()?)
    }

    /// An idea's anchor: the generation its newest sketch reaches, else the
    /// idea itself when its record is there.
    fn idea_anchor(&self, id: &str) -> Option<Anchor> {
        if let Some(g) = self.idea_sketch.get(id).and_then(|s| self.sketch_gen(s)) {
            return Some(Anchor::Arc(g));
        }
        self.idea(id).map(|_| Anchor::Idea(id.to_string()))
    }

    fn callsign(&self, uuid: &str) -> Option<String> {
        self.inputs
            .sessions
            .iter()
            .find(|e| e.session_id == uuid)
            .and_then(|e| e.callsign.clone())
    }

    /// The generation's join sha: the archive's full one, else the log's.
    fn join_sha(&self, g: &Generation) -> Option<String> {
        let marker = g.join_marker()?;
        let full = self
            .archive_of(g)
            .and_then(|e| e.join_sha.clone())
            .filter(|s| same_commit(s, marker));
        Some(full.unwrap_or_else(|| {
            self.fact(marker)
                .map(|f| f.sha.clone())
                .unwrap_or_else(|| marker.to_string())
        }))
    }

    /// The generation whose join or rounds made `sha`, or whose `Tug-Arc`
    /// trailer the commit carries within the generation's span.
    fn gen_of_commit(&self, sha: &str) -> Option<usize> {
        let by_line = self.gens.iter().position(|g| {
            g.join_marker().is_some_and(|m| same_commit(sha, m))
                || self
                    .archive_of(g)
                    .and_then(|e| e.join_sha.as_deref())
                    .is_some_and(|j| g.join_marker().is_some() && same_commit(sha, j))
                || g.rounds.iter().any(|(m, _)| same_commit(sha, m))
        });
        if by_line.is_some() {
            return by_line;
        }
        let fact = self.fact(sha)?;
        let trailer = fact.arc_trailer.as_deref()?;
        let name = trailer.strip_prefix("tugarc/")?.split_whitespace().next()?;
        let date = millis(&fact.date)?;
        self.gens.iter().position(|g| {
            g.name == name
                && millis(&g.started_at).is_some_and(|s| s <= date)
                && g.ended_at
                    .as_deref()
                    .is_none_or(|e| millis(e).is_none_or(|e| date <= e))
        })
    }

    fn anchor(&self, item: &DocketItem) -> Anchor {
        let own = || Anchor::Own(item.key());
        match item {
            DocketItem::Arc { name, created, .. } => {
                self.gen_of_arc(name, created).map_or_else(own, Anchor::Arc)
            }
            DocketItem::Sketch { id, .. } => self.sketch_anchor(id).unwrap_or_else(own),
            DocketItem::Idea { id, .. } => self.idea_anchor(id).unwrap_or_else(own),
            DocketItem::Brief { sha256, .. } => {
                if let Some(g) = self.brief_gen.get(sha256.as_str()) {
                    return Anchor::Arc(*g);
                }
                self.brief_sketch
                    .get(sha256.as_str())
                    .and_then(|s| self.sketch_anchor(s))
                    .unwrap_or_else(own)
            }
            DocketItem::Session { uuid, line_id, .. } => {
                if let Some(g) = self
                    .gens
                    .iter()
                    .position(|g| g.stages.iter().any(|(u, _)| u == uuid))
                {
                    return Anchor::Arc(g);
                }
                self.session_idea
                    .get(uuid.as_str())
                    .and_then(|i| self.idea_anchor(i))
                    .unwrap_or_else(|| Anchor::Line(line_key(uuid, line_id)))
            }
            DocketItem::Commit { sha, .. } => {
                if let Some(g) = self.gen_of_commit(sha) {
                    return Anchor::Arc(g);
                }
                let ids = self.fact(sha).map(|f| &f.session_ids);
                let line = ids.and_then(|ids| {
                    self.filed_lines
                        .iter()
                        .find(|(_, segments)| ids.iter().any(|id| segments.contains(id)))
                        .map(|(line, _)| line.clone())
                });
                line.map_or_else(own, Anchor::Line)
            }
        }
    }

    fn filed(&self, key: &str) -> bool {
        self.inputs.docket.holds(key)
    }

    fn filed_commit(&self, sha: &str) -> bool {
        self.inputs
            .docket
            .items
            .iter()
            .any(|i| matches!(i, DocketItem::Commit { sha: s, .. } if same_commit(s, sha)))
    }

    fn sketch_cell(&self, id: &str) -> SketchCell {
        let fact = self.sketch(id);
        SketchCell {
            id: id.to_string(),
            versions: fact.map_or(0, |s| s.versions),
            want: fact.and_then(|s| s.want.clone()),
            author: fact.map(|s| s.latest_author).unwrap_or_default(),
            filed: self.filed(&format!("sketch:{id}")),
        }
    }

    fn idea_cell(&self, id: &str) -> IdeaCell {
        IdeaCell {
            id: id.to_string(),
            text: self
                .idea(id)
                .map_or_else(|| id.to_string(), |i| i.text.clone()),
            filed: self.filed(&format!("idea:{id}")),
        }
    }

    /// A brief cell's version fields, read from the sketch's brief versions.
    /// A cell with no path of its own — an arc's copy that was never filed —
    /// takes the latest brief version's, so Open arc and Reopen arc have a
    /// file to name.
    fn stamp_versions(&self, cell: &mut BriefCell, sketch: Option<&SketchFact>) {
        let Some(sketch) = sketch else {
            return;
        };
        let Some(latest) = sketch.briefs.iter().max_by_key(|b| b.n) else {
            return;
        };
        cell.version = Some(latest.n);
        cell.versions = sketch.briefs.len() as u32;
        cell.sketch_version = Some(latest.sketch_version);
        cell.stale = latest.sketch_version < sketch.versions;
        if cell.source_path.is_none() {
            cell.source_path = Some(latest.path.clone());
        }
    }

    /// The brief cell a sketch's newest brief version makes, with a brief
    /// filed beside it keeping its snapshot on the cell.
    fn sketch_brief_cell(
        &self,
        sketch: &SketchFact,
        filed_brief: Option<&(String, String)>,
    ) -> Option<BriefCell> {
        let latest = sketch.briefs.iter().max_by_key(|b| b.n)?;
        let mut cell = BriefCell {
            title: Some(latest.title.clone()),
            source: BriefSource::Sketch,
            snapshot: filed_brief.map(|(s, _)| s.clone()),
            source_path: Some(filed_brief.map_or_else(|| latest.path.clone(), |(_, p)| p.clone())),
            filed: filed_brief.is_some(),
            version: None,
            versions: 0,
            sketch_version: None,
            stale: false,
        };
        self.stamp_versions(&mut cell, Some(sketch));
        Some(cell)
    }

    /// The cells of an idea's sessions, each shown as a sketching session.
    fn idea_sessions(&self, idea: &IdeaFact, members: &[&DocketItem]) -> Vec<SessionCell> {
        idea.sessions
            .iter()
            .map(|uuid| SessionCell {
                uuid: uuid.clone(),
                callsign: self.callsign(uuid),
                stage: Some(SKETCH_STAGE.to_string()),
                filed: members
                    .iter()
                    .any(|m| matches!(m, DocketItem::Session { uuid: u, .. } if u == uuid)),
            })
            .collect()
    }

    /// The commits the given sessions made, oldest first, as session cells.
    fn session_commits(&self, uuids: &BTreeSet<&str>) -> Vec<CommitCell> {
        let mut facts: Vec<&CommitFact> = self
            .inputs
            .commits
            .iter()
            .filter(|c| c.session_ids.iter().any(|id| uuids.contains(id.as_str())))
            .collect();
        facts.sort_by_key(|c| (millis(&c.date).unwrap_or(i64::MAX), c.sha.clone()));
        facts
            .iter()
            .map(|c| self.commit_cell(&c.sha, CommitRole::Session))
            .collect()
    }

    fn commit_cell(&self, sha: &str, role: CommitRole) -> CommitCell {
        let fact = self.fact(sha);
        CommitCell {
            sha: fact.map_or_else(|| sha.to_string(), |f| f.sha.clone()),
            subject: fact.map(|f| f.subject.clone()).unwrap_or_default(),
            role,
            filed: self.filed_commit(sha),
        }
    }

    fn arc_thread(&self, i: usize, members: &[&DocketItem]) -> Thread {
        let g = &self.gens[i];
        let fate = match g.end {
            GenerationEnd::Open => ArcFate::Live,
            GenerationEnd::Joined { .. } => ArcFate::Joined,
            GenerationEnd::Discarded => ArcFate::Discarded,
        };
        let linked_sketch = || {
            self.inputs
                .sketches
                .iter()
                .filter(|s| {
                    s.arc.as_ref().is_some_and(|l| {
                        l.name == g.name
                            && l.created
                                .as_deref()
                                .is_some_and(|c| compact_stamp(c) == compact_stamp(&g.started_at))
                    })
                })
                .max_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)))
        };
        let sketch_id = g
            .sketch_id
            .clone()
            .or_else(|| linked_sketch().map(|s| s.id.clone()));
        let sketch_fact = sketch_id.as_deref().and_then(|id| self.sketch(id));
        let idea_fact = sketch_fact
            .and_then(|s| s.idea.as_deref())
            .and_then(|id| self.idea(id));
        let sketch = sketch_id.as_deref().map(|id| self.sketch_cell(id));
        let idea = idea_fact.map(|i| self.idea_cell(&i.id));

        let arc_brief = self.gen_brief.get(&i);
        let brief_version = arc_brief.and_then(|b| {
            sketch_fact?
                .briefs
                .iter()
                .find(|v| v.sha256 == b.sha256)
                .map(|v| v.n)
        });
        let latest_brief = sketch_fact.and_then(|s| s.briefs.iter().map(|b| b.n).max());
        let runs = match sketch_id.as_deref() {
            Some(id) => self
                .gens
                .iter()
                .enumerate()
                .filter(|(j, other)| {
                    other.sketch_id.as_deref() == Some(id) || (*j == i && other.sketch_id.is_none())
                })
                .count()
                .max(1) as u32,
            None => 1,
        };
        let arc = ArcCell {
            name: g.name.clone(),
            created: g.started_at.clone(),
            fate,
            join_sha: self.join_sha(g),
            filed: self.filed(&g.key()),
            brief_version,
            stale: brief_version.zip(latest_brief).is_some_and(|(n, l)| n < l),
            runs,
        };

        // A brief filed beside its arc's own copy keeps its snapshot and its
        // source on the cell, so it can be moved and removed as filed.
        let filed_brief = members.iter().find_map(|m| match m {
            DocketItem::Brief {
                snapshot,
                source_path,
                ..
            } => Some((snapshot.clone(), source_path.clone())),
            _ => None,
        });
        let brief = match arc_brief {
            Some(b) => {
                let mut cell = BriefCell {
                    title: b.title.clone(),
                    source: BriefSource::Arc,
                    snapshot: filed_brief.as_ref().map(|(s, _)| s.clone()),
                    source_path: filed_brief.as_ref().map(|(_, p)| p.clone()),
                    filed: filed_brief.is_some(),
                    version: None,
                    versions: 0,
                    sketch_version: None,
                    stale: false,
                };
                self.stamp_versions(&mut cell, sketch_fact);
                Some(cell)
            }
            None => sketch_fact.and_then(|s| self.sketch_brief_cell(s, filed_brief.as_ref())),
        };

        // The idea's sketching sessions come before the stage sessions.
        let mut sessions =
            idea_fact.map_or_else(Vec::new, |idea| self.idea_sessions(idea, members));
        for (uuid, stage) in &g.stages {
            if sessions.iter().any(|s| &s.uuid == uuid) {
                continue;
            }
            sessions.push(SessionCell {
                uuid: uuid.clone(),
                callsign: self.callsign(uuid),
                stage: Some(stage.clone()),
                filed: members
                    .iter()
                    .any(|m| matches!(m, DocketItem::Session { uuid: u, .. } if u == uuid)),
            });
        }

        let mut commits: Vec<CommitCell> = g
            .rounds
            .iter()
            .map(|(marker, title)| CommitCell {
                sha: marker.clone(),
                subject: title.clone(),
                role: CommitRole::Round,
                filed: self.filed_commit(marker),
            })
            .collect();
        if let Some(join) = self.join_sha(g) {
            commits.push(self.commit_cell(&join, CommitRole::Join));
        }
        if let Some(idea) = idea_fact {
            let uuids: BTreeSet<&str> = idea.sessions.iter().map(String::as_str).collect();
            for cell in self.session_commits(&uuids) {
                if !commits.iter().any(|c| same_commit(&c.sha, &cell.sha)) {
                    commits.push(cell);
                }
            }
        }
        for m in members {
            if let DocketItem::Commit { sha, .. } = m {
                if !commits.iter().any(|c| same_commit(&c.sha, sha)) {
                    commits.push(self.commit_cell(sha, CommitRole::Arc));
                }
            }
        }

        Thread {
            key: g.key(),
            start: g.started_at.clone(),
            idea,
            sketch,
            brief,
            arc: Some(arc),
            sessions,
            commits,
            filed_keys: Vec::new(),
        }
    }

    /// The thread of an idea no arc has adopted: the idea, its newest sketch,
    /// that sketch's newest brief version, the sessions it was sketched in and
    /// the commits they made.
    fn idea_thread(&self, id: &str, members: &[&DocketItem]) -> Thread {
        let fact = self.idea(id);
        let sketch_fact = self.idea_sketch.get(id).and_then(|s| self.sketch(s));
        let filed_brief = members.iter().find_map(|m| match m {
            DocketItem::Brief {
                snapshot,
                source_path,
                ..
            } => Some((snapshot.clone(), source_path.clone())),
            _ => None,
        });
        let sessions = fact.map_or_else(Vec::new, |idea| self.idea_sessions(idea, members));
        let uuids: BTreeSet<&str> = sessions.iter().map(|s| s.uuid.as_str()).collect();
        Thread {
            key: format!("idea:{id}"),
            start: fact.map(|i| i.created.clone()).unwrap_or_default(),
            idea: Some(self.idea_cell(id)),
            sketch: sketch_fact.map(|s| self.sketch_cell(&s.id)),
            brief: sketch_fact.and_then(|s| self.sketch_brief_cell(s, filed_brief.as_ref())),
            arc: None,
            commits: self.session_commits(&uuids),
            sessions,
            filed_keys: Vec::new(),
        }
    }

    fn line_thread(&self, line: &str, members: &[&DocketItem]) -> Thread {
        let mut segments: Vec<&IndexEntry> = self
            .inputs
            .sessions
            .iter()
            .filter(|e| !e.line_id.is_empty() && e.line_id == line)
            .collect();
        segments.sort_by(|a, b| {
            a.created_at_ms
                .cmp(&b.created_at_ms)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        let filed_uuids: Vec<&str> = members
            .iter()
            .filter_map(|m| match m {
                DocketItem::Session { uuid, .. } => Some(uuid.as_str()),
                _ => None,
            })
            .collect();
        let mut sessions: Vec<SessionCell> = segments
            .iter()
            .map(|e| SessionCell {
                uuid: e.session_id.clone(),
                callsign: e.callsign.clone(),
                stage: None,
                filed: filed_uuids.contains(&e.session_id.as_str()),
            })
            .collect();
        for uuid in &filed_uuids {
            if !sessions.iter().any(|s| s.uuid == *uuid) {
                sessions.push(SessionCell {
                    uuid: uuid.to_string(),
                    callsign: self.callsign(uuid),
                    stage: None,
                    filed: true,
                });
            }
        }

        let ids: BTreeSet<&str> = sessions.iter().map(|s| s.uuid.as_str()).collect();
        let mut facts: Vec<&CommitFact> = self
            .inputs
            .commits
            .iter()
            .filter(|c| c.session_ids.iter().any(|id| ids.contains(id.as_str())))
            .collect();
        facts.sort_by_key(|c| (millis(&c.date).unwrap_or(i64::MAX), c.sha.clone()));
        let mut commits: Vec<CommitCell> = facts
            .iter()
            .map(|c| self.commit_cell(&c.sha, CommitRole::Session))
            .collect();
        for m in members {
            if let DocketItem::Commit { sha, .. } = m {
                if !commits.iter().any(|c| same_commit(&c.sha, sha)) {
                    commits.push(self.commit_cell(sha, CommitRole::Session));
                }
            }
        }

        let start = segments
            .iter()
            .map(|e| e.created_at_ms)
            .min()
            .map(iso_of_millis)
            .unwrap_or_else(|| {
                members
                    .iter()
                    .map(|m| m.filed_at().to_string())
                    .min()
                    .unwrap_or_default()
            });
        Thread {
            key: format!("session:{line}"),
            start,
            idea: None,
            sketch: None,
            brief: None,
            arc: None,
            sessions,
            commits,
            filed_keys: Vec::new(),
        }
    }

    fn own_thread(&self, item: &DocketItem) -> Thread {
        let mut thread = Thread {
            key: item.key(),
            start: item.filed_at().to_string(),
            idea: None,
            sketch: None,
            brief: None,
            arc: None,
            sessions: Vec::new(),
            commits: Vec::new(),
            filed_keys: Vec::new(),
        };
        match item {
            DocketItem::Arc { name, created, .. } => {
                thread.start = created.clone();
                let archived = self.inputs.archive.iter().find(|e| {
                    &e.name == name && compact_stamp(&e.created) == compact_stamp(created)
                });
                thread.arc = Some(ArcCell {
                    name: name.clone(),
                    created: created.clone(),
                    fate: match archived.map(|e| e.fate) {
                        Some(crate::archive::ArchiveFate::Joined) => ArcFate::Joined,
                        Some(_) => ArcFate::Discarded,
                        None => ArcFate::Unknown,
                    },
                    join_sha: archived.and_then(|e| e.join_sha.clone()),
                    filed: true,
                    brief_version: None,
                    stale: false,
                    runs: 1,
                });
            }
            DocketItem::Sketch { id, .. } => {
                if let Some(s) = self.sketch(id) {
                    thread.start = s.created.clone();
                }
                thread.sketch = Some(self.sketch_cell(id));
            }
            // Only an idea whose record is missing stands alone.
            DocketItem::Idea { id, .. } => {
                thread.idea = Some(self.idea_cell(id));
            }
            DocketItem::Brief {
                snapshot,
                source_path,
                title,
                ..
            } => {
                thread.brief = Some(BriefCell {
                    title: title.clone(),
                    source: BriefSource::Filed,
                    snapshot: Some(snapshot.clone()),
                    source_path: Some(source_path.clone()),
                    filed: true,
                    version: None,
                    versions: 0,
                    sketch_version: None,
                    stale: false,
                });
            }
            DocketItem::Commit { sha, .. } => {
                if let Some(f) = self.fact(sha) {
                    thread.start = f.date.clone();
                }
                thread
                    .commits
                    .push(self.commit_cell(sha, CommitRole::Filed));
            }
            // A session always anchors on its line.
            DocketItem::Session { .. } => {}
        }
        thread
    }
}

/// A docket's threads, oldest first, ties by key.
///
/// Pure: everything it reads is in `inputs`.
pub fn derive_threads(inputs: &DocketInputs) -> Vec<Thread> {
    let index = Index::new(inputs);
    let mut anchored: BTreeMap<Anchor, Vec<&DocketItem>> = BTreeMap::new();
    for item in &inputs.docket.items {
        anchored.entry(index.anchor(item)).or_default().push(item);
    }
    let mut threads: Vec<Thread> = anchored
        .iter()
        .map(|(anchor, members)| {
            let mut thread = match anchor {
                Anchor::Arc(i) => index.arc_thread(*i, members),
                Anchor::Idea(id) => index.idea_thread(id, members),
                Anchor::Line(line) => index.line_thread(line, members),
                Anchor::Own(_) => index.own_thread(members[0]),
            };
            thread.filed_keys = members.iter().map(|m| m.key()).collect();
            thread
        })
        .collect();
    threads.sort_by(|a, b| {
        let at = |t: &Thread| millis(&t.start).unwrap_or(i64::MAX);
        at(a).cmp(&at(b)).then_with(|| a.key.cmp(&b.key))
    });
    threads
}

/// The `git log` format [`CommitFact`] is read from: fields split by `0x1f`,
/// records by `0x1e`.
const COMMIT_FORMAT: &str = "%H%x1f%s%x1f%cI%x1f%(trailers:key=Tug-Session-Id,valueonly,separator=%x2C)%x1f%(trailers:key=Tug-Arc,valueonly)%x1e";

fn parse_commits(out: &str) -> Vec<CommitFact> {
    out.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            let mut f = record.split('\x1f');
            let sha = f.next()?.trim().to_string();
            if sha.len() != 40 {
                return None;
            }
            let subject = f.next()?.to_string();
            let date = f.next()?.trim().to_string();
            let session_ids = f
                .next()
                .unwrap_or("")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let arc_trailer = f
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some(CommitFact {
                sha,
                subject,
                session_ids,
                arc_trailer,
                date,
            })
        })
        .collect()
}

fn git_log(repo: &Path, args: &[String]) -> Vec<CommitFact> {
    let Ok(output) = tugcore::git_command()
        .current_dir(crate::ops::main_repo_root(repo))
        .arg("log")
        .arg(format!("--format={COMMIT_FORMAT}"))
        .args(args)
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_commits(&String::from_utf8_lossy(&output.stdout))
}

/// The facts for named commits, skipping any the repository does not have.
fn commit_facts(repo: &Path, shas: &[String]) -> Vec<CommitFact> {
    if shas.is_empty() {
        return Vec::new();
    }
    let mut args = vec![
        "--no-walk=unsorted".to_string(),
        "--ignore-missing".to_string(),
    ];
    args.extend(shas.iter().cloned());
    git_log(repo, &args)
}

fn hash_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Read everything [`derive_threads`] needs for `docket`.
///
/// A docket with no items reads nothing. The one `git log` over `HEAD` runs
/// only when a thread shows a session the user filed or one an idea lists,
/// bounded by the earliest such session's creation; filed commits and join
/// commits are read by name.
pub fn gather_inputs(paths: &Paths, repo: &Path, docket: &Docket) -> DocketInputs {
    let mut inputs = DocketInputs {
        docket: docket.clone(),
        log: String::new(),
        archive: Vec::new(),
        arc_briefs: Vec::new(),
        sketches: Vec::new(),
        ideas: Vec::new(),
        sessions: Vec::new(),
        commits: Vec::new(),
    };
    if docket.items.is_empty() {
        return inputs;
    }

    let log_path = tugtool_core::paths::arc_log_path_at(paths, repo);
    inputs.log = fs::read_to_string(&log_path).unwrap_or_default();
    inputs.archive = crate::archive::all_entries(paths, repo);

    for entry in &inputs.archive {
        if !entry.files.iter().any(|f| f == "brief.md") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(entry.dir.join("brief.md")) {
            inputs.arc_briefs.push(ArcBrief {
                name: entry.name.clone(),
                created: Some(entry.created.clone()),
                sha256: hash_hex(&text),
                title: crate::ops::first_heading(&text),
            });
        }
    }
    for name in crate::ops::document_arcs(repo) {
        let path = crate::ops::documents_dir(repo, &name).join("brief.md");
        if let Ok(text) = fs::read_to_string(path) {
            inputs.arc_briefs.push(ArcBrief {
                name,
                created: None,
                sha256: hash_hex(&text),
                title: crate::ops::first_heading(&text),
            });
        }
    }

    inputs.sketches = crate::sketch::sketches(paths, repo)
        .into_iter()
        .map(|record| SketchFact {
            want: crate::sketch::read_version(&record, None)
                .ok()
                .and_then(|t| crate::sketch::want_of(&t)),
            id: record.id.clone(),
            versions: record.latest(),
            created: record.created.clone(),
            arc: record.arc.clone(),
            idea: record.idea.clone(),
            latest_author: record
                .latest_version()
                .map(|v| v.author)
                .unwrap_or_default(),
            briefs: record
                .briefs
                .iter()
                .map(|b| BriefVersionFact {
                    n: b.n,
                    sha256: b.sha256.clone(),
                    title: b.title.clone(),
                    path: b.path.clone(),
                    sketch_version: b.sketch_version,
                })
                .collect(),
        })
        .collect();
    inputs.ideas = crate::idea::ideas(paths, repo)
        .into_iter()
        .map(|idea| IdeaFact {
            id: idea.id,
            text: idea.text,
            created: idea.created,
            sessions: idea.sessions.into_iter().map(|s| s.uuid).collect(),
        })
        .collect();

    let filed_uuids: BTreeSet<&str> = docket
        .items
        .iter()
        .filter_map(|i| match i {
            DocketItem::Session { uuid, .. } => Some(uuid.as_str()),
            _ => None,
        })
        .collect();
    let filed_lines: BTreeSet<&str> = docket
        .items
        .iter()
        .filter_map(|i| match i {
            DocketItem::Session { line_id, .. } if !line_id.is_empty() => Some(line_id.as_str()),
            _ => None,
        })
        .collect();
    let stage_ids = stage_session_ids(&inputs.log);
    let idea_ids: BTreeSet<String> = inputs
        .ideas
        .iter()
        .flat_map(|i| i.sessions.iter().cloned())
        .collect();
    inputs.sessions = tugcore::session_index::all_entries(&paths.session_index_db)
        .into_iter()
        .filter(|e| {
            filed_lines.contains(e.line_id.as_str())
                || filed_uuids.contains(e.session_id.as_str())
                || stage_ids.contains(&e.session_id)
                || idea_ids.contains(&e.session_id)
        })
        .collect();

    // Filed commits, by name — they decide anchors.
    let filed_shas: Vec<String> = docket
        .items
        .iter()
        .filter_map(|i| match i {
            DocketItem::Commit { sha, .. } => Some(sha.clone()),
            _ => None,
        })
        .collect();
    inputs.commits = commit_facts(repo, &filed_shas);

    // HEAD's commits since the earliest session whose commits a thread shows
    // began: every filed session, and every idea's session a thread carries.
    let mut wanted: BTreeSet<String> = filed_uuids.iter().map(|u| u.to_string()).collect();
    for thread in derive_threads(&inputs) {
        wanted.extend(
            thread
                .sessions
                .into_iter()
                .filter(|s| s.stage.as_deref() == Some(SKETCH_STAGE))
                .map(|s| s.uuid),
        );
    }
    if !wanted.is_empty() {
        let earliest = inputs
            .sessions
            .iter()
            .filter(|e| filed_lines.contains(e.line_id.as_str()) || wanted.contains(&e.session_id))
            .map(|e| e.created_at_ms)
            .min();
        let mut args = vec!["HEAD".to_string()];
        if let Some(ms) = earliest {
            args.push(format!("--since={}", iso_of_millis(ms)));
        }
        for fact in git_log(repo, &args) {
            if !inputs.commits.iter().any(|c| c.sha == fact.sha) {
                inputs.commits.push(fact);
            }
        }
    }

    // Join commits of the threads this docket draws, for their subjects.
    let joins: Vec<String> = derive_threads(&inputs)
        .iter()
        .filter_map(|t| t.arc.as_ref()?.join_sha.clone())
        .filter(|sha| !inputs.commits.iter().any(|c| same_commit(&c.sha, sha)))
        .collect();
    let joined = commit_facts(repo, &joins);
    inputs.commits.extend(joined);
    inputs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::ArchiveFate;
    use std::path::PathBuf;

    const STAGE_A: &str = "11111111-1111-1111-1111-111111111111";
    const STAGE_B: &str = "22222222-2222-2222-2222-222222222222";
    const STAGE_C: &str = "33333333-3333-3333-3333-333333333333";

    fn docket(items: Vec<DocketItem>) -> Docket {
        Docket {
            version: 1,
            id: "0000abcd".into(),
            name: "Rail".into(),
            created: "2026-11-01T00:00:00Z".into(),
            project_dir: "/src/repo".into(),
            retired_at: None,
            items,
            dir: PathBuf::new(),
        }
    }

    fn arc_item(name: &str, created: &str) -> DocketItem {
        DocketItem::Arc {
            name: name.into(),
            created: created.into(),
            filed_at: "2026-11-21T00:00:00Z".into(),
        }
    }

    fn commit_item(sha: &str) -> DocketItem {
        DocketItem::Commit {
            sha: sha.into(),
            filed_at: "2026-11-21T00:00:00Z".into(),
        }
    }

    fn session_item(uuid: &str, line: &str) -> DocketItem {
        DocketItem::Session {
            uuid: uuid.into(),
            line_id: line.into(),
            filed_at: "2026-11-21T00:00:00Z".into(),
        }
    }

    fn brief_item(sha256: &str) -> DocketItem {
        DocketItem::Brief {
            snapshot: sha256[..12].into(),
            source_path: "briefs/rail-brief.md".into(),
            sha256: sha256.into(),
            title: Some("Rail".into()),
            filed_at: "2026-11-21T00:00:00Z".into(),
        }
    }

    fn entry(session: &str, line: &str, callsign: &str, at: i64) -> IndexEntry {
        IndexEntry {
            session_id: session.into(),
            line_id: line.into(),
            callsign: Some(callsign.into()),
            project_dir: "/src/repo".into(),
            project_leaf: "repo".into(),
            instance: String::new(),
            title: None,
            created_at_ms: at,
            updated_at_ms: at,
        }
    }

    fn fact(sha: &str, subject: &str, date: &str, sessions: &[&str]) -> CommitFact {
        CommitFact {
            sha: sha.into(),
            subject: subject.into(),
            session_ids: sessions.iter().map(|s| s.to_string()).collect(),
            arc_trailer: None,
            date: date.into(),
        }
    }

    const JOIN: &str = "302d43b5d1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// One arc, `rail`, joined, then its name reused for a second generation.
    fn rail_log() -> String {
        [
            "2026-11-01T00:00:00Z  rail  arc-start  brief.md",
            "2026-11-01T00:00:01Z  rail  arc-sketch  0a1b2c3d",
            &format!("2026-11-01T00:00:02Z  rail  arc-stage  devise {STAGE_A} opus"),
            &format!("2026-11-01T00:01:00Z  rail  arc-stage  implement {STAGE_B} -"),
            "2026-11-01T00:02:00Z  rail  63de5762a  Step 1: The store",
            "2026-11-01T00:02:30Z  rail  7aa1b2c3d  yield: the store; files: a; next: b",
            &format!("2026-11-01T00:03:00Z  rail  arc-stage  implement {STAGE_B} -"),
            "2026-11-01T00:04:00Z  rail  8bb2c3d4e  Step 2: The threads",
            "2026-11-01T00:05:00Z  rail  302d43b5d1  joined via card",
            "2026-11-02T00:00:00Z  rail  arc-start  brief.md",
            &format!("2026-11-02T00:00:02Z  rail  arc-stage  implement {STAGE_C} -"),
            "2026-11-02T00:02:00Z  rail  9cc3d4e5f  Step 1: Again",
        ]
        .join("\n")
            + "\n"
    }

    fn rail_inputs(items: Vec<DocketItem>) -> DocketInputs {
        DocketInputs {
            docket: docket(items),
            log: rail_log(),
            archive: vec![ArchiveEntry {
                name: "rail".into(),
                created: "2026-11-01T00:00:00Z".into(),
                archived_at: "2026-11-01T00:05:00Z".into(),
                fate: ArchiveFate::Joined,
                join_sha: Some(JOIN.into()),
                base_branch: Some("main".into()),
                sketch_id: Some("0a1b2c3d".into()),
                files: vec!["brief.md".into()],
                dir: PathBuf::new(),
            }],
            arc_briefs: vec![
                ArcBrief {
                    name: "rail".into(),
                    created: Some("2026-11-01T00:00:00Z".into()),
                    sha256: "a".repeat(64),
                    title: Some("The rail brief".into()),
                },
                ArcBrief {
                    name: "rail".into(),
                    created: None,
                    sha256: "b".repeat(64),
                    title: Some("The second rail brief".into()),
                },
            ],
            sketches: vec![SketchFact {
                id: "0a1b2c3d".into(),
                versions: 3,
                want: Some("Want a rail.".into()),
                created: "2026-11-01T00:00:01Z".into(),
                arc: Some(SketchArc {
                    name: "rail".into(),
                    created: Some("2026-11-01T00:00:00Z".into()),
                }),
                idea: None,
                latest_author: SketchAuthor::Model,
                briefs: Vec::new(),
            }],
            ideas: Vec::new(),
            sessions: vec![
                entry(STAGE_A, "line-a", "mighty-cabin", 1),
                entry(STAGE_B, "line-b", "odd-kiln", 2),
            ],
            commits: vec![fact(JOIN, "Add the rail", "2026-11-01T00:05:00Z", &[])],
        }
    }

    #[test]
    fn a_filed_arc_brings_its_sketch_brief_sessions_and_commits() {
        let threads = derive_threads(&rail_inputs(vec![arc_item("rail", "2026-11-01T00:00:00Z")]));
        assert_eq!(threads.len(), 1);
        let t = &threads[0];
        assert_eq!(t.key, "arc:rail@2026-11-01T00:00:00Z");
        let arc = t.arc.as_ref().unwrap();
        assert_eq!(arc.fate, ArcFate::Joined);
        assert_eq!(arc.join_sha.as_deref(), Some(JOIN));
        assert!(arc.filed);
        let sketch = t.sketch.as_ref().unwrap();
        assert_eq!((sketch.id.as_str(), sketch.versions), ("0a1b2c3d", 3));
        assert!(!sketch.filed);
        assert_eq!(
            t.brief.as_ref().unwrap().title.as_deref(),
            Some("The rail brief")
        );
        let sessions: Vec<(&str, Option<&str>, Option<&str>)> = t
            .sessions
            .iter()
            .map(|s| (s.uuid.as_str(), s.stage.as_deref(), s.callsign.as_deref()))
            .collect();
        assert_eq!(
            sessions,
            vec![
                (STAGE_A, Some("devise"), Some("mighty-cabin")),
                (STAGE_B, Some("implement"), Some("odd-kiln")),
            ],
            "stage sessions in log order, deduped"
        );
        let commits: Vec<(&str, &str, CommitRole)> = t
            .commits
            .iter()
            .map(|c| (c.sha.as_str(), c.subject.as_str(), c.role))
            .collect();
        assert_eq!(
            commits,
            vec![
                ("63de5762a", "Step 1: The store", CommitRole::Round),
                ("8bb2c3d4e", "Step 2: The threads", CommitRole::Round),
                (JOIN, "Add the rail", CommitRole::Join),
            ],
            "rounds from the log, the yield skipped, the join from git"
        );
    }

    #[test]
    fn filing_any_member_reaches_the_same_thread() {
        let whole = derive_threads(&rail_inputs(vec![arc_item("rail", "2026-11-01T00:00:00Z")]));
        for (item, check) in [
            (
                DocketItem::Sketch {
                    id: "0a1b2c3d".into(),
                    filed_at: "x".into(),
                },
                "sketch",
            ),
            (commit_item(JOIN), "join"),
            (commit_item("302d43b5d1"), "join"),
            (brief_item(&"a".repeat(64)), "brief"),
            (session_item(STAGE_B, "line-b"), "session"),
        ] {
            let threads = derive_threads(&rail_inputs(vec![item.clone()]));
            assert_eq!(threads.len(), 1, "{item:?}");
            let t = &threads[0];
            assert_eq!(t.key, whole[0].key, "{item:?}");
            assert!(!t.arc.as_ref().unwrap().filed);
            let filed = match check {
                "sketch" => t.sketch.as_ref().unwrap().filed,
                "join" => t
                    .commits
                    .iter()
                    .any(|c| c.role == CommitRole::Join && c.filed),
                "brief" => t.brief.as_ref().unwrap().filed,
                _ => t.sessions.iter().any(|s| s.uuid == STAGE_B && s.filed),
            };
            assert!(filed, "the filed member is marked: {item:?}");
            assert_eq!(t.commits.len(), whole[0].commits.len(), "{item:?}");
            assert_eq!(t.filed_keys, vec![item.key()], "{item:?}");
        }
    }

    #[test]
    fn a_reused_name_keeps_its_generations_apart() {
        let threads = derive_threads(&rail_inputs(vec![arc_item("rail", "2026-11-01T00:00:00Z")]));
        let t = &threads[0];
        assert!(!t.sessions.iter().any(|s| s.uuid == STAGE_C));
        assert!(!t.commits.iter().any(|c| c.sha == "9cc3d4e5f"));

        let second = derive_threads(&rail_inputs(vec![arc_item("rail", "2026-11-02T00:00:00Z")]));
        let t = &second[0];
        assert_eq!(t.arc.as_ref().unwrap().fate, ArcFate::Live);
        assert_eq!(t.sessions.len(), 1);
        assert_eq!(t.sessions[0].uuid, STAGE_C);
        assert_eq!(t.commits.len(), 1);
        assert_eq!(t.commits[0].sha, "9cc3d4e5f");
        assert!(
            t.sketch.is_none(),
            "the first generation's sketch stays there"
        );
        assert_eq!(
            t.brief.as_ref().unwrap().title.as_deref(),
            Some("The second rail brief"),
            "a live brief belongs to the newest generation"
        );
    }

    fn session_inputs(items: Vec<DocketItem>) -> DocketInputs {
        let mut inputs = rail_inputs(items);
        inputs.sessions.extend([
            entry(
                "aaaa0001-0000-0000-0000-000000000000",
                "line-main",
                "first-seg",
                100,
            ),
            entry(
                "aaaa0002-0000-0000-0000-000000000000",
                "line-main",
                "second-seg",
                200,
            ),
        ]);
        inputs.commits.extend([
            fact(
                &"c".repeat(40),
                "Second segment's commit",
                "2026-11-10T02:00:00Z",
                &["aaaa0002-0000-0000-0000-000000000000"],
            ),
            fact(
                &"d".repeat(40),
                "First segment's commit",
                "2026-11-10T01:00:00Z",
                &["aaaa0001-0000-0000-0000-000000000000"],
            ),
            fact(
                &"e".repeat(40),
                "Someone else's",
                "2026-11-10T03:00:00Z",
                &["ffff0000-0000-0000-0000-000000000000"],
            ),
        ]);
        inputs
    }

    #[test]
    fn a_filed_session_brings_every_commit_its_line_made() {
        let threads = derive_threads(&session_inputs(vec![session_item(
            "aaaa0001-0000-0000-0000-000000000000",
            "line-main",
        )]));
        assert_eq!(threads.len(), 1);
        let t = &threads[0];
        assert_eq!(t.key, "session:line-main");
        assert_eq!(t.sessions.len(), 2, "both segments of the line");
        assert!(t.sessions[0].filed && !t.sessions[1].filed);
        let subjects: Vec<&str> = t.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(
            subjects,
            vec!["First segment's commit", "Second segment's commit"],
            "newest last, and no other session's commit"
        );
        assert!(t.commits.iter().all(|c| c.role == CommitRole::Session));
        assert_eq!(
            t.filed_keys,
            vec!["session:line-main".to_string()],
            "a removal names the session by its line, not by the cell's uuid"
        );
    }

    #[test]
    fn a_lone_commit_is_its_own_thread_until_its_session_is_filed() {
        let lone = commit_item(&"c".repeat(40));
        let threads = derive_threads(&session_inputs(vec![lone.clone()]));
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].key, format!("commit:{}", "c".repeat(40)));
        assert_eq!(threads[0].commits[0].role, CommitRole::Filed);
        assert_eq!(threads[0].start, "2026-11-10T02:00:00Z");

        let folded = derive_threads(&session_inputs(vec![
            lone,
            session_item("aaaa0001-0000-0000-0000-000000000000", "line-main"),
        ]));
        assert_eq!(
            folded.len(),
            1,
            "the commit folds into the session's thread"
        );
        assert_eq!(folded[0].key, "session:line-main");
        assert!(
            folded[0]
                .commits
                .iter()
                .any(|c| c.filed && c.sha == "c".repeat(40))
        );
    }

    #[test]
    fn threads_sort_oldest_first_with_ties_by_key() {
        let mut inputs = session_inputs(vec![
            commit_item(&"e".repeat(40)),
            arc_item("rail", "2026-11-02T00:00:00Z"),
            arc_item("rail", "2026-11-01T00:00:00Z"),
            DocketItem::Commit {
                sha: "f".repeat(40),
                filed_at: "2026-11-10T03:00:00Z".into(),
            },
        ]);
        inputs.commits.push(fact(
            &"f".repeat(40),
            "Same moment",
            "2026-11-10T03:00:00Z",
            &[],
        ));
        let keys: Vec<String> = derive_threads(&inputs).into_iter().map(|t| t.key).collect();
        assert_eq!(
            keys,
            vec![
                "arc:rail@2026-11-01T00:00:00Z".to_string(),
                "arc:rail@2026-11-02T00:00:00Z".to_string(),
                format!("commit:{}", "e".repeat(40)),
                format!("commit:{}", "f".repeat(40)),
            ]
        );
    }

    #[test]
    fn a_brief_edited_after_its_arc_opened_is_its_own_thread() {
        let threads = derive_threads(&rail_inputs(vec![
            arc_item("rail", "2026-11-01T00:00:00Z"),
            brief_item(&"9".repeat(64)),
        ]));
        assert_eq!(threads.len(), 2);
        let arc = threads.iter().find(|t| t.arc.is_some()).unwrap();
        assert!(!arc.brief.as_ref().unwrap().filed);
        let own = threads.iter().find(|t| t.arc.is_none()).unwrap();
        let brief = own.brief.as_ref().unwrap();
        assert_eq!(brief.source, BriefSource::Filed);
        assert!(brief.filed);
    }

    #[test]
    fn gather_reads_a_session_lines_commits_from_the_repository() {
        use tugcore::session_index::SessionIndex;
        use tugcore::test_fixtures::git::{GitFixture, git};

        let temp = tempfile::TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        GitFixture::init(&repo);
        let paths = Paths::under(&temp.path().join("state"));
        let first = "aaaa0001-0000-0000-0000-000000000000";
        let second = "aaaa0002-0000-0000-0000-000000000000";
        let other = "ffff0000-0000-0000-0000-000000000000";
        for (subject, session) in [("One", first), ("Two", other), ("Three", second)] {
            let message = format!("{subject}\n\nTug-Session-Id: {session}");
            git(&repo, &["commit", "-q", "--allow-empty", "-m", &message]);
        }
        let index = SessionIndex::open(&paths.session_index_db).unwrap();
        for (uuid, callsign) in [(first, "first-seg"), (second, "second-seg")] {
            index
                .upsert(&entry(uuid, "line-main", callsign, 1_000))
                .unwrap();
        }

        let docket = docket(vec![session_item(first, "line-main")]);
        let inputs = gather_inputs(&paths, &repo, &docket);
        let threads = derive_threads(&inputs);
        assert_eq!(threads.len(), 1);
        let mut subjects: Vec<&str> = threads[0]
            .commits
            .iter()
            .map(|c| c.subject.as_str())
            .collect();
        // The commits share a second, so their order is the sha's.
        subjects.sort_unstable();
        assert_eq!(
            subjects,
            vec!["One", "Three"],
            "the line's commits and no other"
        );
        assert_eq!(threads[0].sessions.len(), 2);
    }

    const IDEA: &str = "1a2b3c4d";
    const SK: &str = "5e6f7a8b";
    const SKETCHER: &str = "44444444-4444-4444-4444-444444444444";
    const LIN_1: &str = "2026-11-12T00:00:00Z";
    const LIN_2: &str = "2026-11-13T00:00:00Z";

    fn idea_item(id: &str) -> DocketItem {
        DocketItem::Idea {
            id: id.into(),
            filed_at: "2026-11-21T00:00:00Z".into(),
        }
    }

    fn brief_version(n: u32, sha: char, from: u32) -> BriefVersionFact {
        BriefVersionFact {
            n,
            sha256: sha.to_string().repeat(64),
            title: format!("Lines, v{n}"),
            path: "briefs/lines-brief.md".into(),
            sketch_version: from,
        }
    }

    /// An idea, its sketch at `versions`, two brief versions (from sketch v1
    /// and v2) and one sketching session; an arc `lin` on `log` whose live
    /// `brief.md` is brief version 1 when the log names it.
    fn lineage(items: Vec<DocketItem>, log: &str, versions: u32) -> DocketInputs {
        let arc_link = log.contains("arc-sketch").then(|| SketchArc {
            name: "lin".into(),
            created: Some(LIN_1.into()),
        });
        DocketInputs {
            docket: docket(items),
            log: log.into(),
            archive: Vec::new(),
            arc_briefs: if log.is_empty() {
                Vec::new()
            } else {
                vec![ArcBrief {
                    name: "lin".into(),
                    created: None,
                    sha256: "c".repeat(64),
                    title: Some("Lines, v1".into()),
                }]
            },
            sketches: vec![SketchFact {
                id: SK.into(),
                versions,
                want: Some("Want lines of work.".into()),
                created: "2026-11-10T00:01:00Z".into(),
                arc: arc_link,
                idea: Some(IDEA.into()),
                latest_author: SketchAuthor::User,
                briefs: vec![brief_version(1, 'c', 1), brief_version(2, 'd', 2)],
            }],
            ideas: vec![IdeaFact {
                id: IDEA.into(),
                text: "Lines of work".into(),
                created: "2026-11-10T00:00:00Z".into(),
                sessions: vec![SKETCHER.into()],
            }],
            sessions: vec![entry(SKETCHER, "line-s", "busy-quill", 5)],
            commits: vec![fact(
                &"e".repeat(40),
                "Sketch the lines",
                "2026-11-10T00:30:00Z",
                &[SKETCHER],
            )],
        }
    }

    fn adopted_log() -> String {
        format!("{LIN_1}  lin  arc-start  brief.md\n2026-11-12T00:00:01Z  lin  arc-sketch  {SK}\n")
    }

    #[test]
    fn an_idea_brings_its_sketch_brief_versions_and_sessions() {
        let threads = derive_threads(&lineage(vec![idea_item(IDEA)], "", 2));
        assert_eq!(threads.len(), 1);
        let t = &threads[0];
        assert_eq!(t.key, format!("idea:{IDEA}"));
        assert_eq!(t.start, "2026-11-10T00:00:00Z");
        let idea = t.idea.as_ref().unwrap();
        assert_eq!((idea.text.as_str(), idea.filed), ("Lines of work", true));
        let sketch = t.sketch.as_ref().unwrap();
        assert_eq!(
            (sketch.id.as_str(), sketch.author),
            (SK, SketchAuthor::User)
        );
        let brief = t.brief.as_ref().unwrap();
        assert_eq!(brief.source, BriefSource::Sketch);
        assert_eq!((brief.version, brief.versions), (Some(2), 2));
        assert_eq!(brief.sketch_version, Some(2));
        assert!(!brief.stale);
        assert_eq!(brief.title.as_deref(), Some("Lines, v2"));
        assert_eq!(brief.source_path.as_deref(), Some("briefs/lines-brief.md"));
        let sessions: Vec<(&str, Option<&str>)> = t
            .sessions
            .iter()
            .map(|s| (s.uuid.as_str(), s.stage.as_deref()))
            .collect();
        assert_eq!(sessions, vec![(SKETCHER, Some(SKETCH_STAGE))]);
        assert_eq!(t.commits.len(), 1, "the sketching session's commit");
        assert_eq!(t.commits[0].role, CommitRole::Session);
        assert!(t.arc.is_none());
        assert_eq!(t.filed_keys, vec![format!("idea:{IDEA}")]);
    }

    #[test]
    fn an_adopted_sketch_draws_the_lineage_into_its_arc() {
        let items = vec![
            idea_item(IDEA),
            brief_item(&"d".repeat(64)),
            session_item(SKETCHER, "line-s"),
        ];
        let threads = derive_threads(&lineage(items, &adopted_log(), 2));
        assert_eq!(threads.len(), 1, "{threads:#?}");
        let t = &threads[0];
        assert_eq!(t.key, format!("arc:lin@{LIN_1}"));
        assert_eq!(t.idea.as_ref().map(|i| i.id.as_str()), Some(IDEA));
        let arc = t.arc.as_ref().unwrap();
        assert_eq!(arc.brief_version, Some(1));
        assert!(arc.stale, "brief version 2 has been written since");
        assert_eq!(arc.runs, 1);
        let brief = t.brief.as_ref().unwrap();
        assert_eq!(brief.source, BriefSource::Arc);
        assert_eq!((brief.version, brief.versions), (Some(2), 2));
        assert!(brief.filed, "the filed copy of version 2 rides the cell");
        assert_eq!(t.sessions[0].uuid, SKETCHER);
        assert_eq!(t.sessions[0].stage.as_deref(), Some(SKETCH_STAGE));
        assert!(t.sessions[0].filed);
        assert_eq!(t.filed_keys.len(), 3);
    }

    #[test]
    fn a_new_sketch_version_stales_the_brief_and_leaves_the_arc() {
        let before = derive_threads(&lineage(vec![idea_item(IDEA)], &adopted_log(), 2));
        let after = derive_threads(&lineage(vec![idea_item(IDEA)], &adopted_log(), 3));
        let brief = after[0].brief.as_ref().unwrap();
        assert!(brief.stale);
        assert_eq!(brief.sketch_version, Some(2));
        assert!(!before[0].brief.as_ref().unwrap().stale);
        assert_eq!(before[0].arc, after[0].arc, "the arc cell is unmoved");
    }

    #[test]
    fn an_arc_brief_never_filed_names_the_latest_brief_versions_file() {
        let threads = derive_threads(&lineage(vec![idea_item(IDEA)], &adopted_log(), 2));
        let brief = threads[0].brief.as_ref().unwrap();
        assert_eq!(brief.source, BriefSource::Arc);
        assert!(!brief.filed);
        assert_eq!(
            brief.source_path.as_deref(),
            Some("briefs/lines-brief.md"),
            "Reopen arc needs the file the latest brief version lives in"
        );
    }

    #[test]
    fn a_reopened_arc_takes_the_idea_and_its_first_run_keeps_its_own() {
        let log = format!(
            "{}2026-11-12T01:00:00Z  lin  discarded\n{LIN_2}  lin  arc-start  brief.md\n2026-11-13T00:00:01Z  lin  arc-sketch  {SK}\n",
            adopted_log()
        );
        let threads = derive_threads(&lineage(
            vec![idea_item(IDEA), arc_item("lin", LIN_1)],
            &log,
            2,
        ));
        assert_eq!(threads.len(), 2, "{threads:#?}");
        let first = threads
            .iter()
            .find(|t| t.key == format!("arc:lin@{LIN_1}"))
            .unwrap();
        let second = threads
            .iter()
            .find(|t| t.key == format!("arc:lin@{LIN_2}"))
            .unwrap();
        assert_eq!(first.filed_keys, vec![format!("arc:lin@{LIN_1}")]);
        assert_eq!(second.filed_keys, vec![format!("idea:{IDEA}")]);
        assert_eq!(second.arc.as_ref().unwrap().runs, 2);
        assert!(second.idea.is_some());
    }

    #[test]
    fn an_idea_with_no_record_stands_alone() {
        let threads = derive_threads(&lineage(vec![idea_item("0f0f0f0f")], "", 2));
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].key, "idea:0f0f0f0f");
        assert_eq!(threads[0].idea.as_ref().unwrap().text, "0f0f0f0f");
        assert!(threads[0].sketch.is_none());
    }
}
