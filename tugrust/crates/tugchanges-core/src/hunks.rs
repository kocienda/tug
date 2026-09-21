//! Hunk parsing, content identity, and filtered-patch construction.
//!
//! One file's unified diff splits into hunks; each hunk gets an id that is a
//! hash of its body lines alone. The `@@` header is excluded from the hash, so
//! an unrelated hunk changing size does not move this hunk's id, while any
//! change to the hunk's own content does. That is exactly the drift the
//! landing path must refuse: an election made against content that has since
//! moved.
//!
//! Identity is computed here and nowhere else — the deck receives ids over the
//! wire and never re-derives them, so the checkbox, the draft election, and the
//! commit filter cannot disagree.
//!
//! # The id-agreement contract
//!
//! Two independent readers run `git diff` and hash the result: the **wire**
//! (`tugcast::feeds::git`, async, serving the ids the deck's checkboxes are
//! keyed by) and the **engine** ([`file_hunks`] below, sync, filtering the
//! patch the landing stages). They cannot share a function — one runs git
//! through tokio, the other through `std::process` — so what they share is the
//! argument list and the parse. Where that drifts, every election drifts with
//! it.
//!
//! - Both MUST carry every flag in [`HUNK_DIFF_FLAGS`]. `--no-ext-diff` is not
//!   a nicety: an external diff driver (`diff.external`, or a `*.diff=driver`
//!   gitattribute) emits text that is not a unified diff at all.
//! - Neither may pass `-U<n>`. Context width is inherited from the machine's
//!   `diff.context`, so the two sides agree with each other by construction —
//!   which is the only agreement the contract needs. Pinning `-U3` would also
//!   silently override what the diff card renders for anyone who set it.
//! - Both MUST scrub `GIT_DIFF_OPTS` from the environment. It is per-process,
//!   not per-machine — a profile shell and a launchd app inherit different
//!   values — and it overrides even an explicit `-U<n>`, so leaving it in
//!   place breaks the shared-config premise above. (`diff.context = 0` is
//!   honored; the landing side passes `--unidiff-zero` when a patch's hunks
//!   carry no context.)
//!
//! Three differences between the two spellings are allowed, because none can
//! move an id:
//!
//! - `-c core.quotepath=false` (wire only) changes header path spelling, never
//!   body lines, and the header is not hashed.
//! - `-M` (wire only) changes how a *rename* is presented, and a rename never
//!   carries an election: an unstaged rename surfaces as Deleted-plus-Added, a
//!   created file gets no ids, and a staged rename means a dirty index, which
//!   the partial landing refuses.
//! - `HEAD` (wire) vs. the index (engine) as base are equal whenever the index
//!   is clean, which the partial landing already requires.
//!
//! The agreement is verified by a test that crosses the boundary — it lives on
//! the tugcast side, which depends on this crate rather than the reverse.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::git;

/// The flags every `git diff` whose output feeds hunk identity must carry.
///
/// Spliced into both the async wire spelling and the sync engine spelling; see
/// the module doc for the contract they uphold, and note the deliberate
/// absence of `-U<n>`.
pub const HUNK_DIFF_FLAGS: &[&str] = &["--no-color", "--no-ext-diff"];

/// One hunk of a single file's unified diff.
///
/// `body` is the hunk's lines verbatim (every `-`/`+`/context line and any
/// `\ No newline at end of file` marker), newline-joined with a trailing
/// newline. The `@@` header is not part of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub id: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub body: String,
}

/// Why a filtered patch could not be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HunkDrift {
    /// Selected ids that are absent from the file's current hunks.
    Missing(Vec<String>),
    /// The selection matched no hunk at all — there is nothing to stage.
    EmptySelection,
}

impl fmt::Display for HunkDrift {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HunkDrift::Missing(ids) => write!(f, "unknown hunk ids: {}", ids.join(", ")),
            HunkDrift::EmptySelection => write!(f, "no hunks selected"),
        }
    }
}

impl std::error::Error for HunkDrift {}

/// The id of a hunk with the given body: the first 16 hex characters of the
/// body's SHA-256.
///
/// Callers use the ids on [`Hunk`] rather than this directly; it is public so a
/// test or a receipt-side computation can reproduce an identity from body text.
pub fn hunk_id(body: &str) -> String {
    content_hash(body)
}

