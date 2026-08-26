//! Phases 2 and 3: read every file the program names, then resolve every
//! address, literal, and regex against that file's **original** bytes.
//!
//! Two properties come out of resolving before anything is written. An address
//! means the line the model just read, however many lines another op in the
//! same program inserts above it. And a program that cannot resolve reports
//! *every* failure it has — with the op's source line and the actual match
//! count — rather than the first, so one run tells the model everything that
//! was stale.

use std::collections::HashMap;

use crate::parse::{Addr, Count, DeleteTarget, Op, OpKind, Program, Range, Side, Text};

/// How the interpreter reads. The CLI implements this over the filesystem;
/// tests implement it over a map, which is what keeps every language semantic
/// provable with no temp directory in sight.
pub trait FileSource {
    /// `Ok(None)` when the file does not exist; `Err` for unreadable or
    /// non-UTF-8 content — a rev does not edit binaries.
    fn read(&self, path: &str) -> Result<Option<String>, String>;
}

/// Whether a file the program produces is new or was already there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeKind {
    Modified,
    Created,
}

/// One splice against a file's original bytes: `[start, end)` becomes
/// `replacement`. A zero-width span is an insertion.
#[derive(Debug, Clone)]
pub struct Edit {
    /// The op that produced it, for an overlap refusal that can name both.
    pub op_line: usize,
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

/// One file's resolved work.
#[derive(Debug, Clone)]
pub struct ResolvedFile {
    pub path: String,
    pub kind: OutcomeKind,
    /// The bytes the edits are positioned against; empty for a created file.
    pub original: String,
    pub eol: String,
    pub edits: Vec<Edit>,
    /// `create` and `write` name the whole content instead of splicing.
    pub whole: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveFailure {
    pub path: String,
    /// 1-based source line of the op that failed.
    pub op_line: usize,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveErrors {
    pub failures: Vec<ResolveFailure>,
}

impl std::fmt::Display for ResolveErrors {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, failure) in self.failures.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(
                f,
                "{}: line {}: {}",
                failure.path, failure.op_line, failure.message
            )?;
        }
        Ok(())
    }
}

impl std::error::Error for ResolveErrors {}

/// Phases 2–3. Reads through `src`, resolves every op against original bytes,
/// and hands back the splices each file needs. Writes nothing, ever.
pub fn resolve(
    program: &Program,
    src: &dyn FileSource,
) -> Result<Vec<ResolvedFile>, ResolveErrors> {
    let mut failures: Vec<ResolveFailure> = Vec::new();

    // Phase 2 — read each named file once, in first-appearance order.
    let mut order: Vec<String> = Vec::new();
    let mut contents: HashMap<String, Option<String>> = HashMap::new();
    for block in &program.blocks {
        for path in &block.paths {
            if contents.contains_key(path) {
                continue;
            }
            order.push(path.clone());
            match src.read(path) {
                Ok(content) => {
                    contents.insert(path.clone(), content);
                }
                Err(message) => {
                    contents.insert(path.clone(), None);
                    failures.push(ResolveFailure {
                        path: path.clone(),
                        op_line: block.line,
                        message,
                    });
                }
            }
        }
    }

    // Gather the ops each file carries, keeping program order.
    let mut work: HashMap<&str, Vec<&Op>> = HashMap::new();
    for block in &program.blocks {
        for path in &block.paths {
            for op in &block.ops {
                work.entry(path.as_str()).or_default().push(op);
            }
        }
    }

    let mut resolved: Vec<ResolvedFile> = Vec::new();
    for path in &order {
        let ops = work.get(path.as_str()).cloned().unwrap_or_default();
        match resolve_file(path, contents.get(path).cloned().flatten(), &ops) {
            Ok(Some(file)) => resolved.push(file),
            Ok(None) => {}
            Err(mut file_failures) => failures.append(&mut file_failures),
        }
    }

    if failures.is_empty() {
        Ok(resolved)
    } else {
        failures.sort_by_key(|f| f.op_line);
        Err(ResolveErrors { failures })
    }
}

