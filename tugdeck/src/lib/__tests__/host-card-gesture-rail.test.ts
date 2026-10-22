/**
 * The rail branch of the host's card gesture: a rail's edge drag pressed in
 * the card's own page is carried by the host, and each report's aim drives
 * the rail's width draft through the driver the draft's owner hands it
 * (`railEdgeDriverFor`), opened at the press point; it commits the aim the
 * release reports, and nothing the pointer did not travel for. A report
 * without an aim is a host that does not carry the rail, and moves nothing.
 * The driver opens the draft against the rail pane's frame on its side,
 * marks the frame while the drag stands, and gives the draft back when the
 * frame has left.
 *
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 */

import { describe, expect, test } from "bun:test";
import { registerCard } from "../../card-registry";
import { railEdgeDriverFor, type RailWidthGesture } from "../../components/chrome/rail-width-draft";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState } from "../../layout-tree";
import { createHostCardGesture, type HostGestureReaders, type RailEdgeDriver } from "../host-card-gesture";
import type { RailWidthAim } from "../rail-width";

/** The aim a host drawing a rail at `width` reports. */
const at = (width: number, shown = width, limit: RailWidthAim["limit"] = null): RailWidthAim => ({ width, shown, limit });

function harness() {
  const calls: string[] = [];
  const driver: RailEdgeDriver = {
    begin: (x, y) => calls.push(`begin ${x},${y}`),
    change: (x, y, alt, aim) => calls.push(`change ${x},${y}${alt ? " alt" : ""} @${aim.shown}`),
    commit: (x, alt, aim) => calls.push(`commit ${x}${alt ? " alt" : ""} @${aim.width}`),
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
    columnSeam: () => null,
    requestFrame: () => {},
    land: () => {},
    flowFollow: () => null,
  };
  const handle = createHostCardGesture(deck, readers);
  const step = (phase: "move" | "end" | "cancel", x: number, moved: boolean, alt = false, aim: RailWidthAim | null = at(x)) =>
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
      ...(aim === null ? {} : { rail: aim }),
    });
  return { calls, step };
}

describe("host card gesture: a rail's edge", () => {
  test("opens the draft at the press point, hands it each aim, and commits the release's", () => {
    const { calls, step } = harness();
    step("move", 242, false);
    step("move", 260, true);
    step("move", 280, true, true);
    step("end", 280, true, true);
    expect(calls).toEqual(["begin 240,300", "change 260,300 @260", "change 280,300 alt @280", "commit 280 alt @280"]);
  });

  test("the aim is the host's, past a limit as between them", () => {
    const { calls, step } = harness();
    step("move", 900, true, false, at(675, 701.5, "ceiling"));
    step("end", 900, true, false, at(675, 702, "ceiling"));
    expect(calls).toEqual(["begin 240,300", "change 900,300 @701.5", "commit 900 @675"]);
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
    expect(calls).toEqual(["begin 240,300", "commit 300 @300"]);
  });

  test("a cancel gives the draft back", () => {
    const { calls, step } = harness();
    step("move", 270, true);
    step("cancel", 270, true);
    expect(calls).toEqual(["begin 240,300", "change 270,300 @270", "cancel"]);
  });

  test("a report without the aim opens nothing, and its release commits nothing", () => {
    const { calls, step } = harness();
    step("move", 270, true, false, null);
    step("end", 270, true, false, null);
    expect(calls).toEqual([]);
  });
});

registerCard({
  componentId: "rail-edge-driver-rail",
  contentFactory: () => null,
  defaultMeta: { title: "Rail", closable: true },
  layoutRole: "sidebar",
});
registerCard({
  componentId: "rail-edge-driver-doc",
  contentFactory: () => null,
  defaultMeta: { title: "Doc", closable: true },
});

/** A rail pinned right and a content pane beside it. */
const DECK: DeckState = {
  cards: [
    { id: "R", componentId: "rail-edge-driver-rail", title: "", closable: true },
    { id: "D", componentId: "rail-edge-driver-doc", title: "", closable: true },
  ],
  panes: [
    {
      id: "rail",
      position: { x: 0, y: 0 },
      size: { width: 240, height: 600 },
      cardIds: ["R"],
      activeCardId: "R",
      title: "",
      acceptsFamilies: [],
    },
    {
      id: "doc",
      position: { x: 300, y: 0 },
      size: { width: 400, height: 600 },
      cardIds: ["D"],
      activeCardId: "D",
      title: "",
      acceptsFamilies: ["standard"],
    },
  ],
  imposition: { sidebars: { "rail-edge-driver-rail": { side: "right" } } },
  hasFocus: true,
};

/** A frame that records its mark, and a draft that records its calls. */
function driverHarness(paneId: string) {
  const calls: string[] = [];
  const marks = new Map<string, string>();
  const frame = {
    isConnected: true,
    setAttribute: (name: string, value: string) => marks.set(name, value),
    removeAttribute: (name: string) => marks.delete(name),
  };
  const draft: RailWidthGesture = {
    begin: ({ side, frame: f, clientX, clientY }) =>
      calls.push(`begin ${side} ${f === (frame as unknown) ? "frame" : "other"} ${clientX},${clientY}`),
    change: (x, y, _alt, aim) => calls.push(`change ${x},${y} @${aim.shown}`),
    commit: (x, _alt, aim) => calls.push(`commit ${x} @${aim.width}`),
    cancel: () => calls.push("cancel"),
  };
  const deck = { getSnapshot: () => DECK };
  const driver = railEdgeDriverFor(deck, draft, paneId, (id) => (id === paneId ? (frame as unknown as HTMLElement) : null));
  return { calls, marks, frame, driver };
}

describe("railEdgeDriverFor", () => {
  test("a content pane has no rail edge, and neither has a pane with no frame", () => {
    expect(driverHarness("doc").driver).toBeNull();
    const deck = { getSnapshot: () => DECK };
    const noop: RailWidthGesture = { begin() {}, change() {}, commit() {}, cancel() {} };
    expect(railEdgeDriverFor(deck, noop, "rail", () => null)).toBeNull();
  });

  test("begin on a pinned rail opens the draft at the frame and side, and marks the frame", () => {
    const { calls, marks, driver } = driverHarness("rail");
    driver!.begin(240, 300);
    expect(calls).toEqual(["begin right frame 240,300"]);
    expect(marks.get("data-gesture")).toBe("resize");
  });

  test("commit clears the mark and commits the draft", () => {
    const { calls, marks, driver } = driverHarness("rail");
    driver!.begin(240, 300);
    driver!.change(260, 300, false, at(220));
    driver!.commit(260, false, at(220));
    expect(calls).toEqual(["begin right frame 240,300", "change 260,300 @220", "commit 260 @220"]);
    expect(marks.has("data-gesture")).toBe(false);
  });

  test("a frame gone mid-drag gives the draft back at the next change, and at a commit", () => {
    const atChange = driverHarness("rail");
    atChange.driver!.begin(240, 300);
    atChange.frame.isConnected = false;
    atChange.driver!.change(260, 300, false, at(220));
    expect(atChange.calls).toEqual(["begin right frame 240,300", "cancel"]);
    expect(atChange.marks.has("data-gesture")).toBe(false);

    const atCommit = driverHarness("rail");
    atCommit.driver!.begin(240, 300);
    atCommit.frame.isConnected = false;
    atCommit.driver!.commit(260, false, at(220));
    expect(atCommit.calls).toEqual(["begin right frame 240,300", "cancel"]);
  });
});
