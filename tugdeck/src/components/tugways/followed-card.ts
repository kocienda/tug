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
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useFocusManager } from "@/components/tugways/use-focusable";

/** The followed card id, or `null` when none has been focused. */
export const FollowedCardContext = createContext<string | null>(null);

/** Track the last key card that is not `selfCardId` ([P11]). Runs once, in the
 *  tracking card's content component. */
export function useTrackFollowedCard(selfCardId: string): string | null {
  const focusManager = useFocusManager();
  const currentKey = useSyncExternalStore(
    useCallback(
      (cb: () => void) => focusManager?.subscribe(cb) ?? (() => {}),
      [focusManager],
    ),
    useCallback(() => focusManager?.keyCard() ?? null, [focusManager]),
  );
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (currentKey !== null && currentKey !== selfCardId) setLast(currentKey);
  }, [currentKey, selfCardId]);
  return last;
}

/** Read the enclosing card's followed card id from context. */
export function useFollowedCard(): string | null {
  return useContext(FollowedCardContext);
}
