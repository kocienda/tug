/**
 * pane-chrome-projection — a pane as its chrome draws it, read off the deck.
 *
 * {@link paneChromeFor} is what the shell publishes to each card's body as
 * `pane.chrome` (`bus/declarations/pane.ts`): the tab set, the composed
 * title, the grips the arrangement offers, the title-bar menus' facts. It is
 * the same reading `TugPane` makes from the props `DeckCanvas` hands it, made
 * here from the deck alone, because a card's page has no canvas to ask.
 *
 * The rules the two readings share are the small functions below it —
 * whether a pane closes, whether its × asks first, whether its bar draws the
 * fold, which edges a slot-keeping resize offers — and `TugPane` calls the
 * same ones, so there is one copy of each.
 *
 * Pure over the deck and the injected readers: the title override, the
 * durable identity, the workspace list. The place badge's facts come from
 * `panePlaceFactsOf`, the badge's own reading. The place runs are not
 * measured here — the canvas measures them — so a split column whose members
 * overflow its run reads as sharing it, which differs from the canvas only
 * in whether that column's seams are offered as grips.
 *
 * @module lib/pane-chrome-projection
 */

import type {
  PaneChromePlace,
  PaneChromeStackEntry,
  PaneChromeTab,
  PaneChromeValue,
  ResizeEdge,
} from "../bus/declarations/pane";
import { getRegistration, getStackSizePolicy, type CardMeta } from "../card-registry";
import { closeAsksOf } from "./close-asks";
import { panePlaceFactsOf } from "./pane-place-facts";
import { columnBadgeCharacter } from "./column-badge";
import {
  bullseyePaneIdOf,
  columnDrawsSplit,
  deckColumnsOf,
  deckFlowStrip,
  findSidebarPanes,
  isSidebarParked,
  isUnboundMember,
  sidebarRailsOf,
  type PlaceRuns,
} from "../deck-store-selectors";
import type { DeckState } from "../layout-tree";
import { isPaneDeparting, standingDeck, withDepartingStanding } from "./departing";
import {
  impositionResizeSlot,
  resolvePlacement,
  sidebarSide,
  travelFraction,
  type SidebarSide,
} from "./layout-imposer";
import { composePaneTitleBarText } from "./pane-title";
import { slotFactsIn } from "./slot-facts";

export type { ResizeEdge } from "../bus/declarations/pane";

