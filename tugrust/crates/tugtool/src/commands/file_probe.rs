//! `tugtool file probe` — apply a patch, run a command against it, put the tree
//! back exactly as it was.
//!
//! This is the shape most shell-authored edits are actually reaching for: patch
//! a token, run one test, revert. Done in the shell that is three commands, the
//! middle one of which is unreadable to the attribution grammar and the last of
//! which (`git checkout --`) destroys any uncommitted work that was already
//! there.
//!
//! A probe that restores changed nothing, so the correct record of one is **no
//! record** — and the way it earns that is by **saying so**. The restore is
//! declared on stdout as `TUG-FILE-RECEIPT: {"restored":[…]}`, and the relay
//! drops its Bash-bracket delta rows for exactly those paths. Routing a probe
//! through this verb therefore removes a false `bash` hint that doing it by
//! hand creates.
//!
//! **It used to earn it by restoring the original `mtime` too**, so the relay's
//! status+mtime fingerprint read identical across the bracket and had nothing
//! to report. That worked on the relay and was a lie to everything else: every
//! build system decides staleness by mtime, and rewinding a source *below* the
//! artifact built from it is the one direction cargo cannot see. A probe would
//! compile the patched bytes, rewind the clock under them, and leave a stale
//! rlib behind a tree that looked clean — after which `cargo build` printed
//! `Finished` having compiled nothing and `nextest` ran the pre-probe binary
//! (2026-09-14). Declaring the restore keeps the ledger quiet on the one axis
//! that was ever at stake and lets the filesystem tell the truth.

use std::ffi::c_int;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::SystemTime;

use crate::changes::AppError;
use crate::commands::file::{absolute, normalize};

/// The running child's pid, for the signal handler to forward to. Zero when no
/// child is running.
static PROBE_CHILD: AtomicI32 = AtomicI32::new(0);

/// Forward a terminating signal to the child rather than dying on it, so the
/// wait below returns and the restore still runs. `kill` is async-signal-safe;
/// nothing else here needs to be.
extern "C" fn forward_to_child(sig: c_int) {
    let pid = PROBE_CHILD.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

/// One file the probe is responsible for putting back.
struct Saved {
    /// Where it lives in the tree.
    target: PathBuf,
    /// Its bytes, held in the snapshot directory. `None` when the file did not
    /// exist — restoring it means removing whatever the patch created.
    stored: Option<PathBuf>,
}

/// Every file the probe touched, and where the originals are held.
struct Snapshot {
    dir: PathBuf,
    files: Vec<Saved>,
}

impl Snapshot {
    fn take(dir: PathBuf, targets: &[PathBuf]) -> Result<Self, AppError> {
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Exit1(format!("{}: {e}", dir.display())))?;

        let mut files = Vec::new();
        for (index, target) in targets.iter().enumerate() {
            if !target.exists() {
                files.push(Saved {
                    target: target.clone(),
                    stored: None,
                });
                continue;
            }
            // Indexed rather than named after the target, so two targets with
            // the same file name cannot collide in the snapshot directory.
            let stored = dir.join(format!("{index}.orig"));
            std::fs::copy(target, &stored)
                .map_err(|e| AppError::Exit1(format!("{}: {e}", target.display())))?;
            files.push(Saved {
                target: target.clone(),
                stored: Some(stored),
            });
        }
        Ok(Snapshot { dir, files })
    }

    /// Put every target back byte-identical and remove the files the patch
    /// created, returning the paths whose bytes were restored — the receipt's
    /// `restored` list. Reports every path it could not restore rather than
    /// stopping at the first.
    ///
    /// The mtime is deliberately left at now. See the module doc: rewinding it
    /// is what made a probe leave stale build artifacts, and the hint it used
    /// to suppress is suppressed by the declaration instead.
    fn restore(&self) -> Result<Vec<PathBuf>, String> {
        let mut failures = Vec::new();
        let mut restored = Vec::new();
        for saved in &self.files {
            match &saved.stored {
                Some(stored) => {
                    if let Err(err) = std::fs::copy(stored, &saved.target) {
                        failures.push(format!("{}: {err}", saved.target.display()));
                        continue;
                    }
                    // **The mtime is bumped deliberately, and the bump is the
                    // whole fix.** Dropping the old explicit rewind was not
                    // enough: `fs::copy` is `fcopyfile` on macOS and carries
                    // the source's mtime, and the source here is the snapshot
                    // taken *before* the patch — so the original time came
                    // back through the copy whether anyone asked for it or
                    // not. A source that reads older than the artifact built
                    // from it is the one staleness direction cargo cannot
                    // see, so the restore has to say "now" out loud.
                    let _ = std::fs::OpenOptions::new()
                        .write(true)
                        .open(&saved.target)
                        .and_then(|f| f.set_modified(SystemTime::now()));
                    restored.push(saved.target.clone());
                }
                None => {
                    if saved.target.exists() {
                        if let Err(err) = std::fs::remove_file(&saved.target) {
                            failures.push(format!("{}: {err}", saved.target.display()));
                        }
                    }
                }
            }
        }
        if failures.is_empty() {
            let _ = std::fs::remove_dir_all(&self.dir);
            Ok(restored)
        } else {
            Err(failures.join("; "))
        }
    }
}

