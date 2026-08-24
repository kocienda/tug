<!-- devise-skeleton v5 -->

## Dash Hardening — Conflicts as Data, Operations as a Log {#dash-hardening}

**Purpose:** Give the dash engine the two jj-derived properties named in `dash/dash-hardening-brief.md`, built natively on git with no new dependency: an append-only operation log with CAS-guarded `tugutil dash undo` for join/replay/discard, and unresolved join conflicts represented as durable commits under `refs/tug/conflict/` so the workshop becomes a rebuildable materialization instead of the sole holder of live `MERGE_HEAD` state.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-23 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-23, opus.** Reviewed `plan:099ca95e65804b81`. Lint: 0 errors, 1 warning (PL023, cleared by this section). Oriented on: the whole document — first pass. The review read the machinery the plan builds on rather than the plan's account of it: `replay.rs`'s `replay_onto` / `cas_reset` / `commit_remap`, `ops.rs`'s `finish_join_teardown` / `clear_candidate` call graph / config-key spellings, `resolve.rs`'s `patch_tree` and candidate-ref family, `workshop.rs`'s `open_merge` / `reset_to` / `release` / `ensure`, and `join_resolver.rs`'s two-opener resolve entry. Applied, in order of severity: **[P06]** — the conflict commit's tree was specified as the bare `merge-tree --write-tree` output, which would have discarded every file rungs 2–4 already resolved the moment Step 6 replaced `open_merge` (the current path applies them separately via `Workshop::apply_staged`); the tree is now built with the existing `patch_tree`, and Step 6 retires `apply_staged` from that path rather than orphaning it. **Spec S01 / [P03] / Step 3** — undo-of-replay was specified against "the recorded replayed head", but `ReplayOutcome::Replayed` can carry a `bookkeeping_commit` that `commit_remap` lands *after* `cas_reset`, so the branch tip is that commit and the CAS would have refused every replay-with-remap; `after.dash_tip` now records the final tip and the undo reads it. **Step 2** — recording was placed "before `cas_reset`", which the `Recorded` arm never reaches even though it mutates via `commit_remap`; there are now two record sites and an explicit no-record list for `Current` / `Conflicted` / `Deferred`. **Step 2/3** — `finish_join_teardown` receives only the journal, so the `--continue` path had no way to find its op; completion now discovers it as the newest incomplete op for the dash. **Step 4 / Risk R02** — `clear_candidate` has four callers, not three (the review found `tugcast/src/feeds/join_board.rs`), and R02 contradicted Step 4 by describing three wired sites where the design folds once; both corrected. **Step 6** — the deletion of `open_merge` was costed at zero; it has nine call sites, and the test fixtures change shape (a conflict ref must exist before a workshop can open one), so that migration is now tasks and the checkpoint says so. The `open_candidate` arm, which the plan never mentioned, is named as deliberately untouched. **Step 1** — `project_state_dir` writes are guarded by `refuse_unredirected_temp_repo` under debug assertions; the oplog now calls it and the tests set `ENV_DATA_DIR`. Also corrected a citation in Assumptions that pointed at [P08] for a claim [P03] owns, and pinned the plan-path config key by its real spelling (`.tugplan`). Asked and decided: what a *later* resolve inherits from a failed one, now [P11] — resume from checkpoints, the owner's call, since the candidate still faces `commit_candidate`'s three refusals before anything lands. Tuglaws cross-check: this is Rust-only work with no frontend state, so no State Zone Mapping applies and no React law is at risk; the load-bearing law is the derive-don't-declare rule in `tuglaws/dash-lifecycle.md`, which the plan honors — the conflict summary is computed from the ref at read time and [P07]'s validity is re-checked at every open rather than cached, the specific failure the blocker-caching doctrine exists to prevent. Test plan is at the right layer (Rust, tempdir-git fixtures, stub resolver seam) with no banned shapes. Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

A 2026-08-23 survey of `tugrust/crates/tugdash-core` (recorded in `dash/dash-hardening-brief.md`) found the dash engine has independently converged on most of Jujutsu's architecture — merges computed in memory via `merge-tree --write-tree` + `commit-tree`, candidates parked at `refs/tug/join/<name>`, dirt swept into commits before every integrate, teardowns journaled and resumable. Every remaining fragility sits where live working-tree state still participates, and two of jj's ideas close those gaps without adopting jj: **operations as a log** (today nothing reverses a landed join, a base-motion replay, or a discard — `branch -D` at teardown makes the dash's rounds unreachable, so even manual recovery is a reflog dig on a clock) and **conflicts as data** (today an in-flight conflict lives as `MERGE_HEAD` + index stages + markers in the workshop checkout, with documented wedge modes: the abort-then-reset choreography in `Workshop::reset_to`, the orphan-workshop race when a join tears down mid-verification, and the recorded-not-built-for race where a CLI `tugutil dash join` cannot see tugcast's in-process occupancy guard and destroys a resolve in flight).

The brief fixes the shape and the order: op log first, because it is pure addition and puts an undo net under the workshop surgery that follows. This plan decomposes both items into steps. jj adoption itself was considered and declined (jj workspaces are not git checkouts, which breaks the derive-from-git doctrine in `tuglaws/dash-lifecycle.md`); that decision is settled in the brief and not reopened here.

#### Strategy {#strategy}

- Build the op-log substrate as a new `oplog.rs` module in `tugdash-core`, then wire recording into the three mutating verbs, then build undo on top — three commits, each independently testable.
- Every undo is a compare-and-swap in the discipline `replay.rs::cas_reset` established: verify the world still matches the op's recorded after-state, act, or refuse with a stated reason. Never a force.
- Build the conflict-commit substrate next to the candidate machinery in `resolve.rs` (same ref-plus-config-facts idiom), then teach the ladder to write it, then rebuild the workshop on top of it, then give the resolver checkpoints. The `MERGE_HEAD`-free workshop lands only after the conflict ref is proven by the ladder path alone.
- All tests at the Rust layer in `tugdash-core`'s existing tempdir-git fixture style (see the test modules at the bottom of `ops.rs`, `replay.rs`, `resolve.rs`). No app-tests: nothing here has a UI surface, and the app-test workspace is transient (~2s) — the house pattern covers long-lived git flows at the Rust layer.
- Documentation rides the steps that create the behavior; `tuglaws/dash-lifecycle.md` gains the two new ref namespaces and the undo doctrine in the same step that ships the CLI verb.

#### Success Criteria (Measurable) {#success-criteria}