fn resolve_file(
    path: &str,
    content: Option<String>,
    ops: &[&Op],
) -> Result<Option<ResolvedFile>, Vec<ResolveFailure>> {
    let mut failures: Vec<ResolveFailure> = Vec::new();
    let fail = |failures: &mut Vec<ResolveFailure>, op_line: usize, message: String| {
        failures.push(ResolveFailure {
            path: path.to_string(),
            op_line,
            message,
        });
    };

    // A whole-file op is the only op in its block, but the same file may open
    // several blocks — one that writes it whole and one that edits it is a
    // contradiction rather than an ordering.
    let whole_ops: Vec<&&Op> = ops
        .iter()
        .filter(|op| matches!(op.kind, OpKind::Create { .. } | OpKind::Write { .. }))
        .collect();
    if !whole_ops.is_empty() && ops.len() > 1 {
        fail(
            &mut failures,
            whole_ops[0].line,
            format!(
                "`{}` writes the whole file, but this program also edits it",
                whole_ops[0].kind.word()
            ),
        );
        return Err(failures);
    }

    if let Some(op) = whole_ops.first() {
        let eol = detect_eol(content.as_deref().unwrap_or(""));
        return match &op.kind {
            OpKind::Create { body } => {
                if content.is_some() {
                    fail(
                        &mut failures,
                        op.line,
                        "`create` refuses a file that already exists".to_string(),
                    );
                    return Err(failures);
                }
                Ok(Some(ResolvedFile {
                    path: path.to_string(),
                    kind: OutcomeKind::Created,
                    original: String::new(),
                    whole: Some(body_as_content(body, &eol)),
                    eol,
                    edits: Vec::new(),
                }))
            }
            OpKind::Write { body } => {
                let kind = if content.is_some() {
                    OutcomeKind::Modified
                } else {
                    OutcomeKind::Created
                };
                Ok(Some(ResolvedFile {
                    path: path.to_string(),
                    kind,
                    original: content.unwrap_or_default(),
                    whole: Some(body_as_content(body, &eol)),
                    eol,
                    edits: Vec::new(),
                }))
            }
            _ => unreachable!("whole_ops holds only create and write"),
        };
    }

    let Some(text) = content else {
        // The read phase already reported an unreadable file; a missing one is
        // reported here, against the first op that wanted it.
        let line = ops.first().map(|op| op.line).unwrap_or(1);
        fail(&mut failures, line, "no such file".to_string());
        return Err(failures);
    };

    let doc = Doc::new(&text);
    let mut edits: Vec<Edit> = Vec::new();
    for op in ops {
        match resolve_op(&doc, op) {
            Ok(mut produced) => edits.append(&mut produced),
            Err(message) => fail(&mut failures, op.line, message),
        }
    }

    if failures.is_empty() {
        if let Some((op_line, message)) = overlap(&edits) {
            fail(&mut failures, op_line, message);
        }
    }

    if !failures.is_empty() {
        return Err(failures);
    }

    let eol = doc.eol.to_string();
    Ok(Some(ResolvedFile {
        path: path.to_string(),
        kind: OutcomeKind::Modified,
        original: text,
        eol,
        edits,
        whole: None,
    }))
}

/// Two ops whose spans intersect mean the model's picture of the file has
/// diverged from its bytes. Adjacency is fine; an insertion at the edge of a
/// deleted range is adjacency.
fn overlap(edits: &[Edit]) -> Option<(usize, String)> {
    let mut sorted: Vec<&Edit> = edits.iter().collect();
    sorted.sort_by_key(|e| (e.start, e.end));
    for pair in sorted.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if a.start < b.end && b.start < a.end {
            let (first, second) = (a.op_line.min(b.op_line), a.op_line.max(b.op_line));
            return Some((
                first,
                format!(
                    "this op's span overlaps the one on line {second} — ops never observe each other, so an overlap has no meaning"
                ),
            ));
        }
    }
    None
}

