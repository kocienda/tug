/**
 * at0463-miniature-live-drag.test.ts — the Layout card's miniature is an instrument, not a
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
 * the drawing mirroring the drag itself and retiring it with the gesture;
 * `at0463-miniature-live-strip` carries claims 1 and 2, and `-flow` claim 3.
 * The deck and the readers are `miniature-live-fixture.ts`.
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
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  describe_,
  openDeck,
  titleBar,
  wait,
  type Box,
} from "./miniature-live-fixture";
import { kindBody } from "./_harness/card-reach";

describe.skipIf(!SHOULD_RUN)("at0463 — the miniature is live: the drag", () => {
  test(
    "the drawing mirrors the drag itself, and retires it with the gesture",
    async () => {
      const app = await launchTugApp({ testName: "at0463-miniature-live" });
      try {
        await openDeck(app);

        // Where the drag is about to happen, in canvas terms — and where the
        // drawing stands, so the two can be compared in one scale.
        // The canvas is the shell's and the drawing is in the Layout card's
        // body: each box is read in its own page, and every comparison below
        // is an offset within one page or a width, so the pages' origins
        // never meet.
        const boxes = {
          canvas: await app.evalJS<Box>(
            `(function () {
              var r = document.querySelector("[data-deck-canvas-background]").getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            })()`,
          ),
          mini: await kindBody(app, "layout").evalJS<Box>(
            `(function () {
              // The drawing's PADDING box, which is the containing block an
              // absolutely positioned child is placed and sized against — its
              // border box would be off by the 1px frame.
              var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
              var box = mini.getBoundingClientRect();
              return {
                left: box.left + mini.clientLeft,
                top: box.top + mini.clientTop,
                width: mini.clientWidth,
                height: mini.clientHeight,
              };
            })()`,
          ),
        };
        // The drawing's fractions are taken against its PADDING box, which is
        // what an absolutely positioned child is placed in.
        const scaleX = boxes.mini.width / boxes.canvas.width;
        const scaleY = boxes.mini.height / boxes.canvas.height;

        const target = await app.evalJS<{ x: number; y: number }>(
          `(function () {
            var r = document.querySelector('.tug-pane[data-pane-id="p3"]')
              .getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) };
          })()`,
        );
        await app.nativeDragElementWithoutRelease(titleBar("p1"), target);

        // The dragged frame and the drop indicator are the shell's; the
        // ghost and the zone are drawn in the Layout card's body.
        const TO_BOX_JS = `function (el) {
              if (el === null) return null;
              var r = el.getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            }`;
        const heldShell = await app.evalJS<{ drag: Box | null; indicator: Box | null }>(
          `(function () {
            var toBox = ${TO_BOX_JS};
            return {
              drag: toBox(document.querySelector('.tug-pane[data-pane-id="p1"]')),
              indicator: toBox(document.querySelector(".tug-drop-zone-indicator")),
            };
          })()`,
        );
        const heldBody = await kindBody(app, "layout").evalJS<{ ghost: Box | null; zone: Box | null }>(
          `(function () {
            var toBox = ${TO_BOX_JS};
            var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
            return {
              ghost: toBox(mini.querySelector(".layout-mini-ghost")),
              zone: toBox(mini.querySelector(".layout-mini-zone")),
            };
          })()`,
        );
        const held = { ...heldShell, ...heldBody };
        note(
          `ghost ${describe_(held.ghost)} for a frame at ${describe_(held.drag)}; ` +
            `zone ${describe_(held.zone)} for an indicator at ${describe_(held.indicator)}`,
        );

        expect(held.ghost, "a live drag draws a ghost").not.toBeNull();
        expect(held.zone, "and the place it is being offered").not.toBeNull();
        expect(held.indicator, "which the canvas is indicating too").not.toBeNull();

        const ghost = held.ghost as Box;
        const drag = held.drag as Box;
        // The ghost IS the dragged frame, drawn small: the same rect, through
        // the same scale. Tolerance is a drawing's worth of pixels — the
        // miniature's 1px border and 3px padding sit inside this mapping.
        expect(
          (ghost.left - boxes.mini.left) / scaleX,
          "the ghost stands where the card stands",
        ).toBeCloseTo(drag.left - boxes.canvas.left, -1);
        expect(
          (ghost.top - boxes.mini.top) / scaleY,
          "on both axes",
        ).toBeCloseTo(drag.top - boxes.canvas.top, -1);
        expect(
          ghost.width / scaleX,
          "and is the card's own size, scaled",
        ).toBeCloseTo(drag.width, -1);

        const zone = held.zone as Box;
        const indicator = held.indicator as Box;
        expect(
          (zone.left - boxes.mini.left) / scaleX,
          "and the highlight stands on the place the canvas indicated",
        ).toBeCloseTo(indicator.left - boxes.canvas.left, -1);
        expect(
          zone.width / scaleX,
          "at that place's width",
        ).toBeCloseTo(indicator.width, -1);

        // ── ⌘ frees the card: the ghost stays, the place goes ───────────────
        await app.withModifiersHeld(["cmd"], async () => {
          await app.nativeDragElementWithoutRelease(titleBar("p1"), {
            x: target.x + 12,
            y: target.y + 12,
          });
          const freed = await kindBody(app, "layout").evalJS<{ drag: boolean; zone: boolean }>(
            `(function () {
              var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
              return {
                drag: mini.hasAttribute("data-gauge-drag"),
                zone: mini.hasAttribute("data-gauge-zone"),
              };
            })()`,
          );
          note(`⌘ held: drag=${freed.drag}, zone=${freed.zone}`);
          expect(freed.drag, "⌘ does not end the drag").toBe(true);
          expect(
            freed.zone,
            "but nothing is being offered, so the drawing offers nothing",
          ).toBe(false);
          await app.nativeMouseUp({ x: target.x + 12, y: target.y + 12 });
        });
        await wait(AFTER_LAND_MS);

        const retired = await kindBody(app, "layout").evalJS<{
          drag: boolean;
          zone: boolean;
          ghostShown: string;
        }>(
          `(function () {
            var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
            return {
              drag: mini.hasAttribute("data-gauge-drag"),
              zone: mini.hasAttribute("data-gauge-zone"),
              ghostShown: getComputedStyle(mini.querySelector(".layout-mini-ghost")).display,
            };
          })()`,
        );
        expect(retired.drag, "the release retires the drag").toBe(false);
        expect(retired.zone, "and the place with it").toBe(false);
        expect(
          retired.ghostShown,
          "so the drawing goes back to being a picture of a deck at rest",
        ).toBe("none");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
