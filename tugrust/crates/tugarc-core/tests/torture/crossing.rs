//! The crossing torture bench: adversarial pairs of live arcs, built from
//! scratch in a tempdir and walked round by round through the probe, the
//! pair ladder, a landing and the second arc's join — the whole path a real
//! crossing takes, minus tugcast — with every stand-in for a model written
//! down. Shared by the `crossing_torture` example, which prints the table,
//! and the integration test of the same name, which asserts each scenario's
//! expectation under nextest.
//!
//! What a scenario reports: the crossings the probe saw (clean and
//! conflicted), what the settles taught the cache, which rung settled each
//! file at the join, how many conflict blocks rung 2 took out, and whether
//! the landed bytes equal what the scenario says they should.

use std::path::PathBuf;

use tugarc_core::ResolvedBy;
use tugarc_core::crossing::{forget_crossings, probe_crossings, settle_crossing};
use tugarc_core::resolve::{FileMergeRequest, FileMerger, PairCheckout};
use tugcore::instance::Paths;
use tugcore::test_fixtures::git::{GitFixture, git as fixture_git};

// MARK: - Stand-ins for the scribe

/// The keep-both merge, `git merge-file --union`: every conflict block
/// becomes ours then theirs. `None` on a file merge-file refuses (binary).
pub fn union(base: &[u8], ours: &[u8], theirs: &[u8]) -> Option<Vec<u8>> {
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
    match out.status.code() {
        Some(0..=127) => Some(out.stdout),
        _ => None,
    }
}

/// Which model the AI rung is played by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scribe {
    /// No AI rung at all.
    None,
    /// Keeps both sides of every block — the incident's real resolution.
    KeepBoth,
    /// Answers in prose, as the incident's scribe did.
    Prose,
    /// Hands back its own side, dropping the other's.
    OursOnly,
    /// Keeps both sides and re-indents one line git merged by itself.
    Reformats,
}

impl FileMerger for Scribe {
    fn merge(&self, req: &FileMergeRequest) -> Option<Vec<u8>> {
        let both = || {
            union(
                req.base.as_deref().unwrap_or_default(),
                req.ours.as_deref()?,
                req.theirs.as_deref()?,
            )
        };
        match self {
            Scribe::None => None,
            Scribe::KeepBoth => both(),
            Scribe::Prose => Some(
                b"I can't produce a safe merge of this file, so I'm outputting no merged file.\n"
                    .to_vec(),
            ),
            Scribe::OursOnly => req.ours.clone(),
            Scribe::Reformats => {
                let text = String::from_utf8(both()?).ok()?;
                Some(text.replacen("line 1\n", "line  1\n", 1).into_bytes())
            }
        }
    }
}

// MARK: - The bench

/// One edit a round makes.
pub enum Edit {
    Write(String),
    WriteBytes(Vec<u8>),
    Delete,
    Rename(&'static str),
    Executable,
}

/// A settle the bench ran, as the table shows it.
#[derive(Debug, Clone)]
pub struct Settle {
    pub resolved: Vec<(String, ResolvedBy)>,
    pub unresolved: Vec<String>,
    /// What the resolver stand-in did with what the rungs left, if it ran.
    pub resolver: Option<Result<(), String>>,
}

/// The second arc's join, as the ladder ran it with no scribe at all.
#[derive(Debug, Clone)]
pub struct Join {
    pub conflicts: Vec<String>,
    pub resolved: Vec<(String, ResolvedBy)>,
    pub unresolved: Vec<String>,
    pub candidate: Option<String>,
    /// Conflict blocks the merge leaves with the cache off, and with it on.
    pub blocks: (usize, usize),
}

impl Join {
    pub fn rung(&self, path: &str) -> Option<ResolvedBy> {
        self.resolved
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, by)| *by)
    }
}

pub struct Bench {
    _temp: tempfile::TempDir,
    _state: tempfile::TempDir,
    pub repo: PathBuf,
    pub paths: Paths,
    pub scribe: Scribe,
    /// Whether what the rungs leave is finished by a keep-both resolver
    /// stand-in in the pair's checkout, and taught.
    pub resolver: bool,
    pub clean_crossings: usize,
    pub conflict_crossings: usize,
    pub settles: Vec<Settle>,
    pub joins: Vec<Join>,
    pub notes: Vec<String>,
    pub failures: Vec<String>,
}

