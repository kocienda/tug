//! The edit-program grammar: file blocks and the ten ops.
//!
//! The parser reads the whole program before returning, so a syntax error
//! aborts with nothing read — phase 1 of the four-phase model, where the phase
//! boundary is the contract.

use crate::ParseError;
use crate::lex::Scanner;

/// A parsed program: file blocks in source order.
#[derive(Debug, Clone)]
pub struct Program {
    pub blocks: Vec<Block>,
}

/// One `file` / `files` block and the ops it holds.
#[derive(Debug, Clone)]
pub struct Block {
    /// Every path the block names. A `file` block names one.
    pub paths: Vec<String>,
    pub ops: Vec<Op>,
    /// 1-based source line of the block's header.
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct Op {
    /// 1-based source line the op was written on — what a resolve failure
    /// points the model at.
    pub line: usize,
    pub kind: OpKind,
}

#[derive(Debug, Clone)]
pub enum OpKind {
    Replace {
        find: Text,
        with: Text,
        count: Count,
        scope: Option<Range>,
    },
    Sub {
        pattern: RegexLit,
        repl: String,
        count: Count,
        scope: Option<Range>,
    },
    /// A body of unified-diff hunk lines. Each hunk replaces the lines it
    /// matches with the lines it carries; the counts and headers a real
    /// unified diff needs are neither written nor read.
    Patch {
        hunks: Vec<Hunk>,
    },
    Insert {
        anchor: Addr,
        side: Side,
        indented: bool,
        body: Vec<String>,
    },
    Append {
        body: Vec<String>,
    },
    Delete {
        target: DeleteTarget,
    },
    Lines {
        range: Range,
        body: Vec<String>,
    },
    Move {
        range: Range,
        side: Side,
        anchor: Addr,
    },
    Create {
        body: Vec<String>,
    },
    Write {
        body: Vec<String>,
    },
}

impl OpKind {
    /// The op's spelling, for an error that has to name it.
    pub fn word(&self) -> &'static str {
        match self {
            OpKind::Replace { .. } => "replace",
            OpKind::Sub { .. } => "sub",
            OpKind::Patch { .. } => "patch",
            OpKind::Insert { .. } => "insert",
            OpKind::Append { .. } => "append",
            OpKind::Delete { .. } => "delete",
            OpKind::Lines { .. } => "lines",
            OpKind::Move { .. } => "move",
            OpKind::Create { .. } => "create",
            OpKind::Write { .. } => "write",
        }
    }
}

/// One hunk of a `patch` body: the lines it expects to find, the lines it
/// leaves behind, and where it was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// The context and `-` lines, in body order, each stripped of its prefix
    /// byte — what the hunk matches, as whole lines.
    pub old: Vec<String>,
    /// The context and `+` lines, same stripping — what stands there after.
    pub new: Vec<String>,
    /// 1-based source line of the hunk's first body line.
    pub line: usize,
}

/// A `replace`'s operand: a quoted literal, or a body whose lines join with
/// the target file's own line ending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Text {
    Str(String),
    Body(Vec<String>),
}

/// The guard. `expect 1` is the default for both `replace` and `sub`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Count {
    Expect(usize),
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Before,
    After,
}

#[derive(Debug, Clone)]
pub struct RegexLit {
    /// The pattern as written, for an error message that quotes it back.
    pub source: String,
    pub flags: String,
    pub regex: regex::Regex,
}

#[derive(Debug, Clone)]
pub enum Addr {
    /// Line N, 1-based, as `grep -n` prints it.
    Line(usize),
    /// The line matching the regex, optionally qualified: `[3]` the third
    /// match, `[-1]` the last.
    Regex(RegexLit, Option<i64>),
    /// The line containing the literal, same qualifier.
    Literal(String, Option<i64>),
    /// The run of lines equal to a `<<` body, same qualifier. An address is a
    /// place, and a block of lines is how the model says where when no single
    /// line is distinctive: `after << … >> insert << … >>` anchors past a whole
    /// function. `before` takes its first line and `after` its last, which is
    /// also how it reads as a range end.
    Block(Vec<String>, Option<i64>),
    /// The file's last line.
    Last,
}

#[derive(Debug, Clone)]
pub struct Range {
    pub start: Addr,
    pub end: Addr,
    /// `until` excludes its end line; `..` includes it.
    pub exclusive_end: bool,
}

#[derive(Debug, Clone)]
pub enum DeleteTarget {
    Range(Range),
    Every(Addr),
}

/// Parse a whole program. Phase 1: nothing is opened, nothing is read.
pub fn parse(source: &str) -> Result<Program, ParseError> {
    let mut scanner = Scanner::new(source);
    let mut blocks: Vec<Block> = Vec::new();

    while scanner.next_content_line().is_some() {
        match scanner.peek_word().as_deref() {
            Some("file") | Some("files") => {
                let block = parse_block_header(&mut scanner)?;
                blocks.push(block);
            }
            Some(_) => {
                let op = parse_op(&mut scanner)?;
                match blocks.last_mut() {
                    Some(block) => block.ops.push(op),
                    None => {
                        return Err(scanner.error_at(
                            op.line,
                            1,
                            "an op must sit inside a `file` or `files` block",
                        ));
                    }
                }
            }
            None => unreachable!("next_content_line positions on a word"),
        }
    }

    let program = Program { blocks };
    validate(&program, &scanner)?;
    Ok(program)
}

