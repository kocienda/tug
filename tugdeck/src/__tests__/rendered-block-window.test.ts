/**
 * Unit tests for RenderedBlockWindow — sliding window viewport manager.
 *
 * Covers:
 * - Initial update at scrollTop=0 returns correct range with overscan
 * - Scroll down: enter/exit ranges are correct (new blocks enter at bottom, old exit at top)
 * - Scroll up: symmetric behavior
 * - Large jump (scroll to middle): full window replacement
 * - Dirty tracking: mark, check, clear cycle
 * - Spacer heights match expected values from prefix sum
 * - Viewport resize triggers correct range recalculation
 * - Edge cases: empty index, single block, overscan=0
 */

import { describe, it, expect } from "bun:test";
import { BlockHeightIndex } from "../lib/block-height-index";
import { RenderedBlockWindow } from "../lib/rendered-block-window";
import type { BlockRange } from "../lib/rendered-block-window";

// ---------------------------------------------------------------------------
// Helpers

/** Build a BlockHeightIndex with N blocks of equal height. */
function buildEqualIndex(count: number, height: number): BlockHeightIndex {
  const idx = new BlockHeightIndex(Math.max(count, 1));
  for (let i = 0; i < count; i++) {
    idx.appendBlock(height);
  }
  return idx;
}

