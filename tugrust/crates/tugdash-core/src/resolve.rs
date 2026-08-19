//! The join conflict resolution ladder ([P31]).
//!
//! A conflicted join is not a dead end. This module works the conflict as hard
//! as it can **off to the side** — never touching the user's checkouts — and,
//! when every file resolves, hands back a pre-built candidate commit for
//! [`crate::ops::join_in`] to fast-forward the base onto ([P31], Spec S12). The
//! rungs, in order:
//!
//! 1. **Replay probe** — replay the dash's rounds one at a time in memory
//!    (`merge-tree --merge-base=<round^>` + `commit-tree`, git ≥ 2.40); a clean
//!    replay lands as the replayed rounds (shape change accepted).
//! 2. **rerere** — a scratch detached worktree replays previously recorded
//!    conflict resolutions (shared `rr-cache`).
//! 3. **merge-file** — an opportunistic per-file 3-way re-merge (histogram).
//! 4. **structured-merge driver** — a PATH-discovered, configurable command
//!    (mergiraf by default), never bundled.
//! 5. **AI** ([P32]) — the [`FileMerger`] seam; tugcast injects the scribe, the
//!    CLI passes `None`.
//!
//! Every rung's per-file outcome is recorded so callers can report exactly what
//! happened. Non-content conflicts (delete/modify, binary, mode) short-circuit
//! straight to unresolved — text tools never guess at structure.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::ops::{
    branch_exists, branch_name, commit_worktree_dirt, config_get, dash_base, git_output,
    git_stdout, integrate_message, worktree_path,
};
use crate::replay::{ReplayWalk, ReplayedRounds};

/// Which rung resolved a file ([P31]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResolvedBy {
    /// The whole dash replayed clean; no per-file work (shape = replay).
    Replay,
    /// A previously recorded `rerere` resolution replayed.
    Rerere,
    /// `git merge-file` re-merged the three blobs cleanly.
    MergeFile,
    /// A structured-merge driver (mergiraf or a configured command) resolved it.
    Driver,
    /// The AI file-merge seam ([P32]) produced a validated result.
    Ai,
    /// The resolver finished it in the workshop, with the whole project around
    /// it — the rung above blob arithmetic.
    Resolver,
}

/// One conflicted file's three blob stages plus the dash's intent, handed to the
/// AI rung ([P32]). `base` is `None` for an add/add conflict.
pub struct FileMergeRequest {
    pub path: String,
    pub base: Option<Vec<u8>>,
    pub ours: Option<Vec<u8>>,
    pub theirs: Option<Vec<u8>>,
    /// The dash's maintained draft + round subjects — what the dash was doing.
    pub intent: String,
}

/// The AI rung's seam ([P32]). tugcast implements it with the scribe sidecar;
/// the `tugdash` CLI passes `None`. A `None` return leaves the file unresolved.
pub trait FileMerger: Send + Sync {
    fn merge(&self, req: &FileMergeRequest) -> Option<Vec<u8>>;
}

/// One file's resolution, for reporting.
#[derive(Debug, Clone, Serialize)]
pub struct FileResolution {
    pub path: String,
    pub resolved_by: ResolvedBy,
    /// What this resolution would land on the base: the unified diff from the
    /// base head to the candidate, for this path alone ([P31]). `None` when
    /// there is no candidate to diff against — a partial outcome lands nothing,
    /// so there is nothing to review.
    ///
    /// Every rung above the replay probe is a *machine decision the user never
    /// saw*: rerere replays a cached resolution that may be stale, the driver
    /// and the AI rung guess. This is what makes the decision reviewable before
    /// it lands rather than after.
    pub diff: Option<String>,
    /// Lines added and removed by this resolution, as **git** counts them —
    /// never as anything counts the `diff` above, which is capped.
    ///
    /// A stat derived from the capped text is a lie exactly when the diff is
    /// big enough for the cap to bite, which is when a reviewer most needs it:
    /// a 2050-line file resolved to a one-line body truncates to 395 deletions
    /// and no addition, and the face reported `+0 −395` over a resolution that
    /// added a line. `None` for a binary path, where git reports `-` rather
    /// than a line count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

/// The shape the join will land as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JoinShape {
    Squash,
    Replay,
}

/// The ladder's outcome. `candidate_commit` is present iff every conflict
/// resolved (the pre-built join commit, or the replayed head); when any file
/// stays unresolved it is `None` and `unresolved` names them.
#[derive(Debug, Clone, Serialize)]
pub struct ResolveOutcome {
    pub shape: JoinShape,
    pub resolved: Vec<FileResolution>,
    pub unresolved: Vec<String>,
    pub candidate_commit: Option<String>,
    pub base_branch: String,
    pub warnings: Vec<String>,
    /// The tree holding the ladder's own resolutions — built whether or not
    /// every file resolved, because a *partial* ladder run is exactly when
    /// somebody else has to carry the work forward and would otherwise have to
    /// redo it. The resolver's workshop checks these paths out of it, which
    /// both writes the reconciled content and clears the conflict stages.
    ///
    /// Never serialized: it is a local git object with no meaning to the card.
    #[serde(skip)]
    pub staged_tree: Option<String>,
}

/// Like [`resolve_conflicts`], but discovering the repo root from the process
/// cwd (the `tugdash` CLI entry point).
pub fn resolve_conflicts_cwd(
    name: &str,
    merger: Option<&dyn FileMerger>,
) -> Result<ResolveOutcome, String> {
    let repo = tugutil_core::find_repo_root().map_err(|e| e.to_string())?;
    resolve_conflicts(&repo, name, merger)
}

/// Run the resolution ladder against a dash's current conflict set ([P31]).
///
/// Commits outstanding dash-worktree dirt first (so the branch tip is the real
/// state), then walks the rungs. Never touches the base or dash checkouts — a
/// candidate commit is built off to the side and landed separately by
/// [`crate::ops::join_in`] with the staleness guard.
pub fn resolve_conflicts(
    repo: &Path,
    name: &str,
    merger: Option<&dyn FileMerger>,
) -> Result<ResolveOutcome, String> {
    let outcome = resolve_ladder(repo, name, merger)?;

    // Anchor at one site rather than at each of the ladder's four success
    // exits. The dash head is read here — *after* the ladder's
    // `commit_worktree_dirt` preamble, which commits the dash worktree's dirt
    // and so moves the dash head as part of resolving. Recording the
    // pre-preamble head would mark every candidate stale the moment it was
    // built.
    match &outcome.candidate_commit {
        Some(candidate) => {
            let dash_head = git_stdout(repo, &["rev-parse", &branch_name(name)])?;
            write_candidate_ref(repo, name, candidate)?;
            clear_candidate_marks(repo, name);
            let _ = git_output(repo, &["config", &join_source_config_key(name), &dash_head]);
            for r in &outcome.resolved {
                let value = format!("{}\t{}", r.path, r.resolved_by.as_str());
                let _ = git_output(
                    repo,
                    &["config", "--add", &join_resolved_config_key(name), &value],
                );
            }
        }
        // A partial outcome lands nothing, so any previously anchored candidate
        // is now describing a resolution this run did not reach. Clearing it
        // keeps a superseded candidate from standing as the current one.
        None => clear_candidate(repo, name),
    }

    Ok(outcome)
}

