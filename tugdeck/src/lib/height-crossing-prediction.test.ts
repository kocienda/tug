/**
 * `predictHeightCrossings` — which frames an arrangement change resizes,
 * answered from the arrangement alone.
 *
 * Each case builds the two arrangements the canvas would hand the settle, in
 * the shape `LayerArrangement` gives them, and asks which panes change height.
 * The four are the gestures that decide whether the hold at `arm` is right:
 * a column dividing (both members resize), a flow slide (nothing resizes), a
 * fold (the folding card resizes) and a bullseye (the width changes, the
 * height does not).
 */

import { describe, expect, test } from "bun:test";

import {
  predictHeightCrossings,
  type HeightArrangement,
  type PaneForHeight,
} from "./height-crossing-prediction";
import type { ColumnMemberPlacement, ImposedPlacement } from "./layout-imposer";

const A: PaneForHeight = { id: "a", slot: 1, size: { height: 800 } };
const B: PaneForHeight = { id: "b", slot: 1, size: { height: 800 } };
const C: PaneForHeight = { id: "c", slot: 2, size: { height: 800 } };

/** An arrangement over `panes`, each placed at its slot in a four-up flow. */
function arrangement(opts: {
  strip?: Record<number, number>;
  members?: Record<string, ColumnMemberPlacement>;
  bullseye?: string | null;
}): HeightArrangement {
  return {
    bullseyePaneId: opts.bullseye ?? null,
    stackByPaneId: new Map(),
    parkedRailSideByPaneId: new Map(),
    arrivingSeatByPaneId: new Map(),
    columnMemberByPaneId: new Map(Object.entries(opts.members ?? {})),
    placementFor: (pane): ImposedPlacement | undefined => {
      if (pane.slot === undefined) return undefined;
      const stripLeft = opts.strip?.[pane.slot];
      return stripLeft === undefined
        ? { slot: pane.slot, count: 4 }
        : { slot: pane.slot, count: 4, flow: { stripLeft } };
    },
  };
}

const same = (panes: readonly PaneForHeight[]) => panes.map((p) => ({ before: p, after: p }));

describe("predictHeightCrossings", () => {
  test("a column dividing predicts both members", () => {
    const before = arrangement({});
    const after = arrangement({
      members: {
        a: { slot: 1, index: 0, count: 2, standing: "shared" },
        b: { slot: 1, index: 1, count: 2, standing: "shared" },
      },
    });
    expect(predictHeightCrossings(before, after, same([A, B, C])).sort()).toEqual(["a", "b"]);
  });

  test("a flow-offset-only change predicts none", () => {
    const before = arrangement({ strip: { 1: 0, 2: 680 } });
    const after = arrangement({ strip: { 1: -680, 2: 0 } });
    expect(predictHeightCrossings(before, after, same([A, C]))).toEqual([]);
  });

  test("a fold predicts the folding member", () => {
    const arr = arrangement({});
    const folded: PaneForHeight = { ...C, folded: true };
    expect(
      predictHeightCrossings(arr, arr, [
        { before: A, after: A },
        { before: C, after: folded },
      ]),
    ).toEqual(["c"]);
  });

  test("a bullseye width-only change predicts none", () => {
    const before = arrangement({});
    const after = arrangement({ bullseye: "c" });
    expect(predictHeightCrossings(before, after, same([A, C]))).toEqual([]);
  });
});
