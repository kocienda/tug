//! `tugtool test record` and `tugtool test last`.
//!
//! End to end through `TUG_TEST_RESULTS_DB`, so the suite never touches the
//! real record. What is proven here is the wire: a junit document recorded
//! from one directory is named by `test last` read from the checkout's root.

mod common;
use common::tugtool;

use std::path::Path;
use std::process::Output;

const RED_DOC: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" failures="1" skipped="0" time="0.01">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" failures="1" skipped="0" time="0.01">
    <testcase name="good one" classname="" time="0" file="a.test.ts" line="2" />
    <testcase name="bad two" classname="" time="0" file="a.test.ts" line="3">
      <failure message="expect(received).toBe(expected)" type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
"#;

fn run(db: &Path, cwd: &Path, args: &[&str]) -> Output {
    tugtool()
        .args(args)
        .current_dir(cwd)
        .env("TUG_TEST_RESULTS_DB", db)
        .output()
        .unwrap()
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_recorded_failure_is_named_by_test_last() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let scratch = dir.path().join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    let junit = scratch.join("junit.xml");
    std::fs::write(&junit, RED_DOC).unwrap();

    let out = run(
        &db,
        &scratch,
        &[
            "test",
            "record",
            "--suite",
            "deck",
            "--junit",
            junit.to_str().unwrap(),
            "--exit-code",
            "1",
        ],
    );
    assert!(
        out.status.success(),
        "record exited {:?}: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(receipt["recorded"], true);
    assert_eq!(receipt["hasRecord"], true);

    let out = run(&db, &scratch, &["test", "last", "--failures"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        stdout(&out),
        "deck  (fail) a.test.ts › bad two\n      expect(received).toBe(expected)\n"
    );

    let out = run(&db, &scratch, &["test", "last", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(report["runs"][0]["suite"], "deck");
    assert_eq!(report["runs"][0]["verdict"], "FAIL");
    assert_eq!(report["runs"][0]["failures"][0]["name"], "bad two");
}

#[test]
fn nothing_recorded_is_an_answer_and_exits_zero() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let out = run(&db, dir.path(), &["test", "last", "--failures"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        stdout(&out).starts_with("no recorded test runs for "),
        "{}",
        stdout(&out)
    );
}

#[test]
fn a_missing_document_records_the_run_without_a_per_test_record() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let out = run(
        &db,
        dir.path(),
        &[
            "test",
            "record",
            "--suite",
            "tugcode",
            "--junit",
            "nowhere.xml",
            "--exit-code",
            "1",
        ],
    );
    assert!(out.status.success());
    let out = run(&db, dir.path(), &["test", "last"]);
    let text = stdout(&out);
    assert!(text.starts_with("tugcode  FAIL  "), "{text}");
    assert!(
        text.contains("(no per-test record — the junit file was not written)"),
        "{text}"
    );
}

/// The main-checkout case: `test-ts` records from `tugdeck/`, where `.git` is
/// the parent's directory, and the reader asks from the repository root.
#[test]
fn a_run_recorded_in_a_subdirectory_is_read_from_the_checkout_root() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let checkout = dir.path().join("checkout");
    let sub = checkout.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let init = tugcore::git_command()
        .args(["init", "-q"])
        .current_dir(&checkout)
        .output()
        .unwrap();
    assert!(init.status.success(), "git init failed");
    let junit = sub.join("junit.xml");
    std::fs::write(&junit, RED_DOC).unwrap();

    let out = run(
        &db,
        &sub,
        &[
            "test",
            "record",
            "--suite",
            "deck",
            "--junit",
            junit.to_str().unwrap(),
            "--exit-code",
            "1",
        ],
    );
    assert!(out.status.success());

    let out = run(&db, &checkout, &["test", "last", "--failures"]);
    assert_eq!(
        stdout(&out),
        "deck  (fail) a.test.ts › bad two\n      expect(received).toBe(expected)\n",
        "recorded from sub/, read from the root"
    );
}

/// The wrapper end to end on a real bun run: the red exit passes through,
/// the failure is still on stderr with no line of dots beside it, and the
/// record names the failing test with the message bun printed only on
/// stderr.
#[test]
fn test_run_wraps_a_red_bun_run_and_records_its_failure() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let scratch = dir.path().join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(
        scratch.join("a.test.ts"),
        "import { test, expect } from \"bun:test\";\n\
         test(\"good one\", () => expect(1).toBe(1));\n\
         test(\"bad two\", () => expect(1).toBe(2));\n",
    )
    .unwrap();
    std::fs::write(
        scratch.join("b.test.ts"),
        "import { test, expect } from \"bun:test\";\n\
         test(\"fine\", () => expect(true).toBe(true));\n",
    )
    .unwrap();

    let out = run(
        &db,
        &scratch,
        &[
            "test", "run", "--suite", "s", "--kind", "bun", "--", "bun", "test",
        ],
    );
    assert_eq!(out.status.code(), Some(1), "bun's red exit passes through");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("(fail) bad two"), "{stderr}");
    assert!(
        !stderr
            .lines()
            .any(|l| !l.is_empty() && l.chars().all(|c| c == '.')),
        "no line made only of dots: {stderr}"
    );
    assert!(
        stderr.contains("[test] s: 1 failed — tugtool test last --failures names them"),
        "{stderr}"
    );

    let out = run(&db, &scratch, &["test", "last", "--failures"]);
    assert_eq!(
        stdout(&out),
        "s  (fail) a.test.ts › bad two\n      expect(received).toBe(expected)\n"
    );
    let out = run(&db, &scratch, &["test", "last", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(report["runs"][0]["tests"], 3);
    assert_eq!(report["runs"][0]["exitCode"], 1);
}
