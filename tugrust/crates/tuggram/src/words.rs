//! The session shell's word table: the names it resolves ahead of `$PATH`, and
//! what the readable ones expand to.
//!
//! # Why the shell is asked at all
//!
//! The thing that will run a routed line is `$SHELL -il` with the user's rc
//! files in force, and it resolves a command word in its own order — alias,
//! function, builtin, then PATH. A grader that only knows PATH is wrong in both
//! directions: it cannot see `gs` (a function), cannot see `setopt` (a builtin),
//! and reads `gs` as ghostscript when the shell would never run ghostscript.
//! So membership is answered by interrogating a shell, never by parsing rc
//! files — rc files have conditionals, plugin managers, and machine-specific
//! branches, and the only ground truth for what a word means in this session is
//! the shell that will execute it.
//!
//! # What an expansion is worth
//!
//! An expansion never becomes the graded line. The subject of grading is always
//! what the user typed; a readable expansion contributes only the *grammar to
//! consult* and the *position within it*, so `gs -sb` can grade as git's
//! grammar entered at `status` carrying `-sb`. The shell does its own expanding
//! at run time, with the table live at that instant.
//!
//! # Conservative by construction
//!
//! Every band derived from an expansion depends on this module reading a body
//! correctly, so anything short of a single simple command — multiple
//! statements, control flow, substitution, assignment, redirection — is
//! [`ShellWord::Opaque`]: membership yes, grammar no, which grades `Unknown` and
//! spends the model exactly as the pre-grader stack did. When in doubt, opaque.
//!
//! # Known limitation
//!
//! zsh global (`alias -g`) and suffix (`alias -s`) aliases substitute anywhere in
//! a line, not just at the command word, and this head-oriented model does not
//! contemplate them. They are not collected.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use crate::lex;

/// How deep a chain of aliases and functions is followed before giving up.
/// `alias g=git; alias gs='g status'` is a real shape; eight links of it is not,
/// and a cap is also the cheap half of cycle safety.
const MAX_CHAIN_DEPTH: usize = 8;

/// What one shell word expands to, as read from its printed definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellWord {
    /// Expands to one simple command. `head` is the program that will run,
    /// `prefix` the literal arguments the expansion already supplies, and
    /// `takes_args` whether the typed arguments survive the expansion — a body
    /// referencing `$*`/`$@`/`$N`, or any alias at all (alias expansion appends
    /// the remaining typed tokens).
    Simple {
        head: String,
        prefix: Vec<String>,
        takes_args: bool,
    },
    /// It resolves, but its shape cannot be read. Membership yes, grammar no.
    Opaque,
}

/// What kind of thing the shell said a member is.
///
/// The kind decides what an unreadable member means. An alias or function whose
/// body has not been read is opaque — a user function named `git` must never be
/// graded against real git's grammar. A builtin has no body to read at all and
/// keeps the catalog path, exactly as the static builtin list gives it today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WordKind {
    Alias,
    Function,
    Builtin,
}

impl WordKind {
    /// Shell resolution precedence, lower first: alias beats function beats
    /// builtin.
    fn rank(self) -> u8 {
        match self {
            WordKind::Alias => 0,
            WordKind::Function => 1,
            WordKind::Builtin => 2,
        }
    }
}

/// One member of the table: what kind it is, and its parsed expansion once its
/// body has been read. Functions arrive body-unread — bodies are fetched only
/// for words the user actually types.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Member {
    kind: WordKind,
    word: Option<ShellWord>,
}

/// A chain of aliases and functions resolved down to the program that runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWord {
    /// The program the expansion ultimately names.
    pub head: String,
    /// The literal arguments the expansion supplies ahead of anything typed.
    pub prefix: Vec<String>,
    /// Whether the typed arguments survive the expansion.
    pub takes_args: bool,
}

/// What the table says about a name it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WordResolution {
    /// It expands to a single simple command whose grammar can be consulted.
    Expands(ResolvedWord),
    /// It resolves but its grammar cannot be read.
    Opaque,
    /// It is a shell builtin: it resolves, and the catalog may know it.
    Builtin,
}

/// The session shell's word table: every name the shell resolves ahead of PATH,
/// with parsed expansions for the words whose bodies have been read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellWords {
    words: BTreeMap<String, Member>,
}

