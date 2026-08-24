//! Base-motion replay — moving a dash's rounds onto a base that has advanced.
//!
//! The merge engine is the same one the join's resolution ladder uses for its
//! first rung: replay each round in memory with
//! `merge-tree --write-tree --merge-base=<round^>` + `commit-tree`. What lives
//! here is the *lifecycle* around it — the preconditions that say when acting is
//! safe, the compare-and-swap that moves a branch checked out in a live
//! worktree, and the bookkeeping that records where the rounds went.
//!
//! Nothing here resolves file content. A round that conflicts against the moved
//! base is reported, never merged: that is a question for whoever is working the
//! dash, and the landing-time ladder remains the fallback.

use std::path::Path;

use serde::Serialize;

use crate::dash::append_dash_log;
use crate::ops::{
    branch_exists, branch_name, dash_base, dash_plan_path, git_output, git_stdout, join_in_flight,
    main_repo_root, worktree_path, write_atomic,
};
use crate::resolve::{commit_tree, git_supports_merge_base_flag};

/// A clean replay: the head every round was rebuilt onto, and which commit each
/// original round became.
pub struct ReplayedRounds {
    /// The replayed head — the last round's rebuilt commit.
    pub head: String,
    /// `(original round, rebuilt commit)`, oldest first, one pair per round.
    pub mapping: Vec<(String, String)>,
}

/// What replaying the rounds one at a time found, before anything is moved.
pub(crate) enum ReplayWalk {
    /// Every round rebuilt cleanly.
    Clean(ReplayedRounds),
    /// A round conflicts against the running base; the walk stopped there.
    Conflicted {
        round: String,
        round_subject: String,
        paths: Vec<String>,
    },
    /// No replay is possible: git is too old, or the branch has no rounds.
    Unavailable,
}

/// What `replay_onto` did — or declined to do, having touched nothing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ReplayOutcome {
    /// The branch moved. `mapping` pairs each old round with its replayed
    /// commit, oldest first.
    Replayed {
        base_head: String,
        mapping: Vec<(String, String)>,
        /// The remap round, when a plan ledger had cells to rewrite.
        bookkeeping_commit: Option<String>,
    },
    /// The branch already descends from the base tip and the record needed
    /// repair — after a rebase made by hand or by an agent.
    Recorded {
        base_head: String,
        remapped: Vec<String>,
        unmapped: Vec<String>,
    },
    /// A round conflicts against the moved base. Nothing was touched.
    Conflicted {
        base_head: String,
        round: String,
        round_subject: String,
        paths: Vec<String>,
    },
    /// The base has not moved past the dash's merge-base. Nothing to do.
    Current,
    /// A precondition failed; nothing was touched.
    Deferred { reason: String, detail: String },
}

impl ReplayOutcome {
    fn deferred(reason: &str, detail: impl Into<String>) -> Self {
        ReplayOutcome::Deferred {
            reason: reason.to_string(),
            detail: detail.into(),
        }
    }
}

/// A replay's op-log record, open from the moment before the first write.
///
/// Replay has two mutating arms and four that touch nothing, so the record is
/// opened per arm rather than at the verb's entry — and it is opened *before*
/// the write, so a crash between the write and the record cannot lose the
/// rounds. An arm that turns out to refuse abandons the record, which removes
/// it: a replay that declined did not happen, and the log must not claim it
/// did.
struct OpenOp {
    seq: u64,
}

impl OpenOp {
    fn begin(repo: &Path, name: &str) -> Result<Self, String> {
        let before = crate::oplog::capture_before(repo, name)?;
        let tips = crate::oplog::tips_of(&before);
        let seq = crate::oplog::record_begin(repo, crate::oplog::OpVerb::Replay, name, before, &tips)?;
        Ok(OpenOp { seq })
    }

    /// The branch moved: read the tip back rather than trusting what was
    /// computed. `reconcile_ledger_cells` can land a remap round *after* the
    /// swap, so the tip a replay leaves is one commit past the mapping's tail
    /// whenever the ledger had cells to rewrite.
    fn complete(&self, repo: &Path, branch: &str, mapping: Vec<(String, String)>) {
        let after = crate::oplog::OpAfter {
            dash_tip: git_stdout(repo, &["rev-parse", branch]).ok(),
            mapping,
            ..Default::default()
        };
        let _ = crate::oplog::record_complete(repo, self.seq, after);
    }

    fn abandon(&self, repo: &Path) {
        crate::oplog::abandon(repo, self.seq);
    }
}

/// Like [`replay_onto`], but discovering the repo root from the process cwd —
/// the `tugutil dash replay` entry point. `main_repo_root` normalization inside
/// means it answers the same from the base checkout and from inside any dash
/// worktree, the way `join` does.
pub fn replay(name: &str) -> Result<ReplayOutcome, String> {
    let repo = tugutil_core::find_repo_root().map_err(|e| e.to_string())?;
    replay_onto(&repo, name)
}

