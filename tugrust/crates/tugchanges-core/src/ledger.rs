//! Read-only ledger access — the attribution ledger's `file_events` table
//! (the **machine-global** `changes.db`, [D112]) and the per-instance
//! `sessions.db`'s `sessions` table.
//!
//! `tugchanges-core` reads both with read-only `rusqlite`
//! (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`, WAL-safe against tugcast's
//! concurrent writers) and never writes them — the ledger is tugcast's to own
//! ([P03]). It couples to the schema by raw SQL, exactly as the ported `tugutil`
//! did.
//!
//! **Schema source of truth:** the `file_events`/`sessions` columns this module
//! hand-mirrors are defined by `tugcast/src/feeds/attribution.rs` (the writer)
//! and `tugcast/src/session_ledger.rs` (the table DDL). A schema change there
//! must update this query; the contract test in `changes.rs` guards the shape.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

/// A single decoded `file_events` row, in `at`-ascending order. `at` (epoch
/// ms) feeds the row-liveness rule: a row is live only while it postdates the
/// last commit that touched its path — spent rows neither attribute nor
/// contend.
pub(crate) struct EventRow {
    pub file_path: String,
    pub op: String,
    pub origin: String,
    pub at: i64,
}

/// Open `sessions.db` read-only. WAL semantics make a read-only open safe while
/// tugcast writes concurrently.
pub(crate) fn open_readonly(db_path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("cannot open session ledger {}: {e}", db_path.display()))
}

