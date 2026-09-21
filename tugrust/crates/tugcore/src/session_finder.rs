//! The finder — one answer to "where does this session reference point?".
//!
//! A reference is a session uuid, an 8-hex short id, a callsign, or
//! `<project>/<callsign>`, and there are exactly three verdicts it can
//! earn: it names a session **here** (this instance's own `sessions.db`),
//! one **elsewhere** on this machine (another instance's, or one whose
//! transcript is on disk in a project this instance has never opened), or
//! it is **absent** — nothing on this machine answers to it.
//!
//! Why the verdicts live in one function: the transcript pill and the
//! model's own `tugtool session find` must not disagree about whether a
//! session exists. tugcast keeps `SessionLedger::resolve_session_ids` for
//! the `here` arm, because the deck's identity stores are seeded from the
//! rich `SessionRow` that arm builds and it cannot be produced from
//! tugcore; what it does *not* keep is a second opinion about `elsewhere`
//! and `absent`, which exist only here. Arm 1 below is therefore a
//! deliberate read-only **mirror** of the ledger's arm order — narrow
//! enough to answer one question (which uuid) and pinned against the
//! original by a parity test on the tugcast side.
//!
//! The finder **never writes anything and never resumes anything**. Every
//! open is read-only, every failure is an empty answer rather than an
//! error, and a reference it cannot place is `Absent` — which is itself a
//! useful answer, because "not on this machine" is the truthful thing to
//! say about a reference minted on another one.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};

use crate::session_index::{self, IndexEntry, project_leaf_of};

/// Length of the short session id — the leading run a commit citation
/// records. Must agree with `tugchanges_core::SHORT_SESSION_ID_LEN`, which
/// tugcore cannot read (it depends on no other Tug crate).
const SHORT_SESSION_ID_LEN: usize = 8;

/// How many leading JSONL records the tree arm reads looking for a `cwd`.
const CWD_SCAN_LINES: usize = 50;

/// Which segment answers for a line. A duplicate of `RESUME_SEGMENT_ORDER`
/// in `tugcast/src/session_ledger.rs` — the two must agree, and the parity
/// test in tugcast is what says so.
const RESUME_SEGMENT_ORDER: &str = "ORDER BY (s.state = 'live') DESC,
              (NOT EXISTS (
                  SELECT 1 FROM sessions child
                  WHERE child.forked_from_session_id = s.session_id
              )) DESC,
              s.created_at DESC,
              s.rowid DESC";

/// The four columns arm 1 reads — everything the finder answers with, and
/// nothing of the rich `SessionRow` it deliberately does not rebuild.
const HERE_COLUMNS: &str = "s.session_id, s.project_dir, l.tag, l.name";
const HERE_JOINED: &str = "sessions s LEFT JOIN lines l ON l.line_id = s.line_id";
const SCAN_COLUMNS: &str = "c.session_id, c.project_dir, l.tag, l.name";
const SCAN_JOINED: &str = "external_scan_cache c LEFT JOIN lines l ON l.line_id = c.line_id";

/// Where a finding was found. `Here` is this instance's ledger; `Elsewhere`
/// is the machine-wide index or the transcripts on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    Here,
    Elsewhere,
}

/// A session the finder placed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub session_id: String,
    pub project_dir: String,
    pub callsign: Option<String>,
    pub title: Option<String>,
    /// The instance that recorded it; `None` when only the projects tree
    /// answered, which knows nothing about instances.
    pub instance: Option<String>,
    /// The transcript JSONL, when it is on disk.
    pub transcript: Option<PathBuf>,
    pub provenance: Provenance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finding {
    Found(Found),
    Absent,
}

/// The places a finder looks, injected rather than resolved, so a test can
/// point every one of them at a temp dir.
#[derive(Debug, Clone)]
pub struct FinderEnv {
    /// This instance's session ledger; `None` when there is none to read.
    pub sessions_db: Option<PathBuf>,
    pub index_db: PathBuf,
    /// `~/.claude/projects`.
    pub claude_projects_root: PathBuf,
    /// `TUG_INSTANCE_ID`, or `""` when unset.
    pub instance: String,
}

impl FinderEnv {
    /// The env this process actually runs in.
    pub fn from_process() -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        Self {
            sessions_db: crate::instance::resolve_sessions_db_path(),
            index_db: crate::instance::session_index_db_path(),
            claude_projects_root: home.join(".claude").join("projects"),
            instance: crate::instance::instance_id().unwrap_or_default(),
        }
    }
}

