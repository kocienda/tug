/**
 * directional-focus.ts — which card is in that direction.
 *
 * One pure function: given the deck's state, the runs its two kinds of place
 * divide, the card the keyboard is in, and an arrow, name the card the keyboard
 * should move to — or `null` when there is nothing there.
 *
 * **This is a spatial reckoning over the arrangement, not a walk of a ring**
 * ([D184]). The deck's other two focus movers step rings — `previous-tab` /
 * `next-tab` around every visible card, `previous-stack-card` / `next-stack-card`
 * around a stack's depth — and neither consults geometry, so neither can answer
 * "which card is to my left". This can, and the rule it answers by is the
 * brief's, in order:
 *
 *   1. **The candidates are the cards a reader can see or conceive of** — the
 *      front of each column member, plus the members of a showing rail. A free
 *      pane standing in no place is not one: it is in no arrangement, and this
 *      function reckons over the arrangement.
 *   2. **Keep those strictly beyond the source's edge on the arrow's axis.**
 *   3. **Prefer candidates whose perpendicular span overlaps the source's**,
 *      because a card diagonally away is not "to the left" of you.
 *   4. **Among those, nearest edge wins.**
 *
 * ## The three fork points, and where each is decided
 *
 * **A stacked column reads ↑/↓ as z** — front and back. There is no geometry to
 * consult when every member draws the same rect, and refusing would make the
 * chord dead on an unsplit slot. That mirrors `move-in-column` exactly ([P12])
 * and duplicates the ⌥⌘[/] stack ring deliberately: one gesture, one meaning per
 * arrangement. Entered *laterally*, a stacked column hands focus to its
 * **z-frontmost** member — the one answer well defined in both arrangements, and
 * the same one the rail pair's three-state ladder gives.
 *
 * **A target outside the visible band is still a target.** Nothing here reads
 * the flow strip's offset: a slot the strip has slid past the band's edge is
 * inside the reader's mental model (the strip draws the whole arrangement while
 * they are using it), so the target is named and the band travel that makes it
 * visible on arrival is the caller's job.
 *
 * **The all-diagonal case cannot arise, and that is a fact about the deck
 * rather than a choice made here.** The brief left open whether a direction
 * whose candidates are all diagonal should refuse or fall back to nearest-center,
 * to be felt on a real ragged deck. It has no case to decide: a place's members
 * **tile** its run — contiguous spans covering it end to end, which is what a
 * division of a run is — so every occupied place covers its whole strip, and some
 * member of it necessarily overlaps any source span. However ragged two columns'
 * divisions are against each other, a lateral move between them lands. So the
 * refusal below is the **arrangement's edge** and nothing else: no place beyond,
 * rather than no overlapping member in one. It is written as a filter on overlap
 * regardless, because that is the rule, and a rule that happens to be
 * unfalsifiable in today's arrangements is still the one a fourth kind of place
 * would have to be read against.
 *
 * ## The coordinates
 *
 * Places are ordered on one **x ordinal** rather than measured: the left rail
 * sits before every slot, slots run in slot order, the right rail after them
 * all. Content cards share one deck-wide width, so a slot's x band is the same
 * as every other slot's and the ordinal is the whole of the horizontal
 * geometry — which is also why a vertical move never leaves the place it starts
 * in, since no two places overlap in x.
 *
 * Vertically a member's span is a **fraction of its own place's strip**, read
 * through {@link placeSeamFractions} — the deck's one reading of where a place's
 * seams fall, which already answers the equal division for a place whose run
 * nobody has measured — and for one whose floors overflow it, which has no
 * seams inside the run to report. Fractions rather than pixels because a rail's
 * run and a column's are different lengths spanning nearly the same window, so a
 * fraction is the comparable coordinate between them.
 *
 * @module lib/directional-focus
 */

import type { DeckState } from "../layout-tree";
import {
  columnDrawsSplit,
  columnMoveOrder,
  deckColumnsOf,
  placeSeamFractions,
  railAllocationOf,
  railMembersOf,
  type PlaceRuns,
} from "../deck-store-selectors";
import { slotCount, type SidebarSide } from "./layout-imposer";

/** Where a directional focus move is going. The four arrows of the ⌥⌘ band,
 *  named as the reader's motion rather than the key's glyph. */
export type FocusDirection = "left" | "right" | "above" | "below";

/** Narrow an unknown (an action payload) to a direction. */
export function isFocusDirection(value: unknown): value is FocusDirection {
  return (
    value === "left" ||
    value === "right" ||
    value === "above" ||
    value === "below"
  );
}

/** One member of one place, as the reckoning reads it: which card the keyboard
 *  would land on, and the band of its place's strip it draws in. */
interface PlaceMemberSpan {
  readonly paneId: string;
  /** The card focus arrives at — the member pane's front card. */
  readonly cardId: string;
  /** Fraction of the place's strip, top and bottom. A stacked place's members
   *  all span the whole of it, because they all draw the same rect. */
  readonly top: number;
  readonly bottom: number;
}