fn resolve_op(doc: &Doc, op: &Op) -> Result<Vec<Edit>, String> {
    match &op.kind {
        OpKind::Replace {
            find,
            with,
            count,
            scope,
        } => {
            let needle = text_of(find, doc.eol);
            if needle.is_empty() {
                return Err("the text to replace is empty".to_string());
            }
            let replacement = text_of(with, doc.eol);
            let (from, to) = doc.scope_span(scope.as_ref())?;
            let hay = &doc.text[from..to];
            let mut hits: Vec<usize> = Vec::new();
            let mut cursor = 0;
            while let Some(at) = hay[cursor..].find(&needle) {
                hits.push(from + cursor + at);
                cursor += at + needle.len();
            }
            guard(*count, hits.len(), "match")?;
            Ok(hits
                .into_iter()
                .map(|start| Edit {
                    op_line: op.line,
                    start,
                    end: start + needle.len(),
                    replacement: replacement.clone(),
                })
                .collect())
        }
        OpKind::Sub {
            pattern,
            repl,
            count,
            scope,
        } => {
            let (from, to) = doc.scope_span(scope.as_ref())?;
            let hay = &doc.text[from..to];
            let mut produced: Vec<Edit> = Vec::new();
            for caps in pattern.regex.captures_iter(hay) {
                let whole = caps.get(0).expect("group 0 always matches");
                let mut replacement = String::new();
                caps.expand(repl, &mut replacement);
                produced.push(Edit {
                    op_line: op.line,
                    start: from + whole.start(),
                    end: from + whole.end(),
                    replacement,
                });
            }
            guard(*count, produced.len(), "match")?;
            Ok(produced)
        }
        OpKind::Insert {
            anchor,
            side,
            indented,
            body,
        } => {
            let line = doc.line_of(anchor)?;
            let pad = if *indented {
                doc.leading_whitespace(line)
            } else {
                String::new()
            };
            let text: String = body
                .iter()
                .map(|l| {
                    if l.is_empty() {
                        format!("{}{}", l, doc.eol)
                    } else {
                        format!("{pad}{l}{}", doc.eol)
                    }
                })
                .collect();
            let (at, prefix) = match side {
                Side::Before => (doc.lines[line].start, String::new()),
                Side::After => doc.after_line(line),
            };
            Ok(vec![Edit {
                op_line: op.line,
                start: at,
                end: at,
                replacement: format!("{prefix}{text}"),
            }])
        }
        OpKind::Append { body } => {
            let (at, prefix) = if doc.lines.is_empty() {
                (0, String::new())
            } else {
                doc.after_line(doc.lines.len() - 1)
            };
            let text: String = body.iter().map(|l| format!("{l}{}", doc.eol)).collect();
            Ok(vec![Edit {
                op_line: op.line,
                start: at,
                end: at,
                replacement: format!("{prefix}{text}"),
            }])
        }
        OpKind::Delete { target } => match target {
            DeleteTarget::Range(range) => {
                let (first, last) = doc.range_of(range)?;
                let (start, end) = doc.cut_span(first, last);
                Ok(vec![Edit {
                    op_line: op.line,
                    start,
                    end,
                    replacement: String::new(),
                }])
            }
            DeleteTarget::Every(addr) => {
                let lines = doc.every_line_of(addr)?;
                Ok(lines
                    .into_iter()
                    .map(|line| {
                        let (start, end) = doc.cut_span(line, line);
                        Edit {
                            op_line: op.line,
                            start,
                            end,
                            replacement: String::new(),
                        }
                    })
                    .collect())
            }
        },
        OpKind::Lines { range, body } => {
            let (first, last) = doc.range_of(range)?;
            let span = doc.lines[last].next;
            let keeps_bare_ending = span == doc.text.len() && !doc.final_newline;
            let replacement = if keeps_bare_ending {
                body.join(doc.eol)
            } else {
                body.iter().map(|l| format!("{l}{}", doc.eol)).collect()
            };
            let (start, end) = if body.is_empty() {
                doc.cut_span(first, last)
            } else {
                (doc.lines[first].start, span)
            };
            Ok(vec![Edit {
                op_line: op.line,
                start,
                end,
                replacement,
            }])
        }
        OpKind::Move {
            range,
            side,
            anchor,
        } => {
            let (first, last) = doc.range_of(range)?;
            let landing = doc.line_of(anchor)?;
            if landing >= first && landing <= last {
                return Err(format!(
                    "the anchor on line {} lies inside the range this op moves",
                    landing + 1
                ));
            }
            let (cut_start, cut_end) = doc.cut_span(first, last);
            let mut moved = doc.text[doc.lines[first].start..doc.lines[last].next].to_string();
            if !moved.ends_with(doc.eol) {
                moved.push_str(doc.eol);
            }
            let (at, prefix) = match side {
                Side::Before => (doc.lines[landing].start, String::new()),
                Side::After => doc.after_line(landing),
            };
            Ok(vec![
                Edit {
                    op_line: op.line,
                    start: cut_start,
                    end: cut_end,
                    replacement: String::new(),
                },
                Edit {
                    op_line: op.line,
                    start: at,
                    end: at,
                    replacement: format!("{prefix}{moved}"),
                },
            ])
        }
        OpKind::Create { .. } | OpKind::Write { .. } => {
            unreachable!("whole-file ops are resolved before the document is built")
        }
    }
}

