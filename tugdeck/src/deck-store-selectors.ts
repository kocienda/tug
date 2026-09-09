/**
 * deck-store-selectors.ts — derived predicates over `DeckState`.
 *
 * A selector here is a pure function of `DeckState` plus its inputs
 * (typically a `cardId`). No side effects, no memoization, no imports
 * from React. Consumers pick the subscription shape that fits:
 *
 *   - React components subscribe through `useSyncExternalStore` — see
 *     `deck-store-hooks.ts` for the `use*` wrappers built on these
 *     selectors (upholds [L02]).
 *   - Non-React singletons (e.g. the `selectionGuard`, app-lifecycle
 *     plumbing) subscribe to the deck store directly and re-run the
 *     selector inside their subscription callback:
 *
 *     ```ts
 *     const unsubscribe = deckStore.subscribe(() => {
 *       if (isFocusDestination(cardId, deckStore.getSnapshot())) {
 *         // react to the current card being the focus destination
 *       }
 *     });
 *     ```
 *
 * Keeping these derivations pure means the same predicate is reused
 * from both pathways without forking the logic per consumer — the
 * foundation [A1] establishes for [A3] / [A4] in later steps.
 */

import type { DeckState, TugPaneState } from "./layout-tree";
import {
  DEFAULT_GREED_RANK,
  getAllRegistrations,
  getGreedRank,
  getStackSizePolicy,
  isSidebarCard,
} from "./card-registry";
import {
  allocatePlaceHeights,
  clampSlot,
  columnLayoutOf,
  columnModeOf,
  DEFAULT_CONTENT_WIDTH,
  effectiveColumnOrder,
  effectiveRailOrder,
  IMPOSITION_GAP_PX,
  isSidebarPinned,
  railLayoutOf,
  railModeOf,
  RAIL_SEAM_PX,
  railWeightOf,
  stripPositions,
  impositionLayout,
  resolveContentWidthPx,
  slotCount,
  vacancyExtent,
  type ColumnMode,
  type FlowSlotExtent,
  type FlowStrip,
  type PlaceAllocation,
  type PlaceMemberAppetite,
  type SidebarSide,
} from "./lib/layout-imposer";

/**
 * `isFocusDestination(cardId, state)` — returns true iff `cardId`
 * identifies the card that currently deserves the OS keyboard caret
 * ([A1]). Three conditions, all of which must hold:
 *
 *   1. The app is foreground (`state.hasFocus === true`). When the
 *      tugdeck window is blurred, no card is the focus destination —
 *      restoring focus into the DOM while another app owns the caret
 *      would steal focus back (the [R07] class of bugs).
 *   2. The card's host pane is the active pane
 *      (`state.activePaneId === card.paneId`).
 *   3. The card is the active card of that pane
 *      (`pane.activeCardId === cardId`).
 *
 * Returns `false` for unknown `cardId` (card not in the deck, card
 * with no containing pane, pane missing) — the selector degrades
 * quietly in transient states that show up during deck mutations.
 *
 * Pure: the same inputs always produce the same output. Safe to call
 * from any context — React render, effect, non-React subscribe
 * callback.
 */
export function isFocusDestination(
  cardId: string,
  state: DeckState,
): boolean {
  if (!state.hasFocus) return false;
  const pane = state.panes.find((p) => p.cardIds.includes(cardId));
  if (!pane) return false;
  if (state.activePaneId !== pane.id) return false;
  return pane.activeCardId === cardId;
}

/**
 * `findSidebarPane(state, componentId)` — the pane hosting a sidebar card, or
 * `undefined` when that card is closed.
 *
 * A sidebar pane carries no marker of its own: it is the pane holding the card
 * registered under `componentId`. A sidebar card is a singleton and its pane
 * hosts nothing else (`acceptsFamilies: []` and an un-mergeable family), so the
 * derivation is single-valued. This is the one predicate every consumer that
 * needs "which pane is the rail / the Jots card" goes through.
 */
export function findSidebarPane(
  state: DeckState,
  componentId: string,
): TugPaneState | undefined {
  const cardIds = new Set(
    state.cards.filter((c) => c.componentId === componentId).map((c) => c.id),
  );
  if (cardIds.size === 0) return undefined;
  return state.panes.find((p) => p.cardIds.some((cid) => cardIds.has(cid)));
}

