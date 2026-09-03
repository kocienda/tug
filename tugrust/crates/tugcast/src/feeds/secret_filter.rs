//! SecretFilter — denylist + `.tugattachignore` matcher for the FileTreeFeed.
//!
//! Filters secret-file paths out of `@`-completion suggestions before they
//! reach the prompt-entry popup. Combines a built-in denylist (per
//! `arc/dev-atoms.md#l01-secret-file-denylist`) with an optional
//! workspace-root `.tugattachignore` file (gitignore syntax, parsed via
//! the `ignore` crate).
//!
//! The two sources stack additively on top of the existing `.gitignore`
//! handling in `file_watcher::walk_directory`. The walker drops everything
//! `.gitignore` says to drop; this module drops the remaining secret-shape
//! paths the walker would otherwise have surfaced. Both layers are
//! applied at index-build time so query results never need a per-entry
//! recheck — the `BTreeSet<String>` `FileTreeFeed` owns is already
//! filtered.
//!
//! Off-board queries (`/...` and `~/...` paths that bypass the workspace
//! index) consult this filter per-entry because their results come from
//! a direct `std::fs::read_dir` rather than the pre-filtered set.
//!
//! Parse-error policy: a malformed `.tugattachignore` line is dropped and
//! logged via `warn!` (the existing tugcast telemetry channel — see
//! `arc/dev-atoms.md#t01-failure-modes`). The remaining well-formed
//! patterns still apply; one bad line never disables the whole filter.

use std::path::Path;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use tracing::warn;

/// Built-in denylist patterns per
/// [List L01](../../../../arc/dev-atoms.md#l01-secret-file-denylist).
///
/// Compiled into the matcher at `SecretFilter::new`. Patterns use
/// gitignore syntax — anchored to the workspace root unless they
/// contain a `/`. Matching is case-sensitive (gitignore default);
/// users on case-insensitive filesystems still get the right behavior
/// because the patterns capture the canonical lower-case file names
/// the ecosystem uses by convention.
pub const SECRET_FILE_DENYLIST: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa*",
    "id_ed25519*",
    "secrets.json",
    "credentials.json",
    "**/.aws/credentials",
    "**/.npmrc",
    "**/.ssh/**",
];

/// Workspace-root `.tugattachignore` filename. Same syntax as
/// `.gitignore`. Optional — a workspace without this file gets the
/// built-in denylist only.
pub const TUGATTACHIGNORE_FILENAME: &str = ".tugattachignore";

/// Compiled secret-file matcher for one workspace.
///
/// Owns a `Gitignore` matcher containing the built-in denylist plus
/// (if present at construction time) the patterns parsed from
/// `<workspace>/.tugattachignore`. The matcher is `Sync` so a single
/// `SecretFilter` can be shared across the feed's query and event
/// paths without further synchronization.
pub struct SecretFilter {
    matcher: Gitignore,
}

impl SecretFilter {
    /// Build the filter for `workspace_root`. Always returns a usable
    /// filter — the built-in denylist patterns are static and the
    /// `GitignoreBuilder` accepts them unconditionally. If
    /// `<workspace_root>/.tugattachignore` exists, its patterns are
    /// layered on top; parse errors on individual lines are dropped
    /// with a `warn!` log and the surviving patterns still apply.
    ///
    /// A missing `.tugattachignore` is the common case; not an error.
    pub fn new(workspace_root: &Path) -> Self {
        let mut builder = GitignoreBuilder::new(workspace_root);
        Self::add_builtin_patterns(&mut builder);
        Self::add_tugattachignore(&mut builder, workspace_root);
        let matcher = match builder.build() {
            Ok(m) => m,
            Err(err) => {
                // `GitignoreBuilder::build` only fails on a glob compile
                // error in patterns we already validated line-by-line.
                // If we ever land here it's a programmer bug in the
                // denylist itself — fall back to a no-op matcher so the
                // feed doesn't refuse to start.
                warn!(
                    error = %err,
                    "SecretFilter: matcher build failed; falling back to empty matcher",
                );
                Gitignore::empty()
            }
        };
        Self { matcher }
    }

