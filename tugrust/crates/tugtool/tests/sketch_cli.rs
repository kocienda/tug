//! `tugtool sketch record|show`: an arc's `sketch.md` kept as versions under
//! the sketch's own id, and read back by that id from anywhere.

mod common;
use common::tugtool;
use tugcore::test_fixtures::git::{GitFixture, git};

use std::path::Path;
use std::process::{Command, Output};

fn tug(state: &Path, cwd: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.env("TMPDIR", state);
    cmd.env("TUG_DATA_DIR", state);
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