- After a join completes, the dash's pre-join head is still reachable: `git cat-file -e <old-dash-head>^{commit}` succeeds even though `tugdash/<name>` was deleted (Rust test, Step 2).
- `tugutil dash undo` after a join restores the world: base branch back at its pre-join tip, `tugdash/<name>` recreated at the recorded head, worktree present and hydrated, branch config facts (`tugbase`, `description`, `tugid`, plan path) restored (Rust tests, Step 3).
- Undo refuses with a stated reason when the base tip no longer matches the op's after-state, when the base checkout is dirty on affected paths, or when the op record is incomplete (Rust tests, Step 3).
- The oplog never exceeds its cap: recording the 51st op prunes the 1st, and the pruned op's keepalive ref is gone (Rust test, Step 1).
- A conflicted join produces a commit at `refs/tug/conflict/<name>` whose message parses back to the exact stage table `merge_tree_stages` computed, and whose parents are the base head and dash head (Rust tests, Steps 4–5).
- The workshop's `.git/MERGE_HEAD` never exists at any point in a conflict materialization — asserted by test during and after open (Rust test, Step 6).
- A resolve interrupted after k of n files were checkpointed resumes from the checkpoint, not from zero: destroy the workshop directory mid-resolve, re-open, and the k resolved files are already in the tree (Rust test at the workshop layer, Step 7).
- `cd tugrust && cargo nextest run` green with `-D warnings` throughout; `tugutil plan lint` exit 0 on this document.

#### Scope {#scope}

1. An append-only operation log: keepalive refs under `refs/tug/oplog/`, JSON payloads beside the join journal, recording wired into `join`, `replay`, and `discard`.
2. `tugutil dash undo [<name>]` and `tugutil dash undo --list`, with per-verb CAS-guarded reversal semantics.
3. A durable conflict representation: `refs/tug/conflict/<name>` commits written by the resolution ladder when files remain unresolved, exposed read-only through `dash status`/`show` JSON.
4. The workshop rebuilt as a materialization of the conflict ref — no `git merge --no-commit`, no `MERGE_HEAD`, one reset verb.
5. Resolver checkpoint commits on the conflict chain, and resume-from-checkpoint in tugcast's join resolver.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No jj dependency** — no `jj-lib`, no colocated repos. Settled in the brief; revisit only if jj workspaces gain functional git checkouts.
- **No change to the landing doctrine.** `main` never carries a conflict; squash stays the default shape; candidate-is-bytes-never-shape stands. A conflict commit lives under `refs/tug/`, outside `refs/heads/`, invisible to every branch-globbing surface.
- **No rerere changes.** Rung 2 and its teach-back (`record_rerere`) stay exactly as they are.
- **No UI work.** The shade and sheet read the derived facts they already read; the conflict summary lands in the existing `status`/`show` JSON only.
- **No new daemon, lock file, or on-disk registry.** Both features are refs plus files in `project_state_dir`, recovered by construction.
- **No fold of `join --continue` into the op log.** The join journal is proven machinery; folding it in is a candidate later step once the conflict work settles ([P10]).
- **No binding resurrection on undo.** Decided with the owner 2026-08-23: undo restores git state only; the restored dash reads as unbound until a session binds it again ([P04]).
- **No dirt claw-back on undo of discard.** Hand-backed files were copied into the base checkout, not moved; pulling files out of a user's checkout is what this engine never does. The undo report names the overlap instead ([P03]).

#### Dependencies / Prerequisites {#dependencies}

- git ≥ 2.38 (`merge-tree --write-tree`) and ≥ 2.40 (`--merge-base` flag) — both already probed by `git_supports_merge_tree` (`ops.rs`) and `git_supports_merge_base_flag` (`resolve.rs`); this plan adds no new version requirement.
- The existing tempdir-git test fixtures in `tugdash-core`'s test modules.
- `tugutil-core::paths::project_state_dir` for payload placement (the join journal's home).

#### Constraints {#constraints}

- Rust workspace enforces `-D warnings`; `cargo nextest run` must stay green at every step boundary.
- All git access goes through the crate's existing subprocess funnel (`git_output` / `git_stdout` in `ops.rs`) — no git2/gix, matching the crate's zero-git-library posture.
- Writable-ledger discipline does not apply (nothing here touches SQLite), but the shell-edit discipline does: any repo-file edits during implementation use `Edit`/`Write`/`tugutil file edit`.
- Refs written by this plan stay out of `refs/heads/` entirely — every dash surface globs `refs/heads/tugdash/`, and the workshop's own doc block records why namespace leakage renders phantom rows.

#### Assumptions {#assumptions}

- `git branch -D` removes the branch's `branch.<name>.*` config section, so the op payload must capture the facts to restore (verified against git behavior; the restore list is [P03]'s).
- The empty-tree oid for keepalive commits is obtained at runtime via `git hash-object -t tree /dev/null` rather than hard-coding the SHA-1 constant, so SHA-256 repositories keep working.
- Conflict counts per join are modest (tens of paths, not thousands) — the stage table rides in a commit message without size concern. Non-content conflicts already short-circuit in `RawStages::load`.
- `reconcile_ledger_cells`' remap round is committed *on the dash branch* (as `commit_remap`'s bookkeeping commit, a descendant of the replayed head), so undoing a replay by moving the branch back to the pre-replay tip also reverts the ledger rewrite — no reverse remap is needed ([P03]). Verified against `replay.rs`: `commit_remap` runs `add -A` + `commit` in the dash worktree, so the rewrite is an ordinary round on the branch, not out-of-band state.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The brief queued four questions for this devise round; all four were resolved during authoring: payload location is decided in [P01], resolver checkpoint granularity in [P09], binding restoration was asked of the owner 2026-08-23 and decided in [P04], and the `--continue` fold is deferred by decision in [P10].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Keepalive refs pin large histories against gc | low | med | 50-op cap pruned at record time ([P05]) | repo size complaints |
| Concurrent verbs race on oplog sequence numbers | med | low | create-only `update-ref` allocation loop ([P02]) | a duplicate-seq failure in the wild |
| Undo recreates a worktree whose hydration hooks fail | med | low | reuse the create path's hook runner and report hook failure without rolling back the branch restore ([P03]) | hook failures during undo tests |
| In-flight resolves during upgrade hold old-style `MERGE_HEAD` state | med | low | `open_existing` fallback sweep: a workshop with `MERGE_HEAD` and no conflict ref is released and rebuilt from the ref (Step 6) | first deploy |
| A conflict ref goes stale silently when base or dash moves | med | med | validity is strict head equality recorded in the payload; every open re-checks and rebuilds ([P07]) | staleness test failures |

