/**
 * opening-placement.ts — which slot a fresh card opens into.
 *
 * One rule for every unaddressed arrival in an arrangement: read the deck's
 * slots once ({@link readOpeningDeck}), then rank them from an anchor
 * ({@link chooseOpeningSlot}). The anchor is the card the gesture was made in
 * when it holds a slot, and the deck itself otherwise.
 *
 * The ranking, in key order: nearest to the anchor; an empty slot before a
 * stacked one; right before left. A split column is not a landing place, so a
 * split slot — and a wall, worse still — is a candidate only when nothing else
 * is, and then walls rank after every other split.
 *
 * Pure over `DeckState` plus the two measurements the manager owns — the
 * column run and the flow band — so it answers without a DOM. It composes the
 * deck's existing readings (`deckColumnsOf`, `columnIsWall`, `deckFlowStrip`,
 * `flowVisibleSlots`, `centerVisibleFlowSlot`) and derives none of them again.
 *
 * Outside it, by design: one-up (which cascades), centered dialogs, rail
 * panes, tab adds, and reuse. Rail panes hold no slot and centered dialogs
 * are never slotted, so neither is in any column this reads.
 *
 * @module lib/opening-placement
 */

import type { DeckState } from "@/layout-tree";
import { columnIsWall } from "@/deck-manager";
import { deckColumnsOf, deckFlowStrip } from "@/deck-store-selectors";
import {
  centerSlot,
  centerVisibleFlowSlot,
  clampSlot,
  columnModeOf,
  flowVisibleSlots,
  impositionLayout,
  slotCount,
  type ImpositionKind,
  type ImpositionLayout,
} from "./layout-imposer";

/** How a slot stands against an arrival. */
export type OpeningSlotClass = "empty" | "stack" | "split" | "wall";

/** One slot of the arrangement, as an opening card reads it. */
export interface OpeningSlot {
  slot: number;
  class: OpeningSlotClass;
  /** The panes standing in it, top to bottom when split; empty when empty. */
  members: readonly string[];
}

/** What the band shows in flow, as slot numbers. */
export interface OpeningBand {
  whole: readonly number[];
  touched: readonly number[];
}

/** The deck, read once, for choosing where a card opens. */
export interface OpeningDeck {
  kind: ImpositionKind;
  layout: ImpositionLayout;
  /** Every slot the kind defines, in slot order. */
  slots: readonly OpeningSlot[];
  /** In flow, the slots the band holds whole and the ones it only clips;
   *  `null` in fit, where every slot is on screen. */
  band: OpeningBand | null;
  /** Where an open with no origin is anchored: the arrangement's middle in
   *  fit, the middle of what the band shows in flow. */
  deckAnchor: number;
}

/** The two measurements the manager owns and the state cannot answer. */
export interface OpeningMeasurements {
  /** The column run, in px, or `null` when the canvas has none measured. */
  run: number | null;
  /** The flow band's width, in px. */
  band: number;
}

/**
 * The deck as an opening card reads it, or `null` when nothing is imposed —
 * a free deck has no slots to choose among.
 */
export function readOpeningDeck(
  state: DeckState,
  { run, band }: OpeningMeasurements,
): OpeningDeck | null {
  const kind = state.imposition.kind;
  if (kind === undefined) return null;
  const columns = new Map(
    deckColumnsOf(state, run).map((column) => [column.slot, column]),
  );
  // A pane still ARRIVING is not standing — its column divides the run
  // without it, so `deckColumnsOf` leaves it out — but it holds its slot all
  // the same. A slot whose only card is one waiting to be revealed is not the
  // held-open place an empty slot is, and a second open must not read it so.
  const held = new Set<number>();
  for (const pane of state.panes) {
    if (pane.slot === undefined || state.arriving?.[pane.id] !== true) continue;
    held.add(clampSlot(kind, pane.slot));
  }
  const slots: OpeningSlot[] = [];
  for (let slot = 0; slot < slotCount(kind); slot++) {
    const column = columns.get(slot);
    if (column === undefined || column.members.length === 0) {
      const cls: OpeningSlotClass = !held.has(slot)
        ? "empty"
        : columnModeOf(state.imposition, slot) === "split"
          ? "split"
          : "stack";
      slots.push({ slot, class: cls, members: [] });
      continue;
    }
    // An arriving pane is outside the column, so no member is the one being
    // opened: any folded member at all makes the column a wall.
    const cls: OpeningSlotClass =
      column.mode === "stack"
        ? "stack"
        : columnIsWall(state.panes, "", column.members)
          ? "wall"
          : "split";
    slots.push({ slot, class: cls, members: column.members });
  }

  const layout = impositionLayout(state.imposition);
  const strip = deckFlowStrip(state);
  if (strip === null) {
    return { kind, layout, slots, band: null, deckAnchor: centerSlot(kind) };
  }
  const input = { strip, band, offset: state.flowOffset ?? 0 };
  const visible = flowVisibleSlots(input);
  return {
    kind,
    layout,
    slots,
    band: {
      whole: visible?.whole ?? [],
      touched: visible?.touched ?? [],
    },
    deckAnchor: centerVisibleFlowSlot(input) ?? centerSlot(kind),
  };
}

