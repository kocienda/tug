/**
 * list-view-window — the zoom case.
 *
 * A page-zoom step changes every scroller's CSS-px width by device-pixel
 * snapping and changes `devicePixelRatio` with it. The width settle used to
 * read that as a reflow and wipe the measured-height ledger, which suspended
 * eviction and mounted every row of every transcript in one commit. These
 * pin the classification and what each settle leaves the next commit to
 * render. No React, no DOM.
 */

import { describe, expect, test } from "bun:test";

import { HeightIndex } from "../list-view-height-index";
import {
  classifyWidthSettle,
  computeWindow,
  resolveEvictWindow,
} from "../list-view-window";

describe("classifyWidthSettle", () => {
  test("a sub-pixel move is unchanged, whatever the ratio did", () => {
    expect(
      classifyWidthSettle(
        { width: 661, pixelRatio: 2 },
        { width: 661.3, pixelRatio: 2 },
      ),
    ).toBe("unchanged");
    expect(
      classifyWidthSettle(
        { width: 661, pixelRatio: 2 },
        { width: 661, pixelRatio: 1.8 },
      ),
    ).toBe("unchanged");
  });

  test("a zoom step's snapping is a rescale (slim card, 100 % → 90 %)", () => {
    expect(
      classifyWidthSettle(
        { width: 661, pixelRatio: 2 },
        { width: 663, pixelRatio: 1.7999999523162842 },
      ),
    ).toBe("rescaled");
  });

  test("a zoom on a viewport-sized card is a rescale however far the width moves", () => {
    expect(
      classifyWidthSettle(
        { width: 900, pixelRatio: 2 },
        { width: 1000, pixelRatio: 1.8 },
      ),
    ).toBe("rescaled");
  });

  test("a width change at a fixed ratio is a reflow", () => {
    expect(
      classifyWidthSettle(
        { width: 661, pixelRatio: 2 },
        { width: 541, pixelRatio: 2 },
      ),
    ).toBe("reflowed");
  });
});

describe("resolveEvictWindow", () => {
  const measured = (n: number, h = 80): HeightIndex => {
    const index = new HeightIndex();
    for (let i = 0; i < n; i += 1) index.set(i, h);
    return index;
  };

  test("a whole ledger evicts to the candidate", () => {
    expect(
      resolveEvictWindow({ firstIndex: 40, lastIndex: 60 }, measured(100), 100),
    ).toEqual({ kind: "evict", firstIndex: 40, lastIndex: 60 });
  });

  test("an unmeasured appended row widens to it, not to everything", () => {
    const ledger = measured(99);
    expect(
      resolveEvictWindow({ firstIndex: 40, lastIndex: 60 }, ledger, 100),
    ).toEqual({ kind: "widened", firstIndex: 40, lastIndex: 100 });
  });

  test("an empty ledger suspends", () => {
    expect(
      resolveEvictWindow({ firstIndex: 40, lastIndex: 60 }, new HeightIndex(), 100),
    ).toEqual({ kind: "suspended" });
  });
});

describe("a zoom step's settle and the commit after it", () => {
  const ROWS = 300;
  const ROW_H = 120;
  const VIEWPORT = 840;

  const candidateAt = (ledger: HeightIndex) =>
    computeWindow({
      itemCount: ROWS,
      scrollTop: (ROWS * ROW_H) / 2,
      viewportHeight: VIEWPORT,
      overscanCount: 3,
      estimatedHeightForIndex: (i) => ledger.get(i) ?? 60,
      mountMarginPx: VIEWPORT,
      retainMarginPx: VIEWPORT * 2,
      prevRange: null,
    });

  /** The settle's ledger action, as the list view takes it. */
  const settle = (
    ledger: HeightIndex,
    prev: { width: number; pixelRatio: number },
    next: { width: number; pixelRatio: number },
  ): void => {
    if (classifyWidthSettle(prev, next) === "reflowed") ledger.clear();
  };

  const fullLedger = (): HeightIndex => {
    const ledger = new HeightIndex();
    for (let i = 0; i < ROWS; i += 1) ledger.set(i, ROW_H);
    return ledger;
  };

  test("a rescale keeps the ledger, so the commit mounts the viewport's rows only", () => {
    const ledger = fullLedger();
    settle(ledger, { width: 661, pixelRatio: 2 }, { width: 663, pixelRatio: 1.8 });
    const resolution = resolveEvictWindow(candidateAt(ledger), ledger, ROWS);
    expect(resolution.kind).toBe("evict");
    if (resolution.kind === "suspended") return;
    const mounted = resolution.lastIndex - resolution.firstIndex;
    // The scrollport plus a viewport of margin each side, plus overscan.
    expect(mounted).toBeLessThanOrEqual(
      Math.ceil((VIEWPORT * 3) / ROW_H) + 2 * 3 + 2,
    );
    expect(mounted).toBeLessThan(ROWS / 10);
  });

  test("a reflow wipes the ledger and the commit suspends — the mount a zoom must not cause", () => {
    const ledger = fullLedger();
    settle(ledger, { width: 661, pixelRatio: 2 }, { width: 541, pixelRatio: 2 });
    expect(resolveEvictWindow(candidateAt(ledger), ledger, ROWS)).toEqual({
      kind: "suspended",
    });
  });
});
