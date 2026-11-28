//! `tugtool cycle create|rename|add-entry|add-from|add-sketch|attach|drop|find|list|show|check`:
//! a cycle's record written in a scratch checkout, and every entry's state
//! read back from the arc log; and an arc-less sketch recorded on stdin, the
//! way a skill with no arc records one; and an arc statement checked
//! without a write, and the statement records listed.

mod common;
use common::tugtool;
use tugcore::instance::Paths;
use tugcore::test_fixtures::git::{GitFixture, git};

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

struct Scratch {
    _repo_dir: tempfile::TempDir,
    _state_dir: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        let repo_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let root = repo_dir.path().canonicalize().unwrap();
        let state = state_dir.path().canonicalize().unwrap();
        GitFixture::init(&root);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "base"]);
        Scratch {
            _repo_dir: repo_dir,
            _state_dir: state_dir,
            root,
            state,
        }
    }

    fn tug_in(&self, cwd: &Path) -> Command {
        let mut cmd = tugtool();
        cmd.env("TMPDIR", &self.state);
        cmd.env("TUG_DATA_DIR", &self.state);
        cmd.env("TUG_SESSION_ID", "sess-writer");
        cmd.current_dir(cwd);
        cmd
    }

    fn out(&self, args: &[&str]) -> Output {
        self.tug_in(&self.root).args(args).output().unwrap()
    }

    fn ok(&self, args: &[&str]) -> String {
        let out = self.out(args);
        assert!(
            out.status.success(),
            "tugtool {args:?} failed: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn json(&self, args: &[&str]) -> serde_json::Value {
        let mut all = args.to_vec();
        all.push("--json");
        let envelope: serde_json::Value = serde_json::from_str(&self.ok(&all)).unwrap();
        envelope["data"].clone()
    }

    fn write_log(&self, line: &str) {
        let log = tugtool_core::paths::arc_log_path_at(&Paths::under(&self.state), &self.root);
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        let mut text = std::fs::read_to_string(&log).unwrap_or_default();
        text.push_str(line);
        text.push('\n');
        std::fs::write(log, text).unwrap();
    }
}

