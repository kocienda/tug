<!-- brief-skeleton v1 -->

# The pulsing dot, cheap: same motion, three stops, one clock, no churn

**Purpose:** The dots are still the bill. On the release deck the pulsing dot's loops put a 6 ms floor under every frame at rest, and that floor is what makes a workspace switch and an intra-workspace slide drop frames. The `motion-never-on-the-main-thread` arc landed two days ago and did not remove it, because it fixed a disease the dots do not have.

---

## Purpose {#purpose}

The user, on the app as it stands on 2026-09-26, running the 0.8.15 release built from HEAD that afternoon:

> Performance is laggy again when I switch workspaces or when I click in the Workspaces card to reveal a card in the same workspace that needs to scroll into view. Both animations are *choppy as hell* and *drop frames like crazy*.

And when the measurement named the dots:

> We just ran an arc on these dots too! They *can't* be allowed to bog down the whole system. We *must* find a way to get those dots running in the compositor. […] These dots are part of the main work the app does. We need to make it all *super cheap*!

Two constraints the user set without qualification. The animation stays as designed: the breath is a scale, the ring is a scale and a fade, and no redesign to opacity-only or to a cel flip is on the table. And the dots may not ripple work outward: not into the DOM, not into ARIA, not into layout. The user also reports that the dot and the ring do not stay coordinated, and that fixing that is part of the same job.

---

## Evidence {#evidence}

**[F01] The release deck's WebContent process is busy at rest, and the dots are the reason.** `top` on the 0.8.15 deck (pid 45622, up 53 minutes, 1.3 GB resident) read 30 to 47% CPU with no gesture in progress. The page's own probe (`tugtool deck motion cost --frames 90`) read a median frame cost of 6 ms, p95 8 to 12 ms, max 27 to 39 ms. With every long-running loop stilled by `tugtool deck motion demote on`, and sessions still streaming, the same reading fell to a median of 0 to 1 ms and p95 3 ms, and a 4 s `sample` of the process went from 41% idle to 77% idle. `tugtool deck motion list` showed 198 to 408 long-running animations over the session, every one a pulsing dot's breathe, emit-expand or emit-fade. **(verified, measured on the live deck)**

**[F02] The dots are accelerated. This is not main-thread ticking.** 100 real dots, cloned with their attributes onto the stilled deck so 300 loops ran in a fixed host, produced 3 samples of `updateAnimationsAndSendEvents` and zero of `invalidateStyleForAnimation` in 3 s, against 1 to 3 for a deck with no loops at all. 200 scratch loops in the dot's exact 21-stop `calc(var())` keyframe form behaved the same. WebKit runs these keyframes on the compositor, `var()` and all, and the arc's [B05] split of the crossing onto a well was not what was missing. **(verified by isolating the loops on the live deck under `sample`)**

**[F03] The cost is WebKit's overlap bookkeeping, paid per running transform animation on every compositing update, proportional to keyframe count.** In the loops-on sample, 525 of 650 `resolveStyle` samples were `updateCompositingLayersAfterStyleChange`, and half of that walk was `computeExtentOfTransformAnimation`, reached from `computeCompositingRequirements` and again from `updateBackingAndHierarchy`, each time through `setAnimatedPropertiesInStyle → interpolateKeyframes`. WebKit rebuilds its overlap map from scratch on every compositing update and, for each layer carrying a running transform animation, re-derives the box the layer can reach by sampling the animation once per keyframe, allocating a style per sample. It keeps no cache across updates. With 300 loops and one style change driven per frame, 21 linear stops cost 477 samples of extent computation in 3 s; the same cosine curve as 3 stops with per-segment `cubic-bezier` easing cost 80; a 3-stop opacity loop cost 0. Literal stops against `calc(var())` stops at 21 each measured the same (457 to 522), so the variable references are not a factor. **(verified with scratch loops on the stilled deck; the WebKit mechanism is read from the sample tree, and the per-keyframe sampling is inferred from `setAnimatedPropertiesInStyle` appearing under the extent computation)**

**[F04] The same curve in 3 and 2 stops cuts the real dots' cost four-fold, live, with no other change.** The stylesheet already exposes `--tugx-progress-pulsing-dot-breathe-name` and `--tugx-progress-pulsing-dot-emit-expand-name`. Injecting a 3-stop breath (trough, peak at 30%, trough, `cubic-bezier(0.37, 0, 0.63, 1)` on each segment) and a 2-stop expand (birth held to 27%, then reach on `cubic-bezier(0.33, 1, 0.68, 1)`) and pointing those variables at them on the running release deck took the extent computation from 54 to 14 samples and the compositing update from 178 to 121 in a 3 s sample, on the user's own dots. The deck held 22 breathing dots at that moment against 130 or more earlier in the day; the ratio is what carries. **(verified)**

