# Dash hardening — conflicts as data, operations as a log

**Written 2026-08-23.** This brief describes the next reliability round for dashes: two ideas taken from Jujutsu's model and built natively on git, with no new dependency. It is the input to a `/tugplug:plan-devise` round, not a plan — it fixes the shape and names the judgment calls, and leaves step decomposition to the devise.

## The finding this brief rests on {#finding}

A survey of `tugdash-core` (2026-08-23) found that the dash engine has already independently converged on most of jj's architecture: merges computed in memory (`merge-tree --write-tree` + `commit-tree`), user checkouts never used as scratchpads (`GIT_INDEX_FILE` isolation in `resolve.rs`, candidates parked at `refs/tug/join/<name>`), dirt swept into commits before every integrate (`commit_worktree_dirt`), and interrupted teardowns journaled and resumable (`JoinJournal` + `--continue`). Every remaining fragility in the engine's own failure inventory sits where **live working-tree state still participates**:

- The workshop holds an in-flight conflict as `MERGE_HEAD` + index stages + markers in a checkout — fragile process state with documented wedge modes: the abort-then-reset choreography (`workshop.rs:378`), the orphan-workshop race when a join tears down mid-verification (`workshop.rs:277`), and the recorded-not-built-for race where a CLI `tugutil dash join` cannot see tugcast's in-process occupancy guard and destroys a resolve in flight (`roadmap/archive/join-hardening.md` R03).
- Nothing can reverse a completed operation. The join journal resumes a teardown *forward*; a landed join, a base-motion replay, or a discard has no undo. `branch -D` at teardown makes the dash's rounds unreachable, so even manual recovery is a reflog dig on a clock.

jj's two answers — conflicts recorded as first-class objects in the repository, and every mutation logged and reversible — are both representable in plain git: conflict stages are trees and blobs, an operation record is a ref plus a JSON payload. This round builds both. Adopting jj itself was considered and declined: its workspaces are not git checkouts, which breaks the derive-from-git doctrine everything in `tuglaws/dash-lifecycle.md` rests on, and `jj-lib`'s API is unstable. We take the ideas.

## Item 1 — conflicts as durable data {#conflicts-as-data}

**The idea.** An unresolved join conflict becomes an object in the repository — a **conflict commit** — instead of live merge state in the workshop checkout. The workshop becomes a *materialization* of that object, rebuildable by any process at any time, rather than the sole holder of the conflict.

**Shape.** When the ladder ([P31]) exhausts its rungs with files still unresolved, it already holds everything the conflict *is*: the merge-tree result tree (markers materialized) and the parsed stage table — per path, the stage-1/2/3 blob oids and modes (`merge_tree_stages`, `resolve.rs:657`). Park that as a commit at `refs/tug/conflict/<name>`:

- The commit's **tree** is the merge-tree output — the project with markers in the conflicted files, everything else merged clean.
- The commit's **parents** are the base head and the dash head, so the inputs stay reachable and the conflict's provenance is ancestry, not bookkeeping.
- The **stage table** rides in the commit message (or a sibling blob the message names) so any process can recover the three-blob view per path without re-running the merge.

The workshop then changes character:

- **Open** = reset the workshop worktree to the conflict commit. No `git merge --no-commit`, so `MERGE_HEAD` never exists in the workshop's life — the abort-vs-reset divergence (`workshop.rs:378`, `ops.rs:3594`) collapses to one verb.
- **Resolver progress** = child commits of the conflict commit, made at whatever checkpoints the resolver's loop already has (per-file, per-turn — devise decides). A crash, a tugcast restart, or the R03 teardown loses at most the work since the last checkpoint; the resolve resumes from the ref, not from nothing.
- **Candidate** = today's `commit_candidate` unchanged in spirit: markers-clean, stages-clean, report-accounted, parented on the base head. The conflict commit and its checkpoints are released with the candidate marks in `clear_candidate`.
- **Staleness** = the conflict commit names its base parent, so "base advanced under the resolve" is an ancestry check on the ref, same as candidate staleness (`ops.rs:3465`), instead of a property of a live checkout.