/// The identity of a piece of content: the first 16 hex characters of its
/// SHA-256.
///
/// One rule for every content identity this system compares — a hunk body
/// ([`hunk_id`]) and a span anchor's written text ([P11]) — so evidence
/// minted on one side is comparable on the other without a second convention.
pub fn content_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The engine-side diff of one working-tree file against the index, run with
/// the canonical [`HUNK_DIFF_FLAGS`], returned with its hunks already parsed.
///
/// One function so the spelling is single-sourced, and one git run so the text
/// a caller builds a patch header from and the hunks it filters by are the
/// same read. A path with no changes yields empty text and no hunks.
pub fn file_diff_hunks(repo_root: &Path, path: &str) -> Result<(String, Vec<Hunk>), String> {
    let mut args: Vec<&str> = vec!["diff"];
    args.extend_from_slice(HUNK_DIFF_FLAGS);
    args.extend_from_slice(&["--", path]);
    let diff = git::git_stdout(repo_root, &args)?;
    let hunks = parse_hunks(&diff);
    Ok((diff, hunks))
}

/// One working-tree file's current hunks — the engine's half of the
/// id-agreement contract in this module's doc.
pub fn file_hunks(repo_root: &Path, path: &str) -> Result<Vec<Hunk>, String> {
    file_diff_hunks(repo_root, path).map(|(_, hunks)| hunks)
}

/// Split one file's unified diff into its hunks.
///
/// Input is what `git diff --no-color -- <path>` emits for a single file:
/// the `diff --git` header, mode/index lines, `---`/`+++` lines, then `@@`
/// hunks. Lines before the first `@@` are skipped. A hunk's extent is taken
/// from its header counts, so trailing non-diff text cannot bleed into a body.
///
/// Two hunks with identical bodies within one file are disambiguated by an
/// ordinal suffix on the second and later occurrences (`<hash>#2`).
pub fn parse_hunks(unified_diff_for_one_file: &str) -> Vec<Hunk> {
    let lines: Vec<&str> = unified_diff_for_one_file.lines().collect();
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        let Some(header) = parse_hunk_header(lines[i]) else {
            i += 1;
            continue;
        };
        i += 1;

        let mut body_lines: Vec<&str> = Vec::new();
        let mut old_seen = 0u32;
        let mut new_seen = 0u32;
        while i < lines.len() && (old_seen < header.old_lines || new_seen < header.new_lines) {
            let line = lines[i];
            match line.as_bytes().first() {
                Some(b'-') => old_seen += 1,
                Some(b'+') => new_seen += 1,
                Some(b'\\') => {}
                // A context line is " <text>"; git emits a bare empty line for
                // an empty context line in some tooling paths, so both count.
                Some(b' ') | None => {
                    old_seen += 1;
                    new_seen += 1;
                }
                // Anything else ends the hunk early (a malformed or truncated
                // diff) — keep what we have rather than swallowing the rest.
                _ => break,
            }
            body_lines.push(line);
            i += 1;
        }
        // A "\ No newline at end of file" marker trails the line it qualifies
        // and counts toward neither side, so it can sit past the counts.
        while i < lines.len() && lines[i].starts_with('\\') {
            body_lines.push(lines[i]);
            i += 1;
        }

        let body = if body_lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", body_lines.join("\n"))
        };
        hunks.push(Hunk {
            id: hunk_id(&body),
            old_start: header.old_start,
            old_lines: header.old_lines,
            new_start: header.new_start,
            new_lines: header.new_lines,
            body,
        });
    }

    disambiguate(&mut hunks);
    hunks
}

/// Suffix repeated ids with their ordinal so every id within one file is unique.
fn disambiguate(hunks: &mut [Hunk]) {
    let mut seen: HashMap<String, u32> = HashMap::new();
    for hunk in hunks.iter_mut() {
        let count = seen.entry(hunk.id.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            hunk.id = format!("{}#{}", hunk.id, count);
        }
    }
}

struct HunkHeader {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
}

/// Parse `@@ -<old_start>[,<old_lines>] +<new_start>[,<new_lines>] @@[ heading]`.
fn parse_hunk_header(line: &str) -> Option<HunkHeader> {
    let rest = line.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let mut ranges = rest[..end].split(' ');
    let old = ranges.next()?.strip_prefix('-')?;
    let new = ranges.next()?.strip_prefix('+')?;
    if ranges.next().is_some() {
        return None;
    }
    let (old_start, old_lines) = parse_range(old)?;
    let (new_start, new_lines) = parse_range(new)?;
    Some(HunkHeader {
        old_start,
        old_lines,
        new_start,
        new_lines,
    })
}

