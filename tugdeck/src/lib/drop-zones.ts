/**
 * The drop-zone engine's pure half: which places a dragged card may land in,
 * where each of those places is on the canvas, and which one the pointer is
 * asking for.
 *
 * A drag under this engine moves the card freely and indicates exactly one
 * advertised zone at all times ([P09]). The initial indication is the card's
 * own current position, which is why {@link enumerateDropZones} returns an
 * origin alongside the list rather than leaving the caller to find it: "where
 * this card already stands" is a zone like any other, and a release that has
 * not travelled must resolve to it rather than to nothing.
 *
 * Nothing here touches the DOM. Every rect the engine needs is measured by the
 * gesture at drag-start and handed in ({@link DropZoneMeasurements}), so the
 * whole vocabulary is testable over synthetic geometry — the same bargain
 * `layout-imposer.ts` makes, and for the same reason: a zone that only exists
 * once a pointer is down is a zone nobody can write a test against.
 *
 * A zone's rect is **the tile the card would occupy if released there**, not a
 * hit-target drawn around a boundary. That is what lets the indicator be
 * honest: what it shows is what the release does. Tiles are derived with the
 * commit's own arithmetic — the post-drop order's appetites and weights through
 * `allocatePlaceHeights` ([P06]) — and a place whose floors would no longer fit
 * the run lands under the overflow rule rather than dividing ([P08]). The seam is a
 * value the place supplies, exactly as the imposer's `PlaceRun.seam` is: a
 * column divides at `IMPOSITION_GAP_PX`, a rail at `RAIL_SEAM_PX`, and the
 * tile arithmetic never reads either constant itself, so the two sides agree
 * by construction.
 */

import type { DeckState } from "../layout-tree";
import type { Rect } from "../snap";
import { deckColumnsOf } from "../deck-store-selectors";
import {
  allocatePlaceHeights,
  IMPOSITION_GAP_PX,
  RAIL_SEAM_PX,
  clampSlot,
  railWeightOf,
  slotCount,
  type PlaceMemberAppetite,
  type RailMode,
  type SidebarSide,
} from "./layout-imposer";

// ---- Feel constants ([Q01]) ----
//
// The drag's fine feel is deliberately unsettled — the plan ships the structure
// and tunes the numbers by hand on a debug build. They live together, here, so
// a tuning round is one file and one diff rather than a hunt.

/**
 * How much nearer a challenger zone must be than the incumbent before the
 * indication moves to it, in layout px.
 *
 * Zero would make the indicator flicker between two zones whenever the pointer
 * sat on the boundary between them; a margin makes the incumbent sticky, so
 * crossing is a decision rather than a tremor.
 */
export const ZONE_HYSTERESIS_PX = 24;

// The indicator's inset is the one feel number that lives elsewhere:
// `ZONE_INDICATOR_INSET_PX`, in `drop-zone-indicator.ts`, which is the only
// code that reads it and is a leaf a test can import without dragging this
// module's graph behind it. Tune it there.

/**
 * How close to a scrollable strip's edge the pointer must hold before the strip
 * starts advancing under it, in layout px.
 *
 * The band this is measured against is the run (a column) or the band (the flow
 * strip), so the margin has to be small enough that the middle of the band is
 * comfortably still, and wide enough that the user does not have to find a
 * hairline.
 */
export const AUTOSCROLL_MARGIN_PX = 56;

/** How fast a strip advances while the pointer holds inside the margin, in
 *  layout px per second. Constant rather than ramped by proximity: one number
 *  to tune ([Q01]), and a rate that does not change under a held hand. */
export const AUTOSCROLL_RATE_PX_PER_SEC = 900;

// ---- The vocabulary ([P10]) ----

/**
 * One place a dragged card may land.
 *
 * The four kinds are the whole vocabulary of v1 ([P10]): a position within a
 * split column, a slot as a whole (join its stack, or take an empty anchor),
 * another pane's tab bar (merge as a tab — the one drop zone the app already
 * shipped), and a position within a sidebar rail.
 *
 * Each kind names its target in its own terms rather than through a shared
 * `target` field: a column position is a slot plus an index, a tab bar is a
 * pane, a rail position is a side plus an index. One stringly-typed field
 * covering all three would have to be narrowed at every use.
 */
export type DropZone =
  | { kind: "column-index"; slot: number; index: number; rect: Rect; hit?: Rect }
  | { kind: "slot"; slot: number; rect: Rect; hit?: Rect }
  | { kind: "tab-bar"; paneId: string; rect: Rect; hit?: Rect }
  | {
      kind: "rail-index";
      side: SidebarSide;
      index: number;
      rect: Rect;
      hit?: Rect;
    };

