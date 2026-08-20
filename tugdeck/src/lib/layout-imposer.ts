/**
 * layout-imposer.ts — the geometry of layout imposition.
 *
 * In printing, *imposition* is the arrangement of pages onto the press sheet so
 * that each one lands at its correct position. The imposer does the same for
 * deck panes: an **imposition** (one-up through six-up) defines numbered
 * **slots**, and a pane assigned to a slot is placed at that slot's position in
 * a chain of cards running across the canvas.
 *
 * A slot is a position anchor, **not a rect**. Nothing here computes, clamps, or
 * suggests a width — the pane's own width is an input that passes straight
 * through to the output. When the assigned panes are wider than the canvas,
 * they run off the far edge — an ordinary outcome, not an error.
 *
 * ## Where a slot is
 *
 * A slot is an **anchor at a fixed fraction of the band**, and nothing else in
 * the deck moves it. **Numbering always runs left to right** — slot 1 is the
 * leftmost position on the deck, whatever side the Lens holds and whether or
 * not it is open. A number that means "left" on one deck and "right" on another
 * is a number you have to think about before you can use it.
 *
 * Slot 0 hugs the band's left edge; the last slot hugs its right. In between
 * the anchors space evenly. One rule says all of it — for a pane of width `w`
 * in slot `k` of an `N`-slot imposition, measured from the band's left edge:
 *
 * ```
 *   offset = k / (N - 1) × max(0, band - w)
 * ```
 *
 * `band - w` is the pane's **travel**: how far it can slide before its right
 * edge leaves the band. At slot 0 it has travelled none of it and sits on the
 * band's left edge; at slot `N-1` it has travelled all of it and its right edge
 * lands exactly on the band's right edge. That is what makes "the card in the
 * last slot is the one at the far end" true by construction rather than by
 * arithmetic that happens to work out.
 *
 * **One-up is the one exception.** A single anchor has no ends to space against
 * the edges — the rule reads `0 / 0` — so its slot takes half the travel and
 * the card stands centered in the band. See {@link travelFraction}.
 *
 * The consequence worth naming: **a pane's position depends on its own width
 * and nothing else's.** Closing, widening, or adding a card leaves every other
 * card exactly where it was — a slot is a place in the arrangement, never a
 * place in a queue. Slack therefore spreads evenly between the cards rather
 * than pooling beside the Lens; an arrangement that stays still is worth more
 * than one whose margins collect in one place.
 *
 * When the cards are wider than their share, the offsets crowd together and the
 * cards **overlap** — an ordinary outcome of a narrow deck. A pane wider than
 * the whole band has no travel at all (`max(0, …)`) and sits on the far edge in
 * every slot.
 *
 * The Lens is imposed too, by {@link imposeSidebarStyle}, but it is the strip's
 * fixed end rather than a link in the chain: it holds its pin and its width
 * while the cards absorb the crowding.
 *
 * ## Where the numbers come from
 *
 * The width is the pane's own ([L09] — panes own their geometry); the band is
 * the container, which only CSS knows. So the offset is written as a `calc()`
 * over `100%` and the browser resolves it during its own reflow — no
 * measurement, and no resize observation anywhere on the deck. Widen the window
 * and the crowding eases off on its own.
 *
 * Every horizontal pin is emitted as `left`, including the ones measured from
 * the right edge (as `100% - …`). A frame that is always positioned by the same
 * property can *transition* between two arrangements; one that switches from
 * `right` to `left` can only cut.
 *
 * ## The space allocator
 *
 * The placement rule takes the band as given, so whatever the band's width
 * leaves over shows up as slack between the cards: a deck a little too wide
 * spreads them apart, a deck a little too narrow overlaps them. Nothing inside
 * the rule can absorb that — card widths belong to the panes, and an offset is a
 * pure function of the band.
 *
 * One number can. The pinned sidebar rails are the band's other ends, so their
 * total width and the band's are the same quantity read from opposite sides.
 * The **space allocator** ({@link allocateSidebarWidths}) chooses the total
 * that gives the chain its best picture — scored on the geometry the browser
 * actually paints ({@link seamPicture}): no occlusion first, then no cramped
 * seam, then no raggedness, then as close to the widths the user chose as all
 * of that allows — and then hands that total out to the rails in registered
 * greed order, between two floors and under a shared ceiling. Each rail gets
 * its OWN width; a wide reading rail no longer drags a list rail wide with it.
 *
 * **The moments.** The deck re-solves when the user asks it to arrange itself:
 * a click in the Layouts section, a card assigned to a slot (the imposer's own
 * verb, whichever door dispatched it — the Lens's slot picker or a ⌘N chord),
 * and a canvas that comes to rest at a new size. Everything else — dragging a
 * card out of the chain, closing one — leaves the rails alone, since the user
 * was moving a card and did not ask for their rail to be resized. At those
 * moments the answer is computed, not judged: the allocator is a total
 * function of the canvas, the chain, and the rails' policies.
 *
 * Pure module: no DOM, store, or React runtime imports — the same discipline as
 * `snap.ts`. (`React.CSSProperties` below is a type-only import.)
 *
 * @module lib/layout-imposer
 */

import type React from "react";


/** The active N-up rule. */
export type ImpositionKind =
  | "one-up"
  | "two-up"
  | "three-up"
  | "four-up"
  | "five-up"
  | "six-up";

/** Which side of the deck a sidebar card holds. */
export type SidebarSide = "left" | "right";

/**
 * How the deck resolves a slot into a position.
 *
 * `"fit"` is the travel-fraction rule this module was written around: a slot is
 * an anchor at a fixed fraction of the band, a pane's place depends on its own
 * width and nothing else's, and a deck too narrow for its cards overlaps them.
 *
 * `"flow"` reads the same slots as ordinal positions in a strip: the occupied
 * slots stand side by side in index order, each taking its own extent, and a
 * strip wider than the band runs off the right edge instead of crowding. The
 * two modes share `kind` — the slot vocabulary, the ⌘1..9 range, the miniature
 * — and disagree only about where slot k lands.
 */
export type ImpositionLayout = "fit" | "flow";

/** The layout mode a deck reads under when it has never said otherwise, and
 *  what every blob written before the mode existed means. */
export const DEFAULT_IMPOSITION_LAYOUT: ImpositionLayout = "fit";

/**
 * The deck-wide content width, as one of three named presets. Absent reads as
 * `"comfy"`, which is the width content cards have always opened at — so a blob
 * written before the presets existed migrates to exactly its own behavior.
 */
export type ContentWidth = "slim" | "comfy" | "wide";

/** One sidebar card's standing in the deck: which edge it holds, and whether it
 *  is standing at that pin. */
export interface SidebarEntry {
  /** The side this card holds; the arrangement is numbered away from it. */
  side: SidebarSide;
  /**
   * Whether the card is standing at its pin. Absent reads as pinned.
   *
   * Dragging the card by its title bar sets this false: it becomes an ordinary
   * free pane, and the arrangement then spans the whole canvas exactly as it
   * does when the card is closed. Choosing anything in the Layouts section puts
   * it back — that is the gesture that means "this card belongs on this side".
   *
   * The side survives the float, so re-pinning returns the card to the edge it
   * came from rather than to a default.
   */
  pinned?: boolean;
}

/** How a side's sidebar cards stand against one another. */
export type RailMode = "stack" | "split";

/** How the content cards sharing one slot stand against one another. The same
 *  two words a rail uses, and deliberately a separate name: a slot is a
 *  different place, and a column mode is read from a different record. */
export type ColumnMode = "stack" | "split";

/** Where a move-in-column chord sends its member: one place either way, or all
 *  the way to an end ([P12]). */
export type ColumnMoveTarget = "up" | "down" | "top" | "bottom";

/** Narrow an unknown (an action payload) to a move target. */
export function isColumnMoveTarget(
  value: unknown,
): value is ColumnMoveTarget {
  return (
    value === "up" || value === "down" || value === "top" || value === "bottom"
  );
}

/**
 * How one side's rail is arranged: stacked front-to-back (the default, and what
 * a rail has always been) or divided vertically so every member is visible at
 * once.
 *
 * Split is a property of the SIDE, not of a pair of cards: all of a side's
 * visible members participate, and there are no sub-groups. Two or three cards
 * do not need a tree, and a tree is where this surface's complexity would go.
 *
 * `order` and `shares` outlive the members they name. A card closing is an
 * internal operation and must not destroy the arrangement the user chose
 * ([L23]), so nothing here is ever cleaned up: close a split member and the
 * remaining one takes the full run, reopen it and the split re-applies at the
 * order and heights it had.
 */
export interface RailArrangement {
  /** Absent reads as `"stack"` — today's behavior, on an unchanged blob. */
  mode?: RailMode;
  /**
   * The members' vertical order, top to bottom, by componentId. Absent means
   * registration order — see {@link effectiveRailOrder}, which also tolerates
   * ids named here that are not currently standing.
   */
  order?: string[];
  /**
   * Each member's height weight, keyed by componentId; an unnamed member weighs
   * 1, so an absent record is an equal division.
   *
   * Weights rather than positions: membership churns, and a positional array
   * would hand a departing card's height to whoever inherits its index.
   */
  shares?: Record<string, number>;
}

/**
 * How the content cards sharing one slot stand against one another: the same
 * three fields a rail carries, over a place that runs down a column of the deck
 * rather than down an edge.
 *
 * Deliberately the same shape as {@link RailArrangement}, because a slot and a
 * rail are the same kind of place — a run of vertical space several cards may
 * either take turns in or divide. Sharing the shape is what lets
 * {@link railSeamFractions} and {@link railSharesFromFractions} serve both
 * without a fork; they take an arrangement's parts rather than a side, so they
 * were already place-agnostic before a column existed.
 *
 * The one real difference is what a member is called. A rail keys its members
 * by `componentId`, because a sidebar card is a singleton: one componentId, one
 * pane, one card, all the way down. A slot has no such identity to borrow. Two
 * Session cards are two cards, so componentId cannot name a member; and a slot
 * holds *panes*, each of which may itself be a tab stack of several cards, so
 * neither can a card id — a member named by the card it is showing would be
 * renamed by switching tabs, and the arrangement would move under a gesture
 * that changed nothing about the layout.
 *
 * So a column keys its members by **pane id**, which is what a member actually
 * is. The persistence strength is the same as a card id's and weaker than a
 * rail's either way: a pane id dies with its pane, so a closed member's entries
 * here are inert residue that no reopened card will reclaim ([Q03]). That is
 * accepted — residue is harmless, since nothing standing is named by it — and
 * it is the cost of a place whose occupants have no type-level identity.
 */
export interface ColumnArrangement {
  /** Absent reads as `"stack"` — cards in a slot take turns, as they always did. */
  mode?: ColumnMode;
  /**
   * The members' vertical order, top to bottom, by pane id. Absent means the
   * slot's own pane order — see {@link effectiveColumnOrder}, which also
   * tolerates ids named here that are no longer standing in the slot.
   */
  order?: string[];
  /**
   * Each member's height weight, keyed by pane id; an unnamed member weighs 1,
   * so an absent record is an equal division.
   */
  shares?: Record<string, number>;
}

/**
 * The deck's layout imposition: the N-up rule the chain of content cards is
 * packed under, the width those cards open at, where each sidebar card stands,
 * and how each side's rail is arranged.
 *
 * The axes are independent. `kind` absent means no card is imposed — the deck
 * is free — while the sidebars still hold their sides, because a sidebar has a
 * side whether or not anything is arranged against it.
 */
