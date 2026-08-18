<!-- devise-skeleton v5 -->

## Base-Motion Replay {#base-motion-replay}

**Purpose:** Keep a live dash current with its base instead of ambushing at landing time: when the base moves, replay the dash's rounds onto the new tip then and there — a clean replay happens quietly and leaves a glanceable settled mark; a conflicted one becomes an ordinary agent turn in the dash's bound session, with the conflict and the dash's intent in hand.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugdash/base-motion-replay (base: main) |
| Last updated | 2026-08-15 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-15, opus.** Reviewed `plan:3fdf5094506eb8bd`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document — a first pass, with `rounds: 0`.
Applied: the largest finding was that the plan's central mechanism did not work as described. [P05] claimed injecting a `user_message` frame gave "a user-visible turn… nothing bespoke to trust", but `add_user_message` is emitted **only** by tugcode's JSONL replay translator (`tugcode/src/replay.ts`) and its mid-turn snapshot path — the live transcript's user row is the composer echoing its own submission. An injected turn would therefore have produced assistant output with no visible cause until a reload replayed the JSONL, which is a worse ambush than the landing-time one this plan exists to remove. Asked how it should render and settled on a distinct system-origin row; added [P10], Spec S05, a risk row, the `#injected-turn-contract` deep-dive half explaining what injection does and does not buy, a strategy bullet, a success criterion, and the deck work (store allowlist beside `wake_started`/`assistant_opener`, `turnKey` minted in the impure wrapper, reload-equivalence against the replayed row). Corrected the injection mechanism itself from a new `inject_user_message` supervisor method to a clone of the `code_input_tx` sender `main.rs` already owns, so injected and client submissions share one queue and one order; recorded that the Reporter is a precedent for *reading* CODE_INPUT, not writing it, so this is the system's first server-initiated turn. Second finding: the engine had no level read. `run_git_workspace_watch` baselines `last_head` at task start and broadcasts only on a move past it, so a dash already behind when tugcast starts would never have replayed — added the initial sweep to [P01] and #step-6 with a test that sends no signal. Third: asked about a replay landing mid-`dash-implement` and added [P11] plus Risk R03 (the agent's context outlives the tree it described; a whole-file write could silently revert base changes) with a notice turn naming the base delta. Sequencing: #step-7 now depends on #step-4, because the injected message's contract ends with `tugutil dash replay` — the verb #step-4 ships. Testability: #step-6 was a server-shaped test with no seam, so it now splits a pure `decide_for_dash` from the wiring, following `reporter_wake.rs`'s explicit precedent, and the gate cases became a table. Concrete corrections from reading the code: `main_repo_root` is module-private and must be widened to `pub(crate)`; `commit_worktree_dirt` hardcodes the subject `join: commit outstanding changes` and cannot be reused for the remap commit; `Deferred` gained a `no-worktree` reason for a branch that outlived its worktree; the base-dirt read must be hoisted above `dash_detail_entries_in`'s per-dash loop, which already spends ~6 git invocations per dash against a 150 ms-floored, poll-free recompute. Reworded the non-goal that appeared to forbid #step-1's own change to `resolve.rs`, and named the two allowlists deliberately not extended.
Deferred: nothing — both judgment calls were asked and answered, and are recorded as [P10] and [P11] rather than as Open Questions.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The working brief is `roadmap/join-assessment.md`, and its doctrine line is the goal: **a landing problem should surface the moment it becomes true, not the moment you try to land.** The brief names three ways a landing problem becomes true: the base gains commits, the base checkout holds uncommitted work the dash also touches, and the dash starts from an unclean base. The third was addressed by the create-time census and `--carry` (`roadmap/draft-contract-plan.md`, landed). This plan is the first two — the big one being base motion, where today nothing notices until the join previews and the conflict ambushes you at the end of a run, when you hold the least context you will ever have about why the two sides disagree.

The merge engine already exists. `replay_probe` in `tugrust/crates/tugdash-core/src/resolve.rs` — rung 1 of the resolution ladder — replays a dash's rounds one at a time onto the current base with `git merge-tree --write-tree --merge-base=<round^>` + `commit-tree`, entirely in memory, and returns the replayed head when every round comes out clean. It is complete and unit-tested (`replay_probe_resolves_base_already_advanced_and_lands_replay_shape`). It simply runs at the wrong time: once, on the Resolve click, and its result is discarded unless the whole replay is clean. The distance is not merge machinery — it is lifecycle and bookkeeping, and this plan is that design.

#### Strategy {#strategy}

- **The library does the motion; tugcast decides the moment.** A new `replay_onto` in tugdash-core owns preconditions, the branch move, and the bookkeeping — callable from the CLI (`tugutil dash replay`), from tests, and from tugcast's engine identically. tugcast owns *when*: it subscribes to signals the workspace watcher already emits and applies the safety gate.
- **No new watcher.** One `FileWatcher` per workspace already exists (`workspace_registry.rs`), and `git_watch.rs` already rides it, broadcasting a `GitHeadSignal` on every HEAD move and bumping the aggregate changeset recompute on every batch. Base motion (divergence source 1) triggers off the GIT_HEAD broadcast; live base-dirt overlap (source 2) rides the aggregate recompute that already reads both trees. Nothing is watched twice.
- **Bottom-up steps:** expose the per-round mapping from `replay_probe`; build `replay_onto` and its bookkeeping in the library with tempdir tests; give it a CLI verb; surface divergence fields in the snapshot; then the tugcast engine (clean path), then the conflicted-turn path, then the deck marks, then doctrine.
- **Clean is quiet, never silent.** No interruption for a clean replay — but a dash-log line and a lane mark, because silence about history rewriting itself is its own hazard.
- **Nothing the machine says arrives unattributed.** This is the system's first server-initiated turn, and the transcript has no live path for one: an injected prompt renders nowhere until a reload. The opener frame that fixes that ([P10]) is part of the feature, not a follow-on.
- **The ladder stays.** With no bound agent, or with the gate closed, nothing moves — the mark shows the dash is behind, and today's landing-time ladder remains the fallback. This plan adds an earlier, better moment; it removes nothing.

#### Success Criteria (Measurable) {#success-criteria}

- A commit landing on the base branch causes a live, clean-replayable dash to be re-based onto the new tip without any user gesture, within one debounce interval — proven by a Rust integration test driving the engine against a tempdir repo, and observable live by `git -C .tug/worktrees/<name> log` showing the new base under the rounds.
- The dash-log carries a `replayed` line naming old→new round pairs, and the plan ledger's commit cells (when a plan is recorded) reference only SHAs that exist on the replayed branch — verified by unit tests over `replay_onto`'s bookkeeping.
- A conflicted replay injects exactly one turn into the dash's most recently used live bound session, only when that session is idle, carrying the conflicting round, the stage paths, and the dash's intent — verified at the supervisor test layer.
- No injected turn ever reaches a session card unannounced: every injection emits a `tug_notice` opener carrying the same body, and the card renders it as a system-origin row rather than as the user's own words — verified by a Rust test on the emit side and in the real app on the render side.
- A dash that was already behind before tugcast started is replayed by the initial sweep, with no GIT_HEAD signal involved — verified by an engine test that never sends one.
- A dirty dash worktree, an in-flight join journal, or a mid-turn bound session each cause the engine to defer, touching nothing — verified by unit tests on the gate.
- The dash lane shows a settled mark for a replayed dash, a "base +N" mark for a behind dash, and an overlap warning when the base checkout's dirt intersects the dash's files — the overlap mark verified by an app-test, the others at the Rust snapshot layer.
- `cargo nextest run` green from the workspace baseline; `bunx vite build` clean; `just app-test-changed` green.

#### Scope {#scope}

