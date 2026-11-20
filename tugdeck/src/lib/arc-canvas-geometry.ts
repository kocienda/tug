/**
 * arc-canvas-geometry.ts — where the arc shade's four cards stand, and the
 * lines between them.
 *
 * The arc shade shows an arc's history as four cards on a free canvas, in the
 * order the work passed through them: Idea, Sketch, Brief, Arc. Each can be
 * dragged anywhere on the canvas and opened wider, and a connector joins each
 * card's out port to the next card's in port. Everything here is the pure
 * arithmetic of that: no React, no DOM, no I/O.
 *
 * Also here is the shape the canvas is remembered in, one record per arc,
 * and its parser. The record is stored in tugbank under
 * {@link ARC_CANVAS_DOMAIN}, keyed by the arc's name, through the same
 * defaults path every card-level setting takes.
 *
 * @module lib/arc-canvas-geometry
 */

import type { TaggedValue } from "@/lib/tugbank-client";

/** The four cards, in the order the connectors join them. */
export const ARC_CANVAS_RUNGS = ["idea", "sketch", "brief", "arc"] as const;

/** One of the canvas's four cards. */
export type ArcCanvasRung = (typeof ARC_CANVAS_RUNGS)[number];

/** A connector's reading, and its ports': nothing to join yet, in step, or out of step. */
export type ArcCanvasLinkState = "pending" | "linked" | "changed";

/** A point on the canvas, in layout pixels from its top left corner. */
export interface ArcCanvasPoint {
  readonly x: number;
  readonly y: number;
}

/** A card as it stands on the canvas: its top left corner and its width. */
export interface ArcCanvasCardRect extends ArcCanvasPoint {
  readonly w: number;
}

/** Where every card stands and which are open. */
export interface ArcCanvasState {
  readonly positions: Readonly<Record<ArcCanvasRung, ArcCanvasPoint>>;
  readonly expanded: Readonly<Record<ArcCanvasRung, boolean>>;
}

/** A card's width at rest. */
export const ARC_CARD_WIDTH = 200;
/** A card's width when it is open. */
export const ARC_CARD_WIDTH_EXPANDED = 440;
/** How far down a card's edge its ports are centred. */
export const ARC_PORT_Y = 64;
/** The clear space the canvas keeps beyond its rightmost and lowest card. */
export const ARC_CANVAS_PAD = 16;
/** The least a connector's control points reach out from its ports. */
const MIN_REACH = 28;

/** tugbank domain for the remembered canvas, keyed by arc name. */
export const ARC_CANVAS_DOMAIN = "dev.tugapp.arc-canvas";

/**
 * The tidy layout: a row in the ladder's order, Idea and Brief a step lower
 * than Sketch and Arc so that every connector curves.
 */
export function arcCanvasHomePositions(): Record<ArcCanvasRung, ArcCanvasPoint> {
  return {
    idea: { x: 16, y: 40 },
    sketch: { x: 272, y: 16 },
    brief: { x: 528, y: 40 },
    arc: { x: 784, y: 16 },
  };
}

/**
 * The canvas a fresh arc opens on: every card at home, and the Arc card open,
 * since it is the one carrying the arc's reading and its verbs.
 */
export function arcCanvasDefaultState(): ArcCanvasState {
  return {
    positions: arcCanvasHomePositions(),
    expanded: { idea: false, sketch: false, brief: false, arc: true },
  };
}

/**
 * Keep a card on the canvas. The canvas has a top and a left edge and grows
 * to the right and downward to hold wherever a card is put, so a card is
 * held at those two edges and nowhere else. A coordinate that is not a
 * finite number is the edge.
 */
export function clampToArcCanvas(point: ArcCanvasPoint): ArcCanvasPoint {
  const hold = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
  return { x: hold(point.x), y: hold(point.y) };
}

/** A card's width for whether it is open. */
export function arcCardWidth(expanded: boolean): number {
  return expanded ? ARC_CARD_WIDTH_EXPANDED : ARC_CARD_WIDTH;
}

