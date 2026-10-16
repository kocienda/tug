/**
 * _row-21.ts — what the pieces of row 21 share: a body card's side edges are
 * the pane's border and nothing else.
 *
 * A body's view is posted at a whole number of points, its page lays out in
 * whole points, and the web view draws no backing of its own: the container
 * behind it wears the page's surface. So no column of the view lies outside
 * the page, and none can read as a bright line. The reading that found the
 * strip: at zoom 0.9 a body posted `605.7 pt` wide got a `605 px` layout
 * viewport, and the last device column was the web view's white backing,
 * one pure-white column inside the pane's border.
 *
 * Read on a body card and an in-document Text card side by side, on one
 * device-pixel row through their content, at zoom 0.8, 0.9 and 1.0, with each
 * card key in turn. Each edge is read from the pane's outer edge inward. Its
 * profile is the border's light above the card's own interior. The brightest
 * column is the border. The light's spread, the summed excess over the
 * interior in units of that column's excess, is at most two columns for a
 * single anti-aliased border of no more than two device columns, whatever
 * its phase. A sliver of backing beside the border adds a column of its own
 * and breaks it. The Text card's edges are the reference: the same bound
 * holds on both, and the body's border column reads the Text card's.
 *
 * Every other kind that is a body is read the same way beside the Text
 * card. A pinned rail's one border is its inner edge, drawn in the rail
 * treatment's own stronger rule, and its outer edge meets the window: the
 * spread bound holds on both of its edges, and its border column is the
 * rail's rather than the Text card's.
 *
 * One launch per piece: `row-21-edges-session` for the Session card,
 * `row-21-edges-kinds` for every other kind.
 */

import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, SETTLE_MS, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { kindPane, kindSidebars, type CardKind } from "./_kinds";

const TEST_NAME = "body-grounding-row-21-edges";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/**
 * How a piece launches, stated in the piece itself: every row-21 launch
 * takes the screen, and `@foreground` is read off the file that says so.
 */
export interface Launch {
  foreground: boolean;
}

const A = "r21-a";
const T = "r21-t";
const ZOOMS = [0.8, 0.9, 1.0];
/** The most a single anti-aliased border no wider than two device columns spreads, plus noise. */
const SPREAD_BOUND = 2.2;
/** How far the body's border column may read from the Text card's, per channel. */
const BORDER_TOLERANCE = 20;
/** How far in from the pane's outer edge the border's light is read, and the interior past it (points). */
const BORDER_SPAN_PT = 4;
const INTERIOR_SPAN_PT = 8;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface EdgeProfile {
  /** The columns from the pane's outer edge inward. */
  columns: Rgb[];
  /** The interior's commonest colour past the border span. */
  interior: Rgb;
  /** The brightest column of the border span, against the interior. */
  peak: Rgb;
  /** The border's light, in units of the peak column's. */
  spread: number;
}

const frameOf = (cardId: string): string => `.tug-pane:has([data-card-id="${cardId}"])`;

const rectOf = (app: App, selector: string): Promise<Rect | null> =>
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );

const lum = (c: Rgb): number => (c.r + c.g + c.b) / 3;
const hex = (c: Rgb): string => `${c.r},${c.g},${c.b}`;

function commonest(colours: readonly Rgb[]): Rgb {
  const counts = new Map<string, { c: Rgb; n: number }>();
  for (const c of colours) {
    const k = hex(c);
    const e = counts.get(k);
    if (e) e.n += 1;
    else counts.set(k, { c, n: 1 });
  }
  let best = { c: colours[0], n: 0 };
  for (const e of counts.values()) if (e.n > best.n) best = e;
  return best.c;
}

/**
 * One edge's profile from a captured row. `outer` is the device column the
 * pane's outer edge falls in and `inward` the direction of the card's
 * interior (+1 for a left edge, -1 for a right one).
 */
function profileOf(row: readonly Rgb[], outer: number, inward: 1 | -1, scale: number): EdgeProfile {
  const span = Math.round(BORDER_SPAN_PT * scale);
  const reach = Math.round(INTERIOR_SPAN_PT * scale);
  const columns: Rgb[] = [];
  for (let i = 0; i < span; i++) columns.push(row[outer + inward * i]);
  const inner: Rgb[] = [];
  for (let i = span; i < reach; i++) inner.push(row[outer + inward * i]);
  const interior = commonest(inner);
  const base = lum(interior);
  let peak = columns[0];
  for (const c of columns) if (lum(c) > lum(peak)) peak = c;
  const height = Math.max(1, lum(peak) - base);
  const spread = columns.reduce((sum, c) => sum + Math.max(0, lum(c) - base), 0) / height;
  return { columns, interior, peak, spread };
}

