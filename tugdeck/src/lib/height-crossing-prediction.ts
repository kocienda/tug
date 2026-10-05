/**
 * Which shown frames an arrangement change will resize — answered from the
 * store, before React commits it.
 *
 * The settle engine opens a still crossing (`lib/fold-crossing.ts`) on every
 * frame whose height tweens. Opened in the Last pass, that hold arrived after
 * the commit had already given the frame its new height: React runs a child's
 * layout effects before its parent's, so a Session card's transcript relaid
 * itself out at the new height, unheld, inside the very commit that planned
 * the motion. Opened at `arm` — in the store's notify, before the commit — the
 * frame change never reaches the interior at all. That needs the answer to
 * "which frames will change height" before there is a DOM to measure, and the
 * answer is a pure function of the arrangement: every frame's vertical terms
 * are written by the imposer from the deck record.
 *
 * So this compares, per pane, the vertical terms the pane would be imposed
 * with on each side of the change — the same calls `TugPane` makes, with the
 * same inputs the canvas's arrangement hands it — and the pane's folded flag,
 * which changes the frame's height by its own pin rather than by any term
 * here. The width, the strip offset and every horizontal term are left out,
 * because they move a frame without resizing it.
 *
 * Over-marking is bounded: a frame predicted here that turns out to carry no
 * height term in the Last pass has its hold ended there ([R02]). Missing one is
 * today's behaviour for that frame and no worse.
 */

import {
  imposeSidebarStyle,
  imposeStyle,
  type ColumnMemberPlacement,
  type ImposedPlacement,
  type PlaceStanding,
  type SidebarSide,
} from "./layout-imposer";

/** A rail member's standing, as the arrangement records it — the fields the
 *  rail's vertical pins are read from. */
export interface RailStandingForHeight {
  readonly side: SidebarSide;
  readonly count: number;
  readonly memberIndex: number;
  readonly standing: PlaceStanding;
  readonly strip?: readonly number[];
}

/** The pane fields a frame's height depends on. */
export interface PaneForHeight {
  readonly id: string;
  readonly slot?: number;
  readonly folded?: boolean;
  readonly size: { readonly height: number };
}

/**
 * The slice of the canvas's `LayerArrangement` a frame's vertical terms are
 * read from. The canvas's arrangement satisfies it as it stands, so the settle
 * engine is handed that value rather than a copy of how it is derived.
 */
export interface HeightArrangement<P extends PaneForHeight = PaneForHeight> {
  readonly bullseyePaneId: string | null;
  readonly stackByPaneId: ReadonlyMap<string, RailStandingForHeight>;
  readonly parkedRailSideByPaneId: ReadonlyMap<string, SidebarSide>;
  readonly arrivingSeatByPaneId: ReadonlyMap<string, "bottom" | "run">;
  readonly columnMemberByPaneId: ReadonlyMap<string, ColumnMemberPlacement>;
  readonly placementFor: (pane: P) => ImposedPlacement | undefined;
}

/** `top`, `bottom` and `height` of an imposed style, as one comparable string. */
function vertical(style: React.CSSProperties): string {
  return `${String(style.top ?? "")}|${String(style.bottom ?? "")}|${String(style.height ?? "")}`;
}

/**
 * The frame's vertical terms in `arr`, as one string, by the branch `TugPane`
 * takes: bullseye, a standing rail, a parked rail, an arrival at the column's
 * bottom, an imposed slot (its column share when it has one), or a free pane.
 * Widths are passed as zero because nothing vertical reads them.
 */
function verticalOf<P extends PaneForHeight>(arr: HeightArrangement<P>, pane: P): string {
  if (arr.bullseyePaneId === pane.id) {
    // Unlabelled, like a slot: bullseye takes the whole run, which is what an
    // undivided slot already holds, so entering it from one changes no height.
    return `run:${vertical(imposeStyle({ slot: 0, count: 1 }, 0))}`;
  }
  const stack = arr.stackByPaneId.get(pane.id);
  if (stack !== undefined) {
    const member =
      stack.count > 1
        ? {
            side: stack.side,
            index: stack.memberIndex,
            count: stack.count,
            standing: stack.standing,
            ...(stack.strip === undefined ? {} : { strip: stack.strip }),
          }
        : undefined;
    return `rail:${vertical(imposeSidebarStyle(stack.side, 0, member === undefined ? {} : { member }))}`;
  }
  const parked = arr.parkedRailSideByPaneId.get(pane.id);
  if (parked !== undefined) return `parked:${parked}`;
  const placement = arr.placementFor(pane);
  if (placement !== undefined) {
    if (arr.arrivingSeatByPaneId.get(pane.id) === "bottom") return "arriving";
    return `run:${vertical(
      imposeStyle(placement, 0, undefined, {
        member: arr.columnMemberByPaneId.get(pane.id),
      }),
    )}`;
  }
  return `free:${pane.size.height}`;
}

/**
 * The ids, among `panes`, whose frame height differs between `before` and
 * `after`: their imposed vertical terms differ, or their folded flag does.
 * `panes` pairs each pane as it stands before with how it stands after; a
 * pane absent from either side is a frame arriving or leaving, which the
 * settle carries by its own beats and which has no interior to hold here.
 */
export function predictHeightCrossings<P extends PaneForHeight>(
  before: HeightArrangement<P>,
  after: HeightArrangement<P>,
  panes: ReadonlyArray<{ readonly before: P; readonly after: P }>,
): string[] {
  const resized: string[] = [];
  for (const { before: b, after: a } of panes) {
    if ((b.folded === true) !== (a.folded === true)) {
      resized.push(a.id);
      continue;
    }
    if (verticalOf(before, b) !== verticalOf(after, a)) resized.push(a.id);
  }
  return resized;
}
