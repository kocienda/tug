//! Replay two arcs' round commits through the crossing probe, then fit the
//! second onto the landed base and count what the cache recalled.
//!
//! ```text
//! cargo run -p tugarc-core --example crossing_replay -- [--with-resolver] \
//!     <repo> <fork> <join-base> <second-arc> <arc>:<round> ...
//! ```
//!
//! Works in a scratch clone of `<repo>`, so the repository's own refs and
//! rerere cache are never touched. Both arcs start at `<fork>`; each
//! `<arc>:<round>` moves that arc's branch to the round, in the order given,
//! and runs the round probe and, on a crossing conflict, the pair ladder. The
//! scribe is stood in for by a keep-both merger (`git merge-file --union`),
//! which is what this repository's two incident arcs' real resolution was.
//! With `--with-resolver`, what the rungs leave is finished the same way in
//! the pair's checkout and taught through it, standing in for the resolver.
//! Then every arc but `<second-arc>` is landed by moving `main` to
//! `<join-base>`, and the second arc is fitted onto it by the replay engine
//! base-motion runs, round by round, with no model anywhere: a conflicted
//! round it clears, the cache cleared.

use std::path::{Path, PathBuf};

use tugarc_core::crossing::{probe_crossings, settle_crossing};
use tugarc_core::resolve::{FileMergeRequest, FileMerger, PairCheckout};
use tugcore::instance::Paths;

/// The keep-both merge: every conflict block becomes ours then theirs.
fn union(base: &[u8], ours: &[u8], theirs: &[u8]) -> Option<Vec<u8>> {
    let dir = tempfile::tempdir().ok()?;
    let write = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).ok().map(|_| path)
    };
    let ours = write("ours", ours)?;
    let base = write("base", base)?;
    let theirs = write("theirs", theirs)?;
    let out = tugcore::git_command()
        .args(["merge-file", "--union", "-p"])
        .args([&ours, &base, &theirs])
        .output()
        .ok()?;
    Some(out.stdout)
}

/// The scribe, stood in for by the keep-both merge.
struct Union;

impl FileMerger for Union {
    fn merge(&self, req: &FileMergeRequest) -> Option<Vec<u8>> {
        union(
            req.base.as_deref().unwrap_or_default(),
            req.ours.as_deref()?,
            req.theirs.as_deref()?,
        )
    }
}

/// A blob's bytes, empty when the path is absent at `rev`.
fn blob(repo: &Path, rev: &str, path: &str) -> Vec<u8> {
    tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "blob", &format!("{rev}:{path}")])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| out.stdout)
        .unwrap_or_default()
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(args)
        .env_remove("GIT_DIFF_OPTS")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// How many conflict blocks a merge of `branch` into `base` leaves, with
