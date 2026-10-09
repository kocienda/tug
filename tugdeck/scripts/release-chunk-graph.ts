/**
 * release-chunk-graph.ts — build the release bundle in memory and print its
 * chunk graph as JSON on stdout.
 *
 * Runs the project's own `vite.config.ts` in production mode with
 * `write: false`, so nothing lands in `dist/`. Each chunk is reported with
 * the modules it contains, not only the module it is named for: a manifest
 * names a chunk by its facade, and a module folded into another chunk never
 * appears in it, which is the one case a test of what ships has to see.
 *
 * Usage: bun run scripts/release-chunk-graph.ts
 */
import path from "path";
import { build } from "vite";
import type { Rollup } from "vite";

const root = path.resolve(import.meta.dir, "..");

export interface ChunkRecord {
  fileName: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  modules: string[];
}

const result = await build({
  root,
  configFile: path.join(root, "vite.config.ts"),
  mode: "production",
  logLevel: "silent",
  build: { write: false },
});

const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
const chunks: ChunkRecord[] = outputs
  .flatMap((o) => o.output)
  .filter((item): item is Rollup.OutputChunk => item.type === "chunk")
  .map((c) => ({
    fileName: c.fileName,
    isEntry: c.isEntry,
    facadeModuleId: c.facadeModuleId,
    imports: c.imports,
    dynamicImports: c.dynamicImports,
    modules: Object.keys(c.modules).map((id) => path.relative(root, id)),
  }));

process.stdout.write(JSON.stringify(chunks));
