/**
 * at0404-title-bar-tooltips-state.test.ts — a title-bar control's tooltip
 * turns with the state it describes, and the hover wrapper leaves the control
 * working.
 *
 *   1. The phrase turns with the state it describes. In bullseye the button
 *      offers the way out; the width control names the width it is currently
 *      holding. A tooltip that read the same in both postures would be the
 *      resting lie the `aria-label` already avoids.
 *
 *   2. The composition survives. Two of these controls are popup-menu
 *      triggers and a third runs its own pointer-capture close protocol,
 *      so none of them can be a Radix tooltip trigger directly — the bubble
 *      anchors a span around each. The proof that the wrapper is inert is that
 *      the controls still work: this test opens the width menu through the
 *      same span it just hovered. (Option-click close, the gesture the direct
 *      composition broke, is held by at0040.)
 *
 * That each control names its act, and that its chord chip is read, is
 * `at0404-title-bar-tooltips-names`; the deck and the hover gestures are
 * `title-bar-tooltips-fixture.ts`.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/pane-title-bar-items-store.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/tug-action-tooltip.tsx
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 * @covers tugdeck/src/components/tugways/tug-tooltip.css
 * @family at0404-title-bar-tooltips
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import {
  AFTER_LAND_MS,
  BULLSEYE,
  FIXTURE_CONTENT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  WIDTH_BUTTON,
  WIDTH_MENU,
  cardChrome,
  deckShape,
  hoverPhrase,
  wait,
} from "./title-bar-tooltips-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0404 — a title-bar control's tooltip turns with its state",
  () => {
    test(
      "the phrase turns with the state, and the hover wrapper leaves the control working",
      async () => {
        const app = await launchTugApp({ testName: "at0404-title-bar-tooltips-state" });
        try {
          await app.seedDeckState({
            state: deckShape(),
            cardStates: {
              A: { content: { path: mkTextFixture("at0404-", FIXTURE_CONTENT).file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 2`,
            { timeoutMs: 5000 },
          );
          const chrome = await cardChrome(app);
          await wait(AFTER_LAND_MS);

          // The width control and the target both rest inside the pane's
          // rollup. The hovers below are dispatched straight at the anchors
          // and reach them either way, but the PRESSES are native and would
          // land on the bar behind a hidden row — so pin it open once here.
          await chrome.revealPaneControls();

          // --- The span is inert: the menu it wraps still opens. ----------
          // Pressing through a hovered wrapper is the whole risk of this
          // composition, so the press happens right after the hover.
          await hoverPhrase(chrome, WIDTH_BUTTON);
          await chrome.nativeClickAtElement(WIDTH_BUTTON);
          await chrome.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length > 0`,
            { timeoutMs: 5000 },
          );

          // Choose a preset: the pane takes a width, and the tooltip has a
          // fact to report that it did not have a moment ago.
          const chose = await chrome.evalJS<boolean>(
            `(function () {
              var row = Array.from(
                document.querySelectorAll(${JSON.stringify(WIDTH_MENU)} + " [role='menuitemradio']"),
              ).find(function (el) { return el.getAttribute("data-item-id") === "comfy"; });
              if (!row) return false;
              row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
              row.click();
              return true;
            })()`,
          );
          expect(chose, "the width menu offered its Comfy row").toBe(true);
          await chrome.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length === 0`,
            { timeoutMs: 8000 },
          );
          await wait(AFTER_LAND_MS);

          expect(
            await hoverPhrase(chrome, WIDTH_BUTTON),
            "the closed control cannot show its width, so the bubble does",
          ).toBe("Set this card's width — now Comfy");

          // --- Bullseye's phrase turns with the posture. ------------------
          await chrome.nativeClickAtElement(BULLSEYE);
          await chrome.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(BULLSEYE)}).getAttribute("aria-pressed") === "true"`,
            { timeoutMs: 8000 },
          );
          await wait(AFTER_LAND_MS);
          expect(
            await hoverPhrase(chrome, BULLSEYE),
            "in bullseye, the same button offers the way out",
          ).toBe("Take this card out of bullseye");

        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
