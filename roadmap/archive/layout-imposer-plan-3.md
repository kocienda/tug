## Flow legibility — a band that ends cleanly, dots that say where you are, a slot you can reach from the card {#flow-legibility}

**Purpose:** Make flow mode legible at rest: the sidebar allocator stops leaving a sliver of a card clipped under the Lens, the corner-parked flow rail becomes a centered row of numbered slot chips, and every masthead-wearing card carries a badge naming the slot it stands in — one you can click to move it.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-21 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-21, opus.** Reviewed `plan:c760f3af5db5545b`. Lint: 0 errors, 1 warning (fixed — this section). Oriented on: the plan as first written, read against `layout-imposer.ts`'s allocator, `imposer-gauges.ts`, `tug-slot*.tsx`, `masthead-frame.css`, and the app-test harness. Applied: **test-plan sanity** — two steps proposed a "render counter" that does not exist; the harness's real mechanism is the motion census (`notifies`) in `tests/app-test/_harness/index.ts`, and both steps now assert `notifies === 0` during a gesture and exactly one at commit, which is stronger as well as real; a third step mis-described `at0450-imposer-cut-census.test.ts` as a store-write census when it is a *visual cut* detector, corrected to the at0458 pattern (read the committed value mid-gesture). **Holes** — the scrub previews by discrete reveal jumps with no animation in the preview path, which the plan asserted as fine without examining it; now [P07] states the choice, Risk R03 names the failure mode, and Step 6 carries a hand evaluation with the continuous-mapping fallback written down. **Plan quality** — Steps 5 and 6 each independently derived "which slots are in the band"; hoisted to one pure `slotsInBand` beside `firstVisibleFlowSlot`, so the committed render and the live projection cannot disagree. **Coherence** — Step 1's checkpoint contained a test asserting "the larger value", which is not falsifiable; replaced with the arithmetic. **Laws** — [L02] honored (every structural read is `useSyncExternalStore`; the badge and the dots both take the deck snapshot); [L03] honored (gauge element *and* listener registrations are layout effects with paired teardown); [L06]/[L22] honored and load-bearing (per-frame chip looks are a DOM projection, never state — this is the plan's central mechanism); [L07] honored (scrub state in refs); [L20] is the one law the design nearly broke, and [P06]/Risk R02 exist because of it — a consumer stamping over `TugSlot`'s `TugButton` emphasis would have had to restate tokens the primitive owns, so the projection was moved inside `TugSlotLayout`; [L13] is the law behind Risk R03, since a preview path has no animator in it. Deferred: [Q01], the slot affordance for cards with no masthead — a placement question with no correct answer until the masthead form has been lived on.

**Round 2 — 2026-08-21, opus.** Reviewed `plan:51fe39b439b81670`. Lint: 0 errors, 0 warnings on entry and on exit. Oriented on: the git diff since round 1 — the plan is tracked and committed, so the diff is `cc048e2ca..HEAD` over the plan plus the two code commits that landed against it — read against `layout-imposer.ts` (the landed `hairlineOf` / `SLIVER_PX` / `flowSeedTotals` / `FLOW_CLIP_SLACK_PX`), `imposer-gauges.ts`'s `publish` and `publishFlowOffset`, `tug-slot.tsx` / `tug-slot-layout.tsx` / `tug-button.tsx`, `deck-canvas.tsx`'s gauge effect and `FlowRail` mount, and the app-test corpus's numbering. Steps 1–3 are `done` and were read but not touched. Applied: **a hole the tree opened after round 1** — M01 landed and the reported sliver survived it, because nothing clipped the flow strip to the band; the clip landed separately as `739415490`, and the plan still named the allocator as the whole cause. Context now carries both causes and says plainly that M01 was right and incomplete, Dependencies names the clip as landed prerequisite, and Step 7's doctrine bullet now records the clip beside the band rule — `tuglaws/pane-model.md` asserts a few paragraphs above that a card clipped at the band edge IS the affordance, which was arithmetic and not pixels until the clip. **Numbering** — the plan claimed `at0460`/`at0461` for its two new tests, but `at0460-text-card-join-replace.test.ts` landed on `main` after the draft and is the corpus's high-water mark; the plan would have manufactured a fresh `at####` collision in the same step that clears an old one. Renumbered throughout to `at0461-flow-dots`, `at0462-card-slot-badge`, `at0463-miniature-live`, with the reason recorded at [P05]. **Round 1's own fixup, half-applied** — two "render counter" verifications survived in Success Criteria and Exit Criteria after round 1 replaced them everywhere else; both are now the harness motion census. **Coherence with the amendment** — two criteria still demanded `stripPicture` be *minimal*, which [P02] as amended explicitly refuses; both restated as the graded rule, and the worked example extended to show the third clean answer grading admits. **A hole in Spec S03** — the spec said `setStates` rewrites a look "in the component's own vocabulary", which is not true of the control form: `TugSlot` paints through `TugButton`'s compound `tug-button-<emphasis>-<role>` class, so a projection inlining that template is Risk R02 moved one level in rather than removed. S03 now states both forms's paint paths and requires the grammar be exported from `tug-button.tsx` as `tugButtonEmphasisClass`; Step 4, Risk R02 and the Symbol Inventory carry it, with a pinned unit test so the extraction cannot drift a class name. Also caught that `TugSlotLayoutHandle` as specified would have silently replaced the shipped `forwardRef<HTMLSpanElement>` contract — the handle now carries `element`. **Cold reader** — Spec S04 now names the payload the listener receives (the property map, key `--gauge-flow-offset`, a fraction of the band at four places) so Step 6's "turn the fraction back into an offset" is a lookup; Step 5 names the control form explicitly, since which `TugSlot` form the dots use decides which paint path Step 4's projection must write. Laws re-checked and unchanged from round 1: [L02], [L03], [L06]/[L22], [L07], [L13], [L20]. Deferred: nothing new; [Q01] stands.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Flow mode shipped in `roadmap/layout-imposer-polish.md` (milestone M04, landed as `093bd879a`). It works, and three things about it read badly on a live deck.

**The band ends in the middle of a card, by a few pixels.** In a four-up slim flow deck with the Lens on the right and Jots/Overview on the left, a hairline of the fourth card peeks out from under the Lens — not a readable slice of a card, a three-pixel stripe. One cause is precise and is in `allocateSidebarWidths` (`tugdeck/src/lib/layout-imposer.ts`, the space-allocator section): **the allocator short-circuits in flow and returns `Σ preferredWidth` without scanning at all.** Its own comment reasons the case out and reaches the wrong conclusion — every seam *between* cards is exactly `IMPOSITION_GAP_PX` in flow by construction, so `worstOverlap`, `worstShortfall` and `worstError` are all structurally zero, and the objective collapses. All of that is true. What it misses is that none of those three terms measures how the strip meets **the band's far edge**, which is the one thing that can go wrong in flow and cannot go wrong in fit (in fit the travel fractions pin every card inside the band). The allocator is not failing at its job; it was never given this one.

**The other cause was found after M01 landed, and is already fixed on `main`.** M01 shipped, the deck was rebuilt, and the sliver did not go away — which is a fact about this plan a cold reader must have, because the plan as first written named the allocator as the whole story. Measurement on the live deck said why: **nothing clipped the flow strip to the band.** The frames container in `deck-canvas.tsx` is `position: absolute; inset: 0` with no `overflow` and no `clip-path`, and flow panes are absolutely-positioned children of it — so a card straddling the band's far edge painted straight past that edge, on under the rail, and out the far side into the 5px margin the rail stands off the window edge. That margin is precisely the region no rail width can ever cover, since the rail's own position reserves it; widening the Lens could not close it, and M01's boundary alignment was invisible because the band's far edge was a number the compositor never enforced. The fix landed as `739415490`: `imposeStyle`'s flow branch now carries a `clip-path: inset(…)` built from the same live `var()` algebra as the offset clamp, with `FLOW_CLIP_SLACK_PX = 32` holding the clip off an uncut card so pane shadows survive, and `at0454-flow-mode.test.ts`'s fifth pinned thing asserts the margin answers background while the straddling card still paints inside the band.

**M01 was right and stays right** — it is what keeps the band from ending on a hairline at all, and the clip is what makes where it ends visible. M02 leans on the clip in one concrete way: the dots' whole claim is which slots the band is showing, and only with the clip in force does what they claim match what paints.

