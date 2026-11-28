//! The arc statement: a session's declared run of arcs.
//!
//! A session that lays out a run of arcs writes one `tugarcs` fence, a JSON
//! spec naming each arc, its brief, an optional label and an optional `after`
//! list; failing a fence, each line of its answer that is exactly an arc
//! command (`/arc <name> @<path>`) is read, in order, as the same thing with
//! no labels. This module reads both and checks a statement against the
//! disk, and applies one: [`state_arcs`] makes a session's queued arcs on
//! each cycle match the run it stated.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use tugcore::instance::Paths;
use tugtool_core::paths::project_state_dir_at;
use tugtool_core::session::now_iso8601;

use crate::cycle::{
    CycleEntry, CycleRecord, EntryState, NewEntry, StatedBy, add_entry_held, arc_log_text,
    cycles, entry_states, hold_cycle, is_carried, load, log_work, next_number, normal_brief,
    queued_letters, save, wait_loop,
};
use crate::error::ArcError;
use crate::log::validate_arc_name;
use crate::ops::main_repo_root;
use crate::record_lock::{LockMode, hold};
use crate::sketch::write_atomically;
use crate::work_log::{By, Privacy, WorkKind, WorkObject};

/// The fence language a statement is written under.
pub const FENCE_LANG: &str = "tugarcs";

/// The most arcs a statement holds; arcs past it are left out.
pub const MAX_ARCS: usize = 40;

/// The longest label a statement's arc should carry, in characters.
pub const MAX_LABEL: usize = 60;

/// Where a statement was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A `tugarcs` fence.
    Fence,
    /// Whole command lines of the answer's prose.
    Prose,
}

/// One arc of a statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatedArc {
    /// The arc's name.
    pub name: String,
    /// The brief's path, relative to the project root.
    pub brief: String,
    /// A short label for the arc's entry; absent, the brief's title heads it.
    #[serde(default)]
    pub label: Option<String>,
    /// The arcs this one waits on. `None` waits on the arc before it in the
    /// statement; an empty list waits on nothing.
    #[serde(default)]
    pub after: Option<Vec<String>>,
}

/// A session's declared run of arcs, in the order they are meant to run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Statement {
    pub arcs: Vec<StatedArc>,
    pub source: Source,
}

/// Parse a `tugarcs` fence's body.
///
/// The error is `<path>: <reason>`, the path naming the field at fault
/// (`$` for the whole spec, `arcs[2].name` for one field). Everything the
/// spec can be repaired from is repaired, and each repair is one warning.
pub fn parse_fence(body: &str) -> Result<(Statement, Vec<String>), String> {
    let value: Value = serde_json::from_str(body).map_err(|e| format!("$: not JSON: {e}"))?;
    let Value::Object(root) = value else {
        return Err("$: not an object".into());
    };
    let mut warnings = Vec::new();
    match root.get("tugarcs") {
        None => return Err("tugarcs: missing".into()),
        Some(v) if v.as_u64() == Some(1) => {}
        Some(_) => return Err("tugarcs: must be 1".into()),
    }
    let arcs = match root.get("arcs") {
        None => return Err("arcs: missing".into()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err("arcs: not an array".into()),
    };
    if arcs.is_empty() {
        return Err("arcs: empty".into());
    }
    for key in root.keys() {
        if key != "tugarcs" && key != "arcs" {
            warnings.push(format!("{key}: unknown key, ignored"));
        }
    }

    // Every arc is checked for drawability before any is repaired, so a
    // spec with an undrawable arc past the fortieth is still refused.
    for (i, arc) in arcs.iter().enumerate() {
        let Value::Object(obj) = arc else {
            return Err(format!("arcs[{i}]: not an object"));
        };
        for field in ["name", "brief"] {
            match obj.get(field) {
                None => return Err(format!("arcs[{i}].{field}: missing")),
                Some(Value::String(_)) => {}
                Some(_) => return Err(format!("arcs[{i}].{field}: not a string")),
            }
        }
    }
    if arcs.len() > MAX_ARCS {
        warnings.push(format!(
            "arcs: {} arcs, only the first {MAX_ARCS} are read",
            arcs.len()
        ));
    }

    let mut out: Vec<StatedArc> = Vec::new();
    let mut seen = BTreeSet::new();
    for (i, arc) in arcs.iter().take(MAX_ARCS).enumerate() {
        let obj = arc.as_object().expect("checked above");
        let name = obj["name"].as_str().expect("checked above").to_string();
        let brief = obj["brief"].as_str().expect("checked above").to_string();
        for key in obj.keys() {
            if !matches!(key.as_str(), "name" | "brief" | "label" | "after") {
                warnings.push(format!("arcs[{i}].{key}: unknown key, ignored"));
            }
        }
        if !seen.insert(name.clone()) {
            warnings.push(format!("arcs[{i}].name: {name} is given twice, left out"));
            continue;
        }
        let label = match obj.get("label") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => {
                if s.chars().count() > MAX_LABEL {
                    warnings.push(format!(
                        "arcs[{i}].label: longer than {MAX_LABEL} characters"
                    ));
                }
                Some(s.clone())
            }
            Some(_) => {
                warnings.push(format!("arcs[{i}].label: not a string, left out"));
                None
            }
        };
        let after = match obj.get("after") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => {
                let mut names = Vec::new();
                for (j, item) in items.iter().enumerate() {
                    match item.as_str() {
                        None => warnings.push(format!(
                            "arcs[{i}].after[{j}]: not a string, left out"
                        )),
                        Some(n) if n == name => warnings.push(format!(
                            "arcs[{i}].after[{j}]: {name} waits on itself, left out"
                        )),
                        Some(n) if names.iter().any(|m| m == n) => warnings.push(format!(
                            "arcs[{i}].after[{j}]: {n} is given twice, left out"
                        )),
                        Some(n) => names.push(n.to_string()),
                    }
                }
                Some(names)
            }
            Some(_) => {
                warnings.push(format!("arcs[{i}].after: not an array, left out"));
                None
            }
        };
        out.push(StatedArc {
            name,
            brief,
            label,
            after,
        });
    }

    // An `after` naming no arc of the statement may name one already on the
    // cycle, which only the apply can say; it is kept and warned of.
    let names: BTreeSet<&str> = out.iter().map(|a| a.name.as_str()).collect();
    for (i, arc) in out.iter().enumerate() {
        for n in arc.after.iter().flatten() {
            if !names.contains(n.as_str()) {
                warnings.push(format!(
                    "arcs[{i}].after: {n} is not in this statement, so it must already be on the cycle"
                ));
            }
        }
    }

    Ok((
        Statement {
            arcs: out,
            source: Source::Fence,
        },
        warnings,
    ))
}

/// A fenced code block found in an answer: its info string's first word, its
/// body, and the lines it spans, fences included.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Block {
    lang: String,
    body: String,
    first: usize,
    last: usize,
}

/// An opening or closing fence line: the fence character, its run length,
/// and what follows the run.
fn fence_line(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let run = rest.len() - rest.trim_start_matches(ch).len();
    if run < 3 {
        return None;
    }
    Some((ch, run, &rest[run..]))
}

/// Every closed fenced code block of `text`, in order. An unclosed fence is
/// not a block, and its lines are ordinary lines.
fn blocks(text: &str) -> Vec<Block> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some((ch, run, info)) = fence_line(lines[i]) else {
            i += 1;
            continue;
        };
        if ch == '`' && info.contains('`') {
            i += 1;
            continue;
        }
        let close = (i + 1..lines.len()).find(|&j| {
            fence_line(lines[j])
                .is_some_and(|(c, r, after)| c == ch && r >= run && after.trim().is_empty())
        });
        let Some(close) = close else {
            i += 1;
            continue;
        };
        out.push(Block {
            lang: info.split_whitespace().next().unwrap_or("").to_string(),
            body: lines[i + 1..close].join("\n"),
            first: i,
            last: close,
        });
        i = close + 1;
    }
    out
}

/// The arc command a line is, by the prose line rule: leading whitespace,
/// blockquote markers and one list marker removed, then one pair of
/// backticks around the whole remainder, what is left must be exactly
/// `/arc <name> @<path>`, the path optionally in backticks of its own.
fn command_line(line: &str) -> Option<(String, String)> {
    let mut rest = line.trim_start();
    while let Some(after) = rest.strip_prefix('>') {
        rest = after.trim_start_matches(' ');
    }
    rest = strip_list_marker(rest);
    let mut rest = rest.trim_end();
    if rest.len() >= 2 && rest.starts_with('`') && rest.ends_with('`') {
        rest = &rest[1..rest.len() - 1];
    }
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    let [cmd, name, path] = tokens.as_slice() else {
        return None;
    };
    if *cmd != "/arc" || validate_arc_name(name).is_err() {
        return None;
    }
    let path = path
        .strip_prefix('`')
        .and_then(|p| p.strip_suffix('`'))
        .unwrap_or(path);
    let path = path.strip_prefix('@')?;
    if path.is_empty() || path.contains('`') {
        return None;
    }
    Some((name.to_string(), path.to_string()))
}

