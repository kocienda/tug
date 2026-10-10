//! Fixtures shared by the `ops` test modules.

#![cfg(test)]
#![allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs

use super::*;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

pub(crate) fn porcelain_of(repo: &Path) -> String {
    git_stdout(repo, &["status", "--porcelain"]).unwrap()
}

/// Redirect `project_state_dir`'s base off the real data dir for the
/// duration of a (serial) test, so the arc log lands under `home`.
pub(crate) fn redirect_state_dir(home: &Path) {
    // SAFETY: arc tests are #[serial]; no other thread reads the
    // environment concurrently while this runs.
    unsafe {
        std::env::set_var("TUG_DATA_DIR", home);
    }
}

/// A git repo under `temp`, with the redirected project-state dir as its
/// *sibling* rather than a child, and the cwd left on it.
///
/// Production never puts project state inside a working tree. A fixture
/// that does makes every arc log write — including the birth record
/// `create` appends — read as untracked dirt in the base checkout, which
/// then shows up in dirt censuses and join preflights that have nothing to
/// do with it.
pub(crate) fn repo_beside_state(temp: &TempDir) -> std::path::PathBuf {
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    init_git_repo(&repo);
    redirect_state_dir(&temp.path().join("state"));
    std::env::set_current_dir(&repo).unwrap();
    repo
}

pub(crate) fn commit_all(path: &Path, message: &str) {
    tugcore::git_command()
        .arg("-C")
        .arg(path)
        .args(["add", "-A"])
        .output()
        .unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(path)
        .args(["commit", "-m", message])
        .output()
        .unwrap();
}

pub(crate) fn init_git_repo(path: &Path) {
    tugcore::git_command()
        .arg("-C")
        .arg(path)
        .args(["init", "-b", "main"])
        .output()
        .unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(path)
        .args(["config", "user.name", "Test User"])
        .output()
        .unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(path)
        .args(["config", "user.email", "test@example.com"])
        .output()
        .unwrap();

    // Both worktree homes, matching what a real tugtool checkout ignores —
    // the census reads untracked files with `--exclude-standard`, so a test
    // repo that did not ignore its own worktree home would report every
    // arc worktree as base dirt.
    fs::write(path.join(".gitignore"), ".tugtree/\n.tug/\n").unwrap();
    fs::create_dir_all(path.join(".tugtool")).unwrap();
    fs::write(path.join(".tugtool/.keep"), "").unwrap();

    fs::write(path.join("README.md"), "# Test\n").unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(path)
        .args(["add", "-A"])
        .output()
        .unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(path)
        .args(["commit", "-m", "Initial commit"])
        .output()
        .unwrap();
}

pub(crate) fn branch_present(repo: &Path, branch: &str) -> bool {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["branch", "--list", branch])
        .output()
        .unwrap();
    !String::from_utf8_lossy(&out.stdout).trim().is_empty()
}