fn guard(count: Count, found: usize, noun: &str) -> Result<(), String> {
    match count {
        Count::Expect(want) if found != want => Err(format!(
            "expected {want} {noun}{}, found {found}",
            if want == 1 { "" } else { "es" }
        )),
        Count::All if found == 0 => Err(format!("`all` wants at least one {noun}, found none")),
        _ => Ok(()),
    }
}

fn text_of(text: &Text, eol: &str) -> String {
    match text {
        Text::Str(s) => s.clone(),
        Text::Body(lines) => lines.join(eol),
    }
}

/// A body standing for a whole file: every line ends with the file's ending.
fn body_as_content(body: &[String], eol: &str) -> String {
    body.iter().map(|l| format!("{l}{eol}")).collect()
}

fn detect_eol(text: &str) -> String {
    if text.contains("\r\n") { "\r\n" } else { "\n" }.to_string()
}

struct LineSpan {
    start: usize,
    /// End of the line's text, excluding its ending.
    text_end: usize,
    /// Start of the next line, or the end of the file.
    next: usize,
}

struct Doc<'a> {
    text: &'a str,
    eol: &'a str,
    lines: Vec<LineSpan>,
    final_newline: bool,
}

impl<'a> Doc<'a> {
    fn new(text: &'a str) -> Self {
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let mut lines = Vec::new();
        let mut start = 0;
        while start < text.len() {
            match text[start..].find('\n') {
                Some(offset) => {
                    let newline = start + offset;
                    let text_end = if newline > start && text.as_bytes()[newline - 1] == b'\r' {
                        newline - 1
                    } else {
                        newline
                    };
                    lines.push(LineSpan {
                        start,
                        text_end,
                        next: newline + 1,
                    });
                    start = newline + 1;
                }
                None => {
                    lines.push(LineSpan {
                        start,
                        text_end: text.len(),
                        next: text.len(),
                    });
                    start = text.len();
                }
            }
        }
        let final_newline = text.ends_with('\n');
        Doc {
            text,
            eol,
            lines,
            final_newline,
        }
    }

    fn line_text(&self, index: usize) -> &str {
        &self.text[self.lines[index].start..self.lines[index].text_end]
    }

    fn leading_whitespace(&self, index: usize) -> String {
        self.line_text(index)
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect()
    }

    /// Where an insertion after `index` lands, and the ending it must carry
    /// first when the file's last line has none.
    fn after_line(&self, index: usize) -> (usize, String) {
        let line = &self.lines[index];
        if line.next == self.text.len() && !self.final_newline {
            (self.text.len(), self.eol.to_string())
        } else {
            (line.next, String::new())
        }
    }

    /// The span a deletion of lines `first..=last` removes. Cutting the last
    /// line of a file that ends without a newline takes the preceding line's
    /// ending with it, so the file keeps its bare ending.
    fn cut_span(&self, first: usize, last: usize) -> (usize, usize) {
        let end = self.lines[last].next;
        if end == self.text.len() && !self.final_newline && first > 0 {
            (self.lines[first - 1].text_end, end)
        } else {
            (self.lines[first].start, end)
        }
    }

    fn scope_span(&self, scope: Option<&Range>) -> Result<(usize, usize), String> {
        match scope {
            None => Ok((0, self.text.len())),
            Some(range) => {
                let (first, last) = self.range_of(range)?;
                Ok((self.lines[first].start, self.lines[last].next))
            }
        }
    }

    fn range_of(&self, range: &Range) -> Result<(usize, usize), String> {
        let first = self.line_of(&range.start)?;
        let mut last = self.line_of(&range.end)?;
        if range.exclusive_end {
            if last == 0 {
                return Err(
                    "the range's `until` end is the first line, so it holds nothing".to_string(),
                );
            }
            last -= 1;
        }
        if last < first {
            return Err(format!(
                "the range ends on line {} but starts on line {}",
                last + 1,
                first + 1
            ));
        }
        Ok((first, last))
    }