/// Holds the snapshot for the duration of the probe. `restore_now` is called on
/// every normal path; the `Drop` is the backstop for a panic, so no exit short
/// of `SIGKILL` leaves the tree carrying the patch.
struct Restorer {
    snapshot: Snapshot,
    done: bool,
}

impl Restorer {
    fn restore_now(&mut self) -> Result<(), String> {
        if self.done {
            return Ok(());
        }
        self.done = true;
        let restored = self.snapshot.restore()?;
        // The declaration, printed once and only when something was actually
        // put back. It is the whole of what makes a probe recordless: the
        // relay reads it off this Bash result and drops the bracket's rows for
        // these paths. Printed even when the probed command failed — the
        // restore happened either way, and the relay honours it either way.
        if !restored.is_empty() {
            let paths: Vec<String> = restored
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            println!(
                "TUG-FILE-RECEIPT: {}",
                serde_json::json!({ "ops": [], "restored": paths })
            );
        }
        Ok(())
    }
}

impl Drop for Restorer {
    fn drop(&mut self) {
        if let Err(err) = self.restore_now() {
            eprintln!(
                "error: probe could not restore {err}\n\
                 error: the originals are in {}",
                self.snapshot.dir.display()
            );
        }
    }
}

pub fn run_probe(
    patch: Option<String>,
    extra_paths: &[String],
    command: &[String],
) -> Result<(), AppError> {
    let Some((program, args)) = command.split_first() else {
        return Err(AppError::Exit1(
            "no command to run — pass it after `--`".to_string(),
        ));
    };

    let patch_text = match &patch {
        Some(source) => Some(read_patch(source)?),
        None => None,
    };

    let mut targets: Vec<PathBuf> = Vec::new();
    if let Some(text) = &patch_text {
        targets.extend(patch_targets(text));
    }
    for path in extra_paths {
        targets.push(absolute(Path::new(path)));
    }
    targets.sort();
    targets.dedup();

    if targets.is_empty() {
        return Err(AppError::Exit1(
            "the patch names no files and no --path was given — nothing to protect".to_string(),
        ));
    }

    // Validate before touching anything: a patch that will not apply must leave
    // the tree exactly as it found it.
    if let Some(text) = &patch_text {
        git_apply(text, true)?;
    }

    let dir = std::env::temp_dir().join(format!("tug-probe-{}", std::process::id()));
    let snapshot = Snapshot::take(dir, &targets)?;
    let mut restorer = Restorer {
        snapshot,
        done: false,
    };

    if let Some(text) = &patch_text {
        if let Err(err) = git_apply(text, false) {
            // The patch checked out and then failed anyway — restore before
            // reporting, so the caller is never handed a half-patched tree.
            restore_or_report(&mut restorer)?;
            return Err(err);
        }
    }

    let status = run_child(program, args);

    // The child is done, so the patch has served its purpose. Restore first and
    // report second: a restore failure outranks the child's own verdict.
    restore_or_report(&mut restorer)?;

    match status {
        Ok(0) => Ok(()),
        Ok(code) => Err(AppError::ExitStatus(code)),
        Err(err) => Err(AppError::Exit1(err)),
    }
}