/** Collect all indices covered by an array of ranges. */
function collectIndices(ranges: BlockRange[]): number[] {
  const out: number[] = [];
  for (const r of ranges) {
    for (let i = r.startIndex; i < r.endIndex; i++) {
      out.push(i);
    }
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Empty index

describe("empty BlockHeightIndex", () => {
  it("update() returns no enter/exit and zero spacers", () => {
    const idx = new BlockHeightIndex();
    const win = new RenderedBlockWindow(idx, 600);
    const result = win.update(0);
    expect(result.enter).toHaveLength(0);
    expect(result.exit).toHaveLength(0);
    expect(result.topSpacerHeight).toBe(0);
    expect(result.bottomSpacerHeight).toBe(0);
  });

  it("currentRange is [0,0) after update on empty index", () => {
    const idx = new BlockHeightIndex();
    const win = new RenderedBlockWindow(idx, 600);
    win.update(0);
    expect(win.currentRange).toEqual({ startIndex: 0, endIndex: 0 });
  });
});

// ---------------------------------------------------------------------------
// Single block

describe("single block", () => {
  it("update() at scrollTop=0 includes the block", () => {
    const idx = buildEqualIndex(1, 200);
    const win = new RenderedBlockWindow(idx, 600, 0); // overscan=0 for simplicity
    const result = win.update(0);
    const entered = collectIndices(result.enter);
    expect(entered).toContain(0);
    expect(result.topSpacerHeight).toBe(0);
    expect(result.bottomSpacerHeight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Initial update at scrollTop=0 with overscan

describe("initial update at scrollTop=0", () => {
  it("includes visible blocks plus overscan blocks", () => {
    // 100 blocks of 100px height each = 10000px total
    // Viewport = 600px, overscan = 2 screens = 1200px above + below
    // At scrollTop=0: visible [0,6), overscan below = [0, 18) ≈ 18 blocks
    const idx = buildEqualIndex(100, 100);
    const win = new RenderedBlockWindow(idx, 600, 2);
    const result = win.update(0);

    const entered = collectIndices(result.enter);
    // Should include at least the visible blocks (0-5)
    expect(entered).toContain(0);
    expect(entered).toContain(5);
    // The top spacer should be 0 since we start at block 0
    expect(result.topSpacerHeight).toBe(0);
    // Bottom spacer should be positive (not all blocks rendered)
    expect(result.bottomSpacerHeight).toBeGreaterThan(0);
    // No blocks exit on first update
    expect(result.exit).toHaveLength(0);
  });

  it("currentRange matches entered blocks after initial update", () => {
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 2);
    const result = win.update(0);
    const { startIndex, endIndex } = win.currentRange;
    // All entered indices should be within [startIndex, endIndex)
    for (const r of result.enter) {
      expect(r.startIndex).toBeGreaterThanOrEqual(startIndex);
      expect(r.endIndex).toBeLessThanOrEqual(endIndex);
    }
  });
});

// ---------------------------------------------------------------------------
// Scroll down

describe("scroll down", () => {
  it("new blocks enter at bottom, old blocks exit at top", () => {
    // 50 blocks × 100px, viewport=600, overscan=0 for clear reasoning
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 0);

    // Initial update — renders blocks 0-5 (600/100 = 6 visible)
    win.update(0);
    const after0 = win.currentRange;

    // Scroll down by 300px — block 3 is now the first visible
    const result = win.update(300);

    const entered = collectIndices(result.enter);
    const exited = collectIndices(result.exit);

    // New window starts at block 3 (300/100); old window started at 0
    // Exited: blocks 0-2 (indices that were in old but not new window)
    expect(exited.length).toBeGreaterThan(0);
    // The new window starts further down
    expect(win.currentRange.startIndex).toBeGreaterThan(after0.startIndex);
    // Entered blocks are at higher indices than what we had before
    if (entered.length > 0) {
      expect(Math.max(...entered)).toBeGreaterThanOrEqual(win.currentRange.endIndex - 1);
    }
  });

  it("spacer heights increase as we scroll down", () => {
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 0);
    win.update(0);
    const r1 = win.update(1000);
    expect(r1.topSpacerHeight).toBeGreaterThan(0);
  });

  it("top spacer height equals getBlockOffset of window start", () => {
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 1);
    win.update(0);
    const result = win.update(2000);
    const { startIndex } = win.currentRange;
    expect(result.topSpacerHeight).toBe(idx.getBlockOffset(startIndex));
  });

  it("bottom spacer height equals total - getBlockOffset(endIndex)", () => {
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 1);
    win.update(0);
    const result = win.update(2000);
    const { endIndex } = win.currentRange;
    const expected = idx.getTotalHeight() - idx.getBlockOffset(endIndex);
    expect(result.bottomSpacerHeight).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Scroll up

describe("scroll up", () => {
  it("blocks enter at top and exit at bottom on upward scroll", () => {
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 0);

    // Scroll to bottom first
    win.update(2000);
    const afterDown = win.currentRange;

    // Scroll back up to near the top
    const result = win.update(0);

    const entered = collectIndices(result.enter);
    const exited = collectIndices(result.exit);

    // Blocks entering should be at lower indices than the previous window start
    if (entered.length > 0) {
      expect(Math.min(...entered)).toBeLessThan(afterDown.startIndex);
    }
    // Blocks exiting should be at higher indices that are no longer visible
    if (exited.length > 0) {
      expect(Math.max(...exited)).toBeGreaterThan(win.currentRange.endIndex - 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Large jump

describe("large jump (scroll to middle)", () => {
  it("performs full window replacement when jumping to distant position", () => {
    // 100 blocks × 100px, viewport=600, overscan=0
    const idx = buildEqualIndex(100, 100);
    const win = new RenderedBlockWindow(idx, 600, 0);

    win.update(0);
    const oldRange = win.currentRange;

    // Jump to middle (5000px) — no overlap with old window [0, 6)
    const result = win.update(5000);

    const entered = collectIndices(result.enter);
    const exited = collectIndices(result.exit);

    // All old blocks should have exited
    for (let i = oldRange.startIndex; i < oldRange.endIndex; i++) {
      expect(exited).toContain(i);
    }
    // New window should be around block 50
    expect(entered.length).toBeGreaterThan(0);
    expect(win.currentRange.startIndex).toBeGreaterThanOrEqual(45);
    expect(win.currentRange.endIndex).toBeLessThanOrEqual(60);
  });

  it("top and bottom spacers are both non-zero when window is in middle", () => {
    const idx = buildEqualIndex(100, 100);
    const win = new RenderedBlockWindow(idx, 600, 0);
    win.update(0);
    const result = win.update(5000);
    expect(result.topSpacerHeight).toBeGreaterThan(0);
    expect(result.bottomSpacerHeight).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dirty tracking

describe("dirty tracking", () => {
  it("isDirty() returns false for unmarked blocks", () => {
    const idx = buildEqualIndex(10, 100);
    const win = new RenderedBlockWindow(idx, 600);
    expect(win.isDirty(0)).toBe(false);
    expect(win.isDirty(5)).toBe(false);
  });

  it("isDirty() returns true after markDirty()", () => {
    const idx = buildEqualIndex(10, 100);
    const win = new RenderedBlockWindow(idx, 600);
    win.markDirty(3);
    expect(win.isDirty(3)).toBe(true);
  });

  it("clearDirty() removes the dirty flag", () => {
    const idx = buildEqualIndex(10, 100);
    const win = new RenderedBlockWindow(idx, 600);
    win.markDirty(3);
    win.clearDirty(3);
    expect(win.isDirty(3)).toBe(false);
  });

  it("marking multiple blocks dirty works independently", () => {
    const idx = buildEqualIndex(10, 100);
    const win = new RenderedBlockWindow(idx, 600);
    win.markDirty(1);
    win.markDirty(4);
    win.markDirty(7);
    expect(win.isDirty(1)).toBe(true);
    expect(win.isDirty(4)).toBe(true);
    expect(win.isDirty(7)).toBe(true);
    expect(win.isDirty(2)).toBe(false);
    win.clearDirty(4);
    expect(win.isDirty(4)).toBe(false);
    expect(win.isDirty(1)).toBe(true);
    expect(win.isDirty(7)).toBe(true);
  });

  it("clearDirty() on non-dirty block is a no-op", () => {
    const idx = buildEqualIndex(10, 100);
    const win = new RenderedBlockWindow(idx, 600);
    // Should not throw
    win.clearDirty(5);
    expect(win.isDirty(5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spacer heights

describe("spacer heights", () => {
  it("top + bottom spacers + rendered range span = total height", () => {
    // For a window that renders [s, e), the space accounted for is:
    // topSpacer + heights(s..e) + bottomSpacer = totalHeight
    const idx = buildEqualIndex(20, 50);
    const win = new RenderedBlockWindow(idx, 200, 0);
    win.update(0);
    const result = win.update(500);
    const { startIndex, endIndex } = win.currentRange;

    let renderedHeight = 0;
    for (let i = startIndex; i < endIndex; i++) {
      renderedHeight += idx.getHeight(i);
    }
    const total = result.topSpacerHeight + renderedHeight + result.bottomSpacerHeight;
    expect(total).toBeCloseTo(idx.getTotalHeight(), 5);
  });

  it("top spacer is 0 when window starts at block 0", () => {
    const idx = buildEqualIndex(20, 100);
    const win = new RenderedBlockWindow(idx, 600, 0);
    const result = win.update(0);
    expect(result.topSpacerHeight).toBe(0);
  });

  it("bottom spacer is 0 when window reaches last block", () => {
    // Very large viewport or few blocks: all blocks rendered
    const idx = buildEqualIndex(5, 100);
    const win = new RenderedBlockWindow(idx, 10000, 0); // viewport covers everything
    const result = win.update(0);
    expect(result.bottomSpacerHeight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Viewport resize

describe("setViewportHeight", () => {
  it("subsequent update uses new viewport height", () => {
    // 50 blocks × 100px, overscan=0
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 300, 0); // small viewport: ~3 blocks
    win.update(0);
    const smallRange = win.currentRange;

    // Expand viewport to 900px — should render ~9 blocks
    win.setViewportHeight(900);
    win.update(0);
    const largeRange = win.currentRange;

    expect(largeRange.endIndex - largeRange.startIndex).toBeGreaterThan(
      smallRange.endIndex - smallRange.startIndex
    );
  });

  it("clamps viewport height to minimum of 1", () => {
    const idx = buildEqualIndex(10, 100);
    const win = new RenderedBlockWindow(idx, 600);
    // Should not throw with zero or negative
    win.setViewportHeight(0);
    win.setViewportHeight(-100);
    // update should still work
    expect(() => win.update(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// No-op scroll (same position)

describe("repeated update at same position", () => {
  it("returns no enter/exit on second call with same scrollTop", () => {
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 1);
    win.update(1000);
    const result = win.update(1000);
    // Window should be stable — nothing enters or exits
    const entered = collectIndices(result.enter);
    const exited = collectIndices(result.exit);
    expect(entered).toHaveLength(0);
    expect(exited).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Overscan=0 edge case

describe("overscan=0", () => {
  it("renders only the visible blocks with no extra", () => {
    // 50 blocks × 100px; viewport=600 → 6 blocks visible at scrollTop=0
    const idx = buildEqualIndex(50, 100);
    const win = new RenderedBlockWindow(idx, 600, 0);
    const result = win.update(0);
    const entered = collectIndices(result.enter);
    // Should be exactly 6 blocks (0-5) at scrollTop=0 with 100px blocks and 600px viewport
    expect(entered.length).toBeLessThanOrEqual(7); // allow 1 extra for boundary rounding
    expect(entered[0]).toBe(0);
  });
});
