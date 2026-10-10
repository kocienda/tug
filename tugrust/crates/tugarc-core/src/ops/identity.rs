//! Where an arc lives and what it is called: the branch namespace, the worktree
//! home and its legacy migration, worktree teardown, the branch-config keys, and
//! the minted `tugid` behind every owner key.

use std::path::{Path, PathBuf};
use tugtool_core::error::TugError;
use tugtool_core::sanitize_branch_name;

use super::git::{config_get, git_output, git_stdout};
use super::listing::has_uncommitted;
use super::main_repo_root;
use crate::error::ArcError;
use crate::log::detect_default_branch;

/// The one place an arc's branch namespace is spelled. `branch_name` mints
/// from it, and every `for-each-ref` that enumerates arcs reads it.
pub(crate) const BRANCH_PREFIX: &str = "tugarc/";

/// The namespace arcs were minted under before this build, kept as a **read**
/// for life: `migrate_branch_prefix` is the one thing that names it, and it
/// names it to move a branch off it.
const LEGACY_BRANCH_PREFIX: &str = "tugdash/";

pub(crate) fn branch_name(name: &str) -> String {
    format!("{BRANCH_PREFIX}{name}")
}

/// The current worktree home: `<repo>/.tug/worktrees/<sanitized-name>` ([P13]).
pub(super) fn new_worktree_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".tug")
        .join("worktrees")
        .join(sanitize_branch_name(name))
}

/// The pre-migration worktree home: `<repo>/.tugtree/tugdash__<sanitized-name>`.
///
/// Still operated against for an arc that hasn't (or can't) migrate yet. The
/// retired spelling is deliberate and permanent: this is a **read** of what an
/// older build wrote, and the directory it names never changes its name.
fn old_worktree_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".tugtree")
        .join(format!("tugdash__{}", sanitize_branch_name(name)))
}

/// The effective worktree path for an arc: the new `.tug/worktrees/` home when
/// it exists (created there, or migrated), else the legacy `.tugtree/` path when
/// that still holds it, else the new home (the creation target). So every verb
/// operates on wherever the worktree actually is, migrated or not.
///
/// Public because the wheel's opening prompt names it: the `where` clause hands
/// a stage its worktree so it need not probe for one, and a caller that
/// reconstructed the path itself would be reconstructing the legacy fallback
/// too — the one thing here that is a filesystem question rather than a
/// formatting rule.
pub fn worktree_path(repo: &Path, name: &str) -> PathBuf {
    let new = new_worktree_path(repo, name);
    if new.exists() {
        return new;
    }
    let old = old_worktree_path(repo, name);
    if old.exists() {
        return old;
    }
    new
}

/// Move every `tugarc/<name>` branch to `tugarc/<name>` ([P02], [B13]).
///
/// Runs at the top of every verb, immediately before [`migrate_worktrees`], so
/// the worktree pass enumerates a namespace that has already settled. One-shot
/// and idempotent: a repository with no legacy branches does nothing and a
/// second run finds nothing to do.
///
/// `git branch -m` is what makes this a rename rather than a rebuild — it moves
/// the whole `branch.<old>.*` config section (all four keys: `tugbase`,
/// `description`, `laidby`, `tugid`) and repoints the HEAD of any worktree
/// checked out on the branch, leaving that worktree's path, index, and
/// untracked files untouched.
///
/// A name that already exists under **both** prefixes is left entirely alone
/// and warned about by name (Risk R01): nothing here deletes a branch, so the
/// orphan stays visible in `git branch` until a person resolves it. Every git
/// failure is a warning and never fatal — a verb that cannot rename still runs.
fn migrate_branch_prefix(repo: &Path, warnings: &mut Vec<String>) {
    let Ok(branches) = git_stdout(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            &format!("refs/heads/{LEGACY_BRANCH_PREFIX}"),
        ],
    ) else {
        return;
    };

    for legacy in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = legacy.trim_start_matches(LEGACY_BRANCH_PREFIX);
        let current = branch_name(name);
        if branch_exists(repo, &current) {
            warnings.push(format!(
                "arc '{name}': both {legacy} and {current} branches exist; left as is"
            ));
            continue;
        }
        if let Err(e) = git_output(repo, &["branch", "-m", legacy, &current]) {
            warnings.push(format!("arc '{name}': could not rename {legacy}: {e}"));
        }
    }
}

