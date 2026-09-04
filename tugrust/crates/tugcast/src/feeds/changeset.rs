//! Changeset composition — the workspace-scoped, owner-grouped view of a
//! checkout's dirty state.
//!
//! `compose_snapshot` is the pure building block: each call joins `git
//! status` against the attribution ledger (`file_events` grouped by owning
//! session), derives arc entries from `refs/heads/tugarc/`, and partitions
//! dirty files into owned / shared / unattributed buckets. The account-global
//! `ChangesetAllFeed` (`feeds::changeset_all`) calls it once per open project
//! and delivers the aggregate; `ChangesetBumper` pings that feed's global
//! recompute signal after each file-event write.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tugcast_core::types::{
    ArcStep, ChangesetDraft, ChangesetEntry, ChangesetFile, ChangesetSnapshot, DocumentArcEntry,
    OrphanedFile, SharedOwner, UnattributedFile,
};

use super::attribution::{parse_worktree_states, repo_root_for};
use super::git::{fetch_git_status, fetch_head_message, parse_porcelain_v2};
use super::workspace_registry::WorkspaceRegistry;
use crate::path_resolver::{CanonicalPath, same_file};
use crate::session_ledger::{
    FileEventKey, FileEventRewrite, ProjectFileEvent, SessionLedger, SessionRow, SessionState,
};

/// Fires the account-global changeset recompute after a file-event write.
///
/// Held by the relay loop (one per session); `bump` pings the process-global
/// `ChangesetAllFeed` recompute signal via the registry. Cheap to clone. A
/// disconnected bumper (test harnesses without a registry) makes every `bump`
/// a no-op.
#[derive(Clone, Default)]
pub struct ChangesetBumper {
    registry: Option<Arc<WorkspaceRegistry>>,
}

impl ChangesetBumper {
    pub fn new(registry: Arc<WorkspaceRegistry>) -> Self {
        Self {
            registry: Some(registry),
        }
    }

    /// A bumper with no registry — every `bump` is a no-op. Test
    /// harnesses drive relays without a workspace registry.
    #[cfg(test)]
    pub fn disconnected() -> Self {
        Self::default()
    }

    /// Ping the account-global `ChangesetAllFeed` after a write in
    /// `project_dir`. The aggregate spans every open project, so any
    /// registered write triggers one recompute; `project_dir` no longer
    /// scopes the bump (the per-workspace feed was retired). Notifications
    /// coalesce (a permit, not a queue), so bursts cost one recompute.
    pub fn bump(&self, _project_dir: &Path) {
        if let Some(registry) = &self.registry {
            registry.changeset_all_bump().notify_one();
        }
    }
}

/// Whether a porcelain-v2 XY status is a structural op — a delete, rename, or
/// new-untracked file. These are the ops the sole-holder bracket promotion
/// claims: you don't hand-save a deletion, so a lone bracket sweep over one is
/// the session's own shell work. A plain content modify (`.M`/`M.`) is not
/// structural — that's the ambiguous case attribution stays conservative on.
/// How many contended-path diffs the contention pass runs at once.
///
/// Each is a `git diff` subprocess. Contention is normally zero paths, so
/// this only matters in the workspace R09 warns about — many dirty paths that
/// genuinely contend — where running them one after another would put the
/// whole file's worth of subprocess latency on every recompute.
const CONTENTION_DIFF_CONCURRENCY: usize = 8;

fn status_is_structural(status: &str) -> bool {
    status == "??" || status.chars().any(|c| matches!(c, 'A' | 'D' | 'R'))
}

/// Per-owner aggregation while folding event rows into the snapshot.
struct OwnerAgg {
    display_name: String,
    live: bool,
    /// The line of work this owner is ([P01]), when the ledger knows one.
    line_id: Option<String>,
    /// repo-relative path → file row; `BTreeMap` for deterministic output
    /// order (diff-suppression compares whole snapshots).
    files: BTreeMap<String, ChangesetFile>,
}

/// Compose one `ChangesetSnapshot` for the checkout containing
/// `project_dir` (`workspace_key` left empty for the caller to fill).
/// `None` when the dir is not inside a git working tree or `git status`
/// fails — the feed skips the cycle, like GitFeed.
pub(crate) async fn compose_snapshot(
    project_dir: &Path,
    ledger: Option<&SessionLedger>,
) -> Option<ChangesetSnapshot> {
    let repo_root = repo_root_for(project_dir).await?;
    // Loop-invariant across every row this compose resolves, and resolving it
    // takes the resolver's global memo lock — so it is resolved once, here.
    let canonical_root = CanonicalPath::from_raw(&repo_root);
    let status_output = fetch_git_status(&repo_root).await?;

    let header = parse_porcelain_v2(&status_output);
    let head_message = fetch_head_message(&repo_root).await;
    // One `rev-parse` replaces up to one `git log` per dirty path on every
    // recompute — see `live_cut_cache`.
    let head_oid = git_stdout(&repo_root, &["rev-parse", "HEAD"])
        .await
        .map(|out| out.trim().to_owned())
        .filter(|oid| !oid.is_empty());

    // Dirty working-tree files: repo-relative path → porcelain-v2 XY
    // status ("??" for untracked, matching the familiar v1 rendering).
    let dirty: BTreeMap<String, String> = parse_worktree_states(&status_output)
        .into_iter()
        .map(|(path, status)| {
            let status = if status == "?" {
                "??".to_owned()
            } else {
                status
            };
            (path, status)
        })
        .collect();

    // Fold attribution events into per-owner buckets. Events are
    // oldest-first, so the latest event for a path wins op/origin (same rule
    // as `tugtool changes`). Events whose file is no longer dirty
    // (committed / reverted) drop out, and so do **spent** events — rows at
    // or before the last commit that touched their path (the row-liveness
    // rule, [D112]): a commit spends the rows it absorbs, so a fossil row
    // can never re-claim a file someone re-dirties later.
    // The `file_events` bucket key is canonical (the relay writes it through the
    // gateway), so query the canonical spelling of `project_dir`. Legacy rows
    // written before canonicalization carry the raw spelling; union them in
    // (when it differs) so pre-upgrade attribution still scopes in until the
    // backfill converts them.
    // A read error must never masquerade as "no events" — that renders as
    // "no session claims these" while the truth is "the ledger is
    // damaged". Note the error (latches the degraded tripwire on
    // corruption) and log it at warn.
    let read_events = |ledger: &crate::session_ledger::SessionLedger, project: &str| {
        ledger.file_events_for_project(project).unwrap_or_else(|err| {
            crate::ledger_integrity::health::note_error("changes", &err);
            tracing::warn!(project, error = %err, "file_events read failed; claims unavailable this cycle");
            Vec::new()
        })
    };
    let mut events = match ledger {
        Some(ledger) => {
            let raw = project_dir.to_string_lossy();
            let canonical = CanonicalPath::from_raw(project_dir);
            let mut events = read_events(ledger, canonical.as_str());
            if canonical.as_str() != raw {
                events.extend(read_events(ledger, &raw));
            }
            events
        }
        None => Vec::new(),
    };

    // Opportunistic lazy sweep of this project's absolute rows, once per project
    // per process: those that resolve into the repo are collapsed to canonical
    // project_dir + repo-relative file_path; those that resolve outside it are
    // deleted. An out-of-repo row can never match the fold below (which is keyed
    // on git's repo-relative dirty paths), so it is not a row this project has
    // any use for — it only costs a full resolution attempt every recompute.
    // Correctness never depends on the rewrite half — the bridge already
    // reconciles legacy rows at read time. The sweep runs only for open projects
    // (never a boot walk), preserving the no-TCC-prompt-on-boot property.
    if let Some(ledger) = ledger {
        let canonical = CanonicalPath::from_raw(project_dir);
        let swept = backfill_marker()
            .lock()
            .expect("backfill marker mutex")
            .contains(canonical.as_str());
        if !swept {
            let mut rewrites: Vec<FileEventRewrite> = Vec::new();
            let mut purges: Vec<FileEventKey> = Vec::new();
            for pfe in &events {
                if !pfe.event.file_path.starts_with('/') {
                    continue;
                }
                let rel = repo_relative(&canonical_root, &repo_root, &pfe.event.file_path);
                // Still absolute means both of `repo_relative`'s tests came back
                // negative: the canonicalized path is not under the canonical
                // root by prefix, AND no ancestor of it is the same live
                // directory as the root. A path that merely fails to
                // canonicalize (an in-repo file already deleted from disk) still
                // strips, so "unresolvable" is never read as "outside".
                if rel.starts_with('/') {
                    purges.push(FileEventKey {
                        tug_session_id: pfe.event.tug_session_id.clone(),
                        tool_use_id: pfe.event.tool_use_id.clone(),
                        file_path: pfe.event.file_path.clone(),
                    });
                } else {
                    rewrites.push(FileEventRewrite {
                        tug_session_id: pfe.event.tug_session_id.clone(),
                        tool_use_id: pfe.event.tool_use_id.clone(),
                        old_file_path: pfe.event.file_path.clone(),
                        new_file_path: rel,
                    });
                }
            }
            // Mark the project swept only once the writes land: a forwarded
            // write held for retry must not cost this process its one attempt.
            let mut settled = true;
            if !rewrites.is_empty() {
                settled &= ledger
                    .backfill_file_events_repo_relative(canonical.as_str(), &rewrites)
                    .is_ok();
            }
            if !purges.is_empty() {
                match ledger.purge_file_events_out_of_repo(canonical.as_str(), &purges) {
                    Ok(deleted) => tracing::debug!(
                        project = canonical.as_str(),
                        deleted,
                        "purged file_events rows naming files outside the repo"
                    ),
                    Err(err) => {
                        tracing::warn!(project = canonical.as_str(), error = %err, "out-of-repo purge failed; retrying next compose");
                        settled = false;
                    }
                }
                // Purged rows are gone from the ledger; drop them from this
                // compose too, so they don't cost one last resolution each.
                let dropped: HashSet<(&str, &str, &str)> = purges
                    .iter()
                    .map(|k| {
                        (
                            k.tug_session_id.as_str(),
                            k.tool_use_id.as_str(),
                            k.file_path.as_str(),
                        )
                    })
                    .collect();
                events.retain(|pfe| {
                    !dropped.contains(&(
                        pfe.event.tug_session_id.as_str(),
                        pfe.event.tool_use_id.as_str(),
                        pfe.event.file_path.as_str(),
                    ))
                });
            }
            if settled {
                backfill_marker()
                    .lock()
                    .expect("backfill marker mutex")
                    .insert(canonical.as_str().to_owned());
            }
        }
    }
    let mut owners: BTreeMap<String, OwnerAgg> = BTreeMap::new();
    // Deck-reported seatings, folded into owner liveness: a session seated
    // on an open card is not abandoned no matter what `sessions.state` says
    // between a startup demote and the card's next spawn, so its files must
    // not orphan-lift ([D120]). Read once per compose; empty with no deck
    // connected, which is the truth in that case.
    let seated = super::deck_seatings::seated_session_ids();
    // Line canonicalization ([P01]): a session id is one *segment* of a
    // line of work, and a card that has rotated its id (relaunch-resume,
    // rewind-fork, crash respawn) has written rows under several. Owners
    // are therefore keyed by the line's current seat segment, so every
    // segment's rows fold into one entry; the raw id stands in for a row
    // whose line this ledger has never seen. `canon` maps every segment id
    // the resolved lines have worn to their seat; `line_live` is the
    // line-level answer — any segment live, or seated on an open card.
    let mut canon: HashMap<String, String> = HashMap::new();
    let mut line_seat: HashMap<String, String> = HashMap::new();
    let mut line_live: HashMap<String, bool> = HashMap::new();
    if let Some(ledger) = ledger {
        for pfe in &events {
            let Some(line_id) = &pfe.line_id else {
                continue;
            };
            if line_seat.contains_key(line_id) {
                continue;
            }
            match ledger.line_ownership(line_id).ok().flatten() {
                Some(own) => {
                    let live = own.any_live || own.segment_ids.iter().any(|id| seated.contains(id));
                    for id in &own.segment_ids {
                        canon.insert(id.clone(), own.seat_id.clone());
                    }
                    line_seat.insert(line_id.clone(), own.seat_id);
                    line_live.insert(line_id.clone(), live);
                }
                None => {
                    // Every segment evicted: the stamped line survives its
                    // sessions rows, and the row's own id keys the owner.
                    line_seat.insert(line_id.clone(), pfe.event.tug_session_id.clone());
                    line_live.insert(line_id.clone(), false);
                }
            }
        }
    }
    let owner_key = |pfe: &ProjectFileEvent| -> String {
        pfe.line_id
            .as_ref()
            .and_then(|line| line_seat.get(line))
            .or_else(|| canon.get(&pfe.event.tug_session_id))
            .cloned()
            .unwrap_or_else(|| pfe.event.tug_session_id.clone())
    };
    // Per-path liveness cut, computed once per dirty path with events.
    let mut live_cuts: HashMap<String, i64> = HashMap::new();
    // Per repo-relative path, the owners with a live **proof** row
    // (`exact`/`replay` — the tool input named the file), the genuine authors
    // ([D112]). A `bash`/`turn` row is a whole-tree-delta *claim*
    // (contaminated by concurrent saves, build churn, and the user's own
    // hand-saves), so it never makes a session an owner.
    let mut proof_owners: HashMap<String, HashSet<String>> = HashMap::new();
    for pfe in &events {
        let rel = repo_relative(&canonical_root, &repo_root, &pfe.event.file_path);
        let Some(git_status) = dirty.get(&rel) else {
            continue;
        };
        let min_live = match live_cuts.get(&rel) {
            Some(cut) => *cut,
            None => {
                let cut =
                    cached_min_live_at_ms(&canonical_root, &repo_root, &rel, head_oid.as_deref())
                        .await;
                live_cuts.insert(rel.clone(), cut);
                cut
            }
        };
        if pfe.event.at < min_live {
            continue;
        }
        let owner_id = owner_key(pfe);
        if super::attribution::origin_is_proof(&pfe.event.origin) {
            proof_owners
                .entry(rel.clone())
                .or_default()
                .insert(owner_id.clone());
        }
        // Liveness ORs across the line's segments and every event seen for
        // the owner: the segment that wrote this row may be demoted while
        // another segment of the same line is live or seated.
        let event_live = pfe.owner_live
            || seated.contains(&pfe.event.tug_session_id)
            || pfe
                .line_id
                .as_ref()
                .and_then(|line| line_live.get(line))
                .copied()
                .unwrap_or(false);
        let owner = owners.entry(owner_id).or_insert_with(|| OwnerAgg {
            display_name: session_display_name(pfe),
            live: false,
            line_id: pfe.line_id.clone(),
            files: BTreeMap::new(),
        });
        owner.live |= event_live;
        if owner.line_id.is_none() {
            owner.line_id = pfe.line_id.clone();
        }
        let file = owner
            .files
            .entry(rel.clone())
            .or_insert_with(|| ChangesetFile {
                path: rel.clone(),
                git_status: git_status.clone(),
                op: pfe.event.op.clone(),
                origin: pfe.event.origin.clone(),
                shared: false,
                last_touched: pfe.event.at,
                own_hunks: Vec::new(),
                contested_hunks: Vec::new(),
                shared_with: Vec::new(),
                added: None,
                deleted: None,
            });
        // Provenance display follows proof rows: a later bracket sweep never
        // overwrites the op/origin a proof row established.
        if super::attribution::origin_is_proof(&pfe.event.origin)
            || !super::attribution::origin_is_proof(&file.origin)
        {
            file.op = pfe.event.op.clone();
            file.origin = pfe.event.origin.clone();
        }
        file.last_touched = file.last_touched.max(pfe.event.at);
    }

    // Resolve ownership per path with **proof** rows the leading evidence
    // ([D112]) — correlation never decides on its own, with one promotion:
    //
    // - Some session proof-owns the path → strip it from every owner that
    //   only bracket-grabbed it (their contamination); mark `shared` iff more
    //   than one session proof-owns it (genuine same-file contention).
    // - No proof owner, one bracket holder, structural op → promote it. A
    //   delete / rename / new-untracked file is the session's own shell work
    //   (`git rm`, `mv`, a heredoc `>`), never an incidental editor hand-save
    //   caught in the window — you don't hand-save a deletion. The sole
    //   holder claims it.
    // - No proof owner, otherwise → strip the path from every bracket holder:
    //   the same delta that sweeps up another session's save sweeps up the
    //   user's own hand-save during the command, and the user's editor has no
    //   session to claim it back. A plain content modify is exactly that
    //   ambiguous case; the path falls to `unattributed` below.
    let all_paths: HashSet<String> = owners
        .values()
        .flat_map(|agg| agg.files.keys().cloned())
        .collect();
    // Bracket hints ([P13]): the correlation-only holders stripped below are
    // recorded per path instead of dropped silently — they surface on the
    // unattributed rows as `hinted_by` provenance (a hint for the
    // disposition decision, never an attribution).
    let mut bracket_hints: HashMap<String, Vec<String>> = HashMap::new();
    // Paths with two or more proof owners, resolved after this loop — the
    // verdict needs a `git diff`, and this loop must stay string-only.
    let mut contended_paths: Vec<(String, HashSet<String>)> = Vec::new();
    for path in &all_paths {
        let proof_ids = proof_owners.get(path);
        let holders: Vec<String> = owners
            .iter()
            .filter(|(_, agg)| agg.files.contains_key(path))
            .map(|(id, _)| id.clone())
            .collect();
        // Sole-holder structural promotion: keep the file on its one bracket
        // holder rather than stripping it to unattributed.
        let promoted_holder: Option<&String> = (proof_ids.is_none()
            && holders.len() == 1
            && owners
                .get(&holders[0])
                .and_then(|agg| agg.files.get(path))
                .is_some_and(|f| status_is_structural(&f.git_status)))
        .then(|| &holders[0]);
        for id in &holders {
            if promoted_holder == Some(id) {
                continue;
            }
            if !proof_ids.is_some_and(|ids| ids.contains(id)) {
                if let Some(agg) = owners.get_mut(id) {
                    if agg.files.remove(path).is_some() {
                        bracket_hints
                            .entry(path.clone())
                            .or_default()
                            .push(id.clone());
                    }
                }
            }
        }
        if let Some(proof_ids) = proof_ids {
            if proof_ids.len() > 1 {
                contended_paths.push((path.clone(), proof_ids.clone()));
            }
        }
    }
    // Hunk-aware contention ([P12], [P14]) for the paths that actually have
    // two or more proof owners — normally none, and bounded by the dirty set
    // when not (Risk R09). Everything before this point is string work; this
    // is the only place the composition spends a `git diff`, and it spends it
    // only where a file-level SHARED would otherwise have been asserted.
    //
    // The diffs run concurrently, bounded by `CONTENTION_DIFF_CONCURRENCY`:
    // each one is a subprocess, and a workspace where many paths genuinely
    // contend would otherwise pay for them end to end.
    //
    // A closed session's evidence that no longer places is a ghost, and this
    // is where it stops warning ([P03]). The set is the ids the owner
    // aggregation positively resolved as not-live; a proof id missing from
    // `owners` entirely would read as live, which over-warns rather than
    // retiring something real.
    let dead_ids: HashSet<String> = owners
        .iter()
        .filter(|(_, agg)| !agg.live)
        .map(|(id, _)| id.clone())
        .collect();
    let mut verdicts = Vec::with_capacity(contended_paths.len());
    for batch in contended_paths.chunks(CONTENTION_DIFF_CONCURRENCY) {
        verdicts.extend(
            futures::future::join_all(batch.iter().map(|(path, proof_ids)| {
                // Present in `live_cuts` by construction: a path only becomes
                // contended through rows that already passed its cut.
                let min_live = live_cuts.get(path).copied().unwrap_or(i64::MIN);
                debug_assert!(
                    proof_ids.iter().all(|id| owners.contains_key(id)),
                    "a contended path's proof owners come from the owner aggregation itself; \
                     an id missing from it would silently take the live default"
                );
                contention_verdict(
                    &repo_root, path, proof_ids, &dead_ids, min_live, ledger, &canon,
                )
            }))
            .await,
        );
    }
    for ((path, proof_ids), verdict) in contended_paths.iter().zip(verdicts) {
        // Who each owner is sharing with: the *other* proof owners whose
        // claim survived retirement, named so the badge carries its own
        // evidence ([P06]). Built once per path, from the owner aggregation
        // the ids came from.
        // With no verdict to be had, nobody retired: every proof owner is
        // still claiming the file, which is exactly what the file-level
        // SHARED is saying.
        let mut survivors: Vec<SharedOwner> = proof_ids
            .iter()
            .filter(|id| {
                verdict.as_ref().is_none_or(|(verdict, _)| {
                    !verdict.claims.get(*id).is_some_and(|c| c.claims_nothing())
                })
            })
            .filter_map(|id| {
                owners.get(id).map(|agg| SharedOwner {
                    id: id.clone(),
                    name: agg.display_name.clone(),
                    live: agg.live,
                })
            })
            .collect();
        survivors.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        for id in proof_ids {
            let Some(file) = owners.get_mut(id).and_then(|agg| agg.files.get_mut(path)) else {
                continue;
            };
            match &verdict {
                Some((verdict, hunks)) => {
                    file.shared = verdict.shared;
                    file.own_hunks = verdict.hunks_of(id, hunks);
                    file.contested_hunks = verdict
                        .contested
                        .iter()
                        .filter(|hid| file.own_hunks.contains(hid))
                        .cloned()
                        .collect();
                }
                // No verdict to be had (no spans, no readable diff): the
                // file-level answer stands, which is what it always was.
                None => file.shared = true,
            }
            if file.shared {
                file.shared_with = survivors
                    .iter()
                    .filter(|owner| &owner.id != id)
                    .cloned()
                    .collect();
            }
        }
    }
    // Orphan lift ([D120]): a file owned only by non-live ("dead") sessions is
    // invisible — a closed session keeps its proof rows, but no live card
    // surfaces another session's entry. Lift such files into the `orphaned`
    // bucket so a live session can reclaim them. A file any live session
    // proof-owns stays in that live entry (it is not orphaned), so a file
    // qualifies only when EVERY owner holding it is dead.
    let live_paths: HashSet<String> = owners
        .values()
        .filter(|agg| agg.live)
        .flat_map(|agg| agg.files.keys().cloned())
        .collect();
    // Keyed by path so two dead co-owners of one file yield a single orphan
    // (the most-recently-touched owner wins the provenance).
    let mut orphaned_by_path: BTreeMap<String, OrphanedFile> = BTreeMap::new();
    for (owner_id, agg) in owners.iter_mut() {
        if agg.live {
            continue;
        }
        let orphan_paths: Vec<String> = agg
            .files
            .keys()
            .filter(|path| !live_paths.contains(*path))
            .cloned()
            .collect();
        for path in orphan_paths {
            let Some(file) = agg.files.remove(&path) else {
                continue;
            };
            let candidate = OrphanedFile {
                path: file.path,
                git_status: file.git_status,
                op: file.op,
                origin: file.origin,
                prior_owner_name: agg.display_name.clone(),
                prior_owner_id: owner_id.clone(),
                last_touched: file.last_touched,
            };
            orphaned_by_path
                .entry(path)
                .and_modify(|existing| {
                    if candidate.last_touched > existing.last_touched {
                        *existing = candidate.clone();
                    }
                })
                .or_insert(candidate);
        }
    }
    let orphaned: Vec<OrphanedFile> = orphaned_by_path.into_values().collect();

    // An owner left with no files (its only claims were stripped bracket
    // grabs, or all its files were lifted to `orphaned`) drops out here;
    // fileless live sessions are re-injected by `apply_session_rows`, so the
    // card still lists every open session.
    owners.retain(|_, agg| !agg.files.is_empty());

    // Orphaned paths are owned (by a dead session), just lifted out of their
    // owner's entry above — so they must NOT also fall into `unattributed`.
    let orphaned_paths: HashSet<&str> = orphaned.iter().map(|f| f.path.as_str()).collect();

    // Unattributed: dirty files no owner claims (and not an orphan), each
    // carrying the bracket holders that saw it change ([P13]).
    let unattributed: Vec<UnattributedFile> = dirty
        .iter()
        .filter(|(path, _)| {
            !owners.values().any(|agg| agg.files.contains_key(*path))
                && !orphaned_paths.contains(path.as_str())
        })
        .map(|(path, git_status)| {
            let mut hinted_by = bracket_hints.get(path).cloned().unwrap_or_default();
            hinted_by.sort();
            hinted_by.dedup();
            UnattributedFile {
                path: path.clone(),
                git_status: git_status.clone(),
                hinted_by,
            }
        })
        .collect();

    let mut changesets: Vec<ChangesetEntry> = owners
        .into_iter()
        .map(|(owner_id, agg)| ChangesetEntry::Session {
            owner_id,
            line_id: agg.line_id,
            display_name: agg.display_name,
            live: agg.live,
            files: agg.files.into_values().collect(),
            draft: None,
        })
        .collect();

    // Attach maintained drafts (Spec S10) to eligible entries: a session
    // entry with files. Fileless live sessions are injected later by
    // `apply_session_rows` and pick up their drafts in
    // `attach_live_session_drafts`; arc entries — attached per repo by
    // `attach_arc_composition`, not here — take theirs there too.
    if let Some(ledger) = ledger {
        // Spec S05 spelling contract: writers store `project_dir` canonical;
        // query the canonical spelling and union the raw one when it differs
        // (the same legacy-tolerant pattern as the file_events read above),
        // so a draft written under either spelling still attaches.
        let drafts = {
            let raw = project_dir.to_string_lossy();
            let canonical = CanonicalPath::from_raw(project_dir);
            let mut drafts = ledger
                .changeset_drafts_for_project(canonical.as_str())
                .unwrap_or_default();
            if canonical.as_str() != raw {
                drafts.extend(
                    ledger
                        .changeset_drafts_for_project(&raw)
                        .unwrap_or_default(),
                );
            }
            drafts
        };
        // First writer wins in the map, so a canonical-spelling row
        // shadows any raw-spelling duplicate on the same owner key.
        let mut by_owner: HashMap<(&str, &str), &crate::session_ledger::ChangesetDraftRow> =
            HashMap::new();
        for d in &drafts {
            by_owner
                .entry((d.owner_kind.as_str(), d.owner_id.as_str()))
                .or_insert(d);
        }
        for entry in &mut changesets {
            match entry {
                ChangesetEntry::Session {
                    owner_id,
                    files,
                    draft,
                    ..
                } if !files.is_empty() => {
                    *draft = by_owner
                        .get(&("session", owner_id.as_str()))
                        .map(|row| draft_from_row(row));
                }
                _ => {}
            }
        }
    }

    Some(ChangesetSnapshot {
        workspace_key: String::new(),
        branch: header.branch,
        ahead: header.ahead,
        behind: header.behind,
        head_sha: header.head_sha,
        head_message,
        changesets,
        unattributed,
        orphaned,
    })
}

