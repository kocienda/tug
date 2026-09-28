# Animations at zero cost at rest

**Purpose:** The deck spends most of every frame at rest on animations nobody can see, the instruments built to catch that read it as healthy, and every fold, switch and slide is being judged on a frame that is already three-quarters spent. This brief makes the at-rest cost zero, makes the gauge able to tell, and fixes the one card that is paying today's bill.

---

## Purpose {#purpose}

The report, on 2026-09-27: "We are back to getting basically *no frames* on a card fold/unfold. We just worked on this a couple of days ago and it's already regressed. WHY would this be hard to implement in a stable fashion?" Then: "It's utterly frustrating how you tell me that they're fixed and cheap one moment, and then the source of all performance degradation in the next." And on the finding: "This is *crazy* and must be fixed. We should be paying *zero* for this content not on screen."

The complaint has two parts and both are real. The fold is starved because the deck is doing per-frame work at rest. And the verdicts kept flipping because the instruments that produced them could not see the work. This brief is about both: the cost, and the gauge that let the cost through.

---

## Evidence {#evidence}

All readings are from the user's release deck (Tug.app pid 33027, WebContent 33102, port 55348) on 2026-09-27, via `window.__tugMotion.cost()` and `/usr/bin/sample`, unless marked otherwise.

**[F01] The main thread runs a rendering update every frame at rest, and pays a whole-page compositing walk inside it** — a 10 s idle sample of the WebContent main thread put 4094 of 6093 samples inside the rendering-update timer and only 1973 waiting in `mach_msg`. Under `Page::updateRendering`, 2625 samples were in `Document::resolveStyle`, of which 2550 were `updateCompositingLayersAfterStyleChange` (1914 in `computeCompositingRequirements`, 628 in `updateBackingAndHierarchy`); the style resolve proper was small (`TreeResolver::resolve` 265) and went through `createAnimatedElementUpdate → KeyframeEffectStack::applyKeyframeEffects → KeyframeEffect::apply`, ending in `RenderBlockFlow::styleDidChange → RenderLayer::styleChanged`. So: a handful of animated block elements have their style re-resolved on the main thread every frame, and each such change triggers a compositing walk priced by the page's layer population. **(verified)**

**[F02] JavaScript is not the dirtier** — over a 2 s window at rest: 2 `requestAnimationFrame` calls, 7 short timers (a store's `sweepExpired`), 6 DOM mutations (telemetry text). No script writes style per frame. **(verified)**

**[F03] Pausing every animation on the page takes the frame from 7 ms to 2 ms; pausing any one registered loop group takes it nowhere** — `cost()` p50 before 7, all 220 running animations paused 2, resumed 7. `tugtool deck motion bisect` over the same page: 0.00 ms drop for each of the eight groups (three pulsing-dot groups at 69×, two arc marks, three waves). **(verified)**

**[F04] The pulsing dots are the whole at-rest cost, and only the ones off screen** — pausing by family, with every animation of a figure paused and resumed together so no weld broke: everything paused 3 ms; caret blink alone 4; arc marks alone 4; waves alone 3; pulsing dots alone 12. Then by placement: all dots paused 3; only the 28 on-screen dots running 3; only the 215 off-screen dots running 13; all running 12 to 15. An on-screen dot costs nothing measurable. An off-screen running dot costs roughly 0.05 ms per frame, every frame, and 215 of them cost 10 ms. **(verified)**

**[F05] The 223 running dots are the session-identity marks in the Overview sidebar card** — every running dot but a handful sat under `.overview-post-refs > .tug-session-identity > .tug-session-identity-dot > .tug-progress-indicator > .tug-progress-pulsing-dot` in the pane with `data-rail-member=overview`. Each post reference to a live session carries a live dot (`tugdeck/src/components/tugways/tug-session-identity.tsx`, "The mark is a live pulsing dot, and it is the same mark on both registers"), and the Overview lists hundreds of posts from one live session, so one live session is drawn as 223 breathing dots, 215 of them scrolled out of view. The count grows with the session's posts; it was 70 at the start of the investigation and 243 forty minutes later. **(verified)**

**[F06] An off-screen running dot is not compositor-resident on this WebKit** — that is the reading of [F04]: a resident animation's per-frame cost does not scale with population, and this one does. Which WebKit rule refuses acceleration for these layers (clipped out of the scroller's visible rect, no backing store, or a compositing policy) is not established and does not need to be for the fix; the fix is that they do not run. Confirming the rule would be a bench with dots inside and outside a scroller's clip, read by `cost()`. **(inference from [F04]; the mechanism is unverified, the cost is measured)**

