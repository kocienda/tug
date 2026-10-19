/**
 * at0040-multi-tab-close-confirm-inactive.test.ts — title-bar X close
 * confirmation on a pane that is not simply the active one in view: a
 * background pane, a pane half out of the band, and a sidebar card.
 *
 * One piece of the at0040 split; the deck shapes, selectors and gestures are
 * `multi-tab-close-confirm-fixture.ts`.
 *
 *   4. **Inactive pane.** Click X on a background pane → the pane comes
 *      forward (activates) AND the confirm popover opens where the card
 *      confirms. The user needs to see what they are about to discard. The X
 *      button carries no `data-no-activate`.
 *   5. **Half out of the band.** An ALREADY-ACTIVE pane straddling the
 *      band's near edge is brought whole into view BEFORE the popover opens.
 *      The question is asked on the card it is about: a popover hung off a
 *      title bar that is itself half off the band can be clipped by that
 *      edge. Case 4 is why the fixture's pane must already be active — an
 *      inactive pane's X activates it, and activation has always committed a
 *      reveal of its own, so only an active pane isolates the close's own
 *      reveal.
 *   6. **A sidebar card asks.** A rail card confirms whatever its
 *      registration says about `confirmClose`. A rail is a singleton the deck
 *      keeps one of, its X sits on a bar the reader is already pointing at
 *      for the resize edge and the stack badge, and nothing visible remains
 *      afterwards to say what went. The policy is the pane's, not an opt-in
 *      each rail card repeats.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/card-close-guard.ts
 * @covers tugdeck/src/components/tugways/tug-confirm-popover.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/deck-manager.ts
 * @family at0040-multi-tab-close-confirm
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  AFTER_SETTLE_MS,
  CONFIRM_POPOVER_SELECTOR,
  HALF_PANE_OFFSET_PX,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TOL,
  band,
  flowDeckShape,
  inactiveMultiTabDeckShape,
  inactiveSingleTabDeckShape,
  paneCloseButtonSelector,
  paneRect,
  pause,
  popoverButtonByText,
  railDeckShape,
} from "./multi-tab-close-confirm-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0040: title-bar X close confirmation — a uniform pane feature",
  () => {
    test(
      "case 4 — inactive single-tab non-opt-in: X click closes the pane, no confirm",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c4-inactive-single" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: inactiveSingleTabDeckShape(),
            focusCardId: "C",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("C")`,
          );

          // Sanity: C is the active card (foreground pane); p1 (A) is inactive.
          const activeBefore = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(activeBefore, "C must be active before the click").toBe("C");

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          // Per-card policy: `gallery-input` does not opt into confirm, so even an
          // inactive single-tab pane closes immediately on the X click — no popover.
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );
          const popoverPresent = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
          );
          expect(
            popoverPresent,
            "no confirm popover should render for a non-opt-in single-tab pane",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 4 — inactive multi-tab: X activates the pane AND opens the confirm popover",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c4-inactive-multi" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: inactiveMultiTabDeckShape(),
            focusCardId: "C",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B") && window.__tug.assertHostRootRegistered("C")`,
          );

          // Sanity: C is the active card; p1 (containing A+B) is
          // the background pane.
          const activeBefore = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(activeBefore, "C must be active before the click").toBe("C");

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));
          await pause(300);

          // After the click, p1's active card (A) must be the new
          // first responder — clicking X on an inactive pane brings
          // the pane forward.
          const activeAfter = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(
            activeAfter,
            "case 4: A must be active — clicking X on an inactive pane must bring it forward",
          ).toBe("A");

          // And the popover must be open with the right prompt.
          const popoverState = await app.evalJS<{ present: boolean; text: string | null }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
              if (el === null) return { present: false, text: null };
              return { present: true, text: el.textContent };
            })()`,
          );
          expect(popoverState.present, "popover must be open").toBe(true);
          expect(popoverState.text ?? "", "popover must read 'Close 2 Tabs?'").toContain(
            "Close 2 Tabs?",
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 5 — an active pane half out of the band is brought whole in before the confirm opens",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c5-reveal-before-confirm" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: flowDeckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await pause(AFTER_SETTLE_MS);

          // ── The fixture earns its assertion ─────────────────────────────
          const bandBox = await band(app);
          // The strip half a pane under the band. A wheel pan cannot place it
          // there any more — it jumps a whole slot, so 350 px of wheel moves
          // the deck 705 — so the deck is seeded again with the offset, and
          // without a focus card, so no activation runs its reveal over it.
          await app.seedDeckState({
            state: { ...flowDeckShape(), flowOffset: HALF_PANE_OFFSET_PX },
          });
          await pause(AFTER_SETTLE_MS);
          const before = await paneRect(app, "p1");
          const offsetBefore = await app.evalJS<number>(
            `window.tugdeck.diag.getDeckState().flowOffset || 0`,
          );
          note(
            `[at0040] band [${bandBox.left.toFixed(1)}, ${bandBox.right.toFixed(1)}]; ` +
              `p1 before [${before.left.toFixed(1)}, ${before.right.toFixed(1)}]; ` +
              `flowOffset ${offsetBefore}`,
          );
          expect(
            before.left,
            "fixture: p1 must straddle the band's near edge before the click",
          ).toBeLessThan(bandBox.left - TOL);
          expect(
            before.right,
            "fixture: p1's trailing edge — and its X — must still be inside the band",
          ).toBeGreaterThan(bandBox.left + TOL);
          const activeBefore = await app.evalJS<string | undefined>(
            `window.tugdeck.diag.getDeckState().activePaneId`,
          );
          expect(
            activeBefore,
            "fixture: p1 must already be active, so no activation reveal can run",
          ).toBe("p1");

          // ── The gesture ─────────────────────────────────────────────────
          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
            { timeoutMs: 5000 },
          );

          const after = await paneRect(app, "p1");
          note(`[at0040] p1 after [${after.left.toFixed(1)}, ${after.right.toFixed(1)}]`);
          expect(
            after.left,
            "p1's near edge must be inside the band by the time the question is asked",
          ).toBeGreaterThanOrEqual(bandBox.left - TOL);
          expect(
            after.right,
            "p1's far edge must be inside the band too — revealed WHOLE, not nudged",
          ).toBeLessThanOrEqual(bandBox.right + TOL);

          // The popover is what the travel was for, so it has to be readable.
          const popover = await app.evalJS<{
            left: number;
            width: number;
            text: string;
          }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
              var b = el.getBoundingClientRect();
              return { left: b.left, width: b.width, text: el.textContent || "" };
            })()`,
          );
          expect(popover.text, "the question is the pane's own").toContain(
            "Close 2 Tabs?",
          );
          expect(
            popover.left,
            "the popover must not be clipped by the window's near edge",
          ).toBeGreaterThanOrEqual(0);
          expect(popover.width, "the popover must have been laid out").toBeGreaterThan(0);

          const paneStillThere = await app.evalJS<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="p1"]') !== null`,
          );
          expect(
            paneStillThere,
            "the pane must survive an unanswered question",
          ).toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 6 — a sidebar card's X asks first, and closes only on the answer",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c6-sidebar-confirm" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: railDeckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="pRail"]') !== null`,
            { timeoutMs: 8000 },
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("pRail"));

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
            { timeoutMs: 5000 },
          );
          const text = await app.evalJS<string>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}).textContent || ""`,
          );
          expect(text, "a rail card asks the single-card question").toContain(
            "Close Layout?",
          );
          const railStanding = await app.evalJS<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="pRail"]') !== null`,
          );
          expect(
            railStanding,
            "the rail must still stand while the question is unanswered",
          ).toBe(true);

          await app.evalJS<null>(
            `(function(){
              var btn = ${popoverButtonByText("Close")};
              if (btn === null) throw new Error("[at0040] Close button missing");
              btn.click();
              return null;
            })()`,
          );

          await app.waitForCondition<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="pRail"]') === null`,
            { timeoutMs: 5000 },
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
