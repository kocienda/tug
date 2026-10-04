<!-- brief-skeleton v1 -->

# Flow Swipe One Move

**Purpose:** After a trackpad swipe across the flow strip, the cards make two moves — a glide that tracks macOS's momentum deltas to wherever they die, then a separate slide to the slot. The swipe and its landing must read as one continuous move, which means the deck has to know the instant the fingers lift, and WebKit's `WheelEvent` does not say.

---

## Purpose {#purpose}

The `flow-swipe-settle` arc (joined as `9dbc471d4d`) fixed the snap-back and added the hump and the forward-only stop. What it could not fix is the shape of the ending. The user, on the result:

> I still want to try and find some way for these swipes to end in a *single move*, rather than two moves (a glide-to-end followed by a fixup). Get what I mean here? I want *one move*!

Today the strip tracks every wheel delta 1:1 — the finger's and, after the fingers lift, the momentum deltas macOS keeps delivering on the finger's behalf. The gesture ends only when 180 ms pass with no delta, and the slide to the stop begins then. So the eye sees macOS's deceleration curve play out to a stop, a pause, and then Tug's curve to the slot: the glide and the fixup. One move means Tug's curve begins the moment the fingers leave the glass, seeded with the hand's speed, and macOS's momentum is never drawn at all.

---

## Evidence {#evidence}

**[F01] WebKit's `WheelEvent` carries no phase.** The DOM event has `deltaX`/`deltaY` and nothing about whether the fingers are down, lifted, or whether a delta is momentum. The deck's `FLOW_WHEEL_IDLE_MS` quiet (180 ms, `tugdeck/src/components/chrome/deck-canvas.tsx` ~line 299) exists because that is the only end a wheel gesture has in the page. **(verified, read from code and standing comments)**

**[F02] AppKit has the phase, and the host can see every scroll event before the web view does.** `NSEvent` carries `phase` (`.began`, `.changed`, `.ended`, `.cancelled`, `.mayBegin`) and `momentumPhase` (`.began`, `.changed`, `.ended`) on every `.scrollWheel` event, and `NSEvent.addLocalMonitorForEvents(matching: .scrollWheel)` observes them application-wide without consuming them. The fingers lifting is `phase == .ended`; the first momentum delta is `momentumPhase == .began`. This is the `UIScrollViewDelegate` `willEndDragging` moment, one layer down. **(platform knowledge, not yet exercised in Tug; nothing under `tugapp/Sources` watches scroll events today — verified by grep)**

**[F03] A host→deck bridge of exactly the needed shape already exists.** `MainWindow.swift` pushes host events into the page with `webView.evaluateJavaScript("window.__tugBridge?.onDictation?.(JSON.parse(…))")` (~line 1330), and the deck side installs the handler on `window.__tugBridge` at boot (`tugdeck/src/lib/dictation-bridge.ts`, `activation-click-bridge.ts`). A scroll-phase bridge is one more handler on that object and one more `evaluateJavaScript` site. **(verified, read from code)**

**[F04] The settle can launch at a given velocity, and can hand its velocity on when interrupted.** `motionKeyframes` takes `initialVelocity` in travels per second, clamped to `MAX_INITIAL_VELOCITY = 3.0` (`tugdeck/src/lib/imposer-motion.ts` ~line 105, ~line 166); an arm that interrupts a running beat reads its `progressAt`/`velocityAt` into an `InterruptedBeat` and seeds the replacement with it (`settle-engine.ts` ~line 1613). The prelaunch flow slide currently launches from rest — `motionKeyframes(BEAT_RECIPE.move, { nominalMs: settleMs })` at ~line 2090 passes no velocity — because the release fires after 180 ms of quiet when the hand has already stopped. **(verified, read from code)**

**[F05] The `crossing` recipe is critically damped.** `RECIPES.crossing = { zeta: 1.0, timeScale: 1.0 }` (`imposer-motion.ts` ~line 87). From rest it cannot overshoot. Seeded with a velocity *toward* the target it still cannot cross it — a critically damped spring approaching from one side with initial velocity toward the equilibrium does not pass it unless the velocity exceeds what the damping can absorb, and at ζ = 1 with velocity in the direction of travel the solution stays on one side. The `MAX_INITIAL_VELOCITY` comment speaks of overshoot, but it is describing the under-damped `landing` recipe (ζ 0.9). **(read from code; the no-overshoot claim under a seeded velocity is analysis, and the sampled app-test from [B06] of the prior brief is what confirms it)**

