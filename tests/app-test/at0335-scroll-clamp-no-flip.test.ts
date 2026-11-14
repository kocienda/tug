/**
 * at0335-scroll-clamp-no-flip.test.ts — a clamp does not release
 * follow-bottom.
 *
 * One of the at0335-scroll split, a test to a file so each launch fits its own
 * budget (it was the second case of `at0335-scroll-clamp`; the others are
 * `at0335-scroll-clamp-witnessed` and `-clamp-idle-recovery`, and the
 * reader-side guarantees are `at0335-scroll-reader-held-*`). Why a clamp is
 * never read as the user, and the shared stand-up and readers, are
 * `transcript-scroll-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/deck-trace.ts
 * @family at0335-scroll
 */

import { describe, expect, test } from "bun:test";

import {
  AT_LIVE_EDGE,
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  awaitQuietly,
  readSnap,
  seedTurn,
  settle,
  standUp,
} from "./transcript-scroll-fixture";

describe.skipIf(!SHOULD_RUN)("AT0335: scroll clamp", () => {
  test(
    "a clamp does not release follow-bottom",
    async () => {
      const app = await standUp("at0335-no-flip");
      try {
        // Engaged at the live edge, which is where the two field
        // reports were sitting when their session stopped tracking.
        const before = await readSnap(app);
        expect(before.buttonVisible).toBe("false");

        await app.body("A").evalJS<boolean>(
          `(function () { window.__tug.forceCommitClamp('${SCROLLER}'); return true; })()`,
        );
        // A negative: nothing to wait on but time for the clamp's
        // deferred scroll event to arrive and be judged.
        await new Promise((r) => setTimeout(r, 800));

        // The clamp is machine-authored, so it never reaches the
        // intent rules: the affordance stays hidden and streaming
        // keeps tracking the live edge.
        const after = await readSnap(app);
        expect(after.buttonVisible).toBe("false");

        await seedTurn(app, TURNS);
        await settle(app, after.scrollHeight);
        await awaitQuietly(app, AT_LIVE_EDGE);
        const streamed = await readSnap(app);
        expect(streamed.maxScroll - streamed.top).toBeLessThanOrEqual(4);
        expect(streamed.buttonVisible).toBe("false");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
