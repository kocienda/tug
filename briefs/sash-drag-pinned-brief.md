# A sash drag that stays one frame behind the hand, and an instrument that can see when it does not

**Purpose:** Dragging a sash between two split sidebar cards still lags the pointer by several frames after the `sash-drag-still-crossing` arc (`94fad882a`). That arc removed a cost it could measure on its rig, did not measure the two costs that scale with a real deck, and landed a sampler that cannot fail. This brief records why a DOM sash lags, what the last arc did and did not establish, and the shape of a fix that moves nothing through the rasterizer per frame.

---

## Purpose {#purpose}

The user's report, verbatim: "When I click on a sash and drag it, it should stay *pinned* under my mouse, not lag several frames behind it. WHY would this be hard? Tell me. Make a sketch to fix, and this time for good!"

The same complaint opened the previous arc two days earlier. That arc's own commit message says what it did not do: "What the readings do not support is the claim that this made the drag smooth, and nothing here says it did. … The reported judder is not reproduced on this rig at all, before or after." The user's deck reproduces it every time. So the first obligation of this brief is to say why the rig and the deck disagree, and the second is to name a change whose per-frame cost does not depend on what is in the cards.

---

## Evidence {#evidence}

**[F01] The sash is drawn at least two frames behind the cursor by the pipeline's geometry, before any cost is paid.** The cursor is composited by WindowServer straight from the HID stream. A DOM sash reaches the screen through: the mouse event in the UI process, IPC to the WebContent process, JavaScript, the rendering update (style, layout, paint), the layer tree commit back to the UI process, then that process's next CoreAnimation transaction and the vsync after it. A native `NSSplitView` drag lands the event and the CA commit in one UI-process run-loop turn and is one frame behind. So the achievable target for a DOM sash is "one rendering update behind the last mouse sample, every frame", never "pinned" in the native sense. **(reasoned from WebKit's process architecture; not measured, and not measurable from inside the page — `input-latency.ts`'s `PerformanceEventTiming` reading is the closest in-page proxy)**

