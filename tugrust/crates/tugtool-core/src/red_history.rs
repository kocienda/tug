//! Whose red a red verify's failing tests are.
//!
//! A verify that ends red names its failing checks; this says, for each test
//! those checks failed, what the records hold about it on the arc's base
//! branch: failing there too and since which commit, green there, or never
//! run there. And it names the reds that fail with the same message, which is
//! how one defect behind several tests shows itself.
//!
//! Two ledgers answer. The general test ledger ([`crate::test_ledger`]) keeps
//! every run recorded through `tugtool test run` or `test record`, in any
//! project, with one row per failing test; the app-test ledger
//! ([`crate::apptest_ledger`]) keeps one outcome per app-test file. Both key
//! their runs by the base checkout, which a checkout and its arc worktrees
//! share, and both record the branch a run stood on — so the base branch's
//! own runs can be read apart from the arc's.
//!
//! The answer is advice printed beside the red. It never turns a red green and
//! never leaves a check out: where the defect came from is not whose it is.

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::apptest_ledger::{self, History};

/// The sentence a red verify closes on.
pub const WHOSE_RED: &str = "A red inherited from the base is this arc's to fix, as ordinary rounds: \"red on the base\" says where the defect came from, never whose it is.";

/// The suite name an app-test file's red is reported under.
pub const APPTEST_SUITE: &str = "app-test";

/// What the records hold about one failing test on the base branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "onBase", rename_all = "kebab-case")]
pub enum BaseRecord {
    /// The newest recorded run on the base failed it too, as did every run
    /// back to `since_sha`.
    #[serde(rename_all = "camelCase")]
    Red {
        since_sha: String,
        /// UTC date of that run, `YYYY-MM-DD`.
        since_date: String,
        /// How many recorded runs the streak spans.
        runs: i64,
    },
    /// The newest recorded run on the base passed it.
    #[serde(rename_all = "camelCase")]
    Green { sha: String, date: String },
    /// No recorded run on the base ran it.
    NeverRun,
}

/// One failing test, with what the base's record says of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedTest {
    /// The suite its run recorded under, or [`APPTEST_SUITE`].
    pub suite: String,
    pub file: String,
    /// The test's name; for an app-test, its file.
    pub name: String,
    /// The failure's one-line reason; empty when the record has none.
    pub message: String,
    #[serde(flatten)]
    pub base: BaseRecord,
    /// The other reds in this verify that fail with the same message.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub same_message_as: Vec<String>,
}

/// Where a red verify's runs are found, and the branch to read history on.
#[derive(Debug, Clone, Copy)]
pub struct Scope<'a> {
    /// The base checkout both ledgers key runs by.
    pub base_root: &'a str,
    /// The arc's base branch, as the ledgers record a branch.
    pub base_branch: &'a str,
    /// The full sha the verify checked.
    pub head: &'a str,
    /// Epoch seconds the verify began; runs older than this are not its.
    pub since: i64,
}

/// Every failing test the verify's checks recorded, with what the base's
/// record says of each, in the order they were recorded. A ledger that is
/// absent answers nothing, and a query that fails is skipped rather than
/// failing the verify it advises.
pub fn attribute(
    tests: Option<&Connection>,
    apptests: Option<&Connection>,
    scope: Scope<'_>,
) -> Vec<RedTest> {
    let mut reds = Vec::new();
    if let Some(conn) = tests {
        for (suite, file, name, message) in suite_reds(conn, scope).unwrap_or_default() {
            let Ok(base) = failure_on_branch(conn, scope, &suite, &file, &name) else {
                continue;
            };
            reds.push(RedTest {
                suite,
                file,
                name,
                message,
                base,
                same_message_as: Vec::new(),
            });
        }
    }
    if let Some(conn) = apptests {
        let files = apptest_reds(conn, scope).unwrap_or_default();
        let answers =
            apptest_ledger::file_history_on(conn, scope.base_root, Some(scope.base_branch), &files)
                .unwrap_or_default();
        for answer in answers {
            reds.push(RedTest {
                suite: APPTEST_SUITE.to_string(),
                file: answer.file.clone(),
                name: answer.file,
                message: String::new(),
                base: base_of_history(&answer.history),
                same_message_as: Vec::new(),
            });
        }
    }
    link_shared_messages(&mut reds);
    reds
}

