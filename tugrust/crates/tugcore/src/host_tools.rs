//! Detection of the host tools Tug shells out to but does not ship — today that
//! is `git`, and only `git` — plus the offer that gets one onto the machine.
//!
//! Tug ships no git. Bundling it the way `tmux` is bundled would work and is
//! refused on licensing: git is GPLv2-only and Tug takes on no GPL obligations,
//! so the GPL program arrives from Apple, installed by the user, from Apple's
//! servers. Tug only points, via `xcode-select --install`.
//!
//! **The probe order is load-bearing and must not be simplified.** On a Mac
//! with no active developer directory, `/usr/bin/git` is not git at all — it is
//! Apple's shim, byte-identical to `/usr/bin/clang` and hardlinked under every
//! developer-tool name — and its job is to pop the "install the command line
//! developer tools?" system modal. So a naive `git --version` at launch throws
//! a dialog in the user's face before Tug has said a word, and would be wrong
//! as often as it was rude: a machine with Homebrew git and no Command Line
//! Tools has a perfectly good git. Hence [`route`]: resolve `git` on `PATH`
//! first and, when it lands anywhere other than the shim, run `--version` and
//! stop — the developer-directory question never comes up. Only the shim (or
//! nothing at all) reaches `xcode-select -p`, which is silent and never
//! prompts, and only its exit 0 makes `git --version` safe to run.
//!
//! The decision, with the evidence behind it, is [D171] in
//! `tuglaws/design-decisions.md`.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::version::{parse_leading_version, parse_version_after_words};

/// Apple's shim. Present on every booted Mac whether or not a developer
/// directory is active, so its presence proves nothing and running it may
/// prompt.
const SHIM_GIT: &str = "/usr/bin/git";

/// Where the Command Line Tools land. Watched rather than polled, and the
/// existence test the watch settles on.
pub const COMMAND_LINE_TOOLS_DIR: &str = "/Library/Developer/CommandLineTools";

/// Test seam: where `xcode-select` lives. Absolute in production, because
/// `/usr/bin/xcode-select` is a sealed-System-volume Apple platform binary and
/// cannot be missing on a booted Mac — resolving it through `PATH` would let
/// somebody's shim answer for the OS. A test that needs a machine with no
/// developer directory has no other way to say so, since emptying `PATH` does
/// not reach an absolute path.
const XCODE_SELECT_ENV: &str = "TUG_XCODE_SELECT_BIN";
const XCODE_SELECT: &str = "/usr/bin/xcode-select";

/// The oldest git Tug can work with. `git switch` and `git restore` are both
/// used across the tree and both arrived in 2.23; every other subcommand and
/// flag Tug reaches for is older (`--porcelain=v2` is 2.11, `--no-optional-locks`
/// is 2.15). Below this, an arc fails at `git switch` inside a worktree
/// operation rather than at the door, which is the failure this floor exists to
/// move forward.
pub const GIT_VERSION_FLOOR: &str = "2.23";

/// What the host carries, as the probe found it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostTools {
    /// The version `git --version` reported, or `None` when no usable git was
    /// reached — which covers both "nothing on `PATH`" and "only the shim, and
    /// no developer directory behind it".
    pub git_version: Option<String>,
    /// Where that git resolved. `None` when nothing resolved.
    pub git_path: Option<String>,
    /// `xcode-select -p`'s answer, when the probe had cause to ask. `None` both
    /// when there is no developer directory *and* when a real git off `PATH`
    /// made the question moot — those are distinguished by `git_version`.
    pub developer_dir: Option<String>,
}

impl HostTools {
    /// Whether the machine carries a git Tug can actually use: one that
    /// answered a version, and a version at or above the floor.
    pub fn is_usable(&self) -> bool {
        self.git_version.as_deref().is_some_and(meets_floor)
    }
}