    /// Construct a filter containing the built-in denylist only, with
    /// no workspace lookup. For callers without a workspace root — the
    /// `/api/fs/*` endpoints, which accept any absolute path. Callers
    /// that do have a workspace root should use `new` so the optional
    /// `.tugattachignore` is honored.
    pub fn builtin_only() -> Self {
        let mut builder = GitignoreBuilder::new(".");
        Self::add_builtin_patterns(&mut builder);
        let matcher = builder.build().unwrap_or_else(|_| Gitignore::empty());
        Self { matcher }
    }

    /// True if `relative_path` matches any built-in or `.tugattachignore`
    /// pattern. `relative_path` is workspace-relative with forward
    /// slashes (the shape the BTreeSet stores); a directory entry
    /// carries a trailing `/` and is matched with `is_dir: true` so a
    /// directory pattern like `local-secrets/` excludes the directory
    /// entry itself, not just its children.
    ///
    /// Uses `matched_path_or_any_parents` so a directory pattern also
    /// excludes files *inside* the directory (`local-secrets/api.txt`)
    /// — the ancestor walk tests parent directories on the way up.
    pub fn is_secret(&self, relative_path: &str) -> bool {
        let (path, is_dir) = match relative_path.strip_suffix('/') {
            Some(stripped) => (stripped, true),
            None => (relative_path, false),
        };
        self.matcher
            .matched_path_or_any_parents(path, is_dir)
            .is_ignore()
    }

    fn add_builtin_patterns(builder: &mut GitignoreBuilder) {
        for pattern in SECRET_FILE_DENYLIST {
            if let Err(err) = builder.add_line(None, pattern) {
                // Programmer error — a literal pattern in our denylist
                // failed to parse. Log loudly so the next CI run catches
                // it; the filter continues with the remaining patterns.
                warn!(
                    pattern = %pattern,
                    error = %err,
                    "SecretFilter: built-in denylist pattern rejected by parser",
                );
            }
        }
    }

    fn add_tugattachignore(builder: &mut GitignoreBuilder, workspace_root: &Path) {
        let path = workspace_root.join(TUGATTACHIGNORE_FILENAME);
        // `builder.add` reads the file, parses each non-comment, non-
        // empty line as a gitignore pattern, and returns the first
        // error encountered (or `None` on full success). It does NOT
        // bail on the first bad line — patterns that succeed are kept
        // in the builder. So we can log the first error and still
        // honor the rest.
        if !path.exists() {
            return;
        }
        if let Some(err) = builder.add(&path) {
            warn!(
                path = %path.display(),
                error = %err,
                ".tugattachignore parse error; surviving patterns still apply",
            );
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;

    // -----------------------------------------------------------------------
    // Built-in denylist coverage
    // -----------------------------------------------------------------------

    #[test]
    fn denylist_matches_env_files() {
        let filter = SecretFilter::builtin_only();
        assert!(filter.is_secret(".env"));
        assert!(filter.is_secret(".env.local"));
        assert!(filter.is_secret(".env.production"));
    }

    #[test]
    fn denylist_matches_pem_and_key() {
        let filter = SecretFilter::builtin_only();
        assert!(filter.is_secret("server.pem"));
        assert!(filter.is_secret("private.key"));
        assert!(filter.is_secret("config/api.key"));
    }

    #[test]
    fn denylist_matches_ssh_identities() {
        let filter = SecretFilter::builtin_only();
        assert!(filter.is_secret("id_rsa"));
        assert!(filter.is_secret("id_rsa.pub"));
        assert!(filter.is_secret("id_ed25519"));
        assert!(filter.is_secret("id_ed25519.pub"));
    }

    #[test]
    fn denylist_matches_credentials_files() {
        let filter = SecretFilter::builtin_only();
        assert!(filter.is_secret("secrets.json"));
        assert!(filter.is_secret("credentials.json"));
    }

    #[test]
    fn denylist_matches_nested_dotfiles() {
        let filter = SecretFilter::builtin_only();
        assert!(filter.is_secret(".aws/credentials"));
        assert!(filter.is_secret("home/.aws/credentials"));
        assert!(filter.is_secret(".npmrc"));
        assert!(filter.is_secret("project/.npmrc"));
    }

    #[test]
    fn denylist_matches_ssh_subtree() {
        let filter = SecretFilter::builtin_only();
        assert!(filter.is_secret(".ssh/known_hosts"));
        assert!(filter.is_secret(".ssh/config"));
        assert!(filter.is_secret("home/.ssh/authorized_keys"));
    }

    #[test]
    fn denylist_passes_through_ordinary_files() {
        let filter = SecretFilter::builtin_only();
        assert!(!filter.is_secret("README.md"));
        assert!(!filter.is_secret("src/main.rs"));
        assert!(!filter.is_secret("envoy.yaml"));
        assert!(!filter.is_secret("key_handlers.ts"));
        // The `id_rsa*` and `id_ed25519*` patterns are deliberate
        // prefix matches against SSH key naming conventions. Files
        // that happen to start with those literal prefixes (vanishingly
        // unlikely in real source trees) would be filtered — that's
        // the documented tradeoff per [List L01]. Nothing else
        // starting with `id_` is affected.
        assert!(!filter.is_secret("id.tsx"));
        assert!(!filter.is_secret("identity.ts"));
        // Deliberately empty .env.* match → does NOT consume `.envrc`
        // which is a different gitignore-style match.
        assert!(!filter.is_secret(".envrc"));
    }

    // -----------------------------------------------------------------------
    // .tugattachignore reader
    // -----------------------------------------------------------------------

    #[test]
    fn tugattachignore_patterns_apply() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join(".tugattachignore"),
            "local-secrets/\nbuild.notes\n",
        )
        .unwrap();
        let filter = SecretFilter::new(tmp.path());
        assert!(filter.is_secret("local-secrets/api.txt"));
        assert!(filter.is_secret("build.notes"));
        // Still excludes the built-ins.
        assert!(filter.is_secret(".env"));
        // Doesn't exclude unrelated files.
        assert!(!filter.is_secret("README.md"));
    }

