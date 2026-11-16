/**
 * spike-code-explainer-layout.ts — a prototype of the three diagram forms.
 *
 * Each form is one function from a spec and a measurer to a layer 0
 * `tugdraw` program, the same contract a chart form has in
 * `tuggraphics/src/chart/forms/`. It is written in TypeScript only so the
 * spike can be iterated on without a WASM build; nothing here is meant to
 * ship, and what survives is ported to Rust beside the chart forms.
 *
 * The rule every form keeps: the author gives names, relations and order,
 * and the form gives every coordinate. A spec has no x and no y.
 *
 * @module spikes/spike-code-explainer-layout
 */

import type { ChartTypeRole, TextBox } from "@/lib/lazy/load-tuggraphics";

/* ---------------------------------------------------------------------------
 * Specs
 * ---------------------------------------------------------------------------*/

/** What an edge or a lit row means. `ink` means nothing in particular. */
export type Tone = "ink" | "good" | "bad" | "accent";

/** A row of the keyed table under a figure. */
export interface Keyed {
  /** The number the figure shows; a keyed item gets a table row. */
  key?: number;
  /** What it does, for the table. */
  does?: string;
  /** Where it is in the code, for the table. */
  where?: string;
}

export interface FlowRow extends Keyed {
  name: string;
  sub?: string;
  /** Set in the mono face: an identifier, a path, a key. */
  mono?: boolean;
  /** Fills the row in a tone, as the target of an outcome. */
  lit?: Tone;
}

export interface FlowNode {
  id: string;
  name: string;
  sub?: string;
  rows?: FlowRow[];
  /** Small lines beneath the box. */
  notes?: string[];
}

export interface FlowEdge {
  /** A node id, or `id.n` for that node's n-th row, 1-based. */
  from: string;
  to: string;
  tone?: Tone;
  label?: string;
  dashed?: boolean;
}

export interface FlowSpec {
  form: "flow";
  /** Columns left to right, each a stack of nodes top to bottom. */
  columns: FlowNode[][];
  edges: FlowEdge[];
}

export interface SeqActor {
  id: string;
  name: string;
  sub?: string;
}

export interface SeqMessage extends Keyed {
  from: string;
  /** The same actor as `from` for a step the actor takes alone. */
  to: string;
  label: string;
  tone?: Tone;
  /** An answer coming back: dashed and muted. */
  reply?: boolean;
}

export interface SequenceSpec {
  form: "sequence";
  actors: SeqActor[];
  messages: SeqMessage[];
}

export interface LayerCell extends Keyed {
  name: string;
  sub?: string;
  mono?: boolean;
}

export interface Layer {
  name: string;
  sub?: string;
  cells: LayerCell[];
  /** What crosses the boundary to the layer beneath. */
  below?: string;
}

export interface LayersSpec {
  form: "layers";
  /** Top to bottom. */
  layers: Layer[];
}

export type DiagramSpec = FlowSpec | SequenceSpec | LayersSpec;

/* ---------------------------------------------------------------------------
 * Look
 * ---------------------------------------------------------------------------*/

export type Routing = "elbow" | "rounded" | "curve";

export interface Look {
  routing: Routing;
  fill: "tinted" | "plain";
  keys: "inline" | "disc";
  motion: boolean;
}

export type Measure = (role: ChartTypeRole, text: string) => TextBox;

export interface Drawn {
  /** The layer 0 program, as source. */
  program: string;
  width: number;
  height: number;
  ops: number;
  /** How many times two edges cross. A form would refuse a figure over a bar. */
  crossings: number;
}

/** The keyed rows of a spec, in key order. */
export function legendOf(spec: DiagramSpec): { key: number; name: string; does: string; where: string }[] {
  const out: { key: number; name: string; does: string; where: string }[] = [];
  const take = (name: string, k: Keyed): void => {
    if (k.key !== undefined) out.push({ key: k.key, name, does: k.does ?? "", where: k.where ?? "" });
  };
  if (spec.form === "flow") {
    for (const col of spec.columns) for (const node of col) for (const row of node.rows ?? []) take(row.name, row);
  } else if (spec.form === "sequence") {
    for (const m of spec.messages) take(m.label, m);
  } else {
    for (const layer of spec.layers) for (const cell of layer.cells) take(cell.name, cell);
  }
  return out.sort((a, b) => a.key - b.key);
}

/* ---------------------------------------------------------------------------
 * The pen: layer 0 ops, nothing else
 * ---------------------------------------------------------------------------*/

