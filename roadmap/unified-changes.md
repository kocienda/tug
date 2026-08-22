# Unified Changes — the shade is the join surface

## The shade replaces the inline join prompt {#shade-join-surface}

**Purpose:** Delete the inline join prompt and make the Changes shade the arc's one decision surface. Join-readiness reveals the shade in a quiet moment, the fronted dash row shows the message a join would land with and where those words came from, and the prompt's whole apparatus — the wire fact's question and options, the answer control frame, the dismissal mark and its re-ask policy, the inline component and its answered-id memory — is deleted as no-longer-consumed. The join act itself does not move: the composer's join mode and the Z5 ⬆ land it, and only the user presses.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, fable.** Reviewed `plan:2daf08f7633108a8`. Reviewed same-turn by the authoring session per the devise skill's review clause (the session model outranks the review model the clause names; handing off would re-run the identical model). Lint: 0 errors, 1 warning (the stamp, resolved below). Oriented on: the whole document (first review), read against `join_board.rs`, `join_pilot.rs`, `agent_supervisor.rs`, `verify.rs`, `tugcast-core/src/types.rs`, `join-prompt-inline.tsx`, `session-card.tsx`, `shade-view-controller.ts`, `changeset-join-store.ts`, `changeset-types.ts`, `session-changes-dash-lane.tsx`, `tug-prompt-entry.tsx`, and `at0445-join-prompt.test.ts`. Applied: the Step Status Ledger's rows rewritten to the linter's bare-anchor form (PL015); a mangled join-voice sha in Dependencies corrected to `e289fe517`; [S01]'s shade-hidden predicate corrected from a guessed `null` to the controller's real vocabulary (`ShadeView` is `"none" | "changes" | "history"`, so the read is `=== "none"`). Verified rather than assumed: the four brief items landed in `2ddcace0a` and are pinned (`integrate_message_strips_a_foreign_scope`, the invariant-group comment in `tug-prompt-entry.tsx`), so Non-goals' first entry is fact, not hope; `dash-join`'s SKILL.md already instructs the bare subject, closing the invocation's one open check on item 4; `useChangesetJoinLand` is read by both the dying `JoinLandingBody` and the surviving composer register, which is why [T01] splits the store rather than deleting it; the `QuestionWizard` inside `session-changes-dash-join.tsx` is the resolver's escalation ask, not the join offer, and stays; and the pilot's `tugjoinpilot` mark is keyed on the head pair for reasons the join_pilot docstring states, so [P04] deletes only the head-keyed dismissal mark. Deferred: nothing — the three design forks (reveal timing, reveal depth, held signal) were asked and settled during devise; they land as [P02], [P03], [P05].

---

### Phase Overview {#phase-overview}

#### Context {#context}

The unified Changes pass this plan is named for **already landed**. On 2026-08-16, `2ddcace0a` (*"Make Changes one room and one landing"*, plan archived at `roadmap/archive/unified-changes-plan.md`) delivered the four items the closure brief settled: the Z4A group is invariant `Prompt | Changes` (`tug-prompt-entry.tsx` line ~3598 states it: "The group is INVARIANT: two segments on every card"), the collapsed Dashes fold is gone and non-fronted dashes render as compact rows, release reaches every dash `bound_sessions` licenses through a fact-sheet `TugConfirmPopover`, and `strip_dash_scope` (`tugrust/crates/tugdash-core/src/ops.rs`) strips **any** leading `tugdash(…): ` on every landing route — pinned by `integrate_message_strips_a_foreign_scope` — while all three draft-authoring skills (`dash-implement`, `dash-on`, `dash-join`) instruct bare subjects.

What happened after is the reason this plan exists. The join-prompt campaign disarmed the shade's join face — [D142]: "no gesture here that joins… the composer's ⬆ is the only control that fires one" — and put the arc's one decision in a prompt: first a card-hosted sheet, then ([D150], `roadmap/join-voice.md`, landed `e289fe517`) an inline surface at the transcript's live edge, `join-prompt-inline.tsx`. On 2026-08-21, live use found the structural defect: a reflex Escape answered "Not yet", the dismissal mark (`branch.tugdash/<name>.tugjoinprompted`, keyed on the dash head) suppressed every re-ask, and recovery took a hand-run `git config --unset-all`. A transient dialog has no reopen gesture by construction. A standing surface does: close the shade and nothing is lost, because the dash row is still there.