    #[test]
    fn missing_tugattachignore_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let filter = SecretFilter::new(tmp.path());
        // Built-in patterns still apply.
        assert!(filter.is_secret(".env"));
        // Nothing else is filtered.
        assert!(!filter.is_secret("README.md"));
    }

    #[test]
    fn malformed_tugattachignore_line_does_not_disable_filter() {
        let tmp = tempfile::tempdir().unwrap();
        // The `ignore` crate is lenient — comments + blank lines +
        // valid patterns coexist. A line starting with a literal `[`
        // (no closing bracket) is one of the few cases that triggers
        // a parse error in the underlying globset.
        fs::write(
            tmp.path().join(".tugattachignore"),
            "# leading comment\n[invalid-glob\nlegit-pattern.txt\n",
        )
        .unwrap();
        let filter = SecretFilter::new(tmp.path());
        // Built-ins still work — surviving patterns honored.
        assert!(filter.is_secret(".env"));
        // The valid user pattern survives even though a sibling line
        // failed to parse.
        assert!(filter.is_secret("legit-pattern.txt"));
        // Unrelated files still pass through.
        assert!(!filter.is_secret("README.md"));
    }

    #[test]
    fn tugattachignore_combined_with_builtin_in_one_filter() {
        // Spec assertion: in the combined matcher, both layers fire.
        // Verifies the order doesn't matter — both denylist and user
        // patterns contribute equally to the deny set.
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join(".tugattachignore"),
            "*.draft\nplans/private/\n",
        )
        .unwrap();
        let filter = SecretFilter::new(tmp.path());

        // Built-in still fires.
        assert!(filter.is_secret(".env"));
        assert!(filter.is_secret("server.pem"));
        // User pattern fires.
        assert!(filter.is_secret("notes.draft"));
        assert!(filter.is_secret("plans/private/sketch.md"));
        // Non-matches pass through.
        assert!(!filter.is_secret("notes.md"));
        assert!(!filter.is_secret("plans/public/sketch.md"));
    }
}
