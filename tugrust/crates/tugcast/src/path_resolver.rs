//! PathResolver — robust path resolution for file watching.
//!
//! Resolves a user-provided directory path to the form that the OS file
//! watching API (FSEvents on macOS, inotify on Linux) actually accepts.
//! Handles symlinks, synthetic firmlinks (macOS synthetic.conf), APFS
//! firmlinks (/System/Volumes/Data ↔ /Users), and Linux bind mounts.
//!
//! Uses (device, inode) as the fundamental identity — the only reliable
//! way to determine that two paths refer to the same directory.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tracing::{debug, info};

/// Resolved path information for a watch directory.
pub struct PathResolver {
    /// The original path as provided by the caller.
    original: PathBuf,
    /// The resolved path to register with FSEvents/inotify.
    /// This is the form that actually produces events.
    primary: PathBuf,
    /// (device, inode) identity of the watch directory.
    #[cfg(unix)]
    identity: (u64, u64),
    /// Alternative path forms discovered during resolution or lazily at
    /// runtime. Used as fallbacks for strip_prefix when event paths use
    /// an unexpected form.
    alt_prefixes: Mutex<Vec<PathBuf>>,
    /// Whether the watch path is under an autofs mount (macOS).
    #[allow(dead_code)]
    pub is_autofs: bool,
}

/// The canonicalization gateway ([L29]) lives in [`tugcore::pathform`], below
/// this crate, so `tugarc-core` and every other consumer keys on the same
/// spelling. Re-exported here because `PathResolver`'s `primary` selection is
/// the gateway's twin and every call site in this crate names it through
/// `path_resolver`.
pub use tugcore::pathform::resolve_to_claude_form;

// ---------------------------------------------------------------------------
// CanonicalPath gateway
// ---------------------------------------------------------------------------

/// A path in the user-visible canonical form (`/Users/…` on macOS) — the one
/// spelling every persisted key and cross-path comparison agrees on. The inner
/// string is private, so a `CanonicalPath` can be produced only by the gateway
/// ([`CanonicalPath::from_raw`]) or by adopting an already-canonical string
/// ([`CanonicalPath::from_canonical`]). A raw path therefore cannot be stored or
/// compared as canonical by construction.
///
/// The gateway is authored ahead of its consumers (the attribution write path
/// and the changeset reconciler); the not-yet-wired surface carries
/// `#[allow(dead_code)]` during rollout, the same way `attribution.rs` and the
/// rest of the crate suppress phased-rollout dead-code.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
#[allow(dead_code)]
pub struct CanonicalPath(Arc<str>);

#[allow(dead_code)]
impl CanonicalPath {
    /// Resolve a raw path to canonical form through the gateway.
    ///
    /// A path already under the user-visible face (`/Users/…`) and any path
    /// whose firmlink/synthetic prefix is in the boot-built [`AliasTable`]
    /// resolve as a pure string rewrite — no filesystem touch. Only an unknown
    /// symlink falls back to [`resolve_to_claude_form`] (one `canonicalize`),
    /// and that result is memoized when it names a directory, so each distinct
    /// project dir is resolved at most once per process.
    pub fn from_raw(path: &Path) -> Self {
        if let Some(hit) = memo()
            .lock()
            .expect("canonical memo mutex")
            .get(path)
            .cloned()
        {
            return hit;
        }

        #[cfg(target_os = "macos")]
        if let Some(s) = path.to_str() {
            // Already the user-visible face — trust as-is (pure string).
            if s == "/Users" || s.starts_with("/Users/") {
                return Self(Arc::from(s));
            }
            // Firmlink / synthetic prefix rewrite from the boot table.
            if let Some(rewritten) = alias_table().rewrite(s) {
                return Self(Arc::from(rewritten.as_str()));
            }
        }

        // Cold fallback: real canonicalization (unknown symlink; all non-macOS
        // paths). Memoize only directories — the bridge resolves many distinct
        // file paths, which must not accrete in the cache.
        let resolved = resolve_to_claude_form(path);
        let cp = Self(Arc::from(resolved.to_string_lossy().as_ref()));
        if resolved.is_dir() {
            memo()
                .lock()
                .expect("canonical memo mutex")
                .insert(path.to_path_buf(), cp.clone());
        }
        cp
    }

