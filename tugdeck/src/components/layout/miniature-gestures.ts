/**
 * miniature-gestures.ts — the arithmetic behind a hand on the Layout miniature.
 *
 * The overlay standing over the drawing takes presses on its blocks, its split
 * members and its rail members, and drags from any of them. What a press
 * DOES, and where in the picture each of the canvas's drop zones stands, are
 * decided here, as pure functions of the deck's snapshot and the drawing's
 * measured parts, so they can be checked without a DOM; the hook that owns
 * the gesture (`use-miniature-gestures.ts`) only reads the pointer and the
 * DOM and calls these.
 *
 * @module components/layout/miniature-gestures
 */

import { columnMoveOrder } from "@/deck-store-selectors";
import type { DeckState, TugPaneState } from "@/layout-tree";
import type { DropZone } from "@/lib/drop-zones";
import {
  clampFlowOffset,
  clampSlot,
  type SidebarSide,
} from "@/lib/layout-imposer";
import type { Rect } from "@/snap";

/**
 * How far a challenging zone must beat the incumbent before a drag on the
 * miniature moves its indication. The canvas's own margin is more than a whole
 * column in a drawing this small, so the picture passes its own.
 */
export const MINIATURE_ZONE_HYSTERESIS_PX = 3;

/**
 * What a hand landed on: a whole column block, one member of a split column,
 * or one member of a rail. Members carry their pane, because a member IS a
 * pane; a block names only its slot, because which of its stacked panes a
 * press reaches is the press's own question ({@link stackPressCardId}).
 */
export type MiniatureTarget =
  | { kind: "block"; slot: number }
  | { kind: "member"; slot: number; paneId: string }
  | { kind: "rail"; side: SidebarSide; paneId: string };

/**
 * The pane standing at the front of `slot`: the last pane in `state.panes`
 * whose clamped slot is `slot`. Panes are z-ordered by array position, end
 * highest, so the last one is the one the reader can see. `null` when the
 * slot is empty or nothing is imposed.
 */
export function frontPaneOfSlot(
  state: DeckState,
  slot: number,
): TugPaneState | null {
  const kind = state.imposition.kind;
  if (kind === undefined) return null;
  for (let i = state.panes.length - 1; i >= 0; i--) {
    const pane = state.panes[i];
    if (pane.slot !== undefined && clampSlot(kind, pane.slot) === slot) {
      return pane;
    }
  }
  return null;
}

/**
 * Every pane standing in `slot`, FRONT first — the slot's stack as the reader
 * meets it. Panes are z-ordered by array position, end highest, so this walks
 * `state.panes` backwards. Empty when the slot is empty or nothing is imposed.
 */
export function slotStackOf(
  state: DeckState,
  slot: number,
): readonly TugPaneState[] {
  const kind = state.imposition.kind;
  if (kind === undefined) return [];
  const stack: TugPaneState[] = [];
  for (let i = state.panes.length - 1; i >= 0; i--) {
    const pane = state.panes[i];
    if (pane.slot !== undefined && clampSlot(kind, pane.slot) === slot) {
      stack.push(pane);
    }
  }
  return stack;
}

/**
 * The pane the reader is IN, as the Layout card states it: the active pane
 * when it holds a slot, else the FRONTMOST pane that does — the card the
 * reader was in before they stepped into a rail, which is what "my card"
 * means while they are looking at the picture of the deck. `null` when no
 * pane holds a slot.
 *
 * One rule for the numbered pill the strip fills, the Key-inked face, and the
 * hover that says "you are here", so the three cannot name different cards.
 */
export function readerPaneIdOf(state: DeckState): string | null {
  const active = state.panes.find((p) => p.id === state.activePaneId);
  if (active?.slot !== undefined) return active.id;
  for (let i = state.panes.length - 1; i >= 0; i--) {
    if (state.panes[i].slot !== undefined) return state.panes[i].id;
  }
  return null;
}

/**
 * The card a press on a column block raises, or `null` for an empty slot.
 *
 * A press goes to the slot's FRONT pane. A press "in succession" — when the
 * miniature's last press raised this slot's front pane and nothing but the
 * Layout card has been active since, which the caller says by passing that
 * pane as `armedPaneId` — instead raises the slot's BOTTOM-MOST pane. That is
 * the ring `NEXT_STACK_CARD` makes: each raise sends the outgoing front pane
 * one place back, so a stack of depth N comes home after N presses. Raising
 * the second-from-top would ping-pong between two panes.
 *
 * A slot one pane deep never cycles: a second press re-raises the same card.
 */
export function stackPressCardId(
  state: DeckState,
  slot: number,
  armedPaneId: string | null,
): string | null {
  const front = frontPaneOfSlot(state, slot);
  if (front === null) return null;
  if (armedPaneId === front.id) {
    // Front-first for a stacked slot, so the bottom-most is the last entry.
    const order = columnMoveOrder(state, front.id);
    if (order.length >= 2) {
      const bottomId = order[order.length - 1];
      const bottom = state.panes.find((p) => p.id === bottomId);
      if (bottom !== undefined) return bottom.activeCardId;
    }
  }
  return front.activeCardId;
}