/** Read the left and right edge profiles of both cards off one composite of `crop`. */
async function readEdges(app: App, crop: Rect, frames: Record<string, Rect>): Promise<Record<string, EdgeProfile>> {
  await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop });
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
  const png = decodePngFile(reading.frames[reading.frames.length - 1].path);
  const scale = reading.scale;
  const y = Math.floor(png.height / 2);
  const row: Rgb[] = [];
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    row.push({ r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] });
  }
  const out: Record<string, EdgeProfile> = {};
  for (const [card, f] of Object.entries(frames)) {
    const left = Math.floor((f.x - crop.x) * scale);
    const right = Math.ceil((f.x + f.width - crop.x) * scale) - 1;
    out[`${card} left`] = profileOf(row, left, 1, scale);
    out[`${card} right`] = profileOf(row, right, -1, scale);
  }
  return out;
}

/** A blank text file the Text card shows, so its interior is its own surface. */
function blankFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tug-r21-text-"));
  const file = join(dir, "blank.txt");
  writeFileSync(file, "\n".repeat(120));
  return file;
}

/** A card of `kind` beside the Text card: its side edges are one border, no sliver beside it, at three zooms, key and not key. */
export async function edgesOfKind(launch: Launch, kind: CardKind): Promise<void> {
  const card = `r21-${kind.componentId}`;
  const file = blankFile();
  const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}`, foreground: launch.foreground, bodies: true });
  try {
    await app.seedDeckState({
      state: {
        cards: [
          { id: card, componentId: kind.componentId, title: kind.componentId, closable: true },
          { id: T, componentId: "text", title: "T", closable: true },
        ],
        panes: [
          kindPane(kind.componentId, card, 0),
          { id: `${T}-pane`, position: { x: 40, y: 40 }, size: { width: 640, height: 480 }, cardIds: [T], activeCardId: T, title: "", acceptsFamilies: ["standard"], slot: kind.rail ? 0 : 1 },
        ],
        activePaneId: `${card}-pane`,
        imposition: { kind: "four-up", layout: "flow", contentWidth: "slim", sidebars: kindSidebars([kind.componentId]) },
        hasFocus: true,
      },
      cardStates: { [T]: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
      focusCardId: card,
    });
    await standUpKind(app, kind, card);
    const fractional: string[] = [];
    const spreads: string[] = [];
    for (const zoom of ZOOMS) {
      const took = await app.setPageZoom(zoom);
      expect(took, `View › Zoom took ${zoom}`).toBeCloseTo(zoom, 3);
      for (const key of [card, T]) {
        if (key === card) await focusBody(app, card, { composer: false });
        else {
          await app.evalJS<null>(`(window.__tug.dispatchControlAction("focus-pane", { paneId: ${JSON.stringify(`${T}-pane`)} }), null)`);
          expect(await pollFor(() => app.getFocusedCardId(), (id) => id === T, SETTLE_MS), "the Text card is key").toBe(T);
        }
        await pollFor(() => app.evalJS<boolean>(`document.querySelector(".tug-pane-flash") === null`), (gone) => gone, 5_000);
        await Bun.sleep(300);
        const state = `zoom ${zoom}, ${key === card ? "body key" : "Text key"}`;
        const posted = await app.evalJS<Rect[]>(
          `(window.tugdeck.diag.getBodyPlacement().lastPosted || { bodies: [] }).bodies.map(function (b) { return { x: b.x, y: b.y, width: b.width, height: b.height }; })`,
        );
        for (const b of posted) if (![b.x, b.y, b.width, b.height].every(Number.isInteger)) fractional.push(`${state}: ${JSON.stringify(b)}`);
        const kFrame = (await rectOf(app, frameOf(card)))!;
        const tFrame = (await rectOf(app, frameOf(T)))!;
        const inner = await app.evalJS<{ w: number }>(`({ w: window.innerWidth })`);
        const midY = Math.round(kFrame.y + kFrame.height * 0.6);
        const left = Math.max(0, Math.floor(Math.min(kFrame.x, tFrame.x)) - 2);
        const right = Math.min(Math.floor(inner.w), Math.ceil(Math.max(kFrame.x + kFrame.width, tFrame.x + tFrame.width)) + 2);
        const edges = await readEdges(app, { x: left, y: midY, width: right - left, height: 2 }, { body: kFrame, text: tFrame });
        for (const [edge, p] of Object.entries(edges)) {
          note(`${state}, ${edge}: spread ${p.spread.toFixed(2)}, peak ${hex(p.peak)}, interior ${hex(p.interior)}`);
          if (p.spread > SPREAD_BOUND) spreads.push(`${state}, ${edge}: ${p.spread.toFixed(2)}`);
        }
      }
    }
    expect(fractional, "every body is posted at whole points").toEqual([]);
    expect(spreads, "every edge, the body's and the Text card's, is one border with no sliver beside it").toEqual([]);
  } finally {
    await app.close();
  }
}

/** The Session card beside the Text card: its side edges read as the Text card's at three zooms, key and not key. */
export async function edgesOfSession(launch: Launch): Promise<void> {
  const stubDir = stubDirectory();
  const file = blankFile();
  const app = await launchTugApp({
    testName: `${TEST_NAME}-session`,
    foreground: launch.foreground,
    bodies: true,
    env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
  });
  try {
    await app.seedDeckState({
      state: {
        cards: [
          { id: A, componentId: "session", title: "A", closable: true },
          { id: T, componentId: "text", title: "T", closable: true },
        ],
        panes: [
          sessionPane(A, 0),
          {
            id: `${T}-pane`,
            position: { x: 40, y: 40 },
            size: { width: 640, height: 480 },
            cardIds: [T],
            activeCardId: T,
            title: "",
            acceptsFamilies: ["standard"],
            slot: 1,
          },
        ],
        activePaneId: `${A}-pane`,
        imposition: { kind: "four-up", layout: "flow", contentWidth: "slim", sidebars: {} },
        hasFocus: true,
      },
      cardStates: { [T]: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
      focusCardId: A,
    });
    await spawnStub(app, A, stubDir, 2);
    await waitForBody(app, A);

    // Every edge at every zoom and focus, keyed `zoom|card|key|side`, read
    // before anything is asserted so one run carries every reading.
    const read = new Map<string, EdgeProfile>();
    const fractional: string[] = [];
    for (const zoom of ZOOMS) {
      const took = await app.setPageZoom(zoom);
      expect(took, `View › Zoom took ${zoom}`).toBeCloseTo(zoom, 3);
      for (const key of [A, T]) {
        if (key === A) {
          await focusBody(app, A, { composer: false });
        } else {
          await app.evalJS<null>(`(window.__tug.dispatchControlAction("focus-pane", { paneId: ${JSON.stringify(`${T}-pane`)} }), null)`);
          const focused = await pollFor(() => app.getFocusedCardId(), (id) => id === T, SETTLE_MS);
          expect(focused, "the Text card is key").toBe(T);
        }
        // Focusing a card runs the pane's activation flash, an inset accent
        // ring over its border for 1750 ms: read the edges once it is off.
        const flashed = await pollFor(
          () => app.evalJS<boolean>(`document.querySelector(".tug-pane-flash") === null`),
          (gone) => gone,
          5_000,
        );
        expect(flashed, "the activation flash has run out").toBe(true);
        await Bun.sleep(300);
        const state = `zoom ${zoom}, ${key === A ? "body key" : "Text key"}`;

        const posted = await app.evalJS<Rect[]>(
          `(window.tugdeck.diag.getBodyPlacement().lastPosted || { bodies: [] }).bodies.map(function (b) { return { x: b.x, y: b.y, width: b.width, height: b.height }; })`,
        );
        for (const b of posted) if (![b.x, b.y, b.width, b.height].every(Number.isInteger)) fractional.push(`${state}: ${JSON.stringify(b)}`);

        const aFrame = (await rectOf(app, frameOf(A)))!;
        const tFrame = (await rectOf(app, frameOf(T)))!;
        const midY = Math.round(aFrame.y + aFrame.height * 0.6);
        const crop = {
          x: Math.floor(aFrame.x) - 2,
          y: midY,
          width: Math.ceil(tFrame.x + tFrame.width) + 2 - (Math.floor(aFrame.x) - 2),
          height: 2,
        };
        const edges = await readEdges(app, crop, { body: aFrame, text: tFrame });
        for (const [edge, p] of Object.entries(edges)) {
          const [card, side] = edge.split(" ");
          const isKey = (card === "body") === (key === A);
          read.set(`${zoom}|${card}|${isKey ? "key" : "not key"}|${side}`, p);
          note(
            `${state}, ${edge}: spread ${p.spread.toFixed(2)}, peak ${hex(p.peak)}, interior ${hex(p.interior)}, columns ${p.columns
              .slice(0, 6)
              .map(hex)
              .join(" | ")}`,
          );
        }
      }
    }
    expect(fractional, "every body is posted at whole points").toEqual([]);
    // Like against like: the key card wears the active border, so the
    // body key is read against the Text card key, and not key against
    // not key.
    for (const zoom of ZOOMS) {
      for (const focus of ["key", "not key"]) {
        for (const side of ["left", "right"]) {
          const state = `zoom ${zoom}, ${focus}, ${side} edge`;
          const body = read.get(`${zoom}|body|${focus}|${side}`)!;
          const text = read.get(`${zoom}|text|${focus}|${side}`)!;
          expect(text.spread, `${state}: the Text card's edge reads as one border`).toBeLessThanOrEqual(SPREAD_BOUND);
          expect(body.spread, `${state}: the body card's edge is one border, no sliver beside it`).toBeLessThanOrEqual(SPREAD_BOUND);
          for (const ch of ["r", "g", "b"] as const) {
            expect(
              Math.abs(body.peak[ch] - text.peak[ch]),
              `${state}: the body card's border column ${hex(body.peak)} reads the Text card's ${hex(text.peak)}`,
            ).toBeLessThanOrEqual(BORDER_TOLERANCE);
          }
        }
      }
    }
  } finally {
    await app.close();
  }
}
