//! Whether a row a commit passed over is still evidence about the dirty file.
//!
//! A commit spends the content it absorbs, not the path. A partial commit —
//! a hunk election, a `git add -p` — leaves part of a file dirty, and the rows
//! that wrote that remainder are older than the commit that just touched the
//! path. Read by age alone they are spent, and the remainder falls out of
//! every session's changes. So a row behind the path's last commit is judged
//! by what became of its content, and it survives when two things are both
//! true of one of its anchors:
//!
//! 1. **It still places.** The anchor reaches a hunk of the current diff under
//!    the strict matchers — a line-hash match, a containment match on a single
//!    hunk, a `Hunk` id match — the reading [`crate::contention`] gives a dead
//!    owner, where evidence that fails to place contributes nothing.
//! 2. **No commit since the row took it.** Content a later commit added to the
//!    path is committed content. If the same text is in the diff again, it was
//!    put there by whoever re-added it, and the row that first wrote it has no
//!    claim on that edit.
//!
//! The second test is applied first, and per line: an anchor is *narrowed* to
//! the lines no later commit added, and what is left has to place. That is
//! what lets one edit that reached two hunks, one landed and one not, go on
//! claiming exactly the one still dirty — and it is why the answer is a list
//! of anchors rather than a yes or a no. A survivor that kept its landed lines
//! would carry evidence that can no longer place, and a live owner's
//! unplaceable evidence widens its claim to the whole file.
//!
//! What cannot be falsified cannot survive. A bare [`Anchor::Whole`] — a claim
//! row, an edit past the anchor cap, a legacy row, an unreadable span — and a
//! row with no spans at all record no content, so nothing can show that their
//! content outlived the commit. They stay spent, as every row behind the cut
//! once did.
//!
//! Two readers ask this (the sync engine and tugcast's async feed), so the
//! rule is one pure function, [`surviving_anchors`], and the two share the
//! `git log` argument list ([`path_history_args`]) and its parse
//! ([`PathHistory::parse`]) the way they share the hunk diff's.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use rusqlite::Connection;

use crate::anchors::{containment_probes, head_was_truncated, line_is_distinctive};
use crate::contention::{Anchor, HunkAdded, added_lines_matches, added_text, content_matches};
use crate::git;
use crate::hunks::{HUNK_DIFF_FLAGS, Hunk, content_hash, parse_hunks};
use crate::ledger;

/// The character that opens each commit's record in the history log: a line
/// holding it and the commit's time, then that commit's diff of the path. No
/// line of a unified diff can begin with it.
pub const COMMIT_RECORD_MARK: char = '\u{1e}';

/// The arguments of the `git log` that reads what the commits to `path` added
/// since `since_ms` (epoch ms), for [`PathHistory::parse`].
///
/// - `--first-parent -m` reads the branch's own line, with a merge shown as
///   what it brought in. A plain `git log -p` prints no diff for a merge, and
///   content that arrived by one would look as though no commit had added it.
/// - `--no-renames` shows a file renamed onto the path as added in full, which
///   is what happened to the path.
/// - `--since` is inclusive, and the row's time is rounded down to its second.
///   A commit in the row's own second therefore counts as after it, so a tie
///   breaks toward spent, as it does at the liveness cut.
/// - [`HUNK_DIFF_FLAGS`] keep an external diff driver from replacing the
///   unified diff. The caller scrubs `GIT_DIFF_OPTS`, as for every diff here.
pub fn path_history_args(path: &str, since_ms: i64) -> Vec<String> {
    let mut args: Vec<String> = ["log", "--first-parent", "-m", "-p", "--no-renames"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    args.extend(HUNK_DIFF_FLAGS.iter().map(|s| (*s).to_owned()));
    args.push("--format=%x1e%ct".to_owned());
    let since_secs = since_ms.div_euclid(1000);
    if since_secs > 0 {
        // The `@` spells a raw epoch time; a bare number is a date to git only
        // past nine digits.
        args.push(format!("--since=@{since_secs}"));
    }
    args.push("--".to_owned());
    args.push(path.to_owned());
    args
}

/// The sync reader's history of `path` since `since_ms` (epoch ms): one
/// `git log` over the path, parsed.
///
/// Gather it once per path, from the oldest row to be judged, and take each
/// row's own view with [`PathHistory::added_since`]. An `Err` means the
/// history could not be read, and a row whose history is unknown has not shown
/// that it survived: the caller reads it as spent.
pub fn path_history(repo_root: &Path, path: &str, since_ms: i64) -> Result<PathHistory, String> {
    let args = path_history_args(path, since_ms);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git::git_stdout(repo_root, &refs).map(|out| PathHistory::parse(&out))
}

/// What each commit to one path added, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PathHistory {
    commits: Vec<CommitAdded>,
}