**[F06] The drawn offset and the forward-only stop are already in place.** `previewFlowOffset` remembers the offset it drew and the settle's flow slide starts from it; `flowNextStop` in `tugdeck/src/lib/layout-imposer.ts` resolves the next stop in the direction of the last few deltas, with `FLOW_STOP_NEAR_PX` of slack. The release already runs from the hand's position toward the right place; what is wrong is *when* it starts and what is drawn before it. **(verified, this is the joined arc)**

**[F07] Not every wheel event has a phase.** A mouse's scroll wheel reports `phase == []` and `momentumPhase == []` on every event, and the app-test harness's synthetic `WheelEvent`s never pass through AppKit at all. Those gestures still need an end. **(platform knowledge for the mouse; verified for the harness, which dispatches in-page)**

---

## Decisions {#decisions}

**[B01] Tug.app forwards scroll-phase transitions to the deck over the existing `__tugBridge`.** A local event monitor for `.scrollWheel` watches `phase` and `momentumPhase` and pushes a message on the transitions the deck acts on: fingers down (`phase == .began`, or `.mayBegin`), fingers lifted (`phase == .ended` or `.cancelled`), and momentum began (`momentumPhase == .began`). Per-event forwarding is not needed and not done — the deltas keep arriving through the DOM as they do today; only the edges travel the bridge. The monitor observes and returns the event untouched, so nothing about scrolling anywhere else in the app changes ([F02], [F03]). This is the route the prior brief's [B05] named as the follow-up, chosen now over inferring the lift from the deltas' shape (see Non-goals) because Tug owns its host and a fact beats a heuristic.

**[B02] The deck takes over at `lifted`: it resolves the stop, commits it, and launches the settle from the drawn offset seeded with the hand's velocity.** On the lift message, the canvas wheel gesture ends immediately rather than waiting for the quiet. It resolves `flowNextStop` in the direction of travel as it does today ([F06]), commits that offset, and the settle's prelaunch flow slide launches from `getDrawnFlowOffset()` with `initialVelocity` set from the hand's measured speed ([F04]) — travels per second over the slide's own `dx`, so the units match what the recipe expects. The curve is `crossing`, which does not overshoot ([F05]), so the forward-only guarantee from the prior brief holds. If the hand is already within `FLOW_STOP_NEAR_PX` of the stop, the commit lands `"cut"` and nothing animates, as today.

**[B03] Every wheel delta after `lifted` and before the next `touched` is swallowed.** macOS continues delivering momentum deltas after the fingers leave; the deck `preventDefault`s them (so the page does not pan) and draws nothing from them. Tug's curve is the only motion on screen from the lift to the landing — that is the whole of "one move." The gesture state gains a phase: `touched` (tracking 1:1, hump and all, as today), `released` (swallowing), and the idle fallback below. `momentumPhase == .began` also enters `released`, so a lift message that arrives late is caught by the first momentum delta's own announcement rather than by the deck drawing it ([B01]).

**[B04] The hand's velocity is measured from the last few finger deltas and their timestamps, and sets the curve's speed.** The deck keeps a short window of (delta, `event.timeStamp`) pairs during `touched` — the same `recent` ring the direction already reads from, widened to carry time — and at the lift computes px/s from it. That velocity seeds the slide so a fast flick lands fast and a slow drift lands slow; the recipe's `MAX_INITIAL_VELOCITY` clamp stays as the ceiling. Velocity is an input to the curve's *shape and duration*, not to the *destination*: the stop is still the next one in the direction of travel. A flick that skips stops is a feel question deferred to Open Questions, and "never backwards" is absolute regardless.

