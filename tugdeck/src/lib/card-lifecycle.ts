/**
 * card-lifecycle.ts — Unified card-lifecycle event pipe.
 *
 * Four lifecycle events, fired by the deck at well-defined transitions:
 *
 *   1. Construction  — a card was just added to the deck.
 *   2. Activation    — a card just became the active card.
 *   3. Deactivation  — a card just lost active status, either because
 *                      another card became active or because this
 *                      card is closing while active.
 *   4. Destruction   — a card is about to be removed from the deck.
 *
 * Subscribers (observers) register via `observeCard{Construction,
 * Activation, Deactivation, Destruction}`, filtered by card id or
 * wildcard. React components typically use the hook shorthand:
 * `useOnCard{Construction, Activation, Deactivation, Destruction}`.
 *
 * Timing:
 *   - All four notifications fire SYNCHRONOUSLY at the lifecycle
 *     layer. Subscribers receive the event the instant it happens,
 *     in the same call stack as whatever triggered it.
 *   - React-integrated subscribers (the `useOnCard*` hooks) defer
 *     their user callback via a setState → useEffect pipeline so
 *     side effects (focus moves especially) run AFTER React's
 *     post-commit paint — outside any browser pointer gesture that
 *     might otherwise revert focus changes via the focus-lock
 *     behavior on `preventDefault()`-ed mousedown. This keeps the
 *     subscription itself in `useLayoutEffect` (L03 — installed
 *     before events fire) while pushing the side-effect timing
 *     onto React's deterministic scheduler (L06 — appearance via
 *     DOM/CSS, driven off React-tracked state).
 *   - Non-hook subscribers (e.g., selectionGuard) receive the sync
 *     fire and handle timing themselves if they need to.
 *
 * Invariants:
 *   - Synchronously after `activateCard(cardId)` returns:
 *       - `store.getFocusedCardId() === cardId`
 *       - `manager.getKeyCard() === cardId`
 *       - every direct observer has been notified.
 *   - `notifyCardWillBeginDestruction(cardId)` fires BEFORE the store removes the
 *     card. Subscribers can read state.
 *   - When a close happens on the active card, deactivation fires
 *     before destruction, both sync, then the deck removes.
 *   - ARRIVAL is the one channel that is not an event about the store. A card
 *     the deck OPENS is marked arriving in `addCard`'s own commit and stays
 *     marked until the settle's arrive beat has ended, and
 *     `onceCardDidArrive(cardId, cb)` is how a caller waits for a frame that
 *     has stopped moving. Its rule is FIRE AT ONCE: a card that is not marked
 *     has nothing to wait for, so the callback runs synchronously rather than
 *     taking out a subscription no event will reach ([B05]). Most cards are
 *     never marked — a click-activated card, a card restored at launch, any
 *     card in a window-less host — so the at-once path is the common one, and
 *     it is what lets a caller write one line instead of branching on whether
 *     an arrival happens to be in flight.
 *
 * Observer vs delegate — how to choose:
 *   - `observeCard*(cardId | null, cb)` returns the observer primitive.
 *     Callbacks run SYNCHRONOUSLY in the notify call stack, before any
 *     downstream commit. Use this when you need pre-mutation state
 *     (a `will*` event in a world where the transition hasn't yet
 *     committed), or when you need ordering with other synchronous
 *     observers.
 *   - `useCardDelegate(cardId, delegate)` defers the user callback
 *     onto the `MessageChannel` drain queue. The callback runs AFTER
 *     the commit, past WebKit's gesture focus-lock, and independent of
 *     React's commit scheduling. Use this for React-context-bound
 *     focus/DOM work that must survive gesture (`entryDelegate.focus()`
 *     on `cardDidActivate`, `blur()` on `cardWillDeactivate`). The
 *     `will*` method names describe observer ordering, not delegate
 *     timing — see the note on `TugCardDelegate` below.
 *
 * See design doc §Step 5.5 for the design.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";

/**
 * Module-level toggle for lifecycle trace logs. Defaults to the Vite
 * `import.meta.env.DEV` flag: dev builds print the full will/did →
 * construct/destroy trace; prod builds are silent. Flip to `true` in
 * source to capture a one-off trace without flipping the build mode.
 */
const LIFECYCLE_LOG: boolean = Boolean(import.meta.env?.DEV);

/**
 * Observer callback shape. Receives the id of the card the event
 * applies to. Same value for wildcard subscribers, so callers can
 * route on id without also tracking "am I subscribed to cardId?".
 */
