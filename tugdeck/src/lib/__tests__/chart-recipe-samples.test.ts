/**
 * Every recipe's sample, compiled by the real chart engine. The recipes come
 * from `catalog.json`, the dump a Rust test holds equal to the catalog, so a new
 * recipe is covered here with no change to this file.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compile_round, initSync } from "../../../crates/tuggraphics-wasm/pkg/tuggraphics_wasm.js";
import { runMeasureLoop } from "../chart/chart-measure";
import { narrowCatalog } from "../chart-recipes-store";
import type { ChartRound } from "../lazy/load-tuggraphics";

const dir = dirname(fileURLToPath(import.meta.url));
const dump: unknown[] = JSON.parse(
  readFileSync(join(dir, "../../../../tugrust/crates/tugchart-core/catalog.json"), "utf8"),
);

beforeAll(() => {
  initSync({ module: readFileSync(join(dir, "../../../crates/tuggraphics-wasm/pkg/tuggraphics_wasm_bg.wasm")) });
});

describe("the catalog's samples", () => {
  test("every row of the dump survives the deck's narrowing", () => {
    expect(dump.length).toBeGreaterThan(0);
    expect(narrowCatalog({ recipes: dump }).length).toBe(dump.length);
  });

  test("every sample compiles to a figure", () => {
    const opts = JSON.stringify({ id_prefix: "t", motion: false, layers: "chart" });
    for (const { name, sample } of narrowCatalog({ recipes: dump })) {
      const source = JSON.stringify(sample);
      const round = runMeasureLoop(
        (table) => compile_round(source, opts, JSON.stringify(table)) as ChartRound,
        (_role, text) => ({ w: text.length * 6, a: 10, d: 3 }),
      );
      expect([name, round.status]).toEqual([name, "done"]);
    }
  });
});
