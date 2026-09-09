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
 * leftmost position on the deck, whatever side the rail holds and whether or
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
 * than pooling beside the rail; an arrangement that stays still is worth more
 * than one whose margins collect in one place.
 *
 * When the cards are wider than their share, the offsets crowd together and the
 * cards **overlap** — an ordinary outcome of a narrow deck. A pane wider than
 * the whole band has no travel at all (`max(0, …)`) and sits on the far edge in
 * every slot.
 *
 * The rail is imposed too, by {@link imposeSidebarStyle}, but it is the strip's
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
 * a click in the Layout card, a card assigned to a slot (the imposer's own
 * verb, whichever door dispatched it — the Cards card's slot picker or a ⌘N chord),
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

import { DEFAULT_GREED_RANK } from "../card-registry";

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

/**
 * How one PLACE resolves its members' heights against its run — the vertical
 * twin of {@link ImpositionLayout}, and deliberately a distinct type ([B05]).
 *
 * `"fit"` — the run is the constraint. The members divide it by the allocation
 * ladder: floors, comfort in greed order, and the discretionary pool by weight
 * under each member's natural height. Nobody overflows and the run is filled.
 *
 * `"flow"` — the content is the constraint. Every member stands at its own
 * height, the strip is as long as that makes it, and it scrolls behind the run.
 * Nobody is stretched and nobody is squeezed.
 *
 * The same two words as the deck's band, because it is the same choice one axis
 * over: whether the place should fit the screen, or the screen should be a
 * window onto the place. A SEPARATE TYPE all the same, so a deck layout can
 * never be handed where a place layout is read or the reverse — the two are
 * chosen in different places, stored in different fields, and mean the same
 * thing about different runs.
 */
export type PlaceLayout = "fit" | "flow";

/** The layout a place reads under when it has never said otherwise, and what
 *  every blob written before the choice existed means. */
export const DEFAULT_PLACE_LAYOUT: PlaceLayout = "fit";

/** Narrow an unknown (a parsed blob field, an action payload) to a place
 *  layout. */
export function isPlaceLayout(value: unknown): value is PlaceLayout {
  return value === "fit" || value === "flow";
}

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
   * How the side's run is resolved when it is split; absent reads as
   * {@link DEFAULT_PLACE_LAYOUT}, so every rail that predates the choice comes
   * back exactly as it stood.
   *
   * Meaningful only under `"split"`. A stacked rail stores it and ignores it,
   * exactly as it stores `shares`: the choice describes how a division is
   * resolved, and a stack has no division — but re-splitting has to land on the
   * arrangement the user chose rather than on a default.
   */
  layout?: PlaceLayout;
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
  /**
   * The members standing on the side when the rail as a whole was last hidden,
   * by componentId — what showing the rail again brings back.
   *
   * A rail toggle addresses the SIDE, so hiding one closes every member at once
   * and showing it has to know which ones to reopen. `order` cannot answer
   * that: it outlives the members it names deliberately ([L23]), so it still
   * holds the card the user closed by hand a week ago, and reading it would
   * resurrect that card the first time the rail was shown. This field records
   * the membership at the moment of the hide and is cleared by the show that
   * consumes it, which is what makes it a memory rather than an arrangement —
   * `order` and `shares` are untouched throughout, so every member's position
   * and height survives the round trip whether it was standing or not.
   */
  hidden?: string[];
}

/**
 * How the content cards sharing one slot stand against one another: the same
 * three fields a rail carries, over a place that runs down a column of the deck
 * rather than down an edge.
 *
 * Deliberately the same shape as {@link RailArrangement}, because a slot and a
 * rail are the same kind of place — a run of vertical space several cards may
 * either take turns in or divide. Sharing the shape is what lets
 * {@link allocatePlaceHeights} and {@link placeSharesFromHeights} serve both
 * without a fork; they take a place's members rather than a side, so they were
 * place-agnostic before a column existed.
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
  /** How the slot's run is resolved when it is split; absent reads as
   *  {@link DEFAULT_PLACE_LAYOUT}. Meaningful only under `"split"`, on
   *  {@link RailArrangement.layout}'s own reasoning. */
  layout?: PlaceLayout;
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

