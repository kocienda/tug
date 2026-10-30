/**
 * `chart-find-text.ts` — what transcript Find counts for a chart source.
 *
 * A chart's findable text is its table alternative: title, head cells, body
 * cells, row-major, joined with nothing — the order the rendered `<table>`
 * holds them in. An invalid source's text is the source itself, which is
 * what its error surface shows; a layer 0 drawing's is nothing. The engine
 * computes it (`find_text`), so the projection and tugcast's `text.rs`
 * agree by construction.
 *
 * The engine is a lazy WASM module. Before it has loaded the projection is
 * `""` and the load is started, so the next projection — or the painter's
 * heal of a mounted row from its DOM text ([P03] of the find design) —
 * carries the real string.
 *
 * @module lib/chart/chart-find-text
 */

import { getTuggraphicsSync, loadTuggraphics, type ChartLayers } from "@/lib/lazy/load-tuggraphics";

/** The Find text of `source` under `layers`, or `""` with the engine still loading. */
export function chartFindText(source: string, layers: ChartLayers): string {
  const engine = getTuggraphicsSync();
  if (engine === null) {
    void loadTuggraphics();
    return "";
  }
  return engine.find_text(source, layers);
}
