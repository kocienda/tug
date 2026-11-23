/**
 * Pin the cache in front of `resolve_sketches`, as `arc-citation-store.test.ts`
 * pins the one in front of `resolve_arcs`: driven through the constructor's
 * `send` seam, whose record is the store's output.
 */

import { describe, expect, test } from "bun:test";

import { SketchCitationStore } from "@/lib/sketch-citation-store";
import { decodeResolveSketchesOk } from "@/protocol";

function storeWithWire() {
  const sent: { projectDir: string; ids: string[] }[] = [];
  const store = new SketchCitationStore((projectDir, ids) => {
    sent.push({ projectDir, ids: [...ids] });
    return true;
  });
  return { store, sent };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("sketch citation store", () => {
  test("asks once per id, batched per asking project", async () => {
    const { store, sent } = storeWithWire();
    store.request("/repo", "0a1b2c3d");
    store.request("/repo", "0a1b2c3e");
    store.request("/repo", "0a1b2c3d");
    store.request("/other", "0a1b2c3f");
    await flush();
    expect(sent).toEqual([
      { projectDir: "/repo", ids: ["0a1b2c3d", "0a1b2c3e"] },
      { projectDir: "/other", ids: ["0a1b2c3f"] },
    ]);
    store.request("/other", "0a1b2c3d");
    await flush();
    expect(sent.length).toBe(2);
  });

  test("caches the found and the missing, and names the ids that moved", () => {
    const { store } = storeWithWire();
    const notified: string[][] = [];
    store.subscribe((ids) => notified.push([...ids]));
    const reply = decodeResolveSketchesOk({
      action: "resolve_sketches_ok",
      project_dir: "/repo",
      found: [
        {
          id: "0a1b2c3d",
          project_dir: "/elsewhere",
          arc: { name: "drawn" },
          versions: [{ n: 1, at: "2026-10-01T00:00:00Z" }],
        },
      ],
      missing: ["00ff00ff"],
    });
    store.applyResolved(reply!);
    expect(store.getAnswer("0a1b2c3d")).toEqual({
      status: "found",
      projectDir: "/elsewhere",
      arc: { name: "drawn", created: null },
      versions: [{ n: 1, at: "2026-10-01T00:00:00Z" }],
    });
    expect(store.getAnswer("00ff00ff")).toEqual({ status: "missing" });
    expect(notified).toEqual([["0a1b2c3d", "00ff00ff"]]);
  });

  test("a cached miss is not asked again", async () => {
    const { store, sent } = storeWithWire();
    store.applyResolved({ projectDir: "/repo", found: [], missing: ["00ff00ff"] });
    store.request("/repo", "00ff00ff");
    await flush();
    expect(sent).toEqual([]);
  });

  test("a refusal forgets the asks in flight without caching a miss", async () => {
    const { store, sent } = storeWithWire();
    store.request("/repo", "0a1b2c3d");
    await flush();
    store.applyFailed();
    expect(store.getAnswer("0a1b2c3d")).toEqual({ status: "pending" });
    store.request("/repo", "0a1b2c3d");
    await flush();
    expect(sent.length).toBe(2);
  });

  test("forgetting on reconnect names every id it dropped", () => {
    const { store } = storeWithWire();
    store.applyResolved({ projectDir: "/repo", found: [], missing: ["00ff00ff"] });
    const notified: string[][] = [];
    store.subscribe((ids) => notified.push([...ids]));
    store.forgetAll();
    expect(notified).toEqual([["00ff00ff"]]);
    expect(store.getAnswer("00ff00ff")).toEqual({ status: "pending" });
  });
});
