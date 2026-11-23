//! `tugtool sketch record|show`: an arc's `sketch.md` kept as versions under
//! the sketch's own id, and read back by that id from anywhere.

mod common;
use common::tugtool;
use tugarc_core::idea;
use tugarc_core::sketch;
use tugcore::instance::Paths;
use tugcore::test_fixtures::git::{GitFixture, git};

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn tug(state: &Path, cwd: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.env("TMPDIR", state);
    cmd.env("TUG_DATA_DIR", state);
    cmd.env("TUG_SESSION_INDEX_DB", Paths::under(state).session_index_db);
    cmd.current_dir(cwd);
    cmd
}

fn ok(out: Output) -> String {
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

const V1: &str = "# Sketch\n\nWant the archive.\n\nSource: session x, turns 1–2\n";
const V2: &str = "# Sketch\n\nWant the archive and the atoms.\n\nSource: session x, turns 1–4\n";

#[test]
fn record_keeps_each_version_and_show_reads_them_back() {
    let repo_dir = tempfile::tempdir().unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let state = state_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "base"]);

    let sketch = root.join(".tug/arcs/drawn/sketch.md");
    std::fs::create_dir_all(sketch.parent().unwrap()).unwrap();
    std::fs::write(&sketch, V1).unwrap();

    let first = ok(tug(&state, &root)
        .args(["sketch", "record", "drawn"])
        .output()
        .unwrap());
    let id = first
        .strip_prefix("sketch ")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("an id: {first}"))
        .to_string();
    assert_eq!(first.trim(), format!("sketch {id} v1 (minted)"));

    let again = ok(tug(&state, &root)
        .args(["sketch", "record", "drawn"])
        .output()
        .unwrap());
    assert_eq!(again.trim(), format!("sketch {id} v1 (unchanged)"));

    std::fs::write(&sketch, V2).unwrap();
    let second = ok(tug(&state, &root)
        .args(["sketch", "record", "drawn"])
        .output()
        .unwrap());
    assert_eq!(second.trim(), format!("sketch {id} v2"));

    // `show` needs no repository: it reads from anywhere.
    let elsewhere = tempfile::tempdir().unwrap();
    let show = |args: &[&str]| {
        ok(tug(&state, elsewhere.path())
            .args(["sketch", "show", &id])
            .args(args)
            .output()
            .unwrap())
    };
    assert_eq!(show(&[]), V2, "the latest, verbatim");
    assert_eq!(show(&["--version", "1"]), V1);
    let versions = show(&["--versions"]);
    assert_eq!(versions.lines().count(), 2, "{versions}");
    assert!(versions.starts_with("v1  "), "{versions}");

    let json: serde_json::Value = serde_json::from_str(&show(&["--json"])).unwrap();
    assert_eq!(json["data"]["id"], id.as_str());
    assert_eq!(json["data"]["version"], 2);
    assert_eq!(json["data"]["text"], V2);
    assert_eq!(json["data"]["project_dir"], root.to_str().unwrap());
    assert_eq!(json["data"]["arc"]["name"], "drawn");

    let absent = tug(&state, elsewhere.path())
        .args(["sketch", "show", "00ff00ff"])
        .output()
        .unwrap();
    assert_eq!(absent.status.code(), Some(3), "{absent:?}");
}

/// A scratch repo with one commit and a scratch data root; the temp dirs
/// live as long as the tuple.
fn scratch() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, PathBuf) {
    let repo_dir = tempfile::tempdir().unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let state = state_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "base"]);
    (repo_dir, state_dir, root, state)
}

fn json(out: Output) -> serde_json::Value {
    serde_json::from_str(&ok(out)).unwrap()
}

