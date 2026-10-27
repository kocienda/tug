/**
 * at0755-deck-bulletin-evades-rails.test.ts — a deck bulletin is drawn above
 * every card and stands clear of the sidebar rails.
 *
 * The usage warning (`RateLimitBulletinBridge`) is a deck bulletin, and the
 * deck's stack sits at the window's top-right corner. Every card stands over
 * the shell's page, so a stack the shell drew there was covered by the card
 * beneath it — the Workspaces rail on the right covered most of a warning.
 * Now the shell relays each deck bulletin to the overlay page above the
 * cards (`overlay.bulletin`), and the stack's right offset carries the right
 * rail's reach (`overlay.bulletinInsets`), so it stands beside the rail
 * rather than over it.
 *
 * Scenario: on a deck with the right rail open, raise a deck bulletin from
 * the shell. It is drawn in the overlay page and not the shell's; its right
 * edge stands left of the rail's left edge; the overlay claims the pointer
 * over it, so its close button can be pressed. Hide the rail and the stack
 * goes back to the window's edge.
 *
 * @covers tugdeck/src/components/tugways/tug-bulletin.tsx
 * @covers tugdeck/src/overlay/overlay-root.tsx
 * @covers tugdeck/src/overlay/overlay-claim.ts
 * @covers tugdeck/src/lib/overlay-shell.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import { priorCardDeck } from "./_harness/shapes";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const RAIL_RIGHT = '.tug-pane[data-rail-side="right"]';
const TOAST = "[data-sonner-toast]";
const HOST = ".tug-bulletin-host";

/** The right rail's left edge in window px: the leftmost of its members. */
async function railLeft(app: App): Promise<number> {
  return app.evalJS<number>(
    `Math.min(...Array.from(document.querySelectorAll(${JSON.stringify(RAIL_RIGHT)}))
       .map((el) => el.getBoundingClientRect().left))`,
  );
}

/** The inset the overlay's stack carries for the right rail, in px. */
async function overlayInsetRight(overlay: BodyApp): Promise<number> {
  return overlay.evalJS<number>(
    `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(HOST)}))
       .getPropertyValue("--tug-bulletin-inset-right")) || 0`,
  );
}

/** The front toast's rect in the overlay, read once it has come to rest. */
async function restingToast(overlay: BodyApp): Promise<{ left: number; right: number; top: number }> {
  await overlay.waitForCondition<boolean>(
    `(function(){
       var t = document.querySelector(${JSON.stringify(TOAST)});
       if (!t || t.getAttribute("data-mounted") !== "true") return false;
       var a = t.getBoundingClientRect();
       var prev = window.__at0755Rect;
       window.__at0755Rect = a.left + "," + a.top;
       return prev === window.__at0755Rect;
     })()`,
    { timeoutMs: 5_000, pollMs: 150 },
  );
  return overlay.evalJS<{ left: number; right: number; top: number }>(
    `(function(){
       var r = document.querySelector(${JSON.stringify(TOAST)}).getBoundingClientRect();
       return { left: r.left, right: r.right, top: r.top };
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0755 — a deck bulletin evades the rails", () => {
  test(
    "is drawn in the overlay, beside an open right rail, and back at the edge once it closes",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0755-deck-bulletin-evades-rails",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(`window.__tug.assertHostRootRegistered("A")`, { timeoutMs: 5_000 });
          const overlay = await overlayReady(app);

          // Open the right rail: Workspaces and Layout default to that edge.
          await app.dispatchControlAction("toggle-rail", { value: "right" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(RAIL_RIGHT)}).length > 0`,
            { timeoutMs: 3_000 },
          );
          await overlay.waitForCondition<boolean>(
            `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(HOST)}))
               .getPropertyValue("--tug-bulletin-inset-right")) > 0`,
            { timeoutMs: 3_000 },
          );
          const edge = await railLeft(app);
          const inset = await overlayInsetRight(overlay);
          note(`right rail's left edge ${edge.toFixed(1)} px; the overlay stack's right inset ${inset} px`);

          // A deck bulletin raised in the shell, as the usage warning is.
          await app.evalJS<null>(`(window.__tug.raiseBulletin("Usage at 85%", "caution"), null)`);
          const toast = await restingToast(overlay);
          note(`toast at left ${toast.left.toFixed(1)}, right ${toast.right.toFixed(1)}, top ${toast.top.toFixed(1)}`);

          // Drawn above the cards, never in the shell's page beneath them.
          expect(await app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(TOAST)}).length`)).toBe(0);
          // Beside the rail, not over it.
          expect(toast.right).toBeLessThanOrEqual(edge);
          // Pressable: the overlay takes the pointer over the bulletin.
          await overlay.waitForCondition<boolean>(
            `document.documentElement.getAttribute("data-overlay-claim-state") === "rects"`,
            { timeoutMs: 3_000 },
          );

          // The rail goes: the stack returns to the window's edge.
          await app.dispatchControlAction("toggle-rail", { value: "right" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(RAIL_RIGHT)}).length === 0`,
            { timeoutMs: 3_000 },
          );
          await overlay.waitForCondition<boolean>(
            `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(HOST)}))
               .getPropertyValue("--tug-bulletin-inset-right")) === 0`,
            { timeoutMs: 3_000 },
          );
          const width = await overlay.evalJS<number>(`window.innerWidth`);
          const back = await restingToast(overlay);
          note(`toast back at right ${back.right.toFixed(1)} of ${width}`);
          expect(back.right).toBeGreaterThan(edge);
          expect(width - back.right).toBeLessThanOrEqual(32);
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