/// `line 1 … line n`, one per line.
pub fn lines(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

/// `text` with line `n` replaced by `to` (which may be several lines).
pub fn edit(text: &str, n: usize, to: &str) -> String {
    text.lines()
        .enumerate()
        .map(|(i, line)| {
            if i + 1 == n {
                format!("{to}\n")
            } else {
                format!("{line}\n")
            }
        })
        .collect()
}

impl Bench {
    /// A repository whose `main` holds `files`, with no arcs yet.
    pub fn new(scribe: Scribe, resolver: bool, files: &[(&str, &str)]) -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let state = tempfile::tempdir().expect("state dir");
        let repo = temp.path().canonicalize().expect("canonical").to_path_buf();
        GitFixture::init(&repo);
        for (path, body) in files {
            std::fs::write(repo.join(path), body).expect("write");
        }
        fixture_git(&repo, &["add", "-A"]);
        fixture_git(&repo, &["commit", "-qm", "base"]);
        let paths = Paths::under(state.path());
        Self {
            _temp: temp,
            _state: state,
            repo,
            paths,
            scribe,
            resolver,
            clean_crossings: 0,
            conflict_crossings: 0,
            settles: Vec::new(),
            joins: Vec::new(),
            notes: Vec::new(),
            failures: Vec::new(),
        }
    }

    pub fn git(&self, args: &[&str]) -> String {
        fixture_git(&self.repo, args).trim().to_string()
    }

    /// Cut an arc from `main`.
    pub fn arc(&self, name: &str) {
        self.git(&["branch", &format!("tugarc/{name}")]);
        self.git(&["config", &format!("branch.tugarc/{name}.tugbase"), "main"]);
    }

    /// One round on `arc`: the edits, a commit, the probe against every
    /// sibling, and a settle of each crossing conflict the probe found.
    pub fn round(&mut self, arc: &str, edits: &[(&str, Edit)]) {
        self.git(&["switch", "-q", &format!("tugarc/{arc}")]);
        for (path, edit) in edits {
            let full = self.repo.join(path);
            match edit {
                Edit::Write(body) => std::fs::write(&full, body).expect("write"),
                Edit::WriteBytes(bytes) => std::fs::write(&full, bytes).expect("write"),
                Edit::Delete => {
                    self.git(&["rm", "-q", path]);
                }
                Edit::Rename(to) => {
                    self.git(&["mv", path, to]);
                }
                Edit::Executable => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&full, std::fs::Permissions::from_mode(0o755))
                            .expect("chmod");
                    }
                }
            }
        }
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", &format!("{arc} round")]);
        self.git(&["switch", "-q", "main"]);

        let found = probe_crossings(&self.paths, &self.repo, arc).expect("probe");
        for crossing in found {
            if crossing.conflicts.is_empty() {
                self.clean_crossings += 1;
                continue;
            }
            self.conflict_crossings += 1;
            self.settle(arc, &crossing.sibling);
        }
    }

    fn settle(&mut self, arc: &str, sibling: &str) {
        let scribe = self.scribe;
        let merger: Option<&dyn FileMerger> = match scribe {
            Scribe::None => None,
            _ => Some(&scribe),
        };
        let (pair, settled) =
            settle_crossing(&self.paths, &self.repo, arc, sibling, merger).expect("settle");
        let mut row = Settle {
            resolved: settled.resolved.clone(),
            unresolved: settled.unresolved.clone(),
            resolver: None,
        };
        if self.resolver && !settled.unresolved.is_empty() {
            let checkout =
                PairCheckout::open(&self.repo, &pair.first_tip, &pair.second_tip, &settled)
                    .expect("pair checkout");
            let fork = self.git(&["merge-base", &pair.first_tip, &pair.second_tip]);
            for path in &settled.unresolved {
                if let Some(merged) = union(
                    &self.blob(&fork, path),
                    &self.blob(&pair.first_tip, path),
                    &self.blob(&pair.second_tip, path),
                ) {
                    std::fs::write(checkout.path().join(path), merged).expect("write");
                }
            }
            row.resolver = Some(checkout.teach(&self.repo, &settled.unresolved));
        }
        self.settles.push(row);
    }

    /// Land `arc` as a join does: `main` takes its tree and its branch goes.
    pub fn land(&self, arc: &str) {
        self.git(&["merge", "-q", "--ff-only", &format!("tugarc/{arc}")]);
        self.git(&["branch", "-qD", &format!("tugarc/{arc}")]);
        forget_crossings(&self.repo, arc);
    }

    /// Land a join's own candidate — one commit on `main` with its tree —
    /// so a third arc's join meets what the second's really left.
    pub fn land_candidate(&self, arc: &str, candidate: &str) {
        let tree = self.git(&["rev-parse", &format!("{candidate}^{{tree}}")]);
        let head = self.git(&["rev-parse", "main"]);
        let sha = self.git(&[
            "commit-tree",
            &tree,
            "-p",
            &head,
            "-m",
            &format!("join {arc}"),
        ]);
        self.git(&["update-ref", "refs/heads/main", &sha]);
        self.git(&["branch", "-qD", &format!("tugarc/{arc}")]);
        forget_crossings(&self.repo, arc);
    }

    /// Run `arc`'s join ladder with no scribe, so every path it settles is
    /// settled by a rung that needs no model.
    pub fn join(&mut self, arc: &str) -> Join {
        let outcome =
            tugarc_core::resolve_conflicts(&self.paths, &self.repo, arc, None).expect("join");
        let blocks = self.blocks(&format!("tugarc/{arc}"));
        let join = Join {
            conflicts: outcome.preview_conflicts.clone(),
            resolved: outcome
                .resolved
                .iter()
                .map(|r| (r.path.clone(), r.resolved_by))
                .collect(),
            unresolved: outcome.unresolved.clone(),
            candidate: outcome.candidate_commit.clone(),
            blocks,
        };
        self.joins.push(join.clone());
        join
    }

    /// A blob's bytes at `rev`, empty when the path is absent there.
    pub fn blob(&self, rev: &str, path: &str) -> Vec<u8> {
        tugcore::git_command()
            .arg("-C")
            .arg(&self.repo)
            .args(["cat-file", "blob", &format!("{rev}:{path}")])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| out.stdout)
            .unwrap_or_default()
    }

    pub fn text(&self, rev: &str, path: &str) -> String {
        String::from_utf8_lossy(&self.blob(rev, path)).into_owned()
    }

    /// The keep-both merge of `path` across `ours` and `theirs` from their
    /// fork — what a resolution recorded for that pair replays.
    pub fn union_at(&self, path: &str, ours: &str, theirs: &str) -> String {
        let fork = self.git(&["merge-base", ours, theirs]);
        union(
            &self.blob(&fork, path),
            &self.blob(ours, path),
            &self.blob(theirs, path),
        )
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
    }

    /// How many conflict blocks a merge of `branch` into `main` leaves, with
    /// rerere off and with it on.
    fn blocks(&self, branch: &str) -> (usize, usize) {
        let count = |rerere: &str| {
            let dir = tempfile::tempdir().expect("scratch");
            let at = dir.path().join("wt");
            self.git(&[
                "worktree",
                "add",
                "-q",
                "--detach",
                &at.to_string_lossy(),
                "main",
            ]);
            let _ = tugcore::git_command()
                .arg("-C")
                .arg(&at)
                .args([
                    "-c",
                    &format!("rerere.enabled={rerere}"),
                    "-c",
                    "rerere.autoUpdate=false",
                ])
                .args(["merge", "--no-commit", "--no-ff", branch])
                .output();
            let listed = fixture_git(&at, &["diff", "--name-only", "--diff-filter=U"]);
            let total = listed
                .lines()
                .filter_map(|path| std::fs::read_to_string(at.join(path)).ok())
                .map(|text| text.lines().filter(|l| l.starts_with("<<<<<<<")).count())
                .sum();
            self.git(&["worktree", "remove", "--force", &at.to_string_lossy()]);
            total
        };
        (count("false"), count("true"))
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.notes.push(text.into());
    }

    /// Record a failed expectation; the scenario keeps going so the table
    /// still shows everything else it found.
    pub fn expect(&mut self, ok: bool, what: impl Into<String>) {
        if !ok {
            self.failures.push(what.into());
        }
    }

    /// Expect the join's candidate to carry `want` at `path`.
    pub fn expect_landed(&mut self, join: &Join, path: &str, want: &str) {
        match &join.candidate {
            Some(sha) => {
                let got = self.text(sha, path);
                if got != want {
                    self.failures.push(format!(
                        "{path} landed as {:?}, wanted {:?}",
                        got.trim_end(),
                        want.trim_end()
                    ));
                }
            }
            None => self
                .failures
                .push(format!("no candidate, so {path} landed nothing")),
        }
    }
}

