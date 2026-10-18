/**
 * probe-tap.test.ts — the grounding bar's own path, proven once.
 *
 * Every row of the bar asserts an effect in a body after a key or a menu
 * command delivered the way the user delivers them. This file pins that the
 * delivery exists: a launch with `foreground: true` puts the harness in the
 * session-tap mode, where `nativeType` activates the app, makes its window key
 * and posts to the session event tap, so one typed character goes through
 * WindowServer, AppKit's key-equivalent scan and the first responder's view
 * — the body's web view — and lands in the body's composer. And
 * `performMenuItem` finds the real `NSMenuItem`, validates it and sends its
 * action through `NSApp.sendAction`: View › Zoom In performed that way
 * changes the body's placed width, which the host's body snapshot reports.
 * An identifier no item carries answers `{ found: false }`.
 *
 * The pid mode the rest of the corpus runs in is never evidence for any of
 * this (`NativeEventHandlers.swift`, "Which mode is evidence for what").
 *
 * @foreground
 * @covers tugapp/Sources/TestHarness/NativeEventHandlers.swift
 * @covers tugapp/Sources/TestHarness/TestHarnessConnection.swift
 * @covers tests/app-test/_harness/client.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";

const TEST_NAME = "body-grounding-probe-tap";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = "probe-tap-a";
const PROMPT_INPUT = '[data-slot="tug-text-editor"] .cm-content';
const BODY_READY_MS = 30_000;
const SETTLE_MS = 3_000;

const oneCard = {
  cards: [{ id: CARD, componentId: "session", title: "Probe", closable: true }],
  panes: [
    {
      id: `${CARD}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 640, height: 480 },
      cardIds: [CARD],
      activeCardId: CARD,
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    },
  ],
  activePaneId: `${CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

const composerFocused = `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT)})`;
const composerText = `(document.querySelector(${JSON.stringify(PROMPT_INPUT)}) || { textContent: null }).textContent`;

async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const started = Date.now();
  let last = await read();
  while (!done(last) && Date.now() - started < timeoutMs) {
    await Bun.sleep(50);
    last = await read();
  }
  return last;
}

async function bodyOf(app: App): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === CARD) ?? null;
}

describe.skipIf(!SHOULD_RUN)("body-grounding probe: the app's own path reaches a body", () => {
  test(
    "a character through the activated session tap lands in the body's composer, and a performed menu item acts in the body",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: oneCard, focusCardId: CARD });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-probe-tap-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
        await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
        const ready = await pollFor(() => bodyOf(app), (b) => b !== null && b.state === "ready" && b.visible, BODY_READY_MS);
        expect(ready?.state, "the card's body reports ready").toBe("ready");

        const body = app.body(CARD);
        await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`, {
          timeoutMs: BODY_READY_MS,
        });

        // ---- One character, the user's way ----
        await body.nativeClickAtElement(PROMPT_INPUT);
        await body.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
        const responder = await pollFor(() => bodyOf(app), (b) => b?.firstResponder === true, SETTLE_MS);
        expect(responder?.firstResponder, "the body's web view is the window's first responder").toBe(true);
        await app.nativeType("q");
        const typed = await pollFor(() => body.evalJS<string | null>(composerText), (t) => t !== null && t.includes("q"), SETTLE_MS);
        note(`typed through the session tap: composer text ${JSON.stringify(typed)}; shell active element ${JSON.stringify(
          await app.evalJS<string | null>(`document.activeElement ? document.activeElement.tagName : null`),
        )}`);
        expect(typed, "the character lands in the body's composer").toContain("q");
        expect(
          // card-dom: shell — the shell's own document, which must not have taken the key.
          await app.evalJS<boolean>(`document.body.textContent.includes("q") && document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT)})`),
          "the shell's own document did not take the key",
        ).toBe(false);

        // ---- One menu item, the menu's way ----
        const before = (await bodyOf(app))!.frame.width;
        const missing = await app.performMenuItem("no.such.item");
        expect(missing, "an unknown identifier is not found").toEqual({ found: false });
        const zoomed = await app.performMenuItem("view.zoomIn");
        note(`performMenuItem(view.zoomIn): ${JSON.stringify(zoomed)}`);
        expect(zoomed.found && zoomed.enabled && zoomed.performed, "View › Zoom In is found, enabled and performed").toBe(true);
        const after = await pollFor(() => bodyOf(app), (b) => b !== null && b.frame.width !== before, SETTLE_MS);
        note(`body width ${before} → ${after?.frame.width}`);
        expect(after?.frame.width, "the zoom took effect on the body's placement").not.toBe(before);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
