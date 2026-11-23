/**
 * docket-search-answers.ts — where `search_dockets_ok` frames are heard.
 *
 * The search answers fan out to the docket-mention providers of however many
 * composers the page holds, each keeping the one whose request id is its own,
 * on `sketch-search-answers.ts`'s terms. It holds no answer: a provider that
 * was not listening when one arrived asks again.
 *
 * @module lib/docket-search-answers
 */

import type { DocketVerbOk } from "@/protocol";

/** The decoded `search_dockets_ok`. */
export type SearchDocketsOk = Extract<DocketVerbOk, { verb: "search_dockets" }>;

type Listener = (answer: SearchDocketsOk) => void;

const listeners = new Set<Listener>();

/** Hear every answer; the returned function stops listening ([L27]). */
export function onDocketSearchAnswer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hand a decoded `search_dockets_ok` to whoever is listening. */
export function deliverDocketSearchAnswer(answer: SearchDocketsOk): void {
  for (const listener of [...listeners]) listener(answer);
}