/// The failures the test ledger recorded at `scope.head` since the verify
/// began, one per suite, file and name.
fn suite_reds(
    conn: &Connection,
    scope: Scope<'_>,
) -> rusqlite::Result<Vec<(String, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT r.suite, f.file, f.name, f.message
           FROM failures f JOIN runs r ON r.id = f.run_id
          WHERE r.base_root = ?1 AND r.head_sha = ?2 AND r.started_at >= ?3
          ORDER BY r.id, f.rowid",
    )?;
    let rows = stmt
        .query_map(params![scope.base_root, scope.head, scope.since], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<(String, String, String, String)>>>()?;
    let mut seen = std::collections::HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|(suite, file, name, _)| seen.insert((suite.clone(), file.clone(), name.clone())))
        .collect())
}

/// What the suite's recorded runs on the base branch say of one test. A run
/// that left no readable document says nothing and is passed over; a run
/// with one that names no such failure passed it.
fn failure_on_branch(
    conn: &Connection,
    scope: Scope<'_>,
    suite: &str,
    file: &str,
    name: &str,
) -> rusqlite::Result<BaseRecord> {
    let mut stmt = conn.prepare(
        "SELECT r.head_sha, DATE(r.ended_at, 'unixepoch'),
                EXISTS (SELECT 1 FROM failures f
                         WHERE f.run_id = r.id AND f.file = ?4 AND f.name = ?5)
           FROM runs r
          WHERE r.base_root = ?1 AND r.branch = ?2 AND r.suite = ?3
            AND r.has_record = 1
          ORDER BY r.id DESC",
    )?;
    let runs = stmt
        .query_map(
            params![scope.base_root, scope.base_branch, suite, file, name],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(match runs.first() {
        None => BaseRecord::NeverRun,
        Some((sha, date, false)) => BaseRecord::Green {
            sha: sha.clone(),
            date: date.clone(),
        },
        Some(_) => {
            let streak: Vec<_> = runs.iter().take_while(|(_, _, failed)| *failed).collect();
            let (sha, date, _) = streak.last().copied().unwrap_or(&runs[0]);
            BaseRecord::Red {
                since_sha: sha.clone(),
                since_date: date.clone(),
                runs: streak.len() as i64,
            }
        }
    })
}

/// The app-test files that did not pass in a run at `scope.head` since the
/// verify began. The runner records a short head, so a run's head matches
/// when it is a prefix of the verified one.
fn apptest_reds(conn: &Connection, scope: Scope<'_>) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT r.file, MIN(u.id)
           FROM results r JOIN runs u ON u.id = r.run_id
          WHERE u.base_root = ?1 AND u.started_at >= ?3
            AND length(u.head_sha) >= 7 AND substr(?2, 1, length(u.head_sha)) = u.head_sha
            AND r.status NOT IN ('PASS', 'SKIP', 'WEDGED', 'STALLED')
          GROUP BY r.file
          ORDER BY 2, r.file",
    )?;
    let files = stmt
        .query_map(params![scope.base_root, scope.head, scope.since], |row| {
            row.get(0)
        })?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(files)
}

fn base_of_history(history: &History) -> BaseRecord {
    match history {
        History::LastGreen { green } => BaseRecord::Green {
            sha: green.sha.clone(),
            date: green.date.clone(),
        },
        History::RedStreak {
            count,
            back_to_sha,
            back_to_date,
            ..
        } => BaseRecord::Red {
            since_sha: back_to_sha.clone(),
            since_date: back_to_date.clone(),
            runs: *count,
        },
        History::NoHistory => BaseRecord::NeverRun,
    }
}

/// Fill each red's `same_message_as` with the other reds whose message is
/// the same, non-empty one.
fn link_shared_messages(reds: &mut [RedTest]) {
    let names: Vec<(String, String)> = reds
        .iter()
        .map(|r| (r.message.clone(), r.name.clone()))
        .collect();
    for (i, red) in reds.iter_mut().enumerate() {
        if red.message.is_empty() {
            continue;
        }
        red.same_message_as = names
            .iter()
            .enumerate()
            .filter(|(j, (message, _))| *j != i && *message == red.message)
            .map(|(_, (_, name))| name.clone())
            .collect();
    }
}

