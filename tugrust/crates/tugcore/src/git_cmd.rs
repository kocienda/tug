//! The one place Tug spawns `git` from.
//!
//! A plain `git status` opportunistically refreshes the index and takes
//! `index.lock` to do it. Tug runs a great many of those — feeds, censuses,
//! preflights — beside the few writes that genuinely need the lock, and a
//! join that loses the base's index lock to one of Tug's own reads is Tug
//! competing with itself. `GIT_OPTIONAL_LOCKS=0` turns off exactly that
//! opportunism: it affects only *optional* locks and leaves the mandatory
//! locks of commit, merge and checkout alone, so it is set on every
//! invocation rather than chosen per call site — per-call-site discipline is
//! what left one feed passing `--no-optional-locks` and the rest not.
//!
//! An async caller wraps the same builder:
//! `tokio::process::Command::from(tugcore::git_command())`.

use std::process::Command;

/// The variable git reads, and the value that declines optional locks.
pub const GIT_OPTIONAL_LOCKS: (&str, &str) = ("GIT_OPTIONAL_LOCKS", "0");

/// A `git` command that takes no optional locks.
pub fn git_command() -> Command {
    let mut cmd = Command::new("git");
    cmd.env(GIT_OPTIONAL_LOCKS.0, GIT_OPTIONAL_LOCKS.1);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The spawned git sees the variable — read back through git itself, whose
    /// `!` alias runs a shell in the environment git was given.
    #[test]
    fn the_spawned_git_declines_optional_locks() {
        let out = git_command()
            .args(["-c", "alias.lockenv=!printenv GIT_OPTIONAL_LOCKS", "lockenv"])
            .output()
            .expect("git runs");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0");
    }

    /// No production source spawns `git` any other way. The rule lives at the
    /// constructor because a per-call-site rule is the one that was forgotten.
    /// A build script is exempt: it cannot link this crate, and the one there
    /// is a `rev-parse`, which takes no lock.
    #[test]
    fn no_ad_hoc_git_spawns() {
        let needle = ["new(", "\"git\")"].concat();
        let offenders: Vec<String> = crate::source_scan::production_sources()
            .into_iter()
            .filter(|(path, _)| {
                !path.ends_with("tugcore/src/git_cmd.rs") && !path.ends_with("build.rs")
            })
            .filter(|(_, text)| text.contains(&needle))
            .map(|(path, _)| path.display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "spawn git through tugcore::git_command(): {offenders:?}"
        );
    }
}