export type CardLifecycleObserver = (cardId: string) => void;

/**
 * Structural contract for the deck store. Typed minimally so tests
 * can inject plain objects without bringing DeckManager's surface
 * area along. Production passes the real DeckManager here.
 */
export interface CardLifecycleStore {
  /** Bring `cardId` to front in the z-order (last in the cards array). */
  focusCard(cardId: string): void;
  /** Current focused card id (top of z-order), or null if no cards. */
  getFocusedCardId(): string | null;
  /**
   * Current composite first-responder: the active stack's active card,
   * or `null` when no stack is active. Used by the app → card cascade
   * to pick the right card to fire deactivate on at app-resign time.
   */
  getFirstResponderCardId(): string | null;
}

/**
 * Structural contract for the responder chain. Typed minimally for
 * the same reason as `CardLifecycleStore`. Production passes the
 * real `ResponderChainManager`.
 */
export interface CardLifecycleManager {
  getKeyCard(): string | null;
  makeFirstResponder(id: string): void;
  /**
   * True when the chain's first responder is `id` or a descendant of
   * `id`. Used by `setResponderChainKey`'s idempotency guard so
   * promoting an already-active card doesn't demote an inner
   * responder (TugTextEditor, etc.).
   */
  firstResponderIsAtOrBelow(id: string): boolean;
}

interface Subscription {
  /** `null` = wildcard (fires on every event of this type). */
  readonly cardId: string | null;
  readonly callback: CardLifecycleObserver;
}

export class CardLifecycle {
  // One subscription set per event channel. Separate sets (rather
  // than a single tagged set) so iteration in notify is straight-
  // forward and subscribers of different types don't interleave.
  private readonly constructionSubs: Set<Subscription> = new Set();
  private readonly willActivateSubs: Set<Subscription> = new Set();
  private readonly activationSubs: Set<Subscription> = new Set();
  private readonly willDeactivateSubs: Set<Subscription> = new Set();
  private readonly deactivationSubs: Set<Subscription> = new Set();
  private readonly willMoveSubs: Set<Subscription> = new Set();
  private readonly didMoveSubs: Set<Subscription> = new Set();
  private readonly willResizeSubs: Set<Subscription> = new Set();
  private readonly didResizeSubs: Set<Subscription> = new Set();
  private readonly destructionSubs: Set<Subscription> = new Set();
  private readonly arrivalSubs: Set<Subscription> = new Set();

  // Tracks which cards have been constructed but not yet destroyed.
  // Used for construction initial-sync: a hook subscribing after
  // the card was already constructed should still fire once.
  private readonly constructedCards: Set<string> = new Set();

  /**
   * Cards the deck has opened whose frames have not finished arriving.
   *
   * A card is marked at `addCard` and unmarked when the settle's ARRIVE beat
   * ends. Membership is the whole of what {@link CardLifecycle.onceCardDidArrive}
   * reads: a card NOT in this set has nothing left to wait for, so a caller
   * that asks about one is answered at once rather than left holding a
   * subscription that no event will ever reach.
   */
  private readonly arrivingCards: Set<string> = new Set();

  private manager: CardLifecycleManager | null;

  constructor(
    private readonly store: CardLifecycleStore,
    manager: CardLifecycleManager | null = null,
  ) {
    this.manager = manager;
  }

  /**
   * Late-bind the responder chain manager. The DeckManager instance
   * is constructed before any ResponderChainProvider mounts; the
   * provider attaches the manager from its mount effect so the
   * lifecycle can promote the key responder on activations.
   *
   * Before the manager is attached, `activateCard` is store-only —
   * it updates z-order and fires observers but skips the responder
   * chain promotion. Once attached, activations flow through both
   * systems.
   */
  setManager(manager: CardLifecycleManager | null): void {
    this.manager = manager;
  }

