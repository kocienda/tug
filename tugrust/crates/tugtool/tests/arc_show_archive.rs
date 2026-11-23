//! `tugtool arc show` answers for arcs that have ended: a joined arc from the
//! arc archive, a discarded one whose documents were deleted from the
//! archive too, a join from before documents were archived from the arc log
//! alone, and paperwork a discard kept from `.tug/arcs/<name>/`.
//!
//! Every arc here is walked through the real verbs — `arc create`, a round
//! committed on its worktree, `arc join` or `arc discard` — in a scratch repo
//! whose state lands under a scratch `TUG_DATA_DIR`.

mod common;
use common::tugtool;
use tugcore::instance::Paths;
use tugcore::test_fixtures::git::{GitFixture, git};

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A scratch repo and the scratch data root its arcs record under.
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
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::write(root.join(".tugtool/config.toml"), "").unwrap();
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

    /// The library's view of the same data root the CLI is handed.
    fn paths(&self) -> Paths {
        Paths::under(&self.state)
    }

    fn tug(&self) -> Command {
        let mut cmd = tugtool();
        cmd.env("TMPDIR", &self.state);
        cmd.env("TUG_DATA_DIR", &self.state);
        cmd.current_dir(&self.root);
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        let out = self.tug().args(args).output().unwrap();
        assert!(
            out.status.success(),
            "tugtool {args:?} failed: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    fn show_json(&self, args: &[&str]) -> serde_json::Value {
        let mut all = vec!["arc", "show"];
        all.extend_from_slice(args);
        all.push("--json");
        let out = self.run(&all);
        let envelope: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        envelope["data"].clone()
    }

    /// Open a generation of `name` as the door does — an `arc-start` line and
    /// a brief — then cut its branch and commit one round on it.
    ///
    /// The `arc-start` line is written with a timestamp of its own, a day
    /// apart per generation. An archive entry is keyed to the second, and two
    /// generations a test opens within one second would otherwise share a key;
    /// the log's order, not its clock, is what the walk reads.
    fn open_arc(&self, name: &str, brief: &str) {
        let log = tugtool_core::paths::arc_log_path_at(&self.paths(), &self.root);
        let starts = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|l| l.contains(&format!("  {name}  arc-start  ")))
            .count();
        self.write_log(&format!(
            "2026-11-{:02}T00:00:00.000Z  {name}  arc-start  brief.md\n",
            starts + 1
        ));
        let dir = self.root.join(".tug/arcs").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("brief.md"), brief).unwrap();
        self.run(&["arc", "create", name]);
        let worktree = self.root.join(".tug/worktrees").join(name);
        std::fs::write(worktree.join(format!("{name}-{}.txt", brief.len())), brief).unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-q", "-m", "round"]);
    }

    fn join(&self, name: &str) {
        self.run(&["arc", "join", name, "--unaudited"]);
    }

    fn write_log(&self, text: &str) {
        let log = tugtool_core::paths::arc_log_path_at(&self.paths(), &self.root);
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        let mut old = std::fs::read_to_string(&log).unwrap_or_default();
        old.push_str(text);
        std::fs::write(log, old).unwrap();
    }
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn keys(value: &serde_json::Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[test]
fn a_joined_arc_answers_from_the_archive_and_prints_its_brief() {
    let s = Scratch::new();
    let brief = "# Joined arc\n\nWhat was decided, and why.\n";
    s.open_arc("landed", brief);

    // Live, the answer is today's, every field of it.
    let live = s.show_json(&["landed"]);
    assert_eq!(
        keys(&live),
        vec![
            "base_branch",
            "branch",
            "description",
            "id",
            "name",
            "rounds",
            "status",
            "uncommitted_changes",
            "worktree",
        ],
        "a live arc's answer keeps every field it had"
    );
    assert_eq!(live["status"], "active");

    s.join("landed");
    assert!(
        !s.root.join(".tug/arcs/landed").exists(),
        "the join cleared the working documents"
    );

    let text = stdout(&s.run(&["arc", "show", "landed"]));
    assert!(text.contains("Status: joined"), "{text}");
    assert!(text.contains("Join commit: "), "{text}");
    assert!(text.contains("  brief  "), "{text}");

    let printed = s.run(&["arc", "show", "landed", "--document", "brief"]);
    assert_eq!(printed.stdout, brief.as_bytes(), "the brief, byte for byte");

    let data = s.show_json(&["landed"]);
    assert_eq!(data["status"], "joined");
    assert_eq!(data["documents_kept"], true);
    let head = git(&s.root, &["rev-parse", "HEAD"]);
    assert_eq!(
        data["join_sha"],
        head.trim(),
        "the squash commit on the base"
    );

    let missing = s
        .tug()
        .args(["arc", "show", "landed", "--document", "plan"])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&missing.stderr).contains("arc 'landed' has no plan")
            || String::from_utf8_lossy(&missing.stdout).contains("arc 'landed' has no plan"),
        "{missing:?}"
    );
}

