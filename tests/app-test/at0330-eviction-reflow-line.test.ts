/**
 * at0330-eviction-reflow-line.test.ts — the session transcript renders
 * through `evictOffscreen`, and a reflow holds the reader's line, not only
 * the row it sits in.
 *
 * One piece of the at0330-eviction reflow split, a test to a file so each
 * launch fits its own budget; the drain and width-burst case stays in
 * at0330-eviction-reflow. What this one guards is a reflow holding the
 * reader's row while the line they were reading moved inside it as the
 * text above it re-wrapped.
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @family at0330-eviction
 * @motion
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  readTopLine,
  scrollTo,
  standUp,
  startMountSampler,
  stopMountSampler,
  transcriptPage,
} from "./eviction-fixture";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — reflow", () => {
  test(
    "a reflow holds the reader's line, not only the row",
    async () => {
      const app = await standUp("at0330-reflow-line");
      try {
        const page = await transcriptPage(app);
        await scrollTo(app, 0.4);
        // Put the scrollport top just inside a reply's list item. The reply's
        // paragraph sits above it in the same row and re-wraps at the new
        // width, so the item moves inside its row: a hold on the row and a
        // pixel offset into it would let the reader's line slide, and only a
        // hold on the line itself keeps it.
        // The placement repeats until the item rests where it was put: the
        // first write lands against rows still settling their heights.
        const place = (): Promise<number | null> =>
          page.evalJS<number | null>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var portTop = el.getBoundingClientRect().top;
  var li = window.__at0330Line;
  if (!li || !el.contains(li)) {
    li = [].slice.call(el.querySelectorAll("[data-tug-list-cell-index] li"))
      .filter(function (c) { return c.getBoundingClientRect().top > portTop + 100; })[0];
    if (li === undefined) return null;
    window.__at0330Line = li;
  }
  el.scrollTop = Math.round(el.scrollTop + li.getBoundingClientRect().top - portTop + 3);
  return li.getBoundingClientRect().top - portTop;
})()`);
        await page.evalJS<boolean>(`(delete window.__at0330Line, true)`);
        let rest: number | null = null;
        for (let pass = 0; pass < 4; pass += 1) {
          expect(await place(), "a list item below the scrollport top to read from").not.toBeNull();
          await new Promise((r) => setTimeout(r, 500));
          rest = await readTopLine(app);
          if (rest !== null && Math.abs(rest + 3) <= 1) break;
        }
        expect(rest, "the item rests just above the scrollport top").not.toBeNull();
        expect(Math.abs(rest! + 3)).toBeLessThanOrEqual(1);
        const before = { delta: rest!, text: await page.evalJS<string>(`(window.__at0330Line.textContent || "").slice(0, 40)`) };
        const w = await page.evalJS<number>(`document.querySelector('${SCROLLER}').clientWidth`);

        // A direct width write opens no resize episode: the drain's own hold
        // is what keeps the reader.
        await startMountSampler(app);
        await page.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.style.flex = "0 0 auto";
  el.style.width = "${Math.round(w * 0.55)}px";
  return el.clientWidth;
})()`);
        await page.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return window.__at0330Sampler.sawStale && !el.hasAttribute("data-evict-stale");
})()`,
          { timeoutMs: 20_000, pollMs: 250 },
        );
        // Past the hold's release tail: where the reader was left.
        await new Promise((r) => setTimeout(r, 1000));
        await stopMountSampler(app);
        const after = await readTopLine(app);
        note("reflow line", JSON.stringify({ line: before!.text, width: [w, Math.round(w * 0.55)], delta: [before!.delta, after] }));
        expect(after, "the line's block is still mounted").not.toBeNull();
        expect(Math.abs(after! - before!.delta)).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
