//! `tugtool cycle create|rename|add-entry|add-sketch|attach|find|list|show`:
//! a cycle's record written in a scratch checkout, and every entry's state
//! read back from the arc log; and an arc-less sketch recorded on stdin, the
//! way a skill with no arc records one.

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
        "--note",
        "after the release",
    ]);
    assert_eq!(second["n"], 2);
    assert!(
        !s.out(&["cycle", "add-entry", &id, "--brief", "b.md", "--wait", "9"])
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

    // `--mine` is the writer's, and nobody else's.
    let mine = s.json(&["cycle", "list", "--mine"]);
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(mine[0]["id"], id.as_str());
    let theirs = s
        .tug_in(&s.root)
        .env("TUG_SESSION_ID", "sess-other")
        .args(["cycle", "list", "--mine", "--json"])
        .output()
        .unwrap();
    assert!(theirs.status.success(), "{theirs:?}");
    let theirs: serde_json::Value = serde_json::from_slice(&theirs.stdout).unwrap();
    assert_eq!(theirs["data"], serde_json::json!([]));
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