impl ShellWords {
    /// The degraded table: everything falls through to PATH and the static
    /// builtin list, exactly as before this module existed.
    pub fn empty() -> Self {
        ShellWords::default()
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    pub fn len(&self) -> usize {
        self.words.len()
    }

    /// Record a member whose body has not been read.
    pub fn insert(&mut self, name: String, kind: WordKind) {
        if self.outranks_existing(&name, kind) {
            self.words.insert(name, Member { kind, word: None });
        }
    }

    /// Record a member together with its parsed expansion.
    pub fn insert_parsed(&mut self, name: String, kind: WordKind, word: ShellWord) {
        if self.outranks_existing(&name, kind) {
            self.words.insert(
                name,
                Member {
                    kind,
                    word: Some(word),
                },
            );
        }
    }

    /// Whether a write of this kind may land: a strictly-higher-precedence kind
    /// replaces what is there, an equal kind updates it (this is how a fetched
    /// body reaches a member recorded earlier), and a lower-precedence kind is
    /// dropped so an alias is never overwritten by the function it shadows.
    fn outranks_existing(&self, name: &str, kind: WordKind) -> bool {
        match self.words.get(name) {
            None => true,
            Some(existing) => kind.rank() <= existing.kind.rank(),
        }
    }

    pub fn kind(&self, name: &str) -> Option<WordKind> {
        self.words.get(name).map(|m| m.kind)
    }

    /// Whether this name is an alias or function whose body still has to be
    /// fetched before its grammar can be reached.
    pub fn needs_body(&self, name: &str) -> bool {
        match self.words.get(name) {
            Some(m) => m.word.is_none() && m.kind != WordKind::Builtin,
            None => false,
        }
    }

    /// Every member name, sorted — what crosses the wire for the deck's
    /// membership test, which needs names and nothing else.
    pub fn member_names(&self) -> Vec<&str> {
        self.words.keys().map(|k| k.as_str()).collect()
    }

    /// Resolve a name through the table, following expansions transitively.
    ///
    /// `alias g=git; alias gs='g status'` has to reach `git` or the grade
    /// consults the (absent) catalog entry for `g` and learns nothing. Prefixes
    /// concatenate inner-first — `gs` resolves to `git status` — and
    /// `takes_args` comes from the outermost entry, which is the one the typed
    /// arguments actually meet. A cycle, an over-deep chain, or an unreadable
    /// link anywhere along the way is [`WordResolution::Opaque`]: the safe band.
    ///
    /// `None` means the shell has no such word, which says nothing at all — PATH
    /// is asked next.
    pub fn resolve(&self, name: &str) -> Option<WordResolution> {
        let first = self.words.get(name)?;
        if first.kind == WordKind::Builtin {
            return Some(WordResolution::Builtin);
        }
        let Some(ShellWord::Simple {
            head,
            prefix,
            takes_args,
        }) = &first.word
        else {
            return Some(WordResolution::Opaque);
        };

        let takes_args = *takes_args;
        let mut head = head.clone();
        let mut prefix = prefix.clone();
        let mut seen: Vec<String> = vec![name.to_string()];

        for _ in 1..MAX_CHAIN_DEPTH {
            if seen.contains(&head) {
                return Some(WordResolution::Opaque);
            }
            // A head that is not a member of the table, or is a builtin, is the
            // program that runs: the walk is done.
            let Some(link) = self.words.get(&head) else {
                return Some(WordResolution::Expands(ResolvedWord {
                    head,
                    prefix,
                    takes_args,
                }));
            };
            if link.kind == WordKind::Builtin {
                return Some(WordResolution::Expands(ResolvedWord {
                    head,
                    prefix,
                    takes_args,
                }));
            }
            let Some(ShellWord::Simple {
                head: inner_head,
                prefix: inner_prefix,
                ..
            }) = &link.word
            else {
                return Some(WordResolution::Opaque);
            };
            let mut merged = inner_prefix.clone();
            merged.extend(prefix);
            prefix = merged;
            seen.push(std::mem::replace(&mut head, inner_head.clone()));
        }
        Some(WordResolution::Opaque)
    }
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/// The parameter tokens whose presence means the typed arguments survive the
/// expansion, and whose absence from the graded token stream is the point: a
/// literal `$*` handed to the grammar reads as an unrecognized positional and
/// would knock a real command down a band.
fn is_parameter(token: &str) -> bool {
    matches!(token, "$*" | "$@")
        || (token.len() == 2
            && token.starts_with('$')
            && token.as_bytes()[1].is_ascii_digit()
            && token.as_bytes()[1] != b'0')
}

/// Parse an alias's value — the right-hand side of `alias gs='git status'`.
///
/// Two differences from a function body: `takes_args` is always true, because
/// alias expansion appends whatever else was typed; and *any* `$` is opaque,
/// because an alias has no positional parameters, so a `$` is a live expansion
/// whose value the grade cannot know.
pub fn parse_alias_value(value: &str) -> ShellWord {
    if value.contains('$') {
        return ShellWord::Opaque;
    }
    match parse_statement(value) {
        Some((head, args, _)) => ShellWord::Simple {
            head,
            prefix: args,
            takes_args: true,
        },
        None => ShellWord::Opaque,
    }
}

/// Parse a function's *printed definition* — the whole of what `functions
/// <name>` (zsh) or `declare -f <name>` (bash) emitted.
///
/// The two shells print differently and the difference is a correctness trap:
/// zsh prints one statement across three lines, bash pretty-prints the same
/// statement across four and prints a multi-statement body one statement per
/// line *without* separators. A raw newline scan would therefore call every
/// bash function opaque. So the definition is normalized to its statements
/// first — header dropped, outer braces stripped, lines trimmed, blanks
/// dropped, one trailing `;` removed — and only then does "more than one
/// statement" mean anything.
pub fn parse_function_body(printed: &str) -> ShellWord {
    let Some(statement) = single_statement(printed) else {
        return ShellWord::Opaque;
    };
    match parse_statement(&statement) {
        Some((head, args, takes_args)) => ShellWord::Simple {
            head,
            prefix: args,
            takes_args,
        },
        None => ShellWord::Opaque,
    }
}

/// Reduce a printed definition to its single statement, or `None` if it holds
/// anything else.
fn single_statement(printed: &str) -> Option<String> {
    let open = printed.find('{')?;
    let close = printed.rfind('}')?;
    if close < open {
        return None;
    }
    // What precedes the brace must look like a function header (`name ()`), or
    // this is not a printed definition at all.
    if !printed[..open].trim_end().ends_with(')') {
        return None;
    }
    let mut statements = printed[open + 1..close]
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.strip_suffix(';').unwrap_or(l).trim_end());
    let first = statements.next()?;
    if statements.next().is_some() {
        return None;
    }
    Some(first.to_string())
}

/// Read one statement into a head, its literal arguments, and whether it
/// referenced the typed arguments — or `None` for anything that is not a single
/// simple command whose every token is a literal.
///
/// The order here is load-bearing. Parameter extraction runs **after** lexing,
/// on the token stream, because quote resolution has already collapsed `"$@"`
/// to the token `$@` while leaving a parameter inside a larger quoted span
/// (`echo "a $* b"`) embedded in its containing token — where the `$` rejection
/// below catches it. Extracting on a whitespace split of the raw statement
/// would strip that `$*` and misread the body as a simple command.
fn parse_statement(statement: &str) -> Option<(String, Vec<String>, bool)> {
    // `;` ends a statement; `<` and `>` redirect. `|`, `&&`, `||` and `&` open a
    // second segment and are caught by the segment count below; backticks,
    // `$(`, heredocs and process substitutions are refused by `lex` itself.
    if statement.contains(';')
        || statement.contains('<')
        || statement.contains('>')
        || statement.contains('\n')
    {
        return None;
    }

    let segments = lex::lex(statement)?;
    if segments.len() != 1 {
        return None;
    }
    let segment = &segments[0];
    let head = segment.head()?;
    // A leading `FOO=1` assignment prefix makes this more than a bare command.
    if segment.tokens.first().map(|t| t.as_str()) != Some(head) {
        return None;
    }
    if head.contains('$') {
        return None;
    }
    let head = head.to_string();

    let mut takes_args = false;
    let mut prefix = Vec::new();
    for arg in segment.args() {
        if is_parameter(arg) {
            takes_args = true;
            continue;
        }
        if arg.contains('$') {
            return None;
        }
        prefix.push(arg.clone());
    }
    Some((head, prefix, takes_args))
}

// ---------------------------------------------------------------------------
// Shell interrogation
// ---------------------------------------------------------------------------

/// Wall-clock cap on one interrogation. The work itself is a `printf` loop over
/// shell variables — microseconds — so the whole cost is the interactive-login
/// spawn, and a stall past this means the rc profile wedged. Generous because
/// the caller is never on a latency path: the dump runs at card mount and a body
/// fetch runs behind the typing debounce.
const INTERROGATION_TIMEOUT: Duration = Duration::from_secs(10);

/// Most bytes one interrogation may print. A dump is a few hundred bytes per
/// alias and a name per function, so a real table is far below this; output
/// past it is a profile printing something else, and is refused rather than
/// parsed as a truncated table.
const INTERROGATION_MAX_STDOUT: usize = 8 << 20;

/// Which shell the table is being read from. `$SHELL` is the *login* shell —
/// the one that defined the user's habits — so a `$SHELL` that is neither bash
/// nor zsh yields no table at all rather than a guess: an empty table is today's
/// behavior, while a wrong table would be a wrong answer.
#[derive(Clone, Copy)]
enum Interrogated {
    Zsh,
    Bash,
}

/// The dump script, per shell.
///
/// Both iterate shell *variables* rather than reading `alias`'s display output,
/// whose quoting has real escaping edge cases. Records are NUL-delimited with
/// tab-separated fields — `kind \t name [\t value]` — because neither separator
/// can occur in a name.
impl Interrogated {
    fn from_env() -> Option<(String, Interrogated)> {
        let shell = std::env::var("SHELL").ok()?;
        match shell.rsplit('/').next()? {
            "zsh" => Some((shell, Interrogated::Zsh)),
            "bash" => Some((shell, Interrogated::Bash)),
            _ => None,
        }
    }

