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

import type {
  ColumnMoveTarget,
  ContentWidth,
  GapPreset,
  FlowBandEdges,
  SidebarSide,
} from "./lib/layout-imposer";
import type { CommitLanding } from "./deck-trace";
import type { SlotAssignment } from "./deck-manager";
import type { RailWidthLimits } from "./lib/rail-width";
import type { DeckView } from "./card-deck";

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
  /**
   * The height the card is given in its slot (`TugPaneState.slotHeight`). A
   * number writes it; `null` deletes it, which is the card filling its run
   * again; omitted leaves it as it stands.
   */
  slotHeight?: number | null;
}

/**
 * The shell's whole deck: `DeckView` (what any card, and any listing card,
 * may read and call) plus the arrangement's own mutations. Only the shell
 * holds it; a body page provides a `CardDeck` and never this.
 */
export interface IDeckManagerStore extends DeckView {

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
   * The flow offset {@link previewFlowOffset} last drew and no commit has
   * yet consumed, or `null` when the strip stands where the store says. The
   * settle's arm reads it, inside the commit that consumes it, as the origin
   * of its flow slide — the frame the eye is on rather than the store's last
   * word, which is what keeps the slide after a swipe from snapping back to
   * where the strip stood before the hand touched it.
   */
  getDrawnFlowOffset: () => number | null;
  /**
   * The hand's velocity at the moment a gesture released the drawn offset, in
   * offset px per second (positive as the offset grows), or `null` when no
   * hand handed one over. Written by the canvas wheel just before the commit
   * a trackpad lift makes, and consumed by that commit alongside the drawn
   * offset: the settle's flow slide launches at it, toward its stop only, so
   * a fast lift lands fast and a slow one slow. Like the drawn offset it is a
   * fact about the screen, not the state.
   */
  getDrawnFlowVelocity: () => number | null;
  /** Hand the next flow commit the hand's velocity; see
   *  {@link getDrawnFlowVelocity}. */
  setDrawnFlowVelocity: (pxPerSecond: number | null) => void;
  /**
   * The same band as its two edges in canvas layout px, or `null` when there
   * is none — the left edge is the left rail's inset plus the gap when a rail
   * stands there and the bare gap otherwise, and the right edge likewise.
   * The drag's flow trigger reads these; the width alone cannot say where
   * the band begins under a left rail.
   */
  getBandEdges: () => FlowBandEdges | null;
  /**
   * The band's width as the rails leave it, never `null`: zero or negative
   * when the rails meet or overlap across the canvas. The rail width drag
   * reads it, because a rail widened over the deck must still narrow back,
   * and the imposed `left` expressions clamp a band of no width themselves.
   */
  getBandSpan: () => number;
  /**
   * The `performance.now()` at which the most recent `activateSpace` began,
   * or `null` before any switch. It is the origin the switch frame record
   * measures first paint from: the GESTURE, not the swap commit. Measured, the
   * commit lands about 75 ms after the gesture on a three-workspace deck —
   * React's whole render of the canvas runs between them — so a record whose
   * origin was the commit could never contain the freeze it exists to show.
   */
  getSpaceSwitchStartedAt: () => number | null;

  /**
   * The `performance.now()` at which the most recent COMMITTING imposition
   * gesture was entered, or `null` before any. It is the origin the settle's
   * frame record measures its first paint from: the GESTURE, not the arm.
   * The settle arms on the store's notify, before React's render, so the arm
   * is already earlier than the commit — and the lead that remains is the
   * mutator's own preamble plus the notify, which is what the user waited
   * through and what a record armed at the arm cannot contain.
   *
   * **Only a gesture that reaches the commit stamps.** `setPaneFolded` has
   * three returns before it commits — pane not found, sidebar refusal, and
   * `panesWithFolded` returning identity — and none of them arms a settle. A
   * stamp left behind by one of those would be read as the origin by whatever
   * settle came next, and the reader's staleness guard cannot catch it: that
   * stamp is fresh, and wrong. So the mutator takes the time into a local at
   * its entry and publishes it only on the committing path.
   *
   * **And a published stamp is spent once.** This field is never retired —
   * nothing here knows when it has been read — so the same reasoning covers
   * the settle that FOLLOWS a fold by a second or two: its stamp is fresh
   * and belongs to the fold. The settle's frame record remembers the stamp it
   * last measured a window from and falls back to its own arm rather than
   * measuring a second window from it.
   *
   * Folds the user did not gesture carry no stamp, and that is correct: a card
   * arriving into a wall folds the sitters inside the arrival commit without
   * passing through `setPaneFolded`, and that settle falls back to the arm.
   */
  getImpositionGestureAt: () => number | null;

  /**
   * Commit where a drag left a scrolled strip — an overflowing column's
   * ([P12]), an overflowing rail's, and the flow strip's. One write at the end
   * of the gesture, because the strip moved imperatively while the hand was
   * down and this is where the store catches up with it.
   *
   * `landing` is how the commit lands ([B01]). A gesture that previewed per
   * frame passes `"cut"` — the frames are already drawn there and the settle
   * declines — which is what a per-frame writer had no way to say before
   * ([B03]). A caller that hands over a number the deck was not drawing, the
   * flow strip's segment click and the Center Card chord, leaves the default
   * `"cross"` and the settle carries the crossing.
   */
  setColumnOffset: (
    slot: number,
    offset: number,
    landing?: CommitLanding,
  ) => void;
  setRailOffset: (
    side: SidebarSide,
    offset: number,
    landing?: CommitLanding,
  ) => void;