#[test]
fn a_cycle_is_written_and_its_entries_read_from_the_arc_log() {
    let s = Scratch::new();

    let id = s.ok(&["cycle", "create", "--name", "Cycles"]);
    assert_eq!(id.len(), 8, "an id: {id}");

    // A sketch in the store, recorded through its own verb.
    let sketch = s.root.join(".tug/arcs/drawn/sketch.md");
    std::fs::create_dir_all(sketch.parent().unwrap()).unwrap();
    std::fs::write(&sketch, "# Sketch\n\nWant cycles.\n").unwrap();
    let recorded = s.ok(&["sketch", "record", "drawn"]);
    let sketch_id = recorded.split_whitespace().nth(1).unwrap().to_string();
    assert_eq!(s.ok(&["cycle", "add-sketch", &id, &sketch_id]), "A");
    assert!(
        !s.out(&["cycle", "add-sketch", &id, "00ff00ff"])
            .status
            .success()
    );

    assert_eq!(
        s.ok(&[
            "cycle",
            "add-entry",
            &id,
            "--brief",
            "briefs/one.md",
            "--from",
            "A"
        ]),
        "1"
    );
    let absolute = s.root.join("briefs/two.md");
    let second = s.json(&[
        "cycle",
        "add-entry",
        &id,
        "--brief",
        absolute.to_str().unwrap(),
        "--wait",
        "1",
        "--from",
        "A",
        "--note",
        "after the release",
    ]);
    assert_eq!(second["n"], 2);
    assert!(
        !s.out(&["cycle", "add-entry", &id, "--brief", "b.md"])
            .status
            .success(),
        "an entry that names no sketch is refused"
    );
    assert!(
        !s.out(&[
            "cycle",
            "add-entry",
            &id,
            "--brief",
            "b.md",
            "--from",
            "A",
            "--wait",
            "9"
        ])
        .status
        .success(),
        "a wait on no entry is refused"
    );

    assert!(
        !s.out(&["cycle", "attach", &id, "1", "alpha"])
            .status
            .success(),
        "no such arc in the log"
    );
    s.write_log("2026-11-01T00:00:00.000Z  alpha  arc-start  brief.md");
    s.write_log("2026-11-01T00:00:01.000Z  alpha  arc-stage  implement sess-9 -");
    let attached = s.json(&["cycle", "attach", &id, "1", "alpha"]);
    assert_eq!(attached["arc"]["name"], "alpha");
    assert_eq!(attached["arc"]["created"], "2026-11-01T00:00:00.000Z");

    // `show` reads from anywhere, with every entry's state.
    let elsewhere = tempfile::tempdir().unwrap();
    let show = |json: bool| {
        let mut cmd = s.tug_in(elsewhere.path());
        cmd.args(["cycle", "show", &id]);
        if json {
            cmd.arg("--json");
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "{out:?}");
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let view: serde_json::Value = serde_json::from_str(&show(true)).unwrap();
    let data = &view["data"];
    assert_eq!(data["name"], "Cycles");
    assert_eq!(data["created_by"], "sess-writer");
    assert_eq!(data["project_dir"], s.root.to_str().unwrap());
    assert_eq!(data["landed"], 0);
    assert_eq!(data["sketches"][0]["id"], sketch_id.as_str());
    let entries = &data["entries"];
    assert_eq!(entries[0]["state"], "running");
    assert_eq!(entries[0]["from"][0], "A");
    assert_eq!(entries[0]["stages"][0]["session_id"], "sess-9");
    assert_eq!(entries[1]["state"], "waiting");
    assert_eq!(
        entries[1]["brief"], "briefs/two.md",
        "made relative to the root"
    );
    assert_eq!(entries[1]["note"], "after the release");
    let text = show(false);
    assert!(
        text.contains("1  running  briefs/one.md  arc alpha"),
        "{text}"
    );
    assert!(
        text.contains("2  waiting  briefs/two.md  waits 1"),
        "{text}"
    );

    s.write_log("2026-11-01T01:00:00.000Z  alpha  302d43b5d1  joined");
    let list = s.json(&["cycle", "list"]);
    assert_eq!(list[0]["id"], id.as_str());
    assert_eq!(list[0]["landed"], 1);
    assert_eq!(list[0]["total"], 2);
    assert_eq!(s.ok(&["cycle", "list"]), format!("{id}  1/2  Cycles"));
    let view: serde_json::Value = serde_json::from_str(&show(true)).unwrap();
    assert_eq!(view["data"]["entries"][1]["state"], "ready");

    let absent = s
        .tug_in(elsewhere.path())
        .args(["cycle", "show", "00ff00ff"])
        .output()
        .unwrap();
    assert_eq!(absent.status.code(), Some(3), "{absent:?}");
}

#[test]
fn a_finished_cycle_leaves_the_list_and_a_drop_settles_what_will_never_run() {
    let s = Scratch::new();
    let id = s.ok(&["cycle", "create", "--name", "Closing"]);
    let mut sketches = Vec::new();
    for name in ["first", "second"] {
        let sketch = s.root.join(format!(".tug/arcs/{name}/sketch.md"));
        std::fs::create_dir_all(sketch.parent().unwrap()).unwrap();
        std::fs::write(&sketch, format!("# Sketch\n\nWant {name}.\n")).unwrap();
        let recorded = s.ok(&["sketch", "record", name]);
        sketches.push(recorded.split_whitespace().nth(1).unwrap().to_string());
    }
    assert_eq!(s.ok(&["cycle", "add-sketch", &id, &sketches[0]]), "A");
    assert_eq!(s.ok(&["cycle", "add-sketch", &id, &sketches[1]]), "B");
    for brief in ["briefs/one.md", "briefs/two.md"] {
        s.ok(&["cycle", "add-entry", &id, "--brief", brief, "--from", "A"]);
    }
    let listed = |all: bool| {
        let args: &[&str] = if all {
            &["cycle", "list", "--all"]
        } else {
            &["cycle", "list"]
        };
        s.json(args).as_array().unwrap().clone()
    };
    let refused = |item: &str| {
        let out = s.out(&["cycle", "drop", &id, item]);
        assert!(!out.status.success(), "drop {item} should be refused");
        String::from_utf8_lossy(&out.stderr).to_string()
    };

    // A running arc is discarded, never dropped; a landed one is settled.
    s.write_log("2026-11-01T00:00:00.000Z  alpha  arc-start  brief.md");
    s.ok(&["cycle", "attach", &id, "1", "alpha"]);
    assert!(refused("1").contains("still open"));
    s.write_log("2026-11-01T01:00:00.000Z  alpha  302d43b5d1  joined");
    assert!(refused("1").contains("landed"));
    assert!(refused("A").contains("entry 1"));
    refused("7");

    // One landed and one not started: open, and listed.
    assert_eq!(listed(false)[0]["closed"], false);

    // Entry 2 dropped, sketch B still pending: open.
    assert_eq!(s.ok(&["cycle", "drop", &id, "2"]), "2  dropped");
    assert_eq!(listed(false).len(), 1);
    let dropped = s.json(&["cycle", "drop", &id, "b"]);
    assert_eq!(dropped["id"], id.as_str());
    assert_eq!(dropped["sketch"], "B");

    // Every entry settled and no sketch pending: closed, and off the list.
    assert!(listed(false).is_empty());
    assert_eq!(s.ok(&["cycle", "list"]), "");
    let all = listed(true);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["closed"], true);
    assert_eq!(all[0]["landed"], 1);
    assert_eq!(all[0]["total"], 2);
    assert_eq!(
        s.ok(&["cycle", "list", "--all"]),
        format!("{id}  1/2  Closing  closed")
    );

    // A closed cycle is still shown and still found.
    let shown = s.json(&["cycle", "show", &id]);
    assert_eq!(shown["closed"], true);
    assert_eq!(shown["entries"][1]["state"], "dropped");
    assert!(shown["sketches"][1]["dropped"].is_string());
    let text = s.ok(&["cycle", "show", &id]);
    assert!(text.contains("1/2 landed  closed"), "{text}");
    assert!(
        text.contains(&format!("B  sketch {}  dropped", sketches[1])),
        "{text}"
    );
    assert!(text.contains("2  dropped  briefs/two.md"), "{text}");
    assert_eq!(
        s.json(&["cycle", "find", "--brief", "briefs/two.md"])["id"],
        id.as_str()
    );

    // Run after all, the dropped entry reopens the cycle; and undoing the
    // landing of the other keeps it open once that arc joins.
    s.write_log("2026-11-02T00:00:00.000Z  beta  arc-start  brief.md");
    s.ok(&["cycle", "attach", &id, "2", "beta"]);
    assert_eq!(listed(false).len(), 1);
    assert_eq!(
        s.json(&["cycle", "show", &id])["entries"][1]["state"],
        "running"
    );
    s.write_log("2026-11-02T01:00:00.000Z  beta  9ac1e0f2aa  joined");
    assert!(listed(false).is_empty());
    s.write_log("2026-11-02T02:00:00.000Z  beta  undone  reversed join (operation 4)");
    assert_eq!(listed(false).len(), 1);
}