    /// A single line, by any address form.
    fn line_of(&self, addr: &Addr) -> Result<usize, String> {
        if self.lines.is_empty() {
            return Err("the file has no lines to address".to_string());
        }
        match addr {
            Addr::Line(n) => {
                if *n > self.lines.len() {
                    Err(format!(
                        "line {n} is past the end of the file, which has {} lines",
                        self.lines.len()
                    ))
                } else {
                    Ok(n - 1)
                }
            }
            Addr::Last => Ok(self.lines.len() - 1),
            Addr::Regex(pattern, qualifier) => {
                let hits = self.matching_lines(|line| pattern.regex.is_match(line));
                pick(hits, *qualifier, &format!("/{}/", pattern.source))
            }
            Addr::Literal(literal, qualifier) => {
                let hits = self.matching_lines(|line| line.contains(literal.as_str()));
                pick(hits, *qualifier, &format!("`{literal}`"))
            }
        }
    }

    /// Every line an address matches — the `delete every` shape, and the one
    /// place an unqualified address may match many times.
    fn every_line_of(&self, addr: &Addr) -> Result<Vec<usize>, String> {
        match addr {
            Addr::Regex(pattern, None) => {
                let hits = self.matching_lines(|line| pattern.regex.is_match(line));
                if hits.is_empty() {
                    Err(format!("no line matches /{}/", pattern.source))
                } else {
                    Ok(hits)
                }
            }
            Addr::Literal(literal, None) => {
                let hits = self.matching_lines(|line| line.contains(literal.as_str()));
                if hits.is_empty() {
                    Err(format!("no line contains `{literal}`"))
                } else {
                    Ok(hits)
                }
            }
            other => Ok(vec![self.line_of(other)?]),
        }
    }

    fn matching_lines(&self, mut predicate: impl FnMut(&str) -> bool) -> Vec<usize> {
        (0..self.lines.len())
            .filter(|i| predicate(self.line_text(*i)))
            .collect()
    }
}