  /**
   * Promote `cardId` as the responder chain's key card. No-op when no
   * manager is attached, or when the chain's first responder is
   * already inside `cardId`'s subtree (the card is "already active"
   * from the user's perspective).
   *
   * Carved out of `activateCard` so `DeckManager._flipFirstResponder` can
   * promote the responder chain as part of the composite-bit commit
   * without double-firing the will/did lifecycle events.
   *
   * Idempotency: the guard short-circuits when first responder is
   * `cardId` itself OR a descendant of `cardId`. Without this guard a
   * same-pane click that hits `activateCard(activeCardId)` would
   * unconditionally call `makeFirstResponder(cardId)` and demote any
   * inner responder (e.g. a TugTextEditor editor inside the card) — which
   * silently steals keyboard commands the user expects to reach the
   * inner responder. Previous implementation used
   * `manager.getKeyCard() === cardId`, but `getKeyCard()` walks for a
   * node tagged `kind: "card"` (set on the pane stack, not on
   * card-host) so the comparison never matched cardId and the guard
   * never fired. `firstResponderIsAtOrBelow` walks the chain by
   * parentId / id and matches both id-equals and id-as-ancestor.
   */
  setResponderChainKey(cardId: string): void {
    if (this.manager === null) return;
    if (this.manager.firstResponderIsAtOrBelow(cardId)) return;
    this.manager.makeFirstResponder(cardId);
  }

  // ---- Activation (existing behavior) ----

  /**
   * Activate `cardId`. The only sanctioned way to change which card
   * is active.
   *
   * Fires the four lifecycle events in D3 order when the active card
   * changes (A → B):
   *   1. `cardWillDeactivate(A)` — preparation: A can stash state
   *      before the transition commits.
   *   2. `cardWillActivate(B)` — preparation: B can arm itself.
   *   3. Store + responder-chain update: `store.focusCard(B)` and,
   *      if needed, `manager.makeFirstResponder(B)`.
   *   4. `cardDidDeactivate(A)` — reaction: A reacts to the fact.
   *   5. `cardDidActivate(B)` — reaction: B reacts to the fact.
   *
   * All five phases are synchronous at this layer. React-integrated
   * subscribers defer their user callback to React's post-commit
   * useEffect so focus work runs outside the gesture.
   *
   * Same-card re-activation is silent on all four channels.
   *
   * `knownPreviousActive` is an escape hatch for callers that have
   * already mutated the store before calling `activateCard` (e.g.,
   * `DeckManager.addCard` appends the new card to the end of the
   * array, which changes the store's notion of "top-of-stack" to
   * the new card before any lifecycle event has fired; passing the
   * pre-append active id explicitly lets the transition compute
   * against the *pre*-mutation state). When omitted, the store is
   * read as usual.
   */
  activateCard(
    cardId: string,
    knownPreviousActive?: string | null,
  ): void {
    const wasActive =
      knownPreviousActive !== undefined
        ? knownPreviousActive
        : this.store.getFocusedCardId();
    if (wasActive === cardId) {
      // Same-card re-activation: no will/did fires, but still flow
      // through the store (z-order is a no-op; the focused-card-id
      // pointer is refreshed) and ensure the responder chain matches
      // in case it drifted.
      this.store.focusCard(cardId);
      if (this.manager !== null && this.manager.getKeyCard() !== cardId) {
        this.manager.makeFirstResponder(cardId);
      }
      return;
    }
    // Phase 1–2: preparation callbacks — all fire before any state
    // change, per D3 ordering.
    if (wasActive !== null) {
      this.notifyCardWillDeactivate(wasActive);
    }
    this.notifyCardWillActivate(cardId);
    // Phase 3: commit the state transition atomically.
    this.store.focusCard(cardId);
    if (this.manager !== null && this.manager.getKeyCard() !== cardId) {
      this.manager.makeFirstResponder(cardId);
    }
    // Phase 4–5: reaction callbacks.
    if (wasActive !== null) {
      this.notifyCardDidDeactivate(wasActive);
    }
    this.notifyCardDidActivate(cardId);
  }

  // ---- Public notify entry points (called by DeckManager) ----

