/**
 * session-body-fixture.ts — what the at0738 Session-card body files share.
 *
 * The body gate was one file, `at0738-session-body`, and is now one file per
 * leg (placement, arrival, fallback, reload and quit, the turn), each its own
 * launch. The helpers below are the ones more than one leg reads; a helper one
 * leg alone reads stays in that leg's file.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "./_harness";
import type { HostFrameReading } from "./_harness/client";
import { decodePngFile } from "./_harness/png";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { streamingTranscript } from "./streaming-stub-fixture";

export const PROMPT_INPUT = '[data-slot="tug-text-editor"] .cm-content';
export const WIDTH_BUTTON = '[data-testid="tug-pane-title-bar-width-button"]';
export const WIDTH_MENU = '[data-testid="tug-pane-title-bar-width-menu"]';

/** A body's cold start plus a stub spawn. */
export const BODY_READY_MS = 30_000;
/** Placement follows a commit, or a paint after a wake; a settle lands in under a second. */
export const PLACED_MS = 3_000;
/** The claim is read on the far side of a paint (bounded at 50 ms) after the surface mounts. */
export const CLAIM_SETTLE_MS = 300;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Poll `read` until `done` holds or `timeoutMs` passes; returns the last reading. */
export async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50);
    value = await read();
  }
  return value;
}

/** The page's responder-chain first responder, where its surface can say. */
export const firstResponderJs = `(typeof window.__tug.getFirstResponderId === "function" ? window.__tug.getFirstResponderId() : "(no accessor)")`;

export const composerFocused = `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT)})`;

/**
 * Spawn `cardId` onto a fresh stub session through the picker's New; returns
 * the session. `messages` sizes the one turn a prompt replays — four, about
 * ten seconds at the stub's pace, unless a leg needs it shorter.
 */
export async function spawnStub(app: App, cardId: string, stubDir: string, messages = 4): Promise<string> {
  const tugSessionId = randomUUID();
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0738-project-")));
  onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(messages, 1)));
  await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
  return tugSessionId;
}

/** Unbound Session cards stacked in one flow column, each its own pane. */
export function column(cardIds: string[]): unknown {
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

export interface ShowVerdict {
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
export function showOf(reading: HostFrameReading): ShowVerdict | null {
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

export interface WebContentProcess {
  pid: number;
  rssKb: number;
}

/** Every WebContent process on the machine, with its resident size. */
export function webContentProcesses(): WebContentProcess[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,rss=,comm="]).stdout.toString();
  const found: WebContentProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m && m[3].includes("com.apple.WebKit.WebContent")) found.push({ pid: Number(m[1]), rssKb: Number(m[2]) });
  }
  return found;
}

/** One live connection as `GET /api/pages` lists it. */
export interface PageRow {
  role: "shell" | "body" | "tool";
  card_id: string | null;
  sessions: string[] | null;
}

/** tugcast's page list, fetched from the shell's origin. */
export async function pagesOf(app: App): Promise<PageRow[]> {
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

/**
 * The masthead's phase dot, read in a Session card's own page — where the
 * card draws its chrome, masthead and all: its role and state, or null where
 * none stands.
 */
export const mastheadDot = (): string =>
  `(function () {
    var dot = document.querySelector('.body-chrome-frame [data-slot="session-masthead"] [data-slot="tug-progress-indicator"]');
    return dot === null ? null : { role: dot.getAttribute("data-role"), state: dot.getAttribute("data-state") };
  })()`;

/** The body's prompt entry's phase. */
export const promptPhase = `(function () {
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
export function paintIn(
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
