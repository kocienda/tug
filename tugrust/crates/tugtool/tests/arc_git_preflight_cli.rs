//! `tugtool arc` refuses by name on a machine whose git it cannot use.
//!
//! Tug shells out to `git` from an arc's every verb and ships no git of its
//! own — git is GPLv2-only, so the offer points at Apple's Command Line Tools.
//! Without the preflight a missing git surfaced as whatever internal worktree
//! step reached for it first, phrased as that step's error, which told the user
//! nothing about what was actually wrong.
//!
//! The two states are produced honestly rather than mocked. **No git at all**
//! is an empty `PATH` plus `TUG_XCODE_SELECT_BIN` pointed at a script that
//! exits 2, which is what `xcode-select -p` does on a Mac with no active
//! developer directory — emptying `PATH` alone would not reach the absolute
//! `/usr/bin/xcode-select`, and that absoluteness is deliberate. **A git below
//! the floor** is a `PATH` carrying a `git` that answers `git version 2.19.1`,
//! which also exercises the branch that matters most: a `PATH` git that is not
//! `/usr/bin/git` is version-checked directly and `xcode-select` is never
//! consulted at all, so no dialog can be popped at a user who has a perfectly
//! good git of their own.

mod common;
use common::tugtool;

use std::path::Path;
use std::process::Output;

/// Write `body` to `dir/name` as an executable script.
fn script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

/// Run an arc verb with `PATH` and `xcode-select` as the caller describes them.
fn arc(tmp: &Path, path: &str, xcode_select: Option<&Path>, args: &[&str]) -> Output {
    let mut cmd = tugtool();
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd.env("PATH", path);
    match xcode_select {
        Some(bin) => cmd.env("TUG_XCODE_SELECT_BIN", bin),
        None => cmd.env_remove("TUG_XCODE_SELECT_BIN"),
    };
    cmd.arg("arc").args(args).output().unwrap()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

#[test]
fn no_git_refuses_every_verb_that_needs_one() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // `xcode-select -p` exits 2 when no developer directory is active. Nothing
    // else on this machine is reachable, so there is no git anywhere.
    let xcs = script(tmp.path(), "xcode-select", "#!/bin/sh\nexit 2\n");

    for verb in [
        &["create", "nope"][..],
        &["status", "nope"][..],
        &["commit", "nope", "--message", "m"][..],
        &["replay", "nope"][..],
        &["list"][..],
    ] {
        let out = arc(tmp.path(), bin.to_str().unwrap(), Some(&xcs), verb);
        let said = stderr(&out);
        assert_eq!(
            out.status.code(),
            Some(1),
            "arc {verb:?} should refuse, said: {said}"
        );
        assert!(
            said.contains("git is not installed"),
            "arc {verb:?} should say what is missing, said: {said}"
        );
        // The refusal carries its own fix, because the CLI has no button.
        assert!(
            said.contains("xcode-select --install"),
            "arc {verb:?} should name the install, said: {said}"
        );
        assert!(
            said.contains("about 3 GB"),
            "arc {verb:?} should say what it costs, said: {said}"
        );
        // The floor is not the problem here, and saying so would bury the fact
        // that there is no git at all.
        assert!(
            !said.contains("too old"),
            "arc {verb:?} should not talk about the floor, said: {said}"
        );
    }
}

#[test]
fn the_two_verbs_that_need_no_git_still_answer() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let xcs = script(tmp.path(), "xcode-select", "#!/bin/sh\nexit 2\n");

    // `arc config` reads the project's declared commands and `arc documents`
    // reports paths under `.tug/arcs/`. Both are how a stuck user finds out
    // where they are, so neither is refused.
    let config = arc(tmp.path(), bin.to_str().unwrap(), Some(&xcs), &["config"]);
    assert!(
        !stderr(&config).contains("git is not installed"),
        "arc config needs no git: {}",
        stderr(&config)
    );

    let docs = arc(
        tmp.path(),
        bin.to_str().unwrap(),
        Some(&xcs),
        &["documents", "nope"],
    );
    assert!(
        !stderr(&docs).contains("git is not installed"),
        "arc documents needs no git: {}",
        stderr(&docs)
    );
}

#[test]
fn a_git_below_the_floor_is_named_and_never_asks_apple() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    script(&bin, "git", "#!/bin/sh\necho 'git version 2.19.1'\n");
    // `xcode-select` here would exit 0 and claim a developer directory. The
    // assertion below is that it is never run: a `PATH` git that is not
    // `/usr/bin/git` is answered directly, which is what keeps Apple's install
    // dialog away from a user who has their own git.
    let marker = tmp.path().join("xcode-select-was-run");
    let xcs = script(
        tmp.path(),
        "xcode-select",
        &format!("#!/bin/sh\ntouch {}\nexit 0\n", marker.display()),
    );

    let out = arc(
        tmp.path(),
        bin.to_str().unwrap(),
        Some(&xcs),
        &["status", "nope"],
    );
    let said = stderr(&out);
    assert_eq!(out.status.code(), Some(1), "an old git refuses: {said}");
    assert!(
        said.contains("git 2.19.1 is too old"),
        "the refusal names the version it found: {said}"
    );
    assert!(
        said.contains("2.23"),
        "the refusal names the floor when the floor is the problem: {said}"
    );
    // Somebody else's git is not fixed by installing Apple's — that would leave
    // the old one first on PATH — so the refusal points at the path instead.
    assert!(
        said.contains(bin.join("git").to_str().unwrap()),
        "the refusal names the git it found: {said}"
    );
    assert!(
        !said.contains("xcode-select --install"),
        "a third-party git is not fixed by Apple's installer: {said}"
    );
    assert!(
        !marker.exists(),
        "a PATH git that is not the shim must never consult xcode-select"
    );
}

#[test]
fn this_machines_git_lets_the_verbs_through() {
    // The control: with the ambient PATH — every machine that can build this
    // has git — the preflight says nothing and the verb runs and fails on its
    // own terms (no such arc), rather than on git's.
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = tugtool();
    cmd.env("TMPDIR", tmp.path());
    cmd.env("TUG_DATA_DIR", tmp.path().join("state"));
    let out = cmd.arg("arc").arg("status").arg("nope").output().unwrap();
    let said = stderr(&out);
    assert!(
        !said.contains("git is not installed") && !said.contains("too old"),
        "a machine with git is never told about git: {said}"
    );
}
