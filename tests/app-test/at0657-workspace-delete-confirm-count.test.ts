/**
 * at0657-workspace-delete-confirm-count.test.ts — the delete confirm counts
 * the workspace's own cards, and opens below the header it asks about.
 *
 * Every workspace is given a sidebar when it is made — the Workspaces, Arcs
 * and Layout cards — and the confirm used to count every pane in the deck, so
 * a workspace the user had just made, with nothing in it, asked "Delete
 * Workspace 1 and close 3 cards?" under a header that read "0 cards". The
 * sidebar is furniture, not the user's work: the count is now the
 * workspace's panes less its rail's, the same rule the list's rows are built
 * by.
 *
 * So this makes a fresh workspace through the real `+`, cancels the name
 * field New opens, and asks to delete it:
 *
 *   1. **The sentence counts nothing.** The fresh workspace stands a
 *      three-card rail and nothing else, so it asks only "Delete <name>?" —
 *      a confirm never mentions zero of anything, and any count is the rail
 *      being counted.
 *   2. **The header agrees** — its own tally reads 0, with no filter applied.
 *   3. **The popover hangs BELOW its header.** Above, it covered the previous
 *      workspace's header and rows and read as a question about them.
 *
 * `deck-manager.ts` and `cards-card.tsx` are hubs at the selection ceiling
 * `ACCEPTED_FANOUT` records, so this names where the rule itself lives and
 * the list that shares it.
 *
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import type { App, BodyApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME = "count-home";

/**
 * Read in a Workspaces card's own page: on bodies each is a body holding its
 * card alone, so no layer scope is in it. The `+` puts the user in a fresh
 * workspace, whose own Workspaces card — the visible one — raises the rename,
 * the menu verb's confirm and the header it hangs under; C1 parks with HOME.
 */
const HEADER = `[data-testid="cards-space-header"]`;
const NEW_BUTTON = `[data-testid="cards-new-space"]`;
const RENAME_INPUT = `[data-testid="cards-space-rename"]`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_MESSAGE = '[data-slot="tug-confirm-message"]';
const CONFIRM_CANCEL = '[data-slot="tug-confirm-cancel"]';

/** The fresh workspace's Workspaces card: the visible one, once its body is ready. */
async function freshCardsBody(app: App): Promise<BodyApp> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const bodies = await app.bodies();
    const fresh = bodies.find((b) => b.componentId === "cards" && b.state === "ready" && b.visible && b.cardId !== "C1");
    if (fresh?.cardId != null) return app.body(fresh.cardId);
    if (Date.now() >= deadline) throw new Error(`no fresh Workspaces body stood (the host holds ${bodies.map((b) => `${b.cardId}:${b.componentId}:${b.state}`).join(", ")})`);
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

/** One workspace: a Workspaces rail beside one Text card. */
const BLOB = {
  version: 5,
  activeSpaceId: HOME,
  spaces: [
    {
      id: HOME,
      name: "Home",
      deck: {
        cards: [
          { id: "C1", componentId: "cards", title: "Workspaces", closable: true },
          { id: "A", componentId: "text", title: "A", closable: true },
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
            id: "p1",
            position: { x: 60, y: 60 },
            size: { width: 700, height: 500 },
            cardIds: ["A"],
            activeCardId: "A",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p1",
        imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
        hasFocus: true,
      },
    },
  ],
};

describe.skipIf(!SHOULD_RUN)(
  "at0657 — the delete confirm counts the workspace's own cards",
  () => {
    test(
      "a fresh workspace's confirm counts no cards, agrees with its header, and opens below it",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(BLOB),
        );
        const app = await launchTugApp({
          testName: "at0657-workspace-delete-confirm-count",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.body("C1").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 1`,
            { timeoutMs: 25_000 },
          );

          // ---- A fresh workspace, through the real `+`.
          await app.body("C1").nativeClickAtElement(NEW_BUTTON);
          const shown = await freshCardsBody(app);
          await shown.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await app.nativeKey("Escape");
          await shown.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) === null`,
            { timeoutMs: 8_000 },
          );
          const spaces = await app.evalJS<{
            activeSpaceId: string;
            spaces: { id: string; name: string }[];
          }>(`window.tugdeck.diag.getSpaces()`);
          const created = spaces.activeSpaceId;
          const name = spaces.spaces.find((s) => s.id === created)?.name ?? "";
          expect(created).not.toBe(HOME);

          // The rail is really there: the count below is 0 because it is
          // excluded, not because the workspace stood no sidebar at all.
          const panes = await app.evalJS<number>(
            `window.tugdeck.diag.getSpaces().spaces.find(function (s) {
               return s.id === ${JSON.stringify(created)};
             }).deck.panes.length`,
          );
          note(`at0657 panes in the fresh workspace's deck: ${panes}`);
          expect(panes, "the fresh workspace stands its sidebar's panes").toBeGreaterThan(0);

          // ---- Ask to delete it — the menu's verb, on the active workspace.
          await app.dispatchControlAction("delete-space");
          await shown.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await new Promise<void>((r) => setTimeout(r, 400));

          const facts = await shown.evalJS<{
            message: string;
            tally: string | null;
            headerBottom: number;
            popoverTop: number;
          }>(
            `(function () {
               var header = document.querySelector(
                 ${JSON.stringify(`.cards-space-header[data-cards-space-id="`)} + ${JSON.stringify(created)} + '"]'
               );
               var cell = header.closest(".tug-list-view-cell") || header;
               var tally = header.querySelector('[data-testid="cards-space-count"]');
               var pop = document.querySelector(${JSON.stringify(CONFIRM)});
               return {
                 message: document.querySelector(${JSON.stringify(CONFIRM_MESSAGE)}).textContent,
                 tally: tally === null ? null : tally.textContent,
                 headerBottom: Math.round(cell.getBoundingClientRect().bottom),
                 popoverTop: Math.round(pop.getBoundingClientRect().top),
               };
             })()`,
          );
          note(`at0657 confirm: ${JSON.stringify(facts)}`);
          expect(
            facts.message,
            "the sentence counts the workspace's cards, never its sidebar's",
          ).toBe(`Delete ${name}?`);
          expect(
            facts.tally ?? "",
            "and the header's own tally agrees",
          ).toContain("0 cards");
          expect(
            facts.popoverTop,
            "the confirm hangs below the header it asks about",
          ).toBeGreaterThanOrEqual(facts.headerBottom - 2);

          await shown.nativeClickAtElement(CONFIRM_CANCEL);
          await shown.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
            { timeoutMs: 8_000 },
          );
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
