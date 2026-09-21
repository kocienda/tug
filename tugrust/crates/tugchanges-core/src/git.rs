//! Canonical git shelling + pure parsers.
//!
//! One place to shell git (`git_stdout`/`git_output`, sync `std::process`
//! with `-C <dir>`), one **`-z` door** through which every path listing is
//! read ([`listing`] and the typed readers over it), and one parser each for
//! the record formats those listings yield. Unified diff
//! ([`parse_unified_diff`]) is the one text format still read line by line,
//! because a patch has no `-z` spelling — its file names come from a listing
//! laid over it by [`parse_unified_diff_with`].
//!
//! These parsers are the canonical implementations tugcast's `feeds/git.rs`
//! delegates to ([P06]/[P08]) — the library owns the parsing, the feed plumbing
//! maps the results into the `tugcast_core` wire types. Keeping the raw
//! porcelain-v2 XY per entry (rather than pre-splitting into staged/unstaged)
//! lets both consumers reconstruct exactly what they need: the `changes` query
//! wants the two-char v1 code per path, tugcast wants the staged/unstaged split.

use std::collections::HashMap;
use std::path::Path;
use std::process::Output;

use serde::Serialize;

// ---------------------------------------------------------------------------
// git shell helpers (sync)
// ---------------------------------------------------------------------------

/// Run `git -C <dir> <args…>` and return the raw [`Output`]. Errors only on a
/// spawn failure (git missing / not executable); a non-zero exit is a
/// successful spawn the caller inspects.
pub fn git_output(dir: &Path, args: &[&str]) -> Result<Output, String> {
    tugcore::git_command()
        // Hunk identity ([P06]) assumes both readers diff at one context
        // width. `diff.context` is machine config and satisfies that;
        // GIT_DIFF_OPTS is per-process environment and does not — a profile
        // shell and a launchd app would diff differently, and it even
        // overrides an explicit `-U<n>`. Scrubbed on every git run so no
        // future diff spelling reintroduces the skew.
        .env_remove("GIT_DIFF_OPTS")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("failed to execute git: {e}"))
}

/// Resolve the repo root for `dir` via `git -C <dir> rev-parse --show-toplevel`,
/// falling back to `dir` itself when it isn't a git working tree (then the
/// status map is empty and everything reads as non-dirty).
///
/// This runs from the project dir, so it returns the worktree the session edits
/// in — the correct root for the `changes` join. `tugtool_core`'s
/// `find_repo_root` is deliberately NOT used: it starts from cwd (can't honor
/// `--project`) and resolves a linked worktree back to the main repo ([P08]).
pub fn repo_root_for(dir: &Path) -> std::path::PathBuf {
    match git_output(dir, &["rev-parse", "--show-toplevel"]) {
        Ok(out) if out.status.success() => {
            let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if root.is_empty() {
                dir.to_path_buf()
            } else {
                std::path::PathBuf::from(root)
            }
        }
        _ => dir.to_path_buf(),
    }
}

/// Run `git -C <dir> <args…>`, returning stdout (verbatim, not trimmed) on a
/// zero exit, or git's trimmed stderr as the error on a non-zero exit. Callers
/// that want a single line trim the result themselves.
pub fn git_stdout(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_output(dir, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {args:?} failed")
        } else {
            stderr
        })
    }
}

// ---------------------------------------------------------------------------
// The `-z` path-listing door [B01]
// ---------------------------------------------------------------------------
//
// Git has two spellings for every listing it prints. The line-oriented one is
// a *display* form: a path holding a non-ASCII byte, a `"`, a `\`, a tab or a
// newline comes back wrapped in double quotes with its bytes escaped, so `ł`
// (UTF-8 `C5 82`) reads as `\305\202`. The `-z` one is the path's real bytes,
// NUL-terminated, with no quoting to undo.
//
// Everything below reads the second. Nothing anywhere unquotes the first,
// because with the door there is never anything quoted to unquote — that is
// the whole of [B01], and it is why the remedy is one function family rather
// than an unquoter called at ninety call sites.
//
// `core.quotepath=false` was the partial cure that never spread. It un-quotes
// a non-ASCII name and leaves a `"`, a tab and a newline quoted, so it makes
// the common case pass and turns the rest into a rarer, harder-to-find version
// of the same bug. `-z` is total, and the door supersedes it.
//
// It was also reached for as a *parity* device, and the door supersedes that
// use too: a commit read twice — once for a summary's file list, once for the
// rows that list expands into — has to spell a path the same both times, or
// the two reads describe different files. `core.quotepath=false` bought that
// parity only for the names it un-quotes, so a path holding a `"` or a tab
// still spelled itself two ways across two reads that both set it. Reading
// both through this door makes them the same bytes by construction, which is
// parity that holds for every name rather than for most of them.

