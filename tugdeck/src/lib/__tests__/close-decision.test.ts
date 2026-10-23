/**
 * The shell's close decision for a body card, on the test bus: a body that
 * answers decides the close; one silent past the deadline cancels it and
 * stands the visible refusal on the card's pane ([L33]) rather than only a
 * dev-log line; one whose page goes away while asked cancels it and stands
 * the same refusal with that reason; asking again takes the refusal down.
 *
 * @covers tugdeck/src/lib/close-decision.ts
 * @covers tugdeck/src/lib/close-refusal-store.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cardCloseDecision } from "../../bus/declarations/verbs";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { askCloseDecision } from "../close-decision";
import { closeRefusalStore } from "../close-refusal-store";

let bus: TestBus;
afterEach(() => {
  closeRefusalStore.clear("c1");
  bus?.dispose();
});

/** Settle the bus while `pending` is in flight, then await it. */
async function settled<T>(pending: Promise<T>): Promise<T> {
  for (let i = 0; i < 10; i++) await bus.flush();
  return pending;
}

describe("the close decision's horizon", () => {
  test("a body that does not answer in time cancels the close and dispatches the visible refusal for its card", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    bus.body("c1", "session"); // no handler: the body never answers
    bus.install(shell);
    await bus.flush();
    const flashed: string[] = [];
    const release = closeRefusalStore.onRefuse((cardId) => flashed.push(cardId));

    const answer = await settled(askCloseDecision("c1", false, 20));

    expect(answer).toBe("cancel");
    expect(closeRefusalStore.isRefused("c1")).toBe(true);
    expect(flashed).toEqual(["c1"]);
    release();
  });

  test("a body whose page goes away while asked cancels the close and stands the refusal, saying its page went away", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1", "session");
    bus.install(shell);
    await bus.flush();
    // The page holds the ask, as a guard whose sheet is up does, and then goes.
    cardCloseDecision.on(body.bus).handle(() => new Promise(() => undefined));
    const flashed: string[] = [];
    const release = closeRefusalStore.onRefuse((cardId) => flashed.push(cardId));

    const pending = askCloseDecision("c1", true);
    await bus.flush();
    bus.detach("c1");

    expect(await settled(pending)).toBe("cancel");
    expect(closeRefusalStore.reasonOf("c1")).toBe("gone");
    expect(flashed).toEqual(["c1"]);
    release();
  });

  test("a body that answers decides the close, and asking again takes a standing refusal down", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1", "session");
    bus.install(shell);
    await bus.flush();
    closeRefusalStore.refuse("c1");
    cardCloseDecision.on(body.bus).handle(() => ({ answer: "close" as const }));

    const pending = askCloseDecision("c1", false, 2000);
    expect(closeRefusalStore.isRefused("c1")).toBe(false);
    expect(await settled(pending)).toBe("close");
    expect(closeRefusalStore.isRefused("c1")).toBe(false);
  });

  test("a guard that asks waits on the person: no deadline, so no refusal while the sheet is up", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const body = bus.body("c1", "session");
    bus.install(shell);
    await bus.flush();
    let answer: ((a: "close" | "cancel") => void) | null = null;
    cardCloseDecision.on(body.bus).handle(() => new Promise((resolve) => (answer = (a) => resolve({ answer: a }))));

    const pending = askCloseDecision("c1", true, 20);
    await bus.flush();
    await new Promise((r) => setTimeout(r, 60));
    expect(closeRefusalStore.isRefused("c1")).toBe(false);
    (answer as ((a: "close" | "cancel") => void) | null)?.("cancel");
    expect(await settled(pending)).toBe("cancel");
    expect(closeRefusalStore.isRefused("c1")).toBe(false);
  });
});
