/**
 * at0656-workspace-new-opens-name.test.ts — New Workspace shows the workspace
 * it made and puts its name up for editing.
 *
 * A new workspace is one the user is about to name. New used to create the
 * workspace, go there, and stop: the new header was appended at the END of the
 * Workspaces list, often below the fold, and nothing offered its name for
 * editing — so the one thing the user wanted to do next took a scroll, a find,
 * and a right-click. New now runs Rename's own path on the workspace it just
 * made: the Workspaces card is revealed (opened if it is closed), the new
 * header is scrolled into view, and its field opens holding the default name,
 * selected, with the keyboard — so typing replaces the name.
 *
 * Both doors are driven, because they reach the handler from different
 * places and the second one is where the reveal earns its keep:
 *
 *   1. **The card's `+`**, over a list long enough to scroll, so "the header
 *      is in view" is a claim the scroll had to make true rather than one a
 *      short list made true by accident. Typing then Return names the
 *      workspace — the selected default is replaced, not appended to.
 *   2. **The Window menu's row** (its control frame — the harness cannot click
 *      a native menu item), from a workspace with no Workspaces card open at
 *      all. The field opening at all is the proof the card was brought.
 *      Escape then cancels the rename and the workspace KEEPS its default
 *      name: Escape is the rename's cancel, never an undo of the creation.
 *
 * Escape on an EXISTING workspace's rename restoring its old name is pinned
 * by at0582's rename leg and is not repeated here.
 *
 * The handler lives in `deck-canvas.tsx` and the reveal in `cards-card.tsx`,
 * and both are hubs already at the selection ceiling `ACCEPTED_FANOUT`
 * records, which only pays down. So this names the two narrower modules the
 * path runs through: the request store New hands the verb to, and the header
 * whose field it opens.
 *
 * @covers tugdeck/src/components/cards/cards-space-verb-request.ts
 * @covers tugdeck/src/components/cards/cards-space-header.tsx
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
const TEST_TIMEOUT_MS = 180_000;

const HOME = "new-home";

/**
 * "On screen" — every visited workspace stays mounted, so the document holds
 * one Workspaces card per visited workspace and only one of them is shown.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";
const HEADER = `${SHOWN}[data-testid="cards-space-header"]`;
const NEW_BUTTON = `${SHOWN}[data-testid="cards-new-space"]`;
const RENAME_INPUT = `${SHOWN}[data-testid="cards-space-rename"]`;

/** How many parked workspaces stand behind the home one — enough to scroll. */
const PARKED = 20;