/// What a reference spells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    /// A full session uuid.
    Uuid,
    /// An 8-hex leading run of one.
    ShortId,
    /// A callsign — `adjective-noun`, with optional `-<Letter><digits>`
    /// fork segments.
    Callsign,
}

/// A parsed reference: what it spells, and the project half that narrows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub kind: RefKind,
    /// The spelling itself, project half removed. Lowercased for an id;
    /// as-asked for a callsign, which is a name rather than a query.
    pub needle: String,
    /// Basename of the project half, when the reference carried one.
    pub project_leaf: Option<String>,
}

impl Reference {
    /// Parse a reference, or `None` when the spelling is neither an id nor
    /// a callsign. A refusal here is what keeps free prose from reaching a
    /// query — and it is the finder's only error shape, since every other
    /// failure is an empty answer.
    pub fn parse(reference: &str) -> Option<Self> {
        let trimmed = reference.trim();
        if trimmed.is_empty() {
            return None;
        }
        // Split at the **last** `/`: a project half may be a whole path,
        // and only the basename is ever compared.
        let (project_half, tail) = match trimmed.rsplit_once('/') {
            Some((head, tail)) if !head.is_empty() => (Some(project_leaf_of(head)), tail),
            _ => (None, trimmed),
        };
        let lowered = tail.to_ascii_lowercase();
        let kind = if is_full_session_uuid(&lowered) {
            RefKind::Uuid
        } else if is_short_session_id(&lowered) {
            RefKind::ShortId
        } else if is_session_callsign(tail) {
            RefKind::Callsign
        } else {
            return None;
        };
        let needle = match kind {
            RefKind::Callsign => tail.to_string(),
            _ => lowered,
        };
        Some(Self {
            kind,
            needle,
            project_leaf: project_half,
        })
    }
}

/// Place a reference: this instance's ledger first, then the machine.
pub fn find(reference: &str, env: &FinderEnv) -> Finding {
    let Some(parsed) = Reference::parse(reference) else {
        return Finding::Absent;
    };
    if let Some(found) = find_here(&parsed, env) {
        return Finding::Found(found);
    }
    find_beyond(&parsed, env)
}

/// Arms 2 and 3 alone — the answer tugcast asks for once its own ledger has
/// missed, so the `here` arm is never run twice and never answered twice.
/// It cannot return a `Here` finding.
pub fn find_beyond_here(reference: &str, env: &FinderEnv) -> Finding {
    let Some(parsed) = Reference::parse(reference) else {
        return Finding::Absent;
    };
    find_beyond(&parsed, env)
}

fn find_beyond(parsed: &Reference, env: &FinderEnv) -> Finding {
    if let Some(found) = find_in_index(parsed, env) {
        return Finding::Found(found);
    }
    if let Some(found) = find_in_projects_tree(parsed, env) {
        return Finding::Found(found);
    }
    Finding::Absent
}

// ── Arm 1: here ──────────────────────────────────────────────────────────────

/// One arm-1 row: the uuid and the three facts a pill or a CLI line shows.
struct HereRow {
    session_id: String,
    project_dir: String,
    callsign: Option<String>,
    title: Option<String>,
}

fn here_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HereRow> {
    Ok(HereRow {
        session_id: row.get(0)?,
        project_dir: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        callsign: row.get(2)?,
        title: row.get(3)?,
    })
}

/// The read-only mirror of the ledger's five arms, in the ledger's order:
/// uuid exact; short-id segment prefix (two rows refuse) then line prefix;
/// callsign by `lines.tag`; the `external_scan_cache` fallback when
/// `sessions` had no answer; and the `minted_tags` alias arm for a callsign
/// nothing wears anymore.
///
/// A missing database, a missing table, or any sqlite error is **no
/// answer** rather than an error: an instance that has never opened a
/// session is exactly the instance a reference may be asked of, and it
/// should fall through to the machine-wide arms rather than fail.
fn find_here(parsed: &Reference, env: &FinderEnv) -> Option<Found> {
    let path = env.sessions_db.as_deref()?;
    let conn = open_read_only(path)?;
    let row = here_row_for(&conn, parsed)?;
    // The project half is the whole reason this arm can fall through on a
    // row it did find: `eucit/curly-apple` must not be answered by the
    // `curly-apple` that lives here under `tug`, because the callsign the
    // user meant belongs to a foreign ledger.
    if let Some(leaf) = &parsed.project_leaf
        && &project_leaf_of(&row.project_dir) != leaf
    {
        return None;
    }
    Some(Found {
        transcript: transcript_path(env, &row.project_dir, &row.session_id),
        session_id: row.session_id,
        project_dir: row.project_dir,
        callsign: row.callsign,
        title: row.title,
        instance: Some(env.instance.clone()),
        provenance: Provenance::Here,
    })
}

