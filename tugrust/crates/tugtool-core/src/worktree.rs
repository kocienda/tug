//! Git repository-root resolution and branch-name sanitization.
//!
//! The plan-worktree lifecycle (create/list/cleanup/discover) was retired
//! along with the `tugtool worktree` / `merge` CLI commands. What remains are
//! the small git helpers the surviving `arc` flow still uses.

use crate::error::TugError;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolve the main repository root, even when CWD is inside a linked worktree.
///
/// Uses `std::env::current_dir()` as the starting point. For explicit path control,
/// use `find_repo_root_from()`.
pub fn find_repo_root() -> Result<PathBuf, TugError> {
    let cwd = std::env::current_dir().map_err(|e| TugError::WorktreeCreationFailed {
        reason: format!("failed to get current directory: {}", e),
    })?;
    find_repo_root_from(&cwd)
}

/// Names the checkout that owns this process's repo universe.
///
/// See [`find_repo_root_from`] for the resolution rule this gates.
pub const REPO_UNIVERSE_ENV: &str = "TUG_REPO_UNIVERSE";

/// The universe root, when one is set and `start` lies inside it.
///
/// `Ok(None)` means the boundary does not apply — either no universe is set,
/// or `start` is somewhere else entirely (a scratch repo under `/tmp` resolves
/// by the ordinary rules even while a universe is pinned). A universe that
/// names a path that is missing or holds no `.git` is a misconfiguration of
/// the process, so it is an error regardless of where `start` points: a
/// boundary nobody can see is a boundary nobody can debug.
fn universe_root_for(start: &Path) -> Result<Option<PathBuf>, TugError> {
    let raw = match std::env::var(REPO_UNIVERSE_ENV) {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => return Ok(None),
    };

    let universe = std::fs::canonicalize(&raw).map_err(|e| TugError::RepoUniverseInvalid {
        value: raw.clone(),
        reason: format!("cannot be resolved: {}", e),
    })?;
    if !universe.join(".git").exists() {
        return Err(TugError::RepoUniverseInvalid {
            value: raw,
            reason: "holds no .git — it is not a checkout".to_string(),
        });
    }

    // A path that does not exist yet cannot be canonicalized; compare what we
    // were given rather than refusing, since the caller may be asking about a
    // directory it is about to create.
    let resolved_start = std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
    if resolved_start.starts_with(&universe) {
        Ok(Some(universe))
    } else {
        Ok(None)
    }
}

/// Resolve the main repository root from a given starting path.
///
/// When [`REPO_UNIVERSE_ENV`] is set and `start` lies inside (or is) that
/// universe, the universe root is the answer and no hop happens. The check
/// precedes any `.git` inspection because the hop below is precisely what it
/// overrides: a linked worktree that is *itself* the project an instance has
/// open owns its own arc state, and hopping to the checkout that happens to
/// hold the common dir would put the verbs in a different universe from the
/// app calling them.
///
/// Otherwise, and always when no universe is set:
/// if `start` has a `.git` directory, it is the main repo root;
/// if `start` has a `.git` file (linked worktree), resolves to the main repo
/// via `git rev-parse --path-format=absolute --git-common-dir`.
/// Returns `TugError::NotAGitRepository` if no `.git` is found.
pub fn find_repo_root_from(start: &Path) -> Result<PathBuf, TugError> {
    if let Some(universe) = universe_root_for(start)? {
        return Ok(universe);
    }

    let git_path = start.join(".git");

    // If .git is a directory, we're in the main repo
    if git_path.is_dir() {
        return Ok(start.to_path_buf());
    }

    // If .git is a file, we're in a linked worktree -- resolve to main repo
    if git_path.is_file() {
        let output = Command::new("git")
            .arg("-C")
            .arg(start)
            .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .output()
            .map_err(|e| TugError::WorktreeCreationFailed {
                reason: format!("failed to resolve main repo root: {}", e),
            })?;

        if output.status.success() {
            let common_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let common_path = PathBuf::from(&common_dir);
            if let Some(parent) = common_path.parent() {
                return Ok(parent.to_path_buf());
            }
        }
    }

    // No .git found -- return NotAGitRepository
    Err(TugError::NotAGitRepository)
}