/// Run `tugtool sketch record [args…] --json` with `text` on stdin and return
/// the envelope's data.
fn record_on_stdin(s: &Scratch, args: &[&str], text: &str) -> serde_json::Value {
    let mut child = s
        .tug_in(&s.root)
        .args(["sketch", "record"])
        .args(args)
        .arg("--json")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let envelope: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    envelope["data"].clone()
}

#[test]
fn a_skill_records_a_free_sketch_finds_its_entry_and_renames_by_hand() {
    let s = Scratch::new();

    // A sketch with no arc, read on stdin, then a new version under its id.
    let first = record_on_stdin(&s, &[], "# Sketch\n\nWant dockets.\n");
    let sketch_id = first["id"].as_str().unwrap().to_string();
    assert_eq!(first["minted"], true);
    let next = record_on_stdin(
        &s,
        &["--id", &sketch_id],
        "# Sketch\n\nWant dockets of many briefs.\n",
    );
    assert_eq!(next["id"], sketch_id.as_str());
    assert_eq!(next["version"], 2);
    assert_eq!(next["minted"], false);
    let shown = s.json(&["sketch", "show", &sketch_id]);
    assert!(shown.get("arc").is_none(), "tied to no arc: {shown}");
    assert_eq!(shown["text"], "# Sketch\n\nWant dockets of many briefs.\n");
    assert!(
        !s.out(&["sketch", "record", "drawn", "--id", &sketch_id])
            .status
            .success(),
        "an arc and an id together are refused"
    );

    // The cycle is created from it, and its entry found again by the brief.
    let id = s.ok(&["cycle", "create", "--name", "Dockets"]);
    assert_eq!(s.ok(&["cycle", "add-sketch", &id, &sketch_id]), "A");
    s.ok(&[
        "cycle",
        "add-entry",
        &id,
        "--brief",
        "briefs/one.md",
        "--from",
        "A",
    ]);
    s.ok(&[
        "cycle",
        "add-entry",
        &id,
        "--brief",
        "briefs/two.md",
        "--wait",
        "1",
        "--from",
        "A",
    ]);
    assert_eq!(
        s.ok(&["cycle", "find", "--brief", "briefs/two.md"]),
        format!("{id}  2")
    );
    let absolute = s.root.join("briefs/one.md");
    let found = s.json(&["cycle", "find", "--brief", absolute.to_str().unwrap()]);
    assert_eq!(found["id"], id.as_str());
    assert_eq!(found["n"], 1, "an absolute path inside the checkout");
    assert_eq!(s.ok(&["cycle", "find", "--brief", "briefs/none.md"]), "");
    assert!(
        s.json(&["cycle", "find", "--brief", "briefs/none.md"])
            .is_null()
    );

    // The cycle is found from its sketch, whichever session asks.
    assert_eq!(
        s.ok(&["cycle", "find", "--sketch", &sketch_id]),
        format!("{id}  A")
    );
    let other = s
        .tug_in(&s.root)
        .env("TUG_SESSION_ID", "sess-other")
        .args(["cycle", "find", "--sketch", &sketch_id, "--json"])
        .output()
        .unwrap();
    assert!(other.status.success(), "{other:?}");
    let other: serde_json::Value = serde_json::from_slice(&other.stdout).unwrap();
    assert_eq!(other["data"]["id"], id.as_str());
    assert_eq!(other["data"]["letter"], "A");
    assert_eq!(s.ok(&["cycle", "find", "--sketch", "00000000"]), "");
    assert!(
        !s.out(&["cycle", "list", "--mine"]).status.success(),
        "no cycle is found by the session"
    );
    assert_eq!(s.json(&["cycle", "list"]).as_array().unwrap().len(), 1);

    // A rename by hand keeps the id.
    assert_eq!(
        s.ok(&["cycle", "rename", &id, "--name", "Dockets of many briefs"]),
        "Dockets of many briefs"
    );
    assert_eq!(
        s.ok(&["cycle", "list"]),
        format!("{id}  0/2  Dockets of many briefs")
    );
    assert!(
        !s.out(&["cycle", "rename", &id, "--name", " "])
            .status
            .success(),
        "an empty name is refused"
    );
}

