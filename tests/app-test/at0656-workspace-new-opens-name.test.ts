/**
 * at0656-workspace-new-opens-name.test.ts — New Workspace asks for the new
 * workspace's name, with the default selected, and the name typed is the name
 * the workspace wears.
 *
 * A new workspace is one the user is about to name. The name used to be
 * asked after the fact, in an inline field the Workspaces card opened on the
 * new header — so New made a workspace whatever the user did next, and
 * Escape could only keep its default name. It is now asked first, in the
 * app-modal the overlay draws over the whole window: the field holds the
 * default name, selected, with the keyboard, so typing replaces it; Return
 * makes the workspace under that name, first in the list, and goes there;
 * and Escape makes nothing at all.
 *
 * Both doors are driven, because they reach the handler from different
 * places:
 *
 *   1. **The card's `+`**, over a long list of workspaces. Typing then Return
 *      names the workspace — the selected default is replaced, not appended
 *      to — and the new workspace is the list's first row, whose header the
 *      new workspace's own Workspaces card shows.
 *   2. **The Window menu's row** (its control frame — the harness cannot click
 *      a native menu item), from a workspace with no Workspaces card open at
 *      all. Escape then closes the modal and the list is exactly what it was:
 *      a cancelled New makes nothing.
 *
 * Rename Workspace keeps the inline field; at0582's rename leg pins it.
 *
 * @covers tugdeck/src/lib/new-workspace.ts
 * @covers tugdeck/src/components/tugways/tug-workspace-name-dialog.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { hasBodyOfKind, waitForBodyPainted } from "./_harness/card-reach";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME = "new-home";

/** Every visited workspace's Workspaces card is its own body; the shown one is chosen by kind. */
const HEADER = `[data-testid="cards-space-header"]`;
const NEW_BUTTON = `[data-testid="cards-new-space"]`;

const NAME_DIALOG = '[data-slot="tug-workspace-name-dialog"]';
const NAME_FIELD = '[data-slot="tug-workspace-name-field"]';

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

interface ModalFacts {
  verb: string | null;
  value: string;
  selectedWhole: boolean;
}

/**
 * Wait for the naming modal to stand with the keyboard in its field and the
 * overlay claiming the whole window, then read what a person would see of it.
 */
async function openModal(overlay: BodyApp): Promise<ModalFacts> {
  await overlay.waitForCondition<boolean>(
    `(function () {
       var f = document.querySelector(${JSON.stringify(NAME_FIELD)});
       return f !== null && document.activeElement === f && document.documentElement.getAttribute("data-overlay-claim-state") === "all";
     })()`,
    { timeoutMs: 8_000 },
  );
  return overlay.evalJS<ModalFacts>(
    `(function () {
       var f = document.querySelector(${JSON.stringify(NAME_FIELD)});
       var d = document.querySelector(${JSON.stringify(NAME_DIALOG)});
       return {
         verb: d === null ? null : d.getAttribute("data-verb"),
         value: f.value,
         selectedWhole: f.value.length > 0 && f.selectionStart === 0 && f.selectionEnd === f.value.length,
       };
     })()`,
  );
}

async function modalGone(overlay: BodyApp): Promise<void> {
  await overlay.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(NAME_DIALOG)}) === null && document.documentElement.getAttribute("data-overlay-claim-state") !== "all"`,
    { timeoutMs: 8_000 },
  );
}

async function spaces(
  app: App,
): Promise<{ activeSpaceId: string; spaces: { id: string; name: string }[] }> {
  // card-dom: shell
  const json = await app.evalJS<string>(
    `JSON.stringify((function (s) { return { activeSpaceId: s.activeSpaceId, spaces: s.spaces.map(function (w) { return { id: w.id, name: w.name }; }) }; })(window.tugdeck.diag.getSpaces()))`,
  );
  return JSON.parse(json) as { activeSpaceId: string; spaces: { id: string; name: string }[] };
}

describe.skipIf(!SHOULD_RUN)(
  "at0656 — New Workspace asks for the new workspace's name",
  () => {
    test(
      "the card's + asks with the default selected, and the name typed is the workspace's, first in the list",
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
          await app.body("C1").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === ${PARKED + 1}`,
            { timeoutMs: 25_000 },
          );
          const overlay = await overlayReady(app);
          await app.body("C1").nativeClickAtElement(NEW_BUTTON);
          const modal = await openModal(overlay);
          note(`at0656 + modal: ${JSON.stringify(modal)}`);
          expect(modal.verb, "the modal asks for New").toBe("new");
          expect(modal.value.length, "holding a default name").toBeGreaterThan(0);
          expect(modal.selectedWhole, "selected whole, so typing replaces it").toBe(true);
          const before = await spaces(app);
          expect(before.spaces.length, "nothing is made while the name is asked").toBe(PARKED + 1);

          await app.nativeType("Studio");
          await app.nativeKey("Return");
          await modalGone(overlay);
          // card-dom: shell
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.length === ${PARKED + 2}`,
            { timeoutMs: 10_000 },
          );
          const after = await spaces(app);
          const created = after.activeSpaceId;
          expect(created, "New goes to the workspace it made").not.toBe(HOME);
          expect(after.spaces[0]?.id, "first in the list").toBe(created);
          expect(after.spaces[0]?.name, "wearing the name typed, which replaced the default").toBe("Studio");

          // The new workspace's own Workspaces card shows it as the first row.
          const card = await waitForBodyPainted(app, "cards", 15_000);
          await card.waitForCondition<boolean>(
            `(function () {
               var h = document.querySelector(${JSON.stringify(HEADER)});
               return h !== null && h.getAttribute("data-cards-space-id") === ${JSON.stringify(created)};
             })()`,
            { timeoutMs: 8_000 },
          );
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the menu's New asks too, and Escape makes nothing",
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
          // card-dom: shell
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === ${PARKED + 1}`,
            { timeoutMs: 25_000 },
          );
          // No deck here has a Workspaces card, so none has a body.
          expect(
            await hasBodyOfKind(app, "cards"),
            "no Workspaces card is on screen to start",
          ).toBe(false);
          const before = await spaces(app);

          const overlay = await overlayReady(app);
          await app.dispatchControlAction("new-space");
          const modal = await openModal(overlay);
          note(`at0656 menu modal: ${JSON.stringify(modal)}`);
          expect(modal.verb).toBe("new");
          expect(modal.selectedWhole).toBe(true);

          await app.nativeKey("Escape");
          await modalGone(overlay);
          // Whether the full projection still crosses the bridge after a
          // discard: read for the record, never asserted.
          const whole = await app
            // card-dom: shell
            .evalJS<unknown>(`window.tugdeck.diag.getSpaces()`)
            .then(() => "crosses")
            .catch((e: unknown) => `refused: ${String(e)}`);
          note(`at0656 full getSpaces after Escape: ${whole}`);
          const kept = await spaces(app);
          expect(kept.spaces.map((s) => s.id), "a cancelled New makes nothing").toEqual(before.spaces.map((s) => s.id));
          expect(kept.activeSpaceId, "and the user stays where they were").toBe(HOME);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