/// Parse `<start>` (count 1 implied) or `<start>,<count>`.
fn parse_range(s: &str) -> Option<(u32, u32)> {
    match s.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

/// Build a unified diff carrying only the selected hunks.
///
/// `file_header` is the text preceding the first `@@` of the file's diff (the
/// `diff --git`, mode/index, and `---`/`+++` lines) — emitted verbatim so the
/// patch names the same file git named. Old-side offsets are untouched: the
/// patch applies to the index content, which the excluded hunks have not
/// altered. New-side starts are recomputed by the cumulative size delta of the
/// *included* preceding hunks so the result is well-formed without leaning on
/// `git apply --recount`.
///
/// Any selected id absent from `hunks` is drift — the caller refuses rather
/// than staging an approximation.
pub fn filtered_patch(
    file_header: &str,
    hunks: &[Hunk],
    selected: &BTreeSet<String>,
) -> Result<String, HunkDrift> {
    let available: BTreeSet<&str> = hunks.iter().map(|h| h.id.as_str()).collect();
    let missing: Vec<String> = selected
        .iter()
        .filter(|id| !available.contains(id.as_str()))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(HunkDrift::Missing(missing));
    }
    if selected.is_empty() {
        return Err(HunkDrift::EmptySelection);
    }

    let mut out = String::new();
    out.push_str(file_header);
    if !file_header.is_empty() && !file_header.ends_with('\n') {
        out.push('\n');
    }

    let mut delta: i64 = 0;
    for hunk in hunks {
        if !selected.contains(&hunk.id) {
            continue;
        }
        let new_start = (hunk.old_start as i64 + delta).max(0) as u32;
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, new_start, hunk.new_lines
        ));
        out.push_str(&hunk.body);
        delta += hunk.new_lines as i64 - hunk.old_lines as i64;
    }

    Ok(out)
}