/**
 * Where each card is drawn. A card is drawn where it stands, moved right by
 * what every open card standing to its left has grown, so opening a card
 * pushes the cards to its right along rather than covering them.
 */
export function layoutArcCanvas(state: ArcCanvasState): Record<ArcCanvasRung, ArcCanvasCardRect> {
  const growth = ARC_CARD_WIDTH_EXPANDED - ARC_CARD_WIDTH;
  const shown = {} as Record<ArcCanvasRung, ArcCanvasCardRect>;
  for (const rung of ARC_CANVAS_RUNGS) {
    const at = state.positions[rung];
    let pushed = 0;
    for (const other of ARC_CANVAS_RUNGS) {
      if (other !== rung && state.expanded[other] && state.positions[other].x < at.x) pushed += growth;
    }
    shown[rung] = { x: at.x + pushed, y: at.y, w: arcCardWidth(state.expanded[rung]) };
  }
  return shown;
}

/**
 * The connector from one card's out port to the next card's in port, as an
 * SVG path: a cubic that leaves the first card's right edge level and arrives
 * at the second's left edge level, whichever way the two stand.
 */
export function arcConnectorPath(from: ArcCanvasCardRect, to: ArcCanvasCardRect): string {
  const x1 = from.x + from.w;
  const y1 = from.y + ARC_PORT_Y;
  const x2 = to.x;
  const y2 = to.y + ARC_PORT_Y;
  const reach = Math.max(MIN_REACH, Math.abs(x2 - x1) / 2);
  return `M${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`;
}

/**
 * The canvas's size: far enough right and down to hold every card as drawn,
 * and the clear space beyond. `heights` are the cards' measured heights.
 */
export function arcCanvasExtent(
  shown: Readonly<Record<ArcCanvasRung, ArcCanvasCardRect>>,
  heights: Readonly<Record<ArcCanvasRung, number>>,
): { width: number; height: number } {
  let right = 0;
  let bottom = 0;
  for (const rung of ARC_CANVAS_RUNGS) {
    right = Math.max(right, shown[rung].x + shown[rung].w);
    bottom = Math.max(bottom, shown[rung].y + heights[rung]);
  }
  return { width: right + ARC_CANVAS_PAD, height: bottom + ARC_CANVAS_PAD };
}

/**
 * Read a remembered canvas out of a tugbank value. A missing or malformed
 * card falls back to its default, and a card remembered off the canvas is
 * brought back onto it; an absent or non-json entry is `null`.
 */
export function parseArcCanvasState(entry: TaggedValue | undefined): ArcCanvasState | null {
  if (entry?.kind !== "json" || typeof entry.value !== "object" || entry.value === null) return null;
  const stored = entry.value as { positions?: unknown; expanded?: unknown };
  const positions = (typeof stored.positions === "object" && stored.positions !== null
    ? stored.positions
    : {}) as Record<string, unknown>;
  const expanded = (typeof stored.expanded === "object" && stored.expanded !== null
    ? stored.expanded
    : {}) as Record<string, unknown>;
  const fallback = arcCanvasDefaultState();
  const outPositions = {} as Record<ArcCanvasRung, ArcCanvasPoint>;
  const outExpanded = {} as Record<ArcCanvasRung, boolean>;
  for (const rung of ARC_CANVAS_RUNGS) {
    const at = positions[rung] as { x?: unknown; y?: unknown } | null | undefined;
    outPositions[rung] =
      typeof at === "object" && at !== null && typeof at.x === "number" && typeof at.y === "number"
        ? clampToArcCanvas({ x: at.x, y: at.y })
        : fallback.positions[rung];
    const open = expanded[rung];
    outExpanded[rung] = typeof open === "boolean" ? open : fallback.expanded[rung];
  }
  return { positions: outPositions, expanded: outExpanded };
}
