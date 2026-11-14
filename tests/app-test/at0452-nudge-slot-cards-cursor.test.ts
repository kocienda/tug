/**
 * at0452-nudge-slot-cards-cursor.test.ts — the nudge chord reaches the handler
 * with the keyboard in the Cards card, and moves the cursor row.
 *
 * One of the at0452-nudge-slot split, a test to a file so each launch fits its
 * own budget. This file drives the Cards list's cursor rung of the selection
 * ladder; `at0452-nudge-slot-edges` drives the first-responder and explicit
 * selection rungs. Why the nudge is all-or-nothing, and the shared deck, chord
 * and readers, are `nudge-slot-fixture.ts`.
 *
 * @covers tugdeck/src/layout-imposition.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/lib/action-vocabulary.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/layout-selection.ts
 * @family at0452-nudge-slot
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  AFTER_LAND_MS,
  FRAMES,
  NUDGE,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  cursorTitle,
  deckShape,
  focusCardsList,
  seedRailPreferred,
  setSelection,
  slotsByCard,
  wait,
  walkCursorTo,
} from "./nudge-slot-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0452 — the nudge moves the layout selection one slot, or none of it",
  () => {
    test(
      "the chord reaches the handler with the keyboard in the Cards card",
      async () => {
        const app = await launchTugApp({ testName: "at0452-nudge-cards" });
        try {
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          await setSelection(app, []);

          // With the keyboard in the Cards list the first responder is the Cards card
          // — a rail, which has no slot. Read through the first responder alone
          // this refuses; read through the ladder's cursor rung it moves the row
          // the caret is standing on, which is the whole reason the rung exists.
          await focusCardsList(app);
          await walkCursorTo(app, "Card C");
          expect(
            await cursorTitle(app),
            "the caret is on the row about to move",
          ).toContain("Card C");
          // The list moves its cursor in the Cards card's page, and the nudge
          // is answered in the shell's: the cursor has to have reached it.
          await app.waitForCondition<boolean>(
            `window.__tug.getLayoutCursor() === "C"`,
            { timeoutMs: 2_000 },
          );

          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          const slots = await slotsByCard(app);
          expect(
            slots.C,
            "the cursor row nudged left while the Cards card held the keyboard",
          ).toBe(1);
          expect(slots.A, "and nothing else moved").toBe(0);
          expect(slots.B, "nothing at all").toBe(1);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
