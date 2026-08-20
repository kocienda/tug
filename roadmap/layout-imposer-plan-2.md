## Layout Imposer Round 2 — F → J → G → I → H {#layout-imposer-round-2}

**Purpose:** Implement the five findings from hands-on use recorded in `roadmap/layout-imposer-brief-2.md`, in the brief's proposed order: **F** deterministic Escape in the Lens Cards section, **J** the split chords promoted to the Swift menu, **G** the Layouts miniature as a live, animated instrument in flow, **I** vertical overflow for split columns (the 2.5 rule), **H** a drop-zone drag model for arranging cards in place. Each milestone is a contiguous step range ending in an integration checkpoint, sized to one `/tugplug:dash-implement` invocation.

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

**Round 1 — 2026-08-20, Opus 5.** Reviewed `plan:e959e204ed332404`. Lint: 0 errors, 1 warning (the missing-review-record warning, resolved by this round). Oriented on: first review — the freshly authored document, judged against `tuglaws/plan-review-rubric.md` and the tree, with the drag surface read line by line at the user's request.

Applied, on holes and pitfalls — the drag was where the plan leaned hardest on machinery that does not exist. **The pane drag has no cancel path at all**: `handleDragStart` registers only `pointermove` and `pointerup`, so [P09]'s "Escape mid-drag cancels" was an assertion about code nobody has written, and an interrupted pointer (`pointercancel` — system gesture, scroll takeover) would strand `data-gesture`, the occlusion bracket, and the indicator. Spec S03 now requires both paths and names the precedent to copy — `card-drag-coordinator.ts`, the tab drag, which does have them — including the capture-phase swallow, because an unswallowed Escape would also fire the Lens's `CANCEL_DIALOG` responder (the reason `lens/block-reorder.ts` swallows it, whose comment already names the card drag as the same case). Step 15 additionally has to unwind a rail corridor gesture, since the handlers are live for every drag during the interim before Step 16. On the same axis, **a refused commit had no outcome**: `assignCardsToSlots` refuses as a group and returns `{ok: false}`, which the plan's release path discarded — leaving the frame parked at the zone, transform on, with no commit for the settle to animate. Spec S03 now makes the drop read the result and flash the pane on refusal.

Applied, on technical choices: **mid-drag autoscroll would have armed a FLIP settle on every frame.** [P12] makes the column offset an `arrangementSignature` term, so a per-frame store commit during autoscroll re-arms the settle continuously; the dragged frame is skipped for carrying `data-gesture`, but every other member of that column would be measured and tweened under the user's hand. The offset now moves imperatively on its custom property during the gesture and commits once at drop — the same imperative-then-commit shape the drag already uses for position — with a census cell asserting the other members stay still.

Applied, on architecture and the leaves-it-better test: **the plan deleted a shipped gesture while claiming to generalize the drag.** Dragging a card onto another pane's tab bar merges it as a tab, and that target is already advertised — `dragTabBarCache` is snapshotted at drag start, hit-tested each frame, and stamped `data-card-drag-target`. The app already had exactly one drop zone, and an engine that enumerated every zone except that one would orphan it. Tab bars are now zone kind (d) in [P10], keeping their existing indication and their `onCardMerged` commit.

Asked and settled in-round: with an unmodified release always landing in a zone, an imposed card had no way left to leave the arrangement (edge-resize evicts as a side effect, which is not a gesture anyone would find). The user chose the macOS-typical modifier, ⌘, now [P13]. The collision was checked rather than assumed: ⌘-drag on a *free* pane means move-without-raising and ⌘-*click* with no travel opens the stack picker, both decided at drop in branches that return before any zone logic — different standings, no clash, and `dragStartedWithMeta`'s own comment already frames Cmd-drag as how an imposed pane is evicted. [P13] also restores rail drag-to-unpin, which [P11] had retired with the corridor; one rule now covers both places instead of the corridor's accidental one.

Also corrected: Step 16's symbol-absence checkpoint was written `grep … && exit 1 || true`, which is fragile enough to read as vacuous — now a plain `! grep`. The free-placement non-goal and the M05 success criterion were rewritten to match [P13] rather than contradict it. Two app-test filenames the author had guessed were fixed against the tree before this round (`at0401-sidebar-split`, `at0181-keymap-chord-sweep`); at0456 and at0457 are confirmed unclaimed.

Laws cross-checked: [L02] (the miniature takes props from the section's existing deck subscription rather than reading a store; `columnOffsets` enters through `useSyncExternalStore`), [L06] (indicator, autoscroll property, and miniature transitions are all CSS/DOM — no React state mid-gesture), [L09] (panes own geometry; the drag writes the frame, the store owns the arrangement), [L13] (the miniature is not a pane, so its CSS transition is correct rather than a TugAnimator bypass — stated in [P07]), [L30] (the promoted chords keep one command funnel with the menu as a second door), [D135] (autoscroll rides the gesture's existing rAF, no second clock). The State Zone Mapping gained the mid-gesture autoscroll row, which is the one piece of state that changes zone across the gesture's life.

Not changed, deliberately: the F → J → G → I → H order, the [P08] `run/2.5` rule and its retiring seams, [P10]'s exclusion of cross-place rail↔content drops, and [P06]'s preview-layers-stay-at-rest half. Deferred: [Q01] (the drag's fine feel) stands as the user framed it — structure now, constants tuned by hand on the debug build.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The first layout-imposer plan (`roadmap/layout-imposer-plan.md`, complete and joined to `main`) delivered always-animated layout changes, Lens multi-select, slot nudges, the *flow* geometry, and split content columns. Hands-on use surfaced five follow-ons, investigated in `roadmap/layout-imposer-brief-2.md` and turned into steps here. Two are defects with located engines (Escape's inconsistency is a focus-restore that *creates* a selection plus a BASE-mode arbitration bypass; the missing menu shortcuts are a deliberate unpromotion the feedback overrules). Three are designed extensions: the miniature tracking live flow state, split columns that grow to scroll instead of shrinking their members without limit, and a drop-zone drag replacing the rail corridor model with free movement over advertised targets. The brief's investigation findings (file paths, symbols, mechanisms) are restated in this document so it stands alone.

#### Strategy {#strategy}

- **Bug first (M01 = F).** The Escape fix is independent of everything and repairs a shipped behavior; the `pickOnly`-on-restore fix alone removes the alternation engine, and the arbiter unification hardens the rest.
- **Menu promotion second (M02 = J).** Small and independent, and it front-loads the `CommandMenuFacts.column` menu fact that later gestures keep consulting.
- **Miniature third (M03 = G).** Self-contained inside the Lens; no geometry changes; lands while the column work is exercised.
- **Overflow before drag (M04 = I, M05 = H).** I changes what a split column's geometry *means*; H's drag must be designed once, against the final meaning, with autoscroll-in-a-scrolled-column in scope from the start rather than retrofitted. This order is hard.
- **One engine for the drag.** Rails unify onto the drop-zone engine in the same milestone ([P11]); the corridor code retires rather than surviving as a second drag grammar.
- **Laws travel with the steps.** Each step that touches doctrine carries its tuglaws edit in the same commit (focus-language precedence, menus/chord-tiers, pane-model overflow rule, pane-model drag model), per the cross-check practice in `tuglaws/tuglaws.md`.
- **Five milestones, five implement calls.** M01=F (steps 1–3), M02=J (steps 4–6), M03=G (steps 7–9), M04=I (steps 10–13), M05=H (steps 14–18).

#### Success Criteria (Measurable) {#success-criteria}

- With a selection in the Cards section, pressing Escape repeatedly only ever shrinks state: filter text clears first if present, then the selection clears, then focus leaves the Lens — and the selection **never grows** across any number of presses (app-test verified: the alternation case).
- A selection whose cards are filtered out of the visible list still clears on Escape (app-test verified: store-vs-rows).
- The Window menu shows five items for the split family with ⌃⌘S, ⌃⌘↑/↓, ⌃⇧⌘↑/↓ as key equivalents; each item is enabled exactly when the chord would act, and pressing ⌃⌘↓ with the caret in a session editor moves the column member, not the caret (app-test verified).
- On a flow deck, the committed Layouts row's miniature draws the strip from the slots' real extents with the viewport window at the live offset, and activating an off-band card animates the window to its new position (app-test verified via computed style, not by eye).
- A split column with 3+ members shows each member at `run/2.5` height — two full cards and a half-visible third — and activating an off-run member slides the column minimally until that member is fully visible, animated through the settle (app-test verified).
- Dragging a split-column member moves freely under the pointer while a drop-zone indicator snaps between advertised targets; release animates the card into the indicated zone and commits the matching mutation; Escape mid-drag cancels with no commit and leaves the Lens untouched; a ⌘-held drag still evicts to free pixels; dragging onto another pane's tab bar still merges (app-test verified).
- The rail-member reorder drives through the same drop-zone engine; `beginRailReorder` and the corridor constants are deleted (verified by grep in the checkpoint: the symbols are gone).
- The cut census (at0450) passes with new cells for column overflow reveal and drop-zone drops — zero cuts.
- `cd tugdeck && bunx vite build` clean and the selective app-test set green at every milestone exit.

#### Scope {#scope}