**[F05] The doctrine's easing rule forbids the wrong thing.** The stylesheet's own comment records that a 14-to-21-stop `linear()` easing over two-stop keyframes made every loop unacceleratable, and that a many-stop keyframe list with `linear` interpolation was adopted as the fix. That reasoning is correct about `linear()` and silent about per-segment `cubic-bezier`, which Core Animation expresses natively and WebKit accelerates ([F02], [F04]). The cosine legs the breath was authored from are `cubic-bezier(0.37, 0, 0.63, 1)` to within a fraction of a percent; the ring's cubic ease-out is a bezier by construction. **(verified against the stylesheet and by [F04])**

**[F06] The walks are triggered by the app's own work, not by the dots.** Rendering updates on the live deck run nearly every frame while sessions stream, because every streamed message is a React commit that dirties style. A `MutationObserver` over the document for 2 s counted about 70 mutations, bursty rather than per-frame. The dots do not cause the walks; they set the price of each one. That price is what [F03] measures, and it is paid whether the gesture in flight is a settle, a switch or nothing. **(verified)**

**[F07] One phase change fans out to every mount of that session and does synchronous layout in each.** The observer caught one session going `streaming → tool_work` rewrite `data-phase` and `aria-label` on 27 `tug-progress-indicator` elements in the same millisecond, because a session's dot is mounted per transcript pin and per row. Each rewrite restyles that dot's subtree. In the component's crossing effect, `startLoops` deletes both gate attributes and forces `void root.offsetWidth` before setting them again; the promote, the settle and the resume paths each force `void well.offsetWidth` around an inline `transform` write; `liveScale` reads `getComputedStyle(el).transform`; `releaseEmitter` and `breathClock` iterate `getAnimations()`. Twenty-seven of those in one task is a layout storm on every phase change, and every one of those style writes is a compositing update that pays [F03] in full. **(verified, read from `tug-progress-pulsing-dot.tsx` and observed on the live deck)**

**[F08] The weld between dot and ring is procedural, and cannot be guaranteed.** Two loops on two elements are gated by two attributes and phased by two custom properties, and they share a start time only when both gates open in the same style flush, which the component secures with a forced reflow. On resume mid-pulse, `startBreath` starts the breath alone and `rejoinEmitter` restarts both loops later from a timeout chain; `ensureEmitter` re-arms that chain on every render that lands in between. The phase is read from `getComputedTiming().progress` in one task and applied as a negative `animation-delay` that takes effect at the next rendering update, so every restart can drift by up to a frame, and each rejoin restarts the breath with a visible stall. The user reports the two do not stay coordinated. The exact failing path was not reproduced; the architecture is what this finding names. **(the code is verified; the user's report is not reproduced here)**

**[F09] The circuit breaker cannot fire on this deck, and the tripwire cannot see this.** `breaker.ts` counts a sample toward a trip only when `inFlight === false`, and on the user's deck a session is always in flight, so `tugtool deck motion probe` read 0 trips across 80-plus motion holds with samples of 17, 19, 24 and 39 ms in the ring. The at0629 tripwire asserts render cost on a small quiet deck, where the walk is cheap regardless of what the dots do. **(the breaker gate and probe readings are verified; the tripwire's blindness is inferred from [F03] and [F06] and should be confirmed by reading `at0629-motion-render-cost.test.ts` at the door)**

**[F10] Alternatives were measured and lose.** A cel flip by `background-position` is a paint property and never accelerates. Cels switched by `steps()` are refused acceleration by WebKit. Cels crossfaded by steep linear opacity ramps are accelerated and pay no extent, but need one layer per cel per dot, and 8 opacity layers per dot measured about three times the cost of a 2-layer 3-stop scale dot. A per-dot animated image or video is a decode pipeline each. A single worker-driven canvas overlay would collapse the population to one layer but trades the walk for keeping every glyph's position in sync through scroll and layout. **(the opacity, scale and stop-count numbers are measured; the paint-property and `steps()` refusals are read from WebKit's acceleration rules as recorded in `motion-never-on-the-main-thread-brief.md` [F06])**

---

## Decisions {#decisions}