/// Which of the two probe paths a `PATH` resolution puts us on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// A git that is not Apple's shim: run `--version` on it and stop. Nothing
    /// on this path may consult `xcode-select` — that is what keeps a
    /// Homebrew-git machine from being asked about developer tools it does not
    /// need, and what keeps the common case away from the shim entirely.
    RealGit(PathBuf),
    /// `PATH` landed on the shim, or on nothing. `xcode-select -p` is the only
    /// safe next question: it is silent, and exits non-zero when no developer
    /// directory is active.
    AskDeveloperDir,
}

/// Classify a `PATH` resolution. Pure, so the rule that protects the user from
/// Apple's modal is a testable fact rather than a comment. The caller hands in
/// the resolution with its symlinks followed — see [`probe`] — because the shim
/// is a *file* rather than a spelling: a `git` symlinked onto `/usr/bin/git`
/// must read as the shim, since running it pops the same modal.
pub fn route(resolved: Option<&Path>) -> Route {
    match resolved {
        Some(path) if path != Path::new(SHIM_GIT) => Route::RealGit(path.to_path_buf()),
        _ => Route::AskDeveloperDir,
    }
}

/// Whether `version` is at or above [`GIT_VERSION_FLOOR`]. Compares the leading
/// numeric components pairwise, so a pre-release suffix (`2.23.0.rc1`) does not
/// decide the answer and a shorter floor (`2.23`) compares against a longer
/// version (`2.39.5`) without either being padded.
pub fn meets_floor(version: &str) -> bool {
    let components = |s: &str| {
        s.split('.')
            .map(|part| part.parse::<u32>().ok())
            .take_while(Option::is_some)
            .flatten()
            .collect::<Vec<_>>()
    };
    let found = components(version);
    let floor = components(GIT_VERSION_FLOOR);
    if found.is_empty() {
        return false;
    }
    for (i, required) in floor.iter().enumerate() {
        match found.get(i) {
            Some(have) if have > required => return true,
            Some(have) if have < required => return false,
            // Equal so far; a version that simply runs out at a component the
            // floor still names (`2` against `2.23`) has not met it.
            Some(_) => continue,
            None => return false,
        }
    }
    true
}

/// Resolve `git` on `PATH`, returning the first executable-looking hit. Nothing
/// is run here — resolution is a filesystem question, and running the wrong
/// answer is the whole hazard.
fn git_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("git"))
        .find(|candidate| candidate.is_file())
}

/// The path with its symlinks followed and `.`/`..` resolved, or the path
/// unchanged when it cannot be resolved — a name that does not resolve is not
/// the shim either way, and losing it would lose the report.
fn follow_links(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Probe the host's git, in the order [`route`] describes.
///
/// Never prompts: the only command that can pop Apple's modal is `git
/// --version` against the shim, and it is reached only after `xcode-select -p`
/// has said a developer directory is active.
pub fn probe() -> HostTools {
    let found = git_on_path();
    // The shim test runs on the resolution with its symlinks followed, so a
    // `git` symlinked onto `/usr/bin/git` is recognised rather than run — and
    // running it is the modal. What gets reported is the un-followed hit,
    // because that is the name the user put on their `PATH`.
    let followed = found.as_deref().map(follow_links);
    match (route(followed.as_deref()), found) {
        (Route::RealGit(_), Some(path)) => {
            let version = git_version(&path);
            HostTools {
                git_version: version,
                git_path: Some(path.to_string_lossy().into_owned()),
                developer_dir: None,
            }
        }
        _ => {
            let Some(dir) = developer_dir() else {
                // No developer directory: the shim would prompt, so it is not
                // run, and there is no git here.
                return HostTools {
                    git_version: None,
                    git_path: None,
                    developer_dir: None,
                };
            };
            let shim = PathBuf::from(SHIM_GIT);
            let version = git_version(&shim);
            HostTools {
                // The shim is only ever reported as a path when it answered a
                // version — a `git_path` in the result names a git that works.
                git_path: version.is_some().then(|| SHIM_GIT.to_string()),
                git_version: version,
                developer_dir: Some(dir),
            }
        }
    }
}

/// Run `<git> --version` and read the version out of `git version X.Y.Z (…)`.
fn git_version(git: &Path) -> Option<String> {
    let output = Command::new(git).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_version_after_words(&text, 2).or_else(|| parse_leading_version(&text))
}

/// Ask `xcode-select -p` for the active developer directory. Silent by
/// contract — it never prompts — and exits non-zero when none is active.
fn developer_dir() -> Option<String> {
    let output = Command::new(xcode_select()).arg("-p").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!dir.is_empty()).then_some(dir)
}