/// Replay dash `name`'s rounds onto its base branch's current tip.
///
/// Every refusal path leaves the repository exactly as it found it. The move
/// itself is a compare-and-swap: the worktree must still be clean and its HEAD
/// must still be the tip the replay was computed from, or nothing happens and
/// the outcome says why. `git reset --keep` from inside the worktree is what
/// moves the branch — `branch -f` is refused by git on a checked-out branch, and
/// a bare `update-ref` would leave HEAD, the index, and the working tree
/// disagreeing.
pub fn replay_onto(repo_root: &Path, name: &str) -> Result<ReplayOutcome, String> {
    let repo = main_repo_root(repo_root);
    let repo = repo.as_path();
    let branch = branch_name(name);
    if !branch_exists(repo, &branch) {
        return Err(format!("Dash not found: {}", name));
    }
    if !git_supports_merge_base_flag(repo) {
        return Ok(ReplayOutcome::deferred(
            "git-too-old",
            "replay needs git 2.40 or newer for `merge-tree --merge-base`",
        ));
    }
    if join_in_flight(repo, name) {
        return Ok(ReplayOutcome::deferred(
            "join-journal",
            format!("a join of dash '{}' is in flight", name),
        ));
    }

    let worktree = worktree_path(repo, name);
    if !worktree.exists() {
        return Ok(ReplayOutcome::deferred(
            "no-worktree",
            format!("dash '{}' has no worktree to move under", name),
        ));
    }
    let dirt = git_stdout(&worktree, &["status", "--porcelain"])?;
    if !dirt.trim().is_empty() {
        return Ok(ReplayOutcome::deferred(
            "dirty-worktree",
            format!("dash '{}' has uncommitted changes", name),
        ));
    }

    let base_branch = dash_base(repo, name)?;
    let base_head = git_stdout(repo, &["rev-parse", &base_branch])?;

    // The branch already contains the base tip: nothing to move. Whether that
    // is `Current` or a `Recorded` repair is a bookkeeping question — a rebase
    // made by hand leaves the record pointing at commits that are no longer
    // there, and this is where that gets repaired.
    if is_ancestor(repo, &base_head, &branch) {
        // The bookkeeping arm still commits — `reconcile_ledger_cells` lands a
        // remap round when the plan ledger had cells to rewrite — so it records
        // like any other mutation. It is a separate site because this arm
        // returns before the branch move below ever runs; a record placed only
        // there would miss every repair of a hand-rebased dash.
        let op = OpenOp::begin(repo, name)?;
        let reconciled =
            reconcile_ledger_cells(repo, name, &worktree, &branch, &base_branch, None)?;
        if !reconciled.touched_anything() {
            // Nothing moved, so nothing is recorded: `Current` is the outcome
            // that leaves the repository exactly as it found it, and an op
            // record for a no-op is a row the undo list would have to explain.
            op.abandon(repo);
            return Ok(ReplayOutcome::Current);
        }
        log_replay(repo, name, &recorded_note(repo, &base_head, &reconciled))?;
        op.complete(repo, &branch, Vec::new());
        return Ok(ReplayOutcome::Recorded {
            base_head,
            remapped: reconciled.remapped,
            unmapped: reconciled.unmapped,
        });
    }

    let tip_at_probe = git_stdout(repo, &["rev-parse", &branch])?;
    match walk_rounds(repo, &base_head, &base_branch, &branch)? {
        ReplayWalk::Unavailable => Ok(ReplayOutcome::deferred(
            "no-rounds",
            format!("dash '{}' has no rounds to replay", name),
        )),
        ReplayWalk::Conflicted {
            round,
            round_subject,
            paths,
        } => Ok(ReplayOutcome::Conflicted {
            base_head,
            round,
            round_subject,
            paths,
        }),
        ReplayWalk::Clean(replayed) => {
            // Before the compare-and-swap, because that is the moment the
            // pre-replay rounds stop being reachable from any branch.
            let op = OpenOp::begin(repo, name)?;
            if let Some(refusal) = cas_reset(&worktree, &tip_at_probe, &replayed.head)? {
                op.abandon(repo);
                return Ok(refusal);
            }
            log_replay(
                repo,
                name,
                &replayed_note(repo, &base_head, &replayed.mapping),
            )?;
            let reconciled = reconcile_ledger_cells(
                repo,
                name,
                &worktree,
                &branch,
                &base_branch,
                Some(&replayed.mapping),
            )?;
            op.complete(repo, &branch, replayed.mapping.clone());
            Ok(ReplayOutcome::Replayed {
                base_head,
                mapping: replayed.mapping,
                bookkeeping_commit: reconciled.commit,
            })
        }
    }
}

