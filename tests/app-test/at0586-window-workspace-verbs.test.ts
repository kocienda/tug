/**
 * at0586-window-workspace-verbs.test.ts — the four workspace verbs in the
 * Window menu.
 *
 * The Workspaces card grew doors for all four verbs (at0582), and a card is a
 * surface you have to have open. The menu bar is the one place a verb can be
 * found by somebody who does not yet know the card exists, so New, Rename,
 * Duplicate and Delete stand above the Window menu's workspace list.
 *
 * What this file pins, and why each needs the BUILT menu rather than a unit
 * test of the projection:
 *
 *   1. **The four rows are there, in order, above the list.** Their order and
 *      their position relative to `windowSpaceListAnchor` are facts about the
 *      assembled `NSMenu`, and the identifiers are load-bearing in a way no
 *      type can catch: `rebuildWindowSpaceList` sweeps every item whose
 *      identifier begins `window.space.` on each menu open, so a fifth name
 *      spelled `window.space.new` would vanish the first time anybody used
 *      the menu. This walks the real snapshot, after the rebuild has run.
 *   2. **Delete is gated on there being more than one workspace** ([P07]).
 *      That gate is published from the command table through a new
 *      `spaceCount` fact and read by `validateMenuItem`'s registry tier ahead
 *      of everything hand-rolled — four surfaces that could each be right
 *      alone and still disagree. Only the validated menu reads all four.
 *   3. **Each row's wire does what its title says**, including the two whose
 *      answer is not a state change but a card: Rename and Delete with no
 *      `spaceId` act on the ACTIVE workspace ([P02]) and reach the Workspaces
 *      card, revealing it if it is closed ([P03]) — the inline field for one,
 *      the confirm for the other.
 *
 * The harness cannot click a native menu item, so each verb is driven through
 * the control frame its `@objc` action sends and the MENU is still what is
 * read for (1) and (2) — the same accommodation at0511 and at0581 make.
 *
 * `@covers` names the Swift menu and the payload it decodes, as at0581 does.
 * `command-registry.ts`, where the gate's predicate lives, is named too: the
 * `spaceCount` fact is new and this is the only test that drives it through
 * to a dimmed item.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import type { MenuItemSnapshot } from "./_harness/types";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SPACE_ONE = "space-one";
const SPACE_TWO = "space-two";

const NEW_ROW = "window.newWorkspace";
const RENAME_ROW = "window.renameWorkspace";
const DUPLICATE_ROW = "window.duplicateWorkspace";
const DELETE_ROW = "window.deleteWorkspace";

/** The four, in the order the spine puts them. */
const VERB_ROWS = [NEW_ROW, RENAME_ROW, DUPLICATE_ROW, DELETE_ROW];

const RENAME_INPUT = '[data-testid="cards-space-rename"]';
const CONFIRM = '[data-slot="tug-confirm-popover"]';

/** One workspace's deck, holding a single Text card so it is not a void. */
function spaceDeck(cardId: string, paneId: string): Record<string, unknown> {
  return {
    cards: [{ id: cardId, componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: paneId,
        position: { x: 40, y: 40 },
        size: { width: 700, height: 500 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: paneId,
    imposition: { sidebars: {} },
  };
}

const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    { id: SPACE_ONE, name: "Main", deck: spaceDeck("A", "p-a") },
    { id: SPACE_TWO, name: "Second", deck: spaceDeck("B", "p-b") },
  ],
};

const ONE_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [{ id: SPACE_ONE, name: "Main", deck: spaceDeck("A", "p-a") }],
};

/**
 * The Window menu's items, in order, as the host assembled them.
 *
 * Found by looking for the row list one of the four verbs is in, rather than
 * by the menu's title: the snapshot's top level is the menu BAR, whose items
 * carry the submenus, and which of the two levels holds the title is not the
 * thing under test here. at0511's precedent.
 */
async function windowMenu(app: App): Promise<MenuItemSnapshot[]> {
  const tree = await app.menuSnapshot();
  let rows: MenuItemSnapshot[] | undefined;
  const walk = (items: readonly MenuItemSnapshot[]): void => {
    if (items.some((item) => item.identifier === NEW_ROW)) rows = [...items];
    for (const item of items) if (item.submenu) walk(item.submenu);
  };
  walk(tree);
  if (rows === undefined) {
    throw new Error("the Window menu's rows are not in the snapshot");
  }
  return rows;
}

/**
 * Poll until a row reports the enablement asked for, then return it.
 *
 * The gate rides the menu-state payload, which is coalesced onto a microtask
 * and crosses to the host asynchronously — so a read taken the instant a
 * dispatch returns can legitimately see the state before last, the same
 * accommodation at0581 makes for the rows' marks.
 */
