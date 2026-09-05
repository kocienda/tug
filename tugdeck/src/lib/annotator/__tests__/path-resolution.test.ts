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

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import {
  PathResolutionStore,
  RETRY_AFTER_MS,
  chunkPaths,
  joinPath,
  namesOrContains,
  resolveCandidate,
  type ProbeResult,
} from "../path-resolution";
import { pathVerdictKey, type VerdictKey } from "../verdict-keys";

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

/**
 * The expiry above is reached through `lookup`, and `lookup` only ever runs
 * inside an annotation pass — so the re-ask could only reach a path some pass
 * happened to walk past again. The ink that most needed it was exactly the ink
 * no pass was coming back to: a file named in prose before the tool call that
 * created it, whose container the old awaiting flag never marked.
 *
 * So the store now holds the timer itself. These drive the real timer wheel
 * with fake timers, moving it and the injected clock together, and never call
 * `lookup` across the window — which is the whole claim.
 */
describe("the store fires the due re-ask itself, with no pass to carry it", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const PATH = "/repo/plan.md";
  const gone: ProbeResult = { exists: { [PATH]: false }, canonical: {}, isDir: {} };
  const there: ProbeResult = {
    exists: { [PATH]: true },
    canonical: { [PATH]: PATH },
    isDir: {},
  };

  function harness() {
    let clock = 1_000_000;
    const asked: string[][] = [];
    const heard: VerdictKey[][] = [];
    let answer: ProbeResult | null = null;
    const store = new PathResolutionStore(
      () => clock,
      async (paths) => {
        asked.push([...paths]);
        return answer;
      },
    );
    store.subscribe((keys) => heard.push([...keys]));
    return {
      store,
      asked,
      heard,
      answerWith: (next: ProbeResult | null) => {
        answer = next;
      },
      /**
       * Move the injected clock and the timer wheel by the same span, then
       * let the probe's microtasks run — the flush is async, and advancing a
       * wheel does not drain a promise.
       */
      tick: async (ms: number) => {
        clock += ms;
        jest.advanceTimersByTime(ms);
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      },
    };
  }

  test("a missing key re-probes and notifies with no lookup in between", async () => {
    const h = harness();
    h.answerWith(gone);
    expect(h.store.lookup(PATH, null)).toEqual({ state: "pending" });
    await h.tick(20);
    expect(h.store.lookup(PATH, null)).toEqual({ state: "missing" });
    expect(h.asked.length).toBe(1);
    expect(h.heard).toEqual([[pathVerdictKey(PATH)]]);

    // The file arrives. Nothing asks about it again — no pass walks this ink,
    // and nothing below calls `lookup` until the assertions.
    h.answerWith(there);
    await h.tick(RETRY_AFTER_MS);
    await h.tick(50);

    expect(h.asked.length).toBe(2);
    expect(h.asked[1]).toEqual([PATH]);
    expect(h.heard).toEqual([
      [pathVerdictKey(PATH)],
      [pathVerdictKey(PATH)],
    ]);
    expect(h.store.lookup(PATH, null)).toEqual({
      state: "confirmed",
      canonical: PATH,
      isDir: false,
    });
    h.store.dispose();
  });

  test("a still-missing re-ask says nothing, and the watch is re-armed", async () => {
    const h = harness();
    h.answerWith(gone);
    h.store.lookup(PATH, null);
    await h.tick(20);
    expect(h.asked.length).toBe(1);
    const settled = h.heard.length;

    await h.tick(RETRY_AFTER_MS);
    await h.tick(50);
    expect(h.asked.length).toBe(2);
    expect(h.heard.length).toBe(settled);

    // The second window is armed by the first sweep, not by a lookup.
    await h.tick(RETRY_AFTER_MS);
    await h.tick(50);
    expect(h.asked.length).toBe(3);
    expect(h.heard.length).toBe(settled);
    h.store.dispose();
  });

  test("a lost answer is on the same watch — a server that was down comes back", async () => {
    const h = harness();
    h.answerWith(null);
    h.store.lookup(PATH, null);
    await h.tick(20);
    expect(h.store.lookup(PATH, null)).toEqual({ state: "unknown" });

    h.answerWith(there);
    await h.tick(RETRY_AFTER_MS);
    await h.tick(50);
    expect(h.store.lookup(PATH, null)).toEqual({
      state: "confirmed",
      canonical: PATH,
      isDir: false,
    });
    h.store.dispose();
  });

  test("a confirmed verdict arms nothing — the timer can only ever add a link", async () => {
    const h = harness();
    h.answerWith(there);
    h.store.lookup(PATH, null);
    await h.tick(20);
    expect(h.asked.length).toBe(1);

    await h.tick(RETRY_AFTER_MS * 3);
    await h.tick(50);
    expect(h.asked.length).toBe(1);
    h.store.dispose();
  });

  test("disposing stops the watch", async () => {
    const h = harness();
    h.answerWith(gone);
    h.store.lookup(PATH, null);
    await h.tick(20);
    expect(h.asked.length).toBe(1);

    h.store.dispose();
    await h.tick(RETRY_AFTER_MS * 2);
    await h.tick(50);
    expect(h.asked.length).toBe(1);
  });
});