/// The ladder proper. Wrapped by [`resolve_conflicts`], which anchors whatever
/// candidate this returns; the split exists so the anchoring happens once
/// instead of at each of the four success exits below.
fn resolve_ladder(
    repo: &Path,
    name: &str,
    merger: Option<&dyn FileMerger>,
) -> Result<ResolveOutcome, String> {
    let branch = branch_name(name);
    if !branch_exists(repo, &branch) {
        return Err(format!("Dash not found: {}", name));
    }
    let base_branch = dash_base(repo, name)?;
    let worktree = worktree_path(repo, name);
    let mut warnings = Vec::new();

    // Preamble: the tip must reflect the dash's real state before we resolve.
    commit_worktree_dirt(&worktree)?;

    let base_head = git_stdout(repo, &["rev-parse", &base_branch])?;

    // Rung 1 — replay probe (in-memory per round; git ≥ 2.40).
    if let Some(replayed) = replay_probe(repo, &base_head, &base_branch, &branch)? {
        return Ok(ResolveOutcome {
            shape: JoinShape::Replay,
            resolved: Vec::new(),
            unresolved: Vec::new(),
            candidate_commit: Some(replayed.head),
            base_branch,
            warnings,
            staged_tree: None,
        });
    }

    // The squash conflict set: candidate tree (markers baked in) + per-path
    // stage blobs.
    let (cand_tree, stages) = merge_tree_stages(repo, &base_branch, &branch)?;
    let msg = integrate_message(repo, name, &branch, None);

    if stages.is_empty() {
        // The one-shot squash is actually clean — commit its tree directly.
        let candidate = commit_tree(repo, &cand_tree, &base_head, &msg)?;
        return Ok(ResolveOutcome {
            shape: JoinShape::Squash,
            resolved: Vec::new(),
            unresolved: Vec::new(),
            candidate_commit: Some(candidate),
            base_branch,
            warnings,
            staged_tree: Some(cand_tree),
        });
    }

    // Rungs 2–5, per file. A scratch tempdir holds the merge-file / driver
    // working files; the rerere rung has its own scratch worktree.
    let scratch = tempfile::tempdir().map_err(|e| format!("resolve: tempdir: {}", e))?;
    let intent = resolve_intent(repo, &base_branch, &branch);

    let rerere_resolved = rerere_rung(repo, &base_head, &branch, &stages, &mut warnings);

    let mut resolved: Vec<ResolvedFile> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();

    for (path, raw) in &stages {
        // Recorded resolution replayed by rerere.
        if let Some(oid) = rerere_resolved.get(path) {
            resolved.push(ResolvedFile {
                path: path.clone(),
                by: ResolvedBy::Rerere,
                blob_oid: oid.clone(),
                mode: raw.merged_mode(),
            });
            continue;
        }

        // Load the three blobs; non-content conflicts short-circuit.
        let loaded = match raw.load(repo) {
            Some(l) => l,
            None => {
                unresolved.push(path.clone());
                continue;
            }
        };

        // Rung 3 — opportunistic merge-file re-merge.
        if let Some(bytes) = merge_file_rung(scratch.path(), path, &loaded) {
            let oid = hash_blob(repo, &bytes)?;
            resolved.push(ResolvedFile {
                path: path.clone(),
                by: ResolvedBy::MergeFile,
                blob_oid: oid,
                mode: raw.merged_mode(),
            });
            continue;
        }

        // Rung 4 — structured-merge driver.
        if let Some(bytes) = driver_rung(repo, scratch.path(), path, &loaded) {
            let oid = hash_blob(repo, &bytes)?;
            resolved.push(ResolvedFile {
                path: path.clone(),
                by: ResolvedBy::Driver,
                blob_oid: oid,
                mode: raw.merged_mode(),
            });
            continue;
        }

        // Rung 5 — AI.
        if let Some(m) = merger {
            let req = FileMergeRequest {
                path: path.clone(),
                base: loaded.base.clone(),
                ours: loaded.ours.clone(),
                theirs: loaded.theirs.clone(),
                intent: intent.clone(),
            };
            if let Some(bytes) = m.merge(&req) {
                if is_clean_merge(&bytes) {
                    let oid = hash_blob(repo, &bytes)?;
                    resolved.push(ResolvedFile {
                        path: path.clone(),
                        by: ResolvedBy::Ai,
                        blob_oid: oid,
                        mode: raw.merged_mode(),
                    });
                    continue;
                }
            }
        }

        unresolved.push(path.clone());
    }

    // Teach rerere the resolutions it didn't already know (driver/AI), so an
    // identical future conflict skips the expensive rungs ([P31]). Best-effort.
    let taught: Vec<&ResolvedFile> = resolved
        .iter()
        .filter(|r| matches!(r.by, ResolvedBy::Driver | ResolvedBy::Ai))
        .collect();
    if !taught.is_empty() {
        record_rerere(repo, &base_head, &branch, &taught, &mut warnings);
    }

    // The ladder's work, as a tree, on both arms. On the complete arm it
    // becomes the candidate; on the partial arm it is what the resolver
    // inherits instead of starting over.
    let staged_tree = patch_tree(repo, scratch.path(), &cand_tree, &resolved)?;

    if !unresolved.is_empty() {
        return Ok(ResolveOutcome {
            shape: JoinShape::Squash,
            resolved: resolution_report(repo, &base_head, None, &resolved),
            unresolved,
            candidate_commit: None,
            base_branch,
            warnings,
            staged_tree: Some(staged_tree),
        });
    }

    // Everything resolved — the staged tree is the candidate's tree.
    let candidate = commit_tree(repo, &staged_tree, &base_head, &msg)?;

    Ok(ResolveOutcome {
        shape: JoinShape::Squash,
        resolved: resolution_report(repo, &base_head, Some(&candidate), &resolved),
        unresolved: Vec::new(),
        candidate_commit: Some(candidate),
        base_branch,
        warnings,
        staged_tree: Some(staged_tree),
    })
}

/// How much of one file's diff rides the resolve frame. A review needs the shape
/// of what changed, not an unbounded payload on a CONTROL broadcast.
const DIFF_LINE_CAP: usize = 400;

/// The per-file report, each entry carrying the diff its resolution would land.
fn resolution_report(
    repo: &Path,
    base_head: &str,
    candidate: Option<&str>,
    resolved: &[ResolvedFile],
) -> Vec<FileResolution> {
    resolved
        .iter()
        .map(|r| {
            let d = candidate.and_then(|c| resolution_diff(repo, base_head, c, &r.path));
            FileResolution {
                path: r.path.clone(),
                resolved_by: r.by,
                added: d.as_ref().and_then(|d| d.added),
                removed: d.as_ref().and_then(|d| d.removed),
                diff: d.map(|d| d.text),
            }
        })
        .collect()
}

/// One path's diff and the counts that describe it, from a single `git diff`.
struct ResolutionDiff {
    /// The patch body, capped at [`DIFF_LINE_CAP`] lines.
    text: String,
    added: Option<u32>,
    removed: Option<u32>,
}

/// Parse a `--numstat` line: `<added>\t<removed>\t<path>`, where either count
/// is `-` for a binary file. `None` when the line is not a numstat line at all,
/// which is what keeps a git that stops emitting one from being misread as a
/// patch whose first line vanished.
fn parse_numstat(line: &str) -> Option<(Option<u32>, Option<u32>)> {
    let mut fields = line.split('\t');
    let added = fields.next()?;
    let removed = fields.next()?;
    fields.next()?; // the path — present by construction, unused here
    let cell = |s: &str| -> Option<Option<u32>> {
        if s == "-" {
            Some(None)
        } else {
            s.parse::<u32>().ok().map(Some)
        }
    };
    Some((cell(added)?, cell(removed)?))
}

/// The unified diff one resolved path would land: base head → candidate, plus
/// git's own count of what it moves. Reads the built candidate rather than the
/// blobs, so an add, a delete, and a mode change all come out in the form git
/// already renders them. Best-effort — a diff git declines to produce is
/// `None`, never a failed resolve.
///
/// `--numstat --patch` answers both questions in one subprocess: the numstat
/// line, a blank line, then the patch. One call also means the counts and the
/// text can never disagree, which two calls could if the candidate moved
/// between them.
fn resolution_diff(
    repo: &Path,
    base_head: &str,
    candidate: &str,
    path: &str,
) -> Option<ResolutionDiff> {
    let raw = git_stdout(
        repo,
        &[
            "diff",
            "--no-color",
            "--numstat",
            "--patch",
            base_head,
            candidate,
            "--",
            path,
        ],
    )
    .ok()?;
    let (added, removed, body) = match raw
        .split_once('\n')
        .and_then(|(first, rest)| parse_numstat(first).map(|(a, r)| (a, r, rest)))
    {
        Some((a, r, rest)) => (a, r, rest.strip_prefix('\n').unwrap_or(rest)),
        None => (None, None, raw.as_str()),
    };
    // Emptiness is a question about the **patch**, not the raw output: the raw
    // output always carries a numstat line, so testing it would mean a path
    // with no diff started arriving as a reviewable resolution, and the face
    // drops exactly the entries whose diff is null.
    if body.is_empty() {
        return None;
    }
    let mut lines = body.lines();
    let head: Vec<&str> = lines.by_ref().take(DIFF_LINE_CAP).collect();
    let rest = lines.count();
    let text = if rest == 0 {
        head.join("\n")
    } else {
        format!(
            "{}\n… {} more line{}",
            head.join("\n"),
            rest,
            if rest == 1 { "" } else { "s" }
        )
    };
    Some(ResolutionDiff {
        text,
        added,
        removed,
    })
}

// ---------------------------------------------------------------------------
// Rung 1 — replay probe
// ---------------------------------------------------------------------------