**[F07] `bisect` is blind to a loop that shares its target with another loop, and it breaks the dot's weld** — it pauses one loop group at a time (`tugdeck/src/lib/motion-guard/diagnostics.ts`, `bisect()`). A pulsing dot is three animations on two elements of one figure; pausing the breathe leaves the ring dirtying the same style on the same frame, so the drop reads 0.00 for a loop family that costs 10 ms ([F03] against [F04]). The per-group pause also runs the ring for a second while the dot is held, so after a bisect the two are out of phase; the user saw this on 2026-09-27 and read it as a regression. **(verified; the weld break was observed, the cause is read from the code)**

**[F08] The render-cost budget was calibrated on a bench whose quiet reading already contained this cost** — `tuglaws/animation-doctrine.md` records the quiet p95 rising from 5 ms at 100 dots to 8 ms at 300 in `at0629`, and doubles the worst quiet p95 into `RENDER_COST_BUDGET_MS = 16`. A truly resident population costs nothing that scales. The scaling that was observed was this disease at bench size, recorded as healthy noise, and the breaker was tuned never to fire on it. The doctrine's own sentence, "the quiet frame pays for nothing that scales at all", is contradicted by the table beside it. **(verified from the doctrine's recorded readings)**

**[F09] No guard asserts the one property that matters** — the probe measures cost per frame and the breaker trips on three over-budget samples (`tugdeck/src/lib/motion-guard/render-cost-probe.ts`, `breaker.ts`). Nothing measures whether the page schedules a rendering update at rest at all. A deck running one 7 ms update every frame with nothing streaming is under budget on every sample and reads as healthy. **(verified by reading the code)**

**[F10] The registry can only see what takes a hold** — `acquireMotionHold` is taken by the pulsing dot and the non-dot progress variants (`tug-progress-pulsing-dot.tsx:1167`, `tug-progress-indicator.tsx:576`). The caret blink (`tug-text-editor/theme.ts:339`) is a long-running loop the registry never sees; it measured cheap ([F04]) but it is unregistered, so no bisect and no census would have named it had it not been. **(verified)**

**[F11] The inventory** — 64 `@keyframes` across `tugdeck/src` and `tugdeck/styles` (plus the CodeMirror theme objects), 85 `transition:` declarations, 56 `animate(` call sites, 41 files touching `requestAnimationFrame`. Eight long-running loop families run on the live deck today: three pulsing-dot, three wave, two arc-mark, plus the unregistered caret. **(verified by grep and by `list()`)**

**[F12] The price of one dirty frame is set by the layer population** — every `.tug-pane` is a permanent compositor layer (`tug-pane.css:317`, `will-change: transform`), and the shown workspace holds about 13.8k elements. A single main-thread style change anywhere pays the walk in [F01] at 7 to 10 ms. The workspace-switch brief (`briefs/workspace-switch-cheap-brief.md`) already carries this as its cost anatomy; here it is the multiplier, not the target. **(verified in the earlier session's profiles)**

---

## Decisions {#decisions}

**[B01] Content off screen costs zero.** No animation runs on an element whose box is outside the visible area of its scroller or the viewport. This is the rule that makes the Overview card's 215 dots free, and it is a rule for every loop, not a patch for one card: a running progress glyph in a scrolled-away transcript row is the same defect. The mechanism is chosen by measurement rather than decided here. The candidates are `content-visibility: auto` on the list rows that carry loops, which lets the engine skip the subtree entirely, and an intersection observer that flips `animation-play-state` (or the figure's `data-mode`) off screen. Whichever one reads zero in [B04]'s gauge with 300 dots off screen wins; if both do, the declarative one wins. Resuming on scroll-in must not re-weld a dot audibly, so the dot's own start-time weld ([F07]) is the one that decides how a paused figure resumes.

**[B02] The Overview card draws one live session as one live mark, not as one per post.** Two hundred breathing dots for one session is wrong before it is expensive. Which surface carries the mark (the post's identity chip, the session's own row, both with only the first in view live) is a design call and belongs to the arc, but the count of live figures per live session in a list is bounded by what is on screen, and the list does not pay for what is not.

**[B03] The invariant is zero rendering updates at rest, measured on the live deck.** "p50 under 16 ms" is the wrong statement; it accepted [F01]. The statement is: with nothing streaming and no gesture in flight, the page schedules no rendering update, and a probe that arms on a rising motion edge reads zero updates per second once the deck is still. `cost()` keeps its meaning as the price of the frames that do run; the new reading is how many run. An animation that fails this is broken however it is authored, and the doctrine gets the sentence in that form.