// MARK: - Scenarios

pub struct Scenario {
    pub name: &'static str,
    pub why: &'static str,
    pub run: fn() -> Bench,
}

/// Both arcs rewrite line five of a ten-line file; nothing but a model or a
/// resolver settles it, and keep-both is the answer.
fn line_five(scribe: Scribe, resolver: bool) -> Bench {
    let mut b = Bench::new(scribe, resolver, &[("f.txt", &lines(10))]);
    b.arc("a");
    b.arc("b");
    b.round(
        "a",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
    );
    b.round(
        "b",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
    );
    b
}

fn kept_both() -> String {
    edit(&lines(10), 5, "a five\nb five")
}

fn disjoint() -> Bench {
    let mut b = Bench::new(
        Scribe::KeepBoth,
        true,
        &[("f.txt", &lines(10)), ("g.txt", "g\n")],
    );
    b.arc("a");
    b.arc("b");
    b.round("a", &[("f.txt", Edit::Write(edit(&lines(10), 1, "a one")))]);
    b.round("b", &[("g.txt", Edit::Write("g by b\n".into()))]);
    b.expect(
        b.clean_crossings + b.conflict_crossings == 0,
        "a disjoint pair is no crossing",
    );
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.conflicts.is_empty() && j.candidate.is_some(),
        "the join is clean",
    );
    b
}