function textDeck(cardId: string, paneId: string): Record<string, unknown> {
  return {
    cards: [{ id: cardId, componentId: "text", title: "T", closable: true }],
    panes: [
      {
        id: paneId,
        position: { x: 60, y: 60 },
        size: { width: 600, height: 400 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: paneId,
    imposition: { kind: "one-up", sidebars: {} },
  };
}

/**
 * The home workspace, optionally standing its own Workspaces card in the
 * right rail, followed by {@link PARKED} parked workspaces of one Text card
 * each.
 */
function blob(withCardsCard: boolean): Record<string, unknown> {
  const home = withCardsCard
    ? {
        cards: [
          { id: "C1", componentId: "cards", title: "Workspaces", closable: true },
          { id: "T0", componentId: "text", title: "T0", closable: true },
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
            id: "pt0",
            position: { x: 60, y: 60 },
            size: { width: 600, height: 400 },
            cardIds: ["T0"],
            activeCardId: "T0",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "pt0",
        imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
        hasFocus: true,
      }
    : textDeck("T0", "pt0");
  const spaces = [{ id: HOME, name: "Home", deck: home }];
  for (let i = 1; i <= PARKED; i++) {
    spaces.push({
      id: `parked-${i}`,
      name: `Parked ${i}`,
      deck: textDeck(`T${i}`, `pt${i}`),
    });
  }
  return { version: 5, activeSpaceId: HOME, spaces };
}

interface FieldFacts {
  spaceId: string | null;
  value: string | null;
  selectedWhole: boolean;
  focused: boolean;
  inView: boolean;
  scrolls: boolean;
}

/**
 * Wait for the rename field to open on the shown layer, then read what a
 * person would see of it: which header holds it, its text and selection,
 * whether it holds the keyboard, and whether its row lies inside the card's
 * scroller.
 */
async function openField(app: App): Promise<FieldFacts> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(RENAME_INPUT)}) !== null`,
    { timeoutMs: 15_000 },
  );
  // A frame for the reveal's scroll and the field's focus to settle.
  await new Promise<void>((r) => setTimeout(r, 400));
  return app.evalJS<FieldFacts>(
    `(function () {
       var f = document.querySelector(${JSON.stringify(RENAME_INPUT)});
       var header = f.closest(".cards-space-header");
       var scroller = f.closest(".cards-card");
       var row = (header && header.closest(".tug-list-view-cell")) || header;
       var r = row.getBoundingClientRect();
       var s = scroller.getBoundingClientRect();
       return {
         spaceId: header ? header.getAttribute("data-cards-space-id") : null,
         value: f.value,
         selectedWhole:
           f.value.length > 0 &&
           f.selectionStart === 0 &&
           f.selectionEnd === f.value.length,
         focused: document.activeElement === f,
         inView: r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
         scrolls: scroller.scrollHeight > scroller.clientHeight,
       };
     })()`,
  );
}

async function spaces(
  app: App,
): Promise<{ activeSpaceId: string; spaces: { id: string; name: string }[] }> {
  return app.evalJS(`window.tugdeck.diag.getSpaces()`);
}

describe.skipIf(!SHOULD_RUN)(
  "at0656 — New Workspace shows the new workspace and opens its name",
  () => {
    test(
      "the card's + scrolls the new header into view with its name selected, and typing names it",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob(true)),
        );
        const app = await launchTugApp({
          testName: "at0656-workspace-new-plus",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === ${PARKED + 1}`,
            { timeoutMs: 25_000 },
          );
          await app.nativeClickAtElement(NEW_BUTTON);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.length === ${PARKED + 2}`,
            { timeoutMs: 10_000 },
          );
          const after = await spaces(app);
          const created = after.activeSpaceId;
          const defaultName =
            after.spaces.find((s) => s.id === created)?.name ?? "";
          expect(created, "New goes to the workspace it made").not.toBe(HOME);

          const field = await openField(app);
          note(`at0656 + field: ${JSON.stringify(field)}`);
          expect(
            field.scrolls,
            "the list overflows its card, so being in view took a scroll",
          ).toBe(true);
          expect(field.spaceId, "the field opens on the new workspace").toBe(
            created,
          );
          expect(field.value, "holding its default name").toBe(defaultName);
          expect(field.selectedWhole, "selected whole, so typing replaces it").toBe(
            true,
          );
          expect(field.focused, "with the keyboard").toBe(true);
          expect(field.inView, "and its header is scrolled into view").toBe(true);

          await app.nativeType("Studio");
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) === null`,
            { timeoutMs: 8_000 },
          );
          const named = await spaces(app);
          expect(
            named.spaces.find((s) => s.id === created)?.name,
            "typing replaced the default name",
          ).toBe("Studio");
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the menu's New brings the Workspaces card, and Escape keeps the default name",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob(false)),
        );
        const app = await launchTugApp({
          testName: "at0656-workspace-new-menu",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === ${PARKED + 1}`,
            { timeoutMs: 25_000 },
          );
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(HEADER)}).length`,
            ),
            "no Workspaces card is on screen to start",
          ).toBe(0);

          await app.dispatchControlAction("new-space");
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.length === ${PARKED + 2}`,
            { timeoutMs: 10_000 },
          );
          const after = await spaces(app);
          const created = after.activeSpaceId;
          const defaultName =
            after.spaces.find((s) => s.id === created)?.name ?? "";

          const field = await openField(app);
          note(`at0656 menu field: ${JSON.stringify(field)}`);
          expect(field.spaceId, "the card was brought, open on the new workspace").toBe(
            created,
          );
          expect(field.value).toBe(defaultName);
          expect(field.selectedWhole).toBe(true);
          expect(field.focused).toBe(true);
          expect(field.inView, "its header in view").toBe(true);

          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) === null`,
            { timeoutMs: 8_000 },
          );
          const kept = await spaces(app);
          expect(
            kept.spaces.length,
            "Escape cancels the rename, never the creation",
          ).toBe(PARKED + 2);
          expect(
            kept.spaces.find((s) => s.id === created)?.name,
            "and the workspace keeps its default name",
          ).toBe(defaultName);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