/**
 * Where a zone is **asked for**, as opposed to where it lands.
 *
 * For most zones the two are the same rect and `hit` is absent. They come apart
 * in the stacked places — a split column's positions and a rail's — where the
 * tiles must widen into abutting full-run bands for every position to be
 * askable from anywhere in the run.
 *
 * A position is asked for AT ITS TILE. The indicator draws where the release
 * lands, so the region that selects a position is the region the preview
 * draws — a drag latches at the title bar, so the pointer IS the title bar,
 * and the moment it crosses into the next drawn tile the indication follows.
 * The bands divide the run at each successive tile's top edge, with the
 * outermost stretched to whichever is further out, the run's edge or the
 * strip's own, so a column scrolled off its run still has every position
 * askable somewhere. Dividing anywhere else — the sitting members' midpoints
 * were the previous rule — makes the indication disagree with its own
 * drawing: the title bar stands inside the bottom tile while the outline
 * still claims the top one, and the switch lands three quarters of the way
 * down the run instead of where the preview said it would.
 *
 * The tile stays exactly what it was, so the indicator keeps its promise: what
 * it draws is still where the release lands.
 */
export function hitRectOf(zone: DropZone): Rect {
  return zone.hit ?? zone.rect;
}

/** A rail's composition, in the rail's own vertical order.
 *
 *  Fed in rather than derived: a rail's membership and order come from
 *  `sidebarRailsOf`, which reads the component registry, and a pure module
 *  cannot see a registry. */
export interface DropZoneRail {
  side: SidebarSide;
  /** Stacked or split. A rail card arriving from the other side lands in a
   *  split rail at a position; what a stacked destination advertises is its
   *  own question, answered where the vocabulary is assembled. */
  mode: RailMode;
  /** The rail's member pane ids, top to bottom. */
  members: readonly string[];
  /** The members' division weights, keyed by pane id — the rail's stored
   *  shares re-keyed from componentId at the measurement boundary, since a
   *  pure module cannot see the registry that maps one to the other. Absent
   *  members weigh 1 (`railWeightOf`'s rule). */
  shares?: Readonly<Record<string, number>>;
}

/**
 * Everything the DOM knows that {@link DeckState} does not — measured once, at
 * drag-start, in canvas-relative layout px (the gesture divides out page zoom
 * before it gets here).
 */
export interface DropZoneMeasurements {
  /** Every slot of the arrangement, occupied or not, by slot index. An empty
   *  slot has no pane to measure, so its anchor comes from the imposer's own
   *  solve; a slot missing here simply advertises nothing. */
  slots: ReadonlyMap<number, Rect>;
  /** Every pane's frame, by pane id — content and rail alike. */
  panes: ReadonlyMap<string, Rect>;
  /** Every other pane's tab bar, by pane id — the gesture's existing
   *  `dragTabBarCache` snapshot, which already excludes the dragged pane. */
  tabBars: ReadonlyMap<string, Rect>;
  /** The rails standing on the deck's edges. */
  rails: readonly DropZoneRail[];
  /**
   * What every member of every place wants of its run, by PANE ID — the
   * host's `placeMemberAppetites` over each sidebar and slotted pane, with a
   * rail's members re-keyed from componentId at the same boundary its shares
   * are.
   *
   * One map for both kinds of place rather than one per rail and one per
   * column: a tile is the allocator's answer either way, and the allocator
   * asks the same question of a rail member and a column member. A member
   * missing from it contributes no appetite at all, which the allocator reads
   * as a floorless member of whatever the place decides.
   */
  appetites: ReadonlyMap<string, PlaceMemberAppetite>;
  /**
   * The run each kind of place divides, in layout px — the deck's own
   * measurement (`getColumnRunHeight` and `getRailRunHeight`), never a sum
   * of frames. A frame in flight defines nothing, and the store is the one
   * reader that cannot be moved by a hand ({@link seatedPlace}). `null` is
   * a canvas with no height to speak of, and that kind of place then
   * advertises nothing.
   */
  runs: { column: number | null; rail: number | null };
  /**
   * The dragged card's own frame at gesture start, before any transform —
   * the one rect of its own it can still vouch for. Read only when the card
   * is the sole member of its place, so there is no seated frame to measure
   * the place from; every other place is read off a member that stayed put.
   */
  draggedAtStart: Rect;
  /**
   * The landing strip a side with no rail holds open while a rail card is
   * in the air, by side — the `.tug-rail-vacancy` tile's box, at the rail's
   * anchor and the width the card would take ([B10]). A side with a rail
   * standing on it has members to measure and is absent here; a side with
   * neither advertises nothing.
   */
  railVacancies: Partial<Record<SidebarSide, Rect>>;
}

