/**
 * find-trace.test — the find trace's ring semantics: the bounded buffer that
 * drops its oldest entry rather than growing, `dump({since})` against a
 * `mark()`, and the sample/gesture helpers the call sites record through.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  FIND_TRACE_CAPACITY,
  findTrace,
  inferFindGesture,
  sampleAround,
  type FindGestureSnapshot,
} from "../find-trace";

function recordDivergence(row: number): void {
  findTrace.record({
    kind: "divergence",
    cardId: "card-1",
    row,
    unit: 0,
    cause: "text",
    indexUnits: 1,
    domUnits: 1,
    firstDiffAt: 3,
    indexSample: "abc",
    domSample: "abd",
    healed: false,
  });
}

describe("findTrace ring", () => {
  beforeEach(() => {
    findTrace.clear();
  });

  test("holds capacity entries and drops the oldest on the next record", () => {
    for (let i = 0; i < FIND_TRACE_CAPACITY; i++) recordDivergence(i);
    const atCapacity = findTrace.dump();
    expect(atCapacity.length).toBe(FIND_TRACE_CAPACITY);
    expect(atCapacity[0]).toMatchObject({ kind: "divergence", row: 0 });

    // The 513th record drops the first.
    recordDivergence(FIND_TRACE_CAPACITY);
    const wrapped = findTrace.dump();
    expect(wrapped.length).toBe(FIND_TRACE_CAPACITY);
    expect(wrapped[0]).toMatchObject({ kind: "divergence", row: 1 });
    expect(wrapped[wrapped.length - 1]).toMatchObject({
      kind: "divergence",
      row: FIND_TRACE_CAPACITY,
    });
  });

  test("dump({since}) returns only what was recorded after the mark", () => {
    recordDivergence(0);
    recordDivergence(1);
    const m = findTrace.mark();
    recordDivergence(2);
    const after = findTrace.dump({ since: m });
    expect(after.length).toBe(1);
    expect(after[0]).toMatchObject({ row: 2 });
    // A bare dump is unfiltered.
    expect(findTrace.dump().length).toBe(3);
  });

  test("mark() returns the latest seq", () => {
    recordDivergence(0);
    const first = findTrace.mark();
    recordDivergence(1);
    const second = findTrace.mark();
    expect(second).toBe(first + 1);
    expect(findTrace.dump().map((e) => e.seq)).toEqual([first, second]);
  });

  test("clear() empties the ring without rewinding seq", () => {
    recordDivergence(0);
    const before = findTrace.mark();
    findTrace.clear();
    expect(findTrace.dump().length).toBe(0);
    expect(findTrace.mark()).toBe(before);
    recordDivergence(1);
    expect(findTrace.dump()[0].seq).toBe(before + 1);
  });

  test("record stamps seq and t and preserves the caller's fields", () => {
    findTrace.record({
      kind: "reveal",
      cardId: "card-1",
      navSeq: 4,
      target: { row: 7, segment: 0, start: 2, end: 5, kind: "dom" },
      outcome: "landed",
      reason: null,
      ms: 12,
      writes: 1,
    });
    const [event] = findTrace.dump();
    expect(event).toMatchObject({
      kind: "reveal",
      navSeq: 4,
      outcome: "landed",
      writes: 1,
    });
    expect(typeof event.seq).toBe("number");
    expect(typeof event.t).toBe("number");
  });
});

describe("sampleAround", () => {
  test("centres the window on the offset and clamps to the string", () => {
    const text = "0123456789".repeat(10);
    expect(sampleAround(text, 50)).toBe(text.slice(30, 70));
    expect(sampleAround(text, 0)).toBe(text.slice(0, 40));
    expect(sampleAround("short", 2)).toBe("short");
  });

  test("a negative offset (the unit-count cause) samples nothing", () => {
    expect(sampleAround("anything", -1)).toBe("");
  });
});

describe("inferFindGesture", () => {
  const base: FindGestureSnapshot = {
    query: "beta",
    caseSensitive: false,
    wholeWord: false,
    grep: false,
    activeOrdinal: 0,
    count: 3,
  };

  test("no previous snapshot is an attach", () => {
    expect(inferFindGesture(null, base)).toBe("attach");
  });

  test("a changed query outranks a moved ordinal", () => {
    expect(
      inferFindGesture(base, { ...base, query: "bet", activeOrdinal: 2 }),
    ).toBe("query");
  });

  test("a changed option is an options gesture", () => {
    expect(inferFindGesture(base, { ...base, caseSensitive: true })).toBe(
      "options",
    );
    expect(inferFindGesture(base, { ...base, grep: true })).toBe("options");
  });

  test("ordinal direction names next and previous", () => {
    expect(inferFindGesture(base, { ...base, activeOrdinal: 1 })).toBe("next");
    expect(
      inferFindGesture({ ...base, activeOrdinal: 2 }, { ...base, activeOrdinal: 1 }),
    ).toBe("previous");
  });

  test("a wrap is read as the direction that wraps, not the arithmetic", () => {
    // last → first is a forward wrap, even though the ordinal decreased.
    expect(
      inferFindGesture({ ...base, activeOrdinal: 2 }, { ...base, activeOrdinal: 0 }),
    ).toBe("next");
    // first → last is a backward wrap, even though the ordinal increased.
    expect(
      inferFindGesture({ ...base, activeOrdinal: 0 }, { ...base, activeOrdinal: 2 }),
    ).toBe("previous");
  });
});
