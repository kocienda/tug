/**
 * at0846-go-back-switch-arrival.test.ts — the card a workspace switch arrives
 * on does not stand between the card the reader left and the card they then
 * pick.
 *
 * A switch puts the keyboard on the arriving workspace's remembered card,
 * which the reader did not choose. The trail holds that arrival
 * provisionally: picking another card in the workspace replaces it. Kept as
 * a visit, it sat behind the picked card, and Back from the picked card went
 * to the arrival — a neighbour the reader never activated, in the same
 * workspace — and only a second Back crossed.
 *
 * The walk is the app's own doors: a click into a card's page, the Window
 * menu's workspace row, another click, and the Back chord.
 *
 * @covers tugdeck/src/lib/focus-trail.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const SPACE_ONE = "space-one";
const SPACE_TWO = "space-two";

/** The Window menu's row for the second workspace. */
const ROW_TWO = "window.space.1";

function textCard(id: string) {
  return { id, componentId: "text", title: `File ${id}`, closable: true };
}

function pane(id: string, slot: number, cardId: string) {
  return {
    id,
    position: { x: 40 + slot * 520, y: 40 },
    size: { width: 500, height: 500 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
    slot,
  };
}

function deckOf(first: string, second: string, hasFocus: boolean) {
  return {
    cards: [textCard(first), textCard(second)],
    panes: [pane(`p-${first}`, 0, first), pane(`p-${second}`, 1, second)],
    activePaneId: `p-${first}`,
    imposition: { kind: "two-up", sidebars: {} },
    ...(hasFocus ? { hasFocus: true } : {}),
  };
}

/** Main holds A and B and is shown; Second holds C and D and is parked. */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    { id: SPACE_ONE, name: "Main", deck: deckOf("A", "B", true) },
    { id: SPACE_TWO, name: "Second", deck: deckOf("C", "D", false) },
  ],
};

async function expectHere(app: App, spaceId: string, cardId: string): Promise<void> {
  try {
    await app.waitForCondition<boolean>(
      `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId)} &&
       window.__tug.getActiveCardId() === ${JSON.stringify(cardId)}`,
      { timeoutMs: 6_000 },
    );
  } catch (error) {
    const seen = await app.evalJS<string>(
      `window.tugdeck.diag.getSpaces().activeSpaceId + " / " + window.__tug.getActiveCardId()`,
    );
    throw new Error(`expected ${spaceId} / ${cardId}, the deck is at ${seen}`, { cause: error });
  }
}

/** A real click inside a card's own page. */
async function clickInto(app: App, cardId: string): Promise<void> {
  const selector = `[data-card-id="${cardId}"]`;
  await app.body(cardId).waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await app.body(cardId).nativeClickAtElement(selector);
}

describe.skipIf(!SHOULD_RUN)("at0846 — Back past the card a switch arrived on", () => {
  test(
    "after a switch and a pick, Back crosses to the card left behind on the first press",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(TWO_SPACE_BLOB));
      const app = await launchTugApp({
        testName: "at0846-go-back-switch-arrival",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 10_000 },
        );
        await expectHere(app, SPACE_ONE, "A");
        await clickInto(app, "B");
        await expectHere(app, SPACE_ONE, "B");

        // The switch arrives on C, the card Second stands on: the reader
        // picked the workspace, not the card.
        await app.performMenuItem(ROW_TWO);
        await expectHere(app, SPACE_TWO, "C");

        // The reader's own pick in the arriving workspace.
        await clickInto(app, "D");
        await expectHere(app, SPACE_TWO, "D");

        // Back is the card they were on before D by their own choosing: B,
        // across the boundary, with no stop on C.
        await app.nativeKey("[", ["cmd", "alt", "shift"]);
        await expectHere(app, SPACE_ONE, "B");

        // And Forward retraces to the pick.
        await app.nativeKey("]", ["cmd", "alt", "shift"]);
        await expectHere(app, SPACE_TWO, "D");
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