    /// Adopt an already-canonical string with no filesystem access — the
    /// counterpart to [`super::feeds::workspace_registry::WorkspaceKey::from_canonical`],
    /// used for strings a prior gateway call already produced and persisted
    /// (e.g. `sessions.workspace_key`). The caller guarantees the string is
    /// canonical; this performs no resolution.
    pub fn from_canonical(s: &str) -> Self {
        Self(Arc::from(s))
    }

    /// Construct directly from a string for tests, bypassing the gateway.
    #[cfg(test)]
    pub fn from_test_str(s: &str) -> Self {
        Self(Arc::from(s))
    }

    /// The canonical path as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The canonical path as a `&Path`.
    pub fn as_path(&self) -> &Path {
        Path::new(&*self.0)
    }
}

/// Per-directory resolution cache (`raw input → CanonicalPath`). Only
/// directories are inserted (see [`CanonicalPath::from_raw`]), so the map is
/// bounded by the number of distinct project dirs / repo roots seen.
#[allow(dead_code)]
fn memo() -> &'static Mutex<HashMap<PathBuf, CanonicalPath>> {
    static MEMO: OnceLock<Mutex<HashMap<PathBuf, CanonicalPath>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Test aid: whether the memo currently holds a resolved entry for `path`.
#[cfg(test)]
fn memo_contains(path: &Path) -> bool {
    memo()
        .lock()
        .expect("canonical memo mutex")
        .contains_key(path)
}

// ---------------------------------------------------------------------------
// macOS: boot-time firmlink/symlink alias table
// ---------------------------------------------------------------------------

/// Firmlink/symlink prefix rewrites, built once at boot from
/// `/etc/synthetic.conf` (symlink entries) and the APFS data-volume firmlink
/// (`/System/Volumes/Data` → the user-visible face). Each rewrite collapses a
/// non-canonical prefix to its `/Users/…` form as a pure string operation, so
/// the gateway never `stat`s a historical project dir on boot — it reads
/// `synthetic.conf` once and stats the data-volume mount once. Rewrites are
/// identity-verified (`same_file`) at build, so applying one later needs no
/// re-verification.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
struct AliasTable {
    /// `(from_prefix, to_prefix)`, longest `from` first so the most specific
    /// prefix wins.
    rewrites: Vec<(String, String)>,
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn alias_table() -> &'static AliasTable {
    static ALIAS_TABLE: OnceLock<AliasTable> = OnceLock::new();
    ALIAS_TABLE.get_or_init(AliasTable::build)
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
impl AliasTable {
    fn build() -> Self {
        let mut rewrites: Vec<(String, String)> = Vec::new();

        // synthetic.conf symlink entries: a two-column `name<TAB>target` line is
        // a symlink `/name` → `target`; collapse the target's data-volume
        // firmlink to the user-visible face and record the rewrite.
        for (from, target) in synthetic_table() {
            let to = resolve_apfs_firmlink_str(target).unwrap_or_else(|| target.clone());
            if same_file(Path::new(from), Path::new(&to)) {
                rewrites.push((from.clone(), to));
            }
        }

        // Data-volume firmlink: `/System/Volumes/Data/<rest>` → `/<rest>`.
        if Path::new("/System/Volumes/Data").exists() {
            rewrites.push(("/System/Volumes/Data".to_string(), String::new()));
        }

        rewrites.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        Self { rewrites }
    }

