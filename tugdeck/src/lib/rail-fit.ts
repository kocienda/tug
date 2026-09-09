/**
 * rail-fit.ts — *Resize Sidebars to Fit*, the rail's one remaining algorithm.
 *
 * A rail is always divided and its sashes are the hand's ([B01], [B03]);
 * nothing moves them but a drag and this verb. The verb runs once when the
 * user invokes it, writes its answer as shares — the hand's from then on —
 * and nothing re-runs it: not a resize, not a content change, not a
 * membership change, not a relaunch ([B07]).
 *
 * Two things live here, in the order the verb needs them: what a card's
 * NATURAL is, read from the DOM at the moment of the verb, and how the run is
 * divided once the naturals are in hand.
 */

import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";

/**
 * Overview's natural, as a fraction of the run it stands in ([B10]).
 *
 * Overview is a stream: its rendered height is a function of the height it is
 * given, so it has no content height to read. It stands at three quarters of
 * the run — a fraction rather than a pixel constant, so the number means the
 * same thing on every display, and a fraction rather than the whole run, so
 * the rail's other cards keep their naturals beside it.
 */
export const OVERVIEW_RUN_FRACTION = 0.75;

/** What the arithmetic needs to know about one member of a rail. */
export interface FitMember {
  /** The member's hard floor, px — `getStackSizePolicy(…).min.height`. */
  readonly floor: number;
  /** The height the member's content asks for, px. */
  readonly natural: number;
}

/** The tolerance the proportions are shared out at. */
const FIT_EPSILON = 1e-9;

/**
 * The heights *Resize Sidebars to Fit* stands `members` at in `run`, seams
 * included — [B08]'s one formula in two regimes, both of which fill the run
 * exactly.
 *
 * WHEN THE NATURALS FIT, every member takes its natural plus a share of the
 * slack in proportion to that natural, so a card with more content gets more
 * of the room left over rather than the same slice as a card with two rows.
 *
 * WHEN THEY DO NOT, every member takes its floor plus a share of what remains
 * above the floors, in proportion to how far its natural stood above its own
 * floor — so the cards shrink together and none is squeezed under the floor
 * its policy declares.
 *
 * A natural below the member's own floor is read as the floor: the floor is
 * what the member can actually stand at, and reading anything smaller would
 * hand a member a share of the room it cannot use.
 *
 * The heights sum to the run less its seams, which is what
 * `sharedHeightsOf` divides and what `placeSharesFromHeights` inverts — so
 * the verb's answer converts to shares and allocates straight back out
 * ([P10]), exactly as a drag's does.
 */
export function fitHeights(
  members: readonly FitMember[],
  run: number,
  seam: number,
): number[] {
  const n = members.length;
  if (n === 0) return [];
  const gap = Number.isFinite(seam) && seam > 0 ? seam : 0;
  const divisible = run - (n - 1) * gap;
  const floors = members.map((member) =>
    Number.isFinite(member.floor) && member.floor > 0 ? member.floor : 0,
  );
  const wants = members.map((member, i) =>
    Number.isFinite(member.natural) ? Math.max(member.natural, floors[i]) : floors[i],
  );
  if (!Number.isFinite(divisible) || divisible <= 0) return floors;

  const wanted = wants.reduce((sum, want) => sum + want, 0);
  if (wanted <= divisible) {
    // The naturals fit: hand the slack out in proportion to them.
    const slack = divisible - wanted;
    if (wanted <= FIT_EPSILON) return wants.map(() => divisible / n);
    return wants.map((want) => want + (slack * want) / wanted);
  }

  // They do not: everyone to their floor, and what is left over goes out in
  // proportion to the room each one was asking for above its own floor.
  const floored = floors.reduce((sum, floor) => sum + floor, 0);
  const pool = divisible - floored;
  if (pool <= FIT_EPSILON) {
    // The floors alone do not fit. The place stands as a strip ([B06]) and
    // there is no division for the verb to write; the floors are what the
    // allocator itself answers here.
    return floors;
  }
  const asks = wants.map((want, i) => want - floors[i]);
  const asked = asks.reduce((sum, ask) => sum + ask, 0);
  if (asked <= FIT_EPSILON) return floors.map((floor) => floor + pool / n);
  return floors.map((floor, i) => floor + (pool * asks[i]) / asked);
}

/**
 * The height `componentId`'s card would stand at to show what it holds, read
 * from the DOM at the moment of the verb, or `null` when the card is not on a
 * rail to be read.
 *
 * The card's content element carries `data-card-content` — the one trace the
 * measured-height arc leaves ([B09]) — and its border-box height is what the
 * card has to show, a function of rail width and card data alone. What the
 * PANE needs on top of that is measured rather than assumed: the chrome above
 * and around the scroller is the difference between the pane's own box and
 * the scroller's client height, so a card whose title bar grows an accessory
 * row is read correctly without a constant here knowing about it.
 *
 * Overview is the exception and takes {@link OVERVIEW_RUN_FRACTION} of the
 * run ([B10]), because a stream has no content height to read.
 */
export function railNaturalOf(componentId: string, run: number): number | null {
  if (componentId === OVERVIEW_CARD_ID) return run * OVERVIEW_RUN_FRACTION;
  if (typeof document === "undefined") return null;
  const pane = document.querySelector(
    `.tug-pane[data-rail-member="${CSS.escape(componentId)}"]`,
  );
  if (pane === null) return null;
  const content = pane.querySelector("[data-card-content]");
  if (content === null) return null;
  const paneHeight = pane.getBoundingClientRect().height;
  const contentHeight = content.getBoundingClientRect().height;
  if (!(paneHeight > 0) || !(contentHeight >= 0)) return null;
  const scroller = scrollerAbove(content, pane);
  const shown = scroller === null ? paneHeight : scroller.clientHeight;
  const chrome = Math.max(0, paneHeight - shown);
  return contentHeight + chrome;
}

/**
 * The scrolling ancestor of `content` inside `pane`, or `null` when there is
 * none — the element whose client height is what the card actually shows, and
 * therefore what the chrome is measured against.
 */
function scrollerAbove(content: Element, pane: Element): Element | null {
  let node = content.parentElement;
  while (node !== null && node !== pane) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}