/// One commit's added text, a string per hunk of its diff.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CommitAdded {
    secs: i64,
    texts: Vec<String>,
}

impl PathHistory {
    /// Parse the output of a `git log` run with [`path_history_args`].
    ///
    /// A record whose time cannot be read is dated after every row, so its
    /// content counts against all of them.
    pub fn parse(log_output: &str) -> PathHistory {
        let mut commits: Vec<CommitAdded> = Vec::new();
        let mut open: Option<(i64, String)> = None;
        for line in log_output.lines() {
            if let Some(stamp) = line.strip_prefix(COMMIT_RECORD_MARK) {
                if let Some((secs, diff)) = open.take() {
                    commits.push(CommitAdded::of(secs, &diff));
                }
                open = Some((stamp.trim().parse().unwrap_or(i64::MAX), String::new()));
            } else if let Some((_, diff)) = open.as_mut() {
                diff.push_str(line);
                diff.push('\n');
            }
        }
        if let Some((secs, diff)) = open {
            commits.push(CommitAdded::of(secs, &diff));
        }
        PathHistory { commits }
    }

    /// How many commits the history holds.
    pub fn len(&self) -> usize {
        self.commits.len()
    }

    /// Whether no commit touched the path in the window read.
    pub fn is_empty(&self) -> bool {
        self.commits.is_empty()
    }

    /// What the commits at or after a row's second added — the view one row is
    /// judged against. `row_at_ms` is the row's time in epoch ms.
    pub fn added_since(&self, row_at_ms: i64) -> CommittedAdded {
        let row_secs = row_at_ms.div_euclid(1000);
        let mut out = CommittedAdded::default();
        for commit in self.commits.iter().filter(|c| c.secs >= row_secs) {
            for text in &commit.texts {
                out.line_hashes.extend(text.lines().map(content_hash));
                out.texts.push(text.clone());
            }
        }
        out
    }
}

impl CommitAdded {
    fn of(secs: i64, diff: &str) -> CommitAdded {
        CommitAdded {
            secs,
            texts: parse_hunks(diff)
                .iter()
                .map(added_text)
                .filter(|text| !text.is_empty())
                .collect(),
        }
    }
}

/// The text commits added to a path after one row was written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommittedAdded {
    /// [`content_hash`] of every added line.
    line_hashes: BTreeSet<String>,
    /// The added text of each hunk of each commit, for the containment and
    /// legacy-content readings.
    texts: Vec<String>,
}

impl CommittedAdded {
    /// Whether no commit added anything.
    pub fn is_empty(&self) -> bool {
        self.texts.is_empty()
    }

    /// Whether a commit added this whole line, or a line containing it. The
    /// second half is for a probe that is a fragment of its line.
    fn holds(&self, line: &str) -> bool {
        self.line_hashes.contains(&content_hash(line))
            || self.texts.iter().any(|text| text.contains(line))
    }
}

