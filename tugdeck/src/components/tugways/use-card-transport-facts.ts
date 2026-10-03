/**
 * `useCardTransportFacts` — one card, as an arc's transport verbs read it.
 *
 * The transport's resolution is pure ({@link resolveTransportActor}, Table
 * T02), so everything live is gathered here: the session and project the
 * card's binding names, the name a refusal would call it by, and the arc it is
 * already running. `runningArc` is a **live** reading — an arc that is done,
 * or one somebody stopped, is not work this card is doing, and the server's
 * own `bind` would bind over either — so a card sitting on a stopped arc still
 * accepts a Start.
 *
 * Two surfaces ask it about different cards: the Arcs card about the card it
 * follows, a Changes shade about the card it belongs to — where a Start or a
 * Resume falls through to when no card holds the arc.
 *
 * Laws: [L02] every input enters through `useSyncExternalStore`.
 *
 * @module components/tugways/use-card-transport-facts
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { useChangesetAll } from "@/lib/changeset-all-store";
import { arcSessionIndex } from "@/lib/arc-session-index";
import { isLiveRun, type FollowedCardFacts } from "@/lib/arc-transport";
import { sessionDisplayTitle, useSessionIdentity } from "@/lib/session-identity";

/** The card's transport facts, or null when there is no card or it holds no
 *  session. */
export function useCardTransportFacts(
  cardId: string | null,
): FollowedCardFacts | null {
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  const binding = cardId !== null ? bindings.get(cardId) : undefined;
  const identity = useSessionIdentity(binding?.tugSessionId ?? null);
  const index = arcSessionIndex(useChangesetAll());
  if (cardId === null || binding === undefined) return null;
  const fact = index.get(binding.tugSessionId) ?? null;
  return {
    cardId,
    tugSessionId: binding.tugSessionId,
    projectDir: binding.projectDir,
    cardName:
      identity !== null ? sessionDisplayTitle(identity) : binding.tugSessionId,
    runningArc: fact !== null && isLiveRun(fact.arc) ? fact.name : null,
  };
}
