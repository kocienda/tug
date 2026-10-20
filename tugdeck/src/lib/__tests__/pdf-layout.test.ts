import { describe, expect, test } from "bun:test";

import {
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  clampScale,
  fitScale,
  layoutSpread,
  spreadIndexOfPage,
  spreadsFor,
  steppedScale,
  pageAnchorAt,
  scrollTopForPageAnchor,
  visiblePages,
  type PdfPageSize,
  type PdfSpacing,
} from "@/lib/pdf-layout";

/** US Letter at 72dpi, the size the app-test's generated document uses. */
const LETTER: PdfPageSize = { width: 612, height: 792 };
const LANDSCAPE: PdfPageSize = { width: 792, height: 612 };

/** Round numbers make the arithmetic in the expectations checkable by eye. */
const SPACING: PdfSpacing = { gap: 10, padding: 20 };

const letters = (count: number): PdfPageSize[] =>
  Array.from({ length: count }, () => ({ ...LETTER }));

describe("spreadsFor", () => {
  test("continuous scroll is one spread holding the whole document", () => {
    expect(spreadsFor(5, "continuous")).toEqual([[1, 2, 3, 4, 5]]);
  });

  test("single page is one spread per page", () => {
    expect(spreadsFor(3, "single")).toEqual([[1], [2], [3]]);
  });

  test("two pages pairs from the first page on", () => {
    expect(spreadsFor(4, "two")).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("an odd last page stands alone in its spread", () => {
    expect(spreadsFor(5, "two")).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("an empty document has no spreads in any mode", () => {
    expect(spreadsFor(0, "continuous")).toEqual([]);
    expect(spreadsFor(0, "single")).toEqual([]);
    expect(spreadsFor(0, "two")).toEqual([]);
  });

  test("a one-page document is one spread everywhere", () => {
    expect(spreadsFor(1, "continuous")).toEqual([[1]]);
    expect(spreadsFor(1, "single")).toEqual([[1]]);
    expect(spreadsFor(1, "two")).toEqual([[1]]);
  });
});

describe("spreadIndexOfPage", () => {
  test("finds the pair a page belongs to", () => {
    expect(spreadIndexOfPage(4, 6, "two")).toBe(1);
    expect(spreadIndexOfPage(5, 6, "two")).toBe(2);
  });

  test("every page is in the only spread when continuous", () => {
    expect(spreadIndexOfPage(9, 10, "continuous")).toBe(0);
  });

  test("a page outside the document falls back to the first spread", () => {
    expect(spreadIndexOfPage(99, 3, "single")).toBe(0);
  });
});

describe("layoutSpread — continuous", () => {
  test("stacks pages down the page with a gap between them", () => {
    const layout = layoutSpread(letters(3), [1, 2, 3], "continuous", 1, SPACING);
    expect(layout.boxes.map((b) => b.y)).toEqual([20, 822, 1624]);
    expect(layout.boxes.every((b) => b.height === 792)).toBe(true);
  });

  test("content height is the pages plus the gaps plus the padding", () => {
    const layout = layoutSpread(letters(3), [1, 2, 3], "continuous", 1, SPACING);
    expect(layout.height).toBe(792 * 3 + 10 * 2 + 20 * 2);
    expect(layout.width).toBe(612 + 20 * 2);
  });

  test("scale multiplies the pages but not the gaps or the padding", () => {
    const layout = layoutSpread(letters(2), [1, 2], "continuous", 2, SPACING);
    expect(layout.boxes[0]).toMatchObject({ width: 1224, height: 1584 });
    expect(layout.height).toBe(1584 * 2 + 10 + 20 * 2);
  });

  test("a narrower page is centred against the widest one", () => {
    const sizes = [LANDSCAPE, LETTER];
    const layout = layoutSpread(sizes, [1, 2], "continuous", 1, SPACING);
    expect(layout.width).toBe(792 + 20 * 2);
    expect(layout.boxes[0].x).toBe(20);
    expect(layout.boxes[1].x).toBe((832 - 612) / 2);
  });

  test("mixed page heights stack by their own heights, not a common one", () => {
    const layout = layoutSpread(
      [LETTER, LANDSCAPE, LETTER],
      [1, 2, 3],
      "continuous",
      1,
      SPACING,
    );
    expect(layout.boxes.map((b) => b.y)).toEqual([20, 822, 1444]);
    expect(layout.boxes.map((b) => b.height)).toEqual([792, 612, 792]);
  });
});

describe("layoutSpread — single and two", () => {
  test("single page lays out one page at the padding origin", () => {
    const layout = layoutSpread(letters(4), [2], "single", 1, SPACING);
    expect(layout.boxes).toEqual([
      { page: 2, x: 20, y: 20, width: 612, height: 792 },
    ]);
    expect(layout.width).toBe(612 + 40);
    expect(layout.height).toBe(792 + 40);
  });

  test("two pages sit side by side with the gap between them", () => {
    const layout = layoutSpread(letters(2), [1, 2], "two", 1, SPACING);
    expect(layout.boxes.map((b) => b.x)).toEqual([20, 642]);
    expect(layout.boxes.map((b) => b.y)).toEqual([20, 20]);
    expect(layout.width).toBe(612 * 2 + 10 + 20 * 2);
    expect(layout.height).toBe(792 + 20 * 2);
  });

  test("a short page in a pair is centred against the tall one", () => {
    const layout = layoutSpread([LETTER, LANDSCAPE], [1, 2], "two", 1, SPACING);
    expect(layout.height).toBe(792 + 40);
    expect(layout.boxes[0].y).toBe(20);
    expect(layout.boxes[1].y).toBe((832 - 612) / 2);
  });

  test("an unpaired final page occupies the spread alone", () => {
    const layout = layoutSpread(letters(3), [3], "two", 1, SPACING);
    expect(layout.width).toBe(612 + 40);
    expect(layout.boxes).toHaveLength(1);
  });

  test("an empty spread lays out nothing", () => {
    expect(layoutSpread([], [], "continuous", 1, SPACING)).toEqual({
      boxes: [],
      width: 0,
      height: 0,
    });
  });

  test("page numbers with no size are skipped rather than placed at zero", () => {
    const layout = layoutSpread(letters(2), [1, 2, 3], "continuous", 1, SPACING);
    expect(layout.boxes.map((b) => b.page)).toEqual([1, 2]);
  });
});

describe("fitScale", () => {
  test("fit width divides the viewport less its padding", () => {
    const viewport = { width: 652, height: 400 };
    expect(
      fitScale(letters(1), [1], "single", viewport, "width", SPACING),
    ).toBe(1);
  });

  test("fit page also honours the height, so it is the smaller of the two", () => {
    const viewport = { width: 652, height: 436 };
    expect(fitScale(letters(1), [1], "single", viewport, "page", SPACING)).toBe(
      396 / 792,
    );
  });

  test("fitting two pages accounts for the gap between them", () => {
    const viewport = { width: 1274, height: 2000 };
    expect(fitScale(letters(2), [1, 2], "two", viewport, "width", SPACING)).toBe(
      1,
    );
  });

  test("fit width in continuous mode sizes to the widest page", () => {
    const viewport = { width: 832, height: 600 };
    expect(
      fitScale(
        [LETTER, LANDSCAPE],
        [1, 2],
        "continuous",
        viewport,
        "width",
        SPACING,
      ),
    ).toBe(1);
  });

  test("a viewport too small to hold the padding clamps to the floor", () => {
    const viewport = { width: 10, height: 10 };
    expect(
      fitScale(letters(1), [1], "single", viewport, "page", SPACING),
    ).toBe(PDF_MIN_SCALE);
  });

  test("an empty spread has nothing to fit and stays at actual size", () => {
    expect(fitScale([], [], "single", { width: 500, height: 500 }, "page")).toBe(
      1,
    );
  });
});

describe("clampScale and steppedScale", () => {
  test("clamps to the supported range", () => {
    expect(clampScale(0.001)).toBe(PDF_MIN_SCALE);
    expect(clampScale(99)).toBe(PDF_MAX_SCALE);
    expect(clampScale(1.25)).toBe(1.25);
  });

  test("a non-finite scale falls back to actual size", () => {
    expect(clampScale(Number.NaN)).toBe(1);
  });

  test("steps to the next ladder stop in each direction", () => {
    expect(steppedScale(1, 1)).toBe(1.25);
    expect(steppedScale(1, -1)).toBe(0.75);
  });

  test("a scale between stops moves to the neighbour, not the nearest", () => {
    expect(steppedScale(1.1, 1)).toBe(1.25);
    expect(steppedScale(1.1, -1)).toBe(1);
  });

  test("a scale a hair from a stop steps past it, not onto it", () => {
    // A fit-width scale of 1.2496 is the 1.25 stop to the eye; stepping onto
    // it would be a Zoom In that moves nothing.
    expect(steppedScale(1.2496, 1)).toBe(1.5);
    expect(steppedScale(1.0004, -1)).toBe(0.75);
  });

  test("stepping past either end of the ladder stops at the bound", () => {
    expect(steppedScale(PDF_MAX_SCALE, 1)).toBe(PDF_MAX_SCALE);
    expect(steppedScale(0.25, -1)).toBe(PDF_MIN_SCALE);
  });
});

describe("visiblePages", () => {
  const layout = layoutSpread(letters(10), spreadsFor(10, "continuous")[0], "continuous", 1, SPACING);

  test("only the pages the viewport overlaps are visible", () => {
    expect(visiblePages(layout, 0, 800)).toEqual([1]);
  });

  test("a viewport straddling a gap sees both neighbours", () => {
    expect(visiblePages(layout, 700, 400)).toEqual([1, 2]);
  });

  test("the margin pulls in pages just off screen", () => {
    expect(visiblePages(layout, 0, 800, 200)).toEqual([1, 2]);
  });

  test("scrolled to the end, the last page is visible and the first is not", () => {
    const pages = visiblePages(layout, layout.height - 800, 800);
    expect(pages).toContain(10);
    expect(pages).not.toContain(1);
  });

  test("scrolled past the content, nothing is visible", () => {
    expect(visiblePages(layout, layout.height + 500, 800)).toEqual([]);
  });

  test("an empty layout has no visible pages", () => {
    expect(visiblePages({ boxes: [], width: 0, height: 0 }, 0, 800)).toEqual([]);
  });
});

describe("holding the reader's place across a re-scale", () => {
  // The same ten pages laid out at two scales — what a card width change
  // produces under `fit-width`, where the scale IS the card's width.
  const wide = layoutSpread(letters(10), spreadsFor(10, "continuous")[0], "continuous", 1, SPACING);
  const narrow = layoutSpread(letters(10), spreadsFor(10, "continuous")[0], "continuous", 0.5, SPACING);

  test("a page and a fraction survive the scale a pixel offset does not", () => {
    // A third of the way down page 4, at the wide scale.
    const box = wide.boxes.find((b) => b.page === 4)!;
    const top = box.y + box.height / 3;
    const anchor = pageAnchorAt(wide, top)!;
    expect(anchor.page).toBe(4);
    expect(anchor.fraction).toBeCloseTo(1 / 3, 5);

    // Re-laid at half scale, the same anchor is still a third down page 4 —
    // and lands at a `scrollTop` roughly half the old one, which is exactly
    // the drift a preserved pixel offset would have inflicted.
    const restored = scrollTopForPageAnchor(narrow, anchor)!;
    const narrowBox = narrow.boxes.find((b) => b.page === 4)!;
    expect(restored).toBeCloseTo(narrowBox.y + narrowBox.height / 3, 5);
    expect(restored).toBeLessThan(top);
  });

  test("the top of the document is page one at zero", () => {
    expect(pageAnchorAt(wide, 0)).toEqual({ page: 1, fraction: 0 });
  });

  test("scrolled into the gap after the last page, the anchor stays on it", () => {
    const anchor = pageAnchorAt(wide, wide.height + 500)!;
    expect(anchor.page).toBe(10);
    expect(anchor.fraction).toBe(1);
  });

  test("an anchor on a page this layout does not hold resolves to nothing", () => {
    // A page-mode change re-spreads the document; the old page may not be in
    // the new layout at all, and guessing a position for it is worse than
    // leaving the scroller alone.
    const single = layoutSpread(letters(10), spreadsFor(10, "single")[0], "single", 1, SPACING);
    expect(scrollTopForPageAnchor(single, { page: 7, fraction: 0.5 })).toBeNull();
  });

  test("an empty layout has no anchor to give", () => {
    expect(pageAnchorAt({ boxes: [], width: 0, height: 0 }, 0)).toBeNull();
  });

  test("a resolved anchor never lands outside the content", () => {
    const anchor = { page: 10, fraction: 1 };
    const restored = scrollTopForPageAnchor(narrow, anchor)!;
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(restored).toBeLessThanOrEqual(narrow.height);
  });
});