/** The zones a gesture may land in, and the one it starts indicating. */
export interface DropZoneSet {
  zones: readonly DropZone[];
  /**
   * The dragged card's own current position — the initial indication ([P09]),
   * and what a zero-travel release resolves to.
   *
   * Null only when the card is not arrangeable at all (a free pane, or an
   * unpinned sidebar card), in which case `zones` is empty too and the caller
   * runs its ordinary free drag.
   */
  origin: DropZone | null;
}

/**
 * A strip a drag can scroll by holding the pointer near its edge: an
 * overflowing column's or rail's run, or the flow strip's band.
 *
 * Resolved fresh each frame from the pointer, because which strip is under the
 * hand is a question about right now — a drag that crosses from one column to
 * another is scrolling the one it is over, not the one it started on.
 */
export interface AutoscrollTarget {
  kind: "column" | "rail" | "flow";
  /** The slot whose column scrolls. Absent for the flow strip, which is the
   *  deck's one horizontal strip and has no slot to name. */
  slot?: number;
  /** The side whose rail scrolls. Absent for every other kind, which names its
   *  place the other way or has no place to name. */
  side?: SidebarSide;
  /** The axis the strip travels on — down the run, or across the band. */
  axis: "x" | "y";
  /** The band's near and far edges along that axis, in canvas layout px. */
  bandStart: number;
  bandEnd: number;
  /** Where the strip stands now. */
  offset: number;
  /** How far it may travel: the strip's length less the band's. */
  maxOffset: number;
}

/** A strip's identity, for keeping one running offset per strip across a drag
 *  that visits several. */
export function autoscrollKey(target: AutoscrollTarget): string {
  switch (target.kind) {
    case "column":
      return `column:${target.slot}`;
    case "rail":
      return `rail:${target.side}`;
    case "flow":
      return "flow";
  }
}

/**
 * How far a strip should advance this frame — positive toward its far edge,
 * zero when the pointer is not at either margin.
 *
 * A rate times an elapsed time, so the travel is the same for a given hold
 * however the frames fall. `pointer` and the band are read along the strip's
 * own axis, which is what lets one rule serve both the column's run and the
 * flow band ([P08]'s bargain, again: an axis-free rule read twice).
 */
export function autoscrollDelta(input: {
  pointer: number;
  bandStart: number;
  bandEnd: number;
  elapsedMs: number;
}): number {
  const { pointer, bandStart, bandEnd, elapsedMs } = input;
  if (!(elapsedMs > 0) || !Number.isFinite(pointer)) return 0;
  const travel = (AUTOSCROLL_RATE_PX_PER_SEC * elapsedMs) / 1000;
  if (pointer > bandEnd - AUTOSCROLL_MARGIN_PX) return travel;
  if (pointer < bandStart + AUTOSCROLL_MARGIN_PX) return -travel;
  return 0;
}

/**
 * What a dragging pane asks the canvas for, and what it hands back.
 *
 * The gesture lives in `tug-pane.tsx` and the arrangement lives in the deck, so
 * neither can answer the whole question alone: a pane knows where the pointer
 * is and nothing about the slots, and the canvas knows the arrangement and
 * nothing about the gesture. This is the seam — three verbs, all owned by the
 * canvas, all called from the pane.
 */