#[test]
fn keep_then_show_lists_each_version_with_its_author_and_source() {
    let (_r, _s, root, state) = scratch();
    let paths = Paths::under(&state);
    let made = idea::create_idea(&paths, &root, "Keep me", None).unwrap();

    std::fs::write(root.join("keep.md"), V1).unwrap();
    let first = ok(tug(&state, &root)
        .args(["sketch", "keep", "--idea", &made.id, "--file", "keep.md"])
        .output()
        .unwrap());
    let id = first
        .strip_prefix("sketch ")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("an id: {first}"))
        .to_string();
    assert_eq!(first.trim(), format!("sketch {id} v1 (minted)"));

    std::fs::write(root.join("keep.md"), V2).unwrap();
    let second = json(
        tug(&state, &root)
            .args([
                "sketch", "keep", "--idea", &made.id, "--file", "keep.md", "--json",
            ])
            .output()
            .unwrap(),
    );
    assert_eq!(second["data"]["id"], id.as_str());
    assert_eq!(second["data"]["version"], 2);

    let shown = json(
        tug(&state, &root)
            .args(["sketch", "show", &id, "--json"])
            .output()
            .unwrap(),
    );
    let data = &shown["data"];
    assert_eq!(data["idea"], made.id.as_str());
    assert_eq!(data["versions"].as_array().unwrap().len(), 2);
    assert_eq!(data["versions"][0]["author"], "model");
    assert_eq!(data["versions"][1]["author"], "model");
    assert_eq!(data["versions"][1]["source"]["session"], "x");
    assert_eq!(data["versions"][1]["source"]["turns"], "1–4");
    assert_eq!(data["briefs"].as_array().unwrap().len(), 0);

    std::fs::write(root.join("bare.md"), "# Sketch\n\nNo source line.\n").unwrap();
    let refused = tug(&state, &root)
        .args(["sketch", "keep", "--idea", &made.id, "--file", "bare.md"])
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(1), "{refused:?}");
}

#[test]
fn record_brief_then_for_brief_finds_the_version() {
    let (_r, _s, root, state) = scratch();
    let paths = Paths::under(&state);
    let made = idea::create_idea(&paths, &root, "Brief me", None).unwrap();
    let kept = sketch::keep_sketch(&paths, &root, &made.id, V1).unwrap();

    std::fs::create_dir_all(root.join("briefs")).unwrap();
    std::fs::write(
        root.join("briefs/thing-brief.md"),
        "# The thing\n\nDecided.\n",
    )
    .unwrap();
    let record = |args: &[&str]| {
        json(
            tug(&state, &root)
                .args([
                    "sketch",
                    "record-brief",
                    &kept.id,
                    "--path",
                    "briefs/thing-brief.md",
                ])
                .args(args)
                .args(["--json"])
                .output()
                .unwrap(),
        )
    };
    let first = record(&["--from-version", "1", "--session", "s-1"]);
    assert_eq!(first["data"]["n"], 1);
    assert_eq!(first["data"]["title"], "The thing");
    assert_eq!(first["data"]["path"], "briefs/thing-brief.md");
    assert_eq!(first["data"]["sketch_version"], 1);
    assert_eq!(first["data"]["session"], "s-1");
    let again = record(&["--from-version", "1"]);
    assert_eq!(again["data"]["n"], 1, "unchanged bytes append nothing");

    let found = json(
        tug(&state, &root)
            .args(["sketch", "for-brief", "briefs/thing-brief.md", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(found["data"]["sketch"], kept.id.as_str());
    assert_eq!(found["data"]["brief"]["n"], 1);

    let unknown = tug(&state, &root)
        .args([
            "sketch",
            "record-brief",
            &kept.id,
            "--path",
            "briefs/thing-brief.md",
            "--from-version",
            "9",
        ])
        .output()
        .unwrap();
    assert_eq!(unknown.status.code(), Some(1), "{unknown:?}");

    std::fs::write(
        root.join("briefs/thing-brief.md"),
        "# The thing\n\nRevised.\n",
    )
    .unwrap();
    let none = tug(&state, &root)
        .args(["sketch", "for-brief", "briefs/thing-brief.md"])
        .output()
        .unwrap();
    assert_eq!(none.status.code(), Some(3), "{none:?}");
}

#[test]
fn record_over_a_users_version_refuses_and_puts_the_users_text_back() {
    let (_r, _s, root, state) = scratch();
    let paths = Paths::under(&state);
    let working = root.join(".tug/arcs/drawn/sketch.md");
    std::fs::create_dir_all(working.parent().unwrap()).unwrap();
    std::fs::write(&working, V1).unwrap();
    let kept = json(
        tug(&state, &root)
            .args(["sketch", "record", "drawn", "--json"])
            .output()
            .unwrap(),
    );
    let id = kept["data"]["id"].as_str().unwrap().to_string();

    const MINE: &str = "# Sketch\n\nWhat I actually want.\n";
    sketch::edit_sketch(&paths, &root, &id, MINE, 1).unwrap();

    let docs = json(
        tug(&state, &root)
            .args(["arc", "documents", "drawn", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(docs["data"]["sketch_id"], id.as_str());
    assert_eq!(docs["data"]["sketch_author"], "user");

    std::fs::write(&working, V2).unwrap();
    let refused = tug(&state, &root)
        .args(["sketch", "record", "drawn"])
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(1), "{refused:?}");
    assert_eq!(std::fs::read_to_string(&working).unwrap(), MINE);
}