/// The anchors of one row behind the liveness cut that survived the commits
/// since it: each still places in `hunks`, and each has been narrowed to
/// content no commit in `committed` added. An empty answer is a spent row.
///
/// `hunks` are the path's current hunks, `current_file_hash` the
/// [`content_hash`] of the working file's bytes (`None` when unreadable, which
/// proves nothing and so keeps no whole-file anchor whole), and `committed`
/// the row's own view of the path's history ([`PathHistory::added_since`]).
///
/// The answer replaces the row's anchors wherever its claim is read. A
/// [`Anchor::WholeFile`] whose bytes have moved on comes back as the
/// [`Anchor::AddedLines`] it degrades to, since a live owner's `WholeFile`
/// reads as the whole file whatever became of its lines.
pub fn surviving_anchors(
    anchors: &[Anchor],
    hunks: &[Hunk],
    current_file_hash: Option<&str>,
    committed: &CommittedAdded,
) -> Vec<Anchor> {
    let added: Vec<HunkAdded> = hunks.iter().map(HunkAdded::of).collect();
    let mut survivors: Vec<Anchor> = Vec::new();
    for anchor in anchors {
        match anchor {
            // Records no content, so nothing can show it outlived the commit.
            Anchor::Whole => {}
            Anchor::Hunk { id } => {
                let Some(hunk) = added.iter().find(|h| &h.id == id) else {
                    continue;
                };
                // An id is a hash of the hunk's body, so an id still present
                // is content still dirty — unless a commit since added every
                // distinctive line of it and the same body is back in the
                // diff, which is somebody's re-add.
                let mut distinctive = hunk
                    .text
                    .lines()
                    .filter(|line| line_is_distinctive(line))
                    .peekable();
                if distinctive.peek().is_some() && distinctive.all(|line| committed.holds(line)) {
                    continue;
                }
                survivors.push(anchor.clone());
            }
            Anchor::Content {
                new_hash,
                new_head,
                new_len,
            } => {
                let landed = committed
                    .texts
                    .iter()
                    .any(|text| content_matches(text, new_hash, new_head, *new_len));
                let places = added
                    .iter()
                    .any(|h| content_matches(&h.text, new_hash, new_head, *new_len));
                if !landed && places {
                    survivors.push(anchor.clone());
                }
            }
            Anchor::AddedLines {
                line_hashes,
                added_lines,
                added_head,
            } => {
                let Some((hashes, head)) = narrowed(line_hashes, added_head, committed) else {
                    if !added_lines_matches(&added, line_hashes, added_head).is_empty() {
                        survivors.push(anchor.clone());
                    }
                    continue;
                };
                if !added_lines_matches(&added, &hashes, &head).is_empty() {
                    survivors.push(Anchor::AddedLines {
                        line_hashes: hashes,
                        added_lines: *added_lines,
                        added_head: head,
                    });
                }
            }
            Anchor::WholeFile {
                file_hash,
                line_hashes,
                added_head,
            } => {
                let narrowing = narrowed(line_hashes, added_head, committed);
                let (hashes, head) = match &narrowing {
                    Some((hashes, head)) => (hashes.as_slice(), head.as_str()),
                    None => (line_hashes.as_slice(), added_head.as_str()),
                };
                if current_file_hash == Some(file_hash.as_str()) {
                    // The file is still byte for byte what this call wrote, so
                    // every hunk left in the diff is its own. It stays whole
                    // unless the commits since added all of it, in which case
                    // the bytes were put back by a later hand.
                    if !hashes.is_empty() || !head.is_empty() {
                        survivors.push(anchor.clone());
                    }
                } else if !added_lines_matches(&added, hashes, head).is_empty() {
                    survivors.push(Anchor::AddedLines {
                        line_hashes: hashes.to_vec(),
                        added_lines: line_hashes.len(),
                        added_head: head.to_owned(),
                    });
                }
            }
        }
    }
    survivors
}

/// The rows of one path behind its liveness cut whose content survived, by
/// `(session, tool_use_id)`.
#[derive(Debug, Default)]
pub(crate) struct Survivors {
    rows: HashMap<(String, String), Survivor>,
}

