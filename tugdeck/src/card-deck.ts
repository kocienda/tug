/**
 * CardDeck and DeckView -- the deck a card sees, and the deck a listing card sees.
 *
 * `IDeckManagerStore` is the shell's whole deck: the arrangement, its
 * mutations, and everything a card reads. A card page needs only part of
 * that, and a body page cannot hold the rest, so the interface is split by
 * who may read it:
 *
 * - `CardDeck` is what any card may read and call: its own snapshot,
 *   lifecycle, state bag, focus channels, and the asks it makes of the
 *   arrangement. Every page that draws a card provides one.
 * - `DeckView` adds the reads and asks a card that lists or moves the whole
 *   deck needs (the Layout and Cards cards): spaces, bands and run heights.
 * - `IDeckManagerStore` extends `DeckView` with the arrangement's own
 *   mutations, and only the shell holds it.
 *
 * `DeckManager` implements all three by construction.
 */

import type { DeckState, CardStateBag } from "./layout-tree";
import type { SpacesSnapshot } from "./spaces";
import type { CardLifecycleObserver } from "./lib/card-lifecycle";
import type { ComponentStatePreservationRegistry } from "./components/tugways/component-state-preservation-registry";
import type { CardAssembler } from "./card-state-orchestrator";
import type { CommitLanding, SaveCallbackSource } from "./deck-trace";
import type { EngineHooks } from "./deck-manager-store";

/**
 * The deck a card sees. Conforms to the useSyncExternalStore contract.
 */
export interface CardDeck {
  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * Must be an arrow property (stable identity, auto-bound this)
   * so it can be passed directly to useSyncExternalStore without .bind().
   *
   * The callback receives the commit's {@link CommitLanding} — how the
   * mutation says it wants to land, declared at the call site rather than
   * reconstructed downstream ([B01]). A subscriber that only wants to know
   * *that* something changed takes no argument and is unaffected, which is
   * every subscriber but the settle.
   */
  subscribe: (callback: (landing: CommitLanding) => void) => () => void;

  /**
   * Subscribe on the commit's OWN task. `subscribe` above is told one painted
   * frame later ([D204]); a subscriber that must see the commit before React
   * does takes this door.
   *
   * **What may ride it ([B04]).** The door is for DOM writers and for readers
   * of the flip's edge — facts that are only visible from inside the commit,
   * because a bit's standing value a task later says nothing about whether it
   * moved. Anything on it that reaches REACT does so through the same door
   * React is told through, `scheduleAfterPaint`; a React-visible write made
   * here re-renders the canvas inside `transferFocusForActivation`'s
   * `flushSync`, and the canvas then reads the deck's new snapshot and runs
   * the whole Last pass in the click task ([F05]).
   *
   * The eight subscribers, audited against that rule:
   *
   * - `canvas-arm` (`settle-engine.ts`) — measures and writes the DOM, and
   *   keeps its own refs. It makes no React write of its own, but on a
   *   RETARGET it calls `flushPendingNotify` ([B01]), which votes the commit
   *   it is being told about undeferred so React is told inline at the end of
   *   this task — the one place a sync subscriber reaches React deliberately,
   *   and the reason the Last pass can run after the restores and still land
   *   before paint.
   * - `selection-guard` (`selection-guard.ts`) — installs a `mousedown`
   *   interceptor and repaints its overlay. DOM only.
   * - `pane-raise` (`pane-stacking.ts`) and `pane-focus`
   *   (`pane-focus-controller.ts`) — write each shown frame's inline
   *   `z-index` and `data-focused` from the store, so a press whose React
   *   commit is deferred brings its pane forward and lights it in the press's
   *   own frame. DOM only; React later renders the same `z-index`.
   * - `destination-flip` (`deck-trace.ts`) — appends to the trace ring, which
   *   has no React subscribers.
   * - `test-surface` (`test-surface.ts`) — increments a local counter inside
   *   one probe.
   * - `cards-selection` (`cards-selection-store.ts`) — reads the
   *   first-responder transition here and takes the after-paint door for
   *   BOTH its React-visible writes — the `pickOnly` on a collapse and the
   *   `pruneTo` on every commit ([B02]) — which are the rule's two worked
   *   examples. What stays on this task is the READ of the card list.
   * - `key-card` (`responder-chain-provider.tsx`) — the exception, and it is
   *   deliberate. `focusManager.setKeyCard` notifies React subscribers, so
   *   the deferral rule would otherwise apply. What it cannot be deferred
   *   for is the activation paths that DO NOT run the focus transfer:
   *   `activateCard` (`deck-manager.ts` 1907) flips the first responder
   *   directly, and its callers at 1538, 1867, 3031, 3087 and 7056 — plus
   *   the cold-boot seed, where `syncKeyCard` is called once at mount — never
   *   reach `transferFocusForActivation`. On those paths this subscriber is
   *   the ONLY writer of the key card, and a deferral would leave the focus
   *   manager naming the card that was active before the commit for a frame.
   *   (It is NOT needed by `applyBagFocus`: that calls `adoptKeyCard` with
   *   the incoming id, and `adoptKeyCard` (`focus-manager.ts` 2708) opens
   *   with `this.setKeyCard(cardId)` — so the transfer writes the key card
   *   itself and never reads what this subscriber wrote.) It is a writer of
   *   structural focus state rather than of a deck view, and the cost it can
   *   add to the flush is one focus-manager projection. Its React notify is
   *   held by the gesture scope like any other store's, so only a
   *   `flushSync` or `tellReactNow` releases it before the gesture's paint.
   */
  subscribeSync?: (callback: (landing: CommitLanding) => void, label?: string) => () => void;

