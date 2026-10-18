/**
 * _row-12.ts — what the pieces of row 12 share: Z2, the composer, paste and
 * the picker-to-body handoff work in a body.
 *
 * The bar's twelfth row ([B02] row 12), on one body session card bound to a
 * stub session of two turns:
 *
 * - **Z2** — the status bar stands in the body with its telemetry cells,
 *   and after a turn its per-turn cells carry values.
 * - **The composer** — a prompt typed through the session tap and sent
 *   with Return replays the stub's next turn: the entry's phase leaves
 *   idle, a transcript entry arrives, and the phase comes back to idle.
 * - **Paste** — text put on the real pasteboard lands in the body's
 *   composer on ⌘V; a PNG put on the real pasteboard lands as an image
 *   attachment, through the composer's own paste handler.
 * - **The picker handoff** — ⇧⌘I from inside the body asks the host for
 *   its file panel; the panel is driven by keyboard to a file the test
 *   wrote, and the path comes back to the body that asked, as a file atom
 *   in its composer, with the keyboard back in that body.
 * - **The slash popup** — Session › Open Command Picker raises the body's
 *   completion popup, and an Escape posted through the session tap closes
 *   it ([F17]'s assertion).
 *
 * Every other kind that is a body with a field of its own is read the same
 * way: the Overview's composer takes typing, a text paste and an image
 * paste as an attachment in its body.
 *
 * The pieces: `row-12-composer-session-send` and
 * `row-12-composer-session-panel` (the Session body) and
 * `row-12-composer-kinds` (the Overview's composer in its body).
 */

import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { PROMPT_INPUT, bodyOf, composerFocused, composerText, focusBody, pollFor, promptPhase, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const TEST_NAME = "body-grounding-row-12-composer";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/**
 * How a piece launches, stated in the piece itself: every row-12 launch
 * takes the screen, and `@foreground` is read off the file that says so.
 */
export interface Launch {
  foreground: boolean;
}

const A = "row12-a";
const SETTLE_MS = 8_000;
const TURN_MS = 120_000;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const STATUS_CELLS = '[data-slot="session-card-status-bar"] [data-slot="tug-status-cell"]';
const PHASE_CELL = '[data-slot="session-telemetry-phase"]';
const PER_TURN_DURATION = '[data-slot="session-telemetry-per-turn-duration"]';
const Z2_TIME_CELL = '[data-slot="session-card-status-bar"] [data-slot="tug-status-cell"][data-priority="time"]';
const Z2_SURFACE = '[data-slot="tug-popover"], [data-slot="tug-placard"]';
const TRANSCRIPT_ENTRY = '[data-slot="tug-transcript-entry"]';
const ATTACHMENT_TILE = '[data-slot="tug-attachment-preview__tile"]';
const SLASH_POPUP = '[data-slot="tug-completion-menu"]';
const PASTED_TEXT = "row12 pasted text";
/** A 2×2 PNG, enough for the composer's image paste path. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYZAB3xBP0u7gqmAAAAAElFTkSuQmCC";

/** In a page: the slash popup stands and is shown (it is hidden, not removed, when it closes). */
const slashPopupShown = `(function () {
  var p = document.querySelector(${JSON.stringify(SLASH_POPUP)});
  if (p === null) return false;
  if (getComputedStyle(p).display === "none") return false;
  return p.getBoundingClientRect().height > 0;
})()`;
/** In a page: file atoms in the composer, by label. */
const fileAtomLabels = `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(`${PROMPT_INPUT} [data-atom-type="file"]`)})).map(function (a) { return a.getAttribute("data-atom-label"); }))`;
/** In a page: count a capture-phase keydown listener has seen since it was armed. */
/** In a page: the composer holds no text (CodeMirror shows its placeholder in an empty doc). */
const composerIsEmpty = `(function () { var v = document.querySelector(${JSON.stringify(PROMPT_INPUT)}); if (v === null) return false; return v.querySelector(".cm-placeholder") !== null || v.textContent === ""; })()`;
const armKeyCounter = `(window.__row12Keys = 0, window.addEventListener("keydown", function () { window.__row12Keys += 1; }, true), true)`;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [
      {
        id: `${A}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 900, height: 720 },
        cardIds: [A],
        activeCardId: A,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${A}-pane`,
    hasFocus: true,
  };
}

/** Put `text` on the real pasteboard. */
function pasteboardText(text: string): void {
  const result = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text, "utf8") });
  expect(result.exitCode, "pbcopy wrote the pasteboard").toBe(0);
}

