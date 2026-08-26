//! The `TUG-FILE-RECEIPT` line and the hunk ids it carries.
//!
//! Every verb that moves a repo file's bytes testifies to it here — one line,
//! naming exactly the files that changed, which the relay turns into
//! proof-class rows. It lives in the package's library rather than beside one
//! verb because `tugrev` is a second binary that must emit the *same* receipt:
//! two emitters would be two grammars, and the relay only knows one.

use std::path::Path;

use serde::Serialize;

/// The stdout marker the relay scans every successful Bash result for.
pub const RECEIPT_PREFIX: &str = "TUG-FILE-RECEIPT: ";

#[derive(Debug, Clone, Serialize)]
pub struct ReceiptOp {
    op: &'static str,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    orig_path: Option<String>,
    /// The hunks this edit is responsible for, by their [P06] id (Spec S05) —
    /// the sub-file half of the verb's testimony. Additive: a receipt without
    /// it mints a span-less row, which claims the whole file exactly as
    /// before. Omitted when the verb has nothing to say about regions (a
    /// delete, a rename, a file outside any repo).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    hunks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Receipt {
    ops: Vec<ReceiptOp>,
}

impl Receipt {
    pub fn deleted(&mut self, path: &Path) {
        self.ops.push(ReceiptOp {
            op: "deleted",
            path: path.to_string_lossy().into_owned(),
            orig_path: None,
            hunks: Vec::new(),
        });
    }

    pub fn renamed(&mut self, from: &Path, to: &Path) {
        self.ops.push(ReceiptOp {
            op: "renamed",
            path: to.to_string_lossy().into_owned(),
            orig_path: Some(from.to_string_lossy().into_owned()),
            hunks: Vec::new(),
        });
    }

    /// A modification, naming the regions it produced (Spec S05) where the
    /// verb can read them.
    pub fn modified(&mut self, path: &Path, hunks: Vec<String>) {
        self.ops.push(ReceiptOp {
            op: "modified",
            path: path.to_string_lossy().into_owned(),
            orig_path: None,
            hunks,
        });
    }

    pub fn created(&mut self, path: &Path) {
        self.ops.push(ReceiptOp {
            op: "created",
            path: path.to_string_lossy().into_owned(),
            orig_path: None,
            hunks: Vec::new(),
        });
    }

    /// Emit the receipt — one line, always, even when the run failed partway:
    /// the ops it names did happen, and the relay reads receipts only from
    /// successful results anyway.
    pub fn emit(&self) {
        if self.ops.is_empty() {
            return;
        }
        let json = serde_json::to_string(self).unwrap_or_else(|_| "{\"ops\":[]}".to_string());
        println!("{RECEIPT_PREFIX}{json}");
    }
}

/// One file's current diff hunks by [P06] id, empty when the path is in no
/// repo, is untracked, or git refuses — an unreadable diff costs the receipt
/// its regions, never its file.
pub fn current_hunk_ids(target: &Path) -> Vec<String> {
    let Some(dir) = target.parent() else {
        return Vec::new();
    };
    tugchanges_core::hunks::file_hunks(dir, &target.to_string_lossy())
        .map(|hunks| hunks.into_iter().map(|h| h.id).collect())
        .unwrap_or_default()
}

/// The ids present in the file's diff *now* that were not there before the
/// edit — the regions this edit is responsible for.
///
/// The difference, not the whole current diff: a file the session merely
/// touched one region of must not testify to regions someone else wrote. A
/// hunk this edit rewrote gets a new id (identity is content), so it lands
/// here correctly, and a hunk it did not touch keeps its old id and does not.
pub fn hunks_this_edit_produced(target: &Path, before: &[String]) -> Vec<String> {
    current_hunk_ids(target)
        .into_iter()
        .filter(|id| !before.contains(id))
        .collect()
}
