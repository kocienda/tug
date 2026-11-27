/**
 * cycle-map-layout.ts — where each entry of a cycle sits on its map, and how
 * big the map is drawn.
 *
 * A cycle's entries and what each waits on are a graph with no loop. The map
 * reads left to right: an entry's column is how many entries deep its longest
 * chain of waits runs, so the first column is everything that can start now
 * and each later column is what a join in the one before it frees. Within a
 * column, entries are ordered so the wires cross as little as a few sweeps can
 * manage.
 *
 * Two things keep the map readable:
 *
 *   - A wait that another wait already implies is not drawn. If 8 waits on 4
 *     and on 5, and 5 waits on 4, the wire from 4 to 8 says nothing the other
 *     two do not.
 *   - A wire that passes a column holds a seat in it, so it never runs through
 *     an entry it does not join.
 *
 * Every sketch the cycle came from stands on the map as a seal, wired to the
 * entries it heads. Inside the layout a seal is a negative number, so it
 * never meets an entry's; no caller sees that number.
 *
 * Everything here is pure. `layoutCycleMap` works in whole-number columns and
 * rows, `cycleMapGeometry` turns those into pixels at one of the two sizes,
 * and `pickOnMap` is the selection rule every host applies.
 */

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

export interface CycleMapEntry {
  n: number;
  waits: readonly number[];
  /**
   * Seat this one in the column just before the first that waits on it,
   * rather than as far left as it can go. A sketch is seated this way, so it
   * stands beside the entries it heads however late it was added.
   */
  late?: boolean;
}

export interface CycleMapSeat {
  col: number;
  row: number;
}

export interface CycleMapNode extends CycleMapSeat {
  n: number;
}

export interface CycleMapWire {
  from: number;
  to: number;
  /** The seats the wire passes, its two ends included. */
  seats: readonly CycleMapSeat[];
}

export interface CycleMapLayout {
  nodes: readonly CycleMapNode[];
  wires: readonly CycleMapWire[];
  cols: number;
  rows: number;
}

/** The waits worth drawing: each entry's waits, less the ones another implies. */
export function reducedWaits(entries: readonly CycleMapEntry[]): ReadonlyMap<number, readonly number[]> {
  const byN = new Map(entries.map((e) => [e.n, e]));
  const memo = new Map<number, Set<number>>();
  const before = (n: number): Set<number> => {
    const known = memo.get(n);
    if (known !== undefined) return known;
    const all = new Set<number>();
    memo.set(n, all);
    for (const w of byN.get(n)?.waits ?? []) {
      all.add(w);
      for (const deeper of before(w)) all.add(deeper);
    }
    return all;
  };
  const out = new Map<number, number[]>();
  for (const entry of entries) {
    out.set(
      entry.n,
      entry.waits.filter(
        (w) => byN.has(w) && !entry.waits.some((other) => other !== w && before(other).has(w)),
      ),
    );
  }
  return out;
}

function crossings(layers: readonly string[][], links: ReadonlyArray<readonly [string, string]>): number {
  const at = new Map<string, number>();
  const layerOf = new Map<string, number>();
  layers.forEach((layer, col) =>
    layer.forEach((id, row) => {
      at.set(id, row);
      layerOf.set(id, col);
    }),
  );
  let count = 0;
  for (let i = 0; i < links.length; i += 1) {
    for (let j = i + 1; j < links.length; j += 1) {
      const [a, b] = links[i]!;
      const [c, d] = links[j]!;
      if (layerOf.get(a) !== layerOf.get(c)) continue;
      const left = at.get(a)! - at.get(c)!;
      const right = at.get(b)! - at.get(d)!;
      if (left * right < 0) count += 1;
    }
  }
  return count;
}