/// One red's line, as a verify report prints it.
pub fn describe(red: &RedTest, base_branch: &str) -> String {
    let short = |sha: &str| sha.chars().take(10).collect::<String>();
    let base = match &red.base {
        BaseRecord::Red {
            since_sha,
            since_date,
            runs,
        } => {
            let runs = if *runs == 1 {
                "1 recorded run".to_string()
            } else {
                format!("{runs} recorded runs")
            };
            format!(
                "red on {base_branch} too, since {} ({since_date}, {runs})",
                short(since_sha)
            )
        }
        BaseRecord::Green { sha, date } => {
            format!("green on {base_branch} at {} ({date})", short(sha))
        }
        BaseRecord::NeverRun => format!("never run on {base_branch}"),
    };
    let mut line = format!("{} {}: {base}", red.suite, red.name);
    if !red.same_message_as.is_empty() {
        line.push_str(&format!(
            "; same message as {}",
            red.same_message_as.join(", ")
        ));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apptest_ledger::{FileResult, RunRecord};
    use crate::test_ledger::{JunitFailure, JunitRun, TestRun};
    use std::path::Path;

    const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Seed {
        _dir: tempfile::TempDir,
        root: String,
        base_root: String,
        tests: Connection,
        apptests: Connection,
    }

    fn seed() -> Seed {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.to_string_lossy().into_owned();
        let base_root = apptest_ledger::resolve_base_root(Path::new(&root));
        let tests = crate::test_ledger::open_ledger(dir.path().join("t.db")).unwrap();
        let apptests = apptest_ledger::open_ledger(dir.path().join("a.db")).unwrap();
        Seed {
            _dir: dir,
            root,
            base_root,
            tests,
            apptests,
        }
    }

    fn failure(name: &str, message: &str) -> JunitFailure {
        JunitFailure {
            file: "crate".to_string(),
            name: name.to_string(),
            classname: String::new(),
            message: message.to_string(),
            detail: String::new(),
        }
    }

    fn test_run(seed: &mut Seed, branch: &str, head: &str, at: i64, failures: Vec<JunitFailure>) {
        let run = TestRun {
            started_at: at,
            ended_at: at,
            run_root: seed.root.clone(),
            branch: branch.to_string(),
            head_sha: head.to_string(),
            dirty: false,
            suite: "rust".to_string(),
            session_id: None,
            tool_use_id: None,
            input_key: None,
            command: "cargo nextest run".to_string(),
            exit_code: i64::from(!failures.is_empty()),
            wall_secs: 1.0,
        };
        let doc = JunitRun {
            tests: 10,
            failed: failures.len() as i64,
            skipped: 0,
            files: Vec::new(),
            failures,
        };
        crate::test_ledger::record_run(&mut seed.tests, &run, Some(&doc)).unwrap();
    }

    fn apptest_run(seed: &mut Seed, branch: &str, head: &str, at: i64, files: &[(&str, &str)]) {
        let run = RunRecord {
            started_at: at,
            ended_at: at,
            run_root: seed.root.clone(),
            branch: branch.to_string(),
            head_sha: head.to_string(),
            dirty: false,
            sweep: "explicit-files".to_string(),
            selection: "explicit".to_string(),
            wall_secs: 1,
            verdict: "FAIL".to_string(),
            stopped_reason: None,
            files: files
                .iter()
                .map(|(file, status)| FileResult {
                    file: file.to_string(),
                    status: status.to_string(),
                    passed: 0,
                    total: 1,
                    secs: 5,
                    foreground: false,
                })
                .collect(),
        };
        apptest_ledger::record_run(&mut seed.apptests, &run).unwrap();
    }

    fn scope(seed: &Seed) -> Scope<'_> {
        Scope {
            base_root: &seed.base_root,
            base_branch: "main",
            head: HEAD,
            since: 5_000,
        }
    }

    fn attribute_seed(seed: &Seed) -> Vec<RedTest> {
        attribute(Some(&seed.tests), Some(&seed.apptests), scope(seed))
    }

    #[test]
    fn a_red_failing_on_the_base_says_since_when() {
        let mut seed = seed();
        test_run(&mut seed, "main", "b1", 1_000, vec![]);
        test_run(
            &mut seed,
            "main",
            "b2",
            2_000,
            vec![failure("t::slow", "boom")],
        );
        test_run(
            &mut seed,
            "main",
            "b3",
            3_000,
            vec![failure("t::slow", "boom")],
        );
        // The arc's own earlier red is not the base's record.
        test_run(
            &mut seed,
            "tugarc/demo",
            "x",
            4_000,
            vec![failure("t::slow", "boom")],
        );
        test_run(
            &mut seed,
            "tugarc/demo",
            HEAD,
            5_000,
            vec![failure("t::slow", "boom")],
        );
        let reds = attribute_seed(&seed);
        assert_eq!(reds.len(), 1);
        assert_eq!(
            reds[0].base,
            BaseRecord::Red {
                since_sha: "b2".to_string(),
                since_date: "1970-01-01".to_string(),
                runs: 2,
            }
        );
        assert_eq!(
            describe(&reds[0], "main"),
            "rust t::slow: red on main too, since b2 (1970-01-01, 2 recorded runs)"
        );
    }

    #[test]
    fn a_red_the_base_passed_says_green_there() {
        let mut seed = seed();
        test_run(
            &mut seed,
            "main",
            "b1",
            1_000,
            vec![failure("t::new", "boom")],
        );
        test_run(
            &mut seed,
            "main",
            "b2",
            2_000,
            vec![failure("t::other", "x")],
        );
        test_run(
            &mut seed,
            "tugarc/demo",
            HEAD,
            5_000,
            vec![failure("t::new", "boom")],
        );
        let reds = attribute_seed(&seed);
        assert_eq!(
            reds[0].base,
            BaseRecord::Green {
                sha: "b2".to_string(),
                date: "1970-01-01".to_string(),
            }
        );
    }

    #[test]
    fn a_red_with_no_base_run_says_never_run() {
        let mut seed = seed();
        // A run before the verify began is not one of its reds.
        test_run(
            &mut seed,
            "tugarc/demo",
            HEAD,
            4_000,
            vec![failure("t::old", "boom")],
        );
        test_run(
            &mut seed,
            "tugarc/demo",
            HEAD,
            5_000,
            vec![failure("t::lonely", "boom")],
        );
        apptest_run(
            &mut seed,
            "tugarc/demo",
            "aaaaaaa",
            5_100,
            &[("at0001-x.test.ts", "OVERTIME")],
        );
        let reds = attribute_seed(&seed);
        let names: Vec<&str> = reds.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["t::lonely", "at0001-x.test.ts"]);
        assert!(reds.iter().all(|r| r.base == BaseRecord::NeverRun));
        assert_eq!(
            describe(&reds[1], "main"),
            "app-test at0001-x.test.ts: never run on main"
        );
    }

    #[test]
    fn an_apptest_red_reads_the_base_branchs_outcomes() {
        let mut seed = seed();
        apptest_run(
            &mut seed,
            "main",
            "b1aaaaa",
            1_000,
            &[("at0002-y.test.ts", "PASS")],
        );
        apptest_run(
            &mut seed,
            "main",
            "b2aaaaa",
            2_000,
            &[("at0002-y.test.ts", "FAIL")],
        );
        apptest_run(
            &mut seed,
            "tugarc/demo",
            "ccccccc",
            3_000,
            &[("at0002-y.test.ts", "PASS")],
        );
        apptest_run(
            &mut seed,
            "tugarc/demo",
            "aaaaaaa",
            5_000,
            &[("at0002-y.test.ts", "FAIL"), ("at0003-z.test.ts", "PASS")],
        );
        let reds = attribute_seed(&seed);
        assert_eq!(reds.len(), 1, "only the file that did not pass");
        assert_eq!(
            reds[0].base,
            BaseRecord::Red {
                since_sha: "b2aaaaa".to_string(),
                since_date: "1970-01-01".to_string(),
                runs: 1,
            }
        );
    }

    #[test]
    fn reds_failing_with_one_message_name_each_other() {
        let mut seed = seed();
        test_run(
            &mut seed,
            "tugarc/demo",
            HEAD,
            5_000,
            vec![
                failure("t::a", "noResponder"),
                failure("t::b", "noResponder"),
                failure("t::c", "other"),
                failure("t::d", ""),
                failure("t::e", ""),
            ],
        );
        let reds = attribute_seed(&seed);
        let shared: Vec<(&str, Vec<String>)> = reds
            .iter()
            .map(|r| (r.name.as_str(), r.same_message_as.clone()))
            .collect();
        assert_eq!(
            shared,
            [
                ("t::a", vec!["t::b".to_string()]),
                ("t::b", vec!["t::a".to_string()]),
                ("t::c", vec![]),
                ("t::d", vec![]),
                ("t::e", vec![]),
            ]
        );
        assert!(describe(&reds[0], "main").ends_with("; same message as t::b"));
    }

    #[test]
    fn absent_ledgers_answer_nothing() {
        let seed = seed();
        assert!(attribute(None, None, scope(&seed)).is_empty());
    }

    #[test]
    fn the_json_shape_carries_the_base_answer_flat() {
        let red = RedTest {
            suite: "rust".to_string(),
            file: "crate".to_string(),
            name: "t::a".to_string(),
            message: "boom".to_string(),
            base: BaseRecord::Red {
                since_sha: "b2".to_string(),
                since_date: "2026-11-20".to_string(),
                runs: 3,
            },
            same_message_as: Vec::new(),
        };
        let value = serde_json::to_value(&red).unwrap();
        assert_eq!(value["onBase"], "red");
        assert_eq!(value["sinceSha"], "b2");
        assert_eq!(value["runs"], 3);
        assert!(value.get("sameMessageAs").is_none());
    }
}
