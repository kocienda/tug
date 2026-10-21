/**
 * floor-host.test.ts — the canvas beneath the cards is the shell's own, pixel for pixel.
 *
 * The shell's page lies beneath every card and paints the deck's canvas
 * itself: the canvas colour on `body` and the grid on the deck root, which
 * View › Zoom scales. Nothing the host draws stands between it and the
 * window. So at each of View › Zoom 0.8, 1.0 and 1.25 a crop of bare canvas
 * is read from the composite and held to what the page paints: the canvas
 * colour within the composite tolerance the other rows use, and every grid
 * line within one device pixel of a line on the page's own lattice — the
 * deck root's corner plus whole 24 px cells at the deck's zoom — none extra,
 * and none of the lattice's lines inside the crop missing.
 *
 * @foreground activation
 * @covers tugdeck/src/globals.css
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { pollFor } from "./_bodies";
import { asRgbJs, fillOf, near, type Rgb } from "./_frames";

const TEST_NAME = "body-grounding-floor-host";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const ZOOMS = [0.8, 1.0, 1.25] as const;
/** The composite tolerance the other rows class colours with. */
const TOLERANCE = 8;
/** How far from the canvas colour a pixel may lie and still be a grid line (`_frames.ts`). */
const GRID_REACH = 44;
/** The grid's cell, layout px (`globals.css`). */
const CELL_PX = 24;

/** A crop of bare canvas, in viewport points. */
interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What one zoom read: the canvas colour, the lines' centres in device px of the crop, and the crop's scale. */
interface CanvasReading {
  canvas: Rgb;
  columns: number[];
  rows: number[];
  scale: number;
}

function emptyDeck(): Record<string, unknown> {
  return { cards: [], panes: [], imposition: { sidebars: {} }, hasFocus: true };
}

/**
 * The centres of the runs of lines in `share` (one entry per column or row):
 * a column or row is a line when most of its pixels are grid paint.
 */
function lineCentres(share: number[]): number[] {
  const centres: number[] = [];
  let start = -1;
  for (let i = 0; i <= share.length; i++) {
    const on = i < share.length && share[i] > 0.5;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      centres.push((start + i - 1) / 2);
      start = -1;
    }
  }
  return centres;
}

/** Read a crop of bare canvas: its commonest colour and where its grid lines run. */
async function readCanvas(app: App, crop: Crop): Promise<CanvasReading> {
  await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop });
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
  expect(reading.done, "the burst finished").toBe(true);
  const frame = reading.frames[reading.frames.length - 1];
  const canvas = fillOf(frame);
  const png = decodePngFile(frame.path);
  const columnHits = new Array<number>(png.width).fill(0);
  const rowHits = new Array<number>(png.height).fill(0);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      if (near(p, canvas, TOLERANCE) || !near(p, canvas, GRID_REACH)) continue;
      columnHits[x] += 1;
      rowHits[y] += 1;
    }
  }
  return {
    canvas,
    columns: lineCentres(columnHits.map((n) => n / png.height)),
    rows: lineCentres(rowHits.map((n) => n / png.width)),
    scale: png.width / crop.width,
  };
}

/** A crop of the window's lower right, where an empty deck draws nothing but the canvas. */
async function bareCrop(app: App): Promise<Crop> {
  const size = await app.evalJS<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
  return { x: Math.floor(size.w * 0.55), y: Math.floor(size.h * 0.55), width: 240, height: 160 };
}

/**
 * The centres of the page's own grid lines inside a crop's span on one axis,
 * in device px of the crop: a line every cell at the deck's zoom from the
 * deck root's corner, each `zoom` layout px wide. Only lines whose whole run
 * lies inside the crop, so a line the crop's edge cuts is neither required
 * nor counted against.
 */
function latticeCentres(origin: number, start: number, extent: number, zoom: number, scale: number): number[] {
  const step = CELL_PX * zoom;
  const width = Math.max(1, zoom * scale);
  const centres: number[] = [];
  for (let k = Math.ceil((start - origin) / step); origin + k * step < start + extent; k++) {
    const runStart = (origin + k * step - start) * scale;
    if (runStart < 0 || runStart + width > extent * scale) continue;
    centres.push(runStart + (width - 1) / 2);
  }
  return centres;
}

/** Every line of `got` within one device pixel of a lattice line, and every lattice line found. */
function onLattice(want: number[], got: number[]): { ok: boolean; worst: number } {
  let worst = 0;
  for (const g of got) {
    const d = Math.min(...want.map((w) => Math.abs(g - w)));
    worst = Math.max(worst, d);
  }
  const found = want.every((w) => got.some((g) => Math.abs(g - w) <= 1));
  return { ok: found && worst <= 1, worst };
}

describe.skipIf(!SHOULD_RUN)("body-grounding: the canvas beneath the cards is the shell's own", () => {
  test(
    "at zoom 0.8, 1.0 and 1.25 the composite's canvas colour and grid are the page's to the device pixel",
    async () => {
      const app = await launchTugApp({ testName: TEST_NAME, foreground: true });
      try {
        await app.seedDeckState({ state: emptyDeck() });
        // card-dom: shell — the canvas and its grid are the shell page's paint.
        const token = await app.evalJS<string>(
          asRgbJs("getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')"),
        );
        const expected = (() => {
          const [r, g, b] = token.match(/\d+/g)!.map(Number);
          return { r, g, b };
        })();
        const crop = await bareCrop(app);
        for (const zoom of ZOOMS) {
          const took = await app.setPageZoom(zoom);
          expect(took, `View › Zoom took ${zoom}`).toBeCloseTo(zoom, 3);
          await Bun.sleep(400);
          const root = await app.evalJS<{ x: number; y: number }>(`(function () {
  var r = document.getElementById("deck-container").getBoundingClientRect();
  return { x: r.left, y: r.top };
})()`);
          const reading = await readCanvas(app, crop);
          const wantColumns = latticeCentres(root.x, crop.x, crop.width, zoom, reading.scale);
          const wantRows = latticeCentres(root.y, crop.y, crop.height, zoom, reading.scale);
          const cols = onLattice(wantColumns, reading.columns);
          const rows = onLattice(wantRows, reading.rows);
          note(
            `@ ${zoom}: canvas ${JSON.stringify(reading.canvas)} want ${token}; ` +
              `columns ${reading.columns.length} (lattice ${wantColumns.length}) worst ${cols.worst}; ` +
              `rows ${reading.rows.length} (lattice ${wantRows.length}) worst ${rows.worst}`,
          );
          expect(wantColumns.length, `@ ${zoom}: the page's lattice crosses the crop`).toBeGreaterThan(2);
          expect(near(reading.canvas, expected, TOLERANCE), `@ ${zoom}: the composite's canvas is the page's colour`).toBe(true);
          expect(cols.ok, `@ ${zoom}: every vertical line on the page's lattice within one device pixel, none missing or extra`).toBe(true);
          expect(rows.ok, `@ ${zoom}: every horizontal line on the page's lattice within one device pixel, none missing or extra`).toBe(true);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