#[test]
fn an_old_entry_is_repaired_and_the_check_reads_the_whole_machine() {
    let s = Scratch::new();
    let check = |s: &Scratch| {
        s.tug_in(&s.state)
            .args(["cycle", "check"])
            .output()
            .unwrap()
    };
    let clean = check(&s);
    assert!(clean.status.success(), "{clean:?}");
    assert_eq!(
        String::from_utf8_lossy(&clean.stdout).trim(),
        "every cycle on this machine is whole, and every live arc is on one"
    );

    // A record written before every entry had to name a sketch.
    let id = s.ok(&["cycle", "create", "--name", "Old"]);
    let record_path = tugtool_core::paths::project_state_dir_at(&Paths::under(&s.state), &s.root)
        .join("cycles")
        .join(&id)
        .join("cycle.json");
    let mut record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&record_path).unwrap()).unwrap();
    record["entries"] = serde_json::json!([
        {"n": 1, "brief": "briefs/index.md", "waits": [], "added": "2026-11-01T00:00:00Z"}
    ]);
    std::fs::write(&record_path, serde_json::to_string_pretty(&record).unwrap()).unwrap();

    let broken = check(&s);
    assert_eq!(broken.status.code(), Some(1), "{broken:?}");
    let text = String::from_utf8_lossy(&broken.stdout);
    assert!(text.contains(&format!("{id}  Old")), "{text}");
    assert!(text.contains("  entry 1 names no sketch"), "{text}");
    let report = s
        .tug_in(&s.state)
        .args(["cycle", "check", "--json"])
        .output()
        .unwrap();
    assert_eq!(report.status.code(), Some(1));
    let report: serde_json::Value = serde_json::from_slice(&report.stdout).unwrap();
    assert_eq!(report["data"]["clean"], false);
    assert_eq!(report["data"]["breaks"][0]["id"], id.as_str());

    // A sketch written from the brief, carrying it, then named by the entry.
    let sketch = record_on_stdin(&s, &[], "# Sketch\n\nWant the index.\n")["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        !s.out(&["cycle", "add-from", &id, "1", "--from", "A"])
            .status
            .success(),
        "no sketch A yet"
    );
    assert_eq!(
        s.ok(&[
            "cycle",
            "add-sketch",
            &id,
            &sketch,
            "--brief",
            "briefs/index.md"
        ]),
        "A"
    );
    let from = s.json(&["cycle", "add-from", &id, "1", "--from", "a"]);
    assert_eq!(from["from"], serde_json::json!(["A"]));
    assert_eq!(s.ok(&["cycle", "add-from", &id, "1", "--from", "A"]), "A");
    assert!(
        !s.out(&["cycle", "add-from", &id, "1"]).status.success(),
        "a letter is required"
    );
    assert!(check(&s).status.success(), "the record is whole again");

    // A live arc the door opened and never attached is listed beside the
    // breaks, and fails the check on its own.
    s.write_log("2026-11-03T00:00:00.000Z  loose  arc-start  briefs/loose.md");
    let gap = check(&s);
    assert_eq!(gap.status.code(), Some(1), "{gap:?}");
    let text = String::from_utf8_lossy(&gap.stdout);
    assert!(text.contains("arc loose  "), "{text}");
    assert!(text.trim_end().ends_with("is on no cycle"), "{text}");
    let report: serde_json::Value = serde_json::from_slice(
        &s.tug_in(&s.state)
            .args(["cycle", "check", "--json"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(report["data"]["breaks"], serde_json::json!([]));
    assert_eq!(report["data"]["unattached"][0]["arc"], "loose");
    s.write_log("2026-11-03T00:01:00.000Z  loose  discarded  by hand");
    assert!(check(&s).status.success(), "a discarded arc is no gap");

    // The brief is found through its entry; a brief only a sketch carries is
    // found through the sketch.
    let found = s.json(&["cycle", "find", "--brief", "briefs/index.md"]);
    assert_eq!(found["n"], 1);
    assert!(found.get("letter").is_none(), "{found}");
    let other = record_on_stdin(&s, &[], "# Sketch\n\nWant more.\n")["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        s.ok(&[
            "cycle",
            "add-sketch",
            &id,
            &other,
            "--brief",
            "briefs/umbrella.md"
        ]),
        "B"
    );
    let found = s.json(&["cycle", "find", "--brief", "briefs/umbrella.md"]);
    assert_eq!(found["id"], id.as_str());
    assert_eq!(found["letter"], "B");
    assert!(found.get("n").is_none(), "{found}");
    assert_eq!(
        s.ok(&["cycle", "find", "--brief", "briefs/umbrella.md"]),
        format!("{id}  B")
    );
}

