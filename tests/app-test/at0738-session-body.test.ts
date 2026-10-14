/**
 * at0738-session-body.test.ts — a Session card whose content is a body: its
 * own web view, placed by the host under the shell's placeholder.
 *
 * The gate for the body path. The app launches with bodies on
 * (`TUG_BODY_VIEWS=1`), which the harness otherwise leaves off so the rest of
 * the corpus runs every card in the shell.
 *
 * **Placement and the pointer.** One Session card, spawned onto a stub
 * session, becomes a body card. Its body's frame must equal the shell
 * placeholder's viewport rect within a point after every commit — at zoom
 * 1.0, at 0.8, and after a column split, a settle, has landed (a body snaps
 * at the land). A native click inside the body's rect must reach the body —
 * its composer takes focus — and make the card the shell's first responder;
 * a click on a deck popover the shell raises over the body must reach the
 * shell instead. And a card-scoped command fired through the shell's menu
 * path (`focus-prompt`) must act in the key body.
 *
 * **Arrival.** A card opened through the picker's New takes the warm spare.
 * The host shows its container in ONE step — the sampled opacity is ≤ 0.05
 * and then 1, never between — because the reveal the user sees is the
 * shell's lid lifting over a body already composited (`body-grounding/
 * row-01-arrival` reads that frame by frame); a host fade through the
 * floor's hole would be a fade from the window's background. The container
 * does not move while it shows, and a shown body has `painted`. The card
 * opened right after it finds no spare and is made cold; each reports which
 * it was.
 *
 * **Fallback.** A body that never says it is ready (`TUG_BODY_FORCE_STALL`)
 * fails at the deadline (`TUG_BODY_READY_DEADLINE_MS`, shortened), and its
 * card mounts in the shell's own document on the binding the body's spawn
 * already made — bound once, never spawned a second time.
 *
 * **Reload and quit.** A shell reload saves every body, destroys it, and the
 * reloaded shell's restore pass makes the card a body again, bound to the
 * same session. A quit with the body card mid-turn prepares every view under
 * one deadline: the body's card reaches disk with the draft typed into it, and
 * the teardown fires no forced kill.
 *
 * **The turn.** A whole turn streams in a body: the shell's document holds no
 * transcript for the card, the shell's masthead dot reads working during the
 * turn and idle after (from the body's `card-facts`), tugcast lists one body
 * page for the card subscribed to its session alone, and the composited
 * window's rect is filled by the body's own pane surface — its commonest
 * colour, not an ink share, which the shell's grid would satisfy through an
 * empty placeholder. The history and Changes sheets
 * are opened in the body through the shell's menu path, and a composite of
 * each is kept for the look the clipping question is deferred to. The
 * WebContent processes and their resident size with two bodies and the spare
 * are noted for the program's record.
 *
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
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import type { BodyViewSnapshot, HostFrameReading } from "./_harness/client";
import { decodePngFile } from "./_harness/png";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "./_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0738-session-body";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The body card, and the unbound neighbour sharing its column. */
const BODY_CARD = "at0738-a";
const NEIGHBOUR = "at0738-b";

const PROMPT_INPUT = '[data-slot="tug-text-editor"] .cm-content';
const WIDTH_BUTTON = '[data-testid="tug-pane-title-bar-width-button"]';
const WIDTH_MENU = '[data-testid="tug-pane-title-bar-width-menu"]';

/** A body's cold start plus a stub spawn. */
const BODY_READY_MS = 30_000;
/** Placement follows a commit, or a paint after a wake; a settle lands in under a second. */
const PLACED_MS = 3_000;
/** The claim is read on the far side of a paint (bounded at 50 ms) after the surface mounts. */
const CLAIM_SETTLE_MS = 300;

