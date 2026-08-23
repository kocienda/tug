/**
 * at0470-slot-window.test.ts — a Lens row states its place through a window.
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
 *   2. **The held slot is the CENTRE, on every row.** Not "somewhere in the
 *      window": the middle position exactly, so a column of rows puts every
 *      answer on one vertical. That is the whole reason the window does not
 *      slide to stay full.
 *   3. **The overhang is a stub, and the stub holds its ground.** A card in
 *      slot 1 has no left neighbour, and the position where one would be is
 *      drawn as an inert stub rather than collapsed — collapsing it would
 *      slide the centre by a chip and break the vertical for that row alone.
 *   4. **A neighbour is a one-place move.** Pressing the chip right of centre
 *      moves the card there, and the window follows it.
 *   5. **The centre is the door to the rest.** Pressing the held chip opens
 *      the whole run as a popup — the surface a reader reaches a place the
 *      window does not show through, and the same one the card's own masthead
 *      badge opens.
 *
 * Read from live geometry and `data-` attributes. Nothing here reads back a
 * declared style value.
 *
 * @covers tugdeck/src/components/lens/slot-picker.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.css
 * @covers tugdeck/src/lib/slot-window-pref.ts
 * @covers tugdeck/src/components/lens/sections/layouts-section.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const LENS_WIDTH = 460;
const PANE_WIDTH = 400;
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const PICKER = '[data-testid="lens-slot-picker"]';
const JUMP = '[data-testid="lens-slot-picker-jump"]';
const WINDOW_ROW = '[data-testid="lens-layouts-slot-window"]';

/** What one row's window is drawing, left to right. */
interface WindowFacts {
  /** Every drawn position: a slot's numeral, or `null` for a stub. */
  positions: (string | null)[];
  /** Which position carries the lit chip, or -1 when none does. */
  litAt: number;
  /** The centre chip's horizontal midpoint, for the vertical claim. */
  centreX: number;
}

