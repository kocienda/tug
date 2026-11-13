/**
 * share-probes.ts — what the share-turns app-tests share: four committed
 * turns injected into a bound Session card, and the selectors and reads the
 * share mode is driven and observed through.
 *
 * The four turns are built so the copied Markdown can be read for what the
 * scrub did: the third turn's prose carries an Anthropic key, the fourth
 * turn's tool call reads a file under the test's `$HOME` (which Tug.app and
 * its tugcast inherit), and the second turn's reply carries a word nothing
 * else does, so its absence says the unmarked turn stayed out.
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { sessionCardShape } from "./_harness/shapes";
import type { App } from "./_harness";
import { holdModifier } from "./_harness/client";
import { expect } from "bun:test";

export const FEED_CODE_OUTPUT = 0x40;
export const CARD = '[data-card-id="A"]';
export const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
export const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
export const MARK = `${CARD} [data-slot="share-turn-mark"]`;
export const SHADE = `${CARD} [data-slot="session-share-view"]`;
export const COUNT = `${CARD} [data-testid="session-share-count"]`;
export const MARK_ALL = `${CARD} [data-testid="session-share-mark-all"]`;
export const CLEAR = `${CARD} [data-testid="session-share-clear"]`;
/** The shade's one action button, which performs what its Action menu names. */
export const GO = `${CARD} [data-testid="session-share-go"]`;
export const CANCEL = `${CARD} [data-testid="session-share-cancel"]`;
/** The Action menu's trigger, and its open menu (portaled, so not under the card). */
export const ACTION_TRIGGER = `${CARD} [data-testid="session-share-action"] button`;
export const ACTION_MENU = '[data-testid="session-share-action-menu"]';

/** The shade's actions, in the Action menu's order. */
export type ShareActionName = "preview" | "copy" | "save" | "share";
const ACTION_ORDER: readonly ShareActionName[] = ["preview", "copy", "save", "share"];
export const RENDERING = `${CARD} [data-testid="session-share-rendering"]`;
export const BULLETIN = ".tug-pane-bulletin";

/** The Format choice's segment for `value` (`pdf`, `png` or `markdown`). */
export function formatChoice(value: "pdf" | "png" | "markdown"): string {
  return `${CARD} [data-testid="session-share-format"] [data-choice-value="${value}"]`;
}
export const ENTRY_REGION = `${CARD} [data-slot="session-card-entry-region"]`;
export const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
export const CELL_MENU = '[data-slot="tug-editor-context-menu"]';

export const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
export const HOME = process.env.HOME ?? homedir();
export const HOME_FILE = `${HOME}/src/demo/config.ts`;
/** The second turn's word, found nowhere else. */
export const UNMARKED_WORD = "bananas";

export interface SeedTurn {
  prompt: string;
  reply: string;
  tool?: { name: string; input: Record<string, unknown> };
}

const TURNS: SeedTurn[] = [
  { prompt: "first question", reply: "First answer, about apples." },
  { prompt: "second question", reply: `Second answer, about ${UNMARKED_WORD}.` },
  { prompt: "third question", reply: `The key is ${SECRET} in plain sight.` },
  {
    prompt: "fourth question",
    reply: "Read the config.",
    tool: { name: "Read", input: { file_path: HOME_FILE } },
  },
];

/**
 * Open card A bound to `sid` in a scratch project directory, with `turns`
 * (the four above, unless named) committed. Returns the directory, which the
 * caller removes. Unless `drawn` is false, every turn's prompt row is drawn
 * before it returns; a turn tall enough to push the others out of the
 * windowed list leaves them undrawn, and such a caller waits for one row.
 */
export async function openSeededCard(
  app: App,
  sid: string,
  turns: readonly SeedTurn[] = TURNS,
  drawn = true,
): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), `${sid}-`));
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 820 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: sid, projectDir });
  await app.awaitEngineReady("A");
  const frame = (decoded: Record<string, unknown>) =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: sid, ...decoded },
    });
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const msg = `${sid}-m${i + 1}`;
    await app.driveSession("A", { op: "send", text: turn.prompt });
    await frame({ type: "prompt_anchor", promptUuid: `${sid}-u${i + 1}` });
    await frame({ type: "content_block_start", msg_id: msg, block_index: 0, kind: "text" });
    await frame({
      type: "assistant_text",
      seq: 0,
      rev: 0,
      status: "complete",
      msg_id: msg,
      block_index: 0,
      text: turn.reply,
      is_partial: false,
    });
    if (turn.tool !== undefined) {
      const useId = `${sid}-tc${i + 1}`;
      await frame({
        type: "tool_use",
        msg_id: msg,
        tool_use_id: useId,
        tool_name: turn.tool.name,
        input: turn.tool.input,
        seq: 1,
      });
      await frame({ type: "tool_result", tool_use_id: useId, is_error: false, output: "export {};" });
    }
    await frame({ type: "turn_complete", seq: 0, msg_id: msg, result: "success" });
  }
  await app.body("A").waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length ${drawn ? `=== ${turns.length}` : "> 0"}`,
    { timeoutMs: 10_000 },
  );
  return projectDir;
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** Choose the Share shade's format `value` with a trusted click, and wait for the choice to take. */
export async function chooseFormat(app: App, value: "pdf" | "png" | "markdown"): Promise<void> {
  const card = app.body("A");
  await card.nativeClickAtElement(formatChoice(value));
  await card.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(formatChoice(value))})?.getAttribute("aria-checked") === "true"`,
    { timeoutMs: 4_000 },
  );
}

