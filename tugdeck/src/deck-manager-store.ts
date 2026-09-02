/**
 * IDeckManagerStore -- subscribable store interface for DeckManager.
 *
 * Lives in a separate file to break the circular import between
 * deck-manager.ts (which imports deck-manager-context.tsx for the
 * root.render() wrapper) and deck-manager-context.tsx (which needs
 * a type for the store value).
 *
 * **Authoritative references:**
 * - [D02] Extract IDeckManagerStore interface to break circular imports
 * -: IDeckManagerStore interface
 */

import type { DeckState, CardStateBag } from "./layout-tree";
import type {
  ColumnMoveTarget,
  ContentWidth,
  SidebarSide,
} from "./lib/layout-imposer";
import type { CardLifecycleObserver } from "./lib/card-lifecycle";
import type { ComponentStatePreservationRegistry } from "./components/tugways/component-state-preservation-registry";
import type { CardAssembler } from "./card-state-orchestrator";
import type { SaveCallbackSource } from "./deck-trace";
import type { SlotAssignment } from "./deck-manager";

/**
 * Options on a pane-geometry commit. `evictSlot` releases an imposed pane back
 * to free geometry as part of the same commit — set by both manual geometry
 * gestures, the title-bar drag and the edge resize, and by neither of the
 * structural width writers (the allocator, the width-preset applier).
 */
export interface MovePaneOptions {
  evictSlot?: boolean;
  /**
   * The named width this move is applying. Set only by the width-preset
   * applier; every hand resize omits it, which is what makes the pane's
   * `widthPreset` stamp clear itself when the width changes by any other
   * route. A pane at a width nobody named is at no preset.
   */
  widthPreset?: ContentWidth;
}

/**
 * Subscribable store interface for DeckManager.
 * Conforms to the useSyncExternalStore contract.
 */
export interface IDeckManagerStore {
  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * Must be an arrow property (stable identity, auto-bound this)
   * so it can be passed directly to useSyncExternalStore without .bind().
   */
  subscribe: (callback: () => void) => () => void;

  /**
   * Return the current DeckState snapshot.
   * Must be an arrow property (stable identity, auto-bound this).
   */
  getSnapshot: () => DeckState;

  /**
   * Run `fn` as one gesture: every store notification it provokes is
   * held until it returns, and exactly one fires over the final state.
   *
   * The deck canvas arms its settle off the arrangement signature, once
   * per notify. A gesture built from several mutations — a drop-zone
   * release commits the autoscroll offset, then the zone, and raises the
   * arriving pane on the way — would otherwise arm the settle once per
   * mutation and retarget tweens already in flight. One gesture is one
   * arrangement change, so callers that mutate more than once wrap the
   * whole gesture here.
   *
   * Re-entrant, and safe against a throw inside `fn`: the pending notify
   * still fires. Mutations and lifecycle brackets are NOT reordered —
   * only observation is coalesced.
   */
  batchGesture: <T>(fn: () => T) => T;

  /**
   * Return the current state version (monotonically increasing integer).
   * Must be an arrow property (stable identity, auto-bound this).
   */
  getVersion: () => number;

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

  /**
   * Commit where a drag left a scrolled strip — an overflowing column's
   * ([P12]), an overflowing rail's, and the flow strip's. One write at the end
   * of the gesture, never per frame: the offset is an `arrangementSignature`
   * term, so a per-frame commit would arm a settle on every frame of the drag.
   */
  setColumnOffset: (slot: number, offset: number) => void;
  setRailOffset: (side: SidebarSide, offset: number) => void;
  setFlowOffset: (offset: number) => void;

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

  /**
   * Stable bound callback: update a pane frame's position/size on drag-end /
   * resize-end. The frame that gets dragged is the chrome shell; individual
   * cards within it share the pane's position.
   */
  handlePaneMoved: (
    paneId: string,
    position: { x: number; y: number },
    size: { width: number; height: number },
    opts?: MovePaneOptions,
  ) => void;

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
   */
  activateCard: (cardId: string) => void;

  /**
   * Deselect — clear the composite first-responder bit so no card is
   * active. Drops every title bar to its deactivated appearance and makes
   * `getFirstResponderCardId()` return null. Driven by the canvas-background
   * click. No-op when nothing is active.
   */
  deselectActiveCard: () => void;

  /**
   * Read the composite first-responder bit: the active pane's
   * active card id, or `null` when no pane is active. At any
   * moment, exactly zero or one card is the first responder.
   */
  getFirstResponderCardId: () => string | null;

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
   * `options.slot` names the slot the card joins under a multi-slot
   * arrangement (clamped to it); omitted, the card takes the first slot.
   */
  addCard: (
    componentId: string,
    initialContent?: unknown,
    options?: { slot?: number },
  ) => string | null;

