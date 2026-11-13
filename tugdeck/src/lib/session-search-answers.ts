/**
 * session-search-answers.ts — where `search_sessions_ok` frames are heard.
 *
 * CONTROL answers reach a page through the action registry, one handler per
 * action, while the askers are the session-mention providers of however many
 * composers the page holds. This is the fan-out between the two: the registry
 * delivers each decoded answer here, and every provider listens and keeps the
 * one whose request id is its own. It holds no answer — a provider that was
 * not listening when one arrived simply asks again.
 *
 * @module lib/session-search-answers
 */

import type { SearchSessionsOk } from "@/protocol";

type Listener = (answer: SearchSessionsOk) => void;

const listeners = new Set<Listener>();

/** Hear every answer; the returned function stops listening ([L27]). */
export function onSessionSearchAnswer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hand a decoded `search_sessions_ok` to whoever is listening. */
export function deliverSessionSearchAnswer(answer: SearchSessionsOk): void {
  for (const listener of [...listeners]) listener(answer);
}
