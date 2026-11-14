/**
 * row-03-departure-kinds.test.ts — every other kind that is a body departs
 * as one piece through File › Close Card, and the hole closes with it.
 *
 * A piece of row 3 ([B02] row 3; the row is `_row-03.ts`'s), a test to a
 * file so each launch fits its own budget: a card of each other kind,
 * standing focused beside an unbound Session card, closed the menu's way.
 *
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/HostFrameMeter.swift
 * @family row-03-departure
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "../_harness";
import { floorMeasure, settleFor } from "./_frames";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { kindsUnderTest } from "./_kinds";
import { NEIGHBOUR, PLACED_MS, SHOULD_RUN, TEST_NAME, TEST_TIMEOUT_MS, departLeg } from "./_row-03";

describe.skipIf(!SHOULD_RUN)("body-grounding row 3: departure", () => {
  for (const kind of kindsUnderTest(3)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: File › Close Card: the hole closes in the frame the chrome leaves, and no frame shows the bare window`,
      async () => {
        const card = `row03-${kind.componentId}`;
        const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}` });
        try {
          await app.seedDeckState({ state: kindDeck(kind, card, { sessions: [NEIGHBOUR] }), focusCardId: card });
          await standUpKind(app, kind, card);
          await app.dispatchControlAction("focus-session-card", { cardId: card });
          const key = await settleFor(() => app.evalJS<string | null>("window.__tug.getActiveCardId()"), (id) => id === card, PLACED_MS);
          expect(key, `the ${kind.componentId} card is the key card`).toBe(card);
          await Bun.sleep(400);
          await departLeg(app, card, floorMeasure(kind.rail));
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