/// The top-of-verb git reconciliation, in the order the two passes need: the
/// branch namespace settles first, then the worktrees under it.
pub(super) fn reconcile_branches(repo: &Path, warnings: &mut Vec<String>) {
    migrate_branch_prefix(repo, warnings);
    migrate_worktrees(repo, warnings);
}

/// Migrate legacy `.tugtree/` worktrees to `.tug/worktrees/` ([P13], Risk table).
///
/// Runs at the top of every verb. For each `tugarc/*` branch whose worktree
/// still sits under `.tugtree/` (and isn't already at the new home),
/// `git worktree move`s it when it is SAFE — the worktree is clean and no live
/// instance's app is holding it (a `git worktree move` while an app runs from
/// the dir would strand the app's cwd). Otherwise it warns once and leaves the
/// worktree where it is; the effective `worktree_path` keeps operating on the
/// old location. Best-effort: any git failure is a warning, never fatal.
fn migrate_worktrees(repo: &Path, warnings: &mut Vec<String>) {
    let Ok(branches) = git_stdout(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            &format!("refs/heads/{BRANCH_PREFIX}"),
        ],
    ) else {
        return;
    };

    for branch in branches.lines().filter(|l| !l.trim().is_empty()) {
        let name = branch.trim_start_matches(BRANCH_PREFIX);
        let old = old_worktree_path(repo, name);
        let new = new_worktree_path(repo, name);
        if !old.exists() || new.exists() {
            continue;
        }

        // Gate 1: only a clean worktree migrates — uncommitted work stays put.
        let dirty = has_uncommitted(&old).unwrap_or(true);
        if dirty {
            warnings.push(format!(
                "arc '{}': worktree has uncommitted changes; left at .tugtree (not migrated to .tug/worktrees)",
                name
            ));
            continue;
        }

        // Gate 2: no live instance app holding the dir (reap-slug identity math).
        if arc_instance_live(branch) {
            warnings.push(format!(
                "arc '{}': a live instance holds the worktree; left at .tugtree (not migrated)",
                name
            ));
            continue;
        }

        if let Some(parent) = new.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let moved = git_output(
            repo,
            &[
                "worktree",
                "move",
                &old.to_string_lossy(),
                &new.to_string_lossy(),
            ],
        );
        match moved {
            Ok(o) if !o.status.success() => warnings.push(format!(
                "arc '{}': git worktree move failed; left at .tugtree: {}",
                name,
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => warnings.push(format!(
                "arc '{}': git worktree move failed; left at .tugtree: {}",
                name, e
            )),
            _ => {}
        }
    }
}

/// Whether either the debug or release instance app for `branch` is live (a
/// `cc-<profile>-<slug>` tmux session), so migration doesn't move a worktree out
/// from under a running app. Mirrors `reap_arc_tmux`'s identity math, but
/// non-destructive.
fn arc_instance_live(branch: &str) -> bool {
    let slug = branch_slug(branch);
    ["debug", "release"]
        .iter()
        .any(|profile| tugcore::instance::instance_tmux_live(&format!("{profile}-{slug}")))
}

pub fn branch_exists(repo: &Path, branch: &str) -> bool {
    git_stdout(repo, &["branch", "--list", branch])
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Whether the repo holds a **record** of this arc — which is the `tugid`,
/// not the branch ref ([P01]).
///
/// The distinction is not pedantry. An arc binds an arc *before* its branch
/// exists (`ensure_arc_id` needs no branch), and a teardown removes the ref
/// and the config entry together, so "either one is present" is exactly the
/// set of arcs that exist. tugcast's `live_arc_records` reached this shape
/// first, when a branch-only gate was found nulling valid bindings; this is
/// the same question asked on the tugtool side, so the two agree about which
/// arcs are real.
///
/// Verbs that need the arc's *worktree* — `commit`, the step verbs — still
/// check for it separately, because a pre-branch arc has no tree to work in.
/// This predicate is for the verbs that only need the arc to be a thing:
/// `mark` declares into the log, which a pre-branch arc has every right to do.
pub fn arc_record_exists(repo: &Path, name: &str) -> bool {
    branch_exists(repo, &branch_name(name)) || config_get(repo, &tugid_config_key(name)).is_some()
}

/// Canonical bundle-id branch slug — mirrors `scripts/branch-slug.sh`
/// (lowercase; every run of non-`[a-z0-9]` collapses to a single `-`;
/// trim leading/trailing `-`). This is the slug `assign-bundle-id.sh`
/// folds into the per-worktree instance ID, so it lets us reconstruct
/// the tmux identity a removed arc's app used. NOTE: distinct from
/// `sanitize_branch_name` (which names the worktree *directory* and maps
/// `/` → `__`).
fn branch_slug(branch: &str) -> String {
    let mut out = String::new();
    let mut prev_arc = false;
    for c in branch.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_arc = false;
        } else if !prev_arc {
            out.push('-');
            prev_arc = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Tear down the tmux server/session a removed arc worktree's app left
/// behind. An arc worktree builds the cwd-derived `<profile>-<branch-slug>`
/// identity; its tugcast created a `cc-<id>` session on that instance's
/// private `tug-<token>` server (or, for pre-isolation builds, the shared
/// default server). The arc's profile isn't recorded, so reap both
/// debug and release identities via the shared instance reaper.
fn reap_arc_tmux(branch: &str) {
    let slug = branch_slug(branch);
    for profile in ["debug", "release"] {
        tugcore::instance::reap_instance_tmux(&format!("{profile}-{slug}"));
    }
}

/// Tear down an arc's worktree robustly, always leaving the directory gone.
///
/// An arc's live app/vite dev server keeps files open inside the worktree.
/// On a mounted filesystem, removing a file that a process still holds open
/// leaves a silly-rename placeholder, so the parent `rmdir` fails with
/// "Directory not empty" — and `git worktree remove` strands a half-removed
/// worktree on disk (the exact failure `arc join` used to hit). To avoid it:
///   1. reap the arc's tmux server/app *first*, so nothing holds files open;
///   2. `--force` so gitignored build artifacts never block git's removal;
///   3. fall back to a direct filesystem wipe when git bails, retrying a few
///      times because reaped processes release their handles asynchronously;
///   4. `git worktree prune` to clear git's now-stale administrative entry.
///
/// A warning is pushed only if the directory truly survives all of that.
pub(super) fn remove_arc_worktree(
    repo: &Path,
    branch: &str,
    worktree: &Path,
    warnings: &mut Vec<String>,
) {
    const ATTEMPTS: u32 = 5;

    reap_arc_tmux(branch);

    if !worktree.exists() {
        return;
    }

    for attempt in 0..ATTEMPTS {
        let _ = git_output(
            repo,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        );
        if worktree.exists() {
            let _ = std::fs::remove_dir_all(worktree);
        }
        if !worktree.exists() {
            break;
        }
        if attempt + 1 < ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    let _ = git_output(repo, &["worktree", "prune"]);

    if worktree.exists() {
        warnings.push(format!("Failed to remove worktree: {}", worktree.display()));
    }
}

/// The four branch-config keys an arc carries, each spelled in exactly one
/// place.
///
/// Every one of them hangs off `branch.tugarc/<name>.`, built from the **raw**
/// arc name — not the sanitized spelling `worktree_path` uses for directories.
/// They were previously composed inline at five call sites in three different
/// forms, which is one typo away from an arc that silently forgets its base.
pub(crate) fn base_config_key(name: &str) -> String {
    format!("branch.{}.tugbase", branch_name(name))
}

pub(crate) fn description_config_key(name: &str) -> String {
    format!("branch.{}.description", branch_name(name))
}

/// Who laid this arc down, when it was not a person: `<kind>/<name>` for an
/// agent's work tier ([P15]). Absent on every arc a person created, which
/// is what makes its presence mean something.
pub(crate) fn laid_by_config_key(name: &str) -> String {
    format!("branch.{}.laidby", branch_name(name))
}

/// Stamp an arc's provenance. Written beside the description because it is the
/// same kind of fact and dies with the same branch.
pub fn set_laid_by(repo_root: &Path, name: &str, by: &str) {
    let repo_root = main_repo_root(repo_root);
    let _ = git_output(&repo_root, &["config", &laid_by_config_key(name), by]);
}

/// Read an arc's provenance, or `None` for one a person laid.
pub fn laid_by(repo_root: &Path, name: &str) -> Option<String> {
    config_get(&main_repo_root(repo_root), &laid_by_config_key(name))
}

/// Resolve an arc's base branch: git config first ([P03]), else detection.
pub(crate) fn arc_base(repo: &Path, name: &str) -> Result<String, ArcError> {
    if let Some(base) = config_get(repo, &base_config_key(name)) {
        return Ok(base);
    }
    detect_default_branch(repo).map_err(base_detection_error)
}

/// Default-branch detection's failures by cause: its one refusal — no
/// `origin/HEAD`, no `main`, no `master` — is a sentence naming the branches
/// there are; a git it could not run is git's.
pub(super) fn base_detection_error(e: TugError) -> ArcError {
    match e {
        TugError::BaseBranchNotFound { .. } => ArcError::Refused(e.to_string()),
        other => ArcError::git(
            "",
            &["branch", "--format=%(refname:short)"],
            other.to_string(),
        ),
    }
}

// --- arc identity ---------------------------------------------------------

/// An arc's creation id lives in its branch config, beside `tugbase`.
pub(crate) fn tugid_config_key(name: &str) -> String {
    format!("branch.{}.tugid", branch_name(name))
}

/// Mint a fresh `tugid`: unix-millis plus a 6-hex-char nonce ([P01]). Millis
/// sort chronologically; the nonce keeps two mints in the same millisecond
/// apart without any coordination.
fn mint_tugid() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut nonce = [0u8; 3];
    rand::fill(&mut nonce);
    format!("{millis}-{:02x}{:02x}{:02x}", nonce[0], nonce[1], nonce[2])
}

/// An arc's **owner key** — the identity every ledger row keys by: draft rows'
/// `owner_id`, the sessions table's `arc_id`, and the snapshot entry's
/// `owner_id` ([P01]).
///
/// `tugarc/<name>#<tugid>` when the arc has a creation id, else the bare
/// branch ref `tugarc/<name>` — the legacy identity, byte-identical to the
/// keys every pre-id build wrote.
///
/// **Read this before any teardown.** `git branch -D` deletes the branch's
/// whole config section, `tugid` included, so a key resolved after a
/// `join_in`/`discard_in` returns can only ever be the legacy form — and every
/// id-keyed row it should have swept becomes unnameable ([P05], Risk R02).
pub fn arc_owner_key(repo: &Path, name: &str) -> String {
    let branch = branch_name(name);
    match config_get(repo, &tugid_config_key(name)) {
        Some(id) => format!("{branch}#{id}"),
        None => branch,
    }
}

/// The owner key for an arc, minting its `tugid` when it has none ([P01]).
///
/// Only **write-path** verbs call this — `create`, `commit`, and the
/// `/api/arc` bind handler ([P02]). Read paths use [`arc_owner_key`], which
/// never mints: a read that wrote config would make every feed recompute a
/// side-effecting multi-process race, and two racing mints would fork an arc's
/// identity (Risk R01).
pub fn ensure_arc_id(repo: &Path, name: &str) -> Result<String, ArcError> {
    let branch = branch_name(name);
    if let Some(id) = config_get(repo, &tugid_config_key(name)) {
        return Ok(format!("{branch}#{id}"));
    }
    let id = mint_tugid();
    let out = git_output(repo, &["config", &tugid_config_key(name), &id])?;
    if !out.status.success() {
        return Err(ArcError::git(
            format!("failed to record arc id for {name}"),
            &["config", &tugid_config_key(name), &id],
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(format!("{branch}#{id}"))
}

/// The legacy (pre-id) form of an owner key: everything before the `#`. A `#`
/// cannot appear in a branch ref, so the split is unambiguous, and a key that
/// is already legacy passes through unchanged.
pub fn legacy_owner_key(owner_key: &str) -> &str {
    match owner_key.split_once('#') {
        Some((branch, _)) => branch,
        None => owner_key,
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn branch_slug_matches_canonical_bundle_id_slug() {
        // Mirrors scripts/branch-slug.sh: lowercase, non-alnum runs → '-',
        // trimmed. These reconstruct the per-worktree instance ID that
        // `assign-bundle-id.sh` stamps, so `reap_arc_tmux` targets the
        // exact tmux identity a removed arc's app used.
        assert_eq!(branch_slug("tugarc/kbd-model"), "tugarc-kbd-model");
        assert_eq!(branch_slug("tugarc/Focus_Gallery"), "tugarc-focus-gallery");
        assert_eq!(branch_slug("tugarc/a--b"), "tugarc-a-b");
        assert_eq!(branch_slug("tugarc/trailing-"), "tugarc-trailing");
        // The reconstructed debug session name matches what tugcast creates
        // (`cc-<instance-id>`), e.g. the leaked `cc-debug-tugarc-kbd-model`.
        let id = format!("debug-{}", branch_slug("tugarc/kbd-model"));
        assert_eq!(id, "debug-tugarc-kbd-model");
    }

    #[test]
    fn legacy_owner_key_strips_the_id_and_passes_legacy_keys_through() {
        assert_eq!(
            legacy_owner_key("tugarc/x#1723500000000-a1b2c3"),
            "tugarc/x"
        );
        assert_eq!(legacy_owner_key("tugarc/x"), "tugarc/x");
        // A name with an arc in it is not a split point — only `#` is.
        assert_eq!(legacy_owner_key("tugarc/fix-join#1-abc"), "tugarc/fix-join");
    }

    #[test]
    fn minted_ids_are_millis_arc_six_hex_and_do_not_repeat() {
        let a = mint_tugid();
        let b = mint_tugid();
        assert_ne!(a, b, "the nonce keeps same-millisecond mints apart");
        let (millis, nonce) = a.split_once('-').expect("millis-nonce shape");
        assert!(millis.parse::<u128>().unwrap() > 0);
        assert_eq!(nonce.len(), 6);
        assert!(
            nonce
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }

    /// `create` mints once and every later touch reports the same identity;
    /// an arc with no `tugid` reads under its legacy branch-ref key until a
    /// write verb backfills it ([P01], [P02], Risk R01).
    #[serial]
    #[test]
    fn test_arc_id_minted_once_and_backfilled_on_write() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        let first = create("id-arc", None, false, None).unwrap();
        let id = first.id.clone().expect("create mints an id");
        assert!(id.starts_with("tugarc/id-arc#"), "owner key shape: {id}");

        // The idempotent revisit reports the same identity, not a fresh mint.
        let second = create("id-arc", None, false, None).unwrap();
        assert!(!second.created);
        assert_eq!(second.id.as_deref(), Some(id.as_str()));

        // Every read verb agrees.
        assert_eq!(arc_owner_key(repo, "id-arc"), id);
        assert_eq!(show("id-arc").unwrap().id.as_deref(), Some(id.as_str()));
        let listed = list().unwrap();
        let entry = listed.iter().find(|d| d.name == "id-arc").unwrap();
        assert_eq!(entry.id.as_deref(), Some(id.as_str()));

        // An id-less arc (an older build's) reads under the legacy key, and a
        // read verb must not mint one ([P02]).
        run_git(repo, &["config", "--unset", "branch.tugarc/id-arc.tugid"]);
        assert_eq!(arc_owner_key(repo, "id-arc"), "tugarc/id-arc");
        let _ = show("id-arc").unwrap();
        assert_eq!(arc_owner_key(repo, "id-arc"), "tugarc/id-arc");

        // A round is a write path: it backfills.
        fs::write(repo.join(".tug/worktrees/id-arc/f.txt"), "x\n").unwrap();
        commit("id-arc", "Add f", None).unwrap();
        let backfilled = arc_owner_key(repo, "id-arc");
        assert!(backfilled.starts_with("tugarc/id-arc#"));
        assert_ne!(
            backfilled, id,
            "the backfill is a fresh mint, not the old id"
        );
    }

    /// Regression: when git's own `worktree remove` refuses (in production, a
    /// mounted-filesystem "Directory not empty" caused by the arc's app still
    /// holding files open; here, a `git worktree lock` that single-`--force`
    /// won't override), `remove_arc_worktree` must still leave the directory
    /// gone via its filesystem-wipe fallback — no stranded worktree, no
    /// warning. This drives the real fallback code path on real files.
    #[serial]
    #[test]
    fn test_remove_arc_worktree_fallback_when_git_refuses() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", None, false, None).unwrap();
        let branch = branch_name("test-arc");
        let worktree = worktree_path(repo, "test-arc");
        assert!(worktree.exists());

        // Lock the worktree so `git worktree remove --force` (single -f)
        // refuses, standing in for the mount-level rmdir failure production
        // hits. Only the filesystem fallback can clear it.
        git_output(repo, &["worktree", "lock", &worktree.to_string_lossy()]).unwrap();
        assert!(
            !git_output(
                repo,
                &["worktree", "remove", "--force", &worktree.to_string_lossy()]
            )
            .unwrap()
            .status
            .success(),
            "precondition: git must refuse to remove the locked worktree"
        );
        assert!(worktree.exists(), "precondition: worktree still present");

        let mut warnings = Vec::new();
        remove_arc_worktree(repo, &branch, &worktree, &mut warnings);

        assert!(!worktree.exists(), "fallback must remove the directory");
        assert!(
            warnings.is_empty(),
            "no warning when the directory is gone: {warnings:?}"
        );
    }

    /// A clean legacy `.tugtree/` worktree migrates to `.tug/worktrees/` on the
    /// next tugarc command; a dirty one stays put and still operates from its
    /// old path ([P13], migration risk mitigation).
    #[serial]
    #[test]
    fn test_legacy_worktree_migrates_but_dirty_stays() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        // Stand up two legacy-layout arcs by hand, as pre-migration builds did.
        for name in ["clean", "dirty"] {
            let old = repo.join(format!(".tugtree/tugdash__{name}"));
            let branch = format!("tugarc/{name}");
            assert!(
                git_output(
                    repo,
                    &[
                        "worktree",
                        "add",
                        &old.to_string_lossy(),
                        "-b",
                        &branch,
                        "main"
                    ]
                )
                .unwrap()
                .status
                .success()
            );
            git_output(
                repo,
                &["config", &format!("branch.{branch}.tugbase"), "main"],
            )
            .unwrap();
        }
        fs::write(repo.join(".tugtree/tugdash__dirty/scratch.txt"), "wip\n").unwrap();

        // A single list() runs the migration pass.
        list().unwrap();

        // Clean legacy arc moved to the new home; dirty one stayed at .tugtree.
        assert!(
            repo.join(".tug/worktrees/clean").exists(),
            "clean arc migrated"
        );
        assert!(
            !repo.join(".tugtree/tugdash__clean").exists(),
            "old clean path gone"
        );
        assert!(
            repo.join(".tugtree/tugdash__dirty").exists(),
            "dirty arc stays at .tugtree"
        );
        assert!(
            !repo.join(".tug/worktrees/dirty").exists(),
            "dirty arc did not migrate"
        );

        // The dirty arc still operates from its old path — commit works on it.
        let out = commit("dirty", "wip: scratch", None).unwrap();
        assert!(out.committed, "commit operates on the un-migrated worktree");
    }

    /// **The branch prefix migrates once, and moves nothing but the name.**
    ///
    /// `git branch -m` is doing the work, and what makes it the right verb is
    /// everything it carries along: the whole `branch.<old>.*` config section —
    /// all four keys — and the HEAD of any worktree checked out on the branch.
    /// So the assertions are about what did *not* move: worktree paths, HEADs,
    /// index and untracked state, and the four config values under their new
    /// key. The second `list()` is the idempotence claim, made byte-for-byte
    /// against `for-each-ref` and `config --list` rather than by re-reading a
    /// few keys, because "changed nothing" is stronger than "still right".
    #[serial]
    #[test]
    fn test_branch_prefix_migrates_once_and_carries_everything() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        // Two arcs under the retired prefix, standing where a pre-rename build
        // left them: a worktree apiece and all four config keys set.
        for name in ["clean", "dirty"] {
            let legacy = format!("tugdash/{name}");
            let wt = repo.join(format!(".tug/worktrees/{name}"));
            run_git(
                repo,
                &[
                    "worktree",
                    "add",
                    &wt.to_string_lossy(),
                    "-b",
                    &legacy,
                    "main",
                ],
            );
            for (key, value) in [
                ("tugbase", "main"),
                ("description", "the description"),
                ("laidby", "agent/ci"),
                ("tugid", "1723500000000-a1b2c3"),
            ] {
                run_git(repo, &["config", &format!("branch.{legacy}.{key}"), value]);
            }
        }
        // The dirty one carries work no rename is allowed to disturb.
        let dirty_wt = repo.join(".tug/worktrees/dirty");
        fs::write(dirty_wt.join("staged.txt"), "staged\n").unwrap();
        run_git(&dirty_wt, &["add", "staged.txt"]);
        fs::write(dirty_wt.join("untracked.txt"), "untracked\n").unwrap();

        let heads_before: Vec<String> = ["clean", "dirty"]
            .iter()
            .map(|n| {
                git_stdout(
                    &repo.join(format!(".tug/worktrees/{n}")),
                    &["rev-parse", "HEAD"],
                )
                .unwrap()
            })
            .collect();
        let status_before: Vec<String> = ["clean", "dirty"]
            .iter()
            .map(|n| {
                git_stdout(
                    &repo.join(format!(".tug/worktrees/{n}")),
                    &["status", "--porcelain"],
                )
                .unwrap()
            })
            .collect();
        // The paths only: the `branch` line in this output is *supposed* to
        // move, and that it does is the repoint this whole test is about.
        let worktree_paths = |repo: &Path| -> Vec<String> {
            git_stdout(repo, &["worktree", "list", "--porcelain"])
                .unwrap()
                .lines()
                .filter(|l| l.starts_with("worktree "))
                .map(str::to_owned)
                .collect()
        };
        let worktrees_before = worktree_paths(repo);

        // Any verb runs the pass; `list` is the cheapest.
        list().unwrap();

        // The namespace moved, wholesale.
        for name in ["clean", "dirty"] {
            assert!(
                branch_present(repo, &format!("tugarc/{name}")),
                "{name} minted"
            );
            assert!(
                !branch_present(repo, &format!("tugdash/{name}")),
                "{name} left the retired namespace"
            );
            for (key, want) in [
                ("tugbase", "main"),
                ("description", "the description"),
                ("laidby", "agent/ci"),
                ("tugid", "1723500000000-a1b2c3"),
            ] {
                assert_eq!(
                    config_get(repo, &format!("branch.tugarc/{name}.{key}")).as_deref(),
                    Some(want),
                    "the {key} key rode the rename"
                );
                assert!(
                    config_get(repo, &format!("branch.tugdash/{name}.{key}")).is_none(),
                    "and nothing was left behind under the old key"
                );
            }
        }

        // And the worktrees did not.
        assert_eq!(
            worktree_paths(repo),
            worktrees_before,
            "every worktree kept its path"
        );
        for (i, name) in ["clean", "dirty"].iter().enumerate() {
            let wt = repo.join(format!(".tug/worktrees/{name}"));
            assert_eq!(
                git_stdout(&wt, &["rev-parse", "HEAD"]).unwrap(),
                heads_before[i],
                "{name} kept its HEAD"
            );
            assert_eq!(
                git_stdout(&wt, &["status", "--porcelain"]).unwrap(),
                status_before[i],
                "{name} kept its index and untracked files"
            );
        }
        assert!(dirty_wt.join("untracked.txt").exists());

        // Idempotent: a second pass finds nothing to do and changes nothing.
        let refs_after = git_stdout(repo, &["for-each-ref", "--format=%(refname)"]).unwrap();
        let config_after = git_stdout(repo, &["config", "--list"]).unwrap();
        list().unwrap();
        assert_eq!(
            git_stdout(repo, &["for-each-ref", "--format=%(refname)"]).unwrap(),
            refs_after,
            "the second run moved no ref"
        );
        assert_eq!(
            git_stdout(repo, &["config", "--list"]).unwrap(),
            config_after,
            "and wrote no config"
        );
    }

    /// **A name under both prefixes is left alone and named** (Risk R01).
    ///
    /// Nothing here deletes a branch, so the orphan stays visible in `git
    /// branch` until a person resolves it — which is the whole point: the two
    /// branches may hold different work, and a migration is not the place to
    /// decide which one somebody meant.
    #[serial]
    #[test]
    fn test_branch_prefix_clash_leaves_both_and_warns() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        run_git(repo, &["branch", "tugdash/clash", "main"]);
        run_git(repo, &["branch", "tugarc/clash", "main"]);
        run_git(repo, &["config", "branch.tugarc/clash.tugbase", "main"]);

        let mut warnings = Vec::new();
        migrate_branch_prefix(repo, &mut warnings);

        assert!(branch_present(repo, "tugdash/clash"), "the orphan survives");
        assert!(branch_present(repo, "tugarc/clash"), "and so does the arc");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("clash"),
            "the warning names the arc: {}",
            warnings[0]
        );
    }

    /// The seat is the doctor's fifth record. An arc past devise whose
    /// worktree is gone is named, `--repair` makes the seat through the same
    /// idempotent `create_in` the dispatch calls, and the finding clears;
    /// a name with no arc behind it is refused rather than called healthy.
    #[serial]
    #[test]
    fn the_doctor_finds_a_missing_seat_and_repair_makes_it() {
        let (_temp, root) = stepped_arc("seat-arc");
        crate::arc::append_arc_start(&root, "seat-arc", ".tug/arcs/seat-arc/plan.md").unwrap();
        crate::arc::append_arc_stage(
            &root,
            "seat-arc",
            crate::arc::ArcStage::Implement,
            "s1",
            None,
        )
        .unwrap();

        let seat_findings = |root: &Path| -> Vec<String> {
            crate::doctor::diagnose(root, "seat-arc")
                .findings
                .into_iter()
                .filter(|f| f.code == "seat-missing")
                .map(|f| f.sentence)
                .collect()
        };

        // A seat that stands is quiet.
        assert!(seat_findings(&root).is_empty());

        // The worktree deleted by hand — or never made, which read the same.
        let worktree = worktree_path(&root, "seat-arc");
        run_git(
            &root,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        );
        assert!(!worktree.exists());

        let found = seat_findings(&root);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(
            found[0].contains("implement stage") && found[0].contains("does not exist"),
            "the sentence names the stage and the missing record: {}",
            found[0]
        );
        let finding = crate::doctor::diagnose(&root, "seat-arc")
            .findings
            .into_iter()
            .find(|f| f.code == "seat-missing")
            .unwrap();
        assert!(
            matches!(
                finding.repair,
                Some(crate::doctor::ArcRepair::MakeSeat { .. })
            ),
            "a branch with no rounds is safe to rebuild: {:?}",
            finding.repair
        );

        // `--repair` makes the seat, and the record clears.
        let outcome = crate::doctor::doctor(&root, "seat-arc", true).unwrap();
        assert_eq!(outcome.made, vec![worktree.to_string_lossy().into_owned()]);
        assert!(worktree.is_dir());
        assert_eq!(
            git_stdout(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            branch_name("seat-arc")
        );
        assert!(seat_findings(&root).is_empty());

        // A worktree parked on some other branch is a seat no round may use,
        // and not one the doctor rebuilds.
        run_git(&worktree, &["checkout", "-b", "somewhere-else"]);
        let found = crate::doctor::diagnose(&root, "seat-arc")
            .findings
            .into_iter()
            .filter(|f| f.code == "seat-missing")
            .collect::<Vec<_>>();
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(
            found[0].sentence.contains("somewhere-else"),
            "{}",
            found[0].sentence
        );
        assert!(found[0].repair.is_none());

        // A name nobody opened is not an arc whose records agree.
        let err = crate::doctor::doctor(&root, "nobody", false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("no arc named `nobody`"), "{err}");
    }

    /// A devise-stage arc is owed no seat, so a missing one is not a finding.
    #[serial]
    #[test]
    fn a_devise_stage_arc_with_no_seat_is_quiet() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        let root = fs::canonicalize(&repo).unwrap();
        crate::arc::append_arc_start(&root, "devising", ".tug/arcs/devising/brief.md").unwrap();
        crate::arc::append_arc_stage(&root, "devising", crate::arc::ArcStage::Devise, "s1", None)
            .unwrap();
        assert!(!worktree_path(&root, "devising").exists());
        assert!(
            crate::doctor::diagnose(&root, "devising")
                .findings
                .iter()
                .all(|f| f.code != "seat-missing"),
        );
        // And the doctor knows the arc by its log alone.
        crate::doctor::doctor(&root, "devising", false).unwrap();
    }
}
