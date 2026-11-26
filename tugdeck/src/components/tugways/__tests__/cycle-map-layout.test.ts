/**
 * cycle-map-layout.test.ts — where a cycle's entries and sketches sit on its
 * map, and how big the map is drawn.
 *
 * The layout was reviewed rendered on an eight-entry cycle, so that cycle is
 * pinned first, exactly as it was measured when the layout left the spike it
 * was drawn in. The rest pin the guarantees every host relies on: implied
 * waits are not drawn, a wire never runs through a tile it does not join, a
 * sketch's seal stands beside the entries it heads, bad input never hangs,
 * the two sizes come out at their measures, and the selection rule is the
 * one both hosts apply.
 */

import { describe, expect, it } from "bun:test";

import {
  CYCLE_MAP_MEASURES,
  NO_PICKS,
  cycleMapGeometry,
  entryKey,
  headsOf,
  layoutCycleMap,
  pickOnMap,
  reducedWaits,
  sealCycleMap,
  sketchKey,
  type CycleMapEntry,
  type CycleMapLayout,
  type CycleMapSeat,
  type CycleMapSource,
} from "@/components/tugways/cycle-map-layout";

/** The cycle the map was reviewed on: seven entries from sketch A, and one from sketch B. */
const EIGHT: readonly CycleMapSource[] = [
  { n: 1, waits: [], from: ["A"] },
  { n: 2, waits: [], from: ["A"] },
  { n: 3, waits: [], from: ["A"] },
  { n: 4, waits: [1], from: ["A"] },
  { n: 5, waits: [4], from: ["A"] },
  { n: 6, waits: [2, 5], from: ["A"] },
  { n: 7, waits: [3, 4], from: ["A"] },
  { n: 8, waits: [4, 5, 7], from: ["B"] },
];

function seatOf(layout: CycleMapLayout, n: number): CycleMapSeat {
  const node = layout.nodes.find((x) => x.n === n);
  if (node === undefined) throw new Error(`no node ${n}`);
  return { col: node.col, row: node.row };
}

function column(layout: CycleMapLayout, col: number): number[] {
  return layout.nodes
    .filter((x) => x.col === col)
    .map((x) => x.n)
    .sort((a, b) => a - b);
}

function waitsOf(layout: CycleMapLayout, to: number): number[] {
  return layout.wires
    .filter((w) => w.to === to)
    .map((w) => w.from)
    .sort((a, b) => a - b);
}

/** Every seat on the map: a node's, and each one a wire holds between its ends. */
function allSeats(layout: CycleMapLayout): CycleMapSeat[] {
  return [
    ...layout.nodes.map((x) => ({ col: x.col, row: x.row })),
    ...layout.wires.flatMap((w) => w.seats.slice(1, -1)),
  ];
}

/** Crossings between unit links that leave the same column, with each seat's row read from `rowOf`. */
function crossingsOf(layout: CycleMapLayout, rowOf: (seat: CycleMapSeat) => number): number {
  const links = layout.wires.flatMap((w) => w.seats.slice(0, -1).map((s, i) => [s, w.seats[i + 1]!] as const));
  let count = 0;
  for (let i = 0; i < links.length; i += 1) {
    for (let j = i + 1; j < links.length; j += 1) {
      const [a, b] = links[i]!;
      const [c, d] = links[j]!;
      if (a.col !== c.col) continue;
      if ((rowOf(a) - rowOf(c)) * (rowOf(b) - rowOf(d)) < 0) count += 1;
    }
  }
  return count;
}

/**
 * The rows the layout started from, before any sweep: within each column,
 * the entries in the order given, then each wire's held seats in the order
 * the wires were routed. Sweeps reorder rows and never move a column, so the
 * starting order can be read back from the result.
 */
function startingRows(layout: CycleMapLayout, entries: readonly CycleMapEntry[]): (seat: CycleMapSeat) => number {
  const columns: CycleMapSeat[][] = Array.from({ length: layout.cols }, () => []);
  for (const entry of entries) {
    const seat = seatOf(layout, entry.n);
    columns[seat.col]!.push(seat);
  }
  for (const wire of layout.wires) for (const seat of wire.seats.slice(1, -1)) columns[seat.col]!.push(seat);
  const start = new Map<string, number>();
  columns.forEach((seats) => seats.forEach((seat, row) => start.set(`${seat.col}:${seat.row}`, row)));
  return (seat) => start.get(`${seat.col}:${seat.row}`)!;
}