    fn dump_script(self) -> &'static str {
        match self {
            Interrogated::Zsh => concat!(
                r#"for k v in "${(@kv)aliases}"; do printf 'a\t%s\t%s\0' "$k" "$v"; done; "#,
                r#"for k in ${(k)functions}; do printf 'f\t%s\0' "$k"; done; "#,
                r#"for k in ${(k)builtins}; do printf 'b\t%s\0' "$k"; done"#,
            ),
            Interrogated::Bash => concat!(
                r#"for k in "${!BASH_ALIASES[@]}"; do printf 'a\t%s\t%s\0' "$k" "${BASH_ALIASES[$k]}"; done; "#,
                r#"compgen -A function | while IFS= read -r k; do printf 'f\t%s\0' "$k"; done; "#,
                r#"compgen -b | while IFS= read -r k; do printf 'b\t%s\0' "$k"; done"#,
            ),
        }
    }

    fn print_body_command(self, name: &str) -> String {
        match self {
            Interrogated::Zsh => format!("functions {name}"),
            Interrogated::Bash => format!("declare -f {name}"),
        }
    }
}

/// Read the session shell's word table: one throwaway `$SHELL -ilc` from `cwd`.
///
/// `-i` is what makes the aliases exist at all, and `cwd` matters because rc
/// files branch on it (direnv and friends). `None` — a non-bash/zsh `$SHELL`, a
/// spawn failure, a timeout, a non-zero exit — means the caller uses the empty
/// table, which is exactly today's behavior.
pub fn dump_shell_words(cwd: Option<&Path>) -> Option<ShellWords> {
    let (shell, kind) = Interrogated::from_env()?;
    let stdout = run_interrogation(&shell, kind.dump_script(), cwd)?;
    Some(parse_dump(&stdout))
}

