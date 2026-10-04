/**
 * reach-registry.ts — which named functions ran, per module, in an instrumented deck.
 *
 * Only a deck built with `TUG_APPTEST_REACH=1` calls into this module: the reach Babel
 * plugin (`tugdeck/scripts/babel-plugin-tug-reach.ts`) gives every instrumented module a
 * prologue that registers the module's function names here and keeps the returned
 * array, and each function's first statement sets its own slot to 1. A plain deck never
 * imports it.
 *
 * The app-test harness reads the result through `window.__tugReach.dump()` before it
 * tears an app down, so the selector can rank tests by the functions they actually ran.
 *
 * Pure data, outside every state zone: nothing here renders, subscribes, or notifies.
 */

interface ModuleReach {
    names: readonly string[];
    hits: Uint8Array;
}

/** What `dump()` returns: per module path, its distinct-name count and the names that ran. */
export type ReachDump = Record<string, { n: number; hit: string[] }>;

const modules = new Map<string, ModuleReach>();

const distinct = (names: readonly string[]): string[] => [...new Set(names)];

/** Every registered module's distinct names and the subset that ran. */
export function dump(): ReachDump {
    const out: ReachDump = {};
    for (const [path, m] of modules) {
        out[path] = {
            n: distinct(m.names).length,
            hit: distinct(m.names.filter((_, i) => m.hits[i] === 1)),
        };
    }
    return out;
}

/** Zero every module's hits. For the registry's own tests. */
export function reset(): void {
    for (const m of modules.values()) m.hits.fill(0);
}

let installed = false;

/**
 * Register one module's function names, in declaration order, and return the array its
 * functions mark. A module registered twice (a hot reload) gets a fresh array.
 */
export function __tugReachRegister(path: string, names: readonly string[]): Uint8Array {
    const hits = new Uint8Array(names.length);
    modules.set(path, { names, hits });
    if (!installed && typeof window !== "undefined") {
        installed = true;
        (window as unknown as { __tugReach: { dump: typeof dump } }).__tugReach = { dump };
    }
    return hits;
}
