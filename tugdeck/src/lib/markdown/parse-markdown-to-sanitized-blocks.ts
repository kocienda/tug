/**
 * `parseMarkdownToSanitizedBlocks` — the shared lex/parse/sanitize
 * pipeline consumed by `TugMarkdownView` (virtualized renderer) and
 * `TugMarkdownBlock` (per-cell renderer).
 *
 * Per [D09] (md-block-sibling) in `tugplan-tug-list-view.md`, both
 * primitives share this entry point so the block parsing is
 * identical between them. Splitting them keeps each primitive small
 * and obvious at the import site (`TugMarkdownView` for streaming +
 * virtualized; `TugMarkdownBlock` for natural-flow per-cell content)
 * while the parsing pipeline stays exactly one piece of code.
 *
 * Pipeline stages:
 *   1. `lex_blocks(text)` — pulldown-cmark WASM call returns a packed
 *      `Uint32Array` of block metadata (`type`, byte offsets, depth,
 *      list-item count, table-row count).
 *   2. `decodeBlocks` — translate the packed array into rich
 *      `BlockMeta` records the rest of the pipeline can read.
 *   3. `buildByteToCharMap(text)` — lex returns UTF-8 byte offsets;
 *      JS string slicing uses UTF-16 code units. The map closes that
 *      gap so consumers reading `startChar` / `endChar` see correct
 *      JS indices.
 *   4. `parse_blocks_to_html(text)` — pulldown-cmark WASM call that
 *      walks the whole document in a single pass and emits one HTML
 *      string per top-level block. Single-pass parsing is what makes
 *      footnote ref ↔ definition linking and reference-style links
 *      work — both are cross-block features that a per-block
 *      reparse cannot resolve. The function's block bucketing matches
 *      `lex_blocks`'s in count and order so the two can be zipped.
 *   5. `getDOMPurify().sanitize(rawHtml, SANITIZE_CONFIG)` — strip
 *      anything the allowlist doesn't permit.
 *
 * The result interface (`SanitizedMarkdownBlock`) carries the lex
 * metadata alongside the sanitized HTML. `TugMarkdownView` reads the
 * metadata to estimate block heights for its windowing engine;
 * `TugMarkdownBlock` reads only `html` and `type`. Carrying the rest
 * is a few extra fields per block — orders of magnitude smaller than
 * the HTML payload itself — and keeps the helper's caller from
 * re-lexing to recover them.
 *
 * Pure module: no React, no DOM (beyond DOMPurify's tree-walk), no
 * state beyond the lazily-initialized DOMPurify singleton in
 * `dompurify-instance.ts`. Safe to call from any code path that has
 * the WASM module initialized.
 *
 * Laws: [L20] tokens — none consumed here (rendering chooses
 * tokens). [L21] license compliance — pulldown-cmark (MIT) and
 * DOMPurify (MPL-2.0 / Apache-2.0 dual) are vendored elsewhere; this
 * file is a pure consumer.
 */

import {
  lex_block_hashes,
  lex_blocks,
  parse_blocks_to_html,
} from "../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

import {
  applyBlockTransformers,
  type BlockTransformer,
} from "./block-transformers";
import { getDOMPurify, SANITIZE_CONFIG } from "./dompurify-instance";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One sanitized markdown block — paragraph, heading, code-fence, list,
 * table, blockquote, hr, html, or "other".
 *
 * `html` is post-DOMPurify safe HTML, ready to assign to a node's
 * `innerHTML`. The rest mirror the lex-pass metadata; consumers that
 * don't need them ignore the fields.
 */