Decided 2026-08-22: the shade is the decision surface. The prompt was only ever one way to satisfy [D147]'s real requirement — the offer is *summoned, not discovered* — and a shade that reveals itself satisfies it without the modal's failure mode or its bookkeeping.

#### Strategy {#strategy}

Reshape before deleting, then delete whole subsystems rather than hollowing them. The wire fact survives in reduced form ([P01]) because two consumers still need its facts — the reveal needs a stable identity to fire once per, and the fold needs the would-land message with provenance — but the question, the options, the answer round-trip, and the durable dismissal all exist only to serve a dialog, and they go in one pass each: server fact first (Rust is the layer the mirrors are pinned against), then the answer path, then the client surface, then the two small additions (dot, lands-as), then the app-test, then doctrine.

#### Success Criteria (Measurable) {#success-criteria}

- `join-prompt-inline.tsx`, `join-prompt-inline.css`, and their unit test no longer exist; `rg "join-prompt-inline|JoinPromptInline|useJoinPrompt" tugdeck/src` returns nothing.
- `rg "tugjoinprompted|prompt_mark|changeset_join_prompt_answer" tugrust tugdeck` returns nothing (the pilot's `tugjoinpilot` and `tugjoinsource` marks remain untouched).
- With a bound dash reaching `join_ready` and a standing candidate, the Changes shade reveals itself on the bound card in the first quiet moment ([S01]) and the fronted row's fold shows the would-land subject with its provenance note — pinned by the rewritten at0445.
- Closing the revealed shade does not re-reveal it for the same `request_id`; a new round (new dash head) reveals again — pinned by at0445.
- While an offer stands and the shade is hidden, the Z4A Changes segment carries the accent dot; the dot is gone after the join lands — pinned by at0445.
- `cd tugrust && cargo nextest run` green; `cd tugdeck && bunx tsc --noEmit && bunx vite build` clean; `bun test` green; `just app-test-changed` green.

#### Scope {#scope}

- `tugcast-core` wire types, `join_board.rs`, `join_pilot.rs` (docstring only), `agent_supervisor.rs`, `tugdash-core/src/verify.rs`.
- `tugdeck`: the prompt component's deletion, `session-card.tsx`'s reveal effect, `tug-prompt-entry.tsx`'s segment dot, `session-changes-dash-lane.tsx`'s lands-as section, `changeset-join-store.ts`, `changeset-types.ts`.
- `tests/app-test/at0445-join-prompt.test.ts` (renamed to match its new subject).
- `tuglaws/design-decisions.md`, `tuglaws/dash-work-doctrine.md`, and the tugplug skills' ending narration ("the join prompt will raise momentarily" is now a sentence about a surface that does not exist).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **The four landed items.** Z4A invariance, the fold's death, guarded release, and scope hygiene shipped in `2ddcace0a` and are pinned by their own tests. This plan re-verifies them only through the integration checkpoint's ordinary sweeps; it does not rebuild or redesign them.
- **The join act and its gate.** Composer join mode, Z5 ⬆, `evaluateJoinLandGate`, `changeset_join` — untouched. [D149] stands whole: verification stays out of the join; nothing here re-proposes a join-time check.
- **The pilot.** `pilot_action`, the occupancy guard, and the `tugjoinpilot` attempt mark are the machine's reconcile arc and keep working unchanged. Only the module docstring's paragraph contrasting the two marks needs rewording when the second mark dies.
- **The resolver question.** `standing_question`, `changeset_join_question_answer`, and the `QuestionWizard` mount inside `session-changes-dash-join.tsx` are the *escalation* ask, not the join offer. They stay.
- **The Lens Dashes roster and entry-point affordances** — the next plan's subject.

#### Dependencies / Prerequisites {#dependencies}

`roadmap/join-voice.md` landed (`e289fe517`) and `roadmap/dash-generality.md` landed (`a18557090`); both verified present on `main` at authoring time, along with `2ddcace0a` from 2026-08-16.

#### Constraints {#constraints}

- `-D warnings` across the Rust workspace; every intermediate commit builds clean.
- Wire-type changes must move both mirrors together: `tugcast-core/src/types.rs` and `tugdeck/src/lib/changeset-types.ts`, plus `tugrust/crates/tugcast/tests/stream_json_catalog_drift.rs` where the frame catalog is pinned.
- tugplug skills execute from the app bundle, not the repo — prose edits there are inert until rebuild; the checkpoint that reads them reads the repo copies, and the bundle refresh rides the user's next build.
- App-tests follow the scratch-repo dash discipline: dash fixtures never target the developer's checkout.

#### Assumptions {#assumptions}

- `DashDetail.join_ready` and `landing_message_preview` keep their current semantics; this plan consumes them, never redefines them.
- `ShadeViewController.show("changes")` with no landing mode active is the "bare glance" presentation and hides without side effects — the behavior `handleChangesSheetOpenChange` and `dismissChangesShade` in `session-card.tsx` already implement.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The three design forks — reveal timing, reveal depth, and the held signal — were raised with the owner during devise and settled as [P02], [P03], and [P05].

---

### Risks and Mitigations {#risks}

- **[R01] The reveal races the run's ending narration.** A dash-implement run typically closes its final step mid-turn; the offer stands before the turn ends, and a reveal at that instant would cover the report the user is about to read. Mitigation: [S01]'s quiet-moment gate holds the reveal until the turn settles, so the ordinary sequence is *report finishes → shade reveals* — the same beat the old prompt aimed for, minus the modal.
- **[R02] Deleting the durable dismissal makes the reveal a per-load event.** A reload while an offer stands re-reveals once. Accepted deliberately ([P04]): the cost of one shade glance per reload is far below the cost of the durable mark's failure mode (the 2026-08-21 lockout), and the shade is dismissible for free.
- **[R03] A missed consumer of the deleted store surface.** `ChangesetJoinStore` serves both the dying prompt and the surviving composer register from adjacent methods. Mitigation: [T01] is the audited split, and Step 3's checkpoint greps for every deleted symbol.
- **[R04] The dot goes stale.** A signal keyed on a remembered fact could outlive the dash. Mitigation: [S02] derives the dot on every render from the live feed fact that disappears when the dash lands or unbinds; it holds no state of its own.

---

### Design Decisions {#design-decisions}

#### [P01] The offer fact replaces the prompt fact (DECIDED) {#p01-offer-fact}

**Decision:** `DashJoinState.prompt: Option<DashJoinPrompt>` becomes `offer: Option<DashJoinOffer>` — fields `request_id`, `base_sha`, `dash_head`, `message`, `message_source`, derived by the same gate chain `standing_prompt` runs today (join-ready, candidate standing, no run, no question, no stuck line) **minus the dismissal-mark comparison**. `question`, `options`, and `DashJoinPromptOption` are deleted: an offer is a fact to render, not an ask to answer.

**Rationale:** The reveal needs a stable identity (`request_id` — same `{name}:{base_sha}:{dash_head}` composition, stable across recomputes, distinct the moment either head moves) and the fold needs the would-land message with provenance ([P06]). Everything else on the old fact existed to feed `QuestionWizard`. Keeping the derivation server-side keeps the [D147] posture: the server derives, the client renders.

#### [P02] The reveal fires in quiet moments only (DECIDED — owner-settled 2026-08-22) {#p02-quiet-moments}

**Decision:** The shade auto-reveals only when no turn is running, no landing mode is active, and the composer holds no typed text — [S01] is the predicate. Until a quiet moment arrives, the Z4A Changes segment's accent dot ([P05]) is the standing signal.

**Rationale:** The shade is a view swap — `data-view="changes"` replaces the transcript pane — so a mid-turn reveal covers streaming output. This is stricter than the old dialog's rule ("a running turn is not a reason to hold", [D142]) because the surface is heavier: an inline row pushed content; the shade replaces it. In practice the run that armed the dash ends its turn moments later, so the reveal lands right after the ending narration — the beat the user is already looking at.

#### [P03] The reveal is a passive glance (DECIDED — owner-settled 2026-08-22) {#p03-passive-glance}

**Decision:** The reveal calls `shadeViewController.show("changes")` and nothing else — no mode entry, no composer takeover. The composer stays a prompt; entering the landing mode (Z4A Changes segment, ⌃⌘C, `/dash-join`) remains the user's gesture, and Z5's ⬆ remains the only control that lands.

**Rationale:** Entering join mode would commandeer the composer uninvited — the interruption the prompt was criticized for, rebuilt in a new shape. The passive glance is exactly the existing "bare glance" presentation the shade already has, with its existing self-hide and ✕ behavior; the reveal adds a trigger, not a state.

#### [P04] Reveal-once is per-mount memory, never a durable mark (DECIDED) {#p04-per-mount-memory}

**Decision:** The card remembers revealed `request_id`s in a mount-local ref. Closing the shade never re-reveals for the same id; a new round or base move mints a new id and reveals again; a reload forgets and reveals once more. `tugjoinprompted`, `read_prompt_mark`/`write_prompt_mark`/`clear_prompt_mark` in `tugdash-core/src/verify.rs`, the mark-comparison gate in `standing_prompt`, and the `answeredRef` set in the prompt hook are all deleted.

**Rationale:** The durable mark existed because a *modal* re-raising every recompute is unbearable and a dismissal had to outlive the process. A standing surface inverts the economics: the worst case of forgetting is one extra glance, and the worst case of remembering was the 2026-08-21 lockout. The unchecked-registry rule applies: when nothing raises a prompt, nothing should durably record that one was dismissed. The pilot's `tugjoinpilot` mark is untouched — it bounds the *machine's* re-runs, a different job with a different key, as `join_pilot.rs`'s docstring explains; that docstring's two-marks paragraph is rewritten to describe the one that remains.

#### [P05] The held signal is an accent dot on the Changes segment (DECIDED — owner-settled 2026-08-22) {#p05-accent-dot}

**Decision:** While an offer stands and the shade is hidden, the Z4A Changes segment wears a small accent dot — the unread idiom. It renders from live facts on every paint ([S02]), never from remembered state, and paints through a data attribute and CSS ([L06]). No label swap (the invariant group stays invariant in shape and in words) and no pulse (the pulsing dot is the registers' "running" vocabulary; nothing is running).

#### [P06] The fold shows lands-as with provenance (DECIDED) {#p06-lands-as}

**Decision:** The fronted row's fold gains the would-land view: when the entry carries an offer, the fold's `draft` section becomes **lands as** — the offer's composed subject (`tugdash(<name>): …`) plus a provenance note keyed on `message_source` (`draft` → silent; `description` → "from the branch description — no draft was written"; `fallback` → "no draft and no description — the generic stand-in"). With no offer standing, the section keeps its current shape: the raw draft under the `draft` eyebrow, when one exists.

**Rationale:** This is the one place the landing-message precedence breaks its silence ([D150] called it "a live view"), and the user is still agreeing to those words at Z5 — the preview must live where the decision lives. Rendering the *composed* subject rather than the raw draft shows the exact bytes `integrate_message` will land, scope and all, from the same `landing_message_preview` composition — the two cannot drift because they are one function.

#### [P07] The answer path dies whole (DECIDED) {#p07-answer-path-dies}

**Decision:** The `changeset_join_prompt_answer` CONTROL frame is deleted end to end: `parse_changeset_join_prompt_answer_payload`, `do_changeset_join_prompt_answer`, the dispatch arm in `agent_supervisor.rs`, the store's `answerJoinPrompt` sender and the `changeset_join_prompt_answer_err` action handling in `changeset-join-store.ts`, and the frame's entry in the drift catalog. Its three arms are already covered elsewhere: *Join now* is the composer ⬆'s own `changeset_join` (the handler's comment says it: "The same land the composer's ⬆ performs, down to the handler"); *Review first* is entering the landing mode; *Not yet* is closing the shade, which now costs nothing.

#### [P08] The landing narrates where it already narrates (DECIDED) {#p08-landing-narration}

**Decision:** `JoinLandingBody` dies with the prompt. The join's beats keep their existing homes: the `DashJoinRegister` mounted in the shade's dash lane and on the composer's status row (both read `ChangesetJoinStore`, which stays for them), and the transcript's `/dash-join` receipt row as the terminal record ([D111]). A failed join keeps the register's failure standing — the behavior [D150] already settled. No new surface is built.

#### [P09] Doctrine: the new decision amends [D150] and [D142] (DECIDED) {#p09-doctrine}

**Decision:** The doc-sync step records a global `[D##]` (next free number at landing time): the shade is the join arc's decision surface; the offer is summoned by revealing a standing surface rather than by mounting a transient one; the reveal is quiet-moment-gated, passive, and per-mount; and the dismissal machinery is deleted because a standing surface needs no re-ask policy. It amends [D150] (whose inline mount it deletes — the "speaks inline" half is superseded; the "one place, stops speaking when done" half is inherited by the shade) and [D142] (whose "prompt that summoned itself" is now the shade reveal). [D147] and [D149] are cited unchanged.

---

### Deep Dives {#deep-dives}

#### The prompt machinery, inventoried {#prompt-inventory}

Server: `DashJoinPrompt` + `DashJoinPromptOption` (`tugrust/crates/tugcast-core/src/types.rs` ~673–716); `standing_prompt`, `prompt_options`, and the mark gate (`tugcast/src/feeds/join_board.rs` ~252–340) with the test block "The join prompt (Spec S04, [P06], [P07])" (~867 on); the mark helpers (`tugdash-core/src/verify.rs` 107–135) and their tests; the answer handler (`agent_supervisor.rs` ~2038–2100 parser, ~3062 dispatch, ~5661–5785 handler); `join_pilot.rs`'s docstring paragraph "Why the two marks are keyed differently".

Client: `join-prompt-inline.tsx` (the component, `useJoinPrompt`, `JoinLandingBody`, `joinPromptAsParsed`, `joinPromptMessage`, `answerForLabel`) + `join-prompt-inline.css` + `__tests__/join-prompt-inline.test.ts`; `session-card.tsx` line ~77 import, ~3476 `useJoinPrompt` call, ~5004 `liveEdgeContent={joinPromptElement}`; `changeset-join-store.ts` answer sender (~466) and `changeset_join_prompt_answer_err` handling (~231, ~287, ~456); `changeset-types.ts` `DashJoinPromptWire` + option wire (~321–350). App-test: `tests/app-test/at0445-join-prompt.test.ts`.

#### What "quiet" reads, and where {#quiet-inputs}

The three gate inputs already exist as readable state on the card: turn-running is `codeSessionStore.getSnapshot().canInterrupt === true` (the read `commit-mode-controller.ts` line ~192 uses for the same purpose); landing-active is the card's `anyLandingActive` (`commitModeActive || joinActive`, `session-card.tsx` ~2754); composer text is the prompt entry's `isEmpty()` (the delegate surface `tug-prompt-entry.tsx` ~1088 declares and ~3516 implements). The reveal effect subscribes to the same stores the card already subscribes to for these — no new store, no polling. A held reveal fires when the *next* recompute or store change finds the gate open; the effect re-runs on its inputs, so no timer is involved.

---

### Specification {#specification}

#### [S01] The reveal predicate {#s01-reveal-predicate}

Reveal ⇔ all of: (a) the bound dash's feed entry carries `offer` with a `request_id` not in the mount's revealed-set; (b) `canInterrupt !== true` (no running turn); (c) `anyLandingActive === false`; (d) the composer's `isEmpty()` is true; (e) the shade is not already showing (`shadeViewController.getSnapshot() === "none"` — the controller's `ShadeView` vocabulary is `"none" | "changes" | "history"`). Action: add the id to the revealed-set, then `shadeViewController.show("changes")`. The revealed-set is a mount-local `useRef<Set<string>>` ([P04]).

