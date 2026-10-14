/**
 * The deck bus from a page: addressed messages between the shell and the
 * bodies, one JSON envelope per `DECK_BUS` frame.
 *
 * A page sends `{to, kind, payload}`; tugcast resolves `to` against the live
 * pages and delivers the envelope with `from` set from the sender's
 * registered identity. tugcast's subscription filter always admits the bus
 * feed, so a listener here needs no subscription of its own beyond the
 * `onFrame` registration. The vocabulary is `@tugproto/bus`.
 *
 * @module lib/deck-bus
 */

import type { BusDelivered, BusKind, BusMessage, BusTarget } from "@tugproto/bus";
import type { TugConnection } from "../connection";
import { FeedId } from "../protocol";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The delivered message of one kind. */
export type BusDeliveredOf<K extends BusKind> = BusDelivered & { kind: K };

/** Send one message to `to`. Fire-and-forget: a closed wire drops it, as every frame. */
export function sendBus(connection: TugConnection, to: BusTarget, message: BusMessage): void {
  connection.send(FeedId.DECK_BUS, encoder.encode(JSON.stringify({ to, ...message })));
}

/**
 * Call `listener` with every delivered message of `kind`. Returns the
 * unsubscribe. A frame that is not a bus envelope is logged and skipped.
 */
export function onBus<K extends BusKind>(
  connection: TugConnection,
  kind: K,
  listener: (message: BusDeliveredOf<K>) => void,
): () => void {
  return connection.onFrame(FeedId.DECK_BUS, (payload) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(payload));
    } catch {
      tugDevLogStore.warn("bus", "a DECK_BUS frame was not JSON; skipped");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    if ((parsed as { kind?: unknown }).kind !== kind) return;
    listener(parsed as BusDeliveredOf<K>);
  });
}