export interface DropZoneHost {
  /** Measure the canvas and enumerate, given what the gesture snapshotted at
   *  its start: the tab bars, and the dragged frame's own rect before it
   *  moved. */
  enumerate(
    draggedPaneId: string,
    tabBars: ReadonlyMap<string, Rect>,
    draggedAtStart: Rect,
  ): DropZoneSet;
  /** Show the live zone, or take the indication away. Imperative DOM [L06]. */
  indicate(zone: DropZone | null): void;
  /**
   * Publish where the dragged frame stands to the gauge channel ([P08]), so
   * instruments away from the canvas can draw the drag itself. `null` retires
   * the drag: the frame gauge goes quiet and the drag-only affordances with it.
   *
   * The frame is passed as its ELEMENT rather than a rect because the canvas
   * is the one that knows what a rect on it means — the same reason
   * {@link DropZoneHost.enumerate} measures rather than being told.
   */
  gaugeDragFrame(frame: HTMLElement | null): void;
  /** Commit the zone's mutation in one deck-manager call. False is a refusal
   *  the drop must make visible ([P09]) — never a quiet no-op. */
  commit(zone: DropZone, draggedPaneId: string): boolean;
  /** The strip the pointer is over, or null when nothing there scrolls.
   *
   *  `draggedPaneId` is handed in because a place's band is read off one of
   *  its members' frames, and that member may be the one under the hand —
   *  the same hazard {@link seatedPlace} closes for the tiles, at the site
   *  that decides which strip is being asked about. Without it a card carried
   *  across the deck takes its old place's band with it, so the place it left
   *  never scrolls and the one it is over may answer for it ([B07]). */
  autoscrollTargetFor(
    pointer: { x: number; y: number },
    draggedPaneId: string,
  ): AutoscrollTarget | null;
  /**
   * Move a strip to `offset` imperatively — its custom property and nothing
   * else, so the strip follows the hand at no measuring cost. The store write
   * comes once, at the end, through {@link commitScroll} ([P12]).
   */
  applyScroll(target: AutoscrollTarget, offset: number): void;
  /** Commit where the gesture left a strip. One store write, at the end, and
   *  the number is real state — a cancelled drag returns the card, not the
   *  view. It commits with `landing: "cut"` — the strip is already drawn at
   *  this offset, so the settle declines rather than tweening the members
   *  under the user's hand ([B01], [B03]). */
  commitScroll(target: AutoscrollTarget, offset: number): void;
}

/**
 * A zone's identity, for comparing an incumbent against a freshly enumerated
 * list. Two zones with the same key are the same place, whatever their rects
 * say — rects move under autoscroll, places do not.
 */
export function dropZoneKey(zone: DropZone): string {
  switch (zone.kind) {
    case "column-index":
      return `column:${zone.slot}:${zone.index}`;
    case "slot":
      return `slot:${zone.slot}`;
    case "tab-bar":
      return `tab:${zone.paneId}`;
    case "rail-index":
      return `rail:${zone.side}:${zone.index}`;
  }
}

// ---- Tiles ----

/**
 * Where a place stands on the canvas — its run's top and height, and its
 * strip's `x` and `width` — read from ONE SEATED FRAME and the deck's own run
 * height, never from the frame in flight.
 *
 * A dragged card's rect carries its drag transform, so a run measured from it
 * moves with the hand — and the gesture re-enumerates on every autoscroll
 * frame, so the error grows for as long as the pointer holds at the edge.
 * The run's height is therefore the deck's measurement (`getRailRunHeight`
 * and its column twin, handed in as `run`), and its top is recovered from a
 * member that is not being dragged by inverting the pin the imposer wrote for
 * it: under overflow that member stands `index` strides down the strip
 * (`overflowPins`), and shared it stands at its seam fraction plus half a
 * seam (`memberPins`). The seated frame carries the strip's live offset, so a
 * scrolled place reads back scrolled, which is what the tiles are drawn
 * against.
 *
 * Only when the dragged card is the place's sole member is there no seated
 * frame, and then the rect it had at gesture start stands in. Subtracting the
 * transform back out of a live measurement would fix this site and leave the
 * next re-measure to make the same mistake, so no path here reads the dragged
 * card's live rect at all.
 *
 * `seam` is the place's own: the gap between a column's members, the 0 seam
 * between a rail's. `order` is the place's CURRENT member order, dragged card
 * included when it is a member, with `rects` indexed the same way.
 */
function seatedPlace(
  order: readonly string[],
  rects: readonly Rect[],
  shares: Readonly<Record<string, number>> | undefined,
  appetites: ReadonlyMap<string, PlaceMemberAppetite>,
  draggedId: string,
  draggedAtStart: Rect,
  run: number,
  seam: number,
): { run: { top: number; height: number }; x: number; width: number } {
  const seatedIndex = order.findIndex((id) => id !== draggedId);
  const index = seatedIndex === -1 ? 0 : seatedIndex;
  const seated = seatedIndex === -1 ? draggedAtStart : rects[seatedIndex];
  // How far down the strip the seated member stands, read off the place's own
  // allocation over its CURRENT order — the same arithmetic the pins wrote for
  // it, inverted. One reading for both standings: a strip's member is at its
  // top, and so is a shared one.
  const advance = allocatePlaceHeights(
    placeAppetites(order, appetites, shares),
    run,
    seam,
  ).tops[index];
  return {
    run: { top: seated.y - advance, height: run },
    x: seated.x,
    width: seated.width,
  };
}

