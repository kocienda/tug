/**
 * at0330-eviction-expand-roundtrip.test.ts — the session transcript renders
 * through `evictOffscreen`, and expanding then collapsing a tool block
 * round-trips the document height with no suspension of the mode.
 *
 * One piece of the at0330-eviction far-scroll split, a test to a file so
 * each launch fits its own budget. The mode's whole claim is that eviction
 * is invisible; what this one guards is a gesture on a row near the window
 * edge losing its block, the document mis-sizing after the re-measure, or
 * the mode silently falling back to mounting everything.
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
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
    "expanding and collapsing a tool block round-trips the document height",
    async () => {
      const app = await standUp("at0330-expand-roundtrip");
      try {
        const page = await transcriptPage(app);
        await scrollTo(app, 0.5);
        const before = await page.evalJS<{ h: number; headers: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    headers: el.querySelectorAll('.tool-call-header[data-collapsed="true"]').length,
  };
})()`,
        );
        expect(before.headers).toBeGreaterThan(0);

        // Bring a collapsed header INTO VIEW before toggling it. Expanding a
        // block that sits offscreen cannot move `scrollHeight`: eviction holds
        // it at its placeholder's exact measured height (the pixel-identical
        // constraint), so the growth asserted below never appears.
        await page.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  var headers = [].slice.call(el.querySelectorAll('.tool-call-header[data-collapsed="true"]'));
  var below = headers.map(function (h) {
    return { h: h, top: h.getBoundingClientRect().top };
  }).filter(function (r) { return r.top > box.top; });
  if (below.length === 0) return false;
  el.scrollTop += below[0].top - box.top - 40;
  return true;
})()`);
        await page.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  return [].slice.call(el.querySelectorAll('.tool-call-header[data-collapsed="true"]')).some(function (h) {
    var b = h.getBoundingClientRect();
    return b.top >= box.top && b.bottom <= box.bottom;
  });
})()`,
          { timeoutMs: 5000 },
        );
        const before2 = await page.evalJS<number>(
          `document.querySelector('${SCROLLER}').scrollHeight`,
        );
        await page.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  var target = [].slice.call(el.querySelectorAll('.tool-call-header[data-collapsed="true"]')).filter(function (h) {
    var b = h.getBoundingClientRect();
    return b.top >= box.top && b.bottom <= box.bottom;
  })[0];
  // The disclosure cue owns the toggle, not the header strip.
  target.querySelector('[data-slot="tool-call-header-disclosure"]').click();
  return true;
})()`);
        // The expanded block's height reaches `scrollHeight` only once the
        // eviction ledger re-measures it, which a fixed sleep can miss — wait
        // for the growth instead of sampling at an arbitrary moment.
        await page.waitForCondition<boolean>(
          `document.querySelector('${SCROLLER}').scrollHeight > ${before2}`,
          { timeoutMs: 8000 },
        );
        const expanded = await page.evalJS<{ h: number; open: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    open: el.querySelectorAll('.tool-call-header:not([data-collapsed="true"])').length,
  };
})()`,
        );
        expect(expanded.open).toBeGreaterThan(0);
        expect(expanded.h).toBeGreaterThan(before.h);

        await page.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.querySelector('.tool-call-header:not([data-collapsed="true"]) [data-slot="tool-call-header-disclosure"]').click();
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 600));
        const after = await page.evalJS<{ h: number; fallbacks: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
  };
})()`,
        );
        // Back to the height it had before the gesture: the re-measure
        // reached the ledger, so the spacers report the collapsed row again.
        expect(Math.abs(after.h - before.h)).toBeLessThanOrEqual(2);
        expect(after.fallbacks).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
