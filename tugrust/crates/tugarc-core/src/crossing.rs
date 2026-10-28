//! Crossings — two live arcs on one base that touch the same paths.
//!
//! An arc is reconciled against its base continuously, by base motion, but
//! two live siblings were never compared at all: the first of two overlapping
//! arcs became visible to the second only by landing, and then the whole
//! divergence arrived at once. So every round of an arc probes it against each
//! live sibling on the same base, and the probe is a fact recorded where every
//! surface already reads an arc's state — the arc log.
//!
//! # What a probe costs, and when it is skipped
//!
//! The probe is two path listings and, only when they overlap, one
//! `git merge-tree` of the two tips. Both read objects; neither branch is
//! touched, and nothing is checked out. A pair whose paths do not overlap is
//! skipped before `merge-tree` runs — no shared path, no crossing.
//!
//! # What is recorded
//!
//! Overlapping paths that merge clean are a **crossing**; paths that conflict
//! are a **crossing conflict**. Each is one arc log line naming the sibling
//! and the paths, written only when the pair's standing state changes, so an
//! arc committing round after round over the same crossing records it once
//! rather than once a round. The standing state is kept per unordered pair,
//! so a round of either arc reads the same record. A pair that stops crossing
//! clears its record without a line: a crossing that went away is not news.
//!
//! # How a crossing conflict is settled
//!
//! At once, while each side is a round old, by the join ladder's own per-file
//! rungs run over a merge of the two tips ([`settle_crossing`]). What they
//! settle is written **only** to the shared rerere cache: arcs never merge
//! into each other, because a discarded arc would otherwise leave its code in
//! its sibling. When the second arc joins, rung 2 replays the hunks the cache
//! learned here. A conflict the rungs cannot settle is left for the resolver,
//! in a [`crate::resolve::PairCheckout`] whose finished files teach the same
//! cache.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tugcore::instance::Paths;

use crate::error::ArcError;
use crate::ops::{arc_base, branch_name, config_get, git_output, git_stdout, main_repo_root};

/// The marker of a clean crossing's arc log line.
pub const CROSSING: &str = "crossing";

/// The marker of a conflicted crossing's arc log line.
pub const CROSSING_CONFLICT: &str = "crossing-conflict";

/// One sibling an arc crosses: the paths both changed since they diverged,
/// and which of those a merge of the two tips leaves conflicted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Crossing {
    /// The sibling arc's name.
    pub sibling: String,
    /// Paths both arcs changed since their merge-base, in path order.
    pub overlap: Vec<String>,
    /// The subset of `overlap` the merge leaves conflicted, in path order.
    pub conflicts: Vec<String>,
    /// The subset of `overlap` this probe found newly crossing: every path on
    /// a pair's first crossing, and after that only the paths the pair's
    /// standing record did not hold. What the two sessions are told about.
    #[serde(default)]
    pub fresh: Vec<String>,
}

impl Crossing {
    /// The arc log marker this crossing is recorded under.
    pub fn marker(&self) -> &'static str {
        if self.conflicts.is_empty() {
            CROSSING
        } else {
            CROSSING_CONFLICT
        }
    }

    /// The arc log note: the sibling, then the paths that conflict or overlap.
    pub fn note(&self) -> String {
        if self.conflicts.is_empty() {
            format!("{} · overlaps {}", self.sibling, self.overlap.join(", "))
        } else {
            format!("{} · conflicts {}", self.sibling, self.conflicts.join(", "))
        }
    }
}

/// The live arcs on `name`'s base, other than `name` itself, in name order.
///
/// Live is an arc branch that exists: a join or a discard deletes it, and the
/// workshop's branch sits outside the arc namespace, so it is never listed.
pub fn live_siblings(repo_root: &Path, name: &str) -> Result<Vec<String>, ArcError> {
    let repo = main_repo_root(repo_root);
    let base = arc_base(&repo, name)?;
    let refs = git_stdout(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname:strip=3)",
            "refs/heads/tugarc/",
        ],
    )?;
    let mut siblings = Vec::new();
    for sibling in refs.lines().map(str::trim).filter(|s| !s.is_empty()) {
        if sibling == name {
            continue;
        }
        if arc_base(&repo, sibling).is_ok_and(|b| b == base) {
            siblings.push(sibling.to_string());
        }
    }
    Ok(siblings)
}

