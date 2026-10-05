//! The `test` namespace — `tugtool test record|last`.
//!
//! The way into and out of the unit-test results ledger. `record` reads one
//! junit document into it; `last` names what the latest run of each suite
//! failed, so a red run whose output was filtered or scrolled away is
//! answered without running the suite a second time.
//!
//! `record` prints bare JSON, the same convention as `apptest record`. `last`
//! prints text, or the same report as JSON under the global `--json` — both
//! renderings read one [`LastReport`], so they cannot drift.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tugtool_core::apptest_ledger::resolve_base_root;
use tugtool_core::test_ledger::{self, JunitRun, SuiteRun, TestRun};

use crate::changes::AppError;

/// Seconds since the epoch, now.
pub(crate) fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The directory a verb acts for: `--root`, else the cwd.
fn root_or_cwd(root: Option<PathBuf>) -> Result<PathBuf, AppError> {
    match root {
        Some(r) => Ok(r),
        None => std::env::current_dir()
            .map_err(|err| AppError::Exit1(format!("cannot resolve the run root: {err}"))),
    }
}

/// Branch, `HEAD` and dirtiness of the checkout at `root`. Empty and false on
/// any failure — a run outside a checkout is still a run worth recording.
pub(crate) fn git_facts(root: &Path) -> (String, String, bool) {
    let ask = |args: &[&str]| -> Option<String> {
        let out = tugcore::git_command()
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let branch = ask(&["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let head = ask(&["rev-parse", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let dirty = ask(&["status", "--porcelain"]).is_some_and(|s| !s.trim().is_empty());
    (branch, head, dirty)
}

/// Read a junit document, or say why it could not be read.
pub(crate) fn read_junit(path: &Path) -> Result<JunitRun, String> {
    let xml = std::fs::read_to_string(path)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    test_ledger::parse_junit(&xml).map_err(|err| format!("{}: {err}", path.display()))
}

/// Record one run of `suite` in the ledger at its default path.
pub(crate) fn record(
    run: &TestRun,
    junit: Option<&JunitRun>,
) -> Result<test_ledger::RecordedRun, String> {
    let mut conn = test_ledger::open_ledger(test_ledger::default_path())
        .map_err(|err| format!("cannot open the test results ledger: {err}"))?;
    test_ledger::record_run(&mut conn, run, junit)
        .map_err(|err| format!("cannot record the run: {err}"))
}

/// `tugtool test record`.
pub fn run_record(
    suite: String,
    junit: PathBuf,
    root: Option<PathBuf>,
    exit_code: i64,
    started_at: Option<i64>,
    command: Option<String>,
) -> Result<(), AppError> {
    let run_root = test_ledger::run_root_for(&root_or_cwd(root)?);
    let (branch, head_sha, dirty) = git_facts(&run_root);
    let ended_at = now_epoch();
    let started_at = started_at.unwrap_or(ended_at);
    let doc = read_junit(&junit);
    if let Err(why) = &doc {
        eprintln!("[test] no per-test record: {why}");
    }
    let run = TestRun {
        started_at,
        ended_at,
        run_root: run_root.to_string_lossy().into_owned(),
        branch,
        head_sha,
        dirty,
        suite,
        session_id: None,
        command: command.unwrap_or_default(),
        exit_code,
        wall_secs: (ended_at - started_at).max(0) as f64,
    };
    let recorded = record(&run, doc.as_ref().ok()).map_err(AppError::Exit1)?;
    println!(
        "{}",
        serde_json::json!({
            "recorded": true,
            "runId": recorded.run_id,
            "pruned": recorded.pruned,
            "hasRecord": doc.is_ok(),
        })
    );
    Ok(())
}

/// What `test last` says, in either rendering.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LastReport {
    base_root: String,
    runs: Vec<SuiteRun>,
}

/// `tugtool test last`. A ledger that cannot be opened is reported on stderr
/// and answered as nothing recorded: the verb is a reader, and exits 0.
pub fn run_last(
    failures_only: bool,
    suite: Option<String>,
    root: Option<PathBuf>,
    json: bool,
) -> Result<(), AppError> {
    let base_root = resolve_base_root(&test_ledger::run_root_for(&root_or_cwd(root)?));
    let runs = test_ledger::open_ledger(test_ledger::default_path())
        .and_then(|conn| test_ledger::latest_per_suite(&conn, &base_root, suite.as_deref()))
        .unwrap_or_else(|err| {
            eprintln!("[test] cannot read the test results ledger: {err}");
            Vec::new()
        });
    let report = LastReport { base_root, runs };
    if json {
        println!(
            "{}",
            serde_json::to_string(&report).map_err(|err| AppError::Exit1(err.to_string()))?
        );
    } else {
        print!("{}", render_last(&report, failures_only));
    }
    Ok(())
}

fn render_last(report: &LastReport, failures_only: bool) -> String {
    let mut out = String::new();
    if report.runs.is_empty() {
        out.push_str(&format!("no recorded test runs for {}\n", report.base_root));
        return out;
    }
    if failures_only {
        let mut any = false;
        for run in &report.runs {
            if !run.has_record {
                out.push_str(&format!("{}  {}\n", run.suite, NO_RECORD));
                any = true;
            }
            for f in &run.failures {
                out.push_str(&format!("{}  {}", run.suite, failure_lines(f)));
                any = true;
            }
        }
        if !any {
            let suites: Vec<&str> = report.runs.iter().map(|r| r.suite.as_str()).collect();
            out.push_str(&format!(
                "no failures in the latest run of {}\n",
                suites.join(", ")
            ));
        }
        return out;
    }
    for run in &report.runs {
        out.push_str(&header_line(run));
        if !run.has_record {
            out.push_str(&format!("  {NO_RECORD}\n"));
        }
        for f in &run.failures {
            out.push_str(&format!("  {}", failure_lines(f)));
        }
    }
    out
}

const NO_RECORD: &str = "(no per-test record — the junit file was not written)";

/// `<suite>  <PASS|FAIL>  <YYYY-MM-DD HH:MM>  <tests> tests · <failed> failed · <wall>s  (<branch>@<sha7>[, dirty])[  session <id8>]`
fn header_line(run: &SuiteRun) -> String {
    let when = chrono::DateTime::from_timestamp(run.ended_at, 0)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_default();
    let sha: String = run.head_sha.chars().take(7).collect();
    let dirty = if run.dirty { ", dirty" } else { "" };
    let session = run
        .session_id
        .as_deref()
        .map(|id| format!("  session {}", id.chars().take(8).collect::<String>()))
        .unwrap_or_default();
    format!(
        "{}  {}  {}  {} tests · {} failed · {}s  ({}@{}{}){}\n",
        run.suite,
        run.verdict,
        when,
        run.tests,
        run.failed,
        wall(run.wall_secs),
        run.branch,
        sha,
        dirty,
        session
    )
}

/// Whole seconds, except a run under ten seconds keeps one decimal so a quick
/// suite does not read as having taken none.
fn wall(secs: f64) -> String {
    if secs < 10.0 {
        format!("{secs:.1}")
    } else {
        format!("{secs:.0}")
    }
}

/// `(fail) <file> › <name>`, then the message's first line beneath it.
fn failure_lines(f: &test_ledger::JunitFailure) -> String {
    let mut s = format!("(fail) {} › {}\n", f.file, f.name);
    if let Some(line) = f.message.lines().map(str::trim).find(|l| !l.is_empty()) {
        s.push_str(&format!("      {line}\n"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugtool_core::test_ledger::JunitFailure;

    fn suite_run(suite: &str, failures: Vec<JunitFailure>, has_record: bool) -> SuiteRun {
        SuiteRun {
            run_id: 1,
            suite: suite.into(),
            started_at: 0,
            ended_at: 0,
            run_root: "/r".into(),
            branch: "main".into(),
            head_sha: "0123456789abcdef".into(),
            dirty: true,
            session_id: Some("0d75d27c-a1ed-4f32".into()),
            command: "bun test".into(),
            exit_code: 1,
            wall_secs: 3.5,
            tests: 6,
            failed: failures.len() as i64,
            skipped: 0,
            has_record,
            verdict: "FAIL".into(),
            files: Vec::new(),
            failures,
        }
    }

    fn failure(name: &str, message: &str) -> JunitFailure {
        JunitFailure {
            file: "a.test.ts".into(),
            name: name.into(),
            classname: String::new(),
            message: message.into(),
            detail: String::new(),
        }
    }

    #[test]
    fn the_header_names_verdict_counts_tree_and_session() {
        let line = header_line(&suite_run("tugdeck", vec![failure("x", "")], true));
        assert!(line.starts_with("tugdeck  FAIL  "), "{line}");
        assert!(
            line.ends_with("6 tests · 1 failed · 3.5s  (main@0123456, dirty)  session 0d75d27c\n"),
            "{line}"
        );
    }

    #[test]
    fn failures_only_prefixes_each_failure_with_its_suite() {
        let report = LastReport {
            base_root: "/r".into(),
            runs: vec![
                suite_run(
                    "tugdeck",
                    vec![failure("bad two", "expected 2\nmore")],
                    true,
                ),
                suite_run("rust", Vec::new(), false),
            ],
        };
        assert_eq!(
            render_last(&report, true),
            "tugdeck  (fail) a.test.ts › bad two\n      expected 2\n\
             rust  (no per-test record — the junit file was not written)\n"
        );
    }

    #[test]
    fn a_green_latest_run_says_there_were_no_failures() {
        let mut green = suite_run("rust", Vec::new(), true);
        green.verdict = "PASS".into();
        let report = LastReport {
            base_root: "/r".into(),
            runs: vec![green],
        };
        assert_eq!(
            render_last(&report, true),
            "no failures in the latest run of rust\n"
        );
    }
}