fn parse_block_header(scanner: &mut Scanner) -> Result<Block, ParseError> {
    let line = scanner.line + 1;
    let word = scanner.read_word().unwrap_or_default();
    let mut paths = Vec::new();
    while !scanner.at_line_end() {
        let at = scanner.col;
        let path = scanner.read_word().unwrap_or_default();
        if path.starts_with('\'') || path.starts_with('"') {
            return Err(scanner.error_at(
                line,
                at + 1,
                "a path is written bare — no quotes, no globs, no variables",
            ));
        }
        paths.push(path);
    }
    if paths.is_empty() {
        return Err(scanner.error_at(line, 1, format!("`{word}` names no path")));
    }
    if word == "file" && paths.len() > 1 {
        return Err(scanner.error_at(
            line,
            1,
            "`file` takes one path — use `files` to apply the same ops to several",
        ));
    }
    scanner.finish_line()?;
    Ok(Block {
        paths,
        ops: Vec::new(),
        line,
    })
}

fn parse_op(scanner: &mut Scanner) -> Result<Op, ParseError> {
    let line = scanner.line + 1;
    let at = scanner.col;
    let word = scanner.read_word().unwrap_or_default();

    let kind = match word.as_str() {
        "replace" => {
            let find = parse_text(scanner, &CONTINUES_WITH)?;
            scanner.expect_word("with")?;
            let with = parse_text(scanner, &CONTINUES_TAIL)?;
            let count = parse_count(scanner)?;
            let scope = parse_scope(scanner)?;
            OpKind::Replace {
                find,
                with,
                count,
                scope,
            }
        }
        "sub" => {
            let pattern = parse_regex(scanner)?;
            let repl = scanner.read_quoted()?;
            let count = parse_count(scanner)?;
            let scope = parse_scope(scanner)?;
            OpKind::Sub {
                pattern,
                repl,
                count,
                scope,
            }
        }
        "before" | "after" => {
            let side = if word == "before" {
                Side::Before
            } else {
                Side::After
            };
            let anchor = parse_addr(scanner, &["insert"])?;
            scanner.expect_word("insert")?;
            let indented = if scanner.peek_word().as_deref() == Some("indented") {
                scanner.read_word();
                true
            } else {
                false
            };
            let body = parse_body(scanner, &[])?;
            OpKind::Insert {
                anchor,
                side,
                indented,
                body,
            }
        }
        "patch" => {
            let body = parse_body(scanner, &[])?;
            OpKind::Patch {
                hunks: parse_hunks(&body, line + 1, line, scanner)?,
            }
        }
        "append" => OpKind::Append {
            body: parse_body(scanner, &[])?,
        },
        "delete" => {
            if scanner.peek_word().as_deref() == Some("every") {
                scanner.read_word();
                OpKind::Delete {
                    target: DeleteTarget::Every(parse_addr(scanner, &[])?),
                }
            } else {
                OpKind::Delete {
                    target: DeleteTarget::Range(parse_range(scanner, &[])?),
                }
            }
        }
        "lines" => {
            let range = parse_range(scanner, &["replace"])?;
            scanner.expect_word("replace")?;
            let body = parse_body(scanner, &[])?;
            OpKind::Lines { range, body }
        }
        "move" => {
            let range = parse_range(scanner, &["before", "after"])?;
            let at = scanner.col;
            let side = match scanner.read_word().as_deref() {
                Some("before") => Side::Before,
                Some("after") => Side::After,
                _ => {
                    return Err(scanner.error_at(
                        line,
                        at + 1,
                        "expected `before` or `after` naming where the range lands",
                    ));
                }
            };
            let anchor = parse_addr(scanner, &[])?;
            OpKind::Move {
                range,
                side,
                anchor,
            }
        }
        "create" => OpKind::Create {
            body: parse_body(scanner, &[])?,
        },
        "write" => OpKind::Write {
            body: parse_body(scanner, &[])?,
        },
        other => {
            return Err(scanner.error_at(line, at + 1, format!("unknown op `{other}`")));
        }
    };

    scanner.finish_line()?;
    Ok(Op { line, kind })
}

/// What may follow the `>>` closing a `replace`'s first body: the `with` that
/// introduces its second.
const CONTINUES_WITH: [&str; 1] = ["with"];

/// What may follow the `>>` closing a `replace`'s second body: the count guard
/// and the `in` scope, both optional and both tail of the op.
const CONTINUES_TAIL: [&str; 3] = ["all", "expect", "in"];

fn parse_text(scanner: &mut Scanner, continues: &[&str]) -> Result<Text, ParseError> {
    scanner.skip_spaces();
    match scanner.peek() {
        Some('\'') | Some('"') => Ok(Text::Str(scanner.read_quoted()?)),
        Some('<') => Ok(Text::Body(parse_body(scanner, continues)?)),
        _ => Err(scanner.error("expected a quoted string or a `<<` body")),
    }
}

fn parse_body(scanner: &mut Scanner, continues: &[&str]) -> Result<Vec<String>, ParseError> {
    scanner.skip_spaces();
    if !(scanner.peek() == Some('<') && scanner.peek_at(1) == Some('<')) {
        return Err(scanner.error("expected a `<<` body"));
    }
    scanner.col += 2;
    scanner.read_body(continues)
}

/// A hunk under construction, closed by a `@@` line or by the end of the body.
#[derive(Default)]
struct PartialHunk {
    old: Vec<String>,
    new: Vec<String>,
    /// Set by the first line the hunk collects; `None` means it collected none.
    line: Option<usize>,
    minus: bool,
    plus: bool,
    context: bool,
}

impl PartialHunk {
    fn opened_at(&mut self, source_line: usize) {
        self.line.get_or_insert(source_line);
    }