/// Attach a repo's arc composition — the live arc entries and their
/// maintained drafts — to one already-composed snapshot.
///
/// Split out of [`compose_snapshot`] because an arc list is a property of the
/// *repo*, not of an open project: `arc_detail_entries_in` derives from
/// `git worktree list`, which answers identically from a linked worktree and
/// from the base checkout, so composing it per project duplicated every arc
/// row whenever two open projects shared one repo. The aggregate elects one
/// owner project per repo and calls this for the owner alone.
pub(crate) async fn attach_arc_composition(
    project_dir: &Path,
    ledger: Option<&SessionLedger>,
    snapshot: &mut ChangesetSnapshot,
) {
    let Some(repo_root) = repo_root_for(project_dir).await else {
        return;
    };
    // Base paths a live session is working, with whose they are — derived
    // from the composed session entries, and handed to the arc composition
    // for the same reason the occupancy registry is: the join's blockers have
    // to tell the user's own uncommitted edit — which a resolve may fold into
    // an arc — from another session's, which nothing may touch.
    let live_dirt: BTreeMap<String, (String, String)> = snapshot
        .changesets
        .iter()
        .filter_map(|entry| match entry {
            ChangesetEntry::Session {
                owner_id,
                display_name,
                live: true,
                files,
                ..
            } => Some((owner_id, display_name, files)),
            _ => None,
        })
        .flat_map(|(id, name, files)| {
            files
                .iter()
                .map(move |file| (file.path.clone(), (id.clone(), name.clone())))
        })
        .collect();

    let mut arcs = arc_entries(&repo_root, ledger, &live_dirt).await;

    // Attach maintained drafts (Spec S10) to arcs with rounds or worktree
    // dirt — the gate keeps a stale draft off an entry that has since gone
    // clean. Same spelling contract as the session pass in
    // [`compose_snapshot`]: canonical first, raw unioned when it differs.
    if let Some(ledger) = ledger {
        let drafts = {
            let raw = project_dir.to_string_lossy();
            let canonical = CanonicalPath::from_raw(project_dir);
            let mut drafts = ledger
                .changeset_drafts_for_project(canonical.as_str())
                .unwrap_or_default();
            if canonical.as_str() != raw {
                drafts.extend(
                    ledger
                        .changeset_drafts_for_project(&raw)
                        .unwrap_or_default(),
                );
            }
            drafts
        };
        let mut by_owner: HashMap<&str, &crate::session_ledger::ChangesetDraftRow> = HashMap::new();
        for d in drafts.iter().filter(|d| d.owner_kind == "arc") {
            by_owner.entry(d.owner_id.as_str()).or_insert(d);
        }
        // An arc's rows migrate onto a second axis too — from the bare branch
        // ref to `tugarc/<name>#<tugid>` ([P03]) — and writers reach the new
        // key before every reader does. So index arc rows by their legacy
        // form as well, preferring an id-qualified row when both exist, and
        // probe it when the exact key misses. Without this the maintained
        // draft would vanish from the Changes card for the whole window
        // between the writers moving and the entries following.
        let mut arc_by_legacy: HashMap<&str, &crate::session_ledger::ChangesetDraftRow> =
            HashMap::new();
        for d in drafts.iter().filter(|d| d.owner_kind == "arc") {
            let legacy = tugarc_core::ops::legacy_owner_key(&d.owner_id);
            match arc_by_legacy.entry(legacy) {
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(d);
                }
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    if slot.get().owner_id == legacy && d.owner_id != legacy {
                        slot.insert(d);
                    }
                }
            }
        }
        for entry in &mut arcs {
            if let ChangesetEntry::Arc {
                owner_id,
                rounds,
                worktree_dirty,
                draft,
                stage,
                ..
            } = entry
                && (*rounds > 0 || *worktree_dirty)
            {
                *draft = by_owner
                    .get(owner_id.as_str())
                    .or_else(|| arc_by_legacy.get(tugarc_core::ops::legacy_owner_key(owner_id)))
                    .map(|row| draft_from_row(row));
                // `arc_detail_entries_in` derives its stage without draft
                // visibility; this overlay is the caller that can see one,
                // so it discharges the recompute `derive_stage`'s
                // precedence assigns it — a draft outranks mere activity,
                // and nothing else ([P03]).
                if draft.is_some() && matches!(stage.as_deref(), Some("working") | Some("created"))
                {
                    *stage = Some("draft-ready".to_owned());
                }
            }
        }
    }

    snapshot.changesets.extend(arcs);
}

/// Join a workspace's ledger session rows into a composed snapshot.
///
/// Two effects, both keyed by `session_id`:
///
/// - every **live** session gains an entry — fileless when it owns no dirty
///   files — so the card can list every open session, clean or not;
/// - every session entry with a matching ledger row takes its
///   `display_name` from [`session_row_title`] (the identity grammar:
///   `<name> : <project>/<callsign>`, with the legacy tagless fallbacks
///   name → prompt snippet → id prefix) and its `live` flag from the row's
///   state OR the deck seating board — an open card outranks a demoted row.
///
/// Entries re-sort to (sessions by id, arcs by ref) so injection order
/// never perturbs diff-suppression.
pub(crate) fn apply_session_rows(snapshot: &mut ChangesetSnapshot, rows: &[SessionRow]) {
    let by_id: HashMap<&str, &SessionRow> = rows
        .iter()
        .map(|row| (row.session_id.as_str(), row))
        .collect();

    // Deck seatings fold into liveness here exactly as they do in the owner
    // aggregation: a session seated on an open card reads live to the deck
    // even while its `sessions.state` waits out the startup-demote window.
    let seated = super::deck_seatings::seated_session_ids();
    // Rows group by line ([P01]) the way owners did in the compose: the
    // line's liveness is any segment live-or-seated, and a line already
    // present as an entry must not inject a second entry under another of
    // its segment ids. The line's *face* — the row an entry with no exact
    // id match reads its title from — prefers a live segment.
    let mut line_live: HashMap<&str, bool> = HashMap::new();
    let mut row_of_line: HashMap<&str, &SessionRow> = HashMap::new();
    for row in rows {
        if row.line_id.is_empty() {
            continue;
        }
        let live = row.state == SessionState::Live || seated.contains(&row.session_id);
        *line_live.entry(row.line_id.as_str()).or_insert(false) |= live;
        row_of_line
            .entry(row.line_id.as_str())
            .and_modify(|existing| {
                if live && existing.state != SessionState::Live {
                    *existing = row;
                }
            })
            .or_insert(row);
    }
    let mut present: HashSet<String> = HashSet::new();
    let mut present_lines: HashSet<String> = HashSet::new();
    for entry in &mut snapshot.changesets {
        if let ChangesetEntry::Session {
            owner_id,
            line_id,
            display_name,
            live,
            ..
        } = entry
        {
            present.insert(owner_id.clone());
            if let Some(line) = line_id.as_deref().filter(|l| !l.is_empty()) {
                present_lines.insert(line.to_owned());
            }
            let row = by_id.get(owner_id.as_str()).copied().or_else(|| {
                line_id
                    .as_deref()
                    .and_then(|line| row_of_line.get(line).copied())
            });
            if let Some(row) = row {
                let row_line_live = (!row.line_id.is_empty())
                    .then(|| line_live.get(row.line_id.as_str()).copied())
                    .flatten()
                    .unwrap_or(false);
                *display_name = session_row_title(row);
                *live = row.state == SessionState::Live
                    || seated.contains(row.session_id.as_str())
                    || row_line_live;
                if line_id.is_none() && !row.line_id.is_empty() {
                    *line_id = Some(row.line_id.clone());
                    present_lines.insert(row.line_id.clone());
                }
            }
        }
    }

    for row in rows {
        let live = row.state == SessionState::Live || seated.contains(&row.session_id);
        if !live
            || present.contains(&row.session_id)
            || (!row.line_id.is_empty() && present_lines.contains(&row.line_id))
        {
            continue;
        }
        if !row.line_id.is_empty() {
            present_lines.insert(row.line_id.clone());
        }
        snapshot.changesets.push(ChangesetEntry::Session {
            owner_id: row.session_id.clone(),
            line_id: (!row.line_id.is_empty()).then(|| row.line_id.clone()),
            display_name: session_row_title(row),
            live: true,
            files: Vec::new(),
            draft: None,
        });
    }

    snapshot
        .changesets
        .sort_by(|a, b| entry_sort_key(a).cmp(&entry_sort_key(b)));
}

/// Attach persisted session drafts to live entries still carrying none.
///
/// [`compose_snapshot`] attaches drafts only to entries that own files, and
/// [`apply_session_rows`] injects fileless live sessions after that pass —
/// so a live session whose changes are attributed elsewhere (an arc
/// worktree run) or that has gone clean would read `draft: None` despite a
/// persisted row. A live entry always reads its row back; rows are keyed by
/// the workspace key, the same single-spelling lookup the unattributed
/// bucket uses (Spec S05).
pub(crate) fn attach_live_session_drafts(
    snapshot: &mut ChangesetSnapshot,
    ledger: &crate::session_ledger::SessionLedger,
) {
    let workspace_key = snapshot.workspace_key.clone();
    for entry in &mut snapshot.changesets {
        if let ChangesetEntry::Session {
            owner_id,
            live,
            draft,
            ..
        } = entry
            && *live
            && draft.is_none()
        {
            *draft = ledger
                .changeset_draft("session", owner_id, &workspace_key)
                .ok()
                .flatten()
                .as_ref()
                .map(draft_from_row);
        }
    }
}

/// Deterministic entry order: sessions (by id) before arcs (by ref).
/// The hunk-aware read of one contended path ([P12], [P14]), or `None` when
/// there is nothing to refine with — no live spans among the owners, or no
/// readable hunks. The caller falls back to file-level SHARED there, which is
/// the answer this whole pass exists to narrow and must never widen past.
///
/// The hunks come from the **async** diff spelling ([P16] flags), not from
/// `tugchanges_core::file_hunks`: that is `std::process::Command`, and this
/// runs on a tokio runtime thread. Both spellings carry `HUNK_DIFF_FLAGS`, so
/// the ids agree by Spec S06's contract — which is what lets the deck's
/// checkboxes and this verdict speak about the same hunks.
async fn contention_verdict(
    repo_root: &Path,
    path: &str,
    proof_ids: &HashSet<String>,
    dead_ids: &HashSet<String>,
    min_live: i64,
    ledger: Option<&SessionLedger>,
    canon: &HashMap<String, String>,
) -> Option<(
    tugchanges_core::ContentionVerdict,
    Vec<tugchanges_core::Hunk>,
)> {
    let ledger = ledger?;
    let canonical_root = CanonicalPath::from_raw(repo_root);
    let spans = ledger
        .file_event_spans_for_paths(canonical_root.as_str(), &[path.to_owned()])
        .unwrap_or_else(|err| {
            crate::ledger_integrity::health::note_error("changes", &err);
            tracing::warn!(path, error = %err, "span read failed; contention stays file-level");
            Vec::new()
        });
    let mut by_session: HashMap<String, Vec<tugchanges_core::Anchor>> = HashMap::new();
    for row in &spans {
        // A span written under an older segment of a line speaks for the
        // line's seat, same as its parent row did in the owner fold ([P01]).
        let owner_id = canon
            .get(&row.tug_session_id)
            .unwrap_or(&row.tug_session_id);
        if !proof_ids.contains(owner_id) {
            continue;
        }
        // The same row-liveness cut the owner buckets applied: a spent span
        // is evidence about committed content, not about this dirty file.
        if row.at < min_live {
            continue;
        }
        by_session
            .entry(owner_id.clone())
            .or_default()
            .push(tugchanges_core::Anchor::from_span(
                &row.span.kind,
                &row.span.anchor,
            ));
    }
    if by_session.is_empty() {
        return None;
    }
    let diff = super::git::fetch_git_diff(repo_root, &[path.to_owned()]).await?;
    let hunks = tugchanges_core::parse_hunks(&diff);
    if hunks.is_empty() {
        return None;
    }
    let owners: Vec<tugchanges_core::OwnerAnchors> = proof_ids
        .iter()
        .map(|id| tugchanges_core::OwnerAnchors {
            session: id.clone(),
            anchors: by_session.get(id.as_str()).cloned().unwrap_or_default(),
            // Dead is the retirement-eligible state, so only an id the owner
            // aggregation positively resolved as not-live reads dead ([P03]).
            live: !dead_ids.contains(id),
        })
        .collect();
    // The strong test a `WholeFile` anchor answers: are the file's bytes still
    // exactly the ones that write produced. Unreadable answers nothing, which
    // widens.
    let current_file_hash = std::fs::read(repo_root.join(path))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|text| tugchanges_core::content_hash(&text));
    let verdict =
        tugchanges_core::classify_contention(&hunks, &owners, current_file_hash.as_deref());
    Some((verdict, hunks))
}

fn entry_sort_key(entry: &ChangesetEntry) -> (u8, &str) {
    match entry {
        ChangesetEntry::Session { owner_id, .. } => (0, owner_id.as_str()),
        ChangesetEntry::Arc { owner_id, .. } => (1, owner_id.as_str()),
    }
}

