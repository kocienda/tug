//! The scanner the parser reads a `.rev` program through.
//!
//! A rev is line-oriented and its one multi-line construct — the `<<` … `>>`
//! body — swallows whatever is between its delimiters, so there is no token
//! stream that can be produced ahead of the parse: `/` opens a regex after
//! `sub` and a path after `file`, and a body's lines are text rather than
//! tokens. The scanner therefore reads on demand, and the parser asks for the
//! shape it expects at each position.
//!
//! Every reader reports its position as a 1-based line and column, which is
//! what a parse error carries.

use crate::ParseError;

pub(crate) struct Scanner {
    lines: Vec<Vec<char>>,
    pub(crate) line: usize,
    pub(crate) col: usize,
}

impl Scanner {
    pub(crate) fn new(source: &str) -> Self {
        Self {
            lines: source.lines().map(|l| l.chars().collect()).collect(),
            line: 0,
            col: 0,
        }
    }

    pub(crate) fn error(&self, message: impl Into<String>) -> ParseError {
        self.error_at(self.line + 1, self.col + 1, message)
    }

    pub(crate) fn error_at(
        &self,
        line: usize,
        col: usize,
        message: impl Into<String>,
    ) -> ParseError {
        ParseError {
            line,
            col,
            message: message.into(),
        }
    }

    pub(crate) fn finished(&self) -> bool {
        self.line >= self.lines.len()
    }

    pub(crate) fn peek(&self) -> Option<char> {
        self.lines.get(self.line).and_then(|l| l.get(self.col)).copied()
    }

    pub(crate) fn peek_at(&self, ahead: usize) -> Option<char> {
        self.lines
            .get(self.line)
            .and_then(|l| l.get(self.col + ahead))
            .copied()
    }

