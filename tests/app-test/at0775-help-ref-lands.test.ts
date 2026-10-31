/**
 * at0775-help-ref-lands.test.ts — a help ref opens its card clear of the rail,
 * with the cited passage at the top of the card's scroll area.
 *
 * Two separate faults, each read here after a trusted press and release on the
 * chip.
 *
 * The passage: a card's page mounts at 0 × 0 and the host places its view a
 * moment later. A document that rendered first took its scroll offset from a
 * scroller 28 px wide, where the recipe stands ten times further down, and the
 * offset outlived that layout: the card opened two thousand pixels past the
 * recipe. A pause and then a press and release is what loses that race reliably,
 * and it is what a person's click is. Without the pause, or through a harness
 * click (`nativeClickAtElement`), the view is placed first and the file reads
 * green with the fault in, so neither is a stand-in here.
 *
 * The rail: under one-up a new card is a free pane and walks the cascade, which
 * started at the canvas's corner whatever stood there, and a rail stands above
 * every free pane. So this is every card opened at runtime, not help cards: the
 * Settings card is opened and read too.
 *
 * Claims:
 *
 *  1. The cited heading is at the top of the card's scroll area, and it is the
 *     element under its own centre: nothing covers it.
 *  2. The passage stays there when the layout moves again, until the reader acts.
 *     After a wheel the card leaves the reader's offset alone.
 *  3. The opened card's rect overlaps no rail, under fit and under flow, on the
 *     left and on the right, and it stays inside the window.
 *
 * @covers tugdeck/src/components/tugways/cards/help-card.tsx
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/cascade.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { PIXEL_TOL } from "./_harness/tolerances";
import { kindPane } from "./body-grounding/_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const CHIP = `${CARD} [data-overview-ref-kind="help"]`;
const HEADING = "Create an arc";

const FIND_HEADING = `Array.from(document.querySelectorAll('[data-slot="help-card"] h3')).find(function (h) { return (h.textContent || "").trim() === ${JSON.stringify(HEADING)}; })`;

/** The heading against the scroller, and what is drawn at the heading's centre. */
const READ_PASSAGE = `(function(){
  var root = document.querySelector('[data-slot="help-card"]');
  var heading = ${FIND_HEADING};
  var rect = heading.getBoundingClientRect();
  var hit = document.elementFromPoint(rect.left + 4, rect.top + rect.height / 2);
  return {
    fromTop: rect.top - root.getBoundingClientRect().top,
    scrollTop: root.scrollTop,
    hitsHeading: hit !== null && heading.contains(hit),
  };
})()`;

interface Passage {
  fromTop: number;
  scrollTop: number;
  hitsHeading: boolean;
}

/** The rect the shell draws the newest card of `componentId` at, beside the rail's. */
function readRects(componentId: string): string {
  return `(function(){
    var deck = window.tugdeck.diag.getDeckState();
    var rectOf = function (cardId) {
      var pane = deck.panes.find(function (p) { return p.cardIds.indexOf(cardId) !== -1; });
      var r = document.querySelector('.tug-pane[data-pane-id="' + pane.id + '"]').getBoundingClientRect();
      return { left: r.left, right: r.right };
    };
    var cards = deck.cards.filter(function (c) { return c.componentId === ${JSON.stringify(componentId)}; });
    return { card: rectOf(cards[cards.length - 1].id), rail: rectOf("O"), canvas: window.innerWidth };
  })()`;
}

interface Rects {
  card: { left: number; right: number };
  rail: { left: number; right: number };
  canvas: number;
}

async function expectClearOfRail(app: App, componentId: string, scene: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 5_000 },
  );
  const rects = await app.evalJS<Rects>(readRects(componentId));
  note(`at0775 ${scene}, ${componentId}: ${JSON.stringify(rects)}`);
  const clear = rects.card.left >= rects.rail.right || rects.card.right <= rects.rail.left;
  expect(clear, `${scene}: the ${componentId} card overlaps no rail`).toBe(true);
  expect(rects.card.right, `${scene}: the ${componentId} card is inside the window`).toBeLessThanOrEqual(
    rects.canvas,
  );
}