/// Session row title: the user's `/rename` name when set, else the
/// session's callsign `tag`, else a one-line snippet of the last user
/// prompt, else the first 8 chars of the session id.
///
/// Only a **user-set** name outranks the callsign — an auto `aiTitle`
/// (`name_user_set = false`) does not front, so a tagged session reads as
/// its callsign rather than as a machine-written title.
fn session_row_title(row: &SessionRow) -> String {
    // The identity grammar (Spec S05, amended): a tagged row is
    // `<project>/<callsign>`, led by ` : ` and the user's name when one
    // exists. The project leaf is how a reader places a session among
    // sessions from many projects; a row with no project degrades to the
    // bare callsign.
    if let Some(tag) = &row.tag {
        let tag = tag.trim();
        if !tag.is_empty() {
            let leaf = project_leaf_name(&row.project_dir);
            let line = if leaf.is_empty() {
                tag.to_owned()
            } else {
                format!("{leaf}/{tag}")
            };
            if row.name_user_set {
                if let Some(name) = &row.name {
                    let name = name.trim();
                    if !name.is_empty() {
                        return format!("{name} : {line}");
                    }
                }
            }
            return line;
        }
    }
    if row.name_user_set {
        if let Some(name) = &row.name {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    if let Some(prompt) = &row.last_user_prompt {
        let snippet = snippet_for_display(prompt, 64);
        if !snippet.is_empty() {
            return snippet;
        }
    }
    row.session_id.chars().take(8).collect()
}

/// The trailing path component of a project dir — the project's leaf-name
/// identity, mirroring the deck's `projectLeafName`. Trailing slashes are
/// ignored; an empty or slash-only dir yields the trimmed input.
fn project_leaf_name(dir: &str) -> String {
    let trimmed = dir.trim_end_matches('/');
    let leaf = trimmed.rsplit('/').next().unwrap_or("");
    if leaf.is_empty() {
        trimmed.to_owned()
    } else {
        leaf.to_owned()
    }
}

/// Collapse whitespace runs to single spaces and truncate to `max` chars
/// with an ellipsis — mirrors the picker's `truncateForDisplay`.
fn snippet_for_display(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = flat.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Owner display name, on the same identity grammar as [`session_row_title`]:
/// `<name> : <project>/<callsign>` for a named tagged row,
/// `<project>/<callsign>` for a bare one, else the user-set `name`, else the
/// first 8 chars of the session id.
///
/// The id hash stays the exact `id[..8]` form for a tagless legacy row —
/// the client's hash-equality sniff still recognizes it.
fn session_display_name(pfe: &ProjectFileEvent) -> String {
    if let Some(tag) = &pfe.owner_tag {
        if !tag.is_empty() {
            let leaf = project_leaf_name(&pfe.event.project_dir);
            let line = if leaf.is_empty() {
                tag.clone()
            } else {
                format!("{leaf}/{tag}")
            };
            if pfe.owner_name_user_set {
                if let Some(name) = &pfe.owner_name {
                    if !name.is_empty() {
                        return format!("{name} : {line}");
                    }
                }
            }
            return line;
        }
    }
    if pfe.owner_name_user_set {
        if let Some(name) = &pfe.owner_name {
            if !name.is_empty() {
                return name.clone();
            }
        }
    }
    let id = &pfe.event.tug_session_id;
    id.chars().take(8).collect()
}

/// Project a persisted draft row onto its wire shape (Spec S10).
pub(crate) fn draft_from_row(row: &crate::session_ledger::ChangesetDraftRow) -> ChangesetDraft {
    ChangesetDraft {
        fingerprint: row.fingerprint.clone(),
        message: row.message.clone(),
        updated_at: row.updated_at,
        edited: row.edited,
        // The selection projects opaquely — every key the client wrote comes
        // back, including ones no Rust type names. A selection that fails to
        // parse (hand-mangled row) reads as no overrides rather than
        // poisoning the snapshot.
        selection: row
            .selection
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()),
    }
}

/// Canonical project dirs whose legacy `file_events` rows have already been
/// backfilled this process — the once-per-project guard for the opportunistic
/// lazy backfill in [`compose_snapshot`].
fn backfill_marker() -> &'static Mutex<HashSet<String>> {
    static MARKER: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    MARKER.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Project a recorded `file_path` to the repo-relative key `git status`
/// speaks, reconciling every storage form ([#l01-bridge-cases]):
///
/// - **Already relative** (new capture-time rows) — returned unchanged.
/// - **Absolute** (legacy rows) — both `repo_root` and `file_path` are routed
///   through the canonical gateway and stripped, so a firmlink/synthetic
///   spelling of the repo root collapses to the file's space before the strip.
/// - **Residual mismatch** — walk `file_path`'s ancestors for one that is the
///   same live directory as `repo_root` (`same_file`) and strip that; failing
///   all of it, return the input (falls to unattributed, never a wrong match).
///
/// The canonical root is passed in rather than derived: it is the same for
/// every row of a compose, and resolving it takes a global memo lock.
fn repo_relative(canonical_root: &CanonicalPath, repo_root: &Path, file_path: &str) -> String {
    // New capture-time rows are already repo-relative.
    if !file_path.starts_with('/') {
        return file_path.to_owned();
    }

    // Legacy absolute row: canonicalize both sides, then strip. The firmlink
    // split (repo_root and file_path spelled differently) collapses here.
    let canonical_file = CanonicalPath::from_raw(Path::new(file_path));
    if let Ok(rel) = canonical_file
        .as_path()
        .strip_prefix(canonical_root.as_path())
    {
        return rel.to_string_lossy().into_owned();
    }

    // Residual mismatch: find the ancestor of `file_path` that is the same live
    // directory as `repo_root` by `(dev, ino)`, then strip lexically.
    let file = Path::new(file_path);
    for ancestor in file.ancestors() {
        if same_file(ancestor, repo_root) {
            if let Ok(rel) = file.strip_prefix(ancestor) {
                return rel.to_string_lossy().into_owned();
            }
        }
    }
    file_path.to_owned()
}

/// Liveness cuts that survive between composes, keyed `(canonical_root, rel)`
/// → `(head_oid, cut_ms)`. The cut is derived from the last commit that touched
/// the path, so it can only change when a commit lands — which moves HEAD.
/// Holding the oid alongside the value makes that the invalidation: any commit,
/// merge, or reset mismatches and re-derives. Between commits an editing
/// session recomputes far more often than it commits, and every one of those
/// recomputes was re-running `git log` per dirty path.
///
/// Growth is one entry per path *ever* dirtied in this process's lifetime —
/// bounded in practice by the repo's file count.
type LiveCutCache = Mutex<HashMap<(String, String), (String, i64)>>;

fn live_cut_cache() -> &'static LiveCutCache {
    static CACHE: OnceLock<LiveCutCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The liveness cut for `rel`, through [`live_cut_cache`] when `head_oid` is
/// known. `None` (an unborn or unreadable HEAD) bypasses the cache entirely —
/// never wrong, just uncached.
async fn cached_min_live_at_ms(
    canonical_root: &CanonicalPath,
    repo_root: &Path,
    rel: &str,
    head_oid: Option<&str>,
) -> i64 {
    let Some(head_oid) = head_oid else {
        return min_live_at_ms(repo_root, rel).await;
    };
    let key = (canonical_root.as_str().to_owned(), rel.to_owned());
    if let Some((oid, cut)) = live_cut_cache().lock().expect("live cut cache").get(&key)
        && oid == head_oid
    {
        return *cut;
    }
    let cut = min_live_at_ms(repo_root, rel).await;
    live_cut_cache()
        .lock()
        .expect("live cut cache")
        .insert(key, (head_oid.to_owned(), cut));
    cut
}

/// The row-liveness cut for `rel` (epoch ms): a ledger row is live iff
/// `at >= min_live_at_ms`. Derived from the last commit that touched the path
/// (`git log -1 --format=%ct -- <rel>`), the whole commit second treated as
/// spent so ties break toward spent (the file degrades to unattributed —
/// visible, never falsely claimed). A path with no commit history (a
/// new/untracked file) returns 0: nothing was ever absorbed, every row is
/// live. Mirrors tugchanges-core's rule of the same name ([D112]).
async fn min_live_at_ms(repo_root: &Path, rel: &str) -> i64 {
    match git_stdout(repo_root, &["log", "-1", "--format=%ct", "--", rel]).await {
        Some(out) => match out.trim().parse::<i64>() {
            Ok(commit_secs) => (commit_secs + 1) * 1000,
            Err(_) => 0,
        },
        None => 0,
    }
}

/// One `base...branch` name-status row as a changeset file row.
///
/// The letter is the whole status for every case but a rename or copy, where
/// git appends a similarity score (`R100`); the entry carries the letter.
fn arc_file_row(file: tugarc_core::ArcDetailFile) -> ChangesetFile {
    let letter = file.status.chars().next().unwrap_or('M');
    let op = match letter {
        'A' => "created",
        'D' => "deleted",
        'R' => "renamed",
        _ => "modified",
    };
    ChangesetFile {
        path: file.path,
        git_status: letter.to_string(),
        op: op.to_owned(),
        origin: "arc".to_owned(),
        shared: false,
        last_touched: 0,
        own_hunks: Vec::new(),
        contested_hunks: Vec::new(),
        shared_with: Vec::new(),
        added: file.added,
        deleted: file.deleted,
    }
}

/// What an arc's recorded plan says about itself: its review state and its
/// ledger, from **one** parse.
///
/// Both readings come from the same document and the same read, so they are
/// taken together rather than by two functions that could be given two
/// different paths, or run against two different bytes on either side of a
/// write. An arc whose fraction says `2/5` and whose step list holds six rows
/// is the failure this shape removes.
///
/// `worktree_abs` is the arc worktree's absolute path as
/// `arc_detail_entries_in` resolved it, and `plan_path` is relative to that
/// worktree. **Nothing else joins in** — composing from the caller's repo root
/// would be the bug the absolute path exists to remove, and because every
/// failure here is silent, that bug would not raise: it would show up as a mark
/// that never appears.
///
/// Every failure path is `(None, empty)` deliberately ([P03]): a plan that
/// cannot be read has not been shown to be stale and has not been shown to have
/// no steps, and an unreadable plan is a normal state rather than an incident.
fn arc_plan_reading(abs: &Path) -> (Option<String>, Vec<ArcStep>, bool) {
    let Ok(source) = std::fs::read_to_string(abs)
        .inspect_err(|e| tracing::debug!(path = %abs.display(), error = %e, "arc plan unreadable"))
    else {
        return (None, Vec::new(), false);
    };
    let Ok(doc) = tugtool_core::plan::parse(&source) else {
        return (None, Vec::new(), false);
    };
    // The ledger, not the step headings: the ledger is what the step verbs
    // rewrite, so it is the only half of the document that moves as a run
    // walks — and `step_current` is counted against it too.
    let steps = doc
        .ledger_rows
        .iter()
        .map(|row| ArcStep {
            title: row.title.clone(),
            status: row.status.clone(),
        })
        .collect();
    let review = tugtool_core::plan::review_state(&doc, &source)
        .as_str()
        .to_string();
    (Some(review), steps, tugtool_core::plan::is_task_list(&doc))
}

/// The document whose ledger an arc's steps live in: its plan when it has one,
/// the `/arc` door's task list otherwise.
///
/// The same precedence `tugarc_core::ledger_file` applies on disk, read here
/// off the documents the walk already stat'd rather than by touching the
/// filesystem a second time.
fn ledger_document(documents: &tugarc_core::ArcDocuments) -> Option<&str> {
    documents.plan.as_deref().or(documents.tasks.as_deref())
}

/// Derive one arc entry per `refs/heads/tugarc/` branch.
///
/// The composition lives in `tugarc_core::arc_detail_entries_in` — the same
/// code `tugtool arc list|status` reads — so the CLI and the Changes card can
/// no longer disagree about an arc's base, worktree, or round count. This maps
/// that shared detail onto the wire type and adds the one thing only tugcast
/// knows: which live sessions are mated to each arc ([P08]).
///
/// tugarc-core is synchronous (git subprocesses), so the whole walk runs on
/// the blocking pool in one hop — the same discipline `do_changeset_join`
/// uses. `bound_sessions` comes from **one** ledger query for the repo, fanned
/// out across entries; never a query per arc.
/// Whether this compose must hide `repo_root`'s arcs: an app-test instance
/// composing the checkout under test.
///
/// The `--source-tree` bootstrap makes the checkout a workspace in every
/// instance, so without this an app-test's aggregate would list whatever arcs
/// the *developer* has out — and any assertion about the arc population (a
/// picker's rows, the Unbound section's presence) would be an assertion about
/// whoever runs the suite. An arc is for doing the work, not for running a
/// test: every fixture arc lives in a scratch repository, so the checkout's
/// arc entries are noise here by construction. Session entries are untouched
/// — the changes-attribution tests really do compose the checkout's dirt.
fn arcs_hidden_for(repo_root: &Path) -> bool {
    let is_apptest =
        tugcore::instance::instance_id().is_some_and(|id| tugcore::ports::is_apptest_id(&id));
    if !is_apptest {
        return false;
    }
    // The app-test recipe always pins the universe to the checkout it runs
    // from, so "is this the checkout?" has one spelling.
    let Ok(universe) = std::env::var(tugtool_core::REPO_UNIVERSE_ENV) else {
        return false;
    };
    if universe.trim().is_empty() {
        return false;
    }
    // `watch_path`, not `canonicalize`: the two must converge across macOS
    // firmlinks (`/u/...` vs `/System/Volumes/Data/...`), which canonicalize
    // alone does not resolve — the same reason the workspace registry keys
    // entries through PathResolver.
    let universe = crate::path_resolver::PathResolver::new(PathBuf::from(universe.trim()))
        .watch_path()
        .to_path_buf();
    let root = crate::path_resolver::PathResolver::new(repo_root.to_path_buf())
        .watch_path()
        .to_path_buf();
    root == universe
}

/// The engine's `ArcDocuments` as the wire's — the same six fields, one
/// crate boundary apart.
fn arc_documents(documents: tugarc_core::ArcDocuments) -> tugcast_core::types::ArcDocuments {
    tugcast_core::types::ArcDocuments {
        brief: documents.brief,
        brief_title: documents.brief_title,
        plan: documents.plan,
        plan_title: documents.plan_title,
        tasks: documents.tasks,
        tasks_title: documents.tasks_title,
    }
}

/// The arcs that exist only as documents — a `.tug/arcs/<name>/` with no
/// `tugarc/<name>` branch ([P04]).
///
/// This is what makes the planning phase visible as in-flight rather than the
/// arc appearing only once a branch is cut. A name with a branch is left to
/// `arc_entries`, so an arc is one row before and after `create` rather than
/// two.
pub(crate) async fn document_arc_entries(
    project_dir: &Path,
    ledger: Option<&crate::session_ledger::SessionLedger>,
) -> Vec<DocumentArcEntry> {
    let Some(root) = repo_root_for(project_dir).await else {
        return Vec::new();
    };
    // The same argument `arc_entries` makes: an app-test's aggregate must not
    // list the arcs the developer happens to be carrying in the checkout
    // under test.
    if arcs_hidden_for(&root) {
        return Vec::new();
    }
    let bound_by_arc = ledger
        .and_then(|l| l.bound_sessions_by_arc().ok())
        .unwrap_or_default();

    tokio::task::spawn_blocking(move || document_arc_entries_in(&root, &bound_by_arc))
        .await
        .unwrap_or_default()
}

/// The synchronous body of [`document_arc_entries`], split out so the scan is
/// testable without a runtime hop.
fn document_arc_entries_in(
    root: &Path,
    bound_by_arc: &std::collections::HashMap<String, Vec<String>>,
) -> Vec<DocumentArcEntry> {
    // Every arc-named directory, not only the ones holding a document: the
    // door's first act binds the session to a directory it has just made and
    // not yet written into, and a session bound to an arc the aggregate does
    // not list is a session whose card reads TASKS over a door in progress.
    // An empty directory nobody is bound to is still nothing — litter from an
    // abandoned door — and is dropped below exactly as before.
    tugarc_core::ops::document_arc_dirs(root)
        .into_iter()
        .filter(|name| !tugarc_core::ops::branch_exists(root, &format!("tugarc/{name}")))
        .filter_map(|name| {
            let documents = tugarc_core::ArcDocuments::read(root, &name);
            let owner_id = tugarc_core::ops::arc_owner_key(root, &name);
            let bound_sessions = bound_by_arc.get(&owner_id).cloned().unwrap_or_default();
            if documents.is_empty() && bound_sessions.is_empty() {
                return None;
            }
            let (review, steps, task_list) = ledger_document(&documents)
                .map(|plan| arc_plan_reading(Path::new(plan)))
                .unwrap_or((None, Vec::new(), false));
            // The arc record, read once: the run state below and the recorded
            // kind are two facts off the same read, exactly as the live arc's
            // composition takes them. The kind is what the branchless row was
            // missing, and it is the row every plain arc starts on.
            let record = tugarc_core::read_arc(root, &name);
            Some(DocumentArcEntry {
                bound_sessions,
                owner_id,
                task_list,
                step_total: steps.len() as u32,
                // The *closed* count: a withdrawn step is over, and the
                // fraction and the ticks on screen have to agree about how
                // many of a plan's steps are behind it.
                steps_done: steps
                    .iter()
                    .filter(|s| s.status == "done" || s.status == "withdrawn")
                    .count() as u32,
                steps_begun: steps.iter().filter(|s| s.status != "pending").count() as u32,
                review,
                arc_kind: record
                    .as_ref()
                    .and_then(|r| r.kind)
                    .map(|k| k.as_str().to_owned()),
                arc: record.map(|record| tugcast_core::types::ArcRunState {
                    stage: record.current_stage().map(|s| s.as_str().to_owned()),
                    stopped: record.stopped.as_ref().map(|(_, why)| why.clone()),
                    stopped_stage: record
                        .stopped
                        .as_ref()
                        .map(|(stage, _)| stage.as_str().to_owned()),
                    done: record.done,
                    note: record.notes.last().cloned(),
                }),
                documents: arc_documents(documents),
                display_name: name,
            })
        })
        .collect()
}

/// Base paths a live session **other than this arc's own** is working, mapped
/// to that session's `(owner_id, display_name)` — the id is what a notice to
/// the holder is addressed by, the name is what a sentence about them says.
///
/// The same fact [`compose_snapshot`] hands the arc composition, read fresh
/// for a verb that is about to move somebody's files. It recomposes rather
/// than reusing the feed's last snapshot on purpose: the card's copy is as old
/// as its last recompute, and a session that has since put its hand on the path
/// must still be named in the fold's attribution and told about it. One
/// composition on a user's press is a cost worth paying for that.
pub(crate) async fn live_base_dirt_for(
    project_dir: &Path,
    arc: &str,
    ledger: Option<&SessionLedger>,
) -> BTreeMap<String, (String, String)> {
    let Some(mut snapshot) = compose_snapshot(project_dir, ledger).await else {
        return BTreeMap::new();
    };
    // The arc rows this verb reads its owner key from ride the per-repo
    // attachment now, not the base compose.
    attach_arc_composition(project_dir, ledger, &mut snapshot).await;
    let owner_key = snapshot
        .changesets
        .iter()
        .find_map(|e| match e {
            ChangesetEntry::Arc {
                owner_id,
                display_name,
                ..
            } if display_name == arc => Some(owner_id.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let bound: Vec<String> = ledger
        .and_then(|l| l.bound_sessions_by_arc().ok())
        .and_then(|m| m.get(&owner_key).cloned())
        .unwrap_or_default();
    snapshot
        .changesets
        .iter()
        .filter_map(|e| match e {
            ChangesetEntry::Session {
                owner_id,
                display_name,
                live: true,
                files,
                ..
            } if !bound.contains(owner_id) => {
                Some((owner_id.clone(), display_name.clone(), files.clone()))
            }
            _ => None,
        })
        .flat_map(|(id, name, files)| {
            files
                .into_iter()
                .map(move |f| (f.path.clone(), (id.clone(), name.clone())))
        })
        .collect()
}

/// Whether any session holding this arc is still working.
///
/// An unbound arc — nobody holding it — is never busy: there is no turn that
/// could still be running, and an arc whose card was closed must stay
/// joinable. That is why this takes the bound list rather than the arc's own
/// facts; absence is the answer, not a missing input.
fn holders_busy(busy: &std::collections::HashSet<String>, bound: Option<&Vec<String>>) -> bool {
    bound.is_some_and(|sessions| sessions.iter().any(|id| busy.contains(id)))
}

async fn arc_entries(
    repo_root: &Path,
    ledger: Option<&crate::session_ledger::SessionLedger>,
    live_dirt: &BTreeMap<String, (String, String)>,
) -> Vec<ChangesetEntry> {
    if arcs_hidden_for(repo_root) {
        return Vec::new();
    }
    let bound_by_arc = ledger
        .and_then(|l| l.bound_sessions_by_arc().ok())
        .unwrap_or_default();
    // Who is still working. Read once for the whole recompute, from the
    // supervisor's in-memory ledger — the only place a session's turn and its
    // open background jobs are known ([P08]).
    let busy_sessions = crate::feeds::agent_supervisor::busy_session_ids().await;

    let root = repo_root.to_path_buf();
    let dirt = live_dirt.clone();
    let bound_for_scoping = bound_by_arc.clone();
    // One blocking hop for everything synchronous: the git walk *and* the plan
    // read each arc's review state needs. A second `spawn_blocking` would be a
    // second scheduling round trip for a file read that costs less than one of
    // the git subprocesses already in here ([P04]).
    let Ok(details) = tokio::task::spawn_blocking(move || {
        let details = tugarc_core::arc_detail_entries_in(&root);
        // Which branch the base checkout has out is a property of the
        // repository, not of an arc, so it is read once for the whole recompute
        // and handed to each arc's composition rather than re-read per arc.
        let current_branch = tugarc_core::ops::current_branch(&root).unwrap_or_default();
        // And the standing fold receipts, for the same reason and with more
        // force: reading them is one eager walk of the whole op log, so per-arc
        // it would be that walk once per arc in the loop below.
        let resolve_receipts = crate::feeds::join_board::standing_resolve_receipts(&root);
        let live: Vec<String> = details.iter().map(|d| d.owner_key.clone()).collect();
        crate::feeds::join_board::sweep(&live);
        // The same idea one level down: a workshop is a real checkout on disk,
        // and one whose arc is gone is a leak nothing else collects ([P07]).
        let live_names: Vec<String> = details.iter().map(|d| d.name.clone()).collect();
        crate::feeds::join_board::sweep_workshops(&root, &live_names);
        details
            .into_iter()
            .map(|detail| {
                let (review, steps, task_list) = ledger_document(&detail.documents)
                    .map(|plan| arc_plan_reading(Path::new(plan)))
                    .unwrap_or((None, Vec::new(), false));
                // Whose dirt a path is, scoped to *this* arc: a session mated
                // to it is no stranger to its files, so its edits read as the
                // user's own and stay resolvable ([D147]).
                let bound = bound_for_scoping
                    .get(&detail.owner_key)
                    .cloned()
                    .unwrap_or_default();
                let held_by_others: BTreeMap<String, String> = dirt
                    .iter()
                    .filter(|(_, (id, _))| !bound.contains(id))
                    .map(|(path, (_, name))| (path.clone(), name.clone()))
                    .collect();
                let join = crate::feeds::join_board::join_state_for(
                    &root,
                    &detail,
                    &current_branch,
                    &held_by_others,
                    &resolve_receipts,
                );
                (detail, review, steps, task_list, join)
            })
            .collect::<Vec<_>>()
    })
    .await
    else {
        return Vec::new();
    };

    // What the machine should do about each arc before anybody is asked to
    // look at it ([P01]). Decided here rather than inside the blocking hop
    // because boundness lives in `bound_by_arc`, which is already composed on
    // this side — and the predicate is pure and cheap, so deciding it here
    // costs nothing and saves cloning the map into the closure. Dispatched from
    // the async side for the same reason the frame is: a ladder that runs for
    // minutes must never hold a recompute (Spec S06).
    for (detail, _, _, _, join) in &details {
        let bound = bound_by_arc
            .get(&detail.owner_key)
            .is_some_and(|sessions| !sessions.is_empty());
        // An arc whose holder is still working is not finished, whatever its
        // git facts say, so the pilot does not start reconciling it. The
        // reconcile rewrites the arc's branch, and doing that while the
        // session's own backgrounded tests are running in that worktree is the
        // hazard `base_motion` already refuses mid-turn; two engines moving the
        // same branch must obey the same gate.
        if holders_busy(&busy_sessions, bound_by_arc.get(&detail.owner_key)) {
            continue;
        }
        if let Some(action) = crate::feeds::join_pilot::pilot_action(detail.join_ready, bound, join)
        {
            crate::feeds::join_pilot::dispatch(repo_root, &detail.name, action);
        }
    }

    details
        .into_iter()
        .map(
            |(detail, review, steps, task_list, join)| ChangesetEntry::Arc {
                join: Some(join),
                task_list,
                holders_busy: holders_busy(&busy_sessions, bound_by_arc.get(&detail.owner_key)),
                bound_sessions: bound_by_arc
                    .get(&detail.owner_key)
                    .cloned()
                    .unwrap_or_default(),
                // Whether an *attempt* to replay conflicted is knowledge only the
                // engine that attempted it has; the library composes everything
                // else. Empty when no engine is running, which is the truth then.
                replay_conflict_paths: crate::feeds::base_motion::conflict_paths_for(
                    &detail.owner_key,
                ),
                owner_id: detail.owner_key,
                display_name: detail.name,
                branch: Some(detail.branch),
                // The recorded kind, spelled as the log spells it. `None`
                // stays `None`: the wire never invents a kind ([B01]).
                arc_kind: detail.kind.map(|k| k.as_str().to_owned()),
                stage: Some(detail.stage),
                step_current: detail.step_current,
                step_total: detail.step_total,
                run_position: detail.run_position,
                run_length: detail.run_length,
                step_title: detail.step_title,
                last_activity: detail.last_activity,
                arc: detail.arc.map(|arc| tugcast_core::types::ArcRunState {
                    stage: arc.stage,
                    stopped: arc.stopped,
                    stopped_stage: arc.stopped_stage,
                    done: arc.done,
                    note: arc.note,
                }),
                documents: arc_documents(detail.documents),
                review,
                steps,
                base: detail.base,
                rounds: detail.rounds,
                worktree: detail.worktree_abs,
                worktree_dirty: detail.worktree_dirty,
                files: detail.files.into_iter().map(arc_file_row).collect(),
                round_subjects: detail.round_subjects,
                draft: None,
                base_ahead: detail.base_ahead,
                // The wire carries the paths; the relations behind them are
                // the blockers' business and ride `join.blockers[].overlap`.
                base_overlap: detail.base_overlap.into_iter().map(|o| o.path).collect(),
                last_replay: detail.last_replay,
                fit: detail.fit.map(|f| tugcast_core::types::ArcFit {
                    head: f.head,
                    base: f.base,
                    current: f.current,
                }),
            },
        )
        .collect()
}

/// Commit exactly `files` (repo-relative) in `repo_dir` with `message`
/// ([P15]), routed through `tugchanges_core::commit` ([P06]).
///
/// The staging-by-construction contract is unchanged — `tugchanges_core::commit`
/// with an explicit `--paths` set runs `git add -- <files…>` then
/// `git commit -m <message> -- <files…>`, committing **only** those paths and
/// refusing an empty list / blank message with the same error strings. The
/// sync library is driven off the async feed via `spawn_blocking`, the same
/// pattern tugcast uses for `tugarc-core` ([P02]).
///
/// Returns the structured [`tugchanges_core::CommitReceipt`]; the card path takes
/// `.sha` and the raw `.numstat` for the wire frame it already scrapes ([Q01]).
pub(crate) async fn run_changeset_commit(
    repo_dir: &Path,
    files: &[String],
    message: &str,
    hunks: Option<std::collections::BTreeMap<String, Vec<String>>>,
) -> Result<tugchanges_core::CommitReceipt, String> {
    let project = repo_dir.to_path_buf();
    let files = files.to_vec();
    let message = message.to_string();
    tokio::task::spawn_blocking(move || {
        // Explicit `--paths` bypasses bucketing, so this can never hit the
        // [P03] refusal; map any `CommitError` back to the card's `String` error.
        tugchanges_core::commit(tugchanges_core::CommitOptions {
            session: None,
            project: Some(project),
            message,
            paths: Some(files),
            hunks,
            ..Default::default()
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("commit task panicked: {e}"))?
}

/// The `files:` line both landing receipts carry — the per-file stats as
/// compact JSON, which the deck's receipt blocks parse back into their
/// expandable row list.
///
/// A local Serialize struct fixes the key order (declaration order) so the
/// durable string is stable and readable; `serde_json::json!` would sort the
/// keys alphabetically. One writer for the one line format, so the commit and
/// join receipts cannot drift apart in their bytes.
pub(crate) fn receipt_files_line(files: &[tugchanges_core::FileStat]) -> String {
    #[derive(serde::Serialize)]
    struct ReceiptFile<'a> {
        path: &'a str,
        status: &'a str,
        added: u32,
        removed: u32,
    }
    let entries: Vec<ReceiptFile> = files
        .iter()
        .map(|f| ReceiptFile {
            path: &f.path,
            status: &f.status,
            added: f.added.unwrap_or(0),
            removed: f.deleted.unwrap_or(0),
        })
        .collect();
    let files_json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string());
    format!("files: {files_json}")
}

/// The standard post-commit summary (Spec S02), formatted server-side so the
/// live ink row and the row restored from the shell ledger are byte-identical.
///
/// ```text
/// committed <sha[0..10]> · <N> file(s) · +<added> −<removed>
/// files: [{"path":"…","status":"modified","added":16,"removed":1}, …]
/// <full message>
/// ```
///
/// Line 0 is the fixed machine header; line 1 is a `files:` line carrying the
/// committed files' per-file stats as compact JSON (the receipt's expandable
/// freeze-dried file list); the whole commit message follows verbatim, so the
/// receipt can show up to three of its lines. `<N>` / `added` / `removed` are
/// derived from the same file set (a binary file's absent count is 0).
pub(crate) fn format_commit_summary(
    sha: &str,
    message: &str,
    files: &[tugchanges_core::FileStat],
) -> String {
    let short = &sha[..sha.len().min(10)];
    let message = message.trim();
    let count = files.len();
    let added: u64 = files.iter().map(|f| f.added.unwrap_or(0) as u64).sum();
    let removed: u64 = files.iter().map(|f| f.deleted.unwrap_or(0) as u64).sum();
    let files_line = receipt_files_line(files);
    format!("committed {short} · {count} file(s) · +{added} −{removed}\n{files_line}\n{message}")
}

/// The `/arc-join` receipt's durable summary (Spec S01).
///
/// Built like [`format_commit_summary`] and for the same reason: the header is
/// fixed so the deck's parser can claim it, `·` is U+00B7, and the message is
/// the one the join actually landed with — trimmed, never truncated, so the
/// receipt is the squash message rather than a description of it.
///
/// ```text
/// joined <sha[0..10]> · <arc> → <base> · <N> round(s)
/// fit: verified <head[0..10]> onto <base[0..10]>
/// files: [{"path":"…","status":"modified","added":16,"removed":1}, …]
/// <full message>
/// ```
///
/// The `files:` line is **omitted entirely** when `files` is empty, which is
/// also the shape every receipt written before the line existed carries. One
/// degradation, not two: the deck decides by the `files: ` prefix, so a legacy
/// row and a join with no readable file list take the same path.
///
/// The `fit:` line takes exactly that path, for exactly that reason: it sits
/// between the header and `files:`, is omitted when the arc carried no fit
/// fact, and is claimed by its own prefix rather than by its position.
pub(crate) fn format_join_summary(
    sha: &str,
    arc: &str,
    base: &str,
    rounds: u32,
    message: &str,
    files: &[tugchanges_core::FileStat],
    fit: Option<&tugarc_core::log::FitFact>,
) -> String {
    let short = &sha[..sha.len().min(10)];
    let message = message.trim();
    let header = format!("joined {short} · {arc} → {base} · {rounds} round(s)");
    let mut lines = vec![header];
    if let Some(fit) = fit {
        let word = if fit.current { "verified" } else { "stale" };
        let head = &fit.head[..fit.head.len().min(10)];
        let onto = &fit.base[..fit.base.len().min(10)];
        lines.push(format!("fit: {word} {head} onto {onto}"));
    }
    if !files.is_empty() {
        lines.push(receipt_files_line(files));
    }
    lines.push(message.to_string());
    lines.join("\n")
}

/// The per-file stats for a landing commit — the receipt's file list.
///
/// Read with the **same flags the row expansion fetches with** — the
/// `diff-tree --no-commit-id --root -M` of [`super::git::build_commit_diff_snapshot`],
/// which `git-diff-store.ts` documents as its `commit` flavor: "one commit
/// against its first parent". Every flag is load-bearing for that parity:
/// `-M` makes a rename one row here and one row there rather than two here and
/// one there, `--root` covers a root commit by diffing it against the empty
/// tree, and `core.quotepath=false` keeps a non-ASCII path spelled the same in
/// the list as in the fetch behind it. Matching them makes the summary's list
/// and the rows it expands into the same object by construction.
///
/// `-r` is explicit because `diff-tree` does not recurse by default: `-p` and
/// `--numstat` imply it, but `--name-status` does not, so without it the
/// status read reports top-level directories (`M  tugrust`) and every file
/// falls through to the "modified" default — a created or deleted file in a
/// join would be labelled wrong.
///
/// Either read failing yields an empty vec, which omits the `files:` line
/// rather than asserting a commit changed nothing.
pub(crate) async fn landing_file_stats(dir: &Path, sha: &str) -> Vec<tugchanges_core::FileStat> {
    let numstat = git_stdout(
        dir,
        &[
            "-c",
            "core.quotepath=false",
            "diff-tree",
            "--no-commit-id",
            "--root",
            "-r",
            "-M",
            "--numstat",
            sha,
        ],
    )
    .await;
    let name_status = git_stdout(
        dir,
        &[
            "-c",
            "core.quotepath=false",
            "diff-tree",
            "--no-commit-id",
            "--root",
            "-r",
            "-M",
            "--name-status",
            sha,
        ],
    )
    .await;
    match (numstat, name_status) {
        (Some(numstat), Some(name_status)) => tugchanges_core::file_stats(&numstat, &name_status),
        _ => Vec::new(),
    }
}

/// The `/arc-discard` receipt's durable summary (Spec S02).
///
/// A discard has no commit to name, so its identity is the arc and the size
/// of what it destroyed; the body is the round subjects the discard preflight
/// showed, which makes the receipt a record of exactly what the confirm took.
/// A clean arc renders the header line alone.
///
/// `files` is the arc's **range** diff (`base...branch`), which is what
/// `ArcDetail.files` holds — the files the arc touched, committed or not.
/// The word is plain `file(s)` for that reason: calling them dirty would name
/// a worktree state most of them are not in.
pub(crate) fn format_discard_summary(
    arc: &str,
    rounds: u32,
    files: u32,
    round_subjects: &[String],
    documents_kept: Option<&str>,
) -> String {
    // The verb leads and the count follows it bare. The header used to read
    // `released … · discarded N round(s)`, which said the act twice once the
    // verb itself became `discarded`.
    let mut header = format!("discarded {arc} · {rounds} round(s)");
    if files > 0 {
        header.push_str(&format!(", {files} file(s)"));
    }
    let mut lines: Vec<String> = round_subjects.to_vec();
    // The documents are not the work, and they outlive the arc: a discarded
    // arc's brief and plan are the only trace of decisions the user may want
    // back, so the receipt says they are still there ([P11]).
    if documents_kept.is_some() {
        lines.push(format!("Its documents stay at .tug/arcs/{arc}/."));
    }
    if lines.is_empty() {
        return header;
    }
    format!("{header}\n{}", lines.join("\n"))
}

/// Run a git command at `dir`, returning trimmed stdout on success, `None`
/// on any failure.
pub(crate) async fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new("git")
        // Same scrub as the engine's `git_output` — a per-process context
        // override must never skew a diff this side reads ([P06]).
        .env_remove("GIT_DIFF_OPTS")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_ledger::FileEventRow;
    use std::path::PathBuf;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A real repo with one commit; canonicalized so event project_dir
    /// strings match what `repo_root_for` resolves.
    fn init_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "t@t"]);
        git(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("committed.txt"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "base commit"]);
        (dir, root)
    }

    fn event(session: &str, tool_use: &str, path: &Path, project: &Path) -> FileEventRow {
        FileEventRow {
            tug_session_id: session.to_owned(),
            tool_use_id: tool_use.to_owned(),
            file_path: path.to_string_lossy().into_owned(),
            tool_name: "Write".to_owned(),
            op: "write".to_owned(),
            origin: "exact".to_owned(),
            ambiguous: false,
            parent_tool_use_id: None,
            project_dir: project.to_string_lossy().into_owned(),
            at: 1_700_000_000_000,
        }
    }

    /// Spans as the relay actually writes them: from an `Edit`'s own
    /// `old_string`/`new_string`, context lines and all. A fixture that mints
    /// an anchor from the *added* text instead tests a shape production never
    /// produces — which is how hunk-aware SHARED shipped green and placed
    /// nothing in the field.
    fn edit_spans_for(
        path: &Path,
        old_string: &str,
        new_string: &str,
    ) -> Vec<crate::session_ledger::FileEventSpan> {
        super::super::attribution::spans_for_tool_input(
            "Edit",
            &serde_json::json!({
                "file_path": path.to_string_lossy(),
                "old_string": old_string,
                "new_string": new_string,
            }),
        )
    }

    /// The feed's half of M03: two sessions in one file, each with anchors
    /// placing it in a different hunk, compose as co-owners without SHARED —
    /// and each carries its own hunks on the wire for the picker's default
    /// election. The verdict and its ids come from the async diff spelling,
    /// so this also exercises Spec S06's agreement from the feed side.
    ///
    /// The spans come through `spans_for_tool_input`, so an `own_hunks` that
    /// is a strict subset here is the same shape the badge renders from.
    #[tokio::test]
    async fn compose_reads_disjoint_regions_of_one_file_as_uncontended() {
        let (_dir, root) = init_repo();
        let original: String = (1..=60).map(|n| format!("line{n:03}\n")).collect();
        std::fs::write(root.join("both.txt"), &original).unwrap();
        git(&root, &["add", "both.txt"]);
        git(&root, &["commit", "-q", "-m", "long file"]);
        let edited = original
            .replace("line005\n", "TOP-EDIT\n")
            .replace("line050\n", "BOTTOM-EDIT\n");
        std::fs::write(root.join("both.txt"), &edited).unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        for (i, (session, old, new)) in [
            (
                "sess-alpha",
                "line004\nline005\nline006",
                "line004\nTOP-EDIT\nline006",
            ),
            (
                "sess-beta",
                "line049\nline050\nline051",
                "line049\nBOTTOM-EDIT\nline051",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            ledger
                .record_spawn(
                    session,
                    "ws",
                    &root.to_string_lossy(),
                    "card",
                    0,
                    session,
                    None,
                )
                .unwrap();
            let mut row = event(session, &format!("tu-{i}"), &root.join("both.txt"), &root);
            // The file is tracked, so the row must post-date its commit.
            row.at = 9_000_000_000_000;
            let spans = edit_spans_for(&root.join("both.txt"), old, new);
            ledger.record_file_event_with_spans(&row, &spans).unwrap();
        }

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let files: Vec<&ChangesetFile> = snapshot
            .changesets
            .iter()
            .filter_map(|entry| match entry {
                ChangesetEntry::Session { files, .. } => files.first(),
                _ => None,
            })
            .collect();
        assert_eq!(files.len(), 2, "both sessions own the file");
        for file in &files {
            assert_eq!(file.path, "both.txt");
            assert!(!file.shared, "disjoint regions do not contend");
            assert_eq!(file.own_hunks.len(), 1, "one region each");
            assert!(file.contested_hunks.is_empty());
        }
        assert_ne!(
            files[0].own_hunks, files[1].own_hunks,
            "and the regions are different ones"
        );
    }

    /// The same file, the same region: still SHARED, and the wire says which
    /// hunk the contention is in.
    #[tokio::test]
    async fn compose_still_shares_a_file_two_sessions_edited_in_one_region() {
        let (_dir, root) = init_repo();
        let original: String = (1..=60).map(|n| format!("line{n:03}\n")).collect();
        std::fs::write(root.join("both.txt"), &original).unwrap();
        git(&root, &["add", "both.txt"]);
        git(&root, &["commit", "-q", "-m", "long file"]);
        std::fs::write(
            root.join("both.txt"),
            original.replace("line005\n", "TOP-EDIT\n"),
        )
        .unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        for (i, session) in ["sess-alpha", "sess-beta"].into_iter().enumerate() {
            ledger
                .record_spawn(
                    session,
                    "ws",
                    &root.to_string_lossy(),
                    "card",
                    0,
                    session,
                    None,
                )
                .unwrap();
            let mut row = event(session, &format!("tu-{i}"), &root.join("both.txt"), &root);
            row.at = 9_000_000_000_000;
            let spans = edit_spans_for(
                &root.join("both.txt"),
                "line004\nline005\nline006",
                "line004\nTOP-EDIT\nline006",
            );
            ledger.record_file_event_with_spans(&row, &spans).unwrap();
        }

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        for entry in &snapshot.changesets {
            let ChangesetEntry::Session { files, .. } = entry else {
                continue;
            };
            assert!(files[0].shared, "one region, two owners");
            assert_eq!(files[0].contested_hunks, files[0].own_hunks);
        }
    }

    /// One session's evidence half places and half does not — the common
    /// field case. The badge widens (SHARED for both owners) while the
    /// election stays narrow: the half-placed owner carries only the hunk it
    /// can prove, so landing it cannot sweep up the co-owner's region.
    #[tokio::test]
    async fn compose_widens_shared_without_widening_the_election() {
        let (_dir, root) = init_repo();
        let original: String = (1..=60).map(|n| format!("line{n:03}\n")).collect();
        std::fs::write(root.join("both.txt"), &original).unwrap();
        git(&root, &["add", "both.txt"]);
        git(&root, &["commit", "-q", "-m", "long file"]);
        let edited = original
            .replace("line005\n", "TOP-EDIT\n")
            .replace("line050\n", "BOTTOM-EDIT\n");
        std::fs::write(root.join("both.txt"), &edited).unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        for (i, (session, old, new)) in [
            (
                "sess-alpha",
                "line004\nline005\nline006",
                "line004\nTOP-EDIT\nline006",
            ),
            (
                "sess-beta",
                "line049\nline050\nline051",
                "line049\nBOTTOM-EDIT\nline051",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            ledger
                .record_spawn(
                    session,
                    "ws",
                    &root.to_string_lossy(),
                    "card",
                    0,
                    session,
                    None,
                )
                .unwrap();
            let mut row = event(session, &format!("tu-{i}"), &root.join("both.txt"), &root);
            row.at = 9_000_000_000_000;
            let mut spans = edit_spans_for(&root.join("both.txt"), old, new);
            if session == "sess-alpha" {
                // A second edit whose text a later write overwrote — nothing
                // in the current diff carries it, so it places nowhere.
                let mut gone = edit_spans_for(
                    &root.join("both.txt"),
                    "line029\nline030\nline031",
                    "line029\nSINCE-OVERWRITTEN\nline031",
                );
                gone[0].seq = 1;
                spans.append(&mut gone);
            }
            ledger.record_file_event_with_spans(&row, &spans).unwrap();
        }

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let mut seen = 0;
        for entry in &snapshot.changesets {
            let ChangesetEntry::Session {
                owner_id, files, ..
            } = entry
            else {
                continue;
            };
            let file = &files[0];
            assert!(file.shared, "{owner_id}: unplaceable evidence still warns");
            assert_eq!(
                file.own_hunks.len(),
                1,
                "{owner_id}: elects only what its evidence reached"
            );
            seen += 1;
        }
        assert_eq!(seen, 2, "both sessions own the file");
    }

    /// Seed one long tracked file edited in two places, and give each session
    /// an `Edit`'s worth of spans for the region named. Returns the repo.
    async fn compose_two_owners(
        placements: [(&str, &str, &str); 2],
    ) -> (tempfile::TempDir, PathBuf, SessionLedger) {
        let (dir, root) = init_repo();
        let original: String = (1..=60).map(|n| format!("line{n:03}\n")).collect();
        std::fs::write(root.join("both.txt"), &original).unwrap();
        git(&root, &["add", "both.txt"]);
        git(&root, &["commit", "-q", "-m", "long file"]);
        let edited = original
            .replace("line005\n", "TOP-EDIT\n")
            .replace("line050\n", "BOTTOM-EDIT\n");
        std::fs::write(root.join("both.txt"), &edited).unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        for (i, (session, old, new)) in placements.into_iter().enumerate() {
            ledger
                .record_spawn(
                    session,
                    "ws",
                    &root.to_string_lossy(),
                    "card",
                    0,
                    session,
                    None,
                )
                .unwrap();
            let mut row = event(session, &format!("tu-{i}"), &root.join("both.txt"), &root);
            row.at = 9_000_000_000_000;
            let spans = edit_spans_for(&root.join("both.txt"), old, new);
            ledger.record_file_event_with_spans(&row, &spans).unwrap();
        }
        (dir, root, ledger)
    }

    /// The file's row as each session sees it, by owner id.
    fn files_by_owner(snapshot: &ChangesetSnapshot) -> BTreeMap<String, ChangesetFile> {
        snapshot
            .changesets
            .iter()
            .filter_map(|entry| match entry {
                ChangesetEntry::Session {
                    owner_id, files, ..
                } => files.first().map(|f| (owner_id.clone(), f.clone())),
                _ => None,
            })
            .collect()
    }

    /// Placements for the retirement cases: alpha's edit is right there in the
    /// current diff, beta's names text nothing in the file carries.
    const ALPHA_PLACES_BETA_DOES_NOT: [(&str, &str, &str); 2] = [
        (
            "sess-alpha",
            "line004\nline005\nline006",
            "line004\nTOP-EDIT\nline006",
        ),
        (
            "sess-beta",
            "line029\nline030\nline031",
            "line029\nSINCE-OVERWRITTEN\nline031",
        ),
    ];

    /// The plan's headline, end to end through compose: a closed session whose
    /// content is gone stops making a live session's file SHARED.
    #[tokio::test]
    async fn compose_retires_a_dead_owner_whose_evidence_places_nowhere() {
        let (_dir, root, ledger) = compose_two_owners(ALPHA_PLACES_BETA_DOES_NOT).await;
        ledger.mark_closed("sess-beta").unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let files = files_by_owner(&snapshot);
        let alpha = &files["sess-alpha"];
        assert!(!alpha.shared, "the ghost co-owner stopped warning");
        assert!(alpha.shared_with.is_empty());
        assert!(alpha.contested_hunks.is_empty());
    }

    /// The live floor, same fixture: while beta is running its unplaceable
    /// evidence still widens, exactly as before this plan.
    #[tokio::test]
    async fn compose_keeps_sharing_while_the_same_owner_is_live() {
        let (_dir, root, ledger) = compose_two_owners(ALPHA_PLACES_BETA_DOES_NOT).await;

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let files = files_by_owner(&snapshot);
        let alpha = &files["sess-alpha"];
        assert!(alpha.shared, "a live session may be mid-work");
        assert_eq!(
            alpha
                .shared_with
                .iter()
                .map(|o| (o.id.as_str(), o.live))
                .collect::<Vec<_>>(),
            vec![("sess-beta", true)],
            "and the badge says who with"
        );
    }

    /// Death alone retires nothing: a closed session whose content is still in
    /// the tree keeps contending, and the badge names it as closed — which is
    /// what makes the row recognizable, and releasable by hand.
    #[tokio::test]
    async fn compose_names_a_dead_owner_that_still_places() {
        let (_dir, root, ledger) = compose_two_owners([
            (
                "sess-alpha",
                "line004\nline005\nline006",
                "line004\nTOP-EDIT\nline006",
            ),
            (
                "sess-beta",
                "line004\nline005\nline006",
                "line004\nTOP-EDIT\nline006",
            ),
        ])
        .await;
        ledger.mark_closed("sess-beta").unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let files = files_by_owner(&snapshot);
        let alpha = &files["sess-alpha"];
        assert!(alpha.shared, "the content is right there");
        assert_eq!(
            alpha
                .shared_with
                .iter()
                .map(|o| (o.id.as_str(), o.live))
                .collect::<Vec<_>>(),
            vec![("sess-beta", false)]
        );
    }

    /// Absence of an answer is not death. An owner the liveness resolution
    /// never reached is missing from `dead_ids`, and the verdict must read it
    /// as live — the over-warning direction. Asserted at the verdict rather
    /// than through compose, where the owner aggregation the ids come from
    /// makes the gap unconstructible (and `debug_assert`ed for that reason).
    #[tokio::test]
    async fn an_unresolved_owner_reads_as_live() {
        let (_dir, root, ledger) = compose_two_owners(ALPHA_PLACES_BETA_DOES_NOT).await;
        let proof_ids: HashSet<String> = ["sess-alpha", "sess-beta"]
            .into_iter()
            .map(str::to_owned)
            .collect();

        let (unresolved, _) = contention_verdict(
            &root,
            "both.txt",
            &proof_ids,
            &HashSet::new(),
            i64::MIN,
            Some(&ledger),
            &HashMap::new(),
        )
        .await
        .expect("a verdict");
        assert!(unresolved.shared, "an unresolved owner widens");

        let (resolved_dead, _) = contention_verdict(
            &root,
            "both.txt",
            &proof_ids,
            &["sess-beta".to_owned()].into_iter().collect(),
            i64::MIN,
            Some(&ledger),
            &HashMap::new(),
        )
        .await
        .expect("a verdict");
        assert!(
            !resolved_dead.shared,
            "only a positively-resolved death retires"
        );
    }

    /// Risk R09's bound, structurally: a dirty set nobody contends spends no
    /// diffs at all. Asserted through the wire rather than a clock — every
    /// file coming back with no hunk ids is only possible if the contention
    /// pass never ran for any of them.
    #[tokio::test]
    async fn compose_runs_no_contention_pass_when_nothing_contends() {
        let (_dir, root) = init_repo();
        for i in 0..25 {
            std::fs::write(root.join(format!("f{i:02}.txt")), "x").unwrap();
        }
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess-alpha",
                "ws",
                &root.to_string_lossy(),
                "card",
                0,
                "sess-alpha",
                None,
            )
            .unwrap();
        for i in 0..25 {
            ledger
                .record_file_event(&event(
                    "sess-alpha",
                    &format!("tu-{i}"),
                    &root.join(format!("f{i:02}.txt")),
                    &root,
                ))
                .unwrap();
        }
        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let ChangesetEntry::Session { files, .. } = &snapshot.changesets[0] else {
            panic!("expected session entry");
        };
        assert_eq!(files.len(), 25);
        assert!(
            files
                .iter()
                .all(|f| !f.shared && f.own_hunks.is_empty() && f.contested_hunks.is_empty()),
            "a sole owner is never contended, and never costs a diff"
        );
    }

    #[tokio::test]
    async fn compose_partitions_owned_shared_and_unattributed() {
        let (_dir, root) = init_repo();
        std::fs::write(root.join("owned.txt"), "x").unwrap();
        std::fs::write(root.join("both.txt"), "x").unwrap();
        std::fs::write(root.join("hand-edit.txt"), "x").unwrap();
        // tainted.txt is tracked and then content-modified: a plain modify is
        // the ambiguous op the sole-holder promotion must NOT claim (the same
        // delta could be the user's hand-save of a tracked file). Structural
        // ops are covered by `compose_promotes_sole_holder_structural_op`.
        std::fs::write(root.join("tainted.txt"), "base\n").unwrap();
        git(&root, &["add", "tainted.txt"]);
        git(&root, &["commit", "-q", "--amend", "--no-edit"]);
        std::fs::write(root.join("tainted.txt"), "modified\n").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess-alpha",
                "ws",
                &root.to_string_lossy(),
                "card-1",
                0,
                "sess-alpha",
                Some("alpha-badge"),
            )
            .unwrap();
        ledger.rename("sess-alpha", Some("alpha work")).unwrap();

        ledger
            .record_file_event(&event("sess-alpha", "tu-1", &root.join("owned.txt"), &root))
            .unwrap();
        ledger
            .record_file_event(&event("sess-alpha", "tu-2", &root.join("both.txt"), &root))
            .unwrap();
        ledger
            .record_file_event(&event("sess-beta", "tu-3", &root.join("both.txt"), &root))
            .unwrap();
        // A bracket-only claim (also poisoned with the legacy ambiguous=1
        // column, which is ignored outright): correlation never decides, so
        // the file falls to `unattributed` — never auto-claimed by the
        // bracket's own session.
        let mut tainted = event("sess-alpha", "tu-4", &root.join("tainted.txt"), &root);
        tainted.origin = "bash".to_owned();
        tainted.ambiguous = true;
        // tainted.txt is tracked, so its event must post-date the base commit
        // to stay live (the row-liveness cut is the last commit time).
        tainted.at = 9_000_000_000_000;
        ledger.record_file_event(&tainted).unwrap();
        // An event whose file was since committed/reverted must drop out.
        ledger
            .record_file_event(&event(
                "sess-alpha",
                "tu-5",
                &root.join("committed.txt"),
                &root,
            ))
            .unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");

        assert_eq!(snapshot.branch, "main");
        assert_eq!(snapshot.head_message, "base commit");
        assert_eq!(snapshot.changesets.len(), 2);

        let ChangesetEntry::Session {
            owner_id,
            display_name,
            live,
            files,
            ..
        } = &snapshot.changesets[0]
        else {
            panic!("expected session entry");
        };
        assert_eq!(owner_id, "sess-alpha");
        // Every line wears a callsign ([P01]), so the title is the full
        // identity grammar rather than the name alone.
        let leaf = root.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(*display_name, format!("alpha work : {leaf}/alpha-badge"));
        assert!(live);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            ["both.txt", "owned.txt"],
            "a bracket-only claim never attributes — tainted.txt is not alpha's"
        );
        assert!(files[0].shared, "both.txt has two owners");
        assert!(!files[1].shared);
        assert_eq!(files[0].git_status, "??");

        let ChangesetEntry::Session {
            owner_id,
            display_name,
            live,
            files,
            ..
        } = &snapshot.changesets[1]
        else {
            panic!("expected session entry");
        };
        assert_eq!(owner_id, "sess-beta");
        // No sessions row for sess-beta: display falls back to the id
        // prefix and the entry reads not-live.
        assert_eq!(display_name, "sess-bet");
        assert!(!live);
        assert!(files[0].shared);

        let unattributed: Vec<&str> = snapshot
            .unattributed
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(unattributed, ["hand-edit.txt", "tainted.txt"]);

        // Bracket hints ([P13]): the stripped correlation-only holder is
        // recorded as `hinted_by` on the bracket-swept path; a plain hand
        // edit no bracket saw carries none.
        let hand_edit = &snapshot.unattributed[0];
        assert!(
            hand_edit.hinted_by.is_empty(),
            "no bracket saw hand-edit.txt"
        );
        let tainted = &snapshot.unattributed[1];
        assert_eq!(
            tainted.hinted_by,
            vec!["sess-alpha".to_string()],
            "the bracket holder surfaces as a hint, never an attribution"
        );
    }

    #[tokio::test]
    async fn compose_lifts_dead_only_owned_files_into_orphaned() {
        // A file proof-owned solely by a closed session is an orphan ([D120]):
        // the closed session keeps its rows, but no live card surfaces another
        // session's entry, so it must lift into the `orphaned` bucket. A file a
        // live session co-owns is NOT orphaned — it stays in the live entry.
        let (_dir, root) = init_repo();
        std::fs::write(root.join("orphan.txt"), "x").unwrap();
        std::fs::write(root.join("shared.txt"), "x").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        for s in ["sess-dead", "sess-live"] {
            ledger
                .record_spawn(
                    s,
                    "ws",
                    &root.to_string_lossy(),
                    "card",
                    0,
                    s,
                    Some(if s == "sess-dead" {
                        "ghost-badge"
                    } else {
                        "live-badge"
                    }),
                )
                .unwrap();
        }
        ledger.rename("sess-dead", Some("ghost work")).unwrap();
        // sess-dead proof-owns both files; sess-live proof-owns only shared.txt.
        ledger
            .record_file_event(&event("sess-dead", "tu-1", &root.join("orphan.txt"), &root))
            .unwrap();
        ledger
            .record_file_event(&event("sess-dead", "tu-2", &root.join("shared.txt"), &root))
            .unwrap();
        ledger
            .record_file_event(&event("sess-live", "tu-3", &root.join("shared.txt"), &root))
            .unwrap();
        // Close sess-dead → non-live. sess-live stays live.
        ledger.mark_closed("sess-dead").unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");

        // orphan.txt lifts out (dead's only exclusive file); shared.txt stays
        // owned (a live session holds it), so it is NOT orphaned.
        let orphaned: Vec<&str> = snapshot.orphaned.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(orphaned, ["orphan.txt"], "dead-only file is an orphan");
        assert_eq!(snapshot.orphaned[0].prior_owner_id, "sess-dead");
        let leaf = root.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(
            snapshot.orphaned[0].prior_owner_name,
            format!("ghost work : {leaf}/ghost-badge")
        );
        assert_eq!(snapshot.orphaned[0].origin, "exact");

        // sess-dead has no surviving entry (its only exclusive file was lifted;
        // shared.txt stays but under the live owner too — dead keeps its shared
        // copy). The live session keeps shared.txt.
        let live_entry = snapshot.changesets.iter().find_map(|e| match e {
            ChangesetEntry::Session {
                owner_id, files, ..
            } if owner_id == "sess-live" => Some(files),
            _ => None,
        });
        let live_files: Vec<&str> = live_entry
            .expect("live session entry")
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert!(live_files.contains(&"shared.txt"));
        // orphan.txt is not in the unattributed bucket — it is owned, just dead.
        assert!(
            !snapshot.unattributed.iter().any(|f| f.path == "orphan.txt"),
            "an orphan is owned (by a dead session), never unattributed"
        );
    }

    #[tokio::test]
    async fn compose_never_orphans_a_seated_session() {
        // The ivory-gumbo incident: a startup demote closes every row while
        // the user's card sits open on the work, and the lift — reading
        // `closed` as abandoned — offers the user their own files back. A
        // session the deck reports seated must read live to the compose no
        // matter what `sessions.state` says.
        let (_dir, root) = init_repo();
        std::fs::write(root.join("mine.txt"), "x").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess-seated",
                "ws",
                &root.to_string_lossy(),
                "card",
                0,
                "sess-seated",
                Some("seated-badge"),
            )
            .unwrap();
        ledger
            .record_file_event(&event("sess-seated", "tu-1", &root.join("mine.txt"), &root))
            .unwrap();
        // The demote window: the row reads closed, but the deck holds the
        // card open and says so.
        ledger.mark_closed("sess-seated").unwrap();
        super::super::deck_seatings::set_deck_seatings(
            7,
            std::iter::once("sess-seated".to_string()).collect(),
        );

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        super::super::deck_seatings::drop_deck_seatings(7);

        assert!(
            snapshot.orphaned.is_empty(),
            "a seated session's files never orphan, demoted row or not"
        );
        let entry = snapshot.changesets.iter().find_map(|e| match e {
            ChangesetEntry::Session {
                owner_id,
                live,
                files,
                ..
            } if owner_id == "sess-seated" => Some((*live, files)),
            _ => None,
        });
        let (live, files) = entry.expect("seated session owns its entry");
        assert!(live, "seated folds into liveness");
        assert_eq!(files[0].path, "mine.txt");
    }

    #[tokio::test]
    async fn compose_folds_a_rotated_lines_segments_into_one_owner() {
        // The rotation case ([P01]): one card, one line, two segment ids —
        // the old id closed by a relaunch, the new one live. Rows written
        // under both ids must fold into ONE entry keyed by the line's seat,
        // reading live, with nothing lifted to `orphaned` — never two
        // owners, one of them dead, offering the user their own files back.
        let (_dir, root) = init_repo();
        std::fs::write(root.join("early.txt"), "x").unwrap();
        std::fs::write(root.join("later.txt"), "x").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "seg-old",
                "ws",
                &root.to_string_lossy(),
                "card",
                0,
                "line-1",
                Some("rotated-badge"),
            )
            .unwrap();
        ledger
            .record_file_event(&event("seg-old", "tu-1", &root.join("early.txt"), &root))
            .unwrap();
        // The id rotates: the old segment closes, a new one spawns on the
        // same line and writes on.
        ledger.mark_closed("seg-old").unwrap();
        ledger
            .record_spawn(
                "seg-new",
                "ws",
                &root.to_string_lossy(),
                "card",
                1,
                "line-1",
                None,
            )
            .unwrap();
        ledger
            .record_file_event(&event("seg-new", "tu-2", &root.join("later.txt"), &root))
            .unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");

        assert!(
            snapshot.orphaned.is_empty(),
            "a rotated segment's files never orphan while the line lives"
        );
        let sessions: Vec<_> = snapshot
            .changesets
            .iter()
            .filter_map(|e| match e {
                ChangesetEntry::Session {
                    owner_id,
                    line_id,
                    live,
                    files,
                    ..
                } => Some((owner_id, line_id, live, files)),
                _ => None,
            })
            .collect();
        assert_eq!(sessions.len(), 1, "one line is one owner: {sessions:?}");
        let (owner_id, line_id, live, files) = &sessions[0];
        assert_eq!(*owner_id, "seg-new", "the seat segment fronts the line");
        assert_eq!(line_id.as_deref(), Some("line-1"));
        assert!(**live);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["early.txt", "later.txt"], "both segments' rows");
    }

    #[tokio::test]
    async fn compose_promotes_sole_holder_structural_op() {
        // The screenshot case: the session's shell deleted a tracked file
        // (`git rm` / `rm`), so only a bracket saw it — no Edit/Write proof
        // row. A delete has no editor hand-save story, so a sole bracket
        // holder claims it. A structural op with two bracket holders stays
        // ambiguous.
        let (_dir, root) = init_repo();
        // committed.txt exists in base; delete it → worktree delete (`.D`).
        std::fs::remove_file(root.join("committed.txt")).unwrap();
        // contested.txt: a new untracked file two sessions' brackets both saw
        // — the sole-holder guard keeps it unattributed.
        std::fs::write(root.join("contested.txt"), "x").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        for s in ["sess-alpha", "sess-beta"] {
            ledger
                .record_spawn(s, "ws", &root.to_string_lossy(), "card", 0, s, None)
                .unwrap();
        }
        ledger.rename("sess-alpha", Some("alpha work")).unwrap();

        let mut del = event("sess-alpha", "tu-del", &root.join("committed.txt"), &root);
        del.origin = "bash".to_owned();
        del.op = "deleted".to_owned();
        // committed.txt is tracked; its event must post-date the base commit
        // to stay live (the row-liveness cut is the last commit time).
        del.at = 9_000_000_000_000;
        ledger.record_file_event(&del).unwrap();
        for (s, tu) in [("sess-alpha", "tu-c1"), ("sess-beta", "tu-c2")] {
            let mut grab = event(s, tu, &root.join("contested.txt"), &root);
            grab.origin = "bash".to_owned();
            ledger.record_file_event(&grab).unwrap();
        }

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");

        // committed.txt is claimed by its sole bracket holder.
        let alpha = snapshot
            .changesets
            .iter()
            .find_map(|e| match e {
                ChangesetEntry::Session {
                    owner_id, files, ..
                } if owner_id == "sess-alpha" => Some(files),
                _ => None,
            })
            .expect("sess-alpha entry");
        let alpha_paths: Vec<&str> = alpha.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            alpha_paths,
            ["committed.txt"],
            "a sole-holder delete is promoted to attribution"
        );
        assert!(alpha[0].git_status.contains('D'));

        // contested.txt has two bracket holders — still ambiguous.
        let unattributed: Vec<&str> = snapshot
            .unattributed
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(
            unattributed,
            ["contested.txt"],
            "a structural op with two holders stays unattributed"
        );
    }

    #[tokio::test]
    async fn compose_bracket_grab_does_not_steal_or_share_an_exact_owners_file() {
        // The pinned regression (meek-sheep), in the card's compose: sess-a
        // exact-edited a.txt; sess-b's Bash/turn bracket swept it up (a
        // contaminated whole-tree delta). The file must appear under sess-a
        // alone, NOT shared, and must not appear under sess-b at all.
        let (_dir, root) = init_repo();
        std::fs::write(root.join("a.txt"), "x").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        for s in ["sess-a", "sess-b"] {
            ledger
                .record_spawn(s, "ws", &root.to_string_lossy(), "card", 0, s, None)
                .unwrap();
        }
        // sess-a: the real exact edit. sess-b: a bracket grab of the same file.
        ledger
            .record_file_event(&event("sess-a", "tu-a", &root.join("a.txt"), &root))
            .unwrap();
        let mut grab = event("sess-b", "tu-b", &root.join("a.txt"), &root);
        grab.origin = "bash".to_owned();
        ledger.record_file_event(&grab).unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let sessions: Vec<(&str, Vec<&str>, bool)> = snapshot
            .changesets
            .iter()
            .filter_map(|e| match e {
                ChangesetEntry::Session {
                    owner_id, files, ..
                } => Some((
                    owner_id.as_str(),
                    files.iter().map(|f| f.path.as_str()).collect(),
                    files.iter().any(|f| f.shared),
                )),
                _ => None,
            })
            .collect();
        // Exactly one session owns a.txt — sess-a — and it is not shared.
        let a = sessions
            .iter()
            .find(|(id, _, _)| *id == "sess-a")
            .expect("sess-a present");
        assert_eq!(a.1, ["a.txt"]);
        assert!(
            !a.2,
            "sess-a's file is not shared by a foreign bracket grab"
        );
        assert!(
            !sessions
                .iter()
                .any(|(id, files, _)| *id == "sess-b" && !files.is_empty()),
            "sess-b's bracket grab does not claim a.txt: {sessions:?}"
        );
        assert!(
            snapshot.unattributed.is_empty(),
            "a.txt is owned, not unattributed: {:?}",
            snapshot.unattributed
        );
    }

    #[tokio::test]
    async fn compose_spent_rows_never_reclaim_a_redirtied_file() {
        // Row liveness ([D112]): a session's row for committed.txt predates the
        // repo's commit (at = 1, epoch ~0), the commit absorbed that work, and
        // now someone re-dirties the file. The fossil row must not resurrect a
        // session entry — the file surfaces as unattributed, visible.
        let (_dir, root) = init_repo();
        std::fs::write(root.join("committed.txt"), "re-dirtied\n").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess",
                "ws",
                &root.to_string_lossy(),
                "card-1",
                0,
                "sess",
                None,
            )
            .unwrap();
        let mut ev = event("sess", "tu-1", &root.join("committed.txt"), &root);
        ev.at = 1;
        ledger.record_file_event(&ev).unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        assert!(
            snapshot
                .changesets
                .iter()
                .all(|e| !matches!(e, ChangesetEntry::Session { files, .. } if !files.is_empty())),
            "no session entry claims the re-dirtied file"
        );
        let unattributed: Vec<&str> = snapshot
            .unattributed
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(unattributed, ["committed.txt"]);
    }

    /// The liveness cut survives between composes keyed by HEAD, so a commit
    /// landing between them must re-derive it: the row that was live before
    /// the commit is spent after it, and the file falls to unattributed. A
    /// cache that outlived the commit would keep claiming the file.
    #[tokio::test]
    async fn a_commit_between_composes_invalidates_the_cached_liveness_cut() {
        let (_dir, root) = init_repo();
        std::fs::write(root.join("committed.txt"), "edited\n").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess",
                "ws",
                &root.to_string_lossy(),
                "card-1",
                0,
                "sess",
                None,
            )
            .unwrap();
        let mut ev = event("sess", "tu-1", &root.join("committed.txt"), &root);
        // Past the fixture commit's cut, which rounds up to the next second.
        ev.at = crate::session_ledger::now_millis() + 2_000;
        ledger.record_file_event(&ev).unwrap();

        let owned = |snapshot: &ChangesetSnapshot| {
            snapshot
                .changesets
                .iter()
                .any(|e| matches!(e, ChangesetEntry::Session { files, .. } if !files.is_empty()))
        };

        let first = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        assert!(owned(&first), "the row postdates the fixture's commit");

        // The commit absorbs that work; re-dirtying the file must not let the
        // now-fossil row reclaim it. The cut rounds up to the next whole
        // second, so the commit has to land past the row's stamp.
        tokio::time::sleep(std::time::Duration::from_millis(2_100)).await;
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "absorb the edit"]);
        std::fs::write(root.join("committed.txt"), "re-dirtied\n").unwrap();

        let second = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        assert!(!owned(&second), "the commit spent the row");
        assert_eq!(
            second
                .unattributed
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["committed.txt"]
        );
    }

    /// A document carrying everything `plan::parse` requires and one round with
    /// no stamp yet — the state a review is in just before it stamps.
    const UNSTAMPED_PLAN: &str = r#"## A Minimal Plan {#minimal-plan}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | Someone |

