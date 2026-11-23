/**
 * Pin the cache in front of `resolve_dockets`, as
 * `sketch-citation-store.test.ts` pins the one in front of `resolve_sketches`:
 * driven through the constructor's `send` seam, whose record is the store's
 * output.
 */

import { describe, expect, test } from "bun:test";

import { DocketCitationStore, type ResolveDocketsOk } from "@/lib/docket-citation-store";
import { decodeDocketVerbOk } from "@/protocol";

function storeWithWire() {
  const sent: { projectDir: string; ids: string[] }[] = [];
  const store = new DocketCitationStore((projectDir, ids) => {
    sent.push({ projectDir, ids: [...ids] });
    return true;
  });
  return { store, sent };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function missingOnly(ids: string[]): ResolveDocketsOk {
  return {
    verb: "resolve_dockets",
    requestId: null,
    projectDir: "/repo",
    projectKey: null,
    found: [],
    missing: ids,
  };
}

describe("docket citation store", () => {
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
    const reply = decodeDocketVerbOk({
      action: "resolve_dockets_ok",
      project_dir: "/repo",
      project_key: "/repo",
      found: [
        { id: "0a1b2c3d", name: "GPU wedge", project_dir: "/elsewhere", retired: true, threads: [] },
      ],
      missing: ["00ff00ff"],
    });
    expect(reply?.verb).toBe("resolve_dockets");
    store.applyResolved(reply as ResolveDocketsOk);
    expect(store.getAnswer("0a1b2c3d")).toEqual({
      status: "found",
      projectDir: "/elsewhere",
      name: "GPU wedge",
      retired: true,
      threads: 0,
    });
    expect(store.getAnswer("00ff00ff")).toEqual({ status: "missing" });
    expect(notified).toEqual([["0a1b2c3d", "00ff00ff"]]);
  });

  test("a cached miss is not asked again", async () => {
    const { store, sent } = storeWithWire();
    store.applyResolved(missingOnly(["00ff00ff"]));
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
    store.applyResolved(missingOnly(["00ff00ff"]));
    const notified: string[][] = [];
    store.subscribe((ids) => notified.push([...ids]));
    store.forgetAll();
    expect(notified).toEqual([["00ff00ff"]]);
    expect(store.getAnswer("00ff00ff")).toEqual({ status: "pending" });
  });
});