/** Seat every entry in a column and a row, and route every drawn wait between them. */
export function layoutCycleMap(entries: readonly CycleMapEntry[]): CycleMapLayout {
  const byN = new Map(entries.map((e) => [e.n, e]));
  const depths = new Map<number, number>();
  const depth = (n: number): number => {
    const known = depths.get(n);
    if (known !== undefined) return known;
    depths.set(n, 0);
    const waits = (byN.get(n)?.waits ?? []).filter((w) => byN.has(w));
    const d = waits.length === 0 ? 0 : 1 + Math.max(...waits.map(depth));
    depths.set(n, d);
    return d;
  };
  const cols = entries.length === 0 ? 0 : 1 + Math.max(...entries.map((e) => depth(e.n)));
  for (const entry of entries) {
    if (entry.late !== true) continue;
    const after = entries.filter((e) => e.waits.includes(entry.n)).map((e) => depth(e.n));
    if (after.length > 0) depths.set(entry.n, Math.min(...after) - 1);
  }
  const layers: string[][] = Array.from({ length: cols }, () => []);
  for (const entry of entries) layers[depth(entry.n)]!.push(`n${entry.n}`);

  // Each drawn wait becomes a chain of unit links, with a held seat in every
  // column it passes.
  const waits = reducedWaits(entries);
  const links: Array<readonly [string, string]> = [];
  const chains: Array<{ from: number; to: number; ids: string[] }> = [];
  for (const entry of entries) {
    for (const w of waits.get(entry.n) ?? []) {
      const ids = [`n${w}`];
      for (let col = depth(w) + 1; col < depth(entry.n); col += 1) {
        const id = `w${w}-${entry.n}-${col}`;
        layers[col]!.push(id);
        ids.push(id);
      }
      ids.push(`n${entry.n}`);
      for (let i = 0; i + 1 < ids.length; i += 1) links.push([ids[i]!, ids[i + 1]!]);
      chains.push({ from: w, to: entry.n, ids });
    }
  }

  const neighbours = (id: string, side: 0 | 1): string[] =>
    links.filter((link) => link[side] === id).map((link) => link[side === 0 ? 1 : 0]);

  const sweep = (order: string[][], down: boolean): string[][] => {
    const next = order.map((layer) => [...layer]);
    const walk = down ? next.keys() : [...next.keys()].reverse();
    for (const col of walk) {
      const beside = next[down ? col - 1 : col + 1];
      if (beside === undefined) continue;
      const key = new Map<string, number>();
      next[col]!.forEach((id, row) => {
        const rows = neighbours(id, down ? 1 : 0).map((other) => beside.indexOf(other));
        key.set(id, rows.length === 0 ? row : rows.reduce((a, b) => a + b, 0) / rows.length);
      });
      next[col] = [...next[col]!].sort((a, b) => key.get(a)! - key.get(b)!);
    }
    return next;
  };

  let best = layers;
  let bestCount = crossings(layers, links);
  let current = layers;
  for (let pass = 0; pass < 8 && bestCount > 0; pass += 1) {
    current = sweep(current, pass % 2 === 0);
    const count = crossings(current, links);
    if (count < bestCount) {
      best = current;
      bestCount = count;
    }
  }

  const seat = new Map<string, CycleMapSeat>();
  best.forEach((layer, col) => layer.forEach((id, row) => seat.set(id, { col, row })));
  return {
    nodes: entries.map((e) => ({ n: e.n, ...seat.get(`n${e.n}`)! })),
    wires: chains.map((chain) => ({
      from: chain.from,
      to: chain.to,
      seats: chain.ids.map((id) => seat.get(id)!),
    })),
    cols,
    rows: Math.max(0, ...best.map((layer) => layer.length)),
  };
}

// ---------------------------------------------------------------------------
// Sketches as seals
// ---------------------------------------------------------------------------

/** What the seal transform reads of an entry: its number, its waits, and the sketches it came from. */
export interface CycleMapSource {
  n: number;
  waits: readonly number[];
  /** The letters of every sketch this entry came from. */
  from: readonly string[];
}

/** The layout's input for a cycle, and which sketch each seal stands for. */
export interface CycleMapSealed {
  entries: readonly CycleMapEntry[];
  /** Each seal's number in the layout, to its sketch's letter. */
  letters: ReadonlyMap<number, string>;
}

/**
 * The entries a sketch heads: those that came from it, less those that wait
 * on another entry that came from it too. A wait on a number not in the
 * cycle is ignored.
 */
export function headsOf(letter: string, sources: readonly CycleMapSource[]): number[] {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return sources
    .filter((s) => s.from.includes(letter) && !s.waits.some((w) => byN.get(w)?.from.includes(letter) === true))
    .map((s) => s.n);
}