type Colour = "ink" | "ink-muted" | "grid" | "surface" | "accent" | "good" | "bad";
type Op = (string | number | number[] | Record<string, unknown>)[];
type Pt = [number, number];

const MAX_DELAY = 64;
const MAX_STRING = 200;

function toneColour(tone: Tone | undefined): Colour {
  return tone === undefined || tone === "ink" ? "ink-muted" : tone;
}

interface TextOpts {
  role?: ChartTypeRole;
  fill?: Colour;
  anchor?: "start" | "middle" | "end";
  baseline?: "top" | "middle" | "alphabetic" | "bottom";
  delay?: number;
}

class Pen {
  readonly ops: Op[] = [];

  constructor(private readonly motion: boolean) {}

  private enter(kind: "fade" | "draw", delay: number | undefined): Record<string, unknown> | undefined {
    if (!this.motion || delay === undefined) return undefined;
    return { enter: kind, delay: Math.min(Math.max(0, Math.round(delay)), MAX_DELAY) };
  }

  private paint(verb: "fill" | "stroke", colour: Colour, opacity: number, opts?: Record<string, unknown>): void {
    this.ops.push(["opacity", opacity]);
    this.ops.push(opts === undefined ? [verb, colour] : [verb, colour, opts]);
  }

  /** A rounded box, filled and then outlined. */
  box(
    x: number, y: number, w: number, h: number, r: number,
    o: { fill?: Colour; fillOpacity?: number; stroke?: Colour; strokeOpacity?: number; delay?: number },
  ): void {
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

  disc(cx: number, cy: number, r: number, fill: Colour, delay?: number): void {
    this.ops.push(["circle", cx, cy, r]);
    this.paint("fill", fill, 1, this.enter("fade", delay));
  }

  text(x: number, y: number, s: string, o: TextOpts = {}): void {
    const opts: Record<string, unknown> = {
      role: o.role ?? "label",
      fill: o.fill ?? "ink",
      anchor: o.anchor ?? "start",
      baseline: o.baseline ?? "top",
      ...this.enter("fade", o.delay),
    };
    this.ops.push(["opacity", 1]);
    this.ops.push(["text", x, y, s.length > MAX_STRING ? s.slice(0, MAX_STRING - 1) + "…" : s, opts]);
  }

  /** A straight segment in a colour, for rules and lifelines. */
  rule(a: Pt, b: Pt, colour: Colour, o: { dash?: number[]; width?: number; opacity?: number; delay?: number } = {}): void {
    this.ops.push(["width", o.width ?? 1]);
    if (o.dash !== undefined) this.ops.push(["dash", o.dash]);
    this.ops.push(["move", a[0], a[1]], ["line", b[0], b[1]]);
    this.paint("stroke", colour, o.opacity ?? 1, this.enter("fade", o.delay));
    if (o.dash !== undefined) this.ops.push(["dash", []]);
  }

  /**
   * An edge along `pts`, ending in an arrowhead. Consecutive points differ
   * on one axis only, except under `curve`, which joins the two ends of a
   * forward edge with one cubic.
   */
  edge(
    pts: Pt[],
    o: { colour: Colour; routing: Routing; dashed?: boolean; delay?: number; headAtStart?: boolean; sigmoid?: boolean },
  ): void {
    const HEAD = 8;
    const HALF = 4;
    const n = pts.length;
    const tip = pts[n - 1];
    const before = pts[n - 2];
    const d = unit(before, tip);
    const base: Pt = [tip[0] - d[0] * HEAD, tip[1] - d[1] * HEAD];
    const line = pts.slice(0, n - 1).concat([base]);
    let first = line[0];
    if (o.headAtStart === true) {
      const d0 = unit(line[1], line[0]);
      first = [line[0][0] - d0[0] * HEAD, line[0][1] - d0[1] * HEAD];
      this.head(line[0], d0, HEAD, HALF, o.colour, o.delay);
      line[0] = first;
    }

    this.ops.push(["width", 1.5]);
    if (o.dashed === true) this.ops.push(["dash", [5, 4]]);
    this.ops.push(["move", first[0], first[1]]);
    if (o.routing === "curve" && o.sigmoid === true) {
      const end = line[line.length - 1];
      const dx = (end[0] - first[0]) / 2;
      this.ops.push(["curve", first[0] + dx, first[1], end[0] - dx, end[1], end[0], end[1]]);
    } else if (o.routing === "elbow") {
      for (const p of line.slice(1)) this.ops.push(["line", p[0], p[1]]);
    } else {
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
    }
    // A dashed stroke cannot draw itself along its length: the entrance owns the dash.
    const enter = this.enter(o.dashed === true ? "fade" : "draw", o.delay);
    this.paint("stroke", o.colour, 1, { join: "round", cap: "butt", ...enter });
    if (o.dashed === true) this.ops.push(["dash", []]);
    this.head(tip, d, HEAD, HALF, o.colour, o.delay);
  }

  private head(tip: Pt, d: Pt, len: number, half: number, colour: Colour, delay: number | undefined): void {
    const bx = tip[0] - d[0] * len;
    const by = tip[1] - d[1] * len;
    this.ops.push(["move", tip[0], tip[1]]);
    this.ops.push(["line", bx - d[1] * half, by + d[0] * half]);
    this.ops.push(["line", bx + d[1] * half, by - d[0] * half]);
    this.ops.push(["close"]);
    this.paint("fill", colour, 1, this.enter("fade", delay));
  }

  finish(width: number, height: number, crossings: number): Drawn {
    const w = Math.ceil(width);
    const h = Math.ceil(height);
    // Half a pixel, so a 1px stroke on an integer coordinate lands on one row of pixels.
    const ops: Op[] = [["group", { translate: [0.5, 0.5] }], ...this.ops, ["end"]];
    return {
      program: JSON.stringify({ tugdraw: 1, frame: [w + 1, h + 1], ops }),
      width: w + 1,
      height: h + 1,
      ops: ops.length,
      crossings,
    };
  }
}

function unit(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** A role's line height: the font box of a string with an ascender and a descender. */
function lineHeights(measure: Measure): Record<ChartTypeRole, number> {
  const lh = (role: ChartTypeRole): number => {
    const m = measure(role, "Hg");
    return Math.ceil(m.a + m.d);
  };
  return { title: lh("title"), label: lh("label"), value: lh("value"), mono: lh("mono") };
}

/** How many times the axis-aligned runs of different edges cross. */
function countCrossings(paths: Pt[][]): number {
  type Run = { edge: number; a: Pt; b: Pt };
  const runs: Run[] = [];
  paths.forEach((pts, edge) => {
    for (let i = 1; i < pts.length; i++) runs.push({ edge, a: pts[i - 1], b: pts[i] });
  });
  let count = 0;
  for (const h of runs) {
    if (h.a[1] !== h.b[1]) continue;
    const [hx0, hx1] = [Math.min(h.a[0], h.b[0]), Math.max(h.a[0], h.b[0])];
    for (const v of runs) {
      if (v.edge === h.edge || v.a[0] !== v.b[0]) continue;
      const [vy0, vy1] = [Math.min(v.a[1], v.b[1]), Math.max(v.a[1], v.b[1])];
      if (v.a[0] > hx0 && v.a[0] < hx1 && h.a[1] > vy0 && h.a[1] < vy1) count++;
    }
  }
  return count;
}

/* ---------------------------------------------------------------------------
 * flow — columns of boxes, a box may hold rows, edges route themselves
 * ---------------------------------------------------------------------------*/

const MARGIN = 16;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlacedNode extends Rect {
  node: FlowNode;
  col: number;
  rows: Rect[];
  /** The height the node takes in its column: the box and its notes. */
  slot: number;
}

interface End {
  node: PlacedNode;
  rect: Rect;
  /** True when the end is a row, whose height an edge must meet. */
  fixed: boolean;
}

export function layoutFlow(spec: FlowSpec, look: Look, measure: Measure): Drawn {
  const pen = new Pen(look.motion);
  const lh = lineHeights(measure);
  const PAD = 14;
  const INSET = 12;
  const ROW_PAD_X = 10;
  const ROW_PAD_Y = 7;
  const ROW_GAP = 8;
  const NODE_GAP = 28;
  const DISC = 8;
  const disc = look.keys === "disc";

  const rowName = (row: FlowRow): string =>
    !disc && row.key !== undefined ? `${row.key}  ${row.name}` : row.name;
  const rowRole = (row: FlowRow): ChartTypeRole => (row.mono === true ? "mono" : "label");
  const rowLead = (row: FlowRow): number => (disc && row.key !== undefined ? DISC * 2 + 7 : 0);
  const w = (role: ChartTypeRole, s: string | undefined): number => (s === undefined ? 0 : Math.ceil(measure(role, s).w));

  // Sizes: every box from its text, then every box stretched to its column.
  const sized = spec.columns.map((col, c) =>
    col.map((node) => {
      const rows = node.rows ?? [];
      const head = Math.max(w("title", node.name), w("value", node.sub));
      const headH = lh.title + (node.sub !== undefined ? 3 + lh.value : 0);
      const rowSizes = rows.map((row) => ({
        w: rowLead(row) + Math.max(w(rowRole(row), rowName(row)), w("value", row.sub)) + 2 * ROW_PAD_X,
        h: 2 * ROW_PAD_Y + lh[rowRole(row)] + (row.sub !== undefined ? 2 + lh.value : 0),
      }));
      const noteW = Math.max(0, ...(node.notes ?? []).map((n) => w("value", n)));
      const leaf = rows.length === 0;
      const width = leaf
        ? Math.max(96, head + 2 * PAD)
        : Math.max(head + 2 * PAD, Math.max(...rowSizes.map((r) => r.w)) + 2 * INSET);
      const height = leaf
        ? headH + 2 * (PAD - 3)
        : PAD - 2 + headH + 10 + rowSizes.reduce((s, r) => s + r.h, 0) + ROW_GAP * (rows.length - 1) + INSET;
      const notesH = (node.notes?.length ?? 0) > 0 ? 8 + (node.notes ?? []).length * (lh.value + 2) : 0;
      return { node, col: c, width: Math.max(width, noteW), box: width, height, headH, rowSizes, notesH };
    }),
  );
  const colW = sized.map((col) => Math.max(...col.map((n) => n.width)));
  const colH = sized.map((col) => col.reduce((s, n) => s + n.height + n.notesH, 0) + NODE_GAP * (col.length - 1));
  const contentH = Math.max(...colH);

  // Vertical placement is independent of x, so ends and their heights are known before any gap is sized.
  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  sized.forEach((col, c) => {
    let y = MARGIN + Math.round((contentH - colH[c]) / 2);
    for (const s of col) {
      const rows: Rect[] = [];
      let ry = y + PAD - 2 + s.headH + 10;
      for (const size of s.rowSizes) {
        rows.push({ x: INSET, y: ry, w: colW[c] - 2 * INSET, h: size.h });
        ry += size.h + ROW_GAP;
      }
      const p: PlacedNode = { node: s.node, col: c, x: 0, y, w: colW[c], h: s.height, rows, slot: s.height + s.notesH };
      placed.push(p);
      byId.set(s.node.id, p);
      y += p.slot + NODE_GAP;
    }
  });

  const endOf = (ref: string): End => {
    const [id, n] = ref.split(".");
    const node = byId.get(id);
    if (node === undefined) throw new Error(`flow: no node "${id}"`);
    if (n === undefined) return { node, rect: node, fixed: false };
    const row = node.rows[Number(n) - 1];
    if (row === undefined) throw new Error(`flow: node "${id}" has no row ${n}`);
    return { node, rect: row, fixed: true };
  };

  // Each edge: its kind, and the heights it leaves and arrives at.
  type Kind = "forward" | "stack" | "outer";
  interface Routed {
    edge: FlowEdge;
    from: End;
    to: End;
    kind: Kind;
    y1: number;
    y2: number;
    labelW: number;
    lane: number;
  }
  const mid = (r: Rect): number => Math.round(r.y + r.h / 2);
  const clamp = (v: number, r: Rect): number => Math.min(Math.max(v, r.y + 12), r.y + r.h - 12);
  const taken = new Map<string, number[]>();
  const settle = (node: PlacedNode, side: string, y: number, fixed: boolean): number => {
    const key = `${node.node.id}:${side}`;
    const used = taken.get(key) ?? [];
    let at = y;
    if (!fixed) while (used.some((u) => Math.abs(u - at) < 10)) at += 12;
    used.push(at);
    taken.set(key, used);
    return at;
  };
  const routed: Routed[] = spec.edges.map((edge) => {
    const from = endOf(edge.from);
    const to = endOf(edge.to);
    const kind: Kind =
      to.node.col === from.node.col + 1 ? "forward" : to.node.col === from.node.col && from.node !== to.node ? "stack" : "outer";
    let y1 = mid(from.rect);
    let y2 = mid(to.rect);
    if (kind === "forward") {
      // A straight edge wherever one end is free to meet the other.
      if (from.fixed && !to.fixed) y2 = clamp(y1, to.rect);
      else if (!from.fixed && to.fixed) y1 = clamp(y2, from.rect);
      else if (!from.fixed && !to.fixed) {
        y2 = clamp(y1, to.rect);
        y1 = clamp(y2, from.rect);
      }
      const shift = settle(from.node, "right", y1, from.fixed) - y1;
      y1 += shift;
      if (!to.fixed && y2 + shift === clamp(y2 + shift, to.rect)) y2 += shift;
      y2 = settle(to.node, "left", y2, to.fixed);
    } else if (kind === "outer") {
      y1 = settle(from.node, "right", y1, from.fixed);
    }
    return { edge, from, to, kind, y1, y2, labelW: w("value", edge.label), lane: 0 };
  });

  // Gaps: gap g is right of column g; the last is the right margin an outer edge turns in.
  const cols = spec.columns.length;
  const gapLanes: Routed[][] = Array.from({ length: cols }, () => []);
  for (const r of routed) {
    if (r.kind === "outer") gapLanes[r.from.node.col].push(r);
  }
  for (const r of routed) {
    if (r.kind === "forward" && r.y1 !== r.y2) gapLanes[r.from.node.col].push(r);
  }
  gapLanes.forEach((lanes) => lanes.forEach((r, k) => (r.lane = k)));
  const LANE0 = 18;
  const LANE = 12;
  const gapW = gapLanes.map((lanes, g) => {
    const turn = lanes.length > 0 ? LANE0 + LANE * (lanes.length - 1) : 0;
    if (g === cols - 1) return turn > 0 ? turn + 10 : 0;
    let need = Math.max(52, turn + 22);
    for (const r of routed) {
      if (r.kind !== "forward" || r.from.node.col !== g || r.labelW === 0) continue;
      need = Math.max(need, r.y1 === r.y2 ? r.labelW + 30 : LANE0 + LANE * r.lane + r.labelW + 26);
    }
    return need;
  });

  // Now x.
  const colX: number[] = [];
  let x = MARGIN;
  for (let c = 0; c < cols; c++) {
    colX.push(x);
    x += colW[c] + gapW[c];
  }
  const right = x;
  for (const p of placed) {
    p.x = colX[p.col];
    for (const row of p.rows) row.x += p.x;
  }

  const outer = routed.filter((r) => r.kind === "outer");
  const bottom = MARGIN + contentH;
  const CHANNEL0 = 20;
  const CHANNEL = 14;

  // Boxes.
  for (const p of placed) {
    const { node } = p;
    const leaf = p.rows.length === 0;
    const tinted = look.fill === "tinted" && !leaf;
    pen.box(p.x, p.y, p.w, p.h, 8, {
      fill: tinted ? "accent" : "surface",
      fillOpacity: tinted ? 0.07 : 1,
      stroke: tinted ? "accent" : "ink-muted",
      strokeOpacity: tinted ? 0.75 : 0.9,
      delay: p.col,
    });
    const cx = p.x + Math.round(p.w / 2);
    const headY = leaf ? p.y + PAD - 3 : p.y + PAD - 2;
    pen.text(cx, headY, node.name, { role: "title", anchor: "middle", delay: p.col });
    if (node.sub !== undefined) {
      pen.text(cx, headY + lh.title + 3, node.sub, { role: "value", fill: "ink-muted", anchor: "middle", delay: p.col });
    }
    (node.rows ?? []).forEach((row, i) => {
      const r = p.rows[i];
      const lit = row.lit !== undefined ? toneColour(row.lit) : undefined;
      pen.box(r.x, r.y, r.w, r.h, 5, { fill: "surface", stroke: lit ?? "grid", delay: p.col });
      if (lit !== undefined) pen.box(r.x, r.y, r.w, r.h, 5, { fill: lit, fillOpacity: 0.14, delay: p.col });
      const lead = rowLead(row);
      if (lead > 0 && row.key !== undefined) {
        const cy = r.y + Math.round(r.h / 2);
        pen.disc(r.x + ROW_PAD_X + DISC, cy, DISC, "accent", p.col);
        pen.text(r.x + ROW_PAD_X + DISC, cy, String(row.key), {
          role: "value", fill: "surface", anchor: "middle", baseline: "middle", delay: p.col,
        });
      }
      const tx = r.x + ROW_PAD_X + lead;
      const keyed = row.key !== undefined && row.mono !== true;
      if (row.sub === undefined) {
        // One line sits on the row's middle, whatever the face's own box is.
        pen.text(tx, r.y + Math.round(r.h / 2), rowName(row), {
          role: rowRole(row), fill: keyed ? "accent" : "ink", baseline: "middle", delay: p.col,
        });
      } else {
        pen.text(tx, r.y + ROW_PAD_Y, rowName(row), { role: rowRole(row), fill: keyed ? "accent" : "ink", delay: p.col });
      }
      if (row.sub !== undefined) {
        pen.text(tx, r.y + ROW_PAD_Y + lh[rowRole(row)] + 2, row.sub, { role: "value", fill: "ink-muted", delay: p.col });
      }
    });
    (node.notes ?? []).forEach((note, i) => {
      pen.text(cx, p.y + p.h + 8 + i * (lh.value + 2), note, { role: "value", fill: "ink-muted", anchor: "middle", delay: p.col });
    });
  }

  // Edges, over the boxes.
  const paths: Pt[][] = [];
  const landings = new Map<string, number>();
  let labelBottom = bottom;
  let labelRight = right;
  routed.forEach((r, i) => {
    const colour = toneColour(r.edge.tone);
    const delay = cols + i;
    const x1 = r.from.rect.x + r.from.rect.w;
    let pts: Pt[];
    if (r.kind === "forward") {
      const x2 = r.to.rect.x;
      const lane = colX[r.from.node.col] + colW[r.from.node.col] + LANE0 + LANE * r.lane;
      pts = r.y1 === r.y2 ? [[x1, r.y1], [x2, r.y2]] : [[x1, r.y1], [lane, r.y1], [lane, r.y2], [x2, r.y2]];
      if (r.edge.label !== undefined) {
        const a = pts[pts.length - 2];
        pen.text(Math.round((a[0] + x2 - 8) / 2), r.y2 - 5, r.edge.label, {
          role: "value", fill: colour, anchor: "middle", baseline: "bottom", delay,
        });
      }
    } else if (r.kind === "stack") {
      const down = r.to.node.y > r.from.node.y;
      const cx = r.from.node.x + Math.round(r.from.node.w / 2);
      pts = down
        ? [[cx, r.from.node.y + r.from.node.h], [cx, r.to.node.y]]
        : [[cx, r.from.node.y], [cx, r.to.node.y + r.to.node.h]];
      if (r.edge.label !== undefined) {
        pen.text(cx + 8, Math.round((pts[0][1] + pts[1][1]) / 2), r.edge.label, {
          role: "value", fill: colour, baseline: "middle", delay,
        });
      }
    } else {
      // Out to the right, down past everything, back under, and up into the target.
      const k = outer.indexOf(r);
      const lane = colX[r.from.node.col] + colW[r.from.node.col] + LANE0 + LANE * r.lane;
      const channel = bottom + CHANNEL0 + CHANNEL * k;
      const id = r.to.node.node.id;
      const n = landings.get(id) ?? 0;
      landings.set(id, n + 1);
      const tx = r.to.node.x + Math.round(r.to.node.w / 2) + n * 14;
      pts = [[x1, r.y1], [lane, r.y1], [lane, channel], [tx, channel], [tx, r.to.node.y + r.to.node.h]];
      if (r.edge.label !== undefined) {
        const lx = Math.round((lane + tx) / 2);
        const ly = bottom + CHANNEL0 + CHANNEL * (outer.length - 1) + 6;
        pen.text(lx, ly, r.edge.label, { role: "value", fill: colour, anchor: "middle", delay });
        labelBottom = Math.max(labelBottom, ly + lh.value);
        labelRight = Math.max(labelRight, lx + r.labelW / 2 + MARGIN);
      } else {
        labelBottom = Math.max(labelBottom, channel + 4);
      }
    }
    paths.push(pts);
    pen.edge(pts, { colour, routing: look.routing, dashed: r.edge.dashed, delay, sigmoid: r.kind === "forward" });
  });

  return pen.finish(Math.max(right, labelRight) + (gapW[cols - 1] === 0 ? MARGIN : 0), labelBottom + MARGIN, countCrossings(paths));
}

/* ---------------------------------------------------------------------------
 * sequence — actors across, messages down
 * ---------------------------------------------------------------------------*/

export function layoutSequence(spec: SequenceSpec, look: Look, measure: Measure): Drawn {
  const pen = new Pen(look.motion);
  const lh = lineHeights(measure);
  const w = (role: ChartTypeRole, s: string | undefined): number => (s === undefined ? 0 : Math.ceil(measure(role, s).w));
  const DISC = 8;
  const disc = look.keys === "disc";
  const anyKey = spec.messages.some((m) => m.key !== undefined);
  const gutter = disc && anyKey ? DISC * 2 + 12 : 0;
  const text = (m: SeqMessage): string => (!disc && m.key !== undefined ? `${m.key}  ${m.label}` : m.label);

  const index = new Map(spec.actors.map((a, i) => [a.id, i]));
  const at = (id: string): number => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`sequence: no actor "${id}"`);
    return i;
  };
  const actorW = spec.actors.map((a) => Math.max(88, Math.max(w("title", a.name), w("value", a.sub)) + 24));
  const anySub = spec.actors.some((a) => a.sub !== undefined);
  const actorH = 2 * 9 + lh.title + (anySub ? 3 + lh.value : 0);

