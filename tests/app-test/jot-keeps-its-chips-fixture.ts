/**
 * jot-keeps-its-chips-fixture.ts — the decks, selectors and gestures the
 * at0527-jot-keeps-its-chips-* files share: opening a jot's editor, pasting
 * with an empty `clipboardData` the way Tug.app's real paste arrives, reading
 * the atom sidecar back off the real pasteboard, and reading `jots.json`.
 *
 * @module tests/app-test/jot-keeps-its-chips-fixture
 */

import { readFileSync } from "node:fs";
import type { App, BodyApp } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
export const SID = "at0527-session";

/** U+FFFC, the object-replacement char an atom stands at. */
export const OBJ = "￼";

export const FILE_NAME = "knobs.ts";
export const FILE_BODY = ["export const knobs = {", "  flash: 1500,", "};", ""].join("\n");

export const JOTS_KBD = `.jots-card .jots-list[data-key-view-kbd]`;
export const EDITOR = `.jots-list .jot-editor`;
export const JOT_CONTENT = `${EDITOR} .cm-content`;
export const JOT_CHIP = `${JOT_CONTENT} img[data-atom-type="file"]`;
export const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

/** A sentinel so "the copy never happened" is distinguishable from a real one. */
export const COPY_SENTINEL = "at0527-sentinel-nothing-copied";

export interface JotsFile {
  jots: Array<{
    id: string;
    text: string;
    atoms?: Array<{ position: number; type: string; label: string; value: string }>;
  }>;
}

export function sessionDeck() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

/** A deck with no session in it — the relaunch needs a card, not a project. */
export function plainDeck() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
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

/** Center a span in the scroller before a native click reaches for it. */
export const revealJS = (selector: string) =>
  `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.scrollIntoView({ block: "center" });
    return true;
  })()`;

/** The viewport point of a menu item, or `null` when it is not open. */
export const menuItemPointJS = (action: string) =>
  `(function(){
    var item = document.querySelector('[data-item-action=${action}]');
    if (item === null) return null;
    var r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;

/** The chips in a CM6 field, as `type:value` — the identity a copy reads. */
export const chipsJS = (selector: string) =>
  `JSON.stringify(Array.prototype.map.call(
    document.querySelectorAll(${JSON.stringify(selector)} + ' img:not(.cm-widgetBuffer)'),
    function (img) {
      return (img.getAttribute("data-atom-type") || "")
        + ":" + (img.getAttribute("data-atom-value") || "");
    }))`;

/** The flat text of a CM6 field, lines joined — what a reader would see. */
export const flatTextJS = (selector: string) =>
  `Array.prototype.map.call(
     document.querySelectorAll(${JSON.stringify(selector)} + ' .cm-line'),
     function (l) { return l.textContent || ""; }).join("")`;

/**
 * Reveal the Jots card and wait for its first row.
 */
export async function openJotsCard(app: App, jots: App | BodyApp = app): Promise<void> {
  await app.dispatchControlAction("toggle-jots");
  await jots.waitForCondition<boolean>(
    `document.querySelector('.jots-card .jot-row-label') !== null`,
    { timeoutMs: 8_000 },
  );
}

/**
 * Click the first row and Enter into its editor — the ordinary route a person
 * takes, and the one at0241 pins. `jots` is the page holding the Jots card;
 * the keys go to the app, whose key window routes them there.
 */
export async function enterFirstJotEditor(app: App, jots: App | BodyApp = app): Promise<void> {
  await jots.nativeClickAtElement(".jots-card .jot-row-label");
  await jots.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
    { timeoutMs: 5_000 },
  );
  await app.nativeKey("Return");
  await jots.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
    { timeoutMs: 5_000 },
  );
}

/** The card and the row in one gesture, for the phases that need both. */
export async function openFirstJotEditor(app: App, jots: App | BodyApp = app): Promise<void> {
  await openJotsCard(app, jots);
  await enterFirstJotEditor(app, jots);
}

/**
 * A paste with an EMPTY `clipboardData` — the shape of the real gesture inside
 * Tug.app, where everything the paste needs is on the pasteboard and none of it
 * is in the event, because WebKit hides a private pasteboard type from the DOM.
 */
export async function pasteInto(page: App | BodyApp, selector: string): Promise<void> {
  await page.focusElement(selector);
  await page.evalJS<null>(`(function(){
    var cm = document.querySelector(${JSON.stringify(selector)});
    cm.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
    }));
    return null;
  })()`);
}

/** Read the atom sidecar back off the REAL pasteboard, through the parser. */
export async function readSidecar(
  app: App,
): Promise<{ text: string; atoms: Array<{ type: string; label: string; value: string }> } | null> {
  // The read is async (the native bridge calls back) and `evalJS` cannot
  // return a promise, so kick it off, park the result, and poll.
  await app.evalJS<null>(
    `(window.__at0527sidecar = undefined,
      window.__tug.readClipboardAtoms().then(function (r) {
        window.__at0527sidecar = JSON.stringify(r);
      }),
      null)`,
  );
  await app.waitForCondition<boolean>(`window.__at0527sidecar !== undefined`, {
    timeoutMs: 8_000,
  });
  return JSON.parse(await app.evalJS<string>(`window.__at0527sidecar`)) as {
    text: string;
    atoms: Array<{ type: string; label: string; value: string }>;
  } | null;
}

/** Poll the jots file until it parses — the save is temp-file + rename. */
export function readJotsFile(path: string, timeoutMs: number): Promise<JotsFile | null> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    let last: JotsFile | null = null;
    while (Date.now() < deadline) {
      try {
        last = JSON.parse(readFileSync(path, "utf8")) as JotsFile;
        if ((last.jots[0]?.atoms ?? []).length > 0) return last;
      } catch {
        // Mid-write — read again.
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  })();
}
