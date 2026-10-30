# The arc revision flow

*A picture of what git holds while an arc is created, worked, replayed onto a moving base, and joined back — every ref by name, every commit by the command that made it. The prose laws are [arc-lifecycle.md](arc-lifecycle.md) (what an arc is, the op log, the stages) and [tracking-changes.md](tracking-changes.md#the-landing-workflow) (the landing workflow); this file draws the shape first, then explains the machinery, what we took from Jujutsu, and the base-branch question in prose. The code is `tugarc-core/src/{ops,replay,resolve,crossing,oplog}.rs`.*

## Executive summary

An **arc** is a unit of work done off to the side: a git branch (`tugarc/<name>`) with its own worktree, cut from the tip of a **base** branch. The arc accumulates commits — called **rounds** — while other work keeps landing on the base underneath it. Eventually the arc **joins** back: by default all of its rounds are squashed into one commit on the base, and the branch and worktree are deleted. That is the whole trip: create, work, join.

Three ideas make the flow what it is.

**Nothing is stored that can be derived.** There is no arc database. An arc is just the branch, the worktree, and one git config key naming its base. How many rounds exist, whether the worktree is dirty, where the fork point is — all of it is re-computed from git on every read. This is why every surface (CLI, UI, join checks) agrees: they are all asking git the same questions rather than consulting copies that could drift.

**The base moves, and the arc follows automatically.** When new commits land on the base, a background process **replays** the arc's rounds on top of the new tip. The replay is built entirely in memory using git plumbing — no checkout is touched until a single atomic swap at the end, which is refused if the worktree is dirty or anything moved meanwhile. So an arc stays continuously rebased onto the live base without ever wedging a working copy, and if a replay hits a conflict it simply stops and reports rather than leaving a mess.

**Conflicts are the audit's, and a crossing settled early answers many of them.** The join resolves nothing: an arc is ready only while its audit stands on the live base, so the tree a join lands is the tree that was verified, and a conflict met when the base moves is resolved by the arc's audit stage, in its worktree, as ordinary rounds. Live arcs on one base are probed against each other every round; a crossing that conflicts is settled while both sides are a round old, by a ladder of increasingly powerful resolvers — git's own machinery (rerere, merge-file, merge drivers), a one-shot AI merge, then a multi-turn resolver in a scratch checkout — and what it settles is taught to the shared rerere cache. Every replay recalls from that cache, so the conflict an audit would have met is often already answered. The user's checkout never holds conflict markers and there is never a `MERGE_HEAD` to untangle.

Backing all of this is an **operation log**: before any verb mutates anything, it records every tip about to move in a keepalive commit plus a JSON payload, so every join, replay, and teardown can be undone with a compare-and-swap, and pre-replay history stays reachable until the log is pruned. A verb that fails leaves the base exactly as it found it and records nothing.

The rest of this document draws those shapes precisely — every ref by name, every commit by the command that made it — then explains the machinery in prose, sets the design beside Jujutsu's, and covers using a base other than the default branch.

---

The word **base** below means whatever `branch.tugarc/<name>.tugbase` names — `main` in this repository, but any branch that exists at `create --base <branch>` time. Nothing in the flow reads the word `main`.

## 1. Create — a branch and a worktree cut from the base tip

```
   git worktree add .tug/worktrees/<name> -b tugarc/<name> <base>
   git config branch.tugarc/<name>.tugbase <base>

   base   ──o──o──o──B0                      B0 = base tip at birth
                      \
   tugarc/<name>       (B0)                  same commit, new ref, own worktree
```

Only the base's **name** is recorded. The fork point is never written down; it is re-derived every read as `git merge-base`, which is what keeps it honest after replays.

## 2. Work — rounds accumulate; the base keeps moving underneath

```
   base   ──o──B0──o──o──B1                  other sessions land on the base
                 \
   tugarc/<name>  r1──r2──r3                 one commit per `arc commit` round

   rounds  = git rev-list --count <base>..tugarc/<name>      (derived, never stored)
   dirt    = git status --porcelain in the worktree            (derived, never stored)
```

## 3. Replay — base motion is answered by rebuilding the rounds in memory

`tugcast` watches the base tip; when it moves, `replay.rs` walks the rounds forward with plumbing only, writing loose objects and never touching a checkout until the final compare-and-swap.

```
   for each r in  git rev-list --reverse <base>..tugarc/<name>:
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
   /arc-join <name>   (composer = the squash message; the human presses ⬆)

   preflight, same function for --preview and for the act:
     off-base       checkout HEAD is not <base>
     base-dirt      base checkout dirt ∩ arc's changed paths, minus byte-identical copies
     stale-journal  an incomplete join op stands (→ join --continue)
     empty          rev-list --count <base>..tugarc/<name> == 0 (→ release)

   integrate (default strategy = squash):
     T = git merge-tree --write-tree <base> tugarc/<name>     (objects only; a conflict stops here)
     J = git commit-tree T -p <base> -m "<subject>\n\nTug-Arc: …"
     git merge --ff-only J                                    (the one act that touches the base)

   base   ──o──B0──o──o──B1──J             J = ONE commit, the drafted message
                 \            ↑
                  r1'──r2'──r3'            ...then the branch and worktree go away

   Strategies:  Squash  commit-tree, one parent        (the shipped default)
                Merge   commit-tree, two parents: <base> and the arc tip
                Rebase  merge --ff-only, else cherry-pick <base>..<branch>

   teardown phases, each persisted on the op record BEFORE its acts count as done:
     Integrated ─▶ WorktreeRemoved ─▶ BranchDeleted ─▶ record (arc log "joined", op complete)
     a crash anywhere leaves stage = `joining`; `join --continue` resumes at the phase
```

A squash or merge join **never stages on the base**: the commit is built off to the side and landed by fast-forward, which refuses before writing anything when it loses the index lock or when local changes overlap, and leaves disjoint dirt alone — so there is nothing to roll back, and no `reset --hard` anywhere in the integrate. (Only `Rebase`'s cherry-pick works on the base, and aborts.) A join that lands nothing — a conflict, an integrate error — **drops the op record only after proving the base is as it found it**: `HEAD`, no `SQUASH_MSG`/`MERGE_HEAD`/`CHERRY_PICK_HEAD`, and the arc's paths all read as they did before. When that cannot be proven the record is kept, marked `stranded` with the paths; `join` and `arc undo` refuse it by name, `arc doctor` reports it, and `resolve-base` clears it. An incomplete record therefore means a teardown to resume, or a base to clear — and says which.

## 5. Conflict — the crossing settle and the cache

The join never resolves. A conflict is met when the base moves, by the replay (§3), and the replay recalls what the cache knows before it stops:

```
   for a round whose merge-tree conflicts:
     1  the round alone     cherry-pick r onto acc in a scratch worktree, rerere on;
                            marker-free and `rerere remaining` empty → that tree is r'
     2  the rest as one     squash r..tip onto r^, picked onto acc the same way;
                            recalled → r..tip collapse into ONE commit, every round maps to it
     3  the whole arc       when earlier rounds recalled alone but this one's hunk was only
                            ever taught beside theirs: squash the arc onto its fork, picked
                            onto <base> — recalled → the whole arc is one commit
     otherwise              Conflicted at r; nothing moves; the arc's audit resolves it

   arc log:  onto <base>: <old>-><new>[, …]; recalled <path> …
```

What the cache knows, it learned from **crossings**: two live arcs on one base probed against each other on every round.

```
   probe    changed paths of each tip since the fork ∩ → overlap? → git merge-tree <a-tip> <b-tip>
   record   branch config  tugcrossing.<lo> <hi>.state     the standing crossing
                           tugcrossing.<lo> <hi>.settled   fingerprint of the conflict a settle finished over
   settle   pair ladder over the two tips, in name order:
              rerere · merge-file (histogram, zdiff3) · driver (tugarc.mergedriver, else mergiraf)
              · one-shot scribe, held marker-free and to every clean segment
            then a resolver in a scratch checkout of the merge for what is left
   teaches  the shared rr-cache — the only thing written; neither branch moves
   wakes    base-motion, so a replay that stopped before the cache learned is retried
```

A settle writes its finished mark only while both arcs still stand; a join or discard forgets every record naming its arc.
## 6. The operation log — what undo stands on

```
   before the verb acts:
     seq  = next free   refs/tug/oplog/000042   (create-only update-ref; a lost race errors)
     keep = git commit-tree <empty> -p <arc tip> -p <base tip>
     payload  <project-state>/oplog-000042.json   { verb, arc, before{…}, join: null }

   after:     payload rewritten   { …, after{ base_tip, landed_commit }, join{ phase … } }
   abandoned: update-ref -d + payload removed   (the verb left the base as it found it)

   keepalive-000042 ─┬─▶ r3'   (arc tip)         every parent stays reachable after
                     └─▶ B1    (base tip)         `branch -D` and `reset`, from a ref,
                                                  not from a reflog on a clock

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
   tugarc/<n> r1──r2──r3  ═══▶ r1'──r2'──r3' ═══ audited ═══╝   (branch + worktree gone;
                                                                  op 42 knows how to put
                                                                  them back)
```

---

# The machinery, in prose

*The drawing above shows the shape. These sections say how it works and why, so the next person — curious, or revising the approach — does not have to re-read five crates to find out. Line references are to `tugrust/crates/tugarc-core/src/` unless said otherwise.*

## How the base is tracked relative to an arc

There is no arc database and no stored fork point. An arc is a branch, a worktree, and one config key — `branch.tugarc/<name>.tugbase` (`ops/identity.rs`, `base_config_key`). Every other fact is **derived on the read**: rounds are `git rev-list --count <base>..tugarc/<name>`, dirt is `git status --porcelain` in the worktree, and the fork point is whatever `merge-base` says now. This is the derive-don't-declare rule of [arc-lifecycle.md](arc-lifecycle.md#the-stages-and-derive-vs-declare) applied to revision state, and it is what lets the CLI, the Changes card, and the join preflight agree by construction.

The base moving underneath an arc is answered by **replay** (`replay.rs`), driven by tugcast's base-motion feed. Replay rebuilds the rounds in memory — `git merge-tree --write-tree --merge-base=<round>^ <acc> <round>` then `git commit-tree` per round, in `walk_rounds` — and only at the end performs one compare-and-swap `git reset --keep` in the arc worktree, refused if the worktree is dirty or the tip moved mid-walk. Its five outcomes are `Current` (base never moved), `Recorded` (already an ancestor, e.g. a hand rebase; plan-ledger cells repaired), `Replayed` (branch moved), `Conflicted` (merge-tree named paths at a round; nothing moves), and `Deferred` (dirty worktree; try later). An arc therefore stays continuously rebased onto the live base, with plumbing that never wedges a checkout, and the pre-replay rounds stay reachable through the op log's keepalive until that op is pruned.

## The join machinery

`join_in_with_progress` (`ops/join.rs`) runs one **preflight** that serves both `--preview` and the act, so a blocker's sentence is verbatim the refusal it predicts. The blockers: `off-base` (the base checkout's HEAD is not the base branch), `base-dirt` (base checkout dirt intersected with the arc's changed paths — byte-identical copies are not a blocker; they are dropped with `git checkout HEAD -- <path>` and named in a warning), `stale-journal` (an incomplete join op stands; `join --continue` clears it), and `empty` (no rounds past base; release instead). Then the worktree's dirt is swept into a `Tug-Sweep: 1` round, the op-log record opens with every tip pinned, and `integrate_join` runs.

**Integrate** is one function returning `Landed | Conflicted`. The shipped default is **squash**: the result tree comes from `git merge-tree --write-tree` (a conflict there touches nothing); `git commit-tree` writes the commit — the message being the composer's draft with the `Tug-Arc:` trailer added — and `git merge --ff-only` lands it, retrying past a held `index.lock` with every other index write. Exactly one commit lands on the base, and nothing is ever staged there. `Merge` is the same with the arc tip as a second parent; `Rebase` (`--ff-only`, else `cherry-pick <base>..<branch>`, aborted on conflict) keeps the rounds. An integrate that does not land **abandons the op record only once the base is proven untouched** — a join that lands nothing records nothing, and the premise is checked; otherwise the record is kept and marked `stranded`. On `Landed`, the record's payload gains `JoinProgress { phase, commit_hash, strategy, message }` and becomes the resume record.

**Teardown** (`finish_join_teardown`) is phased — `Integrated → WorktreeRemoved → BranchDeleted → record` — and each phase is persisted on the op payload *before* its acts are treated as done, so a crash under-claims and a resume repeats idempotent work. The phases: `git worktree remove --force` (retried, then `worktree prune`); the arc's crossings and the retired pipeline's residue forgotten (`forget_crossings`, `forget_join_residue`), `git branch -D`, deletion of `.tug/arcs/<name>/`; then the arc log's `joined` line and `record_complete` with the base tip and landed commit. `join --continue` enters above the branch-exists guard, because a join killed after `branch -D` is the one that most needs to resume.

**Conflicts** never reach the user as a wedged checkout, and never reach the join: a ready arc's audit verified the tree on the exact base it lands on ([D226]). They are met by the replay (`replay.rs`, `walk_rounds`), which offers a conflicting round to the rerere cache in a scratch worktree — the round alone, then the rest of the arc as one change, then the whole arc — and stops only on what the cache does not hold. The cache is taught by **crossing settles** (`crossing.rs`, `tugcast/src/feeds/crossing_settle.rs`): the pair ladder (`resolve.rs`, `resolve_pair`) runs rerere, `git merge-file --zdiff3` with histogram diff, a structured driver (`tugarc.mergedriver`, else `mergiraf` on `PATH`), and a one-shot scribe merge over the two arcs' tips, each accepted only if the result carries no complete marker block and keeps every clean segment; what is left goes to the multi-turn resolver (`tugcast/src/feeds/crossing_resolver.rs`) in a scratch checkout of the merge (`PairCheckout`), whose finished files teach the cache under the same bar. Nothing is committed and neither branch moves.

**Undo** (`oplog.rs`) rests on the record every mutating verb writes before it acts: a keepalive commit on `refs/tug/oplog/<seq>` whose parents are every tip about to move or die, and a JSON payload written twice. An undo is a compare-and-swap — base tip unmoved, branch not rebuilt, `reset --keep` rather than `--hard` — and refuses by name otherwise. See [arc-lifecycle.md](arc-lifecycle.md#the-operation-log-and-undoing) for the redo discipline.

## What we took from Jujutsu, and where we go our own way

Jujutsu (`jj`, Apache-2.0) is the best prior art for this problem, and we read it closely. Two of its ideas are borrowed at the design level, each cited where it lands ([D157], [D161], and the comment on the abandon arms in `ops/join.rs`):

- **The transaction rule.** A transaction that is not committed writes no operation. Here: every exit of `integrate_join` that leaves the base as it found it calls `oplog::abandon`, so an incomplete record unambiguously *means* a teardown to resume.
- **Structural marker parsing.** jj's `parse_conflict` shape — a marker is a run of ≥7 identical characters at column 0 followed by end-of-line or a label, and a conflict exists only where a complete ordered block does. Here: `scan_conflict_blocks` / `marker_kind`, which is what stopped a markdown `=======` underline from reading as a conflict.

The differences are structural and deliberate:

- jj's operation log is a **DAG of operation heads**, each holding a complete view of every ref, and undo restores a view. Ours is a **flat, sequential log capped at 50**, one keepalive commit plus one payload per op, and undo is a **compare-and-swap** on named tips. No concurrent-operation merge exists here and none is needed: git's create-only `update-ref` is the only lock.
- jj stores a conflict **inside the commit** as an N-way `Merge<T>` algebra that survives rebases and round-trips through markers. We store no conflict at all: a settled crossing becomes a recorded resolution in git's own rerere cache, recalled wherever git meets the same hunk, and an unsettled one is resolved by the arc's audit as ordinary rounds. The algebra, marker round-tripping, and marker-length escalation buy us nothing: git materializes our markers and resolvers rewrite whole files, so detection is the whole need.
- jj has no index and auto-snapshots the working copy. We are all-in on real git worktrees, `merge-tree --write-tree`, and rerere, and the user's checkout is something this engine never writes into.
- jj has first-class **change ids** that survive rewrites. We carry provenance differently: a join is a squash carrying a `Tug-Arc:` trailer, and the arc log records what each round became across a replay rather than an id.

What we took from jj is ideas, not code, so [L21] wants no `THIRD_PARTY_NOTICES.md` entry. This section is the credit.

## A base other than the default branch

The base is a **per-arc fact, set at birth**, and the whole flow reads it through one function: `arc_base` (`ops/identity.rs`) returns `branch.tugarc/<name>.tugbase` if set, else `detect_default_branch` (`log.rs`: `origin/HEAD`, then `main`, then `master`). `tugtool arc create <name> --base <branch>` records any existing branch as the base; a revisit ignores the flag because a base is set at birth. Every consumer — the join preflight, replay, the ladder, `conflict_is_valid`, and the op record's `before.base_branch` — is threaded from that one read. The op record states the base as a fact rather than re-deriving it, because by the time a `--continue` runs the branch may be gone and detection would be a guess. Only two literals ship: the detector's `main`/`master` probe, and a last-resort `"main"` fallback in `base_branch_of` that should become a refusal rather than a guess.

What is *not* yet built, should the base ever need to be a first-class choice rather than a CLI flag: the arc-lane skills never pass `--base`; the wire and the deck do not carry `base_branch`, so a card can neither show nor choose it; and the `off-base` blocker requires the checkout's HEAD to *equal* the base, which is correct for any base but tells the user nothing about which branch to check out. The natural shape is to surface `base_branch` on the arc entry and the create route, let `/arc` default the base to the checkout's current branch when that is not the default, and delete the fallback — a small arc, not a change to the flow drawn above.