fn clean_overlap() -> Bench {
    let mut b = Bench::new(Scribe::KeepBoth, true, &[("f.txt", &lines(10))]);
    b.arc("a");
    b.arc("b");
    b.round("a", &[("f.txt", Edit::Write(edit(&lines(10), 1, "a one")))]);
    b.round(
        "b",
        &[("f.txt", Edit::Write(edit(&lines(10), 9, "b nine")))],
    );
    b.expect(
        b.clean_crossings == 1 && b.conflict_crossings == 0,
        "one clean crossing",
    );
    b.land("a");
    let j = b.join("b");
    b.expect(j.conflicts.is_empty(), "the join is clean");
    b.expect_landed(
        &j,
        "f.txt",
        &edit(&edit(&lines(10), 1, "a one"), 9, "b nine"),
    );
    b
}

fn a_lands_first() -> Bench {
    let mut b = line_five(Scribe::KeepBoth, false);
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.rung("f.txt") == Some(ResolvedBy::Rerere),
        "rung 2 replays the settle",
    );
    b.expect(j.blocks == (1, 0), format!("blocks {:?}", j.blocks));
    b.expect_landed(&j, "f.txt", &kept_both());
    b
}

fn b_lands_first() -> Bench {
    let mut b = line_five(Scribe::KeepBoth, false);
    b.land("b");
    let j = b.join("a");
    b.expect(
        j.rung("f.txt") == Some(ResolvedBy::Rerere),
        "rung 2 replays the settle",
    );
    b.expect_landed(&j, "f.txt", &kept_both());
    b
}

fn resolver_finishes() -> Bench {
    let mut b = line_five(Scribe::None, true);
    b.expect(
        b.settles.last().is_some_and(|s| s.resolver == Some(Ok(()))),
        "the resolver stand-in taught the cache",
    );
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.rung("f.txt") == Some(ResolvedBy::Rerere),
        "rung 2 replays the resolver's file",
    );
    b.expect_landed(&j, "f.txt", &kept_both());
    b
}

/// A reply the clean-segment guard must refuse: it touched text outside the
/// conflict, or is not a merge at all.
fn refused_scribe(scribe: Scribe) -> Bench {
    let mut b = line_five(scribe, false);
    b.expect(
        b.settles.last().is_some_and(|s| s.unresolved == ["f.txt"]),
        "the reply is declined and nothing is taught",
    );
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.unresolved == ["f.txt"],
        "the join meets the conflict fresh",
    );
    b
}

fn prose_scribe() -> Bench {
    refused_scribe(Scribe::Prose)
}

