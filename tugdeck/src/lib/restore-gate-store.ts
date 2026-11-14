/**
 * restore-gate-store — is any session card cold-restoring right now, and
 * how many of the sessions being restored have finished?
 *
 * A workspace arriving cold — at launch, or on its first visit — is on
 * screen at once, and its resumed sessions are not: each card stands a
 * skeleton while its page is made, its transcript replayed, and the list
 * mounted and measured. The workspace is visible and not yet usable.
 *
 * This store is the reading behind `RestoreGate`, the app-modal that says
 * so: once for each cold arrival, from the moment the restore pass names
 * its cards until the last of them has settled. The gate was written when
 * every card shared one thread and a restore froze the whole app; each
 * card has its own page now, and the gate is kept as the cover for this.
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
 * A resumed card that has not settled holds, whether or not its page
 * exists: one the restore pass named holds from that moment, and its body
 * goes on holding for it while it reports `"waiting"` or `"holding"`. So the
 * gate opens at the cut onto a workspace with such a card, and does not
 * drop between pages made a couple at a time. A named card stops holding
 * when its page has reported and then stopped, has painted having reported
 * nothing, or is not coming — failed, evicted, never asked for. One named
 * over a page that had already painted is handed its resume over the bus,
 * so its paint says nothing and only its report, or the horizon, ends it:
 * the count is told the same, so such a card is a member of its round even
 * while its page, made ahead and still asleep at the cut, holds nothing. A
 * naming lasts {@link HOLD_HORIZON_MS} at most, so a card that never
 * reports cannot keep a round pending.
 *
 * A report is what a body last said, and a body that is not
 * listening says nothing more. A parked workspace's page is made ahead
 * hidden and declared dormant as it paints (`body-make-ahead.ts`), and a
 * dormant body's replay deadlines stop until it is shown
 * (`CodeSessionStore.noteDormant`), so a Session card made ahead inside its
 * resume replay says `"holding"` and then sleeps on it. On 2026-11-09 three
 * such cards in a workspace nobody was looking at raised the modal over the
 * user's work and held it with no end. So a card holds only while it could
 * be the thing the user is waiting on: it is in the shown workspace, and
 * a body that has a page is not dormant.
 *
 * And the gate does not take the reports' word that it should still be up.
 * While it is open it reads every card again each {@link GATE_WATCH_MS} —
 * a poll, by decision, because a modal with no dismiss cannot rest on a
 * notice that may never come — and a card that has held without a break
 * for {@link HOLD_HORIZON_MS}, named, waiting and holding together, stops
 * counting, whatever it says. A card whose page is never made meets the
 * same horizon.
 * That is the shell's own horizon over the card's ([L33]): the replay's
 * silence deadline and the reveal's settle bound end a hold from inside the
 * page, and this ends it when the page cannot.
 *
 * ## The floor
 *
 * Once open, the gate stays on screen until {@link GATE_FLOOR_MS} after it
 * opened. A restore that ends sooner leaves it up for the remainder,
 * reading every session finished; a hold that arrives in that time simply
 * keeps it open; a longer restore gains nothing. One timer, armed at the
 * open and cleared at the close.
 *
 * The floor is the arrival's: it holds a gate that covers cards a restore
 * pass named — a cut onto a workspace, a launch, a reloaded shell. A gate
 * one card raises by resuming on its own — picked from the picker, moved
 * by `/cd`, brought back after its page was lost — closes when that card
 * settles, as it always has: its user is waiting on that one card and
 * types into it the moment it is there.
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
  type RestoreGateReading,
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

/**
 * The least time an open gate stays on screen, counted from when it opened.
 * A gate up for a few hundred milliseconds reads as a flash, not as a
 * message; one up for this long reads as the arrival it covers.
 */
export const GATE_FLOOR_MS = 1_250;

