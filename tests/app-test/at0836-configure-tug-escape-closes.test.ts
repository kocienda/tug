/**
 * at0836-configure-tug-escape-closes — Escape closes the on-demand Configure
 * Tug wizard, the way it closes every other dialog (issue #173).
 *
 * The wizard opened from Tug ▸ Configure Tug… on a set-up machine is the
 * user's to close: it shows Done, and Escape is the same act. The keyboard's
 * Escape reaches the overlay page as the `cancelDialog` command, dispatched
 * at capture; nothing in the wizard answered it, so the overlay forwarded it
 * to the shell and Radix's `onEscapeKeyDown` never ran, and the panel stayed
 * up. The wizard now answers `cancelDialog` as a chain responder.
 *
 * Reached through `dispatchControlAction("configure-tug")`, the action the menu
 * item posts, because the blocking wizard is suppressed under the harness. It
 * needs a machine that is set up and logged in, so Done is offered.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const SETUP = '[data-slot="configure-tug"]';
const SETUP_DONE = `${SETUP} .tug-alert-actions [data-slot="tug-push-button"]`;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "gallery-input", title: "A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 900, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("AT0836: Escape closes the on-demand Configure Tug wizard", () => {
  test(
    "a native Escape takes the wizard down and frees the app",
    async () => {
      const app = await launchTugApp({ testName: "at0836-configure-tug-escape-closes" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        const overlay = await overlayReady(app);

        await app.evalJS<null>(`(window.__tug.dispatchControlAction("configure-tug", {}), null)`);
        await overlay.waitForCondition<boolean>(present(SETUP_DONE), { timeoutMs: 8000 });
        note("at0836", "the on-demand wizard is up, offering Done");

        await app.nativeKey("Escape");
        await overlay.waitForCondition<boolean>(`!(${present(SETUP)})`, { timeoutMs: 3000 });
        expect(await overlay.evalJS<boolean>(present(SETUP)), "Escape closed the wizard").toBe(false);
        await overlay.waitForCondition<boolean>(
          `document.body.style.pointerEvents !== "none"`,
          { timeoutMs: 3000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