### Review Record {#review-record}

**Round 1 — 2026-08-14, opus.** Lint: 0 errors, 0 warnings.

### Phase Overview {#phase-overview}

Some context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The only step | pending | — |

#### Step 1: The only step {#step-1}

**Commit:** `thing(scope): do it`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the thing.

**Tests:**
- [ ] Unit: the thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the thing.
"#;

    /// Write `UNSTAMPED_PLAN` into `dir/plan.md`, stamped or not.
    fn write_plan(dir: &Path, stamped: bool) {
        let source = if stamped {
            tugtool_core::plan::set_review_stamp(UNSTAMPED_PLAN).expect("stampable")
        } else {
            UNSTAMPED_PLAN.to_string()
        };
        std::fs::write(dir.join("plan.md"), source).unwrap();
    }

    /// Write a plan into an arc's own documents home, with one ledger row per
    /// entry of `statuses` so the scan's progress counting has something to
    /// count.
    fn write_arc_plan(root: &Path, name: &str, statuses: &[&str], stamped: bool) {
        let mut ledger = String::new();
        let mut steps = String::new();
        for (i, status) in statuses.iter().enumerate() {
            let n = i + 1;
            ledger.push_str(&format!("| #step-{n} | Step {n} | {status} | — |\n"));
            steps.push_str(&format!(
                "#### Step {n}: Step {n} {{#step-{n}}}\n\n\
                 **Commit:** `thing(scope): do it`\n\n\
                 **References:** (#phase-overview)\n\n\
                 **Tasks:**\n- [ ] Do the thing.\n\n\
                 **Tests:**\n- [ ] Unit: the thing works.\n\n\
                 **Checkpoint:**\n- [ ] `cargo nextest run`\n\n"
            ));
        }
        let source = UNSTAMPED_PLAN
            .replace("| #step-1 | The only step | pending | — |\n", &ledger)
            .replace(
                "#### Step 1: The only step {#step-1}\n\n\
                 **Commit:** `thing(scope): do it`\n\n\
                 **References:** [P01] the decision, (#phase-overview)\n\n\
                 **Tasks:**\n- [ ] Do the thing.\n\n\
                 **Tests:**\n- [ ] Unit: the thing works.\n\n\
                 **Checkpoint:**\n- [ ] `cargo nextest run`\n\n",
                &steps,
            );
        let source = if stamped {
            tugtool_core::plan::set_review_stamp(&source).expect("stampable")
        } else {
            source
        };
        let dir = root.join(".tug").join("arcs").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plan.md"), source).unwrap();
    }

    fn write_arc_brief(root: &Path, name: &str, title: &str) {
        let dir = root.join(".tug").join("arcs").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("brief.md"), format!("# {title}\n\nProse.\n")).unwrap();
    }

    fn document_entries(root: &Path) -> Vec<DocumentArcEntry> {
        document_arc_entries_in(root, &std::collections::HashMap::new())
    }

    /// Write a `/arc` door's task list: the steps and the ledger and nothing
    /// else — no metadata, no phase overview, no deliverables.
    fn write_arc_task_list(root: &Path, name: &str, statuses: &[&str]) {
        let dir = root.join(".tug").join("arcs").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let mut ledger = String::new();
        let mut steps = String::new();
        for (i, status) in statuses.iter().enumerate() {
            let n = i + 1;
            ledger.push_str(&format!("| #step-{n} | Step {n} | {status} | — |\n"));
            steps.push_str(&format!(
                "#### Step {n}: Step {n} {{#step-{n}}}\n\nDo it.\n\n"
            ));
        }
        std::fs::write(
            dir.join("tasks.md"),
            format!(
                "# The task list {{#tasks}}\n\n\
                 ### Execution Steps {{#execution-steps}}\n\n\
                 #### Step Status Ledger {{#step-status-ledger}}\n\n\
                 | Step | Title | Status | Commit |\n|---|---|---|---|\n{ledger}\n{steps}"
            ),
        )
        .unwrap();
    }

    /// An arc's ledger lives in `tasks.md`, and the shade reads it
    /// exactly as it reads a plan's — same rows, same counts, and the
    /// `task_list` flag set so no surface asks it about a review it cannot have.
    #[test]
    fn a_arc_whose_ledger_is_a_task_list_reports_its_steps() {
        let (_dir, root) = init_repo();
        write_arc_brief(&root, "direct", "The direct brief");
        write_arc_task_list(&root, "direct", &["done", "pending", "pending"]);

        let entry = document_entries(&root)
            .into_iter()
            .find(|e| e.display_name == "direct")
            .expect("the task-list arc is listed");
        assert_eq!(entry.step_total, 3);
        assert_eq!(entry.steps_done, 1);
        assert!(entry.task_list, "a tasks.md is a task list");
        assert_eq!(
            entry.documents.tasks.as_deref(),
            Some(&*root.join(".tug/arcs/direct/tasks.md").to_string_lossy())
        );
    }

    /// A plan outranks a task list wherever the ledger is read — the shade
    /// included, so an arc that grew a plan shows the plan's rows.
    #[test]
    fn a_plan_beside_a_task_list_is_what_the_shade_reads() {
        let (_dir, root) = init_repo();
        write_arc_brief(&root, "both-docs", "The brief");
        write_arc_task_list(&root, "both-docs", &["pending", "pending", "pending"]);
        write_arc_plan(&root, "both-docs", &["done", "pending"], true);

        let entry = document_entries(&root)
            .into_iter()
            .find(|e| e.display_name == "both-docs")
            .expect("the arc is listed");
        assert_eq!(entry.step_total, 2, "the plan's rows, not the task list's");
        assert!(!entry.task_list);
    }

    /// The planning phase in flight: an arc exists the moment it has a
    /// document, and stops being a *document-only* arc the moment it has a
    /// branch — one row throughout, never two ([P04]).
    #[test]
    fn a_document_only_arc_is_listed_until_its_branch_exists() {
        let (_dir, root) = init_repo();
        write_arc_brief(&root, "foo", "The foo brief");

        let entries = document_entries(&root);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].display_name, "foo");
        assert_eq!(
            entries[0].documents.brief.as_deref(),
            Some(&*root.join(".tug/arcs/foo/brief.md").to_string_lossy())
        );
        assert_eq!(
            entries[0].documents.brief_title.as_deref(),
            Some("The foo brief")
        );
        assert!(entries[0].documents.plan.is_none());
        assert_eq!(entries[0].review, None);
        assert_eq!(entries[0].step_total, 0);

        // Cutting the branch moves the arc to the live list rather than
        // adding a second row.
        git(&root, &["branch", "tugarc/foo"]);
        assert!(document_entries(&root).is_empty());
    }

    /// The recorded kind rides the branchless row too, and that row is where
    /// every plain arc begins: its door writes the documents, records the
    /// kind, and creates no worktree. Read off the arc record this
    /// composition already reads and never sniffed from the documents — a
    /// plain arc's brief and task list are exactly the shape the old sniff
    /// read as planned.
    #[test]
    fn a_document_only_arc_carries_its_recorded_kind() {
        // The arc log lives under the data dir; nextest runs one process per
        // test, so redirecting it here cannot reach another test.
        let data = tempfile::tempdir().unwrap();
        // SAFETY: single-threaded setup, and this process runs one test.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", data.path());
        }
        let (_dir, root) = init_repo();
        write_arc_brief(&root, "plain-arc", "The plain brief");
        write_arc_task_list(&root, "plain-arc", &["pending", "pending"]);
        tugarc_core::append_arc_start(&root, "plain-arc", ".tug/arcs/plain-arc/tasks.md").unwrap();
        tugarc_core::append_arc_kind(&root, "plain-arc", tugarc_core::ArcKind::Plain).unwrap();
        // And one whose log never said, beside it.
        write_arc_brief(&root, "pre-kind", "The pre-kind brief");

        let entries = document_entries(&root);
        let by_name: std::collections::HashMap<&str, &DocumentArcEntry> = entries
            .iter()
            .map(|e| (e.display_name.as_str(), e))
            .collect();
        assert_eq!(by_name["plain-arc"].arc_kind.as_deref(), Some("plain"));
        // The record spoke, so the run state is there beside it — the two are
        // one read, and this is what says the hoist kept both.
        assert!(by_name["plain-arc"].arc.is_some());
        assert_eq!(by_name["pre-kind"].arc_kind, None);
    }

    /// A document-only arc reads its plan's review state and ledger the same
    /// way a live arc does — the facts a next-gesture is chosen from.
    #[test]
    fn document_arc_entries_read_review_and_steps() {
        let (_dir, root) = init_repo();
        write_arc_plan(
            &root,
            "reviewed-arc",
            &["done", "in progress", "pending"],
            true,
        );
        write_arc_plan(&root, "fresh-arc", &["pending"], false);

        let entries = document_entries(&root);
        let by_name: std::collections::HashMap<&str, &DocumentArcEntry> = entries
            .iter()
            .map(|e| (e.display_name.as_str(), e))
            .collect();

        let reviewed = by_name["reviewed-arc"];
        assert_eq!(reviewed.review.as_deref(), Some("reviewed"));
        assert_eq!(reviewed.step_total, 3);
        // Two facts, two fields: one row finished, two opened.
        assert_eq!((reviewed.steps_done, reviewed.steps_begun), (1, 2));

        let fresh = by_name["fresh-arc"];
        assert_eq!(fresh.review.as_deref(), Some("never-reviewed"));
        assert_eq!((fresh.steps_done, fresh.steps_begun), (0, 0));

        // Sorted by name, so the list is stable across recomputes.
        assert_eq!(
            entries
                .iter()
                .map(|e| e.display_name.as_str())
                .collect::<Vec<_>>(),
            vec!["fresh-arc", "reviewed-arc"]
        );
    }

    /// **An empty directory lists when a session is bound to it, and only
    /// then.** The door's first act makes the directory and binds in one verb,
    /// before the brief exists; the card reads `ARC` off the binding, so the
    /// aggregate has to carry the arc in that gap. An empty directory nobody
    /// is bound to is an abandoned door and stays off the wire.
    #[test]
    fn an_empty_directory_lists_only_while_a_session_is_bound_to_it() {
        let (_dir, root) = init_repo();
        for name in ["opening", "abandoned"] {
            std::fs::create_dir_all(root.join(".tug").join("arcs").join(name)).unwrap();
        }
        let mut bound = std::collections::HashMap::new();
        bound.insert(
            tugarc_core::ops::arc_owner_key(&root, "opening"),
            vec!["sess-1".to_string()],
        );

        let entries = document_arc_entries_in(&root, &bound);
        assert_eq!(
            entries
                .iter()
                .map(|e| e.display_name.as_str())
                .collect::<Vec<_>>(),
            vec!["opening"]
        );
        let opening = &entries[0];
        assert_eq!(opening.bound_sessions, vec!["sess-1".to_string()]);
        assert!(opening.documents.brief.is_none());
        assert!(opening.documents.plan.is_none());
        assert!(opening.documents.tasks.is_none());
        assert_eq!(opening.step_total, 0);

        // Unbound, the same directory is nothing — exactly as before.
        assert!(document_entries(&root).is_empty());
    }

    /// A withdrawn step is closed and begun, so the fraction the feed reports
    /// never reads short of the ticks drawn beside it.
    #[test]
    fn a_withdrawn_step_counts_as_closed() {
        let (_dir, root) = init_repo();
        write_arc_plan(
            &root,
            "skipped-arc",
            &["done", "withdrawn", "pending"],
            true,
        );

        let entries = document_entries(&root);
        let skipped = &entries[0];
        assert_eq!(skipped.display_name, "skipped-arc");
        assert_eq!(skipped.step_total, 3);
        assert_eq!((skipped.steps_done, skipped.steps_begun), (2, 2));
    }

    /// A live arc carries the same documents on its own entry, absolute.
    #[test]
    fn arc_entries_carry_absolute_document_paths() {
        let (_dir, root) = init_repo();
        write_arc_brief(&root, "live", "The live brief");
        write_arc_plan(&root, "live", &["done", "pending"], true);

        let documents = tugarc_core::ArcDocuments::read(&root, "live");
        let wire = arc_documents(documents);
        assert_eq!(
            wire.plan.as_deref(),
            Some(&*root.join(".tug/arcs/live/plan.md").to_string_lossy())
        );
        assert!(wire.plan.as_deref().unwrap().starts_with('/'));
        assert_eq!(wire.brief_title.as_deref(), Some("The live brief"));

        let (review, steps, task_list) = arc_plan_reading(Path::new(wire.plan.as_deref().unwrap()));
        assert_eq!(review.as_deref(), Some("reviewed"));
        assert_eq!(steps.len(), 2);
        // The fixture is written against the skeleton, so it is a plan.
        assert!(!task_list);
    }

    #[test]
    fn arc_plan_reading_reads_reviewed_for_a_stamped_plan() {
        let dir = tempfile::tempdir().unwrap();
        write_plan(dir.path(), true);
        assert_eq!(
            arc_plan_reading(&dir.path().join("plan.md")).0.as_deref(),
            Some("reviewed")
        );
    }

    #[test]
    fn arc_plan_reading_reads_stale_after_the_document_moves() {
        let dir = tempfile::tempdir().unwrap();
        write_plan(dir.path(), true);
        let path = dir.path().join("plan.md");
        let moved = format!(
            "{}\nOne more line.\n",
            std::fs::read_to_string(&path).unwrap()
        );
        std::fs::write(&path, moved).unwrap();
        assert_eq!(
            arc_plan_reading(&dir.path().join("plan.md")).0.as_deref(),
            Some("stale")
        );
    }

    #[test]
    fn arc_plan_reading_reads_never_reviewed_without_a_stamp() {
        let dir = tempfile::tempdir().unwrap();
        write_plan(dir.path(), false);
        assert_eq!(
            arc_plan_reading(&dir.path().join("plan.md")).0.as_deref(),
            Some("never-reviewed")
        );
    }

    /// The other half of the reading: the ledger, which is the only source a
    /// surface has for what an arc's walk *is*. Counted off `ledger_rows`
    /// rather than the step headings, for the reason the plan-doc scan counts
    /// off them — the ledger is what the step verbs rewrite.
    #[test]
    fn arc_plan_reading_carries_the_ledger_rows() {
        let dir = tempfile::tempdir().unwrap();
        write_plan(dir.path(), true);
        let (_, steps, _) = arc_plan_reading(&dir.path().join("plan.md"));
        assert_eq!(
            steps,
            vec![ArcStep {
                title: "The only step".to_string(),
                status: "pending".to_string(),
            }]
        );
    }

    /// Both failures read as *nothing to say*, not as an accusation: a plan
    /// nobody can read has not been shown to be unreviewed, and has not been
    /// shown to have no steps.
    #[test]
    fn arc_plan_reading_is_absent_for_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let (review, steps, task_list) = arc_plan_reading(&dir.path().join("plan.md"));
        assert!(review.is_none());
        assert!(steps.is_empty());
        // Unreadable is not a task list either: absence says nothing at all.
        assert!(!task_list);
    }

    #[test]
    fn arc_plan_reading_is_absent_for_a_document_that_is_not_a_plan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("plan.md"), "# Notes\n\nJust prose.\n").unwrap();
        assert!(arc_plan_reading(&dir.path().join("plan.md")).0.is_none());
    }

    /// The composition asked from a *linked worktree* — the shape a card whose
    /// project directory is itself a worktree produces, which is every arc's
    /// own debug build. The plan lives in the arc's worktree, and the only
    /// path that finds it is the absolute one the detail carries; composing
    /// from the caller's root here would return `None`, which is indisting-
    /// uishable from an arc with no plan.
    /// The recompute is what starts the pilot ([P01]) — nobody presses.
    ///
    /// This is the seam the two halves meet at: the predicate and the dispatch
    /// both run on the async side, over state already in hand, so the changeset
    /// frame goes out without waiting on a ladder that may run for minutes. A
    /// ready arc bound to a live session wants reconciling; one still
    /// implementing wants nothing, and neither does one nobody is looking at
    /// ([P08]).
    #[tokio::test]
    async fn a_ready_bound_arc_is_piloted_off_the_recompute_with_no_press() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct Counting(Arc<AtomicUsize>);

        #[async_trait::async_trait]
        impl crate::feeds::join_pilot::PilotRunner for Counting {
            async fn reconcile(
                &self,
                _project_dir: &str,
                _arc: &str,
                occupancy: crate::feeds::join_occupancy::JoinOccupancy,
            ) {
                drop(occupancy);
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        // The arc log lives under the data dir; nextest runs one process per
        // test, so redirecting it here cannot reach another test.
        let data = tempfile::tempdir().unwrap();
        // SAFETY: single-threaded setup, and this process runs one test.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", data.path());
        }

        let runs = Arc::new(AtomicUsize::new(0));
        crate::feeds::join_pilot::register_runner(Box::new(Counting(Arc::clone(&runs))));

        let (_dir, root) = init_repo();
        git(&root, &["branch", "tugarc/pending"]);
        git(&root, &["config", "branch.tugarc/pending.tugbase", "main"]);
        git(&root, &["branch", "tugarc/finished"]);
        git(&root, &["config", "branch.tugarc/finished.tugbase", "main"]);
        // A round on the arc branch: an arc with nothing to join carries an
        // `empty` blocker, and a blocked arc is one the pilot leaves alone.
        git(&root, &["switch", "-q", "tugarc/finished"]);
        std::fs::write(root.join("round.txt"), "r1\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "r1"]);
        git(&root, &["switch", "-q", "main"]);
        // Nothing declares this arc finished: a landed round on a plan-less
        // arc with a clean worktree is the arming fact ([P02]).

        // Nobody is bound to it yet, so the pilot leaves it alone — the ask it
        // would be preparing has no card to raise on ([P08]).
        let entries = arc_entries(&root, None, &BTreeMap::new()).await;
        assert_eq!(entries.len(), 2, "both arcs compose");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(
            runs.load(Ordering::SeqCst),
            0,
            "an unbound arc is never piloted, ready or not"
        );

        let owner_key = tugarc_core::ops::ensure_arc_id(&root, "finished").unwrap();
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess-1",
                &root.to_string_lossy(),
                &root.to_string_lossy(),
                "card-1",
                crate::session_ledger::now_millis(),
                "sess-1",
                None,
            )
            .unwrap();
        ledger
            .set_arc_binding("sess-1", Some((&owner_key, "finished")))
            .unwrap();

        let entries = arc_entries(&root, Some(&ledger), &BTreeMap::new()).await;
        assert_eq!(entries.len(), 2, "both arcs compose");

        // The dispatch is a spawned task, so give it its scheduling turn. It is
        // deliberately *not* awaited by the recompute — that is the property
        // under test as much as the run itself.
        for _ in 0..200 {
            if runs.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            runs.load(Ordering::SeqCst),
            1,
            "exactly the ready arc is piloted, and exactly once"
        );
        assert!(
            tugarc_core::verify::read_pilot_mark(&root, "finished").is_some(),
            "the pair it acted on is claimed"
        );
        assert!(
            tugarc_core::verify::read_pilot_mark(&root, "pending").is_none(),
            "an arc still implementing is never touched"
        );

        // A second recompute over unmoved heads adds nothing: the mark holds.
        let _ = arc_entries(&root, Some(&ledger), &BTreeMap::new()).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(
            runs.load(Ordering::SeqCst),
            1,
            "an unchanged head pair does not re-kick"
        );
    }

    #[tokio::test]
    async fn arc_entries_read_review_state_from_a_linked_worktree() {
        let (_dir, root) = init_repo();
        git(&root, &["branch", "tugarc/demo"]);
        git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                ".tug/worktrees/demo",
                "tugarc/demo",
            ],
        );
        let documents = root.join(".tug/arcs/demo");
        std::fs::create_dir_all(&documents).unwrap();
        write_plan(&documents, true);

        // A second, unrelated worktree stands in for the card's project dir.
        git(&root, &["branch", "sidecar"]);
        git(
            &root,
            &["worktree", "add", "-q", ".tug/worktrees/sidecar", "sidecar"],
        );
        let asked_from = root.join(".tug/worktrees/sidecar");

        let entries = arc_entries(&asked_from, None, &BTreeMap::new()).await;
        let ChangesetEntry::Arc { review, .. } = entries
            .iter()
            .find(
                |e| matches!(e, ChangesetEntry::Arc { display_name, .. } if display_name == "demo"),
            )
            .expect("the arc is visible from a sibling worktree")
        else {
            unreachable!()
        };
        assert_eq!(
            review.as_deref(),
            Some("reviewed"),
            "the plan is found from a worktree-hosted caller"
        );
    }

    /// An app-test instance never composes arc entries for the checkout
    /// under test. The `--source-tree` bootstrap makes the checkout a
    /// workspace in every instance, so without the gate an app-test's
    /// aggregate would list the *developer's* arcs — and any test
    /// assertion about the arc population would be an assertion about
    /// whoever runs the suite. Scratch repos outside the universe are
    /// untouched, which is where every fixture arc lives.
    ///
    /// Env-mutating, safe under nextest's process-per-test model — the same
    /// regime `tugarc_core::ops`'s universe tests run under.
    #[tokio::test]
    async fn an_apptest_instance_hides_the_universe_checkouts_arcs() {
        let (_dir, root) = init_repo();
        git(&root, &["branch", "tugarc/demo"]);
        git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);

        // Visible before the gate applies.
        assert!(
            !arc_entries(&root, None, &BTreeMap::new()).await.is_empty(),
            "the arc composes in an ordinary instance"
        );

        // SAFETY: one process per test under nextest — the same regime
        // `tugarc_core::ops`'s universe tests run under.
        unsafe {
            std::env::set_var("TUG_INSTANCE_ID", "apptest-0000");
            std::env::set_var(tugtool_core::REPO_UNIVERSE_ENV, &root);
        }
        assert!(
            arc_entries(&root, None, &BTreeMap::new()).await.is_empty(),
            "the universe checkout's arcs are hidden from an app-test instance"
        );

        // A scratch repo outside the universe still composes its arcs.
        let (_dir2, scratch) = init_repo();
        git(&scratch, &["branch", "tugarc/fixture"]);
        git(
            &scratch,
            &["config", "branch.tugarc/fixture.tugbase", "main"],
        );
        assert!(
            !arc_entries(&scratch, None, &BTreeMap::new())
                .await
                .is_empty(),
            "a fixture repo outside the universe is untouched"
        );
    }

    #[tokio::test]
    async fn compose_derives_arc_entries_from_tugarc_refs() {
        let (_dir, root) = init_repo();
        git(&root, &["branch", "tugarc/demo"]);
        git(&root, &["config", "branch.tugarc/demo.tugbase", "main"]);
        git(&root, &["switch", "-q", "tugarc/demo"]);
        std::fs::write(root.join("arc-work.txt"), "round\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "arc round"]);
        git(&root, &["switch", "-q", "main"]);

        // A creation id, and a live session mated to the arc under it.
        let owner_key = tugarc_core::ops::ensure_arc_id(&root, "demo").unwrap();
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess-1",
                &root.to_string_lossy(),
                &root.to_string_lossy(),
                "card-1",
                crate::session_ledger::now_millis(),
                "sess-1",
                None,
            )
            .unwrap();
        ledger
            .set_arc_binding("sess-1", Some((&owner_key, "demo")))
            .unwrap();

        let mut snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        // Arc rows ride the per-repo attachment, the aggregate's owner call.
        attach_arc_composition(&root, Some(&ledger), &mut snapshot).await;
        let arc = snapshot
            .changesets
            .iter()
            .find(|e| matches!(e, ChangesetEntry::Arc { .. }))
            .expect("an arc entry");
        let ChangesetEntry::Arc {
            owner_id,
            display_name,
            branch,
            stage,
            bound_sessions,
            base,
            rounds,
            worktree,
            worktree_dirty,
            files,
            ..
        } = arc
        else {
            panic!("expected arc entry");
        };
        // The identity is the owner key; the ref is its own field ([P09]).
        assert_eq!(owner_id, &owner_key);
        assert!(owner_id.starts_with("tugarc/demo#"));
        assert_eq!(branch.as_deref(), Some("tugarc/demo"));
        // A plan-less arc with a landed round and nothing uncommitted is
        // offerable, and says so ([P02]).
        assert_eq!(stage.as_deref(), Some("ready"));
        assert_eq!(bound_sessions, &vec!["sess-1".to_string()]);
        assert_eq!(display_name, "demo");
        assert_eq!(base, "main");
        assert_eq!(*rounds, 1);
        // Absolute — the receiver composes nothing. (This fixture's arc has no
        // checked-out worktree, so the path names where it would be.)
        assert!(
            worktree.starts_with('/') && worktree.ends_with(".tug/worktrees/demo"),
            "the worktree rides the wire absolute: {worktree}"
        );
        assert!(!worktree_dirty);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "arc-work.txt");
        assert_eq!(files[0].git_status, "A");
        assert_eq!(files[0].op, "created");
        assert_eq!(files[0].origin, "arc");
    }

    /// An arc created by an older build has no `tugid`, so it composes under
    /// its legacy branch-ref identity — and its legacy-keyed draft still
    /// attaches ([P02], [P03], Risk R01).
    #[tokio::test]
    async fn compose_carries_an_id_less_arc_under_its_legacy_identity() {
        let (_dir, root) = init_repo();
        git(&root, &["branch", "tugarc/old"]);
        git(&root, &["config", "branch.tugarc/old.tugbase", "main"]);
        git(&root, &["switch", "-q", "tugarc/old"]);
        std::fs::write(root.join("old-work.txt"), "round\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "old round"]);
        git(&root, &["switch", "-q", "main"]);

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .upsert_changeset_draft(&crate::session_ledger::ChangesetDraftRow {
                owner_kind: "arc".to_string(),
                owner_id: "tugarc/old".to_string(),
                project_dir: CanonicalPath::from_raw(&root).as_str().to_string(),
                fingerprint: "fp".to_string(),
                message: "Land the old work".to_string(),
                updated_at: 1,
                edited: true,
                selection: None,
            })
            .unwrap();

        let mut snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        // Arc rows ride the per-repo attachment, the aggregate's owner call.
        attach_arc_composition(&root, Some(&ledger), &mut snapshot).await;
        let ChangesetEntry::Arc {
            owner_id, draft, ..
        } = snapshot
            .changesets
            .iter()
            .find(|e| matches!(e, ChangesetEntry::Arc { .. }))
            .expect("an arc entry")
        else {
            panic!("expected arc entry");
        };
        assert_eq!(owner_id, "tugarc/old", "no id on file, so no id in the key");
        assert_eq!(
            draft.as_ref().map(|d| d.message.as_str()),
            Some("Land the old work"),
            "the legacy-keyed draft still attaches"
        );
        // Composing is a read path and must not have minted one ([P02]).
        assert_eq!(
            tugarc_core::ops::arc_owner_key(&root, "old"),
            "tugarc/old",
            "compose stayed read-only on git config"
        );
    }

    /// Arc entries sort by `owner_id`, and `#` (0x23) sorts below every
    /// character valid in an arc name — so `demo` still precedes `demo2` once
    /// both carry ids ([P09]). Asserted rather than assumed.
    #[test]
    fn entry_sort_key_orders_id_keyed_arcs_by_name() {
        let arc = |owner_id: &str, name: &str| ChangesetEntry::Arc {
            owner_id: owner_id.to_owned(),
            display_name: name.to_owned(),
            branch: Some(format!("tugarc/{name}")),
            arc_kind: None,
            stage: None,
            task_list: false,
            bound_sessions: Vec::new(),
            holders_busy: false,
            step_current: None,
            step_total: None,
            run_position: None,
            run_length: None,
            step_title: None,
            last_activity: None,
            documents: Default::default(),
            review: None,
            steps: Vec::new(),
            base: "main".to_owned(),
            rounds: 0,
            worktree: String::new(),
            worktree_dirty: false,
            files: Vec::new(),
            round_subjects: Vec::new(),
            draft: None,
            base_ahead: 0,
            base_overlap: Vec::new(),
            last_replay: None,
            fit: None,
            replay_conflict_paths: Vec::new(),
            join: None,
            arc: None,
        };
        let demo = arc("tugarc/demo#1723500000000-a1b2c3", "demo");
        let demo2 = arc("tugarc/demo2#1723500000001-d4e5f6", "demo2");
        assert!(
            entry_sort_key(&demo) < entry_sort_key(&demo2),
            "`#` sorts below the `2` that distinguishes the names"
        );
    }

    #[tokio::test]
    async fn compose_skips_non_repo_dirs() {
        let dir = tempfile::tempdir().unwrap();
        // Guard against the tempdir living under a real repo.
        if repo_root_for(dir.path()).await.is_none() {
            assert!(compose_snapshot(dir.path(), None).await.is_none());
        }
    }

    /// A tagless row; a `name` given here is a user-set `/rename`. Tests
    /// wanting a callsign or an auto `aiTitle` override `tag` /
    /// `name_user_set` with struct-update syntax.
    fn session_row(
        id: &str,
        name: Option<&str>,
        prompt: Option<&str>,
        state: SessionState,
    ) -> SessionRow {
        SessionRow {
            session_id: id.to_owned(),
            workspace_key: "ws".to_owned(),
            project_dir: "/proj".to_owned(),
            created_at: 0,
            last_used_at: 0,
            turn_count: 0,
            last_user_prompt: prompt.map(str::to_owned),
            state,
            card_id: Some("card-1".to_owned()),
            name: name.map(str::to_owned),
            name_user_set: name.is_some(),
            tag: None,
            synopsis: None,
            private: false,
            arc_id: None,
            arc_name: None,
            line_id: String::new(),
        }
    }

    #[test]
    fn apply_session_rows_injects_fileless_live_sessions_and_retitles() {
        let mut snapshot = ChangesetSnapshot {
            workspace_key: "ws".to_owned(),
            branch: "main".to_owned(),
            ahead: 0,
            behind: 0,
            head_sha: String::new(),
            head_message: String::new(),
            changesets: vec![
                ChangesetEntry::Arc {
                    owner_id: "tugarc/demo".to_owned(),
                    display_name: "demo".to_owned(),
                    branch: Some("tugarc/demo".to_owned()),
                    arc_kind: None,
                    stage: Some("working".to_owned()),
                    task_list: false,
                    bound_sessions: Vec::new(),
                    holders_busy: false,
                    step_current: None,
                    step_total: None,
                    run_position: None,
                    run_length: None,
                    step_title: None,
                    last_activity: None,
                    documents: Default::default(),
                    review: None,
                    steps: Vec::new(),
                    base: "main".to_owned(),
                    rounds: 1,
                    worktree: "/repo/.tug/worktrees/demo".to_owned(),
                    worktree_dirty: false,
                    files: Vec::new(),
                    round_subjects: Vec::new(),
                    draft: None,
                    base_ahead: 0,
                    base_overlap: Vec::new(),
                    last_replay: None,
                    fit: None,
                    replay_conflict_paths: Vec::new(),
                    join: None,
                    arc: None,
                },
                ChangesetEntry::Session {
                    owner_id: "sess-writer".to_owned(),
                    line_id: None,
                    display_name: "sess-wri".to_owned(),
                    live: false,
                    files: Vec::new(),
                    draft: None,
                },
            ],
            unattributed: Vec::new(),
            orphaned: Vec::new(),
        };

        let long_prompt = "word ".repeat(20); // 100 chars flat → truncates
        let rows = vec![
            session_row(
                "sess-writer",
                None,
                Some("fix   the\nparser bug"),
                SessionState::Live,
            ),
            session_row("sess-clean", Some("polish pass"), None, SessionState::Live),
            session_row("sess-long", None, Some(&long_prompt), SessionState::Live),
            session_row("sess-closed", None, None, SessionState::Closed),
        ];
        apply_session_rows(&mut snapshot, &rows);

        // Live rows all have entries (fileless when injected); the closed row
        // without files does not. Sessions sort by id ahead of the arc.
        let owners: Vec<&str> = snapshot
            .changesets
            .iter()
            .map(|e| match e {
                ChangesetEntry::Session { owner_id, .. } => owner_id.as_str(),
                ChangesetEntry::Arc { owner_id, .. } => owner_id.as_str(),
            })
            .collect();
        assert_eq!(
            owners,
            ["sess-clean", "sess-long", "sess-writer", "tugarc/demo"]
        );

        let ChangesetEntry::Session {
            display_name,
            live,
            files,
            ..
        } = &snapshot.changesets[0]
        else {
            panic!("expected session entry");
        };
        assert_eq!(display_name, "polish pass");
        assert!(live);
        assert!(files.is_empty());

        let ChangesetEntry::Session { display_name, .. } = &snapshot.changesets[1] else {
            panic!("expected session entry");
        };
        assert_eq!(display_name.chars().count(), 65, "64 chars + ellipsis");
        assert!(display_name.ends_with('…'));

        let ChangesetEntry::Session {
            display_name, live, ..
        } = &snapshot.changesets[2]
        else {
            panic!("expected session entry");
        };
        assert_eq!(display_name, "fix the parser bug");
        assert!(*live, "row state overrides the event-derived flag");
    }

    #[test]
    fn apply_session_rows_injects_and_enlivens_seated_closed_rows() {
        // The demote window: a closed row whose session the deck reports
        // seated must gain an entry and read live, exactly as a Live row
        // does — an open card outranks a demoted state.
        let mut snapshot = ChangesetSnapshot {
            workspace_key: "ws".to_owned(),
            branch: "main".to_owned(),
            ahead: 0,
            behind: 0,
            head_sha: String::new(),
            head_message: String::new(),
            changesets: Vec::new(),
            unattributed: Vec::new(),
            orphaned: Vec::new(),
        };
        let rows = vec![session_row(
            "sess-seated-closed",
            Some("open card"),
            None,
            SessionState::Closed,
        )];
        super::super::deck_seatings::set_deck_seatings(
            11,
            std::iter::once("sess-seated-closed".to_string()).collect(),
        );
        apply_session_rows(&mut snapshot, &rows);
        super::super::deck_seatings::drop_deck_seatings(11);

        let ChangesetEntry::Session { owner_id, live, .. } = &snapshot.changesets[0] else {
            panic!("expected session entry");
        };
        assert_eq!(owner_id, "sess-seated-closed");
        assert!(*live, "seated folds into liveness");
    }

    #[test]
    fn apply_session_rows_matches_and_dedups_by_line() {
        // An entry keyed by one segment of a line, rows carrying a LIVE
        // sibling segment of the same line: the entry takes the sibling's
        // title and liveness through the line match, and the sibling must
        // NOT inject a second entry — one line is one row on the card.
        let mut snapshot = ChangesetSnapshot {
            workspace_key: "ws".to_owned(),
            branch: "main".to_owned(),
            ahead: 0,
            behind: 0,
            head_sha: String::new(),
            head_message: String::new(),
            changesets: vec![ChangesetEntry::Session {
                owner_id: "seg-old".to_owned(),
                line_id: Some("line-1".to_owned()),
                display_name: "stale".to_owned(),
                live: false,
                files: Vec::new(),
                draft: None,
            }],
            unattributed: Vec::new(),
            orphaned: Vec::new(),
        };
        let mut sibling = session_row("seg-new", Some("fresh title"), None, SessionState::Live);
        sibling.line_id = "line-1".to_owned();
        apply_session_rows(&mut snapshot, &[sibling]);

        assert_eq!(
            snapshot.changesets.len(),
            1,
            "the live sibling joins the line's entry rather than doubling it"
        );
        let ChangesetEntry::Session {
            display_name, live, ..
        } = &snapshot.changesets[0]
        else {
            panic!("expected session entry");
        };
        assert_eq!(display_name, "fresh title");
        assert!(*live, "a live segment enlivens its whole line");
    }

    /// The relaunch case: a live session with a persisted draft but zero
    /// attributed files (its changes ride an arc worktree, or it has gone
    /// clean) still reads its draft back on the aggregate.
    #[test]
    fn attach_live_session_drafts_reaches_fileless_live_entries() {
        let ledger = SessionLedger::open_in_memory().unwrap();
        for (owner_id, message) in [
            ("sess-live", "the typed commit message"),
            ("sess-dead", "a dead session's leftovers"),
        ] {
            ledger
                .upsert_changeset_draft(&crate::session_ledger::ChangesetDraftRow {
                    owner_kind: "session".to_owned(),
                    owner_id: owner_id.to_owned(),
                    project_dir: "ws".to_owned(),
                    fingerprint: String::new(),
                    message: message.to_owned(),
                    updated_at: 42,
                    edited: true,
                    selection: None,
                })
                .unwrap();
        }

        let mut snapshot = ChangesetSnapshot {
            workspace_key: "ws".to_owned(),
            branch: "main".to_owned(),
            ahead: 0,
            behind: 0,
            head_sha: String::new(),
            head_message: String::new(),
            changesets: vec![
                ChangesetEntry::Session {
                    owner_id: "sess-live".to_owned(),
                    line_id: None,
                    display_name: "live".to_owned(),
                    live: true,
                    files: Vec::new(),
                    draft: None,
                },
                ChangesetEntry::Session {
                    owner_id: "sess-dead".to_owned(),
                    line_id: None,
                    display_name: "dead".to_owned(),
                    live: false,
                    files: Vec::new(),
                    draft: None,
                },
            ],
            unattributed: Vec::new(),
            orphaned: Vec::new(),
        };
        attach_live_session_drafts(&mut snapshot, &ledger);

        let ChangesetEntry::Session { draft, .. } = &snapshot.changesets[0] else {
            panic!("expected session entry");
        };
        let draft = draft.as_ref().expect("live entry reads its row back");
        assert_eq!(draft.message, "the typed commit message");
        assert!(draft.edited);

        let ChangesetEntry::Session { draft, .. } = &snapshot.changesets[1] else {
            panic!("expected session entry");
        };
        assert!(draft.is_none(), "a dead fileless entry attaches nothing");
    }

    #[test]
    fn session_row_title_prefers_a_user_name_then_the_callsign() {
        let base = session_row(
            "sess-aaaaaaaa",
            None,
            Some("fix the parser"),
            SessionState::Live,
        );

        // A tagged row speaks the identity line — `<project>/<callsign>` —
        // not the prompt snippet.
        let tagged = SessionRow {
            tag: Some("stocky-pixie".to_owned()),
            ..base.clone()
        };
        assert_eq!(session_row_title(&tagged), "proj/stocky-pixie");

        // A user-set name leads, and the identity line stays beside it.
        let renamed = SessionRow {
            name: Some("the parser work".to_owned()),
            name_user_set: true,
            ..tagged.clone()
        };
        assert_eq!(
            session_row_title(&renamed),
            "the parser work : proj/stocky-pixie"
        );

        // An auto `aiTitle` does not front — the identity line wins.
        let auto_titled = SessionRow {
            name: Some("Parser bug investigation".to_owned()),
            name_user_set: false,
            ..tagged.clone()
        };
        assert_eq!(session_row_title(&auto_titled), "proj/stocky-pixie");

        // No project dir → the bare callsign, never a stray slash.
        let projectless = SessionRow {
            project_dir: String::new(),
            ..tagged
        };
        assert_eq!(session_row_title(&projectless), "stocky-pixie");
    }

    #[test]
    fn session_row_title_keeps_the_legacy_tagless_fallbacks() {
        let with_prompt = session_row(
            "sess-aaaaaaaa",
            None,
            Some("fix  the\nparser"),
            SessionState::Live,
        );
        assert_eq!(session_row_title(&with_prompt), "fix the parser");

        let bare = session_row("sess-aaaaaaaa", None, None, SessionState::Live);
        assert_eq!(session_row_title(&bare), "sess-aaa", "exactly id[..8]");

        // An auto title on a tagless row falls through to the prompt.
        let auto_titled = SessionRow {
            name: Some("Parser bug investigation".to_owned()),
            name_user_set: false,
            ..with_prompt
        };
        assert_eq!(session_row_title(&auto_titled), "fix the parser");
    }

    fn project_file_event(
        session_id: &str,
        owner_name: Option<&str>,
        owner_name_user_set: bool,
        owner_tag: Option<&str>,
    ) -> ProjectFileEvent {
        ProjectFileEvent {
            event: FileEventRow {
                tug_session_id: session_id.to_owned(),
                tool_use_id: "tu-1".to_owned(),
                file_path: "a.txt".to_owned(),
                tool_name: "Edit".to_owned(),
                op: "modified".to_owned(),
                origin: "proof".to_owned(),
                ambiguous: false,
                parent_tool_use_id: None,
                project_dir: "/proj".to_owned(),
                at: 0,
            },
            owner_name: owner_name.map(str::to_owned),
            owner_name_user_set,
            line_id: None,
            owner_tag: owner_tag.map(str::to_owned),
            owner_live: true,
        }
    }

    #[test]
    fn session_display_name_speaks_the_callsign_before_the_hash() {
        let tagged = project_file_event("sess-aaaaaaaa", None, false, Some("stocky-pixie"));
        assert_eq!(session_display_name(&tagged), "proj/stocky-pixie");

        let renamed = project_file_event(
            "sess-aaaaaaaa",
            Some("the parser work"),
            true,
            Some("stocky-pixie"),
        );
        assert_eq!(
            session_display_name(&renamed),
            "the parser work : proj/stocky-pixie"
        );

        let auto_titled = project_file_event(
            "sess-aaaaaaaa",
            Some("Parser bug investigation"),
            false,
            Some("stocky-pixie"),
        );
        assert_eq!(session_display_name(&auto_titled), "proj/stocky-pixie");

        // A legacy tagless row still degrades to exactly id[..8] — the
        // client's hash-equality sniff depends on that form.
        let legacy = project_file_event("sess-aaaaaaaa", None, false, None);
        assert_eq!(session_display_name(&legacy), "sess-aaa");
    }

    #[tokio::test]
    async fn run_changeset_commit_commits_exactly_the_listed_files() {
        let (_temp, repo) = init_repo();
        // Three dirty paths — one listed, one pre-staged into the index,
        // one untracked. The commit must take only the listed file and
        // leave everything else exactly as it was.
        std::fs::write(repo.join("a.txt"), "changed-a\n").unwrap();
        std::fs::write(repo.join("b.txt"), "b\n").unwrap();
        git(&repo, &["add", "b.txt"]);
        std::fs::write(repo.join("c.txt"), "c\n").unwrap();

        let receipt = run_changeset_commit(&repo, &["a.txt".to_string()], "commit a", None)
            .await
            .expect("commit succeeds");

        assert_eq!(receipt.sha.len(), 40, "full HEAD sha");
        let receipt_paths: Vec<&str> = receipt
            .numstat
            .lines()
            .filter_map(|l| l.split('\t').nth(2))
            .collect();
        assert_eq!(
            receipt_paths,
            ["a.txt"],
            "numstat lists only the listed file"
        );

        // b.txt stays staged-but-uncommitted; c.txt stays untracked.
        let status = git_stdout(&repo, &["status", "--porcelain"])
            .await
            .expect("status");
        assert!(
            status.contains("A  b.txt"),
            "pre-staged file untouched: {status}"
        );
        assert!(
            status.contains("?? c.txt"),
            "untracked file untouched: {status}"
        );
    }

    #[tokio::test]
    async fn run_changeset_commit_stages_untracked_selections() {
        let (_temp, repo) = init_repo();
        std::fs::write(repo.join("fresh.txt"), "fresh\n").unwrap();
        let receipt = run_changeset_commit(&repo, &["fresh.txt".to_string()], "add fresh", None)
            .await
            .expect("untracked selection commits");
        assert!(receipt.numstat.contains("fresh.txt"));
    }

    #[tokio::test]
    async fn run_changeset_commit_lands_the_session_trailer_pair() {
        let (_temp, repo) = init_repo();
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        // The deck path enriches the message with the citation + machine-id
        // pair before committing (do_changeset_commit → append_trailers).
        // Mirror that here.
        const FULL_ID: &str = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        let pair: [(&str, &str); 2] = [
            ("Tug-Session", "stocky-pixie (f6e43925)"),
            ("Tug-Session-Id", FULL_ID),
        ];
        let message = tugchanges_core::append_trailers("commit a", &pair);
        run_changeset_commit(&repo, &["a.txt".to_string()], &message, None)
            .await
            .expect("commit succeeds");
        let read = |key: &'static str| {
            let repo = repo.clone();
            async move {
                git_stdout(
                    &repo,
                    &[
                        "log",
                        "-1",
                        &format!("--format=%(trailers:key={key},valueonly)"),
                    ],
                )
                .await
                .expect("git log reads the trailer")
                .trim()
                .to_owned()
            }
        };
        assert_eq!(read("Tug-Session").await, "stocky-pixie (f6e43925)");
        assert_eq!(read("Tug-Session-Id").await, FULL_ID);
        // A second append over the already-trailered message is a no-op —
        // both keys, so a re-draft never doubles either line.
        assert_eq!(tugchanges_core::append_trailers(&message, &pair), message);
    }

    #[tokio::test]
    async fn run_changeset_commit_refuses_empty_list_and_blank_message() {
        let (_temp, repo) = init_repo();
        assert!(run_changeset_commit(&repo, &[], "msg", None).await.is_err());
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        assert!(
            run_changeset_commit(&repo, &["a.txt".to_string()], "   ", None)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn run_changeset_commit_forwards_a_hunk_election() {
        let (_temp, repo) = init_repo();
        let original: String = (1..=60).map(|n| format!("line{n}\n")).collect();
        std::fs::write(repo.join("f.txt"), &original).unwrap();
        git(&repo, &["add", "f.txt"]);
        git(&repo, &["commit", "-q", "-m", "seed"]);
        let edited = original
            .replace("line2\n", "line2\nINSERTED-A\n")
            .replace("line30\n", "CHANGED-B\n");
        std::fs::write(repo.join("f.txt"), &edited).unwrap();

        let diff = git_stdout(
            &repo,
            &["diff", "--no-color", "--no-ext-diff", "--", "f.txt"],
        )
        .await
        .expect("diff");
        let ids: Vec<String> = tugchanges_core::parse_hunks(&diff)
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(ids.len(), 2, "diff was: {diff}");

        let mut election = std::collections::BTreeMap::new();
        election.insert("f.txt".to_string(), vec![ids[1].clone()]);
        run_changeset_commit(
            &repo,
            &["f.txt".to_string()],
            "land the second hunk",
            Some(election),
        )
        .await
        .expect("partial commit succeeds");

        let shown = git_stdout(&repo, &["show", "--no-color", "HEAD"])
            .await
            .expect("show");
        assert!(shown.contains("+CHANGED-B"), "commit was: {shown}");
        assert!(!shown.contains("INSERTED-A"), "commit was: {shown}");
    }

    #[tokio::test]
    async fn run_changeset_commit_error_carries_git_stderr() {
        let (_temp, repo) = init_repo();
        let err = run_changeset_commit(&repo, &["no-such-file.txt".to_string()], "msg", None)
            .await
            .expect_err("missing pathspec fails");
        assert!(
            err.contains("no-such-file.txt"),
            "stderr detail names the bad path: {err}"
        );
    }

    fn file_stat(
        path: &str,
        status: &str,
        added: Option<u32>,
        deleted: Option<u32>,
    ) -> tugchanges_core::FileStat {
        tugchanges_core::FileStat {
            path: path.to_string(),
            status: status.to_string(),
            added,
            deleted,
        }
    }

    #[test]
    fn format_commit_summary_single_file() {
        let s = format_commit_summary(
            "0123456789abcdef",
            "Fix the thing",
            &[file_stat("src/a.rs", "modified", Some(3), Some(1))],
        );
        assert_eq!(
            s,
            "committed 0123456789 · 1 file(s) · +3 −1\n\
             files: [{\"path\":\"src/a.rs\",\"status\":\"modified\",\"added\":3,\"removed\":1}]\n\
             Fix the thing"
        );
    }

    #[test]
    fn format_commit_summary_keeps_the_full_multi_line_message() {
        let s = format_commit_summary(
            "abcdef0123456789",
            "Subject line\n\nA longer body paragraph.",
            &[
                file_stat("src/a.rs", "modified", Some(10), Some(2)),
                file_stat("src/b.rs", "created", Some(4), Some(0)),
            ],
        );
        assert_eq!(
            s,
            "committed abcdef0123 · 2 file(s) · +14 −2\n\
             files: [{\"path\":\"src/a.rs\",\"status\":\"modified\",\"added\":10,\"removed\":2},\
             {\"path\":\"src/b.rs\",\"status\":\"created\",\"added\":4,\"removed\":0}]\n\
             Subject line\n\nA longer body paragraph."
        );
    }

    #[test]
    fn format_commit_summary_counts_binary_absent_columns_as_zero() {
        // A binary file reports no ± counts (`None`); it counts toward the file
        // total but adds 0 to the ± sums and serializes as 0.
        let s = format_commit_summary(
            "ffffffffffffffff",
            "Add an image",
            &[
                file_stat("assets/logo.png", "created", None, None),
                file_stat("src/a.rs", "modified", Some(5), Some(3)),
            ],
        );
        assert_eq!(
            s,
            "committed ffffffffff · 2 file(s) · +5 −3\n\
             files: [{\"path\":\"assets/logo.png\",\"status\":\"created\",\"added\":0,\"removed\":0},\
             {\"path\":\"src/a.rs\",\"status\":\"modified\",\"added\":5,\"removed\":3}]\n\
             Add an image"
        );
    }

    #[test]
    fn format_join_summary_names_the_arc_the_base_and_the_rounds() {
        let s = format_join_summary(
            "0123456789abcdef",
            "join-lane",
            "main",
            5,
            "tugarc(join-lane): land the join surface",
            &[],
            None,
        );
        assert_eq!(
            s,
            "joined 0123456789 · join-lane → main · 5 round(s)\n\
             tugarc(join-lane): land the join surface"
        );
    }

    /// Over a real repository, because the bug this pins is one only git can
    /// show: `diff-tree` does not recurse by default. `--numstat` implies it
    /// and `--name-status` does not, so without an explicit `-r` the status
    /// read returns `M<TAB>src` for a whole directory, no path in it matches,
    /// and every file silently takes the "modified" default — a created file
    /// in a nested directory would be labelled modified in a durable receipt.
    #[tokio::test]
    async fn landing_file_stats_reads_nested_paths_and_their_real_statuses() {
        let (_temp, repo) = init_repo();
        std::fs::create_dir_all(repo.join("src/deep")).unwrap();
        std::fs::write(repo.join("src/deep/created.txt"), "new\n").unwrap();
        std::fs::write(repo.join("committed.txt"), "base\nmore\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "second"]);
        let sha = git_stdout(&repo, &["rev-parse", "HEAD"])
            .await
            .expect("HEAD resolves");
        let stats = landing_file_stats(&repo, &sha).await;
        let by_path: std::collections::HashMap<&str, &tugchanges_core::FileStat> =
            stats.iter().map(|f| (f.path.as_str(), f)).collect();
        // The nested path arrives whole, not as its top directory.
        let created = by_path
            .get("src/deep/created.txt")
            .expect("the nested file is listed by its full path");
        assert_eq!(created.status, "created");
        assert_eq!(created.added, Some(1));
        let modified = by_path
            .get("committed.txt")
            .expect("the touched file is listed");
        assert_eq!(modified.status, "modified");
    }

    /// The v2 shape, and the literal the deck's tests copy verbatim — the same
    /// pinning discipline the commit receipt already runs on.
    #[test]
    fn format_join_summary_carries_the_files_line() {
        let s = format_join_summary(
            "0123456789abcdef",
            "join-lane",
            "main",
            5,
            "tugarc(join-lane): land the join surface",
            &[
                file_stat("src/a.rs", "modified", Some(16), Some(1)),
                file_stat("src/b.rs", "created", Some(4), Some(0)),
            ],
            None,
        );
        assert_eq!(
            s,
            "joined 0123456789 · join-lane → main · 5 round(s)\n\
             files: [{\"path\":\"src/a.rs\",\"status\":\"modified\",\"added\":16,\"removed\":1},\
             {\"path\":\"src/b.rs\",\"status\":\"created\",\"added\":4,\"removed\":0}]\n\
             tugarc(join-lane): land the join surface"
        );
    }

    /// An empty file list omits the line entirely rather than writing an empty
    /// array — which is byte-for-byte the shape every receipt written before
    /// the line existed carries, so legacy and no-list are one code path.
    #[test]
    fn format_join_summary_omits_the_files_line_when_there_are_none() {
        let s = format_join_summary("abc1234567def", "d", "trunk", 1, "Subject line", &[], None);
        assert_eq!(
            s,
            "joined abc1234567 · d → trunk · 1 round(s)\nSubject line"
        );
        assert!(!s.contains("files:"));
    }

    /// The fit line's position is the contract: between the header and
    /// `files:`, claimed by its prefix rather than by an index.
    #[test]
    fn format_join_summary_carries_the_fit_between_the_header_and_the_files() {
        let fit = tugarc_core::log::FitFact {
            head: "3f0a1c9e2b7d4f6a".to_string(),
            base: "91c4de70f2a3b5c7".to_string(),
            current: true,
        };
        let s = format_join_summary(
            "0123456789abcdef",
            "join-lane",
            "main",
            5,
            "tugarc(join-lane): land the join surface",
            &[file_stat("src/a.rs", "modified", Some(16), Some(1))],
            Some(&fit),
        );
        assert_eq!(
            s,
            "joined 0123456789 · join-lane → main · 5 round(s)\n\
             fit: verified 3f0a1c9e2b onto 91c4de70f2\n\
             files: [{\"path\":\"src/a.rs\",\"status\":\"modified\",\"added\":16,\"removed\":1}]\n\
             tugarc(join-lane): land the join surface"
        );
    }

    /// A stale fit says `stale` and still names the pair — a receipt that
    /// showed a head without the base it was verified onto would name no tree.
    #[test]
    fn format_join_summary_says_stale_and_still_names_the_pair() {
        let fit = tugarc_core::log::FitFact {
            head: "3f0a1c9e2b7d4f6a".to_string(),
            base: "91c4de70f2a3b5c7".to_string(),
            current: false,
        };
        let s = format_join_summary("abc1234567def", "d", "trunk", 1, "Subject", &[], Some(&fit));
        assert_eq!(
            s,
            "joined abc1234567 · d → trunk · 1 round(s)\n\
             fit: stale 3f0a1c9e2b onto 91c4de70f2\n\
             Subject"
        );
    }

    /// Both optional lines, in every combination — the four shapes the deck's
    /// cursor has to survive, pinned on the server that writes them.
    #[test]
    fn format_join_summary_is_parse_stable_across_every_optional_line() {
        let fit = tugarc_core::log::FitFact {
            head: "3f0a1c9e2b7d4f6a".to_string(),
            base: "91c4de70f2a3b5c7".to_string(),
            current: true,
        };
        let files = [file_stat("src/a.rs", "modified", Some(1), Some(0))];

        // Fit, no files.
        let fit_only =
            format_join_summary("abc1234567def", "d", "trunk", 1, "Subject", &[], Some(&fit));
        assert_eq!(
            fit_only.lines().nth(1),
            Some("fit: verified 3f0a1c9e2b onto 91c4de70f2")
        );
        assert_eq!(fit_only.lines().nth(2), Some("Subject"));
        assert!(!fit_only.contains("files:"));

        // Files, no fit — the pre-fit shape, with `files:` still at index 1.
        let files_only =
            format_join_summary("abc1234567def", "d", "trunk", 1, "Subject", &files, None);
        assert!(
            files_only
                .lines()
                .nth(1)
                .is_some_and(|l| l.starts_with("files: "))
        );
        assert!(!files_only.contains("fit:"));

        // Both.
        let both = format_join_summary(
            "abc1234567def",
            "d",
            "trunk",
            1,
            "Subject",
            &files,
            Some(&fit),
        );
        assert!(both.lines().nth(1).is_some_and(|l| l.starts_with("fit: ")));
        assert!(
            both.lines()
                .nth(2)
                .is_some_and(|l| l.starts_with("files: "))
        );
        assert_eq!(both.lines().nth(3), Some("Subject"));

        // Neither.
        let neither = format_join_summary("abc1234567def", "d", "trunk", 1, "Subject", &[], None);
        assert_eq!(neither.lines().nth(1), Some("Subject"));
    }
    #[test]
    fn format_join_summary_keeps_the_full_multi_line_message() {
        let s = format_join_summary(
            "abcdef0123456789",
            "d",
            "trunk",
            1,
            "  Subject line\n\nA longer body paragraph.\n",
            &[],
            None,
        );
        assert_eq!(
            s,
            "joined abcdef0123 · d → trunk · 1 round(s)\n\
             Subject line\n\nA longer body paragraph."
        );
    }

    #[test]
    fn format_discard_summary_lists_the_round_subjects() {
        let s = format_discard_summary(
            "spike",
            2,
            3,
            &["first round".to_string(), "second round".to_string()],
            None,
        );
        assert_eq!(
            s,
            "discarded spike · 2 round(s), 3 file(s)\n\
             first round\nsecond round"
        );
    }

    #[test]
    fn format_discard_summary_of_a_clean_arc_is_one_line() {
        assert_eq!(
            format_discard_summary("spike", 0, 0, &[], None),
            "discarded spike · 0 round(s)"
        );
    }

    /// A discarded arc's documents outlive it, and the receipt says so — the
    /// one thing a discard keeps rather than destroys.
    #[test]
    fn format_discard_summary_says_the_documents_stay() {
        assert_eq!(
            format_discard_summary("spike", 0, 0, &[], Some("/repo/.tug/arcs/spike")),
            "discarded spike · 0 round(s)\n\
             Its documents stay at .tug/arcs/spike/."
        );
    }

    #[test]
    fn arc_file_rows_map_letters_and_renames() {
        // The parse now lives in tugarc-core (shared with the CLI); what this
        // layer owns is the letter → op mapping and the score-stripped status.
        let files: Vec<ChangesetFile> = [
            ("added.txt", "A"),
            ("changed.txt", "M"),
            ("gone.txt", "D"),
            ("new.txt", "R100"),
        ]
        .into_iter()
        .map(|(path, status)| {
            arc_file_row(tugarc_core::ArcDetailFile {
                path: path.to_owned(),
                status: status.to_owned(),
                added: None,
                deleted: None,
            })
        })
        .collect();
        let got: Vec<(&str, &str, &str)> = files
            .iter()
            .map(|f| (f.path.as_str(), f.git_status.as_str(), f.op.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("added.txt", "A", "created"),
                ("changed.txt", "M", "modified"),
                ("gone.txt", "D", "deleted"),
                ("new.txt", "R", "renamed"),
            ]
        );
    }

    /// Two sessions open one project via two different spellings (real path and
    /// a symlink to it). The relay canonicalizes `project_dir` at write, so both
    /// land in one canonical `file_events` bucket and compose attributes both —
    /// closing the multi-spelling dedup gap.
    #[cfg(unix)]
    #[tokio::test]
    async fn two_spellings_one_project_attribute_to_one_bucket() {
        let (_dir, root) = init_repo();
        let link_home = tempfile::tempdir().unwrap();
        let link = link_home.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();

        std::fs::write(root.join("a.txt"), "x").unwrap();
        std::fs::write(root.join("b.txt"), "x").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess-a",
                "ws",
                &root.to_string_lossy(),
                "card-1",
                0,
                "sess-a",
                None,
            )
            .unwrap();
        ledger
            .record_spawn(
                "sess-b",
                "ws",
                &link.to_string_lossy(),
                "card-2",
                0,
                "sess-b",
                None,
            )
            .unwrap();

        // Each session's write canonicalizes its own spelling; both resolve to
        // the same canonical bucket.
        let pd_a = CanonicalPath::from_raw(&root);
        let pd_b = CanonicalPath::from_raw(&link);
        assert_eq!(
            pd_a.as_str(),
            pd_b.as_str(),
            "both spellings canonicalize alike"
        );
        ledger
            .record_file_event(&event(
                "sess-a",
                "tu-1",
                &root.join("a.txt"),
                pd_a.as_path(),
            ))
            .unwrap();
        ledger
            .record_file_event(&event(
                "sess-b",
                "tu-2",
                &root.join("b.txt"),
                pd_b.as_path(),
            ))
            .unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let owners: Vec<&str> = snapshot
            .changesets
            .iter()
            .filter_map(|e| match e {
                ChangesetEntry::Session { owner_id, .. } => Some(owner_id.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            owners.contains(&"sess-a"),
            "session A attributed: {owners:?}"
        );
        assert!(
            owners.contains(&"sess-b"),
            "session B (other spelling) attributed: {owners:?}"
        );
        assert!(
            snapshot.unattributed.is_empty(),
            "no file falls to unattributed: {:?}",
            snapshot.unattributed
        );
    }

    /// `sessions.project_dir` stays the raw typed path so the picker's
    /// `list_for_project_dir` (raw-path lookup) keeps working — only
    /// `file_events.project_dir` is canonicalized ([P05]).
    #[cfg(unix)]
    #[tokio::test]
    async fn sessions_project_dir_stays_raw() {
        let (_dir, root) = init_repo();
        let link_home = tempfile::tempdir().unwrap();
        let link = link_home.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let raw = link.to_string_lossy().to_string();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn("sess-a", "ws", &raw, "card-1", 0, "sess-a", None)
            .unwrap();

        let rows = ledger.list_for_project_dir(&raw).unwrap();
        assert_eq!(
            rows.len(),
            1,
            "picker finds the session by its raw typed path"
        );
        assert_eq!(
            rows[0].project_dir, raw,
            "sessions.project_dir stays the raw spelling"
        );
    }

    /// The `ee31685b` shape: a legacy absolute `file_path` under one spelling of
    /// a directory, `project_dir` under another (a symlink standing in for the
    /// `/u` firmlink). The reconciler bridge collapses both to the same
    /// repo-relative key, so the file is attributed — not Unattributed.
    #[cfg(unix)]
    #[tokio::test]
    async fn firmlink_split_row_is_attributed() {
        let (_dir, root) = init_repo();
        std::fs::write(root.join("rail-frame.md"), "edit").unwrap();
        let link_home = tempfile::tempdir().unwrap();
        let link = link_home.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess",
                "ws",
                &link.to_string_lossy(),
                "card-1",
                0,
                "sess",
                None,
            )
            .unwrap();
        // Legacy row: absolute file_path under the real path, project_dir the
        // symlink spelling — the two disagree, exactly the live bug.
        ledger
            .record_file_event(&event("sess", "tu-1", &root.join("rail-frame.md"), &link))
            .unwrap();

        // Compose against the symlink spelling (repo_root_for returns it verbatim).
        let snapshot = compose_snapshot(&link, Some(&ledger)).await.expect("repo");
        let owners: Vec<&str> = snapshot
            .changesets
            .iter()
            .filter_map(|e| match e {
                ChangesetEntry::Session {
                    owner_id, files, ..
                } if !files.is_empty() => Some(owner_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            owners,
            ["sess"],
            "the split row is attributed to its session"
        );
        assert!(
            snapshot.unattributed.is_empty(),
            "nothing falls to unattributed: {:?}",
            snapshot.unattributed
        );
    }

    /// A deleted file has no inode, but both sides speak git's repo-relative
    /// language, so a new capture-time (repo-relative) row reconciles against
    /// git's `D` entry.
    #[cfg(unix)]
    #[tokio::test]
    async fn deleted_file_reconciles_repo_relative() {
        let (_dir, root) = init_repo();
        std::fs::remove_file(root.join("committed.txt")).unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        let pd = CanonicalPath::from_raw(&root);
        ledger
            .record_spawn("sess", "ws", pd.as_str(), "card-1", 0, "sess", None)
            .unwrap();
        // New capture-time form: repo-relative file_path, op deleted. The
        // deletion postdates the repo's init commit, so the row is live.
        let mut ev = event("sess", "tu-1", Path::new("committed.txt"), pd.as_path());
        ev.op = "deleted".to_owned();
        ev.at = crate::session_ledger::now_millis() + 2_000;
        ledger.record_file_event(&ev).unwrap();

        let snapshot = compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let owned: Vec<&str> = snapshot
            .changesets
            .iter()
            .flat_map(|e| match e {
                ChangesetEntry::Session { files, .. } => {
                    files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>()
                }
                _ => Vec::new(),
            })
            .collect();
        assert_eq!(
            owned,
            ["committed.txt"],
            "the deleted file reconciles via its repo-relative key"
        );
        assert!(snapshot.unattributed.is_empty());
    }

    /// Unit coverage of the bridge decision table: relative passes through,
    /// absolute strips, and a firmlink-split (repo_root via a symlink) collapses
    /// through the gateway before the strip.
    #[cfg(unix)]
    #[test]
    fn bridge_passes_through_relative_and_strips_absolute() {
        let any = Path::new("/any/repo");
        assert_eq!(
            repo_relative(&CanonicalPath::from_raw(any), any, "arc/x.md"),
            "arc/x.md"
        );

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        assert_eq!(
            repo_relative(
                &CanonicalPath::from_raw(&root),
                &root,
                root.join("a.txt").to_str().unwrap()
            ),
            "a.txt"
        );

        let link_home = tempfile::tempdir().unwrap();
        let link = link_home.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        assert_eq!(
            repo_relative(
                &CanonicalPath::from_raw(&link),
                &link,
                root.join("a.txt").to_str().unwrap()
            ),
            "a.txt",
            "firmlink-split repo_root collapses through the gateway"
        );
    }

    /// A first compose converts a project's legacy absolute rows to canonical
    /// project_dir + repo-relative file_path; a second compose (marker set)
    /// does no further writes.
    #[cfg(unix)]
    #[tokio::test]
    async fn backfill_converts_absolute_rows_only_once() {
        let (_dir, root) = init_repo();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess",
                "ws",
                &root.to_string_lossy(),
                "card",
                0,
                "sess",
                None,
            )
            .unwrap();
        // Legacy-shaped row: absolute file_path.
        ledger
            .record_file_event(&event("sess", "tu-1", &root.join("a.txt"), &root))
            .unwrap();

        compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let rows = ledger.file_events_for_session("sess").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, "a.txt", "row converted to repo-relative");
        let canonical = CanonicalPath::from_raw(&root);
        assert_eq!(
            rows[0].project_dir,
            canonical.as_str(),
            "row project_dir canonicalized"
        );

        let before = ledger.file_events_for_session("sess").unwrap();
        compose_snapshot(&root, Some(&ledger)).await.expect("repo");
        let after = ledger.file_events_for_session("sess").unwrap();
        assert_eq!(before, after, "second compose does no extra writes");
    }

    /// A first compose deletes the rows naming files outside the repo and
    /// converts the ones naming files inside it, leaving `file_events` holding
    /// only paths a changeset can show.
    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_purges_out_of_repo_rows_and_keeps_in_repo_ones() {
        let (_dir, root) = init_repo();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let away = tempfile::tempdir().unwrap();
        let away_file = away.path().canonicalize().unwrap().join("note.md");
        std::fs::write(&away_file, "x").unwrap();

        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess",
                "ws",
                &root.to_string_lossy(),
                "card",
                0,
                "sess",
                None,
            )
            .unwrap();
        ledger
            .record_file_event(&event("sess", "tu-1", &root.join("a.txt"), &root))
            .unwrap();
        ledger
            .record_file_event(&event("sess", "tu-2", &away_file, &root))
            .unwrap();

        compose_snapshot(&root, Some(&ledger)).await.expect("repo");

        let rows = ledger.file_events_for_session("sess").unwrap();
        assert_eq!(rows.len(), 1, "the out-of-repo row is gone: {rows:?}");
        assert_eq!(rows[0].file_path, "a.txt");
    }

    /// An in-repo file already deleted from disk cannot canonicalize, but it is
    /// still in the repo — the sweep must rewrite it, never purge it.
    /// "Unresolvable" is not "outside".
    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_keeps_a_row_for_a_deleted_in_repo_file() {
        let (_dir, root) = init_repo();
        let gone = root.join("src/gone.txt");
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                "sess",
                "ws",
                &root.to_string_lossy(),
                "card",
                0,
                "sess",
                None,
            )
            .unwrap();
        ledger
            .record_file_event(&event("sess", "tu-1", &gone, &root))
            .unwrap();

        compose_snapshot(&root, Some(&ledger)).await.expect("repo");

        let rows = ledger.file_events_for_session("sess").unwrap();
        assert_eq!(rows.len(), 1, "the row survives: {rows:?}");
        assert_eq!(rows[0].file_path, "src/gone.txt", "rewritten, not purged");
    }

    /// The backfill runs only for the project compose actually touches; a
    /// project never composed keeps its legacy rows (proving no boot walk).
    #[cfg(unix)]
    #[tokio::test]
    async fn backfill_never_touches_unopened_projects() {
        let (_dir_x, root_x) = init_repo();
        let (_dir_y, root_y) = init_repo();
        std::fs::write(root_y.join("y.txt"), "y").unwrap();
        let ledger = SessionLedger::open_in_memory().unwrap();
        // X has a legacy absolute row but is never composed.
        ledger
            .record_spawn(
                "sess-x",
                "ws",
                &root_x.to_string_lossy(),
                "card-x",
                0,
                "sess-x",
                None,
            )
            .unwrap();
        ledger
            .record_file_event(&event("sess-x", "tu-x", &root_x.join("x.txt"), &root_x))
            .unwrap();
        let x_before = ledger.file_events_for_session("sess-x").unwrap();

        // Compose only Y.
        compose_snapshot(&root_y, Some(&ledger))
            .await
            .expect("repo");

        let x_after = ledger.file_events_for_session("sess-x").unwrap();
        assert_eq!(x_before, x_after, "unopened project X's rows are untouched");
        assert!(
            x_after[0].file_path.starts_with('/'),
            "X's row stays absolute — no boot walk"
        );
    }

    fn draft_row(selection: Option<&str>) -> crate::session_ledger::ChangesetDraftRow {
        crate::session_ledger::ChangesetDraftRow {
            owner_kind: "session".to_string(),
            owner_id: "sess-1".to_string(),
            project_dir: "/tmp/p".to_string(),
            fingerprint: "fp".to_string(),
            message: "Do the thing".to_string(),
            updated_at: 7,
            edited: false,
            selection: selection.map(str::to_string),
        }
    }

    /// The outbound projection is opaque: whatever the client stored in the
    /// selection column reaches it again unchanged. Narrowing this to a
    /// struct is how the hunk elections were dropped between the ledger and
    /// the deck — serde discards the fields the struct does not name.
    #[test]
    fn draft_projection_preserves_unnamed_selection_keys() {
        let stored = r#"{"include":["a.rs"],"exclude":[],"hunks":{"f.txt":["abc123","def456"]}}"#;
        let draft = draft_from_row(&draft_row(Some(stored)));
        let selection = draft.selection.expect("selection projects");

        assert_eq!(selection["include"], serde_json::json!(["a.rs"]));
        assert_eq!(
            selection["hunks"],
            serde_json::json!({"f.txt": ["abc123", "def456"]}),
            "a key no Rust type names must survive the projection"
        );
    }

    /// A hand-mangled selection reads as no overrides rather than poisoning
    /// the snapshot.
    #[test]
    fn draft_projection_drops_a_malformed_selection() {
        assert!(
            draft_from_row(&draft_row(Some("{not json")))
                .selection
                .is_none()
        );
        assert!(draft_from_row(&draft_row(None)).selection.is_none());
    }
}