/// The paths `tip` changed since `merge_base`, a rename at its destination.
fn changed_since(repo: &Path, merge_base: &str, tip: &str) -> Result<BTreeSet<String>, ArcError> {
    let range = format!("{merge_base}..{tip}");
    let args = ["diff", "--name-status", "-M", &range];
    let records = tugchanges_core::listing(repo, &args).map_err(|e| {
        ArcError::git(
            format!("git diff --name-status {range} failed"),
            &args,
            e.to_string(),
        )
    })?;
    Ok(crate::ops::name_status_paths(&records)
        .into_iter()
        .collect())
}

/// Probe one pair: `None` when the two arcs share no changed path, which is
/// decided before `merge-tree` runs.
pub fn probe_pair(
    repo_root: &Path,
    name: &str,
    sibling: &str,
) -> Result<Option<Crossing>, ArcError> {
    let repo = main_repo_root(repo_root);
    let ours = git_stdout(&repo, &["rev-parse", &branch_name(name)])?;
    let theirs = git_stdout(&repo, &["rev-parse", &branch_name(sibling)])?;
    let merge_base = git_stdout(&repo, &["merge-base", &ours, &theirs])?;
    let mine = changed_since(&repo, &merge_base, &ours)?;
    let theirs_changed = changed_since(&repo, &merge_base, &theirs)?;
    let overlap: Vec<String> = mine.intersection(&theirs_changed).cloned().collect();
    if overlap.is_empty() {
        return Ok(None);
    }
    let conflicts: Vec<String> = crate::resolve::conflicted_paths(&repo, &ours, &theirs)?
        .into_iter()
        .filter(|path| overlap.contains(path))
        .collect();
    Ok(Some(Crossing {
        sibling: sibling.to_string(),
        fresh: overlap.clone(),
        overlap,
        conflicts,
    }))
}

/// The config key a pair's standing crossing is kept under: one per unordered
/// pair, so a round of either arc reads and writes the same record.
fn pair_key(a: &str, b: &str) -> String {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    format!("tugcrossing.{lo} {hi}.state")
}

/// What a pair's standing record holds: the paths, never the sibling's name,
/// since the key already names both arcs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Standing {
    overlap: Vec<String>,
    conflicts: Vec<String>,
}

/// Drop every standing crossing record that names `name`, as an arc's
/// teardown does.
///
/// The record lives outside the `branch.tugarc/<name>` section, so deleting
/// the branch does not take it along. Left standing, it would outlive the arc
/// and greet the next arc of the same name with an overlap it never made: its
/// first crossing on those paths would be neither logged nor told.
pub fn forget_crossings(repo_root: &Path, name: &str) {
    let repo = main_repo_root(repo_root);
    let Ok(records) = git_stdout(&repo, &["config", "--get-regexp", r"^tugcrossing\."]) else {
        return;
    };
    // Each line is the key, a space, then the value. The pair's subsection
    // holds a space of its own, so the key ends at `.state `, which no arc
    // name can contain.
    for record in records.lines() {
        let Some(pair) = record
            .strip_prefix("tugcrossing.")
            .and_then(|rest| rest.split_once(".state "))
            .map(|(pair, _)| pair)
        else {
            continue;
        };
        if pair.split(' ').any(|arc| arc == name) {
            let _ = git_output(
                &repo,
                &["config", "--remove-section", &format!("tugcrossing.{pair}")],
            );
        }
    }
}

