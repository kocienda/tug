/**
 * at0040-multi-tab-close-confirm-plain.test.ts — title-bar X close
 * confirmation on the active pane, by plain click and by Option-click.
 *
 * One piece of the at0040 split; the deck shapes, selectors and gestures are
 * `multi-tab-close-confirm-fixture.ts`.
 *
 *   1. **Plain click, single-tab.** A card type that does not opt into
 *      `confirmClose` closes on the X at once, with no popover.
 *   2. **Plain click, multi-tab.** Click X → "Close N Tabs?" popover opens
 *      and STAYS open. Confirm ("Close All") closes the entire pane; cancel
 *      keeps it.
 *   3. **Option-click.** Option(alt)-click X → the pane closes immediately,
 *      no popover. The power-user escape hatch, single- and multi-tab alike.
 *
 * Case 2 also gates the "popover-flash" regression that motivated the
 * original pass: if `Popover.Trigger`'s auto-toggle ever ends up composed
 * onto the X button again, the popover briefly opens and immediately closes
 * via the toggle inverting the just-opened state on the trailing `click`
 * event. Any future change that reintroduces a Trigger on the X button would
 * fail this test on the "popover still present 300ms after click" assertion.
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
import { launchTugApp } from "./_harness";
import {
  CONFIRM_POPOVER_SELECTOR,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  activeSingleTabDeckShape,
  multiTabActiveDeckShape,
  optionClickElement,
  paneCloseButtonSelector,
  pause,
  popoverButtonByText,
} from "./multi-tab-close-confirm-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0040: title-bar X close confirmation — a uniform pane feature",
  () => {
    test(
      "case 1 — single-tab non-opt-in: plain X click closes immediately, no confirm",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c1-single-immediate" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: activeSingleTabDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          // Per-card policy: a single-tab pane confirms on close ONLY when its card
          // type opts in (`confirmClose: true`, e.g. the Session card). `gallery-input`
          // does not, so a plain X click closes the pane immediately — no popover.
          // (Multi-tab panes always confirm — see case 2.)
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
      "case 2 — multi-tab: X opens 'Close 2 Tabs?' popover and the popover STAYS open",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c2-multi-open" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: multiTabActiveDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          // The flash bug closed the popover within 1–2 frames.
          // Sleep past that window to gate that the popover holds.
          await pause(300);

          const popoverState = await app.evalJS<{ present: boolean; text: string | null }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
              if (el === null) return { present: false, text: null };
              return { present: true, text: el.textContent };
            })()`,
          );
          expect(
            popoverState.present,
            "confirm popover must still be in the DOM 300ms after the X click",
          ).toBe(true);
          expect(
            popoverState.text ?? "",
            "popover prompt must read 'Close 2 Tabs?'",
          ).toContain("Close 2 Tabs?");

          // Pane must still exist — confirm wasn't pressed.
          const paneStillExists = await app.evalJS<boolean>(
            `document.querySelector('[data-pane-id="p1"]') !== null`,
          );
          expect(paneStillExists, "pane must still exist while popover is open").toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 2 — multi-tab: confirming 'Close All' closes the entire pane",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c2-multi-confirm" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: multiTabActiveDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
            { timeoutMs: 2000 },
          );

          // Click the Close All button by text.
          await app.evalJS<void>(
            `(function(){
              var btn = ${popoverButtonByText("Close All")};
              if (btn === null) throw new Error("[at0040] Close All button missing");
              btn.click();
            })()`,
          );

          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 3 — Option-click on X closes a single-tab pane immediately, no popover",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c3-option-single" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: activeSingleTabDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );

          await optionClickElement(app, paneCloseButtonSelector("p1"));
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );

          // No popover ever rendered — Option-click bypasses it.
          const popoverPresent = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
          );
          expect(
            popoverPresent,
            "no confirm popover should render for an Option-click close",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 3 — Option-click on X closes a multi-tab pane immediately, no popover",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c3-option-multi" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: multiTabActiveDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await optionClickElement(app, paneCloseButtonSelector("p1"));
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );

          const popoverPresent = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
          );
          expect(
            popoverPresent,
            "no confirm popover should render for an Option-click close",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
