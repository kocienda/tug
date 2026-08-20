## Layout Imposer Features — C → A → B → D → E {#layout-imposer-features}

**Purpose:** Implement the five layout-imposer features specified in `roadmap/layout-imposer-brief.md` in the brief's proposed order: **C** always-animated layout changes, **A** multi-select in the Lens Cards section, **B** relative slot nudges, **D** a *flow* layout mode alongside *fit*, **E** vertical splits for content cards. Each phase is a contiguous step range ending in an integration checkpoint, sized to one `/tugplug:dash-implement` invocation.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-19 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-19, Fable 5.** Reviewed `plan:cdb84dfff9963eda`. Lint: 0 errors, 1 warning (the missing-review-record warning, resolved by this round). Oriented on: first review — the freshly authored document, judged against the rubric and the tree. Applied: on the technical-choices axis, Step 13's fit/flow control corrected from `TugOptionGroup` (a multi-toggle, wrong for a mutually-exclusive pair) to `TugChoiceGroup`, which [L19] and the Layouts section's own header doc mandate for every control there; on plan-coherence, [P02]'s ghost capture point pinned to the real close dispatch site (`store.handlePaneClosed` called from `deck-canvas.tsx`) rather than a vaguely named "flow". Symbol claims spot-verified against the tree during authoring and review: `assignCardToSlot`, `getFirstResponderCardId`, `arrangementSignature`, `imposeStyle`/`imposeSidebarStyle`, `RailArrangement`, `LensCardsDataSource`, `lastSelectedRowId`, gesture-record modifier fields, ⌃⌘S and ⌃⌘↑/↓ chord vacancy, and the referenced app-tests (`at0294`, `at0303`, `at0332-pane-occlusion`, `at0401`). Deferred: [Q01] flow-mode trackpad panning stays deferred by design; no new questions raised.

**Round 2 — 2026-08-19, Opus 5.** Reviewed `plan:7a355388c1cb26fc`. Lint: 0 errors, 0 warnings, before and after. Oriented on: the Review Record plus the four commits that landed Phases C, A and B since round 1 (`520f094eb`, `fc9683893`, `ea6e504b2`, and the follow-on rail fix `98fe22fad`); the plan itself is tracked and clean, so the diff read was over the tree, not the document. Scope: Milestones M04 (steps 11–14) and M05 (steps 15–19) — steps 1–10 are `done` and were not reviewed or touched.

Applied, on technical choices: the space allocator was the round's main find. In flow every seam is the imposition gap by construction, so `solveSidebarWidths`'s `aⱼ` terms are all zero and `seamPicture` scores every candidate total at zero on its first three keys — the lexicographic objective collapses to `|T − Σ preferred|`. Step 11 now takes the shortcut `allocateSidebarWidths` already takes for a seamless chain (and justifies in the same words) instead of leaving the allocator flexing rails against overlap that flow makes impossible; a consequence is that `imposeRect` and `seamPicture` stay fit-only, which the plan now states rather than leaves ambiguous. On correctness: `arrangementSignature` gains `imposition.layout` as a term of its own — a fit↔flow toggle moves every pane's `left` while every existing term holds still, so the plan as written would have cut on the one gesture Phase D exists to add, and the offset term does not cover it at offset 0. On the same axis, `bullseyeAnchorCentre` resolves each pane's exit-side sort line through `imposeStyle().left`, so [P10]'s "bullseye is unchanged" was true of the bullseyed pane and false of the others; the carve-out is now in Step 12. On architecture: flow breaks the invariant `ImposedPlacement`'s doc comment states outright — a placement that no longer resolves from the pane's own slot alone — so Step 11 pins strip resolution to the single deck-canvas placements memo and requires the doc amended in the same commit. On robustness: the offset clamp moves into CSS (`min()`/`max()` over the strip width and the band) so flow answers a window resize in the browser like fit does, rather than showing a stale viewport until the 200ms retune; the property is renamed `--tug-imposer-flow-offset` to join the family the same effect writes. On cold-reader gaps: the deck-canvas inset effect is keyed on a `railSummary` **string**, so Steps 12 and 16 now say to extend it or the writes never re-run; `activateCard` is a pass-through, so Step 12 names `_commitStandardFirstResponderFlip` as the commit the reveal rides and scopes it to imposed panes; the Layouts section's `focusOrder` ladder and pre-rendered preview layers are requirements Steps 13 and 17 were silent on; `railWeightOf` is module-private, which [P11] implied otherwise. On test hygiene: `at0453` was taken by `at0453-slot-move-holds-rails.test.ts` after authoring, so Phase D and E move to `at0454`/`at0455` throughout, with the collision recorded so the next reader does not "fix" the gap.

Asked and settled in-round: the flow miniature draws its viewport window at rest rather than tracking the live offset (a Lens readout that repaints on every card activation is an instrument, not a plan); Phase E's per-slot column rows render only for slots holding two or more cards rather than mirroring the rail rows' always-rendered-disabled shape — the rail rows are always present to keep a one-card side's un-split gesture reachable, and a one-member column has nothing to un-split. Corrected a success criterion that claimed "cards never overlap" in flow: flow removes collisions between slots, and cards stacked *within* a slot still share its anchor. Deferred: nothing new; [Q01] (trackpad panning) and [Q03] (column persistence across card close) stand as they were.

Not changed, deliberately: [P09]'s decision to keep `kind` as the slot vocabulary in flow, [P10]'s session-only offset, [P11]'s slot-keyed column record, and [P12]'s chord family — ⌃⌘S and the ⌃⌘/⌃⇧⌘ arrow pairs re-verified vacant against `command-registry.ts`.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The deck's layout imposer (`tugdeck/src/lib/layout-imposer.ts`) places content cards at slot anchors across the band between the sidebar rails, animating changes through a measured FLIP settle in `tugdeck/src/components/chrome/deck-canvas.tsx`. The system is doctrinally strong where the settle runs, but several geometry paths never enter it (new panes, closing panes, `flushSync` interleavings), the Lens Cards list has no selection model beyond a single cursor, slot moves are absolute-only, overflow is handled only by overlap, and vertical splits exist only for sidebar rails. `roadmap/layout-imposer-brief.md` investigated all five gaps and fixed the order **C → A → B → D → E**; this plan turns that brief into executable steps. The brief's research findings (file paths, symbols, doctrine constraints) are restated here so this document stands alone.

#### Strategy {#strategy}

- **Motion first (Phase C).** Every later phase adds motion paths; they should land on a deck that already keeps the always-animated promise. The cut-detector instrumentation built in C becomes the regression harness for D and E.
- **Selection second (Phase A).** The `LensSelectionStore` and the layout-selection resolver are the shared seam that B's nudge verb and E's split commands act through.
- **Small verb third (Phase B).** The relative nudge is a thin command once A's resolver and batched mutations exist; it also settles the bracket-chord doctrine question.
- **Geometry modes last (Phases D, E).** D's flow mode changes what a slot means (ordinal position vs travel fraction); E's columns extend the slot record. Their data-model shapes are decided together in this plan ([P09], [P11]) so E never reworks D's keys.
- **Laws travel with the steps.** Each step that touches doctrine carries its tuglaws edit in the same commit (chord-tiers residents, list-view-usage matrix, focus-language carve-out, pane-model geometry modes), per the cross-check practice in `tuglaws/tuglaws.md`.
- **Five milestones, five implement calls.** M01=C (steps 1–4), M02=A (steps 5–8), M03=B (steps 9–10), M04=D (steps 11–14), M05=E (steps 15–19).

#### Success Criteria (Measurable) {#success-criteria}

- The cut-census app-test battery (Spec S01) reports zero unexplained cuts across its scripted gesture set: open, close, slot move, width change, rail split flip, tab switch, bullseye enter/exit, rapid retarget (verified by the at-test assertion, not by eye).
- Shift+click, ⌘+click, and shift+arrow build a multi-card selection in the Lens Cards list, visible as the row selection fill; ⌘1..9 and ⌃⌘1..3 then act on every selected card in one animated settle (app-test verified).
- With keyboard focus in the Lens, ⌘1 moves the selected content card(s) — the current silent refusal (deck first responder = the Lens card itself) is gone (app-test verified).
- ⌥⇧⌘[ / ⌥⇧⌘] nudge the selection one slot left/right, clamped as a group, with a visible refusal at the edge (app-test verified).
- In flow mode, no two occupied slots overlap — each slot's extent is its own, so the chain can no longer collide with itself however narrow the deck gets. (Cards *stacked in one slot* still share that slot's anchor and still sit on top of one another; flow changes what a slot's position means, not what a stack is.) Activating a card not fully inside the band slides the deck minimally until it is, animated through the settle (app-test verified).
- A content slot can be split: two cards in one slot share its column vertically with a draggable seam, and ⌃⌘S / ⌃⌘↑ / ⌃⌘↓ / ⌃⇧⌘↑ / ⌃⇧⌘↓ operate the split from the keyboard (app-test verified).
- `cd tugdeck && bunx vite build` clean and `just app-test-changed` green at every phase exit.

#### Scope {#scope}

1. Cut-detector instrumentation, enter/exit motion for panes, and fixes for the timing hazards enumerated in the brief (Phase C).
2. `LensSelectionStore`, the layout-selection resolver, batched multi-card deck mutations, opt-in `TugListView` multi-select, Cards-section wiring, and the two law amendments (Phase A).
3. The `nudge-slot` command pair on ⌥⇧⌘[ / ⌥⇧⌘] with its chord-tiers entry (Phase B).
4. The `layout: "fit" | "flow"` mode, flow geometry, the flow-offset signature term, reveal-on-activation, and the Layouts-section control (Phase D).
5. Slot-keyed column arrangements (`{mode, order, shares}`), the content-side seam machinery, per-slot Layouts rows, stack-badge menu extension, and the E chord family (Phase E).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Trackpad/scroll-wheel panning of the deck in flow mode (deferred — [Q01]).
- Multi-select in any list other than the Lens Cards section.
- Exit animation for whole-deck teardown (window close, HMR reload).
- Any change to the space allocator's scoring; flow only changes which of its tiers can occur.
- Persisting the flow offset across relaunch ([P10] decides session-only).
- Drag-and-drop of cards between split columns (splits are keyboard/menu/seam-operated in this plan; content drag already evicts slots via the existing gesture path).

#### Dependencies / Prerequisites {#dependencies}

