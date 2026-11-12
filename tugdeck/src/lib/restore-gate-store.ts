/**
 * restore-gate-store — is any session card cold-restoring right now, and
 * how many of the sessions being restored have finished?
 *
 * Every card in the deck shares one main thread in one `WKWebView`. A
 * cold restore's reveal — mounting, laying out, and measuring a whole
 * reconstructed transcript — is a single uninterruptible task on that
 * thread, measured in seconds on a real session. While it runs, nothing
 * in the app answers: not the card restoring, not its neighbours, not
 * the composer you are typing into. The chrome keeps painting its last
 * frame, so the app *looks* live throughout.
 *
 * This store is the reading behind `RestoreGate`, the app-modal that
 * says the app is busy for exactly as long as it is.
 *
 * ## What it counts
 *
 * The modal says "n of N sessions". The open/close rule is unchanged: the
 * gate is open while any card holds it (`deriveRestoreGateHold`). The count
 * is decided by the pure fold in `restore-gate-round.ts`, over rounds. A
 * round opens when the first card holds; its members are the holders then
 * plus every card the restore pass named (`restore-gate-roster.ts`) that is
 * still pending, and that total never changes. A member is done when its
 * hold ends, by any exit — settled, past a horizon, errored — or, never
 * having held, when it has ended without holding; the done count never
 * falls. A round outlives a gate that closes between staged pages while a
 * member is still pending, so the count continues when the gate reopens.
 *
 * Under per-card web views a Session card's session store lives in its
 * body's page, so the shell's services store has none for it. Each body
 * reports its card's restore in its `card.restoreHold`
 * (`body-publisher.ts`, read through `bodyFactsStore.restoreHoldOf`) and the
 * gate folds those reports beside the shell's own stores ([B29] of the
 * bodies migration). A body says `"waiting"` while its restore is still to
 * come and `"holding"` while it holds the gate, which is how the fold tells
 * a session still to come from one that ended without ever holding.
 *
 * ## Who may hold, and for how long
 *
 * A report of `"holding"` is what a body last said, and a body that is not
 * listening says nothing more. A parked workspace's page is made ahead
 * hidden and declared dormant as it paints (`body-make-ahead.ts`), and a
 * dormant body's replay deadlines stop until it is shown
 * (`CodeSessionStore.noteDormant`), so a Session card made ahead inside its
 * resume replay says `"holding"` and then sleeps on it. On 2026-11-09 three
 * such cards in a workspace nobody was looking at raised the modal over the
 * user's work and held it with no end. So a card holds only while it could
 * be the thing the user is waiting on: it is in the shown workspace, its
 * body has a live page, and that body is not dormant.
 *
 * And the gate does not take the reports' word that it should still be up.
 * While it is open it reads every card again each {@link GATE_WATCH_MS} —
 * a poll, by decision, because a modal with no dismiss cannot rest on a
 * notice that may never come — and a card that has said `"holding"` without
 * a break for {@link HOLD_HORIZON_MS} stops counting, whatever it says.
 * That is the shell's own horizon over the card's ([L33]): the replay's
 * silence deadline and the reveal's settle bound end a hold from inside the
 * page, and this ends it when the page cannot.
 *
 * Tuglaws: [L02] — external state with `subscribe`/`getSnapshot`, read
 * through `useSyncExternalStore`; the snapshot is reference-stable
 * across unchanged reads. [L10] — one responsibility (derive the gate);
 * it renders nothing and knows nothing about modality. [L27] — the store
 * is a page singleton whose subscriptions (the roster's among them) last
 * as long as the page, and each per-card store subscription is released
 * when its card leaves the live set.
 *
 * @module lib/restore-gate-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { createSubscribable } from "@/lib/subscribable";

import { cardServicesStore } from "./card-services-store";
import { bodyCardsStore, pageless } from "./body-cards-store";
import { bodyFactsStore } from "./body-facts-store";
import type { CodeSessionStore } from "./code-session-store";
import { getShellDeck } from "./deck-store-registry";
import type { IDeckManagerStore } from "../deck-manager-store";
import { deriveRestoreGateHold } from "@/lib/session-card-restore-gate";
import { restoreGateRoster } from "./restore-gate-roster";
import {
  INITIAL_FOLD,
  foldRestoreGate,
  type RestoreCardFacts,
  type RestoreGateFoldState,
} from "./restore-gate-round";

/** What the gate knows, and what its surface renders. */
export interface RestoreGateSnapshot {
  /** Raise the app-modal. */
  open: boolean;
  /** Sessions in this round whose wait has ended. Never decreases within a round. */
  sessionsDone: number;
  /** Sessions in this round, fixed when it opened. */
  sessionsTotal: number;
}