/// Probe `name` against every live sibling on its base, record each crossing
/// whose standing state changed, and return every crossing found.
///
/// Neither branch moves. A sibling that cannot be probed — its branch went
/// away between the listing and the probe — is skipped rather than failing
/// the rest.
pub fn probe_crossings(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
) -> Result<Vec<Crossing>, ArcError> {
    let repo = main_repo_root(repo_root);
    let mut found = Vec::new();
    for sibling in live_siblings(&repo, name)? {
        let Ok(probe) = probe_pair(&repo, name, &sibling) else {
            continue;
        };
        let key = pair_key(name, &sibling);
        let standing =
            config_get(&repo, &key).and_then(|value| serde_json::from_str::<Standing>(&value).ok());
        let Some(mut crossing) = probe else {
            if standing.is_some() {
                let _ = git_output(&repo, &["config", "--unset-all", &key]);
            }
            continue;
        };
        if let Some(standing) = &standing {
            crossing
                .fresh
                .retain(|path| !standing.overlap.contains(path));
        }
        let now = Standing {
            overlap: crossing.overlap.clone(),
            conflicts: crossing.conflicts.clone(),
        };
        if standing.as_ref() != Some(&now) {
            let value = serde_json::to_string(&now).unwrap_or_default();
            let _ = git_output(&repo, &["config", "--replace-all", &key, &value]);
            crate::log::append_arc_log(paths, &repo, name, crossing.marker(), &crossing.note())
                .map_err(|e| ArcError::arc_log(paths, &repo, e))?;
        }
        found.push(crossing);
    }
    Ok(found)
}

/// The line ranges `tip` changed in `path` since `merge_base`, in `tip`'s own
/// numbering, first line and last, from a zero-context diff. A pure deletion
/// is the one line it sits after.
pub fn changed_regions(repo: &Path, merge_base: &str, tip: &str, path: &str) -> Vec<(u32, u32)> {
    // `GIT_DIFF_OPTS` widens every diff's context when it is set, `-U0`
    // included, and a hunk of the whole file names no region.
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["diff", "--no-color", "-U0", merge_base, tip, "--", path])
        .env_remove("GIT_DIFF_OPTS")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();
    out.lines()
        .filter_map(|line| {
            let after = line.strip_prefix("@@ ")?.split_whitespace().nth(1)?;
            let after = after.strip_prefix('+')?;
            let (start, count) = match after.split_once(',') {
                Some((start, count)) => (start.parse::<u32>().ok()?, count.parse::<u32>().ok()?),
                None => (after.parse::<u32>().ok()?, 1),
            };
            let last = start + count.saturating_sub(1);
            Some((start.max(1), last.max(start).max(1)))
        })
        .collect()
}

fn describe_regions(regions: &[(u32, u32)]) -> String {
    if regions.is_empty() {
        return "the whole file".to_string();
    }
    let ranges: Vec<String> = regions
        .iter()
        .map(|&(first, last)| {
            if first == last {
                format!("{first}")
            } else {
                format!("{first}–{last}")
            }
        })
        .collect();
    let noun = if regions.len() == 1 && regions[0].0 == regions[0].1 {
        "line"
    } else {
        "lines"
    };
    format!("{noun} {}", ranges.join(", "))
}

/// One arc's notice about a crossing: the arc it goes to, and its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossingNotice {
    pub arc: String,
    pub text: String,
}

/// The two notices a crossing's fresh paths call for, one to each arc,
/// naming the other arc, each fresh file, and the lines the other arc
/// changed in it. Empty when nothing is fresh, which is what keeps a repeat
/// on the same path silent.
pub fn crossing_notices(
    repo_root: &Path,
    name: &str,
    crossing: &Crossing,
) -> Result<Vec<CrossingNotice>, ArcError> {
    if crossing.fresh.is_empty() {
        return Ok(Vec::new());
    }
    let repo = main_repo_root(repo_root);
    let ours = git_stdout(&repo, &["rev-parse", &branch_name(name)])?;
    let theirs = git_stdout(&repo, &["rev-parse", &branch_name(&crossing.sibling)])?;
    let merge_base = git_stdout(&repo, &["merge-base", &ours, &theirs])?;
    let compose = |to: &str, from: &str, from_tip: &str| {
        let mut text = format!(
            "Arc \"{from}\", live on the same base as \"{to}\", changed files this arc changed too. \
             No action is required: this is so the overlap can be kept small while it is one round old, \
             because every edit there is one the later join must reconcile.\n"
        );
        for path in &crossing.fresh {
            let regions = changed_regions(&repo, &merge_base, from_tip, path);
            let state = if crossing.conflicts.contains(path) {
                " — already conflicting"
            } else {
                ""
            };
            text.push_str(&format!(
                "  {path} — \"{from}\" changed {}{state}\n",
                describe_regions(&regions)
            ));
        }
        CrossingNotice {
            arc: to.to_string(),
            text,
        }
    };
    Ok(vec![
        compose(name, &crossing.sibling, &theirs),
        compose(&crossing.sibling, name, &ours),
    ])
}

