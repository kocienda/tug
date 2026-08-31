/**
 * at0501-rail-toggle.test.ts — the rail as a keyboard entity: ⌃⌘← and ⌃⌘→
 * show, focus and hide a whole SIDE of the deck.
 *
 * The chord addresses the rail rather than the card standing on it, which is
 * what lets the sidebar grow past the letters a per-card grammar could spend.
 * Control surface exercised (the same path the Maker ▸ Show Left/Right Rail
 * rows take):
 *
 *   - `toggle-rail` with `{ value: "left" | "right" }`
 *       → `action-dispatch` hands off to `toggle-rail:<side>`
 *       → the deck-canvas handler → `toggleSidebarRail()`, the three-state
 *         ladder: hidden → show + focus the side's z-frontmost member,
 *         showing but not holding the keyboard → focus that member,
 *         holding it → hide the whole side.
 *
 * Scenarios:
 *   1. On a deck with no rail, the chord opens the side and the keyboard
 *      lands in it; pressed again — the keyboard is now inside — it takes
 *      the side away.
 *   2. A side holding two members hides as a unit and comes back as one:
 *      the members standing at the hide are exactly the members the show
 *      brings back, which is what `RailArrangement.hidden` records. The
 *      side's order and shares are untouched throughout ([L23]).
 *   3. With the first responder elsewhere, the chord on a showing side
 *      activates its frontmost member rather than hiding it; only the
 *      press after that takes the side away.
 *   4. The real keystroke reaches it. The chord is spelled once, in the
 *      command table, and swept onto an empty-key-equivalent menu item — so
 *      the table's claim, the menu's spelling, and what AppKit actually
 *      delivers are three facts that could disagree. Pressing ⌃⌘→ for real is
 *      the only assertion that reads all three at once.
 *
 * The per-card rows (`toggle-lens` and its siblings) still run the card-level
 * ladder and are pinned by at0231; what changed for them is that they carry no
 * default chord, which at0168 asserts off the live menu.
 *
 * `deck-manager.ts` is deliberately NOT declared: `showSidebarRail` and
 * `hideSidebarRail` live there, but the module is already at its selection-fan
 * budget and the ladder this test is about is `sidebar-toggle.ts`'s. A change
 * to the deck manager's half reaches here through the twenty tests that do
 * name it.
 *
 * @covers tugdeck/src/sidebar-toggle.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
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

/** Every pane pinned to `side`. `data-lens` carries the edge a rail stands on
 *  and is absent once a card is dragged loose, so this counts exactly the
 *  members the chord addresses. */
const railSelector = (side: "left" | "right"): string =>
  `.tug-pane[data-lens="${side}"]`;

async function railCount(app: App, side: "left" | "right"): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(railSelector(side))}).length`,
  );
}

async function toggleRail(app: App, side: "left" | "right"): Promise<void> {
  await app.dispatchControlAction("toggle-rail", { value: side });
}

/** One free content card, so the ladder has somewhere to have come from and
 *  somewhere to go back to. */
function priorCardDeck() {
  return {
    cards: [
      {
        id: "A",
        componentId: "gallery-accordion",
        title: "Accordion",
        closable: true,
      },
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

describe.skipIf(!SHOULD_RUN)("at0501 — the rail toggle chords", () => {
  test(
    "the chord opens a side, lands the keyboard in it, and takes it away",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-open-close",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          expect(await railCount(app, "right")).toBe(0);

          // Hidden → show the side and focus its frontmost member. The deck's
          // sidebar cards default to the right edge, so the right chord is the
          // one with something to open on a factory deck.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length > 0`,
            { timeoutMs: 3_000 },
          );
          const opened = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(opened).not.toBe("A");
          expect(opened).not.toBeNull();

          // Holding the keyboard → hide the side.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 0`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(0);
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
    "a side hides as a unit and comes back holding the same members",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-membership",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Two members on the right, opened one card at a time through the
          // per-card rows — the door that still exists for them.
          await app.dispatchControlAction("toggle-lens");
          await app.dispatchControlAction("toggle-jots");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 2`,
            { timeoutMs: 3_000 },
          );
          const members = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(railSelector("right"))}))
               .map((el) => el.getAttribute("data-pane-id"))`,
          );
          expect(members).toHaveLength(2);

          // The keyboard is inside the side (opening Jots activated it), so
          // one press takes the whole side away — both members, not one.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 0`,
            { timeoutMs: 3_000 },
          );

          // And the show brings back exactly what was standing. A show that
          // read the side's stored ORDER instead would also resurrect a card
          // the user had closed by hand; a show with no memory at all would
          // bring back one.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 2`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(2);
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
    "a showing side takes the keyboard before it will hide",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-middle-state",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length > 0`,
            { timeoutMs: 3_000 },
          );
          const railCardId = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(railCardId).not.toBeNull();

          // Put the keyboard back on the free card: the side is showing but
          // does not hold it — the middle rung.
          await app.dispatchControlAction("focus-session-card", {
            cardId: "A",
          });
          expect(
            await app.evalJS<string | null>(`window.__tug.getActiveCardId()`),
          ).toBe("A");

          // Showing but not holding → focus it, and the side stays up.
          await toggleRail(app, "right");
          expect(
            await app.evalJS<string | null>(`window.__tug.getActiveCardId()`),
          ).toBe(railCardId);
          expect(await railCount(app, "right")).toBeGreaterThan(0);

          // Only now does the press take the side away.
          await toggleRail(app, "right");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 0`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(0);
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
    "the pressed chord reaches the side, not the web view's arrow handling",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0501-rail-pressed-chord",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          expect(await railCount(app, "right")).toBe(0);

          // ⌃⌘→ as a real keystroke. The macOS never-bind list reserves PLAIN
          // ⌃-arrows for Spaces and Mission Control, not the ⌘ composition —
          // an argument worth exactly as much as a running app pressing the
          // key and seeing the side open.
          await app.nativeKey("ArrowRight", ["ctrl", "cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length > 0`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(1);

          // And the same key closes it, so what the press reached is the
          // ladder rather than something that only ever opens.
          await app.nativeKey("ArrowRight", ["ctrl", "cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(railSelector("right"))}).length === 0`,
            { timeoutMs: 3_000 },
          );
          expect(await railCount(app, "right")).toBe(0);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
