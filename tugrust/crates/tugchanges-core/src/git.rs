//! Canonical git shelling + pure parsers.
//!
//! One place to shell git (`git_stdout`/`git_output`, sync `std::process`
//! with `-C <dir>`) and one parser each for the three git text formats this
//! program reads: `git status --porcelain=v2` ([`parse_status_porcelain_v2`]),
//! unified diff ([`parse_unified_diff`]), and `--numstat` ([`parse_numstat`]).
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

/// Parse `git status --porcelain=v2 [--branch]` output into a [`StatusReport`].
///
/// Ordinary changed entries (`1 XY …`) and rename/copy entries (`2 XY … <new>\t<orig>`)
/// become [`StatusEntry`]s with the raw XY preserved; `? path` lines are
/// untracked; `# branch.*` lines fill branch/ahead/behind/head. Unmerged
/// (`u `) and other lines are ignored.
pub fn parse_status_porcelain_v2(output: &str) -> StatusReport {
    let mut report = StatusReport::default();

    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            report.head_sha = if rest == "(initial)" {
                String::new()
            } else {
                rest.to_string()
            };
        } else if let Some(rest) = line.strip_prefix("# branch.head ") {
            report.branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                report.ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                report.behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if line.starts_with("1 ") {
            // Ordinary changed entry: 1 XY sub mH mI mW hH hI path
            let parts: Vec<&str> = line.splitn(9, ' ').collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                let path = parts[8];
                if xy.len() >= 2 && !path.is_empty() {
                    report.entries.push(StatusEntry {
                        path: path.to_string(),
                        xy: xy.to_string(),
                        orig_path: None,
                        renamed: false,
                    });
                }
            }
        } else if line.starts_with("2 ") {
            // Renamed/copied entry: 2 XY sub mH mI mW hH hI Xscore new\torig
            let parts: Vec<&str> = line.splitn(10, ' ').collect();
            if parts.len() >= 10 {
                let xy = parts[1];
                let path_field = parts[9];
                let mut tab_parts = path_field.split('\t');
                let new_path = tab_parts.next().unwrap_or(path_field);
                let orig_path = tab_parts.next().map(str::to_string);
                if xy.len() >= 2 && !new_path.is_empty() {
                    report.entries.push(StatusEntry {
                        path: new_path.to_string(),
                        xy: xy.to_string(),
                        orig_path,
                        renamed: true,
                    });
                }
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            report.untracked.push(path.to_string());
        }
        // `u ` (unmerged) and other `# ` lines are ignored.
    }

    report
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

/// Parse `--numstat` output (`<added>\t<deleted>\t<path>` per line) into
/// [`NumstatEntry`]s. A `-` count means a binary file (`None`); a `path`
/// containing ` => ` is a rename whose new/old paths are recovered.
pub fn parse_numstat(output: &str) -> Vec<NumstatEntry> {
    let mut entries = Vec::new();
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(raw_path)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let added = if a == "-" { None } else { a.parse().ok() };
        let deleted = if d == "-" { None } else { d.parse().ok() };
        let (path, old_path) = split_numstat_path(raw_path);
        entries.push(NumstatEntry {
            path,
            old_path,
            added,
            deleted,
        });
    }
    entries
}

/// Recover `(new_path, old_path)` from a numstat path field. Renames render as
/// either `old => new` or `pre{old => new}post` (git compacts the common
/// prefix/suffix into braces); a non-rename path passes through with `None`.
fn split_numstat_path(raw: &str) -> (String, Option<String>) {
    if !raw.contains(" => ") {
        return (raw.to_string(), None);
    }
    if let (Some(open), Some(close)) = (raw.find('{'), raw.find('}')) {
        if open < close {
            let pre = &raw[..open];
            let inner = &raw[open + 1..close];
            let post = &raw[close + 1..];
            if let Some((old_mid, new_mid)) = inner.split_once(" => ") {
                let old_path = format!("{pre}{old_mid}{post}");
                let new_path = format!("{pre}{new_mid}{post}");
                return (new_path, Some(old_path));
            }
        }
    }
    if let Some((old, new)) = raw.split_once(" => ") {
        return (new.to_string(), Some(old.to_string()));
    }
    (raw.to_string(), None)
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

/// Parse `git show/diff --name-status` into a new-path → status-word map
/// (`A`→created, `M`→modified, `D`→deleted, `R`→renamed, `C`→created). Rename
/// and copy lines key on the destination path.
pub fn parse_name_status(output: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.split('\t');
        let Some(status) = fields.next() else {
            continue;
        };
        let Some(letter) = status.chars().next() else {
            continue;
        };
        // R/C carry a similarity score and an extra path column (old\tnew); the
        // destination is the second path.
        let path = if letter == 'R' || letter == 'C' {
            fields.nth(1)
        } else {
            fields.next()
        };
        let Some(path) = path else { continue };
        let word = match letter {
            'A' => "created",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "created",
            _ => "modified",
        };
        map.insert(path.to_string(), word.to_string());
    }
    map
}