/// Sanitize branch name for filesystem-safe directory name per D08
///
/// Replaces problematic characters to create a valid directory name:
/// - '/' -> '__' (git path separators)
/// - '\\' -> '__' (Windows path separators)
/// - ':' -> '_' (Windows drive letters)
/// - ' ' -> '_' (shell escaping)
/// - Filters to alphanumeric, '-', and '_' only
///
/// Returns "tugplan-worktree" as defensive fallback if result is empty.
pub fn sanitize_branch_name(branch_name: &str) -> String {
    let sanitized: String = branch_name
        .replace(['/', '\\'], "__")
        .replace([':', ' '], "_")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();

    if sanitized.is_empty() {
        "tugplan-worktree".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use tempfile::TempDir;

    /// The universe tests below set a process-global environment variable.
    /// That is safe here only because the workspace runs its tests under
    /// `cargo nextest`, which executes one process per test — a sibling test
    /// cannot observe what one of these sets. The guard restores the previous
    /// value anyway, so a shared-process runner sees no leak either.
    struct UniverseGuard(Option<OsString>);

    impl UniverseGuard {
        fn set(value: Option<&Path>) -> Self {
            let guard = Self(std::env::var_os(REPO_UNIVERSE_ENV));
            unsafe {
                match value {
                    Some(path) => std::env::set_var(REPO_UNIVERSE_ENV, path),
                    None => std::env::remove_var(REPO_UNIVERSE_ENV),
                }
            }
            guard
        }
    }

    impl Drop for UniverseGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.0 {
                    Some(value) => std::env::set_var(REPO_UNIVERSE_ENV, value),
                    None => std::env::remove_var(REPO_UNIVERSE_ENV),
                }
            }
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap_or_else(|e| panic!("git {:?} failed to spawn: {}", args, e));
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A scratch checkout on `main` plus a linked worktree on `feature`,
    /// returned as `(temp, base, worktree)`.
    fn repo_with_linked_worktree() -> (TempDir, PathBuf, PathBuf) {
        let temp = TempDir::new().unwrap();
        let base = temp.path().join("base");
        std::fs::create_dir(&base).unwrap();
        git(&base, &["init", "-b", "main"]);
        git(&base, &["config", "user.email", "test@example.com"]);
        git(&base, &["config", "user.name", "Test"]);
        git(&base, &["commit", "--allow-empty", "-m", "root"]);
        let worktree = temp.path().join("wt");
        git(
            &base,
            &[
                "worktree",
                "add",
                worktree.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );
        (temp, base, worktree)
    }

    #[test]
    fn test_find_repo_root_from_linked_worktree_hops_when_unscoped() {
        let _guard = UniverseGuard::set(None);
        let (_temp, base, worktree) = repo_with_linked_worktree();

        assert!(
            worktree.join(".git").is_file(),
            "expected a linked worktree"
        );
        let resolved = find_repo_root_from(&worktree).expect("hop should resolve");
        assert_eq!(
            std::fs::canonicalize(resolved).unwrap(),
            std::fs::canonicalize(&base).unwrap(),
            "with no universe set, a linked worktree resolves to the checkout that owns it"
        );
    }

    #[test]
    fn test_universe_scopes_a_linked_worktree_to_itself() {
        let (_temp, base, worktree) = repo_with_linked_worktree();
        let _guard = UniverseGuard::set(Some(&worktree));

        let resolved = find_repo_root_from(&worktree).expect("universe should resolve");
        assert_eq!(
            resolved,
            std::fs::canonicalize(&worktree).unwrap(),
            "a scoped worktree owns itself and does not hop"
        );
        assert_ne!(resolved, std::fs::canonicalize(&base).unwrap());
    }

    #[test]
    fn test_universe_scopes_paths_nested_beneath_it() {
        let (_temp, _base, worktree) = repo_with_linked_worktree();
        let nested = worktree.join(".tug/worktrees/fixture");
        std::fs::create_dir_all(&nested).unwrap();
        let _guard = UniverseGuard::set(Some(&worktree));

        let resolved = find_repo_root_from(&nested).expect("nested path should resolve");
        assert_eq!(resolved, std::fs::canonicalize(&worktree).unwrap());
    }

    #[test]
    fn test_universe_survives_a_symlinked_spelling() {
        let (temp, _base, worktree) = repo_with_linked_worktree();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&worktree, &alias).unwrap();
        // The universe is named through the symlink; the start path is not.
        let _guard = UniverseGuard::set(Some(&alias));

        let resolved = find_repo_root_from(&worktree).expect("aliased universe should resolve");
        assert_eq!(
            resolved,
            std::fs::canonicalize(&worktree).unwrap(),
            "both sides canonicalize, so two spellings of one path agree"
        );
    }

    #[test]
    fn test_universe_does_not_capture_paths_outside_it() {
        let (_temp, _base, worktree) = repo_with_linked_worktree();
        let (_other_temp, other_base, other_worktree) = repo_with_linked_worktree();
        let _guard = UniverseGuard::set(Some(&worktree));

        let resolved = find_repo_root_from(&other_worktree).expect("outside path should resolve");
        assert_eq!(
            std::fs::canonicalize(resolved).unwrap(),
            std::fs::canonicalize(&other_base).unwrap(),
            "a universe is a boundary, not a global override"
        );
    }

    #[test]
    fn test_universe_without_a_git_is_a_loud_error() {
        let temp = TempDir::new().unwrap();
        let not_a_checkout = temp.path().join("empty");
        std::fs::create_dir(&not_a_checkout).unwrap();
        let _guard = UniverseGuard::set(Some(&not_a_checkout));

        let err = find_repo_root_from(&not_a_checkout).expect_err("should refuse");
        let message = err.to_string();
        assert!(
            message.contains(REPO_UNIVERSE_ENV),
            "the message must name the variable: {}",
            message
        );
        assert!(
            message.contains("not a checkout"),
            "the message must name the defect: {}",
            message
        );
    }

    #[test]
    fn test_universe_pointing_nowhere_is_a_loud_error() {
        let temp = TempDir::new().unwrap();
        let missing = temp.path().join("does-not-exist");
        let _guard = UniverseGuard::set(Some(&missing));

        let err = find_repo_root_from(temp.path()).expect_err("should refuse");
        assert!(
            err.to_string().contains(REPO_UNIVERSE_ENV),
            "the message must name the variable: {}",
            err
        );
    }

    #[test]
    fn test_sanitize_branch_name() {
        assert_eq!(
            sanitize_branch_name("tugplan/auth-20260208-143022"),
            "tugplan__auth-20260208-143022"
        );
        assert_eq!(
            sanitize_branch_name("tug\\windows\\path"),
            "tug__windows__path"
        );
        assert_eq!(sanitize_branch_name("feature:v1.0"), "feature_v10");
        assert_eq!(sanitize_branch_name("my feature"), "my_feature");
        assert_eq!(sanitize_branch_name("!@#$%"), "tugplan-worktree"); // Fallback
    }

    #[test]
    fn test_find_repo_root_from_git_dir() {
        let _guard = UniverseGuard::set(None);
        let temp = TempDir::new().unwrap();
        let repo = temp.path();

        // Initialize a git repo
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(repo)
            .output()
            .expect("git init should succeed");

        let result = find_repo_root_from(repo);
        assert!(
            result.is_ok(),
            "find_repo_root_from should succeed for git dir"
        );
        assert_eq!(result.unwrap(), repo.to_path_buf());
    }

    #[test]
    fn test_find_repo_root_from_non_git_dir() {
        let _guard = UniverseGuard::set(None);
        let temp = TempDir::new().unwrap();
        let non_git = temp.path();
        // No .git directory created

        let result = find_repo_root_from(non_git);
        assert!(
            result.is_err(),
            "find_repo_root_from should fail for non-git dir"
        );
        match result.unwrap_err() {
            TugError::NotAGitRepository => {} // expected
            other => panic!("Expected NotAGitRepository, got: {:?}", other),
        }
    }
}
