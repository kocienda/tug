/**
 * list-view-height-index — pure-class tests.
 *
 * Pins the `HeightIndex` API: insert / update / delete, total /
 * offset / indexForOffset, plus the documented edge cases (empty,
 * all-measured, all-unmeasured, mixed, defensive-input).
 */

import { describe, expect, test } from "bun:test";

import { HeightIndex } from "../list-view-height-index";

const fixed = (h: number) => () => h;

describe("HeightIndex — basic operations", () => {
  test("set / get / has", () => {
    const idx = new HeightIndex();
    expect(idx.has(0)).toBe(false);
    expect(idx.get(0)).toBeUndefined();
    expect(idx.size).toBe(0);

    idx.set(0, 42);
    expect(idx.has(0)).toBe(true);
    expect(idx.get(0)).toBe(42);
    expect(idx.size).toBe(1);

    // update — same key, new value
    idx.set(0, 99);
    expect(idx.get(0)).toBe(99);
    expect(idx.size).toBe(1);
  });

  test("delete returns boolean and removes the entry", () => {
    const idx = new HeightIndex();
    idx.set(3, 17);
    expect(idx.delete(3)).toBe(true);
    expect(idx.has(3)).toBe(false);
    expect(idx.delete(3)).toBe(false);
  });

  test("clear drops every entry", () => {
    const idx = new HeightIndex();
    idx.set(0, 10);
    idx.set(1, 20);
    idx.set(5, 50);
    expect(idx.size).toBe(3);
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.get(0)).toBeUndefined();
  });
});

describe("HeightIndex — defensive inputs", () => {
  test("ignores negative heights", () => {
    const idx = new HeightIndex();
    idx.set(0, -10);
    expect(idx.has(0)).toBe(false);
  });

  test("ignores non-finite heights", () => {
    const idx = new HeightIndex();
    idx.set(0, Number.POSITIVE_INFINITY);
    idx.set(1, Number.NEGATIVE_INFINITY);
    idx.set(2, Number.NaN);
    expect(idx.size).toBe(0);
  });

  test("accepts zero as a valid measured height", () => {
    const idx = new HeightIndex();
    idx.set(0, 0);
    expect(idx.has(0)).toBe(true);
    expect(idx.get(0)).toBe(0);
  });
});

describe("HeightIndex — totalHeight", () => {
  test("empty index ⇒ totalHeight(0) is 0 regardless of estimate", () => {
    const idx = new HeightIndex();
    expect(idx.totalHeight(0, fixed(40))).toBe(0);
  });

  test("all unmeasured ⇒ total = itemCount × estimate", () => {
    const idx = new HeightIndex();
    expect(idx.totalHeight(5, fixed(40))).toBe(200);
  });

  test("all measured ⇒ total = sum of measured", () => {
    const idx = new HeightIndex();
    [10, 20, 30, 40, 50].forEach((h, i) => idx.set(i, h));
    expect(idx.totalHeight(5, fixed(0))).toBe(150);
  });

  test("mixed ⇒ measured wins for known, estimate fills the rest", () => {
    const idx = new HeightIndex();
    idx.set(1, 100); // measured
    idx.set(3, 200); // measured
    // indices 0, 2, 4 fall back to estimate 40
    expect(idx.totalHeight(5, fixed(40))).toBe(40 + 100 + 40 + 200 + 40);
  });

  test("variable estimates per index", () => {
    const idx = new HeightIndex();
    const estimates = [10, 20, 30, 40, 50];
    expect(idx.totalHeight(estimates.length, (i) => estimates[i])).toBe(150);
  });
});

describe("HeightIndex — offsetForIndex", () => {
  test("offset for index 0 is always 0", () => {
    const idx = new HeightIndex();
    idx.set(0, 100);
    expect(idx.offsetForIndex(0, fixed(40))).toBe(0);
  });

  test("offset for last index = total minus that item's height", () => {
    const idx = new HeightIndex();
    [10, 20, 30, 40, 50].forEach((h, i) => idx.set(i, h));
    expect(idx.offsetForIndex(4, fixed(0))).toBe(100); // 10+20+30+40
    expect(idx.offsetForIndex(5, fixed(0))).toBe(150); // total
  });

  test("all unmeasured ⇒ offsets are linear in estimate", () => {
    const idx = new HeightIndex();
    expect(idx.offsetForIndex(3, fixed(40))).toBe(120);
  });

  test("mixed measured + unmeasured", () => {
    const idx = new HeightIndex();
    idx.set(0, 100);
    idx.set(2, 50);
    // [0]=100, [1]=40 (estimate), [2]=50 → offset for 3 is 190
    expect(idx.offsetForIndex(3, fixed(40))).toBe(190);
  });

  test("negative index clamps to 0", () => {
    const idx = new HeightIndex();
    idx.set(0, 100);
    expect(idx.offsetForIndex(-5, fixed(40))).toBe(0);
  });
});

