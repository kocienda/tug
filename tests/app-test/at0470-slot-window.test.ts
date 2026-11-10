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
 *   6. **A selected row moves its whole selection.** With several cards
 *      selected in the Cards list, pressing a chip on one of their rows sends
 *      every selected card to that place; a row outside the selection still
 *      moves only its own card.
 *
 * Read from live geometry and `data-` attributes. Nothing here reads back a
 * declared style value.
 *
 * Points 1 to 4's first cases run here; the run popup, the selection move and
 * the rest run in `at0470-slot-window-moves.test.ts`, and the deck and the
 * row reads both files use are `slot-window-fixture.ts`. The split keeps each
 * file under the 20 s file budget.
 *
 * @covers tugdeck/src/components/cards/slot-picker.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.css
 * @covers tugdeck/src/lib/slot-window-pref.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @family at0470
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  launchSlotWindowApp,
  openDeck,
  pressPosition,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  cleanUpSlotWindowTugbanks,
  windows,
} from "./slot-window-fixture";

cleanUpSlotWindowTugbanks();

describe.skipIf(!SHOULD_RUN)("at0470 — the Cards row's slot window", () => {
  test(
    "three real places per row, centred where it can be and slid where it cannot",
    async () => {
      const app = await launchSlotWindowApp();
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
      const app = await launchSlotWindowApp();
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
});