/**
 * One place in the arrangement — a slot's column or a side's rail — and the
 * members standing in it.
 *
 * `members` is the order a vertical move walks, and it differs by arrangement
 * exactly as `move-in-column` does: **split, top to bottom; stacked, front to
 * back**, so that index 0 is the end "up" travels toward in both and
 * `members[0]` is what a lateral arrival lands on.
 */
interface Place {
  /** The horizontal ordinal: the left rail before every slot, the right rail
   *  after them. Nothing here is a pixel. */
  readonly x: number;
  /** The slot a column stands at, or `null` for a rail — what the band travel
   *  reads, kept beside the ordinal rather than derived back out of it. */
  readonly slot: number | null;
  /** True when every member draws the same rect and the only order is z. */
  readonly stacked: boolean;
  readonly members: readonly PlaceMemberSpan[];
}

/**
 * Every place in the arrangement, left to right.
 *
 * A side's rail is read whether or not anything is imposed — a sidebar holds its
 * side either way — while the columns exist only under an imposition, because a
 * slot is a place in an arrangement and a free deck has none.
 */
function placesOf(state: DeckState, runs: PlaceRuns): readonly Place[] {
  const kind = state.imposition.kind;
  const places: Place[] = [];
  const rail = (side: SidebarSide, x: number): void => {
    const members = railMembersOf(state, side);
    if (members.length === 0) return;
    // A rail is always divided ([D183]), so there is no stacked reading of one.
    const seams = placeSeamFractions(
      railAllocationOf(state, side, runs.rail),
      members.map((member) => member.componentId),
    );
    places.push({
      x,
      slot: null,
      stacked: false,
      members: members.flatMap((member, i) =>
        spanOf(state, member.paneId, seams, i, members.length),
      ),
    });
  };
  rail("left", -1);
  for (const column of kind === undefined
    ? []
    : deckColumnsOf(state, runs.column)) {
    const split = columnDrawsSplit(column);
    // A stack's own order is z, and `columnMoveOrder` is where the deck reads
    // it — front first, the same walk *Move Up in Column* takes. Reading it
    // here rather than reversing `members` ourselves is what keeps the arrow's
    // two families agreeing at the ends, which is the only place either answer
    // is interesting.
    const order = split
      ? column.members
      : columnMoveOrder(state, column.members[0] ?? "");
    places.push({
      x: column.slot,
      slot: column.slot,
      stacked: !split,
      members: order.flatMap((paneId, i) =>
        split
          ? spanOf(state, paneId, column.seams, i, order.length)
          : spanOf(state, paneId, [], 0, 1),
      ),
    });
  }
  rail("right", kind === undefined ? 0 : slotCount(kind));
  return places;
}

/** One member's span from its place's seam fractions — the band between the
 *  seam above it and the seam below, with the place's own ends standing in for
 *  the seams a first and last member do not have. */
function spanOf(
  state: DeckState,
  paneId: string,
  seams: readonly number[],
  index: number,
  count: number,
): PlaceMemberSpan[] {
  const pane = state.panes.find((p) => p.id === paneId);
  if (pane === undefined) return [];
  const top = index === 0 ? 0 : (seams[index - 1] ?? index / count);
  const bottom =
    index === count - 1 ? 1 : (seams[index] ?? (index + 1) / count);
  return [{ paneId, cardId: pane.activeCardId, top, bottom }];
}

/** A band of a place's strip, top and bottom as fractions of it. */
export interface FocusTravelSpan {
  readonly top: number;
  readonly bottom: number;
}

/** Where a directional move lands, and what the run should carry forward. */
export interface FocusTravelTarget {
  /** The card focus arrives at — the target pane's front card. */
  readonly cardId: string;
  readonly paneId: string;
  /** The slot the target stands in, or `null` for a rail member. What the band
   *  travel reads: a rail is pinned to an edge and never off-band. */
  readonly slot: number | null;
  /** The span the run should remember as its goal ([B06]) — see
   *  {@link resolveDirectionalFocus}'s `goal` parameter. */
  readonly goal: FocusTravelSpan;
}

/** How much of the perpendicular axis two spans share. Zero for spans that
 *  merely touch, which is what makes a neighbour across a seam diagonal rather
 *  than beside you. */
function overlapOf(a: FocusTravelSpan, b: FocusTravelSpan): number {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
}

/**
 * Where `direction` leads from `sourceCardId`, or `null` when the
 * arrangement has nothing there.
 *
 * `runs` is the pair every place allocation is derived against, exactly as
 * {@link deckColumnsOf} takes it: a run of `null` is a place nobody has
 * measured, and its members stand at the equal division rather than making the
 * whole reckoning refuse.
 *
 * **`goal` is the travel's memory, and it is a caret's goal column with the
 * axes swapped** ([B06]). A caret remembers the column it started in so that
 * ↑↓ through short lines does not drift sideways; a lateral focus run remembers
 * the **span** it started at so that ← then → returns to the card it left,
 * rather than to whichever band of that column happens to overlap the wider one
 * it landed on. So the goal is preserved by motion ACROSS it — a lateral move
 * passes the same goal back out — and re-established by motion ALONG it, where a
 * vertical move returns its own new span. Pass `null` (or nothing) to start a
 * fresh run from the source's own span.
 *
 * `null` is returned for a source card in no place at all (a free pane, or a
 * card id nothing hosts) as well as for a move the arrangement's edge refuses.
 * The caller tells them apart by not needing to: both are the same visible
 * answer, a flash on the pane that would not move ([D184]).
 */