/**
 * The appetites a place's `order` carries, in the order's own order: each
 * member's measured appetite, wearing the weight THIS place stores for it.
 *
 * The weight is re-read here rather than taken from the map because a card's
 * share is a fact about the place it stands in, and the map is keyed by pane
 * across every place at once. Weights travel with cards — a member absent from
 * `shares` weighs 1, which is `railWeightOf`'s rule — so a foreign arrival
 * previews the re-division its extra member forces, and a member reordering
 * its own place previews its share standing wherever it lands.
 *
 * A member the measurement never saw contributes no appetite: floors of zero,
 * and a greed rank of `NaN`, which the allocator sanitizes to the default rank
 * rather than reaching for a registry this module cannot see.
 */
function placeAppetites(
  order: readonly string[],
  appetites: ReadonlyMap<string, PlaceMemberAppetite>,
  shares: Readonly<Record<string, number>> | undefined,
): PlaceMemberAppetite[] {
  return order.map((id) => {
    const measured = appetites.get(id);
    const weight = railWeightOf(shares, id);
    return measured === undefined
      ? { id, floor: 0, comfort: 0, natural: 0, greedRank: Number.NaN, weight }
      : { ...measured, weight };
  });
}

/**
 * One tile per position the dragged card could take in a place: for each
 * candidate index, the post-drop order is the sitting members with the dragged
 * card inserted there, and the tile is what the allocator gives that member of
 * the run.
 *
 * This is the pins' own arithmetic with the run resolved to measured pixels —
 * the same allocation, over the same appetites and weights the commit will
 * allocate from — which is what makes the tile a promise the commit keeps by
 * construction ([P06]). The seam arrives as a value for the same reason it
 * rides `PlaceRun.seam` there, so a rail's 0 seam and a column's gap are one
 * arithmetic rather than two, and the standing is the allocator's rather than
 * a count the caller forked on.
 */
function placeTiles(
  others: readonly string[],
  appetites: ReadonlyMap<string, PlaceMemberAppetite>,
  shares: Readonly<Record<string, number>> | undefined,
  draggedId: string,
  run: { top: number; height: number },
  x: number,
  width: number,
  seam: number,
): Rect[] {
  const count = others.length + 1;
  return Array.from({ length: count }, (_, i) => {
    const order = [...others.slice(0, i), draggedId, ...others.slice(i)];
    const allocation = allocatePlaceHeights(
      placeAppetites(order, appetites, shares),
      run.height,
      seam,
    );
    return {
      x,
      width,
      y: run.top + allocation.tops[i],
      height: allocation.heights[i],
    };
  });
}

/**
 * The bands that ask for each of a place's positions, one per tile.
 *
 * The bands divide the run at each successive tile's top edge, so a position
 * is asked for over the tile the indicator draws for it ({@link hitRectOf}
 * says why). The outermost bands are stretched to whichever is further out,
 * the run's edge or the strip's own, so a column scrolled off its run still
 * has every position askable somewhere.
 */
function tileHitBands(
  tiles: readonly Rect[],
  bounds: { top: number; bottom: number },
  x: number,
  width: number,
): Rect[] {
  if (tiles.length === 0) return [];
  const last = tiles[tiles.length - 1];
  const top = Math.min(bounds.top, tiles[0].y);
  const bottom = Math.max(bounds.bottom, last.y + last.height);
  const edges = [top, ...tiles.slice(1).map((tile) => tile.y), bottom];
  const bands: Rect[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    bands.push({
      x,
      width,
      y: edges[i],
      height: Math.max(0, edges[i + 1] - edges[i]),
    });
  }
  return bands;
}

/**
 * Each position of a split column: the tile the card would land in, and the
 * band that asks for it.
 *
 * `order` is the column's sitting member order and `rects` their measured
 * frames, same indexing; the dragged card may be one of them (its own column)
 * or absent (arriving from elsewhere). Either way the resulting column has
 * one member per sitter-other-than-the-dragged plus the dragged card itself,
 * and both the standing and the seams are read off that post-drop world: a
 * two-member column about to take a third stacks the overflow strip, and a
 * column that will still share divides at the fractions the commit's own
 * arithmetic will write ([P06]). The place itself — run and strip — is read
 * off a seated frame and the deck's `columnRun` ({@link seatedPlace}), so
 * the dragged card's travel never moves the tiles it is choosing between.
 */
