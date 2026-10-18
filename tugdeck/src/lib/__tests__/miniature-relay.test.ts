/**
 * The Layout miniature's crossing between the shell and its body.
 *
 * The gauge channel and the drop-zone host are module state per page, so a
 * miniature drawn in a body heard nothing the shell's deck and canvas
 * published, and a drag started on it found no host. These pin both halves
 * of the relay: the shell primes a subscribing body with every standing
 * gauge and forwards each publish once per task; a body applies what it is
 * sent onto its registered elements, drag attributes included, and says
 * when it starts and stops listening; and a drag's zones, outline, carry and
 * commit go to the shell's host and come back.
 *
 * Each half is driven alone: in one page, applying a relayed gauge would be
 * heard again by the shell half's tap.
 *
 * @covers tugdeck/src/lib/miniature-relay.ts
 * @covers tugdeck/src/lib/imposer-gauges.ts
 */

import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { CardCommand } from "@tugproto/bus";

import {
  createBodyMiniatureRelay,
  createShellMiniatureRelay,
  MINIATURE_RELAY_ID,
  type MiniatureRelayMessage,
} from "../miniature-relay";
import {
  publishColumnOffset,
  publishDragFrame,
  publishFlowOffset,
  registerGauge,
} from "../imposer-gauges";
import type { DropZone, DropZoneHost, DropZoneSet } from "../drop-zones";
import type { DeckState } from "../../layout-tree";

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

function shellRig(host: Partial<DropZoneHost> | null = null) {
  const sent: Array<{ cardId: string; message: MiniatureRelayMessage }> = [];
  const flashed: string[] = [];
  const relay = createShellMiniatureRelay({
    send: (cardId, command) => {
      expect(command.command).toBe("dispatch");
      expect(command.id).toBe(MINIATURE_RELAY_ID);
      sent.push({ cardId, message: command.payload as unknown as MiniatureRelayMessage });
    },
    getSnapshot: () => DECK,
    getHost: () => host as DropZoneHost | null,
    flashCard: (cardId) => flashed.push(cardId),
  });
  return { relay, sent, flashed };
}

const tick = (): Promise<void> => new Promise((r) => queueMicrotask(r));

describe("the shell's half", () => {
  test("a subscribing body is primed with the standing gauges, then sent each task's publishes once", async () => {
    publishFlowOffset(0.25);
    const { relay, sent } = shellRig();
    try {
      expect(relay.handle("L", "subscribeGauges", [true])).toBe(true);
      expect(sent).toHaveLength(1);
      const primed = sent[0].message;
      expect(primed.relay).toBe("gauges");
      expect(primed.relay === "gauges" && primed.signals).toContainEqual([
        "flow-offset",
        { "--gauge-flow-offset": "0.2500" },
      ]);

      publishFlowOffset(0.3);
      publishColumnOffset(7, 0.5);
      publishFlowOffset(0.35);
      expect(sent).toHaveLength(1);
      await tick();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual({
        cardId: "L",
        message: {
          relay: "gauges",
          signals: [
            ["column-offset:7", { "--gauge-column-offset-7": "0.5000" }],
            ["flow-offset", { "--gauge-flow-offset": "0.3500" }],
          ],
        },
      });

      relay.handle("L", "subscribeGauges", [false]);
      publishFlowOffset(0.4);
      await tick();
      expect(sent).toHaveLength(2);
    } finally {
      relay.dispose();
      publishFlowOffset(null);
    }
  });

  test("a drag's verbs run on the canvas's host, and a refused commit flashes the card", () => {
    const calls: unknown[][] = [];
    const set: DropZoneSet = { zones: [SLOT_ZONE], origin: null };
    const { relay, sent, flashed } = shellRig({
      enumerateRemote: (paneId) => (calls.push(["enumerateRemote", paneId]), set),
      outline: (zone) => void calls.push(["outline", zone]),
      carry: (kind) => void calls.push(["carry", kind]),
      commit: (zone, paneId) => (calls.push(["commit", zone, paneId]), false),
    });
    try {
      relay.handle("L", "miniatureZones", [4, "A"]);
      relay.handle("L", "miniatureCarry", ["card"]);
      relay.handle("L", "miniatureOutline", [SLOT_ZONE]);
      relay.handle("L", "miniatureCommit", [SLOT_ZONE, "A"]);
      expect(relay.handle("L", "setFlowOffset", [1])).toBe(false);
      expect(calls).toEqual([
        ["enumerateRemote", "p1"],
        ["carry", "card"],
        ["outline", SLOT_ZONE],
        ["commit", SLOT_ZONE, "p1"],
      ]);
      expect(sent).toEqual([{ cardId: "L", message: { relay: "zones", requestId: 4, set } }]);
      expect(flashed).toEqual(["A"]);
    } finally {
      relay.dispose();
    }
  });
});

