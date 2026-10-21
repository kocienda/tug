/**
 * A body's own card stores as the shell reads them: the order the shell
 * hears facts and paint in, what a termination takes with the page, and
 * that a publish that moves nothing sends nothing. The real library on
 * every page of the test bus.
 *
 * @covers tugdeck/src/bus/declarations/card.ts
 * @covers tugdeck/src/body/body-publisher.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { BodyPublisher } from "../../body/body-publisher";
import {
  cardFacts,
  cardHolds,
  cardPainted,
  cardSurface,
  NO_CARD_HOLDS,
  type CardFactsValue,
} from "../declarations/card";
import { createTestBus, type TestBus, type TestPage } from "../test-bus";

let bus: TestBus;
afterEach(() => bus?.dispose());

const FACTS: CardFactsValue = {
  title: "tug/odd-kiln",
  masthead: null,
  activity: "idle",
  identity: null,
  titleBar: null,
  canInterrupt: false,
  compacted: false,
  dormant: false,
};

const SURFACE = {
  title: "Z2",
  className: "z2",
  growth: "up" as const,
  anchorX: 10,
  lineY: 20,
  html: "<p>x</p>",
  scroll: [],
};

function publisherOn(body: TestPage, facts: () => CardFactsValue): BodyPublisher {
  return new BodyPublisher(
    {
      readFacts: facts,
      readWaive: () => false,
      readGuarded: () => true,
      readAsks: () => null,
      readHold: () => null,
      readCaptureArmed: () => false,
      readRestoreHold: () => null,
      readContent: () => null,
      readKbfPaint: () => null,
    },
    body.bus,
  );
}

/** What the shell hears, in order: each `card.facts` title and each `card.painted`. */
function heard(shell: TestPage): string[] {
  const order: string[] = [];
  cardFacts.on(shell.bus).subscribe(() => order.push(`facts:${cardFacts.on(shell.bus).getFor("c1")?.title}`));
  cardPainted.on(shell.bus).subscribe(() => order.push(`painted:${cardPainted.on(shell.bus).getFor("c1")}`));
  return order;
}

describe("a body's own card stores", () => {
  test("card.painted is received after the card.facts it was drawn with", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const order = heard(shell);
    const body = bus.body("c1", "session");
    await bus.flush();
    let title = "first";
    const publisher = publisherOn(body, () => ({ ...FACTS, title }));
    publisher.publish();
    title = "drawn";
    // What `signalReadyWhenQuiet` does after the frame: publish, then paint.
    publisher.publish();
    cardPainted.on(body.bus).set(true);
    await bus.flush();
    expect(order).toEqual(["facts:first", "facts:drawn", "painted:true"]);
  });

  test("a shell that comes up after the body paints still hears the facts first", async () => {
    bus = createTestBus();
    const body = bus.body("c1", "session");
    await bus.flush();
    publisherOn(body, () => FACTS).publish();
    cardPainted.on(body.bus).set(true);
    const shell = bus.shell();
    const order = heard(shell);
    await bus.flush();
    expect(order).toEqual(["facts:tug/odd-kiln", "painted:true"]);
  });

  test("a termination clears card.holds and card.surface and keeps card.facts", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1", "session");
    await bus.flush();
    cardFacts.on(body.bus).set(FACTS);
    cardHolds.on(body.bus).set({ ...NO_CARD_HOLDS, modalHold: { reason: "Compacting.", admitsFold: false } });
    cardSurface.on(body.bus).set(SURFACE);
    cardPainted.on(body.bus).set(true);
    await bus.flush();
    expect(cardSurface.on(shell.bus).getFor("c1")).toEqual(SURFACE);

    bus.detach("c1");
    await bus.flush();
    expect(cardHolds.on(shell.bus).getFor("c1")).toBe(NO_CARD_HOLDS);
    expect(cardSurface.on(shell.bus).getFor("c1")).toBeNull();
    expect(cardPainted.on(shell.bus).getFor("c1")).toBe(false);
    expect(cardFacts.on(shell.bus).getFor("c1")).toEqual(FACTS);
  });

  test("a repeated identical publish sends nothing", async () => {
    bus = createTestBus();
    bus.shell();
    const body = bus.body("c1", "session");
    await bus.flush();
    const publisher = publisherOn(body, () => ({ ...FACTS }));
    publisher.publish();
    await bus.flush();
    const before = bus.frames().length;
    publisher.publish();
    publisher.publish();
    await bus.flush();
    expect(bus.frames().length).toBe(before);
  });
});

describe("card.facts speaks only for its own card", () => {
  test("a body that sends card.facts naming a sibling moves neither the sibling's facts nor its epoch in the shell", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const b1 = bus.body("c1", "session");
    const b2 = bus.body("c2", "session");
    await bus.flush();
    cardFacts.on(b2.bus).set(FACTS);
    await bus.flush();
    const before = shell.bus.census().extensions["store:card.facts"];

    b1.bus.post({ to: "shell", kind: "state", key: "card.facts", card: "c2", version: 1, payload: { ...FACTS, title: "forged" } });
    await bus.flush();

    expect(cardFacts.on(shell.bus).getFor("c2")).toEqual(FACTS);
    expect(shell.bus.census().extensions["store:card.facts"]).toEqual(before);
    expect(shell.log.some((l) => l.level === "warn" && l.message.includes("card.facts") && l.message.includes("refused"))).toBe(true);
  });
});