const CLOSED: RestoreGateSnapshot = {
  open: false,
  sessionsDone: 0,
  sessionsTotal: 0,
};

type Listener = () => void;

/** How often an open gate reads every card again, ms. */
export const GATE_WATCH_MS = 2_000;

/**
 * How long one card may say it holds, without a break, before the gate stops
 * counting it. Measured restores settle in a few seconds, so a hold this old
 * has kept the user out long enough: the card finishes, or fails on its own
 * deadlines, behind an app that answers again.
 */
export const HOLD_HORIZON_MS = 20_000;

class RestoreGateStore {
  private readonly _listeners = createSubscribable();
  private _snapshot: RestoreGateSnapshot = CLOSED;
  private _fold: RestoreGateFoldState = INITIAL_FOLD;
  private _initialized = false;
  /** Per-store unsubscribes for the session stores observed right now. */
  private _storeUnsubs = new Map<CodeSessionStore, () => void>();
  /** When each card now saying it holds began to, on this page's clock. */
  private _heldSince = new Map<string, number>();
  /** The open gate's watch, or null while it is closed. */
  private _watch: ReturnType<typeof setInterval> | null = null;
  /** The deck whose workspace changes are followed, once one is registered. */
  private _deck: IDeckManagerStore | null = null;
  private _releaseDeck: (() => void) | null = null;
  private _now: () => number = () => performance.now();

  subscribe = (listener: Listener): (() => void) => {
    this._ensureInitialized();
    return this._listeners.subscribe(listener);
  };

  /**
   * Take the fold from the shell instead of computing one: the overlay page
   * holds no card, and shows the gate the shell's fold says
   * (`overlay.restoreGate`). A store that has adopted never folds.
   */
  adopt = (next: RestoreGateSnapshot): void => {
    this._initialized = true;
    this._publish(next.open ? { ...next } : CLOSED);
  };

  getSnapshot = (): RestoreGateSnapshot => {
    this._ensureInitialized();
    return this._snapshot;
  };

  /**
   * Observe the services store and, through it, every live card's
   * session store. Lazy so importing this module costs nothing until
   * something reads the gate.
   */
  private _ensureInitialized(): void {
    if (this._initialized) return;
    this._initialized = true;
    cardServicesStore.subscribe(() => this._resync());
    // A body card's session store is in its own page: its body reports the
    // card's cold restore in its facts, and the gate folds that report.
    bodyFactsStore.subscribe(() => this._recompute());
    bodyCardsStore.subscribe(() => this._recompute());
    // The restore pass names the cards it is resuming before their pages
    // exist, which is what fixes a round's total when it opens.
    restoreGateRoster.subscribe(() => this._recompute());
    this._resync();
  }

  /**
   * Re-aim the per-store subscriptions at the current live set, then
   * recompute. Subscribing to the services store alone is not enough —
   * that fires when the live SET changes, not when a member's phase
   * does. A store dropped from the set is unsubscribed: a closed card
   * must not keep this store alive through its listener list.
   */
  private _resync(): void {
    const live = new Set<CodeSessionStore>();
    cardServicesStore.forEachCodeSessionStore((store) => {
      live.add(store);
      if (!this._storeUnsubs.has(store)) {
        this._storeUnsubs.set(store, store.subscribe(() => this._recompute()));
      }
    });
    for (const [store, unsub] of this._storeUnsubs) {
      if (live.has(store)) continue;
      unsub();
      this._storeUnsubs.delete(store);
    }
    this._recompute();
  }

