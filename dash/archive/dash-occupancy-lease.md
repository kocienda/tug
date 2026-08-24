## Dash occupancy lease {#dash-occupancy-lease}

**Purpose:** Close the R03 race from `dash/archive/join-hardening.md` — a `tugutil dash join` or `discard` running in its own process cannot see tugcast's in-process occupancy guard and can tear a workshop down under a live resolve — by deriving resolver liveness from the conflict chain itself: the chain's tip commit, its subject, and its committer age are a lease any process can read from git alone, with no registry, no lock file, and no daemon.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-24 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-24, opus.** Reviewed `plan:c1a735e18fbf131b`. Lint: 0 errors, 1 warning (the absent Review Record, fixed by this section).
Oriented on: the first pass over a never-reviewed plan, read against `tugdash-core/src/{ops,resolve,workshop,oplog}.rs`, `tugcast/src/feeds/{join_resolver,join_board,join_occupancy,agent_supervisor}.rs`, and `tugutil/src/dash.rs`.
Applied: a **third cross-process door** the plan missed — `tugutil dash join --resolve` (`run_join_resolve` in `tugutil/src/dash.rs`) runs `resolve::resolve_conflicts_cwd` *before* it ever reaches `ops::join`, and the ladder's partial-outcome arm calls `clear_candidate`, which folds `clear_conflict` and destroys a live chain; a lease check inside `join_in_with_progress` fires far too late on that path. Scope, [P03], [P06], Step 3 and Step 4 now close it at the CLI boundary, which is the only door the in-process guard does not already cover. Technical choice — `join_blockers_from_detail` does not have the three-argument signature the plan described: it takes a fourth parameter, `joining: bool`, and that parameter *is* the shipped idiom for occupancy-aware blocker suppression, so [P05] no longer filters the blocker in `join_board.rs` after the fact but widens `joining` to `held: Option<&str>` (exactly what `join_occupancy::run_kind` returns), which carries strictly more information and keeps one truth in one place. Correctness — the execute-path refusal was placed after `commit_worktree_dirt`, so a refused join would have committed a round first; moved above the sweep, beside the base-dirt refusal, so the refusal genuinely touches nothing ([L28]). Correctness — `mark_resolve_ended` would have appended an `end` marker to a chain the ladder parked and no resolver ever began (the audit-shaped resolve opens `open_candidate` and has no chain), so Spec S01 now writes an end marker only over a tip that is itself a `tugresolve(` commit, which also makes a double end idempotent. [L31] — the refusal sentence named only `--break-lease`, a door no Session card user can open, so it now names resolving again as well; the card's Resolve arm runs the ladder, which clears the chain and starts fresh. Test plan — the aged-out ops-layer case cannot inject `now` (the ops path calls `SystemTime::now()`), and `git_output` carries no environment, so Step 3 now names the mechanism: a raw `std::process::Command` with `GIT_COMMITTER_DATE`.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

`tugrust/crates/tugcast/src/feeds/join_occupancy.rs` is a process-global `HashMap` behind a `Mutex`: every act that touches a dash's workshop inside tugcast — a resolve, the join pilot, a non-preview join, a discard — takes the dash first and is refused by name (`"a resolve is already running for this dash"`) while another holds it. Its module doc says why it is in memory: an on-disk lock would need staleness detection, and a tugcast restart is both the only event that orphans a run and the event that releases every hold. That reasoning is right and stays.

What it cannot cover is a **second process**. `tugutil dash join <name>` and `tugutil dash discard <name>` run `tugdash_core::ops::join_in_with_progress` / `discard_in` from the CLI, and both tear the workshop down at their release beat — `crate::resolve::clear_candidate(repo_root, name)` followed by `crate::workshop::remove(repo_root, name, &mut warnings)`, in `join_in_with_progress`'s `JoinPhase::WorktreeRemoved` arm and again in `discard_in`. A resolver mid-turn in that workshop loses its checkout, and the next thing it does fails. `dash/archive/join-hardening.md` recorded this as Risk R03, accepted because nothing durable then described a resolve in flight.

That changed with the conflict chain (`1ca5e225e`) and its keepalive (`dash/dash-hardening-2.md`, landed as `42ac1eb0b`). A resolve is now a chain of ordinary commits at `refs/tug/conflict/<name>`: a root commit whose subject starts with `tugconflict(` and whose body is the JSON `ConflictRecord`, and resolver checkpoints as its children, each written by `Workshop::checkpoint` with the subject `tugresolve(<dash>): checkpoint` from `checkpoint_turn` in `join_resolver.rs`. `read_conflict` walks first parents from the ref to the root and returns `ConflictChain { tip, root, record }`. The oplog's `capture_before` already records the chain tip in `OpBefore.conflict`, `tips_of` parents the keepalive on it, and `undo` restores the ref (`restore_conflict_ref`) unless a newer one stands. So a chain torn down by a join is recoverable; what is still lost is the in-flight turn, and what is still missing is any way for the CLI to know a turn is in flight.

Two facts about the chain make a lease derivable, and one gap has to be closed first:

- **A checkpoint records progress, not attempts.** `Workshop::checkpoint` returns `Ok(None)` when the tree matches the tip, and `checkpoint_turn` runs at exactly two sites in the resolver's turn loop. A live resolve can therefore sit on a static tip for a whole turn — and a *resumed* resolve (`Workshop::open_conflict` in `finish_join_inner` opens at the tip of a chain a previous run parked) starts on a tip that may be hours or days old. Tip age alone would read a freshly resumed resolve as dead.
- **The ladder parks chains too.** `resolve_ladder` writes the root when its rungs leave something unresolved, with no resolver involved — the join pilot does this unattended. A bare root is a parked conflict, not a resolve in flight, so the root's own age must never be read as a lease.
- **Completion leaves the chain standing.** The resolver's last act is `anchor_candidate`, which clears candidate marks but not the chain; the chain persists on purpose, because the salvage rung ([D157]) reads the prior chain's tip tree on the next ladder run. So "a chain stands" does not mean "a resolve is unfinished", and the lease must be able to tell the two apart.