/// Apply a `[K]` qualifier, or insist the address matched exactly once.
fn pick(hits: Vec<usize>, qualifier: Option<i64>, what: &str) -> Result<usize, String> {
    match qualifier {
        None => match hits.len() {
            0 => Err(format!("no line matches {what}")),
            1 => Ok(hits[0]),
            n => Err(format!(
                "{n} lines match {what} — say which with `[1]`…`[{n}]`, or `[-1]` for the last"
            )),
        },
        Some(k) if k > 0 => hits.get(k as usize - 1).copied().ok_or_else(|| {
            format!(
                "{what} has no match [{k}] — it matches {} line(s)",
                hits.len()
            )
        }),
        Some(k) => {
            let from_end = (-k) as usize;
            if from_end > hits.len() {
                Err(format!(
                    "{what} has no match [{k}] — it matches {} line(s)",
                    hits.len()
                ))
            } else {
                Ok(hits[hits.len() - from_end])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;

    /// Four lines of three characters: line `n` starts at byte `4 * (n - 1)`,
    /// which is what makes a span assertion readable.
    const DOC: &str = "aaa\nbbb\nccc\nddd\n";

    struct Files(HashMap<String, String>);

    impl FileSource for Files {
        fn read(&self, path: &str) -> Result<Option<String>, String> {
            if path.ends_with(".bin") {
                return Err(format!("{path}: not UTF-8"));
            }
            Ok(self.0.get(path).cloned())
        }
    }

    fn files(pairs: &[(&str, &str)]) -> Files {
        Files(
            pairs
                .iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect(),
        )
    }

    fn plan(source: &str, pairs: &[(&str, &str)]) -> Vec<ResolvedFile> {
        let program = parse(source).expect("program parses");
        resolve(&program, &files(pairs)).expect("program resolves")
    }

    fn refusal(source: &str, pairs: &[(&str, &str)]) -> ResolveErrors {
        let program = parse(source).expect("program parses");
        resolve(&program, &files(pairs)).expect_err("program is refused")
    }

    fn spans(source: &str, pairs: &[(&str, &str)]) -> Vec<(usize, usize)> {
        plan(source, pairs)
            .into_iter()
            .flat_map(|f| f.edits)
            .map(|e| (e.start, e.end))
            .collect()
    }

    fn only(pairs: &[(&str, &str)], op: &str) -> Vec<(usize, usize)> {
        spans(&format!("file a.txt\n  {op}\n"), pairs)
    }

    fn doc() -> Vec<(&'static str, &'static str)> {
        vec![("a.txt", DOC)]
    }

    #[test]
    fn every_address_form_resolves_to_the_line_it_names() {
        assert_eq!(only(&doc(), "delete 2"), vec![(4, 8)]);
        assert_eq!(only(&doc(), "delete /^ccc/"), vec![(8, 12)]);
        assert_eq!(only(&doc(), "delete 'ddd'"), vec![(12, 16)]);
        assert_eq!(only(&doc(), "delete $"), vec![(12, 16)]);
    }

    #[test]
    fn a_dotdot_range_includes_its_end_and_until_excludes_it() {
        assert_eq!(only(&doc(), "delete 2 .. 3"), vec![(4, 12)]);
        assert_eq!(only(&doc(), "delete 2 until 4"), vec![(4, 12)]);
        assert_eq!(only(&doc(), "delete 'bbb' until 'ddd'"), vec![(4, 12)]);
    }

    #[test]
    fn a_match_qualifier_picks_which_hit_and_an_unqualified_multi_match_is_refused() {
        let repeated = vec![("a.txt", "x\nm\ny\nm\nz\nm\n")];
        assert_eq!(only(&repeated, "delete 'm'[2]"), vec![(6, 8)]);
        assert_eq!(only(&repeated, "delete 'm'[-1]"), vec![(10, 12)]);

        let err = refusal("file a.txt\n  delete 'm'\n", &repeated);
        assert_eq!(err.failures.len(), 1);
        assert!(
            err.failures[0].message.contains("3 lines match"),
            "{}",
            err.failures[0].message
        );

        let err = refusal("file a.txt\n  delete 'm'[4]\n", &repeated);
        assert!(
            err.failures[0].message.contains("matches 3 line(s)"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn a_guard_mismatch_names_the_ops_line_and_the_actual_count() {
        let err = refusal(
            "file a.txt\n  # a note\n  replace 'a' with 'z'\n",
            &[("a.txt", "aaa\n")],
        );
        assert_eq!(err.failures.len(), 1);
        assert_eq!(err.failures[0].op_line, 3);
        assert_eq!(err.failures[0].path, "a.txt");
        assert_eq!(err.failures[0].message, "expected 1 match, found 3");
    }

    #[test]
    fn all_wants_at_least_one_match() {
        let err = refusal(
            "file a.txt\n  replace 'q' with 'z' all\n",
            &[("a.txt", "aaa\n")],
        );
        assert!(
            err.failures[0].message.contains("at least one"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn in_a_files_block_the_guard_holds_per_file() {
        let err = refusal(
            "files a.txt b.txt\n  replace 'q' with 'r' all\n",
            &[("a.txt", "q\n"), ("b.txt", "nothing here\n")],
        );
        assert_eq!(err.failures.len(), 1);
        assert_eq!(err.failures[0].path, "b.txt");
    }

    #[test]
    fn a_two_failure_program_reports_both_in_one_run() {
        let err = refusal(
            "file a.txt\n  delete 99\n  replace 'zzz' with 'y'\n",
            &doc(),
        );
        assert_eq!(err.failures.len(), 2);
        assert_eq!(err.failures[0].op_line, 2);
        assert_eq!(err.failures[1].op_line, 3);
        assert!(
            err.failures[0].message.contains("4 lines"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn overlapping_spans_are_refused_and_adjacent_ones_are_not() {
        let err = refusal("file a.txt\n  delete 1 .. 2\n  delete 2 .. 3\n", &doc());
        assert_eq!(err.failures[0].op_line, 2);
        assert!(
            err.failures[0]
                .message
                .contains("overlaps the one on line 3"),
            "{}",
            err.failures[0].message
        );

        assert_eq!(
            spans("file a.txt\n  delete 1 .. 2\n  delete 3\n", &doc()),
            vec![(0, 8), (8, 12)]
        );
    }

    #[test]
    fn an_insertion_at_the_edge_of_a_deleted_range_is_adjacency() {
        assert_eq!(
            spans(
                "file a.txt\n  delete 2 .. 3\n  before 2 insert <<\n  new\n  >>\n",
                &doc()
            ),
            vec![(4, 12), (4, 4)]
        );
    }

    #[test]
    fn a_move_anchored_inside_its_own_range_is_refused() {
        let err = refusal("file a.txt\n  move 2 .. 3 before 3\n", &doc());
        assert!(
            err.failures[0].message.contains("lies inside the range"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn a_move_cuts_at_its_source_and_inserts_at_its_anchor() {
        assert_eq!(
            spans("file a.txt\n  move 3 .. 4 before 1\n", &doc()),
            vec![(8, 16), (0, 0)]
        );
    }

    #[test]
    fn a_range_whose_end_precedes_its_start_is_refused() {
        let err = refusal("file a.txt\n  delete 3 .. 2\n", &doc());
        assert!(
            err.failures[0].message.contains("ends on line 2"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn a_scope_limits_both_the_edit_and_the_count_it_is_guarded_by() {
        let repeated = vec![("a.txt", "q\nq\nq\nq\n")];
        assert_eq!(
            only(&repeated, "replace 'q' with 'z' all in 2 .. 3"),
            vec![(2, 3), (4, 5)]
        );

        let err = refusal(
            "file a.txt\n  replace 'q' with 'z' expect 4 in 2 .. 3\n",
            &repeated,
        );
        assert_eq!(err.failures[0].message, "expected 4 matches, found 2");
    }

    #[test]
    fn a_sub_expands_its_captures_into_the_replacement() {
        let plan = plan(
            "file a.txt\n  sub /foo_(\\w+)/ 'bar_$1' all\n",
            &[("a.txt", "foo_one\nfoo_two\n")],
        );
        let edits = &plan[0].edits;
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].replacement, "bar_one");
        assert_eq!(edits[1].replacement, "bar_two");
    }

    #[test]
    fn delete_every_is_the_one_address_that_may_match_many_lines() {
        let repeated = vec![("a.txt", "keep\ndrop\nkeep\ndrop\n")];
        assert_eq!(
            only(&repeated, "delete every /^drop/"),
            vec![(5, 10), (15, 20)]
        );

        let err = refusal("file a.txt\n  delete every /^nothing/\n", &repeated);
        assert!(
            err.failures[0].message.contains("no line matches"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn a_missing_file_is_an_error_except_under_create_and_write() {
        let err = refusal("file gone.txt\n  delete 1\n", &[]);
        assert_eq!(err.failures[0].message, "no such file");

        let created = plan("file new.txt\n  create <<\n  hello\n  >>\n", &[]);
        assert_eq!(created[0].kind, OutcomeKind::Created);
        assert_eq!(created[0].whole.as_deref(), Some("hello\n"));

        let written = plan("file new.txt\n  write <<\n  hello\n  >>\n", &[]);
        assert_eq!(written[0].kind, OutcomeKind::Created);

        let over = plan("file a.txt\n  write <<\n  hello\n  >>\n", &doc());
        assert_eq!(over[0].kind, OutcomeKind::Modified);
    }

    #[test]
    fn create_refuses_a_file_that_already_exists() {
        let err = refusal("file a.txt\n  create <<\n  hello\n  >>\n", &doc());
        assert!(
            err.failures[0].message.contains("already exists"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn a_file_written_whole_and_edited_by_the_same_program_is_a_contradiction() {
        let err = refusal(
            "file a.txt\n  delete 1\nfile a.txt\n  write <<\n  x\n  >>\n",
            &doc(),
        );
        assert!(
            err.failures[0].message.contains("also edits it"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn an_unreadable_file_fails_the_program_with_what_the_source_said() {
        let err = refusal("file a.bin\n  delete 1\n", &[]);
        assert!(
            err.failures[0].message.contains("not UTF-8"),
            "{}",
            err.failures[0].message
        );
    }

    #[test]
    fn a_file_is_read_once_however_many_blocks_name_it() {
        struct Counting(std::cell::Cell<usize>);
        impl FileSource for Counting {
            fn read(&self, _path: &str) -> Result<Option<String>, String> {
                self.0.set(self.0.get() + 1);
                Ok(Some(DOC.to_string()))
            }
        }
        let program = parse("file a.txt\n  delete 1\nfile a.txt\n  delete 3\n").unwrap();
        let source = Counting(std::cell::Cell::new(0));
        resolve(&program, &source).expect("resolves");
        assert_eq!(source.0.get(), 1);
    }
}
