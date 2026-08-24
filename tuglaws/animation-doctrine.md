# Animation Doctrine

*Motion in Tug is event-clocked and quiet by construction. Every animated surface owns its silence; every running animation is authored in a form whose cost is known, measured, and paid at gesture edges — never per frame, never at rest.*

*Cross-references: `[L##]` → [tuglaws.md](tuglaws.md). `[D##]` (two digits) → [design-decisions.md](design-decisions.md). The laws in this document are the single-digit `[D1]`–`[D8]` coined by the jul30 perf program (`dash/jul30-perf-brief.md`) — code comments and plan records already cite them by those names, so the names are permanent. Evidence anchors: `dash/jul30-perf-brief.md` (the program record), `dash/imposer-pane-motion.md` (the worked FLIP plan).*

---

## The engine facts this doctrine stands on {#engine-facts}

Two findings, measured three independent ways on the real release deck and source-verified against WebKit trunk (`RenderLayerCompositor.cpp`, `KeyframeEffect.cpp`, `RenderElement.cpp`), are the ground truth under every law here:

1. **The per-frame whole-page compositing walk is caused by per-frame main-thread transform style commits, not by transform animations as such.** A software-ticking animation invalidates style on every rendering update; any transform-family diff trips `recompositeChangeRequiresGeometryUpdate` → the `computeCompositingRequirements` traversal over the entire page's layer tree, priced by total mounted layer population. `will-change` is irrelevant to this — the trigger is the style diff, not compositing status. Opacity is exempt by construction: it is absent from the geometry-update property list, and its value pushes straight to the compositor layer even when software-ticked.

2. **A completely accelerated effect stops ticking entirely** (`ticksContinuouslyWhileActive()` false): one requirements walk at animation start reserves the union of the whole journey in the overlap map (`computeExtentOfTransformAnimation` → `setAnimationExtent`), then zero walks per frame at any population, for any journey length. "Completely" is the sharp edge — one non-accelerable property in the same effect, or one blocked animation elsewhere on the element's effect stack (`KeyframeEffectStack::allowsAcceleration`), and the effect ticks anyway.

The corollary that organizes everything else: **the disease was only ever per-frame and at-rest cost.** A fixed handful of walks at the edges of a real user gesture is honest interactive cost ([D4]); a walk per frame, or any cost on a settled deck, is not.

---

## The laws {#laws}

Two of the eight organize the rest: **[D1] the quiet contract** governs what a surface may cost at rest (nothing), and **[D7] the event clock** governs how a surface knows it is at rest (it is told, it never asks). The other six are consequences and disciplines.

### [D1] The quiet contract — every animated surface owns its silence {#d1-quiet-contract}

Every surface that animates continuously has a data-driven notion of *quiet* that only its owner component can know: no data flowing, no work in flight, no gesture underway. The contract: **when my data is quiet, I am motion-silent and animation-object-free** — no running animations, no live timers driving repaint, no retained finished `CSSTransition`s. A settled deck is then zero running animations *by construction*, surface by surface — assertable by census and enforced as an invariant (the idle-silence gate, `at0291`), not a hope.

The stronger form, preferred wherever it applies: a thing that would not move gets **no animation object at all** — a zero-delta FLIP frame gets no tween, a settled session's dot demotes to `data-static`, an unfocused editor's caret rule is `animation-name: none`.

### [D2] Live-work motion runs in the contained form {#d2-contained-form}

