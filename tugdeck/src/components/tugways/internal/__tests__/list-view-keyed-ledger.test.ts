/**
 * The keyed height ledger: `HeightIndex`'s tiers, keyed by row key, so a
 * column that trims its front keeps its heights through the trim.
 */

import { describe, expect, it } from "bun:test";

import { KeyedHeightLedger } from "../list-view-keyed-ledger";

describe("KeyedHeightLedger", () => {
  it("keeps every extent through markAllStale, and flags each stale", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("a", 58);
    ledger.set("b", 78);
    ledger.markAllStale();
    expect(ledger.get("a")).toBe(58);
    expect(ledger.get("b")).toBe(78);
    expect(ledger.has("a")).toBe(true);
    expect(ledger.isFresh("a")).toBe(false);
    expect(ledger.isFresh("b")).toBe(false);
  });

  it("freshens the key a set measures, and only that one", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("a", 58);
    ledger.set("b", 78);
    ledger.markAllStale();
    ledger.set("a", 60);
    expect(ledger.get("a")).toBe(60);
    expect(ledger.isFresh("a")).toBe(true);
    expect(ledger.isFresh("b")).toBe(false);
  });

  it("counts the pending keys: missing or stale", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("a", 58);
    ledger.set("b", 78);
    ledger.markAllStale();
    ledger.set("a", 58);
    expect(ledger.pendingCount(["a", "b", "c"])).toBe(2);
  });

  it("marks one key stale by markStale, and ignores a key it has no extent for", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("a", 58);
    ledger.set("b", 78);
    ledger.markStale("a");
    ledger.markStale("z");
    expect(ledger.isFresh("a")).toBe(false);
    expect(ledger.isFresh("b")).toBe(true);
    expect(ledger.has("z")).toBe(false);
    expect(ledger.pendingCount(["a", "b"])).toBe(1);
  });

  it("drops the keys prune is not given, with their stale flags", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("a", 58);
    ledger.set("b", 78);
    ledger.set("c", 98);
    ledger.markAllStale();
    ledger.prune(["b"]);
    expect(ledger.has("a")).toBe(false);
    expect(ledger.has("c")).toBe(false);
    expect(ledger.get("b")).toBe(78);
    expect(ledger.size).toBe(1);
    // A key set again after a prune comes back fresh, not stale.
    ledger.set("a", 10);
    expect(ledger.isFresh("a")).toBe(true);
  });

  it("answers has and isFresh by index through viewFor", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("b", 78);
    ledger.set("c", 98);
    ledger.markAllStale();
    ledger.set("c", 98);
    const view = ledger.viewFor(["a", "b", "c"]);
    expect(view.has(0)).toBe(false);
    expect(view.has(1)).toBe(true);
    expect(view.isFresh(1)).toBe(false);
    expect(view.isFresh(2)).toBe(true);
    expect(view.has(3)).toBe(false);
    expect(view.isFresh(-1)).toBe(false);
  });

  it("takes the middle extent of an odd count as the median", () => {
    const ledger = new KeyedHeightLedger();
    expect(ledger.median()).toBeNull();
    ledger.set("a", 90);
    ledger.set("b", 10);
    ledger.set("c", 40);
    expect(ledger.median()).toBe(40);
  });

  it("takes the mean of the middle two of an even count as the median", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("a", 90);
    ledger.set("b", 10);
    ledger.set("c", 40);
    ledger.set("d", 60);
    expect(ledger.median()).toBe(50);
  });

  it("rebases every extent by adjustAll, keeping freshness", () => {
    const ledger = new KeyedHeightLedger();
    ledger.set("a", 58);
    ledger.set("b", 78);
    ledger.markAllStale();
    ledger.set("a", 58);
    ledger.adjustAll(4);
    expect(ledger.get("a")).toBe(62);
    expect(ledger.get("b")).toBe(82);
    expect(ledger.isFresh("a")).toBe(true);
    expect(ledger.isFresh("b")).toBe(false);
  });
});
