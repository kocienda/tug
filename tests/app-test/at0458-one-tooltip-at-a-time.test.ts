/**
 * at0458-one-tooltip-at-a-time.test.ts — two bubbles never stand at once,
 * not even when one tooltip's trigger is nested inside another's.
 *
 * A tooltip answers "what is the thing under the pointer". There is one such
 * thing, so there is one answer. Two bubbles overlap, describe different
 * targets, and leave the reader no way to tell which one the pointer earned.
 *
 * Radix has its own arbitration — every open broadcasts a document event that
 * closes the other open contents — and for a row of separate controls that is
 * enough. It cannot reach the case this test drives. Radix registers the close
 * listener from an effect inside the bubble's content, so a tooltip that has
 * just decided to open is not yet listening when a second one broadcasts. Two
 * opens in the same tick therefore both survive.
 *
 * Nested triggers make that the ordinary case rather than a race. A History
 * row wraps its whole commit line in a tip and carries a session citation chip
 * INSIDE that line with a tip of its own. `pointermove` bubbles, so one pointer
 * motion arms both open timers at the same instant — and before
 * `lib/open-tooltip-registry`, both bubbles painted, the commit tip lying
 * across the shade over the session tip.
 *
 * Two things are asserted, in this order, because the second is what makes the
 * first worth having:
 *
 *   1. Exactly one bubble stands.
 *   2. It is the CHIP's, not the row's. The rule is specificity, not recency:
 *      the bubble describing the smaller thing the pointer is actually on wins,
 *      whichever open timer happened to fire first. A rule that read "last one
 *      in takes it" would satisfy (1) and still show the reader the wrong
 *      answer half the time.
 *
 * Driven against the real History shade over this worktree — the repo tugcast
 * serves as its bootstrap `--source-tree`, the same footing at0239 stands on —
 * because the nesting under test is a real composition of two shipping
 * surfaces, not a shape assembled for the test.
 *
 * Hover is synthesized as at0404 does it: a `pointerenter` plus a `pointermove`
 * on the trigger, dispatched on the chip so the move bubbles to the commit
 * line's trigger exactly as a real pointer's would.
 *
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 * @covers tugdeck/src/lib/open-tooltip-registry.ts
 * @covers tugdeck/src/components/tugways/commit-presentation.tsx
 * @covers tugdeck/src/components/tugways/tug-history-list.tsx
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const VIEW = '[data-slot="session-history-view"]';
const ROW = `${VIEW} [data-testid="session-history-commit"]`;
/** The citation chip: a tooltip trigger INSIDE the commit line's trigger. */
const CHIP = `${ROW} .tug-history-list-session-chip`;

/**
 * How many bubbles are showing. A closing Radix tooltip stays mounted for its
 * exit animation, so the count is of bubbles NOT in the closed state — the
 * question is what the reader sees, and a bubble on its way out is on screen
 * either way in a window that runs no rAF.
 */
const OPEN_BUBBLES =
  'document.querySelectorAll(\'[data-slot="tug-tooltip"]:not([data-state="closed"])\').length';

/**
 * Well past the open delay (900ms), because the interesting answer is a
 * NEGATIVE one — a shorter wait would prove only that the second bubble had
 * not arrived yet.
 */
const PAST_THE_DELAY_MS = 2500;

const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)(
  "at0458 — one tooltip on screen, ever",
  () => {
    test(
      "a citation chip nested in a commit line raises its bubble and only its bubble",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
          const app = await launchTugApp({
            testName: "at0458-one-tooltip-at-a-time",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
              timeoutMs: 5_000,
            });

            await app.seedDeckState({
              state: {
                cards: [
                  { id: "D", componentId: "session", title: "Session", closable: true },
                ],
                panes: [
                  {
                    id: "pD",
                    position: { x: 40, y: 40 },
                    size: { width: 900, height: 620 },
                    cardIds: ["D"],
                    activeCardId: "D",
                    title: "",
                    acceptsFamilies: ["maker"],
                  },
                ],
                activePaneId: "pD",
                hasFocus: true,
              },
              focusCardId: "D",
            });
            await app.waitForCondition<boolean>(
              `window.__tug.assertHostRootRegistered("D")`,
              { timeoutMs: 5_000 },
            );

            await app.bindSession("D", { projectDir: REPO });
            await app.dispatchControlAction("toggle-history-view");
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length > 0`,
              { timeoutMs: 6_000 },
            );

            // The chips resolve a step behind the rows: the row renders from
            // the git log, the citation from the session the commit named.
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(CHIP)}).length > 0`,
              { timeoutMs: 6_000 },
            );

            // Hover the chip. Its `pointermove` bubbles to the commit line's
            // trigger too, arming both open timers in one tick — the gesture
            // that used to paint two bubbles.
            await app.evalJS<null>(
              `(function () {
                var chip = document.querySelector(${JSON.stringify(CHIP)});
                chip.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
                chip.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
                return null;
              })()`,
            );
            await wait(PAST_THE_DELAY_MS);

            expect(
              await app.evalJS<number>(OPEN_BUBBLES),
              "bubbles standing after hovering the nested chip",
            ).toBe(1);

            // And it is the chip's own bubble: an open Radix tooltip points its
            // trigger's aria-describedby at the announced copy inside its
            // content, so the link is the trigger's own statement of which
            // bubble is its.
            const chipOwnsIt = await app.evalJS<boolean>(
              `(function () {
                var chip = document.querySelector(${JSON.stringify(CHIP)});
                var id = chip.getAttribute("aria-describedby");
                if (!id) return false;
                var announced = document.getElementById(id);
                return announced !== null &&
                  announced.closest('[data-slot="tug-tooltip"]') !== null;
              })()`,
            );
            expect(chipOwnsIt, "the standing bubble is the chip's").toBe(true);
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
