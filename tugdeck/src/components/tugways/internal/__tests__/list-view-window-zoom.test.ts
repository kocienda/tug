/**
 * list-view-window — the zoom case.
 *
 * View › Zoom scales the deck root by a transform and sizes it to the window
 * ÷ the factor, so a zoom step moves a viewport-sized scroller's layout width
 * by the factor's ratio and leaves `devicePixelRatio` where it was. The width
 * settle keys on the zoom factor: read as a reflow, that move would wipe the
 * measured-height ledger, suspend eviction and mount every row of every
 * transcript in one commit. These pin the classification and what each
 * settle leaves the next commit to render. No React, no DOM.
 */

import { describe, expect, test } from "bun:test";

import { HeightIndex } from "../list-view-height-index";
import {
  classifyWidthSettle,
  computeWindow,
  resolveEvictWindow,
  type WidthSample,
} from "../list-view-window";

describe("classifyWidthSettle", () => {
  test("a sub-pixel move is unchanged, whatever the factor did", () => {
    expect(
      classifyWidthSettle(
        { width: 661, zoomFactor: 1 },
        { width: 661.3, zoomFactor: 1 },
      ),
    ).toBe("unchanged");
    expect(
      classifyWidthSettle(
        { width: 661, zoomFactor: 1 },
        { width: 661, zoomFactor: 0.9 },
      ),
    ).toBe("unchanged");
  });

  test("a viewport-sized card zoomed 100 % → 50 % is a rescale", () => {
    // The root goes from the window to the window ÷ 0.5; the card's fixed
    // chrome keeps the move short of an exact doubling.
    expect(
      classifyWidthSettle(
        { width: 900, zoomFactor: 1 },
        { width: 1784, zoomFactor: 0.5 },
      ),
    ).toBe("rescaled");
  });

  test("a viewport-sized card zoomed 100 % → 200 % is a rescale", () => {
    expect(
      classifyWidthSettle(
        { width: 900, zoomFactor: 1 },
        { width: 442, zoomFactor: 2 },
      ),
    ).toBe("rescaled");
  });

  test("a width change at a fixed factor is a reflow, at 100 % and zoomed", () => {
    expect(
      classifyWidthSettle(
        { width: 661, zoomFactor: 1 },
        { width: 541, zoomFactor: 1 },
      ),
    ).toBe("reflowed");
    expect(
      classifyWidthSettle(
        { width: 661, zoomFactor: 1.5 },
        { width: 541, zoomFactor: 1.5 },
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
  const settle = (ledger: HeightIndex, prev: WidthSample, next: WidthSample): void => {
    if (classifyWidthSettle(prev, next) === "reflowed") ledger.clear();
  };

  const fullLedger = (): HeightIndex => {
    const ledger = new HeightIndex();
    for (let i = 0; i < ROWS; i += 1) ledger.set(i, ROW_H);
    return ledger;
  };

  test("a rescale keeps the ledger, so the commit mounts the viewport's rows only", () => {
    const ledger = fullLedger();
    settle(ledger, { width: 900, zoomFactor: 1 }, { width: 1000, zoomFactor: 0.9 });
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
    settle(ledger, { width: 661, zoomFactor: 1 }, { width: 541, zoomFactor: 1 });
    expect(resolveEvictWindow(candidateAt(ledger), ledger, ROWS)).toEqual({
      kind: "suspended",
    });
  });
});
