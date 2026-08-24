<!-- devise-skeleton v5 -->

## Join Hardening {#join-hardening}

**Purpose:** Close the failure seams the 2026-08-19 audit found in the agent-finished join (`dash/join-hardening-brief.md`): one dash admits one run, a healthy resolver never renders as an error, the audit covers every machine-decided candidate, every join — clean or conflicted — rides a verified candidate through a server-owned gate, and no durable fact left by a crash renders as live, waits forever, or swallows a press.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | tugdash/join-hardening |
| Last updated | 2026-08-19 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-19, fable.** Reviewed `plan:da36f47700c25ccf`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document (first review, same session as authorship — the review deliberately re-walked the code rather than the author's memory: `join_state_for`/`standing_*` in `join_board.rs`, the four `changeset_join*` handlers in `agent_supervisor.rs`, `resolve_in`'s replay and clean-squash exits, `evaluateJoinGate`/`verificationVerdict` in `join-mode-controller.ts`, `Workshop`'s open/commit/remove family, and `validate_dash_name`).
Applied: reference hygiene — Step 1 cited a nonexistent anchor (`#f-traceability`), corrected to `#t01-traceability`; gate coherence — with every join riding a candidate ([P03]), `verificationVerdict`'s `not-applicable` arm would let the client gate pass during the window before the auto-resolve anchors a candidate, burning a server refusal the client could have mirrored — Step 8 gains the narrowing task and its bun test. Laws: [L02] holds (all new client state arrives via the feed → store → `useSyncExternalStore`, and the one client-local piece of join state, `redOverrideFor`, is deleted rather than grown); [L06] holds (run-stretch rendering is `data-*` + CSS); [L31] holds (every new refusal — admission, gate, dead answer — is a sentence naming its escape); [L29] holds (occupancy and board keys stay on `owner_key`, CONTROL payloads keep the existing `project_dir`+`dash` shape). Test plan carries no banned shapes; the restart-orphan behavior is deliberately pinned at the `join_board` layer rather than faking a tugcast kill in an app-test.
Deferred: nothing — the three design forks were asked and decided before authorship ([Q01]–[Q03]); the brief's F12b is refused in Non-goals with its evidence rather than left open.

### Phase Overview {#phase-overview}

#### Context {#context}

Round 2 (`dash/close-dash-join-gaps-round-2.md`, joined 2026-08-19 as `77ece2b65`) built the agent-finished join: the workshop worktree, the charter-governed resolver, tiered verification, the escalation frame, the audited report. The design is sound and its core mechanics are pressed. The 2026-08-19 audit (`dash/join-hardening-brief.md`, findings F1–F12) found that the *seams* between the pieces fail under real conditions the fixtures never produced: stub resolvers answer in milliseconds where real ones take minutes, so the 12-second client deadline flips every real run to a false error whose face invites a second concurrent resolve on one shared worktree; the Join-anyway override is deleted the instant it is set in exactly the state it exists for; the ladder's replay and clean-squash exits skip the audit the code claims to guarantee; a genuinely clean merge still joins with no verification at all; and a tugcast restart leaves a dead question rendering as live while the answer to it is silently swallowed.

Three design calls were put to the user on 2026-08-19 and decided: every join rides a candidate with auto-run verification ([P03]); the verdict gate moves server-side with a durable override fact ([P04]); and the client silence deadline is retired for the resolver rung, with failure detection owned entirely by the server ([P02]).

#### Strategy {#strategy}

- **Truth before gates.** First make every durable fact honest under failure — no verdict pinned at `running`, no unbounded tier, no dead question rendering live ([P06]) — because every later gate reads those facts.
- **One dash, one run.** Introduce admission before widening what runs: auto-verification ([P03]) multiplies the chances of two processes sharing the workshop, so the occupancy discipline ([P01]) lands first.
- **Server first, client second.** The wire types, the occupancy fact, the override fact, and the gate in `join_in` all land before the client steps that consume them, so each client change is a read of standing truth rather than a promise about future truth.
- **The audit follows the decisions, not the conflict markers.** The resolver's duty is defined by what the machine decided (the preview's conflict set plus whatever the resolver itself touched), not by which ladder exit happened to fire ([P05]).
- **Fixtures that reproduce the failure.** Each finding's own scenario becomes its checkpoint: a stub resolver that sleeps past the old deadline, a second Resolve press against a live run, an override pressed after a successful resolve, a restart-orphaned question.

#### Success Criteria (Measurable) {#success-criteria}

- Pressing **Join anyway** after a successful resolve with a red verdict joins the dash (at0443 presses it from the post-resolve state, the state where it was a silent no-op — brief F1).
- A resolver stub that stays silent for 15 seconds produces no error face and no re-mounted Resolve control; a second `changeset_join_resolve` against a live run is refused with a sentence naming the run (new at0444 + supervisor-layer Rust test — brief F2).
- A join resolved by the replay probe or the clean one-shot squash carries a resolver report accounting for every path in the preview's conflict set (Rust test on the supervisor's audit-set computation; at0426 continues to pass — brief F3).
- A textually clean dash cannot join unverified: entering join mode grows a candidate, verification runs, and the join gate refuses until the verdict is green or overridden (at0441 extension — brief F4).
- `tugutil dash join` of a red or unverified candidate is refused server-side without `--anyway` (Rust test in `ops.rs` — brief F4).
- A question standing with no in-process waiter renders as a stuck line naming what was asked, never as a live wizard; an answer that reaches nobody produces a visible refusal (Rust `join_board` test + client listener test — brief F5).
- No tier runner exit path leaves `TierStatus::Running` durable: every `Err` arm rewrites the fact red with the error as its failure sentence (Rust test — brief F5c/F6).
- Tier 0 is bounded; `run_declared` nulls stdin on both branches (Rust test with a stdin-reading command — brief F6/F12).
- `grep -rn "redOverrideFor" tugdeck/src` exits 1 — the client-local override state is gone ([P04]).
- `cargo nextest run`, tugdeck `bun test`, `bunx tsc --noEmit`, `bunx vite build` all green.

#### Scope {#scope}

1. Brief findings F1–F11 and the actionable half of F12 (stdin, delta field naming, `write_report` idempotence).
2. The three decided designs: candidate-for-every-join, server-side verdict gate with durable override, server-owned liveness.
3. Wire/type additions to `DashJoinState` and their client mirrors; the new `changeset_join_override` CONTROL verb.
4. App-test coverage for the arcs the fixes change (at0441, at0443 updates; new at0444).

#### Non-goals (Explicitly out of scope) {#non-goals}

