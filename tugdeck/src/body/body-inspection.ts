/**
 * What a body publishes about its session for the devtools card that
 * follows it, and only while one does.
 *
 * The telemetry inspector reads a session's fields and its reducer's
 * live-clock anchors, which live in the page that holds the card. When the
 * card is a body and the devtools card is another, the shell asks this page
 * to publish (`inspect {on: true}`); {@link installInspectionPublisher}
 * then sends the inspection as `inspection` advice on each change of the
 * fields the inspector draws, deduplicated by content so a stream delta that
 * moves none of them sends nothing. `inspect {on: false}` releases it.
 *
 * The session store is rebuilt when the card rebinds, so the subscription
 * follows the services store, as the body publisher's does.
 *
 * @module body/body-inspection
 */

import type { BusMessage } from "@tugproto/bus";
import { cardServicesStore } from "../lib/card-services-store";
import { relayableInspection } from "../lib/telemetry-inspection-store";

/**
 * Publish `cardId`'s inspection on every change until released. A card with
 * no session publishes `null` once, so the inspector it feeds shows no card
 * rather than the last card's.
 */
export function installInspectionPublisher(cardId: string, send: (message: BusMessage) => void): () => void {
  let last: string | null = null;
  const publish = (): void => {
    const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
    const inspection = store === null ? null : relayableInspection(cardId, store);
    const encoded = JSON.stringify(inspection);
    if (encoded === last) return;
    last = encoded;
    send({ kind: "card-advice", payload: { advice: "inspection", inspection } });
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
  };
}
