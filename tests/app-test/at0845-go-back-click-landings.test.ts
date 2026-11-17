/**
 * at0845-go-back-click-landings.test.ts — Go ▸ Back returns to the card the
 * reader last clicked into, when every landing was a click inside a card.
 *
 * at0841 walks the trail with the lateral ring chord and the Window menu's
 * workspace row, which are the shell's own doors. A hand mostly moves by
 * clicking into a card's editor, which lands in that card's own page, and
 * that is the walk this file takes.
 *
 * @covers tugdeck/src/lib/focus-trail.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/body-command-route.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

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

const ONE_SPACE_BLOB = {
  version: 5,
  activeSpaceId: "space-one",
  spaces: [
    {
      id: "space-one",
      name: "Main",
      deck: {
        cards: [textCard("A"), textCard("B")],
        panes: [pane("p-A", 0, "A"), pane("p-B", 1, "B")],
        activePaneId: "p-A",
        imposition: { kind: "two-up", sidebars: {} },
        hasFocus: true,
      },
    },
  ],
};

const EDITOR = (id: string) => `[data-card-id="${id}"]`;

async function activeCard(app: App): Promise<string | null> {
  return app.evalJS<string | null>(`window.__tug.getActiveCardId()`);
}

async function expectActive(app: App, cardId: string, what: string): Promise<void> {
  try {
    await app.waitForCondition<boolean>(
      `window.__tug.getActiveCardId() === ${JSON.stringify(cardId)}`,
      { timeoutMs: 4_000 },
    );
  } catch {
    // fall through to the assertion, which names what the deck holds
  }
  expect(await activeCard(app), what).toBe(cardId);
}

/** The card holding the keyboard, read every 100 ms for a second. */
async function sample(app: App): Promise<string> {
  const seen: (string | null)[] = [];
  for (let i = 0; i < 10; i++) {
    seen.push(await activeCard(app));
    await new Promise((r) => setTimeout(r, 100));
  }
  return seen.join(" ");
}

async function flips(app: App): Promise<string> {
  return app.evalJS<string>(
    `JSON.stringify(window.__deckTrace.dump().filter((e) => e.kind === "fr-flip").slice(-8).map((e) => [e.from, e.to, e.trigger]))`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0845 — Go ▸ Back after clicking into cards", () => {
  test(
    "Back returns to the card clicked before this one, and stays there",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(ONE_SPACE_BLOB));
      const app = await launchTugApp({
        testName: "at0845-go-back-click-landings",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.enableDeckTrace(true);
        await expectActive(app, "A", "the seeded focus is A");
        for (const id of ["A", "B"]) {
          await app.body(id).waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR(id))}) !== null`,
            { timeoutMs: 8_000 },
          );
        }

        await app.body("B").nativeClickAtElement(EDITOR("B"));
        await expectActive(app, "B", "a click into B's editor lands on B");
        await app.body("A").nativeClickAtElement(EDITOR("A"));
        await expectActive(app, "A", "a click into A's editor lands on A");
        note("flips after the clicks", await flips(app));

        const backRow = await app.menuItemState("go.back");
        note("go.back before the press", JSON.stringify(backRow));

        await app.nativeKey("[", ["cmd", "alt", "shift"]);
        const afterBack = await sample(app);
        note("active card after Back, every 100 ms", afterBack);
        note("flips after Back", await flips(app));
        await expectActive(app, "B", "Back goes to B, the card clicked before A");
        expect(afterBack.split(" ").at(-1), "and it stays on B").toBe("B");

        await app.nativeKey("]", ["cmd", "alt", "shift"]);
        const afterForward = await sample(app);
        note("active card after Forward, every 100 ms", afterForward);
        await expectActive(app, "A", "Forward retraces to A");
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