/// Print one function's definition. Kept separate from the dump because bodies
/// are worth fetching only for a word the user actually typed: the whole name
/// surface costs one spawn, and so does every single body.
///
/// The name is validated against the shell-name alphabet before it is
/// interpolated into a script. A name outside that alphabet simply stays an
/// unread member, which grades opaque — coverage lost, nothing else.
pub fn fetch_function_body(name: &str) -> Option<String> {
    if !is_safe_word_name(name) {
        return None;
    }
    let (shell, kind) = Interrogated::from_env()?;
    let stdout = run_interrogation(&shell, &kind.print_body_command(name), None)?;
    String::from_utf8(stdout)
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Read whatever bodies `head` needs before it can resolve, following the chain
/// it expands through and memoizing each result on the table.
///
/// One shell spawn per unread link, which is why only words a line actually
/// names are ever fetched. A fetch that fails memoizes [`ShellWord::Opaque`]
/// rather than nothing: the answer is the same either way, and memoizing it
/// stops a broken word costing a spawn on every keystroke.
///
/// Blocking. Callers on an async runtime run it on a blocking pool.
pub fn ensure_body_chain(words: &mut ShellWords, head: &str) {
    let mut name = head.to_string();
    for _ in 0..MAX_CHAIN_DEPTH {
        if !words.needs_body(&name) {
            return;
        }
        let Some(kind) = words.kind(&name) else {
            return;
        };
        let word = match fetch_function_body(&name) {
            Some(printed) => parse_function_body(&printed),
            None => ShellWord::Opaque,
        };
        let next = match &word {
            ShellWord::Simple { head, .. } => Some(head.clone()),
            ShellWord::Opaque => None,
        };
        words.insert_parsed(name.clone(), kind, word);
        match next {
            Some(head) => name = head,
            None => return,
        }
    }
}

/// Whether a name can be interpolated into an interrogation script. Covers every
/// name a human types and nothing that could carry shell syntax.
fn is_safe_word_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '@' | '+' | '-'))
}

/// Run one interrogation script under a hard timeout, returning stdout.
///
/// **stdout only.** `bash -i` writes `bash: no job control in this shell` to
/// stderr; folding the two streams together would parse that line into the
/// table. Stdin is closed so an interactive shell cannot sit waiting on it.
///
/// `setsid` before exec puts the shell in a new session with no controlling
/// TTY. An interactive shell that keeps the caller's controlling terminal does
/// job control on it — `tcsetpgrp` hands the terminal's foreground process
/// group to itself — and every write the caller makes while that lasts raises
/// SIGTTOU. Run from a terminal, that stops the caller: `zsh: suspended (tty
/// output)`.
///
/// The new session is also what makes a timeout clean: the shell leads its own
/// process group, so one `kill(-pgid)` reaches the shell and anything its
/// profile started, and the shell is then reaped. A wedged profile costs one
/// timeout, never a shell left running for the life of the process.
fn run_interrogation(shell: &str, script: &str, cwd: Option<&Path>) -> Option<Vec<u8>> {
    run_interrogation_within(shell, script, cwd, INTERROGATION_TIMEOUT)
}

/// [`run_interrogation`] with the deadline as a parameter, so a test can wait
/// on one shorter than ten seconds.
fn run_interrogation_within(
    shell: &str,
    script: &str,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Option<Vec<u8>> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let deadline = Instant::now() + timeout;
    let mut child = cmd.spawn().ok()?;
    // Read without blocking, so one loop can watch both the pipe and the
    // deadline: a dump can outgrow the pipe's buffer, and a shell blocked on a
    // full pipe never exits.
    let mut pipe = child.stdout.take().filter(|out| {
        let fd = out.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            flags >= 0 && libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) >= 0
        }
    });
    let mut stdout = Vec::new();
    let exited = loop {
        drain(&mut pipe, &mut stdout);
        if stdout.len() > INTERROGATION_MAX_STDOUT {
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        let now = Instant::now();
        if now >= deadline {
            break None;
        }
        // Wake on output, or after a short slice to look at the child again.
        let slice = (deadline - now).min(Duration::from_millis(20));
        match &pipe {
            Some(out) => {
                let mut fds = libc::pollfd {
                    fd: out.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                unsafe {
                    libc::poll(&mut fds, 1, slice.as_millis() as libc::c_int);
                }
            }
            None => std::thread::sleep(slice),
        }
    };
    match exited {
        Some(status) => {
            // What the shell wrote between the last read and its exit.
            drain(&mut pipe, &mut stdout);
            (status.success() && stdout.len() <= INTERROGATION_MAX_STDOUT).then_some(stdout)
        }
        None => {
            // Still unreaped, so the pid cannot have been reused: the group
            // is the shell's own.
            unsafe {
                libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
            }
            let _ = child.wait();
            None
        }
    }
}

/// Read everything a non-blocking pipe has ready into `into`, closing the pipe
/// at end of file.
fn drain(pipe: &mut Option<std::process::ChildStdout>, into: &mut Vec<u8>) {
    use std::io::Read;
    let Some(out) = pipe else {
        return;
    };
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match out.read(&mut chunk) {
            Ok(0) => {
                *pipe = None;
                break;
            }
            Ok(n) => into.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            // A pipe that can no longer be read has nothing more to wait on.
            Err(_) => {
                *pipe = None;
                break;
            }
        }
        if into.len() > INTERROGATION_MAX_STDOUT {
            break;
        }
    }
}