  // Gaps between neighbouring lifelines, wide enough for every label that must sit in them.
  const n = spec.actors.length;
  const gap: number[] = [];
  for (let i = 0; i < n - 1; i++) gap.push(Math.max(104, Math.round((actorW[i] + actorW[i + 1]) / 2) + 24));
  let tail = Math.round(actorW[n - 1] / 2);
  for (const m of spec.messages) {
    const a = at(m.from);
    const b = at(m.to);
    const need = w("value", text(m));
    if (a === b) {
      if (a === n - 1) tail = Math.max(tail, need + 40);
      else gap[a] = Math.max(gap[a], need + 52);
      continue;
    }
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    const have = gap.slice(lo, hi).reduce((s, g) => s + g, 0);
    if (have < need + 40) gap[hi - 1] += need + 40 - have;
  }
  const cx: number[] = [MARGIN + gutter + Math.round(actorW[0] / 2)];
  for (let i = 0; i < n - 1; i++) cx.push(cx[i] + gap[i]);

  const top = MARGIN;
  const ROW = lh.value + 24;
  const first = top + actorH + ROW;
  const y = (k: number): number => first + k * ROW;
  const end = y(spec.messages.length - 1) + 18;

  // Lifelines under everything.
  for (let i = 0; i < n; i++) pen.rule([cx[i], top + actorH], [cx[i], end], "grid", { dash: [3, 4], delay: 0 });

