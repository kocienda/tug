## Layout Imposer Polish — designed motion, truthful zones, live instruments {#layout-imposer-polish}

**Purpose:** The layout imposer's behaviors become polished instruments: every card motion runs on a designed spring choreography instead of ad-hoc tweens, every drop zone previews exactly what the release will produce, the Lens miniature mirrors the deck fully live — offsets, slides, and the drag itself — and flow mode gains a numbered scroll rail in the deck's bottom band plus a direct scroll gesture.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-20 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-20, fable (same-turn review after devise; Fable stands above the Opus tier the review rule names).** Reviewed `plan:e6e28742ec4d2384`. Lint: 0 errors, 1 warning (the absent Review Record this round adds).
Oriented on: the whole document — first pass.
Applied: test-layer honesty — Spec S01 promised store-layer unit tests, but no unit test constructs a real `DeckManager` (it is browser-coupled), so the batching semantics moved to app-layer `evalJS` cases; the planned `imposer-gauges.test.ts` was cut for the same reason (bun tests have no DOM substrate — happy-dom was deleted) and its assertions ride the first gauge consumers' app-tests. Technical accuracy — Step 6 claimed `DeckColumn` carries `shares`; it carries `seams`, and the weights live at `state.imposition.columns[slot].shares` (verified in `deck-store-selectors.ts`), so the task now names the real source. Test naming — Step 10 cited an "at0303-family" for the miniature; the actual `@covers` set is at0357/at0359/at0454, and the ambiguous `at0312` citation was pinned to `at0312-focus-attr-stability`. Motion coherence — [P09] gained the commit-jump transition gate (a reveal still glides in the miniature; per-frame gauge writes are never double-smoothed), and [L13] joined the named constraints. Cross-checked laws: [L02] (rail structure, miniature structure from the store), [L03] (gauge registration in layout effects), [L06] (every per-frame path is CSS custom properties — the gauge channel is [L06]'s own mechanism extended across subtrees), [L13] (recipes still play through `animate()`), [D135]/[D6] (multi-term recipes on one curve; `fill: none` landings); the State Zone Mapping covers every new piece of state.
Deferred: nothing — the three design forks were settled by the owner before authoring.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The drop-zone drag engine ([P09] of `roadmap/layout-imposer-plan-2.md`) shipped working but not polished. Four defects stand, reported from hand-testing on the live deck:

