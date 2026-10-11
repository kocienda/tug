//! Fixtures shared by the `ops` test modules.

#![cfg(test)]

use super::*;
use std::fs;
use std::path::Path;
use tempfile::TempDir;
use tugcore::instance::Paths;
pub(crate) use tugcore::test_fixtures::git::{GitFixture, git};

pub(crate) fn porcelain_of(repo: &Path) -> String {
    git_stdout(repo, &["status", "--porcelain"]).unwrap()
}

/// The instance paths a test hands the engine, rooted at `home`, so the arc
/// log and every ledger land there rather than in the real data dir.
///
/// The engine takes its paths as a parameter, so nothing here touches the
/// process environment and no test serializes on it.
#[must_use = "the paths are the redirect: pass them to the engine"]
pub(crate) fn redirect_state_dir(home: &Path) -> Paths {
    Paths::under(home)
}

/// Paths under a fresh scratch directory, for a test whose repo has no
/// fixture-made home of its own. The directory lives as long as the guard.
pub(crate) fn scratch_paths() -> (TempDir, Paths) {
    let home = TempDir::new().unwrap();
    let paths = Paths::under(home.path());
    (home, paths)
}

/// A git repo under `temp`, with the redirected project-state dir as its
/// *sibling* rather than a child.
///
/// Production never puts project state inside a working tree. A fixture
/// that does makes every arc log write — including the birth record
/// `create` appends — read as untracked dirt in the base checkout, which
/// then shows up in dirt censuses and join preflights that have nothing to
/// do with it.
pub(crate) fn repo_beside_state(temp: &TempDir) -> (std::path::PathBuf, Paths) {
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    init_git_repo(&repo);
    let paths = redirect_state_dir(&temp.path().join("state"));
    (repo, paths)
}

pub(crate) fn commit_all(path: &Path, message: &str) {
    git(path, &["add", "-A"]);
    git(path, &["commit", "-m", message]);
}

pub(crate) fn init_git_repo(path: &Path) {
    GitFixture::init(path);

    // Both worktree homes, matching what a real tugtool checkout ignores —
    // the census reads untracked files with `--exclude-standard`, so a test
    // repo that did not ignore its own worktree home would report every
    // arc worktree as base dirt.
    fs::write(path.join(".gitignore"), ".tugtree/\n.tug/\n").unwrap();
    fs::create_dir_all(path.join(".tugtool")).unwrap();
    fs::write(path.join(".tugtool/.keep"), "").unwrap();

    fs::write(path.join("README.md"), "# Test\n").unwrap();
    git(path, &["add", "-A"]);
    git(path, &["commit", "-m", "Initial commit"]);
}

pub(crate) fn branch_present(repo: &Path, branch: &str) -> bool {
    !git(repo, &["branch", "--list", branch]).trim().is_empty()
}

/// Join options for a test whose subject is the join's **mechanics** — the
/// squash, the teardown, the draft, the record.
///
/// Nothing but the defaults, since verification left the join: these
/// options carried an `anyway: true` for as long as a gate stood between a
/// join and the base, and there is no gate left to name.
pub(crate) fn mechanics() -> JoinOptions {
    JoinOptions::default()
}

/// Seed a join interrupted at `phase`, through the real code path: capture,
/// record, attach progress. Never a hand-written payload — a fixture that
/// spelled the record itself would stop testing the writer.
pub(crate) fn seed_interrupted_join(
    paths: &Paths,
    repo: &Path,
    name: &str,
    phase: crate::oplog::JoinPhase,
    commit_hash: &str,
) -> u64 {
    let root = fs::canonicalize(repo).unwrap();
    let before = crate::oplog::capture_before(&root, name).unwrap();
    let tips = crate::oplog::tips_of(&before);
    let seq = crate::oplog::record_begin(
        paths,
        &root,
        crate::oplog::OpVerb::Join,
        name,
        before,
        &tips,
    )
    .unwrap();
    crate::oplog::record_join_progress(
        paths,
        &root,
        seq,
        crate::oplog::JoinProgress {
            phase,
            commit_hash: commit_hash.to_string(),
            strategy: "squash".to_string(),
            message: None,
        },
    )
    .unwrap();
    seq
}

