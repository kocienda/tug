/**
 * Coverage for the verdict-key ledger — the mechanism that decides which
 * ink is stale when an answer moves.
 *
 * The half of that mechanism that touches the DOM (`annotateElement` filing
 * a container's keys, `containerDependsOnVerdicts` walking a subtree) needs
 * a real DOM and is proven in the real app, not here (project policy: no
 * jsdom / happy-dom). What this file pins is everything above the DOM: how
 * a key is spelled, what a pass collects, and — driving the real store with
 * a real response shape — that the `missing` a path met is recorded as a
 * dependency and that the flip to `confirmed` names the very key that was
 * recorded.
 *
 * That last one is the defect this whole mechanism exists for. A path named
 * in prose before the tool call that creates it met `missing`, and the flag
 * the ledger replaced recorded only `pending` — so nothing was ever walked
 * again and the ink stayed plain for the life of the app.
 */

import { describe, expect, test } from "bun:test";

import { PathResolutionStore, type ProbeResult } from "../path-resolution";
import { VerdictBatcher, type VerdictSource } from "../verdict-batching";
import {
  collectVerdictKeys,
  commitVerdictKey,
  dependsOnKeys,
  nameVerdictKey,
  noteVerdictKey,
  pathVerdictKey,
  sessionVerdictKey,
  type VerdictKey,
} from "../verdict-keys";

describe("key spellings", () => {
  test("each resolver has its own namespace", () => {
    const spellings = [
      pathVerdictKey("/repo/a.ts"),
      nameVerdictKey("/repo", "a.ts"),
      commitVerdictKey("/repo", "a.ts"),
      sessionVerdictKey("a.ts"),
    ];
    expect(new Set(spellings).size).toBe(spellings.length);
  });

  test("one path is one key however many times it is asked", () => {
    expect(pathVerdictKey("/repo/a.ts")).toBe(pathVerdictKey("/repo/a.ts"));
  });

  test("the same name under two projects is two keys", () => {
    expect(nameVerdictKey("/one", "a.ts")).not.toBe(
      nameVerdictKey("/two", "a.ts"),
    );
  });

  test("the same sha in two checkouts is two keys", () => {
    expect(commitVerdictKey("/one", "abc1234")).not.toBe(
      commitVerdictKey("/two", "abc1234"),
    );
  });

  // The halves are length-delimited rather than separated by a character a
  // path is allowed to contain, so no two pairs can spell one key.
  test("a separator inside either half cannot forge a collision", () => {
    expect(nameVerdictKey("/a", "b/c.ts")).not.toBe(
      nameVerdictKey("/a/b", "c.ts"),
    );
    expect(nameVerdictKey("/a:", "b")).not.toBe(nameVerdictKey("/a", ":b"));
  });
});

describe("collectVerdictKeys", () => {
  test("collects what the pass noted", () => {
    const keys = collectVerdictKeys(() => {
      noteVerdictKey(pathVerdictKey("/repo/a.ts"));
      noteVerdictKey(pathVerdictKey("/repo/b.ts"));
    });
    expect([...keys].sort()).toEqual([
      pathVerdictKey("/repo/a.ts"),
      pathVerdictKey("/repo/b.ts"),
    ]);
  });

  test("one key noted twice is one key", () => {
    const keys = collectVerdictKeys(() => {
      noteVerdictKey(pathVerdictKey("/repo/a.ts"));
      noteVerdictKey(pathVerdictKey("/repo/a.ts"));
    });
    expect(keys.size).toBe(1);
  });

  test("a note outside a pass is dropped, not thrown", () => {
    expect(() => noteVerdictKey(pathVerdictKey("/repo/a.ts"))).not.toThrow();
    expect(collectVerdictKeys(() => {}).size).toBe(0);
  });

  test("a nested pass returns its own keys and files them with the outer one", () => {
    let inner: Set<VerdictKey> | null = null;
    const outer = collectVerdictKeys(() => {
      noteVerdictKey(pathVerdictKey("/repo/outer.ts"));
      inner = collectVerdictKeys(() => {
        noteVerdictKey(pathVerdictKey("/repo/inner.ts"));
      });
      noteVerdictKey(pathVerdictKey("/repo/after.ts"));
    });
    expect([...(inner ?? new Set())]).toEqual([pathVerdictKey("/repo/inner.ts")]);
    expect([...outer].sort()).toEqual([
      pathVerdictKey("/repo/after.ts"),
      pathVerdictKey("/repo/inner.ts"),
      pathVerdictKey("/repo/outer.ts"),
    ]);
  });

  test("a pass that throws still closes its collection", () => {
    expect(() =>
      collectVerdictKeys(() => {
        throw new Error("pass failed");
      }),
    ).toThrow("pass failed");
    expect(() => noteVerdictKey(pathVerdictKey("/repo/a.ts"))).not.toThrow();
    expect(collectVerdictKeys(() => {}).size).toBe(0);
  });
});

describe("dependsOnKeys", () => {
  const consulted = new Set([
    pathVerdictKey("/repo/a.ts"),
    nameVerdictKey("/repo", "b.ts"),
  ]);

  test("a moved key the pass consulted is a dependency", () => {
    expect(dependsOnKeys(consulted, [pathVerdictKey("/repo/a.ts")])).toBe(true);
  });

  test("a moved key the pass never consulted is not", () => {
    expect(dependsOnKeys(consulted, [pathVerdictKey("/repo/z.ts")])).toBe(false);
  });

  test("one match among many moved keys is enough", () => {
    expect(
      dependsOnKeys(consulted, [
        pathVerdictKey("/repo/y.ts"),
        pathVerdictKey("/repo/z.ts"),
        nameVerdictKey("/repo", "b.ts"),
      ]),
    ).toBe(true);
  });

  test("no ledger and no moved keys are both 'nothing is stale'", () => {
    expect(dependsOnKeys(undefined, [pathVerdictKey("/repo/a.ts")])).toBe(false);
    expect(dependsOnKeys(consulted, [])).toBe(false);
  });
});

