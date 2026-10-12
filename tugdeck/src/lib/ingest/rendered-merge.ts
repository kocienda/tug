/**
 * `rendered-merge` — how two of tugcast's emissions for one Message fold
 * into one record, and how a `.rendered` value is told apart.
 *
 * Each emission carries the Message's whole block list but HTML only for
 * blocks tugcast had not sent before. The ingest engine folds the renders
 * that arrive before their Message mints, and the page's mirror folds every
 * emission into the record a row draws from, both with
 * {@link mergeRenderedMessage}. The display rule that reads a record lives
 * with the markdown pipeline, in `lib/markdown/rendered-record.ts`.
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
 * Merge a later emission into an earlier one. The later block list, length
 * and hash win; a block's HTML comes from the later emission when it carried
 * one, else from the earlier, and HTML for a block no longer listed is
 * dropped, as tugcast forgets it too.
 */
export function mergeRenderedMessage(
  earlier: RenderedMessageWire | null,
  later: RenderedMessageWire,
): RenderedMessageWire {
  if (earlier === null) return later;
  const html: Record<string, string> = {};
  for (const block of later.blocks) {
    const h = later.html[block.hash] ?? earlier.html[block.hash];
    if (h !== undefined) html[block.hash] = h;
  }
  return { ...later, html };
}
