# The dash revision flow

*A picture of what git holds while a dash is created, worked, replayed onto a moving base, and joined back — every ref by name, every commit by the command that made it. The prose laws are [dash-lifecycle.md](dash-lifecycle.md) (what a dash is, the op log, the lease) and [tracking-changes.md](tracking-changes.md#the-landing-workflow) (the landing workflow); this file draws the shape first, then explains the machinery, what we took from Jujutsu, and the base-branch question in prose. The code is `tugdash-core/src/{ops,replay,resolve,workshop,oplog}.rs`.*

## Executive summary

A **dash** is a unit of work done off to the side: a git branch (`tugdash/<name>`) with its own worktree, cut from the tip of a **base** branch. The dash accumulates commits — called **rounds** — while other work keeps landing on the base underneath it. Eventually the dash **joins** back: by default all of its rounds are squashed into one commit on the base, and the branch and worktree are deleted. That is the whole trip: create, work, join.

Three ideas make the flow what it is.

**Nothing is stored that can be derived.** There is no dash database. A dash is just the branch, the worktree, and one git config key naming its base. How many rounds exist, whether the worktree is dirty, where the fork point is — all of it is re-computed from git on every read. This is why every surface (CLI, UI, join checks) agrees: they are all asking git the same questions rather than consulting copies that could drift.

**The base moves, and the dash follows automatically.** When new commits land on the base, a background process **replays** the dash's rounds on top of the new tip. The replay is built entirely in memory using git plumbing — no checkout is touched until a single atomic swap at the end, which is refused if the worktree is dirty or anything moved meanwhile. So a dash stays continuously rebased onto the live base without ever wedging a working copy, and if a replay hits a conflict it simply stops and reports rather than leaving a mess.

**Conflicts are data, never a wedged checkout.** When a join can't merge cleanly, a **ladder** of increasingly powerful resolvers runs — from git's own machinery (rerere, merge-file, merge drivers) up to an AI model. Whatever survives all rungs is *parked*: the conflict state is committed to a special ref (`refs/tug/conflict/<name>`), complete with a machine-readable record of what's unresolved, and a multi-turn AI **resolver agent** works on it in a separate scratch worktree, checkpointing progress as commits. Its finished result — the **candidate** — is then landed by the ordinary join. The user's checkout never holds conflict markers and there is never a `MERGE_HEAD` to untangle.

Backing all of this is an **operation log**: before any verb mutates anything, it records every tip about to move in a keepalive commit plus a JSON payload, so every join, replay, and teardown can be undone with a compare-and-swap, and pre-replay history stays reachable until the log is pruned. A verb that fails leaves the base exactly as it found it and records nothing.

The rest of this document draws those shapes precisely — every ref by name, every commit by the command that made it — then explains the machinery in prose, sets the design beside Jujutsu's, and covers using a base other than the default branch.

---

The word **base** below means whatever `branch.tugdash/<name>.tugbase` names — `main` in this repository, but any branch that exists at `create --base <branch>` time. Nothing in the flow reads the word `main`.

## 1. Create — a branch and a worktree cut from the base tip

```
   git worktree add .tug/worktrees/<name> -b tugdash/<name> <base>
   git config branch.tugdash/<name>.tugbase <base>

   base   ──o──o──o──B0                      B0 = base tip at birth
                      \
   tugdash/<name>      (B0)                  same commit, new ref, own worktree
```

Only the base's **name** is recorded. The fork point is never written down; it is re-derived every read as `git merge-base`, which is what keeps it honest after replays.

## 2. Work — rounds accumulate; the base keeps moving underneath

```
   base   ──o──B0──o──o──B1                  other sessions land on the base
                 \
   tugdash/<name> r1──r2──r3                 one commit per `dash commit` round

   rounds  = git rev-list --count <base>..tugdash/<name>      (derived, never stored)
   dirt    = git status --porcelain in the worktree            (derived, never stored)
```

## 3. Replay — base motion is answered by rebuilding the rounds in memory

`tugcast` watches the base tip; when it moves, `replay.rs` walks the rounds forward with plumbing only, writing loose objects and never touching a checkout until the final compare-and-swap.

```
   for each r in  git rev-list --reverse <base>..tugdash/<name>:
       tree = git merge-tree --write-tree --merge-base=r^  acc  r
       acc  = git commit-tree tree -p acc -m "$(git log -1 --format=%B r)"

   base   ──o──B0──o──o──B1
                 \            \
                  r1──r2──r3   r1'──r2'──r3'    ← same messages, new parents
                          ↑             ↑
                   before: tip   after: git reset --keep r3'  (refused if the
                                        worktree is dirty or the tip moved)

   Outcomes:  Current   base never moved, nothing to do
              Recorded  already an ancestor (hand-rebased); ledger cells repaired
              Replayed  branch moved to r3'
              Conflicted  merge-tree named paths; stops at that round, nothing moves
              Deferred  dirty worktree — try again later
```

The old `r1..r3` stay reachable through the op log's keepalive (§6) until it is pruned.

## 4. Join — preflight, integrate, teardown

```
   /dash-join <name>   (composer = the squash message; the human presses ⬆)

   preflight, same function for --preview and for the act:
     off-base       checkout HEAD is not <base>
     base-dirt      base checkout dirt ∩ dash's changed paths, minus byte-identical copies
     stale-journal  an incomplete join op stands (→ join --continue)
     live-resolve   resolver lease held on the conflict chain (→ --break-lease)
     empty          rev-list --count <base>..tugdash/<name> == 0 (→ release)

   integrate (default strategy = squash):
     git merge --squash tugdash/<name>  &&  git commit -m "<subject>\n\nTug-Dash: …"

   base   ──o──B0──o──o──B1──J             J = ONE commit, the drafted message
                 \            ↑
                  r1'──r2'──r3'            ...then the branch and worktree go away

   Strategies:  Squash  merge --squash + commit        (the shipped default)
                Merge   merge --no-ff -m <msg>
                Rebase  merge --ff-only, else cherry-pick <base>..<branch>

   teardown phases, each persisted on the op record BEFORE its acts count as done:
     Integrated ─▶ WorktreeRemoved ─▶ BranchDeleted ─▶ record (dash-log "joined", op complete)
     a crash anywhere leaves stage = `joining`; `join --continue` resumes at the phase
```

A join that lands nothing — a conflict, a stale candidate, an integrate error — resets the base to what it found (`reset --hard` / `merge --abort` / `cherry-pick --abort`) and **drops the op record**. An incomplete record therefore always means a teardown to resume.

## 5. Conflict — the ladder, the chain, the candidate

When the preview's `git merge-tree --write-tree <base> tugdash/<name>` reports stages, the ladder runs. Each rung either produces bytes with no complete marker block or hands the path down.

```
   rung 0  clean squash      no stages at all → candidate = commit-tree(merged) -p <base>
   rung 1  replay probe      walk the rounds (§3) — all clean → candidate = replayed head
   rung 2a salvage           this dash's prior chain, same 3 stage oids → lift its blob
   rung 2  rerere            scratch worktree, git merge, git rerere remaining
   rung 3  merge-file        git -c diff.algorithm=histogram merge-file -p --zdiff3
   rung 4  driver            tugdash.mergedriver, else mergiraf if on PATH
   rung 5  scribe            one-shot model merge of base/ours/theirs, validated marker-free
   ──────  ladder ends  ──────
   rung 6  resolver agent    multi-turn, in the workshop, on the parked chain (tugcast)

   patched tree:  GIT_INDEX_FILE=<scratch> read-tree; update-index --cacheinfo per path; write-tree
```

Whatever is still unresolved is **parked as data**, not as a wedged checkout:

```
   refs/tug/conflict/<name>          the chain — a ref, outside refs/heads/
     C0  git commit-tree <patched-tree> -p <base-tip> -p <dash-tip>
         -m "tugconflict(<name>): N unresolved\n\n{json: base_head, dash_head, paths[{stage oids}], resolved[]}"
     └─ "tugresolve(<name>): begin"          empty-delta marker  ┐ the resolver's
        └─ "tugresolve(<name>): checkpoint"  one per turn        │ own op log;
           └─ "tugresolve(<name>): end"      empty-delta marker  ┘ the lease reads the tip

   validity  = base tip == json.base_head && dash tip == json.dash_head  (strict; any motion → ladder restarts)
   lease     = chain stands && tip is tugresolve(…) not `end` && no candidate && tip age < 2h

   workshop  .tug/workshops/<name>  on  tugworkshop/<name>     a stable warm worktree,
             `git reset --hard <chain tip> && git clean -fd`   never a merge, never MERGE_HEAD

   refs/tug/join/<name>              the candidate — a finished tree, parented on the base tip
     + branch config tugjoinsource / tugjoinresolved / tugjoinreport / tugjoinquestion
```

Then the ordinary join lands the candidate: `merge-base --is-ancestor <base-tip> <candidate>` proves the base has not moved since, and the same strategy match runs over the candidate instead of the branch — its shape (N replayed rounds) never dictates the base's history; the squash does.

## 6. The operation log — what undo stands on

```
   before the verb acts:
     seq  = next free   refs/tug/oplog/000042   (create-only update-ref; a lost race errors)
     keep = git commit-tree <empty> -p <dash tip> -p <base tip> [-p candidate] [-p chain tip]
     payload  <project-state>/oplog-000042.json   { verb, dash, before{…}, join: null }

   after:     payload rewritten   { …, after{ base_tip, landed_commit }, join{ phase … } }
   abandoned: update-ref -d + payload removed   (the verb left the base as it found it)

   keepalive-000042 ─┬─▶ r3'   (dash tip)        every parent stays reachable after
                     ├─▶ B1    (base tip)         `branch -D` and `reset`, from a ref,
                     ├─▶ cand                     not from a reflog on a clock
                     └─▶ chain tip

   undo join    = CAS: base tip == after.base_tip, branch absent, then
                  git reset --keep before.base_tip;  branch + worktree + config restored
   refusals     tip-moved · base-dirty · branch-exists · already-undone · incomplete-op · nothing-to-undo
   retention    50 per repository, pruned oldest-first by the writer; pruning the keepalive
                is what finally lets gc collect the rounds
```

## 7. The whole trip, on one line

```
 base ──o──B0──────o──o──B1─────────────────────────────────J──o──
             \                 replay             join       ↑
   tugdash/<n> r1──r2──r3  ═══▶ r1'──r2'──r3' ══▶ [ladder] ══╝   (branch + worktree gone;
                                                    │             op 42 knows how to put
                                       refs/tug/conflict/<n>      them back)
                                       refs/tug/join/<n>
```

---

# The machinery, in prose

*The drawing above shows the shape. These sections say how it works and why, so the next person — curious, or revising the approach — does not have to re-read five crates to find out. Line references are to `tugrust/crates/tugdash-core/src/` unless said otherwise.*

## How the base is tracked relative to a dash

There is no dash database and no stored fork point. A dash is a branch, a worktree, and one config key — `branch.tugdash/<name>.tugbase` (`ops.rs`, `base_config_key`). Every other fact is **derived on the read**: rounds are `git rev-list --count <base>..tugdash/<name>`, dirt is `git status --porcelain` in the worktree, and the fork point is whatever `merge-base` says now. This is the derive-don't-declare rule of [dash-lifecycle.md](dash-lifecycle.md#the-stages-and-derive-vs-declare) applied to revision state, and it is what lets the CLI, the Changes card, and the join preflight agree by construction.

The base moving underneath a dash is answered by **replay** (`replay.rs`), driven by tugcast's base-motion feed. Replay rebuilds the rounds in memory — `git merge-tree --write-tree --merge-base=<round>^ <acc> <round>` then `git commit-tree` per round, in `walk_rounds` — and only at the end performs one compare-and-swap `git reset --keep` in the dash worktree, refused if the worktree is dirty or the tip moved mid-walk. Its five outcomes are `Current` (base never moved), `Recorded` (already an ancestor, e.g. a hand rebase; plan-ledger cells repaired), `Replayed` (branch moved), `Conflicted` (merge-tree named paths at a round; nothing moves), and `Deferred` (dirty worktree; try later). A dash therefore stays continuously rebased onto the live base, with plumbing that never wedges a checkout, and the pre-replay rounds stay reachable through the op log's keepalive until that op is pruned.

## The join machinery

`join_in_with_progress` (`ops.rs`) runs one **preflight** that serves both `--preview` and the act, so a blocker's sentence is verbatim the refusal it predicts. The blockers: `off-base` (the base checkout's HEAD is not the base branch), `base-dirt` (base checkout dirt intersected with the dash's changed paths — byte-identical copies are not a blocker; they are dropped with `git checkout HEAD -- <path>` and named in a warning), `stale-journal` (an incomplete join op stands; `join --continue` clears it), `live-resolve` (a resolver lease holds the conflict chain; `--break-lease` or resolving again clears it), and `empty` (no rounds past base; release instead). Then the worktree's dirt is swept into a `Tug-Sweep: 1` round, the op-log record opens with every tip pinned, and `integrate_join` runs.

**Integrate** is one function returning `Landed | Conflicted`. The shipped default is **squash**: `git merge --squash tugdash/<name>` then `git commit -m <message>`, the message being the composer's draft with the `Tug-Dash:` trailer added — exactly one commit lands on the base. `Merge` (`--no-ff`) and `Rebase` (`--ff-only`, else `cherry-pick <base>..<branch>`) exist as strategies. Any non-zero exit collects `conflicted_paths`, restores the base (`reset --hard` for a squash, which sets no `MERGE_HEAD`; `merge --abort` / `cherry-pick --abort` otherwise), and **abandons the op record** — a join that lands nothing records nothing. On `Landed`, the record's payload gains `JoinProgress { phase, commit_hash, strategy, message }` and becomes the resume record.

**Teardown** (`finish_join_teardown`) is phased — `Integrated → WorktreeRemoved → BranchDeleted → record` — and each phase is persisted on the op payload *before* its acts are treated as done, so a crash under-claims and a resume repeats idempotent work. The phases: `git worktree remove --force` (retried, then `worktree prune`); `clear_candidate` (which also drops the conflict chain), workshop removal, `git branch -D`, deletion of `.tug/dashes/<name>/`; then the dash-log line `joined` and `record_complete` with the base tip and landed commit. `join --continue` enters above the branch-exists guard, because a join killed after `branch -D` is the one that most needs to resume.

**Conflicts** never reach the user as a wedged checkout. The preview's `git merge-tree --write-tree <base> tugdash/<name>` reports stages; the **ladder** (`resolve.rs`, `resolve_ladder`) runs its rungs in order — clean squash, replay probe, salvage (this dash's own prior chain, on exact stage-oid identity), rerere, `git merge-file --zdiff3` with histogram diff, a structured driver (`tugdash.mergedriver`, else `mergiraf` on `PATH`), and a one-shot scribe merge — each accepted only if the result carries no complete marker block. The resolved paths are stitched into a tree through a scratch index (`patch_tree`), never the repo's real index. What remains is **parked as data**: a commit on `refs/tug/conflict/<name>` parented on both the base tip and the dash tip, its record (stage oids, kinds, what each rung resolved) as JSON in the message. The multi-turn **resolver agent** (`tugcast/src/feeds/join_resolver.rs`) then works in the **workshop** — a stable, warm worktree on `tugworkshop/<name>`, reset to the chain tip with `reset --hard` + `clean -fd`, never `-x`, never a merge — checkpointing each turn as a commit on the chain, until it anchors a **candidate** at `refs/tug/join/<name>`. The ordinary join lands the candidate through the same strategy match after `merge-base --is-ancestor` proves the base has not moved: **the candidate is the bytes, never the shape**, so a replayed chain of N rounds still arrives on the base as one squash carrying the drafted message.