#### [S02] The dot predicate {#s02-dot-predicate}

Dot ⇔ the bound dash's feed entry carries `offer` **and** the shade is hidden. Derived on every render from those two live reads; when the join lands, the dash's feed entry disappears (`broadcast_dash_gone`) and the dot goes with it; when the user opens the shade — by reveal or by hand — the dot rests while it is open and returns only if the shade closes with the offer still standing. Rendered as a `data-join-offer` attribute on the Changes segment, painted by CSS with an accent-token dot ([L06]; tokens, never hex).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Law |
| --- | --- | --- |
| `offer` on the dash feed entry | Server-derived wire fact, read via the changeset feed store | [L02] |
| Revealed `request_id` set | Mount-local `useRef` on the session card | [L22] |
| Shade visibility | Existing `ShadeViewController` external store | [L02] |
| Accent dot | Derived per render → `data-join-offer` attribute → CSS | [L06] |
| Join beats / failure | Existing `ChangesetJoinStore` (unchanged) | [L02] |

#### [T01] `ChangesetJoinStore` — what goes, what stays {#t01-store-split}

| Surface | Fate |
| --- | --- |
| `answerJoinPrompt` sender + `changeset_join_prompt_answer` frame | deleted ([P07]) |
| `changeset_join_prompt_answer_err` action arms | deleted ([P07]) |
| `useChangesetJoinLand` / land-progress state | stays — the composer register and the shade lane read it |
| `changeset_join` land path, `changeset_join_err` | stays — Z5's press |
| `_note` refusal path | stays — [L31] |

