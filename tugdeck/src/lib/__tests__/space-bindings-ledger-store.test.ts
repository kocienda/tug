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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { spaceBindingsLedgerStore } from "../space-bindings-ledger-store";
import {
  publishListCardBindingsErr,
  publishListCardBindingsOk,
  publishSessionUpdated,
} from "../session-ledger-events";
import type { CardBinding, SessionRow } from "../../protocol";

function row(over: Partial<CardBinding> & { card_id: string }): CardBinding {
  return {
    session_id: `sess-${over.card_id}`,
    project_dir: "/work/project",
    state: "closed",
    turn_count: 0,
    ...over,
  };
}

/** A `session_updated` push for `sessionId`, as the supervisor sends one. */
function push(
  sessionId: string,
  fields: Partial<SessionRow> & { card_id: string | null },
): void {
  publishSessionUpdated({
    session_id: sessionId,
    fields: { session_id: sessionId, state: "live", background: false, ...fields } as SessionRow,
  });
}

// Before as well as after: the store is a module singleton, and a file that
// installed it through `installRegistrySubscriptions` without resetting it
// leaves the install guard set. Once another file resets the event bus that
// subscription is gone, and this file's first `installOnce()` would no-op
// against a guard that no longer guards anything.
beforeEach(() => {
  spaceBindingsLedgerStore._resetForTest();
});

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

  test("is loaded only once a frame has landed, an empty one included", () => {
    spaceBindingsLedgerStore.installOnce();
    expect(spaceBindingsLedgerStore.loaded()).toBe(false);
    publishListCardBindingsOk({ bindings: [] });
    expect(spaceBindingsLedgerStore.loaded()).toBe(true);
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

// The cache is filled at boot and a session rotates mid-run: every arc stage
// is a new segment. Left alone it named a segment four rotations back, and a
// workspace the user had not opened would have resumed that one.
describe("refreshOnPushes", () => {
  let asks = 0;
  let release: (() => void) | null = null;

  beforeEach(() => {
    asks = 0;
    spaceBindingsLedgerStore.installOnce();
    release = spaceBindingsLedgerStore.refreshOnPushes(() => {
      asks += 1;
    });
    publishListCardBindingsOk({ bindings: [row({ card_id: "A", session_id: "seat-1" })] });
  });

  afterEach(() => {
    release?.();
    release = null;
  });

  test("a live segment the cache does not seat its card on asks again", () => {
    push("seat-2", { card_id: "A" });
    expect(asks).toBe(1);
  });

  test("a card the cache has no row for asks again", () => {
    push("fresh", { card_id: "B" });
    expect(asks).toBe(1);
  });

  test("the removal of a segment the cache seats asks again", () => {
    publishSessionUpdated({ session_id: "seat-1", removed: true });
    expect(asks).toBe(1);
  });

  test("a push the cache already agrees with asks nothing", () => {
    // Every turn pushes the seated segment's row; none of them is news.
    push("seat-1", { card_id: "A" });
    // A retired segment closing, a background owner, a cardless row.
    push("seat-0", { card_id: "A", state: "closed" });
    push("bg", { card_id: "spawner", background: true });
    push("loose", { card_id: null });
    publishSessionUpdated({ session_id: "not-cached", removed: true });
    expect(asks).toBe(0);
  });

  test("a burst while a request is out costs one more request, not one per push", () => {
    push("seat-2", { card_id: "A" });
    push("seat-3", { card_id: "A" });
    push("seat-4", { card_id: "A" });
    expect(asks).toBe(1);
    publishListCardBindingsOk({ bindings: [row({ card_id: "A", session_id: "seat-2" })] });
    expect(asks).toBe(2);
    publishListCardBindingsOk({ bindings: [row({ card_id: "A", session_id: "seat-4" })] });
    expect(asks).toBe(2);
    expect(spaceBindingsLedgerStore.get("A")?.session_id).toBe("seat-4");
  });

  test("an error answer frees the next push to ask", () => {
    push("seat-2", { card_id: "A" });
    publishListCardBindingsErr({ reason: "ledger_read_failed" });
    push("seat-3", { card_id: "A" });
    expect(asks).toBe(2);
  });
});
