/**
 * The shell answers a body card's phase, live turn, compaction, close advice
 * and fold guard from what the card's body last set in its own stores, per
 * card; an identical set keeps the object and notifies nobody. Each card's
 * body is a page of the test bus.
 *
 * @covers tugdeck/src/lib/body-facts-store.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cardContent, cardFacts, cardHolds, NO_CARD_HOLDS, type CardFactsValue } from "../../bus/declarations/card";
import { _pageBusBinderCountForTest } from "../../bus/page-bus";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import type { CardMastheadPayload } from "../card-title-store";
import { BodyFactsStore } from "../body-facts-store";

function facts(over: Partial<CardFactsValue> = {}): CardFactsValue {
  return {
    title: "tug/odd-kiln",
    masthead: { kind: "session-masthead", sessionId: "s1" } as unknown as CardMastheadPayload,
    activity: "idle",
    identity: null,
    titleBar: null,
    canInterrupt: false,
    compacted: false,
    dormant: false,
    ...over,
  };
}

let bus: TestBus;
const made: BodyFactsStore[] = [];
afterEach(() => {
  for (const store of made.splice(0)) store.dispose();
  bus?.dispose();
});

async function setup(): Promise<{ store: BodyFactsStore; a: TestPage; b: TestPage }> {
  bus = createTestBus();
  const shell = bus.shell();
  const a = bus.body("a", "session");
  const b = bus.body("b", "session");
  await bus.flush();
  const store = new BodyFactsStore(() => shell.bus);
  made.push(store);
  return { store, a, b };
}

describe("facts", () => {
  test("phase, live turn and compaction follow the last facts per card", async () => {
    const { store, a, b } = await setup();
    expect(store.activityOf("a")).toBe(null);
    expect(store.canInterrupt("a")).toBe(false);

    cardFacts.on(a.bus).set(facts({ activity: "streaming", canInterrupt: true }));
    cardFacts.on(b.bus).set(facts({ compacted: true }));
    await bus.flush();
    expect(store.activityOf("a")).toBe("streaming");
    expect(store.canInterrupt("a")).toBe(true);
    expect(store.compacted("a")).toBe(false);
    expect(store.activityOf("b")).toBe("idle");
    expect(store.compacted("b")).toBe(true);

    cardFacts.on(a.bus).set(facts());
    await bus.flush();
    expect(store.activityOf("a")).toBe("idle");
    expect(store.canInterrupt("a")).toBe(false);
  });

  test("identical facts keep the object and notify nobody", async () => {
    const { store, a } = await setup();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    cardFacts.on(a.bus).set(facts());
    await bus.flush();
    const first = store.get("a");
    cardFacts.on(a.bus).set(facts());
    await bus.flush();
    expect(store.get("a")).toBe(first);
    expect(notified).toBe(1);
  });
});

describe("holds", () => {
  test("close advice and the fold guard answer from the last holds, defaulting to the in-shell answers", async () => {
    const { store, a } = await setup();
    expect(store.waives("a")).toBe(false);
    expect(store.guarded("a")).toBe(true);

    cardHolds.on(a.bus).set({ ...NO_CARD_HOLDS, waive: true, guarded: false });
    await bus.flush();
    expect(store.waives("a")).toBe(true);
    expect(store.guarded("a")).toBe(false);
    expect(store.waives("b")).toBe(false);

    const held = store.get("a");
    cardHolds.on(a.bus).set({ ...NO_CARD_HOLDS, waive: true, guarded: false });
    await bus.flush();
    expect(store.get("a")).toBe(held);
  });

  test("a card that has said nothing reads as nothing, the same object for every such card", async () => {
    const { store } = await setup();
    expect(store.get("a")).toBe(store.get("never"));
    expect(store.factsOf("a")).toBe(null);
  });
});

describe("release", () => {
  test("a store disposed leaves no binder behind and is notified of nothing after", async () => {
    const before = _pageBusBinderCountForTest();
    const { store, a } = await setup();
    expect(_pageBusBinderCountForTest()).toBe(before + 1);
    let heard = 0;
    store.subscribe(() => heard++);

    store.dispose();
    expect(_pageBusBinderCountForTest()).toBe(before);
    cardFacts.on(a.bus).set(facts({ activity: "streaming" }));
    await bus.flush();
    expect(heard).toBe(0);
  });

  test("a body setting card.content notifies the store's readers", async () => {
    const { store, a } = await setup();
    let heard = 0;
    store.subscribe(() => heard++);

    cardContent.on(a.bus).set({ content: 400, shown: 300 });
    await bus.flush();
    expect(heard).toBeGreaterThan(0);
    expect(store.contentOf("a")).toEqual({ content: 400, shown: 300 });
  });
});
