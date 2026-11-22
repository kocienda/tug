/**
 * `followServerTurn` hands the card's `deck.cards` `turnLatch` to its
 * session store: now, on every move of the reading, and to a new store when
 * the card's store changes — never the same reading twice to the same store.
 */

import { describe, it, expect } from "bun:test";

import { followServerTurn, type ServerTurnSink, type ServerTurnSources } from "../body-turn-latch";
import type { ServerTurnLatch } from "../../lib/code-session-store/events";

type Latch = ServerTurnLatch | null;

function sources(): {
  src: ServerTurnSources;
  setLatch(latch: Latch): void;
  setStore(store: ServerTurnSink | null): void;
  listeners(): number;
} {
  let latch: Latch = null;
  let store: ServerTurnSink | null = null;
  const cardListeners = new Set<() => void>();
  const serviceListeners = new Set<() => void>();
  return {
    src: {
      cards: {
        subscribe: (l) => {
          cardListeners.add(l);
          return () => cardListeners.delete(l);
        },
        getSnapshot: () => ({ c1: { turnLatch: latch } }),
      },
      services: {
        subscribe: (l) => {
          serviceListeners.add(l);
          return () => serviceListeners.delete(l);
        },
        storeFor: (id) => (id === "c1" ? store : null),
      },
    },
    setLatch(next) {
      latch = next;
      for (const l of cardListeners) l();
    },
    setStore(next) {
      store = next;
      for (const l of serviceListeners) l();
    },
    listeners: () => cardListeners.size + serviceListeners.size,
  };
}

function sink(): ServerTurnSink & { calls: Array<[Latch, string]> } {
  const calls: Array<[Latch, string]> = [];
  return { calls, noteServerTurn: (latch, cardId) => calls.push([latch, cardId]) };
}

describe("followServerTurn", () => {
  it("tells the store the reading now and on each move, and skips a repeat", () => {
    const s = sources();
    const store = sink();
    s.setStore(store);
    s.setLatch({ active: true, turnId: "t1" });
    const release = followServerTurn("c1", s.src);
    expect(store.calls).toEqual([[{ active: true, turnId: "t1" }, "c1"]]);
    s.setLatch({ active: true, turnId: "t1" });
    expect(store.calls).toHaveLength(1);
    s.setLatch({ active: false, turnId: "t1" });
    s.setLatch(null);
    expect(store.calls).toEqual([
      [{ active: true, turnId: "t1" }, "c1"],
      [{ active: false, turnId: "t1" }, "c1"],
      [null, "c1"],
    ]);
    release();
  });

  it("waits for a store, and tells a new store the reading it missed", () => {
    const s = sources();
    s.setLatch({ active: false, turnId: "t1" });
    const release = followServerTurn("c1", s.src);
    const first = sink();
    s.setStore(first);
    expect(first.calls).toEqual([[{ active: false, turnId: "t1" }, "c1"]]);
    const second = sink();
    s.setStore(second);
    expect(second.calls).toEqual([[{ active: false, turnId: "t1" }, "c1"]]);
    expect(first.calls).toHaveLength(1);
    release();
  });

  it("releases both subscriptions", () => {
    const s = sources();
    const release = followServerTurn("c1", s.src);
    expect(s.listeners()).toBe(2);
    release();
    expect(s.listeners()).toBe(0);
  });
});
