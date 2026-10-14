/**
 * A body speaks only when what it says changes: identical facts go once, a
 * phase change goes, a keystroke that leaves `waive` where it was sends
 * nothing, and a pointer in a body that is already the first responder asks
 * for nothing.
 *
 * @covers tugdeck/src/body/body-publisher.ts
 */
import { describe, expect, test } from "bun:test";
import type { BusMessage, CardFacts } from "@tugproto/bus";
import { BodyPublisher } from "../body-publisher";

interface State {
  facts: CardFacts;
  waive: boolean;
  guarded: boolean;
  firstResponder: boolean;
}

function setup(): { state: State; sent: BusMessage[]; publisher: BodyPublisher } {
  const state: State = {
    facts: { title: "tug/odd-kiln", masthead: null, activity: "idle", telemetry: { canInterrupt: 0, compacted: 0 } },
    waive: true,
    guarded: true,
    firstResponder: false,
  };
  const sent: BusMessage[] = [];
  const publisher = new BodyPublisher(
    {
      readFacts: () => state.facts,
      readWaive: () => state.waive,
      readGuarded: () => state.guarded,
      isFirstResponder: () => state.firstResponder,
    },
    (message) => sent.push(message),
  );
  return { state, sent, publisher };
}

describe("publish on change", () => {
  test("identical facts send once", () => {
    const { state, sent, publisher } = setup();
    publisher.publish();
    state.facts = { ...state.facts, telemetry: { ...state.facts.telemetry } };
    publisher.publish();
    expect(sent.filter((m) => m.kind === "card-facts")).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  test("a phase change sends the facts again", () => {
    const { state, sent, publisher } = setup();
    publisher.publish();
    state.facts = { ...state.facts, activity: "streaming" };
    publisher.publish();
    const facts = sent.filter((m) => m.kind === "card-facts");
    expect(facts.map((m) => (m.payload as CardFacts).activity)).toEqual(["idle", "streaming"]);
  });

  test("a waive that does not flip sends nothing; one that flips sends its advice", () => {
    const { state, sent, publisher } = setup();
    publisher.publish();
    const before = sent.length;
    publisher.publish();
    expect(sent.length).toBe(before);
    state.waive = false;
    publisher.publish();
    expect(sent.slice(before)).toEqual([
      { kind: "card-advice", payload: { advice: "close-advice", waive: false } },
    ]);
  });
});

describe("activation", () => {
  test("a pointer asks to activate only while the card is not the first responder", () => {
    const { state, sent, publisher } = setup();
    publisher.pointerDown();
    state.firstResponder = true;
    publisher.pointerDown();
    expect(sent).toEqual([{ kind: "card-advice", payload: { advice: "activate" } }]);
  });
});
