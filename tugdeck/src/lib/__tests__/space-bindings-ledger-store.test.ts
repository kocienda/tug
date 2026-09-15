/**
 * `spaceBindingsLedgerStore` — the cache a workspace switch restores from.
 *
 * Three rules, each with a failure mode the switch would show if it were
 * wrong: the newest row per card wins (or a switch resumes a session the user
 * has since moved on from), a frame replaces the whole map (or a row the
 * ledger has dropped keeps answering forever), and an unknown card answers
 * `undefined` rather than guessing (which is what routes it to the round trip
 * instead of to a picker).
 */

import { describe, test, expect, afterEach } from "bun:test";

import { spaceBindingsLedgerStore } from "../space-bindings-ledger-store";
import { publishListCardBindingsOk } from "../session-ledger-events";
import type { CardBinding } from "../../protocol";

function row(over: Partial<CardBinding> & { card_id: string }): CardBinding {
  return {
    session_id: `sess-${over.card_id}`,
    project_dir: "/work/project",
    state: "closed",
    turn_count: 0,
    ...over,
  };
}

afterEach(() => {
  spaceBindingsLedgerStore._resetForTest();
});

describe("spaceBindingsLedgerStore", () => {
  test("holds the newest row per card — the wire orders newest first", () => {
    spaceBindingsLedgerStore.installOnce();
    publishListCardBindingsOk({
      bindings: [
        row({ card_id: "A", session_id: "newest", turn_count: 4 }),
        row({ card_id: "A", session_id: "older", turn_count: 1 }),
        row({ card_id: "B", session_id: "sess-B" }),
      ],
    });
    // The same rule `restoreSessions` reads a wire frame by: first row per
    // card id wins. Two answers to "which session does this card resume?"
    // would eventually disagree, and disagreeing is a crash-looping card.
    expect(spaceBindingsLedgerStore.get("A")?.session_id).toBe("newest");
    expect(spaceBindingsLedgerStore.get("B")?.session_id).toBe("sess-B");
  });

  test("a second frame replaces the map rather than merging into it", () => {
    spaceBindingsLedgerStore.installOnce();
    publishListCardBindingsOk({ bindings: [row({ card_id: "A" })] });
    expect(spaceBindingsLedgerStore.get("A")).toBeDefined();

    // The server's answer is authoritative: a card the ledger no longer knows
    // must stop answering, and a merge would keep it answering forever.
    publishListCardBindingsOk({ bindings: [row({ card_id: "C" })] });
    expect(spaceBindingsLedgerStore.get("A")).toBeUndefined();
    expect(spaceBindingsLedgerStore.get("C")).toBeDefined();
  });

  test("an unknown card is undefined, not a guess", () => {
    spaceBindingsLedgerStore.installOnce();
    publishListCardBindingsOk({ bindings: [row({ card_id: "A" })] });
    expect(spaceBindingsLedgerStore.get("nobody")).toBeUndefined();
  });

  test("a malformed row is dropped rather than cached", () => {
    spaceBindingsLedgerStore.installOnce();
    publishListCardBindingsOk({
      bindings: [
        { card_id: "", session_id: "s", project_dir: "/p", turn_count: 0 },
        { card_id: "D" } as unknown as CardBinding,
        row({ card_id: "E" }),
      ] as unknown as CardBinding[],
    });
    expect(spaceBindingsLedgerStore.getSnapshot().size).toBe(1);
    expect(spaceBindingsLedgerStore.get("E")).toBeDefined();
  });

  test("subscribers are told when a frame lands", () => {
    spaceBindingsLedgerStore.installOnce();
    let calls = 0;
    const unsubscribe = spaceBindingsLedgerStore.subscribe(() => {
      calls += 1;
    });
    publishListCardBindingsOk({ bindings: [row({ card_id: "A" })] });
    expect(calls).toBe(1);
    unsubscribe();
    publishListCardBindingsOk({ bindings: [row({ card_id: "A" })] });
    expect(calls).toBe(1);
  });

  test("installOnce subscribes exactly once", () => {
    spaceBindingsLedgerStore.installOnce();
    spaceBindingsLedgerStore.installOnce();
    let calls = 0;
    const unsubscribe = spaceBindingsLedgerStore.subscribe(() => {
      calls += 1;
    });
    // A second subscription would fold the frame twice and notify twice —
    // harmless for the map, but it would double every reader's work for the
    // life of the app.
    publishListCardBindingsOk({ bindings: [row({ card_id: "A" })] });
    expect(calls).toBe(1);
    unsubscribe();
  });
});
