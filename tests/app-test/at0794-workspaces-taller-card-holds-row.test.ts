/**
 * at0794-workspaces-taller-card-holds-row.test.ts — a row clicked near the end
 * of the Workspaces list stays where it was clicked when the workspace it
 * switches to gives the Workspaces card a taller box.
 *
 * Every workspace arranges its own rails, so the Workspaces card is a
 * different height in each one: a reader's right rail splits it with the
 * Layout card at a share of their own choosing per workspace. The shared
 * anchor holds the clicked row's offset from the card's top, and the arriving
 * card is placed to put the row there — but a taller card has less to
 * scroll, and a row near the end of the list wants a `scrollTop` past the
 * taller card's end. Clamped, every row in the card would move by the same
 * few pixels — the constant hop of a switch between two workspaces whose
 * rails differ — so the placement stands the room the row needs below the
 * list instead, and the row lands where it was clicked.
 *
 * The fixture is at0792's — every workspace a Text card and a Workspaces rail
 * — with a Layout card under the Workspaces card on the right rail, the start
 * workspace giving the Workspaces card a smaller share than the target. The
 * start's list is scrolled to its end and the last workspace's header, near
 * the bottom of the card, is clicked.
 *
 * The target's card is visited first and left again, so it stands mounted
 * behind the switch with the scroll-write log installed: the hop is named by
 * the write that makes it, not inferred from where the row ends up.
 *
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/lib/cards-list-anchor.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Enough workspaces that the list overflows the card several times over. */
const COUNT = 24;
const spaceId = (i: number): string => `at0794-s${i}`;
const START = spaceId(0);
const TARGET = spaceId(COUNT - 1);

/** The Workspaces card's share of the right rail; the Layout card takes the rest of 2. */
const START_SHARE = 1.0;
const TARGET_SHARE = 1.4;

const CARD_ROOT = ".cards-card";
const SPACE_HEADER_CELL =
  '.cards-list .tug-list-view-cell[data-tug-list-cell-kind="space-header"]';
const headerFor = (id: string): string =>
  `.cards-space-header[data-cards-space-id="${id}"]`;

/** A row's offset from the card's top edge, in the card's own body. */
const offsetOf = (id: string): string =>
  `(function () {
     var card = document.querySelector(${JSON.stringify(CARD_ROOT)});
     var row = document.querySelector(${JSON.stringify(headerFor(id))});
     if (card === null || row === null) return null;
     return row.getBoundingClientRect().top - card.getBoundingClientRect().top;
   })()`;

const BOX = `(function () {
   var card = document.querySelector(${JSON.stringify(CARD_ROOT)});
   return { scrollTop: card.scrollTop, scrollHeight: card.scrollHeight, clientHeight: card.clientHeight };
 })()`;

