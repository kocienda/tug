/**
 * `rendered-record` — the page's record of tugcast's renders for one
 * Message, and the rule that decides whether a row draws from it.
 *
 * tugcast renders a live Message's text natively and ships each emission
 * with the Message's whole block list but HTML only for blocks it had not
 * sent before. The ingest engine writes what it learns into the Message's
 * `.rendered` path, beside `.text`, as one of four states: never written
 * (the page parses, as for a restored row), `{ pending: true }` (a live
 * Message whose first render has not arrived: draw nothing new), a record,
 * or `null` ("parse yourself").
 *
 * {@link mergeRenderedMessage} folds an emission into the record the mirror
 * holds (it lives in `lib/ingest/rendered-merge.ts`, where the Worker can
 * load it too). {@link chooseRenderedBlocks} reads a state and answers with
 * blocks to draw, `"keep"`, or `null` to parse.
 *
 * Pure — no DOM, no React.
 */

import { isRenderedPending, isRenderedRecord } from "@/lib/ingest/rendered-merge";
import type { SanitizedMarkdownBlock } from "./parse-markdown-to-sanitized-blocks";

export {
  isRenderedPending,
  isRenderedRecord,
  mergeRenderedMessage,
  type RenderedRecord,
} from "@/lib/ingest/rendered-merge";

/**
 * What a row draws for a `.rendered` state:
 *
 * - never written or `null`: `null`, parse;
 * - pending: `"keep"`, leave the DOM as it is;
 * - a finalized record that is not current: `"keep"`, until tugcast's
 *   render of the final text lands or the engine's finisher writes `null`;
 * - a record with a block whose HTML is missing: `null`, parse;
 * - a streaming record longer than the row's text (`textLength` past
 *   `rowTextLength`): `null`, parse. It renders text this page does not
 *   hold, which a page whose own feed dropped a delta can meet;
 * - a streaming record: its blocks, even when they lag the text by a tick;
 * - a finalized, current record: its blocks.
 *
 * A finalized record that is not current is never drawn, and never parsed
 * either: a turn's end routinely overtakes tugcast's last tick, so parsing
 * at once would parse every finished row. The engine's finisher bounds the
 * wait.
 */
export function chooseRenderedBlocks(
  state: unknown,
  rowTextLength: number,
): SanitizedMarkdownBlock[] | "keep" | null {
  if (isRenderedPending(state)) return "keep";
  if (!isRenderedRecord(state)) return null;
  if (!state.streaming && !state.current) return "keep";
  if (state.streaming && state.message.textLength > rowTextLength) return null;
  const { blocks, html } = state.message;
  const out: SanitizedMarkdownBlock[] = [];
  for (const block of blocks) {
    const h = html[block.hash];
    if (h === undefined) return null;
    out.push({
      html: h,
      type: block.kind,
      startChar: block.startChar,
      endChar: block.endChar,
      depth: block.depth,
      itemCount: block.itemCount,
      rowCount: block.rowCount,
      contentHash: BigInt(block.hash),
    });
  }
  return out;
}

/**
 * Whether a `.rendered` state is a live Message still streaming: pending its
 * first render, or a record tugcast has not finalized. The page holds back
 * its own fence highlighting while this is true.
 */
export function isRenderedStreaming(state: unknown): boolean {
  if (isRenderedPending(state)) return true;
  return isRenderedRecord(state) && state.streaming;
}

/** The sibling `.rendered` path of a Message's `.text` path, or `null` for any other path. */
export function renderedPathFor(streamingPath: string): string | null {
  if (!streamingPath.startsWith("turn.") || !streamingPath.endsWith(".text")) return null;
  if (!streamingPath.includes(".message.")) return null;
  return `${streamingPath.slice(0, -".text".length)}.rendered`;
}