function columnPlaces(
  order: readonly string[],
  rects: readonly Rect[],
  shares: Readonly<Record<string, number>> | undefined,
  appetites: ReadonlyMap<string, PlaceMemberAppetite>,
  draggedPaneId: string,
  draggedAtStart: Rect,
  columnRun: number | null,
): { tile: Rect; hit: Rect }[] {
  if (rects.length === 0 || columnRun === null) return [];
  const seam = IMPOSITION_GAP_PX;
  const { run, x, width } = seatedPlace(
    order,
    rects,
    shares,
    appetites,
    draggedPaneId,
    draggedAtStart,
    columnRun,
    seam,
  );
  const others = order.filter((id) => id !== draggedPaneId);
  const tiles = placeTiles(
    others,
    appetites,
    shares,
    draggedPaneId,
    run,
    x,
    width,
    seam,
  );
  const hits = tileHitBands(
    tiles,
    { top: run.top, bottom: run.top + run.height },
    x,
    width,
  );
  return tiles.map((tile, index) => ({ tile, hit: hits[index] ?? tile }));
}

// ---- Enumeration ----

/** A stacked rail's one rect: the union of its SEATED members' frames, which
 *  under a stack are the same frame drawn front to back ([F09]). The dragged
 *  card is left out for the reason {@link seatedPlace} leaves it out — its
 *  rect carries the drag transform, so a rail read through it would follow
 *  the hand — and only when it is the rail's sole member does its own
 *  gesture-start rect stand in ([B07]). Null when a seated member is missing
 *  from the measurement, so a rail that cannot be read whole advertises
 *  nothing. */
function stackRect(
  rail: DropZoneRail,
  measured: DropZoneMeasurements,
  draggedPaneId: string,
): Rect | null {
  let union: Rect | null = null;
  for (const paneId of rail.members) {
    if (paneId === draggedPaneId) continue;
    const rect = measured.panes.get(paneId);
    if (rect === undefined) return null;
    if (union === null) {
      union = { ...rect };
      continue;
    }
    const left = Math.min(union.x, rect.x);
    const top = Math.min(union.y, rect.y);
    const right = Math.max(union.x + union.width, rect.x + rect.width);
    const bottom = Math.max(union.y + union.height, rect.y + rect.height);
    union = { x: left, y: top, width: right - left, height: bottom - top };
  }
  return union ?? { ...measured.draggedAtStart };
}

function railZonesOf(
  rail: DropZoneRail,
  draggedPaneId: string,
  measured: DropZoneMeasurements,
): DropZoneSet {
  const members: Rect[] = [];
  for (const paneId of rail.members) {
    const rect = measured.panes.get(paneId);
    if (rect === undefined) return { zones: [], origin: null };
    members.push(rect);
  }
  const railRun = measured.runs.rail;
  if (members.length === 0 || railRun === null) {
    return { zones: [], origin: null };
  }
  const draggedIndex = rail.members.indexOf(draggedPaneId);
  const others = rail.members.filter((id) => id !== draggedPaneId);
  // A rail stands under the same overflow rule a column does, so its tiles
  // take the same fork: the post-drop rail is a strip when the members' floors
  // no longer fit in the run and a division when they do ([P01]), and the
  // allocator decides which without being asked. The run is the deck's
  // own measurement and the strip is read off a member that is not moving
  // ({@link seatedPlace}), so the dragged card's travel — and the strip's
  // autoscroll under it — never move the tiles it is choosing between. The
  // seam is the rail's own — `RAIL_SEAM_PX`, the value the imposer divides a
  // rail with — so the tiles pin at the seams the commit will actually write.
  const seam = RAIL_SEAM_PX;
  const { run, x, width } = seatedPlace(
    rail.members,
    members,
    rail.shares,
    measured.appetites,
    draggedPaneId,
    measured.draggedAtStart,
    railRun,
    seam,
  );
  // The post-drop rail: the sitters other than the dragged card, plus the
  // dragged card itself — N for its own rail, N + 1 for the other one.
  const tiles = placeTiles(
    others,
    measured.appetites,
    rail.shares,
    draggedPaneId,
    run,
    x,
    width,
    seam,
  );
  const hits = tileHitBands(
    tiles,
    { top: run.top, bottom: run.top + run.height },
    x,
    width,
  );
  // The card's own rail of N members advertises N positions, not N+1: the
  // dragged card is already one of them, so stacking the other N−1 around it
  // yields exactly the N places it could stand. The other rail advertises
  // N+1, because there the card is an arrival ([B08]); its origin is null.
  const zones: DropZone[] = tiles.map((rect, index) => ({
    kind: "rail-index",
    side: rail.side,
    index,
    rect,
    hit: hits[index] ?? rect,
  }));
  return { zones, origin: zones[draggedIndex] ?? null };
}

