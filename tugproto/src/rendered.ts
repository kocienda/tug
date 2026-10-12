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
 * emission carries the message's whole ordered block list but `html` only
 * for blocks whose hash was not in that message's previous emission. Two
 * emissions merge as follows: the later block list wins, and each block's
 * HTML comes from the latest emission that carried it. Hashes are FNV-1a
 * 64 as decimal strings, the form `data-content-hash` holds.
 *
 * The Rust side mirrors these shapes in
 * `tugrust/crates/tugcast/src/feeds/render_bridge.rs`; both are held to
 * `__tests__/fixtures/rendered-parity.json`.
 *
 * Pure types — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/rendered
 */

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
  /** The whole ordered block list. */
  blocks: RenderedBlockWire[];
  /** Sanitized HTML by block hash, only for hashes new since the last emission. */
  html: Record<string, string>;
  /** The rendered text's length in UTF-16 code units. */
  textLength: number;
  /** FNV-1a 64 over the rendered text's UTF-8 bytes, decimal. */
  textHash: string;
}

/** One tick's renders, every session's changed messages bundled. */
export interface RenderBatchFrame {
  kind: "render-batch";
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
  /** Grep mode, and every mounted unit: the unit's text. */
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
}

export type RenderInput =
  | RenderMotionControl
  | RenderPeriodControl
  | RenderResyncControl
  | RenderFindControl;
