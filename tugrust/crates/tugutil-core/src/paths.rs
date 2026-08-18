//! Per-project runtime-state directory resolution.
//!
//! Per-user runtime state (the dash-log, the code-sign sentinel, future
//! side-command outputs) lives outside the source tree, in an OS-conventional
//! application-data directory, broken down per project. The single source of
//! that path is [`project_state_dir`].

use std::path::{Component, Path, PathBuf};

/// Resolve the per-project runtime-state directory for `repo_root`.
///
/// Returns `<data_dir>/Tug/projects/<slug>/`, where `<data_dir>` is the
/// OS-conventional application-data directory (`~/Library/Application Support`
/// on macOS, `$XDG_DATA_HOME` / `~/.local/share` on Linux, `%APPDATA%` on
/// Windows) and `<slug>` is the project's *canonical* absolute path with each
/// separator replaced by `-`. The slug's shape mirrors Claude Code's
/// `.claude/projects/` naming, but the key is the canonical path: one
/// repository has one state dir no matter which spelling the caller arrived by.
///
/// `repo_root` should be the *main* repository root — every linked worktree of
/// a project shares one state dir. This is per-user runtime state; it is never
/// committed.
pub fn project_state_dir(repo_root: &Path) -> PathBuf {
    let projects = tugcore::instance::base_data_dir().join("projects");
    let canonical = project_slug(repo_root);
    let raw = raw_slug(repo_root);
    if raw != canonical {
        reconcile_alias_state_dir(&projects.join(raw), &projects.join(&canonical));
    }
    projects.join(canonical)
}

/// Fold an alias spelling's state dir into the canonical one, once.
///
/// **Claim first, then merge.** The rename to `<slug>-premerge` is the lock:
/// a binary built before the canonical slug existed keeps writing under the
/// alias name and recreates the directory, and only a claim taken up front
/// bounds each incarnation to exactly one merge. The claimed directory stays
/// on disk afterwards as the verbatim record of what was folded in.
///
/// Silent by design in every failure: a rename that loses the race, a copy
/// that fails, a directory that was never there. Nothing here is worth
/// failing a state-dir lookup over, and the `-premerge` directory is the
/// record that a merge happened.
fn reconcile_alias_state_dir(alias: &Path, canonical: &Path) {
    if !alias.is_dir() {
        return;
    }
    let Some(claimed) = claim_alias_dir(alias) else {
        return;
    };
    let _ = std::fs::create_dir_all(canonical);
    let Ok(entries) = std::fs::read_dir(&claimed) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let target = canonical.join(&name);
        if name == "dash-log.md" {
            merge_dash_log(&entry.path(), &target);
        } else if !target.exists() {
            let _ = std::fs::copy(entry.path(), target);
        }
    }
}

/// Rename `alias` aside to `<name>-premerge`, numbering the suffix when it is
/// taken. Returns the claimed path, or `None` when the claim could not be made
/// (a concurrent caller won it, or the filesystem refused).
fn claim_alias_dir(alias: &Path) -> Option<PathBuf> {
    let parent = alias.parent()?;
    let stem = alias.file_name()?.to_string_lossy().into_owned();
    for attempt in 1..=64u32 {
        let name = if attempt == 1 {
            format!("{stem}-premerge")
        } else {
            format!("{stem}-premerge-{attempt}")
        };
        let candidate = parent.join(name);
        if candidate.exists() {
            continue;
        }
        if std::fs::rename(alias, &candidate).is_ok() {
            return Some(candidate);
        }
        return None;
    }
    None
}

/// Union `from`'s dash-log lines into `into`'s, dropping exact duplicates and
/// sorting by the leading ISO-8601 timestamp field. The grammar's first field
/// is that timestamp, so a lexical sort is a chronological one, and
/// `read_declarations` is order-driven — a merged log reads as if one writer
/// had written it.
fn merge_dash_log(from: &Path, into: &Path) {
    let Ok(incoming) = std::fs::read_to_string(from) else {
        return;
    };
    let existing = std::fs::read_to_string(into).unwrap_or_default();
    let mut lines: Vec<&str> = existing
        .lines()
        .chain(incoming.lines())
        .filter(|line| !line.trim().is_empty())
        .collect();
    let mut seen = std::collections::HashSet::new();
    lines.retain(|line| seen.insert(*line));
    lines.sort_by_key(|line| line.split_whitespace().next().unwrap_or(""));

    let mut merged = lines.join("\n");
    merged.push('\n');
    let _ = std::fs::write(into, merged);
}