/// `rest` past one list marker and the spaces after it, or `rest` itself.
fn strip_list_marker(rest: &str) -> &str {
    let marker_end = if rest.starts_with(['-', '*', '+']) {
        Some(1)
    } else {
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        (digits > 0 && rest[digits..].starts_with(['.', ')'])).then_some(digits + 1)
    };
    match marker_end {
        Some(end) if rest[end..].starts_with(' ') => rest[end..].trim_start_matches(' '),
        _ => rest,
    }
}

/// The spec a check was handed: the body of the fenced block `text` opens
/// with, when it is one whole fence, else `text` itself.
pub fn spec_text(text: &str) -> String {
    let trimmed = text.trim();
    if fence_line(trimmed.lines().next().unwrap_or("")).is_some()
        && let Some(block) = blocks(trimmed).into_iter().next()
    {
        return block.body;
    }
    text.to_string()
}

/// The statement an answer makes: the last `tugarcs` fence that parses,
/// else its whole command lines in order, else none.
///
/// A fence that does not parse is skipped. When any fence parsed, no prose
/// line is read; lines inside any fenced block are never read.
pub fn read_answer(text: &str) -> Option<(Statement, Vec<String>)> {
    let found = blocks(text);
    if let Some(parsed) = found
        .iter()
        .rev()
        .filter(|b| b.lang.eq_ignore_ascii_case(FENCE_LANG))
        .find_map(|b| parse_fence(&b.body).ok())
    {
        return Some(parsed);
    }
    let mut arcs: Vec<StatedArc> = Vec::new();
    let mut warnings = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if found.iter().any(|b| b.first <= i && i <= b.last) {
            continue;
        }
        let Some((name, brief)) = command_line(line) else {
            continue;
        };
        if arcs.iter().any(|a| a.name == name) {
            warnings.push(format!("{name} is given twice, left out"));
            continue;
        }
        arcs.push(StatedArc {
            name,
            brief,
            label: None,
            after: None,
        });
    }
    if arcs.len() > MAX_ARCS {
        warnings.push(format!(
            "{} arcs, only the first {MAX_ARCS} are read",
            arcs.len()
        ));
        arcs.truncate(MAX_ARCS);
    }
    (!arcs.is_empty()).then_some((
        Statement {
            arcs,
            source: Source::Prose,
        },
        warnings,
    ))
}

/// What the disk says about a statement: a warning for each arc whose name
/// is not a valid arc name and each whose brief is not a file in the
/// checkout.
pub fn check(_paths: &Paths, repo: &Path, statement: &Statement) -> Vec<String> {
    let root = main_repo_root(repo);
    let mut warnings = Vec::new();
    for arc in &statement.arcs {
        if let Err(e) = validate_arc_name(&arc.name) {
            warnings.push(format!("{}: not a valid arc name: {e}", arc.name));
        }
        if !root.join(&arc.brief).is_file() {
            warnings.push(format!("{}: no brief at {}", arc.name, arc.brief));
        }
    }
    warnings
}

/// The statement record's format version.
pub const STATEMENT_VERSION: u32 = 1;

/// The directory of statement records in the project state dir.
const STATEMENTS_DIR: &str = "statements";

/// The lock every apply of a statement holds for its whole length.
const STATEMENTS_LOCK: &str = "statements.lock";

/// One arc of a statement record: the arc as stated, its brief's record id,
/// and where it went. `cycle` and `n` are absent on a held arc.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordedArc {
    pub name: String,
    pub brief: String,
    pub brief_id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub after: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
}

impl RecordedArc {
    /// Whether the arc is held: stated, and placed on no cycle.
    pub fn is_held(&self) -> bool {
        self.cycle.is_none()
    }
}

/// A session's latest statement, as `<project_state_dir>/statements/<session>.json`
/// keeps it. A held arc is held here and nowhere else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementRecord {
    pub v: u32,
    pub session: String,
    #[serde(default)]
    pub turn: Option<u32>,
    pub at: String,
    pub source: Source,
    pub arcs: Vec<RecordedArc>,
}

impl StatementRecord {
    /// The arcs of the record that are held.
    pub fn held(&self) -> impl Iterator<Item = &RecordedArc> {
        self.arcs.iter().filter(|a| a.is_held())
    }

    /// The record read back as the statement it keeps.
    pub fn statement(&self) -> Statement {
        Statement {
            arcs: self
                .arcs
                .iter()
                .map(|a| StatedArc {
                    name: a.name.clone(),
                    brief: a.brief.clone(),
                    label: a.label.clone(),
                    after: a.after.clone(),
                })
                .collect(),
            source: self.source,
        }
    }
}

/// How a stated arc stood against the cycles when the statement was applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    /// An arc that is open or has joined carries its entry.
    Carried,
    /// Its entry was stated by another session, or queued by hand.
    Foreign,
    /// Its entry was stated by this session.
    Mine,
    /// No entry is named for it.
    New,
}

/// Where one stated arc went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum ArcOutcome {
    /// Queued as entry `n` of the cycle: named, added, or already there.
    Queued { cycle: String, n: u32 },
    /// Left exactly as it was: an entry the statement may not move.
    Untouched { cycle: String, n: u32 },
    /// Placed nowhere: none of the statement's arcs is on a cycle.
    Held,
    /// Not applied, for the reason given.
    Skipped { reason: String },
}

/// One stated arc's class and outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArcResult {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<Class>,
    #[serde(flatten)]
    pub outcome: ArcOutcome,
}

/// What an apply did as a whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatedStatus {
    /// Nothing was recorded: a private session, no session, or no arc left.
    Unrecorded,
    /// The statement is the one stored and moved nothing.
    Unchanged,
    /// The statement was recorded, with its work-log line.
    Stated,
}

/// What [`state_arcs`] did: per arc its class and outcome, and per cycle the
/// names it removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stated {
    pub status: StatedStatus,
    pub arcs: Vec<ArcResult>,
    pub removed: BTreeMap<String, Vec<String>>,
    pub warnings: Vec<String>,
}

/// `<project_state_dir>/statements`.
pub fn statements_dir(paths: &Paths, repo: &Path) -> PathBuf {
    project_state_dir_at(paths, repo).join(STATEMENTS_DIR)
}

/// Whether `session` can name a statement record: a uuid's characters,
/// lowercase hex and hyphens, at most 36 of them.
fn valid_session_id(session: &str) -> bool {
    !session.is_empty()
        && session.len() <= 36
        && session.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f' | '-'))
}

