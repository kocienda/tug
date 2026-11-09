/**
 * at0792-workspaces-click-holds-row.test.ts — the row a reader clicks in the
 * Workspaces card is still where they clicked it once the switch completes.
 *
 * Every mounted workspace holds its own Workspaces card, each its own body
 * with its own scroller. A click on another workspace's header switches to
 * that workspace, which hides the card the reader was looking at and shows a
 * different one, at whatever offset that card last had — or at the top, for a
 * workspace nobody has visited. Nothing in the switch consults where the
 * departing card was, so the clicked row jumps out from under the mouse.
 *
 * The guarantee is a row anchor within the card: the clicked row's offset from
 * the card's top before the click is its offset after the switch settles. The
 * fixture gives every workspace the same rail, so the two cards' boxes match
 * and the anchor is exact. Which workspace is active is ink alone — the
 * accent on its name, the open eye in a fixed-width glyph column, a parked
 * workspace's rows at a lower opacity — so every row is the same height in
 * both cards, and the test asserts that and then the offset to the pixel.
 *
 * Three legs in one launch, measured and then asserted together:
 *
 *   1. **Unfiltered.** The list is scrolled so a workspace deep in it sits
 *      mid-card; its header is clicked; the arriving card is read.
 *   2. **Filtered.** In the card that arrived, a filter is typed, the list is
 *      scrolled again, and another deep header is clicked. The arriving card
 *      must show the same filtered list for the row to have any chance of
 *      holding still.
 *   3. **Back to a mounted card.** From there, the first leg's workspace is
 *      clicked again. Its card has stood behind the switch since the first
 *      leg, at the offset it was left at, so this is the leg in which a
 *      card's own scroll memory would show, and the shared anchor must win.
 *
 * The first two legs are red on a deck whose cards keep their own scroll offset and
 * their own filter. A card standing up for a workspace hears the anchor before
 * its rows arrive, so this is also the test of the placement being held until
 * there are rows to place.
 *
 * A second test holds the filter half on its own, and is green now: the
 * query is one fact for the deck, so a filter typed in one workspace's card
 * is the filter in every other's — a card standing up for the first time and
 * a card already mounted behind the one on screen alike.
 *
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** Enough workspaces that the list overflows the card several times over. */
const COUNT = 24;
const spaceId = (i: number): string => `at0792-s${i}`;

/** Where each leg starts, and the deep workspace each leg clicks. */
const START = spaceId(0);
const FIRST_TARGET = spaceId(18);
const SECOND_TARGET = spaceId(12);

/** Matches `T1` and `T10`–`T19`, so the filtered list still overflows. */
const FILTER = "T1";

const CARD_ROOT = ".cards-card";
const FILTER_INPUT = `${CARD_ROOT} [data-testid="cards-filter"] input`;
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

/** Scroll the card so a row sits at its vertical middle; returns the scroller. */
const centre = (id: string): string =>
  `(function () {
     var card = document.querySelector(${JSON.stringify(CARD_ROOT)});
     var row = document.querySelector(${JSON.stringify(headerFor(id))});
     if (card === null) throw new Error("no card root");
     if (row === null) throw new Error("no header for " + ${JSON.stringify(id)});
     var off = row.getBoundingClientRect().top - card.getBoundingClientRect().top;
     card.scrollTop += off - card.clientHeight / 2;
     return {
       scrollTop: card.scrollTop,
       scrollHeight: card.scrollHeight,
       clientHeight: card.clientHeight,
     };
   })()`;

const settle = (ms = 400): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Every drawn row's height, in list order: the box the anchor is measured in. */
const ROW_HEIGHTS = `(function () {
   var cells = document.querySelectorAll(
     ".cards-list .tug-list-view-cell[data-tug-list-cell-index]");
   return Array.prototype.map.call(cells, function (c) {
     return c.getBoundingClientRect().height;
   });
 })()`;

/**
 * Every workspace is laid out alike — a Text card and a Workspaces rail of the
 * same size — so the departing and arriving cards' boxes match and the row
 * anchor's best case, exact, is the one asserted.
 */
