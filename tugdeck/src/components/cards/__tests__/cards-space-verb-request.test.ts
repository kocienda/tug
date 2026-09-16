/**
 * cards-space-verb-request.test.ts — the one-slot store that carries a
 * menu-originated workspace verb to the Workspaces card ([P08]).
 *
 * Pure logic over a module singleton: no React, no DOM. What is worth pinning
 * is the part a plain `{ verb, spaceId }` slot would get wrong — a second
 * request naming the SAME workspace has to wake a subscriber, and it only can
 * if the snapshot changes identity, which is the whole reason `token` exists.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { cardsSpaceVerbRequest } from "../cards-space-verb-request";

beforeEach(() => {
  cardsSpaceVerbRequest._resetForTest();
});

describe("cardsSpaceVerbRequest", () => {
  test("a request wakes every subscriber and is readable from the snapshot", () => {
    let woke = 0;
    const stop = cardsSpaceVerbRequest.subscribe(() => {
      woke += 1;
    });
    try {
      expect(cardsSpaceVerbRequest.getSnapshot()).toBeNull();
      cardsSpaceVerbRequest.request("rename", "s1");
      expect(woke).toBe(1);
      const slot = cardsSpaceVerbRequest.getSnapshot();
      expect(slot?.verb).toBe("rename");
      expect(slot?.spaceId).toBe("s1");
    } finally {
      stop();
    }
  });

  test("a second request for the SAME workspace is a distinct snapshot", () => {
    // The defect this guards: without `token` the two objects would compare
    // equal under `useSyncExternalStore`'s identity check on a memoized
    // snapshot, and a person pressing Rename twice would get one field.
    let woke = 0;
    const stop = cardsSpaceVerbRequest.subscribe(() => {
      woke += 1;
    });
    try {
      cardsSpaceVerbRequest.request("rename", "s1");
      const first = cardsSpaceVerbRequest.getSnapshot();
      cardsSpaceVerbRequest.request("rename", "s1");
      const second = cardsSpaceVerbRequest.getSnapshot();
      expect(woke).toBe(2);
      expect(second).not.toBe(first);
      expect(second?.token).not.toBe(first?.token);
      expect(second?.verb).toBe("rename");
      expect(second?.spaceId).toBe("s1");
    } finally {
      stop();
    }
  });

  test("a later request replaces the earlier one — the slot holds ONE", () => {
    cardsSpaceVerbRequest.request("rename", "s1");
    cardsSpaceVerbRequest.request("delete", "s2");
    const slot = cardsSpaceVerbRequest.getSnapshot();
    expect(slot?.verb).toBe("delete");
    expect(slot?.spaceId).toBe("s2");
  });

  test("clear empties the slot, and a second clear wakes nobody", () => {
    cardsSpaceVerbRequest.request("delete", "s1");
    let woke = 0;
    const stop = cardsSpaceVerbRequest.subscribe(() => {
      woke += 1;
    });
    try {
      cardsSpaceVerbRequest.clear();
      expect(cardsSpaceVerbRequest.getSnapshot()).toBeNull();
      expect(woke).toBe(1);
      // An empty slot cleared again must not notify: a snapshot that did not
      // move is not a reason to recompute.
      cardsSpaceVerbRequest.clear();
      expect(woke).toBe(1);
    } finally {
      stop();
    }
  });

  test("prune drops a request naming a workspace that is gone, and only that", () => {
    cardsSpaceVerbRequest.request("delete", "gone");
    let woke = 0;
    const stop = cardsSpaceVerbRequest.subscribe(() => {
      woke += 1;
    });
    try {
      // Still live: a no-op, snapshot identity intact.
      const before = cardsSpaceVerbRequest.getSnapshot();
      cardsSpaceVerbRequest.prune(new Set(["gone", "s2"]));
      expect(cardsSpaceVerbRequest.getSnapshot()).toBe(before);
      expect(woke).toBe(0);

      cardsSpaceVerbRequest.prune(new Set(["s2"]));
      expect(cardsSpaceVerbRequest.getSnapshot()).toBeNull();
      expect(woke).toBe(1);

      // An empty slot prunes to nothing and wakes nobody.
      cardsSpaceVerbRequest.prune(new Set<string>());
      expect(woke).toBe(1);
    } finally {
      stop();
    }
  });
});
