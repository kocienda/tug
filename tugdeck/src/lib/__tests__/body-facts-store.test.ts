/**
 * The shell answers a body card's phase, live turn, compaction, close advice
 * and fold guard from the last message the body sent about it, per card; an
 * identical message keeps the stored object and notifies nobody.
 *
 * @covers tugdeck/src/lib/body-facts-store.ts
 */
import { describe, expect, test } from "bun:test";
import type { CardFacts } from "@tugproto/bus";
import { BodyFactsStore } from "../body-facts-store";

function facts(over: Partial<CardFacts> = {}): CardFacts {
  return {
    title: "tug/odd-kiln",
    masthead: { kind: "session-masthead", sessionId: "s1" },
    activity: "idle",
    telemetry: { canInterrupt: 0, compacted: 0 },
    ...over,
  };
}

describe("facts", () => {
  test("phase, live turn and compaction follow the last message per card", () => {
    const store = new BodyFactsStore();
    expect(store.activityOf("a")).toBe(null);
    expect(store.canInterrupt("a")).toBe(false);

    store.applyFacts("a", facts({ activity: "streaming", telemetry: { canInterrupt: 1, compacted: 0 } }));
    store.applyFacts("b", facts({ telemetry: { canInterrupt: 0, compacted: 1 } }));
    expect(store.activityOf("a")).toBe("streaming");
    expect(store.canInterrupt("a")).toBe(true);
    expect(store.compacted("a")).toBe(false);
    expect(store.activityOf("b")).toBe("idle");
    expect(store.compacted("b")).toBe(true);

    store.applyFacts("a", facts());
    expect(store.activityOf("a")).toBe("idle");
    expect(store.canInterrupt("a")).toBe(false);
  });

  test("an identical message keeps the object and notifies nobody", () => {
    const store = new BodyFactsStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.applyFacts("a", facts())).toBe(true);
    const first = store.get("a");
    expect(store.applyFacts("a", facts({ telemetry: { canInterrupt: 0, compacted: 0 } }))).toBe(false);
    expect(store.get("a")).toBe(first);
    expect(notified).toBe(1);
  });
});

describe("advice", () => {
  test("close advice and the fold guard answer from the last advice, defaulting to the in-shell answers", () => {
    const store = new BodyFactsStore();
    expect(store.waives("a")).toBe(false);
    expect(store.guarded("a")).toBe(true);

    store.applyAdvice("a", { advice: "close-advice", waive: true });
    store.applyAdvice("a", { advice: "fold-guard", guarded: false });
    expect(store.waives("a")).toBe(true);
    expect(store.guarded("a")).toBe(false);
    expect(store.waives("b")).toBe(false);

    const held = store.get("a");
    expect(store.applyAdvice("a", { advice: "close-advice", waive: true })).toBe(false);
    expect(store.get("a")).toBe(held);
  });

  test("advice that is an act rather than a fact is not held", () => {
    const store = new BodyFactsStore();
    expect(store.applyAdvice("a", { advice: "activate" })).toBe(false);
    expect(store.applyAdvice("a", { advice: "sheet-reservation", heightPx: 200 })).toBe(false);
    expect(store.get("a")).toBe(store.get("never"));
  });
});