**[B05] The 180 ms quiet stays, as the fallback for gestures that carry no phase.** A mouse wheel and the harness's synthetic events never produce a `lifted` message ([F07]). For them the gesture ends on the quiet as it does today and the release launches from rest. Concretely: a gesture that has seen a `touched` message is phase-driven and ignores the quiet for its ending (the timer still runs, as a guard against a lift message that never arrives); a gesture that has seen none ends on the quiet. The two paths share everything after "the gesture ended."

**[B06] A touch during the settle is an interruption, not a new gesture from rest.** When `touched` arrives while the release slide is running, the arm's existing interruption path reads the beat's live progress and velocity ([F04]) and the new gesture picks up from where the frames actually are — the drawn offset becomes the slide's current position, and the hump is not re-armed, because the hand is catching a moving strip rather than nudging a resting one. The strip tracks 1:1 from that frame.

**[B07] The verifying app-test drives the bridge directly and keeps the frame recorder armed before the gesture.** Synthetic wheel events cannot carry a phase, so the test calls `window.__tugBridge.onScrollPhase(…)` itself, interleaved with the delta train — `touched`, finger deltas, `lifted`, then a decaying train of "momentum" deltas that must draw nothing. It samples position per tick from before the first delta through the settle's end and asserts: no frame moves against the direction of travel, no frame draws a momentum delta (the position after `lifted` follows one smooth curve to the stop, with no plateau where the old glide-then-wait was), and the landing is the next stop. A second case sends the delta train with no phase messages and asserts the quiet-based ending still lands correctly ([B05]). at0685 is the file to extend; its sampler already exists.

---

## Open Questions {#open-questions}

- **Should a hard flick skip past the next stop?** Today's rule and [B04]'s is "next stop in direction," with velocity shaping only the curve. A hand that flicks hard enough might expect to travel two or three slots, which is what a paging `UIScrollView` with deceleration does. It is a feel call that needs the one-move version in hand first; it changes which stop is chosen, not how the lift is detected or how the slide launches, so nothing in [B01]–[B03] moves if it is answered either way.
- **Bridge latency.** `evaluateJavaScript` from the local monitor to the page is an async hop; if it lands more than a frame after the last finger delta, one or two momentum deltas are drawn before `released` takes hold — a small glide, not a snap, and [B03]'s `momentumPhase == .began` edge bounds it at the first momentum frame. Whether that is visible is a measurement to take with the change built, not a decision to make here.

---

## Non-goals {#non-goals}

- **Inferring the lift from the deltas' shape.** Momentum deltas arrive at display cadence with geometrically decaying magnitudes and finger deltas do not, so three or four frames of clean decay could stand in for `lifted`. Rejected for Tug: it needs several momentum frames to recognize (so the glide gets a head start), a slow steady finger can fool it, and the real fact is one bridge message away ([F02]). It is the route for a deck with no host, which Tug is not.
- **Forwarding every scroll event, or its deltas, over the bridge.** The DOM already delivers the deltas with the right target and the scroll-routing conventions already apply to them. Only the phase edges are missing, so only the edges travel ([B01]).
- **Re-arming the hump on a touch mid-settle.** The hump is for a resting hand's wobble; a hand catching a moving strip has committed to moving it ([B06]).
- **Changing the stop rule, the drawn-offset origin, or the crossing recipe.** All three landed in `flow-swipe-settle` and are the ground this stands on ([F06]).

---

## Exit {#exit}

**An arc.** The shape of the first steps, in the order they must land: the host side first — the `.scrollWheel` local monitor in `MainWindow.swift` and the `onScrollPhase` push over `__tugBridge`, with a deck-side `scroll-phase-bridge.ts` installing the handler at boot and exposing the current phase to the canvas ([B01]). Then the canvas wheel gesture grows its `touched`/`released` states, swallows post-lift deltas, measures velocity, and ends on `lifted` with a velocity-seeded commit ([B02]–[B04]), with the quiet kept as the no-phase fallback ([B05]) and the mid-settle touch handled as an interruption ([B06]). The settle engine's prelaunch slide gains an `initialVelocity` input for the one caller that has one. The app-test extends at0685 per [B07], driving the bridge handler by hand. The flick-skips-stops question is judged by feel once that is on screen.