- The brief: `roadmap/layout-imposer-brief.md` (rationale and research trail; this plan restates every fact a step needs).
- Existing FLIP settle machinery: `deck-canvas.tsx` (arm subscriber + settle layout effect), `tugdeck/src/lib/pane-flip.ts`.
- Existing rail-split machinery to port in Phase E: `RailArrangement` and its helpers in `layout-imposer.ts`, the `RailSeam` component in `deck-canvas.tsx`.
- `tugutil` on PATH for `plan lint`; `just app-test-*` recipes for verification.

#### Constraints {#constraints}

- **Warnings are errors** across the workspace; tugdeck changes must pass `bunx vite build` (the debug app loads the prod rollup bundle).
- Tuglaws: [L01] one root render; [L02] external state via `useSyncExternalStore` only; [L03] `useLayoutEffect` for registrations events depend on; [L06] appearance through CSS/DOM, never React state; [L13] CSS for declarative motion, TugAnimator for programmatic motion, rAF is not for animation; [L14] Radix Presence owns enter/exit where Radix is in play; [L27] no retained finished animations.
- Animation doctrine (`tuglaws/animation-doctrine.md`): quiet contract [D1] (zero-delta frames get no animation object), residency [D2]/[D3], no per-frame JS style mutation in product surfaces, no multi-stop `linear()` easings (spring rides in sampled keyframe offsets under keyword `linear`), no transitioning `left`/`top`/`width` for layout motion.
- App-tests are selective: every new test carries `@covers` lines; run via `just app-test-changed` / `just app-test <file>`, never a sweep. Background app-tests cannot deliver menu chords; modifier-click gestures may need `foreground: true` or store-layer coverage (see #test-non-goals).
- Persistent UI state goes through tugbank defaults, never Web storage.

#### Assumptions {#assumptions}

- The five phases land in order; a later phase may assume every earlier step's artifacts exist.
- No second track of work rewrites `deck-canvas.tsx` or `layout-imposer.ts` concurrently.
- The chord decisions here ([P07], [P12]) survive review; if review overturns ⌥⇧⌘[/] for ⌃⌘[/], only Step 9's binding constants change.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton anchor and label conventions: explicit kebab-case `{#anchors}` on every cited heading, `#step-N` step anchors, two-digit stable labels (`[P01]`, `[Q01]`, `S01`, `T01`, `R01`, `M01`), `**Depends on:**` lines citing step anchors, and `**References:**` lines citing labels and anchors — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Trackpad panning of the deck in flow mode (DEFERRED) {#q01-flow-trackpad-panning}

**Question:** Should horizontal trackpad scroll pan the deck strip directly in flow mode, in addition to activation-driven reveal?

**Why it matters:** Free panning makes flow feel like a real scroll surface, but it collides with per-card scroll intent arbitration (`tuglaws/scroll-intent.md`) and would give the deck a second offset writer beside activation, complicating the settle-vs-live-scroll story.

**Plan to resolve:** Ship activation-driven reveal first (Phase D). Revisit after living with flow; a follow-on can add panning behind the same `--tug-imposer-flow-offset` property without reworking geometry.

**Resolution:** DEFERRED — revisit after M04 ships; tracked in #roadmap-follow-ons.

#### [Q02] Pane exit treatment shape (DECIDED — see [P02]) {#q02-exit-treatment}

**Question:** A closing pane unmounts in frame 0; what visual treatment covers the exit without fighting React's unmount?

**Resolution:** DECIDED — exit ghost overlay, [P02]. If the ghost proves visually wrong in practice, the fallback recorded in [P02] is to keep exits as cuts and record that as an accepted snap in `tuglaws/animation-doctrine.md`.

#### [Q03] Column member persistence strength (DECIDED — see [P11]) {#q03-column-persistence}

**Question:** Rail arrangements key members by `componentId` (sidebar cards are singletons) and persist across close/reopen ([L23]-style). Content cards are not singletons — what do column arrangements key by, and how much persistence do they promise?

**Resolution:** DECIDED — card-id keys with weaker persistence, [P11].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| New motion paths regress the settle's quiet contract | med | med | Cut-census harness (Step 1) runs in every later phase's checkpoint | Census battery reports a new cut class |
| Modifier-click gestures unverifiable in background app-tests | med | med | Store-layer coverage for selection logic; one `foreground: true` app-test for the real gesture | Foreground tier flakes under contention |
| Flow mode interacts badly with the space allocator | med | low | Flow never overlaps, so the allocator's overlap tier is vacuous; assert allocator output unchanged in fit mode via existing golden | `at0303` imposer-space-allocator app-test drifts |
| Persisted `DeckImposition` grows new fields older builds don't know | low | med | New fields are optional; serialization tolerates absence (same pattern as `rails`) | Deck state fails to restore after relaunch |
| Chord decisions contested at review | low | med | [P07]/[P12] record fallbacks; only binding constants move | Review round overturns a chord |

**Risk R01: Settle regression from enter/exit motion** {#r01-settle-regression}

- **Risk:** The enter/exit treatments (Step 2) add animation objects to frames the settle also animates, violating the one-effect-per-frame clock ([D135] in `tuglaws/design-decisions.md`).
- **Mitigation:** Enter/exit effects use distinct TugAnimator slot keys (`imposer-enter`, `imposer-exit-ghost`) and animate only `opacity` + `transform` on elements the geometry effect does not target (the ghost is a separate element; the enter effect composites over the settled geometry).
- **Residual risk:** A rapid open→retarget inside one settle window can still produce a visible correction; the census test pins the acceptable bound.

**Risk R02: Selection store drifts from deck reality** {#r02-selection-drift}

- **Risk:** Selected card ids can go stale (card closed, moved to another pane, dashed away) leaving the resolver acting on ghosts.
- **Mitigation:** The resolver filters ids against the live registry at read time; the store subscribes to deck changes only to prune (never to grow) its set.
- **Residual risk:** A pruned-to-empty selection silently falls back to first-responder resolution — by design, but worth a diagnostic note in the store.

---

### Design Decisions {#design-decisions}

#### [P01] The cut detector is diagnostics, not product surface (DECIDED) {#p01-cut-detector-diagnostic}

**Decision:** The cut detector is a dev/test-gated observer module (`tugdeck/src/lib/cut-detector.ts`) that samples pane rects per frame **only while explicitly enabled** (app-test surface or dev panel), and ships disabled with zero standing cost.

**Rationale:**
- The animation doctrine bans per-frame JS style *mutation* in product surfaces and reserves per-frame *measurement* for bench probes; a gated diagnostic is a bench probe.
- The quiet contract [D1] demands zero standing timers at rest — the detector must not exist unless armed.

**Implications:**
- Enabled via the test surface (`tugdeck/src/test-surface.ts`) and the dev panel (`tugDevLogStore`), never by default.
- It reads `getBoundingClientRect()` and `el.getAnimations()` per armed frame; it never writes styles.
- Findings are reported as structured records (paneId, frame delta px, running-animation count) the app-test asserts over.

#### [P02] Enter is fade+rise in the settle window; exit is a ghost (DECIDED) {#p02-enter-exit-treatments}

**Decision:** A newly mounted imposed pane plays an enter effect (opacity 0→1 plus a small translateY rise, ~8px, at its final geometry) through TugAnimator in the same settle window; a closing pane leaves a **ghost** — a position-fixed snapshot element appended to the frames container, playing opacity 1→0 for the settle duration, then removed.

**Rationale:**
- The settle skips frames with no First rect (a new pane has none), so enter motion must be authored, not derived.
- React unmounts the closing pane synchronously; only an element outside the pane's React subtree can outlive it. [L14] does not apply — panes are not Radix Presence surfaces.
- Opacity is exempt from the compositor-residency concern; the ghost never animates layout properties.

**Implications:**
- The ghost captures the pane's rect in the close path before unmount — the close is dispatched as `store.handlePaneClosed(stackState.id)` from `deck-canvas.tsx`, and the capture happens at that dispatch site while the frame still exists. It renders a plain styled div (background token fill + border radius), not a live DOM clone, to keep cost and correctness trivial.
- Enter/exit use TugAnimator slot keys `imposer-enter` / `imposer-exit-ghost`, `fill: "none"`, and self-remove on finish ([L27], [D6]).
- Fallback if the ghost reads wrong in practice: delete it and record closes as an accepted snap in `tuglaws/animation-doctrine.md` (see [Q02]).

#### [P03] "The layout selection" is a resolver: selection store first, first responder fallback (DECIDED) {#p03-layout-selection-resolver}

**Decision:** Layout verbs (slot assign, width, nudge, split commands) resolve their target through one function, `resolveLayoutSelection()`: if the `LensSelectionStore` holds a non-empty, live selection, it returns those card ids (ordered); otherwise it returns the deck's first responder card (`DeckManager.getFirstResponderCardId()`), or none.

**Rationale:**
- Today ⌘1 reads only the first responder, and with keyboard focus in the Lens the first responder *is* the Lens card (a sidebar card), so the `MOVE_TO_SLOT` handler in `deck-canvas.tsx` silently refuses — the resolver fixes A's headline bug and gives B and E their target semantics for free.
- One seam keeps "what does a layout verb act on" answerable in one place.

**Implications:**
- "Live" means: the Lens is open and its Cards list holds key view, **or** the selection was explicitly made and not since cleared — concretely, the store carries the set and clears it on deck-level activation gestures that contradict it (activating a card outside the selection collapses the set to that card).
- The resolver filters ids against the card registry at read time (see Risk R02).
- Single-card behavior today is the degenerate case; no behavior change when the selection is empty.

#### [P04] Multi-card mutations are single DeckManager commits (DECIDED) {#p04-batched-commits}

**Decision:** New batched mutators — `assignCardsToSlots(entries: {cardId, slot}[])` and `setCardWidths(cardIds, preset)` — apply all geometry in **one** commit/notify, mirroring `setContentWidth`'s deliberate one-commit shape.

**Rationale:**
- The FLIP settle re-arms per notify; per-card commits re-measure First mid-flight and break the motion. `setContentWidth` (`deck-manager.ts`) was rebuilt as one commit for exactly this reason and documents it.

**Implications:**
- `assignCardsToSlots` performs raise (z-order) work in its own preceding commit exactly as `assignCardToSlot` does today (raise arms nothing — the signature is z-blind), then all slot writes in one geometry commit.
- The single-card paths delegate to the batched ones (a one-element batch), so there is one implementation.
- Group refusal semantics live here: an entry set that violates clamping as a group is refused whole ([P08]).

#### [P05] Multi-select is an opt-in TugListView capability, with two law amendments (DECIDED) {#p05-listview-multiselect}

**Decision:** `TugListView` grows an opt-in multi-select mode (consumer-owned: the host supplies the selected-id set and receives selection intents), rendered as the primitive's own `data-selected` fill on every member row; `tuglaws/list-view-usage.md`'s selection-ownership matrix gains this as a named fifth intent, and `tuglaws/focus-language.md`'s "arrows never select" gains the carve-out: **a bare arrow never selects; a modifier-extended arrow is a selection gesture**.

**Rationale:**
- The matrix says "do not invent a third path" — so the path must be added to the matrix, not bolted on beside it.
- `focus-language.md` already anticipates multi-select: the focus ring is offset outside the item precisely so multi-select needs no extra checkmark.
- Selection state is consumer-owned (the `LensSelectionStore`) because the selection outlives the list's mount and other surfaces (deck handlers) read it — the list is a view of it, per [L02].

**Implications:**
- Pointer path: shift/⌘ facts come from the gesture record (`gesture-interpreter.ts` already records `metaKey`/`shiftKey`) read in `TugListView`'s pointerdown callback — selection commits at pointerdown, never at click (`focus-language.md` pointer doctrine).
- Keyboard path: the backstop key handler in `tug-list-view.tsx` currently returns early on any `metaKey || ctrlKey`; it learns shift+Arrow/Home/End as anchor-ranged selection extension. The spatial cursor handle (which never sees the KeyboardEvent) is untouched — extension rides the backstop, movement rides the handle.
- Anchor semantics: shift+click and shift+arrow extend from the anchor (last non-shift pick); ⌘+click toggles membership and moves the anchor.
- Only member rows (`role === "cell"`, excluding group headers) are selectable; the Cards inventory row in `list-view-usage.md` updates from "none, cursor only".

#### [P06] In the Cards list, select and activate decouple (DECIDED) {#p06-select-vs-activate}

**Decision:** A plain click keeps today's behavior (select + front the card, selection collapses to one). ⌘+click and shift+click modify the selection **without** dispatching `focus-session-card` — the deck does not raise or re-front while a multi-selection is being built. Enter/Space on the cursor row still activates.

**Rationale:**
- Building a selection by clicking would otherwise front every card touched, thrashing z-order and (in flow mode later) scrolling the deck.
- Matches every native multi-select list (Finder, Mail): modifier clicks are selection edits, not open gestures.

**Implications:**
- The Cards delegate's `onSelect` splits: modifier-classified gestures route to the `LensSelectionStore`; plain ones keep the activate path.
- Activating a card outside the current selection (any surface) collapses the selection to that card ([P03] liveness rule).

#### [P07] The nudge chord is ⌥⇧⌘[ / ⌥⇧⌘], read as the ⌥-variant of the lateral ring (DECIDED) {#p07-nudge-chord}

**Decision:** `nudge-slot:left` / `nudge-slot:right` bind ⌥⇧⌘[ and ⌥⇧⌘], deliberately unpromoted to any menu (the same [Q02]-comment pattern as ⌘1..9 in `command-registry.ts`), with a residents entry added to `tuglaws/chord-tiers.md` recording the R1 reading.

**Confirmed at Step 9, and the fallback stays unspent.** The chord was briefly moved to ⌃⌘[/] on a misreading — a page-level `keydown` probe showed no ⌥⇧⌘ bracket press arriving, which was taken for an AppKit key-equivalent claim by the promoted ⌥⌘[/] neighbours. The probe could not have shown otherwise: a matched chord is consumed with `stopImmediatePropagation`, so a handled chord and a swallowed one read identically. The real fault was a missing `CommandEntry` for `nudge-slot-selection`, which broke the verb under *either* chord. With that fixed, ⌥⇧⌘[/] drive the deck in the real app (`at0452`).

**Rationale:**
- Mechanically free: the only bracket chords in the codebase are ⇧⌘[/] (lateral card ring) and ⌥⌘[/] (stack ring); plain ⌘[/] is pool-reserved for back/forward; ⌥⇧⌘ brackets are unclaimed by Tug, macOS, and WebKit.
- Doctrinal reading: ⇧⌘[/] moves *attention* laterally across the cards; the ⌥ operator means "same verb, altered object" — ⌥⇧⌘[/] moves *the card itself* laterally. Same keys, same axis, altered object.
- Fallback recorded: if review rejects the R1 reading, ⌃⌘[/] (Tug layout tier, brackets free there) is the alternative; only the binding constants change.

**Implications:**
- Unpromoted means no Swift menu item and no `codeToKeyEquivalent` asymmetry (which would render ⌥⌘{ / ⌥⌘}).
- The chord-tiers residents table gains the pair with its reading, in the same commit as the binding (laws travel with steps).
- Verify a new chord by pressing it and watching the deck, never by a page-level `keydown` probe: a matched chord is consumed with `stopImmediatePropagation`, so such a probe reports a working chord and a swallowed one identically. Applies to Step 18's split family too.

#### [P08] Nudges clamp as a group and refuse visibly (DECIDED) {#p08-group-clamp}

**Decision:** A nudge moves every card in the layout selection by ±1 slot; if **any** member is already at the edge in the travel direction, the whole nudge refuses, preserving the selection's relative arrangement. Refusal is visible: the edge-blocked pane's border flashes (`flashPaneBorder`, the existing slot-landing treatment).

**Rationale:**
- Per-card clamping would silently compress the selection against the edge, destroying the arrangement the user is trying to move.
- Errors never fail silently — a refused gesture produces the act or a visible reason.

**Implications:**
- The clamp check lives in `assignCardsToSlots` ([P04]) so every caller gets it.
- Success flashes nothing extra (the settle's motion is the feedback); refusal flashes the blocking pane.

#### [P09] Flow is a mode bit on DeckImposition; slots become ordinal (DECIDED) {#p09-flow-mode-bit}

**Decision:** `DeckImposition` gains `layout?: "fit" | "flow"` (absent = `"fit"`, no migration needed). In flow, slot k's left edge is the running sum of the widths (plus `IMPOSITION_GAP_PX`) of slots 0..k−1 — ordinal position in a strip — instead of the travel-fraction anchor. `kind` (N-up) survives as the slot vocabulary (⌘1..9 range, Layouts miniature) but no longer determines geometry in flow.

**Rationale:**
- The record already persists `kind`/`contentWidth`/`sidebars`/`rails` as optional fields; one more optional field follows the established shape.
- Ordinal geometry is the definition of "never overlap": each slot's extent is its occupant's width.
- Keeping `kind` preserves every existing entry point (⌘1..9, miniature, Layouts picker) without a vocabulary fork.

**Implications:**
- Pure functions in `layout-imposer.ts` compute flow lefts from the occupied-slot list; golden-tested like the allocator.
- A slot with multiple stacked panes contributes the width of its widest member (and in Phase E, a split column contributes its column width). Those stacked panes still share the slot's anchor — flow removes collisions *between* slots, not *within* one.
- **Flow costs the placement invariant, deliberately.** `ImposedPlacement`'s doc states that a placement is a pure function of the kind and the pane's own slot, "so no pane can be resolved only from a vantage point that sees them all" — which is exactly what a running sum over occupied slots requires. Flow accepts that trade and pays it in one place: the strip is resolved in the deck-canvas placements memo, once per commit, and handed to `imposeStyle`. The invariant survives for fit, which is the mode it was written to protect.
- **The space allocator degenerates in flow rather than being changed.** Every flow seam is the imposition gap by construction, so the allocator's lexicographic key collapses to its last term and the answer is each rail's preferred width — the same shortcut `allocateSidebarWidths` already takes for a chain with no seam, and for the same stated reason. No new tier, no new scoring, and `imposeRect`/`seamPicture` stay fit-only because nothing reaches them in flow.
- `pane-model.md` gains flow as a documented geometry mode.

#### [P10] The flow offset is activation-derived, session-only, and a signature term (DECIDED) {#p10-flow-offset}

**Decision:** The deck's flow offset is state on `DeckManager` (not persisted; starts at 0 each session), written only by the reveal rule — on activation in flow mode, compute the minimal offset change that brings the active card fully inside the band (`scrollRectToVisible` semantics) — and applied to the DOM as one custom property, `--tug-imposer-flow-offset`, folded as a subtraction term into `imposeStyle`'s single `left` calc. The offset (rounded px) becomes a term in `arrangementSignature`.

**Rationale:**
- `imposeStyle` already emits exactly one `left` expression per pane; one more `var()` term keeps window resize pure-CSS.
- Activation is deliberately z-blind in the signature; a distinct offset term lets reveal animate through the existing settle without un-blinding z.
- Session-only persistence: the offset is derivable (re-activating any card re-reveals it); persisting it buys nothing and risks restoring a stale viewport.

**Implications:**
- `activateCard` gains its first geometry consequence, but only via the offset term — the z-order commit itself still arms nothing when the offset doesn't change.
- **The mode bit is a signature term too, not just the offset.** A fit↔flow toggle moves every pane's `left` while every existing term — kind, slots, widths, rails, bullseye — holds still, and at offset 0 the offset term does not move either. Without `imposition.layout` in `arrangementSignature`, the toggle arms no settle and cuts.
- Window resize in flow is answered in **CSS**, like fit's: the offset's clamp is written as a `min()`/`max()` over the strip width and the band, both available as expressions the browser re-resolves on every reflow. The settled-resize retune still runs, but only to write the store's offset back inside the new bounds — it is a bookkeeping moment, not the thing that keeps the picture correct.
- Bullseye is unchanged **for the bullseyed pane** — it supersedes the mode, stays centred one-up, takes no offset. Its exit choreography is not unchanged: the line the other panes sort around is resolved through `imposeStyle().left`, so on a flow deck that line has to be the flow left or panes cross on their way off-canvas.

#### [P11] Columns mirror rails: slot-keyed `{mode, order, shares}` with card-id members (DECIDED) {#p11-columns-mirror-rails}

**Decision:** Content splits are recorded as `DeckImposition.columns?: Record<number, ColumnArrangement>` — keyed by slot index — where `ColumnArrangement` has the exact `RailArrangement` shape (`mode?: "stack" | "split"`, `order?: string[]`, `shares?: Record<string, number>`), with members keyed by **card id** (content cards are not singletons, unlike sidebar cards keyed by componentId).

**Rationale:**
- `slotStackByPaneId` in `deck-canvas.tsx` already treats a rail and a slot as the same kind of "place"; the record extension follows the abstraction the code already names.
- Reusing the arrangement shape lets the seam math, the seam component, and the split/stack choreography port rather than fork. `railSeamFractions` and `railSharesFromFractions` take the arrangement's parts rather than a side, so they are already place-agnostic and callable as they stand; `railWeightOf` is module-private and is the one helper a column caller has to reach (see #step-15).

**Implications:**
- Persistence is weaker than rails: card ids die with their cards, so a column's `order`/`shares` entries for closed cards are inert residue (harmless, [L23]-style never-cleaned) but do not restore across a card's close/reopen. This is accepted ([Q03]).
- Seam custom properties generalize from side-keyed to place-keyed: `--tug-slot-<k>-seam-<j>` beside `--tug-rail-<side>-seam-<j>`.
- Layout-tree invariant 6 (a sidebar pane carries no slot) stands; a new invariant asserts a column's `order` members, when present, are cards in panes assigned to that slot.
- In flow mode ([P09]) a split column contributes one width to the strip: the widest member's pane width.

#### [P12] The split chord family: ⌃⌘S, ⌃⌘↑/↓, ⌃⇧⌘↑/↓ (DECIDED) {#p12-split-chords}

**Decision:** `toggle-column-split` binds ⌃⌘S (split/stack for the slot holding the layout selection's card, or the first responder's slot). `move-in-column:up/down` bind ⌃⌘↑ / ⌃⌘↓. `move-in-column:top/bottom` bind ⌃⇧⌘↑ / ⌃⇧⌘↓.

**Rationale:**
- ⌃⌘ is Tug's layout vocabulary tier; letter S is unoccupied there (verified: only ⌘S and ⇧⌘S exist on KeyS) and mnemonic for split.
- Arrows are R1-exempt (rule R2 in `chord-tiers.md`); ⌃⌘ arrows are unbound in Tug and absent from the macOS never-bind list (which reserves plain ⌃-arrows, not ⌃⌘).
- ⌃⇧⌘ is the counterpart set of a ⌃⌘ base — top/bottom is the ⇧-extreme of up/down, exactly the ⌥⇧⌘↑/↓ First/Last Turn pattern one tier over.

**Implications:**
- All five get chord-tiers residents entries in the same commit as the bindings.
- In a stacked (unsplit) column, ⌃⌘↑/↓ are the natural promote/demote within the stack's z-order — decided here as in-scope so the chords are never dead on an unsplit slot.

---

### Deep Dives {#deep-dives}

#### The ground: how geometry and motion work today {#ground-today}

Facts a cold implementer needs, verified against the tree at authoring time.

**Geometry.** `layout-imposer.ts` is pure: a slot is a position anchor — `offset = travelFraction(slot, count) × max(0, band − width)`, band = canvas minus rail insets minus `IMPOSITION_GAP_PX` (5) each side; `IMPOSITION_GAP_BOTTOM_PX` = 32. `imposeStyle(placement, slotWidth, pinnedFrame?)` emits one inline `left` calc (never `right`) plus `width`, `top`, `bottom`; `imposeSidebarStyle(side, paneWidth, {member?})` emits a rail-mixed `left` and, for split rails, member pins over `--tug-rail-<side>-seam-<j>` custom properties. Width presets `CONTENT_WIDTH_SLIM_PX`/`COMFY`/`WIDE` = 675/800/1230. Overflow overlaps by design; nothing scrolls (`layout-tree.ts` states "the deck does not scroll"). The space allocator (`allocateSidebarWidths`) flexes only rail widths, scored lexicographically `[worstOverlap, worstShortfall, worstError, preferred-distance]`.

**State.** All layout state lives in `DeckManager` (`deck-manager.ts`), published via `useSyncExternalStore` through `IDeckManagerStore`. Per-pane: `TugPaneState.slot?`, `widthPreset?`. Deck-wide: `DeckState.imposition: DeckImposition { kind?, contentWidth?, sidebars, rails? }`. `assignCardToSlot(cardId, slot)` raises first in its own commit, then writes geometry in one commit via `_commitImposition`. `getFirstResponderCardId()` = active pane's active card. `setContentWidth` is deliberately one commit — its doc comment records that per-pane notification broke the settle.

**Motion.** No CSS transitions on pane geometry (`tug-pane.css` documents this). `arrangementSignature(state)` in `deck-canvas.tsx` — terms: imposition record, slot↔pane map, rail widths/modes/seams, per-pane width; deliberately z-blind, height-blind, free-position-blind. A store subscriber (`arm`) measures First rects pre-commit, cancels stragglers `snap-to-end`, sets `data-imposer-settling` + `--tugx-imposer-settle-duration` (`IMPOSITION_SETTLE_MS` = 300); a `useLayoutEffect` keyed on the signature measures Last and plays one WAAPI effect per moved frame via TugAnimator (slot key `imposer-flip`): `translate` (+`scaleX` under 20% distortion — [D135]), real `width`/`height` keyframes otherwise; spring rides in 32 sampled keyframe offsets under keyword `linear` easing (`pane-flip.ts`). Frames with `data-gesture` are skipped. New frames (no First rect) are skipped — the enter cut. TugAnimator `commitStyles()` + `cancel()` on finish; `clearFlip` strips inline transform residue.

**Selection.** The Cards section (`tugdeck/src/components/lens/sections/cards-section.tsx`) is a `TugListView` over `LensCardsDataSource` (`cards-data-source.ts`) with no selection props: one internal scalar `selectedIndex`, one cursor ref, and a module-level `lastSelectedRowId` used only to re-seed the cursor. The delegate's `onSelect` **is** `activate` — it dispatches `focus-session-card`. The backstop key handler bails on any meta/ctrl modifier. `gesture-interpreter.ts` already records `metaKey`/`shiftKey` in the gesture record and is the sole owner of pointer classification.

**Rail splits.** `RailArrangement { mode?, order?, shares? }` at `imposition.rails[side]`; helpers `effectiveRailOrder`, `railModeOf`, `railSeamFractions`, `railSharesFromFractions`, `railWeightOf`, `railMemberPins` in `layout-imposer.ts`; seam properties written by a `useLayoutEffect` in `deck-canvas.tsx` (declared before the settle's Last effect — order load-bearing); the `RailSeam` component owns the pointer drag (rAF property write, commit via `railSharesFromFractions` → `setRailShares`); split/stack flip choreography: z-frontmost member moves with a real height term, other members fade and hold.

#### The cut census: enumerated classes {#cut-census-classes}

From the brief's research; the detector (Step 1) verifies which remain after fixes.

Structural: (1) new pane snaps (no First rect); (2) closing pane cuts at unmount; (3) `data-gesture` frames snap when a commit lands the same tick a gesture ends; (4) signature blind spots — height, free-pane position; (5) non-store geometry (theme swap, chrome-tier attributes) snaps — **accepted**, recorded in doctrine (Step 4); (6) the settled-resize retune re-arranges 200ms after the hand stops — accepted for now, noted in doctrine.

Timing hazards (bugs): (7) `flushSync` inside the notify chain forces DOM to Last geometry before `arm` measures — sites: detach and move-card-to-pane in `deck-manager.ts`, activation transfer in `focus-transfer.ts`; (8) `arm` subscribes in a `useEffect` (post-paint gap on mount); (9) `snap-to-end` → `finish()` → unconditional `commitStyles()` can leave stale inline width/height for a frame on rapid retarget; (10) occlusion controller: hides ride a 400ms timer that checks animations only on the frame element; reveals are synchronous — fast raise/hide/reveal can flash; (11) the session-notification hold flushes at settle release — a content pop at settle end (accepted; note in doctrine).

#### Flow geometry {#flow-geometry}

In flow, the occupied slots (ascending index) form a strip: `stripLeft(k) = Σ_{j<k, occupied} (slotExtent(j) + IMPOSITION_GAP_PX)`. `slotExtent(j)` = widest member pane width (Phase E: a split column's widest member). Pane left = `railInsetLeft + IMPOSITION_GAP_PX + stripLeft(k) − flowOffset`. The reveal rule: given the active card's `[stripLeft, stripLeft + extent]` and viewport `[flowOffset, flowOffset + band]`, the minimal new offset clamps so the card's interval is inside the viewport (card wider than band: pin its left edge). Offset is clamped to `[0, max(0, stripWidth − band)]`. All pure functions, unit-tested; the settle animates offset changes because the rounded offset is a signature term ([P10]).

---

### Specification {#specification}

**Spec S01: Cut detector record and battery** {#s01-cut-detector}

While armed, the detector samples each `.tug-pane[data-pane-id]` per frame (rAF loop is legal here per [P01]) and emits a record `{paneId, dx, dy, dw, dh, animations, gesture}` whenever a rect changes by more than 2px on any axis between consecutive frames with `el.getAnimations().length === 0` and no `data-gesture`. The battery app-test arms it, drives: card open into a slot, card close, ⌘-digit slot move, width preset change, rail split→stack→split, tab switch within a stack, bullseye enter/exit, and a rapid double slot-move (retarget inside the settle window) — then asserts the record set contains no entries outside the accepted classes (#cut-census-classes items 5, 6, 11).

**Spec S02: LensSelectionStore surface** {#s02-selection-store}

`tugdeck/src/components/lens/lens-selection-store.ts`: external store (subscribe/getSnapshot) holding `{ ids: readonly string[], anchorId: string | null }` (ordered by pick sequence). Mutators: `pickOnly(id)`, `toggle(id)`, `extendTo(id, dataSourceOrder)` (anchor-ranged over the list's current visible order), `clear()`, `pruneTo(liveIds)`. Read by `resolveLayoutSelection()` and the Cards section; written only by Cards-section gestures and the collapse rule ([P03], [P06]).

**Spec S03: Command additions** {#s03-command-additions}

| Command id | Chord | Routing | Handler | Phase |
|---|---|---|---|---|
| `nudge-slot:left` / `nudge-slot:right` | ⌥⇧⌘[ / ⌥⇧⌘] | first-responder | deck canvas responder | B |
| `set-imposition-layout` (`fit`/`flow`) | — (Layouts UI only) | registry | action-dispatch → `DeckManager.setImpositionLayout` | D |
| `toggle-column-split` | ⌃⌘S | first-responder | deck canvas responder | E |
| `move-in-column:up` / `:down` | ⌃⌘↑ / ⌃⌘↓ | first-responder | deck canvas responder | E |
| `move-in-column:top` / `:bottom` | ⌃⇧⌘↑ / ⌃⇧⌘↓ | first-responder | deck canvas responder | E |

All chord entries follow the `command-registry.ts` pattern: `chord({key, meta, alt, shift, ctrl}, {preventDefault: true})`; none are menu-promoted ([P07]; the split family may be menu-promoted later as follow-on work).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Cut-detector records | diagnostics (dev/test only) | module singleton + test-surface accessor | [P01], doctrine bench-probe carve-out |
| Selection set + anchor | structure | `LensSelectionStore` + `useSyncExternalStore` | [L02] |
| Row selected fill | appearance | `data-selected` attribute stamped by TugListView; CSS owns the paint | [L06] |
| Flow mode (`imposition.layout`) | structure | `DeckManager` state, persisted with the imposition record | [L02] |
| Flow offset | structure → appearance | `DeckManager` field → `--tug-imposer-flow-offset` custom property written in the deck-canvas inset effect | [L02], [L06] |
| Column arrangements (`imposition.columns`) | structure | `DeckManager` state, persisted | [L02] |
| Column seam positions | appearance | `--tug-slot-<k>-seam-<j>` custom properties; drag writes property per rAF like `RailSeam` | [L06] |
| Enter/exit motion | programmatic motion | TugAnimator effects, distinct slot keys, self-removing | [L13], [L27] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/cut-detector.ts` | Armed-only per-frame rect sampler emitting cut records ([P01], Spec S01) |
| `tugdeck/src/components/lens/lens-selection-store.ts` | The layout selection store (Spec S02) |
| `tugdeck/src/lib/layout-selection.ts` | `resolveLayoutSelection()` ([P03]) |
| `tests/app-test/at0450-imposer-cut-census.test.ts` | Spec S01 battery (`@covers` deck-canvas, layout-imposer, pane-flip) |
| `tests/app-test/at0451-lens-multiselect.test.ts` | Phase A gestures + batched verbs |
| `tests/app-test/at0452-nudge-slot.test.ts` | Phase B nudge + group clamp |
| `tests/app-test/at0454-flow-mode.test.ts` | Phase D reveal + no-overlap |
| `tests/app-test/at0455-column-split.test.ts` | Phase E splits + chords |

Numbers `at0450+` are placeholders — take the next free numbers at implementation time and keep the slugs. **`at0453` is not skipped by accident**: it was taken after this plan was authored, by `at0453-slot-move-holds-rails.test.ts` (`98fe22fad`), which pins that a card moving between slots does not re-solve the sidebar rails — the fix that follows Phase B's ⌘-digit path. Phase D and E take the next two free numbers instead. Re-check the directory before creating either file; the corpus grows between milestones.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `CutDetector`, `armCutDetector` | class/fn | `tugdeck/src/lib/cut-detector.ts` | [P01]; test-surface exposure in `test-surface.ts` |
| `LensSelectionStore` | class | `lens-selection-store.ts` | Spec S02 |
| `resolveLayoutSelection` | fn | `tugdeck/src/lib/layout-selection.ts` | [P03] |
| `assignCardsToSlots`, `setCardWidths` | method | `tugdeck/src/deck-manager.ts` | [P04]; single-card paths delegate |
| `multiSelect` props (set + intents) | props | `tugdeck/src/components/tugways/tug-list-view.tsx` | [P05] |
| `nudge-slot:left/right` entries | CommandEntry | `tugdeck/src/components/tugways/command-registry.ts` | [P07], Spec S03 |
| `layout?: "fit" \| "flow"` | field | `DeckImposition`, `tugdeck/src/lib/layout-imposer.ts` | [P09] |
| `layout?` on `AllocatorInput` + flow short-circuit | field + branch | `allocateSidebarWidths`, `layout-imposer.ts` | [P09] |
| `flowStripPositions`, `flowRevealOffset` | fn | `tugdeck/src/lib/layout-imposer.ts` | #flow-geometry, pure |
| `setImpositionLayout`, `setFlowOffset` | method | `tugdeck/src/deck-manager.ts` | [P09], [P10] |
| `--tug-imposer-flow-offset` / `--tug-imposer-flow-strip` terms | calc terms | `imposeStyle`, `layout-imposer.ts` | [P10] |
| `ColumnArrangement`, `columns?` | type/field | `layout-imposer.ts` | [P11]; shape-shared with `RailArrangement` |
| `columnSeamProperty`, `columnMemberPins` | fn | `layout-imposer.ts` | generalized from rail equivalents |
| `toggle-column-split`, `move-in-column:*` | CommandEntry | `command-registry.ts` | [P12], Spec S03 |
| `setColumnMode`, `setColumnOrder`, `setColumnShares` | method | `deck-manager.ts` | mirror `setRailMode/Order/Shares` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/animation-doctrine.md`: accepted-snap list (theme swap, chrome tier, retune delay, settle-release content pop) — Step 4.
- [ ] `tuglaws/list-view-usage.md`: matrix fifth intent + Cards inventory row — Step 6.
- [ ] `tuglaws/focus-language.md`: modifier-arrow selection carve-out — Step 6.
- [ ] `tuglaws/chord-tiers.md`: ⌥⇧⌘[/] residents entry (Step 9); ⌃⌘S, ⌃⌘↑/↓, ⌃⇧⌘↑/↓ entries (Step 18).
- [ ] `tuglaws/pane-model.md`: flow geometry mode (Step 13); column splits (Step 17).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun:test)** | Pure imposer geometry: flow positions, reveal offsets, column pins, selection-store logic | `tugdeck/src/lib/__tests__/`, data-in/data-out |
| **Golden** | Flow position sweep beside the existing allocator golden | drift detection on geometry |
| **App-test** | Real gestures, motion, focus, selection fills | everything behavioral; selective via `@covers` |

#### What stays out of tests {#test-non-goals}

- Fake-DOM / RTL render tests — banned; there is no in-process DOM substrate.
- Mock-store assertion tests — banned; `tsc` catches interface drift.
- Real modifier-click keyboard/mouse combinations in **background** app-tests where the harness cannot deliver them — selection *logic* (anchor, toggle, extend, prune) is covered at the store layer in bun:test; one app-test exercises the real gesture path and is marked `foreground: true` only if background NSEvent modifier clicks prove undeliverable during implementation.
- Per-mutator reflexive pins on the new DeckManager methods — integration app-tests cover the real paths.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Phases map to milestones: M01 = steps 1–4, M02 = steps 5–8, M03 = steps 9–10, M04 = steps 11–14, M05 = steps 15–19. Run `/tugplug:dash-implement` once per milestone range.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | C: cut detector + census battery | done | `4dc1d5165` |
| #step-2 | C: pane enter and exit motion | done | `9acdb5c26` |
| #step-3 | C: timing-hazard fixes | done | `37ca7468f` |
| #step-4 | C: integration checkpoint + doctrine notes | done | `1ce2ada5d` |
| #step-5 | A: selection store, resolver, batched mutators | done | `a3ff99a14` |
| #step-6 | A: TugListView multi-select + law amendments | done | `19b1d2873` |
| #step-7 | A: Cards section wiring + command retarget | done | `a4c65b50e` |
| #step-8 | A: integration checkpoint | done | `130bfd289` |
| #step-9 | B: nudge-slot commands + chord doctrine | done | `24b56a61c` |
| #step-10 | B: integration checkpoint | done | `24b56a61c` |
| #step-11 | D: flow geometry + mode bit | done | `129d84e67` |
| #step-12 | D: offset plumbing + reveal-on-activation | done | `e2d9c6b36` |
| #step-13 | D: Layouts UI + pane-model doc | done | `9c4f1973f` |
| #step-14 | D: integration checkpoint | done | `13f7ffeb2` |
| #step-15 | E: column data model | pending | — |
| #step-16 | E: column geometry + seams | pending | — |
| #step-17 | E: column UI + choreography | pending | — |
| #step-18 | E: split chord family | pending | — |
| #step-19 | E: integration checkpoint | pending | — |

#### Step 1: C — cut detector and census battery {#step-1}

**Commit:** `tugdeck(imposer-motion): cut detector diagnostics and the census app-test battery`

**References:** [P01] cut detector is diagnostics, Spec S01, (#cut-census-classes, #ground-today)

**Artifacts:**
- `tugdeck/src/lib/cut-detector.ts`; test-surface accessor in `tugdeck/src/test-surface.ts`; dev-panel arm/disarm via `tugDevLogStore`.
- `tests/app-test/at0450-imposer-cut-census.test.ts` with `@covers` for `deck-canvas.tsx`, `layout-imposer.ts`, `pane-flip.ts`.

**Tasks:**
- [ ] Implement the detector per Spec S01: armed-only rAF sampling of `.tug-pane[data-pane-id]` rects, record on >2px unanimated delta, skip `data-gesture` frames; disarm cancels the loop and drops all state ([P01] quiet contract).
- [ ] Expose `armCutDetector()` / `disarmCutDetector()` / `takeCutRecords()` on the test surface.
- [ ] Write the battery test driving the Spec S01 gesture set; assert records only from accepted classes. At this step the assertion allowlist includes the known defects (enter cut, exit cut, flushSync sites) so the test is green before the fixes; Steps 2–3 shrink the allowlist.

**Tests:**
- [ ] bun:test for the detector's delta/animation classification over synthetic samples (pure logic extracted from the DOM reader).
- [ ] `at0450-imposer-cut-census` runs green with the initial allowlist.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts`

---

#### Step 2: C — pane enter and exit motion {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer-motion): enter fade-rise and exit ghost for imposed panes`

**References:** [P02] enter/exit treatments, Risk R01, [Q02], (#cut-census-classes, #ground-today)

**Artifacts:**
- Enter effect in the settle's Last pass in `deck-canvas.tsx` (frames with no First rect get `imposer-enter` instead of being skipped); exit ghost creation in the pane-close path.

**Tasks:**
- [ ] Enter: in the settle layout effect, a frame with no First rect plays opacity 0→1 + translateY(8px→0) at its final geometry via TugAnimator (slot `imposer-enter`, `fill: "none"`, settle duration), instead of the current silent `continue`. Reduced-motion (`isTugMotionEnabled()` false) skips it, matching the settle's own gate.
- [ ] Exit: capture the closing pane's rect before unmount in the close flow; append a ghost div (fixed-position, pane ground token fill, pane border radius) to the frames container; play opacity 1→0 (slot `imposer-exit-ghost`); remove on finish. Guard: at most one ghost per pane id; deck teardown removes all ghosts.
- [ ] Shrink the census allowlist: enter and exit classes removed.

**Tests:**
- [ ] `at0450` battery: open and close now produce no cut records; ghost element absent after settle (quiet contract).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0294-imposer-flip-settle.test.ts`

---

#### Step 3: C — timing-hazard fixes {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer-motion): measure-before-flush, layout-effect arm, retarget residue, occlusion animation scan`

**References:** [P01] detector as verifier, Risk R01, (#cut-census-classes)

**Artifacts:**
- Fixes for classes 7–10 in #cut-census-classes.

**Tasks:**
- [ ] `flushSync` sites (detach and move-card-to-pane in `deck-manager.ts`, activation transfer in `focus-transfer.ts`): ensure First rects are captured before the synchronous commit — either by having the settle's `arm` subscriber registered ahead of `useSyncExternalStore`'s (subscription-order audit) or by an explicit pre-flush measure hook the mutator calls; pick whichever the audit shows is reliable, and document the choice in a comment at the arm site.
- [ ] Move the `arm` subscription registration from `useEffect` to `useLayoutEffect` in `deck-canvas.tsx` ([L03] — a registration events depend on).
- [ ] Rapid-retarget residue: on `snap-to-end` cancellation inside `arm`, restore held inline `width`/`height`/`opacity` synchronously (invoke the restorer immediately after the cancel) so no frame paints stale baked pixels.
- [ ] Occlusion hides: extend the hide-timer's animation check to consult the settle window (`data-imposer-settling` on the container) in addition to frame-element animations, deferring hides while a settle runs.
- [ ] Shrink the census allowlist accordingly.

**Tests:**
- [ ] `at0450` battery: rapid double slot-move and tab-switch-during-settle produce no cut records.
- [ ] Existing `at0332-pane-occlusion.test.ts` stays green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0332-pane-occlusion.test.ts tests/app-test/at0294-imposer-flip-settle.test.ts`

---

#### Step 4: C — integration checkpoint and doctrine notes {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tuglaws(animation-doctrine): record the accepted snaps; imposer motion census green`

**References:** [P02], Spec S01, Milestone M01, (#success-criteria, #cut-census-classes)

**Artifacts:**
- `tuglaws/animation-doctrine.md` accepted-snap list (classes 5, 6, 11: theme/chrome-attr snaps, retune delay, settle-release content pop).

**Tasks:**
- [ ] Verify the census battery's final allowlist contains only the accepted classes; the doctrine edit names each with its rationale.
- [ ] Run the full changed-derived selection.

**Tests:**
- [ ] `at0450` green with the final allowlist.

**Checkpoint:**
- [ ] `just app-test-changed`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 5: A — selection store, resolver, batched mutators {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(lens-selection): LensSelectionStore, resolveLayoutSelection, batched slot and width mutators`

**References:** [P03] resolver, [P04] batched commits, Spec S02, Risk R02, (#ground-today, #state-zone-mapping)

**Artifacts:**
- `lens-selection-store.ts`, `layout-selection.ts`, `assignCardsToSlots` / `setCardWidths` on `DeckManager`.

**Tasks:**
- [ ] Implement Spec S02, including `pruneTo` wired to a deck subscription that only shrinks the set (Risk R02), and the collapse rule: `activateCard` on a card outside the selection collapses the set to that card ([P03], [P06]).
- [ ] `resolveLayoutSelection()`: live selection ids (registry-filtered) else first-responder card id else empty.
- [ ] `assignCardsToSlots(entries)`: raise commit(s) first (reuse the `assignCardToSlot` raise shape), then one geometry commit for all slot writes; group-refusal hook for [P08] (refuse whole batch when a validator rejects). `assignCardToSlot` delegates to a one-element batch. `setCardWidths(cardIds, preset)` mirrors `setContentWidth`'s one-commit shape for the named panes only.

**Tests:**
- [ ] bun:test: store logic (pickOnly/toggle/extendTo ordering, anchor movement, prune, collapse), resolver fallback ladder.
- [ ] bun:test: batched mutator produces exactly one geometry notify (count notifies via a test subscriber on the real DeckManager — no mocks).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/lens/__tests__ src/lib/__tests__`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 6: A — TugListView multi-select and the law amendments {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(list-view): opt-in multi-select — pointerdown modifiers, shift-arrow extension; amend list-view-usage and focus-language`

**References:** [P05] listview multiselect, (#ground-today, #state-zone-mapping)

**Artifacts:**
- Multi-select props on `TugListView`; `data-selected` stamping for set membership; law edits in `tuglaws/list-view-usage.md` and `tuglaws/focus-language.md`.

**Tasks:**
- [ ] Props: consumer supplies `selectedIds: ReadonlySet<string>` + intent callbacks (`onPick(id)`, `onToggle(id)`, `onExtendTo(id)`); when present, the primitive stamps `data-selected` on every member row whose id is in the set (appearance stays CSS, [L06]).
- [ ] Pointer path: in the pointerdown callback, read the gesture record's `metaKey`/`shiftKey` (from `gesture-interpreter.ts` — never re-derive from the raw event) and route: meta → `onToggle`, shift → `onExtendTo`, plain → `onPick`. Selection still commits at pointerdown; the deferred-click path (armed reorder) carries the same classification.
- [ ] Keyboard path: the backstop handler's meta/ctrl early-return stays; **shift**+ArrowUp/Down/Home/End extends via `onExtendTo` against the cursor's new row. Cursor movement itself is unchanged (the spatial handle never sees the event; extension rides the backstop only, and rule 5b's vertical-only contract is untouched).
- [ ] Only `role === "cell"` member rows participate; group headers are never selectable.
- [ ] Law edits: matrix fifth intent ("consumer-owned multi-select set") with its ownership sentence; Cards inventory row update; focus-language carve-out sentence ("a bare arrow never selects; a modifier-extended arrow is a selection gesture").

**Tests:**
- [ ] bun:test on the extracted classification (gesture record → intent) as pure logic.
- [ ] App-test coverage lands with Step 7's wiring (the primitive alone has no host surface to drive).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-select` names the list-view-covered tests; run the printed selection.

---

#### Step 7: A — Cards section wiring and command retarget {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(lens-selection): Cards multi-select wired; slot and width commands act on the layout selection`

**References:** [P03], [P06] select vs activate, [P04], Spec S02, (#success-criteria)

**Artifacts:**
- Cards section consumes the store + new props; `MOVE_TO_SLOT` / `SET_PANE_WIDTH` handlers in `deck-canvas.tsx` resolve through `resolveLayoutSelection()` and call the batched mutators.

**Tasks:**
- [ ] Cards section: supply `selectedIds` from the store; intent callbacks — plain pick keeps today's activate path (select + front, collapse set), toggle/extend write the store without dispatching `focus-session-card` ([P06]). `lastSelectedRowId` seeding behavior is preserved.
- [ ] Deck canvas: `MOVE_TO_SLOT` maps every resolved content card to the slot (sidebar cards filtered out with the existing guard), via `assignCardsToSlots`; `SET_PANE_WIDTH` resolves the same way into `setCardWidths`. The Lens-focused case now works: the resolver returns the selection even though the first responder is the Lens card.
- [ ] Refusal visibility: an empty resolution or all-sidebar resolution flashes nothing but logs to the dev panel (`tugDevLogStore`) — no silent dead chord ([P08] spirit; full flash treatment arrives with nudge refusals in Step 9).

**Tests:**
- [ ] `at0451-lens-multiselect.test.ts`: build a selection (evalJS-driven store writes for the logic path; real modifier pointerdown for the gesture path if deliverable in background — else mark the gesture case `foreground: true` per #test-non-goals), then ⌘2 → both cards land slot 2 in one settle (assert one geometry notify via the test surface, both panes' `slot`), width chord applies to both.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0451-lens-multiselect.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 8: A — integration checkpoint {#step-8}

**Depends on:** #step-7

**Commit:** `N/A (verification only)`

**References:** [P03], [P05], [P06], Milestone M02, (#success-criteria)

**Tasks:**
- [ ] Verify the full A surface end to end: mouse selection, keyboard extension, chord application, collapse-on-activate, prune-on-close.
- [ ] Run the census battery — selection gestures must not have introduced cuts.

**Tests:**
- [ ] `at0451` and `at0450` green together.

**Checkpoint:**
- [ ] `just app-test-changed`

---

#### Step 9: B — nudge-slot commands and chord doctrine {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(nudge-slot): ⌃⌘ bracket nudges over the layout selection; chord-tiers residents entry`

**References:** [P07] nudge chord, [P08] group clamp, [P04], Spec S03, (#ground-today)

**Artifacts:**
- `nudge-slot:left` / `nudge-slot:right` in `command-registry.ts`; handler on the deck canvas responder; `tuglaws/chord-tiers.md` residents entry.

**Tasks:**
- [ ] Command entries per Spec S03 (unpromoted, `preventDefault`, first-responder routing) beside `SLOT_COMMANDS`, with a [Q02]-style comment explaining non-promotion.
- [ ] Handler: resolve via `resolveLayoutSelection()`; compute `slot ± 1` per member; group clamp — any member at the travel edge refuses the whole nudge and flashes the blocking pane (`flashPaneBorder`); otherwise one `assignCardsToSlots` batch. Cards without a current slot (free-floating) are excluded from the batch; if that empties it, refuse.
- [ ] chord-tiers.md: residents entry for ⌥⇧⌘[/] recording the ⌥-variant-of-lateral reading and the ⌃⌘[/] fallback rationale ([P07]).

**Tests:**
- [ ] `at0452-nudge-slot.test.ts`: single card nudges right/left; two-card selection nudges as a unit; edge refusal preserves both slots and flashes; chord reaches the handler with Lens focused.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0452-nudge-slot.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 10: B — integration checkpoint {#step-10}

**Depends on:** #step-9

**Commit:** `N/A (verification only)`

**References:** [P07], [P08], Milestone M03, (#success-criteria)

**Tasks:**
- [ ] Verify nudge against the census battery (nudges are settles; no cuts) and against `at0451` (nudge respects the same selection the digit chords use).

**Tests:**
- [ ] `at0450`, `at0451`, `at0452` green together.

**Checkpoint:**
- [ ] `just app-test-changed`

---

#### Step 11: D — flow geometry and the mode bit {#step-11}

**Depends on:** #step-10

**Commit:** `tugdeck(flow-mode): layout mode bit and pure flow strip geometry`

**References:** [P09] flow mode bit, Spec S03, (#flow-geometry, #ground-today)

**Artifacts:**
- `layout?: "fit" | "flow"` on `DeckImposition`; `flowStripPositions`, `flowRevealOffset` pure functions; `layout` on `AllocatorInput` with the flow short-circuit in `allocateSidebarWidths`; `setImpositionLayout` mutator + `set-imposition-layout` registry action; golden sweep test.

**Tasks:**
- [ ] Extend `DeckImposition` (optional field; serialization tolerates absence — follow the `rails` pattern: `parseRails` in `tugdeck/src/serialization.ts`, and the `isContentWidth`-style guard beside it).
- [ ] Implement #flow-geometry as pure functions beside the allocator; slot extent = widest member pane width.
- [ ] **The allocator degenerates in flow, and the code already names the degeneracy.** In flow every seam is exactly `IMPOSITION_GAP_PX` by construction, independent of the band — so in `solveSidebarWidths`'s linear model every `aⱼ = fⱼ₊₁ − fⱼ` term is zero, `denominator` is zero (it returns `null`, already guarded), and in `seamPicture` every candidate total scores `worstOverlap = worstShortfall = worstError = 0`. The lexicographic key therefore reduces to its last term, `|T − Σ preferred|`, whose minimum is `preferredTotal`. Add `layout` to `AllocatorInput` and take the existing shortcut: in `allocateSidebarWidths`, `const target = input.layout === "flow" || chain.length < 2 ? preferredTotal : chooseRailTotal(…)`. Comment it against the `chain.length < 2` branch's own words — "the answer falls out of the objective, so this is a shortcut, not a special case". **This is why `imposeRect` and `seamPicture` stay fit-only**: `seamPicture` is never reached in flow, and `imposeRect` has no other caller in the tree (verified). Say so in `imposeRect`'s doc comment rather than leaving the twin silently half-true.
- [ ] **Name what flow costs the placement invariant.** `ImposedPlacement`'s doc comment states the property flow breaks: *"There is nothing here about the deck's other panes, because a slot's anchor does not depend on them… a placement is a pure function of the kind and the pane's own slot."* In flow `stripLeft(k)` sums every occupied slot's extent, so a placement can only be resolved from a vantage point that sees them all. Resolve it in **one** place — the placements memo in `deck-canvas.tsx`, which already walks every pane per commit and already raises stored widths to the stack size floor — and pass the resolved strip position down to `imposeStyle` as an argument. `TugPane` must not compute it: a pane that recomputed the strip from a store read would re-derive deck-wide geometry per frame. Amend the `ImposedPlacement` doc in the same commit to state both modes and where each is resolved.
- [ ] `DeckManager.setImpositionLayout(layout)` through `_commitImposition`; registry action wired in `action-dispatch.ts` (Layouts UI is Step 13's door; the action exists first so tests can drive it).
- [ ] Golden: a sweep of occupancy/width configurations → strip positions and reveal offsets, snapshotted beside `golden/imposer-solutions.json`.

**Tests:**
- [ ] bun:test unit + golden for the pure functions (edge cases: empty deck, single card wider than band, gaps from unoccupied slots, offset clamping).
- [ ] bun:test: `allocateSidebarWidths` in flow returns each rail's preferred width for a configuration that in fit would drain a rail to its comfort floor — the assertion that the short-circuit is doing work rather than agreeing by luck.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 12: D — offset plumbing and reveal-on-activation {#step-12}

**Depends on:** #step-11

**Commit:** `tugdeck(flow-mode): flow offset custom property, signature term, reveal on activation`

**References:** [P10] flow offset, [P09], Risk R01, (#flow-geometry, #state-zone-mapping)

**Artifacts:**
- `--tug-imposer-flow-offset` and `--tug-imposer-flow-strip` written in the deck-canvas inset effect; CSS-clamped offset subtraction term in `imposeStyle` (flow only); `flowOffset` on `DeckManager`; `layout` **and** rounded-offset terms in `arrangementSignature`; reveal write on the activation commit; bullseye anchor carve-out.

**Tasks:**
- [ ] `imposeStyle` gains a flow variant of its `left` expression; fit mode's expression is byte-identical to today (assert in a unit test). Property names join the family the same effect already writes (`--tug-imposer-inset-<side>`), hence `--tug-imposer-flow-offset`, not a `--tug-deck-` prefix that exists nowhere else.
- [ ] **Clamp the offset in CSS, not only in JS.** Fit's whole resize story is that the browser re-decides the arrangement on every reflow with no JS in the loop; an offset clamped only at the 200ms settled-resize moment would make flow the one mode that shows a stale viewport — widen the window and the strip stays pushed left with dead air at the right edge until the retune fires. Both quantities needed for the clamp are available to CSS: the strip width is a deck-wide number JS already computed, and the band is the expression `imposeStyle` already writes. So the `left` term is `min(var(--tug-imposer-flow-offset, 0px), max(0px, var(--tug-imposer-flow-strip, 0px) - <band>))`, and a window resize re-resolves it for free. The settled-resize retune still runs, to write the *store's* offset back inside the new bounds so the next reveal computes from a truthful number.
- [ ] Deck canvas writes both properties in the same `useLayoutEffect` that writes the rail insets (before the settle's Last effect — the declaration order there is load-bearing; add the new writes to the existing effect, do not create a second one). **That effect is keyed on a summary string, `railSummary`, not on the values themselves** — extend the summary with the layout mode, the rounded offset, and the strip width, or the writes will not re-run when only the offset moves.
- [ ] **`arrangementSignature` gains `imposition.layout` as its own term, not just the offset.** Toggling fit↔flow moves every pane's `left` while leaving kind, slots, widths, rails, and bullseye identical — on today's terms the signature does not move, no settle arms, and the mode flip is a cut on the one gesture the whole phase exists to introduce. The offset term does not cover it: a toggle at offset 0 changes the signature not at all.
- [ ] Reveal on activation ([P10]): `activateCard` is a pass-through to `_flipFirstResponder` → `_commitStandardFirstResponderFlip`, which is the commit the offset must ride. Compute `flowRevealOffset` there; if it changed, write it in the same commit as the raise so the settle animates the slide; if unchanged, the commit stays z-only and arms nothing. Scope the reveal to a pane that is actually imposed — a rail, a free pane, and a bullseyed pane all activate through this path and none of them ride the strip.
- [ ] **Bullseye's exit-side sort line reads `imposeStyle().left`.** `bullseyeAnchorCentre` in `deck-canvas.tsx` resolves each pane's pre-bullseye anchor through `imposeStyle(placement, pane.size.width).left` and sorts panes around the bullseyed card's own former place so exits can never cross. Fed fit lefts on a flow deck that line lands in the wrong place and panes cross on the way out. [P10]'s "bullseye is unchanged" holds for the bullseyed pane's own geometry (still centred one-up, still offset-free); this anchor is the carve-out, and it takes the flow left.
- [ ] Settled-resize retune clamps the stored offset to the new strip/band bounds.
- [ ] ⌘1..9 in flow: `assignCardsToSlots` unchanged (slots are ordinal); after a slot move, re-run the reveal for the moved card so it never lands out of view.

**Tests:**
- [ ] `at0454-flow-mode.test.ts` (first half): enter flow via the registry action; activate an off-viewport card → minimal slide, animated (no cut records); activate an in-view card → no geometry commit; occupied slots never overlap (pairwise rect check over one pane per slot).
- [ ] The mode toggle itself is a census gesture: arm the detector, toggle fit→flow→fit, assert no cut records. This is the assertion the `layout` signature term exists for, and it fails without it.
- [ ] Resize in flow: with the strip overflowing and the offset at its clamp, widen the canvas and assert the right-hand card's frame stays against the band's right edge *before* the 200ms retune could have fired — the CSS clamp, pinned.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0454-flow-mode.test.ts tests/app-test/at0450-imposer-cut-census.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 13: D — Layouts UI and pane-model doc {#step-13}

**Depends on:** #step-12

**Commit:** `tugdeck(flow-mode): fit/flow control in the Layouts section; pane-model geometry mode doc`

**References:** [P09], Spec S03, (#success-criteria)

**Artifacts:**
- Fit/flow control in `tugdeck/src/components/lens/sections/layouts-section.tsx` (a two-segment `TugChoiceGroup` row beside the N-up picker — every Layouts control is a `TugChoiceGroup` per [L19] and the section's own header doc; never hand-rolled, and not `TugOptionGroup`, which is a multi-toggle); `layout` prop on `LayoutMiniature`; `tuglaws/pane-model.md` flow section.

**Tasks:**
- [ ] Layouts row dispatches `set-imposition-layout`; control state reads the store (settled controls show what the store holds).
- [ ] **Take a rung in the section's focus ladder.** Every row passes `focusGroup={host.focusGroup}` and an explicit `focusOrder`, and the orders are computed, not literal: `LAYOUTS_KIND_FOCUS_ORDER`, `LAYOUTS_WIDTH_FOCUS_ORDER`, then `LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER + index` for the sidebar rows and `+ sidebars.length + index` for the rail rows. The fit/flow row belongs directly under Cards, so it takes its own constant between kind and width and every later row's base shifts by one. A row added without a `focusOrder` is invisible to the keyboard ladder, which is a silent failure, not a visible one.
- [ ] **Give the row preview layers.** The section pre-renders one hidden `LayoutMiniature` layer per offerable option and the hover/cursor handlers only toggle DOM attributes to choose which shows ([L06] — no React state in a preview). A row without layers previews nothing, which reads as a broken control beside four rows that all rehearse. Add `data-preview-axis="layout"` to the row, `previewId: "layout:fit"` / `"layout:flow"` to the items, and the two layers to the layer list.
- [ ] Miniature: `LayoutMiniature` gains `layout?: "fit" | "flow"`. In flow it draws the slots at strip proportions — `slotCount(kind)` cards at the content-width preset, which is what it already normalizes from — and, when the strip exceeds the frame, a viewport window over it. **The window draws at rest (offset 0), always.** The miniature is a plan readout, not an instrument: it states that this arrangement overflows and scrolls, and holds still. A window tracking the live offset would repaint a Lens row on every card activation, and the preview layers would have to draw at 0 regardless, since a hypothetical mode has no offset to track. In fit, unchanged. The component stays props-in/CSS-out with no store reads ([L06]) — the section passes `layout` down like `kind` and `width`.
- [ ] `pane-model.md`: flow as the third content geometry (beside fit and free), with the reveal rule and the ordinal-slot meaning.

**Tests:**
- [ ] `at0454` (second half): toggle the control; miniature reflects mode; mode persists across a Reload (imposition record round-trip).
- [ ] The row answers the keyboard: with the Lens focused, the movement cursor reaches the fit/flow group in ladder order and selects with it.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0454-flow-mode.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 14: D — integration checkpoint {#step-14}

**Depends on:** #step-13

**Commit:** `N/A (verification only)`

**References:** [P09], [P10], Milestone M04, (#success-criteria)

**Tasks:**
- [ ] Full flow pass: mode toggle, reveal, slot moves, nudges (B works in flow), width changes re-reveal, bullseye in flow, census battery in flow mode.
- [ ] Bullseye in flow gets its own look, not just a green test: enter bullseye on the leftmost card of an overflowing strip and watch that no pane crosses another on the way out (the anchor carve-out in #step-12).

**Tests:**
- [ ] `at0450` battery re-run with flow enabled prepended to its gesture set; `at0452` nudge in flow; `at0454` green.

**Checkpoint:**
- [ ] `just app-test-changed`

---

#### Step 15: E — column data model {#step-15}

**Depends on:** #step-14

**Commit:** `tugdeck(column-split): ColumnArrangement record, withers, invariants, mutators`

**References:** [P11] columns mirror rails, [Q03], (#ground-today)

**Artifacts:**
- `ColumnArrangement` type + `columns?` field on `DeckImposition` in `layout-imposer.ts`; withers (`withColumnMode/Order/Shares`); `setColumnMode/Order/Shares` on `DeckManager` (mirroring `setRailMode/Order/Shares`, filtering to cards actually in the slot); layout-tree invariant.

**Tasks:**
- [ ] Type and field, sharing the arrangement helper functions with rails. The good news is that none of the three are side-coupled: `railSeamFractions(order, shares)` and `railSharesFromFractions(order, fractions)` take the arrangement's parts, not a side, so columns can call them as they stand — keep the exported names. `railWeightOf` is **module-private** (no `export`), so a column caller either lives in `layout-imposer.ts` beside it or the helper is exported at that point; [P11] names it as shared math, which it is not yet.
- [ ] New invariant in `layout-tree.ts`: a column's `order` members, when present, name cards in panes assigned to that slot (soft: unknown ids are inert residue, [P11]); invariant 6 untouched.
- [ ] Serialization round-trip (optional field, absence-tolerant).

**Tests:**
- [ ] bun:test: withers, mutator filtering, seam-fraction math over column shapes, serialization round-trip.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__ src/__tests__`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 16: E — column geometry and seams {#step-16}

**Depends on:** #step-15

**Commit:** `tugdeck(column-split): member pins in imposeStyle, slot seam properties, seam drag on content columns`

**References:** [P11], Risk R01, (#ground-today, #state-zone-mapping)

**Artifacts:**
- `imposeStyle` `member` option (mirroring `imposeSidebarStyle`'s — byte-identical output when absent or single-member); `columnSeamProperty`/`columnMemberPins`; seam-writer generalization in the deck-canvas inset effect; `RailSeam` reuse for columns (place-keyed props).

**Tasks:**
- [ ] `imposeStyle(placement, slotWidth, pinnedFrame, {member?})`: vertical pins as `calc()` over `--tug-slot-<k>-seam-<j>` with equal-division fallbacks, first/last members taking the bare gaps — port `railMemberPins` exactly.
- [ ] Deck canvas: write/remove slot seam properties beside the rail ones in the same effect (stale-index removal included); `tug-pane.tsx` builds the member option when the pane's slot has a split column with >1 visible members. The rail sweep clears stale indices up to `SIDEBAR_PANE_ZINDEX_MAX_RANK`; a column needs its own upper bound for the same sweep — a slot has no z-rank ceiling to borrow, so state one (the deepest column the split UI will offer) and remove above it. Extend the effect's `railSummary` dep string with the column terms, exactly as #step-12 extends it with the flow terms; the effect re-runs on that string alone.
- [ ] Seam component: parameterize `RailSeam` by place (side or slot) — same drag, clamp, equalize double-click; commit through `setColumnShares`.
- [ ] Flow interplay: a split column's strip extent is its widest member ([P11], [P09]).

**Tests:**
- [ ] bun:test: `columnMemberPins` output shape; single-member byte-identity with the unsplit frame.
- [ ] `at0455-column-split.test.ts` (first half): split a two-card slot via `setColumnMode` (test surface), both cards visible stacked vertically with the seam; drag the seam; equalize.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0455-column-split.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 17: E — column UI and choreography {#step-17}

**Depends on:** #step-16

**Commit:** `tugdeck(column-split): Layouts slot rows, stack-badge menu, split-flip choreography; pane-model doc`

**References:** [P11], [P02], Risk R01, (#ground-today)

**Artifacts:**
- Per-slot split/stack rows in `layouts-section.tsx` (one row per slot **holding two or more cards**); stack-badge menu extension in `tug-pane.tsx` (`handleArrangeRail` generalizes to places); split↔stack flip choreography for columns (survivor moves with a real height term, others fade — port the rail plan in the settle); `pane-model.md` column section.

**Tasks:**
- [ ] Layouts rows dispatch `SET_COLUMN_MODE`-shaped registry actions (added beside `SET_RAIL_MODE` in `action-dispatch.ts`, with the matching `command-registry.ts` internal entries).
- [ ] **A column row appears only for a slot with two or more cards, and does not mirror the rail rows' always-rendered-but-disabled shape.** The rail rows are always present for a stated reason — a split side dropping to one card would otherwise take the only way to un-split it away with it — and a slot cannot reach that trap, because a one-member column is already unsplit and has nothing to restore. Mirroring anyway would put up to six permanently disabled rows under the two rail rows already there. Rows are keyed and ordered by slot index, so a slot gaining a second card inserts its row in place rather than at the end.
- [ ] Focus ladder: the column rows sit last, so their `focusOrder` base is `LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER + sidebars.length + SIDES.length` (itself already shifted by one for #step-13's fit/flow row), plus the row's own index. Because the row set is now membership-dependent, the ladder is dense over *present* rows rather than over all slots — index the rendered rows, not the slot numbers.
- [ ] Stack-badge menu on a content pane in a multi-card slot offers split/stack/equalize.
- [ ] Choreography: extend the settle's rail-mode fade plan to column-mode flips (the signature already gains column terms via the imposition record; verify and add explicit seam/mode terms if the record term alone is too coarse).
- [ ] `pane-model.md`: columns section beside rails.

**Tests:**
- [ ] `at0455` (second half): flip via the Layouts row and the badge menu; choreography produces no cut records; a slot dropping to one card loses its row, and gaining a second card gets it back at the right rung of the ladder.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0455-column-split.test.ts tests/app-test/at0401-sidebar-split.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 18: E — split chord family {#step-18}

**Depends on:** #step-17

**Commit:** `tugdeck(column-split): ⌃⌘S toggle, ⌃⌘↑↓ and ⌃⇧⌘↑↓ column movement; chord-tiers entries`

**References:** [P12] split chords, [P03], Spec S03, (#success-criteria)

**Artifacts:**
- Five command entries + deck-canvas handlers; chord-tiers residents entries.

**Tasks:**
- [ ] `toggle-column-split` (⌃⌘S): resolve the target slot via `resolveLayoutSelection()`'s first card (else first responder); toggle the column's mode; refuse visibly (dev-panel log + no-op flash) on a single-member slot.
- [ ] `move-in-column:up/down/top/bottom`: reorder the resolved card within its column's `order` (stacked columns: promote/demote in z per [P12]); refusal at the edge flashes the pane.
- [ ] chord-tiers.md residents entries for all five ([P12] rationale).

**Tests:**
- [ ] `at0455` (chords): ⌃⌘S splits and re-stacks; ⌃⌘↓ swaps two members; ⌃⇧⌘↑ from bottom lands top; edge refusal flashes. Chords are delivered via the harness key path (they are not menu chords, so background delivery works; if delivery proves foreground-bound during implementation, follow #test-non-goals).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0455-column-split.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 19: E — integration checkpoint {#step-19}

**Depends on:** #step-18

**Commit:** `N/A (verification only)`

**References:** [P11], [P12], Milestone M05, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full-surface pass: splits in fit and flow, multi-select + nudge + width over split members, census battery with split flips included, sidebar splits unregressed.

**Tests:**
- [ ] `at0450`–`at0455` and `at0401-sidebar-split` green together.

**Checkpoint:**
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The deck's layout system keeps an always-animated promise (verified by a census harness), the Lens Cards section supports multi-card selection that every layout verb acts on, cards nudge relatively by keyboard, the deck offers a non-overlapping flow layout beside fit, and content slots split vertically like sidebar rails — with every chord and law change recorded in the tuglaws.

**Milestone M01: Phase C — always animated (steps 1–4)** {#m01-phase-c}
**Milestone M02: Phase A — multi-select (steps 5–8)** {#m02-phase-a}
**Milestone M03: Phase B — relative nudge (steps 9–10)** {#m03-phase-b}
**Milestone M04: Phase D — flow mode (steps 11–14)** {#m04-phase-d}
**Milestone M05: Phase E — content splits (steps 15–19)** {#m05-phase-e}

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Census battery green with only the doctrine-recorded accepted classes (`at0450`).
- [ ] Multi-select flows and batched verbs green (`at0451`), including the Lens-focused ⌘1 case.
- [ ] Nudge with group clamp green (`at0452`); chord-tiers entry landed.
- [ ] Flow reveal, no-overlap, persistence green (`at0454`); pane-model updated.
- [ ] Column splits, seams, choreography, chords green (`at0455`); sidebar splits unregressed (`at0401`).
- [ ] `cd tugdeck && bunx vite build` clean; `just app-test-changed` green at each milestone.

**Acceptance tests:**
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0451-lens-multiselect.test.ts tests/app-test/at0452-nudge-slot.test.ts tests/app-test/at0454-flow-mode.test.ts tests/app-test/at0455-column-split.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap-follow-ons}

- [ ] Trackpad panning of the flow strip ([Q01]).
- [ ] Menu promotion for the split chord family (Window menu items with rebindable equivalents).
- [ ] Multi-select in other list surfaces (Jots, Overview) using the [P05] capability.
- [ ] Exit-ghost fidelity (live snapshot instead of token fill) if the plain ghost reads wrong.

| Checkpoint | Verification |
|------------|--------------|
| Milestone M01 | Step 4 checkpoint commands |
| Milestone M02 | Step 8 checkpoint commands |
| Milestone M03 | Step 10 checkpoint commands |
| Milestone M04 | Step 14 checkpoint commands |
| Milestone M05 | Step 19 checkpoint commands |
