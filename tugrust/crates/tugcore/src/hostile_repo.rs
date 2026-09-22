//! The hostile-filename fixture — one repo whose every name git considers unusual.
//!
//! The defect this arc exists to remove survived because every fixture in the
//! tree is ASCII: git C-quotes an unusual path in any line-oriented listing,
//! Tug stored the quoted form as the path, and no test ever saw a name that
//! triggered the quoting. A test corpus that cannot produce the input cannot
//! find the bug, so the remedy starts with a corpus that can.
//!
//! The fixture lives in `tugcore` because it is shared: the round trips that
//! exercise it run in `tugchanges-core` (`changes` → `commit`), in
//! `tugarc-core` (`lay`/`commit`/`join`) and over `tugtool`'s file verbs, and
//! three copies of a roster of hostile names is three chances for one of them
//! to quietly lose the name that matters. It is gated behind the
//! `test-fixtures` feature and enabled from dev-dependencies only.
//!
//! Nothing here spawns a listing. The seeding runs `init`, `add` and `commit`;
//! reading paths back out is the caller's business, through whatever door the
//! caller is testing.

use std::path::Path;
use std::process::Command;

/// One hostile name, with the property that makes it hostile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostileName {
    /// A stable ASCII handle a test can select by.
    pub label: &'static str,
    /// The file's repo-relative name, as its real bytes.
    pub path: &'static str,
    /// What about the name git (or a pathspec) treats specially.
    pub why: &'static str,
}

/// The roster. Every name here is a real, legal filename on APFS; none of them
/// is a name a user should have to avoid.
///
/// The first is the one that found the defect — a scan of a Polish army record
/// in a real project, whose `ł` is UTF-8 `C5 82` and which git renders as
/// `\305\202` in any listing without `-z`.
pub const HOSTILE_NAMES: &[HostileName] = &[
    HostileName {
        label: "polish_l",
        path: "01_Stanisław_Kocienda_Form_B.jpg",
        why: "non-ASCII (ł, UTF-8 C5 82) — git C-quotes it as \\305\\202",
    },
    HostileName {
        // Written decomposed on purpose: `o` + U+0301, not U+00F3. On macOS
        // APFS preserves the bytes as written, while git precomposes what it
        // reports whenever `core.precomposeunicode` is on — which `git init`
        // turns on there. Off macOS there is no such default and nothing to
        // precompose, so the disk's bytes are what git reports. This is the
        // one name whose disk spelling and git spelling can differ, which is
        // why it is in the roster — and why every expectation about it goes
        // through [`as_git_reports_it`] rather than through `path`.
        label: "decomposed_o",
        path: "No\u{301}tes.txt",
        why: "NFD — decomposes to o + U+0301, where git may report NFC",
    },
    HostileName {
        label: "en_dash",
        path: "range–2026.txt",
        why: "non-ASCII punctuation (en dash, UTF-8 E2 80 93)",
    },
    HostileName {
        label: "space",
        path: "plain name.txt",
        why: "a space — notably NOT quoted by porcelain v2, so it is the control",
    },
    HostileName {
        label: "tab",
        path: "tab\tx.txt",
        why: "a tab — quoted, and the field separator of the rename shape",
    },
    HostileName {
        label: "double_quote",
        path: "quo\"te.txt",
        why: "a double quote — quoted and escaped, and the quoting's own delimiter",
    },
    HostileName {
        label: "backslash",
        path: "back\\slash.txt",
        why: "a backslash — quoted and escaped, and the escape's own character",
    },
    HostileName {
        label: "leading_dash",
        path: "-leading.txt",
        why: "a leading dash — reads as an option to anything that forgets `--`",
    },
    HostileName {
        label: "glob_star",
        path: "*.jpg",
        why: "literally named `*.jpg` — a pathspec pattern, not a path",
    },
    HostileName {
        label: "newline",
        path: "two\nlines.txt",
        why: "a newline — quoted, and it breaks any line-oriented listing outright",
    },
];

/// The roster entry with `label`. Panics when no such label exists, because a
/// test selecting a name that is not in the roster is a test that will silently
/// assert nothing.
pub fn hostile(label: &str) -> &'static HostileName {
    HOSTILE_NAMES
        .iter()
        .find(|n| n.label == label)
        .unwrap_or_else(|| panic!("no hostile name labelled {label:?}"))
}

/// `decomposed_o` as it is written to disk: `o` + U+0301.
pub const NFD_NAME: &str = "No\u{301}tes.txt";

/// `decomposed_o` composed: U+00F3. What git reports where it precomposes.
pub const NFC_NAME: &str = "N\u{f3}tes.txt";

/// Whether git precomposes the names it reports on this platform.
///
/// `core.precomposeunicode` is a macOS-only default — `git init` turns it on
/// there and nowhere else — so this is a platform fact, not a repo setting,
/// and reading it off `cfg!` keeps a caller from having to spawn git to find
/// out. Measured against git's actual behaviour in this module's tests.
pub const GIT_PRECOMPOSES: bool = cfg!(target_os = "macos");

