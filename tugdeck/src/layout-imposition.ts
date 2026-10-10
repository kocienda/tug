/**
 * Layout imposition: the deck's gestures over its structured arrangement.
 *
 * Choosing an arrangement, choosing how it resolves, assigning cards and panes
 * to slots, and the seating a crossing card takes in a split column. Each is a
 * function over an {@link ImpositionDeps} the `DeckManager` builds once — the
 * live deck, the store's public surface, and the handful of the manager's own
 * commit primitives these gestures go through — rather than a method reaching
 * into `this`. The manager's methods of the same names call these from the
 * call sites the gestures always ran at, so `IDeckManagerStore` is unchanged.
 */

import type { DeckState, TugPaneState } from "./layout-tree";
import type { CardLifecycle } from "./lib/card-lifecycle";
import type { IDeckManagerStore, MovePaneOptions } from "./deck-manager-store";
import { columnMembersOf, findSidebarPanes, placeMembers } from "./deck-store-selectors";
import { isSidebarCard } from "./card-registry";
import { paneCanvasOf } from "./components/chrome/space-layer";
import { pageZoomFactor } from "./lib/page-zoom-store";
import { transferFocusForActivation } from "./focus-transfer";
import {
  arrivalSharesOf,
  clampSlot,
  columnModeOf,
  impositionLayout,
  impositionResizeSlot,
  IMPOSITION_GAP_PX,
  slotCount,
  withColumnShares,
  withMemberSeated,
  type DeckImposition,
  type ImpositionKind,
  type ImpositionLayout,
  type ResizeSlot,
} from "./lib/layout-imposer";

/**
 * Whether a slot arrangement took.
 *
 * `assignCardsToSlots` refuses the whole batch rather than half-applying it,
 * so the caller needs to hear which of the two happened before it decides
 * whether to show a receipt or a refusal. `blockedCardId` is present when the
 * refusal has a member to blame — a slot outside the arrangement — and absent
 * when the batch never had a subject at all (no imposition, no such card, a
 * sidebar host), which is a programming fault rather than an edge the user
 * pressed into.
 */
export type SlotAssignment =
  | { readonly ok: true }
  | { readonly ok: false; readonly blockedCardId?: string };

/** The options `DeckManager._commitImposition` takes. */
export interface CommitImpositionOptions {
  readonly retuneRails: boolean;
  readonly revealPaneId?: string | null;
  readonly columnReveal?: { slot: number; offset: number };
}

export interface ImpositionDeps {
  /** The store these gestures act on — its public surface. */
  readonly store: IDeckManagerStore;
  /** The live deck. Read fresh at every use: a detach rebuilds it mid-gesture. */
  deck(): DeckState;
  /** Replace the live deck (the one gesture that commits without `commitImposition`). */
  setDeck(next: DeckState): void;
  notify(caller: string): void;
  scheduleSave(): void;
  lifecycle(): CardLifecycle;
  commitImposition(
    imposition: DeckImposition,
    panes: readonly TugPaneState[],
    opts?: CommitImpositionOptions,
  ): void;
  withSidebarsPinned(imposition: DeckImposition): DeckImposition;
  /** Put every rail back at its pin. */
  pinSidebars(): void;
  detachCard(paneId: string, cardId: string, position: { x: number; y: number }): string | null;
  clearBullseyeFor(paneId: string): void;
  placeRunHeight(kind: "column" | "rail"): number;
  revealAfterTravel(cardId: string): void;
  movePane(
    paneId: string,
    position: { x: number; y: number },
    size: { width: number; height: number },
    opts?: MovePaneOptions,
  ): void;
}

/**
 * Read a pane frame's live on-screen rect in canvas coordinates, or `null`
 * when the frame is not in the DOM. An imposed pane's `position`/`size` hold
 * last-known values while its real rect is derived by CSS, so any code that
 * needs the truth has to measure the frame. Layout space, not visual: the
 * measurements are divided by `body { zoom }` the same way `snapshotCardRects`
 * does, so the result is directly comparable with stored geometry.
 */