interface Box {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Every write to the card's scroller with its stack, installed before the card arrives. */
const SCROLL_WRITE_LOG = `(function () {
   if (window.__at0794writes !== undefined) return null;
   var log = window.__at0794writes = [];
   var t0 = performance.now();
   var d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
   Object.defineProperty(Element.prototype, "scrollTop", {
     configurable: true,
     get: d.get,
     set: function (v) {
       if (this.classList && this.classList.contains("cards-card")) {
         var max = this.scrollHeight - this.clientHeight;
         log.push({
           at: Math.round(performance.now() - t0),
           asked: v,
           max: max,
           stack: String(new Error().stack).split("\\n").slice(1, 5)
             .map(function (s) { return s.trim(); }).join(" < "),
         });
       }
       d.set.call(this, v);
     },
   });
   return null;
 })()`;

const settle = (ms = 400): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function blob(): Record<string, unknown> {
  const spaces = Array.from({ length: COUNT }, (_, i) => {
    const share = spaceId(i) === START ? START_SHARE : TARGET_SHARE;
    return {
      id: spaceId(i),
      name: `W${i}`,
      deck: {
        cards: [
          { id: `T${i}`, componentId: "text", title: `T${i}`, closable: true },
          { id: `C${i}`, componentId: "cards", title: "Workspaces", closable: true },
          { id: `L${i}`, componentId: "layout", title: "Layout", closable: true },
        ],
        panes: [
          {
            id: `pt${i}`,
            position: { x: 60, y: 60 },
            size: { width: 700, height: 400 },
            cardIds: [`T${i}`],
            activeCardId: `T${i}`,
            title: "",
            acceptsFamilies: ["standard"],
          },
          {
            id: `pc${i}`,
            position: { x: 0, y: 0 },
            size: { width: 460, height: 900 },
            cardIds: [`C${i}`],
            activeCardId: `C${i}`,
            title: "",
            acceptsFamilies: [] as string[],
          },
          {
            id: `pl${i}`,
            position: { x: 0, y: 0 },
            size: { width: 460, height: 400 },
            cardIds: [`L${i}`],
            activeCardId: `L${i}`,
            title: "",
            acceptsFamilies: [] as string[],
          },
        ],
        activePaneId: `pt${i}`,
        imposition: {
          kind: "one-up",
          sidebars: { cards: { side: "right" }, layout: { side: "right" } },
          rails: {
            right: {
              order: ["cards", "layout"],
              shares: { cards: share, layout: 2 - share },
            },
          },
        },
        hasFocus: true,
      },
    };
  });
  return { version: 5, activeSpaceId: START, spaces };
}

describe.skipIf(!SHOULD_RUN)(
  "at0794 — a taller Workspaces card in the arriving workspace leaves the row under the mouse",
  () => {
    test(
      "a row clicked at the end of the list keeps its offset in a taller card",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob()),
        );
        const app = await launchTugApp({
          testName: "at0794-taller-card",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        const arriving = app.body(`C${COUNT - 1}`);
        /**
         * A workspace's own Workspaces card, by id. Never "the one on
         * screen": the host's word for which body is visible lags a switch
         * under load, and a scroll sent to one card with the click sent to
         * the next is a click on a row that was never scrolled into view.
         */
        const cardOf = (id: string) => app.body(`C${id.slice("at0794-s".length)}`);
        /** The workspace on screen, which the reader's gestures are in. */
        let here = START;

        /** Bring a header to the card's middle, click it, and wait for its workspace. */
        const goBy = async (target: string): Promise<void> => {
          const from = cardOf(here);
          await from.evalJS<null>(
            `(function () {
               var card = document.querySelector(${JSON.stringify(CARD_ROOT)});
               var row = document.querySelector(${JSON.stringify(headerFor(target))});
               card.scrollTop += row.getBoundingClientRect().top - card.getBoundingClientRect().top - card.clientHeight / 2;
               return null;
             })()`,
          );
          await settle(200);
          await from.nativeClickAtElement(headerFor(target));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(target)}`,
            { timeoutMs: 10_000 },
          );
          here = target;
          await cardOf(here).waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(headerFor(target))}) !== null`,
            { timeoutMs: 15_000 },
          );
          await settle(600);
        };
        /** Scroll the card on screen to the end of its list. */
        const toEnd = async (): Promise<void> => {
          await cardOf(here).evalJS<null>(
            `(function () {
               var card = document.querySelector(${JSON.stringify(CARD_ROOT)});
               card.scrollTop = card.scrollHeight;
               return null;
             })()`,
          );
          await settle(200);
        };

        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined"
             && window.tugdeck.diag.getSpaces().spaces.length === ${COUNT}`,
            { timeoutMs: 25_000 },
          );
          await cardOf(START).waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SPACE_HEADER_CELL)}).length === ${COUNT}`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // ---- Visit the target and come back, so its card stands mounted. ----
          await goBy(TARGET);
          const targetBox = await cardOf(here).evalJS<Box>(BOX);
          await goBy(START);
          await arriving.evalJS<null>(SCROLL_WRITE_LOG);

          // ---- The switch: the start's list at its end, the last header clicked. ----
          await toEnd();
          const startBox = await cardOf(here).evalJS<Box>(BOX);
          const before = await cardOf(here).evalJS<number | null>(offsetOf(TARGET));
          await cardOf(here).nativeClickAtElement(headerFor(TARGET));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(TARGET)}`,
            { timeoutMs: 10_000 },
          );
          await settle(600);
          const after = await arriving.evalJS<number | null>(offsetOf(TARGET));
          const arrivedBox = await arriving.evalJS<Box>(BOX);
          const writes = await arriving.evalJS<string>(
            `JSON.stringify(window.__at0794writes === undefined ? "instrument lost" : window.__at0794writes)`,
          );
          note(
            `at0794 start box=${JSON.stringify(startBox)} target box=${JSON.stringify(targetBox)} ` +
              `arrived box=${JSON.stringify(arrivedBox)} before=${before} after=${after}`,
          );
          note(`at0794 writes in the arriving card=${writes}`);
          expect(
            targetBox.clientHeight,
            "the fixture gives the target's Workspaces card the taller box",
          ).toBeGreaterThan(startBox.clientHeight);
          expect(
            startBox.scrollTop,
            "the start's list stands at its end, where a taller card cannot reach",
          ).toBeCloseTo(startBox.scrollHeight - startBox.clientHeight, 0);
          expect(before, "the clicked row was drawn before the click").not.toBeNull();
          expect(after, "and is drawn in the card that arrived").not.toBeNull();
          expect(
            after ?? Number.NaN,
            "the clicked row sits at the offset it was clicked at, though the arriving card is taller",
          ).toBeCloseTo(before ?? Number.NaN, 0);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
