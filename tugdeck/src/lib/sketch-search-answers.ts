/**
 * sketch-search-answers.ts — where `search_sketches_ok` frames are heard.
 *
 * The search answers fan out to the sketch-mention providers of however many
 * composers the page holds, each keeping the one whose request id is its own,
 * on `session-search-answers.ts`'s terms. It holds no answer: a provider that
 * was not listening when one arrived asks again.
 *
 * @module lib/sketch-search-answers
 */

import type { SearchSketchesOk } from "@/protocol";

type Listener = (answer: SearchSketchesOk) => void;

const listeners = new Set<Listener>();

/** Hear every answer; the returned function stops listening ([L27]). */
export function onSketchSearchAnswer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hand a decoded `search_sketches_ok` to whoever is listening. */
export function deliverSketchSearchAnswer(answer: SearchSketchesOk): void {
  for (const listener of [...listeners]) listener(answer);
}