1. **Motion is ad-hoc and visibly rough.** Dragging and dropping produces flashing and hopping. The settle machinery in `deck-canvas.tsx` warns in its own comments about the retarget flash it papers over with `restores`; a single release can produce three or more store notifies (`transferFocusForActivation` → `activateCard`, then `_commitImposition`, plus the autoscroll's `commitScroll`), each re-arming or retargeting the settle; and during drag-autoscroll the dragged frame's base `left` is a calc over `--tug-imposer-flow-offset` while its transform is pointer-relative (`applyZoneDragFrame` in `tug-pane.tsx` writes `translate(pointer − start)`), so the strip slides the card under the hand. Beyond the defects, there is no *stated design* for what an imposer animation is — each call site picks a duration and an easing.
2. **The drop-zone tile can lie about the outcome.** `stackTiles` in `drop-zones.ts` predicts a column position as the sitting members at their current heights plus the dragged card at its current height — a prediction only correct for a same-height reorder. The commit actually re-divides the run by member weights. And a single-pane slot advertises only a whole-`slot` zone whose commit z-stacks the arrival, when the gesture the user reads from the indicator is a division: drop a card on the lower half of a one-card slot and you should get a split column down the middle.
3. **The Lens Layout miniature is a schematic, not an instrument.** It reads only store commits (`useSyncExternalStore` in `layouts-section.tsx`), while the deck's per-frame motion — flow offset, column slides, the drag itself — lives in CSS custom properties per [L06]. The miniature is right at every rest and blind during every motion, and in flow, motion is the story.
4. **Flow mode's horizontal position is invisible.** There is no scrollbar and no direct scroll gesture at all: the offset moves only via reveal-on-activation, drag-autoscroll, and clamp retunes. The deck already reserves a deeper bottom band (`IMPOSITION_GAP_BOTTOM_PX = 32`) that can hold the affordance.

#### Strategy {#strategy}

- **Diagnose before surgery.** The first step instruments the motion path (settle arms, retargets, notifies per gesture) in `deck-trace.ts` so the coalescing work is judged by counted facts, and the counts stay behind as app-test assertions.
- **One gesture, one commit, one notify.** The release's mutations batch into a single store transaction so the settle arms exactly once. This is [P10] of plan-2 ("the settle animates an arrangement change once") enforced at the store boundary.
- **Design the motion once, in one module.** A named recipe table (spring parameters per operation class) in a new `imposer-motion.ts`, consumed by every imposer call site. `SpringSolver` in `physics.ts` already provides the solver, `keyframes()` sampling, and `velocityAt()` for velocity matching; the sampled-keyframes-over-`easing: "linear"` pattern is established in `gallery-animator.tsx`.
- **Zones tell the truth by construction.** The tile is computed by the same seam-fraction arithmetic the commit will run (`railSeamFractions` serves columns too), so tile and outcome cannot drift.
- **One gauge channel serves two instruments.** Per-frame writers publish once; the Lens miniature and the flow rail both register as gauges and receive CSS custom-property writes — [L06] on both ends.
- **Milestones land independently:** M01 butter, M02 truthful zones, M03 live miniature, M04 flow rail. Each has an integration checkpoint; later milestones ride on M01's motion recipes but M02 does not depend on M03/M04.

#### Success Criteria (Measurable) {#success-criteria}

- A drop-zone release produces exactly 1 store notify, at most 1 settle arm, and 0 settle retargets (motion census assertion in an app-test).
- During drag-autoscroll the dragged card's on-screen position is stationary relative to the pointer within 1px per frame (app-test measuring frame rect against pointer across an autoscroll burst).
- Every imposer tween's keyframes come from a named recipe in `imposer-motion.ts`; `grep` finds no raw `easing:` string in `deck-canvas.tsx`/`tug-pane.tsx` imposer paths (checkpoint grep, plus unit tests on recipe curves).
- A column-position tile equals the post-drop division: for a 2-member equal split, the tile is the run's half minus the seam share, exact to the pixel (unit tests in `drop-zones.test.ts`).
- Dropping a card on the lower half of a single-pane slot commits a 2-member split column with the arrival below (app-test).
- With the deck scrolling in flow, the miniature's window custom property changes on the same frame cadence as the canvas offset property (app-test reading both properties mid-gesture).
- The flow rail is present whenever the deck is in flow, gains its thumb and raised register only when strip > band, and never mounts/unmounts on the overflow boundary (app-test toggling widths across the boundary and asserting the same element identity).
- `bun test`, `bunx tsc --noEmit`, `bunx vite build`, and the `@covers`-selected app-tests are green at every step boundary.

#### Scope {#scope}

1. Motion census instrumentation in `deck-trace.ts`; findings recorded; census kept as test assertion.
2. Store-level gesture transaction; release-path coalescing; drag-autoscroll transform compensation.
3. `imposer-motion.ts` recipe module; spring choreography table; settle and landing converted; velocity-matched retargeting; doctrine in `tuglaws/pane-model.md`.
4. Division-true zone tiles; body-drop-divides grammar for single-pane slots.
5. `imposer-gauges.ts` channel; fully live miniature (offsets, slides, drag ghost, indicated tile).
6. Flow rail in the bottom band (always-on in flow, register change on overflow, click-to-reveal, thumb drag); horizontal/shift wheel scrolling for the flow strip.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Redesigning the drop-zone vocabulary or hysteresis model (plan-2 [P09]/[P10] stand; hit bands from the 2026-08-20 fix stand).
- Springing `PANE_EXIT_GHOST_MS` — the exit ghost is a departure fade, not a crossing, and stays a fade.
- Animating the miniature's *proposal* layers (hover/cursor previews stay at rest; plan-2 [P06]'s split of committed vs proposal stands — this plan upgrades what "live" means for the committed layer only).
- A vertical twin of the flow rail for overflowing columns (follow-on; see #roadmap).
- Snap guides during ⌘-freed zone drags (documented limitation in `applyZoneDragFrame`, unchanged here).
- Touch/trackpad momentum physics for the wheel gesture (plain 1:1 wheel mapping; momentum arrives with the OS's own wheel events).

#### Dependencies / Prerequisites {#dependencies}

- The imposer2 join (drop-zone engine, hit-rect split `hit`/`rect`, `readSettleMs`, landing FLIP) is on `main` — this plan builds directly on those symbols.
- `SpringSolver`/`GravitySolver`/`FrictionSolver` in `tugdeck/src/components/tugways/physics.ts`; `animate()`/`TugAnimation` in `tug-animator.ts`.
- `window.__deckTrace` (`deck-trace.ts`) as the instrumentation surface.

#### Constraints {#constraints}

- Tuglaws: [L02] store state via `useSyncExternalStore`; [L03] layout-effect registrations; [L06] per-frame appearance via CSS/DOM, never React state; [L13] motion runs through TugAnimator, never hand-rolled rAF; [D135] move and size share a clock; [D6] no retained fill after a tween ends.
- TugAnimator scales durations by `getTugTiming()` — recipes hand it raw ms, as the settle already does.
- Reduced motion: `animate()` replaces spatial tweens under `prefers-reduced-motion`; recipes inherit that for free and must not bypass `animate()`.
- `SpringSolver.keyframes` caps at 300 frames (5s at 60fps) — recipe settle times must stay under the cap with margin.
- App-tests run in background windows where rAF is suspended — motion assertions must be "was the tween started with these keyframes", never "is it mid-flight".
- WARNINGS ARE ERRORS across the workspace; `bunx vite build` before declaring tugdeck work done.

#### Assumptions {#assumptions}

- The census will confirm multiple notifies per release as the dominant flash source; if it reveals an additional source (e.g. a lifecycle listener forcing sync layout), that becomes a finding recorded in the dash log and fixed under the same step's checkpoint.
- Equal-weight division (arriving member weight 1, sitting members their stored weights, absent = 1) is the correct post-drop truth — this is what `railWeightOf` already resolves.
- The build stamps in the bottom band keep their bottom-left corner; the flow rail occupies the band's remaining width.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The three design forks this plan turned on were settled by the owner on 2026-08-20: spring-based motion designed as a system (→ [P02], [P03], Table T01), the miniature fully live including the drag itself (→ [P09]), and the flow rail always standing in flow with a register change on overflow (→ [P10]).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Coalescing reorders focus/lifecycle events | high | med | R01 | any focus app-test regression |
| Spring sampling too coarse or too long | med | low | R02 | visible stepping or >5s settles |
| Gauge channel per-frame cost | med | low | R03 | typing-lag metronome regression |
| Flow rail collides with drop-zone hit space | med | med | R04 | zone selection changes near the bottom band |

**Risk R01: The gesture transaction changes event order around focus** {#r01-transaction-event-order}

- **Risk:** `movePaneToSlot` runs `transferFocusForActivation` (which commits an activation) *before* `_commitImposition`; folding both into one notify changes when subscribers observe the raise. Focus-law surfaces (pane-focus-controller, occlusion) may depend on the two-beat order.
- **Mitigation:** The transaction batches *notifies*, not mutations — mutations run in their current order against `deckState`, and one notify fires at the end holding the final state. Lifecycle will/did callbacks (`notifyCardWillMove`/`DidMove`) keep their bracket around the batched write. The census step lands first, so the before/after event traces are compared, not assumed.
- **Residual risk:** A subscriber that needed the intermediate state (activation without arrival) would break; none is known, and the app-test selection over focus suites (at0294, at0372) gates the step.

**Risk R02: Sampled spring keyframes read as stepping or overrun the cap** {#r02-spring-sampling}

- **Risk:** 300 keyframes at 60fps caps a recipe at 5s; a soft spring could clip, and WAAPI's linear interpolation between samples could read as micro-stepping on large travels.
- **Mitigation:** Recipes are constrained by construction — Table T01's stiffest-to-softest range settles in 200–700ms, far under the cap; unit tests assert every recipe's final frame is 1.0 and its settle time is under 1s. The gallery's spring dot is the visual reference for sampling fidelity at this DT.
- **Residual risk:** None material; DT is 1/60s, matching display cadence.

**Risk R03: Publishing gauges per frame costs on the hot path** {#r03-gauge-cost}

- **Risk:** The autoscroll/wheel/drag frames are pointer-clock hot paths; a gauge write is a style write on extra elements per frame.
- **Mitigation:** The registry is a plain `Set` of elements; a publish is `setProperty` on each — the same class of write `applyScroll` already does once. No layout reads in the publish. The typing-lag guard tests (at0312) stay green as the checkpoint.
- **Residual risk:** Many simultaneous gauges would scale linearly; today there are at most two (miniature, flow rail).

**Risk R04: The flow rail sits where drop-zone geometry and autoscroll edges live** {#r04-rail-hit-space}

- **Risk:** The bottom band is inside the canvas; a rail that claims pointer events there could shadow zone hit bands or the autoscroll edge, and a drag released over the rail must still commit its indicated zone.
- **Mitigation:** The rail is `pointer-events: none` while any zone drag is active (the canvas already stamps drag state; the rail reads the same attribute via CSS). Zone hit rects are clamped to the run above the band (they already are — `runOf` ends at the band's top edge).
- **Residual risk:** Wheel events over the rail scroll the strip — which is the wanted behavior, not a conflict.

---

### Design Decisions {#design-decisions}

#### [P01] A release is one commit: one gesture, one notify (DECIDED) {#p01-one-release-one-notify}

**Decision:** The deck store gains a gesture transaction — `DeckManager.batchGesture(fn)` — that defers `notify()` (and `scheduleSave()`) until `fn` returns, firing exactly one notify over the final state. The drop-zone release path (`onPointerUp`'s zone branch in `tug-pane.tsx`) wraps its work in it: autoscroll `commitScroll`, the zone `commit` (`movePaneToSlot` / `setColumnOrder` / `setRailOrder`), and the activation raise inside `movePaneToSlot` all land as one arrangement change.

**Rationale:**
- The settle animates an arrangement change once (plan-2 [P10]); today a release produces ≥2 notifies (`activateCard` inside `transferFocusForActivation`, then `_commitImposition`) and up to 3 with autoscroll — each one re-arms or retargets the settle, and the retarget path is where the flash lives (`settleTweensRef`'s own `restores` comment describes the stale-size paint).
- Batching notifies rather than reordering mutations keeps every existing invariant: mutations run in their current order; only observation is coalesced (see R01).

**Implications:**
- `batchGesture` must be re-entrant (a nested call joins the outer batch) because `movePaneToSlot` itself calls `transferFocusForActivation` → `activateCard` → `notify`.
- Lifecycle will/did brackets stay synchronous around their mutation, not deferred — cards' resize episodes depend on the will side reading pre-move geometry.
- The motion census ([P12]) is the acceptance instrument: 1 notify, ≤1 settle arm, 0 retargets per release.

#### [P02] Every imposer motion is a spring, from one recipe module (DECIDED) {#p02-springs-from-one-module}

**Decision:** A new `tugdeck/src/lib/imposer-motion.ts` defines the imposer's motion recipes — named spring parameter sets sampled to WAAPI keyframes via `SpringSolver.keyframes()` and played through `animate()` with `easing: "linear"`. Every imposer tween (the settle's crossing, the split/stack fade's moving survivor, the drop landing, the reveal slide, the refusal return) is built by a recipe function; no imposer call site passes raw `duration`/`easing` again.

**Rationale:**
- The owner's direction: motion must be *designed*, not ad-hoc — one place states what an animation is for each way cards move.
- The infrastructure exists and is idiomatic: `SpringSolver` (critically damped by default, `initialVelocity` support, `velocityAt()` for interruption), and the sample-to-keyframes pattern proven in `gallery-animator.tsx`.
- A spring's duration is *derived* from its physics (time to settle within tolerance), not chosen per call site — which is what makes the system coherent: one parameter change retimes a family consistently.

**Implications:**
- `imposer-motion.ts` exports `motionKeyframes(recipe, opts)` returning `{ frames, durationMs }`; call sites map normalized positions onto their own properties (transform/width/height/opacity).
- `IMPOSITION_SETTLE_MS` retires as a duration and survives as the **time-scale**: `--tugx-imposer-settle-duration` (read by `readSettleMs`) becomes the crossing recipe's nominal settle, and every other recipe is stated relative to it, so the one user knob keeps retiming everything.
- TugAnimator's `getTugTiming()` scaling and reduced-motion replacement apply unchanged because recipes still go through `animate()`.
- Fades (opacity) may remain plain eased tweens *inside* the recipe table — a fade has no position to spring — but their durations come from the same table.

#### [P03] The choreography is a stated table, in the doctrine and in code (DECIDED) {#p03-choreography-table}

**Decision:** Table T01 states, per operation class, what moves, what it carries (velocity or none), and which spring it runs on. The table lives in this plan, lands in `tuglaws/pane-model.md` as doctrine, and is transcribed 1:1 into `imposer-motion.ts` as the recipe constants.

**Rationale:**
- "We should *know*, conceptually, what an animation should look like based on the construction of the cards and the way things need to move to make them settle" — the knowing is the table; the code is its transcription.
- A reviewer can diff felt behavior against a stated design instead of against taste.

**Implications:**
- A new motion is added by adding a row, in the doctrine first.
- The unit tests pin each recipe's curve properties (final value 1.0, overshoot bound by its damping ratio, settle under its stated time).

#### [P04] Interruption is velocity-matched retargeting, never a mid-paint restore (DECIDED) {#p04-velocity-matched-retarget}

**Decision:** When a new arrangement lands while a settle tween is in flight, the frame's current normalized progress and velocity (`SpringSolver.velocityAt(elapsed)`) seed a fresh spring toward the new target; the old tween is cancelled `hold-at-current` and the new one starts on the same frame. The `snap-to-end` + `restores` dance in `deck-canvas.tsx`'s settle retires.

**Rationale:**
- The current retarget path finishes the old tween at its end value and hands back inline residue a microtask later — the settle's own comments name the one-frame stale-size paint. Velocity matching removes the discontinuity instead of compensating for it.
- With [P01] a *release* never retargets; this covers the remaining legitimate retargets (a second gesture landing during a settle, a resize retune).

**Implications:**
- Motion recipes accept `initialVelocity`; the settle records launch time + recipe per frame so progress/velocity are recoverable at interruption.
- The census's retarget counter distinguishes "velocity-matched relaunch" (allowed, counted separately) from "snap restore" (must be zero).

#### [P05] A drop's landing inherits the hand's velocity (DECIDED) {#p05-landing-inherits-velocity}

**Decision:** The zone-drop landing FLIP (`landZoneDrop` in `tug-pane.tsx`) launches its spring with `initialVelocity` taken from the pointer's release velocity, projected onto the travel vector and normalized by the travel distance; a stationary release launches at 0.

**Rationale:**
- The moment the polish is felt: a card released mid-motion continues rather than stopping and restarting, which is the difference between physical and mechanical.
- The pointer history needed is already in the drag path (`latestDragPointer` per frame); a two-sample velocity estimate suffices.

**Implications:**
- Velocity is clamped to a stated bound (Table T01) so a flick cannot launch a violent overshoot.
- The refusal return uses the same inheritance — home is a place too, and the hand's motion carries into the return.

#### [P06] A zone's tile is the division the commit will produce (DECIDED) {#p06-division-true-tiles}

**Decision:** `stackTiles` in `drop-zones.ts` retires. A column position's tile is computed by the same weight arithmetic the imposer runs after the drop: build the post-drop order (sitting members with the arrival at the candidate index), resolve fractions with `railSeamFractions(order, shares)` (arriving member absent from `shares` = weight 1, exactly `railWeightOf`'s rule), and cut the run into tiles at those fractions minus `IMPOSITION_GAP_PX` seams. Hit bands (`positionHitBands`) are unchanged.

**Rationale:**
- The tile is a promise about the release; computing it with the commit's own pure function makes the promise unbreakable by construction, where `stackTiles`' current-heights prediction is only right for same-height reorders (the reported defect: a full-height card dropped beside a full-height sitter drew its tile off the band).
- The overflow branch (`overflowTiles`) stays for columns that will overflow — its tiles are the real post-drop strips, and this decision makes the last position's tile land inside the band for the ordinary split case, resolving the drawn-below-the-band confusion noted at the imposer2 join.

**Implications:**
- Reorders within a shares-bearing column show position-true tiles (a wide member's position previews wide).
- `drop-zones.test.ts`'s tile expectations rewrite from stacked-heights arithmetic to fraction arithmetic.

#### [P07] Body-drop divides; the tab bar stacks (DECIDED) {#p07-body-drop-divides}

**Decision:** A single-pane content slot advertises two `column-index` positions (upper half → index 0, lower half → index 1) instead of one whole-`slot` zone; committing one forms a 2-member **split** column. `_impositionWithArrival` in `deck-manager.ts` extends to create the split (mode + order) when an indexed arrival targets a slot that is not yet a split column. A multi-pane **stacked** column keeps today's whole-`slot` join semantics — a stack is an arrangement the user chose, and body-dropping into it joins it. Stacking onto a single card remains available as the tab-bar zone (`onCardMerged`).

**Rationale:**
- The owner's report, verbatim intent: "The drop zone preview should show me *what I'll get when I drop*, which in this case, is a split column down the middle." Under today's grammar that drop z-stacks; the indicated division must be the outcome, so the outcome becomes the division.
- This unifies the grammars: rails already read body positions as placement (`rail-index`) and reserve stacking for explicit gestures; content slots now read the same way.

**Implications:**
- An *empty* slot anchor keeps its whole-`slot` zone (nothing to divide).
- `enumerateDropZones`'s single-pane branch computes places via `columnPlaces` with the sitter as the one member, giving division-true tiles per [P06] and midpoint hit bands for free.
- The origin zone for a card dragged out of its own single-pane slot stays the `slot` zone (its own position; nothing divides).

#### [P08] One gauge channel: per-frame truth published once, consumed anywhere (DECIDED) {#p08-gauge-channel}

**Decision:** A new `tugdeck/src/lib/imposer-gauges.ts` holds a registry: gauges register a DOM element for a named signal (`flow-offset`, `column-offset:<slot>`, `drag-frame`, `drag-zone`), and publishers write CSS custom properties onto every registered element. The canvas's per-frame writers publish: `applyScroll` and the inset effect publish offsets; `applyZoneDragFrame` publishes the dragged frame's canvas rect; `indicate` publishes the indicated zone's rect and kind.

**Rationale:**
- [L06] is why the miniature is blind: per-frame motion must never route through React state. The channel extends [L06]'s own mechanism — custom-property writes — across subtrees, so any instrument can be live without a single render.
- One publish point per signal keeps the deck's one-resolution rule: the miniature and the flow rail read the same numbers the frames read, so instruments and deck cannot part company.

**Implications:**
- Registration happens in layout effects ([L03]) and is torn down with them; the registry is a module-level `Map<string, Set<HTMLElement>>` — no store, no state.
- Committed values keep flowing through the store as today; gauges carry only the *between-commits* motion. A gauge element's CSS must therefore compose `var(--gauge-…, <committed fallback>)` so rest states need no publisher.
- Publishers write only when a subscriber set is non-empty (a `Set.size` check), so the channel costs nothing when no instrument is mounted.

#### [P09] The miniature is fully live (DECIDED) {#p09-miniature-fully-live}

**Decision:** The committed `LayoutMiniature` becomes a full instrument: its flow window and overflow slide positions ride the gauge channel per frame, and during a zone drag it draws the drag itself — a ghost tile following the dragged frame's published rect (scaled into the miniature's space) and a highlight on the indicated zone's place. Supersedes plan-2 [P07] (CSS transitions between committed states) for the committed layer's motion; proposal layers stay at rest per plan-2 [P06].

**Rationale:**
- The owner's call: the miniature must "accurately reflect the disposition of the cards *live*", and mirroring the drag is the difference between a diagram and an instrument.
- Everything needed is already published under [P08]; the miniature's cost is CSS `calc()` over custom properties it registered for.

**Implications:**
- The miniature's window element position converts from inline-style-from-props to `calc()` over `--gauge-flow-offset` with the committed offset as fallback; same for column slides.
- Commit-driven moves (a reveal-on-activation, a Layouts click) still glide: the window keeps a CSS transition for those jumps, disabled while a publisher is live (`data-gauge-drag` / a publishing attribute) so per-frame gauge writes are never double-smoothed through a transition.
- The scale mapping (canvas px → miniature %) is written as custom properties at render time from the props the section already passes (`flowBandPx`, `slotExtents`), so the per-frame path stays pure CSS.
- The drag ghost/highlight elements exist only while `drag-frame` publishes (a `data-` attribute the publisher sets on registered elements gates their visibility) — no render per drag.

#### [P10] The flow rail always stands in flow; overflow is a register change (DECIDED) {#p10-flow-rail-register}

**Decision:** A new flow rail component renders in the deck's bottom band (`IMPOSITION_GAP_BOTTOM_PX`) whenever the layout is flow: a strip of numbered slot segments proportional to the real `slotExtents`, right of the build stamps. When strip ≤ band it stands quiet — low-emphasis ticks and digits, no thumb. When strip > band it changes register, never component: a `data-overflow` attribute raises emphasis via CSS and reveals the window thumb. The element never mounts or unmounts on the overflow boundary.

**Rationale:**
- The owner's call, verbatim intent: always on, "*more visually prominent* when the strip overflows… only a change in register, rather than making a whole new component appear."
- The band is already reserved and already meaningfully "the deck's margin" — the rail furnishes it rather than claiming card space.

**Implications:**
- Structure (segment count, widths, digits) renders from the store ([L02]); the thumb's position rides the gauge channel ([P08]).
- Digits match the Cards control's segments (`1 2 3 4 5 6`).
- `pointer-events` are disabled during a zone drag (R04).

#### [P11] Direct scroll: wheel, thumb, and segment all drive the one offset path (DECIDED) {#p11-direct-scroll}

**Decision:** Three gestures move the flow strip, all through the existing discipline (per-frame CSS writes, one store commit at gesture end): (a) horizontal wheel — and shift+vertical wheel — on the canvas, committed on a wheel-idle timeout; (b) dragging the rail's thumb, committed on pointerup; (c) clicking a numbered segment, which commits a minimal reveal of that slot (the same arithmetic as `_flowRevealOffsetFor`) and lets the settle animate the crossing.

**Rationale:**
- Today flow has *no* direct scroll gesture; the rail shows position, the trackpad is how people move.
- Reusing `applyScroll`/`commitScroll`'s shape keeps [P01]'s one-commit rule and [L06]'s per-frame rule without new machinery.

**Implications:**
- The wheel handler must respect card-content scrollers: it acts only when the event's target chain reaches the canvas without crossing a scrollable card region (the deck's existing wheel-routing conventions in `use-outer-scroll-on-modifier-wheel.ts` are the reference for the routing test).
- Wheel-gesture accumulation lives in refs; the idle-commit timeout is the gesture's end.

#### [P12] Diagnosis first: the motion census is built, read, and kept (DECIDED) {#p12-motion-census}

**Decision:** Before any coalescing, `deck-trace.ts` gains motion-census records — store notifies (with caller tags), settle arms, settle retargets (matched vs snap), and per-gesture grouping — exposed via `window.__deckTrace`. The census is read during reproduction, its findings land in the dash log, and it stays as the assertion instrument for [P01]'s checkpoint and at0450's census family.

**Rationale:**
- "Track this down" means counted facts, not plausible stories; three suspects are already named (multi-notify, autoscroll base slide, retarget restore) and the census ranks them before surgery.
- Keeping the census makes the butter bar falsifiable forever: a future regression trips a number, not a feeling.

**Implications:**
- Census hooks are dev/test-build instrumentation on the existing trace surface — zero production-path cost beyond a branch.
- at0450 gains a `release` census case asserting the [P01] numbers.

---

### Deep Dives {#deep-dives}

#### The three named flash sources, with their mechanisms {#flash-sources}

1. **Multi-notify releases.** `movePaneToSlot` (deck-manager.ts) runs `transferFocusForActivation` whose `commitMutation` calls `activateCard` — a full commit+notify that may also carry a flow reveal — *then* `_commitImposition` notifies again. A drag that autoscrolled adds `commitScroll` → `setFlowOffset` (a third notify) before the zone commit. Each notify re-runs `arrangementSignature`; a changed signature arms the settle, and an arm landing mid-flight takes the retarget path.
2. **The retarget restore.** `settleTweensRef`'s doc in `deck-canvas.tsx` describes it: `snap-to-end` bakes the old tween's final pixels into inline style; the restore runs a microtask later; the frame paints once at a stale size against fresh calc geometry. [P04] removes the mechanism rather than tightening the timing.
3. **The autoscroll base slide.** `applyZoneDragFrame` writes `transform: translate(pointer − start)` while the frame's `left` is a calc over `--tug-imposer-flow-offset`; `advanceAutoscroll` moves that property, so the base slides under a transform that doesn't know. The fix: track scroll-delta-at-grab and add `(offsetAtGrab − offsetNow)` to the transform's x (sign per axis for column autoscroll), so the card stays pinned to the hand. The re-enumeration after `advanceAutoscroll` already re-measures zones; only the frame's own travel needs the compensation.

#### Spring recipes: how a call site uses one {#spring-recipe-usage}

```
const { frames, durationMs } = motionKeyframes("landing", {
  initialVelocity: v,          // normalized /s along the travel; 0 default
});
animate(el, frames.map(p => ({ transform: `translate(${(1-p)*dx}px, ${(1-p)*dy}px)` })), {
  duration: durationMs,        // raw ms; TugAnimator scales by getTugTiming()
  easing: "linear",            // physics is in the frames
  fill: "none",                // [D6]
  key: "zone-drop-landing",
});
```

The recipe returns *normalized* positions (0→1, overshoot possible); the call site owns the mapping onto its properties. Multi-term tweens (translate + width + height in the settle) map every term from the same frames array, which is [D135] by construction — one clock because one curve. The settle's own duration read-back (`readSettleMs`) becomes the nominal that scales the whole table: `motionKeyframes` takes `nominalMs` from the caller (the canvas reads it once per gesture, as today) and each recipe states its timing as a multiple of the crossing's.

#### The gauge channel's property contract {#gauge-contract}

Publishers write, per signal: `--gauge-flow-offset: <px>`, `--gauge-column-offset-<slot>: <px>`, `--gauge-drag-x/y/w/h: <px>` (canvas coordinates), `--gauge-zone-x/y/w/h: <px>` plus `--gauge-zone-kind`. Registered elements also receive `data-gauge-drag="true|false"` so pure CSS can gate drag-only affordances. Consumers convert coordinates in CSS: the miniature sets `--mini-scale-x` etc. at render from the same props it already draws from, and positions children with `calc(var(--gauge-drag-x) * var(--mini-scale-x))`. On unregistration the publisher-written properties are removed so a remounted gauge starts at rest.

#### Why the flow rail's structure is cheap to keep honest {#flow-rail-structure}

Everything the rail draws at rest is already computed for the miniature: `deckFlowStrip(state)` gives per-slot extents, `getFlowBandWidth()` the band, `deck.flowOffset` the committed offset. The section-level plumbing in `layouts-section.tsx` (`useCommittedFlow`) is the reference implementation; the rail does the same reads canvas-side where the store is at hand. Only the thumb moves per frame, and it rides `--gauge-flow-offset` with the committed offset as fallback — the identical composition the miniature's window uses, which is how the two instruments are guaranteed to agree.

---

### Specification {#specification}

**Table T01: The imposer motion choreography** {#t01-choreography}

Damping ratio ζ: 1.0 = critically damped (no overshoot); < 1.0 overshoots once, proportionally. Timing is stated relative to the crossing's nominal (`--tugx-imposer-settle-duration`, 360ms shipped). Velocity carry is the normalized initial velocity source.

| Recipe | Operation class | What moves | ζ | Nominal settle | Velocity carry |
|--------|----------------|------------|---|----------------|----------------|
| `crossing` | A settled arrangement change: frames travel/resize to new places (the settle) | transform + width/height, one curve | 1.0 | 1.0× | from interrupted tween ([P04]), else 0 |
| `landing` | A dropped card entering its zone; the refusal's return home | transform | 0.9 | 0.85× | pointer release velocity, clamped ([P05]) |
| `reveal` | The strip or a column sliding to show an activated member | offset property (via the settle's crossing of every riding frame) | 1.0 | 1.0× | 0 |
| `divide-join` | A member arriving in / leaving a divided place (rail or column mode flip) | opacity fade (plain ease; fades have no position); the survivor moves on `crossing` | — | 0.6× | — |
| `refusal-flash` | The blocked-gesture pane flash (existing `flashCardPane`) | unchanged, outside the imposer family | — | — | — |

Bounds: `landing`'s clamped initial velocity ≤ 3.0 normalized/s; every recipe's 0.1%-settle time must stay under 1s at nominal (unit-tested).

**Spec S01: The gesture transaction** {#s01-gesture-transaction}

`batchGesture<T>(fn: () => T): T` on `DeckManager`: increments a depth counter; while depth > 0, `notify()` sets a pending flag instead of calling subscribers and `scheduleSave()` defers; on outermost exit, if pending, one real `notify()` fires, then one `scheduleSave()`. Lifecycle callbacks (`notifyCardWillMove` etc.) are *not* deferred. Exposed through `deck-manager-store.ts` for the pane's release path. `DeckManager` is browser-coupled (window timers, tugbank, lifecycle) and no unit test constructs one, so the semantics are exercised at the app layer: an app-test drives the live store over `evalJS` — nested batches, exception safety (notify still fires once on throw), zero-mutation batches notify nothing — and the motion census covers the integrated release path.

**Spec S02: Zone grammar after [P07]** {#s02-zone-grammar}

| Place under the pointer | Zones advertised | Commit |
|------------------------|------------------|--------|
| Empty slot anchor | 1 whole-`slot` | `movePaneToSlot(id, slot)` |
| Single-pane slot (foreign) | 2 `column-index` (0, 1), division-true tiles, midpoint hit bands | `movePaneToSlot(id, slot, index)` — creates the split via extended `_impositionWithArrival` |
| Single-pane slot (own) | 1 whole-`slot` (origin) | no-op success |
| Split column (foreign) | N+1 `column-index` | as today |
| Split column (own) | N `column-index` | `setColumnOrder` as today |
| Stacked multi-pane column | 1 whole-`slot` (join the stack) | `movePaneToSlot(id, slot)` as today |
| Tab bar | `tab-bar` | merge via `onCardMerged`, as today |
| Rail | `rail-index` family | as today |

**Spec S03: Flow rail anatomy** {#s03-flow-rail}

One `flow-rail` element inside the canvas, absolutely positioned in the bottom band, left edge clear of the build stamps' reserved corner, right edge at the band's end. Children: per occupied slot a `flow-rail-segment` (flex-basis proportional to that slot's extent) carrying its digit; one `flow-rail-thumb` overlay whose left/width derive from `--gauge-flow-offset` and the band/strip proportions (custom properties written at render). States: `data-overflow="false"` — ticks and digits at rail-quiet emphasis, thumb hidden; `data-overflow="true"` — raised emphasis, thumb visible. During a zone drag (`data-gauge-drag` on the canvas), `pointer-events: none`.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Motion recipes (Table T01 constants) | none — pure module constants | `imposer-motion.ts` exports | — |
| In-flight tween bookkeeping (launch time, recipe, velocity) | appearance | refs/Maps in `deck-canvas.tsx`/`tug-pane.tsx`, DOM zone | [L06] |
| Gesture-transaction depth/pending | structure (store internals) | private fields on `DeckManager` | [L02] |
| Gauge registry (signal → elements) | appearance | module `Map` in `imposer-gauges.ts`; registration in layout effects | [L06], [L03] |
| Per-frame offsets/drag rect on gauges | appearance | CSS custom properties written by publishers | [L06] |
| Miniature scale factors | appearance derived from props | custom properties written at render | [L06] |
| Flow rail structure (segments, digits, overflow bit) | structure | store snapshot via `useSyncExternalStore` | [L02] |
| Flow rail thumb position | appearance | `calc()` over `--gauge-flow-offset` | [L06] |
| Wheel gesture accumulation + idle timer | appearance | refs in the canvas; store write at gesture end | [L06], [L02] |
| Motion census records | diagnostics | `deck-trace.ts` ring buffers | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/imposer-motion.ts` | Motion recipes (Table T01), `motionKeyframes()`, velocity clamp, settle-time derivation |
| `tugdeck/src/lib/imposer-gauges.ts` | Gauge registry: `registerGauge()`, `publishGauge()`, property contract (#gauge-contract) |
| `tugdeck/src/components/chrome/flow-rail.tsx` | The flow rail (Spec S03) |
| `tugdeck/src/components/chrome/flow-rail.css` | Rail styles, quiet/overflow registers |
| `tugdeck/src/lib/__tests__/imposer-motion.test.ts` | Recipe curve properties, velocity matching, table bounds (pure math — no DOM needed) |
| `tests/app-test/at0458-flow-rail.test.ts` | Rail presence, register change, click-to-reveal, thumb drag, wheel |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `batchGesture` | method | `tugdeck/src/deck-manager.ts` + `deck-manager-store.ts` | Spec S01 |
| `_impositionWithArrival` | method (extend) | `tugdeck/src/deck-manager.ts` | creates split on indexed arrival into non-split slot ([P07]) |
| `motionKeyframes`, `MotionRecipe` | fn/type | `tugdeck/src/lib/imposer-motion.ts` | [P02], Table T01 |
| `registerGauge`, `publishGauge` | fn | `tugdeck/src/lib/imposer-gauges.ts` | [P08] |
| `columnPlaces` | fn (rewrite tiles) | `tugdeck/src/lib/drop-zones.ts` | division-true via `railSeamFractions` ([P06]); `stackTiles` deleted |
| `enumerateDropZones` | fn (extend) | `tugdeck/src/lib/drop-zones.ts` | single-pane slot positions ([P07], Spec S02) |
| settle arm/Last effects | rework | `tugdeck/src/components/chrome/deck-canvas.tsx` | recipes + velocity-matched retarget ([P02], [P04]) |
| `landZoneDrop`, `applyZoneDragFrame` | rework | `tugdeck/src/components/chrome/tug-pane.tsx` | landing recipe + velocity ([P05]); autoscroll compensation (#flash-sources) |
| release path in `onPointerUp` | rework | `tugdeck/src/components/chrome/tug-pane.tsx` | wrapped in `batchGesture` ([P01]) |
| motion census records | add | `tugdeck/src/deck-trace.ts` | [P12] |
| `SpringSolver.settleTimeMs` | method | `tugdeck/src/components/tugways/physics.ts` | first t where \|x−1\| and \|v\| within tolerance; used to derive durations |
| miniature live layer | rework | `tugdeck/src/components/lens/layout-miniature.tsx` (+css) | gauge registration, drag ghost ([P09]) |
| wheel routing | add | `tugdeck/src/components/chrome/deck-canvas.tsx` | [P11] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/pane-model.md`: the motion choreography (Table T01 as doctrine), the gesture-transaction rule (one release, one notify), the body-drop-divides grammar (Spec S02 rows), the gauge channel, the flow rail.
- [ ] `tuglaws/design-decisions.md`: no new global entries expected; plan-local decisions suffice unless review promotes one.
- [ ] Module docs in the three new `lib`/`chrome` files carry their contracts (#gauge-contract, Spec S03).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure geometry and physics: recipe curves, division-true tiles | `imposer-motion.test.ts`, `drop-zones.test.ts` |
| **Integration (app-test)** | Real gestures on the real deck: census numbers, drag pinning, transaction semantics on the live store, live gauges, rail behavior | at0450 family, at0457, new at0458 |
| **Golden / Contract** | The gauge property contract and rail DOM anatomy asserted against real elements in the app | at0357/at0359/at0454 gauge cases, at0458 |
| **Drift Prevention** | The census assertions stay in at0450 so butter regressions trip numbers | at0450 release case |

#### What stays out of tests {#test-non-goals}

- Perceived smoothness — the census counts (notifies, arms, retargets) and started-tween assertions are the proxies; "does it feel like butter" is the owner's hand-test at each integration checkpoint. Background app-test windows suspend rAF, so mid-flight sampling is banned by construction.
- jsdom render tests and mock-store assertions — banned shapes; store tests run the real `DeckManager`, DOM tests run in the real app.
- Screenshot comparisons of the miniature — liveness is asserted via the gauge properties on its real elements, which is the mechanism itself.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | M01 — the motion census | done | `430c03495` |
| #step-2 | M01 — one release, one notify | in progress | — |
| #step-3 | M01 — the drag stays pinned under autoscroll | pending | — |
| #step-4 | M01 — motion recipes and the springing of the settle | pending | — |
| #step-5 | M01 — integration checkpoint | pending | — |
| #step-6 | M02 — division-true tiles | pending | — |
| #step-7 | M02 — body-drop divides | pending | — |
| #step-8 | M02 — integration checkpoint | pending | — |
| #step-9 | M03 — the gauge channel | pending | — |
| #step-10 | M03 — the miniature goes live | pending | — |
| #step-11 | M03 — the miniature mirrors the drag | pending | — |
| #step-12 | M03 — integration checkpoint | pending | — |
| #step-13 | M04 — the flow rail, standing | pending | — |
| #step-14 | M04 — the rail moves things: thumb, segments, wheel | pending | — |
| #step-15 | M04 — integration checkpoint | pending | — |

**Milestone M01: Butter** {#m01-butter} · **Milestone M02: Truthful zones** {#m02-truthful-zones} · **Milestone M03: Live miniature** {#m03-live-miniature} · **Milestone M04: Flow rail** {#m04-flow-rail}

#### Step 1: M01 — the motion census {#step-1}

**Commit:** `tugdeck(imposer-polish): the motion census counts what a gesture costs`

**References:** [P12] Motion census, (#flash-sources, #strategy)

**Artifacts:**
- Census records in `deck-trace.ts`: notify (with caller tag), settle arm, settle retarget (matched/snap), grouped per gesture; `__deckTrace` dump support.
- A diagnostic pass over the three named suspects with the counted results written into the dash log.

**Tasks:**
- [ ] Add census record types and ring-buffer plumbing to `deck-trace.ts`; tag `notify()` call sites through an optional caller argument (default `"untagged"`).
- [ ] Hook the settle's arm and retarget paths in `deck-canvas.tsx` to emit records.
- [ ] Reproduce a cross-slot drop, an autoscrolled drop, and a same-zone release on a live debug build; record the per-gesture counts and which suspect each confirms.

**Tests:**
- [ ] Extend `at0450-imposer-cut-census.test.ts`'s helper to read the new records; add a diagnostic (non-asserting) release case that prints the counts via `note()`.

**Checkpoint:**
- [ ] `just app-test at0450` — green, with the release counts visible in Diagnostics.
- [ ] Counts for the three gestures recorded in the dash log.

---

#### Step 2: M01 — one release, one notify {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer-polish): a release is one commit — the gesture transaction`

**References:** [P01] One release one notify, Spec S01, Risk R01, (#flash-sources)

**Artifacts:**
- `batchGesture` on `DeckManager` and `deck-manager-store.ts`; the zone-drop release path wrapped.

**Tasks:**
- [ ] Implement Spec S01 (re-entrant depth, pending flag, exception safety; lifecycle brackets not deferred).
- [ ] Wrap the zone branch of `onPointerUp` in `tug-pane.tsx`: autoscroll commit, zone commit, and the landing measurement inside one batch.
- [ ] Flip at0450's diagnostic release case to assert: 1 notify, ≤1 settle arm, 0 snap retargets per release.

**Tests:**
- [ ] App-test case driving `batchGesture` on the live store over `evalJS`: nesting, throw path, no-mutation batch (Spec S01's semantics at the layer the store actually runs in).
- [ ] at0450 release census assertions; at0457 unchanged and green.

**Checkpoint:**
- [ ] `bun test` green; `just app-test at0450 at0457 at0294 at0372` green (focus suites gate R01).

---

#### Step 3: M01 — the drag stays pinned under autoscroll {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer-polish): the dragged card stays under the hand while the strip slides`

**References:** [P01], (#flash-sources), Risk R04

**Artifacts:**
- Offset compensation in `applyZoneDragFrame` (`tug-pane.tsx`): the transform adds the scroll delta since grab on the autoscrolled axis, flow and column alike.

**Tasks:**
- [ ] Record the autoscroll target's offset at grab (and on target change); add `(offsetAtGrab − offsetNow)` to the transform term for that axis.
- [ ] Verify the release measurement (`pendingZoneDropRef`'s `from` rect) is taken from the live DOM and therefore already correct under compensation.

**Tests:**
- [ ] at0457 gains a case: drag into the autoscroll edge, let the strip advance a known delta, assert the frame's bounding rect tracked the pointer within 1px.

**Checkpoint:**
- [ ] `just app-test at0457` green with the new case discriminating (probe: disable the compensation, watch it fail).

---

#### Step 4: M01 — motion recipes and the springing of the settle {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(imposer-polish): every imposer motion runs on a designed spring`

**References:** [P02] Springs from one module, [P03] Choreography table, [P04] Velocity-matched retarget, [P05] Landing inherits velocity, Table T01, Risk R02, (#spring-recipe-usage)

**Artifacts:**
- `imposer-motion.ts` with Table T01 transcribed; `SpringSolver.settleTimeMs`; the settle, the landing, the refusal return, and the divide-join fade consuming recipes; the `snap-to-end` retarget replaced by velocity-matched relaunch; pointer release velocity feeding the landing.
- Table T01 in `tuglaws/pane-model.md` as doctrine.

**Tasks:**
- [ ] Implement `motionKeyframes` + recipes; derive durations from `settleTimeMs` scaled by the caller's nominal (`readSettleMs` value).
- [ ] Convert `deck-canvas.tsx`'s settle (crossing + fades) and `tug-pane.tsx`'s `landZoneDrop` (landing, with velocity estimate from the last drag frames, clamped per T01).
- [ ] Replace the retarget path: cancel `hold-at-current`, relaunch from current progress/velocity; delete the `restores` machinery.
- [ ] Write the doctrine section.

**Tests:**
- [ ] `imposer-motion.test.ts`: final frame 1.0, overshoot bounded by ζ, settle under 1s, velocity clamp, relative timings per T01.
- [ ] at0450 full census green (0 cuts as before, 0 snap retargets now).

**Checkpoint:**
- [ ] `bun test` + `bunx tsc --noEmit` + `bunx vite build` green; `just app-test-changed` green; grep confirms no raw `easing:` in the imposer paths of `deck-canvas.tsx`/`tug-pane.tsx`.

---

#### Step 5: M01 — integration checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P01]–[P05], [P12], (#success-criteria)

**Tasks:**
- [ ] Verify the census numbers across all three gesture reproductions from #step-1 now meet [P01]'s bar.
- [ ] Build and hand off for the owner's hand-feel pass (`just app-debug` from the worktree) — butter is accepted by hand, gated by numbers.

**Tests:**
- [ ] Aggregate: `just app-test at0450 at0455 at0456 at0457 at0401` green.

**Checkpoint:**
- [ ] All listed app-tests green; census assertions standing; owner sign-off on feel before M02 proceeds.

---

#### Step 6: M02 — division-true tiles {#step-6}

**Depends on:** #step-4

**Commit:** `tugdeck(imposer-polish): a zone's tile is the division the commit will produce`

**References:** [P06] Division-true tiles, Spec S02, (#context)

**Artifacts:**
- `columnPlaces` computing tiles from `railSeamFractions` over the post-drop order; `stackTiles` deleted; rail zones likewise division-true (they share the fraction path already — verify and pin).

**Tasks:**
- [ ] Thread the member weights into `columnPlaces` — `DeckColumn` carries `seams`, not weights, so `enumerateDropZones` reads `state.imposition.columns?.[slot]?.shares` (the same record `deckColumnsOf` resolves seams from) and passes per-member weights keyed by pane id, arrival absent = 1; build the candidate order per index; cut the run at `railSeamFractions(order, weights)` minus seams; keep `overflowTiles` for post-drop overflow counts.
- [ ] Rewrite `drop-zones.test.ts` tile expectations to fraction arithmetic; add a shares-bearing reorder case (unequal members preview position-true).

**Tests:**
- [ ] Unit: equal 2-split tile = (run − gap)/2 exact; unequal-shares reorder tiles; overflow boundary count.
- [ ] at0457 tile-facing assertions updated if any pin the old arithmetic.

**Checkpoint:**
- [ ] `bun test` green; `just app-test at0457` green.

---

#### Step 7: M02 — body-drop divides {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(imposer-polish): dropping on a card's lower half splits the column down the middle`

**References:** [P07] Body-drop divides, Spec S02, [P06], (#context)

**Artifacts:**
- `enumerateDropZones` advertising two positions over a foreign single-pane slot; `_impositionWithArrival` creating the split (mode `"split"` + order) on indexed arrival into a non-split slot; stacked multi-pane columns unchanged.

**Tasks:**
- [ ] Implement the single-pane branch via `columnPlaces` with the sitter as sole member.
- [ ] Extend `_impositionWithArrival`; confirm `sweptColumnOrders` keeps the record honest when the arrival is later dragged away (the join fix from 2026-08 covers leaving; add a test for the created-then-emptied split).
- [ ] Update the zone-grammar rows in `tuglaws/pane-model.md`.

**Tests:**
- [ ] Unit: single-pane slot advertises indices 0/1 with half-run tiles and midpoint hit bands; own slot still yields the origin `slot` zone; empty anchor unchanged.
- [ ] at0457 gains the defining case: drop a full-height card on the lower half of a one-card slot → assert a 2-member split column with the arrival at index 1, and that the indicated tile equaled the landed rect.

**Checkpoint:**
- [ ] `bun test` green; `just app-test at0457 at0450` green.

---

#### Step 8: M02 — integration checkpoint {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P06], [P07], Spec S02, (#success-criteria)

**Tasks:**
- [ ] Walk Spec S02's table against the live build: every row's advertised zones and outcomes verified by hand once, tiles matching landings.

**Tests:**
- [ ] Aggregate: `just app-test-changed` over the M02 diff.

**Checkpoint:**
- [ ] Selection green; owner confirms the screenshot scenario now previews and lands the split.

---

#### Step 9: M03 — the gauge channel {#step-9}

**Depends on:** #step-4

**Commit:** `tugdeck(imposer-polish): one gauge channel publishes the deck's per-frame truth`

**References:** [P08] Gauge channel, Risk R03, (#gauge-contract)

**Artifacts:**
- `imposer-gauges.ts` (registry, publish, property contract, removal-on-unregister); publishers wired: `applyScroll`, the inset effect's offset writes, `applyZoneDragFrame`, `indicate`.

**Tasks:**
- [ ] Implement the registry with empty-set fast path; document the contract in the module doc.
- [ ] Wire the four publishers; set/clear `data-gauge-drag` at zone-drag begin/end.

**Tests:**
- [ ] Gauge property lifecycle (register/publish/unregister, multi-gauge fan-out, removal on unregister) asserted on real elements at the app layer — bun tests have no DOM substrate, so these land as an app-test case riding the first consumer (extended in #step-10/#step-11); this step ships the module compile-clean with its contract documented.
- [ ] at0312-focus-attr-stability typing-lag guards stay green (R03).

**Checkpoint:**
- [ ] `bun test` + `bunx tsc --noEmit` green; `just app-test at0312-focus-attr-stability` green.

---

#### Step 10: M03 — the miniature goes live {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(imposer-polish): the miniature's window rides the deck's own frames`

**References:** [P09] Miniature fully live, [P08], (#flow-rail-structure)

**Artifacts:**
- The committed `LayoutMiniature`'s flow window and column slides positioned by `calc()` over gauge properties with committed fallbacks; scale factors as render-time custom properties; gauge registration in a layout effect.

**Tasks:**
- [ ] Convert the window/slide styles; register/unregister with the drawing's lifecycle; keep proposal layers untouched (plan-2 [P06]).
- [ ] Keep the committed-jump CSS transition, gated off while a publisher is live (plan-2 [P07] superseded only for gauge-carried motion).

**Tests:**
- [ ] Miniature assertions in at0357 / at0359 / at0454 (the `@covers` set for `layout-miniature.tsx`) updated to read the composed properties; new app-test case: scroll the deck (autoscroll or wheel once #step-14 lands — until then, reveal-on-activation) and assert the miniature's gauge property changed while no Lens re-render occurred (render counter via existing dev hooks).

**Checkpoint:**
- [ ] `just app-test-changed` green; hand-check: the window tracks a reveal glide frame-for-frame.

---

#### Step 11: M03 — the miniature mirrors the drag {#step-11}

**Depends on:** #step-10

**Commit:** `tugdeck(imposer-polish): the miniature shows the drag itself`

**References:** [P09], [P08], (#gauge-contract)

**Artifacts:**
- Drag ghost + indicated-zone highlight elements in the committed drawing, visible only under `data-gauge-drag`, positioned by `calc()` over the drag/zone gauge properties and the miniature's scale factors.

**Tasks:**
- [ ] Add the two elements + CSS; no React involvement in their motion or visibility.
- [ ] Ensure ⌘-freed stretches (zone null) hide the highlight but keep the ghost, matching the canvas's own indication rules ([P13] of plan-2).

**Tests:**
- [ ] App-test: begin a zone drag, move to a known zone, assert the miniature's ghost/highlight properties correspond (scaled rects within tolerance); release and assert both retire.

**Checkpoint:**
- [ ] `just app-test-changed` green.

---

#### Step 12: M03 — integration checkpoint {#step-12}

**Depends on:** #step-10, #step-11

**Commit:** `N/A (verification only)`

**References:** [P08], [P09], (#success-criteria)

**Tasks:**
- [ ] Hand pass: drag cards around a Four Up flow deck with the Lens open — the miniature is a live map throughout (offsets, slides, ghost, highlight), with zero added renders during motion.

**Tests:**
- [ ] Aggregate: `just app-test-changed` over the M03 diff.

**Checkpoint:**
- [ ] Selection green; owner sign-off on the live miniature.

---

#### Step 13: M04 — the flow rail, standing {#step-13}

**Depends on:** #step-9

**Commit:** `tugdeck(imposer-polish): the flow rail stands in the deck's bottom band`

**References:** [P10] Flow rail register, Spec S03, Risk R04, (#flow-rail-structure)

**Artifacts:**
- `flow-rail.tsx`/`.css` rendered by `deck-canvas.tsx` whenever layout is flow: segments, digits, quiet register; `data-overflow` register flip; thumb element present but hidden when quiet; drag-time `pointer-events: none`.

**Tasks:**
- [ ] Build structure from the store snapshot (extents, band, offset); write the thumb's proportion properties; register the thumb as a `flow-offset` gauge.
- [ ] Place the rail clear of the build stamps' corner; theme-token styling only (audit budget respected).

**Tests:**
- [ ] New `at0458-flow-rail.test.ts` (with `@covers`): present in flow, absent in fit; same element identity across the overflow boundary (width preset flips); register attributes correct on both sides.

**Checkpoint:**
- [ ] `just app-test at0458` green; `bun run audit:theme-contrast` green.

---

#### Step 14: M04 — the rail moves things: thumb, segments, wheel {#step-14}

**Depends on:** #step-13

**Commit:** `tugdeck(imposer-polish): flow scrolls by hand — thumb, segment, and wheel`

**References:** [P11] Direct scroll, [P01], Spec S03, (#gauge-contract)

**Artifacts:**
- Thumb drag (per-frame `applyScroll`-style property writes, one `setFlowOffset` on release, inside `batchGesture`); segment click → minimal reveal of that slot; horizontal + shift-wheel routing on the canvas with idle-timeout commit.

**Tasks:**
- [ ] Implement the three gestures against the one offset path; wheel routing respects card scrollers (reference: `use-outer-scroll-on-modifier-wheel.ts` conventions).
- [ ] Clamp all three to the strip bounds via `clampFlowOffset`'s arithmetic (the store clamps on commit; the per-frame writes clamp identically so the frame never shows an overshoot the commit rejects).

**Tests:**
- [ ] at0458: thumb drag moves the strip and commits once (census); segment click reveals the slot with a crossing (no cut, per at0450's detector); wheel scrolls and commits after idle; a wheel over a card's own scroller does not move the strip.

**Checkpoint:**
- [ ] `just app-test at0458 at0450` green.

---

#### Step 15: M04 — integration checkpoint {#step-15}

**Depends on:** #step-13, #step-14

**Commit:** `N/A (verification only)`

**References:** [P10], [P11], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full doctrine sweep: `tuglaws/pane-model.md` carries the choreography table, the transaction rule, the zone grammar, the gauge channel, and the flow rail; Files tables updated.
- [ ] Owner hand pass on the complete polish: butter, truthful zones, live miniature, flow rail — one session, all four together.

**Tests:**
- [ ] Aggregate: `just app-test-changed` over the full plan diff, plus `just app-test at0450 at0457 at0458`.

**Checkpoint:**
- [ ] All green; `bunx vite build` clean; ledger complete.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A layout imposer whose motion is designed (one spring choreography, one commit per gesture, velocity-carried landings), whose drop zones preview exactly what they deliver, whose Lens miniature is a fully live instrument, and whose flow mode is visibly positioned and directly scrollable from a numbered rail in the deck's bottom band.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Motion census: 1 notify / ≤1 arm / 0 snap retargets per release, asserted in at0450 (verification: app-test).
- [ ] No raw easing/duration in imposer call sites; all motion from Table T01 recipes (verification: grep + unit tests).
- [ ] Spec S02's zone table holds on the live deck, tiles equal landings (verification: at0457 + hand walk).
- [ ] Miniature live during scroll and drag with zero motion-driven renders (verification: at0357/at0359/at0454 + render counter).
- [ ] Flow rail standing, register-changing, and driving the strip by thumb, segment, and wheel (verification: at0458).

**Acceptance tests:**
- [ ] `bun test` — full unit suite green.
- [ ] `just app-test at0450 at0457 at0458` plus `just app-test-changed` over the final diff — green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A vertical rail twin for overflowing columns (the same gauge + register pattern down the y axis).
- [ ] Momentum/deceleration physics for wheel scrolling (`FrictionSolver` is already in `physics.ts`).
- [ ] Snap guides during ⌘-freed zone drags.

| Checkpoint | Verification |
|------------|--------------|
| M01 butter | at0450 census assertions + owner hand pass |
| M02 truthful zones | at0457 split-on-drop case + Spec S02 hand walk |
| M03 live miniature | gauge-property app-tests + owner hand pass |
| M04 flow rail | at0458 + full-diff selection green |
