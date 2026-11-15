//! `tuggram` — the shell command-grammar grader.
//!
//! # What it answers
//!
//! Given a line the user typed, this crate says how strong the evidence is that
//! the line is a shell command, in four bands: **Yes | Maybe | No | Unknown**.
//! Routing a line to the shell is irreversible — the command has already run by
//! the time anyone notices the mistake — so a **Yes is definitive and routes**:
//! it runs the line with no model call at all. Every band short of definitive
//! is a Maybe, where the model reads the line with the program's own
//! documentation attached. That is the whole division of labor: the grader
//! rules on what it can recognize, and hands everything else to the model.
//!
//! # The band doctrine
//!
//! The bands are defined by **evidence strength, not validity**, and the
//! asymmetry is deliberate:
//!
//! - **No** requires evidence of *absence*: the line lexed cleanly and one of
//!   its segment heads resolves to nothing at all — not on the login PATH, not a
//!   shell builtin, not an existing executable file. Nothing else produces a No.
//! - **Yes** is a resolving head whose every token the grammar **recognized** —
//!   a known flag, a known subcommand, an enumerated value, an existing path.
//! - **Maybe** is a resolving head carrying any token the grammar could not
//!   recognize, including a token in a position the grammar leaves free.
//! - **Unknown** is a resolving head with no baked grammar, a line the lexer
//!   will not claim to understand, or a check the grader could not perform.
//!
//! A stale catalog, a wrapper script, a flag added in a newer release: all of
//! these degrade Yes → Maybe, never toward No. Failed *validation* is never
//! evidence of absence, so catalog drift costs one band of caution and can never
//! swallow a real command.
//!
//! # What it never does
//!
//! It never reads English — it declines to. `make the watch loop resilient` is
//! a syntactically valid `make` invocation, but `make`'s positionals are free,
//! so the grammar recognizes nothing in those four words and the line grades
//! **Maybe**. A free position is where English hides; accepting anything there
//! is not recognizing anything there. Whether that line is a target list or a
//! sentence is the model's question, not this crate's.
//!
//! It never executes anything at grading time. The catalog is baked in and the
//! harvester that builds it runs offline; the only filesystem work on the hot
//! path is `stat` — on a path-shaped command word, and on a path positional
//! whose existence is what would make its line definitive.

use std::path::{Path, PathBuf};
use std::time::Duration;

pub mod catalog;
mod corpus;
pub mod harvest;
pub mod lex;
pub mod words;

pub use catalog::{
    Catalog, Entry, Grammar, PositionalKind, PositionalVerdict, Positionals, SYNOPSIS_CHAR_CAP,
    Source, catalog,
};
pub use lex::{Segment, lex};
pub use words::{ResolvedWord, ShellWord, ShellWords, WordKind, WordResolution};

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/// How strong the evidence is that a line is a shell command.
///
/// The ordering is the evidence ordering — `No < Unknown < Maybe < Yes` — so a
/// line's band is the `min` over its segments: one unresolvable segment head
/// settles the whole line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Band {
    /// Evidence of absence: something in the line names nothing that exists.
    No,
    /// No usable evidence either way. Behaves exactly as the pre-grader stack.
    Unknown,
    /// A real command carrying tokens its grammar cannot confirm.
    Maybe,
    /// A real command whose every token its grammar accounts for.
    Yes,
}

impl Band {
    /// The wire spelling used by the `shell_grammar` feed frame.
    pub fn as_str(self) -> &'static str {
        match self {
            Band::No => "no",
            Band::Unknown => "unknown",
            Band::Maybe => "maybe",
            Band::Yes => "yes",
        }
    }
}

/// The grader's answer about one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Graded {
    pub band: Band,
    /// The program's condensed documentation, on `Maybe` only — what the model
    /// is armed with when grammar alone could not tell.
    pub synopsis: Option<String>,
    /// The line's first command word, for logging and for keying the answer.
    pub command: Option<String>,
}

impl Graded {
    /// The answer for a line the grader could not get any purchase on.
    fn unknown(command: Option<String>) -> Self {
        Graded {
            band: Band::Unknown,
            synopsis: None,
            command,
        }
    }
}

// ---------------------------------------------------------------------------
// Command set
// ---------------------------------------------------------------------------

/// A sorted, deduped view onto the login-PATH executable names.
///
/// Borrowed rather than owned so the caller's cached `Vec<String>` — tugcast
/// holds one in a process-wide `OnceLock` — is consulted in place. The slice
/// **must** be sorted; [`command_names_in_path`] returns one that is.
#[derive(Debug, Clone, Copy)]
pub struct CommandSet<'a> {
    names: &'a [String],
}

impl<'a> CommandSet<'a> {
    /// Wrap an already-sorted slice of command names.
    pub fn new_sorted(names: &'a [String]) -> Self {
        CommandSet { names }
    }

