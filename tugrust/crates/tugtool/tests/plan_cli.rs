//! `tugtool plan lint`, `plan status`, and `plan stamp`.
//!
//! Lint's three outcomes are distinct on purpose: a warnings-only run is still
//! a usable plan (exit 0, `status: "ok"`), an error diagnostic gates (exit 1,
//! `status: "error"`), and a document that is not a plan at all is neither
//! clean nor dirty (exit 2).

mod common;
use common::tugtool;

use std::path::Path;

/// A plan carrying every required section and one clean step.
const CONFORMING: &str = r#"## A Conforming Plan {#conforming-plan}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | Someone |

### Review Record {#review-record}

**Round 1 — 2026-08-13, opus.** Lint: 0 errors.

### Phase Overview {#phase-overview}

Some context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The only step | pending | — |

#### Step 1: The only step {#step-1}

**Commit:** `thing(scope): do it`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the thing.

**Tests:**
- [ ] Unit: the thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the thing.
"#;

fn lint(path: &Path, json: bool) -> (i32, String) {
    let mut cmd = tugtool();
    if json {
        cmd.arg("--json");
    }
    let out = cmd.args(["plan", "lint"]).arg(path).output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
    )
}

fn write(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    path
}

#[test]
fn a_conforming_plan_exits_zero() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "plan.md", CONFORMING);
    let (code, stdout) = lint(&path, false);
    assert_eq!(code, 0, "{stdout}");
    assert!(stdout.contains("0 errors"), "{stdout}");
}

#[test]
fn a_warnings_only_plan_still_exits_zero() {
    let dir = tempfile::tempdir().unwrap();
    // Dropping the Review Record leaves a PL023 warning and nothing else.
    let body = CONFORMING.replace(
        "### Review Record {#review-record}\n\n**Round 1 — 2026-08-13, opus.** Lint: 0 errors.\n\n",
        "",
    );
    let path = write(dir.path(), "plan.md", &body);
    let (code, stdout) = lint(&path, false);
    assert_eq!(code, 0, "{stdout}");
    assert!(stdout.contains("PL023"), "{stdout}");
    assert!(stdout.contains("0 errors, 1 warning"), "{stdout}");
}

#[test]
fn a_seeded_error_exits_one_and_names_the_code() {
    let dir = tempfile::tempdir().unwrap();
    let body = CONFORMING.replace("**Commit:** `thing(scope): do it`\n\n", "");
    let path = write(dir.path(), "plan.md", &body);
    let (code, stdout) = lint(&path, false);
    assert_eq!(code, 1, "{stdout}");
    assert!(stdout.contains("PL008"), "{stdout}");
    assert!(stdout.contains("error"), "{stdout}");
}

#[test]
fn a_brief_exits_two() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        "brief.md",
        "## How we got here\n\nSome prose.\n\n## What is open\n\nMore prose.\n",
    );
    let mut cmd = tugtool();
    let out = cmd.args(["plan", "lint"]).arg(&path).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("not a plan document"), "{stderr}");
}

#[test]
fn a_missing_file_exits_two() {
    let dir = tempfile::tempdir().unwrap();
    let (code, _) = lint(&dir.path().join("nope.md"), false);
    assert_eq!(code, 2);
}

#[test]
fn json_carries_the_envelope_and_the_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let body = CONFORMING.replace(
        "### Review Record {#review-record}\n\n**Round 1 — 2026-08-13, opus.** Lint: 0 errors.\n\n",
        "",
    );
    let path = write(dir.path(), "plan.md", &body);
    let (code, stdout) = lint(&path, true);
    assert_eq!(code, 0, "{stdout}");
    let value: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["schema_version"], "1");
    assert_eq!(value["command"], "plan lint");
    assert_eq!(value["status"], "ok");
    assert_eq!(value["data"]["errors"], 0);
    assert_eq!(value["data"]["warnings"], 1);
    let issues = value["issues"].as_array().unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0]["code"], "PL023");
    assert_eq!(issues[0]["severity"], "warning");
}

// --- plan status / plan stamp ----------------------------------------------

/// Run a `plan <verb> <path>` subcommand, returning its exit code and stdout.
fn plan_verb(verb: &str, path: &Path, json: bool) -> (i32, String) {
    let mut cmd = tugtool();
    if json {
        cmd.arg("--json");
    }
    let out = cmd.args(["plan", verb]).arg(path).output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
    )
}

fn status_json(path: &Path) -> (i32, serde_json::Value) {
    let (code, stdout) = plan_verb("status", path, true);
    let value = serde_json::from_str(&stdout).unwrap_or_else(|e| panic!("{e}: {stdout}"));
    (code, value)
}

/// `CONFORMING` grown to three ledger rows in three different states, so the
/// step counts have something to count.
fn three_steps() -> String {
    const EXTRA: &str = "\
#### Step 2: Second {#step-2}

**Commit:** `thing(scope): second`

**References:** [P01] the decision

**Tasks:**
- [ ] Do the second thing.

**Tests:**
- [ ] Unit: the second thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

#### Step 3: Third {#step-3}

**Commit:** `thing(scope): third`

**References:** [P01] the decision

**Tasks:**
- [ ] Do the third thing.

**Tests:**
- [ ] Unit: the third thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}";

    CONFORMING
        .replace(
            "| #step-1 | The only step | pending | — |",
            "| #step-1 | The only step | done | `a4477d5` |\n\
             | #step-2 | Second | in progress | — |\n\
             | #step-3 | Third | pending | — |",
        )
        .replace("### Deliverables and Checkpoints {#deliverables}", EXTRA)
}

