/**
 * _bodies.ts — the body cards the keyboard rows stand up.
 *
 * Rows 5, 6 and 7 of the bar drive keys and menu commands into session
 * cards whose bodies are real web views, so each needs the same furniture:
 * a deck of session cards each bound to a stub session, the body ready with
 * its composer mounted, and a way to
 * give one card the keyboard before a leg begins. This module is that
 * furniture; the rows are the assertions.
 *
 * A stub session plays its transcript only when a prompt is sent into the
 * card (`streaming-stub-fixture.ts`), and nothing here sends one: every card
 * this module seats is bound, idle and empty, so its close waives the
 * confirm. A leg that needs the Close popover gives the card something the
 * confirm protects first: an unsent draft does it at no cost.
 */

import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App, BodyApp } from "../_harness";
import type { BodyViewSnapshot } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { streamingTranscript } from "../streaming-stub-fixture";

export const PROMPT_INPUT = '[data-slot="tug-text-editor"] .cm-content';
export const BODY_READY_MS = 30_000;
export const SETTLE_MS = 3_000;

/** In a page: whether its composer holds DOM focus. */
export const composerFocused = `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT)})`;
/** In a page: its composer's text, or null when it has none. */
export const composerText = `(document.querySelector(${JSON.stringify(PROMPT_INPUT)}) || { textContent: null }).textContent`;
/** In a page: the prompt entry's phase, or null when it has none. */
export const promptPhase = `(function () {
  var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
  return entry === null ? null : entry.getAttribute("data-phase");
})()`;

export async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50);
    value = await read();
  }
  return value;
}

/** One session card's pane in a four-up flow band. */
export function sessionPane(cardId: string, slot: number): Record<string, unknown> {
  return {
    id: `${cardId}-pane`,
    position: { x: 40, y: 40 },
    size: { width: 640, height: 480 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  };
}

export const paneOf = (cardId: string): string => `.tug-pane[data-pane-id="${cardId}-pane"]`;

export async function bodyOf(app: App, cardId: string): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === cardId) ?? null;
}

/**
 * Spawn a stub session into `cardId`, its transcript `messages` long over
 * `turns` turns, in a scratch project dir unless `projectDir` names one. The
 * transcript plays only when a prompt is sent; until then the card is empty.
 * The first `prefill` messages of each turn arrive whole (`streamingTranscript`).
 */
export async function spawnStub(app: App, cardId: string, stubDir: string, messages = 2, turns = 1, projectDir?: string, prefill = 0): Promise<void> {
  const tugSessionId = randomUUID();
  if (projectDir === undefined) {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), `tug-${cardId}-project-`)));
    onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
    projectDir = scratch;
  }
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(messages, turns, undefined, prefill)));
  await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
}

/** The body is ready and placed visible, its composer mounted, its session idle. */
export async function waitForBody(app: App, cardId: string): Promise<void> {
  const ready = await pollFor(() => bodyOf(app, cardId), (b) => b !== null && b.state === "ready" && b.visible, BODY_READY_MS);
  expect(ready?.visible, `${cardId}: the body is ready and placed visible`).toBe(true);
  const body = app.body(cardId);
  await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`, { timeoutMs: BODY_READY_MS });
  await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 90_000 });
}

/**
 * Give `cardId` the keyboard the shell's way — the deck's focus action,
 * which is what a title-bar click ends in — and wait until the host says
 * its body is the window's first responder. Then put the caret in its
 * composer with a click there, so typing has somewhere to land.
 */
export async function focusBody(app: App, cardId: string, opts?: { composer?: boolean }): Promise<void> {
  await app.dispatchControlAction("focus-session-card", { cardId });
  const focused = await pollFor(() => app.getFocusedCardId(), (id) => id === cardId, SETTLE_MS);
  expect(focused, `${cardId}: the shell's focused card`).toBe(cardId);
  const holder = await pollFor(() => bodyOf(app, cardId), (b) => b?.firstResponder === true, SETTLE_MS);
  expect(holder?.firstResponder, `${cardId}: its body is the window's first responder`).toBe(true);
  if (opts?.composer === false) return;
  const body = app.body(cardId);
  await body.nativeClickAtElement(PROMPT_INPUT);
  await body.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
}