/// Replay the dash's rounds one at a time onto the current base, in memory
/// (`merge-tree --merge-base=<round^>` + `commit-tree`). Returns the replayed
/// head and the per-round mapping when every round is clean, else `None` (a
/// conflicting round, no rounds, or git < 2.40). Touches nothing.
///
/// The walk itself lives in [`crate::replay`], which needs the same rebuild plus
/// the detail of *which* round stopped it.
pub(crate) fn replay_probe(
    repo: &Path,
    base_head: &str,
    base_branch: &str,
    branch: &str,
) -> Result<Option<ReplayedRounds>, String> {
    match crate::replay::walk_rounds(repo, base_head, base_branch, branch)? {
        ReplayWalk::Clean(replayed) => Ok(Some(replayed)),
        ReplayWalk::Conflicted { .. } | ReplayWalk::Unavailable => Ok(None),
    }
}

/// Whether `git` here supports `merge-tree --merge-base` (git ≥ 2.40).
pub(crate) fn git_supports_merge_base_flag(repo: &Path) -> bool {
    let out = git_stdout(repo, &["--version"]).unwrap_or_default();
    let ver = out.split_whitespace().nth(2).unwrap_or("");
    let mut parts = ver.split('.');
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    major > 2 || (major == 2 && minor >= 40)
}

// ---------------------------------------------------------------------------
// merge-tree stage parsing
// ---------------------------------------------------------------------------

/// The raw (mode, oid) of each present stage for one conflicted path.
#[derive(Default, Clone)]
struct RawStages {
    base: Option<(String, String)>,   // stage 1
    ours: Option<(String, String)>,   // stage 2
    theirs: Option<(String, String)>, // stage 3
}

/// The three loaded blob bodies for a content conflict.
struct LoadedStages {
    base: Option<Vec<u8>>,
    ours: Option<Vec<u8>>,
    theirs: Option<Vec<u8>>,
}

impl RawStages {
    /// The mode the merged file should carry (the ours-stage mode, else theirs).
    fn merged_mode(&self) -> String {
        self.ours
            .as_ref()
            .or(self.theirs.as_ref())
            .map(|(m, _)| m.clone())
            .unwrap_or_else(|| "100644".to_string())
    }

    /// Load the blob bodies, or `None` when this is a **non-content** conflict:
    /// a delete/modify (missing ours or theirs stage), a mode conflict (ours and
    /// theirs modes differ), or a binary file (a NUL byte in any stage). Text
    /// rungs never touch these.
    fn load(&self, repo: &Path) -> Option<LoadedStages> {
        let ours = self.ours.as_ref()?;
        let theirs = self.theirs.as_ref()?;
        if ours.0 != theirs.0 {
            return None; // mode conflict
        }
        let base = match &self.base {
            Some((_, oid)) => Some(cat_blob(repo, oid).ok()?),
            None => None,
        };
        let ours_b = cat_blob(repo, &ours.1).ok()?;
        let theirs_b = cat_blob(repo, &theirs.1).ok()?;
        if is_binary(&ours_b) || is_binary(&theirs_b) || base.as_deref().is_some_and(is_binary) {
            return None;
        }
        Some(LoadedStages {
            base,
            ours: Some(ours_b),
            theirs: Some(theirs_b),
        })
    }
}

/// Parse `git merge-tree --write-tree -z <base> <branch>`: the toplevel tree OID
/// plus the per-path stage entries. An empty split field ends the
/// conflicted-file-info section; the informational messages after it are
/// ignored. A clean merge yields an empty stage map.
fn merge_tree_stages(
    repo: &Path,
    base: &str,
    branch: &str,
) -> Result<(String, BTreeMap<String, RawStages>), String> {
    let out = git_output(repo, &["merge-tree", "--write-tree", "-z", base, branch])?;
    let stdout = out.stdout;
    let mut fields = stdout.split(|&b| b == 0);
    let tree = String::from_utf8_lossy(fields.next().unwrap_or_default())
        .trim()
        .to_string();
    let mut map: BTreeMap<String, RawStages> = BTreeMap::new();
    for field in fields {
        if field.is_empty() {
            break; // end of the conflicted-file-info section
        }
        // "<mode> <oid> <stage>\t<path>"
        let s = String::from_utf8_lossy(field);
        let Some((meta, path)) = s.split_once('\t') else {
            continue;
        };
        let mut parts = meta.split_whitespace();
        let mode = parts.next().unwrap_or("").to_string();
        let oid = parts.next().unwrap_or("").to_string();
        let stage: u8 = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let entry = map.entry(path.to_string()).or_default();
        match stage {
            1 => entry.base = Some((mode, oid)),
            2 => entry.ours = Some((mode, oid)),
            3 => entry.theirs = Some((mode, oid)),
            _ => {}
        }
    }
    Ok((tree, map))
}

// ---------------------------------------------------------------------------
// Rung 2 — rerere (scratch worktree)
// ---------------------------------------------------------------------------

/// Replay recorded conflict resolutions ([P31]) in a scratch detached worktree:
/// merge the branch into a checkout of the base head (rerere auto-applies +
/// stages known resolutions), then harvest the content-conflict paths that came
/// out marker-free and that rerere does not still list as remaining.
/// Returns `path → resolved blob oid`. Best-effort — any failure yields an empty
/// map (the per-file rungs still run) and pushes a warning.
fn rerere_rung(
    repo: &Path,
    base_head: &str,
    branch: &str,
    stages: &BTreeMap<String, RawStages>,
    warnings: &mut Vec<String>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    // Nothing recorded and nothing to harvest against ⇒ skip the checkout cost.
    if !has_rr_cache(repo) {
        return out;
    }
    let scratch = match ScratchWorktree::open(repo, base_head) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("rerere rung skipped: {}", e));
            return out;
        }
    };
    // A conflicting merge is expected; rerere (autoUpdate) resolves + stages the
    // known ones. We ignore the exit status and inspect the working tree.
    let _ = git_output(scratch.path(), &["merge", "--no-edit", branch]);
    // The paths rerere itself reports as still needing a resolution — a direct
    // answer where the marker scan below can only infer one. An unreadable
    // answer restricts nothing.
    let remaining: std::collections::BTreeSet<String> =
        git_stdout(scratch.path(), &["rerere", "remaining"])
            .map(|s| {
                s.lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
    for (path, raw) in stages {
        // A non-content conflict is marker-free by construction — git leaves the
        // surviving side's content in the tree — so the scan below would claim it
        // with one side's bytes even though rerere did nothing. These belong to
        // the per-file short-circuit; leave them for it.
        if raw.load(repo).is_none() {
            continue;
        }
        if remaining.contains(path) {
            continue;
        }
        let file = scratch.path().join(path);
        if let Ok(bytes) = std::fs::read(&file) {
            if !bytes.is_empty() && is_clean_merge(&bytes) {
                if let Ok(oid) = hash_blob(repo, &bytes) {
                    out.insert(path.clone(), oid);
                }
            }
        }
    }
    let _ = git_output(scratch.path(), &["merge", "--abort"]);
    out
}

/// Teach rerere the driver/AI resolutions ([P31]) so an identical future
/// conflict replays for free: reproduce the conflict in a scratch worktree
/// (rerere records the preimage), write our resolutions, then `git rerere` to
/// record them. Best-effort; warnings on failure.
fn record_rerere(
    repo: &Path,
    base_head: &str,
    branch: &str,
    taught: &[&ResolvedFile],
    warnings: &mut Vec<String>,
) {
    ensure_rerere_config(repo);
    let scratch = match ScratchWorktree::open(repo, base_head) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("rerere record skipped: {}", e));
            return;
        }
    };
    // Conflict so rerere snapshots the preimage.
    let _ = git_output(scratch.path(), &["merge", "--no-edit", branch]);
    let mut wrote = false;
    for r in taught {
        let file = scratch.path().join(&r.path);
        if let Ok(bytes) = cat_blob(repo, &r.blob_oid) {
            if std::fs::write(&file, &bytes).is_ok() {
                let _ = git_output(scratch.path(), &["add", "--", &r.path]);
                wrote = true;
            }
        }
    }
    if wrote {
        // Record resolutions for the now-marker-free files.
        let _ = git_output(scratch.path(), &["rerere"]);
    }
    let _ = git_output(scratch.path(), &["merge", "--abort"]);
}

fn has_rr_cache(repo: &Path) -> bool {
    let dir = git_stdout(repo, &["rev-parse", "--git-path", "rr-cache"]).unwrap_or_default();
    if dir.is_empty() {
        return false;
    }
    let path = if Path::new(&dir).is_absolute() {
        std::path::PathBuf::from(&dir)
    } else {
        repo.join(&dir)
    };
    std::fs::read_dir(&path)
        .map(|mut d| d.next().is_some())
        .unwrap_or(false)
}