/// Why a listing read failed.
///
/// The two cases are not interchangeable, and that is the whole reason this is
/// a type rather than a string. `Git` is the ordinary failure a caller may
/// reasonably swallow — a directory that is not a repo reads as nothing dirty,
/// which is how several callers want it. `Undecodable` is [B06]: git named a
/// real file whose bytes are not UTF-8, and a caller that swallows *that* has
/// silently dropped a file from a listing it is about to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListingError {
    /// Git exited non-zero, or could not be run. Carries its stderr.
    Git(String),
    /// Git reported a path that is not valid UTF-8, rendered lossily here for
    /// diagnosis only — the real bytes are deliberately not turned into a
    /// `String`, because that is the substitution this refuses to make.
    Undecodable { lossy: String },
}

impl ListingError {
    /// Whether this is [B06]'s refusal rather than an ordinary git failure.
    pub fn is_undecodable(&self) -> bool {
        matches!(self, ListingError::Undecodable { .. })
    }
}

impl std::fmt::Display for ListingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ListingError::Git(detail) => write!(f, "{detail}"),
            ListingError::Undecodable { lossy } => write!(
                f,
                "git reported a path that is not valid UTF-8: {lossy:?}. Tug reads paths as text \
                 and will not guess at one it cannot decode, because a guessed path names a \
                 different file."
            ),
        }
    }
}

/// Place `-z` in `args`, **before** a `--` separator when there is one.
///
/// After `--` a flag is not a flag: it is a pathspec, and git would go looking
/// for a file literally named `-z`. Every listing that scopes itself to
/// operands carries that separator, so the position is load-bearing rather
/// than tidiness.
///
/// An `args` that already spells `-z` is left alone. A few commands — `git
/// merge-tree` above all — will not take the flag after their revision
/// operands, so their caller places it and this adds nothing.
fn with_z(args: &[&str]) -> Vec<String> {
    if args.contains(&"-z") {
        return args.iter().map(|s| (*s).to_owned()).collect();
    }
    let cut = args.iter().position(|a| *a == "--").unwrap_or(args.len());
    let mut out: Vec<String> = args[..cut].iter().map(|s| (*s).to_owned()).collect();
    out.push("-z".to_owned());
    out.extend(args[cut..].iter().map(|s| (*s).to_owned()));
    out
}

/// Split a git `-z` payload into its records.
///
/// Records are NUL-*terminated*, so the trailing empty piece after the final
/// NUL is dropped; an empty payload is no records at all.
///
/// An **interior** empty record is kept, because it can be meaningful: `git
/// merge-tree -z` separates its conflicted-path list from its informational
/// records with exactly one. Dropping every empty would splice the two halves
/// together with nothing to notice.
///
/// A record that is not valid UTF-8 is an **error**, never a lossy
/// substitution ([B06]). `String::from_utf8_lossy` turns an undecodable byte
/// into U+FFFD, and a path with a U+FFFD in it is a different, nonexistent
/// path — the same failure shape this door exists to remove, arriving by a
/// quieter route.
pub fn nul_records(stdout: &[u8]) -> Result<Vec<String>, ListingError> {
    let mut out = Vec::new();
    for record in stdout.split(|b| *b == 0) {
        match std::str::from_utf8(record) {
            Ok(s) => out.push(s.to_owned()),
            Err(_) => {
                return Err(ListingError::Undecodable {
                    lossy: String::from_utf8_lossy(record).into_owned(),
                });
            }
        }
    }
    // The terminator's own empty tail, and nothing else.
    if out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    Ok(out)
}

/// **The door.** Run a git listing with `-z` and hand back its records, each
/// one the bytes git actually holds.
///
/// Every path Tug reads from git comes through here or through one of the
/// typed readers below it. A listing spelled any other way is a path Tug may
/// hand back to git as a pathspec that matches nothing.
pub fn listing(dir: &Path, args: &[&str]) -> Result<Vec<String>, ListingError> {
    let (records, status) = listing_with_status(dir, args)?;
    if !status.success() {
        return Err(ListingError::Git(format!("git {args:?} failed")));
    }
    Ok(records)
}

/// The door, for the one listing whose **non-zero exit is the answer** rather
/// than a failure: `git merge-tree --write-tree` exits 1 to say "conflicts",
/// and its conflicted paths are what the caller came for.
///
/// Returns the records and git's exit status. Git's stderr is not consulted,
/// because the caller reads the status itself.
pub fn listing_with_status(
    dir: &Path,
    args: &[&str],
) -> Result<(Vec<String>, std::process::ExitStatus), ListingError> {
    let owned = with_z(args);
    let borrowed: Vec<&str> = owned.iter().map(String::as_str).collect();
    let output = git_output(dir, &borrowed).map_err(ListingError::Git)?;
    let status = output.status;
    if !status.success() {
        // Carry git's own words when it has any, so an ordinary failure still
        // reports what git said.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(ListingError::Git(stderr));
        }
    }
    Ok((nul_records(&output.stdout)?, status))
}

/// Read a bare path listing — `diff --name-only`, `ls-files`, `ls-tree
/// --name-only`, `show --name-only`. One record is one path.
///
/// Empty records are dropped here: a path listing has none, and a caller that
/// wants git's own blank separator reaches for [`listing`] directly.
pub fn read_paths(dir: &Path, args: &[&str]) -> Result<Vec<String>, ListingError> {
    Ok(listing(dir, args)?
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect())
}

