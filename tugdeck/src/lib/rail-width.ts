/**
 * rail-width.ts — the arithmetic of a sidebar rail's width, as one rail.
 *
 * Same-side cards share ONE rail, and a rail is one width ([D128]): the deck
 * reads a side's width as the widest of its members. So a width the hand gives
 * a rail is a width for every member at once, and the bounds the hand meets
 * are the rail's, not any one card's — the hard floor is the tightest member's
 * (any member's floor binds a rail that is one width), and the ceiling is the
 * allocator's slim content width, which no rail is ever granted past.
 *
 * Pure: `DeckManager.setRailWidth` commits through {@link withRailWidth} and
 * `DeckManager.railWidthLimits` answers through {@link railWidthLimitsOf}, so
 * the gesture reads the same bounds the allocator solves within rather than
 * deriving its own beside them.
 *
 * @module lib/rail-width
 */

import type { TugPaneState } from "../layout-tree";
import {
  travelFraction,
  type ImposedPlacement,
  type SidebarSide,
} from "./layout-imposer";

/** The widths a rail may stand at, in canvas layout px. `max >= min` always. */
export interface RailWidthLimits {
  readonly min: number;
  readonly max: number;
}

/**
 * A rail's bounds from its hard floor — the tightest member's, as the
 * allocator's `RailPolicy` folds it — and the allocator's ceiling. A floor
 * above the ceiling wins: a rail that cannot paint under its floor is never
 * squeezed below it by a cap.
 */
export function railWidthLimitsOf(
  floor: number,
  ceiling: number,
): RailWidthLimits {
  return { min: floor, max: Math.max(floor, ceiling) };
}

/** `width` held inside `limits`. */
export function clampRailWidth(width: number, limits: RailWidthLimits): number {
  return Math.min(limits.max, Math.max(limits.min, width));
}

/** The most a rail edge gives past a limit, however far the hand goes. */
export const RAIL_LIMIT_GIVE_PX = 48;

/** Where the hand has taken a rail, as the drag shows it. */
export interface RailWidthAim {
  /** The width the release commits: inside the limits, always. */
  readonly width: number;
  /** The width the edge is drawn at: `width`, or past a limit by the give. */
  readonly shown: number;
  /** The limit the hand is pressing past, or `null` between them. */
  readonly limit: "floor" | "ceiling" | null;
}

/**
 * The width the hand asks for, read against the rail's limits. Between them
 * the edge follows the hand exactly — there are no catches ([B13]). Past one,
 * the edge keeps following with diminishing returns, `give·d/(d+give)` for
 * an overshoot `d`, so it never reaches `RAIL_LIMIT_GIVE_PX` past the limit
 * and never stops dead; what the release commits is the limit itself.
 */
export function aimRailWidth(asked: number, limits: RailWidthLimits): RailWidthAim {
  const give = (d: number): number =>
    (RAIL_LIMIT_GIVE_PX * d) / (d + RAIL_LIMIT_GIVE_PX);
  if (asked > limits.max) {
    return { width: limits.max, shown: limits.max + give(asked - limits.max), limit: "ceiling" };
  }
  if (asked < limits.min) {
    return { width: limits.min, shown: limits.min - give(limits.min - asked), limit: "floor" };
  }
  return { width: asked, shown: asked, limit: null };
}

/**
 * `panes` with every member of one rail at `width`, and the members whose
 * width actually changed. A member whose width moves loses its width-preset
 * stamp, exactly as a hand-moved edge does on a single pane; a member already
 * standing at `width` is returned as the same object.
 */
export function withRailWidth(
  panes: readonly TugPaneState[],
  memberIds: ReadonlySet<string>,
  width: number,
): { panes: TugPaneState[]; resized: TugPaneState[] } {
  const resized: TugPaneState[] = [];
  const next = panes.map((pane) => {
    if (!memberIds.has(pane.id) || pane.size.width === width) return pane;
    const moved: TugPaneState = { ...pane, size: { ...pane.size, width } };
    delete moved.widthPreset;
    resized.push(moved);
    return moved;
  });
  return { panes: next, resized };
}