fn restore_or_report(restorer: &mut Restorer) -> Result<(), AppError> {
    restorer.restore_now().map_err(|err| {
        AppError::Exit1(format!(
            "probe could not restore {err}\nthe originals are in {}",
            restorer.snapshot.dir.display()
        ))
    })
}

/// Run the command with stdio inherited — its output is its own, passed through
/// unchanged so the probe composes wherever the shell form it replaces did.
pub(super) fn run_child(program: &str, args: &[String]) -> Result<u8, String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;

    PROBE_CHILD.store(child.id() as i32, Ordering::SeqCst);
    let previous = install_signal_handlers();

    let status = child.wait();

    restore_signal_handlers(previous);
    PROBE_CHILD.store(0, Ordering::SeqCst);

    let status = status.map_err(|e| format!("{program}: {e}"))?;
    match status.code() {
        Some(code) => Ok(code.clamp(0, 255) as u8),
        // Killed by a signal. Report the shell's convention so a ^C'd probe
        // does not read as success.
        None => Ok(130),
    }
}

fn install_signal_handlers() -> [libc::sighandler_t; 2] {
    let handler = forward_to_child as extern "C" fn(c_int) as *const () as libc::sighandler_t;
    unsafe {
        [
            libc::signal(libc::SIGINT, handler),
            libc::signal(libc::SIGTERM, handler),
        ]
    }
}

fn restore_signal_handlers(previous: [libc::sighandler_t; 2]) {
    unsafe {
        libc::signal(libc::SIGINT, previous[0]);
        libc::signal(libc::SIGTERM, previous[1]);
    }
}

/// Read the diff from a file, or from stdin when the source is `-`.
pub(super) fn read_patch(source: &str) -> Result<String, AppError> {
    if source == "-" {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| AppError::Exit1(format!("stdin: {e}")))?;
        return Ok(buf);
    }
    std::fs::read_to_string(source).map_err(|e| AppError::Exit1(format!("{source}: {e}")))
}