/// The spelling git reports for a roster name on this platform.
///
/// Every name in the roster is reported verbatim except the decomposed one,
/// and that one only where git precomposes. This is the one place that
/// knowledge lives: a test asserting on the names a listing hands back maps
/// the roster through here rather than hard-coding a spelling, because a
/// hard-coded spelling is right on one platform and wrong on the other.
pub fn as_git_reports_it(path: &str) -> &str {
    if GIT_PRECOMPOSES && path == NFD_NAME {
        NFC_NAME
    } else {
        path
    }
}

/// The whole roster as git reports it, in roster order.
///
/// Unsorted on purpose: a caller that compares against a listing sorts both
/// sides itself, and a caller that cares about order should not have had one
/// imposed here.
pub fn hostile_paths_as_git_reports_them() -> Vec<String> {
    HOSTILE_NAMES
        .iter()
        .map(|n| as_git_reports_it(n.path).to_string())
        .collect()
}

/// Seed `root` as a git repo holding one committed ASCII file (`base.txt`) and
/// every hostile name from [`HOSTILE_NAMES`] present on disk but **untracked**.
///
/// That is the eucit shape: the files exist and are correctly named, and the
/// commit about to be attempted is their first. The caller supplies `root` —
/// usually a `tempfile::TempDir` path — so each crate keeps its own tempdir
/// convention.
pub fn seed_hostile_repo(root: &Path) -> Result<(), String> {
    git(root, &["init", "-q", "-b", "main"])?;
    git(root, &["config", "user.email", "t@t.test"])?;
    git(root, &["config", "user.name", "t"])?;
    std::fs::write(root.join("base.txt"), "base\n").map_err(|e| format!("write base.txt: {e}"))?;
    git(root, &["add", "base.txt"])?;
    git(root, &["commit", "-q", "-m", "init"])?;
    write_hostile_files(root)
}

/// Write every hostile name into `root` with one line of content each,
/// touching git not at all. Separate from [`seed_hostile_repo`] so a test can
/// re-create them after committing or deleting them.
pub fn write_hostile_files(root: &Path) -> Result<(), String> {
    for name in HOSTILE_NAMES {
        let body = format!("{}\n", name.label);
        std::fs::write(root.join(name.path), body)
            .map_err(|e| format!("write {:?}: {e}", name.path))?;
    }
    Ok(())
}

/// Commit every hostile file, so a test can start from them tracked.
///
/// The paths go to git as explicit operands rather than through `add -A`, which
/// is deliberate: `-A` would hide the very failure mode under test, where a
/// path Tug manufactured is handed to git as a pathspec and matches nothing.
pub fn commit_hostile_files(root: &Path, message: &str) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(HOSTILE_NAMES.iter().map(|n| n.path));
    git(root, &args)?;
    git(root, &["commit", "-q", "-m", message])
}