/**
 * Six-up with the Lens on the right and three cards spread across the run —
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
      { id: "L", componentId: "lens", title: "Lens", closable: true },
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
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "six-up", sidebars: { lens: { side: "right" } } },
    hasFocus: true,
  };
}

async function openDeck(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
  );
  // The window width is a PERSISTED preference, deck-wide and machine-global,
  // which is exactly what it is meant to be — and exactly why it has to be
  // stated here. Left ambient, the last test to widen it would set the
  // starting width of the first test of the next run, and this file would pass
  // once and fail forever after on a claim about the deck rather than about
  // itself.
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "slotWindow", { kind: "i64", value: 3 }), null)`,
  );
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** Every row's window, in the Lens's own order. */
async function windows(app: App): Promise<WindowFacts[]> {
  return app.evalJS<WindowFacts[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(PICKER)}),
       function (run) {
         var drawn = Array.prototype.slice.call(run.children);
         var litAt = -1;
         var centre = null;
         var positions = drawn.map(function (el, i) {
           var isStub = el.classList.contains("tug-slot-layout-stub");
           var state = el.getAttribute("data-state");
           if (state === "filled" || state === "outlined") litAt = i;
           if (i === Math.floor(drawn.length / 2)) centre = el;
           return isStub ? null : el.textContent.trim();
         });
         var box = centre.getBoundingClientRect();
         return {
           positions: positions,
           litAt: litAt,
           centreX: Math.round(box.left + box.width / 2),
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

describe.skipIf(!SHOULD_RUN)("at0470 — the Lens row's slot window", () => {
  test(
    "three positions per row, the held slot centred, the overhang stubbed",
    async () => {
      const app = await launchTugApp({ testName: "at0470-slot-window" });
      try {
        await openDeck(app);
        const rows = await windows(app);
        note(
          `windows: ${rows
            .map((r) => `[${r.positions.map((p) => p ?? "·").join(" ")}]@${r.centreX}`)
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

        // The centre is the answer, on every row without exception.
        for (const row of rows) {
          expect(
            row.litAt,
            "the held slot is the middle position",
          ).toBe(1);
        }

        // ...which means one vertical serves the whole column. This is the
        // claim a sliding window would break, and it is checked as geometry
        // rather than as index arithmetic because alignment is what the reader
        // actually gets.
        const xs = new Set(rows.map((r) => r.centreX));
        expect(
          xs.size,
          `every row's centre chip stands on one vertical (saw ${[...xs].join(", ")})`,
        ).toBe(1);

        // Card A holds slot 1 of 6, so its left neighbour does not exist. The
        // position is drawn and empty rather than absent — that is what keeps
        // its centre on the vertical above.
        const head = rows.find((r) => r.positions[1] === "1");
        expect(head, "a row for the card in slot 1").toBeDefined();
        expect(
          head?.positions[0],
          "the position past the head of the run is a stub, not a missing chip",
        ).toBeNull();
        expect(
          head?.positions[2],
          "and the real neighbour is still drawn beside it",
        ).toBe("2");

        // The same at the far end: card C holds slot 6 of 6.
        const tail = rows.find((r) => r.positions[1] === "6");
        expect(tail, "a row for the card in slot 6").toBeDefined();
        expect(
          tail?.positions[2],
          "the position past the tail is a stub too",
        ).toBeNull();
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a neighbour moves the card one place, and the window follows",
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
            .map((r) => `[${r.positions.map((p) => p ?? "·").join(" ")}]`)
            .join(" ")}`,
        );
        const moved = after[row];
        expect(
          moved?.positions[1],
          "the card is one place along",
        ).toBe("4");
        expect(
          moved?.litAt,
          "and the window has followed it, so the answer is still centred",
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
    "the centre opens the whole run, and a place the window cannot show is reachable there",
    async () => {
      const app = await launchTugApp({ testName: "at0470-slot-window" });
      try {
        await openDeck(app);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(JUMP)}).length`,
          ),
          "nothing is open until the centre is pressed",
        ).toBe(0);

        const rows = await windows(app);
        const row = rows.findIndex((r) => r.positions[1] === "1");
        // The card is in slot 1 and its window reaches slot 2. Slot 5 is the
        // case the door exists for.
        await pressPosition(app, row, 1);
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
            .map((r) => `[${r.positions.map((p) => p ?? "·").join(" ")}]`)
            .join(" ")}`,
        );
        expect(
          after[row]?.positions[1],
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
    "the Layout section's Slot Window row is what sets the width",
    async () => {
      const app = await launchTugApp({ testName: "at0470-slot-window" });
      try {
        await openDeck(app);
        expect(
          (await windows(app))[0]?.positions.length,
          "three to begin with",
        ).toBe(3);

        // The row is a segmented group of two; the second segment is 5.
        await app.evalJS<boolean>(
          `(function () {
             var group = document.querySelector(${JSON.stringify(WINDOW_ROW)});
             var five = Array.prototype.filter.call(
               group.querySelectorAll("button"),
               function (b) { return b.textContent.trim() === "5"; },
             )[0];
             five.click();
             return true;
           })()`,
        );
        await wait(700);

        const wide = await windows(app);
        note(
          `at five: ${wide
            .map((r) => `[${r.positions.map((p) => p ?? "·").join(" ")}]`)
            .join(" ")}`,
        );
        for (const row of wide) {
          expect(row.positions.length, "every row widened together").toBe(5);
          expect(row.litAt, "and the held slot is still the middle").toBe(2);
        }

        // Card A holds slot 1, so a five-wide window overhangs the head by two
        // — both drawn, both empty.
        const head = wide.find((r) => r.positions[2] === "1");
        expect(
          head?.positions.slice(0, 2),
          "a five-wide window stubs both positions past the head",
        ).toEqual([null, null]);
        expect(
          head?.positions.slice(3),
          "and draws the two real neighbours after it",
        ).toEqual(["2", "3"]);

        // Put it back. The preference is machine-global and outlives the app,
        // so a file that widens it and walks away sets the starting width for
        // every other test that renders a Lens row.
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "slotWindow", { kind: "i64", value: 3 }), null)`,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
