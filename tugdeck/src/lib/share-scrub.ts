/**
 * share-scrub.ts — the deck's one route to tugcast's secret filter.
 *
 * Every string a share output will show goes to tugcast in
 * `scrub_share_text` requests and comes back scrubbed, with the user's home
 * directory shortened to `~`. A long session's strings run to many
 * megabytes, and one WebSocket message past tugcast's 16 MiB limit ends the
 * connection — every card's, not just this one's — so the strings travel in
 * batches of about {@link SCRUB_BATCH_BYTES} each, one request at a time, and
 * a string longer than a batch is cut at line ends and joined again
 * ({@link batchScrubTexts}). The deck never ports the filter's patterns: a
 * second copy would drift from the one the semantic index already trusts.
 *
 * {@link scrubShareTexts} is the whole surface. It resolves the scrubbed
 * strings, or `null` when there is no connection, when tugcast refuses a
 * request, or when a batch goes unanswered for {@link SCRUB_SHARE_DEADLINE_MS}.
 * A `null` fails the share action: unscrubbed text never renders.
 *
 * CONTROL answers are broadcast and reach the page through the action
 * registry, so the registry hands each decoded answer to
 * {@link deliverScrubShareAnswer}, and the one pending ask whose request id
 * it carries settles. Each ask is one wait — the answer or one cleared
 * `setTimeout` — and its entry is released on whichever comes first ([L27],
 * [L33]).
 *
 * @module lib/share-scrub
 */

import { encodeScrubShareText } from "@/protocol";
import type { ScrubShareTextErr, ScrubShareTextOk } from "@/protocol";
import { getConnection } from "./connection-singleton";

/** How long one batch's scrub may take before the share action fails. */
export const SCRUB_SHARE_DEADLINE_MS = 10_000;

/**
 * The most text one request carries, in UTF-16 units. JSON escaping and
 * UTF-8 encoding can grow a string several times over, and this leaves a
 * batch far under tugcast's 16 MiB message limit whatever it holds.
 */
export const SCRUB_BATCH_BYTES = 1_000_000;

/** One string of a batch: which input it belongs to, and its text. */
interface ScrubPiece {
  index: number;
  text: string;
}

/**
 * `texts` as batches of pieces, each batch at most `limit` long in all. A
 * string longer than `limit` becomes several pieces, cut after a line end
 * where there is one — a secret does not span lines — and hard at `limit`
 * where a single line is longer than that. Every input yields at least one
 * piece, an empty string included, so the pieces of index `i`, joined in
 * order, are `texts[i]`.
 */
export function batchScrubTexts(texts: readonly string[], limit: number): ScrubPiece[][] {
  const batches: ScrubPiece[][] = [];
  let batch: ScrubPiece[] = [];
  let size = 0;
  const push = (piece: ScrubPiece): void => {
    if (batch.length > 0 && size + piece.text.length > limit) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(piece);
    size += piece.text.length;
  };
  texts.forEach((text, index) => {
    let rest = text;
    while (rest.length > limit) {
      const lineEnd = rest.lastIndexOf("\n", limit - 1);
      let cut = lineEnd === -1 ? limit : lineEnd + 1;
      // Never between the halves of a surrogate pair: a lone half is not
      // text tugcast's decoder accepts.
      const before = rest.charCodeAt(cut - 1);
      if (cut > 1 && before >= 0xd800 && before <= 0xdbff) cut -= 1;
      push({ index, text: rest.slice(0, cut) });
      rest = rest.slice(cut);
    }
    push({ index, text: rest });
  });
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** The pending asks, by request id. */
const pending = new Map<string, (texts: readonly string[] | null) => void>();

let nextRequest = 0;

/**
 * Scrub `texts` through tugcast. Resolves the same number of strings in the
 * same order, or `null` when the scrub could not be had — no connection, a
 * refusal, an answer of the wrong length, or the deadline.
 */
export async function scrubShareTexts(texts: readonly string[]): Promise<readonly string[] | null> {
  const out: string[] = texts.map(() => "");
  for (const batch of batchScrubTexts(texts, SCRUB_BATCH_BYTES)) {
    const answer = await scrubBatch(batch.map((piece) => piece.text));
    if (answer === null) return null;
    batch.forEach((piece, i) => {
      out[piece.index] += answer[i];
    });
  }
  return out;
}

/** Scrub one batch: a single request, and its answer or `null`. */
function scrubBatch(texts: readonly string[]): Promise<readonly string[] | null> {
  const connection = getConnection();
  if (connection === null) return Promise.resolve(null);
  nextRequest += 1;
  const requestId = `scrub-${Date.now().toString(36)}-${nextRequest}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), SCRUB_SHARE_DEADLINE_MS);
    function settle(answer: readonly string[] | null): void {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(answer !== null && answer.length === texts.length ? answer : null);
    }
    pending.set(requestId, settle);
    const frame = encodeScrubShareText({ requestId, texts });
    connection.send(frame.feedId, frame.payload);
  });
}

/**
 * Hand a decoded `scrub_share_text_ok` or `scrub_share_text_err` to the ask
 * it answers. An answer whose id no ask holds — another page's, or one that
 * arrived after its deadline — is dropped.
 */
export function deliverScrubShareAnswer(answer: ScrubShareTextOk | ScrubShareTextErr): void {
  if (answer.requestId === null) return;
  const settle = pending.get(answer.requestId);
  if (settle === undefined) return;
  settle("texts" in answer ? answer.texts : null);
}