/// Run git in `root`, erroring with its stderr on a non-zero exit.
fn git(root: &Path, args: &[&str]) -> Result<(), String> {
    let out = command(root, args)
        .output()
        .map_err(|e| format!("spawn git {args:?}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// A git command rooted at `root`, through the one constructor.
fn command(root: &Path, args: &[&str]) -> Command {
    let mut cmd = crate::git_command();
    cmd.arg("-C").arg(root).args(args);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run git in `root` and hand back stdout's **raw bytes**. Every assertion
    /// about normalization is an assertion about bytes; a `String` round trip
    /// would be a second normalization step measuring itself.
    fn stdout(root: &Path, args: &[&str]) -> Vec<u8> {
        let out = command(root, args).output().expect("git runs");
        assert!(out.status.success(), "git {args:?}");
        out.stdout
    }

    const NFD: &str = NFD_NAME; // o + U+0301
    const NFC: &str = NFC_NAME; // U+00F3

    /// The measurement the door's design turns on: **git reports a name as
    /// this platform's precomposition leaves it, and accepts every spelling it
    /// precomposes as a pathspec.**
    ///
    /// `git init` sets `core.precomposeunicode=true` on macOS, so a file whose
    /// bytes on disk are NFD is reported as NFC — in the quoted listing and in
    /// the `-z` one alike, because precomposition happens before the quoting
    /// does. Both spellings resolve as operands there, because git precomposes
    /// a pathspec too. Off macOS there is no such default and nothing to
    /// precompose: the listing is the disk's bytes, NFD *is* the reported
    /// name, and NFC is a different byte string that matches no file.
    ///
    /// The conclusion for `[B01]`: **the door does not normalize on
    /// construction.** Where git precomposes, normalizing again is redundant;
    /// where it does not — off macOS, and on macOS under
    /// `core.precomposeunicode=false`, exercised below — the file's real name
    /// *is* the decomposed one, and precomposing it would manufacture a
    /// different, nonexistent path: the very failure shape this arc exists to
    /// remove. The door hands back git's bytes and nothing else, which is the
    /// one rule that is right on both platforms.
    ///
    /// What this leaves open is the attribution join: the ledger stores the
    /// spelling the tool input carried, git's side is whatever git reports, and
    /// `-z` does not make those agree. That is a narrower, separate defect, and
    /// step 3 confirms it against this fixture.
    #[test]
    fn git_precomposes_what_it_reports_and_accepts_either_spelling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]).unwrap();
        git(root, &["config", "user.email", "t@t.test"]).unwrap();
        git(root, &["config", "user.name", "t"]).unwrap();

        // macOS `git init` turns precomposition on and nothing else does; the
        // measurements below are measurements of that default, so assert it
        // rather than assume it. `config` exits non-zero when the key is
        // unset, which is the off-macOS answer, so read it without the success
        // check `stdout` applies.
        let configured = command(root, &["config", "core.precomposeunicode"])
            .output()
            .expect("git runs");
        let configured = String::from_utf8_lossy(&configured.stdout)
            .trim()
            .to_owned();
        if GIT_PRECOMPOSES {
            assert_eq!(
                configured, "true",
                "git init sets precomposition on this platform"
            );
        } else {
            assert_eq!(
                configured, "",
                "git init leaves precomposition unset off macOS"
            );
        }

        // What a listing will say, here.
        let reported = as_git_reports_it(NFD);

        // Written decomposed. APFS preserves the bytes as written.
        std::fs::write(root.join(NFD), "hello\n").unwrap();
        let on_disk: Vec<String> = std::fs::read_dir(root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != ".git")
            .collect();
        assert_eq!(on_disk, [NFD.to_string()], "the disk kept the NFD bytes");

        // Git reports its precomposed spelling, through `-z` as much as
        // without it.
        let untracked = stdout(root, &["status", "--porcelain=v2", "-z"]);
        assert_eq!(
            untracked,
            format!("? {reported}\0").into_bytes(),
            "git reported the name as this platform leaves it"
        );

        // And takes as a pathspec every spelling it precomposes — both where
        // it precomposes, the decomposed one alone where it does not — always
        // answering in the spelling it reports.
        git(root, &["add", "--", NFD]).unwrap();
        git(root, &["commit", "-q", "-m", "add it"]).unwrap();
        let resolvable: &[&str] = if GIT_PRECOMPOSES { &[NFD, NFC] } else { &[NFD] };
        for spelling in resolvable {
            assert_eq!(
                stdout(root, &["ls-files", "-z", "--", spelling]),
                format!("{reported}\0").into_bytes(),
                "{spelling:?} resolved, and answered as git reports it"
            );
        }

        // With precomposition off, the worktree scan yields the disk's own
        // bytes — so NFD *is* the real name there, and a door that precomposed
        // would hand git a path that does not exist. Where git was
        // precomposing, the committed file shows up again here precisely
        // because of the disagreement: the index holds it as NFC while the
        // disk holds NFD, so the unprecomposed scan sees a name the index does
        // not have and calls it untracked. Where it was not, the index already
        // holds the disk's bytes and the file stays committed and quiet.
        std::fs::write(root.join("ru\u{308}ck.txt"), "x\n").unwrap();
        let raw = stdout(
            root,
            &[
                "-c",
                "core.precomposeunicode=false",
                "status",
                "--porcelain=v2",
                "-z",
            ],
        );
        let disagreed = if GIT_PRECOMPOSES {
            format!("? {NFD}\0")
        } else {
            String::new()
        };
        assert_eq!(
            raw,
            format!("{disagreed}? ru\u{308}ck.txt\0").into_bytes(),
            "unprecomposed, the listing is the disk's bytes verbatim"
        );
    }

    /// Every hostile name seeds, and seeds as its real bytes — the fixture's
    /// own smoke test, so a roster entry that cannot be written on this
    /// filesystem fails here rather than inside somebody else's round trip.
    #[test]
    fn every_hostile_name_lands_on_disk_under_its_real_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        seed_hostile_repo(root).expect("the fixture seeds");

        for name in HOSTILE_NAMES {
            let body = std::fs::read_to_string(root.join(name.path))
                .unwrap_or_else(|e| panic!("{} ({}): {e}", name.label, name.why));
            assert_eq!(body, format!("{}\n", name.label));
        }

        // And they are untracked, which is the eucit shape: correctly named
        // files whose first commit is the one that failed.
        let listed = stdout(
            root,
            &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        );
        let count = listed.iter().filter(|b| **b == 0).count();
        assert_eq!(count, HOSTILE_NAMES.len(), "all of them, none tracked");
    }

    /// The roster is addressable by label and every label is distinct.
    #[test]
    fn the_roster_is_addressable_and_its_labels_are_unique() {
        let mut labels: Vec<&str> = HOSTILE_NAMES.iter().map(|n| n.label).collect();
        labels.sort_unstable();
        let before = labels.len();
        labels.dedup();
        assert_eq!(labels.len(), before, "labels are unique");
        assert_eq!(hostile("polish_l").path, "01_Stanisław_Kocienda_Form_B.jpg");
        assert_eq!(hostile("decomposed_o").path, NFD);
    }
}