  spec.actors.forEach((a, i) => {
    const tinted = look.fill === "tinted";
    pen.box(cx[i] - Math.round(actorW[i] / 2), top, actorW[i], actorH, 8, {
      fill: "surface",
      delay: 0,
    });
    pen.box(cx[i] - Math.round(actorW[i] / 2), top, actorW[i], actorH, 8, {
      fill: tinted ? "accent" : undefined,
      fillOpacity: 0.07,
      stroke: tinted ? "accent" : "ink-muted",
      strokeOpacity: tinted ? 0.75 : 0.9,
      delay: 0,
    });
    pen.text(cx[i], top + 9, a.name, { role: "title", anchor: "middle", delay: 0 });
    if (a.sub !== undefined) {
      pen.text(cx[i], top + 9 + lh.title + 3, a.sub, { role: "value", fill: "ink-muted", anchor: "middle", delay: 0 });
    }
  });

  spec.messages.forEach((m, k) => {
    const a = at(m.from);
    const b = at(m.to);
    const yy = y(k);
    const delay = 1 + k;
    const colour: Colour = m.reply === true && m.tone === undefined ? "ink-muted" : m.tone === undefined ? "ink" : toneColour(m.tone);
    const label = text(m);
    const labelW = w("value", label);
    if (disc && m.key !== undefined) {
      pen.disc(MARGIN + DISC, yy, DISC, "accent", delay);
      pen.text(MARGIN + DISC, yy, String(m.key), { role: "value", fill: "surface", anchor: "middle", baseline: "middle", delay });
    }
    if (a === b) {
      // A step the actor takes alone: a short loop off its lifeline.
      const x0 = cx[a];
      pen.edge([[x0, yy - 7], [x0 + 20, yy - 7], [x0 + 20, yy + 7], [x0, yy + 7]], { colour, routing: look.routing === "elbow" ? "elbow" : "rounded", delay });
      pen.text(x0 + 28, yy, label, { role: "value", fill: m.tone === undefined ? "ink" : colour, baseline: "middle", delay });
      return;
    }
    const mx = Math.round((cx[a] + cx[b]) / 2);
    // A label over a lifeline it crosses is knocked out of it.
    pen.box(mx - Math.round(labelW / 2) - 3, yy - 6 - lh.value, labelW + 6, lh.value + 2, 0, { fill: "surface", delay });
    pen.text(mx, yy - 5, label, {
      role: "value", fill: m.reply === true ? "ink-muted" : m.tone === undefined ? "ink" : colour, anchor: "middle", baseline: "bottom", delay,
    });
    pen.edge([[cx[a], yy], [cx[b], yy]], { colour, routing: "elbow", dashed: m.reply, delay });
  });