/// The SQL placeholder tuple `(?1, ?2, …)` for `ids.len()` parameters,
/// numbered from `start`.
fn placeholder_tuple(start: usize, len: usize) -> String {
    (start..start + len)
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every segment id of the line `session` belongs to ([P01]), read from the
/// per-instance `sessions.db`. A session id is one *segment* of a line of
/// work — a card that has rotated its id (relaunch-resume, rewind-fork,
/// crash respawn) has written `file_events` rows under several, and the
/// "this session's files" question is the line's, not the current id's.
/// Empty when the session wears no line, or against a pre-lines database
/// (no `line_id` column) — the caller falls back to the bare id.
pub(crate) fn line_segments(conn: &Connection, session: &str) -> Vec<String> {
    let line_id: Option<String> = conn
        .query_row(
            "SELECT line_id FROM sessions WHERE session_id = ?1",
            [session],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|l| !l.is_empty());
    let Some(line_id) = line_id else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare("SELECT session_id FROM sessions WHERE line_id = ?1") else {
        return Vec::new();
    };
    stmt.query_map([&line_id], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// All `file_events` for the given self set — a line's segment ids, or the
/// bare session id — oldest-first (matching the ledger's own
/// `file_events_for_session` order).
pub(crate) fn query_events(conn: &Connection, selves: &[String]) -> Result<Vec<EventRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT file_path, op, origin, at
             FROM file_events
             WHERE tug_session_id IN ({})
             ORDER BY at ASC, tool_use_id ASC, file_path ASC",
            placeholder_tuple(1, selves.len())
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(selves), |r| {
            Ok(EventRow {
                file_path: r.get::<_, String>(0)?,
                op: r.get::<_, String>(1)?,
                origin: r.get::<_, String>(2)?,
                at: r.get::<_, i64>(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// One other session's claim on a path: its `project_dir` and its newest
/// **proof** row's `at` (`None` when it has only `bash`/`turn` bracket rows
/// for the path). The proof/correlation split is the load-bearing
/// distinction: a bracket row is a whole-tree-delta *claim*, not proof of
/// authorship — only proof rows (`exact` live, `replay` backfill; the tool
/// input names the file) establish ownership ([D112]).
pub(crate) struct PathClaim {
    pub session: String,
    pub project_dir: String,
    pub max_proof_at: Option<i64>,
}

/// Every session outside the `exclude` set (the asking line's segment ids)
/// that has a `file_events` row for the repo-relative `file_path`, as
/// [`PathClaim`]s (Spec S02). Grouped so a session touching the path many
/// times counts once, carrying its newest proof row's `at` for the caller's
/// liveness + authorship cuts.
pub(crate) fn sessions_for_path(
    conn: &Connection,
    file_path: &str,
    exclude: &[String],
) -> Result<Vec<PathClaim>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT tug_session_id, project_dir,
                    MAX(CASE WHEN origin IN {PROOF_ORIGINS_SQL} THEN at END)
             FROM file_events
             WHERE file_path = ?1 AND tug_session_id NOT IN ({})
             GROUP BY tug_session_id, project_dir",
            placeholder_tuple(2, exclude.len())
        ))
        .map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::ToSql> = std::iter::once(&file_path as &dyn rusqlite::ToSql)
        .chain(exclude.iter().map(|id| id as &dyn rusqlite::ToSql))
        .collect();
    let rows = stmt
        .query_map(params.as_slice(), |r| {
            Ok(PathClaim {
                session: r.get::<_, String>(0)?,
                project_dir: r.get::<_, String>(1)?,
                max_proof_at: r.get::<_, Option<i64>>(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Other sessions with a **live proof** claim on `file_path` — the genuine
/// cross-session owners. A session qualifies when its `project_dir`
/// canonicalizes to the same on-disk directory as `repo_root` and it has a
/// proof row at or after `min_live_at_ms` (the row-liveness cut). Bracket
/// (`bash`/`turn`) rows never qualify a session here: a whole-tree fingerprint
/// delta cannot distinguish this session's own writes from another session's
/// concurrent save or a build's churn, so it is not authorship ([D112]). A row
/// whose `project_dir` (or `repo_root`) fails to canonicalize, or resolves
/// elsewhere, is not foreign — it degrades to `unattributed`, visible.
pub(crate) fn foreign_proof_sessions_for_path(
    conn: &Connection,
    file_path: &str,
    exclude: &[String],
    repo_root: &Path,
    min_live_at_ms: i64,
) -> Result<Vec<String>, String> {
    let canon_root = match std::fs::canonicalize(repo_root) {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for claim in sessions_for_path(conn, file_path, exclude)? {
        let Some(exact_at) = claim.max_proof_at else {
            continue;
        };
        if exact_at < min_live_at_ms {
            continue;
        }
        if let Ok(canon_proj) = std::fs::canonicalize(&claim.project_dir) {
            if canon_proj == canon_root {
                out.push(claim.session);
            }
        }
    }
    Ok(out)
}

/// One span row with the owner and event time of its parent — the read side
/// of [P12]. `at` rides along so the caller can apply the same row-liveness
/// cut it applies to the parent: a span of a spent row is spent evidence.
pub(crate) struct SpanRow {
    pub session: String,
    /// The parent row's `project_dir`, so the caller can scope the read to
    /// one repo — two checkouts sharing a relative path must not
    /// cross-pollinate anchors.
    pub project_dir: String,
    pub at: i64,
    pub kind: String,
    pub anchor: String,
}

/// Every **proof**-row span recorded for `file_path`, whoever owns it.
///
/// Joined to the parent so a stranded span can never speak, and restricted to
/// proof origins for the same reason ownership is: a bracket row's whole-tree
/// delta says nothing about regions, and its spans (it has none) must not
/// stand in for evidence it does not have.
pub(crate) fn spans_for_path(conn: &Connection, file_path: &str) -> Result<Vec<SpanRow>, String> {
    // The table arrives with changes-schema v2, and tugcast is the only
    // process that migrates. This reader runs against whatever is on disk —
    // including a v1 database on a machine where tugcast has not restarted
    // yet — so its absence means "no sub-file evidence", not an error. Every
    // owner then claims the whole file ([P12]), which is precisely the answer
    // that database's own vintage would have given.
    if !spans_table_exists(conn) {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT e.tug_session_id, e.project_dir, e.at, s.kind, s.anchor
             FROM file_event_spans s
             JOIN file_events e
               ON e.tug_session_id = s.tug_session_id
              AND e.tool_use_id = s.tool_use_id
              AND e.file_path = s.file_path
             WHERE s.file_path = ?1 AND e.origin IN {PROOF_ORIGINS_SQL}
             ORDER BY e.tug_session_id, e.at, s.seq",
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([file_path], |r| {
            Ok(SpanRow {
                session: r.get::<_, String>(0)?,
                project_dir: r.get::<_, String>(1)?,
                at: r.get::<_, i64>(2)?,
                kind: r.get::<_, String>(3)?,
                anchor: r.get::<_, String>(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Whether this database carries the schema-v2 spans table.
fn spans_table_exists(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'file_event_spans'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .unwrap_or(false)
}

/// Whether a row's `origin` is **proof** of authorship — the tool input named
/// the file (`exact` live, `replay` backfill of the same, `cmd` for a Bash
/// command's literal operands or a `tugutil file` receipt), or a session
/// **`claim`**ed it outright (the explicit promotion of a hinted-but-unproven
/// file). `bash`/`turn` bracket rows are correlation (a whole-tree fingerprint
/// delta), never proof. Mirrors `tugcast::feeds::attribution::origin_is_proof`
/// (the writer side).
pub(crate) fn origin_is_proof(origin: &str) -> bool {
    PROOF_ORIGINS.contains(&origin)
}

/// The proof origins, in one place: [`origin_is_proof`] tests membership and
/// [`PROOF_ORIGINS_SQL`] is the same set as a SQL tuple, so the row-level rule
/// and the query-level rule cannot drift apart.
pub(crate) const PROOF_ORIGINS: [&str; 4] = ["exact", "replay", "claim", "cmd"];

const PROOF_ORIGINS_SQL: &str = "('exact', 'replay', 'claim', 'cmd')";

/// Whether a `sessions` row exists for `session` — the "known vs unknown" test
/// that separates a valid session with no changes (exit 0, empty list) from a
/// bogus id (exit 2).
pub(crate) fn session_exists(conn: &Connection, session: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE session_id = ?1",
            [session],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

/// Which of `ids` are running, against the **`sessions.db`** connection.
///
/// `sessions` is a per-instance table while `file_events` is machine-global
/// ([D112]), so a session belonging to another app instance has no row here
/// and reads as not-live — the same blind spot compose's `owner_live` join
/// already has, inherited deliberately ([Q01]). An id absent from the returned
/// map is *unanswered*, not dead: callers take the live default for it, since
/// dead is the retirement-eligible state ([P03]).
pub(crate) fn session_states(
    conn: &Connection,
    ids: &[&str],
) -> Result<HashMap<String, bool>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (1..=ids.len())
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql =
        format!("SELECT session_id, state FROM sessions WHERE session_id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, state) = row.map_err(|e| e.to_string())?;
        out.insert(id, state == "live");
    }
    // A session this instance has never heard of is answered, and the answer
    // is "not running here".
    for id in ids {
        out.entry((*id).to_owned()).or_insert(false);
    }
    Ok(out)
}

/// Resolve the on-disk `sessions.db` path, mirroring
/// `tugcast::session_ledger::SessionLedger::default_path`: the `TUG_SESSIONS_DB`
/// override when set, else the per-instance location when `TUG_INSTANCE_ID` is
/// set, else the legacy single-instance path under the platform data dir.
pub(crate) fn resolve_sessions_db_path() -> Option<PathBuf> {
    tugcore::instance::resolve_sessions_db_path()
}

/// The machine-global changes-ledger path ([D112]): one `changes.db` for
/// every app instance, holding the `file_events` rows. Mirrors
/// `tugcore::instance::changes_db_path()` (honoring the `TUG_CHANGES_DB`
/// test-isolation override) — deliberately independent of `TUG_INSTANCE_ID`.
pub(crate) fn resolve_changes_db_path() -> PathBuf {
    tugcore::instance::changes_db_path()
}

/// Whether any of the self set's ids holds a `file_events` row at all — the
/// shared-ledger half of the "known session" test (a session recorded by
/// another instance has rows here but no `sessions` row in this instance's
/// `sessions.db`).
pub(crate) fn session_has_events(conn: &Connection, selves: &[String]) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM file_events WHERE tug_session_id IN ({}))",
                placeholder_tuple(1, selves.len())
            ),
            rusqlite::params_from_iter(selves),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seed a `sessions.db` with `(tug_session_id, file_path, origin, project_dir, at)`
    /// rows — origin explicit so the exact-vs-bracket authorship split is testable.
    fn seed(rows: &[(&str, &str, &str, &str, i64)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);
             CREATE TABLE file_event_spans (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                seq INTEGER, kind TEXT, anchor TEXT);",
        )
        .unwrap();
        for (i, (session, file_path, origin, project_dir, at)) in rows.iter().enumerate() {
            conn.execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES (?1, ?2, ?3, 'Write', 'edit', ?4, 0, ?5, ?6)",
                rusqlite::params![session, format!("tu-{i}"), file_path, origin, project_dir, at],
            )
            .unwrap();
        }
        dir
    }

    /// A pre-v2 database has no spans table. Reading it must answer "no
    /// sub-file evidence" rather than failing the whole `changes` call — this
    /// reader runs on machines whose tugcast has not restarted into the new
    /// schema yet.
    #[test]
    fn line_segments_expands_a_session_to_its_whole_line() {
        // `$TUG_SESSION_ID` is frozen at spawn, so after an id rotation it
        // names an older segment — the expansion is what keeps `tugutil
        // changes` answering for the whole conversation ([P01]).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (session_id TEXT, line_id TEXT);
                 INSERT INTO sessions VALUES ('seg-old', 'line-1');
                 INSERT INTO sessions VALUES ('seg-new', 'line-1');
                 INSERT INTO sessions VALUES ('stranger', 'line-2');
                 INSERT INTO sessions VALUES ('lineless', NULL);",
            )
            .unwrap();
        }
        let conn = open_readonly(&path).unwrap();
        let mut segments = line_segments(&conn, "seg-old");
        segments.sort();
        assert_eq!(segments, ["seg-new", "seg-old"]);
        assert!(line_segments(&conn, "lineless").is_empty());
        assert!(line_segments(&conn, "unknown").is_empty());
    }

    #[test]
    fn query_events_reads_every_segment_of_the_self_set() {
        let repo = tempfile::tempdir().unwrap();
        let repo_dir = repo.path().to_string_lossy().into_owned();
        let db = seed(&[
            ("seg-old", "early.rs", "exact", &repo_dir, 1),
            ("seg-new", "later.rs", "exact", &repo_dir, 2),
            ("stranger", "other.rs", "exact", &repo_dir, 3),
        ]);
        let conn = open_readonly(&db.path().join("sessions.db")).unwrap();
        let events = query_events(&conn, &["seg-new".to_owned(), "seg-old".to_owned()]).unwrap();
        let paths: Vec<&str> = events.iter().map(|e| e.file_path.as_str()).collect();
        assert_eq!(paths, ["early.rs", "later.rs"], "both segments, at-ordered");
    }

    #[test]
    fn a_pre_v2_database_reads_as_span_less_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE file_events (
                    tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                    tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                    parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);",
            )
            .unwrap();
        }
        let conn = open_readonly(&path).unwrap();
        assert!(!spans_table_exists(&conn));
        assert!(spans_for_path(&conn, "foo.rs").unwrap().is_empty());
    }

    #[test]
    fn spans_are_read_with_their_owner_and_event_time() {
        let repo = tempfile::tempdir().unwrap();
        let repo_dir = repo.path().to_string_lossy().into_owned();
        let db = seed(&[
            ("mine", "foo.rs", "exact", &repo_dir, 5),
            ("bracketer", "foo.rs", "bash", &repo_dir, 6),
        ]);
        {
            let conn = Connection::open(db.path().join("sessions.db")).unwrap();
            // `tu-0` is `mine`'s proof row; `tu-1` is the bracket row, whose
            // spans must not be readable as evidence.
            conn.execute(
                "INSERT INTO file_event_spans VALUES ('mine','tu-0','foo.rs',0,'insert','{}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO file_event_spans VALUES ('bracketer','tu-1','foo.rs',0,'insert','{}')",
                [],
            )
            .unwrap();
            // An orphan: no parent row names it, so the join drops it.
            conn.execute(
                "INSERT INTO file_event_spans VALUES ('ghost','tu-9','foo.rs',0,'insert','{}')",
                [],
            )
            .unwrap();
        }
        let conn = open_readonly(&db.path().join("sessions.db")).unwrap();
        let spans = spans_for_path(&conn, "foo.rs").unwrap();
        assert_eq!(spans.len(), 1, "only the proof row's span speaks");
        assert_eq!(spans[0].session, "mine");
        assert_eq!(spans[0].at, 5);
        assert_eq!(spans[0].kind, "insert");
    }

    #[test]
    fn foreign_exact_query_excludes_self_and_off_repo_project_dirs() {
        let repo = tempfile::tempdir().unwrap();
        let other_repo = tempfile::tempdir().unwrap();
        let repo_dir = repo.path().to_string_lossy().into_owned();
        let other_dir = other_repo.path().to_string_lossy().into_owned();

        let db = seed(&[
            ("mine", "foo.rs", "exact", &repo_dir, 5),
            ("theirs", "foo.rs", "exact", &repo_dir, 5),
            ("elsewhere", "foo.rs", "exact", &other_dir, 5),
        ]);
        let conn = open_readonly(&db.path().join("sessions.db")).unwrap();

        // Raw claims: everyone but `mine`.
        let claims = sessions_for_path(&conn, "foo.rs", &["mine".to_owned()]).unwrap();
        let ids: Vec<&str> = claims.iter().map(|c| c.session.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"theirs") && ids.contains(&"elsewhere"));

        // Repo-matched exact foreigns: only `theirs`; `elsewhere` resolves off-repo.
        let foreign =
            foreign_proof_sessions_for_path(&conn, "foo.rs", &["mine".to_owned()], repo.path(), 0)
                .unwrap();
        assert_eq!(foreign, vec!["theirs".to_string()]);
    }

    #[test]
    fn only_exact_rows_establish_foreign_ownership() {
        // The pinned regression: another session that merely *bracket-grabbed*
        // a file (bash/turn, a whole-tree delta contaminated by concurrent
        // saves or build churn) is NOT a cross-session owner — only its exact
        // rows count.
        let repo = tempfile::tempdir().unwrap();
        let repo_dir = repo.path().to_string_lossy().into_owned();
        let db = seed(&[
            ("bracketer", "foo.rs", "bash", &repo_dir, 5),
            ("bracketer", "foo.rs", "turn", &repo_dir, 6),
        ]);
        let conn = open_readonly(&db.path().join("sessions.db")).unwrap();

        assert!(
            foreign_proof_sessions_for_path(&conn, "foo.rs", &["mine".to_owned()], repo.path(), 0)
                .unwrap()
                .is_empty(),
            "bracket-only rows never establish foreign ownership"
        );
    }

    #[test]
    fn replay_rows_are_proof_class_evidence() {
        // A `replay` row is an exact-tool backfill — the tool input named the
        // file — so it establishes ownership exactly like a live `exact` row.
        let repo = tempfile::tempdir().unwrap();
        let repo_dir = repo.path().to_string_lossy().into_owned();
        let db = seed(&[("resumed", "foo.rs", "replay", &repo_dir, 5)]);
        let conn = open_readonly(&db.path().join("sessions.db")).unwrap();

        assert_eq!(
            foreign_proof_sessions_for_path(&conn, "foo.rs", &["mine".to_owned()], repo.path(), 0)
                .unwrap(),
            vec!["resumed".to_string()]
        );
    }

    #[test]
    fn foreign_exact_query_drops_spent_rows_behind_the_liveness_cut() {
        let repo = tempfile::tempdir().unwrap();
        let repo_dir = repo.path().to_string_lossy().into_owned();
        let db = seed(&[("theirs", "foo.rs", "exact", &repo_dir, 1)]);
        let conn = open_readonly(&db.path().join("sessions.db")).unwrap();

        // Below the cut → live claimant; above → spent, no claim.
        assert_eq!(
            foreign_proof_sessions_for_path(&conn, "foo.rs", &["mine".to_owned()], repo.path(), 1)
                .unwrap(),
            vec!["theirs".to_string()]
        );
        assert!(
            foreign_proof_sessions_for_path(&conn, "foo.rs", &["mine".to_owned()], repo.path(), 2)
                .unwrap()
                .is_empty(),
            "a spent exact row never contends"
        );
    }

    #[test]
    fn the_proof_origin_set_is_the_same_at_the_row_and_query_levels() {
        for origin in PROOF_ORIGINS {
            assert!(origin_is_proof(origin));
            assert!(
                PROOF_ORIGINS_SQL.contains(&format!("'{origin}'")),
                "`{origin}` is proof at the row level but not in the query predicate"
            );
        }
        for origin in ["bash", "turn"] {
            assert!(!origin_is_proof(origin));
            assert!(!PROOF_ORIGINS_SQL.contains(&format!("'{origin}'")));
        }
    }

    #[test]
    fn a_cmd_claim_is_visible_to_the_foreign_query() {
        // The SQL predicate and `origin_is_proof` must admit `cmd` together —
        // a proof origin the query omits is an owner the read side can't see.
        let repo = tempfile::tempdir().unwrap();
        let repo_dir = repo.path().to_string_lossy().into_owned();
        let db = seed(&[("shell", "foo.rs", "cmd", &repo_dir, 5)]);
        let conn = open_readonly(&db.path().join("sessions.db")).unwrap();

        assert_eq!(
            foreign_proof_sessions_for_path(&conn, "foo.rs", &["mine".to_owned()], repo.path(), 0)
                .unwrap(),
            vec!["shell".to_string()]
        );
    }
}
