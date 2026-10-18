/**
 * floor-host.test.ts — the host's floor is the page's canvas, pixel for pixel.
 *
 * The canvas colour and the grid beneath the deck are drawn by
 * the host (`DeckFloorView`, from the shell's `floorGrid`), and the page's own
 * canvas stands down once the host answers `floorShown`. The page's paint is
 * still there, from the same tokens: it stands down only under
 * `html[data-body-host]` (`globals.css`). So at each of View › Zoom 0.8, 1.0
 * and 1.25 the same crop of bare canvas is read twice from the composite —
 * the host's floor, then the page's own with that attribute lifted, painted
 * over it — and the two must agree: the canvas colour within the composite
 * tolerance the other rows use, and every grid line of the page's within one
 * device pixel of a line of the host's, none missing and none extra.
 *
 * The floor never stands over the splash: the host shows it only once the
 * window has begun revealing the shell, fading it in with the shell's own
 * fade, and says how long after the reveal it showed. The harness's
 * handshake does not reliably precede the reveal, so a burst armed after it
 * cannot see the launch; the host's own report is the reading.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { pollFor } from "./_bodies";
import { fillOf, near, type Rgb } from "./_frames";

const TEST_NAME = "body-grounding-floor-host";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const ZOOMS = [0.8, 1.0, 1.25] as const;
/** The composite tolerance the other rows class colours with. */
const TOLERANCE = 8;
/** How far from the canvas colour a pixel may lie and still be a grid line (`_frames.ts`). */
const GRID_REACH = 44;

/** What one launch read at one zoom: the canvas colour and the lines' centres, in device px of the crop. */
interface FloorReading {
  canvas: Rgb;
  columns: number[];
  rows: number[];
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
async function readFloor(app: App, crop: { x: number; y: number; width: number; height: number }): Promise<FloorReading> {
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
  };
}

/** A crop of the window's lower right, where an empty deck draws nothing but the canvas. */
async function bareCrop(app: App): Promise<{ x: number; y: number; width: number; height: number }> {
  const size = await app.evalJS<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
  return { x: Math.floor(size.w * 0.55), y: Math.floor(size.h * 0.55), width: 240, height: 160 };
}

/** The page's own canvas paint, lifted or put back by the attribute it stands down under. */
async function pagePaints(app: App, paints: boolean): Promise<void> {
  await app.evalJS<null>(
    paints
      ? `(document.documentElement.removeAttribute("data-body-host"), null)`
      : `(document.documentElement.setAttribute("data-body-host", ""), null)`,
  );
  await Bun.sleep(400);
  // Lifted, the page paints an opaque canvas over the host's floor — or the
  // page reading is the host's floor read twice.
  const background = await app.evalJS<string>(`getComputedStyle(document.body).backgroundColor`);
  expect(background === "rgba(0, 0, 0, 0)" || background === "transparent", `the page's canvas ${paints ? "paints" : "stands down"} (${background})`).toBe(!paints);
}

/** The host's floor and the page's own canvas, read over the same crop at each zoom. */
async function readAtZooms(): Promise<{ host: Map<number, FloorReading>; page: Map<number, FloorReading> }> {
  const app = await launchTugApp({ testName: TEST_NAME, foreground: true });
  const host = new Map<number, FloorReading>();
  const page = new Map<number, FloorReading>();
  try {
    await app.seedDeckState({ state: emptyDeck() });
    {
      const hosted = await pollFor(
        () => app.evalJS<boolean>(`document.documentElement.hasAttribute("data-body-host")`),
        (v) => v,
        10_000,
      );
      const diag = await app.evalJS<{ floorShown: { sinceRevealMs: number | null } | null; floorGrid: unknown } | null>(
        "window.tugdeck.diag.getBodyPlacement()",
      );
      note(`floorShown ${JSON.stringify(diag?.floorShown)}; floorGrid ${JSON.stringify(diag?.floorGrid)}`);
      expect(hosted, "the host answered floorShown and the page's canvas stood down").toBe(true);
      expect(await app.evalJS<number>(`document.querySelectorAll("[data-deck-canvas-floor]").length`), "the shell stands no floor of its own").toBe(0);
      const since = diag?.floorShown?.sinceRevealMs ?? null;
      expect(since === null || since >= 0, "the host's floor showed no earlier than the window's reveal: never over the splash").toBe(true);
    }
    const crop = await bareCrop(app);
    for (const zoom of ZOOMS) {
      const took = await app.setPageZoom(zoom);
      expect(took, `View › Zoom took ${zoom}`).toBeCloseTo(zoom, 3);
      await pollFor(
        () => app.evalJS<number | null>("window.tugdeck.diag.getBodyPlacement()?.floorGrid?.zoom ?? null"),
        (z) => z !== null && Math.abs(z - zoom) < 1e-6,
        5_000,
      );
      await Bun.sleep(400);
      for (const [label, readings] of [["host", host], ["page", page]] as const) {
        if (label === "page") await pagePaints(app, true);
        const reading = await readFloor(app, crop);
        if (label === "page") await pagePaints(app, false);
        note(`${label} @ ${zoom}: canvas ${JSON.stringify(reading.canvas)}; ${reading.columns.length} columns ${JSON.stringify(reading.columns.slice(0, 6))}…; ${reading.rows.length} rows ${JSON.stringify(reading.rows.slice(0, 6))}…`);
        readings.set(zoom, reading);
      }
    }
  } finally {
    await app.close();
  }
  return { host, page };
}

/** Every line of `want` has a line of `got` within one device pixel, and the counts agree. */
function linesMatch(want: number[], got: number[]): { ok: boolean; worst: number } {
  let worst = 0;
  for (const w of want) {
    const d = Math.min(...got.map((g) => Math.abs(g - w)));
    worst = Math.max(worst, d);
  }
  return { ok: want.length === got.length && worst <= 1, worst };
}

describe.skipIf(!SHOULD_RUN)("body-grounding: the host's floor is the page's canvas", () => {
  test(
    "at zoom 0.8, 1.0 and 1.25 the host's canvas colour and grid match the page's to the device pixel",
    async () => {
      const { host, page } = await readAtZooms();
      for (const zoom of ZOOMS) {
        const p = page.get(zoom)!;
        const h = host.get(zoom)!;
        const cols = linesMatch(p.columns, h.columns);
        const rows = linesMatch(p.rows, h.rows);
        note(`@ ${zoom}: canvas page ${JSON.stringify(p.canvas)} host ${JSON.stringify(h.canvas)}; columns ${p.columns.length}/${h.columns.length} worst ${cols.worst}; rows ${p.rows.length}/${h.rows.length} worst ${rows.worst}`);
        expect(p.columns.length, `@ ${zoom}: the page's grid shows in the crop`).toBeGreaterThan(2);
        expect(near(p.canvas, h.canvas, TOLERANCE), `@ ${zoom}: the host's canvas is the page's colour`).toBe(true);
        expect(cols.ok, `@ ${zoom}: every vertical line within one device pixel, none missing or extra`).toBe(true);
        expect(rows.ok, `@ ${zoom}: every horizontal line within one device pixel, none missing or extra`).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
