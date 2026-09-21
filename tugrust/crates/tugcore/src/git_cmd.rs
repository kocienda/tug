//! The one place Tug spawns `git` from.
//!
//! A plain `git status` opportunistically refreshes the index and takes
//! `index.lock` to do it. Tug runs a great many of those — feeds, censuses,
//! preflights — beside the few writes that genuinely need the lock, and a
//! join that loses the base's index lock to one of Tug's own reads is Tug
//! competing with itself. `GIT_OPTIONAL_LOCKS=0` turns off exactly that
//! opportunism: it affects only *optional* locks and leaves the mandatory
//! locks of commit, merge and checkout alone, so it is set on every
//! invocation rather than chosen per call site — per-call-site discipline is
//! what left one feed passing `--no-optional-locks` and the rest not.
//!
//! `GIT_LITERAL_PATHSPECS=1` is set on the same footing, and for the same
//! reason the door exists [B03]: every operand Tug puts after a `--` is a
//! path it read back from git or from the filesystem, so a `*` or a `[` in
//! one is part of a file's NAME rather than a pattern. Without this, a file
//! genuinely called `*.jpg` is a pathspec that matches every jpg in the tree
//! — and a commit of it stages files the user never chose. Set at the
//! constructor rather than per call, because a per-call-site rule is the one
//! that gets forgotten.
//!
//! The corollary is that a caller who genuinely wants a glob cannot get one
//! from git, and must not try: it resolves the pattern against a listing read
//! through the door and hands git the literal paths that matched. The
//! Operator's `path`, `path_scope` and `repo.ls` arguments are the surfaces
//! that do this — see `tugcast::feeds::repo_files`.
//!
//! An async caller wraps the same builder:
//! `tokio::process::Command::from(tugcore::git_command())`.

use std::process::Command;

/// The variable git reads, and the value that declines optional locks.
pub const GIT_OPTIONAL_LOCKS: (&str, &str) = ("GIT_OPTIONAL_LOCKS", "0");

/// The variable git reads, and the value that makes every pathspec literal.
pub const GIT_LITERAL_PATHSPECS: (&str, &str) = ("GIT_LITERAL_PATHSPECS", "1");

/// A `git` command that takes no optional locks and treats every pathspec as
/// a literal path.
pub fn git_command() -> Command {
    let mut cmd = Command::new("git");
    cmd.env(GIT_OPTIONAL_LOCKS.0, GIT_OPTIONAL_LOCKS.1);
    cmd.env(GIT_LITERAL_PATHSPECS.0, GIT_LITERAL_PATHSPECS.1);
    cmd
}