#[test]
fn a_discarded_arc_whose_documents_were_deleted_answers_discarded() {
    let s = Scratch::new();
    s.open_arc("dropped", "# Dropped\n");
    s.run(&["arc", "discard", "dropped"]);
    s.run(&["arc", "delete-documents", "dropped"]);
    assert!(!s.root.join(".tug/arcs/dropped").exists());

    let data = s.show_json(&["dropped"]);
    assert_eq!(data["status"], "discarded");
    let printed = s.run(&["arc", "show", "dropped", "--document", "brief"]);
    assert_eq!(stdout(&printed), "# Dropped\n");
}

#[test]
fn a_join_the_log_alone_remembers_keeps_no_documents() {
    let s = Scratch::new();
    s.write_log(
        "2026-10-01T00:00:00.000Z  ghost  arc-start  brief.md\n\
         2026-10-01T01:00:00.000Z  ghost  77aa88bb99  joined via card\n",
    );
    let data = s.show_json(&["ghost"]);
    assert_eq!(data["status"], "joined");
    assert_eq!(data["documents_kept"], false);
    assert_eq!(data["join_sha"], "77aa88bb99");
    let text = stdout(&s.run(&["arc", "show", "ghost"]));
    assert!(
        text.contains("Documents: none kept (joined before documents were archived)"),
        "{text}"
    );
}

#[test]
fn a_bare_name_answers_the_newest_generation_and_created_pins_the_older() {
    let s = Scratch::new();
    s.open_arc("twice", "# First\n");
    s.join("twice");
    let older = s.show_json(&["twice"]);
    let older_created = older["created"].as_str().unwrap().to_string();

    s.open_arc("twice", "# Second, longer\n");
    s.join("twice");

    let newest = s.run(&["arc", "show", "twice", "--document", "brief"]);
    assert_eq!(stdout(&newest), "# Second, longer\n");
    let pinned = s.run(&[
        "arc",
        "show",
        "twice",
        "--created",
        &older_created,
        "--document",
        "brief",
    ]);
    assert_eq!(stdout(&pinned), "# First\n");
    let data = s.show_json(&["twice", "--created", &older_created]);
    assert_eq!(data["created"], older_created);
}

#[test]
fn newer_kept_paperwork_answers_before_an_older_archive() {
    let s = Scratch::new();
    s.open_arc("reused", "# Joined one\n");
    s.join("reused");
    s.open_arc("reused", "# Discarded one\n");
    s.run(&["arc", "discard", "reused"]);
    assert!(
        s.root.join(".tug/arcs/reused/brief.md").exists(),
        "the discard kept its documents"
    );

    let data = s.show_json(&["reused"]);
    assert_eq!(data["status"], "paperwork");
    let printed = s.run(&["arc", "show", "reused", "--document", "brief"]);
    assert_eq!(stdout(&printed), "# Discarded one\n");
}

#[test]
fn project_resolves_the_repo_from_outside_any_checkout() {
    let s = Scratch::new();
    s.open_arc("elsewhere", "# Elsewhere\n");
    s.join("elsewhere");

    let outside = tempfile::tempdir().unwrap();
    let project = s.root.to_str().unwrap().to_string();
    let out = s
        .tug()
        .current_dir(outside.path())
        .args(["arc", "show", "elsewhere", "--project", &project, "--json"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let envelope: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(envelope["data"]["status"], "joined");
    assert!(Path::new(&project).is_dir());
}