/// The queued-work fence names an arc for a brief; the `/arc` door, opening
/// that arc, fills the same entry rather than adding one, and a second
/// opening finds it already placed.
#[test]
fn a_queued_arc_is_filled_by_its_place_and_found_by_name() {
    let s = Scratch::new();
    let id = s.ok(&["cycle", "create", "--name", "Queue"]);
    let sketch = record_on_stdin(&s, &[], "# Sketch\n\nWant a queue.\n");
    let sketch_id = sketch["id"].as_str().unwrap().to_string();
    assert_eq!(s.ok(&["cycle", "add-sketch", &id, &sketch_id]), "A");

    let queued = s.json(&[
        "cycle", "queue", "alpha", "--brief", "briefs/one.md", "--cycle", &id, "--from", "A",
        "--label", "the first", "--turn", "4",
    ]);
    assert_eq!(queued["cycle"], id.as_str());
    assert_eq!(queued["n"], 1);
    assert_eq!(queued["outcome"], "added");
    let refused = s.out(&["cycle", "queue", "alpha", "--brief", "briefs/one.md", "--cycle", &id]);
    assert!(!refused.status.success(), "one unsettled entry per name");

    s.write_log("2026-11-01T00:00:00.000Z  alpha  arc-start  briefs/one.md");
    assert_eq!(
        s.ok(&["cycle", "place", "alpha", "--brief", "briefs/one.md"]),
        format!("{id}  1  filled")
    );
    assert_eq!(s.ok(&["cycle", "find", "--arc", "alpha"]), format!("{id}  1"));
    assert_eq!(
        s.ok(&["cycle", "place", "alpha", "--brief", "briefs/one.md"]),
        format!("{id}  1  already")
    );

    let shown = s.json(&["cycle", "show", &id]);
    let entries = shown["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "one entry, filled: {shown}");
    assert_eq!(s.ok(&["cycle", "find", "--arc", "nobody"]), "");
}

/// Run `tugtool cycle statement <args…>` with `text` on stdin.
fn statement_on_stdin(s: &Scratch, args: &[&str], text: &str) -> Output {
    let mut child = s
        .tug_in(&s.root)
        .args(["cycle", "statement"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

/// Write `briefs/<name>.md` in the scratch checkout.
fn write_brief(s: &Scratch, name: &str) -> String {
    let path = format!("briefs/{name}.md");
    std::fs::create_dir_all(s.root.join("briefs")).unwrap();
    std::fs::write(s.root.join(&path), format!("# {name}\n")).unwrap();
    path
}

const TWO_ARCS: &str = r#"{"tugarcs": 1, "arcs": [
  {"name": "alpha", "brief": "briefs/alpha.md", "label": "the first"},
  {"name": "beta", "brief": "briefs/beta.md"}
]}"#;

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn statement_answers_ok_for_a_clean_spec() {
    let s = Scratch::new();
    write_brief(&s, "alpha");
    write_brief(&s, "beta");
    let out = statement_on_stdin(&s, &["-"], TWO_ARCS);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), "ok: 2 arcs\n");

    // The same spec from a file, and through the envelope.
    let file = s.state.join("spec.json");
    std::fs::write(&file, TWO_ARCS).unwrap();
    let data = s.json(&["cycle", "statement", file.to_str().unwrap()]);
    assert_eq!(data["arcs"][0]["name"], "alpha");
    assert_eq!(data["arcs"][0]["label"], "the first");
    assert_eq!(data["arcs"][1]["name"], "beta");
    assert_eq!(data["warnings"], serde_json::json!([]));
}