**Risk R01: Undo of a join races a new commit on the base** {#r01-undo-base-race}

- **Risk:** Between the join and the undo, the user (or another session) commits on the base; resetting the base branch would destroy that work.
- **Mitigation:** The CAS refuses unless the base tip equals the op's recorded after-tip, verbatim — the same discipline as `cas_reset`, and `reset --keep` (not `--hard`) is the mover, so overlapping working-tree changes also refuse.
- **Residual risk:** An op made un-undoable by later work is permanent; the refusal names the newer tip so the user can decide by hand.

**Risk R02: The conflict chain and the candidate machinery disagree about lifecycle** {#r02-conflict-candidate-lifecycle}

- **Risk:** The conflict ref outlives its dash (the loose-ref-outlives-branch-config failure `clear_candidate` already exists to prevent for candidates), or a candidate lands while a stale conflict ref still advertises "conflicted".
- **Mitigation:** The conflict ref is cleared everywhere `clear_candidate` already runs — one lifecycle, not two — by folding the clear into that function once rather than wiring its four callers separately (Step 4). Step 4's test asserts the fold; the callers need no change and get none.
- **Residual risk:** A crash between candidate landing and release leaves the ref one `--continue` away from cleanup, same as today's candidate marks.

---

### Design Decisions {#design-decisions}

#### [P01] An op record is a keepalive ref plus an updatable JSON payload (DECIDED) {#p01-op-record-shape}

**Decision:** Each operation writes two halves: a ref `refs/tug/oplog/<seq>` pointing at a synthetic keepalive commit (empty tree, parents = every tip the operation moves or deletes), and a JSON payload file `oplog-<seq>.json` in `project_state_dir(repo)` — the join journal's directory — holding verb, dash name, before-values, and after-values.

**Rationale:**
- The ref is what makes undo *possible*: after it exists, `branch -D` and `reset` cannot strand the rounds.
- The payload must be written twice — before-values before the verb acts, after-values when it completes — and a commit message is immutable, so the mutable half lives as JSON. The brief asked for one location, not both; the split here is by role (reachability vs record), not duplication: no fact is stored in both places.
- JSON beside the join journal matches the established pattern (`join-journal-<name>.json`, `write_atomic`) and is greppable during incidents.

**Implications:**
- A payload with no after-values marks an operation that died mid-flight; undo refuses it with that reason (Spec S03).
- Pruning an op deletes both halves; the ref deletion is what finally lets gc collect — the honest meaning of "no longer undoable" ([P05]).

#### [P02] Sequence allocation is a create-only ref write in a retry loop (DECIDED) {#p02-seq-allocation}

**Decision:** The next sequence number is `max(existing) + 1` read via `for-each-ref refs/tug/oplog/`, claimed with `git update-ref refs/tug/oplog/<seq> <keepalive-sha> <empty>` — the empty old-value making the write create-only, so a lost race errors and the loop re-reads and retries (bounded, 10 attempts).

**Rationale:**
- Two verbs recording concurrently (the CLI-vs-tugcast pair the occupancy work documented) must not share a seq; git's ref transaction is the only lock the engine uses anywhere, and it is enough.

**Implications:**
- Seq numbers are zero-padded to six digits in the ref name so `for-each-ref` sort order is numeric order.

#### [P03] Undo semantics are per-verb, CAS-guarded, git-state-only (DECIDED) {#p03-undo-semantics}

**Decision:** `undo` reverses the most recent completed op (optionally the most recent for a named dash). Per verb — **join**: `reset --keep <before-base-tip>` run in the base checkout (refusing unless the current tip equals the recorded after-tip and `status --porcelain` shows no overlap), recreate `tugdash/<name>` at the recorded dash head via `git branch <branch> <sha>`, recreate the worktree via `git worktree add <path> <branch>` (no `-b` — the branch exists), re-run the create path's hydration hooks, restore the recorded branch config facts (`tugbase`, `description`, `tugid`, and the plan-path key), and write a dash-log line. **replay**: move the dash branch back to the recorded pre-replay tip with the existing `cas_reset`. **discard**: recreate branch, worktree, and config facts as for join's dash half; hand-backed dirt is not clawed back, and the undo report lists the handed-back paths still sitting in the base checkout.

**Rationale:**
- Every refusal states its reason — the never-fail-silently doctrine — and never forces: `reset --keep` refuses on overlapping working-tree changes by git's own semantics.
- Bindings and ink are live-session state; resurrecting them from a git verb would cross the derive-vs-declare boundary (owner-decided, [P04]).

**Implications:**
- The join op's payload must capture: base branch name and before/after tips, dash head, worktree path, the four config facts, and the landed commit hash (already in `JoinJournal`).
- Undo is itself recorded as an op (verb `undo`), so the log is a full history; undo of undo is out of scope and refused with a reason.

#### [P04] Undo does not restore session bindings (DECIDED) {#p04-no-binding-restore}

**Decision:** After `undo` of a join, the restored dash reads as unbound; rebinding is the user's gesture.

**Rationale:**
- Asked and answered by the owner 2026-08-23. Bindings live in per-instance `sessions.db` and are live-sessions-only by design (`bound_sessions_for`); a git verb writing session ledgers would blur the one boundary that has kept this machinery legible.

**Implications:**
- The undo report says so explicitly ("restored unbound — bind to resume piloting") so the state is announced, not discovered.

#### [P05] Retention is 50 ops per repo, pruned oldest-first at record time (DECIDED) {#p05-retention}

**Decision:** Recording an op prunes beyond the newest 50: payload file deleted, keepalive ref deleted.

**Rationale:**
- The join-journal pattern — no daemon, no cron; the writer sweeps. 50 covers weeks of real dash traffic while bounding pinned history.

**Implications:**
- The cap is a named constant (`OPLOG_CAP`) in `oplog.rs`, not config — a tuning knob nobody asked for is a surface nobody needs.

#### [P06] A conflict is a commit: merge-tree's tree, both heads as parents, the stage table in the message (DECIDED) {#p06-conflict-commit-shape}

**Decision:** When the ladder exhausts its rungs with paths still unresolved, it writes a commit whose tree is the `merge-tree --write-tree` output **with every blob the ladder's rungs already resolved patched in**, whose parents are `[base_head, dash_head]`, and whose message is a subject line `tugconflict(<name>): <k> unresolved` followed by a blank line and a JSON document: `{version, base_head, dash_head, paths: [{path, kind, stage1, stage2, stage3}], resolved: [{path, rung}]}` where each stage is `{oid, mode}` or null and `kind` is `content` / `delete-modify` / `binary` / `mode` (the `RawStages::load` classification). The ref `refs/tug/conflict/<name>` points at it.

**Rationale:**
- **The patched tree is the correction the review made, and it is load-bearing.** Rungs 2–4 (rerere, merge-file, driver) resolve real files before the ladder gives up on the rest; today that partial work reaches the workshop by a separate route — `Workshop::apply_staged(tree, paths)`, called right after `open_merge` in `join_resolver.rs`. A conflict commit carrying the *bare* merge-tree output would drop those resolutions on the floor the moment Step 6 makes the ref the only input, handing the resolver files the machine had already finished. Baking them in makes the commit the whole truth about the conflict.
- `patch_tree` in `resolve.rs` already performs exactly this operation (`read-tree` + `update-index --add --cacheinfo` + `write-tree`, all under `GIT_INDEX_FILE`) for candidates; the conflict tree reuses it rather than growing a second tree-patcher.
- The parents make provenance ancestry and keep both inputs reachable; the message makes the three-blob view recoverable by any process without re-running the merge.
- The idiom matches the candidate machinery (`candidate_ref_name`, `write_candidate_ref`, `anchor_candidate` in `resolve.rs`) — same crate, same funnel, same lifecycle owner.

**Implications:**
- The `resolved` array records which rung finished each pre-resolved path, so the resolver's context and the eventual audit can tell a machine resolution from its own. It mirrors the `tugjoinresolved` config marks, which stay as they are — the array is the copy that travels with the commit.
- `Workshop::apply_staged` loses its only caller when Step 6 lands and is deleted there, not left standing.
- The parser is the writer's inverse and both are unit-tested against each other (round-trip test, Step 4).
- The subject prefix `tugconflict(` is how the chain root is recognized when walking back from checkpoints ([P09]).

#### [P07] Conflict validity is strict head equality, re-checked at every open (DECIDED) {#p07-conflict-validity}

**Decision:** A conflict commit is valid iff `rev-parse <base_branch>` equals its recorded `base_head` and `rev-parse tugdash/<name>` equals its recorded `dash_head`. Any open (ladder, workshop, status read) that finds either moved treats the ref as stale: clears it and, where the caller is the ladder, rebuilds it fresh.

**Rationale:**
- Base motion or a new round invalidates the merge the tree encodes; equality is cheap, unambiguous, and refuses the ancestry subtleties that made candidate staleness need the `join-pipeline-truth` correction.

**Implications:**
- Checkpoints inherit validity from their root — a stale root invalidates the whole chain, and in-progress resolution work on a stale chain is reported as discarded, never silently kept.

#### [P08] The workshop materializes the conflict ref; MERGE_HEAD never exists (DECIDED) {#p08-workshop-materializes}

**Decision:** `Workshop::open_merge` (which runs `git merge --no-commit --no-ff` and parks live merge state) is replaced by `Workshop::open_conflict(repo, name)`, which resets the workshop worktree to the conflict chain's tip — markers already in the tree. `reset_to`'s `merge --abort`-then-`reset --hard` choreography collapses to the reset alone; `release()` likewise. The `unresolved()` index-stage read is replaced by a marker scan against the conflict payload's path list (the commit path's marker-scan refusal already exists in `Workshop::commit`).

**Rationale:**
- This is the plan's center: the conflict stops being fragile process state. A crash, a tugcast restart, or a CLI teardown can remove the *worktree*; the conflict and its checkpoints survive in the ref and re-materialize on the next open.

**Implications:**
- The index in a materialized workshop is always stage-0 (the reset's), so `commit_candidate`'s stages-clean refusal becomes structurally unreachable there — it stays as a belt against drift.
- `open_existing` gains a one-time fallback for upgrades: a workshop holding `MERGE_HEAD` with no conflict ref is released and rebuilt (Risk table).

#### [P09] Resolver checkpoints are one commit per turn that touched files, on the conflict chain (DECIDED) {#p09-checkpoint-granularity}

**Decision:** After each resolver turn whose diff against the chain tip is non-empty (`touched_since`), the orchestrator commits the workshop tree as a child of the chain tip with subject `tugresolve(<name>): checkpoint` and advances `refs/tug/conflict/<name>` to it. The chain root is found by walking first parents to the `tugconflict(` subject.

**Rationale:**
- Per-turn is the natural boundary the resolver loop already has (Spec S04 turn protocol in `join_resolver.rs`); per-file would require knowing when a file is "done", which only the marker scan answers — and it answers per turn anyway.

**Implications:**
- Resume is: open the workshop at the chain tip; the resolver's opening context lists which payload paths still carry markers. A turn that resolves nothing adds no commit.
- `clear_candidate` clears the conflict ref too, so a landed join releases the whole chain in the release beat it already owns.

#### [P10] The join journal stays parallel to the op log this round (DECIDED) {#p10-journal-stays}

**Decision:** `join --continue` keeps its own journal; the op log records around it. Folding the journal into the op log is deliberately deferred to a later round.

**Rationale:**
- The journal is proven crash machinery with its own tests; rebasing it mid-plan couples the two features' risk. The brief's own recommendation.

**Implications:**
- A join op's payload duplicates nothing from the journal: the journal is the *forward* resume record, the op the *reverse* one; they are cleared at different moments (journal at teardown end, op never — it just ages out).

#### [P11] A failed resolve keeps its checkpoints; a later resolve resumes from them (DECIDED) {#p11-failed-resolve-keeps-checkpoints}

**Decision:** When a resolve fails — deadline expiry, wedge, crash — the conflict chain and its checkpoints stand, and the next resolve opens at the chain tip and continues from there. `Workshop::release()` on the failure path parks the workshop at the chain tip rather than resetting it to the base head.

**Rationale:**
- Owner-decided 2026-08-23, after the review raised it: durability is the whole point of [P06], and a design that made conflicts durable but then threw the resolution work away on every timeout would keep the expensive half of the old behavior.
- The safety argument for discarding is already covered downstream: nothing a resumed resolve inherits can land without passing `commit_candidate`'s three refusals (markers, index stages, report accounting for every path in the resolution set) and the human audit.
- It also settles what `release()` means now. Its current doc rationale — that a marker-carrying tree "reads as wreckage" and "blocks nothing that would help" — was written when the markers were untracked working-tree state with a live `MERGE_HEAD` beside them. Under [P08] they are a committed, named, auditable chain, which is the opposite of wreckage.

**Implications:**
- `release()`'s doc comment in `workshop.rs` and the failure-path comment in `join_resolver.rs` are rewritten in Step 7 to say this; neither is left describing the old contract.
- The stuck fact (`write_stuck`) keeps its role and now names the chain tip, so a reader learns how far the failed run got.
- A stale chain is still discarded wholesale by [P07] — resuming applies to a *valid* chain only.

---

### Specification {#specification}

**Spec S01: Op payload schema** {#s01-op-payload}

```json
{
  "version": 1,
  "seq": 17,
  "verb": "join" | "replay" | "discard" | "undo",
  "dash": "<name>",
  "recorded_at": "<iso8601>",
  "before": {
    "base_branch": "main",
    "base_tip": "<sha>",
    "dash_tip": "<sha>",
    "worktree": "<abs path>",
    "config": {"tugbase": "…", "description": "…", "tugid": "…", "plan": "…"},
    "candidate": "<sha or null>"
  },
  "after": {
    "base_tip": "<sha>",
    "dash_tip": "<sha>",
    "landed_commit": "<sha or null>",
    "mapping": [["<old-round>", "<new-round>"], "…(replay only)"],
    "handed_back": ["<path>", "…(discard only)"]
  },
  "undone_by": 23
}
```

`after` is absent until the verb completes ([P01]); `undone_by` is written by a later undo op. Fields irrelevant to a verb are omitted, `serde` defaulted on read.

**`after.dash_tip` is the branch tip the verb actually left, read back with `rev-parse` at completion — never reconstructed.** The review found the reason: `replay_onto`'s `Replayed` arm runs `cas_reset` to the replayed head and *then* `reconcile_ledger_cells` can land a further round through `commit_remap` (surfaced as `ReplayOutcome::bookkeeping_commit`). So the branch tip after a replay is the bookkeeping commit whenever the plan ledger had cells to rewrite, and the last entry of `mapping` is one commit short of it. An undo whose CAS expected the mapping's tail would refuse every remapped replay with `tip-moved` — a guard that fires on the ordinary case. Reading the tip back removes the whole class.

**Spec S02: Conflict commit message** {#s02-conflict-message}

Subject `tugconflict(<name>): <k> unresolved`, blank line, then the JSON of [P06]. The writer serializes from the same `RawStages` values `merge_tree_stages` parsed; the reader is its inverse; a round-trip property test pins them together. Checkpoint commits carry subject `tugresolve(<name>): checkpoint` and no JSON.

**Spec S03: Undo refusal reasons** {#s03-undo-refusals}

Every refusal is `Err` with one of these stated shapes, never a silent no-op: `nothing-to-undo` (no completed op matches), `already-undone` (payload carries `undone_by`), `incomplete-op` (no `after` — the verb died mid-flight; names the seq), `tip-moved` (current tip ≠ recorded after-tip; names both), `base-dirty` (`reset --keep` refused; names the paths), `branch-exists` (undo of join/discard finds `tugdash/<name>` already recreated), `undo-of-undo` (refused by decision, [P03]).

**Spec S04: CLI surface** {#s04-cli-surface}

`tugutil dash undo [<name>] [--list] [--json]`. Bare `undo` targets the newest completed, not-undone op; with `<name>`, the newest such op for that dash. `--list` prints the log (seq, verb, dash, when, undoable-or-why-not) and mutates nothing. Wired as `DashCommands::Undo` in `tugutil/src/cli.rs` (the `enum DashCommands`), dispatched in `tugutil/src/dash.rs`'s match alongside `Replay`/`Discard`, with `run_undo` following `run_replay`'s outcome-printing pattern.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugdash-core/src/oplog.rs` | Op record substrate: seq allocation, keepalive commits, payload IO, prune, undo executor |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `OPLOG_CAP` | const | `oplog.rs` | 50 ([P05]) |
| `OpVerb`, `OpPayload`, `OpBefore`, `OpAfter` | enum/structs | `oplog.rs` | Spec S01, serde round-trip |
| `record_begin`, `record_complete` | fn | `oplog.rs` | the two payload writes ([P01]); `record_begin` allocates seq + keepalive ref ([P02]) and prunes |
| `undo_in`, `list_ops` | fn | `oplog.rs` | Spec S03/S04 semantics |
| `conflict_ref_name`, `write_conflict_commit`, `read_conflict`, `clear_conflict`, `conflict_is_valid` | fn | `resolve.rs` | [P06], [P07]; beside the candidate ref family |
| `ConflictRecord`, `ConflictPath` | structs | `resolve.rs` | Spec S02 payload |
| `Workshop::open_conflict` | fn | `workshop.rs` | replaces `open_merge` ([P08]); nine call sites migrate |
| `Workshop::apply_staged` | fn (deleted) | `workshop.rs` | its work moves into the conflict tree ([P06]) |
| `Workshop::checkpoint` | fn | `workshop.rs` | commit-and-advance for [P09] |
| `Workshop::release` | fn (modified) | `workshop.rs` | parks at the chain tip, not `base_head` ([P11]) |
| `DashCommands::Undo` | enum variant | `tugutil/src/cli.rs` | Spec S04 |
| `run_undo` | fn | `tugutil/src/dash.rs` | Spec S04 |
| conflict summary fields | struct fields | `ops.rs` (`DashStatus`/`DashDetail`) | read-only derive: `conflicted`, `paths_total`, `paths_resolved` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/dash-lifecycle.md`: add the `refs/tug/oplog/` and `refs/tug/conflict/` namespaces to the ref inventory, and a short undo-doctrine paragraph (CAS-guarded, git-state-only, [P04]).
- [ ] `dash/dash-hardening-brief.md` stays as the rationale record; no edits needed.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Payload/message round-trips, seq allocation, refusal reasons | Steps 1, 3, 4 |
| **Integration** | Verb → record → undo → assert world, in tempdir git repos via the crate's existing fixture style | Steps 2, 3, 5, 6, 7 |
| **Drift Prevention** | Reachability after teardown; MERGE_HEAD-absence invariant; cap enforcement | Steps 2, 6, 1 |

#### What stays out of tests {#test-non-goals}

- App-tests — nothing here has a UI surface; the status JSON additions are covered by Rust serialization tests, and the app-test workspace's ~2s transience makes it the wrong layer for multi-step git lifecycles (established house pattern).
- The AI resolver's model behavior — the checkpoint/resume machinery is tested with the stubbed resolver seam (`tugdash.joinresolver` config) that `join_resolver.rs` already provides; real-`claude` runs stay on-demand.
- Concurrent multi-process races beyond the seq-allocation loop — the create-only ref write is the primitive under test; a full two-process stress harness is not worth the flake surface.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Op-log substrate | pending | — |
| #step-2 | Record join, replay, discard | pending | — |
| #step-3 | Undo core and CLI | pending | — |
| #step-4 | Conflict-commit substrate | pending | — |
| #step-5 | Ladder writes the conflict ref | pending | — |
| #step-6 | Workshop materializes the ref | pending | — |
| #step-7 | Resolver checkpoints and resume | pending | — |
| #step-8 | Integration checkpoint | pending | — |

#### Step 1: Op-log substrate {#step-1}

**Commit:** `tugdash(dash-hardening): add the operation log substrate`

**References:** [P01] op record shape, [P02] seq allocation, [P05] retention, Spec S01, (#s01-op-payload, #strategy)

**Artifacts:**
- New `tugrust/crates/tugdash-core/src/oplog.rs`, registered in `lib.rs`.

**Tasks:**
- [ ] `OpVerb`/`OpPayload`/`OpBefore`/`OpAfter` per Spec S01, serde with defaults so older payloads read forward.
- [ ] `record_begin(repo, verb, dash, before, tips) -> Result<u64, String>`: obtain the empty-tree oid via `git hash-object -t tree /dev/null`, build the keepalive with `commit-tree <empty> -p <tip>… -m "tug oplog <seq> <verb> <dash>"`, allocate the seq with the create-only `update-ref` retry loop ([P02]), write `oplog-<seq>.json` via the crate's `write_atomic`, prune past `OPLOG_CAP` ([P05]).
- [ ] `record_complete(repo, seq, after)`: read payload, attach `after`, rewrite atomically.
- [ ] `list_ops(repo)` newest-first, tolerating a payload whose ref was hand-deleted and vice versa (report, don't panic).
- [ ] Call `refuse_unredirected_temp_repo(repo)` before any `project_state_dir` write, exactly as `append_dash_log` in `dash.rs` does. It is the debug-assertions guard that stops a tempdir repo's state from landing in the live data directory; a new writer to that directory that skips it is the one way this plan could scribble on a developer's real `~/Library/Application Support/Tug`.

**Tests:**
- [ ] Payload round-trip including omitted per-verb fields.
- [ ] Every test in this plan that writes an op sets `tugcore::instance::ENV_DATA_DIR` to a scratch path (cargo sets it per test process, but assert the guard is wired by exercising `record_begin` against a tempdir repo).
- [ ] Two interleaved `record_begin` calls in one repo get distinct seqs (drive the race by pre-creating the ref the first read would claim).
- [ ] Recording op 51 prunes op 1: payload gone, `refs/tug/oplog/000001` gone.
- [ ] Keepalive parents: a tip passed to `record_begin` remains `cat-file -e`-reachable after its branch is deleted.

**Checkpoint:** `cd tugrust && cargo nextest run -p tugdash-core` green; the new module compiles under `-D warnings`.

#### Step 2: Record join, replay, discard {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(dash-hardening): record join, replay, and discard in the op log`

**References:** [P01] op record shape, [P03] undo semantics (payload contents), [P10] journal stays, Spec S01, (#p03-undo-semantics)

**Artifacts:**
- Recording calls in `ops.rs::join_in_with_progress`, `replay.rs::replay_onto` (two sites — see Tasks), and `ops.rs::discard_in`.

**Tasks:**
- [ ] Capture `before.config` by reading the four keys — `branch.tugdash/<name>.tugbase`, `.description`, `.tugid` (`tugid_config_key`), and `.tugplan` (`plan_config_key`, what `dash_plan_path` reads) — before any mutation. Note these keys are built from the **raw** dash name, while `worktree_path` sanitizes; copy the existing key builders rather than composing new strings.
- [ ] **Join:** `record_begin` after the preflights pass and after `commit_worktree_dirt`, immediately before the integrate. The ordering is deliberate and mirrors the `tugjoinsource` lesson recorded in `resolve.rs` — a `before.dash_tip` read *before* the dirt sweep would omit the sweep commit, so an undo would restore a dash missing the work the sweep captured.
- [ ] **Join completion:** `record_complete` inside `finish_join_teardown` after the dash-log line. That function receives only the `JoinJournal`, which carries no sequence number, and it is also the `--continue` entry point — so it finds its op by querying the newest **incomplete** op for this dash rather than by being handed a seq. A `--continue` that finds none completes the teardown and warns; the op is already in the `incomplete-op` state Spec S03 refuses honestly.
- [ ] **Replay, two sites:** `replay_onto` mutates in two arms and returns before `cas_reset` in one of them. Record in the `Recorded` arm before `reconcile_ledger_cells`, and in the `Clean` arm before `cas_reset` (which is where the pre-replay rounds stop being reachable, so the keepalive must precede it). Record **nothing** for `Current`, `Conflicted`, and `Deferred` — every one of those paths leaves the repository exactly as it found it, as `replay_onto`'s own contract states, and an op record for a no-op is a lie the undo list would have to explain.
- [ ] **Discard:** `record_begin` before `apply_hand_back`; `after.handed_back` lists the copied paths.
- [ ] All three completions read `after.dash_tip` (and `after.base_tip`) back with `rev-parse` rather than reusing a value computed earlier (Spec S01).
- [ ] A `record_begin` failure aborts the verb with the error — an operation the log cannot hold must not run half-recorded.
- [ ] A `record_complete` failure downgrades to a warning in the verb's existing warnings vector — the verb finished; the payload just lacks `after`, which Spec S03's `incomplete-op` refusal already handles honestly.

**Tests:**
- [ ] Join in a fixture repo: payload exists with verb `join`, before/after tips correct, and the pre-join dash head is reachable after teardown deleted the branch.
- [ ] Join with dirt in the dash worktree: `before.dash_tip` is the sweep commit, not its parent.
- [ ] Replay of a dash whose plan ledger has cells to rewrite: `after.dash_tip` equals the bookkeeping commit and differs from the last `after.mapping` entry — the exact case that would break undo.
- [ ] Replay that returns `Current`: no op recorded.
- [ ] Discard: `after.handed_back` names the handed-back file.

**Checkpoint:** `cargo nextest run -p tugdash-core` green, including the pre-existing join/replay/discard suites unmodified in behavior.

#### Step 3: Undo core and CLI {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(dash-hardening): tugutil dash undo — CAS-guarded reversal of join, replay, and discard`

**References:** [P03] undo semantics, [P04] no binding restore, Spec S03, Spec S04, Risk R01, (#s03-undo-refusals, #s04-cli-surface, #r01-undo-base-race)

**Artifacts:**
- `oplog.rs::undo_in(repo, dash: Option<&str>) -> Result<UndoOutcome, String>`; `DashCommands::Undo` in `tugutil/src/cli.rs`; `run_undo` in `tugutil/src/dash.rs`; `tuglaws/dash-lifecycle.md` additions per the Documentation Plan.

**Tasks:**
- [ ] Selection: newest completed, not-undone op (filtered by dash when named); every non-match reason from Spec S03 is a distinct refusal string.
- [ ] Undo join per [P03]: `reset --keep` in the base checkout guarded by tip equality and `status --porcelain`; `git branch <branch> <dash_tip>`; `git worktree add <worktree> <branch>`; hydration via the existing `run_post_create`, its failure reported but not fatal to the restore; config facts written back; dash-log line `undone-join`; mark the op `undone_by` and record the undo as its own op.
- [ ] Undo replay: reuse `cas_reset(worktree, expected_tip, head)` with `expected_tip = after.dash_tip` (the tip the replay actually left, bookkeeping commit included — Spec S01) and `head = before.dash_tip`. `cas_reset` returns `Ok(Some(ReplayOutcome::Deferred{…}))` on refusal rather than `Err`, so map its two refusal reasons (`dirty-worktree`, `tip-moved`) onto Spec S03's vocabulary instead of discarding them.
- [ ] Undo discard: branch + worktree + config restore; report lists `after.handed_back` paths as still-present base dirt.
- [ ] `--list` output and `--json` per the crate's existing outcome-serialization pattern (`run_replay` is the model).

**Tests:**
- [ ] Join → undo: base tip, branch tip, worktree presence, and all four config facts asserted restored; binding not asserted (none exists — [P04]).
- [ ] Refusals: commit on base after join → `tip-moved` naming both tips; dirty base overlap → `base-dirty`; second undo of same op → `already-undone`; op without `after` → `incomplete-op`.
- [ ] Replay (with a ledger remap, so a bookkeeping commit exists) → undo → branch tip equals the pre-replay tip and the remap bookkeeping commit is no longer reachable from the branch.
- [ ] Discard → undo → dash restored, handed-back file still in base checkout untouched.

**Checkpoint:** `cargo nextest run -p tugdash-core -p tugutil` green; `tugutil dash undo --list` in a fixture repo prints the recorded ops.

#### Step 4: Conflict-commit substrate {#step-4}

**Depends on:** #step-1

**Commit:** `tugdash(dash-hardening): conflict commits — durable stage tables under refs/tug/conflict`

**References:** [P06] conflict commit shape, [P07] validity, Spec S02, Risk R02, (#p06-conflict-commit-shape, #s02-conflict-message)

**Artifacts:**
- `ConflictRecord`/`ConflictPath` and the `conflict_ref_name` / `write_conflict_commit` / `read_conflict` / `clear_conflict` / `conflict_is_valid` family in `resolve.rs`, beside the candidate ref family.

**Tasks:**
- [ ] `write_conflict_commit`: `commit-tree <merge-tree-oid> -p <base_head> -p <dash_head>` with the Spec S02 message, then `update-ref` the conflict ref; inputs are the tree oid and stage table `merge_tree_stages` already produces.
- [ ] `read_conflict`: resolve the ref, walk first parents to the `tugconflict(` subject root, parse the JSON, return record + chain tip.
- [ ] `conflict_is_valid`: strict equality per [P07]; a helper the ladder and workshop share.
- [ ] `clear_conflict` folded into `clear_candidate` **once**, so every existing caller clears both with no per-site wiring. There are four, and the review checked them: `ops.rs`'s teardown release beat and its discard path, `resolve.rs`'s partial-outcome cleanup, and `tugcast/src/feeds/join_board.rs`. Fold into `clear_candidate` itself, **not** into `clear_candidate_marks` — the marks function is also called on its own from two places in `resolve.rs` that must not drop a live conflict ref.

**Tests:**
- [ ] Round-trip: write from a real conflicted fixture merge, read back, stage table identical (oids, modes, kinds).
- [ ] Validity flips false when a new round lands on the dash; flips false when the base advances.
- [ ] `clear_candidate` removes the conflict ref.

**Checkpoint:** `cargo nextest run -p tugdash-core` green.

#### Step 5: Ladder writes the conflict ref {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(dash-hardening): the ladder parks unresolved conflicts as conflict commits`

**References:** [P06] conflict commit shape, [P07] validity, Spec S02, (#context, #p07-conflict-validity)

**Artifacts:**
- `resolve_ladder` writes the conflict commit when its rung walk ends with unresolved paths; `status_in`/`dash_detail_entries_in` in `ops.rs` gain the read-only conflict summary (`conflicted`, `paths_total`, `paths_resolved` — resolved meaning checkpointed-clean, 0 until Step 7 exists).

**Tasks:**
- [ ] At the ladder's unresolved exit: clear any stale ref ([P07]) and write the fresh conflict commit from the stages it already holds; the resolved-rung config marks (`tugjoinresolved`) are unchanged.
- [ ] On a *fully* resolved ladder run, clear any conflict ref for the dash — a candidate and a live conflict must not coexist (Risk R02).
- [ ] Status derive: the summary computes from `read_conflict` + `conflict_is_valid` + a marker scan of the chain tip's tree against the payload paths, and is absent (not zeroed) when no valid ref exists — derive, never declare.

**Tests:**
- [ ] A conflicted `resolve_conflicts` run leaves a valid conflict ref whose paths equal the ladder's unresolved set.
- [ ] A clean run leaves no ref; a run after base motion replaces the stale ref.
- [ ] `status_in` JSON carries the summary iff the ref is valid.

**Checkpoint:** `cargo nextest run -p tugdash-core` green; existing ladder suites unmodified in behavior.

#### Step 6: Workshop materializes the ref {#step-6}

**Depends on:** #step-5

**Commit:** `tugdash(dash-hardening): the workshop materializes conflict commits — MERGE_HEAD retired`

**References:** [P08] workshop materializes, [P07] validity, Risk R02, (#p08-workshop-materializes)

**Artifacts:**
- `Workshop::open_conflict` replacing `open_merge`; `reset_to` collapsed to the single reset verb; `unresolved()` re-based on the marker scan; the `open_existing` upgrade fallback; `apply_staged` deleted ([P06]); the nine `open_merge` call sites migrated.

**Tasks:**
- [ ] `open_conflict(repo, name)`: validity check ([P07]) then `reset --hard <chain-tip>` + `clean -fd` (never `-x`, preserving warm build state — the existing rule) in the stable workshop worktree. Keep `ensure`'s guard that refuses when `tugdash/<name>` no longer exists; that refusal is what closed the orphan-workshop straggler and nothing here should weaken it.
- [ ] Delete the `merge --no-commit` path and the `merge --abort` call inside `reset_to`; `MERGE_HEAD` is never created, so aborting it is dead code — remove, don't keep-and-skip.
- [ ] Delete `apply_staged` and its call in `join_resolver.rs`: with [P06] the ladder's resolutions are already in the conflict commit's tree, so applying them again is a no-op path with a live caller — exactly the shape that rots.
- [ ] **Leave the `open_candidate` arm alone.** `join_resolver.rs` chooses its opener by join shape: a `Replay`-shaped outcome inherits `candidate_commit` and opens with `open_candidate`, and only the `Squash` arm opens a conflicted tree. This plan changes the second arm only; the first neither has nor needs a conflict ref, and a reader who assumes every open becomes `open_conflict` will break the replay shape.
- [ ] `open_existing` fallback: `MERGE_HEAD` present with no valid conflict ref → release and rebuild from the ref (or refuse with the stale-conflict reason when no ref exists).
- [ ] Migrate the existing `open_merge` call sites — six in `workshop.rs`'s own test module, two in `join_resolver.rs`'s, one in `join_board.rs`'s. **The fixture shape changes:** `open_merge` manufactured the conflict itself by merging, so a test needed only a conflicting dash; `open_conflict` requires a conflict commit to already exist, so each fixture must first run the ladder (or call `write_conflict_commit` directly with the stages from `merge_tree_stages`). Add one shared test helper for that rather than nine hand-rolled setups.

**Tests:**
- [ ] Invariant test: `.git/MERGE_HEAD` (in the workshop's gitdir) absent immediately after open, after an edit, and after `commit`.
- [ ] Destroy-and-reopen: remove the workshop directory wholesale mid-"resolve" (files edited, not committed), `open_conflict` again → tree equals chain tip; the uncommitted edits are the acknowledged loss window.
- [ ] A conflict whose ladder resolved some files: the opened workshop has no markers in the rung-resolved paths and markers only in the unresolved ones — the [P06] regression guard.
- [ ] Upgrade fallback: hand-construct a `MERGE_HEAD` workshop, open, assert rebuild.

**Checkpoint:** `cargo nextest run -p tugdash-core -p tugcast` green, including the nine migrated call sites; `grep -rn 'open_merge\|apply_staged' tugrust/crates` returns nothing.

#### Step 7: Resolver checkpoints and resume {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast(dash-hardening): resolver checkpoints on the conflict chain, resume from the tip`

**References:** [P09] checkpoint granularity, [P11] failed resolves keep checkpoints, [P07] validity, Spec S02, (#p09-checkpoint-granularity, #p11-failed-resolve-keeps-checkpoints)

**Artifacts:**
- `Workshop::checkpoint(message)` (commit child of chain tip + advance the ref); the resolver orchestrator in `tugcast/src/feeds/join_resolver.rs` checkpointing after each touching turn and opening from the chain tip; the Step 5 status summary now reporting real `paths_resolved`.

**Tasks:**
- [ ] `checkpoint`: `add -A`, refuse on markers *outside* the payload's still-unresolved set (a marker in an unlisted file is drift, not progress), `write-tree`/`commit-tree` parented on the chain tip, `update-ref` advance — the `Workshop::commit` pattern with a different parent and subject (Spec S02's `tugresolve(` form).
- [ ] Orchestrator: after each turn, `touched_since(chain_tip)` non-empty → checkpoint; the resolver's opening context enumerates payload paths still carrying markers at the tip, so a resumed resolve starts with only the remainder.
- [ ] Expired/failed resolves leave the chain in place and a later resolve resumes from it ([P11]). Change `release()` to park at the chain tip rather than reset to `base_head`, and rewrite both doc comments that still describe the old contract: `release()`'s in `workshop.rs`, and the failure-path comment in `join_resolver.rs` that reasons about "a live `MERGE_HEAD`" and a tree that "reads as wreckage" — neither is true once conflicts are committed, and a stale rationale outlives the code it explains.
- [ ] The stuck fact (`write_stuck`) names the chain tip so a reader learns how far the failed run got.

**Tests:**
- [ ] Stub-resolver run that resolves 1 of 2 files in turn one: chain gains one checkpoint; kill the run; a fresh run's opening context names only the second file; final candidate lands from the chain.
- [ ] A failed resolve (forced error after one checkpoint) leaves the chain tip at that checkpoint, not at the conflict root — the [P11] guard.
- [ ] A turn that touches nothing adds no commit.
- [ ] Checkpoint refusal on an out-of-set marker file.

**Checkpoint:** `cargo nextest run -p tugdash-core -p tugcast` green.

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-3, #step-7

**Commit:** N/A (verification only)

**References:** [D149] verify the fit, (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <this-dash>` — replay the rounds onto the live base.
- [ ] On `Replayed`/`Recorded`: run the declared verify over the replayed range — `sh scripts/verify-fit.sh {base} {head}` in the warm worktree.
- [ ] On `Current`: nothing re-runs; the last step's checkpoint verified the deliverable byte for byte.
- [ ] On `Conflicted`: resolve in the warm worktree as ordinary work, commit as a round, re-run.

**Tests:**
- [ ] N/A — this step verifies the fit; the work was tested in its steps.

**Checkpoint:** The replay outcome is `Current`/`Replayed`/`Recorded` with the declared verify green over whatever moved.

---

### Deliverables {#deliverables}

- The op log and `tugutil dash undo` (Steps 1–3): every join, replay, and discard reversible within the retention window, refusals stated, rounds never stranded.
- Conflicts as durable data (Steps 4–7): a conflicted join survives crashes, restarts, and worktree teardown as a commit chain under `refs/tug/conflict/<name>`; the workshop is a materialization; the resolver resumes from checkpoints.
- `tuglaws/dash-lifecycle.md` updated with the two ref namespaces and the undo doctrine.
