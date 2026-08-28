/**
 * Unit tests for `cardModalHoldStore` — the card-keyed record of which cards a
 * modal run is holding, and the single refusal voice every closed door speaks
 * through ([L31]). One hold per card, replace-on-claim, and a release that is
 * keyed on the record it was handed out for.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  cardModalHoldStore,
  isCardHeld,
  refuseCardModalHold,
} from "@/lib/card-modal-hold-store";

const releases: Array<() => void> = [];

function hold(cardId: string, reason: string, refuse: () => void = () => {}) {
  const release = cardModalHoldStore.hold(cardId, { reason, refuse });
  releases.push(release);
  return release;
}

beforeEach(() => {
  while (releases.length > 0) releases.pop()?.();
});

describe("cardModalHoldStore", () => {
  it("holds nothing before a run", () => {
    expect(cardModalHoldStore.getSnapshot().size).toBe(0);
    expect(cardModalHoldStore.getFor("A")).toBeNull();
    expect(isCardHeld(cardModalHoldStore.getSnapshot(), "A")).toBe(false);
  });

  it("holds only the card that claimed", () => {
    hold("A", "Compacting");
    expect(isCardHeld(cardModalHoldStore.getSnapshot(), "A")).toBe(true);
    expect(isCardHeld(cardModalHoldStore.getSnapshot(), "B")).toBe(false);
    expect(cardModalHoldStore.getFor("A")?.reason).toBe("Compacting");
  });

  it("answers false for a card that is not named", () => {
    hold("A", "Compacting");
    expect(isCardHeld(cardModalHoldStore.getSnapshot(), undefined)).toBe(false);
    expect(isCardHeld(cardModalHoldStore.getSnapshot(), null)).toBe(false);
    expect(cardModalHoldStore.getFor(null)).toBeNull();
  });

  it("releases the card it held", () => {
    const release = hold("A", "Compacting");
    release();
    expect(isCardHeld(cardModalHoldStore.getSnapshot(), "A")).toBe(false);
  });

  it("a second claim replaces the first", () => {
    hold("A", "first");
    hold("A", "second");
    expect(cardModalHoldStore.getSnapshot().size).toBe(1);
    expect(cardModalHoldStore.getFor("A")?.reason).toBe("second");
  });

  it("a stale release cannot drop the live hold", () => {
    const staleRelease = hold("A", "first");
    hold("A", "second");
    staleRelease();
    expect(cardModalHoldStore.getFor("A")?.reason).toBe("second");
  });

  it("refuse routes to the holder and reports that it did", () => {
    let spoken = 0;
    hold("A", "Compacting", () => {
      spoken += 1;
    });
    expect(refuseCardModalHold("A")).toBe(true);
    expect(spoken).toBe(1);
  });

  it("refuse on a free card says so and speaks for nobody", () => {
    expect(refuseCardModalHold("A")).toBe(false);
    expect(refuseCardModalHold(null)).toBe(false);
  });

  it("notifies subscribers on claim and release", () => {
    let notifications = 0;
    const unsubscribe = cardModalHoldStore.subscribe(() => {
      notifications += 1;
    });
    const release = hold("A", "Compacting");
    expect(notifications).toBe(1);
    release();
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it("hands out a stable snapshot between writes", () => {
    const before = cardModalHoldStore.getSnapshot();
    expect(cardModalHoldStore.getSnapshot()).toBe(before);
    hold("A", "Compacting");
    expect(cardModalHoldStore.getSnapshot()).not.toBe(before);
  });
});
