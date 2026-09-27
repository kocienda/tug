<!-- brief-skeleton v1 -->

# Workspace switches: cut out the cold rebuild, then design the motion

**Purpose:** A workspace switch on a real deck takes 350 to 640 ms from gesture to the departing picture being gone, freezes the screen for the first 200 to 340 ms, and runs at 12 to 15 frames per second for ~180 ms after it paints. The user wants the switch cheap first — the multi-hundred-millisecond pieces of work that are not needed removed — so that a small scale animation can then be *designed* on a deck that has frames to draw it in, instead of guessed at over a rough patch.

---

## Purpose {#purpose}

The user, on the shipped crossfade (2026-09-27):

> The crossfade just doesn't *feel nice*. It still judders a little bit, and it doesn't give a *solid* impression like the experience has been wonderfully and carefully designed. I definitely want the transition to be quicker than it is now — it gives the impression of doing a bunch of setup work... which it probably does — but this gives a feeling of being slow.

> When I arrive at the destination workspace: the cards *cannot shift, hop, or jump*. If we *stick the landing*, this will also substantially improve the impression of proper design and solidity.

After measuring, and after trying a scale animation over the switch as it stands:

> We need to make these workspace changes *cheap* — just like we made animated dots cheap.

> Cut out the unnecessary work. Get rid of multi-hundred-millisecond pieces of work that are not needed. Get us to the point where we can *design* a little scale animation, rather than just trying to come up with something that *sorta* works.

The deck this was measured on is the user's live Release instance: the shown workspace held 8 panes, 3 session cards, 13,846 elements and 67 running animations; the other mounted workspace held 2 panes and 1,612 elements. Viewport 2874×1640 at 2× (5748×3280 device pixels).

---

## Evidence {#evidence}

All timings are from the deck's own instruments — `space-switch-timing` and `space-quiet` in the trace ring, and the scratch frame recorder installed for the scale test — plus two `/usr/bin/sample` profiles of the WebContent process (25 s idle baseline; 90 s covering six real switches) and one of the host process. Ten switches were read before profiling, six during, eight under the cut form.

**[F01] The synchronous store swap is not the cost.** `DeckManager.activateSpace`'s `commitMs` was 4–8 ms and `restoreMs` 0 on every one of 24 switches read. **(verified, measured)**

**[F02] The screen is frozen for 200–340 ms after the gesture, and that window is one click task.** The canvas's crossfade layout effect ran 222–258 ms after `t0` arriving at the big workspace and 61–84 ms arriving at the small one (derived: `paintMs − quietMs`, valid because both records land in the same frame; 16 of 16 agree). The 90 s profile attributes ~1,234 samples across six switches (~200 ms each) to a single `MouseEvent → click → JS listener → microtask checkpoint` task: React's render and commit plus every layout effect in the arriving layer, none of which yields a frame. **(verified, measured and profiled)**

**[F03] Roughly three quarters of that task is style resolution forced by geometry reads.** Four DOM properties carry it — `clientWidth` (220 samples), `clientHeight` (209+), `offsetWidth` (208), `scrollTop` (260) — each descending into `Document::resolveStyle → Style::TreeResolver`, not into layout. Idle baseline for the same symbols: 0–5 samples in 25 s. A layer that was `display: none` has no computed styles, so the first read after the swap must style the whole subtree; but the profile shows **several** distinct full resolves per switch under different callers, which means writes between reads re-dirty large subtrees (`createAnimatedElementUpdate` and `CustomPropertyData::operator==` appear in the stacks, consistent with inherited custom-property writes). **(verified that it is style resolution and that it happens more than once; which writes re-dirty the tree is inferred and needs an instrument — see Open Questions)**

**[F04] The browser's own first frame after the task is cheap.** From the DOM attribute flip to the first painted frame: 25–53 ms (MutationObserver → requestAnimationFrame, six readings, alternating 25/52 by direction). Nearly all of the freeze is our code, not the engine's first paint. **(verified, measured)**