    /// Whether the login PATH holds a command by this name.
    pub fn contains(&self, name: &str) -> bool {
        self.names
            .binary_search_by(|n| n.as_str().cmp(name))
            .is_ok()
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

/// Shell builtins, which run without any PATH presence and so would otherwise
/// resolve to nothing. zsh and bash agree on all of these.
///
/// A builtin *resolves* — it is a real command word — but carries no baked
/// grammar unless a curated catalog entry gives it one, so a builtin line grades
/// Unknown by default and takes the pre-grader path.
pub const SHELL_BUILTINS: &[&str] = &[
    ".", "[", "alias", "bg", "builtin", "cd", "command", "echo", "eval", "exec", "exit", "export",
    "false", "fg", "hash", "history", "jobs", "printf", "pwd", "read", "set", "source", "test",
    "true", "type", "unalias", "unset", "wait",
];

/// Whether a command word names a shell builtin.
pub fn is_builtin(name: &str) -> bool {
    SHELL_BUILTINS.binary_search(&name).is_ok()
}

// ---------------------------------------------------------------------------
// Head resolution
// ---------------------------------------------------------------------------

/// Everything the grader is allowed to consult about the session it is grading
/// for.
///
/// The three membership sources are deliberately separate and none borrows
/// another's authority. `words` is what the session's shell says it will
/// resolve — the executor's own answer, and the only source that can also
/// supply a grammar. `commands` is the cached login-PATH name set. `path_dirs`
/// is the PATH directories themselves, probed per word when the caller has
/// them, so a binary installed a moment ago is found and one deleted a moment
/// ago is not.
#[derive(Debug, Clone, Copy)]
pub struct ShellContext<'a> {
    /// The cached login-PATH command names.
    pub commands: CommandSet<'a>,
    /// The session shell's aliases, functions and builtins.
    pub words: &'a ShellWords,
    /// The login-PATH directories, for the per-word probe. Empty means no probe
    /// surface, and the cached `commands` set decides PATH membership alone.
    pub path_dirs: &'a [PathBuf],
    /// The shell session's working directory, or `None` before it has spawned a
    /// child. See [`resolve_head`] for why the distinction is load-bearing.
    pub cwd: Option<&'a Path>,
}

impl<'a> ShellContext<'a> {
    /// A context with no shell word table and no probe surface: the login-PATH
    /// set plus the static builtins, which is everything the grader knew before
    /// it could ask the session's shell.
    pub fn over_path(commands: CommandSet<'a>, cwd: Option<&'a Path>) -> Self {
        static EMPTY: std::sync::OnceLock<ShellWords> = std::sync::OnceLock::new();
        ShellContext {
            commands,
            words: EMPTY.get_or_init(ShellWords::empty),
            path_dirs: &[],
            cwd,
        }
    }
}

/// What became of the attempt to resolve one segment's command word.
#[derive(Debug, PartialEq, Eq)]
enum Resolution {
    /// It names something that exists.
    Resolved,
    /// It names an alias or function that expands to a single simple command,
    /// whose grammar can therefore be consulted on the typed line's behalf.
    Expands(ResolvedWord),
    /// It resolves — the shell holds this word — but its grammar cannot be
    /// read. Membership yes, grammar no. Distinct from `Resolved` because it
    /// must never reach the catalog: a user function named `git` would
    /// otherwise be graded against real git's grammar, a band derived from a
    /// program that will not run.
    Opaque,
    /// The check ran and found nothing. The only route to `Band::No`.
    Absent,
    /// The check could not run — a relative path with no cwd to resolve it
    /// against, a `~user` prefix, a word carrying a variable expansion. Absence
    /// of validation is not evidence of absence, so this yields `Unknown`.
    Unchecked,
}

/// Resolve a command word against the PATH set, the builtins, and the
/// filesystem.
///
/// Path-shaped words split by what they are relative to. `/usr/bin/true` and
/// `~/bin/x` are position-independent and stat directly. `./build.sh` and
/// `bin/tool` are relative to the **shell session's** working directory, which
/// is why `cwd` is a parameter and never the process's own: tugcast's cwd is
/// wherever the host launched it and has nothing to do with where the user's
/// shell is standing. With no session cwd yet, a relative word is `Unchecked` —
/// grading it absent would silently swallow `./build.sh` as prose in exactly the
/// situation where a user is most likely to type it, the first command of a
/// fresh session.
///
/// A bare word is asked of the shell first, in the shell's own precedence
/// order: an alias or function shadows a same-named binary, and the shell would
/// run the shadow. Only a word the shell holds no entry for falls through to
/// PATH.
fn resolve_head(head: &str, ctx: &ShellContext) -> Resolution {
    // A word carrying an expansion is not the word that will run. Path-shaped
    // words are never aliases or functions, so these branches stay ahead of the
    // word table.
    if head.contains('$') {
        return Resolution::Unchecked;
    }
    if let Some(rest) = head.strip_prefix("~/") {
        let Some(home) = std::env::var_os("HOME") else {
            return Resolution::Unchecked;
        };
        return stat_resolution(&PathBuf::from(home).join(rest));
    }
    // `~user/...` needs a passwd lookup this crate will not do.
    if head.starts_with('~') {
        return Resolution::Unchecked;
    }
    if head.starts_with('/') {
        return stat_resolution(Path::new(head));
    }
    if head.contains('/') {
        return match ctx.cwd {
            Some(cwd) => stat_resolution(&cwd.join(head)),
            None => Resolution::Unchecked,
        };
    }
    match ctx.words.resolve(head) {
        Some(WordResolution::Expands(word)) => return Resolution::Expands(word),
        Some(WordResolution::Opaque) => return Resolution::Opaque,
        // A builtin resolves and keeps the catalog path, exactly as the static
        // builtin list gives it.
        Some(WordResolution::Builtin) => return Resolution::Resolved,
        None => {}
    }
    // With the PATH directories in hand, ask the filesystem rather than the
    // cached name set. It is about twenty stats — the same order as the path
    // positional checks this grader already does — and it is authoritative in
    // both directions: a binary installed a minute ago is found, and one
    // deleted a minute ago is not found however recently the set was swept.
    if !ctx.path_dirs.is_empty() {
        for dir in ctx.path_dirs {
            if stat_resolution(&dir.join(head)) == Resolution::Resolved {
                return Resolution::Resolved;
            }
        }
        return if is_builtin(head) {
            Resolution::Resolved
        } else {
            Resolution::Absent
        };
    }
    if ctx.commands.contains(head) || is_builtin(head) {
        Resolution::Resolved
    } else {
        Resolution::Absent
    }
}

/// Whether a path names an existing executable regular file. Follows symlinks,
/// which is the norm for Homebrew shims and for `./x` pointing into a build dir.
fn stat_resolution(path: &Path) -> Resolution {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() && meta.permissions().mode() & 0o111 != 0 => {
            Resolution::Resolved
        }
        _ => Resolution::Absent,
    }
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/// Grade a line against the embedded catalog.
///
/// The subject is always the line as typed. When a head expands, the expansion
/// contributes the grammar to consult and the position within it — never the
/// text being graded, and never anything that runs.
pub fn grade(line: &str, ctx: &ShellContext) -> Graded {
    grade_with_catalog(line, ctx, catalog())
}

/// Grade a line against a caller-supplied catalog: lex it, resolve every
/// segment head, check each resolved head's tokens against its grammar, and
/// take the weakest band across segments.
pub fn grade_with_catalog(line: &str, ctx: &ShellContext, catalog: &Catalog) -> Graded {
    let Some(segments) = lex(line) else {
        return Graded::unknown(None);
    };
    let command = segments
        .first()
        .and_then(|s| s.head())
        .map(|h| h.to_string());
    if segments.is_empty() {
        return Graded::unknown(command);
    }

    let mut band = Band::Yes;
    let mut first_maybe_synopsis: Option<String> = None;
    for segment in &segments {
        // A segment of nothing but assignments has no command to resolve.
        let Some(head) = segment.head() else {
            band = band.min(Band::Unknown);
            continue;
        };
        // A name the user defined in their own shell, typed alone, is a
        // command they wrote for themselves to type. There is no token left
        // for English to occupy, and the word is theirs rather than a PATH
        // binary that happens to spell a verb — so `push`, a function whose
        // body runs backticks no grammar can read, runs exactly as `amend`
        // does. Arguments end the exemption: `add error handling here` is
        // still the model's to read.
        if segment.args().is_empty()
            && matches!(
                ctx.words.kind(head),
                Some(WordKind::Alias | WordKind::Function)
            )
        {
            continue;
        }
        let segment_band = match resolve_head(head, ctx) {
            Resolution::Absent => Band::No,
            // A word the shell holds but cannot explain says exactly as much as
            // a word with no baked grammar: ask the model.
            Resolution::Unchecked | Resolution::Opaque => Band::Unknown,
            Resolution::Resolved => match catalog.get(catalog_key(head)) {
                // It resolves but nothing here knows its grammar, which says
                // exactly as much as the pre-grader stack said.
                None => Band::Unknown,
                Some(entry) => {
                    let graded = grade_tokens(&entry.grammar, segment.args(), ctx.cwd);
                    if graded == Band::Maybe && first_maybe_synopsis.is_none() {
                        first_maybe_synopsis = Some(entry.synopsis.clone());
                    }
                    graded
                }
            },
            // The expansion supplies the grammar and the position within it;
            // the tokens graded are still the ones the user typed, spliced in
            // behind whatever the expansion already fixed.
            Resolution::Expands(word) => match catalog.get(catalog_key(&word.head)) {
                None => Band::Unknown,
                // The typed arguments have to survive the expansion for the
                // expansion to be what the line means. `amend x y z` runs `git
                // commit --amend` and drops `x y z` on the floor, so the
                // expansion's grammar is not evidence about that line — and
                // surplus arguments on an argument-ignoring word are themselves
                // evidence of prose.
                Some(_) if !word.takes_args && !segment.args().is_empty() => Band::Unknown,
                Some(entry) => {
                    let mut tokens = word.prefix.clone();
                    tokens.extend_from_slice(segment.args());
                    let graded = grade_tokens(&entry.grammar, &tokens, ctx.cwd);
                    if graded == Band::Maybe && first_maybe_synopsis.is_none() {
                        first_maybe_synopsis = Some(entry.synopsis.clone());
                    }
                    graded
                }
            },
        };
        band = band.min(segment_band);
    }

    Graded {
        // A synopsis is what arms the model on a Maybe. A line whose weakest
        // segment is No or Unknown gets no model call or no documentation, so
        // it carries none even if some other segment produced one.
        synopsis: if band == Band::Maybe {
            first_maybe_synopsis
        } else {
            None
        },
        band,
        command,
    }
}

/// The catalog key for a command word. `/usr/bin/git` and `./git` are `git`:
/// the catalog is keyed by program name, and a path-shaped word that resolved
/// still names a program.
fn catalog_key(head: &str) -> &str {
    match head.rsplit_once('/') {
        Some((_, name)) => name,
        None => head,
    }
}

/// Walk a resolved command's tokens against its grammar.
///
/// `Yes` means every token was *confirmed* — matched against something the
/// grammar names. `Maybe` means at least one was not: an unknown flag, an
/// unknown subcommand, a bare word where the grammar takes none, a path that
/// does not exist, or a bare word in a position the grammar leaves free.
///
/// That last case is why a free positional cannot hold a line at `Yes`. A
/// grammar with free positionals accepts any word at all, so `make the watch
/// loop resilient` fits `make` as exactly as `make test` does — a free position
/// is precisely where English hides, and confirming nothing there is not the
/// same as confirming a command. A Yes routes to the shell without a model
/// call, so it has to mean the grammar recognized every token, not merely that
/// it declined to object to any.
///
/// Note what this never concludes: an unconfirmed token is never evidence the
/// line is prose, only evidence that the baked grammar cannot confirm it, which
/// is the model's question with the documentation attached.
fn grade_tokens(top: &Grammar, args: &[String], cwd: Option<&Path>) -> Band {
    let mut grammar = top;
    // `--` ends option parsing; everything after it is a positional.
    let mut end_of_options = false;
    // Subcommand descent is only available before the first real positional.
    let mut seen_positional = false;
    let mut i = 0;

    while i < args.len() {
        let token = args[i].as_str();
        i += 1;

        if !end_of_options && token == "--" {
            end_of_options = true;
            continue;
        }

        // A lone `-` is the conventional name for standard input, not a flag.
        if !end_of_options && token.starts_with('-') && token != "-" {
            // `--flag=value` carries its value inline.
            let (base, inline_value) = match token.split_once('=') {
                Some((base, _)) => (base, true),
                None => (token, false),
            };
            if grammar.knows_flag(base) {
                if !inline_value && grammar.flag_takes_value(base) {
                    i += 1;
                }
                continue;
            }
            match bundled_short_flags(grammar, token) {
                Some(true) => i += 1,
                Some(false) => {}
                None => return Band::Maybe,
            }
            continue;
        }

        if !seen_positional {
            if let Some(sub) = grammar.subcommands.get(token) {
                grammar = sub;
                continue;
            }
        }
        seen_positional = true;
        if grammar.positional_verdict(token, cwd) != PositionalVerdict::Confirmed {
            return Band::Maybe;
        }
    }

    Band::Yes
}

/// Whether `token` is a bundle of known single-character flags (`-la` for
/// `-l -a`). Returns whether the bundle's last flag takes the following token
/// as its value, or `None` if this is not a recognizable bundle.
///
/// Only the final flag in a bundle may take a value — that is how the shell
/// tools themselves read `-n5` and `-ofile` — so a value-taking flag anywhere
/// else means this was not a bundle at all.
fn bundled_short_flags(grammar: &Grammar, token: &str) -> Option<bool> {
    let body = token.strip_prefix('-')?;
    if body.starts_with('-') || body.chars().count() < 2 {
        return None;
    }
    let chars: Vec<char> = body.chars().collect();
    for (idx, c) in chars.iter().enumerate() {
        let flag = format!("-{c}");
        if !grammar.knows_flag(&flag) {
            return None;
        }
        if grammar.flag_takes_value(&flag) {
            // A value-taking flag with more characters behind it took those
            // characters as its value (`-n5`), which only reads as a bundle if
            // it is the last one.
            return if idx + 1 == chars.len() {
                Some(true)
            } else {
                Some(false)
            };
        }
    }
    Some(false)
}

// ---------------------------------------------------------------------------
// Login PATH resolution
// ---------------------------------------------------------------------------

/// Wall-clock cap on the login-PATH probe. The probe is a non-interactive
/// `printf` — cheap — so a stall past this means the login shell wedged on rc
/// baggage; fall back to the calling process's own `$PATH`.
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolve the user's login `$PATH`: spawn `$SHELL -lc 'printf %s "$PATH"'`
/// when `$SHELL` is bash/zsh, else — or on probe failure / timeout — fall back
/// to this process's own `$PATH`. Not an interactive shell: that can wedge on rc
/// baggage; a non-interactive login probe is cheap, safe, and PATH-accurate.
pub fn probe_login_path() -> String {
    if let Ok(sh) = std::env::var("SHELL") {
        let leaf = sh.rsplit('/').next().unwrap_or("");
        if leaf == "bash" || leaf == "zsh" {
            if let Some(p) = run_path_probe(&sh) {
                return p;
            }
        }
    }
    std::env::var("PATH").unwrap_or_default()
}

/// Run the login-shell PATH probe with a hard timeout. A background thread runs
/// the blocking `Command`; `recv_timeout` bounds the wait so a wedged login
/// shell can't stall the caller. Returns the trimmed `$PATH`, or `None` on
/// failure / non-zero exit / empty output / timeout.
fn run_path_probe(shell: &str) -> Option<String> {
    let shell = shell.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = std::process::Command::new(&shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(PATH_PROBE_TIMEOUT) {
        Ok(Ok(output)) if output.status.success() => String::from_utf8(output.stdout)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// Sweep the login-PATH directories for executable command names, resolving the
/// login `$PATH` first.
pub fn compute_path_commands() -> Vec<String> {
    command_names_in_path(&probe_login_path())
}

/// Sweep a `:`-separated PATH string for executable command names: readdir each
/// existing entry, keep regular files with an executable bit, dedupe and sort (a
/// `BTreeSet` gives both). Pure over the filesystem — the unit seam.
pub fn command_names_in_path(path: &str) -> Vec<String> {
    use std::collections::BTreeSet;

    let mut set: BTreeSet<String> = BTreeSet::new();
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        set.extend(command_names_in_dir(Path::new(dir)));
    }
    set.into_iter().collect()
}

/// Readdir one directory for executable command names, sorted. The per-
/// directory seam: a caller revalidating a PATH by directory mtime re-reads
/// only the directories that moved, and reads them exactly the way a full sweep
/// would.
pub fn command_names_in_dir(dir: &Path) -> Vec<String> {
    use std::collections::BTreeSet;
    use std::os::unix::fs::PermissionsExt;

    let mut set: BTreeSet<String> = BTreeSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        // `std::fs::metadata` — NOT `DirEntry::metadata`, which is `lstat`
        // on Unix and reports a symlink as a symlink rather than as what it
        // points at. Symlinked executables are the norm, not the exception:
        // every Homebrew shim is one, and so are `/usr/bin/tar` and the
        // rustup shims, so an `lstat` here drops `cargo`, `rg`, `just` and
        // `tar` out of the set the deck's shell-line precondition consults.
        // A broken link errors out and is skipped, which is what we want.
        let Ok(meta) = std::fs::metadata(entry.path()) else {
            continue;
        };
        if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
            if let Some(name) = entry.file_name().to_str() {
                set.insert(name.to_string());
            }
        }
    }
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn names(list: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    }

    /// Grade against an injected command set — never the real login PATH, so
    /// the result does not depend on what this machine happens to have
    /// installed.
    fn band_of(line: &str, installed: &[&str], cwd: Option<&Path>) -> Band {
        let names = names(installed);
        grade(
            line,
            &ShellContext::over_path(CommandSet::new_sorted(&names), cwd),
        )
        .band
    }

    fn make_executable(dir: &Path, name: &str) {
        let p = dir.join(name);
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_head_that_names_nothing_is_no() {
        assert_eq!(band_of("frobnicate the thing", &["git"], None), Band::No);
    }

    #[test]
    fn one_bad_head_in_a_pipeline_settles_the_whole_line() {
        assert_eq!(band_of("git status | frobnicate", &["git"], None), Band::No);
        assert_eq!(
            band_of("cargo build && deploy-it", &["cargo"], None),
            Band::No
        );
    }

    #[test]
    fn builtins_resolve_without_any_path_presence() {
        assert_eq!(band_of("cd tugrust", &[], None), Band::Unknown);
        assert_eq!(band_of("export FOO=1", &[], None), Band::Unknown);
    }

    #[test]
    fn an_env_prefix_does_not_hide_the_command() {
        // `make` resolves through the prefix — `test` is a free positional, so
        // the line is Maybe rather than Yes, but it is emphatically not No.
        assert_eq!(band_of("FOO=1 make test", &["make"], None), Band::Maybe);
        assert_eq!(band_of("FOO=1 nosuch test", &["make"], None), Band::No);
    }

    #[test]
    fn a_line_the_lexer_refuses_is_unknown_never_no() {
        // Every one of these opens on a word that names nothing, so a lex that
        // succeeded would grade No. The refusal is what protects them.
        assert_eq!(
            band_of("echo `nosuchthing`", &["echo"], None),
            Band::Unknown
        );
        assert_eq!(band_of("nosuchthing 'unbalanced", &[], None), Band::Unknown);
        assert_eq!(band_of("cat <<EOF", &["cat"], None), Band::Unknown);
    }

    #[test]
    fn a_variable_head_is_unchecked_not_absent() {
        assert_eq!(band_of("$EDITOR notes.txt", &[], None), Band::Unknown);
    }

    #[test]
    fn a_relative_head_resolves_against_the_session_cwd() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(dir.path(), "build.sh");
        assert_eq!(
            band_of("./build.sh", &[], Some(dir.path())),
            Band::Unknown,
            "resolves, so it falls through to the no-grammar band"
        );
    }

    #[test]
    fn a_relative_head_the_cwd_does_not_hold_is_no() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(band_of("./build.sh", &[], Some(dir.path())), Band::No);
    }

