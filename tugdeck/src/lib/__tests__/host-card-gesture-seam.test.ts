/**
 * The seam branch of the host's card gesture: a split column member's inner
 * top or bottom edge, pressed in the card's own page and tracked by the host,
 * drives the seam it borders (`driveColumnSeam`), opened at the press point,
 * moved by each report and committed at the release; any other edge, or a
 * card standing in no split column, is the resize's own.
 *
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugdeck/src/components/chrome/column-seam-drag.ts
 */

import { describe, expect, test } from "bun:test";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState } from "../../layout-tree";
import type { ResizeEdge } from "../../bus/declarations/pane";
import type { ColumnSeamGesture } from "../../components/chrome/column-seam-drag";
import { createHostCardGesture, type HostGestureReaders } from "../host-card-gesture";

/** Two cards split in slot 0 and one alone in slot 1, as `at0694` seeds them. */
function splitDeck(): DeckState {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 560, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: ["A", "B", "C"].map((id) => ({ id, componentId: "gallery-accordion", title: `Card ${id}`, closable: true })),
    panes: [pane("p1", 0, "A"), pane("p2", 0, "B"), pane("p3", 1, "C")],
    activePaneId: "p1",
    imposition: { kind: "two-up", layout: "fit", sidebars: {}, columns: { 0: { mode: "split", order: ["p1", "p2"] } } },
    hasFocus: true,
  } as unknown as DeckState;
}

function harness() {
  const calls: string[] = [];
  const state = splitDeck();
  const deck = {
    getSnapshot: () => state,
    batchGesture: (run: () => void) => run(),
    handlePaneMoved: (paneId: string) => calls.push(`resized ${paneId}`),
    getColumnRunHeight: () => 900,
  } as unknown as IDeckManagerStore;
  const readers: HostGestureReaders = {
    canvas: () => ({ left: 0, top: 0, zoom: 1 }),
    zones: () => null,
    paneRects: () => new Map(),
    revealStack: () => {},
    railEdge: () => null,
    columnSeam: (slot, index, clientY): ColumnSeamGesture => {
      calls.push(`seam ${slot}:${index} from ${clientY}`);
      return {
        move: (y) => calls.push(`move ${y}`),
        release: (y) => calls.push(`release ${y}`),
        cancel: () => calls.push("cancel"),
      };
    },
    requestFrame: () => {},
    land: (cardId) => calls.push(`land ${cardId}`),
    flowFollow: () => null,
  };
  const handle = createHostCardGesture(deck, readers);
  const step = (cardId: string, edge: ResizeEdge, phase: "move" | "end" | "cancel", y: number, moved: boolean) =>
    handle({
      cardId,
      kind: "resize",
      phase,
      rect: { x: 40, y: 40, width: 560, height: 300 },
      pointer: { x: 300, y },
      start: { x: 300, y: 340 },
      moved,
      meta: false,
      alt: false,
      edge,
    });
  return { calls, step };
}

describe("host card gesture: a split member's inner edge", () => {
  test("the upper member's bottom edge drives the seam below it, from the press, and commits at the release", () => {
    const { calls, step } = harness();
    step("A", "s", "move", 360, true);
    step("A", "s", "move", 400, true);
    step("A", "s", "end", 420, true);
    expect(calls).toEqual(["seam 0:0 from 340", "move 360", "move 400", "land A", "release 420"]);
  });

  test("the lower member's top edge drives the same seam", () => {
    const { calls, step } = harness();
    step("B", "n", "move", 300, true);
    step("B", "n", "end", 280, true);
    expect(calls).toEqual(["seam 0:0 from 340", "move 300", "land B", "release 280"]);
  });

  test("a release that travelled with no move before it opens and commits the seam", () => {
    const { calls, step } = harness();
    step("A", "s", "end", 420, true);
    expect(calls).toEqual(["seam 0:0 from 340", "land A", "release 420"]);
  });

  test("a cancel commits nothing, and a press that never travelled opens nothing", () => {
    const { calls, step } = harness();
    step("A", "s", "move", 360, true);
    step("A", "s", "cancel", 360, true);
    step("B", "n", "end", 340, false);
    expect(calls).toEqual(["seam 0:0 from 340", "move 360", "cancel"]);
  });

  test("an outer edge, and a card alone in its slot, are the resize's own", () => {
    const { calls, step } = harness();
    step("A", "n", "end", 300, true);
    step("C", "s", "end", 300, true);
    expect(calls.some((c) => c.startsWith("seam"))).toBe(false);
  });
});
