//! The app-test results ledger — what every app-test run leaves behind.
//!
//! One row per run and one row per file in it: the verdict, the counts, the
//! wall time, the `HEAD` it ran against and whether that tree was dirty, how
//! the run was selected, and whether the file took the screen. The runner
//! already computes all of it to render its summary; this module is where it
//! stops dying with the shell.
//!
//! The question it exists to answer is asked at exactly one moment — a file
//! is red and the reader wants to know whether it was red before they touched
//! it. [`file_history`] answers it in one of three ways, and the report prints
//! the answer beside the failure.
//!
//! **Machine-global**, beside `changes.db` rather than inside an instance
//! directory (`tugcore::instance::apptest_results_db_path`), and keyed by the
//! **resolved base checkout** rather than the directory the run executed in.
//! A dash worktree and the checkout it forked from are one project, and the
//! motivating incident lived in exactly that split: the run that hit the red
//! file was on a dash, and the runs that could have exonerated it were on
//! `main`. History keyed by raw root would have kept those apart.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const APPTEST_RESULTS_SCHEMA_VERSION: i64 = 1;

/// Registered migrations, each keyed by the on-disk version it upgrades
/// *from*. Every migration whose `from` is at or above the version found on
/// disk is applied in order. Empty at v1; a schema change adds an entry here
/// and bumps [`APPTEST_RESULTS_SCHEMA_VERSION`] — never edits the DDL alone.
const APPTEST_RESULTS_MIGRATIONS: &[(i64, &str)] = &[];

/// How many runs are kept per base root. Older runs are deleted at record
/// time, and their result rows follow by cascade. Diagnostic telemetry whose
/// value is recency, not completeness — at the observed selective-run cadence
/// this is months of history.
pub const MAX_RUNS_PER_ROOT: i64 = 500;

const CREATE_APPTEST_RESULTS_SQL: &str = "
    CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER NOT NULL,
        base_root   TEXT    NOT NULL,
        run_root    TEXT    NOT NULL,
        branch      TEXT    NOT NULL,
        head_sha    TEXT    NOT NULL,
        dirty       INTEGER NOT NULL,
        sweep       TEXT    NOT NULL,
        selection   TEXT    NOT NULL,
        wall_secs   INTEGER NOT NULL,
        verdict     TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
        run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        file        TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        passed      INTEGER NOT NULL,
        total       INTEGER NOT NULL,
        secs        INTEGER NOT NULL,
        foreground  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS results_by_file ON results (file, run_id);
    CREATE INDEX IF NOT EXISTS runs_by_base ON runs (base_root, id);
";

#[derive(Debug, thiserror::Error)]
pub enum ApptestLedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("app-test results schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
}

/// One file's outcome within a run, as the runner's `RESULT_ROWS` hold it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileResult {
    pub file: String,
    /// `PASS` | `FAIL` | `ERR` | `SKIP`.
    pub status: String,
    pub passed: i64,
    pub total: i64,
    pub secs: i64,
    /// Whether the file ran from the foreground queue.
    #[serde(default)]
    pub foreground: bool,
}

/// A whole run, ready to record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub started_at: i64,
    pub ended_at: i64,
    /// The literal root the run executed in; the base root is resolved from
    /// it here, so the resolution rule lives in exactly one language.
    pub run_root: String,
    pub branch: String,
    pub head_sha: String,
    pub dirty: bool,
    /// The runner's own sweep label (`core` | `explicit-files`).
    pub sweep: String,
    /// How the run was selected (`changed` | `all` | `core` | `explicit`).
    /// Absent means `explicit` — the runner never guesses.
    #[serde(default = "default_selection")]
    pub selection: String,
    pub wall_secs: i64,
    /// `PASS` | `FAIL`.
    pub verdict: String,
    pub files: Vec<FileResult>,
}

fn default_selection() -> String {
    "explicit".to_string()
}

/// What a record left behind.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRun {
    pub run_id: i64,
    /// How many runs retention removed to make room for this one.
    pub pruned: usize,
}