  /**
   * Deliver the deferred notification NOW, synchronously. A caller
   * whose next line reads DOM that only React's commit produces — a tab
   * switch's `display: contents`, a new pane's host — calls this inside its
   * `flushSync` so the contract "DOM consistent after the commit" holds.
   *
   * Called from a SYNCHRONOUS subscriber, where the commit being told about
   * has not scheduled its deferral yet, it instead votes that commit
   * undeferred: the store tells React inline at the end of the same task.
   * The canvas's `arm` is that caller, on a retarget ([B01]).
   */
  flushPendingNotify?: () => void;

  /**
   * Return the current DeckState snapshot: the STANDING deck, which never
   * holds a departing pane, so a reader that lists or counts is right by
   * default. Must be an arrow property (stable identity, auto-bound this).
   */
  getSnapshot: () => DeckState;

  /**
   * The composed picture: the standing deck with every departing pane, its
   * cards and the `departing` marks composed back in for the settle that
   * carries it out (`lib/departing.ts`). Read only by what draws the deck —
   * the canvas, the settle engine, the place facts and slot badge a departing
   * card's own content shows — each named in `departing-invisibility.test.ts`'s
   * allow list. The standing deck when nothing departs. Arrow property, and
   * the same object across calls until either half changes; notified through
   * {@link subscribe}.
   */
  getPicture: () => DeckState;

  /**
   * Return the current state version (monotonically increasing integer).
   * Must be an arrow property (stable identity, auto-bound this).
   */
  getVersion: () => number;

  /**
   * Commit the height a modal surface standing on `memberId` has stated it
   * needs, or drop the claim with a `null` height. `memberId` is the member
   * the way `placeMembers` names it — a pane id for a column member, a
   * componentId for a rail one.
   *
   * On the store because the claim is deck state: the place's allocator reads
   * it as the member's floor for as long as the sheet is up, and it is
   * session-only, so nothing the user did is written over to honour it.
   */
  setSheetReservation: (memberId: string, height: number | null) => void;

