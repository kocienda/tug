/**
 * at0330-eviction-far-scroll.test.ts — the session transcript renders through
 * `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | far-scroll fidelity | blank viewport, or content at the wrong scroll offset |
 * | Z0 stays topmost    | the permanent top row painted mid-transcript, because |
 * |                     | the top spacer grew underneath it                     |
 *
 * One piece of the far-scroll split, a test to a file so each launch fits
 * its own budget: the selection pin is at0330-eviction-selection-pin, and
 * the tool-block expand round trip (with its no-suspensions check) is
 * at0330-eviction-expand-roundtrip.
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each (reflow and
 * hidden-restore) and the rest are found through the list's internals.
 *
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @family at0330-eviction
 */

import { describe, expect, test } from "bun:test";

import {
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  scrollTo,
  standUp,
  transcriptPage,
} from "./eviction-fixture";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — far scroll", () => {
  test(
    "far scroll keeps the viewport populated, contiguous, and row-0-topped",
    async () => {
      const app = await standUp("at0330-far-scroll");
      try {
        const page = await transcriptPage(app);
        // Mid-transcript: rows must cover the viewport with no hole.
        for (const frac of [0.5, 0.85, 0.15]) {
          await scrollTo(app, frac);
          const view = await page.evalJS<{
            cells: number;
            contiguous: boolean;
            coversViewport: boolean;
            evicting: boolean;
          }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var cells = Array.prototype.slice.call(el.querySelectorAll("[data-tug-list-cell-index]"));
  var ix = cells.map(function (c) { return Number(c.getAttribute("data-tug-list-cell-index")); });
  var contiguous = ix.every(function (v, i) { return i === 0 || v === ix[i - 1] + 1; });
  var box = el.getBoundingClientRect();
  var gap = parseFloat(getComputedStyle(el.querySelector(".tug-list-view-window")).rowGap) || 0;
  // Walk the mounted rows down the scrollport looking for a band nothing
  // covers. The inter-row gap is legitimately blank; anything wider is an
  // evicted row's spacer showing through where a row should be.
  var edge = box.top;
  var hole = 0;
  cells.forEach(function (c) {
    var r = c.getBoundingClientRect();
    if (r.bottom <= box.top || r.top >= box.bottom) return;
    hole = Math.max(hole, Math.max(0, Math.min(r.top, box.bottom) - edge));
    edge = Math.max(edge, Math.min(r.bottom, box.bottom));
  });
  hole = Math.max(hole, box.bottom - edge);
  return {
    cells: cells.length,
    contiguous: contiguous,
    noBlankBand: hole <= gap + 2,
    holePx: Math.round(hole),
    gapPx: Math.round(gap),
    evicting: el.hasAttribute("data-evict-active"),
  };
})()`);
          expect({ frac, ...view }).toMatchObject({
            evicting: true,
            contiguous: true,
            noBlankBand: true,
          });
        }

        // At the very top, row 0 is the first thing in the scroll content —
        // the top spacer never grows underneath it and buries it. This is a
        // NEW session, so there is no Z0 strip at all (it reports a load
        // window, and a new session has none); the resumed case, where the
        // strip is present and must top the content, is asserted in
        // at0330-eviction-hidden-restore.
        await scrollTo(app, 0);
        const top = await page.evalJS<{
          hasLeading: boolean;
          firstCellTop: number;
          firstCellIndex: number;
          spacerTop: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var firstCell = el.querySelector("[data-tug-list-cell-index]");
  var box = el.getBoundingClientRect();
  return {
    hasLeading: el.querySelector(".tug-list-view-leading") !== null,
    firstCellTop: firstCell ? Math.round(firstCell.getBoundingClientRect().top - box.top) : -9999,
    firstCellIndex: firstCell ? Number(firstCell.getAttribute("data-tug-list-cell-index")) : -1,
    spacerTop: Math.round(parseFloat(el.querySelector(".tug-list-view-spacer--top").style.height) || 0),
  };
})()`);
        expect(top.hasLeading).toBe(false);
        expect(top.firstCellIndex).toBe(0);
        expect(top.spacerTop).toBe(0);
        // Row 0 sits at the top of the scrollport (under the list's own top
        // padding, which the strip's absence restores), not pushed below a
        // grown spacer.
        expect(top.firstCellTop).toBeLessThanOrEqual(24);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
