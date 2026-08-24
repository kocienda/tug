# Robust Path Resolution for File Watching

**Status:** Proposal
**Date:** 2026-04-07
**Prerequisite:** live-file-completion (data pipeline operational, file watcher in place)

---

## Problem

The file watcher receives a directory path from the app (e.g., `--dir /u/src/tugtool`) and must:
1. Register it with the OS file watching API (FSEvents on macOS, inotify on Linux)
2. Receive events with file paths
3. Convert event paths to relative paths (strip the watch directory prefix)
4. Keep the file index (BTreeSet) in sync with the filesystem

This fails when the watch directory path and the event paths use different forms. On macOS, three mechanisms create path aliases:

| Mechanism | Example | `realpath` resolves? | FSEvents fires? |
|-----------|---------|---------------------|-----------------|
| Synthetic firmlink (`synthetic.conf`) | `/u` → `/System/Volumes/Data/Users/kocienda/Mounts/u` | Resolves to `/System/Volumes/Data/...` | **NO** — zero events for synthetic paths |
| APFS firmlink (system) | `/Users` ↔ `/System/Volumes/Data/Users` | Does NOT resolve | Events fire for `/Users/...` but **NOT** for `/System/Volumes/Data/Users/...` |
| Symlink | `/var` → `/private/var` | Resolves to `/private/var` | Events fire but report `/private/var` form |

On Linux, bind mounts create analogous aliases: `/home` may be bind-mounted from `/data/home`. `realpath` does NOT resolve bind mounts. `inotify` reports paths using the registered form (no rewriting).

### Root cause (proven by spike)

`/etc/synthetic.conf` on this machine:
```
u	/System/Volumes/Data/Users/kocienda/Mounts/u
```

Tug.app passes `--dir /u/src/tugtool`. FSEvents does not fire events for paths registered via synthetic firmlinks. The canonical form (`/System/Volumes/Data/...`) also doesn't work. Only the intermediate firmlink form (`/Users/kocienda/Mounts/u/src/tugtool`) works — verified by spike program.

### Spike results

| Registered path | Events fire? | Event path form |
|----------------|-------------|-----------------|
| `/u/src/tugtool/spike-files` | **NO** | — |
| `/System/Volumes/Data/Users/kocienda/Mounts/u/src/tugtool/spike-files` | **NO** | — |
| `/Users/kocienda/Mounts/u/src/tugtool/spike-files` | **YES** | `/Users/kocienda/Mounts/u/src/tugtool/spike-files/file.txt` |
| `/tmp` (symlink) | **YES** | `/private/tmp/file.txt` (resolved symlink target) |

---

## Approach: Multi-phase path resolution

A `PathResolver` that discovers the correct watch-registration form AND can convert any event path form back to a relative path. No hardcoded OS paths. Uses `(dev, ino)` as the fundamental identity.

### Phase 1: Discover the FSEvents-compatible form (construction time)

Starting from the user-provided `watch_dir`:

1. **Resolve symlinks** — `std::fs::canonicalize()` or walk-and-readlink. This handles `/var` → `/private/var` and similar.

2. **Resolve synthetic firmlinks** (macOS only, behind `#[cfg]`):
   - Parse `/etc/synthetic.conf` (world-readable, tab-delimited).
   - If `watch_dir` starts with a synthetic root (e.g., `/u/...`), look up its target.
   - The target is in `/System/Volumes/Data/...` form. Strip the `/System/Volumes/Data` prefix to get the firmlink-accessible form (`/Users/kocienda/Mounts/u/...`).
   - **Verify with `(dev, ino)` comparison** — confirm the resolved form points to the same directory. If not, fall back.

3. **Resolve bind mounts** (Linux only, behind `#[cfg]`):
   - Parse `/proc/self/mountinfo` for bind mounts.
   - If `watch_dir` is under a bind mount, discover alternative mount points.
   - **Verify with `(dev, ino)` comparison**.

4. **Store all known forms**: primary (resolved for FSEvents/inotify registration), plus any alternatives discovered. The primary form is used to register the watcher and for `strip_prefix`. Alternatives are used as fallbacks.

### Phase 2: Event path resolution (per event)

1. **Fast path**: `strip_prefix(primary_watch_dir)`. Works in the common case where the event path uses the registered form.

2. **Fallback**: if strip_prefix fails, try `alt_prefixes` (cached from Phase 1 or discovered lazily).

3. **Inode fallback** (rare, on first mismatch): walk up the event path's parent chain, stat each, find the one with matching `(dev, ino)`. Cache the new prefix form. All future events with that form hit the fast path.

### Phase 3: Multiple path storage for each file

The BTreeSet stores relative paths (e.g., `src/lib/model.ts`). Relative paths are unambiguous — they don't depend on which absolute form the watch directory uses. The resolution happens at the absolute → relative boundary (in `to_relative`), not in the BTreeSet itself.