---

### Documentation Plan {#documentation-plan}

- `tuglaws/design-decisions.md`: the [P09] decision, appended in the file's voice at the next free `[D##]`.
- `tuglaws/dash-work-doctrine.md` and the tugplug skills (`dash-implement`, `dash-on`, `dash-join` SKILL.md): every sentence that says the join *prompt* raises — e.g. dash-implement's "the join prompt will raise momentarily" and its phase-5 "the prompt is the door" — is rewritten to say the Changes shade reveals; the two-escape-hatch doctrine (`/join <name>` for unbound and legacy dashes) is unchanged.
- `join_pilot.rs` module docstring: the two-marks paragraph becomes a one-mark paragraph.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust unit (join_board):** the offer composes exactly when ready + candidate + quiet, with no mark gate — the existing "asks once / new round asks again" tests become "offer stands / new round mints a new id"; provenance arms (bare / described / drafted) keep their pins against the renamed fact.
- **Rust unit (verify):** the mark-helper tests are deleted with the helpers; `tugjoinpilot` tests stay.
- **Drift:** `stream_json_catalog_drift.rs` updated — the answer frame leaves the catalog; the reshaped join-state block matches the TS mirror.
- **App-test (at0445, renamed at0445-join-reveal):** scratch-repo dash driven to `join_ready` with a candidate; pins: the shade reveals only after the turn settles (MutationObserver history, not a sampler); the fold shows `lands as` with the composed subject and the description-provenance note; closing the shade → no re-reveal on subsequent recomputes; a new round → reveal again; the accent dot stands while hidden and is gone after the join lands.
- **Unit (deck):** none replaces `join-prompt-inline.test.ts` — the reveal is an effect over existing stores and is covered at the app-test layer where the real shade exists.

