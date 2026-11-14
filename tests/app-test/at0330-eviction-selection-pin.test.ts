/**
 * at0330-eviction-selection-pin.test.ts — the session transcript renders
 * through `evictOffscreen`, and the row holding a selection stays mounted
 * while the user scrolls elsewhere ([L23]).
 *
 * One piece of the at0330-eviction far-scroll split, a test to a file so
 * each launch fits its own budget. The mode's whole claim is that eviction
 * is invisible; what this one guards is the row holding a selection
 * unmounting out from under it.
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
    "a selected row stays mounted while the viewport travels away ([L23])",
    async () => {
      const app = await standUp("at0330-selection-pin");
      try {
        const page = await transcriptPage(app);
        await scrollTo(app, 0.9);
        // Select inside a row that is currently mounted near the bottom.
        const picked = await page.evalJS<number>(`(function () {
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
        const held = await page.evalJS<{
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
});