/// Every path the patch will touch, resolved against the current directory —
/// which is where `git apply` resolves them too.
///
/// Two sources, unioned, because neither alone is complete and the cost of
/// asymmetry is not symmetric: a path this misses is a file the probe will
/// **not put back**, while a path it over-reports costs one temp-file copy and
/// yields no receipt op. So it is deliberately a superset.
///
/// - `git apply --numstat` is git's own answer to "what does this patch
///   touch", so it sees the entries that carry no hunks at all — a mode-only
///   change is nothing but `old mode`/`new mode` lines — and it resolves paths
///   exactly the way the real apply will.
/// - The header parse supplies what `--numstat` omits: a rename reports only
///   its *destination* there, and the source is precisely the file that
///   disappears.
pub(super) fn patch_targets(patch: &str) -> Vec<PathBuf> {
    let mut out = git_numstat_targets(patch);
    for path in declared_patch_paths(patch) {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// Ask `git apply` which paths the patch touches. Empty when git cannot read
/// the patch at all — the header parse then stands alone, and `git_apply`'s own
/// `--check` reports the real error a moment later.
fn git_numstat_targets(patch: &str) -> Vec<PathBuf> {
    let Some(output) = git_apply_stdout(patch, &["--numstat", "-z"]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // Records are `<added>\t<deleted>\t<path>`, NUL-terminated. `-z` means the
    // path is verbatim, so a name with spaces or quotes needs no unescaping.
    for record in output.split('\0') {
        let Some(raw) = record.splitn(3, '\t').nth(2) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let resolved = normalize(&absolute(Path::new(raw)));
        if !out.contains(&resolved) {
            out.push(resolved);
        }
    }
    out
}

/// The paths a diff's own headers name.
///
/// Both sides of `---`/`+++` are read, not just `+++`: a deletion's `+++` is
/// `/dev/null` and the file that has to be protected is the one on the `---`
/// side. `rename from`/`copy from` are read for the same reason — they name a
/// file that is about to stop existing, and a 100%-similarity rename carries no
/// `---`/`+++` lines to find it by.
fn declared_patch_paths(patch: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |raw: &str, strip_prefix: bool| {
        if raw.is_empty() || raw == "/dev/null" {
            return;
        }
        // `---`/`+++` carry the `a/`/`b/` prefix `git apply` strips by default
        // (`-p1`); `rename from`/`copy from` are already repo-relative.
        let path = if strip_prefix {
            match raw.split_once('/') {
                Some((_, rest)) if !rest.is_empty() => rest,
                _ => raw,
            }
        } else {
            raw
        };
        let resolved = normalize(&absolute(Path::new(path)));
        if !out.contains(&resolved) {
            out.push(resolved);
        }
    };

    for line in patch.lines() {
        if let Some(rest) = line
            .strip_prefix("+++ ")
            .or_else(|| line.strip_prefix("--- "))
        {
            // `git diff` appends a tab and a timestamp on some producers.
            push(rest.split('\t').next().unwrap_or(rest).trim(), true);
        } else if let Some(rest) = line
            .strip_prefix("rename from ")
            .or_else(|| line.strip_prefix("rename to "))
            .or_else(|| line.strip_prefix("copy from "))
            .or_else(|| line.strip_prefix("copy to "))
        {
            push(rest.trim_end(), false);
        }
    }
    out
}

/// Run `git apply <args>` over the patch and return its stdout, or `None` when
/// git rejected it.
fn git_apply_stdout(patch: &str, args: &[&str]) -> Option<String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = std::process::Command::new("git")
        .arg("apply")
        .args(args)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(patch.as_bytes()).ok()?;
    let output = child.wait_with_output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Apply the diff with git, or just validate it when `check_only`.
pub(super) fn git_apply(patch: &str, check_only: bool) -> Result<(), AppError> {
    run_git_apply(patch, check_only, false)
}

/// Apply the diff to the **index** (`--cached`), leaving the working tree
/// alone, or just validate it when `check_only`.
pub(super) fn git_apply_cached(patch: &str, check_only: bool) -> Result<(), AppError> {
    run_git_apply(patch, check_only, true)
}

fn run_git_apply(patch: &str, check_only: bool, cached: bool) -> Result<(), AppError> {
    use std::io::Write;
    use std::process::Stdio;

    let mut command = std::process::Command::new("git");
    command.arg("apply");
    if check_only {
        command.arg("--check");
    }
    if cached {
        command.arg("--cached");
    }
    command
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| AppError::Exit1(format!("git apply: {e}")))?;
    child
        .stdin
        .take()
        .ok_or_else(|| AppError::Exit1("git apply: no stdin".to_string()))?
        .write_all(patch.as_bytes())
        .map_err(|e| AppError::Exit1(format!("git apply: {e}")))?;

    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Exit1(format!("git apply: {e}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Exit1(format!(
            "git apply: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_patch_names_both_sides_and_ignores_dev_null() {
        let patch = "\
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-a
+b
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+fresh
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-old
";
        let targets = declared_patch_paths(patch);
        let names: Vec<String> = targets
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["x.ts", "new.ts", "gone.ts"]);
        assert!(targets.iter().all(|p| p.is_absolute()));
    }

    #[test]
    fn one_leading_component_is_stripped_exactly_as_git_apply_strips_it() {
        // `git apply` defaults to `-p1` whatever the first component is called,
        // so the snapshot has to resolve the same way or it would protect a
        // path the patch never writes.
        let targets = declared_patch_paths("--- src/x.ts\n+++ src/x.ts\n");
        assert_eq!(targets.len(), 1);
        assert!(targets[0].ends_with("x.ts"), "got {:?}", targets[0]);
    }

    #[test]
    fn a_rename_with_no_hunks_still_names_the_file_that_disappears() {
        // A 100%-similarity rename carries no `---`/`+++` lines at all. Miss
        // the `rename from` side and the probe applies the rename but never
        // puts the original back — a silent, unreported tree mutation.
        let targets = declared_patch_paths(
            "diff --git a/B.txt b/C.txt\nsimilarity index 100%\nrename from B.txt\nrename to C.txt\n",
        );
        let names: Vec<String> = targets
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["B.txt", "C.txt"]);
    }

    #[test]
    fn a_copy_names_both_ends_too() {
        let targets = declared_patch_paths(
            "diff --git a/a.txt b/b.txt\nsimilarity index 100%\ncopy from a.txt\ncopy to b.txt\n",
        );
        assert_eq!(targets.len(), 2);
    }
}
