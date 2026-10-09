/**
 * What the release chunk carries.
 *
 * Spikes, gallery cards, fixture cards and the `window.__tug` test surface
 * are maker tooling: `main.tsx` loads them through dynamic imports behind
 * `loadMakerTooling`, so a release deck never fetches them. That holds only
 * while no shipped module imports one of them statically — one such import
 * would fold it back into a chunk the entry loads, with no behaviour to show
 * for it. So this asserts over the build itself: every chunk reachable from
 * the entry by static imports is free of those modules, and each of them is
 * still built, behind a dynamic import, for the decks that do load it.
 *
 * The build runs in a subprocess (`scripts/release-chunk-graph.ts`) so Vite
 * sees none of the globals other test files install.
 */
import { describe, expect, it } from "bun:test";
import path from "path";

import type { ChunkRecord } from "../../scripts/release-chunk-graph";

const DECK_ROOT = path.resolve(import.meta.dir, "../..");

// The project's own modules only: `node_modules` carries icons named
// `gallery-*` that the shipped deck draws.
const MAKER_TOOLING = [
  /^src\/spikes\//,
  /^src\/.*\/gallery-[^/]*$/,
  /^src\/fixtures\//,
  /^src\/test-surface\.ts$/,
];

function isMakerTooling(module: string): boolean {
  return MAKER_TOOLING.some((pattern) => pattern.test(module));
}

function buildChunkGraph(): ChunkRecord[] {
  const run = Bun.spawnSync(
    [process.execPath, "run", "scripts/release-chunk-graph.ts"],
    { cwd: DECK_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0) {
    throw new Error(`release build failed:\n${run.stderr.toString()}`);
  }
  return JSON.parse(run.stdout.toString()) as ChunkRecord[];
}

describe("release chunk contents", () => {
  it(
    "keeps maker tooling out of every chunk the entry loads statically",
    () => {
      const chunks = buildChunkGraph();
      const byFile = new Map(chunks.map((c) => [c.fileName, c]));
      const entry = chunks.find(
        (c) => c.isEntry && c.facadeModuleId?.endsWith("index.html") === true,
      );
      expect(entry).toBeDefined();

      const reachable = new Set<string>();
      const pending = [entry!.fileName];
      while (pending.length > 0) {
        const file = pending.pop()!;
        if (reachable.has(file)) continue;
        reachable.add(file);
        pending.push(...(byFile.get(file)?.imports ?? []));
      }

      const shipped = [...reachable].flatMap((file) =>
        (byFile.get(file)?.modules ?? []).filter(isMakerTooling).map(
          (module) => `${file}: ${module}`,
        ),
      );
      expect(shipped).toEqual([]);

      // The shared markdown sheet styles every shipped `TugMarkdownBlock`
      // (fenced-code and table chrome, image overlay, link tokens), but its
      // only component importer is `TugMarkdownView`, which ships with the
      // gallery alone. Dropping the gallery once dropped this sheet with it.
      const shippedModules = [...reachable].flatMap(
        (file) => byFile.get(file)?.modules ?? [],
      );
      expect(shippedModules).toContain(
        "src/components/tugways/tug-markdown-view.css",
      );

      // Not vacuous: the tooling is still built, and the entry still
      // reaches each of the four roots through a dynamic import.
      const lazy = chunks
        .filter((c) => !reachable.has(c.fileName))
        .flatMap((c) => c.modules);
      for (const root of [
        "src/components/tugways/cards/gallery-registrations.tsx",
        "src/spikes/spike-registry.tsx",
        "src/fixtures/fixture-registrations.tsx",
        "src/test-surface.ts",
      ]) {
        expect(lazy).toContain(root);
      }
      const entryDynamic = entry!.dynamicImports
        .flatMap((file) => byFile.get(file)?.modules ?? []);
      expect(entryDynamic).toContain("src/test-surface.ts");
    },
    120_000,
  );
});