/**
 * Every pane hosting a sidebar-role card, paired with the componentId it hosts.
 * The order is the panes array's own (z-order); callers that need a spatial
 * order sort by the side each card holds.
 */
export function findSidebarPanes(
  state: DeckState,
): readonly { componentId: string; pane: TugPaneState }[] {
  const byCardId = new Map<string, string>();
  for (const card of state.cards) {
    if (isSidebarCard(card.componentId)) byCardId.set(card.id, card.componentId);
  }
  if (byCardId.size === 0) return [];
  const out: { componentId: string; pane: TugPaneState }[] = [];
  for (const pane of state.panes) {
    for (const cid of pane.cardIds) {
      const componentId = byCardId.get(cid);
      if (componentId !== undefined) {
        out.push({ componentId, pane });
        break;
      }
    }
  }
  return out;
}

/**
 * `slotStackOf(state, slot)` — every pane holding `slot`, in z-order
 * (last = topmost, the order `DeckState.panes` itself carries). Empty when
 * the slot is unoccupied.
 *
 * `undefined` never matches: a free pane and the rail hold no slot, so they
 * stand in no stack. The membership and the order are both fully determined
 * by state the deck already owns, which is why nothing here is stored — a
 * stored copy could only ever disagree with the array it was copied from.
 */
export function slotStackOf(
  state: DeckState,
  slot: number | undefined,
): readonly TugPaneState[] {
  if (slot === undefined) return [];
  return state.panes.filter((p) => p.slot === slot);
}

// A pane's display name is NOT derived here. It is the string that pane's own
// title bar renders — registry title, multi-tab group prefix, and the live
// `cardTitleStore` override composed together — and it lives in exactly one
// place, `lib/pane-title.ts`. A simpler rule used to live here (the
// `CardState.title` fallback chain) and it disagreed with the title bar for
// every card whose identity is dynamic: a Session card bound to a project read
// `test-repo/petit-thaw` on its title bar and `Untitled` in every list.

/**
 * One row of a stack's picker, already resolved for display.
 *
 * A slot's stack and a stacked rail are ordered topmost-first, matching the
 * host menu-state convention. A SPLIT rail is ordered top to bottom instead —
 * nothing is occluded there, so depth is not what the rows are about.
 *
 * The title bar renders its picker from these and never reaches for the deck
 * store: it has no access to one, and chrome driven entirely by props is what
 * keeps chrome and content in their lanes ([L10]).
 */
export interface SlotStackEntry {
  /** The pane this row raises. */
  paneId: string;
  /**
   * The card id to activate — the pane's `activeCardId`, resolved at
   * projection time so the raise needs no second store read.
   */
  cardId: string;
  /** Display title, from {@link paneDisplayTitle}. */
  title: string;
  /**
   * The pane's icon, as a `lucide-react` name — the same `CardMeta.icon` its
   * own title bar draws, resolved here so a picker row reads as a miniature of
   * the title bar it stands for rather than as a bare list of strings.
   * Absent when the card's registration declares no icon.
   */
  icon?: string;
  /**
   * True for the row the picker checks — which is a different pane by
   * arrangement, and that is why the field is not named for either one. In a
   * stack it is the pane at the front, the only one you can see. In a split
   * every member is visible, so it is the FOCUSED member instead, and no row
   * is checked when focus rests outside the rail.
   */
  selected: boolean;
}

/**
 * `bullseyePaneIdOf(state)` — the pane standing in bullseye, or `null`.
 *
 * The stored `state.bullseyePaneId` is an input to this derivation, not its
 * answer. The id is honored only when a pane with that id still exists AND
 * that pane hosts the current first responder — the same rule
 * `DeckManager.getFirstResponderCardId()` states (`activePaneId` names the
 * pane; that pane's `activeCardId` is the responder), reproduced here rather
 * than imported so the selector stays a pure function of a snapshot.
 *
 * Deriving is what makes the focus-shaped exits hold by construction: raising
 * another pane, the depth and lateral rings, a sidebar chord, and the
 * canvas-background deselect all move the first responder, and every one of
 * them stops this from matching without any of them knowing bullseye exists.
 * A raw id may therefore linger after focus moves; it is unreadable through
 * here and is overwritten by the next toggle.
 *
 * Note the pane, not the card, is the subject: switching tabs within a
 * multi-card bullseyed pane keeps the posture, because the user is still
 * working in the card they bullseyed.
 */
