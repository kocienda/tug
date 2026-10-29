/**
 * Unit tests for `compactionProgressStore` — the lean state machine behind the
 * `/compact` progress sheet and closing bulletin ([P07]). Native compaction is
 * opaque, so a run is just in-flight or settled: `{ outcome }` with a failure
 * reason — no phase ladder, no numeric progress. Runs are keyed by card, so any
 * number of cards can be compacting at once.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  compactionProgressStore,
  isCompactingCard,
} from "@/lib/compaction-progress-store";

beforeEach(() => {
  for (const cardId of compactionProgressStore.getSnapshot().keys()) {
    compactionProgressStore.clear(cardId);
  }
});

describe("compactionProgressStore", () => {
  it("is idle before a run", () => {
    expect(compactionProgressStore.getSnapshot().size).toBe(0);
    expect(compactionProgressStore.getFor("A")).toBeNull();
  });

  it("begins in flight for its card, no outcome", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    expect(compactionProgressStore.getFor("A")).toEqual({
      turnKey: "turn-A",
      afterMsgId: null,
      outcome: null,
      failureReason: null,
    });
    expect(isCompactingCard(compactionProgressStore.getSnapshot(), "A")).toBe(
      true,
    );
  });

  it("succeed settles the outcome", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    compactionProgressStore.succeed("A");
    expect(compactionProgressStore.getFor("A")?.outcome).toBe("succeeded");
    expect(isCompactingCard(compactionProgressStore.getSnapshot(), "A")).toBe(
      false,
    );
  });

  it("cancel and fail carry their outcome (fail keeps the reason)", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    compactionProgressStore.cancel("A");
    expect(compactionProgressStore.getFor("A")?.outcome).toBe("canceled");

    compactionProgressStore.clear("A");
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    compactionProgressStore.fail("A", "boom");
    const s = compactionProgressStore.getFor("A");
    expect(s?.outcome).toBe("failed");
    expect(s?.failureReason).toBe("boom");
    // Settling keeps the run's turn.
    expect(s?.turnKey).toBe("turn-A");
  });

  it("a second terminal call is a no-op (first outcome wins)", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    compactionProgressStore.succeed("A");
    compactionProgressStore.cancel("A");
    expect(compactionProgressStore.getFor("A")?.outcome).toBe("succeeded");
  });

  it("clear resets that card to idle", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    compactionProgressStore.succeed("A");
    compactionProgressStore.clear("A");
    expect(compactionProgressStore.getFor("A")).toBeNull();
  });

  it("holds concurrent runs independently — one settling leaves the other alone", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    compactionProgressStore.begin("B", { turnKey: "turn-B", afterMsgId: null });
    expect(compactionProgressStore.getFor("A")?.outcome).toBeNull();
    expect(compactionProgressStore.getFor("B")?.outcome).toBeNull();

    // A finishes first and clears itself: B is still in flight, sheet up.
    compactionProgressStore.succeed("A");
    compactionProgressStore.clear("A");
    expect(compactionProgressStore.getFor("A")).toBeNull();
    expect(isCompactingCard(compactionProgressStore.getSnapshot(), "B")).toBe(
      true,
    );

    // B settles on its own terms, with its own outcome.
    compactionProgressStore.fail("B", "boom");
    expect(compactionProgressStore.getFor("B")?.failureReason).toBe("boom");
  });

  it("settleFrom settles only the in-flight run over the verdict's turn", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    // A verdict read for some other turn — a run since replaced — changes nothing.
    compactionProgressStore.settleFrom("A", "turn-old", { outcome: "failed", failureReason: "stale" });
    expect(compactionProgressStore.getFor("A")?.outcome).toBeNull();

    compactionProgressStore.settleFrom("A", "turn-A", { outcome: "failed", failureReason: "boom" });
    expect(compactionProgressStore.getFor("A")).toMatchObject({ outcome: "failed", failureReason: "boom" });

    // Settled already: a second verdict, from the other reader, is a no-op.
    compactionProgressStore.settleFrom("A", "turn-A", { outcome: "succeeded", failureReason: null });
    expect(compactionProgressStore.getFor("A")?.outcome).toBe("failed");
  });

  it("settling an unknown card is a no-op", () => {
    compactionProgressStore.succeed("A");
    compactionProgressStore.clear("A");
    expect(compactionProgressStore.getSnapshot().size).toBe(0);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    let n = 0;
    const unsub = compactionProgressStore.subscribe(() => {
      n += 1;
    });
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    compactionProgressStore.succeed("A");
    expect(n).toBe(2);
    unsub();
    compactionProgressStore.clear("A");
    expect(n).toBe(2);
  });

  it("performs the run's own cancel, once, and only while it is in flight", () => {
    let asked = 0;
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null }, () => {
      asked += 1;
      compactionProgressStore.cancel("A");
    });

    expect(compactionProgressStore.requestCancel("A")).toBe(true);
    expect(asked).toBe(1);
    expect(compactionProgressStore.getFor("A")?.outcome).toBe("canceled");

    // Settled: there is nothing left to interrupt, so a second press does
    // nothing rather than interrupting whatever turn came next.
    expect(compactionProgressStore.requestCancel("A")).toBe(false);
    expect(asked).toBe(1);
  });

  it("answers false when there is no run, or a run with no cancel", () => {
    expect(compactionProgressStore.requestCancel("A")).toBe(false);
    compactionProgressStore.begin("B", { turnKey: "turn-B", afterMsgId: null });
    expect(compactionProgressStore.requestCancel("B")).toBe(false);
  });

  it("drops the cancel with the run — a cleared card cannot be canceled", () => {
    let asked = 0;
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null }, () => {
      asked += 1;
    });
    compactionProgressStore.clear("A");
    // A second run on the same card, opened without one, must not inherit it.
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    expect(compactionProgressStore.requestCancel("A")).toBe(false);
    expect(asked).toBe(0);
  });

  it("keeps stable snapshot references between notifications", () => {
    compactionProgressStore.begin("A", { turnKey: "turn-A", afterMsgId: null });
    expect(compactionProgressStore.getSnapshot()).toBe(
      compactionProgressStore.getSnapshot(),
    );
    expect(compactionProgressStore.getFor("A")).toBe(
      compactionProgressStore.getFor("A"),
    );

    // Another card's run must not churn this card's snapshot identity —
    // a changed reference would re-render every card's sheet.
    const a = compactionProgressStore.getFor("A");
    compactionProgressStore.begin("B", { turnKey: "turn-B", afterMsgId: null });
    expect(compactionProgressStore.getFor("A")).toBe(a);
  });
});
