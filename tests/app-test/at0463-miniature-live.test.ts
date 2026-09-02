/**
 * at0463-miniature-live.test.ts — the Layout card's miniature is an instrument, not a
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
 * @covers tugdeck/src/lib/imposer-gauges.ts
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const RAIL_WIDTH = 420;
/** The settle window, with room for a landing tween. */
const AFTER_LAND_MS = 900;
/** Long enough for the autoscroll's rate integrator to travel visibly. */
const HOLD_MS = 400;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const COMMITTED_MINI =
  '[data-testid="layout-card-plan"] [data-plan-layer="committed"] .layout-mini';

/** Five content cards and the Layout card on the right, six-up so slot 1 exists. */
function deckShape(): Record<string, unknown> {
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: 600, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "six-up",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** Open the deck with the Layouts plan on screen. */
async function openDeck(app: App, layout?: "flow"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
  const state = deckShape();
  if (layout === "flow") {
    (state.imposition as Record<string, unknown>).layout = "flow";
  }
  await app.seedDeckState({ state, focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="layout-card-plan"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await app.evalJS(
    `document.querySelector('[data-testid="layout-card-section"]')
       .scrollIntoView({ block: "center" })`,
  );
  await wait(AFTER_LAND_MS);
}

/** One gauge property as it stands on the committed drawing, or null when the
 *  channel has published nothing onto it. */
async function gauge(app: App, property: string): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
      if (mini === null) return null;
      var raw = mini.style.getPropertyValue(${JSON.stringify(property)});
      return raw === "" ? null : parseFloat(raw);
    })()`,
  );
}

/** The vertical translation the first overflowing column member is drawing
 *  with, in pixels — the live half of its position. */
async function memberSlidePx(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var block = document.querySelector(
        ${JSON.stringify(COMMITTED_MINI)} + " .layout-mini-block[data-column-overflow]"
      );
      if (block === null) return NaN;
      var transform = getComputedStyle(block).transform;
      if (transform === "none") return 0;
      var parts = transform.replace(/^matrix\\(/, "").replace(/\\)$/, "").split(",");
      return parseFloat(parts[5]);
    })()`,
  );
}

/** A rect as both the deck and the drawing report one. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One box as a diagnostic line. */
const describe_ = (box: Box | null): string =>
  box === null
    ? "none"
    : `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}`;

const titleBar = (paneId: string): string =>
  `.tug-pane[data-pane-id="${paneId}"] .tug-pane-title-bar`;

describe.skipIf(!SHOULD_RUN)("at0463 — the miniature is live", () => {
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

  test(
    "the drawing mirrors the drag itself, and retires it with the gesture",
    async () => {
      const app = await launchTugApp({ testName: "at0463-miniature-live" });
      try {
        await openDeck(app);

        // Where the drag is about to happen, in canvas terms — and where the
        // drawing stands, so the two can be compared in one scale.
        const boxes = await app.evalJS<{
          canvas: Box;
          mini: Box;
        }>(
          `(function () {
            var toBox = function (el) {
              var r = el.getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            };
            // The drawing's PADDING box, which is the containing block an
            // absolutely positioned child is placed and sized against — its
            // border box would be off by the 1px frame.
            var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
            var box = mini.getBoundingClientRect();
            return {
              canvas: toBox(document.querySelector("[data-deck-canvas-background]")),
              mini: {
                left: box.left + mini.clientLeft,
                top: box.top + mini.clientTop,
                width: mini.clientWidth,
                height: mini.clientHeight,
              },
            };
          })()`,
        );
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

        const held = await app.evalJS<{
          drag: Box | null;
          ghost: Box | null;
          indicator: Box | null;
          zone: Box | null;
        }>(
          `(function () {
            var toBox = function (el) {
              if (el === null) return null;
              var r = el.getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            };
            var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
            return {
              drag: toBox(document.querySelector('.tug-pane[data-pane-id="p1"]')),
              ghost: toBox(mini.querySelector(".layout-mini-ghost")),
              indicator: toBox(document.querySelector(".tug-drop-zone-indicator")),
              zone: toBox(mini.querySelector(".layout-mini-zone")),
            };
          })()`,
        );
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
          const freed = await app.evalJS<{ drag: boolean; zone: boolean }>(
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

        const retired = await app.evalJS<{
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
        const band = await app.evalJS<number>(
          `(function () {
            var box = document.querySelector("[data-deck-canvas-background]")
              .getBoundingClientRect();
            var rail = document.querySelector('.tug-pane[data-pane-id="pRail"]')
              .getBoundingClientRect();
            return (rail.left - 5) - (box.left + 5);
          })()`,
        );
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