/// Read `git status --porcelain=v2 <extra…>` into a [`StatusReport`].
///
/// The command is fixed here rather than passed in, because there is exactly
/// one status spelling Tug parses and a second one would be a second parser.
/// `extra` carries the caller's own flags (`--branch`, `--untracked-files=all`,
/// a `--` and its operands).
pub fn read_status(dir: &Path, extra: &[&str]) -> Result<StatusReport, ListingError> {
    read_status_from(dir, &[], extra)
}

/// [`read_status`], with git's own **top-level** flags in front of the
/// subcommand.
///
/// A handful of them — `--no-optional-locks` above all — are only legal
/// before the subcommand word, so they cannot ride `extra`. `pre` is that
/// position, and it is a separate parameter rather than a convention about
/// `extra`'s first elements because the two lists go to different places in
/// the argv and a caller that confused them would get a usage error rather
/// than a wrong answer.
pub fn read_status_from(
    dir: &Path,
    pre: &[&str],
    extra: &[&str],
) -> Result<StatusReport, ListingError> {
    let mut args = pre.to_vec();
    args.extend_from_slice(&["status", "--porcelain=v2"]);
    args.extend_from_slice(extra);
    Ok(parse_status_records(&listing(dir, &args)?))
}

/// Read a `--name-status` listing into a destination-path → status-word map.
pub fn read_name_status(
    dir: &Path,
    args: &[&str],
) -> Result<HashMap<String, String>, ListingError> {
    Ok(parse_name_status_records(&listing(dir, args)?))
}

/// Read a `--numstat` listing into [`NumstatEntry`]s.
pub fn read_numstat(dir: &Path, args: &[&str]) -> Result<Vec<NumstatEntry>, ListingError> {
    Ok(parse_numstat_records(&listing(dir, args)?))
}