**[B01] The animation stays exactly as designed, and its keyframes are emitted as 3 stops for the breath and 2 for the ring expand, with per-segment `cubic-bezier` easing.** The breath is trough at 0%, peak at the turn, trough at 100%, with the cosine bezier on both segments; the expand is birth held to ignition, then reach on the ease-out bezier; the fade is unchanged. This is the same curve to within a fraction of a percent ([F05]), it is what Core Animation runs natively, and it takes the per-update bookkeeping most of the way to the opacity floor ([F03], [F04]). The generator in the component that samples the envelope into stops emits segments instead, so there is one source for the curve and the stylesheet's keyframe blocks follow it. The doctrine's easing note is corrected to forbid multi-stop `linear()` and `steps()`, which demote, and to permit per-segment bezier, which does not.

**[B02] A phase change is one write per session, inherited by every mount, and no crossing does synchronous layout.** The session's phase lands on one ancestor and the dots read it by inheritance, so 27 mounts cost one style change rather than 54 attribute writes ([F07]). `aria-label` on the indicator is set once from its role and never rewritten per phase; the dot is already `aria-hidden`. No `void offsetWidth` remains in the component: a pose is pinned and a loop dropped in one flush by ordering the writes, or by WAAPI where ordering cannot be guaranteed by CSS alone ([B03]). Every forced reflow removed is a compositing update that no longer happens, which is the same bill as [B01] paid from the other side.

**[B03] Dot and ring are one clock by construction: started from script with a shared `startTime`.** The loops are started with `element.animate()` and given the identical `startTime` on `document.timeline`, so they are welded exactly and forever, with no dependence on which flush opened which gate ([F08]). The phase is read as `animation.currentTime` rather than through `getComputedStyle`, and a resume mid-pulse sets the breath's `startTime` from the flying ring's rather than rejoining through a timeout chain. The visible motion does not change; what changes is that the weld is a property of the data. The CSS `@keyframes` remain the source of the curve and are handed to WAAPI by name, so the motion audit still reads them.

**[B04] The change is verified on the real deck and by a tripwire that can see it.** The name-override hooks that made [F04] possible are the acceptance test: the 3-stop form is measured against the 21-stop form on the release deck with `tugtool deck motion cost` and `sample` before the component changes, and again after. The at0629 tripwire is rewritten to mount a realistic population, on the order of a hundred breathing dots across several cards, drive one style change per frame the way streaming does, and assert the extent computation and the frame cost under budget ([F09]). The breaker's gate is changed so that an over-budget streak while sessions are in flight still counts, because in-flight is this deck's normal state.

---

## Open Questions {#open-questions}

- **Which coordination failure the user sees.** [F08] names the architecture; it does not reproduce the report. Before the weld is rebuilt, one session's dot should be watched through resume-mid-pulse, a phase flip during the inhale, and a render landing during the rejoin, so the pin in the harness is the user's case and not only the reading.
- **Where the one phase write lands.** The session row, the transcript pin and the composer chip mount the dot under different ancestors. Readable from the code at the door: the answer is the nearest element each mount shares with its session, or a per-session custom property on the deck root keyed by session id.

---

## Non-goals {#non-goals}

- **Redesigning the motion as opacity-only.** Rejected by the user. It is the only form with zero extent cost ([F03]), and it is recorded here so it is not re-proposed as a performance fix.
- **Cel animation in any form.** Measured or ruled out in [F10]. The accelerated variant is a two-layer opacity crossfade with more layers, and is worse than [B01].
- **Literal keyframe values in place of `calc(var())`.** Measured as no difference at equal stop counts ([F03]). The per-treatment values stay as variables.
- **Reducing how many places a session's dot is mounted.** Each mount is billed separately by WebKit and the count multiplies every cost above, but the user set it aside for this work. [B02] makes each mount cheap; it does not decide how many there are.
- **A single canvas overlay driven by a worker.** The only route to one layer for the whole population, and a much larger change than a keyframe emitter; deferred, not rejected.
- **Private API in the host, or any host-side meter.** Settled by the previous brief and unchanged.

---

## Exit {#exit}

An arc. The order the dependencies run: first the live measurement of [B04] as the baseline, taken through the existing name overrides so the number exists before a byte of the component changes; then [B01], the generator and the keyframe blocks, measured against that baseline on the release deck; then [B02] and [B03] together, since removing the forced reflows and rebuilding the weld touch the same crossing effect and the same start paths; then the tripwire, the breaker gate and the doctrine correction of [B04], which are what keep the first three from regressing unseen.