/// Path the arc log is written to for `repo`, given the redirected base.
///
/// Canonicalizes `repo` to match `find_repo_root()`, which resolves the cwd
/// (e.g. `/var/...` → `/private/var/...` on macOS) — the slug must agree.
pub(crate) fn arc_log_path(home: &Path, repo: &Path) -> std::path::PathBuf {
    let root = fs::canonicalize(repo).unwrap();
    tugtool_core::paths::project_state_dir_at(&Paths::under(home), &root)
        .join(tugtool_core::paths::ARC_LOG)
}

/// Write a `.tugtool/config.toml` with the given post_create commands.
pub(crate) fn write_config(path: &Path, post_create: &[&str]) {
    let cmds = post_create
        .iter()
        .map(|c| format!("\"{}\"", c))
        .collect::<Vec<_>>()
        .join(", ");
    fs::write(
        path.join(".tugtool/config.toml"),
        format!("[tugtool.arc]\npost_create = [{}]\n", cmds),
    )
    .unwrap();
}

/// A skeleton-valid plan with two ledger rows, for the step verbs to drive.
pub(crate) const TWO_STEP_PLAN: &str = r#"## A Two Step Plan {#two-step-plan}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | Someone |

### Phase Overview {#phase-overview}

Some context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The first step | pending | — |
| #step-2 | The second step | pending | — |

#### Step 1: The first step {#step-1}

**Commit:** `thing(scope): first`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the first thing.

**Tests:**
- [ ] Unit: the first thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

#### Step 2: The second step {#step-2}

**Commit:** `thing(scope): second`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the second thing.

**Tests:**
- [ ] Unit: the second thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the thing.
"#;

/// The index lock's real path for a worktree, which is inside the
/// worktree's own git dir — for a linked worktree that is
/// `…/.git/worktrees/<name>/`, not a `.git` directory beside the files.
pub(crate) fn index_lock_path(worktree: &Path) -> std::path::PathBuf {
    let dir = git(worktree, &["rev-parse", "--absolute-git-dir"]);
    Path::new(dir.trim()).join("index.lock")
}

/// Take the index lock and release it after `hold`.
///
/// The releasing thread does nothing else — it is a clock, not a second
/// writer — so the call under test is the only process touching the index
/// and the outcome cannot depend on an interleaving.
pub(crate) fn hold_index_lock(
    worktree: &Path,
    hold: std::time::Duration,
) -> std::thread::JoinHandle<()> {
    let lock = index_lock_path(worktree);
    fs::write(&lock, b"").unwrap();
    std::thread::spawn(move || {
        std::thread::sleep(hold);
        let _ = fs::remove_file(&lock);
    })
}