/** Where an open is ranked from. */
export type OpeningAnchor =
  /** The card the gesture was made in, standing in `slot`. Its own slot is
   *  never a candidate: a card never covers the one that opened it. */
  | { kind: "origin"; slot: number }
  /** No card to open beside: the deck's own anchor, a candidate itself. */
  | { kind: "deck" };

/** The slot chosen, and what the arrival owes the column it lands in. */
export interface OpeningChoice {
  slot: number;
  class: OpeningSlotClass;
  /** The column's standing members, which a wall arrival folds. */
  members: readonly string[];
  /** The arrival lands in a wall, so the sitters fold in the same commit. */
  wall: boolean;
}

/**
 * The slot a fresh card opens into, ranked from `anchor` over `deck`.
 *
 * Candidates are every slot but a split or a wall, ranked by distance from
 * the anchor, then empty before stack, then right before left. When none
 * qualifies the splits are ranked by the same keys with walls last, and the
 * arrival takes the bottom of the winner ([D194]).
 *
 * A deck-anchored open in flow looks first among the slots the band shows
 * whole, then among those it touches, then across the whole arrangement: a
 * card from nowhere should open where the user can see it. An
 * origin-anchored open ranks over the whole arrangement, because the arrival
 * reveals itself and the origin is what the user is already looking at.
 *
 * `null` only for an arrangement with no slot but the origin's.
 */
export function chooseOpeningSlot(
  deck: OpeningDeck,
  anchor: OpeningAnchor,
): OpeningChoice | null {
  const from = anchor.kind === "origin" ? anchor.slot : deck.deckAnchor;
  const pool = deck.slots.filter(
    (s) => anchor.kind !== "origin" || s.slot !== anchor.slot,
  );
  const tiers: (readonly OpeningSlot[])[] = [];
  if (anchor.kind === "deck" && deck.band !== null) {
    const whole = new Set(deck.band.whole);
    const shown = new Set([...deck.band.whole, ...deck.band.touched]);
    tiers.push(pool.filter((s) => whole.has(s.slot)));
    tiers.push(pool.filter((s) => shown.has(s.slot)));
  }
  tiers.push(pool);

  // A candidate anywhere beats any split; an ordinary split anywhere beats any
  // wall. Within each, the band's tiers narrow before they widen.
  for (const admits of ADMISSION) {
    for (const tier of tiers) {
      const best = bestOf(tier.filter(admits), from);
      if (best !== undefined) return choiceOf(best);
    }
  }
  return null;
}

/** The three passes, in order: candidates, then splits, then walls. */
const ADMISSION: readonly ((slot: OpeningSlot) => boolean)[] = [
  (s) => s.class === "empty" || s.class === "stack",
  (s) => s.class === "split",
  (s) => s.class === "wall",
];

/** The best of `slots` ranked from `from`, or `undefined` when there are none. */
function bestOf(
  slots: readonly OpeningSlot[],
  from: number,
): OpeningSlot | undefined {
  let best: OpeningSlot | undefined;
  for (const slot of slots) {
    if (best === undefined || outranks(slot, best, from)) best = slot;
  }
  return best;
}

/** Whether `a` ranks ahead of `b`: nearer, then empty, then rightward. */
function outranks(a: OpeningSlot, b: OpeningSlot, from: number): boolean {
  const distance = Math.abs(a.slot - from) - Math.abs(b.slot - from);
  if (distance !== 0) return distance < 0;
  const aEmpty = a.class === "empty";
  if (aEmpty !== (b.class === "empty")) return aEmpty;
  return a.slot > b.slot;
}

function choiceOf(slot: OpeningSlot): OpeningChoice {
  return {
    slot: slot.slot,
    class: slot.class,
    members: slot.members,
    wall: slot.class === "wall",
  };
}
