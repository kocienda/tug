/**
 * at0330-eviction-zoom.test.ts — the session transcript renders through
 * `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | zoom keeps ledger   | a View › Zoom step resizing the deck root, the width  |
 * |                     | settle reading it as a reflow, wiping the ledger and  |
 * |                     | mounting the whole transcript at once                 |
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each (reflow and
 * hidden-restore) and the rest are found through the list's internals.
 *
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @family at0330-eviction
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  readTopLine,
  rememberTopLine,
  scrollTo,
  settleOn,
  standUp,
} from "./eviction-fixture";

/** The list's width settle (`WIDTH_INVALIDATION_SETTLE_MS`) plus the
 *  rescale hold's release tail (`RESIZE_SETTLE_TAIL_MS`), with a margin:
 *  a read before it lets go reads where the hold is putting the reader. */
const ZOOM_SETTLE_MS = 200 + 600 + 100;

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — zoom", () => {
  test(
    "a View › Zoom step keeps the ledger: no suspension, no whole-transcript mount",
    async () => {
      const app = await standUp("at0330-zoom");
      try {
        await scrollTo(app, 0.5);
        const before = await app.evalJS<{
          cells: number;
          fallbacks: number;
          w: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    cells: el.querySelectorAll("[data-tug-list-cell-index]").length,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    w: el.clientWidth,
  };
})()`);
        expect(before.cells).toBeLessThan(TURNS);
        // The reader is up in history, not following: a zoom step holds the
        // line they were reading, in layout px, through each rescale.
        const line = await rememberTopLine(app);
        expect(line, "a block under the scrollport top").not.toBeNull();

        // Arm the instruments before the zoom: the most cells ever mounted
        // (the over-mount is transient, so a read after settle cannot see
        // it), the frame series (the freeze is a gap in it), and per frame
        // the factor the deck root was drawn at. The zoom is the root's
        // transform, which never moves `devicePixelRatio`, so the factor is
        // read off the root itself: its rect over its layout width.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var deck = document.getElementById("deck-container");
  var rec = { maxCells: 0, frames: [], factors: [], applies: [], on: true };
  var count = function () {
    var n = el.querySelectorAll("[data-tug-list-cell-index]").length;
    if (n > rec.maxCells) rec.maxCells = n;
  };
  rec.mo = new MutationObserver(count);
  rec.mo.observe(el, { childList: true, subtree: true });
  var tick = function (t) {
    rec.frames.push(t);
    rec.factors.push([t, deck.getBoundingClientRect().width / deck.offsetWidth]);
    if (rec.on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  count();
  var bridge = window.__tugBridge;
  rec.apply = bridge.onPageZoomApply;
  bridge.onPageZoomApply = function (factor) {
    rec.applies.push([performance.now(), factor]);
    return rec.apply(factor);
  };
  window.__at0330Zoom = rec;
  return true;
})()`);

        const read = (): Promise<{
          cells: number;
          maxCells: number;
          fallbacks: number;
          active: boolean;
          w: number;
          worstGap: number;
        }> =>
          app.evalJS(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var rec = window.__at0330Zoom;
  var worst = 0;
  for (var i = 1; i < rec.frames.length; i += 1) {
    worst = Math.max(worst, rec.frames[i] - rec.frames[i - 1]);
  }
  var out = {
    cells: el.querySelectorAll("[data-tug-list-cell-index]").length,
    maxCells: rec.maxCells,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    active: el.hasAttribute("data-evict-active"),
    w: el.clientWidth,
    worstGap: Math.round(worst),
  };
  rec.maxCells = out.cells;
  rec.frames = [];
  return out;
})()`);
        // A step has landed once the root is drawn at its factor, eviction is
        // armed with nothing stale, and the width settle and the hold's tail
        // have both run out since the step reached the deck. (This card's
        // layout width does not move with the factor, so no width is waited on.)
        // The drawn factor is read to 1e-2: the root's rect snaps to device
        // pixels, so a 2× step reads 1.9988. A timeout here costs the budget
        // times the runner's job count, so the condition must be one that comes.
        const zoomLanded = (factor: number): Promise<boolean> =>
          settleOn(
            app,
            `(function () {
  var el = document.querySelector('${SCROLLER}');
  var deck = document.getElementById("deck-container");
  var rec = window.__at0330Zoom;
  var last = rec.applies[rec.applies.length - 1];
  return last !== undefined &&
    Math.abs(deck.getBoundingClientRect().width / deck.offsetWidth - ${factor}) < 1e-2 &&
    el.hasAttribute("data-evict-active") && !el.hasAttribute("data-evict-stale") &&
    performance.now() - last[0] >= ${ZOOM_SETTLE_MS};
})()`,
            { timeoutMs: 5000, pollMs: 50 },
          );

        expect(await app.setPageZoom(0.5)).toBeCloseTo(0.5, 5);
        await zoomLanded(0.5);
        const zoomedOut = await read();
        const lineOut = await readTopLine(app);

        expect(await app.setPageZoom(2)).toBeCloseTo(2, 5);
        await zoomLanded(2);
        const zoomedIn = await read();
        const lineIn = await readTopLine(app);

        expect(await app.setPageZoom(1)).toBeCloseTo(1, 5);
        await zoomLanded(1);
        const restored = await read();
        const lineRestored = await readTopLine(app);

        // Two steps back to back: the second is counted in frames from its
        // arrival at the deck to the first frame the root is drawn at it.
        await app.setPageZoom(0.9);
        await app.setPageZoom(0.8);
        await zoomLanded(0.8);
        const doubleTap = await app.evalJS<{
          framesToSecond: number;
          msToSecond: number;
        }>(`(function () {
  var rec = window.__at0330Zoom;
  var second = rec.applies[rec.applies.length - 1];
  var frames = 0;
  var ms = -1;
  for (var i = 0; i < rec.factors.length; i += 1) {
    if (rec.factors[i][0] < second[0]) continue;
    frames += 1;
    if (Math.abs(rec.factors[i][1] - 0.8) < 1e-3) { ms = Math.round(rec.factors[i][0] - second[0]); break; }
  }
  return { framesToSecond: ms < 0 ? -1 : frames, msToSecond: ms };
})()`);
        const tapped = await read();
        await app.setPageZoom(1);

        await app.evalJS<boolean>(`(function () {
  var rec = window.__at0330Zoom;
  rec.on = false;
  rec.mo.disconnect();
  window.__tugBridge.onPageZoomApply = rec.apply;
  delete window.__at0330Zoom;
  return true;
})()`);

        note("zoom 0.5 → 2.0 → 1.0, then a 0.9 → 0.8 double step, on a 60-turn evicted transcript", {
          widths: [before.w, zoomedOut.w, zoomedIn.w, restored.w, tapped.w],
          cells: [before.cells, zoomedOut.cells, zoomedIn.cells, restored.cells, tapped.cells],
          maxCells: [zoomedOut.maxCells, zoomedIn.maxCells, restored.maxCells, tapped.maxCells],
          worstGapMs: [zoomedOut.worstGap, zoomedIn.worstGap, restored.worstGap, tapped.worstGap],
          doubleTap,
          line: { text: line!.text, delta: [line!.delta, lineOut, lineIn, lineRestored] },
        });

        for (const step of [zoomedOut, zoomedIn, restored, tapped]) {
          // The zoom never suspended eviction…
          expect(step.fallbacks).toBe(before.fallbacks);
          expect(step.active).toBe(true);
          // …so nothing near the whole transcript ever mounted. The window
          // grows only with the taller layout viewport a zoom-out gives it.
          expect(step.maxCells).toBeLessThan(TURNS);
          // And the relayout that remains stays under a quarter second.
          expect(step.worstGap).toBeLessThan(250);
        }
        // The second step is drawn in the first or second frame after it
        // reaches the deck, never queued behind the first step's work.
        expect(doubleTap.framesToSecond).toBeGreaterThan(0);
        expect(doubleTap.framesToSecond).toBeLessThanOrEqual(2);
        // The reader's line held through every step, in layout px.
        for (const delta of [lineOut, lineIn, lineRestored]) {
          expect(delta, "the line's block is still mounted").not.toBeNull();
          expect(Math.abs(delta! - line!.delta)).toBeLessThanOrEqual(2);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
