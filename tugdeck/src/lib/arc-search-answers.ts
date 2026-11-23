/**
 * arc-search-answers.ts — where `search_arcs_ok` frames are heard.
 *
 * CONTROL answers reach a page through the action registry, one handler per
 * action, while the askers are the arc-mention providers of however many
 * composers the page holds. This is the fan-out between the two, on
 * `session-search-answers.ts`'s terms: the registry delivers each decoded
 * answer here, and every provider listens and keeps the one whose request id
 * is its own. It holds no answer.
 *
 * @module lib/arc-search-answers
 */

import type { SearchArcsOk } from "@/protocol";

type Listener = (answer: SearchArcsOk) => void;

const listeners = new Set<Listener>();

/** Hear every answer; the returned function stops listening ([L27]). */
export function onArcSearchAnswer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hand a decoded `search_arcs_ok` to whoever is listening. */
export function deliverArcSearchAnswer(answer: SearchArcsOk): void {
  for (const listener of [...listeners]) listener(answer);
}
