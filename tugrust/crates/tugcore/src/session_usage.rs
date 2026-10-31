//! One project's tokens, cost and turns per day and model family, from the
//! session ledger.
//!
//! `sessions.db` is tugcast's per-instance ledger, and tugcast is its writer.
//! This reads `turn_telemetry`, `sessions` and `session_metadata` by name, the
//! way `session_finder` reads the cross-crate tables: **read-only**, creating
//! nothing, and a missing file or table is an empty answer rather than an
//! error.
//!
//! The ledger keeps no model per turn, so a turn takes its session's: the
//! `stage_model` a rotation seated it on when there is one, and otherwise the
//! live model in its `session_metadata` payload. The two name one model
//! differently, which is what [`model_family`] folds.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use chrono::{DateTime, Local, NaiveDate};
use rusqlite::{Connection, OpenFlags, params};

use crate::registry::base_checkout;

/// The family of a session with no model on record.
pub const UNKNOWN_FAMILY: &str = "unknown";

/// What one model family did on one day.
#[derive(Debug, Clone, PartialEq)]
pub struct DayUsage {
    pub day: NaiveDate,
    pub family: String,
    pub turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cost_usd: f64,
}

/// One model family for every way a model is named: `opus` and
/// `claude-opus-5-5` are both `opus`, and `claude-fable-5-1[1m]` is `fable`.
pub fn model_family(model: &str) -> String {
    let name = model
        .split('[')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    name.strip_prefix("claude-")
        .unwrap_or(&name)
        .split('-')
        .find(|part| part.starts_with(|c: char| c.is_ascii_alphabetic()))
        .unwrap_or(UNKNOWN_FAMILY)
        .to_string()
}

/// `project`'s usage from the ledger at `path`, oldest day first and by family
/// within a day. Read-only; a missing file or table answers with nothing.
pub fn usage_by_day(path: &Path, project: &Path) -> Vec<DayUsage> {
    if !path.exists() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    usage_from(&conn, project)
}

const TURNS_SQL: &str = "
    SELECT t.ended_at, t.input_tokens, t.output_tokens, t.cache_read_input_tokens,
           t.cache_creation_input_tokens, t.total_cost_usd,
           COALESCE(
               NULLIF(s.stage_model, ''),
               CASE WHEN json_valid(CAST(m.payload AS TEXT))
                    THEN CAST(json_extract(CAST(m.payload AS TEXT), '$.model') AS TEXT)
               END
           )
    FROM turn_telemetry t
    JOIN sessions s ON s.session_id = t.session_id
    LEFT JOIN session_metadata m ON m.session_id = t.session_id
    WHERE s.project_dir = ?1
";

/// The same answer over an open connection.
pub fn usage_from(conn: &Connection, project: &Path) -> Vec<DayUsage> {
    let base = base_checkout(project);
    let mut days: BTreeMap<(NaiveDate, String), DayUsage> = BTreeMap::new();
    for dir in project_dirs(conn) {
        // A session recorded in an arc's worktree, or through another spelling
        // of the path, belongs to the same project.
        if base_checkout(Path::new(&dir)) != base {
            continue;
        }
        let Ok(mut stmt) = conn.prepare(TURNS_SQL) else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map(params![dir], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, f64>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        }) else {
            return Vec::new();
        };
        for (ended_at, input, output, cache_read, cache_creation, cost, model) in rows.flatten() {
            let Some(day) = local_day(ended_at) else {
                continue;
            };
            let family = model_family(&model.unwrap_or_default());
            let usage = days
                .entry((day, family.clone()))
                .or_insert_with(|| DayUsage {
                    day,
                    family,
                    turns: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    cost_usd: 0.0,
                });
            usage.turns += 1;
            usage.input_tokens += input;
            usage.output_tokens += output;
            usage.cache_read_tokens += cache_read;
            usage.cache_creation_tokens += cache_creation;
            usage.cost_usd += cost;
        }
    }
    days.into_values().collect()
}

