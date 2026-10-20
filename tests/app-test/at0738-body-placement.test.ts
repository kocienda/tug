/**
 * at0738-body-placement.test.ts — a Session card whose content is a body: its
 * own web view, placed by the host where the shell's pane stands.
 *
 * Part of the gate for the body path, which was one file
 * (`at0738-session-body`) and is now one file per leg, each its own launch:
 * placement (this file), `at0738-body-arrival`, `at0738-body-fallback`,
 * `at0738-body-reload-quit` and `at0738-body-turn`. Shared helpers live in
 * `session-body-fixture.ts`.
 *
 * **Placement and the pointer.** Both Session cards are body cards from the
 * moment the deck holds them, unbound, and the spawn onto a stub session is
 * sent to the first card's body, which binds it. A Session card draws its own
 * pane's chrome, so its body's frame is its whole card: the shell's stand-in
 * frame outset by the apron, within a point, after every commit — at zoom
 * 1.0, at 0.8, and after a column split, a settle, has landed (a body snaps
 * at the land). A native click inside the body's rect must reach the body —
 * its composer takes focus — and make the card the shell's first responder;
 * a click on a popover the shell raises over a body (a hello card's, whose
 * chrome the shell still draws) must reach the shell instead. And a
 * card-scoped command fired through the shell's menu path (`focus-prompt`)
 * must act in the key body.
 *
 * @family at0738-body
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/lib/body-command-route.ts
 * @covers tugdeck/src/lib/pointer-claim.ts
 * @covers tugdeck/src/components/chrome/body-placement-beacon.tsx
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import type { BodyViewSnapshot } from "./_harness/client";
import { onTestRunEnd } from "./_harness/test-cleanup";
import {
  BODY_READY_MS,
  CLAIM_SETTLE_MS,
  PLACED_MS,
  PROMPT_INPUT,
  WIDTH_BUTTON,
  WIDTH_MENU,
  composerFocused,
  firstResponderJs,
  pollFor,
  type Rect,
} from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0738-body-placement";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The spawned body card, and the unbound neighbour (a body too) sharing its column. */
const BODY_CARD = "at0738-a";
const NEIGHBOUR = "at0738-b";
/**
 * A card whose pane's chrome the shell still draws, in the next slot: its
 * width popover is a surface the shell raises over a body (its own), which a
 * Session card's no longer is — that card draws its chrome in its own page.
 */
const SHELL_CHROMED = "at0738-c";

const twoInAColumn = {
  cards: [
    { id: BODY_CARD, componentId: "session", title: "Body", closable: true },
    { id: NEIGHBOUR, componentId: "session", title: "Neighbour", closable: true },
    { id: SHELL_CHROMED, componentId: "hello", title: "Hello", closable: true },
  ],
  panes: [BODY_CARD, NEIGHBOUR, SHELL_CHROMED].map((cardId) => ({
    id: `${cardId}-pane`,
    position: { x: 40, y: 40 },
    size: { width: 640, height: 480 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot: cardId === SHELL_CHROMED ? 1 : 0,
  })),
  activePaneId: `${BODY_CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

/**
 * Where the body card's view should stand: its placeholder's rect, which for a
 * card that draws its own chrome is its stand-in frame, outset by the apron —
 * the card's view is the whole pane.
 */
const placeholderRect = (app: App): Promise<Rect | null> =>
  // card-dom: shell — the placeholder is the shell's.
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector('[data-body-placeholder][data-card-id="${BODY_CARD}"]');
      if (el === null) return null;
      var frame = el.closest(".tug-pane");
      var whole = frame !== null && frame.hasAttribute("data-chrome-in-body");
      var r = (whole ? frame : el).getBoundingClientRect();
      var a = whole ? 6 : 0;
      return { x: r.x - a, y: r.y - a, width: r.width + 2 * a, height: r.height + 2 * a };
    })()`,
  );

async function bodyOf(app: App): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === BODY_CARD) ?? null;
}