const twoInAColumn = {
  cards: [
    { id: BODY_CARD, componentId: "session", title: "Body", closable: true },
    { id: NEIGHBOUR, componentId: "session", title: "Neighbour", closable: true },
  ],
  panes: [BODY_CARD, NEIGHBOUR].map((cardId) => ({
    id: `${cardId}-pane`,
    position: { x: 40, y: 40 },
    size: { width: 640, height: 480 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot: 0,
  })),
  activePaneId: `${BODY_CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const placeholderRect = (app: App): Promise<Rect | null> =>
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector('[data-body-placeholder][data-card-id="${BODY_CARD}"]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );

async function bodyOf(app: App): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === BODY_CARD) ?? null;
}

/** Poll `read` until `done` holds or `timeoutMs` passes; returns the last reading. */
async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50);
    value = await read();
  }
  return value;
}

const within = (a: Rect, b: Rect, slack = 1): boolean =>
  Math.abs(a.x - b.x) <= slack &&
  Math.abs(a.y - b.y) <= slack &&
  Math.abs(a.width - b.width) <= slack &&
  Math.abs(a.height - b.height) <= slack;

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
    `${label}: body frame ${JSON.stringify(reading.body!.frame)} equals placeholder ${JSON.stringify(reading.placeholder)} within 1 pt`,
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

/** The page's responder-chain first responder, where its surface can say. */
const firstResponderJs = `(typeof window.__tug.getFirstResponderId === "function" ? window.__tug.getFirstResponderId() : "(no accessor)")`;

const composerFocused = `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT)})`;

/** Spawn `cardId` onto a fresh stub session through the picker's New; returns the session. */
async function spawnStub(app: App, cardId: string, stubDir: string): Promise<string> {
  const tugSessionId = randomUUID();
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0738-project-")));
  onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(4, 1)));
  await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
  return tugSessionId;
}

/** Unbound Session cards stacked in one flow column, each its own pane. */
function column(cardIds: string[]): unknown {
  return {
    cards: cardIds.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: cardIds.map((cardId) => ({
      id: `${cardId}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 640, height: 480 },
      cardIds: [cardId],
      activeCardId: cardId,
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    })),
    activePaneId: `${cardIds[0]}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

interface ShowVerdict {
  /** Opacity of the sample before the rise: the last at or below 0.05. */
  firstOpacity: number;
  /** Samples strictly between transparent and opaque: a fade's, and there should be none. */
  between: number;
  /** From the last transparent sample to the first opaque one, in ms. */
  stepMs: number;
  /** The container's position held still once it could be seen. */
  still: boolean;
  /** The farthest the shown container strayed from its first shown position, in points. */
  strayed: number;
  periodMs: number;
  /** The samples around the step as `t:opacity@x,y`, for a reader of a red. */
  around: string[];
}

/**
 * Read the host's samples of a container being shown: from the last sample
 * at or below 0.05 to the first at full opacity, with whatever lies between.
 */
function showOf(reading: HostFrameReading): ShowVerdict | null {
  const samples = reading.samples ?? [];
  const rise = samples.findIndex((s) => s.opacity > 0.05);
  if (rise <= 0) return null;
  const full = samples.findIndex((s, i) => i >= rise && s.opacity >= 0.9999);
  if (full < 0) return null;
  const around = samples.slice(rise - 1, full + 1);
  const start = around[0];
  const end = around[around.length - 1];
  // A move at opacity 0 is a move nobody sees: the frame and the show land
  // in one placement, so the sample before the step may stand where the
  // container was before it was put.
  const seen = samples.slice(full).filter((s) => s.opacity > 0);
  const first = seen[0] ?? end;
  return {
    firstOpacity: start.opacity,
    between: samples.filter((s) => s.opacity > 0.05 && s.opacity < 0.9999).length,
    stepMs: end.t - start.t,
    still: seen.every((s) => Math.abs(s.x - first.x) < 0.5 && Math.abs(s.y - first.y) < 0.5),
    strayed: Math.max(0, ...seen.map((s) => Math.max(Math.abs(s.x - first.x), Math.abs(s.y - first.y)))),
    periodMs: reading.periodMs,
    around: around.map((s) => `${Math.round(s.t)}:${s.opacity.toFixed(2)}@${Math.round(s.x)},${Math.round(s.y)}`),
  };
}

interface WebContentProcess {
  pid: number;
  rssKb: number;
}

/** Every WebContent process on the machine, with its resident size. */
function webContentProcesses(): WebContentProcess[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,rss=,comm="]).stdout.toString();
  const found: WebContentProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m && m[3].includes("com.apple.WebKit.WebContent")) found.push({ pid: Number(m[1]), rssKb: Number(m[2]) });
  }
  return found;
}

/** One live connection as `GET /api/pages` lists it. */
interface PageRow {
  role: "shell" | "body" | "tool";
  card_id: string | null;
  sessions: string[] | null;
}

/** tugcast's page list, fetched from the shell's origin. */
async function pagesOf(app: App): Promise<PageRow[]> {
  await app.evalJS(`(function () {
    window.__at0738Pages = undefined;
    fetch("/api/pages")
      .then(function (r) { return r.json(); })
      .then(function (j) { window.__at0738Pages = j.pages; })
      .catch(function (e) { window.__at0738Pages = { error: String(e) }; });
    return null;
  })()`);
  return app.waitForCondition<PageRow[]>(`window.__at0738Pages`, { timeoutMs: PLACED_MS });
}

/** The shell masthead's phase dot for a card: its role and state, or null where none stands. */
const mastheadDot = (cardId: string): string =>
  `(function () {
    var dot = document.querySelector('.tug-pane[data-pane-id="${cardId}-pane"] [data-slot="session-masthead"] [data-slot="tug-progress-indicator"]');
    return dot === null ? null : { role: dot.getAttribute("data-role"), state: dot.getAttribute("data-state") };
  })()`;

/** The body's prompt entry's phase. */
const promptPhase = `(function () {
  var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
  return entry === null ? null : entry.getAttribute("data-phase");
})()`;

/**
 * What the composited window paints inside `rect`: its commonest colour, as
 * `rgb(r, g, b)`, and the share of pixels that differ from it. The colour is
 * the fact that says WHOSE paint it is — the body's pane surface, or the
 * shell's canvas showing through an empty placeholder — where the share
 * alone cannot: the shell's grid is ink too.
 */
function paintIn(
  shotPath: string,
  shot: { width: number; height: number; contentWidth: number; contentHeight: number },
  rect: Rect,
): { fill: string; ink: number } {
  const png = decodePngFile(shotPath);
  const scale = shot.width / shot.contentWidth;
  const titleBarPx = shot.height - shot.contentHeight * scale;
  const counts = new Map<number, number>();
  const pixels: number[] = [];
  for (let y = Math.ceil(rect.y * scale); y < Math.floor((rect.y + rect.height) * scale); y += 2) {
    for (let x = Math.ceil(rect.x * scale); x < Math.floor((rect.x + rect.width) * scale); x += 2) {
      const i = (Math.round(titleBarPx + y) * png.width + x) * 4;
      const key = (png.rgba[i] << 16) | (png.rgba[i + 1] << 8) | png.rgba[i + 2];
      pixels.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (pixels.length === 0) return { fill: "rgb(0, 0, 0)", ink: 0 };
  let fill = 0;
  let most = -1;
  for (const [key, n] of counts) if (n > most) [fill, most] = [key, n];
  const far = (a: number, b: number): boolean =>
    Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) +
      Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) +
      Math.abs((a & 255) - (b & 255)) >
    24;
  return {
    fill: `rgb(${(fill >> 16) & 255}, ${(fill >> 8) & 255}, ${fill & 255})`,
    ink: pixels.filter((p) => far(p, fill)).length / pixels.length,
  };
}

describe.skipIf(!SHOULD_RUN)("at0738: a Session card's body", () => {
  test(
    "is placed at its placeholder through zoom and a settle, takes the pointer, and answers the menu",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: twoInAColumn, focusCardId: BODY_CARD });

        // Spawn the card onto a stub session: the funnel hands it to a body.
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

        // ---- A shell popover over the body keeps the pointer ----

        await app.evalJS(armMenuRecorder);
        const bodyPane = `.tug-pane[data-pane-id="${BODY_CARD}-pane"]`;
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
        const frame = (await bodyOf(app))!.frame;
        const left = Math.max(menu.x, frame.x);
        const top = Math.max(menu.y, frame.y);
        const right = Math.min(menu.x + menu.width, frame.x + frame.width);
        const bottom = Math.min(menu.y + menu.height, frame.y + frame.height);
        note(`width menu ${JSON.stringify(menu)} over body ${JSON.stringify(frame)}`);
        expect(right > left && bottom > top, "the width menu stands over the body").toBe(true);
        await app.evalJS(armDownRecorder);
        await body.evalJS(armDownRecorder);
        await app.nativeClick({ x: (left + right) / 2, y: (top + bottom) / 2 });
        const shellDowns = await pollFor(
          () => app.evalJS<string[]>(`(window.__at0738Downs || []).slice()`),
          (d) => d.length > 0,
          PLACED_MS,
        );
        const shellSaw = await app.evalJS<string[]>(readDowns);
        const bodySaw = await body.evalJS<string[]>(readDowns);
        note(`popover click: shell saw ${JSON.stringify(shellSaw)}, body saw ${JSON.stringify(bodySaw)}`);
        expect(shellDowns.length, "the click on the popover reached the shell").toBeGreaterThan(0);
        expect(bodySaw, "the click on the popover never reached the body").toEqual([]);
        await app.dispatchControlAction("dismiss-popover");
        await app.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(WIDTH_MENU)}) === null`, {
          timeoutMs: PLACED_MS,
        });

        // ---- A card-scoped menu command acts in the key body ----

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

  test(
    "arrives warm from the spare, shown in one step under the shell's lid, and cold when there is no spare",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      const WARM = "at0738-warm";
      const COLD = "at0738-cold";
      try {
        await app.seedDeckState({ state: column([WARM, COLD]), focusCardId: WARM });

        // The spare is made a beat after the shell paints, and waits connected.
        const spares = await pollFor(
          () => app.bodies(),
          (all) => all.some((b) => b.cardId === null && b.state === "connected"),
          BODY_READY_MS,
        );
        note(`before the opens: ${JSON.stringify(spares.map((b) => ({ cardId: b.cardId, state: b.state })))}`);
        expect(spares.some((b) => b.cardId === null && b.state === "connected"), "a spare body waits, connected").toBe(true);

        // The first open takes the spare, and its showing is sampled alone:
        // a neighbour binding below it would re-lay the column under it.
        await spawnStub(app, WARM, stubDir);
        await pollFor(() => app.bodies(), (all) => all.some((b) => b.cardId === WARM), PLACED_MS);
        await app.hostFrames({ op: "arm", windowMs: 8_000, layer: WARM });
        await pollFor(
          () => app.bodies(),
          (all) => {
            const b = all.find((x) => x.cardId === WARM);
            return b !== undefined && b.state === "ready" && b.visible && b.opacity >= 0.9999;
          },
          BODY_READY_MS,
        );
        // The second opens at once, inside the second the spare takes to be
        // replaced, so it finds none.
        await spawnStub(app, COLD, stubDir);

        const settled = await pollFor(
          () => app.bodies(),
          (all) =>
            [WARM, COLD].every((id) => {
              const b = all.find((x) => x.cardId === id);
              return b !== undefined && b.state === "ready" && b.visible && b.opacity >= 0.9999;
            }),
          BODY_READY_MS,
        );
        await Bun.sleep(100);
        const reading = (await app.hostFrames({ op: "read" })) as HostFrameReading;
        const warm = settled.find((b) => b.cardId === WARM);
        const cold = settled.find((b) => b.cardId === COLD);
        note(`warm body: start ${warm?.start}, ready ${warm?.readyMs?.toFixed(1)} ms`);
        note(`cold body: start ${cold?.start}, ready ${cold?.readyMs?.toFixed(1)} ms`);
        expect(warm?.state, "the first card's body is ready").toBe("ready");
        expect(cold?.state, "the second card's body is ready").toBe("ready");
        expect(warm!.start, "the first card bound the spare").toBe("warm");
        expect(cold!.start, "the second card, with the spare taken, was made cold").toBe("cold");
        expect(warm!.painted, "a shown body has painted").toBe(true);

        const show = showOf(reading);
        note(`show: ${JSON.stringify(show)}; ${reading.samples?.length ?? 0} samples, period ${reading.periodMs.toFixed(2)} ms`);
        expect(show, "the host sampled the container going from transparent to opaque").not.toBeNull();
        expect(show!.firstOpacity, "the container was transparent before it showed").toBeLessThanOrEqual(0.05);
        expect(show!.between, "the container shows in one step under the lid — no host fade through the hole").toBe(0);
        expect(show!.still, "the container did not move once shown").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "falls back to the shell's document when a body never says it is ready, bound once",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: {
          TUG_BODY_VIEWS: "1",
          TUG_BODY_FORCE_STALL: "1",
          TUG_BODY_READY_DEADLINE_MS: "1500",
          [STUB_TRANSCRIPT_DIR_ENV]: stubDir,
        },
      });
      const STALLED = "at0738-stalled";
      try {
        await app.seedDeckState({ state: column([STALLED]), focusCardId: STALLED });
        await spawnStub(app, STALLED, stubDir);

        const composerInShell = `document.querySelector('.tug-pane[data-pane-id="${STALLED}-pane"] ${PROMPT_INPUT}') !== null`;
        const inShell = async () => ({
          body: (await app.bodies()).find((b) => b.cardId === STALLED) ?? null,
          placeholder: await app.evalJS<boolean>(`document.querySelector('[data-body-placeholder][data-card-id="${STALLED}"]') !== null`),
          composer: await app.evalJS<boolean>(composerInShell),
        });
        const mounted = await pollFor(inShell, (s) => s.body === null && !s.placeholder && s.composer, BODY_READY_MS);
        note(`after the deadline: ${JSON.stringify(mounted)}`);
        expect(mounted.body, "the stalled body is gone").toBeNull();
        expect(mounted.placeholder, "the shell no longer stands a placeholder for the card").toBe(false);
        expect(mounted.composer, "the card mounts in the shell's own document").toBe(true);

        // A re-run of the `new` intent would have bound the card a second time.
        await Bun.sleep(1_000);
        const acks = await app.evalJS<number>(
          `window.__deckTrace.dump().filter(function (e) {
            return e.kind === "session-lifecycle" && e.event === "spawn.ack" && e.fields && e.fields.card_id === ${JSON.stringify(STALLED)};
          }).length`,
        );
        note(`spawn_session_ok for the card: ${acks}`);
        expect(acks, "the card was bound by exactly one spawn").toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "returns as a body on its session after a reload, and reaches disk on a quit mid-turn",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      onTestRunEnd(() => rmTempTugbank(tugbankPath));
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { TUG_BODY_VIEWS: "1", TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      const SAFE = "at0738-safe";
      const DRAFT = "at0738 draft survives the quit";
      let quit = false;
      try {
        await app.seedDeckState({ state: column([SAFE]), focusCardId: SAFE });
        const tugSessionId = await spawnStub(app, SAFE, stubDir);
        const readyBody = (b: BodyViewSnapshot | null): boolean => b !== null && b.state === "ready" && b.visible;
        const safeBody = async () => (await app.bodies()).find((b) => b.cardId === SAFE) ?? null;
        expect(readyBody(await pollFor(safeBody, readyBody, BODY_READY_MS)), "the card's body is ready").toBe(true);

        // ---- A reload: every body saves and goes; the restore makes it again ----

        await app.appReload({ timeoutMs: 20_000 });
        const back = await pollFor(safeBody, readyBody, BODY_READY_MS);
        const boundTo = await pollFor(
          () =>
            app.evalJS<string | null>(
              `(function () { try { return window.__tug.cardLineFacts(${JSON.stringify(SAFE)}).tugSessionId; } catch (e) { return null; } })()`,
            ),
          (id) => id !== null,
          BODY_READY_MS,
        );
        const placeholder = await app.evalJS<boolean>(
          `document.querySelector('[data-body-placeholder][data-card-id="${SAFE}"]') !== null`,
        );
        note(`after the reload: body ${JSON.stringify(back)}, bound to ${boundTo} (spawned ${tugSessionId})`);
        expect(readyBody(back), "the card is a body again after the reload").toBe(true);
        expect(placeholder, "the reloaded shell stands a placeholder for it").toBe(true);
        expect(boundTo, "bound to the same session").toBe(tugSessionId);

        // ---- A quit mid-turn: the body's card reaches disk ----

        const body = app.body(SAFE);
        /** Run one stage of the quit's set-up, naming it if it throws. */
        const stage = async (label: string, run: () => Promise<unknown>): Promise<void> => {
          try {
            await run();
          } catch (error) {
            throw new Error(`${label}: ${String(error)}`);
          }
        };
        // A body reports ready at its bound even before a resume lands, so
        // the session is driven once the card shows its transcript.
        await stage("the reloaded body binds its session", () =>
          body.waitForCondition<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null`, {
            timeoutMs: BODY_READY_MS,
          }),
        );
        await stage("a prompt is sent in the body", () =>
          body.driveSession({ op: "send", text: "Walk the module and report each pass." }),
        );
        await stage("the body's turn streams", () =>
          body.waitForCondition<boolean>(
            `(function () {
              var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
              return entry !== null && entry.getAttribute("data-phase") === "streaming";
            })()`,
            { timeoutMs: BODY_READY_MS },
          ),
        );
        await stage("the composer takes the click", async () => {
          await body.nativeClickAtElement(PROMPT_INPUT);
          await body.waitForCondition<boolean>(composerFocused, { timeoutMs: PLACED_MS });
        });
        await stage("the draft is typed", async () => {
          await app.nativeType(DRAFT);
          await body.waitForCondition<boolean>(
            `(function () {
              var input = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
              return input !== null && input.textContent.indexOf(${JSON.stringify(DRAFT)}) >= 0;
            })()`,
            { timeoutMs: PLACED_MS },
          );
        });
        await app.quitGracefully({ timeoutMs: 30_000 });
        quit = true;
        const report = app.quiesceReport();
        const bag = tugbankRead<unknown>(tugbankPath, "dev.tugapp.deck.cardstate", SAFE);
        const bagText = JSON.stringify(bag?.value ?? null);
        note(`quiesce: ${JSON.stringify(report)}; bag holds the draft: ${bagText.includes(DRAFT)}`);
        expect(report, "the app wrote its shutdown report").not.toBeNull();
        expect(report!.sigkills, "the teardown forced no kill").toEqual([]);
        expect(bag, "the body's card has a bag on disk").not.toBeNull();
        expect(bagText.includes(DRAFT), "the bag on disk holds the draft typed mid-turn").toBe(true);
      } finally {
        if (!quit) await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "streams a whole turn in the body, with the shell's masthead fed from the bus",
    async () => {
      const stubDir = stubDirectory();
      const before = new Set(webContentProcesses().map((p) => p.pid));
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      const TURN = "at0738-turn";
      const OTHER = "at0738-other";
      try {
        await app.seedDeckState({ state: column([TURN, OTHER]), focusCardId: TURN });
        const readyBody = (id: string) => (all: BodyViewSnapshot[]) =>
          all.some((b) => b.cardId === id && b.state === "ready" && b.visible);
        const tugSessionId = await spawnStub(app, TURN, stubDir);
        await pollFor(() => app.bodies(), readyBody(TURN), BODY_READY_MS);
        await spawnStub(app, OTHER, stubDir);
        await pollFor(() => app.bodies(), readyBody(OTHER), BODY_READY_MS);

        // ---- Two bodies and the spare: what the program's record holds ----

        const withSpare = await pollFor(
          () => app.bodies(),
          (all) => all.some((b) => b.cardId === null && b.state === "connected"),
          BODY_READY_MS,
        );
        const added = webContentProcesses().filter((p) => !before.has(p.pid));
        note(
          `views: ${JSON.stringify(withSpare.map((b) => ({ cardId: b.cardId, state: b.state, start: b.start, readyMs: b.readyMs })))}`,
        );
        note(
          `WebContent processes this launch added: ${added.length}, ${Math.round(added.reduce((s, p) => s + p.rssKb, 0) / 1024)} MB resident ` +
            `(each MB: ${JSON.stringify(added.map((p) => Math.round(p.rssKb / 1024)))})`,
        );

        // ---- The turn streams in the body ----

        const body = app.body(TURN);
        await body.waitForCondition<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null`, {
          timeoutMs: BODY_READY_MS,
        });
        await body.driveSession({ op: "send", text: "Walk the module and report each pass." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: BODY_READY_MS });

        const shellTranscript = await app.evalJS<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="${TURN}-pane"] [data-testid="session-card-transcript"]') !== null`,
        );
        expect(shellTranscript, "the shell's document holds no transcript for the body card").toBe(false);

        const working = await pollFor(
          () => app.evalJS<{ role: string; state: string } | null>(mastheadDot(TURN)),
          (d) => d !== null && d.state === "running",
          PLACED_MS,
        );
        note(`masthead dot mid-turn: ${JSON.stringify(working)}`);
        expect(working, "the shell's masthead stands a phase dot for the body card").not.toBeNull();
        expect(working!.state, "the masthead reads the body's turn as working").toBe("running");

        const pages = await pagesOf(app);
        const turnPages = pages.filter((p) => p.role === "body" && p.card_id === TURN);
        note(`pages: ${JSON.stringify(pages.map((p) => ({ role: p.role, card: p.card_id, sessions: p.sessions })))}`);
        expect(turnPages.length, "tugcast lists one body page for the card").toBe(1);
        expect(turnPages[0].sessions, "the body page takes its own session's frames alone").toEqual([tugSessionId]);

        // Key first: the shell washes an inactive pane, body card or not,
        // so only a key card's rect reads as the body's own surface.
        await app.dispatchControlAction("focus-session-card", { cardId: TURN });
        await pollFor(() => app.getFocusedCardId(), (id) => id === TURN, PLACED_MS);
        await Bun.sleep(300);
        const frame = (await app.bodies()).find((b) => b.cardId === TURN)!.frame;
        const shot = await app.captureWindow();
        copyFileSync(shot.path, "/tmp/at0738-turn.png");
        const paint = paintIn(shot.path, shot, frame);
        // Both colours as the composite has them: through a 2D canvas, since
        // a computed style keeps the theme's oklch spelling.
        const asRgb = (expr: string): string => `(function () {
          var c = document.createElement("canvas").getContext("2d");
          c.fillStyle = ${expr}; c.fillRect(0, 0, 1, 1);
          var d = c.getImageData(0, 0, 1, 1).data;
          return "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")";
        })()`;
        const bodySurface = await body.evalJS<string>(asRgb(`getComputedStyle(document.body).backgroundColor`));
        // What the shell lays over the frame — the frame dim, a normal-blend
        // layer, composites over the hole as it does over a shell card — so
        // the rect reads as the body's surface under that layer. The frame's
        // own `data-focused` is the shell's, read as it stands.
        const expected = await app.evalJS<{ fill: string; focused: string | null; layer: string }>(`(function () {
          var pane = document.querySelector('.tug-pane[data-pane-id="${TURN}-pane"]');
          var s = getComputedStyle(pane, "::after");
          var c = document.createElement("canvas").getContext("2d");
          c.fillStyle = ${JSON.stringify(bodySurface)}; c.fillRect(0, 0, 1, 1);
          c.globalAlpha = parseFloat(s.opacity); c.fillStyle = s.backgroundColor; c.fillRect(0, 0, 1, 1);
          var d = c.getImageData(0, 0, 1, 1).data;
          return { fill: "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")", focused: pane.getAttribute("data-focused"),
            layer: s.backgroundColor + " @ " + s.opacity };
        })()`);
        const shellCanvas = await app.evalJS<string | null>(
          `(function () { var f = document.querySelector('[data-deck-canvas-floor]'); return f === null ? null : ${asRgb("getComputedStyle(f).backgroundColor")}; })()`,
        );
        const floorClip = await app.evalJS<string | null>(
          `(function () { var f = document.querySelector('[data-deck-canvas-floor]'); return f === null ? null : f.style.clipPath; })()`,
        );
        note(`shell floor clip: ${floorClip}`);
        note(`shell frame for the card: data-focused=${expected.focused}, frame dim ${expected.layer}, expected fill ${expected.fill}`);
        note(
          `composite in the body's rect ${JSON.stringify(frame)}: fill ${paint.fill}, ink ${(paint.ink * 100).toFixed(1)}%; ` +
            `body surface ${bodySurface}, shell canvas floor ${shellCanvas}`,
        );
        expect(shellCanvas, "the shell stands a canvas floor under the deck on a body host").not.toBeNull();
        expect(paint.fill, "the body's rect is painted by the body, not the shell's canvas").not.toBe(shellCanvas);
        const bodyFocused = await body.evalJS<string | null>(
          `document.querySelector(".body-pane-root")?.getAttribute("data-focused") ?? null`,
        );
        expect(bodyFocused, "the key card's body reads itself as focused").toBe("true");
        const channel = (rgb: string): number[] => rgb.match(/\d+/g)!.map(Number);
        const off = channel(paint.fill).map((v, i) => Math.abs(v - channel(expected.fill)[i]));
        expect(
          Math.max(...off),
          `the body's rect is the body's own surface under the shell's frame layer (fill ${paint.fill}, expected ${expected.fill})`,
        ).toBeLessThanOrEqual(4);
        expect(paint.ink, "the body's paint carries its content").toBeGreaterThan(0.01);

        // ---- The turn ends ----

        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 90_000 });
        const rested = await pollFor(
          () => app.evalJS<{ role: string; state: string } | null>(mastheadDot(TURN)),
          (d) => d !== null && d.state === "stopped",
          PLACED_MS,
        );
        note(`masthead dot after the turn: ${JSON.stringify(rested)}`);
        expect(rested?.state, "the masthead reads the body's session as idle once the turn ends").toBe("stopped");

        // ---- The in-card sheets, opened through the shell's menu path ----

        await app.dispatchControlAction("focus-session-card", { cardId: TURN });
        await pollFor(() => app.getFocusedCardId(), (id) => id === TURN, PLACED_MS);
        const sheets = [
          { action: "toggle-history-view", selector: '[data-slot="session-history-view"]', keep: "/tmp/at0738-history-sheet.png" },
          {
            action: "toggle-changes-view",
            selector: '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]',
            keep: "/tmp/at0738-changes-sheet.png",
          },
        ];
        for (const sheet of sheets) {
          await app.dispatchControlAction(sheet.action);
          try {
            await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(sheet.selector)}) !== null`, {
              timeoutMs: PLACED_MS,
            });
          } catch (error) {
            note(
              `${sheet.action} never stood: shell responder ${await app.evalJS<string | null>(firstResponderJs)}, ` +
                `body responder ${await body.evalJS<string | null>(firstResponderJs)}, ` +
                `body key card ${await body.evalJS<string | null>(`window.__tug.getKeyCardId()`)}`,
            );
            throw error;
          }
          await Bun.sleep(500);
          const capture = await app.captureWindow();
          copyFileSync(capture.path, sheet.keep);
          note(`${sheet.action}: composite kept at ${sheet.keep}`);
          await app.dispatchControlAction(sheet.action);
          await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(sheet.selector)}) === null`, {
            timeoutMs: PLACED_MS,
          });
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