  /**
   * Write `memberId`'s opening bid, or drop it with a `null` height.
   * Keyed exactly as {@link IDeckManagerStore.setSheetReservation} above is.
   *
   * The reservation's neighbour: both are floors the larger of which binds
   * ([B01]), and what separates them is where the number came from and how
   * long it lives. A reservation is measured off a sheet that is on screen; a
   * bid is declared before the card was laid out and is cleared by the first
   * such measurement ([B02]). Session-only for the reservation's reason.
   */
  setOpeningBid: (memberId: string, height: number | null) => void;

  /** Stable bound callback: close a pane (and all of its cards). */
  handlePaneClosed: (paneId: string) => void;

  /**
   * Promote a card's host pane to the top of the `panes` array (highest
   * z-index) and persist the card id for reload restoration. Does NOT
   * fire lifecycle events — pair with `activateCard` when handling a
   * user gesture that should also drive the responder chain.
   */
  focusCard: (cardId: string) => void;

  /**
   * Make `cardId` the first responder — flip the composite bit
   * `(activeWindow?.activeCardId)` to point at `cardId`, fire the
   * will/didDeactivate + will/didActivate lifecycle events, promote
   * the card as the responder chain's key card, bump its host window's
   * z-order, and persist the focused-card pointer for reload
   * restoration. No-op when `cardId` is already the first responder
   * (same-bit calls still refresh the persisted pointer and the
   * responder chain in case it drifted).
   *
   * `reveal: false` declines the strip reveal the commit would otherwise
   * ride — the minimal slide of a flow band, an overflowing column, or an
   * overflowing rail that brings the member fully in. The POINTER passes
   * it: the hand is already on the card it named, and a strip that slides
   * under a press moves the title bar out from under the mouse that is
   * still holding it. Every other arrival (keyboard, a chord, a
   * programmatic raise) reveals, because there the reader asked to be
   * taken to a card they may not be looking at.
   */
  activateCard: (cardId: string, opts?: { reveal?: boolean }) => void;

  /**
   * Slide whatever strip the pane hosting `cardId` rides by the least that
   * shows the pane fully — the reveal an activation commits, on its own, and
   * nothing when the pane is already fully in. The pointer's CLICK ends here:
   * the press activated with `reveal: false` so nothing moved under the
   * hand, and a release that travelled nowhere is the moment the reader has
   * let go and the deck may bring the card in. A release that travelled is a
   * drag, and the drop's own commit answers for it instead.
   */
  revealCard: (cardId: string) => void;

  /**
   * {@link revealCard}, for a question about to be asked of the card: answers
   * how long the travel it started runs, in milliseconds, zero when nothing
   * moved. Present on a card's own page, whose deck's strip is the shell's
   * to slide; the shell's own title bar reads its canvas instead.
   */
  revealForQuestion?: (cardId: string) => Promise<number>;

  /**
   * Read the composite first-responder bit: the active pane's
   * active card id, or `null` when no pane is active. At any
   * moment, exactly zero or one card is the first responder.
   */
  getFirstResponderCardId: () => string | null;
  /**
   * The card a following card follows, when this store knows it rather than
   * the page's focus manager: a body's bridge, whose focus manager holds its
   * one card, answers what the shell's says. Absent on the deck itself;
   * `useTrackFollowedCard` then tracks the focus manager as it always has.
   * Changes notify through {@link IDeckManagerStore.subscribe}.
   */
  getFollowedCardId?: () => string | null;

  /**
   * Subscribe to card CONSTRUCTION events. Fires per card when
   * `deck.addCard` completes; initial-sync fires for each
   * already-constructed card matching the subscription.
   */
  observeCardDidFinishConstruction: (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ) => () => void;

  /**
   * Subscribe to card ACTIVATION events. `cardId === null` is a
   * wildcard (every activation); `cardId === "X"` is specific.
   * Fires synchronously on subscribe if the subscription matches
   * the currently-active card. Returns an unsubscribe function.
   */
  observeCardDidActivate: (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ) => () => void;