export function bullseyePaneIdOf(state: DeckState): string | null {
  const paneId = state.bullseyePaneId;
  if (paneId === undefined) return null;
  if (state.activePaneId !== paneId) return null;
  const pane = state.panes.find((p) => p.id === paneId);
  if (pane === undefined) return null;
  return pane.cardIds.includes(pane.activeCardId) ? paneId : null;
}

/**
 * `paneRenderWidthOf(state, pane)` — the width a pane PAINTS at: its stored
 * width raised to its stack's size floor.
 *
 * A stored width below the floor is a number the frame never shows, so any
 * geometry packed on it — a band inset from a rail, a strip of slots — would
 * run under an edge the deck actually draws.
 */
export function paneRenderWidthOf(
  state: DeckState,
  pane: TugPaneState,
): number {
  return Math.max(
    pane.size.width,
    getStackSizePolicy(
      state.cards
        .filter((card) => pane.cardIds.includes(card.id))
        .map((card) => card.componentId),
    ).min.width,
  );
}

/**
 * `deckFlowStrip(state)` — where the occupied slots stand when the deck is in
 * flow, or `null` when it is not.
 *
 * **This is the deck's one strip.** Flow spends the placement invariant that
 * makes a slot resolvable from its own pane (see `ImposedPlacement`), so the
 * resolution has to be paid in a single place or the frames and the reveal
 * would be reading two strips that agree only by luck. Both callers come here:
 * `deck-canvas.tsx` to place the frames, and `DeckManager` to compute what the
 * next activation reveals.
 *
 * A slot's extent is its WIDEST member's render width — panes sharing a slot
 * share its place, exactly as they do in fit.
 *
 * **Every slot the kind defines stands here, empty or not.** An unoccupied one
 * reserves the width a card opening in it would take — the deck's content-width
 * preset, which is the same number `_openingSlot`'s card will arrive at — so
 * the arrangement reads by its own numbering and a card assigned to slot 4
 * stands at slot 4 whether or not slot 3 holds anything.
 */
export function deckFlowStrip(state: DeckState): FlowStrip | null {
  if (impositionLayout(state.imposition) !== "flow") return null;
  return deckSlotStrip(state, 0);
}

/**
 * `deckSlotStrip(state, band)` — where this deck's slots stand under whichever
 * geometry it is in, or `null` when it has no numbered places at all.
 *
 * The layout-blind twin of {@link deckFlowStrip}, and the reason it exists is
 * the rail's plan: the drawing has to place a block per slot in both modes, and
 * before this it could only ask about flow. So it derived fit itself, out of
 * nominal units, and the two pictures did not agree — the plan visibly jumped
 * when the layout toggled even though nothing about the deck had moved that
 * far. One resolution, dispatched inside {@link stripPositions}, is the fix
 * and the guarantee.
 *
 * The band is fit's input alone; flow lays its strip out in its own length and
 * meets the band later, through an offset. Pass 0 when the answer is only
 * wanted for a flow deck.
 */
export function deckSlotStrip(
  state: DeckState,
  band: number,
): FlowStrip | null {
  if (state.imposition.kind === undefined) return null;
  const occupied: FlowSlotExtent[] = [];
  for (const pane of state.panes) {
    if (pane.slot === undefined) continue;
    // Clamped to the kind, exactly as `resolvePlacement` clamps it, so the
    // strip is keyed by the slot a pane actually stands in. A stored slot past
    // the kind's last one pulls in rather than opening a place of its own —
    // and two panes pulled onto the same slot share it, widest extent winning.
    occupied.push({
      slot: clampSlot(state.imposition.kind, pane.slot),
      width: paneRenderWidthOf(state, pane),
    });
  }
  return stripPositions(impositionLayout(state.imposition), occupied, {
    band,
    vacancy: {
      count: slotCount(state.imposition.kind),
      extent: deckVacancyExtent(state),
    },
  });
}