A glyph depicting in-flight work may scale, translate, breathe, and wave, in any channel motion design calls for, **provided the animation qualifies for contained residency**: compositor-resident, one extent reservation for the whole journey, zero per-frame walks (#qualifying-form). Opacity-only authoring is a fallback of last resort for a motion that provably cannot qualify, never the default — motion design keeps its channels.

### [D3] The cost of motion is paid once, at authoring time {#d3-authoring-time}

Every motion primitive declares its residency class (#residency), and the class is verified by measurement on the bench (#falsification), not asserted in a comment. The end state is the Tug animation API (`dash/jul30-perf-brief.md#tug-animation-api`) — primitives with declared classes, event-clock subscriptions, and a lint against raw `@keyframes`/`element.animate()` in product surfaces. Until that layer lands (its own follow-up scope), this document plus the bench discipline is the enforcement: new continuous motion is authored inside the qualifying form, cites this doc, and gets benched before it ships.

### [D4] When real work is in flight, honest cost is acceptable; at rest, none is {#d4-honest-cost}

A session actively streaming is not idle — paying rendering cost to depict genuinely live work is defensible. Indefensible is paying it at rest: stuck in-flight indicators, breathing glyphs on settled sessions, decorative loops, holds and measurements for motion that will not run. The gate between quiet and motion is the truthful liveness of the thing depicted, derived from real state (turn phase, feed activity), never from "the card is mounted."

### [D5] Measurement discipline is part of the doctrine {#d5-measurement}

The binding method rules, dearly bought: profile release builds only; release-main is not a controlled environment (interleave baselines, repeat, take ×3 medians, discard runs whose baselines disagree); an occluded window does no rendering work and voids the run; suppress animations with `animation: none` via a probe sheet, never WAAPI `pause()` (pausing demotes to the main thread and reads *worse*); count leading sample integers from raw trees, never grep line counts; and prove the instrument is live with a forcing probe, because a driver that silently does nothing and a change that genuinely costs nothing produce the same reading (#falsification).

### [D6] Finite transitions must end and must be droppable {#d6-finite}

Settle crossings, hover/press states, card chrome — honest one-shots, but WebKit retains a finished `CSSTransition` in `getAnimations()` forever unless the surface drops it (`transition: none` on the rest state, per the dot's `data-static` demotion), and TugAnimator's completion path cancels its WAAPI object after committing. A surface is not quiet until its transition population is zero. This is [L27]'s acquisition-and-release applied to animation objects: a retained finished effect is a leak.

### [D7] The data event is the only clock {#d7-event-clock}

**Never poll a push system.** Every depiction of live work sits downstream of a data plane that already announces its changes (store events, feed frames, turn-phase transitions); a consumer that runs a standing timer to *ask* whether anything changed is re-deriving, at per-tick cost, a fact the system already pushed for free — and every "detect quiet and stop" mechanism (dormancy detection, idle gating, TTL decay) is a patch on that one mistake. Under [D7], quiet is not detected, it is **constructed**: no event, no work, and an idle surface holds zero timers and zero animation objects because nothing is running, not because something noticed.

Timers are permitted in exactly one shape — **finishers**: a timer may only complete work a data event started, and must terminate by construction. The finisher discipline: a finisher finishes the **data's** future, not the pixels' present — a plotted value can hold still while the window beneath it is still draining, so a finisher's stop condition must outlive the data horizon the last event touched, never merely observe that the screen stopped moving. (The sparkline's settle burst stops only when the value is stable *and* the rolling window has fully drained; its first cut stopped on value-stability alone and froze the tape at a clamped maximum — the bug this rule is made of.)

A stop must ride the **falling edge** of the data it depicts, on every path that edge can take — normal end, cancel, error, recovery. A depiction that outlives its data because one end-path forgot to stop it is a broken quiet contract, whatever the CSS says.

### [D8] No news is no news — the wire contract {#d8-wire-contract}

[D7] applied at the producer: an emitter publishes **change**, not state — an unchanged reading sends nothing, silence means "unchanged," and consumers hold the last published value indefinitely on the strength of that. Two obligations make the contract sound: the emitter must publish the **falling edge** (a final zero when the measured thing dies — silence must never be ambiguous between "steady" and "gone"), and no consumer may time out a held value (a TTL decay under this contract turns a steady reading into a lie).

Change thresholds layer by knowledge, each gate owning exactly the judgment it is positioned to make — wire-level dedup at the emitter, display-grain recognition at ingestion, plot-pixel recognition at the surface — and every gate compares against the value at the last *published/recognized* change, never the previous sample, so sub-threshold drift accumulates against a fixed reference and eventually fires instead of ratcheting under the threshold forever.

---

## Residency classes and their measured prices {#residency}

Three classes. The numbers are the permanent evidence, from the jul29B/jul30 program (idle-hunt lab bench at 12,200 composited boxes; real release deck at ~26k layers; [D5] discipline throughout).

| Class | Definition | Measured price |
|---|---|---|
| **compositor-free** | opacity/filter — outside the geometry-update property list entirely | walk **0** at any population, even software-ticked; the caret's sampled-opacity blink measured `applyKeyframeEffects` 0, walk contribution 0 on the heavy deck |
| **compositor-contained** | transform-family in the qualifying form (#qualifying-form) — completely accelerated, extent reserved once | steady-state walk ≈ 0 at any population: every cleanly-authored bench condition read 0–3 samples/5s vs baseline at 12,200 boxes; a 420×700 pane-sized tween on the real ~26k-layer deck read median delta ≈ 0 (68/85/81 vs neighboring baselines 76/88/63). Cost is per **gesture**, not per frame: ~11 samples per walk, three walks per gesture (React's geometry commit, tween start, land) |
| **main-thread** | per-frame JS style mutation (rAF), or any effect demoted to software ticking | the whole-page walk per frame, priced by total mounted layer population: an rAF transform loop lit the lab bench from ≈0 to walk 18 / `updateRendering` 21; the same frames rAF-driven on release read **2622** samples/4s against the qualifying settle's 290. One software-ticking transform on the heavy deck cost 85 samples/5s; thirty cost 112; zero cost 0. Forbidden in product surfaces; bench probes only |

Two multipliers on the main-thread class, recorded so nobody re-derives them: `will-change` is irrelevant to the walk (the trigger is the style diff, not compositing status — hinted layers still cost memory and population); and the walk's price scales with mounted layer population, so the population diet (brief I3) divides a cost that containment zeroes.

The interaction term, measured because it shipped machinery: **a React commit landing inside a running transform animation's window is superadditive** — settle alone 343 walk samples, a commit stream alone 654, both together 1809 (81% above their sum), with median frame delivery degrading 17ms → 20ms and four times the dropped frames. A commit dirties compositing while the animation's extent is reserved, forcing exactly the recompute the reservation exists to avoid. Deferring wire-origin notifications through the window (`CodeSessionStore.holdNotifications`) recovered 95% of that penalty (1556 → 386, within noise of settle-alone) with every deferred event landing in one flush at release.

---

## The qualifying form — the authoring recipe {#qualifying-form}

A transform animation earns the compositor-contained class when **all** of the following hold. This is the recipe, verbatim from I1's measured verdict:

- One `element.animate()` or CSS animation whose keyframes touch **transform-family properties only** — nothing else in the effect. (Mixing in opacity is permitted: opacity is itself accelerable, so the effect stays completely accelerated.)
- Strictly 2D. No `z`, no 3D functions — 3D breaks extent certainty.
- Explicit two-plus keyframes, no NaN offsets.
- **Keyword easing** (`linear`, `ease`, a single cubic-bezier). A multi-stop `linear(…)` points easing is the classic blocker: Core Animation expresses a segment's easing as one cubic Bézier, a multi-stop `linear()` is not one, and WebKit answers by blending the whole effect on the main thread. **A curve rides in sampled keyframe offsets under keyword `linear` instead** — the identical shape by construction, and a compositor can run it. Receipts: the pulsing dot measured 18.0% of a core with `linear()` easings and 0.9% with sampled stops (`tug-progress-pulsing-dot.css`); the imposer's damped spring is 33 sampled offsets (`lib/pane-flip.ts`).
- `composite: replace`, `playbackRate` 1, forward direction, finite non-zero duration.
- No other blocked animation on the same element's effect stack, and no ancestor transform animation running concurrently (the nested case costs extent certainty — measured bounded at +9% walk with 48 nested loops, accepted, but do not author it deliberately).
- For long moves: `fill: 'forwards'` + commit once at landing — one walk at start, one at land, zero between. For FLIP settles: `fill: 'none'` with an identity final keyframe, so cancellation at any moment has no wrong pose to snap to.

**The disqualifying delta**, equally sharp: driving motion by per-frame JS style mutation (rAF writing `style.transform`), or any condition that demotes the effect to software ticking. This is [L05]/[L13]'s "rAF is not for animation" arriving independently by measurement.

Two lifecycle edges that come with the form:

- **Residue.** TugAnimator's completion handler calls `commitStyles()` unconditionally before cancelling, stamping the final value into `el.style` whatever `fill` says. A standing inline `transform` — even identity — makes the element a containing block for `position: fixed` and portaled descendants. Every landing path of a transform tween on a structural element must clear the inline property; the ordering is safe because `TugAnimation.finished` resolves only after the commit-and-cancel handler runs.
- **Object teardown.** The animation object must not outlive the motion ([D6]): TugAnimator cancels its WAAPI object on completion; CSS transitions drop via the rest state's `transition: none`.

---

## Worked example 1 — the event clock end to end (Pulse) {#worked-event-clock}

The S2 rework is the reference implementation of [D7]/[D8] across a full producer→consumer chain. Before: a standing 4Hz sampler per tape, a perpetual 250ms easing interval per readout row, and dormancy machinery whose whole job was to detect that polling had been finding nothing — an idle Pulse card ran ~48 timer wakes/s. After: **zero timers, zero animation objects, zero frames at idle, each stage silent because the stage before it sent nothing.**

- **The wire ([D8]):** tugcast's resource sampler publishes only moved gauge channels (0.5% CPU / 4 MiB rss / exact-delta disk, referenced to last-published), sends no frame when nothing moved, and flushes one final all-zero frame when a session leaves the live set — the falling edge that keeps silence unambiguous. The deck holds indefinitely; the TTL was deleted because under this contract a decay is a lie.
- **The store gate:** `record()` recognizes change at display grain (gauge moved ≥1% of full scale vs the published reference) and pushes channel-tagged activity events; consumers subscribe, never sample.
- **The surface finishers:** the tape appends only downstream of events; its two timers are finishers — a settle burst that stops only when the plotted value is stable *and* the rolling window has drained past the last event, and one flat-off timeout that retires the scroll tween once the last recognized change scrolls off. Change is recognized in plot pixels (2px of amplitude vs the reference at last recognized change). The readout's easing became a glide burst: armed by events, terminated by its own no-write gate.

The geometry lesson that made it work: the pen draws the last value flat to the right edge, so "a flat line needs no new points" is literally true — quiet was made *constructible* by making stillness the default rendering, not by detecting it.

## Worked example 2 — the FLIP settle (imposer) {#worked-flip}

The S5 settle is the reference implementation of the qualifying form on a structural surface (`dash/imposer-pane-motion.md`; `deck-canvas.tsx`, `lib/pane-flip.ts`). The old motion transitioned `left`/`top`/`bottom`/`width` — per-frame *layout* of every moving pane's subtree, a cost class above even the walk. Now: React commits the final geometry in one layout pass; each moved frame is tweened from the inverse delta to identity — measured First in a store subscriber (pre-commit), Last in a layout effect (post-commit, pre-paint), spring shape in 33 sampled keyframe offsets under keyword `linear`, run through TugAnimator with `fill: 'none'` and every landing path clearing the inline residue. A frame with zero delta gets no animation at all; reduced motion skips tween, measurement, and hold alike — the snap *is* the settle.

Width crosses on the same tween, as a `scaleX` term anchored at the frame's left edge (the edge the move's `dx` is measured between) — the deck's content-width row and a card's own width preset both resize every frame in the chain, and a settle that carried only the move would slide the frames while their boxes cut. Carrying it as a *scale* rather than a width keyframe is what keeps the effect completely accelerated; it also means the frame's content is laid out at the final width for the whole crossing and stretches to meet it, which is the deliberate trade — interpolating the real width would re-run layout for every moving pane's subtree per frame, the exact cost class this settle exists to leave behind. The gesture must arrive as ONE commit for FLIP to measure across it, so `setContentWidth` resizes the panes, restamps the record, and re-solves the rails together.

Its prices, as measured on release: idle contribution exactly zero between gestures; three walks per gesture; nested descendant animations bounded (+9%); and the superadditive commit-in-window cost paid off by the notification hold (#residency) — deferral, never dropping, with a store-internal watchdog as the wedge guard ([L23]) and release as the clock.

Arriving and departing frames are carried too, but not by FLIP, which has nothing to say about either: a frame that was not on screen when the settle armed has no First rect to invert, and a frame that left is gone before any effect could run on it. An arriving frame plays its own entrance at the geometry the commit gave it — a fade up over a short rise, `PANE_ENTER_RISE_PX` — on its own TugAnimator slot so it never cancels a neighbour's geometry tween. A departing one leaves a **ghost**: an inert tile at its last rect, carrying the chrome's ground and radius and nothing else, faded over `PANE_EXIT_GHOST_MS` and removed when the fade lands. Departures are derived from the First measurement rather than from any close handler — a pane the arm measured that no longer has a frame has left, whichever path closed it — which is what keeps the treatment from being one button's manners.

### The accepted snaps {#accepted-snaps}

The settle's promise is that a layout change travels rather than jumps, and `tests/app-test/at0450-imposer-cut-census.test.ts` holds it to that by watching every frame for the length of a gesture: it reports any pane that changed places, or arrived, with nothing animating it. Four movements are deliberately outside that promise. They are recorded here so a reader meets them as decisions rather than finding them as bugs, and they are absent from the census for the same reason.

- **A theme swap, and a chrome-tier change.** Both move geometry from outside the store — token-derived chrome heights and radii resolve on the next paint — so no arrangement change arms a settle. Animating them would mean tweening on a signal the deck does not receive.
- **The settled-resize retune.** Rails re-solve 200ms after the hand stops (`RESIZE_RETUNE_QUIET_MS`), and that motion *is* animated; what is accepted is the delay before it, which reads as a second movement after the gesture ended. Re-solving continuously during the drag would put the allocator on the resize's clock, which is the cost the quiet window exists to avoid.
- **The content pop at settle release.** Session notifications held for the settle window flush when it closes (#residency), so a card whose content changed mid-settle repaints at the end of the motion rather than during it. This is the notification hold working as designed; the alternative is the superadditive commit-in-window cost it was built to pay off.

Anything else the census reports is a defect. An entry there is not a tolerance — a gesture that stops cutting has its allowance taken to zero in the same change, or the test goes quiet about the regression it exists to catch.

---

## The falsification method — bench a primitive before shipping it {#falsification}

Every new continuous-motion primitive, and every claimed residency class, is proven on a bench before it ships. The method:

1. **Mount against a synthetic population.** The walk's price is population-scaled, so a primitive benched on an empty page proves nothing. The idle-hunt lab bench plants ~12k composited boxes; the release deck (~26k layers) is the confirmation surface.
2. **[D5] discipline throughout:** unoccluded window, interleaved no-probe baselines, ×3 runs, medians, discard on baseline disagreement, `animation: none` probe sheet for suppression (never `pause()`), leading sample integers from raw `sample` trees.
3. **Prove the instrument with a forcing probe.** Run the same scenario driven by the disqualifying form (an rAF style-mutation loop) and confirm the walk lights up. Without it, "the primitive measured near-zero" and "the probe is broken" are the same reading. Equally: assert the driver actually did something (the [Q02] measurement was nearly ruled the wrong way by a driver that silently no-opped).
4. **Assert the quiet contract by census, twice.** The animation census (`document.getAnimations()` by name/target/playState, retained-transition count) *and* a timer census — two surfaces (native-input carets, interval-driven readout easing) taught the program that `getAnimations()` is structurally blind to timer-driven motion, so a quiet claim backed only by the animation census is incomplete. (The checked-in census snippet and standing-timer instrument are brief I4, still open.)
5. **Sampling benches stay out of CI.** They are on-demand measurement, not gates — the app-test layer asserts the census invariants; the bench asserts the price.

---

## What one page can and cannot promise {#containment}

Inside a single WebKit page, painter's order is document-global — any layer may in general overlap any other, so a *moving* layer means re-deciding who else needs compositing. The platform bounds this in exactly two ways, and the doctrine uses both: **extent reservation** (the qualifying form's one-walk-for-the-whole-journey, #engine-facts) and **overlap clip scopes** (a composited container that clips its descendants bounds their possible overlap to its own box). What the page cannot promise: any motion outside the qualifying form is priced by the whole deck's layer population, however small the moving thing is. The downward-only invalidation the pane model wants (see [pane-model.md](pane-model.md)) exists inside one page *only* in the qualifying form; if a future motion provably cannot qualify and its measured cost is unacceptable, the recorded fallback is host-side (out-of-page) pane composition — an architecture-round decision, not an authoring workaround.

## Relationship to the tuglaws {#tuglaws-relationship}

This doctrine deepens [L06] and [L13]; it replaces neither.

- **[L06]** (appearance through CSS/DOM, never React state) gains its temporal complement: appearance state must also be *quiet* — the DOM-zone mechanisms L06 mandates must shed their animation objects, timers, and retained transitions when the data they depict settles ([D1]/[D6]).
- **[L13]** (CSS declarative / TugAnimator programmatic / rAF for gestures only) gains its price sheet: "rAF is not for animation" is now a measured law — per-frame style mutation is *the* disqualifying delta that turns any motion into a whole-page-walk-per-frame ([L05] agrees for React-timing reasons; the compositor agrees for pricing reasons). TugAnimator remains the programmatic engine, with its completion-commit residue edge named in #qualifying-form.
- **[L27]** applies to animation objects: a finished-but-retained effect is an unreleased acquisition ([D6]).
- **[L23]/[L28]** govern the hold pattern: anything that defers user-visible updates for a gesture window needs a watchdog, idempotent release, and teardown coverage, and is driven through the owning store's published API, never by reaching in.