/**
 * The body stands at its placeholder: each of its four edges within `slack`
 * of the placeholder's, and covering it. The host's frame is the
 * placeholder's rect grown outward to whole points, so a body's page lays
 * out over the whole of its view; each edge moves less than a point, and
 * the width and height can grow by up to two between them.
 */
const within = (a: Rect, b: Rect, slack = 1): boolean =>
  a.x <= b.x + 0.001 &&
  a.y <= b.y + 0.001 &&
  a.x + a.width >= b.x + b.width - 0.001 &&
  a.y + a.height >= b.y + b.height - 0.001 &&
  b.x - a.x < slack &&
  b.y - a.y < slack &&
  a.x + a.width - (b.x + b.width) < slack &&
  a.y + a.height - (b.y + b.height) < slack;

/**
 * What the shell's placer would see now: the settle's mark, the placeholders
 * under the canvas, and the placer's own account after a nudge — read when a placement
 * check fails, so a red says which of them held the body back.
 */
async function placementState(app: App): Promise<unknown> {
  await app.evalJS(`(window.dispatchEvent(new Event("resize")), null)`);
  await Bun.sleep(200);
  return app.evalJS(
    `(function () {
      var canvas = document.querySelector("[data-deck-canvas-background]");
      return {
        settling: document.querySelectorAll("[data-imposer-settling]").length,
        canvas: canvas !== null,
        placeholdersInCanvas: canvas ? canvas.querySelectorAll("[data-body-placeholder]").length : -1,
        placeholdersInDocument: document.querySelectorAll("[data-body-placeholder]").length,
        placerAfterNudge: window.tugdeck.diag.getBodyPlacement(),
      };
    })()`,
  );
}

/** The body's frame equals the placeholder's rect within a point, and it shows. */
async function expectPlaced(app: App, label: string): Promise<Rect> {
  const reading = await pollFor(
    async () => ({ placeholder: await placeholderRect(app), body: await bodyOf(app) }),
    (r) => r.placeholder !== null && r.body !== null && r.body.visible && within(r.body.frame, r.placeholder),
    PLACED_MS,
  );
  note(`${label}: placeholder ${JSON.stringify(reading.placeholder)}, body ${JSON.stringify(reading.body?.frame)}`);
  if (reading.body === null || !reading.body.visible || reading.placeholder === null || !within(reading.body.frame, reading.placeholder)) {
    note(`${label}: shell placement state ${JSON.stringify(await placementState(app))}`);
  }
  expect(reading.placeholder, `${label}: the shell stands a placeholder for the body card`).not.toBeNull();
  expect(reading.body, `${label}: the host holds the card's body`).not.toBeNull();
  expect(reading.body!.visible, `${label}: the body shows`).toBe(true);
  expect(
    within(reading.body!.frame, reading.placeholder!),
    `${label}: body frame ${JSON.stringify(reading.body!.frame)} covers placeholder ${JSON.stringify(reading.placeholder)}, each edge within 1 pt`,
  ).toBe(true);
  return reading.placeholder!;
}

/** Record the next pointerdowns a document sees, swallowing them so nothing acts. */
const armDownRecorder = `(function () {
  window.__at0738Downs = [];
  window.__at0738Record = function (e) {
    var t = e.target instanceof Element ? e.target : null;
    window.__at0738Downs.push(t === null ? "?" : (t.closest("[data-testid]") || t).getAttribute("data-testid") || t.tagName);
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("pointerdown", window.__at0738Record, true);
  return null;
})()`;
const readDowns = `(function () {
  window.removeEventListener("pointerdown", window.__at0738Record, true);
  return window.__at0738Downs || [];
})()`;

/**
 * What the shell saw around the width-button click: its pointerdowns, its
 * window's focus and blur, and the menu's mounts — read if the menu does not
 * stand, so a red says whether the click arrived and the menu came and went.
 */
