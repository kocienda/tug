# The Join Arc {#join-arc}

**Purpose:** Make the stretch between a dash reaching `built` and its join landing into a designed arc — the machine reconciles and checks the merged tree unprompted, the user is asked exactly once at the decision, the join narrates itself while it runs, and every act lives in Z5 or the prompt rather than as a button on the Changes shade.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-20 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-20, opus.** Reviewed `plan:03f00f825e66e2b0`. Lint: 0 errors, 0 warnings on the first pass and after every fixup.
Oriented on: the plan as authored — this is the first round, so the whole document was read against the real tree.
Applied: **technical choice** — the pilot's attempt-mark comparison was placed inside the predicate and on the changeset recompute, which is wrong twice. `DashDetail` carries no head sha and `resolve::candidate_status` returns early before its two `rev-parse` calls when no candidate ref exists, so exactly the dashes the pilot most wants (conflicted, uncandidated) would have cost two new git subprocesses per dash per recompute — violating the plan's own hot-path constraint — and a mark checked on the recompute but acted on a scheduling hop later is a time-of-check/time-of-use window a second recompute walks through. The comparison moved into the dispatched task under the occupancy guard as the new Spec S06, `pilot_action` shrank to a pure function over state already in hand, and the constraint, [P01], Risk R01, Table T02, Step 1 and Step 2 were all corrected to match. **Accuracy** — `join_in` is in `tugdash-core/src/ops.rs`, not `lib.rs`; the Symbol Inventory and the beat-callback deep dive were corrected. **Accuracy** — `TugPopupMenu` lives in `internal/` and no card composes it; Step 12 was repointed at `TugEditorContextMenu` with `useSessionIdentityMenu` as the shipped model. **Law discipline** — [L20] was cited twice for composition, which is not what it says (it governs token scoping); Steps 6 and 12 now cite [L19] for the authoring contract and [L20] for the real constraint, that the register must never reach into `BlockHeader`'s `--tugx-toolheader-*` family, which is exactly what the spike's CSS did. A `#law-cross-check` section (Table T03) was added naming all eleven laws the plan touches and flagging [L31] as the one this plan could quietly weaken. **Sequencing** — Step 7 had no test that could fail before Step 13 landed, which the rubric names as a defect even when the dependency graph is legal; it now runs the two shipping app-tests whose `@covers` already name the files it edits. **Holes** — two failure paths were unaddressed and are now decided in [P06] and tasked: the prompt must yield to a composer already in a landing mode (a modal over a half-typed commit is the interruption the design exists to delete, while a running turn is *not* a reason to hold), and a refused `join-now` must write no prompt mark so the next decision re-asks rather than going silent. **Test sanity** — at0444 was listed as an update; it presses a Resolve button that will not exist and its arc is started by the pilot now, so it is a rewrite, and the step says so.
Deferred: the pilot's aggregate model spend stays [Q01] — the trigger line lands in Step 2 and the config knob is a follow-on if the logs justify it. That was the user's framing when they chose the full ladder, and nothing in the code changes it.

---

### Phase Overview {#phase-overview}

#### Context {#context}

A dash today finishes its run and dumps the user into prose: the agent's last line is a `/join <name>` chip, and pressing it opens a Changes shade carrying a thicket of buttons — `RESOLVE`, `RESOLVE AGAIN`, `VERIFY`, `JOIN ANYWAY`, `Resume teardown`, `UNBIND`, `DISCARD` — most of which ask the *user* to start work the *machine* should have done before asking for attention. Verification does not begin until the shade is opened, so a person who came to land a finished dash is told "Verify the joined tree first" and then waits. When the checks do run, their failure arrives as a wall of compiler output where a verdict belongs. And when the client's per-frame silence clock fires, the shade says *"No answer from the resolution ladder in 12 seconds — its result will appear on this row if it finished."* — a sentence that guesses at liveness the client cannot see and names no act.

The join itself is then silent: the press lands, and nothing speaks until the durable commit message appears in the transcript many seconds later.

The design was worked out across four rounds in the `join-arc` design spike (`tugdeck/src/spikes/spike-join-arc.tsx`), which this plan implements and then deletes. Its rule, applied five times: **the machine works first, the user decides once, and every act lives in Z5 or a summoned prompt.** Status is never a control; the shade is a glance.

#### Strategy {#strategy}

- **The eager pipeline lands before the buttons die.** Deleting `RESOLVE` first would strand a conflicted dash with no door out. The pilot ([P01]) ships first; the face is disarmed last ([P08]).
- **Reuse the transcript's own chrome for status.** Every register and the join's progress line is a `BlockHeader` — the vetted Quiet Line — so the lifecycle pulsing dot carries the state and no new status vocabulary is invented ([P04]).
- **Every new server fact is durable and self-demoting**, following the existing `(base_sha, candidate_sha)` cacheability split in `tugrust/crates/tugdash-core/src/verify.rs`. A fact that cannot survive a reload is not a fact the face may depend on.
- **The wire grows additively.** `DashJoinState` gains fields; nothing existing changes shape, so a partially-updated client degrades to today's behavior rather than breaking.
- **The reachability invariant is restated, not deleted** ([P09]). Removing the controls it points at would silently gut [L31]; the replacement claim is stronger and simpler.
- **Tests move with the surfaces they cover.** The join app-tests drive controls that will not exist; they are rewritten against the new arc, not patched.

#### Success Criteria (Measurable) {#success-criteria}

- A dash marked `built` with a moved base reconciles and runs its Tier 0 build **with no user gesture** — verified by at0441, which marks a scratch dash built and waits on the feed for `join.candidate` and `join.verification.tier0 === "green"` without touching the shade.
- The Changes shade's dash row mounts **zero** join controls — no element carrying `data-slot="session-changes-dash-resolve"`, `…-join-verify`, `…-join-override`, or `…-resume` exists in the DOM in any join state. Pinned by at0441 and at0443.
- A join in flight publishes at least one `changeset_join_land_delta` beat before its `changeset_join_ok`, and the composer's status row renders a register naming the current beat — pinned by at0441.
- The string `"resolution ladder in"` appears nowhere in `tugdeck/src` — pinned by a grep assertion in `tugdeck/src/lib/__tests__/changeset-join-store.test.ts`.
- Over a red Tier 0 verdict the composer's land button carries `role="danger"` and its press opens a confirm rather than landing — pinned by at0443.
- A dash at `built` whose decision is `clean` raises the prompt sheet exactly once; dismissing with "Not yet" and then moving the base without changing the decision raises **no** second prompt — pinned by at0445.
- `cargo nextest run`, `bun test`, `bunx tsc --noEmit`, and `bunx vite build` are all clean at every step boundary.

#### Scope {#scope}

1. A server-side **join pilot** that reconciles and Tier-0-checks a `built` dash unprompted, exactly once per `(base_sha, dash_head)` ([P01]).
2. Retirement of Tier 1 from every join-time path ([P02]).
3. **Beat narration** for the join itself — a progress callback through `join_in`, `changeset_join_land_delta` CONTROL frames, and a client store that holds them ([P03]).
4. Death of the client-side silence deadline and both word-salad sentences ([P03]).
5. One **status register** derivation and component, mounted on three surfaces ([P04]).
6. A **role- and confirm-aware Z5** land control ([P05]).
7. The **prompt at built** — a durable `join.prompt` fact, a card-hosted modal sheet, an answer wire, and the re-ask policy ([P06], [P07]).
8. **Disarming the shade**: controls deleted or moved to a `⋯` menu, and the reachability invariant restated ([P08], [P09]).
9. App-test and documentation sync; the spike is deleted.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **The numbered step list.** It remains tabled for a possible Z2 WORK popover refresh and is not built here.
- **Tier 1 as a background job.** It is not run at join time by anything, and it is not rescheduled elsewhere ([P02]).
- **A generalized "server may ask the user anything" framework.** The prompt at built is one concrete fact on one existing feed block, not a new ask subsystem.
- **Changing what `join_in` does.** The join's git semantics — squash, teardown, branch delete, binding release — are untouched; only its narration is new.
- **Changing the resolution ladder's rungs or the resolver's charter.** The pilot invokes the existing ladder unchanged.
- **The Lens Dashes section's structure.** It keeps the eyebrow/meta grammar from [D141]; only the status register is added.

#### Dependencies / Prerequisites {#dependencies}

- The join occupancy registry (`tugrust/crates/tugcast/src/feeds/join_occupancy.rs`) — one run per dash — already exists and is what keeps the pilot from racing a manual act.
- The join board (`tugrust/crates/tugcast/src/feeds/join_board.rs`) already computes `DashJoinState` on every changeset recompute; the pilot reads its output rather than re-deriving.
- `BlockHeader` (`tugdeck/src/components/tugways/blocks/block-header.tsx`) and `toolCallPhaseVisual` (`tugdeck/src/lib/code-session-store/tool-call-phase-visual.ts`) ship today and are the status vocabulary.
- The card-hosted sheet seam — `showSheet`, used by `useRewindSheet` in `tugdeck/src/components/tugways/cards/rewind-sheet.tsx` — is the prompt's mount.
- The dash app-test fixture (`tests/app-test/dash-fixture.ts`) creates scratch repositories; every dash test here uses it and never the developer's checkout.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace (`tugrust/.cargo/config.toml` sets `-D warnings`).
- **Only the user commits to `main`.** Dash rounds land via `tugutil dash commit` on the dash worktree.
- **No fake-DOM / RTL tests and no mock-store assertion tests** — banned by `tuglaws/dash-work-doctrine.md`. Browser behavior is an app-test; everything else is a pure-logic test.
- **App-tests are selective.** `just app-test-changed` derives the run from `@covers`; the full corpus is never swept on the implementer's initiative.
- The changeset recompute is a hot path that already does a blocking git walk per dash. The pilot's *predicate* must add **no** git work to it; the head-pair `rev-parse` and the mark read happen in the dispatched task instead ([Spec S01](#s01-pilot-predicate)). The prompt derivation ([P06]) does add one `config_get` per dash, which is in-family with the four `standing_*` config reads `join_state_for` already performs.
- The wire is JSON over CONTROL/feed frames; new fields are additive and optional, per the existing `DashJoinState` convention.

