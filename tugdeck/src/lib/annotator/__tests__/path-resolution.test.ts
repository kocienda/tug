/**
 * Pure-logic coverage for path resolution.
 *
 * The network round trip is not simulated here — a mocked fetch would
 * only prove the mock was called. The real endpoint is driven by the
 * app-test that clicks a real path in a real transcript. What this file
 * pins is everything the store decides on its own: how a candidate
 * resolves to something askable, how wants are batched, and — driving the
 * real store with real response shapes — how verdicts settle, when the
 * version moves, and what happens when an answer never comes.
 */

import { describe, expect, test } from "bun:test";

import {
  PathResolutionStore,
  RETRY_AFTER_MS,
  chunkPaths,
  joinPath,
  resolveCandidate,
  type ProbeResult,
} from "../path-resolution";

describe("joinPath", () => {
  test("joins a relative path onto a cwd", () => {
    expect(joinPath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
  });

  test("tolerates a trailing slash on the cwd", () => {
    expect(joinPath("/repo/", "src/a.ts")).toBe("/repo/src/a.ts");
  });

  test("normalizes . and .. away", () => {
    expect(joinPath("/repo", "./src/../lib/a.ts")).toBe("/repo/lib/a.ts");
    expect(joinPath("/repo/src", "../lib/a.ts")).toBe("/repo/lib/a.ts");
  });

  test("collapses repeated separators", () => {
    expect(joinPath("/repo", "src//a.ts")).toBe("/repo/src/a.ts");
  });
});

describe("resolveCandidate", () => {
  test("an absolute candidate needs no cwd", () => {
    expect(resolveCandidate("/repo/a.ts", null)).toBe("/repo/a.ts");
  });

  test("an absolute candidate is normalized so spellings share a cache entry", () => {
    expect(resolveCandidate("/repo/./src/../a.ts", null)).toBe("/repo/a.ts");
  });

  test("a relative candidate resolves against the cwd", () => {
    expect(resolveCandidate("src/a.ts", "/repo")).toBe("/repo/src/a.ts");
  });

  test("a relative candidate with no cwd is unresolvable, not guessed", () => {
    expect(resolveCandidate("src/a.ts", null)).toBeNull();
  });
});

describe("chunkPaths", () => {
  test("a batch under the cap stays whole", () => {
    expect(chunkPaths(["a", "b"], 64)).toEqual([["a", "b"]]);
  });

  test("splits at the endpoint's cap", () => {
    const paths = Array.from({ length: 70 }, (_, i) => `/p/${i}`);
    const chunks = chunkPaths(paths);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(64);
    expect(chunks[1].length).toBe(6);
    expect(chunks.flat()).toEqual(paths);
  });

  test("an empty batch produces no chunks", () => {
    expect(chunkPaths([])).toEqual([]);
  });
});

describe("verdicts settle on the real store", () => {
  test("an unseen path is pending — queued, awaited, not yet answered", () => {
    const store = new PathResolutionStore();
    expect(store.lookup("/repo/a.ts", null)).toEqual({ state: "pending" });
  });

  test("a confirmed path carries the canonical form the endpoint returned", () => {
    const store = new PathResolutionStore();
    store.lookup("/repo/a.ts", null);
    store.applyProbeResult(["/repo/a.ts"], {
      exists: { "/repo/a.ts": true },
      canonical: { "/repo/a.ts": "/private/repo/a.ts" },
      isDir: {},
    });
    expect(store.lookup("/repo/a.ts", null)).toEqual({
      state: "confirmed",
      canonical: "/private/repo/a.ts",
        isDir: false,
    });
  });

  test("a confirmed path with no canonical form falls back to itself", () => {
    const store = new PathResolutionStore();
    store.applyProbeResult(["/repo/a.ts"], {
      exists: { "/repo/a.ts": true },
      canonical: {},
      isDir: {},
    });
    expect(store.lookup("/repo/a.ts", null)).toEqual({
      state: "confirmed",
      canonical: "/repo/a.ts",
        isDir: false,
    });
  });

  test("a missing path stays missing — the answer is cached, not re-derived", () => {
    const store = new PathResolutionStore();
    store.applyProbeResult(["/repo/gone.ts"], {
      exists: { "/repo/gone.ts": false },
      canonical: {},
      isDir: {},
    });
    expect(store.lookup("/repo/gone.ts", null)).toEqual({ state: "missing" });
  });

  test("a lost answer returns the path to unknown, never to a false verdict", () => {
    const store = new PathResolutionStore();
    store.applyProbeResult(["/repo/a.ts"], null);
    expect(store.lookup("/repo/a.ts", null)).toEqual({ state: "unknown" });
  });

  test("a path the response omits is also unknown, not missing", () => {
    const store = new PathResolutionStore();
    store.applyProbeResult(["/repo/a.ts", "/repo/b.ts"], {
      exists: { "/repo/a.ts": true },
      canonical: {},
      isDir: {},
    });
    expect(store.lookup("/repo/b.ts", null)).toEqual({ state: "unknown" });
  });

  test("a relative candidate with no cwd is never cached, so the cwd's arrival can answer it", () => {
    const store = new PathResolutionStore();
    expect(store.lookup("src/a.ts", null)).toEqual({ state: "unknown" });
    store.applyProbeResult(["/repo/src/a.ts"], {
      exists: { "/repo/src/a.ts": true },
      canonical: {},
      isDir: {},
    });
    expect(store.lookup("src/a.ts", "/repo")).toEqual({
      state: "confirmed",
      canonical: "/repo/src/a.ts",
        isDir: false,
    });
  });
});

describe("the version moves exactly when the ink would need re-marking", () => {
  test("a verdict arrival bumps it", () => {
    const store = new PathResolutionStore();
    const before = store.version();
    store.applyProbeResult(["/repo/a.ts"], {
      exists: { "/repo/a.ts": true },
      canonical: {},
      isDir: {},
    });
    expect(store.version()).toBeGreaterThan(before);
  });

  test("the same verdict again does not", () => {
    const store = new PathResolutionStore();
    const result = { exists: { "/repo/a.ts": true }, canonical: {}, isDir: {} };
    store.applyProbeResult(["/repo/a.ts"], result);
    const after = store.version();
    store.applyProbeResult(["/repo/a.ts"], result);
    expect(store.version()).toBe(after);
  });

  test("a lost answer for a path we never knew does not", () => {
    const store = new PathResolutionStore();
    const before = store.version();
    store.applyProbeResult(["/repo/a.ts"], null);
    expect(store.version()).toBe(before);
  });

  test("subscribers hear about arrivals until they unsubscribe", () => {
    const store = new PathResolutionStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.applyProbeResult(["/repo/a.ts"], {
      exists: { "/repo/a.ts": true },
      canonical: {},
      isDir: {},
    });
    expect(notifications).toBe(1);
    unsubscribe();
    store.applyProbeResult(["/repo/b.ts"], {
      exists: { "/repo/b.ts": true },
      canonical: {},
      isDir: {},
    });
    expect(notifications).toBe(1);
  });
});

/**
 * A verdict cached for the app's life is a reference that can never come
 * back, and a Overview post routinely names a file minutes before it exists.
 * The clock and the probe are injected — the clock so a minute can pass
 * without waiting one, the probe so the test can read WHICH paths the store
 * chose to ask about, which is the decision the expiry rule makes. That is
 * not a mocked round trip standing in for the endpoint: the endpoint's own
 * answers are still the real shapes, and the app-test still clicks a real
 * path in a real transcript.
 */
describe("a 'no' expires and is asked again; a 'yes' never is", () => {
  function harness() {
    let clock = 1_000_000;
    const asked: string[][] = [];
    let answer: ProbeResult | null = null;
    const store = new PathResolutionStore(
      () => clock,
      async (paths) => {
        asked.push([...paths]);
        return answer;
      },
    );
    return {
      store,
      asked,
      advance: (ms: number) => {
        clock += ms;
      },
      answerWith: (next: ProbeResult | null) => {
        answer = next;
      },
      // The store batches on a 16ms debounce and answers on a microtask.
      settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
    };
  }

  const gone: ProbeResult = {
    exists: { "/repo/plan.md": false },
    canonical: {},
    isDir: {},
  };
  const there: ProbeResult = {
    exists: { "/repo/plan.md": true },
    canonical: { "/repo/plan.md": "/repo/plan.md" },
    isDir: {},
  };

  test("a file written after the post that named it becomes a link", async () => {
    const h = harness();
    h.answerWith(gone);
    expect(h.store.lookup("/repo/plan.md", null)).toEqual({ state: "pending" });
    await h.settle();
    expect(h.store.lookup("/repo/plan.md", null)).toEqual({ state: "missing" });
    expect(h.asked.length).toBe(1);

    // Within the window the cached "no" answers every pass on its own.
    h.advance(RETRY_AFTER_MS - 1);
    h.store.lookup("/repo/plan.md", null);
    await h.settle();
    expect(h.asked.length).toBe(1);

    // Past it, the path is asked again — and the reader sees the OLD answer
    // while that question is in flight, never a flicker back to pending.
    h.advance(2);
    h.answerWith(there);
    expect(h.store.lookup("/repo/plan.md", null)).toEqual({ state: "missing" });
    await h.settle();
    expect(h.asked.length).toBe(2);
    expect(h.store.lookup("/repo/plan.md", null)).toEqual({
      state: "confirmed",
      canonical: "/repo/plan.md",
      isDir: false,
    });
  });

  test("a re-ask that is still 'no' re-marks nothing", async () => {
    const h = harness();
    h.answerWith(gone);
    h.store.lookup("/repo/plan.md", null);
    await h.settle();
    const settledVersion = h.store.version();

    h.advance(RETRY_AFTER_MS);
    h.store.lookup("/repo/plan.md", null);
    await h.settle();
    expect(h.asked.length).toBe(2);
    expect(h.store.version()).toBe(settledVersion);
  });

  test("a lost answer is asked again too — a server that was down comes back", async () => {
    const h = harness();
    h.answerWith(null);
    h.store.lookup("/repo/plan.md", null);
    await h.settle();
    expect(h.store.lookup("/repo/plan.md", null)).toEqual({ state: "unknown" });

    h.advance(RETRY_AFTER_MS);
    h.answerWith(there);
    h.store.lookup("/repo/plan.md", null);
    await h.settle();
    expect(h.store.lookup("/repo/plan.md", null)).toEqual({
      state: "confirmed",
      canonical: "/repo/plan.md",
      isDir: false,
    });
  });

  test("a confirmed path is never re-asked — expiry can only ever add a link", async () => {
    const h = harness();
    h.answerWith(there);
    h.store.lookup("/repo/plan.md", null);
    await h.settle();
    expect(h.asked.length).toBe(1);

    h.advance(RETRY_AFTER_MS * 10);
    h.store.lookup("/repo/plan.md", null);
    await h.settle();
    expect(h.asked.length).toBe(1);
  });
});
