/**
 * tugproto/rendered — tugcast's native markdown renders and the controls the
 * deck sends back.
 *
 * tugcast parses, sanitizes and highlights every streaming session's
 * assistant text itself and ships the result on the `RENDERED` feed (0xB0),
 * one JSON {@link RenderedFrame} per frame. The deck answers on
 * `RENDER_INPUT` (0xB1) with one JSON {@link RenderInput} per frame.
 *
 * A message is addressed by the wire's key for it (`messageKey`), and an
 * emission carries the message's ordered block list from the first block
 * that changed since its previous emission, and `html` only for blocks
 * whose hash was not in that emission. Emissions are numbered per message
 * (`seq`); a list that starts past zero (`blocksFrom`) is read against the
 * emission it names (`baseSeq`), and one whose base the receiver does not
 * hold is answered by a resync, which tugcast answers whole. Two emissions
 * merge as follows: the later block list wins, and each block's HTML comes
 * from the latest emission that carried it. Hashes are FNV-1a 64 as decimal
 * strings, the form `data-content-hash` holds.
 *
 * The Rust side mirrors these shapes in
 * `tugrust/crates/tugcast/src/feeds/render_bridge.rs`; both are held to
 * `__tests__/fixtures/rendered-parity.json`.
 *
 * Every `render-batch` and every control carries the protocol version it
 * was written at (`v`, {@link RENDERED_FEED_VERSION}). tugcast refuses a
 * control at a version it does not speak, and answers a deck's whole resync
 * at once with an empty `render-batch`: that answer is how a deck learns
 * this tugcast renders at a version it reads, and a deck that has not had
 * it draws its own rows.
 *
 * Pure types and constants — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/rendered
 */

/** The protocol version both halves speak: `RENDERED_FEED_VERSION` in `render_bridge.rs`. */
export const RENDERED_FEED_VERSION = 1;

// ---------------------------------------------------------------------------
// tugcast → deck (`RENDERED`)
// ---------------------------------------------------------------------------

/** One top-level block of a rendered message, without its HTML. */
export interface RenderedBlockWire {
  /** FNV-1a 64 over the block's source bytes, decimal. */
  hash: string;
  /** The page's block type: "paragraph", "code", "tug-math-display", …. */
  kind: string;
  /** UTF-16 offsets into the message text. */
  startChar: number;
  endChar: number;
  depth: number;
  itemCount: number;
  rowCount: number;
}

/** One message's emission. */
export interface RenderedMessageWire {
  messageKey: string;
  channel: "text" | "thinking";
  /** This emission's number for the message, counting from 1. */
  seq: number;
  /**
   * The emission `blocks` continues, when `blocksFrom` is not zero: keep
   * that emission's first `blocksFrom` blocks and append `blocks`. Zero when
   * the list is whole.
   */
  baseSeq: number;
  /** Where `blocks` starts in the message's whole block list. */
  blocksFrom: number;
  /** The ordered block list from `blocksFrom` on. */
  blocks: RenderedBlockWire[];
  /** Sanitized HTML by block hash, only for hashes new since the last emission. */
  html: Record<string, string>;
  /** The rendered text's length in UTF-16 code units. */
  textLength: number;
  /** FNV-1a 64 over the rendered text's UTF-8 bytes, decimal. */
  textHash: string;
}

/** One tick's renders, every session's changed messages bundled; empty in answer to a whole resync. */
export interface RenderBatchFrame {
  kind: "render-batch";
  /** The protocol version the batch was written at. */
  v: number;
  sessions: { tugSessionId: string; messages: RenderedMessageWire[] }[];
}

/** The answer to a {@link RenderFindControl}. */
export interface FindResultFrame {
  kind: "find-result";
  requestId: string;
  tugSessionId: string;
  /** The query did not compile (grep mode only; a literal always does). */
  invalid?: true;
  /** Literal mode: every match, in unit order. */
  matches?: { unit: string; start: number; end: number }[];
  /**
   * Grep mode, and every mounted unit: the unit's text, except a unit whose
   * text hashes to the find's `knownTexts` entry for it, which the page
   * already holds.
   */
  texts?: Record<string, string>;
  /** Units tugcast holds no text for. */
  missing: string[];
}

export type RenderedFrame = RenderBatchFrame | FindResultFrame;

// ---------------------------------------------------------------------------
// deck → tugcast (`RENDER_INPUT`)
// ---------------------------------------------------------------------------

/** The deck's motion hold: tugcast buffers renders while any holder is held. */
export interface RenderMotionControl {
  kind: "motion";
  holder: string;
  held: boolean;
  /** How long the hold may last; tugcast expires it at `max(capMs, 1000)`. */
  capMs?: number;
}

/** The display period tugcast paces its emissions to. */
export interface RenderPeriodControl {
  kind: "display-period";
  periodMs: number;
}

/** Ask for every block's HTML on the next emission: one message, one session's, or all. */
export interface RenderResyncControl {
  kind: "resync";
  tugSessionId?: string;
  messageKey?: string;
}

/** A find query over a session's rendered text. */
export interface RenderFindControl {
  kind: "find";
  requestId: string;
  tugSessionId: string;
  query: string;
  options: { caseSensitive: boolean; wholeWord: boolean; grep: boolean };
  limit: number;
  units: string[];
  mountedUnits: string[];
  /**
   * The text hash (FNV-1a 64, decimal) of each unit's rendered text the
   * page holds, so tugcast leaves the ones still current out of `texts`.
   */
  knownTexts?: Record<string, string>;
}

export type RenderInput =
  | RenderMotionControl
  | RenderPeriodControl
  | RenderResyncControl
  | RenderFindControl;

/** One `RENDER_INPUT` frame: a control and the protocol version it was written at. */
export type RenderInputFrame = RenderInput & { v: number };

/** A control as the wire carries it, at this deck's version. */
export function renderInputFrame(control: RenderInput): RenderInputFrame {
  return { v: RENDERED_FEED_VERSION, ...control };
}