  return pen.finish(cx[n - 1] + tail + MARGIN, end + MARGIN, 0);
}

/* ---------------------------------------------------------------------------
 * layers — strata, and what crosses each boundary
 * ---------------------------------------------------------------------------*/

export function layoutLayers(spec: LayersSpec, look: Look, measure: Measure): Drawn {
  const pen = new Pen(look.motion);
  const lh = lineHeights(measure);
  const w = (role: ChartTypeRole, s: string | undefined): number => (s === undefined ? 0 : Math.ceil(measure(role, s).w));
  const DISC = 8;
  const disc = look.keys === "disc";
  const CELL_GAP = 8;
  const BAND_PAD = 10;

  const cellName = (c: LayerCell): string => (!disc && c.key !== undefined ? `${c.key}  ${c.name}` : c.name);
  const cellRole = (c: LayerCell): ChartTypeRole => (c.mono === true ? "mono" : "label");
  const cellLead = (c: LayerCell): number => (disc && c.key !== undefined ? DISC * 2 + 7 : 0);
  const natural = (c: LayerCell): number => cellLead(c) + Math.max(w(cellRole(c), cellName(c)), w("value", c.sub)) + 24;

  const labelW = Math.max(...spec.layers.map((l) => Math.max(w("title", l.name), w("value", l.sub)))) + 28;
  const inner = Math.max(
    ...spec.layers.map((l) => l.cells.length * Math.max(...l.cells.map(natural)) + CELL_GAP * (l.cells.length - 1)),
  );
  const anySub = spec.layers.some((l) => l.cells.some((c) => c.sub !== undefined));
  const cellH = 2 * 8 + lh.label + (anySub ? 2 + lh.value : 0);
  const bandH = cellH + 2 * BAND_PAD;
  const bandW = labelW + inner + BAND_PAD;
  const tinted = look.fill === "tinted";

  let y = MARGIN;
  spec.layers.forEach((layer, i) => {
    const x = MARGIN;
    pen.box(x, y, bandW, bandH, 8, {
      fill: tinted ? "accent" : "surface",
      fillOpacity: tinted ? 0.07 : 1,
      stroke: tinted ? "accent" : "ink-muted",
      strokeOpacity: tinted ? 0.75 : 0.9,
      delay: i,
    });
    const headH = lh.title + (layer.sub !== undefined ? 3 + lh.value : 0);
    const ty = y + Math.round((bandH - headH) / 2);
    pen.text(x + 14, ty, layer.name, { role: "title", delay: i });
    if (layer.sub !== undefined) pen.text(x + 14, ty + lh.title + 3, layer.sub, { role: "value", fill: "ink-muted", delay: i });

    const count = layer.cells.length;
    const cw = (inner - CELL_GAP * (count - 1)) / count;
    layer.cells.forEach((cell, k) => {
      const cx = Math.round(x + labelW + k * (cw + CELL_GAP));
      const cy = y + BAND_PAD;
      const width = Math.round(cw);
      pen.box(cx, cy, width, cellH, 5, { fill: "surface", stroke: "grid", delay: i });
      const lead = cellLead(cell);
      if (lead > 0 && cell.key !== undefined) {
        pen.disc(cx + 12 + DISC, cy + Math.round(cellH / 2), DISC, "accent", i);
        pen.text(cx + 12 + DISC, cy + Math.round(cellH / 2), String(cell.key), {
          role: "value", fill: "surface", anchor: "middle", baseline: "middle", delay: i,
        });
      }
      const role = cellRole(cell);
      const textH = lh[role] + (cell.sub !== undefined ? 2 + lh.value : 0);
      const top = cy + Math.round((cellH - textH) / 2);
      const keyed = cell.key !== undefined && cell.mono !== true;
      pen.text(cx + 12 + lead, top, cellName(cell), { role, fill: keyed ? "accent" : "ink", delay: i });
      if (cell.sub !== undefined) pen.text(cx + 12 + lead, top + lh[role] + 2, cell.sub, { role: "value", fill: "ink-muted", delay: i });
    });

    y += bandH;
    if (i < spec.layers.length - 1) {
      const gap = layer.below !== undefined ? 34 : 12;
      if (layer.below !== undefined) {
        const ax = Math.round(x + labelW + inner / 2);
        pen.edge([[ax, y + 3], [ax, y + gap - 3]], { colour: "ink-muted", routing: "elbow", delay: i + 1, headAtStart: true });
        pen.text(ax + 10, y + Math.round(gap / 2), layer.below, { role: "value", fill: "ink-muted", baseline: "middle", delay: i + 1 });
      }
      y += gap;
    }
  });

  return pen.finish(MARGIN + bandW + MARGIN, y + MARGIN, 0);
}

export function layoutDiagram(spec: DiagramSpec, look: Look, measure: Measure): Drawn {
  switch (spec.form) {
    case "flow":
      return layoutFlow(spec, look, measure);
    case "sequence":
      return layoutSequence(spec, look, measure);
    case "layers":
      return layoutLayers(spec, look, measure);
  }
}