function blob(): Record<string, unknown> {
  const spaces = Array.from({ length: COUNT }, (_, i) => ({
    id: spaceId(i),
    name: `W${i}`,
    deck: {
      cards: [
        { id: `T${i}`, componentId: "text", title: `T${i}`, closable: true },
        { id: `C${i}`, componentId: "cards", title: "Workspaces", closable: true },
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
      ],
      activePaneId: `pt${i}`,
      imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
      hasFocus: true,
    },
  }));
  return { version: 5, activeSpaceId: START, spaces };
}

interface Leg {
  before: number | null;
  after: number | null;
  heightsBefore: number[];
  heightsAfter: number[];
}

describe.skipIf(!SHOULD_RUN)(
  "at0792 — a click in the Workspaces card leaves the row under the mouse",
  () => {
    test(
      "the clicked row keeps its offset in the card across the switch, filtered or not",
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
          testName: "at0792-click-holds-row",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        const cards = kindBody(app, "cards");

        /** Click a deep header, wait for its workspace, read the new card. */
        const switchBy = async (target: string): Promise<Leg> => {
          const scroller = await cards.evalJS<{
            scrollTop: number;
            scrollHeight: number;
            clientHeight: number;
          }>(centre(target));
          expect(
            scroller.scrollHeight,
            "the fixture overflows the card, or there is no scroll offset to lose",
          ).toBeGreaterThan(scroller.clientHeight);
          await settle(200);
          const before = await cards.evalJS<number | null>(offsetOf(target));
          const heightsBefore = await cards.evalJS<number[]>(ROW_HEIGHTS);
          await cards.nativeClickAtElement(headerFor(target));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(target)}`,
            { timeoutMs: 10_000 },
          );
          await cards.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(headerFor(target))}) !== null`,
            { timeoutMs: 15_000 },
          );
          await settle(600);
          const after = await cards.evalJS<number | null>(offsetOf(target));
          const heightsAfter = await cards.evalJS<number[]>(ROW_HEIGHTS);
          return { before, after, heightsBefore, heightsAfter };
        };

        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined"
             && window.tugdeck.diag.getSpaces().spaces.length === ${COUNT}`,
            { timeoutMs: 25_000 },
          );
          await cards.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SPACE_HEADER_CELL)}).length === ${COUNT}`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // ---- 1. Unfiltered. ---------------------------------------------
          const plain = await switchBy(FIRST_TARGET);
          note(`at0792 unfiltered ${FIRST_TARGET}: before=${plain.before} after=${plain.after} rows=${plain.heightsAfter.length}`);

          // ---- 2. Filtered, typed in the card that just arrived. ---------
          await cards.evalJS<null>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
               if (el === null) throw new Error("no filter field");
               el.focus();
               var setter = Object.getOwnPropertyDescriptor(
                 window.HTMLInputElement.prototype, "value").set;
               setter.call(el, ${JSON.stringify(FILTER)});
               el.dispatchEvent(new Event("input", { bubbles: true }));
               return null;
             })()`,
          );
          await cards.waitForCondition<boolean>(
            `document.querySelectorAll('.cards-list .cards-row[data-cards-row-id]').length < ${COUNT}`,
            { timeoutMs: 10_000 },
          );
          await settle();
          const filtered = await switchBy(SECOND_TARGET);
          const arrivingFilter = await cards.evalJS<string | null>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
               return el === null ? null : el.value;
             })()`,
          );
          note(
            `at0792 filtered ${SECOND_TARGET}: before=${filtered.before} after=${filtered.after} rows=${filtered.heightsAfter.length} ` +
              `arriving filter=${JSON.stringify(arrivingFilter)}`,
          );

          // ---- 3. Back to the first leg's workspace, its card mounted. ----
          const returned = await switchBy(FIRST_TARGET);
          note(`at0792 returned ${FIRST_TARGET}: before=${returned.before} after=${returned.after}`);

          expect(plain.before, "the clicked row was drawn before the click").not.toBeNull();
          expect(plain.after, "and is drawn in the card that arrived").not.toBeNull();
          expect(
            plain.heightsAfter,
            "which workspace is active changes no row's height, so the boxes match",
          ).toEqual(plain.heightsBefore);
          expect(
            plain.after ?? Number.NaN,
            "the clicked row sits at the offset it was clicked at, to the pixel",
          ).toBeCloseTo(plain.before ?? Number.NaN, 0);
          expect(arrivingFilter, "the arriving card filters as the departing one did").toBe(FILTER);
          expect(filtered.before).not.toBeNull();
          expect(filtered.after).not.toBeNull();
          expect(filtered.heightsAfter).toEqual(filtered.heightsBefore);
          expect(
            filtered.after ?? Number.NaN,
            "with a filter typed, the clicked row still sits where it was clicked, to the pixel",
          ).toBeCloseTo(filtered.before ?? Number.NaN, 0);
          expect(returned.before).not.toBeNull();
          expect(returned.after).not.toBeNull();
          expect(
            returned.after ?? Number.NaN,
            "a card mounted behind the switch takes the shared position, not the one it was left at",
          ).toBeCloseTo(returned.before ?? Number.NaN, 0);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a filter typed in one workspace's card is the filter in every other's",
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
          testName: "at0792-filter-is-shared",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        const cards = kindBody(app, "cards");
        const typeFilter = (text: string): Promise<null> =>
          cards.evalJS<null>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
               if (el === null) throw new Error("no filter field");
               el.focus();
               var setter = Object.getOwnPropertyDescriptor(
                 window.HTMLInputElement.prototype, "value").set;
               setter.call(el, ${JSON.stringify(text)});
               el.dispatchEvent(new Event("input", { bubbles: true }));
               return null;
             })()`,
          );
        const reading = (): Promise<{ field: string | null; rows: number }> =>
          cards.evalJS<{ field: string | null; rows: number }>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
               return {
                 field: el === null ? null : el.value,
                 rows: document.querySelectorAll(
                   '.cards-list .cards-row[data-cards-row-id]').length,
               };
             })()`,
          );
        const goTo = async (target: string): Promise<void> => {
          await cards.nativeClickAtElement(headerFor(target));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(target)}`,
            { timeoutMs: 10_000 },
          );
          await cards.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(headerFor(target))}) !== null`,
            { timeoutMs: 15_000 },
          );
          await settle(600);
        };

        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined"
             && window.tugdeck.diag.getSpaces().spaces.length === ${COUNT}`,
            { timeoutMs: 25_000 },
          );
          await cards.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SPACE_HEADER_CELL)}).length === ${COUNT}`,
            { timeoutMs: 25_000 },
          );
          await settle();
          const unfiltered = await reading();

          // ---- 1. Typed in the first workspace's card. ---------------------
          await typeFilter(FILTER);
          await cards.waitForCondition<boolean>(
            `document.querySelectorAll('.cards-list .cards-row[data-cards-row-id]').length < ${unfiltered.rows}`,
            { timeoutMs: 10_000 },
          );
          await settle();
          const typed = await reading();

          // ---- 2. A card that stands up for the first time takes it. ------
          await goTo(spaceId(1));
          const arrived = await reading();

          // ---- 3. Cleared there; the first card, mounted all along, hears it.
          await typeFilter("");
          await cards.waitForCondition<boolean>(
            `document.querySelectorAll('.cards-list .cards-row[data-cards-row-id]').length === ${unfiltered.rows}`,
            { timeoutMs: 10_000 },
          );
          await goTo(START);
          const back = await reading();
          note(
            `at0792 filter: unfiltered=${JSON.stringify(unfiltered)} typed=${JSON.stringify(typed)} ` +
              `arrived=${JSON.stringify(arrived)} back=${JSON.stringify(back)}`,
          );

          expect(typed.rows, "the filter narrowed the list it was typed in").toBeLessThan(
            unfiltered.rows,
          );
          expect(arrived, "the newly mounted card filters the same way").toEqual(typed);
          expect(back, "the card mounted behind the switch dropped the filter too").toEqual(
            unfiltered,
          );
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