  /**
   * Fold the live set into a snapshot. A card holds by
   * `deriveRestoreGateHold`: the replay window the per-card strip reads
   * (`deriveColdRestoreActive`) plus the reveal behind it, so the gate
   * stays up until the restored transcript is actually on screen. The
   * count over those holders, and over the cards the restore pass named,
   * is `foldRestoreGate`'s.
   */
  private _recompute(): void {
    this._followDeck();
    const now = this._now();
    const saying = new Set<string>();
    const holding = new Set<string>();
    const shellHeld = new Map<string, boolean>();
    cardServicesStore.forEachCodeSessionStore((store, cardId) => {
      const says = deriveRestoreGateHold(store.getSnapshot());
      if (says) saying.add(cardId);
      const held = says && this._mayHold(cardId, now);
      shellHeld.set(cardId, held);
      if (held) holding.add(cardId);
    });
    // Each body card whose body says it is restoring, held as a
    // shell-hosted card is held ([B29] of the bodies migration): the body
    // derives the same `deriveRestoreGateHold`, its own silence deadline
    // errors it there, and the hold goes with the page. A body that is not
    // listening — no page, or dormant — holds nothing, whatever it last said.
    const bodyHeld = new Map<string, boolean>();
    for (const cardId of bodyCardsStore.cardIds()) {
      const says = bodyFactsStore.restoreHoldOf(cardId) === "holding";
      if (says) saying.add(cardId);
      const held =
        says &&
        !pageless(bodyCardsStore.stateOf(cardId)) &&
        bodyFactsStore.factsOf(cardId)?.dormant !== true &&
        this._mayHold(cardId, now);
      bodyHeld.set(cardId, held);
      if (held) holding.add(cardId);
    }
    // A hold's clock runs for as long as the card goes on saying it.
    for (const cardId of this._heldSince.keys()) {
      if (!saying.has(cardId)) this._heldSince.delete(cardId);
    }
    const facts = (cardId: string): RestoreCardFacts => {
      if (bodyCardsStore.has(cardId)) {
        const report = bodyFactsStore.restoreHoldOf(cardId);
        const state = bodyCardsStore.stateOf(cardId);
        return {
          holding: bodyHeld.get(cardId) === true,
          waiting: report === "waiting",
          live: state !== "failed" && state !== "evicted" && state !== "unmade",
          painted: state === "painted",
        };
      }
      const held = shellHeld.get(cardId);
      if (held !== undefined) {
        return { holding: held, waiting: false, live: true, painted: true };
      }
      return { holding: false, waiting: false, live: false, painted: false };
    };
    const { state, reading } = foldRestoreGate(this._fold, {
      holding,
      arrived: restoreGateRoster.take(),
      facts,
    });
    this._fold = state;
    this._publish(reading.open ? reading : CLOSED);
    this._watchWhileOpen(reading.open);
  }

  /**
   * Whether a card saying it holds may: it is in the shown workspace — a
   * restore nobody is looking at keeps nobody waiting — and it has not said
   * so past the horizon. Starts the card's clock on its first call.
   */
  private _mayHold(cardId: string, now: number): boolean {
    let since = this._heldSince.get(cardId);
    if (since === undefined) {
      since = now;
      this._heldSince.set(cardId, since);
    }
    if (now - since >= HOLD_HORIZON_MS) return false;
    const deck = this._deck;
    if (deck === null) return true;
    const spaceId = deck.spaceOf(cardId);
    return spaceId === null || spaceId === deck.getSpacesSnapshot().activeSpaceId;
  }

  /**
   * Follow the registered shell deck's workspaces. The registry is last-wins
   * (`registerShellDeck`), so each fold reads it again: a deck that has been
   * replaced or withdrawn is let go, and its successor followed, rather than
   * the first one found being held for the life of the page.
   */
  private _followDeck(): void {
    const deck = getShellDeck();
    if (deck === this._deck) return;
    this._releaseDeck?.();
    this._releaseDeck = null;
    this._deck = deck;
    if (deck !== null) this._releaseDeck = deck.subscribeSpaces(() => this._recompute());
  }

  /**
   * Read every card again each {@link GATE_WATCH_MS} for as long as the gate
   * is open, and not at all while it is closed. The fold is otherwise moved
   * by notices, and the one that would close the gate is exactly the one a
   * sleeping or stuck page never sends.
   */
  private _watchWhileOpen(open: boolean): void {
    if (open && this._watch === null) {
      this._watch = setInterval(() => this._recompute(), GATE_WATCH_MS);
    } else if (!open && this._watch !== null) {
      clearInterval(this._watch);
      this._watch = null;
    }
  }

  /**
   * Publish when something changed. Reference-stable output is the
   * `useSyncExternalStore` contract — an unchanged read must return the
   * identical object or React re-renders forever.
   */
  private _publish(next: RestoreGateSnapshot): void {
    const prev = this._snapshot;
    if (
      prev.open === next.open &&
      prev.sessionsDone === next.sessionsDone &&
      prev.sessionsTotal === next.sessionsTotal
    ) {
      return;
    }
    this._snapshot = next;
    this._listeners.notify();
  }

  /**
   * Drop the fold and the snapshot, notifying nobody. The store is a module
   * singleton and its round outlives `bodyCardsStore._reset()`, so a test
   * that reuses card ids starts each case here.
   */
  _resetForTest(): void {
    this._fold = INITIAL_FOLD;
    this._snapshot = CLOSED;
    this._heldSince.clear();
    this._watchWhileOpen(false);
    this._releaseDeck?.();
    this._releaseDeck = null;
    this._deck = null;
    this._now = () => performance.now();
  }

  /** Read every card again as the open gate's watch does, at `now` on a clock the test owns. */
  _watchForTest(now: number): void {
    this._now = () => now;
    this._recompute();
  }
}

export const restoreGateStore = new RestoreGateStore();

/** Read the gate in React ([L02]). */
export function useRestoreGate(): RestoreGateSnapshot {
  return useSyncExternalStore(
    restoreGateStore.subscribe,
    restoreGateStore.getSnapshot,
  );
}
