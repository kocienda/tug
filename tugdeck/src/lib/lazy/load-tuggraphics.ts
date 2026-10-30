/**
 * `loadTuggraphics` — singleton lazy loader for the `tuggraphics-wasm`
 * crate, the chart engine. Built on the generic `wasmInit` helper so this
 * file declares only the shape of the engine.
 *
 * New crates default to lazy (tuglaws/wasm-crates.md): a deck that never
 * renders a chart pays nothing for the engine, and nothing in `main.tsx`
 * imports it.
 *
 * @module lib/lazy/load-tuggraphics
 */

import { wasmInit } from "./wasm-init";

/** A type role — text carries a role, never a font. */
export type ChartTypeRole = "title" | "label" | "value" | "mono";

/** A measured string: advance width, font-box ascent and descent, in px. */
export interface TextBox {
  w: number;
  a: number;
  d: number;
}

/** The measure table the deck hands the compiler: `"<role>\u0000<text>"` keys. */
export type MeasureTableJson = Record<string, TextBox>;

/** Which layers a door accepts: a fence takes charts only, a tool's stdout either. */
export type ChartLayers = "chart" | "any";

export interface ChartCompileOpts {
  /** The width the chart may take; absent, the spec's or the form's default. */
  width?: number;
  id_prefix: string;
  motion: boolean;
  layers: ChartLayers;
  /** Whether the figure draws its title; absent, it does. The deck's block header shows it instead. */
  figure_title?: boolean;
}

export interface ChartTable {
  caption: string;
  head: string[];
  rows: string[][];
}

export interface ChartError {
  path: string;
  message: string;
}

export type ChartRound =
  | { status: "measure"; texts: [ChartTypeRole, string][] }
  | {
      status: "done";
      svg: string;
      table: ChartTable;
      find_text: string;
      width: number;
      height: number;
    }
  | { status: "invalid"; errors: ChartError[] };

export type DrawOutcome =
  | { status: "done"; svg: string }
  | { status: "invalid"; errors: { op: number | null; message: string }[] };

export type ValidateOutcome = { status: "valid" } | { status: "invalid"; errors: ChartError[] };

export interface TuggraphicsEngine {
  /** Validates and renders a layer 0 program. */
  render_program(source: string, idPrefix: string): DrawOutcome;
  /** Every error in a source, for a door taking `layers`. */
  validate(source: string, layers: ChartLayers): ValidateOutcome;
  /** One round of the measure protocol. */
  compile_round(source: string, opts: ChartCompileOpts, table: MeasureTableJson): ChartRound;
  /**
   * The text transcript Find counts for a source: a chart's table text, a
   * drawing's nothing, an invalid source's own text.
   */
  find_text(source: string, layers: ChartLayers): string;
}

const loader = wasmInit<TuggraphicsEngine, typeof import("../../../crates/tuggraphics-wasm/pkg/tuggraphics_wasm.js")>(
  () => import("../../../crates/tuggraphics-wasm/pkg/tuggraphics_wasm.js"),
  (mod) => ({
    render_program: (source, idPrefix) => mod.render_program(source, idPrefix) as DrawOutcome,
    validate: (source, layers) => mod.validate(source, layers) as ValidateOutcome,
    compile_round: (source, opts, table) =>
      mod.compile_round(source, JSON.stringify(opts), JSON.stringify(table)) as ChartRound,
    find_text: (source, layers) => mod.find_text(source, layers),
  }),
);

export const loadTuggraphics = loader.load;
export const getTuggraphicsSync = loader.getSync;
export const resetTuggraphicsForTests = loader.reset;
export const injectTuggraphicsForTests = loader.inject;