**Undo** (`oplog.rs`) rests on the record every mutating verb writes before it acts: a keepalive commit on `refs/tug/oplog/<seq>` whose parents are every tip about to move or die, and a JSON payload written twice. An undo is a compare-and-swap — base tip unmoved, branch not rebuilt, `reset --keep` rather than `--hard` — and refuses by name otherwise. See [dash-lifecycle.md](dash-lifecycle.md#the-operation-log-and-undoing) for the redo discipline.

## What we took from Jujutsu, and where we go our own way

Jujutsu (`jj`, Apache-2.0) is the best prior art for this problem, and we read it closely. Four of its ideas are borrowed at the design level, each cited where it lands ([D157], [D160], [D161], and the comment on the abandon arms in `ops.rs`):

- **The transaction rule.** A transaction that is not committed writes no operation. Here: every exit of `integrate_join` that leaves the base as it found it calls `oplog::abandon`, so an incomplete record unambiguously *means* a teardown to resume.
- **The op-heads lock carries no correctness.** jj's lock exists only to avoid duplicated work. Here: the resolver **lease** is a derived hint read off the conflict chain's tip, the in-process registry is the fast path, and a wrong lease costs one turn that the op log makes recoverable.
- **Structural marker parsing.** jj's `parse_conflict` shape — a marker is a run of ≥7 identical characters at column 0 followed by end-of-line or a label, and a conflict exists only where a complete ordered block does. Here: `scan_conflict_blocks` / `marker_kind`, which is what stopped a markdown `=======` underline from reading as a conflict.
- **Conflicts as data**, in spirit: an unresolved merge is a committed object with a record, not a wedged working copy.

The differences are structural and deliberate:

- jj's operation log is a **DAG of operation heads**, each holding a complete view of every ref, and undo restores a view. Ours is a **flat, sequential log capped at 50**, one keepalive commit plus one payload per op, and undo is a **compare-and-swap** on named tips. No concurrent-operation merge exists here and none is needed: git's create-only `update-ref` is the only lock.
- jj stores a conflict **inside the commit** as an N-way `Merge<T>` algebra that survives rebases and round-trips through markers. We store git's **materialized** markers plus the three stage oids, and validity is **strict head equality** — any base motion invalidates the chain and the ladder restarts, with the salvage rung recovering checkpointed work wherever the stage oids are byte-identical. The algebra, marker round-tripping, and marker-length escalation buy us nothing: git materializes our markers and resolvers rewrite whole files, so detection is the whole need.
- jj has no index and auto-snapshots the working copy. We are all-in on real git worktrees, `merge-tree --write-tree`, and rerere, and the user's checkout is something this engine never writes into.
- jj has first-class **change ids** that survive rewrites. We carry provenance differently: a join is a squash carrying a `Tug-Dash:` trailer, and lineage is ancestry on the conflict root (two parents) rather than an id.

What we took from jj is ideas, not code, so [L21] wants no `THIRD_PARTY_NOTICES.md` entry. This section is the credit.

## A base other than the default branch

The base is a **per-dash fact, set at birth**, and the whole flow reads it through one function: `dash_base` (`ops.rs`) returns `branch.tugdash/<name>.tugbase` if set, else `detect_default_branch` (`dash.rs`: `origin/HEAD`, then `main`, then `master`). `tugtool dash create <name> --base <branch>` records any existing branch as the base; a revisit ignores the flag because a base is set at birth. Every consumer — the join preflight, replay, the ladder, `conflict_is_valid`, the workshop's base head, and the op record's `before.base_branch` — is threaded from that one read. The op record states the base as a fact rather than re-deriving it, because by the time a `--continue` runs the branch may be gone and detection would be a guess. Only two literals ship: the detector's `main`/`master` probe, and a last-resort `"main"` fallback in `base_branch_of` that should become a refusal rather than a guess.

What is *not* yet built, should the base ever need to be a first-class choice rather than a CLI flag: the dash-lane skills never pass `--base`; the wire and the deck do not carry `base_branch`, so a card can neither show nor choose it; and the `off-base` blocker requires the checkout's HEAD to *equal* the base, which is correct for any base but tells the user nothing about which branch to check out. The natural shape is to surface `base_branch` on the dash entry and the create route, let `/dash` default the base to the checkout's current branch when that is not the default, and delete the fallback — a small dash, not a change to the flow drawn above.