/**
 * The attribute an imposed element carries so a rail width preview can move
 * it without re-resolving the deck's styles: what its `left` is a function
 * of, as `imposeStyle` wrote it. Stamped by whoever called `imposeStyle` for
 * the element, from the same placement and slot width, so the preview and
 * the rest-state geometry are one derivation.
 */
export const RAIL_TRAVEL_ATTR = "data-rail-travel";

/**
 * The attribute a rail member's frame carries when its content reflows on a
 * pause rather than live (`railReflow: "pause"` in its registration): a
 * width drag holds that frame's body at its last laid-out width until the
 * hand rests.
 */
export const RAIL_REFLOW_ATTR = "data-rail-reflow";

/** How long the hand must rest before held rail content reflows. */
export const RAIL_REFLOW_PAUSE_MS = 80;

/**
 * What an imposed element's horizontal place depends on, besides the rail.
 * A FIT element stands at its slot's travel fraction of the band's slack over
 * its slot width; a FLOW element stands on the strip, under an offset the
 * band clamps.
 */
export type RailTravel =
  | { readonly kind: "fit"; readonly fraction: number; readonly slotWidth: number }
  | { readonly kind: "flow" };

/** The {@link RAIL_TRAVEL_ATTR} value for an element `imposeStyle` placed. */
export function railTravelOf(
  placement: ImposedPlacement,
  slotWidth: number,
): string {
  return placement.flow !== undefined
    ? "flow"
    : `fit:${travelFraction(placement)}:${slotWidth}`;
}

/** Read a {@link RAIL_TRAVEL_ATTR} value back, or `null` for one this did
 *  not write. */
export function parseRailTravel(value: string | null): RailTravel | null {
  if (value === "flow") return { kind: "flow" };
  if (value === null || !value.startsWith("fit:")) return null;
  const [, fraction, slotWidth] = value.split(":");
  const f = Number(fraction);
  const w = Number(slotWidth);
  if (!Number.isFinite(f) || !Number.isFinite(w)) return null;
  return { kind: "fit", fraction: f, slotWidth: w };
}

/** The band and the flow strip as they stood when the drag began. */
export interface RailTravelBand {
  /** The band's width — the canvas less both rails' insets and a gap at
   *  either end — at the rail's starting width. */
  readonly band: number;
  /** The flow strip's stored offset and full length, or `null` off flow. */
  readonly flow: { readonly offset: number; readonly strip: number } | null;
}

/**
 * How far an imposed element moves, in px, when the rail on `side` grows by
 * `growth` (negative when it narrows) — the difference between the `left`
 * `imposeStyle`'s expression resolves to at the two widths.
 *
 * A rail's growth is an inset on its own side and a band that much narrower.
 * The left inset moves everything that stands after it; the band moves only
 * what stands a fraction of the way across its slack (fit) or what the flow
 * offset's clamp lets back in (flow). Both `max(0, …)` terms and the flow
 * clamp are the expression's own, so an element pinned at the band's near
 * edge stays pinned.
 */
export function railTravelShift(
  travel: RailTravel,
  side: SidebarSide,
  start: RailTravelBand,
  growth: number,
): number {
  const insetShift = side === "left" ? growth : 0;
  const band = start.band - growth;
  if (travel.kind === "fit") {
    const slack = (b: number): number => Math.max(0, b - travel.slotWidth);
    return insetShift + travel.fraction * (slack(band) - slack(start.band));
  }
  if (start.flow === null) return insetShift;
  const { offset, strip } = start.flow;
  const clamped = (b: number): number => Math.min(offset, Math.max(0, strip - b));
  return insetShift - (clamped(band) - clamped(start.band));
}