**[F02] Every overrun frame is one more frame of visible debt, and WebKit drops mouse samples while it waits.** The UI process holds one pending mouse-move in flight and coalesces the rest until the WebContent process acknowledges it. A rendering update that misses its deadline therefore both delays the sash by a frame and discards the samples that arrived meanwhile, so the sash catches up in a jump. "Several frames behind" and "judder" are the same defect seen at two moments. **(reasoned; the previous brief's [F08] said the same and marked it unsampled — it is still unsampled)**

**[F03] The previous arc's own frame readings show the drag overrunning on its rig, and filed it as noise.** `at0626-sash-drag-sampler.test.ts`'s header records an idle frame interval of 17.0 ms and drag intervals of 18 to 20 ms "with the hold and without it", and describes "two frames in three over the interval" as "half rig". A mean rAF interval two to three milliseconds over the display interval on a rail holding two small cards is dropped frames. The hold removed about one millisecond and the drag still overran. **(verified, by reading the test header and the commit message of `94fad882a`)**

**[F04] The sampler's lag assertion is a tautology and cannot go red.** In `at0626` the instrument records `state.pointerY` from a document-capture `pointermove` and reads `seam.getBoundingClientRect().top` inside a `requestAnimationFrame` tick. The drag's own rAF callback was registered earlier in the same frame, so it has already published the fraction when the tick runs, and the rect read forces a synchronous layout. The seam is therefore always exactly at the last event's y, by construction, and the assertion "within one pointer sample" measures the DOM against itself. It sees nothing about paint, the layer commit, or the display. **(verified, by reading `tests/app-test/at0626-sash-drag-sampler.test.ts` lines 360 to 470 and 600 to 720)**

**[F05] The injected trail is slower than a frame, so no frame under test ever has a pending sample.** The harness fixes the gap between interpolated `mouseDragged` events at 20 ms in `tugapp/Sources/TestHarness/TestHarnessConnection.swift`, with a comment that windowserver coalesces anything faster. A real hand at 60 or 120 Hz delivers one or two samples per frame; the test delivers one per 1.2 frames. The coalescing the comment steps around is the very mechanism [F02] describes. **(verified, by reading the harness and its `client.ts` docblock)**

**[F06] Both divided members re-raster in full on every frame of the drag, and the cost scales with card area.** `.tug-pane` carries a standing `will-change: transform` (`tugdeck/src/components/tugways/tug-pane.css` near line 317), so every pane is its own compositor layer. The drag changes each member's height every frame by rewriting the run fractions its `top`/`bottom` `calc()` pins read. A composited layer whose bounds change is repainted whole, and `.tug-pane-chrome` (background, border, radius, title bar) and every non-composited descendant paint into that layer. Under the still-crossing hold the interior does not re-lay-out, but it is still repainted. Two Retina-scale card repaints per frame, more under cascade. The rig's rail held a small Cards card and a small Jots card; the user's deck holds session cards. This is the previous brief's [F06], recorded there as "inference, not measured; the sampler settles it", and the sampler did not measure it. **(inference from WebKit's `RenderLayerBacking` geometry update; not measured. `tugtool deck motion cost` during a drag on a loaded deck is what confirms or refutes it.)**

**[F07] The seam itself is not a layer, and it moves by layout.** `.tug-place-seam` is an absolutely positioned div whose `top` is a `calc()` over the same fraction property, with no `will-change`; its hairline is a pseudo-element. Moving it per frame is a layout and a repaint of the containing layer's region. Small, but it is a third thing the rasterizer touches per frame. **(verified, by reading `deck-canvas.tsx` `PlaceSeam` and `tug-pane.css` near line 2027)**

**[F08] The drag's write site is a `requestAnimationFrame` hop from the pointer handler.** `onPointerMove` stores `latestY` and schedules `apply` once per frame; `apply` publishes every seam fraction on the container. Style resolves once per rendering update regardless of how many property writes precede it, so the hop batches nothing that the engine would not batch. Whether it ever costs a frame depends on where in WebKit's frame the move lands relative to the rAF phase; the previous brief left this open and the arc did not measure it. **(verified as to the code; open as to cost)**

**[F09] The document-level `pointermove` listeners do no per-event layout during a sash drag.** `gesture-interpreter.ts`'s capture listener returns once `press.travelled` is set; `selection-guard.ts`'s returns unless a selection is being tracked. Neither reads geometry during a seam drag. The pane `ResizeObserver`s in `tug-pane.tsx` observe the title-bar controls and the accessory, whose boxes do not change under a height drag. The deck-canvas container observer only retunes after a quiet period. No React render runs per frame. **(verified, by reading each listener)**

**[F10] The deck now carries a gauge that reads the frame's rendering cost on the release build, which did not exist when the previous arc measured.** `window.__tugMotion.cost(n)` samples the interval from a rAF callback to a `setTimeout(0)` queued from it, which brackets style, layout and compositing update; `tugtool deck motion cost` is its shell end over the `diag/eval` door (`tuglaws/animation-doctrine.md` §deck-motion-verb, landed in `350eaa76d` today). It can be run while the user drags a sash on their own deck. Its budget constant, `RENDER_COST_BUDGET_MS = 16`, is calibrated at 60 Hz; on a 120 Hz display the interval is 8.3 ms and a 16 ms frame is two dropped frames. **(verified, by reading `tugdeck/src/lib/motion-guard/` and the doctrine)**

**[F11] The zoom unit mismatch in the held height stands and is not this defect.** The previous arc recorded that `markStillCrossing` feeds a `getBoundingClientRect` reading to a CSS `px` property inside a subtree under `body { zoom: var(--tug-zoom) }`, which differ at any zoom other than 1. A wrong held height clips the picture at the wrong place; it does not cause lag. Noted so it is not mistaken for the cause. **(verified, by reading the commit message of `94fad882a` and `tugdeck/styles/tug.css` line 115)**

---

## Decisions {#decisions}

**[B01] The first act is a reading of the user's deck, on the release build, with the gauge that now exists.** `tugtool deck motion cost` while dragging a sash between two loaded session cards, and again between a Cards card and a Jots card, with the display's refresh rate recorded beside the numbers. Nothing about this drag has ever been measured where it fails. The reading decides which lever the rest of the arc pulls: a p95 under the display interval means the residual is [F01]'s pipeline and [B04] is the lever; a p95 over it means [F06] is real and [B02] is. Both changes are still made, because both are correct on their own argument, but the reading is what the arc's findings paper has to carry, and it is what an "after" is measured against.

**[B02] During the drag, nothing painted changes size.** At the latch each divided member's box is set once to the largest height it can reach over the gesture, which the drag already computes from `seamDragBounds` through `cascadedHeights`, upper member anchored top and lower member anchored bottom, chrome included. Per frame the drag writes only compositor properties: `clip-path: inset(…)` on each member to cut it at the boundary, and a `transform: translateY` on the seam. A basic-shape `clip-path` on a composited layer is a shape-mask layer in WebKit, so changing it repaints nothing; a translated seam is a layer moving. At release the real fractions are published, the clips are cleared, and the one layout the interior takes lands as it does today. This is the previous brief's [B04] taken as the change rather than the second step: it removes the cost that scales with what is in the cards, which is the cost the rig could not show. The gauge from [B01] confirms whether the clip is free; if it is not, the same shape stands with the pane as a paintless clipping box and the chrome held at the largest height the way the card root is, and the boundary's square edge for the gesture's length is accepted because the seam's hairline covers it.

**[B03] The clip stands at rest on every pane at identity.** The animation doctrine forbids a gesture creating or destroying a layer inside the frame the eye is judging, and a mask layer applied at pointer-down is exactly that. So `clip-path: inset(0)` is standing state on `.tug-pane`, and the drag changes only its number. The cost at rest is one mask layer per pane, which [B01]'s reading prices; if WebKit elides an identity inset and promotes at first change anyway, that is a finding to record and the fallback in [B02] is the answer.

**[B04] The property write moves into the pointer handler; the `requestAnimationFrame` hop goes.** A `setProperty` is cheap, style resolves once per update however many writes precede it, and the hop has no case where it gains a frame and at least one where it may lose one. Removing it also closes the last open question the previous brief left. Publishing from the handler keeps the latch and every exit exactly as they are.

**[B05] Pointer prediction is the last lever, gated on the reading, and only for the pipeline's residual.** If [B02] and [B04] land, the reading shows every frame under the interval, and the drag is still visibly two frames behind, the seam may be extrapolated by pointer velocity over the measured pipeline latency, clamped to the drag's bounds. It overshoots at stops and is the only change here that trades correctness for feel, so it is not made until the numbers say nothing else is left.

**[B06] The instrument asserts two things the eye can see, sampled by timer, on a loaded rail, and is proved red on the old code before it is called green.** `at0626` is rewritten: it asserts zero animation frames longer than 1.5× the display interval during the held window, and a render-cost p95 under the interval using the gauge's own `sampleFrame`, both on a rail whose members are real session cards rather than a small list. Samples are taken by `setTimeout`, not rAF, per the occlusion finding. The harness's 20 ms trail floor is lifted so the trail runs at frame rate, and the coalescing the comment feared is observed rather than avoided. The rewritten test is run under a reverse patch of [B02] and must fail there; a sash sampler that cannot fail is what let the previous arc land green.

**[B07] The held-height zoom mismatch ([F11]) is squared in `markStillCrossing`'s contract, not in the seam.** It is one line of arithmetic at the one call site every hold shares, it affects the settle and the fold as well as the drag, and it is cheaper to fix while the hold is being reworked than to carry as a fourth open note.

---

## Open Questions {#open-questions}

- **Whether a basic-shape `clip-path` on a composited pane repaints in this WebKit.** Settled by the [B01] gauge on a build carrying [B02], not by reading. The fallback is in [B02].
- **Whether an identity `inset(0)` at rest keeps a mask layer standing or is elided.** Same instrument. Decides whether [B03] is standing state or a first-frame promotion the doctrine refuses.
- **The user's display refresh rate.** Everything above is stated against "the display interval"; the number is 16.7 or 8.3 ms and the gauge's budget constant assumes the first. Read with the [B01] numbers.

---

## Non-goals {#non-goals}

- **Making the sash native.** A host-side split view would own the pointer and the CA commit and be one frame behind, but the panes are DOM and the boundary would have to be mirrored back into them every frame across the same IPC. It moves the lag rather than removing it.
- **Re-measuring on the rig's small rail.** Two small cards do not carry [F06]'s cost. Every reading this arc quotes is taken on a loaded rail or on the user's deck.
- **Dropping the standing `will-change: transform`.** It is the previous animation arc's decision and the reason the re-raster is a fixed cost rather than a spike at each end of every tween. The answer to a layer that repaints on resize is not to resize it, which is [B02].
- **Holding the interior less, or per card.** The still-crossing hold from `94fad882a` is correct and stays; it is the raster, not the layout, that this brief adds to it.
- **The width drag.** Its per-frame cost is honest re-wrap of the rail's contents. Out of scope, though [B03]'s standing clip may be worth reading against it later.
- **Asserting "pinned" in the native sense.** [F01] says it is not achievable from inside a web view; an instrument asserting it would be red forever and read as noise.

---

## Exit {#exit}

An arc. Its first movement is [B01], the release-build reading on the user's deck, recorded in the arc's findings paper as the "before". Its second is the instrument, [B06], rewritten and shown red on current `main`. Its third is [B02] with [B03] and [B04] together, since the standing clip is what makes the per-frame clip write legal and the write site is where the number goes; then the same reading again as the "after", and the instrument green. [B07] rides that step. [B05] is a fourth movement that opens only if the after reading and the user's hand both say the pipeline is what remains.