/**
 * Choose `action` in the shade's Action menu with trusted clicks — the
 * trigger, then the item — and wait for the action button to wear it. A no-op
 * when it already does.
 */
export async function chooseAction(app: App, action: ShareActionName): Promise<void> {
  const card = app.body("A");
  const wears = `document.querySelector(${JSON.stringify(GO)})?.getAttribute("data-share-action") === ${JSON.stringify(action)}`;
  if (await card.evalJS<boolean>(wears)) return;
  await card.nativeClickAtElement(ACTION_TRIGGER);
  const item = `${ACTION_MENU} [data-item-id="${ACTION_ORDER.indexOf(action)}"]`;
  await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(item)})`, { timeoutMs: 4_000 });
  await card.nativeClickAtElement(item);
  await card.waitForCondition<boolean>(wears, { timeoutMs: 4_000 });
}

/** Choose `action` and press the action button. */
export async function pressAction(app: App, action: ShareActionName): Promise<void> {
  await chooseAction(app, action);
  await app.body("A").nativeClickAtElement(GO);
}

/**
 * Perform `action` — Preview…, or Copy, Save… or Share… on a selection not yet
 * previewed — and wait for the preview sheet to take the keyboard from the
 * window that held it, then press the sheet's default button (its Return
 * key): Done after Preview…, the action's own button otherwise. `timeoutMs`
 * bounds the wait for the sheet, which a rendered format reaches only after
 * the host's render. `thenAnotherSheet` is for Save…, whose confirm raises
 * the save panel: the card's window does not get the keyboard back, and the
 * caller reads the panel from the host's log instead.
 */
export async function pressThroughPreview(
  app: App,
  action: ShareActionName,
  timeoutMs = 10_000,
  thenAnotherSheet = false,
): Promise<void> {
  await chooseAction(app, action);
  const before = await app.windowState();
  expect(before.isKeyWindow, "the card's window holds the keyboard before the preview").toBe(true);
  await app.body("A").nativeClickAtElement(GO);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await app.windowState();
    if (!state.isKeyWindow && state.appKeyWindow) {
      await app.nativeKey("Return");
      if (thenAnotherSheet) return;
      const gone = Date.now() + 3_000;
      let after = await app.windowState();
      while (!after.isKeyWindow && Date.now() < gone) {
        await settle(100);
        after = await app.windowState();
      }
      expect(after.isKeyWindow, "Return pressed the sheet's default button").toBe(true);
      return;
    }
    await settle(100);
  }
  throw new Error("the preview sheet never took the keyboard");
}

/** Press Preview… and the preview sheet's Done. */
export function previewAndDismiss(app: App, timeoutMs = 10_000): Promise<void> {
  return pressThroughPreview(app, "preview", timeoutMs);
}

/** The marks' turn keys in transcript order, and which are checked. */
export function marksJs(): string {
  return `Array.from(document.querySelectorAll(${JSON.stringify(MARK)})).map(function (el) {
    return { key: el.getAttribute("data-turn-key"), checked: el.getAttribute("aria-checked") === "true" };
  })`;
}

/** A selector for the mark of the turn whose key is `key`. */
export function markFor(key: string): string {
  return `${MARK}[data-turn-key="${key}"]`;
}

/**
 * Click the mark of turn `key` with a trusted click — shift held when
 * `shift` — after bringing it into the transcript's view, since the list
 * rests at its bottom and an early turn's mark is above it.
 */
export async function clickMark(app: App, key: string, shift = false): Promise<void> {
  const card = app.body("A");
  const point = await card.evalJS<{ x: number; y: number }>(
    `(function(){ var el = document.querySelector(${JSON.stringify(markFor(key))}); el.scrollIntoView({ block: "center" }); var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (shift) {
    await holdModifier(card, ["shift"], async (inner) => {
      await inner.rpcCall<void>("nativeClick", { viewportPoint: point });
    });
  } else {
    await card.nativeClick(point);
  }
}

/** Whether the element `selector` names is present and not disabled. */
export function enabledJs(selector: string): string {
  return `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); return el !== null && !el.disabled; })()`;
}

export function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

export function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}