#[test]
fn statement_warns_of_a_missing_brief_and_exits_zero() {
    let s = Scratch::new();
    write_brief(&s, "alpha");
    let out = statement_on_stdin(&s, &["-"], TWO_ARCS);
    assert!(out.status.success(), "a warning is not a refusal: {out:?}");
    let text = stdout(&out);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "ok: 2 arcs");
    assert_eq!(lines.len(), 2, "{text}");
    assert!(
        lines[1].starts_with("warning: ") && lines[1].contains("briefs/beta.md"),
        "{text}"
    );
}

#[test]
fn statement_refuses_a_non_spec_with_its_path_and_exits_two() {
    let s = Scratch::new();
    let out = statement_on_stdin(
        &s,
        &["-"],
        r#"{"tugarcs": 1, "arcs": [{"name": "alpha", "brief": "briefs/alpha.md"}, {"brief": "briefs/beta.md"}]}"#,
    );
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    assert_eq!(
        stdout(&out),
        "not a valid arc statement: arcs[1].name: missing\n"
    );

    let out = statement_on_stdin(&s, &["-"], "not json at all");
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    assert!(
        stdout(&out).starts_with("not a valid arc statement: "),
        "{out:?}"
    );
}

#[test]
fn statement_takes_a_whole_fence_on_stdin() {
    let s = Scratch::new();
    write_brief(&s, "alpha");
    write_brief(&s, "beta");
    let fence = format!("```tugarcs\n{TWO_ARCS}\n```\n");
    let out = statement_on_stdin(&s, &["-"], &fence);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), "ok: 2 arcs\n");
}