export interface DeckImposition {
  /** The N-up rule, or absent when nothing is imposed. */
  kind?: ImpositionKind;
  /** The deck-wide content width; absent reads as {@link DEFAULT_CONTENT_WIDTH}. */
  contentWidth?: ContentWidth;
  /**
   * How slots resolve into positions; absent reads as
   * {@link DEFAULT_IMPOSITION_LAYOUT}, so every deck that predates the mode
   * comes back exactly as it stood.
   *
   * Independent of `kind`, which keeps naming how many slots there are in
   * either mode.
   */
  layout?: ImpositionLayout;
  /**
   * Where each sidebar card stands, keyed by its registered `componentId`.
   *
   * A card absent from the map has never been placed and takes
   * {@link DEFAULT_SIDEBAR_SIDE} when it first opens. The map is keyed by
   * componentId rather than by card id because a sidebar card is a singleton:
   * its side is a property of the card *type*, and survives the pane being
   * closed and reopened.
   */
  sidebars: Record<string, SidebarEntry>;
  /**
   * How each side's rail is arranged. Absent — for a side or for the record —
   * reads as a stack, which is what every rail was before splitting existed and
   * what every rail still is until the user says otherwise.
   *
   * Keyed by side rather than folded into {@link SidebarEntry} because the
   * arrangement belongs to the rail: two cards sharing a side cannot disagree
   * about whether they are stacked.
   */
  rails?: { left?: RailArrangement; right?: RailArrangement };
  /**
   * How the cards in each slot are arranged, keyed by slot index. Absent — for
   * a slot or for the record — reads as a stack, which is what every slot was
   * before splitting reached the content columns.
   *
   * Keyed by slot rather than by pane because the arrangement belongs to the
   * place: a slot keeps the division the user chose while its cards come and
   * go, exactly as `rails` keeps a side's. Entries for slots the current
   * {@link ImpositionKind} does not reach are kept rather than pruned — a deck
   * dropped from six-up to three-up remembers how its fourth column stood, and
   * gets it back on the way up.
   */
  columns?: Record<number, ColumnArrangement>;
}

/** Where a sidebar card stands when nothing has ever said otherwise. */
export const DEFAULT_SIDEBAR_SIDE: SidebarSide = "right";

/** The width content cards open at when the deck has never said otherwise. */
export const DEFAULT_CONTENT_WIDTH: ContentWidth = "comfy";

/**
 * The side `componentId` holds, or the default when it has never been placed.
 *
 * Total by construction, including on an imposition carrying no `sidebars` map
 * at all: the record arrives from JSON blobs and from seeded test decks as well
 * as from the store, and an unplaced sidebar and an absent map mean the same
 * thing — nobody has said where this card goes.
 */
export function sidebarSide(
  imposition: DeckImposition,
  componentId: string,
): SidebarSide {
  return imposition.sidebars?.[componentId]?.side ?? DEFAULT_SIDEBAR_SIDE;
}

/** Whether `componentId` stands at its pin. Absent reads as pinned — a sidebar
 *  that has never been dragged has never left its side. */
export function isSidebarPinned(
  imposition: DeckImposition,
  componentId: string,
): boolean {
  return imposition.sidebars?.[componentId]?.pinned !== false;
}

/** The imposition with `componentId` standing on `side`, at its pin. */
export function withSidebarSide(
  imposition: DeckImposition,
  componentId: string,
  side: SidebarSide,
): DeckImposition {
  return {
    ...imposition,
    sidebars: { ...imposition.sidebars, [componentId]: { side, pinned: true } },
  };
}

/** The imposition with `componentId` pinned or unpinned, keeping its side. */
export function withSidebarPinned(
  imposition: DeckImposition,
  componentId: string,
  pinned: boolean,
): DeckImposition {
  const side = sidebarSide(imposition, componentId);
  return {
    ...imposition,
    sidebars: { ...imposition.sidebars, [componentId]: { side, pinned } },
  };
}

/**
 * The sidebar componentIds standing on `side`, in the vertical order they hold
 * there: the side's stored `order` filtered to the ids actually standing, then
 * any standing id the stored order does not name, in the order given.
 *
 * **CALLER CONTRACT: `componentIds` must arrive in REGISTRATION order.** This
 * module is pure and cannot reach the card registry, so the fallback order is
 * whatever the caller hands in — and the obvious list to reach for is the wrong
 * one. `findSidebarPanes` walks `state.panes`, the array `activateCard`
 * reorders, so handing that in makes a split rail's default vertical order
 * follow the last raise: click the lower card and the two would trade places.
 * The caller sorts into registration order first ([R06]).
 *
 * Tolerating ids the rail no longer holds is what lets an arrangement survive
 * membership churn: close a split member and its position is still recorded, so
 * reopening it puts it back where it was rather than at the end.
 *
 * A stack's members have a vertical order too — they simply all draw the same
 * rect, so it is invisible there. One function serves both modes: the rail's
 * member enumeration and the badge's picker rows read the same list whether the
 * side is stacked or split, which is also what makes the settle signature's
 * rail term blind to z-order.
 */
export function effectiveRailOrder(
  imposition: DeckImposition,
  side: SidebarSide,
  componentIds: readonly string[],
): readonly string[] {
  const present = componentIds.filter(
    (id) => sidebarSide(imposition, id) === side,
  );
  const stored = imposition.rails?.[side]?.order;
  if (stored === undefined) return present;
  const standing = new Set(present);
  const named = stored.filter((id) => standing.has(id));
  const claimed = new Set(named);
  return [...named, ...present.filter((id) => !claimed.has(id))];
}

/** The arrangement `side` stands under; absent reads as a stack. */
export function railModeOf(
  imposition: DeckImposition,
  side: SidebarSide,
): RailMode {
  return imposition.rails?.[side]?.mode === "split" ? "split" : "stack";
}

/** Narrow an unknown (a parsed blob field, an action payload) to a rail mode. */
export function isRailMode(value: unknown): value is RailMode {
  return value === "stack" || value === "split";
}

/** The side's arrangement with one field replaced, the others untouched. */
function withRailField(
  imposition: DeckImposition,
  side: SidebarSide,
  patch: Partial<RailArrangement>,
): DeckImposition {
  const current = imposition.rails?.[side] ?? {};
  return {
    ...imposition,
    rails: { ...imposition.rails, [side]: { ...current, ...patch } },
  };
}

/** The imposition with `side` stacked or split, keeping its order and shares —
 *  a re-split lands on the arrangement the user last chose, not on a default. */
export function withRailMode(
  imposition: DeckImposition,
  side: SidebarSide,
  mode: RailMode,
): DeckImposition {
  return withRailField(imposition, side, { mode });
}

/** The imposition with `side`'s members in `order`, top to bottom. */
export function withRailOrder(
  imposition: DeckImposition,
  side: SidebarSide,
  order: readonly string[],
): DeckImposition {
  return withRailField(imposition, side, { order: [...order] });
}

/** The imposition with `side`'s height weights replaced. */
export function withRailShares(
  imposition: DeckImposition,
  side: SidebarSide,
  shares: Record<string, number>,
): DeckImposition {
  return withRailField(imposition, side, { shares: { ...shares } });
}

/** The imposition with `side`'s height weights removed — an equal division,
 *  keeping the side's mode and order. */
export function withoutRailShares(
  imposition: DeckImposition,
  side: SidebarSide,
): DeckImposition {
  const current = imposition.rails?.[side];
  if (current?.shares === undefined) return imposition;
  const { shares: _dropped, ...rest } = current;
  return { ...imposition, rails: { ...imposition.rails, [side]: rest } };
}

/**
 * How much of the run a member is worth: its stored weight, or 1.
 *
 * A weight that is not a positive finite number reads as 1 rather than as an
 * error. These arrive from a JSON blob and from gesture arithmetic, and a rail
 * that refuses to lay itself out because one number is `NaN` is worse than a
 * rail that divides evenly.
 */
function railWeightOf(
  shares: Readonly<Record<string, number>> | undefined,
  componentId: string,
): number {
  const weight = shares?.[componentId];
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0
    ? weight
    : 1;
}

/** The narrowest a seam segment may be, as a fraction of the run. Keeps the
 *  fractions strictly increasing and every derived weight positive. */
const RAIL_SEAM_EPSILON = 1e-6;

/**
 * Where the seams fall in a rail of `order`, as cumulative fractions of the
 * vertical run: N members give N−1 strictly increasing values in (0, 1), and
 * `fractions[j]` is where the gap between member `j` and member `j+1` sits.
 *
 * Renormalized over the members actually in `order`, so a rail that lost a
 * member divides what it has rather than leaving a hole where that member was.
 * Computed, never stored — the record holds weights ([P02]), and a fraction is
 * what those weights mean for the members standing right now.
 */
export function railSeamFractions(
  order: readonly string[],
  shares: Readonly<Record<string, number>> | undefined,
): readonly number[] {
  if (order.length < 2) return [];
  const weights = order.map((id) => railWeightOf(shares, id));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const fractions: number[] = [];
  let running = 0;
  for (let i = 0; i < weights.length - 1; i += 1) {
    running += weights[i];
    const fraction = running / total;
    const floor = (i + 1) * RAIL_SEAM_EPSILON;
    const ceiling = 1 - (weights.length - 1 - i) * RAIL_SEAM_EPSILON;
    fractions.push(Math.min(Math.max(fraction, floor), ceiling));
  }
  return fractions;
}

/**
 * The inverse of {@link railSeamFractions}: the weights a set of seam fractions
 * means.
 *
 * Segment lengths *are* the weights, so every member the drag did not touch
 * keeps its ratio to every other untouched member by construction — which is
 * the [P02] property, and the reason a seam drag commits through a named pure
 * function rather than through arithmetic inlined in a pointer handler.
 *
 * Scaled to average 1 per member, so an equal division round-trips to the
 * all-ones record that an absent `shares` already means.
 */
export function railSharesFromFractions(
  order: readonly string[],
  fractions: readonly number[],
): Record<string, number> {
  const shares: Record<string, number> = {};
  if (order.length === 0) return shares;
  if (order.length === 1) return { [order[0]]: 1 };
  // Sanitized on the way in: a non-finite or out-of-order fraction would give a
  // zero-or-negative segment, and a weight of zero is not a height.
  const bounded: number[] = [];
  for (let i = 0; i < order.length - 1; i += 1) {
    const raw = fractions[i];
    const floor = (bounded[i - 1] ?? 0) + RAIL_SEAM_EPSILON;
    const ceiling = 1 - (order.length - 1 - i) * RAIL_SEAM_EPSILON;
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : floor;
    bounded.push(Math.min(Math.max(value, floor), ceiling));
  }
  const scale = order.length;
  let previous = 0;
  for (let i = 0; i < order.length; i += 1) {
    const upper = i === order.length - 1 ? 1 : bounded[i];
    shares[order[i]] = (upper - previous) * scale;
    previous = upper;
  }
  return shares;
}

/**
 * The custom property carrying seam `index` on `side`, as a plain number in
 * (0, 1) — the fraction of the run the seam sits at.
 *
 * Deliberately unregistered, the same discipline {@link sidebarWidthProperty}
 * holds: every expression reading one supplies the equal-division fraction as
 * its `var()` fallback, so a frame that renders before the properties land
 * still tiles the rail.
 */
export function railSeamProperty(side: SidebarSide, index: number): string {
  return `--tug-rail-${side}-seam-${index}`;
}

/** One split member's place in its rail: which side, which position, and how
 *  many members it divides the run with. */
export interface RailMemberPlacement {
  side: SidebarSide;
  index: number;
  count: number;
}

/** Narrow an unknown (a parsed blob field, an action payload) to a side. */
export function isSidebarSide(value: unknown): value is SidebarSide {
  return value === "left" || value === "right";
}

// ---- Columns: the same arrangement, over a slot ----

/** The arrangement slot `slot` stands under; absent reads as a stack. */
export function columnModeOf(
  imposition: Pick<DeckImposition, "columns">,
  slot: number,
): ColumnMode {
  return imposition.columns?.[slot]?.mode === "split" ? "split" : "stack";
}

/** Narrow an unknown (a parsed blob field, an action payload) to a column mode. */
export function isColumnMode(value: unknown): value is ColumnMode {
  return value === "stack" || value === "split";
}

/** The slot's arrangement with one field replaced, the others untouched. */
function withColumnField(
  imposition: DeckImposition,
  slot: number,
  patch: Partial<ColumnArrangement>,
): DeckImposition {
  const current = imposition.columns?.[slot] ?? {};
  return {
    ...imposition,
    columns: { ...imposition.columns, [slot]: { ...current, ...patch } },
  };
}

/** The imposition with `slot` stacked or split, keeping its order and shares —
 *  a re-split lands on the arrangement the user last chose, not on a default. */
export function withColumnMode(
  imposition: DeckImposition,
  slot: number,
  mode: ColumnMode,
): DeckImposition {
  return withColumnField(imposition, slot, { mode });
}

/** The imposition with `slot`'s members in `order`, top to bottom. */
export function withColumnOrder(
  imposition: DeckImposition,
  slot: number,
  order: readonly string[],
): DeckImposition {
  return withColumnField(imposition, slot, { order: [...order] });
}

/** The imposition with `slot`'s height weights replaced. */
export function withColumnShares(
  imposition: DeckImposition,
  slot: number,
  shares: Record<string, number>,
): DeckImposition {
  return withColumnField(imposition, slot, { shares: { ...shares } });
}