  /**
   * Subscribe to card DEACTIVATION events — fires when a card loses
   * active status, either to a subsequent activation or to closure
   * while active. No initial-sync.
   */
  observeCardDidDeactivate: (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ) => () => void;

  /**
   * Subscribe to card DESTRUCTION events. Fires once, synchronously,
   * right before the card is removed from the deck. Subscribers can
   * still read state. No initial-sync.
   */
  observeCardWillBeginDestruction: (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ) => () => void;

  /** Subscribe to MOVE events: a card's pane committed a new position. No initial-sync. */
  observeCardDidMove: (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ) => () => void;

  /** Subscribe to RESIZE events: a card's pane committed a new size. No initial-sync. */
  observeCardDidResize: (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ) => () => void;

  /**
   * Add a new card from the registry, wrapped in a new single-card
   * window at the default position. Returns the generated card id,
   * or null if no registration is found for `componentId`.
   *
   * `initialContent`, when provided, seeds the new card's
   * `CardStateBag.content` before the commit so the card mounts
   * through the restore path with the payload in hand (parameterized
   * openers like `open-file`).
   *
   * `options.origin` names the card the gesture was made in; under a
   * multi-slot arrangement the deck ranks the new card's slot from it, from
   * the first responder when it holds no slot, and from the deck otherwise.
   * `options.opening: "bound"` says the caller binds the card in the same
   * gesture, so the form its registration declares for an unbound opening
   * is neither readied nor measured and the card lands in the call.
   *
   * A card whose registration declares an opening form with something to
   * make ready lands a moment AFTER this returns — once the form is ready to
   * be measured — and the id is the caller's from the return either way.
   *
   * `options.cardId` is the id the new card takes, minted by the caller so it
   * holds the id before the card lands; omitted, the deck mints one.
   */
  addCard: (
    componentId: string,
    initialContent?: unknown,
    options?: { origin?: string | null; opening?: "bound"; cardId?: string },
  ) => string | null;

  /**
   * Show a card type as a singleton: activate the existing card with
   * this `componentId` (raising its pane to z-top) if one exists, else
   * add a fresh one. Returns the reused or new card id, or null if
   * `componentId` is unregistered.
   */
  showSingletonCard: (componentId: string) => string | null;


  /**
   * Add a new card to an existing pane. Returns the new card id, or
   * null if the pane or registration is not found. The new card
   * becomes the pane's active card.
   *
   * `initialContent`, when provided, seeds the new card's
   * `CardStateBag.content` before construction so the card mounts
   * through the restore path with the payload in hand — the same
   * channel `addCard` uses for parameterized openers (e.g. open-file's
   * "new tab in frontmost card" target).
   */
  addCardToPane: (
    paneId: string,
    componentId: string,
    initialContent?: unknown,
  ) => string | null;

  /**
   * Remove a card. If the card was the last card in its pane, the
   * pane is removed entirely. (Renamed from `removeTab`.)
   */
  removeCard: (paneId: string, cardId: string) => void;

  // ---- Phase 5f: Per-card state cache and focus persistence () ----

  /**
   * Read a per-card state bag from the in-memory cache. Returns
   * `undefined` when there is no cached state for the card.
   */
  getCardState: (cardId: string) => CardStateBag | undefined;

  /**
   * Write a per-card state bag to the in-memory cache and schedule a
   * debounced tugbank write (fire-and-forget).
   */
  setCardState: (cardId: string, bag: CardStateBag) => void;

  /**
   * Capture a card's current bag and persist it durably *now*, bypassing
   * the debounce. Used by surfaces whose state must reach tugbank the
   * instant it changes rather than 500 ms later — the prompt entry calls
   * it on submit so the cleared draft is durable immediately and a crash
   * or relaunch in the debounce window can't resurrect the just-sent
   * message. Uses a `keepalive` PUT so the write outlives an
   * immediately-following teardown. Optional — only the concrete
   * `DeckManager` implements it; test doubles may omit it, so callers
   * invoke it optionally. [L23].
   */
  flushCardStateNow?: (cardId: string) => void;