#[test]
fn status_reports_reviewed_then_stale_and_never_gates() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "plan.md", CONFORMING);

    // Pre-migration: a Review Record with a round and no stamp vouches for
    // nothing, and PL025 says so.
    let (code, value) = status_json(&path);
    assert_eq!(code, 0, "{value}");
    assert_eq!(value["data"]["review"], "never-reviewed");
    assert_eq!(value["data"]["rounds"], 1);
    assert!(value["data"]["last_round"]["stamp"].is_null(), "{value}");

    let (code, stdout) = plan_verb("stamp", &path, false);
    assert_eq!(code, 0, "{stdout}");

    let (code, value) = status_json(&path);
    assert_eq!(code, 0, "{value}");
    assert_eq!(value["status"], "ok");
    assert_eq!(value["command"], "plan status");
    assert_eq!(value["data"]["review"], "reviewed");
    assert_eq!(
        value["data"]["last_round"]["stamp"], value["data"]["content_hash"],
        "a reviewed plan's round stamp is today's content hash"
    );

    // One word of body prose, and the review no longer covers the document —
    // but the verdict is data, so the exit code does not move.
    let stamped = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        &path,
        stamped.replace("Some context.", "Some other context."),
    )
    .unwrap();
    let (code, value) = status_json(&path);
    assert_eq!(code, 0, "a readout never gates: {value}");
    assert_eq!(value["data"]["review"], "stale");
}

#[test]
fn status_exits_two_on_a_document_that_is_not_a_plan() {
    let dir = tempfile::tempdir().unwrap();
    // A program plan: phases and decisions, no `{#execution-steps}`.
    let path = write(
        dir.path(),
        "program.md",
        "## The Program {#program}\n\n### Plan Metadata {#plan-metadata}\n\n### Phases {#phases}\n\n#### Phase 1 {#phase-1}\n",
    );
    let out = tugtool()
        .args(["plan", "status"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("not a plan document"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn stamping_twice_refuses_and_leaves_the_file_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "plan.md", CONFORMING);

    let (code, _) = plan_verb("stamp", &path, false);
    assert_eq!(code, 0);
    let stamped = std::fs::read_to_string(&path).unwrap();

    let out = tugtool()
        .args(["plan", "stamp"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("already stamped"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        stamped,
        "a refused stamp writes nothing"
    );
}

#[test]
fn stamp_json_names_the_round_it_wrote() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "plan.md", CONFORMING);
    let (code, stdout) = plan_verb("stamp", &path, true);
    assert_eq!(code, 0, "{stdout}");
    let value: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["command"], "plan stamp");
    assert_eq!(value["data"]["round"], 1);
    let stamp = value["data"]["stamp"].as_str().unwrap();
    assert_eq!(stamp.len(), 16, "{stamp}");
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains(&format!("Reviewed `plan:{stamp}`."))
    );
}

#[test]
fn status_counts_the_ledger_by_status() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "plan.md", &three_steps());
    let (code, value) = status_json(&path);
    assert_eq!(code, 0, "{value}");
    assert_eq!(value["data"]["steps"]["total"], 3);
    assert_eq!(value["data"]["steps"]["done"], 1);
    assert_eq!(value["data"]["steps"]["in_progress"], 1);
    assert_eq!(value["data"]["steps"]["pending"], 1);
    assert_eq!(value["data"]["lint"]["errors"], 0, "{value}");
}

/// The two fields `arc-implement`'s gate message quotes have to be populated
/// together: a stale verdict is only actionable next to what has already landed.
#[test]
fn a_stale_plan_still_reports_its_step_counts() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "plan.md", &three_steps());
    let (code, _) = plan_verb("stamp", &path, false);
    assert_eq!(code, 0);

    let stamped = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, stamped.replace("Some context.", "Something else.")).unwrap();

    let (code, value) = status_json(&path);
    assert_eq!(code, 0, "{value}");
    assert_eq!(value["data"]["review"], "stale");
    assert_eq!(value["data"]["steps"]["done"], 1);
    assert_eq!(value["data"]["last_round"]["date"], "2026-08-13");
    assert_eq!(value["data"]["last_round"]["model"], "opus");
}

#[test]
fn json_reports_error_status_when_a_run_carries_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let body = CONFORMING.replace("**Checkpoint:**\n- [ ] `cargo nextest run`\n", "");
    let path = write(dir.path(), "plan.md", &body);
    let (code, stdout) = lint(&path, true);
    assert_eq!(code, 1, "{stdout}");
    let value: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["status"], "error");
    let issues = value["issues"].as_array().unwrap();
    let pl012 = issues
        .iter()
        .find(|i| i["code"] == "PL012")
        .unwrap_or_else(|| panic!("expected PL012 in {issues:#?}"));
    assert_eq!(pl012["severity"], "error");
    assert_eq!(pl012["anchor"], "#step-1");
    assert!(pl012["line"].is_number(), "{pl012}");
}
