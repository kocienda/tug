//! `tugtool host restore-names` — put back the session rows a lost name
//! needs to be reachable.
//!
//! A user-set name lives on the `lines` table and outlives every session id
//! the line wears. Every listing path, though, walked `sessions` — so when a
//! per-workspace cap deleted a line's last segment, the name stayed in the
//! database, perfectly intact, with nothing left that could reach it. Ten
//! lines on one machine ended up in that state before anybody noticed.
//!
//! The cap is gone and no automatic delete can take a named line's last
//! segment any more, but neither of those brings back a row already deleted.
//! This does, and it is deliberately **a verb the user runs rather than a
//! startup migration**: it writes to a live ledger, and a silent migration on
//! every machine to repair ten rows on one is the wrong blast radius.
//!
//! Nothing here is inferred. The session a stranded line owned is read out of
//! `minted_tags`, which recorded the pairing when the callsign was claimed
//! and is append-only by Spec S08 — so a spent callsign is never re-minted
//! and the join is a durable record rather than a guess. The `facts` ledger
//! is consulted as an independent second source, and the transcript must be
//! on disk: a restored row whose JSONL is gone would be a session the picker
//! offers and cannot open, which is worse than the loss it repairs. A line
//! whose transcript has gone keeps its name and stays unrestored, and the
//! report says so rather than fabricating a row.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

/// What the verb decided about one stranded named line.
struct Candidate {
    line_id: String,
    tag: String,
    name: String,
    project_dir: String,
    created_at: i64,
    last_used_at: i64,
    /// The session `minted_tags` names for this line, newest mint first.
    session_id: String,
    /// Where the transcript is, when it is anywhere.
    jsonl: Option<PathBuf>,
    /// How many `facts` rows name that session — the corroborating read.
    fact_count: i64,
}

impl Candidate {
    fn restorable(&self) -> bool {
        self.jsonl.is_some()
    }
}

/// Every `sessions.db` this machine holds, or just the one the caller named.
fn ledgers(db: Option<&Path>) -> Result<Vec<PathBuf>, String> {
    if let Some(path) = db {
        return Ok(vec![path.to_path_buf()]);
    }
    let root = tugcore::instances_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Err(format!("no instances directory at {}", root.display()));
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path().join("sessions.db"))
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    Ok(found)
}