/**
 * The zones a drag of `draggedPaneId` may land in, and the one it starts on.
 *
 * The vocabulary depends on what kind of card is moving ([P10]): a pinned
 * sidebar card sees BOTH rails' positions — N on its own, N+1 on the other,
 * where it would be an arrival — and nothing else; a content card sees
 * content slots, split-column positions, and tab bars — never a rail. The
 * vocabularies stay disjoint across KINDS of card: neither can name the
 * other's places, which is what keeps a content card off a rail and a rail
 * card out of a slot.
 *
 * A card that is arrangeable in neither sense — a free pane on an unimposed
 * deck, an unpinned sidebar card — gets no zones at all. That is the signal
 * for the caller to run its ordinary free drag: an engine that invented a zone
 * for a card with nowhere to be would have to invent its commit too.
 */
export function enumerateDropZones(
  state: DeckState,
  draggedPaneId: string,
  measured: DropZoneMeasurements,
): DropZoneSet {
  const ownRail = measured.rails.find((r) => r.members.includes(draggedPaneId));
  if (ownRail !== undefined) {
    const zones: DropZone[] = [];
    let origin: DropZone | null = null;
    for (const rail of measured.rails) {
      if (rail.mode !== "split") {
        // A stacked rail is one rect front to back, and what it offers is the
        // stack itself rather than a position in a division: one zone, the
        // rail's whole rect, and an arrival goes to the front — index 0 of
        // the stored order — with the mode untouched ([B11]). The fork is on
        // the rail's MODE alone and not on whose rail it is, because the
        // shape is the same fact either way: a stack's members share one
        // frame, so there are no positions to divide it into, and reading a
        // division out of them would put the tiles wherever the arithmetic
        // for a split rail happened to land. A stacked own rail therefore
        // advertises its one rect as its own origin, and a release over it
        // asks for the place the card already holds.
        const stack = stackRect(rail, measured, draggedPaneId);
        if (stack !== null) {
          const zone: DropZone = {
            kind: "rail-index",
            side: rail.side,
            index: 0,
            rect: stack,
          };
          zones.push(zone);
          if (rail === ownRail) origin = zone;
        }
        continue;
      }
      const set = railZonesOf(rail, draggedPaneId, measured);
      zones.push(...set.zones);
      if (rail === ownRail) origin = set.origin;
    }
    // A side with no rail holds open a landing strip while the card is in
    // the air ([B10]): the vacancy tile is the promise the indicator draws,
    // the same way a slot's is, and the card arrives alone at index 0.
    for (const side of ["left", "right"] as const) {
      if (measured.rails.some((rail) => rail.side === side)) continue;
      const vacancy = measured.railVacancies[side];
      if (vacancy === undefined) continue;
      zones.push({ kind: "rail-index", side, index: 0, rect: vacancy });
    }
    return { zones, origin };
  }

  const kind = state.imposition.kind;
  if (kind === undefined) return { zones: [], origin: null };
  const dragged = state.panes.find((pane) => pane.id === draggedPaneId);
  if (dragged?.slot === undefined) return { zones: [], origin: null };
  const ownSlot = clampSlot(kind, dragged.slot);

  const columns = deckColumnsOf(state, measured.runs.column);
  const zones: DropZone[] = [];
  let origin: DropZone | null = null;

  for (let slot = 0; slot < slotCount(kind); slot++) {
    const column = columns.find((c) => c.slot === slot);
    const own = slot === ownSlot;

    if (column !== undefined && column.mode === "split") {
      const members: Rect[] = [];
      for (const paneId of column.members) {
        const rect = measured.panes.get(paneId);
        if (rect === undefined) break;
        members.push(rect);
      }
      if (members.length !== column.members.length) continue;
      const draggedIndex = own ? column.members.indexOf(draggedPaneId) : null;
      const places = columnPlaces(
        column.members,
        members,
        state.imposition.columns?.[slot]?.shares,
        measured.appetites,
        draggedPaneId,
        measured.draggedAtStart,
        measured.runs.column,
      );
      // The card's own column keeps its member count; a foreign one grows by
      // the arriving card, so it advertises one more position than it has
      // members.
      const positions = own ? column.members.length : column.members.length + 1;
      for (let index = 0; index < positions; index++) {
        const place = places[index];
        if (place === undefined) continue;
        const zone: DropZone = {
          kind: "column-index",
          slot,
          index,
          rect: place.tile,
          hit: place.hit,
        };
        zones.push(zone);
        if (own && index === draggedIndex) origin = zone;
      }
      continue;
    }

    // A foreign card standing alone in its slot: the drop divides ([P07]).
    // The slot advertises the two positions the split will make — upper half
    // index 0, lower half index 1 — through the same division path a split
    // column's places take, with the sitter as the sole sitting member, so
    // the tiles are the halves the commit's seam will cut (Spec S02). A
    // stacked multi-pane column keeps its whole-slot join below: a stack is
    // an arrangement the user chose, and body-dropping into it joins it.
    if (column !== undefined && column.members.length === 1 && !own) {
      const sitterRect = measured.panes.get(column.members[0]);
      if (sitterRect !== undefined) {
        const places = columnPlaces(
          column.members,
          [sitterRect],
          state.imposition.columns?.[slot]?.shares,
          measured.appetites,
          draggedPaneId,
          measured.draggedAtStart,
          measured.runs.column,
        );
        for (const [index, place] of places.entries()) {
          zones.push({
            kind: "column-index",
            slot,
            index,
            rect: place.tile,
            hit: place.hit,
          });
        }
        continue;
      }
    }

    // A stacked slot, the card's own single-pane slot, or an empty anchor:
    // the whole slot is the zone — dropping on it means joining what stands
    // there, or standing where the card already stands.
    const rect = measured.slots.get(slot);
    if (rect === undefined) continue;
    const zone: DropZone = { kind: "slot", slot, rect };
    zones.push(zone);
    if (own) origin = zone;
  }

  for (const [paneId, rect] of measured.tabBars) {
    if (paneId === draggedPaneId) continue;
    zones.push({ kind: "tab-bar", paneId, rect });
  }

  return { zones, origin };
}

