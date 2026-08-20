/**
 * at9998-spike-dash-progress-look.test.ts — a throwaway render probe: mount
 * the Dash Progress spike and screenshot section 5 for design review.
 * Applied and removed by `tugutil file probe`; never lands.
 *
 * @covers tugdeck/src/spikes/spike-dash-progress.tsx
 */

import { describe, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

function deckShape() {
  return {
    cards: [
      {
        id: "G",
        componentId: "spike-dash-progress",
        title: "Dash Progress",
        closable: true,
      },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 860, height: 1400 },
        cardIds: ["G"],
        activeCardId: "G",
        title: "",
        acceptsFamilies: ["spike"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at9998 — spike render probe", () => {
  test(
    "section 5 renders",
    async () => {
      const app = await launchTugApp({
        testName: "at9998-spike-dash-progress-look",
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "G" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="G"] .spdp') !== null`,
          { timeoutMs: 20_000 },
        );
        await app.evalJS<null>(
          `(() => {
             const s = Array.from(document.querySelectorAll('[data-card-id="G"] .sp-section-title'))
               .find((el) => el.textContent.includes("5 ·"));
             if (s) s.scrollIntoView({ block: "start" });
             return null;
           })()`,
        );
        await new Promise((r) => setTimeout(r, 500));
        note("at9998 section 5", await app.screenshot().then((s) => s.path));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
