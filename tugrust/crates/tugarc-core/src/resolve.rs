//! The per-file merge rungs, run over a merge of two live arcs' tips when they
//! cross ([`resolve_pair`]), and the checkout a resolver finishes the rest in
//! ([`PairCheckout`]).
//!
//! Nothing here touches a checkout anybody is using, and nothing here commits:
//! the shared rerere cache is the only thing written. A crossing settled here
//! is recalled later wherever git meets the same hunk with rerere on — the
//! base-motion replay, and the rebase an audit stage runs.
//!
//! The rungs, in order:
//!
//! 1. **rerere** — a scratch detached worktree replays previously recorded
//!    conflict resolutions (shared `rr-cache`).
//! 2. **merge-file** — an opportunistic per-file 3-way re-merge (histogram).
//! 3. **structured-merge driver** — a PATH-discovered, configurable command
//!    (mergiraf by default), never bundled.
//! 4. **AI** ([P32]) — the [`FileMerger`] seam; tugcast injects the scribe.
//!
//! Every machine merge is held to one bar: marker-free, and every clean segment
//! of `git merge-file`'s marker output kept verbatim and in order. Non-content
//! conflicts (delete/modify, binary, mode) short-circuit straight to
//! unresolved — text tools never guess at structure.
//!
//! The join once ran a ladder of its own over an arc and its base and landed
//! a candidate commit; a ready arc's audit now verifies the exact tree a join
//! lands, so the join is a squash and nothing here serves it. What that ladder
//! left in repositories is collected by [`crate::residue`].

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use tugcore::instance::Paths;

use serde::Serialize;

use crate::error::ArcError;
use crate::ops::{git_output, git_stdout};

/// Which rung settled a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResolvedBy {
    /// A previously recorded `rerere` resolution replayed.
    Rerere,
    /// `git merge-file` re-merged the three blobs cleanly.
    MergeFile,
    /// A structured-merge driver (mergiraf or a configured command) resolved it.
    Driver,
    /// The AI file-merge seam ([P32]) produced a validated result.
    Ai,
}

/// One conflicted file's three blob stages plus the arc's intent, handed to the
/// AI rung ([P32]). `base` is `None` for an add/add conflict.
pub struct FileMergeRequest {
    pub path: String,
    pub base: Option<Vec<u8>>,
    pub ours: Option<Vec<u8>>,
    pub theirs: Option<Vec<u8>>,
    /// The arc's maintained draft + round subjects — what the arc was doing.
    pub intent: String,
}

/// The most characters any one side of a conflicted file may carry into the
/// AI rung's one-shot merge. A file over it is declined, never cut: a model
/// asked to write a whole file and shown part of one writes the part it saw,
/// so the rung leaves such a file unresolved for the multi-turn resolver,
/// which works the hunks in a checkout. Not raised: a bigger cap is only a
/// bigger file on the far side of it.
pub const ONE_SHOT_MERGE_CAP_CHARS: usize = 60_000;

/// What the AI rung says when it declines a file over the cap.
pub const TOO_LARGE_FOR_ONE_SHOT: &str = "too large for a one-shot merge";

impl FileMergeRequest {
    /// Whether any of the three sides is over [`ONE_SHOT_MERGE_CAP_CHARS`].
    pub fn exceeds_one_shot_cap(&self) -> bool {
        [&self.base, &self.ours, &self.theirs]
            .into_iter()
            .flatten()
            .any(|bytes| exceeds_one_shot_cap(bytes))
    }
}

/// Whether one side of a conflicted file is over [`ONE_SHOT_MERGE_CAP_CHARS`],
/// counted in characters as the prompt carries it.
pub fn exceeds_one_shot_cap(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes).chars().count() > ONE_SHOT_MERGE_CAP_CHARS
}

/// The AI rung's seam ([P32]). tugcast implements it with the scribe sidecar;
/// the `tugarc` CLI passes `None`. A `None` return leaves the file unresolved.
pub trait FileMerger: Send + Sync {
    fn merge(&self, req: &FileMergeRequest) -> Option<Vec<u8>>;
}

