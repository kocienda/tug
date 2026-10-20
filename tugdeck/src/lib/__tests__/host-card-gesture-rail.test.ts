/**
 * The rail branch of the host's card gesture: a rail's edge drag pressed in
 * the card's own page drives the rail's width draft through the driver its
 * stand-in registered, opened at the press point, and commits nothing the
 * pointer did not travel for.
 */

import { describe, expect, test } from "bun:test";
import type { IDeckManagerStore } from "../../deck-manager-store";
import { createHostCardGesture, type HostGestureReaders } from "../host-card-gesture";
import type { RailEdgeDriver } from "../rail-edge-registry";

function harness() {
  const calls: string[] = [];
  const driver: RailEdgeDriver = {
    begin: (x, y) => calls.push(`begin ${x},${y}`),
    change: (x, y, alt) => calls.push(`change ${x},${y}${alt ? " alt" : ""}`),
    commit: (x, alt) => calls.push(`commit ${x}${alt ? " alt" : ""}`),
    cancel: () => calls.push("cancel"),
  };
  const deck = {
    getSnapshot: () => ({
      panes: [{ id: "rail", cardIds: ["L"], activeCardId: "L" }],
      cards: [{ id: "L", componentId: "layout" }],
    }),
  } as unknown as IDeckManagerStore;
  const readers: HostGestureReaders = {
    canvas: () => ({ left: 0, top: 0, zoom: 1 }),
    zones: () => null,
    paneRects: () => new Map(),
    revealStack: () => {},
    railEdge: (paneId) => (paneId === "rail" ? driver : null),
    requestFrame: () => {},
    land: () => {},
  };
  const handle = createHostCardGesture(deck, readers);
  const step = (phase: "move" | "end" | "cancel", x: number, moved: boolean, alt = false) =>
    handle({
      cardId: "L",
      kind: "rail",
      phase,
      rect: { x: 0, y: 0, width: 240, height: 600 },
      pointer: { x, y: 300 },
      start: { x: 240, y: 300 },
      moved,
      meta: false,
      alt,
      edge: "e",
    });
  return { calls, step };
}

describe("host card gesture: a rail's edge", () => {
  test("opens the draft at the press point and commits at the release", () => {
    const { calls, step } = harness();
    step("move", 242, false);
    step("move", 260, true);
    step("move", 280, true, true);
    step("end", 280, true, true);
    expect(calls).toEqual(["begin 240,300", "change 260,300", "change 280,300 alt", "commit 280 alt"]);
  });

  test("a press that never travelled opens nothing", () => {
    const { calls, step } = harness();
    step("move", 241, false);
    step("end", 241, false);
    expect(calls).toEqual([]);
  });

  test("a release that travelled with no move before it opens and commits the draft", () => {
    const { calls, step } = harness();
    step("end", 300, true);
    expect(calls).toEqual(["begin 240,300", "commit 300"]);
  });

  test("a cancel gives the draft back", () => {
    const { calls, step } = harness();
    step("move", 270, true);
    step("cancel", 270, true);
    expect(calls).toEqual(["begin 240,300", "change 270,300", "cancel"]);
  });
});
