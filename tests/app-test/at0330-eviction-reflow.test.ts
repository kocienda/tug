/**
 * at0330-eviction-reflow.test.ts — the session transcript renders through
 * `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | reflow drain        | a width change mounting every row to re-measure it,   |
 * |                     | or the reader's place drifting while the stale        |
 * |                     | heights drain; a splitter drag's burst of widths      |
 * |                     | suspending eviction per tick instead of coalescing to |
 * |                     | one invalidation at settle                            |
 *
 * One piece of the reflow split, a test to a file so each launch fits its
 * own budget: the reader's-line hold is at0330-eviction-reflow-line.
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each: this one the
 * list (its width settle and drain hold are what these cases drive), and
 * hidden-restore the card.
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
  readFullHeight,
  readRowCount,
  scrollTo,
  standUp,
  startMountSampler,
  stopMountSampler,
  transcriptPage,
} from "./eviction-fixture";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — reflow", () => {
  test(
    "a reflow never mounts the whole transcript, and a width burst coalesces to one invalidation",
    async () => {
      const app = await standUp("at0330-reflow-drain");
      try {
        const page = await transcriptPage(app);
        const rowCount = await readRowCount(app);
        await scrollTo(app, 0.5);
        // Put a row's top edge on the scrollport top, so "where the reader
        // is" is a whole row whose offset can be read before and after.
        await page.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var portTop = el.getBoundingClientRect().top;
  var cells = [].slice.call(el.querySelectorAll("[data-tug-list-cell-index]"));
  var top = cells.filter(function (c) { return c.getBoundingClientRect().bottom > portTop + 1; })
    .sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; })[0];
  el.scrollTop = Math.round(el.scrollTop + top.getBoundingClientRect().top - portTop);
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 500));
        const readTop = (index: number | null) =>
          page.evalJS<{ index: number; offset: number; w: number; fallbacks: number }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var portTop = el.getBoundingClientRect().top;
  var want = ${index === null ? "null" : index};
  var cells = [].slice.call(el.querySelectorAll("[data-tug-list-cell-index]"));
  var top = want === null
    ? cells.filter(function (c) { return c.getBoundingClientRect().bottom > portTop + 1; })
        .sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; })[0]
    : el.querySelector('[data-tug-list-cell-index="' + want + '"]');
  return {
    index: top ? Number(top.getAttribute("data-tug-list-cell-index")) : -1,
    offset: top ? top.getBoundingClientRect().top - portTop : NaN,
    w: el.clientWidth,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
  };
})()`);
        const before = await readTop(null);
        expect(before.index).toBeGreaterThan(0);
        expect(before.w).toBeGreaterThan(300);

        // Drive several width changes in quick succession — a splitter
        // drag's shape. Each write must actually move the scroller's
        // box (the scroller is sized by its pane, so pin it with an
        // explicit width + flex none). Mid-burst, the ledger freeze
        // keeps coverage true, so eviction stays armed instead of
        // suspending per tick; mid-burst geometry is deliberately
        // stale (old width) and is NOT asserted here. A direct width
        // write opens no resize episode, so the drain's own restore
        // target is what holds the reader.
        const setWidth = (w: number): Promise<number> =>
          page.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.style.flex = "0 0 auto";
  el.style.width = "${w}px";
  return el.clientWidth;
})()`);
        const burstWidths = [
          before.w - 40,
          before.w - 80,
          before.w - 160,
          before.w - 120,
        ];
        let lastClientWidth = before.w;
        await startMountSampler(app);
        for (const w of burstWidths) {
          lastClientWidth = await setWidth(w);
        }
        const midBurst = await page.evalJS<{ active: boolean; w: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return { active: el.hasAttribute("data-evict-active"), w: el.clientWidth };
})()`,
        );
        // `style.width` is border-box, so the client width lands a
        // scrollbar short of the CSS value — compare against the
        // final write's own read-back, not the CSS number.
        expect(midBurst.w).toBe(lastClientWidth);
        expect(midBurst.w).toBeLessThan(before.w);
        // The freeze keeps eviction running through the burst.
        expect(midBurst.active).toBe(true);

        // Rest past the settle interval, then let the drain re-measure
        // every stale row. The exactness below holds after the drain, not
        // before it: until then stale heights stand in for unmounted rows.
        await page.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return window.__at0330Sampler.sawStale &&
    el.hasAttribute("data-evict-active") && !el.hasAttribute("data-evict-stale");
})()`,
          { timeoutMs: 20_000, pollMs: 250 },
        );
        // Past the restore target's release tail, so what is read is where
        // the reader was left, not where the hold is still putting them.
        await new Promise((r) => setTimeout(r, 1000));
        const sampled = await stopMountSampler(app);
        const after = await readTop(before.index);
        const settled = await page.evalJS<{ h: number; active: boolean }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return { h: el.scrollHeight, active: el.hasAttribute("data-evict-active") };
})()`);
        note(
          `reflow drain: rows ${rowCount}, peak mounted ${sampled.peak}, ` +
            `top row ${before.index} offset ${before.offset.toFixed(1)} → ${after.offset.toFixed(1)}, ` +
            `fallbacks ${before.fallbacks} → ${after.fallbacks}`,
        );
        expect(settled.active).toBe(true);
        expect(sampled.peak).toBeLessThan(rowCount);
        // A reflow drains rather than suspends: no commit renders every row.
        expect(after.fallbacks).toBe(before.fallbacks);
        expect(after.index).toBe(before.index);
        expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);

        // Exactness after the drain: the evicted document is the same
        // height the fully-mounted one is at this width.
        const fullH = await readFullHeight(app);
        expect(Math.abs(settled.h - fullH)).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
