/**
 * row-03-departure.test.ts — a card departs as one piece, and the hole
 * closes with it.
 *
 * The bar's third row ([B02] row 3). A body card standing above a neighbour
 * in a column is closed through File › Close Card — the real menu item,
 * performed — and every composited frame of its content rect is read from
 * the close on. The shell hides the body at the commit that starts the
 * departure, with the rect it had: the floor's hole closes and the lid goes
 * back on in the frame the chrome starts to leave, so no frame shows the bare
 * window through an open hole, and the chrome leaves carrying a blank surface
 * rather than standing over a body that stays put. When the departure has
 * landed the host holds no body for the card.
 *
 * Frames are judged by surface colour, never ink share ([B05]): an open hole
 * with nothing beneath it is canvas-coloured paint with none of the floor's
 * grid in it.
 *
 * Every other kind that is a body is closed the same way, standing focused
 * beside an unbound Session card.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/HostFrameMeter.swift
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { classifyFrame, describeFrames, FLOOR_BY_CLASS, floorMeasure, pollFor, readPalette, showsBareHole, type FloorMeasure } from "./_frames";
import { closeButtonOfPopover } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { kindsUnderTest, sessionUnderTest } from "./_kinds";

const TEST_NAME = "body-grounding-row-03-departure";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const BODY_CARD = "row03-body";
const NEIGHBOUR = "row03-neighbour";
const BODY_READY_MS = 30_000;
const PLACED_MS = 3_000;
const BURST_MS = 3_000;
const BURST_INTERVAL_MS = 33;
/**
 * How far a pixel may stand from a palette colour and still be it, after the close. Tighter
 * than the classifier's default: after the close the crop is the unbound
 * neighbour's content, the floor's grid seen through its picker's scrim, and
 * those dimmed grid lines fall within 8 of the pane surface — which is the
 * body's own colour now that nothing of the neighbour leaks over it — and
 * stop counting as grid, which the bare-hole rule reads as a hole.
 */
const TOLERANCE = 4;

/** The body card above an unbound neighbour, one flow column. */
const column = {
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

const promptPhase = `(function () {
  var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
  return entry === null ? null : entry.getAttribute("data-phase");
})()`;

async function bodyOf(app: App, card: string): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === card) ?? null;
}

/**
 * The close and its reading, for `card` standing as a body, focused: File ›
 * Close Card performed, and every frame of its rect read from then on.
 */
