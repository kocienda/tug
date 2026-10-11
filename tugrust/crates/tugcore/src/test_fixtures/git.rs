//! The hermetic git fixture — one way for a test to run `git` that the
//! developer's own git config cannot reach.
//!
//! Without it, every test that runs `git` reads `~/.gitconfig`, the XDG config
//! and the system config, so a developer with `init.defaultBranch`,
//! `commit.gpgsign` or a global hook path set runs a different suite from one
//! without. Every command built here sets `GIT_CONFIG_GLOBAL` to the fixture's
//! own `gitconfig` and `GIT_CONFIG_NOSYSTEM=1`, so the only config a fixture
//! command reads is the fixture's and the repository's.
//!
//! The fixture `gitconfig` carries an identity and `init.defaultBranch=main`
//! and nothing else. Its content is constant, so it is a checked-in file
//! beside this module rather than one a test writes: one file serves every
//! repo and every worktree, [`git`] can run hermetically in any directory
//! without knowing which fixture made it, and nothing is minted under the
//! temp dir for the janitor to sweep out from under a running test.
//!
//! [`GitFixture::init`] also writes the identity into the new repository's
//! own config, with `commit.gpgsign` off. That is for the code under test,
//! not for the fixture: production code spawns git through
//! [`crate::git_command`], which reads the user's global config by design,
//! and repository config is the one layer that outranks it. A test whose
//! subject commits must find an identity there on a machine with none, and
//! must not try to sign on a machine that signs everything.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The identity every fixture commit carries.
pub const FIXTURE_USER_NAME: &str = "Test User";
/// The identity's email.
pub const FIXTURE_USER_EMAIL: &str = "test@example.com";

/// What [`GitFixture::init`] appends to the new repository's own config.
const REPO_CONFIG: &str =
    "[user]\n\tname = Test User\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n";

/// The fixture `gitconfig`: `fixture.gitconfig` beside this module.
pub fn fixture_gitconfig() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/test_fixtures/fixture.gitconfig"
    ))
}

/// A `git` command that reads only the fixture's config and the repository's.
///
/// Built on [`crate::git_command`], so it keeps the production door's
/// settings; for a caller that needs the raw `Output`, such as a test that
/// expects git to refuse.
pub fn command() -> Command {
    let mut cmd = crate::git_command();
    cmd.env("GIT_CONFIG_GLOBAL", fixture_gitconfig());
    cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    cmd
}