  /**
   * Fire CONSTRUCTION for `cardId`. Called by the deck after the
   * card has been added to the store. Records the card in the
   * constructed-set so late-subscribing hooks receive initial-sync.
   */
  notifyCardDidFinishConstruction(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardDidFinishConstruction id=${cardId}`);
    this.constructedCards.add(cardId);
    this.fire(this.constructionSubs, cardId);
  }

  /**
   * Fire DESTRUCTION for `cardId`. Called by the deck right BEFORE
   * removing the card from the store so synchronous observers can
   * read state. Also removes the card from the constructed-set.
   *
   * Important timing caveat for `useCardDelegate` consumers: the
   * React delegate hook defers callbacks through a MessageChannel
   * drain queue (see `scheduleDelegateCall`), which runs as the next
   * macrotask. Between the synchronous fire and the deferred drain,
   * the deck removes the card from its store. Delegate callbacks
   * that need the card's pre-destruction state must capture it
   * synchronously in an observer, not from within the deferred
   * `cardWillBeginDestruction` delegate method.
   */
  notifyCardWillBeginDestruction(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardWillBeginDestruction id=${cardId}`);
    this.fire(this.destructionSubs, cardId);
    this.constructedCards.delete(cardId);
    // A card torn down before its frame finished arriving leaves a mark
    // nothing will ever clear, and every later `onceCardDidArrive` for that id
    // would defer forever. The card is going; the arrival is moot.
    this.arrivingCards.delete(cardId);
    // And so are the callers already waiting on it. A one-shot arrival waiter
    // unsubscribes itself when it fires, and this card will never fire: it is
    // leaving the deck, and a cardId is never reused. Nothing else drops the
    // subscription — the canvas's drain reaches only cards the deck still
    // holds, and `_revealAfterArrival` keeps no cancel to run — so a card the
    // reader shuts during its own arrival would leave its waiter in the set
    // for the life of the lifecycle. Wildcard subscribers are not touched:
    // they are about the channel rather than about this card.
    for (const sub of this.arrivalSubs) {
      if (sub.cardId === cardId) this.arrivalSubs.delete(sub);
    }
  }

  /**
   * Mark `cardId` as ARRIVING — its frame is in the DOM but the settle has not
   * finished bringing it on screen.
   *
   * Called by `DeckManager.addCard` inside the commit that appends the pane, so
   * the mark is standing before anything downstream can ask about it. Between
   * this and {@link CardLifecycle.notifyCardDidArrive}, an
   * {@link CardLifecycle.onceCardDidArrive} for this card DEFERS.
   */
  notifyCardWillArrive(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardWillArrive id=${cardId}`);
    this.arrivingCards.add(cardId);
  }

  /**
   * Fire ARRIVAL for `cardId` — the settle's arrive beat has ended and the card
   * is on screen and still.
   *
   * The mark is cleared BEFORE the fire, which is the ordering that matters: a
   * callback that re-enters `onceCardDidArrive` for the same card — a sheet
   * presenting, which activates the card, which observes arrival again — must
   * see a card that has ARRIVED and be answered at once, rather than subscribing
   * against an event that has already been fired.
   *
   * Idempotent by construction: the second call finds nothing in the set, and
   * fires to a channel whose one-shot subscribers have already unsubscribed
   * themselves. That matters because the drain that guarantees the event
   * ([R01]) deliberately calls this for every marked card it can find, from
   * several places, rather than reasoning about which one owns it.
   */
  notifyCardDidArrive(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardDidArrive id=${cardId}`);
    this.arrivingCards.delete(cardId);
    this.fire(this.arrivalSubs, cardId);
  }

  /**
   * Fire WILL-ACTIVATE for `cardId`. Preparation phase: subscribers
   * can prime state before the store transition commits. Called
   * from `activateCard` in the will-phase of a card switch.
   */
  notifyCardWillActivate(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardWillActivate id=${cardId}`);
    this.fire(this.willActivateSubs, cardId);
  }

  /**
   * Fire DID-ACTIVATE for `cardId`. Reaction phase: the store and
   * responder chain already reflect the new active card. Called
   * from `activateCard` after the transition commits, and from the
   * cascade layer when the app returns to the foreground.
   */
  notifyCardDidActivate(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardDidActivate id=${cardId}`);
    this.fire(this.activationSubs, cardId);
  }

  /**
   * Fire WILL-DEACTIVATE for `cardId`. Preparation phase: subscribers
   * can stash state before the store transition commits. Called
   * from `activateCard` in the will-phase of a card switch, and from
   * `removeCard` before closing an active card.
   */
  notifyCardWillDeactivate(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardWillDeactivate id=${cardId}`);
    this.fire(this.willDeactivateSubs, cardId);
  }

  /**
   * Fire DID-DEACTIVATE for `cardId`. Reaction phase: the card has
   * lost active status. Called from `activateCard` after the
   * transition commits, and from `removeCard` after will-deactivate
   * on an active card.
   */
  notifyCardDidDeactivate(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardDidDeactivate id=${cardId}`);
    this.fire(this.deactivationSubs, cardId);
  }

  /**
   * Fire WILL-MOVE for `cardId`. Preparation phase: subscribers can
   * stash state before the position commit. Called by the deck's
   * `moveCard` when the new position differs from the existing one.
   */
  notifyCardWillMove(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardWillMove id=${cardId}`);
    this.fire(this.willMoveSubs, cardId);
  }

  /**
   * Fire DID-MOVE for `cardId`. Reaction phase: the store now reflects
   * the new position. Canonical place to re-assert focus or other
   * side-effects that a move may have disturbed (browser-level focus
   * loss during a drag gesture, etc.).
   */
  notifyCardDidMove(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardDidMove id=${cardId}`);
    this.fire(this.didMoveSubs, cardId);
  }

  /**
   * Fire WILL-RESIZE for `cardId`. Preparation phase: subscribers can
   * stash state before the size commit. Called by the deck's
   * `moveCard` when the new size differs from the existing one.
   */
  notifyCardWillResize(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardWillResize id=${cardId}`);
    this.fire(this.willResizeSubs, cardId);
  }

  /**
   * Fire DID-RESIZE for `cardId`. Reaction phase: the store now
   * reflects the new size. Parallel to `cardDidMove` for the size
   * transition.
   */
  notifyCardDidResize(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardDidResize id=${cardId}`);
    this.fire(this.didResizeSubs, cardId);
  }

  // ---- Observe ----

  /**
   * Subscribe to CONSTRUCTION events. Initial-sync fires for each
   * currently-constructed card matching the subscription (wildcard
   * fires for every live card; specific fires if the card exists).
   * This lets a hook-calling card body receive its own construction
   * event even though the hook subscribes after construction fired.
   */
  observeCardDidFinishConstruction(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.constructionSubs, cardId, callback, (sub) => {
      // Initial-sync: fire for any currently-constructed card
      // matching the subscription.
      for (const constructedId of this.constructedCards) {
        if (sub.cardId === null || sub.cardId === constructedId) {
          this.safeInvoke(sub.callback, constructedId);
        }
      }
    });
  }

  /**
   * Subscribe to WILL-ACTIVATE events. No initial-sync — will-
   * activate is strictly a pre-transition event with no
   * "currently about to activate" state.
   */
  observeCardWillActivate(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willActivateSubs, cardId, callback);
  }

  /**
   * Subscribe to DID-ACTIVATE events.
   *
   * Initial-sync fires synchronously on subscribe when the current
   * active card already matches the subscription (wildcard matches
   * any non-null active; specific matches by id). Mount-time
   * subscribers don't need a separate "read current state" branch —
   * if the card is already active when you subscribe, your callback
   * fires right now.
   */
  observeCardDidActivate(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.activationSubs, cardId, callback, (sub) => {
      const active = this.store.getFocusedCardId();
      if (active !== null && (sub.cardId === null || sub.cardId === active)) {
        this.safeInvoke(sub.callback, active);
      }
    });
  }

  /**
   * Subscribe to ARRIVAL events — every one, for the length of the
   * subscription. No initial-sync: an arrival is a moment rather than a state,
   * and a card that has already arrived has no arrival left to replay.
   *
   * {@link CardLifecycle.onceCardDidArrive} is what a caller waiting on ONE
   * card's arrival wants; this is the wildcard channel, for an observer that
   * wants to see every card land.
   */
  observeCardDidArrive(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.arrivalSubs, cardId, callback);
  }

  /**
   * Run `callback` once `cardId` has finished arriving — AT ONCE when it is not
   * arriving, and otherwise on the next {@link CardLifecycle.notifyCardDidArrive}
   * for it. Returns a cancel.
   *
   * Fire-at-once is the contract and not an optimisation ([B05]). Most cards
   * are never marked at all: a card activated by a click, a card restored at
   * launch, a card in a host with no window. A caller that subscribed and
   * waited in those cases would wait forever, so "is this card arriving?" is
   * asked first and the subscription is only ever taken out when the answer is
   * yes. That is what lets every caller write one line rather than branching on
   * whether an arrival is in flight.
   *
   * The wrapper unsubscribes itself before invoking, so the callback runs
   * exactly once even if a drain fires the arrival twice, and so a callback
   * that itself opens a card cannot re-enter this subscription.
   */
  onceCardDidArrive(cardId: string, callback: () => void): () => void {
    if (!this.arrivingCards.has(cardId)) {
      callback();
      return () => {};
    }
    let cancel = (): void => {};
    let fired = false;
    cancel = this.subscribe(this.arrivalSubs, cardId, () => {
      if (fired) return;
      fired = true;
      cancel();
      callback();
    });
    return cancel;
  }

  /**
   * Mark `cardId` as TRAVELLING — its frame is crossing to a new place and the
   * settle carrying it has not ended.
   *
   * The move's twin of {@link CardLifecycle.notifyCardWillArrive}, over the
   * same mark: what the mark records is "a settle is still carrying this
   * frame", and the canvas's unconditional drain clears it at every settle end
   * whether the beat was an arrival or a crossing. A moved card gets its own
   * name so a call site reads as what it is — a drop is not an arrival.
   */
  notifyCardWillTravel(cardId: string): void {
    if (LIFECYCLE_LOG) console.log(`[CardLifecycle] cardWillTravel id=${cardId}`);
    this.arrivingCards.add(cardId);
  }

  /**
   * Run `callback` once `cardId` has finished travelling — AT ONCE when no
   * settle is carrying it, and otherwise when the settle ends. The move's
   * twin of {@link CardLifecycle.onceCardDidArrive}, with the same
   * fire-at-once contract ([B05]) for the same reason: a host with no canvas
   * never clears the mark, so it is never made there, and the caller writes
   * one line either way.
   */
  onceCardDidTravel(cardId: string, callback: () => void): () => void {
    return this.onceCardDidArrive(cardId, callback);
  }

  /**
   * Subscribe to WILL-DEACTIVATE events. No initial-sync — will-
   * deactivate is strictly a pre-transition event.
   */
  observeCardWillDeactivate(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willDeactivateSubs, cardId, callback);
  }

  /**
   * Subscribe to DID-DEACTIVATE events. No initial-sync — deactivation
   * is strictly a transition event; there is no sensible "currently
   * deactivated" state to replay.
   */
  observeCardDidDeactivate(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.deactivationSubs, cardId, callback);
  }

  /**
   * Subscribe to WILL-MOVE events. No initial-sync — move is strictly
   * transitional, no "currently about to move" state to replay.
   */
  observeCardWillMove(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willMoveSubs, cardId, callback);
  }

  /**
   * Subscribe to DID-MOVE events. No initial-sync.
   */
  observeCardDidMove(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.didMoveSubs, cardId, callback);
  }

  /**
   * Subscribe to WILL-RESIZE events. No initial-sync.
   */
  observeCardWillResize(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willResizeSubs, cardId, callback);
  }

  /**
   * Subscribe to DID-RESIZE events. No initial-sync.
   */
  observeCardDidResize(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.didResizeSubs, cardId, callback);
  }

  /**
   * Subscribe to DESTRUCTION events. No initial-sync — destruction
   * is a one-shot terminal event fired right before removal.
   */
  observeCardWillBeginDestruction(
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): () => void {
    return this.subscribe(this.destructionSubs, cardId, callback);
  }

  /**
   * Current composite first responder (the active pane's active card).
   * The canonical read for "which card is the user in right now?" —
   * see `CardLifecycleStore.getFirstResponderCardId`. Consumers that
   * only want top-of-z-order (which can diverge from the composite bit
   * after detach/move) should read `store.getFocusedCardId()` directly.
   */
  getFirstResponderCardId(): string | null {
    return this.store.getFirstResponderCardId();
  }

  /**
   * Whether `cardId` is currently in the constructed-but-not-destroyed
   * state. True between `notifyCardDidFinishConstruction(cardId)` and
   * `notifyCardWillBeginDestruction(cardId)`, false otherwise.
   *
   * Used by the cascade (`lifecycle-cascade.ts`) to skip reactivation
   * of a card that was destroyed while the app was backgrounded.
   */
  hasConstructed(cardId: string): boolean {
    return this.constructedCards.has(cardId);
  }

  // ---- Internals ----

  private subscribe(
    set: Set<Subscription>,
    cardId: string | null,
    callback: CardLifecycleObserver,
    onSubscribe?: (sub: Subscription) => void,
  ): () => void {
    const subscription: Subscription = { cardId, callback };
    set.add(subscription);
    onSubscribe?.(subscription);
    return () => {
      set.delete(subscription);
    };
  }

  private fire(set: Set<Subscription>, cardId: string): void {
    for (const sub of set) {
      if (sub.cardId === null || sub.cardId === cardId) {
        this.safeInvoke(sub.callback, cardId);
      }
    }
  }

  private safeInvoke(cb: CardLifecycleObserver, cardId: string): void {
    try {
      cb(cardId);
    } catch (err) {
      console.error("CardLifecycle observer threw:", err);
    }
  }
}

