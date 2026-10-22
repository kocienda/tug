/**
 * _frames.ts — what a composited frame shows in a body's rect, by colour.
 *
 * The bar's arrival and departure rows read every frame of a capture burst
 * and ask whose paint fills the rect: the pane's own surface (the lid, or the
 * body on it), the shell's canvas floor (canvas colour with its grid lines),
 * the bare window background (an open hole with nothing beneath it), or
 * content ink. Each pixel is classed by the nearest palette colour within a
 * tolerance, and a frame is the share of each class. The grid tells the floor
 * from a bare hole when the window's background is the canvas colour: the
 * floor draws a 1 px line every 24 px in both directions, a hole draws none.
 *
 * Never an ink share alone, which the shell's grid satisfies through an empty
 * placeholder ([B05]). And never a CSS token taken for the pixel: the
 * composite renders every colour a few units off the token (colour
 * management between the page and the window server), so the surface is
 * calibrated from a composite of the body itself, the tolerance covers the
 * shift, and the grid is read as the dim lattice near the canvas colour.
 */

import type { App } from "../_harness";
import type { CaptureBurstFrame } from "../_harness/client";
import { decodePngFile, type DecodedPng } from "../_harness/png";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The last two frames decoded. A judge reads one frame several ways in a
 * row — the placeholder's rect, the whole crop, an edge on each of two rows
 * — and a full-window decode is ~36 ms, so each read decoding afresh was
 * most of a leg's cost. A frame's file never changes once captured. Least
 * recently used goes first, so a standing frame every frame is compared
 * against (`framesDiffer`) stays while the frames under judgement pass.
 */
const recent = new Map<string, DecodedPng>();

function decoded(path: string): DecodedPng {
  const hit = recent.get(path);
  if (hit !== undefined) {
    recent.delete(path);
    recent.set(path, hit);
    return hit;
  }
  const png = decodePngFile(path);
  recent.set(path, png);
  if (recent.size > 2) recent.delete(recent.keys().next().value!);
  return png;
}