**What this closes.** The `MERGE_HEAD` wedge class; the orphan-workshop re-creation race (an `open_*` after teardown re-materializes from the ref or finds it gone, either way coherently); the R03 damage (the CLI can still remove a worktree, but the resolution state survives in the ref — and with the conflict durable, the occupancy question becomes answerable *from git* rather than from tugcast's process memory, which is the real fix for a registry that lies after a crash). It also gives the resolve surfaces a truthful face for free: "conflicted, 3 of 5 files resolved" is a read of the ref, per the derive-don't-declare law.

**What this does not change.** The landing doctrine is untouched: `main` lands clean, always — a conflict commit never lands anywhere; it lives under `refs/tug/`, outside `refs/heads/`, invisible to every branch-globbing surface. The ladder's rungs, order, and rerere teach-back stay as they are; this changes where an *unfinished* conflict lives, not how conflicts get resolved.

## Item 2 — the operation log and `tugutil dash undo` {#op-log}

**The idea.** Every mutating dash verb writes an append-only operation record *before* it acts, capturing the before-state as refs — so the record itself keeps the pre-operation commits reachable — and `tugutil dash undo` reverses the most recent operation with the same compare-and-swap discipline `replay.rs:213` already established.

**Shape.** An op record is two halves:

- A **keepalive ref** at `refs/tug/oplog/<seq>` pointing at a synthetic commit whose parents are every tip the operation is about to move or delete — base head, dash head, candidate if present. This is the half that makes undo *possible*: after it exists, `branch -D` and `reset` can no longer strand the rounds.
- A **payload** (JSON beside the join journal in `project_state_dir`, or in the keepalive commit's message — devise decides one, not both) naming the verb, the dash, the refs' before-values, and the after-values written when the operation completes.

Verbs that log, in order of value: **join** (the integrate through teardown — one op, since the journal already treats it as one), **replay** (the CAS branch move), **discard** (branch + worktree deletion, hand-back census). Create does not need one — a half-made create already rolls itself back.

**Undo semantics, per verb.** Each undo is a CAS: it verifies the world still matches the op's *after*-state (base tip is still the join's commit, base checkout clean, no newer op touching the same dash) and refuses with a stated reason otherwise — never a force.

- **Undo join**: reset the base branch to its recorded tip (from the base checkout, `reset --keep`, same rationale as `cas_reset`), recreate `tugdash/<name>` at the recorded dash head, recreate the worktree through the existing create path (hydration hooks and all), restore the branch config facts the teardown cleared. The dash-log records the undo as its own line; the ink/binding side is *not* resurrected — a rebound session is a new binding, and the devise should confirm that boundary with the owner.
- **Undo replay**: move the dash branch back to the recorded pre-replay tip via the same CAS, and re-run `reconcile_ledger_cells` in reverse using the op's stored mapping.
- **Undo discard**: recreate branch and worktree at the recorded tip. Hand-backed dirt is *not* clawed back from the base — it was copied, not moved, and pulling files out of a user's checkout is exactly what this engine never does; the undo report names the overlap instead.

**Retention.** Cap the oplog (order of 50 records per repo, devise picks the number), pruned oldest-first at record time — the join-journal pattern, not a daemon. Pruning an op record is what finally lets git gc the commits it kept alive, which is the honest meaning of "this operation is no longer undoable."

**What this closes.** The "no reverse gear" gap named above; the reflog-archaeology recovery mode; and it quietly hardens *every* verb, because a verb that must first record what it is about to change is a verb that has enumerated what it changes.

## Order and dependencies {#order}

Item 2 first. It is smaller, it is pure addition (no existing seam moves), and it puts a net under item 1's larger surgery — the first undo-able operations exist before the workshop's insides are rearranged. Item 1 then lands as its own phase, with the resolver loop (`join_resolver.rs`) adopting checkpoint commits last, after the conflict-ref substrate is proven by the ladder and workshop paths alone.

## Non-goals {#non-goals}

- **No jj dependency**, no `jj-lib`, no colocated repos — this round is the reasoned alternative to that. Revisit only if jj's workspaces someday host functional git checkouts.
- **No change to the landing doctrine.** Squash stays the default shape; `main` never carries a conflict; the candidate-is-bytes-never-shape rule stands.
- **No rerere changes.** Rung 2 and its teach-back stay exactly as they are.
- **No UI work.** The shade and sheet read whatever the derived facts already say; richer conflict faces ride the existing derive path or wait for their own round.
- **No new daemon, lock file, or registry.** Both items are refs plus files in `project_state_dir`, recovered by construction — the occupancy lesson applied, not repeated.

## Open questions for the devise round {#open-questions}

1. Checkpoint granularity for resolver commits on the conflict ref — per file resolved, per resolver turn, or both.
2. Payload location for op records — `project_state_dir` JSON (greppable, matches the journal) vs the keepalive commit message (atomic with the ref). One, not both.
3. Whether `undo join` restores the session binding or leaves rebinding to the user; the recommendation above is leave it, but it is an owner call.
4. Whether `join --continue` folds into the op-log machinery now or stays a parallel journal until item 1 settles — folding is cleaner, but the journal is proven and the fold can be its own later step.
