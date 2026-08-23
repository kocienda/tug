# Tugdeck Plan: Dash+Join Workflow Fixes

## Front the Changes Route, Put Landing Progress in the Transcript {#dash-join-workflow-fixes}

**Purpose:** When a dash is presented for approval, the Session card actually goes to the Changes route — join mode entered, route toggle flipped, composer armed with the draft — instead of glancing at it from the Prompt route. And the join arc's live progress narration moves out of the prompt entry's status row into the transcript, pinned at the live edge beneath messages that may still scroll in.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-23 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-23, fable.** Reviewed `plan:06f9c252d540269e`. Lint: 0 errors, 1 warning (PL023, satisfied by this section). Oriented on: first pass — the whole document, judged against the live code. Verified against the tree: the mode↔sheet coupling and the `landingActive`-derived route toggle (so [P01] is genuinely one call); the dormant `liveEdgeContent` → `trailingContent` plumbing in `session-card-transcript.tsx` with no existing producer; `DashJoinRegisterView`'s export and its `BlockHeader` composition; the `data-empty` bridge's mount-captured `editorExtensions` (hence [P05]'s ref-routed callback); the mode-entry prompt stash (`preCommitDraftRef`, restored verbatim on exit), which grounds the non-destructive-entry assumption; and `at0444`'s register selectors targeting the shade and Lens mounts only (R03 holds). Applied: sequencing — Step 3 falsely depended on #step-1 (the live-edge move uses no emptiness machinery); the dependency is removed so the step can land independently, with #step-4 still gating on both. Tuglaws: [L02] honored (register and shade state via `useSyncExternalStore`), [L06]/[L22] honored (emptiness stays a DOM-attribute appearance path; the new callback fires on transitions only; once-per-head memory stays mount-local), [L13] honored (the register's pulse is `TugProgressIndicator`'s), [L19]/[L20] honored (the new row composes `DashJoinRegisterView`; nothing reaches into its slots), [L31] honored (every refusal path pre-exists; auto-entry adds none). Test shapes: app-tests over real dashes only; no banned shapes; deferred-entry state is produced directly, never raced. Deferred: nothing — no open questions were raised or left.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Two long-standing complaints, both traced to deliberate decisions in the code rather than to bugs.

**The route never switches.** When a bound dash's join offer arrives, `session-card.tsx` runs a reveal effect (the one commented "The reveal is a passive glance") that calls `shadeViewController.show("changes")` and nothing else — it deliberately enters no landing mode. The Z4A route toggle in `tug-prompt-entry.tsx` (`entryRouteChoice`) derives its value from `landingActive` alone, so with no mode entered the toggle stays on **Prompt**, the composer stays a prompt composer, and the ⬆ submits prompts rather than joining. The card looks half-switched: the Changes shade is up, but the card never went to the Changes route. The join lives behind mode entry (the "dead button" lesson: lane JOIN = mode entry, the join control is the composer ⬆), and nothing entered the mode.

There is a second, stacked defect: the reveal effect's gates are one-shot peeks. `entryDelegateRef.current?.isEmpty()` and `shadeViewController.getSnapshot()` are read imperatively inside the effect but are not dependencies, so when the offer arrives at a non-quiet moment the effect returns without recording — and never re-runs when the composer empties or the shade closes. Whether the reveal fires at all depends on gate state happening to hold at a dependency-change instant. This is why the behavior reads as intermittent.

**The progress lives in the wrong room.** The join arc's live narration — the "register": reconciling / checking / ready / joining / joined — is mounted as `<DashJoinRegisterView register={landingRegister} />` inside the prompt entry's status row (`tug-prompt-entry.tsx`, the `statusRow` block guarded by `hasStatusRow`). `join-mode-controller.ts` carries explicit machinery ([P03] in its own docs — the `narration` field and `narrationRestTimer`) to keep that register alive in the composer after the mode exits so it "can finish its sentence" there. The user has asked repeatedly for this progress to be transcript ink instead. The component itself agrees: `dash-join-register.tsx`'s docstring says it wears "the transcript's own chrome" — it composes `BlockHeader`, the transcript's lifecycle-dot header. It was built out of transcript vocabulary and mounted in the composer.

Three pieces of existing machinery make both fixes small:

1. **The mode↔sheet coupling** in `session-card.tsx`: entering either landing mode raises the Changes shade (`shadeViewController.show("changes")`), and exiting drops it. So "front the Changes route" is one call to the card's existing `enterChanges()`, which picks join vs commit from the binding and enters the right mode with the right target.
2. **The route toggle follows for free**: its `value={landingActive ? "changes" : "prompt"}` derivation means mode entry flips the visible tab with no extra wiring.
3. **A dormant live-edge slot already exists**: `SessionTranscriptHost` (in `session-card-transcript.tsx`) declares `liveEdgeContent?: React.ReactNode` — "an element rendered after the last row, inside the scroller, so it scrolls with the conversation and sits directly above the composer at rest. Un-indexed (it takes no row slot and perturbs no anchor math)". It is plumbed through to the inner `TugListView`'s `trailingContent`, and **no producer passes it today**. Its docstring even anticipates this use ("the join arc's decision surface"). This is exactly "pinned beneath other messages which still might scroll in."

#### Strategy {#strategy}

Three moves, in dependency order:

1. Give the card a subscribable composer-emptiness signal (`onEmptyChange` on `TugPromptEntry`, driven from the existing `data-empty` bridge), so the quiet-moment gate can re-arm instead of silently dying.
2. Rewrite the passive reveal as **route entry**: the effect calls `enterChanges()` under the same quiet-moment gates, now all live dependencies. The explicit Lens-row reveal (`revealChanges`) enters the route too when the bound dash carries a standing offer. Record the superseding decision in `tuglaws/design-decisions.md`.
3. Move the register: remove `DashJoinRegisterView` from the prompt entry's status row; mount it in the transcript's `liveEdgeContent` slot via a thin new `SessionLandingProgressRow` component that subscribes to the join mode controller. The register's derivation, narration keep-alive, and rest/retirement mechanics are untouched — only the mount point moves.

#### Success Criteria (Measurable) {#success-criteria}

- When a bound dash's join offer arrives at a quiet moment (no turn in flight, no landing up, empty composer, no shade showing), the card enters join mode: the Z4A route toggle reads **Changes**, the Changes shade is up, and the composer holds the join draft with ⬆ meaning Join. Pinned by app-test.
- When the offer arrives at a non-quiet moment, entry is deferred — and fires on its own when the moment turns quiet (e.g. the composer empties). Pinned by app-test.
- A dismissed entry does not re-raise for the same dash head (once-per-head memory retained). Pinned by app-test.
- While a join runs, the register renders at the transcript's live edge and the prompt entry's status row contains no register. Pinned by app-test.
- The live-edge progress row is never ledgered: after the join settles, the transcript carries exactly one durable join receipt and no progress residue; restore parity ([D111]) is untouched.
- `cargo nextest run` untouched (no Rust changes); `bunx tsc --noEmit` and `bunx vite build` clean; the derived app-test selection green.

#### Scope {#scope}

- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (+ `.css`) — new `onEmptyChange` prop; register removed from the status row.
- `tugdeck/src/components/tugways/cards/session-card.tsx` — reveal effect rewritten to route entry; `composerEmpty` state; `liveEdgeContent` wired; `revealChanges` offer-aware.
- New `tugdeck/src/components/tugways/cards/session-landing-progress-row.tsx` (+ `.css` if styling is needed) — the live-edge register mount.
- `tuglaws/design-decisions.md` — one new global decision entry.
- Two new app-tests; possible selector touch-ups in `tests/app-test/at0444-join-slow-resolver.test.ts`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **A commit-mode register.** Commit mode reports a null register today; inventing progress narration for `/commit` is separate work. The live-edge row is written against the landing register generally, so a future commit register mounts there for free.
- **The join prompt/modal redesign and agent-resolved joins** (the Round 2 redirect / SharedAgent charter). This plan changes where the existing arc presents, not who resolves it.
- **Per-file receipt rows for Merge/Rebase joins** — named as follow-on work in `roadmap/join-receipt-mechanics.md`.
- **The Lens Dashes section rework** (always-visible section, multi-line rows). A separate conversation.
- **Removing the narration machinery** in `join-mode-controller.ts`. It is what keeps the register non-null after the mode exits mid-join; the transcript row depends on it exactly as the composer row did.

#### Dependencies / Prerequisites {#dependencies}

- The join receipt work (`roadmap/join-receipt-mechanics.md`) is landed on `main` — the durable receipt the progress row settles into is the commit-presentation join receipt.
- No server/Rust changes: the offer (`DashJoinOfferWire` with `dash_head` in `tugdeck/src/lib/changeset-types.ts`) and the register derivation (`tugdeck/src/lib/dash-join-register.ts`) are already sufficient.

#### Constraints {#constraints}

- Tuglaws: [L02] external state via `useSyncExternalStore`; [L06]/[L22] no per-keystroke React state — emptiness is a transition callback; [L19]/[L20] compose `DashJoinRegisterView` and `BlockHeader`, add no rule reaching inside their slots; [L31] a refused act speaks.
- App-tests are selective and run bare (`just app-test <file>`), never piped; every new test carries `@covers`.
- Warnings are errors; `bunx vite build` before declaring tugdeck work done.
- No hard-wrapped prose in markdown deliverables.

#### Assumptions {#assumptions}

- `TugListView`'s `trailingContent` participates in follow-bottom the way the `liveEdgeContent` docstring describes (rendered after the last row, inside the scroller). Verified by reading `session-card-transcript.tsx`: the prop is passed straight through as `trailingContent={liveEdgeContent ?? undefined}`.
- The composer stash/restore machinery on landing-mode entry (the in-progress prompt is stashed on entry and restored verbatim on exit — `tug-prompt-entry.tsx`'s mode-entry handling) makes auto-entry non-destructive even in edge cases; the empty-composer gate makes it additionally polite.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The two judgment calls this plan embeds — auto-entry gated on quiet moments rather than unconditional, and the explicit Lens reveal entering the route only when an offer stands — are decided as [P01] and [P04] below; both follow directly from the user's stated intent ("the Changes route should get fronted") plus the existing quiet-moment doctrine.

---

### Risks and Mitigations {#risks}

- **R01 — Auto-entry surprises a user mid-something the gates cannot see** (reading scrollback, about to type). Mitigation: all four quiet gates hold before entry; the entry is one keystroke to leave (Escape exits the mode and drops the shade via the existing coupling); once-per-head memory means a dismissal is final for that dash head.
- **R02 — The live-edge row appears while the user is scrolled up** and goes unseen. Acceptable by design: the row sits at the live edge inside the scroller, the jump-to-bottom affordance exists, and a *failed* join's register is a standing surface that persists until the next join — it will be there when they arrive. No scroll hijacking.
- **R03 — `at0444-join-slow-resolver.test.ts` reads register poses during a live join.** Its `REGISTER` selector targets the Changes-shade row and `LENS_REGISTER` the Lens row — neither is the composer mount — so it should pass unchanged; verify in the step that moves the mount and adjust selectors only if an assertion touched the composer row.
- **R04 — `onEmptyChange` fires on landing-mode document swaps** (mode entry swaps the editor doc, flipping emptiness). Harmless: the gate consults `composerEmpty` only when no landing is active, and transitions are cheap. Note it in the prop's docs so nobody "fixes" it.
- **R05 — Race between the settling register and the arriving receipt row.** The register's success beat rests and then retires on its own timer (`narrationRestTimer`); the durable receipt row arrives from the shell ledger independently. A brief window where both are visible (settled sentence at the live edge, receipt row above it) is correct and self-clearing — do not couple the two.

---

### Design Decisions {#design-decisions}

#### [P01] A ready dash fronts the Changes route (DECIDED) {#p01-ready-dash-fronts-changes}

When a bound dash's join offer arrives and the quiet-moment gate holds, the card calls its existing `enterChanges()` — full join-mode entry — instead of the passive `shadeViewController.show("changes")`. Mode entry raises the shade (existing mode↔sheet coupling), flips the route toggle (derived from `landingActive`), seeds the composer with the join draft, and arms ⬆ as Join. This supersedes the "passive glance" reasoning written at the reveal effect; the comment there is rewritten to state the new contract. A corresponding entry is appended to `tuglaws/design-decisions.md`: *a ready dash is presented on the Changes route, not glanced at from the Prompt route.*

#### [P02] Deferral re-arms: gates are live signals, not one-shot peeks (DECIDED) {#p02-gates-are-live-signals}

Every gate the entry effect consults is a dependency that re-runs it: turn-in-flight (already a `useSyncExternalStore` read), any-landing-active (already derived state), shade view (already read via `useSyncExternalStore` as `shadeView` — added to the effect's inputs), and composer emptiness (new — [P05]). The once-per-dash-head memory (`revealedOffersRef`, mount-local per [L22]) is retained unchanged: the head is recorded only when entry actually fires, so a deferred entry retries until it lands or the head is spent.

#### [P03] Landing progress is transcript ink-in-motion at the live edge (DECIDED) {#p03-progress-at-live-edge}

The register leaves the composer's status row entirely. While the landing register is non-null, the transcript renders it at the live edge — `SessionTranscriptHost`'s `liveEdgeContent` slot — via `SessionLandingProgressRow`, which composes the existing `DashJoinRegisterView`. The row is pinned beneath all rows and scrolls with the conversation; messages still stream in above it. It is never ledgered: replay renders exactly the durable receipts, so restore parity ([D111]) is untouched by construction. The register's other two mounts (Lens Dashes row, Changes-shade dash row) are unchanged.

#### [P04] The explicit reveal follows the offer (DECIDED) {#p04-explicit-reveal-follows-offer}

The Lens dash row's activation path (`revealChanges` in `session-card.tsx`, [D152]'s one reveal path) enters the Changes route via `enterChanges()` when the bound dash carries a standing join offer, and stays a passive `show("changes")` glance otherwise — a dash mid-implementation has no join to arm, and entering join mode on it would seed a composer for a press its gate must refuse. One path, two forms, chosen by the offer's presence.

#### [P05] Emptiness is a transition callback, never render state per keystroke (DECIDED) {#p05-emptiness-transition-callback}

`TugPromptEntry` gains `onEmptyChange?: (empty: boolean) => void`, invoked from the existing `data-empty` bridge (the `EditorView.updateListener` that writes the root's `data-empty` attribute) **only when the boolean flips**, plus once at substrate mount to seed the initial value. The session card holds the result in `useState` — legitimate render state, updated on rare transitions, never per keystroke ([L06]/[L22] preserved: the attribute write stays the appearance path; the callback is behavior).

---

### Deep Dives {#deep-dives}

#### The reveal effect today, and why it misfires {#reveal-effect-today}

In `session-card.tsx`, the effect keyed on `joinOffer?.dash_head` gates on four conditions: `turnInFlight` (from `codeSessionStore`, a dependency), `anyLandingActive` (a dependency), `entryDelegateRef.current?.isEmpty()` (a ref peek — **not** a dependency), and `shadeViewController.getSnapshot() !== "none"` (a snapshot peek — **not** a dependency, though the component separately subscribes to the controller as `shadeView`). A gate failure returns without recording the head, intending a retry — but the retry only happens if a *dependency* later changes. After the turn settles, dependencies go quiet, and a reveal deferred on composer text or shade state never fires. The fix is [P02]; the mechanism for the missing composer signal is [P05].

#### The mode↔sheet coupling and every exit path {#mode-sheet-coupling}

`session-card.tsx` observes `anyLandingActive` (commit-mode active || join-mode active): a false→true edge shows the Changes shade (and closes the find bar); a true→false edge hides it. The shade's self-close (`handleChangesSheetOpenChange`) exits whichever mode is up, and the header ✕ (`dismissChangesShade`) calls `leave()` — persisting a typed message — rather than `exit()`. Consequence for this plan: `enterChanges()` is the *entire* fronting gesture, and every existing exit (Escape, ⌘., ✕, the Prompt segment, ⌃⌘C toggle, a completed land) already returns the card to the Prompt route with the shade down. No new exit wiring.

#### The dormant live-edge slot {#live-edge-slot}

`SessionTranscriptHost` (exported from `session-card-transcript.tsx`) accepts `liveEdgeContent?: React.ReactNode` and forwards it to the inner `TugListView` as `trailingContent`. It is un-indexed — no row slot, no anchor-math perturbation — and currently has **no producer**; the Session card's `<SessionTranscriptHost …>` render site simply gains the prop. This is the only structural wiring the transcript needs.

#### Register lifetime across the mode boundary {#register-lifetime}

`join-mode-controller.ts` derives `registerTarget = this.target ?? this.narration`. While the mode is active, `target` feeds the register; when the user's press fires the join and the mode exits, `narration` keeps the register alive so the beats and the settled sentence outlive the mode. A **successful** narration retires itself after a rest (`narrationRestTimer`); a **failed** one stands until the next join replaces it. `SessionLandingProgressRow` reads the same snapshot the composer read (`joinModeController.subscribe` / `.getSnapshot().register`), so it inherits all of this without modification: the row mounts when the register is non-null, pulses through the beats, rests on the verdict, and unmounts when the derivation returns null.

#### What leaves the prompt entry {#what-leaves-prompt-entry}

In `tug-prompt-entry.tsx`: the `landingRegister` local (from `landingSnap?.register`), the `<DashJoinRegisterView register={landingRegister} />` element in the `statusRow` block, the `landingRegister !== null` term in `hasStatusRow`, and the `DashJoinRegisterView` import. The status row itself stays (it still carries `statusContent` and `cautionContent`). Check `tug-prompt-entry.css` for register-scoped rules under `.tug-prompt-entry-status` and remove any. The `sameRegister` equality in `join-mode-controller.ts` stays — the Lens and shade mounts still ride it.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `composerEmpty` (session-card) | local-data | `useState`, written only on `onEmptyChange` transitions | [L22], [L06] |
| once-per-head reveal memory | local-data (mount-local) | existing `useRef<Set<string>>` | [L22] |
| landing register (live-edge row) | external store | `joinModeController` via `useSyncExternalStore` | [L02] |
| register pose / tone / pulse | appearance | `data-phase` attribute + CSS via `BlockHeader` (existing) | [L06], [L13] |
| shade view | external store | `shadeViewController` via `useSyncExternalStore` (existing) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

- `tugdeck/src/components/tugways/cards/session-landing-progress-row.tsx` — thin component: subscribes to the join mode controller, renders `DashJoinRegisterView` at `altitude="leaf"` or null. A sibling `.css` only if positioning inside the live edge needs it.
- `tests/app-test/at0470-changes-route-fronting.test.ts`
- `tests/app-test/at0471-landing-progress-transcript.test.ts`

#### Symbols to add / modify {#symbols}

- `TugPromptEntryProps.onEmptyChange?: (empty: boolean) => void` — new; invoked from the `data-empty` bridge on transitions and once at substrate wiring to seed.
- `tug-prompt-entry.tsx` — remove the register mount per (#what-leaves-prompt-entry).
- `session-card.tsx` — `composerEmpty` state; the reveal effect rewritten per [P01]/[P02]; `revealChanges` per [P04]; `<SessionTranscriptHost liveEdgeContent={…}>`.
- `SessionLandingProgressRow` — new, per [P03].
- `tuglaws/design-decisions.md` — one appended entry (next free [D##]) recording [P01]'s contract.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **App-tests (primary).** Real dashes in scratch repositories, the real offer round-trip, real mode entry — the harness patterns are already established in `at0436-join-press.test.ts` (building a joinable dash and pressing the join) and `at0444-join-slow-resolver.test.ts` (holding a join in flight long enough to read the register; its `[data-slot="dash-join-register"]` selectors are the vocabulary to reuse).
- **Route-state assertions** read what the user sees: the Z4A choice group's selected value, the shade's presence, the composer's seeded draft text — not controller internals.
- **Live-edge assertions** target `[data-slot="dash-join-register"]` *within the transcript scroller* and assert its **absence** within `.tug-prompt-entry-status`.

#### What stays out of tests {#test-non-goals}

- No racing real processes against each other for gate timing — deferred-entry tests produce the deferring state directly (type into the composer first), never by winning a race.
- No jsdom render tests, no mocked stores, no synthetic offer frames — the offer arrives from the real server because a real dash went ready.
- No relaunch coverage here: durable-receipt restore parity is already pinned by `at0419-join-receipt.test.ts`; this plan adds nothing to the ledger and so has nothing new to restore.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The composer reports emptiness transitions | pending | — |
| #step-2 | A ready dash fronts the Changes route | pending | — |
| #step-3 | The landing register moves to the transcript's live edge | pending | — |
| #step-4 | Integration checkpoint | pending | — |

#### Step 1: The composer reports emptiness transitions {#step-1}

**Commit:** `tugdash(dash-join-workflow): report composer emptiness transitions to the host card`

**References:** [P05] Emptiness is a transition callback, (#reveal-effect-today, #state-zone-mapping)

**Artifacts:**
- `onEmptyChange` prop on `TugPromptEntry`; `composerEmpty` state in the session card.

**Tasks:**
- [ ] Add `onEmptyChange?: (empty: boolean) => void` to `TugPromptEntryProps` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx`, documented per [P05] including the R04 note (landing-mode document swaps fire transitions; consumers gate on landing state).
- [ ] Invoke it from the `data-empty` bridge (the `EditorView.updateListener` in `editorExtensions`) only when the emptiness boolean differs from the last reported value (track via ref), and seed the initial value where the substrate ref is wired (the same effect that seeds the root's `data-empty` attribute). Route the callback through a ref so the mount-time extension array (captured once by `useMemo`) never goes stale.
- [ ] In `session-card.tsx`, hold `const [composerEmpty, setComposerEmpty] = useState(true)` updated by the new prop.

**Tests:**
- [ ] Covered by the step-2 app-test's deferred-entry case, which is driven entirely through this signal; no isolated test — a transition callback exercised only by a synthetic harness would be a mock of the substrate ([#test-non-goals]).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 2: A ready dash fronts the Changes route {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(dash-join-workflow): enter the Changes route when a dash is ready`

**References:** [P01] A ready dash fronts the Changes route, [P02] Gates are live signals, [P04] The explicit reveal follows the offer, (#mode-sheet-coupling, #reveal-effect-today)

**Artifacts:**
- The rewritten entry effect and offer-aware `revealChanges` in `session-card.tsx`; a new global decision entry in `tuglaws/design-decisions.md`; `tests/app-test/at0470-changes-route-fronting.test.ts`.

**Tasks:**
- [ ] Rewrite the reveal effect in `session-card.tsx`: same four gates, but `composerEmpty` and `shadeView` become consulted dependencies alongside `turnInFlight` and `anyLandingActive`; on a quiet moment record the dash head in `revealedOffersRef` and call `enterChanges()` instead of `shadeViewController.show("changes")`. Rewrite the "passive glance" comment block to state the [P01] contract and the [P02] re-arm behavior.
- [ ] Make `revealChanges` offer-aware per [P04]: with a standing offer, record the head and call `enterChanges()`; without one, keep the passive `show("changes")`.
- [ ] Append the [P01] contract to `tuglaws/design-decisions.md` under the next free [D##], citing [D152] (the one reveal path — preserved, now with a mode-entry form) and the mode↔sheet coupling.
- [ ] Write `at0470-changes-route-fronting.test.ts` using the `at0436` harness pattern (scratch repository, real dash driven to ready): **(a)** quiet moment → the Z4A route group's selected value is `changes`, the Changes shade is open, the composer holds the dash's join draft; **(b)** deferred entry → seed composer text *before* the dash goes ready, observe no entry, clear the composer, observe entry fire with no other stimulus; **(c)** once-per-head → Escape out, observe the card at rest on Prompt with no re-entry, and the route group's `data-join-offer` dot still marking Changes. Carry `@covers` for `session-card.tsx` and `tug-prompt-entry.tsx`.

**Tests:**
- [ ] `at0470-changes-route-fronting.test.ts` cases (a), (b), (c) as above.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0470-changes-route-fronting.test.ts`

---

#### Step 3: The landing register moves to the transcript's live edge {#step-3}

**Commit:** `tugdash(dash-join-workflow): land join progress at the transcript's live edge`

**References:** [P03] Progress at the live edge, (#live-edge-slot, #register-lifetime, #what-leaves-prompt-entry)

**Artifacts:**
- `session-landing-progress-row.tsx`; the wired `liveEdgeContent`; the thinned prompt-entry status row; `tests/app-test/at0471-landing-progress-transcript.test.ts`.

**Tasks:**
- [ ] Create `SessionLandingProgressRow` in `tugdeck/src/components/tugways/cards/session-landing-progress-row.tsx`: subscribe to the join mode controller via `useSyncExternalStore` ([L02]), render `DashJoinRegisterView` with the snapshot's register (null → render nothing). Compose only ([L19]/[L20]); a sibling `.css` only if the live edge needs breathing room the register's own chrome doesn't supply.
- [ ] Pass `liveEdgeContent={<SessionLandingProgressRow …/>}` at the `<SessionTranscriptHost>` render site in `session-card.tsx`, and update the slot's stale docstring claim in `session-card-transcript.tsx` ("which today is the join arc's decision surface") to name its real occupant.
- [ ] Remove the register from the prompt entry per (#what-leaves-prompt-entry): the element, the `landingRegister` local, its `hasStatusRow` term, the import, and any register-scoped rules in `tug-prompt-entry.css`.
- [ ] Write `at0471-landing-progress-transcript.test.ts` using the `at0444` slow-resolver pattern to hold a join in flight: while the join runs, `[data-slot="dash-join-register"]` is present within the transcript scroller and absent within `.tug-prompt-entry-status`; after settle, the live-edge register rests and retires on its own, and the transcript's durable rows contain exactly one join receipt. Assert the row sits below the last transcript row (bounding-box order), pinning "beneath messages that still scroll in". Carry `@covers` for the new component, `session-card-transcript.tsx`, and `tug-prompt-entry.tsx`.
- [ ] Run `just app-test tests/app-test/at0444-join-slow-resolver.test.ts` and adjust its selectors only if any assertion touched the composer mount (R03 says none should).

**Tests:**
- [ ] `at0471-landing-progress-transcript.test.ts` as above.
- [ ] `at0444-join-slow-resolver.test.ts` still green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0471-landing-progress-transcript.test.ts tests/app-test/at0444-join-slow-resolver.test.ts`

---

#### Step 4: Integration checkpoint {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** N/A (verification only)

**References:** (#success-criteria), [P01], [P02], [P03]

**Artifacts:**
- A verified fit: the dash replayed onto the live base.

**Tasks:**
- [ ] `tugutil dash replay <name>`.
- [ ] On `Replayed`/`Recorded`: `sh scripts/verify-fit.sh <base-sha> <head-sha>` in the warm worktree. On `Current`: nothing re-runs — the last step's checkpoints verified these bytes. On `Conflicted`: resolve the named round as ordinary work, commit it as a round, then verify as above.

**Tests:**
- [ ] None new — this step verifies the fit, not the work ([#test-non-goals]).

**Checkpoint:**
- [ ] The replay outcome is `Current`, or the verify command over the replayed range exits 0.

---

### Deliverables and Checkpoints {#deliverables}

- A Session card that goes to the Changes route when its dash is ready — toggle flipped, shade up, draft seeded, ⬆ armed — with deferral that re-arms and dismissal that sticks.
- Join progress as transcript ink-in-motion at the live edge, settling into the durable receipt; a prompt entry that is once again only a place to type.
- One new global design decision; two new app-tests pinning both behaviors.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- All success criteria in (#success-criteria) hold, pinned by `at0470` and `at0471`.
- `tsc`, `vite build`, and the derived app-test selection are green; the fit is verified per #step-4.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- A commit-mode register riding the same live-edge row, so `/commit` narrates where joins now do.
- The Lens Dashes section rework (always-visible, multi-line rows, bound-session references).
- The join prompt/agent-resolution arc (Round 2 redirect).