describe("cycle-map-layout — the eight-entry cycle", () => {
  const sealed = sealCycleMap(EIGHT);
  const layout = layoutCycleMap(sealed.entries);
  const sealA = [...sealed.letters].find(([, l]) => l === "A")![0];
  const sealB = [...sealed.letters].find(([, l]) => l === "B")![0];

  it("has five columns and four rows", () => {
    expect(layout.cols).toBe(5);
    expect(layout.rows).toBe(4);
  });

  it("seats every entry and seal in the column it was measured in", () => {
    expect(seatOf(layout, sealA).col).toBe(0);
    expect(column(layout, 0)).toEqual([sealA]);
    expect(column(layout, 1)).toEqual([1, 2, 3]);
    expect(column(layout, 2)).toEqual([4]);
    expect(column(layout, 3)).toEqual([sealB, 5, 7].sort((a, b) => a - b));
    expect(column(layout, 4)).toEqual([6, 8]);
  });

  it("drops 8's wait on 4, which 5 and 7 already imply", () => {
    expect(waitsOf(layout, 8)).toEqual([sealB, 5, 7].sort((a, b) => a - b));
  });

  it("holds seats for the wires that pass a column", () => {
    const held = (from: number, to: number): number[] =>
      layout.wires
        .find((w) => w.from === from && w.to === to)!
        .seats.slice(1, -1)
        .map((s) => s.col);
    expect(held(2, 6)).toEqual([2, 3]);
    expect(held(3, 7)).toEqual([2]);
  });

  it("draws twelve wires", () => {
    expect(layout.wires).toHaveLength(12);
  });
});

describe("cycle-map-layout — reducedWaits", () => {
  it("drops a wait another wait implies, and only that wait", () => {
    const entries: CycleMapEntry[] = [
      { n: 1, waits: [] },
      { n: 2, waits: [1] },
      { n: 3, waits: [] },
      { n: 4, waits: [1, 2, 3] },
    ];
    const waits = reducedWaits(entries);
    expect(waits.get(4)).toEqual([2, 3]);
    expect(waits.get(2)).toEqual([1]);
    expect(waits.get(1)).toEqual([]);
  });

  it("drops a wait implied several steps deep", () => {
    const entries: CycleMapEntry[] = [
      { n: 1, waits: [] },
      { n: 2, waits: [1] },
      { n: 3, waits: [2] },
      { n: 4, waits: [1, 3] },
    ];
    expect(reducedWaits(entries).get(4)).toEqual([3]);
  });

  it("ignores a wait on a number not in the cycle", () => {
    expect(reducedWaits([{ n: 1, waits: [99] }]).get(1)).toEqual([]);
  });
});

describe("cycle-map-layout — seats and wires", () => {
  const fixtures: Record<string, readonly CycleMapEntry[]> = {
    eight: sealCycleMap(EIGHT).entries,
    crossed: [
      { n: 1, waits: [] },
      { n: 2, waits: [] },
      { n: 3, waits: [2] },
      { n: 4, waits: [1] },
    ],
    long: [
      { n: 1, waits: [] },
      { n: 2, waits: [1] },
      { n: 3, waits: [2] },
      { n: 4, waits: [3] },
      { n: 5, waits: [] },
      { n: 6, waits: [5, 4] },
      { n: 7, waits: [1] },
      { n: 8, waits: [7, 5] },
    ],
  };

  for (const [name, entries] of Object.entries(fixtures)) {
    const layout = layoutCycleMap(entries);

    it(`${name}: every node has exactly one seat, and no two seats are shared`, () => {
      expect(layout.nodes.map((x) => x.n).sort((a, b) => a - b)).toEqual(entries.map((e) => e.n).sort((a, b) => a - b));
      const seats = allSeats(layout).map((s) => `${s.col}:${s.row}`);
      expect(new Set(seats).size).toBe(seats.length);
      for (const seat of allSeats(layout)) {
        expect(seat.col).toBeGreaterThanOrEqual(0);
        expect(seat.col).toBeLessThan(layout.cols);
        expect(seat.row).toBeGreaterThanOrEqual(0);
        expect(seat.row).toBeLessThan(layout.rows);
      }
    });

    it(`${name}: a wire's seats run one column at a time from its start to its end`, () => {
      for (const wire of layout.wires) {
        expect(wire.seats[0]).toEqual(seatOf(layout, wire.from));
        expect(wire.seats[wire.seats.length - 1]).toEqual(seatOf(layout, wire.to));
        wire.seats.forEach((seat, i) => expect(seat.col).toBe(wire.seats[0]!.col + i));
      }
    });

    it(`${name}: the ordering never crosses more than the order it started from`, () => {
      const final = crossingsOf(layout, (seat) => seat.row);
      expect(final).toBeLessThanOrEqual(crossingsOf(layout, startingRows(layout, entries)));
    });
  }

  it("uncrosses two wires the input order crossed", () => {
    const layout = layoutCycleMap(fixtures.crossed!);
    expect(crossingsOf(layout, startingRows(layout, fixtures.crossed!))).toBe(1);
    expect(crossingsOf(layout, (seat) => seat.row)).toBe(0);
  });
});