const armMenuRecorder = `(function () {
  var log = (window.__at0738MenuLog = []);
  var t0 = performance.now();
  var at = function () { return Math.round(performance.now() - t0); };
  var down = function (e) {
    var t = e.target instanceof Element ? e.target : null;
    log.push(at() + " down " + (t === null ? "?" : ((t.closest("[data-testid]") || t).getAttribute("data-testid") || t.tagName)));
  };
  var focus = function () { log.push(at() + " window focus"); };
  var blur = function () { log.push(at() + " window blur"); };
  var observer = new MutationObserver(function () {
    var open = document.querySelector(${JSON.stringify(WIDTH_MENU)}) !== null;
    if (open !== window.__at0738MenuOpen) log.push(at() + (open ? " menu mounted" : " menu gone"));
    window.__at0738MenuOpen = open;
  });
  window.__at0738MenuOpen = false;
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  window.__at0738MenuStop = function () {
    observer.disconnect();
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
  };
  return null;
})()`;
const readMenuRecorder = `(function () {
  if (window.__at0738MenuStop) window.__at0738MenuStop();
  return { log: window.__at0738MenuLog || [], hasFocus: document.hasFocus() };
})()`;

describe.skipIf(!SHOULD_RUN)("at0738: a Session card's body", () => {
  test(
    "is placed at its placeholder through zoom and a settle, takes the pointer, and answers the menu",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: twoInAColumn, focusCardId: BODY_CARD });

        // Spawn the card onto a stub session. The card is already a body
        // card, so the funnel sends the spawn to its body, which binds it.
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0738-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(4, 1)));
        await app.spawnSessionNew(BODY_CARD, { tugSessionId, projectDir });
        const ready = await pollFor(
          () => bodyOf(app),
          (b) => b !== null && b.state === "ready" && b.visible,
          BODY_READY_MS,
        );
        note(`body: ${JSON.stringify(ready)}`);
        expect(ready?.state, "the card's body reports ready").toBe("ready");
        await app.body(BODY_CARD).waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`,
          { timeoutMs: BODY_READY_MS },
        );
        const neighbour = await pollFor(
          () => app.bodies(),
          (all) => all.some((b) => b.cardId === NEIGHBOUR),
          PLACED_MS,
        );
        expect(
          neighbour.some((b) => b.cardId === NEIGHBOUR),
          "the unbound neighbour is a body card too",
        ).toBe(true);

        // ---- Placement at zoom 1.0, at 0.8, and after a settle lands ----

        await expectPlaced(app, "zoom 1.0");
        await app.setPageZoom(0.8);
        await expectPlaced(app, "zoom 0.8");
        await app.setPageZoom(1.0);
        const stacked = await expectPlaced(app, "zoom 1.0 again");

        await app.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" });
        const split = await expectPlaced(app, "after the split lands");
        expect(split.height, "the split gave the body card a share of the column").toBeLessThan(stacked.height - 20);

        // ---- A click inside the body reaches the body and activates its card ----

        await app.dispatchControlAction("focus-session-card", { cardId: NEIGHBOUR });
        await pollFor(() => app.getFocusedCardId(), (id) => id === NEIGHBOUR, PLACED_MS);
        const body = app.body(BODY_CARD);
        await body.nativeClickAtElement(PROMPT_INPUT);
        await body.waitForCondition<boolean>(composerFocused, { timeoutMs: PLACED_MS });
        const focused = await pollFor(() => app.getFocusedCardId(), (id) => id === BODY_CARD, PLACED_MS);
        expect(focused, "the click in the body made its card the shell's first responder").toBe(BODY_CARD);

        // ---- A shell popover over a body keeps the pointer ----

        // The shell-chromed card's width popover, over that card's own body.
        const shellChromed = app.body(SHELL_CHROMED);
        await app.evalJS(armMenuRecorder);
        const bodyPane = `.tug-pane[data-pane-id="${SHELL_CHROMED}-pane"]`;
        await app.revealPaneControls(bodyPane);
        await app.nativeClickAtElement(`${bodyPane} ${WIDTH_BUTTON}`);
        try {
          await app.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(WIDTH_MENU)}) !== null`, {
            timeoutMs: PLACED_MS,
          });
        } catch (error) {
          note(`width menu never stood: ${JSON.stringify(await app.evalJS(readMenuRecorder))}`);
          throw error;
        }
        await app.evalJS(readMenuRecorder);
        await Bun.sleep(CLAIM_SETTLE_MS);
        const menu = await app.evalJS<Rect>(
          `(function () {
            var r = document.querySelector(${JSON.stringify(WIDTH_MENU)}).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })()`,
        );
        const frame = (await app.bodies()).find((b) => b.cardId === SHELL_CHROMED)!.frame;
        const left = Math.max(menu.x, frame.x);
        const top = Math.max(menu.y, frame.y);
        const right = Math.min(menu.x + menu.width, frame.x + frame.width);
        const bottom = Math.min(menu.y + menu.height, frame.y + frame.height);
        note(`width menu ${JSON.stringify(menu)} over body ${JSON.stringify(frame)}`);
        expect(right > left && bottom > top, "the width menu stands over the body").toBe(true);
        await app.evalJS(armDownRecorder);
        await shellChromed.evalJS(armDownRecorder);
        await app.nativeClick({ x: (left + right) / 2, y: (top + bottom) / 2 });
        const shellDowns = await pollFor(
          () => app.evalJS<string[]>(`(window.__at0738Downs || []).slice()`),
          (d) => d.length > 0,
          PLACED_MS,
        );
        const shellSaw = await app.evalJS<string[]>(readDowns);
        const bodySaw = await shellChromed.evalJS<string[]>(readDowns);
        note(`popover click: shell saw ${JSON.stringify(shellSaw)}, body saw ${JSON.stringify(bodySaw)}`);
        expect(shellDowns.length, "the click on the popover reached the shell").toBeGreaterThan(0);
        expect(bodySaw, "the click on the popover never reached the body").toEqual([]);
        await app.dispatchControlAction("dismiss-popover");
        await app.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(WIDTH_MENU)}) === null`, {
          timeoutMs: PLACED_MS,
        });

        // ---- A card-scoped menu command acts in the key body ----

        // The width button's press made the shell-chromed card key: hand the
        // keyboard back to the body card the command is read in.
        await app.dispatchControlAction("focus-session-card", { cardId: BODY_CARD });
        await pollFor(() => app.getFocusedCardId(), (id) => id === BODY_CARD, PLACED_MS);
        await body.evalJS(`(document.activeElement && document.activeElement.blur(), null)`);
        expect(await body.evalJS<boolean>(composerFocused), "the composer is blurred").toBe(false);
        expect(await app.getFocusedCardId(), "the body card is still first responder").toBe(BODY_CARD);
        const chains = async () => ({
          shell: await app.evalJS<string | null>(firstResponderJs),
          shellHasFocus: await app.evalJS<boolean>(`document.hasFocus()`),
          body: await body.evalJS<string | null>(firstResponderJs),
          bodyKeyCard: await body.evalJS<string | null>(`window.__tug.getKeyCardId()`),
          bodyHasFocus: await body.evalJS<boolean>(`document.hasFocus()`),
          bodyActive: await body.evalJS<string>(
            `document.activeElement === null ? "null" : document.activeElement.tagName + "." + document.activeElement.className`,
          ),
        });
        note(`before focus-prompt: ${JSON.stringify(await chains())}`);
        await app.dispatchControlAction("focus-prompt");
        try {
          await body.waitForCondition<boolean>(composerFocused, { timeoutMs: PLACED_MS });
        } catch (error) {
          note(`after focus-prompt: ${JSON.stringify(await chains())}`);
          throw error;
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