/// A reply that keeps one side of the block and nothing else: inside the
/// conflict the choice is the model's, so the guard lets it through, and
/// what it taught is what the join replays.
fn ours_only_scribe() -> Bench {
    let mut b = line_five(Scribe::OursOnly, false);
    b.expect(
        b.settles
            .last()
            .is_some_and(|s| s.resolved == [("f.txt".to_string(), ResolvedBy::Ai)]),
        "a one-sided block is a merge the guard allows",
    );
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.rung("f.txt") == Some(ResolvedBy::Rerere),
        "and it replays",
    );
    b.expect_landed(&j, "f.txt", &edit(&lines(10), 5, "a five"));
    b.note("the guard judges nothing inside the block; one side kept is the scribe's call");
    b
}

fn reformatting_scribe() -> Bench {
    refused_scribe(Scribe::Reformats)
}

/// A file over the one-shot cap: declined by the AI rung, taught only
/// through the resolver.
fn over_cap(resolver: bool) -> Bench {
    let big = format!("{}{}", lines(10), "x".repeat(70_000));
    let mut b = Bench::new(Scribe::KeepBoth, resolver, &[("big.txt", &big)]);
    b.arc("a");
    b.arc("b");
    b.round("a", &[("big.txt", Edit::Write(edit(&big, 5, "a five")))]);
    b.round("b", &[("big.txt", Edit::Write(edit(&big, 5, "b five")))]);
    b.expect(
        b.settles
            .last()
            .is_some_and(|s| s.unresolved == ["big.txt"]),
        "the AI rung declines the file",
    );
    b.land("a");
    let j = b.join("b");
    if resolver {
        b.expect(
            j.rung("big.txt") == Some(ResolvedBy::Rerere),
            "replayed from the resolver",
        );
        b.expect_landed(&j, "big.txt", &edit(&big, 5, "a five\nb five"));
    } else {
        b.expect(j.unresolved == ["big.txt"], "the join meets it fresh");
    }
    b
}

fn over_cap_rungs_only() -> Bench {
    over_cap(false)
}

fn over_cap_with_resolver() -> Bench {
    over_cap(true)
}

/// Settle at round one, then each arc edits a line `d` away from the hunk,
/// on its own side only. Does the recorded resolution still replay?
fn drift(d: usize) -> Bench {
    let forty = lines(40);
    let mut b = Bench::new(Scribe::KeepBoth, false, &[("f.txt", &forty)]);
    b.arc("a");
    b.arc("b");
    let a1 = edit(&forty, 20, "a twenty");
    let b1 = edit(&forty, 20, "b twenty");
    b.round("a", &[("f.txt", Edit::Write(a1.clone()))]);
    b.round("b", &[("f.txt", Edit::Write(b1.clone()))]);
    let a2 = edit(&a1, 20 + d, &format!("a {}", 20 + d));
    let b2 = edit(&b1, 20 - d, &format!("b {}", 20 - d));
    b.round("a", &[("f.txt", Edit::Write(a2))]);
    b.round("b", &[("f.txt", Edit::Write(b2))]);
    // What a fresh keep-both of the final tips lands. One line away, git
    // folds the neighbours into the block and the scribe keeps both of
    // the larger block; further away they stay outside it.
    let want = b.union_at("f.txt", "tugarc/a", "tugarc/b");
    b.land("a");
    let j = b.join("b");
    let rung = j.rung("f.txt");
    b.note(format!(
        "d={d}: f.txt {} · blocks {}→{}",
        rung.map_or("unresolved", |r| r.as_str()),
        j.blocks.0,
        j.blocks.1
    ));
    if rung.is_some() {
        b.expect_landed(&j, "f.txt", &want);
    }
    b
}

fn drift_1() -> Bench {
    drift(1)
}
fn drift_2() -> Bench {
    drift(2)
}
fn drift_3() -> Bench {
    drift(3)
}
fn drift_4() -> Bench {
    drift(4)
}
fn drift_8() -> Bench {
    drift(8)
}

