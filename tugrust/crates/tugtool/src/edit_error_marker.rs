//! The `TUG-EDIT-ERROR` line — what a failed edit program leaves behind.
//!
//! `tugtool` never opens a session ledger, so a failed edit has exactly one
//! way to reach one: say so on stderr in a form the relay can read. This is
//! that form, and it is deliberately shaped like `receipt.rs` — one constant,
//! one prefixed line of JSON, one emitter — because the relay knows one
//! grammar per marker, and a second emitter would be a second grammar.
//!
//! The line doubles as the evidence bundle: the class, the exit, the report
//! the human already read, how many ops resolved, the files the program
//! named, and the program itself. One format, two consumers.

use serde::Serialize;

use crate::edit::EditError;

/// The stderr marker the relay scans every *failed* Bash result for.
pub const EDIT_ERROR_PREFIX: &str = "TUG-EDIT-ERROR: ";

/// The cut mark, spelled the way the facts library spells it.
const ELISION: &str = "…";

/// The program text's cap. A program is evidence, not a payload: 16 KiB holds
/// every edit program written by hand and declines to carry a generated one
/// whole.
const PROGRAM_CAP: usize = 16 * 1024;

/// One failed edit, serialized to the marker line.
#[derive(Debug, Clone, Serialize)]
pub struct EditErrorMarker {
    /// Which phase refused: `usage`, `parse`, `resolve`, or `write`.
    class: &'static str,
    /// The process exit the failure produces.
    exit: u8,
    /// The rendered report, verbatim — the same text stderr carried.
    message: String,
    ops_resolved: usize,
    ops_total: usize,
    files: Vec<String>,
    program: String,
}

impl EditErrorMarker {
    pub fn new(class: &'static str, exit: u8, message: impl Into<String>) -> Self {
        EditErrorMarker {
            class,
            exit,
            message: message.into(),
            ops_resolved: 0,
            ops_total: 0,
            files: Vec::new(),
            program: String::new(),
        }
    }

    pub fn with_ops(mut self, resolved: usize, total: usize) -> Self {
        self.ops_resolved = resolved;
        self.ops_total = total;
        self
    }

    pub fn with_files(mut self, files: Vec<String>) -> Self {
        self.files = files;
        self
    }

    pub fn with_program(mut self, program: &str) -> Self {
        self.program = cap(program);
        self
    }

    /// Emit the marker — one line, on stderr, where the report it follows
    /// already went.
    pub fn emit(&self) {
        let json = serde_json::to_string(self)
            .unwrap_or_else(|_| format!("{{\"class\":\"{}\",\"exit\":{}}}", self.class, self.exit));
        eprintln!("{EDIT_ERROR_PREFIX}{json}");
    }
}

/// The marker an `EditError` describes, with the program it was reading.
pub fn compose(err: &EditError, program: &str) -> EditErrorMarker {
    let marker =
        EditErrorMarker::new(err.class(), err.exit_code(), err.message()).with_program(program);
    match err.evidence() {
        Some(ops) => marker
            .with_ops(ops.resolved, ops.total)
            .with_files(ops.files.clone()),
        None => marker,
    }
}

/// A failed edit's two lines: the report a human reads, then the one the
/// ledger does. The order is the point — the marker is an addition to the
/// stderr the verb always emitted, never a replacement for it.
pub fn report(err: &EditError, program: &str) {
    eprintln!("error: {}", err.message());
    compose(err, program).emit();
}

/// Cut to `PROGRAM_CAP` bytes on a character boundary, marking the cut.
fn cap(text: &str) -> String {
    if text.len() <= PROGRAM_CAP {
        return text.to_string();
    }
    let mut kept = String::with_capacity(PROGRAM_CAP + ELISION.len());
    for ch in text.chars() {
        if kept.len() + ch.len_utf8() > PROGRAM_CAP {
            break;
        }
        kept.push(ch);
    }
    kept.push_str(ELISION);
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::EditOps;

    fn parse(marker: &EditErrorMarker) -> serde_json::Value {
        serde_json::to_value(marker).expect("the marker serializes")
    }

    #[test]
    fn every_class_carries_its_own_exit_and_name() {
        let cases = [
            (EditError::Usage("no program".into()), "usage", 1),
            (EditError::Parse("2:3: bad op".into()), "parse", 2),
            (
                EditError::Resolve("stale".into(), EditOps::default()),
                "resolve",
                3,
            ),
            (
                EditError::Write("disk full".into(), EditOps::default()),
                "write",
                4,
            ),
        ];
        for (err, class, exit) in cases {
            let json = parse(&compose(&err, "file a.txt\n"));
            assert_eq!(json["class"], class);
            assert_eq!(json["exit"], exit);
            assert_eq!(json["message"], err.message());
        }
    }

    #[test]
    fn a_resolve_failure_carries_its_counts_and_files() {
        let ops = EditOps {
            resolved: 1,
            total: 3,
            files: vec!["a.txt".to_string(), "b.txt".to_string()],
        };
        let json = parse(&compose(&EditError::Resolve("stale".into(), ops), "prog"));
        assert_eq!(json["ops_resolved"], 1);
        assert_eq!(json["ops_total"], 3);
        assert_eq!(json["files"], serde_json::json!(["a.txt", "b.txt"]));
        assert_eq!(json["program"], "prog");
    }

    #[test]
    fn a_class_that_never_parsed_counts_no_ops() {
        let json = parse(&compose(&EditError::Parse("1:1: bad".into()), "junk"));
        assert_eq!(json["ops_total"], 0);
        assert_eq!(json["files"], serde_json::json!([]));
        assert_eq!(json["program"], "junk");
    }

    #[test]
    fn an_oversized_program_is_cut_and_the_cut_is_marked() {
        let huge = "x".repeat(PROGRAM_CAP * 2);
        let json = parse(&compose(&EditError::Parse("bad".into()), &huge));
        let program = json["program"].as_str().expect("a program string");
        assert!(program.ends_with(ELISION), "the cut is marked");
        assert_eq!(program.len(), PROGRAM_CAP + ELISION.len());
    }

    #[test]
    fn a_multibyte_program_is_never_cut_mid_character() {
        let huge = "é".repeat(PROGRAM_CAP);
        let json = parse(&compose(&EditError::Parse("bad".into()), &huge));
        let program = json["program"].as_str().expect("a program string");
        assert!(program.ends_with(ELISION));
        assert!(program.len() <= PROGRAM_CAP + ELISION.len());
    }

    #[test]
    fn the_marker_is_one_line() {
        let err = EditError::Resolve("line 3: stale\nline 4: stale".into(), EditOps::default());
        let json =
            serde_json::to_string(&compose(&err, "file a.txt\n  delete 1\n")).expect("serializes");
        assert!(!json.contains('\n'), "the newlines are escaped: {json}");
    }
}
