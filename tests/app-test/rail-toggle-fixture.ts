/**
 * rail-toggle-fixture.ts — the constants and readers the at0501-rail-toggle-*
 * files share: the rail selector, the rail count and the toggle.
 *
 * The rail as a keyboard entity: ⌃⌘← and ⌃⌘→ show, focus and hide a whole
 * SIDE of the deck.
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
 * Scenarios, one file each:
 *   1. `-open-close`: on a deck with no rail, the chord opens the side and
 *      the keyboard lands in it; pressed again — the keyboard is now inside —
 *      it takes the side away.
 *   2. `-membership`: a side holding two members hides as a unit and comes
 *      back as one: the members standing at the hide are exactly the members
 *      the show brings back, which is what `RailArrangement.hidden` records.
 *      The side's order and shares are untouched throughout ([L23]).
 *   3. `-middle-state`: with the first responder elsewhere, the chord on a
 *      showing side activates its frontmost member rather than hiding it;
 *      only the press after that takes the side away.
 *   4. `-pressed-chord`: the real keystroke reaches it. The chord is spelled
 *      once, in the command table, and swept onto an empty-key-equivalent
 *      menu item — so the table's claim, the menu's spelling, and what AppKit
 *      actually delivers are three facts that could disagree. Pressing ⌃⌘→
 *      for real is the only assertion that reads all three at once.
 *
 * The per-card rows (`toggle-cards` and its siblings) still run the card-level
 * ladder and are pinned by at0231; what changed for them is that they carry no
 * default chord, which at0168 asserts off the live menu.
 *
 * `deck-manager.ts` is deliberately NOT declared by the test files:
 * `showSidebarRail` and `hideSidebarRail` live there, but the module is
 * already at its selection-fan budget and the ladder these tests are about is
 * `sidebar-toggle.ts`'s. A change to the deck manager's half reaches here
 * through the twenty tests that do name it.
 *
 * Split out of `at0501-rail-toggle.test.ts` when that file was cut one test
 * to a file so each launch fits its own budget.
 *
 * @module tests/app-test/rail-toggle-fixture
 */

import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;

/** Every pane pinned to `side`. `data-rail-side` carries the edge a rail stands on
 *  and is absent once a card is dragged loose, so this counts exactly the
 *  members the chord addresses. */
export const railSelector = (side: "left" | "right"): string =>
  `.tug-pane[data-rail-side="${side}"]`;

export async function railCount(app: App, side: "left" | "right"): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(railSelector(side))}).length`,
  );
}

export async function toggleRail(app: App, side: "left" | "right"): Promise<void> {
  await app.dispatchControlAction("toggle-rail", { value: side });
}
