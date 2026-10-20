/**
 * one-view-fixture.ts — what the one-view readings share: a deck of Session
 * cards in one pane, a card's view as the host has it, rects read in a
 * card's own page, and still and burst captures of the composite.
 *
 * A card that draws its own chrome is one view, and these readings judge
 * that by colour in the composite (`at0744`, `at0746`).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App, BodyApp } from "./_harness";
import type { CaptureBurstFrame, CaptureBurstReading } from "./_harness/client";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { streamingTranscript } from "./streaming-stub-fixture";
import { pollFor } from "./body-grounding/_frames";

export const BODY_READY_MS = 30_000;
export const BURST_MS = 2_000;
export const BURST_INTERVAL_MS = 25;
/** How near a pixel must be to a colour to be read as it. */
export const COLOUR_TOLERANCE = 10;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A deck of Session cards, all in one free pane, the first in front. */
export function sessionPaneDeck(cardIds: string[]): unknown {
  return {
    cards: cardIds.map((id) => ({ id, componentId: "session", title: "Session", closable: true })),
    panes: [
      {
        id: "one-view-pane",
        position: { x: 30, y: 40 },
        size: { width: 640, height: 520 },
        cardIds,
        activeCardId: cardIds[0],
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "one-view-pane",
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** `selector`'s rect in `body`'s own viewport, or null. */
export function rectIn(body: BodyApp, selector: string): Promise<Rect | null> {
  return body.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
}

/** Where the host has `card`'s view, window content points, or null when it is not placed visible. */
export async function viewOf(app: App, card: string): Promise<Rect | null> {
  const b = (await app.bodies()).find((s) => s.cardId === card);
  return b === undefined || !b.visible ? null : b.frame;
}

/** Bind `card` to a stub session whose short transcript runs out at once. */
export async function spawnWithTranscript(app: App, stubDir: string, card: string): Promise<void> {
  const tugSessionId = randomUUID();
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-one-view-project-")));
  onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
  await app.spawnSessionNew(card, { tugSessionId, projectDir });
}

/** Wait until `card`'s page has its turn idle and its content painted under its finished chrome. */
export async function cardAtRest(app: App, card: string): Promise<BodyApp> {
  const body = app.body(card);
  await body.waitForCondition<boolean>(
    `document.querySelector('[data-slot="tug-prompt-entry"]')?.getAttribute("data-phase") === "idle"`,
    { timeoutMs: 15_000 },
  );
  await body.waitForCondition<boolean>(`document.querySelector('[data-content-painted]') !== null`, { timeoutMs: 5_000 });
  return body;
}

/** Arm a burst over `crop`. */
export async function armBurst(app: App, crop: Rect): Promise<void> {
  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
}

/** The armed burst, once it has finished. */
export function readBurst(app: App): Promise<CaptureBurstReading> {
  return pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
}

/** One still frame of `crop`: the composite as it stands. */
export async function still(app: App, crop: Rect): Promise<{ frame: CaptureBurstFrame; scale: number }> {
  await app.captureBurst({ op: "arm", durationMs: 60, intervalMs: 30, crop });
  const r = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (v) => v.done, 3_000);
  return { frame: r.frames[r.frames.length - 1], scale: r.scale };
}
