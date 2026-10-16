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
 * | selection pin       | the row holding a selection unmounted out from under  |
 * |                     | it while the user scrolled elsewhere ([L23])          |
 * | tool-block expand   | a gesture on a row near the window edge losing its    |
 * |                     | block, or the document mis-sizing after the re-measure|
 * | no suspensions      | the mode silently falling back to mounting everything |
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
} from "./eviction-fixture";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — far scroll", () => {
  test(
    "far scroll keeps the viewport populated, contiguous, and row-0-topped",
    async () => {
      const app = await standUp("at0330-far-scroll");
      try {
        // Mid-transcript: rows must cover the viewport with no hole.
        for (const frac of [0.5, 0.85, 0.15]) {
          await scrollTo(app, frac);
          const view = await app.evalJS<{
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
        const top = await app.evalJS<{
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

  test(
    "a selected row stays mounted while the viewport travels away ([L23])",
    async () => {
      const app = await standUp("at0330-selection-pin");
      try {
        await scrollTo(app, 0.9);
        // Select inside a row that is currently mounted near the bottom.
        const picked = await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var cells = Array.prototype.slice.call(el.querySelectorAll("[data-tug-list-cell-index]"));
  var box = el.getBoundingClientRect();
  var target = null;
  cells.forEach(function (c) {
    var r = c.getBoundingClientRect();
    if (target === null && r.top >= box.top && r.bottom <= box.bottom) target = c;
  });
  if (target === null) target = cells[Math.floor(cells.length / 2)];
  var range = document.createRange();
  range.selectNodeContents(target);
  var sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return Number(target.getAttribute("data-tug-list-cell-index"));
})()`);
        expect(picked).toBeGreaterThanOrEqual(0);
        // Selection changes are observed off `selectionchange`, which is
        // dispatched asynchronously.
        await new Promise((r) => setTimeout(r, 300));

        await scrollTo(app, 0);
        const held = await app.evalJS<{
          mounted: boolean;
          collapsed: boolean;
          evicting: boolean;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var sel = document.getSelection();
  return {
    mounted: !!el.querySelector('[data-tug-list-cell-index="${picked}"]'),
    collapsed: sel === null || sel.isCollapsed,
    evicting: el.hasAttribute("data-evict-active"),
  };
})()`);
        expect(held.collapsed).toBe(false);
        expect(held.mounted).toBe(true);
        // The pin widens the window; it does not switch eviction off.
        expect(held.evicting).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "expanding and collapsing a tool block round-trips the document height",
    async () => {
      const app = await standUp("at0330-expand-roundtrip");
      try {
        await scrollTo(app, 0.5);
        const before = await app.evalJS<{ h: number; headers: number }>(
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
        await app.evalJS<boolean>(`(function () {
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
        await app.waitForCondition<boolean>(
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
        const before2 = await app.evalJS<number>(
          `document.querySelector('${SCROLLER}').scrollHeight`,
        );
        await app.evalJS<boolean>(`(function () {
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
        await app.waitForCondition<boolean>(
          `document.querySelector('${SCROLLER}').scrollHeight > ${before2}`,
          { timeoutMs: 8000 },
        );
        const expanded = await app.evalJS<{ h: number; open: number }>(
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

        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.querySelector('.tool-call-header:not([data-collapsed="true"]) [data-slot="tool-call-header-disclosure"]').click();
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 600));
        const after = await app.evalJS<{ h: number; fallbacks: number }>(
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
