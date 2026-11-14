/**
 * _row-03.ts — what the pieces of row 3 share: a card departs as one piece,
 * and the hole closes with it.
 *
 * The bar's third row ([B02] row 3). A body card standing above a neighbour
 * in a slot is closed through File › Close Card — the real menu item,
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
 * One launch per piece, a test to a file so each fits its own budget:
 * `row-03-departure-session` for the Session card, `row-03-departure-kinds`
 * for every other kind.
 */

import { expect } from "bun:test";

import { note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { classifyFrame, describeFrames, FLOOR_BY_CLASS, settleFor, readPalette, showsBareHole, type FloorMeasure } from "./_frames";
import { closePopoverUp, pressCloseOfPopover } from "./_bodies";

export const TEST_NAME = "body-grounding-row-03-departure";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 150_000;

export const BODY_CARD = "row03-body";
export const NEIGHBOUR = "row03-neighbour";
export const BODY_READY_MS = 30_000;
export const PLACED_MS = 3_000;
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
/** How far a card's view reaches past its pane (`CARD_APRON_PX`). */
const APRON_PX = 10;

/** The body card above an unbound neighbour, one flow column. */
export const column = {
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

export const promptPhase = `(function () {
  var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
  return entry === null ? null : entry.getAttribute("data-phase");
})()`;

export async function bodyOf(app: App, card: string): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === card) ?? null;
}

/**
 * The close and its reading, for `card` standing as a body, focused: File ›
 * Close Card performed, and every frame of its rect read from then on.
 */
export async function departLeg(app: App, card: string, measure: FloorMeasure = FLOOR_BY_CLASS): Promise<void> {
  const body = app.body(card);
  const frame = (await bodyOf(app, card))!.frame;
  // The card's own rect: a card that draws its chrome is a view outset from
  // its pane by the apron (`CARD_APRON_PX`), which shows what is beneath it
  // by design, so the crop stands inside it.
  const crop = {
    x: Math.ceil(frame.x) + APRON_PX + 2,
    y: Math.ceil(frame.y) + APRON_PX + 2,
    width: Math.floor(frame.width) - 2 * APRON_PX - 4,
    height: Math.floor(frame.height) - 2 * APRON_PX - 4,
  };
  const probe = (await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop })) as { armed: true };
  expect(probe.armed).toBe(true);
  const probeReading = await settleFor(
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
  // A card that asks before it closes asks in the confirm over its chrome, in
  // the page that draws it — the card's own, for a kind that carries its
  // chrome — and the close is that confirm's Close. A Session card with no
  // turn running waives it; the Overview never does.
  const asked = await settleFor(() => closePopoverUp(app, card), (up) => up, 600);
  if (asked) {
    note("the card asked before closing; answering Close");
    expect(await pressCloseOfPopover(app, card), "the confirm's Close is pressed").toBe(true);
  }
  const gone = await settleFor(() => bodyOf(app, card), (b) => b === null, BODY_READY_MS);
  if (gone !== null) {
    note(`after the close the deck holds ${JSON.stringify(await app.evalJS<string[]>(`Array.from(document.querySelectorAll(".tug-pane [data-card-id]")).map(function (el) { return el.getAttribute("data-card-id"); })`))}; it still names ${card}: ${await app.evalJS<boolean>(`document.querySelector('.tug-pane [data-card-id="${card}"]') !== null`)}; its body ${JSON.stringify({ state: gone.state, visible: gone.visible, frame: gone.frame })}; the sidebars ${JSON.stringify(await app.evalJS<unknown>("window.tugdeck.diag.getDeckState().imposition.sidebars"))}`);
  }
  expect(gone, "the host holds no body for the closed card once it has departed").toBeNull();
  const reading = await settleFor(
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
