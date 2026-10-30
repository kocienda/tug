/**
 * `wasmInit` — generic singleton-promise helper for lazy-loading
 * wasm-pack-emitted modules.
 *
 * Every per-crate loader (`load-tugdiff-wasm.ts`, future siblings) was
 * accumulating the same boilerplate: a module-scoped `inflight`
 * promise, a `default()` init call, a typed wrapper around the
 * exported functions, a reset-on-rejection hook, and a test injection
 * point. This module factors that into a single helper so each
 * per-crate loader stays focused on the *shape* of its engine, not
 * the plumbing.
 *
 * Usage from a per-crate loader:
 *
 * ```ts
 * import { wasmInit } from "./wasm-init";
 *
 * export interface MyEngine { foo(x: string): string; }
 *
 * const loader = wasmInit<MyEngine, typeof import("...wasm.js")>(
 *   () => import("../../../crates/my-wasm/pkg/my_wasm.js"),
 *   (mod) => ({ foo: mod.foo as (x: string) => string }),
 * );
 *
 * export const loadMyWasm = loader.load;
 * export const resetMyWasmForTests = loader.reset;
 * export const injectMyWasmForTests = loader.inject;
 * ```
 *
 * Why dynamic-import callbacks instead of a path string: Vite needs
 * the import literal to be statically resolvable at the call site for
 * module-graph analysis and chunk splitting. Each per-crate loader
 * supplies its own one-line `() => import("...")` arrow that Vite
 * can see and bundle correctly.
 *
 * @module lib/lazy/wasm-init
 */

/**
 * Construct a singleton lazy-loader for one wasm-pack-built crate.
 *
 * - `importer` returns a dynamic import of the crate's generated JS.
 *   The returned module's `default` export is the wasm-bindgen
 *   `__wbg_init` function; calling it with no argument resolves the
 *   `.wasm` URL via `import.meta.url`, which Vite rewrites correctly.
 * - `shape` projects the loaded module into the typed engine the
 *   consumer wants. Cast types here, not at every call site.
 *
 * Returns `{ load, getSync, reset, inject }`:
 *
 * - `load()` returns the singleton promise. The first call kicks off
 *   the import + wasm init; subsequent calls share the same promise.
 *   On rejection, the cache resets so a future caller can retry.
 * - `getSync()` returns the engine once a load has settled (or after
 *   `inject`), and `null` before then — for a caller that must answer
 *   synchronously and can start a load for next time.
 * - `reset()` clears the cache. Use only from test setup.
 * - `inject(engine)` pre-populates the cache with a stub engine so
 *   tests can run synchronously without a real wasm runtime.
 */
export interface WasmLoader<TEngine> {
  load(): Promise<TEngine>;
  getSync(): TEngine | null;
  reset(): void;
  inject(engine: TEngine): void;
}

interface WasmModuleInit {
  default(arg?: unknown): Promise<unknown>;
}

export function wasmInit<TEngine, TModule extends WasmModuleInit>(
  importer: () => Promise<TModule>,
  shape: (mod: TModule) => TEngine,
): WasmLoader<TEngine> {
  let inflight: Promise<TEngine> | null = null;
  let resolved: TEngine | null = null;

  function load(): Promise<TEngine> {
    if (inflight === null) {
      const pending = (async () => {
        const mod = await importer();
        await mod.default();
        return shape(mod);
      })();
      inflight = pending;
      // A load superseded by `reset` or `inject` settles into nothing.
      pending.then(
        (engine) => {
          if (inflight === pending) resolved = engine;
        },
        () => {
          if (inflight === pending) {
            inflight = null;
            resolved = null;
          }
        },
      );
    }
    return inflight;
  }

  function getSync(): TEngine | null {
    return resolved;
  }

  function reset(): void {
    inflight = null;
    resolved = null;
  }

  function inject(engine: TEngine): void {
    inflight = Promise.resolve(engine);
    resolved = engine;
  }

  return { load, getSync, reset, inject };
}