    #[test]
    fn a_relative_head_with_no_cwd_is_unknown_never_no() {
        // The first command of a fresh session: no shell child has spawned, so
        // there is no directory to resolve against. The check could not run.
        assert_eq!(band_of("./build.sh", &[], None), Band::Unknown);
        assert_eq!(band_of("bin/tool --check", &[], None), Band::Unknown);
    }

    #[test]
    fn an_absolute_head_is_unaffected_by_the_cwd() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(dir.path(), "tool");
        let absolute = dir.path().join("tool");
        let line = format!("{} --check", absolute.display());
        assert_eq!(band_of(&line, &[], None), Band::Unknown);
        assert_eq!(band_of("/no/such/binary", &[], Some(dir.path())), Band::No);
    }

    #[test]
    fn a_non_executable_file_does_not_resolve() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hi").unwrap();
        assert_eq!(band_of("./notes.txt", &[], Some(dir.path())), Band::No);
    }

    /// Grade against the committed catalog and an injected command set, so the
    /// answer depends on the catalog under review and nothing else.
    fn graded(line: &str, installed: &[&str]) -> Graded {
        let names = names(installed);
        grade(
            line,
            &ShellContext::over_path(CommandSet::new_sorted(&names), None),
        )
    }

    /// The same, standing in a directory — for the path positionals whose band
    /// depends on what is actually there.
    fn graded_in(line: &str, installed: &[&str], cwd: &Path) -> Graded {
        let names = names(installed);
        grade(
            line,
            &ShellContext::over_path(CommandSet::new_sorted(&names), Some(cwd)),
        )
    }

    // -- grading through the session shell's word table -----------------------

    /// The reference machine's table, as the brief measured it: `gs` and `pick`
    /// absorb arguments, `amend` does not, `add` is multi-statement and so
    /// unreadable, and `git` is shadowed by a user function.
    fn reference_words() -> ShellWords {
        let mut words = ShellWords::empty();
        let simple = |head: &str, prefix: &[&str], takes_args: bool| ShellWord::Simple {
            head: head.to_string(),
            prefix: prefix.iter().map(|s| s.to_string()).collect(),
            takes_args,
        };
        words.insert_parsed(
            "gs".into(),
            WordKind::Function,
            simple("git", &["status"], true),
        );
        words.insert_parsed(
            "amend".into(),
            WordKind::Function,
            simple("git", &["commit", "--amend"], false),
        );
        words.insert_parsed("add".into(), WordKind::Function, ShellWord::Opaque);
        words.insert("setopt".into(), WordKind::Builtin);
        words
    }

    fn band_with_words(line: &str, words: &ShellWords, installed: &[&str]) -> Band {
        let names = names(installed);
        grade(
            line,
            &ShellContext {
                commands: CommandSet::new_sorted(&names),
                words,
                path_dirs: &[],
                cwd: None,
            },
        )
        .band
    }

    #[test]
    fn an_expansion_lends_its_grammar_to_the_typed_line() {
        let words = reference_words();
        // The words the user actually types, graded against git's grammar
        // entered where the expansion left off. Note `git` is not in the
        // installed set: membership came from the shell, not from PATH.
        assert_eq!(band_with_words("gs", &words, &[]), Band::Yes);
        assert_eq!(band_with_words("gs -sb", &words, &[]), Band::Yes);
        assert_eq!(band_with_words("gs --invented", &words, &[]), Band::Maybe);
    }

    #[test]
    fn a_word_that_discards_arguments_only_speaks_for_the_bare_line() {
        let words = reference_words();
        // `amend` alone is the expansion, so it routes.
        assert_eq!(band_with_words("amend", &words, &[]), Band::Yes);
        // `amend last commit please` runs `git commit --amend` and drops the
        // words on the floor, so the expansion says nothing about this line and
        // the model reads it as the English it is.
        assert_eq!(
            band_with_words("amend last commit please", &words, &[]),
            Band::Unknown
        );
    }

    #[test]
    fn an_unreadable_body_is_membership_without_grammar() {
        let words = reference_words();
        // It resolves, so it is never No — the shell holds the word.
        assert_eq!(
            band_with_words("add error handling here", &words, &[]),
            Band::Unknown
        );
    }

    #[test]
    fn a_bare_user_word_runs_whatever_its_body() {
        // Reversed 2026-11-15: a bare opaque word used to grade Unknown and go
        // to the model, which read the user's own `push` function as a request
        // to push. A name the user defined, typed alone, is a command.
        let mut words = reference_words();
        assert_eq!(band_with_words("add", &words, &[]), Band::Yes);
        // Unread is the same answer — the body is never what makes it theirs.
        words.insert("push".into(), WordKind::Function);
        assert_eq!(band_with_words("push", &words, &[]), Band::Yes);
        words.insert("deploy".into(), WordKind::Alias);
        assert_eq!(band_with_words("deploy && push", &words, &[]), Band::Yes);
        // A builtin is not the user's word and keeps its catalog path.
        assert_eq!(band_with_words("setopt", &words, &[]), Band::Unknown);
    }

    #[test]
    fn a_shadowing_word_wins_over_the_binary_it_shadows() {
        // `gs` is ghostscript on this machine's PATH *and* a git function in
        // the shell. The shell runs the function, so the grade follows it.
        let mut words = ShellWords::empty();
        words.insert_parsed(
            "ls".into(),
            WordKind::Function,
            ShellWord::Simple {
                head: "git".into(),
                prefix: vec!["status".into()],
                takes_args: true,
            },
        );
        assert_eq!(band_with_words("ls -sb", &words, &["ls"]), Band::Yes);
    }

    #[test]
    fn a_function_shadowing_a_cataloged_program_never_borrows_its_grammar() {
        // The reason `Opaque` is its own resolution: a user function named
        // `git` must not be graded against real git's grammar, because real git
        // is not what will run.
        let mut words = ShellWords::empty();
        words.insert_parsed("git".into(), WordKind::Function, ShellWord::Opaque);
        assert_eq!(
            band_with_words("git status", &words, &["git"]),
            Band::Unknown
        );
        // Unread is the same answer: a member whose body nobody fetched.
        let mut words = ShellWords::empty();
        words.insert("git".into(), WordKind::Function);
        assert_eq!(
            band_with_words("git status", &words, &["git"]),
            Band::Unknown
        );
    }

    #[test]
    fn a_builtin_the_static_list_never_heard_of_still_resolves() {
        // `setopt` is on no PATH and in no static list, and today grades No —
        // evidence of absence about a word the shell runs every day.
        assert_eq!(band_of("setopt extendedglob", &[], None), Band::No);
        assert_eq!(
            band_with_words("setopt extendedglob", &reference_words(), &[]),
            Band::Unknown
        );
    }

    #[test]
    fn an_expansion_onto_an_uncataloged_program_is_unknown() {
        let mut words = ShellWords::empty();
        words.insert_parsed(
            "deploy".into(),
            WordKind::Alias,
            ShellWord::Simple {
                head: "frobnicate".into(),
                prefix: vec![],
                takes_args: true,
            },
        );
        assert_eq!(band_with_words("deploy now", &words, &[]), Band::Unknown);
    }

    #[test]
    fn an_expansion_that_lands_on_maybe_carries_the_synopsis() {
        let words = reference_words();
        let names = names(&[]);
        let graded = grade(
            "gs --invented",
            &ShellContext {
                commands: CommandSet::new_sorted(&names),
                words: &words,
                path_dirs: &[],
                cwd: None,
            },
        );
        assert_eq!(graded.band, Band::Maybe);
        let synopsis = graded.synopsis.expect("a maybe arms the model");
        assert!(synopsis.contains("git"));
    }

    #[test]
    fn a_word_table_never_touches_a_path_shaped_head() {
        // `/usr/bin/gs` and `./gs` are not aliases; the shell would not expand
        // them, so neither does the grade.
        let words = reference_words();
        assert_eq!(band_with_words("/no/such/gs -sb", &words, &[]), Band::No);
        assert_eq!(band_with_words("./gs -sb", &words, &[]), Band::Unknown);
    }

    #[test]
    fn the_path_directories_outrank_the_cached_name_set() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(dir.path(), "freshly-installed");
        let dirs = vec![dir.path().to_path_buf()];
        let empty = ShellWords::empty();
        let cached = names(&["deleted-since"]);
        let ctx = ShellContext {
            commands: CommandSet::new_sorted(&cached),
            words: &empty,
            path_dirs: &dirs,
            cwd: None,
        };
        // On disk but not in the set: the `brew install` a moment ago.
        assert_eq!(
            grade("freshly-installed --go", &ctx).band,
            Band::Unknown,
            "it resolves, so it is not No"
        );
        // In the set but no longer on disk: the sweep is stale, the disk is not.
        assert_eq!(grade("deleted-since --go", &ctx).band, Band::No);
        // A builtin is not a file anywhere and still resolves.
        assert_eq!(grade("cd somewhere", &ctx).band, Band::Unknown);
        // Nothing anywhere is still No.
        assert_eq!(grade("frobnicate x", &ctx).band, Band::No);
    }

    #[test]
    fn with_no_probe_surface_the_cached_set_decides_alone() {
        let empty = ShellWords::empty();
        let cached = names(&["git"]);
        let ctx = ShellContext {
            commands: CommandSet::new_sorted(&cached),
            words: &empty,
            path_dirs: &[],
            cwd: None,
        };
        assert_eq!(grade("git status", &ctx).band, Band::Yes);
        assert_eq!(grade("frobnicate x", &ctx).band, Band::No);
    }

    #[test]
    fn a_word_the_shell_holds_is_never_probed_for_on_path() {
        // Membership order is the shell's: a function shadowing nothing at all
        // resolves anyway, and an empty PATH directory does not make it absent.
        let dir = tempfile::tempdir().unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        let words = reference_words();
        let cached = names(&[]);
        let ctx = ShellContext {
            commands: CommandSet::new_sorted(&cached),
            words: &words,
            path_dirs: &dirs,
            cwd: None,
        };
        assert_eq!(grade("gs -sb", &ctx).band, Band::Yes);
        assert_eq!(grade("setopt extendedglob", &ctx).band, Band::Unknown);
    }

    #[test]
    fn the_empty_table_grades_exactly_as_before() {
        let empty = ShellWords::empty();
        assert_eq!(band_with_words("git status", &empty, &["git"]), Band::Yes);
        assert_eq!(band_with_words("frobnicate x", &empty, &["git"]), Band::No);
        assert_eq!(band_with_words("cd tugrust", &empty, &[]), Band::Unknown);
    }

    #[test]
    fn a_command_whose_every_token_the_grammar_recognizes_is_yes() {
        assert_eq!(graded("git status", &["git"]).band, Band::Yes);
        assert_eq!(graded("git status -s", &["git"]).band, Band::Yes);
        assert_eq!(
            graded("git commit -m \"fix the crash\"", &["git"]).band,
            Band::Yes
        );
        assert_eq!(graded("cargo build -p tugcast", &["cargo"]).band, Band::Yes);
    }

    #[test]
    fn a_path_positional_is_yes_when_it_is_there_and_maybe_when_it_is_not() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hi").unwrap();

        assert_eq!(
            graded_in("sort -u notes.txt", &["sort"], dir.path()).band,
            Band::Yes
        );
        // Nothing of that name is there, so the grader cannot call the line
        // definitive and the model reads it instead.
        assert_eq!(
            graded_in("sort -u missing.txt", &["sort"], dir.path()).band,
            Band::Maybe
        );
        // A session with no cwd yet has nothing to resolve the name against.
        assert_eq!(graded("sort -u notes.txt", &["sort"]).band, Band::Maybe);
    }

    #[test]
    fn an_unknown_subcommand_is_maybe_not_no() {
        // A typo and a stale catalog are the same shape from here. Both cost
        // one band; neither can swallow the line.
        assert_eq!(graded("git stauts", &["git"]).band, Band::Maybe);
        assert_eq!(graded("cargo bulid", &["cargo"]).band, Band::Maybe);
    }

    #[test]
    fn an_unknown_flag_is_maybe() {
        assert_eq!(graded("rg --no-such-flag x", &["rg"]).band, Band::Maybe);
        assert_eq!(graded("git status --invented", &["git"]).band, Band::Maybe);
    }

    #[test]
    fn a_maybe_carries_the_program_documentation_and_nothing_else_does() {
        let maybe = graded("git stauts", &["git"]);
        assert_eq!(maybe.band, Band::Maybe);
        let synopsis = maybe.synopsis.expect("a maybe arms the model");
        assert!(synopsis.contains("git"));
        assert!(graded("git status", &["git"]).synopsis.is_none());
        assert!(graded("frobnicate x", &["git"]).synopsis.is_none());
    }

    #[test]
    fn a_no_segment_beats_a_maybe_segment_and_drops_its_synopsis() {
        let g = graded("git stauts | frobnicate", &["git"]);
        assert_eq!(g.band, Band::No);
        assert!(g.synopsis.is_none(), "a No never reaches the model at all");
    }

    #[test]
    fn free_positionals_mean_the_grader_does_not_read_english() {
        // `make` takes arbitrary targets, so this IS a well-formed make
        // invocation — and that is exactly the problem. A free position fits
        // English as snugly as it fits a target list, so the grammar has
        // recognized nothing here and the line cannot be definitive.
        assert_eq!(
            graded("make the watch loop resilient", &["make"]).band,
            Band::Maybe
        );
        assert_eq!(graded("say hello there", &["say"]).band, Band::Maybe);
        // The short real invocation is no different: `test` is a target the
        // grammar never named either.
        assert_eq!(graded("make test", &["make"]).band, Band::Maybe);
        // What survives is the line with nothing free in it at all.
        assert_eq!(graded("make -j8", &["make"]).band, Band::Yes);
    }

    #[test]
    fn a_command_that_takes_no_bare_words_flags_one() {
        assert_eq!(graded("top extra", &["top"]).band, Band::Maybe);
    }

    #[test]
    fn value_flags_swallow_their_argument() {
        // `-m` takes the next token, so `resilient` is the only positional and
        // `git commit` accepts file positionals.
        assert_eq!(graded("git commit -m resilient", &["git"]).band, Band::Yes);
        // The same token as a bare word instead would be an unknown subcommand.
        assert_eq!(graded("git resilient", &["git"]).band, Band::Maybe);
    }

    #[test]
    fn long_flags_accept_an_inline_value() {
        assert_eq!(graded("git log --pretty=oneline", &["git"]).band, Band::Yes);
    }

    #[test]
    fn bundled_short_flags_are_accounted_for() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hi").unwrap();
        assert_eq!(
            graded_in("sort -nr notes.txt", &["sort"], dir.path()).band,
            Band::Yes
        );
        // `-q` is not one of sort's short flags, so the bundle is unrecognized
        // whatever the file does.
        assert_eq!(
            graded_in("sort -nq notes.txt", &["sort"], dir.path()).band,
            Band::Maybe
        );
    }

    #[test]
    fn everything_after_a_double_dash_is_a_positional() {
        // `cargo` takes no bare words, so `--nocapture` past the terminator is
        // a positional it does not accept. The terminator is what makes it a
        // positional rather than an unknown flag; either way it is not
        // recognized, and the point of the test is that `--` ended option
        // parsing rather than which band a trailing word lands in.
        assert_eq!(
            graded("cargo nextest run -- --nocapture", &["cargo"]).band,
            Band::Maybe
        );
    }

    #[test]
    fn a_builtin_still_has_no_grammar_to_check_against() {
        assert_eq!(graded("cd tugrust", &[]).band, Band::Unknown);
    }

    #[test]
    fn a_resolving_command_the_catalog_does_not_know_is_unknown() {
        assert_eq!(
            graded("ffmpeg -i in.mov out.mp4", &["ffmpeg"]).band,
            Band::Unknown
        );
    }

    #[test]
    fn a_path_shaped_head_is_graded_by_its_program_name() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(dir.path(), "git");
        let names = names(&[]);
        let commands = CommandSet::new_sorted(&names);
        let line = format!("{}/git stauts", dir.path().display());
        assert_eq!(
            grade(&line, &ShellContext::over_path(commands, None)).band,
            Band::Maybe
        );
    }

    #[test]
    fn the_command_word_is_reported_for_logging() {
        let names = names(&["git"]);
        let g = grade(
            "FOO=1 git status",
            &ShellContext::over_path(CommandSet::new_sorted(&names), None),
        );
        assert_eq!(g.command.as_deref(), Some("git"));
    }

    #[test]
    fn the_builtin_list_is_sorted_so_the_lookup_holds() {
        let mut sorted = SHELL_BUILTINS.to_vec();
        sorted.sort_unstable();
        assert_eq!(SHELL_BUILTINS, sorted.as_slice());
    }

    #[test]
    fn command_names_in_path_dedupes_and_sorts() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        // `zed` in both dirs (dedupe); `apple` non-executable (skipped).
        make_executable(a.path(), "zed");
        make_executable(a.path(), "git");
        make_executable(b.path(), "zed");
        make_executable(b.path(), "cargo");
        let plain = b.path().join("apple");
        std::fs::write(&plain, b"data").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();

        let path = format!("{}:{}", a.path().display(), b.path().display());
        assert_eq!(command_names_in_path(&path), vec!["cargo", "git", "zed"]);
    }

    #[test]
    fn command_names_in_path_follows_symlinks() {
        // Symlinked executables are the norm — every Homebrew shim, the rustup
        // shims, `/usr/bin/tar`. Reading the link itself instead of its target
        // silently drops all of them, and a command missing from this set
        // cannot pass the deck's shell-line precondition at all.
        let real = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        make_executable(real.path(), "cargo");
        std::os::unix::fs::symlink(real.path().join("cargo"), bin.path().join("cargo")).unwrap();
        std::os::unix::fs::symlink(real.path().join("gone"), bin.path().join("dangling")).unwrap();

        let names = command_names_in_path(&bin.path().to_string_lossy());
        assert_eq!(names, vec!["cargo"], "a dangling link resolves to nothing");
    }

    #[test]
    fn command_names_in_path_skips_missing_and_empty_segments() {
        // A nonexistent dir and empty segments are tolerated, not fatal.
        assert!(command_names_in_path("/no/such/dir::").is_empty());
    }

    #[test]
    fn run_path_probe_bogus_shell_returns_none() {
        // A shell that can't spawn fails fast → None, so `probe_login_path`
        // falls back to the process's own `$PATH`.
        assert_eq!(run_path_probe("/nonexistent/shell/binary"), None);
    }
}