describe("a body's half", () => {
  test("a registration subscribes, and relayed gauges land on the element with their drag attributes", async () => {
    const calls: unknown[][] = [];
    const relay = createBodyMiniatureRelay({
      call: (method, args) => calls.push([method, ...args]),
      cardOfPane: () => null,
    });
    const el = new JSDOM("<!doctype html><div></div>").window.document.querySelector("div") as unknown as HTMLElement;
    const off = registerGauge("drag-frame", el);
    try {
      expect(calls).toEqual([["subscribeGauges", true]]);
      const gauges = (signals: unknown): CardCommand => ({
        command: "dispatch",
        id: MINIATURE_RELAY_ID,
        payload: { relay: "gauges", signals } as unknown as Record<string, unknown>,
      });
      expect(
        relay.receive(
          gauges([["drag-frame", { "--gauge-drag-x": "0.1", "--gauge-drag-y": "0.2", "--gauge-drag-w": "0.3", "--gauge-drag-h": "0.4" }]]),
        ),
      ).toBe(true);
      expect(el.style.getPropertyValue("--gauge-drag-x")).toBe("0.1");
      expect(el.getAttribute("data-gauge-drag")).toBe("true");

      relay.receive(gauges([["drag-frame", null]]));
      expect(el.style.getPropertyValue("--gauge-drag-x")).toBe("");
      expect(el.hasAttribute("data-gauge-drag")).toBe(false);

      expect(relay.receive({ command: "dispatch", id: "something-else" })).toBe(false);
    } finally {
      off();
      await tick();
      relay.dispose();
      publishDragFrame(null);
    }
    expect(calls[calls.length - 1]).toEqual(["subscribeGauges", false]);
  });

  test("a drawing that re-registers in one task stays subscribed, and a re-subscription hears the drag ended", async () => {
    const calls: unknown[][] = [];
    const relay = createBodyMiniatureRelay({
      call: (method, args) => calls.push([method, ...args]),
      cardOfPane: () => null,
    });
    const doc = new JSDOM("<!doctype html><div></div><p></p>").window.document;
    const first = doc.querySelector("div") as unknown as HTMLElement;
    const second = doc.querySelector("p") as unknown as HTMLElement;
    const offFirst = registerGauge("drag-frame", first);
    offFirst();
    const offSecond = registerGauge("drag-frame", second);
    await tick();
    expect(calls).toEqual([["subscribeGauges", true]]);
    offSecond();
    await tick();
    relay.dispose();

    // The shell's half: a drag published and retired, then a body subscribing
    // late is told the retirement, not left with nothing to say.
    publishDragFrame({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    publishDragFrame(null);
    const { relay: shell, sent } = shellRig();
    try {
      shell.handle("L", "subscribeGauges", [true]);
      const primed = sent[0].message;
      expect(primed.relay === "gauges" && primed.signals).toContainEqual(["drag-frame", null]);
      expect(primed.relay === "gauges" && primed.signals).toContainEqual(["drag-zone", null]);
    } finally {
      shell.dispose();
    }
  });

  test("a drag's zones come back from the shell, and its commit is handed over by card", async () => {
    const calls: unknown[][] = [];
    const relay = createBodyMiniatureRelay({
      call: (method, args) => calls.push([method, ...args]),
      cardOfPane: (paneId) => (paneId === "body-pane-L" ? "L" : paneId === "p1" ? "A" : null),
    });
    try {
      const answer = relay.host.enumerateRemote("p1");
      expect(answer instanceof Promise).toBe(true);
      const asked = calls[calls.length - 1] as [string, number, string];
      expect([asked[0], asked[2]]).toEqual(["miniatureZones", "A"]);
      const set: DropZoneSet = { zones: [SLOT_ZONE], origin: null };
      relay.receive({
        command: "dispatch",
        id: MINIATURE_RELAY_ID,
        payload: { relay: "zones", requestId: asked[1], set } as unknown as Record<string, unknown>,
      });
      expect(await answer).toEqual(set);

      relay.host.carry("rail");
      relay.host.outline(null);
      expect(relay.host.commit(SLOT_ZONE, "body-pane-L")).toBe(true);
      expect(calls.slice(-3)).toEqual([
        ["miniatureCarry", "rail"],
        ["miniatureOutline", null],
        ["miniatureCommit", SLOT_ZONE, "L"],
      ]);
    } finally {
      relay.dispose();
    }
  });
});
