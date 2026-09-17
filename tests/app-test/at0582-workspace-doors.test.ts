/**
 * at0582-workspace-doors.test.ts — the Workspaces card's visible doors.
 *
 * The folding leg is the one that lands first, and it is about the case the
 * old rule could not serve: **one workspace**. The data source used to force
 * the active workspace expanded, and `cards-space-header` drew its cue
 * disabled to match — so a person who had never made a second workspace had a
 * fold cue on screen that could not be pressed, over the one list long enough
 * to want folding. [B02] retires that rule: every workspace folds, the active
 * one included, and the store now holds COLLAPSED ids over an
 * expanded-by-default list.
 *
 * So this launches with a single workspace and drives the real cue with the
 * real pointer:
 *
 *   1. The cue is enabled, and the workspace's rows are on screen — the new
 *      default is expanded, which is what an empty store now means.
 *   2. A click folds it: the header stays (a workspace is a place), its
 *      `N cards` summary still counts what is inside, and every row under it
 *      is gone.
 *   3. **The deck on screen is unchanged** — same active workspace, same card
 *      ids, same pane. Folding a list is a reading gesture and must not be a
 *      move; the whole value of the cue is that it costs nothing.
 *   4. A second click brings the rows back, exactly as they were.
 *
 * Step 3 is the assertion with teeth. The fold reads a module store that the
 * deck knows nothing about, and the failure it guards against is a projection
 * change that reached through to the deck — the same shape [B02] makes newly
 * possible by letting the ACTIVE workspace, whose rows are the live deck's,
 * be the one that folds.
 *
 * The doors leg is the [B01] card half: New / Rename / Duplicate / Delete
 * used to open from a right-click and nowhere else, which makes a verb one a
 * person has to already know about. The card's toolbar now carries a New
 * button and every header row a `···` onto the same three-item menu — New is
 * the toolbar's alone, because a menu opened on a row is about that row — and
 * every one of them is answered at the chain root rather than on this card
 * ([P02]), so the doors work whether or not the card holds focus.
 *
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 * @covers tugdeck/src/components/cards/cards-space-expansion.ts
 * @covers tugdeck/src/components/cards/cards-space-header.tsx
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-space-verb-request.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SPACE_ONE = "doors-one";

/**
 * "On screen", said out loud.
 *
 * Every visited workspace stays MOUNTED ([B06]), so the document holds one
 * Workspaces card per visited workspace — all but one inside a wrapper with
 * no `data-space-shown` and no boxes. A bare `document.querySelectorAll` over
 * rows counts the hidden ones too. The portaled selectors (menus, confirms,
 * sheets) deliberately carry no scope: an overlay is mounted at the canvas's
 * overlay root, outside every layer.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";

const HEADER = `${SHOWN}[data-testid="cards-space-header"]`;
const headerFor = (id: string): string =>
  `${SHOWN}.cards-space-header[data-cards-space-id="${id}"]`;
const foldFor = (id: string): string =>
  `${headerFor(id)} [data-slot="cards-space-fold"]`;
const SUMMARY = '[data-testid="cards-space-count"]';
/**
 * The rows UNDER a workspace's header. `data-cards-space-run` is the workspace
 * reorder's block key and the HEADER carries it too — it has to, so a carried
 * workspace travels with everything it holds — so the header is subtracted
 * here rather than counted as one of its own rows.
 */
const runUnder = (id: string): string =>
  `${SHOWN}.cards-list [data-cards-space-run="${id}"]:not([data-testid="cards-space-header"])`;
const MENU_ITEM = "[data-item-action]";
const NEW_BUTTON = `${SHOWN}[data-testid="cards-new-space"]`;
const VERBS_BUTTON = `${SHOWN}[data-testid="cards-space-verbs-button"]`;

/**
 * One workspace, standing its own Workspaces card beside two Text cards — so
 * the list has rows worth folding and the surface under test is inside the
 * workspace being folded, which is the case [B02] opens up.
 */