/** Which bodies the host says hold the keyboard, for a note. */
export async function responders(app: App): Promise<string> {
  const bodies = await app.bodies();
  return JSON.stringify(bodies.map((b) => ({ card: b.cardId, fr: b.firstResponder, visible: b.visible })));
}

/**
 * A slide hides `cardId`'s body for the beat and shows it at the land, and
 * the keyboard comes back to it then: wait for that before the next chord,
 * which otherwise lands while no body is first responder.
 */
export async function landed(app: App, cardId: string): Promise<void> {
  const body = await pollFor(() => bodyOf(app, cardId), (b) => b?.visible === true && b.firstResponder === true, 8_000);
  expect(body?.visible === true && body.firstResponder, `${cardId}: its body is shown and holds the keyboard after the land`).toBe(true);
  // And the settle's own mark off the canvas: the body shows at the land,
  // but the settle's hold on the deck can outlast it by a tick or two.
  await pollFor(
    () => app.evalJS<boolean>(`document.querySelector("[data-deck-canvas-background]")?.hasAttribute("data-imposer-settling") ?? false`),
    (v) => !v,
    8_000,
  );
  await Bun.sleep(300);
}

/** The pane's slot in the shell's deck state, or null. */
export async function slotOf(app: App, cardId: string): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var s = window.tugdeck.diag.getDeckState();
      var p = (s && s.panes || []).find(function (p) { return p.id === ${JSON.stringify(`${cardId}-pane`)}; });
      return p && typeof p.slot === "number" ? p.slot : null;
    })()`,
  );
}

/** Whether the pane's frame wears `data-folded`. */
export async function foldedOf(app: App, cardId: string): Promise<boolean> {
  return app.evalJS<boolean>(`document.querySelector(${JSON.stringify(paneOf(cardId))})?.getAttribute("data-folded") === "true"`);
}

export const CONFIRM_POPOVER = '[data-slot="tug-confirm-popover"]';
export const popoverPresent = `document.querySelector(${JSON.stringify(CONFIRM_POPOVER)}) !== null`;

/**
 * The centre of the Close popover's Close button, in the viewport of the page
 * it stands in — the shell's, or the card's own for a card that draws its own
 * chrome — or null.
 */
export async function closeButtonOfPopover(app: Pick<App, "evalJS">): Promise<{ x: number; y: number } | null> {
  return app.evalJS<{ x: number; y: number } | null>(`(function () {
    var root = document.querySelector(${JSON.stringify(CONFIRM_POPOVER)});
    if (root === null) return null;
    var btns = root.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || "").trim() === "Close") { var r = btns[i].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return null;
  })()`);
}

/**
 * The page a card's Close popover stands in, or null when none does: the
 * card's own, for a card that draws its own chrome, or the shell's. A card
 * whose body is gone has no page to ask, and answers as the shell's.
 */
export async function closePopoverPage(app: App, cardId: string): Promise<App | BodyApp | null> {
  const body = app.body(cardId);
  if (await body.evalJS<boolean>(popoverPresent).catch(() => false)) return body;
  if (await app.evalJS<boolean>(popoverPresent)) return app;
  return null;
}

/** Whether a card's Close popover stands, in its own page or the shell's. */
export async function closePopoverUp(app: App, cardId: string): Promise<boolean> {
  return (await closePopoverPage(app, cardId)) !== null;
}

/** Press the Close button of a card's Close popover, wherever it stands; false when there is none. */
export async function pressCloseOfPopover(app: App, cardId: string): Promise<boolean> {
  const page = await closePopoverPage(app, cardId);
  if (page === null) return false;
  const button = await closeButtonOfPopover(page);
  if (button === null) return false;
  await page.nativeClick(button);
  return true;
}