1. `replay_probe` refactored to report the per-round old→new mapping (behavior of `resolve_conflicts` unchanged).
2. `replay_onto` in tugdash-core: preconditions, the compare-and-swap branch move under the live worktree, the conflicted report, and the bookkeeping (dash-log line, plan-ledger reconciliation).
3. `tugutil dash replay <name>` — the manual gesture, the test surface, and the agent's finishing verb after a hand rebase.
4. Divergence fields on `DashDetail` and the changeset snapshot: `base_ahead`, `base_overlap`, `last_replay`.
5. The tugcast base-motion engine: GIT_HEAD subscription, the safety gate, spawning `replay_onto`, bumping the recompute.
6. The conflicted path: turn composition and injection through the CODE_INPUT queue, the `tug_notice` opener that makes an injected turn visible, the mid-plan notice, park-and-retry while the session is busy, the no-agent fallback.
7. Deck work: the notice row and the divergence marks in the dash lane; doctrine prose in `tuglaws/dash-work-doctrine.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The tactical layer from the brief (turn-gate scope on lane controls, in-face refusal reasons, conflict archaeology) — explicitly sequenced after this program.
- Queueing a landing for a turn's end (the brief's open question) — untouched.
- Replaying *onto* a moving base mid-agent-turn on the dash — the gate forbids it; no attempt to make it safe.
- Any change to the landing-time ladder's *behavior* or to the resolution review gate — they remain the fallback exactly as shipped. #step-1 widens `replay_probe`'s return type so the mapping is available to the new caller, and is required to leave `resolve_conflicts`'s outcome byte-identical; that is the only edit this plan makes inside `resolve.rs`.
- Cross-instance coordination: the engine acts from the tugcast instance whose workspace registry watches the base repo; a second instance on the same repo is out of scope (see Risk R05).

#### Dependencies / Prerequisites {#dependencies}

- `roadmap/draft-contract-plan.md` implemented and landed (it is — the draft key, the byte-for-byte landing invariant, and the create census all precede this).
- git ≥ 2.40 for `merge-tree --merge-base` (already probed by `git_supports_merge_base_flag`; older git makes replay unavailable, never wrong).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** — the Rust workspace enforces `-D warnings`.
- **Never probe with `tugutil dash join <name> --resolve`** — it lands. `--preview` and the tempdir Rust tests are the probes.
- App-tests run against the live repository: base motion cannot be exercised there (moving the real base means committing to `main`). Branch-motion coverage lives at the Rust layer in tempdir repos; the app-test covers only what is safe live (the overlap mark, from working-tree dirt that is reverted).
- A Rust change needs `just build-app` before any app-test can see it; deck changes are verified with `bunx vite build`.
- No plan-step numbers in durable artifacts (code, comments, test names, commit messages).

#### Assumptions {#assumptions}

- The dash worktree lives at `.tug/worktrees/<name>` and its base branch is recorded at `branch.tugdash/<name>.tugbase` (both are how `worktree_path` / `dash_base` in `ops.rs` read them today).
- `read_declarations` in `dash.rs` ignores unknown dash-log markers (`_ => {}` in its match), so a new `replayed` marker is invisible to existing stage derivation — verified by reading the code; a test pins it.
- Session↔dash binding is readable from the per-instance `sessions.db` (`bound_sessions_for` in `ops.rs`: `dash_id` column, `state = 'live'`, ordered `last_used_at DESC`), and turn state is the supervisor's `turn_active` on its ledger entry.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, plan-local decisions `[P##]`, specs `S##`, risks `R##`, and per-step `**References:**` / `**Depends on:**` lines per `tuglaws/devise-skeleton.md`. Anchors are kebab-case and carry no phase numbers. `[D##]` citations refer to the global `tuglaws/design-decisions.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The brief's open lifecycle questions are answered as design decisions [P02]–[P07] below.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Branch motion races a live write in the worktree | high | low | [P03] compare-and-swap + clean check immediately before the move; per-dash serialization in the engine | any lost-write report |
| Replay feedback loop (replay commits re-trigger the engine) | med | med | R02 idempotence: a not-behind dash is a fast no-op; bookkeeping commits move the dash branch, not the base | engine hot-looping in logs |
| Injected turn surprises the user / spends tokens | med | med | [P05] inject only bound+idle, message opens by saying why it exists; [P08] config escape | user feedback |
| Injected turn renders nowhere live | high | certain without a fix | [P10] a system-origin opener frame; without it the turn is invisible until reload | any new server-initiated turn |
| Agent acts on pre-replay file contents | high | med | R03 [P11] notice turn naming the base delta | a silent revert of base work |
| Ledger remap writes a wrong SHA | med | low | R04 reconcile only unambiguous matches; leave the rest and say so in the log line | a mismatched cell in review |
| Two tugcast instances on one repo both replay | med | low | R05 the CAS move makes the second a no-op error, logged and swallowed | multi-instance work resumes |

**Risk R01: The branch moves under a live checkout** {#r01-branch-move-race}

- **Risk:** The dash worktree is checked out at the old tip; moving `tugdash/<name>` while an agent or user is mid-edit there could destroy work or wedge the checkout.
- **Mitigation:** The move happens only from inside the worktree via `git reset --keep` ([P03]), which itself refuses if any file with local modifications differs between HEAD and the target; before it, `replay_onto` re-verifies `git status --porcelain` is empty and that `rev-parse HEAD` still equals the tip the replay was computed from (the CAS). The engine additionally gates on `turn_active` for every bound session ([P02]) and holds a per-dash in-flight lock so two replays never interleave.
- **Residual risk:** A write from outside any tracked session (a stray editor) between the CAS read and the reset. The window is milliseconds and `reset --keep` still refuses on tracked-file dirt; an untracked file is untouched by `reset --keep` by construction.

**Risk R02: Recompute/replay feedback** {#r02-feedback-loop}

- **Risk:** A replay writes commits and a dash-log line, which produce fs events, which bump the recompute and (for the reset) touch `.git` — the engine must not re-trigger itself into a loop.
- **Mitigation:** The trigger is the *base branch ref* moving, not any fs event: on each wake the engine reads `rev-parse <base_branch>` per dash and compares against the merge-base; a dash already based on the tip is a no-op before any git write. The reset moves `refs/heads/tugdash/<name>` and the worktree HEAD, never the base ref, so a replay cannot look like base motion.
- **Residual risk:** Wasted no-op wakes on busy trees — bounded by the same debounce the watcher already applies to batches.

**Risk R03: The agent's context outlives the tree it described** {#r03-stale-agent-context}

- **Risk:** A clean replay resets the dash worktree between turns of a live plan run. The agent's context still holds the pre-replay contents of every file it read, so a subsequent whole-file write can silently revert base changes the replay just brought in — a regression with a green build and no conflict anywhere.
- **Mitigation:** [P11] — follow a mid-plan replay with a notice turn naming the new base tip and the base delta's paths, so the next turn re-reads what moved. The rendering is [P10]'s, so the notice is visible rather than a hidden prompt.
- **Residual risk:** An agent that ignores the notice and writes from memory anyway. Bounded by the fact that the replay's own conflict detection already passed — the overlap is by construction non-conflicting text — and by ordinary round review.

**Risk R04: Ledger reconciliation guesses wrong** {#r04-remap-ambiguity}

- **Risk:** After a hand or agent rebase there is no old→new pair list; matching ledger cells to new rounds by commit subject could collide on duplicate subjects and record a wrong SHA.
- **Mitigation:** Reconciliation rewrites a cell only when exactly one round on the branch carries the matching subject; ambiguous or unmatched cells are left as they are and the `replayed` log line names them as unmapped. When `replay_onto` did the motion itself, the mapping is exact (per-round pairs from the probe) and subject-matching is not used.
- **Residual risk:** An unmapped cell keeps a SHA that is no longer on the branch — a display gap, not a corruption; the object still exists in the repository until gc.

**Risk R05: Concurrent engines** {#r05-concurrent-engines}

- **Risk:** A debug instance and the release instance both watch the same repo and both attempt the same replay.
- **Mitigation:** The CAS in [P03] makes the loser's reset fail cleanly (tip no longer matches); the engine logs and drops it. Bookkeeping is idempotent (the ledger reconcile finds nothing left to rewrite; the log line is append-only and duplicate lines are harmless to `read_declarations`).
- **Residual risk:** A duplicated `replayed` log line — cosmetic.

---

### Design Decisions {#design-decisions}

#### [P01] One watcher, three divergence sources (DECIDED) {#p01-one-watcher}

**Decision:** No new OS watch and no polling loop. The engine subscribes to the existing per-workspace `GitHeadSignal` broadcast (emitted by `run_git_workspace_watch` in `tugcast/src/feeds/git_watch.rs` off the workspace's single `FileWatcher`) for base motion, and the live base-dirt overlap is computed inside the aggregate changeset recompute that the same watcher already bumps on every batch.

**Rationale:**
- The brief's instruction verbatim: the three divergence sources all need a watcher on the base — "design them together or the watcher gets built three times." The watcher *is already built*; the registry dedups it per canonical workspace and refcounts it across cards.
- `GitHeadSignal {workspace_key, head}` fires on any HEAD move of the watched checkout, which includes every base-branch commit while the checkout is on the base (the normal state). The signal is the *wake*, not the *evidence*: on wake the engine reads the base branch ref per dash and derives divergence from refs, so a checkout switch or a signal for an unrelated branch is a cheap no-op.

**Implications:**
- The engine is a subscriber to `workspace_registry`'s shared GIT_HEAD channel (`gh_response_tx`, `workspace_registry.rs`), resolved per workspace key; it owns no filesystem handles.
- Divergence source 3 (unclean base at create) stays where it landed — the create census; this engine does not re-implement it.
- **A signal is an edge, so the engine also needs a level read.** `run_git_workspace_watch` captures `last_head` at task start and broadcasts only on a *move past* it, so a dash that is already behind when tugcast starts — the base advanced while the app was down, or the dash has simply been parked a while — produces no signal and would never replay. The engine therefore performs an **initial sweep** of every dash in a workspace when it first sees that workspace (at startup and on each `get_or_create` of a fresh entry), evaluating exactly as it does on a signal. The sweep is also what covers the residual case of a base ref advancing without the watched checkout's HEAD moving (a fetch/fast-forward of a branch that is not checked out): rare here, since this repo commits directly to the base, and never wrong — only later than it could have been.
- Because behindness is read from refs on every wake, the sweep and the signal path share one code path; the sweep is a wake with no signal attached.

#### [P02] When acting is safe: the gate (DECIDED) {#p02-safety-gate}

**Decision:** A replay may act on a dash only when *all* hold: the dash worktree is clean (`git status --porcelain` empty), no join journal exists (`read_join_journal` returns `None`), no live bound session has `turn_active == true`, and no resolve round or prior replay for this dash is in flight. When any fails, the engine records the dash as behind (visible via `base_ahead`) and retries on the next wake — including a wake synthesized when a bound session's turn completes.

**Rationale:**
- The brief names the two hard prohibitions: never mid-turn, never over a dirty dash worktree. The journal check covers "never during a landing," and the in-flight lock covers self-overlap.
- Deferral is cheap because the mark makes it visible: a dash that stays behind is a lane state, not a silent stall.

**Implications:**
- The engine needs read access to the supervisor's session ledger for `turn_active` and to `bound_sessions_for`'s query (per-instance `sessions.db`, `dash_id` column, live rows). It lives beside the supervisor in tugcast for exactly this reason.
- A `turn_complete` for a session bound to a behind dash re-wakes the engine, so the common case — base moved during a turn — replays seconds after the turn ends, not on the next unrelated commit.

#### [P03] The branch moves by compare-and-swap `reset --keep`, from inside the worktree (DECIDED) {#p03-cas-reset-keep}

**Decision:** `replay_onto` moves the dash branch by running, inside the dash worktree: verify `git status --porcelain` is empty; verify `git rev-parse HEAD` equals the tip the replay was computed from; then `git reset --keep <replayed-head>`. Any verification failure or reset refusal aborts the replay with nothing touched, reported as deferred.

**Rationale:**
- The branch is checked out in the worktree, so `git branch -f` is refused by git and a bare `update-ref` would desynchronize HEAD/index/worktree. `reset --keep` from within the worktree updates all three together and *itself* refuses rather than clobbering local tracked changes — a second, independent safety net under the explicit checks.
- The CAS (tip still equals what the probe replayed from) closes the race where a round lands between the probe and the move; the probe result would silently drop that round otherwise.

**Implications:**
- `replay_onto` computes the probe and performs the move in one call, holding the old tip across both; the engine never passes a stale candidate in from outside.
- The same shape protects concurrent engines (Risk R05): the loser's CAS fails cleanly.

#### [P04] Bookkeeping is append-plus-reconcile (DECIDED) {#p04-bookkeeping}

**Decision:** Replayed rounds' new SHAs are recorded two ways. The dash-log gains a `replayed` marker line (Spec S02) carrying the base tip and the old→new short-SHA pairs. The plan ledger's commit cells (when `dash_plan_path` records a plan) are rewritten in the worktree copy to the new SHAs and the edit is committed as an ordinary round with message `tugdash(<name>): remap round ids after base replay`. When nothing matches, no commit is made.

**Rationale:**
- Git already records the new history; the dash-log's job (per `ops.rs`: "the verbatim instruction is git's one gap") extends naturally to "these rounds are those rounds, moved."
- The ledger cells are read by humans and by `dash step done`'s record; leaving them pointing at SHAs off the branch makes the plan's own record a lie. Rewriting them in the worktree and committing keeps the plan a plain file whose history is ordinary rounds — the next replay replays the remap commit like any other.
- The `replayed` marker is safe by construction: `read_declarations` ignores unknown markers, and `is_terminal` matches only `released` / `joined`.

**Implications:**
- Ledger rewriting goes through `tugutil_core::plan::parse` + `set_ledger_status`-adjacent editing (a new cell-rewrite helper; `set_ledger_status` as shipped also flips status, which a remap must not). Written atomically per `write_atomic`'s pattern in `ops.rs`.
- When `replay_onto` performed the motion, the mapping is exact. After a hand/agent rebase the mapping is reconciled by unique commit subject (Risk R04).

#### [P05] A conflicted replay becomes a turn, never a rung (DECIDED) {#p05-conflict-becomes-turn}

**Decision:** When the probe stops on a conflicting round, the engine composes one message (Spec S03) — what moved, which round stops the replay, the conflicting paths, the dash's intent via `resolve_intent` (maintained draft + round subjects), and the concrete finishing instructions — and injects it into the dash's most recently used live bound session, only when that session is idle, by sending a `user_message` CODE_INPUT frame down the same `code_input_tx` mpsc the router feeds (`main.rs` holds the sender; the dispatcher consumes it). The agent resolves by rebasing inside the dash worktree (`git rebase <base>`, hand-resolving as conflicts surface) and finishes with `tugutil dash replay <name>`, which finds the branch already current and performs bookkeeping only. The engine never resolves file content itself. The turn is made **visible** by [P10] — injection alone would not be.

**Rationale:**
- The brief: "a conflicted one becomes an ordinary agent turn in the dash's own session, with the stages and the dash's intent in hand, reviewed like any other round." Going in through `code_input_tx` is what makes the *machinery* ordinary: `dispatch_one`'s `user_message` intercept journals a pending turn, flips `turn_active`, and spawns the session if idle — all identical to a client submission, with no second path to keep in step.
- A rebase in the dash worktree is the designed act for a dash (its branch is its own; history rewriting there is the point), and it hands the agent the full working tree, tests, and context — strictly more than the ladder's three blobs per file.
- Injecting only when idle (and parking otherwise, retried on `turn_complete`) honors [P02]'s never-mid-turn on the injection side too.

**Implications:**
- The engine holds a clone of the `code_input_tx` `mpsc::Sender<Frame>` created in `main.rs` (the same handle `register_input(FeedId::CODE_INPUT, …)` receives), so injected frames queue behind client frames in submission order rather than racing them. Payload shape is what `parse_tug_session_id` and `InspectedPayload::from_slice` already read: `{tug_session_id, type: "user_message", content: [{type: "text", text}]}`.
- **Journaling is not rendering.** The pending-turn row and the JSONL entry make the turn real to the server and to a later reload; neither puts a row on screen live. That is [P10]'s job, and it is required, not optional.
- One injection per divergence event: the engine marks the dash conflicted-and-notified and does not re-inject on subsequent wakes until the dash becomes current or the base moves again.
- Multiple bound sessions: `bound_sessions_for` already orders `last_used_at DESC`; the first live row wins.

#### [P06] No bound agent, no motion (DECIDED) {#p06-no-agent-fallback}

**Decision:** With no live bound session, a conflicted replay does nothing but mark: the dash reads behind/conflicted in the lane, and the landing-time ladder remains exactly today's fallback. A *clean* replay still proceeds — it needs no agent.

**Rationale:**
- The brief answers this question itself: "the fallback is today's landing-time ladder, which is exactly why the ladder stays."
- A clean replay is precisely what a clean landing would compute anyway; requiring an agent for it would make the common case worse for parked dashes.

**Implications:**
- The lane must distinguish "behind, will replay" from "conflicted, needs a session" — the `base_ahead` + conflict fields in Spec S04 carry both.

#### [P07] Quiet, never silent (DECIDED) {#p07-quiet-never-silent}

**Decision:** A clean replay interrupts nobody. Its record is the `replayed` dash-log line and a settled mark on the dash's lane row (and the data for any other surface via the snapshot). No dialog, no toast, no turn.

**Rationale:**
- The brief: "clean replays are silent" is the goal, but silence about history rewriting itself is its own hazard — "probably a settled, glanceable mark rather than an interruption." Decided as exactly that.

**Implications:**
- `DashDetail` carries `last_replay` (Spec S04) read from the dash-log's most recent `replayed` line for the current generation, so the mark survives restarts and re-derives from the same append-only record everything else does.

#### [P08] Default on, with a per-repo escape (DECIDED) {#p08-default-on}

**Decision:** The engine is on by default. `git config tugdash.autoreplay false` (read at the repo the workspace watches) disables automatic motion for that repository; the CLI verb and the marks keep working.

**Rationale:**
- The doctrine is the default: a landing problem surfaces when it becomes true. An opt-in flag would make the designed behavior the exception.
- The strict gate ([P02]) plus the CAS ([P03]) bound the blast radius of "on"; the escape exists for repos where any automatic ref motion is unwelcome.

**Implications:**
- The config is read per wake (cheap, one `git config` read) so flipping it needs no restart.

#### [P09] The live overlap rides the recompute (DECIDED) {#p09-overlap-on-recompute}

**Decision:** Divergence source 2 — base-checkout dirt intersecting the dash's files — is computed in `dash_detail_entries_in` (which already reads both trees on every aggregate recompute) and shipped as `base_overlap` on `DashDetail`. It is a warning mark, not a trigger: the engine never acts on it.

**Rationale:**
- The join preflight's `blocking_base_dirt` already computes exactly this intersection at landing time; this moves the same read to the moment the overlap appears, which the brief names as "usually the moment the dash's round touches that file, hours before the join."
- Acting (auto-carrying, auto-stashing) on someone's uncommitted base edits is not the machine's call; saying so early is.

**Implications:**
- `dash_detail_entries_in` gains one intersection over data it already holds (the dash's changed files) plus the base's dirty tracked paths — one `git diff --name-only HEAD` per recompute against the base, shared across dashes.

#### [P10] An injected turn gets a system-origin opener row (DECIDED) {#p10-system-origin-opener}

**Decision:** Every server-injected turn renders in the transcript as a **distinct system-origin row** carrying the injected text, visibly attributed to Tug rather than to the user. tugcast emits a new opener frame (Spec S05) alongside the injection; the deck's `code-session-store` allowlist gains it beside `wake_started` and `assistant_opener`, and it opens a turn whose head row is the notice.

**Rationale:**
- **Without this the turn is invisible.** `add_user_message` is emitted only by tugcode's JSONL replay translator (`tugcode/src/replay.ts`) and its mid-turn snapshot path; on the live path the transcript's user row comes from the composer's own optimistic echo of what *it* submitted. An injected frame gets neither, so the agent would begin working — assistant text, tool calls, commits — with no visible cause, and the prompt would materialize only on a later reload when the JSONL is replayed. That is strictly worse than the landing-time ambush this plan replaces.
- Attributing it to the user instead (emitting an `add_user_message`) would be cheaper but would put words in the user's mouth in their own transcript, and would make the reload rendering and the live rendering agree on something false.
- The vocabulary already has the right shape: `wake_started` and `assistant_opener` are both non-user turn openers admitted by the store's allowlist, so this is one more member of an existing family rather than a new concept ([D15]'s `add_<kind>` template).

**Implications:**
- Three coordinated edits, and the tugcode inbound-message allowlist is *not* one of them — this frame travels tugcast → client on CODE_OUTPUT, never client → tugcode.
- The deck must treat the row as ink that survives reload: since the JSONL records the injection as a user entry, the replay translator will synthesize an `add_user_message` for it on reload. The opener's text and the replayed row must not double up — the reload path renders the JSONL row, the live path renders the opener, and they occupy the same position in the turn.
- This is the first server-initiated turn in the system. The Reporter, despite also touching CODE_INPUT, only *subscribes* to submissions (`reporter.rs`: "the CODE_INPUT submission broadcast: what the human actually asked") and posts to the Gazette — it never drives a session, so it is a precedent for reading that feed, not for writing it.

#### [P11] A replay under a live plan run tells the agent its context moved (DECIDED) {#p11-notify-stale-context}

**Decision:** The engine replays between turns even while the dash is mid-plan (stage `implementing`), and immediately follows a successful replay with a short injected notice turn ([P05]'s machinery, [P10]'s rendering) naming the new base tip and the files the replay brought in — but only when a live bound session exists and the dash is mid-plan. A replay on a parked or built dash notifies nobody.

**Rationale:**
- Deferring until a plan run finishes would leave a dash behind for the whole run — hours — which is exactly the ambush this plan exists to remove.
- Replaying silently is the real hazard (Risk R03): the agent's context holds pre-replay file contents, so its next edit can silently revert base changes it never saw. Telling it is cheap and repairs the hazard rather than avoiding it.
- The notice is not a request to do anything — it is context. The agent's next step proceeds normally, now knowing to re-read what moved.

**Implications:**
- The notice names changed paths (`git diff --name-only <old-base>..<new-base>` intersected with nothing — the full base delta is what the agent's context may be stale about) and says explicitly that no action is required.
- It is subject to the same idle rule and one-per-divergence-event latch as the conflict injection.

---

### Deep Dives {#deep-dives}

#### The engine's shape inside tugcast {#engine-shape}

The precedent is `draft_engine.rs`: a component beside the supervisor that reacts to signals, resolves against the latest snapshot, and spawns detached blocking work. The base-motion engine (`tugcast/src/feeds/base_motion.rs`) holds: a subscription to the shared GIT_HEAD broadcast; a handle to the workspace registry (workspace key → repo dir); the supervisor's ledger (for `turn_active`) and control channel (for injection); and per-dash state — `current | behind | replaying | conflicted{notified: bool}` — plus an in-flight lock. On wake (a GIT_HEAD signal for a workspace, or a `turn_complete` hook for a session bound to a behind dash): read `tugdash.autoreplay`; enumerate dashes via `dash_detail_entries_in`; for each, compute behindness from refs (`git merge-base <branch> <base>` vs `rev-parse <base>`); apply the [P02] gate; spawn `replay_onto` on `spawn_blocking`; on completion, fire the aggregate bump (`changeset_all` recompute) so the snapshot and marks refresh.

The `turn_complete` re-wake rides the supervisor's existing turn lifecycle: where the merger flips `entry.turn_active = false` (agent_supervisor.rs), notify the engine with the session id; the engine checks whether that session is bound to a behind or conflicted dash and wakes if so.

#### What the injected turn asks the agent to do {#injected-turn-contract}

The turn's work happens in ordinary git, in the dash worktree, visible in the session. Sequence the message prescribes: `git -C <worktree-abs> rebase <base-branch>`; resolve each conflict in place with full knowledge of both sides (the message carries the stopping round's subject and the conflicting paths; the working tree carries the markers); `git rebase --continue` until done; run the dash's tests if the plan names any; finish with `tugutil dash replay <name> --json`, which now finds the branch already descending from the base tip and performs bookkeeping only (the `recorded` outcome in Spec S01). If the agent judges the rebase wrong to finish (the conflict reveals a real design collision), it aborts (`git rebase --abort`), says so in the session, and the dash simply stays behind — the landing-time ladder still exists.

`tugutil` inside a dash worktree resolves to the `~/.local/bin` symlink pointing at the base checkout's build — for this verb that is correct (the verb operates on the shared repo state), but the message uses the bare `tugutil` spelling deliberately and the verb must work identically from either root (it goes through `main_repo_root` normalization like `join_in` does).

**What injection does and does not buy.** Sending the frame down `code_input_tx` gets the server-side half of an ordinary turn for free — `dispatch_one`'s `user_message` intercept mints a `journal_id`, writes a pending row, flips `turn_active`, and spawns the session if it is idle, all identical to a client submission. What it does **not** buy is a row on screen. The transcript's live user row comes from the composer echoing its own submission; the only frames that open a turn from the wire are `add_user_message` (emitted solely by tugcode's JSONL replay translator in `tugcode/src/replay.ts` and its mid-turn snapshot path), `wake_started`, and `assistant_opener`. So an injection with no opener produces assistant output with no visible cause, and the prompt appears only on a later reload when the JSONL is replayed. [P10] and Spec S05 are that missing half, and they are not optional polish — without them this feature is a worse ambush than the one it replaces.

#### Why the app-test cannot move the base {#apptest-no-base-motion}

App-tests run against the live repository. Base motion means commits landing on the developer's `main` — not acceptable from a test, and resetting `main` afterwards is exactly the class of act that once destroyed work here. So: everything involving actual branch motion is covered at the Rust layer in tempdir repos (the `resolve.rs` test module's `init()` pattern), and the app-test covers the one divergence surface that is safe to fake live — `base_overlap`, produced by touching a file on the base that a fixture dash also changed, and reverted with `tugutil file probe`-equivalent hygiene (write, assert, restore bytes and mtime).

---

### Specification {#specification}

**Spec S01: `replay_onto` and the CLI verb's outcomes** {#s01-replay-outcome}

```rust
// tugrust/crates/tugdash-core/src/replay.rs
pub enum ReplayOutcome {
    /// The branch moved. `mapping` pairs each old round with its replayed
    /// commit, oldest first. `bookkeeping_commit` is the remap round, when
    /// a plan ledger had cells to rewrite.
    Replayed { base_head: String, mapping: Vec<(String, String)>, bookkeeping_commit: Option<String> },
    /// The branch already descends from the base tip; bookkeeping was
    /// reconciled (possibly a no-op). `remapped` names rewritten cells.
    Recorded { base_head: String, remapped: Vec<String>, unmapped: Vec<String> },
    /// A round conflicts against the moved base. Nothing was touched.
    Conflicted { base_head: String, round: String, round_subject: String, paths: Vec<String> },
    /// The base has not moved past the dash's merge-base. Nothing to do.
    Current,
    /// A precondition failed; nothing was touched. `reason` is one of
    /// "dirty-worktree" | "no-worktree" | "join-journal" | "tip-moved"
    /// | "no-rounds" | "git-too-old".
    Deferred { reason: String, detail: String },
}

pub fn replay_onto(repo_root: &Path, name: &str) -> Result<ReplayOutcome, String>;
```

`tugutil dash replay <name> [--json]` prints the outcome; exit 0 for `Replayed`/`Recorded`/`Current`, exit 1 for `Conflicted` and `Deferred` (they name what to do). The JSON is the serde form of the enum, tagged `outcome`.

**Spec S02: the dash-log `replayed` line** {#s02-dashlog-line}

One line via `append_dash_log(repo_root, name, "replayed", note)`. The note grammar: `onto <base-short>: <old-short>-><new-short>[, ...]` for an engine replay; `onto <base-short>: by rebase[, remapped <cell-short>...][, unmapped <cell-short>...]` for a `Recorded` reconciliation. Notes are single-line by `append_dash_log`'s construction. `read_declarations` must ignore the marker (pinned by a test), and `is_terminal` must not match it.

**Spec S03: the injected turn's message** {#s03-turn-message}

Plain text, composed by the engine:

```
[base-motion replay] The base branch <base> moved to <base-short> under dash "<name>",
and replaying its rounds stopped at <round-short> "<round-subject>" with conflicts in:
<path list>

This dash's intent:
<resolve_intent(repo, base, branch) — the maintained draft + round subjects>

Resolve it on the dash's own worktree:
  git -C <worktree-abs> rebase <base>
Fix each conflict with both sides in view, then `git rebase --continue`. When the
rebase is done, run `tugutil dash replay <name> --json` to record the moved rounds.
If the conflict reveals a real design collision instead, `git rebase --abort` and say so.
```

**Spec S04: divergence fields on the snapshot** {#s04-snapshot-fields}

`DashDetail` (ops.rs) gains:

```rust
/// Commits on the base branch past this dash's merge-base — 0 when current.
pub base_ahead: u32,
/// Base-checkout dirty tracked paths that intersect this dash's changed files.
pub base_overlap: Vec<String>,
/// The note of the dash-log's most recent `replayed` line for the current
/// generation, when one exists — the settled mark's text.
pub last_replay: Option<String>,
/// Set when the engine's last probe of this dash stopped on a conflict:
/// the conflicting paths. Empty when unknown or clean.
pub replay_conflict_paths: Vec<String>,
```

`tugdeck/src/lib/changeset-types.ts`'s dash entry mirrors them as optional fields (`base_ahead?: number; base_overlap?: string[]; last_replay?: string; replay_conflict_paths?: string[]`) with absent-tolerant parsing, matching how `plan_path` and `worktree_abs` were added. `replay_conflict_paths` is derived in tugcast at compose time from the engine's per-dash state (the library stays stateless); `base_ahead`, `base_overlap`, `last_replay` are computed in `dash_detail_entries_in` so the CLI and the card cannot drift.

**Spec S05: the system-origin turn opener** {#s05-system-opener}

The frame that makes an injected turn visible ([P10]). tugcast emits it on the session's CODE_OUTPUT path at the moment it injects, before the agent's first output:

```jsonc
{
  "tug_session_id": "…",
  "type": "tug_notice",          // a turn opener, sibling to wake_started / assistant_opener
  "origin": "base-motion",       // which subsystem spoke; the row's attribution label
  "text": "…"                    // the same body the injection carried
}
```

Client side, in `tugdeck/src/lib/code-session-store.ts`: add `"tug_notice"` to the accepted-event allowlist beside `"wake_started"` and `"assistant_opener"`, minting a `turnKey` in the impure wrapper exactly as those two do (the reducer stays pure — it never calls `crypto.randomUUID()`). The reducer opens a turn whose head row is the notice, rendered as a distinct system-origin row: visibly not a user bubble, carrying `origin` as its label.

Reload equivalence: the JSONL records the injection as an ordinary user entry, so on reload the replay translator synthesizes an `add_user_message` in the same turn position. The live opener and the replayed user row are therefore two renderings of one submission — the transcript must show one row there, not two.

Deliberately **not** extended: the tugcode inbound-message allowlist (`tugcode/src/types.ts`) — this frame travels tugcast → client, never client → tugcode — and `REPORTER_FORWARD_ALLOWLIST` in `reporter_wake.rs`, because a notice is Tug talking about its own bookkeeping, not narratable news about the work.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `base_ahead` / `base_overlap` / `last_replay` / `replay_conflict_paths` on the dash entry | structure (server-derived snapshot) | existing changeset store + `useSyncExternalStore` | [L02] |
| The lane mark's visual states (settled / behind / overlap / conflicted) | appearance | CSS classes driven by the entry fields at render | [L06] |
| The `tug_notice` turn row (Spec S05) | structure (transcript ink) | `CodeSessionStore` reducer event, `turnKey` minted in the impure wrapper | [L02] |

No new client-held state; no new store — the notice row is transcript data reduced by the existing session store, and its appearance is CSS.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugdash-core/src/replay.rs` | `replay_onto`, `ReplayOutcome`, bookkeeping (log line + ledger reconcile), and their tests |
| `tugrust/crates/tugcast/src/feeds/base_motion.rs` | The engine: subscription, gate, per-dash state, injection composition |
| `tests/app-test/at0427-dash-divergence-marks.test.ts` | The overlap mark, live and reverted |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `replay_probe` | fn (modify) | `tugdash-core/src/resolve.rs` | returns `Option<ReplayedRounds>` (head + old→new pairs); `resolve_conflicts` reads `.head`, behavior unchanged |
| `ReplayedRounds` | struct | `tugdash-core/src/resolve.rs` | `head: String, mapping: Vec<(String, String)>` |
| `replay_onto`, `ReplayOutcome` | fn/enum | `tugdash-core/src/replay.rs` | Spec S01 |
| `reconcile_ledger_cells` | fn | `tugdash-core/src/replay.rs` | exact-mapping and unique-subject modes ([P04], R04) |
| `rewrite_ledger_commit_cell` | fn | `tugrust/crates/tugutil-core/src/plan.rs` (or beside `set_ledger_status`) | rewrite a row's commit cell without touching status |
| `base_ahead`, `base_overlap`, `last_replay`, `replay_conflict_paths` | fields | `tugdash-core/src/ops.rs` `DashDetail` | Spec S04 |
| `DashCommands::Replay` | CLI verb | `tugutil/src/cli.rs`, `tugutil/src/dash.rs` | `tugutil dash replay <name> [--json]` |
| `run_base_motion_engine` | fn | `tugcast/src/feeds/base_motion.rs` | spawned from server wiring in `main.rs` beside the registry; holds a `code_input_tx` clone |
| `decide_for_dash` | fn (pure) | `tugcast/src/feeds/base_motion.rs` | the gate + action decision with no IO, testable directly (the `reporter_wake.rs` pattern) |
| `tug_notice` opener | frame + reducer event | `tugcast` emit side; `tugdeck/src/lib/code-session-store.ts` allowlist | Spec S05, [P10] — what makes an injected turn visible |
| turn-complete hook | wiring | `tugcast/src/feeds/agent_supervisor.rs` | notify the engine where `turn_active` flips false |
| `main_repo_root` | fn (visibility) | `tugdash-core/src/ops.rs` | currently module-private; make `pub(crate)` so `replay.rs` can normalize roots the way `join_in` does |
| dash entry fields | types | `tugdeck/src/lib/changeset-types.ts` | Spec S04, absent-tolerant |
| lane divergence mark | component | `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` | settled / behind / overlap / conflicted |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/dash-work-doctrine.md`: a "When the base moves" section — the doctrine line, the gate, the quiet-never-silent mark, the conflicted-turn contract, the rule that **no server-initiated turn is ever unannounced** ([P10]), the mid-plan notice ([P11]), the ladder as fallback, `tugdash.autoreplay`.
- [ ] `roadmap/join-assessment.md`: strike suggested-order item 3 as addressed, pointing here.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `replay_onto` outcomes, the CAS, bookkeeping, marker tolerance, message composition | tempdir repos per `resolve.rs`'s `init()` pattern |
| **Integration** | engine gate + wake + injection at the supervisor test layer; CLI round-trips in `changes_cli.rs` | end-to-end without an app |
| **App-test** | the overlap mark renders in the lane | the one divergence surface safe on the live repo |

#### What stays out of tests {#test-non-goals}

- Base motion in an app-test — moving the live repo's `main` is forbidden; covered in tempdir repos at the Rust layer (see #apptest-no-base-motion).
- The agent actually performing a rebase — a real-model flow; the contract is pinned by composing and asserting the injected message and the `Recorded` bookkeeping path it ends with.
- Mock-store or fake-DOM render tests — banned shapes; the lane mark is asserted in the real app.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The probe reports what it rebuilt | done | `dbc1648ce` |
| #step-2 | `replay_onto`: the gate and the move | done | `81296ebc5` |
| #step-3 | Bookkeeping: the log line and the ledger reconcile | done | `84d64251a` |
| #step-4 | The CLI verb | done | `4027eeef0` |
| #step-5 | Divergence fields on the snapshot | done | `5d43cd83b` |
| #step-6 | The engine: wake, gate, replay, bump | done | `1427ddf5c` |
| #step-7 | The conflicted path becomes a turn | done | `eaea17172` |
| #step-8 | The deck — the notice row and the divergence marks | done | `74b5bfaab` |
| #step-9 | Doctrine prose | done | `d5c4a8fec` |
| #step-10 | Integration checkpoint | done | `c82bf5e79` |

#### Step 1: The probe reports what it rebuilt {#step-1}

**Commit:** `tugdash-core(resolve): the replay probe reports each round it rebuilt`

**References:** [P03] CAS reset, Spec S01, (#context, #engine-shape)

**Artifacts:**
- `ReplayedRounds { head, mapping }` returned by `replay_probe`; `resolve_conflicts` unchanged in behavior.

**Tasks:**
- [ ] In `tugrust/crates/tugdash-core/src/resolve.rs`, change `replay_probe`'s return from `Option<String>` to `Option<ReplayedRounds>`, collecting `(round, new_commit)` pairs as its existing loop calls `commit_tree` per round. Make it `pub(crate)`.
- [ ] `resolve_conflicts` destructures `.head` where it used the string; the `ResolveOutcome` it returns is byte-identical to before.

**Tests:**
- [ ] Extend `replay_probe_resolves_base_already_advanced_and_lands_replay_shape`: assert the mapping has one pair per round, oldest first, each `new` reachable from the returned head and each `old` the original round SHA.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 2: `replay_onto`: the gate and the move {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash-core(replay): replay a dash's rounds onto a moved base, compare-and-swap, touching nothing on refusal`

**References:** [P02] safety gate, [P03] CAS reset, Spec S01, Risk R01, Risk R02, (#engine-shape)

**Artifacts:**
- `tugrust/crates/tugdash-core/src/replay.rs` with `replay_onto` and `ReplayOutcome` (Spec S01), exported from `lib.rs`.

**Tasks:**
- [ ] Preconditions in order, each producing its `Deferred`/`Current` outcome: branch exists; git ≥ 2.40 (`git_supports_merge_base_flag`); no join journal (`read_join_journal`); worktree exists (`no-worktree` when the branch outlived its worktree) and `git status --porcelain` empty; base ahead of the merge-base (else `Current`); rounds exist.
- [ ] Normalize the incoming root with `main_repo_root` exactly as `join_in` and `join_preflight_in` do, so a call from inside a dash worktree operates on the repository. It is module-private in `ops.rs` today — widen it to `pub(crate)` rather than reimplementing it (`tugutil_core::find_repo_root_from` with a fallback is the whole body).
- [ ] Detect the already-moved case first: when `git merge-base --is-ancestor <base-tip> <branch>` holds, return the `Recorded` path (bookkeeping only — wired in #step-3; here it returns `Recorded` with empty lists).
- [ ] Run `replay_probe` against the current base tip. `None` → collect the stopping round by re-running the per-round loop far enough to name it (or return it from the probe alongside `None` — implementer's choice, but `Conflicted` must carry `round`, `round_subject`, and `paths` from `merge-tree`'s conflicted-file section for that round).
- [ ] The move ([P03]): inside the worktree, re-verify clean, CAS the tip against the value the probe read, `git reset --keep <head>`. Refusal at any point → `Deferred { reason: "tip-moved" | "dirty-worktree", .. }` with nothing touched.

**Tests:** (in `replay.rs`'s `mod tests`, tempdir repos per `resolve.rs`'s `init()` pattern, but with a real linked worktree via `git worktree add`)
- [ ] A clean replay moves the branch: worktree HEAD is the new head, rounds sit above the new base tip, worktree is clean after.
- [ ] A dirty worktree defers, touching nothing (tip unchanged, dirt intact).
- [ ] A conflicting round yields `Conflicted` naming the round and paths, tip unchanged.
- [ ] A tip that moves between probe and reset (simulated by committing a round after the probe ran — factor the probe/move seam to make this drivable) defers with `tip-moved`.
- [ ] An unmoved base yields `Current`; a base already under the branch yields `Recorded`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 3: Bookkeeping: the log line and the ledger reconcile {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash-core(replay): record moved rounds in the dash-log and reconcile the plan ledger's commit cells`

**References:** [P04] bookkeeping, Spec S02, Risk R04, (#s02-dashlog-line)

**Artifacts:**
- The `replayed` dash-log line; `reconcile_ledger_cells`; `rewrite_ledger_commit_cell` beside `set_ledger_status` in `tugutil-core`'s plan module; the remap round commit.

**Tasks:**
- [ ] `rewrite_ledger_commit_cell(source, anchor, sha)` — rewrites one row's commit cell, leaving status untouched (read `set_ledger_status` first; reuse its row location, not its status write).
- [ ] `reconcile_ledger_cells`: with an exact mapping (engine replay), rewrite every cell whose short SHA prefixes an old round; without one (`Recorded` after a rebase), rewrite only cells whose SHA is absent from the branch *and* whose row can be matched to exactly one branch round by commit subject — collect the rest as `unmapped` (Risk R04).
- [ ] When any cell changed: write atomically (the `write_atomic` pattern in `ops.rs`), then commit the worktree with message `tugdash(<name>): remap round ids after base replay`. Note `commit_worktree_dirt` cannot be reused as-is — it hardcodes the subject `join: commit outstanding changes` — so this needs its own `git add -A` + `git commit -m`, following that function's shape (skip silently when `status --porcelain` is empty, surface a failed add/commit as an `Err`).
- [ ] Append the Spec S02 log line in both modes. Wire both into `replay_onto`'s `Replayed` and `Recorded` arms.

**Tests:**
- [ ] After an engine replay with a recorded plan, every ledger commit cell resolves on the branch and the bookkeeping commit exists with the exact message.
- [ ] Subject-match reconciliation rewrites a unique match, leaves a duplicated subject unmapped, and the log line names both.
- [ ] `read_declarations` over a log containing a `replayed` line derives the same declarations as without it; `derive_stage` is unaffected.
- [ ] No plan recorded → no commit, log line still written.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil-core`

---

#### Step 4: The CLI verb {#step-4}

**Depends on:** #step-3

**Commit:** `tugutil(dash): a replay verb — move a behind dash onto its base, or record a rebase already made`

**References:** [P05] the finishing verb, Spec S01, (#injected-turn-contract)

**Artifacts:**
- `tugutil dash replay <name> [--json]` in `tugutil/src/cli.rs` + `tugutil/src/dash.rs`; human output per outcome.

**Tasks:**
- [ ] Wire the verb to `replay_onto` through the same root normalization `join` uses (`main_repo_root`), so it behaves identically from the base checkout and from inside a dash worktree.
- [ ] Exit codes and JSON per Spec S01. Human text: `Replayed` prints the pairs; `Conflicted` prints the round, paths, and the rebase instruction; `Deferred` prints the reason.

**Tests:** (in `tugutil/tests/changes_cli.rs`, using its `add_dash_worktree` helper)
- [ ] Round-trip: create a dash with rounds, move the base, `dash replay --json` → `outcome: "replayed"`, branch re-based, dash-log line present.
- [ ] Rebase-then-record: move the base, rebase the dash branch by hand in the fixture, `dash replay --json` → `outcome: "recorded"`.
- [ ] Conflicted exits 1 and names the paths; nothing moved.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`

---

#### Step 5: Divergence fields on the snapshot {#step-5}

**Depends on:** #step-3

**Commit:** `tugdash-core(detail): a dash's snapshot says how far its base has moved, what overlaps, and what was replayed`

**References:** [P07] quiet never silent, [P09] overlap on recompute, Spec S04, (#s04-snapshot-fields)

**Artifacts:**
- `base_ahead`, `base_overlap`, `last_replay` computed in `dash_detail_entries_in`; `replay_conflict_paths` plumbed as a compose-time input (defaulting empty) for tugcast to fill in #step-6.

**Tasks:**
- [ ] `base_ahead`: `rev-list --count <merge-base>..<base>` per dash.
- [ ] `base_overlap`: intersection of the base checkout's dirty tracked paths with the dash's `files` — the same predicate family as `blocking_base_dirt`, but over the full dirty set and non-blocking. **Hoist the base read above the per-dash loop.** `dash_detail_entries_in` is a `for branch in branches` loop and already spends ~6 git invocations per dash per recompute; the base's dirty set is one `git diff --name-only HEAD` for the whole repository, so read it once before the loop and intersect per dash. Recomputes are bump-driven with a 150 ms coalescing floor (`BUMP_FLOOR` in `changeset_all.rs`) and there is no poll, so every added invocation is paid per real filesystem event.
- [ ] `last_replay`: the most recent `replayed` line's note for the current generation, read the way `read_declarations` scopes generations (discard at terminal lines).
- [ ] Serialize through tugcast's snapshot compose into the changeset frame; extend `tugdeck/src/lib/changeset-types.ts`'s dash entry with the optional fields and absent-tolerant parsing.

**Tests:**
- [ ] A fixture with a moved base reports `base_ahead > 0`; current reports 0.
- [ ] A base edit to a dash-changed file appears in `base_overlap`; an edit to an untouched file does not.
- [ ] After a replay, `last_replay` carries the Spec S02 note.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 6: The engine: wake, gate, replay, bump {#step-6}

**Depends on:** #step-2, #step-5

**Commit:** `tugcast(base-motion): replay a behind dash the moment its base moves, under the safety gate`

**References:** [P01] one watcher, [P02] safety gate, [P08] default on, Risk R02, Risk R05, (#engine-shape)

**Artifacts:**
- `tugcast/src/feeds/base_motion.rs`; server wiring beside the workspace registry; per-dash state feeding `replay_conflict_paths` at compose.

**Tasks:**
- [ ] **Split the decision from the wiring**, the way `reporter_wake.rs` does ("Rust decides *when*… this module is the whole of the first half plus the parsing of the second, and it is deliberately pure"). Write `decide_for_dash(inputs) -> Decision` with no IO: inputs are the dash's name, behindness, worktree-clean, journal-present, bound-session ids with their `turn_active` flags, the `autoreplay` flag, and the in-flight/notified state; output is `Skip | Replay | ReplayThenNotify(session) | InjectConflict(session) | MarkOnly`. Every gate case is then a table test rather than a spun-up server.
- [ ] Wiring: subscribe to the shared GIT_HEAD channel (`gh_response_tx` handed out by `workspace_registry.rs`); resolve `workspace_key` → repo dir via the registry; hold clones of the aggregate `bump` `Notify` and the `code_input_tx` sender from `main.rs`.
- [ ] **The initial sweep** ([P01]): evaluate every dash in a workspace when the engine first sees that workspace — at startup and when the registry creates a fresh entry — because `run_git_workspace_watch` baselines `last_head` at task start and broadcasts only on a move past it, so an already-behind dash would otherwise never wake. The sweep is a wake with no signal attached and shares the whole path.
- [ ] On wake: read `tugdash.autoreplay` (skip when `false`); enumerate via `dash_detail_entries_in`; per dash compute behindness from refs; feed `decide_for_dash`. Worktree-clean and journal-free are re-checked inside `replay_onto` (single source of truth); the engine supplies the session half — `bound_sessions_for`-equivalent query against the instance's `sessions.db` plus the supervisor ledger's `turn_active`.
- [ ] Per-dash in-flight lock; `spawn_blocking(replay_onto)`; on any non-`Current` completion fire the aggregate bump so the snapshot refreshes; hold `Conflicted` results in the per-dash state for compose and for #step-7.
- [ ] The `turn_complete` re-wake: where the supervisor flips `turn_active` to false, send the session id to the engine; wake if that session is bound to a behind/conflicted dash.

**Tests:** (`decide_for_dash` as table tests; the wiring against tempdir repos, no live app)
- [ ] `decide_for_dash` table: behind+clean+idle → `Replay`; behind+clean+idle+mid-plan+bound → `ReplayThenNotify`; dirty worktree → `Skip`; any bound session mid-turn → `Skip`; journal present → `Skip`; conflicted+no session → `MarkOnly`; conflicted+idle session+not yet notified → `InjectConflict`; conflicted+already notified at this base tip → `MarkOnly`.
- [ ] A synthesized GIT_HEAD signal for a workspace with a behind dash and no bound sessions runs a clean replay end-to-end: branch moved, dash-log line written, bump fired.
- [ ] The initial sweep replays a dash that was already behind before the engine started — no signal is ever sent.
- [ ] `tugdash.autoreplay false` defers everything.
- [ ] A second signal during an in-flight replay does not start a second one.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 7: The conflicted path becomes a turn {#step-7}

**Depends on:** #step-4, #step-6

**Commit:** `tugcast(base-motion): a conflicted replay becomes an ordinary turn in the dash's bound session`

**References:** [P05] conflict becomes turn, [P06] no-agent fallback, [P10] system-origin opener, [P11] notify stale context, Spec S03, Spec S05, Risk R03, (#injected-turn-contract)

**Depends on #step-4** because the turn's contract ends with `tugutil dash replay <name>` — the verb that step ships. Without it the injected message instructs the agent to run a command that does not exist.

**Artifacts:**
- Injection through the `code_input_tx` sender; the Spec S03 conflict message and the [P11] notice message, both composed in `base_motion.rs`; the Spec S05 `tug_notice` frame emitted on CODE_OUTPUT; park-and-retry; the notified latch.

**Note:** this step completes the server half. The turn is not *visible* until #step-8 teaches the deck to render `tug_notice` — that is the ordering, and the feature is not done at this step's checkpoint.

**Tasks:**
- [ ] Inject by sending a frame down the `code_input_tx` `mpsc::Sender<Frame>` cloned from `main.rs` — the same queue the router feeds — with the payload `parse_tug_session_id` and `InspectedPayload::from_slice` already read: `{tug_session_id, type: "user_message", content: [{type: "text", text}]}`. The dispatcher's existing intercept then journals the pending turn, flips `turn_active`, and spawns the session if idle; no new supervisor method is required, and going through the queue rather than calling `dispatch_one` directly keeps injected and client submissions in one order.
- [ ] Emit the Spec S05 `tug_notice` frame on the session's CODE_OUTPUT path at injection time, carrying `origin: "base-motion"` and the same body ([P10]).
- [ ] Compose the Spec S03 conflict message from the `Conflicted` outcome plus `resolve_intent(repo, base, branch)` (resolve.rs) and the dash's `worktree_abs`.
- [ ] Compose the [P11] notice message after a successful mid-plan replay: the new base tip, the base delta's paths, and an explicit "no action required".
- [ ] Target the most recently used live bound session; if it is mid-turn, park and retry on its turn-complete wake; if none exists, do nothing beyond the marks ([P06]).
- [ ] Latch `notified` per (dash, base tip): one injection per divergence event; a new base tip resets the latch.

**Tests:**
- [ ] An injected frame produces a pending journal row and flips `turn_active`, indistinguishable from a client submission (mirror the existing `dispatch_one_inserts_journal_row_without_augmenting_frame` shape).
- [ ] Every injection emits exactly one `tug_notice` frame carrying the same text, so no injected turn can reach a client unannounced.
- [ ] A conflicted outcome with an idle bound session injects exactly once (a second wake at the same base tip injects nothing); with a busy session it parks and injects on turn-complete; with no session it only marks.
- [ ] The composed conflict message contains the round subject, every conflicted path, the worktree-absolute rebase command, and the finishing `tugutil dash replay` line; the composed notice message names the base delta's paths.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 8: The deck — the notice row and the divergence marks {#step-8}

**Depends on:** #step-5, #step-7

**Commit:** `tugways(dash-lane): render the base-motion notice and the divergence marks`

**References:** [P07] quiet never silent, [P09] overlap, [P10] system-origin opener, Spec S04, Spec S05, (#state-zone-mapping, #apptest-no-base-motion)

**Artifacts:**
- `tug_notice` in the `code-session-store` allowlist and its reducer path; the notice row's rendering; marks on the dash row in `session-changes-dash-lane.tsx`; `tests/app-test/at0427-dash-divergence-marks.test.ts` with `@covers` for the lane file, the store, and `ops.rs`.

**Tasks:**
- [ ] Add `"tug_notice"` to the accepted-event allowlist in `tugdeck/src/lib/code-session-store.ts`, beside `"wake_started"` and `"assistant_opener"`, minting the `turnKey` in the impure wrapper exactly as those two do so the reducer stays pure (Spec S05).
- [ ] Render the notice as a distinct system-origin turn row — visibly not a user bubble, labelled from `origin`. It is transcript ink, so it must survive a reload: verify against the replayed `add_user_message` the JSONL produces for the same submission that the turn shows **one** head row, not two.
- [ ] Render the lane marks from the entry fields: `last_replay` → a settled, glanceable mark (muted, no interruption); `base_ahead > 0` → "base +N"; `base_overlap` non-empty → a warning mark naming the count, with the paths in the row's expanded detail; `replay_conflict_paths` non-empty → the conflicted state, naming the paths.
- [ ] Compose existing Tug* components for the mark (a `TugBadge`-family element, per the lane's existing dash-name badge) — no hand-rolled chrome.
- [ ] Verify against tuglaws: the notice row and the marks are structure, entering React through the existing store subscriptions [L02]; the marks' visual states are CSS classes, never React state [L06]. Name the laws in the commit body.

**Tests:**
- [ ] `at0427`: fixture dash changing a known file; write a base edit to that same file; assert the overlap mark appears with the count; restore the base file bytes+mtime; assert the mark clears on the next recompute. `scrollIntoView({ block: "center" })` before any row interaction (the at0425 lesson).
- [ ] A `tug_notice` frame delivered to a live session card renders one system-origin row carrying its text and is not attributed to the user — driven through the real store, not a fake DOM.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test-changed`

---

#### Step 9: Doctrine prose {#step-9}

**Depends on:** #step-7, #step-8

**Commit:** `tuglaws(dash-work-doctrine): when the base moves — the replay, the gate, and the turn it becomes`

**References:** [P02], [P05], [P06], [P07], [P08], [P10], [P11], (#documentation-plan)

**Artifacts:**
- The "When the base moves" section in `tuglaws/dash-work-doctrine.md`; `roadmap/join-assessment.md` suggested-order item 3 struck as addressed.

**Tasks:**
- [ ] Write the doctrine: the doctrine line itself, what replays and when, the gate's four conditions, quiet-never-silent, the conflicted-turn contract (including that the agent may abort and say so), the standing rule that a server-initiated turn always carries a visible system-origin opener ([P10]) and that a mid-plan replay tells the agent its context moved ([P11]), the ladder as the standing fallback, and `tugdash.autoreplay`.
- [ ] Update the brief: item 3 **addressed**, pointing at this plan; refresh the closing "next piece of work" line.

**Tests:**
- [ ] None (prose).

**Checkpoint:**
- [ ] `tugutil plan lint roadmap/base-motion-replay-plan.md` still exits 0 (the ledger edits of the run have not broken the document).

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-4, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full workspace suite green from the recorded baseline; deck builds; selective app-tests green.
- [ ] Live smoke on the dash's own debug instance: with this plan's dash still open, land any unrelated commit on `main` (the user's act, or observe one that happens) and watch the engine replay the dash and the mark settle — or, when no organic base motion occurs, drive `tugutil dash replay` manually and verify the `Recorded`/`Current` readouts and the mark.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (workspace)
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dash whose base moves is replayed onto the new tip the moment it is safe — quietly when clean, as an ordinary reviewed agent turn when conflicted — with the motion recorded in the dash-log and the plan ledger, surfaced as glanceable marks in the dash lane, and today's landing-time ladder untouched as the fallback.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `replay_onto` covers all five outcomes with tempdir tests, and refusal paths touch nothing (`cargo nextest run -p tugdash-core`).
- [ ] `tugutil dash replay` round-trips all outcomes from the CLI (`cargo nextest run -p tugutil`).
- [ ] The engine replays a behind dash off a GIT_HEAD signal *and* off the initial sweep under the gate, and injects exactly one turn per conflicted divergence (`cargo nextest run -p tugcast`).
- [ ] Every injected turn carries a `tug_notice` opener and renders as a system-origin row, not as the user's words (`cargo nextest run -p tugcast`, `just app-test-changed`).
- [ ] The lane shows the four marks; the overlap mark is pinned live (`just app-test-changed` including `at0427`).
- [ ] Doctrine written; the brief's item 3 struck.

**Acceptance tests:**
- [ ] The engine-layer clean-replay end-to-end test and the initial-sweep test (#step-6).
- [ ] The injection tests, including "every injection emits exactly one `tug_notice`" (#step-7).
- [ ] The system-origin notice row rendering through the real store (#step-8).
- [ ] `at0427-dash-divergence-marks.test.ts`.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The tactical layer from the brief: turn-gate scope on lane controls, in-face refusal reasons, conflict archaeology.
- [ ] Queue-a-landing-for-turn-end (the brief's remaining open question).
- [ ] A lane affordance to trigger `dash replay` by click for a deferred/conflicted dash with no bound session.
- [ ] Teaching the injected turn to run the plan's own checkpoints after the rebase.

| Checkpoint | Verification |
|------------|--------------|
| Library motion + bookkeeping | `cargo nextest run -p tugdash-core -p tugutil-core` |
| CLI | `cargo nextest run -p tugutil` |
| Engine + injection | `cargo nextest run -p tugcast` |
| Deck marks | `bunx vite build`, `just app-test-changed` |

---

### Implementation Addendum {#implementation-addendum}

*Written after the plan shipped (landed on `main` as `9bfae24bd`). Where the implementation and the plan differ, this says which won and why; where the plan left a choice open, this records the one taken. Everything below is a decision a future reader would otherwise have to re-derive from the code — or worse, re-litigate.*

#### Where the implementation departed from the plan {#addendum-departures}

**The round walk has one home, and the ladder's probe delegates to it.** #step-2 offered the implementer a choice for naming the round a conflict stopped on: re-run the per-round loop, or widen `replay_probe` to return it alongside `None`. Both would have left two copies of the same `merge-tree` loop, and the engine needs strictly more from it than the ladder does. So the whole walk moved into `replay.rs` as `walk_rounds` (returning `Clean | Conflicted | Unavailable`), and `resolve.rs`'s `replay_probe` became a thin delegate over it. `resolve_conflicts`'s outcome is provably unchanged — its own tests never moved. The cost was widening `commit_tree` and `git_supports_merge_base_flag` to `pub(crate)`, and adding a `join_in_flight` predicate rather than exposing `JoinJournal`'s shape (which `-D private-interfaces` refuses anyway).

**`Current` and `Recorded` are the same condition at the ref level.** Both mean the branch already descends from the base tip; git cannot tell them apart. The distinguishing signal is the *record*, not the graph: a rebase made by hand leaves plan-ledger cells naming commits no longer on the branch. So the ancestor arm of `replay_onto` reconciles first and returns `Recorded` only when it actually repaired something, `Current` otherwise. Spec S01 reads as though the two were separately detectable; they are not.

**A plain `Replay` decision still carries the session it *would* tell.** The #step-6 decision table names a session only for `ReplayThenNotify` and `InjectConflict`. Taken literally, a first-time replay that turns out to conflict would have nobody to inject to — the dash would be marked and stay silent until a next wake that may never come. So the wiring resolves the target as the most-recently-used idle session in all three replaying arms and lets the *outcome* choose the message; `notify_on_clean` is the flag that distinguishes `ReplayThenNotify` from `Replay`. `decide_for_dash` is unchanged and still answers the question it was written to answer — whether telling is right — but it is not also the source of *whom*.

**The notified latch is keyed on the base tip, not on a boolean.** [P05] says "one injection per divergence event", and a bare `notified` flag cannot express that. With a flag, a conflicted-and-notified dash decides `MarkOnly` forever: it never runs another replay, so nothing ever resets the flag when the base moves again — the second divergence is silently swallowed. Each wake therefore reads the base tip (`rev_parse` per dash, in the same blocking hop as `dash_detail_entries_in`) and compares it against `notified_tip`. A base that moves is a new event by construction, with no reset logic to get wrong.

**The [P11] notice's file list is anchored on a pre-move round, not on the base tip alone.** "The base delta" needs the base tip the dash *used to* sit on, which `ReplayOutcome::Replayed` does not carry. It does carry `mapping`, whose oldest entry is the oldest round as it stood before the move — and that round's merge-base with the base branch *is* the old tip. So the delta is `merge-base(oldest_pre_move_round, base)..base`: exactly what the base brought in, and none of the dash's own work. With no pre-move round to anchor on, the notice says there is nothing to name rather than guessing.

**The lane marks put their paths in a tooltip, not in the row's expanded detail.** #step-8 asked for the paths in the expanded face. The expanded face is the landing surface — preview, blockers, draft — and a divergence mark is not a landing concern. The marks follow the existing `review` mark's grammar instead: count in the row, paths on hover, capped at eight with the remainder counted. If the paths later want a permanent home, the expanded detail is still the right one; this was a taxonomy call, not a capability limit.

#### Wiring the plan did not anticipate {#addendum-wiring}

**The engine needed two wake channels that did not exist.** [P01] is right that a `GitHeadSignal` is an edge and that a startup sweep covers the level — but it covers only the level *at startup*. Two cases fall through: a workspace opened later (its git watch baselines HEAD at task start, so it will never speak about motion that predates it), and a turn ending (the gate refuses mid-turn, and "the base moved during a turn" is the common shape of the whole problem). Neither had a signal. Each got a `OnceLock<mpsc::Sender<String>>` set once at boot — on `WorkspaceRegistry` (fired on a fresh non-browse entry) and on `AgentSupervisor` (fired where the merger flips `turn_active` false). Unset in every test and in any boot without the engine, where the send is simply skipped. The `OnceLock` shape is deliberate: it keeps both constructors' signatures unchanged, following `AgentSupervisor::changeset_watch`.

**`replay_conflict_paths` publishes through a process singleton rather than a threaded parameter.** It is the one Spec S04 field the library cannot derive: whether an *attempt* conflicted is knowledge only the thing that attempted has. Threading it would have meant a third parameter through `compose_snapshot`, `compose_aggregate`, and every test constructor, for a field that is empty in every configuration without an engine. Instead the running engine publishes itself to a module-level `ConflictBoard` once (`OnceLock`), and `dash_entries` reads it by owner key. There is exactly one engine per tugcast process; with no engine the reader answers empty, which is the truth in that case. This is the one place in the feature where a global was preferred to a parameter, and the reason is that the parameter would have been vestigial everywhere else.

**The notice row is a `system_note`, not a fourth transcript row kind.** Spec S05 asks for a "distinct system-origin row". The transcript's row kinds (`user | assistant | shell`) are load-bearing across addressing, ordinals, and the data source's slot walk, and adding a fourth would have rippled through all of it. `SystemNote` already existed as "subdued note inside a turn" with a `source` union and a live precedent — the wake-trigger chip, which opens a wake turn's body with what scheduled it. So `tug_notice` opens an `origin: "assistant"` turn seeded with one `source: "notice"` note carrying `noticeOrigin`. The turn renders `#a`-only with the notice at its head: visibly not a user bubble, exactly one head row, and no phantom user row. Assistant-origin rather than user-origin is the load-bearing part — attributing Tug's words to the user would put them in the user's mouth in their own transcript.

#### Constraints that bound the tests {#addendum-test-constraints}

**`at0427` can reach exactly one of the four marks, and the reason is structural.** The other three require the *base branch* to move, which in this repository means committing to the developer's real `main` — ruled out by #apptest-no-base-motion, and the class of act that has destroyed work here before. Only `base_overlap` is producible live. It is produced honestly: a real dash whose round changes a tracked file, and the same file left uncommitted in the base checkout. Two properties make that safe enough to ship, and both must survive any future edit to the file:

- It **refuses to run** if that path is already uncommitted in the base checkout, rather than clobbering work in progress.
- It restores **bytes and mtime** in `afterAll` — `tugutil file probe`'s contract, done by hand because the assertion has to happen while the dirt is live. Restoring bytes alone would leave a spurious modification hint on the path.

The residual risk is a hard kill between the two, which would leave one appended comment line in `.gitignore`. That is the whole exposure, and it is visible and trivially reversible.

**`base_overlap` always reads the *main* checkout's working tree**, never the scanned project's — `dirty_tracked_paths(repo_root)` runs after `main_repo_root` normalization. A test running from a dash worktree must therefore dirty the main checkout, which is why `at0427` resolves it explicitly through `git rev-parse --git-common-dir` rather than using its own `PROJECT_DIR`.

**`at0405` and `at0426` were red before this work and are red after it.** Verified twice during #step-8: they fail identically with all of the step's deck changes stashed, *and* with `tugdash.autoreplay false` disabling the engine entirely. So neither the deck work nor the engine causes them. at0405's join draft never attaches to its entry and at0426's stub-driver body never appears in the resolution diff — both consistent with the caveat at0405's own docblock records, that a run whose scanned project is itself a dash worktree resolves worktree paths differently than the CLI does. Confirming that against `main` needs a build from `main`, which was not run. **Do not attribute these two to base-motion when they surface again.**

#### One thing the plan's own checkpoints missed {#addendum-checkpoint-gap}

#step-5's checkpoint was `cargo nextest run -p tugdash-core -p tugcast`, which never compiles `tugcast-core`'s own test target — so a third `ChangesetEntry::Dash` constructor there went un-updated and the full workspace suite was red at the start of the second run. The general lesson: **a step that adds a field to a shared wire type owes a workspace-wide test compile, not a crate-scoped one**, because the constructors that break are wherever the type is built, not wherever the field is read.
