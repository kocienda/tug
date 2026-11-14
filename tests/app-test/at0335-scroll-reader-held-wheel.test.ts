/**
 * at0335-scroll-reader-held-wheel.test.ts — a sustained downward wheel
 * gesture reaches the bottom and stays.
 *
 * One of the at0335-scroll split, a test to a file so each launch fits its own
 * budget (it was the third case of `at0335-scroll-reader-held`; the others are
 * `at0335-scroll-reader-held-no-revert` and `-reader-held-swaps`, and the
 * clamp itself is `at0335-scroll-clamp-*`). Why the scroller belongs to the
 * user, and the shared stand-up and readers, are
 * `transcript-scroll-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/deck-trace.ts
 * @family at0335-scroll
 */

import { describe, expect, test } from "bun:test";

import {
  AT_BOTTOM_PX,
  BUTTON_HIDDEN,
  BUTTON_VISIBLE,
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  awaitQuietly,
  expectZeroDisplacements,
  readSnap,
  settle,
  standUp,
} from "./transcript-scroll-fixture";

describe.skipIf(!SHOULD_RUN)("AT0335: a reader is held", () => {
  test(
    "a sustained downward wheel gesture reaches the bottom and stays",
    async () => {
      const app = await standUp("at0335-wheel", { awaitHostRoot: true });
      try {
        // Park near the top, behind a large evicted top spacer — the
        // geometry the field report was captured on.
        await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = 0;
  return el.scrollTop;
})()`);
        await settle(app);
        await awaitQuietly(app, BUTTON_VISIBLE);
        expect((await readSnap(app)).buttonVisible).toBe("true");

        // A sustained downward burst. Synthetic wheel events do not
        // perform the browser's own scroll, so each tick pairs the
        // event with the movement it stands for — the phase machine
        // and the disengage rules see a genuine downward gesture, and
        // any upward jump between ticks is somebody else's doing.
        const run = await app.body("A").evalJS<{
          worstUpJump: number;
          finalTop: number;
          maxScroll: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var worstUpJump = 0;
  var prev = el.scrollTop;
  for (var i = 0; i < 120; i += 1) {
    el.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 600, bubbles: true, cancelable: true,
    }));
    el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + 600);
    var now = el.scrollTop;
    var up = prev - now;
    if (up > worstUpJump) worstUpJump = up;
    prev = now;
  }
  return {
    worstUpJump: worstUpJump,
    finalTop: el.scrollTop,
    maxScroll: el.scrollHeight - el.clientHeight,
  };
})()`);
        // Nothing snapped the gesture back partway.
        expect(run.worstUpJump).toBeLessThanOrEqual(AT_BOTTOM_PX);
        expect(run.maxScroll - run.finalTop).toBeLessThanOrEqual(AT_BOTTOM_PX);

        // End the gesture, in two beats. A wheel-only gesture stays in
        // the dragging phase until scrollend arrives, and synthetic
        // wheel events paired with a manual assignment do not reliably
        // produce one — pointerup is the termination the harness can
        // drive. But it has to arrive on a quiet scroller: the
        // assignments above queue scroll events, and any that land
        // during the 50ms post-pointerup window read as momentum, so
        // the phase machine goes to decelerating (which waits for the
        // scrollend that will never come) instead of idle. Settling
        // first makes the gesture end where a real one does.
        await settle(app);
        await app.body("A").evalJS<boolean>(`(function () {
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return true;
})()`);

        // The gesture ends engaged: it arrived at the live edge and
        // never scrolled away from it.
        await awaitQuietly(app, BUTTON_HIDDEN);
        const settled = await readSnap(app);
        expect(settled.buttonVisible).toBe("false");
        await expectZeroDisplacements(app);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
