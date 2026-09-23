/**
 * `liveTurnsStore` — which cards have a turn in flight, as something you can
 * subscribe to.
 *
 * Three callers already answer this question, and all three answer it the same
 * way and at the same moment: walk `cardServicesStore.allServices()`, read each
 * session's `canInterrupt`, act. That is fine for a gesture — the quit pipeline
 * interrupts and moves on — and wrong for a surface, because a surface has to
 * keep being right. The update wizard's *Stop work in flight* row is derived
 * rather than latched: it settles on its own when the user stops the turns in
 * their cards, and it comes back when a new turn starts. A one-shot walk cannot
 * say either.
 *
 * So this store publishes the aggregate the walks were computing by hand — a
 * count and the titles behind it — and republishes it whenever any part of the
 * answer moves: a card added or removed, a card renamed, a session's phase
 * crossing into or out of `canInterrupt`. The snapshot is reference-stable
 * across every notification that leaves the answer unchanged, which is what
 * `useSyncExternalStore` needs to not tear ([L02]) and what keeps a phase tick
 * on some unrelated card from re-rendering a wizard that has nothing new to
 * show.
 *
 * "Live" is the session's own published `canInterrupt` and never a phase test
 * re-derived here — [L28]: the lifecycle owner decides what can be
 * interrupted, and a second opinion would drift from the one that acts.
 *
 * Everything the store reads arrives through {@link LiveTurnsContext}, so the
 * aggregation and the reference stability are reachable from a unit test with
 * no deck, no cards and no wire. The module singleton below is the same class
 * wired to the real deck; {@link attachLiveTurnsDeck} is the one wiring point,
 * called from the boot path beside `cardServicesStore.attachDeckManager`.
 *
 * @module lib/live-turns-store
 */

import { useSyncExternalStore } from "react";
import { cardServicesStore } from "./card-services-store";

/**
 * What the deck looks like from here: cards that may hold a turn, and a way to
 * hear that the set or their titles changed.
 *
 * Structural rather than `DeckManager`, so this module imports no deck and a
 * test can pass a plain object.
 */
export interface LiveTurnsDeck {
  getSnapshot: () => { readonly cards: readonly { id: string; title: string }[] };
  subscribe: (listener: () => void) => () => void;
}

