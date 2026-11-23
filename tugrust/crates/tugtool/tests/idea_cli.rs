//! `tugtool idea show|list`: an idea read back by its id from anywhere, with
//! the docket it is on and the sketch kept from it, and a checkout's ideas
//! listed newest first.
//!
//! Records are seeded through `tugarc_core` — the CLI has no verb that makes
//! an idea — over a scratch repo whose state lives under a scratch
//! `TUG_DATA_DIR`, with the session index redirected beside it.

mod common;
use common::tugtool;
use tugarc_core::docket::{self, FileItem};
use tugarc_core::idea::{self, IDEA_JSON};
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

    fn paths(&self) -> Paths {
        Paths::under(&self.state)
    }

    fn run(&self, cwd: &Path, args: &[&str]) -> Output {
        let mut cmd: Command = tugtool();
        cmd.env("TMPDIR", &self.state);
        cmd.env("TUG_DATA_DIR", &self.state);
        cmd.env("TUG_SESSION_INDEX_DB", &self.paths().session_index_db);
        cmd.current_dir(cwd);
        cmd.args(args).output().unwrap()
    }

    fn ok(&self, cwd: &Path, args: &[&str]) -> String {
        let out = self.run(cwd, args);
        assert!(
            out.status.success(),
            "{args:?}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn json(&self, cwd: &Path, args: &[&str]) -> serde_json::Value {
        serde_json::from_str(&self.ok(cwd, args)).unwrap()
    }
}

const SKETCH: &str = "# Sketch\n\nWant the inbox.\n\nSource: session 11111111-2222-3333-4444-555555555555, turns 1–3\n";

#[test]
fn show_names_the_docket_the_sketch_and_the_sessions() {
    let s = Scratch::new();
    let paths = s.paths();
    let made =
        idea::create_idea(&paths, &s.root, "An inbox for ideas", Some("More words.")).unwrap();
    idea::add_session(
        &paths,
        &s.root,
        &made.id,
        "11111111-2222-3333-4444-555555555555",
    )
    .unwrap();

    let inbox = docket::create_docket(&paths, &s.root, "Inbox").unwrap();
    let item = docket::resolve_item(
        &paths,
        &s.root,
        &FileItem::Idea {
            id: made.id.clone(),
        },
    )
    .unwrap();
    docket::file_items(&paths, &s.root, &inbox.id, &[item]).unwrap();

    let file = s.root.join("keep.md");
    std::fs::write(&file, SKETCH).unwrap();
    s.ok(
        &s.root,
        &["sketch", "keep", "--idea", &made.id, "--file", "keep.md"],
    );
    let sketch_id = s.json(&s.root, &["idea", "show", &made.id, "--json"])["data"]["sketch"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // `show` needs no repository: it reads from anywhere.
    let elsewhere = tempfile::tempdir().unwrap();
    let text = s.ok(elsewhere.path(), &["idea", "show", &made.id]);
    assert!(
        text.starts_with(&format!("idea {}  An inbox for ideas\n", made.id)),
        "{text}"
    );
    assert!(text.contains("More words."), "{text}");
    assert!(
        text.contains(&format!("docket: Inbox ({})\n", inbox.id)),
        "{text}"
    );
    assert!(
        text.contains(&format!("sketch: {sketch_id} v1\n")),
        "{text}"
    );
    assert!(
        text.contains("session: 11111111-2222-3333-4444-555555555555\n"),
        "{text}"
    );
    assert!(
        text.trim_end()
            .ends_with(&format!("tugtool sketch show {sketch_id}")),
        "{text}"
    );

    let json = s.json(elsewhere.path(), &["idea", "show", &made.id, "--json"]);
    let data = &json["data"];
    assert_eq!(data["id"], made.id.as_str());
    assert_eq!(data["text"], "An inbox for ideas");
    assert_eq!(data["body"], "More words.");
    assert_eq!(data["project_dir"], s.root.to_str().unwrap());
    assert_eq!(data["docket"]["id"], inbox.id.as_str());
    assert_eq!(data["docket"]["name"], "Inbox");
    assert_eq!(data["sketch"]["version"], 1);
    assert_eq!(
        data["sessions"][0]["uuid"],
        "11111111-2222-3333-4444-555555555555"
    );
}

#[test]
fn show_of_an_unfiled_unsketched_idea_says_none() {
    let s = Scratch::new();
    let made = idea::create_idea(&s.paths(), &s.root, "Bare", None).unwrap();
    let text = s.ok(&s.root, &["idea", "show", &made.id]);
    assert!(text.contains("docket: none\n"), "{text}");
    assert!(text.contains("sketch: none\n"), "{text}");
    assert!(!text.contains("session:"), "{text}");
    assert!(!text.contains("tugtool sketch show"), "{text}");
}

#[test]
fn an_unknown_id_exits_three() {
    let s = Scratch::new();
    let out = s.run(&s.root, &["idea", "show", "00ff00ff"]);
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    let json = s.run(&s.root, &["idea", "show", "00ff00ff", "--json"]);
    assert_eq!(json.status.code(), Some(3), "{json:?}");
    let body: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(body["issues"][0]["code"], "idea_absent", "{body}");
}

#[test]
fn list_orders_newest_first() {
    let s = Scratch::new();
    let paths = s.paths();
    let first = idea::create_idea(&paths, &s.root, "first", None).unwrap();
    let mut second = idea::create_idea(&paths, &s.root, "second", None).unwrap();
    // Two ideas made in one second share a stamp; date the second later.
    second.created = "2999-01-01T00:00:00Z".into();
    std::fs::write(
        second.dir.join(IDEA_JSON),
        serde_json::to_vec_pretty(&second).unwrap(),
    )
    .unwrap();

    let json = s.json(&s.root, &["idea", "list", "--json"]);
    let ids: Vec<&str> = json["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![second.id.as_str(), first.id.as_str()]);

    let text = s.ok(&s.root, &["idea", "list"]);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "{text}");
    assert!(lines[0].starts_with(&second.id), "{text}");
    assert!(lines[0].ends_with("second"), "{text}");

    let empty = Scratch::new();
    assert_eq!(empty.ok(&empty.root, &["idea", "list"]).trim(), "no ideas");
}
