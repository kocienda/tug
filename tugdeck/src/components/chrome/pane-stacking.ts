/**
 * pane-stacking.ts — who stands in front of whom.
 *
 * The deck's pane z-order has two halves, and both live here: the MAP — focus
 * order for the free panes, a ranked band for the rails, and the fixed tiers
 * the canvas's own chrome (margin caps, rail shadows, seams) takes around that
 * band — and the WRITER that lands a raise on the shown frames in the store
 * commit's own task, ahead of React. The canvas renders `zIndex` from the same
 * map, so the two can never disagree about the values; the writer only gets
 * there first.
 *
 * Nothing here is React state ([L06]): the map is a pure function of the deck,
 * and the writer is a synchronous store subscription that touches
 * `style.zIndex` on frames the canvas already owns ([L22]). The canvas calls
 * {@link usePaneRaise} once.
 *
 * @module components/chrome/pane-stacking
 */

import { type RefObject, useLayoutEffect } from "react";
import { findSidebarPanes } from "@/deck-store-selectors";
import type { IDeckManagerStore } from "@/deck-manager-store";
import type { DeckState } from "@/layout-tree";
import { revealPaneFrame } from "./pane-occlusion-controller";
import { SHOWN_PANE_FRAMES } from "./space-layer";

// ---- Card z-index base ----

/**
 * Z-index base for cards. Card at index i in deckState.cards gets
 * z-index CARD_ZINDEX_BASE + i.
 */
export const CARD_ZINDEX_BASE = 1;

/**
 * Z-index BAND for sidebar panes — the rails. A rail must sit ABOVE every free
 * pane (tiny array-order z, 1..N) so it is never occluded by a card, yet
 * strictly BELOW the canvas-overlay base (`--tug-z-overlay-base` = 9000) into
 * which every popup/menu/tooltip — including a rail card's own `…` menu and
 * its popovers — portals. A naive "always on top" z above 9000 would bury
 * those popups behind the rail. 8999 is the tier the former dev-panel overlay
 * used, and the band is the nine values below it.
 *
 * It has to be a band rather than the single value it was when one card was the
 * only rail: **same-side sidebars stand front-to-back**, so the two of them have
 * to be orderable against each other. Within the band they take the deck's own
 * z-order — array position, the thing `activateCard` moves — which is what makes
 * the title bar's stack picker able to bring the covered one forward. One fixed
 * value for every rail would have pinned whichever card happened to hold it on
 * top forever, and with two identical rects that is a card you can never reach.
 */
export const SIDEBAR_PANE_ZINDEX_BASE = 8990;

/**
 * Z for the margin caps — the two elements covering the five pixels a rail
 * stands off the window edge and therefore cannot cover itself.
 *
 * It has to be ABOVE every free card, because covering a card travelling out
 * past the band edge is the whole job, and free cards take a tiny array-order
 * z (1..N). And it has to be strictly BELOW the rail band, because the rail is
 * what actually occludes the card and a cap painting over a rail's own margin
 * edge would put canvas ground on top of chrome. One below the band's base is
 * both, with no arithmetic over the deck's card count. [B02]
 */
export const MARGIN_CAP_ZINDEX = SIDEBAR_PANE_ZINDEX_BASE - 1;

/**
 * Z for the rail shadows, deliberately the margin cap's own layer: above
 * every free card and strictly below the rail band. The shadow's whole job is
 * to darken the card sliding under it, so it must outrank cards; and it must
 * stay below the rails so a rail's own ink is never shaded by the panel it
 * belongs to.
 */
export const RAIL_SHADOW_ZINDEX = MARGIN_CAP_ZINDEX;

/** The most rails the band can order before it would collide with the overlay
 *  base. Far past any real deck; the clamp is here so it cannot ever collide.
 *
 *  Eight rather than nine, and 8999 is free again. The top of the ten values
 *  under the overlay base was the canvas tier the departing workspace stood at
 *  for the length of one switch, and the cut retired both that tier and the
 *  layer that spent it ([B01]). So the reason the band gave the
 *  value up is gone, and the clamp stays at 8 anyway: nothing needs the ninth
 *  rank, because no deck has ever stood two rails a side, let alone nine.
 *  Raising it would be a change with no caller asking for it, and would spend
 *  the one value a future canvas tier could have. */