  /**
   * Show a card type as a singleton: activate the existing card with
   * this `componentId` (raising its pane to z-top) if one exists, else
   * add a fresh one. Returns the reused or new card id, or null if
   * `componentId` is unregistered.
   */
  showSingletonCard: (componentId: string) => string | null;

  /**
   * Re-center the pane hosting `cardId` in the live canvas, at its current
   * size. What a `placement: "center"` card takes on every show, so a
   * position saved under an older arrangement can never leave it standing
   * behind the pinned rail. A pane whose geometry is derived (slotted, or the
   * rail itself) is left alone.
   */
  centerPane: (cardId: string) => void;

  /**
   * Move a pane immediately below another in z-order — the
   * Previous-Card-in-Stack rotation primitive. Reorder only; the caller
   * owns activating whichever pane the demotion fronts.
   */
  sendPaneBehind: (paneId: string, belowPaneId: string) => void;

  /**
   * Show a sidebar card by componentId. Activates the card if its rail is
   * already open, else creates the pinned pane at the width it reopens at.
   * Returns the card id, or null when the card type is unregistered.
   */
  showSidebarPane: (componentId: string) => string | null;

  /**
   * Hide a sidebar card by closing its pane (presence is the open state,
   * [P02]). No-op when it is not open.
   */
  hideSidebarPane: (componentId: string) => void;

  /**
   * Show a side's rail: reopen the members it held when it was last hidden
   * whole, else the one card that belongs there. Returns the card id left
   * z-frontmost, or null when the side has nothing to show.
   */
  showSidebarRail: (side: SidebarSide) => string | null;

  /**
   * Hide a side's rail by closing every member standing on it, recording which
   * ones they were so the matching show can bring back the same rail.
   */
  hideSidebarRail: (side: SidebarSide) => void;

  /**
   * Re-solve every pinned sidebar rail's width so the imposed chain tiles
   * evenly, and commit if any changed (the space allocator,
   * `lib/layout-imposer.ts`). A no-op when no sidebar is pinned and open, when
   * no arrangement is active, or when the answer is the widths already showing.
   */
  retuneSidebarAllocation: () => void;

  /**
   * Set a side's height weights — the seam drag's commit. Weights are per
   * componentId, so a member that closes and returns keeps its height, and a
   * reorder moves cards without moving heights ([P02]).
   *
   * A gesture's commit rather than a public action: nothing but the seam has
   * business synthesizing a ratio ([P11]).
   */
  setRailShares: (side: SidebarSide, shares: Record<string, number>) => void;

  /**
   * Put a side's members in a stated vertical order — the corridor drag's
   * commit, and a gesture's commit for the same reason {@link setRailShares}
   * is.
   */
  setRailOrder: (side: SidebarSide, order: readonly string[]) => void;

  /**
   * Set a slot's height weights — the column seam drag's commit, and a
   * gesture's commit for the same reason {@link setRailShares} is. Weights are
   * per PANE id: a slot holds panes, and a pane may itself be a tab stack, so
   * there is no card-level identity to key a member by ([P11]).
   */
  setColumnShares: (slot: number, shares: Record<string, number>) => void;

  /** Put a slot's members in a stated vertical order — the move-in-column
   *  chords' commit, filtered to the panes actually standing in that slot. */
  setColumnOrder: (
    slot: number,
    order: readonly string[],
    movedPaneId?: string,
  ) => void;

  /**
   * Move a whole pane to a slot, optionally at a stated index in that slot's
   * split column — the drop-zone drag's commit for a card crossing places
   * ([P10]).
   *
   * Pane-addressed where {@link assignCardToSlot} is card-addressed: a
   * title-bar drag holds the box, tabs and all. One call because it is one
   * arrangement change, so the settle animates the crossing once. Refuses on
   * the same grounds any slot assignment refuses.
   */
  movePaneToSlot: (
    paneId: string,
    slot: number,
    index?: number,
  ) => SlotAssignment;

  /**
   * Put a card's pane in a slot of the imposed chain — the Layouts click's
   * commit, and the drop-zone drag's for a plain slot ([P10]). Refuses as a
   * group, which the caller must read rather than discard.
   */
  assignCardToSlot: (cardId: string, slot: number) => SlotAssignment;

  /**
   * Move a pane within its own column — the move-in-column chords' commit.
   * Returns false when the move is refused (no column, a column of one, or a
   * member already at that end), which the caller turns into a visible flash.
   */
  moveInColumn: (paneId: string, where: ColumnMoveTarget) => boolean;


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

  /**
   * Set the active card in a pane. No-op when `cardId` is not in
   * the pane. (Renamed from `setActiveTab`.)
   */
  setActiveCardInPane: (paneId: string, cardId: string) => void;