/// Move the dash worktree — and with it the branch checked out there — to
/// `head`, but only if the worktree is still clean and still sits on
/// `expected_tip`. Returns the refusal outcome when it declined, having touched
/// nothing; `None` when the move happened.
///
/// This is the compare-and-swap. Without it, a round committed between the
/// replay and the move would be silently dropped: the replayed head knows
/// nothing about it, and `reset --keep` would happily discard it.
pub(crate) fn cas_reset(
    worktree: &Path,
    expected_tip: &str,
    head: &str,
) -> Result<Option<ReplayOutcome>, String> {
    let dirt = git_stdout(worktree, &["status", "--porcelain"])?;
    if !dirt.trim().is_empty() {
        return Ok(Some(ReplayOutcome::deferred(
            "dirty-worktree",
            "the dash worktree became dirty while the replay ran",
        )));
    }
    let tip_now = git_stdout(worktree, &["rev-parse", "HEAD"])?;
    if tip_now != expected_tip {
        return Ok(Some(ReplayOutcome::deferred(
            "tip-moved",
            "a round landed on the dash while the replay ran",
        )));
    }
    let reset = git_output(worktree, &["reset", "--keep", head])?;
    if !reset.status.success() {
        return Ok(Some(ReplayOutcome::deferred(
            "tip-moved",
            format!(
                "git refused to move the dash worktree: {}",
                String::from_utf8_lossy(&reset.stderr).trim()
            ),
        )));
    }
    Ok(None)
}

/// Replay each round of `branch` onto `base_head`, in memory, stopping at the
/// first round that conflicts. Touches nothing in the repository beyond writing
/// loose objects.
pub(crate) fn walk_rounds(
    repo: &Path,
    base_head: &str,
    base_branch: &str,
    branch: &str,
) -> Result<ReplayWalk, String> {
    if !git_supports_merge_base_flag(repo) {
        return Ok(ReplayWalk::Unavailable);
    }
    let rounds_out = git_stdout(
        repo,
        &[
            "rev-list",
            "--reverse",
            &format!("{}..{}", base_branch, branch),
        ],
    )?;
    let rounds: Vec<&str> = rounds_out
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if rounds.is_empty() {
        return Ok(ReplayWalk::Unavailable);
    }

    let mut acc = base_head.to_string();
    let mut mapping: Vec<(String, String)> = Vec::new();
    for round in rounds {
        let parent = format!("{}^", round);
        let out = git_output(
            repo,
            &[
                "merge-tree",
                "--write-tree",
                "-z",
                &format!("--merge-base={}", parent),
                &acc,
                round,
            ],
        )?;
        if !out.status.success() {
            return Ok(ReplayWalk::Conflicted {
                round: round.to_string(),
                round_subject: git_stdout(repo, &["log", "-1", "--format=%s", round])
                    .unwrap_or_default(),
                paths: conflicted_paths(&out.stdout),
            });
        }
        let tree = String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        let msg = git_stdout(repo, &["log", "-1", "--format=%B", round])?;
        acc = commit_tree(repo, &tree, &acc, &msg)?;
        mapping.push((round.to_string(), acc.clone()));
    }
    Ok(ReplayWalk::Clean(ReplayedRounds { head: acc, mapping }))
}