/// Where to find `xcode-select`, honoring [`XCODE_SELECT_ENV`].
fn xcode_select() -> PathBuf {
    std::env::var_os(XCODE_SELECT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(XCODE_SELECT))
}

/// Ask macOS to install the Command Line Tools, returning `(ok, error)`.
///
/// This hands off to Apple's own installer UI; the command returns as soon as
/// the panel is up, so its success means "the offer was made", not "git is
/// here". What settles the row afterwards is a watch on
/// [`COMMAND_LINE_TOOLS_DIR`], which lives with whoever has an event loop.
pub fn offer_developer_tools() -> (bool, Option<String>) {
    match Command::new(xcode_select()).arg("--install").output() {
        Ok(out) => read_offer_outcome(
            out.status.code(),
            &String::from_utf8_lossy(&out.stderr),
            &String::from_utf8_lossy(&out.stdout),
        ),
        Err(e) => (false, Some(e.to_string())),
    }
}

/// Read `xcode-select --install`'s exit into an outcome.
///
/// Exit 1 with "already installed" is the normal answer on a configured
/// machine, and surfacing it as an error would tell a user with working
/// developer tools that something went wrong. It is success.
fn read_offer_outcome(code: Option<i32>, stderr: &str, stdout: &str) -> (bool, Option<String>) {
    if code == Some(0) {
        return (true, None);
    }
    let said = format!("{stderr}\n{stdout}").to_lowercase();
    if said.contains("already installed") {
        return (true, None);
    }
    let detail = stderr
        .trim()
        .lines()
        .last()
        .filter(|line| !line.is_empty())
        .unwrap_or("could not start the Command Line Tools install");
    (false, Some(detail.to_string()))
}
/// The size of Apple's Command Line Tools, said out loud wherever they are
/// offered. A prompt that does not say what it costs is an ambush.
pub const COMMAND_LINE_TOOLS_SIZE: &str = "about 3 GB";