  /**
   * Suspend debounced card-state saves for the duration of a batch load,
   * returning a disposer that resumes them. A card mid-load holds this so
   * the [A9] persistence flush never fetches per dirty card while the load
   * settles. Optional — only the concrete `DeckManager` implements it; test
   * doubles may omit it, so callers invoke it optionally.
   */
  suspendCardStateSaves?: () => () => void;

  /** Which space holds `cardId`, active or parked — `null` when none does. */
  spaceOf: (cardId: string) => string | null;

  // ---- Phase 5f3: Save callbacks for close-time state flush ([D01]) ----

  /**
   * Register a save callback associated with the given ID (typically a
   * cardId). The callback is invoked by DeckManager on visibilitychange
   * (hidden) and beforeunload to capture state before the page is
   * discarded. Registration should happen in useLayoutEffect (Rule of
   * Tugways #3) so the callback is registered before any events that
   * may depend on it fire.
   */
  registerSaveCallback: (
    id: string,
    callback: (source?: SaveCallbackSource) => void,
  ) => void;

  /**
   * Unregister the save callback for the given ID.
   * Called in the cleanup of the useLayoutEffect that registered it.
   */
  unregisterSaveCallback: (id: string) => void;

  /**
   * Invoke the save callback registered under the given ID, if any. Used by
   * callers that need to trigger a specific save synchronously (e.g., save
   * outgoing card's state before switching to a new active card). No-op when
   * no callback is registered.
   *
   * The optional `source` parameter tags the triggering path for the
   * deck-trace; live callers always pass a source, but the parameter
   * is optional on the interface for backward compatibility with test
   * mocks that predate the trace. Implementations that see
   * `source === undefined` default to `"manual"`.
   */
  invokeSaveCallback: (id: string, source?: SaveCallbackSource) => void;

  /**
   * Return the per-card Component State Preservation Protocol registry
   * ([D13], [A9]) for `cardId`, creating it lazily on first call. Used
   * by `useComponentStatePreservation` to register capture/restore
   * closures and by the framework orchestration layer at save/restore
   * time.
   */
  getComponentStatePreservationRegistry: (cardId: string) => ComponentStatePreservationRegistry;

  /**
   * Look up a card's component state preservation registry without
   * creating one. Returns `undefined` when the card has never
   * registered an opt-in component. Used by the capture/restore
   * orchestration so a non-participating card incurs no allocation.
   */
  peekComponentStatePreservationRegistry: (
    cardId: string,
  ) => ComponentStatePreservationRegistry | undefined;

  /**
   * Register a card-level assembler with the framework orchestrator
   * ([A9c]). `CardHost` calls this from a `useLayoutEffect` and uses
   * the returned unregister function for cleanup. The orchestrator
   * invokes the assembler's `capture()` for every save trigger
   * (will-phase, close-before-destroy, `saveState` RPC), layering
   * component-level state on top to produce the full `CardStateBag`.
   */
  registerCardAssembler: (
    cardId: string,
    assembler: CardAssembler,
  ) => () => void;

  /**
   * Capture the full bag for `cardId` via the orchestrator. Every save
   * trigger (debounced save callback, close-before-destroy flush,
   * `saveState` RPC) flows through this entry point so `bag.components`
   * lands alongside framework-owned axes by construction.
   *
   * `source` names the triggering path and is forwarded to the card's
   * assembler, so a card can capture differently for the app's own
   * termination than for a steady-state save.
   */
  captureCardState: (cardId: string, source?: SaveCallbackSource) => CardStateBag;

  // ---- Focus-transfer channels (focus-transfer.ts seam) ----

