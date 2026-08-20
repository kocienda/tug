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
 * honest: what it shows is what the release does. Tiles are derived the way the
 * imposer derives them — heights travel with cards, members stack a gap apart,
 * and a column that would end up with three or more members lands under the
 * overflow rule rather than dividing ([P08]).
 */

import type { DeckState } from "../layout-tree";
import type { Rect } from "../snap";
import { deckColumnsOf } from "../deck-store-selectors";
import {
  COLUMN_OVERFLOW_VISIBLE_MEMBERS,
  IMPOSITION_GAP_PX,
  clampSlot,
  columnStanding,
  slotCount,
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

/** How far inside a zone's tile the indicator is drawn, in layout px. */
export const ZONE_INDICATOR_INSET_PX = 3;

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
 * wherever the tile a card would land in is a poor description of the region
 * that should select it — which is every position of a split column or a rail.
 *
 * A column's positions are asked for at its MEMBERS: the run divides at the
 * midpoint of each member standing there, so position 0 is asked for over the
 * top member's upper half, the last position over the bottom member's lower
 * half, and every position is a band the eye can find. Selecting by the landing
 * tile instead makes the last position of a column about to overflow nearly
 * unreachable — its tile begins four fifths of the way down a run it then hangs
 * off the bottom of, so the only pointer that asks for it is one in the last
 * sliver of the band, while everything above it reads as the middle position.
 * That is the wrong question, in the same way center distance was: the card is
 * being placed AMONG the cards that are there, and where they are is the fact
 * the hand is aiming at.
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
  /** The rail's member pane ids, top to bottom. */
  members: readonly string[];
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
 * overflowing column's run, or the flow strip's band.
 *
 * Resolved fresh each frame from the pointer, because which strip is under the
 * hand is a question about right now — a drag that crosses from one column to
 * another is scrolling the one it is over, not the one it started on.
 */
export interface AutoscrollTarget {
  kind: "column" | "flow";
  /** The slot whose column scrolls. Absent for the flow strip, which is the
   *  deck's one horizontal strip and has no slot to name. */
  slot?: number;
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
  return target.kind === "column" ? `column:${target.slot}` : "flow";
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
  /** Measure the canvas and enumerate, given the tab bars the gesture already
   *  snapshotted at its start. */
  enumerate(
    draggedPaneId: string,
    tabBars: ReadonlyMap<string, Rect>,
  ): DropZoneSet;
  /** Show the live zone, or take the indication away. Imperative DOM [L06]. */
  indicate(zone: DropZone | null): void;
  /** Commit the zone's mutation in one deck-manager call. False is a refusal
   *  the drop must make visible ([P09]) — never a quiet no-op. */
  commit(zone: DropZone, draggedPaneId: string): boolean;
  /** The strip the pointer is over, or null when nothing there scrolls. */
  autoscrollTargetFor(pointer: { x: number; y: number }): AutoscrollTarget | null;
  /**
   * Move a strip to `offset` imperatively — its custom property and nothing
   * else. Never a store write: the offset is an `arrangementSignature` term
   * ([P12]), so a per-frame commit would arm a FLIP settle on every frame of
   * the drag and tween the column's other members under the user's hand.
   */
  applyScroll(target: AutoscrollTarget, offset: number): void;
  /** Commit where the gesture left a strip. One store write, at the end, and
   *  the number is real state — a cancelled drag returns the card, not the
   *  view. */
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
 * The run a column's measured members are standing in: where their strip
 * begins, and how tall the place they divide is.
 *
 * An overflowing column's members do not fill their run — the last one hangs
 * off its bottom edge, which is the affordance ([P08]) — so the run is read
 * back through the rule that set the member height rather than summed from the
 * tiles. A shared column does fill it, so there the sum is the run.
 */
function runOf(members: readonly Rect[]): { top: number; height: number } {
  const top = Math.min(...members.map((rect) => rect.y));
  if (columnStanding(members.length) === "overflow") {
    return { top, height: members[0].height * COLUMN_OVERFLOW_VISIBLE_MEMBERS };
  }
  const height =
    members.reduce((sum, rect) => sum + rect.height, 0) +
    IMPOSITION_GAP_PX * (members.length - 1);
  return { top, height };
}

/**
 * Tiles for a column of `count` members standing under the overflow rule: every
 * member `run / 2.5` tall, stacked a gap apart down a strip that runs past the
 * run's bottom edge ([P08]).
 */
function overflowTiles(
  count: number,
  run: { top: number; height: number },
  x: number,
  width: number,
): Rect[] {
  const height = run.height / COLUMN_OVERFLOW_VISIBLE_MEMBERS;
  return Array.from({ length: count }, (_, i) => ({
    x,
    width,
    y: run.top + i * (height + IMPOSITION_GAP_PX),
    height,
  }));
}

/**
 * Tiles for a place whose members keep their own measured heights, one tile per
 * position the dragged card could take.
 *
 * Heights travel with cards — a member's share is keyed by its pane id — so
 * taking position `i` means the others close up around the dragged card's own
 * height wherever it lands, which is exactly what this stacks.
 */
function stackTiles(
  others: readonly Rect[],
  draggedHeight: number,
  runTop: number,
  x: number,
  width: number,
): Rect[] {
  const tiles: Rect[] = [];
  for (let i = 0; i <= others.length; i++) {
    const above = others.slice(0, i).reduce((sum, rect) => sum + rect.height, 0);
    tiles.push({
      x,
      width,
      y: runTop + above + i * IMPOSITION_GAP_PX,
      height: draggedHeight,
    });
  }
  return tiles;
}

/**
 * The bands that ask for each of a place's positions, given the members the
 * dragged card would be standing among.
 *
 * One band per position — `others.length + 1` of them — divided at each other
 * member's midpoint, so crossing a member's middle is what moves the indication
 * past it. The outermost bands are stretched to whichever is further out, the
 * run's edge or the member's own, so a column scrolled off its run still has
 * every position askable somewhere.
 *
 * @see {@link hitRectOf} for why selection is asked at the members rather than
 * at the tiles.
 */
function positionHitBands(
  others: readonly Rect[],
  bounds: { top: number; bottom: number },
  x: number,
  width: number,
): Rect[] {
  if (others.length === 0) {
    return [{ x, width, y: bounds.top, height: bounds.bottom - bounds.top }];
  }
  const first = others[0];
  const last = others[others.length - 1];
  const top = Math.min(bounds.top, first.y);
  const bottom = Math.max(bounds.bottom, last.y + last.height);
  const edges = [
    top,
    ...others.map((rect) => rect.y + rect.height / 2),
    bottom,
  ];
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
 * `draggedIndex` is the card's own index when the column is its own, or null
 * when it is arriving from elsewhere — the difference being whether the card
 * is already one of the measured members. Either way the resulting column has
 * `others.length + 1` members, and its standing is read off that count rather
 * than off the count the column has now: a two-member column that is about to
 * take a third divides no longer.
 */
function columnPlaces(
  members: readonly Rect[],
  draggedIndex: number | null,
): { tile: Rect; hit: Rect }[] {
  if (members.length === 0) return [];
  const run = runOf(members);
  const { x, width } = members[0];
  const others =
    draggedIndex === null
      ? members
      : members.filter((_, i) => i !== draggedIndex);
  const count = others.length + 1;
  const draggedHeight =
    draggedIndex === null ? run.height / count : members[draggedIndex].height;
  const tiles =
    columnStanding(count) === "overflow"
      ? overflowTiles(count, run, x, width)
      : stackTiles(others, draggedHeight, run.top, x, width);
  const hits = positionHitBands(
    others,
    { top: run.top, bottom: run.top + run.height },
    x,
    width,
  );
  return tiles.map((tile, index) => ({ tile, hit: hits[index] ?? tile }));
}

// ---- Enumeration ----

function railZonesOf(
  rail: DropZoneRail,
  draggedPaneId: string,
  panes: ReadonlyMap<string, Rect>,
): DropZoneSet {
  const members: Rect[] = [];
  for (const paneId of rail.members) {
    const rect = panes.get(paneId);
    if (rect === undefined) return { zones: [], origin: null };
    members.push(rect);
  }
  if (members.length === 0) return { zones: [], origin: null };
  const draggedIndex = rail.members.indexOf(draggedPaneId);
  const { x, width } = members[0];
  const runTop = Math.min(...members.map((rect) => rect.y));
  const others = members.filter((_, i) => i !== draggedIndex);
  const runBottom = Math.max(...members.map((rect) => rect.y + rect.height));
  const tiles = stackTiles(
    others,
    members[draggedIndex].height,
    runTop,
    x,
    width,
  );
  const hits = positionHitBands(
    others,
    { top: runTop, bottom: runBottom },
    x,
    width,
  );
  // A rail of N members advertises N positions, not N+1: the dragged card is
  // already one of them, so stacking the other N−1 around it yields exactly the
  // N places it could stand.
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
 * sidebar card sees its own rail's positions and nothing else, and a content
 * card sees content slots, split-column positions, and tab bars — never a
 * rail. Cross-place drops are a later feature, and the way this stays a later
 * feature is that neither vocabulary can name the other's places.
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
  const rail = measured.rails.find((r) => r.members.includes(draggedPaneId));
  if (rail !== undefined) {
    return railZonesOf(rail, draggedPaneId, measured.panes);
  }

  const kind = state.imposition.kind;
  if (kind === undefined) return { zones: [], origin: null };
  const dragged = state.panes.find((pane) => pane.id === draggedPaneId);
  if (dragged?.slot === undefined) return { zones: [], origin: null };
  const ownSlot = clampSlot(kind, dragged.slot);

  const columns = deckColumnsOf(state);
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
      const places = columnPlaces(members, draggedIndex);
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

    // A stacked slot, a slot holding one pane, or an empty anchor: the whole
    // slot is the zone, and dropping on it means joining what stands there.
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
