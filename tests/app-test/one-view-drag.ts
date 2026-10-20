/**
 * one-view-drag.ts — a card that draws its own chrome drags as one view.
 *
 * The reading `at0744` states and `row-02-drag-kinds` reuses for every kind
 * that carries its chrome: the card is pressed in its own page, carried by
 * the host across the window under a capture burst, and released. On every
 * composited frame, the title bar's top (found by the chrome's colour) and
 * the content's top (found by the content surface's) stand the chrome's
 * height apart, to a device pixel, and once dropped the card's view rests on
 * its stand-in, outset by the apron. A chrome and a content that could part
 * would read as a different separation on some frame of the travel.
 */

import { expect } from "bun:test";

import { note, type App, type BodyApp } from "./_harness";
import type { CaptureBurstFrame } from "./_harness/client";
import { bandStartOnColumn, fillOnRow, leadingEdgeOnRow, near, pollFor, type Rgb } from "./body-grounding/_frames";
import { COLOUR_TOLERANCE, armBurst, readBurst, rectIn, still, viewOf } from "./one-view-fixture";

const TRAVEL_X = 400;
const TRAIL_STEPS = 20;
const TRAIL_STEP_MS = 30;
/** How far a card's view reaches past its pane on every side, points. */
const APRON = 6;

/** The title bar's top to the content's top on column `x`, device px, by their colours. */
function separationOn(frame: CaptureBurstFrame, x: number, chrome: Rgb, surface: Rgb, minChromePx: number): number | null {
  const top = bandStartOnColumn(frame, x, chrome, COLOUR_TOLERANCE, 0, 3);
  if (top === null) return null;
  const content = bandStartOnColumn(frame, x, surface, COLOUR_TOLERANCE, top + minChromePx, 12);
  return content === null ? null : content - top;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export interface OneViewDrag {
  /** The card dragged, standing at rest with its content painted. */
  card: string;
  /** The element in the card's page the hand presses: a content card's grab handle, a rail's bar. */
  press: string;
  /** How far below the title bar's top its colour is read: clear of the top corners and of a rail's stripe. */
  chromeRowPx: number;
  /**
   * How the one piece is read. `bands`: the title bar's top and the content's
   * top stand the chrome's height apart on every column, told apart by
   * colour. `edges`, for a card whose bar and content paint one surface (a
   * rail): the card's leading edge against the ground it travels over stands
   * in one column on a row through the bar and a row through the content.
   */
  reading: "bands" | "edges";
  /** The card's stand-in in the shell, which the dropped view comes to rest on. */
  standIn: string;
}

/** Drag `d.card` by its chrome under a burst, and hold it to one view on every frame and at the landing. */
export async function expectDragsAsOneView(app: App, body: BodyApp, d: OneViewDrag): Promise<void> {
  // The chrome is in the card's page, and the shell's pane is a stand-in.
  const bar = await rectIn(body, ".tug-pane-title-bar");
  expect(bar, "the card's page draws its title bar").not.toBeNull();
  // card-dom: shell
  const shellBars = await app.evalJS<number>(`document.querySelectorAll('.tug-pane[data-chrome-in-body] .tug-pane-title-bar').length`);
  expect(shellBars, "the shell's stand-in draws no title bar").toBe(0);
  const content = (await rectIn(body, ".tug-pane-content"))!;
  const chromeHeight = content.y - bar!.y;
  await Bun.sleep(200);
  const v = (await viewOf(app, d.card))!;
  note(`view ${JSON.stringify(v)}; title bar ${JSON.stringify(bar)}; content top ${content.y}; chrome height ${chromeHeight}`);

  // ---- The colours, off the standing card ----
  // card-dom: shell
  const inner = await app.evalJS<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
  // Toward whichever side of the window has room: a right rail travels left.
  const roomRight = Math.floor(inner.w - (v.x + v.width) - 20);
  const roomLeft = Math.floor(v.x - 20);
  const reach = Math.min(TRAVEL_X, Math.max(roomRight, roomLeft), Math.floor(v.width * 0.6));
  expect(reach, "the window leaves room to drag the card").toBeGreaterThanOrEqual(120);
  const dx = roomRight >= roomLeft ? reach : -reach;
  const left = Math.max(0, Math.floor(Math.min(v.x, v.x + dx)) - 4);
  const top = Math.max(0, Math.floor(v.y) - 4);
  const crop = {
    x: left,
    y: top,
    width: Math.min(Math.ceil(v.width + reach) + 8, Math.floor(inner.w) - left),
    height: Math.min(Math.ceil(v.height) + 8, Math.floor(inner.h) - top),
  };
  const standing = await still(app, crop);
  const scale = standing.scale;
  const across = (x0: number, x1: number): [number, number] => [(x0 - crop.x) * scale, (x1 - crop.x) * scale];
  const contentRow = (v.y + content.y + 20 - crop.y) * scale;
  const surface = fillOnRow(standing.frame, contentRow, ...across(v.x + 40, v.x + v.width - 40));

  /** One frame's reading: the bands' separation, or the two rows' edges' disagreement; null when it cannot be read. */
  let judge: (f: CaptureBurstFrame) => number | null;
  if (d.reading === "bands") {
    const chrome = fillOnRow(standing.frame, (v.y + bar!.y + d.chromeRowPx - crop.y) * scale, ...across(v.x + 40, v.x + v.width - 40));
    note(`chrome ${JSON.stringify(chrome)}; content surface ${JSON.stringify(surface)}`);
    expect(near(chrome, surface, COLOUR_TOLERANCE), "the chrome and the content surface are told apart by colour").toBe(false);
    // The columns: where the card stands at both ends of the travel.
    const overlap = v.x + Math.max(0, dx);
    const columns = [0.2, 0.35, 0.5, 0.65, 0.8].map((f) => (overlap + (v.width - reach) * f - crop.x) * scale);
    const minChromePx = Math.floor(chromeHeight * 0.5 * scale);
    judge = (f) => {
      const seps = columns.map((c) => separationOn(f, c, chrome, surface, minChromePx)).filter((s): s is number => s !== null);
      return seps.length === 0 ? null : median(seps);
    };
  } else {
    // The ground the card travels over, read at rest where it is going.
    const groundAt = dx > 0 ? across(v.x + v.width + 20, v.x + v.width + reach - 20) : across(v.x - reach + 20, v.x - 20);
    const ground = fillOnRow(standing.frame, contentRow, ...groundAt);
    note(`ground ${JSON.stringify(ground)}; content surface ${JSON.stringify(surface)}`);
    expect(near(ground, surface, COLOUR_TOLERANCE), "the card is told apart from the ground it travels over").toBe(false);
    const barRow = (v.y + bar!.y + d.chromeRowPx - crop.y) * scale;
    const from = dx > 0 ? "right" : "left";
    judge = (f) => {
      const atBar = leadingEdgeOnRow(f, barRow, ground, COLOUR_TOLERANCE, from, 0, crop.width * scale);
      const atContent = leadingEdgeOnRow(f, contentRow, ground, COLOUR_TOLERANCE, from, 0, crop.width * scale);
      return atBar === null || atContent === null ? null : atBar - atContent;
    };
  }
  const rest = judge(standing.frame);
  expect(rest, "the standing card is read by colour").not.toBeNull();
  note(`standing reading ${rest} device px against a chrome height of ${chromeHeight} pt`);
  if (d.reading === "bands") {
    expect(Math.abs(rest! / scale - chromeHeight), "at rest the bands stand the chrome's height apart").toBeLessThanOrEqual(2);
  } else {
    expect(Math.abs(rest!), "at rest the bar and the content end at one edge").toBeLessThanOrEqual(1);
  }

  // ---- The drag, under a burst ----
  const handle = await rectIn(body, d.press);
  expect(handle, `the title bar offers ${d.press} to the hand`).not.toBeNull();
  // In window points: the hand travels past the card's own view, so the
  // gesture is sent to the window, where the card's view takes the press as
  // any view under the pointer does.
  const from = { x: v.x + handle!.x + Math.min(40, handle!.width / 2), y: v.y + handle!.y + handle!.height / 2 };
  const to = { x: from.x + dx, y: from.y };
  await armBurst(app, crop);
  const gestureWall = Date.now();
  // What the page asks the host, and what the host tells the shell: a red at
  // the hold says which leg of the gesture went missing.
  await body.evalJS<null>(`(function () {
    var rec = (window.__oneView = []);
    var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cardGesture;
    if (h) { var post = h.postMessage.bind(h); h.postMessage = function (v) { rec.push(v); post(v); }; }
    return null;
  })()`);
  // card-dom: shell
  await app.evalJS<null>(`(function () {
    var rec = (window.__oneView = []);
    var b = window.__tugBridge; var take = b.onCardGesture;
    b.onCardGesture = function (r) { rec.push({ phase: r.phase, moved: r.moved, rect: r.rect }); return take(r); };
    return null;
  })()`);
  await app.nativeDragWithoutRelease(from, to, {
    interpolationSteps: TRAIL_STEPS,
    interpolationDelayMs: TRAIL_STEP_MS,
    mouseDownDelayMs: 80,
  });
  // Where the host has the container now: its presented frame, which a
  // gesture moves before any placement names it.
  const held = (await app.bodies()).find((s) => s.cardId === d.card)!.presentedFrame;
  note(`at the hold the view stands at ${JSON.stringify(held)}`);
  if ((held.x - v.x) * Math.sign(dx) <= reach * 0.7) {
    const asked = await body.evalJS<unknown>(`window.__oneView`);
    // card-dom: shell
    const told = await app.evalJS<unknown>(`window.__oneView`);
    note(`the page asked ${JSON.stringify(asked)}; the shell heard ${JSON.stringify(told)}`);
  }
  expect((held.x - v.x) * Math.sign(dx), "the host carried the card with the hand").toBeGreaterThan(reach * 0.7);
  await app.nativeMouseUp(to);
  const reading = await readBurst(app);
  expect(reading.done, "the burst finished").toBe(true);

  // The drop lands as one: the host's view comes to rest on the shell's
  // stand-in, outset by the apron.
  const landedOn = async (): Promise<number> => {
    // card-dom: shell
    const standIn = await app.evalJS<{ x: number; y: number; width: number; height: number } | null>(
      `(function () { var f = document.querySelector(${JSON.stringify(d.standIn)}); if (!f || document.querySelector('[data-imposer-settling]')) return null; var r = f.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    const now = (await app.bodies()).find((s) => s.cardId === d.card)?.presentedFrame;
    if (standIn === null || now === undefined) return Infinity;
    return Math.max(
      Math.abs(now.x - (standIn.x - APRON)),
      Math.abs(now.y - (standIn.y - APRON)),
      Math.abs(now.width - (standIn.width + 2 * APRON)),
      Math.abs(now.height - (standIn.height + 2 * APRON)),
    );
  };
  const gap = await pollFor(landedOn, (g) => g <= 1, 3_000);
  note(`after the drop the view stands ${gap} pt from the stand-in outset by the apron`);
  expect(gap, "the dropped card's view rests on its stand-in, outset by the apron").toBeLessThanOrEqual(1);

  const judged: Array<{ t: number; sep: number }> = [];
  for (const f of reading.frames) {
    if (f.wall < gestureWall) continue;
    const sep = judge(f);
    if (sep !== null) judged.push({ t: f.t, sep });
  }
  expect(judged.length, "frames were read across the drag").toBeGreaterThan(10);
  const worst = judged.reduce((a, b) => (Math.abs(b.sep - rest!) > Math.abs(a.sep - rest!) ? b : a));
  note(`${judged.length} frames judged; worst separation ${worst.sep} device px at ${Math.round(worst.t)} ms against ${rest}`);
  const off = judged.filter((j) => Math.abs(j.sep - rest!) > 1);
  if (off.length > 0) note(`frames where chrome and content parted\n${off.map((j) => `${Math.round(j.t)}ms ${j.sep}`).join("\n")}`);
  expect(off.length, "on every frame the chrome and the content stand as they stood at rest, to a device pixel").toBe(0);
}
