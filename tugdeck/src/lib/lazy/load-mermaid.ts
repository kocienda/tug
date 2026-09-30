/**
 * `loadMermaid` — singleton lazy loader for the Mermaid diagram
 * library.
 *
 * Per [D10] Mermaid is excluded from the boot bundle: a session that
 * never sees a ` ```mermaid ` fence pays nothing for it. First
 * encounter triggers the dynamic import; subsequent renders share
 * the cached engine.
 *
 * One-shot promise — the first caller kicks off the import,
 * subsequent callers share that promise. Once resolved, the engine
 * is also exposed via {@link getMermaidSync} so DOM-walk consumers
 * can render synchronously after a single async wait.
 *
 * The engine accepts a `themeName` plus a small `themeVariables` map
 * on every render call. Re-initializing per render is cheap (Mermaid
 * stores the config; the expensive work happens in `render`) and
 * keeps theme switches honest — an ironclad → sloop swap shows up on
 * the next diagram emission without explicit reset.
 *
 * @module lib/lazy/load-mermaid
 */

import type { MermaidConfig } from "mermaid";

/**
 * Subset of Mermaid's `themeVariables` we pass through from the
 * markdown call sites. Mermaid accepts arbitrary string CSS colours
 * for these keys and falls back to its theme defaults for anything
 * left unset. Keeping the surface narrow here so a caller can only
 * tune what we've vetted against both `ironclad` and `sloop`.
 */
export interface MermaidThemeVariables {
  primaryColor?: string;
  primaryBorderColor?: string;
  primaryTextColor?: string;
  lineColor?: string;
  textColor?: string;
  mainBkg?: string;
  background?: string;
  noteBkgColor?: string;
  noteTextColor?: string;
  fontFamily?: string;
}

/**
 * Configuration accepted by the engine's render call. The theme name
 * picks Mermaid's built-in palette; `themeVariables` tunes individual
 * colours on top. Both default to Mermaid's own defaults if absent.
 */
export interface MermaidRenderConfig {
  themeName?: "default" | "base" | "dark" | "neutral" | "forest";
  themeVariables?: MermaidThemeVariables;
}

/**
 * Outcome of one Mermaid render call. Mirrors the underlying
 * library's `RenderResult` but exposes only the fields the
 * tugways consumers use (the svg string; bind functions are not
 * needed because our diagrams have no interactive bindings).
 */
export interface MermaidRenderResult {
  svg: string;
  diagramType: string;
}

/**
 * Narrow engine surface exposed by the loader. The wrapper hides the
 * default-export shape of `mermaid` so consumers don't import the
 * package directly — keeping the boot bundle clean of any direct
 * Mermaid reference per [D10].
 */
export interface MermaidEngine {
  render(
    id: string,
    text: string,
    config?: MermaidRenderConfig,
  ): Promise<MermaidRenderResult>;
}

let cached: MermaidEngine | null = null;
let inflight: Promise<MermaidEngine> | null = null;

/**
 * Build the engine wrapper around a freshly-imported Mermaid module.
 * Exported for the test injection point so a stub engine can be
 * constructed without pulling the real package into a unit test.
 */
function makeEngine(mod: {
  default: {
    initialize: (config: MermaidConfig) => void;
    render: (id: string, text: string) => Promise<{ svg: string; diagramType: string }>;
  };
}): MermaidEngine {
  // `securityLevel: 'strict'` keeps Mermaid from injecting HTML inside
  // the rendered SVG (the only execution surface diagrams have);
  // `startOnLoad: false` disables the auto-scan that would otherwise
  // run against every `.mermaid` element in the document on import.
  // Both are set once at construction; per-render `initialize` calls
  // below only tune theme.
  mod.default.initialize({ startOnLoad: false, securityLevel: "strict" });
  return {
    async render(id, text, config) {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: config?.themeName ?? "default",
        themeVariables: config?.themeVariables ?? {},
      });
      return mod.default.render(id, text);
    },
  };
}

/**
 * Load (or return the cached) Mermaid engine. Idempotent — every
 * caller after the first shares the same singleton promise. On
 * rejection the cache resets so a future caller can retry.
 */
export function loadMermaid(): Promise<MermaidEngine> {
  if (cached !== null) return Promise.resolve(cached);
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const mod = await import("mermaid");
    cached = makeEngine(mod as unknown as Parameters<typeof makeEngine>[0]);
    return cached;
  })();
  inflight.catch(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Synchronous accessor for the loaded engine. Returns `null` until
 * the first {@link loadMermaid} call resolves. Used by DOM walkers
 * that want to short-circuit re-loads after the initial wait.
 */
export function getMermaidSync(): MermaidEngine | null {
  return cached;
}

/**
 * Test-only: clear the loader cache so a subsequent
 * {@link loadMermaid} call kicks off a fresh import. Never call from
 * production code.
 */
export function resetMermaidForTests(): void {
  cached = null;
  inflight = null;
}

/**
 * Test-only: pre-populate the loader with a stub engine so unit
 * tests can run synchronously without a real mermaid import.
 */
export function injectMermaidForTests(engine: MermaidEngine): void {
  cached = engine;
  inflight = Promise.resolve(engine);
}