- UI polish — button positions, feedback areas, fonts, colors, layout. That is its own review round, run on the user's eye.
- The app-test corpus quality round (culling non-falsifiable tests; at0438's scratch-universe rewrite).
- Live-model resolver tests in the corpus — real-claude runs stay on-demand; every fixture drives the stub seam. The slow-resolver fixture in at0444 is a *stub that sleeps*, not a model.
- A takeover mode opening the workshop as a project.
- Renaming the commit|join composer substrate (`landing-mode.ts` et al.) — user ruling, [P01] of round 2.
- Brief F12b (dash-name sanitization collision): **refused** — `validate_dash_name` (`tugrust/crates/tugdash-core/src/dash.rs`) admits only `[a-z0-9-]`, so two names that sanitize identically cannot both exist; the workshop sanitizer is dead defense, left alone.
- The join-verb UI split (lane JOIN enters the mode, composer ⬆ executes) — belongs to the UI round.

#### Dependencies / Prerequisites {#dependencies}

- Round 2 shipped and joined (`77ece2b65`): the workshop (`tugrust/crates/tugdash-core/src/workshop.rs`), the resolver (`tugrust/crates/tugcast/src/feeds/join_resolver.rs`), verification (`tugrust/crates/tugdash-core/src/verify.rs`), the join board (`tugrust/crates/tugcast/src/feeds/join_board.rs`), and the join face (`tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx`).
- The scratch-repo fixtures (`tests/app-test/dash-fixture.ts`: `makeJoinScratchRepo`) and the resolver stub seam (git config `tugdash.joinresolver`).
- `dash/join-hardening-brief.md` — the findings, their file:line evidence, and the audit's "found sound" list, which this plan builds on and does not re-litigate.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`); no step may leave dead code across a commit boundary.
- No fixture may spawn a live model or touch the developer's checkout — the spawner stays injected, never defaulted (round 2's rule, kept).
- App-tests are selective (`just app-test <files…>` / `just app-test-changed`); never a sweep, output never piped.
- Client persistent state goes through the feed or tugbank, never Web storage; external state enters React through `useSyncExternalStore` only [L02].

#### Assumptions {#assumptions}

