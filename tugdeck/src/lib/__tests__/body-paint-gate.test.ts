/**
 * The shell shows a body only once the host has composited its first frame
 * and both `card.painted` and `card.facts` have arrived — whatever order
 * the two snapshots reach the shell in. The real stores on every page of
 * the test bus.
 *
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cardFacts, cardPainted, type CardFactsValue } from "../../bus/declarations/card";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { createBodyPaintGate } from "../body-shell";

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

describe("the shell's paint gate", () => {
  test("a body whose painted snapshot arrives before its facts is not shown until the facts arrive", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1", "session");
    await bus.flush();
    const shown: string[] = [];
    const gate = createBodyPaintGate(shell.bus, (cardId) => shown.push(cardId));

    gate.hostPainted("c1");
    cardPainted.on(body.bus).set(true);
    await bus.flush();
    expect(cardPainted.on(shell.bus).getFor("c1")).toBe(true);
    expect(shown).toEqual([]);

    cardFacts.on(body.bus).set(FACTS);
    await bus.flush();
    expect(shown).toEqual(["c1"]);
    gate.dispose();
  });

  test("the host's half is still waited on, and a forgotten card is never shown", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1", "session");
    await bus.flush();
    const shown: string[] = [];
    const gate = createBodyPaintGate(shell.bus, (cardId) => shown.push(cardId));

    cardFacts.on(body.bus).set(FACTS);
    cardPainted.on(body.bus).set(true);
    await bus.flush();
    expect(shown).toEqual([]);
    gate.hostPainted("c1");
    expect(shown).toEqual(["c1"]);

    gate.forget("c1");
    const b2 = bus.body("c2", "session");
    await bus.flush();
    gate.hostPainted("c2");
    gate.forget("c2");
    cardFacts.on(b2.bus).set(FACTS);
    cardPainted.on(b2.bus).set(true);
    await bus.flush();
    expect(shown).toEqual(["c1"]);
    gate.dispose();
  });

  test("on the wire a body's facts precede its painted snapshot when it attaches", async () => {
    bus = createTestBus();
    const body = bus.body("c1", "session");
    cardPainted.on(body.bus).set(true);
    cardFacts.on(body.bus).set(FACTS);
    await bus.flush();
    bus.shell();
    await bus.flush();
    const keys = bus
      .frames()
      .filter((f) => f.envelope.kind === "state" && f.from === body.pageId)
      .map((f) => f.envelope.key);
    expect(keys.indexOf("card.facts")).toBeLessThan(keys.indexOf("card.painted"));
  });
});