/**
 * Build the answer the endpoint would give for one existing path.
 */
function found(path: string): ProbeResult {
  return { exists: { [path]: true }, canonical: { [path]: path }, isDir: {} };
}

/** The endpoint's answer for one path that is not there. */
function absent(path: string): ProbeResult {
  return { exists: { [path]: false }, canonical: {}, isDir: {} };
}

describe("the path store names the key it answered about", () => {
  test("a lookup notes its key whatever the verdict says", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const first = collectVerdictKeys(() => {
      expect(store.lookup("notes/x.md", "/repo").state).toBe("pending");
    });
    expect([...first]).toEqual([pathVerdictKey("/repo/notes/x.md")]);

    store.applyProbeResult(["/repo/notes/x.md"], absent("/repo/notes/x.md"));

    // The second pass meets `missing` — the state the retired flag did not
    // record — and records the key all the same.
    const second = collectVerdictKeys(() => {
      expect(store.lookup("notes/x.md", "/repo").state).toBe("missing");
    });
    expect([...second]).toEqual([pathVerdictKey("/repo/notes/x.md")]);
  });

  test("a relative candidate with no cwd notes nothing, since it asked nothing", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const keys = collectVerdictKeys(() => {
      expect(store.lookup("notes/x.md", null).state).toBe("unknown");
    });
    expect(keys.size).toBe(0);
  });

  test("a notification names the keys that moved, and only those", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const heard: VerdictKey[][] = [];
    store.subscribe((keys) => heard.push([...keys]));

    store.applyProbeResult(
      ["/repo/a.ts", "/repo/b.ts"],
      { exists: { "/repo/a.ts": true, "/repo/b.ts": false }, canonical: {}, isDir: {} },
    );
    expect(heard).toEqual([
      [pathVerdictKey("/repo/a.ts"), pathVerdictKey("/repo/b.ts")],
    ]);

    // The same answers again move nothing, so nothing is named.
    store.applyProbeResult(
      ["/repo/a.ts", "/repo/b.ts"],
      { exists: { "/repo/a.ts": true, "/repo/b.ts": false }, canonical: {}, isDir: {} },
    );
    expect(heard.length).toBe(1);
  });

  test("the missing a pass met is the key its flip names — the whole defect", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const path = "/repo/notes/x.md";

    // The file does not exist yet: the Bash header names it before the
    // command that writes it has run.
    store.applyProbeResult([path], absent(path));

    // The prose that follows is painted under that `missing`.
    const consulted = collectVerdictKeys(() => {
      expect(store.lookup(path, null).state).toBe("missing");
    });

    // The file arrives, and the re-ask comes back confirmed.
    const moved: VerdictKey[] = [];
    store.subscribe((keys) => moved.push(...keys));
    store.applyProbeResult([path], found(path));

    expect(store.lookup(path, null).state).toBe("confirmed");
    expect(dependsOnKeys(consulted, moved)).toBe(true);
  });

  test("and a deletion reaches ink painted under a confirmed answer", () => {
    const store = new PathResolutionStore(() => 0, async () => null);
    const path = "/repo/notes/x.md";
    store.applyProbeResult([path], found(path));

    const consulted = collectVerdictKeys(() => {
      expect(store.lookup(path, null).state).toBe("confirmed");
    });

    const moved: VerdictKey[] = [];
    store.subscribe((keys) => moved.push(...keys));
    store.applyProbeResult([path], absent(path));

    expect(dependsOnKeys(consulted, moved)).toBe(true);
  });
});

/** A source whose answers a test fires by hand. */
function fakeSource(): VerdictSource & { answer: (keys: VerdictKey[]) => void } {
  const listeners = new Set<(keys: readonly VerdictKey[]) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answer: (keys) => {
      for (const listener of listeners) listener(keys);
    },
  };
}

describe("VerdictBatcher carries the union of what moved", () => {
  test("one window's answers arrive as one notification naming every key", async () => {
    const one = fakeSource();
    const two = fakeSource();
    const batcher = new VerdictBatcher([one, two]);
    const heard: VerdictKey[][] = [];
    const off = batcher.subscribe((keys) => heard.push([...keys]));

    one.answer([pathVerdictKey("/repo/a.ts")]);
    two.answer([nameVerdictKey("/repo", "b.ts")]);
    one.answer([pathVerdictKey("/repo/a.ts")]);

    expect(heard).toEqual([]);
    await Bun.sleep(150);
    expect(heard.length).toBe(1);
    expect([...heard[0]].sort()).toEqual(
      [pathVerdictKey("/repo/a.ts"), nameVerdictKey("/repo", "b.ts")].sort(),
    );
    off();
  });

  test("a later window starts empty rather than repeating the last one", async () => {
    const source = fakeSource();
    const batcher = new VerdictBatcher([source]);
    const heard: VerdictKey[][] = [];
    const off = batcher.subscribe((keys) => heard.push([...keys]));

    source.answer([pathVerdictKey("/repo/a.ts")]);
    await Bun.sleep(150);
    source.answer([pathVerdictKey("/repo/b.ts")]);
    await Bun.sleep(150);

    expect(heard).toEqual([
      [pathVerdictKey("/repo/a.ts")],
      [pathVerdictKey("/repo/b.ts")],
    ]);
    off();
  });
});
