/**
 * at0571-picker-card-arrival-open-slot.test.ts — with an empty slot beside
 * the split, a Session card opens there instead, picker and all.
 *
 * One piece of the at0571 split, a test to a file so each launch fits its own
 * budget; the deck shapes, the frame census and the trace readings are
 * `picker-card-arrival-fixture.ts`. Why an arrival is two motions, and the
 * divided case this one is the ordinary-deck counterpart of, are
 * `at0571-picker-card-arrival-divided`.
 *
 * `session-card.tsx`, where the picker is raised, stands at its recorded
 * fan-out and is deliberately not named; `card-lifecycle.ts` owns the channel
 * the picker's presentation rides, so an edit that changes when a card is
 * said to have activated selects this file through it.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/fold.ts
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/lib/settle-notice.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/opening-placement.ts
 * @family at0571-picker-card-arrival
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import {
  AFTER_LAND_MS,
  PICKER_FORM,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  addSessionCard,
  launchArrivalApp,
  openDeckShape,
  removeArrivalPickerSessions,
  seedArrivalPickerSessions,
  wait,
} from "./picker-card-arrival-fixture";

beforeAll(seedArrivalPickerSessions);
afterAll(removeArrivalPickerSessions);

describe.skipIf(!SHOULD_RUN)("AT0571: the divided arrival", () => {
  test(
    "with an empty slot beside the split, the card opens there instead",
    async () => {
      const app = await launchArrivalApp("at0571-open-slot");
      try {
        await app.seedDeckState({ state: openDeckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        await app.evalJS<null>(`(${addSessionCard}, null)`);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getDeckState().cards.some(function (c) {
            return c.componentId === "session";
          })`,
          { timeoutMs: 8_000 },
        );
        const placed = await app.evalJS<{ paneId: string; cardId: string; slot: number | null }>(
          `(function () {
            var state = window.tugdeck.diag.getDeckState();
            var card = state.cards.filter(function (c) {
              return c.componentId === "session";
            })[0];
            var pane = state.panes.filter(function (p) {
              return p.cardIds.indexOf(card.id) !== -1;
            })[0];
            return { paneId: pane.id, cardId: card.id, slot: pane.slot === undefined ? null : pane.slot };
          })()`,
        );
        note("open slot", JSON.stringify(placed));
        expect(
          placed.slot,
          "the empty slot beside the focused card's split, never the split itself",
        ).toBe(1);

        // It still rides in on its picker: the arrival is the same one, only
        // somewhere better. The picker is in the body of the card that pane
        // holds.
        const placedBody = await waitForBodyReady(app, placed.cardId);
        await placedBody.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // The split slot was not joined: its one member is still its only one.
        expect(
          await app.evalJS<number>(
            `window.tugdeck.diag.getDeckState().panes.filter(function (p) {
              return p.slot === 0;
            }).length`,
          ),
          "the split at slot 0 took no newcomer",
        ).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