/// One surviving row: where it was recorded, and the anchors it kept.
#[derive(Debug)]
pub(crate) struct Survivor {
    pub project_dir: String,
    pub anchors: Vec<Anchor>,
}

impl Survivors {
    /// Whether the row `(session, tool_use_id)` survived.
    pub(crate) fn holds(&self, session: &str, tool_use_id: &str) -> bool {
        self.rows
            .contains_key(&(session.to_owned(), tool_use_id.to_owned()))
    }

    /// Whether any row `session` recorded from `project_dir` survived.
    pub(crate) fn holds_any(&self, session: &str, project_dir: &str) -> bool {
        self.rows
            .iter()
            .any(|((s, _), row)| s == session && row.project_dir == project_dir)
    }

    /// Every surviving row with the session that owns it.
    pub(crate) fn rows(&self) -> impl Iterator<Item = (&str, &Survivor)> {
        self.rows.iter().map(|((s, _), row)| (s.as_str(), row))
    }
}

/// The sync reader's survival read of one path: every proof row recorded under
/// `ledger_path` before `min_live_at_ms`, judged against the hunks of
/// `diff_path`. The two names differ only for a renamed file, whose rows sit
/// under the old name and whose dirt is under the new one.
///
/// The hunks are the working tree's against `HEAD`, since a commit is what
/// spent the rows: a remainder the user has staged is still uncommitted and
/// still its author's. Git is run only when a row behind the cut has spans,
/// and the history only when one of those rows places at all — a file's long
/// tail of spent rows, whose content is in `HEAD`, stops at the diff.
///
/// A diff or a history that cannot be read proves no row survived.
pub(crate) fn path_survivors(
    conn: &Connection,
    repo_root: &Path,
    ledger_path: &str,
    diff_path: &str,
    min_live_at_ms: i64,
) -> Result<Survivors, String> {
    struct Candidate {
        project_dir: String,
        at: i64,
        anchors: Vec<Anchor>,
    }
    let mut candidates: BTreeMap<(String, String), Candidate> = BTreeMap::new();
    if min_live_at_ms > 0 {
        for span in ledger::spans_for_path(conn, ledger_path)? {
            if span.at >= min_live_at_ms {
                continue;
            }
            candidates
                .entry((span.session, span.tool_use_id))
                .or_insert_with(|| Candidate {
                    project_dir: span.project_dir,
                    at: span.at,
                    anchors: Vec::new(),
                })
                .anchors
                .push(Anchor::from_span(&span.kind, &span.anchor));
        }
    }
    if candidates.is_empty() {
        return Ok(Survivors::default());
    }

    let mut args: Vec<&str> = vec!["diff"];
    args.extend_from_slice(HUNK_DIFF_FLAGS);
    args.extend_from_slice(&["HEAD", "--", diff_path]);
    let hunks = match git::git_stdout(repo_root, &args) {
        Ok(diff) => parse_hunks(&diff),
        Err(_) => Vec::new(),
    };
    if hunks.is_empty() {
        return Ok(Survivors::default());
    }
    let file_hash = std::fs::read_to_string(repo_root.join(diff_path))
        .ok()
        .map(|text| content_hash(&text));

    let nothing = CommittedAdded::default();
    candidates.retain(|_, c| {
        !surviving_anchors(&c.anchors, &hunks, file_hash.as_deref(), &nothing).is_empty()
    });
    let Some(oldest) = candidates.values().map(|c| c.at).min() else {
        return Ok(Survivors::default());
    };
    let Ok(history) = path_history(repo_root, ledger_path, oldest) else {
        return Ok(Survivors::default());
    };

    let mut rows = HashMap::new();
    for (key, candidate) in candidates {
        let anchors = surviving_anchors(
            &candidate.anchors,
            &hunks,
            file_hash.as_deref(),
            &history.added_since(candidate.at),
        );
        if !anchors.is_empty() {
            rows.insert(
                key,
                Survivor {
                    project_dir: candidate.project_dir,
                    anchors,
                },
            );
        }
    }
    Ok(Survivors { rows })
}