describe("HeightIndex — indexForOffset", () => {
  test("offset 0 ⇒ index 0", () => {
    const idx = new HeightIndex();
    expect(idx.indexForOffset(0, 5, fixed(40))).toBe(0);
  });

  test("offset inside the first cell ⇒ index 0", () => {
    const idx = new HeightIndex();
    expect(idx.indexForOffset(20, 5, fixed(40))).toBe(0);
  });

  test("offset at exact cell boundary ⇒ next index (cell containing boundary pixel)", () => {
    const idx = new HeightIndex();
    // cell 0: [0,40), cell 1: [40,80) — offset 40 lives in cell 1.
    expect(idx.indexForOffset(40, 5, fixed(40))).toBe(1);
  });

  test("offset past the last cell ⇒ clamps to itemCount - 1", () => {
    const idx = new HeightIndex();
    expect(idx.indexForOffset(99999, 5, fixed(40))).toBe(4);
  });

  test("itemCount === 0 ⇒ 0", () => {
    const idx = new HeightIndex();
    expect(idx.indexForOffset(100, 0, fixed(40))).toBe(0);
  });

  test("negative offset ⇒ 0", () => {
    const idx = new HeightIndex();
    expect(idx.indexForOffset(-10, 5, fixed(40))).toBe(0);
  });

  test("variable measured + estimate fallback", () => {
    const idx = new HeightIndex();
    idx.set(0, 100); // [0, 100)
    idx.set(1, 50);  // [100, 150)
    // index 2 unmeasured (estimate 40) → [150, 190)
    // index 3 unmeasured → [190, 230)
    expect(idx.indexForOffset(50, 4, fixed(40))).toBe(0);
    expect(idx.indexForOffset(120, 4, fixed(40))).toBe(1);
    expect(idx.indexForOffset(160, 4, fixed(40))).toBe(2);
    expect(idx.indexForOffset(195, 4, fixed(40))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fenwick fast path — prepared reads
// ---------------------------------------------------------------------------
//
// `prepare(itemCount, estimateFn)` builds an internal Fenwick tree so
// subsequent `totalHeight` / `offsetForIndex` / `indexForOffset` calls
// run in O(log n) (or O(1) for `totalHeight`'s prefix-sum root). The
// stateless API is preserved; reads check whether the cache is valid
// for the supplied args and either use it (fast path) or fall back to
// the linear walk (slow path). Both paths must agree on every result.

describe("HeightIndex — prepared (Fenwick) fast path", () => {
  const cases: Array<{
    name: string;
    setup: (idx: HeightIndex) => void;
    itemCount: number;
    estimate: (i: number) => number;
  }> = [
    {
      name: "all unmeasured",
      setup: () => undefined,
      itemCount: 8,
      estimate: fixed(40),
    },
    {
      name: "all measured uniform",
      setup: (idx) => {
        for (let i = 0; i < 8; i += 1) idx.set(i, 30);
      },
      itemCount: 8,
      estimate: fixed(40),
    },
    {
      name: "mixed measured + estimate",
      setup: (idx) => {
        idx.set(1, 100);
        idx.set(3, 200);
        idx.set(5, 50);
      },
      itemCount: 8,
      estimate: fixed(40),
    },
    {
      name: "variable estimates",
      setup: (idx) => {
        idx.set(2, 100);
      },
      itemCount: 6,
      estimate: (i) => 10 + i * 5,
    },
  ];

  test.each(cases)(
    "$name — totalHeight / offsetForIndex / indexForOffset agree with linear path",
    ({ setup, itemCount, estimate }) => {
      const linear = new HeightIndex();
      const prepared = new HeightIndex();
      setup(linear);
      setup(prepared);
      prepared.prepare(itemCount, estimate);

      expect(prepared.totalHeight(itemCount, estimate)).toBe(
        linear.totalHeight(itemCount, estimate),
      );

      for (let i = 0; i <= itemCount; i += 1) {
        expect(prepared.offsetForIndex(i, estimate)).toBe(
          linear.offsetForIndex(i, estimate),
        );
      }

      const total = linear.totalHeight(itemCount, estimate);
      const probes = [-1, 0, 1, total / 2, total - 1, total, total + 100];
      for (const offset of probes) {
        expect(prepared.indexForOffset(offset, itemCount, estimate)).toBe(
          linear.indexForOffset(offset, itemCount, estimate),
        );
      }
    },
  );

  test("set after prepare patches the Fenwick tree (no rebuild needed)", () => {
    const idx = new HeightIndex();
    const est = fixed(40);
    idx.prepare(8, est);
    // Initial total = 8 × 40 = 320.
    expect(idx.totalHeight(8, est)).toBe(320);

    // Patch in a measurement; cache stays valid, total updates by delta.
    idx.set(3, 100);
    expect(idx.totalHeight(8, est)).toBe(320 - 40 + 100);
    expect(idx.offsetForIndex(4, est)).toBe(40 + 40 + 40 + 100);

    // Replace the same index with a different value.
    idx.set(3, 25);
    expect(idx.totalHeight(8, est)).toBe(320 - 40 + 25);
  });

  test("delete after prepare reverts the Fenwick slot to the estimate", () => {
    const idx = new HeightIndex();
    const est = fixed(40);
    idx.set(2, 100);
    idx.prepare(5, est);
    expect(idx.totalHeight(5, est)).toBe(40 + 40 + 100 + 40 + 40);

    idx.delete(2);
    expect(idx.totalHeight(5, est)).toBe(5 * 40);
  });

  test("clear invalidates the cache; next prepare rebuilds from estimates", () => {
    const idx = new HeightIndex();
    const est = fixed(40);
    idx.set(0, 200);
    idx.prepare(3, est);
    expect(idx.totalHeight(3, est)).toBe(200 + 40 + 40);

    idx.clear();
    // Without re-preparing, reads use the linear fallback against the
    // now-empty heights map: every index falls back to the estimate.
    expect(idx.totalHeight(3, est)).toBe(3 * 40);

    // Re-preparing rebuilds from the estimate-only effective array.
    idx.prepare(3, est);
    expect(idx.totalHeight(3, est)).toBe(3 * 40);
  });

  test("cache invalidates when itemCount or estimate identity changes", () => {
    const idx = new HeightIndex();
    const estA = fixed(40);
    const estB = fixed(80);

    idx.set(1, 100);
    idx.prepare(4, estA);
    expect(idx.totalHeight(4, estA)).toBe(40 + 100 + 40 + 40);

    // Different estimate fn: linear fallback still produces the right
    // value (which is also what we'd get if we re-prepared).
    expect(idx.totalHeight(4, estB)).toBe(80 + 100 + 80 + 80);

    idx.prepare(4, estB);
    expect(idx.totalHeight(4, estB)).toBe(80 + 100 + 80 + 80);

    // itemCount change: legacy fallback still right; re-prepare also
    // right.
    expect(idx.totalHeight(6, estB)).toBe(80 * 5 + 100);
    idx.prepare(6, estB);
    expect(idx.totalHeight(6, estB)).toBe(80 * 5 + 100);
  });

  test("set out of prepared range falls back; next prepare absorbs it", () => {
    const idx = new HeightIndex();
    const est = fixed(40);
    idx.prepare(5, est);
    // Index 99 is outside the prepared [0, 5) range — the cache is
    // not patched, but the heights map records the value.
    idx.set(99, 999);
    expect(idx.get(99)).toBe(999);
    // totalHeight(5) ignores out-of-range entries, same as today.
    expect(idx.totalHeight(5, est)).toBe(5 * 40);

    // A larger prepare picks up the out-of-range measurement.
    idx.prepare(100, est);
    // 99 entries at estimate 40 + one measurement of 999.
    expect(idx.totalHeight(100, est)).toBe(99 * 40 + 999);
  });

  test("preparing twice with same args is a no-op (cached state preserved)", () => {
    const idx = new HeightIndex();
    const est = fixed(40);
    idx.prepare(3, est);
    idx.set(1, 100);
    // Cache is patched — totalHeight reflects the measurement.
    expect(idx.totalHeight(3, est)).toBe(40 + 100 + 40);
    // Same-args prepare must NOT clobber the patched state.
    idx.prepare(3, est);
    expect(idx.totalHeight(3, est)).toBe(40 + 100 + 40);
  });
});

describe("HeightIndex — shift (prepend remap)", () => {
  const est = () => 10;

  test("remaps measured heights by +by, leaving values intact", () => {
    const idx = new HeightIndex();
    idx.set(0, 100);
    idx.set(1, 200);
    idx.set(2, 300);

    idx.shift(2);

    // Old indices 0,1,2 now live at 2,3,4 with the same heights.
    expect(idx.get(0)).toBeUndefined();
    expect(idx.get(1)).toBeUndefined();
    expect(idx.get(2)).toBe(100);
    expect(idx.get(3)).toBe(200);
    expect(idx.get(4)).toBe(300);
    expect(idx.size).toBe(3);
  });

  test("offsets after shift account for the now-unmeasured front rows", () => {
    const idx = new HeightIndex();
    idx.set(0, 100);
    idx.set(1, 100);
    // Before shift: offset of index 2 is 200.
    expect(idx.offsetForIndex(2, est)).toBe(200);

    idx.shift(2);
    idx.prepare(4, est);
    // Two new front rows fall back to the estimate (10 each); the
    // measured pair now sits at 2,3.
    expect(idx.offsetForIndex(2, est)).toBe(20); // 10 + 10
    expect(idx.totalHeight(4, est)).toBe(10 + 10 + 100 + 100);
  });

  test("shift(0) and negative are no-ops; empty index is a no-op", () => {
    const idx = new HeightIndex();
    idx.set(0, 42);
    idx.shift(0);
    expect(idx.get(0)).toBe(42);
    idx.shift(-3);
    expect(idx.get(0)).toBe(42);

    const empty = new HeightIndex();
    empty.shift(5);
    expect(empty.size).toBe(0);
  });
});

describe("HeightIndex — adjustAll patches the prepared cache in place", () => {
  const est = fixed(60);

  /** A fresh instance holding the same measured entries as `src`, prepared. */
  const freshTwin = (src: HeightIndex, itemCount: number): HeightIndex => {
    const twin = new HeightIndex();
    for (let i = 0; i < itemCount; i += 1) {
      const h = src.get(i);
      if (h !== undefined) twin.set(i, h);
    }
    twin.prepare(itemCount, est);
    return twin;
  };

  const expectParity = (
    idx: HeightIndex,
    twin: HeightIndex,
    itemCount: number,
  ): void => {
    expect(idx.totalHeight(itemCount, est)).toBe(
      twin.totalHeight(itemCount, est),
    );
    for (let i = 0; i <= itemCount; i += 1) {
      expect(idx.offsetForIndex(i, est)).toBe(twin.offsetForIndex(i, est));
    }
    const total = twin.totalHeight(itemCount, est);
    for (let px = 0; px <= total; px += 7) {
      expect(idx.indexForOffset(px, itemCount, est)).toBe(
        twin.indexForOffset(px, itemCount, est),
      );
    }
  };

  test("positive delta: reads agree with a freshly-prepared twin", () => {
    const idx = new HeightIndex();
    idx.set(0, 100);
    idx.set(2, 50);
    idx.set(4, 80);
    idx.prepare(6, est);

    idx.adjustAll(8);
    expectParity(idx, freshTwin(idx, 6), 6);
    expect(idx.get(0)).toBe(108);
    expect(idx.get(2)).toBe(58);
  });

  test("negative delta with clamp-at-0 entries", () => {
    const idx = new HeightIndex();
    idx.set(0, 3); // clamps to 0 under -8
    idx.set(1, 100);
    idx.set(3, 8); // clamps exactly to 0
    idx.prepare(5, est);

    idx.adjustAll(-8);
    expect(idx.get(0)).toBe(0);
    expect(idx.get(3)).toBe(0);
    expect(idx.get(1)).toBe(92);
    expectParity(idx, freshTwin(idx, 5), 5);
  });

  test("unmeasured indices keep the estimate through the rebuild", () => {
    const idx = new HeightIndex();
    idx.set(1, 40);
    idx.prepare(4, est);

    idx.adjustAll(5);
    // Indices 0, 2, 3 are unmeasured: still the 60px estimate.
    expect(idx.offsetForIndex(1, est)).toBe(60);
    expect(idx.offsetForIndex(2, est)).toBe(60 + 45);
    expect(idx.totalHeight(4, est)).toBe(60 * 3 + 45);
    expectParity(idx, freshTwin(idx, 4), 4);
  });

  test("measured entries outside the prepared range adjust without touching the cache", () => {
    const idx = new HeightIndex();
    idx.set(0, 30);
    idx.set(9, 70); // beyond the prepared range
    idx.prepare(4, est);

    idx.adjustAll(10);
    expect(idx.get(9)).toBe(80);
    expectParity(idx, freshTwin(idx, 4), 4);
  });

  test("no-cache path is unchanged (map-only rebase)", () => {
    const idx = new HeightIndex();
    idx.set(0, 30);
    idx.set(1, 40);
    idx.adjustAll(6);
    expect(idx.get(0)).toBe(36);
    expect(idx.get(1)).toBe(46);
    expect(idx.totalHeight(3, est)).toBe(36 + 46 + 60);
  });

  test("set after adjustAll still patches the tree consistently", () => {
    const idx = new HeightIndex();
    idx.set(0, 100);
    idx.set(1, 100);
    idx.prepare(3, est);
    idx.adjustAll(12);
    idx.set(1, 200);
    expectParity(idx, freshTwin(idx, 3), 3);
  });
});
