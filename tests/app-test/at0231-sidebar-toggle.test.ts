/**
 * at0231-sidebar-toggle.test.ts — `toggleSidebarCard`'s three states,
 * driven through a real rail card in a real pane.
 *
 * Layout is the card under test, and only because it is an ordinary
 * registered sidebar card (`"layout"`) hosted by the normal CardHost inside
 * an anchored pane. The subject is the toggle, not the card: every rail card
 * reaches its rail through this one function, so one of them driven for real
 * is what pins the shape for all of them.
 *
 * Control surface exercised (the same path Swift's "Show Layout" menu row
 * takes):
 *   - `toggle-layout` → `toggleSidebarCard()`, the three-state shortcut:
 *     hidden → show + activate, showing but inactive → activate,
 *     showing and active → hide.
 *
 * Scenarios:
 *   1. toggle-layout shows the anchored rail; a second toggle hides it —
 *      the rail it showed is the active card, so the second press is
 *      the hide state.
 *   2. with the first responder elsewhere, toggle-layout on a showing
 *      rail activates it rather than hiding it; only the press after
 *      that takes it away.
 *
 * A third scenario stood here — `focus-lens` opening the Lens and a second
 * press restoring the prior card. It retired with the command: the keyboard
 * addresses the RAILS now (`toggle-rail`), and a per-card focus verb has no
 * successor to point this at.
 *
 * Reload-survival of the anchored pane is NOT an app-test: in test mode
 * `DeckManager` ignores the persisted layout blob and starts empty (the
 * harness drives state via `seedDeckState`), so auto-restore-on-reload
 * can't be exercised here. That path — parseV4 carrying `anchor` and
 * skipping the fit-clamp — is pinned by the `serialization` unit tests
 * (`layout-tree.test.ts`).
 *
 * @covers tugdeck/src/sidebar-toggle.ts
 * @covers tugdeck/src/components/layout/layout-card-registration.tsx
 * @covers tugdeck/src/layout-tree.ts
 * @covers tugdeck/src/focus-transfer.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

// The card's own body is the address for "the rail is standing": it renders
// only while the pane does, and unlike a pane id it survives the hide/show
// cycle this file is entirely about, which mints a new pane each time.
const RAIL_PANE_SELECTOR = `[data-testid="lens-layouts-section"]`;

async function railPaneExists(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(RAIL_PANE_SELECTOR)}) !== null`,
  );
}

async function dispatch(app: App, action: string): Promise<void> {
  await app.dispatchControlAction(action);
}

function priorCardDeck() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)(
  "at0231 — the sidebar toggle, in its three states",
  () => {
    test(
      "toggle-layout shows then hides the anchored rail",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: "at0231-layout-toggle",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.waitForCondition<boolean>(
              `typeof window.__tug !== "undefined"`,
              { timeoutMs: 5_000 },
            );
            expect(await railPaneExists(app)).toBe(false);

            await dispatch(app, "toggle-layout");
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(RAIL_PANE_SELECTOR)}) !== null`,
              { timeoutMs: 3_000 },
            );
            expect(await railPaneExists(app)).toBe(true);

            await dispatch(app, "toggle-layout");
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(RAIL_PANE_SELECTOR)}) === null`,
              { timeoutMs: 3_000 },
            );
            expect(await railPaneExists(app)).toBe(false);
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "toggle-layout activates a showing rail before it will hide it",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: "at0231-layout-toggle-activate",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
            await app.waitForCondition<boolean>(
              `window.__tug.assertHostRootRegistered("A")`,
              { timeoutMs: 5_000 },
            );

            // Hidden → show and activate.
            await dispatch(app, "toggle-layout");
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(RAIL_PANE_SELECTOR)}) !== null`,
              { timeoutMs: 3_000 },
            );
            const railCardId = await app.evalJS<string | null>(
              `window.__tug.getActiveCardId()`,
            );
            expect(railCardId).not.toBe("A");
            expect(railCardId).not.toBeNull();

            // Put the first responder back on the free card: the rail is now
            // showing but not active — the middle state.
            await app.dispatchControlAction("focus-session-card", {
              cardId: "A",
            });
            expect(await app.evalJS<string | null>(`window.__tug.getActiveCardId()`)).toBe("A");

            // Showing but inactive → activate, and the rail stays up.
            await dispatch(app, "toggle-layout");
            expect(await app.evalJS<string | null>(`window.__tug.getActiveCardId()`)).toBe(
              railCardId,
            );
            expect(await railPaneExists(app)).toBe(true);

            // Showing and active → hide.
            await dispatch(app, "toggle-layout");
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(RAIL_PANE_SELECTOR)}) === null`,
              { timeoutMs: 3_000 },
            );
            expect(await railPaneExists(app)).toBe(false);
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