#### What stays out of tests {#test-non-goals}

No jsdom render tests, no synthetic store fixtures standing in for the feed, no timer-sampled reveal assertions. The reveal's timing pin observes the DOM's own mutation history on a real card.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The offer fact replaces the prompt fact | done | `23b7a8e8f` |
| #step-2 | The answer path and the dismissal mark die | done | `9f2e0d0b0` |
| #step-3 | The reveal replaces the inline surface | done | `23b7a8e8f` |
| #step-4 | The dot and the lands-as view | done | `60385747a` |
| #step-5 | at0445 pins the reveal arc | done | `bdd806342` |
| #step-6 | Doctrine, skills, and the integration checkpoint | done | `98bf7a47f` |

---

#### Step 1: The offer fact replaces the prompt fact {#step-1}

**Commit:** `tugdash(unified-changes): derive the join offer, not the ask`

**References:** [P01] the offer fact, [P06] lands-as, (#prompt-inventory)

**Artifacts:** reshaped `DashJoinState` in both mirrors; `standing_offer` in `join_board.rs`.

**Tasks:**
- [ ] In `tugcast-core/src/types.rs`: rename `DashJoinPrompt` → `DashJoinOffer`, drop `question` and `options`, delete `DashJoinPromptOption`; rename the `DashJoinState.prompt` field → `offer`.
- [ ] In `join_board.rs`: rename `standing_prompt` → `standing_offer`; delete `prompt_options`; delete the `read_prompt_mark` comparison (the mark itself dies in Step 2 so this step leaves `verify.rs` untouched and green); keep the quiet-gate parameter and the `landing_message_preview` read exactly as they are; update the blocked-arm literal (`prompt: None` → `offer: None`).
- [ ] In `tugdeck/src/lib/changeset-types.ts`: mirror the reshape (`DashJoinOfferWire`, field `offer`); fix the one deck read that compiles against it this step (the lane passes the join block through; the prompt component still compiles against the old import until Step 3, so this step also updates `join-prompt-inline.tsx`'s prop types minimally — mechanical rename only, no behavior).
- [ ] Update `stream_json_catalog_drift.rs` for the reshaped block.

**Tests:**
- [ ] `join_board` tests renamed and re-aimed: `the_offer_arrives_once_the_machine_is_out_of_work_and_not_before`, request-id stability across recomputes, new-round-mints-a-new-id; the three provenance-arm tests keep their assertions against `offer`.
- [ ] The mark-gate tests (`write_prompt_mark` suppresses / `clear_prompt_mark` restores) are deleted here with the gate they test.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcast-core`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 2: The answer path and the dismissal mark die {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(unified-changes): delete the prompt answer path and its mark`

**References:** [P04] per-mount memory, [P07] the answer path dies, (#prompt-inventory)

**Artifacts:** removals only.

**Tasks:**
- [ ] Delete from `agent_supervisor.rs`: the dispatch arm, `parse_changeset_join_prompt_answer_payload`, `do_changeset_join_prompt_answer`, and the payload struct — the handler goes first so the mark helpers lose their last consumer inside one commit.
- [ ] Delete from `tugdash-core/src/verify.rs`: `prompt_mark_key`, `read_prompt_mark`, `write_prompt_mark`, `clear_prompt_mark`, and their tests. `tugjoinpilot` and `tugjoinsource` helpers stay byte-identical.
- [ ] Rewrite `join_pilot.rs`'s "Why the two marks are keyed differently" docstring paragraph to describe the one mark that remains and why it is keyed on the head pair.
- [ ] Delete from `changeset-join-store.ts`: the `answerJoinPrompt` sender and every `changeset_join_prompt_answer_err` arm, per [T01]; delete the store tests that drove them.
- [ ] Remove the answer frame from the drift catalog.

**Tests:**
- [ ] `rg "tugjoinprompted|prompt_mark|changeset_join_prompt_answer" tugrust tugdeck` → no matches.
- [ ] Surviving store tests (land progress, refusal `_note`) still green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src/lib/__tests__/changeset-join-store.test.ts`

---

#### Step 3: The reveal replaces the inline surface {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(unified-changes): the shade reveals; the inline prompt is deleted`

**References:** [P02] quiet moments, [P03] passive glance, [P04] per-mount memory, [P08] landing narration, [S01], (#quiet-inputs)

**Artifacts:** a reveal effect in `session-card.tsx`; three file deletions.

**Tasks:**
- [ ] Add the reveal effect to `session-card.tsx` where `useJoinPrompt` is called today (~3476): implement [S01] over the card's existing reads (#quiet-inputs) with a `useRef<Set<string>>` revealed-set; it calls `shadeViewController.show("changes")` and nothing else.
- [ ] Delete `join-prompt-inline.tsx`, `join-prompt-inline.css`, `__tests__/join-prompt-inline.test.ts`; remove the `useJoinPrompt` import and the `liveEdgeContent={joinPromptElement}` pass (the `liveEdgeContent` slot itself stays — it is a generic transcript slot).
- [ ] Verify the composer register still narrates a landing end to end — it reads `useChangesetJoinLand`, which [T01] keeps; nothing to build, only to confirm no import broke.

**Tests:**
- [ ] `rg "join-prompt-inline|JoinPromptInline|useJoinPrompt" tugdeck/src` → no matches.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 4: The dot and the lands-as view {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(unified-changes): the Changes segment wears the offer; the fold shows lands-as`

**References:** [P05] accent dot, [P06] lands-as, [S02], (#state-zone-mapping)

**Artifacts:** segment dot CSS + data attribute; the fold's lands-as section.

**Tasks:**
- [ ] `tug-prompt-entry.tsx`: derive [S02] where the segment group renders (~3598) and set `data-join-offer` on the Changes segment; paint the dot in the entry's CSS from accent tokens.
- [ ] `session-changes-dash-lane.tsx`: when the entry's join block carries `offer`, render the fold section as **lands as** (`TugSectionLabel` eyebrow, the offer's `message`, the provenance note per [P06]); otherwise keep the existing `draft` section.
- [ ] Provenance note copy lives beside the component, keyed on `message_source` — the wire spellings `draft` / `description` / `fallback` from `LandingMessageSource::as_str`.

**Tests:**
- [ ] Covered by Step 5's pins; this step's checkpoint is build-level.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test src/__tests__/card-taxonomy.test.ts`

---

#### Step 5: at0445 pins the reveal arc {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(unified-changes): at0445 drives the reveal, the dot, and lands-as`

**References:** [S01], [S02], [P04], (#test-categories)

**Artifacts:** `tests/app-test/at0445-join-reveal.test.ts` (renamed; `@covers` updated to the reveal effect, the segment, and the lane).

**Tasks:**
- [ ] Rewrite the file on the scratch-repo dash fixture: drive a dash to `join_ready` with a standing candidate and a branch description (no draft), then pin: reveal fires only after the turn settles (MutationObserver history on the view swap, never a fixed-delay sampler); the fold shows the composed `tugdash(<name>): …` subject with the description-provenance note; close the shade → the same `request_id` never re-reveals across recomputes; commit a new round → reveal fires again; the dot stands while the shade is hidden and is absent after the join lands.
- [ ] Keep the join-landing beat pin at the register, where join-voice already aimed it.

**Tests:**
- [ ] The file is the test. `just app-test-covers-check` passes on the rename.

**Checkpoint:**
- [ ] `just build-app` (Rust changed in Steps 1–2), then `just app-test tests/app-test/at0445-join-reveal.test.ts`

---

#### Step 6: Doctrine, skills, and the integration checkpoint {#step-6}

**Depends on:** #step-5

**Commit:** `tugdash(unified-changes): the shade is the decision surface — doctrine and skills`

**References:** [P09] doctrine, (#documentation-plan, #success-criteria)

**Artifacts:** the new `[D##]`; reworded skill and doctrine prose.

**Tasks:**
- [ ] Append the [P09] decision to `tuglaws/design-decisions.md` at the next free number, amending [D150] and [D142], citing [D147] and [D149] unchanged.
- [ ] Sweep `tuglaws/dash-work-doctrine.md` and the three skills' SKILL.md for prompt-raising language; rewrite to the shade reveal; leave the `/join` escape-hatch doctrine intact. Note in the run report that bundle copies refresh on the next app build.
- [ ] Record in the plan's addendum (post-landing) that items 1–4 of the original brief were verified landed in `2ddcace0a` and required no work here beyond the dash-join bare-subject confirmation (its SKILL.md already instructs it).

**Tests:**
- [ ] `rg -i "join prompt|prompt sheet|prompt will raise" tuglaws tugplug/skills` → only historical/decision-record mentions remain, each in past tense.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test-changed`

---

### Deliverables {#deliverables}

- The join arc's decision surface is the Changes shade: revealed in quiet moments, signaled by the segment dot, showing the exact landing subject with provenance, dismissible for free, re-summoned by new work.
- The inline join prompt, its answer control frame, its dismissal mark, and its re-ask policy no longer exist anywhere in the tree.
- A rewritten at0445 pinning the whole reveal arc on a real card over a scratch-repo dash.
- A global design decision recording the shade-as-decision-surface doctrine, amending [D150] and [D142].

---

### Landing Addendum {#landing-addendum}

**The four items of the original brief needed no work here.** Z4A invariance, the Dashes fold's death, guarded release, and scope hygiene all landed on 2026-08-16 in `2ddcace0a`, as the Context section records; the run re-verified them only through the ordinary sweeps. The one item the invocation left open — whether `dash-join`'s SKILL.md instructs a bare subject — was confirmed already true at authoring time and required no edit.

**Two deviations from the written steps, both recorded in their rounds.** Step 3's client deletions landed inside Step 1's commit: reshaping the wire fact orphaned `join-prompt-inline.tsx` outright (it read `question` and `options`, which the offer does not carry), so adapting it for two commits would have been writing code to delete. And the mount-local revealed-set keys on the offer's **`dash_head`**, not its `request_id` as [S01] and [P04] specified — the first at0445 run caught `request_id` re-revealing the shade on every push to the base, because it moves when either head does. The dash head is the fact meaning *work you have not been shown*, which is the distinction the retired dismissal mark was keyed on. It satisfies the success criterion as written (same `request_id` implies same dash head) and additionally makes base moves silent.