/// The conflicted paths named by `merge-tree --write-tree -z`: the first NUL
/// field is the tree OID, then `<mode> <oid> <stage>\t<path>` entries until an
/// empty field ends the section.
fn conflicted_paths(stdout: &[u8]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for field in stdout.split(|&b| b == 0).skip(1) {
        if field.is_empty() {
            break;
        }
        let s = String::from_utf8_lossy(field);
        if let Some((_, path)) = s.split_once('\t') {
            let path = path.to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

// ---------------------------------------------------------------------------
// Bookkeeping — where the rounds went
// ---------------------------------------------------------------------------

/// What the plan ledger's commit cells needed, and what came of it.
#[derive(Default)]
pub(crate) struct Reconciled {
    /// Anchors whose commit cell now names a commit on the branch.
    pub remapped: Vec<String>,
    /// Anchors whose recorded commit is off the branch and could not be matched
    /// to exactly one round — left exactly as they were.
    pub unmapped: Vec<String>,
    /// The round that committed the rewritten plan, when anything changed.
    pub commit: Option<String>,
}

impl Reconciled {
    fn touched_anything(&self) -> bool {
        !self.remapped.is_empty() || !self.unmapped.is_empty()
    }
}

/// Repair the plan ledger's commit cells after the dash's history moved.
///
/// With `mapping` — the engine's own replay — every cell is matched by prefix
/// against the round it recorded, so the answer is exact. Without one — a rebase
/// made by hand or by an agent — a cell is repaired only when the commit it
/// names has exactly one same-subject round on the branch; anything ambiguous is
/// reported unmapped and left alone, because a wrong sha in the record is worse
/// than a stale one (the old object still exists until gc).
pub(crate) fn reconcile_ledger_cells(
    repo: &Path,
    name: &str,
    worktree: &Path,
    branch: &str,
    base_branch: &str,
    mapping: Option<&[(String, String)]>,
) -> Result<Reconciled, String> {
    let mut out = Reconciled::default();
    let Some(rel) = dash_plan_path(repo, name) else {
        return Ok(out);
    };
    let plan_file = worktree.join(&rel);
    let Ok(source) = std::fs::read_to_string(&plan_file) else {
        return Ok(out);
    };
    let Ok(doc) = tugutil_core::plan::parse(&source) else {
        return Ok(out);
    };

    let rounds = branch_rounds(repo, base_branch, branch)?;
    let mut edited = source.clone();
    for row in &doc.ledger_rows {
        let Some(cell) = row.commit.clone() else {
            continue;
        };
        if cell.trim().is_empty() || is_ancestor(repo, &cell, branch) {
            continue; // still on the branch — nothing to repair
        }
        let replacement = match mapping {
            Some(pairs) => pairs
                .iter()
                .find(|(old, _)| old.starts_with(&cell))
                .map(|(_, new)| new.clone()),
            None => unique_subject_match(repo, &cell, &rounds),
        };
        match replacement {
            Some(new) => {
                let short = abbreviate(repo, &new, cell.len());
                match tugutil_core::plan::rewrite_ledger_commit_cell(&edited, &row.anchor, &short) {
                    Ok(next) => {
                        edited = next;
                        out.remapped.push(row.anchor.clone());
                    }
                    Err(_) => out.unmapped.push(row.anchor.clone()),
                }
            }
            None => out.unmapped.push(row.anchor.clone()),
        }
    }

    if !out.remapped.is_empty() {
        write_atomic(&plan_file, &edited)?;
        out.commit = Some(commit_remap(worktree, name)?);
    }
    Ok(out)
}

/// `(commit, subject)` for every round of `branch` above `base_branch`.
fn branch_rounds(
    repo: &Path,
    base_branch: &str,
    branch: &str,
) -> Result<Vec<(String, String)>, String> {
    let out = git_stdout(
        repo,
        &[
            "log",
            "--format=%H%x1f%s",
            &format!("{}..{}", base_branch, branch),
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('\x1f'))
        .map(|(h, s)| (h.to_string(), s.to_string()))
        .collect())
}

/// The one round carrying the same subject as `old`, when there is exactly one.
fn unique_subject_match(repo: &Path, old: &str, rounds: &[(String, String)]) -> Option<String> {
    let subject = git_stdout(repo, &["log", "-1", "--format=%s", old]).ok()?;
    let subject = subject.trim();
    if subject.is_empty() {
        return None;
    }
    let mut hits = rounds.iter().filter(|(_, s)| s == subject);
    let first = hits.next()?;
    if hits.next().is_some() {
        return None; // duplicated subject — refuse to guess
    }
    Some(first.0.clone())
}

/// `commit` abbreviated to the width the ledger cell already wore.
fn abbreviate(repo: &Path, commit: &str, width: usize) -> String {
    let width = width.clamp(7, 40);
    git_stdout(repo, &["rev-parse", &format!("--short={width}"), commit])
        .unwrap_or_else(|_| commit.chars().take(width).collect())
}

/// Commit the rewritten plan as an ordinary round.
///
/// `commit_worktree_dirt` cannot stand in for this: it writes the join arc's
/// preflight sweep, which carries a `Tug-Sweep` trailer and is therefore
/// excluded from the dash's rounds. A remap IS a round. A clean worktree here
/// means the rewrite changed no bytes, which is not an error — there is simply
/// no round to make.
fn commit_remap(worktree: &Path, name: &str) -> Result<String, String> {
    let dirt = git_stdout(worktree, &["status", "--porcelain"])?;
    if dirt.trim().is_empty() {
        return git_stdout(worktree, &["rev-parse", "HEAD"]);
    }
    let add = git_output(worktree, &["add", "-A"])?;
    if !add.status.success() {
        return Err(format!(
            "replay: git add in the dash worktree failed: {}",
            String::from_utf8_lossy(&add.stderr).trim()
        ));
    }
    let msg = format!("tugdash({}): remap round ids after base replay", name);
    let c = git_output(worktree, &["commit", "-m", &msg])?;
    if !c.status.success() {
        return Err(format!(
            "replay: the remap commit failed: {}",
            String::from_utf8_lossy(&c.stderr).trim()
        ));
    }
    git_stdout(worktree, &["rev-parse", "HEAD"])
}

/// The dash-log's record of a replay (Spec S02) — the one thing git cannot say
/// for itself, since the rounds it names no longer exist under that branch.
fn log_replay(repo: &Path, name: &str, note: &str) -> Result<(), String> {
    append_dash_log(repo, name, "replayed", note).map_err(|e| e.to_string())
}

/// `onto <base>: <old>-><new>[, …]` — an engine replay's note.
fn replayed_note(repo: &Path, base_head: &str, mapping: &[(String, String)]) -> String {
    let pairs: Vec<String> = mapping
        .iter()
        .map(|(old, new)| format!("{}->{}", abbreviate(repo, old, 9), abbreviate(repo, new, 9)))
        .collect();
    format!(
        "onto {}: {}",
        abbreviate(repo, base_head, 9),
        pairs.join(", ")
    )
}

/// `onto <base>: by rebase[, remapped …][, unmapped …]` — a reconciliation's.
fn recorded_note(repo: &Path, base_head: &str, r: &Reconciled) -> String {
    let mut note = format!("onto {}: by rebase", abbreviate(repo, base_head, 9));
    if !r.remapped.is_empty() {
        note.push_str(&format!(", remapped {}", r.remapped.join(" ")));
    }
    if !r.unmapped.is_empty() {
        note.push_str(&format!(", unmapped {}", r.unmapped.join(" ")));
    }
    note
}

/// Whether `maybe_ancestor` is contained in `descendant`.
fn is_ancestor(repo: &Path, maybe_ancestor: &str, descendant: &str) -> bool {
    git_output(
        repo,
        &["merge-base", "--is-ancestor", maybe_ancestor, descendant],
    )
    .map(|o| o.status.success())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dash::read_declarations;
    use serial_test::serial;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn set(dir: &Path, rel: &str, content: &str) {
        if let Some(parent) = dir.join(rel).parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(dir.join(rel), content).unwrap();
    }

    /// A repo on `main` with base commit `A`, a `tugdash/demo` dash carrying
    /// `rounds`, and a **real linked worktree** at `.tug/worktrees/demo` — the
    /// branch must be checked out somewhere for the move to be the move this
    /// module actually performs.
    ///
    /// `home` redirects `project_state_dir`, so the dash-log a replay writes
    /// lands in the fixture rather than in the developer's real state dir. Every
    /// test here is `#[serial]` for that reason.
    struct Fixture {
        repo: tempfile::TempDir,
        _home: tempfile::TempDir,
    }

    impl Fixture {
        fn path(&self) -> &Path {
            self.repo.path()
        }
        fn worktree(&self) -> std::path::PathBuf {
            worktree_path(self.path(), "demo")
        }
        fn tip(&self, rev: &str) -> String {
            git_stdout(self.path(), &["rev-parse", rev]).unwrap()
        }
        /// Advance `main` by committing `content` to `rel` in the base checkout.
        fn advance_base(&self, rel: &str, content: &str, msg: &str) {
            set(self.path(), rel, content);
            git(self.path(), &["add", rel]);
            git(self.path(), &["commit", "-m", msg]);
        }
        /// Commit a round on the dash worktree, returning its sha.
        fn round(&self, rel: &str, content: &str, msg: &str) -> String {
            let wt = self.worktree();
            set(&wt, rel, content);
            git(&wt, &["add", "-A"]);
            git(&wt, &["commit", "-m", msg]);
            git_stdout(&wt, &["rev-parse", "HEAD"]).unwrap()
        }
        /// The dash-log as the library resolves it — through the same root
        /// normalization `replay_onto` applies, so the test cannot read a
        /// different slug than the code wrote.
        fn dash_log(&self) -> String {
            let root = main_repo_root(self.path());
            let path = tugutil_core::project_state_dir(&root).join("dash-log.md");
            std::fs::read_to_string(path).unwrap_or_default()
        }
    }

    fn init(rounds: &[(&str, &str, &str)]) -> Fixture {
        let home = tempfile::tempdir().unwrap();
        // SAFETY: every test in this module is #[serial]; no other thread reads
        // the environment while this runs.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        set(repo, "f.txt", "A\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        git(repo, &["config", "branch.tugdash/demo.tugbase", "main"]);
        let wt = worktree_path(repo, "demo");
        git(
            repo,
            &["worktree", "add", wt.to_str().unwrap(), "tugdash/demo"],
        );
        let fixture = Fixture {
            repo: temp,
            _home: home,
        };
        for (rel, content, msg) in rounds {
            fixture.round(rel, content, msg);
        }
        fixture
    }

    /// A plan whose ledger rows point at `cells`, committed as a round, with the
    /// dash configured to be driving it.
    fn plan_with_cells(f: &Fixture, cells: &[(&str, &str, &str)]) -> String {
        let mut doc = String::from(
            "## Fixture Plan {#fixture-plan}\n\n### Execution Steps {#execution-steps}\n\n#### Step Status Ledger {#step-status-ledger}\n\n| Step | Title | Status | Commit |\n|---|---|---|---|\n",
        );
        for (anchor, title, sha) in cells {
            doc.push_str(&format!("| #{anchor} | {title} | done | `{sha}` |\n"));
        }
        set(&f.worktree(), "roadmap/p.md", &doc);
        let wt = f.worktree();
        git(&wt, &["add", "-A"]);
        git(&wt, &["commit", "-m", "record the plan"]);
        git(
            f.path(),
            &["config", "branch.tugdash/demo.tugplan", "roadmap/p.md"],
        );
        "roadmap/p.md".to_string()
    }

    /// Every commit cell in the worktree's plan, in ledger order.
    fn cells(f: &Fixture) -> Vec<String> {
        let source = std::fs::read_to_string(f.worktree().join("roadmap/p.md")).unwrap();
        tugutil_core::plan::parse(&source)
            .unwrap()
            .ledger_rows
            .iter()
            .filter_map(|r| r.commit.clone())
            .collect()
    }

    #[test]
    #[serial]
    fn a_replay_records_the_tip_it_actually_left_not_the_mapping_tail() {
        // The ledger's cell points at the round, so reconciliation rewrites it
        // and lands a remap round *after* the branch move. That commit is the
        // tip a later undo must compare against; the mapping's tail is one
        // commit short of it, and an undo built on the tail would refuse every
        // remapped replay as `tip-moved`.
        let f = init(&[("g.txt", "dash\n", "add g")]);
        let round = f.tip("tugdash/demo");
        plan_with_cells(&f, &[("step-1", "One", &round[..9])]);
        // `plan_with_cells` commits the plan as a further round, so the
        // pre-replay tip is that commit rather than the round above it.
        let pre_replay = f.tip("tugdash/demo");
        f.advance_base("f.txt", "B\n", "base moves");

        let outcome = replay_onto(f.path(), "demo").unwrap();
        let ReplayOutcome::Replayed {
            mapping,
            bookkeeping_commit,
            ..
        } = &outcome
        else {
            panic!("expected a replay, got {outcome:?}");
        };
        let bookkeeping = bookkeeping_commit
            .clone()
            .expect("the ledger cell was rewritten, so a remap round landed");

        let op = crate::oplog::list_ops(f.path())
            .into_iter()
            .find(|o| o.verb == crate::oplog::OpVerb::Replay)
            .expect("the replay recorded an operation");
        let after = op.after.expect("a completed replay has an after");
        let recorded_tip = after.dash_tip.expect("the tip is recorded");

        assert_eq!(
            recorded_tip,
            f.tip("tugdash/demo"),
            "the record names the branch tip as it actually stands"
        );
        assert_eq!(recorded_tip, bookkeeping, "which is the remap round");
        assert_ne!(
            recorded_tip,
            mapping.last().unwrap().1,
            "and is one commit past the mapping's tail — the case this guards"
        );
        assert_eq!(
            op.before.dash_tip, pre_replay,
            "the before-tip is the branch as it stood before the replay"
        );
    }

    #[test]
    #[serial]
    fn undo_of_a_remapped_replay_puts_the_branch_back() {
        // The end-to-end version of the tip question: with a ledger cell to
        // rewrite, the replay leaves a bookkeeping round on top, and the undo's
        // compare-and-swap has to expect *that* commit. Built on the mapping's
        // tail it would refuse here with `tip-moved`.
        let f = init(&[("g.txt", "dash\n", "add g")]);
        let round = f.tip("tugdash/demo");
        plan_with_cells(&f, &[("step-1", "One", &round[..9])]);
        let pre_replay = f.tip("tugdash/demo");
        f.advance_base("f.txt", "B\n", "base moves");
        replay_onto(f.path(), "demo").unwrap();
        assert_ne!(f.tip("tugdash/demo"), pre_replay);

        let out = crate::oplog::undo_in(f.path(), Some("demo")).unwrap();

        assert_eq!(out.verb, crate::oplog::OpVerb::Replay);
        assert_eq!(
            f.tip("tugdash/demo"),
            pre_replay,
            "the branch is back where the replay found it"
        );
        assert_eq!(
            git_stdout(&f.worktree(), &["rev-parse", "HEAD"]).unwrap(),
            pre_replay,
            "and the worktree came with it, rather than being left behind"
        );
        // The ledger cell is back to naming the original round, because the
        // remap round is no longer reachable from the branch.
        assert_eq!(cells(&f), vec![round[..9].to_string()]);
    }

    #[test]
    #[serial]
    fn undo_of_a_replay_refuses_when_a_round_landed_since() {
        let f = init(&[("g.txt", "dash\n", "add g")]);
        f.advance_base("f.txt", "B\n", "base moves");
        replay_onto(f.path(), "demo").unwrap();
        // A round committed after the replay would be silently dropped by a
        // reset that did not check.
        let later = f.round("h.txt", "typed later\n", "later round");

        let err = crate::oplog::undo_in(f.path(), Some("demo")).unwrap_err();
        assert!(err.starts_with("tip-moved:"), "{err}");
        assert_eq!(f.tip("tugdash/demo"), later, "the later round is untouched");
    }

    #[test]
    #[serial]
    fn a_replay_with_nothing_to_do_records_no_operation() {
        // `Current` leaves the repository exactly as it found it, so there is
        // nothing to undo and the log must not grow a row that says otherwise.
        let f = init(&[("g.txt", "dash\n", "add g")]);
        let outcome = replay_onto(f.path(), "demo").unwrap();
        assert!(
            matches!(outcome, ReplayOutcome::Current),
            "the base has not moved, got {outcome:?}"
        );
        assert!(
            crate::oplog::list_ops(f.path()).is_empty(),
            "a no-op replay records nothing"
        );
    }

    #[test]
    #[serial]
    fn clean_replay_moves_the_branch_under_its_live_worktree() {
        // The dash edits g.txt; the base separately edits f.txt — disjoint, so
        // every round replays clean.
        let f = init(&[("g.txt", "dash\n", "add g")]);
        f.advance_base("f.txt", "B\n", "base moves");
        let wt = f.worktree();
        let before = f.tip("tugdash/demo");

        let outcome = replay_onto(f.path(), "demo").unwrap();
        let ReplayOutcome::Replayed { mapping, .. } = &outcome else {
            panic!("expected a replay, got {outcome:?}");
        };
        assert_eq!(mapping.len(), 1, "one pair per round");
        assert_eq!(mapping[0].0, before, "the pair names the original round");

        // The branch, the worktree HEAD, and the working tree all moved together.
        assert_eq!(f.tip("tugdash/demo"), mapping[0].1);
        assert_eq!(
            git_stdout(&wt, &["rev-parse", "HEAD"]).unwrap(),
            mapping[0].1
        );
        assert_eq!(
            git_stdout(&wt, &["status", "--porcelain"]).unwrap(),
            "",
            "the worktree is clean after the move"
        );
        // The base's own commit is now under the dash's round, and the dash's
        // work survived.
        assert!(is_ancestor(f.path(), &f.tip("main"), "tugdash/demo"));
        assert_eq!(std::fs::read_to_string(wt.join("f.txt")).unwrap(), "B\n");
        assert_eq!(std::fs::read_to_string(wt.join("g.txt")).unwrap(), "dash\n");
    }

    #[test]
    #[serial]
    fn a_dirty_worktree_defers_and_touches_nothing() {
        let f = init(&[("g.txt", "dash\n", "add g")]);
        f.advance_base("f.txt", "B\n", "base moves");
        let wt = f.worktree();
        set(&wt, "g.txt", "half-written\n");
        let before = f.tip("tugdash/demo");

        let outcome = replay_onto(f.path(), "demo").unwrap();
        assert_eq!(
            outcome,
            ReplayOutcome::Deferred {
                reason: "dirty-worktree".into(),
                detail: "dash 'demo' has uncommitted changes".into(),
            }
        );
        assert_eq!(f.tip("tugdash/demo"), before, "the tip did not move");
        assert_eq!(
            std::fs::read_to_string(wt.join("g.txt")).unwrap(),
            "half-written\n",
            "the dirt is intact"
        );
    }

    #[test]
    #[serial]
    fn a_conflicting_round_names_itself_and_moves_nothing() {
        // Both sides rewrite the same line of f.txt.
        let f = init(&[("f.txt", "dash\n", "dash rewrites f")]);
        f.advance_base("f.txt", "base\n", "base rewrites f");
        let before = f.tip("tugdash/demo");

        let outcome = replay_onto(f.path(), "demo").unwrap();
        let ReplayOutcome::Conflicted {
            round,
            round_subject,
            paths,
            ..
        } = &outcome
        else {
            panic!("expected a conflict, got {outcome:?}");
        };
        assert_eq!(round, &before);
        assert_eq!(round_subject, "dash rewrites f");
        assert_eq!(paths, &vec!["f.txt".to_string()]);
        assert_eq!(f.tip("tugdash/demo"), before, "nothing moved");
    }

    #[test]
    #[serial]
    fn a_tip_that_moves_between_probe_and_reset_defers() {
        let f = init(&[("g.txt", "dash\n", "add g")]);
        f.advance_base("f.txt", "B\n", "base moves");
        let wt = f.worktree();
        let stale = f.tip("tugdash/demo");

        // A round lands after the replay was computed against `stale`.
        f.round("h.txt", "later\n", "a later round");
        let now = f.tip("tugdash/demo");

        let refusal = cas_reset(&wt, &stale, &f.tip("main"))
            .unwrap()
            .expect("the compare-and-swap refuses");
        assert!(matches!(
            &refusal,
            ReplayOutcome::Deferred { reason, .. } if reason == "tip-moved"
        ));
        assert_eq!(f.tip("tugdash/demo"), now, "the later round survived");
    }

    #[test]
    #[serial]
    fn an_unmoved_base_is_current() {
        let f = init(&[("g.txt", "dash\n", "add g")]);
        assert_eq!(
            replay_onto(f.path(), "demo").unwrap(),
            ReplayOutcome::Current
        );

        // Still current after the dash is rebased onto a moved base by hand and
        // there is no record to repair: the branch already descends from the
        // tip, so there is nothing to move and nothing to say.
        f.advance_base("f.txt", "B\n", "base moves");
        git(&f.worktree(), &["rebase", "main"]);
        assert_eq!(
            replay_onto(f.path(), "demo").unwrap(),
            ReplayOutcome::Current
        );
    }

    #[test]
    #[serial]
    fn a_branch_without_a_worktree_defers() {
        let f = init(&[("g.txt", "dash\n", "add g")]);
        f.advance_base("f.txt", "B\n", "base moves");
        let wt = f.worktree();
        git(
            f.path(),
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        let before = f.tip("tugdash/demo");

        let outcome = replay_onto(f.path(), "demo").unwrap();
        assert!(matches!(
            &outcome,
            ReplayOutcome::Deferred { reason, .. } if reason == "no-worktree"
        ));
        assert_eq!(f.tip("tugdash/demo"), before);
    }

    #[test]
    #[serial]
    fn a_dash_with_no_rounds_defers() {
        let f = init(&[]);
        f.advance_base("f.txt", "B\n", "base moves");
        let outcome = replay_onto(f.path(), "demo").unwrap();
        assert!(matches!(
            &outcome,
            ReplayOutcome::Deferred { reason, .. } if reason == "no-rounds"
        ));
    }

    #[test]
    #[serial]
    fn an_unknown_dash_is_an_error() {
        let f = init(&[]);
        assert!(replay_onto(f.path(), "nope").is_err());
    }

    // ---- bookkeeping ----

    #[test]
    #[serial]
    fn a_replay_remaps_the_ledger_and_commits_the_remap() {
        let f = init(&[]);
        let round = f.round("g.txt", "dash\n", "add g");
        plan_with_cells(&f, &[("step-1", "Add g", &round[..9])]);
        f.advance_base("f.txt", "B\n", "base moves");

        let outcome = replay_onto(f.path(), "demo").unwrap();
        let ReplayOutcome::Replayed {
            bookkeeping_commit, ..
        } = &outcome
        else {
            panic!("expected a replay, got {outcome:?}");
        };
        let remap = bookkeeping_commit.as_ref().expect("a remap round");
        assert_eq!(
            git_stdout(&f.worktree(), &["log", "-1", "--format=%s", remap]).unwrap(),
            "tugdash(demo): remap round ids after base replay"
        );

        // Every cell now names a commit that is actually on the branch, and the
        // recorded abbreviation keeps its width.
        for cell in cells(&f) {
            assert_eq!(cell.len(), 9, "the cell keeps its width: {cell}");
            assert!(
                is_ancestor(f.path(), &cell, "tugdash/demo"),
                "cell {cell} resolves on the branch"
            );
            assert!(
                !round.starts_with(&cell),
                "the cell no longer names the pre-replay round"
            );
        }

        let log = f.dash_log();
        assert!(log.contains("replayed"), "the dash-log records it: {log}");
        assert!(
            log.contains(&format!("{}->", &round[..9])),
            "the log names the old round: {log}"
        );
    }

    #[test]
    #[serial]
    fn a_hand_rebase_is_reconciled_by_subject_and_refuses_a_duplicate() {
        let f = init(&[]);
        let unique = f.round("g.txt", "one\n", "a unique subject");
        let dup_a = f.round("h.txt", "two\n", "a repeated subject");
        f.round("i.txt", "three\n", "a repeated subject");
        plan_with_cells(
            &f,
            &[
                ("step-1", "Unique", &unique[..9]),
                ("step-2", "Duplicated", &dup_a[..9]),
            ],
        );
        f.advance_base("f.txt", "B\n", "base moves");

        // The rebase the agent would have done by hand.
        git(&f.worktree(), &["rebase", "main"]);

        let outcome = replay_onto(f.path(), "demo").unwrap();
        let ReplayOutcome::Recorded {
            remapped, unmapped, ..
        } = &outcome
        else {
            panic!("expected a recorded reconciliation, got {outcome:?}");
        };
        assert_eq!(remapped, &vec!["step-1".to_string()]);
        assert_eq!(
            unmapped,
            &vec!["step-2".to_string()],
            "a duplicated subject is left alone rather than guessed at"
        );

        let cells = cells(&f);
        assert!(
            is_ancestor(f.path(), &cells[0], "tugdash/demo"),
            "the unique row was repaired"
        );
        assert_eq!(
            cells[1],
            dup_a[..9],
            "the ambiguous row keeps the sha it had"
        );

        let log = f.dash_log();
        assert!(log.contains("by rebase"), "{log}");
        assert!(log.contains("remapped step-1"), "{log}");
        assert!(log.contains("unmapped step-2"), "{log}");
    }

    #[test]
    #[serial]
    fn no_plan_recorded_still_records_the_replay() {
        let f = init(&[("g.txt", "dash\n", "add g")]);
        f.advance_base("f.txt", "B\n", "base moves");

        let outcome = replay_onto(f.path(), "demo").unwrap();
        let ReplayOutcome::Replayed {
            bookkeeping_commit, ..
        } = &outcome
        else {
            panic!("expected a replay, got {outcome:?}");
        };
        assert!(bookkeeping_commit.is_none(), "nothing to remap, no round");
        assert!(f.dash_log().contains("replayed"));
    }

    #[test]
    #[serial]
    fn the_replayed_marker_is_invisible_to_stage_derivation() {
        let f = init(&[("g.txt", "dash\n", "add g")]);
        let before = read_declarations(f.path(), "demo");
        f.advance_base("f.txt", "B\n", "base moves");
        replay_onto(f.path(), "demo").unwrap();
        let after = read_declarations(f.path(), "demo");

        assert!(f.dash_log().contains("replayed"), "the line was written");
        assert_eq!(
            (before.latest, before.step),
            (after.latest, after.step),
            "a replayed line declares no stage and no step progress"
        );
        assert!(
            after.last_replay.is_some(),
            "it is readable as the settled mark's text"
        );
    }
}