/// The two tips a crossing is settled over, in name order, so a round of
/// either arc settles the same merge and the cache learns one preimage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossingPair {
    /// The arc whose tip is the merge's first side: the lower name.
    pub first: String,
    pub first_tip: String,
    /// The arc whose tip is merged in: the higher name.
    pub second: String,
    pub second_tip: String,
}

impl CrossingPair {
    pub fn read(repo_root: &Path, a: &str, b: &str) -> Result<Self, ArcError> {
        let repo = main_repo_root(repo_root);
        let (first, second) = if a <= b { (a, b) } else { (b, a) };
        Ok(Self {
            first_tip: git_stdout(&repo, &["rev-parse", &branch_name(first)])?,
            second_tip: git_stdout(&repo, &["rev-parse", &branch_name(second)])?,
            first: first.to_string(),
            second: second.to_string(),
        })
    }

    /// What both arcs were for, each read against the other, and what the
    /// merge is: a crossing nobody is joining yet.
    pub fn intent(&self, paths: &Paths, repo_root: &Path) -> String {
        let repo = main_repo_root(repo_root);
        let one = branch_name(&self.first);
        let two = branch_name(&self.second);
        format!(
            "Two live arcs, `{}` and `{}`, both changed these files. Nothing is being joined: \
             the merge settles the overlap now so either arc's later join replays it.\n\n\
             # `{}`\n\n{}\n\n# `{}`\n\n{}",
            self.first,
            self.second,
            self.first,
            crate::resolve::resolve_intent(paths, &repo, &two, &one).trim(),
            self.second,
            crate::resolve::resolve_intent(paths, &repo, &one, &two).trim(),
        )
    }
}