  /**
   * Register a content factory's `onCardActivated` callback for
   * `cardId`. Returns an unregister function. Last-registration-wins
   * per cardId: content factories re-register on every mount, and
   * the previous registration is displaced. Passing an unregister
   * function back rather than exposing a mirror `unregister…`
   * method keeps the registration / cleanup pair colocated in the
   * caller's `useLayoutEffect`. No-op unregister is safe to call
   * more than once.
   */
  registerActivationCallback: (
    cardId: string,
    callback: () => void,
  ) => () => void;

  /**
   * Fire the registered activation callback for `cardId`. Silently
   * no-ops when no callback is registered (the card may be
   * DOM-authority, may not have mounted yet, or may have
   * unregistered). Callers are expected to have passed
   * {@link resolveActivationTarget} and received
   * `{ kind: "dispatch-activated" }` before reaching here.
   *
   * `dispatchedFrom` tags the activation gesture-source for the
   * `engine-activation-dispatched` deck-trace event (recorded
   * inside the implementation, not the callback body). Use one
   * of the entry-point names from `focus-transfer.ts`:
   * `"transfer-for-activation"` (rows 1–3 — intra-pane / pane-chrome
   * / tab-close), `"transfer-after-move"` (row 4 — drag drop or
   * cancel), `"reactivate-current"` (row 5 — app-lifecycle return).
   */
  invokeActivationCallback: (cardId: string, dispatchedFrom: string) => void;

  /**
   * Register a deactivation callback for `cardId`. Returns an
   * unregister function. Mirror image of
   * {@link registerActivationCallback}: fires when the card is about
   * to lose focus-destination status, so the consumer can hand its
   * selection over to the inactive-paint channel before the new
   * active card claims focus + global Selection. [L23] enforcement.
   */
  registerDeactivationCallback: (
    cardId: string,
    callback: () => void,
  ) => () => void;

  /**
   * Fire the registered deactivation callback for `cardId`. Silently
   * no-ops when no callback is registered. Called by
   * `transferFocusForActivation` ahead of activation transitions so
   * the previously-active card can route its selection to
   * `selectionGuard` (via `paintMirrorAsInactive`) before the new
   * active card's `setSelectedRange` runs `removeAllRanges()` on the
   * global Selection. [L23].
   */
  invokeDeactivationCallback: (cardId: string, dispatchedFrom: string) => void;

  /**
   * Register the live `[data-card-host][data-card-id="…"]` DOM
   * element for `cardId`. `CardHost` calls this from a callback-ref
   * composed with a `useLayoutEffect` so the registry is populated
   * before any activation event can fire. Passing `null` unregisters
   * the current entry — used both by the cleanup path and by the
   * re-registration branch when the DOM node identity changes
   * mid-session (e.g. cross-pane move when CardPortal's reconciler
   * swaps the subtree rather than moving in place).
   */
  registerCardHostRoot: (cardId: string, el: HTMLElement | null) => void;

  /**
   * Read the registered card-host root element without creating or
   * mutating anything. Returns `null` when no root is currently
   * registered (card unmounted or never mounted). Used by
   * {@link resolveActivationTarget} to scope DOM lookups to the
   * one subtree that belongs to `cardId`.
   */
  peekCardHostRoot: (cardId: string) => HTMLElement | null;

  // ---- Engine hooks (Phase E.11 single-channel dispatcher seam) ----