/// Settle at round one, then both arcs edit the same line `d` away, so a
/// second conflict stands beside the first.
fn second_hunk(d: usize) -> Bench {
    let forty = lines(40);
    let mut b = Bench::new(Scribe::KeepBoth, false, &[("f.txt", &forty)]);
    b.arc("a");
    b.arc("b");
    let a1 = edit(&forty, 20, "a twenty");
    let b1 = edit(&forty, 20, "b twenty");
    b.round("a", &[("f.txt", Edit::Write(a1.clone()))]);
    b.round("b", &[("f.txt", Edit::Write(b1.clone()))]);
    let settles_before = b.settles.len();
    b.round("a", &[("f.txt", Edit::Write(edit(&a1, 20 + d, "a again")))]);
    b.round("b", &[("f.txt", Edit::Write(edit(&b1, 20 + d, "b again")))]);
    let settled_again = b.settles.len() > settles_before;
    let want = b.union_at("f.txt", "tugarc/a", "tugarc/b");
    b.land("a");
    let j = b.join("b");
    let rung = j.rung("f.txt");
    b.note(format!(
        "d={d}: re-settled {} · join f.txt {} · blocks {}→{}",
        if settled_again { "yes" } else { "no" },
        rung.map_or("unresolved", |r| r.as_str()),
        j.blocks.0,
        j.blocks.1
    ));
    b.expect(
        rung.is_some(),
        "the second hunk was settled when it appeared",
    );
    if rung.is_some() {
        b.expect_landed(&j, "f.txt", &want);
    }
    b
}

fn second_hunk_1() -> Bench {
    second_hunk(1)
}
fn second_hunk_5() -> Bench {
    second_hunk(5)
}

fn conflict_goes_away_and_returns() -> Bench {
    let mut b = line_five(Scribe::KeepBoth, false);
    b.round("b", &[("f.txt", Edit::Write(lines(10)))]);
    b.note(format!(
        "after b reverts: {} clean, {} conflicted",
        b.clean_crossings, b.conflict_crossings
    ));
    b.round(
        "b",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
    );
    b.expect(
        b.settles
            .last()
            .is_some_and(|s| s.resolved.iter().any(|(_, by)| *by == ResolvedBy::Rerere)),
        "the returning conflict is settled from the cache, not re-taught",
    );
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.rung("f.txt") == Some(ResolvedBy::Rerere),
        "replayed at the join",
    );
    b.expect_landed(&j, "f.txt", &kept_both());
    b
}

/// Three arcs on one hunk: the pair caches each hold a two-sided answer,
/// and the third join meets a hunk no pair ever saw.
fn three_arcs() -> Bench {
    let mut b = line_five(Scribe::KeepBoth, false);
    b.arc("c");
    b.round(
        "c",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "c five")))],
    );
    b.note(format!("{} pair conflicts settled", b.conflict_crossings));
    b.land("a");
    let jb = b.join("b");
    b.expect(
        jb.rung("f.txt") == Some(ResolvedBy::Rerere),
        "b replays a·b",
    );
    let Some(candidate) = jb.candidate.clone() else {
        return b;
    };
    b.land_candidate("b", &candidate);
    let jc = b.join("c");
    b.note(format!(
        "c's join: f.txt {} · blocks {}→{}",
        jc.rung("f.txt").map_or("unresolved", |r| r.as_str()),
        jc.blocks.0,
        jc.blocks.1
    ));
    b
}

fn discarded_arc_taught_the_cache() -> Bench {
    let mut b = line_five(Scribe::KeepBoth, false);
    b.git(&["branch", "-qD", "tugarc/b"]);
    forget_crossings(&b.repo, "b");
    b.arc("c");
    b.round(
        "c",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "c five")))],
    );
    b.land("a");
    let j = b.join("c");
    b.expect(j.rung("f.txt") == Some(ResolvedBy::Rerere), "a·c replays");
    b.expect_landed(&j, "f.txt", &edit(&lines(10), 5, "a five\nc five"));
    b
}

fn rename_vs_edit() -> Bench {
    let mut b = Bench::new(Scribe::KeepBoth, true, &[("f.txt", &lines(10))]);
    b.arc("a");
    b.arc("b");
    b.round(
        "a",
        &[
            ("f.txt", Edit::Rename("h.txt")),
            ("h.txt", Edit::Write(edit(&lines(10), 5, "a five"))),
        ],
    );
    b.round(
        "b",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
    );
    b.note(format!(
        "probe saw {} clean, {} conflicted",
        b.clean_crossings, b.conflict_crossings
    ));
    b.land("a");
    let j = b.join("b");
    b.note(format!(
        "join conflicts {:?} · resolved {:?} · unresolved {:?}",
        j.conflicts, j.resolved, j.unresolved
    ));
    b.expect(
        b.conflict_crossings > 0 || j.conflicts.is_empty(),
        "a conflict the join meets was a crossing the probe saw",
    );
    b
}