// ---- Module-level singleton for cross-provider bootstrapping ----

/**
 * Current process-wide `CardLifecycle` instance, registered by
 * `DeckManager` at construction so providers outside the React tree
 * (notably `ResponderChainProvider`, which needs to call
 * `setManager` from its mount effect before the deck manager
 * context is reachable via hooks) can attach the responder chain
 * manager without threading a prop.
 *
 * Last-registration-wins: mirrors `registerResponderChainManager`
 * in action-dispatch.ts. Intentionally nullable so tests that don't
 * construct a DeckManager see `null`.
 */
let cardLifecycleRef: CardLifecycle | null = null;

export function registerCardLifecycle(lifecycle: CardLifecycle | null): void {
  cardLifecycleRef = lifecycle;
}

export function getCardLifecycle(): CardLifecycle | null {
  return cardLifecycleRef;
}

// ---- React integration ----

/**
 * Context holding the process-wide `CardLifecycle` instance.
 * Consumers outside any provider receive `null` and should no-op
 * cleanly — production always has a provider; tests opt in when
 * they're exercising lifecycle-driven behavior.
 */
export const CardLifecycleContext = createContext<CardLifecycle | null>(null);

export function useCardLifecycle(): CardLifecycle | null {
  return useContext(CardLifecycleContext);
}

