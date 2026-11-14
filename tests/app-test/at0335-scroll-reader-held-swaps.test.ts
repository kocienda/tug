/**
 * at0335-scroll-reader-held-swaps.test.ts — repeated window swaps displace
 * nobody, and the extent floor tracks the extent.
 *
 * One of the at0335-scroll split, a test to a file so each launch fits its own
 * budget (it was the second case of `at0335-scroll-reader-held`; the others
 * are `at0335-scroll-reader-held-no-revert` and `-reader-held-wheel`, and the
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
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  expectZeroDisplacements,
  readSnap,
  seedTurn,
  settle,
  standUp,
} from "./transcript-scroll-fixture";

describe.skipIf(!SHOULD_RUN)("AT0335: a reader is held", () => {
  test(
    "repeated window swaps displace nobody",
    async () => {
      const app = await standUp("at0335-swaps", { awaitHostRoot: true });
      try {
        // Drive the window up and down through the whole transcript
        // several times. Every one of these moves re-windows: rows
        // leave the DOM and the spacers absorb their extent. That is
        // exactly the moment the geometry used to tear.
        await app.body("A").evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = el.scrollHeight - el.clientHeight;
  var stops = [max, max * 0.6, max * 0.2, 0, max * 0.4, max * 0.8, max];
  window.__at0335 = { stops: stops, i: 0 };
  return true;
})()`);
        for (let i = 0; i < 7; i += 1) {
          await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = window.__at0335.stops[${i}];
  return el.scrollTop;
})()`);
          // Let the re-window commit and drain before the next move.
          await settle(app);
        }
        // Stream growth on top of the swaps — the streaming case is
        // where re-windowing and geometry reads collide most often.
        const before = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS);
        await settle(app, before);

        await expectZeroDisplacements(app);

        // The extent floor is standing and tracks the settled extent
        // (extent − 1, with a commit's rebase slack).
        const floor = await app.body("A").evalJS<{
          present: boolean;
          floorPx: number;
          scrollHeight: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var floor = el.querySelector(".tug-list-view-floor");
  return {
    present: floor !== null,
    floorPx: floor === null ? -1 : parseFloat(floor.style.height || "0"),
    scrollHeight: el.scrollHeight,
  };
})()`);
        expect(floor.present).toBe(true);
        expect(Math.abs(floor.floorPx - (floor.scrollHeight - 1))).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
