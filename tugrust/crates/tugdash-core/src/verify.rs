//! The two marks the join arc leaves on a branch — what the pilot last acted
//! on, and what the user last declined.
//!
//! # Verification does not live here, because it does not live at the join
//!
//! This module used to run the project's declared checks over the joined tree
//! before offering it, in two tiers. That question is still asked — it just
//! moved to where the answer is worth its cost. A dash is *make these changes
//! and fit them back onto main*, so the **run's ending** replays the dash onto
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

use std::path::Path;

use crate::ops::{config_get, git_output};

/// The branch-config key an older build wrote a candidate's verdict to.
///
/// Read by nothing. Named here only so [`clear_verification`] can collect it
/// where the join and the discard already call it.
fn verification_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinverified", name)
}

/// The multi-valued companion an older build kept the verdict's sentences in.
fn verification_detail_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinverifydetail", name)
}

/// The key an older build recorded a "join it anyway" decision under. The
/// decision overrode a verdict, so it died with the verdict.
fn override_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinoverride", name)
}

/// Sweep the retired verdict keys off a branch.
///
/// A dash created before verification left the join carries these keys, and a
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
/// `<base_sha>:<dash_head>`.
///
/// The pilot runs off the changeset recompute, which fires again the moment its
/// own run bumps the aggregate. Without a mark, a ladder pass that produces no
/// candidate and writes no stuck line re-qualifies immediately and runs
/// forever. The mark is written *before* the run so a crash mid-pass does not
/// license a retry loop on restart.
pub fn pilot_mark_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinpilot", name)
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

/// The branch-config key holding the **dash head** the user last declined.
///
/// The head is the whole key, and the base sha is deliberately not part of it.
/// Those are two different questions and only one of them is new work. A base
/// move means *the same dash work, reconciled again* — including it would ask
/// the same question on every push to the base branch, which is nagging. A new
/// round means *work the user has not been asked about* — and that is the case
/// the mark must expire on, because a dismissal is about a state, not about a
/// dash forever. Declining at the end of one milestone must not silence the
/// ask at the end of the next.
///
/// A mark written by an older build holds a decision word rather than a sha,
/// and a word can never equal a 40-character head, so those dismissals expire
/// on upgrade — the prompt returns, which is the direction to fail in.
pub fn prompt_mark_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinprompted", name)
}

/// The dash head the user last declined, if any.
pub fn read_prompt_mark(repo: &Path, name: &str) -> Option<String> {
    config_get(repo, &prompt_mark_key(name))
}

/// Record that the user declined the ask standing over this dash head.
pub fn write_prompt_mark(repo: &Path, name: &str, dash_head: &str) -> Result<(), String> {
    let out = git_output(
        repo,
        &["config", "--replace-all", &prompt_mark_key(name), dash_head],
    )?;
    if !out.status.success() {
        return Err(format!(
            "failed to record the declined prompt for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Drop the dismissal — the user engaged, so the next state this dash reaches
/// is a fresh question.
pub fn clear_prompt_mark(repo: &Path, name: &str) {
    let _ = git_output(repo, &["config", "--unset-all", &prompt_mark_key(name)]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Cmd;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Cmd::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    /// A repo with a dash branch, which is all a branch-config mark needs.
    fn init() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        temp
    }

    /// The pilot's mark round-trips and a rewrite replaces rather than appends.
    #[test]
    fn the_pilot_mark_round_trips_and_replaces() {
        let temp = init();
        let repo = temp.path();
        assert!(read_pilot_mark(repo, "demo").is_none());

        write_pilot_mark(repo, "demo", "base1:head1").unwrap();
        assert_eq!(read_pilot_mark(repo, "demo").as_deref(), Some("base1:head1"));

        write_pilot_mark(repo, "demo", "base2:head1").unwrap();
        assert_eq!(
            read_pilot_mark(repo, "demo").as_deref(),
            Some("base2:head1"),
            "a rewritten mark replaces the old pair"
        );
    }

    /// The dismissal round-trips, suppresses the head it declined, expires on
    /// the next round, and clears on engagement.
    #[test]
    fn the_prompt_mark_declines_one_head() {
        let temp = init();
        let repo = temp.path();
        let head_b = "b".repeat(40);
        let head_c = "c".repeat(40);
        let declined = |mark: Option<String>, head: &str| mark.as_deref() == Some(head);

        assert!(read_prompt_mark(repo, "demo").is_none());

        write_prompt_mark(repo, "demo", &head_b).unwrap();
        assert!(declined(read_prompt_mark(repo, "demo"), &head_b));
        assert!(
            !declined(read_prompt_mark(repo, "demo"), &head_c),
            "a new round is a question nobody has declined"
        );

        write_prompt_mark(repo, "demo", &head_c).unwrap();
        assert!(declined(read_prompt_mark(repo, "demo"), &head_c));

        clear_prompt_mark(repo, "demo");
        assert!(read_prompt_mark(repo, "demo").is_none());
    }

    /// A mark left by an older build holds a decision word, which no head can
    /// equal — so the dismissal expires on upgrade and the prompt returns.
    #[test]
    fn a_legacy_decision_word_mark_never_suppresses() {
        let temp = init();
        let repo = temp.path();
        let head = "d".repeat(40);

        write_prompt_mark(repo, "demo", "clean").unwrap();
        assert_ne!(read_prompt_mark(repo, "demo").as_deref(), Some(head.as_str()));
    }

    /// The two marks live on different keys and cannot shadow one another —
    /// they answer different questions and are keyed deliberately differently.
    #[test]
    fn the_two_marks_are_independent() {
        let temp = init();
        let repo = temp.path();
        assert_ne!(pilot_mark_key("demo"), prompt_mark_key("demo"));

        write_pilot_mark(repo, "demo", "b:h").unwrap();
        write_prompt_mark(repo, "demo", &"e".repeat(40)).unwrap();
        clear_prompt_mark(repo, "demo");

        assert_eq!(
            read_pilot_mark(repo, "demo").as_deref(),
            Some("b:h"),
            "clearing a declined decision does not license a re-run"
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