/// A scratch detached worktree that removes itself on drop.
struct ScratchWorktree {
    repo: std::path::PathBuf,
    dir: tempfile::TempDir,
}

impl ScratchWorktree {
    fn open(repo: &Path, at: &str) -> Result<Self, String> {
        let dir = tempfile::tempdir().map_err(|e| format!("scratch tempdir: {}", e))?;
        let out = git_output(
            repo,
            &[
                "worktree",
                "add",
                "--detach",
                &dir.path().to_string_lossy(),
                at,
            ],
        )?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(Self {
            repo: repo.to_path_buf(),
            dir,
        })
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }
}

impl Drop for ScratchWorktree {
    fn drop(&mut self) {
        let _ = git_output(
            &self.repo,
            &[
                "worktree",
                "remove",
                "--force",
                &self.dir.path().to_string_lossy(),
            ],
        );
    }
}

// ---------------------------------------------------------------------------
// Rung 3 — merge-file
// ---------------------------------------------------------------------------

/// An opportunistic per-file 3-way re-merge with `git merge-file` (histogram
/// diff). Accepts only a clean (exit 0) result. Returns the merged bytes or
/// `None`. An add/add conflict (no base) has no 3-way and is skipped.
fn merge_file_rung(scratch: &Path, path: &str, loaded: &LoadedStages) -> Option<Vec<u8>> {
    let base = loaded.base.as_ref()?;
    let ours = loaded.ours.as_ref()?;
    let theirs = loaded.theirs.as_ref()?;
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt");
    let ours_f = write_scratch(scratch, "ours", ext, ours)?;
    let base_f = write_scratch(scratch, "base", ext, base)?;
    let theirs_f = write_scratch(scratch, "theirs", ext, theirs)?;
    let out = Command::new("git")
        .args([
            "-c",
            "diff.algorithm=histogram",
            "merge-file",
            "-p",
            "--zdiff3",
        ])
        .arg(&ours_f)
        .arg(&base_f)
        .arg(&theirs_f)
        .output()
        .ok()?;
    if out.status.success() && is_clean_merge(&out.stdout) {
        Some(out.stdout)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Rung 4 — structured-merge driver
// ---------------------------------------------------------------------------

/// A structured-merge driver ([P31]): the configured `tugdash.mergedriver`
/// command (or `mergiraf` when present), invoked with the three stage files and
/// an output file. Convention — the command receives, positionally:
/// `<base> <ours> <theirs> <output> <ext>` and must write the merged result to
/// `<output>` (exit 0). We validate the output has no conflict markers before
/// accepting. Absent tool ⇒ `None` (rung skipped), never bundled.
fn driver_rung(repo: &Path, scratch: &Path, path: &str, loaded: &LoadedStages) -> Option<Vec<u8>> {
    let base = loaded.base.as_ref()?;
    let ours = loaded.ours.as_ref()?;
    let theirs = loaded.theirs.as_ref()?;
    let program = driver_program(repo)?;
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt");
    let base_f = write_scratch(scratch, "d-base", ext, base)?;
    let ours_f = write_scratch(scratch, "d-ours", ext, ours)?;
    let theirs_f = write_scratch(scratch, "d-theirs", ext, theirs)?;
    let out_f = scratch.join(format!("d-out.{}", ext));

    let mut parts = program.split_whitespace();
    let bin = parts.next()?;
    let mut cmd = Command::new(bin);
    for arg in parts {
        cmd.arg(arg);
    }
    let status = cmd
        .arg(&base_f)
        .arg(&ours_f)
        .arg(&theirs_f)
        .arg(&out_f)
        .arg(ext)
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    let bytes = std::fs::read(&out_f).ok()?;
    if !bytes.is_empty() && is_clean_merge(&bytes) {
        Some(bytes)
    } else {
        None
    }
}

/// The configured resolver stub command, if this repo names one.
///
/// The seam sits beside [`driver_program`] because it is the same seam one rung
/// up: `tugdash.mergedriver` lets a test play a structured-merge driver in a few
/// lines of shell, and `tugdash.joinresolver` lets it play the resolver the same
/// way. Absent, tugcast spawns the real thing.
pub fn resolver_program(repo: &Path) -> Option<String> {
    crate::ops::config_get(repo, "tugdash.joinresolver").filter(|c| !c.trim().is_empty())
}

/// The structured-merge driver command: `tugdash.mergedriver` when configured,
/// else `mergiraf` when it is on `PATH`, else `None`.
fn driver_program(repo: &Path) -> Option<String> {
    if let Some(cmd) = crate::ops::config_get(repo, "tugdash.mergedriver") {
        return Some(cmd);
    }
    if on_path("mergiraf") {
        return Some("mergiraf".to_string());
    }
    None
}

fn on_path(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                let p = dir.join(bin);
                p.is_file()
            })
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

/// A file resolved by some rung, ready to patch into the candidate tree.
struct ResolvedFile {
    path: String,
    by: ResolvedBy,
    blob_oid: String,
    mode: String,
}

/// Patch the merge-tree candidate tree with each resolved blob, via a temp index
/// (the repo's real index is never touched). Returns the new tree OID.
fn patch_tree(
    repo: &Path,
    scratch: &Path,
    base_tree: &str,
    resolved: &[ResolvedFile],
) -> Result<String, String> {
    let index = scratch.join("resolve-index");
    git_with_index(repo, &index, &["read-tree", base_tree])?;
    for r in resolved {
        git_with_index(
            repo,
            &index,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("{},{},{}", r.mode, r.blob_oid, r.path),
            ],
        )?;
    }
    git_with_index(repo, &index, &["write-tree"])
}