/// The text of a file's diff preceding its first hunk — the header
/// [`filtered_patch`] needs. Returns the whole input when it has no `@@` line.
pub fn file_header(unified_diff_for_one_file: &str) -> String {
    let mut out = String::new();
    for line in unified_diff_for_one_file.lines() {
        if line.starts_with("@@ ") {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREE_HUNKS: &str = "\
diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,4 @@
 alpha
+added-one
 bravo
 charlie
@@ -10,3 +11,3 @@
 kilo
-lima
+LIMA
 mike
@@ -20,3 +21,2 @@
 tango
-uniform
 victor
";

    fn ids(diff: &str) -> Vec<String> {
        parse_hunks(diff).into_iter().map(|h| h.id).collect()
    }

    #[test]
    fn parses_three_hunks_with_ranges() {
        let hunks = parse_hunks(THREE_HUNKS);
        assert_eq!(hunks.len(), 3);
        assert_eq!(
            (hunks[0].old_start, hunks[0].old_lines),
            (1, 3),
            "first hunk old range"
        );
        assert_eq!((hunks[0].new_start, hunks[0].new_lines), (1, 4));
        assert_eq!((hunks[1].old_start, hunks[1].new_start), (10, 11));
        assert_eq!(hunks[2].body, " tango\n-uniform\n victor\n");
    }

    #[test]
    fn id_survives_other_hunks_shifting_line_numbers() {
        // The same three bodies with every `@@` number moved.
        let shifted = THREE_HUNKS
            .replace("@@ -1,3 +1,4 @@", "@@ -101,3 +140,4 @@")
            .replace("@@ -10,3 +11,3 @@", "@@ -210,3 +311,3 @@")
            .replace("@@ -20,3 +21,2 @@", "@@ -320,3 +420,2 @@");
        assert_eq!(ids(THREE_HUNKS), ids(&shifted));
    }

    #[test]
    fn id_changes_when_the_body_changes() {
        let edited = THREE_HUNKS.replace("+added-one", "+added-ONE");
        let before = ids(THREE_HUNKS);
        let after = ids(&edited);
        assert_ne!(before[0], after[0], "edited hunk gets a new id");
        assert_eq!(before[1], after[1], "untouched hunks keep theirs");
        assert_eq!(before[2], after[2]);
    }

    #[test]
    fn duplicate_bodies_get_ordinal_suffixes() {
        let diff = "\
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,3 @@
 same
+dup
@@ -20,2 +21,3 @@
 same
+dup
@@ -40,2 +42,3 @@
 same
+dup
";
        let hunks = parse_hunks(diff);
        assert_eq!(hunks.len(), 3);
        assert!(!hunks[0].id.contains('#'));
        assert_eq!(hunks[1].id, format!("{}#2", hunks[0].id));
        assert_eq!(hunks[2].id, format!("{}#3", hunks[0].id));
    }

    #[test]
    fn no_newline_marker_rides_its_hunk_without_counting() {
        let diff = "\
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 alpha
-bravo
\\ No newline at end of file
+BRAVO
\\ No newline at end of file
@@ -10,1 +10,2 @@
 kilo
+lima
";
        let hunks = parse_hunks(diff);
        assert_eq!(hunks.len(), 2, "the marker did not swallow the next hunk");
        assert!(hunks[0].body.contains("\\ No newline at end of file"));
        assert_eq!(hunks[1].body, " kilo\n+lima\n");

        let selected: BTreeSet<String> = [hunks[0].id.clone()].into_iter().collect();
        let patch = filtered_patch("--- a/f.txt\n+++ b/f.txt\n", &hunks, &selected).unwrap();
        assert_eq!(patch.matches("\\ No newline at end of file").count(), 2);
    }

    #[test]
    fn filtered_patch_of_one_middle_hunk() {
        let hunks = parse_hunks(THREE_HUNKS);
        let selected: BTreeSet<String> = [hunks[1].id.clone()].into_iter().collect();
        let patch = filtered_patch(&file_header(THREE_HUNKS), &hunks, &selected).unwrap();
        assert!(patch.contains("--- a/f.txt"));
        assert!(patch.contains("+LIMA"));
        assert!(!patch.contains("+added-one"));
        // No preceding hunk is included, so the new side starts where the old
        // side does.
        assert!(patch.contains("@@ -10,3 +10,3 @@"), "patch was: {patch}");
    }

    #[test]
    fn filtered_patch_recomputes_offsets_across_included_hunks() {
        let hunks = parse_hunks(THREE_HUNKS);
        let selected: BTreeSet<String> = [hunks[0].id.clone(), hunks[2].id.clone()]
            .into_iter()
            .collect();
        let patch = filtered_patch(&file_header(THREE_HUNKS), &hunks, &selected).unwrap();
        // Hunk 1 adds a line, so hunk 3's new side sits one below its old side.
        assert!(patch.contains("@@ -1,3 +1,4 @@"), "patch was: {patch}");
        assert!(patch.contains("@@ -20,3 +21,2 @@"), "patch was: {patch}");
        assert!(!patch.contains("+LIMA"));
    }

    #[test]
    fn filtered_patch_of_all_hunks_keeps_original_offsets() {
        let hunks = parse_hunks(THREE_HUNKS);
        let selected: BTreeSet<String> = hunks.iter().map(|h| h.id.clone()).collect();
        let patch = filtered_patch(&file_header(THREE_HUNKS), &hunks, &selected).unwrap();
        assert!(patch.contains("@@ -1,3 +1,4 @@"));
        assert!(patch.contains("@@ -10,3 +11,3 @@"));
        assert!(patch.contains("@@ -20,3 +21,2 @@"), "patch was: {patch}");
    }

    #[test]
    fn filtered_patch_refuses_empty_and_unknown_selections() {
        let hunks = parse_hunks(THREE_HUNKS);
        assert_eq!(
            filtered_patch("", &hunks, &BTreeSet::new()),
            Err(HunkDrift::EmptySelection)
        );
        let bogus: BTreeSet<String> = ["deadbeefdeadbeef".to_string()].into_iter().collect();
        assert_eq!(
            filtered_patch("", &hunks, &bogus),
            Err(HunkDrift::Missing(vec!["deadbeefdeadbeef".to_string()]))
        );
    }

    #[test]
    fn file_header_stops_at_the_first_hunk() {
        assert_eq!(
            file_header(THREE_HUNKS),
            "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n"
        );
    }

    #[test]
    fn git_applies_a_filtered_patch_to_the_index() {
        use std::io::Write;
        use std::path::Path;
        use std::process::Stdio;

        fn git(root: &Path, args: &[&str]) -> String {
            let out = tugcore::git_command()
                .args(args)
                .current_dir(root)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@t.test"]);
        git(root, &["config", "user.name", "t"]);

        // 60 numbered lines with edits far enough apart that git's context
        // regions do not merge them into one hunk.
        let original: String = (1..=60).map(|n| format!("line{n}\n")).collect();
        std::fs::write(root.join("f.txt"), &original).unwrap();
        git(root, &["add", "f.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);

        let edited = original
            .replace("line2\n", "line2\nINSERTED-A\n")
            .replace("line30\n", "CHANGED-B\n")
            .replace("line58\n", "");
        std::fs::write(root.join("f.txt"), &edited).unwrap();

        let diff = git(
            root,
            &["diff", "--no-color", "--no-ext-diff", "--", "f.txt"],
        );
        let hunks = parse_hunks(&diff);
        assert_eq!(hunks.len(), 3, "diff was: {diff}");

        let selected: BTreeSet<String> = [hunks[1].id.clone()].into_iter().collect();
        let patch = filtered_patch(&file_header(&diff), &hunks, &selected).unwrap();

        let mut child = tugcore::git_command()
            .args(["apply", "--cached", "-"])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("git apply");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(patch.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "git apply --cached failed: {}\npatch was:\n{patch}",
            String::from_utf8_lossy(&out.stderr)
        );

        let staged = git(root, &["diff", "--cached", "--no-color"]);
        assert!(staged.contains("+CHANGED-B"), "staged was: {staged}");
        assert!(staged.contains("-line30"));
        assert!(!staged.contains("INSERTED-A"), "staged was: {staged}");
        assert!(!staged.contains("-line58"), "staged was: {staged}");

        // The working tree still carries all three edits.
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), edited);
    }
}
