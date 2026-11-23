//! `tugtool docket list|show`: a checkout's dockets, and a docket's threads
//! derived from the arc log, the archive and git, read from anywhere.
//!
//! The store is seeded through `tugarc_core::docket` — the CLI has no verb
//! that writes — over a scratch repo whose state lives under a scratch
//! `TUG_DATA_DIR`, with the session index redirected beside it.

mod common;
use common::tugtool;
use tugarc_core::docket::{self, DocketItem, ResolvedItem};
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

    /// The library's view of the same data root the CLI is handed.
    fn paths(&self) -> Paths {
        Paths::under(&self.state)
    }

    fn tug(&self, cwd: &Path) -> Command {
        let mut cmd = tugtool();
        cmd.env("TMPDIR", &self.state);
        cmd.env("TUG_DATA_DIR", &self.state);
        cmd.env("TUG_SESSION_INDEX_DB", &self.paths().session_index_db);
        cmd.current_dir(cwd);
        cmd
    }

    fn ok(&self, cwd: &Path, args: &[&str]) -> String {
        let out: Output = self.tug(cwd).args(args).output().unwrap();
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

const CREATED: &str = "2026-11-01T00:00:00Z";

/// A joined arc `rail`: its log lines, its archive entry with a brief, and
/// the squash commit on the base. Returns the join's full sha.
fn seed_joined_arc(s: &Scratch) -> String {
    std::fs::write(s.root.join("rail.txt"), "rail\n").unwrap();
    git(&s.root, &["add", "-A"]);
    git(&s.root, &["commit", "-q", "-m", "Add the rail"]);
    let join = git(&s.root, &["rev-parse", "HEAD"]).trim().to_string();
    let marker = &join[..10];

    let paths = s.paths();
    let log = tugtool_core::paths::arc_log_path_at(&paths, &s.root);
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(
        &log,
        format!(
            "{CREATED}  rail  arc-start  brief.md\n\
             2026-11-01T00:01:00Z  rail  arc-stage  implement 11111111-1111-1111-1111-111111111111 -\n\
             2026-11-01T00:02:00Z  rail  63de5762a  Step 1: The store\n\
             2026-11-01T00:03:00Z  rail  {marker}  joined via card\n"
        ),
    )
    .unwrap();

    let entry = tugarc_core::archive::archive_root(&paths, &s.root)
        .join("rail")
        .join(tugarc_core::archive::compact_stamp(CREATED));
    std::fs::create_dir_all(&entry).unwrap();
    std::fs::write(entry.join("brief.md"), "# The rail brief\n\nBody.\n").unwrap();
    std::fs::write(
        entry.join("arc.json"),
        serde_json::json!({
            "name": "rail",
            "created": CREATED,
            "archived_at": "2026-11-01T00:03:00Z",
            "fate": "joined",
            "join_sha": join,
            "base_branch": "main",
            "files": ["brief.md"],
        })
        .to_string(),
    )
    .unwrap();
    join
}

#[test]
fn list_and_show_read_a_docket_and_its_threads() {
    let s = Scratch::new();
    let join = seed_joined_arc(&s);
    let paths = s.paths();

    let rail = docket::create_docket(&paths, &s.root, "Rail work").unwrap();
    let arc = docket::resolve_item(
        &paths,
        &s.root,
        &docket::FileItem::Arc {
            name: "rail".into(),
            project_dir: None,
            created: None,
        },
    )
    .unwrap();
    let out = docket::file_items(&paths, &s.root, &rail.id, &[arc]).unwrap();
    assert_eq!(out[0].outcome, docket::Outcome::Filed);

    let old = docket::create_docket(&paths, &s.root, "Old").unwrap();
    docket::file_items(
        &paths,
        &s.root,
        &old.id,
        &[ResolvedItem {
            item: DocketItem::Commit {
                sha: join.clone(),
                filed_at: String::new(),
            },
            brief_text: None,
        }],
    )
    .unwrap();
    docket::retire_docket(&paths, &s.root, &old.id, true).unwrap();

    // `list` reads the checkout it runs in; a retired docket needs `--all`.
    let live = s.ok(&s.root, &["docket", "list"]);
    assert!(
        live.contains(&format!("{}  Rail work  1 thread", rail.id)),
        "{live}"
    );
    assert!(!live.contains("Old"), "{live}");
    let all = s.ok(&s.root, &["docket", "list", "--all"]);
    assert!(
        all.contains(&format!("{}  Old  1 thread  retired", old.id)),
        "{all}"
    );
    let rows = s.json(&s.root, &["docket", "list", "--all", "--json"]);
    assert_eq!(rows["data"].as_array().unwrap().len(), 2);

    // `show` needs no repository.
    let elsewhere = tempfile::tempdir().unwrap();
    let shown = s.json(elsewhere.path(), &["docket", "show", &rail.id, "--json"]);
    let data = &shown["data"];
    assert_eq!(data["name"], "Rail work");
    assert_eq!(data["project_dir"], s.root.to_str().unwrap());
    let threads = data["threads"].as_array().unwrap();
    assert_eq!(threads.len(), 1, "{shown}");
    let t = &threads[0];
    assert_eq!(t["key"], format!("arc:rail@{CREATED}"));
    assert_eq!(t["arc"]["fate"], "joined");
    assert_eq!(t["arc"]["join_sha"], join.as_str());
    assert_eq!(t["arc"]["filed"], true);
    assert_eq!(t["brief"]["title"], "The rail brief");
    assert_eq!(t["sessions"][0]["stage"], "implement");
    let commits: Vec<(String, String)> = t["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["role"].as_str().unwrap().to_string(),
                c["subject"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        commits,
        vec![
            ("round".to_string(), "Step 1: The store".to_string()),
            ("join".to_string(), "Add the rail".to_string()),
        ]
    );

    let text = s.ok(elsewhere.path(), &["docket", "show", &rail.id]);
    assert!(
        text.starts_with(&format!("Rail work  {}\n", rail.id)),
        "{text}"
    );
    assert!(
        text.contains(&format!("tugtool arc show rail --created {CREATED}")),
        "{text}"
    );
    assert!(text.contains(&format!("git show {join}")), "{text}");

    let absent = s
        .tug(elsewhere.path())
        .args(["docket", "show", "00ff00ff"])
        .output()
        .unwrap();
    assert_eq!(absent.status.code(), Some(3), "{absent:?}");
}

#[test]
fn show_prints_an_ideas_thread_with_a_stale_brief() {
    let s = Scratch::new();
    let paths = s.paths();
    let idea = tugarc_core::idea::create_idea(&paths, &s.root, "Lineage", None).unwrap();
    let inbox = docket::create_docket(&paths, &s.root, "Inbox").unwrap();
    let item = docket::resolve_item(
        &paths,
        &s.root,
        &docket::FileItem::Idea {
            id: idea.id.clone(),
        },
    )
    .unwrap();
    docket::file_items(&paths, &s.root, &inbox.id, &[item]).unwrap();

    const V1: &str = "# Sketch\n\nWant it.\n\nSource: session x, turns 1–2\n";
    const V2: &str = "# Sketch\n\nWant it more.\n\nSource: session x, turns 1–5\n";
    let kept = tugarc_core::sketch::keep_sketch(&paths, &s.root, &idea.id, V1).unwrap();
    std::fs::create_dir_all(s.root.join("briefs")).unwrap();
    std::fs::write(
        s.root.join("briefs/lineage-brief.md"),
        "# Lineage\n\nDecided.\n",
    )
    .unwrap();
    tugarc_core::sketch::record_brief(
        &paths,
        &s.root,
        &kept.id,
        Path::new("briefs/lineage-brief.md"),
        1,
        None,
    )
    .unwrap();
    tugarc_core::sketch::keep_sketch(&paths, &s.root, &idea.id, V2).unwrap();

    let text = s.ok(&s.root, &["docket", "show", &inbox.id]);
    assert!(
        text.contains(&format!("thread idea:{}\n", idea.id)),
        "{text}"
    );
    assert!(
        text.contains(&format!(
            "  idea     {} \"Lineage\"  (filed)  · tugtool idea show {}\n",
            idea.id, idea.id
        )),
        "{text}"
    );
    assert!(
        text.contains("  brief    v1 (stale: from sketch v1, now v2) Lineage"),
        "{text}"
    );
}