However, the query response echoes the relative path to the client. The client uses this to construct the file atom value. If the client needs an absolute path, it can prepend the project root (which it knows from `cwd` in session metadata).

---

## Implementation

### New: `PathResolver` struct

```rust
pub struct PathResolver {
    /// The primary watch directory — the form to register with FSEvents/inotify.
    /// This is the form that produces events.
    primary: PathBuf,
    /// (dev, ino) identity of the watch directory.
    #[cfg(unix)]
    identity: (u64, u64),
    /// Alternative path forms discovered lazily. Protected by Mutex for
    /// interior mutability (the resolver is shared via &self).
    alt_prefixes: Mutex<Vec<PathBuf>>,
}
```

### API

```rust
impl PathResolver {
    /// Create a resolver from a user-provided path.
    /// Resolves symlinks, synthetic firmlinks (macOS), and bind mounts (Linux)
    /// to find the form that the OS file watching API accepts.
    pub fn new(path: PathBuf) -> Self;

    /// The resolved path to register with the watcher.
    pub fn watch_path(&self) -> &Path;

    /// Convert an absolute event path to a relative path.
    /// Uses strip_prefix with all known forms, with inode fallback.
    pub fn to_relative(&self, abs_path: &Path) -> Option<String>;
}
```

### macOS synthetic.conf resolution

```rust
#[cfg(target_os = "macos")]
fn resolve_synthetic(path: &Path) -> Option<PathBuf> {
    // Parse /etc/synthetic.conf
    let conf = std::fs::read_to_string("/etc/synthetic.conf").ok()?;
    for line in conf.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 { continue; }
        let syn_root = format!("/{}", parts[0]);
        if path.starts_with(&syn_root) {
            let target = parts[1]; // e.g., /System/Volumes/Data/Users/.../Mounts/u
            let rest = path.strip_prefix(&syn_root).ok()?;
            
            // The target is /System/Volumes/Data/... form.
            // FSEvents wants the form WITHOUT /System/Volumes/Data.
            // Discover it by checking if the target without that prefix
            // exists and has the same (dev, ino).
            let resolved = resolve_data_volume_path(target)?;
            let full = PathBuf::from(resolved).join(rest);
            
            // Verify identity
            if same_identity(path, &full) {
                return Some(full);
            }
        }
    }
    None
}

/// On macOS APFS, /System/Volumes/Data/Users/... and /Users/... are the
/// same directory via firmlink. Discover the shorter form by progressively
/// stripping /System/Volumes/Data from the front and checking (dev, ino).
#[cfg(target_os = "macos")]
fn resolve_data_volume_path(path: &str) -> Option<PathBuf> {
    let svd = "/System/Volumes/Data";
    if path.starts_with(svd) {
        let short = &path[svd.len()..];
        let short_path = PathBuf::from(short);
        if short_path.exists() && same_identity_path(path, &short_path) {
            return Some(short_path);
        }
    }
    Some(PathBuf::from(path))
}
```

### Linux bind mount resolution

```rust
#[cfg(target_os = "linux")]
fn resolve_bind_mounts(path: &Path) -> Option<PathBuf> {
    // Parse /proc/self/mountinfo for bind mounts
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    // Each line: id parent_id major:minor root mount_point options ...
    // Bind mounts have the same major:minor as their source
    // Use (dev, ino) to find alternative paths to the same directory
    // ...
    None // Placeholder — most Linux setups don't need this
}
```

### Identity comparison

```rust
#[cfg(unix)]
fn same_identity(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    ma.dev() == mb.dev() && ma.ino() == mb.ino()
}
```

---

## Where this lives

- `PathResolver` replaces the ad-hoc path handling currently scattered across `FileWatcher::new()`, `convert_event()`, and `strip_to_relative()`.
- `FileWatcher::new()` takes a `PathBuf`, creates a `PathResolver`, and uses `resolver.watch_path()` for the watcher registration and `resolver.to_relative()` for event conversion.
- The resolver is also used by `walk()` for consistent relative path computation.

---

## Test strategy

The spike program (`spike-files/`) provides the real-world test surface:
- `watch-me.txt` — ASCII filename
- `カタカナ.txt` — CJK filename  
- `😉.txt` — emoji filename (astral plane)
- `永樂帝.png` — CJK filename with data

Integration tests (real filesystem, real watcher):
1. Create a temp directory, create files, verify walk finds them.
2. Start FileWatcher + FileTreeFeed, create/remove files, verify events flow and BTreeSet updates.
3. Test with symlink in path (create a temp symlink to a real directory).
4. On macOS: test with the actual project directory (synthetic mount) if available.