/** How `side`'s run is resolved: what it stored, or fit. */
export function railLayoutOf(
  imposition: DeckImposition,
  side: SidebarSide,
): PlaceLayout {
  const stored = imposition.rails?.[side]?.layout;
  return isPlaceLayout(stored) ? stored : DEFAULT_PLACE_LAYOUT;
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

/** The imposition with `side` fitting or flowing its run, keeping its mode,
 *  order and shares. */
export function withRailLayout(
  imposition: DeckImposition,
  side: SidebarSide,
  layout: PlaceLayout,
): DeckImposition {
  return withRailField(imposition, side, { layout });
}

/** The imposition with `side`'s members in `order`, top to bottom. */
export function withRailOrder(
  imposition: DeckImposition,
  side: SidebarSide,
  order: readonly string[],
): DeckImposition {
  return withRailField(imposition, side, { order: [...order] });
}

/**
 * The imposition with `componentId` moved from the rail it stands on to
 * position `index` of `side`'s rail — its side, the origin's order, and the
 * destination's order in ONE imposition, so a cross-side drop arms exactly
 * one settle. The precedent is a split: {@link withRailMode}'s caller writes
 * the mode and the order it materializes in one commit, never two, because a
 * second commit under the same gesture is a second settle under the user's
 * hand. Changing the side alone would first land the card at the side's
 * default position and tween it there, and only then move it to `index`.
 *
 * `standing` is each side's members in the vertical order they hold, the
 * caller's to supply for the reason {@link effectiveRailOrder} states: a pure
 * module cannot see the registry. The card is removed from wherever it appears
 * in either list, inserted at `index` of the destination (clamped to the
 * list's ends), and the origin's order is written without it — the same
 * standing-members order a same-side reorder stores.
 */
export function withSidebarMovedToRail(
  imposition: DeckImposition,
  componentId: string,
  side: SidebarSide,
  index: number,
  standing: Readonly<Record<SidebarSide, readonly string[]>>,
): DeckImposition {
  const from = sidebarSide(imposition, componentId);
  const destination = standing[side].filter((id) => id !== componentId);
  const at = Math.max(0, Math.min(index, destination.length));
  destination.splice(at, 0, componentId);
  let next = withSidebarSide(imposition, componentId, side);
  if (from !== side) {
    next = withRailOrder(
      next,
      from,
      standing[from].filter((id) => id !== componentId),
    );
  }
  return withRailOrder(next, side, destination);
}

/** The members `side` held when its rail was last hidden whole, or an empty
 *  list when there is no such memory — the rail has never been hidden that way,
 *  or the show that consumed the memory has already run. */
export function railHiddenMembers(
  imposition: DeckImposition,
  side: SidebarSide,
): readonly string[] {
  return imposition.rails?.[side]?.hidden ?? [];
}

/** The imposition remembering that `side` held `hidden` when its rail went
 *  away — or, given an empty list, remembering nothing, which is what a show
 *  writes once it has reopened what the memory named. */
export function withRailHidden(
  imposition: DeckImposition,
  side: SidebarSide,
  hidden: readonly string[],
): DeckImposition {
  return withRailField(imposition, side, {
    hidden: hidden.length === 0 ? undefined : [...hidden],
  });
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
 * A weight that is not a finite non-negative number reads as 1 rather than as
 * an error. These arrive from a JSON blob and from gesture arithmetic, and a
 * rail that refuses to lay itself out because one number is `NaN` is worse
 * than a rail that divides evenly.
 *
 * Zero is a weight, not an absence: a member a drag pushed down to its floor
 * has no share of the discretionary pool and says so with a zero ([P04]).
 * {@link sharedHeightsOf} divides evenly when every weight is zero, which is
 * the only reading a total of nothing has.
 */
export function railWeightOf(
  shares: Readonly<Record<string, number>> | undefined,
  componentId: string,
): number {
  const weight = shares?.[componentId];
  return typeof weight === "number" && Number.isFinite(weight) && weight >= 0
    ? weight
    : 1;
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

/**
 * The custom property carrying `side`'s rail offset — how far its strip of
 * members has been slid up behind the run, in px.
 *
 * The side-keyed twin of {@link columnOffsetProperty}, per side because each
 * overflowing rail scrolls on its own, and unregistered for the reason the
 * seams are: every expression reading one supplies `0px` as its `var()`
 * fallback, so a frame rendered before the property lands stands at the strip's
 * top.
 */
export function railOffsetProperty(side: SidebarSide): string {
  return `--tug-rail-${side}-offset`;
}

/**
 * The custom property carrying strip coordinate `index` on `side`'s overflowing
 * rail, in px — the top of member `index`, and for `index === n` the length of
 * the whole strip.
 *
 * There are `n + 1` of these for `n` members because the strip's own end is a
 * coordinate the frames read: the last member's bottom is it, and the offset
 * clamp is it less the run. The values are absolute px rather than fractions
 * because an overflowing strip is longer than the run and a fraction of the run
 * would say nothing about where the strip ends.
 *
 * Unregistered, the same discipline {@link railSeamProperty} holds: every
 * expression reading one supplies the coordinate it was rendered against as its
 * `var()` fallback, so a frame that renders before the properties land stands
 * where the allocation put it.
 */
export function railStripProperty(side: SidebarSide, index: number): string {
  return `--tug-rail-${side}-strip-${index}`;
}

/** One split member's place in its rail: which side, which position, and how
 *  many members it divides the run with. */
export interface RailMemberPlacement {
  side: SidebarSide;
  index: number;
  count: number;
  /** How the place stands — {@link allocatePlaceHeights}'s own answer, carried
   *  here because the pins fork on it and a member cannot see the run its
   *  place was allocated against. */
  standing: PlaceStanding;
  /** The overflowing place's strip coordinates, `n + 1` of them, as the
   *  allocation resolved them: the `var()` fallbacks the frame stands at
   *  before the canvas publishes the properties. Absent while sharing. */
  strip?: readonly number[];
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

/** How `slot`'s run is resolved: what it stored, or fit. */
export function columnLayoutOf(
  imposition: Pick<DeckImposition, "columns">,
  slot: number,
): PlaceLayout {
  const stored = imposition.columns?.[slot]?.layout;
  return isPlaceLayout(stored) ? stored : DEFAULT_PLACE_LAYOUT;
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

/** The imposition with `slot` fitting or flowing its run, keeping its mode,
 *  order and shares. */
export function withColumnLayout(
  imposition: DeckImposition,
  slot: number,
  layout: PlaceLayout,
): DeckImposition {
  return withColumnField(imposition, slot, { layout });
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

/** Every imposition kind, in ascending slot count — the Layout card's picker order. */
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
 * edges, from the rail, and from the pane in the neighbouring slot.
 *
 * This is the same gap the Option-drag snap holds between two card edges —
 * `tug-pane.tsx` imports it for `computeSnap` / `computeResizeSnap` rather than
 * declaring its own. A pane placed by the imposer and a pane snapped by hand
 * therefore land on the same rhythm.
 */
export const IMPOSITION_GAP_PX = 5;

/**
 * The **bottom** imposition gap a MAKER's canvas keeps, which is deeper than
 * the other three because it has a tenant: the host draws a dev-info strip in
 * the canvas's bottom-left corner — the branch, revision, and build stamps —
 * 8px above the canvas bottom and about 19px tall. A pane imposed to the
 * ordinary gap runs straight through it. This depth clears the strip and
 * leaves one ordinary gap of air above it, so nothing imposed ever collides
 * with the stamps.
 *
 * A release build draws no stamps, so it keeps no band for them: the bottom
 * gap there is {@link IMPOSITION_GAP_PX}, the same air as the other three
 * edges. The deeper band was once also read as typography — a heavier bottom
 * margin than top, as old as the printed page — but the deck is a canvas of
 * movable frames rather than a page, and a reader who cannot see what the
 * reserved stripe is for reads it as dead pixels rather than as a margin.
 */
export const IMPOSITION_GAP_BOTTOM_MAKER_PX = 32;

/**
 * The property the bottom gap crosses into CSS on, so the imposer's emitted
 * `calc()` strings state the gap ONCE, by name, and a build that keeps a
 * different band changes it in a single property write rather than in every
 * expression that mentions it.
 *
 * The fallback in every `var()` is the maker depth, which is the safe way
 * round: a page that never learns its profile keeps the band that clears the
 * stamps rather than the one that runs through them.
 */
export const IMPOSITION_GAP_BOTTOM_PROPERTY = "--tug-imposer-gap-bottom";

let gapBottomPx = IMPOSITION_GAP_BOTTOM_MAKER_PX;

/**
 * The bottom gap this page imposes to, in px — the numeric twin of
 * {@link IMPOSITION_GAP_BOTTOM_PROPERTY}, for the arithmetic that cannot go
 * through CSS: a run height, a seam's travel.
 */
export function impositionGapBottomPx(): number {
  return gapBottomPx;
}

/**
 * The bottom pin a pinned rail keeps, in px — the numeric twin of the
 * `RAIL_GAP_BOTTOM` expression the rail's frames read.
 *
 * A rail's bottom is the edge inset, as its top is, except that a MAKER's
 * canvas has a tenant at the foot: the dev-info strip. The bottom gap clears
 * that strip and leaves one card gap of air above it; a panel touching the
 * strip reads as furniture meeting furniture, so the rail gives up the air and
 * keeps the clearance — the bottom gap less the card gap, plus the edge inset.
 * A release build has no strip, and the rail runs flush to the foot there
 * exactly as it does to the top.
 */
export function railGapBottomPx(): number {
  return gapBottomPx - IMPOSITION_GAP_PX + RAIL_EDGE_INSET_PX;
}

/**
 * Settle the bottom gap from the host's build profile. Called once at boot,
 * when the maker-mode round trip lands; returns whether the gap actually
 * moved, which is the caller's cue to stamp the property and re-impose.
 *
 * It does not touch the document itself: this module resolves geometry and
 * emits the expressions that read the property, and the one element the
 * property belongs on is the boot sequence's to name.
 */
export function setImpositionGapBottom(makerMode: boolean): boolean {
  const next = makerMode ? IMPOSITION_GAP_BOTTOM_MAKER_PX : IMPOSITION_GAP_PX;
  if (next === gapBottomPx) return false;
  gapBottomPx = next;
  return true;
}

/**
 * The **rail edge inset**: a pinned rail's stand-off from the window edge on
 * its outer side and at its top. It is one of the two lengths that name a
 * rail's geometry apart from the card gap ({@link RAIL_GUTTER_PX} is the
 * other), so the rail can stand flush to the window while every seam between
 * cards keeps {@link IMPOSITION_GAP_PX}. The property is the CSS twin, on the
 * bottom gap's pattern: every emitted `calc()` names it, and `main.tsx` stamps
 * it on the document root once so a stylesheet can read it too.
 *
 * Zero: a rail is a panel of the window, not a card on the paper, so it
 * stands flush. The card gap (5) would put it back on the paper as one more
 * card, which is the reading the panel treatment exists to break.
 */
export const RAIL_EDGE_INSET_PX = 0;

export const RAIL_EDGE_INSET_PROPERTY = "--tug-rail-edge-inset";

/**
 * The **rail gutter**: the space between a pinned rail's inner edge and the
 * band the cards stand in — the first card's near edge is exactly this far
 * from the rail. Wider than the card gap on purpose: the air between a panel
 * and the paper is not the air between two cards, and the width is what says
 * so without tint or livery in the gap.
 */
export const RAIL_GUTTER_PX = 12;

export const RAIL_GUTTER_PROPERTY = "--tug-rail-gutter";

/**
 * The **rail seam**: the air between two members of a split rail, in px. Zero:
 * the members of a panel touch, meeting at one hairline, because a gap between
 * them would be the card gap's rhythm, and that rhythm is what content cards
 * have and a rail does not. A column's members keep {@link IMPOSITION_GAP_PX}
 * at their seams; this is the one place the two kinds of place divide their
 * run differently.
 */
export const RAIL_SEAM_PX = 0;

/**
 * The inset a standing rail contributes to the span, in px — the numeric twin
 * of {@link railSpanInset}.
 *
 * The span keeps one card gap at each end before the first card
 * ({@link imposeRect}), whether or not a rail stands there, so a rail at the
 * edge inset whose inner edge is one gutter from the first card pushes the
 * span in by `edge inset + width + gutter − gap`: the gap the span spends on
 * its own is the last of the gutter. At 5/5 that is `width + gap`, which is
 * the number this arithmetic was once written as.
 */
export function railSpanInsetPx(width: number): number {
  return RAIL_EDGE_INSET_PX + width + RAIL_GUTTER_PX - IMPOSITION_GAP_PX;
}

/**
 * The **rail treatment**: the one name every appearance rule for a pinned
 * rail and the margin it stands in is keyed on. It is written once, as
 * {@link RAIL_TREATMENT_ATTRIBUTE} on the deck's frame container, and the CSS
 * for a treatment is one block scoped under that attribute — so a second
 * treatment is a new value here, one block there, and possibly different
 * values for the two rail lengths, with no expression touched.
 *
 * `panel` is the shipped treatment: the rail as a flush panel of the window
 * rather than a card on the paper. It is a constant rather than a setting
 * because nobody has asked to choose; the attribute is what makes a setting
 * one line away if that changes.
 */
export const RAIL_TREATMENT = "panel";

export const RAIL_TREATMENT_ATTRIBUTE = "data-rail-treatment";

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
 *
 * **This is the one knob for how fast cards move.** Every tween that carries a
 * card to a new place or a new size runs on it: the crossing a changed
 * imposition arms, the fade a split or stack gives a member, the rise an
 * arriving frame plays, and the landing a drop animates into its zone. Raising
 * it slows all of them together, which is the only way they stay one motion.
 * The two durations deliberately outside it are named where they are declared —
 * {@link PANE_EXIT_GHOST_MS}, which is a departure rather than a crossing, and
 * `--tug-timing`, the app-wide multiplier over every Tug animation.
 */
export const IMPOSITION_SETTLE_MS = 400;

/**
 * The settle duration actually in force on `el`, in milliseconds — the resolved
 * `--tugx-imposer-settle-duration`, so a tuning override anywhere up the tree
 * retimes every card that moves under it. Falls back to
 * {@link IMPOSITION_SETTLE_MS} for an unresolvable or malformed value.
 *
 * Here rather than at either call site because both the canvas that arms the
 * settle and the pane that lands a drop have to read the same number, and two
 * parsers of one property is one parser too many.
 */
export function readSettleMs(el: HTMLElement): number {
  const raw = getComputedStyle(el)
    .getPropertyValue("--tugx-imposer-settle-duration")
    .trim();
  const seconds = raw.endsWith("ms") ? 0.001 : raw.endsWith("s") ? 1 : 0;
  if (seconds === 0) return IMPOSITION_SETTLE_MS;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0
    ? value * seconds * 1000
    : IMPOSITION_SETTLE_MS;
}

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
 * Which side a pinned rail holds, as a number: 0 is the left edge, 1 the
 * right. Registered as a `<number>` custom property in `tug-pane.css` so the
 * expression that reads it can compute with it — see {@link imposeSidebarStyle}.
 */
export const RAIL_SIDE_PROPERTY = "--tugx-rail-side";

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

const GAP_BOTTOM = `var(${IMPOSITION_GAP_BOTTOM_PROPERTY}, ${IMPOSITION_GAP_BOTTOM_MAKER_PX}px)`;

/** The rail's two lengths as CSS lengths, each reading its property with the
 *  numeric twin as the fallback, so an expression resolves to the same pixel
 *  whether or not the root has been stamped yet. */
const RAIL_EDGE_INSET = `var(${RAIL_EDGE_INSET_PROPERTY}, ${RAIL_EDGE_INSET_PX}px)`;

const RAIL_GUTTER = `var(${RAIL_GUTTER_PROPERTY}, ${RAIL_GUTTER_PX}px)`;

/** The rail's bottom pin as a CSS length — see {@link railGapBottomPx}. */
const RAIL_GAP_BOTTOM = `calc(${GAP_BOTTOM} - ${GAP} + ${RAIL_EDGE_INSET})`;

/**
 * The inset a standing rail contributes to the span, as a CSS length over the
 * rail's live width expression — the CSS twin of {@link railSpanInsetPx}, and
 * what `deck-canvas.tsx` writes into `--tug-imposer-inset-<side>`. The two
 * state the same identity so the numeric span and the imposed frames cannot
 * part company.
 */
export function railSpanInset(width: string): string {
  return `calc(${RAIL_EDGE_INSET} + ${width} + ${RAIL_GUTTER} - ${GAP})`;
}

/** The CSS custom properties carrying the rail insets (see `deck-canvas.tsx`).
 *  Each carries a standing rail's whole span inset less the gap the band
 *  spends at its own end ({@link railSpanInset}); that gap is added on top of
 *  them here, so the numeric twin below and the CSS agree by construction. */
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

/**
 * The kind's centermost slot, cheating LEFT when the count is even and no
 * single slot is the middle one: `floor((N - 1) / 2)`.
 *
 * Two-up answers 0, three-up answers 1, four-up answers 1, six-up answers 2.
 * The tie has to break somewhere and left is the side the deck already reads
 * from — numbering runs left to right, so the left of the two middles is the
 * earlier one, and a caller that wants the other can say so.
 */
export function centerSlot(kind: ImpositionKind): number {
  return Math.floor((slotCount(kind) - 1) / 2);
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
 * The rail's side is not an input. It moves the band's edges — which is the
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

/** The band the chain is laid across: the canvas minus the rail's inset on the
 *  side it holds. Imposed panes are never under the rail.
 *
 *  The span is the *raw* band — the chain's own imposition gap is not folded in
 *  here, so this stays a plain description of the canvas and the rail. Both
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
 * A rail is itself imposed — it stands the rail edge inset off the canvas edge
 * — so its near edge sits `edge inset + width` in, and the band takes that plus
 * the rail's gutter, less the gap it spends at its own end: the chain's own gap
 * is the last of the gutter, and its far card lands exactly one gutter off the
 * rail. This is the numeric twin of the `--tug-imposer-inset-*` custom
 * properties `deck-canvas.tsx` writes; both are {@link railSpanInsetPx} per
 * occupied side, so they agree by construction.
 *
 * **This function is the gap count.** A closed rail contributes neither width
 * nor inset, so the band a solve must reproduce is `span.width − 2 × gap` for
 * whatever rails stand — never a constant number of gaps written out by hand.
 * What a standing rail contributes is {@link railSpanInsetPx}: its width plus
 * the rail's edge inset and gutter, less the gap the span spends on its own.
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
    const inset = railSpanInsetPx(rail.width);
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
 * `slotWidth` either way, and a pinned card keeps its own size centerd inside
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
  const runHeight = span.height - IMPOSITION_GAP_PX - impositionGapBottomPx();
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
 * every deck — only the two inset terms change when the rail crosses. That is
 * what a flip has to interpolate: one expression, same form on both sides. (An
 * arrangement that measured from the right when the rail was left would be
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
 * stood there, and About is centerd inside it on both axes.
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
  /** The card's own width, centerd across `slotWidth`. */
  width?: number;
  /** The card's own height, centerd down the vertical run. */
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
          // A size-locked card centers inside whatever run it was given, so a
          // split column shrinks the box it centers in rather than taking it
          // out of the division.
          width: `${frameWidth}px`,
          height: `${pinned.height}px`,
          top: `calc(${run.top} + max(0px, (100% - ${run.top} - ${run.bottom} - ${pinned.height}px) / 2))`,
        };

  const band = `(100% - ${INSET_LEFT} - ${INSET_RIGHT} - ${GAP} * 2)`;
  // The centering term is a plain number, not a percentage: both widths are
  // known here, so it never needs the browser to resolve it.
  const centerOffset =
    frameWidth === slotWidth ? 0 : Math.max(0, (slotWidth - frameWidth) / 2);
  const center = frameWidth === slotWidth ? "" : ` + ${centerOffset}px`;

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
    style.left = `calc(0% + ${INSET_LEFT} + ${GAP} + ${placement.flow.stripLeft}px - ${offset}${center})`;

    // The ink stops by OCCLUSION, not by a cut. A card that straddles a band
    // edge travels on under the rail, which is opaque, already outranks every
    // free card, and casts its own shadow over what it covers. The five pixels
    // of margin no rail can stand in are covered by the margin caps
    // `deck-canvas.tsx` stands at each window edge. So the flow branch is the
    // one `left` expression above and nothing else ([B01]).
    return style;
  }

  const fraction = travelFraction(placement);
  // `k / (N - 1) × max(0, band - width)` — see the module note.
  const offset =
    fraction === 0 ? "0px" : `${fraction} * max(0px, ${band} - ${slotWidth}px)`;
  style.left = `calc(0% + ${INSET_LEFT} + ${GAP} + ${offset}${center})`;
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

/** Where the slots stand along the strip, and how long the strip is. */
export interface FlowStrip {
  /** Each standing slot's left edge, measured from the strip's own origin —
   *  which is the band's left edge at offset 0. A held-open empty slot stands
   *  here too; a slot absent from the map has no place at all. */
  positions: ReadonlyMap<number, number>;
  /**
   * Each standing slot's extent — the width its widest member paints at, after
   * duplicates have folded, or the reserved width of a held-open empty one.
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
 * What a held-open empty slot reserves: the widest extent standing in the
 * chain, or `fallback` when nothing stands in it yet.
 *
 * **The cards on the deck, not the preset**, because the reserved room is
 * drawn — it is a gap between frames and a segment in the strip — and a gap
 * sized to a preset the user has overridden reads as wrong however defensible
 * the number is. A place among cards should look like the cards it is among.
 *
 * The fallback is the deck's content width, which is what an empty arrangement
 * has to answer with: with no card standing anywhere there is nothing to match,
 * and the width the next card will open at is the honest guess.
 *
 * The widest rather than the mean or the nearest: a slot's extent already
 * folds to its widest member ({@link FlowSlotExtent}), so this is the same rule
 * one level up, and it is the only one that cannot leave a reserved place too
 * small for the card the deck would put in it.
 */
export function vacancyExtent(
  occupied: readonly { slot: number; width: number }[],
  fallback: number,
): number {
  let widest = 0;
  for (const entry of occupied) {
    if (!Number.isFinite(entry.width)) continue;
    widest = Math.max(widest, entry.width);
  }
  return widest > 0 ? widest : Math.max(0, fallback);
}

/** How an empty slot is held open, when it is. */
export interface FlowVacancy {
  /** How many slots the kind defines — every index below it takes a place. */
  count: number;
  /** The extent an unoccupied slot reserves — {@link vacancyExtent}. */
  extent: number;
}

/**
 * Which slot stands how wide — the input both strip rules read, resolved once
 * so the two of them can never disagree about the deck they are laying out.
 *
 * **An empty slot is a place, not an absence** — given a {@link FlowVacancy}.
 * Slot 3 standing empty holds a card's width open between slots 2 and 4, so a
 * card assigned to slot 4 stands at slot 4 rather than sliding up to where slot
 * 3 would have been. Without that the arrangement collapses under its own
 * numbering: the strip would draw 1|2|4 and a chord naming slot 4 would move
 * the card nowhere the eye could follow, because its place was already the
 * third position in the run.
 *
 * The reserved extent is {@link vacancyExtent} — the widest card standing in
 * the chain — so the room a held-open slot keeps looks like the cards it is
 * kept among, and is never too small for the card the deck would put in it.
 *
 * Omit the vacancy and the run is the occupied slots alone, which is what a
 * caller holding only an occupancy list can honestly ask for.
 *
 * Duplicate entries for one slot fold by taking the widest, matching
 * {@link AllocatorInput.occupied}; unreadable widths are dropped, and a
 * negative one reads as zero.
 */
function slotExtentMap(
  occupied: readonly FlowSlotExtent[],
  vacancy?: FlowVacancy,
): Map<number, number> {
  const extents = new Map<number, number>();
  for (const entry of occupied) {
    if (!Number.isFinite(entry.slot) || !Number.isFinite(entry.width)) continue;
    const width = Math.max(0, entry.width);
    const standing = extents.get(entry.slot);
    if (standing === undefined || width > standing) {
      extents.set(entry.slot, width);
    }
  }
  if (vacancy !== undefined && Number.isFinite(vacancy.count)) {
    const reserved = Number.isFinite(vacancy.extent)
      ? Math.max(0, vacancy.extent)
      : 0;
    for (let slot = 0; slot < vacancy.count; slot += 1) {
      if (!extents.has(slot)) extents.set(slot, reserved);
    }
  }
  return extents;
}

/**
 * Lay the slots out as a strip, ascending by slot index:
 * `stripLeft(k) = Σ_{j<k} (extent(j) + IMPOSITION_GAP_PX)`.
 *
 * This is the whole of what flow means. A slot's place is the running sum of
 * everything before it, so no two slots can overlap by construction — and,
 * equally by construction, a card's place now depends on its neighbours'
 * widths, which is the property fit was built to avoid. Both are the trade the
 * mode exists to offer.
 *
 * The strip is laid out in its OWN coordinates, origin at its near end, which
 * is where the band's left edge falls at offset 0. Its length is the last
 * slot's right edge — there is no trailing gap, because a gap is what stands
 * BETWEEN two slots.
 *
 * The extents are {@link slotExtentMap}'s, vacancy and all.
 *
 * {@link fitStripPositions} is the other half of the pair, and the two are
 * dispatched between by {@link stripPositions}.
 */
export function flowStripPositions(
  occupied: readonly FlowSlotExtent[],
  vacancy?: FlowVacancy,
): FlowStrip {
  const extents = slotExtentMap(occupied, vacancy);
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
 * Lay the slots out across a band, ascending by slot index:
 * `fitLeft(k) = travelFraction(k) × max(0, band − extent(k))`.
 *
 * This is the whole of what fit means, and it is the numeric twin of the `left`
 * expression {@link imposeStyle} writes for a fit deck: the same
 * {@link travelFraction} over the same `max(0, band − width)`, resolved in JS
 * rather than by the browser. Slot 0 hugs the band's near edge, the last slot
 * hugs its far one, and the rest are spaced by their share of the slack — so a
 * card's place depends on the BAND and on its own width, and on nothing any
 * neighbour does. That independence is the property fit exists to offer, and
 * the price is the one flow exists to avoid: when the cards want more room than
 * the band has, the travel runs out before the run does and they lap over each
 * other rather than running off the edge.
 *
 * Same shape and same coordinates as {@link flowStripPositions}, so the two are
 * interchangeable to everything downstream: origin at the band's near edge,
 * extents from {@link slotExtentMap}, and a `width` that is how much room the
 * arrangement takes. In fit that is the band itself — the first slot rests on
 * one edge and the last on the other, so the run is exactly as long as the band
 * however wide the cards are. A fit strip therefore never overflows, which is
 * the same statement as: fit has nothing to scroll.
 */
export function fitStripPositions(
  occupied: readonly FlowSlotExtent[],
  band: number,
  vacancy?: FlowVacancy,
): FlowStrip {
  const extents = slotExtentMap(occupied, vacancy);
  const slots = [...extents.keys()].sort((a, b) => a - b);
  const room = Number.isFinite(band) ? Math.max(0, band) : 0;
  const count = slots.length === 0 ? 0 : slots[slots.length - 1] + 1;
  const positions = new Map<number, number>();
  for (const slot of slots) {
    const travel = Math.max(0, room - (extents.get(slot) as number));
    positions.set(slot, travelFraction({ slot, count }) * travel);
  }
  return { positions, extents, width: slots.length === 0 ? 0 : room };
}

/**
 * The deck's slot places under whichever geometry it is standing in — the one
 * entry point for anything that needs to know where the arrangement puts its
 * cards without caring which mode put them there.
 *
 * The band is read only by fit; flow's strip is laid out in its own length and
 * meets the band later, when an offset slides it. Passing it regardless is what
 * lets a caller ask this question without first asking which mode it is in —
 * which is the whole point, and the reason the plan drawing and its legend can
 * be one arithmetic across both.
 */
export function stripPositions(
  layout: ImpositionLayout,
  occupied: readonly FlowSlotExtent[],
  options: { band: number; vacancy?: FlowVacancy },
): FlowStrip {
  return layout === "flow"
    ? flowStripPositions(occupied, options.vacancy)
    : fitStripPositions(occupied, options.band, options.vacancy);
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
 * members at their own comfort heights reveals by exactly this arithmetic.
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

/**
 * What the centering rule is told. The same four lengths the reveal is told
 * MINUS the offset standing now, and the omission is the whole difference
 * between the two rules: where the band is has no bearing on where the middle
 * of the strip's `stripStart..stripStart + extent` run is.
 */
export type StripCenterInput = Omit<StripRevealInput, "offset">;

/**
 * The offset that puts a member's middle at the band's middle.
 *
 * Where {@link stripRevealOffset} answers "move as little as possible", this
 * answers "put it here" — an absolute position rather than a correction. That
 * is what a reader asking for a slot BY NAME means: they named a place, not a
 * deficiency in the current one, so the answer must not depend on where the
 * band happens to stand. A member already wholly on screen still travels.
 *
 * The clamp is what makes the ends behave: the first and last slots of a strip
 * cannot reach the middle of the band without showing emptiness beside them,
 * and the clamp pins them flush instead. So a centering gesture near an end
 * moves less than the middle of the strip would, and at the very end moves
 * nothing — the strip is already showing everything it has in that direction.
 *
 * Axis-free, like its neighbour, so a column's vertical strip could center by
 * exactly this arithmetic over heights.
 */
export function stripCenterOffset(input: StripCenterInput): number {
  const { stripStart, extent, stripLength, band } = input;
  if (!Number.isFinite(stripStart) || !Number.isFinite(extent)) {
    return clampStripOffset(0, stripLength, band);
  }
  return clampStripOffset(
    stripStart + extent / 2 - band / 2,
    stripLength,
    band,
  );
}

/** Flow's own name for {@link StripCenterInput}. */
export type FlowCenterInput = Omit<FlowRevealInput, "offset">;

/** {@link stripCenterOffset} read horizontally — flow's centering. */
export function flowCenterOffset(input: FlowCenterInput): number {
  return stripCenterOffset({
    stripStart: input.stripLeft,
    extent: input.extent,
    stripLength: input.stripWidth,
    band: input.band,
  });
}

/** What {@link centerVisibleFlowSlot} is asked over. */
export interface FlowVisibleInput {
  /** The deck's strip. */
  strip: FlowStrip;
  /** The band the strip is seen through. */
  band: number;
  /** The offset standing now. */
  offset: number;
}

/**
 * The centermost slot the band is actually showing — where a card arriving from
 * nowhere belongs.
 *
 * A slot is a candidate when the band holds the WHOLE of it, and the answer is
 * the middle candidate — cheating LEFT when there is an even number of them,
 * for the reason {@link centerSlot} does. Only when no occupied slot is wholly
 * on screen do the clipped ones answer, and then it is the middle slot the band
 * touches at all: a deck scrolled to the middle of a card that is wider than
 * the band still has somewhere the eye is, and the lowest occupied slot — which
 * is what a caller falls back to otherwise — is not it.
 *
 * `undefined` for an empty strip, which is the one case with no centermost
 * anything. The reveal arithmetic's mirror image: {@link flowRevealOffset}
 * moves the band to a slot, and this reads which slot the band already stands
 * over.
 */
export function centerVisibleFlowSlot(
  input: FlowVisibleInput,
): number | undefined {
  const { strip, band, offset } = input;
  const slots = [...strip.positions.keys()].sort((a, b) => a - b);
  if (slots.length === 0) return undefined;
  if (!Number.isFinite(band) || band <= 0 || !Number.isFinite(offset)) {
    return middleOf(slots);
  }
  const bandEnd = offset + band;
  const whole: number[] = [];
  const touched: number[] = [];
  for (const slot of slots) {
    const left = strip.positions.get(slot) as number;
    const right = left + (strip.extents.get(slot) ?? 0);
    if (left >= offset && right <= bandEnd) whole.push(slot);
    else if (right > offset && left < bandEnd) touched.push(slot);
  }
  if (whole.length > 0) return middleOf(whole);
  if (touched.length > 0) return middleOf(touched);
  return middleOf(slots);
}

/** The middle member of a non-empty ascending list, cheating left on a tie. */
function middleOf(slots: readonly number[]): number {
  return slots[Math.floor((slots.length - 1) / 2)];
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
  /**
   * What an unoccupied slot holds open — the deck's content width, or the
   * widest card standing if the deck would rather match its own cards
   * ({@link vacancyExtent}).
   *
   * **Read in both modes**, because in both the chain the objective scores is
   * every slot of the kind rather than the occupied ones ({@link chainOf}). In
   * flow that was always true: the objective measures where the band's far edge
   * cuts the STRIP, and the deck draws every slot ({@link flowStripPositions}).
   * In fit it is the correction described at `chainOf` — an empty slot has
   * always held its share of the band, and the objective now knows it.
   *
   * Absent, the extent is derived from the widest card standing, which is the
   * same rule {@link vacancyExtent} applies one level up.
   */
  emptyExtent?: number;
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

  // How much chain a mode needs before it has a picture worth scanning for,
  // and the two answers differ because the two pictures do. FIT scores the
  // seams BETWEEN cards, so one card has no seam and nothing to fit. FLOW
  // scores where the band's far edge falls, and a lone card wider than the
  // band is cut by that edge exactly as a chain member would be — narrowing
  // the rails widens the band until the whole of it shows, which is a real
  // repair the scan can find. So flow's floor is one card, not two.
  const minimumChain = impositionLayout(input) === "flow" ? 1 : 2;
  const target =
    chain.length < minimumChain
      ? // Nothing to score: every candidate ties on every term but the last,
        // the key reduces to that last term, and it is minimised at
        // Σ preferred. Returned directly rather than scanned for — the answer
        // falls out of the objective, so this is a shortcut, not a special
        // case.
        //
        // FLOW USED TO SHARE THIS BRANCH, and the reasoning was sound as far as
        // it went: every flow seam is exactly IMPOSITION_GAP_PX by construction
        // and independent of the band, so `worstOverlap`, `worstShortfall` and
        // `worstError` really are identically zero at every candidate total.
        // What all three measure is the seam BETWEEN two cards, and what flow
        // can get wrong is where the band's FAR EDGE lands — a degree of
        // freedom no fit term watches, because in fit it cannot go wrong at
        // all. So flow scans like everything else now, against a picture of its
        // own ({@link stripPicture}).
        //
        // `imposeRect` and `seamPicture` still stay fit-only, and the reason is
        // now that flow has its own picture rather than that it has none.
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

  // The rounding CONSERVES THE TOTAL. Two rails of equal rank split a tier's
  // share evenly, so an odd total leaves each of them on a half — and rounding
  // each on its own rounds both the same way, answering a pixel off the total
  // the sweep chose. In fit a pixel of seam slack was invisible; in flow the
  // total was chosen to land the band on a slot boundary, and a pixel off it
  // is a hairline of a card, the exact thing the choice paid for. So each
  // rail's rounding carries its fraction into the next: the sum of the answer
  // is the sum of the widths, and the last rail's answer is the total less the
  // rest, which lies within its bounds because those are integers and its
  // exact width was inside them.
  const answer: RailWidths = {};
  let carried = 0;
  for (const rail of rails) {
    const exact = (widths.get(rail.side) as number) + carried;
    const rounded = Math.round(exact);
    carried = exact - rounded;
    answer[rail.side] = rounded;
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
 * The lexicographic score of a candidate total.
 *
 * **In fit:** occlusion, then cramping, then the rails' comfort, then
 * raggedness, then distance from the widths the user chose. **In flow:** the
 * cut the band's far edge leaves when the boundary is not paid for — zero for
 * a candidate that ends the band on a boundary within
 * {@link RAIL_BOUNDARY_BUDGET_PX} — then comfort, then that same distance. The
 * modes score different things because they can fail in different ways, and
 * each key ends on the same last term — which is what makes every answer
 * unique, and breaks every remaining tie toward leaving the rails where their
 * owner put them.
 *
 * Flow's first term is a PRICE decision, not a grade. A boundary is bought
 * when it is within budget, whatever the cut it removes measures; a boundary
 * beyond the budget is not bought, whatever the cut it would have removed
 * measures. Comfort sits below it, so a boundary that costs a rail its
 * comfort but not its hard floor is still bought — the floors bound the sweep
 * and are never on the menu at all.
 *
 * ## The content cards are laid out first
 *
 * The picture terms come FIRST, ahead of anything the rails want, and that
 * ordering is the whole policy: the deck fits or flows its content cards as
 * well as the canvas allows, and the rails take what is left. Comfort is a
 * term in the same key rather than a gate in front of it, so it is spent by
 * the pixel, exactly as far as the picture is bought by spending it — a rail
 * gives up six pixels to close a six-pixel overlap and no more.
 *
 * This used to be a TIER GATE: the search ran in the comfort domain and
 * descended below it only when doing so reached a strictly better CLASS of
 * picture — clean over cramped, cramped over occluded. On a deck no total can
 * repair, that rule kept every rail at its comfort measure and left the cards
 * lapping further over one another than they had to. Three slim cards on a
 * 2560px canvas lapped 128px a seam under the gate and 102px without it: the
 * gate was holding 52px of rail nobody had asked for against 52px of the
 * user's own cards. "Improve a picture that stays broken" turned out to be
 * worth doing after all, because the cards are the subject and the rails are
 * the frame.
 *
 * Comfort sits BELOW `worstShortfall` and above `worstError`, and both
 * placements are load-bearing. Below shortfall, because the total that tiles a
 * three-up deck of slim cards can land a handful of pixels under the comfort
 * floors, and a rule that ranked comfort first would paint every interior seam
 * at 2px instead of 5 to save six pixels of width nobody was reading. Above
 * raggedness, because raggedness is a matter of degree on a chain that already
 * reads as arranged, and a rail should not be cramped to shave a pixel off it.
 *
 * A key is only ever compared against another key of its own mode, so the two
 * lengths never meet.
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
  totals: {
    sides: readonly SidebarSide[];
    preferredTotal: number;
    comfortTotal: number;
    /** Flow only: the cut the band makes at Σ preferred — what the deck keeps
     *  if no boundary is paid for. Read once by the chooser, not per candidate. */
    unpaidCut: number;
  },
): readonly number[] {
  const { sides, preferredTotal, comfortTotal, unpaidCut } = totals;
  const widths: RailWidths = {};
  for (const side of sides) widths[side] = total / sides.length;
  const distance = Math.abs(total - preferredTotal);
  // How far under their comfort measure this candidate stands the rails, in
  // pixels, and zero at or above it — a rest state like the picture terms',
  // so a deck that reads well is decided by the last term alone.
  const discomfort = Math.max(0, comfortTotal - total);
  if (impositionLayout(input) === "flow") {
    // A candidate that ends the band on a boundary, and does so within the
    // budget, has PAID for it and reads 0. Every other candidate reads the cut
    // the deck keeps when nothing is paid — the same number for all of them —
    // so that among the unpaid the comfort and distance terms decide, and the
    // rails stay where their owner put them.
    //
    // The unpaid reading is a DECK-LEVEL constant rather than each candidate's
    // own sliver, and that is the whole of the budget's authority. A
    // per-candidate residual, minimised or maximised, is the objective this
    // replaced: it is nonzero at nearly every total, so it governs always, and
    // it drags a rail across its range chasing a cut it can only ever move.
    // With the term flat off the boundaries, the only thing rail width is ever
    // spent on in flow is a boundary, and the only question is whether that
    // boundary is within budget. There is no threshold: a 3px hairline and a
    // 300px slice are the same kind of thing here, a cut, and each is repaired
    // or left exactly as its boundary's price says.
    const paid =
      distance <= RAIL_BOUNDARY_BUDGET_PX &&
      sliverOfChain(input, chain, widths).worstSliver === 0;
    return [paid ? 0 : unpaidCut, discomfort, distance];
  }
  const picture = pictureOfChain(input, chain, widths);
  return [
    picture.worstOverlap,
    picture.worstShortfall,
    discomfort,
    picture.worstError,
    distance,
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
 * ONE domain — `[Σ floor, Σ ceiling]`, every width the rails may legally
 * stand at — scanned against the one key {@link scoreRailTotal} writes. The
 * content cards' picture is the first term of that key, so it is settled
 * before anything the rails prefer is read at all, and the comfort measure is
 * a term inside it rather than a boundary around it. What the rails want is
 * the residual, which is the whole of the policy.
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
  // Flow's rest reading: the cut the band makes at the widths the user chose,
  // which is what every candidate that pays for no boundary is scored as.
  // Read once here rather than once per candidate — the sweep below evaluates
  // the strip several hundred times and this number is the same at each.
  const unpaidCut =
    impositionLayout(input) === "flow"
      ? (() => {
          const widths: RailWidths = {};
          for (const side of sides) widths[side] = preferredTotal / sides.length;
          return sliverOfChain(input, chain, widths).worstSliver;
        })()
      : 0;
  const score = (total: number): readonly number[] =>
    scoreRailTotal(input, chain, total, {
      sides,
      preferredTotal,
      comfortTotal,
      unpaidCut,
    });

  // EVERY integer total, in one ascending pass. A rail stands between its hard
  // floor and the shared ceiling, so the range is at most a thousand numbers
  // and each costs a handful of `imposeRect` evaluations — a few thousand
  // arithmetic operations, once per commit or per settled resize.
  //
  // This used to be a 16px stride with a 1px rescan around the coarse winner,
  // seeded with the closed-form fit and, in flow, with the totals that put the
  // band on a slot edge. Every one of those was an apology for the stride, and
  // the stride was wrong: `imposeRect` clamps a pane's travel at zero, so a
  // chain of mixed card widths has a picture full of narrow valleys that a
  // coarse pass steps straight over. On a four-up deck of alternating slim and
  // wide cards it settled on the range's low end at 816px of lap while a total
  // 268px away sat at 814px and cost the rails no comfort at all.
  //
  // An exact sweep has no such failure mode, and it makes the answer the
  // objective rather than an approximation of it — which is the property every
  // invariant in the solutions sweep is written against.
  const best = (lo: number, hi: number): number => {
    if (hi <= lo) return lo;
    let chosen = lo;
    let chosenScore = score(lo);
    // Ties keep the SMALLER total, which a strict improvement test over an
    // ascending sweep gives for free.
    for (let total = lo + 1; total <= hi; total += 1) {
      const candidate = score(total);
      if (compareScores(candidate, chosenScore) < 0) {
        chosen = total;
        chosenScore = candidate;
      }
    }
    return chosen;
  };

  // The comfort floors bound nothing here — they are a term in the key, not a
  // domain. The sweep runs the rails' whole legal range in one pass and the
  // ordering inside `scoreRailTotal` decides.
  return best(floorTotal, ceilingTotal);
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
  // `band = span.width − 2 × gap` and `span.width = canvasWidth − Σ inset(rail)`
  // with `inset(rail) = rail + inset(0)` ({@link railSpanInsetPx}), so the
  // rails' total is `canvasWidth − R·inset(0) − 2·gap − band`. At one rail and
  // the rail's lengths equal to the gap that is `3 × gap`, which is why a
  // constant was once safe to write down and is not safe to carry forward —
  // the count is a function of how many rails stand, and a closed rail
  // contributes neither width nor inset.
  const band = numerator / denominator;
  const solved = Math.round(
    input.canvasWidth -
      railCount * railSpanInsetPx(0) -
      IMPOSITION_GAP_PX * 2 -
      band,
  );
  return Number.isFinite(solved) ? solved : null;
}

/**
 * **Every slot the kind defines**, left to right: the widest pane standing at
 * that slot, or the extent a vacancy holds open where none does. `null` means
 * the INPUT is unusable — a non-finite number somewhere in it — and nothing
 * else.
 *
 * ## The chain is the arrangement, not the occupancy
 *
 * This used to be the OCCUPIED slots alone, and that is the single assumption
 * behind the worst picture the allocator has ever painted. `pictureOfChain`
 * scores the seam between consecutive chain members against one imposition
 * gap; it does not know how many slots apart they are. So a three-up deck with
 * slots 0 and 2 filled and slot 1 empty handed it a two-member chain pinned to
 * the two ENDS of the band, and asked it to make those two cards sit 5px
 * apart. On a 2870px canvas that wants a rail total of 1495 — past the
 * ceiling — so both rails went to their 675px maximum and the picture was
 * still 145px out. The deck was in fact CRAMPED by 535px against what the
 * empty slot holds open, and the allocator spent every pixel of rail it had
 * widening in the wrong direction.
 *
 * The vacancy was never invisible to the rest of the model: `imposeRect`
 * anchors on `travelFraction`, which divides by the kind's slot COUNT, so an
 * empty slot has always held its share of the band, and the deck draws a
 * reserved place there. Only the objective disagreed.
 *
 * Filling the chain fixes that at the root, and it is the stronger fix over
 * teaching `pictureOfChain` how far apart two members are: **the rails no
 * longer move when a card arrives or leaves.** A three-up deck is solved for
 * three cards whether one stands in it or three do, so opening a card into
 * the slot the arrangement was already holding finds the rails already the
 * right width — where an occupancy-shaped chain would resize both edges of
 * the deck under the user for a card that landed exactly where its place was.
 *
 * A vacancy's width is {@link AllocatorInput.emptyExtent}; absent, it is
 * derived here the same way {@link vacancyExtent} derives it, from the widest
 * card standing. A chain of one — one-up — is a perfectly good chain with no
 * seam in it, and is returned as such; whether that is an answerable question
 * is the caller's to decide.
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

  const vacancy =
    input.emptyExtent !== undefined && Number.isFinite(input.emptyExtent)
      ? Math.max(0, input.emptyExtent)
      : vacancyExtent(occupied, 0);
  const chain: { slot: number; width: number }[] = [];
  for (let slot = 0; slot < slotCount(kind); slot += 1) {
    const width = widest.get(slot) ?? vacancy;
    // A slot with no card and nothing to hold open contributes nothing: a
    // zero-width member is not a place, and a chain of them would have the
    // allocator tiling seams between things that are not there. This is the
    // wholly empty deck — no card standing anywhere and no `emptyExtent` given
    // — which comes out as an empty chain, and an empty chain is what leaves
    // every rail at the width its owner chose.
    if (width > 0) chain.push({ slot, width });
  }
  return chain;
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
 * How far the rails may move, in total width, to end the band on a slot
 * boundary — the one tunable in the flow objective.
 *
 * A boundary whose price is within this many pixels of rail is paid for; one
 * beyond it is left alone, and the cut the band makes is an honest slice of a
 * card, never a manufactured one. The number answers a question a person can
 * reason about — "how far may a rail move to end the band cleanly" — and it
 * caps the spend absolutely: the pathology this replaced, a rail dragged from
 * the 420px its owner set to its 675px ceiling to take a 316px cut down to
 * 61px, cannot recur under a cap because that move is not inside any budget.
 *
 * Priced on the rails' TOTAL, which is the quantity the band depends on. In
 * practice the greed order hands a surplus or a deficit to one rail at a time,
 * so a total moved by this much is, on nearly every deck, one rail moved by
 * this much.
 *
 * **Absolute, not a fraction of the rails' range**, and 120 — settled by
 * sweeping the three-up and four-up decks at Slim and Comfy, with one rail and
 * with two (each preferring 420 over a 320 floor under the 675 ceiling, so a
 * rail's range is 355), every ten pixels of canvas from 1200 to 4000, and
 * reading which boundaries each form of budget takes. The bar: take the 39px
 * and 79px boundaries the clipped-card sweep found, refuse the 316px one.
 *
 * | form                          | budget one / two rails | takes ~39 | takes ~79 | refuses 316 | dearest taken |
 * |-------------------------------|------------------------|-----------|-----------|-------------|---------------|
 * | absolute 100                  | 100 / 100              | yes       | yes       | yes         | 98 / 99       |
 * | absolute 120                  | 120 / 120              | yes       | yes       | yes         | 118 / 119     |
 * | absolute 140                  | 140 / 140              | yes       | yes       | yes         | 138 / 139     |
 * | ⅕ of Σ (ceiling − floor)      | 71 / 142               | yes       | one rail: NO | yes      | 68 / 141      |
 * | ¼ of Σ (ceiling − floor)      | 89 / 178               | yes       | yes       | yes         | 88 / 176      |
 *
 * A fraction scales with the rail count, and that is the wrong axis: the band
 * depends on the rails' TOTAL, so a boundary 78px away costs 78px of rail
 * whether one rail stands or two, and a budget that refuses it on a one-rail
 * deck and pays twice as much on a two-rail deck is answering a question about
 * the rails when the question is about the cards. A fraction large enough to
 * take the one-rail 78 (a quarter) pays up to 176px on two rails — half the
 * distance to the 316px pathology. The absolute number reads the same in every
 * golden row, and 120 sits where the sweep's price ladder has a clear step:
 * every boundary under it is a few tens of pixels the eye reads as the rail
 * settling, and the first refused ones are a hundred and more.
 *
 * Its feel in the app is the user's to confirm; the census holds it above the
 * readable minimum either way.
 */
export const RAIL_BOUNDARY_BUDGET_PX = 120;

/**
 * How the chain reads **in flow**: the smaller of the two pieces the band's far
 * edge cuts a slot into, `0` when it cuts none — and, when it does cut one, the
 * price of each of the two boundaries in rail width.
 *
 * Flow's failure is not the one the three readings above measure, and it cannot
 * be. Every flow seam is exactly {@link IMPOSITION_GAP_PX} by construction —
 * the strip is a running sum, so widening the rails narrows the band without
 * moving a single seam — which leaves `worstOverlap`, `worstShortfall` and
 * `worstError` identically zero at every candidate total. What none of them
 * watches is where the band's FAR EDGE lands, and in flow that is the only
 * thing that can go wrong: the strip is designed to run past the band, so the
 * edge falls wherever the rails' width leaves it. In fit it cannot go wrong at
 * all, because `imposeRect` pins every card inside the band.
 *
 * `worstSliver` is the raw measurement, and it is deliberately not the score:
 *
 *  - **`0` is a boundary.** The edge landed on a slot's near or far edge, or in
 *    the gap between two slots, or past the strip's end. Nothing is cut.
 *  - **Any other reading is a cut**, and every cut has two boundaries in closed
 *    form: `growPrice` is how much wider the rails' total must stand for the
 *    band to end on the cut slot's near edge, and `shrinkPrice` how much
 *    narrower for it to reach the far edge — which, on the last slot, is the
 *    strip's own end, where the whole of it shows. The smaller of the two is
 *    the sliver itself; the objective reads them as prices and the census reads
 *    them as its oracle. Both are `null` when nothing is cut.
 *
 * The prices are raw: measured from `widths`, and bounded by nothing. Whether a
 * boundary's total is one the rails may legally stand at is the sweep's
 * business, and whether it is within budget is the score's
 * ({@link RAIL_BOUNDARY_BUDGET_PX}).
 *
 * The measure is SYMMETRIC on purpose. Three pixels of a card showing and three
 * pixels of it hidden are the same ugliness and the same three pixels of rail
 * from clean; a one-sided reading would repair one and chase the other.
 *
 * Evaluated at flow offset 0 and nowhere else. Rails whose widths followed the
 * live offset would breathe as the strip scrolled, which is a far worse picture
 * than the one this repairs. It costs nothing in the common case: with every
 * card at one content-width preset the strip has a uniform stride, every
 * revealed offset is a multiple of it, and an edge on a boundary at rest is on
 * a boundary at every revealed offset.
 */
export function stripPicture(
  input: AllocatorInput,
  widths: RailWidths,
): StripPicture {
  const chain = chainOf(input);
  if (chain === null || chain.length === 0) return UNCUT;
  return sliverOfChain(input, chain, widths);
}

/** What {@link stripPicture} reads: the cut, and the price of each way out. */
export interface StripPicture {
  worstSliver: number;
  growPrice: number | null;
  shrinkPrice: number | null;
}

const UNCUT: StripPicture = { worstSliver: 0, growPrice: null, shrinkPrice: null };

/**
 * {@link stripPicture} with the chain already in hand — the form the total
 * chooser calls, for the reason {@link pictureOfChain} exists.
 */
function sliverOfChain(
  input: AllocatorInput,
  chain: readonly { slot: number; width: number }[],
  widths: RailWidths,
): StripPicture {
  // The band is the span less the gap the chain keeps at each of its ends —
  // the same derivation `DeckManager._flowBandWidth` makes from the same
  // `resolveSpan`, rather than a second one that would agree with it by luck.
  const band =
    resolveSpan({ width: input.canvasWidth, height: 0 }, railsOf(widths))
      .width -
    IMPOSITION_GAP_PX * 2;
  if (!Number.isFinite(band) || band <= 0) return UNCUT;

  const strip = flowStripPositions(
    chain,
    input.emptyExtent === undefined
      ? undefined
      : { count: slotCount(input.kind), extent: input.emptyExtent },
  );
  // A strip inside its band has no far edge to cut anything with.
  if (strip.width <= band) return UNCUT;

  for (const [slot, left] of strip.positions) {
    const extent = strip.extents.get(slot) as number;
    // Half-open: an edge exactly on a slot's near edge belongs to the gap
    // before it, and one exactly on its far edge belongs to the next gap. Both
    // are boundaries, and both must read as 0 rather than as a zero-width cut.
    if (band > left && band < left + extent) {
      // The band shrinks by exactly what the rails grow, so the distance from
      // the edge to each boundary IS the rail movement that reaches it.
      const growPrice = band - left;
      const shrinkPrice = left + extent - band;
      return {
        worstSliver: Math.min(growPrice, shrinkPrice),
        growPrice,
        shrinkPrice,
      };
    }
  }
  // The edge fell in a gap between two slots, or past the last one.
  return UNCUT;
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
 * The rail's frame: pinned to the side it holds, the rail edge inset in on its
 * outer edge and top and the strip's clearance at the bottom, at the width the
 * pane carries.
 *
 * The rail is imposed but it is not a link in the chain. A chain link travels
 * across the band and can end up overlapped when the deck is crowded. The rail
 * must never be overlapped, so it holds the strip's far end at a fixed pin and
 * the cards share what is left of the band ({@link resolveSpan}).
 *
 * The side is emitted as a **number**, not as a pin, and the pin is one
 * expression that reads it: {@link RAIL_SIDE_PROPERTY} is 0 on the left and 1
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
 * Crossing between the two sides is not this expression's job. The rail travels
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
 * An automatic vertical split was tried first and was a worse rail: it spent a
 * rail's height to show two half-cards, which is what the Jots card was
 * already doing on its own, only less space-efficient. The stack that
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
    [RAIL_SIDE_PROPERTY]: rail,
    left:
      `calc(var(${RAIL_SIDE_PROPERTY}) * (100% - ${width} - ${RAIL_EDGE_INSET})` +
      ` + (1 - var(${RAIL_SIDE_PROPERTY})) * ${RAIL_EDGE_INSET})`,
  };
  return style as React.CSSProperties;
}

/**
 * The vertical run a place's members divide, and the pins at either end of it:
 * the frames' container less what the place keeps at each end. A column keeps
 * the card gap at its top and the deeper gap at its bottom; a rail keeps the
 * rail edge inset at its top and the strip's clearance at its bottom
 * ({@link railGapBottomPx}). Every pin below is written over the run it is
 * handed rather than over a number.
 */
interface PlaceRun {
  top: string;
  bottom: string;
  /** `(100% − top − bottom)`, as one CSS expression. */
  extent: string;
  /** The air between two neighbouring members, in px. */
  seam: number;
}

const RAIL_RUN: PlaceRun = {
  top: RAIL_EDGE_INSET,
  bottom: RAIL_GAP_BOTTOM,
  extent: `(100% - ${RAIL_EDGE_INSET} - ${RAIL_GAP_BOTTOM})`,
  seam: RAIL_SEAM_PX,
};

const COLUMN_RUN: PlaceRun = {
  top: GAP,
  bottom: GAP_BOTTOM,
  extent: `(100% - ${GAP} - ${GAP_BOTTOM})`,
  seam: IMPOSITION_GAP_PX,
};

/** Half the place's seam — each seam takes one, half from each neighbour, so
 *  a column's split members read as the same rhythm as every other seam on
 *  the deck, and a rail's meet at nothing. */
function seamHalf(run: PlaceRun): string {
  return `${run.seam / 2}px`;
}

/**
 * A member's `top` and `bottom` — the rail's own endpoints for the first and
 * last member, and the seam either side of it for the rest.
 *
 * The endpoints are written as the bare gaps rather than as fractions of the
 * run so the ends of a split rail land on exactly the pins an unsplit one has:
 * a top member and a stacked card share a top edge to the pixel, and the eye
 * reads a split as a division of the card it already knew.
 *
 * When the place overflows — the members' floors no longer fit in the run
 * ([P01]) — {@link overflowPins} takes over, against the side's own offset
 * property. That is the same rule a column stands under, because a rail and a
 * column are the same kind of place. Without it a rail with no room left would
 * divide its run into slivers below its members' floors; with it the members
 * take their own height and the strip scrolls, and the half-visible member at
 * the bottom edge says there is more below.
 *
 * The standing arrives on the placement rather than being decided here: it is
 * a fact about the run the place was allocated against, and the pins cannot
 * see the run.
 */
function railMemberPins(
  member: RailMemberPlacement | undefined,
): { top: string; bottom: string } {
  if (member === undefined) return { top: RAIL_RUN.top, bottom: RAIL_RUN.bottom };
  if (member.standing === "overflow") {
    return overflowPins(
      member,
      railOffsetProperty(member.side),
      (j) => railStripProperty(member.side, j),
      RAIL_RUN,
    );
  }
  return memberPins(member, (j) => railSeamProperty(member.side, j), RAIL_RUN);
}

/**
 * A split member's `top` and `bottom`, given the place it stands in and the
 * property carrying each seam of that place.
 *
 * The whole of what a rail member and a column member share, which is
 * everything but the property name and the run's endpoints: both divide a
 * vertical run, both take half a gap either side of a seam, and both pin their
 * outer edge to the run's own endpoint rather than to a fraction. That last
 * part is what makes a split read as a division of the card the eye already
 * knew — the top member and a stacked card share a top edge to the pixel.
 *
 * A place of fewer than two members is not divided, so it gets the undivided
 * pins. That is the byte-identity the split feature rests on: a slot or a side
 * that has never been split, or has dropped to one member, produces exactly the
 * frame it produced before either could be split at all.
 */
function memberPins(
  member: { index: number; count: number },
  seamProperty: (index: number) => string,
  run: PlaceRun,
): { top: string; bottom: string } {
  const { index, count } = member;
  if (count < 2) return { top: run.top, bottom: run.bottom };
  const seam = (j: number): string =>
    `var(${seamProperty(j)}, ${(j + 1) / count})`;
  return {
    top:
      index === 0
        ? run.top
        : `calc(${run.top} + ${seam(index - 1)} * ${run.extent} + ${seamHalf(run)})`,
    bottom:
      index === count - 1
        ? run.bottom
        : `calc(${run.bottom} + (1 - ${seam(index)}) * ${run.extent} + ${seamHalf(run)})`,
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
 * The custom property carrying strip coordinate `index` of slot `slot`'s
 * overflowing column, in px.
 *
 * The place-keyed twin of {@link railStripProperty}, and the same `n + 1`
 * coordinates for the same reason: a rail and a column are the same kind of
 * place, and an overflowing one is a strip either way.
 */
export function columnStripProperty(slot: number, index: number): string {
  return `--tug-slot-${slot}-strip-${index}`;
}

/**
 * How a place divides its run among the members standing in it — the rule a
 * rail and a column both stand under, because they are the same kind of place.
 *
 * `"shared"` — every member's floor fits in the run at once: the run is
 * divided between them at draggable seams, which is what both have always
 * done.
 *
 * `"overflow"` — they do not: division has run out of run to divide, so the
 * members stop dividing and start stacking down a strip longer than the run,
 * which scrolls behind it. The half-visible member at the bottom edge IS the
 * affordance, the way flow's half-visible card at the band edge is.
 *
 * The rule was a member COUNT once — three members or more overflowed — which
 * was a proxy for "is there room" that could not see the room ([P01]). Two
 * tall-floored members overflow on a short window and five short-floored ones
 * share a tall one, and the standing is now decided where the floors and the
 * run are both in hand: inside {@link allocatePlaceHeights}, which returns it
 * as a field rather than offering it as a function anybody may call.
 */
export type PlaceStanding = "shared" | "overflow";

/**
 * One member's appetite for vertical run: what it cannot go below, what it is
 * comfortable at, what it would take if the run were endless, how greedy it is
 * against its neighbours, and the weight the user's own seam drags stored.
 *
 * A rail member is a card (`id` is its componentId); a column member is a pane
 * (`id` is the pane id). The two are the same kind of member in the same kind
 * of place, which is why one allocator answers for both.
 */
export interface PlaceMemberAppetite {
  /** componentId for a rail member, pane id for a column member. */
  id: string;
  /** Hard floor, px: `getStackSizePolicy(componentIds).min.height`. */
  floor: number;
  /** ≥ floor; equals floor when the card declares none. */
  comfort: number;
  /** ≥ comfort; equals floor when undeclared; may be `Infinity`. */
  natural: number;
  /** Lower is greedier; `getGreedRank` folded with `Math.min` over a pane's
   *  cards. */
  greedRank: number;
  /** The stored weight, {@link railWeightOf}: finite, ≥ 0, default 1. */
  weight: number;
}

/**
 * How a place divides its run among the members standing in it — the one shape
 * every consumer reads, so that no site derives a member height for itself.
 *
 * `heights` and `tops` are strip coordinates: a shared place's strip IS its
 * run, so `stripLength` equals `run` and the last member's bottom sits at the
 * run's bottom; an overflowing place's strip is longer than the run and slides
 * behind it by the place's offset.
 */
export interface PlaceAllocation {
  standing: PlaceStanding;
  /** The place's own choice, carried with the numbers it produced. Every
   *  consumer that must know which arithmetic made these heights reads it here
   *  rather than working it out again ([B12]). */
  layout: PlaceLayout;
  ids: readonly string[];
  /** One per member, px, each ≥ its floor. */
  heights: readonly number[];
  /** Strip coordinate of each member's top: Σ_{j<i} heights[j] + i · seam. */
  tops: readonly number[];
  /** Σ heights + (n − 1) · seam. Equals `run` (±1e-6) in shared. */
  stripLength: number;
  run: number;
  seam: number;
}

/** The tolerance every comparison in this arithmetic is made at: a px of run
 *  divided by a weight is never exact, and a member a millionth of a px below
 *  its natural height is at its natural height. */
const PLACE_HEIGHT_EPSILON = 1e-6;

/**
 * The appetites as the allocator may rely on them: floors non-negative and
 * finite, `floor ≤ comfort ≤ natural`, weight finite and non-negative, greed a
 * rank.
 *
 * Sanitized rather than rejected for the reason {@link railWeightOf} reads a
 * `NaN` weight as 1 — these numbers arrive from a stored blob, from gesture
 * arithmetic, and from cards that declare their own appetites, and a rail that
 * refuses to lay itself out because one card published a `NaN` is worse than a
 * rail that lays itself out from the numbers it can read.
 */
function sanitizedAppetites(
  members: readonly PlaceMemberAppetite[],
): PlaceMemberAppetite[] {
  return members.map((member) => {
    const floor =
      Number.isFinite(member.floor) && member.floor > 0 ? member.floor : 0;
    const comfort = Number.isFinite(member.comfort)
      ? Math.max(floor, member.comfort)
      : floor;
    const natural =
      member.natural === Infinity
        ? Infinity
        : Number.isFinite(member.natural)
          ? Math.max(comfort, member.natural)
          : comfort;
    const weight =
      Number.isFinite(member.weight) && member.weight >= 0 ? member.weight : 1;
    const greedRank = Number.isFinite(member.greedRank)
      ? member.greedRank
      : DEFAULT_GREED_RANK;
    return { id: member.id, floor, comfort, natural, greedRank, weight };
  });
}

/**
 * The `n + 1` strip coordinates an OVERFLOWING place publishes — every member's
 * top, then the strip's own end — or `undefined` for a place that has no strip.
 *
 * One derivation, read by the canvas's property writer and by the placements it
 * hands the panes, so the numbers a frame falls back to and the numbers the
 * properties carry are the same numbers ([P02]). A shared place answers
 * `undefined` rather than its tops: it publishes seams, and a strip coordinate
 * standing beside them would be a second, staler account of the same run.
 */
export function stripCoordinatesOf(
  allocation: PlaceAllocation | null | undefined,
): readonly number[] | undefined {
  if (allocation === null || allocation === undefined) return undefined;
  if (allocation.standing !== "overflow") return undefined;
  return [...allocation.tops, allocation.stripLength];
}

/** The allocation `heights` make: tops accumulate the heights a seam apart, and
 *  the strip is the last top plus the last height. */
function placeAllocationOf(
  standing: PlaceStanding,
  layout: PlaceLayout,
  members: readonly PlaceMemberAppetite[],
  heights: readonly number[],
  run: number,
  seam: number,
): PlaceAllocation {
  const tops: number[] = [];
  let running = 0;
  for (let i = 0; i < heights.length; i += 1) {
    tops.push(running);
    running += heights[i] + seam;
  }
  const stripLength = heights.length === 0 ? 0 : running - seam;
  return {
    standing,
    layout,
    ids: members.map((member) => member.id),
    heights,
    tops,
    stripLength,
    run,
    seam,
  };
}

/**
 * A FLOWING place's heights, from what its members want and nothing about the
 * run: `max(floor, natural · weight)`, where the weight is the multiplier the
 * user's own seam drags stored.
 *
 * Natural rather than comfort is the tier, because natural is what flow
 * promises ([B08]): the content is the constraint here, so a member stands at
 * the height its own content is finished at, and nobody is stretched to fill a
 * run or squeezed to fit one. The floor still binds — a member whose whole
 * declaration falls below the box it needs to paint stands in that box.
 *
 * A member with an ENDLESS natural — a stream, which is never finished — reads
 * the run as its natural and so stands at one screen of itself, scrolled to.
 * That is the only number in this function about the place rather than about
 * the member, and it is here because `Infinity · weight` is not a height. A
 * place with no run to speak of has no screen to offer either, so a stream
 * there falls back to the comfort height it declared.
 *
 * Greed ranks play no part: flow divides nothing, so there is nothing to be
 * first in line for.
 */
function flowHeightsOf(
  members: readonly PlaceMemberAppetite[],
  run: number,
): number[] {
  const screen = Number.isFinite(run) && run > 0 ? run : null;
  return members.map((member) => {
    const natural = Number.isFinite(member.natural)
      ? member.natural
      : (screen ?? member.comfort);
    return Math.max(member.floor, natural * member.weight);
  });
}

/** The tolerance the ladder's own pool arithmetic is done at, finer than
 *  {@link PLACE_HEIGHT_EPSILON} because a pool of a millionth of a px is still
 *  a pool to be handed out rather than a rounding error to be reported. */
const PLACE_POOL_EPSILON = 1e-9;

/**
 * A shared place's heights: the allocation ladder ([P03]), which is the whole
 * of how a run that fits its members gets divided among them.
 *
 * Four stages, each spending what the one before it left:
 *
 * 1. **Floors.** Every member starts at the height it cannot go below, and the
 *    seams take theirs. What is left over is the pool.
 * 2. **Comfort, greediest first.** Members are visited in `greedRank` order
 *    (ties by position) and each takes the pool up to its comfort height. This
 *    is the stage that runs out: a run with room for the floors but not for
 *    every comfort leaves the last-ranked members at their floors, which is
 *    the honest answer — somebody has to be short, and the greed rank is the
 *    card registry's statement about who it should be.
 * 3. **Toward natural, by weight.** What is still left is the DISCRETIONARY
 *    pool, and the stored weights divide it — each member capped at its
 *    natural height, with the surplus a capped member could not take poured
 *    back over the members still below theirs. That is why this is a loop
 *    rather than one division: capping one member changes every other
 *    member's share, and the water has to find its level.
 * 4. **Past natural, whole, to the greediest.** Once everybody is at natural
 *    there is no cap left to bind, and the remainder goes ENTIRELY to the
 *    lowest `greedRank` — position as tiebreak, the same order stage 2 used —
 *    so the run is still filled exactly ([D181]) while every other member
 *    stands at precisely its natural. Every seam then sits on a content
 *    boundary and the one stretch of empty space is at the foot of the card
 *    that will grow into it first ([B06]). Spreading the remainder by weight
 *    was the old rule and it handed each card space it had not asked for:
 *    when one card then grew, the settle had to claw that space back across
 *    every seam instead of moving one.
 *
 * Fit has two edges and they have names. **Squeeze** is the run falling short
 * of the naturals — stage 2 runs out and members are held below natural in
 * reverse greed order. **Slack** is the run running past them — stage 4, where
 * the greediest takes the lot. Neither word is user-facing; the user's words
 * for the choice are Fit and Flow.
 *
 * A weight of zero is legal and means what it says at each stage: no share of
 * the pool. It is what a member dragged down to its comfort height stores, and
 * a place whose weights are ALL zero divides its pool equally rather than not
 * at all — the only reading a total of nothing has.
 */
function sharedHeightsOf(
  members: readonly PlaceMemberAppetite[],
  run: number,
  seam: number,
): number[] {
  const n = members.length;
  const heights = members.map((member) => member.floor);
  const floors = heights.reduce((sum, height) => sum + height, 0);
  let pool = run - floors - (n - 1) * seam;

  const byGreed = members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => a.member.greedRank - b.member.greedRank || a.index - b.index);
  for (const { member, index } of byGreed) {
    if (pool <= PLACE_POOL_EPSILON) break;
    const take = Math.min(member.comfort - member.floor, pool);
    if (take <= 0) continue;
    heights[index] += take;
    pool -= take;
  }

  let active = members
    .map((_, index) => index)
    .filter((i) => heights[i] < members[i].natural - PLACE_POOL_EPSILON);
  while (pool > PLACE_POOL_EPSILON && active.length > 0) {
    const total = active.reduce((sum, i) => sum + members[i].weight, 0);
    const give = active.map((i) =>
      total > 0 ? (pool * members[i].weight) / total : pool / active.length,
    );
    const capped = active.filter(
      (i, k) => give[k] >= members[i].natural - heights[i] - PLACE_POOL_EPSILON,
    );
    if (capped.length === 0) {
      active.forEach((i, k) => {
        heights[i] += give[k];
      });
      pool = 0;
      break;
    }
    for (const i of capped) {
      pool -= members[i].natural - heights[i];
      heights[i] = members[i].natural;
    }
    const held = new Set(capped);
    active = active.filter((i) => !held.has(i));
  }

  if (pool > PLACE_POOL_EPSILON) {
    // Slack. The default is one card's: past natural nobody is competing for
    // the pool, so dividing it by weight would only hand every card space it
    // did not ask for ([B06]). A weight of exactly 1 on EVERY member is the
    // shape an absent `shares` record makes — `railWeightOf` answers 1 for a
    // place nobody has dragged — so that is the default, and it goes whole to
    // the greediest, position as tiebreak.
    //
    // Anything else is a hand's: a seam dragged past the naturals stored the
    // division it was let go at, and it overrides the default for that place
    // ([B12]). {@link placeSharesFromHeights} scales a slack drag's weights to
    // put their largest at n, rather than to average 1, for exactly this
    // reason — an equal division of slack is a real thing to have dragged to,
    // and it must not come back wearing the all-ones record that means nobody
    // dragged at all.
    const dragged = members.some(
      (member) => Math.abs(member.weight - 1) > PLACE_POOL_EPSILON,
    );
    if (dragged) {
      const total = members.reduce((sum, member) => sum + member.weight, 0);
      for (let i = 0; i < n; i += 1) {
        // A record of nothing but zeros is still a hand's by the test above,
        // and it has no ratio in it — so it divides evenly, the only reading a
        // total of nothing has, and the same one the stage below the naturals
        // takes. Without this the division is a zero over a zero on every
        // member at once.
        heights[i] += total > 0 ? (pool * members[i].weight) / total : pool / n;
      }
    } else {
      heights[byGreed[0].index] += pool;
    }
  }
  return heights;
}

/**
 * How a place STANDS, from its layout and its floors — the one derivation of
 * the standing, read by {@link allocatePlaceHeights} and by the inverse that
 * must know which arithmetic made a set of heights ([B12]).
 *
 * A flowing place is a strip by choice and a place whose floors do not fit its
 * run is a strip by arithmetic ([B07]), and the two are the same standing. A
 * place of fewer than two members has nothing to divide and always shares.
 *
 * It takes the LAYOUT rather than being handed a standing, so that no caller
 * has to work out for itself which of the two a place is in. That was the shape
 * the inverse and the drag bounds used to be written in, and a caller that got
 * it wrong wrote a weight the allocator would not give back.
 */
function placeStandingOf(
  members: readonly PlaceMemberAppetite[],
  run: number,
  seam: number,
  layout: PlaceLayout,
): PlaceStanding {
  if (members.length < 2) return "shared";
  if (layout === "flow") return "overflow";
  if (!Number.isFinite(run) || run <= 0) return "overflow";
  const required =
    members.reduce((sum, member) => sum + member.floor, 0) +
    (members.length - 1) * seam;
  return required > run ? "overflow" : "shared";
}

/**
 * How a place divides `run` among `members`, seams included — the single
 * derivation of a member height ([P02]).
 *
 * The standing follows the place's LAYOUT ([B04]). A flowing place stands as a
 * strip whatever its run, because that is what flow means: the content is the
 * constraint and the run is a window onto it. A fitting place divides its run —
 * unless it cannot, which is the one derived exception ([B07]): floors and seams
 * that do not fit inside the run leave nothing to divide, so the place stands
 * as flowing until a member leaves or the window grows. That test used to be
 * THE rule and is now fit's fallback, and the standing stays derived and
 * visible either way, which is what lets the faces read it.
 *
 * `layout` is optional and absent reads as fit, so every caller written before
 * the choice existed allocates exactly as it did.
 *
 * Then the heights follow from the standing — the ladder in
 * {@link sharedHeightsOf} for a shared place, and each member's own comfort
 * height, weighted, for an overflowing one.
 *
 * Neither branch reads a number about the run rather than about the member.
 * An overflowing member takes `max(floor, comfort · weight)` — what it said it
 * wanted, scaled by what the user's own seam drags stored — so a strip is
 * built out of its members instead of out of a constant, and a member whose
 * floor exceeds any share of the run still stands at its floor. The count-based
 * standing and the fixed fraction-of-the-run height were the two halves of the
 * same proxy ([P01], [B07]), and neither is left.
 *
 * The census in `src/lib/__tests__/layout-imposer-heights-census.test.ts` is
 * the statement of what this must be true of, overflow rows included: every
 * height is at or above its floor, and `allocate(sharesFromHeights(h)) == h`
 * for every reachable `h`.
 */
export function allocatePlaceHeights(
  members: readonly PlaceMemberAppetite[],
  run: number,
  seam: number,
  layout: PlaceLayout = DEFAULT_PLACE_LAYOUT,
): PlaceAllocation {
  const sane = sanitizedAppetites(members);
  const gap = Number.isFinite(seam) && seam > 0 ? seam : 0;
  if (sane.length === 0) {
    return placeAllocationOf("shared", layout, sane, [], run, gap);
  }
  if (sane.length === 1) {
    // The undivided member IS the run, as today, even below its floor: a place
    // with one member has nothing to divide and no strip to scroll.
    return placeAllocationOf("shared", layout, sane, [run], run, gap);
  }
  if (placeStandingOf(sane, run, gap, layout) === "overflow") {
    // Flow is a strip by choice, and a run that cannot hold the floors is a
    // strip by arithmetic — fit's one derived exception ([B07]). The two stand
    // the same way and get the same heights.
    return placeAllocationOf(
      "overflow",
      layout,
      sane,
      flowHeightsOf(sane, run),
      run,
      gap,
    );
  }
  return placeAllocationOf(
    "shared",
    layout,
    sane,
    sharedHeightsOf(sane, run, gap),
    run,
    gap,
  );
}

/**
 * The allocation a place of `count` ANONYMOUS members gets: the equal
 * division, over members nobody has measured.
 *
 * This is what a *proposal* is: a picture of an arrangement nobody has stood
 * in, whose members have no appetites because they are not standing anywhere
 * yet. The Layout card's miniature draws its preview layers from it, which is
 * how the drawing keeps one span arithmetic for the committed picture and the
 * proposed ones alike while only the committed picture reads real heights.
 *
 * It answers the equal division because that is what the allocator answers for
 * members with no floor to fit and an appetite nothing satisfies, and the equal
 * division is what [P09] asks a proposal to draw. The endless natural is what
 * makes it so: a proposal's members are unmeasured rather than satisfied, so
 * they divide the run by weight in the ladder's discretionary stage and never
 * reach fit's slack rule, which would hand the whole picture to one of them
 * ([B06]). It is here rather than at the drawing so that the miniature still
 * derives no member height of its own ([P02]).
 */
export function nominalPlaceAllocation(
  count: number,
  run: number,
  seam: number,
): PlaceAllocation {
  const members: PlaceMemberAppetite[] = Array.from(
    { length: Math.max(0, count) },
    (_, index) => ({
      id: `${index}`,
      floor: 0,
      comfort: 0,
      natural: Infinity,
      greedRank: DEFAULT_GREED_RANK,
      weight: 1,
    }),
  );
  return allocatePlaceHeights(members, run, seam);
}

/**
 * The weights a set of heights means — the inverse of
 * {@link allocatePlaceHeights}, and what a committed seam drag stores ([P04]).
 *
 * It takes the place's LAYOUT and works the standing out itself ([B12]), so
 * that no caller has to decide which arithmetic made the heights it is handing
 * over. The standing is the one {@link placeStandingOf} derives, which is why
 * a FIT place whose floors do not fit inverts as a strip: those heights came
 * from flow's rule, and inverting them by fit's would store a weight the
 * allocator would not give back.
 *
 * A weight means a different thing in each standing, so the inverse does too.
 *
 * **A strip** — flow, or fit standing as flow: the weight is the multiplier on
 * NATURAL the height implies, which is the tier flow's heights are built on
 * ([B08]). A stream, whose natural is endless, reads the run as its natural
 * here exactly as it does there.
 *
 * **A shared run** — fit: the weight is the share of the discretionary pool
 * the member took, measured from whichever floor of that pool the place stands
 * above, and the two regimes scale differently because the difference carries
 * a fact.
 *
 * Below natural, the weights are scaled to average 1, so an equal division
 * round-trips to the all-ones record that an absent `shares` already means —
 * equal IS the default there, and returning the empty record for it is the
 * same statement in fewer bytes.
 *
 * Past natural the default is not the equal division but the greedy one
 * ([B06]), so THAT is the division that returns the empty record: heights
 * standing at every natural with the whole remainder on the greediest are what
 * a place nobody has dragged already looks like, and storing a record for it
 * would freeze today's greed ranks into the blob. Any other division of the
 * slack is a hand's, and it overrides the default for that place. Its weights
 * are scaled to put their LARGEST at `n` rather than to average 1, because an
 * equal division of slack is a real thing to have dragged to and must not come
 * back wearing the all-ones record that means nobody dragged at all.
 */
export function placeSharesFromHeights(
  members: readonly PlaceMemberAppetite[],
  heights: readonly number[],
  layout: PlaceLayout,
  run: number,
  seam = 0,
): Record<string, number> {
  const sane = sanitizedAppetites(members);
  if (sane.length < 2) return {};
  const gap = Number.isFinite(seam) && seam > 0 ? seam : 0;
  const standing = placeStandingOf(sane, run, gap, layout);
  const shares: Record<string, number> = {};
  if (standing === "overflow") {
    const screen = Number.isFinite(run) && run > 0 ? run : null;
    for (let i = 0; i < sane.length; i += 1) {
      const height = heights[i] ?? 0;
      const natural = Number.isFinite(sane[i].natural)
        ? sane[i].natural
        : (screen ?? sane[i].comfort);
      shares[sane[i].id] = natural > 0 ? height / natural : 1;
    }
    return shares;
  }
  const pastNatural = sane.every(
    (member, i) => (heights[i] ?? 0) >= member.natural - PLACE_HEIGHT_EPSILON,
  );
  const weights = sane.map((member, i) =>
    Math.max(0, (heights[i] ?? 0) - (pastNatural ? member.natural : member.comfort)),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= PLACE_HEIGHT_EPSILON) return {};
  if (pastNatural) {
    // The greedy default wears no record. The slack all standing on the
    // lowest `greedRank` — position as tiebreak, the order {@link
    // sharedHeightsOf} hands it out in — is what an undragged place already
    // allocates, so the empty record reproduces it exactly ([B12]).
    const greediest = sane
      .map((member, index) => ({ member, index }))
      .sort(
        (a, b) =>
          a.member.greedRank - b.member.greedRank || a.index - b.index,
      )[0].index;
    if (weights[greediest] >= total - PLACE_HEIGHT_EPSILON) return {};
  }
  // Averaging to 1 divides by the total; putting the largest at n divides by
  // the largest.
  const basis = pastNatural ? Math.max(...weights) : total;
  for (let i = 0; i < sane.length; i += 1) {
    shares[sane[i].id] = (weights[i] * sane.length) / basis;
  }
  return shares;
}

/**
 * How far the seam between members `index` and `index + 1` may be dragged,
 * as the range of `heights[index]` — the clamp the gesture holds every frame,
 * and the reason a drag can never write a height the allocator would refuse to
 * give back ([P10]).
 *
 * The regime is the allocation's own, never inferred here: the allocation
 * carries both the layout the place chose and the standing that layout put it
 * in ([B12]), so these bounds read a fact rather than re-deriving one from the
 * heights they are about to clamp.
 *
 * The bounds are the regime's (Table T02). A shared place whose comfort no
 * longer fits has no discretionary pool to move, so its seams are immovable;
 * one still below natural trades between comfort and natural; and one past
 * natural trades above natural. A range that comes out inverted — or collapsed,
 * which regime A reaches honestly ([Q01]) — is reported as the height standing
 * exactly where it is.
 *
 * A place standing as a STRIP is the one that does not trade. Its drag resizes
 * the member above the seam and lengthens the strip, leaving every other member
 * at the height it declared ([B08]) — so the bound below is that member's own
 * floor, and the bound above is a screen of it: the run, which is the same
 * measure flow gives a stream, and past which a card is being scrolled rather
 * than read. A member already taller than that keeps its own height as the
 * ceiling, so a drag can always hold where it is. A fit place whose floors do
 * not fit stands here too and drags the same way, because its heights were made
 * the same way ([B07]).
 */
export function seamDragBounds(
  allocation: PlaceAllocation,
  members: readonly PlaceMemberAppetite[],
  index: number,
): { lower: number; upper: number } {
  const sane = sanitizedAppetites(members);
  const heights = allocation.heights;
  const held = heights[index] ?? 0;
  if (index < 0 || index + 1 >= sane.length) return { lower: held, upper: held };
  const a = sane[index];
  const b = sane[index + 1];
  const span = (heights[index] ?? 0) + (heights[index + 1] ?? 0);
  let lower: number;
  let upper: number;
  if (allocation.standing === "overflow") {
    lower = a.floor;
    upper = Math.max(
      held,
      a.floor,
      Number.isFinite(allocation.run) && allocation.run > 0
        ? allocation.run
        : 0,
    );
  } else {
    const comfortRequired =
      sane.reduce((sum, member) => sum + member.comfort, 0) +
      (sane.length - 1) * allocation.seam;
    const pastNatural = sane.every(
      (member, i) => (heights[i] ?? 0) >= member.natural - PLACE_HEIGHT_EPSILON,
    );
    if (comfortRequired > allocation.run + PLACE_HEIGHT_EPSILON) {
      // Regime C: the pool is empty, so there is nothing to trade.
      return { lower: held, upper: held };
    }
    if (pastNatural) {
      lower = a.natural;
      upper = span - b.natural;
    } else {
      lower = Math.max(a.comfort, span - b.natural);
      upper = Math.min(a.natural, span - b.comfort);
    }
  }
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
    return { lower: held, upper: held };
  }
  return { lower, upper };
}

/** One split member's place in its column: which slot, which position, and how
 *  many members it divides the run with. */
export interface ColumnMemberPlacement {
  slot: number;
  index: number;
  count: number;
  /** How the place stands — the rail twin's own field, for the rail twin's own
   *  reason. */
  standing: PlaceStanding;
  /** And the layout that put it there, for the badge menu that offers the
   *  choice back ([B10]). Optional because no geometry reads it — the standing
   *  above is what the frame is built from — so a caller describing a
   *  placement rather than driving a menu leaves it off, and absent reads as
   *  fit exactly as an absent stored layout does. */
  layout?: PlaceLayout;
  /** The rail twin's own field, for the rail twin's own reason: the strip
   *  coordinates this frame's `var()` fallbacks are read from. */
  strip?: readonly number[];
}

/**
 * An overflowing member's `top` and `bottom`: the two strip coordinates either
 * side of it, with the whole strip slid up by the place's own offset.
 *
 * A member's height is no longer expressible in CSS — it is `max(floor,
 * comfort · weight)`, which is a fact about the member rather than about the
 * run — so the frame reads the allocation's own coordinates instead of solving
 * for a height. That is why there are `n + 1` strip properties for `n` members:
 * a frame pins to the coordinate above it and the one below it, exactly as a
 * shared frame pins to the seam above it and the one below it, and neither ever
 * multiplies an index by a height.
 *
 * The offset is CLAMPED HERE, in CSS, for the reason flow's is clamped inside
 * its `left`: make the window taller and the run grows while the stored number
 * stands still, and without the clamp the place would hold a stale slide until
 * the settled-resize retune fired. The clamp reads the strip's own end —
 * property `n` — so a strip that got shorter because a member's comfort fell
 * re-resolves in the same reflow ([L06]).
 *
 * `bottom` is `100%` less the coordinate below the member, plus the seam that
 * coordinate stands above (the last member has none: its lower coordinate IS
 * the strip's end). The last members of a long strip resolve it negative, and
 * that is the point: they hang below the run and the canvas clips them.
 *
 * The place enters only as `offsetProperty`, which is the whole of what a rail
 * and `stripProperty`, which is the whole of what a rail and a column differ by
 * here — the rest of the arithmetic is the run, and both stand in the same one.
 */
function overflowPins(
  member: { index: number; count: number; strip?: readonly number[] },
  offsetProperty: string,
  stripProperty: (index: number) => string,
  run: PlaceRun,
): { top: string; bottom: string } {
  const at = (index: number): string =>
    `var(${stripProperty(index)}, ${Math.round(member.strip?.[index] ?? 0)}px)`;
  const offset =
    `min(var(${offsetProperty}, 0px), ` +
    `max(0px, ${at(member.count)} - ${run.extent}))`;
  const seam = member.index < member.count - 1 ? run.seam : 0;
  return {
    top: `calc(${run.top} + ${at(member.index)} - ${offset})`,
    bottom:
      `calc(100% - ${run.top} - ${at(member.index + 1)} + ${seam}px + ${offset})`,
  };
}

/**
 * A column member's `top` and `bottom` — the column's own endpoints for the
 * first and last member, and the seam either side of it for the rest.
 *
 * Byte-identical to the undivided frame when the member is absent or its column
 * holds one member, which is what lets {@link imposeStyle} take the option
 * unconditionally.
 *
 * When the place overflows — the members' floors no longer fit in the run
 * ([P01]) — {@link overflowPins} takes over, against the slot's own offset
 * property.
 */
export function columnMemberPins(
  member: ColumnMemberPlacement | undefined,
): { top: string; bottom: string } {
  if (member === undefined)
    return { top: COLUMN_RUN.top, bottom: COLUMN_RUN.bottom };
  if (member.standing === "shared") {
    return memberPins(
      member,
      (j) => columnSeamProperty(member.slot, j),
      COLUMN_RUN,
    );
  }
  return overflowPins(
    member,
    columnOffsetProperty(member.slot),
    (j) => columnStripProperty(member.slot, j),
    COLUMN_RUN,
  );
}

