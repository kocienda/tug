/**
 * share-scrub.ts — the deck's one route to tugcast's secret filter.
 *
 * Every string a share output will show goes to tugcast in one
 * `scrub_share_text` request and comes back scrubbed, with the user's home
 * directory shortened to `~`. The deck never ports the filter's patterns: a
 * second copy would drift from the one the semantic index already trusts.
 *
 * {@link scrubShareTexts} is the whole surface. It resolves the scrubbed
 * strings, or `null` when there is no connection, when tugcast refuses the
 * request, or when nothing answers within {@link SCRUB_SHARE_DEADLINE_MS}.
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

/** How long a scrub may take before the share action fails. */
export const SCRUB_SHARE_DEADLINE_MS = 10_000;

/** The pending asks, by request id. */
const pending = new Map<string, (texts: readonly string[] | null) => void>();

let nextRequest = 0;

/**
 * Scrub `texts` through tugcast. Resolves the same number of strings in the
 * same order, or `null` when the scrub could not be had — no connection, a
 * refusal, an answer of the wrong length, or the deadline.
 */
export function scrubShareTexts(texts: readonly string[]): Promise<readonly string[] | null> {
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
