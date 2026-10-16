/**
 * at0685-flow-swipe-catch.test.ts — a trackpad swipe clears a
 * small hump before the strip moves, and the settle after it runs from where
 * the hand left the cards to the next slot the way the hand was going, never
 * backwards.
 *
 * ## The defect
 *
 * A horizontal wheel on the canvas draws the strip through
 * `previewFlowOffset` on every event and commits once, after the idle quiet.
 * The settle's flow slide used to plan its origin from the store's LAST
 * COMMITTED offset — which, after a swipe, is where the strip stood before the
 * hand touched it. The slide's inverse transform held every frame at that
 * stale origin for its first frame and then tweened the whole swipe distance
 * again: the cards snapped back and replayed the swipe. The fix is one fact
 * kept where the truth of the screen already lives — the per-frame writer
 * remembers the offset it drew, and the arm reads it as the origin — and a
 * commit of the very number the deck was drawing lands `"cut"`, because the
 * frames are already where it puts them.
 *
 * ## Why the recorder is armed BEFORE the gesture
 *
 * The defect lands in the frame where the commit lands. A row clocked from
 * the settle arm (`settle-frames`) begins AFTER that frame and cannot see it;
 * a reading taken after the settle sees only that the cards ended up in the
 * right place, which was always true. So this file samples where a card
 * actually stands, from before the first delta through the end of the settle
 * window, and asserts over the whole trace: no sample behind the hand's last
 * drawn position, and travel monotonic in the direction of the swipe.
 *
 * The sampler is a timer rather than `requestAnimationFrame`, which an
 * occluded harness window suspends; the reading is `getBoundingClientRect`,
 * which carries a running tween's transform and so answers where the card IS.
 *
 * ## The hump
 *
 * A resting hand sends a pixel or two of sideways delta, and a strip that
 * tracked 1:1 from the first event juddered on every one. So a gesture opens
 * held and draws nothing until its deltas sum past `FLOW_WHEEL_HUMP_PX`; the
 * first event past it draws the sum less the hump, so there is no lurch. The
 * second case drives a train that never clears it and asserts the card, the
 * store and the offset property all stand where they were; then a train that
 * clears it with a pause inside and asserts the travel is the sum less ONE
 * hump — a pause within a swipe does not re-arm it.
 *
 * ## The release
 *
 * The idle commit does not land wherever the hand stopped: it resolves the
 * next STOP — a slot's aligned offset, or a clamped end — in the direction of
 * the hand's last few deltas, and the settle slides there from the drawn
 * offset on a critically damped curve from rest, which cannot overshoot. Not
 * the nearest stop: a swipe that stopped forty percent of the way would be
 * sent back, which is the forbidden motion. The third case stops a swipe
 * forty percent past the first slot and asserts the settle lands on the
 * second with every frame moving one way; then reverses inside a swipe and
 * asserts the settle goes the way the hand LAST moved.
 *
 * ## The lift
 *
 * On a trackpad the deck does not wait for the quiet. Tug.app forwards the
 * fingers' phase edges over `__tugBridge.onScrollPhase`, and the gesture ends
 * the instant the `lifted` edge arrives: the stop is committed then, and every
 * delta macOS sends on the hand's behalf afterwards — the momentum — is taken
 * and drawn nowhere, so the settle from the hand to the stop is the only
 * motion. Synthetic wheel events never pass through AppKit, so the fourth case
 * calls the bridge handler itself around the train: `touched`, the finger
 * deltas, `lifted`, then a decaying momentum train. It asserts the store held
 * the stop before the momentum ended, the drawn offset never took a momentum
 * delta, every momentum event was taken, and the card ran one way from the
 * hand to the stop with no plateau — the glide-then-wait the quiet used to
 * leave. The first three cases send no edges, and are the quiet's fallback.
 *
 * ## The hand's speed
 *
 * The slide from a lift launches at the hand's measured speed, toward the
 * stop only, so a fast lift lands fast and a slow one slow — the curve's
 * shape changes and its destination does not. The fifth case lifts the same
 * finger travel twice from a stop, once fast and once slow, so the distance
 * from hand to stop is the same, and asserts the fast slide's curve covers
 * more ground in its first tenth, with every sampled frame of both one-way
 * and none past its stop. The curve is read off the slide's own keyframes,
 * in the lift's task: sampled positions this early carry the first frame's
 * latency, which differs slide to slide by more than the launch does.
 *
 * Both lifts here, and every lift case that asserts the NEXT stop, move at a
 * brisk pace the flick projection still lands one slot on — `BRISK_GAP_MS`.
 *
 * ## The flick
 *
 * A quick swipe travels more than one slot: the lift projects the hand on at
 * its speed (`FLOW_FLICK_COAST_S` × `FLOW_FLICK_SENSITIVITY`) and lands on the
 * stop ahead nearest that aim. The flick case lifts the same finger travel
 * fast, from rest, and asserts it settles past the next stop, on the offset it
 * committed at the lift, with every frame one-way and none past where it lands.
 *
 * ## The catch
 *
 * A touch while the slide from a lift is still running catches the strip: the
 * settle hands it over where it stands on screen, and the hand moves it 1:1
 * from there with no hump re-armed. The sixth case lifts, touches again
 * partway through the slide, and sends a few deltas; it asserts the strip was
 * caught where the slide had it rather than leaping to the stop, the first
 * delta drew from the caught place, and the whole trace ran one way.
 *
 * ## The fixture
 *
 * at0454's flow deck: five 420px cards in a six-up beside a 420px Layout
 * rail, a strip comfortably longer than the band on any window this harness
 * opens. The strip's overflow is asserted rather than assumed — a band with
 * no room to swipe into would move nothing and prove nothing.
 *
 * The swipe is a train of synthetic wheel events through the deck's own
 * handler, so the offset that lands is one the product clamped and
 * committed. The train is dispatched in-page on a timer, spaced well inside
 * the handler's idle quiet, so a slow RPC round trip cannot end the gesture
 * early; the hand's last drawn position is read in the same task as the
 * last dispatch, before any frame could move it.
 *
 * `deck-manager.ts` and `deck-canvas.tsx` are deliberately NOT named, and the
 * absence is the selection budget's answer rather than an oversight: both
 * already fan out to the count `ACCEPTED_FANOUT` records, and one more namer
 * would turn a one-line edit there into a sweep. What this file needs covered
 * is the drawn offset's CONTRACT — that the writer remembers it and the arm
 * reads it as the origin — which is `deck-manager-store.ts`'s doc comment and
 * the settle engine's arm, and the hump's size, which is the constant in
 * `layout-imposer.ts`; all three are named below.
 *
 * ## The cut
 *
 * Cut from `at0685-flow-swipe-settles-from-hand` to fit the 20 s budget. This
 * file carries the catch; `at0685-flow-swipe-quiet` carries the settle after
 * the idle commit and the hump, `-release-lift` the release and the lift, and
 * `-speed-flick` the hand's speed and the flick. The deck, the train and the
 * sampler are `flow-swipe-fixture.ts`.
 *
 * @family at0685-flow-swipe
 * @motion
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/deck-manager-store.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/scroll-phase-bridge.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { PIXEL_TOL } from "./_harness/tolerances";
import {
  AFTER_LAND_MS,
  BRISK_GAP_MS,
  CATCH_AFTER_MS,
  CATCH_DELTAS,
  DELTA_COUNT,
  DELTA_PX,
  KIND_TILES,
  MAX_CATCH_STEP_PX,
  RAIL_WIDTH,
  SHOULD_RUN,
  SLOT_PITCH_PX,
  TEST_TIMEOUT_MS,
  deckShape,
  flowOffset,
  paneLeft,
  paneLeftJS,
  wait,
  type Sample,
} from "./flow-swipe-fixture";

describe.skipIf(!SHOULD_RUN)("at0685 — flow swipe settles from the hand", () => {
  test(
    "a touch mid-slide catches the strip where it stands and tracks from there",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-catch",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        const restLeft = await paneLeft(app);

        // ── touched, the fingers, lifted; then touched again mid-slide ───────
        await app.evalJS<null>(
          `(function () {
            var trace = {
              samples: [], tLift: null, tCatch: null, catchLeft: null,
              firstLeft: null, handLeft: null, tHand: null, done: false,
              timer: null,
            };
            window.__catch = trace;
            var left = function () { return ${paneLeftJS}; };
            trace.timer = setInterval(function () {
              trace.samples.push({ t: performance.now(), left: left() });
            }, 4);
            var el = document.querySelector("[data-deck-canvas-background]");
            var phase = function (edge) { window.__tugBridge.onScrollPhase(edge); };
            var wheel = function (dx) {
              el.dispatchEvent(new WheelEvent("wheel", {
                deltaX: dx, deltaY: 0, bubbles: true, cancelable: true,
              }));
            };
            var train = function (count, then) {
              var sent = 0;
              var tick = function () {
                wheel(${DELTA_PX});
                sent += 1;
                if (trace.tCatch !== null && trace.firstLeft === null) trace.firstLeft = left();
                if (sent < count) { setTimeout(tick, ${BRISK_GAP_MS}); return; }
                then();
              };
              tick();
            };
            setTimeout(function () {
              phase("touched");
              train(${DELTA_COUNT}, function () {
                phase("lifted");
                trace.tLift = performance.now();
                setTimeout(function () {
                  phase("touched");
                  trace.tCatch = performance.now();
                  trace.catchLeft = left();
                  setTimeout(function () {
                    train(${CATCH_DELTAS}, function () {
                      trace.handLeft = left();
                      trace.tHand = performance.now();
                      phase("lifted");
                      trace.done = true;
                    });
                  }, ${BRISK_GAP_MS});
                }, ${CATCH_AFTER_MS});
              });
            }, 40);
            return null;
          })()`,
        );
        await app.waitForCondition<boolean>(`window.__catch.done === true`, {
          timeoutMs: 5_000,
        });
        await wait(AFTER_LAND_MS);
        const trace = await app.evalJS<{
          samples: Sample[];
          tLift: number;
          tCatch: number;
          catchLeft: number;
          firstLeft: number;
          handLeft: number;
          tHand: number;
        }>(
          `(function () {
            clearInterval(window.__catch.timer);
            return window.__catch;
          })()`,
        );
        const before = trace.samples.filter((s) => s.t < trace.tCatch);
        const lastBefore = before[before.length - 1];
        const slideStop = restLeft - SLOT_PITCH_PX;
        note(
          `catch: slide at ${Math.round(lastBefore.left - slideStop)}px short of its stop, ` +
            `caught at ${Math.round(trace.catchLeft - slideStop)}px, ` +
            `first delta drawn at ${Math.round(trace.firstLeft - trace.catchLeft)}px from the catch`,
        );

        // The catch was mid-slide: the strip had left the hand and not landed.
        expect(
          lastBefore.left - slideStop,
          "the slide was still short of its stop when the hand touched",
        ).toBeGreaterThan(PIXEL_TOL);
        const atLift = trace.samples.filter((s) => s.t <= trace.tLift).pop()!;
        expect(
          atLift.left - lastBefore.left,
          "the slide had carried the strip on from the hand before the catch",
        ).toBeGreaterThan(PIXEL_TOL);

        // No jump at the catch: the strip stood where the slide had it, to
        // within one frame of the slide's travel, and did not leap to the stop.
        expect(
          Math.abs(trace.catchLeft - lastBefore.left),
          "the strip was caught where the slide had it",
        ).toBeLessThanOrEqual(MAX_CATCH_STEP_PX);
        // And the hand moved it 1:1 from there, with no hump re-armed.
        expect(
          trace.catchLeft - trace.firstLeft,
          "the first delta after the catch drew 1:1 from the caught place",
        ).toBeCloseTo(DELTA_PX, 0);
        expect(
          trace.catchLeft - trace.handLeft,
          "every delta after the catch drew 1:1",
        ).toBeCloseTo(DELTA_PX * CATCH_DELTAS, 0);
        // And nothing between the catch and the hand's last delta leapt: each
        // step is a delta or a frame of the slide, never the rest of the way.
        const held = trace.samples.filter(
          (s) => s.t >= trace.tCatch && s.t <= trace.tHand,
        );
        let leap = 0;
        for (let i = 1; i < held.length; i += 1) {
          leap = Math.max(leap, Math.abs(held[i].left - held[i - 1].left));
        }
        note(`largest step while the hand held the strip: ${Math.round(leap)}px`);
        expect(leap, "no step leapt while the hand held the strip").toBeLessThanOrEqual(
          MAX_CATCH_STEP_PX,
        );

        // One way throughout, and on to the next stop the hand was moving to.
        const backs: string[] = [];
        for (let i = 1; i < trace.samples.length; i += 1) {
          const step = trace.samples[i].left - trace.samples[i - 1].left;
          if (step > PIXEL_TOL) {
            backs.push(
              `${Math.round(step)}px at ${Math.round(trace.samples[i].t - trace.tCatch)}ms from the catch`,
            );
          }
        }
        if (backs.length > 0) note(`backtracks: ${backs.join(", ")}`);
        expect(backs.length, "the card only ever moved the hand's way").toBe(0);
        const settled = await flowOffset(app);
        note(`settled offset ${settled}`);
        expect(
          settled % SLOT_PITCH_PX,
          "the second lift settled on a slot's stop",
        ).toBeCloseTo(0, 0);
        expect(
          settled,
          "the second lift carried on past the caught place",
        ).toBeGreaterThanOrEqual(restLeft - trace.firstLeft);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
