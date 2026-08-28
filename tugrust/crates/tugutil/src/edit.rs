//! `tugutil file edit` — run an edit program and testify to what it moved.
//!
//! The language lives in `tugedit-core`, which performs no I/O: it reads
//! through a `FileSource` and hands back the content each file would have.
//! This module is the other half — the filesystem source, the atomic write,
//! the exit-code contract, and the receipt, which is the same one
//! the `--patch` mode emits, from the same code.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};

use tugedit_core::{
    FileOutcome, FileSource, OutcomeKind, Program, ResolveErrors, resolve_and_apply, unified_diff,
};

use crate::receipt::{Receipt, current_hunk_ids, hunks_this_edit_produced};

/// Why an edit program stopped, and with which exit status.
///
/// The codes are the contract: `2` is a program the parser refused, `3` is a
/// program whose addresses no longer match the tree, and `4` is a filesystem
/// failure partway through the write — the one case where an edit program is not
/// all-or-nothing, and so the one case that has to say what it did.
#[derive(Debug)]
pub enum EditError {
    /// Nothing about the program could be read (exit 1).
    Usage(String),
    /// A syntax error, named by line and column (exit 2).
    Parse(String),
    /// Addresses that no longer resolve — every one of them (exit 3).
    Resolve(String),
    /// A write that failed partway (exit 4).
    Write(String),
}

impl EditError {
    pub fn exit_code(&self) -> u8 {
        match self {
            EditError::Usage(_) => 1,
            EditError::Parse(_) => 2,
            EditError::Resolve(_) => 3,
            EditError::Write(_) => 4,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            EditError::Usage(m)
            | EditError::Parse(m)
            | EditError::Resolve(m)
            | EditError::Write(m) => m,
        }
    }
}

impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for EditError {}

/// Read a program from a file, or from stdin when the operand is absent or
/// `-` — the heredoc shape the language is built around.
pub fn read_program(source: Option<&str>) -> Result<String, EditError> {
    match source {
        None | Some("-") => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).map_err(|e| {
                EditError::Usage(format!("cannot read the program from stdin: {e}"))
            })?;
            Ok(text)
        }
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| EditError::Usage(format!("cannot read {path}: {e}"))),
    }
}

/// Parse, read, resolve, apply. With `preview`, stop before the write, leaving
/// bytes *and* mtime untouched and emitting no receipt — nothing changed, so
/// the ledger must not say otherwise.
pub fn run(program: &str, preview: bool) -> Result<(), EditError> {
    let parsed = tugedit_core::parse(program)
        .map_err(|e| EditError::Parse(format!("{e}\nnothing was written")))?;
    let tree = Tree::new();
    let outcomes = resolve_and_apply(&parsed, &tree)
        .map_err(|e| EditError::Resolve(nothing_written(&parsed, &e)))?;

    // Byte-identical is not a change: it is neither written nor receipted, and
    // it has no diff to show.
    let moved: Vec<FileOutcome> = outcomes
        .into_iter()
        .filter(|outcome| tree.was_read_as(&outcome.path) != Some(outcome.new_content.clone()))
        .collect();

    for outcome in &moved {
        let before = tree.was_read_as(&outcome.path).unwrap_or_default();
        print!(
            "{}",
            unified_diff(&outcome.path, &before, &outcome.new_content)
        );
    }

    if preview {
        return Ok(());
    }

    let mut receipt = Receipt::default();
    let mut written: Vec<String> = Vec::new();
    let mut failure: Option<String> = None;

    for outcome in &moved {
        let target = absolute(&outcome.path);
        let hunks_before = current_hunk_ids(&target);
        match write_atomically(&target, &outcome.new_content) {
            Ok(()) => {
                written.push(outcome.path.clone());
                match outcome.kind {
                    OutcomeKind::Created => receipt.created(&target),
                    OutcomeKind::Modified => {
                        receipt.modified(&target, hunks_this_edit_produced(&target, &hunks_before))
                    }
                }
            }
            Err(message) => {
                failure = Some(message);
                break;
            }
        }
    }

    // The receipt goes out even when the write failed partway: the files it
    // names did move, and a human reading the transcript needs to know which.
    // The relay reads receipts only from successful results, so an exit 4
    // still costs those files their proof rows — a residual `tugutil file
    // edit` has carried since it shipped, not a gap this closes.
    receipt.emit();

    match failure {
        None => Ok(()),
        Some(message) => Err(EditError::Write(format!(
            "{message} — wrote {} file(s) before failing: {}",
            written.len(),
            if written.is_empty() {
                "none".to_string()
            } else {
                written.join(", ")
            }
        ))),
    }
}

/// The refusal's last line. An edit program is all-or-nothing, and a model reading a
/// refusal tends to carry on as though the ops that did resolve had landed —
/// its next program then addresses text this one never wrote. So the refusal
/// counts what resolved and says, in so many words, that none of it is done.
fn nothing_written(program: &Program, errors: &ResolveErrors) -> String {
    let failed: BTreeSet<usize> = errors.failures.iter().map(|f| f.op_line).collect();
    let ops: BTreeSet<usize> = program
        .blocks
        .iter()
        .flat_map(|block| block.ops.iter().map(|op| op.line))
        .collect();
    let resolved = ops.iter().filter(|line| !failed.contains(line)).count();
    format!(
        "{errors}\nnothing was written — {resolved} op{} resolved and {} did not, so every op in \
         this program is still pending",
        if resolved == 1 { "" } else { "s" },
        failed.len()
    )
}

/// Write-temp-and-rename inside the target's own directory, preserving mode.
/// The rename is what makes each file's write atomic, which is why an exit 4
/// leaves whole files rather than half of one.
fn write_atomically(target: &Path, content: &str) -> Result<(), String> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let mode = std::fs::metadata(target).ok().map(|m| m.permissions());
    let temp = dir.join(format!(
        ".{}.tugedit",
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "edit".to_string())
    ));

    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("{}: {e}", target.display()));
    }
    if let Some(mode) = mode {
        let _ = std::fs::set_permissions(&temp, mode);
    }
    std::fs::rename(&temp, target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("{}: {e}", target.display())
    })
}

fn absolute(path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

/// The filesystem as a `FileSource`, remembering what it handed out so the
/// caller can tell a file that moved from one the program left alone without
/// reading it twice.
struct Tree {
    seen: RefCell<HashMap<String, String>>,
}

impl Tree {
    fn new() -> Self {
        Tree {
            seen: RefCell::new(HashMap::new()),
        }
    }

    fn was_read_as(&self, path: &str) -> Option<String> {
        self.seen.borrow().get(path).cloned()
    }
}

impl FileSource for Tree {
    fn read(&self, path: &str) -> Result<Option<String>, String> {
        let target = absolute(path);
        match std::fs::read(&target) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", target.display())),
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => {
                    self.seen
                        .borrow_mut()
                        .insert(path.to_string(), text.clone());
                    Ok(Some(text))
                }
                Err(_) => Err(format!(
                    "{}: not UTF-8 — an edit program does not edit binaries",
                    target.display()
                )),
            },
        }
    }
}
