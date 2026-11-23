/**
 * idea-search-answers.ts — where `search_ideas_ok` frames are heard.
 *
 * The search answers fan out to the idea-mention providers of however many
 * composers the page holds, each keeping the one whose request id is its own,
 * on `docket-search-answers.ts`'s terms. It holds no answer: a provider that
 * was not listening when one arrived asks again.
 *
 * @module lib/idea-search-answers
 */

import type { IdeaVerbOk } from "@/protocol";

/** The decoded `search_ideas_ok`. */
export type SearchIdeasOk = Extract<IdeaVerbOk, { verb: "search_ideas" }>;

type Listener = (answer: SearchIdeasOk) => void;

const listeners = new Set<Listener>();

/** Hear every answer; the returned function stops listening ([L27]). */
export function onIdeaSearchAnswer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hand a decoded `search_ideas_ok` to whoever is listening. */
export function deliverIdeaSearchAnswer(answer: SearchIdeasOk): void {
  for (const listener of [...listeners]) listener(answer);
}