/**
 * The imposition with every column's order narrowed to the panes actually
 * standing in that slot.
 *
 * A column is keyed by pane id, and a pane can leave the slot it was recorded
 * in without the record being asked about it: `assignCardsToSlots` writes a new
 * `slot` onto the pane and commits the imposition untouched, and changing the
 * imposition's kind re-clamps every pane, collapsing the slots above the new
 * last one. Both leave the departed member named in a column it no longer
 * stands in — which is exactly what invariant 9 refuses, so the next validate
 * throws and the deck comes up on the error overlay.
 *
 * The drop, rather than a hold: this is the policy {@link withColumnOrder}'s
 * caller already applies on every explicit reorder ("ids the column does not
 * currently hold are dropped"), because a place kept for a pane id is a place
 * nothing can return to. A member that leaves and comes back arrives as a
 * newcomer, which is what {@link effectiveColumnOrder} already does with it.
 *
 * Membership is read from the pane's RAW slot, not its clamped one — the same
 * reading the invariant makes, and the one the record has to satisfy. (The
 * clamped reading in `deckColumnsOf` answers a different question: which column
 * DRAWS the pane.)
 *
 * Returns the same object when nothing moved, so a commit that changes no
 * membership allocates nothing and compares equal.
 */
export function sweptColumnOrders(
  imposition: DeckImposition,
  panes: readonly { readonly id: string; readonly slot?: number }[],
): DeckImposition {
  const columns = imposition.columns;
  if (columns === undefined) return imposition;
  const slotByPaneId = new Map(panes.map((pane) => [pane.id, pane.slot]));
  let changed = false;
  const next: Record<number, ColumnArrangement> = {};
  for (const [key, arrangement] of Object.entries(columns)) {
    const slot = Number(key);
    const order = arrangement.order;
    if (order === undefined) {
      next[slot] = arrangement;
      continue;
    }
    // A pane id that names no live pane is residue, and residue is inert — the
    // invariant tolerates it and `effectiveColumnOrder` skips it. Only a LIVE
    // pane standing elsewhere is a lie about membership.
    const kept = order.filter((paneId) => {
      if (!slotByPaneId.has(paneId)) return true;
      return slotByPaneId.get(paneId) === slot;
    });
    if (kept.length === order.length) {
      next[slot] = arrangement;
      continue;
    }
    changed = true;
    next[slot] = { ...arrangement, order: kept };
  }
  return changed ? { ...imposition, columns: next } : imposition;
}

/** The imposition with `slot`'s height weights removed — an equal division,
 *  keeping the slot's mode and order. */
export function withoutColumnShares(
  imposition: DeckImposition,
  slot: number,
): DeckImposition {
  const current = imposition.columns?.[slot];
  if (current?.shares === undefined) return imposition;
  const { shares: _dropped, ...rest } = current;
  return { ...imposition, columns: { ...imposition.columns, [slot]: rest } };
}

/**
 * The order slot `slot`'s members stand in, top to bottom, given the pane ids
 * actually standing there.
 *
 * The exact shape of {@link effectiveRailOrder}, and for the same reasons: the
 * stored order is a preference over members that come and go, so ids it names
 * that are not standing are skipped, and ids standing that it does not name
 * follow in the order they were handed in. A slot with no stored order takes
 * that order whole, which is the slot's own pane order — the depth order a
 * stack already shows.
 */
export function effectiveColumnOrder(
  imposition: Pick<DeckImposition, "columns">,
  slot: number,
  paneIds: readonly string[],
): readonly string[] {
  const stored = imposition.columns?.[slot]?.order;
  if (stored === undefined) return paneIds;
  const standing = new Set(paneIds);
  const named = stored.filter((id) => standing.has(id));
  const claimed = new Set(named);
  return [...named, ...paneIds.filter((id) => !claimed.has(id))];
}

/** Narrow an unknown (a parsed blob field, an action payload) to a width. */
export function isContentWidth(value: unknown): value is ContentWidth {
  return value === "slim" || value === "comfy" || value === "wide";
}

/** Every imposition kind, in ascending slot count — the Lens picker's order. */
export const IMPOSITION_KINDS: readonly ImpositionKind[] = [
  "one-up",
  "two-up",
  "three-up",
  "four-up",
  "five-up",
  "six-up",
];

/**
 * The arrangement a deck stands under when nothing has said otherwise — the
 * factory default on a fresh install, and the fallback an absent or unreadable
 * blob kind restores under. An imposition is always active; there is no off.
 */
export const DEFAULT_IMPOSITION_KIND: ImpositionKind = "three-up";

/**
 * The **imposition gap**: the space an imposed pane keeps from the canvas
 * edges, from the Lens rail, and from the pane in the neighbouring slot.
 *
 * This is the same gap the Option-drag snap holds between two card edges —
 * `tug-pane.tsx` imports it for `computeSnap` / `computeResizeSnap` rather than
 * declaring its own. A pane placed by the imposer and a pane snapped by hand
 * therefore land on the same rhythm.
 */
export const IMPOSITION_GAP_PX = 5;

/**
 * The **bottom** imposition gap, which is deliberately deeper than the other
 * three. A heavier bottom margin than top is as old as the printed page, and
 * an arrangement that reaches the same distance from every edge reads as
 * sinking; the extra depth is what makes it sit.
 *
 * It also has to do a job. The host draws a dev-info strip in the canvas's
 * bottom-left corner — the branch, revision, and build stamps — 8px above the
 * canvas bottom and about 19px tall. A pane imposed to the ordinary gap runs
 * straight through it. This depth clears the strip and leaves one ordinary gap
 * of air above it, so nothing imposed ever collides with the stamps.
 */
export const IMPOSITION_GAP_BOTTOM_PX = 32;

/* ---------------------------------------------------------------------------
 * Content width presets
 * ---------------------------------------------------------------------------*/

/**
 * What each {@link ContentWidth} is, in pixels.
 *
 * **Slim (675)** is the narrow reading width the Session card's chrome was put
 * on a diet to reach; **comfy (800)** is what every content card shipped at
 * before the presets existed, which is why a record with no `contentWidth`
 * reads as comfy; **wide (1230)** is comfy scaled by that same ratio again,
 * for a card holding code and prose at once.
 *
 * A width is applied by a *command*, through `movePane` — the imposer still
 * passes width through untouched, so [D121]'s "a slot is a position anchor,
 * not a rect" is unaffected. Each is one named constant, so retuning `wide`
 * (the one the brief marks as taste) stays a one-line change.
 */
export const CONTENT_WIDTH_SLIM_PX = 675;
export const CONTENT_WIDTH_COMFY_PX = 800;
export const CONTENT_WIDTH_WIDE_PX = 1230;

/** The widths in the order every picker offers them: narrow to wide. */
export const CONTENT_WIDTH_PRESETS: readonly ContentWidth[] = [
  "slim",
  "comfy",
  "wide",
];

/** Pixels per width. */
export const CONTENT_WIDTH_PX: Readonly<Record<ContentWidth, number>> = {
  slim: CONTENT_WIDTH_SLIM_PX,
  comfy: CONTENT_WIDTH_COMFY_PX,
  wide: CONTENT_WIDTH_WIDE_PX,
};

/** How each width is named in the UI — one spelling, every surface. */
export const CONTENT_WIDTH_LABELS: Readonly<Record<ContentWidth, string>> = {
  slim: "Slim",
  comfy: "Comfy",
  wide: "Wide",
};

/**
 * The width a pane actually lands on when `preset` is applied to it: the
 * preset's pixels, held between the pane's own minimum and maximum.
 *
 * Neither bound is decoration. `movePane` does not clamp — it writes the rect it
 * is handed — so a preset resolved outside the stack's policy would be stored at
 * one width and painted at another until the next resize. The floor matters
 * because a stack's `sizePolicy.min.width` can be wider than a preset (Settings'
 * 720 beats slim's 675); the ceiling matters because a card can be size-locked
 * (About is 320 wide, min and max both), and the deck-wide default reaches every
 * content pane, including those.
 *
 * A card whose bounds beat the preset still gets the *stamp*: the user picked
 * that row, and the width they got is as close to it as the card allows. Pure so
 * both appliers — the per-pane popup and the deck-wide default — resolve
 * identically, and so the arithmetic is testable without a deck.
 */
export function resolveContentWidthPx(
  preset: ContentWidth,
  minWidth: number,
  maxWidth?: number,
): number {
  const width = Math.max(CONTENT_WIDTH_PX[preset], minWidth);
  return maxWidth === undefined ? width : Math.min(width, Math.max(maxWidth, minWidth));
}

/**
 * How long the deck takes to settle into a new arrangement, in milliseconds.
 *
 * Changing the imposition moves every derived frame at once, and they cross to
 * their new places rather than cutting — by a measured FLIP tween started in
 * `deck-canvas.tsx`. That module writes this number onto the frames' container
 * as `--tugx-imposer-settle-duration` and reads the resolved value back when
 * timing the settle, so the tween and the window that frames it are one number
 * and an override on the container tunes both.
 */
export const IMPOSITION_SETTLE_MS = 300;

/**
 * How far a frame rises as it arrives, in pixels.
 *
 * A pane that was not on screen when the settle armed has no First rect, so
 * there is no distance for it to cross and nothing FLIP can invert. It still
 * may not simply materialize — the deck's promise is that a card never changes
 * places in a single frame — so it fades up over a short rise instead. Short
 * on purpose: a long travel would claim the card came from somewhere, and it
 * did not come from anywhere.
 */
export const PANE_ENTER_RISE_PX = 8;

/**
 * How long a closing pane's ghost lingers, in milliseconds.
 *
 * React unmounts a closing frame within the commit, so the frame itself cannot
 * be animated out — by the time there is anything to animate, there is no
 * element. What outlives it is a ghost: a plain tile the canvas plants at the
 * frame's last rect and fades. It rides its own duration rather than the
 * settle's because it is not part of the arrangement — nothing is waiting on
 * it, and a departure that lingers as long as a crossing reads as slower than
 * the gesture that caused it.
 */
export const PANE_EXIT_GHOST_MS = 180;

/**
 * Which side the pinned Lens holds, as a number: 0 is the left edge, 1 the
 * right. Registered as a `<number>` custom property in `tug-pane.css` so the
 * expression that reads it can compute with it — see {@link imposeSidebarStyle}.
 */
export const LENS_RAIL_PROPERTY = "--tugx-lens-rail";

/**
 * A side's live rail width, as a CSS length on the frames' containing block
 * (`deck-canvas.tsx` writes it).
 *
 * The width is the one number a rail edge drag changes, and it is an input to
 * three expressions at once: the sidebar's own pin on a right-side deck (`100%
 * - width - gap`), the band the chain is imposed across, and the frame's own
 * `width`. Carried as a property rather than baked into each of them, the drag
 * writes it once and the browser re-resolves all three in the same reflow — so
 * the pinned edge holds and the cards re-impose live, with no measurement and
 * no per-frame JavaScript ([L06]).
 *
 * One property per SIDE, not per card: same-side sidebar cards share a rail, so
 * they share a width, and a stacked pair reading one property cannot drift
 * apart mid-drag.
 *
 * Deliberately unregistered: every expression reading it supplies the
 * React-known width as the `var()` fallback, so a frame that renders before the
 * property is written lands on exactly the geometry it would have had. A
 * registered property has an initial value instead of an absence, and the
 * fallback would never be reached.
 */
export function sidebarWidthProperty(side: SidebarSide): string {
  return side === "left"
    ? "--tug-sidebar-width-left"
    : "--tug-sidebar-width-right";
}

/** The gaps as CSS lengths, for the calc expressions below. */
const GAP = `${IMPOSITION_GAP_PX}px`;
const GAP_BOTTOM = `${IMPOSITION_GAP_BOTTOM_PX}px`;

/** The CSS custom properties carrying the rail insets (see `deck-canvas.tsx`).
 *  These carry the Lens rail only; the gap is added on top of them here, so the
 *  numeric twin below and the CSS agree by construction. */
const INSET_LEFT = "var(--tug-imposer-inset-left, 0px)";
const INSET_RIGHT = "var(--tug-imposer-inset-right, 0px)";

/**
 * The flow viewport's offset — how far the strip has slid left under the band —
 * written by the deck canvas alongside the insets above, and read back by
 * {@link imposeStyle}'s flow `left`.
 *
 * Named for the imposer rather than the deck because it joins the family that
 * effect already writes: one prefix, one place to look for what moves a frame.
 */
