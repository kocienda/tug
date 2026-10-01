/**
 * miniature-gestures.test.ts — what a press on the Layout miniature reaches,
 * checked as arithmetic over hand-built `DeckState` fixtures.
 */

import { describe, expect, test } from "bun:test";

import {
  frontPaneOfSlot,
  miniatureZoneRects,
  stackPressCardId,
  windowDragOffset,
} from "@/components/layout/miniature-gestures";
import type { DeckState, TugPaneState } from "@/layout-tree";
import { dropZoneKey, type DropZone } from "@/lib/drop-zones";

function makePane(id: string, slot: number | undefined): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: ["standard"],
    slot,
  };
}

function deck(panes: TugPaneState[]): DeckState {
  return {
    cards: panes.map((p) => ({
      id: p.activeCardId,
      componentId: "probe",
      title: p.id,
      closable: true,
    })),
    panes,
    activePaneId: panes[panes.length - 1]?.id,
    imposition: { kind: "three-up", sidebars: {} },
    hasFocus: true,
  };
}

/** What a raise does to z-order: the raised pane moves to the end. */
function raised(state: DeckState, cardId: string): DeckState {
  const pane = state.panes.find((p) => p.activeCardId === cardId)!;
  return {
    ...state,
    panes: [...state.panes.filter((p) => p !== pane), pane],
    activePaneId: pane.id,
  };
}

describe("frontPaneOfSlot", () => {
  test("is the last pane standing in the slot", () => {
    const state = deck([
      makePane("a", 1),
      makePane("b", 0),
      makePane("c", 1),
      makePane("rail", undefined),
    ]);
    expect(frontPaneOfSlot(state, 1)?.id).toBe("c");
    expect(frontPaneOfSlot(state, 0)?.id).toBe("b");
    expect(frontPaneOfSlot(state, 2)).toBeNull();
  });

  test("is null when nothing is imposed", () => {
    const state = { ...deck([makePane("a", 0)]), imposition: { sidebars: {} } };
    expect(frontPaneOfSlot(state, 0)).toBeNull();
  });
});

describe("stackPressCardId", () => {
  test("unarmed, a press reaches the front card", () => {
    const state = deck([makePane("a", 0), makePane("b", 0), makePane("c", 0)]);
    expect(stackPressCardId(state, 0, null)).toBe("card-c");
    // Armed on a different pane is the same as unarmed.
    expect(stackPressCardId(state, 0, "a")).toBe("card-c");
  });

  test("armed on a depth-3 stack, presses ring every card and come home", () => {
    let state = deck([makePane("a", 0), makePane("b", 0), makePane("c", 0)]);
    const visited: string[] = [];
    let armed: string | null = null;
    for (let press = 0; press < 4; press++) {
      const cardId = stackPressCardId(state, 0, armed)!;
      visited.push(cardId);
      state = raised(state, cardId);
      armed = frontPaneOfSlot(state, 0)!.id;
    }
    // The first press goes to the front; the next two bring up the
    // bottom-most each time; the fourth is back where the ring started.
    expect(visited).toEqual(["card-c", "card-a", "card-b", "card-c"]);
  });

  test("armed on a slot one pane deep, a press re-raises the same card", () => {
    const state = deck([makePane("a", 0), makePane("b", 1)]);
    expect(stackPressCardId(state, 0, "a")).toBe("card-a");
  });

  test("an empty slot raises nothing", () => {
    const state = deck([makePane("a", 0)]);
    expect(stackPressCardId(state, 2, null)).toBeNull();
  });
});

describe("windowDragOffset", () => {
  // A strip twice the band, drawn into a 200px field: the window is half the
  // field (scale 0.5), so 100px of hand is one band of strip.
  const base = {
    startOffset: 200,
    fieldWidthPx: 200,
    bandPx: 1000,
    stripWidthPx: 2000,
    flowScale: 0.5,
  };

  test("is linear in the hand's travel", () => {
    expect(windowDragOffset({ ...base, dxPx: 0 })).toBe(200);
    expect(windowDragOffset({ ...base, dxPx: 10 })).toBeCloseTo(300, 9);
    expect(windowDragOffset({ ...base, dxPx: 30 })).toBeCloseTo(500, 9);
    expect(windowDragOffset({ ...base, dxPx: -10 })).toBeCloseTo(100, 9);
  });

  test("clamps at the strip's two ends", () => {
    expect(windowDragOffset({ ...base, dxPx: -100 })).toBe(0);
    // The far end is strip less band.
    expect(windowDragOffset({ ...base, dxPx: 500 })).toBe(1000);
  });

  test("returns the start with no field or no scale to measure against", () => {
    expect(windowDragOffset({ ...base, dxPx: 40, fieldWidthPx: 0 })).toBe(200);
    expect(windowDragOffset({ ...base, dxPx: 40, flowScale: 0 })).toBe(200);
  });
});

