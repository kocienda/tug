/**
 * at0685-flow-swipe-speed-flick.test.ts — a trackpad swipe clears a
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
 * file carries the hand's speed and the flick; `at0685-flow-swipe-quiet`
 * carries the settle after the idle commit and the hump, `-release-lift` the
 * release and the lift, and `-catch` the catch. The deck, the train and the
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
  DELTA_COUNT,
  DELTA_GAP_MS,
  DELTA_PX,
  EARLY_FRACTION,
  KIND_TILES,
  MOMENTUM_DELTAS,
  RAIL_WIDTH,
  SHOULD_RUN,
  SLOT_PITCH_PX,
  SLOW_GAP_MS,
  TEST_TIMEOUT_MS,
  deckShape,
  flowOffset,
  paneLeft,
  repeat,
  startSwipe,
  stopSwipe,
  wait,
} from "./flow-swipe-fixture";

describe.skipIf(!SHOULD_RUN)("at0685 — flow swipe settles from the hand", () => {
  test(
    "the slide from a lift launches at the hand's speed, one way, to the same stop",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-hand-speed",
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

        /** Lift one finger train from the stop the strip stands on; answer
         *  how much of the travel the slide's curve covers `EARLY_FRACTION`
         *  in, and the one-way and no-overshoot counts. */
        const lift = async (gapMs: number, stops: number) => {
          const fromLeft = await paneLeft(app);
          const stopLeft = fromLeft - SLOT_PITCH_PX;
          await startSwipe(app, {
            deltas: repeat(DELTA_PX, DELTA_COUNT),
            gapMs,
            momentum: MOMENTUM_DELTAS,
          });
          await wait(AFTER_LAND_MS);
          const trace = await stopSwipe(app);
          const after = trace.samples.filter((s) => s.t >= trace.tLastDelta);
          const launch = trace.launch ?? [];
          const early = launch[Math.round((launch.length - 1) * EARLY_FRACTION)];
          let backtracks = 0;
          for (let i = 1; i < trace.samples.length; i += 1) {
            if (trace.samples[i].left - trace.samples[i - 1].left > PIXEL_TOL) backtracks += 1;
          }
          return {
            handToStop: trace.handLeft - stopLeft,
            early: early ?? 0,
            launched: launch.length,
            backtracks,
            past: after.filter((s) => s.left < stopLeft - PIXEL_TOL).length,
            landed: Math.abs((await paneLeft(app)) - stopLeft),
            store: await flowOffset(app),
            stop: SLOT_PITCH_PX * stops,
          };
        };

        const fast = await lift(BRISK_GAP_MS, 1);
        const slow = await lift(SLOW_GAP_MS, 2);
        note(
          `hand to stop: fast ${Math.round(fast.handToStop)}px, slow ${Math.round(slow.handToStop)}px; ` +
            `curve at ${EARLY_FRACTION * 100}%: fast ${fast.early.toFixed(3)}, slow ${slow.early.toFixed(3)} of the travel`,
        );

        expect(
          Math.abs(fast.handToStop - slow.handToStop),
          "both lifts left the same distance to their stop",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        for (const [name, run] of [["fast", fast], ["slow", slow]] as const) {
          expect(run.launched, `the ${name} lift launched a slide`).toBeGreaterThan(2);
          expect(run.store, `the ${name} lift settled on its next stop`).toBeCloseTo(run.stop, 0);
          expect(run.landed, `the ${name} card ends on its stop`).toBeLessThanOrEqual(PIXEL_TOL);
          expect(run.backtracks, `the ${name} card only moved the hand's way`).toBe(0);
          expect(run.past, `no ${name} frame went past the stop`).toBe(0);
        }
        expect(
          fast.early,
          `the fast lift's curve covers more of the travel ${EARLY_FRACTION * 100}% in than the slow one's`,
        ).toBeGreaterThan(slow.early + 0.02);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a quick swipe flicks past the next stop, one way, to where it committed",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-flick",
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

        // ── the same twelve deltas, sixteen milliseconds apart, lifted ───────
        await startSwipe(app, {
          deltas: repeat(DELTA_PX, DELTA_COUNT),
          gapMs: DELTA_GAP_MS,
          momentum: MOMENTUM_DELTAS,
        });
        await wait(AFTER_LAND_MS);
        const trace = await stopSwipe(app);
        const settled = await flowOffset(app);
        const landedLeft = await paneLeft(app);
        const after = trace.samples.filter((s) => s.t >= trace.tLastDelta);
        note(
          `flick: hand at ${Math.round(restLeft - trace.handLeft)}px, ` +
            `committed ${trace.storeAtTrainEnd}, settled ${settled} ` +
            `(${(settled / SLOT_PITCH_PX).toFixed(2)} slots)`,
        );

        expect(
          trace.storeAtTrainEnd,
          "the flick's stop was committed at the lift",
        ).toBe(settled);
        expect(
          settled,
          "the flick travelled past the next stop",
        ).toBeGreaterThan(SLOT_PITCH_PX + PIXEL_TOL);
        expect(
          Math.abs(restLeft - landedLeft - settled),
          "the card ends where the store settled",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(trace.momentumUntaken, "every momentum event was taken").toBe(0);
        let backtracks = 0;
        for (let i = 1; i < trace.samples.length; i += 1) {
          if (trace.samples[i].left - trace.samples[i - 1].left > PIXEL_TOL) backtracks += 1;
        }
        expect(backtracks, "the card only ever moved the hand's way").toBe(0);
        expect(
          after.filter((s) => s.left < landedLeft - PIXEL_TOL).length,
          "no frame went past where the flick landed",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