fn project_dirs(conn: &Connection) -> HashSet<String> {
    let Ok(mut stmt) = conn.prepare("SELECT DISTINCT project_dir FROM sessions") else {
        return HashSet::new();
    };
    let Ok(rows) = stmt.query_map([], |r| r.get(0)) else {
        return HashSet::new();
    };
    rows.flatten().collect()
}

fn local_day(ended_at_ms: i64) -> Option<NaiveDate> {
    let at = DateTime::from_timestamp_millis(ended_at_ms)?;
    Some(at.with_timezone(&Local).date_naive())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::path::PathBuf;

    /// `turn_telemetry` and `session_metadata` are tugcast's own, outside the
    /// fixture's cross-crate set, so the columns read here are named here.
    const TUGCAST_TABLES: &str = "
        CREATE TABLE turn_telemetry (
            session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL NOT NULL DEFAULT 0, ended_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, msg_id));
        CREATE TABLE session_metadata (
            session_id TEXT PRIMARY KEY, payload BLOB NOT NULL, captured_at INTEGER NOT NULL);
    ";

    struct Ledger {
        path: PathBuf,
        conn: Connection,
        next_turn: i64,
    }

    impl Ledger {
        fn at(dir: &Path) -> Self {
            let ledgers = crate::test_fixtures::ledgers(dir);
            let conn = ledgers.sessions();
            conn.execute_batch(TUGCAST_TABLES).unwrap();
            conn.execute(
                "INSERT INTO lines (line_id, tag, project_dir, created_at, last_used_at)
                 VALUES ('line', 'odd-kiln', '/p', 0, 0)",
                [],
            )
            .unwrap();
            Self {
                path: ledgers.sessions_db(),
                conn,
                next_turn: 0,
            }
        }

        fn session(&self, id: &str, project: &Path, stage_model: Option<&str>) {
            self.conn
                .execute(
                    "INSERT INTO sessions (session_id, workspace_key, project_dir, created_at,
                                           last_used_at, state, line_id, stage_model)
                     VALUES (?1, 'ws', ?2, 0, 0, 'closed', 'line', ?3)",
                    params![id, project.to_str().unwrap(), stage_model],
                )
                .unwrap();
        }

        fn metadata(&self, id: &str, payload: &[u8]) {
            self.conn
                .execute(
                    "INSERT INTO session_metadata (session_id, payload, captured_at)
                     VALUES (?1, ?2, 0)",
                    params![id, payload],
                )
                .unwrap();
        }

        /// A turn of one output token and one cent, at noon on `day` of the month.
        fn turn(&mut self, id: &str, day: u32) {
            self.next_turn += 1;
            self.conn
                .execute(
                    "INSERT INTO turn_telemetry
                         (session_id, msg_id, input_tokens, output_tokens,
                          cache_creation_input_tokens, cache_read_input_tokens,
                          total_cost_usd, ended_at)
                     VALUES (?1, ?2, 2, 1, 3, 4, 0.01, ?3)",
                    params![id, self.next_turn, noon(day)],
                )
                .unwrap();
        }
    }

    fn noon(day: u32) -> i64 {
        Local
            .with_ymd_and_hms(2026, 10, day, 12, 0, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn date(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, day).unwrap()
    }

    fn rows(usage: &[DayUsage]) -> Vec<(NaiveDate, &str, i64)> {
        usage
            .iter()
            .map(|u| (u.day, u.family.as_str(), u.turns))
            .collect()
    }

    #[test]
    fn every_name_of_a_model_folds_onto_one_family() {
        for name in [
            "opus",
            "claude-opus-5-5",
            "claude-opus-4-8",
            "claude-opus-5-5[1m]",
            "opus[1m]",
            "Claude-Opus-5-5",
            "claude-3-opus-20240229",
        ] {
            assert_eq!(model_family(name), "opus", "{name}");
        }
        assert_eq!(model_family("claude-fable-5-1[1m]"), "fable");
        assert_eq!(model_family("claude-sonnet-5-5"), "sonnet");
        assert_eq!(model_family(""), UNKNOWN_FAMILY);
    }

    #[test]
    fn turns_sum_by_day_and_family_from_the_stage_model_then_the_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let mut ledger = Ledger::at(dir.path());
        // A stage model outranks what the metadata says.
        ledger.session("staged", &project, Some("opus"));
        ledger.metadata("staged", br#"{"model":"claude-fable-5-1"}"#);
        ledger.session("live", &project, None);
        ledger.metadata("live", br#"{"model":"claude-opus-5-5[1m]"}"#);
        ledger.session("other-model", &project, None);
        ledger.metadata("other-model", br#"{"model":"claude-fable-5-1[1m]"}"#);
        // Neither on record, in each of the ways that can be.
        ledger.session("no-row", &project, None);
        ledger.session("no-key", &project, Some(""));
        ledger.metadata("no-key", br#"{"cwd":"/p"}"#);
        ledger.session("malformed", &project, None);
        ledger.metadata("malformed", b"{not json");

        ledger.turn("staged", 20);
        ledger.turn("live", 20);
        ledger.turn("other-model", 20);
        ledger.turn("no-row", 21);
        ledger.turn("no-key", 21);
        ledger.turn("malformed", 21);
        ledger.turn("live", 22);

        let usage = usage_by_day(&ledger.path, &project);
        assert_eq!(
            rows(&usage),
            vec![
                (date(20), "fable", 1),
                (date(20), "opus", 2),
                (date(21), UNKNOWN_FAMILY, 3),
                (date(22), "opus", 1),
            ]
        );
        let opus = &usage[1];
        assert_eq!(opus.input_tokens, 4);
        assert_eq!(opus.output_tokens, 2);
        assert_eq!(opus.cache_creation_tokens, 6);
        assert_eq!(opus.cache_read_tokens, 8);
        assert!((opus.cost_usd - 0.02).abs() < 1e-9);
    }

    #[test]
    fn another_projects_rows_are_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let (ours, theirs) = (dir.path().join("ours"), dir.path().join("theirs"));
        std::fs::create_dir(&ours).unwrap();
        std::fs::create_dir(&theirs).unwrap();
        let mut ledger = Ledger::at(dir.path());
        ledger.session("mine", &ours, Some("opus"));
        ledger.session("yours", &theirs, Some("fable"));
        ledger.turn("mine", 20);
        ledger.turn("yours", 20);
        assert_eq!(
            rows(&usage_by_day(&ledger.path, &ours)),
            vec![(date(20), "opus", 1)]
        );
    }

    /// `git worktree add`'s layout, written by hand: a `.git` directory in the
    /// checkout, and a `.git` file in the worktree pointing into it.
    fn linked_worktree(root: &Path) -> (PathBuf, PathBuf) {
        let (base, worktree) = (root.join("base"), root.join("worktree"));
        let gitdir = base.join(".git/worktrees/worktree");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        std::fs::create_dir(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        (base, worktree)
    }

    #[test]
    fn a_worktree_and_its_checkout_read_the_same_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let (base, worktree) = linked_worktree(dir.path());
        let mut ledger = Ledger::at(dir.path());
        ledger.session("at-base", &base, Some("opus"));
        ledger.session("in-worktree", &worktree, Some("fable"));
        ledger.turn("at-base", 20);
        ledger.turn("in-worktree", 20);

        let both = vec![(date(20), "fable", 1), (date(20), "opus", 1)];
        assert_eq!(rows(&usage_by_day(&ledger.path, &base)), both);
        assert_eq!(rows(&usage_by_day(&ledger.path, &worktree)), both);
    }

    #[test]
    fn a_missing_file_is_an_empty_answer_and_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.db");
        assert!(usage_by_day(&path, dir.path()).is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn a_missing_table_is_an_empty_answer_and_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let ledger = Ledger::at(dir.path());
        ledger.session("s", &project, Some("opus"));
        ledger
            .conn
            .execute_batch("DROP TABLE turn_telemetry")
            .unwrap();
        assert!(usage_by_day(&ledger.path, &project).is_empty());

        let other = dir.path().join("other.db");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE x (a)")
            .unwrap();
        assert!(usage_by_day(&other, &project).is_empty());
        let conn = Connection::open(&other).unwrap();
        let tables: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tables, 1, "no schema is created");
    }
}
