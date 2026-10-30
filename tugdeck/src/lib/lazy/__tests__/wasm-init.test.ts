/**
 * `wasmInit` — the synchronous accessor over the singleton load, driven
 * by real importers (one that resolves, one that rejects) rather than a
 * mocked loader.
 */

import { describe, expect, test } from "bun:test";

import { wasmInit } from "../wasm-init";

interface Engine {
  name: string;
}

function resolvingLoader(name = "real") {
  return wasmInit<Engine, { default(): Promise<unknown>; name: string }>(
    () => Promise.resolve({ default: async () => undefined, name }),
    (mod) => ({ name: mod.name }),
  );
}

describe("wasmInit getSync", () => {
  test("is null before a load and the engine once it settles", async () => {
    const loader = resolvingLoader();
    expect(loader.getSync()).toBeNull();
    const pending = loader.load();
    expect(loader.getSync()).toBeNull();
    const engine = await pending;
    expect(loader.getSync()).toBe(engine);
    expect(engine.name).toBe("real");
  });

  test("is the injected engine after inject", () => {
    const loader = resolvingLoader();
    const stub = { name: "stub" };
    loader.inject(stub);
    expect(loader.getSync()).toBe(stub);
  });

  test("is null again after reset", async () => {
    const loader = resolvingLoader();
    await loader.load();
    loader.reset();
    expect(loader.getSync()).toBeNull();
  });

  test("a load superseded by reset does not fill the cache", async () => {
    const loader = resolvingLoader();
    const pending = loader.load();
    loader.reset();
    await pending;
    expect(loader.getSync()).toBeNull();
  });

  test("is null after a rejected load, and a later load retries", async () => {
    let attempts = 0;
    const loader = wasmInit<Engine, { default(): Promise<unknown> }>(
      () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("fetch failed"))
          : Promise.resolve({ default: async () => undefined });
      },
      () => ({ name: "second" }),
    );
    await expect(loader.load()).rejects.toThrow("fetch failed");
    expect(loader.getSync()).toBeNull();
    const engine = await loader.load();
    expect(loader.getSync()).toBe(engine);
    expect(attempts).toBe(2);
  });
});
