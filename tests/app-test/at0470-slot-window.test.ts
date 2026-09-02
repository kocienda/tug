/**
 * at0470-slot-window.test.ts — a Cards row states its place through a window.
 *
 * A row used to draw the whole imposition: one chip per slot, the held one
 * lit. That encoded position geometrically — find the lit chip in the ruler —
 * and cost a chip per place on EVERY row, which made a row's width a function
 * of the deck's slot count. Six already crowded the rail and the design had no
 * answer for eight, so the count was the thing that had to stay small.
 *
 * The window states position in the numeral instead, with the neighbours
 * giving the local run, and costs the same at three places as at ten.
 *
 * What this file pins:
 *
 *   1. **The window is the preference's width, not the deck's.** A six-up deck
 *      draws three positions per row at the default, and five when the reader
 *      asks for five — and the count of drawn positions does not move when the
 *      imposition grows.
 *   2. **Every chip names a real place.** The window prefers to centre on the
 *      card's own slot and SLIDES off centre at the ends of the run rather
 *      than reaching past it — a card in the first place draws the first N
 *      slots with its own at the left. An earlier cut held the centre and drew
 *      the overhang as a dashed stub; the stubs read as damage.
 *   3. **The run still ends on one vertical.** Which is the alignment that
 *      actually matters, and it survives the slide for a reason worth pinning:
 *      the count is the DECK's, so every row draws the same number of chips
 *      and the coordinate ends at one offset whether or not the lit chip does.
 *   4. **A chip that is not the card's own is a one-place move.** Pressing it
 *      moves the card there, and the window follows.
 *   5. **The card's own chip is the door to the rest.** Pressing where a card
 *      already stands is not a move, so the press opens the whole run as a
 *      popup — how a reader reaches a place the window does not show, and the
 *      same surface the card's own masthead badge opens.
 *
 * Read from live geometry and `data-` attributes. Nothing here reads back a
 * declared style value.
 *
 * @covers tugdeck/src/components/cards/slot-picker.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.css
 * @covers tugdeck/src/lib/slot-window-pref.ts
 * @covers tugdeck/src/action-dispatch.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARDS_WIDTH = 460;
const PANE_WIDTH = 400;
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const PICKER = '[data-testid="cards-slot-picker"]';
const JUMP = '[data-testid="cards-slot-picker-jump"]';

/** What one row's window is drawing, left to right. */
interface WindowFacts {
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
function deckShape() {
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

async function openDeck(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.cards", "widthPx", { kind: "i64", value: ${CARDS_WIDTH} }), null)`,
  );
  // The window width is a PERSISTED preference, deck-wide and machine-global,
  // which is exactly what it is meant to be — and exactly why it has to be
  // stated here. Left ambient, the last test to widen it would set the
  // starting width of the first test of the next run, and this file would pass
  // once and fail forever after on a claim about the deck rather than about
  // itself.
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.slot-window", "slotWindow", { kind: "i64", value: 3 }), null)`,
  );
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** Every row's window, in the Cards card's own order. */
async function windows(app: App): Promise<WindowFacts[]> {
  return app.evalJS<WindowFacts[]>(
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
async function pressPosition(
  app: App,
  row: number,
  position: number,
): Promise<void> {
  const selector =
    `document.querySelectorAll(${JSON.stringify(PICKER)})[${row}]` +
    `.children[${position}]`;
  await app.evalJS<boolean>(`(function () { ${selector}.click(); return true; })()`);
  await wait(500);
}

describe.skipIf(!SHOULD_RUN)("at0470 — the Cards row's slot window", () => {
  test(
    "three real places per row, centred where it can be and slid where it cannot",
    async () => {
      const app = await launchTugApp({ testName: "at0470-slot-window" });
      try {
        await openDeck(app);
        const rows = await windows(app);
        note(
          `windows: ${rows
            .map((r) => `[${r.positions.join(" ")}]lit@${r.litAt} right=${r.runRight}`)
            .join(" ")}`,
        );

        // Six-up, and every row is three wide. The deck's slot count is not
        // what a row costs any more, which is the whole point of the change.
        for (const row of rows) {
          expect(
            row.positions.length,
            "a row draws the window's width, not the deck's",
          ).toBe(3);
        }

        // Every drawn position is a place a card can actually be put. The
        // window reaches past neither end of the run.
        for (const row of rows) {
          for (const chip of row.positions) {
            expect(chip, "every chip names a real slot").toMatch(/^[1-6]$/);
          }
          expect(
            row.litAt,
            "and each row's own place is one of them",
          ).toBeGreaterThanOrEqual(0);
        }

        // Card B holds slot 3, with room either side, so its window centres.
        const middle = rows.find((r) => r.litAt === 1);
        expect(middle?.positions, "a card with room either side is centred").toEqual([
          "2",
          "3",
          "4",
        ]);

        // Card A holds slot 1 — no left neighbour to draw, so the window
        // slides rather than overhanging, and its own chip sits at the left.
        const head = rows.find((r) => r.positions[0] === "1");
        expect(head, "a row for the card in slot 1").toBeDefined();
        expect(
          head?.positions,
          "at the head the window slides right rather than reaching past the run",
        ).toEqual(["1", "2", "3"]);
        expect(head?.litAt, "with the card's own place at the left").toBe(0);

        // The same at the far end: card C holds slot 6 of 6.
        const tail = rows.find((r) => r.positions[2] === "6");
        expect(tail, "a row for the card in slot 6").toBeDefined();
        expect(
          tail?.positions,
          "at the tail it slides left, for the same reason",
        ).toEqual(["4", "5", "6"]);
        expect(tail?.litAt, "with the card's own place at the right").toBe(2);

        // The alignment that survives the slide, and the one that matters: the
        // run's own trailing edge, which is where the coordinate ends. It holds
        // because the count is the DECK's — every row draws the same number of
        // chips — so the eye still lands on one vertical down the column.
        const edges = new Set(rows.map((r) => r.runRight));
        expect(
          edges.size,
          `every row's run ends on one vertical (saw ${[...edges].join(", ")})`,
        ).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a chip that is not the card's own moves it there, and the window follows",
    async () => {
      const app = await launchTugApp({ testName: "at0470-slot-window" });
      try {
        await openDeck(app);
        const before = await windows(app);
        const row = before.findIndex((r) => r.positions[1] === "3");
        expect(row, "a row for the card in slot 3").toBeGreaterThanOrEqual(0);

        // The chip right of centre says 4, and pressing it means "go there".
        await pressPosition(app, row, 2);

        const after = await windows(app);
        note(
          `after the nudge: ${after
            .map((r) => `[${r.positions.join(" ")}]lit@${r.litAt}`)
            .join(" ")}`,
        );
        const moved = after[row];
        expect(
          moved?.positions[moved.litAt],
          "the card is one place along",
        ).toBe("4");
        expect(
          moved?.litAt,
          "and the window followed it, so it is centred again",
        ).toBe(1);
        expect(
          moved?.positions,
          "with its new neighbours drawn either side",
        ).toEqual(["3", "4", "5"]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the card's own chip opens the whole run, and a place the window cannot show is reachable there",
    async () => {
      const app = await launchTugApp({ testName: "at0470-slot-window" });
      try {
        await openDeck(app);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(JUMP)}).length`,
          ),
          "nothing is open until the card's own chip is pressed",
        ).toBe(0);

        const rows = await windows(app);
        const row = rows.findIndex((r) => r.positions[0] === "1" && r.litAt === 0);
        expect(row, "a row for the card in slot 1").toBeGreaterThanOrEqual(0);
        // The card is in slot 1 and its window reaches slot 3. Slot 5 is the
        // case the door exists for.
        await pressPosition(app, row, 0);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JUMP)}) !== null`,
          { timeoutMs: 8_000 },
        );

        const run = await app.evalJS<string[]>(
          `Array.prototype.map.call(
             document.querySelectorAll(
               ${JSON.stringify(JUMP)} + ' [data-slot="tug-slot"]'
             ),
             function (el) { return el.textContent.trim(); },
           )`,
        );
        note(`jump popup offers: ${run.join(" ")}`);
        expect(
          run,
          "the popup is the WHOLE arrangement — that is what it is for",
        ).toEqual(["1", "2", "3", "4", "5", "6"]);

        await app.evalJS<boolean>(
          `(function () {
             var chips = document.querySelectorAll(
               ${JSON.stringify(JUMP)} + ' [data-slot="tug-slot"]'
             );
             chips[4].click();
             return true;
           })()`,
        );
        await wait(600);

        const after = await windows(app);
        note(
          `after the jump: ${after
            .map((r) => `[${r.positions.join(" ")}]lit@${r.litAt}`)
            .join(" ")}`,
        );
        const landed = after[row];
        expect(
          landed === undefined ? undefined : landed.positions[landed.litAt],
          "the card landed where the popup said, four places from where it stood",
        ).toBe("5");
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(JUMP)}).length`,
          ),
          "and the popup closed in the same act that moved it",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the `set-slot-window` action is what sets the width",
    async () => {
      const app = await launchTugApp({ testName: "at0470-slot-window" });
      try {
        await openDeck(app);
        expect(
          (await windows(app))[0]?.positions.length,
          "three to begin with",
        ).toBe(3);

        // Driven through the action, which is the whole of the switch now. The
        // Layout section carried a Slot Window row for a while and no longer
        // does — the window settled at five, and a row asking the reader to
        // choose sat oddly in a section otherwise entirely about the deck. The
        // preference and the action outlived it, so the width is still a thing
        // that changes and this is still the path it changes by.
        await app.dispatchControlAction("set-slot-window", { size: 5 });
        await wait(700);

        const wide = await windows(app);
        note(
          `at five: ${wide
            .map((r) => `[${r.positions.join(" ")}]lit@${r.litAt}`)
            .join(" ")}`,
        );
        for (const row of wide) {
          expect(row.positions.length, "every row widened together").toBe(5);
          for (const chip of row.positions) {
            expect(chip, "and every chip still names a real slot").toMatch(/^[1-6]$/);
          }
        }

        // Card A holds slot 1, so a five-wide window on a six-up deck slides
        // all the way to the head rather than reaching two places past it.
        const head = wide.find((r) => r.litAt === 0);
        expect(
          head?.positions,
          "at the head a five-wide window shows the run's first five places",
        ).toEqual(["1", "2", "3", "4", "5"]);

        // Put it back. The preference is machine-global and outlives the app,
        // so a file that widens it and walks away sets the starting width for
        // every other test that renders a Cards row.
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.slot-window", "slotWindow", { kind: "i64", value: 3 }), null)`,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
