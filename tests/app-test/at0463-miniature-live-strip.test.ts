/**
 * at0463-miniature-live-strip.test.ts — the Layout card's miniature is an instrument, not a
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
 * claims 1 and 2; `at0463-miniature-live-drag` carries the drawing mirroring
 * the drag itself, and `-flow` claim 3. The deck and the readers are
 * `miniature-live-fixture.ts`.
 *
 * @family at0463-miniature-live
 * @covers tugdeck/src/lib/imposer-gauges.ts
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  AFTER_LAND_MS,
  COMMITTED_MINI,
  HOLD_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  gauge,
  memberSlidePx,
  openDeck,
  titleBar,
  wait,
} from "./miniature-live-fixture";

describe.skipIf(!SHOULD_RUN)("at0463 — the miniature is live: the strip under the hand", () => {
  test(
    "a strip sliding under the hand slides the drawing, with nothing committed",
    async () => {
      const app = await launchTugApp({ testName: "at0463-miniature-live" });
      try {
        await openDeck(app);

        // ── The fixture: one overflowing column, drawn ──────────────────────
        for (const cardId of ["A", "B", "C", "D", "E"]) {
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(cardId)}, slot: 1 }), null)`,
          );
        }
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 1, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        // Bring the strip home: assigning a slot raises the card it placed,
        // and raising a member of an overflowing column reveals it.
        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        await wait(AFTER_LAND_MS);

        const members = await app.evalJS<string[]>(
          `Array.prototype.slice.call(document.querySelectorAll(
             '.tug-pane[data-column-split][data-imposed="1"]'
           )).sort(function (a, b) {
             return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
           }).map(function (el) { return el.getAttribute("data-pane-id"); })`,
        );
        expect(
          members.length,
          "five cards in one slot is an overflowing column",
        ).toBeGreaterThanOrEqual(3);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(
               ${JSON.stringify(COMMITTED_MINI)} + " .layout-mini-block[data-column-overflow]"
             ).length`,
          ),
          "and the drawing draws it as a sliding strip",
        ).toBe(members.length);
        expect(
          await gauge(app, "--gauge-column-offset-1"),
          "at rest the column's strip has published a zero, not a slide",
        ).toBe(0);
        expect(await memberSlidePx(app), "so the members draw untranslated").toBe(
          0,
        );

        // ── 1. The hold moves the picture and commits nothing ───────────────
        const geometry = await app.evalJS<{ left: number; width: number }>(
          `(function () {
            var r = document.querySelector(
              '.tug-pane[data-pane-id=${JSON.stringify(members[0])}]'
            ).getBoundingClientRect();
            return { left: r.left, width: r.width };
          })()`,
        );
        const canvas = await app.evalJS<{ bottom: number }>(
          `(function () {
            var r = document.querySelector("[data-deck-canvas-background]")
              .getBoundingClientRect();
            return { bottom: r.bottom };
          })()`,
        );
        const edge = {
          x: Math.round(geometry.left + geometry.width / 2),
          y: Math.round(canvas.bottom - 60),
        };

        let gaugeUnderHand: number | null = null;
        let slideUnderHand = 0;
        // Definite-assignment rather than an initializer: both are written inside
        // the `motionCensus` callback below, which TypeScript cannot see running,
        // so an `= null` initializer narrows the declared type away and the
        // assertions below compare against `null` instead of the value.
        let draggingAttr!: string | null;
        let transitionUnderHand!: string | null;
        // The census brackets the HOLD alone: the press and the travel to the
        // edge are outside it, so what it counts is the autoscroll's own cost.
        await app.nativeDragElementWithoutRelease(titleBar(members[0]), edge);
        const census = await app.motionCensus(async () => {
          await wait(HOLD_MS);
          gaugeUnderHand = await gauge(app, "--gauge-column-offset-1");
          slideUnderHand = await memberSlidePx(app);
          draggingAttr = await app.evalJS<string | null>(
            `(function () {
              var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
              return mini === null ? null : mini.getAttribute("data-gauge-drag");
            })()`,
          );
          transitionUnderHand = await app.evalJS<string>(
            `(function () {
              var block = document.querySelector(
                ${JSON.stringify(COMMITTED_MINI)} + " .layout-mini-block[data-column-overflow]"
              );
              return getComputedStyle(block).transitionDuration;
            })()`,
          );
        }, 0);
        const committedDuringHold = await app.evalJS<number>(
          `((window.tugdeck.diag.getDeckState().columnOffsets || {})[1] || 0)`,
        );
        note(
          `under the hand: gauge=${gaugeUnderHand}, slide=${slideUnderHand}px, ` +
            `data-gauge-drag=${draggingAttr}, transition=${transitionUnderHand}, ` +
            `committed offset=${committedDuringHold}, notifies=${census.notifies}`,
        );

        expect(
          draggingAttr,
          "the channel stamps the live drag on the drawing it publishes to",
        ).toBe("true");
        expect(
          gaugeUnderHand,
          "the strip has slid, and the channel is carrying how far",
        ).toBeGreaterThan(0);
        expect(
          slideUnderHand,
          "so the drawn members have travelled UP the field with it",
        ).toBeLessThan(-1);
        expect(
          transitionUnderHand,
          "and per-frame motion is not smoothed a second time",
        ).toBe("0s");
        expect(
          committedDuringHold,
          "while the deck has committed nothing at all ([P12])",
        ).toBe(0);
        expect(
          census.notifies,
          "which is the claim: the picture moved without one store notify",
        ).toBe(0);

        // ── 2. The drop hands the motion back to the commit ─────────────────
        await app.nativeMouseUp(edge);
        await wait(AFTER_LAND_MS);
        const committed = await app.evalJS<number>(
          `((window.tugdeck.diag.getDeckState().columnOffsets || {})[1] || 0)`,
        );
        const run = await app.evalJS<number>(
          `window.tugdeck.diag.getDeckState().panes.length && (function () {
            var el = document.querySelector('.tug-pane[data-column-split]');
            return el === null ? 0 : 1;
          })()`,
        );
        expect(run, "the column survived the drop").toBe(1);
        expect(
          committed,
          "the drop is where the offset becomes real state",
        ).toBeGreaterThan(0);
        const gaugeAfter = await gauge(app, "--gauge-column-offset-1");
        const slideAfter = await memberSlidePx(app);
        note(
          `after the drop: committed=${Math.round(committed)}px, gauge=${gaugeAfter}, slide=${slideAfter}px`,
        );
        expect(
          gaugeAfter,
          "the commit republishes the same number it committed",
        ).toBeGreaterThan(0);
        expect(
          Math.abs(slideAfter),
          "so the live term is spent and the pins carry the position again",
        ).toBeLessThan(1);
        expect(
          await app.evalJS<string | null>(
            `(function () {
              var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
              return mini.getAttribute("data-gauge-drag");
            })()`,
          ),
          "and the drag is retired from the channel",
        ).toBeNull();
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