describe("cycle-map-layout — late nodes", () => {
  it("seats a late node in the column just before the first that waits on it", () => {
    const layout = layoutCycleMap([
      { n: -1, waits: [], late: true },
      { n: 1, waits: [] },
      { n: 2, waits: [1] },
      { n: 3, waits: [2, -1] },
      { n: 4, waits: [3, -1] },
    ]);
    expect(seatOf(layout, 3).col).toBe(2);
    expect(seatOf(layout, -1).col).toBe(1);
  });

  it("leaves a late node nothing waits on in the first column", () => {
    const layout = layoutCycleMap([
      { n: 1, waits: [] },
      { n: 2, waits: [1] },
      { n: -1, waits: [], late: true },
    ]);
    expect(seatOf(layout, -1).col).toBe(0);
  });
});

describe("cycle-map-layout — bad input", () => {
  it("lays out the empty cycle with no columns and no rows", () => {
    const layout = layoutCycleMap([]);
    expect(layout).toEqual({ nodes: [], wires: [], cols: 0, rows: 0 });
  });

  it("ignores a wait on an unknown number", () => {
    const layout = layoutCycleMap([
      { n: 1, waits: [99] },
      { n: 2, waits: [1] },
    ]);
    expect(seatOf(layout, 1).col).toBe(0);
    expect(seatOf(layout, 2).col).toBe(1);
    expect(layout.wires.map((w) => [w.from, w.to])).toEqual([[1, 2]]);
  });

  it("terminates on a loop, a wait on itself, and a three-entry ring", () => {
    const loops: CycleMapEntry[][] = [
      [
        { n: 1, waits: [2] },
        { n: 2, waits: [1] },
      ],
      [{ n: 1, waits: [1] }],
      [
        { n: 1, waits: [3] },
        { n: 2, waits: [1] },
        { n: 3, waits: [2] },
      ],
    ];
    for (const entries of loops) {
      const layout = layoutCycleMap(entries);
      expect(layout.nodes).toHaveLength(entries.length);
      expect(() => cycleMapGeometry(layout, "full")).not.toThrow();
    }
  });
});

describe("cycle-map-layout — sketches as seals", () => {
  it("heads the entries that wait on nothing else from their sketch", () => {
    expect(headsOf("A", EIGHT)).toEqual([1, 2, 3]);
    expect(headsOf("B", EIGHT)).toEqual([8]);
    expect(headsOf("C", EIGHT)).toEqual([]);
  });

  it("puts seals first, in the order sketches are named, then letters the entries add", () => {
    const sealed = sealCycleMap([{ n: 1, waits: [], from: ["B"] }], ["C"]);
    expect([...sealed.letters.values()]).toEqual(["C", "B"]);
    expect(sealed.entries.slice(0, 2).every((e) => e.n < 0 && e.late === true && e.waits.length === 0)).toBe(true);
  });

  it("wires each head to its sketch's seal, and no other entry", () => {
    const sealed = sealCycleMap(EIGHT);
    const sealA = [...sealed.letters].find(([, l]) => l === "A")![0];
    const layout = layoutCycleMap(sealed.entries);
    expect(
      layout.wires
        .filter((w) => w.from === sealA)
        .map((w) => w.to)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3]);
  });

  it("wires an entry that heads two sketches from both seals", () => {
    const sealed = sealCycleMap([
      { n: 1, waits: [], from: ["A"] },
      { n: 2, waits: [1], from: ["A", "B"] },
    ]);
    const seal = (letter: string): number => [...sealed.letters].find(([, l]) => l === letter)![0];
    // 2 waits on 1, which is also from A, so 2 heads B alone; 1 heads A.
    const two = sealed.entries.find((e) => e.n === 2)!;
    expect([...two.waits].sort((a, b) => a - b)).toEqual([seal("B"), 1].sort((a, b) => a - b));

    const both = sealCycleMap([{ n: 1, waits: [], from: ["A", "B"] }]);
    const one = both.entries.find((e) => e.n === 1)!;
    expect([...one.waits].sort((a, b) => a - b)).toEqual([...both.letters.keys()].sort((a, b) => a - b));
    expect(layoutCycleMap(both.entries).wires.filter((w) => w.to === 1)).toHaveLength(2);
  });

  it("gives a sketch no entry heads a seal with no wires, in the first column", () => {
    const sealed = sealCycleMap([{ n: 1, waits: [], from: ["A"] }], ["A", "Z"]);
    const sealZ = [...sealed.letters].find(([, l]) => l === "Z")![0];
    const layout = layoutCycleMap(sealed.entries);
    expect(seatOf(layout, sealZ).col).toBe(0);
    expect(layout.wires.some((w) => w.from === sealZ || w.to === sealZ)).toBe(false);
  });
});