pub(crate) fn run_git(repo: &Path, args: &[&str]) {
    let ok = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
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
    repo: &Path,
    name: &str,
    phase: crate::oplog::JoinPhase,
    commit_hash: &str,
) -> u64 {
    let root = fs::canonicalize(repo).unwrap();
    let before = crate::oplog::capture_before(&root, name).unwrap();
    let tips = crate::oplog::tips_of(&before);
    let seq =
        crate::oplog::record_begin(&root, crate::oplog::OpVerb::Join, name, before, &tips).unwrap();
    crate::oplog::record_join_progress(
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
    // SAFETY: serial test; see redirect_state_dir.
    unsafe {
        std::env::set_var("TUG_DATA_DIR", home);
    }
    let root = fs::canonicalize(repo).unwrap();
    tugtool_core::project_state_dir(&root).join(tugtool_core::paths::ARC_LOG)
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
    let git_dir = tugcore::git_command()
        .arg("-C")
        .arg(worktree)
        .args(["rev-parse", "--absolute-git-dir"])
        .output()
        .unwrap();
    let dir = String::from_utf8_lossy(&git_dir.stdout).trim().to_string();
    Path::new(&dir).join("index.lock")
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
    let out = tugcore::git_command()
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A plain repo with one commit and one uncommitted change — the shape
/// `commit_worktree_dirt` is handed at join time.
pub(crate) fn dirty_repo(temp: &TempDir) -> std::path::PathBuf {
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    init_git_repo(&repo);
    fs::write(repo.join("a.txt"), "base\n").unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(&repo)
        .args(["add", "-A"])
        .output()
        .unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(&repo)
        .args(["commit", "-q", "-m", "base"])
        .output()
        .unwrap();
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
    tugcore::git_command()
        .arg("-C")
        .arg(worktree)
        .args(["add", "-A"])
        .output()
        .unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(worktree)
        .args(["commit", "-q", "-m", &format!("tugarc(d): round {n}")])
        .output()
        .unwrap();
}

/// Stand up a repo with an arc whose documents home holds [`TWO_STEP_PLAN`].
/// Returns the temp dir and the canonical repo root the verbs resolve to.
pub(crate) fn stepped_arc(name: &str) -> (TempDir, std::path::PathBuf) {
    let temp = TempDir::new().unwrap();
    let repo = repo_beside_state(&temp);
    create(name, None, false, None).unwrap();

    let plan = plan_file(&repo, name);
    fs::create_dir_all(plan.parent().unwrap()).unwrap();
    fs::write(&plan, TWO_STEP_PLAN).unwrap();

    let root = fs::canonicalize(&repo).unwrap();
    (temp, root)
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
pub(crate) fn log_text(root: &Path) -> String {
    fs::read_to_string(tugtool_core::project_state_dir(root).join(tugtool_core::paths::ARC_LOG))
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
pub(crate) fn wheeled_arc(name: &str) -> (TempDir, std::path::PathBuf) {
    let (temp, root) = stepped_arc(name);
    crate::arc::append_arc_start(&root, name, &format!(".tug/arcs/{name}/plan.md")).unwrap();
    crate::arc::append_arc_stage(&root, name, crate::arc::ArcStage::Implement, "sess-1", None)
        .unwrap();
    step_start(name, 1, 1).unwrap();
    fs::write(worktree_path(&root, name).join("one.txt"), "first\n").unwrap();
    commit(name, "r1", None).unwrap();
    step_done(name, 1, None).unwrap();
    (temp, root)
}

/// A repo with no arc yet.
pub(crate) fn repo_for_create() -> (TempDir, std::path::PathBuf) {
    let temp = TempDir::new().unwrap();
    let repo = repo_beside_state(&temp);
    let root = fs::canonicalize(&repo).unwrap();
    (temp, root)
}

pub(crate) fn dirt_entry<'a>(out: &'a CreateOutcome, path: &str) -> &'a BaseDirtPath {
    out.base_dirt
        .iter()
        .find(|d| d.path == path)
        .unwrap_or_else(|| panic!("{path} not censused: {:?}", out.base_dirt))
}

/// Pin the repo universe for the rest of this test's process.
pub(crate) fn set_universe(path: &Path) {
    // SAFETY: serial test under nextest; see redirect_state_dir.
    unsafe {
        std::env::set_var(tugtool_core::REPO_UNIVERSE_ENV, path);
    }
}

/// A scratch base checkout on `main` plus a linked worktree on `feature`
/// that is itself the universe — the shape an app-test run has, where the
/// worktree is the project the instance under test has open.
///
/// Returns `(base, universe)`, both canonicalized so they compare equal to
/// what the resolver returns, with the cwd left on the universe.
pub(crate) fn base_with_universe(temp: &TempDir) -> (std::path::PathBuf, std::path::PathBuf) {
    let base = temp.path().join("base");
    fs::create_dir_all(&base).unwrap();
    init_git_repo(&base);
    redirect_state_dir(&temp.path().join("state"));
    let universe = temp.path().join("universe");
    run_git(
        &base,
        &[
            "worktree",
            "add",
            universe.to_str().unwrap(),
            "-b",
            "feature",
        ],
    );
    set_universe(&universe);
    std::env::set_current_dir(&universe).unwrap();
    (
        fs::canonicalize(&base).unwrap(),
        fs::canonicalize(&universe).unwrap(),
    )
}

/// The commit a revision names, as a full sha.
pub(crate) fn rev_parse_at(repo: &Path, rev: &str) -> String {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", rev])
        .output()
        .unwrap();
    assert!(out.status.success(), "git rev-parse {rev} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Seed a repo with one commit and an arc carrying one round, returning the
/// repo path's owner so it outlives the call. The shared fixture for the
/// preview-blocker tests ([P02]).
pub(crate) fn seed_arc_with_a_round(temp: &TempDir, name: &str) {
    let repo = temp.path();
    init_git_repo(repo);
    redirect_state_dir(&temp.path().join("state"));
    std::env::set_current_dir(repo).unwrap();
    fs::write(repo.join("shared.txt"), "base\n").unwrap();
    git_output(repo, &["add", "."]).unwrap();
    git_output(repo, &["commit", "-m", "seed"]).unwrap();
    create(name, None, false, None).unwrap();
    let worktree = repo.join(".tug/worktrees").join(name);
    fs::write(worktree.join("shared.txt"), "base\narc change\n").unwrap();
    commit(name, "touch shared", None).unwrap();
}

pub(crate) fn preview(name: &str) -> JoinOutcome {
    join(
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

/// Point the draft reader at an empty tempdir path for the duration of a
/// (serial) test, so a message composition never reads — or is coloured by —
/// the live machine ledger.
pub(crate) fn isolate_changes_db(temp: &TempDir) {
    // SAFETY: these tests are #[serial]; no other thread reads the
    // environment concurrently while this runs.
    unsafe {
        std::env::set_var("TUG_CHANGES_DB", temp.path().join("changes.db"));
    }
}

/// Seed a draft row directly into the isolated ledger, bootstrapping the
/// table the way every writer does. `project` is taken verbatim, which is
/// what lets a test reproduce a pre-fix worktree-keyed row.
pub(crate) fn seed_draft_row(db: &Path, owner_id: &str, project: &Path, message: &str) {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS changeset_drafts (
            owner_kind   TEXT NOT NULL,
            owner_id     TEXT NOT NULL,
            project_dir  TEXT NOT NULL,
            fingerprint  TEXT NOT NULL,
            message      TEXT NOT NULL,
            updated_at   INTEGER NOT NULL,
            edited       INTEGER NOT NULL DEFAULT 0,
            selection    TEXT,
            PRIMARY KEY (owner_kind, owner_id, project_dir)
        );",
    )
    .unwrap();
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
pub(crate) fn open_arc_fixture() -> (TempDir, TempDir) {
    let home = tempfile::tempdir().expect("tempdir");
    redirect_state_dir(home.path());
    (home, tempfile::tempdir().expect("tempdir"))
}

/// Write one of an arc's documents into its own documents home.
pub(crate) fn write_arc_document(root: &Path, arc: &str, file: &str) {
    let dir = root.join(".tug").join("arcs").join(arc);
    fs::create_dir_all(&dir).expect("documents dir");
    fs::write(dir.join(file), "# Fixture\n").expect("write document");
}

pub(crate) fn checked_out_branch(repo: &Path) -> String {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repo with one plain arc and no documents anywhere.
pub(crate) fn plain_arc(name: &str) -> (TempDir, std::path::PathBuf) {
    let temp = TempDir::new().unwrap();
    let repo = repo_beside_state(&temp);
    create(name, None, false, None).unwrap();
    let root = fs::canonicalize(&repo).unwrap();
    (temp, root)
}

/// A repository with no `.gitignore` at all, which is what makes the
/// exclusion in `create` load-bearing rather than incidental.
pub(crate) fn bare_repo_beside_state(temp: &TempDir) -> std::path::PathBuf {
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Test User"],
        vec!["config", "user.email", "test@example.com"],
    ] {
        tugcore::git_command()
            .arg("-C")
            .arg(&repo)
            .args(&args)
            .output()
            .unwrap();
    }
    fs::create_dir_all(repo.join(".tugtool")).unwrap();
    fs::write(repo.join(".tugtool/.keep"), "").unwrap();
    fs::write(repo.join("README.md"), "# Test\n").unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(&repo)
        .args(["add", "-A"])
        .output()
        .unwrap();
    tugcore::git_command()
        .arg("-C")
        .arg(&repo)
        .args(["commit", "-m", "init"])
        .output()
        .unwrap();
    redirect_state_dir(&temp.path().join("state"));
    std::env::set_current_dir(&repo).unwrap();
    repo
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
pub(crate) fn ops_for(repo: &Path, name: &str) -> Vec<crate::oplog::OpPayload> {
    let root = std::fs::canonicalize(repo).unwrap();
    crate::oplog::list_ops(&root)
        .into_iter()
        .filter(|op| op.arc == name && op.verb == crate::oplog::OpVerb::Join)
        .collect()
}

/// Park a real conflict chain on `name` by making the base and the arc
/// edit the same line, then running the ladder until it gives up.
///
/// Real rather than synthetic because `read_conflict` parses the record out
/// of the root commit's message: a hand-made ref is not a chain.
pub(crate) fn park_conflict(repo: &Path, name: &str) -> String {
    let worktree = worktree_path(repo, name);
    fs::write(worktree.join("shared.txt"), "base\narc side\n").unwrap();
    commit(name, "arc edits shared", None).unwrap();
    fs::write(repo.join("shared.txt"), "base\nbase side\n").unwrap();
    git_output(repo, &["add", "."]).unwrap();
    git_output(repo, &["commit", "-m", "base edits shared"]).unwrap();

    let outcome = crate::resolve::resolve_conflicts(repo, name, None).unwrap();
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
pub(crate) fn lease_a_parked_conflict(repo: &Path, name: &str) -> String {
    park_conflict(repo, name);
    crate::resolve::mark_resolve_begun(repo, name).expect("the begin marker lands")
}

/// Helper: a fresh repo with an arc carrying one commit that adds `f.txt`.
pub(crate) fn repo_with_committed_arc(name: &str) -> (TempDir, std::path::PathBuf) {
    let temp = TempDir::new().unwrap();
    let repo = fs::canonicalize(temp.path()).unwrap();
    init_git_repo(&repo);
    redirect_state_dir(&temp.path().join("state"));
    std::env::set_current_dir(&repo).unwrap();
    create(name, None, false, None).unwrap();
    let worktree = repo.join(format!(".tug/worktrees/{name}"));
    fs::write(worktree.join("f.txt"), "arc\n").unwrap();
    commit(name, &format!("{name}-only"), None).unwrap();
    (temp, repo)
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
pub(crate) fn seed_arc_that_adds_files(temp: &TempDir, name: &str) {
    seed_arc_with_a_round(temp, name);
    let worktree = temp.path().join(".tug/worktrees").join(name);
    fs::write(worktree.join("added.txt"), "new in the arc\n").unwrap();
    fs::create_dir_all(worktree.join("nested")).unwrap();
    fs::write(worktree.join("nested/extra.txt"), "also new\n").unwrap();
    commit(name, "add files", None).unwrap();
}
