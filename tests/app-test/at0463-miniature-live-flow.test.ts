/**
 * at0463-miniature-live-flow.test.ts — the Layout card's miniature is an instrument, not a
 * diagram.
 *
 * The committed drawing has always been able to show where the deck STOOD at
 * the last commit. The gauge channel ([P08]) makes it show where the deck is
 * right now: the canvas's per-frame writers publish the deck's live numbers as
 * custom properties onto every element registered for a signal, and the
 * drawing composes them in CSS. Nothing renders, nothing is notified, and the
 * picture moves with the hand.
 *
 * What this file pins:
 *
 *   1. **A strip sliding under the hand slides the drawing with it.** Holding a
 *      dragged card at an overflowing column's bottom edge autoscrolls the
 *      strip. During the hold NOTHING is committed — the offset lives on a
 *      custom property until the drop ([P12]) — so a drawing that only knew
 *      committed state could not move at all. The census is read across the
 *      hold: the store is notified zero times while the miniature's gauge
 *      travels and its members translate.
 *   2. **The commit hands the motion back.** On release the offset commits, the
 *      drawing re-renders at its new pins, and the live translation returns to
 *      zero — the gauge carries the motion BETWEEN commits and nothing else,
 *      so the two layers can never double-count.
 *   3. **The flow window reads the same channel.** After a reveal moves the
 *      flow strip, the committed drawing carries `--gauge-flow-offset` at the
 *      offset's own fraction of the band, which is the number the window's
 *      position is composed from.
 *
 * The assertions are on the REAL properties of the REAL elements — the
 * mechanism itself — rather than on screenshots of them, for the reason the
 * plan states: liveness is a fact about what is published and composed, and a
 * picture cannot distinguish a live drawing from a lucky one.
 *
 * Cut from `at0463-miniature-live` to fit the 20 s budget. This file carries
 * claim 3; `at0463-miniature-live-strip` carries claims 1 and 2, and `-drag`
 * the drawing mirroring the drag itself. The deck and the readers are
 * `miniature-live-fixture.ts`.
 *
 * @family at0463-miniature-live
 * @covers tugdeck/src/lib/imposer-gauges.ts
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.css
 */

import { describe, expect, test } from "bun:test";

import { flowBandEdges } from "../../tugdeck/src/lib/layout-imposer";
import { launchTugApp, note } from "./_harness";
import {
  AFTER_LAND_MS,
  COMMITTED_MINI,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  gauge,
  openDeck,
  wait,
} from "./miniature-live-fixture";

describe.skipIf(!SHOULD_RUN)("at0463 — the miniature is live: the flow window", () => {
  test(
    "the flow window reads the offset off the same channel",
    async () => {
      const app = await launchTugApp({ testName: "at0463-miniature-live" });
      try {
        await openDeck(app, "flow");
        // Revealing the last card slides the strip — a committed move, which
        // is the other half of the channel: publishers run at the commit too,
        // so the drawing's live term is zero rather than stale.
        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);

        const offset = await app.evalJS<number>(
          `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
        );
        // The band through the deck's OWN function, from the canvas width and
        // the standing rail's width — not re-derived from the two elements'
        // edges here. A second reading agrees with `getBandWidth()` only by
        // luck, as its own docstring says: a rail contributes
        // `railSpanInsetPx`, which spends the rail gutter as well as the
        // imposition gap, so a hand-written `rail.left - 5` ran 7px wide from
        // the moment `flowBandEdges` became the one answer (`4aef806c3`).
        const canvasWidth = await app.evalJS<number>(
          `document.querySelector("[data-deck-canvas-background]")
             .getBoundingClientRect().width`,
        );
        const railWidth = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pRail"]')
             .getBoundingClientRect().width`,
        );
        const edges = flowBandEdges(canvasWidth, { right: railWidth });
        const band = edges.end - edges.start;
        const published = await gauge(app, "--gauge-flow-offset");
        note(
          `flow: offset ${Math.round(offset)}px / band ${Math.round(band)}px = ` +
            `${(offset / band).toFixed(4)}, published ${published}`,
        );
        expect(offset, "revealing the last card moved the strip").toBeGreaterThan(
          0,
        );
        expect(
          published,
          "and the channel carries it as a fraction of the band",
        ).toBeCloseTo(offset / band, 2);

        const windowSlide = await app.evalJS<number>(
          `(function () {
            var win = document.querySelector(
              ${JSON.stringify(COMMITTED_MINI)} + " .layout-mini-window"
            );
            if (win === null) return NaN;
            var transform = getComputedStyle(win).transform;
            if (transform === "none") return 0;
            var parts = transform.replace(/^matrix\\(/, "").replace(/\\)$/, "").split(",");
            return parseFloat(parts[4]);
          })()`,
        );
        expect(
          Math.abs(windowSlide),
          "a committed move leaves nothing for the live term to carry",
        ).toBeLessThan(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
