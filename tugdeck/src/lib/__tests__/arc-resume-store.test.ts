/**
 * `arcResumeStore` — the press, and the refusal that has nowhere else to go.
 *
 * The store carries two facts and deliberately not a third. It never says
 * whether an arc is still stopped, because a receipt is a frozen record and a
 * renderer that read live arc state into one would stop being a record.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { arcResumeStore } from "@/lib/arc-resume-store";

afterEach(() => {
  arcResumeStore.settle("alpha");
  arcResumeStore.settle("beta");
  arcResumeStore.clearRefusal("sess-1");
});

describe("the press", () => {
  it("holds the pressed arc and no other", () => {
    // A card can hold stop receipts for more than one arc, and a press on one
    // must not grey the other's button.
    arcResumeStore.press("alpha");
    expect(arcResumeStore.isPending("alpha")).toBe(true);
    expect(arcResumeStore.isPending("beta")).toBe(false);
  });

  it("releases on the answer", () => {
    arcResumeStore.press("alpha");
    arcResumeStore.settle("alpha");
    expect(arcResumeStore.isPending("alpha")).toBe(false);
  });

  it("releases on a refusal too", () => {
    // A button still greyed over a refusal the bulletin already spoke is a
    // control the user cannot retry.
    arcResumeStore.press("alpha");
    arcResumeStore.refuse("sess-1", "alpha", "card runs beta");
    expect(arcResumeStore.isPending("alpha")).toBe(false);
  });

  it("wakes its readers on both edges", () => {
    let woke = 0;
    const stop = arcResumeStore.subscribe(() => {
      woke += 1;
    });
    arcResumeStore.press("alpha");
    arcResumeStore.settle("alpha");
    stop();
    expect(woke).toBe(2);
  });

  it("does not wake them for a press already standing", () => {
    arcResumeStore.press("alpha");
    let woke = 0;
    const stop = arcResumeStore.subscribe(() => {
      woke += 1;
    });
    arcResumeStore.press("alpha");
    stop();
    expect(woke).toBe(0);
  });
});

describe("the refusal", () => {
  it("carries the arc and the reason, keyed by session", () => {
    arcResumeStore.refuse("sess-1", "alpha", "card runs beta");
    const refusal = arcResumeStore.refusalFor("sess-1");
    expect(refusal?.arc).toBe("alpha");
    expect(refusal?.reason).toBe("card runs beta");
    expect(arcResumeStore.refusalFor("sess-2")).toBeNull();
  });

  it("bumps its sequence so two identical refusals both speak", () => {
    // The second one is a second press, and a notice keyed on the words would
    // swallow it.
    arcResumeStore.refuse("sess-1", "alpha", "card runs beta");
    const first = arcResumeStore.refusalFor("sess-1")?.seq;
    arcResumeStore.refuse("sess-1", "alpha", "card runs beta");
    expect(arcResumeStore.refusalFor("sess-1")?.seq).not.toBe(first);
  });

  it("is forgotten when a later resume lands", () => {
    arcResumeStore.refuse("sess-1", "alpha", "card runs beta");
    arcResumeStore.clearRefusal("sess-1");
    expect(arcResumeStore.refusalFor("sess-1")).toBeNull();
  });
});