export function resolveDirectionalFocus(
  state: DeckState,
  runs: PlaceRuns,
  sourceCardId: string,
  direction: FocusDirection,
  goal: FocusTravelSpan | null = null,
): FocusTravelTarget | null {
  const host = state.panes.find((pane) =>
    pane.cardIds.includes(sourceCardId),
  );
  if (host === undefined) return null;
  const places = placesOf(state, runs);
  const from = places.find((place) =>
    place.members.some((member) => member.paneId === host.id),
  );
  if (from === undefined) return null;
  const index = from.members.findIndex(
    (member) => member.paneId === host.id,
  );
  const source = from.members[index];

  if (direction === "above" || direction === "below") {
    // No two places overlap in x, so the perpendicular-overlap rule leaves a
    // vertical move inside the place it started in — for a split that is the
    // band above or below, for a stack the card in front of or behind this one.
    const to = from.members[index + (direction === "above" ? -1 : 1)];
    // A move ALONG the axis the goal describes re-establishes it, which is the
    // caret rule mirrored: the new band is the line the next lateral run holds.
    return to === undefined ? null : targetOf(from, to, to);
  }

  const sign = direction === "left" ? -1 : 1;
  // The line this run is travelling along: the goal it entered with, else this
  // card's own span, which is what starting a run means.
  const line = goal ?? source;
  const beyond = places.filter((place) => sign * (place.x - from.x) > 0);
  const candidates = beyond.flatMap((place) =>
    // A stacked place presents one rect, and the member drawing it is the
    // z-frontmost — so that is the only member of it a lateral move can reach.
    (place.stacked ? place.members.slice(0, 1) : place.members).map(
      (member) => ({ place, member, overlap: overlapOf(line, member) }),
    ),
  );
  const overlapping = candidates.filter(({ overlap }) => overlap > 0);
  if (overlapping.length === 0) return null;
  const nearest = Math.min(
    ...overlapping.map(({ place }) => Math.abs(place.x - from.x)),
  );
  // Every rect of one place shares its x edge, so nearest-edge leaves a split
  // column's bands tied. The one most in front of the reader breaks it — the
  // greatest share of their own span — and the topmost breaks a tie in that.
  const best = overlapping
    .filter(({ place }) => Math.abs(place.x - from.x) === nearest)
    .sort(
      (a, b) => b.overlap - a.overlap || a.member.top - b.member.top,
    )[0];
  // The goal passed straight back out: a lateral move travels ACROSS the line
  // it remembers, so the line is unchanged by having been travelled.
  return best === undefined ? null : targetOf(best.place, best.member, line);
}

/** One target, assembled: the arriving card, the place it stands in, and the
 *  goal the run carries on with. */
function targetOf(
  place: Place,
  member: PlaceMemberSpan,
  goal: FocusTravelSpan,
): FocusTravelTarget {
  return {
    cardId: member.cardId,
    paneId: member.paneId,
    slot: place.slot,
    goal: { top: goal.top, bottom: goal.bottom },
  };
}

/**
 * Which of the four directions would act right now — the menu's `focusTravel`
 * fact ([P05]), or `null` when none would.
 *
 * The same reckoning the handlers run, asked four times, so a menu item is live
 * exactly when its chord would act rather than merely when a card happens to be
 * focused. That equivalence is the whole promotion: AppKit resolves a key
 * equivalent before the web view sees the keydown, so an item this dims is a
 * chord that no longer fires.
 *
 * The goal is deliberately not consulted. Whether a lateral move lands does not
 * depend on the line it is travelling — a place beyond either exists or does not,
 * and if it exists some member of it overlaps any span, because a place's members
 * tile its run. So the fact is the same for a run in progress as for a fresh one,
 * and a menu gate that took a memory as input would be reading state it has no
 * business in.
 */
export function focusTravelDirections(
  state: DeckState,
  runs: PlaceRuns,
  sourceCardId: string | null,
): {
  readonly left: boolean;
  readonly right: boolean;
  readonly above: boolean;
  readonly below: boolean;
} | null {
  if (sourceCardId === null) return null;
  const can = (direction: FocusDirection): boolean =>
    resolveDirectionalFocus(state, runs, sourceCardId, direction) !== null;
  const answer = {
    left: can("left"),
    right: can("right"),
    above: can("above"),
    below: can("below"),
  };
  // All four false collapses two cases — a card in no place at all, and a card
  // alone in a one-up deck with nowhere to go — and it does not matter that it
  // does: both dim all four rows, so `null` is the simpler spelling of the one
  // answer either would produce.
  return answer.left || answer.right || answer.above || answer.below
    ? answer
    : null;
}
