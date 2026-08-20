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
  | { kind: "column-index"; slot: number; index: number; rect: Rect }
  | { kind: "slot"; slot: number; rect: Rect }
  | { kind: "tab-bar"; paneId: string; rect: Rect }
  | { kind: "rail-index"; side: SidebarSide; index: number; rect: Rect };

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
 * Where the dragged card would land for each position of a split column.
 *
 * `draggedIndex` is the card's own index when the column is its own, or null
 * when it is arriving from elsewhere — the difference being whether the card
 * is already one of the measured members. Either way the resulting column has
 * `others.length + 1` members, and its standing is read off that count rather
 * than off the count the column has now: a two-member column that is about to
 * take a third divides no longer.
 */
function columnTileRects(
  members: readonly Rect[],
  draggedIndex: number | null,
): Rect[] {
  if (members.length === 0) return [];
  const run = runOf(members);
  const { x, width } = members[0];
  const others =
    draggedIndex === null
      ? members
      : members.filter((_, i) => i !== draggedIndex);
  const count = others.length + 1;
  if (columnStanding(count) === "overflow") {
    return overflowTiles(count, run, x, width);
  }
  const draggedHeight =
    draggedIndex === null ? run.height / count : members[draggedIndex].height;
  return stackTiles(others, draggedHeight, run.top, x, width);
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
  const tiles = stackTiles(
    others,
    members[draggedIndex].height,
    runTop,
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
      const tiles = columnTileRects(members, draggedIndex);
      // The card's own column keeps its member count; a foreign one grows by
      // the arriving card, so it advertises one more position than it has
      // members.
      const positions = own ? column.members.length : column.members.length + 1;
      for (let index = 0; index < positions; index++) {
        const rect = tiles[index];
        if (rect === undefined) continue;
        const zone: DropZone = { kind: "column-index", slot, index, rect };
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
  let bestScore = zoneScore(best.rect, pointer);
  for (const zone of zones.slice(1)) {
    const score = zoneScore(zone.rect, pointer);
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
    zoneScore(standing.rect, pointer),
    ZONE_HYSTERESIS_PX,
  )
    ? best
    : standing;
}