/// The M02A checklist, walked against the real machinery rather than by hand.
///
/// Every step here runs the product path: a real git repo, a real
/// `SessionLedger` holding a live session and a proof row, the real
/// [`compose_snapshot`], the real draft round trip through the ledger, and the
/// real landing engine. What it does **not** drive is the rendering — the
/// checkbox, the badge text, and the disabled control are React, and are
/// covered by the `reconcileHunkElection` unit table and by at0333.
///
/// The point of walking it here is that every M02A defect lived on this side
/// of the boundary: the projection that dropped the election, the two diff
/// spellings that could disagree about an id, the landing that had to refuse
/// drift. A checklist item a machine can hold is not a hand-verification item.
#[cfg(test)]
mod m02a_verification {
    use super::*;
    use crate::session_ledger::{ChangesetDraftRow, FileEventRow};
    use std::path::Path;

    const SESSION: &str = "hv-session";
    const FILE: &str = "wide.txt";

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 120 committed lines, then edits at 20 and 90 — far enough apart that
    /// git emits two hunks rather than merging them.
    fn dirty_two_hunks(root: &Path) {
        let dirty: String = (1..=120)
            .map(|n| match n {
                20 | 90 => format!("line {n} CHANGED\n"),
                _ => format!("line {n}\n"),
            })
            .collect();
        std::fs::write(root.join(FILE), dirty).unwrap();
    }