export const FLOW_OFFSET_PROPERTY = "--tug-imposer-flow-offset";

/** The strip's full length, published so the offset's clamp can be expressed in
 *  CSS. See {@link imposeStyle}. */
export const FLOW_STRIP_PROPERTY = "--tug-imposer-flow-strip";

/** Narrow an unknown (a parsed blob field, an action payload) to a kind. */
export function isImpositionKind(value: unknown): value is ImpositionKind {
  return (
    typeof value === "string" &&
    (IMPOSITION_KINDS as readonly string[]).includes(value)
  );
}

/** Narrow an unknown to a layout mode, for the same two doors. */
export function isImpositionLayout(value: unknown): value is ImpositionLayout {
  return value === "fit" || value === "flow";
}

/**
 * The mode this imposition reads under.
 *
 * Total by construction, like {@link sidebarSide}: the record arrives from JSON
 * blobs and seeded test decks as well as from the store, and an absent field
 * and a deck that has never chosen mean the same thing.
 */
export function impositionLayout(
  imposition: Pick<DeckImposition, "layout">,
): ImpositionLayout {
  return imposition.layout ?? DEFAULT_IMPOSITION_LAYOUT;
}

/** How many slots the kind defines: 1 through 6. */
export function slotCount(kind: ImpositionKind): number {
  switch (kind) {
    case "one-up":
      return 1;
    case "two-up":
      return 2;
    case "three-up":
      return 3;
    case "four-up":
      return 4;
    case "five-up":
      return 5;
    case "six-up":
      return 6;
  }
}

/**
 * Bring any number into the kind's slot range: floored to an integer and
 * clamped to `[0, N-1]`. A non-finite input reads as slot 0. This is what makes
 * a kind change safe — shrinking from four-up to two-up pulls slots 2 and 3 in
 * to slot 1 rather than dropping those panes out of the arrangement.
 */
export function clampSlot(kind: ImpositionKind, slot: number): number {
  if (!Number.isFinite(slot)) return 0;
  const last = slotCount(kind) - 1;
  return Math.max(0, Math.min(last, Math.floor(slot)));
}

/* ---------------------------------------------------------------------------
 * Placement
 * ---------------------------------------------------------------------------*/

/** One pane's place in the arrangement — everything a frame needs to position
 *  itself, and no more.
 *
 *  **In fit** there is nothing here about the deck's other panes, because a
 *  slot's anchor does not depend on them. That is the whole of what makes the
 *  arrangement hold still: a placement is a pure function of the kind and the
 *  pane's own slot, so no pane can be resolved only from a vantage point that
 *  sees them all.
 *
 *  **In flow that property is deliberately spent** ([P09] in the layout-imposer
 *  plan): a slot's place is the running sum of every occupied slot before it,
 *  which is exactly such a vantage point. Flow pays for it in ONE place — the
 *  placements memo in `deck-canvas.tsx`, which already walks every pane once
 *  per commit — and hands the resolved strip position to {@link imposeStyle} as
 *  an argument. Nothing downstream of that memo resolves a strip: a pane that
 *  recomputed it from a store read would re-derive deck-wide geometry per
 *  frame, and the invariant above would be lost in fit as well as in flow.
 *
 *  The offset is deliberately not resolved here: it depends on the band's
 *  width, which only the browser knows. {@link imposeStyle} hands that to CSS.
 *  The flow viewport offset goes the same way, for the same reason. */
export interface ImposedPlacement {
  /** The pane's slot, already clamped to the kind. */
  slot: number;
  /** How many slots the kind defines. */
  count: number;
  /**
   * The slot's standing in the strip — present only in flow, and written only
   * by the deck-canvas placements memo. Absent means fit, which is what every
   * caller that resolves a placement on its own gets.
   */
  flow?: FlowStanding;
}

/** Where a slot stands along the strip, resolved once per commit by the deck
 *  canvas and carried to {@link imposeStyle} on the placement. */
export interface FlowStanding {
  /** This slot's left edge, measured from the strip's origin. */
  stripLeft: number;
}

/**
 * Resolve one pane's place from its slot and the deck's arrangement. `slot`
 * is clamped to the kind, so shrinking four-up to two-up pulls the outer slots
 * in rather than dropping their panes out of the arrangement.
 *
 * The Lens's side is not an input. It moves the band's edges — which is the
 * insets' job, not the numbering's — and slot 1 is the leftmost position on
 * either deck.
 */
export function resolvePlacement(
  kind: ImpositionKind,
  slot: number,
): ImposedPlacement {
  return { slot: clampSlot(kind, slot), count: slotCount(kind) };
}

/**
 * A slot's share of the band's travel: `slot / (slots - 1)`, in `[0, 1]`. Slot
 * 0 gives 0 (hug the band's left edge) and the last slot gives 1 (hug its
 * right).
 *
 * **One-up is the special case.** With a single anchor there is no chain to
 * number, so the rule that spaces the ends against the edges has nothing to
 * space: `0 / 0`. Its one slot takes HALF the travel instead — the card stands
 * centered in the band, with the slack split evenly on both sides. A lone card
 * shoved against the left edge would read as a two-up arrangement missing its
 * partner; centered, it reads as the one thing on the deck, which is what
 * one-up means.
 */
export function travelFraction(placement: ImposedPlacement): number {
  if (placement.count < 2) return 0.5;
  return placement.slot / (placement.count - 1);
}

/* ---------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------------*/

/** The band the chain is laid across: the canvas minus the Lens's inset on the
 *  side it holds. Imposed panes are never under the Lens.
 *
 *  The span is the *raw* band — the chain's own imposition gap is not folded in
 *  here, so this stays a plain description of the canvas and the Lens. Both
 *  {@link imposeRect} and {@link imposeStyle} inset it by that gap themselves. */
export interface ImposerSpan {
  x: number;
  width: number;
  height: number;
}

/** One side's rail: the width the cards stacked on that side share. A side
 *  with no open, pinned sidebar card has no rail and is absent. */
export interface SidebarRail {
  side: SidebarSide;
  width: number;
}

/**
 * Resolve the span from the canvas box and the rails standing on its edges. No
 * rails means the span is the whole canvas; one or two inset it from that side.
 *
 * A rail is itself imposed — it stands one gap off the canvas edge — so its
 * near edge sits `width + gap` in, and that is the inset the band takes on that
 * side. The chain's own gap then lands its far card exactly one gap off the
 * rail. This is the numeric twin of the `--tug-imposer-inset-*` custom
 * properties `deck-canvas.tsx` writes; both add the same gap per occupied side,
 * so they agree by construction.
 *
 * **This function is the gap count.** A closed rail contributes neither width
 * nor gap, so the band a solve must reproduce is `span.width − 2 × gap` for
 * whatever rails stand — never a constant number of gaps written out by hand.
 * {@link solveSidebarWidths} derives its band identity from here rather than
 * carrying its own arithmetic, which is what keeps the numeric twin and the CSS
 * from parting company as rails come and go.
 */
export function resolveSpan(
  canvas: { width: number; height: number },
  rails: readonly SidebarRail[],
): ImposerSpan {
  let left = 0;
  let right = 0;
  for (const rail of rails) {
    const inset = rail.width + IMPOSITION_GAP_PX;
    if (rail.side === "left") left += inset;
    else right += inset;
  }
  return {
    x: left,
    width: canvas.width - left - right,
    height: canvas.height,
  };
}

