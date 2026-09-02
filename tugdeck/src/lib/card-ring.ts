/**
 * card-ring.ts — the deck's lateral card ring.
 *
 * Previous/Next Card walk one ring over every *visible* card position: each
 * tab of each pane the user can currently see. A pane is visible when it is
 * the front of its place — a slot, or a sidebar rail — or when it holds no
 * place at all (a free pane). Buried panes are the depth axis's territory
 * (Previous/Next Card in Stack).
 *
 * **The sidebars are on the ring, the rail included.** They are cards the
 * user reads and types in, standing in plain sight, so a lateral walk that
 * skipped them would leave the one card always on screen as the one the
 * keyboard could not reach. `move-to-slot` excludes the rail because a
 * sidebar takes no slot — that is a fact about slots, not a general rule
 * about sidebars, and reading it as one is what left the rail off this ring
 * while Jots rode it. A rail is a place exactly as a slot is ([D128]), so a
 * rail's front is a ring position exactly as a slot's front is.
 *
 * The ring's order is structural, read from deck state alone: left-rail
 * front, slotted fronts by slot number, free panes left-to-right by stored
 * position, right-rail front. Within a pane, tabs run in `cardIds` order.
 * Structural rather than measured so the same function can gate the menu
 * item (`visibleCardCount` in the menu-state projection) and drive the
 * step, and the two can never disagree.
 */

import type { DeckState, TugPaneState } from "@/layout-tree";
import { findSidebarPanes } from "@/deck-store-selectors";
import { isSidebarPinned, sidebarSide } from "@/lib/layout-imposer";

/** Every visible card position, in ring order. */
export function visibleCardRing(state: DeckState): readonly string[] {
  // A pinned sidebar pane's place is its rail; everything else is its slot,
  // or nothing. Same place taxonomy as the slot-stack picker's. A sidebar
  // dragged off its pin has no rail entry and falls through to `free`, which
  // is right — off the pin it is an ordinary pane.
  const railSideOf = new Map<string, "left" | "right">();
  for (const { componentId, pane } of findSidebarPanes(state)) {
    if (!isSidebarPinned(state.imposition, componentId)) continue;
    railSideOf.set(pane.id, sidebarSide(state.imposition, componentId));
  }

  // Front of each place = the last member in `panes` array order (z-top).
  const frontOfPlace = new Map<string, TugPaneState>();
  const free: TugPaneState[] = [];
  for (const pane of state.panes) {
    const railSide = railSideOf.get(pane.id);
    const place =
      railSide !== undefined
        ? `rail:${railSide}`
        : pane.slot === undefined
          ? undefined
          : `slot:${pane.slot}`;
    if (place === undefined) {
      free.push(pane);
      continue;
    }
    frontOfPlace.set(place, pane); // later members overwrite: last wins
  }

  const slotted = [...frontOfPlace.entries()]
    .filter(([place]) => place.startsWith("slot:"))
    .sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5)))
    .map(([, pane]) => pane);
  free.sort(
    (a, b) =>
      a.position.x - b.position.x ||
      a.position.y - b.position.y ||
      a.id.localeCompare(b.id),
  );

  const ordered: TugPaneState[] = [];
  const leftRail = frontOfPlace.get("rail:left");
  if (leftRail) ordered.push(leftRail);
  ordered.push(...slotted, ...free);
  const rightRail = frontOfPlace.get("rail:right");
  if (rightRail) ordered.push(rightRail);

  return ordered.flatMap((pane) => pane.cardIds);
}

/** The ring's size — the menu fact Previous/Next Card gate on. */
export function visibleCardCount(state: DeckState): number {
  return visibleCardRing(state).length;
}

/**
 * The card one step around the ring from `fromCardId`, or `null` when the
 * ring cannot answer: fewer than two positions, or a starting card that is
 * not on the ring (a buried pane's tab — stepping from nowhere would teleport
 * rather than move).
 */
export function stepCardRing(
  state: DeckState,
  fromCardId: string | null,
  direction: 1 | -1,
): string | null {
  const ring = visibleCardRing(state);
  if (ring.length < 2 || fromCardId === null) return null;
  const idx = ring.indexOf(fromCardId);
  if (idx === -1) return null;
  return ring[(idx + direction + ring.length) % ring.length];
}