/// The stored statement of `session`, when there is one.
pub fn read_statement(paths: &Paths, repo: &Path, session: &str) -> Option<StatementRecord> {
    if !valid_session_id(session) {
        return None;
    }
    let text = fs::read_to_string(statements_dir(paths, repo).join(format!("{session}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every statement record of this checkout, by session.
pub fn statements(paths: &Paths, repo: &Path) -> Vec<StatementRecord> {
    let Ok(read) = fs::read_dir(statements_dir(paths, repo)) else {
        return Vec::new();
    };
    let mut all: Vec<StatementRecord> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str(&text).ok())
        .collect();
    all.sort_by(|a, b| a.session.cmp(&b.session));
    all
}

/// Make the session's queued arcs match `statement`, as one unit per cycle.
///
/// A fence is the whole of the session's run on each cycle it touches; a
/// prose statement of two or more arcs replaces only when it names an arc
/// the session already stated there, and a prose statement of one arc never
/// replaces. Every replaced arc's entry is removed when the statement added
/// it and returned to what it was when it only named it; an entry whose arc
/// is open or joined, one another session stated, and one queued by hand are
/// never touched. A statement none of whose arcs is on a cycle is held, in
/// the session's statement record. Nothing is written for a private session,
/// and a statement equal to the stored one that moves nothing appends no
/// line.
pub fn state_arcs(
    paths: &Paths,
    repo: &Path,
    statement: &Statement,
    by: &By,
) -> Result<Stated, ArcError> {
    apply(paths, repo, statement, by, false)
}

/// Re-apply every stored statement that holds an arc and names `arc`: the
/// door has just placed `arc`, so the rest of its list joins that cycle.
pub fn ground_statements(paths: &Paths, repo: &Path, arc: &str) -> Result<Vec<Stated>, ArcError> {
    let mut out = Vec::new();
    for record in statements(paths, repo) {
        if record.held().next().is_none() || !record.arcs.iter().any(|a| a.name == arc) {
            continue;
        }
        // A private session's statement is never stored, so this one is
        // public.
        let by = By {
            session: Some(record.session.clone()),
            turn: record.turn,
            privacy: Privacy::Public,
            segments: Vec::new(),
        };
        out.push(apply(paths, repo, &record.statement(), &by, true)?);
    }
    Ok(out)
}

/// One stated arc on its way through an apply.
struct Plan {
    arc: StatedArc,
    brief_id: String,
    brief_path: String,
    class: Class,
    /// The index of its cycle among the loaded records.
    cycle: Option<usize>,
    /// Its entry on that cycle.
    n: Option<u32>,
    skip: Option<String>,
}

impl Plan {
    fn skipped(arc: &StatedArc, reason: String) -> Plan {
        Plan {
            arc: arc.clone(),
            brief_id: String::new(),
            brief_path: String::new(),
            class: Class::New,
            cycle: None,
            n: None,
            skip: Some(reason),
        }
    }

    fn live(&self) -> bool {
        self.skip.is_none()
    }

    fn moves(&self) -> bool {
        self.live() && matches!(self.class, Class::Mine | Class::New)
    }
}

/// An entry named or added by an apply, for its `arc.queued` line.
struct Queued {
    cycle: String,
    n: u32,
    arc: String,
    brief_id: String,
    label: Option<String>,
}

fn apply(
    paths: &Paths,
    repo: &Path,
    statement: &Statement,
    by: &By,
    grounded: bool,
) -> Result<Stated, ArcError> {
    let mut out = Stated {
        status: StatedStatus::Unrecorded,
        arcs: Vec::new(),
        removed: BTreeMap::new(),
        warnings: Vec::new(),
    };
    let session = match (&by.session, by.privacy) {
        (_, Privacy::Private) | (None, _) => return Ok(out),
        (Some(s), _) => s.clone(),
    };
    if !valid_session_id(&session) {
        return Err(ArcError::Refused(format!(
            "{session} is not a session id a statement can be kept under"
        )));
    }
    let state_dir = project_state_dir_at(paths, repo);
    fs::create_dir_all(&state_dir)
        .map_err(|e| ArcError::io("could not create the state dir", &state_dir, e))?;
    let _statements = hold(&state_dir, STATEMENTS_LOCK, LockMode::Wait)?;
    let stored = read_statement(paths, repo, &session);
    let root = main_repo_root(repo);

    // Every arc that can be applied has a valid name and a brief on disk,
    // and its brief's record, before any cycle lock is taken.
    let mut plans: Vec<Plan> = Vec::new();
    for arc in &statement.arcs {
        if let Err(e) = validate_arc_name(&arc.name) {
            plans.push(Plan::skipped(arc, format!("not a valid arc name: {e}")));
            continue;
        }
        if !root.join(normal_brief(&arc.brief)).is_file() {
            plans.push(Plan::skipped(arc, format!("no brief at {}", arc.brief)));
            continue;
        }
        match crate::brief::ensure(paths, repo, &arc.brief, by) {
            Ok(found) => plans.push(Plan {
                arc: arc.clone(),
                brief_id: found.id,
                brief_path: found.path,
                class: Class::New,
                cycle: None,
                n: None,
                skip: None,
            }),
            Err(e) => plans.push(Plan::skipped(arc, e.to_string())),
        }
    }
    for p in plans.iter().filter(|p| !p.live()) {
        out.warnings.push(format!("{}: {}", p.arc.name, p.skip.clone().unwrap_or_default()));
    }
    if !plans.iter().any(Plan::live) {
        out.arcs = results(&plans, &[]);
        return Ok(out);
    }

    // Every cycle of the checkout, held in ascending id order and loaded
    // under its lock, the most recently changed first.
    let listed = cycles(paths, repo);
    let mut ids: Vec<&str> = listed.iter().map(|r| r.id.as_str()).collect();
    ids.sort_unstable();
    let mut held = Vec::new();
    for id in &ids {
        held.push(hold_cycle(paths, repo, id)?);
    }
    let mut records: Vec<CycleRecord> = listed
        .iter()
        .filter_map(|r| load(paths, repo, &r.id).ok())
        .collect();
    let log = arc_log_text(paths, repo);
    let states: Vec<BTreeMap<u32, EntryState>> = records
        .iter()
        .map(|r| entry_states(&log, r).into_iter().collect())
        .collect();
    let own = |e: &CycleEntry| e.stated_by.as_ref().is_some_and(|s| by.is_own(&s.session));

    // Classify each arc, and give it a cycle.
    for p in plans.iter_mut().filter(|p| p.skip.is_none()) {
        let name = p.arc.name.as_str();
        let mut carried = None;
        let mut open = None;
        for (ri, r) in records.iter().enumerate() {
            for e in &r.entries {
                let named = e.arc_name.as_deref() == Some(name)
                    || e.arc.as_ref().is_some_and(|l| l.name == name);
                if !named {
                    continue;
                }
                if is_carried(&log, e) {
                    carried.get_or_insert((ri, e.n));
                } else if e.arc_name.as_deref() == Some(name)
                    && !states[ri].get(&e.n).is_some_and(|s| s.is_settled())
                {
                    open.get_or_insert((ri, e.n, own(e)));
                }
            }
        }
        (p.class, p.cycle, p.n) = match (carried, open) {
            (Some((ri, n)), _) => (Class::Carried, Some(ri), Some(n)),
            (None, Some((ri, n, true))) => (Class::Mine, Some(ri), Some(n)),
            (None, Some((ri, n, false))) => (Class::Foreign, Some(ri), Some(n)),
            (None, None) => {
                let id = p.brief_id.as_str();
                let holding = records.iter().position(|r| {
                    r.entries.iter().any(|e| e.brief_id == id)
                        || r.sketches.iter().any(|s| s.brief_id.as_deref() == Some(id))
                });
                (Class::New, holding, None)
            }
        };
    }
    let anchor = plans.iter().filter(|p| p.live()).find_map(|p| p.cycle);

    let names: BTreeSet<&str> = statement.arcs.iter().map(|a| a.name.as_str()).collect();
    let stored_held: BTreeSet<String> = stored
        .iter()
        .flat_map(|s| s.held().map(|a| a.name.clone()))
        .collect();
    let mut queued: Vec<Queued> = Vec::new();
    let mut touched: BTreeSet<usize> = BTreeSet::new();
    let mut changed = false;
    let mut restates = statement.arcs.iter().any(|a| stored_held.contains(&a.name));

    if let Some(anchor) = anchor {
        for p in plans.iter_mut().filter(|p| p.live() && p.cycle.is_none()) {
            p.cycle = Some(anchor);
        }
        touched = plans.iter().filter(|p| p.live()).filter_map(|p| p.cycle).collect();
        for &ri in &touched {
            let replaces = statement.source == Source::Fence
                || (statement.arcs.len() >= 2
                    && records[ri].entries.iter().any(|e| {
                        own(e) && e.arc_name.as_deref().is_some_and(|n| names.contains(n))
                    }));
            restates |= replaces;
            let pass = CyclePass {
                paths,
                repo,
                by,
                session: &session,
                log: &log,
                states: &states[ri],
                names: &names,
                fence: statement.source == Source::Fence,
                replaces,
                ri,
            };
            let (saved, removed, mut named) =
                pass.run(&mut records[ri], &mut plans, &mut out.warnings)?;
            changed |= saved;
            if !removed.is_empty() {
                out.removed.insert(records[ri].id.clone(), removed);
            }
            queued.append(&mut named);
        }
    }
    drop(held);

    for q in &queued {
        let mut detail = serde_json::json!({ "arc": q.arc, "brief": q.brief_id });
        if let Some(label) = &q.label {
            detail["label"] = Value::String(label.clone());
        }
        log_work(
            paths,
            repo,
            WorkKind::ArcQueued,
            WorkObject::Cycle {
                cycle: q.cycle.clone(),
                n: q.n,
            },
            detail,
            by,
        );
    }

    let cycle_ids: Vec<String> = records.iter().map(|r| r.id.clone()).collect();
    out.arcs = results(&plans, &cycle_ids);
    let mut arcs: Vec<RecordedArc> = plans
        .iter()
        .filter(|p| p.live())
        .map(|p| RecordedArc {
            name: p.arc.name.clone(),
            brief: p.brief_path.clone(),
            brief_id: p.brief_id.clone(),
            label: p.arc.label.clone(),
            after: p.arc.after.clone(),
            cycle: p.n.and(p.cycle).map(|ri| cycle_ids[ri].clone()),
            n: p.cycle.and(p.n),
        })
        .collect();
    if !restates {
        // An additive list does not erase the arcs an earlier one left held.
        if let Some(s) = &stored {
            for a in s.held().filter(|a| !names.contains(a.name.as_str())) {
                arcs.push(a.clone());
            }
        }
    }
    if !changed && queued.is_empty() && stored.as_ref().is_some_and(|s| s.arcs == arcs) {
        out.status = StatedStatus::Unchanged;
        return Ok(out);
    }

    let record = StatementRecord {
        v: STATEMENT_VERSION,
        session: session.clone(),
        turn: by.turn,
        at: now_iso8601(),
        source: statement.source,
        arcs,
    };
    let dir = statements_dir(paths, repo);
    fs::create_dir_all(&dir).map_err(|e| ArcError::io("could not create the statement store", &dir, e))?;
    let json = serde_json::to_string_pretty(&record)
        .map_err(|e| ArcError::Refused(format!("could not serialize the statement: {e}")))?;
    write_atomically(
        &dir.join(format!("{session}.json")),
        (json + "\n").as_bytes(),
        "statement",
    )?;

    let mut detail = serde_json::json!({
        "arcs": statement.arcs.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
        "source": statement.source,
        "cycles": touched.iter().map(|&ri| cycle_ids[ri].as_str()).collect::<Vec<_>>(),
        "added": queued.iter().map(|q| q.arc.as_str()).collect::<Vec<_>>(),
        "removed": out.removed.values().flatten().map(String::as_str).collect::<Vec<_>>(),
        "held": record.held().map(|a| a.name.as_str()).collect::<Vec<_>>(),
    });
    if grounded {
        detail["grounded"] = Value::Bool(true);
    }
    log_work(
        paths,
        repo,
        WorkKind::ArcsStated,
        WorkObject::Stated { stated: session },
        detail,
        by,
    );
    out.status = StatedStatus::Stated;
    Ok(out)
}

/// Each plan's result, in statement order.
fn results(plans: &[Plan], cycle_ids: &[String]) -> Vec<ArcResult> {
    plans
        .iter()
        .map(|p| {
            let outcome = match (&p.skip, p.cycle, p.n) {
                (Some(reason), _, _) => ArcOutcome::Skipped {
                    reason: reason.clone(),
                },
                (None, Some(ri), Some(n)) => {
                    let cycle = cycle_ids[ri].clone();
                    match p.class {
                        Class::Carried | Class::Foreign => ArcOutcome::Untouched { cycle, n },
                        Class::Mine | Class::New => ArcOutcome::Queued { cycle, n },
                    }
                }
                _ => ArcOutcome::Held,
            };
            ArcResult {
                name: p.arc.name.clone(),
                class: p.skip.is_none().then_some(p.class),
                outcome,
            }
        })
        .collect()
}

/// One cycle's share of an apply: what it removes, names, adds and waits.
struct CyclePass<'a> {
    paths: &'a Paths,
    repo: &'a Path,
    by: &'a By,
    session: &'a str,
    log: &'a str,
    /// Each entry's state as the record was loaded.
    states: &'a BTreeMap<u32, EntryState>,
    /// Every name the statement gives.
    names: &'a BTreeSet<&'a str>,
    fence: bool,
    replaces: bool,
    /// The cycle's index among the loaded records.
    ri: usize,
}

impl CyclePass<'_> {
    fn own(&self, e: &CycleEntry) -> bool {
        e.stated_by
            .as_ref()
            .is_some_and(|s| self.by.is_own(&s.session))
    }

    fn standing(&self, e: &CycleEntry) -> bool {
        !is_carried(self.log, e)
            && e.dropped.is_none()
            && !self.states.get(&e.n).is_some_and(|s| s.is_settled())
    }

    fn stated_by(&self, added: bool) -> StatedBy {
        StatedBy {
            session: self.session.to_string(),
            turn: self.by.turn,
            added,
        }
    }

    /// Apply the plans on this cycle to `record`, and save it once when it
    /// changed. Returns whether it was saved, the names it removed, and the
    /// entries it named or added.
    fn run(
        &self,
        record: &mut CycleRecord,
        plans: &mut [Plan],
        warnings: &mut Vec<String>,
    ) -> Result<(bool, Vec<String>, Vec<Queued>), ArcError> {
        let before = record.entries.clone();
        let before_next = record.next_n;
        let own_set: BTreeSet<u32> = record
            .entries
            .iter()
            .filter(|e| self.own(e))
            .map(|e| e.n)
            .collect();
        let here = |p: &Plan, ri: usize| p.live() && p.cycle == Some(ri);

        // A mine arc whose entry holds another brief starts over as new.
        for p in plans.iter_mut().filter(|p| here(p, self.ri) && p.class == Class::Mine) {
            let entry = p.n.and_then(|n| record.entry(n));
            if entry.is_some_and(|e| e.brief_id != p.brief_id) {
                if self.replaces {
                    p.class = Class::New;
                } else {
                    warnings.push(format!(
                        "{}: queued with another brief, left as it is",
                        p.arc.name
                    ));
                    p.class = Class::Foreign;
                }
            }
        }

        // The replaced: every standing entry of this session's not named by
        // the statement, or named for an arc that starts over.
        let mut removed: BTreeSet<u32> = BTreeSet::new();
        let mut removed_names: Vec<String> = Vec::new();
        if self.replaces {
            let restarted: BTreeSet<u32> = plans
                .iter()
                .filter(|p| here(p, self.ri) && p.class == Class::New)
                .filter_map(|p| p.n)
                .collect();
            for i in 0..record.entries.len() {
                let e = &record.entries[i];
                let Some(name) = e.arc_name.clone() else {
                    continue;
                };
                if !self.own(e) || !self.standing(e) {
                    continue;
                }
                let restart = restarted.contains(&e.n);
                if self.names.contains(name.as_str()) && !restart {
                    continue;
                }
                if !restart {
                    removed_names.push(name);
                }
                if e.stated_by.as_ref().is_some_and(|s| s.added) {
                    removed.insert(e.n);
                } else {
                    let e = &mut record.entries[i];
                    e.arc_name = None;
                    e.label = None;
                    e.stated_by = None;
                    e.waits.retain(|w| !own_set.contains(w));
                }
            }
            record.entries.retain(|e| !removed.contains(&e.n));
            for p in plans.iter_mut().filter(|p| here(p, self.ri) && p.class == Class::New) {
                p.n = None;
            }
        }

        // The new: a free entry holding the brief is named, else one is added.
        let mut named: Vec<Queued> = Vec::new();
        for pi in 0..plans.len() {
            if !(here(&plans[pi], self.ri) && plans[pi].class == Class::New) {
                continue;
            }
            let label = clean_label(plans[pi].arc.label.as_deref());
            let free = record.entries.iter().position(|e| {
                e.brief_id == plans[pi].brief_id
                    && e.arc_name.is_none()
                    && e.dropped.is_none()
                    && !is_carried(self.log, e)
            });
            let n = if let Some(at) = free {
                let e = &mut record.entries[at];
                e.arc_name = Some(plans[pi].arc.name.clone());
                e.label = label.clone();
                e.stated_by = Some(self.stated_by(false));
                e.listed = true;
                e.n
            } else {
                let mut from = queued_letters(self.paths, record, &plans[pi].brief_id);
                if from.is_empty() {
                    from = plans
                        .iter()
                        .filter(|p| here(p, self.ri))
                        .find_map(|p| p.n.and_then(|n| record.entry(n)))
                        .map(|e| e.from.clone())
                        .unwrap_or_default();
                }
                if from.is_empty() {
                    from = record.sketches.first().map(|s| vec![s.letter.clone()]).unwrap_or_default();
                }
                let entry = NewEntry {
                    brief: plans[pi].brief_path.clone(),
                    from,
                    arc_name: Some(plans[pi].arc.name.clone()),
                    label: label.clone(),
                    stated_by: Some(self.stated_by(true)),
                    listed: Some(true),
                    ..NewEntry::default()
                };
                match add_entry_held(self.paths, self.repo, record, entry, self.by) {
                    Ok(n) => n,
                    Err(e) => {
                        warnings.push(format!("{}: {e}", plans[pi].arc.name));
                        plans[pi].skip = Some(e.to_string());
                        continue;
                    }
                }
            };
            plans[pi].n = Some(n);
            named.push(Queued {
                cycle: record.id.clone(),
                n,
                arc: plans[pi].arc.name.clone(),
                brief_id: plans[pi].brief_id.clone(),
                label,
            });
        }

        // The mine: a fence sets each label; a prose line has none to give.
        for p in plans.iter().filter(|p| here(p, self.ri) && p.class == Class::Mine) {
            let label = clean_label(p.arc.label.as_deref());
            if !(self.fence || label.is_some()) {
                continue;
            }
            if let Some(e) = record.entries.iter_mut().find(|e| Some(e.n) == p.n) {
                e.label = label;
            }
        }

        // The waits, in statement order.
        let order: Vec<usize> = (0..plans.len())
            .filter(|&pi| here(&plans[pi], self.ri) && plans[pi].n.is_some())
            .collect();
        let tail = record
            .entries
            .iter()
            .filter(|e| own_set.contains(&e.n) && self.standing(e))
            .filter(|e| !e.arc_name.as_deref().is_some_and(|n| self.names.contains(n)))
            .map(|e| e.n)
            .max();
        for (k, &pi) in order.iter().enumerate() {
            let p = &plans[pi];
            if !p.moves() {
                continue;
            }
            let Some(n) = p.n else { continue };
            let mut targets: Vec<u32> = match &p.arc.after {
                Some(after) => after
                    .iter()
                    .filter_map(|name| {
                        let found = order
                            .iter()
                            .map(|&j| &plans[j])
                            .find(|q| q.arc.name == *name)
                            .and_then(|q| q.n)
                            .or_else(|| entry_named(record, name, self.states));
                        if found.is_none() {
                            warnings.push(format!(
                                "{}: waits on {name}, which has no entry on cycle {}",
                                p.arc.name, record.id
                            ));
                        }
                        found
                    })
                    .collect(),
                None if k > 0 => plans[order[k - 1]].n.into_iter().collect(),
                None if !self.replaces && p.class == Class::New => tail.into_iter().collect(),
                None => Vec::new(),
            };
            targets.retain(|&t| t != n);
            targets.dedup();
            let first_kept = !self.replaces && k == 0 && p.class == Class::Mine;
            let Some(e) = record.entries.iter_mut().find(|e| e.n == n) else {
                continue;
            };
            if self.replaces {
                let mut waits: Vec<u32> = e
                    .waits
                    .iter()
                    .copied()
                    .filter(|w| !own_set.contains(w) || targets.contains(w))
                    .collect();
                for t in targets {
                    if !waits.contains(&t) {
                        waits.push(t);
                    }
                }
                e.waits = waits;
            } else if !first_kept {
                for t in targets {
                    if !e.waits.contains(&t) {
                        e.waits.push(t);
                    }
                }
            }
        }

        for e in &mut record.entries {
            e.waits.retain(|w| !removed.contains(w));
        }
        if let Some(at) = wait_loop(&record.entries) {
            warnings.push(format!(
                "cycle {} left as it was: the waits would close a loop through entry {at}",
                record.id
            ));
            record.entries = before;
            record.next_n = before_next;
            for p in plans.iter_mut().filter(|p| here(p, self.ri) && p.moves()) {
                p.skip = Some(format!("the waits would close a loop through entry {at}"));
            }
            return Ok((false, Vec::new(), Vec::new()));
        }

        let past_before = before.iter().map(|e| e.n).max().unwrap_or(0) + 1;
        record.next_n = next_number(record).max(past_before);
        let saved = record.entries != before || record.next_n != before_next;
        if saved {
            save(record)?;
        }
        Ok((saved, removed_names, named))
    }
}

/// A label as an entry keeps it: trimmed, and absent when empty.
fn clean_label(label: Option<&str>) -> Option<String> {
    label.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The entry of `record` named for `name`: an unsettled one first, else the
/// highest numbered.
fn entry_named(record: &CycleRecord, name: &str, states: &BTreeMap<u32, EntryState>) -> Option<u32> {
    let named: Vec<&CycleEntry> = record
        .entries
        .iter()
        .filter(|e| e.arc_name.as_deref() == Some(name))
        .collect();
    named
        .iter()
        .find(|e| !states.get(&e.n).is_some_and(|s| s.is_settled()))
        .or_else(|| named.iter().max_by_key(|e| e.n))
        .map(|e| e.n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn arc(name: &str, brief: &str) -> StatedArc {
        StatedArc {
            name: name.into(),
            brief: brief.into(),
            label: None,
            after: None,
        }
    }

    #[test]
    fn every_fixture_case_parses_as_recorded() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tugdeck/src/lib/__tests__/fixtures/arc-statements.json");
        let text = fs::read_to_string(&path).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert!(cases.len() >= 20, "the fixture covers every rule");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let spec = case["spec"].as_str().unwrap();
            let result = parse_fence(spec);
            if let Some(error) = case.get("error") {
                let err = result.expect_err(name);
                let path = err.split(": ").next().unwrap();
                assert_eq!(path, error.as_str().unwrap(), "{name}: {err}");
                continue;
            }
            let (statement, warnings) = result.unwrap_or_else(|e| panic!("{name}: {e}"));
            let want: Vec<StatedArc> = serde_json::from_value(case["arcs"].clone()).unwrap();
            assert_eq!(statement.arcs, want, "{name}");
            assert_eq!(statement.source, Source::Fence);
            assert_eq!(
                warnings.len() as u64,
                case["warnings"].as_u64().unwrap(),
                "{name}: {warnings:?}"
            );
        }
    }

    #[test]
    fn the_liven_line_shapes_are_read() {
        let text = "Here is the run:\n\n\
            1. `/arc liven-tooled-ground @briefs/liven-tooled-one-look-brief.md`\n\
            2. /arc liven-cast-beasts @briefs/liven-cast-animals-brief.md\n\
            > `/arc one-door @briefs/one-door-brief.md`\n\
            /arc cast-files `@briefs/x.md`\n";
        let (statement, warnings) = read_answer(text).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(statement.source, Source::Prose);
        assert_eq!(
            statement.arcs,
            vec![
                arc("liven-tooled-ground", "briefs/liven-tooled-one-look-brief.md"),
                arc("liven-cast-beasts", "briefs/liven-cast-animals-brief.md"),
                arc("one-door", "briefs/one-door-brief.md"),
                arc("cast-files", "briefs/x.md"),
            ]
        );
    }

    #[test]
    fn a_command_inside_a_sentence_is_not_a_statement() {
        for text in [
            "Arc 3 is ready to open: `/arc liven-figures-default @briefs/liven-figures-brief.md`",
            "/arc make the ring pulse",
            "/arc name",
            "- /arc name @",
            "/arc Bad-Name @briefs/x.md",
        ] {
            assert_eq!(read_answer(text), None, "{text}");
        }
    }

    #[test]
    fn a_line_inside_a_code_fence_is_not_read() {
        let text = "```bash\n/arc one @briefs/a.md\n```\n/arc two @briefs/b.md\n";
        let (statement, _) = read_answer(text).unwrap();
        assert_eq!(statement.arcs, vec![arc("two", "briefs/b.md")]);
        assert_eq!(read_answer("~~~\n/arc one @briefs/a.md\n~~~\n"), None);
    }

    #[test]
    fn a_fence_wins_over_lines() {
        let text = "/arc one @briefs/a.md\n\n```tugarcs\n\
            {\"tugarcs\": 1, \"arcs\": [{\"name\": \"two\", \"brief\": \"briefs/b.md\"}]}\n```\n";
        let (statement, _) = read_answer(text).unwrap();
        assert_eq!(statement.source, Source::Fence);
        assert_eq!(statement.arcs, vec![arc("two", "briefs/b.md")]);
    }

    #[test]
    fn the_last_fence_is_the_statement() {
        let text = "```tugarcs\n\
            {\"tugarcs\": 1, \"arcs\": [{\"name\": \"one\", \"brief\": \"briefs/a.md\"}]}\n```\n\
            ````TugArcs title\n\
            {\"tugarcs\": 1, \"arcs\": [{\"name\": \"two\", \"brief\": \"briefs/b.md\"}]}\n````\n\
            ```tugarcs\nnot json\n```\n";
        let (statement, _) = read_answer(text).unwrap();
        assert_eq!(statement.arcs, vec![arc("two", "briefs/b.md")]);
        // A fence that never parses leaves the lines to be read.
        let text = "```tugarcs\nnot json\n```\n/arc three @briefs/c.md\n";
        let (statement, _) = read_answer(text).unwrap();
        assert_eq!(statement.source, Source::Prose);
        assert_eq!(statement.arcs, vec![arc("three", "briefs/c.md")]);
    }

    #[test]
    fn an_unclosed_fence_is_not_read() {
        let text = "```tugarcs\n\
            {\"tugarcs\": 1, \"arcs\": [{\"name\": \"one\", \"brief\": \"briefs/a.md\"}]}\n";
        assert_eq!(read_answer(text), None);
        // A close shorter than the open closes nothing.
        let text = "````tugarcs\n\
            {\"tugarcs\": 1, \"arcs\": [{\"name\": \"one\", \"brief\": \"briefs/a.md\"}]}\n```\n";
        assert_eq!(read_answer(text), None);
    }

    /// The contract every session's prompt carries teaches the fence by
    /// example, so each example has to be one the parser reads clean: every
    /// `tugarcs` fence in it, and the spec its check example pipes in.
    #[test]
    fn every_example_in_the_contract_compiles_clean() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tugplug/arc-statements.md");
        let text = fs::read_to_string(&path).unwrap();
        let mut specs: Vec<String> = blocks(&text)
            .into_iter()
            .filter(|b| b.lang == FENCE_LANG)
            .map(|b| b.body)
            .collect();
        assert!(!specs.is_empty(), "the contract shows a fence");
        for block in blocks(&text).into_iter().filter(|b| b.lang == "bash") {
            if let Some((_, rest)) = block.body.split_once("<<'SPEC'\n")
                && let Some((spec, _)) = rest.split_once("\nSPEC")
            {
                specs.push(spec.to_string());
            }
        }
        assert!(specs.len() >= 2, "and a check over a spec: {specs:?}");
        for spec in &specs {
            let (statement, warnings) =
                parse_fence(spec).unwrap_or_else(|e| panic!("{e}\n{spec}"));
            assert!(warnings.is_empty(), "{warnings:?}\n{spec}");
            assert!(!statement.arcs.is_empty());
        }
    }

    #[test]
    fn a_whole_fence_handed_to_the_check_is_read_as_its_body() {
        let spec = "{\"tugarcs\": 1, \"arcs\": []}";
        assert_eq!(spec_text(spec), spec);
        assert_eq!(spec_text(&format!("\n```tugarcs\n{spec}\n```\n")), spec);
        assert_eq!(spec_text(&format!("~~~\n{spec}\n~~~")), spec);
        // An open fence is not a block, so the text is handed on whole.
        let open = format!("```tugarcs\n{spec}\n");
        assert_eq!(spec_text(&open), open);
    }

    #[test]
    fn check_warns_of_a_brief_not_on_disk() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join("briefs")).unwrap();
        fs::write(repo.join("briefs/here.md"), "# Here\n").unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        let statement = Statement {
            arcs: vec![
                arc("here", "briefs/here.md"),
                arc("gone", "briefs/gone.md"),
                arc("Bad", "briefs/here.md"),
            ],
            source: Source::Fence,
        };
        let warnings = check(&paths, &repo, &statement);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0].contains("briefs/gone.md"));
        assert!(warnings[1].starts_with("Bad: not a valid arc name"));
    }
}