/// The green a file was last recorded at.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastGreen {
    pub sha: String,
    /// UTC date of the run's `ended_at`, `YYYY-MM-DD`.
    pub date: String,
    /// How many **recorded** runs ago it was — an interrupted run leaves no
    /// row, so this is not a count of runs attempted, and the rendering says
    /// "recorded" in those words.
    pub runs_ago: i64,
    /// Whether that green was recorded on a dirty tree. Materially weaker
    /// evidence than a clean one, so it rides the answer rather than being
    /// flattened away.
    pub dirty: bool,
    /// How many files actually ran in that run — the run's **batch size**.
    ///
    /// The fact that tells a defect from contention. Some files pass alone in
    /// six seconds and time out at eighty in a sixteen-file batch, and until
    /// this rode the answer the `history:` line recorded *the run* without
    /// recording *the run's size*, so the two shapes read identically. A file
    /// red only in large batches and green alone is contention; one red alone
    /// too is a defect.
    ///
    /// Derived — `COUNT(*)` over the run's non-`SKIP` result rows — rather
    /// than stored as a column, so it cannot disagree with the rows it counts.
    /// A skipped file never ran and so never contended.
    pub files_in_run: i64,
}

/// One of the three answers ([P06]).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "answer", rename_all = "kebab-case")]
pub enum History {
    /// The file's most recent recorded outcome was a pass.
    LastGreen {
        #[serde(flatten)]
        green: LastGreen,
    },
    /// The file's most recent recorded outcomes are a run of failures.
    #[serde(rename_all = "camelCase")]
    RedStreak {
        /// Length of the consecutive failing tail — not every red ever
        /// recorded.
        count: i64,
        back_to_sha: String,
        back_to_date: String,
        /// The smallest and largest batch size across the streak. Equal when
        /// every red ran at the same size, which is the common case and reads
        /// as one number.
        min_files_in_run: i64,
        max_files_in_run: i64,
        /// The green before the streak, when there is one.
        #[serde(skip_serializing_if = "Option::is_none")]
        last_green: Option<LastGreen>,
    },
    /// Nothing recorded for this file on this base root.
    NoHistory,
}

/// A file paired with its answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileHistory {
    pub file: String,
    #[serde(flatten)]
    pub history: History,
}

/// The machine-global ledger path.
pub fn default_path() -> PathBuf {
    tugcore::instance::apptest_results_db_path()
}

/// Open (or create) the ledger, bringing the schema to the current version.
pub fn open_ledger(path: impl AsRef<Path>) -> Result<Connection, ApptestLedgerError> {
    if let Some(dir) = path.as_ref().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = tugcore::ledger_db::open(path)?;
    prepare(&conn)?;
    Ok(conn)
}

/// Bring a connection's schema to the current version. Split out so tests can
/// exercise it against an in-memory connection.
fn prepare(conn: &Connection) -> Result<(), ApptestLedgerError> {
    // `results` cascades from `runs`, and SQLite leaves foreign keys off per
    // connection unless asked — asserted here rather than assumed of
    // `ledger_db::apply_pragmas`, whose contract is journaling.
    conn.pragma_update(None, "foreign_keys", true)?;
    // A version newer than this build means a newer tugtool owns the shape:
    // refuse the open rather than writing rows against an unknown schema. The
    // recipe treats an unopenable ledger as absent, and absence is loud.
    let on_disk: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if on_disk > APPTEST_RESULTS_SCHEMA_VERSION {
        return Err(ApptestLedgerError::SchemaTooNew {
            on_disk,
            supported: APPTEST_RESULTS_SCHEMA_VERSION,
        });
    }
    if on_disk > 0 && on_disk < APPTEST_RESULTS_SCHEMA_VERSION {
        for (from, sql) in APPTEST_RESULTS_MIGRATIONS {
            if *from >= on_disk {
                conn.execute_batch(sql)?;
            }
        }
    }
    conn.execute_batch(CREATE_APPTEST_RESULTS_SQL)?;
    conn.pragma_update(None, "user_version", APPTEST_RESULTS_SCHEMA_VERSION)?;
    Ok(())
}

/// Resolve a run root to the base checkout every history query keys on: a
/// linked worktree resolves to the checkout it was forked from, and anything
/// else is its own base. Canonicalized so two spellings of one path are one
/// key; an uncanonicalizable path (a root since deleted) keeps its literal
/// form rather than failing the record.
pub fn resolve_base_root(run_root: &Path) -> String {
    let base =
        tugcore::registry::linked_worktree_base(run_root).unwrap_or_else(|| run_root.to_path_buf());
    base.canonicalize()
        .unwrap_or(base)
        .to_string_lossy()
        .into_owned()
}