/** Put the PNG at `path` on the real pasteboard as an image. */
function pasteboardImage(path: string): void {
  const result = Bun.spawnSync(["osascript", "-e", `set the clipboard to (read (POSIX file ${JSON.stringify(path)}) as «class PNGf»)`]);
  expect(result.exitCode, `the pasteboard took the PNG: ${result.stderr.toString()}`).toBe(0);
}

/** Empty the body's composer from the keyboard. */
async function clearComposer(app: App, cardId: string): Promise<void> {
  await app.nativeKey("a", ["cmd"]);
  await app.nativeKey("Backspace");
  const empty = await pollFor(() => app.body(cardId).evalJS<boolean>(composerIsEmpty), (v) => v, SETTLE_MS);
  expect(empty, `${cardId}'s composer is empty after ⌘A Backspace`).toBe(true);
}

/** The body is the window's first responder and its composer holds DOM focus. */
async function expectKeyboardInBody(app: App, cardId: string, label: string): Promise<void> {
  const body = await pollFor(() => bodyOf(app, cardId), (b) => b?.firstResponder === true, SETTLE_MS);
  expect(body?.firstResponder, `${label}: ${cardId}'s body is the window's first responder`).toBe(true);
  const focused = await pollFor(() => app.body(cardId).evalJS<boolean>(composerFocused), (v) => v, SETTLE_MS);
  expect(focused, `${label}: ${cardId}'s composer holds focus`).toBe(true);
}


/** A scratch directory holding the 2×2 PNG the image paste reads. */
function scratchWithPng(): { scratch: string; pngPath: string } {
  const scratch = mkdtempSync(join(tmpdir(), "tug-row12-"));
  const pngPath = join(scratch, "row12.png");
  writeFileSync(pngPath, Buffer.from(PNG_BASE64, "base64"));
  return { scratch, pngPath };
}

/** The Overview's composer, in its body, takes typing, a text paste and an image paste as an attachment. */
export async function overviewComposer(launch: Launch): Promise<void> {
  const card = "row12-overview";
  const kind = cardKind("overview");
  const { pngPath } = scratchWithPng();
  const field = `(document.querySelector(${JSON.stringify(kind.field)}) || { textContent: "" }).textContent`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-overview`, ...launch });
  try {
    await app.seedDeckState({ state: kindDeck(kind, card, { sessions: ["row12-seed"] }), focusCardId: card });
    const o = await standUpKind(app, kind, card);
    await focusBody(app, card, { composer: false });
    await o.nativeClickAtElement(kind.field!);
    await app.nativeType("typed");
    expect(await pollFor(() => o.evalJS<string>(field), (t) => t.includes("typed"), SETTLE_MS), "typing lands in its composer").toContain("typed");
    pasteboardText(PASTED_TEXT);
    await app.nativeKey("v", ["cmd"]);
    expect(await pollFor(() => o.evalJS<string>(field), (t) => t.includes(PASTED_TEXT), SETTLE_MS), "⌘V pastes the pasteboard's text into its composer").toContain(PASTED_TEXT);
    pasteboardImage(pngPath);
    await app.nativeKey("v", ["cmd"]);
    const tiles = await pollFor(() => o.evalJS<number>(`document.querySelectorAll(${JSON.stringify(ATTACHMENT_TILE)}).length`), (n) => n > 0, SETTLE_MS);
    note(`after the image paste: ${tiles} attachment tile(s) in the Overview's composer`);
    expect(tiles, "⌘V pastes the pasteboard's image as an attachment in its composer").toBeGreaterThan(0);
  } finally {
    await app.close();
  }
}

/**
 * One Session body bound to a stub of two turns. Part `send`: Z2 stands in
 * it, a prompt sent plays the next turn, and text and an image paste into its
 * composer; the turn's first message arrives whole and its second streams,
 * so the phase is seen to leave idle in a few seconds rather than seven.
 * Part `panel`: the host's file panel hands its path back to it, and Escape
 * closes its slash popup.
 */