/**
 * The flow offset a drag on the window bracket has reached.
 *
 * The window is one band wide, and in the field it is `100 * flowScale`
 * percent wide — so a fraction `f` of the field is `f / flowScale` bands.
 * A hand that has moved `dxPx` across a field `fieldWidthPx` wide has
 * therefore slid the band by `(dxPx / fieldWidthPx) * bandPx / flowScale`
 * pixels of strip, clamped to the strip's ends as every flow offset is.
 *
 * `startOffset` comes back unchanged when there is no field or no scale to
 * measure against.
 */
export function windowDragOffset(input: {
  startOffset: number;
  dxPx: number;
  fieldWidthPx: number;
  bandPx: number;
  stripWidthPx: number;
  flowScale: number;
}): number {
  const { startOffset, dxPx, fieldWidthPx, bandPx, stripWidthPx, flowScale } =
    input;
  if (fieldWidthPx <= 0 || flowScale <= 0) return startOffset;
  return clampFlowOffset(
    startOffset + ((dxPx / fieldWidthPx) * bandPx) / flowScale,
    stripWidthPx,
    bandPx,
  );
}

/**
 * The drawing's parts a drop zone can be placed on, in px relative to the
 * overlay's padding box — the drawing's own padding box, which is the space
 * its drag ghost and offered place are drawn in.
 */
export interface MiniatureZoneParts {
  /** Each slot's full column rect: its block's frame. */
  slots: ReadonlyMap<number, Rect>;
  /** Each drawn rail strip. A side with no rail draws none. */
  rails: Partial<Record<SidebarSide, Rect>>;
}

/** A canvas zone, and where the picture stands it. */
export interface MiniatureZone {
  zone: DropZone;
  rect: Rect;
}

/**
 * Where in the picture each of the canvas's zones stands — one entry per zone
 * the picture draws.
 *
 * The zones are the canvas's own, enumerated and committed by the canvas; the
 * picture only gives each a rect, so a hand on the miniature chooses among
 * exactly the places a hand on the canvas could. The picture is not the canvas
 * at one scale — rails are drawn at a nominal width and an overflowing flow
 * strip is drawn whole — so no point mapping would do: each zone is placed on
 * the part that draws its place.
 *
 * Slot parts are first trimmed to their VISIBLE strip: where slot k+1's part
 * starts inside slot k's, as fit laps them, k's right edge is cut to k+1's
 * left. Otherwise a pointer on card k+1's leading strip stands inside both
 * rects and the centre tie-break can pick the buried card.
 *
 * - `slot`: the slot's trimmed rect.
 * - `column-index`: the slot's rect divided vertically into P equal bands, P
 *   being the number of `column-index` zones offered for that slot.
 * - `rail-index`: the side's strip divided the same way.
 * - `tab-bar`, and any zone whose slot or side has no part: omitted. A slot
 *   offers one kind of zone — positions or the whole slot — so bands never
 *   overlap a slot zone.
 */
export function miniatureZoneRects(
  zones: readonly DropZone[],
  parts: MiniatureZoneParts,
): readonly MiniatureZone[] {
  const ordered = [...parts.slots.entries()].sort((a, b) => a[0] - b[0]);
  const visible = new Map<number, Rect>();
  ordered.forEach(([slot, rect], i) => {
    const next = ordered[i + 1]?.[1];
    const right = rect.x + rect.width;
    const cut =
      next !== undefined && next.x > rect.x && next.x < right
        ? next.x - rect.x
        : rect.width;
    visible.set(slot, { ...rect, width: cut });
  });

  const columnCount = new Map<number, number>();
  const railCount = new Map<SidebarSide, number>();
  for (const zone of zones) {
    if (zone.kind === "column-index") {
      columnCount.set(zone.slot, (columnCount.get(zone.slot) ?? 0) + 1);
    } else if (zone.kind === "rail-index") {
      railCount.set(zone.side, (railCount.get(zone.side) ?? 0) + 1);
    }
  }
  const band = (rect: Rect, index: number, count: number): Rect => {
    const height = rect.height / count;
    return { x: rect.x, y: rect.y + index * height, width: rect.width, height };
  };

  const placed: MiniatureZone[] = [];
  for (const zone of zones) {
    switch (zone.kind) {
      case "slot": {
        const rect = visible.get(zone.slot);
        if (rect !== undefined) placed.push({ zone, rect });
        break;
      }
      case "column-index": {
        const rect = visible.get(zone.slot);
        const count = columnCount.get(zone.slot) ?? 0;
        if (rect !== undefined && count > 0) {
          placed.push({ zone, rect: band(rect, zone.index, count) });
        }
        break;
      }
      case "rail-index": {
        const rect = parts.rails[zone.side];
        const count = railCount.get(zone.side) ?? 0;
        if (rect !== undefined && count > 0) {
          placed.push({ zone, rect: band(rect, zone.index, count) });
        }
        break;
      }
      case "tab-bar":
        break;
    }
  }
  return placed;
}