fn delete_vs_modify() -> Bench {
    let mut b = Bench::new(Scribe::KeepBoth, true, &[("f.txt", &lines(10))]);
    b.arc("a");
    b.arc("b");
    b.round("a", &[("f.txt", Edit::Delete)]);
    b.round(
        "b",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
    );
    b.note(format!(
        "settle: {:?}",
        b.settles
            .last()
            .map(|s| (&s.resolved, &s.unresolved, &s.resolver))
    ));
    b.land("a");
    let j = b.join("b");
    b.note(format!(
        "join: resolved {:?} · unresolved {:?}",
        j.resolved, j.unresolved
    ));
    b
}

fn add_add() -> Bench {
    let mut b = Bench::new(Scribe::KeepBoth, true, &[("f.txt", &lines(10))]);
    b.arc("a");
    b.arc("b");
    b.round("a", &[("n.txt", Edit::Write("from a\n".into()))]);
    b.round("b", &[("n.txt", Edit::Write("from b\n".into()))]);
    b.note(format!(
        "settle: {:?}",
        b.settles
            .last()
            .map(|s| (&s.resolved, &s.unresolved, &s.resolver))
    ));
    b.land("a");
    let j = b.join("b");
    b.note(format!(
        "join: n.txt {}",
        j.rung("n.txt").map_or("unresolved", |r| r.as_str())
    ));
    if j.rung("n.txt").is_some() {
        b.expect_landed(&j, "n.txt", "from a\nfrom b\n");
    }
    b
}

fn mode_flip_vs_edit() -> Bench {
    let mut b = Bench::new(Scribe::KeepBoth, true, &[("f.txt", &lines(10))]);
    b.arc("a");
    b.arc("b");
    b.round("a", &[("f.txt", Edit::Executable)]);
    b.round(
        "b",
        &[("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
    );
    b.note(format!(
        "probe saw {} clean, {} conflicted",
        b.clean_crossings, b.conflict_crossings
    ));
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.conflicts.is_empty() && j.candidate.is_some(),
        "a mode flip merges clean",
    );
    if let Some(c) = &j.candidate {
        let mode = b.git(&["ls-tree", c, "f.txt"]);
        b.expect(mode.starts_with("100755"), format!("mode kept: {mode}"));
    }
    b
}

fn crlf() -> Bench {
    let base = lines(10).replace('\n', "\r\n");
    let mut b = Bench::new(Scribe::KeepBoth, false, &[("f.txt", &base)]);
    b.arc("a");
    b.arc("b");
    let a = base.replace("line 5\r\n", "a five\r\n");
    let bb = base.replace("line 5\r\n", "b five\r\n");
    b.round("a", &[("f.txt", Edit::Write(a))]);
    b.round("b", &[("f.txt", Edit::Write(bb))]);
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.rung("f.txt") == Some(ResolvedBy::Rerere),
        "replayed with CRLF intact",
    );
    b.expect_landed(
        &j,
        "f.txt",
        &base.replace("line 5\r\n", "a five\r\nb five\r\n"),
    );
    b
}

fn binary() -> Bench {
    let base: Vec<u8> = (0..=255u8).collect();
    let mut b = Bench::new(Scribe::KeepBoth, true, &[("blob.bin", "")]);
    std::fs::write(b.repo.join("blob.bin"), &base).unwrap();
    b.git(&["add", "-A"]);
    b.git(&["commit", "-qm", "binary base"]);
    b.arc("a");
    b.arc("b");
    let mut a = base.clone();
    a[10] = 0xAA;
    let mut bb = base.clone();
    bb[10] = 0xBB;
    b.round("a", &[("blob.bin", Edit::WriteBytes(a))]);
    b.round("b", &[("blob.bin", Edit::WriteBytes(bb))]);
    b.expect(
        b.settles.last().is_some_and(|s| s.resolved.is_empty()),
        "no rung claims a binary merge",
    );
    b.land("a");
    let j = b.join("b");
    b.expect(
        j.unresolved == ["blob.bin"],
        "the join leaves it unresolved",
    );
    b
}