/// Record one run and its per-file results, then prune this base root's
/// history back to [`MAX_RUNS_PER_ROOT`].
pub fn record_run(
    conn: &mut Connection,
    run: &RunRecord,
) -> Result<RecordedRun, ApptestLedgerError> {
    let base_root = resolve_base_root(Path::new(&run.run_root));
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO runs
            (started_at, ended_at, base_root, run_root, branch, head_sha,
             dirty, sweep, selection, wall_secs, verdict)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            run.started_at,
            run.ended_at,
            base_root,
            run.run_root,
            run.branch,
            run.head_sha,
            i64::from(run.dirty),
            run.sweep,
            run.selection,
            run.wall_secs,
            run.verdict,
        ],
    )?;
    let run_id = tx.last_insert_rowid();
    {
        let mut insert = tx.prepare(
            "INSERT INTO results (run_id, file, status, passed, total, secs, foreground)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for file in &run.files {
            insert.execute(params![
                run_id,
                file.file,
                file.status,
                file.passed,
                file.total,
                file.secs,
                i64::from(file.foreground),
            ])?;
        }
    }
    let pruned = tx.execute(
        "DELETE FROM runs
          WHERE base_root = ?1
            AND id NOT IN (
                SELECT id FROM runs WHERE base_root = ?1
                 ORDER BY id DESC LIMIT ?2
            )",
        params![base_root, MAX_RUNS_PER_ROOT],
    )?;
    tx.commit()?;
    Ok(RecordedRun { run_id, pruned })
}

/// One row of a file's recorded outcomes, newest first.
struct Outcome {
    status: String,
    head_sha: String,
    date: String,
    dirty: bool,
    /// How many recorded runs of this file separate it from the newest.
    runs_ago: i64,
    /// How many files actually ran in that run.
    files_in_run: i64,
}