describe("miniatureZoneRects", () => {
  const canvasRect = { x: 0, y: 0, width: 1, height: 1 };
  // Three slots lapped as fit laps them: each starts inside the one before.
  const slots = new Map([
    [0, { x: 0, y: 0, width: 60, height: 100 }],
    [1, { x: 40, y: 0, width: 60, height: 100 }],
    [2, { x: 120, y: 0, width: 40, height: 100 }],
  ]);
  const rails = { right: { x: 200, y: 0, width: 20, height: 90 } };
  const rectOf = (
    placed: ReturnType<typeof miniatureZoneRects>,
    key: string,
  ) => placed.find((m) => dropZoneKey(m.zone) === key)?.rect;
  const inside = (r: { x: number; y: number; width: number; height: number }, x: number, y: number) =>
    x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

  test("a lapped slot is trimmed at the next slot's left edge", () => {
    const zones: DropZone[] = [0, 1, 2].map((slot) => ({
      kind: "slot",
      slot,
      rect: canvasRect,
    }));
    const placed = miniatureZoneRects(zones, { slots, rails: {} });
    expect(rectOf(placed, "slot:0")).toEqual({ x: 0, y: 0, width: 40, height: 100 });
    // Not lapped by slot 2, so slot 1 keeps its whole width.
    expect(rectOf(placed, "slot:1")).toEqual(slots.get(1));
    expect(rectOf(placed, "slot:2")).toEqual(slots.get(2));
    // A point on slot 1's leading strip lies in slot 1's rect alone.
    const hits = placed.filter((m) => inside(m.rect, 45, 50));
    expect(hits.map((m) => dropZoneKey(m.zone))).toEqual(["slot:1"]);
  });

  test("a lone sitter's two positions split its slot into halves", () => {
    const zones: DropZone[] = [0, 1].map((index) => ({
      kind: "column-index",
      slot: 2,
      index,
      rect: canvasRect,
    }));
    const placed = miniatureZoneRects(zones, { slots, rails: {} });
    expect(rectOf(placed, "column:2:0")).toEqual({ x: 120, y: 0, width: 40, height: 50 });
    expect(rectOf(placed, "column:2:1")).toEqual({ x: 120, y: 50, width: 40, height: 50 });
  });

  test("a split column of three splits into thirds", () => {
    const zones: DropZone[] = [0, 1, 2].map((index) => ({
      kind: "column-index",
      slot: 2,
      index,
      rect: canvasRect,
    }));
    const placed = miniatureZoneRects(zones, { slots, rails: {} });
    expect(rectOf(placed, "column:2:1")?.y).toBeCloseTo(100 / 3, 9);
    expect(rectOf(placed, "column:2:2")?.height).toBeCloseTo(100 / 3, 9);
  });

  test("the other rail of N members splits into N+1 bands", () => {
    const zones: DropZone[] = [0, 1, 2].map((index) => ({
      kind: "rail-index",
      side: "right",
      index,
      rect: canvasRect,
    }));
    const placed = miniatureZoneRects(zones, { slots, rails });
    expect(rectOf(placed, "rail:right:0")).toEqual({ x: 200, y: 0, width: 20, height: 30 });
    expect(rectOf(placed, "rail:right:2")).toEqual({ x: 200, y: 60, width: 20, height: 30 });
  });

  test("tab bars and zones with no part in the picture are omitted", () => {
    const zones: DropZone[] = [
      { kind: "tab-bar", paneId: "a", rect: canvasRect },
      { kind: "slot", slot: 5, rect: canvasRect },
      { kind: "rail-index", side: "left", index: 0, rect: canvasRect },
      { kind: "slot", slot: 0, rect: canvasRect },
    ];
    const placed = miniatureZoneRects(zones, { slots, rails });
    expect(placed.map((m) => dropZoneKey(m.zone))).toEqual(["slot:0"]);
  });
});