export function readPaneFrameRect(
  paneId: string,
): { x: number; y: number; width: number; height: number } | null {
  if (typeof document === "undefined") return null;
  const escaped = paneId.replace(/["\\]/g, "\\$&");
  const frame = document.querySelector<HTMLElement>(
    `.tug-pane[data-pane-id="${escaped}"]`,
  );
  if (!frame) return null;
  const canvas = paneCanvasOf(frame)?.getBoundingClientRect() ?? null;
  const zoom = pageZoomFactor();
  const rect = frame.getBoundingClientRect();
  return {
    x: (rect.left - (canvas ? canvas.left : 0)) / zoom,
    y: (rect.top - (canvas ? canvas.top : 0)) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
}

/** Per-pane position/size deltas between two pane arrays of the same shape,
 *  keyed by active card, for the will/did move/resize lifecycle events. */
export function geometryChanges(
  before: readonly TugPaneState[],
  after: readonly TugPaneState[],
): { id: string; positionChanged: boolean; sizeChanged: boolean }[] {
  const changes: {
    id: string;
    positionChanged: boolean;
    sizeChanged: boolean;
  }[] = [];
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i];
    const a = after[i];
    const positionChanged =
      b.position.x !== a.position.x || b.position.y !== a.position.y;
    const sizeChanged =
      b.size.width !== a.size.width || b.size.height !== a.size.height;
    if (positionChanged || sizeChanged) {
      changes.push({ id: a.activeCardId, positionChanged, sizeChanged });
    }
  }
  return changes;
}

/**
 * Set the deck's active imposition, or clear it.
 *
 * A kind change keeps every assignment: a slot the new kind does not have is
 * clamped to its last slot rather than dropped, so nothing silently falls out
 * of the arrangement when the user goes from four-up to two-up.
 *
 * Clearing freezes each imposed pane where the user last saw it — the live
 * frame rect is written into `position`/`size` before `slot` goes away, so
 * turning the structure off does not scatter panes back to stale
 * pre-imposition coordinates.
 *
 * Either way the rails return to their pins: choosing an arrangement is
 * choosing one they stand at the ends of. A rail dragged loose and left there
 * is put back by any choice in the Layout card, which is why an unchanged
 * kind is not simply a no-op.
 */
export function setImposition(deps: ImpositionDeps, kind: ImpositionKind | null): void {
  const deck = deps.deck();
  const current = deck.imposition.kind;
  if (current === (kind ?? undefined)) {
    deps.pinSidebars();
    deps.store.retuneSidebarAllocation();
    return;
  }
  const railCardIds = findSidebarPanes(deck).map(
    ({ pane }) => pane.activeCardId,
  );

  if (kind === null) {
    const lifecycle = deps.lifecycle();
    const frozen = deck.panes.map((pane) => {
      if (pane.slot === undefined) return pane;
      const next: TugPaneState = { ...pane };
      delete next.slot;
      // The slot's height goes with the slot, as in `movePane`'s eviction.
      delete next.slotHeight;
      const rect = readPaneFrameRect(pane.id);
      if (rect !== null) {
        next.position = { x: rect.x, y: rect.y };
        next.size = { width: rect.width, height: rect.height };
      }
      return next;
    });
    const changes = geometryChanges(deck.panes, frozen);
    for (const ch of changes) {
      if (ch.positionChanged) lifecycle.notifyCardWillMove(ch.id);
      if (ch.sizeChanged) lifecycle.notifyCardWillResize(ch.id);
    }
    const imposition: DeckImposition = {
      ...deps.withSidebarsPinned(deck.imposition),
    };
    delete imposition.kind;
    for (const cardId of railCardIds) lifecycle.notifyCardWillMove(cardId);
    deps.setDeck({ ...deck, panes: frozen, imposition });
    deps.notify("setImposition");
    for (const ch of changes) {
      if (ch.positionChanged) lifecycle.notifyCardDidMove(ch.id);
      if (ch.sizeChanged) lifecycle.notifyCardDidResize(ch.id);
    }
    for (const cardId of railCardIds) lifecycle.notifyCardDidMove(cardId);
    deps.scheduleSave();
    return;
  }

  const panes = deck.panes.map((pane) => {
    if (pane.slot === undefined) return pane;
    const clamped = clampSlot(kind, pane.slot);
    return clamped === pane.slot ? pane : { ...pane, slot: clamped };
  });
  deps.commitImposition(
    {
      ...deps.withSidebarsPinned(deck.imposition),
      kind,
    },
    panes,
  );
}

/**
 * Choose how the deck resolves its slots: `"fit"`, where a slot is an anchor
 * at a fraction of the band, or `"flow"`, where the occupied slots stand in a
 * strip and never overlap.
 *
 * Every pane keeps its slot — the mode changes what a slot MEANS, not which
 * one a card holds — so this commits the record and nothing else, and the
 * frames follow because their `left` is derived from it.
 *
 * A Layouts click is one of THE MOMENTS the deck may re-solve its rails, so
 * this goes through `commitImposition` with the retune left on. It has
 * real work to do here in one direction: leaving flow, the rails have been
 * standing at their preferred widths (the allocator's flow answer) and the
 * seams the fit picture wants are almost certainly somewhere else.
 */
export function setImpositionLayout(deps: ImpositionDeps, layout: ImpositionLayout): void {
  const deck = deps.deck();
  const imposition = deck.imposition;
  if (impositionLayout(imposition) === layout) return;
  deps.commitImposition({ ...imposition, layout }, deck.panes);
}

/**
 * Choose what an edge resize does to an imposed card's slot: keep it, or
 * release the card into free pixels.
 *
 * A rule for the NEXT gesture, so nothing moves: every pane keeps its slot
 * and its frame, and the commit carries the record alone. The rails are left
 * where they stand — choosing how a later resize behaves is not one of the
 * moments the deck may arrange itself.
 */
export function setResizeSlot(deps: ImpositionDeps, resizeSlot: ResizeSlot): void {
  const deck = deps.deck();
  const imposition = deck.imposition;
  if (impositionResizeSlot(imposition) === resizeSlot) return;
  deps.commitImposition(
    { ...imposition, resizeSlot },
    deck.panes,
    { retuneRails: false },
  );
}

/**
 * Give a slotted card back its run's full height: delete the height its
 * bottom edge gave it, so it follows the run again. The width menu's Fill
 * Height row. One write, through the same commit an edge resize takes, and a
 * card that already fills its run is left alone.
 */
export function fillPaneHeight(deps: ImpositionDeps, paneId: string): void {
  const pane = deps.deck().panes.find((p) => p.id === paneId);
  if (pane === undefined || pane.slotHeight === undefined) return;
  deps.movePane(paneId, pane.position, pane.size, { slotHeight: null });
}

/**
 * Assign several cards to slots as one arrangement.
 *
 * The batch is the multi-card gesture's whole point: the FLIP settle in
 * `deck-canvas.tsx` measures where the frames were on the store event and
 * where they landed after React's commit, so a gesture that notifies once
 * per card offers that measurement a half-moved deck each time and re-arms
 * the settle window on every one of them. All the slot writes land in ONE
 * geometry commit, the same reasoning that made `setContentWidth` one
 * commit rather than one per pane.
 *
 * The detaches and the raises still run per card, ahead of the geometry,
 * because that is what they are: pulling a card out of a tab strip changes
 * what the strip IS, and a raise moves nothing (the settle's arrangement
 * signature is z-blind), so neither arms a window of its own. The cards come
 * forward in the order given, which leaves the last one first responder.
 *
 * GROUP REFUSAL. The batch is validated whole before anything moves: one
 * ineligible card refuses all of them. A gesture that half-applies is worse
 * than one that refuses, because the user cannot see which half took.
 *
 * A slot outside the arrangement is one of those ineligibilities rather than
 * something to clamp. Clamping is right when the arrangement itself shrinks
 * (`clampSlot` on a kind change pulls orphaned panes back in); it is wrong
 * for a gesture, because a group clamped against the edge arrives with its
 * members stacked on one slot — the arrangement the user was moving,
 * destroyed by the move. The refusal names the card that blocked it so the
 * caller can point at it.
 */
export function assignCardsToSlots(
  deps: ImpositionDeps,
  entries: readonly { readonly cardId: string; readonly slot: number }[],
): SlotAssignment {
  if (entries.length === 0) return { ok: false };
  const kind = deps.deck().imposition.kind;
  if (kind === undefined) {
    console.warn(
      "assignCardsToSlots: no active imposition; cannot slot cards",
    );
    return { ok: false };
  }

  const lastSlot = slotCount(kind) - 1;
  for (const { cardId, slot } of entries) {
    const deck = deps.deck();
    const host = deck.panes.find((p) => p.cardIds.includes(cardId));
    if (!host) {
      console.warn(`assignCardsToSlots: no pane holds card "${cardId}"`);
      return { ok: false };
    }
    const hostsSidebar = deck.cards.some(
      (c) => host.cardIds.includes(c.id) && isSidebarCard(c.componentId),
    );
    if (hostsSidebar) {
      // A sidebar card pins to a deck edge and insets the band — it is the
      // imposition's fixed end, not the chain's to place.
      console.warn(
        `assignCardsToSlots: card "${cardId}" is hosted in the sidebar pane "${host.id}"`,
      );
      return { ok: false };
    }
    if (!Number.isFinite(slot) || slot < 0 || slot > lastSlot) {
      return { ok: false, blockedCardId: cardId };
    }
  }

  // Which panes already stood in the chain, read BEFORE anything moves.
  // This is what separates a card joining the chain from a card moving
  // inside it, and the two get different answers below.
  const chainBefore = new Set(
    deps.deck().panes.filter((p) => p.slot !== undefined).map((p) => p.id),
  );

  const targets = new Map<string, number>();
  for (const { cardId, slot } of entries) {
    // Re-read the host each pass: an earlier detach rebuilds the panes array.
    const host = deps.deck().panes.find((p) => p.cardIds.includes(cardId));
    if (!host) continue;

    // `detachCard` returns null when the card is alone in its pane — that is
    // exactly the "slot the existing host" branch, no detach needed.
    const detachedPaneId =
      host.cardIds.length > 1
        ? deps.detachCard(host.id, cardId, host.position)
        : null;
    const targetPaneId = detachedPaneId ?? host.id;

    // Raise BEFORE the geometry, in its own commit.
    //
    // Assigning always raises: the slotted card becomes the active one, as a
    // first-class activation. Doing it after the geometry commit would leave
    // the frame crossing to its slot underneath the panes it is on its way to
    // sitting in front of — the raise is a precondition of the motion, not its
    // epilogue.
    //
    // A raw `activateCard` here would flip the first responder but skip the
    // focus transfer — the outgoing card (the Cards card, whose list dispatched the
    // assign) would never save its bag, and the slotted card would never
    // receive its focus claim (no caret until the user clicks into it).
    // Detaching has already raised and activated the new pane, in which case
    // this is the same-bit refresh.
    transferFocusForActivation({
      outgoingCardId: deps.store.getFirstResponderCardId(),
      incomingCardId: cardId,
      store: deps.store,
      commitMutation: () => deps.store.activateCard(cardId),
    });

    targets.set(targetPaneId, clampSlot(kind, slot));
  }
  if (targets.size === 0) return { ok: false };

  // Re-placing a pane ends its bullseye. This path writes `slot` on its own
  // rather than through `movePane`, so it honors the rule explicitly.
  for (const paneId of targets.keys()) deps.clearBullseyeFor(paneId);

  const deck = deps.deck();
  const panes = deck.panes.map((p) => {
    const slot = targets.get(p.id);
    return slot === undefined ? p : ({ ...p, slot } as TugPaneState);
  });
  // Everything in the chain moves, including the panes that kept their
  // slots: these cards' widths are now part of what precedes them.
  //
  // Whether the RAILS move too turns on membership, not on the verb. A pane
  // ENTERING the chain — a loose card gaining a slot, or a card pulled out of
  // a tab group into a pane of its own — changes what the chain is, and the
  // deck makes room for what it was just asked to arrange; that is the moment
  // `retuneSidebarAllocation` was written for. A pane that already had a slot
  // taking a different one is not that gesture: membership is unchanged,
  // nothing new needs room, and re-solving would hand the width freed by a
  // tighter pack to the rails — growing a sidebar by most of a card on a
  // chord that named one card.
  //
  // Which is the same fault, from the other side, that `setCardWidths` takes
  // `retuneRails: false` for. Both verbs are card-addressed and neither may
  // spend a rail; what licenses a re-solve is the Layouts click, the settled
  // resize, and a change to who is in the chain.
  const joinsChain = [...targets.keys()].some((id) => !chainBefore.has(id));
  // Every pane that CROSSED into a slot is seated at the bottom of that
  // slot's column ([D194]), in the order the batch named them. A pane the
  // batch re-assigned to the slot it already stood in has not arrived
  // anywhere and keeps its place.
  let imposition = deck.imposition;
  for (const [id, slot] of targets) {
    const before = deck.panes.find((p) => p.id === id);
    const stayed =
      before?.slot !== undefined && clampSlot(kind, before.slot) === slot;
    if (stayed) continue;
    imposition = impositionSeating(deps, imposition, panes, id, slot);
  }
  deps.commitImposition(imposition, panes, {
    retuneRails: joinsChain,
    // The batch leaves its last card first responder, and that is the card
    // the user is looking for; a slot whose column overflows must scroll it
    // into the run or the assignment lands somewhere nobody can see.
    revealPaneId: [...targets.keys()][targets.size - 1],
  });
  return { ok: true };
}

/**
 * The imposition the arriving pane's column should hold, with the pane
 * seated at the index a drop asked for, and at the bottom otherwise
 * ([D194]). The rule itself is `withMemberSeated`; this reads the
 * column the way the deck draws it and hands the reading over.
 *
 * Folded into the assignment's own commit rather than written after it,
 * because a card crossing into a split column changes two things about the
 * arrangement — which slot it stands in and where in that slot's order it
 * stands — and the settle can only animate them as one motion if they arrive
 * as one commit. Two commits would measure the deck once with the card
 * arrived but unplaced, which is a frame nobody asked to see.
 *
 * `panes` already carries the arrival, so a slot that held one pane reads
 * back as a column of two: the arrival plus the sitter it divides with.
 * Takes the imposition it seats into rather than reading the store's, so a
 * batch can seat several panes into one commit.
 *
 * `session` is the session-only state the commit is about to write
 * alongside the seating — the arriving marks, and the opening bid a card
 * arrives on — read here rather than off the store because the store does
 * not hold them yet and the seating has to be answered against the deck as
 * the commit will leave it. A pane marked arriving is left out of the
 * column's reading ([B08]): it is seated in the order, so it lands at the
 * bottom when revealed, but it takes no weight until then.
 */
export function impositionSeating(
  deps: ImpositionDeps,
  imposition: DeckImposition,
  panes: readonly TugPaneState[],
  paneId: string,
  slot: number,
  index?: number,
  session?: Pick<DeckState, "openingBids" | "arriving">,
  weighSeated = false,
): DeckImposition {
  const state = {
    ...deps.deck(),
    panes,
    imposition,
    // Keyed on the key's PRESENCE, never on its value. Both records encode
    // "empty" as the field GONE — `arrivingWith` drops `arriving` with its
    // last mark, so the reveal's cleared record IS `undefined` — and a
    // `!== undefined` test read that as "the caller passed nothing" and left
    // the store's own record standing. At the reveal that record still
    // carried the mark, so `columnMembersOf` went on leaving the newcomer
    // out, `arrivalShares` saw a column of one, and the weight the reveal
    // exists to write was never written ([B05]). The two encodings are both
    // right and they collide only here.
    ...(session !== undefined && "openingBids" in session
      ? { openingBids: session.openingBids }
      : {}),
    ...(session !== undefined && "arriving" in session
      ? { arriving: session.arriving }
      : {}),
  };
  const seated = withMemberSeated(
    imposition,
    slot,
    columnMembersOf(state, slot),
    paneId,
    index,
  );
  // Unchanged means the ORDER did not move, which for a card crossing into a
  // column means nothing arrived anywhere the column can divide — no
  // sitters, or a stacked column no drop asked to split — so there is no
  // division to write either.
  //
  // `weighSeated` is the one case where that reading is wrong. A card that
  // arrived HIDDEN was seated in the order a commit ago and takes its weight
  // at the reveal ([B04]/[B08]), so at the reveal the order is already right
  // and this shortcut would skip the very write the reveal exists to make —
  // leaving the newcomer unweighted, and the column's next division handing
  // it the unnamed default's fraction instead of the room the eye just saw
  // it take ([B05]). `arrivalShares` refuses a stacked column and a column
  // of one on its own, so nothing the shortcut guarded is lost by passing it.
  if (seated === imposition && !weighSeated) return seated;
  return arrivalShares(deps, { ...state, imposition: seated }, paneId, slot);
}

/**
 * The seated imposition with the arriving member's weight written into
 * `slot`'s division ([B05]) — `arrivalSharesOf`'s answer, in the same
 * commit as the seating that earned it.
 *
 * In the SAME commit for {@link impositionSeating}'s own reason: which slot
 * the card stands in, where in the column it stands, and how much of the run
 * it takes are three things about one arrangement change, and the settle can
 * animate them as one motion only if they arrive together. A weight written
 * a commit later would re-target a settle already in flight.
 *
 * `state` is the deck as the commit will leave it — the arrival's pane
 * standing in `slot`, the seated order, and (at `addCard`) the opening bid
 * the same commit writes, which is the floor the newcomer actually arrives
 * on. Answering off the store's own state instead would weigh the newcomer
 * at a floor its card never stood at.
 */
function arrivalShares(
  deps: ImpositionDeps,
  state: DeckState,
  paneId: string,
  slot: number,
): DeckImposition {
  const imposition = state.imposition;
  if (columnModeOf(imposition, slot) !== "split") return imposition;
  const run = deps.placeRunHeight("column");
  if (!(run > 0)) return imposition;
  const members = columnMembersOf(state, slot);
  if (members.length < 2) return imposition;
  const shares = arrivalSharesOf(
    placeMembers(
      state,
      "column",
      members,
      imposition.columns?.[slot]?.shares,
    ),
    paneId,
    run,
    IMPOSITION_GAP_PX,
  );
  if (Object.keys(shares).length === 0) return imposition;
  return withColumnShares(imposition, slot, shares);
}

/**
 * Move a whole pane to `slot`, optionally landing it at `index` in that
 * slot's split column — the drop-zone drag's commit for a card crossing
 * places ([P10]).
 *
 * Pane-addressed, where {@link assignCardsToSlots} is card-addressed, because
 * the two gestures have different subjects. The Layouts click names a card
 * and means that card, so a card pulled from a tab stack detaches into a pane
 * of its own. A title-bar drag names the pane — the box the hand is holding,
 * tabs and all — and detaching its front tab mid-flight would leave the rest
 * of the stack behind at the place the user just dragged away from.
 *
 * One call and one commit, which is the point of taking the index here rather
 * than in a `setColumnOrder` afterwards: the slot write and the order write
 * are the same arrangement change, and the settle animates an arrangement
 * change once. Two commits would show the deck a frame with the pane arrived
 * but unplaced.
 *
 * Refuses on the same grounds a slot assignment refuses — no imposition, no
 * such pane, a slot outside the arrangement, a pane pinned to a rail — and
 * the drop must read the answer rather than assume it ([P09]).
 */
export function movePaneToSlot(
  deps: ImpositionDeps,
  paneId: string,
  slot: number,
  index?: number,
): SlotAssignment {
  const kind = deps.deck().imposition.kind;
  if (kind === undefined) {
    console.warn("movePaneToSlot: no active imposition; cannot place a pane");
    return { ok: false };
  }
  const pane = deps.deck().panes.find((p) => p.id === paneId);
  if (pane === undefined) {
    console.warn(`movePaneToSlot: no pane "${paneId}"`);
    return { ok: false };
  }
  const hostsSidebar = deps.deck().cards.some(
    (c) => pane.cardIds.includes(c.id) && isSidebarCard(c.componentId),
  );
  if (hostsSidebar) {
    console.warn(`movePaneToSlot: pane "${paneId}" is a sidebar pane`);
    return { ok: false };
  }
  if (!Number.isFinite(slot) || slot < 0 || slot > slotCount(kind) - 1) {
    return { ok: false, blockedCardId: pane.activeCardId };
  }

  const joinsChain = pane.slot === undefined;
  // The raise goes ahead of the geometry for the reason it does in
  // `assignCardsToSlots`: a pane crossing to its new place must travel over
  // the panes it is about to sit in front of, not under them.
  //
  // The raise reveals nothing and neither does the move: a drop is TWO
  // MOVES, on the rule `_revealAfterArrival` states. The first commit puts
  // the card in the slot the hand released it over, at the offset standing,
  // so the crossing lands the card under the hand. The slide that shows it
  // whole is a second commit, after the crossing has ended. Spread into
  // this one, the slide and the crossing rode one settle — the card flew to
  // where it would stand AFTER the slide while the strip slid under it —
  // and the release read as the card hopping backwards.
  transferFocusForActivation({
    outgoingCardId: deps.store.getFirstResponderCardId(),
    incomingCardId: pane.activeCardId,
    store: deps.store,
    commitMutation: () =>
      deps.store.activateCard(pane.activeCardId, { reveal: false }),
  });
  deps.clearBullseyeFor(paneId);

  const placed = clampSlot(kind, slot);
  const deck = deps.deck();
  const panes = deck.panes.map((p) =>
    p.id === paneId ? ({ ...p, slot: placed } as TugPaneState) : p,
  );
  // A pane dropped into the slot it already stands in, with no index named,
  // has not arrived anywhere and keeps its place in the column.
  const stayed =
    pane.slot !== undefined && clampSlot(kind, pane.slot) === placed;
  deps.commitImposition(
    stayed && index === undefined
      ? deck.imposition
      : impositionSeating(deps, deck.imposition, panes, paneId, placed, index),
    panes,
    { retuneRails: joinsChain, revealPaneId: null },
  );
  deps.revealAfterTravel(pane.activeCardId);
  return { ok: true };
}