#### Assumptions {#assumptions}

- A dash reaches `built` through `tugutil dash mark <name> built`, which is what `dash-implement`'s Build phase runs; `stage` arrives on `DashDetail` and is already on the wire as `ChangesetEntry::Dash.stage`.
- Running the full resolution ladder — scribe rung included — without a press is acceptable model spend, decided in [P01].
- The prompt interrupts: a modal card-hosted sheet is the right surface, decided in [P06].
- A project that declares no `verify_tier0` command is green with a note, per `tugrust/crates/tugdash-core/src/verify.rs` — so the pilot is a no-op-with-a-note on projects that declare nothing, not a red.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines, per `tuglaws/devise-skeleton.md`. Plan-local decisions are `[P##]`; `[D##]` cites the global `tuglaws/design-decisions.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where the pilot's cost shows up over a long day (OPEN) {#q01-pilot-cost-visibility}

**Question:** The pilot may run a scribe-backed resolution ladder per `(base_sha, dash_head)` pair, unprompted, for every `built` dash in every open workspace. Nothing in the design surfaces the aggregate cost of that.

**Why it matters:** The attempt mark ([P01]) bounds re-runs per head, but a busy `main` moving five times against three built dashes is fifteen ladder runs nobody asked for. If that turns out to be material, the mitigation is a policy knob (`[tugtool.dash].pilot = "full" | "algorithmic" | "off"`) — cheap to add later, but only if the cost is visible enough to notice.

**Options (if known):**
- Ship as designed and watch; add the knob if it bites.
- Add the config knob now, defaulting to `full`.
- Log a per-run cost line and revisit after a week of real use.

**Plan to resolve:** Ship [P01] with a `tracing::info!` line per pilot run naming the dash, the trigger pair, and the rungs it used (already required by Step 2's tasks). Revisit after the arc has been in real use.

**Resolution:** DEFERRED — the trigger line lands in Step 2, and the knob is a follow-on if the logs justify it.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The pilot loops on a dash whose ladder produces nothing | high | med | Durable attempt mark keyed on `(base_sha, dash_head)` ([P01]) | Any repeat pilot run on an unchanged pair |
| Controls deleted before the pilot works strands a conflicted dash | high | low | Step ordering: [P08] depends on the pilot's integration checkpoint | A conflicted dash with no candidate and no control |
| The prompt sheet interrupts typing | med | med | Only the dash's bound session's card raises it; unbound dashes never prompt ([P06]) | User reports a prompt over a live composer |
| Beat frames arrive after the join's own `_ok` | low | med | Beats are a liveness hint, never the carrier of truth — the feed recompute remains authoritative ([P03]) | A register stuck on a beat after the row left |
| Restating the reachability table quietly weakens [L31] | high | med | The invariant test is rewritten to the stronger claim, not deleted ([P09]) | Any refusal reason with no row |

**Risk R01: The pilot loops** {#r01-pilot-loops}

- **Risk:** `join_state_for` runs on every changeset recompute; a pilot that derives "needs reconciling" purely from that state will re-kick forever whenever a ladder run completes without producing a candidate and without writing a `stuck` fact.
- **Mitigation:**
  - A durable **attempt mark** in branch config, `branch.tugdash/<name>.tugjoinpilot`, holding `<base_sha>:<dash_head>`. The pilot refuses when the mark equals the current pair.
  - The mark is read and written **inside the dispatched task, under the occupancy guard** ([Spec S06](#s06-pilot-dispatch)) — not on the recompute. Checking it on the recompute and acting a scheduling hop later is a time-of-check/time-of-use window a second recompute walks straight through.
  - The mark is written **before** the run starts, not after, so a crash mid-run does not license a retry loop on restart.
  - It self-demotes by comparison: either sha moving makes the mark stop matching, which is the same shape the verdict and the override already use.
- **Residual risk:** A genuinely stuck ladder that neither writes `stuck` nor moves either head leaves the dash reconciled-never with no visible cause. The register's `wire-drop`/idle arm is what the reader sees; the durable `stuck` fact remains the resolver's own responsibility.

**Risk R02: Ordering** {#r02-ordering}

- **Risk:** The shade's controls are the only escape hatch for a conflicted dash today. Removing them before the pilot reliably reconciles leaves no path forward.
- **Mitigation:**
  - Step 12 (`#step-12`) depends on Step 3's integration checkpoint (`#step-3`), which is where the pilot is proven end to end on a real scratch repo.
  - The prompt's "Review first" answer routes to join mode, which is a second, independent path to the composer.
- **Residual risk:** A dash that is `blocked` (not conflicted) still depends on each blocker's own act, which lives outside this surface and is unchanged.

---

### Design Decisions {#design-decisions}

#### [P01] The machine reconciles unprompted, once per head pair (DECIDED) {#p01-the-pilot}

**Decision:** A **join pilot** in tugcast reacts to the changeset recompute: for every dash whose `stage` is `built`, whose `DashJoinState` shows no run, no blockers, no standing question and no standing stuck line, and which either lacks a candidate while conflicted or has a candidate whose Tier 0 verdict is `unrun`, the pilot runs the **full resolution ladder** (scribe rung included) and then Tier 0 — guarded by the occupancy registry and by a durable attempt mark.

**Rationale:**
- The user's attention is the scarce resource. Work that can be done before asking for it must be.
- The join board already computes exactly the state this decision needs, on every recompute, at no extra cost — the pilot is a predicate over `DashJoinState` plus `DashDetail.stage`, not a new query.
- The full ladder (rather than the algorithmic rungs alone) is what makes the arc's promise real: a conflicted dash arrives at the decision already reconciled, not with one more press pending.
- Occupancy already serializes runs per dash, so the pilot cannot race a `/join` the user typed.