**[F05] After first paint there is a rough patch of ~180 ms at 12–15 fps, arriving at the big workspace only.** Frame intervals: 25, 68, 20, 27, 35 ms, then steady 17. Arriving at the small workspace: 51, 22, 5, then steady 17. The quiet gate's "two silent frames" therefore take 126–187 ms, and the shipped dissolve begins 348–402 ms after the gesture (501–527 under profiler load). **(verified, measured)**

**[F06] What fills the rough patch is the compositing rebuild of the arriving tree.** Per switch, profile deltas over idle baseline: layer-tree commit to Core Animation (`GraphicsLayerCA::flushCompositingState`) ≈ 70 ms; overlap-map walks (`computeCompositingRequirements` after style and after layout) ≈ 65 ms; a `WebAnimation.commitStyles` forcing a style flush ≈ 28 ms (this one is the dissolve's own finish and vanishes under the cut). The host process is nearly idle: applying the new backing-store surfaces (`asyncSetLayerContents` / `CAIOSurfaceCreate`) and CA transaction flushes total well under one frame per switch. **(verified, profiled; the per-switch split is approximate because the idle baseline was scaled from a separate sample)**

**[F07] The deck at rest carries `display: none` on hidden workspaces by design, and that word is the cold start.** `space-layer.css` chooses `display: none` "deliberately: a hidden workspace must cost no layout and no paint," and `tuglaws`'s Step-8 doctrine accepts that "its subtree has no boxes, so it can take no measurement while hidden — every canvas geometry is armed on the shown transition." Every re-arm site in the recording (`briefs/workspace-switch-quiet-recording.md`) exists because of this choice, and so does [F03]'s first unavoidable resolve. **(verified, read from the code and the recording)**

**[F08] The pure cut beats the shipped crossfade, by feel and by instrument.** With `--tug-motion: 0` (no cover, no freeze, no dissolve) the user's verdict was "*better*, by a lot." First paint measured 149–160 ms arriving at the small workspace and 312–323 ms at the big one, against 226–268 and 348–402 with the dissolve. The 312 ms is [F02] still standing; the cut feels better because the new picture appears the instant it exists rather than after a hold plus a 240 ms fade. **(verified, measured and judged by the user)**

**[F09] No scale animation over the switch as it stands can be smooth, and four variants proved it.** Started at the DOM flip (140–170 ms), the animation finished before the first paint and was seen once in five. Started on the first painted frame, it stepped in two beats across the rough patch, and unpinning the canvas's compositor layer at its end added a demotion rebuild — the "persistent hitch at the end." Started two frames late, it showed the deck at full size and then snapped to 99 % — the oscillation. Started at the flip with a backwards fill and a 320 ms ease-in-out, two thirds of its progress elapsed before smooth frames existed and it was "sometimes visible and sometimes not." The frame recorder shows why: a short animation's entire life falls inside [F05]. **(verified, four live trials with frame timing)**

**[F10] Several landing hazards are structural, not incidental.** The quiet gate watches pane rects, the canvas settle mark and the canvas's own commit counter, and nothing inside a card; a list view in the arriving workspace re-based its scroll extent 104 ms after a real switch, invisible to the gate. `[data-space-switching] .tug-pane { transition: none }` is lifted when the dissolve *begins*, so any pane geometry landing after that point animates in view. The 200 ms bound is a wall that uncovers a slow first show mid-write. **(verified, read from the code and the trace ring)**

**[F11] The switch's frozen picture and crossing layer are themselves work on every switch away from the big workspace.** The departing wrapper flips `display: contents → block` with a new stacking context and z-index, 8 panes get four inline rect writes and five re-stamped attributes each, and the whole 13.8k-element live layer is then group-opacity blended for 240 ms over 8 permanently composited children (`will-change: transform` in `tug-pane.css`), which Core Animation renders offscreen at full window size every frame. Under the cut none of this runs. **(read from the code; its share of the switch cost was not separately measured)**

**[F12] Standing cost unrelated to the switch, noted so it is not lost.** Even idle, the deck spends ~5 ms per second in `ResizeObserver::gatherObservations` every frame; 157 tool-call headers are each observed by the block chrome. **(verified in the idle profile; not this brief's work)**

---

## Decisions {#decisions}

**[B01] The switch is a cut. The old cover-and-dissolve is retired.** The arriving workspace paints on the first frame after the swap and nothing is painted over it. This is the form the user judged better by a lot [F08], and it removes [F06]'s `commitStyles` flush, the whole of [F11], the quiet gate and its bound, and every landing hazard in [F10] that stems from a cover lifting at the wrong time. A dissolve is the wrong tool for this gesture: its stated purpose was to hide geometry landing late, and the right fix for geometry landing late is for it not to land late. What would revisit this: a measured switch that is cheap and still reads as too abrupt — at which point motion is *designed* on top of the cut ([B06]), not a cover reinstated under it.

**[B02] A hidden workspace keeps its render state. `display: none` goes.** The hidden layer stays styled, laid out and composited; it is taken off screen with `visibility: hidden` and its paint and hit-testing skipped with `content-visibility: hidden`, and the shown layer's `display: contents` stays exactly as it is. This is the premise change that removes the cold rebuild in [F03]'s first resolve and most of [F06], and it dissolves the re-arm table: a measurement taken while hidden is a real measurement again, so the composer line box, the pane accessory height and the controls width no longer need to be armed on the shown transition. The resting-cost objection `space-layer.css` recorded is real and is answered by measurement, not assertion: a hidden layer with `content-visibility: hidden` paints nothing and is skipped by the overlap map, and the deck's tripwires (`tugtool deck motion cost`, the breaker) are the instrument that says whether resting cost moved. What must be checked and pinned: the `[B06]` broadcast rule (a card in a hidden layer still must not answer a broadcast), pointer inertness, focus never landing in a hidden layer, and the first-mount fade class from `briefs/workspaces-content-visibility-brief.md` `[F02]`, which was a `commitStyles` on an unrendered element — `visibility: hidden` is *rendered* for that purpose, which is a point in this decision's favour and must be verified rather than assumed.

**[B03] Arrival pays style resolution once.** Every read-then-write-then-read chain in the arriving layer's effects is found and broken: geometry reads batched ahead of writes, or moved to a `ResizeObserver` callback so the engine resolves once at the frame boundary, and writes of inherited custom properties on card or pane roots moved to where they do not re-dirty a subtree that is about to be read. The target is one `resolveStyle` under the click task, and with [B02] in place that one is small. Verified by profile, not by feel: the four property getters in [F03] are the tripwire symbols.

**[B04] The swap leaves the click task.** The store commit stays synchronous and cheap [F01]; React's commit and the arriving layer's effects are allowed one frame boundary after it so the browser can paint before they run — or, if [B02] and [B03] together make the whole task cheaper than a frame, this is moot and is not done. Decided as an order rather than a mandate: measure after [B02] and [B03], and only reach for this if the click task still exceeds one frame.

**[B05] Nothing on the arriving side may animate or transition until the switch has settled.** The `transition: none` stand-down on arriving panes holds until the deck's frames are steady, not until a dissolve begins, and the settle's `"cut"` spelling stays. With [B02] there should be no late geometry to hide; this is the belt for the braces, and it is what "stick the landing" asks for in code.

**[B06] Motion is designed after the switch is cheap, and not before.** A small scale on the whole canvas is the candidate the user wants to design: it read well in the one trial where frames existed to draw it. The design constraints already learned: it starts on the first painted frame, not at the DOM flip [F09]; the canvas is a compositor layer at rest for the length of the feature so neither end of the animation promotes or demotes [F09]; scale and duration live in CSS custom properties settable on the live deck so the user can tune by feel; and it is a transform on the canvas container, whose `position: absolute` children ride along without re-layout. It is not part of this arc's acceptance. It becomes possible when [F05]'s rough patch is gone, which this arc measures.

**[B07] Acceptance is measured, on the real deck, before and after.** The same instruments this brief used: `space-switch-timing` (`paintMs` gesture to second painted frame), the frame-interval recorder for 600 ms after each switch, and the four getter symbols in a `sample` profile. Targets: gesture to first paint under one frame at 60 Hz on the re-show path on a deck of this size; no frame over 20 ms in the 600 ms after arrival; one `resolveStyle` per switch. A fixture the size of `at0620`'s cannot show this — it must be read on a deck with several thousand elements and dozens of running animations, or on a harness fixture grown to that size.

---

## Open Questions {#open-questions}

- **Which writes re-dirty the arriving subtree between reads [F03]?** The profile shows several full resolves per switch but the JIT frames above the getters are unsymbolicated. Settles it: a scratch instrument wrapping the four getters to record a stack and a `resolveStyle`-dirty check per call during one switch, or the Web Inspector's timeline on a switch. This decides how much of [B03] is a handful of call sites and how much is a pattern.

- **Does `content-visibility: hidden` on the hidden wrapper interact with `display: contents` on the shown one?** `content-visibility` needs a box; the hidden wrapper will have one, the shown one deliberately does not. The switch is therefore a `display` change on the wrapper after all (block ↔ contents), which may itself cost a compositing update. Settles it: measure the flip on the live deck. If it costs, the alternative is a wrapper that always has a box and a shown state whose box is the canvas's (`position: absolute; inset: 0`), which the crossing state already used without disturbing pane geometry.

- **Resting cost of a hidden layer that stays composited.** [B02] asserts `content-visibility: hidden` takes the layer out of paint and overlap; whether WebKit also drops its backing stores, and whether 5,000 hidden render layers change the overlap-map walk the dots' arc just made cheap, is to be measured with `tugtool deck motion cost` before and after, on this deck.

---

## Non-goals {#non-goals}

- **A better crossfade.** Shorter, steeper, per-pane rather than group, a truly frozen departing picture — all considered in the earlier sketch and all withdrawn. They tune a cover whose reason to exist [B02] removes.
- **A scale animation in this arc.** Four variants were tried live over the current switch and none could be smooth [F09]. It is the *next* piece of work, and [B06] records what was learned so it starts from a shape.
- **Fixing the ResizeObserver standing cost [F12].** Real, separate, and not this.
- **Host-side snapshots.** Faking the switch with a `WKWebView` snapshot faded natively was considered and set aside: it would hide the rebuild rather than remove it, and it would put the one visible motion in the app outside the deck's motion doctrine and its tripwires.
- **Lazy or partial mounting of hidden workspaces.** The direction here is to keep *more* render state for a hidden workspace, not less. Eviction of long-unvisited workspaces is a memory question for another brief.

---

## Exit {#exit}

**An arc.** The shape the first steps take:

1. **Measure first, on the live deck.** Land a repeatable reading — `paintMs`, the 600 ms frame-interval recorder, and a `sample` over four switches — as the arc's baseline, and instrument the four getters to answer the first open question. Nothing changes until this is in the record.
2. **Retire the cover.** Remove the crossing state, the frozen picture, the quiet gate and its bound; the switch becomes the `"cut"` it already commits as [B01]. Keep the switching mark and extend its stand-down to "frames steady" [B05]. Re-measure: this alone should recover the numbers in [F08].
3. **Keep hidden workspaces rendered [B02].** Change the hidden rule, verify the broadcast, focus, pointer and first-mount-fade invariants, and delete the re-arm sites the change makes unnecessary. Measure resting cost and switch cost.
4. **One resolve on arrival [B03].** Break the read/write chains the instrument named. Re-profile until the four getters are quiet.
5. **Only if still needed, leave the click task [B04].**
6. **Close with the acceptance readings [B07]** and hand the frame-interval record to the motion design that follows [B06].

Order matters between 2 and 3 — retiring the cover first means step 3 is measured against a cut, so its effect is legible — and between 3 and 4, because [B02] changes which reads are expensive.