/** The numeric form of an imposed pane's frame, in canvas coordinates. */
export interface ImposedRect {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * The numeric twin of {@link imposeStyle} — the rect an imposed pane occupies,
 * for tests, snap math, and the freeze that runs when the imposition is turned
 * off. `paneWidth` passes through untouched; no clamping and no minimum, so an
 * overhanging result is returned as computed.
 *
 * `pinned` mirrors {@link imposeStyle}'s: the slot is computed from
 * `slotWidth` either way, and a pinned card keeps its own size centred inside
 * it rather than filling it.
 *
 * **Fit only.** This is the travel-fraction rule, and it has no flow variant
 * because it has no flow caller: the deck's flow lefts are resolved in the
 * `deck-canvas.tsx` placements memo and expressed through {@link imposeStyle},
 * and nothing else in the tree asks the imposer for a numeric imposed rect.
 * Given a flow deck it would answer the fit question correctly, which is not
 * the same as answering.
 */
export function imposeRect(
  placement: ImposedPlacement,
  slotWidth: number,
  span: ImposerSpan,
  pinned?: PinnedFrame,
): ImposedRect {
  const bandWidth = span.width - IMPOSITION_GAP_PX * 2;
  const travel = Math.max(0, bandWidth - slotWidth);
  const offset = travelFraction(placement) * travel;
  const runHeight = span.height - IMPOSITION_GAP_PX - IMPOSITION_GAP_BOTTOM_PX;
  const width = pinned?.width ?? slotWidth;
  const height = pinned?.height ?? runHeight;
  return {
    position: {
      x: span.x + IMPOSITION_GAP_PX + offset + Math.max(0, (slotWidth - width) / 2),
      y: IMPOSITION_GAP_PX + Math.max(0, (runHeight - height) / 2),
    },
    size: { width, height },
  };
}

/**
 * The CSS form: inline frame styles that pin the pane to its slot's anchor. One
 * horizontal pin, always measured from the left: the left inset, the gap, and
 * this slot's share of the pane's travel across the band.
 *
 * The travel is a `max()` over the live band, so the browser is the one that
 * decides how much room the arrangement has — and it re-decides on every
 * reflow. That is the whole of the deck's response to a window or display
 * resize.
 *
 * Because the numbering never turns around, the pin's *shape* is the same on
 * every deck — only the two inset terms change when the Lens crosses. That is
 * what a flip has to interpolate: one expression, same form on both sides. (An
 * arrangement that measured from the right when the Lens was left would be
 * swapping a bare length for a percentage, which is not the same kind of value
 * and cuts instead of crossing.)
 *
 * The vertical run is the top gap down to the deeper bottom gap.
 *
 * `pinned` separates the SLOT from the FRAME. Normally they are the same box:
 * `slotWidth` is the pane's own width, the frame fills the run, and the two
 * words describe one rect. A size-locked card breaks them apart. About is 320
 * × 360 by registration — an about box has exactly one correct size — and it
 * has no larger form to be stretched into, so the imposition PLACES it rather
 * than sizing it: the slot is computed as though an ordinary content card
 * stood there, and About is centred inside it on both axes.
 *
 * Taking the slot from the card's own 320 instead would be the visible bug in
 * the screenshot this was written from: the card hugs the band's left edge in
 * slot 0, because a narrow pane has more travel to give away, and the slot the
 * eye expects — the one every other card in that arrangement occupies — is not
 * where it sits. The slot belongs to the arrangement, not to the card standing
 * in it.
 *
 * Both `max(0px, …)` terms keep a card LARGER than its slot from hanging off:
 * it pins at the near edge rather than taking a negative offset.
 */
export interface PinnedFrame {
  /** The card's own width, centred across `slotWidth`. */
  width?: number;
  /** The card's own height, centred down the vertical run. */
  height?: number;
}

export function imposeStyle(
  placement: ImposedPlacement,
  slotWidth: number,
  pinned?: PinnedFrame,
  options: { member?: ColumnMemberPlacement } = {},
): React.CSSProperties {
  const frameWidth = pinned?.width ?? slotWidth;
  // The vertical run the frame takes. Undivided this is the top gap down to the
  // deeper bottom one; in a shared column it is this member's share, pinned to
  // the seams either side of it; in an overflowing one it is this member's
  // place down a scrolling strip. `columnMemberPins` answers with the undivided
  // pins when there is no member or its column holds one, so every case is one
  // expression rather than a branch.
  const run = columnMemberPins(options.member);
  const style: React.CSSProperties =
    pinned?.height === undefined
      ? {
          width: `${frameWidth}px`,
          height: "auto",
          top: run.top,
          bottom: run.bottom,
        }
      : {
          // A size-locked card centres inside whatever run it was given, so a
          // split column shrinks the box it centres in rather than taking it
          // out of the division.
          width: `${frameWidth}px`,
          height: `${pinned.height}px`,
          top: `calc(${run.top} + max(0px, (100% - ${run.top} - ${run.bottom} - ${pinned.height}px) / 2))`,
        };

  const band = `(100% - ${INSET_LEFT} - ${INSET_RIGHT} - ${GAP} * 2)`;
  // The centring term is a plain number, not a percentage: both widths are
  // known here, so it never needs the browser to resolve it.
  const centre =
    frameWidth === slotWidth ? "" : ` + ${Math.max(0, (slotWidth - frameWidth) / 2)}px`;

  if (placement.flow !== undefined) {
    // FLOW. The slot's place along the strip is a number the canvas resolved,
    // and the viewport's offset is a property the canvas wrote — so this is
    // still ONE expression the browser re-resolves on every reflow, which is
    // the property the whole module is built on.
    //
    // The offset is CLAMPED HERE, in CSS, and not only where it was computed.
    // Widen the window and the band grows while the stored offset stands
    // still; without this clamp the strip would stay pushed left with dead air
    // at the right edge until the settled-resize retune fired 200ms later, and
    // flow would be the one mode whose answer to a resize is a stale picture.
    // Both terms are available: the strip's length is the deck-wide number
    // published as FLOW_STRIP_PROPERTY, and the band is the expression above.
    const offset =
      `min(var(${FLOW_OFFSET_PROPERTY}, 0px), ` +
      `max(0px, var(${FLOW_STRIP_PROPERTY}, 0px) - ${band}))`;
    style.left = `calc(0% + ${INSET_LEFT} + ${GAP} + ${placement.flow.stripLeft}px - ${offset}${centre})`;
    return style;
  }

  const fraction = travelFraction(placement);
  // `k / (N - 1) × max(0, band - width)` — see the module note.
  const offset =
    fraction === 0 ? "0px" : `${fraction} * max(0px, ${band} - ${slotWidth}px)`;
  style.left = `calc(0% + ${INSET_LEFT} + ${GAP} + ${offset}${centre})`;
  return style;
}

/* ---------------------------------------------------------------------------
 * Flow geometry
 * ---------------------------------------------------------------------------*/

/**
 * One occupied slot's extent in the strip: the width the slot takes up, which
 * is its WIDEST member's pane width. Panes sharing a slot share its anchor in
 * flow exactly as they do in fit — flow removes collisions BETWEEN slots, not
 * within one — so a stack contributes one extent, not one per member.
 */
export interface FlowSlotExtent {
  /** The slot index. */
  slot: number;
  /** The widest member pane's render width. */
  width: number;
}

/** Where the occupied slots stand along the strip, and how long the strip is. */
export interface FlowStrip {
  /** Each occupied slot's left edge, measured from the strip's own origin —
   *  which is the band's left edge at offset 0. */
  positions: ReadonlyMap<number, number>;
  /**
   * Each occupied slot's extent — the width its widest member paints at, after
   * duplicates have folded.
   *
   * Carried out of the strip rather than left for a caller to re-derive from
   * the positions, for the reason the strip is resolved in one place at all: a
   * second derivation would have to subtract a gap it assumes, and would part
   * company with this one the day the gap stops being a constant.
   */
  extents: ReadonlyMap<number, number>;
  /** The strip's full length: the last slot's left plus its extent. No
   *  trailing gap — the gap is what stands BETWEEN two slots. */
  width: number;
}

/**
 * Lay the occupied slots out as a strip, ascending by slot index:
 * `stripLeft(k) = Σ_{j<k, occupied} (extent(j) + IMPOSITION_GAP_PX)`.
 *
 * This is the whole of what flow means. A slot's place is the running sum of
 * everything before it, so no two occupied slots can overlap by construction —
 * and, equally by construction, a card's place now depends on its neighbours'
 * widths, which is the property fit was built to avoid. Both are the trade the
 * mode exists to offer.
 *
 * Unoccupied slots contribute nothing, not even a gap: three cards in slots 0,
 * 2 and 5 of a six-up deck stand as a run of three, because the strip is a
 * sequence and an empty slot is not a member of it.
 *
 * Duplicate entries for one slot fold by taking the widest, matching
 * {@link AllocatorInput.occupied}; unreadable widths are dropped, and a
 * negative one reads as zero.
 */
export function flowStripPositions(
  occupied: readonly FlowSlotExtent[],
): FlowStrip {
  const extents = new Map<number, number>();
  for (const entry of occupied) {
    if (!Number.isFinite(entry.slot) || !Number.isFinite(entry.width)) continue;
    const width = Math.max(0, entry.width);
    const standing = extents.get(entry.slot);
    if (standing === undefined || width > standing) {
      extents.set(entry.slot, width);
    }
  }
  const slots = [...extents.keys()].sort((a, b) => a - b);
  const positions = new Map<number, number>();
  let running = 0;
  for (const slot of slots) {
    positions.set(slot, running);
    running += (extents.get(slot) as number) + IMPOSITION_GAP_PX;
  }
  // `running` carries one trailing gap past the last slot; the strip ends at
  // the last card's right edge.
  const width = slots.length === 0 ? 0 : running - IMPOSITION_GAP_PX;
  return { positions, extents, width };
}

/**
 * Hold an offset inside a strip's own bounds: never negative (the strip's near
 * edge is as far as the viewport can look back) and never past the point where
 * the strip's far edge reaches the band's.
 *
 * A strip shorter than the band has no travel at all and clamps to 0.
 *
 * Axis-free — the arithmetic is over four scalars and never asks which
 * direction they run in, which is what lets a column's vertical strip share it
 * (see {@link stripRevealOffset}).
 */
export function clampStripOffset(
  offset: number,
  stripLength: number,
  band: number,
): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(0, offset), Math.max(0, stripLength - band));
}

/** The horizontal name for {@link clampStripOffset} — flow's strip runs left to
 *  right, and the callers that only ever mean flow say so. */
export function clampFlowOffset(
  offset: number,
  stripWidth: number,
  band: number,
): number {
  return clampStripOffset(offset, stripWidth, band);
}

/** What the reveal rule is told: where the member stands in the strip, how long
 *  the strip is, how wide the band is, and where the viewport is now. All four
 *  are lengths along the strip's own axis, whichever axis that is. */
export interface StripRevealInput {
  /** The member's near edge, measured from the strip's origin. */
  stripStart: number;
  /** That member's extent along the strip. */
  extent: number;
  /** The full strip length, for the clamp. */
  stripLength: number;
  /** The band the strip is seen through. */
  band: number;
  /** The offset standing now. */
  offset: number;
}

/**
 * The minimal offset that brings a member fully into the band —
 * `scrollRectToVisible` semantics, and nothing more: a member already inside
 * the viewport returns the offset unchanged, so an activation that reveals
 * nothing commits no geometry.
 *
 * A member LONGER than the band cannot be brought fully in, so its near edge is
 * pinned instead: reading starts at the near edge, and a member whose far edge
 * was flush would hide the side the eye goes to first.
 *
 * The rule has no axis in it, which is why a column's overflowing strip of
 * `run / 2.5` members reveals by exactly this arithmetic over heights.
 */
export function stripRevealOffset(input: StripRevealInput): number {
  const { stripStart, extent, stripLength, band, offset } = input;
  if (!Number.isFinite(stripStart) || !Number.isFinite(extent)) {
    return clampStripOffset(offset, stripLength, band);
  }
  const wanted =
    extent >= band || stripStart < offset
      ? stripStart
      : stripStart + extent > offset + band
        ? stripStart + extent - band
        : offset;
  return clampStripOffset(wanted, stripLength, band);
}

/** Flow's own name for {@link StripRevealInput}. */
export interface FlowRevealInput {
  /** The active card's slot position along the strip. */
  stripLeft: number;
  /** That slot's extent. */
  extent: number;
  /** The full strip length, for the clamp. */
  stripWidth: number;
  /** The band the strip is seen through. */
  band: number;
  /** The offset standing now. */
  offset: number;
}

/** {@link stripRevealOffset} read horizontally — flow's reveal, unchanged. */
export function flowRevealOffset(input: FlowRevealInput): number {
  return stripRevealOffset({
    stripStart: input.stripLeft,
    extent: input.extent,
    stripLength: input.stripWidth,
    band: input.band,
    offset: input.offset,
  });
}

/* ---------------------------------------------------------------------------
 * The space allocator
 * ---------------------------------------------------------------------------*/

/**
 * How long the canvas must hold still before a resize counts as settled and the
 * allocator re-tunes (`deck-canvas.tsx`). Lives here so the imposer's tuning
 * surface stays in one module, beside {@link IMPOSITION_SETTLE_MS}.
 */
export const RESIZE_RETUNE_QUIET_MS = 200;

/**
 * One rail's policy: the width it wants, the two floors beneath it, and how
 * greedy it is for whatever width the deck has to share out.
 *
 * A rail shared by a stack carries the WIDEST preference among its members (a
 * rail must be able to show the card its owner sized widest), the TIGHTEST
 * floors — both of them (a rail is one width, so a floor binding on either
 * card binds the rail) — and the GREEDIEST rank.
 */
export interface RailPolicy {
  /** The width this rail wants: the width the user chose for it, or the
   *  registered preference when they never have. The solver fills toward it
   *  and drains away from it; it is never read back from the rail's own
   *  standing width, which is what keeps past answers out of the input. */
  preferredWidth: number;
  /** The HARD floor: the width below which this rail cannot paint its
   *  contents at all. Inviolable, and the same floor the user's own resize
   *  drag clamps to. */
  minWidth: number;
  /**
   * The COMFORT floor: the narrowest this rail is comfortable at, at or above
   * {@link minWidth}. A card with no comfort band registers its hard floor
   * here, which makes the comfort tier empty for its rail.
   *
   * The allocator holds every rail at or above its comfort floor unless
   * descending below removes overlap from the chain ENTIRELY — comfort is
   * spent to fix a picture, never merely to improve one. Showing the user's
   * cards un-occluded outranks a rail's comfortable measure; nothing outranks
   * the rail's ability to paint.
   */
  comfortWidth: number;
  /**
   * How greedy this rail is: **lower is greedier** — fed first when the deck
   * has width to give, drained last when it has width to take. Folded from
   * the rail's members by `deck-manager.ts` (greediest wins), registered as
   * `CardRegistration.greedRank`.
   *
   * The solver sorts on this and knows nothing else about the cards standing
   * in the rail.
   */
  greedRank: number;
}

/** A width per occupied side — the allocator's answer, and the shape a rail's
 *  policies arrive in. A side with no rail is absent from both. */
export type RailWidths = { left?: number; right?: number };

/** Everything {@link allocateSidebarWidths} reads. All lengths in layout px. */
export interface AllocatorInput {
  /** The canvas (frames' container) client width. */
  canvasWidth: number;
  /** The active kind; its slot count defines the travel fractions. */
  kind: ImpositionKind;
  /**
   * The deck's layout mode; absent reads as {@link DEFAULT_IMPOSITION_LAYOUT}.
   *
   * It reaches the allocator for one reason: in flow the seams are not a
   * function of the rails at all, which collapses the objective. See
   * {@link allocateSidebarWidths}.
   */
  layout?: ImpositionLayout;
  /**
   * The occupied slots and the width each one renders at — the RENDER width,
   * already raised to the stack's size floor, since that is the width the chain
   * actually paints. Duplicates are folded by taking the widest.
   */
  occupied: readonly { slot: number; width: number }[];
  /** The rails standing on the deck's edges, at most one per side. */
  rails: { left?: RailPolicy; right?: RailPolicy };
  /**
   * The widest any rail may stand, in pixels — the ceiling every rail shares,
   * the way the shrink floor is each rail's own. The deck passes
   * {@link CONTENT_WIDTH_SLIM_PX}: a rail may be as wide as a slim content
   * card and no wider, whatever Card Width the deck is set to — a sidebar is
   * a reading surface, and a comfy- or wide-sized one is absurd on its face.
   */
  maxRailWidth: number;
}

/** The sides carrying a rail, left before right — the order every per-rail sum
 *  in the solve runs in. */
function railSidesOf(rails: AllocatorInput["rails"]): readonly SidebarSide[] {
  const sides: SidebarSide[] = [];
  if (rails.left !== undefined) sides.push("left");
  if (rails.right !== undefined) sides.push("right");
  return sides;
}

/** The widths as rails, for {@link resolveSpan}. */
function railsOf(widths: RailWidths): readonly SidebarRail[] {
  const rails: SidebarRail[] = [];
  if (widths.left !== undefined) rails.push({ side: "left", width: widths.left });
  if (widths.right !== undefined) {
    rails.push({ side: "right", width: widths.right });
  }
  return rails;
}

