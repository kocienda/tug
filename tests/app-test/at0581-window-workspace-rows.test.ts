/**
 * at0581-window-workspace-rows.test.ts — Window ▸ Workspaces lists every
 * workspace, marks the one on screen, and switches to the one you pick.
 *
 * The section is one row per workspace with a radio mark on the active one
 * ([B10], [P12]), and it is built from four facts that could each be right
 * alone and still disagree: the spaces snapshot, the `spaces` block on the
 * menu-state payload, the Swift decode, and `rebuildWindowSpaceList`'s
 * insertion after its own anchor. Only the built menu reads all four at once,
 * which is why this is an app-test rather than a unit test of the projection.
 *
 * Scenarios:
 *   1. Two workspaces from a seeded `version: 5` blob: `window.space.0` is
 *      checked and titled "Main", `window.space.1` is unchecked and titled
 *      "Second".
 *   2. The switch the row performs — the control frame `activate-space`,
 *      which is exactly what `activateSpaceFromMenu` sends — moves the mark
 *      to `window.space.1`. The harness cannot click a menu item, so the item's
 *      own wire is driven instead and the MENU is still what is read; the same
 *      accommodation at0511 makes.
 *   3. A rename through the `lab` surface retitles the row. Nothing about the
 *      deck moves for a rename, so the row can only change if the menu's own
 *      subscription to the spaces store carried it.
 *
 * The blob is why the launch carries `restoreInTestMode`: under plain test
 * mode the constructor drops the boot layout by design, and the second
 * workspace IS the fixture.
 *
 * `@covers` names the two surfaces this file is the first reader of — the
 * Swift menu and the payload it decodes. `deck-canvas.tsx`, which answers the
 * `activate-space` frame leg 2 sends, is deliberately not among them: it
 * stands at the fan-out ratchet's accepted count, at0578 already covers it for
 * that handler, and the ratchet lets recorded debt be paid down rather than
 * refinanced (at0506's precedent, the same one at0580 takes).
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";

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

const ROW_ONE = "window.space.0";
const ROW_TWO = "window.space.1";

/** `NSControl.StateValue` as the harness reports it. */
const OFF = 0;
const ON = 1;

/** Two workspaces on disk, each holding one Text card so neither is a void. */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    {
      id: SPACE_ONE,
      name: "Main",
      deck: {
        cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
        panes: [
          {
            id: "p-a",
            position: { x: 40, y: 40 },
            size: { width: 700, height: 500 },
            cardIds: ["A"],
            activeCardId: "A",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p-a",
        imposition: { sidebars: {} },
      },
    },
    {
      id: SPACE_TWO,
      name: "Second",
      deck: {
        cards: [{ id: "B", componentId: "text", title: "File", closable: true }],
        panes: [
          {
            id: "p-b",
            position: { x: 60, y: 60 },
            size: { width: 700, height: 500 },
            cardIds: ["B"],
            activeCardId: "B",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p-b",
        imposition: { sidebars: {} },
      },
    },
  ],
};

/**
 * Poll until the row matches both its mark and its title, then return what it
 * settled on.
 *
 * The payload that carries the section is coalesced onto a microtask and
 * crosses to the host asynchronously, so a read taken the instant a dispatch
 * returns can legitimately see the state before last — the same accommodation
 * at0511 makes for the sidebar rows.
 */
async function waitRow(
  app: App,
  identifier: string,
  want: { state: number; title?: string },
  timeoutMs = 8000,
): Promise<{ found: boolean; state?: number; title?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; state?: number; title?: string } = {
    found: false,
  };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (
      last.found &&
      last.state === want.state &&
      (want.title === undefined || last.title === want.title)
    ) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)("at0581 — the Window menu's Workspaces rows", () => {
  test(
    "a row per workspace, the active one checked, and picking one switches",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(TWO_SPACE_BLOB),
      );

      const app = await launchTugApp({
        testName: "at0581-window-workspace-rows",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 10_000 },
        );

        // ---- 1. One row per workspace, in the user's order, mark on the
        // one being rendered.
        const first = await waitRow(app, ROW_ONE, {
          state: ON,
          title: "Main",
        });
        expect(first.found, `${ROW_ONE} must exist`).toBe(true);
        expect(first.state, `${ROW_ONE} is the workspace on screen`).toBe(ON);
        expect(first.title).toBe("Main");

        const second = await waitRow(app, ROW_TWO, {
          state: OFF,
          title: "Second",
        });
        expect(second.found, `${ROW_TWO} must exist`).toBe(true);
        expect(second.state, `${ROW_TWO} is parked`).toBe(OFF);
        expect(second.title).toBe("Second");

        // ---- 2. The row's own wire switches, and the mark follows.
        await app.dispatchControlAction("activate-space", {
          spaceId: SPACE_TWO,
        });
        const switched = await waitRow(app, ROW_TWO, { state: ON });
        expect(switched.state, `${ROW_TWO} takes the mark`).toBe(ON);
        const yielded = await waitRow(app, ROW_ONE, { state: OFF });
        expect(yielded.state, `${ROW_ONE} gives it up`).toBe(OFF);
        // The mark is not the only thing that moved: the deck did too.
        expect(
          await app.evalJS<string[]>(`window.tugdeck.diag.listCardIds()`),
        ).toContain("B");

        // ---- 3. A rename retitles the row. No deck mutation is involved,
        // so this can only arrive through the spaces subscription.
        await app.evalJS<null>(
          `(window.tugdeck.lab.renameSpace(${JSON.stringify(SPACE_TWO)}, "Renamed"), null)`,
        );
        const renamed = await waitRow(app, ROW_TWO, {
          state: ON,
          title: "Renamed",
        });
        expect(renamed.title, `${ROW_TWO} carries the new name`).toBe(
          "Renamed",
        );
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