/**
 * `deckVacancyExtent(state)` — what a held-open empty slot reserves on this
 * deck: the widest card standing in the chain, or the deck's content width when
 * nothing stands in it. The rule is {@link vacancyExtent}'s; this is the deck's
 * one reading of the inputs, so the strip, the allocator and the vacancy tile
 * cannot reserve three different numbers.
 */
export function deckVacancyExtent(state: DeckState): number {
  const occupied: { slot: number; width: number }[] = [];
  for (const pane of state.panes) {
    if (pane.slot === undefined) continue;
    occupied.push({ slot: pane.slot, width: paneRenderWidthOf(state, pane) });
  }
  return vacancyExtent(
    occupied,
    resolveContentWidthPx(
      state.imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH,
      0,
    ),
  );
}

/**
 * One slot's column: the panes standing in it, how they stand against one
 * another, and — when they divide the run — where the seams fall.
 *
 * The content-side twin of `deck-canvas.tsx`'s `SidebarRail`, and deliberately
 * the same shape: both are a place several panes either take turns in or
 * divide.
 */
export interface DeckColumn {
  slot: number;
  mode: ColumnMode;
  /** The members' pane ids, top to bottom when split. */
  members: readonly string[];
  /** Where the gaps fall, as fractions of the run: `members.length - 1` values
   *  in split mode, empty in a stack (a stack has no gaps to place). */
  seams: readonly number[];
  /** How the column divides its run among its members, or `null` when it has
   *  nothing to divide — a stack, or a canvas with no measured run. */
  allocation: PlaceAllocation | null;
}

/**
 * `deckColumnsOf(state)` — the occupied slots of the imposed chain, in slot
 * order, each with the arrangement its panes stand under.
 *
 * **This is the deck's one reading of its columns**, for the reason
 * {@link deckFlowStrip} is the deck's one strip: the frames' member pins, the
 * seam handles, the arrangement signature, and the seam-property writer all
 * have to agree about which member is at which index, and four independent
 * derivations would agree only by luck.
 *
 * Empty when nothing is imposed: a slot is a place in an arrangement, and a
 * free deck has none.
 *
 * The fallback order — what a column with no stored `order` gets — is the
 * slot's panes **sorted by pane id**, NOT their order in `state.panes`. That
 * array is z-order, and `activateCard` rewrites it: taking it here would make
 * two unarranged members of a split column trade places when the user clicked
 * the lower one. Sorting by id is arbitrary between two panes that arrived
 * together and, far more importantly, is fixed under a raise. It is the same
 * hazard `sidebarRailsOf` avoids by sorting into registration order; a pane has
 * no registration to sort into, and its id is what it has instead.
 *
 * A split column normally never reaches that fallback anyway:
 * `DeckManager.setColumnMode` materializes the order in the same commit that
 * writes the split, so the members land in the front-to-back order they stood
 * in at the moment of the split, and the stored order governs from there.
 */
export function deckColumnsOf(
  state: DeckState,
  columnRun: number | null,
): readonly DeckColumn[] {
  const kind = state.imposition.kind;
  if (kind === undefined) return [];
  const bySlot = columnStandingBySlot(state, kind);
  const columns: DeckColumn[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const members = effectiveColumnOrder(
      state.imposition,
      slot,
      [...(bySlot.get(slot) ?? [])].sort(),
    );
    const mode = columnModeOf(state.imposition, slot);
    const shares = state.imposition.columns?.[slot]?.shares;
    const allocation =
      mode === "split" ? columnAllocationOf(state, slot, columnRun) : null;
    columns.push({
      slot,
      mode,
      members,
      allocation,
      seams:
        mode === "split" ? placeSeamFractions(allocation, members) : [],
    });
  }
  return columns;
}

/** Every occupied slot's panes, keyed by the slot they actually stand in —
 *  clamped exactly as the strip and `resolvePlacement` clamp it, so a column
 *  and a placement never disagree about which slot a pane is in. */