pub(crate) fn head_sha(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

/// A plain repo with one commit and one uncommitted change — the shape
/// `commit_worktree_dirt` is handed at join time.
pub(crate) fn dirty_repo(temp: &TempDir) -> std::path::PathBuf {
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    init_git_repo(&repo);
    fs::write(repo.join("a.txt"), "base\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "base"]);
    fs::write(repo.join("a.txt"), "dirty\n").unwrap();
    repo
}

/// Commit one authored round in an arc worktree, the way a run does.
pub(crate) fn author_round(worktree: &Path, n: u32) {
    fs::write(
        worktree.join(format!("round{n}.txt")),
        format!("work {n}\n"),
    )
    .unwrap();
    git(worktree, &["add", "-A"]);
    git(
        worktree,
        &["commit", "-q", "-m", &format!("tugarc(d): round {n}")],
    );
}

/// Stand up a repo with an arc whose documents home holds [`TWO_STEP_PLAN`].
/// Returns the temp dir and the canonical repo root the verbs resolve to.
pub(crate) fn stepped_arc(name: &str) -> (TempDir, std::path::PathBuf, Paths) {
    let temp = TempDir::new().unwrap();
    let (repo, paths) = repo_beside_state(&temp);
    create_in(&paths, &repo, name, None, false, None).unwrap();

    let plan = plan_file(&repo, name);
    fs::create_dir_all(plan.parent().unwrap()).unwrap();
    fs::write(&plan, TWO_STEP_PLAN).unwrap();

    let root = fs::canonicalize(&repo).unwrap();
    (temp, root, paths)
}

/// The arc worktree's current commit, short — a sha `step done --commit`
/// will accept, because it is one that exists.
pub(crate) fn worktree_head(root: &Path, name: &str) -> String {
    git_stdout(
        &worktree_path(root, name),
        &["rev-parse", "--short", "HEAD"],
    )
    .unwrap()
}

/// The project's whole arc log, as text.
pub(crate) fn log_text(paths: &Paths, root: &Path) -> String {
    fs::read_to_string(
        tugtool_core::paths::project_state_dir_at(paths, root).join(tugtool_core::paths::ARC_LOG),
    )
    .unwrap_or_default()
}

/// The ledger row for `anchor`, as the plan on disk now reads.
pub(crate) fn ledger_row(root: &Path, name: &str, anchor: &str) -> tugtool_core::plan::LedgerRow {
    let source = fs::read_to_string(plan_file(root, name)).unwrap();
    tugtool_core::plan::parse(&source)
        .unwrap()
        .ledger_rows
        .into_iter()
        .find(|r| r.anchor == anchor)
        .unwrap_or_else(|| panic!("no row for #{anchor}"))
}

/// A finished one-step run with an arc record over it — a live wheel
/// seated in `implement`, which is where an arc is when its run ends and
/// its audit has not started.
pub(crate) fn wheeled_arc(name: &str) -> (TempDir, std::path::PathBuf, Paths) {
    let (temp, root, paths) = stepped_arc(name);
    crate::arc::append_arc_start(&paths, &root, name, &format!(".tug/arcs/{name}/plan.md"))
        .unwrap();
    crate::arc::append_arc_stage(
        &paths,
        &root,
        name,
        crate::arc::ArcStage::Implement,
        "sess-1",
        None,
    )
    .unwrap();
    step_start_in(&paths, &root, name, 1, 1).unwrap();
    fs::write(worktree_path(&root, name).join("one.txt"), "first\n").unwrap();
    commit_in(&paths, &root, name, "r1", None, None).unwrap();
    step_done_in(&paths, &root, name, 1, None).unwrap();
    (temp, root, paths)
}

/// A repo with no arc yet.
pub(crate) fn repo_for_create() -> (TempDir, std::path::PathBuf, Paths) {
    let temp = TempDir::new().unwrap();
    let (repo, paths) = repo_beside_state(&temp);
    let root = fs::canonicalize(&repo).unwrap();
    (temp, root, paths)
}

pub(crate) fn dirt_entry<'a>(out: &'a CreateOutcome, path: &str) -> &'a BaseDirtPath {
    out.base_dirt
        .iter()
        .find(|d| d.path == path)
        .unwrap_or_else(|| panic!("{path} not censused: {:?}", out.base_dirt))
}

/// Pin the repo universe until the returned guard drops.
///
/// The guard is the point: under `cargo test` every test shares one process,
/// and a universe left pinned after its temp dir is gone makes every later
/// test resolve its root against a path that no longer exists.
#[must_use = "the universe is unpinned when the guard drops"]
pub(crate) fn set_universe(path: &Path) -> UniverseGuard {
    // SAFETY: every caller is `#[serial(tug_repo_universe)]` — the
    // resolver takes the boundary from the environment alone — and nextest
    // runs each test in its own process besides.
    unsafe {
        std::env::set_var(tugtool_core::REPO_UNIVERSE_ENV, path);
    }
    UniverseGuard
}

/// Unpins the repo universe on drop, including when the test panics.
pub(crate) struct UniverseGuard;