/**
 * Delegate protocol for a card's lifecycle events.
 *
 * Apple-style: a single object with optional methods, supplied to
 * `useCardDelegate(cardId, delegate)`. Missing methods are no-ops.
 *
 * Ordering on a card switch A → B (per D3 of the lifecycle-delegates
 * plan): `cardAWillDeactivate` → `cardBWillActivate` → (store +
 * responder updates) → `cardADidDeactivate` → `cardBDidActivate`.
 *
 * Semantic note on the `will*` methods: these names describe the
 * ordering of the underlying synchronous observer — the observer
 * callback on `observeCardWillDeactivate` / `observeCardWillActivate`
 * runs BEFORE the state commit. The delegate hook, by contrast,
 * defers the user callback onto the `MessageChannel` drain queue so
 * it runs on the next macrotask, AFTER the commit has already
 * landed. Consumers that need pre-mutation semantics (reading
 * pre-transition state, ordering with other synchronous work)
 * should subscribe via `observeCard*` directly rather than going
 * through `useCardDelegate`.
 */
export interface TugCardDelegate {
  cardDidFinishConstruction?(cardId: string): void;
  /**
   * Runs AFTER the state transition has committed. Name describes the
   * observer's ordering, not the delegate's. Use `observeCardWillActivate`
   * for pre-mutation state.
   */
  cardWillActivate?(cardId: string): void;
  cardDidActivate?(cardId: string): void;
  /**
   * Runs AFTER the state transition has committed. Name describes the
   * observer's ordering, not the delegate's. Use `observeCardWillDeactivate`
   * for pre-mutation state.
   */
  cardWillDeactivate?(cardId: string): void;
  cardDidDeactivate?(cardId: string): void;
  /**
   * Runs AFTER the position/size mutation has committed. Name describes
   * the observer's ordering, not the delegate's. Use `observeCardWillMove`
   * for pre-mutation geometry.
   */
  cardWillMove?(cardId: string): void;
  cardDidMove?(cardId: string): void;
  /**
   * Runs AFTER the resize has committed. Name describes the observer's
   * ordering, not the delegate's. Use `observeCardWillResize` for
   * pre-mutation size.
   */
  cardWillResize?(cardId: string): void;
  cardDidResize?(cardId: string): void;
  /**
   * Runs AFTER the card has already been removed from the store. By the
   * time this delegate method fires, `store.cards` no longer contains the
   * card. Consumers that need to read the card's pre-destruction data
   * must capture it synchronously via `observeCardWillBeginDestruction`.
   * Refs owned by the card's own components are unaffected — they're
   * held by the consumer, not looked up through the store.
   */
  cardWillBeginDestruction?(cardId: string): void;
}