1. The Escape decision table: restore-suppression, store-backed guards, BASE-mode capture symmetry, stated precedence (M01).
2. Menu promotion for the five split chords: the `column` menu fact, registry promotion, Swift menu items, doc regeneration (M02).
3. The miniature as instrument: live offset + real extents on the committed layer, CSS-transition animation for fit and flow alike (M03).
4. Column overflow: the fixed `run/2.5` member height at N ≥ 3, per-slot ephemeral offsets, CSS clamp, reveal-on-activation, seams retiring and returning (M04).
5. The drop-zone drag engine: free movement, zone enumeration and snapping, indicator rendering, release-animates-to-zone, commits mapped per zone kind, rail unification, autoscroll in scrolled columns and flow strips (M05).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Cross-place drops between rails and content.** A content card cannot be dropped onto a rail, nor a sidebar card into a slot; the zone vocabulary is content-side for content cards and rail-side for sidebar cards ([P10]). A future feature.
- **Free placement as a drop zone.** An *unmodified* drop-zone gesture always resolves to an advertised zone; releasing an imposed card no longer evicts it to free pixels ([P09]). Eviction survives as a ⌘-modified drag ([P13]), and free panes on an unimposed deck keep their ordinary free drag.
- **Trackpad scrolling of columns or the flow strip.** Offsets are written by activation and drag-autoscroll only; scroll-intent arbitration stays deferred, as it was for flow ([Q01] of the first plan).
- **Persisting `columnOffsets` or `flowOffset`.** Both are session-ephemeral, per the first plan's [P10].
- **The tab drag.** `card-drag-coordinator.ts` (tab reorder/detach/merge, driven from `tug-tab-bar.tsx`) is a separate pipeline and is not touched — this plan only borrows its cancel-path pattern and, in [P10] (d), keeps the *pane* drag's existing merge-onto-a-tab-bar outcome working.
- **Miniature preview layers going live.** Only the committed layer tracks the deck; auditioned arrangements still draw at rest ([P06]).

#### Dependencies / Prerequisites {#dependencies}

- The first plan's Phases A–E, all landed on `main` (multi-select and `lensSelectionStore`, flow geometry and `flowOffset`, split columns and `imposition.columns`).
- `roadmap/layout-imposer-brief-2.md` — the investigation this plan executes.
- `tuglaws/` doctrine: `tuglaws.md`, `pane-model.md`, `focus-language.md`, `list-view-usage.md`, `chord-tiers.md`, `menus.md`, `component-authoring.md`.

#### Constraints {#constraints}

- Tugdeck laws: one render [L01], external state via `useSyncExternalStore` [L02], `useLayoutEffect` for registrations [L03], appearance via CSS/DOM [L06], panes own geometry [L09], motion through TugAnimator [L13], command funnel [L30], one clock per frame [D135].
- Bun toolchain only; verify with `bunx vite build` (the debug app loads the prod rollup bundle).
- App-tests are selective (`just app-test-changed` / named files), never a sweep. **`deck-manager.ts` and `deck-canvas.tsx` sit at the 20-file `@covers` fan-out ceiling** — new app-tests must not add `@covers` lines naming them; follow at0455's precedent and record the omission in the test's docblock.
- Swift changes require `just build-app` before any app-test run (the app-test harness refreshes `dist` but never rebuilds the binary).
- Warnings are errors across the workspace.

#### Assumptions {#assumptions}

- Column members remain keyed by pane id (the first plan's deviation from its own [P11], recorded in `pane-model.md`); nothing here reopens that.
- The FLIP settle machinery (`arrangementSignature`, the First/Last measurement, `pane-flip.ts`) is sound and extensible by adding signature terms, as M04/M05 of the first plan demonstrated twice.
- `DeckManager.container` (the canvas element) remains the geometry authority for band and run measurements (`_flowBandWidth` reads `container.clientWidth`; the run height reads `container.clientHeight`).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] The drop-zone gesture's fine feel (DEFERRED) {#q01-drop-zone-feel}

**Question:** The precise feel of the drop-zone drag — indicator visual treatment, snap thresholds and hysteresis, autoscroll speed and activation margins, whether the dragged card dims or lifts, timing of the release animation.

**Why it matters:** The user stated the model ("drag freely; the UI advertises specific drop zones; I snap between zones as I move; release animates to the indicated zone") and explicitly flagged: "This will be tricky to get exactly right … We may need to discuss this further to arrive at precisely the set of behaviors I want."

**Options (if known):** Spec S03 fixes the structural behaviors (zone vocabulary, always-live indication, commit mapping, cancel). The feel parameters are deliberately tunable constants.

**Plan to resolve:** Steps 14–17 land the structure with the feel parameters as named constants in one place (`drop-zones.ts`); the user vets on the debug build during the dash's iterate phase, and tuning rounds adjust the constants. Any *structural* change they ask for becomes its own fix round.

**Resolution:** DEFERRED — asked 2026-08-20; the user chose the model and reserved the fine behaviors for hands-on iteration.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Drop-zone feel needs multiple tuning rounds | med | high | Feel parameters are named constants; structure lands first ([Q01]) | user feedback on the debug build |
| Promoted arrows claimed by AppKit inside editors | high | low | Editor-caret app-test before M02 closes (Spec S02) | any editor regression report |
| Drag transforms fighting the FLIP settle | med | med | The drop keeps `data-gesture` so the settle skips the dragged frame, exactly as the corridor drag does today | census cells for drops |
| Corridor removal regresses at0401 | med | high | at0401 is rewritten against the engine in the same step (Step 16), never deleted-and-later | `just app-test-covers-check` |
| Two offsets moving in one gesture (flow + column) cut | med | med | Both are `arrangementSignature` terms; the census gains a combined cell (Step 13) | at0450 |