    /// Rewrite `path`'s longest matching alias prefix, or `None` when no alias
    /// applies. A match on the exact prefix, or on the prefix followed by a
    /// path separator, is rewritten; a partial component (`/Userspace` under
    /// `/Users`) is not.
    fn rewrite(&self, path: &str) -> Option<String> {
        for (from, to) in &self.rewrites {
            if path == from {
                return Some(if to.is_empty() {
                    "/".to_string()
                } else {
                    to.clone()
                });
            }
            if let Some(rest) = path.strip_prefix(from) {
                if rest.starts_with('/') {
                    return Some(format!("{to}{rest}"));
                }
            }
        }
        None
    }
}

impl PathResolver {
    /// Create a resolver from a user-provided path.
    ///
    /// Resolves through symlinks, synthetic firmlinks (macOS), APFS data
    /// volume firmlinks, and Linux bind mounts to find the form that the
    /// OS file watching API accepts. All resolution is verified with
    /// (dev, ino) identity comparison.
    pub fn new(path: PathBuf) -> Self {
        #[cfg(unix)]
        let identity = get_identity(&path).unwrap_or((0, 0));

        let mut seen = HashSet::new();
        seen.insert(path.clone());

        // Phase 1: resolve symlinks via canonicalize.
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        seen.insert(canonical.clone());

        // Phase 2: resolve synthetic firmlinks (macOS).
        #[cfg(target_os = "macos")]
        let synthetic_resolved = resolve_synthetic(&path);
        #[cfg(not(target_os = "macos"))]
        let synthetic_resolved: Option<PathBuf> = None;

        if let Some(ref sr) = synthetic_resolved {
            seen.insert(sr.clone());
        }

        // Phase 3: resolve APFS data volume firmlinks (macOS).
        #[cfg(target_os = "macos")]
        let firmlink_resolved = resolve_apfs_firmlink(&canonical);
        #[cfg(not(target_os = "macos"))]
        let firmlink_resolved: Option<PathBuf> = None;

        if let Some(ref fr) = firmlink_resolved {
            seen.insert(fr.clone());
        }

        // Phase 4: resolve Linux bind mounts.
        #[cfg(target_os = "linux")]
        let bind_resolved = resolve_bind_mounts(&path);
        #[cfg(not(target_os = "linux"))]
        let bind_resolved: Option<PathBuf> = None;

        if let Some(ref br) = bind_resolved {
            seen.insert(br.clone());
        }

        // Choose the primary (the form to register with the watcher) via the
        // shared resolver, so the synthetic > firmlink > canonical priority
        // lives in exactly ONE place ([`resolve_to_claude_form`]) and the
        // FSEvents watch path can never drift from the Claude form the ledger
        // scan resolves to. `resolve_to_claude_form` recomputes the pieces
        // above, but `PathResolver::new` is cold (once per workspace), so the
        // duplicate stat is immaterial — coherence wins. The pieces computed
        // above are still used to build `alt_prefixes`.
        let primary = resolve_to_claude_form(&path);

        // Build alt_prefixes from all discovered forms except the primary.
        let alt_prefixes: Vec<PathBuf> = seen.into_iter().filter(|p| *p != primary).collect();

        // Check for autofs.
        #[cfg(target_os = "macos")]
        let is_autofs = check_autofs(&primary);
        #[cfg(not(target_os = "macos"))]
        let is_autofs = false;

        info!(
            original = %path.display(),
            primary = %primary.display(),
            alt_count = alt_prefixes.len(),
            is_autofs,
            "PathResolver initialized"
        );
        for alt in &alt_prefixes {
            debug!(alt = %alt.display(), "PathResolver alt prefix");
        }

        Self {
            original: path,
            primary,
            #[cfg(unix)]
            identity,
            alt_prefixes: Mutex::new(alt_prefixes),
            is_autofs,
        }
    }

    /// The resolved path to register with FSEvents/inotify.
    pub fn watch_path(&self) -> &Path {
        &self.primary
    }

    /// The original path as provided by the caller.
    #[allow(dead_code)]
    pub fn original_path(&self) -> &Path {
        &self.original
    }

    /// Convert an absolute event path to a relative path string.
    ///
    /// Tries strip_prefix against all known path forms (fast path), then
    /// falls back to inode-based resolution for unknown forms.
    pub fn to_relative(&self, abs_path: &Path) -> Option<String> {
        // Fast path: try primary.
        if let Ok(rel) = abs_path.strip_prefix(&self.primary) {
            return Some(rel.to_string_lossy().to_string());
        }

        // Try alt prefixes.
        if let Ok(alts) = self.alt_prefixes.lock() {
            for alt in alts.iter() {
                if let Ok(rel) = abs_path.strip_prefix(alt) {
                    return Some(rel.to_string_lossy().to_string());
                }
            }
        }

        // Slow path: inode-based resolution.
        #[cfg(unix)]
        if let Some(discovered) = self.resolve_by_inode(abs_path) {
            if let Ok(rel) = abs_path.strip_prefix(&discovered) {
                if let Ok(mut alts) = self.alt_prefixes.lock() {
                    if !alts.contains(&discovered) {
                        info!(
                            discovered = %discovered.display(),
                            "PathResolver discovered alt prefix via inode"
                        );
                        alts.push(discovered);
                    }
                }
                return Some(rel.to_string_lossy().to_string());
            }
        }

        // For removed files: try the parent (file is gone, can't stat it).
        if let (Some(parent), Some(file_name)) = (abs_path.parent(), abs_path.file_name()) {
            if let Some(rel_parent) = self.to_relative(parent) {
                let rel = PathBuf::from(rel_parent).join(file_name);
                return Some(rel.to_string_lossy().to_string());
            }
        }

        None
    }

