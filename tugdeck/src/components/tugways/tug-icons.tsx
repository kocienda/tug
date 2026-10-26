/**
 * Tug-authored glyphs — icons drawn for Tug that have no lucide equivalent,
 * expressed in lucide's own icon-node data format so they travel every path a
 * lucide icon travels.
 *
 * lucide covers the vocabulary until it doesn't: `operator` is the assistant
 * `Bot` wearing a headset, a mark lucide has no glyph for (its `Headset` is a
 * bare human headset, its `Bot` has no mic). Rather than hand-rolling an
 * `<svg>` at the call site, the geometry lands here as a `LucideIconNode` —
 * the same `[[tag, attrs], …]` shape `lucide` exports — so it can be handed to
 * {@link TugSpriteIcon} and rendered as `<svg><use/></svg>` against a symbol
 * defined once. That is the transcript-scale contract: a participant icon
 * repeated across thousands of rows costs 2 DOM nodes per row, not 9.
 *
 * Drawn on lucide's 24×24 grid with lucide's stroke conventions (2px, round
 * cap and join, `currentColor`), so it sits beside `Bot`/`User`/`Shell` in the
 * transcript gutter without reading as foreign. The head outline carries an
 * explicit 1.7 `stroke-width`: the glyph packs a headset around a head on the
 * same grid lucide gives the head alone, and the lighter outline keeps the
 * interior from filling in at 20px. Per-element attributes in the symbol
 * override the instance `<svg>`'s inherited stroke width.
 *
 * @module components/tugways/tug-icons
 */

import React from "react";

import {
  TugSpriteIcon,
  type LucideIconNode,
} from "@/components/tugways/tug-sprite-icon";

/**
 * `operator` — bot head with headset and boom mic.
 *
 * Antenna, head, and two eye ticks are the `Bot` silhouette; the earcups and
 * the mic boom hanging under the chin are the headset. The boom's horizontal
 * run clears the jaw by a full grid unit so the two strokes stay separate at
 * icon sizes.
 */
export const operatorIconNode: LucideIconNode = [
  // Antenna: stem up out of the head, flag to the left.
  ["path", { d: "M12 6.4V3.4H8" }],
  // Head.
  [
    "rect",
    { width: 12, height: 11, x: 6, y: 6.9, rx: 2, "stroke-width": 1.7 },
  ],
  // Eyes.
  ["path", { d: "M9.5 11.4v2" }],
  ["path", { d: "M14.5 11.4v2" }],
  // Earcups.
  ["rect", { width: 3, height: 6, x: 2.5, y: 9.4, rx: 1.5 }],
  ["rect", { width: 3, height: 6, x: 18.5, y: 9.4, rx: 1.5 }],
  // Mic boom: down off the right earcup, around, and in under the chin.
  ["path", { d: "M20.2 15.6v2.5a2.5 2.5 0 0 1-2.5 2.5h-3" }],
];

/**
 * Tug glyph registry, keyed by icon name. A consumer that resolves icons from
 * a string (the `icons[name]` lucide lookup in `tug-pane`, `tug-tab-bar`,
 * `tug-sheet`, …) can consult this first and fall through to lucide.
 */
export const TUG_ICON_NODES: Record<string, LucideIconNode> = {
  operator: operatorIconNode,
};

export interface TugGlyphProps {
  /** Width/height in px — matches lucide's `size` prop. Default 24. */
  size?: number;
  className?: string;
  "aria-hidden"?: React.AriaAttributes["aria-hidden"];
}

/**
 * `operator` as a drop-in for a lucide component — same call shape as
 * `<Bot size={20} />`, sprite-backed underneath.
 */
export function Operator(props: TugGlyphProps): React.ReactElement {
  return <TugSpriteIcon name="operator" node={operatorIconNode} {...props} />;
}
