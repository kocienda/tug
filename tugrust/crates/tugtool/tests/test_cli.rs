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

/// `test last --json`'s report, out of the `--json` envelope it rides.
fn last_report(stdout: &str) -> serde_json::Value {
    let envelope: serde_json::Value = serde_json::from_str(stdout).unwrap();
    assert_eq!(envelope["command"], "test last", "{envelope}");
    assert_eq!(envelope["status"], "ok", "{envelope}");
    envelope["data"].clone()
}

fn run(db: &Path, cwd: &Path, args: &[&str]) -> Output {
    run_under(db, cwd, None, args)
}

/// The same, under a Bash call: `TUG_TOOL_USE_ID` set as the hook's rewrite
/// exports it.
fn run_under(db: &Path, cwd: &Path, call: Option<&str>, args: &[&str]) -> Output {
    let mut cmd = tugtool();
    if let Some(id) = call {
        cmd.env("TUG_TOOL_USE_ID", id);
    }
    cmd.args(args)
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
    let report = last_report(&stdout(&out));
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
    let init = tugcore::test_fixtures::git::command()
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
    let report = last_report(&stdout(&out));
    assert_eq!(report["runs"][0]["tests"], 3);
    assert_eq!(report["runs"][0]["exitCode"], 1);
}

/// `--kind lines` end to end: each line the item regex matches is a test, the
/// red exit passes through, and the record names the failing item.
#[test]
fn test_run_lines_records_the_items_its_regex_reads() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let out = run(
        &db,
        dir.path(),
        &[
            "test",
            "run",
            "--suite",
            "s",
            "--kind",
            "lines",
            "--item",
            r"^(?P<status>PASS|FAIL) (?P<name>\S+)",
            "--",
            "sh",
            "-c",
            "printf 'PASS a\\nFAIL b\\n'; exit 1",
        ],
    );
    assert_eq!(out.status.code(), Some(1), "the red exit passes through");
    assert_eq!(
        stdout(&out),
        "PASS a\nFAIL b\n",
        "the output passes through"
    );

    let out = run(&db, dir.path(), &["test", "last", "--json"]);
    let report = last_report(&stdout(&out));
    assert_eq!(report["runs"][0]["tests"], 2);
    assert_eq!(report["runs"][0]["failed"], 1);
    let out = run(&db, dir.path(), &["test", "last", "--failures"]);
    assert_eq!(stdout(&out), "s  (fail) b\n");
}

/// `--kind tap` on a real `node --test` run: the top-level results are the
/// tests, a skip is counted as one, and the failure is named.
#[test]
fn test_run_tap_records_a_node_test_run() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let scratch = dir.path().join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(
        scratch.join("a.test.mjs"),
        "import { test } from \"node:test\";\n\
         import assert from \"node:assert\";\n\
         test(\"adds\", () => { assert.equal(1 + 1, 2); });\n\
         test(\"subtracts wrong\", () => { assert.equal(2 - 1, 0); });\n",
    )
    .unwrap();
    std::fs::write(
        scratch.join("b.test.mjs"),
        "import { test } from \"node:test\";\n\
         test(\"later\", { skip: \"not yet\" }, () => {});\n",
    )
    .unwrap();

    let out = run(
        &db,
        &scratch,
        &[
            "test",
            "run",
            "--suite",
            "node",
            "--kind",
            "tap",
            "--",
            "node",
            "--test",
            "--test-reporter=tap",
            "a.test.mjs",
            "b.test.mjs",
        ],
    );
    assert_eq!(out.status.code(), Some(1), "node's red exit passes through");
    assert!(stdout(&out).contains("not ok 2 - subtracts wrong"));

    let out = run(&db, &scratch, &["test", "last", "--json"]);
    let report = last_report(&stdout(&out));
    assert_eq!(report["runs"][0]["tests"], 3);
    assert_eq!(report["runs"][0]["failed"], 1);
    assert_eq!(report["runs"][0]["skipped"], 1);
    let out = run(&db, &scratch, &["test", "last", "--failures"]);
    assert_eq!(stdout(&out), "node  (fail) subtracts wrong\n");
}

/// A verify's shape: several suites recorded under one call id, each from
/// its own directory. `test last --call` reads them back as one, in the order
/// they ran, from any directory, and the no-flag form still answers the
/// newest run of each suite for the checkout.
#[test]
fn test_last_call_reads_every_suite_recorded_under_one_call_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test_results.db");
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let lines = |suite: &str, script: &str| -> Vec<String> {
        [
            "test",
            "run",
            "--suite",
            suite,
            "--kind",
            "lines",
            "--item",
            r"^(?P<status>PASS|FAIL) (?P<name>\S+)",
            "--",
            "sh",
            "-c",
            script,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    };
    fn as_refs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }

    let rust = lines("rust", "printf 'FAIL tests::bad\\n'; exit 1");
    let out = run_under(&db, &a, Some("toolu_verify"), &as_refs(&rust));
    assert_eq!(out.status.code(), Some(1));
    let deck = lines("deck", "printf 'PASS fine\\n'");
    let out = run_under(&db, &b, Some("toolu_verify"), &as_refs(&deck));
    assert_eq!(out.status.code(), Some(0));
    // A later rust run under another call: the verify's read must not show it.
    let rust_again = lines("rust", "printf 'PASS tests::bad\\n'");
    let out = run_under(&db, &a, Some("toolu_later"), &as_refs(&rust_again));
    assert_eq!(out.status.code(), Some(0));

    let out = run(&db, dir.path(), &["test", "last", "--call", "toolu_verify", "--failures"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(stdout(&out), "rust  (fail) tests::bad\n");

    let out = run(&db, dir.path(), &["test", "last", "--call", "toolu_verify", "--json"]);
    let report = last_report(&stdout(&out));
    assert_eq!(report["call"], "toolu_verify");
    let suites: Vec<&str> = report["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["suite"].as_str().unwrap())
        .collect();
    assert_eq!(suites, ["rust", "deck"], "the call's runs, oldest first");
    assert_eq!(report["runs"][0]["toolUseId"], "toolu_verify");
    assert_eq!(report["runs"][0]["verdict"], "FAIL");

    let out = run(&db, &a, &["test", "last", "--failures"]);
    assert_eq!(
        stdout(&out),
        "no failures in the latest run of rust\n",
        "the no-flag form is still the newest run of each suite"
    );
    let out = run(&db, dir.path(), &["test", "last", "--call", "toolu_none"]);
    assert_eq!(stdout(&out), "no recorded test runs under call toolu_none\n");
}