impl Drop for UniverseGuard {
    fn drop(&mut self) {
        // SAFETY: see `set_universe`.
        unsafe {
            std::env::remove_var(tugtool_core::REPO_UNIVERSE_ENV);
        }
    }
}

/// A scratch base checkout on `main` plus a linked worktree on `feature`
/// that is itself the universe — the shape an app-test run has, where the
/// worktree is the project the instance under test has open.
///
/// Returns `(base, universe, guard, paths)`, the two paths canonicalized so
/// they compare equal to what the resolver returns; the universe stays
/// pinned while `guard` lives.
pub(crate) fn base_with_universe(
    temp: &TempDir,
) -> (std::path::PathBuf, std::path::PathBuf, UniverseGuard, Paths) {
    let base = temp.path().join("base");
    fs::create_dir_all(&base).unwrap();
    init_git_repo(&base);
    let paths = redirect_state_dir(&temp.path().join("state"));
    let universe = temp.path().join("universe");
    git(
        &base,
        &[
            "worktree",
            "add",
            universe.to_str().unwrap(),
            "-b",
            "feature",
        ],
    );
    let guard = set_universe(&universe);
    (
        fs::canonicalize(&base).unwrap(),
        fs::canonicalize(&universe).unwrap(),
        guard,
        paths,
    )
}

/// The commit a revision names, as a full sha.
pub(crate) fn rev_parse_at(repo: &Path, rev: &str) -> String {
    git(repo, &["rev-parse", rev]).trim().to_string()
}

/// Seed a repo with one commit and an arc carrying one round, returning the
/// paths its arc state lives under. The shared fixture for the
/// preview-blocker tests ([P02]).
pub(crate) fn seed_arc_with_a_round(temp: &TempDir, name: &str) -> Paths {
    let repo = temp.path();
    init_git_repo(repo);
    let paths = redirect_state_dir(&temp.path().join("state"));
    fs::write(repo.join("shared.txt"), "base\n").unwrap();
    git_output(repo, &["add", "."]).unwrap();
    git_output(repo, &["commit", "-m", "seed"]).unwrap();
    create_in(&paths, repo, name, None, false, None).unwrap();
    let worktree = repo.join(".tug/worktrees").join(name);
    fs::write(worktree.join("shared.txt"), "base\narc change\n").unwrap();
    commit_in(&paths, repo, name, "touch shared", None, None).unwrap();
    paths
}

/// A join preview of `name` against `root`, unwrapped.
pub(crate) fn preview_in(paths: &Paths, root: &Path, name: &str) -> JoinOutcome {
    join_in(
        paths,
        root,
        name,
        JoinOptions {
            preview: true,
            ..mechanics()
        },
    )
    .unwrap()
}

pub(crate) fn blocker<'a>(outcome: &'a JoinOutcome, kind: &str) -> Option<&'a JoinBlocker> {
    outcome.blockers.iter().find(|b| b.kind == kind)
}

/// Point the draft reader at an empty tempdir path, so a message
/// composition never reads — or is coloured by — the live machine ledger.
pub(crate) fn isolate_changes_db(paths: &mut Paths, temp: &TempDir) {
    paths.changes_db = temp.path().join("changes.db");
}

/// Seed a draft row directly into the isolated ledger, bootstrapping the
/// schema through the one bootstrap every writer runs. `project` is taken
/// verbatim, which is what lets a test reproduce a pre-fix worktree-keyed row.
pub(crate) fn seed_draft_row(db: &Path, owner_id: &str, project: &Path, message: &str) {
    let conn = tugcore::changes_schema::open(db).unwrap();
    tugcore::changes_schema::bootstrap(&conn).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO changeset_drafts \
         (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited) \
         VALUES ('arc', ?1, ?2, '', ?3, 0, 1)",
        rusqlite::params![owner_id, project.to_string_lossy(), message],
    )
    .unwrap();
}