/// `~/.claude/projects/*/<session_id>.jsonl`, found by walking rather than by
/// re-deriving claude's lossy `/`→`-` directory encoding. The walk is right
/// for a repair specifically because the encoding is where this has gone
/// wrong before: we hold the session id, and the id is the filename.
fn find_transcript(projects_root: &Path, session_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(projects_root).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let candidate = entry.path().join(format!("{session_id}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// The stranded named lines in one ledger, each resolved as far as the
/// records allow.
fn survey(conn: &Connection, projects_root: &Path) -> Result<Vec<Candidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.line_id, l.tag, l.name, l.project_dir, l.created_at, l.last_used_at,
                    m.session_id
             FROM lines l
             JOIN minted_tags m ON m.line_id = l.line_id
             WHERE l.name_user_set = 1
               AND l.name IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM sessions s WHERE s.line_id = l.line_id
               )
               -- One row per line: the newest mint it has. `rowid` breaks a
               -- tie in `minted_at`, so a line can never yield two.
               AND m.rowid = (
                   SELECT MAX(m2.rowid) FROM minted_tags m2
                   WHERE m2.line_id = l.line_id
               )
             ORDER BY l.last_used_at DESC",
        )
        .map_err(|e| format!("survey: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| format!("survey: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("survey: {e}"))?;

    let facts = has_table(conn, "facts");
    let mut out = Vec::with_capacity(rows.len());
    for (line_id, tag, name, project_dir, created_at, last_used_at, session_id) in rows {
        let fact_count = if facts {
            conn.query_row(
                "SELECT COUNT(*) FROM facts WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
        } else {
            0
        };
        out.push(Candidate {
            jsonl: find_transcript(projects_root, &session_id),
            line_id,
            tag,
            name,
            project_dir,
            created_at,
            last_used_at,
            session_id,
            fact_count,
        });
    }
    Ok(out)
}

/// Put the row back, bound to the line it belonged to. `INSERT OR IGNORE`
/// because a session that reappeared between the survey and the write is a
/// repair that is no longer needed, not a collision.
fn restore(conn: &Connection, c: &Candidate) -> Result<bool, String> {
    let affected = conn
        .execute(
            "INSERT OR IGNORE INTO sessions (
                 session_id, workspace_key, project_dir, created_at, last_used_at,
                 turn_count, state, card_id, line_id
             ) VALUES (?1, ?2, ?2, ?3, ?4, 0, 'closed', NULL, ?5)",
            params![
                c.session_id,
                c.project_dir,
                c.created_at,
                c.last_used_at,
                c.line_id
            ],
        )
        .map_err(|e| format!("restore {}: {e}", c.name))?;
    Ok(affected > 0)
}

pub fn run_restore_names(db: Option<PathBuf>, dry_run: bool) -> Result<i32, String> {
    let projects_root = dirs_home()?.join(".claude/projects");
    let paths = ledgers(db.as_deref())?;
    let mut restored = 0usize;
    let mut skipped = 0usize;

    for path in &paths {
        let conn =
            tugcore::ledger_db::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        // A ledger from before names moved onto their own table has nothing
        // this verb could repair. Skipping is the right answer, and failing
        // on it would make the whole run depend on the oldest instance on the
        // machine.
        if !has_table(&conn, "lines") {
            println!(
                "{}: no `lines` table (pre-migration) — skipped",
                path.display()
            );
            continue;
        }
        let candidates = survey(&conn, &projects_root)?;
        if candidates.is_empty() {
            println!("{}: no stranded names", path.display());
            continue;
        }

        println!("{}:", path.display());
        for c in &candidates {
            if c.restorable() {
                println!(
                    "  restore  {} ({})  session {}  {} facts",
                    c.name, c.tag, c.session_id, c.fact_count
                );
            } else {
                println!(
                    "  skip     {} ({})  session {} — no transcript on disk",
                    c.name, c.tag, c.session_id
                );
            }
        }

        for c in &candidates {
            if !c.restorable() {
                skipped += 1;
                continue;
            }
            if dry_run {
                continue;
            }
            if restore(&conn, c)? {
                restored += 1;
            }
        }
    }

    if dry_run {
        println!("\n--dry-run: nothing was written.");
    } else {
        println!("\nrestored {restored}, skipped {skipped} (no transcript).");
    }
    Ok(0)
}

fn dirs_home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is not set".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ledger with the three tables this verb reads, shaped as the real one
    /// shapes them.
    fn fixture(dir: &Path) -> Connection {
        let conn = tugcore::ledger_db::open(dir.join("sessions.db")).expect("open");
        conn.execute_batch(
            "CREATE TABLE lines (
                 line_id TEXT PRIMARY KEY, tag TEXT NOT NULL UNIQUE, name TEXT,
                 name_user_set INTEGER NOT NULL DEFAULT 0, card_id TEXT,
                 project_dir TEXT NOT NULL, created_at INTEGER NOT NULL,
                 last_used_at INTEGER NOT NULL);
             CREATE TABLE sessions (
                 session_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL,
                 project_dir TEXT NOT NULL, created_at INTEGER NOT NULL,
                 last_used_at INTEGER NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
                 state TEXT NOT NULL, card_id TEXT, line_id TEXT NOT NULL);
             CREATE TABLE minted_tags (
                 tag TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                 minted_at INTEGER NOT NULL, line_id TEXT);
             CREATE TABLE facts (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL,
                 kind TEXT NOT NULL, session_id TEXT, subject TEXT,
                 text TEXT NOT NULL, payload TEXT NOT NULL);",
        )
        .expect("schema");
        conn
    }

    fn strand(conn: &Connection, line: &str, tag: &str, name: &str, session: &str) {
        conn.execute(
            "INSERT INTO lines (line_id, tag, name, name_user_set, project_dir,
                                created_at, last_used_at)
             VALUES (?1, ?2, ?3, 1, '/proj', 10, 20)",
            params![line, tag, name],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO minted_tags (tag, session_id, minted_at, line_id)
             VALUES (?1, ?2, 5, ?3)",
            params![tag, session, line],
        )
        .unwrap();
    }

    fn with_transcript(root: &Path, session: &str) {
        let dir = root.join("-Users-someone-proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{session}.jsonl")), "{}\n").unwrap();
    }

    #[test]
    fn a_stranded_named_line_is_surveyed_with_its_recorded_session() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path());
        let projects = tmp.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        strand(&conn, "line-lens", "ashen-bagel", "lens-xp", "d361bcf4");
        with_transcript(&projects, "d361bcf4");
        conn.execute(
            "INSERT INTO facts (at_ms, kind, session_id, text, payload)
             VALUES (1, 'session.renamed', 'd361bcf4', 'lens-xp', '{}')",
            [],
        )
        .unwrap();

        let found = survey(&conn, &projects).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "lens-xp");
        assert_eq!(
            found[0].session_id, "d361bcf4",
            "the session comes out of minted_tags, not out of a guess"
        );
        assert!(found[0].restorable());
        assert_eq!(found[0].fact_count, 1, "the facts ledger corroborates");
    }

    #[test]
    fn a_line_whose_transcript_is_gone_is_surveyed_but_not_restorable() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path());
        let projects = tmp.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        strand(&conn, "line-ghost", "lucky-wren", "dots-hacking", "abc123");

        let found = survey(&conn, &projects).unwrap();
        assert_eq!(found.len(), 1);
        assert!(
            !found[0].restorable(),
            "a row with no transcript would be a session the picker cannot open"
        );
    }

    #[test]
    fn an_unnamed_line_and_a_line_with_a_segment_are_both_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path());
        let projects = tmp.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();

        // Nobody typed this one's name.
        conn.execute(
            "INSERT INTO lines (line_id, tag, name, name_user_set, project_dir,
                                created_at, last_used_at)
             VALUES ('line-anon', 'plain-mouse', NULL, 0, '/proj', 1, 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO minted_tags (tag, session_id, minted_at, line_id)
             VALUES ('plain-mouse', 'anon1', 1, 'line-anon')",
            [],
        )
        .unwrap();
        // This one is named and still has a segment, so nothing is stranded.
        strand(&conn, "line-kept", "brisk-otter", "layout-xp", "kept1");
        conn.execute(
            "INSERT INTO sessions (session_id, workspace_key, project_dir,
                                   created_at, last_used_at, state, line_id)
             VALUES ('kept1', '/proj', '/proj', 1, 2, 'closed', 'line-kept')",
            [],
        )
        .unwrap();

        assert!(survey(&conn, &projects).unwrap().is_empty());
    }

    #[test]
    fn restoring_writes_the_row_back_onto_its_line_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path());
        let projects = tmp.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        strand(&conn, "line-lens", "ashen-bagel", "lens-xp", "d361bcf4");
        with_transcript(&projects, "d361bcf4");

        let found = survey(&conn, &projects).unwrap();
        assert!(restore(&conn, &found[0]).unwrap(), "the row goes back");

        let line: String = conn
            .query_row(
                "SELECT line_id FROM sessions WHERE session_id = 'd361bcf4'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(line, "line-lens", "bound to the line that carries the name");
        // And the line is no longer stranded, so a second run finds nothing.
        assert!(survey(&conn, &projects).unwrap().is_empty());
        assert!(
            !restore(&conn, &found[0]).unwrap(),
            "a re-run writes nothing rather than colliding"
        );
    }

    #[test]
    fn a_ledger_with_no_lines_table_is_skipped_rather_than_failed_on() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = tugcore::ledger_db::open(tmp.path().join("sessions.db")).unwrap();
        conn.execute_batch("CREATE TABLE sessions (session_id TEXT PRIMARY KEY);")
            .unwrap();
        assert!(
            !has_table(&conn, "lines"),
            "a pre-migration ledger is recognized by the absence itself"
        );
    }
}
