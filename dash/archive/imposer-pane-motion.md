## Imposer pane motion — the walk-free FLIP settle {#imposer-pane-motion}

**Purpose:** Replace the imposer's arrangement-settle motion — previously a CSS transition of `left`/`top`/`bottom`/`width` that relayouted every moving pane on every frame — with a FLIP-style, fully-accelerated, transform-only tween run through **TugAnimator**, paying a fixed handful of compositing walks per gesture and zero per frame. (Measured: three walks per gesture, not the two the animation alone accounts for — React's commit of the new geometry is the third; see the brief's S5 record.) The data-clock freeze was decided by measurement, not assumed — [Q02] ruled it in, and the notification hold shipped as Step 7. This is S5 of `dash/jul30-perf-brief.md#s5-imposer`.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | complete — all steps landed; measured on release |
| Target branch | main (interactive) or dash worktree per user's call |
| Last updated | 2026-07-30 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The jul30 perf program proved a two-part law about WebKit's compositing cost (recorded in `dash/jul30-perf-brief.md#i1-sparkline-exception`, source-verified against WebKit trunk and measured on both the 12,200-box lab bench and the real release deck): (1) the per-frame whole-page `computeCompositingRequirements` walk is caused by **per-frame main-thread style commits of transform-family properties**, not by transform animations as such — which is also [L05]/[L13]'s "rAF is not for animation" arriving independently by measurement; (2) a **completely accelerated** animation effect stops ticking entirely — one walk at animation start reserves the union of the whole journey in the overlap map (`computeExtentOfTransformAnimation` → `setAnimationExtent`), then zero walks per frame at any layer population. A 420×700 pane-sized `element.animate()` translate tween measured **zero walk delta on the real ~26k-layer deck** (interleaved ×3, medians) — with no freeze of any kind, on a busy deck running 39 animations.

Today's imposer settle is worse than either form: `tug-pane.css` transitions `left`, `top`, `bottom`, and `width` under `[data-imposer-settling]`, and the pinned Lens crosses by a transition on the registered custom property `--tugx-lens-rail` that `left` re-reads via `calc()`. Every frame of every settle is therefore a **relayout** of each moving pane's whole subtree — a cost class strictly above the walk.

One premise correction from investigation, and it is good news: **an arrangement change is already pure translation.** A pane's rendered width is `renderWidth = max(size.width, minSize.width)` (`tug-pane.tsx`), and its vertical run is the top gap down to the bottom gap — none of which an imposition-kind swap, Lens side flip, or slot reassignment touches. There is nothing to pre-size; the `width` in today's transition list only ever moves when something *else* changes width in the same window. FLIP's translate-only form is therefore the natural fit, not a compromise ([P01] records the one edge this leaves: a concurrent width change snaps).

The fix is the classic FLIP inversion: React commits the final geometry in one relayout, then a qualifying-form transform tween runs from the inverse delta to identity, then the animation object is dropped at land.

#### Strategy {#strategy}

