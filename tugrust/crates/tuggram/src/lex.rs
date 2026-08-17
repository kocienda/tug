//! The shell-aware tokenizer and segmenter.
//!
//! This is not a shell and does not try to be one. It recognizes exactly the
//! surface a typed one-liner uses — quoting, word splitting, the four segment
//! separators, redirections, environment-assignment prefixes — and refuses
//! everything else by returning `None`.
//!
//! Refusing is the whole point. A construct this lexer cannot confidently
//! segment must never be read as evidence that the line is prose: the grader
//! turns a `None` into the `Unknown` band, which spends the model exactly as the
//! pre-grader stack did. Only a *successful* lex can lead to a `No`.

/// One simple-command segment of a line: the tokens between separators, with
/// quotes resolved and redirections removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    /// Tokens in order, including any leading `NAME=value` assignments.
    pub tokens: Vec<String>,
}

impl Segment {
    /// The command word: the first token that is not a `NAME=value` assignment.
    /// `None` for a segment that is nothing but assignments (`FOO=1`), which is
    /// a legal shell statement with no command to resolve.
    pub fn head(&self) -> Option<&str> {
        self.tokens
            .iter()
            .find(|t| !is_env_assign(t))
            .map(|t| t.as_str())
    }

    /// The tokens after the head, in order.
    pub fn args(&self) -> &[String] {
        match self.tokens.iter().position(|t| !is_env_assign(t)) {
            Some(i) => &self.tokens[i + 1..],
            None => &[],
        }
    }
}