const SCENES = [
  { name: "left rail, fit", side: "left", layout: "fit" },
  { name: "left rail, flow", side: "left", layout: "flow" },
  { name: "right rail, fit", side: "right", layout: "fit" },
];

describe.skipIf(!SHOULD_RUN)("at0775 — a help ref lands", () => {
  for (const scene of SCENES) {
    test(
      scene.name,
      async () => {
        const app = await launchTugApp({ testName: "at0775-help-ref-lands" });
        try {
          await app.setWindowContentSize({ width: 1320, height: 900 });
          await app.seedDeckState({
            state: {
              cards: [{ id: "O", componentId: "overview", title: "Overview", closable: true }],
              panes: [kindPane("overview", "O", 1)],
              activePaneId: "O-pane",
              imposition: {
                kind: "one-up",
                layout: scene.layout,
                sidebars: { overview: { side: scene.side } },
                rails: { [scene.side]: { order: ["overview"] } },
              },
              hasFocus: true,
            },
            focusCardId: "O",
          });
          const overview = app.body("O");
          await overview.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARD)}) !== null`,
            { timeoutMs: 15_000 },
          );
          const post = {
            id: 9775,
            at_ms: 1_754_600_000_000,
            author: "observer",
            body: "Arcs are opened from the door.",
            refs: [{ kind: "help", target: "recipes#create-an-arc" }],
          };
          expect(
            await overview.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
            ),
          ).toBe(true);
          await overview.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
            { timeoutMs: 10_000 },
          );

          // The pause is load-bearing: see the header.
          await Bun.sleep(800);
          const center = await overview.evalJS<{ x: number; y: number }>(`(function(){
            var rect = document.querySelector(${JSON.stringify(CHIP)}).getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`);
          await overview.nativeDragElementWithoutRelease(CHIP, { selector: CHIP });
          await overview.nativeMouseUp(center);

          const help = kindBody(app, "help");
          // A real size, then past the frame that delivers it: a reading taken
          // at 0 × 0 reads the heading at the top with the fault in.
          await help.waitForCondition<boolean>(
            `window.innerWidth > 0 && (${FIND_HEADING}) !== undefined`,
            { timeoutMs: 10_000 },
          );
          await Bun.sleep(500);

          const landed = await help.evalJS<Passage>(READ_PASSAGE);
          note(`at0775 ${scene.name}, landed: ${JSON.stringify(landed)}`);
          expect(
            Math.abs(landed.fromTop),
            `${scene.name}: the heading is at the top of the scroll area`,
          ).toBeLessThanOrEqual(PIXEL_TOL);
          expect(landed.hitsHeading, `${scene.name}: nothing covers the heading`).toBe(true);

          await expectClearOfRail(app, "help", scene.name);

          // The layout moves again with the reader still not having acted: the
          // passage stays. Then the reader acts, and the card lets go.
          const NARROW = `document.querySelector('[data-slot="help-card"]').style.width = "480px"; null`;
          const WIDEN = `document.querySelector('[data-slot="help-card"]').style.width = ""; null`;
          await help.evalJS(NARROW);
          await Bun.sleep(150);
          const held = await help.evalJS<Passage>(READ_PASSAGE);
          note(`at0775 ${scene.name}, narrowed: ${JSON.stringify(held)}`);
          expect(Math.abs(held.fromTop), `${scene.name}: the passage is held`).toBeLessThanOrEqual(PIXEL_TOL);

          await help.evalJS(`(function(){
            var root = document.querySelector('[data-slot="help-card"]');
            root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 }));
            root.scrollTop = 12;
            return null;
          })()`);
          await help.evalJS(WIDEN);
          await Bun.sleep(150);
          const released = await help.evalJS<Passage>(READ_PASSAGE);
          note(`at0775 ${scene.name}, after the reader: ${JSON.stringify(released)}`);
          expect(released.scrollTop, `${scene.name}: the reader's offset is left alone`).toBe(12);

          await app.evalJS(`window.__tug.dispatchControlAction("show-card", { component: "settings" })`);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getDeckState().cards.some(function (c) { return c.componentId === "settings"; })`,
            { timeoutMs: 10_000 },
          );
          await expectClearOfRail(app, "settings", scene.name);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
