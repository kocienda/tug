//! `tugtool cycle create|add-entry|add-sketch|attach|list|show`: a cycle's
//! record written in a scratch checkout, and every entry's state read back
//! from the arc log.

mod common;
use common::tugtool;
use tugcore::instance::Paths;
use tugcore::test_fixtures::git::{GitFixture, git};

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

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