**[B04] The gauge reports updates per second, and the breaker trips on updates at rest.** `tugtool deck motion` gains the at-rest count beside the cost. The breaker's trip condition adds the case the current one cannot see: sustained rendering updates with nothing in flight and no gesture, over the same three-sample window. The `motion-demoted` trace row carries which. The existing budget trip stays for the frame that is expensive as well as present.

**[B05] `bisect` pauses whole figures and attributes additively.** A group is every animation sharing a target element or a figure root, never one keyframe name. The reading is taken with everything paused first and one family woken at a time, which is the only shape that is not fooled by two loops dirtying the same frame ([F07]). Pause and resume happen in one synchronous turn per family, so no weld is broken by the instrument; a diagnostic that leaves the deck visibly worse than it found it is not one the user will run twice.

**[B06] The budget is recalibrated after [B01] lands, from a bench whose quiet reading is flat.** `at0629`'s quiet p95 must not move between 100 and 300 glyphs; if it does, the bench still contains the disease and the number it produces is not a budget. Only then is `RENDER_COST_BUDGET_MS` re-derived by the doctrine's own rule, and the doctrine's calibration table is rewritten from the new run with the old one kept as the record of what was accepted before.

**[B07] Every long-running loop registers, or the lint refuses it.** The caret blink joins the registry ([F10]); `scripts/audit-motion.ts` gains the rule that a `var(--tug-loop-iterations)` loop in a product surface has a hold owner, so the census and the bisect see everything that can tick.

**[B08] "Cheap" is a reading on the user's deck with the user's content, recorded in the trace.** The bench proves authoring; only the live deck proves cost. No motion work is called done on a bench number again. The at-rest count and the additive bisect, read on the release deck, ride the arc's audit for any change to a loop, and the reading is written into the trace so the claim can be checked days later.

**[B09] The fold is re-measured after [B01], before its code is touched.** The fold's frames were starved, not broken ([F04]); the fold-crossing hold and the settle choreography stay as they are until a reading on a quiet deck says otherwise. The same holds for the workspace switch: its brief stands, and this one does not widen into it.

---

## Open Questions {#open-questions}

- **Which off-screen mechanism actually reads zero.** `content-visibility: auto` skips the subtree, which is the strongest form, but it changes the row's intrinsic sizing and the list's scroll extents in ways `tug-list-view` may already manage by hand (`extent-rebase`). An intersection observer is a JS hop per row. The bench in [B01] settles it; the brief does not.
- **Why WebKit refuses residency for these layers** ([F06]). The fix does not depend on the answer, but the doctrine's residency section claims residency for the dot without this qualifier and should either name the rule or state the limit as measured.
- **Whether a demoted deck should re-arm itself.** The breaker latches until `reset()` or a reload; with updates-at-rest as a trip condition, a card scrolling its dots off screen would clear the cause and leave the latch. The arc decides whether the latch clears on a reading of zero.

---

## Non-goals {#non-goals}

- **Making the walk cheaper by shedding layers.** [F12] is real and the workspace-switch brief owns it. If [B03] holds, the walk does not run at rest and its price is paid only where a gesture earns it.
- **Redesigning the dot.** The figure's authoring is correct on screen ([F04]) and the two-well form from `350eaa76d` stays. This is about where it runs, not how it is drawn.
- **Re-deriving the budget before the bench is fixed.** A number from a bench that still scales is the mistake in [F08] made a second time.
- **Touching the fold, the settle or the workspace switch in this work.** [B09].

---

## Exit {#exit}

An arc. The order that matters:

1. **Land the gauge first** ([B03], [B04]): the at-rest updates-per-second reading in the probe and the shell verb, and a recorded baseline on the release deck as it stands today (about 60 updates per second at 12 to 15 ms). Everything after is judged against that number.
2. **Fix the instrument** ([B05], [B07]): figure-grouped, additive `bisect` that preserves welds; register the caret; the lint rule. Re-run on the release deck and confirm it names the Overview dots.
3. **Make off-screen content free** ([B01]): bench both mechanisms with 300 dots off screen, pick the one that reads zero, apply it to every surface that hosts a loop in a scroller. Read zero at rest on the release deck.
4. **Bound the Overview's live marks** ([B02]).
5. **Recalibrate** ([B06]) and rewrite the doctrine's invariant and calibration table.
6. **Re-measure the fold and the shade** ([B09]) on the quiet deck and record the readings; open nothing on them unless the readings say to.