#[cfg(test)]
mod apply_tests {
    use super::*;
    use crate::cycle::{PlaceArc, QueueArc, add_entry, add_sketch, create_cycle, place_arc, queue_arc};
    use crate::work_log::work_log_path;
    use tempfile::TempDir;

    const S1: &str = "0f3c1e5a-9b27-4c1d-8e36-5a7f2d4b6c90";
    const S2: &str = "81acbce8-ec2c-4686-877f-c889f083424f";

    fn scratch() -> (TempDir, PathBuf, Paths) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join("briefs")).unwrap();
        let paths = Paths::under(&temp.path().join("state"));
        (temp, repo, paths)
    }

    /// `briefs/<stem>-brief.md`, written to disk.
    fn brief(repo: &Path, stem: &str) -> String {
        let path = format!("briefs/{stem}-brief.md");
        fs::write(repo.join(&path), format!("# {stem}\n")).unwrap();
        path
    }

    /// A cycle with one sketch, A, and the sketch's id.
    fn sketched(paths: &Paths, repo: &Path) -> (String, String) {
        let id = create_cycle(paths, repo, "Run", None).unwrap().id;
        let dir = crate::ops::documents_dir(repo, "seed");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sketch.md"), "# Sketch\n\nseed\n").unwrap();
        let sketch = crate::sketch::record_arc_sketch(
            paths,
            repo,
            "seed",
            &By::none(),
            crate::sketch::Written::AtTheTime,
        )
        .unwrap()
        .id;
        assert_eq!(add_sketch(paths, repo, &id, &sketch, None).unwrap(), "A");
        (id, sketch)
    }

    /// A cycle holding brief `stem` in a free entry, as the brief skill
    /// leaves one.
    fn cycle_with(paths: &Paths, repo: &Path, stem: &str) -> String {
        let (id, _) = sketched(paths, repo);
        let path = brief(repo, stem);
        add_entry(
            paths,
            repo,
            &id,
            NewEntry {
                brief: path,
                from: vec!["A".into()],
                ..NewEntry::default()
            },
        )
        .unwrap();
        id
    }

    fn by(session: &str, turn: u32) -> By {
        By {
            session: Some(session.into()),
            turn: Some(turn),
            privacy: Privacy::Public,
            segments: Vec::new(),
        }
    }

    fn statement(source: Source, arcs: &[(&str, &str)]) -> Statement {
        Statement {
            arcs: arcs
                .iter()
                .map(|(name, stem)| StatedArc {
                    name: (*name).into(),
                    brief: format!("briefs/{stem}-brief.md"),
                    label: None,
                    after: None,
                })
                .collect(),
            source,
        }
    }

    fn record(paths: &Paths, repo: &Path, id: &str) -> CycleRecord {
        cycles(paths, repo).into_iter().find(|r| r.id == id).unwrap()
    }

    /// The queued entries of cycle `id`: named, not carried, in entry order.
    fn queued(paths: &Paths, repo: &Path, id: &str) -> Vec<CycleEntry> {
        let log = arc_log_text(paths, repo);
        record(paths, repo, id)
            .entries
            .into_iter()
            .filter(|e| e.arc_name.is_some() && !is_carried(&log, e))
            .collect()
    }

    fn names(entries: &[CycleEntry]) -> BTreeSet<String> {
        entries.iter().filter_map(|e| e.arc_name.clone()).collect()
    }

    fn held(paths: &Paths, repo: &Path, session: &str) -> BTreeSet<String> {
        read_statement(paths, repo, session)
            .map(|r| r.held().map(|a| a.name.clone()).collect())
            .unwrap_or_default()
    }

    /// Each of `chain` is queued on cycle `id`, the first waiting on no
    /// queued entry and each other on the one before, and nothing else is
    /// queued.
    fn assert_chain(paths: &Paths, repo: &Path, id: &str, chain: &[&str]) {
        let entries = queued(paths, repo, id);
        assert_eq!(
            names(&entries),
            chain.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>(),
            "queued names"
        );
        let n_of = |name: &str| {
            entries
                .iter()
                .find(|e| e.arc_name.as_deref() == Some(name))
                .unwrap()
                .n
        };
        let queued_ns: BTreeSet<u32> = entries.iter().map(|e| e.n).collect();
        for (i, name) in chain.iter().enumerate() {
            let e = entries.iter().find(|e| e.arc_name.as_deref() == Some(*name)).unwrap();
            let on: Vec<u32> = e.waits.iter().copied().filter(|w| queued_ns.contains(w)).collect();
            let want: Vec<u32> = if i == 0 { Vec::new() } else { vec![n_of(chain[i - 1])] };
            assert_eq!(on, want, "{name} waits");
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

    fn work_lines(paths: &Paths, repo: &Path) -> Vec<crate::work_log::WorkLine> {
        let text = fs::read_to_string(work_log_path(paths, repo)).unwrap_or_default();
        crate::work_log::read_lines(&text)
    }

    fn open(paths: &Paths, repo: &Path, arc: &str, brief: &str, at: &str) {
        log_append(paths, repo, &format!("{at}  {arc}  arc-start  {brief}"));
        let none = By::none();
        place_arc(
            paths,
            repo,
            PlaceArc {
                arc,
                brief,
                sketch: None,
                name: None,
                by: &none,
            },
        )
        .unwrap();
    }

    const TURN_10: [&str; 12] = [
        "liven-cast-conversation",
        "liven-cast-devices",
        "liven-cast-interface",
        "liven-cast-files",
        "liven-cast-hardware",
        "liven-cast-making",
        "liven-cast-ideas",
        "liven-cast-signs",
        "liven-cast-numbers",
        "liven-cast-media",
        "liven-cast-places",
        "liven-cast-people",
    ];

    /// The seven liven statements, in order, each as `(turn, arcs)`.
    fn liven() -> Vec<(u32, Vec<(&'static str, &'static str)>)> {
        let cast = |names: &[&'static str]| -> Vec<(&'static str, &'static str)> {
            names.iter().map(|n| (*n, "liven-rigged-cast")).collect()
        };
        let birds = ("liven-cast-birds", "liven-cast-animals");
        let beasts = ("liven-cast-beasts", "liven-cast-animals");
        let trees = ("liven-cast-trees", "liven-cast-flora");
        let flowers = ("liven-cast-flowers", "liven-cast-flora");
        let t2 = vec![
            ("liven-tooled-ground", "liven-tooled-one-look"),
            ("liven-neomod-spike", "liven-neomod-manner"),
            ("liven-prop-rig-spike", "liven-prop-rig"),
            ("liven-tooled-one-look", "liven-tooled-one-look"),
            ("liven-default-style", "liven-default-manner"),
            ("liven-neomod-style", "liven-neomod-manner"),
            ("liven-prop-rig", "liven-prop-rig"),
            ("liven-rigged-cast", "liven-rigged-cast"),
        ];
        let t4 = vec![
            ("liven-neomod-cast", "liven-neomod-cast"),
            ("liven-figures-study", "liven-figures"),
            ("liven-figures-default", "liven-figures"),
            ("liven-figures-neomod", "liven-figures"),
        ];
        let t10 = cast(&TURN_10);
        let t11 = vec![birds, beasts];
        let mut t12 = vec![birds, beasts];
        t12.extend(cast(&TURN_10));
        let mut t13 = vec![beasts];
        t13.extend(cast(&TURN_10));
        t13.extend([trees, flowers]);
        let mut t21 = cast(&TURN_10[3..]);
        t21.extend([trees, flowers]);
        vec![(2, t2), (4, t4), (10, t10), (11, t11), (12, t12), (13, t13), (21, t21)]
    }

    /// A scratch project with the nine liven briefs on disk and a cycle
    /// holding the first of them.
    fn liven_project() -> (TempDir, PathBuf, Paths, String) {
        let (t, repo, paths) = scratch();
        for stem in [
            "liven-neomod-manner",
            "liven-prop-rig",
            "liven-default-manner",
            "liven-rigged-cast",
            "liven-neomod-cast",
            "liven-figures",
            "liven-cast-animals",
            "liven-cast-flora",
        ] {
            brief(&repo, stem);
        }
        let id = cycle_with(&paths, &repo, "liven-tooled-one-look");
        (t, repo, paths, id)
    }

    #[test]
    fn the_liven_sequence_leaves_the_last_list() {
        let (_t, repo, paths, id) = liven_project();
        let mut ever: BTreeMap<u32, String> = BTreeMap::new();
        for (turn, arcs) in liven() {
            let stated = state_arcs(&paths, &repo, &statement(Source::Prose, &arcs), &by(S1, turn)).unwrap();
            assert_eq!(stated.status, StatedStatus::Stated, "turn {turn}: {stated:?}");
            let entries = queued(&paths, &repo, &id);
            for e in &entries {
                let name = e.arc_name.clone().unwrap();
                let was = ever.entry(e.n).or_insert_with(|| name.clone());
                assert_eq!(*was, name, "turn {turn}: entry {} is never given again", e.n);
            }
            let names_of = |v: &[(&str, &str)]| v.iter().map(|(n, _)| n.to_string()).collect::<Vec<_>>();
            let chain = names_of(&arcs);
            let chain: Vec<&str> = chain.iter().map(String::as_str).collect();
            match turn {
                2 => {
                    assert_eq!(entries.len(), 8);
                    assert!(held(&paths, &repo, S1).is_empty());
                }
                4 => {
                    assert_eq!(entries.len(), 8);
                    assert_eq!(held(&paths, &repo, S1).len(), 4);
                }
                10 => {
                    assert_eq!(entries.len(), 20);
                    assert_eq!(held(&paths, &repo, S1).len(), 4);
                }
                11 => {
                    assert_eq!(entries.len(), 20);
                    assert_eq!(held(&paths, &repo, S1).len(), 6);
                }
                _ => {
                    assert_chain(&paths, &repo, &id, &chain);
                    assert!(held(&paths, &repo, S1).is_empty(), "turn {turn}");
                }
            }
        }
        let record = record(&paths, &repo, &id);
        assert!(record.entries.iter().all(|e| e.dropped.is_none()), "nothing is dropped");
        assert!(chain_ok(&record));
        // The brief skill's entry is back to what it recorded.
        let first = record.entry(1).unwrap();
        assert_eq!(first.arc_name, None);
        assert_eq!(first.stated_by, None);
    }

    fn chain_ok(record: &CycleRecord) -> bool {
        crate::cycle::chain_breaks(record).is_empty()
            && record
                .entries
                .iter()
                .all(|e| e.waits.iter().all(|w| record.entry(*w).is_some()))
    }

    #[test]
    fn the_same_sequence_with_arcs_opening_never_touches_a_running_or_landed_entry() {
        let (_t, repo, paths, id) = liven_project();
        let mut kept: Vec<CycleEntry> = Vec::new();
        for (turn, arcs) in liven() {
            state_arcs(&paths, &repo, &statement(Source::Prose, &arcs), &by(S1, turn)).unwrap();
            let now = record(&paths, &repo, &id);
            for e in &kept {
                let entry = now.entry(e.n).expect("a carried entry is never removed");
                assert_eq!(entry.arc, e.arc, "turn {turn}: entry {}", e.n);
                assert_eq!(entry.arc_name, e.arc_name);
            }
            if turn == 10 {
                // Two of turn 2's arcs open before the list that drops them.
                open(&paths, &repo, "liven-neomod-spike", "briefs/liven-neomod-manner-brief.md", "2026-11-02T00:00:00Z");
                open(&paths, &repo, "liven-prop-rig-spike", "briefs/liven-prop-rig-brief.md", "2026-11-02T00:01:00Z");
                log_append(&paths, &repo, "2026-11-02T01:00:00Z  liven-prop-rig-spike  302d43b5d1  joined");
                kept = record(&paths, &repo, &id)
                    .entries
                    .iter()
                    .filter(|e| e.arc.is_some())
                    .cloned()
                    .collect();
                assert_eq!(kept.len(), 2);
            }
        }
        assert_chain(
            &paths,
            &repo,
            &id,
            &[
                "liven-cast-files",
                "liven-cast-hardware",
                "liven-cast-making",
                "liven-cast-ideas",
                "liven-cast-signs",
                "liven-cast-numbers",
                "liven-cast-media",
                "liven-cast-places",
                "liven-cast-people",
                "liven-cast-trees",
                "liven-cast-flowers",
            ],
        );
    }

    #[test]
    fn a_statement_restated_word_for_word_writes_nothing() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        let mut st = statement(Source::Fence, &[("aa", "p"), ("bb", "p"), ("cc", "p")]);
        st.arcs[1].label = Some("The second".into());
        state_arcs(&paths, &repo, &st, &by(S1, 1)).unwrap();
        let file = record(&paths, &repo, &id).dir.join(crate::cycle::CYCLE_JSON);
        let bytes = fs::read(&file).unwrap();
        let lines = work_lines(&paths, &repo).len();
        let stmt = fs::read(statements_dir(&paths, &repo).join(format!("{S1}.json"))).unwrap();

        let again = state_arcs(&paths, &repo, &st, &by(S1, 2)).unwrap();
        assert_eq!(again.status, StatedStatus::Unchanged);
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert_eq!(work_lines(&paths, &repo).len(), lines);
        assert_eq!(fs::read(statements_dir(&paths, &repo).join(format!("{S1}.json"))).unwrap(), stmt);
    }

    #[test]
    fn a_fence_replaces_a_disjoint_list_and_a_prose_list_only_adds() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p"), ("bb", "p")]), &by(S1, 1)).unwrap();
        let stated = state_arcs(&paths, &repo, &statement(Source::Fence, &[("cc", "p"), ("dd", "p")]), &by(S1, 2)).unwrap();
        assert_chain(&paths, &repo, &id, &["cc", "dd"]);
        assert_eq!(stated.removed.get(&id).cloned().unwrap_or_default().len(), 2);
        state_arcs(&paths, &repo, &statement(Source::Prose, &[("ee", "p"), ("ff", "p")]), &by(S1, 3)).unwrap();
        assert_chain(&paths, &repo, &id, &["cc", "dd", "ee", "ff"]);
    }

    #[test]
    fn a_single_command_line_naming_a_standing_arc_removes_nothing() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        let five = [("aa", "p"), ("bb", "p"), ("cc", "p"), ("dd", "p"), ("ee", "p")];
        state_arcs(&paths, &repo, &statement(Source::Fence, &five), &by(S1, 1)).unwrap();
        let before = queued(&paths, &repo, &id);
        state_arcs(&paths, &repo, &statement(Source::Prose, &[("cc", "p")]), &by(S1, 2)).unwrap();
        let after = queued(&paths, &repo, &id);
        assert_eq!(names(&after).len(), 5);
        let waits = |v: &[CycleEntry]| v.iter().find(|e| e.arc_name.as_deref() == Some("cc")).unwrap().waits.clone();
        assert_eq!(waits(&after), waits(&before));
        assert_chain(&paths, &repo, &id, &["aa", "bb", "cc", "dd", "ee"]);
    }

    #[test]
    fn a_replaced_added_entry_is_removed_and_its_number_is_never_reused() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p"), ("bb", "p")]), &by(S1, 1)).unwrap();
        let bb = queued(&paths, &repo, &id).into_iter().find(|e| e.arc_name.as_deref() == Some("bb")).unwrap().n;
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p")]), &by(S1, 2)).unwrap();
        assert!(record(&paths, &repo, &id).entry(bb).is_none(), "bb's entry is removed");
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p"), ("cc", "p")]), &by(S1, 3)).unwrap();
        let cc = queued(&paths, &repo, &id).into_iter().find(|e| e.arc_name.as_deref() == Some("cc")).unwrap().n;
        assert!(cc > bb, "cc is {cc}, bb was {bb}");
    }

    #[test]
    fn a_replaced_named_entry_goes_back_to_what_the_brief_skill_recorded() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        brief(&repo, "q");
        let before = record(&paths, &repo, &id).entry(1).cloned().unwrap();
        let mut st = statement(Source::Fence, &[("aa", "p"), ("bb", "q")]);
        st.arcs[0].label = Some("First".into());
        state_arcs(&paths, &repo, &st, &by(S1, 1)).unwrap();
        let named = record(&paths, &repo, &id).entry(1).cloned().unwrap();
        assert_eq!(named.arc_name.as_deref(), Some("aa"));
        assert!(!named.stated_by.unwrap().added);
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("bb", "q")]), &by(S1, 2)).unwrap();
        let back = record(&paths, &repo, &id).entry(1).cloned().unwrap();
        assert_eq!(back, before);
    }

    #[test]
    fn a_wait_on_a_removed_entry_is_scrubbed() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p"), ("bb", "p")]), &by(S1, 1)).unwrap();
        let none = By::none();
        queue_arc(
            &paths,
            &repo,
            QueueArc {
                arc: "by-hand",
                brief: "briefs/p-brief.md",
                cycle: Some(&id),
                label: None,
                waits: Vec::new(),
                after: Some("bb"),
                from: Vec::new(),
                by: &none,
            },
        )
        .unwrap();
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p")]), &by(S1, 2)).unwrap();
        let record = record(&paths, &repo, &id);
        let hand = record.entries.iter().find(|e| e.arc_name.as_deref() == Some("by-hand")).unwrap();
        assert!(hand.waits.is_empty(), "{:?}", hand.waits);
        assert!(chain_ok(&record));
    }

    #[test]
    fn an_entry_another_session_stated_is_never_touched() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("xx", "p"), ("yy", "p")]), &by(S2, 1)).unwrap();
        let theirs: Vec<CycleEntry> = queued(&paths, &repo, &id);
        let mut st = statement(Source::Fence, &[("xx", "p"), ("aa", "p")]);
        st.arcs[0].label = Some("Mine now".into());
        let stated = state_arcs(&paths, &repo, &st, &by(S1, 1)).unwrap();
        assert_eq!(stated.arcs[0].class, Some(Class::Foreign));
        assert!(matches!(stated.arcs[0].outcome, ArcOutcome::Untouched { .. }));
        state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p")]), &by(S1, 2)).unwrap();
        let record = record(&paths, &repo, &id);
        for e in &theirs {
            assert_eq!(record.entry(e.n), Some(e), "entry {}", e.n);
        }
    }

    #[test]
    fn an_entry_queued_by_hand_is_never_touched() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        let none = By::none();
        queue_arc(
            &paths,
            &repo,
            QueueArc {
                arc: "by-hand",
                brief: "briefs/p-brief.md",
                cycle: Some(&id),
                label: Some("Hand"),
                waits: Vec::new(),
                after: None,
                from: Vec::new(),
                by: &none,
            },
        )
        .unwrap();
        let before = record(&paths, &repo, &id);
        let stated = state_arcs(&paths, &repo, &statement(Source::Fence, &[("by-hand", "p")]), &by(S1, 1)).unwrap();
        assert_eq!(stated.arcs[0].class, Some(Class::Foreign));
        assert_eq!(record(&paths, &repo, &id).entries, before.entries);
    }

    #[test]
    fn briefs_on_no_cycle_join_the_first_ones_cycle() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        brief(&repo, "q");
        let stated = state_arcs(&paths, &repo, &statement(Source::Prose, &[("aa", "p"), ("bb", "q")]), &by(S1, 1)).unwrap();
        assert!(stated.arcs.iter().all(|a| matches!(&a.outcome, ArcOutcome::Queued { cycle, .. } if *cycle == id)));
        assert_chain(&paths, &repo, &id, &["aa", "bb"]);
    }

    #[test]
    fn a_statement_with_no_cycle_is_held_and_writes_no_entry() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        brief(&repo, "q");
        brief(&repo, "r");
        let before = record(&paths, &repo, &id);
        let stated = state_arcs(&paths, &repo, &statement(Source::Prose, &[("aa", "q"), ("bb", "r")]), &by(S1, 1)).unwrap();
        assert_eq!(stated.status, StatedStatus::Stated);
        assert!(stated.arcs.iter().all(|a| a.outcome == ArcOutcome::Held));
        assert_eq!(record(&paths, &repo, &id), before);
        assert_eq!(held(&paths, &repo, S1).len(), 2);
        let line = work_lines(&paths, &repo).pop().unwrap();
        assert_eq!(line.kind, WorkKind::ArcsStated);
        assert_eq!(line.detail["held"], serde_json::json!(["aa", "bb"]));
    }

    #[test]
    fn the_door_grounds_a_held_statement_when_one_of_its_arcs_opens() {
        let (_t, repo, paths) = scratch();
        brief(&repo, "q");
        state_arcs(&paths, &repo, &statement(Source::Prose, &[("aa", "q"), ("bb", "q")]), &by(S1, 1)).unwrap();
        assert_eq!(held(&paths, &repo, S1).len(), 2);

        let (id, sketch) = sketched(&paths, &repo);
        log_append(&paths, &repo, "2026-11-02T00:00:00Z  aa  arc-start  briefs/q-brief.md");
        let none = By::none();
        place_arc(
            &paths,
            &repo,
            PlaceArc {
                arc: "aa",
                brief: "briefs/q-brief.md",
                sketch: Some(&sketch),
                name: None,
                by: &none,
            },
        )
        .unwrap();
        let record = record(&paths, &repo, &id);
        let aa = record.entries.iter().find(|e| e.arc_name.as_deref() == Some("aa")).unwrap().n;
        let bb = record.entries.iter().find(|e| e.arc_name.as_deref() == Some("bb")).expect("bb joins the cycle");
        assert_eq!(bb.waits, [aa]);
        assert!(held(&paths, &repo, S1).is_empty());
        let line = work_lines(&paths, &repo).pop().unwrap();
        assert_eq!(line.kind, WorkKind::ArcsStated);
        assert_eq!(line.detail["grounded"], true);
        assert_eq!(line.session.as_deref(), Some(S1));
    }

    #[test]
    fn after_sets_the_waits_and_an_empty_after_waits_on_nothing() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        let mut st = statement(Source::Fence, &[("aa", "p"), ("bb", "p"), ("cc", "p")]);
        st.arcs[1].after = Some(Vec::new());
        st.arcs[2].after = Some(vec!["aa".into()]);
        state_arcs(&paths, &repo, &st, &by(S1, 1)).unwrap();
        let entries = queued(&paths, &repo, &id);
        let get = |n: &str| entries.iter().find(|e| e.arc_name.as_deref() == Some(n)).unwrap();
        assert!(get("aa").waits.is_empty());
        assert!(get("bb").waits.is_empty());
        assert_eq!(get("cc").waits, [get("aa").n]);
    }

    #[test]
    fn a_wait_loop_leaves_the_cycle_unwritten() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        let file = record(&paths, &repo, &id).dir.join(crate::cycle::CYCLE_JSON);
        let bytes = fs::read(&file).unwrap();
        let mut st = statement(Source::Fence, &[("aa", "p"), ("bb", "p")]);
        st.arcs[0].after = Some(vec!["bb".into()]);
        let stated = state_arcs(&paths, &repo, &st, &by(S1, 1)).unwrap();
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert!(stated.arcs.iter().all(|a| matches!(a.outcome, ArcOutcome::Skipped { .. })));
        assert!(stated.warnings.iter().any(|w| w.contains("loop")));
    }

    #[test]
    fn a_private_session_states_nothing() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        let before = record(&paths, &repo, &id);
        let lines = work_lines(&paths, &repo).len();
        let private = By {
            privacy: Privacy::Private,
            ..by(S1, 1)
        };
        let stated = state_arcs(&paths, &repo, &statement(Source::Fence, &[("aa", "p")]), &private).unwrap();
        assert_eq!(stated.status, StatedStatus::Unrecorded);
        assert_eq!(record(&paths, &repo, &id), before);
        assert_eq!(work_lines(&paths, &repo).len(), lines);
        assert!(!statements_dir(&paths, &repo).exists());
    }

    #[test]
    fn two_sessions_stating_at_once_lose_nothing() {
        let (_t, repo, paths) = scratch();
        let id = cycle_with(&paths, &repo, "p");
        std::thread::scope(|scope| {
            for t in 0..8 {
                let (paths, repo) = (&paths, &repo);
                scope.spawn(move || {
                    let session = format!("0000000{t}-0000-0000-0000-000000000000");
                    let a = format!("t{t}-aa");
                    let b = format!("t{t}-bb");
                    let c = format!("t{t}-cc");
                    let st = statement(Source::Fence, &[(&a, "p"), (&b, "p"), (&c, "p")]);
                    state_arcs(paths, repo, &st, &by(&session, 1)).unwrap();
                });
            }
        });
        let entries = queued(&paths, &repo, &id);
        assert_eq!(entries.len(), 24);
        let ns: BTreeSet<u32> = entries.iter().map(|e| e.n).collect();
        assert_eq!(ns.len(), 24);
        assert_eq!(statements(&paths, &repo).len(), 8);
    }
}