- The audit's line numbers describe `main` at `fc9683893`; symbols are cited by name in this plan so drift in line numbers is harmless.
- `git merge-tree --write-tree` (git ≥ 2.38) is available, as round 2 already assumes.
- One tugcast process serves a given project checkout at a time; the occupancy registry ([P01]) is in-process state, and the residual risk of a *CLI* join racing a tugcast-held run is accepted and recorded (Risk R03).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How does a clean join get verified? (DECIDED — see [P03]) {#q01-clean-join}

**Question:** A clean merge grows no candidate today, so neither verification tier ever runs on it. Auto-run, verify-on-demand, or leave ungated?

**Resolution:** DECIDED 2026-08-19 by the user: every join rides a candidate; verification auto-runs on it; the join gates on the verdict. See [P03].

#### [Q02] Where does the verdict gate live? (DECIDED — see [P04]) {#q02-gate-home}

**Question:** The green/red/override discipline is entirely client-side; the server's join handler never consults the verdict, so a stale client or the CLI joins a red candidate.

**Resolution:** DECIDED 2026-08-19 by the user: the server refuses red/unrun; the override becomes a durable server fact scoped to the candidate sha; the CLI gets the same gate with `--anyway` as the explicit escape. See [P04]. (This also resolves the brief's Q4 — the override cannot stay "one deck's memory" once the server gates on it.)

#### [Q03] What replaces the 12-second client silence deadline for the resolver rung? (DECIDED — see [P02]) {#q03-liveness}

**Question:** A real resolver has minutes-long legitimate silences; the 12s deadline flips every real run to a false error.

**Resolution:** DECIDED 2026-08-19 by the user: the client deadline disarms entirely once the resolver rung starts; failure detection is server-owned — bounded tier runs, an overall resolve deadline, and the durable stuck fact. See [P02].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Auto-verification cost on join-mode entry | med | med | Verdicts anchor to `(base_sha, candidate_sha)` and cache; re-runs only when a head moves | Users report join mode feeling heavy |
| Occupancy stuck after a panic | high | low | RAII guard releases on drop; the registry is in-process, so a tugcast restart clears it by construction | Any "already running" refusal that outlives the run |
| `join_in` gate churn across existing tests | low | high | `JoinOptions { anyway: true }` in tests that exercise join mechanics; new tests pin the refusal itself | — |

**Risk R01: Every join now pays a build** {#r01-verify-cost}

- **Risk:** Entering join mode on a clean dash triggers a candidate commit plus tier 0/tier 1 — minutes of machine time per join.
- **Mitigation:** The verdict caches against the head pair and self-demotes only when a head moves; a dash joined shortly after its last green re-uses it. The cost is the arc's stated point: "no breakage that the project's own checks would have caught may join silently."
- **Residual risk:** A busy repo where `main` moves constantly re-verifies often. Acceptable; the alternative is the hole.

**Risk R02: The occupancy registry lies after a crash inside a run** {#r02-occupancy}

- **Risk:** A run that panics without dropping its guard would refuse every later run.
- **Mitigation:** The guard is RAII (release on `Drop`), the spawned task owns it, and tokio task panics still run destructors. The registry is in-memory only, so a process restart is a full reset — deliberately, since any on-disk lock would need the very staleness reasoning this plan is removing elsewhere.
- **Residual risk:** None identified beyond a wedged-but-alive task, which the bounded runs ([P06]) convert into an exit.

**Risk R03: A CLI join can still race a tugcast-held run** {#r03-cli-race}

- **Risk:** `tugutil dash join` runs in its own process and cannot see tugcast's occupancy registry; it could tear down the workshop while a resolve holds it.
- **Mitigation:** The window is the same one that existed for every dash verb before this plan; the ordinary flow (the card) is fully guarded. Recorded, not built for.
- **Residual risk:** The race itself. Revisit if it ever fires in practice.

---

### Design Decisions {#design-decisions}

#### [P01] One dash, one run — an in-process occupancy registry (DECIDED) {#p01-occupancy}

**Decision:** The agent supervisor holds a per-dash occupancy registry (keyed by the dash's `owner_key`, exactly as the `JoinBoard` cache is). `changeset_join_resolve`, `changeset_join_verify`, and a non-preview `changeset_join` each acquire the dash before doing anything and are refused with a sentence naming the live run ("a resolve is already running for this dash") while another holds it. The guard is RAII and travels into the detached task, so it releases on every exit path including panic.

**Rationale:**
- Two `finish_join` tasks on one workshop `reset --hard` under each other's live agent (brief F2b); Verify racing a resolve shares the same worktree and `target/` (brief F8); a join tearing the workshop down mid-resolve resurrects it as an orphan (brief F9). One admission discipline answers all three.
- `ops::join_in_flight` (the join journal in `tugrust/crates/tugdash-core/src/ops.rs`) already establishes the precedent that a join is a run with a beginning and an end; this extends the idea to resolve and verify, in memory, where a restart clears it by construction.

**Implications:**
- The occupancy is surfaced on the wire ([P09]) so the face and the board can read it.
- `join_board::join_state_for` consults it to pin facts during a run ([P05] pinning half).
- The client's "pressing again costs time and nothing else" docblock (`changeset-join-store.ts`) is rewritten — it stopped being true when the workshop arrived.

#### [P02] Liveness is server-owned; the client deadline dies for the resolver rung (DECIDED) {#p02-liveness}

**Decision:** `ChangesetJoinStore` disarms its silence deadline whenever the current rung is `resolver` — any status, not just `asking`. Failure detection moves entirely server-side: tier 0 gains `TIER0_TIMEOUT` (20 minutes, same figure and rationale as `TIER1_TIMEOUT`), the resolver driver gains a per-turn silence bound (`RESOLVER_TURN_TIMEOUT`, 20 minutes without a byte from the child), and `finish_join` gains an overall deadline (`RESOLVE_DEADLINE`, 2 hours — 3 iterations × (turn + tier 0) + the 30-minute question wait, with slack). Every timeout lands in `record_join_stuck` with a sentence naming which bound fired.

**Rationale:**
- The 12s deadline's premise (per-chunk streaming deltas) is true of the scribe rung and false of the resolver, whose four discrete statuses bracket minutes-long healthy silences (brief F2a). A liveness check that cannot distinguish work from death should not exist on the side that cannot see the work.
- The client already handles the one failure it *can* see — a dropped wire — via `connectionDidClose`. Everything else is the server's to know and the stuck fact's to say.

**Implications:**
- The face renders `working` / `verifying` / `iterating` stretches as work (the wire `run` fact from [P09] keeps them visible across a reload).
- The user chose this over a heartbeat design (2026-08-19): fewer moving parts, and the durable stuck fact is the single failure channel.

#### [P03] Every join rides a candidate; verification auto-runs (DECIDED) {#p03-candidate-always}

**Decision:** Entering join mode on a clean dash sends `changeset_join_resolve` exactly as a conflicted one does. The ladder's clean one-shot squash exit (already in `resolve_in`) anchors the candidate; the supervisor then auto-runs verification (`run_join_verification`, detached, under the same occupancy) on **every** resolve outcome that did not already verify inside `finish_join`. The join gate's existing `unrun`/`running`/`red` refusals then apply unchanged — `evaluateJoinGate` already refuses an unverified candidate; the hole was only that a clean dash never grew one.

**Rationale:**
- The motivating case of the whole arc — the renamed symbol on one side, the new call site on the other — is a *clean* merge that does not build (brief F4). Round 2's success criterion is only pinned where a candidate exists.
- The clean-squash candidate is one `commit-tree` — cheap. The verification is the same cost the conflicted path already pays, and the verdict caches ([R01]).

**Implications:**
- The client's join-mode entry path (the controller feeding `session-changes-dash-join.tsx`) auto-sends `resolve` when the feed shows outcome clean, no candidate, and no live run. Idempotent by [P01] — a duplicate press is refused server-side.
- `deriveJoinOutcome`'s clean-with-candidate path is already joinable; no gate relaxation needed.

#### [P04] The verdict gate lives in `join_in`; the override is a durable server fact (DECIDED) {#p04-server-gate}

**Decision:** `tugdash_core::ops::join_in` refuses a non-preview join whose candidate's verification is red or unrun, and refuses a non-preview join with **no** candidate at all, unless `JoinOptions.anyway` is set. The override is a git-config fact beside the verdict — `branch.tugdash/<name>.tugjoinoverride = <candidate_sha>` — written by a new `changeset_join_override` CONTROL verb (and honored by `join_in` as equivalent to `anyway` for that candidate only). The CLI gains `tugutil dash join --anyway`. The client's `redOverrideFor` state is deleted; `redOverrideStands` reads the wire fact.

**Rationale:**
- A gate the server never consults is advisory: a second deck, a stale client, or the CLI joins a red candidate with no refusal (brief F4). Placing it in `join_in` gives the card and the CLI one gate.
- The override must die with the tree it was decided over — anchoring it to the candidate sha is the same discipline every other join fact already follows, and `standing` reads self-demote it exactly as the verdict does.
- This is also the durable fix for brief F1: the client-local override that `_set` deleted is not repaired, it is removed.

**Implications:**
- Existing Rust tests that call `join(...)`/`join_in(...)` to exercise join mechanics set `anyway: true`; new tests pin the refusals themselves.
- `DashJoinState` gains `override_for: Option<String>` ([P09]); the face's Join-anyway button sends the CONTROL verb instead of mutating a store.

#### [P05] The audit set is the preview's conflict set plus resolver-touched paths; standing facts pin during a run (DECIDED) {#p05-audit-set}

**Decision:** Two halves. (1) `resolve_in` computes `merge_tree_stages` **before** the replay probe and carries the conflicted path list on `ResolveOutcome` as `preview_conflicts`; the replay and clean-squash exits call `record_resolved_rung` for each of those paths (rung `Replay` / `Squash` respectively — `ResolvedBy` gains the spellings); the supervisor's resolver trigger becomes "the audit set is non-empty" (`preview_conflicts ∪ resolved ∪ unresolved`), so a ladder exit that silently decided conflicted paths still gets audited. (2) `validate_report`'s required set widens to the audit set plus every path in `git diff --name-only` between the ladder's tree (`ResolveOutcome.staged_tree`, or the replayed head's tree) and the candidate's tree — the paths the resolver itself changed, including files it invented (brief F10). (3) While a run occupies the dash, `join_state_for` does **not** clear a stale candidate out from under it, and `standing_question` matches the question by its recorded head even if the dash head has since moved (brief F7).

**Rationale:**
- The replay exit is precisely the 2026-08-15 incident shape — a wholesale machine decision that builds green — passing unread (brief F3). The comment above `conflicted` already claims this guarantee; the code should keep it.
- A report that need not mention a file the resolver created is a report that cannot catch the resolver smuggling one in (brief F10).
- Clearing the candidate on recompute is right *between* runs and wrong *during* one: the mid-run clear produces "the build verdict went missing before the exam," a stuck sentence naming none of the real cause (brief F7).

**Implications:**
- `ResolveOutcome` grows `preview_conflicts: Vec<String>` (serde-skipped like `staged_tree`); one extra `merge-tree` on the replay path, accepted.
- When the base genuinely moved during a run, the run finishes and its candidate demotes on the *next* recompute with an honest stale note — the ordinary staleness path, at the ordinary time.

#### [P06] Failure facts are always terminal (DECIDED) {#p06-terminal-facts}

**Decision:** No durable fact may describe an activity nobody is performing. Concretely: every `Err` arm of `run_tier0`/`run_tier1`'s callers rewrites the verification fact to red with the error as its failure sentence before propagating (never leaving `Running`); a standing question whose dash has no live run and no in-process waiter is converted, at `join_board` read time, into a stuck line quoting the question (never rendered as a live wizard); the client subscribes to `changeset_join_question_answer_err` and surfaces its reason; and an expired escalation writes its question into a `branch.tugdash/<name>.tugjoinlastask` fact that `resolve_intent` appends to the next charter's corpus ("an earlier resolver asked and got no answer: …"), making `QUESTION_DEADLINE`'s docstring true instead of rewriting it down.

**Rationale:**
- The `running`-forever verdict maps to a refusal with no control (`REFUSAL_REACHABILITY.verifying = {slot: null, where: "time"}`) — a permanent "wait" (brief F5c). A dead question rendering live plus a swallowed answer is the [L31] silence the surrounding code exists to forbid (brief F5a/b).
- Feeding the expired ask forward is the cheapest honest version of "the answer arrives on the next resolve": the next resolver is *told*, even though the conversation is not resumable (brief F11).

**Implications:**
- The no-waiter check needs the occupancy registry ([P01]) — a question is only "orphaned" when nobody holds the dash.
- `resolve_intent` gains one more corpus section; `PLAN_INTENT_CAP` handling unchanged.

#### [P07] Workshop lifecycle: release on failure, sweep on recompute, no resurrection (DECIDED) {#p07-workshop-lifecycle}

**Decision:** `finish_join`'s failure exits call `Workshop::release()` (currently dead code) so a failed resolve leaves a clean base checkout rather than markers and a live `MERGE_HEAD`; `Workshop::ensure` refuses (instead of creating) when the dash's branch no longer exists, so a straggling task cannot resurrect a torn-down workshop; and the dash feed's recompute sweeps `.tug/workshops/` entries whose dash no longer exists and whose name holds no occupancy — the sweeper the directory never had.

**Rationale:**
- "Dirty after failure" as the steady state is survivable but reads as wreckage to anyone who opens the workshop; a released tree plus the stuck fact says the same thing legibly (brief F9).
- The orphan path (teardown ran, `ensure` re-created) leaks a worktree and a branch forever; refusing creation for a dead dash closes it at the root, and the sweep collects anything that leaked before this plan.

**Implications:**
- [P01]'s occupancy makes the sweep safe: a workshop is only removed when nothing holds its dash.
- `open_existing` keeps not-resetting (the resolver's edits must survive a task boundary); `release` is failure-path only.

#### [P08] Small honesty fixes ride along (DECIDED) {#p08-smalls}

**Decision:** `run_declared` nulls stdin on both branches (today only the unbounded one does — brief F12a); `emit_resolver_delta` stops passing the candidate sha through a parameter named `path` (the delta payload names it `candidate`, and the client keys accordingly — brief F12c); `write_report`, `write_stuck`, `write_question`, and the new override/lastask writers use `git config --replace-all` so a doubled key cannot fail every later write (brief F12d).

**Rationale:** Each is a one-line class of bug with a real failure sentence attached in the brief; none warrants its own step, so they land inside the steps that touch their files.

#### [P09] The wire grows `run` and `override_for`; nothing else moves (DECIDED) {#p09-wire}

**Decision:** `DashJoinState` (`tugrust/crates/tugcast-core/src/types.rs`) gains `run: Option<String>` — `"resolve"` or `"verify"` while the occupancy registry holds the dash, else absent — and `override_for: Option<String>`, the standing override fact's candidate sha. `DashJoinStateWire` (`tugdeck/src/lib/changeset-types.ts`) mirrors both. The `run` fact is what lets a reload land on a face that still says "Resolving…" instead of nothing.

**Rationale:** Round 2's resolve progress was client-overlay-only, so a mid-resolve reload rendered a running resolve as absence. The server knows; the wire should say.

**Implications:** `join_state_for` reads the registry through a narrow accessor the supervisor exposes (the board must not own run state — it is a cache, and occupancy is not cacheable).

---

### Deep Dives (Optional) {#deep-dives}

#### Finding-to-step traceability {#finding-traceability}

**Table T01: Brief findings → plan steps** {#t01-traceability}

| Finding | What it is | Step(s) | Decision |
|---|---|---|---|
| F1 | Join-anyway no-op | #step-6, #step-8 | [P04] |
| F2a | 12s deadline vs resolver cadence | #step-8 | [P02] |
| F2b | No in-flight guard; double resolve | #step-2 | [P01] |
| F3 | Replay/clean-squash skip the audit | #step-4 | [P05] |
| F4 | Clean joins unverified; no server gate | #step-6, #step-7 | [P03], [P04] |
| F5a | Stale question renders live | #step-3 | [P06] |
| F5b | Answer refusal has no listener | #step-8 | [P06] |
| F5c | Tier error pins `running` | #step-1 | [P06] |
| F6 | Tier 0 unbounded; no overall deadline | #step-1 | [P02] |
| F7 | Recompute clears candidate mid-run | #step-3 | [P05] |
| F8 | Verify races resolve in one workshop | #step-2 | [P01] |
| F9 | Workshop orphans; `release()` dead | #step-9 | [P07] |
| F10 | Invented files land unaudited | #step-5 | [P05] |
| F11 | Expiry contract untrue | #step-5 | [P06] |
| F12a | stdin inherited under timeout | #step-1 | [P08] |
| F12b | Name sanitization collision | refused (#non-goals) | — |
| F12c | sha-as-path delta field | #step-8 | [P08] |
| F12d | `write_report` non-idempotent set | #step-3 | [P08] |

#### Why the occupancy registry is in-memory {#occupancy-in-memory}

An on-disk lock would need staleness detection (who holds it, are they alive, when is it safe to break) — exactly the class of reasoning this plan removes from the question and candidate facts. In-process state has the opposite property: a tugcast restart clears every hold by construction, and the restart is also the only event that can orphan a run, so the two invalidate together. The join journal (`ops::join_in_flight`) stays as-is: it guards the join's own crash-recovery replay, a different job.

---

### Specification {#specification}

**Spec S01: Occupancy semantics** {#s01-occupancy}

- Registry: `Mutex<HashMap<String /*owner_key*/, JoinRun>>` in the agent supervisor, where `JoinRun` names the kind (`Resolve` | `Verify`) and, for questions, the run's dash-head snapshot.
- Acquire: `changeset_join_resolve`, `changeset_join_verify`, and non-preview `changeset_join` each try-acquire before any git activity; on refusal, the `_err` reply is `"a <kind> is already running for this dash"`. Preview joins never acquire (they touch nothing).
- Release: RAII guard owned by the spawned task; drop = release.
- Read: `join_state_for` reads kind via an accessor; a held dash reports `run` on the wire ([P09]).

**Spec S02: The override fact** {#s02-override}

- Key: `branch.tugdash/<name>.tugjoinoverride`; value: the candidate sha it was decided over. Written with `--replace-all`.
- Written by: `changeset_join_override` CONTROL request `{project_dir, dash, candidate}` → `changeset_join_override_ok/_err`. Refused when `candidate` is not the standing candidate (the decision must be about the tree that would join).
- Read by: `join_in` (equivalent to `anyway` iff it names `opts.candidate`/the standing candidate) and `standing` assembly (`override_for` on the wire). Cleared by `clear_candidate` alongside the other candidate marks — a new candidate must be decided about on its own terms.

**Spec S03: The `join_in` gate** {#s03-join-gate}

Order, after the existing blockers and before the merge work, for non-preview joins only:

1. `opts.anyway` → pass (CLI `--anyway`, and tests exercising join mechanics).
2. A standing override naming the candidate → pass.
3. Candidate present: read the verification fact; refuse red (`"verification is red for this candidate — re-resolve, or join --anyway"`) and unrun/missing (`"this candidate is unverified — verify first, or join --anyway"`).
4. No candidate: refuse (`"no verified candidate — resolve first, or join --anyway"`).

Every refusal is a sentence naming the escape, per the errors-never-fail-silently rule.

**Spec S04: The audit set** {#s04-audit-set}

`audit_set = preview_conflicts ∪ resolved_paths ∪ unresolved_paths`; the resolver runs iff it is non-empty. `validate_report`'s required set = `audit_set ∪ resolver_touched`, where `resolver_touched = git diff --name-only <ladder_tree> <candidate_tree>` (`ladder_tree` = `ResolveOutcome.staged_tree` when present, else the replayed head's tree; recomputed per iteration against the previous candidate).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `run` / `override_for` wire mirrors | local-data | feed → `ChangesetJoinStore` → `useSyncExternalStore` | [L02] |
| Answer-refusal notice | local-data | store error field, same channel as resolve errors | [L02] |
| Face states for run stretches | appearance | `data-*` attributes + CSS, no React state | [L06] |
| `redOverrideFor` | — | **deleted** (replaced by the wire fact) | — |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Occupancy, gate order, audit-set computation, terminal-fact rewrites, bounds | Every server-side step |
| **Unit (bun)** | Store deadline discipline, gate/verdict pure functions, wire parsing | Client steps |
| **Integration (Rust)** | Supervisor handlers against scratch repos with scripted resolvers | Steps 2–7 |
| **App-test** | The pressed arcs a user actually walks | Step 10 |

#### What stays out of tests {#test-non-goals}

- Live-model resolver behavior — the corpus proves the machinery; real-claude runs are on-demand only.
- Model prose quality — never asserted (the scripted-spawner rule).
- Pixel/animation assertions — banned shapes; states assert via `data-*` and text.
- A real tugcast kill/restart inside an app-test — the restart-orphaned-question behavior is pinned at the `join_board` layer, where the fact conversion actually lives.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Verification honesty: bounds, terminal facts, stdin | done | `953f642e0` |
| #step-2 | The occupancy registry: one dash, one run | done | `60eeb2122` |
| #step-3 | Standing facts under occupancy: pinning, orphan conversion | done | `e951cdea8` |
| #step-4 | The audit covers replay and clean-squash | done | `f3fd20620` |
| #step-5 | The resolver contract: touched paths and the expired ask | done | `9c472f68f` |
| #step-6 | The server verdict gate and the override fact | done | `521a83b72` |
| #step-7 | Every join rides a candidate | done | `4906420d0` |
| #step-8 | Client truth: deadline, override, answer refusal | done | `c55942bc3` |
| #step-9 | Workshop lifecycle: release, refuse, sweep | done | `34c81bcce` |
| #step-10 | The pressed arcs | done | `6feb54501` |
| #step-11 | Documentation sync | done | `1ffece71e` |
| #step-12 | Integration checkpoint | done | `5f89d8605` |

#### Step 1: Verification honesty: bounds, terminal facts, stdin {#step-1}

**Commit:** `join(verify): tier 0 is bounded, a failed runner writes red, and no command inherits stdin`

**References:** [P02], [P06], [P08], Spec S04 context, (#p06-terminal-facts, #t01-traceability)

**Artifacts:** `TIER0_TIMEOUT` in `verify.rs`; rewritten `Err` arms in `join_resolver.rs::run_tier0/run_tier1` and `agent_supervisor.rs::run_join_verification`; stdin nulled in `run_declared`'s unbounded branch's sibling (`run_bounded`).

**Tasks:**
- [ ] Add `TIER0_TIMEOUT: Duration = 20 * 60` beside `TIER1_TIMEOUT` in `tugrust/crates/tugdash-core/src/verify.rs`; pass it in `run_tier0`'s `run_declared` call (today `None`).
- [ ] In `verify.rs::run_bounded`, set `Stdio::null()` for stdin (the timeout branch currently inherits tugcast's).
- [ ] In `tugrust/crates/tugcast/src/feeds/join_resolver.rs` (`run_tier0`, `run_tier1`) and `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` (`run_join_verification`): every path that wrote `TierStatus::Running` and then can return `Err` must first rewrite the fact — the failing tier `Red`, the error string appended to `failures` — before propagating. No exit leaves `Running` durable.
- [ ] Add `RESOLVER_TURN_TIMEOUT` (20 min of child silence) to the resolver drivers in `join_resolver.rs` — a turn that produces no bytes for that long kills the child and returns the timeout as the turn's `Err`, which `finish_join` already lands in `record_join_stuck`.
- [ ] Add `RESOLVE_DEADLINE` (2 h) around `finish_join`'s whole flow; on expiry, stuck names which activity was in flight.

**Tests:**
- [ ] Rust: a declared tier-0 command that reads stdin exits (never blocks) under both the bounded and unbounded branches.
- [ ] Rust: a tier runner whose `Workshop::open_candidate` fails leaves the verification fact red with the failure sentence, not `Running` (drive by deleting the candidate ref before the run).
- [ ] Rust: a stub resolver that never writes a byte trips `RESOLVER_TURN_TIMEOUT` and the stuck fact names it.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugdash-core -p tugcast`

---

#### Step 2: The occupancy registry: one dash, one run {#step-2}

**Depends on:** #step-1

**Commit:** `join(admission): one dash admits one run, and the second press is refused by name`

**References:** [P01], [P09], Spec S01, (#p01-occupancy, #occupancy-in-memory)

**Artifacts:** `JoinRun`/registry + RAII guard in `agent_supervisor.rs`; refusal arms in `do_changeset_join_resolve`, `do_changeset_join_verify`, `do_changeset_join`; `DashJoinState.run` + `DashJoinStateWire.run`.

**Tasks:**
- [ ] Add the registry (Spec S01) to the supervisor; expose a narrow read accessor for the join board (`fn join_run_for(owner_key) -> Option<&'static str>` shape).
- [ ] `do_changeset_join_resolve`: try-acquire `Resolve` before `clear_stuck`; on refusal send `changeset_join_resolve_err` with the naming sentence; move the guard into the detached task (both the `finish_join` spawn and the non-resolver path).
- [ ] `do_changeset_join_verify`: same with `Verify`.
- [ ] `do_changeset_join`: non-preview only — try-acquire (kind `Verify` is fine; the point is exclusion) for the duration of the blocking `join_in` call; previews never acquire.
- [ ] Surface `run` on `DashJoinState` (types.rs) from the accessor in `join_state_for`; mirror on `DashJoinStateWire` (`tugdeck/src/lib/changeset-types.ts`) and its parser/fixtures.
- [ ] Rewrite the `changeset-join-store.ts` docblock that promises "a second run costs time and nothing else."

**Tests:**
- [ ] Rust: a second `changeset_join_resolve` while a stub resolver run holds the dash is refused with the naming sentence; after the run exits, a fresh resolve is admitted.
- [ ] Rust: `changeset_join_verify` during a resolve is refused; a non-preview `changeset_join` during a resolve is refused; a preview is not.
- [ ] Rust: the guard releases when the detached task panics (drive with a stub whose spawn closure panics).
- [ ] bun: wire parser round-trips `run`.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugcast`
- [ ] `cd /u/src/tugtool/tugdeck && bun test changeset`

---

#### Step 3: Standing facts under occupancy: pinning, orphan conversion {#step-3}

**Depends on:** #step-2

**Commit:** `join(board): a live run pins its facts, and a dead question becomes a stuck line`

**References:** [P05] (pinning half), [P06], [P08], Spec S01, (#p05-audit-set, #p06-terminal-facts)

**Artifacts:** occupancy-aware `join_state_for`, `standing_question`; `--replace-all` writers in `resolve.rs`.

**Tasks:**
- [ ] `join_board::join_state_for`: when the dash is occupied, a `CandidateStatus::Stale` is *reported* (stale note) but not *cleared* — `clear_candidate` only fires on an unoccupied dash.
- [ ] `standing_question`: when the dash is occupied by a resolve, match the question against the run's recorded head snapshot (Spec S01) rather than the current dash head, so a mid-question dash commit does not vanish the wizard.
- [ ] `standing_question`: when the dash is **not** occupied and a question fact stands, convert it — `clear_question` + `write_stuck` quoting the question ("tugcast restarted while the resolver waited on: …") — and report the stuck line instead. This is the restart self-heal; no startup hook needed.
- [ ] Convert `write_report`/`write_stuck`/`write_question` (and Step 6's new writers) to `git config --replace-all`.

**Tests:**
- [ ] Rust: an orphaned question (fact written, no occupancy, no waiter) renders as `stuck` quoting the question and the fact is gone afterwards; an occupied dash's question survives a dash-head move.
- [ ] Rust: a stale candidate under occupancy is reported with its note but the ref still exists; the same recompute after release clears it.
- [ ] Rust: a doubled config value for the report key no longer fails `write_report`.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugcast -p tugdash-core`

---

#### Step 4: The audit covers replay and clean-squash {#step-4}

**Depends on:** #step-2

**Commit:** `join(audit): the audit follows the preview's conflict set, not the ladder's exit`

**References:** [P05], Spec S04, (#p05-audit-set, #t01-traceability F3)

**Artifacts:** `ResolveOutcome.preview_conflicts`; `ResolvedBy::Replay`/`ResolvedBy::Squash` spellings; audit-set trigger in `do_changeset_join_resolve`.

**Tasks:**
- [ ] In `resolve.rs::resolve_in`: compute `merge_tree_stages` before the replay probe; carry the conflicted path list as `preview_conflicts: Vec<String>` (serde-skipped) on every exit.
- [ ] Extend `ResolvedBy` with `Replay` and `Squash` (plus `as_str`/`parse`); on the replay and clean-squash exits, `record_resolved_rung` each preview-conflicted path with the exit's rung so the charter's `rung_resolved` names them.
- [ ] In `do_changeset_join_resolve`: replace the `conflicted` boolean with `audit_set` non-emptiness (Spec S04); a replay/squash exit with a non-empty preview conflict set now enters `finish_join` for the audit + verification pass.
- [ ] `compose_charter` already renders `rung_resolved`; confirm the replay rung reads sensibly in the audit duty prose (the charter's audit framing is per-file, so no structural change expected).

**Tests:**
- [ ] Rust: a scratch repo whose squash conflicts but whose rounds replay cleanly (the rerere-shape fixture from round 2's at0426 family, at the Rust layer) produces a replay candidate *and* a resolver invocation whose resolution set names the preview conflicts; the report must account for them (`validate_report` refuses one that omits them).
- [ ] Rust: a genuinely clean dash (empty preview conflict set) still skips the resolver — audit-set-empty is the no-audit case, by construction not by exit shape.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugdash-core -p tugcast`
- [ ] `cd /u/src/tugtool && just app-test tests/app-test/at0426-dash-resolution-audit.test.ts`

---

#### Step 5: The resolver contract: touched paths and the expired ask {#step-5}

**Depends on:** #step-4

**Commit:** `join(resolver): the report accounts for every path the resolver touched, and an expired ask reaches the next charter`

**References:** [P05], [P06], Spec S04, (#s04-audit-set, #t01-traceability F10/F11)

**Artifacts:** widened `validate_report`; `tugjoinlastask` fact + `resolve_intent` section; truthful `QUESTION_DEADLINE` docs.

**Tasks:**
- [ ] In `join_resolver.rs::finish_join`: after each `commit_candidate`, compute `resolver_touched` (Spec S04: diff of the ladder tree — or the previous iteration's candidate tree — against the new candidate tree) and pass the union set to `validate_report`.
- [ ] `validate_report`: signature takes the full required set; the refusal sentence distinguishes "the report omits a path the machine resolved" from "…a path the resolver changed."
- [ ] `escalate`'s timeout arm: write `branch.tugdash/<name>.tugjoinlastask` (dash-head-keyed blob, same pattern as the question fact) before clearing the question; `resolve_intent` appends a section quoting it when present; the next resolve's start clears it after reading.
- [ ] Rewrite `QUESTION_DEADLINE`'s docblock to describe what now actually happens.

**Tests:**
- [ ] Rust: a stub resolver that writes a new file not in any conflict set and omits it from its report is refused by name; including it passes.
- [ ] Rust: an expired ask appears verbatim in the next resolve's composed intent and is consumed (absent from the one after).

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugcast -p tugdash-core`

---

#### Step 6: The server verdict gate and the override fact {#step-6}

**Depends on:** #step-1

**Commit:** `join(gate): the server refuses an unverified or red candidate, and Join anyway is a durable fact about one tree`

**References:** [P04], [P09], Spec S02, Spec S03, (#p04-server-gate, #s02-override, #s03-join-gate)

**Artifacts:** `JoinOptions.anyway`; the gate in `join_in`; `write_override`/`read_override`/cleared-with-candidate in `verify.rs` or `resolve.rs` (beside the verdict it modifies); `changeset_join_override` verb; `tugutil dash join --anyway`; `DashJoinState.override_for` + wire mirror.

**Tasks:**
- [ ] Add `anyway: bool` to `JoinOptions` (`ops.rs`); implement the gate per Spec S03 in `join_in`, after blockers, non-preview only.
- [ ] Add the override fact (Spec S02): writer/reader beside `verification_config_key`'s family; `clear_candidate` clears it with the other marks.
- [ ] Add `changeset_join_override` to the supervisor: parse `{project_dir, dash, candidate}`, refuse a candidate that is not the standing one, write the fact, bump the changeset recompute, reply `_ok`/`_err`. (Remember the tugcode inbound-message allowlist if the verb crosses that boundary — the card sends CONTROL directly, so likely not, but verify.)
- [ ] `tugutil dash join` gains `--anyway`, threaded to `JoinOptions.anyway`.
- [ ] Surface `override_for` on `DashJoinState`/`DashJoinStateWire` from the standing fact (self-demoting: only reported while it names the standing candidate).
- [ ] Sweep existing Rust tests that call `join`/`join_in` for join mechanics: set `anyway: true` where the test's subject is not the gate.

**Tests:**
- [ ] Rust: a non-preview join with a red candidate is refused naming the escape; with the override fact standing it passes; a re-resolve (new candidate) demotes the override and the refusal returns.
- [ ] Rust: a non-preview join with no candidate is refused; `anyway: true` passes; a preview never gates.
- [ ] Rust: `changeset_join_override` for a superseded candidate is refused.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run`

---

#### Step 7: Every join rides a candidate {#step-7}

**Depends on:** #step-2, #step-4, #step-6

**Commit:** `join(candidate): a clean join grows a candidate and verifies it before the gate will open`

**References:** [P03], [P01], Spec S01, (#p03-candidate-always, #r01-verify-cost)

**Artifacts:** auto-verification after non-resolver resolves in `do_changeset_join_resolve`; client auto-resolve on join-mode entry.

**Tasks:**
- [ ] `do_changeset_join_resolve`: when the outcome anchored a candidate without entering `finish_join` (empty audit set — the genuinely clean squash or replay), hand the occupancy guard to a detached `run_join_verification` (kind transitions `Resolve` → `Verify`) so the verdict exists without a user press. `finish_join`'s own path already verifies.
- [ ] Client join-mode entry (the controller path in `session-changes-dash-join.tsx` / `join-mode-controller.ts` that runs when the mode opens): when the feed shows outcome `clean`, no `candidate`, and no `run`, send `store.resolve(...)` once. Duplicate sends are refused by [P01]; the send is an action on mode entry, not render-time state.
- [ ] The face's clean-arc rendering: the verdict panel and Verify/override controls already mount off candidate+verification state; confirm the clean arc reaches them unchanged and adjust `deriveResolveFace` only if the `running` stretch renders as absence (it should render from the wire `run` fact).

**Tests:**
- [ ] Rust: a clean-squash resolve leaves a candidate *and* a verification fact (green under the fixture's trivial tier 0) with no `changeset_join_verify` ever sent.
- [ ] bun: the controller sends exactly one resolve on mode entry for a clean unverified dash, and none when a candidate or run already stands.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugcast`
- [ ] `cd /u/src/tugtool/tugdeck && bun test && bunx tsc --noEmit`

---

#### Step 8: Client truth: deadline, override, answer refusal {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `join(client): the deadline trusts the resolver, the override is the server's fact, and a dead answer refuses out loud`

**References:** [P02], [P04], [P06], [P08], (#p02-liveness, #state-zone-mapping, #t01-traceability F1/F2a/F5b/F12c)

**Artifacts:** deadline disarm for the resolver rung; `redOverrideFor` deleted; `overrideRed` → CONTROL sender; `changeset_join_question_answer_err` listener; renamed delta field.

**Tasks:**
- [ ] `changeset-join-store.ts`: disarm the deadline whenever `rung === "resolver"` (all statuses, not just `asking`); the deadline continues to govern the scribe/ladder rungs.
- [ ] Delete `ResolveState.redOverrideFor` and the store's local `overrideRed` mutation; `overrideRed` now sends `changeset_join_override` and the gate reads `override_for` from the wire (`redOverrideStands(candidate, join.override_for)` — signature updated where `join-mode-controller.ts` and the face consume it).
- [ ] `_onControl`: accept `changeset_join_override_ok/_err` and `changeset_join_question_answer_err`; a question-answer refusal surfaces through the store's error channel so the face says why the press did nothing.
- [ ] `join_resolver.rs::emit_resolver_delta`: stop passing the candidate sha through the `path` parameter; the payload field is named `candidate` and `changeset-join-store.ts` keys accordingly.
- [ ] `join-mode-controller.ts::verificationVerdict`: narrow the `not-applicable` arm — a dash whose outcome is `clean` but whose candidate has not yet anchored returns `unrun`, so the client gate refuses exactly where the server gate ([P04]) would; `not-applicable` survives only for a null/blocked join state where no join is on offer at all.
- [ ] Update the pure-function unit tests (`join-mode-controller.test.ts`) to drive the override through the wire shape, and add the store round-trip the old tests never had (the F1 lesson).

**Tests:**
- [ ] bun: with rung `resolver` and status `working`, 12+ seconds of silence produces no error state; with rung `scribe` it still does.
- [ ] bun: store round-trip — override pressed from the idle-after-resolve state reaches the connection as `changeset_join_override` (the exact state where F1 was a no-op).
- [ ] bun: a `changeset_join_question_answer_err` frame lands a visible reason.
- [ ] bun: `verificationVerdict` returns `unrun` for a clean outcome with no candidate, and the gate refuses `unverified` there — the window between join-mode entry and the auto-resolve anchoring never reads as joinable.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `grep -rn "redOverrideFor" tugdeck/src` exits 1

---

#### Step 9: Workshop lifecycle: release, refuse, sweep {#step-9}

**Depends on:** #step-2

**Commit:** `join(workshop): a failed resolve releases the tree, a dead dash cannot grow one, and orphans are swept`

**References:** [P07], [P01], (#p07-workshop-lifecycle)

**Artifacts:** `release()` on `finish_join` failure exits; `ensure` refusal for a missing dash branch; the recompute sweep.

**Tasks:**
- [ ] `finish_join`: every `Err` exit (after `record_join_stuck`) calls `Workshop::release()` — the stuck fact carries the account; the tree goes back to base.
- [ ] `Workshop::ensure`: when `tugdash/<name>` does not exist, return `Err` naming the dash as gone instead of creating the worktree/branch.
- [ ] Add a sweep — on the dash feed's recompute (where `join_board::sweep` already runs), remove `.tug/workshops/<name>` worktrees and `tugworkshop/<name>` branches whose dash branch no longer exists and whose `owner_key` holds no occupancy. Reuse `workshop::remove`.
- [ ] Decide nothing about `open_existing` — it keeps not-resetting (the resolver's edits span a task boundary), documented in place.

**Tests:**
- [ ] Rust: a `finish_join` failure leaves the workshop checked out clean at base (no markers, no `MERGE_HEAD`).
- [ ] Rust: `ensure` for a deleted dash refuses; a straggling verify against a torn-down dash lands its refusal in the verification fact (red, by Step 1's terminal-fact rule) rather than resurrecting the worktree.
- [ ] Rust: an orphaned workshop (branch deleted out from under it) disappears on the next sweep; an occupied one survives.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugdash-core -p tugcast`

---

#### Step 10: The pressed arcs {#step-10}

**Depends on:** #step-3, #step-5, #step-7, #step-8, #step-9

**Commit:** `join(arcs): the clean join verifies, the slow resolver is not an error, and Join anyway joins`

**References:** [P01], [P02], [P03], [P04], (#success-criteria, #test-non-goals)

**Artifacts:** at0441 extension; at0443 update; new at0444.

**Tasks:**
- [ ] **at0441** (conflicted arc): extend with a *clean* beat — a scratch dash with no conflicts enters join mode, the face reaches a green verdict with no Verify press, and the join lands. (Fixture: `makeJoinScratchRepo` grows a no-conflict option.)
- [ ] **at0443** (red + override): the override beat now presses Join anyway from the settled post-resolve state and asserts the join *proceeds* (the F1 no-op state); assert the override survives a deck reload (it is a server fact now).
- [ ] **at0444** (new): a resolver stub that sleeps 15 s before reporting. Assert: no error face at 12 s (the status stretch renders as work), a second Resolve press mid-run is refused with the naming sentence in view, and the run completes green afterwards. `@covers` the store, the controller, and the supervisor's admission path.
- [ ] Run the join family: at0417, at0418, at0425, at0426, at0436, at0441, at0442, at0443, at0444.

**Tests:**
- [ ] The three files above are the tests.

**Checkpoint:**
- [ ] `cd /u/src/tugtool && just app-test tests/app-test/at0441-join-arc-end-to-end.test.ts tests/app-test/at0443-join-red-override.test.ts tests/app-test/at0444-join-slow-resolver.test.ts`
- [ ] `just app-test-covers-check`

---

#### Step 11: Documentation sync {#step-11}

**Depends on:** #step-10

**Commit:** `join(docs): doctrine and skills speak the gated, admitted, self-healing join`

**References:** [P01]–[P07], (#non-goals)

**Artifacts:** doctrine + skill + README updates; brief cross-note.

**Tasks:**
- [ ] `tuglaws/dash-work-doctrine.md` "The join finishes itself": add the admission rule (one dash, one run), the server gate, and the terminal-facts rule, in the section's existing voice.
- [ ] `tugplug/skills/dash-join/SKILL.md`: the conflicted beat's prose gains the clean-join verification (every join rides a candidate) and `--anyway`.
- [ ] `tests/app-test/README.md` join-fixtures section: the slow-resolver stub and the clean-join fixture option.
- [ ] `dash/join-hardening-brief.md`: a one-line status note at top pointing here (the brief stays as the findings record).

**Tests:**
- [ ] None (prose).

**Checkpoint:**
- [ ] `grep -n "one dash, one run" tuglaws/dash-work-doctrine.md` exits 0

---

#### Step 12: Integration checkpoint {#step-12}

**Depends on:** #step-11

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Tasks:**
- [ ] Verify the whole pipeline builds; rebuild the app so the live instance carries the change (`just build-app` — the app-test harness never rebuilds the binary).

**Tests:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run`
- [ ] `cd /u/src/tugtool/tugdeck && bun test && bunx tsc --noEmit && bunx vite build`

**Checkpoint:**
- [ ] `cd /u/src/tugtool && just app-test-changed` (or the core tier if the budget refuses)
- [ ] Every success criterion in (#success-criteria) is checked off or its deviation named.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A join pipeline where admission is exclusive per dash, liveness is the server's fact and silence is never an error, the audit duty follows the machine's decisions through every ladder exit, every join — clean or conflicted — rides a candidate that the project's own checks have judged, the gate and its override live server-side where every client and the CLI meet them, and every failure — crash, timeout, restart, expiry — lands as a terminal, readable fact with a control or a reason beside it.