describe("namesOrContains — how far a directory event reaches", () => {
  const named = new Set(["/repo/notes/x.md", "/repo/build"]);

  // The exact-name case is the caller's, and it is a plain `Set.has` — this
  // is only the ancestor walk, which a `Modified` deliberately does not get.
  test("the path itself is not the ancestor rule's business", () => {
    expect(namesOrContains(named, "/repo/notes/x.md")).toBe(false);
  });

  test("a directory the path lives under, at any depth", () => {
    expect(namesOrContains(named, "/repo/build/out/a.js")).toBe(true);
    expect(namesOrContains(named, "/repo/build/a.js")).toBe(true);
  });

  test("a sibling, or a prefix that is not a whole segment, reaches nothing", () => {
    expect(namesOrContains(named, "/repo/notes/y.md")).toBe(false);
    expect(namesOrContains(named, "/repo/buildings/a.js")).toBe(false);
    expect(namesOrContains(named, "/repo/notes/x.md.bak")).toBe(false);
  });

  test("an empty batch reaches nothing", () => {
    expect(namesOrContains(new Set(), "/repo/notes/x.md")).toBe(false);
  });
});

/**
 * The world, not the clock. The frame shape is the one
 * `lib/__tests__/text-card-store.manual.test.ts` builds, because it is the
 * one tugcast sends: a workspace key and a batch of events whose paths are
 * relative to it.
 */
