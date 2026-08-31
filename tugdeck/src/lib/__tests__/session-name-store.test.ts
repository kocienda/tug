/**
 * session-name-store.test.ts — set/get/clear + non-clobbering `seedName`
 * coverage for the per-session name cache backing the Z4B chip.
 */

import { describe, expect, test } from "bun:test";
import { sessionNameStore, type NameSettle } from "../session-name-store";

describe("sessionNameStore", () => {
  test("get is null before any set; set then get round-trips (trimmed)", () => {
    expect(sessionNameStore.getName("n-get")).toBe(null);
    sessionNameStore.setName("n-get", "  commit-inline-dialog  ");
    expect(sessionNameStore.getName("n-get")).toBe("commit-inline-dialog");
  });

  test("setName with a blank clears the entry (authoritative path)", () => {
    sessionNameStore.setName("n-clear", "some-name");
    expect(sessionNameStore.getName("n-clear")).toBe("some-name");
    sessionNameStore.setName("n-clear", "   ");
    expect(sessionNameStore.getName("n-clear")).toBe(null);
  });

  test("seedName writes a real value but a blank never clobbers a good name", () => {
    sessionNameStore.setName("n-seed", "commit-inline-dialog");
    // A seed carrying no name (unnamed row, or read before the name landed)
    // must NOT wipe the good name back to the id-hash.
    sessionNameStore.seedName("n-seed", null);
    sessionNameStore.seedName("n-seed", "   ");
    expect(sessionNameStore.getName("n-seed")).toBe("commit-inline-dialog");
    // seedName populates a previously-empty entry.
    expect(sessionNameStore.getName("n-seed-fresh")).toBe(null);
    sessionNameStore.seedName("n-seed-fresh", "roadmap-sketch");
    expect(sessionNameStore.getName("n-seed-fresh")).toBe("roadmap-sketch");
  });

  test("an unchanged set does not notify subscribers", () => {
    let notifications = 0;
    const unsubscribe = sessionNameStore.subscribe(() => {
      notifications++;
    });
    sessionNameStore.setName("n-noop", "a-name"); // change → 1 notify
    sessionNameStore.setName("n-noop", "a-name"); // unchanged → no notify
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("a refused rename restores the name", () => {
    const settles: NameSettle[] = [];
    sessionNameStore.setName("n-took", "old");
    sessionNameStore.awaitSettle("n-took", "harbor light", "old", (s) =>
      settles.push(s),
    );
    sessionNameStore.settle("n-took", "harbor light", {
      ok: false,
      reason: "ledger_write_failed",
    });
    expect(sessionNameStore.getName("n-took")).toBe("old");
    expect(settles[0]?.reason).toBe("ledger_write_failed");
  });

  test("a rename that took nobody's name hands the waiter no displacement", () => {
    const settles: NameSettle[] = [];
    sessionNameStore.awaitSettle("n-alone", "unspoken for", null, (s) =>
      settles.push(s),
    );
    sessionNameStore.settle("n-alone", "unspoken for", { ok: true });
    expect(settles[0]?.displaced).toBeUndefined();
  });

  test("a rename that took a name hands the waiter who lost it", () => {
    const settles: NameSettle[] = [];
    sessionNameStore.awaitSettle("n-taker", "harbor light", null, (s) =>
      settles.push(s),
    );
    // The newest gesture wins ([P11]), so the settle carries the lines the
    // name was taken from — the bulletin says so rather than letting a name
    // vanish off another card unannounced.
    sessionNameStore.settle("n-taker", "harbor light", {
      ok: true,
      displaced: [{ lineId: "n-held", tag: "stocky-pixie" }],
    });
    expect(settles[0]?.displaced).toEqual([
      { lineId: "n-held", tag: "stocky-pixie" },
    ]);
  });
});