export interface SanitizedMarkdownBlock {
  /** Sanitized HTML for the block. */
  html: string;
  /** Block kind from the lexer: "heading", "paragraph", "code", "blockquote", "list", "table", "hr", "html", "other". */
  type: string;
  /** Start character offset (JS string index) in the source text. */
  startChar: number;
  /** End character offset (JS string index, exclusive) in the source text. */
  endChar: number;
  /** Heading depth (1..6) for `type === "heading"`; 0 otherwise. */
  depth: number;
  /** List-item count for `type === "list"`; 0 otherwise. */
  itemCount: number;
  /** Table row count for `type === "table"`; 0 otherwise. */
  rowCount: number;
  /**
   * FNV-1a 64-bit hash of the block's source byte range, computed in
   * Rust during the lex pass. Identifies block-content equivalence
   * across renders for the streaming reconciler ([#step-18-8]) — when
   * two parses produce blocks whose `contentHash` matches at the same
   * index, the reconciler can leave that block's DOM untouched and
   * preserve its scroll-anchor identity.
   *
   * Carried as a `bigint` so the full 64 bits survive the WASM →
   * JS boundary (`Uint32Array` low/high pair packed into one
   * `BigInt`). The reconciler uses `===` equality for comparison.
   */
  contentHash: bigint;
}

// ---------------------------------------------------------------------------
// Internal block metadata — packed Uint32Array decoding
// ---------------------------------------------------------------------------

/**
 * Stride and tag mapping for `lex_blocks`'s packed `Uint32Array`. The
 * lexer emits four `u32`s per block:
 *   `[w0, startByte, endByte, w3]`
 * where `w0`'s low byte is the block-type tag and the next byte is
 * `depth`; `w3` packs `itemCount` (low 16 bits) and `rowCount` (high
 * 16 bits). The string array indexes line up with the lexer's tag
 * enum.
 */
const STRIDE = 4;
const BLOCK_TYPES = ["?", "heading", "paragraph", "code", "blockquote", "list", "table", "hr", "html", "other"];

/**
 * Decoded record for one entry in `lex_blocks`'s packed output.
 *
 * Exported so `TugMarkdownView`'s incremental update path can re-lex
 * a single region and consume the same metadata shape the full-pass
 * helper does. The byte offsets are kept in their pre-conversion form
 * (`startByte` / `endByte`) so the caller can apply its own
 * `buildByteToCharMap` against a substring.
 */
export interface BlockMeta {
  type: string;
  startByte: number;
  endByte: number;
  depth: number;
  itemCount: number;
  rowCount: number;
}

/**
 * Decode `lex_blocks`'s packed `Uint32Array` into a `BlockMeta[]`.
 * Exported so `TugMarkdownView`'s incremental path can re-lex a single
 * region and walk the metadata identically to the full-pass helper.
 */
