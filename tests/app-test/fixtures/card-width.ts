/**
 * Setting a card's width from a test, through the door that still exists.
 *
 * Width had two doors: the title bar's width popup and the chords ⌃⌘1/2/3. The
 * chords were retired when the Tug tier's digits went to Go to Slot — setting
 * a width is a once-a-session act, and it was wearing an every-hour chord — so
 * the popup (and its Window-menu twin, which no test can drive) is what an
 * explicit width gesture is now.
 *
 * Four suites need to make one, for four different reasons: at0371 is about the
 * verb itself, at0372 uses it as a bullseye exit door, at0430 as a reflow door,
 * and any future one will want the same eight lines. So the sequence lives here
 * rather than being copied — a popup that scales in has to be waited for both
 * ways, and a Radix menu row answers a pointer PAIR rather than a bare
 * `click()`, which is exactly the kind of detail that rots differently in four
 * places.
 */

import { expect } from "bun:test";

import type { App } from "../_harness";

/** The width popup's own root, portalled out of the pane. */
const WIDTH_MENU = '[data-testid="tug-pane-title-bar-width-menu"]';

/** One pane's width button, which is the popup's trigger. */
export const widthButton = (paneId: string): string =>
  `[data-pane-id="${paneId}"] [data-testid="tug-pane-title-bar-width-button"]`;

/**
 * Open one pane's width popup and choose a preset, returning once the popup has
 * closed again.
 *
 * The caller waits for whatever it is measuring: this waits only for the popup,
 * because what "landed" means differs by suite — a settled frame width, a
 * cleared bullseye, a closed reflow episode.
 */
export async function chooseWidth(
  app: App,
  paneId: string,
  preset: "slim" | "comfy" | "wide",
): Promise<void> {
  await app.nativeClickAtElement(widthButton(paneId));
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length > 0`,
    { timeoutMs: 5_000 },
  );
  const chose = await app.evalJS<boolean>(
    `(function () {
      var row = Array.from(
        document.querySelectorAll(${JSON.stringify(WIDTH_MENU)} + " [role='menuitemradio']"),
      ).find(function (el) { return el.getAttribute("data-item-id") === ${JSON.stringify(preset)}; });
      if (!row) return false;
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      row.click();
      return true;
    })()`,
  );
  expect(chose, `the width menu offered its ${preset} row`).toBe(true);
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length === 0`,
    { timeoutMs: 8_000 },
  );
}
