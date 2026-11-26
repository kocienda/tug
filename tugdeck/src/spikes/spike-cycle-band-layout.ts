/**
 * spike-cycle-band-layout.ts — where each entry of a cycle sits on its map.
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
 * Pure, and unit-free: columns and rows are whole numbers, and the caller
 * turns them into pixels.
 */

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

export interface CycleMap {
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

export function cycleMap(entries: readonly CycleMapEntry[]): CycleMap {
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