/// The three answers, per file, for the given base root.
///
/// `SKIP` rows are excluded from consideration entirely — a file the runner
/// skipped tells the reader nothing about whether it works.
pub fn file_history(
    conn: &Connection,
    base_root: &str,
    files: &[String],
) -> Result<Vec<FileHistory>, ApptestLedgerError> {
    let mut stmt = conn.prepare(
        "SELECT r.status, u.head_sha, DATE(u.ended_at, 'unixepoch'), u.dirty,
                (SELECT COUNT(*) FROM results b
                  WHERE b.run_id = u.id AND b.status <> 'SKIP')
           FROM results r JOIN runs u ON u.id = r.run_id
          WHERE u.base_root = ?1 AND r.file = ?2 AND r.status <> 'SKIP'
          ORDER BY u.id DESC",
    )?;
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        let outcomes: Vec<Outcome> = stmt
            .query_map(params![base_root, file], |row| {
                Ok(Outcome {
                    status: row.get(0)?,
                    head_sha: row.get(1)?,
                    date: row.get(2)?,
                    dirty: row.get::<_, i64>(3)? != 0,
                    runs_ago: 0,
                    files_in_run: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .enumerate()
            .map(|(idx, mut o)| {
                o.runs_ago = idx as i64;
                o
            })
            .collect();
        out.push(FileHistory {
            file: file.clone(),
            history: answer_from(&outcomes),
        });
    }
    Ok(out)
}

fn answer_from(outcomes: &[Outcome]) -> History {
    let Some(newest) = outcomes.first() else {
        return History::NoHistory;
    };
    let green = |o: &Outcome| LastGreen {
        sha: o.head_sha.clone(),
        date: o.date.clone(),
        runs_ago: o.runs_ago,
        dirty: o.dirty,
        files_in_run: o.files_in_run,
    };
    if newest.status == "PASS" {
        return History::LastGreen {
            green: green(newest),
        };
    }
    let streak: Vec<&Outcome> = outcomes.iter().take_while(|o| o.status != "PASS").collect();
    let oldest = streak.last().copied().unwrap_or(newest);
    History::RedStreak {
        count: streak.len() as i64,
        back_to_sha: oldest.head_sha.clone(),
        back_to_date: oldest.date.clone(),
        min_files_in_run: streak.iter().map(|o| o.files_in_run).min().unwrap_or(0),
        max_files_in_run: streak.iter().map(|o| o.files_in_run).max().unwrap_or(0),
        last_green: outcomes.iter().find(|o| o.status == "PASS").map(green),
    }
}

/// How many runs are recorded for a base root — the retention tests' witness,
/// and a cheap answer for anything that wants to know whether a checkout has
/// any history at all.
pub fn run_count(conn: &Connection, base_root: &str) -> Result<i64, ApptestLedgerError> {
    Ok(conn
        .query_row(
            "SELECT COUNT(*) FROM runs WHERE base_root = ?1",
            params![base_root],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(dir: &Path) -> Connection {
        open_ledger(dir.join("apptest_results.db")).unwrap()
    }

    fn run(root: &str, sha: &str, at: i64, files: Vec<FileResult>) -> RunRecord {
        let verdict = match files
            .iter()
            .all(|f| f.status != "FAIL" && f.status != "ERR")
        {
            true => "PASS",
            false => "FAIL",
        };
        RunRecord {
            started_at: at - 60,
            ended_at: at,
            run_root: root.to_string(),
            branch: "main".into(),
            head_sha: sha.into(),
            dirty: false,
            sweep: "explicit-files".into(),
            selection: "explicit".into(),
            wall_secs: 60,
            verdict: verdict.into(),
            files,
        }
    }

    fn file(name: &str, status: &str) -> FileResult {
        FileResult {
            file: name.into(),
            status: status.into(),
            passed: if status == "PASS" { 3 } else { 1 },
            total: 3,
            secs: 20,
            foreground: false,
        }
    }

    fn history_of(conn: &Connection, root: &str, name: &str) -> History {
        file_history(conn, &resolve_base_root(Path::new(root)), &[name.into()])
            .unwrap()
            .remove(0)
            .history
    }

    /// **The batch-pressure fact.** Three files pass in isolation and fail in
    /// a sixteen-file batch, and until the run's size rode the answer the
    /// `history:` line recorded *the run* without recording *the run's size* —
    /// so a defect and a contention read identically. A file green alone and
    /// red only in batches is contention; one red alone too is a defect.
    ///
    /// Derived from the run's own result rows rather than stored beside them,
    /// so the count and the rows it counts cannot disagree. A `SKIP` never
    /// ran, so it never contended and is not counted.
    #[test]
    fn every_outcome_names_the_batch_it_ran_in() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());

        // Green alone.
        record_run(
            &mut conn,
            &run(
                &root,
                "aaa1111",
                1_700_000_000,
                vec![file("at0478.test.ts", "PASS")],
            ),
        )
        .unwrap();
        match history_of(&conn, &root, "at0478.test.ts") {
            History::LastGreen { green } => assert_eq!(green.files_in_run, 1),
            other => panic!("expected last-green, got {other:?}"),
        }

        // Red in a batch of four — one of which was skipped, so the batch it
        // actually contended with is three.
        let mut batch: Vec<FileResult> = (0..2)
            .map(|i| file(&format!("neighbour{i}.test.ts"), "PASS"))
            .collect();
        batch.push(file("skipped.test.ts", "SKIP"));
        batch.push(file("at0478.test.ts", "FAIL"));
        record_run(&mut conn, &run(&root, "bbb2222", 1_700_086_400, batch)).unwrap();

        // Red again, alone this time — which is what turns the reading from
        // contention into a defect, and the range is what shows it.
        record_run(
            &mut conn,
            &run(
                &root,
                "ccc3333",
                1_700_172_800,
                vec![file("at0478.test.ts", "FAIL")],
            ),
        )
        .unwrap();

        match history_of(&conn, &root, "at0478.test.ts") {
            History::RedStreak {
                count,
                min_files_in_run,
                max_files_in_run,
                last_green,
                ..
            } => {
                assert_eq!(count, 2);
                assert_eq!(min_files_in_run, 1, "the newer red ran alone");
                assert_eq!(
                    max_files_in_run, 3,
                    "the older red ran with two neighbours; the skip never ran"
                );
                assert_eq!(
                    last_green.expect("a green before the streak").files_in_run,
                    1
                );
            }
            other => panic!("expected red-streak, got {other:?}"),
        }
    }

    #[test]
    fn fresh_open_creates_schema_and_reopen_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("apptest_results.db");
        {
            let conn = open_ledger(&path).unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(version, APPTEST_RESULTS_SCHEMA_VERSION);
            let fk: i64 = conn
                .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
                .unwrap();
            assert_eq!(fk, 1, "the cascade needs foreign keys on");
        }
        let again = open_ledger(&path).unwrap();
        let version: i64 = again
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, APPTEST_RESULTS_SCHEMA_VERSION);
    }

    #[test]
    fn two_runs_record_and_the_newer_green_is_one_run_ago() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        record_run(
            &mut conn,
            &run(
                &root,
                "aaa1111",
                1_700_000_000,
                vec![file("at0001.test.ts", "PASS")],
            ),
        )
        .unwrap();
        record_run(
            &mut conn,
            &run(
                &root,
                "bbb2222",
                1_700_086_400,
                vec![file("at0002.test.ts", "PASS")],
            ),
        )
        .unwrap();
        assert_eq!(
            run_count(&conn, &resolve_base_root(Path::new(&root))).unwrap(),
            2
        );
        // at0001 passed in the older run, and one recorded run has happened
        // since — but `runs_ago` counts this file's recorded outcomes, and
        // at0001 appears in only one of the two runs.
        match history_of(&conn, &root, "at0001.test.ts") {
            History::LastGreen { green } => {
                assert_eq!(green.sha, "aaa1111");
                assert_eq!(green.runs_ago, 0);
                assert!(!green.dirty);
            }
            other => panic!("expected last-green, got {other:?}"),
        }
    }

    #[test]
    fn runs_ago_counts_this_files_recorded_outcomes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        let name = "at0417.test.ts";
        record_run(
            &mut conn,
            &run(&root, "aaa1111", 1_700_000_000, vec![file(name, "PASS")]),
        )
        .unwrap();
        record_run(
            &mut conn,
            &run(&root, "bbb2222", 1_700_086_400, vec![file(name, "FAIL")]),
        )
        .unwrap();
        match history_of(&conn, &root, name) {
            History::RedStreak { last_green, .. } => {
                let green = last_green.expect("green before the streak");
                assert_eq!(green.sha, "aaa1111");
                assert_eq!(green.runs_ago, 1);
            }
            other => panic!("expected red-streak, got {other:?}"),
        }
    }

    #[test]
    fn the_streak_counts_only_the_consecutive_tail() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        let name = "at0417.test.ts";
        for (idx, status) in ["FAIL", "FAIL", "PASS", "FAIL"].iter().enumerate() {
            let at = 1_700_000_000 + (idx as i64 * 86_400);
            record_run(
                &mut conn,
                &run(&root, &format!("sha{idx}"), at, vec![file(name, status)]),
            )
            .unwrap();
        }
        match history_of(&conn, &root, name) {
            History::RedStreak {
                count,
                back_to_sha,
                last_green,
                ..
            } => {
                assert_eq!(count, 1, "only the newest FAIL is in the tail");
                assert_eq!(back_to_sha, "sha3");
                let green = last_green.expect("the PASS before the tail");
                assert_eq!(green.sha, "sha2");
                assert_eq!(green.runs_ago, 1);
            }
            other => panic!("expected red-streak, got {other:?}"),
        }
    }

    #[test]
    fn a_worktree_run_answers_a_base_keyed_query_and_the_reverse() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("checkout");
        let worktree = dir.path().join("wt");
        std::fs::create_dir_all(base.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        // A linked worktree's `.git` is a file pointing at its gitdir, and
        // that gitdir's `commondir` points back at the base checkout's `.git`.
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", base.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        std::fs::write(base.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();

        let mut conn = ledger(dir.path());
        let name = "at0417.test.ts";
        // Recorded from the worktree...
        record_run(
            &mut conn,
            &run(
                &worktree.to_string_lossy(),
                "aaa1111",
                1_700_000_000,
                vec![file(name, "PASS")],
            ),
        )
        .unwrap();
        // ...found by a query keyed from the base checkout.
        match history_of(&conn, &base.to_string_lossy(), name) {
            History::LastGreen { green } => assert_eq!(green.sha, "aaa1111"),
            other => panic!("base-keyed query missed the worktree run: {other:?}"),
        }
        // And the reverse: recorded from base, found from the worktree.
        record_run(
            &mut conn,
            &run(
                &base.to_string_lossy(),
                "bbb2222",
                1_700_086_400,
                vec![file(name, "FAIL")],
            ),
        )
        .unwrap();
        match history_of(&conn, &worktree.to_string_lossy(), name) {
            History::RedStreak { back_to_sha, .. } => assert_eq!(back_to_sha, "bbb2222"),
            other => panic!("worktree-keyed query missed the base run: {other:?}"),
        }
    }

    #[test]
    fn a_green_on_a_dirty_tree_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        let name = "at0001.test.ts";
        let mut rec = run(&root, "aaa1111", 1_700_000_000, vec![file(name, "PASS")]);
        rec.dirty = true;
        record_run(&mut conn, &rec).unwrap();
        match history_of(&conn, &root, name) {
            History::LastGreen { green } => assert!(green.dirty),
            other => panic!("expected last-green, got {other:?}"),
        }
    }

    #[test]
    fn retention_prunes_the_oldest_and_cascades_their_results() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a");
        let other = dir.path().join("b");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let mut conn = ledger(dir.path());
        record_run(
            &mut conn,
            &run(
                &other.to_string_lossy(),
                "other",
                1_700_000_000,
                vec![file("at0001.test.ts", "PASS")],
            ),
        )
        .unwrap();
        let mut pruned_total = 0;
        for idx in 0..(MAX_RUNS_PER_ROOT + 2) {
            let recorded = record_run(
                &mut conn,
                &run(
                    &root.to_string_lossy(),
                    &format!("sha{idx}"),
                    1_700_000_000 + idx,
                    vec![file("at0001.test.ts", "PASS")],
                ),
            )
            .unwrap();
            pruned_total += recorded.pruned;
        }
        assert_eq!(pruned_total, 2, "the two oldest runs past the cap");
        let base = resolve_base_root(&root);
        assert_eq!(run_count(&conn, &base).unwrap(), MAX_RUNS_PER_ROOT);
        let orphans: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM results
                  WHERE run_id NOT IN (SELECT id FROM runs)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0, "result rows must cascade with their run");
        assert_eq!(
            run_count(&conn, &resolve_base_root(&other)).unwrap(),
            1,
            "a second base root's runs are untouched"
        );
    }

    #[test]
    fn skip_rows_never_produce_or_influence_an_answer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        let name = "at0001.test.ts";
        record_run(
            &mut conn,
            &run(&root, "aaa1111", 1_700_000_000, vec![file(name, "PASS")]),
        )
        .unwrap();
        record_run(
            &mut conn,
            &run(&root, "bbb2222", 1_700_086_400, vec![file(name, "SKIP")]),
        )
        .unwrap();
        match history_of(&conn, &root, name) {
            History::LastGreen { green } => {
                assert_eq!(green.sha, "aaa1111");
                assert_eq!(green.runs_ago, 0, "the SKIP is not a recorded outcome");
            }
            other => panic!("a SKIP must not become an answer: {other:?}"),
        }
        // A file with nothing but SKIPs has no history at all.
        record_run(
            &mut conn,
            &run(
                &root,
                "ccc3333",
                1_700_172_800,
                vec![file("at0002.test.ts", "SKIP")],
            ),
        )
        .unwrap();
        assert_eq!(
            history_of(&conn, &root, "at0002.test.ts"),
            History::NoHistory
        );
    }

    #[test]
    fn an_unrecorded_file_has_no_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let conn = ledger(dir.path());
        assert_eq!(
            history_of(&conn, &root, "at9999.test.ts"),
            History::NoHistory
        );
    }

    #[test]
    fn the_serialized_answer_is_the_shape_the_recipe_formats_from() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        let name = "at0417.test.ts";
        record_run(
            &mut conn,
            &run(&root, "0519182", 1_755_000_000, vec![file(name, "PASS")]),
        )
        .unwrap();
        record_run(
            &mut conn,
            &run(&root, "dac7cfc", 1_755_086_400, vec![file(name, "FAIL")]),
        )
        .unwrap();
        let answers =
            file_history(&conn, &resolve_base_root(Path::new(&root)), &[name.into()]).unwrap();
        let json = serde_json::to_value(&answers[0]).unwrap();
        assert_eq!(json["file"], name);
        assert_eq!(json["answer"], "red-streak");
        assert_eq!(json["count"], 1);
        assert_eq!(json["backToSha"], "dac7cfc");
        assert_eq!(json["backToDate"], "2025-08-13");
        assert_eq!(json["lastGreen"]["sha"], "0519182");
        assert_eq!(json["lastGreen"]["runsAgo"], 1);
        assert_eq!(json["lastGreen"]["dirty"], false);
        let none = serde_json::to_value(FileHistory {
            file: "at9999.test.ts".into(),
            history: History::NoHistory,
        })
        .unwrap();
        assert_eq!(none["answer"], "no-history");
    }

    #[test]
    fn a_missing_selection_records_as_explicit() {
        let payload = r#"{
            "startedAt": 1, "endedAt": 2, "runRoot": "/tmp/x", "branch": "main",
            "headSha": "abc", "dirty": false, "sweep": "core",
            "wallSecs": 1, "verdict": "PASS", "files": []
        }"#;
        let parsed: RunRecord = serde_json::from_str(payload).unwrap();
        assert_eq!(parsed.selection, "explicit");
    }
}
