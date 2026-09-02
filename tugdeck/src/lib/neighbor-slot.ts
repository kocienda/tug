/**
 * neighbor-slot.ts — where a card opened *from* another card lands.
 *
 * One rule, shared by every opener that spawns a card on a reader's behalf:
 * the new card belongs beside the card that named it. Opening at the first
 * slot can put it a whole deck away from the passage being read.
 *
 * Callers: `open-file-in-card.ts` (a path from a link, ⌘O, Open Quickly, a
 * drop) and the `resume-session` handler in `action-dispatch.ts` (a session
 * named by an identity row's menu).
 *
 * @module lib/neighbor-slot
 */

import type { IDeckManagerStore } from "@/deck-manager-store";
import { slotCount } from "./layout-imposer";

/**
 * The slot a card opened from `originCardId` lands in: the slot immediately to
 * its left, or — when the origin is already leftmost — the one immediately to
 * its right.
 *
 * `undefined` is "no opinion, take the default slot": no arrangement is up, the
 * arrangement has one slot, or the originating card holds no slot of its own (a
 * sidebar card such as the rail, or a free-floating pane).
 */
export function neighborSlot(
  store: IDeckManagerStore,
  originCardId: string | null,
): number | undefined {
  if (originCardId === null) return undefined;
  const deck = store.getSnapshot();
  const kind = deck.imposition.kind;
  if (kind === undefined || slotCount(kind) < 2) return undefined;
  const host = deck.panes.find((p) => p.cardIds.includes(originCardId));
  if (!host || host.slot === undefined) return undefined;
  return host.slot > 0 ? host.slot - 1 : 1;
}
