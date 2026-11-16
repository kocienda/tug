/**
 * spike-diagram-plus-layout.ts — the four diagram forms, each redrawn with
 * the changes the Diagram Plus spike proposes.
 *
 * Every function here takes a spec with no coordinates in it and returns a
 * layer 0 program, the way the shipped forms in
 * `crates/tuggraphics/src/diagram/` do. The specs carry a few fields the
 * shipped ones do not have yet (`cross`, `link`, `phases`, `legend`); those
 * are part of what is proposed, and each is named in the spike's notes.
 *
 * Nothing here ships. It is TypeScript so a look can be changed without a
 * WASM build; what survives is ported to the Rust forms and their pen.
 *
 * @module spikes/spike-diagram-plus-layout
 */

import type { ChartTypeRole, InkBox, TextBox } from "@/lib/lazy/load-tuggraphics";

/* ---------------------------------------------------------------------------
 * Specs
 * ---------------------------------------------------------------------------*/

export type Tone = "good" | "bad" | "caution" | "outside";

export interface PlusCell {
  name: string;
  sub?: string;
  mono?: boolean;
  key?: number;
  lit?: Tone;
}

/** What crosses a boundary: the channel, and what goes each way over it. */
export interface Crossing {
  via?: string;
  down?: string;
  up?: string;
}

export interface LayersPlusSpec {
  form: "layers";
  layers: { name: string; sub?: string; tone?: Tone; cells: PlusCell[]; cross?: Crossing }[];
}

export interface StackBlock {
  name: string;
  sub?: string;
  span: [number, number];
  /** What the arrow to this block carries. */
  link?: string;
}

export interface StackPlusSpec {
  form: "stack";
  columns: number;
  above: StackBlock[];
  layers: { name: string; sub?: string; span?: [number, number]; rows: PlusCell[][]; below?: string }[];
  below: StackBlock[];
  across?: { title: string; names: string[] };
}

export interface SequencePlusSpec {
  form: "sequence";
  actors: { id: string; name: string; sub?: string }[];
  messages: { from: string; to: string; label: string; reply?: boolean; tone?: Tone; key?: number }[];
  /** Runs of messages that belong together, by 0-based message index. */
  phases?: { label: string; note?: string; from: number; to: number }[];
}

export interface FlowPlusSpec {
  form: "flow";
  columns: { id: string; name: string; sub?: string; rows?: PlusCell[] }[][];
  edges: { from: string; to: string; tone?: Tone; label?: string; dashed?: boolean }[];
  /** What each tone means in this figure, drawn under it. */
  legend?: { tone: Tone; text: string }[];
}

/** A new form: what a thing can be, and what moves it from one to another. */
export interface StatesPlusSpec {
  form: "states";
  /** The state a thing begins in. */
  start: string;
  /**
   * States without `under` are the main line, left to right in the order
   * given. A state `under` another hangs beneath it: a failure, a side exit.
   */
  states: { id: string; name: string; sub?: string; key?: number; tone?: Tone; end?: boolean; under?: string }[];
  transitions: { from: string; to: string; label?: string; tone?: Tone; dashed?: boolean }[];
}

export interface TreeNode {
  name: string;
  sub?: string;
  mono?: boolean;
  key?: number;
  tone?: Tone;
  children?: TreeNode[];
}

/** A new form: what is inside what. */
export interface TreePlusSpec {
  form: "tree";
  root: TreeNode;
}

export type PlusSpec = LayersPlusSpec | StackPlusSpec | SequencePlusSpec | FlowPlusSpec | StatesPlusSpec | TreePlusSpec;

export type Measure = (role: ChartTypeRole, text: string) => TextBox;
export type Ink = (role: ChartTypeRole, text: string) => InkBox;

export interface Drawn {
  /** The layer 0 program, as source. */
  program: string;
  width: number;
  height: number;
}

/* ---------------------------------------------------------------------------
 * The pen
 * ---------------------------------------------------------------------------*/

type Colour = "ink" | "ink-muted" | "grid" | "surface" | "accent" | Tone;
type Op = (string | number | number[] | Record<string, unknown>)[];
type Pt = [number, number];

const MARGIN = 16;
const DISC = 8;
const KEY_LEAD = DISC * 2 + 7;
const LINE_GAP = 2;
/** A connector's weight, and its head: long enough to read as a direction. */
const EDGE = 2;
const HEAD = 11;
const HALF = 5.5;
const MAX_DELAY = 64;

