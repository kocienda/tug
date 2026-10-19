/**
 * What a body publishes about its session for the devtools card that
 * follows it, and only while one does.
 *
 * The telemetry inspector reads a session's fields and its reducer's
 * live-clock anchors, which live in the page that holds the card. When the
 * card is a body and the devtools card is another, the shell says so
 * (`card.inspected`); {@link installInspectionPublisher} then sets the
 * card's `card.inspection` on each change of its session, and the store
 * sends only a value that moved, so a stream delta that moves none of the
 * fields the inspector draws sends nothing. When the shell says no devtools
 * card follows any more, it is released and the inspection goes to null.
 *
 * The session store is rebuilt when the card rebinds, so the subscription
 * follows the services store, as the body publisher's does.
 *
 * @module body/body-inspection
 */

import { cardInspection } from "../bus/declarations/card";
import { cardServicesStore } from "../lib/card-services-store";
import { relayableInspection } from "../lib/telemetry-inspection-store";

/**
 * Publish `cardId`'s inspection on every change until released. A card with
 * no session publishes `null` once, so the inspector it feeds shows no card
 * rather than the last card's.
 */
export function installInspectionPublisher(cardId: string): () => void {
  const publish = (): void => {
    const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
    cardInspection.set(store === null ? null : relayableInspection(cardId, store));
  };
  let releaseSession: (() => void) | null = null;
  let watched: unknown = null;
  const follow = (): void => {
    const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
    if (store === watched) return;
    releaseSession?.();
    watched = store;
    releaseSession = store === null ? null : store.subscribe(publish);
  };
  const releaseServices = cardServicesStore.subscribe(() => {
    follow();
    publish();
  });
  follow();
  publish();
  return () => {
    releaseServices();
    releaseSession?.();
    cardInspection.set(null);
  };
}
