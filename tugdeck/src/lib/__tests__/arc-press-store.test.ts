/**
 * `arcPressStore` — the press, and the refusal that has nowhere else to go.
 *
 * The store carries two facts and deliberately not a third. It never says
 * whether an arc is still stopped, because a receipt is a frozen record and a
 * renderer that read live arc state into one would stop being a record.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { arcPressStore } from "@/lib/arc-press-store";

afterEach(() => {
  for (const arc of ["alpha", "beta"] as const) {
    for (const verb of ["start", "resume", "stop"] as const) {
      arcPressStore.settle(arc, verb);
    }
  }
  arcPressStore.clearRefusal("sess-1");
});

describe("the press", () => {
  it("holds the pressed arc and no other", () => {
    // A card can show more than one arc, and a press on one must not grey the
    // other's button.
    arcPressStore.press("alpha", "resume");
    expect(arcPressStore.isPending("alpha", "resume")).toBe(true);
    expect(arcPressStore.isPending("beta", "resume")).toBe(false);
  });

  it("holds the pressed verb and no other on the same arc", () => {
    // The Arcs card's row and a stop receipt below it can be about one arc at
    // once. A Stop still waiting for its answer says nothing about whether a
    // Start on that arc is pressable.
    arcPressStore.press("alpha", "stop");
    expect(arcPressStore.isPending("alpha", "stop")).toBe(true);
    expect(arcPressStore.isPending("alpha", "start")).toBe(false);
    expect(arcPressStore.isPending("alpha", "resume")).toBe(false);
  });

  it("releases on the answer", () => {
    arcPressStore.press("alpha", "resume");
    arcPressStore.settle("alpha", "resume");
    expect(arcPressStore.isPending("alpha", "resume")).toBe(false);
  });

  it("releases on a refusal too", () => {
    // A button still greyed over a refusal the bulletin already spoke is a
    // control the user cannot retry.
    arcPressStore.press("alpha", "resume");
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    expect(arcPressStore.isPending("alpha", "resume")).toBe(false);
  });

  it("releases only the refused verb", () => {
    arcPressStore.press("alpha", "start");
    arcPressStore.press("alpha", "stop");
    arcPressStore.refuse("sess-1", "alpha", "stop", "no card is running it");
    expect(arcPressStore.isPending("alpha", "stop")).toBe(false);
    expect(arcPressStore.isPending("alpha", "start")).toBe(true);
  });

  it("wakes its readers on both edges", () => {
    let woke = 0;
    const stop = arcPressStore.subscribe(() => {
      woke += 1;
    });
    arcPressStore.press("alpha", "resume");
    arcPressStore.settle("alpha", "resume");
    stop();
    expect(woke).toBe(2);
  });

  it("does not wake them for a press already standing", () => {
    arcPressStore.press("alpha", "resume");
    let woke = 0;
    const stop = arcPressStore.subscribe(() => {
      woke += 1;
    });
    arcPressStore.press("alpha", "resume");
    stop();
    expect(woke).toBe(0);
  });
});

describe("the refusal", () => {
  it("carries the arc, the verb and the reason, keyed by session", () => {
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    const refusal = arcPressStore.refusalFor("sess-1");
    expect(refusal?.arc).toBe("alpha");
    expect(refusal?.verb).toBe("resume");
    expect(refusal?.reason).toBe("card runs beta");
    expect(arcPressStore.refusalFor("sess-2")).toBeNull();
  });

  it("bumps its sequence so two identical refusals both speak", () => {
    // The second one is a second press, and a notice keyed on the words would
    // swallow it.
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    const first = arcPressStore.refusalFor("sess-1")?.seq;
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    expect(arcPressStore.refusalFor("sess-1")?.seq).not.toBe(first);
  });

  it("is forgotten when a later press lands", () => {
    arcPressStore.refuse("sess-1", "alpha", "resume", "card runs beta");
    arcPressStore.clearRefusal("sess-1");
    expect(arcPressStore.refusalFor("sess-1")).toBeNull();
  });
});