/// The slug for `repo_root` exactly as the caller spelled it — the name an
/// alias state dir carries on disk.
fn raw_slug(repo_root: &Path) -> String {
    repo_root.to_string_lossy().replace(['/', '\\'], "-")
}

/// Resolve `repo_root` to the one spelling this machine agrees on.
///
/// Two rewrites, in order:
///
/// 1. `std::fs::canonicalize`, falling back to the path as given when it fails
///    (a path that does not exist still needs a stable slug).
/// 2. Strip a leading `/System/Volumes/Data`. macOS firmlinks make
///    `canonicalize` answer with that prefix for some spellings of the data
///    volume and without it for others — `/u/src/tugtool` canonicalizes to
///    `/System/Volumes/Data/Users/…` while `/Users/…` canonicalizes to itself
///    — so canonicalization alone still yields two names for one directory.
///
/// The strip is component-wise, so `/System/Volumes/DataX` is untouched.
pub fn canonical_repo_root(repo_root: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(repo_root).unwrap_or_else(|_| repo_root.to_path_buf());
    strip_data_volume_prefix(&resolved)
}

/// Drop a leading `/System/Volumes/Data` from an absolute path.
fn strip_data_volume_prefix(path: &Path) -> PathBuf {
    let mut components = path.components();
    let head: Vec<Component<'_>> = components.clone().take(5).collect();
    let matches = matches!(head.as_slice(), [Component::RootDir, a, b, c, _rest]
        if a.as_os_str() == "System" && b.as_os_str() == "Volumes" && c.as_os_str() == "Data");
    if !matches {
        return path.to_path_buf();
    }
    let mut stripped = PathBuf::from("/");
    stripped.extend(components.by_ref().skip(4));
    stripped
}

