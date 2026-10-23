/**
 * The Layout miniature's crossing between the shell and its body, on the test
 * bus.
 *
 * The gauge channel and the drop-zone host are module state per page, so a
 * miniature drawn in a body hears nothing the shell's deck and canvas publish,
 * and a drag started on it finds no host, unless the `miniature.*`
 * declarations carry them. These pin both halves: a body with a gauge
 * registration is primed with every standing gauge and then sent each task's
 * publishes once; what it is sent lands on its registered elements, drag
 * attributes included; a drawing that re-registers in one task keeps its
 * demand; and a drag's zones, outline, carry and commit go to the shell's
 * host, the zones coming back to the body that asked.
 *
 * Both pages share this process's gauge channel, so a test that reads what
 * the body applied sets `miniature.gauges` in the shell by hand rather than
 * publishing there.
 *
 * @covers tugdeck/src/lib/miniature-bus.ts
 * @covers tugdeck/src/bus/declarations/relays.ts
 * @covers tugdeck/src/lib/imposer-gauges.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { registerCard } from "../../card-registry";
import type { DeckState } from "../../layout-tree";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { MINIATURE_ZONES_MS, miniatureGauges } from "../../bus/declarations/relays";
import { answerMiniature, bodyMiniatureHost, followMiniatureGauges } from "../miniature-bus";
import { publishColumnOffset, publishDragFrame, publishFlowOffset, registerGauge } from "../imposer-gauges";
import type { DropZone, DropZoneHost, DropZoneSet } from "../drop-zones";

registerCard({
  componentId: "miniature-bus-layout",
  contentFactory: () => null,
  defaultMeta: { title: "Layout", closable: true },
  bodyDeck: "arrangement",
});

const LAYOUT = "miniature-bus-layout";

const DECK = {
  cards: [],
  panes: [
    {
      id: "p1",
      position: { x: 0, y: 0 },
      size: { width: 400, height: 600 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: [],
    },
  ],
} as unknown as DeckState;

const SLOT_ZONE: DropZone = { kind: "slot", slot: 2, rect: { x: 1, y: 2, width: 3, height: 4 } };

let bus: TestBus;
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  bus?.dispose();
  publishFlowOffset(null);
  publishDragFrame(null);
});

function element(): HTMLElement {
  return new JSDOM("<!doctype html><div></div>").window.document.querySelector("div") as unknown as HTMLElement;
}

const keyOf = (f: { envelope: unknown }): string | undefined => (f.envelope as { key?: string }).key;
const gaugeFrames = (): number => bus.frames().filter((f) => keyOf(f) === "miniature.gauges").length;
const tick = (): Promise<void> => new Promise((r) => queueMicrotask(r));

describe("the gauges", () => {
  test("a body with a registration is primed with the standing gauges, then sent each task's publishes once", async () => {
    publishFlowOffset(0.25);
    bus = createTestBus();
    const shell = bus.shell();
    releases.push(answerMiniature({ getSnapshot: () => DECK, getHost: () => null, flashCard: () => {} }, shell.bus));
    const layout = bus.body("L", LAYOUT);
    releases.push(followMiniatureGauges(layout.bus));
    await bus.flush();
    // No registration yet: nothing is published for the body.
    expect(gaugeFrames()).toBe(0);

    const off = registerGauge("flow-offset", element());
    releases.push(off);
    await bus.flush();
    expect(miniatureGauges.on(layout.bus).getSnapshot()).toContainEqual(["flow-offset", { "--gauge-flow-offset": "0.2500" }]);
    const primed = gaugeFrames();

    publishFlowOffset(0.3);
    publishColumnOffset(7, 0.5);
    publishFlowOffset(0.35);
    await bus.flush();
    expect(gaugeFrames()).toBe(primed + 1);
    const sent = miniatureGauges.on(layout.bus).getSnapshot();
    expect(sent).toContainEqual(["flow-offset", { "--gauge-flow-offset": "0.3500" }]);
    expect(sent).toContainEqual(["column-offset:7", { "--gauge-column-offset-7": "0.5000" }]);

    off();
    await tick();
    await bus.flush();
    publishFlowOffset(0.4);
    await bus.flush();
    expect(gaugeFrames()).toBe(primed + 1);
    publishColumnOffset(7, null);
  });

  test("what the shell sends lands on the body's element, drag attributes included", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const layout = bus.body("L", LAYOUT);
    const el = element();
    releases.push(followMiniatureGauges(layout.bus), registerGauge("drag-frame", el));
    await bus.flush();

    miniatureGauges
      .on(shell.bus)
      .set([["drag-frame", { "--gauge-drag-x": "0.1", "--gauge-drag-y": "0.2", "--gauge-drag-w": "0.3", "--gauge-drag-h": "0.4" }]]);
    await bus.flush();
    expect(el.style.getPropertyValue("--gauge-drag-x")).toBe("0.1");
    expect(el.getAttribute("data-gauge-drag")).toBe("true");

    miniatureGauges.on(shell.bus).set([["drag-frame", null]]);
    await bus.flush();
    expect(el.style.getPropertyValue("--gauge-drag-x")).toBe("");
    expect(el.hasAttribute("data-gauge-drag")).toBe(false);
  });

  test("a drawing that re-registers in one task keeps its demand, and a late one hears the drag ended", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    releases.push(answerMiniature({ getSnapshot: () => DECK, getHost: () => null, flashCard: () => {} }, shell.bus));
    const layout = bus.body("L", LAYOUT);
    releases.push(followMiniatureGauges(layout.bus));
    await bus.flush();

    const offFirst = registerGauge("drag-frame", element());
    offFirst();
    const offSecond = registerGauge("drag-frame", element());
    await tick();
    await bus.flush();
    const demands = bus.frames().filter((f) => keyOf(f) === "miniature.demand");
    expect(demands.map((f) => (f.envelope as { payload?: unknown }).payload)).toEqual([true]);
    offSecond();
    await tick();
    await bus.flush();

    // A drag published and retired while no body listened: a body that comes
    // to listen is told the retirement, not left drawing the last frame.
    publishDragFrame({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    publishDragFrame(null);
    releases.push(registerGauge("drag-frame", element()));
    await bus.flush();
    const primed = miniatureGauges.on(layout.bus).getSnapshot();
    expect(primed).toContainEqual(["drag-frame", null]);
    expect(primed).toContainEqual(["drag-zone", null]);
  });
});

describe("the drop-zone host", () => {
  test("a drag's verbs run on the canvas's host, its zones come back to the body that asked, and a refused commit flashes the card", async () => {
    const calls: unknown[][] = [];
    const flashed: string[] = [];
    const set: DropZoneSet = { zones: [SLOT_ZONE], origin: null };
    const host = {
      enumerateRemote: (paneId: string) => (calls.push(["enumerateRemote", paneId]), set),
      outline: (zone: DropZone | null) => void calls.push(["outline", zone]),
      carry: (kind: "rail" | "card" | null) => void calls.push(["carry", kind]),
      commit: (zone: DropZone, paneId: string) => (calls.push(["commit", zone, paneId]), false),
    } as unknown as DropZoneHost;
    bus = createTestBus();
    const shell = bus.shell();
    releases.push(answerMiniature({ getSnapshot: () => DECK, getHost: () => host, flashCard: (id) => flashed.push(id) }, shell.bus));
    const layout = bus.body("L", LAYOUT);
    const other = bus.body("M", LAYOUT);
    await bus.flush();

    const miniature = bodyMiniatureHost((paneId) => (paneId === "body-pane-L" ? "L" : paneId === "p1" ? "A" : null), layout.bus);
    const answer = miniature.enumerateRemote("p1");
    expect(answer instanceof Promise).toBe(true);
    await bus.flush();
    expect(await answer).toEqual(set);
    const replies = bus.frames().filter((f) => f.envelope.kind === "reply");
    expect(replies.map((f) => f.to)).toEqual([[layout.pageId]]);
    expect(replies.some((f) => f.to.includes(other.pageId))).toBe(false);

    miniature.carry("rail");
    miniature.outline(null);
    expect(miniature.commit(SLOT_ZONE, "body-pane-L")).toBe(true);
    expect(miniature.commit(SLOT_ZONE, "nowhere")).toBe(false);
    await bus.flush();
    expect(calls).toEqual([
      ["enumerateRemote", "p1"],
      ["carry", "rail"],
      ["outline", null],
    ]);
    // `L` is in no pane of the shell's deck, so the commit is refused and flashed.
    expect(flashed).toEqual(["L"]);

    expect(miniature.commit(SLOT_ZONE, "p1")).toBe(true);
    await bus.flush();
    expect(calls[calls.length - 1]).toEqual(["commit", SLOT_ZONE, "p1"]);
    expect(flashed).toEqual(["L", "A"]);
  });

  test("the zones a shell never answers time out at their horizon, and the drag stays inert", async () => {
    expect(MINIATURE_ZONES_MS).toBe(1000);
    bus = createTestBus();
    bus.shell();
    const layout = bus.body("L", LAYOUT);
    await bus.flush();
    const answer = bodyMiniatureHost(() => "A", layout.bus).enumerateRemote("p1");
    await bus.flush();
    expect(await answer).toBeNull();
  });
});
