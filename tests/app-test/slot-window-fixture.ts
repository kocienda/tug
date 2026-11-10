/**
 * slot-window-fixture.ts — what the two halves of at0470 share: the six-up
 * deck, the seeded slot-window preference, and the reads and presses on a
 * Cards row's window. The claim and the cases are in
 * `at0470-slot-window.test.ts` (the window's width and its slide) and
 * `at0470-slot-window-moves.test.ts` (a press moves a card, opens the run,
 * or moves the selection), split so neither file crosses the 20 s file
 * budget.
 */

import { afterAll } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { mkSeededTugbank, rmTempTugbank } from "./_harness/tugbank-helpers";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

/**
 * The window width is a PERSISTED preference, deck-wide and machine-global,
 * which is exactly what it is meant to be — and exactly why it has to be
 * stated here. Left ambient, the last test to widen it would set the starting
 * width of the first test of the next run, and this file would pass once and
 * fail forever after on a claim about the deck rather than about itself.
 *
 * It is stated in the tugbank the app opens, which reaches every page: the
 * rows draw in the Cards card's body, and a page-local cache write there
 * would also outrank the server's answer to the `set-slot-window` PUT, whose
 * domain generation it had already spent.
 */
const tugbanks: string[] = [];
export async function launchSlotWindowApp(): Promise<App> {
  const tugbank = mkSeededTugbank([
    { domain: "dev.tugapp.slot-window", key: "slotWindow", type: "int", value: "3" },
  ]);
  tugbanks.push(tugbank);
  return launchTugApp({ testName: "at0470-slot-window", env: { TUGBANK_PATH: tugbank } });
}
/** Remove the seeded tugbanks once the importing file's cases are done. */
export function cleanUpSlotWindowTugbanks(): void {
  afterAll(() => {
    for (const tugbank of tugbanks.splice(0)) rmTempTugbank(tugbank);
  });
}
export const TEST_TIMEOUT_MS = 120_000;

export const CARDS_WIDTH = 460;
export const PANE_WIDTH = 400;
export const AFTER_LAND_MS = 900;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export const PICKER = '[data-testid="cards-slot-picker"]';
export const JUMP = '[data-testid="cards-slot-picker-jump"]';

/** What one row's window is drawing, left to right. */
export interface WindowFacts {
  /** Every drawn chip's numeral. */
  positions: string[];
  /** Which position carries the lit chip, or -1 when none does. */
  litAt: number;
  /** The run's own trailing edge — the vertical the coordinate ends on. */
  runRight: number;
}

/**
 * Six-up with the Cards card on the right and three cards spread across the run —
 * one at each end and one in the middle, which is what makes the stub claim
 * and the alignment claim readable in a single deck.
 */
export function deckShape() {
  const members: [string, number, string][] = [
    ["p1", 0, "A"],
    ["p2", 2, "B"],
    ["p3", 5, "C"],
  ];
  return {
    cards: [
      ...members.map(([, , cardId]) => ({
        id: cardId,
        componentId: "hello",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "L", componentId: "cards", title: "Cards", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => ({
        id,
        position: { x: 40, y: 40 },
        size: { width: PANE_WIDTH, height: 400 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
        slot,
      })),
      {
        id: "pCards",
        position: { x: 0, y: 0 },
        size: { width: CARDS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Cards",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "six-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  };
}

export async function openDeck(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.cards", "widthPx", { kind: "i64", value: ${CARDS_WIDTH} }), null)`,
  );
  // The window width starts at three, from the tugbank the app was launched
  // on (`launchSlotWindowApp`).
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.body("L").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await app.body("L").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER)}).children.length === 3`,
    { timeoutMs: 4_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** Every row's window, in the Cards card's own order. */
export async function windows(app: App): Promise<WindowFacts[]> {
  return app.body("L").evalJS<WindowFacts[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(PICKER)}),
       function (run) {
         var drawn = Array.prototype.slice.call(run.children);
         var litAt = -1;
         var positions = drawn.map(function (el, i) {
           var state = el.getAttribute("data-state");
           if (state === "filled" || state === "outlined") litAt = i;
           return el.textContent.trim();
         });
         return {
           positions: positions,
           litAt: litAt,
           runRight: Math.round(run.getBoundingClientRect().right),
         };
       },
     )`,
  );
}

/** Press one of a row's drawn positions. */
export async function pressPosition(
  app: App,
  row: number,
  position: number,
): Promise<void> {
  const selector =
    `document.querySelectorAll(${JSON.stringify(PICKER)})[${row}]` +
    `.children[${position}]`;
  await app.body("L").evalJS<boolean>(`(function () { ${selector}.click(); return true; })()`);
  await wait(500);
}

/** Every card's slot, read off the deck rather than off the rows. */
export async function slotsByCard(app: App): Promise<Record<string, number | null>> {
  return app.evalJS<Record<string, number | null>>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      var out = {};
      for (var i = 0; i < deck.panes.length; i += 1) {
        var pane = deck.panes[i];
        for (var j = 0; j < pane.cardIds.length; j += 1) {
          out[pane.cardIds[j]] = pane.slot === undefined ? null : pane.slot;
        }
      }
      return out;
    })()`,
  );
}