/// Read a `--name-status` listing's rename and copy rows as `(source,
/// destination)` pairs.
///
/// [`read_name_status`] keys on the destination alone, which is what a status
/// word wants; a caller staging a rename needs both halves, since staging the
/// destination without the source commits half a rename.
pub fn read_rename_pairs(dir: &Path, args: &[&str]) -> Result<Vec<(String, String)>, ListingError> {
    let records = listing(dir, args)?;
    let mut pairs = Vec::new();
    let mut i = 0;
    while i < records.len() {
        let Some(letter) = records[i].chars().next() else {
            i += 1;
            continue;
        };
        i += 1;
        if letter == 'R' || letter == 'C' {
            if let (Some(source), Some(destination)) = (records.get(i), records.get(i + 1)) {
                if letter == 'R' {
                    pairs.push((source.clone(), destination.clone()));
                }
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    Ok(pairs)
}

/// Join a `--numstat` and a `--name-status` read of the same range into
/// per-file [`FileStat`]s — the door's form of [`file_stats`].
pub fn read_file_stats(
    dir: &Path,
    numstat_args: &[&str],
    name_status_args: &[&str],
) -> Result<Vec<FileStat>, ListingError> {
    let status_by_path = read_name_status(dir, name_status_args)?;
    Ok(read_numstat(dir, numstat_args)?
        .into_iter()
        .map(|e| FileStat {
            status: status_by_path
                .get(&e.path)
                .cloned()
                .unwrap_or_else(|| "modified".to_owned()),
            path: e.path,
            added: e.added,
            deleted: e.deleted,
        })
        .collect())
}

/// Parse `git status --porcelain=v2 -z` records into a [`StatusReport`].
///
/// The shapes, as git emits them (measured, not inferred):
///
/// - `# branch.oid <sha>`, `# branch.head <name>`, `# branch.ab +N -M` — one
///   header per record.
/// - `1 XY sub mH mI mW hH hI <path>` — an ordinary change; the path is the
///   ninth space-separated field and runs to the end of the record.
/// - `2 XY sub mH mI mW hH hI Xscore <new>` — a rename or copy, **and the
///   original path is the record that follows**. This is the one shape that is
///   not merely a de-quoting of the line form: without `-z` the two paths share
///   a line separated by a tab, which is unreadable the moment a path contains
///   a tab.
/// - `u XY …  <path>` — unmerged, one path, ignored here as it is in the line
///   form.
/// - `? <path>` — untracked.
pub fn parse_status_records(records: &[String]) -> StatusReport {
    let mut report = StatusReport::default();
    let mut i = 0;
    while i < records.len() {
        let record = &records[i];
        i += 1;

        if record.is_empty() {
            continue;
        } else if let Some(rest) = record.strip_prefix("# branch.oid ") {
            report.head_sha = if rest == "(initial)" {
                String::new()
            } else {
                rest.to_owned()
            };
        } else if let Some(rest) = record.strip_prefix("# branch.head ") {
            report.branch = rest.to_owned();
        } else if let Some(rest) = record.strip_prefix("# branch.ab ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                report.ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                report.behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if record.starts_with("1 ") {
            let parts: Vec<&str> = record.splitn(9, ' ').collect();
            if parts.len() >= 9 && parts[1].len() >= 2 && !parts[8].is_empty() {
                report.entries.push(StatusEntry {
                    path: parts[8].to_owned(),
                    xy: parts[1].to_owned(),
                    orig_path: None,
                    renamed: false,
                });
            }
        } else if record.starts_with("2 ") {
            let parts: Vec<&str> = record.splitn(10, ' ').collect();
            if parts.len() >= 10 && parts[1].len() >= 2 && !parts[9].is_empty() {
                // The original path is its own record, and consuming it is
                // what keeps it from being read as the next entry.
                let orig_path = records.get(i).cloned();
                if orig_path.is_some() {
                    i += 1;
                }
                report.entries.push(StatusEntry {
                    path: parts[9].to_owned(),
                    xy: parts[1].to_owned(),
                    orig_path,
                    renamed: true,
                });
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            report.untracked.push(path.to_owned());
        }
        // `u ` (unmerged) and any other `# ` header are ignored.
    }
    report
}

/// Parse `--name-status -z` records into a destination-path → status-word map.
///
/// The status letter is its own record and the path (or, for a rename or copy,
/// the two paths in `old`, `new` order) follows it: `M`, `plain.txt`; `R079`,
/// `old`, `new`. The score rides the letter with no separator, which is why the
/// letter is taken as the record's first character rather than by splitting.
pub fn parse_name_status_records(records: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < records.len() {
        let Some(letter) = records[i].chars().next() else {
            i += 1;
            continue;
        };
        i += 1;
        let path = if letter == 'R' || letter == 'C' {
            let dest = records.get(i + 1);
            i += 2;
            dest
        } else {
            let dest = records.get(i);
            i += 1;
            dest
        };
        let Some(path) = path else { break };
        let word = match letter {
            'A' => "created",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "created",
            _ => "modified",
        };
        map.insert(path.clone(), word.to_owned());
    }
    map
}

/// Parse `--numstat -z` records into [`NumstatEntry`]s.
///
/// A plain row is one record, `<added>\t<deleted>\t<path>`. A rename leaves the
/// path field **empty** and follows with two records, `old` then `new` — so the
/// `old => new` and `pre{old => new}post` spellings the line form compacts
/// renames into do not occur here, and nothing has to take them apart.
pub fn parse_numstat_records(records: &[String]) -> Vec<NumstatEntry> {
    let mut entries = Vec::new();
    let mut i = 0;
    while i < records.len() {
        let record = &records[i];
        i += 1;
        let mut fields = record.splitn(3, '\t');
        let (Some(a), Some(d), Some(path_field)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let added = if a == "-" { None } else { a.parse().ok() };
        let deleted = if d == "-" { None } else { d.parse().ok() };

        let (path, old_path) = if path_field.is_empty() {
            let (Some(old), Some(new)) = (records.get(i), records.get(i + 1)) else {
                break;
            };
            i += 2;
            (new.clone(), Some(old.clone()))
        } else {
            (path_field.to_owned(), None)
        };

        entries.push(NumstatEntry {
            path,
            old_path,
            added,
            deleted,
        });
    }
    entries
}

// ---------------------------------------------------------------------------
// git status --porcelain=v2
// ---------------------------------------------------------------------------

/// One changed (tracked) entry from `git status --porcelain=v2`. `xy` is the
/// two-char porcelain-v2 code verbatim (`.` marks an unchanged side, e.g.
/// `".M"`, `"M."`, `"MM"`, `"R."`); `orig_path` and `renamed` come from a `2 `
/// rename/copy entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub xy: String,
    pub orig_path: Option<String>,
    pub renamed: bool,
}

/// The parsed `git status --porcelain=v2 [--branch]` result. Tracked changes
/// live in `entries` (raw XY preserved); untracked paths in `untracked`;
/// branch/ahead/behind/head from the `# branch.*` header lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct StatusReport {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub head_sha: String,
    pub entries: Vec<StatusEntry>,
    pub untracked: Vec<String>,
}

impl StatusReport {
    /// Build the repo-relative path → two-char porcelain-v1 status map the
    /// `changes` query joins against (`.` positions rendered as spaces,
    /// untracked as `"??"`). This is the projection the ported `changes` query's
    /// `git_status_map` produced.
    pub fn v1_status_map(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for entry in &self.entries {
            if !entry.path.is_empty() {
                map.insert(entry.path.clone(), normalize_xy(&entry.xy));
            }
        }
        for path in &self.untracked {
            map.insert(path.clone(), "??".to_owned());
        }
        map
    }
}

/// Render a porcelain-v2 `XY` (which uses `.` for an unchanged position) as
/// the porcelain-v1 two-char code (`.` → space).
pub fn normalize_xy(xy: &str) -> String {
    xy.chars().map(|c| if c == '.' { ' ' } else { c }).collect()
}

// ---------------------------------------------------------------------------
// unified diff
// ---------------------------------------------------------------------------

/// The kind of change a diffed file underwent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One file's slice of a combined `git diff`: its status, new/old paths, added
/// and removed line counts, a binary flag, and the verbatim unified chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: DiffFileStatus,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
    pub unified: String,
}

/// Split combined `git diff` output into one [`DiffFile`] per file.
///
/// Files are delimited by `diff --git ` header lines (git emits exactly one per
/// file pair, including pure renames and binary files). Each file's `unified`
/// text is its chunk verbatim; status, paths, and `+`/`-` counts are derived
/// per [`parse_diff_chunk`].
///
/// **The paths this derives are git's display form**, and there is no `-z`
/// spelling of a patch to read instead: the `diff --git a/… b/…` and `+++ b/…`
/// headers are the only place a patch names a file, and git quotes them the
/// same way it quotes any listing. So a caller that needs real paths takes
/// them from a listing and lays them over the text with
/// [`parse_unified_diff_with`] — the patch is then read for its hunks alone,
/// which is all it was ever the authority on. No unquoter exists here or
/// anywhere, which is the whole of [B01].
pub fn parse_unified_diff(output: &str) -> Vec<DiffFile> {
    let mut files = Vec::new();
    let mut chunk: Option<Vec<&str>> = None;
    for line in output.lines() {
        if line.starts_with("diff --git ") {
            if let Some(lines) = chunk.take() {
                files.push(parse_diff_chunk(&lines));
            }
            chunk = Some(vec![line]);
        } else if let Some(lines) = chunk.as_mut() {
            lines.push(line);
        }
        // Lines before the first `diff --git` (none for plain `git diff`) are
        // ignored — there is no chunk to attach them to.
    }
    if let Some(lines) = chunk.take() {
        files.push(parse_diff_chunk(&lines));
    }
    files
}

/// [`parse_unified_diff`], with the file names taken from a `-z` listing of
/// the **same** diff rather than from the patch's own headers.
///
/// Paired by **position**, because git emits the patch and the listing in one
/// order: the nth chunk and the nth entry are the same file. That is exact,
/// and it is the only join available — a join by name would have to match the
/// quoted header against the real path, which is the unquoting this arc exists
/// to avoid writing.
///
/// A chunk with no entry facing it keeps the path the text parse derived. That
/// is the honest fallback rather than a silent drop: the two can only disagree
/// if the caller listed a different diff from the one it patched, and a file
/// that vanishes from a snapshot is harder to notice than one whose name is
/// spelled the old way.
///
/// Only `path` and `old_path` move. Status, counts, the binary flag and the
/// verbatim `unified` text stay the patch's, so no hunk id can move —
/// `hunk_id` hashes the hunk body, and the headers it does not hash are the
/// only thing that differs between the two spellings.
pub fn parse_unified_diff_with(output: &str, listed: &[NumstatEntry]) -> Vec<DiffFile> {
    let mut files = parse_unified_diff(output);
    for (file, entry) in files.iter_mut().zip(listed) {
        file.path = entry.path.clone();
        if file.status == DiffFileStatus::Renamed {
            file.old_path = entry.old_path.clone();
        }
    }
    files
}

/// Strip git's `a/` or `b/` path prefix (after a `--- `/`+++ ` marker).
fn strip_ab_prefix(s: &str) -> &str {
    s.strip_prefix("a/")
        .or_else(|| s.strip_prefix("b/"))
        .unwrap_or(s)
}

/// Parse the new-side path out of a `diff --git a/<old> b/<new>` header, the
/// only path source for a binary file (no `---`/`+++` lines). Best-effort for
/// paths without spaces — the common case; renames and text files take the more
/// precise `rename to` / `+++ b/` paths instead.
fn path_from_diff_header(header: &str) -> Option<String> {
    let rest = header.strip_prefix("diff --git ")?;
    let idx = rest.rfind(" b/")?;
    Some(rest[idx + 3..].to_string())
}

/// Derive one file's [`DiffFile`] from its chunk lines (the first line is the
/// `diff --git` header). Status comes from git's metadata markers; paths from
/// the `rename to`/`+++ b/`/`--- a/` lines (falling back to the header);
/// `added`/`removed` from the `+`/`-` hunk-body lines.
fn parse_diff_chunk(lines: &[&str]) -> DiffFile {
    let header = lines.first().copied().unwrap_or("");
    let mut status = DiffFileStatus::Modified;
    let mut rename_from: Option<String> = None;
    let mut rename_to: Option<String> = None;
    let mut plus_path: Option<String> = None;
    let mut minus_path: Option<String> = None;
    let mut binary = false;
    let mut added = 0u32;
    let mut removed = 0u32;
    let mut in_hunk = false;

    for &line in lines.iter().skip(1) {
        if line.starts_with("new file mode") {
            status = DiffFileStatus::Added;
        } else if line.starts_with("deleted file mode") {
            status = DiffFileStatus::Deleted;
        } else if let Some(p) = line.strip_prefix("rename from ") {
            status = DiffFileStatus::Renamed;
            rename_from = Some(p.to_string());
        } else if let Some(p) = line.strip_prefix("rename to ") {
            status = DiffFileStatus::Renamed;
            rename_to = Some(p.to_string());
        } else if line.starts_with("Binary files ") {
            binary = true;
        } else if let Some(p) = line.strip_prefix("--- ") {
            if p != "/dev/null" {
                minus_path = Some(strip_ab_prefix(p).to_string());
            }
        } else if let Some(p) = line.strip_prefix("+++ ") {
            if p != "/dev/null" {
                plus_path = Some(strip_ab_prefix(p).to_string());
            }
        } else if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && line.starts_with('+') {
            added += 1;
        } else if in_hunk && line.starts_with('-') {
            removed += 1;
        }
    }

    let (path, old_path) = if status == DiffFileStatus::Renamed {
        (
            rename_to.or_else(|| plus_path.clone()).unwrap_or_default(),
            rename_from.or_else(|| minus_path.clone()),
        )
    } else {
        (
            plus_path
                .or(minus_path)
                .or_else(|| path_from_diff_header(header))
                .unwrap_or_default(),
            None,
        )
    };

    let unified = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };

    DiffFile {
        path,
        old_path,
        status,
        added,
        removed,
        binary,
        unified,
    }
}

// ---------------------------------------------------------------------------
// numstat (`git show/diff --numstat`)
// ---------------------------------------------------------------------------

/// One `N\tM\tpath` numstat row. `added`/`deleted` are `None` for a binary file
/// (git renders `-`); `old_path` is set when the row is a rename (`old => new`
/// or the `pre{old => new}post` brace form).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NumstatEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

// ---------------------------------------------------------------------------
// per-file stats (numstat ∩ name-status)
// ---------------------------------------------------------------------------

/// One file's commit/diff stats (`{path, status, added, deleted}`) — the shape
/// both the commit receipt (Spec S03) and the diff report (Spec S04) emit.
/// `status` ∈ `created|modified|deleted|renamed`; `added`/`deleted` are `None`
/// for a binary file (numstat `-`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileStat {
    pub path: String,
    pub status: String,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

#[cfg(test)]
mod tests {
    /// The shared runner's git declines optional locks — read back through
    /// git itself, whose `!` alias runs in the environment git was given.
    #[test]
    fn the_runner_spawns_git_without_optional_locks() {
        let out = super::git_output(
            std::path::Path::new("."),
            &[
                "-c",
                "alias.lockenv=!printenv GIT_OPTIONAL_LOCKS",
                "lockenv",
            ],
        )
        .expect("git runs");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0");
    }

    use super::*;

    #[test]
    fn normalize_xy_renders_dots_as_spaces() {
        assert_eq!(normalize_xy(".M"), " M");
        assert_eq!(normalize_xy("M."), "M ");
        assert_eq!(normalize_xy("MM"), "MM");
    }

    const MODIFIED: &str = "\
diff --git a/src/main.rs b/src/main.rs
index 1234567..89abcde 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
+    println!(\"added\");
 }
";

    const ADDED: &str = "\
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line one
+line two
";

    const DELETED: &str = "\
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-bye one
-bye two
";

    const RENAMED_EDITED: &str = "\
diff --git a/a.txt b/b.txt
similarity index 80%
rename from a.txt
rename to b.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/b.txt
@@ -1,2 +1,2 @@
 keep
-old line
+new line
";

    const BINARY: &str = "\
diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
";

    #[test]
    fn unified_diff_parses_all_statuses_and_counts() {
        let combined = format!("{MODIFIED}{ADDED}{DELETED}{RENAMED_EDITED}{BINARY}");
        let files = parse_unified_diff(&combined);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            ["src/main.rs", "new.txt", "gone.txt", "b.txt", "img.png"]
        );

        assert_eq!(files[0].status, DiffFileStatus::Modified);
        assert_eq!(files[0].added, 2);
        assert_eq!(files[0].removed, 1);
        assert!(files[0].unified.starts_with("diff --git a/src/main.rs"));

        assert_eq!(files[1].status, DiffFileStatus::Added);
        assert_eq!(files[1].added, 2);

        assert_eq!(files[2].status, DiffFileStatus::Deleted);
        assert_eq!(files[2].path, "gone.txt");
        assert_eq!(files[2].removed, 2);

        assert_eq!(files[3].status, DiffFileStatus::Renamed);
        assert_eq!(files[3].path, "b.txt");
        assert_eq!(files[3].old_path.as_deref(), Some("a.txt"));

        assert_eq!(files[4].status, DiffFileStatus::Modified);
        assert!(files[4].binary);
        assert_eq!(files[4].path, "img.png");
    }

    #[test]
    fn unified_diff_empty_is_empty() {
        assert!(parse_unified_diff("").is_empty());
    }

    // -----------------------------------------------------------------------
    // The hostile-filename fixture [B05]
    // -----------------------------------------------------------------------

    // -- The `-z` door [B01] -------------------------------------------------

    /// Build a `-z` payload from records, NUL-*terminated* as git writes it.
    fn payload(records: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for r in records {
            out.extend_from_slice(r.as_bytes());
            out.push(0);
        }
        out
    }

    /// `-z` goes before a `--`, because after one it is a pathspec and git
    /// would look for a file named `-z`.
    #[test]
    fn the_z_flag_lands_before_the_pathspec_separator() {
        assert_eq!(
            with_z(&["status", "--porcelain=v2"]),
            ["status", "--porcelain=v2", "-z"]
        );
        assert_eq!(
            with_z(&["diff", "--name-only", "HEAD", "--", "a.txt", "b.txt"]),
            ["diff", "--name-only", "HEAD", "-z", "--", "a.txt", "b.txt"]
        );
        // A leading `--` still gets the flag ahead of it.
        assert_eq!(
            with_z(&["ls-files", "--", "*.jpg"]),
            ["ls-files", "-z", "--", "*.jpg"]
        );
    }

    /// Records are NUL-terminated, so the trailing empty piece is not a record;
    /// an empty payload is no records at all.
    #[test]
    fn nul_records_drops_the_terminator_and_reads_the_bytes_verbatim() {
        assert!(nul_records(b"").unwrap().is_empty());
        assert_eq!(
            nul_records(&payload(&[
                "01_Stanisław.jpg",
                "tab\tx.txt",
                "two\nlines.txt"
            ]))
            .unwrap(),
            ["01_Stanisław.jpg", "tab\tx.txt", "two\nlines.txt"]
        );
        // An interior empty record survives — `merge-tree -z` separates its
        // conflicted paths from its messages with one, and a listing that
        // dropped it would splice the two halves together.
        assert_eq!(
            nul_records(&payload(&["a.txt", "", "note"])).unwrap(),
            ["a.txt", "", "note"]
        );
    }

    /// An undecodable name is refused, not lossily renamed ([B06]). U+FFFD in
    /// a path is a different, nonexistent path.
    #[test]
    fn a_non_utf8_record_is_refused_rather_than_replaced() {
        let mut bytes = b"good.txt\0bad-".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(b".txt\0");
        let err = nul_records(&bytes).unwrap_err();
        assert!(err.is_undecodable(), "{err}");
        assert!(err.to_string().contains("not valid UTF-8"), "{err}");
        // The type is what callers branch on: an ordinary git failure is one a
        // caller may swallow, and this one is not.
        assert!(!ListingError::Git("no such repo".into()).is_undecodable());
    }

    /// Status records, including the `-z` rename shape: the original path is
    /// its own record after the `2 ` entry, not a tab-separated tail.
    #[test]
    fn status_records_read_headers_entries_renames_and_untracked() {
        let report = parse_status_records(
            &payload(&[
                "# branch.oid 0a09ccb8",
                "# branch.head main",
                "# branch.ab +2 -1",
                "2 R. N... 100644 100644 100644 f384549c b2f931a6 R79 neł.txt",
                "olł.txt",
                "1 M. N... 100644 100644 100644 587be6b4 975fbec8 plain name.txt",
                "u UU N... 100644 100644 100644 100644 df967b96 ba2906d0 2299c379 cł.txt",
                "? two\nlines.txt",
                "? *.jpg",
            ])
            .split(|b| *b == 0)
            .filter(|r| !r.is_empty())
            .map(|r| String::from_utf8(r.to_vec()).unwrap())
            .collect::<Vec<_>>(),
        );

        assert_eq!(report.head_sha, "0a09ccb8");
        assert_eq!(report.branch, "main");
        assert_eq!((report.ahead, report.behind), (2, 1));
        assert_eq!(report.untracked, ["two\nlines.txt", "*.jpg"]);
        assert_eq!(
            report.entries,
            [
                StatusEntry {
                    path: "neł.txt".to_owned(),
                    xy: "R.".to_owned(),
                    orig_path: Some("olł.txt".to_owned()),
                    renamed: true,
                },
                StatusEntry {
                    path: "plain name.txt".to_owned(),
                    xy: "M.".to_owned(),
                    orig_path: None,
                    renamed: false,
                },
            ]
        );
    }

    /// The status map keys by the real name, which is what the `changes` join
    /// and the commit's operand list are both built from.
    #[test]
    fn status_records_map_by_the_real_name() {
        let records: Vec<String> = ["? 01_Stanisław.jpg", "? quo\"te.txt"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let map = parse_status_records(&records).v1_status_map();
        assert_eq!(map.get("01_Stanisław.jpg").map(String::as_str), Some("??"));
        assert_eq!(map.get("quo\"te.txt").map(String::as_str), Some("??"));
    }

    /// Name-status records: the letter is its own record, the score rides the
    /// letter, and a rename's two paths arrive in `old`, `new` order.
    #[test]
    fn name_status_records_key_renames_on_the_destination() {
        let records: Vec<String> = [
            "R079",
            "olł.txt",
            "neł.txt",
            "M",
            "plain name.txt",
            "A",
            "tab\tx.txt",
            "D",
            "gone.txt",
            "C100",
            "src.txt",
            "copy.txt",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let map = parse_name_status_records(&records);

        assert_eq!(map.get("neł.txt").map(String::as_str), Some("renamed"));
        assert!(
            !map.contains_key("olł.txt"),
            "keyed on the destination only"
        );
        assert_eq!(
            map.get("plain name.txt").map(String::as_str),
            Some("modified")
        );
        assert_eq!(map.get("tab\tx.txt").map(String::as_str), Some("created"));
        assert_eq!(map.get("gone.txt").map(String::as_str), Some("deleted"));
        assert_eq!(map.get("copy.txt").map(String::as_str), Some("created"));
        assert_eq!(map.len(), 5);
    }

    /// Numstat records: a rename leaves the path field empty and follows with
    /// `old`, `new`, so the `old => new` and `pre{old => new}post` spellings
    /// never occur and nothing has to take them apart.
    #[test]
    fn numstat_records_read_counts_renames_and_binaries() {
        let records: Vec<String> = [
            "1\t0\t",
            "olł.txt",
            "neł.txt",
            "3\t2\tplain name.txt",
            "-\t-\t01_Stanisław.jpg",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();

        assert_eq!(
            parse_numstat_records(&records),
            [
                NumstatEntry {
                    path: "neł.txt".to_owned(),
                    old_path: Some("olł.txt".to_owned()),
                    added: Some(1),
                    deleted: Some(0),
                },
                NumstatEntry {
                    path: "plain name.txt".to_owned(),
                    old_path: None,
                    added: Some(3),
                    deleted: Some(2),
                },
                NumstatEntry {
                    path: "01_Stanisław.jpg".to_owned(),
                    old_path: None,
                    added: None,
                    deleted: None,
                },
            ]
        );
    }

    /// The door, against a real repo: every hostile name comes back as itself,
    /// through the status read and through a bare path listing alike.
    #[test]
    fn the_door_reads_every_hostile_name_as_the_file_itself() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        tugcore::hostile_repo::seed_hostile_repo(root).expect("the fixture seeds");

        let mut want: Vec<String> = tugcore::hostile_repo::HOSTILE_NAMES
            .iter()
            .map(|n| {
                if n.path == "No\u{301}tes.txt" {
                    "N\u{f3}tes.txt".to_owned()
                } else {
                    n.path.to_owned()
                }
            })
            .collect();
        want.sort();

        let mut untracked = read_status(root, &["--branch"]).unwrap().untracked;
        untracked.sort();
        assert_eq!(untracked, want, "the status read names every file");

        let mut listed = read_paths(root, &["ls-files", "--others", "--exclude-standard"]).unwrap();
        listed.sort();
        assert_eq!(listed, want, "the path listing names every file");

        // And the names it hands back are names git accepts back as operands —
        // the round trip the whole door exists for.
        let operands: Vec<&str> = untracked.iter().map(String::as_str).collect();
        let mut args = vec!["ls-files", "--others", "--exclude-standard", "--"];
        args.extend_from_slice(&operands);
        let mut back = read_paths(root, &args).unwrap();
        back.sort();
        assert_eq!(back, want, "every name resolved as a pathspec");
    }

    /// The door reads a rename's two paths from a real repo, which is the shape
    /// the line form cannot express once a path holds a tab.
    #[test]
    fn the_door_reads_a_hostile_rename_from_a_real_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        tugcore::hostile_repo::seed_hostile_repo(root).expect("the fixture seeds");
        tugcore::hostile_repo::commit_hostile_files(root, "add them").expect("committed");

        let old = "tab\tx.txt";
        let new = "renamed\ttab.txt";
        std::fs::rename(root.join(old), root.join(new)).unwrap();
        let status = read_status(root, &["--branch"]).unwrap();
        // Unstaged, so git reports a deletion and an untracked file rather than
        // a rename; staging is what makes it one.
        assert!(status.entries.iter().any(|e| e.path == old));

        let staged = git_output(root, &["add", "-A"]).unwrap();
        assert!(staged.status.success());
        let report = read_status(root, &["--branch"]).unwrap();
        let entry = report
            .entries
            .iter()
            .find(|e| e.renamed)
            .expect("a rename entry");
        assert_eq!(entry.path, new);
        assert_eq!(entry.orig_path.as_deref(), Some(old));

        let stats = read_file_stats(
            root,
            &["diff", "--cached", "--numstat"],
            &["diff", "--cached", "--name-status"],
        )
        .unwrap();
        let renamed = stats.iter().find(|s| s.path == new).expect("the new path");
        assert_eq!(renamed.status, "renamed");
    }

    // The line-oriented status, numstat and name-status parsers are gone, and
    // their shape tests with them. They were kept only until the tugcast feeds
    // moved off them; once nothing read a display format, leaving a parser for
    // one in the door's own file was leaving the next reader the shape this
    // arc exists to remove, within copying distance of the door.
    //
    // The hostile-name assertion once written against the status parser went
    // the same way and earlier: it asked a display format to stop being one,
    // which it structurally cannot. The claim lives in
    // `the_door_reads_every_hostile_name_as_the_file_itself` instead, through
    // the door that actually carries it.
}