pub(crate) fn canonical(p: &Path) -> std::path::PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// A temp home for the arc log and a temp repo to open arcs in, with no
/// git and no instance — `open_arc` reads documents off disk and writes
/// log lines, and neither needs a checkout.
pub(crate) fn open_arc_fixture() -> (TempDir, TempDir, Paths) {
    let home = tempfile::tempdir().expect("tempdir");
    let paths = redirect_state_dir(home.path());
    (home, tempfile::tempdir().expect("tempdir"), paths)
}

/// Write one of an arc's documents into its own documents home.
pub(crate) fn write_arc_document(root: &Path, arc: &str, file: &str) {
    let dir = root.join(".tug").join("arcs").join(arc);
    fs::create_dir_all(&dir).expect("documents dir");
    fs::write(dir.join(file), "# Fixture\n").expect("write document");
}

pub(crate) fn checked_out_branch(repo: &Path) -> String {
    git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .trim()
        .to_string()
}

/// A repo with one plain arc and no documents anywhere.
pub(crate) fn plain_arc(name: &str) -> (TempDir, std::path::PathBuf, Paths) {
    let temp = TempDir::new().unwrap();
    let (repo, paths) = repo_beside_state(&temp);
    create_in(&paths, &repo, name, None, false, None).unwrap();
    let root = fs::canonicalize(&repo).unwrap();
    (temp, root, paths)
}

/// A repository with no `.gitignore` at all, which is what makes the
/// exclusion in `create` load-bearing rather than incidental.
pub(crate) fn bare_repo_beside_state(temp: &TempDir) -> (std::path::PathBuf, Paths) {
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    GitFixture::init(&repo);
    fs::create_dir_all(repo.join(".tugtool")).unwrap();
    fs::write(repo.join(".tugtool/.keep"), "").unwrap();
    fs::write(repo.join("README.md"), "# Test\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-m", "init"]);
    let paths = redirect_state_dir(&temp.path().join("state"));
    (repo, paths)
}