/**
 * Every entry, and every sketch as a seal its heads wait on. An entry that
 * heads two sketches waits on both seals. A sketch no entry heads is a seal
 * with no wires, and stays in the first column.
 *
 * The sketches are the ones named, in the order given, then any letter an
 * entry names that was not, in the order the entries name them. Seals come
 * before entries in the result, as they did in the map the layout was
 * reviewed on.
 */
export function sealCycleMap(sources: readonly CycleMapSource[], sketches: readonly string[] = []): CycleMapSealed {
  const order: string[] = [];
  for (const letter of [...sketches, ...sources.flatMap((s) => s.from)]) {
    if (!order.includes(letter)) order.push(letter);
  }
  const sealOf = new Map(order.map((letter, i) => [letter, -(i + 1)]));
  const headed = new Map<number, number[]>();
  for (const letter of order) {
    for (const n of headsOf(letter, sources)) headed.set(n, [...(headed.get(n) ?? []), sealOf.get(letter)!]);
  }
  return {
    entries: [
      ...order.map((letter) => ({ n: sealOf.get(letter)!, waits: [], late: true })),
      ...sources.map((s) => ({ n: s.n, waits: [...s.waits, ...(headed.get(s.n) ?? [])] })),
    ],
    letters: new Map(order.map((letter) => [sealOf.get(letter)!, letter])),
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** The two sizes the map is drawn at: a surface's own, and a sidebar's. */
export type CycleMapSize = "full" | "compact";

/** A size's measures, in px. */
export interface CycleMapMeasures {
  /** From one column's left edge to the next's. */
  colW: number;
  /** From one row's top edge to the next's. */
  rowH: number;
  tileW: number;
  tileH: number;
  /** Around the whole map. */
  pad: number;
}

export const CYCLE_MAP_MEASURES: Readonly<Record<CycleMapSize, CycleMapMeasures>> = {
  full: { colW: 160, rowH: 58, tileW: 124, tileH: 42, pad: 10 },
  compact: { colW: 112, rowH: 38, tileW: 88, tileH: 28, pad: 6 },
};

/**
 * The lengths inside a tile that decide how much room its number leaves for
 * the arc's track, in px. They mirror `cycle-map.css` (the tile's border and
 * padding, the gap between number and mark), and `digit` is a digit of the
 * number at its size, measured rather than taken from a font table: about
 * 9.5 px at 16 px semibold and 7 px at 12 px, rounded up.
 */
export interface CycleMapTileInner {
  border: number;
  pad: number;
  gap: number;
  digit: number;
}

export const CYCLE_MAP_TILE_INNER: Readonly<Record<CycleMapSize, CycleMapTileInner>> = {
  full: { border: 1.5, pad: 8, gap: 6, digit: 10 },
  compact: { border: 1.5, pad: 5, gap: 2, digit: 8 },
};

/**
 * The arc track's knobs as a tile sets them (`--tugx-arc-track-cell-w`,
 * `-steps-w`, `-cell-h` in `cycle-map.css`), in px, and the track's own gaps
 * (`tug-arc-track.css`): 2 between cells, 1 between ticks. A running tile
 * draws the arc's whole track, the one every surface whose subject is the arc
 * draws, at a tile's scale.
 */
export interface CycleMapTrack {
  cellW: number;
  stepsW: number;
  cellH: number;
}

export const CYCLE_MAP_TRACK: Readonly<Record<CycleMapSize, CycleMapTrack>> = {
  full: { cellW: 6, stepsW: 36, cellH: 9 },
  compact: { cellW: 4, stepsW: 26, cellH: 6 },
};

/** The gap between two of the track's cells, and between two ticks. */
const TRACK_CELL_GAP = 2;
const TRACK_TICK_GAP = 1;

/** A track's width at a size: a planned arc's six phases, or a plain arc's four. */
export function tileTrackWidth(size: CycleMapSize, planned: boolean): number {
  const t = CYCLE_MAP_TRACK[size];
  const phases = planned ? 6 : 4;
  return (phases - 1) * t.cellW + t.stepsW + (phases - 1) * TRACK_CELL_GAP;
}

/** The most steps whose ticks share the implement cell without passing its edge. */
export function tileTrackTicks(size: CycleMapSize): number {
  return Math.floor((CYCLE_MAP_TRACK[size].stepsW + TRACK_TICK_GAP) / (1 + TRACK_TICK_GAP));
}

/** The room beside a tile's number, in px, at a size, for entry `n`. */
export function tileMarkRoom(size: CycleMapSize, n: number): number {
  const inner = CYCLE_MAP_TILE_INNER[size];
  const digits = String(Math.max(0, Math.trunc(n))).length;
  return CYCLE_MAP_MEASURES[size].tileW - 2 * inner.border - 2 * inner.pad - digits * inner.digit - inner.gap;
}

/** Where one tile or seal is drawn. A seal is a square the tile's height, at the tile's right edge. */
export interface CycleMapBox {
  n: number;
  seal: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One wire's line and arrowhead, as SVG path data. */
export interface CycleMapStroke {
  from: number;
  to: number;
  path: string;
  head: string;
}

export interface CycleMapGeometry {
  width: number;
  height: number;
  boxes: readonly CycleMapBox[];
  strokes: readonly CycleMapStroke[];
}

const xOf = (d: CycleMapMeasures, seat: CycleMapSeat): number => d.pad + seat.col * d.colW;
const yOf = (d: CycleMapMeasures, seat: CycleMapSeat): number => d.pad + seat.row * d.rowH + d.tileH / 2;

/** A wire's path: a curve across each gap, and a straight run across a held seat. */
function wirePath(d: CycleMapMeasures, seats: readonly CycleMapSeat[]): string {
  const first = seats[0]!;
  let x = xOf(d, first) + d.tileW;
  let y = yOf(d, first);
  let path = `M ${x} ${y}`;
  for (let i = 1; i < seats.length; i += 1) {
    const seat = seats[i]!;
    const last = i === seats.length - 1;
    const toX = xOf(d, seat) - (last ? 5 : 0);
    const toY = yOf(d, seat);
    const mid = (x + toX) / 2;
    path += ` C ${mid} ${y} ${mid} ${toY} ${toX} ${toY}`;
    x = toX;
    y = toY;
    if (!last) {
      x = xOf(d, seat) + d.tileW;
      path += ` L ${x} ${y}`;
    }
  }
  return path;
}

function wireHead(d: CycleMapMeasures, seats: readonly CycleMapSeat[]): string {
  const end = seats[seats.length - 1]!;
  const x = xOf(d, end);
  const y = yOf(d, end);
  return `M ${x} ${y} L ${x - 6} ${y - 3.5} L ${x - 6} ${y + 3.5} Z`;
}

/** A layout in pixels at one size: the map's extent, each tile's and seal's box, and each wire's stroke. */
export function cycleMapGeometry(layout: CycleMapLayout, size: CycleMapSize): CycleMapGeometry {
  const d = CYCLE_MAP_MEASURES[size];
  const empty = layout.cols === 0 || layout.rows === 0;
  return {
    width: empty ? 0 : d.pad * 2 + layout.cols * d.colW - (d.colW - d.tileW),
    height: empty ? 0 : d.pad * 2 + layout.rows * d.rowH - (d.rowH - d.tileH),
    boxes: layout.nodes.map((node) => {
      const seal = node.n < 0;
      return {
        n: node.n,
        seal,
        left: xOf(d, node) + (seal ? d.tileW - d.tileH : 0),
        top: d.pad + node.row * d.rowH,
        width: seal ? d.tileH : d.tileW,
        height: d.tileH,
      };
    }),
    strokes: layout.wires.map((wire) => ({
      from: wire.from,
      to: wire.to,
      path: wirePath(d, wire.seats),
      head: wireHead(d, wire.seats),
    })),
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** An entry's key, shared by its tile on the map and its place in a host's list. */
export const entryKey = (n: number): string => `e${n}`;

/** A sketch's key, shared by its seal on the map and its place in a host's list. */
export const sketchKey = (letter: string): string => `s${letter}`;

/** No selection. */
export const NO_PICKS: ReadonlySet<string> = new Set();

/**
 * The selection after a press. A press selects one, a shift-press adds or
 * removes one, and a press on the map's ground (`key` null) clears.
 */
export function pickOnMap(chosen: ReadonlySet<string>, key: string | null, shift: boolean): ReadonlySet<string> {
  if (key === null) return NO_PICKS;
  if (!shift) return new Set([key]);
  const next = new Set(chosen);
  if (!next.delete(key)) next.add(key);
  return next;
}
