<!-- brief-skeleton v1 -->

# Flow Swipe Settle

**Purpose:** A trackpad swipe across the flow strip judders on small movements and, when the hand stops, the cards snap back to where they stood before the swipe and replay it. The settle after a swipe must continue from where the hand left the cards, toward the next slot in the direction of travel, and never move backwards.

---

## Purpose {#purpose}

The user's report, on a laptop in flow mode, swiping between slots with the trackpad:

> The trackpad should have a *little* hump so that cards don't *judder* when I swipe a little.

> When I stop my swipe, and when the cards settle on a slot and animate to their proper position, they *must only ever move in the direction of my swipe*. Now, the cards *snap* back to some other position and then animate from there. BAD and WRONG. The animation after I lift a swipe must *continue from that point*, without any backtracking.

Two asks: a dead zone at the start of a swipe, and a release settle that starts where the eye is and runs one way only.

---

## Evidence {#evidence}

**[F01] The trackpad path commits `"cross"`; the drag path commits `"cut"`.** The canvas wheel handler (`tugdeck/src/components/chrome/deck-canvas.tsx`, `onWheel` near line 4500) draws every event through `previewFlowOffset` and, after `FLOW_WHEEL_IDLE_MS` (180 ms) of quiet, calls `commitFlowOffset(gesture.offset)` → `store.setFlowOffset(offset)` with the default landing `"cross"`. The drop-zone host's `commitScroll` (same file, ~line 3935) calls `store.setFlowOffset(offset, "cut")` for the same situation — a per-frame writer catching the store up. **(verified, read from code)**

**[F02] The settle's flow slide starts from the last *committed* offset, not the drawn one.** In `tugdeck/src/components/chrome/settle-engine.ts` the prelaunch slide computes `dx = nextFlowOffset - prevFlowOffset` (~line 1987) where `prevFlowOffset` is `flowOffsetRef.current`, advanced only on a commit. After a swipe, that is the offset standing before the swipe began. The move beat's inverse transform holds every frame at that stale origin for the first frame and tweens the whole swipe distance again. This is the snap-back the user sees. **(verified, read from code; not yet reproduced with a frame sampler)**

**[F03] There is no slot settle on the trackpad today.** The wheel commits wherever the hand stopped, clamped to the strip's ends via `clampFlowOffset` (`tugdeck/src/lib/layout-imposer.ts`). No stop list, no rounding to a slot. "Settle on a slot" is new behaviour, not a repair of an existing one. **(verified)**

**[F04] There is no hump.** Every wheel delta moves the strip 1:1 from the first event; a one- or two-pixel wobble moves the cards. **(verified)**

**[F05] `previewFlowOffset` is the one per-frame writer, on the store.** `DeckManager.previewFlowOffset` (`tugdeck/src/deck-manager.ts` ~line 5782) is called by the canvas wheel, the Layout card's strip scrub (`layout-card.tsx`), and the miniature window drag. It writes the canvas property and publishes the fraction; it holds no state. **(verified)**

**[F06] The settle's velocity plumbing exists.** `InterruptedBeat` carries a velocity in travels per second into the next beat (`settle-engine.ts` ~line 1514). The release slide can start at the hand's speed without new machinery. **(verified, read)**

**[F07] The move beat's curve is `"crossing"`.** `BEAT_RECIPE.move = "crossing"` (`settle-engine.ts` ~line 517). Whether that recipe overshoots was not checked; `tugways/physics.ts` documents that its spring solver *can* overshoot. If it does, a slot settle on it would pass the slot and come back — a backtrack. **(not verified; the recipe's damping must be read before the settle curve is chosen)**

**[F08] WebKit wheel events carry no phase.** A lift is not visible to the deck as an event; macOS continues to deliver momentum deltas after the fingers leave, decaying over time. The 180 ms quiet is the only end the gesture has today. **(verified by the existing comment at `FLOW_WHEEL_IDLE_MS`; momentum behaviour is platform knowledge, not measured here)**