/**
 * The set of delegate method names the hook routes events to. The
 * discriminator on the pending-event buffer, and the key used to
 * look up the delegate method at drain time.
 */
type CardDelegateMethodName =
  | "cardDidFinishConstruction"
  | "cardWillActivate"
  | "cardDidActivate"
  | "cardWillDeactivate"
  | "cardDidDeactivate"
  | "cardWillMove"
  | "cardDidMove"
  | "cardWillResize"
  | "cardDidResize"
  | "cardWillBeginDestruction";

// ---- MessageChannel-based delegate drain queue ----
//
// Per the lifecycle-delegate-reliability study, delegate callbacks
// defer through a module-scope `MessageChannel` rather than through
// React's `setState → useEffect` commit cycle. The MessageChannel
// drain:
//
//   - Runs as a macrotask (escapes WebKit's gesture focus-lock).
//   - Skips the 4 ms setTimeout clamp and timer-throttling in
//     background tabs.
//   - Is not entangled with React's commit scheduling; closures queued
//     here survive component unmount (the dying card's own
//     `cardWillBeginDestruction` delegate fires reliably — hole H1
//     closed).
//
// The queue is snapshot+cleared on each drain so callbacks that enqueue
// further work run on the next drain, preserving order within a tick
// and preventing runaway reentrant drains.