/** `rgb(r, g, b)`, `rgba(r, g, b, a)` or `#rrggbb` → channels. */
export function parseRgb(text: string): Rgb {
  const hex = text.trim().match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16) };
  const m = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) throw new Error(`not a colour: ${JSON.stringify(text)}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

export function near(a: Rgb, b: Rgb, tolerance: number): boolean {
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance;
}

/** The colours a frame is read against. */
export interface Palette {
  /** The pane surface as the composite shows it: the lid, and the body's page. */
  surface: Rgb;
  /** The shell's canvas floor colour. */
  canvas: Rgb;
  /** The window's own background — what an open hole with nothing beneath shows. */
  bare: Rgb;
}

/** A frame's paint, as shares of its pixels (0..1). */
export interface FrameClasses {
  t: number;
  wall: number;
  surface: number;
  canvas: number;
  grid: number;
  /** Bare window background. Folded into `canvas` when the two colours coincide. */
  bare: number;
  /** Everything else: content ink, chrome, a neighbour's paint. */
  other: number;
  pixels: number;
  /** The frame's commonest colour, as `rgb(r, g, b)`: whose paint fills it. */
  fill: string;
}

/**
 * How a reading tells the floor showing through a card's rect from the card's
 * own paint.
 *
 * By class, the floor is its canvas, its grid and the bare window, and a
 * card's paint is its surface and its ink. That holds on a content card,
 * whose surface stands well clear of the canvas. A pinned rail paints the
 * sunken surface, which in the dark themes is a step of the very ramp the
 * canvas and its grid line are steps of, so a rail's own ink lies inside the
 * grid's reach and reads as grid. A floor is mostly canvas wherever it shows,
 * so on a rail it is read by its canvas and the bare window alone, and
 * whatever is neither is the rail's paint.
 */
export interface FloorMeasure {
  floor(f: FrameClasses): number;
  own(f: FrameClasses): number;
  /** The card's ink: its paint that is not its surface. */
  ink(f: FrameClasses): number;
}

export const FLOOR_BY_CLASS: FloorMeasure = {
  floor: (f) => f.canvas + f.grid + f.bare,
  own: (f) => f.surface + f.other,
  ink: (f) => f.other,
};

export const FLOOR_BY_CANVAS: FloorMeasure = {
  floor: (f) => f.canvas + f.bare,
  own: (f) => 1 - f.canvas - f.bare,
  ink: (f) => f.other + f.grid,
};

/** The measure for a card: by canvas on a pinned rail, by class everywhere else. */
export const floorMeasure = (rail: boolean): FloorMeasure => (rail ? FLOOR_BY_CANVAS : FLOOR_BY_CLASS);

/** The frame's commonest colour. */
export function fillOf(frame: CaptureBurstFrame): Rgb {
  const png = decoded(frame.path);
  const counts = new Map<number, number>();
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const i = (y * png.width + x) * 4;
      const key = (png.rgba[i] << 16) | (png.rgba[i + 1] << 8) | png.rgba[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let fillKey = 0;
  let most = -1;
  for (const [key, count] of counts) if (count > most) [fillKey, most] = [key, count];
  return { r: (fillKey >> 16) & 255, g: (fillKey >> 8) & 255, b: fillKey & 255 };
}

/** How far from the canvas colour a pixel may lie and still be the floor's grid line. */
const GRID_REACH = 44;

/** A region of a frame, in the frame's own device pixels (the crop's). */
export interface FrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Class every pixel (stride 2) of the frame's PNG — the burst's crop, so the
 * whole image is the rect. The surface is tried first; the grid is any
 * pixel that is neither surface nor canvas but lies within {@link GRID_REACH}
 * of the canvas — the floor's line is a lighter tint of it, and nothing else
 * on the deck sits that close. `bareIsCanvas` says the window background
 * cannot be told from the canvas by colour; then the grid share is what
 * tells a floor from an open hole.
 *
 * With a `region`, only the pixels inside it are classed — the body's rect
 * inside a burst cropped to the whole of a drag's travel — clamped to the
 * image; a region with no pixels in it answers all shares zero.
 */
export function classifyFrame(
  frame: CaptureBurstFrame,
  palette: Palette,
  tolerance = 8,
  region?: FrameRegion,
): FrameClasses {
  const png = decoded(frame.path);
  const bareIsCanvas = near(palette.bare, palette.canvas, tolerance);
  const x0 = Math.max(0, Math.floor(region?.x ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const x1 = Math.min(png.width, Math.ceil(region === undefined ? png.width : region.x + region.width));
  const y1 = Math.min(png.height, Math.ceil(region === undefined ? png.height : region.y + region.height));
  let surface = 0;
  let canvas = 0;
  let grid = 0;
  let bare = 0;
  let other = 0;
  let pixels = 0;
  const counts = new Map<number, number>();
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      pixels += 1;
      const key = (p.r << 16) | (p.g << 8) | p.b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (near(p, palette.surface, tolerance)) surface += 1;
      else if (near(p, palette.canvas, tolerance)) canvas += 1;
      else if (!bareIsCanvas && near(p, palette.bare, tolerance)) bare += 1;
      else if (near(p, palette.canvas, GRID_REACH)) grid += 1;
      else other += 1;
    }
  }
  const n = Math.max(1, pixels);
  let fillKey = 0;
  let most = -1;
  for (const [key, count] of counts) if (count > most) [fillKey, most] = [key, count];
  const fill = `rgb(${(fillKey >> 16) & 255}, ${(fillKey >> 8) & 255}, ${fillKey & 255})`;
  return { t: frame.t, wall: frame.wall, surface: surface / n, canvas: canvas / n, grid: grid / n, bare: bare / n, other: other / n, pixels, fill };
}

/**
 * The leftmost x (device px) on row `y` of the frame where a run of at
 * least `minRun` pixels within `tolerance` of `colour` begins, or null when
 * the row carries no such run. What tells where a surface stands in a
 * composite without any DOM rect: the chrome's title bar on its row, the
 * body on a content row, each read by its own colour.
 */
export function leftEdgeOnRow(frame: CaptureBurstFrame, y: number, colour: Rgb, tolerance: number, minRun = 16): number | null {
  const png = decoded(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  let run = 0;
  for (let x = 0; x < png.width; x++) {
    const i = (row * png.width + x) * 4;
    const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
    if (near(p, colour, tolerance)) {
      run += 1;
      if (run >= minRun) return x - run + 1;
    } else {
      run = 0;
    }
  }
  return null;
}

/**
 * A card's leading edge on row `y` against the ground it travels over: the
 * outermost pixel of the first run of `minRun` pixels that are NOT near
 * `ground`, scanning in from the side the card travels toward (`from: "right"`
 * scans leftward from `x1`, `"left"` rightward from `x0`), or null. A dot
 * grid's dots are shorter than the run, so the ground's texture is not an
 * edge.
 */
export function leadingEdgeOnRow(
  frame: CaptureBurstFrame,
  y: number,
  ground: Rgb,
  tolerance: number,
  from: "left" | "right",
  x0: number,
  x1: number,
  minRun = 6,
): number | null {
  const png = decoded(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  const lo = Math.max(0, Math.round(x0));
  const hi = Math.min(png.width - 1, Math.round(x1));
  const step = from === "right" ? -1 : 1;
  let run = 0;
  for (let x = from === "right" ? hi : lo; x >= lo && x <= hi; x += step) {
    const i = (row * png.width + x) * 4;
    const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
    if (near(p, ground, tolerance)) {
      run = 0;
      continue;
    }
    run += 1;
    if (run === minRun) return x - step * (minRun - 1);
  }
  return null;
}

/**
 * The first x (device px) on row `y`, scanning rightward from `x0`, where the
 * ground begins: the first pixel of a window of `span` pixels at least
 * `minGround` of which lie within `tolerance` of `ground`, or null when the
 * row carries none before `x1`. What finds a card's trailing edge from inside
 * it, where {@link leadingEdgeOnRow} finds its leading edge from outside: the
 * window admits the floor's 1 px grid lines, so a line crossing the ground
 * moves the reading by a pixel at most rather than by the line's spacing.
 */
export function groundStartOnRow(
  frame: CaptureBurstFrame,
  y: number,
  ground: Rgb,
  tolerance: number,
  x0: number,
  x1: number,
  span = 8,
  minGround = 6,
): number | null {
  const png = decoded(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  const lo = Math.max(0, Math.round(x0));
  const hi = Math.min(png.width, Math.round(x1));
  const isGround = (x: number): number => {
    const i = (row * png.width + x) * 4;
    return near({ r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] }, ground, tolerance) ? 1 : 0;
  };
  if (hi - lo < span) return null;
  let count = 0;
  for (let x = lo; x < lo + span; x++) count += isGround(x);
  for (let x = lo; x + span <= hi; x++) {
    if (count >= minGround && isGround(x) === 1) return x;
    if (x + span < hi) count += isGround(x + span) - isGround(x);
  }
  return null;
}

/**
 * The x (device px) on row `y` where a run of at least `minRun` pixels within
 * `tolerance` of `colour` begins, of all such runs on the row the one that
 * begins nearest `nearX`; null when the row carries none. Where two surfaces
 * on the row share one colour — a rail's bar and its body, or an inactive
 * title bar beside it — the leftmost run is another card's, and the run
 * nearest where this card stands is its own. The edge is still the
 * composite's: `nearX` only chooses whose.
 */
export function edgeNearOnRow(frame: CaptureBurstFrame, y: number, colour: Rgb, tolerance: number, nearX: number, minRun = 16): number | null {
  const png = decoded(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  let run = 0;
  let best: number | null = null;
  for (let x = 0; x < png.width; x++) {
    const i = (row * png.width + x) * 4;
    const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
    if (near(p, colour, tolerance)) {
      run += 1;
      if (run === minRun) {
        const start = x - run + 1;
        if (best === null || Math.abs(start - nearX) < Math.abs(best - nearX)) best = start;
      }
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * The first device row at or below `fromY` on column `x` where a run of
 * `minRun` pixels near `colour` begins, or null. What finds a band by its
 * paint on one column: a title bar's top by the chrome's colour, a content
 * box's top by its surface.
 */
export function bandStartOnColumn(
  frame: CaptureBurstFrame,
  x: number,
  colour: Rgb,
  tolerance: number,
  fromY = 0,
  minRun = 4,
): number | null {
  const png = decoded(frame.path);
  const col = Math.min(png.width - 1, Math.max(0, Math.round(x)));
  let run = 0;
  for (let y = Math.max(0, Math.round(fromY)); y < png.height; y++) {
    const i = (y * png.width + col) * 4;
    const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
    if (near(p, colour, tolerance)) {
      run += 1;
      if (run === minRun) return y - run + 1;
    } else {
      run = 0;
    }
  }
  return null;
}

/**
 * The share of `region`'s sampled pixels (device px, stride 4) where two
 * frames of one burst differ by more than `tolerance` in any channel: how
 * much of one area of the composite two frames disagree on, where
 * {@link framesDiffer} asks of the whole frame.
 */
export function regionDiffShare(
  a: CaptureBurstFrame,
  b: CaptureBurstFrame,
  region: { x: number; y: number; width: number; height: number },
  tolerance = 8,
): number {
  const p = decoded(a.path);
  const q = decoded(b.path);
  if (p.width !== q.width || p.height !== q.height) return 1;
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(p.width, Math.ceil(region.x + region.width));
  const y1 = Math.min(p.height, Math.ceil(region.y + region.height));
  let differing = 0;
  let sampled = 0;
  for (let y = y0; y < y1; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      const i = (y * p.width + x) * 4;
      sampled += 1;
      if (
        Math.abs(p.rgba[i] - q.rgba[i]) > tolerance ||
        Math.abs(p.rgba[i + 1] - q.rgba[i + 1]) > tolerance ||
        Math.abs(p.rgba[i + 2] - q.rgba[i + 2]) > tolerance
      ) {
        differing += 1;
      }
    }
  }
  return differing / Math.max(1, sampled);
}

/**
 * Whether two frames of one burst show different paint: the share of
 * sampled pixels (stride 4) that differ by more than `tolerance` in any
 * channel is at least `minShare`. What tells a composite that has shown a
 * gesture's first frame from one still showing the standing deck — the
 * shell's own record can be a frame or two ahead of the window server.
 */
export function framesDiffer(a: CaptureBurstFrame, b: CaptureBurstFrame, tolerance = 8, minShare = 0.002): boolean {
  const p = decoded(a.path);
  const q = decoded(b.path);
  if (p.width !== q.width || p.height !== q.height) return true;
  let differing = 0;
  let sampled = 0;
  for (let y = 0; y < p.height; y += 4) {
    for (let x = 0; x < p.width; x += 4) {
      const i = (y * p.width + x) * 4;
      sampled += 1;
      if (
        Math.abs(p.rgba[i] - q.rgba[i]) > tolerance ||
        Math.abs(p.rgba[i + 1] - q.rgba[i + 1]) > tolerance ||
        Math.abs(p.rgba[i + 2] - q.rgba[i + 2]) > tolerance
      ) {
        differing += 1;
      }
    }
  }
  return differing / Math.max(1, sampled) >= minShare;
}

/**
 * One past the right end of the last vertical line on row `y` whose pixels
 * `isLine` accepts, or null when the row carries none: the last pixel it
 * accepts whose pixels `reach` device px above and below it accepts too, so
 * a glyph in a matching colour is not read as the line. An opaque line
 * paints its own colour whatever lies beneath it, and a line two device px
 * wide covers at least one pixel whole wherever it lands.
 */
export function lineEndOnRow(frame: CaptureBurstFrame, y: number, isLine: (pixel: Rgb) => boolean, reach: number): number | null {
  const png = decoded(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  const rows = [row - reach, row, row + reach].filter((r) => r >= 0 && r < png.height);
  const matches = (x: number): boolean =>
    rows.every((r) => {
      const i = (r * png.width + x) * 4;
      return isLine({ r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] });
    });
  for (let x = png.width - 1; x >= 0; x--) {
    if (matches(x)) return x + 1;
  }
  return null;
}

/**
 * The step in colour into each x (device px) on row `y` from `x0` to `x1`:
 * the largest channel difference between the pixel and the one before it.
 * Where an edge stands is where its step is, and a tint over it or a repaint
 * of the surfaces either side scales the step without moving it.
 */
export function stepsOnRow(frame: CaptureBurstFrame, y: number, x0: number, x1: number): { x: number; step: number }[] {
  const png = decoded(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  const out: { x: number; step: number }[] = [];
  for (let x = Math.max(1, Math.round(x0)); x < Math.min(png.width, Math.round(x1)); x++) {
    const i = (row * png.width + x) * 4;
    const step = Math.max(
      Math.abs(png.rgba[i] - png.rgba[i - 4]),
      Math.abs(png.rgba[i + 1] - png.rgba[i - 3]),
      Math.abs(png.rgba[i + 2] - png.rgba[i - 2]),
    );
    out.push({ x, step });
  }
  return out;
}

/** The commonest colour along row `y` of the frame between `x0` and `x1` (device px). */
export function fillOnRow(frame: CaptureBurstFrame, y: number, x0: number, x1: number): Rgb {
  const png = decoded(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  const counts = new Map<number, number>();
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(png.width, Math.ceil(x1)); x++) {
    const i = (row * png.width + x) * 4;
    const key = (png.rgba[i] << 16) | (png.rgba[i + 1] << 8) | png.rgba[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let fillKey = 0;
  let most = -1;
  for (const [key, count] of counts) if (count > most) [fillKey, most] = [key, count];
  return { r: (fillKey >> 16) & 255, g: (fillKey >> 8) & 255, b: fillKey & 255 };
}

/** One line per frame, for a reader of a red. */
export function describeFrames(frames: readonly FrameClasses[]): string {
  const pct = (v: number): string => (v * 100).toFixed(1);
  return frames
    .map((f) => `${Math.round(f.t)}ms surface ${pct(f.surface)} canvas ${pct(f.canvas)} grid ${pct(f.grid)} bare ${pct(f.bare)} other ${pct(f.other)} fill ${f.fill}`)
    .join("\n");
}

/** Within this of the canvas a pixel is the canvas itself, for {@link gridColumns}. */
const GRID_CANVAS_TOLERANCE = 8;

/**
 * The full-height runs of grid paint in a frame: columns whose pixels are
 * mostly neither the canvas nor far from it. The floor draws one every cell;
 * a card draws none, or a stray rule. The floor is told by its grid rather
 * than by the canvas colour's share, because a Session card's own restore
 * lid and a picker's empty body are dark surfaces within the composite
 * tolerance of the canvas, which a share reads as floor.
 *
 * Only runs on one pitch count: the floor's lines stand a cell apart, while
 * a card's own dark surfaces — a picker sheet's edges over its body — make
 * runs at whatever spacing its layout has. The answer is the longest chain
 * of runs a steady pitch apart.
 */
export function gridColumns(path: string, canvas: Rgb): number {
  return gridColumnsIn(decodePngFile(path), canvas);
}

/** {@link gridColumns} over `region` of a decoded frame, in its pixels (the whole frame when none). */
export function gridColumnsIn(png: DecodedPng, canvas: Rgb, region?: FrameRegion): number {
  const x0 = Math.max(0, Math.floor(region?.x ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const x1 = Math.min(png.width, Math.ceil(region === undefined ? png.width : region.x + region.width));
  const y1 = Math.min(png.height, Math.ceil(region === undefined ? png.height : region.y + region.height));
  const starts: number[] = [];
  let on = false;
  for (let x = x0; x < x1; x++) {
    let hits = 0;
    for (let y = y0; y < y1; y += 2) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      if (!near(p, canvas, GRID_CANVAS_TOLERANCE) && near(p, canvas, GRID_REACH)) hits += 1;
    }
    const line = hits / Math.max(1, Math.ceil((y1 - y0) / 2)) > 0.5;
    if (line && !on) starts.push(x);
    on = line;
  }
  if (starts.length < 2) return starts.length;
  let best = 1;
  let chain = 1;
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    const prev = i > 1 ? starts[i - 1] - starts[i - 2] : gap;
    chain = i > 1 && Math.abs(gap - prev) <= 2 ? chain + 1 : 2;
    best = Math.max(best, chain);
  }
  return best;
}

/** A frame with this many grid columns is showing the floor: a body's chrome draws at most a rule or two. */
export const FLOOR_COLUMNS = 3;

/**
 * Whether a frame shows an OPEN HOLE with nothing beneath it: canvas-coloured
 * paint with none of the floor's grid in it. The floor's grid is a line
 * every 24 px each way, so canvas-class paint that is the floor carries
 * about 8% grid; a bare window carries none. Judged only when there is
 * enough canvas-class paint to judge.
 */
export function showsBareHole(f: FrameClasses, minShare = 0.05): boolean {
  if (f.bare > minShare) return true;
  const floorish = f.canvas + f.grid;
  if (floorish < minShare) return false;
  return f.grid / floorish < 0.02;
}

/** A colour expression evaluated in a page, answered as `rgb(r, g, b)` through a 2D canvas. */
export const asRgbJs = (expr: string): string => `(function () {
  var c = document.createElement("canvas").getContext("2d");
  c.fillStyle = ${expr}; c.fillRect(0, 0, 1, 1);
  var d = c.getImageData(0, 0, 1, 1).data;
  return "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")";
})()`;

/**
 * The palette as the running app has it: the floor's canvas colour from the
 * theme's canvas token (the colour the host's floor draws, and the shell's
 * canvas with bodies off), the window's background from the burst's
 * reading, and the surface from a composite frame of the standing body —
 * its commonest colour, which is the pane surface as the window server
 * shows it.
 */
export async function readPalette(
  app: App,
  windowBackground: string,
  standingBody: CaptureBurstFrame,
): Promise<Palette> {
  const canvas = await app.evalJS<string>(
    asRgbJs(`getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')`),
  );
  return {
    surface: fillOf(standingBody),
    canvas: parseRgb(canvas),
    bare: parseRgb(windowBackground),
  };
}

/**
 * Poll `read` until `done` holds; returns the reading that satisfied it, and
 * throws once `timeoutMs` passes without one, naming the last reading. A
 * wait is a step: a defect that leaves it waiting stops the test there, with
 * what it saw, rather than letting it run on into a later and misleading red.
 * A wait whose value the caller asserts itself is {@link settleFor}.
 */
export async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const value = await settleFor(read, done, timeoutMs);
  if (!done(value)) {
    const seen = JSON.stringify(value) ?? String(value);
    throw new Error(`pollFor: not done after ${timeoutMs} ms; the last reading ${seen.length > 400 ? `${seen.slice(0, 400)}…` : seen}`);
  }
  return value;
}

/**
 * Poll `read` until `done` holds or `timeoutMs` passes, and return the last
 * reading either way: for a wait whose value the caller asserts itself, with
 * its own message — or one whose running out is an answer, not a fault.
 */
export async function settleFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50);
    value = await read();
  }
  return value;
}
