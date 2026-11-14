/**
 * at0335-scroll-clamp-idle-recovery.test.ts — an idle user at the bottom is
 * never stranded by a disengaged flag.
 *
 * One of the at0335-scroll split, a test to a file so each launch fits its own
 * budget (it was the third case of `at0335-scroll-clamp`; the others are
 * `at0335-scroll-clamp-witnessed` and `-clamp-no-flip`, and the reader-side
 * guarantees are `at0335-scroll-reader-held-*`). The shared stand-up and
 * readers, and the table of what each case guards, are
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
  AT_LIVE_EDGE,
  BUTTON_HIDDEN,
  BUTTON_VISIBLE,
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  awaitQuietly,
  readFollowBottomSources,
  readSnap,
  seedTurn,
  settle,
  standUp,
} from "./transcript-scroll-fixture";

describe.skipIf(!SHOULD_RUN)("AT0335: scroll clamp", () => {
  test(
    "an idle user at the bottom is never stranded by a disengaged flag",
    async () => {
      const app = await standUp("at0335-idle-recovery");
      try {
        // The state the field reports describe: parked at the live
        // edge with follow-bottom off. It has to be forced — a
        // downward `scrollTop` assignment into the band re-engages
        // before a test can observe it.
        await app.body("A").evalJS<boolean>(`(function () {
  window.__tug.setTranscriptFollowBottom('${SCROLLER}', false);
  return true;
})()`);
        await awaitQuietly(app, BUTTON_VISIBLE);
        const stranded = await readSnap(app);
        expect(stranded.buttonVisible).toBe("true");
        expect(stranded.maxScroll - stranded.top).toBeLessThanOrEqual(
          AT_BOTTOM_PX,
        );

        // Touch nothing, then let a row arrive — the ordinary append
        // that a `/commit` receipt or a `Session compacted` note is.
        await seedTurn(app, TURNS);
        await settle(app, stranded.scrollHeight);
        await awaitQuietly(app, `${AT_LIVE_EDGE} && ${BUTTON_HIDDEN}`);

        const recovered = await readSnap(app);
        expect(recovered.maxScroll - recovered.top).toBeLessThanOrEqual(4);
        expect(recovered.buttonVisible).toBe("false");

        // And it is visible as such: the growth-time route is tagged
        // distinctly, so a re-engagement that should not have happened
        // can be found rather than guessed at.
        const sources = await readFollowBottomSources(app);
        expect(sources).toContain("growth-at-bottom-reengage");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