/// Flatten an absolute path into a single directory-name slug by replacing each
/// path separator with `-`. A leading separator becomes a leading `-`, e.g.
/// `/Users/a/src/tug` → `-Users-a-src-tug`.
///
/// The path is canonicalized first ([`canonical_repo_root`]) so that every
/// spelling of one repository lands on one slug.
///
/// This is Tug's OWN state-dir naming, not Claude Code's
/// `~/.claude/projects/` scheme — claude additionally collapses dots,
/// underscores, and every other non-`[A-Za-z0-9-]` character to `-`
/// (see `encode_claude_project_name` in tugcast). Do not copy this
/// function for anything that must resolve claude's on-disk layout;
/// and do not "fix" it to match — existing per-project state dirs are
/// keyed by this exact form.
fn project_slug(repo_root: &Path) -> String {
    raw_slug(&canonical_repo_root(repo_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_mirrors_claude_projects_scheme() {
        // A path that does not exist keeps its raw spelling.
        assert_eq!(
            project_slug(Path::new("/Users/nobody/Mounts/u/src/tugtool")),
            "-Users-nobody-Mounts-u-src-tugtool"
        );
    }

    #[test]
    fn state_dir_is_under_tug_projects() {
        let dir = project_state_dir(Path::new("/tmp/example-repo"));
        assert!(dir.ends_with("Tug/projects/-tmp-example-repo"));
    }

    #[test]
    fn data_volume_prefix_is_stripped() {
        assert_eq!(
            strip_data_volume_prefix(Path::new("/System/Volumes/Data/Users/x/src/tug")),
            PathBuf::from("/Users/x/src/tug")
        );
    }

    #[test]
    fn similar_prefixes_are_left_alone() {
        for path in [
            "/System/Volumes/DataX/Users/x",
            "/System/Volumes/Datum",
            "/Users/x/System/Volumes/Data/y",
            "/System/Volumes/Data",
        ] {
            assert_eq!(
                strip_data_volume_prefix(Path::new(path)),
                PathBuf::from(path),
                "{path}"
            );
        }
    }

    /// An alias dir holding `log` beside an empty canonical dir, both under one
    /// temp `projects` root. Returns (projects, alias, canonical).
    fn alias_fixture(
        alias_log: &str,
        canonical_log: &str,
    ) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let projects = tempfile::tempdir().expect("tempdir");
        let alias = projects.path().join("-u-src-tugtool");
        let canonical = projects.path().join("-Users-x-src-tugtool");
        std::fs::create_dir_all(&alias).expect("alias dir");
        std::fs::write(alias.join("dash-log.md"), alias_log).expect("alias log");
        if !canonical_log.is_empty() {
            std::fs::create_dir_all(&canonical).expect("canonical dir");
            std::fs::write(canonical.join("dash-log.md"), canonical_log).expect("canonical log");
        }
        (projects, alias, canonical)
    }

    #[test]
    fn an_alias_dir_merges_in_timestamp_order_and_is_claimed_aside() {
        let (projects, alias, canonical) = alias_fixture(
            "2026-08-14T10:00:00Z  d  step-start  1/9 first\n\
             2026-08-14T14:00:00Z  d  step-done  1/9 first\n",
            "2026-08-14T12:00:00Z  d  replayed  base\n",
        );
        std::fs::write(alias.join("join-journal-d.json"), "{}").expect("journal");

        reconcile_alias_state_dir(&alias, &canonical);

        let merged = std::fs::read_to_string(canonical.join("dash-log.md")).expect("merged");
        let stamps: Vec<&str> = merged
            .lines()
            .map(|line| line.split_whitespace().next().unwrap())
            .collect();
        assert_eq!(
            stamps,
            [
                "2026-08-14T10:00:00Z",
                "2026-08-14T12:00:00Z",
                "2026-08-14T14:00:00Z"
            ]
        );
        assert!(canonical.join("join-journal-d.json").exists());
        assert!(!alias.exists());
        assert!(projects.path().join("-u-src-tugtool-premerge").is_dir());
    }

    #[test]
    fn duplicate_lines_survive_the_merge_once() {
        let shared = "2026-08-14T10:00:00Z  d  bound  session\n";
        let (_projects, alias, canonical) = alias_fixture(shared, shared);

        reconcile_alias_state_dir(&alias, &canonical);

        let merged = std::fs::read_to_string(canonical.join("dash-log.md")).expect("merged");
        assert_eq!(merged, shared);
    }

    #[test]
    fn a_recreated_alias_is_claimed_under_a_numbered_suffix() {
        let (projects, alias, canonical) =
            alias_fixture("2026-08-14T10:00:00Z  d  bound  one\n", "");
        reconcile_alias_state_dir(&alias, &canonical);
        let after_first = std::fs::read_to_string(canonical.join("dash-log.md")).expect("merged");

        // A stale writer recreates the alias dir and appends more history.
        std::fs::create_dir_all(&alias).expect("alias dir again");
        std::fs::write(
            alias.join("dash-log.md"),
            "2026-08-14T11:00:00Z  d  bound  two\n",
        )
        .expect("alias log again");
        reconcile_alias_state_dir(&alias, &canonical);

        let after_second = std::fs::read_to_string(canonical.join("dash-log.md")).expect("merged");
        assert_ne!(after_first, after_second);
        assert!(after_second.contains("two"));
        assert!(projects.path().join("-u-src-tugtool-premerge").is_dir());
        assert!(projects.path().join("-u-src-tugtool-premerge-2").is_dir());
    }

    #[test]
    fn reconciling_a_missing_alias_is_a_no_op() {
        let projects = tempfile::tempdir().expect("tempdir");
        let alias = projects.path().join("-u-src-tugtool");
        let canonical = projects.path().join("-Users-x-src-tugtool");

        reconcile_alias_state_dir(&alias, &canonical);

        assert!(!canonical.exists());
    }

    #[test]
    fn a_symlinked_repo_root_slugs_like_its_real_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let real = tmp.path().join("real-repo");
        std::fs::create_dir(&real).expect("create real");
        let link = tmp.path().join("link-repo");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        assert_eq!(project_slug(&link), project_slug(&real));
    }
}