/// Every file under `dir` and its bytes, so two readings compare whole.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(snapshot(&path));
        } else {
            out.push((path.clone(), std::fs::read(&path).unwrap()));
        }
    }
    out.sort();
    out
}

#[test]
fn statement_writes_nothing() {
    let s = Scratch::new();
    write_brief(&s, "alpha");
    s.ok(&["cycle", "create", "--name", "Checked"]);
    let state = tugtool_core::paths::project_state_dir_at(&Paths::under(&s.state), &s.root);
    let before = snapshot(&state);
    assert!(!before.is_empty(), "the cycle is on disk to compare against");

    let out = statement_on_stdin(&s, &["-"], TWO_ARCS);
    assert!(out.status.success(), "{out:?}");
    let out = statement_on_stdin(&s, &["-"], "{\"tugarcs\": 2}");
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    assert_eq!(snapshot(&state), before, "a check writes nothing");
}

#[test]
fn stated_lists_a_held_statement() {
    use tugarc_core::statement::{Source, StatedArc, Statement, state_arcs};
    use tugarc_core::work_log::{By, Privacy};

    let s = Scratch::new();
    write_brief(&s, "alpha");
    write_brief(&s, "beta");
    assert_eq!(s.ok(&["cycle", "stated"]), "", "no statement yet");

    let session = "0f3c1e5a-9b27-4c1d-8e36-5a7f2d4b6c90";
    let arcs = ["alpha", "beta"]
        .iter()
        .map(|name| StatedArc {
            name: name.to_string(),
            brief: format!("briefs/{name}.md"),
            label: None,
            after: None,
        })
        .collect();
    state_arcs(
        &Paths::under(&s.state),
        &s.root,
        &Statement {
            arcs,
            source: Source::Prose,
        },
        &By {
            session: Some(session.into()),
            turn: Some(3),
            privacy: Privacy::Public,
            segments: Vec::new(),
        },
    )
    .unwrap();

    assert_eq!(
        s.ok(&["cycle", "stated"]),
        format!("{session}  turn 3\n  alpha  held\n  beta  held")
    );
    let records = s.json(&["cycle", "stated"]);
    assert_eq!(records[0]["session"], session);
    assert_eq!(records[0]["turn"], 3);
    assert_eq!(records[0]["arcs"][1]["name"], "beta");
    assert!(records[0]["arcs"][1].get("cycle").is_none(), "{records}");
}
