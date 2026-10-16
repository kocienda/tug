/**
 * Microtask-defer test for `TugDevLogStore.log()`.
 *
 * A burst of N synchronous appends must produce exactly ONE listener
 * notification per microtask tick — that's the load-bearing safety
 * property that keeps logging cheap and render-time-safe.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

beforeEach(() => {
  (tugDevLogStore as unknown as { _disposeForTest: () => void })._disposeForTest();
});

describe("TugDevLogStore — microtask-deferred notify", () => {
  it("adopt() appends another page's entries with their timestamps, under that page's name, and mints their ids", async () => {
    tugDevLogStore.info("here", "own entry");
    tugDevLogStore.adopt("shell", [
      { timestamp: 1_700_000_000_000, level: "warn", source: "body", message: "relayed one", data: { n: 1 } },
      { timestamp: 1_700_000_000_001, level: "info", source: "deck", message: "relayed two" },
    ]);
    await Promise.resolve();
    const entries = tugDevLogStore.getSnapshot().entries;
    expect(entries.map((e) => e.message)).toEqual(["own entry", "relayed one", "relayed two"]);
    expect(entries.map((e) => e.source)).toEqual(["here", "shell/body", "shell/deck"]);
    expect(entries[1].timestamp).toBe(1_700_000_000_000);
    expect(entries[1].level).toBe("warn");
    expect(entries[1].data).toEqual({ n: 1 });
    expect("data" in entries[2]).toBe(false);
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);
  });

  it("a synchronous burst of N appends yields exactly 1 listener call", async () => {
    let calls = 0;
    const unsub = tugDevLogStore.subscribe(() => {
      calls += 1;
    });
    try {
      for (let i = 0; i < 50; i++) {
        tugDevLogStore.info("test", `msg ${i}`);
      }
      // Pre-flush: nothing has notified yet.
      expect(calls).toBe(0);
      // Yield one microtask tick → drain runs → one notification.
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(tugDevLogStore.getSnapshot().entries.length).toBe(50);
    } finally {
      unsub();
    }
  });

  it("appends across two ticks produce two notifications", async () => {
    let calls = 0;
    const unsub = tugDevLogStore.subscribe(() => {
      calls += 1;
    });
    try {
      tugDevLogStore.warn("a", "first");
      await Promise.resolve();
      tugDevLogStore.warn("a", "second");
      await Promise.resolve();
      expect(calls).toBe(2);
      expect(tugDevLogStore.getSnapshot().entries.length).toBe(2);
    } finally {
      unsub();
    }
  });

  it("log() called during a subscriber callback does not sync-reenter the store", async () => {
    let observedDuringCallback = -1;
    const unsub = tugDevLogStore.subscribe(() => {
      // Re-entering log() here would deadlock if the store flushed
      // synchronously; the microtask defer protects us.
      observedDuringCallback = tugDevLogStore.getSnapshot().entries.length;
      tugDevLogStore.debug("reentrant", "ping");
    });
    try {
      tugDevLogStore.info("test", "boot");
      await Promise.resolve();
      // The first notification observed exactly 1 entry; the
      // re-entrant log() got enqueued for the NEXT microtask, not
      // appended synchronously.
      expect(observedDuringCallback).toBe(1);
      await Promise.resolve();
      // After the next tick, the re-entrant log lands.
      expect(tugDevLogStore.getSnapshot().entries.length).toBe(2);
    } finally {
      unsub();
    }
  });
});
