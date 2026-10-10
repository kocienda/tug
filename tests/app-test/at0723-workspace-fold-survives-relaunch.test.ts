/**
 * at0723-workspace-fold-survives-relaunch.test.ts — a workspace folded shut in
 * the Workspaces card is still folded after the app quits and relaunches.
 *
 * The fold used to be session-only by design: a module store nothing wrote
 * down, so every relaunch brought every workspace back expanded. It now lives
 * in the cards store beside the group folds and is written to tugbank under
 * `dev.tugapp.cards` / `cardsCollapsedSpaces`, so the list comes back the way
 * the user left it.
 *
 * Two launches over one tugbank: the first folds the workspace through the
 * real cue and waits for the write to land on disk; the second asserts the
 * header stands with nothing under it from its first paint, with no gesture.
 *
 * @covers tugdeck/src/spaces-store.ts
 * @covers tugdeck/src/components/cards/cards-store/cards-store.ts
 * @covers tugdeck/src/components/cards/cards-store/reducer.ts
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SPACE = "relaunch-one";

/** Every visited workspace stays mounted; only the shown layer counts. */
const SHOWN = "[data-space-layer][data-space-shown] ";
const HEADER = `${SHOWN}.cards-space-header[data-cards-space-id="${SPACE}"]`;
const FOLD = `${HEADER} [data-slot="cards-space-fold"]`;
/** The rows under the header — the header carries the run key too. */
const RUN_UNDER = `${SHOWN}.cards-list [data-cards-space-run="${SPACE}"]:not([data-testid="cards-space-header"])`;

function oneSpaceBlob() {
  return {
    version: 5,
    activeSpaceId: SPACE,
    spaces: [
      {
        id: SPACE,
        name: "Main",
        deck: {
          cards: [
            { id: "C1", componentId: "cards", title: "Workspaces", closable: true },
            { id: "T1", componentId: "text", title: "T1", closable: true },
          ],
          panes: [
            {
              id: "pc1",
              position: { x: 0, y: 0 },
              size: { width: 420, height: 900 },
              cardIds: ["C1"],
              activeCardId: "C1",
              title: "",
              acceptsFamilies: [] as string[],
            },
            {
              id: "pt1",
              position: { x: 60, y: 60 },
              size: { width: 700, height: 500 },
              cardIds: ["T1"],
              activeCardId: "T1",
              title: "",
              acceptsFamilies: ["standard"],
            },
          ],
          activePaneId: "pt1",
          imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
          hasFocus: true,
        },
      },
    ],
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll tugbank from the test process until the fold is on disk. */
async function awaitFoldOnDisk(path: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const r = tugbankRead<unknown>(path, "dev.tugapp.cards", "cardsCollapsedSpaces");
    last = r?.value ?? null;
    if (Array.isArray(last) && last.includes(SPACE)) return last;
    await wait(200);
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)("at0723 — a workspace fold survives a relaunch", () => {
  test(
    "fold, quit, relaunch: the workspace comes back folded",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(oneSpaceBlob()),
      );
      const launch = (name: string) =>
        launchTugApp({
          testName: name,
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });

      try {
        // ---- 1. First launch: expanded by default, then folded by the cue.
        const first = await launch("at0723-first");
        try {
          await first.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(RUN_UNDER)}).length > 0`,
            { timeoutMs: 20_000 },
          );
          await first.nativeClickAtElement(FOLD);
          await first.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(RUN_UNDER)}).length === 0`,
            { timeoutMs: 8_000 },
          );
          const onDisk = await awaitFoldOnDisk(tugbankPath, 8_000);
          note("at0723 cardsCollapsedSpaces after the fold", JSON.stringify(onDisk));
          expect(Array.isArray(onDisk) && onDisk.includes(SPACE), "the fold is written down").toBe(true);
        } finally {
          await first.close().catch(() => undefined);
        }

        // ---- 2. Second launch: the header stands, and nothing is under it.
        const second = await launch("at0723-second");
        try {
          await second.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(HEADER)}) !== null`,
            { timeoutMs: 20_000 },
          );
          // A beat for any late hydrate to land, so a fold that only arrived
          // after a first expanded paint would still be caught as expanded.
          await wait(500);
          const rows = await second.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(RUN_UNDER)}).length`,
          );
          note("at0723 rows under the workspace after relaunch", String(rows));
          expect(rows, "the workspace comes back folded").toBe(0);
        } finally {
          await second.close().catch(() => undefined);
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