    /// Push the finished hunk onto `out` and start a fresh one. A hunk that
    /// collected no lines is dropped: a separator between nothing and nothing
    /// is not a hunk.
    fn close(&mut self, out: &mut Vec<Hunk>, scanner: &Scanner) -> Result<(), ParseError> {
        let Some(line) = self.line else {
            return Ok(());
        };
        if !self.minus && !self.plus {
            return Err(scanner.error_at(
                line,
                1,
                "this hunk has no `-` or `+` line, so it would change nothing",
            ));
        }
        if !self.minus && !self.context {
            return Err(scanner.error_at(
                line,
                1,
                "this hunk has no context or `-` line, so it has nowhere to go",
            ));
        }
        out.push(Hunk {
            old: std::mem::take(&mut self.old),
            new: std::mem::take(&mut self.new),
            line,
        });
        *self = Self::default();
        Ok(())
    }
}

/// Split a `patch` body into hunks. `first_line` is the 1-based source line of
/// the body's first line, so body line `i` is `first_line + i`; `op_line` is
/// the line the `patch` word sits on.
fn parse_hunks(
    lines: &[String],
    first_line: usize,
    op_line: usize,
    scanner: &Scanner,
) -> Result<Vec<Hunk>, ParseError> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut current = PartialHunk::default();

    for (i, text) in lines.iter().enumerate() {
        let source_line = first_line + i;
        if text.starts_with("@@") {
            current.close(&mut hunks, scanner)?;
            continue;
        }
        if text.starts_with('\\') {
            continue;
        }
        let mut chars = text.chars();
        let prefix = chars.next().unwrap_or(' ');
        let rest = chars.as_str();
        match prefix {
            ' ' => {
                current.opened_at(source_line);
                current.context = true;
                current.old.push(rest.to_string());
                current.new.push(rest.to_string());
            }
            '-' => {
                current.opened_at(source_line);
                current.minus = true;
                current.old.push(rest.to_string());
            }
            '+' => {
                current.opened_at(source_line);
                current.plus = true;
                current.new.push(rest.to_string());
            }
            other => {
                return Err(scanner.error_at(source_line, 1, prefix_refusal(lines, other)));
            }
        }
    }
    current.close(&mut hunks, scanner)?;

    if hunks.is_empty() {
        return Err(scanner.error_at(op_line, 1, "`patch` needs at least one hunk"));
    }
    Ok(hunks)
}

/// Why a hunk line with no prefix byte refused, and what to write instead.
///
/// The two ways to lose the byte read differently. A body pasted whole out of
/// the file carries no prefix on any line, and what the caller wanted was
/// usually a verbatim block swap. A single bare line among prefixed ones is a
/// context line whose space went missing. Each gets its own repair.
fn prefix_refusal(lines: &[String], first: char) -> String {
    let prefixed = lines
        .iter()
        .any(|l| l.starts_with('-') || l.starts_with('+') || l.starts_with("@@"));
    if prefixed {
        format!(
            "a hunk line starts with ` `, `-`, `+`, or `@@` — this one starts with `{first}`. \
             If the patch keeps this line it is context and needs one leading space; \
             if it goes out or comes in, mark it `-` or `+`"
        )
    } else {
        format!(
            "a `patch` body is a diff hunk — one prefix byte per line (` ` keeps, `-` takes out, \
             `+` puts in) — and no line in this body carries one; this one starts with `{first}`. \
             To swap one verbatim block for another, use `replace << … >> with << … >>`"
        )
    }
}

fn parse_regex(scanner: &mut Scanner) -> Result<RegexLit, ParseError> {
    let line = scanner.line + 1;
    scanner.skip_spaces();
    let at = scanner.col;
    let (source, flags) = scanner.read_regex()?;
    let regex =
        compile(&source, &flags).map_err(|message| scanner.error_at(line, at + 1, message))?;
    Ok(RegexLit {
        source,
        flags,
        regex,
    })
}

/// `^` and `$` are line anchors, as they are in `sed` and `perl -p`; `\A` and
/// `\z` anchor the file.
fn compile(source: &str, flags: &str) -> Result<regex::Regex, String> {
    let mut prefix = String::from("(?m");
    if flags.contains('i') {
        prefix.push('i');
    }
    if flags.contains('s') {
        prefix.push('s');
    }
    prefix.push(')');
    regex::Regex::new(&format!("{prefix}{source}")).map_err(|e| format!("invalid regex: {e}"))
}

fn parse_count(scanner: &mut Scanner) -> Result<Count, ParseError> {
    match scanner.peek_word().as_deref() {
        Some("expect") => {
            scanner.read_word();
            Ok(Count::Expect(scanner.read_number()?))
        }
        Some("all") => {
            scanner.read_word();
            Ok(Count::All)
        }
        _ => Ok(Count::Expect(1)),
    }
}

fn parse_scope(scanner: &mut Scanner) -> Result<Option<Range>, ParseError> {
    if scanner.peek_word().as_deref() != Some("in") {
        return Ok(None);
    }
    scanner.read_word();
    Ok(Some(parse_range(scanner, &[])?))
}