/// Run `git -C dir <args>` hermetically and return its stdout.
///
/// Panics with git's full stderr when the command fails, so a broken fixture
/// says why rather than leaving the test to fail somewhere later.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = command()
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("spawning git {args:?} in {}: {e}", dir.display()));
    assert!(
        out.status.success(),
        "git {args:?} in {} failed ({}):\n{}",
        dir.display(),
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A repository made by the fixture.
#[derive(Debug, Clone)]
pub struct GitFixture {
    root: PathBuf,
}

impl GitFixture {
    /// `git init` in `dir` (created if missing), on `main`, with the
    /// fixture identity in the repository's own config.
    pub fn init(dir: &Path) -> Self {
        fs::create_dir_all(dir).unwrap_or_else(|e| panic!("creating {}: {e}", dir.display()));
        git(dir, &["init", "-q"]);
        let config = dir.join(".git").join("config");
        let mut text = fs::read_to_string(&config)
            .unwrap_or_else(|e| panic!("reading {}: {e}", config.display()));
        text.push_str(REPO_CONFIG);
        fs::write(&config, text).unwrap_or_else(|e| panic!("writing {}: {e}", config.display()));
        Self {
            root: dir.to_path_buf(),
        }
    }

    /// The repository's working tree.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// [`git`] in the repository's root.
    pub fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A home whose global and XDG config, and a system config, each set
    /// something a fixture command must not see.
    fn leaky_home(temp: &Path) -> (PathBuf, PathBuf) {
        let home = temp.join("home");
        fs::create_dir_all(home.join(".config/git")).unwrap();
        fs::write(
            home.join(".gitconfig"),
            "[user]\n\tname = Leaked Global\n[init]\n\tdefaultBranch = leaked\n[tug]\n\tglobal = leaked\n",
        )
        .unwrap();
        fs::write(home.join(".config/git/config"), "[tug]\n\txdg = leaked\n").unwrap();
        let system = temp.join("system-gitconfig");
        fs::write(&system, "[tug]\n\tsystem = leaked\n").unwrap();
        (home, system)
    }

    fn with_home(mut cmd: Command, home: &Path, system: &Path) -> Command {
        cmd.env("HOME", home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("GIT_CONFIG_SYSTEM", system);
        cmd
    }

    fn get(mut cmd: Command, dir: &Path, key: &str) -> Option<String> {
        let out = cmd
            .arg("-C")
            .arg(dir)
            .args(["config", "--get", key])
            .output()
            .unwrap();
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[test]
    fn a_leaky_home_is_visible_to_a_plain_command() {
        // The control: without the fixture, the leaky home is what git reads,
        // so the hermetic test below is not passing for want of a leak.
        let temp = tempfile::tempdir().unwrap();
        let (home, system) = leaky_home(temp.path());
        let plain = || {
            let mut cmd = crate::git_command();
            cmd.env_remove("GIT_CONFIG_GLOBAL")
                .env_remove("GIT_CONFIG_NOSYSTEM");
            with_home(cmd, &home, &system)
        };
        assert_eq!(
            get(plain(), temp.path(), "tug.global").as_deref(),
            Some("leaked")
        );
        assert_eq!(
            get(plain(), temp.path(), "tug.xdg").as_deref(),
            Some("leaked")
        );
        assert_eq!(
            get(plain(), temp.path(), "tug.system").as_deref(),
            Some("leaked")
        );
    }

    #[test]
    fn no_global_xdg_or_system_setting_reaches_a_fixture_command() {
        let temp = tempfile::tempdir().unwrap();
        let (home, system) = leaky_home(temp.path());
        let hermetic = || with_home(command(), &home, &system);

        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let out = hermetic()
            .arg("-C")
            .arg(&repo)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        assert_eq!(get(hermetic(), &repo, "tug.global"), None);
        assert_eq!(get(hermetic(), &repo, "tug.xdg"), None);
        assert_eq!(get(hermetic(), &repo, "tug.system"), None);
        assert_eq!(
            get(hermetic(), &repo, "user.name").as_deref(),
            Some(FIXTURE_USER_NAME)
        );
        let head = hermetic()
            .arg("-C")
            .arg(&repo)
            .args(["symbolic-ref", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "refs/heads/main"
        );
    }

    #[test]
    fn init_makes_a_repo_on_main_that_commits_as_the_fixture() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = GitFixture::init(&temp.path().join("repo"));
        fs::write(fixture.root().join("f.txt"), "A\n").unwrap();
        fixture.git(&["add", "-A"]);
        fixture.git(&["commit", "-q", "-m", "base"]);

        assert_eq!(fixture.git(&["branch", "--show-current"]).trim(), "main");
        assert_eq!(
            fixture.git(&["log", "-1", "--format=%an <%ae>"]).trim(),
            format!("{FIXTURE_USER_NAME} <{FIXTURE_USER_EMAIL}>")
        );
        // The identity is in the repository's own config too, where the code
        // under test — which reads the user's global config — will find it.
        assert_eq!(
            fixture
                .git(&["config", "--local", "--get", "user.name"])
                .trim(),
            FIXTURE_USER_NAME
        );
        assert_eq!(
            fixture
                .git(&["config", "--local", "--get", "commit.gpgsign"])
                .trim(),
            "false"
        );
    }

    #[test]
    #[should_panic(expected = "not a git repository")]
    fn a_failing_command_panics_with_git_stderr() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["rev-parse", "HEAD"]);
    }
}