  /**
   * Reorder a card within its pane. Moves the card at `fromIndex`
   * to `toIndex`. No-op when the pane is not found, indices are out
   * of bounds, or fromIndex === toIndex. (Renamed from `reorderTab`.)
   */
  reorderCardInPane: (paneId: string, fromIndex: number, toIndex: number) => void;

  /**
   * Detach a card from its pane and create a new single-card pane at
   * the given position. Returns the new pane's id, or null if the
   * pane or card is not found, or if the card is the last card in
   * its pane. (Renamed from `detachTab`.)
   */
  detachCard: (
    paneId: string,
    cardId: string,
    position: { x: number; y: number },
  ) => string | null;

  /**
   * Move a card from its source pane to a target pane, inserting at
   * `insertAtIndex`. No-op when `sourcePaneId === targetPaneId`.
   * The moved card becomes the target pane's active card. If the
   * source pane has only one card, the source pane is removed.
   * (Renamed from `mergeTab`.)
   */
  moveCardToPane: (
    sourcePaneId: string,
    cardId: string,
    targetPaneId: string,
    insertAtIndex: number,
  ) => void;

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

  /**
   * The card ID that was focused when the deck was last saved to tugbank.
   * Used only on reload to restore focus via makeFirstResponder in DeckCanvas.
   * Cleared to undefined after DeckCanvas reads it (fires once on mount).
   * ([D03])
   */
  initialFocusedCardId?: string;

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
   * Set one content pane's width to a named preset and stamp it, clamped up to
   * the pane's stack floor. Refuses a sidebar pane — a rail's width belongs to
   * the allocator.
   */
  setPaneWidth: (paneId: string, preset: ContentWidth) => void;

  /**
   * Set the deck's default content width and put every content pane on it.
   * Overwrites per-pane deviations — the default is a statement about how wide
   * content reads on this deck, not a seed for the next card.
   */
  setContentWidth: (preset: ContentWidth) => void;

  /**
   * Put a pane in bullseye — centered in the band at the comfy width, with
   * every other pane receded — or take it out when it is already there.
   * Refuses a missing pane and a sidebar pane. Writes no geometry, so leaving
   * bullseye restores nothing: nothing was disturbed.
   */
  toggleBullseye: (paneId: string) => void;

  /**
   * The pane standing in bullseye, or `null`. A derivation over the current
   * snapshot, not a stored answer: it holds only while the pane exists and
   * hosts the first responder, which is what makes every focus-shaped exit
   * door work without an event handler per door.
   */
  getBullseyePaneId: () => string | null;

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

  /**
   * Flip the session-only `DeckState.hasFocus` slice ([A1]). Wired up
   * from the module-scope window `focus` / `blur` listeners installed
   * by `DeckManager`; tests may call this directly to simulate
   * foreground transitions without dispatching DOM events. Must be an
   * arrow property (stable identity, auto-bound `this`) so it can be
   * passed as a listener callback without `.bind()`. No-op when the
   * bit is already at `value`.
   */
  setHasFocus: (value: boolean) => void;

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
}

/**
 * Hooks an engine registers with the framework so the single-channel
 * dispatcher (`applyBagFocus`) can drive activation-time
 * `paintMirrorAsActive` / `paintMirrorAsInactive` calls. The engine
 * still owns the implementation — these hooks are thin closures over
 * the engine's view that call into the engine's existing primitives
 * (e.g. `paintMirrorAsActiveImpl(view, state)` for the editor).
 *
 * Closures must read engine state (e.g. `viewRef.current`) live at
 * fire time, not at registration time, per [L07] — otherwise the
 * hook would fight CodeMirror's StrictMode-driven mount/cleanup/
 * mount cycle.
 */
export interface EngineHooks {
  /**
   * Claim focus and global Selection on behalf of this card's
   * engine. The framework's `applyBagFocus` invokes this when
   * `bag.focus.kind === "engine"`. The engine reads its own latest
   * state (selection, scroll) and applies. Returns `void` — the
   * dispatcher treats the call as best-effort; if the engine's
   * `view` is unmounted, the hook should no-op silently and the
   * dispatcher's late-mount retry (Phase E.11 Step 4) will re-fire
   * once the engine registers fresh hooks.
   */
  paintMirrorAsActive: () => void;

  /**
   * Symmetry pair: route the engine's selection into the
   * inactive-paint channel before another card claims focus +
   * global Selection. The engine knows where to send its selection
   * Range — typically `selectionGuard.updateCardDomSelection(cardId,
   * range)`. The dispatcher never reads the returned Range; it only
   * triggers the hook.
   */
  paintMirrorAsInactive: () => void;
}