**Implications:**
- A new durable mark, `branch.tugdash/<name>.tugjoinpilot` = `<base_sha>:<dash_head>`, written before the run. It dies with the branch, like the verdict and the override.
- The predicate is a pure function over state the recompute already holds — no shas, no marks, no I/O — so it unit-tests without a repository and adds nothing to the hot path ([Spec S01](#s01-pilot-predicate)).
- The head-pair `rev-parse` and the mark comparison move into the dispatched task, under the occupancy guard ([Spec S06](#s06-pilot-dispatch)). That is both the cheap place and the race-free one.
- The pilot spawns onto a blocking task and never blocks the recompute.
- A project declaring no `verify_tier0` gets a green-with-a-note verdict, per the existing rule in `verify.rs` — the pilot is a no-op there, not a red.

#### [P02] Tier 1 does not run at join time (DECIDED) {#p02-tier1-retired}

**Decision:** No join-time path runs Tier 1. The pilot asks for Tier 0 only; the client's verdict derivation (`verificationVerdict` in `tugdeck/src/lib/join-mode-controller.ts`) reads `verification.tier0` alone; the `changeset_join_verify` CONTROL action is retired along with the `VERIFY` button.

**Rationale:**
- Tier 1 drives real app launches behind a machine-wide gate and is bounded at twenty minutes (`TIER1_TIMEOUT`). A wait of indeterminate length between the user's decision and the join is exactly what this arc deletes.
- The dash's own per-step checkpoints ran the tests during the run. The join-time question is narrower and different: *does the merged tree build* — which the checkpoints could not have asked, because the merge did not exist yet.
- Keeping a tier the gate ignores would be worse than removing it: a `running` tier1 would make `verificationVerdict` return `running` and refuse a join for a reason nothing on screen explains.

**Implications:**
- `Verification.tier1` stays on the struct and on the wire — it is durable branch state and removing it is a schema change for no gain — but nothing derives a verdict from it.
- `run_join_verification`'s `tier` parameter survives for whatever non-UI caller may want it; the pilot always passes `Some("tier0")`.
- at0443's Tier 1 arm, if any, is rewritten to a Tier 0 red.

#### [P03] The join narrates its beats; the client stops guessing at liveness (DECIDED) {#p03-join-narrates}

**Decision:** `join_in` gains a beat callback and tugcast broadcasts `changeset_join_land_delta { project_dir, dash, beat, status }` frames as the join proceeds through `squash`, `record`, `teardown`, `release`. The client holds land progress in `ChangesetJoinStore` beside resolve progress. The per-frame silence deadline (`_armDeadline`, `RESOLVE_IDLE_DEADLINE_MS`) and both of its sentences are deleted; the connection-close failure arm survives.

**Rationale:**
- The join takes real seconds and today says nothing for all of them.
- A beat frame is a liveness hint, not truth — the feed recompute is authoritative, exactly as the resolve path already treats `changeset_join_resolve_ok` ([D-precedent in `do_changeset_join_resolve`, which bumps the recompute on every arm]).
- The deadline's premise was per-chunk streaming, which is false for every rung it still covered. It measured nothing and declared healthy work dead.
- A dropped wire is the one liveness fact the client can honestly see, so that arm stays.

**Implications:**
- `join_in`'s signature is preserved; a new `join_in_with_progress(dir, dash, opts, on_beat)` carries the callback and `join_in` delegates with a no-op, matching `run_declared`'s existing callback shape in `verify.rs`.
- `RESOLVE_IDLE_DEADLINE_MS` and `_deadlines` come out of `changeset-join-store.ts` entirely.
- A grep assertion pins that `"resolution ladder in"` never returns.

#### [P04] One status register, wearing the tool-call header (DECIDED) {#p04-status-register}

**Decision:** A pure derivation `dashJoinRegister(input) → { phase: ToolCallPhase, line: string, word: string }` in `tugdeck/src/lib/dash-join-register.ts`, rendered by a `DashJoinRegister` component in `tugdeck/src/components/tugways/` that mounts a `BlockHeader` with the sentence as `target` and the state word as a `{ kind: "text" }` summary. It mounts on the Lens Dashes row, the Changes shade's dash row, and the composer's status row.

**Rationale:**
- The transcript already taught this chrome. Inventing a second status vocabulary for the same kind of fact is how two surfaces drift.
- The lifecycle pulsing dot carries the state through the shipped `toolCallPhaseVisual` mapping — pulsing action for work, pulsing caution for a wait on the user, settled green and red for verdicts — so tone is not re-decided per surface.
- A pure derivation means the whole state→sentence table is unit-testable with no DOM, the way `deriveJoinFace` is today.

**Implications:**
- One place decides what the arc says, so the shade, the Lens and the composer cannot disagree.
- The derivation takes `{ entry, join, resolvePhase, landPhase, landBeat, connected }` and nothing else — no store reads inside it ([L02] is upheld by the callers).
- `BlockHeader`'s `altitude` prop (`leaf` | `entry` | `section`) is the knob for mounting outside the transcript.

#### [P05] Z5 carries the act's role and its confirm (DECIDED) {#p05-z5-role-confirm}

**Decision:** `LandingSnapshot` gains `landRole: "action" | "danger"` and `landConfirm: string | null`. `tug-prompt-entry.tsx`'s land button reads both instead of hardcoding `role="action"`; a non-null `landConfirm` makes the press open a `TugConfirmPopover` whose confirm runs the land. The join mode returns `danger` + a confirm sentence naming the failure count over a red Tier 0 verdict; the commit mode always returns `action` + `null`.

**Rationale:**
- `JOIN ANYWAY` as a separate button on the shade was a control offering a press whose refusal was computed somewhere the press never reached. The decision belongs on the act.
- A red verdict is not a caution — it is the existing `danger` role, and using it keeps one meaning for one hue.
- Putting the role on the snapshot rather than branching on `landingMode.kind` inside the entry keeps the entry ignorant of which landing it is hosting, which is what makes the two modes share one Z5.

**Implications:**
- `evaluateJoinGate`'s `verification-red` stops being a refusal and becomes the signal that arms the confirm. The `redOverride` arm and `redOverrideStands` survive: an override already recorded server-side still passes the gate without re-confirming.
- The confirm's press sends the join with `anyway: true`, which is the existing `JoinOptions` field.

#### [P06] The prompt at built is a durable feed fact rendered as a card-hosted modal sheet (DECIDED) {#p06-prompt-at-built}

**Decision:** `DashJoinState` gains `prompt: Option<DashJoinPrompt>` — `{ request_id, decision: "clean" | "red", base_sha, dash_head, question, options }` — raised by the pilot when its run finishes and cleared by an answer. The client renders it as a card-hosted modal sheet (the `showSheet` seam, as `useRewindSheet` uses) containing a `QuestionWizard`, on **the card of a session bound to that dash only**. The answer goes back on a new `changeset_join_prompt_answer` CONTROL action.

**Rationale:**
- The `join.question` block already proves the shape: a server-owned, durable, feed-carried ask that a `QuestionWizard` renders and a CONTROL action answers. This is a second instance of a pattern that works, not a new subsystem.
- Durable rather than ephemeral, so a reload does not lose the ask — the same reason `standing_question` is read on every recompute rather than held in memory.
- Modal because the whole point is that the decision is not missed; a passive shade would be exactly the "come find it later" the arc is replacing.
- Bound-session-only because an unbound dash has no card that is *about* it, and a prompt on an unrelated card is an interruption with no context. Unbound dashes keep the Lens row and `/join`.

**Implications:**
- Three options, matching the spike: **Join now** (lands with the standing draft), **Review first** (enters join mode without landing), **Not yet** (dismisses, per [P07]).
- The prompt's `request_id` guards against an answer resolving a different ask, exactly as `DashJoinQuestionWire.request_id` does.
- If two cards are bound to one dash, the prompt raises on each; the first answer clears the fact and the others' sheets close on the next recompute (`isPending` goes false).
- **The prompt yields to a landing already in progress.** A card whose composer is in commit or join mode does not raise the sheet — the user is mid-message, and a modal over a half-typed commit is the interruption this design was supposed to delete. The fact stays on the feed; the sheet raises when the mode exits. A running *turn* is not a reason to yield: the decision is about a dash, not about Claude, and a turn can run for minutes.
- **A failed `join-now` does not consume the ask.** If the land is refused (a blocker appeared between the derivation and the press, occupancy took the dash, the merge went stale), the sheet closes, the failure lands on the register as the join's own refusal sentence, and **no prompt mark is written** — so the next decision the pilot computes asks again rather than leaving the user with a dash nobody will mention twice.

#### [P07] Re-ask only when the decision changes (DECIDED) {#p07-reask-policy}

**Decision:** "Not yet" writes a durable **dismissal mark**, `branch.tugdash/<name>.tugjoinprompted` = `<decision>`, recording which decision was declined. The pilot re-raises the prompt only when the decision it computes differs from the dismissed one. A base move that reconciles to the same decision re-reconciles silently and asks nothing.

**Rationale:**
- Asking twice for the same decision trains the user to dismiss the dialog reflexively, which destroys the one prompt that matters.
- The *decision* — clean or red — is the thing the user answered about; the shas are not. Keying the mark on the decision rather than the head pair is what makes a routine base move silent.
- Green→red is a genuinely new question and must interrupt: the tree the user was about to land no longer builds.

**Implications:**
- The mark is keyed on the decision only, so it survives head movement by design — the opposite of the pilot's attempt mark ([P01]), which is keyed on the pair. The two marks answer different questions and must not be merged.
- Answering **Join now** or **Review first** clears the mark: the user engaged, so the next decision is fresh.
- A dash whose decision goes red after a dismissed clean prompts again; one that goes clean after a dismissed red also prompts again ("it builds now").

#### [P08] Every act leaves the shade (DECIDED) {#p08-shade-disarmed}

**Decision:** `session-changes-dash-join.tsx` mounts no join controls. `RESOLVE`/`RESOLVE AGAIN`, `VERIFY`, and `Resume teardown` are deleted outright (the machine runs all three); `JOIN ANYWAY` becomes the Z5 confirm ([P05]); `UNBIND` and `DISCARD` move into a `⋯` menu on the dash row in `session-changes-dash-lane.tsx`, keeping the discard confirm.

**Rationale:**
- Each deleted control asked the user to start machine work — the arc inverted.
- `Resume teardown` in particular: the join journal is durable and an interrupted teardown resumes itself; a button for it is a press that only exists because nothing resumed.
- `UNBIND` and `DISCARD` are rare lifecycle verbs, not resting controls. They keep working; they stop shouting.

**Implications:**
- `JOIN_CONTROL`, the `control` field on `JoinFace`, and `deriveJoinFace`'s control ladder are deleted; what remains folds into [P04]'s derivation.
- The blockers list, the conflicts list, the resolver's report, the verification failures and the escalation question **stay** — they are information, not controls, and the shade is still where a reader goes for detail.
- `resumeTeardown`, `resolve` and `verify` come off `DashJoinActions`; the server handlers for resolve and the question answer stay (the pilot and the escalation still use them), while `changeset_join_verify` retires with its button ([P02]).

#### [P09] The reachability invariant is restated, not deleted (DECIDED) {#p09-reachability-restated}

**Decision:** `REFUSAL_REACHABILITY` survives with a narrower shape: `where` becomes `"composer" | "time"`, the `"join-face"` arm and every `slot` naming a shade control are removed, and the invariant test in `tugdeck/src/lib/__tests__/join-resolve-face.test.ts` is rewritten to assert the stronger claim — **every refusal points at the composer, or names a wait that only time clears.**

**Rationale:**
- The table's whole purpose is [L31]: a refusal must name the act that clears it and that act must be on screen. Letting the table fall out with the controls would remove the enforcement while leaving the law nominally in force — the 2026-08-18 deadlock repeated with fewer buttons.
- The new claim is genuinely stronger: with no controls on the face, there is exactly one place a refusal can point, and a reason that points anywhere else is now a type error.

**Implications:**
- Reasons whose only act was a shade control (`outcome`'s conflicted arm, `unverified`) either disappear with their gate arms or re-point at time — the pilot is what clears them now.
- `refusalReachability`'s outcome-splitting helper shrinks accordingly.

---

### Deep Dives {#deep-dives}

#### How a dash reaches the pilot, end to end {#pilot-flow}

`tugcast`'s changeset feed recomputes on a bump (`registry.changeset_all_bump()`), and `dash_entries` in `tugrust/crates/tugcast/src/feeds/changeset.rs` does one `spawn_blocking` hop that walks every dash: `tugdash_core::dash_detail_entries_in(&root)` for the details, then `join_board::join_state_for(&root, &detail, &current_branch)` per dash. That call site is where the pilot's predicate runs — it already holds both inputs the predicate needs (`DashDetail` and `DashJoinState`) and pays nothing extra to consult them.

`join_state_for` derives `phase` as `"resolved"` when a candidate stands, `"conflicted"` when the merge probe found conflicting paths, and `"previewed"` otherwise; it also carries `run` (the live occupancy), `blockers`, `stuck`, `question`, `override_for`, and `verification` (the standing `(base_sha, candidate_sha)`-anchored verdict). Everything the predicate reads is already there.

The predicate itself must be pure so it is testable without a repository — and, critically, **it must read nothing the recompute has not already computed.**

`DashDetail` carries no head sha (its fields are `name`, `owner_key`, `branch`, `base`, `rounds`, the worktree paths, `files`, `round_subjects`, `stage`, the step counters, `plan_path`, `base_ahead`, …), and `resolve::candidate_status` — which *does* `rev-parse` both the base and the dash branch — returns early with `CandidateStatus::None` when no candidate ref exists. So on exactly the dashes the pilot most wants to act on (conflicted, no candidate), the head shas have **not** been computed and getting them means two new `git rev-parse` subprocesses per dash per recompute.

That is why the attempt-mark comparison is **not** part of the predicate. It lives in the dispatched task, which also makes it race-free: checking a mark on the recompute and acting a scheduling hop later is a time-of-check/time-of-use window that a second recompute can walk straight through.

**Spec S01: The pilot predicate** {#s01-pilot-predicate}

```rust
pub enum PilotAction { Reconcile, CheckTier0 }

/// What the pilot should consider doing about this dash, if anything.
/// Pure over state the recompute already has — no shas, no marks, no I/O.
pub fn pilot_action(stage: &str, state: &DashJoinState) -> Option<PilotAction>
```

Rules, in order:

1. `stage != "built"` → `None`. The pilot acts on a finished dash only.
2. `state.run.is_some()` → `None`. Something already holds this dash.
3. `!state.blockers.is_empty()` → `None`. A blocked dash needs an act elsewhere.
4. `state.question.is_some()` or `state.stuck.is_some()` → `None`. Waiting on a person, or a refusal already stated.
5. `state.candidate.is_none()` → `Some(Reconcile)`.
6. `state.verification` absent, or its `tier0` is `Unrun` → `Some(CheckTier0)`.
7. Otherwise → `None`.

**Spec S06: The pilot dispatch** {#s06-pilot-dispatch}

For each dash the predicate named, in a `tokio::spawn`ed task — never on the recompute:

1. Acquire occupancy (`join_occupancy::acquire`) for the action's `JoinRunKind`. A refusal means the dash is busy; log at `debug` and stop — the next recompute reconsiders.
2. `rev_parse` the base branch and the dash branch; compose `head_pair = "<base_sha>:<dash_head>"`.
3. Read the attempt mark. If it equals `head_pair`, release and stop (Risk R01).
4. Write the attempt mark **before** running, so a crash mid-run does not license a retry loop on restart.
5. Bump the aggregate, run the action, bump again.

Steps 1–4 are cheap and happen under the guard, so two recomputes racing the same dash produce exactly one run.

#### The beat callback through `join_in` {#beat-callback}

`tugdash_core::join_in(repo_root, name, opts) -> Result<JoinOutcome, String>` — defined in `tugrust/crates/tugdash-core/src/ops.rs`, re-exported at the crate root — is one synchronous call driven from `do_changeset_join` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` via `spawn_blocking`. The precedent for threading progress out of a blocking tugdash-core call is `run_join_verification`, which takes `on_progress: impl Fn()` and is invoked with a closure that fires `bump.notify_one()`.

Follow it exactly: add

```rust
pub fn join_in_with_progress(
    dir: &Path,
    dash: &str,
    opts: JoinOptions,
    on_beat: impl Fn(&str, &str),   // (beat, status)
) -> Result<JoinOutcome, String>
```

and make `join_in` a delegation with a no-op closure, so every existing caller — the CLI included — is untouched.

**Spec S02: The join's beats** {#s02-join-beats}

| Beat | Fires when | `status` values |
|---|---|---|
| `squash` | before and after the squash commit is created | `start`, `done` |
| `record` | around the landing receipt and dash-log write | `start`, `done` |
| `teardown` | around the workshop/worktree removal | `start`, `done` |
| `release` | around the branch delete, draft clear and binding release | `start`, `done` |

A preview (`opts.preview == true`) emits no beats — it mutates nothing and there is nothing to narrate.

The CONTROL frame:

**Spec S03: `changeset_join_land_delta`** {#s03-land-delta}

```json
{
  "action": "changeset_join_land_delta",
  "project_dir": "<the workspace key, echoed verbatim>",
  "dash": "<display name>",
  "beat": "squash|record|teardown|release",
  "status": "start|done"
}
```

`project_dir` is echoed exactly as sent, which is what keeps the reply correlated to the cell the request opened with no spelling to reconcile ([L29]) — the same rule `changeset_join_resolve_delta` follows.

#### What the register says in each state {#register-table}

**Table T01: The status register** {#t01-register}

| State | `phase` (dot) | Line | Word |
|---|---|---|---|
| reconciling | `in_flight` | `Reconciling with <base> — resolving N files` | `reconciling` |
| checking | `in_flight` | `Building the joined tree` | `checking` |
| ready | `success` | `Ready to join` | `ready` |
| question | `awaiting` | `The resolver needs a decision — answer the prompt` | `question` |
| checks-red | `error` | `Build red on the joined tree — join is a decision now` | `checks-red` |
| joining | `in_flight` | `Joining <dash> into <base> — <current beat>` | `joining` |
| blocked | `error` | the first blocker's own `detail` | `blocked` |
| wire-drop | `idle` | `Connection dropped — the run continues on the server` | `offline` |
| idle | `idle` | `Built — nothing to reconcile` | `built` |

`phase` values are `ToolCallPhase` (`tugdeck/src/lib/code-session-store/tool-call-phase-visual.ts`), and `toolCallPhaseVisual` maps them to the dot's role and motion: `in_flight` → pulsing action, `awaiting` → pulsing caution, `success` → settled success, `error` → settled danger, `idle` → quiet.

#### The two marks, and why they are not one {#the-two-marks}

Both marks live in branch config beside the verdict and the override, so both die with the branch when a join deletes it.

**Table T02: Durable marks this plan adds** {#t02-marks}

| Key | Value | Written by | Compared against | Purpose |
|---|---|---|---|---|
| `branch.tugdash/<n>.tugjoinpilot` | `<base_sha>:<dash_head>` | the dispatched task, before the run, under occupancy | the current head pair | Stops a re-kick on an unchanged pair (Risk R01) |
| `branch.tugdash/<n>.tugjoinprompted` | `clean` \| `red` | the prompt's "Not yet" answer | the freshly computed decision | Stops re-asking a question already declined ([P07]) |

Merging them would break both: keyed on the pair, a dismissal would expire on any base move and re-ask constantly; keyed on the decision, the pilot would never re-run after the base moved.

---

### Specification {#specification}

#### Wire additions {#wire-additions}

**Spec S04: `DashJoinPrompt`** {#s04-prompt-wire}

Rust (`tugrust/crates/tugcast-core/src/types.rs`, beside `DashJoinQuestion`) and TypeScript (`tugdeck/src/lib/changeset-types.ts`, beside `DashJoinQuestionWire`):

```
DashJoinPrompt {
  request_id: String,          // guards the answer against a stale ask
  decision: String,            // "clean" | "red"
  base_sha: String,
  dash_head: String,
  question: String,            // "<dash> is built and reconciled with <base> — join it?"
  options: Vec<DashJoinPromptOption>,   // { label, description }
}
```

Carried as `DashJoinState.prompt`, optional and additive — absent means no ask, which is what every client that has not learned the field reads today.

**Spec S05: `changeset_join_prompt_answer`** {#s05-prompt-answer}

```json
{
  "action": "changeset_join_prompt_answer",
  "project_dir": "<workspace key>",
  "dash": "<display name>",
  "request_id": "<from the prompt>",
  "answer": "join-now|review-first|not-yet"
}
```

Replies `changeset_join_prompt_answer_err { detail }` on a refusal — a stale `request_id`, an unknown dash, or a project that is not open — and nothing on success, because the effect is visible on the feed. `join-now` dispatches the same land the composer's ⬆ would, carrying the dash's standing draft as the message.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Land progress (current beat, per dash) | local-data | `ChangesetJoinStore` + `useSyncExternalStore` | [L02] |
| Register phase / line / word | derived | pure function over props; no store read inside | [L02], [L11] |
| Register dot motion + tone | appearance | `BlockHeader` → `TugProgressIndicator`, `data-phase` + CSS | [L06], [L13] |
| `landRole` / `landConfirm` | local-data | `LandingSnapshot` field, read through the existing landing-mode subscription | [L02] |
| Z5 confirm open/closed | local-data | `useState` in `tug-prompt-entry`, as the existing Replace-message confirm already is | [L22] |
| Prompt sheet presence | local-data | feed fact → card `showSheet` call, dismissed on `isPending` going false | [L02] |
| `⋯` menu open/closed | local-data | `useDashRowMenu`'s `useState`, as `useSessionIdentityMenu` holds its own | [L22] |
| Which `request_id` this card has answered | local-data | `useRef` on the card; never a store, never durable | [L22] |

#### Law cross-check {#law-cross-check}

**Table T03: The laws this plan touches** {#t03-law-crosscheck}

| Law | Where it bears | Honored by |
|---|---|---|
| [L02] External state via `useSyncExternalStore` only | land beats, the prompt fact, `landRole`/`landConfirm`, the register's inputs | Every value reaches the register as a **prop** from the caller's own store read; the derivation ([P04]) imports nothing from `components/` and reads no store itself |
| [L06] Appearance through CSS and DOM | the register's dot tone and motion | `BlockHeader` paints from `data-phase`; no React state drives appearance |
| [L11] Controls emit actions | the prompt sheet, the `⋯` menu | Both emit (`answerPrompt`, the menu's verbs); neither mutates dash state itself |
| [L13] Motion is CSS or TugAnimator | the register's pulsing dot | Owned by `TugProgressIndicator`; the plan adds no `requestAnimationFrame` |
| [L19] The component authoring guide is the contract | `DashJoinRegister`, `dash-row-menu.tsx` | File pair, docstring, props interface, `data-slot`, `@tug-pairings` — Step 6 and Step 12 name it |
| [L20] Token scoping is the ownership boundary | the register framing `BlockHeader` | Register CSS references register-scoped tokens only and never `--tugx-toolheader-*` (Step 6) |
| [L22] Direct store observation for DOM-driving state | the Z5 confirm's open state, the answered-`request_id` ref | Local `useState`/`useRef`, matching the existing Replace-message confirm |
| [L26] Mount identity stable across transitions | the Z5 land button gaining a role and a confirm | The button is **not** swapped — `role` and an anchored popover change on the same node, as `data-mode` already does |
| [L29] Paths through the canonicalization gateway | `changeset_join_land_delta`, `changeset_join_prompt_answer` | `project_dir` is echoed **verbatim** as sent, the rule `changeset_join_resolve_delta` already follows — no new spelling to reconcile |
| [L31] A gesture produces the act or a visible reason | the whole surface | Restated as the stronger claim in [P09]; a refused prompt answer replies `_err` with a detail; a refused `join-now` lands on the register |
| [L23] Internal operations never lose user-visible state | the deleted deadline, the deleted controls | The deadline's *connection-close* arm survives ([P03]); every informational block stays on the shade ([P08]) |

**At risk, and watched:** [L31] is the one this plan could quietly weaken, because it deletes the controls its enforcement table points at. [P09] is the mitigation and Step 8 carries the rewritten invariant test; a round that lands the deletions without the restated table has broken the law while passing the linter.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/join_pilot.rs` | The predicate ([Spec S01]) and the dispatch that runs it |
| `tugdeck/src/lib/dash-join-register.ts` | The pure register derivation ([P04], Table T01) |
| `tugdeck/src/lib/__tests__/dash-join-register.test.ts` | Its table-driven unit test |
| `tugdeck/src/components/tugways/dash-join-register.tsx` | `BlockHeader`-backed register component |
| `tugdeck/src/components/tugways/cards/session-changes/dash-row-menu.tsx` | The `⋯` menu holding Unbind / Discard |
| `tests/app-test/at0445-join-prompt.test.ts` | The prompt arc + the re-ask policy |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `pilot_action` | fn | `tugcast/src/feeds/join_pilot.rs` | Spec S01; pure, unit-tested |
| `PilotAction` | enum | `tugcast/src/feeds/join_pilot.rs` | `Reconcile` \| `CheckTier0` |
| `pilot_mark_key` / `read_pilot_mark` / `write_pilot_mark` | fn | `tugdash-core/src/verify.rs` | Table T02, beside the verdict's own key helpers |
| `prompt_mark_key` / `read_prompt_mark` / `write_prompt_mark` / `clear_prompt_mark` | fn | `tugdash-core/src/verify.rs` | Table T02 |
| `join_in_with_progress` | fn | `tugdash-core/src/ops.rs` | Spec S02; `join_in` delegates (both re-exported at the crate root) |
| `DashJoinPrompt` / `DashJoinPromptOption` | struct | `tugcast-core/src/types.rs` | Spec S04 |
| `DashJoinState.prompt` | field | `tugcast-core/src/types.rs` | Optional, additive |
| `do_changeset_join_prompt_answer` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Spec S05 |
| `do_changeset_join_verify` | fn | `tugcast/src/feeds/agent_supervisor.rs` | **Deleted** ([P02]) |
| `dashJoinRegister` | fn | `tugdeck/src/lib/dash-join-register.ts` | [P04], Table T01 |
| `DashJoinRegister` | component | `tugdeck/src/components/tugways/dash-join-register.tsx` | [P04] |
| `LandingSnapshot.landRole` / `.landConfirm` | field | `tugdeck/src/lib/landing-mode.ts` | [P05] |
| `evaluateJoinGate` | fn | `tugdeck/src/lib/join-mode-controller.ts` | `verification-red` stops refusing ([P05]) |
| `REFUSAL_REACHABILITY` / `refusalReachability` | const / fn | `tugdeck/src/lib/join-mode-controller.ts` | Restated ([P09]) |
| `JOIN_CONTROL` / `JoinFace.control` / `deriveJoinFace` | const / type / fn | `session-changes-dash-join.tsx` | **Deleted** ([P08]) |
| `RESOLVE_IDLE_DEADLINE_MS` / `_armDeadline` / `_clearDeadline` | const / method | `tugdeck/src/lib/changeset-join-store.ts` | **Deleted** ([P03]) |
| `ChangesetJoinStore.landProgress` | method | `tugdeck/src/lib/changeset-join-store.ts` | Beat state per dash ([P03]) |

---

### Documentation Plan {#documentation-plan}

- [ ] New `[D142]` in `tuglaws/design-decisions.md`: the arc doctrine — machine-first, one decision, acts in Z5 or the prompt, status is never a control — amending `[D141]`.
- [ ] `tuglaws/dash-work-doctrine.md`: the "Stop before the join" section gains a sentence saying the machine reconciles at `built` and the user is prompted, so a run's report no longer needs to end in a `/join` chip.
- [ ] `tugdeck/src/components/tugways/blocks/block-header.tsx` docstring: note that the header is also the dash status register's chrome, so its `altitude` contract has a second tenant.
- [ ] Delete `tugdeck/src/spikes/spike-join-arc.tsx` + `.css`, its two `spike-registry.tsx` lines, and restore the count pin in `tugdeck/src/__tests__/card-taxonomy.test.ts` to 12.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `pilot_action`'s ladder; the mark read/write round trips | Every rule in Spec S01 |
| **Unit (TS)** | `dashJoinRegister`'s table; the restated reachability invariant; the gate's red arm | Table T01, [P05], [P09] |
| **App-test** | The arc as the real app runs it: eager reconcile with no gesture, the beat register, the prompt, the danger Z5, the absent controls | Anything only the real DOM + real server can answer |
| **Drift** | A grep assertion that the banished sentences never return | [P03] |

#### What stays out of tests {#test-non-goals}

- **The scribe rung's output quality** — the resolver's own charter and its audit already cover it; this plan changes when it runs, not what it decides.
- **`join_in`'s git semantics** — unchanged by this plan and covered by the existing tugdash-core suite. The beat callback is tested for *firing*, not for what the beats surround.
- **Per-mutator store pins** — banned by the doctrine, and `tsc --noEmit` already catches the interface drift they would chase.
- **Fake-DOM renders of the register** — banned; the component's behavior is its derivation (unit) plus its mounted appearance (app-test).

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The pilot's predicate and its marks | done | `66749ee54` |
| #step-2 | The pilot runs | done | `66749ee54` |
| #step-3 | Tier 1 leaves the join path; pilot integration checkpoint | done | `fa9989a81` |
| #step-4 | The join narrates its beats | done | `cb1138138` |
| #step-5 | The client holds the beats; the deadline dies | done | `551e4f350` |
| #step-6 | The register derivation and its component | done | `b752c4ba4` |
| #step-7 | The register mounts on three surfaces | done | `c4480e1ba` |
| #step-8 | Z5 carries the role and the confirm | done | `b7bbb55b7` |
| #step-9 | The prompt fact and the re-ask policy | in progress | — |
| #step-10 | The prompt sheet and its answer | pending | — |
| #step-11 | The shade is disarmed | pending | — |
| #step-12 | Unbind and Discard move to a row menu | pending | — |
| #step-13 | The pressed arcs — app-tests rewritten | pending | — |
| #step-14 | Documentation sync; the spike is deleted | pending | — |
| #step-15 | Integration checkpoint | pending | — |

---

#### Step 1: The pilot's predicate and its marks {#step-1}

**Commit:** `tugdash(join-arc): the pilot predicate and its durable marks`

**References:** [P01] The pilot, [P07] Re-ask policy, Spec S01, Table T02, Risk R01, (#pilot-flow, #the-two-marks)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/join_pilot.rs` with `PilotAction` and `pilot_action`
- Mark helpers in `tugrust/crates/tugdash-core/src/verify.rs`

**Tasks:**
- [ ] Add `pilot_mark_key(name) -> "branch.tugdash/<name>.tugjoinpilot"` and `prompt_mark_key(name) -> "branch.tugdash/<name>.tugjoinprompted"` in `verify.rs`, beside `verification_config_key` and `override_config_key`, which are the existing spelling convention.
- [ ] Add `read_pilot_mark` / `write_pilot_mark` and `read_prompt_mark` / `write_prompt_mark` / `clear_prompt_mark`, using the crate's `config_get` and the same `git config` write path the verdict uses.
- [ ] Create `join_pilot.rs` with `PilotAction` and `pilot_action(stage, state)` per Spec S01. Keep it pure — no `Path`, no git, no I/O, and **no mark argument**: the mark comparison belongs to the dispatch (Spec S06), for the reason recorded in `#pilot-flow`.
- [ ] Register the module in `tugrust/crates/tugcast/src/feeds/mod.rs`.
- [ ] Document in the module docstring **why** the two marks are keyed differently (Table T02), and why the attempt mark is not read by the predicate — both are the non-obvious parts a later reader will try to "simplify".

**Tests:**
- [ ] Unit test in `join_pilot.rs` covering every rule of Spec S01 in order: not-built → `None`; run present → `None`; blockers → `None`; question or stuck → `None`; no candidate → `Reconcile`; candidate with `tier0: Unrun` → `CheckTier0`; candidate with `tier0: Green` → `None`.
- [ ] Unit test in `verify.rs` for the mark round trips against a temp repo, including "absent reads as `None`" and "a rewritten mark replaces rather than appends".

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core`
- [ ] `cd tugrust && cargo build` (warnings are errors)

---

#### Step 2: The pilot runs {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(join-arc): the machine reconciles a built dash unprompted`

**References:** [P01] The pilot, Spec S01, Spec S06, Risk R01, [Q01] Pilot cost, (#pilot-flow)

**Artifacts:**
- Pilot dispatch, driven off the changeset recompute but running beside it

**Tasks:**
- [ ] In `dash_entries` (`tugrust/crates/tugcast/src/feeds/changeset.rs`), after `join_state_for` produces each dash's state inside the existing `spawn_blocking` hop, call `pilot_action(&detail.stage, &join)` and collect `(owner_key, name, action)` for the dashes that want work. This adds **no** git calls to the recompute — the predicate reads only what is already in hand.
- [ ] Do **not** run the work inside the recompute. Return the wanted actions and dispatch them from the async side with `tokio::spawn`, so the feed frame goes out immediately.
- [ ] Implement the dispatch per Spec S06, in order: acquire occupancy → `rev_parse` base and dash branch → compose the head pair → read the attempt mark and drop if it matches → write the mark → bump, run, bump. The mark work is inside the guard so two racing recomputes produce one run (Risk R01).
- [ ] For `Reconcile`, run the same body `do_changeset_join_resolve` runs — including the `ScribeFileMerger` construction, so the full ladder runs ([P01]) — under `JoinRunKind::Resolve` with the snapshotted `dash_head`. Factor that body out of `do_changeset_join_resolve` into a shared function rather than duplicating it; the CONTROL handler then calls the same thing.
- [ ] For `CheckTier0`, call `run_join_verification(dir, dash, Some("tier0"), bump)` under `JoinRunKind::Verify`.
- [ ] Emit one `tracing::info!` per pilot run naming the dash, the action, the head pair, and whether a scribe rung was available ([Q01]).
- [ ] An occupancy refusal is not an error here — the dash is busy, the next recompute will reconsider. Log at `debug` and move on.

**Tests:**
- [ ] Rust integration test in `tugcast` driving two recomputes over a scratch repo with a built dash: the first dispatches, the second does not (the mark holds).
- [ ] Rust test that a dash with a live occupancy entry produces no dispatch.
- [ ] Rust test that the mark write happens before the run: kill the run mid-flight (or use an action that fails) and assert a following recompute does **not** re-dispatch on the unchanged pair.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo build`

---

#### Step 3: Tier 1 leaves the join path; pilot integration checkpoint {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(join-arc): tier 1 stops running at join time`

**References:** [P02] Tier 1 retired, [P01] The pilot, Risk R02, (#pilot-flow)

**Artifacts:**
- `verificationVerdict` reading `tier0` alone
- `do_changeset_join_verify` and the `changeset_join_verify` action deleted

**Tasks:**
- [ ] In `tugdeck/src/lib/join-mode-controller.ts`, change `verificationVerdict` to read `verification.tier0` only. Update its docstring to say why, citing that the dash's own checkpoints ran the tests and the join-time question is whether the *merged* tree builds.
- [ ] Delete `do_changeset_join_verify`, `send_changeset_join_verify_err`, `parse_changeset_join_verify_payload`, `ChangesetJoinVerifyPayload`, and the `"changeset_join_verify"` dispatch arm from `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`. `run_join_verification` **stays** — the pilot is its caller now.
- [ ] Delete the client's verify sender from `tugdeck/src/lib/changeset-join-store.ts` (or wherever `changeset_join_verify` is sent from) and the `verify` entry on `DashJoinActions`; the `VERIFY` button itself goes in Step 11 (`#step-11`), so leave the button calling a no-op only if `tsc` forces it — prefer deleting the button's branch here if it comes out cleanly.
- [ ] Leave `Verification.tier1` on the struct and the wire ([P02] implications) and add a comment on the field saying nothing gates on it.
- [ ] Verify by hand on a scratch repo that a `built` dash with a moved base reconciles and goes Tier-0-green with no gesture, and record what you observed in the round's summary.

**Tests:**
- [ ] Update `tugdeck/src/lib/__tests__/join-resolve-face.test.ts` cases that construct a `tier1` value to assert it no longer moves the verdict.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src/lib`
- [ ] `just build-app` succeeds (a Rust change; the app bundle must be rebuilt before any app-test)

---

#### Step 4: The join narrates its beats {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(join-arc): the join reports its beats while it runs`

**References:** [P03] The join narrates, Spec S02, Spec S03, (#beat-callback)

**Artifacts:**
- `join_in_with_progress` in tugdash-core
- `changeset_join_land_delta` frames from `do_changeset_join`

**Tasks:**
- [ ] Add `join_in_with_progress(dir, dash, opts, on_beat: impl Fn(&str, &str))` in `tugrust/crates/tugdash-core/src/lib.rs` (or wherever `join_in` is defined) and make `join_in` delegate with `|_, _| {}`. Follow `run_declared`'s callback style in `verify.rs`.
- [ ] Fire the four beats of Spec S02 at their real boundaries. Do not invent beats the code does not have — if the implementation's shape does not have a distinct `record` step, say so in the commit body and collapse the table to what exists rather than faking a boundary.
- [ ] A preview emits nothing (Spec S02).
- [ ] In `do_changeset_join`, call `join_in_with_progress` with a closure that broadcasts Spec S03 frames on `control_tx`, echoing `project_dir` verbatim ([L29]).
- [ ] The frames are a liveness hint: the existing `changeset_all_bump()` on success remains the carrier of truth, unchanged.

**Tests:**
- [ ] Rust unit test that a real join over a scratch repo fires the beats in order and that a preview fires none.
- [ ] Rust test asserting the frame's JSON shape matches Spec S03 exactly (field names and the echoed `project_dir`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast`
- [ ] `cd tugrust && cargo build`

---

#### Step 5: The client holds the beats; the deadline dies {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(join-arc): land beats replace the silence deadline`

**References:** [P03] The join narrates, Spec S03, (#register-table)

**Artifacts:**
- Land progress on `ChangesetJoinStore`
- `RESOLVE_IDLE_DEADLINE_MS` and both banished sentences deleted

**Tasks:**
- [ ] In `tugdeck/src/lib/changeset-join-store.ts`, accept `changeset_join_land_delta` in the action allowlist and hold `{ beat, status }` per `(workspace_key, dash)` cell, keyed exactly as resolve progress is.
- [ ] Delete `RESOLVE_IDLE_DEADLINE_MS`, `_deadlines`, `_armDeadline`, `_clearDeadline` and every call site, and the sentence `"No answer from the resolution ladder in … seconds …"`.
- [ ] **Keep** `_failInFlight` and its connection-close observer — a dropped wire is the one liveness fact the client can see — and rewrite its sentence to `"The connection dropped — the run continues on the server."` (drop the "will appear on this row if it finished" clause, which promised something the client cannot know).
- [ ] Clear a dash's land progress when the dash leaves the aggregate, so a landed dash's beats do not outlive it.
- [ ] Mirror the wire shape in `tugdeck/src/lib/changeset-types.ts` if a type is needed for the frame body.

**Tests:**
- [ ] Extend `tugdeck/src/lib/__tests__/changeset-join-store.test.ts`: a land delta lands on the right cell; a delta for another dash does not; land progress clears when the entry goes.
- [ ] A drift assertion in the same file that the source of `changeset-join-store.ts` contains neither `"resolution ladder in"` nor `"if it finished"`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/lib/__tests__/changeset-join-store.test.ts`

---

#### Step 6: The register derivation and its component {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(join-arc): one status register, on the tool-call header`

**References:** [P04] Status register, Table T01, (#register-table)

**Artifacts:**
- `tugdeck/src/lib/dash-join-register.ts`
- `tugdeck/src/components/tugways/dash-join-register.tsx`

**Tasks:**
- [ ] Write `dashJoinRegister({ entry, join, resolvePhase, landPhase, landBeat, connected })` returning `{ phase: ToolCallPhase, line: string, word: string }` per Table T01. Pure: no store reads, no `Date.now()`, no imports from `components/`.
- [ ] Order the arms so the most urgent state wins: wire-drop, then blocked, then joining, then question, then run-in-flight, then verdict, then idle. State the ordering in the docstring — it is the part that will be re-derived wrongly.
- [ ] Write `DashJoinRegister` mounting `BlockHeader` with `phase`, `target={line}`, `summary={{ kind: "text", text: word }}`, and a `data-slot="dash-join-register"` on its wrapper so app-tests can name it.
- [ ] Pass `altitude` through where the mount is not a transcript leaf.
- [ ] **The register's CSS references only register-scoped tokens** ([L20] — token scoping is the ownership boundary): it may frame and position the header, and must never override, alias, or reference `BlockHeader`'s own `--tugx-toolheader-*` family. The spike framed the header from outside; shipping must not.
- [ ] Name the laws in the commit body: [L02] (every value arrives as a prop from the caller's store read), [L06] (tone paints through the dot's own `data-phase`, never React state), [L19] (the component follows the authoring guide — file pair, docstring, `data-slot`, `@tug-pairings`), [L20] (no reach into the composed header's tokens).

**Tests:**
- [ ] `tugdeck/src/lib/__tests__/dash-join-register.test.ts` — one case per row of Table T01, plus the precedence cases: a wire drop outranks a running resolve; a blocker outranks a green verdict; a live join outranks everything but a wire drop.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/lib/__tests__/dash-join-register.test.ts`

---

#### Step 7: The register mounts on three surfaces {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(join-arc): the register reads the same on shade, Lens and composer`

**References:** [P04] Status register, Table T01, [D141] (the Lens dash row's grammar)

**Artifacts:**
- The register mounted in the Lens Dashes row, the shade's dash row, and the composer's status row

**Tasks:**
- [ ] Mount `DashJoinRegister` in `tugdeck/src/components/lens/sections/dashes-section.tsx`, beneath the existing `DashMetaLine`, keeping the [D141] eyebrow/meta grammar untouched above it.
- [ ] Mount it in `session-changes-dash-lane.tsx`'s collapsed dash row, beneath the shared meta line.
- [ ] Mount it in the composer's `statusRow` while a join landing mode is active, so the register the shade shows is the register the composer shows. The `statusRow` slot on `TugEntryShell` already exists and `tug-prompt-entry.tsx` already computes `hasStatusRow`.
- [ ] Each mount reads its inputs from the store it already subscribes to; the derivation stays pure ([L02]).
- [ ] Name the laws in the commit body.

**Tests:**
- [ ] The cross-surface claim — "the same sentence on three surfaces" — is a DOM fact and is pinned by the app-tests in Step 13 (`#step-13`). But this step must not be *unverifiable until then*: the two shipping app-tests that already `@covers` the surfaces it edits are the checkpoint below, and they fail if a mount breaks the row's structure or height.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test at0407-lens-dashes-section.test.ts at0405-changes-dash-lane.test.ts` — the two files whose `@covers` name `dashes-section.tsx` and `session-changes-dash-lane.tsx`. Run bare; never piped.

---

#### Step 8: Z5 carries the role and the confirm {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck(join-arc): a red verdict makes the join press a decision`

**References:** [P05] Z5 role and confirm, [P09] Reachability restated, (#state-zone-mapping)

**Artifacts:**
- `LandingSnapshot.landRole` / `.landConfirm`
- The land button's role and confirm in `tug-prompt-entry.tsx`
- `evaluateJoinGate`'s red arm retired

**Tasks:**
- [ ] Add `landRole: "action" | "danger"` and `landConfirm: string | null` to `LandingSnapshot` in `tugdeck/src/lib/landing-mode.ts`.
- [ ] `CommitModeController` returns `"action"` / `null` always.
- [ ] `JoinModeController` returns `"danger"` and a sentence naming the failure count — e.g. `"The build is red on the joined tree. Join anyway?"` — when the Tier 0 verdict is red and no standing override covers the candidate; `"action"` / `null` otherwise.
- [ ] In `evaluateJoinGate`, remove the `verification-red` refusal arm: a red no longer refuses, it arms the confirm. Keep `redOverrideStands` and the `redOverride` input — a standing server-side override passes without re-confirming.
- [ ] In `tug-prompt-entry.tsx`, read `landRole` on the land button's `role` and mount a `TugConfirmPopover` anchored on it when `landConfirm !== null`, following the existing Replace-message confirm's shape (`commitConfirmOpen`, `anchorEl` from `rootRef.current?.querySelector`, `side="top"`, `arrow`). The confirm's press runs the land; cancel closes.
- [ ] The confirmed land sends `anyway: true` through the existing `JoinOptions` field.
- [ ] Restate `REFUSAL_REACHABILITY` per [P09]: drop the `"join-face"` variant from `ReachabilityRow.where`, drop the `unverified` and `verification-red` rows if their gate arms are gone, and re-point what remains at `"composer"` or `"time"`.
- [ ] Name the laws in the commit body ([L22] for the confirm's local state, [L26] for the button never being swapped across modes, [L31] for the restated reachability).

**Tests:**
- [ ] `tugdeck/src/lib/__tests__/join-resolve-face.test.ts` — rewrite the reachability invariant to the stronger claim: every `JoinGateReason` has a row, and every row's `where` is `"composer"` or `"time"`.
- [ ] Unit cases: a red verdict yields `landRole: "danger"` and a non-null `landConfirm`; a red with a standing override yields `"action"` / `null`; commit mode always yields `"action"` / `null`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugdeck && bun test src/lib`

---

#### Step 9: The prompt fact and the re-ask policy {#step-9}

**Depends on:** #step-3

**Commit:** `tugdash(join-arc): the pilot raises the decision as a durable prompt`

**References:** [P06] Prompt at built, [P07] Re-ask policy, Spec S04, Spec S05, Table T02, (#the-two-marks)

**Artifacts:**
- `DashJoinPrompt` on the wire, raised and cleared server-side
- `changeset_join_prompt_answer` handler

**Tasks:**
- [ ] Add `DashJoinPrompt` / `DashJoinPromptOption` to `tugrust/crates/tugcast-core/src/types.rs` beside `DashJoinQuestion`, and `prompt: Option<DashJoinPrompt>` on `DashJoinState` — additive and `skip_serializing_if = "Option::is_none"`, matching the block's existing convention.
- [ ] In `join_board.rs`, derive the prompt in `join_state_for`: present when `stage == "built"`, a candidate stands (or the merge is clean with no conflicts), Tier 0 has a verdict, there is no run, no blockers, no question and no stuck line — and the freshly computed `decision` (`clean` when Tier 0 is green, `red` when red) **differs** from the `tugjoinprompted` mark ([P07]). `request_id` is derived deterministically from `<dash>:<base_sha>:<dash_head>:<decision>` so it is stable across recomputes and a stale answer cannot resolve a fresh ask.
- [ ] Compose the question and the three options (Spec S04) server-side, so the durable row and the rendered one are the same bytes — the same reason the landing receipt is server-formatted.
- [ ] Add `parse_changeset_join_prompt_answer_payload` and `do_changeset_join_prompt_answer` in `agent_supervisor.rs`, dispatched from the `handle_control` match. `not-yet` writes the prompt mark and bumps; `review-first` clears the mark and bumps (the client enters join mode off the cleared fact); `join-now` clears the mark and dispatches the same land `do_changeset_join` performs, with the dash's standing draft as the message.
- [ ] A stale `request_id`, an unknown dash, or a project that is not open replies `changeset_join_prompt_answer_err { detail }` — never a silent no-op ([L31]).
- [ ] **`join-now` writes no prompt mark, on either arm.** A land that is refused (a blocker arrived, occupancy took the dash, the candidate went stale) must leave the ask unconsumed so the next decision re-raises it ([P06] implications); the refusal itself travels the existing `changeset_join_err` path and lands on the register.
- [ ] Mirror `DashJoinPrompt` in `tugdeck/src/lib/changeset-types.ts` as `DashJoinPromptWire`, and in whatever TS fixture mirrors the wire shape.

**Tests:**
- [ ] Rust unit tests over the derivation: a green Tier 0 with no mark raises `clean`; the same state with a `clean` mark raises nothing; a red verdict against a `clean` mark raises `red`; a run in flight raises nothing.
- [ ] Rust test that `request_id` is stable across two derivations of the same state and differs when the decision changes.
- [ ] Rust test that an answer carrying a stale `request_id` is refused with a detail.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcast-core -p tugdash-core`
- [ ] `cd tugrust && cargo build`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 10: The prompt sheet and its answer {#step-10}

**Depends on:** #step-9, #step-8

**Commit:** `tugdeck(join-arc): the decision arrives as a sheet, once`

**References:** [P06] Prompt at built, [P07] Re-ask policy, Spec S04, Spec S05

**Artifacts:**
- A card-hosted prompt sheet driven by the feed fact
- The answer sender on `ChangesetJoinStore`

**Tasks:**
- [ ] Add `answerPrompt(workspaceKey, dash, requestId, answer)` to `ChangesetJoinStore`, sending Spec S05, and accept `changeset_join_prompt_answer_err` into the store's existing stated-refusal path (the same `_note` treatment `changeset_join_override_err` gets).
- [ ] In `session-card.tsx`, subscribe to the bound dash's `join.prompt` and raise the sheet via the card's `showSheet` seam when a prompt appears whose `request_id` this card has not already answered. Follow `useRewindSheet`'s shape in `rewind-sheet.tsx`: a `use…Sheet` hook returning an opener, with the body a component that owns its own interaction.
- [ ] The sheet body mounts `QuestionWizard` with the fact's question and options, `isPending` driven by the fact still being present, `onSubmit` mapping the chosen label to `join-now` / `review-first` / `not-yet`, `onCancel` answering `not-yet` (⎋ is a dismissal, not a silent close), and `onDecline` also answering `not-yet` while leaving the user's prose in the composer.
- [ ] **Only a card bound to that dash raises it** ([P06]). An unbound dash raises nothing; the Lens row and `/join` remain its paths.
- [ ] **Yield to a landing already in progress** ([P06] implications): when this card's composer is in commit or join mode, hold the sheet and raise it when the mode exits. A running turn is *not* a reason to hold. Read the landing mode's `active` through its existing subscription ([L02]) rather than adding a new signal.
- [ ] Track answered `request_id`s per card so a fact that lingers for one recompute after an answer does not re-raise the sheet.
- [ ] `review-first` enters join mode on this card after the sheet closes, through the existing landing-mode entry the `/dash-join` command uses.
- [ ] Close the sheet when the fact clears, so another card's answer dismisses this one.
- [ ] Name the laws in the commit body ([L02] the fact arrives through the store subscription; [L11] the sheet emits an action rather than mutating).

**Tests:**
- [ ] Extend `changeset-join-store.test.ts` for `answerPrompt`'s frame shape and for the `_err` note path.
- [ ] The sheet's arrival, its three answers, and the re-ask policy are DOM facts — pinned by at0445 in Step 13 (`#step-13`).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugdeck && bun test`

---

#### Step 11: The shade is disarmed {#step-11}

**Depends on:** #step-10

**Commit:** `tugdeck(join-arc): the dash row states, and no longer asks`

**References:** [P08] Shade disarmed, [P09] Reachability restated, Risk R02

**Artifacts:**
- `session-changes-dash-join.tsx` with no join controls
- `JOIN_CONTROL`, `JoinFace.control` and `deriveJoinFace` deleted

**Tasks:**
- [ ] Delete the `RESOLVE` / `RESOLVE AGAIN`, `VERIFY`, `JOIN ANYWAY` and `Resume teardown` buttons from `session-changes-dash-join.tsx`, along with `JOIN_CONTROL`, `JoinFace.control`, and `deriveJoinFace`'s control ladder. What the face still says about the join comes from `DashJoinRegister` ([P04]).
- [ ] Remove `resolve`, `verify`, `overrideRed` and `resumeTeardown` from `DashJoinActions` and their wiring in `session-card.tsx`. `answerQuestion` and `answerPrompt` stay.
- [ ] **Keep** every informational block: the blockers list with each blocker's act sentence, the conflicted paths, the resolver's report, the verification failures and notes, the stale note, and the escalation `QuestionWizard`. The shade is still where detail lives.
- [ ] Keep `deriveResolveFace` only if something still reads it; if the register subsumes it, delete it and its tests rather than leaving a dead export.
- [ ] Re-check `REFUSAL_REACHABILITY` after the deletions: every remaining `JoinGateReason` must still have a row, and every row must point at `"composer"` or `"time"` ([P09]).
- [ ] Name the laws in the commit body.

**Tests:**
- [ ] Update `join-resolve-face.test.ts` for the deleted exports; do not leave tests asserting a shape that no longer exists.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugdeck && bun test src/lib`

---

#### Step 12: Unbind and Discard move to a row menu {#step-12}

**Depends on:** #step-11, #step-3

**Commit:** `tugdeck(join-arc): the rare dash verbs move into a row menu`

**References:** [P08] Shade disarmed, Risk R02

**Artifacts:**
- `dash-row-menu.tsx` holding Unbind and Discard

**Tasks:**
- [ ] Create `dash-row-menu.tsx` as a `useDashRowMenu({ … })` hook returning `{ menu, openMenu }`, composing `TugEditorContextMenu` with `TugEditorContextMenuEntry` items for Unbind and Discard. That is the shipped in-card menu precedent — `tugdeck/src/components/tugways/session-identity-menu.tsx` (`useSessionIdentityMenu`) is the model to follow. **Do not reach for `internal/tug-popup-menu.tsx`**: it is internal machinery and no card composes it directly ([L19] — the authoring guide's composition contract; [L20] — the menu's own tokens stay the menu's).
- [ ] Mount the opener from a `subtype="icon"` `TugPushButton` on the dash row's trailing edge in `session-changes-dash-lane.tsx`.
- [ ] Discard keeps its existing confirm and its preflight sentence (`discardPreflightLine`), which names what the discard destroys and where the worktree's uncommitted files go.
- [ ] A disabled verb keeps its reason on screen — a disabled menu item takes no pointer events, so the reason rides the item's own label or a sibling line, never a `title` ([L31]).
- [ ] Delete the standing `UNBIND` and `DISCARD` buttons from wherever they render today on the row.
- [ ] Name the laws in the commit body.

**Tests:**
- [ ] The menu's presence and its two items are DOM facts — pinned by at0405's update in Step 13 (`#step-13`).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugdeck && bun test`

---

#### Step 13: The pressed arcs — app-tests rewritten {#step-13}

**Depends on:** #step-12

**Commit:** `tugtest(join-arc): the arc, pressed end to end`

**References:** [P01] The pilot, [P03] The join narrates, [P05] Z5 role and confirm, [P06] Prompt at built, [P07] Re-ask policy, [P08] Shade disarmed, (#success-criteria)

**Artifacts:**
- `at0441` rewritten to the new arc
- `at0443` rewritten to the danger Z5
- `at0445` new, covering the prompt and the re-ask policy
- `at0405`, `at0435`, `at0444` updated

**Tasks:**
- [ ] Rewrite `tests/app-test/at0441-join-arc-end-to-end.test.ts` to the new arc on a scratch repo: create a dash, land a round, move the base so the merge conflicts, `tugutil dash mark <name> built`, then **assert with no gesture at all** that the feed reaches a candidate and a green Tier 0; reload the deck and assert it holds; assert the shade mounts none of the four deleted control slots; enter join mode; press ⬆; assert at least one land-beat register appears before the row leaves.
- [ ] Rewrite `at0443-join-verification-red.test.ts` against a scratch project whose `verify_tier0` command exits non-zero: assert the register reads red, the composer's land button carries `role="danger"` (its rendered class or `data-*`, whichever the button exposes), that pressing it opens the confirm rather than landing, and that confirming lands.
- [ ] Add `at0445-join-prompt.test.ts`: a built, reconciled, green dash bound to a session raises the prompt sheet; "Not yet" dismisses it; a base move that reconciles to the same decision raises **no** second prompt; a change that makes Tier 0 red raises a new one. Also assert an **unbound** dash raises nothing.
- [ ] Update `at0405-changes-dash-lane.test.ts` for the `⋯` menu and the register.
- [ ] Update `at0435-join-refusal-speaks.test.ts` for the restated reachability — every refusal it drives must still be a sentence on screen naming the composer or a wait.
- [ ] **Rewrite** `at0444-join-slow-resolver.test.ts` rather than patching it. Its arc today is *conflicted → press Resolve → fifteen seconds of silence → no error, no control*, and both ends of that change: there is no Resolve to press, and the run is started by the pilot. The rewritten claim is the same defect at the new layer — a resolver held still for fifteen seconds, past the old twelve-second bound, with the run started **by the pilot and by nothing else**, leaves the register on its running pose and never fabricates a failure. Keep the file's docstring history of *why* the deadline was wrong; it is the reason the test exists.
- [ ] Every new or moved test carries `@covers` lines naming the real sources it exercises, including the new Rust files.
- [ ] Every dash fixture uses `dash-fixture.ts`'s scratch repository — never the developer's checkout.

**Tests:**
- [ ] The step's artifacts are the tests.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just build-app` (Rust changed earlier in this plan; the bundle must be current)
- [ ] `just app-test at0441-join-arc-end-to-end.test.ts at0443-join-verification-red.test.ts at0445-join-prompt.test.ts`
- [ ] `just app-test at0405-changes-dash-lane.test.ts at0435-join-refusal-speaks.test.ts at0444-join-slow-resolver.test.ts`
- [ ] Run each bare — never piped into a filter.

---

#### Step 14: Documentation sync; the spike is deleted {#step-14}

**Depends on:** #step-13

**Commit:** `tugdocs(join-arc): the arc doctrine, and the spike retires`

**References:** [P01]–[P09], (#documentation-plan)

**Artifacts:**
- `[D142]` in `tuglaws/design-decisions.md`
- The spike deleted and the taxonomy pin restored

**Tasks:**
- [ ] Write `[D142]`: the arc doctrine — machine-first, one decision, acts in Z5 or the prompt, status is never a control, the register is the tool-call header — amending `[D141]`, and record what it retires (the four controls, Tier 1 at join time, the silence deadline).
- [ ] Update `tuglaws/dash-work-doctrine.md`'s "Stop before the join" so it reflects that the machine reconciles at `built` and the prompt is what asks.
- [ ] Note the second tenant on `BlockHeader`'s `altitude` contract in its docstring.
- [ ] Delete `tugdeck/src/spikes/spike-join-arc.tsx` and `.css`, remove its two lines from `spike-registry.tsx`, and restore the count in `tugdeck/src/__tests__/card-taxonomy.test.ts` to 12 with the heading text corrected.
- [ ] Use `Edit`/`Write` or `tugutil file edit` for every documentation change — never a shell heredoc, which lands unattributed.

**Tests:**
- [ ] `bun test src/__tests__/card-taxonomy.test.ts` passes with the restored pin.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/__tests__/card-taxonomy.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 15: Integration checkpoint {#step-15}

**Depends on:** #step-14

**Commit:** N/A (verification only)

**References:** (#success-criteria, #risks)

**Artifacts:**
- A verified build, and the observations that back each success criterion

**Tasks:**
- [ ] Walk every line of [Success Criteria](#success-criteria) and record for each what you ran and what you observed. A criterion nobody checked is a criterion that did not ship.
- [ ] Confirm on a scratch repo that a conflicted `built` dash reconciles with no gesture, that the prompt arrives once, and that a dismissal followed by a same-decision base move stays silent.
- [ ] Confirm the pilot's `tracing::info!` lines are legible enough to answer [Q01] later.
- [ ] `just app-debug` from the worktree; report the instance id and the `just launch-debug` / `just logs-debug` / `just stop-debug` commands.
- [ ] `tugutil dash mark <name> built`, then write the join draft with `tugutil draft set --owner dash:<name> --message "…"` — subject bare, no scope prefix.
- [ ] Stop. The join is the user's gesture.

**Tests:**
- [ ] No new tests; this step verifies the ones that exist.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-changed`
- [ ] `just app-debug` brings up a live instance

---

### Deliverables {#deliverables}

- A join pilot that reconciles and Tier-0-checks a `built` dash unprompted, once per head pair, with a durable attempt mark and a legible log line.
- Tier 1 removed from every join-time path.
- A join that narrates its beats from `join_in` through the wire to a register on the composer.
- The client's silence deadline and both word-salad sentences deleted, with a drift assertion keeping them gone.
- One status-register derivation and component, on the transcript's own Quiet Line chrome, mounted on the Lens Dashes row, the Changes shade's dash row, and the composer's status row.
- A Z5 land control that carries the act's role and its confirm, so a red verdict is a decision rather than a refusal.
- A durable prompt at `built`, rendered as a card-hosted modal sheet on the bound session's card, with a re-ask policy that only speaks when the decision changes.
- A Changes shade that states and never asks, with Unbind and Discard in a row menu.
- `[D142]`, the doctrine sync, and the deleted spike.