/// Twenty-four interleaved rounds over three files, edits drawn from a
/// seeded generator: how much of the accumulated crossing does rung 2
/// replay at the join?
fn random_rounds(seed: u64) -> Bench {
    let files = ["x.txt", "y.txt", "z.txt"];
    let thirty = lines(30);
    let mut b = Bench::new(Scribe::KeepBoth, true, &files.map(|f| (f, thirty.as_str())));
    b.arc("a");
    b.arc("b");
    let mut state = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    let mut next = move |n: usize| {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 33) as usize) % n
    };
    let mut texts: [[String; 3]; 2] = [
        [thirty.clone(), thirty.clone(), thirty.clone()],
        [thirty.clone(), thirty.clone(), thirty.clone()],
    ];
    for round in 0..24 {
        let side = round % 2;
        let arc = ["a", "b"][side];
        let file = next(3);
        let edits = 1 + next(2);
        for _ in 0..edits {
            let line = 1 + next(30);
            texts[side][file] = edit(&texts[side][file], line, &format!("{arc} r{round} l{line}"));
        }
        b.round(
            arc,
            &[(files[file], Edit::Write(texts[side][file].clone()))],
        );
    }
    let want: Vec<(String, String)> = files
        .iter()
        .map(|f| (f.to_string(), b.union_at(f, "tugarc/a", "tugarc/b")))
        .collect();
    let taught = b
        .settles
        .iter()
        .map(|s| {
            s.resolved
                .iter()
                .filter(|(_, by)| *by != ResolvedBy::Rerere)
                .count()
        })
        .sum::<usize>();
    b.note(format!(
        "{} settles · {} files taught · {} resolver finishes",
        b.settles.len(),
        taught,
        b.settles.iter().filter(|s| s.resolver.is_some()).count()
    ));
    b.land("a");
    let j = b.join("b");
    let hits = j
        .resolved
        .iter()
        .filter(|(_, by)| *by == ResolvedBy::Rerere)
        .count();
    b.note(format!(
        "join: {} conflicted, {hits} by rung 2, {} unresolved · blocks {}→{}",
        j.conflicts.len(),
        j.unresolved.len(),
        j.blocks.0,
        j.blocks.1
    ));
    if j.candidate.is_some() {
        for (path, text) in &want {
            b.expect_landed(&j, path, text);
        }
    }
    b
}

fn random_seed_1() -> Bench {
    random_rounds(1)
}
fn random_seed_2() -> Bench {
    random_rounds(2)
}
fn random_seed_3() -> Bench {
    random_rounds(3)
}

/// Every scenario, in the order the table shows them.
pub fn scenarios() -> Vec<Scenario> {
    macro_rules! s {
        ($($name:ident => $why:literal),* $(,)?) => {
            vec![$(Scenario { name: stringify!($name), why: $why, run: $name }),*]
        };
    }
    s![
        disjoint => "no shared path: no probe, clean join",
        clean_overlap => "same file, far lines: a clean crossing, clean join",
        a_lands_first => "one hunk, keep-both scribe; a lands, b replays",
        b_lands_first => "the same, landed the other way round",
        resolver_finishes => "no scribe; the resolver stand-in teaches, b replays",
        prose_scribe => "a scribe answering in prose teaches nothing",
        ours_only_scribe => "a scribe returning its own side teaches nothing",
        reformatting_scribe => "a scribe re-indenting a clean line teaches nothing",
        over_cap_rungs_only => "a 70k file: the AI rung declines, the join meets it",
        over_cap_with_resolver => "the same, finished by the resolver stand-in",
        drift_1 => "settle, then each side edits 1 line from the hunk",
        drift_2 => "… 2 lines away",
        drift_3 => "… 3 lines away",
        drift_4 => "… 4 lines away",
        drift_8 => "… 8 lines away",
        second_hunk_1 => "settle, then a second conflict 1 line below it",
        second_hunk_5 => "… 5 lines below it",
        conflict_goes_away_and_returns => "b reverts, then re-edits the same line",
        three_arcs => "a, b, c on one hunk; c's join meets a·b's merged hunk",
        discarded_arc_taught_the_cache => "b taught a·b then was discarded; c joins after a",
        rename_vs_edit => "a renames and edits, b edits the old path",
        delete_vs_modify => "a deletes, b edits",
        add_add => "both add the same new file",
        mode_flip_vs_edit => "a flips the mode, b edits the text",
        crlf => "one hunk in a CRLF file",
        binary => "one byte differs in a binary file",
        random_seed_1 => "24 random interleaved rounds over three files",
        random_seed_2 => "… another seed",
        random_seed_3 => "… another seed",
    ]
}
