/**
 * Unit tests for BlockHeightIndex — Float64Array prefix sum data structure.
 *
 * Covers:
 * - getTotalHeight() matches sum of appended heights
 * - getBlockAtOffset() returns correct block for various scroll offsets
 * - getBlockOffset() returns correct Y offset for each block
 * - setHeight() correctly invalidates and recomputes prefix sum
 * - Binary search performance: 100K blocks, getBlockAtOffset() < 1ms
 * - Array growth: append beyond initial capacity, verify correctness
 * - clear() resets state
 * - Edge cases: empty index, single block, exact boundary offsets
 */

import { describe, it, expect } from "bun:test";
import { BlockHeightIndex, LINE_HEIGHT, HEADING_HEIGHTS, CODE_LINE_HEIGHT, HR_HEIGHT, CODE_HEADER_HEIGHT } from "../lib/block-height-index";

// ---------------------------------------------------------------------------
// Helpers

function buildIndex(heights: number[]): BlockHeightIndex {
  const idx = new BlockHeightIndex();
  for (const h of heights) {
    idx.appendBlock(h);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Constants

describe("height estimation constants", () => {
  it("LINE_HEIGHT is positive", () => {
    expect(LINE_HEIGHT).toBeGreaterThan(0);
  });

  it("CODE_LINE_HEIGHT is positive", () => {
    expect(CODE_LINE_HEIGHT).toBeGreaterThan(0);
  });

  it("CODE_HEADER_HEIGHT is positive", () => {
    expect(CODE_HEADER_HEIGHT).toBeGreaterThan(0);
  });

  it("HR_HEIGHT is positive", () => {
    expect(HR_HEIGHT).toBeGreaterThan(0);
  });

  it("HEADING_HEIGHTS has entries for levels 1-6", () => {
    for (let level = 1; level <= 6; level++) {
      expect(HEADING_HEIGHTS[level]).toBeGreaterThan(0);
    }
  });

  it("heading heights decrease from h1 to h6", () => {
    for (let level = 1; level < 6; level++) {
      expect(HEADING_HEIGHTS[level]).toBeGreaterThanOrEqual(HEADING_HEIGHTS[level + 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Empty index

describe("empty BlockHeightIndex", () => {
  it("count is 0", () => {
    const idx = new BlockHeightIndex();
    expect(idx.count).toBe(0);
  });

  it("getTotalHeight() returns 0", () => {
    const idx = new BlockHeightIndex();
    expect(idx.getTotalHeight()).toBe(0);
  });

  it("getBlockAtOffset(0) returns 0", () => {
    const idx = new BlockHeightIndex();
    expect(idx.getBlockAtOffset(0)).toBe(0);
  });

  it("getBlockAtOffset(large) returns 0", () => {
    const idx = new BlockHeightIndex();
    expect(idx.getBlockAtOffset(99999)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single block

describe("single block", () => {
  it("count is 1 after one append", () => {
    const idx = buildIndex([100]);
    expect(idx.count).toBe(1);
  });

  it("getTotalHeight() equals the block height", () => {
    const idx = buildIndex([100]);
    expect(idx.getTotalHeight()).toBe(100);
  });

  it("getBlockOffset(0) is 0", () => {
    const idx = buildIndex([100]);
    expect(idx.getBlockOffset(0)).toBe(0);
  });

  it("getBlockAtOffset(0) returns 0", () => {
    const idx = buildIndex([100]);
    expect(idx.getBlockAtOffset(0)).toBe(0);
  });

  it("getBlockAtOffset(50) returns 0 (within block)", () => {
    const idx = buildIndex([100]);
    expect(idx.getBlockAtOffset(50)).toBe(0);
  });

  it("getBlockAtOffset(99) returns 0 (last pixel of block)", () => {
    const idx = buildIndex([100]);
    expect(idx.getBlockAtOffset(99)).toBe(0);
  });

  it("getBlockAtOffset(100) returns 0 (past single block, clamped)", () => {
    const idx = buildIndex([100]);
    // Only one block; offset beyond end still returns last block (0)
    expect(idx.getBlockAtOffset(100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getTotalHeight

describe("getTotalHeight", () => {
  it("equals sum of all heights", () => {
    const heights = [24, 48, 20, 33, 100, 72];
    const idx = buildIndex(heights);
    const expected = heights.reduce((a, b) => a + b, 0);
    expect(idx.getTotalHeight()).toBe(expected);
  });

  it("updates after setHeight()", () => {
    const idx = buildIndex([100, 200]);
    idx.setHeight(0, 150);
    expect(idx.getTotalHeight()).toBe(350);
  });
});

// ---------------------------------------------------------------------------
// getBlockOffset

describe("getBlockOffset", () => {
  it("block 0 is always at offset 0", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockOffset(0)).toBe(0);
  });

  it("block 1 starts after block 0", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockOffset(1)).toBe(50);
  });

  it("block 2 starts after blocks 0+1", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockOffset(2)).toBe(150);
  });

  it("offset at count equals getTotalHeight()", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockOffset(3)).toBe(225);
    expect(idx.getBlockOffset(3)).toBe(idx.getTotalHeight());
  });

  it("updates after setHeight()", () => {
    const idx = buildIndex([50, 100, 75]);
    idx.setHeight(0, 80);
    expect(idx.getBlockOffset(1)).toBe(80);
    expect(idx.getBlockOffset(2)).toBe(180);
  });
});

// ---------------------------------------------------------------------------
// getBlockAtOffset — boundary cases

describe("getBlockAtOffset", () => {
  it("returns 0 for offset 0", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockAtOffset(0)).toBe(0);
  });

  it("returns 0 for offset within first block", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockAtOffset(49)).toBe(0);
  });

  it("returns 1 for offset at exact start of second block", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockAtOffset(50)).toBe(1);
  });

  it("returns 1 for offset within second block", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockAtOffset(100)).toBe(1);
  });

  it("returns 2 for offset at exact start of third block", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockAtOffset(150)).toBe(2);
  });

  it("returns 2 for offset within third block", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockAtOffset(200)).toBe(2);
  });

  it("returns last block for offset past total height", () => {
    const idx = buildIndex([50, 100, 75]);
    expect(idx.getBlockAtOffset(9999)).toBe(2);
  });

  it("handles uniform block heights correctly", () => {
    // 10 blocks of height 100 each
    const idx = buildIndex(Array(10).fill(100));
    expect(idx.getBlockAtOffset(0)).toBe(0);
    expect(idx.getBlockAtOffset(99)).toBe(0);
    expect(idx.getBlockAtOffset(100)).toBe(1);
    expect(idx.getBlockAtOffset(500)).toBe(5);
    expect(idx.getBlockAtOffset(999)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// setHeight — dirty invalidation

describe("setHeight", () => {
  it("updates getTotalHeight() after change", () => {
    const idx = buildIndex([100, 200, 300]);
    idx.setHeight(1, 250);
    expect(idx.getTotalHeight()).toBe(650);
  });

  it("updates getBlockOffset() for blocks after changed index", () => {
    const idx = buildIndex([100, 200, 300]);
    idx.setHeight(0, 50);
    expect(idx.getBlockOffset(1)).toBe(50);
    expect(idx.getBlockOffset(2)).toBe(250);
    expect(idx.getBlockOffset(3)).toBe(550);
  });

  it("updates getBlockAtOffset() after height change", () => {
    const idx = buildIndex([100, 100, 100]);
    // Verify initial state
    expect(idx.getBlockAtOffset(150)).toBe(1);
    // Double first block height
    idx.setHeight(0, 200);
    // Block 1 now starts at offset 200
    expect(idx.getBlockAtOffset(150)).toBe(0);
    expect(idx.getBlockAtOffset(200)).toBe(1);
  });

  it("multiple setHeight() calls converge correctly", () => {
    const idx = buildIndex([100, 100, 100]);
    idx.setHeight(0, 50);
    idx.setHeight(1, 75);
    idx.setHeight(2, 25);
    expect(idx.getTotalHeight()).toBe(150);
    expect(idx.getBlockOffset(1)).toBe(50);
    expect(idx.getBlockOffset(2)).toBe(125);
  });

  it("getHeight() returns updated value", () => {
    const idx = buildIndex([100]);
    idx.setHeight(0, 42);
    expect(idx.getHeight(0)).toBe(42);
  });

  it("throws on out-of-range index", () => {
    const idx = buildIndex([100]);
    expect(() => idx.setHeight(1, 50)).toThrow(RangeError);
    expect(() => idx.setHeight(-1, 50)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// clear

describe("clear", () => {
  it("resets count to 0", () => {
    const idx = buildIndex([100, 200, 300]);
    idx.clear();
    expect(idx.count).toBe(0);
  });

  it("getTotalHeight() returns 0 after clear", () => {
    const idx = buildIndex([100, 200, 300]);
    idx.clear();
    expect(idx.getTotalHeight()).toBe(0);
  });

  it("can append blocks after clear", () => {
    const idx = buildIndex([100, 200]);
    idx.clear();
    idx.appendBlock(50);
    idx.appendBlock(75);
    expect(idx.count).toBe(2);
    expect(idx.getTotalHeight()).toBe(125);
    expect(idx.getBlockOffset(0)).toBe(0);
    expect(idx.getBlockOffset(1)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// truncate

describe("truncate", () => {
  it("reduces count to newCount", () => {
    const idx = buildIndex([100, 200, 300, 400, 500]);
    idx.truncate(3);
    expect(idx.count).toBe(3);
  });

  it("totalHeight() reflects only the first newCount blocks", () => {
    const idx = buildIndex([100, 200, 300, 400, 500]);
    idx.truncate(3);
    // Only first 3 blocks: 100 + 200 + 300 = 600
    expect(idx.getTotalHeight()).toBe(600);
  });

  it("getBlockOffset() is correct after truncate", () => {
    const idx = buildIndex([100, 200, 300, 400, 500]);
    idx.truncate(3);
    expect(idx.getBlockOffset(0)).toBe(0);
    expect(idx.getBlockOffset(1)).toBe(100);
    expect(idx.getBlockOffset(2)).toBe(300);
    expect(idx.getBlockOffset(3)).toBe(600);
  });

  it("can append blocks after truncate", () => {
    const idx = buildIndex([100, 200, 300, 400, 500]);
    idx.truncate(2);
    idx.appendBlock(50);
    expect(idx.count).toBe(3);
    expect(idx.getTotalHeight()).toBe(350);
    expect(idx.getBlockOffset(2)).toBe(300);
  });

  it("truncate to 0 behaves like clear", () => {
    const idx = buildIndex([100, 200, 300]);
    idx.truncate(0);
    expect(idx.count).toBe(0);
    expect(idx.getTotalHeight()).toBe(0);
  });

  it("truncate to same count is a no-op", () => {
    const idx = buildIndex([100, 200, 300]);
    idx.truncate(3);
    expect(idx.count).toBe(3);
    expect(idx.getTotalHeight()).toBe(600);
  });

  it("throws RangeError for newCount < 0", () => {
    const idx = buildIndex([100, 200]);
    expect(() => idx.truncate(-1)).toThrow(RangeError);
  });

  it("throws RangeError for newCount > count", () => {
    const idx = buildIndex([100, 200]);
    expect(() => idx.truncate(3)).toThrow(RangeError);
  });

  it("truncate to 5 from 10 leaves first 5 blocks intact", () => {
    const heights = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const idx = buildIndex(heights);
    idx.truncate(5);
    expect(idx.count).toBe(5);
    // totalHeight = 10+20+30+40+50 = 150
    expect(idx.getTotalHeight()).toBe(150);
    // Verify each block offset is still correct
    expect(idx.getBlockOffset(0)).toBe(0);
    expect(idx.getBlockOffset(1)).toBe(10);
    expect(idx.getBlockOffset(2)).toBe(30);
    expect(idx.getBlockOffset(3)).toBe(60);
    expect(idx.getBlockOffset(4)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Array growth

describe("array growth beyond initial capacity", () => {
  it("correctness after growing past initial capacity of 4", () => {
    const idx = new BlockHeightIndex(4);
    // Append 8 blocks — forces two doublings (4 -> 8 -> 16 not needed, just one)
    const heights = [10, 20, 30, 40, 50, 60, 70, 80];
    for (const h of heights) {
      idx.appendBlock(h);
    }
    expect(idx.count).toBe(8);
    expect(idx.getTotalHeight()).toBe(360);

    // Verify offsets
    let cumulative = 0;
    for (let i = 0; i < heights.length; i++) {
      expect(idx.getBlockOffset(i)).toBe(cumulative);
      cumulative += heights[i];
    }
  });

  it("setHeight() works correctly after growth", () => {
    const idx = new BlockHeightIndex(2);
    for (let i = 0; i < 6; i++) {
      idx.appendBlock(100);
    }
    idx.setHeight(3, 200);
    expect(idx.getTotalHeight()).toBe(700);
    expect(idx.getBlockOffset(4)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// shiftFrom

describe("shiftFrom", () => {
  it("shiftFrom right by 2 from middle — heights before shift point unchanged, heights after moved, count increased", () => {
    // Heights: [10, 20, 30, 40, 50]  count=5
    // shiftFrom(2, 2) opens a gap at indices 2,3; old [2..4] move to [4..6]
    // After: count=7, heights[0]=10, heights[1]=20, heights[4]=30, heights[5]=40, heights[6]=50
    // heights[2] and heights[3] are uninitialized (caller sets them)
    const idx = buildIndex([10, 20, 30, 40, 50]);
    idx.shiftFrom(2, 2);

    expect(idx.count).toBe(7);
    // Heights before shift point unchanged
    expect(idx.getHeight(0)).toBe(10);
    expect(idx.getHeight(1)).toBe(20);
    // Heights after shift point moved
    expect(idx.getHeight(4)).toBe(30);
    expect(idx.getHeight(5)).toBe(40);
    expect(idx.getHeight(6)).toBe(50);
  });

  it("shiftFrom right by 2 — prefix sum and offsets are correct after setting gap entries", () => {
    const idx = buildIndex([10, 20, 30, 40, 50]);
    idx.shiftFrom(2, 2);
    // Fill the gap
    idx.setHeight(2, 15);
    idx.setHeight(3, 25);

    // Heights: [10, 20, 15, 25, 30, 40, 50]
    expect(idx.getTotalHeight()).toBe(190);
    expect(idx.getBlockOffset(0)).toBe(0);
    expect(idx.getBlockOffset(1)).toBe(10);
    expect(idx.getBlockOffset(2)).toBe(30);
    expect(idx.getBlockOffset(3)).toBe(45);
    expect(idx.getBlockOffset(4)).toBe(70);
    expect(idx.getBlockOffset(5)).toBe(100);
    expect(idx.getBlockOffset(6)).toBe(140);
    expect(idx.getBlockOffset(7)).toBe(190);
  });

  it("shiftFrom left by 1 from middle — heights compacted, count decreased", () => {
    // Heights: [10, 20, 30, 40, 50]  count=5
    // shiftFrom(2, -1) removes entry at index 1; old [2..4] move to [1..3]
    // After: count=4, heights[0]=10, heights[1]=30, heights[2]=40, heights[3]=50
    const idx = buildIndex([10, 20, 30, 40, 50]);
    idx.shiftFrom(2, -1);

    expect(idx.count).toBe(4);
    expect(idx.getHeight(0)).toBe(10);
    expect(idx.getHeight(1)).toBe(30);
    expect(idx.getHeight(2)).toBe(40);
    expect(idx.getHeight(3)).toBe(50);
  });

  it("shiftFrom left by 1 — total height correct after compaction", () => {
    const idx = buildIndex([10, 20, 30, 40, 50]);
    idx.shiftFrom(2, -1);
    // Heights: [10, 30, 40, 50] — sum = 130
    expect(idx.getTotalHeight()).toBe(130);
    expect(idx.getBlockOffset(0)).toBe(0);
    expect(idx.getBlockOffset(1)).toBe(10);
    expect(idx.getBlockOffset(2)).toBe(40);
    expect(idx.getBlockOffset(3)).toBe(80);
    expect(idx.getBlockOffset(4)).toBe(130);
  });

  it("shiftFrom with capacity growth — handles delta > remaining capacity", () => {
    // Start with capacity 4, fill it, then shift right by 4 to force growth
    const idx = new BlockHeightIndex(4);
    idx.appendBlock(10);
    idx.appendBlock(20);
    idx.appendBlock(30);
    idx.appendBlock(40);
    // count=4, capacity=4 — shiftFrom(2, 4) needs count+4=8 which exceeds capacity
    idx.shiftFrom(2, 4);

    expect(idx.count).toBe(8);
    // Heights before shift unchanged
    expect(idx.getHeight(0)).toBe(10);
    expect(idx.getHeight(1)).toBe(20);
    // Heights after shift moved: old index 2 -> new index 6, old index 3 -> new index 7
    expect(idx.getHeight(6)).toBe(30);
    expect(idx.getHeight(7)).toBe(40);
  });

  it("shiftFrom from index 0 right — all existing heights shifted", () => {
    const idx = buildIndex([10, 20, 30]);
    idx.shiftFrom(0, 2);
    expect(idx.count).toBe(5);
    expect(idx.getHeight(2)).toBe(10);
    expect(idx.getHeight(3)).toBe(20);
    expect(idx.getHeight(4)).toBe(30);
  });

  it("shiftFrom from end index — no heights moved, count changes", () => {
    const idx = buildIndex([10, 20, 30]);
    // startIndex == count: shift from the tail, like appending slots
    idx.shiftFrom(3, 2);
    expect(idx.count).toBe(5);
    // Existing heights unchanged
    expect(idx.getHeight(0)).toBe(10);
    expect(idx.getHeight(1)).toBe(20);
    expect(idx.getHeight(2)).toBe(30);
  });

  it("shiftFrom with delta 0 is a no-op", () => {
    const idx = buildIndex([10, 20, 30]);
    idx.shiftFrom(1, 0);
    expect(idx.count).toBe(3);
    expect(idx.getTotalHeight()).toBe(60);
  });

  it("shiftFrom throws RangeError for startIndex out of range", () => {
    const idx = buildIndex([10, 20, 30]);
    expect(() => idx.shiftFrom(-1, 1)).toThrow(RangeError);
    expect(() => idx.shiftFrom(4, 1)).toThrow(RangeError);
  });

  it("shiftFrom throws RangeError if delta would make count negative", () => {
    const idx = buildIndex([10, 20, 30]);
    // shiftFrom(0, -4) would make count = 3 - 4 = -1
    expect(() => idx.shiftFrom(0, -4)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Binary search

describe("binary search", () => {
  it("finds the block at a mid offset in a 100K index", () => {
    const N = 100_000;
    const idx = new BlockHeightIndex(N);
    for (let i = 0; i < N; i++) {
      idx.appendBlock(24); // LINE_HEIGHT
    }

    const totalHeight = idx.getTotalHeight();
    const midOffset = totalHeight / 2;

    const result = idx.getBlockAtOffset(midOffset);

    // Mid offset should land near block 50000
    expect(result).toBeGreaterThan(49990);
    expect(result).toBeLessThan(50010);
  });
});