async function waitEnabled(
  app: App,
  identifier: string,
  want: boolean,
  timeoutMs = 10_000,
): Promise<{ found: boolean; enabled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)("at0586 — the Window menu's workspace verbs", () => {
  test(
    "four rows above the list, Delete live with two workspaces, and each wire acts",
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
        testName: "at0586-window-workspace-verbs",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 10_000 },
        );
        // The list is built on menu open; this read is what runs the rebuild,
        // so everything below is looking at a menu that has been swept once.
        await waitEnabled(app, DELETE_ROW, true);

        // ---- 1. The four rows, in order, above the workspace list. -------
        const items = await windowMenu(app);
        const ids = items.map((i) => i.identifier ?? (i.separator ? "—" : ""));
        note(`at0586 Window menu tail: ${JSON.stringify(ids.slice(-14))}`);

        const indexOf = (id: string): number =>
          items.findIndex((i) => i.identifier === id);
        const positions = VERB_ROWS.map(indexOf);
        expect(
          positions.every((p) => p >= 0),
          `all four rows exist: ${JSON.stringify(VERB_ROWS.map((id, n) => [id, positions[n]]))}`,
        ).toBe(true);
        expect(
          positions,
          "and they stand in the spine's order, contiguously",
        ).toEqual([
          positions[0],
          positions[0] + 1,
          positions[0] + 2,
          positions[0] + 3,
        ]);
        expect(
          VERB_ROWS.map((id) => items[indexOf(id)]?.title),
          "titled from the command table, the ellipsis marking the one that opens a field",
        ).toEqual([
          "New Workspace",
          "Rename Workspace…",
          "Duplicate Workspace",
          "Delete Workspace",
        ]);

        // Above the workspace list, and with nothing between: the anchor is
        // itself a separator, so a rule of our own would double it.
        const firstSpaceRow = items.findIndex(
          (i) => i.identifier?.startsWith("window.space.") === true,
        );
        expect(firstSpaceRow, "the workspace list is built").toBeGreaterThan(0);
        expect(
          positions[3],
          "the four stand above the list",
        ).toBeLessThan(firstSpaceRow);
        expect(
          items[positions[3] + 1]?.separator,
          "and the anchor separator is what divides them from it",
        ).toBe(true);
        expect(
          items[positions[0] - 1]?.identifier?.startsWith("window.space."),
          "none of the four carries the prefix the list's sweep removes",
        ).not.toBe(true);
        expect(
          VERB_ROWS.some((id) => id.startsWith("window.space.")),
          "nor would any of them be caught by it",
        ).toBe(false);

        // ---- 2. Delete is live while a second workspace stands. ----------
        for (const id of VERB_ROWS) {
          const row = await waitEnabled(app, id, true);
          expect(row.enabled, `${id} is live with two workspaces`).toBe(true);
        }

        // ---- 3. Each wire does what its row says. ------------------------
        // New: creates and activates, which is `createSpace`'s own contract.
        await app.dispatchControlAction("new-space");
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getSpaces().spaces.length === 3`,
          { timeoutMs: 10_000 },
        );
        const afterNew = await app.evalJS<{
          activeSpaceId: string;
          spaces: { id: string; name: string }[];
        }>(`window.tugdeck.diag.getSpaces()`);
        expect(
          afterNew.activeSpaceId,
          "the new workspace is the one you are now in",
        ).not.toBe(SPACE_ONE);
        const created = afterNew.activeSpaceId;

        // Duplicate: a copy of the ACTIVE workspace, from a row that names no
        // workspace at all — which is the whole of [P02].
        await app.dispatchControlAction("duplicate-space");
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getSpaces().spaces.length === 4`,
          { timeoutMs: 10_000 },
        );
        const afterDuplicate = await app.evalJS<{
          activeSpaceId: string;
          spaces: { id: string; name: string }[];
        }>(`window.tugdeck.diag.getSpaces()`);
        const sourceName =
          afterNew.spaces.find((s) => s.id === created)?.name ?? "";
        expect(
          afterDuplicate.spaces.map((s) => s.name),
          "the copy is named after what it copied",
        ).toContain(`${sourceName} copy`);
        expect(
          afterDuplicate.activeSpaceId,
          "and the copy is not activated — you stay where you were",
        ).toBe(created);

        // Rename: no card is open on this workspace, so the verb has to bring
        // one. The field opening at all is the proof the reveal ran ([P03]).
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) === null`,
          ),
          "nothing is being renamed yet",
        ).toBe(true);
        await app.dispatchControlAction("rename-space");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RENAME_INPUT)}) !== null`,
          { timeoutMs: 15_000 },
        );
        // On the ACTIVE workspace's row, not on some other one.
        expect(
          await app.evalJS<string | null>(
            `(function(){
               var field = document.querySelector(${JSON.stringify(RENAME_INPUT)});
               var header = field.closest(".cards-space-header");
               return header === null ? null : header.getAttribute("data-cards-space-id");
             })()`,
          ),
          "the field opens on the workspace the menu was naming — the active one",
        ).toBe(created);
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RENAME_INPUT)}) === null`,
          { timeoutMs: 8_000 },
        );

        // Delete: reaches the card the same way and arms the confirm rather
        // than taking the workspace outright.
        await app.dispatchControlAction("delete-space");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        expect(
          await app.evalJS<number>(
            `window.tugdeck.diag.getSpaces().spaces.length`,
          ),
          "the confirm is a question, not a receipt",
        ).toBe(4);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with one workspace the Delete row dims, and the other three stay live",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(ONE_SPACE_BLOB),
      );

      const app = await launchTugApp({
        testName: "at0586-window-workspace-verbs-alone",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 1`,
          { timeoutMs: 10_000 },
        );

        const deleteRow = await waitEnabled(app, DELETE_ROW, false);
        note(`at0586 delete row, one workspace: ${JSON.stringify(deleteRow)}`);
        expect(deleteRow.found, "the row is there").toBe(true);
        expect(
          deleteRow.enabled,
          "and dimmed: the last workspace cannot go, and the row says so rather than failing when pressed",
        ).toBe(false);

        for (const id of [NEW_ROW, RENAME_ROW, DUPLICATE_ROW]) {
          const row = await waitEnabled(app, id, true);
          expect(
            row.enabled,
            `${id} is ungated — there is always an active workspace to act on`,
          ).toBe(true);
        }
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
