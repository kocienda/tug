/**
 * `overlay.surfaces` holds a card's surface only while the card rests: its
 * entry is withdrawn at a gesture's first travelled report and while any plan
 * names it, and published again, at its rest rect, once nothing moves it.
 * The gesture's half is wired in the host card gesture's handler, which also
 * sends the overlay the guides the host snapped each step to.
 *
 * @covers tugdeck/src/lib/overlay-surfaces.ts
 * @covers tugdeck/src/lib/host-card-gesture.ts
 */

import { describe, expect, test } from "bun:test";
import type { OverlaySurfaceEntry } from "../../bus/declarations/overlay";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState } from "../../layout-tree";
import { createHostCardGesture, type HostGestureReaders } from "../host-card-gesture";
import { OverlaySurfaceBook, overlaySurfaceBook } from "../overlay-surfaces";
import { currentIndication } from "../drag-indication";
import { createTestBus } from "../../bus/test-bus";

const PLACARD: OverlaySurfaceEntry = {
  surface: { title: "Time", className: "", growth: "up", anchorX: 120, lineY: 580, html: "<span>1:00</span>", scroll: [] },
  body: { x: 40, y: 40, width: 480, height: 620 },
  pane: null,
  bound: null,
};
const movedTo = (x: number): OverlaySurfaceEntry => ({ ...PLACARD, body: { ...PLACARD.body, x } });

function book() {
  const sent: Array<Record<string, OverlaySurfaceEntry>> = [];
  return { book: new OverlaySurfaceBook((shown) => sent.push(shown)), sent };
}

describe("OverlaySurfaceBook", () => {
  test("publishes a resting card's surface, and says nothing new on a repeat", () => {
    const { book: b, sent } = book();
    b.publish("A", PLACARD);
    b.publish("A", { ...PLACARD });
    expect(sent).toEqual([{ A: PLACARD }]);
  });

  test("withdraws the entry at a gesture and publishes it again at its release", () => {
    const { book: b, sent } = book();
    b.publish("A", PLACARD);
    b.hold("A", "gesture");
    expect(b.snapshot()).toEqual({});
    b.publish("A", movedTo(400));
    expect(b.snapshot(), "a rest rect published mid-gesture waits for the rest").toEqual({});
    b.release("A", "gesture");
    expect(b.snapshot()).toEqual({ A: movedTo(400) });
    expect(sent.length).toBe(3);
  });

  test("a card both in hand and in a plan stands again only when both have let it go", () => {
    const { book: b } = book();
    b.publish("A", PLACARD);
    b.hold("A", "gesture");
    b.hold("A", "plan");
    b.release("A", "gesture");
    expect(b.snapshot()).toEqual({});
    b.releaseAll("plan");
    expect(b.snapshot()).toEqual({ A: PLACARD });
  });

  test("a plan withdraws only the cards it names, and its land returns them all", () => {
    const { book: b } = book();
    b.publish("A", PLACARD);
    b.publish("B", PLACARD);
    b.hold("A", "plan");
    expect(Object.keys(b.snapshot())).toEqual(["B"]);
    b.releaseAll("plan");
    expect(Object.keys(b.snapshot()).sort()).toEqual(["A", "B"]);
  });

  test("a release for a reason never held changes nothing", () => {
    const { book: b, sent } = book();
    b.publish("A", PLACARD);
    b.release("A", "gesture");
    b.releaseAll("plan");
    expect(sent.length).toBe(1);
  });

  test("a card coming to rest is shown at the rect it rests at, read then, not the one it was published at in motion", () => {
    const { book: b, sent } = book();
    b.publish("A", PLACARD);
    b.hold("A", "plan");
    b.publish("A", movedTo(220));
    b.setRefresher(() => movedTo(400));
    b.releaseAll("plan");
    expect(b.snapshot()).toEqual({ A: movedTo(400) });
    const shownX = sent.map((s): number | null => ("A" in s ? s.A.body.x : null));
    expect(shownX, "nothing in between is shown").toEqual([40, null, 400]);
  });
});

describe("the host card gesture's half", () => {
  test("a card in a host-carried drag is moving from its first travelled report until its release", () => {
    const state = {
      cards: [{ id: "A", componentId: "hello", title: "A", closable: true }],
      panes: [{ id: "p1", position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, cardIds: ["A"], activeCardId: "A", title: "" }],
      activePaneId: "p1",
      imposition: {},
      hasFocus: true,
    } as unknown as DeckState;
    const deck = {
      getSnapshot: () => state,
      batchGesture: (run: () => void) => run(),
      handlePaneMoved: () => {},
      activateCard: () => {},
    } as unknown as IDeckManagerStore;
    const readers: HostGestureReaders = {
      canvas: () => ({ left: 0, top: 0, zoom: 1 }),
      zones: () => null,
      paneRects: () => new Map(),
      revealStack: () => {},
      railEdge: () => null,
      columnSeam: () => null,
      requestFrame: () => {},
      land: () => {},
      flowFollow: () => null,
    };
    // The shell's page bus, which the indication is written through.
    const bus = createTestBus();
    bus.install(bus.shell());
    const handle = createHostCardGesture(deck, readers);
    const step = (phase: "move" | "end", moved: boolean, snap?: { x: number | null; y: number | null }) =>
      handle({
        cardId: "A",
        kind: "move",
        phase,
        rect: { x: 10, y: 0, width: 400, height: 300 },
        pointer: { x: 210, y: 20 },
        start: { x: 200, y: 20 },
        moved,
        meta: false,
        alt: false,
        snap,
      });
    step("move", false);
    expect(overlaySurfaceBook.isMoving("A"), "a press that has not travelled is not motion").toBe(false);
    step("move", true, { x: 210, y: null });
    expect(overlaySurfaceBook.isMoving("A")).toBe(true);
    expect(currentIndication().guides, "the guide the host snapped to").toEqual({ x: 210, y: null });
    step("end", true);
    expect(overlaySurfaceBook.isMoving("A")).toBe(false);
    expect(currentIndication().guides, "no guide once the hand lets go").toEqual({ x: null, y: null });
    bus.dispose();
  });
});
