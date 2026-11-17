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

/**
 * Where a string's glyphs actually are, in px from the text origin on the
 * alphabetic baseline: left and right edges, and how far the ink rises
 * above and falls below the baseline.
 */
export interface InkBox {
  l: number;
  r: number;
  a: number;
  d: number;
}

/**
 * A measured string: advance width, font-box ascent and descent, in px,
 * and the ink box when the engine asked for it.
 */
export interface TextBox {
  w: number;
  a: number;
  d: number;
  ink?: InkBox;
}

/** The measure table the deck hands the compiler: `"<role>\u0000<text>"` keys. */
export type MeasureTableJson = Record<string, TextBox>;

/**
 * Which layers a door accepts: a `tugchart` fence takes charts only, a
 * `tugdiagram` fence diagrams only, and a tool's stdout any of them.
 */
export type ChartLayers = "chart" | "diagram" | "any";

export interface ChartCompileOpts {
  /** The width the chart may take; absent, the spec's or the form's default. */
  width?: number;
  id_prefix: string;
  motion: boolean;
  layers: ChartLayers;
  /** Whether the figure draws its title; absent, it does. The deck's block header shows it instead. */
  figure_title?: boolean;
}

/**
 * What one place in a chart's table names: a ref (`"commit:63de5762a"`), a
 * set of refs of one kind, or — past the set cap — how many there were.
 */
export type ChartRefSlot =
  | string
  | { kind: string; members: string[] }
  | { kind: string; count: number };

/** A mark annotation's ref: its index among the annotations, the category it marks, and its label. */
export interface ChartMarkRef {
  index: number;
  at: number;
  label: string;
  slot: ChartRefSlot;
}

/**
 * A table's refs, addressed as its text is. Each list is empty when
 * nothing at that address carries a ref.
 */
export interface ChartTableRefs {
  /** Per table row. */
  rows: (ChartRefSlot | null)[];
  /** Per head column; index 0, the label column, is always null. */
  cols: (ChartRefSlot | null)[];
  /** `[row][col]`, column 0 always null. */
  cells: (ChartRefSlot | null)[][];
  /** `dots` only: `[row][dot index]`. */
  items: (ChartRefSlot | null)[][];
  /** The mark annotations that carry a ref, in annotation order. */
  marks: ChartMarkRef[];
}

export interface ChartTable {
  caption: string;
  head: string[];
  rows: string[][];
  /** Absent when the spec carries no refs. */
  refs?: ChartTableRefs;
  /** The spec's `source`, verbatim; absent when the spec has none. */
  source?: ChartSource;
}

/**
 * The recipe and absolute arguments a chart was drawn from, which a reader
 * hands back to ask that recipe for a mark's members. The engine checks its
 * shape and draws nothing from it.
 */
export interface ChartSource {
  recipe: string;
  args?: Record<string, unknown>;
}

export interface ChartError {
  path: string;
  message: string;
}

export type ChartRound =
  /** `ink` names the pairs among `texts` whose ink box is wanted too. */
  | { status: "measure"; texts: [ChartTypeRole, string][]; ink: [ChartTypeRole, string][] }
  | {
      status: "done";
      svg: string;
      table: ChartTable;
      find_text: string;
      width: number;
      height: number;
      /**
       * What is wrong with the source that did not stop it drawing. They
       * are for whoever wrote the source, and `tugtool chart render` is
       * where that author reads them: the deck draws the figure and shows
       * the reader none of them.
       */
      warnings: ChartError[];
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
