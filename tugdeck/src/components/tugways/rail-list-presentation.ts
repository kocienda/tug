/**
 * rail-list-presentation.ts — the rail cards' one-line lists, tuned in one
 * place.
 *
 * Every one-line list a sidebar card shows is the same kind of surface: a dense
 * index of one-line handles, stacked in a narrow column, read by scanning
 * rather than by dwelling. They must therefore agree on how a row is separated
 * from its neighbour and how big its text is — two lists in one rail that
 * disagree on either read as a layout accident.
 *
 * Everything below is live under HMR: change a number, look at the rail.
 */

import type {
  TugListViewRowSeparator,
  TugListViewRowStriping,
} from "@/components/tugways/tug-list-view";

// ===========================================================================
// TUNE HERE — alternating row color
// ===========================================================================
//
// The band is a wash of the surface's own text color, so the same number reads
// correctly on the dark themes (a light band) and the light ones (a dark band).
// It goes on odd rows; row 0 always sits on the host surface.
//
// Every option, in full:
//
//   "none"                  OFF. No banding — and the row hairlines come back
//                           automatically (see `separatorFor` below).
//   { strength: 2 }         2% wash — "faint"   ┐ any number is legal, and the
//   { strength: 4 }         4% wash — "subtle"  │ interesting range is roughly
//   { strength: 7 }         7% wash — "medium"  │ 1.5–14; below 1.5 it stops
//   { strength: 11 }       11% wash — "strong"  ┘ reading, above ~14 it stripes
//                                                 louder than the selection.
//   "faint" | "subtle" | "medium" | "strong"
//                           The same four values by name (2 / 4 / 7 / 11).
//   { color: "…" }          Skip the wash entirely and paint an explicit color
//                           or token — e.g.
//                           "var(--tug7-surface-global-primary-normal-content-rest)".
//
// Fractional values work: `{ strength: 5.5 }` is a real setting.
//
const ROW_STRIPING: TugListViewRowStriping = { strength: 4 };

// ===========================================================================
// TUNE HERE — row text size, in px
// ===========================================================================
//
// One measure for every row in every rail list; it outranks each label's own
// size.
// 13 is the app's default row text; 12 is roughly BBEdit's list scale; 11 is
// as small as the incipits stay comfortable.
//
// Note this no longer changes row HEIGHT: the row bottoms out at 30px on its
// accessories (the 24px leading close box), not on its type.
//
const ROW_TEXT_SIZE = 12;

// ===========================================================================
// Row HEIGHT is the one knob that has to be CSS — it is the row component's
// own token and the list passes it down by cascade. It lives on
// `.lens-oneline-list` in `lens-content.css`.
// ===========================================================================

/** Presentation props shared by the rail cards' one-line lists. */
export interface RailListPresentation {
  rowStriping: TugListViewRowStriping;
  rowSeparator: TugListViewRowSeparator | undefined;
  rowTextSize: number;
}

/**
 * Banding and hairlines separate rows the same way, so exactly one of them is
 * ever on: striping carries the separation when striping is on, and the flush
 * layout's own hairline — what `undefined` leaves in place — carries it when
 * striping is off. Derived rather than set, so turning the striping knob to
 * `"none"` puts the lines back without a second edit.
 */
function separatorFor(
  striping: TugListViewRowStriping,
): TugListViewRowSeparator | undefined {
  return striping === "none" ? undefined : "none";
}

export const RAIL_LIST_PRESENTATION: RailListPresentation = {
  rowStriping: ROW_STRIPING,
  rowSeparator: separatorFor(ROW_STRIPING),
  rowTextSize: ROW_TEXT_SIZE,
};