async function departLeg(app: App, card: string, measure: FloorMeasure = FLOOR_BY_CLASS): Promise<void> {
  const body = app.body(card);
  const frame = (await bodyOf(app, card))!.frame;
  const crop = {
    x: Math.ceil(frame.x) + 2,
    y: Math.ceil(frame.y) + 2,
    width: Math.floor(frame.width) - 4,
    height: Math.floor(frame.height) - 4,
  };
  const probe = (await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop })) as { armed: true };
  expect(probe.armed).toBe(true);
  const probeReading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    PLACED_MS,
  );
  const standingFrame = probeReading.frames[probeReading.frames.length - 1];
  const palette = await readPalette(app, probeReading.windowBackground, standingFrame);
  const standing = classifyFrame(standingFrame, palette);
  const bodyFocused = await body.evalJS<string | null>(
    `document.querySelector(".body-pane-root")?.getAttribute("data-focused") ?? null`,
  );
  note(`palette ${JSON.stringify(palette)}; body data-focused=${bodyFocused}; body standing: ${describeFrames([standing])}`);
  expect(measure.own(standing), "the standing body fills its rect with its own paint").toBeGreaterThan(0.95);

  // ---- Close, the menu's way, and read every frame ----
  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const closeWall = Date.now();
  const closed = await app.performMenuItem("file.closeCard");
  note(`performMenuItem(file.closeCard): ${JSON.stringify(closed)}`);
  expect(closed.found && closed.enabled && closed.performed, "File › Close Card is found, enabled and performed").toBe(true);
  // A card that asks before it closes asks in the confirm the shell draws over
  // its chrome, and the close is that confirm's Close. A Session card with no
  // turn running waives it; the Overview never does.
  const asked = await pollFor(() => closeButtonOfPopover(app), (p) => p !== null, 600);
  if (asked !== null) {
    note(`the card asked before closing; answering Close at ${JSON.stringify(asked)}`);
    await app.nativeClick(asked);
  }
  const gone = await pollFor(() => bodyOf(app, card), (b) => b === null, BODY_READY_MS);
  if (gone !== null) {
    note(`after the close the deck holds ${JSON.stringify(await app.evalJS<string[]>(`Array.from(document.querySelectorAll(".tug-pane [data-card-id]")).map(function (el) { return el.getAttribute("data-card-id"); })`))}; it still names ${card}: ${await app.evalJS<boolean>(`document.querySelector('.tug-pane [data-card-id="${card}"]') !== null`)}; its body ${JSON.stringify({ state: gone.state, visible: gone.visible, frame: gone.frame })}; the sidebars ${JSON.stringify(await app.evalJS<unknown>("window.tugdeck.diag.getDeckState().imposition.sidebars"))}`);
  }
  expect(gone, "the host holds no body for the closed card once it has departed").toBeNull();
  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    BURST_MS + 5_000,
  );
  expect(reading.done, "the burst finished").toBe(true);
  note(
    `after the close: panes ${JSON.stringify(await app.evalJS<unknown>(`Array.from(document.querySelectorAll(".tug-pane")).map(function (p) { var r = p.getBoundingClientRect(); return [p.getAttribute("data-pane-id"), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), getComputedStyle(p).zIndex, p.getAttribute("data-focused"), p.getAttribute("data-body-cut"), p.style.getPropertyValue("--tugx-pane-cut").slice(0, 20), getComputedStyle(p, "::after").opacity, getComputedStyle(p, "::after").clipPath.slice(0, 20), getComputedStyle(p.querySelector(".tug-pane-chrome")).clipPath.slice(0, 20)]; })`))}; ` +
      `host ${JSON.stringify((await app.bodies()).map((b) => [b.cardId, b.state, b.visible, b.frame]))}; placer ${JSON.stringify(await app.evalJS<unknown>("window.tugdeck.diag.getBodyPlacement()"))}`,
  );

  const frames = reading.frames.map((f) => classifyFrame(f, palette, TOLERANCE));
  const after = frames.filter((f) => f.wall >= closeWall);
  const bare = after.filter((f) => showsBareHole(f));
  const lidFrames = after.filter((f) => f.surface > 0.9).length;
  const last = after[after.length - 1];
  note(
    `${after.length} frames after the close; ${bare.length} show a bare hole; ${lidFrames} blank-lid frames; ` +
      `last frame: ${describeFrames([last])}`,
  );
  if (bare.length > 0) note(`bare-hole frames\n${describeFrames(bare)}`);
  expect(bare.length, "no frame after the close shows the bare window through an open hole").toBe(0);
  expect(
    last.canvas + last.grid + last.surface + last.other,
    "the departed rect is the floor or the neighbour, whole",
  ).toBeGreaterThan(0.99);
  const placeholder = await app.evalJS<boolean>(
    `document.querySelector('[data-body-placeholder][data-card-id="${card}"]') !== null`,
  );
  expect(placeholder, "the departed card's placeholder is gone from the shell").toBe(false);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 3: departure", () => {
  for (const kind of kindsUnderTest(3)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: File › Close Card: the hole closes in the frame the chrome leaves, and no frame shows the bare window`,
      async () => {
        const card = `row03-${kind.componentId}`;
        const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}`, foreground: true });
        try {
          await app.seedDeckState({ state: kindDeck(kind, card, { sessions: [NEIGHBOUR] }), focusCardId: card });
          await standUpKind(app, kind, card);
          await app.dispatchControlAction("focus-session-card", { cardId: card });
          const key = await pollFor(() => app.evalJS<string | null>("window.__tug.getActiveCardId()"), (id) => id === card, PLACED_MS);
          expect(key, `the ${kind.componentId} card is the key card`).toBe(card);
          await Bun.sleep(400);
          await departLeg(app, card, floorMeasure(kind.rail));
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  test.skipIf(!sessionUnderTest(3))(
    "File › Close Card: the hole closes in the frame the chrome leaves, and no frame shows the bare window",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: column, focusCardId: BODY_CARD });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-row03-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
        await app.spawnSessionNew(BODY_CARD, { tugSessionId, projectDir });
        const shown = await pollFor(() => bodyOf(app, BODY_CARD), (b) => b !== null && b.visible, BODY_READY_MS);
        expect(shown?.visible, "the body card's body is placed visible").toBe(true);

        // The turn the stub replays runs out, so the close asks nothing.
        const body = app.body(BODY_CARD);
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 90_000 });
        await app.dispatchControlAction("focus-session-card", { cardId: BODY_CARD });
        await pollFor(() => app.getFocusedCardId(), (id) => id === BODY_CARD, PLACED_MS);
        await Bun.sleep(400);

        await departLeg(app, BODY_CARD);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