  /**
   * Register an engine's `paintMirrorAsActive` / `paintMirrorAsInactive`
   * hooks for `cardId`. Returns an unregister function.
   * Last-registration-wins per cardId.
   *
   * The engine becomes a **callable** the framework's
   * `applyBagFocus` dispatcher invokes when `bag.focus.kind === "engine"`,
   * NOT an autonomous focus claimant. Step 2 adds the channel
   * (additive, no consumer yet); Step 3 wires `applyBagFocus` to
   * call `invokeEnginePaintMirrorAsActive` / `invokeEnginePaintMirrorAsInactive`
   * and retires the engine's autonomous claim in
   * `useCardStatePreservation.onCardActivated` / the `isActive` branch
   * of `onRestore`. See `tuglaws/state-preservation.md`
   * [Focus dispatch model].
   *
   * Registration bumps the deck-manager's `callbacksVersion` axis
   * so `CardHost`'s `useLayoutEffect` that depends on it re-fires —
   * this lets Step 4's `deferred-engine` retry settle when the
   * engine mounts late (dev's transcript loads messages async after
   * cold-boot; the editor that owns engine focus mounts at that
   * later point). Same axis the state-preservation callbacks use,
   * so the existing re-fire wiring covers this without a new
   * subscription.
   *
   * `TugTextEditor` registers via `useLayoutEffect` keyed on
   * `[store, cardId]`; the closure reads `viewRef.current` live at
   * fire time per [L07], so the closure's identity is stable across
   * re-renders.
   */
  registerEngineHooks: (
    cardId: string,
    hooks: EngineHooks,
  ) => () => void;

  /**
   * Invoke the registered engine's `paintMirrorAsActive` for
   * `cardId`. Silently no-ops when no hooks are registered (engine
   * not mounted yet, card is DOM-authority, hooks unregistered).
   * Phase E.11 Step 3 wires `applyBagFocus` to this method for the
   * `engine` resolution kind; until then this method exists but is
   * never called from the framework dispatcher.
   */
  invokeEnginePaintMirrorAsActive: (cardId: string) => void;

  /**
   * Mirror invocation for `paintMirrorAsInactive`. Silently no-ops
   * when no hooks are registered. The `publish` callback the engine
   * needs to route inactive-selection through `selectionGuard` is
   * captured by the engine's own hook closure at registration time
   * (it has the cardId baked in), so this method takes only the
   * cardId; the hook is parameterless from the dispatcher's side.
   */
  invokeEnginePaintMirrorAsInactive: (cardId: string) => void;

  /**
   * `true` when an engine has currently-registered hooks for
   * `cardId`. Used by `resolveBagFocus` (focus-transfer.ts) to
   * discriminate `engine` (engine ready — invoke now) from
   * `deferred-engine` (engine mounts late — return `"deferred"`
   * so Step 4's `subscribeEngineHooksChange` retry fires when the
   * engine registers). Pure read; no side effects.
   */
  hasEngineHooks: (cardId: string) => boolean;

  /**
   * Subscribe to engine-hook registration events for `cardId`.
   * Listener fires after every `registerEngineHooks` registration
   * (including last-write-wins re-registrations) and after the
   * unregister cleanup. Returns an unsubscribe function.
   *
   * `CardHost` uses this in a `useLayoutEffect` to drive the
   * `deferred-engine` retry path: when an engine mounts late
   * (dev's editor renders after `feedsReady`), its
   * `registerEngineHooks` call fires the listener, which bumps
   * CardHost's `callbacksVersion`-equivalent dep and re-fires the
   * cold-boot RESTORE effect through `applyBagFocus`.
   */
  subscribeEngineHooksChange: (
    cardId: string,
    listener: () => void,
  ) => () => void;

  /**
   * Interrupt every session with a turn in flight and wait, bounded, for each
   * to settle. Resolves with the sessions that acknowledged and the ones that
   * did not; never rejects and never waits indefinitely.
   *
   * On the interface because it has a caller outside the quit pipeline that
   * owns it: the update wizard's *Stop work in flight* row. "Live" is each
   * session's own published `canInterrupt` ([L28]), so a caller here re-derives
   * nothing and cannot drift from the implementation that acts.
   */
  interruptLiveSessions: () => Promise<{
    interrupted: string[];
    unacknowledged: string[];
  }>;
}

/**
 * The deck a card that lists or moves the whole deck sees: `CardDeck` plus
 * the spaces, the bands and the asks that rearrange them.
 */
