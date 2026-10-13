/**
 * list-view-height-persist — the measured-height ledger as a card-state
 * payload: captured by a replay-stable id, seeded fresh under matching
 * samples and stale under any other.
 */

import { describe, expect, test } from "bun:test";

import { HeightIndex } from "../list-view-height-index";
import {
  PERSISTED_HEIGHTS_MAX,
  capturePersistedHeights,
  carryPersistedHeights,
  coercePersistedHeights,
  seedPersistedHeights,
} from "../list-view-height-persist";

const SAMPLE = { width: 640, zoomFactor: 1, rowGap: 12 };

const idOf = (i: number): string | null => `r${i}`;

function freshRead(idx: HeightIndex) {
  return (i: number) => (idx.isFresh(i) ? idx.get(i) : undefined);
}

describe("capturePersistedHeights / seedPersistedHeights", () => {
  test("a captured ledger seeds the same heights back, fresh", () => {
    const idx = new HeightIndex();
    for (let i = 0; i < 5; i += 1) idx.set(i, 100 + i);
    const record = capturePersistedHeights(freshRead(idx), 5, idOf, SAMPLE);
    expect(record.entries).toEqual([["r0", 100], ["r1", 101], ["r2", 102], ["r3", 103], ["r4", 104]]);

    const into = new HeightIndex();
    const r = seedPersistedHeights(into, record, 5, idOf, SAMPLE);
    expect(r).toEqual({ seeded: [0, 1, 2, 3, 4], stale: false });
    for (let i = 0; i < 5; i += 1) {
      expect(into.get(i)).toBe(100 + i);
      expect(into.isFresh(i)).toBe(true);
    }
  });

  test("seeding matches by id, so a list that grew at its front lands each height on its row", () => {
    const idx = new HeightIndex();
    for (let i = 0; i < 3; i += 1) idx.set(i, 50 + i);
    const record = capturePersistedHeights(freshRead(idx), 3, idOf, SAMPLE);
    const into = new HeightIndex();
    // Two rows now precede the recorded ones.
    const shifted = (i: number) => (i < 2 ? `new${i}` : `r${i - 2}`);
    expect(seedPersistedHeights(into, record, 5, shifted, SAMPLE).seeded).toEqual([2, 3, 4]);
    expect(into.get(2)).toBe(50);
    expect(into.get(4)).toBe(52);
    expect(into.has(0)).toBe(false);
  });

  test("the cap keeps the tail", () => {
    const n = PERSISTED_HEIGHTS_MAX + 10;
    const idx = new HeightIndex();
    for (let i = 0; i < n; i += 1) idx.set(i, 10);
    const record = capturePersistedHeights(freshRead(idx), n, idOf, SAMPLE);
    expect(record.entries).toHaveLength(PERSISTED_HEIGHTS_MAX);
    expect(record.entries[0][0]).toBe("r10");
    expect(record.entries[record.entries.length - 1][0]).toBe(`r${n - 1}`);
  });

  test("a duplicated id is dropped, both rows of it, and a row with no id is skipped", () => {
    const idx = new HeightIndex();
    for (let i = 0; i < 5; i += 1) idx.set(i, 20 + i);
    const ids = ["a", "dup", null, "dup", "e"];
    const record = capturePersistedHeights(freshRead(idx), 5, (i) => ids[i], SAMPLE);
    expect(record.entries).toEqual([["a", 20], ["e", 24]]);
  });

  test("a stale height is not captured", () => {
    const idx = new HeightIndex();
    idx.set(0, 10);
    idx.set(1, 11);
    idx.markAllStale();
    idx.set(1, 12);
    const record = capturePersistedHeights(freshRead(idx), 2, idOf, SAMPLE);
    expect(record.entries).toEqual([["r1", 12]]);
  });

  test("a width mismatch seeds stale", () => {
    const record = { v: 1 as const, ...SAMPLE, entries: [["r0", 80], ["r1", 90]] as [string, number][] };
    const into = new HeightIndex();
    const r = seedPersistedHeights(into, record, 2, idOf, { ...SAMPLE, width: 700 });
    expect(r).toEqual({ seeded: [0, 1], stale: true });
    expect(into.get(0)).toBe(80);
    expect(into.isFresh(0)).toBe(false);
    expect(into.isFresh(1)).toBe(false);
  });

  test("a zoom or row-gap mismatch seeds stale too", () => {
    const record = { v: 1 as const, ...SAMPLE, entries: [["r0", 80]] as [string, number][] };
    expect(seedPersistedHeights(new HeightIndex(), record, 1, idOf, { ...SAMPLE, zoomFactor: 1.1 }).stale).toBe(true);
    expect(seedPersistedHeights(new HeightIndex(), record, 1, idOf, { ...SAMPLE, rowGap: 8 }).stale).toBe(true);
  });

  test("a matching sample seeds fresh, the width within half a pixel", () => {
    const record = { v: 1 as const, ...SAMPLE, entries: [["r0", 80]] as [string, number][] };
    const into = new HeightIndex();
    expect(seedPersistedHeights(into, record, 1, idOf, { ...SAMPLE, width: 640.4 }).stale).toBe(false);
    expect(into.isFresh(0)).toBe(true);
  });

  test("a row that already has a height is not overwritten by the seed", () => {
    const record = { v: 1 as const, ...SAMPLE, entries: [["r0", 80], ["r1", 90]] as [string, number][] };
    const into = new HeightIndex();
    into.set(0, 33);
    expect(seedPersistedHeights(into, record, 2, idOf, SAMPLE).seeded).toEqual([1]);
    expect(into.get(0)).toBe(33);
  });
});