/// Join `--numstat` and `--name-status` output into per-file [`FileStat`]s. The
/// numstat drives the file list and counts; the name-status supplies the status
/// word (defaulting to `modified` when a path is absent from it).
pub fn file_stats(numstat: &str, name_status: &str) -> Vec<FileStat> {
    let status_by_path = parse_name_status(name_status);
    parse_numstat(numstat)
        .into_iter()
        .map(|e| FileStat {
            status: status_by_path
                .get(&e.path)
                .cloned()
                .unwrap_or_else(|| "modified".to_string()),
            path: e.path,
            added: e.added,
            deleted: e.deleted,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    /// The shared runner's git declines optional locks — read back through
    /// git itself, whose `!` alias runs in the environment git was given.
    #[test]
    fn the_runner_spawns_git_without_optional_locks() {
        let out = super::git_output(
            std::path::Path::new("."),
            &["-c", "alias.lockenv=!printenv GIT_OPTIONAL_LOCKS", "lockenv"],
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

    #[test]
    fn porcelain_v2_parses_modified_untracked_renamed_staged() {
        let output = "\
# branch.oid abc123def456
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 hash1 hash2 src/main.rs
1 .M N... 100644 100644 100644 hash3 hash4 README.md
2 R. N... 100644 100644 100644 hash5 hash6 R100 new_name.rs\told_name.rs
? temp.txt
";
        let report = parse_status_porcelain_v2(output);
        assert_eq!(report.branch, "main");
        assert_eq!(report.ahead, 2);
        assert_eq!(report.behind, 1);
        assert_eq!(report.head_sha, "abc123def456");
        assert_eq!(report.untracked, vec!["temp.txt"]);
        assert_eq!(report.entries.len(), 3);

        let staged = &report.entries[0];
        assert_eq!(staged.path, "src/main.rs");
        assert_eq!(staged.xy, "M.");
        assert!(!staged.renamed);

        let unstaged = &report.entries[1];
        assert_eq!(unstaged.path, "README.md");
        assert_eq!(unstaged.xy, ".M");

        let renamed = &report.entries[2];
        assert_eq!(renamed.path, "new_name.rs");
        assert_eq!(renamed.orig_path.as_deref(), Some("old_name.rs"));
        assert!(renamed.renamed);

        // The v1 status map recombines XY per path (untracked → "??").
        let map = report.v1_status_map();
        assert_eq!(map.get("src/main.rs").unwrap(), "M ");
        assert_eq!(map.get("README.md").unwrap(), " M");
        assert_eq!(map.get("temp.txt").unwrap(), "??");
        assert_eq!(map.get("new_name.rs").unwrap(), "R ");
    }

    #[test]
    fn porcelain_v2_initial_head_is_empty() {
        let output = "# branch.oid (initial)\n# branch.head main\n";
        let report = parse_status_porcelain_v2(output);
        assert_eq!(report.head_sha, "");
        assert_eq!(report.branch, "main");
    }

    #[test]
    fn numstat_parses_binary_and_rename() {
        let output = "\
24\t6\tsrc/main.rs
-\t-\tassets/logo.png
3\t1\tsrc/{old => new}/mod.rs
0\t0\ttop_old.txt => top_new.txt
";
        let entries = parse_numstat(output);
        assert_eq!(entries.len(), 4);

        assert_eq!(entries[0].path, "src/main.rs");
        assert_eq!(entries[0].added, Some(24));
        assert_eq!(entries[0].deleted, Some(6));
        assert_eq!(entries[0].old_path, None);

        // Binary → both counts None.
        assert_eq!(entries[1].path, "assets/logo.png");
        assert_eq!(entries[1].added, None);
        assert_eq!(entries[1].deleted, None);

        // Brace-form rename.
        assert_eq!(entries[2].path, "src/new/mod.rs");
        assert_eq!(entries[2].old_path.as_deref(), Some("src/old/mod.rs"));
        assert_eq!(entries[2].added, Some(3));

        // Simple-form rename.
        assert_eq!(entries[3].path, "top_new.txt");
        assert_eq!(entries[3].old_path.as_deref(), Some("top_old.txt"));
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
}