type DelegateCall = () => void;
const delegateQueue: DelegateCall[] = [];
const delegateChannel: MessageChannel =
  typeof MessageChannel !== "undefined" ? new MessageChannel() : (null as unknown as MessageChannel);

if (delegateChannel !== null) {
  delegateChannel.port1.onmessage = (): void => {
    const pending = delegateQueue.splice(0);
    for (const fn of pending) {
      try {
        fn();
      } catch (err) {
        console.error("[CardLifecycle] delegate callback threw:", err);
      }
    }
  };
}

function scheduleDelegateCall(fn: DelegateCall): void {
  delegateQueue.push(fn);
  if (delegateChannel !== null) {
    delegateChannel.port2.postMessage(null);
  }
}

/**
 * `useCardDelegate` — subscribe a React component to a card's
 * lifecycle as a delegate.
 *
 * Architecture:
 *   - Subscriptions install in `useLayoutEffect` (L03 — event-
 *     dependent setup is ready before events fire). One subscription
 *     per observer channel is installed unconditionally; routing to
 *     a delegate method happens at drain time.
 *   - Observer callbacks enqueue a closure onto the module-scope
 *     `MessageChannel`-backed delegate queue. The drain runs as a
 *     macrotask after the current task completes — past WebKit's
 *     gesture focus-lock, independent of React's commit scheduler.
 *   - The closure captures the delegate ref directly, so the
 *     callback survives component unmount between fire and drain.
 *
 * The delegate object is held in a ref so inline literals don't
 * re-install the subscription on every render. The six observer
 * subscriptions install once per `(lifecycle, cardId)` pair.
 */
export function useCardDelegate(
  cardId: string,
  delegate: TugCardDelegate,
): void {
  const lifecycle = useCardLifecycle();

  // Live delegate ref — avoids re-subscribing when the caller
  // passes an inline object every render.
  const delegateRef = useRef(delegate);
  useLayoutEffect(() => {
    delegateRef.current = delegate;
  }, [delegate]);

  useLayoutEffect(() => {
    if (lifecycle === null) return;
    const enqueue = (
      method: CardDelegateMethodName,
      eventCardId: string,
    ): void => {
      scheduleDelegateCall(() => {
        const fn = delegateRef.current[method];
        if (fn === undefined) return;
        try {
          fn(eventCardId);
        } catch (err) {
          console.error(`useCardDelegate ${method} threw:`, err);
        }
      });
    };
    const unsubs = [
      lifecycle.observeCardDidFinishConstruction(cardId, (id) =>
        enqueue("cardDidFinishConstruction", id),
      ),
      lifecycle.observeCardWillActivate(cardId, (id) =>
        enqueue("cardWillActivate", id),
      ),
      lifecycle.observeCardDidActivate(cardId, (id) =>
        enqueue("cardDidActivate", id),
      ),
      lifecycle.observeCardWillDeactivate(cardId, (id) =>
        enqueue("cardWillDeactivate", id),
      ),
      lifecycle.observeCardDidDeactivate(cardId, (id) =>
        enqueue("cardDidDeactivate", id),
      ),
      lifecycle.observeCardWillMove(cardId, (id) =>
        enqueue("cardWillMove", id),
      ),
      lifecycle.observeCardDidMove(cardId, (id) =>
        enqueue("cardDidMove", id),
      ),
      lifecycle.observeCardWillResize(cardId, (id) =>
        enqueue("cardWillResize", id),
      ),
      lifecycle.observeCardDidResize(cardId, (id) =>
        enqueue("cardDidResize", id),
      ),
      lifecycle.observeCardWillBeginDestruction(cardId, (id) =>
        enqueue("cardWillBeginDestruction", id),
      ),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [lifecycle, cardId]);
}