export const SIDEBAR_PANE_ZINDEX_MAX_RANK = 8;

/**
 * The seam between two split rail members, level with the frontmost rank a rail
 * can reach and still strictly below every popup.
 *
 * It has to be stated rather than left to document order, because the seam's
 * hit strip is wider than the 5px gap it sits in and therefore overlaps each
 * neighbouring frame by about 2.5px. Below the band, a press in that overlap
 * would land on the frame instead and the seam would be undraggable along the
 * edges that matter most.
 */
export const RAIL_SEAM_ZINDEX =
  SIDEBAR_PANE_ZINDEX_BASE + SIDEBAR_PANE_ZINDEX_MAX_RANK;

/**
 * A deck's pane z-order: focus order for the free panes, the band for the rails.
 *
 * Taken out of the shown workspace's memo because a HIDDEN workspace needs the
 * same answer now. It used to need none — every pane of a workspace nobody was
 * looking at could take one flat value, because `display: none` paints none of
 * them. Then the switch dissolve put the departing workspace on screen, opaque
 * and on top, for a beat ([B09]): flat, its own rail would have been painted
 * over by whichever of its own cards happened to sort after it, and the first
 * frame of the dissolve — the one that is supposed to be indistinguishable
 * from the last frame before it — would have restacked the workspace the
 * reader was looking at a moment ago.
 */
export function buildZIndexMap(
  panes: readonly { id: string }[],
  sidebarPaneIds: ReadonlySet<string>,
): Map<string, number> {
  // Rails are ranked among themselves, in the deck's own array order, so a
  // raise inside the band actually moves one in front of the other.
  const railRank = new Map<string, number>();
  for (const pane of panes) {
    if (sidebarPaneIds.has(pane.id)) railRank.set(pane.id, railRank.size);
  }
  const map = new Map<string, number>();
  panes.forEach((pane, i) => {
    const rank = railRank.get(pane.id);
    map.set(
      pane.id,
      rank === undefined
        ? CARD_ZINDEX_BASE + i
        : SIDEBAR_PANE_ZINDEX_BASE +
          Math.min(rank, SIDEBAR_PANE_ZINDEX_MAX_RANK),
    );
  });
  return map;
}

/** A deck's pane z-order, as its arrangement renders it. */
export function paneZIndexMap(deck: DeckState): Map<string, number> {
  return buildZIndexMap(
    deck.panes,
    new Set(findSidebarPanes(deck).map(({ pane }) => pane.id)),
  );
}

/**
 * The pane-raise writer.
 *
 * The raise lands in the commit's own task. A press that brings a pane
 * forward defers its React commit past the next paint (`mayDeferCommit`),
 * and the rendered `zIndex` would follow it — so a pane pressed from under
 * its neighbour would travel under it for a frame before popping forward.
 * Stacking is appearance the user is looking straight at, so it is written
 * here, from the store, as the flow offset is ([L22]); React's later commit
 * renders the same values. A frame that comes forward is revealed with it,
 * since the occlusion pass that would otherwise reveal it is behind the
 * same deferral.
 */
export function usePaneRaise(
  deckRootRef: RefObject<HTMLDivElement | null>,
  store: IDeckManagerStore,
): void {
  useLayoutEffect(() => {
    const raise = (): void => {
      const root = deckRootRef.current;
      if (root === null) return;
      const zIndexMap = paneZIndexMap(store.getSnapshot());
      for (const frame of root.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
        const z = zIndexMap.get(frame.dataset.paneId ?? "");
        if (z === undefined) continue;
        const was = parseInt(frame.style.zIndex, 10);
        if (was === z) continue;
        frame.style.zIndex = String(z);
        if (!(was > z)) revealPaneFrame(frame);
      }
    };
    return store.subscribeSync?.(raise, "pane-raise") ?? (() => {});
  }, [deckRootRef, store]);
}