    pub(crate) fn skip_spaces(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.col += 1;
        }
    }

    /// True when only whitespace or a comment remains on this line.
    pub(crate) fn at_line_end(&mut self) -> bool {
        self.skip_spaces();
        matches!(self.peek(), None | Some('#'))
    }

    pub(crate) fn advance_line(&mut self) {
        self.line += 1;
        self.col = 0;
    }

    /// Position at the first content character of the next line that is
    /// neither blank nor a comment, and report that line's indentation — the
    /// width a body opened on it is dedented by.
    pub(crate) fn next_content_line(&mut self) -> Option<usize> {
        while !self.finished() {
            self.col = 0;
            self.skip_spaces();
            let indent = self.col;
            if self.at_line_end() {
                self.advance_line();
                continue;
            }
            self.col = indent;
            return Some(indent);
        }
        None
    }

    /// Consume the rest of the line, refusing anything but whitespace and a
    /// comment. Trailing text is a parse error rather than something quietly
    /// ignored: a word the parser did not understand is a word the model meant.
    pub(crate) fn finish_line(&mut self) -> Result<(), ParseError> {
        if !self.at_line_end() {
            return Err(self.error("unexpected text at the end of the line"));
        }
        self.advance_line();
        Ok(())
    }

    /// The next whitespace-delimited word, without consuming it. A `#` opens a
    /// comment, so it is never a word.
    pub(crate) fn peek_word(&self) -> Option<String> {
        let line = self.lines.get(self.line)?;
        let mut col = self.col;
        while matches!(line.get(col), Some(' ' | '\t')) {
            col += 1;
        }
        if line.get(col) == Some(&'#') {
            return None;
        }
        let start = col;
        while let Some(c) = line.get(col) {
            if *c == ' ' || *c == '\t' {
                break;
            }
            col += 1;
        }
        if col == start {
            None
        } else {
            Some(line[start..col].iter().collect())
        }
    }

    pub(crate) fn read_word(&mut self) -> Option<String> {
        let word = self.peek_word()?;
        self.skip_spaces();
        self.col += word.chars().count();
        Some(word)
    }

    pub(crate) fn expect_word(&mut self, want: &str) -> Result<(), ParseError> {
        self.skip_spaces();
        let at = self.col;
        match self.read_word() {
            Some(found) if found == want => Ok(()),
            Some(found) => Err(self.error_at(
                self.line + 1,
                at + 1,
                format!("expected `{want}`, found `{found}`"),
            )),
            None => Err(self.error_at(self.line + 1, at + 1, format!("expected `{want}`"))),
        }
    }

    pub(crate) fn read_number(&mut self) -> Result<usize, ParseError> {
        self.skip_spaces();
        let start = self.col;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.col += 1;
        }
        if self.col == start {
            return Err(self.error("expected a number"));
        }
        let text: String = self.lines[self.line][start..self.col].iter().collect();
        text.parse().map_err(|_| {
            self.error_at(
                self.line + 1,
                start + 1,
                format!("`{text}` is not a usable number"),
            )
        })
    }

    /// A `'…'` or `"…"` literal. The only escapes are `\'`, `\"`, `\\`, `\n`
    /// and `\t`; every other backslash stands for itself, so a Windows path or
    /// a regex-looking literal survives untouched.
    pub(crate) fn read_quoted(&mut self) -> Result<String, ParseError> {
        self.skip_spaces();
        let open_line = self.line + 1;
        let open_col = self.col + 1;
        let quote = match self.peek() {
            Some(c @ ('\'' | '"')) => c,
            _ => return Err(self.error("expected a quoted string")),
        };
        self.col += 1;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => {
                    return Err(self.error_at(open_line, open_col, "unterminated string literal"));
                }
                Some(c) if c == quote => {
                    self.col += 1;
                    return Ok(out);
                }
                Some('\\') => {
                    self.col += 1;
                    match self.peek() {
                        Some('n') => out.push('\n'),
                        Some('t') => out.push('\t'),
                        Some('\\') => out.push('\\'),
                        Some('\'') => out.push('\''),
                        Some('"') => out.push('"'),
                        Some(other) => {
                            out.push('\\');
                            out.push(other);
                        }
                        None => {
                            return Err(self.error_at(
                                open_line,
                                open_col,
                                "unterminated string literal",
                            ));
                        }
                    }
                    self.col += 1;
                }
                Some(c) => {
                    out.push(c);
                    self.col += 1;
                }
            }
        }
    }

    /// A `/…/` literal and its flags. `\/` is a literal slash; every other
    /// backslash reaches the regex engine as written.
    pub(crate) fn read_regex(&mut self) -> Result<(String, String), ParseError> {
        self.skip_spaces();
        let open_line = self.line + 1;
        let open_col = self.col + 1;
        if self.peek() != Some('/') {
            return Err(self.error("expected a /regex/"));
        }
        self.col += 1;
        let mut pattern = String::new();
        loop {
            match self.peek() {
                None => return Err(self.error_at(open_line, open_col, "unterminated regex")),
                Some('/') => {
                    self.col += 1;
                    break;
                }
                Some('\\') => {
                    self.col += 1;
                    match self.peek() {
                        Some('/') => pattern.push('/'),
                        Some(other) => {
                            pattern.push('\\');
                            pattern.push(other);
                        }
                        None => {
                            return Err(self.error_at(open_line, open_col, "unterminated regex"));
                        }
                    }
                    self.col += 1;
                }
                Some(c) => {
                    pattern.push(c);
                    self.col += 1;
                }
            }
        }
        let mut flags = String::new();
        while let Some(c) = self.peek() {
            match c {
                'i' | 's' => {
                    flags.push(c);
                    self.col += 1;
                }
                c if c.is_ascii_alphanumeric() => {
                    return Err(self.error(format!(
                        "unknown regex flag `{c}` — only `i` and `s` are understood"
                    )));
                }
                _ => break,
            }
        }
        Ok((pattern, flags))
    }

    /// A `[K]` match qualifier: `[3]` is the third match, `[-1]` the last.
    pub(crate) fn read_qualifier(&mut self) -> Result<Option<i64>, ParseError> {
        if self.peek() != Some('[') {
            return Ok(None);
        }
        self.col += 1;
        let negative = if self.peek() == Some('-') {
            self.col += 1;
            true
        } else {
            false
        };
        let at = self.col;
        let n = self.read_number()? as i64;
        if n == 0 {
            return Err(self.error_at(
                self.line + 1,
                at + 1,
                "`[0]` is not a match — matches count from 1, and `[-1]` is the last",
            ));
        }
        if self.peek() != Some(']') {
            return Err(self.error("expected `]` closing the match qualifier"));
        }
        self.col += 1;
        Ok(Some(if negative { -n } else { n }))
    }

    /// The lines between a `<<` the caller has just consumed and its `>>`,
    /// each dedented by `indent` — the indentation of the op line that opened
    /// the body. What remains is verbatim, blank lines included, so relative
    /// indentation inside the body survives.
    ///
    /// Leaves the scanner on the `>>` line, just past it, so the caller
    /// finishes the op line the same way it would for a body-less op.
    pub(crate) fn read_body(&mut self, indent: usize) -> Result<Vec<String>, ParseError> {
        let open_line = self.line + 1;
        let open_col = self.col + 1;
        self.skip_spaces();
        if self.peek() == Some('>') && self.peek_at(1) == Some('>') {
            self.col += 2;
            return Ok(Vec::new());
        }
        if !self.at_line_end() {
            return Err(self.error("a body starts on the line after `<<`"));
        }
        self.advance_line();
        let mut body = Vec::new();
        loop {
            if self.finished() {
                return Err(self.error_at(open_line, open_col, "unterminated body — no `>>`"));
            }
            let line = &self.lines[self.line];
            let leading = line.iter().take_while(|c| **c == ' ' || **c == '\t').count();
            let rest: String = line[leading..].iter().collect();
            if rest.trim_end() == ">>" {
                self.col = leading + 2;
                return Ok(body);
            }
            body.push(dedent(line, indent));
            self.advance_line();
        }
    }
}

/// Strip at most `indent` leading whitespace characters. A body line indented
/// less than its op is not an error — it simply loses what it has.
fn dedent(line: &[char], indent: usize) -> String {
    let mut i = 0;
    while i < indent && matches!(line.get(i), Some(' ' | '\t')) {
        i += 1;
    }
    line[i..].iter().collect()
}