function columnStandingBySlot(
  state: DeckState,
  kind: NonNullable<DeckState["imposition"]["kind"]>,
): Map<number, string[]> {
  const bySlot = new Map<number, string[]>();
  for (const pane of state.panes) {
    if (pane.slot === undefined) continue;
    const slot = clampSlot(kind, pane.slot);
    const members = bySlot.get(slot);
    if (members) members.push(pane.id);
    else bySlot.set(slot, [pane.id]);
  }
  return bySlot;
}

/** One slot's members in the column's own top-to-bottom order — what
 *  {@link deckColumnsOf} reads for that slot, without building the rest. */
export function columnMembersOf(
  state: DeckState,
  slot: number,
): readonly string[] {
  const kind = state.imposition.kind;
  if (kind === undefined) return [];
  const standing = columnStandingBySlot(state, kind).get(slot);
  if (standing === undefined) return [];
  return effectiveColumnOrder(state.imposition, slot, [...standing].sort());
}

/**
 * The runs the deck's two kinds of place divide, measured — the pair every
 * allocation is derived against ([P06]).
 *
 * `null` is a canvas with no height to speak of: a place with no run has no
 * allocation, and the frames fall back to the equal division their `var()`
 * fallbacks have always carried.
 */
export interface PlaceRuns {
  rail: number | null;
  column: number | null;
}

/**
 * Whether a place's run has moved far enough since `last` that the deck has to
 * re-derive its allocations — [P11]'s decision, in one place so it can be
 * stated once and tested.
 *
 * A run of `null` on either side means nobody has measured that place yet, and
 * an unmeasured run is not a MOVED one — on either side of the comparison. The
 * answer at boot is that nothing has changed, and the first measurement is
 * what a later comparison is against.
 *
 * The threshold is a whole pixel, the same one the width allocator's own
 * `moves` check uses, because a sub-pixel run change moves nothing anybody
 * draws and re-allocating for it would arm a settle over frames that are
 * already where they belong.
 */
export function placeRunsMoved(last: PlaceRuns, next: PlaceRuns): boolean {
  const moved = (was: number | null, is: number | null): boolean =>
    was !== null && is !== null && Math.abs(is - was) >= 1;
  return moved(last.rail, next.rail) || moved(last.column, next.column);
}

/**
 * What each member of a place wants of its run: its floor from the stack size
 * policy, its comfort and natural heights, its greed rank, and the weight the
 * user's own seam drags stored.
 *
 * A rail member is named by componentId and a column member by pane id, which
 * is the one thing the two places differ by here — a sidebar card is a
 * singleton, and a slot holds panes that may each be a tab stack.
 *
 * Comfort and natural come from `state.appetites` — the settled mirror of
 * `cardAppetiteStore` ([P05]) — folded across the componentIds a member's pane
 * hosts by `Math.max`, because a tab stack is one box and the box has to suit
 * whichever tab is forward.
 *
 * A member NO card of which declared anything reads its floor for comfort and
 * an ENDLESS natural: it needs the floor to paint and it has said nothing
 * about the height its content is finished at. Endless is what "it did not
 * say" means, and saying instead that it is satisfied at its floor would be a
 * declaration nobody made — one that the seed's slack rule would then act on
 * by handing every spare pixel of the run to somebody else ([B06]). A column
 * of two ordinary content panes seeds to half the run each for this reason:
 * neither is finished, so the seed's fill toward natural divides what is over
 * evenly rather than one of them taking it.
 *
 * `natural` is raised to `comfort` here rather than trusted from the
 * publisher: the seed's water-fill reads `natural` as the ceiling on
 * `comfort`'s step, and a member whose ceiling sat below its own comfort would
 * make the two rungs disagree about the same member.
 */
