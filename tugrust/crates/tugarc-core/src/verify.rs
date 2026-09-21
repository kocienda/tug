//! The two marks the join leaves on a branch — what the pilot last acted
//! on, and what the user last declined.
//!
//! # Verification does not live here, because it does not live at the join
//!
//! This module used to run the project's declared checks over the joined tree
//! before offering it, in two tiers. That question is still asked — it just
//! moved to where the answer is worth its cost. An arc is *make these changes
//! and fit them back onto main*, so the **run's ending** replays the arc onto
//! the live base and verifies the tree that will actually land, in the warm
//! worktree, with the model present to fix what it finds. Checking the same
//! tree again at join time meant a cold build standing between the user and
//! the dialog, guarding a case the run had already covered.
//!
//! So the join gate is reconcile-clean alone: a candidate stands, the merge had
//! no unresolved conflicts, the prompt raises. What remains here are the two
//! branch-config marks that keep the arc from repeating itself — plus the
//! teardown sweep for the verdict keys older builds wrote, so a live branch
//! carrying one is cleaned rather than left holding a fact nothing reads.
//!
//! The ending's verification itself lives in [`crate::surfaces`], run by
//! `tugtool arc verify` over the surfaces a project declares.

use std::path::Path;

use crate::ops::{config_get, git_output};

/// The branch-config key an older build wrote a candidate's verdict to.
///
/// Read by nothing. Named here only so [`clear_verification`] can collect it
/// where the join and the discard already call it.
fn verification_config_key(name: &str) -> String {
    format!("branch.tugarc/{}.tugjoinverified", name)
}

/// The multi-valued companion an older build kept the verdict's sentences in.
fn verification_detail_key(name: &str) -> String {
    format!("branch.tugarc/{}.tugjoinverifydetail", name)
}

/// The key an older build recorded a "join it anyway" decision under. The
/// decision overrode a verdict, so it died with the verdict.
fn override_config_key(name: &str) -> String {
    format!("branch.tugarc/{}.tugjoinoverride", name)
}

/// Sweep the retired verdict keys off a branch.
///
/// An arc created before verification left the join carries these keys, and a
/// key nothing reads is a lie waiting to be believed. The demotion and
/// teardown paths that always called this keep calling it, so the residue is
/// collected on the way past rather than needing a migration of its own.
pub fn clear_verification(repo: &Path, name: &str) {
    for key in [
        verification_config_key(name),
        verification_detail_key(name),
        override_config_key(name),
    ] {
        let _ = git_output(repo, &["config", "--unset-all", &key]);
    }
}

/// The branch-config key holding the pilot's last attempt, as
/// `<base_sha>:<arc_head>`.
///
/// The pilot runs off the changeset recompute, which fires again the moment its
/// own run bumps the aggregate. Without a mark, a ladder pass that produces no
/// candidate and writes no stuck line re-qualifies immediately and runs
/// forever. The mark is written *before* the run so a crash mid-pass does not
/// license a retry loop on restart.
pub fn pilot_mark_key(name: &str) -> String {
    format!("branch.tugarc/{}.tugjoinpilot", name)
}

/// The head pair the pilot last acted on, if it ever acted.
pub fn read_pilot_mark(repo: &Path, name: &str) -> Option<String> {
    config_get(repo, &pilot_mark_key(name))
}

/// Record the head pair the pilot is about to act on.
pub fn write_pilot_mark(repo: &Path, name: &str, head_pair: &str) -> Result<(), String> {
    let out = git_output(
        repo,
        &["config", "--replace-all", &pilot_mark_key(name), head_pair],
    )?;
    if !out.status.success() {
        return Err(format!(
            "failed to record the pilot attempt for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let ok = tugcore::git_command()
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// A repo with an arc branch, which is all a branch-config mark needs.
    fn init() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugarc/demo"]);
        temp
    }

    /// The pilot's mark round-trips and a rewrite replaces rather than appends.
    #[test]
    fn the_pilot_mark_round_trips_and_replaces() {
        let temp = init();
        let repo = temp.path();
        assert!(read_pilot_mark(repo, "demo").is_none());

        write_pilot_mark(repo, "demo", "base1:head1").unwrap();
        assert_eq!(
            read_pilot_mark(repo, "demo").as_deref(),
            Some("base1:head1")
        );

        write_pilot_mark(repo, "demo", "base2:head1").unwrap();
        assert_eq!(
            read_pilot_mark(repo, "demo").as_deref(),
            Some("base2:head1"),
            "a rewritten mark replaces the old pair"
        );
    }

    /// The retired verdict keys are swept where the teardown already ran.
    #[test]
    fn the_teardown_sweeps_a_legacy_verdict() {
        let temp = init();
        let repo = temp.path();
        let key = verification_config_key("demo");
        git(repo, &["config", "--replace-all", &key, "a:b:green:unrun"]);
        assert!(config_get(repo, &key).is_some());

        clear_verification(repo, "demo");
        assert!(
            config_get(repo, &key).is_none(),
            "a fact nothing reads is collected on the way past"
        );
    }
}