class RestoreGateStore {
  private readonly _listeners = createSubscribable();
  private _snapshot: RestoreGateSnapshot = CLOSED;
  private _fold: RestoreGateFoldState = INITIAL_FOLD;
  private _initialized = false;
  /** Per-store unsubscribes for the session stores observed right now. */
  private _storeUnsubs = new Map<CodeSessionStore, () => void>();
  /** When each card now saying it holds began to, on this page's clock. */
  private _heldSince = new Map<string, number>();
  /** Cards a restore pass named whose restore no page has yet seen through. */
  private _named = new Set<string>();
  /** Cards whose page has said something of their restore. */
  private _reported = new Set<string>();
  /** Named cards whose page had already painted when the pass named them. */
  private _namedPainted = new Set<string>();
  /** When each named card was named, on this page's clock. */
  private _namedAt = new Map<string, number>();
  /** When the gate now shown opened, or null while it is closed. */
  private _openedAt: number | null = null;
  /** The open round's total, kept for the floor's finished reading. */
  private _lastTotal = 0;
  /** The wake-up at the floor, armed at the open and cleared at the close. */
  private _floorTimer: ReturnType<typeof setTimeout> | null = null;
  /** The floor's timer has fired: the floor is over, whatever a coarse clock reads. */
  private _floorDue = false;
  /** The open gate covers an arrival: cards a restore pass named. Only such a gate has a floor. */
  private _arrival = false;
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
    // The cards a restore pass has named since the last fold: the fold
    // counts them, and until each one's page speaks for it they hold.
    const arrived = restoreGateRoster.take();
    for (const cardId of arrived) {
      this._named.add(cardId);
      this._namedAt.set(cardId, now);
      this._reported.delete(cardId);
      // A card named over a page that has already painted is handed its
      // resume over the bus: its paint says nothing of the restore to come.
      if (bodyCardsStore.stateOf(cardId) === "painted") this._namedPainted.add(cardId);
      else this._namedPainted.delete(cardId);
    }
    // Cards a pass named are still to settle: what the gate covers is an arrival.
    const arrival = this._named.size > 0;
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
      const report = bodyFactsStore.restoreHoldOf(cardId);
      const state = bodyCardsStore.stateOf(cardId);
      if (report !== null) this._reported.add(cardId);
      // A card the restore pass named is pending until its page has said
      // something of its restore and then stopped, or has painted saying
      // nothing, or is no longer coming at all.
      if (this._named.has(cardId)) {
        const coming = state !== "failed" && state !== "evicted" && state !== "unmade";
        const over =
          report === null &&
          (this._reported.has(cardId) || (state === "painted" && !this._namedPainted.has(cardId)));
        if (!coming || over) this._named.delete(cardId);
      }
      // Its page says its restore is under way or still to come; or the
      // pass named it and its page has not been made, or has said nothing
      // yet. Either way the user is looking at a card they cannot use.
      const reports = report !== null && !pageless(state);
      const says = reports || this._named.has(cardId);
      if (says) saying.add(cardId);
      const held = says && bodyFactsStore.factsOf(cardId)?.dormant !== true && this._mayHold(cardId, now);
      bodyHeld.set(cardId, held);
      if (held) holding.add(cardId);
    }
    for (const cardId of this._named) {
      if (!bodyCardsStore.has(cardId)) this._named.delete(cardId);
    }
    // A naming has the hold's horizon: past it the card is counted by what
    // its page says, as one no pass named.
    for (const [cardId, since] of this._namedAt) {
      if (this._named.has(cardId) && now - since >= HOLD_HORIZON_MS) this._named.delete(cardId);
      if (!this._named.has(cardId)) this._namedAt.delete(cardId);
    }
    for (const cardId of this._namedPainted) {
      if (!this._named.has(cardId)) this._namedPainted.delete(cardId);
    }
    for (const cardId of this._reported) {
      if (!bodyCardsStore.has(cardId)) this._reported.delete(cardId);
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
          // A paint that came before the pass named the card says nothing of
          // the restore the pass handed it.
          painted: state === "painted" && !this._namedPainted.has(cardId),
        };
      }
      const held = shellHeld.get(cardId);
      if (held !== undefined) {
        return { holding: held, waiting: false, live: true, painted: true };
      }
      return { holding: false, waiting: false, live: false, painted: false };
    };
    const { state, reading } = foldRestoreGate(this._fold, { holding, arrived, facts });
    this._fold = state;
    const shown = this._floor(reading, now, arrival);
    this._publish(shown);
    this._watchWhileOpen(shown.open);
  }

  /**
   * What the gate shows for `reading`: the reading itself while something
   * holds, and for the rest of {@link GATE_FLOOR_MS} after it opened, an open
   * gate reading every session of the round finished. A gate that opened and
   * closed inside a few hundred milliseconds would be a flash of its own, so
   * it closes at the later of its last hold ending and the floor; a long
   * restore gains nothing. Only a gate covering an `arrival` has the floor,
   * counted from when the gate opened whenever the arrival joined it. One
   * timer, armed then and cleared at the close, wakes the store at the
   * floor; the decision reads the clock.
   */
  private _floor(reading: RestoreGateReading, now: number, arrival: boolean): RestoreGateSnapshot {
    if (reading.open) {
      if (this._openedAt === null) this._openedAt = now;
      if (arrival && !this._arrival) {
        this._arrival = true;
        this._floorTimer = setTimeout(() => {
          this._floorTimer = null;
          this._floorDue = true;
          this._recompute();
        }, Math.max(0, GATE_FLOOR_MS - (now - this._openedAt)));
      }
      this._lastTotal = reading.sessionsTotal;
      return reading;
    }
    if (this._arrival && this._openedAt !== null && !this._floorDue && now - this._openedAt < GATE_FLOOR_MS) {
      return { open: true, sessionsDone: this._lastTotal, sessionsTotal: this._lastTotal };
    }
    this._closeFloor();
    return CLOSED;
  }

  private _closeFloor(): void {
    this._openedAt = null;
    this._lastTotal = 0;
    this._floorDue = false;
    this._arrival = false;
    if (this._floorTimer !== null) {
      clearTimeout(this._floorTimer);
      this._floorTimer = null;
    }
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
    this._named.clear();
    this._reported.clear();
    this._namedPainted.clear();
    this._namedAt.clear();
    this._closeFloor();
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
