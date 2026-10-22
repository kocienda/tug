/**
 * When the launch's deck is populated: the moment the last body the launch
 * asked for has painted.
 *
 * The shell's own laps close at `frontend-ready`, which is the reveal; the
 * cards are dark for seconds after it while their pages load, and nothing
 * else on record says when they stop being dark. This is the lap that does:
 * once the startup restore pass has settled and no pass is still deciding
 * for a card, and every body card of the shown workspace has painted (or
 * failed, or been evicted — a card that will not paint must not hold the lap
 * open), the shell posts `deck-populated` on its own clock, beside the reveal.
 *
 * It fires once per page: a shell reload is a launch of its own.
 *
 * @module lib/deck-populated
 */

import type { BodyCardState } from "./body-cards-store";

/** The cards the deck holds, as read here. */
export interface PopulatedDeck {
  getSnapshot(): { readonly cards: readonly { readonly id: string; readonly componentId: string }[] };
  subscribe(listener: () => void): () => void;
}

/** What the reading is made from, each a snapshot of its store. */
export interface PopulationReading {
  /** The startup restore pass has settled (`restorePassGate`). */
  readonly passSettled: boolean;
  /** Some pass is still asking the ledger about a card (`restorePassCards`). */
  readonly passPending: boolean;
  /** The body cards the launch waits on. */
  readonly expected: readonly string[];
  /** Each card's body state, null for one not yet handed off. */
  readonly stateOf: (cardId: string) => BodyCardState | null;
}

/** What a launch populated: the pages made, those that failed, and the cards left without one. */
export interface Population {
  readonly bodies: number;
  readonly failed: number;
  readonly unmade: number;
}

/** A body that has painted, or never will on this page's word: either way the launch is not waiting on it. */
function settled(state: BodyCardState | null): boolean {
  return state === "painted" || state === "failed" || state === "evicted";
}

/**
 * Null while the launch is still waiting on a body; once it is not, how many
 * bodies the launch populated, how many of those failed, and how many cards
 * stood without a page — not shown, so none was made, or evicted already.
 */
export function populationOf(reading: PopulationReading): Population | null {
  if (!reading.passSettled || reading.passPending) return null;
  let failed = 0;
  let unmade = 0;
  for (const cardId of reading.expected) {
    const state = reading.stateOf(cardId);
    if (!settled(state)) return null;
    if (state === "failed") failed += 1;
    if (state === "evicted") unmade += 1;
  }
  return { bodies: reading.expected.length - unmade, failed, unmade };
}

/** The body cards a launch asks for: every card of the shown workspace whose kind lives in a body. */
export function launchBodyCards(deck: PopulatedDeck, isBodyKind: (componentId: string) => boolean): string[] {
  return deck
    .getSnapshot()
    .cards.filter((card) => isBodyKind(card.componentId))
    .map((card) => card.id);
}

/** The stores `watchDeckPopulated` reads, passed in so the watch holds no module of its own. */
export interface PopulationSources {
  readonly deck: PopulatedDeck;
  readonly isBodyKind: (componentId: string) => boolean;
  readonly passSettled: () => boolean;
  readonly passPending: () => boolean;
  readonly stateOf: (cardId: string) => BodyCardState | null;
  /** Every store above, subscribed together. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** Call `onPopulated` once, the first time the launch is not waiting on any body; returns the release. */
export function watchDeckPopulated(
  sources: PopulationSources,
  onPopulated: (population: Population) => void,
): () => void {
  let done = false;
  let release: (() => void) | null = null;
  const check = (): void => {
    if (done) return;
    const population = populationOf({
      passSettled: sources.passSettled(),
      passPending: sources.passPending(),
      expected: launchBodyCards(sources.deck, sources.isBodyKind),
      stateOf: sources.stateOf,
    });
    if (population === null) return;
    done = true;
    release?.();
    release = null;
    onPopulated(population);
  };
  release = sources.subscribe(check);
  check();
  return () => {
    done = true;
    release?.();
    release = null;
  };
}