The design that follows from those facts: the resolver writes two more commits on the chain, a **begin marker** when it opens the workshop and an **end marker** when it exits by any path, both empty-delta (the tip's own tree, one parent). The chain then reads as the resolve's own operation log — `tugconflict` root, `tugresolve(<dash>): begin`, zero or more `checkpoint`s, `tugresolve(<dash>): end` — and liveness is a pure function of the tip: *the tip is a `begin` or `checkpoint` commit, no candidate stands, and the tip is younger than the resolve deadline*. The lease releases on every orderly exit through the end marker (jj's op-heads lock releases on drop the same way), and only a crash leaves it to age out — over a window that is not guessed but is the same `RESOLVE_DEADLINE` the resolver already dies at.

#### Strategy {#strategy}

- **Markers first, in `tugdash-core`.** The begin/end commits and the lease reader (`resolve_lease`) land in `resolve.rs` with unit tests that drive real chains, before anything refuses on them. The reader takes `now` as a parameter so tests age a chain without sleeping or rewriting committer dates.
- **The resolver writes the markers** at its two lifecycle edges: after `Workshop::open_conflict` succeeds inside `finish_join_inner`'s blocking task, and in the one place every exit of a resolve passes through — the `RESOLVE_DEADLINE`-bounded wrapper around `finish_join_inner`. The window constant moves to `tugdash-core` and tugcast's `RESOLVE_DEADLINE` becomes an alias of it, so the deadline the resolver dies at and the window the lease reads are one number by construction.
- **Then the refusal, on all three cross-process doors.** `join_blockers_from_detail` grows a `live-resolve` blocker kind (preview path); `join_in_with_progress` and `discard_in` refuse with the same sentence on the execute path, above their worktree-dirt sweep so a refused verb touches nothing; and `run_join_resolve` refuses before it runs the ladder, because the ladder is the third door and it destroys the chain outright.
- **Then the override.** `--break-lease` on `join` and `discard` proceeds past the refusal; the op log's `OpBefore` records that the lease was broken and how old the tip was, the verb's warnings say what was torn down and which op number restores it. The chain itself is already under the keepalive, so nothing new is needed to make the teardown recoverable — the flag is consent, not capability.
- **tugcast's guard stays as the fast path.** Its refusal is exact and instant; the lease is the cross-process backstop, and the occupancy fact the board already holds is passed *into* `join_blockers_from_detail` — widening the `joining: bool` parameter that suppression already rides — so one truth is decided in one place.
- **Docs and a decision last**, once the behaviour is real: a section in `tuglaws/dash-lifecycle.md` and a global design decision.

#### Success Criteria (Measurable) {#success-criteria}

- A chain whose tip is a `tugresolve(<dash>): begin` or `checkpoint` commit younger than `RESOLVE_LEASE`, with no candidate anchored, reads as live from `resolve_lease`; a bare root, an `end`-tipped chain, a chain with a standing candidate, and a tip older than the window all read as not live (unit tests in `resolve.rs`).
- `tugutil dash join <name>`, `tugutil dash discard <name>`, and `tugutil dash join <name> --resolve` against a live chain each exit non-zero with a sentence naming the dash, the tip's age, the lease window, and both ways out, and change nothing — the worktree, the chain ref, and the op log are byte-identical before and after (ops tests plus one CLI test for the `--resolve` door).
- `tugutil dash join <name> --preview` on the same dash lists a `live-resolve` blocker with that sentence and exits 0 (CLI test).
- `--break-lease` lands the join (or completes the discard), the op payload carries `broke_lease` with the tip age, the outcome's warnings name the op number, and `tugutil dash undo` afterwards restores `refs/tug/conflict/<name>` to the tip that was torn down (ops test).
- A resolver run in tugcast leaves the chain tipped by `tugresolve(<dash>): end` on success, on a refused report, and on the resolve deadline expiring (tugcast tests).
- `tugcast`'s `RESOLVE_DEADLINE` and `tugdash_core::resolve::RESOLVE_LEASE` are the same constant (one is defined as the other).
- `cd tugrust && cargo nextest run` is green with `-D warnings`.

#### Scope {#scope}

1. Begin/end marker commits on the conflict chain, written by the resolver.
2. A lease reader in `tugdash-core` (`resolve_lease`) and the window constant it reads (`RESOLVE_LEASE`).
3. A `live-resolve` refusal on the preview and execute paths of `join`, on `discard`, and on the CLI's `join --resolve` before it runs the ladder.
4. A `--break-lease` override on those three verbs, recorded in the op log and narrated in the verb's warnings.
5. Occupancy-aware suppression of the lease blocker, carried into `join_blockers_from_detail` by the caller that holds the fact.
6. `tuglaws/dash-lifecycle.md` and `tuglaws/design-decisions.md` updates.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Any new daemon, lock file, registry, or heartbeat.** The lease is read from `refs/tug/conflict/<name>` and `refs/tug/candidate/<name>` with `git rev-parse` and `git log`; nothing writes on a timer.
- **Replacing or weakening `join_occupancy.rs`.** The in-process guard remains the first check on every tugcast path and its refusal text is unchanged.
- **A lease for chain-less resolves.** A resolve that opens on an inherited or squash candidate (`Workshop::open_candidate`, the audit shape) has no chain to write on; its candidate is already kept alive by the oplog keepalive, and a CLI teardown under it costs one audit turn. Inventing a durable fact for it would be a declared fact rather than a derived one ([D138]), and the ordinary card flow is already guarded in-process.
- **Changing the landing doctrine.** Who joins, what a join lands, and the reconcile-clean gate ([D149]) are untouched; this plan adds one refusal and one override to two verbs.
- **Cross-machine occupancy.** Two checkouts on two machines sharing a remote are not a case the dash model has.

#### Dependencies / Prerequisites {#dependencies}

- The conflict chain (`1ca5e225e`) and the chain keepalive + `restore_conflict_ref` + `redo` (`42ac1eb0b`, from `dash/dash-hardening-2.md`) — both landed on `main`.
- `git commit-tree` and `git log --format=%ct`, both present in every git this project supports (the join preview already requires git ≥ 2.38).

#### Constraints {#constraints}

- `-D warnings` across the workspace; every test runs under `cargo nextest`.
- Refusals are CAS-style: a named kind, a full sentence, no mutation before the refusal ([L22], [L28], [L31]).
- No test may sleep to age a chain; the reader takes `now` explicitly.
- Every file this plan touches lives in `tugrust/crates/{tugdash-core,tugcast,tugutil}` and `tuglaws/`; no tugdeck change is needed because the join board already carries blockers to the face and the face renders `JoinBlocker.detail` verbatim.

#### Assumptions {#assumptions}

- The two `checkpoint_turn` call sites in `join_resolver.rs` remain the only writers of `tugresolve(…): checkpoint` commits; the begin/end markers are the only other resolver-authored commits on a chain.
- A candidate standing beside a chain means the resolve that produced it completed: `resolve_ladder` calls `clear_candidate` (which folds `clear_conflict`) before parking a new root, and the resolver anchors its candidate as its final act, so the pair only ever coexists after completion.
- The wall clock on the machine that reads the lease is the one that wrote the chain, so committer time minus now is meaningful to within seconds.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The four questions the invocation named are decided in [P01]–[P05].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A crashed resolve leaves a `begin`/`checkpoint` tip that refuses CLI joins for up to the window | med | low | `--break-lease` with a full receipt; the window is the existing resolve deadline, not a new number | Users reach for `--break-lease` routinely |
| Empty-delta marker commits confuse a chain reader that assumes each commit changes the tree | med | low | Step 1 audits every `read_conflict`/`valid_conflict` caller; markers share the parent's tree so salvage and `open_conflict` see no difference | A reader starts diffing consecutive chain commits |
| The end marker is not written on some exit path | med | low | It is written in the one wrapper every resolve exit passes through, and a missed marker degrades to the aged-out case, never to silent destruction | A tugcast test finds a chain tipped by `begin` after an orderly exit |

**Risk R01: A stale lease after a crash** {#r01-stale-lease}

- **Risk:** tugcast dies mid-resolve; the chain tip is a `checkpoint` commit; `tugutil dash join` refuses for the rest of the window although nothing is running.
- **Mitigation:** the refusal states the tip age and the override in one sentence; the override is recorded and undoable; the window is `RESOLVE_LEASE` = 2 h, the ceiling the resolver already enforces on itself, so it is the smallest window that is derived rather than guessed.
- **Residual risk:** up to two hours of an unattended CLI script being told to wait or break. Accepted: the CLI is the rare path, and a refusal that names its override is not a wedge.

**Risk R02: Marker commits and chain readers** {#r02-marker-readers}

- **Risk:** a reader of the chain assumes the tip's tree differs from its parent's, or counts commits as turns.
- **Mitigation:** Step 1 lists every caller of `read_conflict`, `valid_conflict`, and `ConflictChain.tip` in `resolve.rs`, `workshop.rs`, `ops.rs`, `oplog.rs`, and `join_resolver.rs` and confirms each reads the tip's tree or ref only; the salvage rung (`salvage_rung`) reads the prior tip's blobs, which the markers preserve exactly.
- **Residual risk:** none identified.

---

### Design Decisions {#design-decisions}

#### [P01] The chain is the resolve's op log: begin and end markers bracket the checkpoints (DECIDED) {#p01-chain-markers}

**Decision:** When the resolver opens a chain-backed workshop it commits an empty-delta `tugresolve(<dash>): begin` on the chain and advances the ref; when the resolve exits — anchored, refused, errored, or timed out — it commits `tugresolve(<dash>): end` the same way. Both are ordinary commits made with `git commit-tree <tip>^{tree} -p <tip>` so the tree is the parent's and `read_conflict`'s first-parent walk still reaches the root.

**Rationale:**
- Checkpoints record progress, not attempts (`Workshop::checkpoint` returns `Ok(None)` on an unchanged tree), so a resumed resolve sits on an old tip for a whole turn. The begin marker makes "a resolve opened this chain at time T" a git fact.
- A bare `tugconflict(` root is written by the ladder with no resolver present (the join pilot parks conflicts unattended). Without a begin marker the root's age would be read as a lease and refuse a CLI join for two hours after every pilot pass that left a conflict.
- An end marker is what lets the lease release on an orderly exit instead of aging out — the property jj's op-heads lock has by dropping its guard. The chain must persist after completion because the salvage rung ([D157]) reads it, so "chain gone" cannot be the release signal.
- Empty-delta commits are cheap, and their subjects make the chain read as a log: root, begin, checkpoints, end.

**Implications:**
- `RESOLVE_SUBJECT_PREFIX = "tugresolve("` becomes a `pub const` in `resolve.rs` beside `CONFLICT_SUBJECT_PREFIX`; `checkpoint_turn`'s message keeps its current spelling, which already starts with it.
- Two new functions in `resolve.rs`: `mark_resolve_begun(repo, name) -> Result<String, String>` and `mark_resolve_ended(repo, name) -> Result<String, String>`, sharing one private `append_marker(repo, name, subject)`. `mark_resolve_begun` is a no-op when no chain stands; `mark_resolve_ended` is a no-op when no chain stands **or** when the tip is not itself a `tugresolve(` commit — a chain the ladder parked and no resolver ever opened must not acquire an `end` marker, and the same guard makes a second `mark_resolve_ended` idempotent (Spec S01). An audit-shaped resolve, which opens `Workshop::open_candidate` and has no chain at all, therefore marks nothing at either edge.
- The resolver calls them at the two lifecycle edges named in Step 2.

#### [P02] Liveness is a pure function of the chain tip, read from git alone (DECIDED) {#p02-lease-rule}

**Decision:** `resolve_lease(repo, name, now: SystemTime) -> Option<ResolveLease>` returns `Some` — the dash is leased — exactly when all four hold: a ref stands at `refs/tug/conflict/<name>` (read with `read_conflict`, **without** the validity gate); the tip's subject starts with `tugresolve(` and is not the `end` marker; `read_candidate(repo, name)` is `None`; and `now − tip committer time < RESOLVE_LEASE`. `ResolveLease { tip: String, age: Duration }`.

**Rationale:**
- Validity (`conflict_is_valid`, strict head equality) answers *may this chain be opened*; the lease answers *is somebody working on it*. A round landing on the dash mid-resolve invalidates the chain without stopping the resolver, and the keepalive reads the chain without the gate for the same reason ([tuglaws/dash-lifecycle.md](../tuglaws/dash-lifecycle.md#the-operation-log-and-undoing)).
- A standing candidate is the resolver's own receipt of completion: `anchor_candidate` is its last act, and `resolve_ladder` clears any candidate before parking a new root. Reading it means a missed end marker degrades to the aged-out case only when the resolve never finished.
- Committer time rather than author time, because `commit-tree` sets both from the same clock and committer is the one git conventionally means by "when was this written".
- `now` is a parameter so tests can age a chain by passing a later instant.

**Implications:**
- `RESOLVE_LEASE: Duration = Duration::from_secs(2 * 60 * 60)` is defined in `tugdash-core/src/resolve.rs`; `tugcast`'s `RESOLVE_DEADLINE` becomes `pub const RESOLVE_DEADLINE: Duration = tugdash_core::resolve::RESOLVE_LEASE;` with its doc comment kept, so the two cannot drift.
- Tip committer time is read with `git log -1 --format=%ct <tip>`.

#### [P03] The refusal is a named blocker, `live-resolve`, with one sentence on both paths (DECIDED) {#p03-live-resolve-refusal}

**Decision:** `JoinBlocker.kind` gains `live-resolve`. `join_blockers_from_detail` pushes it (preview path) and `join_in_with_progress` / `discard_in` return it as their `Err` (execute path) when `resolve_lease` is `Some` and the caller did not pass `break_lease`. One function, `live_resolve_detail(name, &ResolveLease, verb: &str) -> String`, renders the sentence for every path:

> A resolve may still be running for dash '<name>': its conflict chain was last advanced <age> ago, inside the <window> lease. Wait for it to finish, resolve again to start a fresh one, or pass `--break-lease` to <verb> anyway — the resolver's checkpoints are kept by the op log and `tugutil dash undo` puts them back.

`<age>` and `<window>` render as `Nm` / `Nh Nm` through a small `human_age(Duration)` helper (seconds under a minute as `Ns`).

**Rationale:**
- The existing kinds (`stale-journal`, `off-base`, `base-dirt`, `empty`) are the vocabulary; a new kind in the same grammar reaches the face with no tugdeck change, because the join board already carries `JoinBlocker` rows and the register renders `detail` as written.
- The `detail` string being the execute path's `Err` text is the documented convention on `JoinBlocker.detail`.
- **Both ways out are named because the sentence has two audiences.** `--break-lease` is a CLI flag no Session card user can reach; the card's way past a stale lease is its Resolve arm, which runs the ladder, and the ladder clears the chain and starts fresh. A refusal that named only the flag would be a control that does nothing for half the people who read it ([L31]).

**Implications:**
- On the execute path the check sits after every existing refusal **and above `commit_worktree_dirt`**, so the refusal genuinely touches nothing. Placing it lower — between the sweep and `capture_before` — would mean a refused join had first committed a round on the dash, which is a mutation on a refusal path ([L28]) even though the round is dash-owned work.
- `join_preflight_in`'s doc says "Never cache this"; the lease is another such input and is computed fresh each call.

#### [P04] `--break-lease` is consent, recorded in the op log; the chain stays recoverable through the keepalive that already exists (DECIDED) {#p04-break-lease}

**Decision:** `JoinOptions` gains `break_lease: bool`; `discard_in` gains a `break_lease: bool` parameter; `tugutil dash join` (both with and without `--resolve`) and `tugutil dash discard` gain `--break-lease`. With it set, the verb proceeds past the `live-resolve` refusal; `OpBefore` gains `broke_lease: Option<u64>` (the tip's age in seconds at the moment it was broken, `serde(default)`), and the verb pushes a warning: `Broke the resolve lease on '<name>' (chain tip <age> old); the resolver's checkpoints are kept at op #<seq> — tugutil dash undo restores them.` The chain teardown itself is unchanged: `clear_candidate` drops the ref, and `undo` restores it as it already does.

**Rationale:**
- Never silent destruction ([L23]): the op log is the place a teardown is already recorded, and `OpBefore.conflict` already captures the tip; recording *that the lease was broken* is one more field beside it, visible in `tugutil dash undo --list` via `print_oplog`.
- Nothing new is needed for recoverability — the keepalive parents the chain tip and `restore_conflict_ref` puts the ref back. The flag adds consent and a receipt, which is all it should add.
- The spelling `--break-lease` names the concept the refusal named, and is unlike `--force`, which this CLI reserves for `init`.

**Implications:**
- tugcast never passes `break_lease` — the card has no gesture for it and its own guard is exact ([P05]); a card join that reaches the lease refusal is by definition a resolve in another process, and the refusal sentence is what the face shows.
- `print_oplog` appends `, broke lease (<age>)` to the state column when `broke_lease` is `Some`.

#### [P05] tugcast's in-process guard is the fast path; the lease is the cross-process backstop (DECIDED) {#p05-guard-stays}

**Decision:** `join_occupancy.rs` is unchanged. Every tugcast path acquires it first, exactly as today; `join_in_with_progress` and `discard_in` then read the lease as well. The suppression rides the parameter that already carries occupancy into the blocker set: `join_blockers_from_detail`'s fourth parameter changes from `joining: bool` to `held: Option<&str>` — the run kind, exactly what `join_occupancy::run_kind` returns. `joining` becomes `held == Some("join")` at its one use (the stale-journal split), and `live-resolve` is suppressed whenever `held.is_some()`.

**Rationale:**
- The in-process guard is exact and instant; the lease is a two-hour window with one refusal. Using the exact answer where it exists and the derived one only where it is the only answer is the whole shape of the design, and it is jj's: the file lock avoids duplicated work, correctness lives elsewhere.
- **The parameter is the shipped idiom, not an invention.** `join_blockers_from_detail` already takes occupancy from its caller, and its doc says why: "It is the one input the caller must supply — the answer cannot be read from disk." Filtering a blocker back out in `join_board.rs` after the function produced it would put the same decision in two places, which is precisely the drift the parameter exists to prevent.
- `held: Option<&str>` carries strictly more than `joining: bool` and loses nothing: the stale-journal split needs "a **join** holds it" (a resolve over a crashed join's journal must still be refused, as the body comment states), while the lease needs "**anything** holds it".
- A tugcast restart releases every in-process hold and orphans every run at once; the lease is what the *next* process — a CLI or the restarted tugcast — reads about the orphan.

**Implications:**
- `join_preflight_in` passes `None` where it passes `false` today, with its existing comment ("No occupancy view from a CLI process, and none wanted") extended by one clause: which is exactly why the lease exists.
- Inside tugcast, a join after its own completed resolve never sees the lease (the candidate stands, the tip is `end`). A join after a resolve that *failed* inside the same tugcast sees the tip as `end` too, so no false refusal reaches the card from its own history; only a crash leaves a `begin`/`checkpoint` tip behind, and the card's way past it is its Resolve arm ([P03]).

#### [P06] The CLI's `join --resolve` is the third cross-process door, and is refused before the ladder runs (DECIDED) {#p06-resolve-door}

**Decision:** `run_join_resolve` in `tugrust/crates/tugutil/src/dash.rs` reads `resolve_lease` and refuses with `live_resolve_detail(name, &lease, "resolve")` **before** calling `resolve::resolve_conflicts_cwd`, unless `--break-lease` was passed; when it was, the flag is also threaded into the `JoinOptions` it builds afterwards. No lease check is added inside the ladder itself.

**Rationale:**
- The ladder destroys the chain outright: `resolve_ladder`'s partial-outcome arm calls `clear_candidate`, which folds `clear_conflict` (`resolve.rs`, the "the order matters and is load-bearing" comment), and its full-resolve arm calls `clear_conflict` directly. So `tugutil dash join --resolve` wipes a live resolver's checkpoints *before* `ops::join` is reached, and a lease check inside `join_in_with_progress` never sees the race at all. This is the same R03 hole through a different door.
- **The refusal belongs at the CLI boundary, not in the ladder.** The ladder's other callers are all inside tugcast — the join pilot and the supervisor — and both acquire `join_occupancy` before running it, so the in-process guard already covers them ([P05]). A lease check in the ladder core would additionally refuse the pilot for up to two hours after any resolver crash, wedging the one actor whose job is to clear the wreckage.
- There is no cross-process *resolver*: the AI resolver lives only in tugcast. So the only ladder run that can race a live resolve is one started from a second process, which is exactly what this check catches.

**Implications:**
- Once the CLI resolve is allowed past the lease, the chain it replaces is gone, so the `ops::join` that follows sees no lease and needs no exemption; `break_lease` is threaded into its `JoinOptions` anyway so the two halves of one gesture cannot disagree.

---

### Deep Dives {#deep-dives}

#### The chain as a log {#chain-as-log}

After this plan a chain reads, first-parent from the ref:

```
tugresolve(<dash>): end          ← tip after an orderly exit (lease released)
tugresolve(<dash>): checkpoint   ← one per turn that changed the tree
tugresolve(<dash>): begin        ← written when the resolver opened the workshop
tugconflict(<dash>): …           ← root, JSON ConflictRecord in the body (ladder-written)
```

A resumed resolve appends a second `begin` after the previous `end` (or after a `checkpoint` if the previous run crashed); the lease reads only the tip. `read_conflict` is unaffected because it walks to the first `tugconflict(` subject; `Workshop::open_conflict` resets to `chain.tip`'s tree, which the markers preserve; `salvage_rung` reads blobs at the prior tip, likewise preserved.

**Table T01: What the lease reads** {#t01-lease-reads}

| Tip subject | Candidate stands | Age < window | `resolve_lease` |
|---|---|---|---|
| `tugconflict(` root | — | — | `None` (parked, nobody working) |
| `tugresolve(…): begin` / `checkpoint` | no | yes | `Some` (live) |
| `tugresolve(…): begin` / `checkpoint` | no | no | `None` (crashed and aged out) |
| `tugresolve(…): begin` / `checkpoint` | yes | — | `None` (completed; end marker missed) |
| `tugresolve(…): end` | — | — | `None` (released) |

#### Where the resolver's exits converge {#resolver-exits}

In `join_resolver.rs`, `finish_join_inner(ctx, outcome, &phase)` is the whole resolve — it opens the workshop in a `spawn_blocking` (choosing `open_candidate` for an inherited replay candidate, `open_conflict` when `valid_conflict` stands, `open_candidate` for a squash candidate otherwise), runs the turn loop with `checkpoint_turn` after each turn, validates the report, commits, and calls `anchor_candidate`. Its caller wraps it in `tokio::time::timeout(RESOLVE_DEADLINE, …)` and, on either arm, is the one place every exit passes: success, a `Err(String)` from any step, and the deadline. That wrapper is where `mark_resolve_ended` goes — after the timeout resolves, before the outcome is reported — in its own `spawn_blocking`. The begin marker goes inside the blocking task that opens the workshop, immediately after the `open_conflict` arm returns `Ok` (the other two arms have no chain and call nothing).

#### Ordering of the refusal in `join_in_with_progress` and `discard_in` {#refusal-ordering}

`join_in_with_progress` refuses, in order: preview (returns early with blockers), stale journal, inside-worktree, off-base, intersection base dirt; then `commit_worktree_dirt` sweeps worktree dirt into a round; then the `ahead == 0` check; then `capture_before` / `record_begin`. **The lease check goes immediately after the intersection base-dirt refusal and above the sweep** — every refusal above that line has touched nothing, and a refusal that had first committed a round would be a mutation on a refusal path ([L28]). `discard_in` refuses on hand-back conflicts, then `capture_before` / `record_begin`; the lease check goes between those two, which is likewise above its first write.

The third door does not pass through either function. `tugutil dash join --resolve` dispatches to `run_join_resolve`, which calls `resolve::resolve_conflicts_cwd` **first** and only reaches `ops::join` once the ladder has produced a candidate. The ladder clears the chain on both its arms, so by the time `join_in_with_progress` could check a lease there is nothing left to check; the refusal therefore sits at the top of `run_join_resolve` ([P06]).

---

### Specification {#specification}

**Spec S01: Marker commits** {#s01-markers}

- Subject `tugresolve(<name>): begin` / `tugresolve(<name>): end`; body empty.
- Made with `git commit-tree <tip>^{tree} -p <tip> -m <subject>` in the main repo root (`main_repo_root`), then `advance_conflict_ref(repo, name, sha)`.
- When `read_conflict` returns `None`, both functions return `Ok(String::new())` without writing — no chain, nothing to mark, not an error.
- `mark_resolve_ended` additionally returns `Ok(tip)` without writing when the tip's subject does not start with `RESOLVE_SUBJECT_PREFIX`, or is already the `end` marker. A chain the ladder parked with no resolver on it never acquires an `end`, and a second call is idempotent.

**Spec S02: `resolve_lease`** {#s02-resolve-lease}

```rust
pub const RESOLVE_LEASE: Duration = Duration::from_secs(2 * 60 * 60);
pub const RESOLVE_SUBJECT_PREFIX: &str = "tugresolve(";

pub struct ResolveLease { pub tip: String, pub age: Duration }

pub fn resolve_lease(repo: &Path, name: &str, now: SystemTime) -> Option<ResolveLease>
```

Rules as in Table T01. `age` is `now.duration_since(UNIX_EPOCH + Duration::from_secs(secs)).unwrap_or(Duration::ZERO)`, so a committer time that parses but lies in the future yields `age = 0` — live, conservatively, never a panic.

**Spec S03: The refusal and the override** {#s03-refusal-override}

- Blocker kind: `live-resolve`. Detail: the sentence in [P03], `verb` = `join`, `discard`, or `resolve`.
- `join_blockers_from_detail(repo_root, detail, current_branch, held: Option<&str>)` — the fourth parameter replaces today's `joining: bool`. `join_preflight_in` passes `None`; `join_board::join_state_for` passes the `run_kind` it already reads.
- `JoinOptions.break_lease: bool` (default `false`); `discard_in(repo_root, name, origin, break_lease: bool)`; `ops::discard(name, origin, break_lease)`.
- `OpBefore.broke_lease: Option<u64>` — seconds; `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- Warning text on break: `Broke the resolve lease on '<name>' (chain tip <age> old); the resolver's checkpoints are kept at op #<seq> — tugutil dash undo restores them.`
- CLI: `--break-lease` on `DashCommands::Join` (honored on both the plain and `--resolve` arms) and `DashCommands::Discard`; the JSON receipt carries the warning in the existing `warnings` array.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `RESOLVE_LEASE` | const | `tugdash-core/src/resolve.rs` | 2 h; tugcast's `RESOLVE_DEADLINE` aliases it |
| `RESOLVE_SUBJECT_PREFIX` | const | `tugdash-core/src/resolve.rs` | `"tugresolve("` |
| `ResolveLease` | struct | `tugdash-core/src/resolve.rs` | `tip`, `age` |
| `resolve_lease` | fn | `tugdash-core/src/resolve.rs` | Spec S02 |
| `mark_resolve_begun`, `mark_resolve_ended`, `append_marker` | fn | `tugdash-core/src/resolve.rs` | Spec S01 |
| `human_age` | fn | `tugdash-core/src/ops.rs` | `Duration` → `Ns` / `Nm` / `Nh Nm` |
| `live_resolve_detail` | fn | `tugdash-core/src/ops.rs` | beside `stale_journal_detail` and friends |
| `JoinBlocker` kind `live-resolve` | value | `tugdash-core/src/ops.rs` | doc comment on `kind` lists it |
| `join_blockers_from_detail` | fn signature | `tugdash-core/src/ops.rs` | `joining: bool` → `held: Option<&str>` ([P05]) |
| `run_join_resolve` | fn | `tugutil/src/dash.rs` | lease check before `resolve_conflicts_cwd` ([P06]) |
| `JoinOptions.break_lease` | field | `tugdash-core/src/ops.rs` | |
| `discard_in` / `discard` | fn signature | `tugdash-core/src/ops.rs` | `break_lease: bool` appended |
| `OpBefore.broke_lease` | field | `tugdash-core/src/oplog.rs` | `Option<u64>` seconds |
| `RESOLVE_DEADLINE` | const | `tugcast/src/feeds/join_resolver.rs` | `= tugdash_core::resolve::RESOLVE_LEASE` |
| `DashCommands::Join.break_lease`, `DashCommands::Discard.break_lease` | flags | `tugutil/src/cli.rs` | `--break-lease` |
| `run_join`, `run_discard`, `print_oplog` | fn | `tugutil/src/dash.rs` | thread the flag; print `broke lease` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `resolve_lease` over real chains in a temp repo, one test per Table T01 row | Step 1 |
| **Integration (ops)** | `join_in_with_progress` / `discard_in` refuse, break, record, undo — on the `park_conflict` / `resolve_parked_conflict` fixtures already in `ops.rs` | Step 3 |
| **Integration (tugcast)** | the resolver test fixtures in `join_resolver.rs` assert the tip subject after each exit | Step 2 |
| **CLI** | `tugutil dash join --preview` lists the blocker; `--break-lease` lands; in `tugutil/tests/dash_binding_cli.rs` with its `tug(tmp)` runner | Step 4 |

#### What stays out of tests {#test-non-goals}

- No app-test: the Session card renders `JoinBlocker.detail` as it renders every other blocker, and no tugdeck code changes.
- No sleeping to age a chain: `resolve_lease` takes `now`, and a test passes `tip_time + RESOLVE_LEASE + 1s`.
- No test of a real crash in tugcast: the aged-out row of Table T01 is the crash case and is a unit test.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Chain markers and the lease reader | done | `2f006969e` |
| #step-2 | The resolver writes the markers | done | `7db1b0d93` |
| #step-3 | Join and discard refuse `live-resolve`, `--break-lease` overrides | done | `cb947c734` |
| #step-4 | CLI flags, op-log listing, and docs | done | `bc6f7442c` |
| #step-5 | Integration Checkpoint | done | `1ef8ea4f6` |

#### Step 1: Chain markers and the lease reader {#step-1}

**Commit:** `tugdash-core(resolve): derive a resolve lease from the conflict chain tip`

**References:** [P01] chain markers, [P02] lease rule, Spec S01, Spec S02, Table T01, Risk R02, (#chain-as-log)

**Artifacts:**
- `RESOLVE_LEASE`, `RESOLVE_SUBJECT_PREFIX`, `ResolveLease`, `resolve_lease`, `mark_resolve_begun`, `mark_resolve_ended` in `tugrust/crates/tugdash-core/src/resolve.rs`, re-exported from the crate root beside `read_conflict`.

**Tasks:**
- [ ] Add the constants and `ResolveLease` next to `CONFLICT_SUBJECT_PREFIX` / `ConflictChain`.
- [ ] Implement `append_marker(repo, name, subject)`: `read_conflict` → `None` returns `Ok(String::new())`; otherwise `git commit-tree "<tip>^{tree}" -p <tip> -m <subject>` in `main_repo_root(repo)`, then `advance_conflict_ref`. Expose `mark_resolve_begun` / `mark_resolve_ended`.
- [ ] Implement `resolve_lease` per Spec S02: `read_conflict` (no validity gate); `git log -1 --format=%s <tip>` must start with `RESOLVE_SUBJECT_PREFIX` and not end in `: end`; `read_candidate` must be `None`; `git log -1 --format=%ct <tip>` parsed as Unix seconds, `age = now.duration_since(UNIX_EPOCH + secs).unwrap_or(Duration::ZERO)`, live when `age < RESOLVE_LEASE`.
- [ ] Audit every caller of `read_conflict`, `valid_conflict`, and `.tip` in `resolve.rs`, `workshop.rs`, `ops.rs`, `oplog.rs`, and `tugcast/src/feeds/join_resolver.rs` for an assumption that consecutive chain commits differ in tree; record in the step's commit body that none was found, or fix the one that was.

**Tests:**
- [ ] `a_parked_root_is_not_a_lease` — park a chain with the existing test helpers, assert `resolve_lease` is `None`.
- [ ] `a_begin_marker_leases_the_dash_until_it_ages_out` — `mark_resolve_begun`, `Some` at `now`, `None` at `now + RESOLVE_LEASE + 1s`.
- [ ] `a_checkpoint_renews_the_lease` — checkpoint via `Workshop::checkpoint` after a file edit; the lease's `tip` is the checkpoint.
- [ ] `an_end_marker_releases_the_lease` and `a_standing_candidate_releases_the_lease` — the last two rows of Table T01.
- [ ] `markers_keep_the_tip_tree_and_the_root_reachable` — after begin + end, `read_conflict().root` is unchanged and `git rev-parse <tip>^{tree}` equals the checkpoint's tree.
- [ ] `marking_a_dash_with_no_chain_is_a_no_op` — both markers return `Ok("")` and create no ref.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 2: The resolver writes the markers {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(join-resolver): bracket a resolve with begin and end markers on its chain`

**References:** [P01] chain markers, [P02] lease rule, [P05] guard stays, Spec S01, (#resolver-exits)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/join_resolver.rs`: `RESOLVE_DEADLINE` aliased to `tugdash_core::resolve::RESOLVE_LEASE`; `mark_resolve_begun` after the `open_conflict` arm; `mark_resolve_ended` in the deadline wrapper.

**Tasks:**
- [ ] Replace `RESOLVE_DEADLINE`'s literal with `tugdash_core::resolve::RESOLVE_LEASE`; extend its doc comment with one sentence: the same number is the lease window every process reads from the chain.
- [ ] In `finish_join_inner`'s workshop-opening `spawn_blocking`, call `tugdash_core::resolve::mark_resolve_begun(&repo, &dash)` immediately after the `Some(_) => Workshop::open_conflict(...)?` arm; a marker failure is a warning-level `tracing` line, not a resolve failure (the lease degrades to aged-out, never to destruction). The other two arms open a candidate and have no chain, so they call nothing.
- [ ] In `finish_join`, the public wrapper that runs `tokio::time::timeout(RESOLVE_DEADLINE, finish_join_inner(ctx, outcome, &phase))`, `spawn_blocking` a `mark_resolve_ended(&repo, &dash)` after the `match` that produces `result` and before the existing `if result.is_err()` release block; same failure policy. `finish_join` is the single point every exit of a resolve passes — success, any `Err` sentence, and the expired deadline — which is why the marker goes there rather than at the exits themselves.
- [ ] Confirm `checkpoint_turn`'s message `tugresolve({dash}): checkpoint` starts with `RESOLVE_SUBJECT_PREFIX` by constructing it from the constant.

**Tests:**
- [ ] Extend `the_resolver_finishes_a_conflict_and_anchors_its_candidate` to assert the chain tip subject is `tugresolve(demo): end` and `resolve_lease` is `None` afterwards.
- [ ] Extend the refused-resolve test (`"a refused resolve anchors no candidate"`) to assert the tip is the `end` marker.
- [ ] New: `a_resolve_in_flight_leases_its_chain` — using the existing fake-resolver harness, assert `resolve_lease` is `Some` while the harness holds the turn open and `None` after it returns.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast join_resolver`

---

#### Step 3: Join and discard refuse `live-resolve`, `--break-lease` overrides {#step-3}

**Depends on:** #step-1

**Commit:** `tugdash-core(ops): refuse a join or discard over a leased chain, unless the lease is broken on the record`

**References:** [P03] live-resolve refusal, [P04] break-lease, [P05] guard stays, Spec S03, Risk R01, (#refusal-ordering)

**Artifacts:**
- `tugrust/crates/tugdash-core/src/ops.rs`: `human_age`, `live_resolve_detail`, the `live-resolve` blocker, `join_blockers_from_detail`'s widened parameter, `JoinOptions.break_lease`, `discard_in`/`discard` signatures, the refusal at both sites, the warning on break.
- `tugrust/crates/tugdash-core/src/oplog.rs`: `OpBefore.broke_lease`, set by the two verbs after `capture_before` when they broke the lease.
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`: `JoinOptions { break_lease: false, .. }` and `discard_in(..., false)` at the two call sites; `tugrust/crates/tugcast/src/feeds/join_board.rs`: pass `run_kind` into `join_blockers_from_detail`.

**Tasks:**
- [ ] Add `human_age` and `live_resolve_detail` beside `stale_journal_detail`; extend the doc comment on `JoinBlocker.kind`.
- [ ] Widen `join_blockers_from_detail`'s fourth parameter from `joining: bool` to `held: Option<&str>` per [P05]; rewrite the stale-journal split as `held == Some("join")`, keeping its existing body comment; update its doc paragraph to describe the wider fact. Callers: `join_preflight_in` passes `None`, `join_board::join_state_for` passes the `run_kind` it already reads, and the two in-crate test call sites pass `None`.
- [ ] In the same function, push `live-resolve` when `held.is_none()` and `resolve_lease(repo_root, name, SystemTime::now())` is `Some`, after the `base-dirt` blockers and before `empty`.
- [ ] `join_in_with_progress`: immediately after the intersection base-dirt refusal and **above** `commit_worktree_dirt`, refuse with `live_resolve_detail(name, &lease, "join")` unless `opts.break_lease`; when breaking, carry the age forward and set `op_before.broke_lease = Some(age)` before `record_begin`, then push the warning naming the returned `seq`.
- [ ] `discard_in`: same, between the hand-back refusal and `capture_before`; thread `break_lease` through `discard`.
- [ ] Every `JoinOptions { .. }` and `OpBefore { .. }` initializer in the workspace gains the new field.

**Tests:**
- [ ] `a_join_over_a_live_chain_is_refused_by_name_and_touches_nothing` — park with the existing `park_conflict` fixture + `mark_resolve_begun`; `join_in` returns `Err` equal to `live_resolve_detail(...)`; `refs/tug/conflict/demo`, the dash tip (proving the dirt sweep never ran), and the op-log sequence are unchanged.
- [ ] `a_discard_over_a_live_chain_is_refused_the_same_way`.
- [ ] `a_preview_lists_live_resolve_as_a_blocker` — `join_preflight_in` contains a blocker with `kind == "live-resolve"`.
- [ ] `breaking_the_lease_lands_records_the_age_and_is_undoable` — `break_lease: true` lands; `read_op(seq).before.broke_lease` is `Some`; the outcome's warnings name `#<seq>`; `undo_in` restores `refs/tug/conflict/demo` to the recorded tip.
- [ ] `an_ended_lease_does_not_refuse` — `mark_resolve_ended`, then `join_in` succeeds without the flag.
- [ ] `an_aged_out_lease_does_not_refuse` — the ops path calls `SystemTime::now()` and cannot be given a clock, and `git_output` carries no environment, so backdate the marker directly: a raw `std::process::Command::new("git")` running `commit-tree` in the repo with `.env("GIT_COMMITTER_DATE", "<now − 3h> +0000")`, then `advance_conflict_ref` to it. `join_in` then succeeds without the flag.
- [ ] `the_board_hides_the_lease_blocker_while_it_holds_the_dash` in `join_board.rs`, using `join_occupancy::acquire` with a per-test key as the existing board tests do, and asserting the shipped stale-journal behaviour is unchanged for a `Resolve` holder.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast`

---

#### Step 4: CLI flags, op-log listing, and docs {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugutil(dash): add --break-lease to join and discard, and write the lease into the laws`

**References:** [P03] live-resolve refusal, [P04] break-lease, [P05] guard stays, [P06] the resolve door, Spec S03, (#chain-as-log, #refusal-ordering)

**Artifacts:**
- `tugrust/crates/tugutil/src/cli.rs`: `--break-lease` on `Join` and `Discard` with a one-line help naming what it tears down.
- `tugrust/crates/tugutil/src/dash.rs`: `run_join` / `run_discard` thread the flag; `run_join_resolve` gains the [P06] refusal before `resolve_conflicts_cwd` and threads the flag into the `JoinOptions` it builds; `print_oplog` appends `, broke lease (<age>)` when `broke_lease` is `Some`.
- `tuglaws/dash-lifecycle.md`: a subsection after the op-log section, "Occupancy — the lease", stating the chain-as-log shape, the four-part rule, the window's provenance, the refusal, the override, and that the in-process guard remains the fast path.
- `tuglaws/design-decisions.md`: **D160** — the decision in one paragraph, citing [D138], [D157], [L23], [L31], and this plan.

**Tasks:**
- [ ] Add the flags and thread them through all three arms — the plain join, `--resolve`, and discard. The JSON receipt needs no new field because the warning rides `warnings`.
- [ ] `run_join_resolve`: refuse per [P06] before `resolve_conflicts_cwd`, with `verb = "resolve"`.
- [ ] Write the lifecycle subsection and D160 in prose, no hard wrapping. D160 states that R03 in `dash/archive/join-hardening.md` is closed, and names the three doors the lease guards.
- [ ] Update `join_occupancy.rs`'s module doc with one sentence pointing at the lease as the cross-process backstop, so a reader of the guard learns where the other half lives.

**Tests:**
- [ ] `dash_join_preview_names_a_live_resolve_and_break_lease_lands_it` in `tugutil/tests/dash_binding_cli.rs`: park a chain and write a begin marker in the fixture; `dash join demo --preview --json` lists the blocker; `dash join demo` exits non-zero with the sentence; `dash join demo --break-lease --json` succeeds with the warning; `dash undo --list` shows `broke lease`.
- [ ] `dash_join_resolve_refuses_over_a_live_chain_and_leaves_it_standing` — `dash join demo --resolve` exits non-zero and `refs/tug/conflict/demo` still points at the begin marker, proving the ladder never ran.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `cd tugrust && cargo build` (warnings are errors)

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(dash-occupancy-lease): close the ledger`

**References:** [P01]–[P05], (#success-criteria)

**Artifacts:**
- The ledger rows closed; the dash replayed onto the live base and its fit verified.

**Tasks:**
- [ ] `tugutil dash replay <name>`.
- [ ] On `Replayed` / `Recorded`: run the declared verify command from `tugutil dash config --json` (`sh scripts/verify-fit.sh {base} {head}`) in the worktree. On `Current`: run nothing and say so. On `Conflicted`: resolve in the worktree as a round, then verify.

**Tests:**
- [ ] None beyond the fit: every checkpoint above ran against these bytes.

**Checkpoint:**
- [ ] `tugutil dash replay <name>` reports `Current`, or the verify command exits 0 on the replayed range.

---

### Deliverables {#deliverables}

- A conflict chain that reads as its resolve's op log, bracketed by `begin` and `end` markers the resolver writes.
- `tugdash_core::resolve::resolve_lease`, the one reader of resolver liveness, taking git and a clock and nothing else.
- `live-resolve` as a named refusal on all three cross-process doors — `join` (preview and execute), `discard`, and the CLI's `join --resolve` — and `--break-lease` as its recorded, undoable override.
- tugcast's `RESOLVE_DEADLINE` and the lease window unified in one constant.
- `tuglaws/dash-lifecycle.md` and D160 documenting the lease; `dash/archive/join-hardening.md` R03 closed by reference from D160.
