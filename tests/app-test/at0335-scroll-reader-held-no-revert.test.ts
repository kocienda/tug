/**
 * at0335-scroll-reader-held-no-revert.test.ts — a genuine user scroll is never
 * reverted.
 *
 * One of the at0335-scroll split, a test to a file so each launch fits its own
 * budget (it was the first case of `at0335-scroll-reader-held`; the others are
 * `at0335-scroll-reader-held-swaps` and `-reader-held-wheel`, and the clamp
 * itself is `at0335-scroll-clamp-*`). Why the scroller belongs to the user,
 * and the shared stand-up and readers, are `transcript-scroll-fixture.ts`.
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
  parkMidHistory,
  readSnap,
  seedTurn,
  settle,
  standUp,
} from "./transcript-scroll-fixture";

describe.skipIf(!SHOULD_RUN)("AT0335: a reader is held", () => {
  test(
    "a genuine user scroll is never reverted",
    async () => {
      const app = await standUp("at0335-no-revert", { awaitHostRoot: true });
      try {
        // The scrollbar's silence, reproduced: a bare assignment with
        // no pointer or wheel events. This is the actor the repair
        // must never fight — its drag looks exactly like a clamp to
        // everything except the scroll events it delivers.
        const parked = await parkMidHistory(app);
        // Disengaging opens the anchoring gate: the parked reader gets
        // the reading-position hold back. SmartScroll stamps
        // `overflow-anchor: none` only while following the bottom.
        expect(
          await app.body("A").evalJS<string>(
            `document.querySelector('${SCROLLER}').style.overflowAnchor`,
          ),
        ).toBe("");

        // Stream turns underneath. Every one of these commits runs the
        // bracket; none of them may pull the reader back.
        for (let n = 0; n < 3; n += 1) {
          const before = (await readSnap(app)).scrollHeight;
          await seedTurn(app, TURNS + n);
          await settle(app, before);
        }

        const held = await readSnap(app);
        expect(Math.abs(held.top - parked)).toBeLessThanOrEqual(50);
        await expectZeroDisplacements(app);
        expect(held.buttonVisible).toBe("true");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