/// rerere off and with it on.
fn blocks(repo: &Path, scratch: &Path, base: &str, branch: &str) -> (usize, usize) {
    let count = |rerere: &str| {
        let dir = scratch.join(format!("blocks-{rerere}"));
        git(
            repo,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                &dir.to_string_lossy(),
                base,
            ],
        );
        let _ = tugcore::git_command()
            .arg("-C")
            .arg(&dir)
            .args([
                "-c",
                &format!("rerere.enabled={rerere}"),
                "-c",
                "rerere.autoUpdate=false",
            ])
            .args(["merge", "--no-commit", "--no-ff", branch])
            .output();
        let listed = git(&dir, &["diff", "--name-only", "--diff-filter=U"]);
        let total = listed
            .lines()
            .filter_map(|path| std::fs::read_to_string(dir.join(path)).ok())
            .map(|text| text.lines().filter(|l| l.starts_with("<<<<<<<")).count())
            .sum();
        git(
            repo,
            &["worktree", "remove", "--force", &dir.to_string_lossy()],
        );
        total
    };
    (count("false"), count("true"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let with_resolver = args.first().is_some_and(|a| a == "--with-resolver");
    let args = &args[usize::from(with_resolver)..];
    let [source, fork, join_base, second, rounds @ ..] = args else {
        eprintln!(
            "usage: crossing_replay <repo> <fork> <join-base> <second-arc> <arc>:<round> ..."
        );
        std::process::exit(2);
    };
    let scratch = tempfile::tempdir().expect("scratch dir");
    let state = tempfile::tempdir().expect("state dir");
    let paths = Paths::under(state.path());
    let repo: PathBuf = scratch.path().join("repo");
    git(
        Path::new("."),
        &[
            "clone",
            "-q",
            "--shared",
            "--no-checkout",
            source,
            &repo.to_string_lossy(),
        ],
    );
    git(&repo, &["config", "user.name", "crossing replay"]);
    git(&repo, &["config", "user.email", "replay@example.invalid"]);
    git(&repo, &["update-ref", "refs/heads/main", fork]);

    let mut arcs: Vec<&str> = Vec::new();
    for spec in rounds {
        let (arc, round) = spec.split_once(':').expect("<arc>:<round>");
        if !arcs.contains(&arc) {
            arcs.push(arc);
            git(
                &repo,
                &["update-ref", &format!("refs/heads/tugarc/{arc}"), fork],
            );
            git(
                &repo,
                &["config", &format!("branch.tugarc/{arc}.tugbase"), "main"],
            );
        }
        git(
            &repo,
            &["update-ref", &format!("refs/heads/tugarc/{arc}"), round],
        );
        let found = probe_crossings(&paths, &repo, arc).expect("probe");
        for crossing in found.iter().filter(|c| !c.conflicts.is_empty()) {
            let (pair, settled) =
                settle_crossing(&paths, &repo, arc, &crossing.sibling, Some(&Union))
                    .expect("settle");
            println!(
                "round {arc} {} · conflicts {} · settled {} · left {}",
                &round[..9.min(round.len())],
                crossing.conflicts.join(", "),
                settled
                    .resolved
                    .iter()
                    .map(|(path, by)| format!("{path} by {}", by.as_str()))
                    .collect::<Vec<_>>()
                    .join(", "),
                settled.unresolved.join(", "),
            );
            if with_resolver && !settled.unresolved.is_empty() {
                let checkout =
                    PairCheckout::open(&repo, &pair.first_tip, &pair.second_tip, &settled)
                        .expect("pair checkout");
                let fork = git(&repo, &["merge-base", &pair.first_tip, &pair.second_tip]);
                for path in &settled.unresolved {
                    let merged = union(
                        &blob(&repo, &fork, path),
                        &blob(&repo, &pair.first_tip, path),
                        &blob(&repo, &pair.second_tip, path),
                    )
                    .expect("keep-both merge");
                    std::fs::write(checkout.path().join(path), merged).expect("write");
                }
                println!(
                    "  resolver stand-in: {}",
                    match checkout.teach(&repo, &settled.unresolved) {
                        Ok(()) => "taught".to_string(),
                        Err(why) => why,
                    }
                );
            }
        }
        if found.iter().all(|c| c.conflicts.is_empty()) {
            println!(
                "round {arc} {} · no crossing conflict",
                &round[..9.min(round.len())]
            );
        }
    }

    // Land every other arc: `main` takes the join base, and its branch goes.
    git(&repo, &["update-ref", "refs/heads/main", join_base]);
    for arc in arcs.iter().filter(|arc| *arc != second) {
        git(
            &repo,
            &["update-ref", "-d", &format!("refs/heads/tugarc/{arc}")],
        );
    }
    let worktree = repo.join(".tug").join("worktrees").join(second);
    std::fs::create_dir_all(worktree.parent().expect("a parent")).expect("worktrees dir");
    let at = worktree.to_string_lossy().into_owned();
    git(
        &repo,
        &["worktree", "add", "-q", &at, &format!("tugarc/{second}")],
    );
    let fit = tugarc_core::replay_onto(&paths, &repo, second).expect("the fit");
    git(&repo, &["worktree", "remove", "--force", &at]);
    match &fit {
        tugarc_core::ReplayOutcome::Replayed { mapping, .. } => {
            println!(
                "fit {second} · replayed {} round(s) onto the join base",
                mapping.len()
            );
        }
        tugarc_core::ReplayOutcome::Conflicted {
            round_subject,
            paths: stopped,
            ..
        } => {
            println!("fit {second} · stopped at \"{round_subject}\"");
            for path in stopped {
                println!("  {path} conflicted");
            }
        }
        other => println!("fit {second} · {other:?}"),
    }
    let log = std::fs::read_to_string(tugtool_core::paths::arc_log_path_at(&paths, &repo))
        .unwrap_or_default();
    for line in log.lines().filter(|l| l.contains("recalled")) {
        println!("  {line}");
    }
    let (before, after) = blocks(
        &repo,
        scratch.path(),
        join_base,
        &format!("tugarc/{second}"),
    );
    println!("conflict blocks at the join: {before} without the cache, {after} with it");
}
