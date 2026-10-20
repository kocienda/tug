/**
 * A flow card's right-edge resize, carried by the host, moves the later slots
 * with the hand while it holds: each report shifts every later stand-in by the
 * strip's own answer at the width the host reports, and the strip's length
 * with them, so the commit at the release lays out what the hand already
 * showed. Earlier slots stand. A cancel hands every stand-in back its pin; a
 * fit deck, and any edge but the right, open no follow.
 *
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugdeck/src/lib/keep-slot-resize.ts
 */

import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState } from "../../layout-tree";
import type { ResizeEdge } from "../../bus/declarations/pane";
import { createHostCardGesture, openFlowFollow, type FlowFollow, type HostGestureReaders } from "../host-card-gesture";
import { FLOW_STRIP_PROPERTY } from "../layout-imposer";

const START_WIDTH = 480;

/** Three slim cards in flow, as `at0693` seeds them. */
function flowDeck(layout: "flow" | "fit" = "flow"): DeckState {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: START_WIDTH, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
    widthPreset: "slim",
  });
  return {
    cards: ["A", "B", "C"].map((id) => ({ id, componentId: "gallery-accordion", title: `Card ${id}`, closable: true })),
    panes: [pane("p1", 0, "A"), pane("p2", 1, "B"), pane("p3", 2, "C")],
    activePaneId: "p1",
    imposition: { kind: "three-up", layout, sidebars: {} },
    hasFocus: true,
  } as unknown as DeckState;
}

/** The stand-ins at the lefts their render gave them, under a layer carrying the strip's length. */
function standIns() {
  const doc = new JSDOM("<!doctype html><body></body>").window.document;
  const layer = doc.createElement("div");
  layer.style.setProperty(FLOW_STRIP_PROPERTY, "1500px");
  ["p1", "p2", "p3"].forEach((id, i) => {
    const el = doc.createElement("div");
    el.className = "tug-pane";
    el.dataset.paneId = id;
    el.style.left = `${40 + i * 490}px`;
    layer.append(el);
  });
  doc.body.append(layer);
  const left = (id: string) => doc.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)!.style.left;
  return { doc, layer, left };
}

describe("openFlowFollow", () => {
  test("shifts every later stand-in by the width's change and leaves the earlier ones", () => {
    const { doc, layer, left } = standIns();
    const follow = openFlowFollow(flowDeck(), "p2", doc)!;
    follow.move(START_WIDTH + 90);
    expect(left("p1")).toBe("40px");
    expect(left("p2")).toBe("530px");
    expect(left("p3")).toBe("calc(1110px)");
    expect(layer.style.getPropertyValue(FLOW_STRIP_PROPERTY)).not.toBe("1500px");
  });

  test("the first card narrower moves both later slots, and a cancel hands back every pin and the strip", () => {
    const { doc, layer, left } = standIns();
    const follow = openFlowFollow(flowDeck(), "p1", doc)!;
    follow.move(START_WIDTH - 60);
    expect(left("p2")).toBe("calc(470px)");
    expect(left("p3")).toBe("calc(960px)");
    follow.cancel();
    expect([left("p1"), left("p2"), left("p3")]).toEqual(["40px", "530px", "1020px"]);
    expect(layer.style.getPropertyValue(FLOW_STRIP_PROPERTY)).toBe("1500px");
  });

  test("a deck not in flow has nothing to follow", () => {
    const { doc } = standIns();
    expect(openFlowFollow(flowDeck("fit"), "p1", doc)).toBeNull();
  });
});

describe("host card gesture: a flow card's right edge", () => {
  function harness(layout: "flow" | "fit" = "flow") {
    const calls: string[] = [];
    const state = flowDeck(layout);
    const deck = {
      getSnapshot: () => state,
      batchGesture: (run: () => void) => run(),
      handlePaneMoved: (paneId: string) => calls.push(`commit ${paneId}`),
      getColumnRunHeight: () => 900,
    } as unknown as IDeckManagerStore;
    const follow: FlowFollow = {
      move: (w) => calls.push(`move ${w}`),
      release: (w) => calls.push(`release ${w}`),
      cancel: () => calls.push("cancel"),
    };
    const readers: HostGestureReaders = {
      canvas: () => ({ left: 0, top: 0, zoom: 1 }),
      zones: () => null,
      paneRects: () => new Map(),
      revealStack: () => {},
      railEdge: () => null,
      columnSeam: () => null,
      requestFrame: () => {},
      land: (cardId) => calls.push(`land ${cardId}`),
      flowFollow: (_state, paneId) => {
        calls.push(`open ${paneId}`);
        return follow;
      },
    };
    const handle = createHostCardGesture(deck, readers);
    const step = (edge: ResizeEdge, phase: "move" | "end" | "cancel", width: number) =>
      handle({
        cardId: "A",
        kind: "resize",
        phase,
        rect: { x: 40, y: 40, width, height: 620 },
        pointer: { x: 40 + width, y: 300 },
        start: { x: 520, y: 300 },
        moved: true,
        meta: false,
        alt: false,
        edge,
      });
    return { calls, step };
  }

  test("each report moves the later slots, and the release stands them before the commit", () => {
    const { calls, step } = harness();
    step("e", "move", 450);
    step("e", "move", 420);
    step("e", "end", 420);
    expect(calls).toEqual(["open p1", "move 450", "move 420", "release 420", "land A", "commit p1"]);
  });

  test("a cancel hands them back and commits nothing", () => {
    const { calls, step } = harness();
    step("e", "move", 450);
    step("e", "cancel", 450);
    expect(calls).toEqual(["open p1", "move 450", "cancel"]);
  });

  test("the bottom edge, and a fit deck's right edge, open no follow", () => {
    const flow = harness();
    flow.step("s", "move", 480);
    flow.step("s", "end", 480);
    expect(flow.calls.some((c) => c.startsWith("open"))).toBe(false);
    const fit = harness("fit");
    fit.step("e", "move", 450);
    fit.step("e", "end", 450);
    expect(fit.calls.some((c) => c.startsWith("open"))).toBe(false);
  });
});