fn here_row_for(conn: &Connection, parsed: &Reference) -> Option<HereRow> {
    let needle = &parsed.needle;
    let from_sessions = match parsed.kind {
        RefKind::Uuid => query_one(
            conn,
            &format!("SELECT {HERE_COLUMNS} FROM {HERE_JOINED} WHERE s.session_id = ?1 LIMIT 1"),
            needle,
        ),
        RefKind::ShortId => {
            // `LIMIT 2` is the ambiguity probe: one row answers, two refuse.
            // The short-id shape is validated before it reaches the LIKE, so
            // the pattern carries no `%` or `_`.
            let by_segment = query_rows(
                conn,
                &format!(
                    "SELECT {HERE_COLUMNS} FROM {HERE_JOINED} \
                     WHERE s.session_id LIKE ?1 || '%' LIMIT 2"
                ),
                needle,
            );
            match by_segment.len() {
                1 => by_segment.into_iter().next(),
                // Two segments share the prefix — refuse, never guess, and
                // do not fall through to the line arm either.
                2.. => return None,
                _ => query_one(
                    conn,
                    &format!(
                        "SELECT {HERE_COLUMNS} FROM {HERE_JOINED}
                         WHERE s.line_id IN (SELECT line_id FROM lines WHERE line_id LIKE ?1 || '%')
                           AND s.state != 'failed'
                         {RESUME_SEGMENT_ORDER}
                         LIMIT 1"
                    ),
                    needle,
                ),
            }
        }
        RefKind::Callsign => query_one(
            conn,
            &format!(
                "SELECT {HERE_COLUMNS} FROM {HERE_JOINED}
                 WHERE l.tag = ?1 AND s.state != 'failed'
                 {RESUME_SEGMENT_ORDER}
                 LIMIT 1"
            ),
            needle,
        ),
    };
    if from_sessions.is_some() {
        return from_sessions;
    }
    // The eviction fallback: `sessions` has forgotten the row, but the
    // picker's scan cache may still list the transcript.
    let from_scan = match parsed.kind {
        RefKind::Uuid => query_one(
            conn,
            &format!(
                "SELECT {SCAN_COLUMNS} FROM {SCAN_JOINED} \
                 WHERE c.session_id = ?1 AND c.excluded = 0 LIMIT 1"
            ),
            needle,
        ),
        RefKind::ShortId => {
            let rows = query_rows(
                conn,
                &format!(
                    "SELECT {SCAN_COLUMNS} FROM {SCAN_JOINED} \
                     WHERE c.session_id LIKE ?1 || '%' AND c.excluded = 0 LIMIT 2"
                ),
                needle,
            );
            match rows.len() {
                1 => rows.into_iter().next(),
                _ => return None,
            }
        }
        RefKind::Callsign => {
            let rows = query_rows(
                conn,
                &format!(
                    "SELECT {SCAN_COLUMNS} FROM {SCAN_JOINED} \
                     WHERE l.tag = ?1 AND c.excluded = 0 LIMIT 2"
                ),
                needle,
            );
            match rows.len() {
                1 => rows.into_iter().next(),
                2.. => return None,
                _ => None,
            }
        }
    };
    if from_scan.is_some() {
        return from_scan;
    }
    if parsed.kind != RefKind::Callsign {
        return None;
    }
    // The alias arm: a spelling the line has spent, remembered by the
    // all-time arbiter, resolving to the session heading that line now.
    query_one(
        conn,
        &format!(
            "SELECT {HERE_COLUMNS} FROM {HERE_JOINED}
             WHERE s.line_id = (SELECT line_id FROM minted_tags WHERE tag = ?1)
               AND s.state != 'failed'
             {RESUME_SEGMENT_ORDER}
             LIMIT 1"
        ),
        needle,
    )
}