describe("a FILESYSTEM event re-asks the verdicts it contradicts", () => {
  const PATH = "/repo/notes/x.md";

  type FrameEvent = { kind: string; path?: string; from?: string; to?: string };

  /** A synthetic frame rooted at `/repo`, naming absolute paths. */
  function frame(events: FrameEvent[]): Uint8Array {
    const rel = (p?: string) => (p === undefined ? undefined : p.replace(/^\/repo\//, ""));
    return new TextEncoder().encode(
      JSON.stringify({
        workspace_key: "/repo",
        events: events.map((e) => ({
          kind: e.kind,
          path: rel(e.path),
          from: rel(e.from),
          to: rel(e.to),
        })),
      }),
    );
  }

  function harness() {
    let clock = 1_000_000;
    const asked: string[][] = [];
    const heard: VerdictKey[][] = [];
    let answer: ProbeResult | null = null;
    const store = new PathResolutionStore(
      () => clock,
      async (paths) => {
        asked.push([...paths]);
        return answer;
      },
    );
    store.subscribe((keys) => heard.push([...keys]));
    return {
      store,
      asked,
      heard,
      answerWith: (next: ProbeResult | null) => {
        answer = next;
      },
      // The store batches wants on a 16ms debounce and answers on a microtask.
      settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
    };
  }

  const gone: ProbeResult = { exists: { [PATH]: false }, canonical: {}, isDir: {} };
  const there: ProbeResult = {
    exists: { [PATH]: true },
    canonical: { [PATH]: PATH },
    isDir: {},
  };

  test("a Created for a missing path lights it, with no pass and no clock", async () => {
    const h = harness();
    h.answerWith(gone);
    h.store.lookup(PATH, null);
    await h.settle();
    expect(h.store.lookup(PATH, null)).toEqual({ state: "missing" });
    expect(h.asked.length).toBe(1);

    // The tool call that writes the file lands. Not a minute has passed.
    h.answerWith(there);
    h.store.applyFilesystemFrame(frame([{ kind: "Created", path: PATH }]));
    await h.settle();

    expect(h.asked.length).toBe(2);
    expect(h.asked[1]).toEqual([PATH]);
    expect(h.heard).toEqual([
      [pathVerdictKey(PATH)],
      [pathVerdictKey(PATH)],
    ]);
    expect(h.store.lookup(PATH, null)).toEqual({
      state: "confirmed",
      canonical: PATH,
      isDir: false,
    });
    h.store.dispose();
  });

  test("a Removed darkens a confirmed path the same way", async () => {
    const h = harness();
    h.answerWith(there);
    h.store.lookup(PATH, null);
    await h.settle();
    expect(h.store.lookup(PATH, null).state).toBe("confirmed");

    h.answerWith(gone);
    h.store.applyFilesystemFrame(frame([{ kind: "Removed", path: PATH }]));
    await h.settle();

    expect(h.asked.length).toBe(2);
    expect(h.store.lookup(PATH, null)).toEqual({ state: "missing" });
    h.store.dispose();
  });

  test("a rename re-asks both ends of it", async () => {
    const h = harness();
    h.answerWith(gone);
    h.store.lookup("/repo/a.md", null);
    h.store.lookup("/repo/b.md", null);
    await h.settle();
    expect(h.asked.length).toBe(1);

    h.answerWith(null);
    h.store.applyFilesystemFrame(
      frame([{ kind: "Renamed", from: "/repo/a.md", to: "/repo/b.md" }]),
    );
    await h.settle();
    expect(h.asked.length).toBe(2);
    expect([...h.asked[1]].sort()).toEqual(["/repo/a.md", "/repo/b.md"]);
    h.store.dispose();
  });

  test("a removed directory takes the verdicts under it", async () => {
    const h = harness();
    h.answerWith({
      exists: { "/repo/build/out/a.js": true },
      canonical: {},
      isDir: {},
    });
    h.store.lookup("/repo/build/out/a.js", null);
    await h.settle();
    expect(h.asked.length).toBe(1);

    h.store.applyFilesystemFrame(frame([{ kind: "Removed", path: "/repo/build" }]));
    await h.settle();
    expect(h.asked.length).toBe(2);
    expect(h.asked[1]).toEqual(["/repo/build/out/a.js"]);
    h.store.dispose();
  });

  test("a Modified says nothing this store ever asked about", async () => {
    const h = harness();
    h.answerWith(there);
    h.store.lookup(PATH, null);
    await h.settle();
    expect(h.asked.length).toBe(1);

    h.store.applyFilesystemFrame(frame([{ kind: "Modified", path: PATH }]));
    await h.settle();
    // The feed collapses a create and a remove on one path into a single
    // `Modified`, so the kind is not an existence signal and the subject is
    // what counts: a `Modified` naming a path we hold re-asks it.
    expect(h.asked.length).toBe(2);
    h.store.dispose();
  });

  test("but a Modified on a directory does not re-ask what is under it", async () => {
    // macOS fires a modify on a parent whenever anything inside it changes,
    // so the ancestor walk is reserved for the kinds that can actually take
    // a subtree with them.
    const h = harness();
    h.answerWith({
      exists: { "/repo/build/out/a.js": true },
      canonical: {},
      isDir: {},
    });
    h.store.lookup("/repo/build/out/a.js", null);
    await h.settle();
    expect(h.asked.length).toBe(1);

    h.store.applyFilesystemFrame(frame([{ kind: "Modified", path: "/repo/build" }]));
    await h.settle();
    expect(h.asked.length).toBe(1);
    h.store.dispose();
  });

  test("an event about somebody else's file costs nothing", async () => {
    const h = harness();
    h.answerWith(gone);
    h.store.lookup(PATH, null);
    await h.settle();
    expect(h.asked.length).toBe(1);

    h.store.applyFilesystemFrame(
      frame([{ kind: "Created", path: "/repo/notes/other.md" }]),
    );
    await h.settle();
    expect(h.asked.length).toBe(1);
    h.store.dispose();
  });

  test("a malformed frame is silence, never a throw in a feed callback", () => {
    const h = harness();
    expect(() =>
      h.store.applyFilesystemFrame(new TextEncoder().encode("not json")),
    ).not.toThrow();
    expect(h.asked.length).toBe(0);
    h.store.dispose();
  });
});
