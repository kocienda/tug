<!-- devise-skeleton v5 -->

## Join Narration — the join narrates itself from the press {#join-narration}

**Purpose:** A submitted join must show progress from the instant of the ⬆ press. Today there are several silent seconds between the press and the durable receipt, and during them the register reads "Ready to join" — a resting lie over live work. This plan makes the press itself write the first beat and makes the server narrate the front of the run, then diagnoses the pre-existing red `at0405-changes-dash-lane` and repairs it if the cause is small.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, opus.** Reviewed `plan:62f8bd60af399e06`. Lint: 0 errors, 0 warnings.
Oriented on: the plan as devised (never reviewed), read against the code it names.
Applied: the at0405 half of the plan was wrong and is rewritten. [P05] had decided that the lane's `lands as` slot supersedes the awaited `session-changes-dash-draft` slot, and the code refutes it — `standing_offer` (`join_board.rs`) returns `None` unless its `quiet` argument holds, and `quiet` requires `candidate.is_some()`; a candidate comes from the resolution ladder, which the pilot runs only for a **server-bound** dash ([D147]), while at0405's bind is a synthesized client-side `bind_dash_ok` its own header admits cannot fake `bound_sessions`. The second guess — that the grammar was removed — is refuted too: `DashChangesetEntry.draft` is still on the wire and still composed (`draft_from_row` / `attach_live_session_drafts`). I ran the file bare to confirm the red is current (100s timeout on that selector; harness history: red in the last 3 runs back to `8c04a5616`) but could not settle the cause inside a review, so [P05] is now "diagnose before repairing, and bound the repair", Step 3 is a diagnosis step with an explicit stop condition, and (#at0405-anatomy) records both eliminations and the surviving hypothesis with the order to test it in. The scope call — fold the diagnosis in versus cut it — was put to the user, who chose diagnose-and-fix-if-small; that is what the step now says.
Also applied: six load-bearing facts an implementer would otherwise re-derive are now in (#silent-join-anatomy), each read from the code — `exit()` does not touch `narration` (which is what makes [P02]'s press-time write survive the staged path's `mode.exit()`, and the plan asserted the write without establishing it); the controller *does* subscribe to the join store and `main.tsx` attaches it before any card mounts, and `sameRegister` compares by value, so two plausible rival causes of the silence are eliminated rather than left open; `performJoin` is the only production join sender on either side of the wire, which is what makes [P01]'s single call site complete; `narrateServerJoin`/`expectServerJoin` are dormant with test-only callers, so they are correctly out of scope but must seed `beginLand` if ever wired, now recorded in the follow-ons; and `hasStatusRow` gates on `landingRegister !== null`, which is why the dismissal window shows nothing rather than a stale line. Purpose, Strategy, Success Criteria, Scope, Assumptions, the ledger row, the Deliverable and the exit criteria were all reconciled to the new Step 3, and the plan now names [L31] as the law it serves.
Laws cross-checked: [L02] — every new piece of state is store-held and read through `useSyncExternalStore` or the controller's own snapshot; the State Zone Mapping is correct and introduces no React state. [L31] — honored, and now named as the plan's spine; the refusal-retraction requirement in [P02] is what keeps the fix from creating a new lie in the other direction. [L29] — the plan correctly requires `key(workspaceKey, dash)` for the new store write and I verified the wire echoes `project_dir` verbatim, so no shim is invited. [L22] — not implicated: nothing here drives DOM directly. [L06] — not implicated: no appearance state.
Deferred: nothing. No `[Q##]` remains — the one judgment call was asked and answered during this round.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The join's narration plumbing exists end-to-end: `join_in_with_progress` (`tugrust/crates/tugdash-core/src/ops.rs`) fires paired `squash`/`teardown`/`release`/`record` beats, `do_changeset_join` (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`) forwards each as a `changeset_join_land_delta` CONTROL frame, `ChangesetJoinStore` (`tugdeck/src/lib/changeset-join-store.ts`) holds the latest beat per dash and settles a terminal one on `changeset_join_ok`/`_err`, and `dashJoinRegister` (`tugdeck/src/lib/dash-join-register.ts`) renders "Joining X into Y — \<beat\>" on all three register surfaces. Yet a real join submitted from the composer shows nothing for several seconds. The cause is not a broken pipe — it is that **no beat exists during the front of the run**, on either end. The full anatomy is in the Deep Dive (#silent-join-anatomy); the two gaps are: the server's first beat is `squash`, which fires only after occupancy, identity reads, and the whole of `join_in`'s preflight; and the client deletes the previous beat at press time (`clearLand`) without writing a new one, so the register falls through to the standing-candidate arm and reads "Ready to join" while the join runs.

A second, adjacent defect rides along: the app-test `tests/app-test/at0405-changes-dash-lane.test.ts` is red on `main`, timing out after 100s waiting for the `session-changes-dash-draft` slot. Its cause is **not yet known**, and the two obvious guesses have both been eliminated by reading the code (#at0405-anatomy) — the surviving hypothesis is that the maintained draft never reaches the dash's feed entry, which is either a fixture/environment fault in the test or a real draft-ledger keying fault in the product. Step 3 diagnoses it and fixes it here if the cause is small, and stops and reports if it turns out to be a draft-ledger problem larger than a step.

#### Strategy {#strategy}

- Read the whole thing as an [L31] repair. A press must produce the act or a visible reason and never silence, and today an accepted join press produces several seconds of a *green resting sentence* — which is worse than silence, because it reports the opposite of what is happening. Every decision below is in service of that law.
- Fix the front of the narration at both ends, smallest-first: one server-side beat emitted the moment the handler accepts a non-preview join, and one client-side optimistic beat written at the accepted press.
- Move the composer register's existence to the press: `narration` is set in `land()` when the gate passes, not in `performJoin` after the shade's dismissal, so the register has a target from the press's own frame.
- Keep the beats a liveness hint. `changeset_all_bump()` stays the carrier of truth; a dropped beat costs the progress line and nothing else. Nothing in this plan gates any outcome on a beat.
- One vocabulary: the new beats join `BEAT_WORDS` in `dash-join-register.ts`, the single table every register surface reads through `dashJoinRegister()`.
- Treat `at0405` as a diagnosis with an unknown answer rather than a rewrite with a known one: find why the draft never reaches the entry, then repair the smaller of the test and the product — and stop rather than let a ledger investigation swallow the narration work.

#### Success Criteria (Measurable) {#success-criteria}

- From an accepted ⬆ press, the join-mode snapshot's `register` is non-null and `phase: "in_flight"` on the same synchronous derivation — no frame between press and terminal settle reads "Ready to join" (unit test, `join-mode-controller.test.ts`).
- The first `changeset_join_land_delta` frame a non-preview join emits is `preflight`/`start`, and it precedes every `squash` frame (Rust test extending `a_join_narrates_its_beats_on_the_wire`).
- A preview still emits no beats (existing Rust assertions stay green unmodified).
- A staged press whose re-check refuses retracts the optimistic beat — the register does not report "Joining" about a join that was refused (unit test).
- `at0405-changes-dash-lane`'s cause is named in the plan with the evidence for it, and either the file is green (`just app-test tests/app-test/at0405-changes-dash-lane.test.ts`) or the step records why the repair is larger than this plan and where it goes instead.

#### Scope {#scope}

1. `do_changeset_join` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — one early beat.
2. `ChangesetJoinStore` (`tugdeck/src/lib/changeset-join-store.ts`) — a `beginLand` writer for the optimistic beat.
3. `JoinModeController` (`tugdeck/src/lib/join-mode-controller.ts`) — press-time narration and beat, refusal retraction.
4. `BEAT_WORDS` in `tugdeck/src/lib/dash-join-register.ts` — two new rows.
5. `tests/app-test/at0405-changes-dash-lane.test.ts` and whatever its diagnosis names — the draft's path from `tugutil draft set` to the dash entry's `draft` field.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Gating the composer status row's register off the Prompt route, and making the composer route follow the Changes shade. That is `dash/join-offer-route.md`'s subject; this plan only guarantees the register has something true to say whenever it mounts.
- Unifying the join receipt with the Git Commit presentation, the `index.lock` arming race, and `dash replay`'s exit-code/status disagreement. Those are `dash/join-receipt-mechanics.md`'s subject.
- New beats inside `join_in_with_progress` itself. The handler-level `preflight` beat covers the whole span up to `squash:start`, including `join_in`'s own preflight running inside `spawn_blocking`; adding ops-level beats would double-narrate the same span.
- Any client-side liveness clock on the optimistic beat. The store deliberately removed its silence clock (see its module docblock); this plan does not reintroduce one.
- Passing `connected` into the composer's `dashJoinRegister` call. The wire-drop arm exists in the derivation; wiring the composer's read of it is untouched here.

#### Dependencies / Prerequisites {#dependencies}

- None on other plans. `dash/join-offer-route.md` touches the same register's *mount*; this plan touches its *content*. The two compose in either landing order because neither edits the other's lines: this plan's controller changes are in `land()`/`performJoin`, that plan's are in the snapshot consumer (`tug-prompt-entry.tsx`).

#### Constraints {#constraints}

- Rust workspace enforces `-D warnings`; never commit red.
- App-test output is the report — run `just app-test <file>` bare, never piped.
- The beat frames echo `project_dir` verbatim as the request sent it, and every send on this path carries the **workspace key** ([L29]) — new store writes must key the same way (`key(workspaceKey, dash)`), never the project root.
- `changeset_join_land_delta` is a tugcast CONTROL broadcast, server→client. It does not ride tugcode, so the tugcode inbound-message allowlist needs no edit — recorded so nobody goes looking.

#### Assumptions {#assumptions}

- The five prior dash/join plans (join-voice, dash-generality, unified-changes, join-landing-parity, dash-entry-points) are all landed on `main`; the file/symbol inventory below was read against that state on 2026-08-22.
- `at0405`'s red is current and reproducible: it was run during this plan's review on 2026-08-22 and failed as described in (#at0405-anatomy), with the harness reporting it red in the last 3 recorded runs back to `8c04a5616`. No assumption is made about *why*.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v5 conventions: explicit `{#anchor}` on every cited heading, kebab-case, `[P##]` for plan-local decisions (never `[D##]`), two-digit labels never reused, `**Depends on:**` lines with `#step-n` anchors, and `**References:**` lines citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. Every design call this plan needed is decided below; the diagnosis the idea asked for was completed during authoring and is recorded in the Deep Dives, so no step depends on an unknown.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Optimistic beat rests forever on a swallowed request | med | low | `changeset_join` always answers `_ok`/`_err`; wire-drop clears non-terminal beats | a register stuck "Joining" with a live wire |
| Staged refusal leaves a lying "Joining" beat | med | med | refusal paths retract via `clearLand` ([P02]); unit-tested | — |
| Early beat narrates a join occupancy then refuses | low | low | the `_err` reply settles the beat terminal `failed`, which is true — the press did fail | — |

**Risk R01: The optimistic beat outlives a request nothing answers** {#r01-optimistic-beat-orphaned}

- **Risk:** `beginLand` writes a non-terminal beat at press time; if no server reply ever arrives on a live wire, the register reads "Joining" indefinitely.
- **Mitigation:**
  - Every `changeset_join` request is answered — `do_changeset_join` has no exit that sends nothing (guards send `_err`, the join sends `_ok` or `_err`), and each of those settles the beat terminal in `ChangesetJoinStore._onControl`.
  - A dropped wire clears non-terminal beats already (`_failInFlight` deletes them and the register's wire-drop arm speaks for the gap).
- **Residual risk:** a server thread that hangs mid-join shows "Joining" until the wire recycles. That is the same exposure the resolve overlay accepted when it removed its silence clock — liveness bounding is the server's job, per the store's own docblock.

**Risk R02: The staged re-check refuses after the beat is written** {#r02-staged-refusal-lies}

- **Risk:** `land()` writes the optimistic beat, the shade dismisses, and `performJoin`'s live re-check refuses — the store still holds `requested`/`start`, so the shade's dash row and the Lens row narrate a join that never ran.
- **Mitigation:**
  - Every refusing branch in `performJoin` retracts the beat with `clearLand` and clears the press-time narration before publishing the refusal ([P02]).
  - Pinned by a unit test driving the staged path into a refusal (Step 2).
- **Residual risk:** none identified; `refuse()` is the single exit for refusals, so the retraction has one place to live per branch.

---

### Design Decisions {#design-decisions}

#### [P01] The press writes the first beat, client-side (DECIDED) {#p01-press-writes-first-beat}

**Decision:** `ChangesetJoinStore` gains `beginLand(workspaceKey, dash)`, which sets the dash's land progress to `{ beat: "requested", status: "start" }` (non-terminal). `JoinModeController.land()` calls it the moment the gate passes, replacing the `clearLand` call currently made later in `performJoin` — a new press's `beginLand` both retires the previous join's settled word and seeds the new narration in one write.

**Rationale:**
- Server latency can never produce a dead frame: the beat exists before the request leaves the client, so the register renders `in_flight` on the press's own derivation.
- The precedent is the terminal-settle logic one arm over: `changeset_join_ok`/`_err` settle a terminal beat instead of clearing precisely because fast joins were otherwise unobservable. This extends the same principle to the front of the run.
- Putting the write in the store (not the controller) keeps it visible to all three register surfaces — the Lens row and the shade's dash row subscribe to the same `landProgress` cell.

**Implications:**
- `_failInFlight` already deletes non-terminal beats on wire drop, so the optimistic beat inherits the right cleanup for free.
- Every server frame for the dash (`land_delta`, `_ok`, `_err`) overwrites the cell, so the optimistic beat is strictly a placeholder for the silent span.

#### [P02] Narration begins at the accepted press, and a refusal retracts (DECIDED) {#p02-narration-at-press}

**Decision:** `JoinModeController.land()` sets `this.narration = target` when the gate passes — before staging — instead of `performJoin` setting it after `sheetDidHide`. Every refusing branch in `performJoin` (the live gate re-check and the missing-verb-store arm) retracts: `clearLand(workspaceKey, target.name)` and `this.narration = null` before `refuse()` fires (the re-entry path's `enter(target)` already nulls the narration; the retraction still clears the store beat).

**Rationale:**
- The staged land dismisses the shade and exits the mode at press time, and `registerTarget` is `this.target ?? this.narration` — with narration set only in `performJoin`, the composer register has **no target at all** during the dismissal animation, then derives "Ready to join" until the first server beat. Setting narration at the press closes both gaps.
- A register that says "Joining" about a refused join is the same resting lie in the other direction; the retraction is what keeps [P01] honest.

**Implications:**
- `performJoin` keeps its live re-check unchanged; only its bookkeeping moves.
- `enter()` already sets `narration = null`, so re-aiming after a refusal needs no new code beyond the store retraction.

#### [P03] The server narrates the front with one `preflight` beat (DECIDED) {#p03-server-preflight-beat}

**Decision:** `do_changeset_join` emits a `changeset_join_land_delta` frame with `beat: "preflight"`, `status: "start"` immediately after the registry and git-worktree guards pass and `request.preview` is known false — before the `dash_owner_key` and rounds reads, before occupancy, before `spawn_blocking`. No paired `done` frame: the next thing the wire says about this dash is `squash:start` (or a terminal `_err`), and the register only ever renders the latest beat.

**Rationale:**
- The span from handler-accept to `squash:start` is where the observed silent seconds live: two synchronous git reads on the async task, occupancy, then the whole of `join_in_with_progress`'s preflight inside `spawn_blocking` — `migrate_worktrees`, rerere config, branch/journal/cwd/base checks, the intersection preflight's diffs, `commit_worktree_dirt` (a real `git add`+`commit`), and the ahead-count `rev-list`. One beat before all of it narrates the whole span.
- Emitting from the handler (not from `ops.rs`) keeps `join_in_with_progress`'s beat table exactly what its docblock promises — the join's own boundaries — and keeps the CLI path unchanged.
- Preview emits nothing, preserving `join_in_with_progress`'s "a preview narrates nothing" contract and the existing test assertions.

**Implications:**
- An occupancy refusal after the beat is fine: `send_changeset_join_err` follows, and the store settles the beat terminal `failed` — which is true of that press.
- Existing tests that skip `changeset_join_land_delta` frames while awaiting a result (`changeset_join_previews_and_executes`'s `next_control`) are unaffected by construction.

#### [P04] Two new words in the one vocabulary (DECIDED) {#p04-beat-words}

**Decision:** `BEAT_WORDS` in `tugdeck/src/lib/dash-join-register.ts` gains `requested: "starting"` and `preflight: "checking the base"`. No other table is created or edited.

**Rationale:**
- `BEAT_WORDS` is consumed only inside `dashJoinRegister()`, which all three surfaces (Lens `DashJoinRow`, the shade's dash row, the composer status row) render through the shared `DashJoinRegister` component — so two rows in one table is the entire display change.
- The register's docblock states the one-vocabulary rule explicitly; a second table for the front beats is the drift it warns about.

**Implications:**
- An unknown beat already falls back to the raw word (`BEAT_WORDS[landing.beat] ?? landing.beat`), so the deploy order of Steps 1 and 2 cannot render nonsense — at worst "— preflight" until the word lands.

#### [P05] at0405 is diagnosed before it is repaired, and the repair is bounded (DECIDED) {#p05-at0405-diagnose-first}

**Decision:** Step 3 finds why `at0405-changes-dash-lane` times out and then repairs the smaller of the two candidates: if the fault is in the fixture or its environment, fix the test; if it is a one-seam product fault in the draft's path to the dash entry, fix the product. If the cause is a draft-ledger keying or scoping problem larger than a single step, the step **stops**, records the cause and its evidence in this plan, and hands it to its own plan rather than growing this one.

**Rationale:**
- The two guesses that would have made this a rewrite are both eliminated by the code (#at0405-anatomy): the `lands as` slot cannot be superseding the draft in this fixture, because a standing offer requires a candidate that this dash never gets; and the entry's `draft` field has not been removed from the wire.
- What is left — the maintained draft not reaching `DashChangesetEntry.draft` — is a class that spans a test-env fault and a real [L29] keying fault, and those want opposite repairs. Committing to either in advance is how a plan writes a fix for a bug it has not found.
- The bound is what keeps this plan a narration plan. The red predates it and is not caused by it, so the narration work must be able to land whatever the draft investigation turns up.

**Implications:**
- Step 3's Tasks are ordered diagnosis-then-repair with an explicit stop condition, and its checkpoint accepts either a green file or a recorded hand-off.
- Step 3 stays independent of Steps 1–2 — nothing in the narration change touches the draft's path to the entry — so a stop there leaves the plan's deliverable intact.
- The test's `@covers` lines already name `session-changes-dash-lane.tsx`; a test-side repair needs no declaration change. A product-side repair must add the touched source to `@covers` (`just app-test-covers-check` enforces it).

---

### Deep Dives {#deep-dives}

#### Anatomy of the silent join {#silent-join-anatomy}

The complete causal chain, established by reading the landed code (all paths relative to repo root):

1. **The press.** The composer ⬆ in join mode calls `JoinModeController.land()` (`tugdeck/src/lib/join-mode-controller.ts`). With the session card's land hook installed, the press **stages**: `createStagedLanding` parks `runJoin`, the mode exits (clearing `this.target`), the Changes shade dismisses, and `sheetDidHide` later runs `performJoin`. From the user's chair: the shade animates away and they are looking at the transcript and composer.
2. **The register goes dark, then lies.** The composer's register target is `this.target ?? this.narration`. The mode exit nulls `target`; `narration` is set only inside `performJoin` — so during the dismissal animation the register has no target and does not mount at all. When `performJoin` runs, it calls `clearLand` (deleting any previous join's settled word) and sends the request. With `landBeat === null`, `dashJoinRegister`'s arm order falls through blockers → landing → question → stuck → running to the standing-candidate arm: **"Ready to join", phase `success`** — a green resting state shown over a running join, until the first server beat overwrites it.
3. **The server's first word is late.** `do_changeset_join` (`agent_supervisor.rs`) accepts the request, then before any beat: reads `dash_owner_key` and the round count (synchronous git), acquires join occupancy, and enters `spawn_blocking`. Inside, `join_in_with_progress` (`ops.rs`) runs its whole preflight — `migrate_worktrees`, rerere config, branch existence, base resolution, journal check, cwd check, current-branch check, the intersection preflight's diffs, `commit_worktree_dirt` (a real commit when the worktree is dirty), and the ahead-count `rev-list` — before `on_beat("squash", "start")` fires. Those are the observed silent seconds.
4. **The ending was already right.** `changeset_join_ok`/`_err` settle a terminal beat that rests (`SETTLED_REST_MS`), and `scheduleNarrationRetirement` retires a success after its rest. Nothing in the tail needs work.
5. **No surface is structurally register-less.** All three surfaces subscribe to the same `landProgress` cell keyed `(workspaceKey, dash)`, and the wire echoes `project_dir` verbatim so the keys meet ([L29]). The silence is temporal — no beat exists during the front — not spatial. (The register also currently mounts on the Prompt route where it reads as a stray tool-call pill; that mount gating is `dash/join-offer-route.md`'s subject.)

The two fixes and their meeting point: after [P01]/[P02], the press itself writes `requested`/`start` and aims the narration, so the register renders "Joining \<dash\> into \<base\> — starting" from the press's own frame; after [P03], the wire's `preflight`/`start` overwrites it once the server accepts, then `squash` and the rest follow as today.

**Five facts an implementer would otherwise re-derive, each read from the code on 2026-08-22:**

- **`exit()` does not touch `narration`.** It clears `active`, `seedMessage`, `target`, and `landRefusal` only. So [P02]'s write in `land()` survives the staged path's `mode.exit()`, which is what makes press-time narration possible at all. `enter()` and `retarget()`/`aim()` *do* null it, deliberately — a composer aimed somewhere new stops narrating the last join.
- **The controller already subscribes to the join store.** Its constructor pushes `joinStore.subscribe(() => this.recompute())`, and `main.tsx` calls `attachChangesetJoinStore` at boot, before any session card mounts and constructs a controller. So a beat does reach the composer's snapshot; the silence is not a missing subscription.
- **`sameRegister` compares the register by value** (`phase`/`line`/`word`) inside `snapshotsEqual`, with a docblock explaining that a live join moves nothing else on the snapshot. So a new beat fires listeners. Note that `narrating` is *not* compared — which is fine here only because every narration change this plan makes also changes the register.
- **`performJoin` is the only production sender of a join.** `ChangesetVerbStore.join` has exactly one non-test caller, and server-side `do_changeset_join` has exactly one call site (the `changeset_join` CONTROL handler). There is no second press path to teach.
- **`narrateServerJoin` and `expectServerJoin` are dormant.** Both exist for a prompt-sheet "Join now" that starts a join server-side, and both have test-only callers today — the shipped offer is a standing fact the Changes shade renders, and the press still goes through the composer. Leave them alone; but if either ever gains a production caller, it must seed `beginLand` for the same reason [P01] gives, since a server-started join has no client press to write the first beat.

- **The composer's status row mounts only when the register is non-null** (`hasStatusRow` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx` includes `landingRegister !== null`), which is why the dismissal window shows nothing at all rather than a stale sentence.

#### Anatomy of the at0405 red {#at0405-anatomy}

**What the test does.** `tests/app-test/at0405-changes-dash-lane.test.ts` seeds a real dash via the real CLI in a scratch repo it owns, commits a round, writes a draft with `tugutil draft set --owner dash:<name>` against the instance's own changes DB (`TUG_CHANGES_DB`), writes an unrelated file in the project to nudge a recompose, and then waits for `[data-slot="session-changes-dash-draft"]` inside that dash's row.

**What it does now.** Run bare during this plan's review on 2026-08-22: `TimeoutError: waitForCondition exceeded 100000ms` on that selector, 1 of 2 tests passing, with the harness's history line reporting it red in the last 3 recorded runs back to `8c04a5616`. So the red is current and reproducible, and predates this work.

**Two hypotheses, and reading the code got the first one wrong.**

1. *The offer supersedes the draft.* The lane renders `offer !== null ? lands-as : entry.draft !== undefined ? draft : null` (`session-changes-dash-lane.tsx`), so a standing offer hides the awaited slot. This was argued away during the review on the grounds that `standing_offer` (`tugrust/crates/tugcast/src/feeds/join_board.rs`) needs a candidate, that a candidate comes from the resolution ladder, and that the ladder only runs for a server-bound dash — which this fixture's synthesized `bind_dash_ok` cannot produce. **The argument was wrong, and the run says so.** Step 3 dumped the row's slots at the moment of the timeout: `session-changes-dash-lands-as` is present and `session-changes-dash-draft` is not. The dash is join-ready from its first round, the arc arms it with nobody asking ([D147]), and the offer stands. Whatever the binding does or does not gate, it does not gate this.
2. *The grammar was removed.* It was not: `DashChangesetEntry.draft` is still on the wire type (`tugdeck/src/lib/changeset-types.ts`), still rendered by the lane, and still composed server-side (`draft_from_row` / `attach_live_session_drafts` in `tugrust/crates/tugcast/src/feeds/changeset.rs`).

**The cause, observed.** The test waited for a grammar that could not appear on this fixture. `join_ready` (`tugrust/crates/tugdash-core/src/dash.rs`) is satisfied the instant the fixture's round lands — `rounds >= 1`, no tracked worktree dirt, `decls.step.is_none()` for a plan-less dash — so the offer stands from before the draft is even written, and the fold shows `lands as` for the rest of the run. The draft is not missing: `landing_message_preview` (`ops.rs`) reads it from the same ledger and the offer carries it, which is why the repaired test finds the draft's words in the fold within a second or two.

**The repair, and why it is the test's.** The product is doing what [D152] says: the fold shows what the join would land whenever there is a join to land, and the plain draft otherwise. So the fixture waits for the draft's **words** rather than for one of the two slots, then reads whichever grammar carried them and asserts that grammar's own claims — for `lands as`, that no provenance note stands, which is how the offer says these are the draft's words rather than the branch description's. Evidence the repair is real rather than a loosened assertion: the file goes 2/2 in 11 seconds, against 1/2 and a 100-second timeout before it.

---

### Specification {#specification}

**Spec S01: The wire's front beat** {#s01-front-beat-wire}

A non-preview `changeset_join` request produces, as its first `changeset_join_land_delta` frame:

```json
{ "action": "changeset_join_land_delta", "project_dir": "<echoed verbatim>", "dash": "<echoed>", "beat": "preflight", "status": "start" }
```

emitted after the not-an-open-project and not-a-git-repository guards pass and before the dash identity reads. It has no paired `done`. A preview request emits no `changeset_join_land_delta` frames at all.

**Spec S02: The optimistic beat's lifecycle** {#s02-optimistic-beat-lifecycle}

`beginLand(workspaceKey, dash)` sets the cell to `{ beat: "requested", status: "start" }` with no `terminal` flag. It is overwritten by any server frame for the dash; deleted by `_failInFlight` on wire drop (non-terminal); retracted by `clearLand` when a staged press's re-check refuses. It is never written by anything but an accepted press, and `clearLand`'s existing docblock role — "what a new press does to the last narration" — transfers to `beginLand`'s replace-in-one-write.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| optimistic land beat (`requested`) | external store | `ChangesetJoinStore._land` + `useSyncExternalStore` readers | [L02] |
| press-time narration target | external store (controller snapshot) | `JoinModeController` field, published via its snapshot | [L02] |

No new React state, no appearance state; the register's rendering is unchanged apart from two vocabulary rows.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun)** | store/controller/derivation behavior per seam | Steps 1–2 client seams |
| **Integration (Rust)** | the wire's beat shape end-to-end through the real handler on a scratch repo | Step 1's server beat |
| **App-test** | the lane's grammar against a real dash and the real CLI | Step 3 |

#### What stays out of tests {#test-non-goals}

- No app-test asserting a mid-flight beat between press and receipt — a scratch-repo join can complete inside one frame batch, so the assertion races the run it observes. Each seam is pinned where it is deterministic instead: the store's writes (unit), the controller's press/refusal bookkeeping (unit), the wire's frame order (Rust, which collects all frames after the fact).
- No mock-store or fake-DOM render tests (banned shapes); the register derivation is a pure function and is tested as one.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The server narrates the front | done | `eae88adc9` |
| #step-2 | The press writes the first beat | done | `045026ea1` |
| #step-3 | Find why at0405's draft never arrives | done | `ac83ab65b` |
| #step-4 | Integration Checkpoint | done | `fa23cb06f` |

#### Step 1: The server narrates the front {#step-1}

**Commit:** `tugdash(join-narration): server narrates the join's front`

**References:** [P03] server preflight beat, Spec S01, (#silent-join-anatomy, #success-criteria)

**Artifacts:**
- `do_changeset_join` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` emits the `preflight`/`start` frame per Spec S01.

**Tasks:**
- [ ] In `do_changeset_join`, after the git-worktree guard and only when `!request.preview`, send the Spec S01 frame on `self.control_tx` — same JSON shape and `Frame::new(FeedId::CONTROL, …)` construction the existing beat forwarder uses, echoing `project_dir` and `dash` verbatim from the request.
- [ ] Keep the emission above the `dash_owner_key`/rounds reads and the occupancy acquire, so the beat covers them (an occupancy refusal after it is fine — the `_err` settles the beat terminal, per [P03]).

**Tests:**
- [ ] Extend `a_join_narrates_its_beats_on_the_wire` (same file's test module): collect the run's `changeset_join_land_delta` frames and assert the first is `preflight`/`start` and every `squash` frame comes after it.
- [ ] Assert a `preview: true` request emits zero `changeset_join_land_delta` frames (extend the same test or the preview arm of `changeset_join_previews_and_executes`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: The press writes the first beat {#step-2}

**Depends on:** #step-1

**References:** [P01] press writes first beat, [P02] narration at press, [P04] beat words, Spec S02, Risk R02, (#silent-join-anatomy, #state-zone-mapping)

**Commit:** `tugdash(join-narration): the press writes the first beat`

**Artifacts:**
- `beginLand` on `ChangesetJoinStore` (`tugdeck/src/lib/changeset-join-store.ts`).
- Press-time narration and refusal retraction in `JoinModeController` (`tugdeck/src/lib/join-mode-controller.ts`).
- `requested` and `preflight` rows in `BEAT_WORDS` (`tugdeck/src/lib/dash-join-register.ts`).

**Tasks:**
- [ ] Add `beginLand(workspaceKey, dash)` per Spec S02, adjacent to `clearLand` and cross-referenced in both docblocks (the replace-previous-word role moves to `beginLand`; `clearLand` remains the retraction verb).
- [ ] In `land()`, after the gate passes and `clearRefusal()` runs: call `getChangesetJoinStore()?.beginLand(…)` and set `this.narration = target` before the staged/inline fork ([P02]).
- [ ] In `performJoin`: remove the `clearLand` + `this.narration = target` pair (both moved to the press); in each refusing branch (failed live re-check, missing verb store), retract with `clearLand` and `this.narration = null` before `refuse()` (Risk R02).
- [ ] Add the two `BEAT_WORDS` rows ([P04]).

**Tests:**
- [ ] `changeset-join-store.test.ts`: `beginLand` seeds `requested`/`start` non-terminal; a `changeset_join_land_delta` overwrites it; `changeset_join_ok` settles it terminal; a wire drop deletes it (via the existing `_failInFlight` path).
- [ ] `join-mode-controller.test.ts`: an accepted staged press yields a snapshot whose `register` is non-null and `in_flight` immediately (before any server frame); a staged press whose re-check refuses leaves `landProgress` null and the register out of the joining arm; a second press replaces the prior settled word.
- [ ] `dash-join-register.test.ts`: `landBeat: {beat:"requested",status:"start"}` renders "Joining X into Y — starting"; `preflight` renders "— checking the base".

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/changeset-join-store.test.ts src/lib/__tests__/join-mode-controller.test.ts src/lib/__tests__/dash-join-register.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 3: Find why at0405's draft never arrives {#step-3}

**References:** [P05] diagnose before repairing, (#at0405-anatomy)

**Commit:** `tugdash(join-narration): at0405 sees the dash's draft`

**Artifacts:**
- A named cause for the timeout, recorded in (#at0405-anatomy) with its evidence.
- Whichever of `tests/app-test/at0405-changes-dash-lane.test.ts` or the draft's server-side path the cause indicts — or, on the stop condition, a hand-off note naming where the repair goes.

**Tasks:**
- [ ] Reproduce and observe, rather than re-deriving: run the file and, while it is waiting, read what the row's fold actually contains. The two eliminated hypotheses in (#at0405-anatomy) are not to be re-tested — the question is only whether `entry.draft` is present on the dash's feed entry.
- [ ] Establish where the draft stops: is the row written (inspect the run's changes DB with `just db-inspect`, never a live `sqlite3`), is it written under the key the recompose reads ([L29]: `(workspace_key, owner_kind, owner_id)`), and does the nudge wake a recompose that carries dash drafts at all.
- [ ] Repair the smaller side per [P05] — the fixture if the fault is the test's, the projection or keying if it is the product's. A product-side repair adds the touched source to the file's `@covers` block.
- [ ] Stop condition: if the cause is a draft-ledger keying or scoping problem larger than this step, do not start it. Record the cause and the evidence in (#at0405-anatomy), note the hand-off in (#roadmap-follow-ons), and close the step there.

**Tests:**
- [ ] The file's own assertions, once it can see the draft; no new test file. A product-side repair also gets a Rust-layer test over the projection that made the row invisible, at the seam the diagnosis names.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0405-changes-dash-lane.test.ts` — run bare, output is the report — **or**, on the stop condition, the recorded cause and hand-off, with the file still red and known-why.

---

#### Step 4: Integration Checkpoint {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `N/A (verification only)`

**References:** [P01], [P03], (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json`; in this repo `sh scripts/verify-fit.sh {base} {head}`), substituting `{base}`/`{head}` from the replay's JSON.
- [ ] `Current`: the base never moved — the last step's checkpoint already verified these exact bytes; re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree as ordinary work, commit it as a round, then verify as above.

**Tests:**
- [ ] None of its own; this step establishes that the steps' work holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A join narrates itself from the instant of the press — an optimistic client beat, a server front beat, and no frame in between where the register rests on "Ready to join" — and `at0405-changes-dash-lane`'s long-standing timeout has a named cause, repaired here or handed off with its evidence.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The first wire beat of a non-preview join is `preflight`/`start`, before any `squash` frame (Rust test, Step 1).
- [ ] An accepted press renders the register `in_flight` on its own frame, and a staged refusal retracts (unit tests, Step 2).
- [ ] "Joining X into Y — starting" and "— checking the base" render from the one vocabulary (unit test, Step 2).
- [ ] `at0405-changes-dash-lane`'s cause is named with evidence, and the file is green or its repair is handed off with a reason (app-test / recorded diagnosis, Step 3).

**Acceptance tests:**
- [ ] The extended `a_join_narrates_its_beats_on_the_wire` (Step 1).
- [ ] The press/refusal cases in `join-mode-controller.test.ts` (Step 2).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap-follow-ons}

- [ ] Register mount gating and route-follows-shade — `dash/join-offer-route.md`.
- [ ] Join receipt unification and run-ending mechanics — `dash/join-receipt-mechanics.md`.
- [ ] A draft-ledger repair, if Step 3's stop condition fires — its own plan, seeded by the cause and evidence Step 3 records in (#at0405-anatomy).
- [ ] `narrateServerJoin` / `expectServerJoin` are dormant scaffolding for a server-started join with no production caller (#silent-join-anatomy). Either wire the path or retire the pair; whoever wires it must seed `beginLand` per [P01].