describe("carryPersistedHeights", () => {
  const record = (entries: [string, number][], sample = SAMPLE) => ({ v: 1 as const, ...sample, entries });

  test("a capture taken before the rows arrive keeps the record's heights", () => {
    const carried = record([["a", 10], ["b", 20]]);
    expect(carryPersistedHeights(record([]), carried).entries).toEqual([["a", 10], ["b", 20]]);
  });

  test("a captured height wins over the carried one for the same id", () => {
    const carried = record([["a", 10], ["b", 20]]);
    expect(carryPersistedHeights(record([["b", 25], ["c", 30]]), carried).entries).toEqual([
      ["a", 10],
      ["b", 25],
      ["c", 30],
    ]);
  });

  test("a record measured under other samples is not carried", () => {
    const carried = record([["a", 10]], { ...SAMPLE, width: 500 });
    expect(carryPersistedHeights(record([["c", 30]]), carried).entries).toEqual([["c", 30]]);
  });

  test("the cap drops carried entries before captured ones", () => {
    const captured = record(Array.from({ length: PERSISTED_HEIGHTS_MAX - 1 }, (_, i): [string, number] => [`n${i}`, 1]));
    const out = carryPersistedHeights(captured, record([["old0", 5], ["old1", 6]]));
    expect(out.entries).toHaveLength(PERSISTED_HEIGHTS_MAX);
    expect(out.entries[0]).toEqual(["old1", 6]);
  });
});

describe("coercePersistedHeights", () => {
  test("a well-formed record round-trips", () => {
    const record = { v: 1, ...SAMPLE, entries: [["a", 10]] };
    expect(coercePersistedHeights(JSON.parse(JSON.stringify(record)))).toEqual(record as never);
  });

  test("malformed input coerces to undefined", () => {
    expect(coercePersistedHeights(undefined)).toBeUndefined();
    expect(coercePersistedHeights(null)).toBeUndefined();
    expect(coercePersistedHeights("heights")).toBeUndefined();
    expect(coercePersistedHeights({ v: 2, ...SAMPLE, entries: [] })).toBeUndefined();
    expect(coercePersistedHeights({ v: 1, width: "640", zoomFactor: 1, rowGap: 12, entries: [] })).toBeUndefined();
    expect(coercePersistedHeights({ v: 1, ...SAMPLE, entries: {} })).toBeUndefined();
  });

  test("malformed entries are dropped one by one", () => {
    const r = coercePersistedHeights({
      v: 1,
      ...SAMPLE,
      entries: [["a", 10], ["b"], [3, 4], ["c", -1], ["d", Number.NaN], "e", ["f", 20]],
    });
    expect(r?.entries).toEqual([["a", 10], ["f", 20]]);
  });
});

describe("HeightIndex.markStale", () => {
  test("marks one held height stale and is a no-op for an index with none", () => {
    const idx = new HeightIndex();
    idx.set(0, 10);
    idx.set(1, 20);
    idx.markStale(0);
    idx.markStale(5);
    expect(idx.isFresh(0)).toBe(false);
    expect(idx.isFresh(1)).toBe(true);
    expect(idx.has(5)).toBe(false);
    expect(idx.staleCount()).toBe(1);
  });
});
