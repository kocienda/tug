/**
 * session-tag-store.test.ts — set/get/clear + no-op-when-unchanged coverage for
 * the per-session tag cache (a faithful clone of the name store's contract).
 */

import { describe, expect, test } from "bun:test";
import { sessionTagStore } from "../session-tag-store";

describe("sessionTagStore", () => {
  test("get is null before any set; set then get round-trips (trimmed)", () => {
    expect(sessionTagStore.getTag("s-get")).toBe(null);
    sessionTagStore.setTag("s-get", "  azure-heron  ");
    expect(sessionTagStore.getTag("s-get")).toBe("azure-heron");
  });

  test("a blank tag clears the entry", () => {
    sessionTagStore.setTag("s-clear", "coral-otter");
    expect(sessionTagStore.getTag("s-clear")).toBe("coral-otter");
    sessionTagStore.setTag("s-clear", "   ");
    expect(sessionTagStore.getTag("s-clear")).toBe(null);
  });

  test("seedTag writes a real value but a blank never clobbers a good tag", () => {
    sessionTagStore.setTag("s-seed", "stout-finch");
    // A row read before the tag landed pushes null — must NOT wipe the tag.
    sessionTagStore.seedTag("s-seed", null);
    sessionTagStore.seedTag("s-seed", "   ");
    expect(sessionTagStore.getTag("s-seed")).toBe("stout-finch");
    // A different real value still overwrites (server suffixed a collision).
    sessionTagStore.seedTag("s-seed", "stout-finch-2");
    expect(sessionTagStore.getTag("s-seed")).toBe("stout-finch-2");
    // seedTag also populates a previously-empty entry.
    expect(sessionTagStore.getTag("s-seed-fresh")).toBe(null);
    sessionTagStore.seedTag("s-seed-fresh", "azure-heron");
    expect(sessionTagStore.getTag("s-seed-fresh")).toBe("azure-heron");
  });

  test("an unchanged set does not notify subscribers", () => {
    let notifications = 0;
    const unsubscribe = sessionTagStore.subscribe(() => {
      notifications++;
    });
    sessionTagStore.setTag("s-noop", "azure-heron"); // change → 1 notify
    sessionTagStore.setTag("s-noop", "azure-heron"); // unchanged → no notify
    expect(notifications).toBe(1);
    unsubscribe();
  });
});

describe("lineWearing — the callsign is addressable ([P12])", () => {
  test("a known callsign resolves to its line, exactly", () => {
    sessionTagStore.setTag("r-1", "stocky-pixie");
    expect(sessionTagStore.lineWearing("stocky-pixie")).toBe("r-1");
    // Surrounding whitespace is the composer's, not the user's.
    expect(sessionTagStore.lineWearing("  stocky-pixie  ")).toBe("r-1");
  });

  test("a near miss is a miss — a callsign is a name, not a query", () => {
    sessionTagStore.setTag("r-2", "syrupy-beam");
    expect(sessionTagStore.lineWearing("syrupy-bea")).toBeNull();
    expect(sessionTagStore.lineWearing("syrupy")).toBeNull();
    expect(sessionTagStore.lineWearing("beam")).toBeNull();
    expect(sessionTagStore.lineWearing("nobody-home")).toBeNull();
  });

  test("a lineage callsign matches as itself and never as its root", () => {
    sessionTagStore.setTag("r-root", "petit-thaw");
    sessionTagStore.setTag("r-fork", "petit-thaw-A1");
    expect(sessionTagStore.lineWearing("petit-thaw-A1")).toBe("r-fork");
    expect(sessionTagStore.lineWearing("petit-thaw")).toBe("r-root");
  });

  test("a rerolled callsign stops resolving — the reason the index is maintained", () => {
    // The ledger rerolls a collided mint, so the callsign shown "from the drop"
    // legitimately changes once. The old one names nothing after that, and
    // resolving it would resume a session by a name it no longer wears.
    sessionTagStore.setTag("r-3", "optimistic-tag");
    expect(sessionTagStore.lineWearing("optimistic-tag")).toBe("r-3");
    sessionTagStore.setTag("r-3", "rerolled-tag");
    expect(sessionTagStore.lineWearing("optimistic-tag")).toBeNull();
    expect(sessionTagStore.lineWearing("rerolled-tag")).toBe("r-3");
  });

  test("clearing a session's tag withdraws it from the index too", () => {
    sessionTagStore.setTag("r-4", "gone-soon");
    sessionTagStore.setTag("r-4", null);
    expect(sessionTagStore.lineWearing("gone-soon")).toBeNull();
  });

  test("a reroll never deletes another session's mapping", () => {
    // The collision scenario the reroll exists for: session B legitimately
    // wears the tag session A optimistically minted. When A's reroll lands,
    // withdrawing A's spent callsign must not knock out B's entry — B's own
    // later re-seed would short-circuit on "unchanged" and never repair it.
    sessionTagStore.setTag("r-owner", "contested-tag");
    sessionTagStore.setTag("r-optimist", "contested-tag"); // steals the index
    expect(sessionTagStore.lineWearing("contested-tag")).toBe("r-optimist");
    // The ledger re-seeds the rightful owner, then rerolls the optimist.
    sessionTagStore.setTag("r-owner", "contested-tag");
    expect(sessionTagStore.lineWearing("contested-tag")).toBe("r-owner");
    sessionTagStore.setTag("r-optimist", "fresh-reroll");
    expect(sessionTagStore.lineWearing("contested-tag")).toBe("r-owner");
    expect(sessionTagStore.lineWearing("fresh-reroll")).toBe("r-optimist");
    // Clearing the optimist outright is likewise ownership-checked.
    sessionTagStore.setTag("r-optimist-2", "shared-tag");
    sessionTagStore.setTag("r-owner-2", "shared-tag");
    sessionTagStore.setTag("r-optimist-2", null);
    expect(sessionTagStore.lineWearing("shared-tag")).toBe("r-owner-2");
  });
});
