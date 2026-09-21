//! `tugtool file run` — run a command that rewrites files, and receipt exactly
//! what it moved.
//!
//! This is the inverse of `file probe`. A probe patches, runs, and restores, so
//! it changed nothing and prints no receipt. A run keeps what the command did
//! and testifies to it.
//!
//! It exists for the class of edit no grammar can read and no edit program can
//! carry: the **in-place rewriter**. `cargo fmt -p tugedit-core` names no file at all —
//! cargo discovers them from the crate's module tree — and `rustfmt a.rs b.rs`,
//! `prettier --write`, and `eslint --fix` are not in `shell_ops`'s set of
//! mutating commands, so all of them reach the ledger as a `bash` bracket hint
//! and land in UNATTRIBUTED. An edit program cannot stand in for them either:
//! it carries bytes the model authored, and a formatter's output is not known
//! until the formatter has run.
//!
//! The receipt is earned rather than asserted. The verb fingerprints every file
//! in the changeable universe before the command and again after, and names
//! only the paths whose **content** actually differs — so a tool that touches a
//! file without changing it mints nothing, and a tool that rewrites one whose
//! mtime it preserves is still caught. That is what makes this proof rather
//! than the correlation a bracket offers: the session ran the command through a
//! verb that watched it, and rows are relay-local, so the claim can only ever
//! be about itself.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::changes::AppError;
use tugtool::receipt::{Receipt, current_hunk_ids, hunks_this_edit_produced};

/// One file's content identity, before or after the command. Ordered, so the
/// receipt names files in a stable order rather than a hash-random one.
type Fingerprints = BTreeMap<PathBuf, [u8; 32]>;

pub fn run_run(scopes: &[String], command: &[String]) -> Result<(), AppError> {
    let Some((program, args)) = command.split_first() else {
        return Err(AppError::Exit1(
            "no command to run — pass it after `--`".to_string(),
        ));
    };

    let root = repo_root()?;
    let scope_filter = resolve_scopes(&root, scopes)?;

    let before = fingerprint_universe(&root, &scope_filter)?;
    // The hunk ids each file already carried, so the receipt can name only the
    // regions this run produced — the same rule `file edit` follows.
    let hunks_before: HashMap<PathBuf, Vec<String>> = before
        .keys()
        .map(|path| (path.clone(), current_hunk_ids(path)))
        .collect();

    let status = super::file_probe::run_child(program, args);

    let after = fingerprint_universe(&root, &scope_filter)?;

    let mut receipt = Receipt::default();
    let mut moved = 0usize;
    for (path, digest) in &after {
        match before.get(path) {
            Some(was) if was == digest => {}
            Some(_) => {
                let empty = Vec::new();
                let was = hunks_before.get(path).unwrap_or(&empty);
                receipt.modified(path, hunks_this_edit_produced(path, was));
                moved += 1;
            }
            None => {
                receipt.created(path);
                moved += 1;
            }
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            receipt.deleted(path);
            moved += 1;
        }
    }

    // Emitted whatever the command's own verdict: bytes that moved are bytes
    // that moved, and a half-finished formatter's output is still this
    // session's to answer for.
    if moved > 0 {
        receipt.emit();
    }

    match status {
        Ok(0) => Ok(()),
        Ok(code) => Err(AppError::ExitStatus(code)),
        Err(err) => Err(AppError::Exit1(err)),
    }
}

/// The repository root, which is both the default scope and the directory the
/// universe is enumerated from.
fn repo_root() -> Result<PathBuf, AppError> {
    let out = tugcore::git_command()
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| AppError::Exit1(format!("git: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Exit1(
            "not inside a git repository — `file run` needs one to scope the universe".to_string(),
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(PathBuf::from(text))
}

/// Absolute scope prefixes, or an empty vec meaning the whole repository.
fn resolve_scopes(root: &Path, scopes: &[String]) -> Result<Vec<PathBuf>, AppError> {
    let mut out = Vec::new();
    for scope in scopes {
        let path = super::file::absolute(Path::new(scope));
        if !path.starts_with(root) {
            return Err(AppError::Exit1(format!(
                "{}: outside the repository, so nothing in it could be receipted",
                path.display()
            )));
        }
        out.push(path);
    }
    Ok(out)
}

/// Every file the command could change, fingerprinted by content.
///
/// The universe is git's own — tracked files plus untracked ones git does not
/// ignore, the same set the read side classifies — so a build directory or a
/// target tree costs nothing to run this over.
fn fingerprint_universe(root: &Path, scopes: &[PathBuf]) -> Result<Fingerprints, AppError> {
    // This read was `-z` before the door existed, and it decoded lossily —
    // which would have turned an undecodable name into a *different*,
    // nonexistent path and fingerprinted nothing under it. The door refuses
    // that substitution instead ([B06]).
    let listed = tugchanges_core::read_paths(
        root,
        &["ls-files", "--cached", "--others", "--exclude-standard"],
    )
    .map_err(|e| AppError::Exit1(format!("git ls-files: {e}")))?;

    let mut map = Fingerprints::new();
    for rel in listed {
        let path = root.join(rel);
        if !scopes.is_empty() && !scopes.iter().any(|s| path.starts_with(s) || path == *s) {
            continue;
        }
        // A path git lists but that is not readable now — a broken symlink, a
        // file removed between the listing and the read — is simply not in the
        // universe. It cannot be proven either way, so it is not claimed.
        if let Ok(bytes) = std::fs::read(&path) {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            map.insert(path, hasher.finalize().into());
        }
    }
    Ok(map)
}
