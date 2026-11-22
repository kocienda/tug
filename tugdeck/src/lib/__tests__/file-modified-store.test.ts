/**
 * Pure-logic tests for `fileModifiedStore`: what a disk read or write records,
 * and what a stat answer does to what is held.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { FileModifiedStore, readStatTimes } from "@/lib/file-modified-store";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function answering(body: unknown): void {
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;
}

describe("FileModifiedStore — record", () => {
  it("holds the time a read or write reported, and notifies once per change", () => {
    const store = new FileModifiedStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.record("/a.md", 100);
    store.record("/a.md", 100);
    expect(store.get("/a.md")).toBe(100);
    expect(notified).toBe(1);
  });

  it("a zero is the wire's unknown and records nothing", () => {
    const store = new FileModifiedStore();
    store.record("/a.md", 0);
    expect(store.get("/a.md")).toBeNull();
    expect(store.getVersion()).toBe(0);
  });

  it("forget drops a deleted file's time", () => {
    const store = new FileModifiedStore();
    store.record("/a.md", 100);
    store.forget("/a.md");
    expect(store.get("/a.md")).toBeNull();
  });
});

describe("FileModifiedStore — request", () => {
  it("records each stat'd file's time and forgets a file that is gone", async () => {
    const store = new FileModifiedStore();
    store.record("/gone.md", 5);
    answering({
      exists: { "/a.md": true, "/gone.md": false },
      mtimeMs: { "/a.md": 1234 },
    });
    await store.request(["/a.md", "/gone.md"]);
    expect(store.get("/a.md")).toBe(1234);
    expect(store.get("/gone.md")).toBeNull();
  });

  it("an answer from a tugcast with no mtimes leaves what is held", async () => {
    const store = new FileModifiedStore();
    store.record("/a.md", 77);
    answering({ exists: { "/a.md": true } });
    await store.request(["/a.md"]);
    expect(store.get("/a.md")).toBe(77);
  });

  it("a failed request changes nothing and does not throw", async () => {
    const store = new FileModifiedStore();
    store.record("/a.md", 77);
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error("down");
    }) as unknown as typeof globalThis.fetch;
    await store.request(["/a.md"]);
    expect(store.get("/a.md")).toBe(77);
  });
});

describe("readStatTimes", () => {
  it("reads a body that is not an answer as none", () => {
    expect(readStatTimes(null)).toBeNull();
    expect(readStatTimes({ exists: [], mtimeMs: "x" })).toEqual({ exists: {}, mtimeMs: {} });
  });
});