---

## Decisions {#decisions}

**[B01] The settle after a swipe starts from the offset actually drawn, never from the last commit.** `previewFlowOffset` remembers the last offset it wrote; the flow-only slide in the settle engine reads that drawn offset as its origin when one stands, and every commit clears it. This fixes the trackpad, the Layout strip scrub, and any future previewer in one place, because the one writer is where the truth is ([F05]). It rules out the alternative of committing `"cut"` then `"cross"` back to back — two commits in one task is exactly the coalescing shape the prelaunch guard comments warn about ([F02]).

**[B02] A swipe starts in a held state and clears a small hump before the strip tracks.** Deltas accumulate while the strip stays still (events are still taken, so nothing else scrolls); once the sum passes a named constant (~16 px, tuned by feel), the strip tracks with the hump subtracted so there is no lurch. The hump applies once per swipe, not again after each pause within one. A swipe that never clears it moves nothing and commits nothing ([F04]).

**[B03] The release destination is the next stop in the direction of travel.** Stops are each slot's aligned offset plus the two clamped ends. Rounding to the *nearest* stop would let a swipe that stopped 40% of the way snap backwards, which is the forbidden motion. Direction is the sign of the last few deltas, not the net of the swipe, so a swipe that reverses settles the way the hand was last moving.

**[B04] The release curve must not overshoot.** Whatever recipe the release slide plays, its progress is monotonic — a spring with bounce passes the stop and returns, and that is a backtrack ([F07]). The slide starts at the hand's velocity via the existing interrupted-beat plumbing ([F06]). If the drawn offset is already within a pixel or two of the stop, commit `"cut"` and animate nothing.

**[B05] Momentum is part of the hand, for now.** With no phase available ([F08]) the release is still the 180 ms quiet; the settle takes over after momentum dies and still moves forward. Ship this first and judge by feel. If the settle reads as late, the next step is for Tug.app to forward `NSEvent.phase` / `momentumPhase` so the settle can begin the instant the fingers lift — a separate piece of work, not this one.

**[B06] The verifying app-test arms a frame recorder before the gesture, not at the settle.** The defect lands in the frame where the commit lands; a row clocked from the settle arm would miss it. The test drives synthetic wheel deltas, samples every frame's position per rAF from before the first delta through the settle's end, and asserts monotonic travel with no frame behind the last drawn offset. A second case asserts that a swipe under the hump moves nothing.

---

## Open Questions {#open-questions}

- **The hump size and the stop rule at the clamped ends.** 16 px is a starting value; whether the hump should scale with device pixel ratio, and whether a swipe past the last slot settles to the clamp or to the last slot, are feel calls best made with the change in hand. Neither changes what gets written.

---

## Non-goals {#non-goals}

- **Native phase forwarding from Tug.app.** Named in [B05] as the follow-up if the quiet-based release feels late; not part of this work.
- **Committing `"cut"` then `"cross"` to fake a continuation.** Rejected in [B01]; two commits in one task coalesce under the deferral.
- **Nearest-slot rounding.** Rejected in [B03]; it can move backwards.
- **Changing the drag path or the Layout strip scrub's commit.** They already land `"cut"` where they should ([F01]); [B01] reaches them only by making their preview the settle's origin, which is a no-op when they commit `"cut"`.

---

## Exit {#exit}

**An arc.** The shape of the first steps: make `previewFlowOffset` remember its drawn offset and teach the settle's flow slide to start from it ([B01]) — this alone ends the snap-back and should land first, with the sampled app-test ([B06]) proving it. Then the hump ([B02]). Then the stop list and direction-of-travel destination ([B03]) with a read of the `"crossing"` recipe's damping and a monotonic release curve ([B04]). Each step is independently shippable and the order follows the user's priority: the backtrack is the "BAD and WRONG", the hump is the "little".