/// An added-lines anchor's evidence with everything a later commit added taken
/// out: the line hashes no commit holds, and a head rebuilt from the probe
/// lines no commit holds. `None` when the commits took nothing, so the caller
/// keeps the anchor as recorded.
///
/// The rebuilt head holds whole lines only — the tail the cap may have severed
/// is dropped here, as the matcher would have dropped it.
fn narrowed(
    line_hashes: &[String],
    added_head: &str,
    committed: &CommittedAdded,
) -> Option<(Vec<String>, String)> {
    let probes = containment_probes(added_head, head_was_truncated(added_head));
    let hashes: Vec<String> = line_hashes
        .iter()
        .filter(|hash| !committed.line_hashes.contains(*hash))
        .cloned()
        .collect();
    let kept: Vec<&str> = probes
        .iter()
        .copied()
        .filter(|probe| !committed.holds(probe))
        .collect();
    if hashes.len() == line_hashes.len() && kept.len() == probes.len() {
        return None;
    }
    Some((hashes, kept.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchors::{edit_anchor, whole_anchor};
    use crate::contention::{Claim, OwnerAnchors, classify_contention};
    use tugcore::test_fixtures::git::GitFixture;

    /// Three edits far enough apart to stay three hunks.
    const THREE_HUNKS: &str = "\
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,4 @@
 alpha
+alpha added line
 bravo
 charlie
@@ -20,3 +21,4 @@
 tango
+tango added line
 uniform
 victor
@@ -40,3 +42,4 @@
 xray
+xray added line
 yankee
 zulu
";

    /// The same file after the first hunk landed: two hunks left.
    const TWO_LEFT: &str = "\
--- a/f.txt
+++ b/f.txt
@@ -21,3 +21,4 @@
 tango
+tango added line
 uniform
 victor
@@ -41,3 +42,4 @@
 xray
+xray added line
 yankee
 zulu
";

    /// A history log as [`path_history_args`] has git print it: one commit at
    /// `secs` that added `lines` in one hunk.
    fn log_adding(secs: i64, lines: &[&str]) -> String {
        let mut out = format!(
            "{COMMIT_RECORD_MARK}{secs}\n\ndiff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,{} @@\n context\n",
            lines.len() + 1
        );
        for line in lines {
            out.push_str(&format!("+{line}\n"));
        }
        out
    }

    /// What one commit after the row added.
    fn committed(lines: &[&str]) -> CommittedAdded {
        PathHistory::parse(&log_adding(2_000, lines)).added_since(1_000_000)
    }

    /// An anchor built the way production builds one, through the writer and
    /// back out through the decoder.
    fn edit(new: &str) -> Anchor {
        Anchor::from_span("insert", &edit_anchor(None, new).to_string())
    }

    fn whole(content: &str) -> Anchor {
        Anchor::from_span("whole", &whole_anchor(content).to_string())
    }

    fn ids(hunks: &[Hunk]) -> Vec<String> {
        hunks.iter().map(|h| h.id.clone()).collect()
    }

    /// The hunks a live owner holding `anchors` elects.
    fn elected(hunks: &[Hunk], anchors: Vec<Anchor>) -> (Vec<String>, bool) {
        let verdict = classify_contention(
            hunks,
            &[OwnerAnchors {
                session: "s".to_owned(),
                anchors,
                live: true,
            }],
            None,
        );
        let widened = !matches!(
            verdict.claims.get("s"),
            Some(Claim::Hunks {
                unplaced: false,
                ..
            })
        );
        (verdict.hunks_of("s", hunks), widened)
    }

    #[test]
    fn an_anchor_the_commit_passed_over_survives() {
        // The report: a co-owner landed the first hunk, and this row wrote
        // the other two.
        let hunks = parse_hunks(TWO_LEFT);
        let row = vec![edit("tango added line"), edit("xray added line")];
        let survivors = surviving_anchors(&row, &hunks, None, &committed(&["alpha added line"]));
        assert_eq!(survivors, row, "nothing of this row landed");
        assert_eq!(elected(&hunks, survivors), (ids(&hunks), false));
    }

    #[test]
    fn a_row_whose_content_landed_is_spent() {
        let hunks = parse_hunks(TWO_LEFT);
        let row = vec![edit("alpha added line")];
        let survivors = surviving_anchors(&row, &hunks, None, &committed(&["alpha added line"]));
        assert!(survivors.is_empty(), "{survivors:?}");
    }

    #[test]
    fn a_re_added_identical_line_does_not_revive_the_row() {
        // The row's line was committed, and the same line is in the diff again
        // by a later hand. It places, and it is still not this row's edit.
        let hunks = parse_hunks(THREE_HUNKS);
        let row = vec![edit("alpha added line")];
        assert!(
            !surviving_anchors(&row, &hunks, None, &CommittedAdded::default()).is_empty(),
            "the line places when no commit took it"
        );
        let survivors = surviving_anchors(&row, &hunks, None, &committed(&["alpha added line"]));
        assert!(survivors.is_empty(), "{survivors:?}");
    }

    #[test]
    fn a_commit_before_the_row_does_not_count_against_it() {
        let hunks = parse_hunks(THREE_HUNKS);
        let row = vec![edit("alpha added line")];
        let history = PathHistory::parse(&log_adding(2_000, &["alpha added line"]));
        // Row written in second 2001, after the commit at 2000.
        let survivors = surviving_anchors(&row, &hunks, None, &history.added_since(2_001_000));
        assert_eq!(survivors, row);
        // A row in the commit's own second ties toward spent.
        let survivors = surviving_anchors(&row, &hunks, None, &history.added_since(2_000_999));
        assert!(survivors.is_empty(), "{survivors:?}");
    }

    #[test]
    fn a_row_spanning_a_landed_and_an_unlanded_hunk_keeps_the_unlanded_one() {
        let hunks = parse_hunks(TWO_LEFT);
        let landed = committed(&["alpha added line"]);

        // Two spans, one per hunk the row reached: the landed one drops.
        let row = vec![edit("alpha added line"), edit("tango added line")];
        let survivors = surviving_anchors(&row, &hunks, None, &landed);
        assert_eq!(survivors, vec![edit("tango added line")]);
        assert_eq!(
            elected(&hunks, survivors),
            (vec![hunks[0].id.clone()], false),
            "the survivor claims its hunk and does not widen"
        );

        // One span whose lines reached both hunks: it is narrowed, not kept.
        let row = vec![edit("alpha added line\ntango added line")];
        let survivors = surviving_anchors(&row, &hunks, None, &landed);
        assert_eq!(survivors.len(), 1);
        let Anchor::AddedLines {
            line_hashes,
            added_head,
            ..
        } = &survivors[0]
        else {
            panic!("{survivors:?}");
        };
        assert_eq!(line_hashes, &vec![content_hash("tango added line")]);
        assert_eq!(added_head, "tango added line");
        assert_eq!(
            elected(&hunks, survivors),
            (vec![hunks[0].id.clone()], false)
        );
    }

    #[test]
    fn an_anchor_that_places_nowhere_is_spent() {
        let hunks = parse_hunks(TWO_LEFT);
        let row = vec![edit("a line no hunk holds")];
        let survivors = surviving_anchors(&row, &hunks, None, &CommittedAdded::default());
        assert!(survivors.is_empty(), "{survivors:?}");
    }

    #[test]
    fn evidence_that_records_no_content_never_survives() {
        let hunks = parse_hunks(TWO_LEFT);
        let none = CommittedAdded::default();
        assert!(surviving_anchors(&[Anchor::Whole], &hunks, None, &none).is_empty());
        assert!(surviving_anchors(&[], &hunks, None, &none).is_empty());
        // A bare whole beside placeable evidence does not ride along with it.
        let row = vec![Anchor::Whole, edit("tango added line")];
        assert_eq!(
            surviving_anchors(&row, &hunks, None, &none),
            vec![edit("tango added line")]
        );
    }

    #[test]
    fn a_fragment_survives_by_containment_on_one_hunk() {
        // A sub-line edit: the recorded text is part of the hunk's line, so no
        // line hash can match and the probe has to.
        let hunks = parse_hunks(TWO_LEFT);
        let row = vec![edit("tango added")];
        let none = CommittedAdded::default();
        assert_eq!(surviving_anchors(&row, &hunks, None, &none), row);
        // A commit whose added line contains the fragment took it.
        let survivors =
            surviving_anchors(&row, &hunks, None, &committed(&["the tango added line"]));
        assert!(survivors.is_empty(), "{survivors:?}");
        // A fragment two hunks contain places on neither.
        let row = vec![edit("added line")];
        assert!(surviving_anchors(&row, &hunks, None, &none).is_empty());
    }

    #[test]
    fn a_hunk_id_survives_while_its_hunk_is_in_the_diff() {
        let before = parse_hunks(THREE_HUNKS);
        let after = parse_hunks(TWO_LEFT);
        let row: Vec<Anchor> = before
            .iter()
            .map(|h| Anchor::Hunk { id: h.id.clone() })
            .collect();
        let survivors = surviving_anchors(&row, &after, None, &committed(&["alpha added line"]));
        assert_eq!(survivors, row[1..].to_vec(), "the landed hunk's id is gone");
        // The id is present and a commit since added its lines: a re-add.
        let survivors =
            surviving_anchors(&row[..1], &before, None, &committed(&["alpha added line"]));
        assert!(survivors.is_empty(), "{survivors:?}");
    }

    #[test]
    fn a_legacy_content_anchor_takes_the_same_two_tests() {
        let hunks = parse_hunks(TWO_LEFT);
        let content = |text: &str| Anchor::Content {
            new_hash: content_hash(text),
            new_head: text.to_owned(),
            new_len: text.len(),
        };
        let row = vec![content("tango added line")];
        assert_eq!(
            surviving_anchors(&row, &hunks, None, &committed(&["alpha added line"])),
            row
        );
        assert!(
            surviving_anchors(&row, &hunks, None, &committed(&["tango added line"])).is_empty()
        );
        assert!(
            surviving_anchors(
                &[content("nowhere at all")],
                &hunks,
                None,
                &CommittedAdded::default()
            )
            .is_empty()
        );
    }

    #[test]
    fn a_whole_file_write_stays_whole_while_the_bytes_are_its_own() {
        let hunks = parse_hunks(TWO_LEFT);
        let text = "tango\ntango added line\nxray\nxray added line\n";
        let row = vec![whole(text)];
        let hash = content_hash(text);
        let landed = committed(&["alpha added line"]);
        assert_eq!(surviving_anchors(&row, &hunks, Some(&hash), &landed), row);
        // Every line it wrote was committed since: the bytes are a re-add.
        let all = committed(&["tango", "tango added line", "xray", "xray added line"]);
        assert!(surviving_anchors(&row, &hunks, Some(&hash), &all).is_empty());
    }

    #[test]
    fn a_whole_file_write_the_file_moved_past_degrades_to_its_lines() {
        let hunks = parse_hunks(TWO_LEFT);
        let row = vec![whole("alpha added line\ntango added line\n")];
        let landed = committed(&["alpha added line"]);
        for current in [Some("some other bytes"), None] {
            let survivors = surviving_anchors(&row, &hunks, current, &landed);
            assert_eq!(survivors.len(), 1, "{survivors:?}");
            assert!(
                matches!(&survivors[0], Anchor::AddedLines { line_hashes, .. }
                    if line_hashes == &vec![content_hash("tango added line")]),
                "{survivors:?}"
            );
            assert_eq!(
                elected(&hunks, survivors),
                (vec![hunks[0].id.clone()], false),
                "a degraded whole-file write claims its hunk, not the file"
            );
        }
        // None of its lines are in the diff any more.
        let gone = vec![whole("alpha added line\n")];
        assert!(surviving_anchors(&gone, &hunks, Some("other"), &landed).is_empty());
    }

    #[test]
    fn the_history_parse_keeps_each_commit_apart() {
        let log = format!(
            "{}{}",
            log_adding(3_000, &["newer line"]),
            log_adding(2_000, &["older line"])
        );
        let history = PathHistory::parse(&log);
        assert_eq!(history.len(), 2);
        let both = history.added_since(1_000_000);
        assert!(both.holds("newer line") && both.holds("older line"));
        let newer = history.added_since(2_500_000);
        assert!(newer.holds("newer line") && !newer.holds("older line"));
        assert!(history.added_since(3_001_000).is_empty());
        assert!(PathHistory::parse("").is_empty());
        // A record with an unreadable time counts against every row.
        let undated = PathHistory::parse(&log_adding(2_000, &["x line"]).replace("2000", "soon"));
        assert!(undated.added_since(i64::MAX).holds("x line"));
    }

    /// Commit whatever is staged, with the commit's time pinned to `secs`.
    fn commit_at(fixture: &GitFixture, secs: i64, message: &str) {
        let date = format!("@{secs} +0000");
        let status = tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(fixture.root())
            .args(["commit", "-q", "-m", message])
            .env("GIT_COMMITTER_DATE", &date)
            .env("GIT_AUTHOR_DATE", &date)
            .status()
            .expect("git commit");
        assert!(status.success());
    }

    #[test]
    fn the_history_reads_what_a_partial_commit_took() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let fixture = GitFixture::init(root);
        let base: String = (1..=40).map(|n| format!("line {n}\n")).collect();
        std::fs::write(root.join("f.txt"), &base).unwrap();
        fixture.git(&["add", "f.txt"]);
        commit_at(&fixture, 1_700_000_000, "init");

        // Two edits far apart, then only the first is staged and committed —
        // a partial commit made by plain git.
        let first = base.replace("line 2\n", "line 2\nfirst region added\n");
        let both = first.replace("line 30\n", "line 30\nsecond region added\n");
        std::fs::write(root.join("f.txt"), &first).unwrap();
        fixture.git(&["add", "f.txt"]);
        std::fs::write(root.join("f.txt"), &both).unwrap();
        commit_at(&fixture, 1_700_000_100, "land the first region");

        // A row written between the two commits sees only the second.
        let row_at_ms = 1_700_000_050_000;
        let history = path_history(root, "f.txt", row_at_ms).expect("history");
        assert_eq!(history.len(), 1, "the window opens at the row");
        let committed = history.added_since(row_at_ms);
        assert!(committed.holds("first region added"));
        assert!(!committed.holds("second region added"));
        assert!(
            !committed.holds("line 1"),
            "the first commit is before the row"
        );

        // A row in the partial commit's own second still sees it.
        let tied = path_history(root, "f.txt", 1_700_000_100_999).expect("history");
        assert_eq!(tied.len(), 1);
        // A row after it sees nothing, and one before everything sees both.
        assert!(
            path_history(root, "f.txt", 1_700_000_101_000)
                .expect("history")
                .is_empty()
        );
        assert_eq!(path_history(root, "f.txt", 0).expect("history").len(), 2);

        // Judged against the working tree: the row that wrote both regions
        // keeps the one still dirty.
        let hunks = crate::hunks::file_hunks(root, "f.txt").expect("hunks");
        assert_eq!(hunks.len(), 1);
        let row = vec![edit("first region added"), edit("second region added")];
        assert_eq!(
            surviving_anchors(&row, &hunks, None, &committed),
            vec![edit("second region added")]
        );
    }
}