/**
 * The width each pinned sidebar rail should render at so the imposed chain
 * tiles evenly — one width per occupied side, each solved on its own.
 *
 * ## What is being solved
 *
 * A slot is an anchor at a fixed fraction of the band, and a pane's width is its
 * own — so the slack between two adjacent imposed cards is whatever the band's
 * width leaves over. Choose an arrangement on a wide deck and the cards stand
 * apart; narrow the window slightly and the same arrangement overlaps. Neither
 * is wrong, but neither is what the eye wants either, and no number in the
 * placement rule can fix it: card widths belong to the panes ([L09]) and the
 * offsets are pure functions of the band.
 *
 * The rails' width is the one quantity that can absorb the residual, because it
 * *is* the band's other end: `band = canvasWidth − Σ rail − (R + 2) × gap` for
 * `R` standing rails (each stands a gap off its canvas edge, and the chain is
 * inset one gap at each end of what is left). Flexing the rails a little moves
 * every seam at once. The gap count is read off {@link resolveSpan} rather than
 * written down, since a closed rail contributes neither width nor gap.
 *
 * ## The solve
 *
 * With `fⱼ` the travel fraction of the j-th occupied slot and `wⱼ` its render
 * width, the seam between neighbours `j` and `j+1` is linear in the band:
 *
 * ```
 *   seamⱼ(B) = aⱼ·B + cⱼ      aⱼ = fⱼ₊₁ − fⱼ      cⱼ = fⱼwⱼ − fⱼ₊₁wⱼ₊₁ − wⱼ
 * ```
 *
 * so the band that puts every seam as close to one imposition gap as it can is
 * a plain least-squares fit with a closed form — no iteration, no measurement:
 *
 * ```
 *   B* = Σ aⱼ(gap − cⱼ) / Σ aⱼ²        T* = canvasWidth − (R + 2)·gap − B*
 * ```
 *
 * `T*` is the rails' TOTAL, and it is the only thing the geometry has an
 * opinion about. **The split between the sides is free**: `resolveSpan` insets
 * the canvas by `railWidth + gap` per occupied side, so the band — and
 * therefore every seam — depends on the rails' total and never on how that
 * total is divided. Moving width from the left rail to the right shifts
 * `span.x` and changes no seam at all. Tiling is the total's business; which
 * rail is the wide one is the greed order's, and the two can never trade
 * against each other.
 *
 * For the common case — uniform card widths at an even stride, e.g. five-up
 * with slots 1, 3 and 5 — the fit is exact and every seam lands on the gap.
 * Irregular occupancy (slots 1, 2 and 5) has no band that tiles it at all: the
 * fit spreads the error rather than removing it, and the rails still stand at
 * the best total there is.
 *
 * ## Choosing the total: the picture, not the fit
 *
 * The total is chosen by looking at the picture it paints. Every candidate
 * total in `[Σ floor, Σ ceiling]` is scored by {@link seamPicture} — which
 * reads `imposeRect`'s REAL clamped geometry — on a lexicographic key:
 *
 * ```
 *   key(T) = [ worstOverlap, worstShortfall, worstError, |T − Σ preferred| ]
 * ```
 *
 * Occlusion first (a card the user cannot see), then cramping (a chain that
 * reads as broken rather than arranged), then raggedness, and last the
 * distance from the widths the user chose — which breaks every remaining tie
 * toward leaving the rails where their owner put them, and makes the answer
 * unique.
 *
 * `B*` is not the answer. The least-squares fit minimises a SUM of squared
 * errors over the LINEAR seam model; what the user sees is the WORST seam
 * under the real rule that clamps a pane's travel at zero. On a crowded deck
 * those are different objectives, and the difference is a chain that puts one
 * pair of cards 372px on top of one another so the next pair can stand 482px
 * apart. `solveSidebarWidths` survives as the honest closed form and seeds the
 * scan, but it no longer decides.
 *
 * ## The invariant order — what the answer must satisfy
 *
 * The allocator judges nothing. It satisfies these requirements in strict
 * priority, and the answer is whatever comes out:
 *
 *   1. **Hard floors are inviolable.** Every rail stands at or above its
 *      `minWidth` — the width below which it cannot paint its contents.
 *      A floor above the ceiling wins: a policy about maximum width does not
 *      outrank a width the card cannot be drawn under.
 *   2. **The picture is chosen from the comfort domain when it can be.** The
 *      total is the best-scoring one at or above `Σ comfortWidth`.
 *   3. **Comfort is surrendered to reach a better TIER of picture, and for
 *      nothing else.** The tiers are clean (nothing occluded, no seam under
 *      the gap), unoccluded-but-cramped, and occluded. If the range below the
 *      comfort floors reaches a higher tier than the comfort domain can, the
 *      rails give up their measure; otherwise comfort is kept, because
 *      cramping a rail to improve a picture that stays broken buys nothing at
 *      the cost of a rail the user can no longer read. A tier comparison is
 *      still a yes/no rule, not a graded judgement — which is what makes it
 *      testable, and what distinguishes it from the licence this allocator
 *      deleted.
 *   4. **Preferences fill in greed order.** Each rail starts at the width it
 *      wants. A deficit drains the LEAST greedy rail first — to its comfort
 *      floor, and only then, if the total is still unmet, to its hard floor;
 *      a surplus feeds the GREEDIEST first, to its ceiling, before a less
 *      greedy rail grows past what it wants. Rails of equal rank split their
 *      tier's share evenly.
 *   5. **Ceilings cap everything.** No rail stands wider than
 *      {@link AllocatorInput.maxRailWidth}.
 *
 * Which rail is the wide one cannot affect the picture at all: the band, and
 * therefore every seam, depends on the rails' TOTAL and never on how that
 * total is split (the separation property, above). So step 4 can never trade
 * away what steps 2 and 3 bought.
 *
 * There is no tolerance and no grade — the score is an OBJECTIVE, not an
 * acceptance test, so there is nothing to tune and no "refuse" branch. The
 * standing widths are not an input at all (`RailPolicy` cannot carry them),
 * which is what makes it structurally impossible for the allocator to read its
 * own past answers back as the user's choice.
 *
 * **The solver is total.** It answers whenever a rail stands: `null` means
 * exactly two things, and neither is a shrug — no rail stands, or a number in
 * the input is not finite. With no chain to fit (fewer than two occupied
 * slots) each rail answers `clamp(preferred, floor, ceiling)`, which is safe
 * because preference is read from the durable stores the user's own drag
 * writes: snapping to it is snapping to the width they last chose.
 *
 * Total by construction: never throws.
 */
export function allocateSidebarWidths(input: AllocatorInput): RailWidths | null {
  const sides = railSidesOf(input.rails);
  if (sides.length === 0) return null;
  if (!Number.isFinite(input.maxRailWidth) || input.maxRailWidth <= 0) {
    return null;
  }
  // The one validation site: a non-finite canvas, occupied entry, or rail
  // policy number. A chain of fewer than two cards is NOT an error here — it
  // has no seam to fit, which is a question about the target, not about
  // whether the rails may be answered for.
  const chain = chainOf(input);
  if (chain === null) return null;

  const ceiling = Math.round(input.maxRailWidth);
  const rails: RailBounds[] = sides.map((side) => {
    const policy = input.rails[side] as RailPolicy;
    // Floors round UP so that an integer answer can never land under a
    // fractional floor; the ceiling and preference then live inside it.
    const floor = Math.ceil(policy.minWidth);
    const top = Math.max(ceiling, floor);
    const preferred = Math.min(
      Math.max(Math.round(policy.preferredWidth), floor),
      top,
    );
    return {
      side,
      floor,
      // The comfort floor is clamped UNDER the rail's preference. A rail the
      // user dragged below its comfort measure keeps that drag as its
      // effective comfort floor, so the comfort rule can never grow a rail
      // back past a width its owner chose — comfort constrains the allocator,
      // never the user. It is also what keeps every comfort-tier capacity
      // (`standing − comfortFloor`) non-negative in the drain below.
      comfortFloor: Math.max(floor, Math.min(Math.ceil(policy.comfortWidth), preferred)),
      ceiling: top,
      preferred,
      rank: policy.greedRank,
    };
  });

  const sum = (of: (rail: RailBounds) => number): number =>
    rails.reduce((running, rail) => running + of(rail), 0);
  const preferredTotal = sum((rail) => rail.preferred);
  const floorTotal = sum((rail) => rail.floor);
  const comfortTotal = sum((rail) => rail.comfortFloor);
  const ceilingTotal = sum((rail) => rail.ceiling);

  const target =
    impositionLayout(input) === "flow" || chain.length < 2
      ? // No seam is no picture: every candidate scores zero on the first
        // three terms and the key reduces to its last, which is minimised at
        // Σ preferred. Returned directly rather than scanned for it — the
        // answer falls out of the objective, so this is a shortcut, not a
        // special case.
        //
        // FLOW joins that branch for the same reason, one step further along.
        // A flow deck has seams, but every one of them is exactly
        // IMPOSITION_GAP_PX by construction and independent of the band: the
        // strip is a running sum, so widening the rails narrows the band
        // without moving a single seam. Every candidate total therefore scores
        // zero on `worstOverlap`, `worstShortfall` and `worstError` alike, the
        // key reduces to its last term again, and the answer is Σ preferred.
        // (The linear solve agrees by a different route: its `aⱼ = fⱼ₊₁ − fⱼ`
        // terms are all zero in flow, so `solveSidebarWidths` divides by a zero
        // denominator and returns null, which is already guarded.)
        //
        // Flow is why `imposeRect` and `seamPicture` stay fit-only: nothing
        // reaches them here.
        preferredTotal
      : chooseRailTotal(input, chain, {
          floorTotal,
          comfortTotal,
          ceilingTotal,
          preferredTotal,
          sides,
        });

  const widths = new Map(rails.map((rail) => [rail.side, rail.preferred]));
  const outstanding = target - preferredTotal;
  if (outstanding > 0) {
    waterFill(widths, rails, outstanding, true, (rail) => rail.ceiling);
  } else if (outstanding < 0) {
    // Two tiers, both in reverse greed order: every rail gives up its comfort
    // before any rail gives up more than that, and inside each tier the least
    // greedy rail gives first. The greediest rail is the last to be
    // uncomfortable and the last to approach the width it cannot paint under.
    const still = waterFill(
      widths,
      rails,
      -outstanding,
      false,
      (rail) => rail.comfortFloor,
    );
    if (still > 0) waterFill(widths, rails, still, false, (rail) => rail.floor);
  }

  // Rounding leaves at most one pixel per rail on the table. It is left with
  // the band's travel rather than redistributed: a pixel of seam slack is
  // invisible, and a redistribution pass is complexity with no picture to buy.
  const answer: RailWidths = {};
  for (const rail of rails) {
    answer[rail.side] = Math.round(widths.get(rail.side) as number);
  }
  return answer;
}

/** One rail's solved bounds: the two floors it stands on, the ceiling it may
 *  not pass, the width it wants, and how greedy it is for the rest. */
interface RailBounds {
  side: SidebarSide;
  floor: number;
  comfortFloor: number;
  ceiling: number;
  preferred: number;
  rank: number;
}

/**
 * One greed-ordered pass of the water-fill, moving every rail toward `bound`
 * until `need` is met. Returns whatever is left unmet, which is how the
 * deficit's two tiers chain: drain to comfort, and hand what comfort could not
 * cover to a second pass that drains to the hard floors.
 *
 * Greed order: greediest (lowest rank) first when feeding, last when draining.
 * The same comparison is read in both directions, so no tier can be fed out of
 * one order and drained out of another.
 */
function waterFill(
  widths: Map<SidebarSide, number>,
  rails: readonly RailBounds[],
  need: number,
  surplus: boolean,
  bound: (rail: RailBounds) => number,
): number {
  let outstanding = need;
  const ordered = [...rails].sort((a, b) =>
    surplus ? a.rank - b.rank : b.rank - a.rank,
  );
  const capacityOf = (rail: RailBounds): number => {
    const standing = widths.get(rail.side) as number;
    return Math.max(0, surplus ? bound(rail) - standing : standing - bound(rail));
  };
  for (let start = 0; start < ordered.length && outstanding > 0; ) {
    let end = start;
    while (end < ordered.length && ordered[end].rank === ordered[start].rank) {
      end += 1;
    }
    // One tier: equal-rank rails split what the tier takes evenly, and a
    // member that hits its bound hands the rest back to the members still
    // short of theirs. Ordering the tier by capacity makes that a single pass
    // rather than a loop.
    const tier = ordered
      .slice(start, end)
      .sort((a, b) => capacityOf(a) - capacityOf(b));
    for (let i = 0; i < tier.length && outstanding > 0; i += 1) {
      const rail = tier[i];
      const standing = widths.get(rail.side) as number;
      const taken = Math.min(outstanding / (tier.length - i), capacityOf(rail));
      widths.set(rail.side, surplus ? standing + taken : standing - taken);
      outstanding -= taken;
    }
    start = end;
  }
  return outstanding;
}