export async function sessionComposer(launch: Launch, part: "send" | "panel"): Promise<void> {
  const stubDir = stubDirectory();
  const { scratch, pngPath } = scratchWithPng();
  const insertPath = join(scratch, "row12-insert.txt");
  writeFileSync(insertPath, "a file the panel chooses\n");
  const app = await launchTugApp({ testName: `${TEST_NAME}-${part}`, ...launch, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  try {
    await app.seedDeckState({ state: deck(), focusCardId: A });
    await spawnStub(app, A, stubDir, 2, 2, undefined, 1);
    await waitForBody(app, A);
    await focusBody(app, A, { composer: true });
    const a = app.body(A);

    if (part === "send") {
      // ---- Z2 stands in the body ----
      const cellsAtStart = await a.evalJS<number>(`document.querySelectorAll(${JSON.stringify(STATUS_CELLS)}).length`);
      note(`Z2 at the start: status bar ${await a.evalJS<boolean>(`document.querySelector(${JSON.stringify(STATUS_BAR)}) !== null`)}, ${cellsAtStart} cells; phase ${JSON.stringify(await a.evalJS<string | null>(`document.querySelector(${JSON.stringify(PHASE_CELL)})?.textContent ?? null`))}`);
      expect(await a.evalJS<boolean>(`document.querySelector(${JSON.stringify(STATUS_BAR)}) !== null`), "the body shows Z2's status bar").toBe(true);
      expect(cellsAtStart, "Z2 has its telemetry cells in the body").toBeGreaterThan(0);

      // ---- The composer sends a prompt and the next turn plays ----
      const entriesBefore = await a.evalJS<number>(`document.querySelectorAll(${JSON.stringify(TRANSCRIPT_ENTRY)}).length`);
      await app.nativeType("row12 prompt");
      expect(await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("row12 prompt") === true, SETTLE_MS), "typing lands in the body's composer").toContain("row12 prompt");
      // Return writes a line in the composer; ⇧Return is the send.
      await pollFor(() => a.evalJS<string | null>(`document.querySelector('[data-slot="tug-prompt-entry"]')?.getAttribute("data-can-submit") ?? null`), (v) => v === "true", SETTLE_MS);
      await app.nativeKey("Return", ["shift"]);
      const left = await pollFor(() => a.evalJS<string | null>(promptPhase), (p) => p !== "idle", SETTLE_MS);
      note(`after ⇧Return: phase ${JSON.stringify(left)}, Z2 phase cell ${JSON.stringify(await a.evalJS<string | null>(`document.querySelector(${JSON.stringify(PHASE_CELL)})?.textContent ?? null`))}, composer ${JSON.stringify(await a.evalJS<string | null>(composerText))}`);
      expect(left, "⇧Return sends the prompt: the entry's phase leaves idle").not.toBe("idle");
      const back = await pollFor(() => a.evalJS<string | null>(promptPhase), (p) => p === "idle", TURN_MS);
      expect(back, "the turn runs out and the entry is idle again").toBe("idle");
      const entriesAfter = await pollFor(() => a.evalJS<number>(`document.querySelectorAll(${JSON.stringify(TRANSCRIPT_ENTRY)}).length`), (n) => n > entriesBefore, SETTLE_MS);
      const perTurn = await pollFor(() => a.evalJS<string>(`document.querySelector(${JSON.stringify(PER_TURN_DURATION)})?.textContent ?? ""`), (t) => t.trim() !== "", SETTLE_MS);
      note(`after the turn: transcript entries ${entriesBefore} → ${entriesAfter}; Z2 per-turn duration ${JSON.stringify(perTurn)}; composer ${JSON.stringify(await a.evalJS<string | null>(composerText))}`);
      expect(entriesAfter, "the stub's next turn arrived in the body's transcript").toBeGreaterThan(entriesBefore);
      expect(await pollFor(() => a.evalJS<boolean>(composerIsEmpty), (v) => v, SETTLE_MS), "the send cleared the composer").toBe(true);
      // Z2's surfaces open in the body: the time cell's popover, closed by Escape.
      await a.nativeClickAtElement(Z2_TIME_CELL);
      const z2Open = await pollFor(() => a.evalJS<boolean>(`document.querySelector(${JSON.stringify(Z2_SURFACE)}) !== null`), (v) => v, SETTLE_MS);
      expect(z2Open, "a click on Z2's time cell opens its surface in the body").toBe(true);
      await app.nativeKey("Escape");
      const z2Closed = await pollFor(() => a.evalJS<boolean>(`document.querySelector(${JSON.stringify(Z2_SURFACE)}) === null`), (v) => v, SETTLE_MS);
      expect(z2Closed, "Escape closes Z2's surface").toBe(true);
      await a.nativeClickAtElement(PROMPT_INPUT);

      // ---- Paste: text, then an image, through the real pasteboard ----
      await expectKeyboardInBody(app, A, "before the paste");
      pasteboardText(PASTED_TEXT);
      await app.nativeKey("v", ["cmd"]);
      const pastedText = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes(PASTED_TEXT) === true, SETTLE_MS);
      expect(pastedText, "⌘V pastes the pasteboard's text into the body's composer").toContain(PASTED_TEXT);
      await clearComposer(app, A);
      pasteboardImage(pngPath);
      await app.nativeKey("v", ["cmd"]);
      const tiles = await pollFor(() => a.evalJS<number>(`document.querySelectorAll(${JSON.stringify(ATTACHMENT_TILE)}).length`), (n) => n > 0, SETTLE_MS);
      note(`after the image paste: ${tiles} attachment tile(s); composer ${JSON.stringify(await a.evalJS<string | null>(composerText))}`);
      expect(tiles, "⌘V pastes the pasteboard's image as an attachment in the body's composer").toBeGreaterThan(0);
      await clearComposer(app, A);
      await pollFor(() => a.evalJS<number>(`document.querySelectorAll(${JSON.stringify(ATTACHMENT_TILE)}).length`), (n) => n === 0, SETTLE_MS);
      return;
    }

    // ---- The picker handoff: ⇧⌘I from the body, the host's panel, the path back to the body ----
    await expectKeyboardInBody(app, A, "before Insert File");
    await app.nativeKey("i", ["cmd", "shift"]);
    // The panel is the host's, so it is driven by keyboard: Go to Folder
    // with the file's own path selects it, and Return inserts.
    await Bun.sleep(1_500);
    await app.nativeKey("g", ["cmd", "shift"]);
    await Bun.sleep(600);
    await app.nativeType(insertPath);
    await Bun.sleep(600);
    await app.nativeKey("Return");
    await Bun.sleep(900);
    await app.nativeKey("Return");
    const atoms = await pollFor(() => a.evalJS<string>(fileAtomLabels), (s) => s.includes("row12-insert.txt"), 15_000);
    note(`after Insert File: file atoms ${atoms}; composer ${JSON.stringify(await a.evalJS<string | null>(composerText))}`);
    expect(atoms, "the panel's path comes back to the body as a file atom in its composer").toContain("row12-insert.txt");
    await expectKeyboardInBody(app, A, "after the panel");
    await clearComposer(app, A);

    // ---- The slash popup: raised in the body, closed by Escape ([F17]) ----
    await app.performMenuItem("session.commandPicker");
    const popup = await pollFor(() => a.evalJS<boolean>(slashPopupShown), (v) => v, SETTLE_MS);
    expect(popup, "Open Command Picker raises the slash popup in the body").toBe(true);
    await a.evalJS(armKeyCounter);
    await app.evalJS(armKeyCounter);
    await app.nativeKey("Escape");
    const popupDown = await pollFor(() => a.evalJS<boolean>(slashPopupShown), (v) => !v, SETTLE_MS);
    note(
      `after Escape: popup shown ${popupDown}; keydowns seen — body ${await a.evalJS<number>("window.__row12Keys")}, shell ${await app.evalJS<number>("window.__row12Keys")}; ` +
        `host ${JSON.stringify((await app.bodies()).map((b) => ({ card: b.cardId, fr: b.firstResponder })))}; body focus ${await a.evalJS<boolean>("document.hasFocus()")}, composer focused ${await a.evalJS<boolean>(composerFocused)}, composer ${JSON.stringify(await a.evalJS<string | null>(composerText))}`,
    );
    expect(popupDown, "Escape through the session tap closes the slash popup in the body").toBe(false);
    await expectKeyboardInBody(app, A, "after the popup");
  } finally {
    await app.close();
  }
}