/// Settle the crossing between `name` and `sibling` into the rerere cache.
///
/// Runs the pair ladder over the two tips and returns the pair it read with
/// what the rungs settled and what they left. Neither branch moves; the cache
/// is the only thing written.
pub fn settle_crossing(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    sibling: &str,
    merger: Option<&dyn crate::resolve::FileMerger>,
) -> Result<(CrossingPair, crate::resolve::PairResolution), ArcError> {
    let repo = main_repo_root(repo_root);
    let pair = CrossingPair::read(&repo, name, sibling)?;
    let intent = pair.intent(paths, &repo);
    let settled =
        crate::resolve::resolve_pair(&repo, &pair.first_tip, &pair.second_tip, merger, &intent)?;
    Ok((pair, settled))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcore::test_fixtures::git::{GitFixture, git};

    fn set(repo: &Path, rel: &str, body: &str) {
        std::fs::write(repo.join(rel), body).unwrap();
    }

    /// `main` with a ten-line `f.txt` and a `g.txt`, and two arcs `a` and `b`
    /// cut from it, each on `main`.
    fn two_arcs() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        GitFixture::init(repo);
        let ten: String = (1..=10).map(|n| format!("line {n}\n")).collect();
        set(repo, "f.txt", &ten);
        set(repo, "g.txt", "g\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        for arc in ["a", "b"] {
            git(repo, &["branch", &format!("tugarc/{arc}")]);
            git(
                repo,
                &["config", &format!("branch.tugarc/{arc}.tugbase"), "main"],
            );
        }
        temp
    }

    /// One round on `arc` that writes `rel` as `body`.
    fn round(repo: &Path, arc: &str, rel: &str, body: &str) {
        git(repo, &["switch", "-q", &format!("tugarc/{arc}")]);
        set(repo, rel, body);
        git(repo, &["commit", "-qam", &format!("{arc} round")]);
        git(repo, &["switch", "-q", "main"]);
    }

    fn edit_line(n: usize, to: &str) -> String {
        (1..=10)
            .map(|i| {
                if i == n {
                    format!("{to}\n")
                } else {
                    format!("line {i}\n")
                }
            })
            .collect()
    }

    fn tips(repo: &Path) -> (String, String) {
        (
            git_stdout(repo, &["rev-parse", "tugarc/a"]).unwrap(),
            git_stdout(repo, &["rev-parse", "tugarc/b"]).unwrap(),
        )
    }

    fn logged(paths: &Paths, repo: &Path) -> Vec<String> {
        let log = tugtool_core::paths::arc_log_path_at(paths, repo);
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                crate::log::split_log_line(line)
                    .filter(|(_, _, marker, _)| marker.starts_with("crossing"))
                    .map(|(_, arc, marker, note)| format!("{arc} {marker} {note}"))
            })
            .collect()
    }

    #[test]
    fn arcs_on_another_base_are_not_siblings() {
        let temp = two_arcs();
        let repo = temp.path();
        git(repo, &["branch", "other"]);
        git(repo, &["branch", "tugarc/c", "other"]);
        git(repo, &["config", "branch.tugarc/c.tugbase", "other"]);
        assert_eq!(live_siblings(repo, "a").unwrap(), vec!["b".to_string()]);
    }

    /// Disjoint paths: no crossing, and `merge-tree` is never asked.
    #[test]
    fn a_disjoint_pair_is_not_a_crossing() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let temp = two_arcs();
        let repo = temp.path();
        round(repo, "a", "f.txt", &edit_line(1, "a one"));
        round(repo, "b", "g.txt", "g by b\n");

        assert_eq!(probe_pair(repo, "a", "b").unwrap(), None);
        assert!(probe_crossings(&paths, repo, "a").unwrap().is_empty());
        assert!(logged(&paths, repo).is_empty());
    }

    /// The same file, different regions: a clean crossing, recorded once, with
    /// neither branch moved.
    #[test]
    fn an_overlap_that_merges_clean_is_a_crossing() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let temp = two_arcs();
        let repo = temp.path();
        round(repo, "a", "f.txt", &edit_line(1, "a one"));
        round(repo, "b", "f.txt", &edit_line(9, "b nine"));
        let before = tips(repo);

        let found = probe_crossings(&paths, repo, "a").unwrap();
        assert_eq!(
            found,
            vec![Crossing {
                sibling: "b".to_string(),
                overlap: vec!["f.txt".to_string()],
                conflicts: vec![],
                fresh: vec!["f.txt".to_string()],
            }]
        );
        assert_eq!(logged(&paths, repo), vec!["a crossing b · overlaps f.txt"]);
        assert_eq!(tips(repo), before, "neither branch is touched");

        // A round of the other arc over the same crossing is not news.
        probe_crossings(&paths, repo, "b").unwrap();
        probe_crossings(&paths, repo, "a").unwrap();
        assert_eq!(logged(&paths, repo).len(), 1);
    }

    /// The same lines: a crossing conflict, and it is recorded again when a
    /// clean crossing becomes one.
    #[test]
    fn an_overlap_that_conflicts_is_a_crossing_conflict() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let temp = two_arcs();
        let repo = temp.path();
        round(repo, "a", "f.txt", &edit_line(1, "a one"));
        round(repo, "b", "f.txt", &edit_line(9, "b nine"));
        probe_crossings(&paths, repo, "a").unwrap();

        // b now rewrites a's line as well.
        let both = edit_line(9, "b nine").replace("line 1\n", "b one\n");
        round(repo, "b", "f.txt", &both);
        let before = tips(repo);
        let found = probe_crossings(&paths, repo, "b").unwrap();
        assert_eq!(found[0].conflicts, vec!["f.txt".to_string()]);
        assert_eq!(found[0].marker(), CROSSING_CONFLICT);
        assert_eq!(
            logged(&paths, repo),
            vec![
                "a crossing b · overlaps f.txt",
                "b crossing-conflict a · conflicts f.txt",
            ]
        );
        assert_eq!(tips(repo), before, "neither branch is touched");
    }

    /// A first crossing tells each arc once, naming the other arc, the file
    /// and the other's lines; another round over the same path tells nobody;
    /// a path that newly crosses is told about alone.
    #[test]
    fn a_new_crossing_tells_each_arc_once_per_path() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let temp = two_arcs();
        let repo = temp.path();
        round(repo, "a", "f.txt", &edit_line(1, "a one"));
        round(repo, "b", "f.txt", &edit_line(9, "b nine"));

        let found = probe_crossings(&paths, repo, "a").unwrap();
        let notices = crossing_notices(repo, "a", &found[0]).unwrap();
        let to: Vec<&str> = notices.iter().map(|n| n.arc.as_str()).collect();
        assert_eq!(to, vec!["a", "b"], "one notice to each arc");
        assert!(notices[0].text.contains("Arc \"b\""), "{}", notices[0].text);
        assert!(
            notices[0].text.contains("f.txt — \"b\" changed line 9"),
            "{}",
            notices[0].text
        );
        assert!(
            notices[1].text.contains("f.txt — \"a\" changed line 1"),
            "{}",
            notices[1].text
        );

        // Another round of b over the same path: the crossing stands, and
        // nobody is told again, whichever arc's round probes it.
        round(repo, "b", "f.txt", &edit_line(9, "b nine again"));
        for arc in ["b", "a"] {
            let found = probe_crossings(&paths, repo, arc).unwrap();
            assert!(found[0].fresh.is_empty());
            assert!(crossing_notices(repo, arc, &found[0]).unwrap().is_empty());
        }

        // A path that newly crosses is the only one named.
        round(repo, "a", "g.txt", "g by a\n");
        round(repo, "b", "g.txt", "g by b\n");
        let found = probe_crossings(&paths, repo, "b").unwrap();
        assert_eq!(found[0].fresh, vec!["g.txt".to_string()]);
        let notices = crossing_notices(repo, "b", &found[0]).unwrap();
        assert_eq!(notices.len(), 2);
        assert!(notices.iter().all(|n| !n.text.contains("f.txt")));
        assert!(
            notices[0]
                .text
                .contains("g.txt — \"a\" changed line 1 — already conflicting")
        );
    }

    /// Both arcs rewrite line five, so no text rung settles the merge.
    fn line_five_conflict(repo: &Path) {
        round(repo, "a", "f.txt", &edit_line(5, "a five"));
        round(repo, "b", "f.txt", &edit_line(5, "b five"));
    }

    /// Both sides' line five, in the block's place.
    fn kept_both() -> String {
        edit_line(5, "a five\nb five")
    }

    /// A scribe whose every merge is `kept_both`.
    struct KeepsBoth;
    impl crate::resolve::FileMerger for KeepsBoth {
        fn merge(&self, _req: &crate::resolve::FileMergeRequest) -> Option<Vec<u8>> {
            Some(kept_both().into_bytes())
        }
    }

    /// Land `first` the way a join does — `main` takes its tree and its branch
    /// goes — then run the second arc's join ladder with no scribe at all.
    fn join_after(paths: &Paths, repo: &Path, first: &str, second: &str) -> crate::ResolveOutcome {
        git(
            repo,
            &["merge", "-q", "--ff-only", &format!("tugarc/{first}")],
        );
        git(repo, &["branch", "-D", &format!("tugarc/{first}")]);
        crate::resolve::resolve_conflicts(paths, repo, second, None).unwrap()
    }

    fn landed_file(repo: &Path, outcome: &crate::ResolveOutcome) -> String {
        let candidate = outcome.candidate_commit.as_deref().expect("a candidate");
        git_stdout(repo, &["show", &format!("{candidate}:f.txt")]).unwrap() + "\n"
    }

    /// The crossing settled while both arcs were a round old is what the
    /// second join replays, through rung 2, whichever arc lands first.
    #[test]
    fn a_crossing_settled_at_a_round_replays_through_rerere_at_the_join() {
        for (first, second) in [("a", "b"), ("b", "a")] {
            let _state = tempfile::TempDir::new().unwrap();
            let paths = Paths::under(_state.path());
            let temp = two_arcs();
            let repo = temp.path();
            line_five_conflict(repo);
            let before = tips(repo);

            let (pair, settled) =
                settle_crossing(&paths, repo, "b", "a", Some(&KeepsBoth)).unwrap();
            assert_eq!((pair.first.as_str(), pair.second.as_str()), ("a", "b"));
            assert_eq!(
                settled.resolved,
                vec![("f.txt".to_string(), crate::ResolvedBy::Ai)]
            );
            assert!(settled.unresolved.is_empty());
            assert_eq!(tips(repo), before, "neither branch is touched");

            let joined = join_after(&paths, repo, first, second);
            assert_eq!(joined.resolved.len(), 1, "{first} then {second}");
            assert_eq!(joined.resolved[0].resolved_by, crate::ResolvedBy::Rerere);
            assert_eq!(landed_file(repo, &joined), kept_both());
        }
    }

    /// What the rungs leave, the resolver finishes in a pair checkout, and
    /// its finished file is what the join replays.
    #[test]
    fn a_crossing_the_resolver_finished_replays_at_the_join() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let temp = two_arcs();
        let repo = temp.path();
        line_five_conflict(repo);

        let (pair, settled) = settle_crossing(&paths, repo, "a", "b", None).unwrap();
        assert_eq!(settled.unresolved, vec!["f.txt".to_string()]);
        let checkout =
            crate::resolve::PairCheckout::open(repo, &pair.first_tip, &pair.second_tip, &settled)
                .unwrap();
        set(checkout.path(), "f.txt", &kept_both());
        checkout.teach(repo, &settled.unresolved).unwrap();
        drop(checkout);

        let joined = join_after(&paths, repo, "a", "b");
        assert_eq!(joined.resolved[0].resolved_by, crate::ResolvedBy::Rerere);
        assert_eq!(landed_file(repo, &joined), kept_both());
    }

    /// A finished file that leaves markers or rewrites clean text teaches the
    /// cache nothing, so the join meets the conflict fresh.
    #[test]
    fn a_bad_finish_teaches_the_cache_nothing() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let temp = two_arcs();
        let repo = temp.path();
        line_five_conflict(repo);

        let (pair, settled) = settle_crossing(&paths, repo, "a", "b", None).unwrap();
        let checkout =
            crate::resolve::PairCheckout::open(repo, &pair.first_tip, &pair.second_tip, &settled)
                .unwrap();
        let refused = checkout.teach(repo, &settled.unresolved).unwrap_err();
        assert!(refused.contains("left conflicts in f.txt"), "{refused}");
        set(
            checkout.path(),
            "f.txt",
            &kept_both().replace("line 1\n", "LINE 1\n"),
        );
        let refused = checkout.teach(repo, &settled.unresolved).unwrap_err();
        assert!(
            refused.contains("outside the conflicts in f.txt"),
            "{refused}"
        );
        drop(checkout);

        let joined = join_after(&paths, repo, "a", "b");
        assert_eq!(joined.unresolved, vec!["f.txt".to_string()]);
    }

    /// An arc's teardown forgets its crossings, so a later arc of the same
    /// name meets its first crossing as news rather than as a repeat.
    #[test]
    fn a_torn_down_arc_leaves_no_standing_crossing() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let temp = two_arcs();
        let repo = temp.path();
        git(repo, &["branch", "tugarc/c"]);
        git(repo, &["config", "branch.tugarc/c.tugbase", "main"]);
        round(repo, "a", "f.txt", &edit_line(1, "a one"));
        round(repo, "b", "f.txt", &edit_line(9, "b nine"));
        round(repo, "c", "f.txt", &edit_line(5, "c five"));
        probe_crossings(&paths, repo, "a").unwrap();
        probe_crossings(&paths, repo, "b").unwrap();

        forget_crossings(repo, "a");
        assert!(config_get(repo, &pair_key("a", "b")).is_none());
        assert!(config_get(repo, &pair_key("a", "c")).is_none());
        assert!(
            config_get(repo, &pair_key("b", "c")).is_some(),
            "a pair the arc is not in stands"
        );
    }
}