/// The fingerprint helper the no-hand-back tests measure with: every
/// tracked and untracked file under the base checkout, by path and by
/// content.
///
/// "Byte-identical" is the criterion [P09] is written against, so the
/// assertion has to read bytes rather than a git status — a hand-back that
/// copied a file in and a hand-back that deleted one are both invisible to
/// a status the discard itself could have reset.
pub(crate) fn base_fingerprint(root: &Path) -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            // `.git` holds the discard's own bookkeeping, and `.tug` holds
            // the worktrees being torn down; neither is the user's content.
            if name == ".git" || name == ".tug" {
                continue;
            }
            if path.is_dir() {
                walk(&path, root, out);
            } else if let Ok(text) = fs::read_to_string(&path) {
                out.push((path.strip_prefix(root).unwrap().display().to_string(), text));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

/// Every join op recorded for `name`, read from the canonical repo root the
/// state dir is slugged from.
pub(crate) fn ops_for(paths: &Paths, repo: &Path, name: &str) -> Vec<crate::oplog::OpPayload> {
    let root = std::fs::canonicalize(repo).unwrap();
    crate::oplog::list_ops(paths, &root)
        .into_iter()
        .filter(|op| op.arc == name && op.verb == crate::oplog::OpVerb::Join)
        .collect()
}

/// Park a real conflict chain on `name` by making the base and the arc
/// edit the same line, then running the ladder until it gives up.
///
/// Real rather than synthetic because `read_conflict` parses the record out
/// of the root commit's message: a hand-made ref is not a chain.
pub(crate) fn park_conflict(paths: &Paths, repo: &Path, name: &str) -> String {
    let worktree = worktree_path(repo, name);
    fs::write(worktree.join("shared.txt"), "base\narc side\n").unwrap();
    commit_in(paths, repo, name, "arc edits shared", None, None).unwrap();
    fs::write(repo.join("shared.txt"), "base\nbase side\n").unwrap();
    git_output(repo, &["add", "."]).unwrap();
    git_output(repo, &["commit", "-m", "base edits shared"]).unwrap();

    let outcome = crate::resolve::resolve_conflicts(paths, repo, name, None).unwrap();
    assert_eq!(
        outcome.unresolved,
        vec!["shared.txt".to_string()],
        "the fixture must actually conflict"
    );
    crate::resolve::read_conflict(repo, name)
        .expect("a chain stands")
        .tip
}

/// Carry a parked conflict to the state a join actually meets: a resolver
/// has committed a checkpoint and settled the file, so a candidate stands
/// and the chain holds work worth keeping. Returns the chain tip.
pub(crate) fn resolve_parked_conflict(repo: &Path, name: &str) -> (String, String) {
    let ws = crate::workshop::Workshop::open_conflict(repo, name).unwrap();
    fs::write(ws.path().join("shared.txt"), "base\nboth sides\n").unwrap();
    ws.checkpoint("resolve shared.txt")
        .expect("the checkpoint lands");
    let tip = crate::resolve::read_conflict(repo, name)
        .expect("the chain advanced")
        .tip;
    // `Workshop::commit` builds the candidate; anchoring it and recording
    // which arc head it was resolved against is what makes the join see
    // it, and both are the resolver's job in the live flow.
    let candidate = ws.commit("resolved").expect("the candidate commits");
    crate::resolve::write_candidate_ref(repo, name, &candidate).unwrap();
    let arc_head = git_stdout(repo, &["rev-parse", &branch_name(name)]).unwrap();
    git_output(
        repo,
        &[
            "config",
            &crate::resolve::join_source_config_key(name),
            &arc_head,
        ],
    )
    .unwrap();
    (tip, candidate)
}

// ---- the resolve lease ([P03], [P04]) ----

/// A chain a resolver has opened but not finished — the state a second
/// process must be able to read.
pub(crate) fn lease_a_parked_conflict(paths: &Paths, repo: &Path, name: &str) -> String {
    park_conflict(paths, repo, name);
    crate::resolve::mark_resolve_begun(repo, name).expect("the begin marker lands")
}

/// Helper: a fresh repo with an arc carrying one commit that adds `f.txt`.
pub(crate) fn repo_with_committed_arc(name: &str) -> (TempDir, std::path::PathBuf, Paths) {
    let temp = TempDir::new().unwrap();
    let repo = fs::canonicalize(temp.path()).unwrap();
    init_git_repo(&repo);
    let paths = redirect_state_dir(&temp.path().join("state"));
    create_in(&paths, &repo, name, None, false, None).unwrap();
    let worktree = repo.join(format!(".tug/worktrees/{name}"));
    fs::write(worktree.join("f.txt"), "arc\n").unwrap();
    commit_in(&paths, &repo, name, &format!("{name}-only"), None, None).unwrap();
    (temp, repo, paths)
}

/// What a failed landing must leave exactly as it found it.
pub(crate) fn base_snapshot(
    repo: &Path,
    files: &[&str],
) -> (String, String, String, Vec<Vec<u8>>, bool) {
    let git_dir = git_stdout(repo, &["rev-parse", "--absolute-git-dir"]).unwrap();
    (
        git_stdout(repo, &["rev-parse", "HEAD"]).unwrap(),
        git_stdout(repo, &["ls-files", "--stage"]).unwrap(),
        git_stdout(repo, &["status", "--porcelain"]).unwrap(),
        files
            .iter()
            .map(|f| fs::read(repo.join(f)).unwrap())
            .collect(),
        Path::new(&git_dir).join("SQUASH_MSG").exists(),
    )
}

/// An arc that edits one file and adds two — the shape whose base copies
/// come in all three index states.
pub(crate) fn seed_arc_that_adds_files(temp: &TempDir, name: &str) -> Paths {
    let paths = seed_arc_with_a_round(temp, name);
    let worktree = temp.path().join(".tug/worktrees").join(name);
    fs::write(worktree.join("added.txt"), "new in the arc\n").unwrap();
    fs::create_dir_all(worktree.join("nested")).unwrap();
    fs::write(worktree.join("nested/extra.txt"), "also new\n").unwrap();
    commit_in(&paths, temp.path(), name, "add files", None, None).unwrap();
    paths
}