  /**
   * The widths the rail on `side` may stand at — its tightest member's hard
   * floor and the allocator's slim ceiling — or `null` when no pinned rail
   * stands there. The one derivation the rail width drag reads.
   */
  railWidthLimits: (side: SidebarSide) => RailWidthLimits | null;
  /**
   * Commit the rail on `side` at `width`, clamped to its limits: every member
   * of the side, mirrored to each card's reopen width, in one notify. The
   * space allocator does not run.
   */
  setRailWidth: (side: SidebarSide, width: number) => void;

  /**
   * The same claim for a member of the PARKED workspace `spaceId`, written on
   * its parked record: a parked card's picker can report while its
   * workspace is hidden. Only the shell's manager holds parked workspaces; a body's
   * one-card deck has none, and leaves this out.
   */
  setParkedSheetReservation?: (spaceId: string, memberId: string, height: number | null) => void;

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

  /**
   * Deselect — clear the composite first-responder bit so no card is
   * active. Drops every title bar to its deactivated appearance and makes
   * `getFirstResponderCardId()` return null. Driven by the canvas-background
   * click. No-op when nothing is active.
   */
  deselectActiveCard: () => void;

  /**
   * The pane's half of a drop's second move. A dropped frame is carried into
   * its tile by the pane's own landing, which the settle skips; the reveal
   * that shows the card whole must wait for that landing as well as for the
   * settle, or the frame it skips jumps when the landing ends. `noteCardWillLand`
   * is called at the release, before the commit; `noteCardDidLand` when the
   * landing has finished, on every path out.
   */
  noteCardWillLand: (cardId: string) => void;
  noteCardDidLand: (cardId: string) => void;

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
   * Hide a sidebar card by closing its pane. It tests presence, so a parked
   * card is closed too. No-op when the card is not on the deck.
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
   * Land a sidebar card at a position of a rail from whichever rail it stands
   * on — the cross-side drop's commit: side and both orders in one
   * imposition, so the gesture arms one settle.
   */
  moveSidebarToRail: (componentId: string, side: SidebarSide, index: number) => void;

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

  /**
   * The card ID that was focused when the deck was last saved to tugbank.
   * Used only on reload to restore focus via makeFirstResponder in DeckCanvas.
   * Cleared to undefined after DeckCanvas reads it (fires once on mount).
   * ([D03])
   */
  initialFocusedCardId?: string;

  /**
   * Add a workspace, activate it, and stand its factory rail ([P05]). The
   * name is the caller's when given, and `Workspace N` otherwise. Returns the
   * new space's id.
   */
  createSpace: (name?: string) => string;

  /**
   * Copy a workspace's layout and sidebars — never its content cards — into a
   * new one named `<name> copy`, appended after the source and not activated
   * ([P06]). Returns the new id, or `null` when no space has that id.
   */
  duplicateSpace: (spaceId: string) => string | null;

  /**
   * Remove a workspace and close its sessions ([P07]). Refuses the last one.
   * Deleting the active workspace activates its nearest neighbour first.
   * Returns whether it was deleted.
   */
  deleteSpace: (spaceId: string) => boolean;

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
   * Set the deck's card gap — one named preset that every imposed frame, seam,
   * rail gutter and margin cap follows, persisted on the imposition record.
   */
  setGap: (preset: GapPreset) => void;

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
   * Flip the session-only `DeckState.hasFocus` slice ([A1]). Wired up
   * from the module-scope window `focus` / `blur` listeners installed
   * by `DeckManager`; tests may call this directly to simulate
   * foreground transitions without dispatching DOM events. Must be an
   * arrow property (stable identity, auto-bound `this`) so it can be
   * passed as a listener callback without `.bind()`. No-op when the
   * bit is already at `value`.
   */
  setHasFocus: (value: boolean) => void;

  /**
   * Become the deck's DEPARTURE HOST — the one party that will carry a
   * closed pane out and say when it is gone. Returns the unregister.
   *
   * While a host is registered and motion is on, a close leaves the pane, its
   * cards and a `departing` mark in the published snapshot instead of removing
   * them, and defers the cards' destruction until {@link landDepartures}. With
   * no host, a close removes outright, so a deck with no mounted canvas — a
   * unit test, the boot path — never strands a departure. When the last host
   * unregisters, every departure lands.
   *
   * The settle engine registers in a `useLayoutEffect`.
   */
  registerDepartureHost: () => () => void;

  /**
   * Land departures: for each named departing pane (every one when `paneIds`
   * is omitted), flush its cards' save callbacks, fire their
   * `cardWillBeginDestruction`, and remove the pane, its cards and its mark
   * from the published snapshot in one notify. An id that is not departing is
   * ignored, so landing twice is harmless.
   */
  landDepartures: (paneIds?: readonly string[]) => void;
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