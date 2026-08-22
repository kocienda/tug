//! The canonicalization gateway — the one place a path becomes the **Claude
//! form** ([L29]).
//!
//! Every persisted or compared path routes through [`resolve_to_claude_form`];
//! nothing keys a row, compares two spellings, or looks a project up by a raw
//! path or a bare [`std::fs::canonicalize`]. The gateway lives here, below
//! `tugcast`, so the crates that must agree on a spelling — the server that
//! writes a row and the dash library that reads it back — can reach the same
//! function rather than each rolling its own normalization.
//!
//! `tugcast::path_resolver` re-exports these names, so its `PathResolver`
//! watcher and every existing call site are unchanged.

use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

/// Resolve a user-supplied directory path to the **Claude form**: symlinks
/// and macOS `synthetic.conf` firmlinks resolved, but the APFS data-volume
/// firmlink collapsed back to its user-visible prefix
/// (`/System/Volumes/Data/Users/…` → `/Users/…`).
///
/// This is the single path form that the kernel's `getcwd`, Bun's
/// `realpathSync`, and Claude Code's `~/.claude/projects/<encoded-cwd>`
/// directory naming all agree on. Every consumer that must line up with
/// Claude's on-disk layout — the external-session scanner, the trash mover,
/// the JSONL `cwd` record filter, `claude_project_dir`, the dash draft
/// lookup — MUST route through here. It is the standalone twin of
/// `tugcast::path_resolver::PathResolver`'s `primary` selection (they share
/// [`resolve_synthetic`] / [`resolve_apfs_firmlink`]), exposed for callers
/// that only need the canonical string, not a live FSEvents watcher.
///
/// **Do not** reach for [`std::fs::canonicalize`] on a project path: on macOS
/// `realpath(3)` expands the data-volume firmlink to `/System/Volumes/Data/…`,
/// a form Claude never writes. That single mismatch is the recurring
/// "terminal sessions don't appear in the picker / trash silently no-ops"
/// bug class — this function is its firmlink-aware replacement.
pub fn resolve_to_claude_form(path: &Path) -> PathBuf {
    // Phase 1: resolve symlinks via canonicalize (firmlink-expanded on macOS).
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

    // Phase 2/3 (macOS): collapse synthetic.conf + APFS firmlinks back to the
    // user-visible form, identity-verified. Priority matches PathResolver's
    // `primary`: synthetic-resolved > firmlink-resolved > canonical.
    #[cfg(target_os = "macos")]
    {
        resolve_synthetic(path)
            .or_else(|| resolve_apfs_firmlink(&canonical))
            .unwrap_or(canonical)
    }
    #[cfg(not(target_os = "macos"))]
    {
        canonical
    }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// The `(device, inode)` identity of a live path, or `None` when it cannot be
/// stat'd (missing / permission-denied). Ground truth for "are these the same
/// file", but only for **live** files — a deleted or renamed path has no inode
/// to read, so this is a reconciliation aid, never a durable key.
#[cfg(unix)]
pub fn get_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.dev(), meta.ino()))
}

/// Whether two **live** paths name the same file by `(device, inode)`. Used to
/// judge equality when the canonical strings disagree (firmlink/symlink alias
/// verification, legacy-row reconciliation). `false` when either path cannot be
/// stat'd, so a deleted path never matches.
#[cfg(unix)]
pub fn same_file(a: &Path, b: &Path) -> bool {
    match (get_identity(a), get_identity(b)) {
        (Some(ia), Some(ib)) => ia == ib,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// macOS: synthetic.conf resolution
// ---------------------------------------------------------------------------

/// Parse `/etc/synthetic.conf` into `("/name", "target")` symlink entries, in
/// file order. Comments, blank lines, and lines without both columns are
/// dropped.
#[cfg(target_os = "macos")]
fn parse_synthetic_conf(conf: &str) -> Vec<(String, String)> {
    conf.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (name, target) = line.split_once('\t')?;
            let (name, target) = (name.trim(), target.trim());
            if name.is_empty() || target.is_empty() {
                return None;
            }
            Some((format!("/{name}"), target.to_string()))
        })
        .collect()
}

/// The parsed synthetic.conf entries, read once per process. Entries only take
/// effect at boot, so a running process can never observe a working change to
/// the file — `tugcast`'s boot-built alias table already froze this data on the
/// same reasoning.
#[cfg(target_os = "macos")]
pub fn synthetic_table() -> &'static [(String, String)] {
    static TABLE: OnceLock<Vec<(String, String)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        std::fs::read_to_string("/etc/synthetic.conf")
            .map(|conf| parse_synthetic_conf(&conf))
            .unwrap_or_default()
    })
}

#[cfg(target_os = "macos")]
pub fn resolve_synthetic(path: &Path) -> Option<PathBuf> {
    let path_str = path.to_str()?;

    for (syn_root, target) in synthetic_table() {
        let syn_root = syn_root.as_str();
        let target = target.as_str();

        if path_str == syn_root || path_str.starts_with(&format!("{}/", syn_root)) {
            let rest = &path_str[syn_root.len()..];
            let resolved_target =
                resolve_apfs_firmlink_str(target).unwrap_or_else(|| target.to_string());
            let full = format!("{}{}", resolved_target, rest);
            let full_path = PathBuf::from(&full);

            if full_path.exists() && same_file(path, &full_path) {
                return Some(full_path);
            }

            let fallback = PathBuf::from(format!("{}{}", target, rest));
            if fallback.exists() && same_file(path, &fallback) {
                return Some(fallback);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// macOS: APFS firmlink resolution
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub fn resolve_apfs_firmlink(path: &Path) -> Option<PathBuf> {
    let path_str = path.to_str()?;
    let resolved = resolve_apfs_firmlink_str(path_str)?;
    let resolved_path = PathBuf::from(&resolved);
    if resolved_path.exists() && same_file(path, &resolved_path) {
        Some(resolved_path)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn resolve_apfs_firmlink_str(path_str: &str) -> Option<String> {
    let prefix = "/System/Volumes/Data";
    if let Some(without) = path_str.strip_prefix(prefix) {
        if !without.is_empty() && Path::new(without).exists() {
            return Some(without.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The conf parse keeps exactly the two-column entries, trims both
    /// columns, and drops comments, blanks, and single-column lines.
    #[cfg(target_os = "macos")]
    #[test]
    fn synthetic_conf_parse_keeps_only_valid_entries() {
        let conf = "\
# a comment

u\t/Users/someone/Mounts/u
malformed-single-column
 spaced \t /Volumes/Target \n\
empty-target\t
\t/no/name";
        let entries = parse_synthetic_conf(conf);
        assert_eq!(
            entries,
            vec![
                ("/u".to_string(), "/Users/someone/Mounts/u".to_string()),
                ("/spaced".to_string(), "/Volumes/Target".to_string()),
            ]
        );
    }

    /// A symlinked spelling of a directory and the directory itself resolve to
    /// one form. This is the property every persisted key depends on: two
    /// spellings of one root must never read as two projects.
    #[test]
    fn symlinked_spelling_resolves_to_the_same_form() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert_eq!(
            resolve_to_claude_form(&link),
            resolve_to_claude_form(&target),
        );
    }

    /// A plain directory under no alias is a no-op beyond symlink resolution.
    #[test]
    fn plain_directory_matches_canonicalize() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_to_claude_form(tmp.path());
        assert!(same_file(tmp.path(), &resolved));
    }
}