/// `continues` names the words that may follow the `>>` of a block address —
/// the op's own next word, exactly as for a `replace`'s two bodies.
fn parse_addr(scanner: &mut Scanner, continues: &[&str]) -> Result<Addr, ParseError> {
    scanner.skip_spaces();
    match scanner.peek() {
        Some('<') => {
            // `"["` lets the body close on its own `[K]` qualifier; see
            // `lex::terminates`.
            let mut closing: Vec<&str> = vec!["["];
            closing.extend_from_slice(continues);
            let body = parse_body(scanner, &closing)?;
            let qualifier = scanner.read_qualifier()?;
            Ok(Addr::Block(body, qualifier))
        }
        Some('$') => {
            scanner.col += 1;
            Ok(Addr::Last)
        }
        Some('/') => {
            let pattern = parse_regex(scanner)?;
            let qualifier = scanner.read_qualifier()?;
            Ok(Addr::Regex(pattern, qualifier))
        }
        Some('\'') | Some('"') => {
            let literal = scanner.read_quoted()?;
            let qualifier = scanner.read_qualifier()?;
            Ok(Addr::Literal(literal, qualifier))
        }
        Some(c) if c.is_ascii_digit() => {
            let at = scanner.col;
            let n = scanner.read_number()?;
            if n == 0 {
                return Err(scanner.error_at(
                    scanner.line + 1,
                    at + 1,
                    "line numbers are 1-based, as `grep -n` prints them",
                ));
            }
            Ok(Addr::Line(n))
        }
        _ => Err(scanner
            .error("expected an address: a line number, /regex/, 'literal', a `<<` block, or $")),
    }
}

/// `tail` names the words that may follow the whole range, which a block
/// address at either end needs in order to know where its body stops.
fn parse_range(scanner: &mut Scanner, tail: &[&str]) -> Result<Range, ParseError> {
    let mut opening: Vec<&str> = vec!["..", "until"];
    opening.extend_from_slice(tail);
    let start = parse_addr(scanner, &opening)?;
    scanner.skip_spaces();
    let exclusive_end = if scanner.peek() == Some('.') && scanner.peek_at(1) == Some('.') {
        scanner.col += 2;
        false
    } else if scanner.peek_word().as_deref() == Some("until") {
        scanner.read_word();
        true
    } else {
        // A bare address where a range is expected is the one-line range.
        return Ok(Range {
            end: start.clone(),
            start,
            exclusive_end: false,
        });
    };
    let end = parse_addr(scanner, tail)?;
    Ok(Range {
        start,
        end,
        exclusive_end,
    })
}

