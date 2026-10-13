/**
 * `rendered-merge` — how two of tugcast's emissions for one Message fold
 * into one record, and how a `.rendered` value is told apart.
 *
 * Each emission carries the Message's block list from the first block that
 * changed, read against the emission it names, and HTML only for blocks
 * tugcast had not sent before. {@link expandRenderedMessage} reads a diff
 * back into the whole list; every record the engine posts is whole. The
 * ingest engine folds the renders that arrive before their Message mints,
 * and the page's mirror folds every emission into the record a row draws
 * from, both with {@link mergeRenderedMessage}. The display rule that reads
 * a record lives with the markdown pipeline, in
 * `lib/markdown/rendered-record.ts`.
 *
 * Pure and Worker-safe: types from tugproto, nothing else.
 */

import type { RenderedState } from "@tugproto/ingest";
import type { RenderedMessageWire } from "@tugproto/rendered";

/** A state that carries a record. */
export type RenderedRecord = Extract<NonNullable<RenderedState>, { message: RenderedMessageWire }>;

/** Whether a `.rendered` value is a record. */
export function isRenderedRecord(state: unknown): state is RenderedRecord {
  return typeof state === "object" && state !== null && "message" in state;
}

/** Whether a `.rendered` value is the pending state. */
export function isRenderedPending(state: unknown): state is { pending: true } {
  return typeof state === "object" && state !== null && (state as { pending?: unknown }).pending === true;
}

/**
 * An emission's whole block list, read against the whole record before it:
 * the earlier record's first `blocksFrom` blocks, then the emission's. A
 * whole emission reads as itself; a diff whose base is not the record held
 * reads as `null`, and is answered by a resync.
 */
export function expandRenderedMessage(
  earlier: RenderedMessageWire | null,
  later: RenderedMessageWire,
): RenderedMessageWire | null {
  if (later.blocksFrom === 0) return later;
  if (
    earlier === null
    || earlier.blocksFrom !== 0
    || earlier.seq !== later.baseSeq
    || later.blocksFrom > earlier.blocks.length
  ) {
    return null;
  }
  return {
    ...later,
    baseSeq: 0,
    blocksFrom: 0,
    blocks: [...earlier.blocks.slice(0, later.blocksFrom), ...later.blocks],
  };
}

/**
 * Merge a later emission into an earlier one. The later block list, read
 * against the earlier, its length and hash win; a block's HTML comes from
 * the later emission when it carried one, else from the earlier, and HTML
 * for a block no longer listed is dropped, as tugcast forgets it too. A
 * diff the earlier record is not the base of stays as it came, for the
 * engine to answer.
 */
export function mergeRenderedMessage(
  earlier: RenderedMessageWire | null,
  later: RenderedMessageWire,
): RenderedMessageWire {
  const whole = expandRenderedMessage(earlier, later);
  if (whole === null) return later;
  if (earlier === null) return whole;
  const html: Record<string, string> = {};
  for (const block of whole.blocks) {
    const h = later.html[block.hash] ?? earlier.html[block.hash];
    if (h !== undefined) html[block.hash] = h;
  }
  return { ...whole, html };
}