export function placeMemberAppetites(
  state: DeckState,
  kind: "rail" | "column",
  memberIds: readonly string[],
  shares: Readonly<Record<string, number>> | undefined,
): PlaceMemberAppetite[] {
  return memberIds.map((id) => {
    const pane =
      kind === "rail"
        ? findSidebarPane(state, id)
        : state.panes.find((p) => p.id === id);
    const componentIds =
      pane === undefined
        ? []
        : state.cards
            .filter((card) => pane.cardIds.includes(card.id))
            .map((card) => card.componentId);
    const floor = getStackSizePolicy(componentIds).min.height;
    let greedRank = DEFAULT_GREED_RANK;
    let comfort = floor;
    let natural = floor;
    let declared = false;
    for (const componentId of componentIds) {
      greedRank = Math.min(greedRank, getGreedRank(componentId));
      const appetite = state.appetites?.[componentId];
      if (appetite === undefined) continue;
      declared = true;
      comfort = Math.max(comfort, appetite.comfort);
      natural = Math.max(natural, appetite.natural);
    }
    return {
      id,
      floor,
      comfort,
      natural: declared ? Math.max(comfort, natural) : Infinity,
      greedRank,
      weight: railWeightOf(shares, id),
    };
  });
}

/**
 * `railMembersOf(state, side)` — the members standing on one edge, in the
 * rail's own vertical order, each paired with the pane hosting it.
 *
 * The componentIds are sorted into **registration** order before the
 * imposition's stored order is applied. That is `effectiveRailOrder`'s caller
 * contract, and it cannot be met by accident: `findSidebarPanes` walks
 * `state.panes`, the array `activateCard` reorders, so handing its order
 * straight in would make a split rail with no stored order follow the last
 * raise — click the lower member and the two would swap places. Registration
 * is a boot step, so the order this sorts into is fixed for the session.
 *
 * It lives here rather than in the canvas because the allocation needs it and
 * the canvas is not its only reader: a rail's membership is a fact about the
 * deck, and two derivations of it would agree only by luck.
 */
export function railMembersOf(
  state: DeckState,
  side: SidebarSide,
): readonly { componentId: string; paneId: string }[] {
  const pinned = findSidebarPanes(state).filter(({ componentId }) =>
    isSidebarPinned(state.imposition, componentId),
  );
  if (pinned.length === 0) return [];
  const paneByComponentId = new Map(
    pinned.map(({ componentId, pane }) => [componentId, pane]),
  );
  const registered = [...getAllRegistrations().keys()].filter((componentId) =>
    paneByComponentId.has(componentId),
  );
  const members: { componentId: string; paneId: string }[] = [];
  const order = effectiveRailOrder(state.imposition, side, registered);
  for (const componentId of order) {
    const pane = paneByComponentId.get(componentId);
    if (pane === undefined) continue;
    members.push({ componentId, paneId: pane.id });
  }
  return members;
}

/**
 * How one side's rail divides `run` among its members, or `null` when there is
 * nothing to divide: no rail on that side, a stacked one, or a canvas with no
 * run.
 *
 * A stacked rail has no allocation because every member takes the whole run —
 * that is what a stack IS — and answering with heights would invite a caller
 * to draw a division nobody asked for.
 */
export function railAllocationOf(
  state: DeckState,
  side: SidebarSide,
  run: number | null,
): PlaceAllocation | null {
  if (run === null || !(run > 0)) return null;
  if (railModeOf(state.imposition, side) !== "split") return null;
  const members = railMembersOf(state, side);
  if (members.length === 0) return null;
  return allocatePlaceHeights(
    placeMemberAppetites(
      state,
      "rail",
      members.map((member) => member.componentId),
      state.imposition.rails?.[side]?.shares,
    ),
    run,
    RAIL_SEAM_PX,
    railLayoutOf(state.imposition, side),
  );
}

/** {@link railAllocationOf}'s slot-keyed twin, over a column's panes and the
 *  gap a column divides at. */
export function columnAllocationOf(
  state: DeckState,
  slot: number,
  run: number | null,
): PlaceAllocation | null {
  if (run === null || !(run > 0)) return null;
  if (columnModeOf(state.imposition, slot) !== "split") return null;
  const members = columnMembersOf(state, slot);
  if (members.length === 0) return null;
  return allocatePlaceHeights(
    placeMemberAppetites(
      state,
      "column",
      members,
      state.imposition.columns?.[slot]?.shares,
    ),
    run,
    IMPOSITION_GAP_PX,
    columnLayoutOf(state.imposition, slot),
  );
}

