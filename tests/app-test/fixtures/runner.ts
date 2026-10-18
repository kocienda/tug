/**
 * runner.ts — drive a COMMITTED fixture session through the production
 * session-card picker → spawn → reveal path, for behavior/correctness legs.
 *
 * The picker dance is never Tab/Tab/Enter — the picker's Enter fall-through
 * opens a NEW session. The source is a small committed fixture, so these
 * legs run everywhere and never touch the private live archive.
 *
 * Card A is a body, so every read of its picker and transcript is made in
 * A's own page: the picker is drawn there while the card is unbound, and the
 * spawn re-binds that same body in place.
 */

import { expect } from "bun:test";
import type { App, BodyApp } from "../_harness";
import { waitForBodyReady } from "../_harness/card-reach";
import type { SeededFixtureSession } from "./resolve";

export const PICKER_FORM = ".session-card-picker-form";
export const OPEN = '[data-tug-focus-key="session-picker-cycle:5"]';
export const TRANSCRIPT =
  '[data-card-id="A"] [data-testid="session-card-transcript"]';
/** The scroll container CardHost captures/restores under this region key. */
export const SCROLLER =
  '[data-card-id="A"] [data-tug-scroll-key="session-card-transcript"]';

export const rowSel = (id: string): string => `[data-session-id="${id}"]`;

export function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
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

function clickElement(page: App | BodyApp, selector: string): Promise<boolean> {
  return page.evalJS<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return false;
      el.scrollIntoView({ block: "nearest" });
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
}

/**
 * Set the picker's project-path combo box to `path` via a React-compatible
 * value write (the native `HTMLInputElement.value` setter + an `input` event),
 * then blur so the dropdown the typing opened doesn't overlay the sessions list.
 * Returns false if the field isn't present.
 */
function setPickerPath(page: App | BodyApp, path: string): Promise<boolean> {
  return page.evalJS<boolean>(
    `(function(){
      var input = document.querySelector(".session-card-picker-form input");
      if (input === null) return false;
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(path)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      return true;
    })()`,
  );
}

export interface OpenFixtureOpts {
  /** Saved card-state bag to inject (Phase B restore). */
  cardStates?: Record<string, unknown>;
  listTimeoutMs?: number;
  /**
   * Run in card A's body once the picker stands, before Open is clicked —
   * the earliest point a probe can be armed in the page the session card
   * will come up in.
   */
  beforeOpen?: (page: BodyApp) => Promise<void>;
}

/**
 * Seed the deck (optionally with a restore bag), drive the picker to the
 * seeded fixture, and click Open. Returns when Open has been clicked —
 * call {@link waitForTranscriptSettled} next.
 */
export async function openFixtureSession(
  app: App,
  seeded: SeededFixtureSession,
  opts: OpenFixtureOpts = {},
): Promise<{ openedAt: number }> {
  await app.seedDeckState({
    state: deckShape(),
    ...(opts.cardStates ? { cardStates: opts.cardStates } : {}),
    focusCardId: "A",
  });
  const page = await waitForBodyReady(app, "A");
  await page.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
    { timeoutMs: 8000 },
  );
  // The recents now seed the path combo box's dropdown (not a separate list).
  // The picker one-shot-seeds the field from the host hint on mount, so it can't
  // be assumed to hold the seeded project dir — drive the field directly with a
  // React-compatible value write (the native setter + an `input` event), then
  // blur so the combo box dropdown the typing opened doesn't overlay the list.
  expect(await setPickerPath(page, seeded.projectDir)).toBe(true);
  await page.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(".session-card-picker-form input");
      return el !== null && el.value === ${JSON.stringify(seeded.projectDir)};
    })()`,
    { timeoutMs: 8000 },
  );
  await page.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(rowSel(seeded.sessionId))}) !== null`,
    { timeoutMs: opts.listTimeoutMs ?? 15_000 },
  );

  expect(await clickElement(page, rowSel(seeded.sessionId))).toBe(true);
  await page.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(rowSel(seeded.sessionId))});
      return el !== null && el.getAttribute("data-selected") === "true";
    })()`,
    { timeoutMs: 6000 },
  );

  if (opts.beforeOpen !== undefined) await opts.beforeOpen(page);
  const openedAt = Date.now();
  expect(await clickElement(page, OPEN)).toBe(true);
  return { openedAt };
}

/** How long the transcript's height must stand still to count as settled. */
const SETTLED_HEIGHT_HOLD_MS = 500;

/**
 * Wait until the resumed transcript has settled: replay done, scroller
 * mounted, content scrollable (scrollHeight exceeds the viewport), and its
 * height held still for a beat.
 *
 * Scrollable is not settled. Rows go on measuring after the list first
 * overflows, and a scroll written into that window has the rows above it grow
 * under it: the scroller keeps the reader's place, so `scrollTop` moves by
 * the growth, and a test holding the number it wrote is holding a place the
 * reader no longer has. The height standing unchanged for
 * {@link SETTLED_HEIGHT_HOLD_MS} is what says the layout is done.
 */
export async function waitForTranscriptSettled(
  app: App,
  timeoutMs = 20_000,
): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var host = document.querySelector(${JSON.stringify(TRANSCRIPT)});
      if (host === null || host.hasAttribute("data-replaying")) return false;
      var el = document.querySelector(${JSON.stringify(SCROLLER)});
      if (el === null) return false;
      if (el.scrollHeight <= el.clientHeight + 200) return false;
      var now = performance.now();
      var seen = window.__tugTranscriptHeightSeen;
      if (seen === undefined || seen.el !== el || seen.height !== el.scrollHeight) {
        window.__tugTranscriptHeightSeen = { el: el, height: el.scrollHeight, at: now };
        return false;
      }
      return now - seen.at >= ${SETTLED_HEIGHT_HOLD_MS};
    })()`,
    { timeoutMs },
  );
}