Unit tests for PathResolver:
1. `resolve_synthetic` correctly parses `/etc/synthetic.conf` and resolves paths.
2. `to_relative` handles all path forms (synthetic, symlink, canonical, firmlink).
3. Identity comparison with `(dev, ino)`.
4. `is_autofs` detection for automounted paths.

Mount monitor tests:
1. Verify the mount monitor task starts and can detect mount state (read `/proc/self/mountinfo` on Linux, check DiskArbitration session on macOS).
2. Verify recovery: simulate "stale" state, trigger re-walk, confirm BTreeSet is refreshed.

Spike program (`spike-files/`) for manual verification:
- `watch-me.txt` — ASCII filename, basic create/remove cycle
- `カタカナ.txt` — CJK filename
- `😉.txt` — emoji filename (astral plane)
- `永樂帝.png` — CJK filename with data

---

## Runtime mount/unmount detection

When a volume under the watched directory unmounts, FSEvents silently stops delivering events (no error, no notification). On Linux, inotify delivers `IN_UNMOUNT` then auto-removes the watch. On remount, watchers don't recover — the entire watch infrastructure must be torn down and rebuilt.

### Detection mechanism

**macOS — DiskArbitration framework:**

The DiskArbitration framework provides mount/unmount callbacks via a C API callable from Rust through FFI:

```rust
#[cfg(target_os = "macos")]
mod mount_monitor {
    // DARegisterDiskAppearedCallback — fires when a volume mounts
    // DARegisterDiskDisappearedCallback — fires when a volume unmounts
    // DASession scheduled on a dispatch queue or run loop
    //
    // ~50 lines of FFI. Gives us mount point path, volume name, BSD device.
}
```

Alternative (simpler, less precise): watch `/Volumes` with FSEvents for directory appearance/disappearance.

**Linux — poll `/proc/self/mountinfo`:**

The kernel supports `poll()` on `/proc/self/mountinfo` with `POLLPRI | POLLERR`. When a mount or unmount occurs, `poll()` returns and we re-read the file. inotify does NOT work on procfs — `poll()` is the kernel-supported mechanism.

```rust
#[cfg(target_os = "linux")]
mod mount_monitor {
    // Open /proc/self/mountinfo
    // poll() with POLLPRI | POLLERR
    // On wake: re-read, diff against previous state
    // ~30 lines. Gives us mount point, filesystem type, device.
}
```

### Recovery strategy

When a mount change affects the watched directory:

1. **Unmount detected**: mark the FileWatcher as stale. Stop processing events (they won't arrive anyway). The BTreeSet retains its current state.
2. **Remount detected**: re-walk the directory via `FileWatcher::walk()`. Replace the BTreeSet. Restart the `notify` watcher with a fresh registration. This is the same "re-walk to recover" pattern used for `RecvError::Lagged`.
3. **Unrelated mount**: ignore (the mount point doesn't overlap with our watch path).

The `PathResolver` checks at construction whether the watch path crosses any mount boundaries. The mount monitor runs as a background task alongside the FileWatcher, sharing the `CancellationToken`.

---

## Automount handling (macOS `auto_home`)

On enterprise Macs, `/Users/username` may be an automounted network share via the `auto_home` map. The automount is triggered on first access and unmounts after an inactivity timeout (default 60 minutes, configurable in `/etc/autofs.conf`). If the target is a local APFS volume, FSEvents works transparently. If it's a network share, FSEvents doesn't fire (network filesystem limitation).

### Detection

```rust
#[cfg(target_os = "macos")]
fn is_autofs(path: &Path) -> bool {
    // statfs() on the path — check f_fstypename for "autofs"
    // Or: parse mount output for "autofs" / "map auto_home"
}
```

Also parse `/etc/auto_master` and referenced map files (`/etc/auto_home`) to understand which paths are automount-controlled.

### Keep-alive strategy

The key risk: the automount expires while we're actively watching, causing silent event cessation. To prevent this:

1. **Keep a file descriptor open** on the watched directory. An open fd prevents the automount from unmounting (the mount stays "busy"). This is a single `File::open()` held for the lifetime of the FileWatcher.

2. **Detect autofs at construction**. If the watch path is under an autofs mount, open the keep-alive fd immediately and log it.

3. **Integrate with mount monitoring**. If the mount monitor detects the autofs mount dropped (despite the keep-alive — e.g., forced unmount), trigger the re-walk recovery.

### Design impact

The `PathResolver` gains an optional `_keepalive_fd: Option<File>` field. If the watch path is under autofs, it opens the directory and holds the fd. On drop, the fd closes and the automount may eventually expire (which is fine — we're shutting down).

---

## What this does NOT do

- NFS or network filesystem watching (FSEvents and inotify don't support remote filesystems — known limitation, not a target audience for Tug)
- Windows path resolution (future work when Windows support is needed)