/**
 * A place's allocation as one string — how it stands, and the heights it gave
 * its members, rounded to the pixel they are drawn at.
 *
 * The arrangement signature's rail and column terms, and the reason they are
 * the HEIGHTS rather than the weights behind them: what a settle interpolates
 * is frames, and a place crossing between sharing its run and stacking a strip
 * moves every one of them without any weight changing at all. Rounding is what
 * keeps sub-pixel allocation arithmetic from arming a settle nobody can see.
 *
 * A place with no allocation — a stack, or an unmeasured run — contributes the
 * empty term, which is what it contributed before allocations existed.
 */
export function placeAllocationTerm(
  allocation: PlaceAllocation | null,
): string {
  return `${allocation?.standing ?? "-"}:${
    allocation?.heights.map((height) => Math.round(height)).join("+") ?? ""
  }`;
}

/** The equal division's seam fractions for `count` members: `j + 1` of `count`,
 *  which is exactly the `var()` fallback every member pin already carries. It
 *  is what a place with no measured run has to answer — there is no run to take
 *  the members' floors and weights against yet, and the frame the browser draws
 *  before the properties land is drawn from the fallbacks anyway. */
function equalSeamFractions(count: number): readonly number[] {
  if (count < 2) return [];
  return Array.from({ length: count - 1 }, (_, j) => (j + 1) / count);
}

/**
 * The seam fractions an allocation means: boundary `j` sits where member
 * `j + 1`'s top is, less the half-seam that member surrendered.
 *
 * The inverse of the pins' own arithmetic, so a fraction published from an
 * allocation lands the frame exactly where the allocation put it ([P07]). An
 * overflowing place has no fractions at all — it publishes strip coordinates
 * instead — and a place with no allocation because its run is not measured yet
 * falls back to the equal division, which is what the frames' `var()` fallbacks
 * draw in that frame anyway.
 */
export function placeSeamFractions(
  allocation: PlaceAllocation | null,
  members: readonly string[],
): readonly number[] {
  if (allocation === null) return equalSeamFractions(members.length);
  if (allocation.standing !== "shared") return [];
  const fractions: number[] = [];
  for (let i = 1; i < allocation.tops.length; i += 1) {
    fractions.push((allocation.tops[i] - allocation.seam / 2) / allocation.run);
  }
  return fractions;
}

/**
 * `columnDrawsSplit(column)` — whether the column is DRAWING as a split, which
 * is not the same question as whether `mode` says split.
 *
 * A column of one renders its member across the whole undivided run, and it
 * does so identically in either mode — membership churn never destroys the
 * arrangement, so a slot that was split and lost a member keeps `mode:
 * "split"` waiting for the member to come back. Nothing about that column is
 * divided while it stands alone, and anything describing what is ON SCREEN has
 * to say so.
 *
 * It exists as a function because two surfaces were each deciding it for
 * themselves and drifted: `deck-canvas.tsx` gated the member placement on
 * `mode === "split" && members.length >= 2`, which is what the pane's own
 * cluster reads, while `columnBadgeFactsOf` asked only about `mode`. The same
 * lone card then wore a stack badge on its masthead and a split band letter —
 * `A`, an address matched against nothing — on its rail row. Two surfaces
 * contradicting each other about one card is not a bug either of them can be
 * blamed for; it is a rule that was written down twice.
 */
export function columnDrawsSplit(column: DeckColumn): boolean {
  return column.mode === "split" && column.members.length >= 2;
}

/** What a column badge draws for one card: which kind of place it stands in,
 *  how many panes share that place, and — for a split — which band it is. */
export interface ColumnBadgeFacts {
  kind: "stack" | "split";
  count: number;
  /** 0-based, front of the run first: a split's topmost band, a stack's
   *  frontmost card. */
  index: number;
}