    /// Walk up the path's parent chain looking for a directory with the
    /// same (device, inode) as our watch directory.
    #[cfg(unix)]
    fn resolve_by_inode(&self, path: &Path) -> Option<PathBuf> {
        let (target_dev, target_ino) = self.identity;
        if target_dev == 0 && target_ino == 0 {
            return None;
        }

        let mut ancestor = path.to_path_buf();
        loop {
            if !ancestor.pop() {
                return None;
            }
            if let Some(id) = get_identity(&ancestor) {
                if id == (target_dev, target_ino) {
                    return Some(ancestor);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// Identity and the macOS firmlink resolvers live alongside the gateway in
/// [`tugcore::pathform`]; `PathResolver` and the alias table share them, so
/// there is one implementation rather than a watcher-side copy.
#[cfg(unix)]
pub use tugcore::pathform::{get_identity, same_file};

#[cfg(target_os = "macos")]
use tugcore::pathform::{
    resolve_apfs_firmlink, resolve_apfs_firmlink_str, resolve_synthetic, synthetic_table,
};

// ---------------------------------------------------------------------------
// macOS: autofs detection
// ---------------------------------------------------------------------------

/// Check whether a path is under an autofs mount using statfs(2).
#[cfg(target_os = "macos")]
fn check_autofs(path: &Path) -> bool {
    use std::ffi::CString;
    let c_path = match CString::new(path.to_string_lossy().as_bytes()) {
        Ok(p) => p,
        Err(_) => return false,
    };
    unsafe {
        let mut stat: libc::statfs = std::mem::zeroed();
        if libc::statfs(c_path.as_ptr(), &mut stat) == 0 {
            // autofs filesystem type name on macOS
            let fstypename = std::ffi::CStr::from_ptr(stat.f_fstypename.as_ptr());
            if let Ok(name) = fstypename.to_str() {
                return name == "autofs";
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Linux: bind mount resolution
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn resolve_bind_mounts(path: &Path) -> Option<PathBuf> {
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").ok()?;

    for line in mountinfo.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let mount_point = fields[4];
        if path.starts_with(mount_point) && mount_point != "/" {
            let dev = fields[2];
            for other_line in mountinfo.lines() {
                let other_fields: Vec<&str> = other_line.split_whitespace().collect();
                if other_fields.len() < 5 {
                    continue;
                }
                if other_fields[2] == dev && other_fields[4] != mount_point {
                    let alt_mount = other_fields[4];
                    let rest = path.strip_prefix(mount_point).ok()?;
                    let alt_path = PathBuf::from(alt_mount).join(rest);
                    if alt_path.exists() && same_file(path, &alt_path) {
                        return Some(alt_path);
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
fn resolve_bind_mounts(_path: &Path) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression pin for the firmlink bug class. A path reached through a
    /// macOS `synthetic.conf` symlink (e.g. `/u`) must resolve to the
    /// firmlink-*collapsed* Claude form (`/Users/…`), never the
    /// firmlink-*expanded* form (`/System/Volumes/Data/Users/…`) that a bare
    /// `canonicalize` yields. When the two diverge, every lookup keyed on
    /// Claude's on-disk `~/.claude/projects/<encoded-cwd>` directory breaks
    /// silently — terminal-created sessions vanish from the picker, trash
    /// no-ops. This fails the moment `resolve_to_claude_form` regresses to
    /// plain `canonicalize`.
    #[cfg(target_os = "macos")]
    #[test]
    fn synthetic_path_resolves_to_firmlink_collapsed_claude_form() {
        const DATA_PREFIX: &str = "/System/Volumes/Data";
        let Ok(conf) = std::fs::read_to_string("/etc/synthetic.conf") else {
            eprintln!("skip: no /etc/synthetic.conf on this host");
            return;
        };

        let mut exercised = false;
        for line in conf.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() < 2 {
                continue;
            }
            let syn_root = PathBuf::from(format!("/{}", parts[0].trim()));
            if !syn_root.exists() {
                continue;
            }

            let resolved = resolve_to_claude_form(&syn_root);
            let resolved_str = resolved.to_string_lossy();

            // The whole point: the resolved form is the user-visible,
            // firmlink-collapsed path — never the data-volume expansion.
            assert!(
                !resolved_str.starts_with(DATA_PREFIX),
                "resolve_to_claude_form({}) must collapse the APFS firmlink, got {resolved_str}",
                syn_root.display(),
            );
            // And it must still point at the very same directory.
            assert!(
                same_file(&syn_root, &resolved),
                "resolved form {} is not the same directory as {}",
                resolved.display(),
                syn_root.display(),
            );
            // Document the divergence this function exists to fix: a bare
            // canonicalize WOULD expand the firmlink on a synthetic root, and
            // the resolver must NOT agree with it in that case.
            if let Ok(canon) = syn_root.canonicalize() {
                if canon.to_string_lossy().starts_with(DATA_PREFIX) {
                    assert_ne!(
                        canon, resolved,
                        "resolver must diverge from canonicalize when canonicalize expands the firmlink",
                    );
                }
            }
            exercised = true;
            break;
        }

        if !exercised {
            eprintln!("skip: no usable synthetic.conf entry on this host");
        }
    }

    /// On a plain real directory with no synthetic/firmlink involvement, the
    /// Claude form equals `canonicalize` — the resolver is a faithful no-op
    /// there, so non-firmlinked projects are unaffected.
    #[test]
    fn plain_directory_matches_canonicalize() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_to_claude_form(tmp.path());
        let canon = tmp.path().canonicalize().unwrap();
        assert_eq!(resolved, canon);
    }

    /// The gateway collapses a symlink and its real target to one canonical
    /// form, and memoizes the resolved directory so a second resolve is a
    /// cache hit rather than a fresh `canonicalize`.
    #[test]
    fn gateway_collapses_symlink_alias_without_fs_after_warmup() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let via_link = CanonicalPath::from_raw(&link);
        let via_real = CanonicalPath::from_raw(&real);
        assert_eq!(
            via_link, via_real,
            "symlink and real path collapse to one canonical form"
        );

        assert!(memo_contains(&link), "resolved directory is memoized");
        assert_eq!(
            CanonicalPath::from_raw(&link),
            via_link,
            "second resolve returns the memoized value"
        );
    }

    /// A path reached through the APFS data-volume firmlink
    /// (`/System/Volumes/Data/Users/…`) collapses back to its user-visible
    /// `/Users/…` face via the boot alias table — a pure string rewrite.
    #[cfg(target_os = "macos")]
    #[test]
    fn gateway_rewrites_data_volume_prefix() {
        const DATA_PREFIX: &str = "/System/Volumes/Data";
        if !Path::new(DATA_PREFIX).exists() {
            eprintln!("skip: no {DATA_PREFIX} on this host");
            return;
        }
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            eprintln!("skip: no HOME");
            return;
        };
        if !home.starts_with("/Users/") {
            eprintln!("skip: HOME not under /Users");
            return;
        }
        let tmp = tempfile::tempdir_in(&home).unwrap();
        let real = tmp.path();
        let expanded = PathBuf::from(format!("{DATA_PREFIX}{}", real.display()));
        if !expanded.exists() {
            eprintln!("skip: data-volume twin absent for {}", real.display());
            return;
        }
        let collapsed = CanonicalPath::from_raw(&expanded);
        assert_eq!(
            collapsed.as_path(),
            real,
            "data-volume prefix collapses to the /Users face",
        );
    }

    /// On a plain directory with no firmlink/symlink involvement, the gateway
    /// agrees with `resolve_to_claude_form` — non-aliased projects are
    /// unaffected.
    #[test]
    fn gateway_plain_directory_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let via_gateway = CanonicalPath::from_raw(tmp.path());
        let via_resolver = resolve_to_claude_form(tmp.path());
        assert_eq!(via_gateway.as_path(), via_resolver.as_path());
    }

    /// A symlink and its real target share `(dev, ino)`, so `same_file` judges
    /// them equal even though the path strings differ — the reconciliation
    /// primitive the bridge leans on for firmlink-split rows.
    #[cfg(unix)]
    #[test]
    fn same_file_true_across_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(
            same_file(&real, &link),
            "a symlink and its target are the same file"
        );
    }

    /// Two distinct directories are not the same file.
    #[cfg(unix)]
    #[test]
    fn same_file_false_for_distinct_dirs() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        assert!(!same_file(a.path(), b.path()));
    }

    /// A path with no live inode (never created) cannot be stat'd, so
    /// `same_file` is `false` — it is a live-path aid, never a durable key.
    #[cfg(unix)]
    #[test]
    fn same_file_false_for_deleted_path() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = tmp.path().join("gone");
        assert!(!same_file(tmp.path(), &gone));
    }
}