/// Fold a dump's NUL-delimited records into a table.
///
/// Alias values are parsed on the spot — they arrive in hand, so there is no
/// second round trip to pay. Functions and builtins are recorded as members
/// only; a function's body is fetched when a line names it.
fn parse_dump(stdout: &[u8]) -> ShellWords {
    let mut words = ShellWords::empty();
    for record in stdout.split(|b| *b == 0) {
        let Ok(record) = std::str::from_utf8(record) else {
            continue;
        };
        let mut fields = record.split('\t');
        let (Some(kind), Some(name)) = (fields.next(), fields.next()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        match kind {
            "a" => {
                let value = fields.next().unwrap_or_default();
                words.insert_parsed(name.to_string(), WordKind::Alias, parse_alias_value(value));
            }
            // The completion machinery defines about a thousand `_`-prefixed
            // functions on a normal zsh setup, none of them invocable by a
            // person. They are noise on the wire and noise in the membership
            // test the deck runs against every keystroke.
            "f" if !name.starts_with('_') => {
                words.insert(name.to_string(), WordKind::Function);
            }
            "b" => {
                words.insert(name.to_string(), WordKind::Builtin);
            }
            _ => {}
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple(head: &str, prefix: &[&str], takes_args: bool) -> ShellWord {
        ShellWord::Simple {
            head: head.to_string(),
            prefix: prefix.iter().map(|s| s.to_string()).collect(),
            takes_args,
        }
    }

    // -- the seven real bodies, as the two shells actually print them --------

    #[test]
    fn reads_the_real_zsh_bodies() {
        assert_eq!(
            parse_function_body("gs () {\n\tgit status $*\n}\n"),
            simple("git", &["status"], true)
        );
        assert_eq!(
            parse_function_body("pick () {\n\tgit cherry-pick $*\n}\n"),
            simple("git", &["cherry-pick"], true)
        );
        assert_eq!(
            parse_function_body("amend () {\n\tgit commit --amend\n}\n"),
            simple("git", &["commit", "--amend"], false)
        );
        assert_eq!(
            parse_function_body("stuff () {\n\tbbedit /Users/k/Text/how-to-do-stuff.txt\n}\n"),
            simple("bbedit", &["/Users/k/Text/how-to-do-stuff.txt"], false)
        );
        assert_eq!(
            parse_function_body("site () {\n\tssh deploy@192.155.87.51\n}\n"),
            simple("ssh", &["deploy@192.155.87.51"], false)
        );
    }

    #[test]
    fn multi_statement_real_bodies_are_opaque() {
        // `add` is two statements; `pull`/`push` open on an assignment carrying
        // command substitutions.
        assert_eq!(
            parse_function_body("add () {\n\tgit add $*\n\tgit status\n}\n"),
            ShellWord::Opaque
        );
        assert_eq!(
            parse_function_body(
                "pull () {\n\tCMD=\"git pull `git remote show`\" \n\techo $CMD\n\tgit pull `git remote show`\n}\n"
            ),
            ShellWord::Opaque
        );
    }

    #[test]
    fn reads_the_same_bodies_as_bash_prints_them() {
        // bash pretty-prints one statement across four lines...
        assert_eq!(
            parse_function_body("gs () \n{ \n    git status $*\n}\n"),
            simple("git", &["status"], true)
        );
        assert_eq!(
            parse_function_body("amend () \n{ \n    git commit --amend\n}\n"),
            simple("git", &["commit", "--amend"], false)
        );
        // ...and a multi-statement body one per line, with a trailing `;` on
        // every statement but the last.
        assert_eq!(
            parse_function_body("add () \n{ \n    git add $*;\n    git status\n}\n"),
            ShellWord::Opaque
        );
    }

    // -- the opaque construct classes ---------------------------------------

    #[test]
    fn every_construct_short_of_a_simple_command_is_opaque() {
        let opaque = [
            // control flow
            "f () {\n\tif [ -n \"$1\" ]; then git status; fi\n}",
            "f () {\n\tfor x in a b; do echo $x; done\n}",
            "f () {\n\twhile true; do sleep 1; done\n}",
            // separators that open a second segment
            "f () {\n\tgit fetch && git status\n}",
            "f () {\n\tmake || echo failed\n}",
            "f () {\n\tgit status | less\n}",
            // substitution
            "f () {\n\techo `date`\n}",
            "f () {\n\techo $(date)\n}",
            "f () {\n\tdiff <(a) <(b)\n}",
            // assignment
            "f () {\n\tFOO=1 make test\n}",
            "f () {\n\tFOO=1\n}",
            // redirection
            "f () {\n\tls > out.txt\n}",
            "f () {\n\tsort < in.txt\n}",
            // an expansion in the head or an argument
            "f () {\n\t$EDITOR notes.txt\n}",
            "f () {\n\tgit status $BRANCH\n}",
            // nothing to read
            "f () {\n}",
            "f () {\n\n}",
            "not a definition at all",
            "",
        ];
        for printed in opaque {
            assert_eq!(
                parse_function_body(printed),
                ShellWord::Opaque,
                "should be opaque: {printed:?}"
            );
        }
    }

    #[test]
    fn a_parameter_inside_a_quoted_span_is_opaque() {
        // The pin for the parse order: `"a $* b"` lexes to one token carrying a
        // `$`, which is not a parameter reference the grade can honor. Stripping
        // parameters off a whitespace split of the raw statement would leave
        // `echo "a b"` and misread this as a simple command.
        assert_eq!(
            parse_function_body("f () {\n\techo \"a $* b\"\n}"),
            ShellWord::Opaque
        );
    }

    #[test]
    fn a_quoted_parameter_still_counts_as_one() {
        assert_eq!(
            parse_function_body("f () {\n\tgit status \"$@\"\n}"),
            simple("git", &["status"], true)
        );
        assert_eq!(
            parse_function_body("f () {\n\tgit show $1\n}"),
            simple("git", &["show"], true)
        );
    }

    #[test]
    fn quoted_arguments_survive_as_one_literal() {
        assert_eq!(
            parse_function_body("f () {\n\tgit commit -m \"wip on it\"\n}"),
            simple("git", &["commit", "-m", "wip on it"], false)
        );
    }

    // -- alias values --------------------------------------------------------

    #[test]
    fn alias_values_always_take_arguments() {
        assert_eq!(
            parse_alias_value("git status"),
            simple("git", &["status"], true)
        );
        assert_eq!(parse_alias_value("ls -la"), simple("ls", &["-la"], true));
    }

    #[test]
    fn an_alias_value_carrying_an_expansion_is_opaque() {
        assert_eq!(parse_alias_value("cd $HOME"), ShellWord::Opaque);
        assert_eq!(parse_alias_value("echo $(date)"), ShellWord::Opaque);
        assert_eq!(parse_alias_value("cd ~ && ls"), ShellWord::Opaque);
        assert_eq!(parse_alias_value(""), ShellWord::Opaque);
    }

    // -- the table -----------------------------------------------------------

    fn table(entries: &[(&str, WordKind, Option<ShellWord>)]) -> ShellWords {
        let mut words = ShellWords::empty();
        for (name, kind, word) in entries {
            match word {
                Some(w) => words.insert_parsed(name.to_string(), *kind, w.clone()),
                None => words.insert(name.to_string(), *kind),
            }
        }
        words
    }

    #[test]
    fn an_alias_shadows_a_function_of_the_same_name() {
        let words = table(&[
            (
                "gs",
                WordKind::Function,
                Some(simple("ghostscript", &[], false)),
            ),
            (
                "gs",
                WordKind::Alias,
                Some(simple("git", &["status"], true)),
            ),
        ]);
        assert_eq!(words.kind("gs"), Some(WordKind::Alias));
        assert_eq!(
            words.resolve("gs"),
            Some(WordResolution::Expands(ResolvedWord {
                head: "git".into(),
                prefix: vec!["status".into()],
                takes_args: true,
            }))
        );
        // ...in either insertion order.
        let words = table(&[
            (
                "gs",
                WordKind::Alias,
                Some(simple("git", &["status"], true)),
            ),
            (
                "gs",
                WordKind::Function,
                Some(simple("ghostscript", &[], false)),
            ),
        ]);
        assert_eq!(words.kind("gs"), Some(WordKind::Alias));
    }

    #[test]
    fn a_fetched_body_lands_on_the_member_recorded_earlier() {
        let mut words = table(&[("gs", WordKind::Function, None)]);
        assert!(words.needs_body("gs"));
        words.insert_parsed(
            "gs".into(),
            WordKind::Function,
            simple("git", &["status"], true),
        );
        assert!(!words.needs_body("gs"));
        assert!(matches!(
            words.resolve("gs"),
            Some(WordResolution::Expands(_))
        ));
    }

    #[test]
    fn an_unread_or_unreadable_member_resolves_opaque() {
        let words = table(&[
            ("unread", WordKind::Function, None),
            ("unreadable", WordKind::Function, Some(ShellWord::Opaque)),
        ]);
        assert_eq!(words.resolve("unread"), Some(WordResolution::Opaque));
        assert_eq!(words.resolve("unreadable"), Some(WordResolution::Opaque));
        assert!(words.needs_body("unread"));
        assert!(!words.needs_body("unreadable"));
    }

    #[test]
    fn a_builtin_resolves_as_a_builtin_and_never_needs_a_body() {
        let words = table(&[("setopt", WordKind::Builtin, None)]);
        assert_eq!(words.resolve("setopt"), Some(WordResolution::Builtin));
        assert!(!words.needs_body("setopt"));
    }

    #[test]
    fn a_word_the_shell_does_not_hold_resolves_to_nothing() {
        let words = table(&[("gs", WordKind::Function, None)]);
        assert_eq!(words.resolve("ls"), None);
    }

    #[test]
    fn chains_resolve_through_to_the_program_prefix_inner_first() {
        // alias g=git; alias gs='g status'
        let words = table(&[
            ("g", WordKind::Alias, Some(simple("git", &[], true))),
            ("gs", WordKind::Alias, Some(simple("g", &["status"], true))),
        ]);
        assert_eq!(
            words.resolve("gs"),
            Some(WordResolution::Expands(ResolvedWord {
                head: "git".into(),
                prefix: vec!["status".into()],
                takes_args: true,
            }))
        );
        // Three links, each contributing a prefix, innermost first.
        let words = table(&[
            ("a", WordKind::Alias, Some(simple("git", &["log"], true))),
            (
                "b",
                WordKind::Alias,
                Some(simple("a", &["--oneline"], true)),
            ),
            ("c", WordKind::Alias, Some(simple("b", &["-n5"], true))),
        ]);
        assert_eq!(
            words.resolve("c"),
            Some(WordResolution::Expands(ResolvedWord {
                head: "git".into(),
                prefix: vec!["log".into(), "--oneline".into(), "-n5".into()],
                takes_args: true,
            }))
        );
    }

    #[test]
    fn takes_args_comes_from_the_outermost_entry() {
        // The typed arguments meet the outermost word: `amendall` discards them
        // however permissive the link beneath it is.
        let words = table(&[
            ("g", WordKind::Alias, Some(simple("git", &[], true))),
            (
                "amendall",
                WordKind::Function,
                Some(simple("g", &["commit", "--amend"], false)),
            ),
        ]);
        assert_eq!(
            words.resolve("amendall"),
            Some(WordResolution::Expands(ResolvedWord {
                head: "git".into(),
                prefix: vec!["commit".into(), "--amend".into()],
                takes_args: false,
            }))
        );
    }

    #[test]
    fn a_chain_through_an_unreadable_link_is_opaque() {
        let words = table(&[
            ("inner", WordKind::Function, None),
            (
                "outer",
                WordKind::Alias,
                Some(simple("inner", &["x"], true)),
            ),
        ]);
        assert_eq!(words.resolve("outer"), Some(WordResolution::Opaque));
    }

    #[test]
    fn a_cycle_is_opaque_rather_than_a_hang() {
        let words = table(&[
            ("a", WordKind::Alias, Some(simple("b", &[], true))),
            ("b", WordKind::Alias, Some(simple("a", &[], true))),
        ]);
        assert_eq!(words.resolve("a"), Some(WordResolution::Opaque));
        // A word that expands to itself is the degenerate case: `alias ls='ls
        // --color'` is real, common, and must not loop.
        let words = table(&[(
            "ls",
            WordKind::Alias,
            Some(simple("ls", &["--color"], true)),
        )]);
        assert_eq!(words.resolve("ls"), Some(WordResolution::Opaque));
    }

    #[test]
    fn an_over_deep_chain_is_opaque() {
        let mut words = ShellWords::empty();
        // w0 → w1 → … → w20, deeper than the cap.
        for i in 0..20 {
            words.insert_parsed(
                format!("w{i}"),
                WordKind::Alias,
                simple(&format!("w{}", i + 1), &[], true),
            );
        }
        words.insert_parsed("w20".into(), WordKind::Alias, simple("git", &[], true));
        assert_eq!(words.resolve("w0"), Some(WordResolution::Opaque));
    }

    #[test]
    fn a_chain_ending_in_a_builtin_names_the_builtin() {
        let words = table(&[
            ("echo", WordKind::Builtin, None),
            ("say", WordKind::Alias, Some(simple("echo", &["--"], true))),
        ]);
        assert_eq!(
            words.resolve("say"),
            Some(WordResolution::Expands(ResolvedWord {
                head: "echo".into(),
                prefix: vec!["--".into()],
                takes_args: true,
            }))
        );
    }

    #[test]
    fn member_names_come_back_sorted() {
        let words = table(&[
            ("zed", WordKind::Function, None),
            ("alpha", WordKind::Alias, None),
            ("mid", WordKind::Builtin, None),
        ]);
        assert_eq!(words.member_names(), vec!["alpha", "mid", "zed"]);
    }

    #[test]
    fn the_empty_table_holds_nothing() {
        let words = ShellWords::empty();
        assert!(words.is_empty());
        assert_eq!(words.resolve("anything"), None);
        assert!(!words.needs_body("anything"));
    }

    // -- interrogation -------------------------------------------------------

    #[test]
    fn folds_a_dump_into_a_table() {
        let dump = b"a\tgs\tgit status\0f\tamend\0f\t_completion_noise\0b\tsetopt\0";
        let words = parse_dump(dump);
        assert_eq!(
            words.resolve("gs"),
            Some(WordResolution::Expands(ResolvedWord {
                head: "git".into(),
                prefix: vec!["status".into()],
                takes_args: true,
            })),
            "an alias value arrives in hand and is parsed on the spot"
        );
        assert_eq!(words.kind("amend"), Some(WordKind::Function));
        assert!(words.needs_body("amend"), "bodies are fetched, not dumped");
        assert_eq!(words.kind("setopt"), Some(WordKind::Builtin));
        assert_eq!(
            words.kind("_completion_noise"),
            None,
            "completion functions are not invocable and do not belong in the table"
        );
    }

    #[test]
    fn a_malformed_dump_record_is_skipped_not_fatal() {
        let words = parse_dump(b"\0garbage\0z\tunknown-kind\0a\t\0f\tkept\0");
        assert_eq!(words.member_names(), vec!["kept"]);
    }

    /// Point `$SHELL` at zsh and `$ZDOTDIR` at a tempdir holding a known rc, so
    /// the assertions are about that rc and not about whatever the machine
    /// running the test happens to have configured. nextest runs each test in
    /// its own process, so the env mutation is contained.
    fn with_rc(rc: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".zshrc"), rc).unwrap();
        unsafe {
            std::env::set_var("SHELL", "/bin/zsh");
            std::env::set_var("ZDOTDIR", dir.path());
        }
        dir
    }

    #[test]
    fn dumps_the_words_a_real_shell_holds() {
        let _rc = with_rc("alias tugalias='git status'\ntugfn () { git status $* }\n");
        let words = dump_shell_words(None).expect("zsh dumps");

        assert_eq!(
            words.resolve("tugalias"),
            Some(WordResolution::Expands(ResolvedWord {
                head: "git".into(),
                prefix: vec!["status".into()],
                takes_args: true,
            }))
        );
        assert_eq!(words.kind("tugfn"), Some(WordKind::Function));
        assert!(words.needs_body("tugfn"));
        assert_eq!(
            words.kind("setopt"),
            Some(WordKind::Builtin),
            "a builtin off PATH is exactly what the login-PATH sweep cannot see"
        );
        assert!(
            !words.member_names().iter().any(|n| n.starts_with('_')),
            "completion functions are filtered"
        );
    }

    #[test]
    fn fetches_and_parses_a_real_function_body() {
        let _rc = with_rc("tugfn () { git status $* }\n");
        let printed = fetch_function_body("tugfn").expect("zsh prints the body");
        assert_eq!(
            parse_function_body(&printed),
            simple("git", &["status"], true)
        );
    }

    #[test]
    fn an_unusable_shell_yields_no_table_rather_than_a_guess() {
        unsafe {
            std::env::set_var("SHELL", "/usr/bin/false");
        }
        assert_eq!(dump_shell_words(None), None);
        assert_eq!(fetch_function_body("anything"), None);
    }

    #[test]
    fn a_name_outside_the_word_alphabet_never_reaches_a_shell() {
        assert!(!is_safe_word_name("x; rm -rf /"));
        assert!(!is_safe_word_name("$(date)"));
        assert!(!is_safe_word_name(""));
        assert!(is_safe_word_name("git-foo.bar:baz@1+2_x"));
        // Refused before `$SHELL` is even read, so this holds whatever shell the
        // machine has.
        assert_eq!(fetch_function_body("x; echo pwned"), None);
    }

    /// A stand-in login shell: ignores `-ilc` and runs the script with
    /// `/bin/sh`, so the test does not depend on anybody's rc files.
    fn fake_shell(dir: &Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-shell");
        std::fs::write(&path, "#!/bin/sh\nexec /bin/sh -c \"$2\"\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn is_alive(pid: libc::pid_t) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn a_wedged_profile_is_killed_with_everything_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path());
        let pids = dir.path().join("pids");
        // The shell's own pid, then a background sleeper's, then a wait that
        // outlasts the deadline — a profile that never comes back.
        let script = format!(
            "echo $$ > {p}; sleep 30 & echo $! >> {p}; wait",
            p = pids.display()
        );
        let started = std::time::Instant::now();
        let out = run_interrogation_within(&shell, &script, None, Duration::from_millis(500));
        assert_eq!(out, None);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "returned at the deadline, not when the script finished"
        );
        let written = std::fs::read_to_string(&pids).unwrap();
        let pids: Vec<libc::pid_t> = written.lines().map(|l| l.trim().parse().unwrap()).collect();
        assert_eq!(pids.len(), 2, "{written:?}");
        // The shell was reaped before the call returned. The sleeper, now an
        // orphan, is reaped by init; give that a moment, never seconds.
        let settle = std::time::Instant::now() + Duration::from_secs(2);
        while pids.iter().any(|&pid| is_alive(pid)) && std::time::Instant::now() < settle {
            std::thread::sleep(Duration::from_millis(20));
        }
        for pid in pids {
            assert!(!is_alive(pid), "pid {pid} survived the timeout");
        }
    }

    #[test]
    fn output_larger_than_a_pipe_buffer_arrives_whole() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path());
        // 4000 lines of 101 bytes: several times any pipe's buffer, so a reader
        // that only waited for the exit would deadlock against the writer.
        let script = "i=0; while [ $i -lt 4000 ]; do printf '%0100d\\n' 0; i=$((i+1)); done";
        let out = run_interrogation_within(&shell, script, None, Duration::from_secs(10))
            .expect("the script exits 0");
        assert_eq!(out.len(), 4000 * 101);
    }

    #[test]
    fn a_failing_script_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path());
        assert_eq!(
            run_interrogation_within(
                &shell,
                "echo partial; exit 3",
                None,
                Duration::from_secs(10)
            ),
            None
        );
    }
}