function oneSpaceBlob() {
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      {
        id: SPACE_ONE,
        name: "Main",
        deck: {
          cards: [
            {
              id: "C1",
              componentId: "cards",
              title: "Workspaces",
              closable: true,
            },
            { id: "T1", componentId: "text", title: "T1", closable: true },
            { id: "T2", componentId: "text", title: "T2", closable: true },
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
            {
              id: "pt2",
              position: { x: 80, y: 80 },
              size: { width: 700, height: 500 },
              cardIds: ["T2"],
              activeCardId: "T2",
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

describe.skipIf(!SHOULD_RUN)(
  "at0582 — every workspace folds, the only one included",
  () => {
    test(
      "the sole workspace's fold cue is live, and folding it does not move the deck",
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

        const app = await launchTugApp({
          testName: "at0582-workspace-doors",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          // ---- 1. One workspace, expanded by default, with a live cue.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 1`,
            { timeoutMs: 20_000 },
          );
          const rowsUnder = (): Promise<number> =>
            app.evalJS<number>(
              `document.querySelectorAll(
                 ${JSON.stringify(runUnder(SPACE_ONE))}
               ).length`,
            );
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(
               ${JSON.stringify(runUnder(SPACE_ONE))}
             ).length > 0`,
            { timeoutMs: 8_000 },
          );
          const openRows = await rowsUnder();
          note("at0582 rows under the sole workspace", String(openRows));
          expect(openRows).toBeGreaterThan(0);

          // The cue a person with one workspace can actually press. Disabled
          // was the whole defect, so the attribute is the assertion.
          const cueState = await app.evalJS<{
            disabled: boolean;
            ariaDisabled: string | null;
          }>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(foldFor(SPACE_ONE))});
               return {
                 disabled: el.disabled === true,
                 ariaDisabled: el.getAttribute("aria-disabled"),
               };
             })()`,
          );
          note("at0582 fold cue at rest", JSON.stringify(cueState));
          expect(cueState.disabled).toBe(false);
          expect(cueState.ariaDisabled).not.toBe("true");

          // What the deck looks like before anything is folded: the active
          // workspace, the cards, and the pane layout. NOT the active pane —
          // clicking the cue focuses the Workspaces card and its pane becomes
          // active, which is ordinary click-to-focus and nothing the fold did.
          const deckBefore = await app.evalJS<{
            activeSpaceId: string;
            cardIds: string[];
            panes: string[];
          }>(
            `(function () {
               var s = window.tugdeck.diag.getSpaces();
               var d = window.tugdeck.diag.getDeckState();
               return {
                 activeSpaceId: s.activeSpaceId,
                 cardIds: d.cards.map(function (c) { return c.id; }).sort(),
                 panes: d.panes.map(function (p) {
                   return p.id + ":" + p.cardIds.join(",");
                 }).sort(),
               };
             })()`,
          );

          // ---- 2. A click folds it. Header stays; rows go.
          await app.nativeClickAtElement(foldFor(SPACE_ONE));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(
               ${JSON.stringify(runUnder(SPACE_ONE))}
             ).length === 0`,
            { timeoutMs: 8_000 },
          );
          // The header — and its cue — survive the fold. The card's empty
          // label would take both away, and with one workspace that is the
          // only door back to the rows just put down.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(HEADER)}).length`,
            ),
          ).toBe(1);
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('[data-testid="cards-empty"]').length`,
            ),
          ).toBe(0);
          // The count is taken before the fold decides what to draw, so the
          // folded header still says how much is inside.
          const summary = await app.evalJS<string | null>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(headerFor(SPACE_ONE))});
               var s = el.querySelector(${JSON.stringify(SUMMARY)});
               return s === null ? null : s.textContent;
             })()`,
          );
          note("at0582 folded summary", String(summary));
          expect(summary).toContain("cards");

          // ---- 3. The deck did not move. This is the assertion with teeth:
          // the fold reads a module store the deck knows nothing about, and
          // since the ACTIVE workspace is the one folding, its rows are the
          // live deck's.
          const deckAfter = await app.evalJS<typeof deckBefore>(
            `(function () {
               var s = window.tugdeck.diag.getSpaces();
               var d = window.tugdeck.diag.getDeckState();
               return {
                 activeSpaceId: s.activeSpaceId,
                 cardIds: d.cards.map(function (c) { return c.id; }).sort(),
                 panes: d.panes.map(function (p) {
                   return p.id + ":" + p.cardIds.join(",");
                 }).sort(),
               };
             })()`,
          );
          expect(deckAfter).toEqual(deckBefore);

          // ---- 4. A second click brings the rows back, as they were.
          await app.nativeClickAtElement(foldFor(SPACE_ONE));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(
               ${JSON.stringify(runUnder(SPACE_ONE))}
             ).length === ${openRows}`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<typeof deckBefore>(
              `(function () {
                 var s = window.tugdeck.diag.getSpaces();
                 var d = window.tugdeck.diag.getDeckState();
                 return {
                   activeSpaceId: s.activeSpaceId,
                   cardIds: d.cards.map(function (c) { return c.id; }).sort(),
                   panes: d.panes.map(function (p) {
                     return p.id + ":" + p.cardIds.join(",");
                   }).sort(),
                 };
               })()`,
            ),
          ).toEqual(deckBefore);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the New button and the row's ··· are the card's visible doors",
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

        const app = await launchTugApp({
          testName: "at0582-workspace-doors-verbs",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 1`,
            { timeoutMs: 20_000 },
          );

          // ---- 1. Delete is disabled on the last workspace and says why.
          //
          // Read from the `···` rather than the right-click, because the
          // button is the door this step added and the menu behind it is the
          // same one — so this is both assertions at once.
          await app.nativeClickAtElement(VERBS_BUTTON);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length >= 3`,
            { timeoutMs: 8_000 },
          );
          const menu = await app.evalJS<
            { action: string; label: string; disabled: boolean }[]
          >(
            `Array.prototype.map.call(
               document.querySelectorAll(${JSON.stringify(MENU_ITEM)}),
               function (el) {
                 return {
                   action: el.getAttribute("data-item-action"),
                   label: el.textContent,
                   disabled: el.getAttribute("aria-disabled") === "true" || el.disabled === true,
                 };
               },
             )`,
          );
          note("at0582 the ··· menu", JSON.stringify(menu));
          expect(menu.map((m) => m.action)).toEqual([
            "rename-space",
            "duplicate-space",
            "delete-space",
          ]);
          const del = menu[2];
          expect(del?.disabled).toBe(true);
          // The label carries the reason, so a dead row is not a mystery.
          expect(del?.label).toContain("last workspace");

          // Opening the menu is not travelling: the workspace under the row
          // is still the one on screen.
          expect(
            await app.evalJS<string>(
              `window.tugdeck.diag.getSpaces().activeSpaceId`,
            ),
          ).toBe(SPACE_ONE);
          await app.nativeKey("Escape");

          // ---- 2. The New button makes a second workspace and goes there.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(NEW_BUTTON)}).length`,
            ),
          ).toBe(1);
          await app.nativeClickAtElement(NEW_BUTTON);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.length === 2`,
            { timeoutMs: 8_000 },
          );
          const spaces = await app.evalJS<
            { activeSpaceId: string; spaces: { id: string }[] }
          >(`window.tugdeck.diag.getSpaces()`);
          // Creating a workspace puts the user in it — the created one is
          // the active one, which is what makes the button one gesture.
          expect(spaces.activeSpaceId).not.toBe(SPACE_ONE);
          expect(spaces.spaces).toHaveLength(2);

          // ---- 3. With two workspaces, Delete is live and names no reason.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 2`,
            { timeoutMs: 8_000 },
          );
          await app.nativeClickAtElement(
            `${headerFor(SPACE_ONE)} [data-testid="cards-space-verbs-button"]`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length >= 3`,
            { timeoutMs: 8_000 },
          );
          const second = await app.evalJS<
            { action: string; label: string; disabled: boolean }[]
          >(
            `Array.prototype.map.call(
               document.querySelectorAll(${JSON.stringify(MENU_ITEM)}),
               function (el) {
                 return {
                   action: el.getAttribute("data-item-action"),
                   label: el.textContent,
                   disabled: el.getAttribute("aria-disabled") === "true" || el.disabled === true,
                 };
               },
             )`,
          );
          note("at0582 the ··· menu, two workspaces", JSON.stringify(second));
          expect(second[2]?.disabled).toBe(false);
          expect(second[2]?.label).not.toContain("last workspace");
          await app.nativeKey("Escape");

          // ---- 4. The right-click still opens the same menu. The `···` is a
          // second door onto one menu, not a replacement for the first.
          await app.nativeRightClickAtElement(headerFor(SPACE_ONE));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(MENU_ITEM)}).length >= 3`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<string[]>(
              `Array.prototype.map.call(
                 document.querySelectorAll(${JSON.stringify(MENU_ITEM)}),
                 function (el) { return el.getAttribute("data-item-action"); },
               )`,
            ),
          ).toEqual([
            "rename-space",
            "duplicate-space",
            "delete-space",
          ]);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