/** Every edge and corner: what a pane whose resize releases it offers. */
export const ALL_RESIZE_EDGES: readonly ResizeEdge[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

// ---- The rules TugPane shares ----

/** Whether a pane whose active card has `meta` draws a close box. */
export function paneClosableOf(meta: CardMeta): boolean {
  return meta.closable !== false;
}

/** Whether a pane's bar draws the fold glyph: a content card that does not author its own folded form. */
export function paneCardFoldOf(isRail: boolean, activeComponentId: string | null): boolean {
  return (
    !isRail && activeComponentId !== null && getRegistration(activeComponentId)?.ownsFoldedForm !== true
  );
}

/** What a slot-keeping resize of a pane standing in its slot reads to choose its edges. */
export interface KeepSlotGripFacts {
  layout: "fit" | "flow";
  /** The slot's travel fraction across the band (fit only). */
  fraction: number;
  /** The pane's band in a split column sharing its run, when it stands in one. */
  column: { index: number; count: number } | undefined;
  /** Whether the pane holds a slot height of its own (a Fill Height pane). */
  heightHeld: boolean;
  /** Whether the pane's width is locked by its size policy. */
  widthPinned: boolean;
}

/**
 * The edges a pane offers. A pane whose resize releases it offers all eight.
 * A slot-keeping one offers only what the arrangement lets move: in fit a
 * left edge where the slot has travel to give up and a right edge where it is
 * not the last slot's; in flow the right edge alone; a width-locked card
 * neither; never a corner; and a top or bottom only where it borders a seam
 * of a split column sharing its run, or where the pane holds a height.
 */
export function keepSlotGripsOf(keep: KeepSlotGripFacts | null): ResizeEdge[] {
  if (keep === null) return [...ALL_RESIZE_EDGES];
  return ALL_RESIZE_EDGES.filter((edge) => {
    const column = keep.column;
    if (edge === "n") return column !== undefined && column.index > 0;
    if (edge === "s") {
      if (keep.heightHeld) return true;
      return column !== undefined && column.index < column.count - 1;
    }
    if (keep.widthPinned) return false;
    if (keep.layout === "flow") return edge === "e";
    return (edge === "w" && keep.fraction > 0) || (edge === "e" && keep.fraction < 1);
  });
}

/** The one edge a rail member offers — its deck-facing one — and none while it stands in bullseye. */
export function railGripsOf(side: SidebarSide, bullseye: boolean): ResizeEdge[] {
  if (bullseye) return [];
  return [side === "left" ? "e" : "w"];
}

// ---- The projection ----

/** What the projection reads beyond the deck. A tab carries only its card: the page names it from `deck.cards`. */
export interface PaneChromeReaders {
  /** The live title override a standing card published, or null: the pane's title composes the active card's. */
  titleOf: (cardId: string) => string | null;
  /** Whether a card says it holds nothing a close would lose: what its body published. */
  waives: (cardId: string) => boolean;
  /** The workspace list, and the one this deck's layer shows. */
  spaces: { list: ReadonlyArray<{ id: string; name: string }>; ownSpaceId: string | null };
  /** The place runs, when the caller has measured them. */
  runs?: PlaceRuns;
}

const UNMEASURED_RUNS: PlaceRuns = { rail: null, column: null };

/** The side `paneId` stands on as a rail member — seated, or parked with its rail — or undefined. */
function barSideOf(state: DeckState, paneId: string, runs: PlaceRuns): SidebarSide | undefined {
  for (const rail of sidebarRailsOf(state, runs)) {
    if (rail.members.some((m) => m.paneId === paneId)) return rail.side;
  }
  for (const { componentId, pane } of findSidebarPanes(state)) {
    if (pane.id === paneId && isSidebarParked(state, componentId)) return sidebarSide(state.imposition, componentId);
  }
  return undefined;
}

/** Whether `paneId` stands seated in a rail now (not parked). */
function seatedInRail(state: DeckState, paneId: string, runs: PlaceRuns): boolean {
  return sidebarRailsOf(state, runs).some((rail) => rail.members.some((m) => m.paneId === paneId));
}

/** Where a pane stands, as its chrome and its gestures read it. */
export interface PaneStanding {
  /** The side it stands on as a rail member, seated or parked with its rail. */
  barSide: SidebarSide | undefined;
  /** Whether it stands in bullseye. */
  bullseye: boolean;
  /** Whether it stands in a slot of the imposition (and is not a seated rail member). */
  slotted: boolean;
  /** The column it stands in, when it is slotted. */
  column: { mode: "stack" | "split" } | undefined;
  /** Whether its geometry is derived — pinned, slotted or bullseyed — so a hand move or a released resize evicts it. */
  derived: boolean;
  /** Whether it holds a slot height of its own: alone or stacked in its slot, its height not locked. */
  slotHeightApplies: boolean;
  /** The facts a slot-keeping resize reads, or null when its resize releases it. */
  keepSlot: KeepSlotGripFacts | null;
}

/** Where `paneId` stands on `state`, read as `TugPane` reads it from the props `DeckCanvas` hands it. */
export function paneStandingOf(state: DeckState, paneId: string, runs: PlaceRuns = UNMEASURED_RUNS): PaneStanding {
  const pane = state.panes.find((p) => p.id === paneId);
  const barSide = barSideOf(state, paneId, runs);
  const seated = seatedInRail(state, paneId, runs);
  const kind = state.imposition.kind;
  const placement =
    pane === undefined || kind === undefined || pane.slot === undefined ? undefined : resolvePlacement(kind, pane.slot);
  const imposed = !seated && placement !== undefined;
  const bullseye = bullseyePaneIdOf(state) === paneId;
  const arriving = state.arriving?.[paneId] === true && placement !== undefined;

  const column = deckColumnsOf(state, runs.column).find((c) => c.members.includes(paneId));
  const columnMember =
    column !== undefined && columnDrawsSplit(column)
      ? { index: column.members.indexOf(paneId), count: column.members.length, standing: column.allocation?.standing ?? "shared" }
      : undefined;

  const cardsById = new Map(state.cards.map((c) => [c.id, c]));
  const sizePolicy = getStackSizePolicy(
    (pane?.cardIds ?? []).flatMap((id) => cardsById.get(id)?.componentId ?? []),
    { folded: pane?.folded === true, unbound: isUnboundMember(state, paneId) },
  );
  const widthPinned = sizePolicy.max?.width === sizePolicy.min.width;
  const heightPinned = sizePolicy.max?.height === sizePolicy.min.height;
  const slotHeightApplies = imposed && columnMember === undefined && !heightPinned && !bullseye && !seated && !arriving;

  const keepsSlot =
    impositionResizeSlot(state.imposition) === "keep" && imposed && placement !== undefined && !bullseye && !arriving;
  const flow = placement !== undefined && deckFlowStrip(state)?.positions.get(placement.slot) !== undefined;
  const keepSlot: KeepSlotGripFacts | null =
    !keepsSlot || placement === undefined
      ? null
      : {
          layout: flow ? "flow" : "fit",
          fraction: flow ? 0 : travelFraction(placement),
          column:
            columnMember !== undefined && columnMember.count > 1 && columnMember.standing === "shared"
              ? { index: columnMember.index, count: columnMember.count }
              : undefined,
          heightHeld: slotHeightApplies,
          widthPinned,
        };

  return {
    barSide,
    bullseye,
    slotted: placement !== undefined,
    column: column === undefined ? undefined : { mode: column.mode },
    derived: seated || imposed || bullseye,
    slotHeightApplies,
    keepSlot,
  };
}

/**
 * The `pane.chrome` value for `cardId`, or null when no pane of `deck` holds
 * it. `deck` is the deck the card stands in — the live one, or its parked
 * workspace's record. Every card of a pane gets the same value.
 */
export function paneChromeFor(deck: DeckState, cardId: string, readers: PaneChromeReaders): PaneChromeValue | null {
  const found = deck.panes.find((p) => p.cardIds.includes(cardId));
  if (found === undefined) return null;
  // A departing pane is read over the deck as if it still stood, so its
  // chrome does not change in the middle of its fade; every other pane over
  // the standing deck, which a departing pane is not part of.
  const state = isPaneDeparting(deck, found.id) ? withDepartingStanding(deck) : standingDeck(deck);
  const pane = state.panes.find((p) => p.id === found.id) ?? found;
  const runs = readers.runs ?? UNMEASURED_RUNS;

  const cardsById = new Map(state.cards.map((c) => [c.id, c]));
  const paneCards = pane.cardIds.map((id) => cardsById.get(id)).filter((c) => c !== undefined);
  const multi = paneCards.length > 1;
  // Each card's value is the chrome it shows IN FRONT: a card's page is seen
  // only while its card is the pane's active one, so it draws its own tab
  // active and its own title. A hidden sibling has then already drawn the
  // chrome a tab switch shows, and the switch repaints nothing.
  const activeCard = cardsById.get(cardId) ?? paneCards[0];
  const activeComponentId = activeCard?.componentId ?? null;
  const registration = activeComponentId === null ? undefined : getRegistration(activeComponentId);
  const meta: CardMeta = registration?.defaultMeta ?? { title: "" };
  const isRail = registration?.layoutRole === "sidebar";

  const tabs: PaneChromeTab[] = paneCards.map((card) => ({ cardId: card.id }));

  const title = composePaneTitleBarText({
    metaTitle: meta.title,
    paneTitle: multi ? pane.title : undefined,
    titleOverride: readers.titleOf(activeCard?.id ?? pane.activeCardId),
  });

  // Where the pane stands: a rail member, a slotted pane, or free.
  const standing = paneStandingOf(state, pane.id, runs);
  const barSide = standing.barSide;
  const bullseyed = standing.bullseye;
  const column = standing.column;
  const slotHeightApplies = standing.slotHeightApplies;
  const grips = barSide !== undefined ? railGripsOf(barSide, bullseyed) : keepSlotGripsOf(standing.keepSlot);

  const place = panePlaceFactsOf(deck, pane.id);
  const count = Math.max(place.count, 1);
  const placeOf = (mode: PaneChromePlace["mode"], placeKind: PaneChromePlace["kind"]): PaneChromePlace => ({
    mode,
    kind: placeKind,
    index: place.index,
    band: mode === "split" ? columnBadgeCharacter("split", count, place.index) : null,
    count,
  });
  const placeArrangement: PaneChromePlace | null =
    barSide !== undefined
      ? // A rail of one divides nothing, so its badge reads the count, as a slot of one does.
        placeOf(count > 1 ? "split" : "stack", "rail")
      : standing.slotted
        ? placeOf(column?.mode ?? "stack", "column")
        : null;

  const slotStack: PaneChromeStackEntry[] = place.slotStack.map((entry) => ({
    paneId: entry.paneId,
    cardId: entry.cardId,
    selected: entry.selected,
  }));

  return {
    paneId: pane.id,
    tabs,
    activeCardId: activeCard?.id ?? pane.activeCardId,
    title,
    icon: meta.icon ?? null,
    closable: paneClosableOf(meta),
    close: closeAsksOf({
      cards: paneCards.map((card) => ({ cardId: card.id, componentId: card.componentId, waives: readers.waives(card.id) })),
      activeCardId: activeCard?.id ?? pane.activeCardId,
      isRail,
    }),
    role: isRail ? "sidebar" : "content",
    grips,
    acceptedFamilies: [...pane.acceptsFamilies],
    width: barSide === undefined ? { preset: pane.widthPreset ?? null } : null,
    fillHeight: barSide === undefined && slotHeightApplies ? { fills: pane.slotHeight === undefined } : null,
    placeArrangement,
    bullseye: isRail ? null : bullseyed,
    spaces: isRail ? [] : readers.spaces.list.map((s) => ({ id: s.id, name: s.name })),
    ownSpaceId: readers.spaces.ownSpaceId,
    slotStack,
    cardFold: paneCardFoldOf(isRail, activeComponentId),
    slot: slotFactsIn(deck, activeCard?.id ?? pane.activeCardId) ?? null,
  };
}