export interface DeckView extends CardDeck {

  /**
   * The band the arrangement is laid across, in px, or `null` when there is
   * none to report. Layout-independent — fit spreads across it and flow slides
   * under it, but it is one measurement. A measurement of the canvas rather
   * than a fact in `DeckState`, which is why it is a method and not a field of
   * the snapshot.
   */
  getBandWidth: () => number | null;
  getColumnRunHeight: () => number | null;
  /** The same run under the other place's name — a rail and a column divide
   *  one vertical extent. */
  getRailRunHeight: () => number | null;
  setFlowOffset: (offset: number, landing?: CommitLanding) => void;

  /**
   * Draw the deck at a flow offset without committing it — the per-frame half
   * of a scrub, and the one writer of it ([P11]). It writes the property the
   * imposed frames read and publishes the fraction the instruments read, and
   * touches no state at all.
   *
   * On the store rather than in the canvas because the strip that scrubs is in
   * the LAYOUT CARD while the element the offset is written on is the canvas's: two
   * implementations would be two clamps and two chances to disagree.
   */
  previewFlowOffset: (offset: number) => void;

  // ---- The spaces store: the level above the deck ([P03], [L02]) ----

  /**
   * Subscribe to changes in the SPACE LIST — added, renamed, removed,
   * reordered, activated. Not to changes inside a deck; those are
   * {@link subscribe}'s. Arrow property, for {@link getSpacesSnapshot}'s
   * reason.
   */
  subscribeSpaces: (callback: () => void) => () => void;

  /**
   * The space list's identities and order, and which one is active. Stable by
   * identity until the list changes, as `useSyncExternalStore` requires.
   */
  getSpacesSnapshot: () => SpacesSnapshot;

  /**
   * That space's deck — the LIVE one for the active space, its parked record
   * for any other — or `null` when no space has that id. The one read that
   * lets a surface draw a workspace nobody is looking at.
   */
  getSpaceDeck: (spaceId: string) => DeckState | null;

  /**
   * Render that space's deck, parking the one on screen ([P04]). A no-op on
   * the active space and on an id no space carries.
   *
   * Never a close: nothing in the switch fires card destruction, so every
   * session in the outgoing workspace keeps its binding and its process
   * ([B05]). The outgoing cards' state bags are captured on the way out and
   * replayed when the workspace returns.
   */
  activateSpace: (spaceId: string) => void;

  /** Rename a workspace. Trims; a name empty after trimming is refused. */
  renameSpace: (spaceId: string, name: string) => void;

  /**
   * Choose a workspace's theme. The active workspace's is applied to the
   * screen; a parked one's is only recorded, and shows when the user switches
   * to it.
   */
  chooseSpaceTheme: (spaceId: string, theme: string) => void;

  /**
   * How many live sessions a workspace holds ([P07]): Session cards with a
   * binding, or with a cached ledger row that is alive, has a transcript, or
   * has taken a turn. The confirm's count and the close loop read this one
   * definition.
   */
  spaceHoldsLiveSessions: (spaceId: string) => number;

  /**
   * How many cards a workspace holds: its panes, never its sidebar's, and
   * never narrowed by a filter. The delete confirm's count.
   */
  spaceCardCount: (spaceId: string) => number;

  /**
   * Put the workspaces in `order`. Unknown ids are ignored and unmentioned
   * spaces keep their relative order at the end.
   */
  reorderSpaces: (order: readonly string[]) => void;

  /**
   * Move `cardId`, with the pane holding it, into another workspace ([B07]).
   * The card's id does not change, so a Session card keeps its binding and
   * everything else keyed by that id. A no-op when the card is already there,
   * when no space has that id, or when the pane holds a sidebar card. Returns
   * whether it moved.
   */
  moveCardToSpace: (cardId: string, spaceId: string) => boolean;
}