/// A `git` command for `check-ignore`, which **refuses** the literal setting.
///
/// `git check-ignore` rejects pathspec magic outright — with the variable set
/// it exits 128 saying `pathspec magic not supported by this command:
/// 'literal'`, whatever the argument is. It is the only subcommand Tug runs
/// that does, so this is not a general escape hatch and must not become one.
///
/// Scrubbing it costs nothing here, which is the reason this is a scrub
/// rather than a problem: every `check-ignore` Tug runs asks the same fixed
/// question about the literal string `.tug/`, a pattern Tug authored rather
/// than a path it read back from git. There is no name for the setting to
/// protect.
pub fn git_command_for_check_ignore() -> Command {
    let mut cmd = git_command();
    cmd.env_remove(GIT_LITERAL_PATHSPECS.0);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The spawned git sees the variable — read back through git itself, whose
    /// `!` alias runs a shell in the environment git was given.
    #[test]
    fn the_spawned_git_declines_optional_locks() {
        let out = git_command()
            .args([
                "-c",
                "alias.lockenv=!printenv GIT_OPTIONAL_LOCKS",
                "lockenv",
            ])
            .output()
            .expect("git runs");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0");
    }

    /// A file whose name IS a glob is addressable, which is the whole of
    /// [B03]. Without `GIT_LITERAL_PATHSPECS` the `*.jpg` operand matches
    /// every jpg in the tree, so the assertion is on what did NOT get
    /// staged — the failure this prevents is silent over-selection, not an
    /// error.
    #[test]
    fn a_file_named_like_a_glob_is_a_name_and_not_a_pattern() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let git = |args: &[&str]| {
            let out = git_command()
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .expect("git runs");
            assert!(out.status.success(), "git {args:?}: {:?}", out.stderr);
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@t.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("*.jpg"), "the glob-named one\n").expect("write");
        std::fs::write(root.join("holiday.jpg"), "a bystander\n").expect("write");

        git(&["add", "--", "*.jpg"]);

        let staged = git_command()
            .arg("-C")
            .arg(root)
            .args(["diff", "--cached", "--name-only", "-z"])
            .output()
            .expect("git runs");
        let staged = String::from_utf8_lossy(&staged.stdout);
        let staged: Vec<&str> = staged.split('\0').filter(|s| !s.is_empty()).collect();
        assert_eq!(staged, vec!["*.jpg"]);
    }

    /// No production source spawns `git` any other way. The rule lives at the
    /// constructor because a per-call-site rule is the one that was forgotten.
    /// A build script is exempt: it cannot link this crate, and the one there
    /// is a `rev-parse`, which takes no lock.
    #[test]
    fn no_ad_hoc_git_spawns() {
        let needle = ["new(", "\"git\")"].concat();
        let offenders: Vec<String> = crate::source_scan::production_sources()
            .into_iter()
            .filter(|(path, _)| {
                !path.ends_with("tugcore/src/git_cmd.rs") && !path.ends_with("build.rs")
            })
            .filter(|(_, text)| text.contains(&needle))
            .map(|(path, _)| path.display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "spawn git through tugcore::git_command(): {offenders:?}"
        );
    }

    /// The argument spellings whose output is a set of **paths**.
    ///
    /// `--porcelain` is on the list conditionally: under `status` it is a path
    /// listing, so it counts only when `"status"` is spelled in the same
    /// argument list. Under `worktree list` the one path a record carries is a
    /// **directory Tug resolved** — a worktree it sited itself, or the repo
    /// root — read to be compared against a path Tug already holds, never read
    /// back out of a tree and handed to git as a pathspec. Git prints it
    /// unquoted whatever bytes it holds; only a newline in a directory's name
    /// would spoil the line split, and `-z` is the answer if one ever does.
    const LISTING_ARGS: [&str; 6] = [
        "--porcelain",
        "--name-only",
        "--name-status",
        "--numstat",
        "ls-files",
        "ls-tree",
    ];

    /// The calls that take an argument list and hand back git's **raw** text:
    /// the two `Command` builders, and `tugchanges_core`'s two line-oriented
    /// escapes. Every other call that takes an argument slice — `listing`,
    /// `read_paths`, `read_numstat`, `read_name_status`, `read_status`,
    /// `read_file_stats` and the async wrappers over them — appends `-z` and
    /// splits on NUL, which is the whole of [B01].
    const RAW_SINKS: [&str; 5] = [
        "git_command(",
        "git_stdout(",
        "git_output(",
        ".args(",
        ".arg(",
    ];

    /// The sites that spell a listing flag beside a raw read and are **not**
    /// reading paths out of it. The flag alone cannot tell a listing from a
    /// non-listing use, so the ones that are not are named here with why.
    ///
    /// - `resolve.rs` asks for `diff --numstat --patch` in one subprocess and
    ///   parses the numstat line for its two COUNTS; the path it is about is
    ///   the operand it passed in, and the patch body supplies the rest. No
    ///   path is read back, so there is nothing for `-z` to protect.
    const NOT_A_LISTING: [(&str, &str); 1] = [("tugarc-core/src/resolve.rs", "--numstat")];

    /// Split a source into one fragment per function body.
    ///
    /// The function is the scope a binding is tracked in, so that a `numstat`
    /// in one function cannot be confused with a `numstat` in another. A
    /// fragment runs from one `fn` declaration to the next, which can only
    /// ever over-read: a nested `fn` closes its parent's fragment early and
    /// the tail lands in the next one. Both are misses, never false alarms.
    fn function_fragments(code: &str) -> Vec<String> {
        let is_declaration = |line: &str| {
            let trimmed = line.trim_start();
            let Some(before) = trimmed.split("fn ").next() else {
                return false;
            };
            trimmed.contains("fn ")
                && before.split_whitespace().all(|word| {
                    matches!(word, "pub" | "async" | "const" | "unsafe" | "extern")
                        || word.starts_with("pub(")
                })
        };
        let mut fragments: Vec<String> = Vec::new();
        let mut current: Vec<&str> = Vec::new();
        for line in code.lines() {
            if is_declaration(line) && !current.is_empty() {
                fragments.push(current.join("\n"));
                current.clear();
            }
            current.push(line);
        }
        if !current.is_empty() {
            fragments.push(current.join("\n"));
        }
        fragments
    }

    /// The name a statement binds or extends an argument list under, when the
    /// statement is one of the four shapes an argument list is assembled in:
    /// `let name = …`, `name.push(…)`, `name.extend…(…)`, `name.insert(…)`.
    ///
    /// This is what lets the guard see a listing whose flag and whose raw read
    /// are in different statements — the shape that hid
    /// `preflight.rs::diff_stats`, a live `--numstat` read outside the door,
    /// for the whole of this arc. Assembling an argument list across
    /// statements is the ordinary way to write a *scoped* listing, so a rule
    /// that only saw the one-liner saw the easy half.
    fn assembled_name(statement: &str) -> Option<String> {
        let ident = |text: &str| -> Option<String> {
            let name: String = text
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            (!name.is_empty()).then_some(name)
        };
        if let Some(rest) = statement.trim_start().strip_prefix("let ") {
            return ident(rest.trim_start().strip_prefix("mut ").unwrap_or(rest));
        }
        for call in [".push(", ".extend", ".insert("] {
            if let Some(at) = statement.find(call) {
                let head = &statement[..at];
                let start = head
                    .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .map_or(0, |i| i + 1);
                return ident(&head[start..]);
            }
        }
        None
    }

    /// No production source reads a path set out of git as raw text [B02].
    ///
    /// The guard reads the argument list where it is spelled, beside the call
    /// that spawns or that returns raw text — which is the shape a new ad-hoc
    /// listing arrives in. `#[cfg(test)]` modules are exempt, for no reason of
    /// this rule's own: `production_sources` cuts them, and following
    /// `no_ad_hoc_git_spawns` exactly is worth more than a second definition
    /// of "production source" that could drift from it.
    #[test]
    fn no_listing_read_outside_the_door() {
        let mut offenders: Vec<String> = Vec::new();
        for (path, text) in crate::source_scan::production_sources() {
            let shown = path.display().to_string();
            // The door itself, and this file, which names every needle.
            if shown.ends_with("tugchanges-core/src/git.rs")
                || shown.ends_with("tugcore/src/git_cmd.rs")
            {
                continue;
            }
            let code = text
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for fragment in function_fragments(&code) {
                // Which argument lists this function has put a listing flag
                // into, by the name each is assembled under.
                let mut carrying: Vec<(String, &str)> = Vec::new();
                for statement in fragment.split([';', '{', '}']) {
                    let mut flags: Vec<&str> = Vec::new();
                    for arg in LISTING_ARGS {
                        if !statement.contains(&format!("\"{arg}")) {
                            continue;
                        }
                        if arg == "--porcelain" && !statement.contains("\"status\"") {
                            continue;
                        }
                        if NOT_A_LISTING
                            .iter()
                            .any(|(file, flag)| shown.ends_with(file) && *flag == arg)
                        {
                            continue;
                        }
                        flags.push(arg);
                    }
                    if let Some(name) = assembled_name(statement) {
                        for arg in &flags {
                            carrying.push((name.clone(), arg));
                        }
                    }
                    if !RAW_SINKS.iter().any(|sink| statement.contains(sink)) {
                        continue;
                    }
                    // A flag spelled at the sink, and a flag the sink's
                    // argument list was given in an earlier statement.
                    for arg in flags {
                        offenders.push(format!("{shown}: {arg}"));
                    }
                    for (name, arg) in &carrying {
                        if statement.contains(&format!("&{name}")) {
                            offenders.push(format!("{shown}: {arg}"));
                        }
                    }
                }
            }
        }
        offenders.sort();
        offenders.dedup();
        assert!(
            offenders.is_empty(),
            "read these through tugchanges_core's -z door, never as raw git text: {offenders:?}"
        );
    }
}
