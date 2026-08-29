/**
 * The deck's seating report — a `deck_seatings` CONTROL frame telling
 * tugcast which tug sessions are seated on open Session cards, right now.
 *
 * `sessions.state` on the server answers "is a subprocess running", which is
 * the wrong question for the changeset's orphan lift ([D120]): between a
 * tugcast startup demote and a card's next spawn, every session reads
 * `closed` while the user's cards sit open on their work — and the lift,
 * reading `closed` as abandoned, offers the user their own files back and
 * puts every claim on a treadmill. Seatedness is the missing fact, and only
 * the deck holds it, so the deck reports it.
 *
 * One subscriber on `cardSessionBindingStore` — the single funnel every
 * bind/unbind already passes through (spawn ack, `/clear` re-seat, close,
 * trash, auth-gate unbind, reconnect `clearAll`). Each report is the full
 * replacement set, so a missed delta can never wedge the server's view.
 * Coalesced to a microtask because a restore lands N spawn acks in a burst,
 * and diffed against the last-sent payload so no-op notifies cost nothing.
 *
 * Server-side the set is keyed by WebSocket client id and dies with the
 * socket, so a reconnect starts from "seated on nothing" — the reporter
 * mirrors that by forgetting its last-sent payload on reconnect and letting
 * the restore burst's notifies re-send. The one suppression: an empty set
 * is not sent when nothing has been sent on this socket yet (the server
 * already holds nothing for a fresh client), but IS sent once seatings have
 * been reported — closing the last Session card genuinely empties the set.
 *
 * @module lib/deck-seatings-reporter
 */

import type { TugConnection } from "../connection";
import { cardSessionBindingStore } from "./card-session-binding-store";
import { getConnectionLifecycle } from "./connection-lifecycle";

let installed = false;

/** Serialize the current binding set into the frame payload, stably ordered
 * so payload equality is set equality. */
function currentPayload(): { seatings: { card_id: string; tug_session_id: string }[] } {
  const seatings = [...cardSessionBindingStore.getSnapshot()]
    .map(([cardId, binding]) => ({
      card_id: cardId,
      tug_session_id: binding.tugSessionId,
    }))
    .sort((a, b) => a.card_id.localeCompare(b.card_id));
  return { seatings };
}

/**
 * Install the reporter. Called once at boot, after `initActionDispatch` —
 * the same timing rule as the auth probe, and after the store exists. Safe
 * against double-install.
 */
export function installDeckSeatingsReporter(connection: TugConnection): void {
  if (installed) return;
  installed = true;

  let lastSent: string | null = null;
  let pending = false;

  const send = (): void => {
    pending = false;
    const payload = currentPayload();
    const serialized = JSON.stringify(payload);
    if (serialized === lastSent) return;
    if (payload.seatings.length === 0 && lastSent === null) return;
    if (connection.trySendControlFrame("deck_seatings", payload)) {
      lastSent = serialized;
    } else {
      // Socket not open — forget the send so the next notify (or the
      // reconnect reset below) retries rather than believing it landed.
      lastSent = null;
    }
  };

  const scheduleSend = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(send);
  };

  cardSessionBindingStore.subscribe(scheduleSend);
  // A reconnect is a fresh server-side client id holding no seatings —
  // forget the last payload so the restore burst's notifies re-report even
  // when the final set matches what the old socket was told.
  getConnectionLifecycle()?.observeConnectionDidReconnect(() => {
    lastSent = null;
    scheduleSend();
  });
  // Boot: the store may already hold bindings if restore raced install;
  // report whatever is there.
  scheduleSend();
}
