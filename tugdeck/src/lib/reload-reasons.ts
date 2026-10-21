/**
 * Why a Session card's transcript is read back from disk.
 *
 * A reload is an act with a reason, and the reasons are a closed set:
 *
 * - `launch` — the page that holds the card started (the app launched, or a
 *   body page loaded), and the card restores from the ledger.
 * - `restore-open` — a card is opened onto a session: the picker, a resume,
 *   a parked workspace activated, Run in New Session, and the `/clear`,
 *   `/resume` and `/cd` re-binds, each of which shows a different session
 *   afterwards and builds it as an open.
 * - `server-restart` — the deck reconnected to a tugcast that is not the one
 *   it was talking to.
 *
 * Nothing else reloads a card. Building a card's stores asks for nothing;
 * the transcript is requested by `cardServicesStore.requestTranscript`, with
 * one of these reasons, from the `spawn_session_ok` that answers a spawn sent
 * for that reason. Adding a fourth is a change to this list and to the test
 * that enumerates it, made on purpose.
 */
export const RELOAD_REASONS = ["launch", "restore-open", "server-restart"] as const;

export type ReloadReason = (typeof RELOAD_REASONS)[number];

/** Whether `value` is one of the closed set. */
export function isReloadReason(value: unknown): value is ReloadReason {
  return (RELOAD_REASONS as readonly unknown[]).includes(value);
}

/**
 * What a `request_replay` says about itself on the wire. A reload carries its
 * {@link ReloadReason}; `page` is the transcript asking for the turns older
 * than the ones it holds, and `catch-up` a body that was dormant asking for
 * the turns it missed while hidden — each extends a loaded card rather than
 * reloading it.
 */
export type ReplayRequestReason = ReloadReason | "page" | "catch-up";

/**
 * Why a `spawn_session` is sent. Every reload is one, and so is `rebind`: a
 * reconnect to the same tugcast re-asserting a card whose stores still stand
 * ([B03]). The server re-holds the session for the new socket and acks; the
 * card keeps everything it holds and reads nothing back, so a rebind is not a
 * reload and is not in {@link RELOAD_REASONS}.
 */
export type SpawnReason = ReloadReason | "rebind";

/**
 * The reason each card's outstanding `spawn_session` was sent for, by card.
 * Written as the spawn goes out, taken by the ack that binds the card — the
 * page that sends a card's spawn is the page that builds its stores, so the
 * two ends meet here without the reason crossing the wire twice.
 */
const pending = new Map<string, SpawnReason>();

/** Record the reason a spawn for `cardId` is being sent. */
export function notePendingReload(cardId: string, reason: SpawnReason): void {
  pending.set(cardId, reason);
}

/** Take (and forget) the reason `cardId`'s spawn was sent for. */
export function takePendingReload(cardId: string): SpawnReason | undefined {
  const reason = pending.get(cardId);
  pending.delete(cardId);
  return reason;
}

/** Forget `cardId`'s outstanding reason: its spawn was refused or the card closed. */
export function forgetPendingReload(cardId: string): void {
  pending.delete(cardId);
}

/** @internal Test seam. */
export function _resetPendingReloadsForTests(): void {
  pending.clear();
}