**Risk R01: The drop-zone engine is the largest new surface** {#r01-drop-zone-surface}

- **Risk:** M05 replaces a working drag (rail corridor) with a new engine; a regression strands both rails and columns.
- **Mitigation:** The engine reuses the proven pieces verbatim (measured resting tiles, `data-gesture` settle handoff, the post-commit cleanup effect); rails and columns are cut over in separate steps with their app-tests rewritten in the same commits; the free-pane drag path is untouched.
- **Residual risk:** Feel iteration ([Q01]) may reshape indicator logic after the checkpoint; structural code is isolated in `drop-zones.ts` to keep those rounds small.

**Risk R02: Menu fact liveness** {#r02-menu-fact-liveness}

- **Risk:** A `column` fact gated only on the Lens selection reads as mostly-disabled in the menu, making the promotion look broken.
- **Mitigation:** The fact ladders to the first-responder card exactly as `resolveLayoutSelection` does ([P05]), so the menu item is live whenever the chord would be.
- **Residual risk:** None beyond ordinary `validate` drift, pinned by at0168/at0181.

---

### Design Decisions {#design-decisions}

#### [P01] Escape in the Lens follows a stated decision table, in this order (DECIDED) {#p01-escape-decision-table}

**Decision:** Escape over the Lens Cards context resolves strictly: (1) the attached filter has text → clear the filter; (2) `lensSelectionStore` is non-empty — the **store**, never the visible-rows projection → clear the selection; (3) otherwise → focus out of the Lens. The precedence is recorded in `tuglaws/focus-language.md`.

**Rationale:**
- The current behavior distributes the decision across chain order, focus mode, and first-responder identity, which is why identical visible states resolve differently.
- Filter-over-selection is already the de-facto order (`handleListKey` yields when `attachedFilter` has a query); stating it makes it a contract instead of an accident.

**Implications:**
- The list's `captures` predicate and `handleListKey` read `lensSelectionStore.getSnapshot().ids` (via the section's `multiSelect` delegate), not `selectedRowIds` built from visible rows.
- `focus-language.md` gains the precedence paragraph in the same commit.

#### [P02] A focus restore never creates a selection (DECIDED) {#p02-restore-never-selects}

**Decision:** The auto-select rule in `attachLensSelectionToDeck` (`selection.pickOnly(fr)` on a content-card first responder) is suppressed when the first-responder change is a programmatic focus restore. The `FOCUS_LENS` toggle-out in `deck-canvas.tsx` sets a one-shot suppression on `lensSelectionStore` (`suppressNextAutoSelect()`) immediately before calling `transferFocusForActivation`; the attacher consumes and clears it.

**Rationale:**
- This is the alternation engine: Escape with an empty selection focuses out, the restore activates the prior card, and the attacher's `pickOnly` re-creates the very selection the next Escape clears. The rule was written for user activations, not restores.
- A one-shot flag at the store keeps the attacher's subscription shape unchanged and the knowledge at the only call site that performs a restore.

**Implications:**
- Any future programmatic restore that must not select goes through the same suppression; the store method's doc says so.
- The at0451 alternation case (Escape ×4, selection never grows) pins it.

#### [P03] BASE-mode Escape consults the key view before the chain (DECIDED) {#p03-base-capture-symmetry}

**Decision:** `captureListener` in `responder-chain-provider.tsx` — which today dispatches a `CANCEL_DIALOG`-matching Escape straight into the responder chain when the focus mode is `BASE_FOCUS_MODE` — first consults `focusManager.keyViewCaptures(focusKey)`, the same predicate `actDispatchListener` consults, and yields to the key-view delegate when it captures.

**Rationale:**
- The list's "while there is a set, Escape is the list's" contract (`tug-list-view.tsx`, the `captures` behavior) is currently bypassed in the most common state (no descend scope, no dialog — i.e. BASE), so who arbitrates depends on invisible mode state.
- Symmetry with `actDispatchListener` restores one arbitration story for all modes.

**Implications:**
- Escape behavior inside dialogs/popovers (non-BASE modes) is unchanged.
- With [P01]'s store-backed `captures`, the list now reliably claims Escape whenever a selection exists, whatever holds the ring inside the Lens.

#### [P04] The Cards section keeps one Escape owner (DECIDED) {#p04-one-escape-owner}

**Decision:** The selection-clear lives in the list path (`multiSelect.onClear`, reached via `captures` + `handleListKey`) and in the chain as a backstop (`lens-content.tsx`'s responder and the conditional root clear in `deck-canvas.tsx`), but all of them consult the same store and the same precedence — no path may clear the filter when [P01] says the selection is next, and none may focus out while either has content.

**Rationale:**
- Deleting the chain backstops entirely would leave Escape dead when the first responder is a content card (the walk never reaches `lens-content`); the root conditional clear exists for exactly that case.
- The defect was never that there are several handlers — it is that they disagreed on inputs (rows vs store) and order.

**Implications:**
- `lens-content.tsx`'s responder gains the filter rung: if the Cards section's attached filter has a query, it clears that first (via the existing filter-field chain handler by *not* claiming, or by explicit delegation — implementation picks the simpler and documents it inline).

#### [P05] The split family is promoted with a laddered `column` menu fact (DECIDED) {#p05-column-menu-fact}

**Decision:** `CommandMenuFacts` gains `column: { canSplit: boolean; canMoveUp: boolean; canMoveDown: boolean } | null`, resolved from the layout selection **laddering to the first-responder card** exactly as `resolveLayoutSelection` does, published through `host-menu-state.ts`, decoded in the Swift `MenuState`. The five `COLUMN_SPLIT_COMMANDS` gain `menuItemId` (`window.columnSplit`, `window.columnMoveUp`, `window.columnMoveDown`, `window.columnMoveTop`, `window.columnMoveBottom`), `mirrored: true`, `menuEligible: true` on their single binding, and `validate` reading the new fact.

**Rationale:**
- The original unpromotion rationale ("a menu item's `validate` has nothing to read") was answerable — it just costs a fact. The feedback rules that the menu is the discoverability surface and the chords must appear there.
- Laddering keeps the items live whenever the *chord* would act (Risk R02).

**Implications:**
- Five static `NSMenuItem`s in `buildMenuBar()` (Window menu, beside the width/bullseye group), `keyEquivalent: ""` so `applyCommandChords` writes the chord; `@objc` actions calling `sendControl(...)` with `representedObject` carrying the move target.
- The chords leave the JS funnel globally — AppKit claims them everywhere — so Spec S02's editor-caret test is a close gate for the milestone.
- `menus.md` regenerates; the five chord rows flip `JS, global` → `menu bar (swept)`.

#### [P06] Only the committed miniature layer is live; previews stay at rest (DECIDED) {#p06-committed-layer-live}

**Decision:** `LayoutMiniature` gains committed-layer-only props — the live flow offset and the slots' real extents — fed as props from the Layouts section's existing deck subscription. Preview layers (hover/cursor auditions) continue to draw at rest. The component stays purely presentational: props in, CSS out, no store reads.

**Rationale:**
- This reverses half of a recorded decision (the header's "plan readout, not an instrument" paragraph) on the user's explicit feedback; the preview half of that decision stands — an uncommitted arrangement has no offset to track.
- Props preserve [L06]'s no-store-reads discipline and keep every drawing testable as a pure function of inputs.

**Implications:**
- The header comment is rewritten, not deleted; it cites `roadmap/layout-imposer-brief-2.md` for the reversal.
- The committed row re-renders on activation in flow; that cost is confined to one row and rides the section's existing subscription.

#### [P07] The miniature animates via CSS transitions, fit and flow alike (DECIDED) {#p07-miniature-css-transitions}

**Decision:** Mini blocks and the viewport window transition `left`/`width`/`top`/`bottom` via one CSS transition rule scoped to the committed drawing (`data-committed`); preview layers carry no transition.

**Rationale:**
- The miniature is not a pane; [L13] (TugAnimator for pane motion) does not apply — appearance change through CSS is exactly [L06].
- One rule means the drawing never cuts where the deck glides, in either geometry.

**Implications:**
- App-test assertions on the miniature must target the un-animated end state or the transition property itself (mid-flight computed values interpolate — the known transition-poisoning gotcha).

#### [P08] Overflow: at N ≥ 3 a member's height is `run/2.5`; seams retire (DECIDED) {#p08-overflow-run-2-5}

**Decision:** A split column with 3 or more members abandons share division: every member's height is the run divided by 2.5 (`run = 100% − 5px − 32px`, the span between `IMPOSITION_GAP_PX` and `IMPOSITION_GAP_BOTTOM_PX`), members stack down a virtual strip with the 5px gap between them, and the strip scrolls behind a per-slot offset. Seam handles do not render while the column overflows; user-dragged shares are untouched in the record and resume meaning when the column returns to 2 members.

**Rationale:**
- The user's rule: past ~2.5 visible members, division stops being useful. The half-visible third card *is* the scroll affordance — the vertical twin of flow's clipped card at the band edge.
- Reinterpreting shares against the virtual strip would silently change the seams' meaning at the overflow boundary; retiring them is honest.

**Implications:**
- `columnMemberPins` grows an overflow branch (Spec S01); the equal-share and dragged-share behavior at N ≤ 2 is byte-identical to today.
- The miniature's 3-member drawing cap becomes true geometry rather than a drawing convention.

#### [P09] The drop-zone drag: free movement, always-live indication, release commits to the indicated zone (DECIDED) {#p09-drop-zone-model}

**Decision:** Dragging an arrangeable card moves it freely under the pointer (unconstrained, no corridor). Throughout the gesture exactly one advertised drop zone is *indicated* — initially the card's own current position — and the indication snaps between zones as the pointer moves. Release animates the card into the indicated zone and commits that zone's mutation. Because a zone is always live, an unmodified release is always meaningful: **the unmodified gesture never produces a free-pane eviction**; eviction moves to ⌘ ([P13]). Escape or `pointercancel` mid-drag cancels: the card animates home and nothing commits.

**Rationale:**
- The user's stated model, chosen over corridor parity and over clamped dragging: "the UI advertises specific drop zones … I'll snap between drop zones while the movement itself is unconstrained. When I release, the item must animate to the drop zone that was indicated."
- Always-live indication resolves the "what does releasing nowhere mean" question structurally instead of with a special case.

**Implications:**
- `releaseImposedFrame`'s evict-on-drag path stays reachable, but only under ⌘ ([P13]); free panes on an unimposed deck keep their free drag unchanged.
- The drop keeps `data-gesture` on the dragged frame so the imposer settle animates the landing, as the corridor drag does today.
- Cancel and refusal are both real paths with real outcomes, specified in Spec S03 — a gesture that ends in nothing must say so.
- Feel parameters (snap hysteresis, indicator treatment, autoscroll margins) are named constants pending [Q01] iteration.

#### [P10] Zone vocabulary v1: own column, other slots, other columns' insertion points, tab bars (DECIDED) {#p10-zone-vocabulary}

**Decision:** For a content card, the advertised zones are: (a) every member position of the card's own split column; (b) every other occupied content slot as a whole (join that slot's stack), and every unoccupied slot anchor on a fit deck; (c) every insertion position of another split column; (d) **every other pane's tab bar** (merge as a tab) — the zone that already ships. For a sidebar card, the zones are its own rail's member positions. Rails are not zones for content cards, and content slots are not zones for sidebar cards.

The card's own current position is always a zone, whatever its standing — for an unsplit slot that is the slot itself. That is what makes the initial indication honest and a zero-travel release a no-op.

**Rationale:**
- The user selected the two content-side vocabularies; rails-as-targets and free placement were offered and not chosen. Free placement instead becomes a modifier gesture ([P13]) rather than a zone.
- **(d) is not new scope — it is the one advertised drop zone the app already has.** `handleDragStart` snapshots every `.tug-tab-bar[data-pane-id]` into `dragTabBarCache`, hit-tests it each frame, and stamps `data-card-drag-target` on the live one; the drop calls `onCardMerged` → `moveCardToPane`. An engine that enumerated every zone *except* that one would delete a shipped gesture (drag a card onto another card's tab bar to make it a tab) while claiming to generalize the drag. It is absorbed, not orphaned.
- Dropping on a whole stacked slot means "join the stack" — the pointer's way of doing `assignCardToSlot`; dropping between a split column's members means insertion at that index. These are different outcomes from (d): a slot holds panes, a pane holds cards as tabs.

**Implications:**
- Commit mapping (Spec S03): own-column position → `setColumnOrder`; other slot / empty anchor → `assignCardToSlot`; other column position → `assignCardToSlot` + `setColumnOrder` on the target, in **one** deck-manager commit so the settle animates once (a new batched `movePaneIntoColumn` on `DeckManager`); tab bar → `onCardMerged(id, paneId, insertIndex)` with `computeMergeInsertIndex` as today.
- The tab-bar zone keeps its existing indication (`data-card-drag-target`) rather than the new indicator element, so the merge affordance a user already knows does not change appearance mid-plan; the indicator element covers the geometric zones.

#### [P13] ⌘ during the drag frees the card; unmodified drags always land in a zone (DECIDED) {#p13-command-frees}

**Decision:** Holding ⌘ during a title-bar drag of an **imposed** card suppresses zone indication entirely and drops the card at free pixels, evicting it from its slot (`onCardMoved(..., {evictSlot: true})` — today's path, unchanged). Without ⌘, the gesture is purely zone-based and never evicts.

**Rationale:**
- The user chose the modifier route and named ⌘ as the macOS-typical key. The code already agrees: `handleDragStart`'s comment on `dragStartedWithMeta` says a Cmd-drag "for an imposed pane … is how it is evicted from its slot".
- Without a door, eviction would survive only as a side effect of edge-resize (which passes `evictSlot` from its own `releaseImposedFrame`), which is not a gesture anyone would find.

**Collision check (verified in `tug-pane.tsx`, not assumed):**
- ⌘-drag on a **free** pane means the Mac convention of moving a background window without raising it. Different standing, no clash — the suppression branch is scoped to imposed cards.
- ⌘-**click** with no travel opens the stack picker (`titleBarRef.current?.revealStack()`), decided in the no-travel branch of `onPointerUp`. Unchanged: ⌘ is read at drop, not at pointer-down, and the zero-travel branch returns before any zone logic.

**Implications:**
- ⌘ is read per frame (like `latestAltKey`), so pressing or releasing it mid-drag switches modes live: the indicator disappears when ⌘ goes down and returns when it lifts.
- Option-snap guides remain meaningful only in the ⌘-suppressed (free) mode and for free panes; a zone-mode drag shows no snap guides.
- `pane-model.md` records both halves (Step 17).

#### [P11] Rails unify on the engine; the corridor retires (DECIDED) {#p11-rails-unify}

**Decision:** The rail-member reorder is rebuilt on the drop-zone engine in this plan (the user chose "unify now"). `beginRailReorder`, `applyRailReorderFrame`, `railReorderTops`, `clearRailReorder`, `RailReorderState`, `RAIL_CORRIDOR_SLOP_PX`, and the corridor conversion logic are deleted; a rail card's zones are its own rail's member positions, and its commit is `setRailOrder`.

**Rationale:**
- One drag grammar; no reconciliation debt. The engine's pieces are the corridor drag's proven pieces (measured resting tiles, half-overlap insertion, settle handoff), generalized over `SeamPlace`-style places.

**Implications:**
- at0401 (rail reorder) is rewritten against the engine in the same commit that cuts rails over — the coverage never lapses.
- A rail drag that today converts to a free drag on corridor exit instead keeps its rail zones live ([P09]: always-live indication). Drag-to-unpin is **not** lost: ⌘ frees a pinned sidebar card exactly as it frees an imposed content card ([P13]), so one rule covers both places rather than the corridor's accidental one.

#### [P12] Column offsets are per-slot ephemeral state with a CSS-side clamp (DECIDED) {#p12-column-offset-state}

**Decision:** `DeckState` gains `columnOffsets?: Readonly<Record<number, number>>` (px, keyed by slot), never serialized — the vertical twin of `flowOffset`. Each overflowing slot's offset is published as one custom property `--tug-slot-<k>-column-offset` by the deck-canvas inset effect, and member `top` expressions clamp it in CSS (`min(var(offset), max(0px, strip − run))`) so window resize re-resolves in reflow with no JS. Writers: activation (reveal, computed in `DeckManager` via the shared reveal math) and, at drop only, M05's drag autoscroll — mid-gesture autoscroll moves the property imperatively and commits the number once (Spec S03), because the offset is an `arrangementSignature` term and a per-frame commit would arm a settle on every frame of the drag. The offset joins `arrangementSignature` so reveals animate through the settle.

**Rationale:**
- Exactly the shape flow proved: ephemeral offset, one property, CSS clamp, reveal-on-activation riding the activation commit so raise and slide are one arrangement change.
- Per-slot because each column scrolls independently.

**Implications:**
- `flowRevealOffset` is axis-free already (pure scalars); it is renamed/shared rather than duplicated (Spec S01).
- The inset effect is keyed on the `railSummary` **string** — the offsets must join that string or the writes never re-run.
- `DeckManager` reads the run height from `container.clientHeight` the same way `_flowBandWidth` reads `clientWidth`.

---

### Deep Dives {#deep-dives}

#### Escape resolution today — the full handler order {#escape-resolution-today}

All in `tugdeck/src/components/tugways/responder-chain-provider.tsx` unless noted; capture-phase listeners in registration order: (0) synthetic-escape bail (`tugways/internal/synthetic-escape.ts`); (0.5) mid-reorder swallow (`lens/block-reorder.ts`); (1) `captureListener` — **at `BASE_FOCUS_MODE` an Escape matching `CANCEL_DIALOG` dispatches into the responder chain immediately**, bypassing the list; (2) `actDispatchListener` — consults `focusManager.keyViewCaptures(focusKey)` (`focus-manager.ts`, which reads only the key view's *own* behavior — no container fallback, unlike `dispatchKeyToKeyView`); (3) `keyViewDelegateListener` → `TugListView.handleListKey` — clears via `multiSelect.onClear` if `selectedIds` non-empty and the filter has no query; (4) the Escape ladder (dismiss → ascend → mode-exit → drop `kbfManual`) — no rung clears the selection.

Chain `CANCEL_DIALOG` responders relevant here, innermost-first: the filter field (`tugways/tug-filter-field.tsx`, present when the query is non-empty), the Lens's own (`lens/lens-content.tsx`: non-empty → `clear()`, empty → `FOCUS_LENS`), the conditional root clear (`chrome/deck-canvas.tsx`, registered on `hasLayoutSelection`). The alternation bug: `FOCUS_LENS` toggle-out → `transferFocusForActivation(... store.activateCard(prior))` → `attachLensSelectionToDeck` (`lens/lens-selection-store.ts`) observes the new content-card first responder and runs `selection.pickOnly(fr)`. The multi-select Escape paths landed in commit `082660f5d`; at0451 (`tests/app-test/at0451-lens-multiselect.test.ts`) covers them.

Known divergence inputs beyond the two fixed here: the section's `multiSelect.selectedIds` is built from **visible rows** (`cards-section.tsx`, `selectedRowIds`), so filtered-out or collapsed selections report size 0; and the first responder's identity decides which chain rung answers (Lens content vs a content card vs the Lens card node above `lens-content`).

#### The rail drag pipeline, and what the engine inherits {#rail-drag-pipeline}

Owner: the pane frame, entered through `CardTitleBar`'s `onDragStart` → `TugPane.handleDragStart` (`chrome/tug-pane.tsx`) — START (pointer capture, `data-gesture`, `captureFocusForDragStart`, rect snapshots), FRAME (`applyDragFrame`, one rAF), DROP (pointer-up). Reorder pieces: `beginRailReorder` latches only when `sidebarStackRef.current?.side` and `railSplitRef.current` hold, discovers members via `.tug-pane[data-rail-split][data-lens="<side>"]`, measures rects in layout px (÷ zoom); `applyRailReorderFrame` translates the dragged frame raw and previews siblings with `translateY` tweens through TugAnimator (`RAIL_REORDER_SHUFFLE_MS`, `slotCancelMode: "snap-to-end"`); insertion index is half-overlap against **latched resting tiles**; `railReorderTops` restacks by `top += height + IMPOSITION_GAP_PX`. The drop keeps `data-gesture` (the settle skips the dragged frame), parks the frame at its new resting top, and commits `onSetRailOrder(side, order)` → `DeckManager.setRailOrder`; a `useLayoutEffect` consuming `pendingRailReorderRef` clears preview transforms post-commit, before the settle's Last measure. Heights travel with cards, so reorders never touch shares — true for columns too (`setColumnShares` keys by pane id).

Place-generic already: the seam component (`PlaceSeam` over `SeamPlace = {kind:"rail"; side} | {kind:"column"; slot}` in `deck-canvas.tsx`), the title-bar arrangement badge (`handleArrangePlace`), the imposer's shared `memberPins`, the cleanup effect, the occlusion bracket. Rail-typed: the latch gate, the discovery selector (columns need `.tug-pane[data-column-split][data-imposed="<slot>"]` — both attributes already stamped), componentId keying (columns key by `data-pane-id`), the `onSetRailOrder` prop (no column twin exists), and the corridor conversion (`RAIL_CORRIDOR_SLOP_PX`; exit → `releaseImposedFrame` → `onCardMoved(..., {evictSlot: true})`). `DeckManager.setColumnOrder`'s doc comment already names "a corridor drag" as an intended caller. Keep distinct: `card-drag-coordinator.ts` is the tab-drag pipeline (reorder/detach/merge via tab bars), untouched by this plan; the free-drag path's tab-bar merge hit-test (`dragTabBarCache`, `computeMergeInsertIndex`) stays reachable only from free panes.

#### The menu pipeline — why the wire cannot conjure an item {#menu-pipeline}

The macOS menu is built statically in `AppDelegate.swift`'s `buildMenuBar()`; every item carries a stable identifier (`.identified("<ns>.<name>")`). Tugdeck pushes `MenuState` (via `webkit.messageHandlers.menuState`); `updateMenuState` caches it and `applyCommandChords` walks the built menu applying three-state chord specs (`absent`/`detach`/`apply`) to items *that already exist by identifier* — nothing on the wire creates one. On the TS side, `host-menu-state.ts`'s `computeCommandCapabilities` skips any entry without `menuItemId`; `keymap-registry.ts`'s `menuChords`/`menuBindingOf` pick the `menuEligible` binding and `chord-format.ts`'s `codeToKeyEquivalent` converts (arrows map to `NSUpArrowFunctionKey`/`NSDownArrowFunctionKey`, so the arrow chords are expressible). `tuglaws/menus.md` is generated from the TS registry alone (`menus-doc.ts`, driven by `menus-doc.test.ts`, `TUG_WRITE_MENUS_DOC=1` to rewrite); its chord table already lists the five chords as `JS, global` — the doc is correct and is the receipt of their unpromotion. The template for a promoted family is `CARD_WIDTH_COMMANDS` (⌃⌘1/2/3): `menuItemId` + `mirrored` + `menuEligible` + `validate`, Swift items built with empty `keyEquivalent` for the sweep to fill, `@objc` handlers calling `sendControl` (`setCardWidthFromMenu(_:)`).

#### The vertical strip is flow's math over heights {#vertical-strip-precedent}

`flowStripPositions` (`lib/layout-imposer.ts`) is a running sum of extents plus gaps — no axis in it. `flowRevealOffset` takes `{stripLeft, extent, stripWidth, band, offset}` — pure scalars with `scrollRectToVisible` semantics and a wider-than-band pin rule; `clampFlowOffset` bounds it. The offset publication pattern: `deckState.flowOffset` (ephemeral, `layout-tree.ts`, never serialized) → `FLOW_OFFSET_PROPERTY`/`FLOW_STRIP_PROPERTY` written by the deck-canvas inset effect (keyed on the `railSummary` string) → clamped inside `imposeStyle`'s `left` calc so resize is pure reflow → `_retuneFlowOffset` re-clamps the *number* on settled resize (`RESIZE_RETUNE_QUIET_MS`). Reveal rides the activation commit (`_flowRevealOffsetFor` inside the first-responder flip) so raise and slide are one settle. The vertical twin substitutes: extent = `run/2.5` px (a pure function of `container.clientHeight`, no pane measurement), strip = over members instead of slots, band = the run, property per slot. The overflow member pins are simpler than the share pins: `top_i = GAP + i × (memberH + GAP_PX) − clampedOffset`, `height = memberH` — expressible as one calc over `100%` exactly like `RAIL_RUN`.

#### The miniature's reversed decision {#miniature-reversal}

`lens/layout-miniature.tsx` currently draws the flow window "at REST, always" and synthesizes the strip from a single preset width (`cardUnits` per card against `FLOW_BAND_NOMINAL_PX`); the header names the costs of tracking live state — the exact costs this plan accepts for the committed layer only. Real inputs exist and are already selected in `deck-canvas.tsx`: `deckFlowStrip(state)` (positions + width, extents = each slot's widest member) and `deckState.flowOffset`. The Layouts section (`lens/sections/layouts-section.tsx`) reads the deck via `useDeck()` and pre-renders `PlanLayer`s; only the committed layer receives the live props. The split-column drawing caps at 3 members (`Math.min(members, 3)`); M04 makes ~2.5 the true geometry, and the drawing follows (Spec S01).

---

### Specification {#specification}

**Spec S01: Overflow column geometry** {#s01-overflow-geometry}

- `columnStanding(count)`: `"shared"` for `count ≤ 2` (today's behavior, byte-identical — shares, seams, drags), `"overflow"` for `count ≥ 3`.
- Overflow member extent: `memberH = run / 2.5`, where `run = 100% − IMPOSITION_GAP_PX − IMPOSITION_GAP_BOTTOM_PX` in CSS terms and `container.clientHeight − 5 − 32` in px terms.
- Overflow pins for member index i of the column's effective order: `top = calc(GAP + i × (memberH + 5px) − clamp(offset))`, `height = memberH`; the clamp is `min(var(--tug-slot-<k>-column-offset, 0px), max(0px, stripH − run))` with `stripH = N × memberH + (N−1) × 5px` — all expressible over `100%` so resize re-resolves in reflow.
- Seam properties are not written and seam handles not rendered for an overflow column; the `shares` record is preserved untouched.
- Reveal on activation: the shared axis-free reveal (extract `stripRevealOffset` from `flowRevealOffset`'s body; `flowRevealOffset` becomes a caller) computed in `DeckManager` inside the activation commit, exactly parallel to `_flowRevealOffsetFor`; a member already fully visible commits no offset.
- `arrangementSignature`'s column term gains the rounded offset; the miniature's overflow drawing shows `2.5` members (two full, one half) with the strip metaphor, replacing the flat 3-cap.

**Spec S02: Menu promotion contract** {#s02-menu-promotion}

- Five items, Window menu, grouped after the width/bullseye block: Split or Stack Column (⌃⌘S, `window.columnSplit`), Move Card Up in Column (⌃⌘↑, `window.columnMoveUp`), Move Card Down in Column (⌃⌘↓, `window.columnMoveDown`), Move Card to Top of Column (⌃⇧⌘↑, `window.columnMoveTop`), Move Card to Bottom of Column (⌃⇧⌘↓, `window.columnMoveBottom`).
- `CommandMenuFacts.column: { canSplit: boolean; canMoveUp: boolean; canMoveDown: boolean } | null` — `null` when no content card resolves; resolved from `resolveLayoutSelection`'s ladder (selection first, first-responder card fallback) against `deckColumnsOf`. `canSplit` is true when the resolved card's slot holds ≥ 2 panes; the move fields reflect the resolved card's position in its column (ends refuse). Top/bottom items validate on the same move fields.
- Wire: the fact joins `EMPTY_MENU_FACTS`, the aggregator in `host-menu-state.ts`, and the Swift `MenuState` decode; `disabledChord: "keep"` (a disabled item keeps showing its chord, matching the width family).
- Close gate: an app-test types into a session-card editor, presses ⌃⌘↓, and asserts the caret did not move while the column responded (or the menu refused with no caret effect).

**Spec S03: Drop zones** {#s03-drop-zones}

- A **zone** is `{ kind: "column-index" | "slot" | "tab-bar", target, index?: number, rect: DOMRect }` per [P10], including the dragged card's own current position.
- Enumeration is pure: `enumerateDropZones(state, draggedPaneId, measuredRects)` in a new `tugdeck/src/lib/drop-zones.ts` — testable without DOM by feeding rects. Tab-bar zones are fed in from the existing `dragTabBarCache` snapshot rather than re-queried.
- Indication: exactly one zone is live at all times; the initial zone is the card's origin; the live zone is the nearest eligible zone to the pointer with hysteresis (a new zone must beat the incumbent by a margin — a named constant). The indicator is imperative DOM (a single absolutely-positioned element on the canvas, positioned via CSS custom properties), never React state during the gesture [L06]. A tab-bar zone indicates through its existing `data-card-drag-target` attribute ([P10]).
- With ⌘ held ([P13]) no zone is live, the indicator is hidden, and the gesture is today's free drag.
- Release: the card animates to the zone (the settle animates the commit; the drop keeps `data-gesture` as today) and the zone's mutation commits in **one** deck-manager call per [P10]'s mapping.
- **Refusal is a visible outcome, never a quiet no-op.** `assignCardToSlot`/`assignCardsToSlots` return `SlotAssignment` and refuse as a group (`{ok: false}`) — e.g. a slot outside the arrangement, or a card hosted in a sidebar pane. On a refusal the frame must not be left parked at the zone with a stale transform and no commit to animate: the card animates home and the refusal flashes the pane (`flashCardPane`, as the column chords' refusals already do). The drop reads the return value; it may not discard it.
- **Cancel paths, both required.** Neither exists in the pane drag today — the precedent to copy is `card-drag-coordinator.ts` (the tab drag), which registers a **capture-phase document `keydown`** for Escape and a **`pointercancel`** handler on the element, and runs the same cleanup-without-commit for both. Escape must be swallowed (`preventDefault` + `stopImmediatePropagation`) so the Lens's `CANCEL_DIALOG` responder does not also fire — the reason `lens/block-reorder.ts` swallows it, and its comment names the card drag as the same case. `pointercancel` (system gesture, scroll takeover) must clear transforms, the indicator, the occlusion bracket, and `data-gesture` without committing; today's pane drag handles only `pointermove`/`pointerup`, so an interrupted gesture leaves state behind.
- Autoscroll: while the pointer holds near an overflowing column's run edge (or the band's edge on a flow deck), the relevant offset advances at a constant rate (named constants) and zone rects re-derive. **During the gesture the offset is written imperatively to its custom property only — never committed to the store per frame.** A store commit would change `arrangementSignature` (the offset is a term per [P12]) and arm a FLIP settle on every autoscroll frame; the dragged frame is skipped for carrying `data-gesture`, but every *other* member of that column would be measured and tweened under the user's hand. The number commits once, at drop or cancel, alongside the zone's mutation.
- Feel constants (hysteresis margin, autoscroll margin and rate, indicator inset) live together at the top of `drop-zones.ts`, per [Q01].

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `lensSelectionStore` auto-select suppression | local-data (one-shot flag) | module state on the store, consumed by the attacher | [L02] |
| Escape precedence | structure (arbitration) | responder chain + key-view capture; no new state | [L30] |
| `CommandMenuFacts.column` | structure (derived) | computed in the menu-state push from store snapshots | [L02] |
| miniature live offset/extents | appearance | props from the section's `useDeck()` subscription; CSS transitions | [L02], [L06] |
| `columnOffsets` | structure | `DeckState` + `useSyncExternalStore`; published as per-slot custom properties in the inset `useLayoutEffect` | [L02], [L22], [L06] |
| drop-zone gesture state | local-data (imperative, per-gesture) | refs in `tug-pane.tsx`, like the existing drag; zero React state mid-drag | [L06], [L09] |
| drop-zone indicator | appearance | one DOM element, custom properties, CSS | [L06] |
| mid-gesture autoscroll offset | appearance during the gesture, structure at drop | custom property written imperatively per frame; one store commit at drop/cancel (Spec S03) | [L06], [L02] |
| autoscroll clock | appearance/motion | the gesture's single rAF (the existing `applyDragFrame` clock) | [D135] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/drop-zones.ts` | Pure zone enumeration, nearest-zone selection with hysteresis, feel constants |
| `tugdeck/src/lib/__tests__/drop-zones.test.ts` | Unit tests over synthetic rects |
| `tests/app-test/at0456-column-overflow.test.ts` | Overflow geometry, reveal, seam retirement (verify the number is unclaimed before creating; renumber if taken) |
| `tests/app-test/at0457-drop-zone-drag.test.ts` | Drag, snap, release, cancel, rail parity (same numbering caveat) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `suppressNextAutoSelect()` | method | `lens/lens-selection-store.ts` | one-shot; consumed by `attachLensSelectionToDeck` |
| `captures` / `handleListKey` guards | edit | `tugways/tug-list-view.tsx` + `lens/sections/cards-section.tsx` | read the store via the `multiSelect` delegate, not visible rows |
| `captureListener` key-view consult | edit | `tugways/responder-chain-provider.tsx` | [P03] |
| `CommandMenuFacts.column` | field | `tugways/command-registry.ts` | + `EMPTY_MENU_FACTS`, aggregator, Swift decode |
| five `window.column*` menu items | NSMenuItem | `tugapp/Sources/AppDelegate.swift` | `buildMenuBar()`, empty keyEquivalent |
| `LayoutMiniatureProps.flowOffsetPx` / `slotExtents` | props | `lens/layout-miniature.tsx` | committed layer only |
| `columnStanding` | fn | `lib/layout-imposer.ts` | Spec S01 |
| `stripRevealOffset` | fn | `lib/layout-imposer.ts` | extracted axis-free core of `flowRevealOffset` |
| `columnOffsetProperty(slot)` | fn | `lib/layout-imposer.ts` | `--tug-slot-<k>-column-offset` |
| `DeckState.columnOffsets` | field | `layout-tree.ts` | ephemeral, never serialized |
| `DeckManager._columnRevealOffsetFor` / `_columnRunHeight` | methods | `deck-manager.ts` | parallel to `_flowRevealOffsetFor` / `_flowBandWidth` |
| `DeckManager.movePaneIntoColumn(paneId, slot, index)` | method | `deck-manager.ts` | one batched commit: slot assign + column order |
| `enumerateDropZones` / `pickLiveZone` | fns | `lib/drop-zones.ts` | Spec S03 |
| drag `keydown`(Escape, capture) + `pointercancel` | handlers | `chrome/tug-pane.tsx` | new to the pane drag; pattern from `card-drag-coordinator.ts` |
| `PlaceReorder` gesture (replaces `RailReorderState` et al.) | rewrite | `chrome/tug-pane.tsx` | engine wiring; corridor symbols deleted |
| `onDropZoneCommit` prop family | props | `chrome/deck-canvas.tsx` → `tug-pane.tsx` | replaces `onSetRailOrder`-only shape |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/focus-language.md` — the Escape precedence paragraph (Step 2).
- [ ] `tuglaws/menus.md` — regenerate (Step 4); `tuglaws/chord-tiers.md` residents note updated (Step 4).
- [ ] `lens/layout-miniature.tsx` header — decision rewrite citing the brief (Step 7).
- [ ] `tuglaws/pane-model.md` — the overflow rule beside the split rule (Step 12); the drop-zone drag model (Step 17).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure imposer math, zone enumeration, selection-store semantics | Spec S01 pins, `stripRevealOffset`, `enumerateDropZones` over synthetic rects |
| **Integration (app-test)** | Real gestures on the real app | Escape sequences, menu items, drags, reveals — every user-visible claim |
| **Golden / Contract** | Registry ↔ doc ↔ menu agreement | `menus-doc.test.ts`, at0168's static item table, command-routing drift |
| **Drift Prevention** | The census | at0450 cells for overflow reveal, combined flow+column motion, drop commits |

App-tests must drive real code paths on real content; every new cell carries an engagement guard (a cell that no-ops must fail, not report a clean census). Mid-transition computed styles interpolate — assert end states or the transition property. New app-tests must not add `@covers` lines naming `deck-manager.ts` or `deck-canvas.tsx` (both at the fan-out ceiling); record the omission in the docblock as at0455 does.

#### What stays out of tests {#test-non-goals}

- Visual feel of the miniature transitions and the drop-zone indicator — [Q01] territory; the user vets on the debug build. Tests pin structure (positions, commits, animation presence), not aesthetics.
- jsdom/RTL render tests — banned; everything user-visible is an app-test.
- The tab-drag pipeline — untouched, covered by its existing tests.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | F — the restore that selects | done | `bafdfa9c9` |
| #step-2 | F — one arbiter, stated precedence | done | `f0b730b77` |
| #step-3 | F — integration checkpoint | done | `f0b730b77` |
| #step-4 | J — the column fact and registry promotion | done | `077e3541f` |
| #step-5 | J — Swift menu items and the editor gate | done | `40fa37601` |
| #step-6 | J — integration checkpoint | done | `40fa37601` |
| #step-7 | G — the committed layer goes live | done | `ace99958a` |
| #step-8 | G — one transition rule | done | `42d5b8237` |
| #step-9 | G — integration checkpoint | done | `42d5b8237` |
| #step-10 | I — overflow geometry, pure | pending | — |
| #step-11 | I — offsets, clamp, reveal | pending | — |
| #step-12 | I — UI, miniature, doctrine | pending | — |
| #step-13 | I — integration checkpoint | pending | — |
| #step-14 | H — zone model and enumeration | pending | — |
| #step-15 | H — the gesture: free drag, snap, release | pending | — |
| #step-16 | H — rails unify, corridor retires | pending | — |
| #step-17 | H — autoscroll and doctrine | pending | — |
| #step-18 | H — integration checkpoint | pending | — |

**Milestone M01: F — deterministic Escape** {#m01-escape}

#### Step 1: F — the restore that selects {#step-1}

**Commit:** `tugdeck(lens-escape): a focus restore never creates a selection`

**References:** [P02] restore never selects, (#escape-resolution-today, #p01-escape-decision-table)

**Artifacts:**
- `suppressNextAutoSelect()` on `LensSelectionStore`; consumption in `attachLensSelectionToDeck`; the suppression set by the `FOCUS_LENS` toggle-out in `deck-canvas.tsx` before `transferFocusForActivation`.

**Tasks:**
- [ ] Add the one-shot suppression to `lens-selection-store.ts` with a doc naming the restore path as its reason.
- [ ] Set it in the `FOCUS_LENS` toggle-out handler (`deck-canvas.tsx`) on the restore branch only — a user-initiated Lens activation keeps today's behavior.
- [ ] Consume-and-clear in `attachLensSelectionToDeck` before the `pickOnly` branch.

**Tests:**
- [ ] Unit (`lens-selection-store` tests): suppression is one-shot — the next auto-select is skipped, the one after fires.
- [ ] at0451 gains the alternation case: build a selection, press Escape four times; assert the selection is empty after press 1 and **stays empty** — it never grows across presses.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/lens && bunx tsc --noEmit`
- [ ] `just app-test tests/app-test/at0451-lens-multiselect.test.ts`

---

#### Step 2: F — one arbiter, stated precedence {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(lens-escape): Escape reads the store and one precedence, in every focus mode`

**References:** [P01] decision table, [P03] BASE capture symmetry, [P04] one owner, (#escape-resolution-today)

**Artifacts:**
- Store-backed `captures`/`handleListKey` inputs; the `captureListener` key-view consult; the chain backstops aligned to the precedence; the `focus-language.md` paragraph.

**Tasks:**
- [ ] Feed the Cards section's `multiSelect` delegate from `lensSelectionStore.getSnapshot().ids` (not `selectedRowIds`) for the `captures`/`onClear` guards; `onClear` clears the store regardless of visibility.
- [ ] In `responder-chain-provider.tsx`, make `captureListener`'s BASE-mode `CANCEL_DIALOG` dispatch consult `focusManager.keyViewCaptures(focusKey)` first and yield when it captures ([P03]).
- [ ] Align the backstops to [P01]: `lens-content.tsx`'s responder respects the filter rung; the root conditional clear (`deck-canvas.tsx`) reads the same store.
- [ ] Write the precedence into `tuglaws/focus-language.md` (filter → selection → focus-out; a restore never selects).

**Tests:**
- [ ] at0451: store-vs-rows — select two cards, filter them out of view, press Escape; the selection clears (assert via a follow-up gesture, not a DOM count).
- [ ] at0451: filter precedence — with filter text and a selection, Escape clears the text first, the selection second, focus third.
- [ ] Existing at0451 cases stay green (no regression to click/keyboard selection building).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0451-lens-multiselect.test.ts`

---

#### Step 3: F — integration checkpoint {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `N/A (verification only)`

**References:** [P01], [P02], [P03], [P04], (#success-criteria)

**Tasks:**
- [ ] Walk the decision table by hand on the debug build across the three first-responder shapes (Lens content, a content card, the Lens card node) — same outcome in all three.

**Tests:**
- [ ] The full at0451 file green in one run.

**Checkpoint:**
- [ ] `just app-test-changed` (or the derived selection if it exceeds the budget — run the lens/chrome subset and say so)

---

**Milestone M02: J — the menu promotion** {#m02-menu}

#### Step 4: J — the column fact and registry promotion {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(menu-column): the split family gains a menu fact and promotion fields`

**References:** [P05] column menu fact, Spec S02, Risk R02, (#menu-pipeline)

**Artifacts:**
- `CommandMenuFacts.column`; promotion fields on the five `COLUMN_SPLIT_COMMANDS`; `host-menu-state.ts` publication; regenerated `menus.md`; updated `chord-tiers.md` residents note.

**Tasks:**
- [ ] Add the `column` fact per Spec S02 (laddered resolution via `resolveLayoutSelection` + `deckColumnsOf`) to `CommandMenuFacts`, `EMPTY_MENU_FACTS`, and the aggregator.
- [ ] Add `menuItemId`, `mirrored: true`, `menuEligible: true`, `disabledChord: "keep"`, and `validate` to the five entries; run the collision lint.
- [ ] Update the `PROMOTED` table in `command-registry.test.ts`; regenerate `menus.md` (`TUG_WRITE_MENUS_DOC=1`); update `chord-tiers.md`'s note that the family was promoted and why.

**Tests:**
- [ ] Unit: the fact resolves through the ladder — a Lens selection wins, the first-responder card falls back, no content card → `null`.
- [ ] `menus-doc.test.ts` and `command-routing-drift.test.ts` green (the five rows flip to `menu bar (swept)`).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`

---

#### Step 5: J — Swift menu items and the editor gate {#step-5}

**Depends on:** #step-4

**Commit:** `tugapp(menu-column): five Window-menu items for the split family`

**References:** [P05], Spec S02, Risk R02, (#menu-pipeline)

**Artifacts:**
- Five `NSMenuItem`s in `buildMenuBar()`; `MenuState` decode for the `column` fact; `@objc` actions via `sendControl`; updated at0168 static table; the editor-caret gate test.

**Tasks:**
- [ ] Build the five items in the Window menu after the width/bullseye group, `.identified` per Spec S02, empty `keyEquivalent`, `representedObject` carrying the move target where applicable.
- [ ] Decode the new fact in the Swift `MenuState` and wire `validateMenuItem` for the five identifiers.
- [ ] Update at0168's `STATIC_ITEMS` contract; extend at0181's swept-chord coverage to the five.

**Tests:**
- [ ] at0168: the five identifiers exist with the swept key equivalents (⌃⌘S, arrows with ⌃⌘ and ⌃⇧⌘ masks).
- [ ] The editor gate (Spec S02): caret in a session editor, ⌃⌘↓ — column acts, caret holds (add to at0168 or the fitting existing editor test; a menu-chord test needs `foreground: true` per the harness doctrine).

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test tests/app-test/at0168-menu-structure.test.ts tests/app-test/at0181-keymap-chord-sweep.test.ts`

---

#### Step 6: J — integration checkpoint {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P05], Spec S02, (#success-criteria)

**Tasks:**
- [ ] On the debug build: browse the Window menu — the five items visible with chords; disabled states track the resolved card; invoke one by menu click and one by chord.

**Tests:**
- [ ] at0455 (column split) still green — the promotion must not have changed chord behavior in the deck.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0455-column-split.test.ts tests/app-test/at0168-menu-structure.test.ts`

---

**Milestone M03: G — the miniature instrument** {#m03-miniature}

#### Step 7: G — the committed layer goes live {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(lens-miniature): the committed drawing tracks the real strip and the live offset`

**References:** [P06] committed layer live, (#miniature-reversal)

**Artifacts:**
- `flowOffsetPx` and `slotExtents` props on `LayoutMiniature`, honored by the committed flow drawing (window position, per-slot block widths); the section feeding them from `useDeck()`; the rewritten header paragraph.

**Tasks:**
- [ ] Add the two committed-layer-only props; when present, draw blocks at real extents (normalized against the real strip width) and the window at the scaled live offset; absent, the at-rest synthetic drawing stands (previews).
- [ ] In `layouts-section.tsx`, compute the strip via `deckFlowStrip` and pass offset + extents to the committed layer only.
- [ ] Rewrite the header's decision paragraph: previews at rest (unchanged rationale), committed live (cite `roadmap/layout-imposer-brief-2.md`).

**Tests:**
- [ ] Unit-style probe (the existing `zz-probe-layout-miniature` app-test surface): with a live offset and uneven extents, the committed drawing's window `left` and block widths match the scaled truth; a preview layer under the same state draws at rest.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/zz-probe-layout-miniature.test.ts`

---

#### Step 8: G — one transition rule {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck(lens-miniature): the committed drawing animates, fit and flow alike`

**References:** [P07] CSS transitions, (#miniature-reversal)

**Artifacts:**
- The transition rule in `layout-miniature.css` scoped to `[data-committed]`; previews untouched.

**Tasks:**
- [ ] One transition covering block `left`/`width`/`top`/`bottom` and the window's `left`/`width` on the committed drawing; no transition on preview layers (audition swaps stay crisp).
- [ ] Confirm fit-mode changes (preset, count, splits) ride the same rule.

**Tests:**
- [ ] App-test: activate an off-band card; assert the committed window's *end* position moved and the computed `transition-property` names the animated properties (never assert mid-flight interpolated values).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/zz-probe-layout-miniature.test.ts`

---

#### Step 9: G — integration checkpoint {#step-9}

**Depends on:** #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P06], [P07], (#success-criteria)

**Tasks:**
- [ ] By eye on the debug build: flow activations glide the window; preset changes glide the blocks; hovering audition rows still swaps instantly.

**Tests:**
- [ ] The miniature probe file and at0454 (flow) green together.

**Checkpoint:**
- [ ] `just app-test tests/app-test/zz-probe-layout-miniature.test.ts tests/app-test/at0454-flow-mode.test.ts`

---

**Milestone M04: I — column overflow** {#m04-overflow}

#### Step 10: I — overflow geometry, pure {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(column-overflow): the 2.5 rule — overflow pins, strip math, shared reveal`

**References:** [P08] run/2.5, [P12] offset state, Spec S01, (#vertical-strip-precedent)

**Artifacts:**
- `columnStanding`, `columnOffsetProperty`, the overflow branch in `columnMemberPins`/`imposeStyle`, `stripRevealOffset` extracted from `flowRevealOffset`.

**Tasks:**
- [ ] Implement Spec S01's pins and clamp expressions in `layout-imposer.ts`; N ≤ 2 byte-identical to today (extend the byte-identity unit tests).
- [ ] Extract the axis-free `stripRevealOffset`; make `flowRevealOffset` a thin caller; keep its wider-than-band pin rule intact.

**Tests:**
- [ ] Unit (`layout-imposer-columns.test.ts`): overflow pins at N=3/4/6 (positions, strip height, clamp bounds); N=2 byte-identity; `stripRevealOffset` equivalence with `flowRevealOffset` on flow inputs; reveal semantics on vertical inputs (already-visible → unchanged; below → minimal slide; taller-than-run → pin to top).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib && bunx tsc --noEmit`

---

#### Step 11: I — offsets, clamp, reveal {#step-11}

**Depends on:** #step-10

**Commit:** `tugdeck(column-overflow): per-slot offsets, CSS clamp, reveal riding the activation commit`

**References:** [P12], Spec S01, (#vertical-strip-precedent)

**Artifacts:**
- `DeckState.columnOffsets`; `_columnRevealOffsetFor`/`_columnRunHeight` in `deck-manager.ts` wired into the activation commit and `moveInColumn`; the inset effect writing per-slot offset properties; the `arrangementSignature` offset term; a resize retune clamping the numbers (parallel to `_retuneFlowOffset`).

**Tasks:**
- [ ] Add the ephemeral field (never serialized — assert in the serialization tests); write reveals inside the same commits that raise/move the member so the settle sees one arrangement change.
- [ ] Publish offsets in the deck-canvas inset effect and **extend the `railSummary` string** with the offsets — the effect is keyed on it and silent otherwise.
- [ ] Add the offset to the signature's column term (rounded), so reveals animate and no-op reveals arm nothing.

**Tests:**
- [ ] Unit (`deck-store-selectors` / manager tests): activation of an off-run member writes the minimal offset; visible member writes none; resize retune clamps.
- [ ] Serialization: `columnOffsets` never round-trips.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`

---

#### Step 12: I — UI, miniature, doctrine {#step-12}

**Depends on:** #step-11

**Commit:** `tugdeck(column-overflow): seams retire at three, the miniature draws the half card, pane-model records the rule`

**References:** [P08], Spec S01, (#miniature-reversal)

**Artifacts:**
- Seam handles and seam-property writes gated on `columnStanding`; the miniature's overflow drawing (2.5 metaphor); the `pane-model.md` overflow paragraphs; at0456.

**Tasks:**
- [ ] Gate `PlaceSeam` rendering and the seam-property writes for overflow columns; shares preserved untouched; handles return at N ≤ 2.
- [ ] Miniature: an overflow column draws two full members and a clipped half (replacing the flat 3-cap); committed layer may reflect the live column offset per [P06] (same prop path).
- [ ] Write the overflow rule into `tuglaws/pane-model.md` beside the split rule.

**Tests:**
- [ ] at0456 (new): three cards split in one slot — member heights ≈ run/2.5; no seam handles; activating the bottom member slides the column minimally (assert offset property + end geometry); closing back to 2 restores seams and shares.
- [ ] at0450: a `column-overflow-reveal` cell with an engagement guard.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && cd .. && just app-test tests/app-test/at0456-column-overflow.test.ts tests/app-test/at0455-column-split.test.ts`

---

#### Step 13: I — integration checkpoint {#step-13}

**Depends on:** #step-10, #step-11, #step-12

**Commit:** `N/A (verification only)`

**References:** [P08], [P12], Spec S01, (#success-criteria)

**Tasks:**
- [ ] On a flow deck, overflow a split column and activate across both axes — the strip slides horizontally and the column vertically in one settle, no cut.

**Tests:**
- [ ] at0450 with a combined `flow:column-overflow` cell (engagement-guarded); at0454, at0455, at0456 green together.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0454-flow-mode.test.ts tests/app-test/at0455-column-split.test.ts tests/app-test/at0456-column-overflow.test.ts`

---

**Milestone M05: H — the drop-zone drag** {#m05-drop-zone}

#### Step 14: H — zone model and enumeration {#step-14}

**Depends on:** #step-13

**Commit:** `tugdeck(drop-zones): the zone vocabulary, enumeration, and live-zone selection — pure`

**References:** [P09] model, [P10] vocabulary, [P13] ⌘ frees, Spec S03, [Q01], Risk R01, (#rail-drag-pipeline)

**Artifacts:**
- `lib/drop-zones.ts`: zone types, `enumerateDropZones`, `pickLiveZone` with hysteresis, feel constants; unit tests.

**Tasks:**
- [ ] Implement Spec S03's enumeration over `(state, draggedPaneId, measuredRects)` — own-column positions, other slots, other columns' insertion points, empty fit anchors, tab-bar zones ([P10] (d), fed from the caller's `dragTabBarCache` snapshot); rail positions for a sidebar card; ineligible targets excluded; the dragged card's current position is always a zone (for an unsplit slot, the slot itself).
- [ ] Implement nearest-zone selection with the hysteresis margin; the incumbent zone survives until beaten by the margin.

**Tests:**
- [ ] Unit: vocabularies per card kind ([P10]); the origin is the initial zone for a split member, a stacked member, and a lone card in a slot; hysteresis (a pointer at the midpoint keeps the incumbent); occupied/empty slot cases; tab-bar zones enumerate and never appear for a sidebar card; a flow deck's off-band slots enumerate with their strip rects.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib && bunx tsc --noEmit`

---

#### Step 15: H — the gesture: free drag, snap, release {#step-15}

**Depends on:** #step-14

**Commit:** `tugdeck(drop-zones): free movement, a snapping indicator, and release that lands where it says`

**References:** [P09], [P10], [P13] ⌘ frees, Spec S03, [Q01], Risk R01, (#rail-drag-pipeline)

**Artifacts:**
- The gesture rewrite in `tug-pane.tsx` for imposed content cards: free translate under the pointer, the indicator element, per-frame zone selection, the ⌘ suppression branch, Escape and `pointercancel` cancel paths; commits per Spec S03 including `DeckManager.movePaneIntoColumn`; the `onDropZoneCommit` prop path in `deck-canvas.tsx`.

**Tasks:**
- [ ] Replace the imposed-card branch of `handleDragStart`/`applyDragFrame`: without ⌘ the frame translates freely with no `releaseImposedFrame` and no evict; zones enumerated at gesture start from live rects (including the existing `dragTabBarCache`), re-picked each frame on the gesture's single rAF.
- [ ] Read ⌘ per frame like `latestAltKey` ([P13]): held, the indicator hides and the existing free-drag path (release, clamp, Option-snap guides, evict at drop) runs unchanged; released, zone mode resumes.
- [ ] The indicator: one absolutely-positioned element on the canvas, positioned via custom properties, visible for the live geometric zone only; a tab-bar zone keeps `data-card-drag-target`. Imperative DOM throughout [L06].
- [ ] Release: park the frame per the zone, keep `data-gesture`, commit the mapped mutation in one deck-manager call, and **read the result** — a `SlotAssignment` refusal animates the card home and flashes the pane rather than leaving it parked (Spec S03).
- [ ] Add the two cancel paths the pane drag has never had, on `card-drag-coordinator.ts`'s pattern: a capture-phase document `keydown` for Escape that swallows the key (`preventDefault` + `stopImmediatePropagation`, so the Lens `CANCEL_DIALOG` responder does not also fire), and a `pointercancel` handler. Both clear transforms, the indicator, the occlusion bracket, and `data-gesture` without committing.
- [ ] Add `movePaneIntoColumn` (batched slot assign + target order) to `DeckManager` and `IDeckManagerStore`.
- [ ] The cancel paths are registered for *every* pane drag, so during the interim before Step 16 they must also unwind a rail corridor gesture (`clearRailReorder` + the `railReorderRef` reset) — a cancel that only knows about zones would leave a half-shuffled rail behind.

**Tests:**
- [ ] at0457 (new): drag a split member within its column past a sibling's midline — indicator moves, release commits `setColumnOrder`, shares untouched; drag onto another stacked slot — joins the stack (`assignCardToSlot`); drag into another split column between members — inserted at the index; drag onto another pane's tab bar — merges as a tab, the shipped gesture intact ([P10] (d)).
- [ ] at0457: Escape mid-drag — no commit, geometry restored, **and** the Lens's selection/focus is untouched (proving the swallow); a ⌘-held drag of a split member — no indicator, drop evicts to free pixels ([P13]).
- [ ] at0450: a `drop-zone-commit` cell (engagement-guarded).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0457-drop-zone-drag.test.ts`

---

#### Step 16: H — rails unify, corridor retires {#step-16}

**Depends on:** #step-15

**Commit:** `tugdeck(drop-zones): rails ride the engine; the corridor is deleted`

**References:** [P11] rails unify, [P09], Spec S03, Risk R01, (#rail-drag-pipeline)

**Artifacts:**
- Rail cards driving through the engine (zones = own rail's member positions, commit = `setRailOrder`); deletion of `beginRailReorder`, `applyRailReorderFrame`, `railReorderTops`, `clearRailReorder`, `RailReorderState`/`RailReorderMember`, `RAIL_CORRIDOR_SLOP_PX`; at0401 rewritten.

**Tasks:**
- [ ] Route the rail-member drag through the engine; the sibling shuffle preview becomes the indicator + settle landing (the `RAIL_REORDER_SHUFFLE_MS` preview tween retires with the corridor — the settle animates the commit; keep the constant only if the indicator design reuses it).
- [ ] ⌘ frees a pinned sidebar card ([P11], [P13]) — the drag-to-unpin the corridor exit used to provide, now on the same key as content eviction.
- [ ] Delete the corridor symbols; the checkpoint greps for them.
- [ ] Rewrite at0401 against the engine in this same commit — drag, snap, release, order commit, shares untouched.

**Tests:**
- [ ] at0401 (rewritten) green; at0457's rail case added (sidebar card's zones never include content slots — [P10]).

**Checkpoint:**
- [ ] `! grep -rn "beginRailReorder\|RAIL_CORRIDOR_SLOP_PX\|railReorderTops" tugdeck/src` (exits 0 only when the symbols are gone)
- [ ] `just app-test tests/app-test/at0401-sidebar-split.test.ts tests/app-test/at0457-drop-zone-drag.test.ts`

---

#### Step 17: H — autoscroll and doctrine {#step-17}

**Depends on:** #step-15, #step-16

**Commit:** `tugdeck(drop-zones): edge autoscroll for scrolled columns and the flow strip; pane-model records the model`

**References:** [P09], [P12], Spec S03, [Q01], (#vertical-strip-precedent)

**Artifacts:**
- Edge autoscroll writing `columnOffsets`/`flowOffset` during a drag (constant rate, margin constants in `drop-zones.ts`), zone rects re-derived as the offset moves; the `pane-model.md` drag-model paragraphs.

**Tasks:**
- [ ] While the pointer holds inside the autoscroll margin of an overflowing column's run (or the band's edge on a flow deck), advance the relevant offset on the gesture's existing rAF clock ([D135] — no second clock) and refresh zone rects.
- [ ] Move the offset **imperatively on its custom property during the gesture** and commit the number once at drop or cancel (Spec S03) — a per-frame store write would arm a FLIP settle on every frame and tween the column's other members under the user's hand.
- [ ] Clamp autoscroll writes with the same clamp the reveal uses; the scrolled-to offset survives the gesture (it is real state, not preview), including on cancel — the card returns home, the view does not.
- [ ] Write the drop-zone drag model into `tuglaws/pane-model.md`, both halves: zone-based by default, ⌘ frees ([P13]).

**Tests:**
- [ ] at0457: in a 4-member overflow column, drag toward the run's bottom edge — the column scrolls, a member initially off-run becomes the live zone, release commits the order; a flow-deck drag near the band edge slides the strip.
- [ ] at0450: an `autoscroll-drag` cell asserting the column's *other* members are not tweened while the pointer holds at the edge (the per-frame-commit regression this step exists to avoid).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0457-drop-zone-drag.test.ts tests/app-test/at0456-column-overflow.test.ts`

---

#### Step 18: H — integration checkpoint {#step-18}

**Depends on:** #step-14, #step-15, #step-16, #step-17

**Commit:** `N/A (verification only)`

**References:** [P09], [P10], [P11], Spec S03, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full-surface pass on the debug build: column drags, cross-slot drops, tab-bar merges, rail drags, overflow autoscroll, flow-deck drags, Escape and `pointercancel` cancels — indicator honest throughout (what it shows is what release does).
- [ ] Confirm ⌘-drag still frees both an imposed content card and a pinned sidebar card ([P13]), and that the free-pane drag on an unimposed deck is untouched.

**Tests:**
- [ ] at0450 full census green including every cell added by this plan; at0401, at0455, at0456, at0457 green together.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0401-sidebar-split.test.ts tests/app-test/at0455-column-split.test.ts tests/app-test/at0456-column-overflow.test.ts tests/app-test/at0457-drop-zone-drag.test.ts`
- [ ] `just app-test-covers-check`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The five round-2 findings shipped: deterministic Escape, the split family in the Swift menu, a live animated miniature, columns that grow to scroll at three members, and one drop-zone drag engine arranging cards across columns, slots, and rails.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every success criterion in #success-criteria verified by its named test.
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build` clean.
- [ ] `just app-test-covers-check` clean; no new `@covers` lines on the two ceiling files.
- [ ] The corridor symbols absent from the tree (Step 16's grep).
- [ ] Doctrine current: `focus-language.md`, `menus.md`, `chord-tiers.md`, `pane-model.md`.

**Acceptance tests:**
- [ ] at0451 (Escape cases), at0168/at0181 (menu), zz-probe-layout-miniature, at0456, at0457, at0401 (rewritten), at0450 (full census).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Drop-zone feel tuning rounds with the user on the debug build ([Q01]).
- [ ] Cross-place drops (content ↔ rail) as zone-vocabulary growth.
- [ ] Trackpad scrolling of columns and the flow strip (scroll-intent arbitration).

| Checkpoint | Verification |
|------------|--------------|
| Escape decision table | at0451 |
| Menu promotion | at0168 + at0181 + the editor gate |
| Live miniature | zz-probe-layout-miniature |
| Overflow geometry | at0456 + at0450 cells |
| Drop-zone engine | at0457 + rewritten at0401 + at0450 cells |
