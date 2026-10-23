/**
 * A body speaks only when what it says changes: identical facts go once, a
 * phase change goes, a keystroke that leaves `waive` where it was sends
 * nothing, a card with no close guard says none while a guarded card says
 * when its guard would ask, a card says when a modal run takes and lets go
 * its hold, and a pointer asks for activation on every press. Each is the
 * exchange the shell sees, on the test bus.
 *
 * @covers tugdeck/src/body/body-publisher.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cardFacts, cardHolds, type CardFactsValue } from "../../bus/declarations/card";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import { BodyPublisher } from "../body-publisher";
import { cardActivate } from "../../bus/declarations/verbs";

interface State {
  facts: CardFactsValue;
  waive: boolean;
  guarded: boolean;
  asks: boolean | null;
  hold: { reason: string; admitsFold: boolean } | null;
}

let bus: TestBus;
afterEach(() => bus?.dispose());

async function setup(): Promise<{
  state: State;
  shell: TestPage;
  publisher: BodyPublisher;
  activations: () => number;
  sent: (key: string) => unknown[];
}> {
  bus = createTestBus();
  const shell = bus.shell();
  const body = bus.body("c1", "session");
  await bus.flush();
  const state: State = {
    facts: {
      title: "tug/odd-kiln",
      masthead: null,
      activity: "idle",
      identity: null,
      titleBar: null,
      canInterrupt: false,
      compacted: false,
      dormant: false,
    },
    waive: true,
    guarded: true,
    asks: null,
    hold: null,
  };
  let activated = 0;
  const publisher = new BodyPublisher(
    {
      readFacts: () => state.facts,
      readWaive: () => state.waive,
      readGuarded: () => state.guarded,
      readAsks: () => state.asks,
      readAnswered: () => state.asks !== null,
      readHold: () => state.hold,
      readCaptureArmed: () => false,
      readRestoreHold: () => null,
      readContent: () => null,
      readKbfPaint: () => null,
    },
    body.bus,
  );
  cardActivate.on(shell.bus).handle(() => {
    activated += 1;
  });
  const sent = (key: string): unknown[] =>
    bus
      .frames()
      .filter((f) => f.envelope.kind === "state" && (f.envelope as { key?: string }).key === key)
      .map((f) => (f.envelope as { payload?: unknown }).payload);
  return { state, shell, publisher, activations: () => activated, sent };
}

describe("publish on change", () => {
  test("identical facts send once", async () => {
    const { state, publisher, sent } = await setup();
    publisher.publish();
    state.facts = { ...state.facts };
    publisher.publish();
    await bus.flush();
    expect(sent("card.facts")).toHaveLength(1);
    expect(sent("card.holds")).toHaveLength(1);
  });

  test("a phase change sends the facts again", async () => {
    const { state, shell, publisher, sent } = await setup();
    publisher.publish();
    state.facts = { ...state.facts, activity: "streaming" };
    publisher.publish();
    await bus.flush();
    expect(sent("card.facts").map((f) => (f as CardFactsValue).activity)).toEqual(["idle", "streaming"]);
    expect(cardFacts.on(shell.bus).getFor("c1")?.activity).toBe("streaming");
  });

  test("a waive that does not flip sends nothing; one that flips sends the holds", async () => {
    const { state, shell, publisher, sent } = await setup();
    publisher.publish();
    publisher.publish();
    await bus.flush();
    expect(sent("card.holds")).toHaveLength(1);
    state.waive = false;
    publisher.publish();
    await bus.flush();
    expect(sent("card.holds")).toHaveLength(2);
    expect(cardHolds.on(shell.bus).getFor("c1").waive).toBe(false);
  });

  test("a card with no close guard says none; a guarded card says when its guard would ask", async () => {
    const { state, shell, publisher, sent } = await setup();
    publisher.publish();
    await bus.flush();
    expect(cardHolds.on(shell.bus).getFor("c1").closeGuardAsks).toBe(null);
    state.asks = false;
    publisher.publish();
    state.asks = true;
    publisher.publish();
    publisher.publish();
    await bus.flush();
    expect(sent("card.holds").map((h) => (h as { closeGuardAsks: boolean | null }).closeGuardAsks)).toEqual([
      null,
      false,
      true,
    ]);
  });
});

describe("modal hold", () => {
  test("no hold says none; a hold and its release each go once", async () => {
    const { state, shell, publisher, sent } = await setup();
    publisher.publish();
    state.hold = { reason: "Compacting.", admitsFold: true };
    publisher.publish();
    publisher.publish();
    await bus.flush();
    expect(cardHolds.on(shell.bus).getFor("c1").modalHold).toEqual({ reason: "Compacting.", admitsFold: true });
    state.hold = null;
    publisher.publish();
    publisher.publish();
    await bus.flush();
    expect(sent("card.holds").map((h) => (h as { modalHold: unknown }).modalHold)).toEqual([
      null,
      { reason: "Compacting.", admitsFold: true },
      null,
    ]);
  });
});

describe("activation", () => {
  test("a pointer asks to activate on every press: only the shell knows whether the card is already key", async () => {
    const { publisher, activations } = await setup();
    publisher.pointerDown();
    publisher.pointerDown();
    await bus.flush();
    expect(activations()).toBe(2);
  });
});
