//! Phase 4 minus the write: splice each file's resolved edits into the bytes
//! they were positioned against, and hand back the content the file would
//! have.
//!
//! Edits are applied bottom-up by position, so no edit shifts another and the
//! order ops were written in never matters. What leaves this module is a plan;
//! the CLI decides what to do with it, which is what keeps write policy — and
//! the receipt — out of the language.

use crate::parse::Program;
use crate::resolve::{resolve, Edit, FileSource, OutcomeKind, ResolveErrors};

/// What one file would become.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileOutcome {
    pub path: String,
    pub kind: OutcomeKind,
    pub new_content: String,
}

/// Phases 2–4 minus the write: read through `src`, resolve against original
/// bytes, and return the content each file would have.
pub fn resolve_and_apply(
    program: &Program,
    src: &dyn FileSource,
) -> Result<Vec<FileOutcome>, ResolveErrors> {
    Ok(resolve(program, src)?
        .into_iter()
        .map(|file| FileOutcome {
            new_content: match file.whole {
                Some(content) => content,
                None => splice(&file.original, &file.edits),
            },
            path: file.path,
            kind: file.kind,
        })
        .collect())
}

/// Bottom-up, so every edit's offsets still mean what they meant when they
/// resolved. Two insertions at one point keep the order the program wrote
/// them in.
fn splice(original: &str, edits: &[Edit]) -> String {
    let mut ordered: Vec<(usize, &Edit)> = edits.iter().enumerate().collect();
    ordered.sort_by(|(ai, a), (bi, b)| {
        b.start
            .cmp(&a.start)
            .then(b.end.cmp(&a.end))
            .then(bi.cmp(ai))
    });
    let mut out = original.to_string();
    for (_, edit) in ordered {
        out.replace_range(edit.start..edit.end, &edit.replacement);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;
    use std::collections::HashMap;

    struct Files(HashMap<String, String>);

    impl FileSource for Files {
        fn read(&self, path: &str) -> Result<Option<String>, String> {
            Ok(self.0.get(path).cloned())
        }
    }

    fn run(source: &str, pairs: &[(&str, &str)]) -> Vec<FileOutcome> {
        let program = parse(source).expect("program parses");
        let files = Files(
            pairs
                .iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect(),
        );
        resolve_and_apply(&program, &files).expect("program resolves")
    }

    fn content(source: &str, before: &str) -> String {
        run(source, &[("a.txt", before)])
            .into_iter()
            .next()
            .expect("one file")
            .new_content
    }

    #[test]
    fn a_hunk_replaces_its_block_keeping_the_files_indentation() {
        let out = content(
            concat!(
                "file a.txt\n",
                "  patch <<\n",
                "     if x {\n",
                "-        a();\n",
                "-            deep();\n",
                "+        one();\n",
                "         b();\n",
                "     }\n",
                ">>\n",
            ),
            "fn go() {\n    if x {\n        a();\n            deep();\n        b();\n    }\n}\n",
        );
        assert_eq!(
            out,
            "fn go() {\n    if x {\n        one();\n        b();\n    }\n}\n"
        );
    }

    #[test]
    fn a_pure_minus_hunk_without_context_deletes_the_lines_and_their_endings() {
        let out = content("file a.txt\n  patch <<\n-b\n>>\n", "a\nb\nc\n");
        assert_eq!(out, "a\nc\n");
    }

    #[test]
    fn a_pure_plus_hunk_with_context_inserts_after_its_context() {
        let out = content("file a.txt\n  patch <<\n a\n+b\n>>\n", "a\nc\n");
        assert_eq!(out, "a\nb\nc\n");
    }

    #[test]
    fn two_hunks_in_one_body_resolve_independently_against_original_bytes() {
        let out = content(
            concat!(
                "file a.txt\n",
                "  patch <<\n",
                "-one\n",
                "+1\n",
                "+2\n",
                "+3\n",
                "@@\n",
                "-four\n",
                "+IV\n",
                ">>\n",
            ),
            "one\ntwo\nthree\nfour\n",
        );
        assert_eq!(out, "1\n2\n3\ntwo\nthree\nIV\n");
    }

    #[test]
    fn a_hunk_carries_a_gtgt_line_as_a_plus_line() {
        let out = content("file a.txt\n  patch <<\n a\n+>>\n>>\n", "a\n");
        assert_eq!(out, "a\n>>\n");
    }

    #[test]
    fn a_hunk_touching_the_last_line_of_a_file_without_a_final_newline_keeps_the_bare_ending() {
        let replaced = content("file a.txt\n  patch <<\n-b\n+B\n>>\n", "a\nb");
        assert_eq!(replaced, "a\nB");
        let deleted = content("file a.txt\n  patch <<\n-b\n>>\n", "a\nb");
        assert_eq!(deleted, "a");
    }

    #[test]
    fn a_crlf_file_keeps_crlf_through_a_hunk() {
        let out = content(
            "file a.txt\n  patch <<\n-two\n+deux\n>>\n",
            "one\r\ntwo\r\n",
        );
        assert_eq!(out, "one\r\ndeux\r\n");
    }

    #[test]
    fn ops_in_any_order_land_the_same_edit() {
        let before = (1..=10).map(|n| format!("line {n}\n")).collect::<String>();
        let top_down = content(
            "file a.txt\n  delete 2 .. 3\n  delete 6\n  delete 9 .. 10\n",
            &before,
        );
        let jumbled = content(
            "file a.txt\n  delete 9 .. 10\n  delete 2 .. 3\n  delete 6\n",
            &before,
        );
        assert_eq!(top_down, jumbled);
        assert_eq!(top_down, "line 1\nline 4\nline 5\nline 7\nline 8\n");
    }

    #[test]
    fn crlf_content_stays_crlf() {
        let out = content(
            "file a.txt\n  after 1 insert <<\nfresh\n>>\n",
            "one\r\ntwo\r\n",
        );
        assert_eq!(out, "one\r\nfresh\r\ntwo\r\n");
    }

    #[test]
    fn a_file_without_a_trailing_newline_keeps_that_until_something_appends_past_its_last_line() {
        assert_eq!(
            content("file a.txt\n  delete 2\n", "one\ntwo\nthree"),
            "one\nthree"
        );
        assert_eq!(
            content("file a.txt\n  delete 3\n", "one\ntwo\nthree"),
            "one\ntwo"
        );
        assert_eq!(
            content("file a.txt\n  append <<\nfour\n>>\n", "one\ntwo\nthree"),
            "one\ntwo\nthree\nfour\n"
        );
    }

    #[test]
    fn insert_indented_copies_the_anchors_indentation_and_the_bare_form_does_not() {
        let before = "fn go() {\n    call();\n}\n";
        assert_eq!(
            content(
                "file a.txt\n  after 'call();' insert indented <<\nother();\n>>\n",
                before
            ),
            "fn go() {\n    call();\n    other();\n}\n"
        );
        assert_eq!(
            content(
                "file a.txt\n  after 'call();' insert <<\nother();\n>>\n",
                before
            ),
            "fn go() {\n    call();\nother();\n}\n"
        );
    }

    #[test]
    fn a_move_relocates_its_range_and_leaves_everything_else_alone() {
        assert_eq!(
            content(
                "file a.txt\n  move 3 .. 4 before 1\n",
                "one\ntwo\nthree\nfour\nfive\n"
            ),
            "three\nfour\none\ntwo\nfive\n"
        );
        assert_eq!(
            content(
                "file a.txt\n  move 1 .. 2 after $\n",
                "one\ntwo\nthree\nfour\n"
            ),
            "three\nfour\none\ntwo\n"
        );
    }

    #[test]
    fn a_program_whose_result_equals_the_original_says_so_in_its_outcome() {
        let before = "same\n";
        let outcome = run(
            "file a.txt\n  replace 'same' with 'same'\n",
            &[("a.txt", before)],
        );
        assert_eq!(outcome[0].new_content, before);
    }

    #[test]
    fn a_body_replacement_joins_with_the_files_own_line_ending() {
        assert_eq!(
            content(
                "file a.txt\n  replace 'one' with <<\none\nuno\n>>\n",
                "one\r\ntwo\r\n"
            ),
            "one\r\nuno\r\ntwo\r\n"
        );
    }

    #[test]
    fn lines_replace_swaps_a_range_for_a_body_and_an_empty_body_cuts_it() {
        assert_eq!(
            content(
                "file a.txt\n  lines 2 .. 3 replace <<\nonly\n>>\n",
                "one\ntwo\nthree\nfour\n"
            ),
            "one\nonly\nfour\n"
        );
        assert_eq!(
            content(
                "file a.txt\n  lines 2 .. 3 replace << >>\n",
                "one\ntwo\nthree\nfour\n"
            ),
            "one\nfour\n"
        );
    }

    #[test]
    fn create_and_write_produce_whole_files() {
        let created = run("file new.txt\n  create <<\nhello\n>>\n", &[]);
        assert_eq!(created[0].kind, OutcomeKind::Created);
        assert_eq!(created[0].new_content, "hello\n");

        let written = run(
            "file a.txt\n  write <<\nfresh\n>>\n",
            &[("a.txt", "old\nold\n")],
        );
        assert_eq!(written[0].kind, OutcomeKind::Modified);
        assert_eq!(written[0].new_content, "fresh\n");
    }

    #[test]
    fn a_files_block_applies_the_same_ops_to_each_file_independently() {
        let out = run(
            "files a.txt b.txt\n  replace 'old' with 'new' all\n",
            &[("a.txt", "old\n"), ("b.txt", "old old\n")],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].new_content, "new\n");
        assert_eq!(out[1].new_content, "new new\n");
    }

    #[test]
    fn two_insertions_at_one_anchor_keep_the_order_the_program_wrote_them_in() {
        assert_eq!(
            content(
                "file a.txt\n  before 2 insert <<\nfirst\n>>\n  before 2 insert <<\nsecond\n>>\n",
                "one\ntwo\n"
            ),
            "one\nfirst\nsecond\ntwo\n"
        );
    }
}