fn query_rows(conn: &Connection, sql: &str, needle: &str) -> Vec<HereRow> {
    let Ok(mut stmt) = conn.prepare(sql) else {
        // A ledger with no such table — never opened, or older than these
        // arms — is no answer, not a failure.
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![needle], here_row) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

fn query_one(conn: &Connection, sql: &str, needle: &str) -> Option<HereRow> {
    query_rows(conn, sql, needle).into_iter().next()
}

fn open_read_only(path: &Path) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

// ── Arm 2: the machine-wide index ────────────────────────────────────────────

/// The index arm. A uuid answers by key; a short id answers only when one
/// uuid carries the prefix; a callsign answers only when every row it
/// matches belongs to **one** `(instance, line_id)` group, because a
/// callsign is unique per ledger and two foreign ledgers may each hold one.
/// Two groups is a refusal, never a guess.
fn find_in_index(parsed: &Reference, env: &FinderEnv) -> Option<Found> {
    let rows: Vec<IndexEntry> = match parsed.kind {
        RefKind::Uuid => session_index::lookup_uuid(&env.index_db, &parsed.needle),
        RefKind::ShortId => session_index::lookup_prefix(&env.index_db, &parsed.needle),
        RefKind::Callsign => session_index::lookup_callsign(
            &env.index_db,
            &parsed.needle,
            parsed.project_leaf.as_deref(),
        ),
    };
    // A row this instance itself recorded that arm 1 just missed is a stale
    // index row — the ledger evicted the session — unless its transcript is
    // still on disk, in which case it is genuinely findable.
    let live: Vec<(IndexEntry, Option<PathBuf>)> = rows
        .into_iter()
        .filter_map(|row| {
            let transcript = transcript_path(env, &row.project_dir, &row.session_id);
            if row.instance == env.instance && transcript.is_none() {
                return None;
            }
            Some((row, transcript))
        })
        .collect();
    let (row, transcript) = match parsed.kind {
        RefKind::Uuid => live.into_iter().next()?,
        RefKind::ShortId => {
            let mut ids: Vec<&str> = live.iter().map(|(r, _)| r.session_id.as_str()).collect();
            ids.sort_unstable();
            ids.dedup();
            if ids.len() != 1 {
                return None;
            }
            live.into_iter().next()?
        }
        RefKind::Callsign => {
            let mut groups: Vec<(&str, &str)> = live
                .iter()
                .map(|(r, _)| (r.instance.as_str(), r.line_id.as_str()))
                .collect();
            groups.sort_unstable();
            groups.dedup();
            if groups.len() != 1 {
                return None;
            }
            // One group: its newest segment is the one that answers.
            live.into_iter()
                .max_by_key(|(r, _)| (r.updated_at_ms, r.session_id.clone()))?
        }
    };
    Some(Found {
        session_id: row.session_id,
        project_dir: row.project_dir,
        callsign: row.callsign,
        title: row.title,
        instance: Some(row.instance),
        transcript,
        provenance: Provenance::Elsewhere,
    })
}

// ── Arm 3: the transcripts on disk ───────────────────────────────────────────

/// The last arm: a uuid whose JSONL is sitting in `~/.claude/projects`
/// under a project no instance ever recorded. Only a uuid reaches it — a
/// callsign is Tug's own word for a session and the tree has never heard
/// of one, and a short id would mean reading every directory twice for an
/// ambiguous answer.
///
/// `.tug-trash` is never entered: a trashed transcript is a session the
/// user threw away, and finding it would be worse than not finding it.
fn find_in_projects_tree(parsed: &Reference, env: &FinderEnv) -> Option<Found> {
    if parsed.kind != RefKind::Uuid {
        return None;
    }
    let file_name = format!("{}.jsonl", parsed.needle);
    let entries = std::fs::read_dir(&env.claude_projects_root).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if entry.file_name() == ".tug-trash" || !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&file_name);
        if !candidate.is_file() {
            continue;
        }
        // The transcript's own `cwd` is the project dir; when no record
        // carries one, the encoded directory name is the best name there
        // is, and a finding with an odd-looking project is still a finding.
        let project_dir = cwd_from_transcript(&candidate)
            .unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into());
        return Some(Found {
            session_id: parsed.needle.clone(),
            project_dir,
            callsign: None,
            title: None,
            instance: None,
            transcript: Some(candidate),
            provenance: Provenance::Elsewhere,
        });
    }
    None
}

/// The `cwd` of the first leading record that carries one. Bounded at
/// [`CWD_SCAN_LINES`] records: a transcript is unbounded, and a file whose
/// first fifty records name no cwd is not about to.
fn cwd_from_transcript(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(CWD_SCAN_LINES) {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(|c| c.as_str())
            && !cwd.is_empty()
        {
            return Some(cwd.to_string());
        }
    }
    None
}

/// `<root>/<encode(project_dir)>/<uuid>.jsonl`, when it is on disk.
fn transcript_path(env: &FinderEnv, project_dir: &str, session_id: &str) -> Option<PathBuf> {
    if project_dir.is_empty() {
        return None;
    }
    let path = env
        .claude_projects_root
        .join(encode_claude_project_name(project_dir))
        .join(format!("{session_id}.jsonl"));
    path.is_file().then_some(path)
}

