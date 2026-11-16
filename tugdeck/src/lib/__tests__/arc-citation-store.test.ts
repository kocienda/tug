/**
 * Pin the cache in front of `resolve_arcs` — whether a project's arc log holds
 * the arc an `arc:` reference names.
 *
 * The store is driven through its own constructor seam: `send` records what a
 * batch would put on the wire, which is the store's output rather than a mock
 * of something it calls. The annotator's reading of it is app-tested.
 */

import { describe, expect, test } from "bun:test";

import { ArcCitationStore } from "@/lib/arc-citation-store";
import { arcVerdictKey } from "@/lib/annotator/verdict-keys";
import { decodeResolveArcsOk } from "@/protocol";

function storeWithWire() {
  const sent: { projectDir: string; names: string[] }[] = [];
  const store = new ArcCitationStore((projectDir, names) => {
    sent.push({ projectDir, names: [...names] });
    return true;
  });
  return { store, sent };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("arc citation store", () => {
  test("asks once per name, batched per project", async () => {
    const { store, sent } = storeWithWire();
    store.request("/repo", "a");
    store.request("/repo", "b");
    store.request("/repo", "a");
    store.request("/other", "a");
    await flush();
    expect(sent).toEqual([
      { projectDir: "/repo", names: ["a", "b"] },
      { projectDir: "/other", names: ["a"] },
    ]);
    store.request("/repo", "a");
    await flush();
    expect(sent.length).toBe(2);
  });

  test("files found and missing answers, and names the keys that moved", () => {
    const { store } = storeWithWire();
    const notified: string[][] = [];
    store.subscribe((keys) => notified.push([...keys]));
    const reply = decodeResolveArcsOk({
      action: "resolve_arcs_ok",
      project_dir: "/repo",
      found: [
        { name: "open", fate: "live" },
        { name: "landed", fate: "joined", join_sha: "302d43b5d1" },
      ],
      missing: ["gone"],
    });
    expect(reply).not.toBeNull();
    store.applyResolved(reply!);
    expect(store.getAnswer("/repo", "open")).toEqual({
      status: "found",
      fate: "live",
    });
    expect(store.getAnswer("/repo", "landed")).toEqual({
      status: "found",
      fate: "joined",
      joinSha: "302d43b5d1",
    });
    expect(store.getAnswer("/repo", "gone")).toEqual({ status: "missing" });
    expect(store.getAnswer("/other", "open")).toEqual({ status: "pending" });
    expect(notified).toEqual([
      [
        arcVerdictKey("/repo", "open"),
        arcVerdictKey("/repo", "landed"),
        arcVerdictKey("/repo", "gone"),
      ],
    ]);
  });

  test("a refusal forgets the asks in flight without caching a miss", async () => {
    const { store, sent } = storeWithWire();
    store.request("/repo", "a");
    await flush();
    store.applyFailed();
    expect(store.getAnswer("/repo", "a")).toEqual({ status: "pending" });
    store.request("/repo", "a");
    await flush();
    expect(sent.length).toBe(2);
  });

  test("with no wire, the ask is dropped so a later pass asks again", async () => {
    let live = false;
    const sent: string[] = [];
    const store = new ArcCitationStore((_, names) => {
      if (!live) return false;
      sent.push(...names);
      return true;
    });
    store.request("/repo", "a");
    await flush();
    live = true;
    store.request("/repo", "a");
    await flush();
    expect(sent).toEqual(["a"]);
  });

  test("forgetting everything names every key it dropped", () => {
    const { store } = storeWithWire();
    store.applyResolved({ projectDir: "/repo", found: [], missing: ["x"] });
    const notified: string[][] = [];
    store.subscribe((keys) => notified.push([...keys]));
    store.forgetAll();
    expect(notified).toEqual([[arcVerdictKey("/repo", "x")]]);
    expect(store.getAnswer("/repo", "x")).toEqual({ status: "pending" });
  });

  test("a joined row with no sha is dropped by the decoder", () => {
    expect(
      decodeResolveArcsOk({
        action: "resolve_arcs_ok",
        project_dir: "/repo",
        found: [{ name: "x", fate: "joined" }],
        missing: [],
      })?.found,
    ).toEqual([]);
  });
});