/// `git commit-tree <tree> -p <parent> -m <msg>` → the new commit OID.
pub(crate) fn commit_tree(
    repo: &Path,
    tree: &str,
    parent: &str,
    msg: &str,
) -> Result<String, String> {
    let out = git_output(repo, &["commit-tree", tree, "-p", parent, "-m", msg])?;
    if !out.status.success() {
        return Err(format!(
            "commit-tree failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// git plumbing helpers
// ---------------------------------------------------------------------------

/// Run a git command with an explicit `GIT_INDEX_FILE`, returning trimmed
/// stdout on success.
fn git_with_index(repo: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_INDEX_FILE", index)
        .output()
        .map_err(|e| format!("git {}: {}", args.join(" "), e))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Read a blob body by OID.
fn cat_blob(repo: &Path, oid: &str) -> Result<Vec<u8>, String> {
    let out = git_output(repo, &["cat-file", "blob", oid])?;
    if !out.status.success() {
        return Err(format!(
            "cat-file {} failed: {}",
            oid,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// Write `bytes` as a loose blob (`git hash-object -w --stdin`) → its OID.
fn hash_blob(repo: &Path, bytes: &[u8]) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["hash-object", "-w", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("hash-object: {}", e))?;
    child
        .stdin
        .take()
        .ok_or("hash-object: no stdin")?
        .write_all(bytes)
        .map_err(|e| format!("hash-object write: {}", e))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("hash-object wait: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "hash-object failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Write bytes to a uniquely named scratch file carrying the real extension, so
/// extension-based tools (mergiraf) detect the language. Returns the path.
fn write_scratch(scratch: &Path, tag: &str, ext: &str, bytes: &[u8]) -> Option<std::path::PathBuf> {
    let file = scratch.join(format!("{}.{}", tag, ext));
    std::fs::write(&file, bytes).ok()?;
    Some(file)
}

/// How much of an adopted plan the intent corpus carries before it is cut back
/// to the document's prose half.
const PLAN_INTENT_CAP: usize = 12_000;

/// The dash's intent, as the whole corpus a reconciliation is adjudicated
/// against: the maintained draft, the round subjects, the adopted plan
/// document, the base branch's own motion since the merge base, and the two
/// sides' name-status diffs.
///
/// Read by the AI rung of the resolution ladder ([P32]), by the resolver
/// charter, and by the base-motion engine, which puts it in front of an agent
/// being asked to resolve a replay that conflicts — in every case the question
/// is "what is this dash for, and what has the base been doing meanwhile", and
/// the answer is the same one. A draft and a few subjects can say what a dash
/// wanted; they cannot say which of two purposes a conflicting hunk serves,
/// which is the judgment this corpus exists to support.
pub fn resolve_intent(repo: &Path, base_branch: &str, branch: &str) -> String {
    let mut parts = Vec::new();
    if let Some(draft) = crate::ops::dash_draft_message(repo, branch) {
        parts.push(draft);
    }
    if let Ok(subjects) = git_stdout(
        repo,
        &[
            "log",
            "--format=%s",
            &format!("{}..{}", base_branch, branch),
        ],
    ) {
        if !subjects.trim().is_empty() {
            parts.push(format!("Round subjects:\n{}", subjects.trim()));
        }
    }
    if let Some(plan) = dash_plan_text(repo, branch) {
        parts.push(format!("The dash's plan:\n{}", plan));
    }

    // The base's own motion, read from the merge base rather than from
    // `base..branch`: what the other side of this conflict has been doing.
    let fork = git_stdout(repo, &["merge-base", base_branch, branch]).ok();
    if let Some(fork) = fork.as_deref().filter(|f| !f.is_empty()) {
        if let Ok(subjects) = git_stdout(
            repo,
            &["log", "--format=%s", &format!("{}..{}", fork, base_branch)],
        ) {
            if !subjects.trim().is_empty() {
                parts.push(format!(
                    "What {} has done since this dash forked:\n{}",
                    base_branch,
                    subjects.trim()
                ));
            }
        }
        for (label, tip) in [("This dash", branch), ("The base", base_branch)] {
            if let Ok(names) = git_stdout(
                repo,
                &["diff", "--name-status", &format!("{}..{}", fork, tip)],
            ) {
                if !names.trim().is_empty() {
                    parts.push(format!("{} touched:\n{}", label, names.trim()));
                }
            }
        }
    }

    parts.join("\n\n")
}

/// The adopted plan document as the dash branch holds it ([D139]), size-bounded.
///
/// A plan runs to hundreds of lines of execution steps, and the steps are the
/// least useful half for adjudicating a conflict — the prose above them is what
/// states the intent. So an oversized plan is cut at its Execution Steps
/// heading rather than mid-sentence, and only hard-truncated when it has no
/// such heading to cut at.
fn dash_plan_text(repo: &Path, branch: &str) -> Option<String> {
    let rel = config_get(repo, &format!("branch.{}.tugplan", branch))?;
    let text = git_stdout(repo, &["show", &format!("{}:{}", branch, rel)]).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    if text.len() <= PLAN_INTENT_CAP {
        return Some(text);
    }
    if let Some(cut) = text.find("\n### Execution Steps") {
        let head = &text[..cut];
        if head.len() <= PLAN_INTENT_CAP {
            return Some(format!("{}\n\n[execution steps omitted]", head.trim_end()));
        }
    }
    let mut cut = PLAN_INTENT_CAP;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    Some(format!("{}\n\n[truncated]", &text[..cut]))
}

/// Ensure `rerere.enabled` + `rerere.autoUpdate` are set on the repo (idempotent).
pub(crate) fn ensure_rerere_config(repo: &Path) {
    let _ = git_output(repo, &["config", "rerere.enabled", "true"]);
    let _ = git_output(repo, &["config", "rerere.autoUpdate", "true"]);
}

/// Whether a byte body looks binary (a NUL byte in the first 8 KiB).
fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Whether merged text is conflict-free — no `git` conflict markers.
fn is_clean_merge(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    !text.lines().any(|l| {
        l.starts_with("<<<<<<<")
            || l.starts_with("=======")
            || l.starts_with(">>>>>>>")
            || l.starts_with("|||||||")
    })
}

// --- candidate anchoring ---------------------------------------------------

/// The ref a resolved candidate is anchored at.
///
/// A candidate that lives only in a caller's memory dies with the process, and
/// three of them were built and abandoned in one day because of it. A ref
/// survives process death, is visible to every process on the repo, and is a gc
/// root, so the commit cannot be collected while it stands.
pub fn candidate_ref_name(name: &str) -> String {
    format!("refs/tug/join/{}", name)
}

/// The dash head the ladder ran against, recorded because the candidate's own
/// parentage cannot say it (the replay shape parents onto its previous round).
pub fn join_source_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinsource", name)
}

/// Which rung resolved each path, multi-valued as `<path>\t<rung>`.
///
/// The candidate commit records the resolved *bytes* and never the provenance
/// of the decision, so this is the one half of the review payload that cannot
/// be recomputed from git.
pub fn join_resolved_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinresolved", name)
}

impl ResolvedBy {
    /// The stored spelling, matching the wire's kebab-case.
    pub fn as_str(self) -> &'static str {
        match self {
            ResolvedBy::Replay => "replay",
            ResolvedBy::Rerere => "rerere",
            ResolvedBy::MergeFile => "merge-file",
            ResolvedBy::Driver => "driver",
            ResolvedBy::Ai => "ai",
            ResolvedBy::Resolver => "resolver",
        }
    }

    /// Read a stored spelling back.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "replay" => Some(ResolvedBy::Replay),
            "rerere" => Some(ResolvedBy::Rerere),
            "merge-file" => Some(ResolvedBy::MergeFile),
            "driver" => Some(ResolvedBy::Driver),
            "ai" => Some(ResolvedBy::Ai),
            "resolver" => Some(ResolvedBy::Resolver),
            _ => None,
        }
    }
}

/// Anchor a candidate commit at the dash's join ref.
pub fn write_candidate_ref(repo: &Path, name: &str, sha: &str) -> Result<(), String> {
    let out = git_output(repo, &["update-ref", &candidate_ref_name(name), sha])?;
    if !out.status.success() {
        return Err(format!(
            "failed to anchor join candidate for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// The commit the dash's join ref points at, if it stands.
pub fn read_candidate(repo: &Path, name: &str) -> Option<String> {
    let spec = format!("{}^{{commit}}", candidate_ref_name(name));
    let out = git_output(repo, &["rev-parse", "--verify", "--quiet", &spec]).ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

/// Drop the candidate ref. Best-effort: a ref that is already gone is success.
pub fn delete_candidate_ref(repo: &Path, name: &str) {
    let _ = git_output(repo, &["update-ref", "-d", &candidate_ref_name(name)]);
}

/// Read back which rung resolved each path.
pub fn read_resolved_rungs(repo: &Path, name: &str) -> Vec<(String, ResolvedBy)> {
    let out = match git_output(
        repo,
        &["config", "--get-all", &join_resolved_config_key(name)],
    ) {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (path, rung) = line.split_once('\t')?;
            Some((path.to_string(), ResolvedBy::parse(rung)?))
        })
        .collect()
}

/// One resolved path's diff against the base, for a caller rebuilding the
/// review payload from git rather than from the run that produced it.
///
/// The same function the ladder reports with, so a diff recomputed on a later
/// recompute and the diff the ladder first sent are the same bytes.
pub fn candidate_path_diff(
    repo: &Path,
    base_branch: &str,
    candidate: &str,
    path: &str,
) -> Option<CandidateDiff> {
    let base_head = git_stdout(repo, &["rev-parse", base_branch]).ok()?;
    let d = resolution_diff(repo, &base_head, candidate, path)?;
    Some(CandidateDiff {
        text: d.text,
        added: d.added,
        removed: d.removed,
    })
}

/// One path's recomputed diff and the counts describing it.
pub struct CandidateDiff {
    pub text: String,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// Anchor a candidate somebody other than the ladder built, with the dash head
/// it was built against.
///
/// The ladder does this inline at its own success arm; the resolver needs the
/// same act from the workshop, and doing it through one function is what keeps
/// the ref, the source mark, and the cleared stale marks moving together. A
/// half-written set is how a superseded candidate ends up blessed by the marks
/// of the one before it.
pub fn anchor_candidate(
    repo: &Path,
    name: &str,
    candidate: &str,
    dash_head: &str,
) -> Result<(), String> {
    write_candidate_ref(repo, name, candidate)?;
    clear_candidate_marks(repo, name);
    let _ = git_output(repo, &["config", &join_source_config_key(name), dash_head]);
    Ok(())
}

/// Record which rung decided one path, for the candidate that stands.
pub fn record_resolved_rung(repo: &Path, name: &str, path: &str, rung: ResolvedBy) {
    let value = format!("{}\t{}", path, rung.as_str());
    let _ = git_output(
        repo,
        &["config", "--add", &join_resolved_config_key(name), &value],
    );
}

/// Where a candidate's resolver report is pointed from: `<candidate>:<blob>`.
///
/// The report itself is a git blob rather than a config value — it is prose,
/// and prose in `.git/config` is a formatting accident waiting to happen. The
/// config carries the pointer *and* the candidate it describes, which is what
/// makes the report self-demote the moment the candidate does, exactly like the
/// verification verdict beside it.
pub fn report_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinreport", name)
}

/// Why the last resolve stopped short: `<dash_head>:<reason>`.
///
/// Anchored to the dash head rather than to a candidate, because a stuck
/// resolve is precisely the case where no candidate was produced. A new round
/// on the dash moves the head and the reason stops applying, which is the
/// self-demotion every join fact gets.
pub fn stuck_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinstuck", name)
}

/// Store a resolver report for a candidate, as a blob the config points at.
pub fn write_report(repo: &Path, name: &str, candidate: &str, json: &str) -> Result<(), String> {
    let blob = hash_blob(repo, json.as_bytes())?;
    let value = format!("{}:{}", candidate, blob);
    let out = git_output(repo, &["config", &report_config_key(name), &value])?;
    if !out.status.success() {
        return Err(format!(
            "failed to record the resolver report for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Read the resolver report standing for `candidate`, if the stored one
/// describes it.
pub fn read_report(repo: &Path, name: &str, candidate: &str) -> Option<String> {
    let value = config_get(repo, &report_config_key(name))?;
    let (for_candidate, blob) = value.split_once(':')?;
    if for_candidate != candidate {
        return None;
    }
    git_stdout(repo, &["cat-file", "blob", blob]).ok()
}

/// Record why a resolve stopped short, against the dash head it ran on.
pub fn write_stuck(repo: &Path, name: &str, dash_head: &str, reason: &str) {
    let one_line = reason.replace('\n', " ");
    let value = format!("{}:{}", dash_head, one_line);
    let _ = git_output(repo, &["config", &stuck_config_key(name), &value]);
}

/// The standing stuck reason, if one describes the dash's current head.
pub fn read_stuck(repo: &Path, name: &str, dash_head: &str) -> Option<String> {
    let value = config_get(repo, &stuck_config_key(name))?;
    let (for_head, reason) = value.split_once(':')?;
    if for_head != dash_head {
        return None;
    }
    Some(reason.to_string())
}

/// Drop the standing stuck reason — what a resolve does when it starts, so a
/// retry never renders under the last attempt's refusal.
pub fn clear_stuck(repo: &Path, name: &str) {
    let _ = git_output(repo, &["config", "--unset-all", &stuck_config_key(name)]);
}

/// Where the escalation a resolve is blocked on is pointed from:
/// `<dash_head>:<blob>`.
///
/// The question itself is a git blob rather than a config value, for the
/// reason the report is: it is model-authored prose with quotes and newlines
/// in it, and a config value is the wrong container for that — the shape that
/// forced the change was a question whose own apostrophes did not survive the
/// round trip. Anchored to the *dash head* rather than a candidate, because a
/// question exists precisely when there is no candidate yet.
pub fn question_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinquestion", name)
}

/// Record the question a resolve is blocked on, so a reload re-renders it.
pub fn write_question(repo: &Path, name: &str, dash_head: &str, json: &str) {
    let Ok(blob) = hash_blob(repo, json.as_bytes()) else {
        return;
    };
    let value = format!("{}:{}", dash_head, blob);
    let _ = git_output(repo, &["config", &question_config_key(name), &value]);
}

/// The standing question, if one describes the dash's current head.
pub fn read_question(repo: &Path, name: &str, dash_head: &str) -> Option<String> {
    let value = config_get(repo, &question_config_key(name))?;
    let (for_head, blob) = value.split_once(':')?;
    if for_head != dash_head {
        return None;
    }
    git_stdout(repo, &["cat-file", "blob", blob]).ok()
}

/// Drop the standing question — what answering, expiring, or starting a fresh
/// resolve each do.
pub fn clear_question(repo: &Path, name: &str) {
    let _ = git_output(repo, &["config", "--unset-all", &question_config_key(name)]);
}

/// Clear every mark that describes a candidate, without touching the ref.
fn clear_candidate_marks(repo: &Path, name: &str) {
    for key in [
        join_source_config_key(name),
        join_resolved_config_key(name),
        report_config_key(name),
    ] {
        let _ = git_output(repo, &["config", "--unset-all", &key]);
    }
}

/// Drop a candidate and everything that described it, as one act.
///
/// The ref and the marks are written and cleared as a group so a half-written
/// set cannot outlive a candidate — a stale verification verdict would report
/// a green about a tree nobody built, and a stale report would describe a
/// resolution nobody made.
pub fn clear_candidate(repo: &Path, name: &str) {
    delete_candidate_ref(repo, name);
    clear_candidate_marks(repo, name);
    crate::verify::clear_verification(repo, name);
}

/// Whether the anchored candidate still describes the current heads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CandidateStatus {
    /// No candidate ref stands.
    None,
    /// The ref stands and both checks pass.
    Valid(String),
    /// The ref stood but failed verification; the sentence names which side moved.
    Stale(String),
}

/// [`candidate_status`] for a caller that does not already hold the base
/// branch, resolving it the same way every other dash verb does.
pub fn candidate_status_in(repo: &Path, name: &str) -> Result<CandidateStatus, String> {
    let base = dash_base(repo, name)?;
    Ok(candidate_status(repo, name, &base))
}

/// Verify the anchored candidate against the current base and dash heads.
///
/// **Ancestry, not parenthood.** The squash shape builds its candidate directly
/// on the base head, but the replay shape returns the tip of a chain of replayed
/// rounds whose parent is the previous round — so a parent-equality test would
/// call every multi-round replay candidate stale. Ancestry is also exactly what
/// the join demands (`git merge --ff-only`), which is what keeps this verdict and
/// the join's verdict from ever disagreeing.
pub fn candidate_status(repo: &Path, name: &str, base_branch: &str) -> CandidateStatus {
    let candidate = match read_candidate(repo, name) {
        Some(c) => c,
        None => return CandidateStatus::None,
    };

    let base_head = match git_stdout(repo, &["rev-parse", base_branch]) {
        Ok(h) => h,
        Err(_) => return CandidateStatus::None,
    };
    let ancestor = git_output(
        repo,
        &["merge-base", "--is-ancestor", &base_head, &candidate],
    )
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !ancestor {
        return CandidateStatus::Stale(format!(
            "{} moved since this was resolved — resolve again",
            base_branch
        ));
    }

    let branch = branch_name(name);
    let dash_head = match git_stdout(repo, &["rev-parse", &branch]) {
        Ok(h) => h,
        Err(_) => return CandidateStatus::None,
    };
    match config_get(repo, &join_source_config_key(name)) {
        Some(source) if source == dash_head => CandidateStatus::Valid(candidate),
        _ => CandidateStatus::Stale(
            "the dash has moved since this was resolved — resolve again".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn set(dir: &Path, rel: &str, content: &str) {
        std::fs::write(dir.join(rel), content).unwrap();
    }

    /// A repo on `main` with base commit `A`, a `tugdash/demo` dash, and helpers
    /// wired (user config, rerere off by default — tests opt in).
    fn init(rounds_on_branch: &[(&str, &str, &str)]) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        set(repo, "f.txt", "A\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        git(repo, &["config", "branch.tugdash/demo.tugbase", "main"]);
        // Rounds land on the branch (checked out via a switch, no worktree).
        git(repo, &["switch", "-q", "tugdash/demo"]);
        for (rel, content, msg) in rounds_on_branch {
            set(repo, rel, content);
            git(repo, &["add", "-A"]);
            git(repo, &["commit", "-m", msg]);
        }
        git(repo, &["switch", "-q", "main"]);
        temp
    }

    /// Configure rung 4 with a stub that resolves every conflict to `body`.
    /// `<base> <ours> <theirs> <output> <ext>` → write the output.
    fn stub_driver(repo: &Path, body: &str) {
        let stub = repo.join("stub-driver.sh");
        std::fs::write(&stub, format!("#!/bin/sh\nprintf '%s' '{body}' > \"$4\"\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(
            repo,
            &["config", "tugdash.mergedriver", &stub.to_string_lossy()],
        );
    }

    // ---- unit rungs ----

    #[test]
    fn merge_file_rung_resolves_disjoint_edits_and_declines_overlap() {
        let scratch = tempfile::tempdir().unwrap();
        let disjoint = LoadedStages {
            base: Some(b"l1\nl2\nl3\n".to_vec()),
            ours: Some(b"X\nl2\nl3\n".to_vec()),
            theirs: Some(b"l1\nl2\nY\n".to_vec()),
        };
        let merged = merge_file_rung(scratch.path(), "f.txt", &disjoint).expect("disjoint merges");
        let text = String::from_utf8_lossy(&merged);
        assert!(
            text.contains("X") && text.contains("Y"),
            "both edits present: {text}"
        );
        assert!(is_clean_merge(&merged));

        let overlap = LoadedStages {
            base: Some(b"A\n".to_vec()),
            ours: Some(b"B\n".to_vec()),
            theirs: Some(b"C\n".to_vec()),
        };
        assert!(
            merge_file_rung(scratch.path(), "f.txt", &overlap).is_none(),
            "overlap declines"
        );
    }

    #[test]
    fn is_binary_and_clean_merge_detectors() {
        assert!(is_binary(b"ab\0cd"));
        assert!(!is_binary(b"plain text\n"));
        assert!(is_clean_merge(b"resolved\n"));
        assert!(!is_clean_merge(
            b"a\n<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\n"
        ));
    }

    // ---- ladder end-to-end ----

    #[test]
    fn replay_probe_resolves_base_already_advanced_and_lands_replay_shape() {
        // branch: A→B→C. main separately advances A→B (same as round 1), so the
        // one-shot squash conflicts (B vs C) but round-by-round replay is clean.
        let temp = init(&[("f.txt", "B\n", "r1"), ("f.txt", "C\n", "r2")]);
        let repo = temp.path();
        set(repo, "f.txt", "B\n");
        git(repo, &["commit", "-am", "main advances to B"]);

        // Sanity: the plain squash really does conflict.
        let (_t, stages) = merge_tree_stages(repo, "main", "tugdash/demo").unwrap();
        assert!(!stages.is_empty(), "squash conflicts");

        // The probe names each round it rebuilt, oldest first.
        let rounds = git_stdout(repo, &["rev-list", "--reverse", "main..tugdash/demo"]).unwrap();
        let rounds: Vec<&str> = rounds.lines().filter(|l| !l.trim().is_empty()).collect();
        let base_head = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        let replayed = replay_probe(repo, &base_head, "main", "tugdash/demo")
            .unwrap()
            .expect("clean replay");
        assert_eq!(replayed.mapping.len(), rounds.len());
        for (i, (old, new)) in replayed.mapping.iter().enumerate() {
            assert_eq!(
                old, rounds[i],
                "pair {i} keeps the original round, in order"
            );
            assert_ne!(old, new, "the round was rebuilt onto the moved base");
            // Each rebuilt commit is reachable from the replayed head.
            let ok = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["merge-base", "--is-ancestor", new, &replayed.head])
                .status()
                .unwrap()
                .success();
            assert!(ok, "rebuilt commit {new} is under the replayed head");
        }
        assert_eq!(
            replayed.mapping.last().map(|(_, new)| new.as_str()),
            Some(replayed.head.as_str()),
            "the head is the last round's rebuilt commit"
        );

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert_eq!(outcome.shape, JoinShape::Replay);
        assert!(outcome.unresolved.is_empty());
        let candidate = outcome.candidate_commit.expect("replay candidate");
        // The candidate's f.txt is the dash's final state, C.
        let show = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show", &format!("{candidate}:f.txt")])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&show.stdout), "C\n");
    }

    #[test]
    fn unresolvable_overlap_leaves_no_candidate() {
        // branch A→B; main A→C. Overlapping single-line change, no rerere/driver.
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert!(outcome.candidate_commit.is_none(), "no candidate");
        assert_eq!(outcome.unresolved, vec!["f.txt".to_string()]);
    }

    #[test]
    fn delete_modify_short_circuits_to_unresolved() {
        // branch modifies f.txt; main deletes it → delete/modify (non-content).
        let temp = init(&[("f.txt", "B\n", "modify")]);
        let repo = temp.path();
        std::fs::remove_file(repo.join("f.txt")).unwrap();
        git(repo, &["commit", "-am", "main deletes f.txt"]);

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert!(outcome.candidate_commit.is_none());
        assert_eq!(outcome.unresolved, vec!["f.txt".to_string()]);
        assert!(outcome.resolved.is_empty());
    }

    #[test]
    fn delete_modify_is_not_claimed_by_rerere() {
        // Same shape as the test above, but with a populated `rr-cache` so rung 2
        // actually runs — `rerere_rung` early-returns on an empty cache, which is
        // why every other test in this module is blind to what it does here.
        let temp = init(&[("f.txt", "B\n", "modify")]);
        let repo = temp.path();
        ensure_rerere_config(repo);
        let base = git_stdout(repo, &["rev-parse", "HEAD"]).unwrap();

        // Seed the cache with a genuine recorded resolution on an unrelated file,
        // then rewind — `rr-cache` survives the reset.
        git(repo, &["switch", "-q", "-c", "seed"]);
        set(repo, "g.txt", "S\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "seed side"]);
        git(repo, &["switch", "-q", "main"]);
        set(repo, "g.txt", "M\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "main side"]);
        let _ = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["merge", "--no-edit", "seed"])
            .status();
        set(repo, "g.txt", "R\n");
        git(repo, &["add", "g.txt"]);
        git(repo, &["commit", "--no-edit", "-m", "resolve g"]);
        git(repo, &["reset", "--hard", &base]);
        assert!(has_rr_cache(repo), "rr-cache seeded");

        // main deletes f.txt; the branch modified it → delete/modify.
        std::fs::remove_file(repo.join("f.txt")).unwrap();
        git(repo, &["commit", "-am", "main deletes f.txt"]);

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert!(
            outcome.resolved.is_empty(),
            "rerere resolved nothing here; a delete/modify is marker-free by \
             construction and must not be harvested as resolved: {:?}",
            outcome
                .resolved
                .iter()
                .map(|r| (&r.path, r.resolved_by))
                .collect::<Vec<_>>()
        );
        assert_eq!(outcome.unresolved, vec!["f.txt".to_string()]);
        assert!(
            outcome.candidate_commit.is_none(),
            "a candidate here would be the base tree — an empty squash"
        );
    }

    #[test]
    fn driver_rung_resolves_via_configured_stub() {
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);

        stub_driver(repo, "DRIVER\n");

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        let candidate = outcome
            .candidate_commit
            .expect("driver produced a candidate");
        assert_eq!(outcome.resolved.len(), 1);
        assert_eq!(outcome.resolved[0].resolved_by, ResolvedBy::Driver);
        let show = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show", &format!("{candidate}:f.txt")])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&show.stdout), "DRIVER\n");
    }

    #[test]
    fn a_resolution_carries_the_diff_it_would_land() {
        // The driver stub resolves f.txt to DRIVER; main is at C. The review the
        // join face gates on is this diff, so the outcome has to carry it.
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);
        stub_driver(repo, "DRIVER\n");

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        let resolution = &outcome.resolved[0];
        let diff = resolution
            .diff
            .as_deref()
            .expect("a landable resolution carries its diff");
        // What the join does to this file, both sides of it: C leaves, DRIVER lands.
        assert!(diff.contains("-C"), "the base's line leaving: {diff}");
        assert!(diff.contains("+DRIVER"), "the resolution joining: {diff}");
        assert!(diff.contains("f.txt"), "the path in the header: {diff}");
        // One line out, one line in — git's count, beside the text it describes.
        assert_eq!((resolution.added, resolution.removed), (Some(1), Some(1)));

        // A partial outcome lands nothing, so it has nothing to review — and
        // nothing to count either.
        let temp2 = init(&[("f.txt", "B\n", "r1")]);
        let repo2 = temp2.path();
        set(repo2, "f.txt", "C\n");
        git(repo2, &["commit", "-am", "main to C"]);
        let partial = resolve_conflicts(repo2, "demo", None).unwrap();
        assert!(partial.candidate_commit.is_none());
        assert!(partial.resolved.iter().all(|r| r.diff.is_none()));
        assert!(
            partial
                .resolved
                .iter()
                .all(|r| r.added.is_none() && r.removed.is_none())
        );
    }

    #[test]
    fn a_capped_diff_still_reports_the_whole_resolution() {
        // The `+0 −395` incident, pinned. A large file on the base resolved to a
        // one-line body produces a diff whose deletions alone overrun the cap —
        // and git emits deletions before additions, so the single `+` line, the
        // driver's actual decision, falls past it. Counting the text you can see
        // therefore reports a resolution that removed everything and added
        // nothing, which is the opposite of what would land.
        let big: String = (1..=2050).map(|i| format!("line {i}\n")).collect();
        let temp = init(&[("f.txt", "dash side — the whole file, rewritten\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", &big);
        git(repo, &["commit", "-am", "main grows f.txt past the cap"]);
        stub_driver(repo, "DRIVER\n");

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        let resolution = &outcome.resolved[0];
        assert_eq!(resolution.resolved_by, ResolvedBy::Driver);
        let diff = resolution.diff.as_deref().expect("a resolution to review");

        // The text really is truncated — the premise of the whole test.
        assert!(
            diff.contains("more lines"),
            "the cap should have bitten: {}",
            &diff[..diff.len().min(200)]
        );
        assert!(
            !diff.contains("+DRIVER"),
            "the addition falls past the cap — if it does not, this test no \
             longer covers the case it was written for"
        );

        // …and the counts are still git's, over the whole diff. This is the
        // assertion the face's stat now rests on.
        assert_eq!(
            (resolution.added, resolution.removed),
            (Some(1), Some(2050))
        );
    }

    #[test]
    fn ai_rung_resolves_and_validates_marker_free() {
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);

        struct FakeAi;
        impl FileMerger for FakeAi {
            fn merge(&self, _req: &FileMergeRequest) -> Option<Vec<u8>> {
                Some(b"AI-MERGED\n".to_vec())
            }
        }
        let outcome = resolve_conflicts(repo, "demo", Some(&FakeAi)).unwrap();
        assert_eq!(outcome.resolved.len(), 1);
        assert_eq!(outcome.resolved[0].resolved_by, ResolvedBy::Ai);
        assert!(outcome.candidate_commit.is_some());

        // A marker-bearing AI reply is rejected → unresolved. A fresh repo, so
        // the good run above (which taught rerere) can't replay here.
        let temp2 = init(&[("f.txt", "B\n", "r1")]);
        let repo2 = temp2.path();
        set(repo2, "f.txt", "C\n");
        git(repo2, &["commit", "-am", "main to C"]);
        struct BadAi;
        impl FileMerger for BadAi {
            fn merge(&self, _req: &FileMergeRequest) -> Option<Vec<u8>> {
                Some(b"<<<<<<< ours\nB\n=======\nC\n>>>>>>> theirs\n".to_vec())
            }
        }
        let bad = resolve_conflicts(repo2, "demo", Some(&BadAi)).unwrap();
        assert!(bad.candidate_commit.is_none());
        assert_eq!(bad.unresolved, vec!["f.txt".to_string()]);
    }

    #[test]
    fn rerere_replays_a_recorded_resolution() {
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        ensure_rerere_config(repo);
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);
        let main_c = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        // Record: a real merge conflicts, we resolve to R and commit → rerere
        // learns the preimage→resolution. Then reset main back to C.
        let _ = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["merge", "--no-edit", "tugdash/demo"])
            .status();
        set(repo, "f.txt", "R\n");
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--no-edit", "-m", "resolve"]);
        git(repo, &["reset", "--hard", &main_c]);

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert_eq!(outcome.resolved.len(), 1, "rerere resolved f.txt");
        assert_eq!(outcome.resolved[0].resolved_by, ResolvedBy::Rerere);
        let candidate = outcome.candidate_commit.expect("rerere candidate");
        let show = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show", &format!("{candidate}:f.txt")])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&show.stdout), "R\n");
    }

    // ---- candidate anchoring ----

    #[test]
    fn squash_candidate_anchors_at_the_ref_and_verifies_valid() {
        // branch A→B, main A→C, stub driver resolves → squash-shape candidate.
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);
        stub_driver(repo, "RESOLVED\n");

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert_eq!(outcome.shape, JoinShape::Squash);
        let candidate = outcome.candidate_commit.clone().expect("candidate");

        assert_eq!(
            read_candidate(repo, "demo").as_deref(),
            Some(candidate.as_str()),
            "the ref points at the candidate the ladder built"
        );
        assert_eq!(
            candidate_status(repo, "demo", "main"),
            CandidateStatus::Valid(candidate)
        );
    }

    #[test]
    fn replay_candidate_verifies_valid_though_its_parent_is_not_the_base() {
        // The multi-round replay shape: the candidate is the tip of a chain of
        // replayed rounds, so its *parent* is the previous round rather than
        // the base head. A parent-equality rule would call this stale; ancestry
        // is the rule that gets it right, and it is the rule the join uses.
        let temp = init(&[("f.txt", "B\n", "r1"), ("f.txt", "C\n", "r2")]);
        let repo = temp.path();
        set(repo, "f.txt", "B\n");
        git(repo, &["commit", "-am", "main advances to B"]);

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert_eq!(outcome.shape, JoinShape::Replay);
        let candidate = outcome.candidate_commit.clone().expect("candidate");

        let base_head = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        let parent = git_stdout(repo, &["rev-parse", &format!("{candidate}^")]).unwrap();
        assert_ne!(
            parent, base_head,
            "precondition: the replay candidate does NOT parent onto the base"
        );

        assert_eq!(
            candidate_status(repo, "demo", "main"),
            CandidateStatus::Valid(candidate),
            "ancestry accepts what parenthood would have rejected"
        );
    }

    #[test]
    fn worktree_dirt_committed_by_the_preamble_still_yields_a_valid_candidate() {
        // The dash head the ladder records must be read AFTER the preamble
        // commits the worktree's dirt — that preamble moves the dash head as
        // part of resolving, so a pre-preamble reading marks every candidate
        // stale the instant it is built.
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);
        stub_driver(repo, "RESOLVED\n");

        let worktree = repo.join(".tug").join("worktrees").join("demo");
        std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        git(
            repo,
            &[
                "worktree",
                "add",
                &worktree.to_string_lossy(),
                "tugdash/demo",
            ],
        );
        let head_before = git_stdout(repo, &["rev-parse", "tugdash/demo"]).unwrap();
        set(&worktree, "extra.txt", "dirt\n");

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        let candidate = outcome.candidate_commit.clone().expect("candidate");

        let head_after = git_stdout(repo, &["rev-parse", "tugdash/demo"]).unwrap();
        assert_ne!(
            head_before, head_after,
            "precondition: the preamble moved the dash head"
        );
        assert_eq!(
            candidate_status(repo, "demo", "main"),
            CandidateStatus::Valid(candidate),
            "the recorded source is the post-preamble head"
        );
    }

    #[test]
    fn a_moved_base_and_a_moved_dash_each_get_their_own_stale_sentence() {
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);
        stub_driver(repo, "RESOLVED\n");
        resolve_conflicts(repo, "demo", None).unwrap();

        // The base advances past the candidate.
        set(repo, "other.txt", "later\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "main moves on"]);
        match candidate_status(repo, "demo", "main") {
            CandidateStatus::Stale(note) => {
                assert!(note.contains("main"), "names the base: {note}");
            }
            other => panic!("expected stale after base motion, got {other:?}"),
        }

        // Rebuild against the moved base, then move the dash instead.
        resolve_conflicts(repo, "demo", None).unwrap();
        assert!(matches!(
            candidate_status(repo, "demo", "main"),
            CandidateStatus::Valid(_)
        ));
        git(repo, &["switch", "-q", "tugdash/demo"]);
        set(repo, "dash-extra.txt", "r2\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "r2"]);
        git(repo, &["switch", "-q", "main"]);
        match candidate_status(repo, "demo", "main") {
            CandidateStatus::Stale(note) => {
                assert!(note.contains("dash"), "names the dash: {note}");
            }
            other => panic!("expected stale after dash motion, got {other:?}"),
        }
    }

    #[test]
    fn a_partial_resolve_clears_a_previously_anchored_candidate() {
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);
        stub_driver(repo, "RESOLVED\n");
        resolve_conflicts(repo, "demo", None).unwrap();
        assert!(read_candidate(repo, "demo").is_some(), "anchored");

        // Drop the driver so the same conflict now resolves nothing.
        git(repo, &["config", "--unset", "tugdash.mergedriver"]);
        git(repo, &["config", "rerere.enabled", "false"]);
        let again = resolve_conflicts(repo, "demo", None).unwrap();
        assert!(again.candidate_commit.is_none(), "partial outcome");
        assert_eq!(
            read_candidate(repo, "demo"),
            None,
            "the superseded candidate does not stand"
        );
        assert!(read_resolved_rungs(repo, "demo").is_empty());
        assert_eq!(config_get(repo, &join_source_config_key("demo")), None);
    }

    #[test]
    fn resolved_rungs_round_trip_through_config() {
        let temp = init(&[("f.txt", "B\n", "r1"), ("g.txt", "G\n", "r2")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "main to C"]);
        stub_driver(repo, "RESOLVED\n");

        let outcome = resolve_conflicts(repo, "demo", None).unwrap();
        assert!(outcome.candidate_commit.is_some());
        let stored = read_resolved_rungs(repo, "demo");
        assert_eq!(stored.len(), outcome.resolved.len(), "one value per file");
        for r in &outcome.resolved {
            assert!(
                stored
                    .iter()
                    .any(|(p, by)| p == &r.path && *by == r.resolved_by),
                "{} kept its rung",
                r.path
            );
        }
    }
}