/**
 * The coarse stride the total scan takes before rescanning at 1px around the
 * coarse winner.
 *
 * A binary search would be tempting — every seam is non-increasing in the
 * rails' total, so overlap is monotone — but `imposeRect`'s `max(0, band − w)`
 * clamps a pane's travel at zero, which FLATTENS that relationship wherever a
 * pane has run out of room, and with unequal card widths those flat regions do
 * not line up. A scan is robust to that; a binary search would be correct
 * almost always, which is the worst kind of correct.
 *
 * If the exhaustive cross-check in the solutions sweep ever fails, this stride
 * is wrong — not the objective.
 */
const TOTAL_SCAN_STRIDE_PX = 16;

/**
 * The lexicographic score of a candidate total: occlusion, then cramping, then
 * raggedness, then distance from the widths the user chose.
 *
 * The candidate is evaluated through a `RailWidths` carrying THE SAME SIDES
 * the answer will carry. The split across those sides is immaterial — the band
 * depends only on the total — but the number of standing sides is not, because
 * `resolveSpan` spends one imposition gap per occupied side.
 */
function scoreRailTotal(
  input: AllocatorInput,
  chain: readonly { slot: number; width: number }[],
  total: number,
  sides: readonly SidebarSide[],
  preferredTotal: number,
): readonly number[] {
  const widths: RailWidths = {};
  for (const side of sides) widths[side] = total / sides.length;
  const picture = pictureOfChain(input, chain, widths);
  return [
    picture.worstOverlap,
    picture.worstShortfall,
    picture.worstError,
    Math.abs(total - preferredTotal),
  ];
}

/** Lexicographic comparison — negative when `a` is the better score. */
function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The rails' total, chosen by the picture it paints ({@link seamPicture})
 * rather than by the least-squares fit.
 *
 * Two domains. The search runs first over `[Σ comfortFloor, Σ ceiling]`; it
 * descends into the range below the comfort floors IF AND ONLY IF some total
 * down there reaches a better TIER of picture than anything up here can —
 * clean over cramped, cramped over occluded. Comfort is surrendered to fix a
 * picture, never merely to improve one: on a chain no total can repair,
 * cramping the rails leaves the user a picture they still see is wrong, at the
 * cost of a rail they can no longer read.
 */
function chooseRailTotal(
  input: AllocatorInput,
  chain: readonly { slot: number; width: number }[],
  totals: {
    floorTotal: number;
    comfortTotal: number;
    ceilingTotal: number;
    preferredTotal: number;
    sides: readonly SidebarSide[];
  },
): number {
  const { floorTotal, comfortTotal, ceilingTotal, preferredTotal, sides } = totals;
  const score = (total: number): readonly number[] =>
    scoreRailTotal(input, chain, total, sides, preferredTotal);

  // The closed-form fit is no longer the answer, but it is still an excellent
  // guess at where the answer sits, so it joins the coarse candidates.
  const fitted = solveSidebarWidths(input);

  const bestIn = (lo: number, hi: number): number => {
    if (hi <= lo) return lo;
    let best = lo;
    let bestScore = score(lo);
    const consider = (candidate: number): void => {
      if (candidate <= lo || candidate > hi) return;
      const candidateScore = score(candidate);
      // Ties keep the SMALLER total, which the ascending sweep already does
      // and this makes true of the out-of-order candidates too.
      if (
        compareScores(candidateScore, bestScore) < 0 ||
        (compareScores(candidateScore, bestScore) === 0 && candidate < best)
      ) {
        best = candidate;
        bestScore = candidateScore;
      }
    };
    for (let t = lo + TOTAL_SCAN_STRIDE_PX; t < hi; t += TOTAL_SCAN_STRIDE_PX) {
      consider(t);
    }
    consider(hi);
    if (fitted !== null) consider(Math.min(Math.max(fitted, lo), hi));
    // Then 1px around the coarse winner, which is where the true optimum sits:
    // the score is monotone in the total on either side of it up to the stride.
    const fineLo = Math.max(lo, best - TOTAL_SCAN_STRIDE_PX);
    const fineHi = Math.min(hi, best + TOTAL_SCAN_STRIDE_PX);
    for (let t = fineLo; t <= fineHi; t += 1) consider(t);
    return best;
  };

  // How well a total reads, in three tiers: CLEAN (nothing occluded and no
  // seam under the gap), UNOCCLUDED (nothing on top of anything, but the
  // rhythm is cramped), and OCCLUDED. Comfort is surrendered if and only if
  // doing so reaches a HIGHER tier — never to improve the picture within one.
  //
  // Both of the lower tiers are the chain failing to read as arranged, and
  // both are repaired by the same few pixels of rail, which is why the rule
  // cannot turn on occlusion alone: on a three-up deck of slim cards with the
  // Overview's rail on one edge, the total that tiles can land a handful of
  // pixels BELOW the comfort floors. Nothing occludes there, so an
  // overlap-only rule holds the measure and paints every interior seam at 2px
  // instead of 5 — cramped rhythm bought for six pixels of width nobody was
  // reading, in a trap door a few pixels wide that a window resize walks
  // straight through.
  //
  // It cannot turn on cleanliness alone either: where the comfort domain is
  // occluded and the range below it can only get as far as cramped, giving up
  // comfort still buys the user their cards back, and a clean-or-nothing rule
  // would refuse it. Tiers say both of those in one comparison, and keep the
  // yes/no character that makes the rule testable.
  const tierOf = (total: number): number => {
    const key = score(total);
    if (key[0] > 0) return 0;
    return key[1] > 0 ? 1 : 2;
  };
  const comfortBest = bestIn(comfortTotal, ceilingTotal);
  const comfortTier = tierOf(comfortBest);
  if (comfortTier === 2) return comfortBest;
  const hardBest = bestIn(floorTotal, ceilingTotal);
  return tierOf(hardBest) > comfortTier ? hardBest : comfortBest;
}

/**
 * The raw closed-form solve — the rails' TOTAL width that would put every seam
 * on one imposition gap, with no flex range applied and nothing said about how
 * the total is shared out — or `null` when there is nothing to solve for (no
 * rail standing, fewer than two occupied slots, a degenerate chain, a
 * non-finite input).
 *
 * Split out from {@link allocateSidebarWidths} so the number the fit actually wants
 * is inspectable on its own. The range check is a policy about how far the deck
 * may move under the user; the solve is the geometry, and the two answer
 * different questions.
 */
export function solveSidebarWidths(input: AllocatorInput): number | null {
  const chain = chainOf(input);
  // Fewer than two cards is no seam, and no seam is nothing to fit.
  if (chain === null || chain.length < 2) return null;
  const railCount = railSidesOf(input.rails).length;
  if (railCount === 0) return null;

  const count = slotCount(input.kind);
  let numerator = 0;
  let denominator = 0;
  for (let j = 0; j < chain.length - 1; j += 1) {
    const near = chain[j];
    const far = chain[j + 1];
    const fNear = travelFraction({ slot: near.slot, count });
    const fFar = travelFraction({ slot: far.slot, count });
    const a = fFar - fNear;
    const c = fNear * near.width - fFar * far.width - near.width;
    numerator += a * (IMPOSITION_GAP_PX - c);
    denominator += a * a;
  }
  if (denominator <= 0) return null;

  // The band identity, read off {@link resolveSpan} rather than written out:
  // `band = span.width − 2 × gap` and `span.width = canvasWidth − Σ(rail + gap)`,
  // so the rails' total is `canvasWidth − (R + 2)·gap − band`. At one rail that
  // is today's `3 × gap`, which is why the constant was safe to write down and
  // is not safe to carry forward — the gap count is a function of how many
  // rails stand, and a closed rail contributes neither width nor gap.
  const band = numerator / denominator;
  const solved = Math.round(
    input.canvasWidth - IMPOSITION_GAP_PX * (railCount + 2) - band,
  );
  return Number.isFinite(solved) ? solved : null;
}

/**
 * The occupied slots as the chain actually reads left to right: duplicates
 * folded to the widest pane standing at that slot, ordered by slot. `null`
 * means the INPUT is unusable — a non-finite number somewhere in it — and
 * nothing else.
 *
 * A chain of fewer than two cards is a perfectly good chain with no seam in
 * it, and it is returned as such. Whether that is an answerable question is
 * the caller's to decide: {@link solveSidebarWidths} genuinely has nothing to
 * fit and says so, while {@link allocateSidebarWidths} still owes every
 * standing rail a width.
 *
 * This is the allocator's ONE validation site — including `greedRank`, which
 * the greed order sorts on and which would make that order nondeterministic
 * if it were `NaN`.
 */
function chainOf(
  input: AllocatorInput,
): readonly { slot: number; width: number }[] | null {
  const { canvasWidth, kind, occupied, rails } = input;
  if (!Number.isFinite(canvasWidth)) return null;
  for (const side of railSidesOf(rails)) {
    const { preferredWidth, minWidth, comfortWidth, greedRank } = rails[
      side
    ] as RailPolicy;
    if (!Number.isFinite(preferredWidth) || preferredWidth <= 0) return null;
    if (!Number.isFinite(minWidth)) return null;
    if (!Number.isFinite(comfortWidth)) return null;
    if (!Number.isFinite(greedRank)) return null;
  }

  const widest = new Map<number, number>();
  for (const entry of occupied) {
    if (!Number.isFinite(entry.width) || !Number.isFinite(entry.slot)) return null;
    const slot = clampSlot(kind, entry.slot);
    const held = widest.get(slot);
    if (held === undefined || entry.width > held) widest.set(slot, entry.width);
  }
  return [...widest.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, width]) => ({ slot, width }));
}

/**
 * How the chain reads when the rails stand at `widths`: the widest any seam
 * misses {@link IMPOSITION_GAP_PX} by (`worstError` — how ragged), the deepest
 * any pair of neighbours occlude one another (`worstOverlap` — zero when
 * nothing overlaps), and the tightest any seam falls SHORT of the gap
 * (`worstShortfall` — zero when no seam is cramped).
 *
 * **This is the objective the rails' total is chosen against**, not a report
 * written after the fact. The chooser scans the candidate totals and keeps the
 * one whose picture scores best; the reason it scores THIS and not the
 * least-squares fit is the difference between the two measurements below.
 *
 * Measured from {@link imposeRect}'s actual rule rather than from the linear
 * form {@link solveSidebarWidths} fits. The two agree while every pane still
 * has travel left, and part company exactly when a pane is wider than the
 * band: the real rule clamps its travel at zero and the line does not, so on a
 * crowded deck the linear form describes a picture the browser never paints —
 * which is precisely the deck the allocator most needs to get right.
 *
 * The three readings are separate because the failures are separate.
 * `worstOverlap` is occlusion: a card the user cannot see. `worstShortfall` is
 * cramping: a chain that reads as broken rather than arranged. `worstError`
 * takes a seam over the gap as seriously as one under it, which is right for
 * raggedness and wrong for either of the other two — a slightly airy chain
 * still reads as arranged.
 */
export function seamPicture(
  input: AllocatorInput,
  widths: RailWidths,
): { worstError: number; worstOverlap: number; worstShortfall: number } {
  const chain = chainOf(input);
  if (chain === null || chain.length < 2) {
    return { worstError: 0, worstOverlap: 0, worstShortfall: 0 };
  }
  return pictureOfChain(input, chain, widths);
}

/**
 * {@link seamPicture} with the chain already in hand — the form the total
 * chooser calls, since it reads the same chain a few dozen times over and
 * `chainOf` folds and sorts the occupancy afresh on every call.
 */
