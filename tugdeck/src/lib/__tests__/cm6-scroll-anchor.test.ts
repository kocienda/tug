/**
 * cm6-scroll-anchor — a line anchor means the same place at every View › Zoom
 * factor. CodeMirror's height map is viewport px (it measures lines with rects
 * and reports the ratio as `scaleY`) while `scrollTop` is layout px, so a
 * height goes into the map times `scaleY` and comes out divided. A fake view
 * stands in for CM6: every line is 20 layout px, and its height map is that
 * times the scale. No DOM.
 */

import { describe, expect, test } from "bun:test";
import type { EditorView } from "@codemirror/view";

import { readCm6LineAnchor, resolveCm6LineAnchor } from "../cm6-scroll-anchor";

/** Layout px per line; the height map reports `LINE_PX * scale`. */
const LINE_PX = 20;
/** Characters per line, so line `n` starts at `(n - 1) * CHARS`. */
const CHARS = 10;
const LINES = 100;

function fakeView(scale: number, scrollTop: number): EditorView {
  const blockAt = (index: number) => ({
    from: index * CHARS,
    top: index * LINE_PX * scale,
    bottom: (index + 1) * LINE_PX * scale,
  });
  const view = {
    scaleY: scale,
    scrollDOM: { scrollTop },
    state: {
      doc: {
        lines: LINES,
        line: (n: number) => ({ from: (n - 1) * CHARS }),
        lineAt: (pos: number) => ({ number: Math.floor(pos / CHARS) + 1 }),
      },
    },
    lineBlockAtHeight: (h: number) => blockAt(Math.floor(h / (LINE_PX * scale))),
    lineBlockAt: (pos: number) => blockAt(Math.floor(pos / CHARS)),
  };
  return view as unknown as EditorView;
}

describe("readCm6LineAnchor under a zoom", () => {
  test("names the line at the top and a layout-px offset into it", () => {
    // 45 layout px down is 5 px into line 3 (lines run 0–20, 20–40, 40–60).
    for (const scale of [1, 0.5, 2]) {
      expect(readCm6LineAnchor(fakeView(scale, 45))).toEqual({ line: 3, offsetPx: 5 });
    }
  });
});

describe("resolveCm6LineAnchor under a zoom", () => {
  test("puts the line back at the same scrollTop at every factor", () => {
    for (const scale of [1, 0.5, 2]) {
      expect(resolveCm6LineAnchor(fakeView(scale, 0), { line: 3, offsetPx: 5 })).toBe(45);
    }
  });

  test("an anchor read at one factor lands at another", () => {
    const anchor = readCm6LineAnchor(fakeView(0.5, 133));
    expect(anchor).not.toBeNull();
    expect(resolveCm6LineAnchor(fakeView(2, 0), anchor!)).toBe(133);
  });
});