/// The rules a well-formed program must satisfy that the grammar alone cannot
/// state.
fn validate(program: &Program, scanner: &Scanner) -> Result<(), ParseError> {
    for block in &program.blocks {
        if block.ops.is_empty() {
            return Err(scanner.error_at(block.line, 1, "this block has no ops"));
        }
        for op in &block.ops {
            let whole_file = matches!(op.kind, OpKind::Create { .. } | OpKind::Write { .. });
            if whole_file && block.ops.len() > 1 {
                return Err(scanner.error_at(
                    op.line,
                    1,
                    format!(
                        "`{}` writes the whole file, so it must be the only op in its block",
                        op.kind.word()
                    ),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn program(source: &str) -> Program {
        parse(source).expect("program parses")
    }

    fn ops(source: &str) -> Vec<Op> {
        program(source)
            .blocks
            .into_iter()
            .next()
            .expect("a block")
            .ops
    }

    fn failure(source: &str) -> ParseError {
        parse(source).expect_err("program is refused")
    }

    fn hunks(source: &str) -> Vec<Hunk> {
        match ops(source).into_iter().next().expect("an op").kind {
            OpKind::Patch { hunks } => hunks,
            other => panic!("expected patch, got {other:?}"),
        }
    }

    #[test]
    fn a_patch_body_parses_into_old_and_new_lines() {
        let hunks = hunks("file a.txt\n  patch <<\n one\n-two\n+deux\n three\n>>\n");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old, vec!["one", "two", "three"]);
        assert_eq!(hunks[0].new, vec!["one", "deux", "three"]);
        assert_eq!(hunks[0].line, 3);
    }

    #[test]
    fn a_blank_body_line_is_a_blank_context_line() {
        let hunks = hunks("file a.txt\n  patch <<\n one\n\n-two\n+deux\n>>\n");
        assert_eq!(hunks[0].old, vec!["one", "", "two"]);
        assert_eq!(hunks[0].new, vec!["one", "", "deux"]);
    }

    #[test]
    fn at_at_lines_separate_hunks_and_their_tails_are_ignored() {
        let hunks = hunks(concat!(
            "file a.txt\n",
            "  patch <<\n",
            "@@ -1,2 +1,2 @@\n",
            "-a\n",
            "+b\n",
            "@@ -9,2 +9,2 @@\n",
            "-c\n",
            "+d\n",
            "@@\n",
            ">>\n",
        ));
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].old, vec!["a"]);
        assert_eq!(hunks[0].line, 4);
        assert_eq!(hunks[1].new, vec!["d"]);
        assert_eq!(hunks[1].line, 7);
    }

    #[test]
    fn a_no_newline_marker_is_ignored() {
        let hunks = hunks(concat!(
            "file a.txt\n",
            "  patch <<\n",
            "-a\n",
            "+b\n",
            "\\ No newline at end of file\n",
            ">>\n",
        ));
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old, vec!["a"]);
        assert_eq!(hunks[0].new, vec!["b"]);
    }

    #[test]
    fn a_line_with_no_prefix_is_refused_naming_its_first_byte() {
        let err = failure("file a.txt\n  patch <<\n one\ntwo\n+x\n>>\n");
        assert_eq!(err.line, 4);
        assert_eq!(err.col, 1);
        assert!(err.message.contains("starts with `t`"), "{}", err.message);
        assert!(
            err.message.contains("needs one leading space"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_body_with_no_prefix_anywhere_is_steered_at_replace() {
        let err = failure("file a.txt\n  patch <<\nexport const X = 1;\nexport const Y = 2;\n>>\n");
        assert_eq!(err.line, 3);
        assert_eq!(err.col, 1);
        assert!(
            err.message.contains("no line in this body carries one"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("`replace << … >> with << … >>`"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_hunk_that_changes_nothing_is_refused() {
        let err = failure("file a.txt\n  patch <<\n one\n two\n>>\n");
        assert_eq!(err.line, 3);
        assert!(
            err.message.contains("would change nothing"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_hunk_with_nowhere_to_go_is_refused() {
        let err = failure("file a.txt\n  patch <<\n+one\n>>\n");
        assert_eq!(err.line, 3);
        assert!(err.message.contains("nowhere to go"), "{}", err.message);
    }

    #[test]
    fn a_body_with_no_hunks_is_refused() {
        let err = failure("file a.txt\n  patch <<\n@@\n>>\n");
        assert_eq!(err.line, 2);
        assert!(
            err.message.contains("needs at least one hunk"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_context_line_opening_with_gtgt_closes_the_body_and_a_plus_line_carries_it() {
        let hunks = hunks("file a.txt\n  patch <<\n one\n+>>\n>>\n");
        assert_eq!(hunks[0].new, vec!["one", ">>"]);

        let err = failure("file a.txt\n  patch <<\n-one\n+two\n >>\n+x\n>>\n");
        assert!(err.message.contains("unknown op"), "{}", err.message);
    }

    #[test]
    fn patch_takes_no_tail() {
        let err = failure("file a.txt\n  patch <<\n-one\n+two\n>> all\n");
        assert!(err.message.contains("unterminated body"), "{}", err.message);
    }

    #[test]
    fn a_file_block_names_one_path_and_a_files_block_names_several() {
        let p = program("file a.rs\n  delete 1\nfiles b.rs c.rs\n  replace 'x' with 'y'\n");
        assert_eq!(p.blocks.len(), 2);
        assert_eq!(p.blocks[0].paths, vec!["a.rs".to_string()]);
        assert_eq!(p.blocks[0].line, 1);
        assert_eq!(
            p.blocks[1].paths,
            vec!["b.rs".to_string(), "c.rs".to_string()]
        );
    }

    #[test]
    fn the_rename_campaign_parses() {
        let ops = ops(concat!(
            "files tugrust/crates/tugarc-core/src/ops.rs tugrust/crates/tugarc-core/src/replay.rs\n",
            "  replace 'ReleaseOutcome' with 'DiscardOutcome' all\n",
            r"  sub /\brelease_in\b/ 'discard_in' all",
            "\n",
            r"  sub /\bfn release_/ 'fn discard_' all",
            "\n",
        ));
        assert_eq!(ops.len(), 3);
        match &ops[0].kind {
            OpKind::Replace {
                find,
                with,
                count,
                scope,
            } => {
                assert_eq!(find, &Text::Str("ReleaseOutcome".into()));
                assert_eq!(with, &Text::Str("DiscardOutcome".into()));
                assert_eq!(*count, Count::All);
                assert!(scope.is_none());
            }
            other => panic!("expected replace, got {other:?}"),
        }
        match &ops[1].kind {
            OpKind::Sub {
                pattern,
                repl,
                count,
                ..
            } => {
                assert_eq!(pattern.source, r"\brelease_in\b");
                assert_eq!(repl, "discard_in");
                assert_eq!(*count, Count::All);
            }
            other => panic!("expected sub, got {other:?}"),
        }
    }

    #[test]
    fn the_multi_pair_edit_with_a_body_replacement_parses() {
        let ops = ops(concat!(
            "file tugdeck/src/main.tsx\n",
            "  replace 'import { attachPulseStore } from \"./lib/pulse-store\";' with <<\n",
            "import { attachPulseStore } from \"./lib/pulse-store\";\n",
            "import { attachLocalModelStore } from \"./lib/local-model-store\";\n",
            ">>\n",
            "  after 'attachPulseStore(connection);' insert indented <<\n",
            "\n",
            "attachLocalModelStore(connection);\n",
            ">>\n",
        ));
        assert_eq!(ops.len(), 2);
        match &ops[0].kind {
            OpKind::Replace { with, count, .. } => {
                assert_eq!(
                    with,
                    &Text::Body(vec![
                        "import { attachPulseStore } from \"./lib/pulse-store\";".into(),
                        "import { attachLocalModelStore } from \"./lib/local-model-store\";".into(),
                    ])
                );
                assert_eq!(*count, Count::Expect(1));
            }
            other => panic!("expected replace, got {other:?}"),
        }
        match &ops[1].kind {
            OpKind::Insert {
                anchor,
                side,
                indented,
                body,
            } => {
                assert!(
                    matches!(anchor, Addr::Literal(l, None) if l == "attachPulseStore(connection);")
                );
                assert_eq!(*side, Side::After);
                assert!(indented);
                assert_eq!(
                    body,
                    &vec!["".to_string(), "attachLocalModelStore(connection);".into()]
                );
            }
            other => panic!("expected insert, got {other:?}"),
        }
    }

    #[test]
    fn the_numeric_deletes_parse_in_any_order() {
        let ops = ops(concat!(
            "file tugdeck/src/components/layout/layout-card.tsx\n",
            "  delete 835 .. 849\n",
            "  delete 521 .. 522\n",
            "  delete 166\n",
        ));
        assert_eq!(ops.len(), 3);
        match &ops[0].kind {
            OpKind::Delete {
                target: DeleteTarget::Range(range),
            } => {
                assert!(matches!(range.start, Addr::Line(835)));
                assert!(matches!(range.end, Addr::Line(849)));
                assert!(!range.exclusive_end);
            }
            other => panic!("expected delete, got {other:?}"),
        }
        // A bare address where a range is expected is the one-line range.
        match &ops[2].kind {
            OpKind::Delete {
                target: DeleteTarget::Range(range),
            } => {
                assert!(matches!(range.start, Addr::Line(166)));
                assert!(matches!(range.end, Addr::Line(166)));
            }
            other => panic!("expected delete, got {other:?}"),
        }
    }

    #[test]
    fn the_block_swap_and_the_truncate_at_marker_parse() {
        let p = program(concat!(
            "file roadmap/local-model-bringup.md\n",
            "  move 431 .. 441 before 415\n",
            "file roadmap/animation-tuneup.md\n",
            "  delete /^### Remaining execution steps/ .. $\n",
        ));
        match &p.blocks[0].ops[0].kind {
            OpKind::Move {
                range,
                side,
                anchor,
            } => {
                assert!(matches!(range.start, Addr::Line(431)));
                assert!(matches!(range.end, Addr::Line(441)));
                assert_eq!(*side, Side::Before);
                assert!(matches!(anchor, Addr::Line(415)));
            }
            other => panic!("expected move, got {other:?}"),
        }
        match &p.blocks[1].ops[0].kind {
            OpKind::Delete {
                target: DeleteTarget::Range(range),
            } => {
                assert!(
                    matches!(&range.start, Addr::Regex(r, None) if r.source == "^### Remaining execution steps")
                );
                assert!(matches!(range.end, Addr::Last));
            }
            other => panic!("expected delete, got {other:?}"),
        }
    }

    #[test]
    fn the_scoped_rename_parses_its_in_range() {
        let ops = ops(concat!(
            "file tugdeck/src/components/chrome/tug-pane.tsx\n",
            "  replace 'railSplit' with 'placeSplit' all in 350 .. 900\n",
        ));
        match &ops[0].kind {
            OpKind::Replace { count, scope, .. } => {
                assert_eq!(*count, Count::All);
                let scope = scope.as_ref().expect("an `in` scope");
                assert!(matches!(scope.start, Addr::Line(350)));
                assert!(matches!(scope.end, Addr::Line(900)));
            }
            other => panic!("expected replace, got {other:?}"),
        }
    }

    #[test]
    fn a_scope_may_run_from_a_marker_to_the_end_of_the_file() {
        let ops = ops(
            "file a.rs\n  replace 'state.record(' with 'state.record_now(' all in /^mod tests \\{/ .. $\n",
        );
        match &ops[0].kind {
            OpKind::Replace { scope, .. } => {
                let scope = scope.as_ref().expect("an `in` scope");
                assert!(
                    matches!(&scope.start, Addr::Regex(r, None) if r.source == r"^mod tests \{")
                );
                assert!(matches!(scope.end, Addr::Last));
            }
            other => panic!("expected replace, got {other:?}"),
        }
    }

    #[test]
    fn append_and_create_carry_their_bodies() {
        let p = program(concat!(
            "file gallery-motion-bench.css\n",
            "  append <<\n",
            "\n",
            ".gmb-escaped {\n",
            "  position: fixed;\n",
            "}\n",
            ">>\n",
            "file tests/model-eval/verbs.txt\n",
            "  create <<\n",
            "add audit author\n",
            ">>\n",
        ));
        match &p.blocks[0].ops[0].kind {
            OpKind::Append { body } => {
                assert_eq!(
                    body,
                    &vec![
                        "".to_string(),
                        ".gmb-escaped {".into(),
                        "  position: fixed;".into(),
                        "}".into(),
                    ]
                );
            }
            other => panic!("expected append, got {other:?}"),
        }
        match &p.blocks[1].ops[0].kind {
            OpKind::Create { body } => assert_eq!(body, &vec!["add audit author".to_string()]),
            other => panic!("expected create, got {other:?}"),
        }
    }

    #[test]
    fn write_and_lines_replace_and_delete_every_parse() {
        let write = ops("file a.txt\n  write <<\nwhole\n>>\n");
        assert!(
            matches!(&write[0].kind, OpKind::Write { body } if body == &vec!["whole".to_string()])
        );

        let lines = ops("file a.txt\n  lines 3 until 'end marker' replace << >>\n");
        match &lines[0].kind {
            OpKind::Lines { range, body } => {
                assert!(range.exclusive_end);
                assert!(body.is_empty());
            }
            other => panic!("expected lines, got {other:?}"),
        }

        let every = ops("file a.txt\n  delete every /^debug!/\n");
        assert!(matches!(
            &every[0].kind,
            OpKind::Delete {
                target: DeleteTarget::Every(Addr::Regex(_, None))
            }
        ));
    }

    #[test]
    fn a_match_qualifier_selects_which_hit_an_address_means() {
        let ops = ops(
            "file a.txt\n  before /^fn go/[3] insert <<\n  x\n  >>\n  after 'tail'[-1] insert << >>\n",
        );
        assert!(matches!(
            &ops[0].kind,
            OpKind::Insert {
                anchor: Addr::Regex(_, Some(3)),
                ..
            }
        ));
        assert!(matches!(
            &ops[1].kind,
            OpKind::Insert {
                anchor: Addr::Literal(_, Some(-1)),
                ..
            }
        ));
    }

    #[test]
    fn a_body_is_verbatim_whatever_its_op_line_is_indented_by() {
        // The body is the file's bytes, as an `Edit`'s `old_string` is. Nothing
        // about the op line's own indentation is subtracted from it, and the
        // `>>` may sit wherever the writer put it.
        let ops = ops("file a.txt\n  append <<\n\n    kept four\n      kept six\n>>\n");
        match &ops[0].kind {
            OpKind::Append { body } => assert_eq!(
                body,
                &vec![
                    "".to_string(),
                    "    kept four".into(),
                    "      kept six".into()
                ]
            ),
            other => panic!("expected append, got {other:?}"),
        }
    }

    #[test]
    fn the_shell_apostrophe_idiom_is_named_rather_than_left_as_trailing_text() {
        let err = failure("file a.txt\n  replace 'the deck'\"'\"'s edge' with 'x'\n");
        assert!(err.message.contains("shell's apostrophe idiom"), "{err}");
        assert!(err.message.contains("inside \"…\""), "{err}");
        let err = failure("file a.txt\n  replace 'the deck'\\''s edge' with 'x'\n");
        assert!(err.message.contains("shell's apostrophe idiom"), "{err}");
    }

    #[test]
    fn the_default_guard_is_expect_one_for_both_replace_and_sub() {
        let ops = ops("file a.txt\n  replace 'a' with 'b'\n  sub /a/ 'b'\n");
        assert!(matches!(
            &ops[0].kind,
            OpKind::Replace {
                count: Count::Expect(1),
                ..
            }
        ));
        assert!(matches!(
            &ops[1].kind,
            OpKind::Sub {
                count: Count::Expect(1),
                ..
            }
        ));
    }

    #[test]
    fn all_and_an_explicit_expect_parse() {
        let ops = ops("file a.txt\n  replace 'a' with 'b' all\n  sub /a/ 'b' expect 3\n");
        assert!(matches!(
            &ops[0].kind,
            OpKind::Replace {
                count: Count::All,
                ..
            }
        ));
        assert!(matches!(
            &ops[1].kind,
            OpKind::Sub {
                count: Count::Expect(3),
                ..
            }
        ));
    }

    #[test]
    fn comments_and_blank_lines_are_ignored_outside_bodies() {
        let ops = ops("# leading\nfile a.txt\n\n  # a note\n  delete 4  # trailing\n");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].line, 5);
    }

    #[test]
    fn a_whole_file_op_beside_another_op_is_refused_at_its_line() {
        let err = failure("file a.txt\n  delete 1\n  write <<\n  x\n  >>\n");
        assert_eq!(err.line, 3);
        assert!(err.message.contains("only op"), "{}", err.message);

        let err = failure("file a.txt\n  create <<\n  x\n  >>\n  delete 1\n");
        assert_eq!(err.line, 2);
    }

    #[test]
    fn an_unterminated_body_names_the_line_that_opened_it() {
        let err = failure("file a.txt\n  append <<\n  x\n");
        assert_eq!(err.line, 2);
        assert!(err.message.contains("no `>>`"), "{}", err.message);
    }

    #[test]
    fn an_unterminated_string_names_its_opening_quote() {
        let err = failure("file a.txt\n  delete 'no closing quote\n");
        assert_eq!((err.line, err.col), (2, 10));
        assert!(
            err.message.contains("unterminated string"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_replace_carries_a_body_on_both_sides() {
        // The shape three of the first four field uses of the verb were
        // written in, and all three were refused: a CSS block replaced whole.
        // A quoted literal cannot span lines, so this is the form that does.
        let ops = ops(concat!(
            "file dash-lifecycle-line.css\n",
            "  replace <<\n",
            "  .tug-dash-lifecycle-line {\n",
            "    display: flex;\n",
            "  }\n",
            "  >> with <<\n",
            "  .tug-dash-lifecycle-line {\n",
            "    display: flex;\n",
            "    overflow: hidden;\n",
            "  }\n",
            "  >>\n",
        ));
        assert_eq!(ops.len(), 1);
        match &ops[0].kind {
            OpKind::Replace {
                find, with, count, ..
            } => {
                assert_eq!(
                    find,
                    &Text::Body(vec![
                        "  .tug-dash-lifecycle-line {".into(),
                        "    display: flex;".into(),
                        "  }".into(),
                    ])
                );
                assert_eq!(
                    with,
                    &Text::Body(vec![
                        "  .tug-dash-lifecycle-line {".into(),
                        "    display: flex;".into(),
                        "    overflow: hidden;".into(),
                        "  }".into(),
                    ])
                );
                assert_eq!(*count, Count::Expect(1));
            }
            other => panic!("expected replace, got {other:?}"),
        }
    }

    #[test]
    fn a_two_body_replace_takes_a_count_and_a_scope_after_its_last_body() {
        let ops = ops(concat!(
            "file a.rs\n",
            "  replace <<\n",
            "  old\n",
            "  >> with <<\n",
            "  new\n",
            "  >> all in 350 .. 900\n",
        ));
        match &ops[0].kind {
            OpKind::Replace { count, scope, .. } => {
                assert_eq!(*count, Count::All);
                let scope = scope.as_ref().expect("an `in` scope");
                assert!(matches!(scope.start, Addr::Line(350)));
                assert!(matches!(scope.end, Addr::Line(900)));
            }
            other => panic!("expected replace, got {other:?}"),
        }
    }

    #[test]
    fn the_op_after_a_two_body_replace_is_an_ordinary_op() {
        let ops = ops("file a.txt\n  replace <<\n  a\n  >> with <<\n  b\n  >>\n  delete 1\n");
        assert_eq!(ops.len(), 2);
        assert!(matches!(&ops[1].kind, OpKind::Delete { .. }));
        assert_eq!(ops[1].line, 7);
    }

    #[test]
    fn a_body_line_starting_with_two_angles_is_content_not_a_terminator() {
        // A markdown blockquote carried in a body. Only a `>>` followed by
        // nothing, or by the op's own continuation word, closes one.
        let ops = ops("file a.md\n  append <<\n  >> quoted\n  text\n  >>\n");
        match &ops[0].kind {
            OpKind::Append { body } => {
                assert_eq!(body, &vec!["  >> quoted".to_string(), "  text".into()]);
            }
            other => panic!("expected append, got {other:?}"),
        }
    }

    #[test]
    fn a_multi_line_literal_is_refused_with_the_body_form_named() {
        let err = failure("file a.css\n  replace 'a {\n  x: 1;\n}' with 'b'\n");
        assert_eq!((err.line, err.col), (2, 11));
        assert!(err.message.contains("one line"), "{}", err.message);
        assert!(err.message.contains("`<<` body"), "{}", err.message);
    }

    #[test]
    fn a_doubled_quote_is_named_rather_than_left_as_trailing_text() {
        // The other way the field uses went wrong: `''` written for an escaped
        // quote, the shell and SQL convention.
        let err = failure("file a.txt\n  replace 'a' with 'the run''s track'\n");
        assert_eq!(err.line, 2);
        assert!(err.message.contains("doubled quote"), "{}", err.message);
        assert!(err.message.contains(r"\'"), "{}", err.message);
    }

    #[test]
    fn an_empty_string_is_not_read_as_a_doubled_quote() {
        let ops = ops("file a.txt\n  replace '' with 'x'\n  replace 'y' with ''\n");
        assert!(
            matches!(&ops[0].kind, OpKind::Replace { find, .. } if find == &Text::Str(String::new()))
        );
        assert!(
            matches!(&ops[1].kind, OpKind::Replace { with, .. } if with == &Text::Str(String::new()))
        );
    }

    #[test]
    fn an_unknown_op_names_itself_at_its_column() {
        let err = failure("file a.txt\n  frobnicate 3\n");
        assert_eq!((err.line, err.col), (2, 3));
        assert!(err.message.contains("frobnicate"), "{}", err.message);
    }

    #[test]
    fn an_invalid_regex_is_a_parse_error_rather_than_a_late_surprise() {
        let err = failure("file a.txt\n  sub /a(/ 'b'\n");
        assert_eq!(err.line, 2);
        assert!(err.message.contains("invalid regex"), "{}", err.message);
    }

    #[test]
    fn an_op_outside_any_block_is_refused() {
        let err = failure("  delete 1\n");
        assert_eq!(err.line, 1);
        assert!(err.message.contains("`file`"), "{}", err.message);
    }

    #[test]
    fn a_block_with_no_ops_is_refused_at_its_header() {
        let err = failure("file a.txt\nfile b.txt\n  delete 1\n");
        assert_eq!(err.line, 1);
        assert!(err.message.contains("no ops"), "{}", err.message);
    }

    #[test]
    fn the_only_string_escapes_are_the_five_and_every_other_backslash_is_literal() {
        let ops = ops("file a.txt\n  replace 'a\\nb\\\\c\\d' with \"it's \\\"quoted\\\"\"\n");
        match &ops[0].kind {
            OpKind::Replace { find, with, .. } => {
                assert_eq!(find, &Text::Str("a\nb\\c\\d".into()));
                assert_eq!(with, &Text::Str("it's \"quoted\"".into()));
            }
            other => panic!("expected replace, got {other:?}"),
        }
    }

    #[test]
    fn a_regex_carries_its_flags_and_anchors_lines_by_default() {
        let ops = ops("file a.txt\n  sub /^ab$/i 'x' all\n");
        match &ops[0].kind {
            OpKind::Sub { pattern, .. } => {
                assert_eq!(pattern.flags, "i");
                assert!(pattern.regex.is_match("zz\nAB\nyy"));
            }
            other => panic!("expected sub, got {other:?}"),
        }
    }

    #[test]
    fn a_block_is_an_address_wherever_an_address_goes() {
        let ops = ops(concat!(
            "file a.ts\n",
            "  after <<\n",
            "}\n",
            ">> insert <<\n",
            "next\n",
            ">>\n",
            "  delete <<\n",
            "gone\n",
            ">>[2]\n",
            "  lines <<\n",
            "start\n",
            ">> .. <<\n",
            "end\n",
            ">> replace <<\n",
            "fresh\n",
            ">>\n",
        ));
        assert_eq!(ops.len(), 3);
        assert!(matches!(
            &ops[0].kind,
            OpKind::Insert { anchor: Addr::Block(b, None), .. } if b == &vec!["}".to_string()]
        ));
        assert!(matches!(
            &ops[1].kind,
            OpKind::Delete {
                target: DeleteTarget::Every(_) | DeleteTarget::Range(_)
            }
        ));
        match &ops[2].kind {
            OpKind::Lines { range, .. } => {
                assert!(
                    matches!(&range.start, Addr::Block(b, None) if b == &vec!["start".to_string()])
                );
                assert!(
                    matches!(&range.end, Addr::Block(b, None) if b == &vec!["end".to_string()])
                );
            }
            other => panic!("expected lines, got {other:?}"),
        }
    }

    #[test]
    fn the_address_refusal_names_the_block_form() {
        let err = failure("file a.ts\n  after nope insert <<\nx\n>>\n");
        assert!(err.message.contains("a `<<` block"), "{}", err.message);
    }
}
