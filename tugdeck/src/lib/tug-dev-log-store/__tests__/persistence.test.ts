/**
 * Persistence behavior of `TugDevLogStore` — verifies that filter +
 * cap mutations issue PUT requests to `/api/defaults/dev.tugapp.dev-panel/*`
 * with the right `kind` / `value` shape, and that the free-text
 * filter is NEVER PUT (in-memory only).
 *
 * Stubs `globalThis.fetch` to capture calls — same pattern the
 * sibling stores' persistence tests use.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  DEV_LOG_KEYS,
  LOG_STORE_DOMAIN,
  tugDevLogStore,
} from "@/lib/tug-dev-log-store/tug-dev-log-store";

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

let captured: CapturedRequest[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    captured.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
    });
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  (tugDevLogStore as unknown as { _disposeForTest: () => void })._disposeForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function pickPut(suffix: string): CapturedRequest | undefined {
  return captured.find(
    (c) => c.method === "PUT" && c.url.endsWith(`/${suffix}`),
  );
}

describe("TugDevLogStore — persistence", () => {
  it("setLevels PUTs logFilterLevels as kind:json (sorted string[])", async () => {
    tugDevLogStore.setLevels(new Set(["warn", "error"]));
    await Promise.resolve();
    const put = pickPut(DEV_LOG_KEYS.FILTER_LEVELS);
    expect(put).toBeDefined();
    expect(put!.url).toBe(
      `/api/defaults/${LOG_STORE_DOMAIN}/${DEV_LOG_KEYS.FILTER_LEVELS}`,
    );
    expect(put!.body).toEqual({
      kind: "json",
      value: ["error", "warn"],
    });
  });

  it("setSource('x') PUTs logFilterSource as kind:string", async () => {
    tugDevLogStore.setSource("x");
    await Promise.resolve();
    const put = pickPut(DEV_LOG_KEYS.FILTER_SOURCE);
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ kind: "string", value: "x" });
  });

  it("setSource(null) PUTs logFilterSource as kind:null", async () => {
    tugDevLogStore.setSource("x");
    tugDevLogStore.setSource(null);
    await Promise.resolve();
    const puts = captured.filter(
      (c) =>
        c.method === "PUT" &&
        c.url.endsWith(`/${DEV_LOG_KEYS.FILTER_SOURCE}`),
    );
    const last = puts[puts.length - 1];
    expect(last.body).toEqual({ kind: "null", value: null });
  });

  it("setMaxEntries PUTs logMaxEntries as kind:i64", async () => {
    tugDevLogStore.setMaxEntries(250);
    await Promise.resolve();
    const put = pickPut(DEV_LOG_KEYS.MAX_ENTRIES);
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ kind: "i64", value: 250 });
  });

  it("setNewestFirst(true) PUTs logNewestFirst as kind:bool", async () => {
    tugDevLogStore.setNewestFirst(true);
    await Promise.resolve();
    const put = pickPut(DEV_LOG_KEYS.NEWEST_FIRST);
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ kind: "bool", value: true });
  });

  it("setText NEVER PUTs anything", async () => {
    tugDevLogStore.setText("hello");
    await Promise.resolve();
    const puts = captured.filter((c) => c.method === "PUT");
    expect(puts.length).toBe(0);
    // But the snapshot DOES reflect the change.
    expect(tugDevLogStore.getSnapshot().filters.text).toBe("hello");
  });

  it("clearing the buffer never PUTs (buffer is transient)", async () => {
    tugDevLogStore.info("a", "hi");
    await Promise.resolve();
    captured = [];
    tugDevLogStore.clear();
    await Promise.resolve();
    const puts = captured.filter((c) => c.method === "PUT");
    expect(puts.length).toBe(0);
  });
});