/** One card's contribution to the answer. */
export interface LiveTurnSource {
  /** The card's title, as the user sees it — what the warning line names. */
  readonly title: string;
  /** The session's own `canInterrupt`, read fresh each time ([L28]). */
  readonly isLive: () => boolean;
  /** Observe this session's publications; returns its unregister ([L27]). */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Everything the store needs from the app. `sources` is re-read on every
 * change rather than cached, because a card's title moves under a rename with
 * no session publication to announce it.
 */
export interface LiveTurnsContext {
  /** Every card that could hold a turn, in deck order. */
  sources: () => readonly LiveTurnSource[];
  /** Observe the card set changing — added, removed, renamed. */
  observeSources: (listener: () => void) => () => void;
}

/** The count of cards mid-turn, and their titles in deck order. */
export interface LiveTurnsSnapshot {
  readonly count: number;
  readonly titles: readonly string[];
}

/**
 * The answer when nothing is running — a single frozen value, so the common
 * case is `Object.is`-stable without any comparison at all.
 */
export const NO_LIVE_TURNS: LiveTurnsSnapshot = Object.freeze({
  count: 0,
  titles: Object.freeze([]) as readonly string[],
});

function sameAnswer(
  a: LiveTurnsSnapshot,
  b: readonly string[],
): boolean {
  if (a.count !== b.length) return false;
  for (let i = 0; i < b.length; i += 1) {
    if (a.titles[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The aggregate itself. Subscribes to the card set for its lifetime and holds
 * one subscription per card, rebuilt whenever the set changes — never one per
 * reader, so the cost is the deck's rather than the wizard's.
 */
export class LiveTurnsStore {
  private readonly listeners = new Set<() => void>();
  private readonly sourceUnsubs: Array<() => void> = [];
  private readonly detachSources: () => void;
  private snapshot: LiveTurnsSnapshot = NO_LIVE_TURNS;

  constructor(private readonly context: LiveTurnsContext) {
    this.detachSources = context.observeSources(this.resync);
    this.resync();
  }

  /** [L02] — the subscribe half of the `useSyncExternalStore` contract. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * [L02] — reference-stable between publications. Two reads with no change
   * in between return the same object, so React sees no update.
   */
  getSnapshot = (): LiveTurnsSnapshot => this.snapshot;

  /** Release every subscription this store holds ([L27]). */
  dispose(): void {
    this.detachSources();
    this.releaseSources();
    this.listeners.clear();
  }

  /**
   * The card set moved: drop the per-card subscriptions and take them again
   * from the current set, then re-read.
   *
   * Rebuilding wholesale rather than diffing is deliberate — the set is a
   * handful of cards, and a diff would have to key on something the context
   * deliberately does not expose.
   */
  private resync = (): void => {
    this.releaseSources();
    for (const source of this.context.sources()) {
      this.sourceUnsubs.push(source.subscribe(this.recompute));
    }
    this.recompute();
  };

  private releaseSources(): void {
    for (const unsubscribe of this.sourceUnsubs.splice(0)) unsubscribe();
  }

  private recompute = (): void => {
    const titles: string[] = [];
    for (const source of this.context.sources()) {
      if (source.isLive()) titles.push(source.title);
    }
    if (sameAnswer(this.snapshot, titles)) return;
    this.snapshot =
      titles.length === 0
        ? NO_LIVE_TURNS
        : Object.freeze({ count: titles.length, titles: Object.freeze(titles) });
    for (const listener of [...this.listeners]) listener();
  };
}

// ---- The module singleton, and the one place the deck reaches it ----

const sourceListeners = new Set<() => void>();

function notifySources(): void {
  for (const listener of [...sourceListeners]) listener();
}

let attachedDeck: LiveTurnsDeck | null = null;
let deckUnsub: (() => void) | null = null;
let servicesUnsub: (() => void) | null = null;

/**
 * Wire the singleton to the running deck. Called once from the boot path,
 * beside `cardServicesStore.attachDeckManager` — until it runs, the store
 * answers "nothing is running", which is the truth on a deck with no cards.
 *
 * Idempotent, and re-attachable: a second deck replaces the first's
 * subscription rather than stacking on it.
 */
export function attachLiveTurnsDeck(deck: LiveTurnsDeck): void {
  if (attachedDeck === deck) return;
  deckUnsub?.();
  attachedDeck = deck;
  deckUnsub = deck.subscribe(notifySources);
  // Taken here rather than at module load: touching `cardServicesStore` is
  // what initializes it, and importing this module must not.
  servicesUnsub ??= cardServicesStore.subscribe(notifySources);
  notifySources();
}

/** Undo {@link attachLiveTurnsDeck}. For tests and for a deck teardown. */
export function detachLiveTurnsDeck(): void {
  deckUnsub?.();
  deckUnsub = null;
  servicesUnsub?.();
  servicesUnsub = null;
  attachedDeck = null;
  notifySources();
}

export const liveTurnsStore = new LiveTurnsStore({
  sources: () => {
    const deck = attachedDeck;
    if (deck === null) return [];
    const sources: LiveTurnSource[] = [];
    for (const card of deck.getSnapshot().cards) {
      const services = cardServicesStore.getServices(card.id);
      if (services === null) continue;
      const store = services.codeSessionStore;
      sources.push({
        title: card.title,
        isLive: () => store.getSnapshot().canInterrupt,
        subscribe: (listener) => store.subscribe(listener),
      });
    }
    return sources;
  },
  observeSources: (listener) => {
    sourceListeners.add(listener);
    return () => {
      sourceListeners.delete(listener);
    };
  },
});

/** Read the aggregate from React, the only way external state may enter ([L02]). */
export function useLiveTurns(): LiveTurnsSnapshot {
  return useSyncExternalStore(
    liveTurnsStore.subscribe,
    liveTurnsStore.getSnapshot,
    liveTurnsStore.getSnapshot,
  );
}