/// Why a command that needs git cannot run here, in words a terminal can
/// print, or `None` when this machine's git is fine.
///
/// The CLI has no button, so the refusal has to carry the whole answer: what
/// is wrong, and the one command that fixes it. It names the floor only when
/// the floor is the problem — telling somebody with no git at all that Tug
/// needs 2.23 or newer buries the fact that they have none.
pub fn refusal(tools: &HostTools) -> Option<String> {
    if tools.is_usable() {
        return None;
    }
    let install = format!(
        "Install Apple's Command Line Tools ({COMMAND_LINE_TOOLS_SIZE}):\n    xcode-select --install"
    );
    match &tools.git_version {
        Some(version) => {
            // A git that answered, and is too old. `developer_dir` is set only
            // when the probe had cause to ask, which is the Apple-git case;
            // for anyone else's git, installing Apple's would leave the old one
            // first on PATH and change nothing.
            let fix = if tools.developer_dir.is_some() {
                install
            } else {
                format!(
                    "Update the git at {}.",
                    tools.git_path.as_deref().unwrap_or("an unknown path")
                )
            };
            Some(format!(
                "git {version} is too old — Tug needs git {GIT_VERSION_FLOOR} or newer.\n{fix}"
            ))
        }
        None => Some(format!(
            "git is not installed, and an arc is a git branch plus a worktree.\n{install}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_git_that_is_not_the_shim_never_asks_about_developer_tools() {
        // The assertion that protects the user from Apple's modal: a machine
        // with Homebrew, MacPorts, or Nix git is answered without
        // `xcode-select` ever being consulted.
        for real in [
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/opt/local/bin/git",
            "/run/current-system/sw/bin/git",
        ] {
            assert_eq!(
                route(Some(Path::new(real))),
                Route::RealGit(PathBuf::from(real)),
                "{real} should be probed directly"
            );
        }
    }

    #[test]
    fn the_shim_and_nothing_at_all_both_ask_about_developer_tools() {
        assert_eq!(route(Some(Path::new(SHIM_GIT))), Route::AskDeveloperDir);
        assert_eq!(route(None), Route::AskDeveloperDir);
    }

    #[test]
    fn a_symlinked_git_is_classified_by_what_it_points_at() {
        // The shim is a file, not a spelling. A `git` on `PATH` that is a
        // symlink onto `/usr/bin/git` is Apple's shim under another name, and
        // running it pops the same modal — so `probe` follows links before
        // handing the resolution to `route`.
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real-git");
        std::fs::write(&real, b"#!/bin/sh\n").expect("write");
        let link = dir.path().join("git");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        assert_eq!(
            follow_links(&link),
            std::fs::canonicalize(&real).expect("canonicalize")
        );
        // A name that does not resolve is handed back rather than lost.
        let missing = dir.path().join("nowhere");
        assert_eq!(follow_links(&missing), missing);
    }

    #[test]
    fn already_installed_is_success_however_it_exits() {
        // The normal answer on a configured machine, and never an error.
        assert_eq!(
            read_offer_outcome(
                Some(1),
                "xcode-select: error: command line tools are already installed, use \"Software Update\" to install updates",
                ""
            ),
            (true, None)
        );
        // Some releases say it on stdout instead.
        assert_eq!(
            read_offer_outcome(Some(1), "", "Command line tools are already installed."),
            (true, None)
        );
    }

    #[test]
    fn a_clean_exit_is_success() {
        assert_eq!(read_offer_outcome(Some(0), "", ""), (true, None));
    }

    #[test]
    fn a_real_failure_reports_its_last_line() {
        let (ok, error) = read_offer_outcome(Some(1), "xcode-select: error: no network\n", "");
        assert!(!ok);
        assert_eq!(error.as_deref(), Some("xcode-select: error: no network"));
    }

    #[test]
    fn a_silent_failure_still_says_something() {
        let (ok, error) = read_offer_outcome(None, "", "");
        assert!(!ok);
        assert!(error.is_some_and(|e| !e.is_empty()));
    }

    #[test]
    fn the_floor_admits_every_git_at_or_above_2_23() {
        for version in ["2.23.0", "2.23.0.rc1", "2.39.5", "2.51.0", "3.0.0"] {
            assert!(meets_floor(version), "{version} should meet the floor");
        }
    }

    #[test]
    fn the_floor_refuses_an_older_git() {
        for version in ["2.22.0", "2.19.1", "1.9.5", "2", "", "not a version"] {
            assert!(!meets_floor(version), "{version} should miss the floor");
        }
    }

    #[test]
    fn usability_is_a_version_at_the_floor() {
        assert!(
            HostTools {
                git_version: Some("2.39.5".into()),
                git_path: Some("/usr/bin/git".into()),
                developer_dir: Some("/Library/Developer/CommandLineTools".into()),
            }
            .is_usable()
        );
        assert!(
            !HostTools {
                git_version: Some("2.19.1".into()),
                git_path: Some("/usr/local/bin/git".into()),
                developer_dir: None,
            }
            .is_usable()
        );
        assert!(!HostTools::default().is_usable());
    }
}
