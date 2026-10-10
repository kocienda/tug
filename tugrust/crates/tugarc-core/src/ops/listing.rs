//! The `-z` path-listing door: every listing that yields paths reads them as
//! records through `tugchanges_core::git`, never as git's display lines.

use std::path::Path;

use crate::error::ArcError;

// --- the `-z` path-listing door [B01] --------------------------------------
//
// Every listing in this crate that yields *paths* reads them through
// `tugchanges_core::git`'s door rather than through `git_stdout` above. The
// reason is one sentence: git's line-oriented output is a display format that
// C-quotes any path with a non-ASCII byte, a `"`, a `\`, a tab or a newline,
// and these sites move a user's work — a join preflight that cannot name what
// is dirty is a join that sweeps or refuses on a path nobody has.
//
// `git_stdout` stays for everything that is not a path: shas, branch names,
// commit subjects, config values.

/// The paths a git listing names, through the door.
pub(crate) fn git_paths(dir: &Path, args: &[&str]) -> Result<Vec<String>, ArcError> {
    tugchanges_core::read_paths(dir, args).map_err(|e| listing_error(args, e))
}

/// The same, degrading an unreadable listing to no paths — for the callers
/// that already treated a git failure that way.
pub(crate) fn git_paths_or_empty(dir: &Path, args: &[&str]) -> Vec<String> {
    git_paths(dir, args).unwrap_or_default()
}

/// `git status --porcelain=v2 <extra…>` at `dir`, through the door.
pub(crate) fn git_status(
    dir: &Path,
    extra: &[&str],
) -> Result<tugchanges_core::StatusReport, ArcError> {
    tugchanges_core::read_status(dir, extra).map_err(|e| listing_error(extra, e))
}

/// The door's two failures, by cause: git failing is a git failure, already
/// one finished sentence; a path git named that is not UTF-8 is the door
/// refusing to guess at it, and says so.
pub(super) fn listing_error(args: &[&str], e: tugchanges_core::ListingError) -> ArcError {
    match e {
        tugchanges_core::ListingError::Git(detail) => ArcError::git("", args, detail),
        undecodable => ArcError::Refused(undecodable.to_string()),
    }
}

/// Whether `dir` holds anything uncommitted at all — tracked or untracked.
///
/// The question every `status --porcelain` emptiness check was asking. It goes
/// through the door for the same reason the others do: a status read is a
/// path listing whether or not this particular caller looks at the paths, and
/// one spelling for all of them is what keeps the next one from drifting.
pub(crate) fn has_uncommitted(dir: &Path) -> Result<bool, ArcError> {
    let report = git_status(dir, &[])?;
    Ok(!report.entries.is_empty() || !report.untracked.is_empty())
}

/// The tracked paths with uncommitted changes in `dir` (staged or unstaged vs
/// HEAD) as plain path lines — the intersection-preflight input. `git diff
/// --name-only HEAD` avoids porcelain's status-prefix parsing and never lists
/// untracked files (which can't overlap the base's tracked dirt anyway).
pub(super) fn dirty_tracked_paths(dir: &Path) -> Vec<String> {
    git_paths_or_empty(dir, &["diff", "--name-only", "HEAD"])
}

/// The untracked paths at `dir`, as plain path lines.
pub(super) fn untracked_paths(dir: &Path) -> Vec<String> {
    git_paths_or_empty(dir, &["ls-files", "--others", "--exclude-standard"])
}