// ---- Indication ----

function centerDistance(rect: Rect, pointer: { x: number; y: number }): number {
  const dx = rect.x + rect.width / 2 - pointer.x;
  const dy = rect.y + rect.height / 2 - pointer.y;
  return Math.hypot(dx, dy);
}

/** How far outside `rect` the pointer is; zero anywhere inside it. */
function edgeDistance(rect: Rect, pointer: { x: number; y: number }): number {
  const dx = Math.max(rect.x - pointer.x, 0, pointer.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - pointer.y, 0, pointer.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/**
 * How near the pointer is to a zone, as the pair the comparison actually needs.
 *
 * **Containment first.** A pointer standing inside a zone is asking for that
 * zone, whatever the arithmetic says about anywhere else — and center distance
 * alone gets this wrong in exactly the case the deck is full of: a tall slot's
 * center is far from its own top edge, so a pointer resting on a card's title
 * bar can measure nearer to the *middle* of a neighbouring column than to the
 * slot it is physically inside. That is not a tuning error, it is the wrong
 * question.
 *
 * **Center distance breaks ties.** Inside-ness is a yes or no, so it cannot
 * separate two zones the pointer is inside at once — and one nesting is
 * guaranteed: a tab bar always lies within the tile of the pane it belongs to.
 * There the centers separate them the way the eye does, the thin bar's being
 * close and the tall tile's far.
 */
function zoneScore(
  rect: Rect,
  pointer: { x: number; y: number },
): { edge: number; center: number } {
  return {
    edge: edgeDistance(rect, pointer),
    center: centerDistance(rect, pointer),
  };
}

/** Whether `a` is nearer than `b`, by at least `margin` on the decisive term. */
function nearer(
  a: { edge: number; center: number },
  b: { edge: number; center: number },
  margin: number,
): boolean {
  if (a.edge !== b.edge) return a.edge + margin < b.edge;
  return a.center + margin < b.center;
}

/**
 * Which zone the pointer is asking for, given the one already indicated.
 *
 * The incumbent holds its place until a challenger beats it by
 * {@link ZONE_HYSTERESIS_PX}, so the indication crosses a boundary once rather
 * than oscillating across it. An incumbent that is no longer in the list — a
 * column that lost a member mid-gesture — yields to the nearest zone.
 */
export function pickLiveZone(
  zones: readonly DropZone[],
  pointer: { x: number; y: number },
  incumbent: DropZone | null,
): DropZone | null {
  if (zones.length === 0) return null;
  let best = zones[0];
  let bestScore = zoneScore(hitRectOf(best), pointer);
  for (const zone of zones.slice(1)) {
    const score = zoneScore(hitRectOf(zone), pointer);
    if (nearer(score, bestScore, 0)) {
      best = zone;
      bestScore = score;
    }
  }
  if (incumbent === null) return best;
  const key = dropZoneKey(incumbent);
  const standing = zones.find((zone) => dropZoneKey(zone) === key);
  if (standing === undefined) return best;
  if (dropZoneKey(best) === key) return standing;
  return nearer(
    bestScore,
    zoneScore(hitRectOf(standing), pointer),
    ZONE_HYSTERESIS_PX,
  )
    ? best
    : standing;
}
