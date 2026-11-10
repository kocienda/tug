/**
 * at0470-slot-window-moves.test.ts — the second half of at0470, whose claim
 * and first half are `at0470-slot-window.test.ts`: pressing a Cards row's
 * window moves the card, the card's own chip opens the whole run, and a
 * selected row moves its whole selection. The deck and the row reads are
 * `slot-window-fixture.ts`; the split keeps each file under the 20 s file
 * budget.
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
  JUMP,
  launchSlotWindowApp,
  openDeck,
  pressPosition,
  SHOULD_RUN,
  slotsByCard,
  TEST_TIMEOUT_MS,
  cleanUpSlotWindowTugbanks,
  wait,
  windows,
} from "./slot-window-fixture";

cleanUpSlotWindowTugbanks();

describe.skipIf(!SHOULD_RUN)("at0470 — the Cards row's slot window", () => {
  test(
    "the card's own chip opens the whole run, and a place the window cannot show is reachable there",
    async () => {
      const app = await launchSlotWindowApp();
      try {
        await openDeck(app);
        expect(
          await app.body("L").evalJS<number>(
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
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JUMP)}) !== null`,
          { timeoutMs: 8_000 },
        );

        const run = await app.body("L").evalJS<string[]>(
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

        await app.body("L").evalJS<boolean>(
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
          await app.body("L").evalJS<number>(
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
    "a chip on a selected row moves every selected card, and a row outside the selection moves only its own",
    async () => {
      const app = await launchSlotWindowApp();
      try {
        await openDeck(app);
        // A (slot 1) and C (slot 6) selected; B (slot 3) left out.
        await app.evalJS<null>(
          `(window.__tug.setLayoutSelection(["A", "C"]), null)`,
        );
        await wait(300);

        const rows = await windows(app);
        const row = rows.findIndex((r) => r.positions[0] === "1" && r.litAt === 0);
        expect(row, "a row for card A in slot 1").toBeGreaterThanOrEqual(0);
        // A's window is [1 2 3]; the chip saying 2 is a move, not the door.
        await pressPosition(app, row, 1);

        const grouped = await slotsByCard(app);
        note(`after the group move: ${JSON.stringify(grouped)}`);
        expect(grouped.A, "the pressed row's card went to position 2").toBe(1);
        expect(grouped.C, "and so did the other selected card").toBe(1);
        expect(grouped.B, "the unselected card stayed where it was").toBe(2);

        // B's row is outside the selection: its press is B's alone.
        const after = await windows(app);
        const bRow = after.findIndex(
          (r) => r.litAt >= 0 && r.positions[r.litAt] === "3",
        );
        expect(bRow, "a row for card B in slot 3").toBeGreaterThanOrEqual(0);
        const fourAt = after[bRow]?.positions.indexOf("4") ?? -1;
        expect(fourAt, "B's window shows position 4").toBeGreaterThanOrEqual(0);
        await pressPosition(app, bRow, fourAt);

        const single = await slotsByCard(app);
        note(`after the single move: ${JSON.stringify(single)}`);
        expect(single.B, "B moved to position 4").toBe(3);
        expect(single.A, "A did not follow it").toBe(1);
        expect(single.C, "nor did C").toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the `set-slot-window` action is what sets the width",
    async () => {
      const app = await launchSlotWindowApp();
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
          `(window.__tug.setTugbankValue("dev.tugapp.slot-window", "slotWindow", { kind: "i64", value: 3 }), null)`,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