export function decodeBlocks(buf: Uint32Array): BlockMeta[] {
  const count = buf.length / STRIDE;
  const blocks: BlockMeta[] = new Array(count);
  for (let i = 0, j = 0; i < buf.length; i += STRIDE, j += 1) {
    const w0 = buf[i];
    blocks[j] = {
      type: BLOCK_TYPES[w0 & 0xff] ?? "other",
      startByte: buf[i + 1],
      endByte: buf[i + 2],
      depth: (w0 >> 8) & 0xff,
      itemCount: buf[i + 3] & 0xffff,
      rowCount: (buf[i + 3] >> 16) & 0xffff,
    };
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// UTF-8 byte offset → JS string char index conversion
//
// pulldown-cmark returns BYTE offsets into the UTF-8 encoding of the
// input. JS `String.slice` uses UTF-16 code unit indices. For ASCII
// they coincide, but any multi-byte codepoint (em-arc, emoji)
// produces a wrong slice without this conversion.
//
// We build the map once per content string and reuse it for all
// block slices.
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder();

/**
 * Build a `Uint32Array` mapping UTF-8 byte index → JS string char
 * index. Index `i` holds the JS char index that starts at UTF-8 byte
 * `i`. Length is `byteLength + 1` (last entry = `text.length`).
 *
 * Exported so the incremental update path in `TugMarkdownView` can
 * use the same translation for region-scoped re-lexing.
 */
export function buildByteToCharMap(text: string): Uint32Array {
  const encoded = _encoder.encode(text);
  const byteLen = encoded.length;
  const map = new Uint32Array(byteLen + 1);
  let bytePos = 0;
  let charPos = 0;
  while (charPos < text.length) {
    map[bytePos] = charPos;
    const cp = text.codePointAt(charPos);
    if (cp === undefined) break;
    const byteWidth = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    const charWidth = cp >= 0x10000 ? 2 : 1;
    for (let b = 0; b < byteWidth; b += 1) {
      map[bytePos + b] = charPos;
    }
    bytePos += byteWidth;
    charPos += charWidth;
  }
  map[byteLen] = charPos;
  return map;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Optional knobs for the post-sanitize block-transformer pass.
 *
 * - `transformers` — ordered list of `BlockTransformer` instances. Each
 *   transformer flat-maps over the (current) block list and may
 *   replace, drop, or split a block. See `block-transformers/index.ts`.
 * - `isComplete` — passed through into each `BlockTransformContext`.
 *   Streaming-aware transformers (e.g. `mermaid`) defer their
 *   promotion until completion; for static documents callers leave
 *   this `true` (the default).
 */
export interface ParseMarkdownOptions {
  transformers?: ReadonlyArray<BlockTransformer>;
  isComplete?: boolean;
}

/**
 * Lex, parse, and sanitize markdown text into a list of safe HTML
 * blocks plus their lex metadata. Empty input returns an empty array
 * without invoking the WASM pipeline.
 *
 * The WASM module (`tugmark-wasm`) must be initialized before this
 * function is called. Production initialization happens in
 * `main.tsx`; tests use `initSync({ module: wasmBytes })`.
 *
 * If `options.transformers` is supplied, the result of the lex →
 * parse → sanitize pipeline runs through `applyBlockTransformers`
 * before being returned. Transformers may change a block's `type`
 * (e.g. promote a `code` block with `lang === "mermaid"` to a
 * `tug-mermaid` block), drop a block, or split it into siblings —
 * see Spec S04.
 */
export function parseMarkdownToSanitizedBlocks(
  text: string,
  options?: ParseMarkdownOptions,
): SanitizedMarkdownBlock[] {
  if (text === "") return [];

  const packed = lex_blocks(text);
  const blocks = decodeBlocks(packed);
  if (blocks.length === 0) return [];

  // Single-pass full-document parse for cross-block correctness
  // (footnote ref ↔ definition linking, reference-style links). The
  // count must match `lex_blocks`'s — both walk the same parser with
  // the same options — but we guard against any future drift by
  // capping the iteration at the shorter of the two and falling back
  // to an empty html for any extra lexer-reported blocks.
  const htmlPerBlock = parse_blocks_to_html(text) as string[];
  // Per-block FNV-1a 64-bit content hashes, walked the same way as
  // `lex_blocks` so the index ordering matches; 2 u32 per block (low
  // half then high half). Reassembled below into one `bigint` per
  // block for the reconciler ([#step-18-8]).
  const hashWords = lex_block_hashes(text);

  const byteToChar = buildByteToCharMap(text);
  const sanitizer = getDOMPurify();

  const result: SanitizedMarkdownBlock[] = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const startChar = byteToChar[block.startByte] ?? block.startByte;
    const endChar = byteToChar[block.endByte] ?? block.endByte;
    const rawHtml = htmlPerBlock[i] ?? "";
    const sanitized = sanitizer.sanitize(rawHtml, SANITIZE_CONFIG);
    // Pack the (low, high) u32 pair from `lex_block_hashes` into one
    // 64-bit `bigint`. Defensive `?? 0n` guards a hypothetical drift
    // between the two WASM walks; in practice both produce the same
    // count by construction.
    const hashLo = hashWords[i * 2] ?? 0;
    const hashHi = hashWords[i * 2 + 1] ?? 0;
    const contentHash = (BigInt(hashHi) << 32n) | BigInt(hashLo);
    result[i] = {
      html: sanitized,
      type: block.type,
      startChar,
      endChar,
      depth: block.depth,
      itemCount: block.itemCount,
      rowCount: block.rowCount,
      contentHash,
    };
  }

  const transformers = options?.transformers;
  if (transformers === undefined || transformers.length === 0) return result;
  return applyBlockTransformers(result, transformers, {
    isComplete: options?.isComplete,
  });
}