function unit(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

interface TextOpts {
  role?: ChartTypeRole;
  fill?: Colour;
  anchor?: "start" | "middle" | "end";
  baseline?: "top" | "middle" | "alphabetic" | "bottom";
  delay?: number;
}

interface ArrowOpts {
  colour?: Colour;
  dashed?: boolean;
  width?: number;
  /** A stroked V in place of a filled head: a return, not a call. */
  open?: boolean;
  /** A head at the start too. */
  both?: boolean;
  /** No head at all: a line that joins, not one that points. */
  bare?: boolean;
  delay?: number;
}

class Pen {
  readonly ops: Op[] = [];
  readonly lh: Record<ChartTypeRole, number>;

  constructor(
    private readonly motion: boolean,
    readonly measure: Measure,
    private readonly ink: Ink,
  ) {
    const lh = (r: ChartTypeRole): number => {
      const m = measure(r, "Hg");
      return Math.ceil(m.a + m.d);
    };
    this.lh = { title: lh("title"), label: lh("label"), value: lh("value"), mono: lh("mono") };
  }

  w(role: ChartTypeRole, s: string | undefined): number {
    return s === undefined || s === "" ? 0 : Math.ceil(this.measure(role, s).w);
  }

  /** Words wrapped at `max` px to at most `most` lines; the last line takes what is left. */
  wrap(role: ChartTypeRole, s: string | undefined, max: number, most = 2): string[] {
    if (s === undefined || s === "") return [];
    const out: string[] = [];
    let line = "";
    for (const word of s.split(" ")) {
      const next = line === "" ? word : `${line} ${word}`;
      if (line !== "" && out.length < most - 1 && this.w(role, next) > max) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
    return out;
  }

  widest(role: ChartTypeRole, lines: string[]): number {
    return lines.reduce((m, l) => Math.max(m, this.w(role, l)), 0);
  }

  block(role: ChartTypeRole, n: number): number {
    return n === 0 ? 0 : n * this.lh[role] + (n - 1) * LINE_GAP;
  }

  private enter(kind: "fade" | "draw", delay: number | undefined): Record<string, unknown> | undefined {
    if (!this.motion || delay === undefined) return undefined;
    return { enter: kind, delay: Math.min(Math.max(0, Math.round(delay)), MAX_DELAY) };
  }

  private paint(verb: "fill" | "stroke", colour: Colour, opacity: number, opts?: Record<string, unknown>): void {
    this.ops.push(["opacity", opacity]);
    this.ops.push(opts === undefined ? [verb, colour] : [verb, colour, opts]);
  }

  box(
    x: number, y: number, w: number, h: number, r: number,
    o: { fill?: Colour; fillOpacity?: number; stroke?: Colour; strokeOpacity?: number; delay?: number },
  ): void {
    this.reach = [Math.min(this.reach[0], x), Math.max(this.reach[1], x + w)];
    if (o.fill !== undefined) {
      this.ops.push(["rect", x, y, w, h, { r }]);
      this.paint("fill", o.fill, o.fillOpacity ?? 1, this.enter("fade", o.delay));
    }
    if (o.stroke !== undefined) {
      this.ops.push(["width", 1]);
      this.ops.push(["rect", x, y, w, h, { r }]);
      this.paint("stroke", o.stroke, o.strokeOpacity ?? 1, this.enter("fade", o.delay));
    }
  }

  text(x: number, y: number, s: string, o: TextOpts = {}): void {
    this.ops.push(["opacity", 1]);
    this.ops.push([
      "text", x, y, s,
      {
        role: o.role ?? "label",
        fill: o.fill ?? "ink",
        anchor: o.anchor ?? "start",
        baseline: o.baseline ?? "top",
        ...this.enter("fade", o.delay),
      },
    ]);
  }

  /** Lines of one role stacked from `y` down. */
  lines(x: number, y: number, lines: string[], o: TextOpts = {}): void {
    const role = o.role ?? "value";
    lines.forEach((line, j) => this.text(x, y + j * (this.lh[role] + LINE_GAP), line, { ...o, role, baseline: "top" }));
  }

  upright(cx: number, cy: number, s: string, o: TextOpts = {}): void {
    this.ops.push(["group", { translate: [cx, cy], rotate: -90 }]);
    this.text(0, 0, s, { ...o, anchor: "middle", baseline: "middle" });
    this.ops.push(["end"]);
  }

  key(cx: number, cy: number, n: number, delay?: number): void {
    this.ops.push(["circle", cx, cy, DISC]);
    this.paint("fill", "accent", 1, this.enter("fade", delay));
    const s = String(n);
    const box = this.ink("value", s);
    this.text(cx - (box.r + box.l) / 2, cy + (box.a - box.d) / 2, s, {
      role: "value", fill: "surface", anchor: "start", baseline: "alphabetic", delay,
    });
  }

  dot(cx: number, cy: number, r: number, colour: Colour, delay?: number): void {
    this.ops.push(["circle", cx, cy, r]);
    this.paint("fill", colour, 1, this.enter("fade", delay));
  }

  rule(a: Pt, b: Pt, colour: Colour, o: { dash?: number[]; width?: number; opacity?: number; delay?: number } = {}): void {
    this.ops.push(["width", o.width ?? 1]);
    if (o.dash !== undefined) this.ops.push(["dash", o.dash]);
    this.ops.push(["move", a[0], a[1]], ["line", b[0], b[1]]);
    this.paint("stroke", colour, o.opacity ?? 1, this.enter("fade", o.delay));
    if (o.dash !== undefined) this.ops.push(["dash", []]);
  }

  /** A connector along `pts` with rounded elbows, ending in a head. */
  arrow(pts: Pt[], o: ArrowOpts = {}): void {
    const colour = o.colour ?? "ink";
    const n = pts.length;
    const tip = pts[n - 1];
    const d = unit(pts[n - 2], tip);
    const line = pts.slice();
    // A filled head covers the stroke's end; an open one is the stroke's end.
    if (o.open !== true && o.bare !== true) line[n - 1] = [tip[0] - d[0] * (HEAD - 1), tip[1] - d[1] * (HEAD - 1)];
    const d0 = unit(pts[1], pts[0]);
    if (o.both === true) line[0] = [pts[0][0] - d0[0] * (HEAD - 1), pts[0][1] - d0[1] * (HEAD - 1)];

    this.ops.push(["width", o.width ?? EDGE]);
    if (o.dashed === true) this.ops.push(["dash", [6, 4]]);
    this.ops.push(["move", line[0][0], line[0][1]]);
    for (let i = 1; i < line.length; i++) {
      const p = line[i];
      if (i === line.length - 1) {
        this.ops.push(["line", p[0], p[1]]);
        break;
      }
      const prev = line[i - 1];
      const next = line[i + 1];
      const r = Math.min(8, dist(prev, p) / 2, dist(p, next) / 2);
      const din = unit(prev, p);
      const dout = unit(p, next);
      this.ops.push(["line", p[0] - din[0] * r, p[1] - din[1] * r]);
      this.ops.push(["curve", p[0], p[1], p[0], p[1], p[0] + dout[0] * r, p[1] + dout[1] * r]);
    }
    const enter = this.enter(o.dashed === true ? "fade" : "draw", o.delay);
    this.paint("stroke", colour, 1, { join: "round", cap: "butt", ...enter });
    if (o.dashed === true) this.ops.push(["dash", []]);
    if (o.bare !== true) this.head(tip, d, colour, o.open === true, o.delay);
    if (o.both === true) this.head(pts[0], d0, colour, false, o.delay);
  }

  private head(tip: Pt, d: Pt, colour: Colour, open: boolean, delay: number | undefined): void {
    const bx = tip[0] - d[0] * HEAD;
    const by = tip[1] - d[1] * HEAD;
    const a: Pt = [bx - d[1] * HALF, by + d[0] * HALF];
    const b: Pt = [bx + d[1] * HALF, by - d[0] * HALF];
    if (open) {
      this.ops.push(["width", EDGE]);
      this.ops.push(["move", a[0], a[1]], ["line", tip[0], tip[1]], ["line", b[0], b[1]]);
      this.paint("stroke", colour, 1, { join: "round", cap: "round", ...this.enter("fade", delay) });
      return;
    }
    this.ops.push(["move", tip[0], tip[1]], ["line", a[0], a[1]], ["line", b[0], b[1]], ["close"]);
    this.paint("fill", colour, 1, this.enter("fade", delay));
  }

  chipSize(lines: string[], role: ChartTypeRole = "value"): { w: number; h: number } {
    return { w: this.widest(role, lines) + 18, h: this.block(role, lines.length) + 8 };
  }

  /**
   * A label that sits on its connector: the figure's surface under it, so
   * the line it names runs into it and out the other side.
   */
  chip(cx: number, cy: number, lines: string[], o: { role?: ChartTypeRole; colour?: Colour; delay?: number } = {}): void {
    if (lines.length === 0) return;
    const role = o.role ?? "value";
    const { w, h } = this.chipSize(lines, role);
    const x = Math.round(cx - w / 2);
    const y = Math.round(cy - h / 2);
    this.box(x, y, w, h, Math.min(10, h / 2), {
      fill: "surface",
      stroke: o.colour ?? "ink-muted",
      strokeOpacity: o.colour === undefined ? 0.55 : 0.8,
      delay: o.delay,
    });
    lines.forEach((line, j) =>
      this.text(Math.round(cx), y + 4 + j * (this.lh[role] + LINE_GAP), line, {
        role, fill: o.colour ?? "ink", anchor: "middle", baseline: "top", delay: o.delay,
      }),
    );
  }

  /** How far left and right the boxes and chips drawn so far reach. */
  reach: [number, number] = [Infinity, -Infinity];

  /** The finished program, every mark moved `dx` to the right. */
  finish(width: number, height: number, dx = 0): Drawn {
    const w = Math.ceil(width);
    const h = Math.ceil(height);
    const ops: Op[] = [["group", { translate: [0.5 + dx, 0.5] }], ...this.ops, ["end"]];
    return { program: JSON.stringify({ tugdraw: 1, frame: [w + 1, h + 1], ops }), width: w + 1, height: h + 1 };
  }
}

/* ---------------------------------------------------------------------------
 * layers — a channel between each pair of bands, centred, with what goes
 * each way
 * ---------------------------------------------------------------------------*/

function layoutLayers(spec: LayersPlusSpec, pen: Pen): Drawn {
  const BAND_PAD = 10;
  const CELL_GAP = 8;
  const CROSS_GAP = 58;

  const heads = spec.layers.map((l) => Math.max(pen.w("title", l.name), pen.w("value", l.sub)));
  const labelW = Math.max(...heads) + 44;
  const cellW = (c: PlusCell): number =>
    (c.key !== undefined ? KEY_LEAD : 0) + Math.max(pen.w(c.mono === true ? "mono" : "label", c.name), pen.w("value", c.sub)) + 24;
  let inner = Math.max(
    ...spec.layers.map((l) => l.cells.length * Math.max(...l.cells.map(cellW)) + CELL_GAP * (l.cells.length - 1)),
  );

  // A crossing is laid out about the band's own centre, so the band is at least as wide as its widest crossing.
  const crossings = spec.layers.map((l) => {
    const c = l.cross;
    if (c === undefined) return null;
    const via = pen.chipSize(c.via === undefined ? [] : [c.via], "mono");
    const down = pen.wrap("value", c.down, 170);
    const up = pen.wrap("value", c.up, 170);
    const half = c.via === undefined ? 12 : Math.round(via.w / 2) + 18;
    const side = Math.max(pen.widest("value", down), pen.widest("value", up));
    return { via: c.via, down, up, half, need: 2 * (half + 12 + side) + 2 * BAND_PAD, paired: down.length > 0 && up.length > 0 };
  });
  const need = Math.max(0, ...crossings.map((c) => (c === null ? 0 : c.need)));
  inner = Math.max(inner, need - labelW - BAND_PAD);

  const cellH = 16 + Math.max(pen.lh.label, DISC * 2) + LINE_GAP + pen.lh.value;
  const bandH = cellH + 2 * BAND_PAD;
  const bandW = labelW + inner + BAND_PAD;
  const x = MARGIN;
  let y = MARGIN;

  spec.layers.forEach((layer, i) => {
    const outside = layer.tone === "outside";
    pen.box(x, y, bandW, bandH, 8, {
      fill: outside ? "outside" : "surface",
      fillOpacity: outside ? 0.16 : 1,
      stroke: outside ? "outside" : "ink-muted",
      strokeOpacity: 0.9,
      delay: i,
    });
    const headH = pen.lh.title + (layer.sub === undefined ? 0 : 3 + pen.lh.value);
    const ty = y + Math.round((bandH - headH) / 2);
    pen.text(x + 14, ty, layer.name, { role: "title", delay: i });
    if (layer.sub !== undefined) pen.text(x + 14, ty + pen.lh.title + 3, layer.sub, { role: "value", fill: "ink-muted", delay: i });
    // The head is the band's label, ruled off from what the band holds.
    pen.rule([x + labelW - 15, y + BAND_PAD], [x + labelW - 15, y + bandH - BAND_PAD], "ink-muted", { opacity: 0.35, delay: i });

    const n = layer.cells.length;
    const cw = Math.round((inner - CELL_GAP * (n - 1)) / n);
    layer.cells.forEach((cell, k) => {
      const cx = Math.round(x + labelW + k * (cw + CELL_GAP));
      pen.box(cx, y + BAND_PAD, cw, cellH, 5, { fill: "surface", stroke: "ink-muted", strokeOpacity: 0.3, delay: i });
      const band1 = Math.max(pen.lh.label, DISC * 2);
      const textH = band1 + (cell.sub === undefined ? 0 : LINE_GAP + pen.lh.value);
      const top = y + BAND_PAD + Math.round((cellH - textH) / 2);
      const lineY = top + Math.round(band1 / 2);
      if (cell.key !== undefined) pen.key(cx + 12 + DISC, lineY, cell.key, i);
      const tx = cx + 12 + (cell.key !== undefined ? KEY_LEAD : 0);
      pen.text(tx, lineY, cell.name, { role: cell.mono === true ? "mono" : "label", baseline: "middle", delay: i });
      if (cell.sub !== undefined) pen.text(tx, top + band1 + LINE_GAP, cell.sub, { role: "value", fill: "ink-muted", delay: i });
    });

    y += bandH;
    if (i + 1 === spec.layers.length) return;
    const c = crossings[i];
    if (c === null) {
      y += 14;
      return;
    }
    const mid = Math.round(x + bandW / 2);
    const [a, b] = [y + 4, y + CROSS_GAP - 4];
    const cy = Math.round(y + CROSS_GAP / 2);
    if (c.paired) {
      pen.arrow([[mid - c.half, a], [mid - c.half, b]], { delay: i + 1 });
      pen.arrow([[mid + c.half, b], [mid + c.half, a]], { delay: i + 1 });
      const dy = cy - Math.round(pen.block("value", c.down.length) / 2);
      pen.lines(mid - c.half - 12, dy, c.down, { anchor: "end", fill: "ink", delay: i + 1 });
      const uy = cy - Math.round(pen.block("value", c.up.length) / 2);
      pen.lines(mid + c.half + 12, uy, c.up, { anchor: "start", fill: "ink", delay: i + 1 });
      if (c.via !== undefined) pen.chip(mid, cy, [c.via], { role: "mono", delay: i + 1 });
    } else {
      const one = c.down.length > 0 ? c.down : c.up;
      const pts: Pt[] = c.up.length > 0 ? [[mid, b], [mid, a]] : [[mid, a], [mid, b]];
      pen.arrow(pts, { both: one.length === 0, delay: i + 1 });
      if (one.length > 0) pen.lines(mid + 14, cy - Math.round(pen.block("value", one.length) / 2), one, { fill: "ink", delay: i + 1 });
      if (c.via !== undefined) pen.chip(mid, cy, [c.via], { role: "mono", delay: i + 1 });
    }
    y += CROSS_GAP;
  });

  return pen.finish(x + bandW + MARGIN, y + MARGIN);
}

/* ---------------------------------------------------------------------------
 * stack — every arrow says what it carries, and adjacent layers may too
 * ---------------------------------------------------------------------------*/

function layoutStack(spec: StackPlusSpec, pen: Pen): Drawn {
  const COL_GAP = 12;
  const PAD = 12;
  const CELL_GAP = 8;
  const QUIET = 12;
  const LINK = 66;
  const BLOCK_H = 16 + pen.lh.title + 3 + pen.lh.value + 16;

  const span = (s: [number, number] | undefined): [number, number] => s ?? [1, spec.columns];
  const cellW = (c: PlusCell): number =>
    (c.key !== undefined ? KEY_LEAD : 0) + Math.max(pen.w("label", c.name), pen.w("value", c.sub)) + 28;

  // One column width for the whole grid: the narrowest that fits every row and every outside block.
  let colW = 110;
  const fit = (need: number, cols: number): void => {
    colW = Math.max(colW, Math.ceil((need - (cols - 1) * COL_GAP) / cols));
  };
  for (const layer of spec.layers) {
    const [a, b] = span(layer.span);
    for (const row of layer.rows) {
      fit(row.length * Math.max(...row.map(cellW)) + CELL_GAP * (row.length - 1) + 2 * PAD, b - a + 1);
    }
  }
  for (const blk of [...spec.above, ...spec.below]) {
    fit(Math.max(pen.w("title", blk.name), pen.w("value", blk.sub)) + 40, blk.span[1] - blk.span[0] + 1);
  }

  const gutter = Math.max(...spec.layers.map((l) => Math.max(pen.w("title", l.name), pen.w("value", l.sub)))) + 18;
  const gx = MARGIN + gutter;
  const xOf = (s: [number, number]): { x: number; w: number } => ({
    x: gx + (s[0] - 1) * (colW + COL_GAP),
    w: (s[1] - s[0] + 1) * colW + (s[1] - s[0]) * COL_GAP,
  });
  const gridW = spec.columns * colW + (spec.columns - 1) * COL_GAP;

  /** An arrow up and down at `cx` between `y0` and `y1`, with what it carries on it. */
  const link = (cx: number, y0: number, y1: number, label: string | undefined, delay: number): void => {
    pen.arrow([[cx, y0 + 4], [cx, y1 - 4]], { both: true, delay });
    if (label !== undefined) pen.chip(cx, Math.round((y0 + y1) / 2), pen.wrap("value", label, 180), { delay });
  };
  const outside = (blk: StackBlock, y: number, delay: number): number => {
    const { x, w } = xOf(blk.span);
    pen.box(x, y, w, BLOCK_H, 8, { fill: "outside", fillOpacity: 0.16, stroke: "outside", delay });
    const cx = Math.round(x + w / 2);
    pen.text(cx, y + 16, blk.name, { role: "title", anchor: "middle", delay });
    if (blk.sub !== undefined) {
      pen.text(cx, y + 16 + pen.lh.title + 3, blk.sub, { role: "value", fill: "ink-muted", anchor: "middle", delay });
    }
    return cx;
  };

  let y = MARGIN;
  let step = 0;
  const aboveX = spec.above.map((blk) => outside(blk, y, step));
  if (spec.above.length > 0) {
    spec.above.forEach((blk, i) => link(aboveX[i], y + BLOCK_H, y + BLOCK_H + LINK, blk.link, step + 1));
    y += BLOCK_H + LINK;
    step++;
  }

  const top = y;
  const placed: { x: number; w: number; bottom: number }[] = [];
  spec.layers.forEach((layer, i) => {
    const { x, w } = xOf(span(layer.span));
    const rowH = layer.rows.map((row) => 18 + pen.lh.label + (row.some((c) => c.sub !== undefined) ? LINE_GAP + pen.lh.value : 0));
    const h = 2 * PAD + rowH.reduce((s, v) => s + v, 0) + CELL_GAP * (layer.rows.length - 1);
    pen.box(x, y, w, h, 8, { fill: "surface", stroke: "ink-muted", strokeOpacity: 0.9, delay: step });
    const headH = pen.lh.title + (layer.sub === undefined ? 0 : 3 + pen.lh.value);
    const ty = y + Math.round((h - headH) / 2);
    pen.text(gx - 16, ty, layer.name, { role: "title", anchor: "end", delay: step });
    if (layer.sub !== undefined) {
      pen.text(gx - 16, ty + pen.lh.title + 3, layer.sub, { role: "value", fill: "ink-muted", anchor: "end", delay: step });
    }

    let ry = y + PAD;
    layer.rows.forEach((row, r) => {
      const cw = Math.round((w - 2 * PAD - CELL_GAP * (row.length - 1)) / row.length);
      row.forEach((cell, k) => {
        const cx0 = Math.round(x + PAD + k * (cw + CELL_GAP));
        pen.box(cx0, ry, cw, rowH[r], 5, { fill: "surface", stroke: "ink-muted", strokeOpacity: 0.3, delay: step });
        const textH = pen.lh.label + (cell.sub === undefined ? 0 : LINE_GAP + pen.lh.value);
        const lineY = ry + Math.round((rowH[r] - textH) / 2) + Math.round(pen.lh.label / 2);
        // The key and its name are one group, centred together: the disc never drifts to a corner.
        const nameW = pen.w("label", cell.name);
        const groupW = (cell.key !== undefined ? KEY_LEAD : 0) + nameW;
        const left = Math.round(cx0 + (cw - groupW) / 2);
        if (cell.key !== undefined) pen.key(left + DISC, lineY, cell.key, step);
        pen.text(left + (cell.key !== undefined ? KEY_LEAD : 0), lineY, cell.name, { baseline: "middle", delay: step });
        if (cell.sub !== undefined) {
          pen.text(Math.round(cx0 + cw / 2), lineY + Math.round(pen.lh.label / 2) + LINE_GAP, cell.sub, {
            role: "value", fill: "ink-muted", anchor: "middle", delay: step,
          });
        }
      });
      ry += rowH[r] + CELL_GAP;
    });

    y += h;
    placed.push({ x, w, bottom: y });
    step++;
    if (i + 1 === spec.layers.length) return;
    if (layer.below === undefined) {
      y += QUIET;
      return;
    }
    // Centred on what the two layers share, which is where they touch.
    const next = xOf(span(spec.layers[i + 1].span));
    const lo = Math.max(x, next.x);
    const hi = Math.min(x + w, next.x + next.w);
    link(Math.round((lo + hi) / 2), y, y + LINK, layer.below, step);
    y += LINK;
  });
  const bottom = y;

  if (spec.below.length > 0) {
    const by = bottom + LINK;
    spec.below.forEach((blk) => {
      const cx = outside(blk, by, step);
      // The arrow rises to the lowest layer standing over this block.
      const over = [...placed].reverse().find((p) => cx > p.x && cx < p.x + p.w);
      link(cx, over?.bottom ?? bottom, by, blk.link, step + 1);
    });
    y = by + BLOCK_H;
  }

  let right = gx + gridW;
  if (spec.across !== undefined) {
    const BAR = 30;
    let bx = right + 20;
    pen.text(bx, top - 6, spec.across.title, { role: "value", fill: "ink-muted", baseline: "bottom", delay: step });
    for (const name of spec.across.names) {
      pen.box(bx, top, BAR, bottom - top, 6, { fill: "surface", stroke: "ink-muted", strokeOpacity: 0.9, delay: step });
      pen.upright(bx + BAR / 2, Math.round((top + bottom) / 2), name, { role: "value", delay: step });
      bx += BAR + 8;
    }
    right = bx - 8;
  }

  return pen.finish(right + MARGIN, y + MARGIN);
}

/* ---------------------------------------------------------------------------
 * sequence — keys on the lifeline, activations, phases, calls and returns
 * that differ in shape
 * ---------------------------------------------------------------------------*/

function layoutSequence(spec: SequencePlusSpec, pen: Pen): Drawn {
  const ACTOR_H = 14 + pen.lh.title + 3 + pen.lh.value + 14;
  const BAR = 5;
  const phases = spec.phases ?? [];
  const GUTTER_WRAP = 118;
  const gutter =
    phases.length === 0
      ? 0
      : Math.max(...phases.map((p) => Math.max(pen.w("label", p.label), pen.widest("value", pen.wrap("value", p.note, GUTTER_WRAP, 3))))) + 26;

  const at = new Map(spec.actors.map((a, i) => [a.id, i]));
  const boxW = spec.actors.map((a) => Math.max(pen.w("title", a.name), pen.w("value", a.sub)) + 30);

  // Lifeline spacing: wide enough for the actors' boxes and for every label on the run it sits over.
  const gaps: number[] = spec.actors.slice(1).map((_, i) => boxW[i] / 2 + boxW[i + 1] / 2 + 22);
  for (const m of spec.messages) {
    const [a, b] = [at.get(m.from) ?? 0, at.get(m.to) ?? 0];
    if (a === b) continue;
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    const need = pen.w("label", m.label) + 56;
    const have = gaps.slice(lo, hi).reduce((s, v) => s + v, 0);
    if (have < need) for (let i = lo; i < hi; i++) gaps[i] += (need - have) / (hi - lo);
  }
  const xs: number[] = [MARGIN + gutter + boxW[0] / 2];
  gaps.forEach((g, i) => xs.push(Math.round(xs[i] + g)));
  xs[0] = Math.round(xs[0]);

  // Rows: a return sits close under its call; a new exchange takes a full step; a phase opens with more.
  const ys: number[] = [];
  let y = MARGIN + ACTOR_H + 46;
  spec.messages.forEach((m, i) => {
    if (i > 0) {
      const prev = spec.messages[i - 1];
      y += m.reply === true ? 34 : 46;
      if (prev.from === prev.to) y += 12;
      if (phases.some((p) => p.from === i)) y += 18;
    }
    ys.push(y);
  });
  const last = ys[ys.length - 1] ?? y;
  const selfTail = spec.messages.length > 0 && spec.messages[spec.messages.length - 1].from === spec.messages[spec.messages.length - 1].to ? 22 : 0;
  const foot = last + selfTail + 30;

  let right = xs[xs.length - 1] + boxW[boxW.length - 1] / 2;
  spec.messages.forEach((m) => {
    if (m.from === m.to) right = Math.max(right, xs[at.get(m.from) ?? 0] + 52 + pen.w("label", m.label));
  });
  right = Math.ceil(right);

  // Phases first: they are the ground the exchange is drawn on.
  phases.forEach((p) => {
    const y0 = ys[p.from] - 30;
    const y1 = ys[p.to] + (spec.messages[p.to].from === spec.messages[p.to].to ? 34 : 14);
    pen.box(MARGIN, y0, right - MARGIN + 8, y1 - y0, 6, { fill: "ink-muted", fillOpacity: 0.07, delay: p.from + 1 });
    pen.text(MARGIN + 10, y0 + 9, p.label, { role: "label", delay: p.from + 1 });
    pen.lines(MARGIN + 10, y0 + 9 + pen.lh.label + 3, pen.wrap("value", p.note, GUTTER_WRAP, 3), { fill: "ink-muted", delay: p.from + 1 });
  });

  spec.actors.forEach((a, i) => {
    const bx = Math.round(xs[i] - boxW[i] / 2);
    pen.rule([xs[i], MARGIN + ACTOR_H], [xs[i], foot - 6], "ink-muted", { dash: [3, 4], opacity: 0.7, delay: 0 });
    pen.box(bx, MARGIN, boxW[i], ACTOR_H, 8, { fill: "surface", stroke: "ink-muted", strokeOpacity: 0.9, delay: 0 });
    pen.text(xs[i], MARGIN + 14, a.name, { role: "title", anchor: "middle", delay: 0 });
    if (a.sub !== undefined) {
      pen.text(xs[i], MARGIN + 14 + pen.lh.title + 3, a.sub, { role: "value", fill: "ink-muted", anchor: "middle", delay: 0 });
    }
    // The name again where a long exchange ends, so the last message is never read against a bare line.
    pen.text(xs[i], foot, a.name, { role: "value", fill: "ink-muted", anchor: "middle", delay: spec.messages.length });
  });

  // An actor is busy from a call it receives to the return it sends for it.
  const busy: { actor: number; from: number; to: number }[] = [];
  spec.messages.forEach((m, i) => {
    if (m.reply === true || m.from === m.to) return;
    const j = spec.messages.findIndex((r, k) => k > i && r.reply === true && r.from === m.to && r.to === m.from);
    if (j > i) busy.push({ actor: at.get(m.to) ?? 0, from: i, to: j });
  });
  for (const b of busy) {
    pen.box(xs[b.actor] - BAR, ys[b.from] - 5, BAR * 2, ys[b.to] - ys[b.from] + 10, 3, {
      fill: "surface", stroke: "ink-muted", strokeOpacity: 0.9, delay: b.from + 1,
    });
  }
  const barAt = (actor: number, i: number): boolean => busy.some((b) => b.actor === actor && b.from <= i && b.to >= i);

  spec.messages.forEach((m, i) => {
    const [a, b] = [at.get(m.from) ?? 0, at.get(m.to) ?? 0];
    const my = ys[i];
    const delay = i + 1;
    const colour: Colour = m.tone ?? (m.reply === true ? "ink-muted" : "ink");
    if (a === b) {
      const x0 = xs[a];
      const start = x0 + (m.key !== undefined ? DISC : 0);
      pen.arrow([[start, my], [x0 + 34, my], [x0 + 34, my + 22], [x0 + (barAt(a, i) ? BAR : 1), my + 22]], { colour, delay });
      if (m.key !== undefined) pen.key(x0, my, m.key, delay);
      pen.text(x0 + 46, my + 11, m.label, { baseline: "middle", delay });
      return;
    }
    const dir = b > a ? 1 : -1;
    const origin = xs[a] + dir * (m.key !== undefined ? DISC : barAt(a, i) ? BAR : 0);
    const tip = xs[b] - dir * (barAt(b, i) ? BAR : 1);
    pen.arrow([[origin, my], [tip, my]], { colour, dashed: m.reply === true, open: m.reply === true, width: m.reply === true ? 1.5 : EDGE, delay });
    // The key is where the message starts: on the lifeline of whoever sends it.
    if (m.key !== undefined) pen.key(xs[a], my, m.key, delay);
    else if (m.reply !== true && !barAt(a, i)) pen.dot(xs[a], my, 3, colour, delay);
    pen.text(Math.round((origin + tip) / 2), my - 7, m.label, {
      fill: m.tone ?? (m.reply === true ? "ink-muted" : "ink"), anchor: "middle", baseline: "bottom", delay,
    });
  });

  return pen.finish(right + MARGIN + 8, foot + pen.lh.value + MARGIN);
}

/* ---------------------------------------------------------------------------
 * flow — labels ride their edges, ports say where an edge leaves, a back
 * edge takes the short way, tones are named in the figure
 * ---------------------------------------------------------------------------*/

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function layoutFlow(spec: FlowPlusSpec, pen: Pen): Drawn {
  const BOX_PAD = 12;
  const ROW_GAP = 8;
  const BOX_GAP = 20;
  const SUB_WRAP = 130;

  type Node = FlowPlusSpec["columns"][number][number];
  const rowSubs = new Map<PlusCell, string[]>();
  const rowW = (r: PlusCell): number => {
    const sub = pen.wrap("value", r.sub, SUB_WRAP);
    rowSubs.set(r, sub);
    return (
      (r.key !== undefined ? KEY_LEAD : 0) +
      Math.max(pen.w(r.mono === true ? "mono" : "label", r.name), pen.widest("value", sub)) +
      24 +
      (r.lit !== undefined ? 18 : 0)
    );
  };
  const rowH = (r: PlusCell): number => {
    const n = (rowSubs.get(r) ?? []).length;
    return 16 + Math.max(pen.lh.label, DISC * 2) + (n > 0 ? LINE_GAP + pen.block("value", n) : 0);
  };
  const headSub = (n: Node): string[] => pen.wrap("value", n.sub, Math.max(SUB_WRAP, pen.w("title", n.name)));
  const headH = (n: Node): number => {
    const lines = headSub(n).length;
    return pen.lh.title + (lines === 0 ? 0 : 3 + pen.block("value", lines));
  };
  const nodeW = (n: Node): number =>
    Math.max(pen.w("title", n.name), pen.widest("value", headSub(n)), ...(n.rows ?? []).map(rowW)) + 2 * BOX_PAD;
  const nodeH = (n: Node): number => {
    const rows = n.rows ?? [];
    const body = rows.length === 0 ? 0 : 12 + rows.reduce((s, r) => s + rowH(r), 0) + ROW_GAP * (rows.length - 1);
    return BOX_PAD + headH(n) + body + BOX_PAD;
  };

  const colW = spec.columns.map((col) => Math.max(...col.map(nodeW)));
  const colH = spec.columns.map((col) => col.reduce((s, n) => s + nodeH(n), 0) + BOX_GAP * (col.length - 1));
  const tall = Math.max(...colH);

  // Where each end is: a box by its id, a row as `id.N`.
  const colOf = new Map<string, number>();
  spec.columns.forEach((col, c) => col.forEach((n) => colOf.set(n.id, c)));
  const idOf = (end: string): string => end.split(".")[0];

  // A gap is as wide as the widest label that rides an edge across it.
  const labelLines = spec.edges.map((e) => pen.wrap("value", e.label, 96));
  const gapW: number[] = spec.columns.slice(1).map(() => 60);
  spec.edges.forEach((e, i) => {
    const [a, b] = [colOf.get(idOf(e.from)) ?? 0, colOf.get(idOf(e.to)) ?? 0];
    if (Math.abs(a - b) !== 1 || labelLines[i].length === 0) return;
    const g = Math.min(a, b);
    gapW[g] = Math.max(gapW[g], pen.chipSize(labelLines[i]).w + 46);
  });

  const colX: number[] = [MARGIN];
  for (let c = 1; c < spec.columns.length; c++) colX.push(colX[c - 1] + colW[c - 1] + gapW[c - 1]);

  const boxes = new Map<string, Rect>();
  const rows = new Map<string, Rect>();
  spec.columns.forEach((col, c) => {
    let y = MARGIN + Math.round((tall - colH[c]) / 2);
    col.forEach((n) => {
      const h = nodeH(n);
      const box: Rect = { x: colX[c], y, w: colW[c], h };
      boxes.set(n.id, box);
      pen.box(box.x, box.y, box.w, box.h, 8, { fill: "surface", stroke: "ink-muted", strokeOpacity: 0.9, delay: c });
      const cx = Math.round(box.x + box.w / 2);
      const hasRows = (n.rows ?? []).length > 0;
      const ty = hasRows ? y + BOX_PAD : y + Math.round((h - headH(n)) / 2);
      pen.text(cx, ty, n.name, { role: "title", anchor: "middle", delay: c });
      pen.lines(cx, ty + pen.lh.title + 3, headSub(n), { fill: "ink-muted", anchor: "middle", delay: c });

      let ry = y + BOX_PAD + headH(n) + 12;
      (n.rows ?? []).forEach((r, j) => {
        const rect: Rect = { x: box.x + BOX_PAD, y: ry, w: box.w - 2 * BOX_PAD, h: rowH(r) };
        rows.set(`${n.id}.${j + 1}`, rect);
        pen.box(rect.x, rect.y, rect.w, rect.h, 5, {
          fill: r.lit ?? "surface",
          fillOpacity: r.lit === undefined ? 1 : 0.14,
          stroke: r.lit ?? "ink-muted",
          strokeOpacity: r.lit === undefined ? 0.3 : 0.9,
          delay: c,
        });
        const band1 = Math.max(pen.lh.label, DISC * 2);
        const lineY = rect.y + 8 + Math.round(band1 / 2);
        if (r.key !== undefined) pen.key(rect.x + 12 + DISC, lineY, r.key, c);
        const tx = rect.x + 12 + (r.key !== undefined ? KEY_LEAD : 0);
        pen.text(tx, lineY, r.name, { role: r.mono === true ? "mono" : "label", baseline: "middle", delay: c });
        pen.lines(tx, rect.y + 8 + band1 + LINE_GAP, rowSubs.get(r) ?? [], { fill: "ink-muted", delay: c });
        // A lit row carries its tone as a mark too, not as the colour of its text alone.
        if (r.lit !== undefined) pen.dot(rect.x + rect.w - 13, lineY, 4, r.lit, c);
        ry += rect.h + ROW_GAP;
      });
      y += h + BOX_GAP;
    });
  });

  const bottom = MARGIN + tall;
  const chips: (() => void)[] = [];
  const taken: { box: string; side: string; at: number }[] = [];
  /** A free place on one side of a box, as near `want` as the other edges leave room for. */
  const port = (box: string, side: string, want: number, lo: number, hi: number): number => {
    let at = Math.min(Math.max(want, lo), hi);
    const clash = (v: number): boolean => taken.some((t) => t.box === box && t.side === side && Math.abs(t.at - v) < 22);
    for (let k = 1; clash(at) && k < 8; k++) {
      const step = Math.ceil(k / 2) * 24 * (k % 2 === 1 ? 1 : -1);
      const tryAt = Math.min(Math.max(want + step, lo), hi);
      if (!clash(tryAt)) at = tryAt;
    }
    taken.push({ box, side, at });
    return at;
  };

  const lanes: number[] = spec.columns.slice(1).map(() => 0);
  const approach: number[] = spec.columns.slice(1).map(() => 0);
  let under = 0;
  spec.edges.forEach((e, i) => {
    const [sid, tid] = [idOf(e.from), idOf(e.to)];
    const [sb, tb] = [boxes.get(sid), boxes.get(tid)];
    if (sb === undefined || tb === undefined) return;
    const [sr, tr] = [rows.get(e.from), rows.get(e.to)];
    const [sc, tc] = [colOf.get(sid) ?? 0, colOf.get(tid) ?? 0];
    const colour: Colour = e.tone ?? "ink";
    const delay = spec.columns.length + i;
    const lines = labelLines[i];

    if (Math.abs(sc - tc) === 1) {
      // Neighbours: straight across the gap between them, forward or back.
      const dir = tc > sc ? 1 : -1;
      const g = Math.min(sc, tc);
      const sy = sr !== undefined ? Math.round(sr.y + sr.h / 2) : port(sid, dir > 0 ? "r" : "l", Math.round(sb.y + sb.h / 2), sb.y + 16, sb.y + sb.h - 16);
      const sx = sr !== undefined ? (dir > 0 ? sr.x + sr.w : sr.x) : dir > 0 ? sb.x + sb.w : sb.x;
      const ty = tr !== undefined ? Math.round(tr.y + tr.h / 2) : port(tid, dir > 0 ? "l" : "r", sy, tb.y + 16, tb.y + tb.h - 16);
      const tx = tr !== undefined ? (dir > 0 ? tr.x : tr.x + tr.w) : dir > 0 ? tb.x : tb.x + tb.w;
      const edgeS = dir > 0 ? sb.x + sb.w : sb.x;
      const edgeT = dir > 0 ? tb.x : tb.x + tb.w;
      let pts: Pt[];
      let run: [number, number];
      if (sy === ty) {
        pts = [[sx, sy], [tx, ty]];
        run = [edgeS, edgeT];
      } else {
        const lx = edgeS + dir * (18 + lanes[g] * 12);
        lanes[g]++;
        pts = [[sx, sy], [lx, sy], [lx, ty], [tx, ty]];
        run = [lx, edgeT];
      }
      pen.arrow(pts, { colour, dashed: e.dashed, delay });
      pen.dot(sx, sy, 3.5, colour, delay);
      if (lines.length > 0) chips.push(() => pen.chip(Math.round((run[0] + run[1]) / 2 - dir * 4), ty, lines, { colour: e.tone, delay }));
      return;
    }

    // Further apart: down, along a lane of its own under the boxes, and up.
    const laneY = bottom + 26 + under * 30;
    under++;
    const sx = port(sid, "b", Math.round(sb.x + sb.w / 2), sb.x + 20, sb.x + sb.w - 20);
    let tx: number;
    if (tr !== undefined && tc > sc) {
      // It ends at a row, so it comes up in the gap before that row's box and turns in.
      tx = tb.x - 16 - approach[tc - 1] * 12;
      approach[tc - 1]++;
      const ty = Math.round(tr.y + tr.h / 2);
      pen.arrow([[sx, sb.y + sb.h], [sx, laneY], [tx, laneY], [tx, ty], [tr.x, ty]], { colour, dashed: e.dashed, delay });
    } else {
      tx = port(tid, "b", Math.round(tb.x + tb.w / 2), tb.x + 20, tb.x + tb.w - 20);
      pen.arrow([[sx, sb.y + sb.h], [sx, laneY], [tx, laneY], [tx, tb.y + tb.h]], { colour, dashed: e.dashed, delay });
    }
    pen.dot(sx, sb.y + sb.h, 3.5, colour, delay);
    const one = e.label === undefined ? [] : [e.label];
    if (one.length > 0) chips.push(() => pen.chip(Math.round((sx + tx) / 2), laneY, one, { colour: e.tone, delay }));
  });
  // Labels last, so each one sits on its line and over any line passing behind.
  for (const draw of chips) draw();

  let y = bottom + (under > 0 ? 26 + (under - 1) * 30 + 22 : 0);
  let right = colX[colX.length - 1] + colW[colW.length - 1];
  if (spec.legend !== undefined && spec.legend.length > 0) {
    y += 16;
    let lx = MARGIN;
    const delay = spec.columns.length + spec.edges.length;
    for (const item of spec.legend) {
      pen.rule([lx, y + 7], [lx + 20, y + 7], item.tone, { width: EDGE, delay });
      pen.text(lx + 27, y + 7, item.text, { role: "value", fill: "ink-muted", baseline: "middle", delay });
      lx += 27 + pen.w("value", item.text) + 22;
    }
    right = Math.max(right, lx - 22);
    y += 14;
  }

  return pen.finish(right + MARGIN, y + MARGIN);
}

/* ---------------------------------------------------------------------------
 * states — a new form: a main line of states, side exits beneath, and every
 * transition that is not the next step carried over the top
 * ---------------------------------------------------------------------------*/

function layoutStates(spec: StatesPlusSpec, pen: Pen): Drawn {
  const H_PAD = 18;
  const LANE = 36;
  type State = StatesPlusSpec["states"][number];
  const byId = new Map(spec.states.map((s) => [s.id, s]));
  const main = spec.states.filter((s) => s.under === undefined);
  const mainAt = new Map(main.map((s, i) => [s.id, i]));
  const sideOf = (id: string): State | undefined => spec.states.find((s) => s.under === id);

  const subs = new Map(spec.states.map((s) => [s.id, pen.wrap("value", s.sub, 130)]));
  const sw = (s: State): number =>
    (s.key !== undefined ? KEY_LEAD : 0) + Math.max(pen.w("title", s.name), pen.widest("value", subs.get(s.id) ?? [])) + 2 * H_PAD;
  const subLines = Math.max(0, ...spec.states.map((s) => (subs.get(s.id) ?? []).length));
  const band1 = Math.max(pen.lh.title, DISC * 2);
  const SH = 12 + band1 + (subLines > 0 ? LINE_GAP + pen.block("value", subLines) : 0) + 12;

  // What each transition is, by where its two ends stand.
  type Kind = "step" | "over" | "drop" | "back" | "none";
  const kindOf = (t: StatesPlusSpec["transitions"][number]): Kind => {
    const [a, b] = [byId.get(t.from), byId.get(t.to)];
    if (a === undefined || b === undefined || a === b) return "none";
    const [i, j] = [mainAt.get(a.id), mainAt.get(b.id)];
    if (i !== undefined && j !== undefined) return j === i + 1 ? "step" : "over";
    if (i !== undefined && b.under === a.id) return "drop";
    if (j !== undefined && a.under !== undefined && a.under !== b.id) return "back";
    return "none";
  };
  const kinds = spec.transitions.map(kindOf);
  const labels = spec.transitions.map((t, k) => pen.wrap("value", t.label, kinds[k] === "over" ? 160 : 110));
  const chipW = (k: number): number => (labels[k].length === 0 ? 0 : pen.chipSize(labels[k]).w);

  // A column is as wide as the widest thing that stands in it.
  const colW = main.map((s) => {
    const side = sideOf(s.id);
    const drop = spec.transitions.findIndex((t, k) => kinds[k] === "drop" && t.from === s.id);
    return Math.max(sw(s), side === undefined ? 0 : sw(side), drop < 0 ? 0 : chipW(drop));
  });
  const cx: number[] = [MARGIN + 34 + colW[0] / 2];
  for (let i = 1; i < main.length; i++) {
    let gap = 56;
    spec.transitions.forEach((t, k) => {
      if (kinds[k] === "step" && mainAt.get(t.from) === i - 1) gap = Math.max(gap, chipW(k) + 46);
    });
    let between = Math.max(colW[i - 1] / 2 + colW[i] / 2 + 20, sw(main[i - 1]) / 2 + sw(main[i]) / 2 + gap);
    // A side state's way back to the next main state needs room for its label on the way.
    spec.transitions.forEach((t, k) => {
      if (kinds[k] !== "back") return;
      const from = byId.get(t.from);
      const [u, j] = [mainAt.get(from?.under ?? ""), mainAt.get(t.to)];
      if (from === undefined || u === undefined || j === undefined) return;
      if (Math.min(u, j) === i - 1 && Math.max(u, j) === i) between = Math.max(between, sw(from) / 2 + chipW(k) + 40);
    });
    cx.push(Math.round(cx[i - 1] + between));
  }
  cx[0] = Math.round(cx[0]);

  const overs = kinds.filter((k) => k === "over").length;
  const mainY = MARGIN + (overs > 0 ? 24 + 30 + (overs - 1) * LANE : 0);
  const sideY = mainY + SH + 66;
  const hasSide = spec.states.some((s) => s.under !== undefined);

  const rects = new Map<string, Rect>();
  const draw = (s: State, mid: number, y: number, delay: number): void => {
    const w = sw(s);
    const r: Rect = { x: Math.round(mid - w / 2), y, w, h: SH };
    rects.set(s.id, r);
    pen.box(r.x, r.y, r.w, r.h, Math.min(SH / 2, 18), {
      fill: s.tone ?? "surface",
      fillOpacity: s.tone === undefined ? 1 : 0.16,
      stroke: s.tone ?? "ink-muted",
      strokeOpacity: 0.9,
      delay,
    });
    // A state nothing leaves wears a second outline.
    if (s.end === true) pen.box(r.x + 4, r.y + 4, r.w - 8, r.h - 8, Math.min(SH / 2, 18) - 4, { stroke: s.tone ?? "ink-muted", strokeOpacity: 0.6, delay });
    const lines = subs.get(s.id) ?? [];
    const textH = band1 + (lines.length > 0 ? LINE_GAP + pen.block("value", lines.length) : 0);
    const top = y + Math.round((SH - textH) / 2);
    const lineY = top + Math.round(band1 / 2);
    const groupW = (s.key !== undefined ? KEY_LEAD : 0) + pen.w("title", s.name);
    const left = Math.round(mid - groupW / 2);
    if (s.key !== undefined) pen.key(left + DISC, lineY, s.key, delay);
    pen.text(left + (s.key !== undefined ? KEY_LEAD : 0), lineY, s.name, { role: "title", baseline: "middle", delay });
    pen.lines(mid, top + band1 + LINE_GAP, lines, { fill: "ink-muted", anchor: "middle", delay });
  };
  main.forEach((s, i) => {
    draw(s, cx[i], mainY, i);
    const side = sideOf(s.id);
    if (side !== undefined) draw(side, cx[i], sideY, i + 1);
  });

  // Where it begins: a dot, and an arrow into the first state.
  const first = rects.get(spec.start);
  if (first !== undefined) {
    const my = Math.round(first.y + first.h / 2);
    pen.dot(first.x - 28, my, 5, "ink", 0);
    pen.arrow([[first.x - 23, my], [first.x, my]], { delay: 0 });
  }

  const taken: { id: string; side: string; at: number }[] = [];
  const port = (id: string, side: string, want: number, r: Rect): number => {
    const [lo, hi] = [r.x + 20, r.x + r.w - 20];
    const clash = (v: number): boolean => taken.some((t) => t.id === id && t.side === side && Math.abs(t.at - v) < 22);
    let at = Math.min(Math.max(want, lo), hi);
    for (let k = 1; clash(at) && k < 8; k++) {
      const tryAt = Math.min(Math.max(want + Math.ceil(k / 2) * 24 * (k % 2 === 1 ? 1 : -1), lo), hi);
      if (!clash(tryAt)) at = tryAt;
    }
    taken.push({ id, side, at });
    return at;
  };

  const chips: (() => void)[] = [];
  let lane = 0;
  spec.transitions.forEach((t, k) => {
    const [a, b] = [rects.get(t.from), rects.get(t.to)];
    if (a === undefined || b === undefined || kinds[k] === "none") return;
    const colour: Colour = t.tone ?? "ink";
    const delay = main.length + k;
    const o = { colour, dashed: t.dashed, delay };
    const chip = (x: number, y: number): void => {
      if (labels[k].length > 0) chips.push(() => pen.chip(Math.round(x), Math.round(y), labels[k], { colour: t.tone, delay }));
    };
    const [amid, bmid] = [Math.round(a.x + a.w / 2), Math.round(b.x + b.w / 2)];
    if (kinds[k] === "step") {
      const y = Math.round(a.y + a.h / 2);
      pen.arrow([[a.x + a.w, y], [b.x, y]], o);
      pen.dot(a.x + a.w, y, 3.5, colour, delay);
      chip((a.x + a.w + b.x) / 2 - 4, y);
    } else if (kinds[k] === "over") {
      const y = mainY - 30 - lane * LANE;
      lane++;
      // Each end leans toward the other, so the lane is as short as it can be.
      const lean = bmid > amid ? 1 : -1;
      const sx = port(t.from, "t", amid + lean * 14, a);
      const tx = port(t.to, "t", bmid - lean * 14, b);
      pen.arrow([[sx, a.y], [sx, y], [tx, y], [tx, b.y]], o);
      pen.dot(sx, a.y, 3.5, colour, delay);
      chip((sx + tx) / 2, y);
    } else if (kinds[k] === "drop") {
      const x = port(t.from, "b", amid, a);
      pen.arrow([[x, a.y + a.h], [x, b.y]], o);
      pen.dot(x, a.y + a.h, 3.5, colour, delay);
      chip(x, (a.y + a.h + b.y) / 2 - 4);
    } else {
      const dir = bmid > amid ? 1 : -1;
      const sx = dir > 0 ? a.x + a.w : a.x;
      const y = Math.round(a.y + a.h / 2);
      const tx = port(t.to, "b", bmid, b);
      pen.arrow([[sx, y], [tx, y], [tx, b.y + b.h]], o);
      pen.dot(sx, y, 3.5, colour, delay);
      chip((sx + tx) / 2, y);
    }
  });
  for (const drawChip of chips) drawChip();

  // A wide chip may reach past the first state; the whole figure moves right to keep it in.
  const dx = Math.max(0, MARGIN - pen.reach[0]);
  return pen.finish(pen.reach[1] + dx + MARGIN, (hasSide ? sideY : mainY) + SH + MARGIN, dx);
}

/* ---------------------------------------------------------------------------
 * tree — a new form: what is inside what, root at the left, a column per
 * depth, a parent centred on its children
 * ---------------------------------------------------------------------------*/

function layoutTree(spec: TreePlusSpec, pen: Pen): Drawn {
  const V_GAP = 8;
  const H_GAP = 44;
  const sizes = new Map<TreeNode, { w: number; h: number }>();
  const colW: number[] = [];
  const role = (n: TreeNode, d: number): ChartTypeRole => (n.mono === true ? "mono" : d === 0 ? "title" : "label");
  const measure = (n: TreeNode, d: number): void => {
    const w = (n.key !== undefined ? KEY_LEAD : 0) + Math.max(pen.w(role(n, d), n.name), pen.w("value", n.sub)) + 24;
    const h = 14 + Math.max(pen.lh.label, DISC * 2) + (n.sub === undefined ? 0 : LINE_GAP + pen.lh.value);
    sizes.set(n, { w, h });
    colW[d] = Math.max(colW[d] ?? 0, w);
    for (const c of n.children ?? []) measure(c, d + 1);
  };
  measure(spec.root, 0);
  const colX: number[] = [MARGIN];
  for (let d = 1; d < colW.length; d++) colX.push(colX[d - 1] + colW[d - 1] + H_GAP);

  const kidsH = (n: TreeNode): number => {
    const kids = n.children ?? [];
    return kids.reduce((s, c) => s + extent(c), 0) + V_GAP * Math.max(0, kids.length - 1);
  };
  const extent = (n: TreeNode): number => Math.max(sizes.get(n)?.h ?? 0, kidsH(n));

  /** Draws `n` and all beneath it from `top` down, and returns the y of its middle. */
  const place = (n: TreeNode, d: number, top: number): number => {
    const { h } = sizes.get(n) ?? { h: 0 };
    const ext = extent(n);
    const y = Math.round(top + (ext - h) / 2);
    const mid = Math.round(y + h / 2);
    const x = colX[d];
    const delay = d;

    let ky = top + (ext - kidsH(n)) / 2;
    for (const c of n.children ?? []) {
      const cmid = place(c, d + 1, ky);
      const lx = x + colW[d] + H_GAP / 2;
      const pts: Pt[] = cmid === mid ? [[x + colW[d], mid], [colX[d + 1], cmid]] : [[x + colW[d], mid], [lx, mid], [lx, cmid], [colX[d + 1], cmid]];
      pen.arrow(pts, { colour: c.tone ?? "ink-muted", width: 1.5, bare: true, delay: d + 1 });
      ky += extent(c) + V_GAP;
    }

    pen.box(x, y, colW[d], h, 6, {
      fill: n.tone ?? "surface",
      fillOpacity: n.tone === undefined ? 1 : 0.16,
      stroke: n.tone ?? "ink-muted",
      strokeOpacity: (n.children ?? []).length > 0 ? 0.9 : 0.4,
      delay,
    });
    const band1 = Math.max(pen.lh.label, DISC * 2);
    const lineY = y + 7 + Math.round(band1 / 2);
    if (n.key !== undefined) pen.key(x + 12 + DISC, lineY, n.key, delay);
    const tx = x + 12 + (n.key !== undefined ? KEY_LEAD : 0);
    pen.text(tx, lineY, n.name, { role: role(n, d), baseline: "middle", delay });
    if (n.sub !== undefined) pen.text(tx, y + 7 + band1 + LINE_GAP, n.sub, { role: "value", fill: "ink-muted", delay });
    return mid;
  };
  place(spec.root, 0, MARGIN);

  return pen.finish(colX[colX.length - 1] + colW[colW.length - 1] + MARGIN, MARGIN + extent(spec.root) + MARGIN);
}

/** Lays out one spec with the proposed looks. */
export function layoutPlus(spec: PlusSpec, motion: boolean, measure: Measure, ink: Ink): Drawn {
  const pen = new Pen(motion, measure, ink);
  switch (spec.form) {
    case "layers":
      return layoutLayers(spec, pen);
    case "stack":
      return layoutStack(spec, pen);
    case "sequence":
      return layoutSequence(spec, pen);
    case "flow":
      return layoutFlow(spec, pen);
    case "states":
      return layoutStates(spec, pen);
    case "tree":
      return layoutTree(spec, pen);
  }
}