- **Layout snaps once; motion is transform.** React keeps writing the same inline geometry it writes today (`imposeStyle` / `imposeLensStyle` output); we stop transitioning those properties and instead measure first/last rects around the commit and tween `transform: translate()` from the inverse delta to zero.
- **The tween runs through TugAnimator** ([P07], [L13]) — the settle needs cancellation, completion, and multi-element coordination, which is TugAnimator's exact jurisdiction — with three of its behaviors explicitly managed: the reduced-motion spatial-strip (bypassed by skipping the tween entirely), `getTugTiming()` duration scaling (the land timer uses the same scaled number), and the `fill: 'forwards'` default (overridden to `'none'`).
- **The tween is authored in the I1 qualifying form** and nothing else: keyframes touching only `transform`, strictly 2D, keyword `linear` easing, rate 1, forward, finite; the damped-spring shape is carried by **sampled keyframe offsets**, never by a `linear(...)` points easing (a known acceleration blocker — the pulsing dot's recorded 18.0%→0.9% battle in `tug-progress-pulsing-dot.css`).
- **The freeze is a measured decision, not a premise.** The release-main evidence says the tween itself is free without one; what a freeze would buy is suppression of mid-gesture React commits (each forces layout + a walk inside the window). The lab step measures that cost first ([Q02]); the freeze step exists but is conditional on the numbers, and if it ships, the dependency points outward — public `holdNotifications()`/`releaseNotifications()` on `CodeSessionStore`, driven from the `CardServicesStore` registry — never a module singleton imported into `dispatch` ([P04]).
- **The Lens rail stops transitioning.** The rail becomes a static number written at re-imposition; the crossing motion is the same FLIP tween every other pane gets. This deletes the ungated rail transition and its WebKit same-style-change workaround prose.
- **Sequencing:** pure math first (unit-testable), then the orchestration, then the CSS removal, then the app-test, then the lab measurement that both closes the brief's S5 exit and rules on the freeze.

#### Success Criteria (Measurable) {#success-criteria}

- During a scripted arrangement change, the only running animations on moving panes are transform-only WAAPI tweens; `document.getAnimations()` shows them during and **zero** residual animation objects or retained `CSSTransition`s after land (app-test census).
- After land — and after a *second* settle — **no pane frame carries an inline `transform`**, and a `TugSheet`/completion popup opened afterward positions against the viewport, not the pane ([P07].4 app-test).
- After land, every moving pane's `getBoundingClientRect()` equals the `imposeRect` numeric twin's prediction within 1px (app-test).
- On the idle-hunt lab (per the [D5] discipline: unoccluded, interleaved baselines, ×3 medians), a scripted settle on a heavy deck shows walk delta ≤ noise vs baseline in tween steady state, and the gesture window holds frame budget (no main-thread frame over ~16.7ms attributable to the settle) — recorded into `dash/jul30-perf-brief.md#s5-imposer`.
- [Q02] is resolved with numbers: mid-gesture commit cost is either measured negligible (freeze step closed as not-needed) or the freeze ships and a held `CodeSessionStore` publishes **zero** notifications during a hold and exactly **one** flush at release, state-equal to an unheld control (bun test at the store layer, real reducer events).
- The quiet contract: between gestures the imposer contributes zero animation objects and zero timers by construction (census on a settled deck).

#### Scope {#scope}

1. FLIP math as a pure module (`tugdeck/src/lib/pane-flip.ts`) with unit tests.
2. FLIP orchestration in `deck-canvas.tsx` (measure → TugAnimator tween → land), including mid-tween retargeting and the reduced-motion skip.
3. Removal of the settle property transitions and the Lens rail transition from `tug-pane.css`; static rail writes.
4. App-test coverage for census, geometry, and retarget; lab measurement and the brief's S5 record.
5. **Conditional on [Q02]:** notification hold on `CodeSessionStore` driven from the `CardServicesStore` registry, with store-layer tests.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Pointer-driven motion: drags and resizes keep writing `left`/`top`/`width` per frame under `[data-gesture]` — that is honest interactive cost and FLIP explicitly excludes gesturing panes, exactly as the CSS transitions do today.
- Animating size. Arrangement changes don't change pane size (#context); a width change that lands concurrently snaps ([P01]).
- The collapse/expand window-shade height motion (its own transition in `chrome.css`, untouched).
- I3 (layer-population diet), the Tug animation API primitive layer, and `tuglaws/animation-doctrine.md` — separate brief items.
- Host-side (out-of-page) pane composition — the brief's flagged architecture-round fallback, only relevant if this plan's measured exit fails.

#### Dependencies / Prerequisites {#dependencies}

- S1–S4 quiet contracts (landed): a moving pane buys little if dots and sparklines tick through the move.
- The I1 record (`dash/jul30-perf-brief.md#i1-sparkline-exception`): the qualifying form and the disqualifying delta this plan is built on.
- `/api/eval` on release behind the `diag/eval` tugbank default (landed in jul29B) for the lab measurement step.
- `tug-animator.ts` as it stands: named slots, cancel modes, `group()`, duration scaling, reduced-motion handling ([P07] works with, not around, each).

#### Constraints {#constraints}

- WARNINGS ARE ERRORS (`-D warnings` Rust-side; zero new tsc/lint findings tugdeck-side); bun only; `bunx vite build` must pass before any tugdeck step is declared done.
- Banned test styles: no fake-DOM/RTL, no mock-store assertion tests — any freeze tests drive the **real** `CodeSessionStore` with real wire events.
- Tuglaws: appearance changes via CSS/DOM, never React state ([L06]); external state through `useSyncExternalStore` only ([L02]); programmatic motion through TugAnimator ([L13]); name touched laws in each commit body.
- App-tests: selective (`just app-test-changed` / named files), every new test carries `@covers`.

#### Assumptions {#assumptions}

- The shipping WebKit accelerates broadly (measured: even `steps()` runs walk-free on the lab bench under threaded animation resolution), but the plan still authors strictly inside the conservative qualifying form so it stays cheap on older/other configurations.
- `getBoundingClientRect()` during a running accelerated WAAPI transform tween reflects the current animated transform (Web Animations resolves the effect at style-query time), which is what makes mid-tween retargeting by measurement correct.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does a running descendant transform animation during the move cost anything? (OPEN → resolve by measurement in Step 6) {#q01-nested-transform}

**Question:** WebKit sets `animationCausesExtentUncertainty` when a layer and its ancestor both run transform animations (the "nested" rule in `RenderLayerCompositor.cpp`). A breathing `pulsing-dot` (accelerated scale) inside a FLIP-moving pane is exactly that shape. Uncertainty turns overlap testing off for the remainder of the pane's stacking context **during whichever walks actually run** (start and land — steady-state has none), potentially over-compositing pane content transiently.

**Why it matters:** If the start-walk over-composites heavily, the gesture's two honest walks could mint a burst of layers and backing memory.

**Plan to resolve:** Step 6's lab session runs the scripted settle with a live turn (wave + dot running inside the moving pane) and compares layer counts and walk cost against the settled-pane run. Accept if the delta is transient and bounded; only escalate to a design change on proof.

**Resolution:** **RESOLVED — accepted.** 48 infinite accelerated scale loops planted inside the moving panes, over the same 8-gesture 4s window: walk median 365 → 399 (+9%), p95 frame delivery unchanged, no layer-count explosion. Bounded and transient, as hoped; no design change. Numbers in `dash/jul30-perf-brief.md#s5-imposer`.

#### [Q02] Is the notification freeze needed at all? (OPEN → resolve by measurement in Step 6) {#q02-freeze-needed}

**Question:** The brief's kink-the-hose sequence assumes a freeze; the release-main measurement then showed the tween costs nothing even on a deck with live animations and no freeze. What remains unmeasured is the cost of a **React commit landing inside the gesture window** (a streaming card's coalesced notify → render → layout → one walk, ~up to 18 commits in a 300ms window at the coalescing cadence).

**Why it matters:** The freeze is the only piece of this plan with a wedge failure mode (a hold that never releases leaves cards stale — the [L23] shape). Machinery with a wedge risk must not ship on an unmeasured premise.

**Plan to resolve:** Step 6 measures the settle with a live streaming turn in a moving pane, freeze absent: frame budget and walk counts in the window, interleaved against a settled-pane baseline. If the commits break frame budget, Step 7 ships the hold; if not, Step 7 closes as not-needed and the brief's S5 record says so with numbers.

**Resolution:** **RESOLVED — the freeze ships.** Three-way attribution over a 4s window with 8 gestures and 67 validated deck-store commits: settle alone walk 343 / 10 dropped frames; commits alone 654 / 26; both **1809 / 43**. Additive prediction is 997, so the interaction is **81% superadditive** — a commit landing inside the gesture window dirties compositing while the animation's extent is reserved, forcing exactly the recompute the reservation exists to avoid. Median frame delivery degrades 17ms → 20ms with four times the dropped-frame rate. Machinery with a wedge risk may not ship on an unmeasured premise; this one is measured. Step 7 is unconditional now.

**A note on how nearly this went the other way.** The first pass at this measurement drove commits with `cycleCard`, which cycles cards *within* a pane — and every pane in the scene holds one card, so it was a no-op. That run showed no delta and would have closed Step 7 as not-needed. The condition now asserts the deck state actually moved (`activePaneId` flips) before believing its own numbers. A driver that silently does nothing and a change that genuinely costs nothing produce the same reading; only the assertion tells them apart.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `commitStyles()` residue makes panes a containing block for fixed/portaled descendants | **high** | certain if unhandled | idempotent inline-transform clear on every landing path ([P07].4, Spec S01/S02); app-test asserts no inline `transform` after land | any sheet/popup mispositioned *after* an arrangement change |
| TugAnimator's reduced-motion strip fades panes instead of skipping | med | high if unhandled | orchestrator skips tween creation under `!isTugMotionEnabled()` ([P07]); app-test note | any pane flash under reduced motion |
| Duration desync (scaled tween vs unscaled window timer) | med | high if unhandled | one resolved duration: `readSettleMs(el) × getTugTiming()` drives tween, land timer, and any hold cap ([P07]) | attribute lifts before/after motion ends |
| Freeze wedge (hold never released) — only if Step 7 ships | med | low | store-internal watchdog via `timerSource`; release idempotent; effect cleanup releases | any stuck-stale card report |
| Retarget glitch mid-tween | low | med | measure-cancel-remeasure ordering (Spec S02); app-test drives back-to-back changes | visible jump in vet |
| Nested-animation over-compositing ([Q01]) | med | low | measured in Step 6; bounded to pane stacking context | layer-count spike in the lab run |
| Stale-inset measurement on Lens flips | high | high if unhandled | FLIP layout effect declared **after** the inset-writing effect (Spec S02) | wrong-delta crossing on side flip |

**Risk R01: The freeze holds forever** {#r01-freeze-wedge}

- **Risk:** If Step 7 ships and land never fires (exception mid-orchestration, unmount mid-gesture), held stores would never flush and cards would go stale — the wedge shape [L23] exists to prevent.
- **Mitigation:** `holdNotifications(capMs)` runs a store-internal watchdog on the store's own injected `timerSource` (the existing DI discipline); release is idempotent; `deck-canvas`'s effect cleanup releases on unmount; the cap is `2 ×` the resolved settle duration, minimum 1s.
- **Residual risk:** a hold released by the watchdog rather than the land timer flushes slightly late — never never.

**Risk R02: `getComputedStyle`/gBCR flushes at the wrong moment** {#r02-measure-flush}

- **Risk:** First-rect capture in the store subscriber and Last-rect capture in the layout effect both force layout; a mistake in ordering measures the wrong side of the commit.
- **Mitigation:** Spec S02 fixes the ordering (subscriber = pre-render, layout effect = post-commit pre-paint after the inset effect, cancel-before-Last on retarget); the geometry app-test asserts end rects against the numeric twin.
- **Residual risk:** one extra forced layout per gesture (the First measurement) — a fixed, bounded cost at gesture start, which [D4] prices as honest.

---

### Design Decisions {#design-decisions}

#### [P01] FLIP replaces property transitions — layout snaps, transform moves (DECIDED) {#p01-flip}

**Decision:** On an arrangement change, React commits the final geometry immediately, and the visible motion is a per-pane tween of `transform: translate()` from the inverse delta to identity. The `left`/`top`/`bottom`/`width` transitions and the rail transition are deleted.

**Rationale:**
- Transitioning layout properties relayouts every moving pane's subtree per frame — the top cost class on the page, above even the compositing walk (jul30 brief `#i1-sparkline-exception`).
- A qualifying transform tween measured **zero walk delta on the real release deck** — motion becomes two walks per gesture (start reserves the journey envelope; land drops it), not N-per-frame.
- Arrangement changes are already pure translation (#context), so translate-only FLIP loses nothing today's motion has.

**Implications:**
- The settle stops being pure CSS; `deck-canvas.tsx` orchestrates measure → tween → land (Spec S02).
- A pane's final transform is identity, so no `commitStyles()` is needed; completion drops the animation, leaving zero objects ([D6] in the brief's doctrine).
- `data-imposer-settling` survives as the gesture-window marker (test hook, and hold scope if Step 7 ships) but gates **no** transitions once Step 3 lands — nothing else transitions incidentally inside the window anymore.
- **The one behavior change, accepted:** a `width` change landing concurrently with an arrangement change used to glide (width was in the transition list) and now snaps at commit. Arrangement gestures don't change width themselves, so this arises only from coincidental simultaneous edits (a stack-floor change, a store width write); a snap there is honest, and motion on it would violate the translate-only qualifying form.
- [L09] tension, argued: the geometry of record remains TugPane's inline style from the store snapshot — `deck-canvas.tsx` writes only a transient, appearance-zone `transform` that starts and ends at identity, as the arrangement's orchestrator. Pane geometry ownership is untouched; this is motion, not position. **The word "transient" is what carries this argument, and it is load-bearing rather than rhetorical:** a `transform` left standing on the frame is no longer motion but a persistent, geometry-affecting property written by a non-owner (it makes the frame a containing block for its `position: fixed` and portaled descendants). [P07].4's mandatory inline-transform cleanup is therefore what keeps this plan inside [L09], not merely tidy.

#### [P02] The qualifying form; the spring lives in sampled keyframes (DECIDED) {#p02-qualifying-form}

**Decision:** Tween keyframes touch **only** `transform` (2D translate), keyword `linear` easing, `playbackRate` 1, forward direction, finite duration; the damped-spring shape (`dampedSpring()` in `tugdeck/src/lib/unit-functions.ts`) is baked into ~33 sampled keyframe offsets.

**Rationale:**
- `IMPOSITION_SETTLE_EASING` is `cssEasing(dampedSpring())` — a **65-point `linear(...)`**, which is precisely the acceleration blocker the pulsing dot's history records (`tug-progress-pulsing-dot.css`: Core Animation cannot express multi-stop `linear()`; WebKit declines to accelerate; measured 18.0% vs 0.9%). Threaded animation resolution may forgive it on current WebKit, but the sampled-keyframe form is proven, costs nothing, and stays safe everywhere.
- Many-stop keyframes under keyword `linear` is the identical curve by construction — the same trick, already precedented in-repo.

**Implications:**
- A pure `springKeyframes` function samples position at each offset: keyframe *i* of *N* carries `translate(dx·(1−s), dy·(1−s))` with `s = dampedSpring()(i/N)`.
- The `--tugx-imposer-settle-easing` CSS knob is retired (List L01); duration tuning keeps working through `--tugx-imposer-settle-duration` via `readSettleMs`.

#### [P03] The Lens crosses by FLIP; the rail becomes static (DECIDED) {#p03-lens-rail}

**Decision:** `--tugx-lens-rail` is still written by `imposeLensStyle` (the `left` calc still reads it) but never transitions; the Lens's crossing motion is the same measured FLIP tween as every other pane. The `@property` registration stays; the two rail transition rules in `tug-pane.css` are deleted.

**Rationale:**
- The rail transition re-resolves `left` per frame — per-frame layout, the exact disease.
- FLIP interpolates in transform space, so "a bare length and a percentage don't interpolate" — the whole reason the rail exists as a motion mechanism (`imposeLensStyle` docstring) — stops applying to motion. The rail remains only as the static side selector.
- The WebKit same-style-change gating workaround (the ungated rail transition and its long comment) is deleted rather than maintained.

**Implications:** `imposeLensStyle`'s docstring is rewritten to describe the rail as a static side number; the "arming is driven off the STORE" constraint in `deck-canvas.tsx` (WebKit refusing transitions armed in the same style change) becomes irrelevant to motion — the subscriber's remaining job is First-rect capture and window arming.

#### [P04] The freeze, if measurement demands it, is store API driven from the registry — never a singleton in dispatch (DECIDED as to shape; SHIPPING conditional on [Q02]) {#p04-freeze}

**Decision:** If Step 6's numbers show mid-gesture commits breaking frame budget, `CodeSessionStore` gains public `holdNotifications(capMs)` / `releaseNotifications()` that pin the snapshot and defer **wire-origin** notifications exactly as the replay fold does (same `_foldPending` machinery, same truthfulness rules: local actions, timer ticks, and transport events publish immediately), flushing once on release; the watchdog is store-internal on the injected `timerSource`. The orchestrator in `deck-canvas.tsx` drives every card's store through a narrow iteration method on `CardServicesStore` (which already owns the `Map<string, CardServices>`).

**Rationale:**
- The brief names the muscle ("the same muscle HMR/replay gating already exercises", `#s5-imposer`) — the deferral shape, snapshot pinning, and flush-once semantics already exist and are tested.
- The dependency direction is the vetted correction: a module singleton imported by `dispatch` would break the store's injection discipline (`timerSource` arrives via constructor options), make tests order-dependent through shared globals, and bury a control input in a hot path. A public method on the store, called by whoever owns the gesture, is [L28]'s direction — act on a lifecycle through its published surface.
- [D7] (brief doctrine): the hold defers, never drops; its stop condition is the land event; the watchdog is the wedge-guard, not the clock.

**Implications:**
- No new module; two store methods, one `CardServicesStore` iteration method, one orchestrator call pair.
- Hold scope is all session stores (an arrangement change can move every pane; the window is ~300ms); non-session stores are out of scope (Pulse is event-clocked and worker-drawn; deck-manager state is the mover itself).

#### [P05] Retarget by measurement, through the tween registry (DECIDED) {#p05-retarget}

**Decision:** An arrangement change landing mid-tween measures each moving pane's **current visual rect** (gBCR, which includes the running tween's transform), cancels that pane's registered `TugAnimation`, lets React commit the new layout, measures Last, and starts a fresh tween from the visual-rect delta.

**Rationale:**
- The CSS transition retargeted for free; FLIP must do it explicitly or back-to-back changes jump. Measuring the live visual position makes the new tween start exactly where the eye is.
- Cancellation semantics are safe by construction: the tween's final keyframe is identity with `fill: 'none'`, so both TugAnimator's `snap-to-end` and a plain cancel land the element on its base (untransformed) style — there is no wrong pose to snap to. The visual jump this implies is invisible because no paint occurs between the subscriber's cancel and the layout effect's new tween (store notify → synchronous `useSyncExternalStore` re-render → layout effects → one paint).

**Implications:** the orchestrator keeps a per-pane registry of `TugAnimation` handles (a plain `useRef<Map>` — DOM-zone state, no React); TugAnimator's named slot (`key: "imposer-flip"`) additionally dedupes defensively if a registry entry is ever missed; cancel-before-Last ordering is normative (Spec S02).

#### [P06] Gesturing panes never FLIP (DECIDED) {#p06-gesture-exclusion}

**Decision:** A pane wearing `data-gesture` is skipped by the orchestrator, exactly as `:not([data-gesture])` excluded it from the transitions.

**Rationale:** The drag machine writes `left`/`top` per frame; motion on top of a pointer lags the pointer (the existing comment's law). Pointer cost is [D4]-honest and out of scope.

#### [P07] The tween runs through TugAnimator, with its three sharp edges named (DECIDED) {#p07-tug-animator}

**Decision:** Tweens are created with `animate()` from `tugdeck/src/components/tugways/tug-animator.ts` — never raw `element.animate()` — and the orchestrator explicitly manages three TugAnimator behaviors that would otherwise break this surface.

**Rationale:**
- [L13]: "TugAnimator owns animations needing completion promises, cancellation, multi-element coordination, or physics curves." The settle needs three of the four; hand-rolling a parallel WAAPI wrapper beside it would give the future Tug animation API (`dash/jul30-perf-brief.md#tug-animation-api`) two engines to reconcile instead of one to extend.
- Its named slots and cancel modes are the retarget machinery [P05] needs, already written and GC-safe.

**Implications — the four edges, each mandatory in Spec S01/S02:**
1. **Reduced motion:** TugAnimator strips spatial properties and substitutes an opacity fade when `!isTugMotionEnabled()` — for FLIP that would *flash every pane* (they already sit at their final positions). That branch **also** overrides the duration to `--tug-motion-duration-fast`, which would silently retime the gesture window out from under the land timer. The orchestrator checks `isTugMotionEnabled()` (from `scale-timing.ts`) itself and **skips tween creation entirely** when motion is off: layout has already snapped, which *is* the correct reduced-motion settle.
2. **Duration scaling:** `resolveDuration` multiplies its input by `getTugTiming()`. The rule is one line: **pass the raw `readSettleMs(el)` to `animate()`, and set the land timer (and any hold cap) to `readSettleMs(el) × getTugTiming()`** — the scaled product the tween will actually run for. The tween and the window that frames it may never disagree.
3. **Fill:** TugAnimator defaults `fill: 'forwards'`, which retains the effect — a [D6] violation on this surface. Every settle tween passes `fill: 'none'` explicitly.
4. **Inline-style residue — the sharpest edge, and `fill` does not gate it.** TugAnimator's natural-completion handler calls `wapiAnim.commitStyles()` *unconditionally* before cancelling, writing the animation's final value into `el.style`. For FLIP that stamps a permanent inline `transform: translate(0px, 0px)` on every pane frame — and React never removes it, because `transform` is not among the style keys `TugPane` renders, and React only clears keys it previously set. `cancel("snap-to-end")` takes the same path (it calls `finish()`, which resolves the WAAPI promise). **A transform other than `none` makes the element a containing block for `position: fixed` descendants**, and this codebase puts such elements inside pane frames: `TugSheet` portals into `paneFrameEl` itself, and the completion popup, alerts, banners, and markdown-view surfaces all position with `position: fixed` from viewport coordinates. The residue would offset every one of them by the pane's origin — and only *after the first arrangement change*, so a fresh-launch test passes and the breakage surfaces later in the session. **Therefore every landing path explicitly clears the inline transform** (Spec S01, Spec S02.4/S02.5), asserted by app-test. The animation *object* needs no such care: the same handler calls `wapiAnim.cancel()` after committing, so the census stays at zero.

---

### Deep Dives {#deep-dives}

#### The current settle machinery, precisely {#current-machinery}

For the cold reader — what exists today and where:

- **Geometry**: `TugPane` (`tugdeck/src/components/chrome/tug-pane.tsx`, the frame `<div className="tug-pane">`) renders inline styles in three modes — pinned Lens (`imposeLensStyle`), imposed chain link (`imposeStyle`), free (`left/top/width/height` from the store). Both impose helpers live in `tugdeck/src/lib/layout-imposer.ts`; every horizontal pin is emitted as `left` (a `calc()` over `100%` and the `--tug-imposer-inset-*` custom properties that `deck-canvas.tsx` writes). Rendered width is `renderWidth = max(size.width, minSize.width)` — arrangement-independent.
- **Arming**: `deck-canvas.tsx` subscribes to the deck store; on a change to `arrangementSignature(state)` (imposition kind | lens side | pinned | pane→slot map) it writes the knobs, sets `data-imposer-settling` on the container, flushes via `readSettleMs(el)` (which reads the **resolved** duration back), and clears the attribute on a timer of that duration. The subscriber-not-effect placement predates this plan (it existed for WebKit's transition-arming rule); its surviving job is pre-render First-rect capture.
- **Insets**: a `useLayoutEffect` keyed `[lensSide, lensInset]` writes `--tug-imposer-inset-left/right` on the container — the values every imposed `left` calc resolves against. Declaration order against this effect is load-bearing for FLIP (Spec S02).
- **Motion**: `tug-pane.css` — `[data-imposer-settling] .tug-pane:not([data-gesture])` transitions `left/top/bottom/width`; `.tug-pane[data-lens-pane]` transitions `--tugx-lens-rail` **ungated** (the same-style-change workaround); the `@property --tugx-lens-rail { syntax: "<number>" }` registration is what makes the rail interpolable at all.
- **TugAnimator**: `tugdeck/src/components/tugways/tug-animator.ts` — `animate(el, keyframes, opts)` → `TugAnimation` (`finished` promise, `cancel(mode)`, `raw`); named slots via `key` + `slotCancelMode`; `group()`; `resolveDuration` scales by `getTugTiming()`; reduced-motion spatial strip via `hasSpatialProperties` / `isTugMotionEnabled()`; defaults `easing: 'ease'`, `fill: 'forwards'`, `composite: 'replace'`.
- **Scripting**: `set-imposition` and `set-imposition-lens` actions (`tugdeck/src/action-dispatch.ts`) change the arrangement; existing app-tests `at0230-pinned-lens-geometry.test.ts` and `at0276-lens-side-persists.test.ts` are the models for driving and asserting imposer geometry.
- **The freeze muscle** (relevant only if Step 7 ships): `code-session-store.ts` `dispatch` — the `notifyWorthy` branch defers wire-event notifications while `state.phase === "replaying"` (snapshot pinned via `_cachedSnapshot` untouched, `_foldPending` counting, threshold flush), and `_publishAndNotify` flushes everything in one notify. The store's dependencies arrive by constructor injection (`timerSource`, `conn`, `lifecycle` — see `CodeSessionStoreOptions`); any new control input follows that discipline. Session stores are owned per card by `CardServicesStore` (`tugdeck/src/lib/card-services-store.ts`, `_services: Map<string, CardServices>`), which is where an all-stores iteration belongs.

#### Why two walks per gesture is the floor, and why that's fine {#two-walks}

The start walk is forced: starting a transform animation dirties compositing once (and is also the walk that inserts the journey envelope into the overlap map — `computeExtentOfTransformAnimation` is *how* the remaining frames are free). The land walk is the inverse: the animation ends, the layer's promotion drops, geometry is re-validated. Between them, a completely accelerated effect does not tick (`ticksContinuouslyWhileActive()` false) and nothing dirties compositing bits, so `updateCompositingLayers` never runs. [D4] prices two walks at gesture edges as honest interactive cost; the disease was only ever per-frame. (The lab measurement then priced a full gesture at *three* walks — React's own commit of the new geometry dirties compositing before either tween exists. The floor argued here is the animation's share; the commit's walk exists with or without motion.)

**Spec S01: The qualifying tween** {#s01-qualifying-tween}

- Element: the `.tug-pane` frame div (the element whose inline geometry React owns). `transform` is otherwise unused on frames, so the tween conflicts with nothing.
- Call: `animate(el, springKeyframes(dx, dy), { duration: <raw ms per [P07].2>, easing: "linear", fill: "none", composite: "replace", key: "imposer-flip", slotCancelMode: "snap-to-end" })` — TugAnimator per [P07]; no delay, rate 1, forward.
- Reduced motion: the orchestrator returns before this call when `!isTugMotionEnabled()` ([P07].1).
- Keyframes: `SPRING_KEYFRAME_SAMPLES = 32` intervals (33 frames); frame *i* is `{ transform: `translate(${dx·(1−s)}px, ${dy·(1−s)}px)`, offset: i/N }` with `s = dampedSpring()(i/N)`; endpoints pinned exactly to the full delta and to `translate(0px, 0px)`.
- Land: `tugAnim.finished.then(clear, clear)` where `clear` removes the registry entry **and calls `el.style.removeProperty("transform")`** — the inline residue `commitStyles()` leaves behind ([P07].4). Both arms are wired: `finished` rejects under `hold-at-current`, and while this surface never uses that mode, a bare `.then()` would turn a future cancel-mode edit into an unhandled rejection. `clear` must be idempotent — the land sweep and the effect cleanup call it too, and microtask ordering means it can run more than once per pane (Spec S02).
- The animation object itself needs no teardown: TugAnimator's completion handler calls `wapiAnim.cancel()` after committing, so `getAnimations()` returns to zero on its own ([D6]).
- A pane whose delta is `(0, 0)` gets **no animation at all** (the quiet contract's stronger form, as S3 established for glyphs).

**Spec S02: Orchestration ordering (normative)** {#s02-orchestration}

1. **Store subscriber** (runs before the re-render it causes): if `arrangementSignature` changed — for each `.tug-pane` frame in the container **not** wearing `data-gesture`: record its current gBCR as First (a running tween's transform is included in gBCR, which is the point); if a registry tween is running on it, cancel it (`snap-to-end`; identity-final-keyframe makes this pose-safe per [P05]). Stash `Map<paneId, DOMRect>`. Compute the gesture window once: `windowMs = readSettleMs(el) × getTugTiming()`. Set `data-imposer-settling`. (Hold `CodeSessionStore`s here — only if Step 7 ships.)
2. **React commits** the new arrangement geometry — the one honest relayout.
3. **`useLayoutEffect` keyed on the signature** (after commit, before paint), **declared after the inset-writing effect** — React runs layout effects in declaration order, and the inset effect writes the `--tug-imposer-inset-*` values every imposed `left` resolves against; measuring Last before fresh insets would tween every Lens flip from a stale delta. For each stashed pane still present: measure Last (gBCR), `flipDelta`; skip if `!isTugMotionEnabled()` or delta is zero; else start the Spec S01 tween and register the handle. Clear the stash.
4. **Land timer** (`windowMs`): clear `data-imposer-settling`; for every registry straggler, cancel and run the idempotent `clear` (registry entry + `style.removeProperty("transform")`) — normally already self-cleaned via `finished`, but the sweep is what guarantees no pane keeps the residue if a `finished` handler was missed; release holds if Step 7 shipped.
5. **Cleanup** (effect teardown): cancel registered tweens, run `clear` on each, clear the attribute, release holds — unmount mid-gesture leaves neither a running animation nor an inline transform behind.

**Teardown is not synchronous, and the orchestrator must not assume it is.** `cancel("snap-to-end")` calls `finish()`, whose completion handler (`commitStyles()` → `wapiAnim.cancel()` → resolve) runs in a **microtask** — so on a retarget it lands *after* the subscriber returns and possibly after the layout effect has already started the replacement tween. That is visually safe (a running animation outranks inline style in the cascade, and the replacement is started from a freshly measured delta), but it has two consequences that are normative here: `clear` must be idempotent, because the old tween's handler and the new tween's handler can both fire for the same pane; and the inline-transform removal must never be treated as a one-shot at a single point in the sequence.

Both measurements are gBCR in viewport coordinates; deltas are CSS px in the same space, unaffected by page zoom (both sides scale identically). The frame's own transform never appears in React's inline style, so mid-move React re-renders of the pane cannot clobber the tween.

**Spec S03: The notification hold (conditional on [Q02])** {#s03-hold}

- `CodeSessionStore.holdNotifications(capMs)`: sets an internal held flag, arms a watchdog on `this.timerSource` that calls `releaseNotifications()` at `capMs`; idempotent re-arm extends the watchdog.
- While held, the `notifyWorthy` branch routes **wire-origin** events to the existing defer path (`_foldPending += 1`, snapshot pinned) — a sibling condition beside the replay fold's, with the fold's truthfulness rules verbatim (local actions, timer ticks, transport events publish immediately). The `_publishCoalesced` streaming branch also defers while held.
- `releaseNotifications()`: clears the flag and watchdog; if anything deferred, one `_publishAndNotify()`. Idempotent.
- `CardServicesStore` gains a narrow iteration (e.g. `forEachCodeSessionStore(fn)`) over `_services`; the orchestrator calls hold/release through it. No module singleton; no import in `dispatch`; the store's DI discipline holds.
- [D8] alignment: nothing is dropped or re-requested — the events were already reduced into state; only the *notification* waits.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| First-rect stash | appearance orchestration | plain `useRef<Map>` in `DeckCanvas`, written by store subscriber, read by layout effect | [L06], [L22] |
| Running-tween registry (`TugAnimation` handles) | appearance orchestration | plain `useRef<Map<paneId, TugAnimation>>`, never React state | [L06], [L13] |
| `data-imposer-settling` | appearance | DOM attribute written straight to the container | [L06] |
| Transient `transform` on frames | appearance (motion) | TugAnimator tween, starts and ends at identity; **inline residue cleared on every landing path** ([P07].4) so the property never outlives the gesture; geometry of record stays TugPane's inline style | [L06], [L13], [L09] (argued in [P01]) |
| Hold flag + watchdog (conditional) | store-internal | public store methods over injected `timerSource`, driven via `CardServicesStore` | [L02], [L28], [L23] |
| Pane geometry | structure (unchanged) | React inline styles from the deck store snapshot, exactly as today | [L02], [L09] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/pane-flip.ts` | Pure FLIP math: `flipDelta(first, last)`, `springKeyframes(dx, dy, samples?)`, `SPRING_KEYFRAME_SAMPLES` |
| `tugdeck/src/lib/__tests__/pane-flip.test.ts` | Unit tests for the math |
| `tests/app-test/atNNNN-imposer-flip-settle.test.ts` | Scripted settle: census, geometry, retarget (`@covers` deck-canvas.tsx, tug-pane.css, pane-flip.ts). **NNNN = verified-unique**: list `tests/app-test/`, take max+1, and check no collision — the corpus already contains a duplicated `at0230`, so uniqueness is checked, not inferred |
| `tugdeck/src/lib/code-session-store/__tests__/notification-hold.test.ts` | Conditional (Step 7): real-store hold/flush tests |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `flipDelta` | fn | `lib/pane-flip.ts` | `(first: DOMRectReadOnly, last: DOMRectReadOnly) → {dx, dy}`; translate-only by design |
| `springKeyframes` | fn | `lib/pane-flip.ts` | Spec S01 keyframe generator; samples `dampedSpring()` from `lib/unit-functions.ts` |
| `DeckCanvas` settle block | modify | `components/chrome/deck-canvas.tsx` | Spec S02 orchestration; TugAnimator import; declaration order vs the inset effect |
| `IMPOSITION_SETTLE_EASING` | remove | `lib/layout-imposer.ts` | superseded by sampled keyframes; drop the now-unused `cssEasing` import |
| settle transition rules | remove | `components/tugways/tug-pane.css` | the `[data-imposer-settling]` property lists and both rail transition rules; `@property` registration stays |
| `imposeLensStyle` docstring | modify | `lib/layout-imposer.ts` | rail described as static side selector |
| `holdNotifications` / `releaseNotifications` | fn (conditional) | `lib/code-session-store.ts` | Spec S03; watchdog on injected `timerSource` |
| `forEachCodeSessionStore` | fn (conditional) | `lib/card-services-store.ts` | narrow iteration over `_services` for hold/release |

**List L01: Tuning-knob contract after this plan** {#l01-knobs}

- `--tugx-imposer-settle-duration` — **kept**; read by `readSettleMs`, then scaled once by `getTugTiming()` into the single `windowMs` that drives tween, land timer, and any hold cap together ([P07].2).
- `--tugx-imposer-settle-easing` — **retired**; the curve is `dampedSpring(stiffness)` sampled into keyframes; retuning means changing the stiffness argument (or sample count) in code. Documented in the CSS comment that replaces the old knob prose.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (bun) | `flipDelta` / `springKeyframes` shape: endpoints exact, offsets monotone, transform-only strings, zero-delta short-circuit | Step 1 |
| **Real-app** (`just app-test`) | scripted `set-imposition` / `set-imposition-lens`: during-census, after-census, end geometry vs `imposeRect`, retarget | Step 5 |
| **Integration** (bun, real store — conditional) | hold/flush against real `CodeSessionStore` reducing real wire events; watchdog; wire-only rule; coalesced-branch deferral | Step 7, if it ships |

#### What stays out of tests {#test-non-goals}

- Fake-DOM render tests and mock-store assertions — banned; any hold semantics are proven on the real store, the motion on the real app.
- Frame-budget and walk measurements — [D5] lab discipline on-demand (Step 6), not CI: sampling profiles don't belong in gates.
- Mid-window wire-timing races in app-tests — arrival inside a specific 300ms window is inherently racy in a real app; store-layer tests cover hold semantics deterministically instead (the established layering: cover at the store round-trip layer what app-test timing can't hold).
- Reduced-motion visuals — the skip path is a code branch asserted by the absence of animations in the census, not a screenshot comparison.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | FLIP math module | done | `8287798cd` |
| #step-2 | FLIP orchestration via TugAnimator | done | `c6b2607e6` (with #step-3) |
| #step-3 | CSS transition removal + static rail | done | `c6b2607e6` (with #step-2) |
| #step-4 | Integration checkpoint: build + selective tests | done | verification only |
| #step-5 | App-test: scripted settle | done | `797648b56` (`at0294`) |
| #step-6 | Lab measurement + brief record + freeze verdict | done | see below |
| #step-7 | Notification hold (**ruled IN** by [Q02]) | done | see commit below |

#### Step 1: FLIP math module {#step-1}

**Commit:** `tugdeck(pane-flip): FLIP delta and sampled-spring keyframes for the imposer settle`

**References:** [P01] FLIP replaces transitions, [P02] qualifying form, Spec S01, (#context, #two-walks); external: `dash/jul30-perf-brief.md#i1-sparkline-exception`

**Artifacts:** `tugdeck/src/lib/pane-flip.ts`, `tugdeck/src/lib/__tests__/pane-flip.test.ts`

**Tasks:**
- [ ] `flipDelta(first, last)` returning `{dx, dy}` from rect `left`/`top` differences; document that size is deliberately ignored (arrangement changes are pure translation — #context — and a concurrent width change snaps per [P01]).
- [ ] `springKeyframes(dx, dy, samples = SPRING_KEYFRAME_SAMPLES)` per Spec S01, importing `dampedSpring` from `lib/unit-functions.ts`; endpoints pinned exactly; each keyframe carries only `transform` and `offset`.
- [ ] Module docstring states the qualifying form and the `linear()`-points prohibition, citing the brief's I1 anchor — this is the file a future editor reads before "improving" the easing.

**Tests:**
- [ ] Endpoints: first keyframe is the full inverse delta, last is `translate(0px, 0px)`.
- [ ] Shape: offsets strictly increasing in [0,1]; every keyframe's only property keys are `transform` and `offset`; values contain no `z`/3D functions.
- [ ] `dampedSpring` fidelity: mid-sample values match direct evaluation within 1e-5.

**Checkpoint:**
- [ ] `cd tugdeck && bun test lib/__tests__/pane-flip.test.ts` green; `bunx tsc --noEmit` clean.

---

#### Step 2: FLIP orchestration via TugAnimator {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(deck-canvas): imposer settle by measured FLIP tween through TugAnimator`

**References:** [P01], [P05] retarget, [P06] gesture exclusion, [P07] TugAnimator with edges named, Spec S01, Spec S02, Risk R02, (#current-machinery, #state-zone-mapping); laws [L13], [L05], [L06], [L22], [L09]

**Artifacts:** rewritten settle block in `tugdeck/src/components/chrome/deck-canvas.tsx`

**Tasks:**
- [ ] Store subscriber (existing `arm`): on signature change, capture First rects of every non-gesturing `.tug-pane` (cancel registered tweens after measuring, per [P05]), stash in a ref `Map`, compute `windowMs = readSettleMs(el) × getTugTiming()` once, write the duration knob, set `data-imposer-settling`.
- [ ] New `useLayoutEffect` keyed on the arrangement signature, **declared after the inset-writing effect** (Spec S02.3 — this line is load-bearing; leave a comment saying why): measure Last, `flipDelta`, skip under `!isTugMotionEnabled()` or zero delta, else `animate(...)` per Spec S01 and register the `TugAnimation` handle.
- [ ] The idempotent `clear(paneEl)` helper — registry removal **plus `style.removeProperty("transform")`** — wired to both arms of `finished` and reused by the land sweep and cleanup ([P07].4). Comment it with the reason (TugAnimator commits on completion regardless of `fill`; a standing identity transform would become a containing block for `TugSheet` portals and every `position: fixed` surface inside the pane), so nobody "simplifies" it away.
- [ ] Land timer at `windowMs`: clear the attribute, sweep the registry through `clear`. Effect cleanup cancels tweens and clears.
- [ ] Update the block comment: the store-subscriber placement now exists for pre-render measurement (the WebKit transition-arming rationale leaves with the transitions); name the laws touched ([L13], [L06], [L22], [L05], [L09]) in the commit body.

**Tests:**
- [ ] Covered by Step 5's app-test (browser-behavior surface); tsc + existing bun suites must stay green here.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `cd tugdeck && bunx vite build` clean; manual vet on the debug instance: N-up swap and Lens side flip visibly cross (HMR live); with system reduced-motion on, arrangement changes cut with no fade and no flash.
- [ ] Residue check by hand before moving on: after two settles, inspect a `.tug-pane` frame in the dev panel — its inline style must carry no `transform`, and a sheet opened on that pane must sit where it did before the settle ([P07].4).
- [ ] Retarget is the watch-item path (measurement, cancellation, and microtask teardown all interact): drive several arrangement changes back-to-back inside one settle window and confirm no jump, no stacked tweens, no residue.

---

#### Step 3: CSS transition removal + static rail {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(tug-pane.css): retire settle property transitions and the rail transition — motion is the FLIP tween`

**References:** [P01], [P03] static rail, List L01, (#current-machinery)

**Artifacts:** edits to `tugdeck/src/components/tugways/tug-pane.css`, `tugdeck/src/lib/layout-imposer.ts`

**Tasks:**
- [ ] Delete the `[data-imposer-settling] .tug-pane:not([data-gesture])` property-transition rule, the ungated `.tug-pane[data-lens-pane]` rail transition, and the settling-gated Lens variant; keep the `@property --tugx-lens-rail` registration; rewrite the section comment to describe the FLIP contract and the List L01 knob status.
- [ ] `layout-imposer.ts`: remove `IMPOSITION_SETTLE_EASING` (and the now-unused `cssEasing` import); rewrite the `imposeLensStyle` docstring — the rail is the static side selector the `left` expression reads; motion is measured FLIP in `deck-canvas.tsx`.
- [ ] Sweep for stale references to the easing knob and the rail-transition rationale (`deck-canvas.tsx` comments included).

**Tests:**
- [ ] Existing suites; visual vet (a settle still crosses, the Lens flip still crosses, drags still track raw).

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `cd tugdeck && bunx vite build` clean; `grep -rn "settle-easing" tugdeck/src` returns nothing.

---

#### Step 4: Integration checkpoint {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `N/A (verification only)`

**References:** [P01]–[P03], [P05]–[P07], (#success-criteria)

**Tasks:**
- [ ] Full local verification: `cd tugdeck && bun test`, `bunx tsc --noEmit`, `bunx vite build`; `just app-test-changed` (or the selection it prints).
- [ ] Debug-instance vet: arrangement changes cross smoothly; mid-flip re-flip doesn't jump ([P05]); a pane mid-drag is untouched ([P06]); after settle, `document.getAnimations()` in the dev panel shows no residual tween; reduced-motion cuts cleanly ([P07].1).

**Checkpoint:**
- [ ] All of the above green in one run.

---

#### Step 5: App-test — scripted settle {#step-5}

**Depends on:** #step-4

**Commit:** `app-test(imposer-flip): settle census, end geometry, and retarget under the FLIP tween`

**References:** [P01], [P05], [P07], Spec S01, Spec S02, (#test-plan-concepts, #success-criteria); models: `tests/app-test/at0230-pinned-lens-geometry.test.ts`, `at0276-lens-side-persists.test.ts`

**Artifacts:** `tests/app-test/atNNNN-imposer-flip-settle.test.ts` with `@covers` for `deck-canvas.tsx`, `tug-pane.css`, `lib/pane-flip.ts` (NNNN verified unique per #new-files)

**Tasks:**
- [ ] Seed a deck with ≥2 imposed panes + pinned Lens; dispatch `set-imposition` (kind swap) and `set-imposition-lens` (side flip) via the action path.
- [ ] Mid-window census (evalJS): every animation on `.tug-pane` frames is transform-only (inspect `getKeyframes()`); the container wears `data-imposer-settling`.
- [ ] Post-land census: zero animations on frames, attribute gone, and end gBCR of each imposed pane matches the `imposeRect` numeric twin within 1px (import the twin's math or recompute in-page).
- [ ] **No inline-transform residue** ([P07].4): after land, every `.tug-pane` frame has an empty `el.style.transform` (read the inline style, not the computed value — the computed value of an untransformed element is `none`, which would pass vacuously). Assert it after a *second* settle too, since the residue is what a first-gesture-only test would miss.
- [ ] Containing-block guard, the residue's actual consequence: after a settle, open a `TugSheet` (which portals into the pane frame) or a completion popup and assert its viewport position is unaffected by the pane's origin — this is the assertion that fails loudly if a future edit drops the transform clear.
- [ ] Retarget: dispatch a second arrangement change mid-window; assert no console errors, tweens replaced not stacked, final geometry correct — including a Lens side flip immediately after a width-affecting change, which exercises the inset-ordering constraint (Spec S02.3).

**Tests:** the file is the test.

**Checkpoint:**
- [ ] `just app-test tests/app-test/atNNNN-imposer-flip-settle.test.ts` → `VERDICT: PASS`; `just app-test-covers-check` green.

---

#### Step 6: Lab measurement + brief record + freeze verdict {#step-6}

**Depends on:** #step-5

**Commit:** `roadmap(jul30-perf-brief): S5 record — settle measured walk-free; freeze ruled by measurement`

**References:** [Q01] nested-transform cost, [Q02] freeze necessity, [P01], (#success-criteria, #two-walks); instruments: `/api/eval` + `sample` per the [D5] discipline (unoccluded, interleaved baselines, ×3 medians, count leading sample integers)

**Artifacts:** S5 record + checked exit box in `dash/jul30-perf-brief.md`; the S5 section's "whole-page walk per frame" premise line updated to cite the I1 law; [Q01]/[Q02] resolutions recorded in this plan

**How the settle gets driven on a release build (found during the implementation run):** `window.__tug` is **not available** on release — `attachTugTestSurface` is a no-op unless `window.__tugTestMode` is set, and the `WKUserScript` that sets it is `#if DEBUG`-gated in `tugapp/Sources/TestHarness/TestHarnessUserScript.swift`, so no tugbank default can turn it on. `/api/eval` is available (`PUT /api/defaults/diag/eval {"kind":"bool","value":true}` on the instance's port, then `POST /api/eval {"code": "…"}`), and it reaches the real DOM — so the way to script an arrangement change is a real click on the Lens's Layouts picker (`document.querySelector('[data-testid="lens-layouts-kind"] [data-radio-value="two-up"]').click()`), which runs the genuine React handler and control-action path. `window.tugdeck.diag` (`getDeckState`, `listCardIds`, `captureCardState`) is available for reading state back. What `/api/eval` cannot do is *build* the deck: a fresh release instance starts at onboarding with zero panes, so the heavy deck this step measures on has to be a real one the user is already working in, or one stood up by hand first.

**Tasks:**
- [ ] On a dash-release lab instance rebuilt from the branch under test (newest-WebContent-by-start-time to find the PID): scripted settles on a heavy deck, sampled — walk delta ≤ noise vs interleaved baselines in tween steady state; two-walk gesture edges visible and priced.
- [ ] [Q01]: repeat with a live turn running inside a moving pane (wave + dot); record layer-count and walk deltas; accept or escalate on the numbers; mark Q01 resolved here.
- [ ] [Q02]: same live-turn run, freeze absent — measure mid-window React-commit cost (frame times in the gesture window vs the settled-pane run). Rule: frame budget held → Step 7 closes as not-needed; broken → Step 7 ships. Record the verdict and numbers in this plan and the brief.
- [ ] Frame budget: no settle-attributable main-thread frame over ~16.7ms in the gesture window (sample or Instruments, method noted in the record).
- [ ] Write the record; check the S5 exit box (or annotate it pending Step 7 if the freeze ships).

**Checkpoint:**
- [ ] The record's numbers are in the brief with method notes; [Q01] and [Q02] flipped from OPEN in this plan.

---

#### Step 7: Notification hold (CONDITIONAL on [Q02]) {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(code-session-store): notification hold for the settle window, on the replay-fold muscle`

**References:** [P04] store-API hold, Spec S03, Risk R01, [Q02], (#current-machinery); laws [L28], [L23], [L02]

**Artifacts:** `holdNotifications`/`releaseNotifications` in `tugdeck/src/lib/code-session-store.ts`; `forEachCodeSessionStore` in `tugdeck/src/lib/card-services-store.ts`; hold/release calls in the Spec S02 orchestration; `tugdeck/src/lib/code-session-store/__tests__/notification-hold.test.ts`

**Tasks:**
- [ ] Only if Step 6 ruled the freeze in — otherwise flip this step's ledger row to `done (not needed — see Step 6 record)` and stop.
- [ ] Store methods per Spec S03: held flag, wire-only deferral beside the replay-fold condition (including the `_publishCoalesced` branch), single flush on release, watchdog on `this.timerSource`, idempotent both ways.
- [ ] `CardServicesStore.forEachCodeSessionStore`; orchestrator hold at Spec S02.1 with cap `2 × windowMs` (min 1s), release at S02.4/S02.5.

**Tests (real store, real events — no mocks):**
- [ ] Hold → dispatch N wire `assistant_text`/`tool_use` events → zero listener notifications, snapshot unchanged; release → exactly one notification; state deep-equals an unheld control store fed the same events.
- [ ] Local-origin event mid-hold notifies immediately.
- [ ] Watchdog: hold with a small cap, no release call → flush fires once at the cap; a later `release()` is a no-op.
- [ ] Double-hold/double-release idempotence; replay-fold tests untouched and green.

**Checkpoint:**
- [ ] `cd tugdeck && bun test code-session-store` green; `bunx tsc --noEmit` clean; `bunx vite build` clean; re-run the Step 6 live-turn measurement with the hold active and record the delta.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Imposer arrangement changes cross via fully-accelerated, transform-only FLIP tweens through TugAnimator — per-frame layout and per-frame compositing walks eliminated from pane motion — verified by unit and app tests, measured on the lab, recorded in the brief, with the freeze question closed by numbers in either direction.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Settle motion is translate-only WAAPI in the qualifying form, created through TugAnimator; the `left/top/bottom/width` and rail transitions are gone from `tug-pane.css` (grep + app-test census).
- [x] No inline-transform residue after repeated settles, and portaled/fixed surfaces inside a pane still position against the viewport ([P07].4 app-test).
- [x] App-test green: during/after census, end geometry vs the numeric twin, retarget (including the post-inset-change flip) — `at0294`.
- [x] Lab record in the brief: steady-state walk ≤ noise (idle exactly zero), gesture-edge walks priced (three per gesture — the React commit is the third), frame budget held; [Q01] and [Q02] resolved on measurement.
- [x] [Q02] ruled the freeze in: hold semantics proven at the store layer (`code-session-store/__tests__/notification-hold.test.ts` — 0 notifies held → 1 flush, state-equal to control; watchdog; local-immediate; coalesce-timer absorption) and the live-turn re-measurement recorded (settle + held 386 vs settle-alone 327, 95% of the interaction penalty recovered).
- [x] Quiet contract: settled deck shows zero imposer-owned animations, timers, or retained transitions (census); reduced motion cuts with no fade — and neither measures nor holds (the snap is the settle).

**Acceptance tests:**
- [x] `cd tugdeck && bun test` (pane-flip and hold suites included) green.
- [x] `just app-test tests/app-test/at0294-imposer-flip-settle.test.ts` → PASS.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] I3 layer-population diet (divides the two remaining walks' price).
- [ ] The Tug animation API primitive layer — this plan's `pane-flip.ts` + TugAnimator pairing is a candidate first resident of the `compositor-contained` class (`dash/jul30-perf-brief.md#tug-animation-api`).
- [ ] `tuglaws/animation-doctrine.md` (brief `#tuglaws-doc`), citing this plan's tween as the worked FLIP example.

| Checkpoint | Verification |
|------------|--------------|
| Motion form | app-test census: transform-only tweens, zero residuals |
| Geometry truth | end gBCR vs `imposeRect` twin in app-test |
| Performance + freeze verdict | lab record in `dash/jul30-perf-brief.md#s5-imposer` |
| Hold (conditional) | store-layer bun tests + live-turn re-measurement |
