/**
 * followed-card.ts — the "last key card that is not this one", tracked by a
 * rail card and shared with whatever inside it needs to know.
 *
 * Because focusing a rail card makes *it* the key card, a surface that wants
 * "the card I'm working in" must remember the previous key card that is not
 * itself ([P11]). Tracking it in the surface that asks is wrong: those mount
 * and unmount as levels and lists come and go, so a fresh tracker misses
 * history. The card's own content component — mounted for the whole time its
 * pane is open — runs the single tracker and publishes the result through this
 * context, so every reader inside the card agrees.
 *
 * @module components/tugways/followed-card
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { useFocusManager } from "@/components/tugways/use-focusable";
import { getDeckStore } from "@/lib/deck-store-registry";

/** The followed card id, or `null` when none has been focused. */
export const FollowedCardContext = createContext<string | null>(null);

/** Track the last key card that is not `selfCardId` ([P11]). Runs once, in the
 *  tracking card's content component.
 *
 *  The history lives beside the subscription that hears it, and the snapshot
 *  is the remembered card — so a key change is one commit through the door,
 *  where copying the key into state from an effect cost a second.
 *
 *  In a body the page's focus manager knows one card, its own, so the deck
 *  store answers instead (`getFollowedCardId`): the shell tracks the key card
 *  and says which card this one follows. */
export function useTrackFollowedCard(selfCardId: string): string | null {
  const focusManager = useFocusManager();
  const deck = getDeckStore();
  const bridged = deck?.getFollowedCardId;
  const lastRef = useRef<string | null>(null);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (deck !== null && bridged !== undefined) return deck.subscribe(() => onStoreChange());
      if (focusManager === null) return () => {};
      const remember = (): void => {
        const key = focusManager.keyCard();
        if (key !== null && key !== selfCardId) lastRef.current = key;
      };
      // The key card at subscribe time is history too; React re-reads the
      // snapshot after subscribing, so a mount-time key still renders.
      remember();
      return focusManager.subscribe(() => {
        remember();
        onStoreChange();
      });
    },
    [focusManager, selfCardId, deck, bridged],
  );
  return useSyncExternalStore(subscribe, () => (bridged !== undefined ? bridged() : lastRef.current));
}

/** Read the enclosing card's followed card id from context. */
export function useFollowedCard(): string | null {
  return useContext(FollowedCardContext);
}