describe("cycle-map-layout — geometry", () => {
  const layout = layoutCycleMap(sealCycleMap(EIGHT).entries);

  it("draws the eight-entry cycle at 516 × 236 full and 328 × 154 compact", () => {
    const full = cycleMapGeometry(layout, "full");
    const compact = cycleMapGeometry(layout, "compact");
    expect([full.width, full.height]).toEqual([516, 236]);
    expect([compact.width, compact.height]).toEqual([328, 154]);
  });

  for (const size of ["full", "compact"] as const) {
    it(`${size}: every box sits inside the map, at its size's measures`, () => {
      const d = CYCLE_MAP_MEASURES[size];
      const g = cycleMapGeometry(layout, size);
      expect(g.boxes).toHaveLength(layout.nodes.length);
      for (const box of g.boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(g.width);
        expect(box.top + box.height).toBeLessThanOrEqual(g.height);
        expect(box.height).toBe(d.tileH);
        expect(box.width).toBe(box.seal ? d.tileH : d.tileW);
        expect(box.seal).toBe(box.n < 0);
      }
    });

    it(`${size}: a seal is square and ends where its column's tiles end`, () => {
      const d = CYCLE_MAP_MEASURES[size];
      const g = cycleMapGeometry(layout, size);
      for (const box of g.boxes.filter((b) => b.seal)) {
        const col = seatOf(layout, box.n).col;
        expect(box.left + box.width).toBe(d.pad + col * d.colW + d.tileW);
      }
    });

    it(`${size}: draws one stroke for each wire`, () => {
      const g = cycleMapGeometry(layout, size);
      expect(g.strokes.map((s) => [s.from, s.to])).toEqual(layout.wires.map((w) => [w.from, w.to]));
      for (const stroke of g.strokes) {
        expect(stroke.path.startsWith("M ")).toBe(true);
        expect(stroke.head.endsWith(" Z")).toBe(true);
      }
    });
  }

  it("draws the empty cycle at no size", () => {
    expect(cycleMapGeometry(layoutCycleMap([]), "full")).toEqual({ width: 0, height: 0, boxes: [], strokes: [] });
  });
});

describe("cycle-map-layout — selection", () => {
  it("names assets the same way on the map and in a list", () => {
    expect(entryKey(3)).toBe("e3");
    expect(sketchKey("A")).toBe("sA");
  });

  it("selects one on a press, replacing what was chosen", () => {
    expect([...pickOnMap(new Set(["e1", "e2"]), "e3", false)]).toEqual(["e3"]);
  });

  it("adds one on a shift-press, and removes one already chosen", () => {
    expect([...pickOnMap(new Set(["e1"]), "sA", true)].sort()).toEqual(["e1", "sA"]);
    expect([...pickOnMap(new Set(["e1", "sA"]), "e1", true)]).toEqual(["sA"]);
  });

  it("clears on a press on the ground", () => {
    expect(pickOnMap(new Set(["e1"]), null, false)).toBe(NO_PICKS);
    expect(pickOnMap(new Set(["e1"]), null, true).size).toBe(0);
  });

  it("never changes the set it was given", () => {
    const chosen = new Set(["e1"]);
    pickOnMap(chosen, "e2", true);
    pickOnMap(chosen, "e1", true);
    expect([...chosen]).toEqual(["e1"]);
  });
});