// ── The grammar, copied from tugcast ─────────────────────────────────────────

/// Encode a project dir into claude's per-project directory name — every
/// character that is not ASCII alphanumeric or `-` becomes `-`. A copy of
/// `encode_claude_project_name` in `tugcast/src/session_ledger.rs`.
pub fn encode_claude_project_name(project_dir: &str) -> String {
    project_dir
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// A copy of `is_full_session_uuid` in `tugcast/src/session_ledger.rs`.
fn is_full_session_uuid(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = s.split('-');
    for len in groups {
        match parts.next() {
            Some(part) if part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()) => {}
            _ => return false,
        }
    }
    parts.next().is_none()
}

/// A copy of `is_short_session_id` in `tugcast/src/session_ledger.rs`.
fn is_short_session_id(s: &str) -> bool {
    s.len() == SHORT_SESSION_ID_LEN && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A copy of `is_session_callsign` in `tugcast/src/session_ledger.rs` —
/// `adjective-noun`, extended by `-<Letter><digits>` fork segments, matched
/// case-sensitively because a callsign is a name rather than a query.
fn is_session_callsign(s: &str) -> bool {
    const MAX_LEN: usize = 64;
    if s.is_empty() || s.len() > MAX_LEN {
        return false;
    }
    let mut segments = s.split('-');
    let head = [segments.next(), segments.next()];
    for word in head {
        match word {
            Some(w) if !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase()) => {}
            _ => return false,
        }
    }
    segments.all(|seg| {
        let mut bytes = seg.bytes();
        matches!(bytes.next(), Some(b) if b.is_ascii_uppercase())
            && bytes.len() > 0
            && bytes.all(|b| b.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_index::{IndexEntry, SessionIndex};

    const UUID_A: &str = "0f3c1111-2222-3333-4444-555566667777";
    const UUID_B: &str = "abcd8888-2222-3333-4444-555566667777";

    struct Fixture {
        _dir: tempfile::TempDir,
        env: FinderEnv,
    }

    impl Fixture {
        /// A temp dir holding a hand-built `sessions.db` with just the
        /// columns the arms read, an index db, and a fake projects root.
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let sessions = dir.path().join("sessions.db");
            let conn = crate::ledger_db::open(&sessions).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (
                     session_id TEXT PRIMARY KEY, line_id TEXT, project_dir TEXT,
                     state TEXT, created_at INTEGER, forked_from_session_id TEXT);
                 CREATE TABLE lines (line_id TEXT PRIMARY KEY, tag TEXT, name TEXT);
                 CREATE TABLE minted_tags (tag TEXT PRIMARY KEY, line_id TEXT);
                 CREATE TABLE external_scan_cache (
                     session_id TEXT PRIMARY KEY, project_dir TEXT, line_id TEXT,
                     excluded INTEGER NOT NULL DEFAULT 0);",
            )
            .unwrap();
            drop(conn);
            let projects = dir.path().join("projects");
            std::fs::create_dir_all(&projects).unwrap();
            let env = FinderEnv {
                sessions_db: Some(sessions),
                index_db: dir.path().join("session_index.db"),
                claude_projects_root: projects,
                instance: "debug-here".into(),
            };
            Self { _dir: dir, env }
        }

        fn ledger(&self) -> Connection {
            crate::ledger_db::open(self.env.sessions_db.as_ref().unwrap()).unwrap()
        }

        fn line(&self, line_id: &str, tag: &str, name: Option<&str>) {
            self.ledger()
                .execute(
                    "INSERT INTO lines (line_id, tag, name) VALUES (?1, ?2, ?3)",
                    params![line_id, tag, name],
                )
                .unwrap();
        }

        fn session(&self, uuid: &str, line_id: &str, project_dir: &str, state: &str) {
            self.session_forked(uuid, line_id, project_dir, state, None, 0);
        }

        fn session_forked(
            &self,
            uuid: &str,
            line_id: &str,
            project_dir: &str,
            state: &str,
            forked_from: Option<&str>,
            created_at: i64,
        ) {
            self.ledger()
                .execute(
                    "INSERT INTO sessions
                        (session_id, line_id, project_dir, state, created_at, forked_from_session_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![uuid, line_id, project_dir, state, created_at, forked_from],
                )
                .unwrap();
        }

        fn index(&self) -> SessionIndex {
            SessionIndex::open(&self.env.index_db).unwrap()
        }

        fn index_row(&self, uuid: &str, callsign: &str, project_dir: &str, instance: &str) {
            self.index_row_on_line(uuid, callsign, project_dir, instance, "line-x", 1_000);
        }

        fn index_row_on_line(
            &self,
            uuid: &str,
            callsign: &str,
            project_dir: &str,
            instance: &str,
            line_id: &str,
            updated_at_ms: i64,
        ) {
            self.index()
                .upsert(&IndexEntry {
                    session_id: uuid.into(),
                    line_id: line_id.into(),
                    callsign: Some(callsign.into()),
                    project_dir: project_dir.into(),
                    project_leaf: String::new(),
                    instance: instance.into(),
                    title: None,
                    created_at_ms: 1,
                    updated_at_ms,
                })
                .unwrap();
        }

        /// Write a transcript into the fake projects root, as claude would.
        fn transcript(&self, project_dir: &str, uuid: &str, cwd: Option<&str>) -> PathBuf {
            let dir = self
                .env
                .claude_projects_root
                .join(encode_claude_project_name(project_dir));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("{uuid}.jsonl"));
            let body = match cwd {
                Some(cwd) => format!("{{\"type\":\"user\",\"cwd\":\"{cwd}\"}}\n"),
                None => "{\"type\":\"user\"}\n".to_string(),
            };
            std::fs::write(&path, body).unwrap();
            path
        }

        fn trashed_transcript(&self, uuid: &str) {
            let dir = self.env.claude_projects_root.join(".tug-trash");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{uuid}.jsonl")), "{}\n").unwrap();
        }

        fn find(&self, reference: &str) -> Finding {
            super::find(reference, &self.env)
        }
    }

    fn found(finding: Finding) -> Found {
        match finding {
            Finding::Found(f) => f,
            Finding::Absent => panic!("expected a finding, got Absent"),
        }
    }

    // ── The grammar ──────────────────────────────────────────────────────

    #[test]
    fn the_grammar_classifies_every_spelling() {
        let uuid = Reference::parse(UUID_A).unwrap();
        assert_eq!(uuid.kind, RefKind::Uuid);
        assert_eq!(uuid.project_leaf, None);

        assert_eq!(Reference::parse("0f3c1111").unwrap().kind, RefKind::ShortId);
        assert_eq!(
            Reference::parse("curly-apple").unwrap().kind,
            RefKind::Callsign
        );
        assert_eq!(
            Reference::parse("curly-apple-A1-B2").unwrap().kind,
            RefKind::Callsign
        );

        let split = Reference::parse("/u/src/eucit/curly-apple").unwrap();
        assert_eq!(split.kind, RefKind::Callsign);
        assert_eq!(split.needle, "curly-apple");
        assert_eq!(split.project_leaf.as_deref(), Some("eucit"));

        // A uuid keeps its case-free reading; a callsign is matched as asked.
        assert_eq!(
            Reference::parse(&UUID_A.to_uppercase()).unwrap().needle,
            UUID_A
        );

        assert!(Reference::parse("not a reference").is_none());
        assert!(Reference::parse("").is_none());
        assert!(Reference::parse("Curly-Apple").is_none());
    }

    // ── Arm 1: here ──────────────────────────────────────────────────────

    #[test]
    fn a_uuid_resolves_here() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", Some("Some Title"));
        fx.session(UUID_A, "line-1", "/u/src/tug", "live");

        let f = found(fx.find(UUID_A));
        assert_eq!(f.provenance, Provenance::Here);
        assert_eq!(f.session_id, UUID_A);
        assert_eq!(f.project_dir, "/u/src/tug");
        assert_eq!(f.callsign.as_deref(), Some("curly-apple"));
        assert_eq!(f.title.as_deref(), Some("Some Title"));
        assert_eq!(f.instance.as_deref(), Some("debug-here"));
    }

    #[test]
    fn a_short_id_resolves_here_and_two_of_them_refuse() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", None);
        fx.session(UUID_A, "line-1", "/u/src/tug", "live");
        assert_eq!(found(fx.find("0f3c1111")).session_id, UUID_A);

        // A second segment sharing the prefix is an ambiguity, and the
        // ambiguity is a refusal rather than a guess.
        fx.session(
            "0f3c1111-9999-3333-4444-555566667777",
            "line-1",
            "/u/src/tug",
            "closed",
        );
        assert_eq!(fx.find("0f3c1111"), Finding::Absent);
    }

    #[test]
    fn a_line_prefix_resolves_here_when_no_segment_does() {
        let fx = Fixture::new();
        fx.line("abcdef01-line", "curly-apple", None);
        fx.session(UUID_A, "abcdef01-line", "/u/src/tug", "live");
        assert_eq!(found(fx.find("abcdef01")).session_id, UUID_A);
    }

    #[test]
    fn a_callsign_resolves_here() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", None);
        fx.session(UUID_A, "line-1", "/u/src/tug", "live");
        assert_eq!(found(fx.find("curly-apple")).session_id, UUID_A);
    }

    #[test]
    fn an_alias_resolves_here_through_the_arbiter() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", None);
        fx.session(UUID_A, "line-1", "/u/src/tug", "live");
        fx.ledger()
            .execute(
                "INSERT INTO minted_tags (tag, line_id) VALUES ('spent-name', 'line-1')",
                [],
            )
            .unwrap();
        assert_eq!(found(fx.find("spent-name")).session_id, UUID_A);
    }

    #[test]
    fn the_scan_cache_answers_when_sessions_has_forgotten() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", Some("Scanned"));
        fx.ledger()
            .execute(
                "INSERT INTO external_scan_cache (session_id, project_dir, line_id, excluded)
                 VALUES (?1, '/u/src/tug', 'line-1', 0)",
                params![UUID_A],
            )
            .unwrap();

        let f = found(fx.find(UUID_A));
        assert_eq!(f.provenance, Provenance::Here);
        assert_eq!(f.callsign.as_deref(), Some("curly-apple"));
        assert_eq!(f.title.as_deref(), Some("Scanned"));
    }

    #[test]
    fn a_two_segment_line_answers_with_the_live_one_then_the_childless_one() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", None);
        fx.session_forked(UUID_A, "line-1", "/u/src/tug", "closed", None, 100);
        fx.session_forked(UUID_B, "line-1", "/u/src/tug", "live", Some(UUID_A), 200);
        assert_eq!(
            found(fx.find("curly-apple")).session_id,
            UUID_B,
            "live first"
        );

        // With nothing live, the segment nothing forked from is the tip.
        fx.ledger()
            .execute("UPDATE sessions SET state = 'closed'", [])
            .unwrap();
        assert_eq!(
            found(fx.find("curly-apple")).session_id,
            UUID_B,
            "then the childless segment"
        );
    }

    #[test]
    fn a_missing_ledger_is_no_answer_rather_than_an_error() {
        let mut fx = Fixture::new();
        fx.env.sessions_db = Some(fx.env.claude_projects_root.join("nowhere.db"));
        assert_eq!(fx.find(UUID_A), Finding::Absent);
        fx.env.sessions_db = None;
        assert_eq!(fx.find(UUID_A), Finding::Absent);
    }

    // ── Arm 2: the index ─────────────────────────────────────────────────

    #[test]
    fn a_uuid_only_in_the_index_is_elsewhere_with_its_instance() {
        let fx = Fixture::new();
        fx.index_row(UUID_A, "curly-apple", "/u/src/eucit", "debug-other");

        let f = found(fx.find(UUID_A));
        assert_eq!(f.provenance, Provenance::Elsewhere);
        assert_eq!(f.project_dir, "/u/src/eucit");
        assert_eq!(f.instance.as_deref(), Some("debug-other"));
        assert_eq!(f.transcript, None, "no transcript on this fake disk");
    }

    #[test]
    fn the_project_half_falls_arm_one_through_to_the_index() {
        let fx = Fixture::new();
        // `curly-apple` exists here, but under `tug`, not `eucit`.
        fx.line("line-1", "curly-apple", None);
        fx.session(UUID_A, "line-1", "/u/src/tug", "live");
        fx.index_row(UUID_B, "curly-apple", "/u/src/eucit", "debug-other");

        let f = found(fx.find("eucit/curly-apple"));
        assert_eq!(f.provenance, Provenance::Elsewhere);
        assert_eq!(f.session_id, UUID_B);

        // The same reference under the project it does live in stays here.
        assert_eq!(
            found(fx.find("tug/curly-apple")).provenance,
            Provenance::Here
        );
    }

    #[test]
    fn one_callsign_under_two_foreign_groups_refuses() {
        let fx = Fixture::new();
        fx.index_row_on_line(
            UUID_A,
            "curly-apple",
            "/u/src/eucit",
            "debug-a",
            "line-1",
            10,
        );
        fx.index_row_on_line(UUID_B, "curly-apple", "/u/src/tug", "debug-b", "line-2", 20);
        assert_eq!(
            fx.find("curly-apple"),
            Finding::Absent,
            "two groups, no guess"
        );

        // Naming the project narrows it to one group, and it answers.
        assert_eq!(found(fx.find("eucit/curly-apple")).session_id, UUID_A);
    }

    #[test]
    fn one_group_answers_with_its_newest_segment() {
        let fx = Fixture::new();
        fx.index_row_on_line(
            UUID_A,
            "curly-apple",
            "/u/src/eucit",
            "debug-a",
            "line-1",
            10,
        );
        fx.index_row_on_line(
            UUID_B,
            "curly-apple",
            "/u/src/eucit",
            "debug-a",
            "line-1",
            99,
        );
        assert_eq!(found(fx.find("curly-apple")).session_id, UUID_B);
    }

    #[test]
    fn a_stale_row_this_instance_wrote_is_skipped() {
        let fx = Fixture::new();
        // Recorded by *this* instance, gone from its ledger, no transcript:
        // the index row outlived the session, so it answers for nothing.
        fx.index_row(UUID_A, "curly-apple", "/u/src/tug", "debug-here");
        assert_eq!(fx.find(UUID_A), Finding::Absent);

        // The same row with the transcript still on disk is findable.
        let path = fx.transcript("/u/src/tug", UUID_A, Some("/u/src/tug"));
        let f = found(fx.find(UUID_A));
        assert_eq!(f.provenance, Provenance::Elsewhere);
        assert_eq!(f.transcript.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn a_short_id_matching_two_index_uuids_refuses() {
        let fx = Fixture::new();
        fx.index_row(
            "abcd8888-1111-3333-4444-555566667777",
            "one",
            "/u/src/a",
            "debug-a",
        );
        fx.index_row(UUID_B, "two", "/u/src/b", "debug-a");
        assert_eq!(fx.find("abcd8888"), Finding::Absent);
    }

    // ── Arm 3: the projects tree ─────────────────────────────────────────

    #[test]
    fn a_transcript_on_disk_alone_is_elsewhere_with_no_instance() {
        let fx = Fixture::new();
        let path = fx.transcript("/u/src/eucit", UUID_A, Some("/u/src/eucit"));

        let f = found(fx.find(UUID_A));
        assert_eq!(f.provenance, Provenance::Elsewhere);
        assert_eq!(f.instance, None);
        assert_eq!(
            f.project_dir, "/u/src/eucit",
            "the cwd the transcript names"
        );
        assert_eq!(f.transcript.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn a_transcript_with_no_cwd_falls_back_to_the_encoded_directory_name() {
        let fx = Fixture::new();
        fx.transcript("/u/src/eucit", UUID_A, None);
        assert_eq!(found(fx.find(UUID_A)).project_dir, "-u-src-eucit");
    }

    #[test]
    fn a_trashed_transcript_is_never_found() {
        let fx = Fixture::new();
        fx.trashed_transcript(UUID_A);
        assert_eq!(fx.find(UUID_A), Finding::Absent);
    }

    #[test]
    fn a_callsign_never_reaches_the_tree_arm() {
        let fx = Fixture::new();
        fx.transcript("/u/src/eucit", UUID_A, Some("/u/src/eucit"));
        assert_eq!(fx.find("curly-apple"), Finding::Absent);
    }

    // ── Absence, and the beyond-here door ────────────────────────────────

    #[test]
    fn a_fabricated_uuid_is_absent() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", None);
        fx.session(UUID_A, "line-1", "/u/src/tug", "live");
        assert_eq!(
            fx.find("deadbeef-1111-2222-3333-444455556666"),
            Finding::Absent
        );
        assert_eq!(fx.find("not a reference at all"), Finding::Absent);
    }

    #[test]
    fn find_beyond_here_never_returns_here() {
        let fx = Fixture::new();
        fx.line("line-1", "curly-apple", None);
        fx.session(UUID_A, "line-1", "/u/src/tug", "live");

        // `find` places it here; `find_beyond_here` skips that arm entirely.
        assert_eq!(found(fx.find(UUID_A)).provenance, Provenance::Here);
        assert_eq!(find_beyond_here(UUID_A, &fx.env), Finding::Absent);
        assert_eq!(find_beyond_here("curly-apple", &fx.env), Finding::Absent);

        // What it does answer is the machine-wide arm.
        fx.index_row(UUID_B, "zany-ghost", "/u/src/eucit", "debug-other");
        let f = found(find_beyond_here(UUID_B, &fx.env));
        assert_eq!(f.provenance, Provenance::Elsewhere);
    }

    #[test]
    fn the_encoder_matches_claudes_directory_naming() {
        assert_eq!(encode_claude_project_name("/u/src/tug"), "-u-src-tug");
        assert_eq!(
            encode_claude_project_name("/Users/k/My Proj_1"),
            "-Users-k-My-Proj-1"
        );
    }
}
