//! Corpus fidelity: the language expresses what the model actually did.
//!
//! Each fixture under `tests/corpus/` holds a command lifted verbatim from a
//! session transcript, the real file content it ran against — pinned from git
//! history at a commit where its anchors match — and the rev that expresses it.
//! The test runs the **original interpreter** in one temp dir and `tugrev` in
//! another and asserts the results are byte-identical.
//!
//! The oracle is the real command, not a golden captured at authoring time,
//! because a golden cannot catch the case this tier exists for: a rev that
//! silently diverges from what the command actually did. For the same reason a
//! missing `python3`, `sed`, or `perl` is a failure rather than a skip — a
//! silently-skipped fidelity tier is the same lie as a synthetic fixture.
//!
//! Fixtures were captured on macOS (BSD `sed`/`awk`); a fixture whose oracle
//! depended on BSD-only syntax would be rewritten to a portable equivalent or
//! dropped, never made to pass by weakening the assertion.

use std::path::{Path, PathBuf};
use std::process::Command;

fn corpus(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/corpus")
        .join(name)
}

/// Every file in a tree, relative path and bytes, in a stable order.
fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read fixture dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .expect("under root")
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, std::fs::read(&path).expect("read file")));
            }
        }
    }
    out.sort();
    out
}

/// The fixture's content — everything but the three control files — laid into
/// a fresh temp dir.
fn lay_out(fixture: &Path, into: &Path) {
    for (rel, bytes) in tree(fixture) {
        if matches!(rel.as_str(), "cmd.sh" | "program.rev" | "note.md") {
            continue;
        }
        let target = into.join(&rel);
        std::fs::create_dir_all(target.parent().expect("a parent")).expect("mkdir");
        std::fs::write(&target, bytes).expect("write");
    }
}

fn run_fixture(name: &str) {
    run_program(name, &std::fs::read_to_string(corpus(name).join("program.rev")).expect("program"));
}

/// Run the fixture's oracle and the given rev side by side, and insist they
/// agree.
fn run_program(name: &str, program: &str) {
    let fixture = corpus(name);
    let oracle_dir = tempfile::tempdir().expect("temp");
    let rev_dir = tempfile::tempdir().expect("temp");
    lay_out(&fixture, oracle_dir.path());
    lay_out(&fixture, rev_dir.path());
    let before = tree(oracle_dir.path());

    let command = std::fs::read_to_string(fixture.join("cmd.sh")).expect("cmd.sh");
    let oracle = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(oracle_dir.path())
        .output()
        .expect("run the original command");
    assert!(
        oracle.status.success(),
        "{name}: the original command failed: {}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    assert_ne!(
        before,
        tree(oracle_dir.path()),
        "{name}: the original command changed nothing, so the oracle proves nothing"
    );

    let program_file = rev_dir.path().join("program.rev");
    std::fs::write(&program_file, program).expect("write program");
    let rev = Command::new(env!("CARGO_BIN_EXE_tugrev"))
        .arg(&program_file)
        .current_dir(rev_dir.path())
        .output()
        .expect("run tugrev");
    std::fs::remove_file(&program_file).expect("remove program");
    assert!(
        rev.status.success(),
        "{name}: the rev failed: {}",
        String::from_utf8_lossy(&rev.stderr)
    );

    assert_eq!(
        tree(oracle_dir.path()),
        tree(rev_dir.path()),
        "{name}: the rev and the command it expresses produced different bytes"
    );
}

#[test]
fn the_python_multi_pair_edit_with_count_guards() {
    run_fixture("multi_pair_guarded");
}

#[test]
fn the_python_two_marker_span_cut() {
    run_fixture("marker_span_cut");
}

#[test]
fn the_python_insert_located_by_a_marker() {
    run_fixture("marker_insert");
}

#[test]
fn the_python_truncate_at_a_marker() {
    run_fixture("truncate_at_python_marker");
}

#[test]
fn the_python_line_array_splice() {
    run_fixture("line_array_splice");
}

#[test]
fn the_sed_numeric_range_delete_chain() {
    run_fixture("numeric_delete_chain");
}

#[test]
fn the_range_scoped_substitution() {
    run_fixture("range_scoped_sub");
}

#[test]
fn the_stacked_expression_rename() {
    run_fixture("stacked_rename");
}

#[test]
fn the_multi_file_substitution_with_a_capture() {
    run_fixture("multi_file_sub");
}

#[test]
fn the_substitution_whose_replacement_spans_lines() {
    run_fixture("cross_line_replacement");
}

#[test]
fn the_append_of_a_block() {
    run_fixture("append_block");
}

#[test]
fn the_creation_of_a_whole_file() {
    run_fixture("create_file");
}

#[test]
fn the_truncate_through_a_temp_file_and_a_move() {
    run_fixture("truncate_at_marker");
}

/// The oracle has to be able to say no, or every test above is a tautology.
#[test]
fn a_wrong_rev_fails_against_the_same_oracle() {
    let good = std::fs::read_to_string(corpus("numeric_delete_chain").join("program.rev"))
        .expect("program");
    let wrong = good.replace("delete 115 .. 164", "delete 115 .. 163");
    assert_ne!(good, wrong, "the mutation has to change the program");
    let outcome = std::panic::catch_unwind(|| run_program("numeric_delete_chain", &wrong));
    assert!(
        outcome.is_err(),
        "a rev that deletes the wrong lines must not pass the fidelity assertion"
    );
}