**The flow rail is parked in a corner and states the wrong thing.** `FlowRail` (`tugdeck/src/components/chrome/flow-rail.tsx`) anchors to the band's right end at `min(45% of canvas, 420px)`, hard-stopped short of the bottom-left corner by `STAMP_CLEARANCE_PX = 420` — a number that was *stated* rather than measured, to clear the host's maker-mode build stamps (`tugapp/Sources/MainWindow.swift`'s `setDevInfo`). It draws each occupied slot at its true fraction of the strip, which with four cards at one width preset is four near-identical boxes carrying no information anyone would act on, and a 1px accent-outlined thumb over them. It is a scrollbar for something nobody wants to scroll, in the one place on the canvas the eye never goes.

**A new card in flow opens where you cannot see it.** Already fixed on `main` ahead of this plan: `DeckManager.addCard` took `options?.slot ?? 0`, and in flow slot 0 is routinely scrolled off the left. `firstVisibleFlowSlot` (`layout-imposer.ts`) and `DeckManager._openingSlot()` now answer with the leftmost slot the band is actually showing. That work is **not** part of this plan; it is named here because the dots and the allocator both build on the same geometry and a cold reader will find it in the tree.

There is also a positive discovery that shapes two of the three milestones: **the numbered-chip control this plan needs already exists.** `TugSlot` / `TugSlotLayout` (`tugdeck/src/components/tugways/tug-slot.tsx`, `tug-slot-layout.tsx`) are documented as "one numbered position in a layout, drawn as a small card… a little taller than it is wide, with nearly-squared corners and its number centered," with three resting looks (`rest` / `outlined` / `filled`) and an optional control form that emits through `onSelectSlot`. The Lens already mounts the layout as `SlotPicker` (`tugdeck/src/components/lens/slot-picker.tsx`) on every Cards row. Nothing in this plan authors a numbered chip; both new surfaces compose the existing one.

#### Strategy {#strategy}

- **Fix the geometry before drawing an instrument that reports it.** M01 lands first. The dots are a readout of what the band is showing, and designing them against a band that still slivers would design the sliver into the readout.
- **Give flow its own picture inside the machine that already exists.** The allocator's candidate scan, lexicographic key, comfort tiering and greed-ordered water-fill all stay; flow supplies a different picture function and a different key. No new mechanism.
- **Compose `TugSlotLayout` twice rather than authoring two chip controls.** The canvas dots and the masthead popup are the same component the Lens row already uses, at different sizes with different meanings for the same resting looks.
- **Keep [P11]'s one-offset-path intact across the rail's retirement.** The thumb is the only gesture that dies; chip click and the canvas wheel survive unchanged and a scrub replaces the thumb, still one commit at release.
- **Liveness stays out of React.** Per-frame in-band state reaches the dots through the gauge channel and is projected onto the DOM by the component that owns those nodes — never through a render.
- **Each milestone ends in a checkpoint step that runs the real app**, because every failure this plan is fixing is a failure of the picture, and a picture is not asserted by a unit test.

#### Success Criteria (Measurable) {#success-criteria}

- On a four-up slim flow deck with rails on both edges, the band's far edge never leaves a HAIRLINE of a card — the piece it cuts is either 0px or at least `SLIVER_PX` — whenever the rails' flex range contains such a total ([P02], as amended). Verification: unit assertion over `stripPicture` at the real content-width presets, plus a hand pass on a debug build.
- On a deck that already reads well, the rails do not move at all. Verification: the reference sweep — across 2001 canvas widths of that configuration, the rails move at exactly the widths that carried a hairline and nowhere else.
- The fit allocator's answers are byte-identical to today's for every configuration in the existing golden tables. Verification: `layout-imposer-solutions.test.ts` golden table unchanged (no `IMPOSER_GOLDEN_UPDATE` regeneration on the fit rows).
- The flow dots stand centered in the canvas's bottom band, draw exactly `slotCount(kind)` chips, and never overlap the host's bottom-left build stamps at any canvas width ≥ the deck's minimum. Verification: app-test measuring the dots' box against the canvas box.
- Scrolling the strip by wheel repaints which chips read as on-screen with **zero** React renders of the dots component. Verification: the harness motion census (`notifies`) across a wheel gesture reads 0 while the chips' `data-state` changes — the same mechanism `at0458-miniature-live.test.ts` pins its own liveness with. There is no render counter in the harness; a notify is what a render would have to come from.
- A masthead-wearing card in a multi-slot imposition shows a badge whose digit equals its pane's `slot + 1`, and clicking a chip in the badge's popup moves the card to that slot and raises it. Verification: app-test driving the popup and reading `deckState.panes`.
- The badge is absent under one-up and on sidebar/Lens panes. Verification: app-test assertion on both.

#### Scope {#scope}

1. A flow objective for `allocateSidebarWidths`: `stripPicture`, the flow scoring key, the flow comfort tiering, and the removal of the flow short-circuit.
2. `FlowRail` → `FlowDots`: centered, `TugSlotLayout`-composed, two registers, chip click + scrub, thumb retired.
3. A gauge-channel listener registration, so an instrument can derive a discrete state per frame without a render.
4. An imperative resting-look handle on `TugSlotLayout`, so per-frame state is projected by the component that owns the nodes.
5. `CardSlotBadge`: the masthead's numbered slot chip and its slot popup, mounted through `masthead-frame.css` in both masthead components.
6. Doctrine: the flow paragraphs in `tuglaws/pane-model.md` rewritten for the dots and the band rule.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The fit allocator's objective, tiers, or golden answers. M01 must leave every fit configuration numerically unchanged.
- A slot badge on cards with a plain one-line title bar. The badge lives in the dead leading column under a masthead's phase dot; a one-line title bar has no such column, and inventing a place for it there is a different design question.
- A vertical dots twin for overflowing columns. The same pattern down the y axis is a follow-on, as it was for the rail.
- Momentum or deceleration physics on the wheel gesture.
- Re-opening `firstVisibleFlowSlot` / `_openingSlot`, landed on `main` before this plan.
- Renumbering the 17 pre-existing duplicate `at####` numbers in the corpus. This plan renumbers only the two its own predecessor introduced.

#### Dependencies / Prerequisites {#dependencies}

- The gauge channel ([P08] of `roadmap/layout-imposer-polish.md`), `tugdeck/src/lib/imposer-gauges.ts` — present.
- `TugSlot` / `TugSlotLayout` and their CSS — present.
- `TugPopover` / `TugPopoverTrigger` / `TugPopoverContent` — present. `TugPopoverTrigger` composes the child's ref through `composeRefs` (`tugdeck/src/components/tugways/compose-refs.ts`) as of the fix landed on `main`; a trigger that overwrote the child's ref would silently cost the popup's chips their keyboard cursor.
- The `assign-slot` action, registered in `tugdeck/src/action-dispatch.ts` and routed through `command-registry.ts`, backed by `DeckManager.assignCardToSlot`.
- `firstVisibleFlowSlot` in `layout-imposer.ts`, landed on `main`.
- **The flow clip** — `FLOW_CLIP_SLACK_PX` and the `clip-path` in `imposeStyle`'s flow branch (`layout-imposer.ts`), landed on `main` as `739415490`. M02 states which slots the band is showing; without the clip, a straddling card paints outside the band and the statement is false in pixels. Not re-opened here (#context).

#### Constraints {#constraints}

- Tugdeck laws: one `root.render()` [L01]; external state through `useSyncExternalStore` [L02]; registrations in layout effects [L03]; appearance through CSS and DOM, never React state [L06]; live reads through refs [L07]; token sovereignty — a consumer never repaints a composed component's tokens [L20]; DOM-projected cursors/states [L22].
- The gauge channel's contract: **every published value is a unitless fraction**, because CSS cannot divide a length by a length.
- Verify tugdeck changes with `cd tugdeck && bunx vite build` — the debug app loads the production rollup bundle.
- App-tests are selective. `just app-test-changed` derives the run from `@covers`; every new test file must carry a `@covers` header or `just app-test-covers-check` fails.
- No `localStorage`; persistent state goes through tugbank.

#### Assumptions {#assumptions}

- Flow is a mode bit over a fixed-slot kind: `slotCount` returns 1–6 and never more, so a dot row is at most six chips and can never grow into the host's stamp corner when centered. Confirmed by reading `slotCount` and `clampSlot`.
- In the common case every card in the strip stands at one content-width preset, so the strip has a uniform stride and a band that ends on a boundary at offset 0 ends on a boundary at every *revealed* offset. See [P03].
- The host's build stamps are maker-mode only (`tugapp/Sources/AppDelegate.swift`), drawn 8px from the bottom-left. Centering the dots removes the clearance question rather than re-answering it.
- `_flowBandWidth` in `deck-manager.ts` and `resolveSpan` in `layout-imposer.ts` agree by construction: the band is `resolveSpan(canvas, rails).width − 2 × IMPOSITION_GAP_PX`. M01 derives the band the same way rather than restating it.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where a slot badge goes on a card with no masthead (DEFERRED) {#q01-badge-without-masthead}

**Question:** Cards wearing a plain one-line title bar get no slot badge under this plan. Should they have one, and where?

**Why it matters:** The badge is the first pointer path to slot assignment from the card itself. Restricting it to masthead-wearing cards makes the affordance inconsistent across card families.

**Options (if known):**
- Leading edge of the one-line title bar, before the title — competes with the title's own inset.
- In the pane's trailing control cluster, as another chrome button — changes it from a readout into a button.
- Leave it masthead-only.

**Plan to resolve:** Live on the masthead form first. The badge's value as a readout is the open part; if it proves load-bearing, the title-bar placement is a separate design pass with its own geometry question.

**Resolution:** DEFERRED — masthead-only ships here; see [P08].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The flow scan changes a fit answer | high | low | Branch on `impositionLayout(input)` at the score and tier sites only; assert the fit golden table is byte-unchanged | Any fit golden diff |
| Per-frame chip state needs a token override | med | med | `TugSlotLayout` projects its own resting looks through an imperative handle ([P06]); no consumer repaints its tokens | Implementer finds the handle insufficient |
| The scrub fights the canvas's drop-zone drag | med | low | The dots keep the rail's `data-gauge-drag` gate: pointer-events off while a zone drag is live | A drop lands on the dots |
| Rails visibly twitch as the strip scrolls | high | low | The picture is scored at offset 0 only; the rails' answer is not a function of `flowOffset` ([P03]) | Any rail width change during a wheel gesture |
| The scrub's preview jumps read as broken | med | med | Each jump is a full-slot move under the user's own finger ([P07]); hand-evaluated in Step 6 with a continuous mapping as the named fallback (Risk R03) | The hand pass reads it as stutter rather than paging |

**Risk R01: A flow term perturbs the fit allocator** {#r01-fit-perturbation}

- **Risk:** The allocator is one function with one scan; adding a flow key could change a fit answer through a shared code path.
- **Mitigation:**
  - The branch is on `impositionLayout(input)` and lives only inside `scoreRailTotal` and the tier predicate — `chainOf`, `waterFill`, the rounding, and the totality guards are untouched.
  - The fit golden table in `layout-imposer-solutions.test.ts` is asserted **unregenerated**: a fit diff fails the step.
- **Residual risk:** A configuration outside both golden tables could still move; the exhaustive invariant sweep is the net for it.

**Risk R02: The dots' live state needs to override a composed component's paint** {#r02-live-paint-override}

- **Risk:** `TugSlot`'s resting look is a `TugButton` emphasis className. A consumer writing its own live attribute over that would either fail to repaint or repaint by restating tokens the primitive owns — an [L20] violation.
- **Mitigation:**
  - The projection is the primitive's, not the consumer's: `TugSlotLayout` exposes an imperative `setStates` handle that rewrites its own children's resting look ([P06]). The consumer calls it; it never touches a class or a token.
  - The one class it does write that is not its own — the control form's `tug-button-<emphasis>-<role>` — is produced by `tugButtonEmphasisClass`, exported from `tug-button.tsx` for this purpose (Spec S03). Restating that template inside `TugSlotLayout` would be this same risk one level in, which is why the plan names the export rather than leaving the implementer to inline it.
  - The committed render remains the fallback truth, so a dropped frame degrades to the committed picture rather than to a stuck one.
- **Residual risk:** An imperative handle is a second write path into the same nodes as React's render; the ordering rule in Spec S03 is what keeps them from disagreeing.

**Risk R03: The scrub's preview has no animator in it** {#r03-scrub-preview-jumps}

- **Risk:** A scrub previews by committing-in-appearance each crossed chip's *reveal* offset, which is a discrete slot-sized jump. The preview path writes the offset property directly and publishes it; only the final `setFlowOffset` arms the settle. So every intermediate jump is instantaneous, and a fast scrub across four chips is four hard cuts. [L13] puts motion in `TugAnimator`, and there is no animator in a per-frame preview by design.
- **Mitigation:**
  - The jumps are slot-sized and driven by the user's own finger, which is the page-dot idiom rather than a stutter — a paging control is *supposed* to page.
  - Step 6 carries an explicit hand evaluation of exactly this, and names the fallback: map the pointer's travel across the dots row continuously onto the strip offset, as the retired thumb did, and let only the release snap to a slot.
  - The fallback is a change inside `FlowDots` alone. Nothing in the offset path, the clamp, or the commit rule changes with it.
- **Residual risk:** If the continuous mapping is adopted, the dots' equal widths no longer correspond to the strip's real proportions during a scrub — the same untruth the thumb was retired for, confined to the duration of a gesture.

---

### Design Decisions {#design-decisions}

#### [P01] Flow gets its own picture; the allocator stops short-circuiting (DECIDED) {#p01-flow-gets-a-picture}

**Decision:** `allocateSidebarWidths` no longer returns `Σ preferredWidth` immediately in flow. Flow scans candidate rail totals exactly as fit does, scored by a flow-specific picture function `stripPicture` and a flow-specific lexicographic key.

**Rationale:**
- The three fit terms (`worstOverlap`, `worstShortfall`, `worstError`) are structurally zero in flow, which is why the short-circuit was written — and all three measure seams *between* cards. None measures the band's far edge, which is the only failure flow has.
- Fit cannot have this failure at all: `imposeRect`'s travel fractions pin every card inside the band. So the term genuinely belongs to flow and nowhere else.
- The candidate scan, the comfort tiering, the greed-ordered water-fill and the rounding are all mode-agnostic and already correct. Only the *picture* is mode-specific.

**Implications:**
- `impositionLayout(input)` is read at two sites — `scoreRailTotal` and the tier predicate — and nowhere else in the allocator.
- **The short-circuit's threshold is mode-dependent, because the picture is.** This decision first said `chain.length < 2` stays for both modes; the exhaustive sweep refuted it on `one-up` with a single card. Fit scores the seams *between* cards, so one card has nothing to fit — but flow scores the band's far edge, and a lone card wider than the band is cut by that edge exactly as a chain member would be, with narrowing the rails a real repair. So flow's floor is one card and fit's is two.
- Flow's answer degenerates to `Σ preferred` on its own whenever the strip fits the band, because every candidate then scores 0 on the first term and the key reduces to its last. The old behavior survives exactly where it was right.

#### [P02] The flow picture measures the smaller piece the band's far edge cuts (DECIDED) {#p02-sliver-measure}

**Decision:** `stripPicture` returns one number, `worstSliver`: with the strip laid out by `flowStripPositions` and the band's far edge at `B`, it is the smaller of the two pieces `B` cuts a slot into — `min(B − left, left + extent − B)` for the slot containing `B` — and `0` when `B` falls in a gap between slots, on a slot boundary, or past the strip's end.

**AMENDED DURING IMPLEMENTATION.** As first written this decision made the flow key `[worstSliver, |T − Σ preferred|]` — the raw measurement, minimised. That is wrong, and the sweep proved it: **the fit key's first three terms are breakage readings with a rest state at zero**, so on a deck that already reads well the distance-from-preferred term governs and the rails stay where their owner put them. A raw sliver has no rest state — it is nonzero at nearly every candidate total — so it would govern *always*, and the allocator would chase a cut it can only ever shrink. It did: on a two-card wide deck whose nearest boundary sat past the rail ceiling, the Lens was pushed from the 420px its owner set to its 675px maximum, taking a 316px cut down to 61px. Still cut, still not a boundary, and the user's rail gone.

So the score is **graded, not minimised**: `hairlineOf(worstSliver)` is the sliver when `0 < sliver < SLIVER_PX` and `0` otherwise, and the flow key is `[hairlineOf(worstSliver), |T − Σ preferred|]`. A boundary is clean; an honest slice of a card is clean; only the hairline between them is a defect. That restores the rest state the fit key depends on. `SLIVER_PX = 32` is the one tunable in the objective — below it, what shows is a pane's rounded corner and the edge of its shadow rather than any content.

Measured over the reference configuration (four-up slim, rails both edges) across 2001 canvas widths: 155 produced a hairline at the preferred widths, 0 do now, and the rails move at exactly those 155 widths and nowhere else.

**Rationale:**
- `worstSliver = 0` is exactly "the band's far edge lands on a card boundary", which is the picture the user is asking for.
- The measure is symmetric on purpose. A three-pixel stripe of a card *peeking* and a three-pixel stripe *hidden* are equally ugly, and both are three pixels of rail away from clean; a one-sided measure would fix one and chase the other.
- **The grading is what gives the objective a rest state**, which is the property the fit key has and a raw magnitude does not. Without it the term is nonzero almost everywhere, so it outranks the user's own rail widths on every deck rather than only on a broken one.
- A cut card remains a perfectly readable overflow affordance — the doctrine already says so for columns — and the grading states that rather than merely tolerating it: an honest slice scores exactly as well as a boundary, so the allocator has no reason to spend rail width on one.
- The optima are computable rather than searchable, so they are seeded into the scan (`flowSeedTotals`). Grading makes the score spiky — wide clean plateaus, narrow hairline valleys, and boundary optima a single pixel wide — and the 16px coarse stride steps over those. It did, choosing a total 37px further from the user's rail than one it stepped past.

**Implications:**
- One term, not three: flow's key is shorter than fit's. `compareScores` already compares element-wise over equal-length arrays and is never handed one of each.
- The measure needs the band, and the band is `resolveSpan(canvas, railsOf(widths)).width − 2 × IMPOSITION_GAP_PX` — the same derivation `_flowBandWidth` uses in `deck-manager.ts`, taken from `resolveSpan` rather than restated.

#### [P03] The picture is scored at rest, so rail widths never follow the scroll (DECIDED) {#p03-scored-at-rest}

**Decision:** `stripPicture` evaluates the band's far edge at flow offset 0. The allocator never reads `flowOffset`.

**Rationale:**
- Rails whose widths were a function of the live offset would breathe as the strip scrolled — a far worse picture than the sliver being fixed.
- It costs nothing in the common case. When every card stands at one content-width preset the strip has a uniform stride `s = w + gap`, every strip position is a multiple of `s`, and every *revealed* offset is one too (`flowRevealOffset` pins a slot's near edge). The far edge is then at `offset + B ≡ B (mod s)`, so a boundary at rest is a boundary at every revealed offset.
- With irregular widths — mixed presets, or a stack floor raising one slot — the guarantee holds only at rest, which is the same graceful degradation the fit allocator already gives irregular slot occupancy.

**Implications:**
- `AllocatorInput` gains nothing. The allocator's inputs stay `(canvasWidth, kind, layout, occupied, rails, maxRailWidth)`.
- A mid-scroll cut is expected and is not a bug. The success criteria are stated at rest.

#### [P04] Flow's comfort rule is two tiers: clean or cut (DECIDED) {#p04-flow-comfort-tiers}

**Decision:** In flow the tier predicate is `worstSliver === 0` (clean) versus `worstSliver > 0` (cut). Comfort is surrendered — the scan descends below `Σ comfortWidth` — if and only if doing so reaches clean from cut, mirroring fit's rule that comfort is spent to fix a picture and never merely to improve one.

**Rationale:**
- It preserves the existing invariant order verbatim; only the tier function changes with the mode. Hard floors stay inviolable, ceilings still cap, preferences still fill in greed order.
- Two tiers is the honest count: flow has one failure, and it is either present or not.
- Cramping a rail to shave a sliver from 40px to 30px buys the user nothing while costing them a rail they can read — the same argument fit's tier rule already makes.

**Implications:**
- `chooseRailTotal`'s `tierOf` becomes mode-aware; its two-domain search (`bestIn(comfortTotal, ceilingTotal)` then, conditionally, `bestIn(floorTotal, ceilingTotal)`) is unchanged.

#### [P05] The rail becomes flow dots: centered, `TugSlotLayout`-composed, two registers (DECIDED) {#p05-flow-dots}

**Decision:** `FlowRail` is replaced by `FlowDots` (`tugdeck/src/components/chrome/flow-dots.tsx`). It renders a `TugSlotLayout` of exactly `slotCount(kind)` chips, centered horizontally in the canvas's bottom band at the rail's existing 8px inset. A chip reads `outlined` when its slot is in the band right now and `rest` otherwise. No accent, no thumb, no proportional widths.

**Rationale:**
- The proportional drawing carried no actionable information: at one width preset it is N near-identical boxes. Which slots exist and which are on screen is what a reader acts on.
- Centering deletes the stamp problem instead of managing it. At most six chips centered on the canvas cannot reach the bottom-left corner, so `STAMP_CLEARANCE_PX` — a stated, unmeasured 420 — goes, and with it `RAIL_BAND_SHARE` and `RAIL_MAX_WIDTH_PX`.
- `TugSlot` is already the numbered card-shaped chip this needs, already used by the Lens's `SlotPicker`. Authoring a second one would be the exact failure `masthead-frame.css` documents at length about the document masthead.
- Two registers need no accent at all, which is the standing rule for the canvas. The active card is already obvious — it is the focused card on screen — so a third register would spend an accent to restate what the deck is already showing.
- All `slotCount(kind)` chips are drawn, not only the occupied ones, matching `SlotPicker`'s own vocabulary and `TugSlotLayout`'s native `count` rendering. An unoccupied slot is never "in the band" in any useful sense, so it rests.

**Implications:**
- `rest` and `outlined` mean *visibility* here and *stacking* in the Lens. They are appearance names mapped to `TugButton` emphases; each surface states what they mean for it, and the plan says so rather than pretending one meaning covers both.
- `flow-rail.tsx` / `flow-rail.css` are deleted, and the `Files` rows for them in `tuglaws/pane-model.md` are replaced.
- `at0459-flow-rail.test.ts` is rewritten as `at0461-flow-dots.test.ts`, which also clears one of the two `at####` collisions the previous dash introduced. **The numbers are 0461/0462/0463, not 0460 onward:** `at0460-text-card-join-replace.test.ts` landed on `main` after this plan was drafted, and `at0460` is the corpus's current high-water mark — so the first free number is `at0461`. A plan that manufactured a fresh collision while clearing an old one would be worse than leaving both.

#### [P06] Per-frame resting looks are projected by `TugSlotLayout`, driven by a gauge listener (DECIDED) {#p06-live-projection}

**Decision:** The gauge channel gains a listener registration (`registerGaugeListener`) alongside its element registration, and `TugSlotLayout` gains an imperative `setStates` handle exposed through its ref. `FlowDots` subscribes to `flow-offset` as a listener, computes which slots are in the band, and calls `setStates`. React renders the committed picture; the handle carries the motion between commits.

**Rationale:**
- [L06] forbids per-frame appearance through React state, and CSS cannot derive a boolean "is this slot in the band" from a published fraction — the test is a threshold, and there is no `calc()` that yields one usable by an emphasis system.
- The projection must be the primitive's. A consumer writing its own attribute over `TugSlot`'s paint would have to restate `TugButton`'s emphasis tokens, which is precisely the sovereignty [L20] protects. A component rewriting its own children's resting look in its own vocabulary violates nothing.
- The listener is the smallest possible extension: the publisher already iterates registered elements, and a parallel set of callbacks is a handful of lines that generalizes to any future instrument needing a derived discrete state.
- It follows the shape `useFocusCursor` already uses for `data-key-cursor` — appearance computed in JS, written to the DOM, never rendered.

**Implications:**
- `imposer-gauges.ts` grows `registerGaugeListener(signal, fn): () => void`; `publish` calls the listeners after writing the elements, and a late listener is primed with `latest` exactly as a late element is.
- The two write paths into the chips' DOM need an ordering rule; Spec S03 states it.
- `FlowDots` registers as **both** an element (for the `data-gauge-drag` gate it inherits free) and a listener (for the state derivation).

#### [P07] One offset path survives; the thumb is the only casualty (DECIDED) {#p07-gestures-survive}

**Decision:** [P11] of `roadmap/layout-imposer-polish.md` — "three gestures, one path" — holds unchanged. Chip click reveals its slot through `flowRevealOffset`; the canvas wheel is untouched; and a **scrub** (pointer down on the dots and drag across them) replaces the thumb drag, previewing each crossed chip's reveal offset and committing once at release.

**Rationale:**
- The thumb has no truthful drawing over equal-width chips: a sliding capsule would state proportions the chips do not have.
- The scrub is the page-dot idiom and preserves every property the thumb bought — per-frame preview, exactly one `setFlowOffset`, and every frame clamped with `clampFlowOffset` so the deck never draws a position the commit would refuse.
- Chip click and the wheel are the two gestures that were already right; changing them would be change for its own sake.

**Implications:**
- `deck-canvas.tsx`'s `previewFlowOffset` / `commitFlowOffset` / wheel effect are unchanged apart from the component they hand to.
- The doctrine paragraph "Three gestures move the strip" in `tuglaws/pane-model.md` is edited in place — the thumb clause becomes the scrub clause — rather than rewritten.
- **The scrub previews in slot-sized jumps, and that is chosen rather than tolerated.** A preview writes the offset property directly and arms no settle, so there is no animator in the path ([L13]); each crossed chip therefore lands instantly. A paging control paging under the user's own finger is the idiom, not a stutter. Risk R03 names the failure mode and the fallback if the hand pass disagrees.

#### [P08] The masthead badge is a readout that opens a picker (DECIDED) {#p08-masthead-badge}

**Decision:** `CardSlotBadge` renders one `TugSlot` in the masthead frame's dead leading column — under the phase dot, aligned to the description line's block start — carrying the pane's `slot + 1`. Clicking it opens a `TugPopover` holding a `TugSlotLayout` control form of `slotCount(kind)` chips; selecting one dispatches `assign-slot`. It is mounted through `masthead-frame.css`'s geometry by both `session-masthead.tsx` and `card-masthead.tsx`.

**Rationale:**
- The column is genuinely dead space: `TugSessionRow` is mounted with `subAlign="title"`, so the description and third lines indent to the title's vertical and leave the leading column empty beneath the dot.
- The frame is where shared masthead geometry lives, by its own stated doctrine — the document masthead's first authoring drifted precisely by restating the frame's numbers at the mount site.
- `assign-slot` already exists end to end and already raises the assigned card, which is the behavior this affordance wants anyway. Nothing new is needed below the UI.
- `TugSlotLayout`'s control form takes a `focusGroup`, so the popup is the first keyboard path to slot assignment outside the Lens, for free.

**Implications:**
- The badge is **absent**, not dimmed, when `slotCount(kind) === 1`, when the pane has no `slot`, and on sidebar/Lens panes. This deliberately departs from [P10] of the previous plan (register change, not component change): that rule applies where the fact always exists and only its emphasis changes. A one-up pane has no slot, so a badge there would state a fact that does not exist.
- The badge itself is `outlined`, not `filled`: a card at rest should not wear an accent chip. Accent appears only on the popup's current slot, which is a transient selection.

---

### Deep Dives {#deep-dives}

#### Why the fit terms cannot see the sliver {#why-fit-terms-are-blind}

`pictureOfChain` walks adjacent pairs of the chain and measures `farRect.x − (nearRect.x + nearRect.width)` — the seam **between** two cards. In fit, `imposeRect` places a card at a travel fraction of the band and clamps its travel at zero, so a card can overlap a neighbour but can never hang off the band's end; the band's edges are therefore never a failure surface, and no term needs to watch them.

In flow, `imposeRect` is not used at all: `flowStripPositions` lays the occupied slots as a running sum from the strip's own origin, and the deck-canvas placements memo hands the resulting `stripLeft` to `imposeStyle`. The strip is *designed* to run past the band. Every seam is `IMPOSITION_GAP_PX` exactly, so the three fit terms are identically zero at every candidate total — which the short-circuit correctly observes — and the only remaining degree of freedom, where the band's far edge lands, has no term at all.

#### Worked example: the sliver in the screenshot {#worked-example}

Four-up, slim preset (`CONTENT_WIDTH_SLIM_PX = 675`), `IMPOSITION_GAP_PX = 5`, rails on both edges.

- Stride `s = 675 + 5 = 680`; strip width `W = 4 × 675 + 3 × 5 = 2715`.
- Suppose the rails at `Σ preferred` give a band `B = 2043`. Then `B` sits inside slot 3 (`left₃ = 2040`, extent `675`): visible `= 3`, hidden `= 672`, `worstSliver = 3`.
- Widening the rails' total by 3px gives `B = 2040`, exactly `left₃` — the far edge is on a boundary, `worstSliver = 0`, and slot 3 is cleanly off screen.
- Narrowing by 677 would also reach 0 (`B = 1366`, hmm — `left₂ + 675 = 2040 − 680 + 675 = 2035`; the nearest boundaries below are `2035` and `1360`), but the second key term `|T − Σ preferred|` prefers the total nearest the widths the user chose, so the 3px move wins.

That last line is the whole reason the key is lexicographic rather than a single score: among the totals that tile, the one closest to what the user asked for is the answer.

Under [P02] as amended the example still holds, and gains a third clean answer worth seeing: the 3px cut is a hairline (`3 < SLIVER_PX`), so it scores as a defect; `B = 2040` is a boundary and scores 0; and so does *narrowing* to `B = 2072`, which cuts slot 3 into an honest 32px slice. All three of those are reachable, two score 0, and `|T − Σ preferred|` picks between them — 3px of movement beats 29px, so the boundary still wins here. The grading did not change this answer; it changed which answers are allowed to be answers.

#### What the dots say, precisely {#what-the-dots-say}

For a four-up deck with slots 0, 1 and 3 occupied and the band standing over slots 1 and 3:

```
   [1] [2] [3] [4]
    ·   ▢   ·   ▢
```

- Chip 1 — occupied, off screen → `rest`.
- Chip 2 — occupied, in the band → `outlined`.
- Chip 3 — unoccupied → `rest`.
- Chip 4 — occupied, in the band → `outlined`.

Chips 1 and 3 are indistinguishable, and that is an accepted cost of drawing all `count` slots. The alternative — drawing only the strip's members — is truer but needs a sparse-numbering extension to `TugSlotLayout`, and the Lens's own row already draws all `count`. Consistency with the surface the user already reads slot numbers on wins.

#### Where the badge sits in the masthead {#badge-geometry}

`.tug-masthead-frame` is a 72px top-aligned column. `TugSessionRow` is mounted with `subAlign="title"` and `--tugx-session-row-leading-inset: 6px`, which puts the phase dot on the title line and starts the two lines beneath it at the *title's* vertical. The region bounded by the frame's leading edge, the title line's bottom, and the title's inset is therefore empty on every masthead — the space in the reference screenshot.

The badge is positioned there by `masthead-frame.css` (absolute against `.tug-masthead-frame`, which is already `position: relative`), aligned to the description line's block start so it reads as belonging to the stack rather than floating. The frame is **not** clipped (its comment records why: a phase dot's ring paints past its own box), so the badge cannot be bitten by an overflow rule.

---

### Specification {#specification}

**Spec S01: `stripPicture`** {#s01-strip-picture}

```ts
export function stripPicture(
  input: AllocatorInput,
  widths: RailWidths,
): { worstSliver: number };
```

- Derive the band: `resolveSpan({ width: input.canvasWidth, height: 0 }, railsOf(widths)).width − 2 × IMPOSITION_GAP_PX`. Clamp at 0.
- Build the strip: `flowStripPositions(chain)` over the same folded chain `chainOf(input)` produces.
- If the chain is empty, or the band ≤ 0, or `strip.width ≤ band` (no overflow), return `{ worstSliver: 0 }`.
- Otherwise let `B` be the band. Find the slot whose half-open interval `[left, left + extent)` contains `B`. If none does — `B` fell in a gap, or exactly on a boundary, or past the strip's end — return `{ worstSliver: 0 }`.
- Otherwise return `{ worstSliver: Math.min(B − left, left + extent − B) }`.

Exported for the same reason `seamPicture` is: the objective must be inspectable on its own, and the tests score it directly.

**Spec S02: the flow scoring key and tier** {#s02-flow-key}

- In `scoreRailTotal`, branch on `impositionLayout(input)`. Flow returns `[stripPicture(input, widths).worstSliver, Math.abs(total − preferredTotal)]`; fit returns today's four-term key unchanged.
- In `chooseRailTotal`, `tierOf(total)` returns `1` when the flow key's first term is `0` and `0` otherwise; fit's three-tier predicate is unchanged. The two-domain search and the "descend below comfort only for a higher tier" rule are shared verbatim.
- `allocateSidebarWidths` drops `impositionLayout(input) === "flow"` from the `target` short-circuit, and the remaining chain-length guard becomes mode-dependent — `< 2` in fit, `< 1` in flow ([P02], as amended).
- The flow scan is seeded with `flowSeedTotals` — the totals that put the band on a slot edge, on an edge ± `SLIVER_PX`, or at the strip's own length — because the graded score is spiky and a coarse stride can step over a one-pixel-wide optimum.

**Spec S03: the two write paths into a chip's resting look** {#s03-two-write-paths}

`TugSlotLayout` renders resting looks from its `states` prop and also exposes `setStates` through its ref. The ordering rule:

1. React's render is the **committed** truth. Every commit re-renders the layout with the states derived from the committed offset.
2. `setStates` is the **live** truth and is only called between commits, from a gauge listener.
3. A commit therefore always overwrites the last live write with an equal or newer answer, because the publisher's final frame and the commit derive from the same offset.
4. `FlowDots` calls `setStates` on every listener callback and never on render. It does not need to "clear" a live state: the next render supplies it.
5. **The handle keeps the element ref.** `TugSlotLayout` is `React.forwardRef<HTMLSpanElement, …>` today. A handle that replaced that would silently narrow a shipped primitive's ref contract, so `TugSlotLayoutHandle` carries `element: HTMLSpanElement | null` alongside `setStates`. No consumer passes a ref today (`slot-picker.tsx` and the two spikes do not), so this costs nothing now and keeps the affordance for later.

**How the projection actually writes a look.** `TugSlot` has two forms and they paint differently. Without `onSelect` it is a `<span>` carrying `tug-slot-exemplar-<state>`. With `onSelect` — the form `FlowDots` uses, since a chip is clickable — it is a `TugButton` whose look is the compound class `tug-button-<emphasis>-<role>`, `emphasis` coming from `TugSlot`'s own `STATE_EMPHASIS` map and `role` fixed at `"action"`. Both forms stamp `data-state`. So `setStates` writes two things per chip: `data-state`, which is what the app-tests read, and the one look class that chip's form carries, swapped from the old state's to the new one's.

**The class grammar stays where it lives.** `tug-button-<emphasis>-<role>` is composed inline in `tug-button.tsx` (`emphasisRoleClass`). `TugSlotLayout` must not restate that template: that is the same [L20] restatement Risk R02 exists to prevent, moved one level in rather than removed. Export the composition from `tug-button.tsx` as `tugButtonEmphasisClass(emphasis, role)`, use it at the existing render site so there is one definition, and call it from the projection. The exemplar form's `tug-slot-exemplar-<state>` is `TugSlot`'s own vocabulary and needs no export.

**Spec S04: `registerGaugeListener`** {#s04-gauge-listener}

```ts
export function registerGaugeListener(
  signal: GaugeSignal,
  fn: (values: ReadonlyMap<string, string> | null) => void,
): () => void;
```

- Stored in a module-level `Map<GaugeSignal, Set<fn>>` beside `subscribers`.
- Primed on registration with `latest.get(signal)` when present, exactly as an element registration is — an instrument mounted mid-gesture draws the gesture.
- `publish` calls every listener for the signal **after** writing the registered elements, with the same value it wrote (`null` retires the signal).
- The returned teardown removes the listener. It publishes nothing on removal; a listener that stopped listening leaves whatever it last wrote for its own component's next render to correct.
- The existing `Set.size` fast path in `publish` must now consider listeners too, or a signal with listeners and no elements would never fire. (`latest.set(signal, values)` already happens before that early return, so priming stays correct either way.)
- The listener is handed the **same property map the elements are written from**, not a number: for `flow-offset` that is `new Map([["--gauge-flow-offset", "0.1234"]])`, published by `publishFlowOffset` as `flowOffset / flowBand` and fixed to four places. A consumer reads `values.get("--gauge-flow-offset")` and `Number()`s it, then multiplies by the band it holds. Naming this here so Step 6's "turn the published fraction back into an offset" is a lookup rather than a re-derivation.

**Spec S05: `slotsInBand`** {#s05-slots-in-band}

```ts
export function slotsInBand(input: FlowVisibleInput): ReadonlySet<number>;
```

Reuses `FlowVisibleInput` (`{ strip, band, offset }`), the shape `firstVisibleFlowSlot` already takes. Returns every occupied slot whose interval `[left, left + extent)` intersects `[offset, offset + band)` — a slot is "in the band" when any part of it is on screen, since a clipped card is still a card the reader can see.

It exists so that **the committed render and the live projection cannot disagree**: `FlowDots` derives its `states` prop from it at render, and its gauge listener derives the live states from it per frame, over the same arithmetic. A second derivation would agree with the first only by luck, which is the same reason `FlowStrip` carries `extents` rather than leaving a caller to subtract a gap it assumes.

Empty band, non-finite inputs, or an empty strip return an empty set.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Rail widths / band width | structure | Pure allocator over `AllocatorInput`, committed through `_commitImposition` | [L02] |
| Which slots exist, and their occupancy | structure | Deck snapshot via `useSyncExternalStore` in `deck-canvas.tsx`, handed to `FlowDots` as props | [L02] |
| Chip resting looks at rest (committed) | structure | React render from the committed `flowOffset` | [L02] |
| Chip resting looks during a gesture | appearance | `registerGaugeListener` → `TugSlotLayout.setStates` DOM projection | [L06], [L22] |
| Scrub in progress (origin, live offset) | local-data | `useRef` in `FlowDots`; no state, no render | [L07] |
| Drag gate on the dots | appearance | `data-gauge-drag` stamped by the channel, read by CSS | [L06] |
| Badge presence and its digit | structure | Deck snapshot via `useSyncExternalStore` | [L02] |
| Badge popup open/closed | local-data | `TugPopover`'s own controlled/uncontrolled state | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/chrome/flow-dots.tsx` | `FlowDots` — the centered numbered readout of where the band stands, and the chip click / scrub that move it |
| `tugdeck/src/components/chrome/flow-dots.css` | The dots' seating in the bottom band and its drag gate |
| `tugdeck/src/components/tugways/card-slot-badge.tsx` | `CardSlotBadge` — the masthead's slot readout and its slot popup |
| `tests/app-test/at0461-flow-dots.test.ts` | The dots: seating, registers, liveness, gestures |
| `tests/app-test/at0462-card-slot-badge.test.ts` | The badge: presence rules, digit, popup assignment |

#### Files removed {#removed-files}

| File | Replaced by |
|------|-------------|
| `tugdeck/src/components/chrome/flow-rail.tsx` | `flow-dots.tsx` |
| `tugdeck/src/components/chrome/flow-rail.css` | `flow-dots.css` |
| `tests/app-test/at0459-flow-rail.test.ts` | `at0461-flow-dots.test.ts` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `stripPicture` | fn | `tugdeck/src/lib/layout-imposer.ts` | Spec S01; exported beside `seamPicture` |
| `slotsInBand` | fn | `tugdeck/src/lib/layout-imposer.ts` | Spec S05; the one derivation both the committed render and the live projection read |
| `scoreRailTotal` | fn | `tugdeck/src/lib/layout-imposer.ts` | Mode branch, Spec S02 |
| `chooseRailTotal` | fn | `tugdeck/src/lib/layout-imposer.ts` | Mode-aware `tierOf`, Spec S02 |
| `allocateSidebarWidths` | fn | `tugdeck/src/lib/layout-imposer.ts` | Flow removed from the short-circuit condition |
| `registerGaugeListener` | fn | `tugdeck/src/lib/imposer-gauges.ts` | Spec S04 |
| `publish` | fn | `tugdeck/src/lib/imposer-gauges.ts` | Fires listeners; fast path considers them |
| `TugSlotLayoutHandle` | interface | `tugdeck/src/components/tugways/tug-slot-layout.tsx` | `{ element: HTMLSpanElement \| null; setStates(states: readonly TugSlotState[]): void }` — the element is kept because the component forwards `HTMLSpanElement` today (Spec S03) |
| `tugButtonEmphasisClass` | fn | `tugdeck/src/components/tugways/internal/tug-button.tsx` | Exports the existing inline `tug-button-${emphasis}-${role}` composition so the projection can swap a look without restating it ([L20], Spec S03) |
| `TugSlotLayout` | component | `tugdeck/src/components/tugways/tug-slot-layout.tsx` | `forwardRef` to the handle; projects its own children's looks |
| `FlowDots` | component | `tugdeck/src/components/chrome/flow-dots.tsx` | [P05], [P06], [P07] |
| `CardSlotBadge` | component | `tugdeck/src/components/tugways/card-slot-badge.tsx` | [P08] |
| `.tug-masthead-frame-slot-badge` | CSS class | `tugdeck/src/components/tugways/masthead-frame.css` | The badge's seating, stated once for both mastheads |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/pane-model.md` — rewrite the "In flow the deck says where it stands" paragraph for the dots (centered, all `count` chips, two registers, no accent, `TugSlotLayout`-composed).
- [ ] `tuglaws/pane-model.md` — edit the "Three gestures move the strip" paragraph: the thumb clause becomes the scrub clause; chip click and wheel unchanged.
- [ ] `tuglaws/pane-model.md` — add a paragraph stating the band rule, which has two halves and currently records neither: the rails absorb the residual so the band never ends on a hairline of a card (graded, not minimised — an honest slice is a clean answer, [P02] as amended), **and the band clips** — a flow pane's ink stops at the band edges through `imposeStyle`'s `clip-path`, which is what makes "the half-visible card IS the affordance" (already asserted a few paragraphs up, for columns) true in pixels rather than only in arithmetic.
- [ ] `tuglaws/pane-model.md` — replace the two `flow-rail.*` Files rows with `flow-dots.*`, and add `card-slot-badge.tsx`.
- [ ] `tuglaws/pane-model.md` — extend the gauge-channel paragraph with the listener registration and what it is for.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `stripPicture`'s arithmetic, the flow key, the flow tier, `registerGaugeListener`'s lifecycle | `tugdeck/src/lib/__tests__/` |
| **Exhaustive sweep** | The flow scan finds what a 1px search finds; the invariant order still holds | `layout-imposer-solutions.test.ts` |
| **Golden / drift** | Fit answers byte-unchanged; flow answers snapshotted so a retune reads as a diff | `layout-imposer-solutions.test.ts`, `layout-imposer-flow.test.ts` |
| **App-test** | The picture on a real deck: seating, registers, liveness, gestures, badge behavior | `tests/app-test/at0461`, `at0462` |

#### What stays out of tests {#test-non-goals}

- No jsdom render tests of `FlowDots` or `CardSlotBadge`. Both are geometry-and-appearance components; a fake DOM would assert the props rather than the picture, which is the banned shape.
- No assertion on the exact rail widths the flow scan chooses for a given canvas width outside the golden table. The property (`hairlineOf(worstSliver) === 0` where reachable, `Σ preferred` breaking ties) is what is asserted; the number is drift-netted, not specified.
- No mid-transition style reads on the dots. A settle animates the strip's crossing after a chip click; assertions read the committed offset and the projected states, never an interpolated paint.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | M01 — the flow picture, pure | done | `0e8187fbc` |
| #step-2 | M01 — the allocator scans in flow | done | `ecc71755c` |
| #step-3 | M01 — integration checkpoint | done | `481416b77` |
| #step-4 | M02 — the gauge listener and the layout's own projection | done | `7202547ed` |
| #step-5 | M02 — flow dots replace the rail | done | `4e5e85e3f` |
| #step-6 | M02 — the dots go live and take the gestures | done | `0cd0953fe` |
| #step-7 | M02 — integration checkpoint | done | `62b0f40c2` |
| #step-8 | M03 — the slot badge in the masthead frame | done | `2a62124fe` |
| #step-9 | M03 — the badge's slot popup | done | `301776a9f` |
| #step-10 | M03 — integration checkpoint | done | `a1c515012` |

**Milestone M01: The band stops slivering** {#m01-band-stops-slivering} · **Milestone M02: Flow dots** {#m02-flow-dots} · **Milestone M03: The masthead slot badge** {#m03-masthead-slot-badge}

#### Step 1: M01 — the flow picture, pure {#step-1}

**Commit:** `tugdeck(flow-legibility): the band's far edge becomes a measurable picture`

**References:** [P02] Sliver measure, [P03] Scored at rest, Spec S01, (#why-fit-terms-are-blind, #worked-example)

**Artifacts:**
- `stripPicture` exported from `tugdeck/src/lib/layout-imposer.ts`, beside `seamPicture`.
- Unit coverage of its edges in `tugdeck/src/lib/__tests__/layout-imposer-flow.test.ts`.

**Tasks:**
- [ ] Implement Spec S01. Derive the band from `resolveSpan(...).width − 2 × IMPOSITION_GAP_PX` — do not restate `_flowBandWidth`'s arithmetic; the two must agree by construction.
- [ ] Reuse `chainOf(input)` for the occupancy fold and `flowStripPositions` for the layout, so the picture and the deck's real strip cannot part company.
- [ ] Document the function the way `seamPicture` is documented: what it measures, why it is one term and not three, and why a symmetric measure is the right one ([P02]).

**Tests:**
- [ ] `layout-imposer-flow.test.ts`: a band ending exactly on a slot's left edge → 0; on a slot's right edge → 0; in a gap between slots → 0; a 3px peek → 3; a 3px hidden tail → 3; a band ending 300px into a 675px slot → 300 (`min(300, 375)`); a strip that fits its band → 0; an empty chain → 0.
- [ ] A case at the real presets from the worked example (`CONTENT_WIDTH_SLIM_PX`, four-up), asserting the sliver the reference configuration produces.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/layout-imposer-flow.test.ts` green.
- [ ] `bunx tsc --noEmit` clean.

---

#### Step 2: M01 — the allocator scans in flow {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(flow-legibility): the rails absorb the residual so the band tiles`

**References:** [P01] Flow gets a picture, [P04] Flow comfort tiers, Spec S02, Risk R01, (#why-fit-terms-are-blind)

**Artifacts:**
- `scoreRailTotal` and `chooseRailTotal` mode-aware; the flow arm removed from `allocateSidebarWidths`'s short-circuit.
- The short-circuit's comment replaced with one that states what it now covers and why flow left it.

**Tasks:**
- [ ] Branch `scoreRailTotal` on `impositionLayout(input)` per Spec S02. Keep the fit key's construction untouched.
- [ ] Make `tierOf` in `chooseRailTotal` mode-aware; leave the two-domain search and the comfort rule exactly as they are.
- [ ] Remove `impositionLayout(input) === "flow"` from the `target` short-circuit, and make the remaining chain-length guard mode-dependent — `< 2` in fit, `< 1` in flow.
- [ ] Rewrite the short-circuit comment: it must no longer claim flow has no picture, and it should name where flow's picture now lives.
- [ ] Update the `allocateSidebarWidths` doc block's "Flow is why `imposeRect` and `seamPicture` stay fit-only" sentence — that remains true, and the reason is now that flow has its own picture rather than none.

**Tests:**
- [ ] `layout-imposer-solutions.test.ts`: extend the exhaustive 1px cross-check to flow configurations — the coarse-to-fine scan must find what a 1px exhaustive search finds, and every invariant (totality, bounds, greed soundness, monotonicity, tie fairness) must hold in flow too.
- [ ] Assert the **fit** golden table is unchanged without regeneration (Risk R01): a fit diff fails the step.
- [ ] Add flow rows to the golden table so a future retune reads as a diff.
- [ ] `layout-imposer-flow.test.ts`: the allocator's own flow answers — a configuration whose comfort domain can reach `worstSliver === 0` keeps comfort; one that can only reach it below the comfort floors surrenders comfort ([P04]); one that can reach it in neither keeps `Σ preferred`-nearest.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` green, with the fit golden table untouched in the diff.
- [ ] `bunx tsc --noEmit` clean; `bunx vite build` clean.

---

#### Step 3: M01 — integration checkpoint {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** N/A (verification only)

**References:** Milestone M01, [P01] Flow gets a picture, (#success-criteria, #worked-example)

**Artifacts:**
- A recorded hand pass on a debug build: the reference configuration from the worked example, before and after.

**Tasks:**
- [ ] `just app-debug` from the worktree; set the deck to four-up, slim, flow, with rails on both edges.
- [ ] Confirm by eye and by measurement that no hairline of a card stands under the Lens, and record the rails' widths and the band.
- [ ] Confirm the rails do not change width while scrolling the strip by wheel ([P03], Risk table row 4).

**Tests:**
- [ ] `just app-test-changed` over the working diff.

**Checkpoint:**
- [ ] The reference deck shows no sliver; the measurement is recorded in the dash log.
- [ ] Rail widths constant across a wheel gesture.
- [ ] `just app-test-changed` green.

---

#### Step 4: M02 — the gauge listener and the layout's own projection {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(flow-legibility): a gauge may be heard, and a slot layout projects its own looks`

**References:** [P06] Live projection, Spec S03, Spec S04, Risk R02

**Artifacts:**
- `registerGaugeListener` in `tugdeck/src/lib/imposer-gauges.ts`.
- `TugSlotLayoutHandle` and a `forwardRef` `TugSlotLayout` that projects resting looks onto its own children.

**Tasks:**
- [ ] Implement Spec S04. Prime a late listener from `latest`; fire listeners after the element writes; make `publish`'s fast path consider listeners as well as elements, or a listener-only signal never fires.
- [ ] Document the listener in the module doc beside the element registration, stating what it is for: a consumer whose live state is a *threshold* over the published fraction, which CSS cannot express.
- [ ] Export `tugButtonEmphasisClass(emphasis, role)` from `tug-button.tsx` and use it at the existing `emphasisRoleClass` site, so the compound-class grammar has exactly one definition ([L20], Spec S03).
- [ ] Implement `TugSlotLayoutHandle` — `{ element, setStates }` — inside `TugSlotLayout`, forwarding through `useImperativeHandle` over the span ref it already holds. Keep `element` (Spec S03, point 5).
- [ ] `setStates` writes each chip's `data-state` and swaps the one look class its form carries: `tug-slot-exemplar-<state>` on the exemplar span, `tugButtonEmphasisClass(STATE_EMPHASIS[state], "action")` on the control form's button. It never restates a token and never takes a class from a consumer ([L20], Risk R02).
- [ ] State Spec S03's ordering rule in `tug-slot-layout.tsx`'s module doc: render is committed truth, the handle is live truth between commits, and a commit always supersedes.

**Tests:**
- [ ] Unit: a listener registered before a publish receives it; one registered mid-gesture is primed with `latest`; teardown stops delivery; a `null` publish reaches listeners; a signal with listeners and no elements still fires.
- [ ] Unit: `gaugeSubscriberCount` semantics unchanged for elements.
- [ ] Unit: `tugButtonEmphasisClass` returns exactly the string the render site composed before the export, pinned over the emphasis × role matrix, so the extraction cannot drift a class name.
- [ ] App-test case in the existing gauge coverage asserting `setStates` changes a chip's `data-state` while the harness motion census reports `notifies === 0` across the call — the mechanism `at0458-miniature-live.test.ts` already uses for exactly this claim (`tests/app-test/_harness/index.ts`). There is no render counter in the harness; a notify is what a render would have to come from, so this is the assertion that means it.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` green.
- [ ] `bunx tsc --noEmit` clean; `bunx vite build` clean.

---

#### Step 5: M02 — flow dots replace the rail {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(flow-legibility): the flow rail becomes a centered row of numbered dots`

**References:** [P05] Flow dots, Spec S05, (#what-the-dots-say)

**Artifacts:**
- `slotsInBand` in `layout-imposer.ts`, beside `firstVisibleFlowSlot`.
- `flow-dots.tsx` / `flow-dots.css`; `flow-rail.tsx` / `flow-rail.css` deleted.
- `deck-canvas.tsx` mounting `FlowDots`.
- `at0459-flow-rail.test.ts` rewritten as `at0461-flow-dots.test.ts`.

**Tasks:**
- [ ] Implement Spec S05's `slotsInBand`, reusing `FlowVisibleInput`. Both this step's render and Step 6's listener read it — do not derive the in-band test twice.
- [ ] Author `FlowDots`: a `TugSlotLayout` of `slotCount(kind)` chips in its **control form** — it passes `onSelectSlot`, because a chip is clickable ([P07]) — with resting looks from `slotsInBand` over the committed `flowOffset`, centered in the canvas's bottom band at the rail's existing 8px inset. The form matters beyond the click: a control-form chip is a `TugButton` and paints through the emphasis class, which is the path Step 4's projection writes (Spec S03).
- [ ] Keep the rail's mount condition in `deck-canvas.tsx`: the dots stand only when there is a flow strip and a band (`flowStrip !== null && flowBandPx !== null && flowBandPx > 0`). Flow is a mode bit, and a fit deck has no strip to report.
- [ ] Register the root as a gauge element for `flow-offset` in a layout effect ([L03]) — this is what inherits the `data-gauge-drag` gate; keep the rail's `pointer-events: none` rule under it.
- [ ] Delete `STAMP_CLEARANCE_PX`, `RAIL_BAND_SHARE`, `RAIL_MAX_WIDTH_PX`, the proportional position/width math, and the thumb along with `flow-rail.*`.
- [ ] Swap the mount in `deck-canvas.tsx`; leave `previewFlowOffset`, `commitFlowOffset` and the wheel effect untouched.
- [ ] Renumber the previous dash's other colliding test: `at0458-miniature-live.test.ts` → `at0463-miniature-live.test.ts`, keeping its `@covers` header intact.

**Tests:**
- [ ] `at0461-flow-dots.test.ts` with a `@covers` header naming `flow-dots.tsx`: the dots stand centered (their box's center within a pixel of the canvas's), sit 8px off the canvas bottom, draw exactly `slotCount(kind)` chips, and clear the canvas's bottom-left corner by the width of the stamps at the deck's minimum width.
- [ ] Unit: `slotsInBand` over a known strip — a slot wholly inside, one clipped at each edge, one wholly outside, an unoccupied slot, an empty strip, a zero band.
- [ ] A case asserting the resting looks for a known strip and offset match [P05]'s rule (occupied-and-in-band → `outlined`, everything else → `rest`).
- [ ] `just app-test-covers-check`.

**Checkpoint:**
- [ ] `just app-test at0461-flow-dots.test.ts` green.
- [ ] `bunx vite build` clean; no reference to `flow-rail` remains (`grep -r flow-rail tugdeck tests` empty).

---

#### Step 6: M02 — the dots go live and take the gestures {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(flow-legibility): the dots follow the strip, and move it`

**References:** [P06] Live projection, [P07] Gestures survive, Spec S03, Spec S05, Risk R03, (#what-the-dots-say)

**Artifacts:**
- `FlowDots` subscribed via `registerGaugeListener`, projecting live looks through `TugSlotLayout.setStates`.
- Chip click and scrub wired to `onCommit` / `onPreview`.

**Tasks:**
- [ ] Register the listener in the same layout effect as the element registration; turn the published fraction back into an offset (it is a fraction of the *band* — [P08] of the previous plan), derive the in-band set with `slotsInBand` (Spec S05, the same call the render makes), and hand it to `setStates`. Never call it from render (Spec S03).
- [ ] Wire chip click to `flowRevealOffset` — the least move that brings that slot fully into the band, the same arithmetic an activation reveals with.
- [ ] Implement the scrub: pointer down on the dots row, pointer capture, previewing each crossed chip's reveal offset per frame, exactly one `onCommit` at release. Clamp every frame with `clampFlowOffset`. Gesture state in refs, never state ([L07]).
- [ ] Confirm the wheel gesture in `deck-canvas.tsx` still repaints the dots — it publishes `flow-offset`, so the listener carries it with no further wiring.

**Tests:**
- [ ] `at0461-flow-dots.test.ts`: mid-wheel-gesture, the chips' `data-state` has changed while the committed `flowOffset` read off `window.tugdeck.diag.getDeckState()` is unchanged and the harness motion census reports `notifies === 0` — the at0458 pattern, which is the claim "the picture moved without one store notify".
- [ ] A chip click commits exactly the `flowRevealOffset` answer, and a chip already fully in the band commits nothing.
- [ ] A scrub across chips: `notifies === 0` while the hand is down, exactly one after release, and the committed offset equals the last previewed one.
- [ ] A case asserting the dots take no pointer events while `data-gauge-drag` is stamped.

**Checkpoint:**
- [ ] `just app-test at0461-flow-dots.test.ts at0450-imposer-cut-census.test.ts` green.
- [ ] `cd tugdeck && bun test` green; `bunx vite build` clean.
- [ ] **Hand evaluation of the scrub on a debug build (Risk R03).** Scrub slowly and fast across the chips and judge whether the slot-sized jumps read as paging or as stutter. Record the verdict. If it reads as stutter, adopt the named fallback — map the pointer's travel across the dots row continuously onto the strip offset and snap to a slot only at release — which is a change confined to `FlowDots`.

---

#### Step 7: M02 — integration checkpoint {#step-7}

**Depends on:** #step-5, #step-6

**Commit:** `tugdeck(flow-legibility): the pane model says dots, and says how the band ends`

**References:** Milestone M02, [P05] Flow dots, [P07] Gestures survive, (#documentation-plan)

**Artifacts:**
- `tuglaws/pane-model.md` updated per the Documentation Plan.

**Tasks:**
- [ ] Rewrite the flow-rail paragraph for the dots; edit the three-gestures paragraph's thumb clause into the scrub clause; add the band-rule paragraph; extend the gauge paragraph with the listener; replace the Files rows.
- [ ] Hand pass on a debug build: wheel, chip click, and scrub, each watched for a stutter or a stuck chip.

**Tests:**
- [ ] `just app-test-changed` over the working diff.

**Checkpoint:**
- [ ] `just app-test-changed` green.
- [ ] Doctrine contains no surviving reference to the rail or its thumb.

---

#### Step 8: M03 — the slot badge in the masthead frame {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck(flow-legibility): a card says which slot it stands in`

**References:** [P08] Masthead badge, [Q01] Badge without a masthead, (#badge-geometry)

**Artifacts:**
- `card-slot-badge.tsx` (readout form only — no popup yet).
- `.tug-masthead-frame-slot-badge` geometry in `masthead-frame.css`.
- Mounts in `session-masthead.tsx` and `card-masthead.tsx`.

**Tasks:**
- [ ] Author `CardSlotBadge`: read the deck snapshot through `useSyncExternalStore` ([L02]), find the pane hosting `cardId`, render one `TugSlot` at `state="outlined"` with `number={slot + 1}`.
- [ ] Return `null` when `slotCount(kind) === 1`, when the host pane has no `slot`, when there is no host, and when the host is a sidebar or the Lens pane (`findSidebarPane` / `findLensPane` in `deck-store-selectors.ts` — the same guards `SlotPicker` applies).
- [ ] State the geometry once in `masthead-frame.css` per the badge-geometry deep dive; mount the component in both masthead files.
- [ ] Record in the component doc why absence is right here and why it does not contradict the previous plan's register-not-component rule ([P08]).

**Tests:**
- [ ] `at0462-card-slot-badge.test.ts` with a `@covers` header: the badge's digit equals the pane's `slot + 1` under a multi-slot imposition; it is absent under one-up; it is absent on the Lens pane; it sits inside the masthead frame's leading column and below the phase dot (box comparison).
- [ ] `just app-test-covers-check`.

**Checkpoint:**
- [ ] `just app-test at0462-card-slot-badge.test.ts` green.
- [ ] `bunx tsc --noEmit` clean; `bunx vite build` clean.

---

#### Step 9: M03 — the badge's slot popup {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(flow-legibility): the badge moves the card`

**References:** [P08] Masthead badge, (#dependencies)

**Artifacts:**
- `CardSlotBadge` wrapped in `TugPopover`; a `TugSlotLayout` control form inside the content.

**Tasks:**
- [ ] Wrap the badge's `TugSlot` in `TugPopoverTrigger`; render a `TugPopoverContent` holding a `TugSlotLayout` with `count = slotCount(kind)`, the current slot `filled` and the rest `rest`, `slotLabel`, and a `focusGroup` so the chips are reachable by keyboard.
- [ ] `onSelectSlot` dispatches `assign-slot` with `{ cardId, slot }` — the same action `SlotPicker` dispatches — and closes the popover.
- [ ] Confirm the trigger composes the child's ref rather than replacing it. `TugPopoverTrigger` uses `composeRefs`; a regression there costs the chips their movement cursor silently, which is the failure `compose-refs.ts`'s doc records.

**Tests:**
- [ ] `at0462-card-slot-badge.test.ts`: clicking the badge opens the popup; clicking chip N moves the pane to slot N−1 and raises it (assert `deckState.panes`); the badge's digit updates to N.
- [ ] A keyboard case: the popup's chips carry `data-key-cursor` when the group holds the key view — the direct regression guard for the ref-composition failure.

**Checkpoint:**
- [ ] `just app-test at0462-card-slot-badge.test.ts` green.
- [ ] `cd tugdeck && bun test` green; `bunx vite build` clean.

---

#### Step 10: M03 — integration checkpoint {#step-10}

**Depends on:** #step-8, #step-9

**Commit:** N/A (verification only)

**References:** Milestone M03, [P08] Masthead badge, (#success-criteria)

**Artifacts:**
- A recorded hand pass covering all three milestones together.

**Tasks:**
- [ ] Add the badge's Files row to `tuglaws/pane-model.md`.
- [ ] Hand pass on a debug build: move a card between slots from its own masthead, watch the dots follow, confirm the band still ends cleanly after the move.
- [ ] Run `just app-test-changed` over the whole plan's diff; if it advises the core tier, run `just app-test` and move on.

**Tests:**
- [ ] `just app-test-changed` (and the core tier if advised).

**Checkpoint:**
- [ ] All three milestones' app-tests green in one run.
- [ ] `cd tugdeck && bun test` green; `bunx tsc --noEmit` clean; `bunx vite build` clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A flow deck that is legible at rest — the sidebar rails absorb the strip's residual so the band ends on a card boundary rather than on a hairline, a centered row of numbered chips says which slots the band is showing and moves it by click or scrub, and every masthead-wearing card names the slot it stands in and can be moved from there.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `hairlineOf(stripPicture(...).worstSliver)` is 0 at the chosen rail total whenever the rails' range can reach 0, and the fit golden table is byte-unchanged (verification: `layout-imposer-solutions.test.ts`). **Not "minimal":** [P02] as amended grades the sliver rather than minimising it, so a total that cuts an honest slice is a passing answer and a total that shaves a slice thinner is not a better one.
- [ ] The reference four-up slim flow deck shows no clipped hairline under the Lens (verification: hand pass, recorded measurement).
- [ ] Rail widths are constant across a wheel gesture (verification: hand pass).
- [ ] The dots stand centered, draw `slotCount(kind)` chips, and clear the host's stamp corner (verification: at0461).
- [ ] A wheel gesture repaints the dots with zero renders (verification: at0461, motion census `notifies === 0`).
- [ ] Chip click, scrub, and wheel each write the store exactly once per gesture (verification: at0461 + at0450 census).
- [ ] The badge names the right slot, is absent where there is no slot, and assigns through its popup (verification: at0462).
- [ ] `tuglaws/pane-model.md` describes the dots, the scrub, the band rule, and the gauge listener; nothing in it still describes the rail.

**Acceptance tests:**
- [ ] `cd tugdeck && bun test` — green.
- [ ] `bunx tsc --noEmit` and `bunx vite build` — clean.
- [ ] `just app-test at0461-flow-dots.test.ts at0462-card-slot-badge.test.ts at0450-imposer-cut-census.test.ts` — green.
- [ ] `just app-test-changed` over the final diff — green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A vertical dots twin for overflowing columns — the same pattern down the y axis.
- [ ] A slot affordance for cards with a plain one-line title bar ([Q01]).
- [ ] Drawing only the strip's occupied slots, which needs a sparse-numbering extension to `TugSlotLayout` (#what-the-dots-say).
- [ ] Momentum / deceleration physics on the wheel gesture.

| Checkpoint | Verification |
|------------|--------------|
| M01 band stops slivering | solutions sweep + golden tables + hand pass |
| M02 flow dots | at0461 + at0450 census + hand pass |
| M03 masthead slot badge | at0462 + hand pass |
