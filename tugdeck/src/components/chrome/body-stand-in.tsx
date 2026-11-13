/**
 * BodyStandIn — the shell's mark for a body card whose own page has not
 * painted: a frame at the pane's rect that paints nothing.
 *
 * Every card draws its chrome in its own page ([D216]), and while that page
 * has not painted — being made, evicted and asked for again, or on a
 * workspace nobody has shown — the host stands the card's picture in its
 * workspace's stage, above the shell: its last frame, or a skeleton it draws
 * from the card's placement in its workspace's palette, wearing the deck's
 * progress wave while the card loads (`tugapp/Sources/BodyStages.swift`). So
 * the shell draws nothing here; the frame stands only as the shell's record
 * of a card still waiting on its page, marked `data-body-stand-in`, which is
 * what the shell's own census reads (`at0747`).
 *
 * When it stands is `lib/body-stand-in-store.ts`'s, and a card not yet a body
 * card at all — on a workspace whose pages have not been handed off — stands
 * too. It answers no point and takes no focus, so a press reaches the shell's
 * pane as it does with no stand-in.
 *
 * Laws: [L02] every store is read through `useSyncExternalStore`; [L06]
 * nothing here is appearance — the picture is the host's.
 *
 * @module components/chrome/body-stand-in
 */

import React from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { bodyStandInStore } from "@/lib/body-stand-in-store";
import { bodyCardsStore } from "@/lib/body-cards-store";

export interface BodyStandInProps {
  cardId: string;
  componentId: string;
}

/** The card's paintless stand-in while its page has not painted, or nothing once it has. */
export function BodyStandIn({ cardId }: BodyStandInProps): React.ReactElement | null {
  const standing = useSyncExternalStore(bodyStandInStore.subscribe, () => bodyStandInStore.standing(cardId));
  const notHandedOff = useSyncExternalStore(bodyCardsStore.subscribe, () => !bodyCardsStore.has(cardId));
  if (!standing && !notHandedOff) return null;
  return <div className="tug-body-stand-in" data-body-stand-in aria-hidden="true" inert />;
}