function pictureOfChain(
  input: AllocatorInput,
  chain: readonly { slot: number; width: number }[],
  widths: RailWidths,
): { worstError: number; worstOverlap: number; worstShortfall: number } {
  // The span comes from `resolveSpan`, not from an inline single-rail
  // expression: with rails on both edges the band is inset twice, and a span
  // built for one of them describes a picture the browser never paints — which
  // is the one thing this test may not do.
  const span = resolveSpan(
    { width: input.canvasWidth, height: 0 },
    railsOf(widths),
  );
  const count = slotCount(input.kind);
  let worstError = 0;
  let worstOverlap = 0;
  let worstShortfall = 0;
  for (let j = 0; j < chain.length - 1; j += 1) {
    const near = chain[j];
    const far = chain[j + 1];
    const nearRect = imposeRect({ slot: near.slot, count }, near.width, span);
    const farRect = imposeRect({ slot: far.slot, count }, far.width, span);
    const seam =
      farRect.position.x - (nearRect.position.x + nearRect.size.width);
    worstError = Math.max(worstError, Math.abs(seam - IMPOSITION_GAP_PX));
    worstOverlap = Math.max(worstOverlap, -seam);
    worstShortfall = Math.max(worstShortfall, IMPOSITION_GAP_PX - seam);
  }
  return { worstError, worstOverlap, worstShortfall };
}

/**
 * The Lens's frame: pinned to the side it holds, one gap in on three edges and
 * the deeper gap at the bottom, at the width the pane carries.
 *
 * The Lens is imposed but it is not a link in the chain. A chain link travels
 * across the band and can end up overlapped when the deck is crowded. The Lens
 * must never be overlapped, so it holds the strip's far end at a fixed pin and
 * the cards share what is left of the band ({@link resolveSpan}).
 *
 * The side is emitted as a **number**, not as a pin, and the pin is one
 * expression that reads it: {@link LENS_RAIL_PROPERTY} is 0 on the left and 1
 * on the right, and `left` mixes the two anchors by it. The rail is a static
 * side selector — it is written at re-imposition and holds until the next one.
 *
 * The two anchors cannot be emitted as two values of `left`, which is what the
 * rail exists to avoid: the left anchor is `5px` and the right one is
 * `100% - width - gap`, and a bare length and a percentage are not the same
 * kind of value, so `left` would have to carry a shape that changes with the
 * side. Nor can the left anchor be dressed as a percentage — a `calc(0% + 5px)`
 * is simplified straight back to `5px` at computed-value time. One expression
 * over a number keeps the frame's resting geometry a single property whichever
 * side it holds.
 *
 * Crossing between the two sides is not this expression's job. The Lens travels
 * by the same measured FLIP tween as every other frame (`deck-canvas.tsx`,
 * `lib/pane-flip.ts`): the new side lands in one layout pass and a transform
 * carries the frame across. Interpolating the rail instead would re-resolve
 * `left` — and re-run layout — on every frame of the crossing.
 *
 * The width is read from {@link sidebarWidthProperty}'s property rather than
 * written as a length, and the pin is written in terms of the same expression.
 * On a right-side deck the pin IS the width (`100% - width - gap`), so a width
 * that changes without the pin changing means the pinned edge is the one that
 * moves — which is precisely backwards: the deck edge is what the sidebar
 * holds, and the dragged edge is the only one a resize may move. One property
 * feeding both makes that true by construction rather than by the drag
 * remembering to update two numbers.
 *
 * **A shared rail is a stack by default; the user may split it.** Two sidebar
 * cards on one side get the *same* geometry — same pin, same width property,
 * same full vertical run — and stand front-to-back, exactly as two panes
 * sharing a slot do; which one you see is the deck's z-order, and the title
 * bar's stack badge is how you reach the one behind. That is the resting state,
 * and it stays the default.
 *
 * Both arrangements have now been lived on, and each was found wanting alone.
 * An automatic vertical split was tried first and was a worse Lens: it spent a
 * rail's height to show two half-cards, which is what the Jots section was
 * already doing inside the Lens, only less space-efficient. The stack that
 * replaced it hides content the user wants visible at once. What both verdicts
 * point at is that the division is a *choice*, so the user makes it per side —
 * {@link RailArrangement} records it, and passing `options.member` here is what
 * a split member's frame asks for. Without `member`, or with a rail of one, the
 * output is byte-identical to the stacked frame it has always been.
 *
 * A split member's vertical pins are the run's fractions in `calc()`, read from
 * the seam properties ({@link railSeamProperty}) rather than resolved here, for
 * the same reason the width is: the browser re-resolves fractions of the run on
 * its own reflow, so a window resize costs no JavaScript ([L06]), and a seam
 * drag is one `setProperty` call.
 */
export function imposeSidebarStyle(
  side: SidebarSide,
  paneWidth: number,
  options: { widthProperty?: string; member?: RailMemberPlacement } = {},
): React.CSSProperties {
  const rail = side === "right" ? 1 : 0;
  const widthProperty = options.widthProperty ?? sidebarWidthProperty(side);
  const width = `var(${widthProperty}, ${paneWidth}px)`;
  const style: Record<string, string | number> = {
    width,
    height: "auto",
    ...railMemberPins(options.member),
    [LENS_RAIL_PROPERTY]: rail,
    left:
      `calc(var(${LENS_RAIL_PROPERTY}) * (100% - ${width} - ${GAP})` +
      ` + (1 - var(${LENS_RAIL_PROPERTY})) * ${GAP})`,
  };
  return style as React.CSSProperties;
}

/** The vertical run a rail's members divide: the frames' container less the
 *  gap it keeps at the top and the deeper one it keeps at the bottom. */
const RAIL_RUN = `(100% - ${GAP} - ${GAP_BOTTOM})`;

/** Half an imposition gap — each seam takes one, half from each neighbour, so
 *  the air between two split members reads as the same rhythm as every other
 *  seam on the deck. */
const RAIL_SEAM_HALF_GAP = `${IMPOSITION_GAP_PX / 2}px`;

/**
 * A member's `top` and `bottom` — the rail's own endpoints for the first and
 * last member, and the seam either side of it for the rest.
 *
 * The endpoints are written as the bare gaps rather than as fractions of the
 * run so the ends of a split rail land on exactly the pins an unsplit one has:
 * a top member and a stacked card share a top edge to the pixel, and the eye
 * reads a split as a division of the card it already knew.
 */
function railMemberPins(
  member: RailMemberPlacement | undefined,
): { top: string; bottom: string } {
  if (member === undefined) return { top: GAP, bottom: GAP_BOTTOM };
  return memberPins(member, (j) => railSeamProperty(member.side, j));
}

/**
 * A split member's `top` and `bottom`, given the place it stands in and the
 * property carrying each seam of that place.
 *
 * The whole of what a rail member and a column member share, which is
 * everything but the property name: both divide the same vertical run, both
 * take half a gap either side of a seam, and both pin their outer edge to the
 * run's own endpoint rather than to a fraction. That last part is what makes a
 * split read as a division of the card the eye already knew — the top member
 * and a stacked card share a top edge to the pixel.
 *
 * A place of fewer than two members is not divided, so it gets the undivided
 * pins. That is the byte-identity the split feature rests on: a slot or a side
 * that has never been split, or has dropped to one member, produces exactly the
 * frame it produced before either could be split at all.
 */
function memberPins(
  member: { index: number; count: number },
  seamProperty: (index: number) => string,
): { top: string; bottom: string } {
  const { index, count } = member;
  if (count < 2) return { top: GAP, bottom: GAP_BOTTOM };
  const seam = (j: number): string =>
    `var(${seamProperty(j)}, ${(j + 1) / count})`;
  return {
    top:
      index === 0
        ? GAP
        : `calc(${GAP} + ${seam(index - 1)} * ${RAIL_RUN} + ${RAIL_SEAM_HALF_GAP})`,
    bottom:
      index === count - 1
        ? GAP_BOTTOM
        : `calc(${GAP_BOTTOM} + (1 - ${seam(index)}) * ${RAIL_RUN} + ${RAIL_SEAM_HALF_GAP})`,
  };
}

/**
 * The custom property carrying seam `index` of slot `slot`, as a plain number
 * in (0, 1) — the fraction of the run the seam sits at.
 *
 * The place-keyed twin of {@link railSeamProperty}, and unregistered for the
 * same reason: every expression reading one supplies the equal-division
 * fraction as its `var()` fallback, so a frame rendered before the properties
 * land still tiles its column.
 */
export function columnSeamProperty(slot: number, index: number): string {
  return `--tug-slot-${slot}-seam-${index}`;
}

/**
 * The custom property carrying slot `slot`'s column offset — how far its strip
 * of members has been slid up behind the run, in px.
 *
 * The vertical twin of {@link FLOW_OFFSET_PROPERTY}, and per-slot because each
 * overflowing column scrolls on its own. Unregistered, and every expression
 * reading one supplies `0px` as its fallback, so a frame rendered before the
 * property lands stands at the strip's top.
 */
export function columnOffsetProperty(slot: number): string {
  return `--tug-slot-${slot}-column-offset`;
}

/**
 * How a column of `count` members divides its run.
 *
 * `"shared"` — two members or fewer: the run is divided between them at a
 * draggable seam, which is what a column has always done.
 *
 * `"overflow"` — three or more: division stops being useful past about two and
 * a half visible members, so the members stop dividing and start stacking down
 * a strip of fixed-height cards that scrolls behind the run. The half-visible
 * member at the bottom edge IS the affordance, the way flow's clipped card at
 * the band edge is.
 */
export type ColumnStanding = "shared" | "overflow";

/** The member count at which a column stops dividing and starts stacking. */
export const COLUMN_OVERFLOW_MIN_MEMBERS = 3;

/** How many members an overflowing column shows at once — two whole ones and
 *  the half that says there is more below. */
export const COLUMN_OVERFLOW_VISIBLE_MEMBERS = 2.5;

/** @see {@link ColumnStanding} */
export function columnStanding(count: number): ColumnStanding {
  return count >= COLUMN_OVERFLOW_MIN_MEMBERS ? "overflow" : "shared";
}

/** One split member's place in its column: which slot, which position, and how
 *  many members it divides the run with. */
export interface ColumnMemberPlacement {
  slot: number;
  index: number;
  count: number;
}

/** An overflowing member's height: the run over the number of members meant to
 *  be visible in it. A pure function of the run, so no pane is measured and the
 *  browser re-resolves it on reflow. */
const COLUMN_MEMBER_HEIGHT = `(${RAIL_RUN} / ${COLUMN_OVERFLOW_VISIBLE_MEMBERS})`;

/** The strip `count` overflowing members make: their heights plus the gap
 *  standing between each neighbouring pair. */
function columnStripHeight(count: number): string {
  return `(${count} * ${COLUMN_MEMBER_HEIGHT} + ${(count - 1) * IMPOSITION_GAP_PX}px)`;
}

/**
 * A column member's `top` and `bottom` — the column's own endpoints for the
 * first and last member, and the seam either side of it for the rest.
 *
 * Byte-identical to the undivided frame when the member is absent or its column
 * holds one member, which is what lets {@link imposeStyle} take the option
 * unconditionally.
 *
 * At three members or more the column overflows ({@link columnStanding}) and
 * the pins change shape entirely: every member takes the same
 * {@link COLUMN_MEMBER_HEIGHT}, they stack down a strip with the imposition gap
 * between them, and the whole strip is slid up by the slot's offset. The offset
 * is CLAMPED HERE, in CSS, for the reason flow's is clamped inside its `left`:
 * make the window taller and the run grows while the stored number stands
 * still, and without the clamp the column would hold a stale slide until the
 * settled-resize retune fired. Both terms are expressible over `100%`, so a
 * resize costs no JavaScript ([L06]).
 *
 * `bottom` is not a pin the eye reads — it is `100%` less the top and the
 * height, which is how a fixed-height member is stated in a `top`/`bottom`
 * frame. The last members of a long strip resolve it negative, and that is the
 * point: they hang below the run and the canvas clips them.
 */
export function columnMemberPins(
  member: ColumnMemberPlacement | undefined,
): { top: string; bottom: string } {
  if (member === undefined) return { top: GAP, bottom: GAP_BOTTOM };
  if (columnStanding(member.count) === "shared") {
    return memberPins(member, (j) => columnSeamProperty(member.slot, j));
  }
  const offset =
    `min(var(${columnOffsetProperty(member.slot)}, 0px), ` +
    `max(0px, ${columnStripHeight(member.count)} - ${RAIL_RUN}))`;
  const advance =
    member.index === 0
      ? "0px"
      : `${member.index} * (${COLUMN_MEMBER_HEIGHT} + ${GAP})`;
  return {
    top: `calc(${GAP} + ${advance} - ${offset})`,
    bottom: `calc(100% - ${GAP} - ${advance} - ${COLUMN_MEMBER_HEIGHT} + ${offset})`,
  };
}