    fn seed_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "t@t.test"]);
        git(&root, &["config", "user.name", "t"]);
        let base: String = (1..=120).map(|n| format!("line {n}\n")).collect();
        std::fs::write(root.join(FILE), base).unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        dirty_two_hunks(&root);
        (dir, root)
    }

    /// A live session that proof-owns the dirty file — the shape a real
    /// session-entry row is composed from.
    fn seed_ledger(root: &Path) -> SessionLedger {
        let ledger = SessionLedger::open_in_memory().unwrap();
        ledger
            .record_spawn(
                SESSION,
                "ws",
                &root.to_string_lossy(),
                "card-1",
                0,
                SESSION,
                None,
            )
            .unwrap();
        ledger
            .record_file_event(&FileEventRow {
                tug_session_id: SESSION.to_owned(),
                tool_use_id: "tu-1".to_owned(),
                file_path: root.join(FILE).to_string_lossy().into_owned(),
                tool_name: "Edit".to_owned(),
                op: "write".to_owned(),
                origin: "exact".to_owned(),
                ambiguous: false,
                parent_tool_use_id: None,
                project_dir: root.to_string_lossy().into_owned(),
                // Past the row-liveness cut (the file's last commit).
                at: 9_000_000_000_000,
            })
            .unwrap();
        ledger
    }

    /// The hunk ids the deck's checkboxes are keyed by — read the way the deck
    /// reads them, off the wire.
    async fn wire_hunk_ids(root: &Path) -> Vec<String> {
        let diff = super::super::git::fetch_git_diff_with_untracked(root, &[])
            .await
            .expect("wire diff");
        super::super::git::parse_git_diff(&diff)
            .into_iter()
            .find(|f| f.path == FILE)
            .expect("the dirty file is on the wire")
            .hunks
    }

    fn write_election(ledger: &SessionLedger, root: &Path, ids: &[&str]) {
        let selection = serde_json::json!({
            "include": [],
            "exclude": [],
            "hunks": { FILE: ids },
        });
        ledger
            .upsert_changeset_draft(&ChangesetDraftRow {
                owner_kind: "session".to_owned(),
                owner_id: SESSION.to_owned(),
                project_dir: root.to_string_lossy().into_owned(),
                fingerprint: "fp".to_owned(),
                message: "Land part of the file".to_owned(),
                updated_at: 1,
                edited: false,
                selection: Some(selection.to_string()),
            })
            .unwrap();
    }

    /// The composed session entry for our seeded session.
    async fn session_entry(root: &Path, ledger: &SessionLedger) -> ChangesetEntry {
        compose_snapshot(root, Some(ledger))
            .await
            .expect("repo composes")
            .changesets
            .into_iter()
            .find(|e| matches!(e, ChangesetEntry::Session { owner_id, .. } if owner_id == SESSION))
            .expect("the live session owns a dirty file, so it has an entry")
    }

    fn head_patch(root: &Path) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["show", "--no-color", "HEAD"])
            .output()
            .expect("git show");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// **HV1 + HV2** — the election settles, survives the round trip through
    /// the ledger, and the row can count it.
    ///
    /// This is the F1 defect's exact path. Before the projection was made
    /// opaque, the `hunks` key was written to the ledger and then dropped by
    /// the typed struct on the way back out, so the checkbox snapped back and
    /// the badge never appeared. `elected`/`total` here are the two numbers
    /// the `N of M hunks` badge renders.
    #[tokio::test]
    async fn hv1_hv2_the_election_settles_and_the_row_can_count_it() {
        let (_dir, root) = seed_repo();
        let ledger = seed_ledger(&root);
        let ids = wire_hunk_ids(&root).await;
        assert_eq!(ids.len(), 2, "two well-separated edits, two hunks");

        write_election(&ledger, &root, &[&ids[0]]);

        let ChangesetEntry::Session { files, draft, .. } = session_entry(&root, &ledger).await
        else {
            panic!("session entry");
        };
        assert!(
            files.iter().any(|f| f.path == FILE),
            "the session owns the dirty file"
        );

        let selection = draft
            .expect("an entry with files carries its draft")
            .selection
            .expect("the draft carries the selection");
        assert_eq!(
            selection["hunks"][FILE],
            serde_json::json!([ids[0]]),
            "the election survives the projection — the F1 defect verbatim"
        );

        // What the badge renders: elected ∩ current = 1, total = 2.
        let elected = selection["hunks"][FILE]
            .as_array()
            .unwrap()
            .iter()
            .filter(|id| ids.iter().any(|cur| cur == id.as_str().unwrap()))
            .count();
        assert_eq!((elected, ids.len()), (1, 2), "the row reads `1 of 2 hunks`");
    }

    /// **HV4 + HV6** — a partial landing takes only the elected hunk and
    /// leaves the rest dirty; an unelected file still lands whole.
    #[tokio::test]
    async fn hv4_hv6_partial_lands_alone_and_whole_file_still_lands_whole() {
        let (_dir, root) = seed_repo();
        let _ledger = seed_ledger(&root);
        let ids = wire_hunk_ids(&root).await;

        // HV4: land the first hunk only.
        let mut hunks = std::collections::BTreeMap::new();
        hunks.insert(FILE.to_string(), vec![ids[0].clone()]);
        tugchanges_core::commit(tugchanges_core::CommitOptions {
            project: Some(root.clone()),
            message: "land the first hunk".to_string(),
            paths: Some(vec![FILE.to_string()]),
            hunks: Some(hunks),
            ..Default::default()
        })
        .expect("the partial landing succeeds");

        let shown = head_patch(&root);
        assert!(
            shown.contains("line 20 CHANGED"),
            "the elected hunk landed: {shown}"
        );
        assert!(
            !shown.contains("line 90 CHANGED"),
            "the unelected hunk did NOT land: {shown}"
        );
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&status.stdout).contains(FILE),
            "the remainder is still dirty"
        );

        // HV6: no election now — the remainder lands whole.
        tugchanges_core::commit(tugchanges_core::CommitOptions {
            project: Some(root.clone()),
            message: "land the rest".to_string(),
            paths: Some(vec![FILE.to_string()]),
            ..Default::default()
        })
        .expect("the whole-file landing succeeds");
        assert!(
            head_patch(&root).contains("line 90 CHANGED"),
            "the remainder landed whole"
        );
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "the tree is clean"
        );
    }

    /// **HV5 + HV8** — an election whose content has moved is refused by name,
    /// and the refusal stages nothing.
    ///
    /// HV8's display half (the row reading `stale election` rather than a
    /// silent whole-file landing) is the `reconcileHunkElection` table's job;
    /// what matters here is that the condition it warns about is real — the
    /// landing genuinely refuses rather than quietly taking the whole file.
    #[tokio::test]
    async fn hv5_hv8_drift_refuses_by_name_and_stages_nothing() {
        let (_dir, root) = seed_repo();
        let _ledger = seed_ledger(&root);
        let ids = wire_hunk_ids(&root).await;

        // Elect the first hunk, then edit that hunk's own content out from
        // under the election.
        let drifted: String = (1..=120)
            .map(|n| match n {
                20 => "line 20 CHANGED AGAIN\n".to_string(),
                90 => "line 90 CHANGED\n".to_string(),
                _ => format!("line {n}\n"),
            })
            .collect();
        std::fs::write(root.join(FILE), drifted).unwrap();

        let mut hunks = std::collections::BTreeMap::new();
        hunks.insert(FILE.to_string(), vec![ids[0].clone()]);
        let err = tugchanges_core::commit(tugchanges_core::CommitOptions {
            project: Some(root.clone()),
            message: "land a hunk that moved".to_string(),
            paths: Some(vec![FILE.to_string()]),
            hunks: Some(hunks),
            ..Default::default()
        })
        .expect_err("the elected hunk is no longer in the file");

        match &err {
            tugchanges_core::CommitError::HunkDrift { path, ids: named } => {
                assert_eq!(path, FILE, "the refusal names the path");
                assert_eq!(named, &vec![ids[0].clone()], "and the drifted id");
            }
            other => panic!("expected a typed drift refusal, got {other:?}"),
        }
        assert!(
            err.to_string().starts_with("hunk drift:"),
            "the refusal reads as drift: {err}"
        );

        let staged = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["diff", "--cached", "--name-only"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&staged.stdout).trim().is_empty(),
            "a refused landing leaves nothing staged"
        );
    }

    /// **HV3's premise** — an election that selects nothing is refused, which
    /// is what makes the disabled last checkbox correct rather than arbitrary.
    ///
    /// The control refuses to let the user uncheck the sole remaining hunk.
    /// That guard is only honest if the state it prevents is genuinely
    /// unreachable-by-design, so this pins the engine end of it: a file in the
    /// landing set with an empty election is an error, not a whole-file
    /// disposition.
    #[tokio::test]
    async fn hv3_an_election_that_selects_nothing_is_refused() {
        let (_dir, root) = seed_repo();
        let mut hunks = std::collections::BTreeMap::new();
        hunks.insert(FILE.to_string(), Vec::new());

        let err = tugchanges_core::commit(tugchanges_core::CommitOptions {
            project: Some(root.clone()),
            message: "land nothing".to_string(),
            paths: Some(vec![FILE.to_string()]),
            hunks: Some(hunks),
            ..Default::default()
        })
        .expect_err("an empty election is not a disposition");
        assert!(
            err.to_string().contains("selects no hunks"),
            "the refusal says why: {err}"
        );
    }

    /// **HV7's mechanism** — the id a collapsed band is keyed by survives a
    /// hunk appearing above it.
    ///
    /// at0333 drives the DOM half on a real row (the band stays folded and the
    /// diff body is the same node). This pins the half that makes that
    /// meaningful: the id is content-derived, so inserting a hunk above does
    /// not move it — if ids shifted with position, surviving the mount would
    /// still land the fold on the wrong band.
    #[tokio::test]
    async fn hv7_a_hunk_appearing_above_does_not_move_the_ids_below_it() {
        let (_dir, root) = seed_repo();
        let before = wire_hunk_ids(&root).await;
        assert_eq!(before.len(), 2);

        // A third edit between the two, far enough from both to be its own
        // hunk — the "a hunk appears above the collapsed one" transition.
        let three: String = (1..=120)
            .map(|n| match n {
                20 | 55 | 90 => format!("line {n} CHANGED\n"),
                _ => format!("line {n}\n"),
            })
            .collect();
        std::fs::write(root.join(FILE), three).unwrap();

        let after = wire_hunk_ids(&root).await;
        assert_eq!(after.len(), 3, "the new edit is its own hunk");
        assert_eq!(
            (after[0].clone(), after[2].clone()),
            (before[0].clone(), before[1].clone()),
            "the original hunks keep their ids — the `@@` header is not hashed, \
             so a hunk appearing between them cannot move either one"
        );
    }
}
