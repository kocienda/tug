/**
 * pending-enhancements.ts — the markdown enhancements still in flight.
 *
 * A rendered block is drawn synchronously, and then two passes may still
 * change what it looks like: a fenced block's syntax colouring, whose grammar
 * chunk loads lazily, and math, whose KaTeX engine does. Each is a promise
 * that patches the DOM when it resolves. A live transcript never waits on
 * them; a page that is about to be photographed has to, or the picture shows
 * plain code and raw TeX.
 *
 * So each such pass registers its promise here, and
 * {@link enhancementsSettled} resolves once none is outstanding — including
 * any a resolving pass started in turn. It is the completion signal itself,
 * not a guess at one: no frame, no timer.
 *
 * @module lib/markdown/pending-enhancements
 */

const inFlight = new Set<Promise<unknown>>();

/** Register `work`, a pass that will patch rendered markdown when it settles. */
export function trackEnhancement<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  const done = (): void => {
    inFlight.delete(work);
  };
  work.then(done, done);
  return work;
}

/** How many passes are outstanding now (diagnostics and tests). */
export function pendingEnhancementCount(): number {
  return inFlight.size;
}

/**
 * Resolve once every registered pass has settled, whether it succeeded or
 * not, including passes registered while waiting.
 */
export async function enhancementsSettled(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}