/// Whether `git` here supports `merge-tree --merge-base` (git ≥ 2.40).
///
/// Asked through `tugcore::host_tools`, never by running `git --version` here:
/// on a Mac with no developer directory the `git` on `PATH` is Apple's shim,
/// and running it pops the install modal.
pub(crate) fn git_supports_merge_base_flag() -> bool {
    tugcore::host_tools::git_version_at_least(2, 40)
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
) -> Result<(String, BTreeMap<String, RawStages>), ArcError> {
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

/// The conflicted paths and a fingerprint of the conflict's content — the
/// stage oids of every conflicted path, in path order. Two merges with the
/// same fingerprint face byte-identical conflicts, so a resolution taught for
/// one covers the other and settling the second is wasted work; a fingerprint
/// that moved is a conflict that changed and wants settling afresh. Reads
/// objects only.
pub(crate) fn conflict_fingerprint(
    repo: &Path,
    ours: &str,
    theirs: &str,
) -> Result<(Vec<String>, String), ArcError> {
    let (_, stages) = merge_tree_stages(repo, ours, theirs)?;
    let oid = |s: &Option<(String, String)>| {
        s.as_ref()
            .map(|(_, o)| o.as_str())
            .unwrap_or("-")
            .to_string()
    };
    // The two sides are sorted, not kept as ours/theirs: `probe_pair` names the
    // rounding arc "ours", so the same standing conflict is read with the sides
    // swapped from one arc's round to the other's. A sorted pair reads the same
    // either way, which is what lets a round of the far arc match the record.
    let fingerprint = stages
        .iter()
        .map(|(path, raw)| {
            let mut sides = [oid(&raw.ours), oid(&raw.theirs)];
            sides.sort();
            format!("{path}\t{}\t{}\t{}", oid(&raw.base), sides[0], sides[1])
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok((stages.into_keys().collect(), fingerprint))
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

pub(crate) fn has_rr_cache(repo: &Path) -> bool {
    rr_cache_dir(repo)
        .and_then(|path| std::fs::read_dir(path).ok())
        .is_some_and(|mut d| d.next().is_some())
}

/// How many resolutions the shared rerere cache holds — every `postimage`
/// file under every entry, so a re-settled resolution git numbers
/// `postimage.1` counts too. It only grows while the cache learns, which is
/// what a reader holding an earlier count needs: a different count means
/// something was taught since.
pub fn rr_cache_learned(repo: &Path) -> usize {
    let Some(dir) = rr_cache_dir(repo) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read_dir(entry.path()).ok())
        .flat_map(|files| files.flatten())
        .filter(|file| {
            file.file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("postimage"))
        })
        .count()
}

/// The repository's `rr-cache` directory, resolved through git.
fn rr_cache_dir(repo: &Path) -> Option<std::path::PathBuf> {
    let dir = git_stdout(repo, &["rev-parse", "--git-path", "rr-cache"]).unwrap_or_default();
    if dir.is_empty() {
        return None;
    }
    Some(if Path::new(&dir).is_absolute() {
        std::path::PathBuf::from(&dir)
    } else {
        repo.join(&dir)
    })
}

/// A scratch detached worktree that removes itself on drop.
pub(crate) struct ScratchWorktree {
    repo: std::path::PathBuf,
    dir: tempfile::TempDir,
}

impl ScratchWorktree {
    pub(crate) fn open(repo: &Path, at: &str) -> Result<Self, ArcError> {
        let dir = tempfile::tempdir()
            .map_err(|e| ArcError::io("scratch tempdir", std::env::temp_dir(), e))?;
        let path = dir.path().to_string_lossy();
        let args = ["worktree", "add", "--detach", &path, at];
        let out = git_output(repo, &args)?;
        if !out.status.success() {
            return Err(ArcError::git(
                "",
                &args,
                String::from_utf8_lossy(&out.stderr).trim(),
            ));
        }
        Ok(Self {
            repo: repo.to_path_buf(),
            dir,
        })
    }

    pub(crate) fn path(&self) -> &Path {
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
// The pair ladder — a crossing between two live arcs
// ---------------------------------------------------------------------------

/// What the pair ladder settled for a merge of two arc tips.
#[derive(Debug, Clone, Default)]
pub struct PairResolution {
    /// Each path a rung settled, and which rung.
    pub resolved: Vec<(String, ResolvedBy)>,
    /// The paths no rung settled, in path order.
    pub unresolved: Vec<String>,
    pub warnings: Vec<String>,
    /// The merge tree with every settled path patched in; the unresolved
    /// paths still carry their markers. `None` only when nothing conflicted.
    pub staged_tree: Option<String>,
}

/// Run the per-file rungs over a merge of `ours` and `theirs`, and teach the
/// shared rerere cache every resolution it did not already hold.
///
/// The join ladder's rungs from rerere down, over a pair of arc tips rather
/// than an arc and its base. Neither tip moves and nothing is committed: the
/// cache is the only thing written, so the join that later meets the same
/// hunks replays them through rung 2. Replay, salvage and the candidate
/// belong to a join and have no meaning between two live arcs. Every rung
/// that settles a path teaches it, the three-way merge included, because the
/// join's own three-way merge runs against a different base and may not
/// settle the same hunk.
pub fn resolve_pair(
    repo: &Path,
    ours: &str,
    theirs: &str,
    merger: Option<&dyn FileMerger>,
    intent: &str,
) -> Result<PairResolution, ArcError> {
    let (cand_tree, stages) = merge_tree_stages(repo, ours, theirs)?;
    if stages.is_empty() {
        return Ok(PairResolution::default());
    }
    let scratch = tempfile::tempdir()
        .map_err(|e| ArcError::io("resolve pair: tempdir", std::env::temp_dir(), e))?;
    let mut warnings = Vec::new();
    let replayed = rerere_rung(repo, ours, theirs, &stages, &mut warnings);

    let mut resolved: Vec<ResolvedFile> = Vec::new();
    let mut unresolved = Vec::new();
    for (path, raw) in &stages {
        let mut settle = |by: ResolvedBy, blob_oid: String| {
            resolved.push(ResolvedFile {
                path: path.clone(),
                by,
                blob_oid,
                mode: raw.merged_mode(),
            });
        };
        if let Some(oid) = replayed.get(path) {
            settle(ResolvedBy::Rerere, oid.clone());
            continue;
        }
        let Some(loaded) = raw.load(repo) else {
            unresolved.push(path.clone());
            continue;
        };
        let merged = merge_file_rung(scratch.path(), path, &loaded)
            .map(|bytes| (ResolvedBy::MergeFile, bytes))
            .or_else(|| {
                driver_rung(repo, scratch.path(), path, &loaded)
                    .map(|bytes| (ResolvedBy::Driver, bytes))
            })
            .or_else(|| {
                let req = FileMergeRequest {
                    path: path.clone(),
                    base: loaded.base.clone(),
                    ours: loaded.ours.clone(),
                    theirs: loaded.theirs.clone(),
                    intent: intent.to_string(),
                };
                if req.exceeds_one_shot_cap() {
                    return None;
                }
                let bytes = merger?.merge(&req);
                match scribe_declined(scratch.path(), path, &loaded, bytes.as_deref()) {
                    None => bytes.map(|bytes| (ResolvedBy::Ai, bytes)),
                    Some(_) => None,
                }
            });
        match merged {
            Some((by, bytes)) => settle(by, hash_blob(repo, &bytes)?),
            None => unresolved.push(path.clone()),
        }
    }

    let taught: Vec<&ResolvedFile> = resolved
        .iter()
        .filter(|r| r.by != ResolvedBy::Rerere)
        .collect();
    if !taught.is_empty() {
        record_rerere(repo, ours, theirs, &taught, &mut warnings);
    }
    let staged_tree = patch_tree(repo, scratch.path(), &cand_tree, &resolved)?;
    Ok(PairResolution {
        resolved: resolved.into_iter().map(|r| (r.path, r.by)).collect(),
        unresolved,
        warnings,
        staged_tree: Some(staged_tree),
    })
}

/// A checkout of a merge of two arc tips, for the resolver to finish what the
/// pair ladder could not.
///
/// A detached scratch worktree at `ours` with `theirs` merged in and left
/// uncommitted, so rerere has recorded every conflict's preimage, and with
/// the ladder's settled paths written over their markers. Removed on drop;
/// nothing in it is ever committed, and no ref moves.
pub struct PairCheckout {
    scratch: ScratchWorktree,
    ours: String,
    theirs: String,
}

impl PairCheckout {
    pub fn open(
        repo: &Path,
        ours: &str,
        theirs: &str,
        settled: &PairResolution,
    ) -> Result<Self, ArcError> {
        ensure_rerere_config(repo);
        let scratch = ScratchWorktree::open(repo, ours)?;
        // A conflicting merge is the point; its exit status says nothing.
        let _ = git_output(scratch.path(), &["merge", "--no-commit", "--no-ff", theirs]);
        if let Some(tree) = &settled.staged_tree {
            for (path, _) in &settled.resolved {
                let bytes = git_output(repo, &["cat-file", "blob", &format!("{tree}:{path}")])?;
                std::fs::write(scratch.path().join(path), &bytes.stdout).map_err(|e| {
                    ArcError::io("pair checkout: write", scratch.path().join(path), e)
                })?;
            }
        }
        Ok(Self {
            scratch,
            ours: ours.to_string(),
            theirs: theirs.to_string(),
        })
    }

    pub fn path(&self) -> &Path {
        self.scratch.path()
    }

    /// Teach the cache the files the resolver finished, or say why not.
    ///
    /// Held to the bar every machine merge meets: a finished file must be
    /// marker-free and keep every clean segment of the pair's merge. A
    /// refusal teaches nothing, so a bad resolution never reaches a join.
    ///
    /// And a path rerere cannot record is a refusal too: a delete-versus-modify
    /// is not a content conflict, so `git rerere` writes no preimage for it and
    /// exits 0 all the same. `rerere status` names the paths rerere tracks as
    /// content conflicts; a finished path missing from it taught the cache
    /// nothing, and a caller that believed it did would have the join meet the
    /// conflict fresh with no warning. So that case is reported, not swallowed.
    pub fn teach(&self, repo: &Path, finished: &[String]) -> Result<(), String> {
        let read = |path: &str| std::fs::read(self.path().join(path)).ok();
        let marked: Vec<String> = finished
            .iter()
            .filter(|path| read(path).is_none_or(|bytes| !is_clean_merge(&bytes)))
            .cloned()
            .collect();
        if !marked.is_empty() {
            return Err(format!(
                "the resolver left conflicts in {}",
                marked.join(", ")
            ));
        }
        let rewritten =
            paths_rewritten_outside_conflicts(repo, &self.ours, &self.theirs, finished, read)
                .map_err(|e| e.to_string())?;
        if !rewritten.is_empty() {
            return Err(format!(
                "the resolver rewrote lines outside the conflicts in {}",
                rewritten.join(", ")
            ));
        }
        // The content conflicts rerere will record, read before `add` clears
        // them from its view. A finished path not among these is one rerere
        // cannot record a resolution for.
        let recordable: std::collections::BTreeSet<String> =
            git_stdout(self.path(), &["rerere", "status"])
                .map(|s| {
                    s.lines()
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
        let unrecordable: Vec<String> = finished
            .iter()
            .filter(|path| !recordable.contains(*path))
            .cloned()
            .collect();
        if !unrecordable.is_empty() {
            return Err(format!(
                "rerere recorded no resolution for {} (not a content conflict)",
                unrecordable.join(", ")
            ));
        }
        let mut add = vec!["add", "--"];
        add.extend(finished.iter().map(String::as_str));
        let _ = git_output(self.path(), &add);
        let out = git_output(self.path(), &["rerere"]).map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "rerere would not record the resolution: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
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
    let out = tugcore::git_command()
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
// The clean-segment check
// ---------------------------------------------------------------------------

/// The stretches of `git merge-file`'s marker output that lie between its
/// conflict blocks — everything git merged by itself — in order, empty
/// stretches dropped. `None` when `merge-file` could not run.
///
/// The default `merge` style, not the rung's `--zdiff3`: zdiff3 lifts lines
/// both sides share out of a block, and a merge that keeps both sides may
/// legitimately place those lines differently. The default is the least a
/// correct merge must keep.
fn clean_segments(
    scratch: &Path,
    path: &str,
    base: Option<&[u8]>,
    ours: &[u8],
    theirs: &[u8],
) -> Option<Vec<Vec<u8>>> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt");
    let ours_f = write_scratch(scratch, "c-ours", ext, ours)?;
    let base_f = write_scratch(scratch, "c-base", ext, base.unwrap_or_default())?;
    let theirs_f = write_scratch(scratch, "c-theirs", ext, theirs)?;
    let out = tugcore::git_command()
        .args(["-c", "diff.algorithm=histogram", "merge-file", "-p"])
        .arg(&ours_f)
        .arg(&base_f)
        .arg(&theirs_f)
        .output()
        .ok()?;
    // The exit status is the number of conflicts, capped at 127; anything
    // past that, or a signal, is merge-file failing.
    match out.status.code() {
        Some(0..=127) => Some(split_clean_segments(&out.stdout)),
        _ => None,
    }
}

/// Split marker output at its conflict blocks. Inside a block only the
/// closer is looked for, so a block side carrying a setext `=======` cannot
/// end the block early.
fn split_clean_segments(text: &[u8]) -> Vec<Vec<u8>> {
    let mut segments = Vec::new();
    let mut current = Vec::new();
    let mut in_block = false;
    for line in text.split_inclusive(|&b| b == b'\n') {
        let bare = line.strip_suffix(b"\n").unwrap_or(line);
        let bare = bare.strip_suffix(b"\r").unwrap_or(bare);
        let kind = std::str::from_utf8(bare).ok().and_then(marker_kind);
        match (in_block, kind) {
            (false, Some(MarkerKind::Ours)) => {
                in_block = true;
                segments.push(std::mem::take(&mut current));
            }
            (false, _) => current.extend_from_slice(line),
            (true, Some(MarkerKind::Theirs)) => in_block = false,
            (true, _) => {}
        }
    }
    segments.push(current);
    segments.retain(|s| !s.is_empty());
    segments
}

/// Whether `merged` carries every segment, verbatim and in order.
fn keeps_segments(merged: &[u8], segments: &[Vec<u8>]) -> bool {
    let mut from = 0;
    for segment in segments {
        match merged[from..]
            .windows(segment.len())
            .position(|w| w == segment.as_slice())
        {
            Some(at) => from += at + segment.len(),
            None => return false,
        }
    }
    true
}

/// Whether a merge of three versions left alone everything git merged by
/// itself: every clean stretch of `merge-file`'s marker output appears in
/// `merged`, verbatim and in order. A merge may rewrite only the conflicted
/// regions, so prose fails at once, and so does a reply that reformats text
/// it was not asked to touch. Fails closed when the check cannot run.
fn keeps_clean_segments(scratch: &Path, path: &str, loaded: &LoadedStages, merged: &[u8]) -> bool {
    let (Some(ours), Some(theirs)) = (loaded.ours.as_deref(), loaded.theirs.as_deref()) else {
        return false;
    };
    clean_segments(scratch, path, loaded.base.as_deref(), ours, theirs)
        .is_some_and(|segments| keeps_segments(merged, &segments))
}

/// Why a scribe's reply is not a merge, or `None` when it is one: present,
/// marker-free, and keeping every clean segment.
fn scribe_declined(
    scratch: &Path,
    path: &str,
    loaded: &LoadedStages,
    merged: Option<&[u8]>,
) -> Option<&'static str> {
    match merged {
        None => Some("the scribe returned nothing"),
        Some(bytes) if !is_clean_merge(bytes) => {
            Some("the scribe's merge still has conflict markers")
        }
        Some(bytes) if !keeps_clean_segments(scratch, path, loaded, bytes) => {
            Some("the scribe's merge rewrote lines outside the conflicts")
        }
        Some(_) => None,
    }
}

/// Which of `paths` a finished merge rewrote outside the conflicts of
/// `base_head` × `arc_head`, reading each finished file through `read`.
///
/// The resolver's half of the clean-segment check: a file it finished is held
/// to the same bar as the AI rung's reply. A path the pair does not conflict
/// on as text is not checked; a finished file `read` cannot find is checked
/// as empty, so deleting a conflicted file fails whenever git merged any of it.
pub fn paths_rewritten_outside_conflicts(
    repo: &Path,
    base_head: &str,
    arc_head: &str,
    paths: &[String],
    read: impl Fn(&str) -> Option<Vec<u8>>,
) -> Result<Vec<String>, ArcError> {
    let (_, stages) = merge_tree_stages(repo, base_head, arc_head)?;
    let scratch = tempfile::tempdir()
        .map_err(|e| ArcError::io("resolve: tempdir", std::env::temp_dir(), e))?;
    let mut rewritten = Vec::new();
    for path in paths {
        let Some(loaded) = stages.get(path).and_then(|raw| raw.load(repo)) else {
            continue;
        };
        let merged = read(path).unwrap_or_default();
        if !keeps_clean_segments(scratch.path(), path, &loaded, &merged) {
            rewritten.push(path.clone());
        }
    }
    Ok(rewritten)
}

// ---------------------------------------------------------------------------
// Rung 4 — structured-merge driver
// ---------------------------------------------------------------------------

/// A structured-merge driver ([P31]): the configured `tugarc.mergedriver`
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
/// up: `tugarc.mergedriver` lets a test play a structured-merge driver in a few
/// lines of shell, and `tugarc.joinresolver` lets it play the resolver the same
/// way. Absent, tugcast spawns the real thing.
pub fn resolver_program(repo: &Path) -> Option<String> {
    crate::ops::config_get(repo, "tugarc.joinresolver").filter(|c| !c.trim().is_empty())
}

/// The structured-merge driver command: `tugarc.mergedriver` when configured,
/// else `mergiraf` when it is on `PATH`, else `None`.
fn driver_program(repo: &Path) -> Option<String> {
    if let Some(cmd) = crate::ops::config_get(repo, "tugarc.mergedriver") {
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
) -> Result<String, ArcError> {
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
) -> Result<String, ArcError> {
    let args = ["commit-tree", tree, "-p", parent, "-m", msg];
    let out = git_output(repo, &args)?;
    if !out.status.success() {
        return Err(ArcError::git(
            "commit-tree failed",
            &args,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// git plumbing helpers
// ---------------------------------------------------------------------------

/// Run a git command with an explicit `GIT_INDEX_FILE`, returning trimmed
/// stdout on success.
fn git_with_index(repo: &Path, index: &Path, args: &[&str]) -> Result<String, ArcError> {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_INDEX_FILE", index)
        .output()
        .map_err(|e| ArcError::git(format!("git {}", args.join(" ")), args, e.to_string()))?;
    if !out.status.success() {
        return Err(ArcError::git(
            format!("git {} failed", args.join(" ")),
            args,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Read a blob body by OID.
fn cat_blob(repo: &Path, oid: &str) -> Result<Vec<u8>, ArcError> {
    let args = ["cat-file", "blob", oid];
    let out = git_output(repo, &args)?;
    if !out.status.success() {
        return Err(ArcError::git(
            format!("cat-file {} failed", oid),
            &args,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(out.stdout)
}

/// Write `bytes` as a loose blob (`git hash-object -w --stdin`) → its OID.
fn hash_blob(repo: &Path, bytes: &[u8]) -> Result<String, ArcError> {
    const ARGS: [&str; 3] = ["hash-object", "-w", "--stdin"];
    let mut child = tugcore::git_command()
        .arg("-C")
        .arg(repo)
        .args(ARGS)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| ArcError::git("hash-object", &ARGS, e.to_string()))?;
    child
        .stdin
        .take()
        .ok_or_else(|| ArcError::git("hash-object", &ARGS, "no stdin"))?
        .write_all(bytes)
        .map_err(|e| ArcError::git("hash-object write", &ARGS, e.to_string()))?;
    let out = child
        .wait_with_output()
        .map_err(|e| ArcError::git("hash-object wait", &ARGS, e.to_string()))?;
    if !out.status.success() {
        return Err(ArcError::git(
            "hash-object failed",
            &ARGS,
            String::from_utf8_lossy(&out.stderr).trim(),
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

/// The arc's intent, as the whole corpus a reconciliation is adjudicated
/// against: the maintained draft, the round subjects, the adopted plan
/// document, the base branch's own motion since the merge base, and the two
/// sides' name-status diffs.
///
/// Read by the AI rung of the resolution ladder ([P32]), by the resolver
/// charter, and by the base-motion engine, which puts it in front of an agent
/// being asked to resolve a replay that conflicts — in every case the question
/// is "what is this arc for, and what has the base been doing meanwhile", and
/// the answer is the same one. A draft and a few subjects can say what an arc
/// wanted; they cannot say which of two purposes a conflicting hunk serves,
/// which is the judgment this corpus exists to support.
pub fn resolve_intent(paths: &Paths, repo: &Path, base_branch: &str, branch: &str) -> String {
    let mut parts = Vec::new();
    if let Some(draft) = crate::ops::arc_draft_message(paths, repo, branch) {
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
    if let Some(plan) = arc_plan_text(repo, branch) {
        parts.push(format!("The arc's plan:\n{}", plan));
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
                    "What {} has done since this arc forked:\n{}",
                    base_branch,
                    subjects.trim()
                ));
            }
        }
        for (label, tip) in [("This arc", branch), ("The base", base_branch)] {
            // Through the [B01] door, and rendered here rather than relayed:
            // this text names files to whoever adjudicates the conflict, and
            // git's line-oriented spelling would name some of them wrongly.
            if let Ok(records) = tugchanges_core::listing(
                repo,
                &["diff", "--name-status", &format!("{}..{}", fork, tip)],
            ) {
                let names = crate::ops::name_status_paths(&records);
                if !names.is_empty() {
                    parts.push(format!("{} touched:\n{}", label, names.join("\n")));
                }
            }
        }
    }

    parts.join("\n\n")
}

/// The arc's plan as it stands at its own address ([D139]), size-bounded.
///
/// A plan runs to hundreds of lines of execution steps, and the steps are the
/// least useful half for adjudicating a conflict — the prose above them is what
/// states the intent. So an oversized plan is cut at its Execution Steps
/// heading rather than mid-sentence, and only hard-truncated when it has no
/// such heading to cut at.
fn arc_plan_text(repo: &Path, branch: &str) -> Option<String> {
    let name = branch.strip_prefix("tugarc/")?;
    let text = std::fs::read_to_string(crate::ops::plan_file(repo, name)).ok()?;
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

/// The shortest run of marker characters git will write. Git's own
/// `conflict-marker-size` attribute can enlarge it but never shrink it below
/// this, so a run of at least this many is the floor a parser accepts.
const MIN_MARKER_RUN: usize = 7;

/// Which of git's four markers a line opens, if it is a marker line at all.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkerKind {
    Ours,
    Base,
    Separator,
    Theirs,
}

/// Classify one line: a run of at least [`MIN_MARKER_RUN`] identical marker
/// characters at column 0, ending the line or followed by a space and a label.
///
/// The trailing-space rule is what keeps a `<<<<<<<<<<` ASCII rule or a
/// `=======================` divider from reading as a marker only by length —
/// git writes either a bare marker or `marker + space + label`, never a marker
/// run butted against other text.
fn marker_kind(line: &str) -> Option<MarkerKind> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let first = line.as_bytes().first().copied()?;
    let kind = match first {
        b'<' => MarkerKind::Ours,
        b'|' => MarkerKind::Base,
        b'=' => MarkerKind::Separator,
        b'>' => MarkerKind::Theirs,
        _ => return None,
    };
    let run = line.bytes().take_while(|&b| b == first).count();
    if run < MIN_MARKER_RUN {
        return None;
    }
    match line.as_bytes().get(run) {
        None => Some(kind),
        Some(b' ') => Some(kind),
        Some(_) => None,
    }
}

/// How far a conflict block has been read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockState {
    /// Past `<<<<<<<`, before any `|||||||` or `=======`.
    Ours,
    /// Past `|||||||` (diff3/zdiff3 style), before `=======`.
    Base,
    /// Past `=======`, waiting on `>>>>>>>`.
    Theirs,
}

/// Walk `bytes` line by line, calling `on_block` once per complete conflict
/// block and returning whether any *structural* marker fell outside one.
///
/// A **complete block** is `<<<<<<<`, optionally `|||||||`, then `=======`,
/// then `>>>>>>>`, in that order. Anything else — a bare `=======` setext
/// underline, a `>>>>>>>` in a doc example, an opener whose closer never
/// arrives — is content, because git only ever writes complete blocks.
///
/// A second opener while a block is open abandons the open block and starts
/// fresh from the new opener: markers do not nest in git output, so the first
/// opener was content that happened to look like one.
///
/// **Structural** excludes a lone `=======`. The returned flag feeds an
/// advisory, and the separator is the one marker that is ordinary content in
/// ordinary files ([`orphan_marker_lines`] carries the argument).
fn scan_conflict_blocks(bytes: &[u8], mut on_block: impl FnMut()) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let mut open: Option<BlockState> = None;
    let mut orphans = false;
    // An opener is pending from the moment it is read until its block either
    // completes or is abandoned; an opener that never completes is wreckage.
    let mut opener_pending = false;

    for line in text.lines() {
        let Some(kind) = marker_kind(line) else {
            continue;
        };
        match (open, kind) {
            // An opener always starts a block, abandoning any open one.
            (prev, MarkerKind::Ours) => {
                if prev.is_some() {
                    orphans = true;
                }
                opener_pending = true;
                open = Some(BlockState::Ours);
            }
            (Some(BlockState::Ours), MarkerKind::Base) => {
                open = Some(BlockState::Base);
            }
            (Some(BlockState::Ours | BlockState::Base), MarkerKind::Separator) => {
                open = Some(BlockState::Theirs);
            }
            (Some(BlockState::Theirs), MarkerKind::Theirs) => {
                on_block();
                opener_pending = false;
                open = None;
            }
            // Any other marker inside an open block is out of order, which
            // means the block was never git's: abandon it and treat what was
            // read as content.
            (Some(_), _) => {
                orphans = true;
                opener_pending = false;
                open = None;
            }
            // A marker with no block open at all. A stray closer or base
            // separator is wreckage; a stray `=======` is a setext underline.
            (None, MarkerKind::Base | MarkerKind::Theirs) => orphans = true,
            (None, MarkerKind::Separator) => {}
        }
    }

    orphans || opener_pending
}

/// Whether text carries a complete `git` conflict block.
///
/// The one predicate — the workshop's marker scan and the ladder's clean-merge
/// test both ask it, so "does this file still conflict" cannot be answered two
/// ways by two callers.
///
/// **Detection is structural, not prefix-matching.** A line that merely looks
/// marker-ish is content: `=======` is a setext heading underline in markdown,
/// and files carrying one are ordinary. Requiring the whole block — opener,
/// optional base section, separator, closer, in order — is exactly the
/// signature of something git wrote, so legitimate content can neither wedge a
/// resolve nor cause a rung to withhold a merge it computed cleanly.
pub(crate) fn has_conflict_markers(bytes: &[u8]) -> bool {
    let mut found = false;
    scan_conflict_blocks(bytes, || found = true);
    found
}

/// Whether merged text is conflict-free — no `git` conflict markers.
pub(crate) fn is_clean_merge(bytes: &[u8]) -> bool {
    !has_conflict_markers(bytes)
}

impl ResolvedBy {
    /// The spelling the wire and the bench print, matching the kebab-case.
    pub fn as_str(self) -> &'static str {
        match self {
            ResolvedBy::Rerere => "rerere",
            ResolvedBy::MergeFile => "merge-file",
            ResolvedBy::Driver => "driver",
            ResolvedBy::Ai => "ai",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcore::test_fixtures::git::{GitFixture, git};

    fn set(dir: &Path, rel: &str, content: &str) {
        std::fs::write(dir.join(rel), content).unwrap();
    }

    /// A repo on `main` with base commit `A`, a `tugarc/demo` arc, and helpers
    /// wired (user config, rerere off by default — tests opt in).
    fn init(rounds_on_branch: &[(&str, &str, &str)]) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        GitFixture::init(repo);
        set(repo, "f.txt", "A\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugarc/demo"]);
        git(repo, &["config", "branch.tugarc/demo.tugbase", "main"]);
        // Rounds land on the branch (checked out via a switch, no worktree).
        git(repo, &["switch", "-q", "tugarc/demo"]);
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
            &["config", "tugarc.mergedriver", &stub.to_string_lossy()],
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

    // ---- structural marker detection ----

    /// Marker-ish lines that no complete block encloses are content, and the
    /// setext case is not hypothetical: repo files carry `=======` underlines.
    #[test]
    fn lone_marker_lines_are_content_not_conflicts() {
        let setext = b"Heading\n=======\n\nbody text\n";
        assert!(
            !has_conflict_markers(setext),
            "a markdown setext underline is content"
        );
        assert!(!has_conflict_markers(
            b"Docs say the closer is\n>>>>>>> theirs\nand that is all.\n"
        ));
        assert!(!has_conflict_markers(
            b"diff3 adds a\n||||||| base\nsection.\n"
        ));
        assert!(!has_conflict_markers(
            b"<<<<<<< opener with no closer\nbody\n"
        ));

        // A marker run butted against other text is not a marker line.
        assert!(!has_conflict_markers(
            b"<<<<<<<ours\nb\n=======\nc\n>>>>>>>theirs\n"
        ));
    }

    /// The block must be *ordered*, not merely present.
    #[test]
    fn out_of_order_marker_lines_do_not_form_a_block() {
        assert!(!has_conflict_markers(
            b">>>>>>> theirs\nb\n=======\nc\n<<<<<<< ours\n"
        ));
        assert!(
            !has_conflict_markers(b"<<<<<<< ours\nb\n>>>>>>> theirs\n"),
            "a closer with no separator is not a block"
        );
    }

    /// Real `git merge-file` output, in each style the ladder can meet, and the
    /// resolution of it. Hand-typed marker text proves the parser matches what
    /// somebody typed; this proves it matches what git writes.
    #[test]
    fn real_merge_file_output_reads_conflicted_in_every_style() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path();
        for (label, style) in [
            ("default", None),
            ("diff3", Some("--diff3")),
            ("zdiff3", Some("--zdiff3")),
        ] {
            std::fs::write(dir.join("base"), "A\n").unwrap();
            std::fs::write(dir.join("ours"), "B\n").unwrap();
            std::fs::write(dir.join("theirs"), "C\n").unwrap();
            let mut cmd = tugcore::test_fixtures::git::command();
            cmd.arg("merge-file").arg("-p");
            if let Some(style) = style {
                cmd.arg(style);
            }
            let out = cmd
                .arg(dir.join("ours"))
                .arg(dir.join("base"))
                .arg(dir.join("theirs"))
                .output()
                .unwrap();
            assert!(
                has_conflict_markers(&out.stdout),
                "{label} style output must read conflicted: {}",
                String::from_utf8_lossy(&out.stdout)
            );
            assert!(
                is_clean_merge(b"B\n"),
                "{label}: and its resolution reads clean"
            );
        }
    }

    /// Git writes CRLF blocks in a CRLF file, and the marker line then ends
    /// `\r\n` rather than `\n`.
    #[test]
    fn crlf_blocks_read_conflicted() {
        assert!(has_conflict_markers(
            b"a\r\n<<<<<<< ours\r\nb\r\n=======\r\nc\r\n>>>>>>> theirs\r\n"
        ));
        assert!(
            !has_conflict_markers(b"Heading\r\n=======\r\n\r\nbody\r\n"),
            "and a CRLF setext underline is still content"
        );
    }

    /// `conflict-marker-size` can enlarge the runs; it never shrinks them.
    #[test]
    fn enlarged_marker_runs_still_read_conflicted() {
        assert!(has_conflict_markers(
            b"<<<<<<<<<<<< ours\nb\n============\nc\n>>>>>>>>>>>> theirs\n"
        ));
    }

    /// The withheld-resolution regression, which is the sharper half of the
    /// bug. Every text rung validates its *own output* through
    /// `is_clean_merge` before accepting it, so a file whose perfectly clean
    /// merge legitimately contains a `=======` underline was rejected by the
    /// rung that had just settled it — and fell through to `unresolved`, where
    /// the AI seam was handed a conflict rung 3 had already answered.
    #[test]
    fn a_clean_merge_carrying_a_setext_underline_is_not_withheld() {
        let scratch = tempfile::tempdir().unwrap();
        let stages = LoadedStages {
            base: Some(b"Heading\n=======\n\nl1\nl2\nl3\n".to_vec()),
            ours: Some(b"Heading\n=======\n\nX\nl2\nl3\n".to_vec()),
            theirs: Some(b"Heading\n=======\n\nl1\nl2\nY\n".to_vec()),
        };
        let merged = merge_file_rung(scratch.path(), "doc.md", &stages)
            .expect("disjoint edits merge cleanly, underline or not");
        let text = String::from_utf8_lossy(&merged);
        assert!(
            text.contains("X") && text.contains("Y"),
            "both edits present: {text}"
        );
        assert!(
            text.contains("======="),
            "and the underline survived into the result: {text}"
        );
        assert!(
            is_clean_merge(&merged),
            "which the rung must accept rather than withhold"
        );
    }
    /// The three sides of `operator_ask.rs` in the incident's merge of
    /// `36c6d58b7` (ours) and `dd7a54de2` (theirs): one conflict, where each
    /// side added fields to the same struct literal, and the right answer is
    /// to keep both.
    const ASK_BASE: &str = include_str!("../tests/fixtures/operator-ask/base.rs.fixture");
    const ASK_OURS: &str = include_str!("../tests/fixtures/operator-ask/ours.rs.fixture");
    const ASK_THEIRS: &str = include_str!("../tests/fixtures/operator-ask/theirs.rs.fixture");

    /// What the scribe wrote in the incident, in place of a merged file.
    const ASK_PROSE: &str = "I can't produce a safe merge of this file: the versions I was \
                             given are incomplete, so I'm outputting no merged file.\n";

    fn ask_stages() -> LoadedStages {
        LoadedStages {
            base: Some(ASK_BASE.as_bytes().to_vec()),
            ours: Some(ASK_OURS.as_bytes().to_vec()),
            theirs: Some(ASK_THEIRS.as_bytes().to_vec()),
        }
    }

    /// The fixture merged by keeping both sides: `merge-file`'s own marker
    /// output with the marker lines taken out.
    fn ask_keep_both(scratch: &Path) -> String {
        let ours = write_scratch(scratch, "k-ours", "rs", ASK_OURS.as_bytes()).unwrap();
        let base = write_scratch(scratch, "k-base", "rs", ASK_BASE.as_bytes()).unwrap();
        let theirs = write_scratch(scratch, "k-theirs", "rs", ASK_THEIRS.as_bytes()).unwrap();
        let out = tugcore::git_command()
            .args(["merge-file", "-p"])
            .arg(&ours)
            .arg(&base)
            .arg(&theirs)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1), "the fixture has one conflict");
        String::from_utf8(out.stdout)
            .unwrap()
            .split_inclusive('\n')
            .filter(|line| marker_kind(line.trim_end_matches('\n')).is_none())
            .collect()
    }

    #[test]
    fn a_merge_may_rewrite_only_the_conflicted_regions() {
        let scratch = tempfile::tempdir().unwrap();
        let stages = ask_stages();
        let keep_both = ask_keep_both(scratch.path());
        assert!(keep_both.contains("prompt_ledger,") && keep_both.contains("docs_dir:"));

        assert!(
            keeps_clean_segments(scratch.path(), "ask.rs", &stages, keep_both.as_bytes()),
            "keeping both sides of the one conflict passes"
        );
        assert!(
            !keeps_clean_segments(scratch.path(), "ask.rs", &stages, ASK_PROSE.as_bytes()),
            "prose in place of the file fails"
        );
        // Text git merged by itself is not the model's to touch: one clean
        // line re-indented is a rewrite outside the conflict.
        let reformatted = keep_both.replacen("    let model = args\n", "  let model = args\n", 1);
        assert_ne!(reformatted, keep_both);
        assert!(!keeps_clean_segments(
            scratch.path(),
            "ask.rs",
            &stages,
            reformatted.as_bytes()
        ));
        // Either side alone drops what the other added outside the conflict,
        // which git had merged cleanly.
        assert!(!keeps_clean_segments(
            scratch.path(),
            "ask.rs",
            &stages,
            ASK_OURS.as_bytes()
        ));
    }

    /// A repo whose `main` and `tugarc/demo` conflict as the incident's
    /// `operator_ask.rs` did, at `ask.rs`.
    fn ask_repo() -> tempfile::TempDir {
        let temp = init(&[]);
        let repo = temp.path();
        set(repo, "ask.rs", ASK_BASE);
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "ask base"]);
        git(repo, &["branch", "-f", "tugarc/demo", "main"]);
        git(repo, &["switch", "-q", "tugarc/demo"]);
        set(repo, "ask.rs", ASK_THEIRS);
        git(repo, &["commit", "-am", "declare the docs surface"]);
        git(repo, &["switch", "-q", "main"]);
        set(repo, "ask.rs", ASK_OURS);
        git(repo, &["commit", "-am", "reset turn counts"]);
        temp
    }

    /// A finished file is held to the same bar through the resolver's door:
    /// read from wherever it was finished, checked against the pair's own
    /// conflict.
    #[test]
    fn a_finished_file_that_rewrites_clean_text_is_named() {
        let temp = ask_repo();
        let repo = temp.path();
        let base = git_stdout(repo, &["rev-parse", "main"]).unwrap();
        let arc = git_stdout(repo, &["rev-parse", "tugarc/demo"]).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let keep_both = ask_keep_both(scratch.path());
        let files = vec!["ask.rs".to_string(), "f.txt".to_string()];

        let good = paths_rewritten_outside_conflicts(repo, &base, &arc, &files, |_| {
            Some(keep_both.as_bytes().to_vec())
        })
        .unwrap();
        assert!(
            good.is_empty(),
            "keep-both passes, and f.txt is no conflict"
        );

        let prose = paths_rewritten_outside_conflicts(repo, &base, &arc, &files, |_| {
            Some(ASK_PROSE.as_bytes().to_vec())
        })
        .unwrap();
        assert_eq!(prose, vec!["ask.rs".to_string()]);
    }

    // ---- the pair ladder ----

    /// `main` and `tugarc/demo` rewriting the same line, as their tips.
    fn pair(repo: &Path) -> (String, String) {
        (
            git_stdout(repo, &["rev-parse", "main"]).unwrap(),
            git_stdout(repo, &["rev-parse", "tugarc/demo"]).unwrap(),
        )
    }

    /// A conflicting pair, `f.txt` rewritten to `B` on the arc and `C` on main.
    fn crossed() -> tempfile::TempDir {
        let temp = init(&[("f.txt", "B\n", "r1")]);
        let repo = temp.path();
        set(repo, "f.txt", "C\n");
        git(repo, &["commit", "-am", "main to C"]);
        temp
    }

    /// The structured-merge driver is a rung of the pair ladder, configured
    /// per repository, and what it writes is the settled file.
    #[test]
    fn a_configured_driver_settles_a_crossed_pair() {
        let temp = crossed();
        let repo = temp.path();
        stub_driver(repo, "DRIVER\n");
        let (ours, theirs) = pair(repo);

        let settled = resolve_pair(repo, &ours, &theirs, None, "").unwrap();
        assert_eq!(
            settled.resolved,
            vec![("f.txt".to_string(), ResolvedBy::Driver)]
        );
        assert!(settled.unresolved.is_empty());
        let tree = settled.staged_tree.expect("a staged tree");
        assert_eq!(
            git_stdout(repo, &["show", &format!("{tree}:f.txt")]).unwrap(),
            "DRIVER"
        );
    }

    /// A scribe reply that still carries conflict markers settles nothing:
    /// the path stays for the resolver, and the cache learns nothing from it.
    #[test]
    fn a_scribe_reply_with_markers_is_declined_by_the_pair_ladder() {
        struct Marked;
        impl FileMerger for Marked {
            fn merge(&self, _req: &FileMergeRequest) -> Option<Vec<u8>> {
                Some(b"<<<<<<< ours\nB\n=======\nC\n>>>>>>> theirs\n".to_vec())
            }
        }
        let temp = crossed();
        let repo = temp.path();
        let (ours, theirs) = pair(repo);

        let settled = resolve_pair(repo, &ours, &theirs, Some(&Marked), "").unwrap();
        assert!(settled.resolved.is_empty());
        assert_eq!(settled.unresolved, vec!["f.txt".to_string()]);
    }

    /// What one settle teaches, the next meets in the cache: the same pair
    /// settled a second time with no scribe at all recalls the first answer.
    #[test]
    fn a_settled_pair_is_recalled_from_the_cache() {
        struct KeepBoth;
        impl FileMerger for KeepBoth {
            fn merge(&self, _req: &FileMergeRequest) -> Option<Vec<u8>> {
                Some(b"C\nB\n".to_vec())
            }
        }
        let temp = crossed();
        let repo = temp.path();
        ensure_rerere_config(repo);
        let (ours, theirs) = pair(repo);

        let first = resolve_pair(repo, &ours, &theirs, Some(&KeepBoth), "").unwrap();
        assert_eq!(first.resolved, vec![("f.txt".to_string(), ResolvedBy::Ai)]);
        assert!(has_rr_cache(repo), "the settle taught the cache");

        let second = resolve_pair(repo, &ours, &theirs, None, "").unwrap();
        assert_eq!(
            second.resolved,
            vec![("f.txt".to_string(), ResolvedBy::Rerere)]
        );
        let tree = second.staged_tree.expect("a staged tree");
        assert_eq!(
            git_stdout(repo, &["show", &format!("{tree}:f.txt")]).unwrap(),
            "C\nB"
        );
    }
}