/// Whether a token is a leading environment assignment (`TUG_X=1`). Matches the
/// deck's `ENV_ASSIGN` rule in `shell-line-classifier.ts` so both sides skip the
/// same prefix to find the same command word.
fn is_env_assign(token: &str) -> bool {
    let Some(eq) = token.find('=') else {
        return false;
    };
    if eq == 0 {
        return false;
    }
    let name = &token[..eq];
    let mut chars = name.chars();
    let first = chars.next().expect("eq > 0");
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Quote state while scanning.
#[derive(PartialEq)]
enum Quote {
    None,
    Single,
    Double,
}

/// Split a line into simple-command segments, or `None` if it holds a construct
/// this lexer will not claim to understand: an unbalanced quote, a trailing
/// backslash, a heredoc (`<<`), a command substitution (`` ` `` or `$(`), or a
/// process substitution (`<(`, `>(`).
pub fn lex(line: &str) -> Option<Vec<Segment>> {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut lx = Lexer::default();
    let mut quote = Quote::None;
    let mut i = 0;

    while i < n {
        let c = chars[i];
        match quote {
            Quote::Single => {
                if c == '\'' {
                    quote = Quote::None;
                } else {
                    lx.token.push(c);
                }
                i += 1;
            }
            Quote::Double => {
                match c {
                    '"' => quote = Quote::None,
                    // Command substitution inside a double-quoted string is
                    // still a substitution.
                    '`' => return None,
                    '$' if chars.get(i + 1) == Some(&'(') => return None,
                    '\\' => {
                        let next = *chars.get(i + 1)?;
                        // A continuation splices inside double quotes too, and
                        // leaves nothing behind in the string.
                        if next == '\n' {
                            i += 2;
                            continue;
                        }
                        // Only these four are escapes inside double quotes;
                        // any other backslash is a literal backslash.
                        if matches!(next, '"' | '\\' | '$' | '`') {
                            lx.token.push(next);
                            i += 1;
                        } else {
                            lx.token.push('\\');
                        }
                    }
                    _ => lx.token.push(c),
                }
                i += 1;
            }
            Quote::None => match c {
                '\'' => {
                    quote = Quote::Single;
                    lx.open_quoted();
                    i += 1;
                }
                '"' => {
                    quote = Quote::Double;
                    lx.open_quoted();
                    i += 1;
                }
                '\\' => {
                    // A backslash at the very end is a continuation waiting on
                    // input that never arrived: the line is incomplete, so it
                    // is refused rather than graded.
                    let next = *chars.get(i + 1)?;
                    // Backslash-newline is a line continuation. It joins the
                    // two lines into one command word-for-word and contributes
                    // no character of its own — it does not even open a token,
                    // so `a \<newline> b` is two tokens, not three.
                    if next == '\n' {
                        i += 2;
                        continue;
                    }
                    lx.push(next);
                    i += 2;
                }
                '`' => return None,
                '$' if chars.get(i + 1) == Some(&'(') => return None,
                ' ' | '\t' => {
                    lx.end_token();
                    i += 1;
                }
                '|' => {
                    lx.end_segment();
                    i += if chars.get(i + 1) == Some(&'|') { 2 } else { 1 };
                }
                // A newline that survived continuation-splicing separates two
                // statements, exactly as `;` does. Every segment it opens has
                // to resolve on its own for the line to grade at all.
                ';' | '\n' => {
                    lx.end_segment();
                    i += 1;
                }
                '&' if chars.get(i + 1) == Some(&'&') => {
                    lx.end_segment();
                    i += 2;
                }
                // `&>file` is a redirection; a lone `&` backgrounds the command
                // and ends it, just as `;` does.
                '&' if chars.get(i + 1) != Some(&'>') => {
                    lx.end_segment();
                    i += 1;
                }
                '&' | '<' | '>' => {
                    i += lx.consume_redirect(&chars, i)?;
                }
                _ => {
                    lx.push(c);
                    i += 1;
                }
            },
        }
    }

    if quote != Quote::None {
        return None;
    }
    lx.end_segment();
    Some(lx.segments)
}

/// Scanner state: the segments closed so far, the tokens of the segment being
/// read, and the word being accumulated.
#[derive(Default)]
struct Lexer {
    segments: Vec<Segment>,
    tokens: Vec<String>,
    token: String,
    token_open: bool,
    token_quoted: bool,
    /// Set by a redirection operator so the operator's target word is read and
    /// thrown away rather than mistaken for an argument.
    drop_next: bool,
}

impl Lexer {
    fn push(&mut self, c: char) {
        self.token.push(c);
        self.token_open = true;
    }

    /// Open a token at a quote mark. `''` is an empty but real argument, so the
    /// token exists even before any character lands in it.
    fn open_quoted(&mut self) {
        self.token_open = true;
        self.token_quoted = true;
    }

    /// Close the in-progress token, honoring a pending redirection target.
    fn end_token(&mut self) {
        if !self.token_open {
            return;
        }
        if self.drop_next {
            self.drop_next = false;
            self.token.clear();
        } else {
            self.tokens.push(std::mem::take(&mut self.token));
        }
        self.token_open = false;
        self.token_quoted = false;
    }

    /// Close the in-progress segment. An empty segment (a trailing `|`, a
    /// leading `;`) contributes nothing rather than failing the lex.
    fn end_segment(&mut self) {
        self.end_token();
        self.drop_next = false;
        if !self.tokens.is_empty() {
            self.segments.push(Segment {
                tokens: std::mem::take(&mut self.tokens),
            });
        }
    }

    /// Consume a redirection operator starting at `start`, returning how many
    /// characters it spans and arming the drop of its target word. Discards a
    /// bare file-descriptor number already accumulated (the `2` of `2>&1`), and
    /// refuses a heredoc or a process substitution by returning `None`.
    fn consume_redirect(&mut self, chars: &[char], start: usize) -> Option<usize> {
        if chars[start] == '<' && chars.get(start + 1) == Some(&'<') {
            return None; // heredoc
        }
        if chars.get(start + 1) == Some(&'(') {
            return None; // process substitution
        }
        // An unquoted all-digit token immediately before the operator is the fd
        // it redirects, not an argument.
        if self.token_open
            && !self.token_quoted
            && !self.token.is_empty()
            && self.token.chars().all(|c| c.is_ascii_digit())
        {
            self.token.clear();
            self.token_open = false;
        }
        self.end_token();
        self.drop_next = true;
        let mut len = 0;
        while matches!(chars.get(start + len), Some('<') | Some('>') | Some('&')) {
            len += 1;
        }
        Some(len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heads(line: &str) -> Option<Vec<String>> {
        Some(
            lex(line)?
                .iter()
                .map(|s| s.head().unwrap_or("").to_string())
                .collect(),
        )
    }

    fn tokens(line: &str) -> Vec<Vec<String>> {
        lex(line)
            .expect("lexable")
            .into_iter()
            .map(|s| s.tokens)
            .collect()
    }

    #[test]
    fn splits_a_plain_command_into_words() {
        assert_eq!(tokens("git status"), vec![vec!["git", "status"]]);
    }

    #[test]
    fn collapses_runs_of_whitespace() {
        assert_eq!(tokens("  git   status \t"), vec![vec!["git", "status"]]);
    }

    #[test]
    fn resolves_quotes_into_one_token() {
        assert_eq!(
            tokens("git commit -m \"fix the crash\""),
            vec![vec!["git", "commit", "-m", "fix the crash"]]
        );
        assert_eq!(tokens("rg 'a b' src"), vec![vec!["rg", "a b", "src"]]);
    }

    #[test]
    fn honors_backslash_escapes() {
        assert_eq!(tokens("ls a\\ b"), vec![vec!["ls", "a b"]]);
        assert_eq!(tokens("echo \"a\\\"b\""), vec![vec!["echo", "a\"b"]]);
    }

    #[test]
    fn splits_on_every_separator() {
        assert_eq!(
            heads("git status | rg foo"),
            Some(vec!["git".into(), "rg".into()])
        );
        assert_eq!(
            heads("cargo build && cargo test"),
            Some(vec!["cargo".into(), "cargo".into()])
        );
        assert_eq!(
            heads("make || echo failed"),
            Some(vec!["make".into(), "echo".into()])
        );
        assert_eq!(heads("cd /tmp; ls"), Some(vec!["cd".into(), "ls".into()]));
        assert_eq!(heads("sleep 5 &"), Some(vec!["sleep".into()]));
    }

    #[test]
    fn a_separator_inside_quotes_is_literal() {
        assert_eq!(tokens("rg 'a|b'"), vec![vec!["rg", "a|b"]]);
        assert_eq!(heads("rg 'a|b'"), Some(vec!["rg".into()]));
    }

    #[test]
    fn env_assignments_are_skipped_to_find_the_head() {
        let segs = lex("FOO=1 BAR=2 make test").expect("lexable");
        assert_eq!(segs[0].head(), Some("make"));
        assert_eq!(segs[0].args(), ["test"]);
    }

    #[test]
    fn a_segment_of_only_assignments_has_no_head() {
        let segs = lex("FOO=1").expect("lexable");
        assert_eq!(segs[0].head(), None);
    }

    #[test]
    fn redirections_and_their_targets_drop_out() {
        assert_eq!(tokens("ls > out.txt"), vec![vec!["ls"]]);
        assert_eq!(tokens("ls >out.txt"), vec![vec!["ls"]]);
        assert_eq!(tokens("cargo build 2>&1"), vec![vec!["cargo", "build"]]);
        assert_eq!(tokens("make &> log"), vec![vec!["make"]]);
        assert_eq!(tokens("sort < in.txt -u"), vec![vec!["sort", "-u"]]);
    }

    #[test]
    fn refuses_the_constructs_it_cannot_claim_to_understand() {
        assert_eq!(lex("echo 'unbalanced"), None);
        assert_eq!(lex("echo \"unbalanced"), None);
        assert_eq!(lex("echo trailing \\"), None);
        assert_eq!(lex("cat <<EOF"), None);
        assert_eq!(lex("echo `date`"), None);
        assert_eq!(lex("echo $(date)"), None);
        assert_eq!(lex("echo \"$(date)\""), None);
        assert_eq!(lex("diff <(a) <(b)"), None);
    }

    #[test]
    fn splices_a_backslash_continuation_into_one_command() {
        assert_eq!(
            tokens("git commit -m \"subject\" \\\n  a.ts \\\n  b.ts"),
            vec![vec!["git", "commit", "-m", "subject", "a.ts", "b.ts"]]
        );
        // The continuation contributes no character and opens no token, so a
        // spliced line tokenizes identically to the joined one.
        assert_eq!(tokens("ls \\\n-la"), tokens("ls -la"));
        // Inside double quotes it splices too, leaving nothing in the string.
        assert_eq!(tokens("echo \"a\\\nb\""), vec![vec!["echo", "ab"]]);
    }

    #[test]
    fn a_surviving_newline_separates_statements() {
        assert_eq!(heads("cd /tmp\nls"), Some(vec!["cd".into(), "ls".into()]));
        // A newline inside quotes is a literal newline in the word, not a
        // separator.
        assert_eq!(tokens("echo 'a\nb'"), vec![vec!["echo", "a\nb"]]);
    }

    #[test]
    fn an_empty_line_lexes_to_no_segments() {
        assert_eq!(lex(""), Some(vec![]));
        assert_eq!(lex("   "), Some(vec![]));
        assert_eq!(lex("| |"), Some(vec![]));
    }
}