/**
 * `columnBadgeFactsOf(state, cardId)` — what the card's place is, for the badge
 * that says so. `null` when there is nothing to say: no host pane, or no
 * imposition to stand in.
 *
 * **A place one card deep is still a place**, and it reads `1`. The pane's own
 * cluster has said so since the badge became unconditional there, and a rail
 * row that went blank for the same card said the opposite about it — one
 * surface claiming the card stands somewhere and the other claiming it stands
 * nowhere. The absence also cost the reader the one case where the badge is a
 * door worth opening: a lone card is exactly the card whose place can still be
 * split, and a row with no badge on it gives no hint that it can.
 *
 * Read over {@link deckColumnsOf} and nothing else, which is the deck's one
 * reading of its columns — so a rail row and the pane's own cluster cannot
 * disagree about which member is at which index.
 *
 * **Rails are deliberately out of reach here, and do not need to be in it.**
 * `DeckManager.assignCardsToSlots` and `movePaneToSlot` both refuse a
 * sidebar-hosted pane, so a rail pane carries no `slot` and can never appear in
 * a column; the rails' own membership lives behind `sidebarRailsOf`, which is
 * module-private to `components/chrome/deck-canvas.tsx` and reads the boot-time
 * card registry rather than deck state — not something a pure `(state, cardId)`
 * selector can call without dragging the registry into this layer. It would buy
 * nothing either way: the only sidebar-hosted cards are the rail, Jots, and
 * Overview, none of which is a Session row, and a rail member's badge is
 * already drawn on its own pane from `sidebarStack`.
 */
export function columnBadgeFactsOf(
  state: DeckState,
  cardId: string,
): ColumnBadgeFacts | null {
  const host = state.panes.find((pane) => pane.cardIds.includes(cardId));
  if (host === undefined) return null;
  // The badge is about membership and standing, never about heights, so it
  // reads the members alone rather than allocating a run it does not have.
  const kind = state.imposition.kind;
  if (kind === undefined || host.slot === undefined) return null;
  const members = columnMembersOf(state, clampSlot(kind, host.slot));
  if (!members.includes(host.id)) return null;
  const count = members.length;
  // Where the card stands in its place, for BOTH kinds. A stack answered 0
  // flat once, which meant every row of a three-deep slot drew the same badge
  // and the one thing a reader of a list wants to know — which of these is in
  // front — was the one thing it would not say.
  //
  // Read through `columnMoveOrder` rather than off `column.members`, because
  // for a stack those are different orders and only one of them is visible:
  // members is the split band order (panes sorted by id), while a stack's only
  // perceptible ordering is z. It is also the order *Move Up in Column*
  // walks, so the marked end and the direction that verb travels agree by
  // construction rather than by two functions happening to match.
  const index = Math.max(columnMoveOrder(state, host.id).indexOf(host.id), 0);
  const drawsSplit =
    columnModeOf(state.imposition, clampSlot(kind, host.slot)) === "split" &&
    count >= 2;
  if (!drawsSplit) return { kind: "stack", count, index };
  return { kind: "split", count, index };
}

/**
 * `columnMoveOrder(state, paneId)` — the sequence a move-in-column verb walks
 * for the pane, or empty when the pane stands in no column.
 *
 * Split, that is the column's member order, top to bottom. Stacked, nothing is
 * above anything — every member draws the same rect — so the only ordering the
 * user can see is z, reversed so index 0 is the front and "up" is one index
 * earlier in both arrangements.
 *
 * One reading, because two callers ask: `DeckManager.moveInColumn` performs the
 * move, and the menu's `column` fact says whether the move would be refused. A
 * fact derived from a second walk would disagree with the verb exactly at the
 * ends, which is the only place either answer is interesting.
 */
export function columnMoveOrder(
  state: DeckState,
  paneId: string,
): readonly string[] {
  const kind = state.imposition.kind;
  if (kind === undefined) return [];
  const pane = state.panes.find((p) => p.id === paneId);
  if (pane?.slot === undefined) return [];
  const slot = clampSlot(kind, pane.slot);
  if (columnModeOf(state.imposition, slot) === "split") {
    return columnMembersOf(state, slot);
  }
  return state.panes
    .filter((p) => p.slot !== undefined && clampSlot(kind, p.slot) === slot)
    .map((p) => p.id)
    .reverse();
}

/**
 * `countWorkCards(state)` — how many cards the user is working in, i.e. every
 * card that is not a rail. The sidebar cards are app furniture (they open by
 * factory default), so anything asking "does this deck hold work yet" — the
 * setup wizard's "start a session" step, the copy that reads a deck as busy —
 * counts through here rather than off `state.cards.length`.
 */
export function countWorkCards(state: DeckState): number {
  return state.cards.filter((c) => !isSidebarCard(c.componentId)).length;
}
