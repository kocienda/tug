/**
 * session-private-store.ts — per-session Overview-privacy cache.
 *
 * `sessions.private` lives authoritatively in tugcast's ledger. The `/private`
 * command needs to know the current value to toggle it, and the session atom
 * needs it to show the resting state — so this store indexes
 * `tugSessionId → private` and each surface subscribes by id ([L02]).
 *
 * Three arms fill it, and between them a card is never left guessing: the
 * `spawn_session_ok` bind ack (which is how a card reloaded or resumed
 * mid-turn learns the flag without waiting for a later frame), the
 * `session_updated` push, and `/private`'s own ack. The flag also rides
 * `list_sessions_ok` rows on the wire, but nothing reads it there — the picker
 * shows no marker, and a listing is about sessions this deck may not be
 * holding.
 *
 * Privacy is a **resting state**, which is why it gets a store rather than
 * living in the ack: a transient "this session is now private" notice is gone
 * after a reload, and a session silently not being narrated with nothing on
 * screen to say why is precisely the resting lie this codebase refuses.
 *
 * The value is authoritative on every push — a row carrying `false` means the
 * session really is public — so there is no non-clobbering seed arm here. The
 * `/private` command writes optimistically so the marker turns over with the
 * gesture rather than a round trip later.
 *
 * Alongside the state, the store carries the **transition**: a one-shot
 * {@link SessionPrivateStore.awaitSettle} waiter the `/private` command arms
 * before it sends, resolved by whichever ack comes back. The marker can afford
 * to be optimistic because it is reconciled either way; the bulletin cannot,
 * because a claim that the Overview has stopped listening is not something to
 * make on a request that may still be refused. A session is bound to exactly
 * one card (`card_id` is 1:1 on the ledger row), so the session id addresses
 * the waiter as precisely as a card id would.
 *
 * @module lib/session-private-store
 */

/** How a `/private` toggle came back from the ledger. */
export interface PrivateSettle {
  /** Whether the ledger wrote the value. */
  ok: boolean;
  /** Wire reason from `set_session_private_err` — absent when `ok`. */
  reason?: string;
}

class SessionPrivateStore {
  private readonly privateIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Map<
    string,
    { requested: boolean; notify: (settle: PrivateSettle) => void }
  >();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether `tugSessionId` is currently out of the Overview. */
  isPrivate = (tugSessionId: string): boolean =>
    this.privateIds.has(tugSessionId);

  /**
   * Set the flag for `tugSessionId`. No-op + no notify when unchanged, so a
   * redundant wire echo doesn't churn React.
   */
  setPrivate(tugSessionId: string, isPrivate: boolean): void {
    if (this.privateIds.has(tugSessionId) === isPrivate) return;
    if (isPrivate) this.privateIds.add(tugSessionId);
    else this.privateIds.delete(tugSessionId);
    for (const listener of this.listeners) listener();
  }

  /**
   * Arm a one-shot waiter for the toggle just fired on `tugSessionId`, to be
   * resolved by the ack for `requested`.
   *
   * One waiter per session, superseded by a newer gesture, and matched on the
   * value that was asked for — so a double-toggle's first ack doesn't resolve
   * the second gesture's waiter and speak the wrong outcome. An ack with no
   * matching waiter is simply not this deck's gesture to narrate.
   *
   * There is no timeout. An ack that never arrives means the transport is
   * down, which the deck already says globally — a per-command timer would
   * only duplicate that signal.
   */
  awaitSettle(
    tugSessionId: string,
    requested: boolean,
    notify: (settle: PrivateSettle) => void,
  ): void {
    this.waiters.set(tugSessionId, { requested, notify });
  }

  /**
   * Resolve the pending waiter for `tugSessionId` if it asked for
   * `requested`. Called by both ack arms, after the state write.
   */
  settle(
    tugSessionId: string,
    requested: boolean,
    settle: PrivateSettle,
  ): void {
    const waiter = this.waiters.get(tugSessionId);
    if (waiter === undefined || waiter.requested !== requested) return;
    this.waiters.delete(tugSessionId);
    waiter.notify(settle);
  }

  /** Forget a session entirely — a trashed row is neither private nor public. */
  forget(tugSessionId: string): void {
    this.waiters.delete(tugSessionId);
    this.setPrivate(tugSessionId, false);
  }
}

/** Module-scope singleton — mirrors the other per-session stores' usage shape. */
export const sessionPrivateStore = new SessionPrivateStore();

/**
 * Human copy for a `set_session_private_err` reason, for the refusal
 * bulletin's description. An unknown code falls through to a legible line
 * rather than a raw token — mirrors `spawnErrorMessage`.
 */
export function privateRefusalDetail(reason: string | undefined): string {
  switch (reason) {
    case "not_found":
      return "This session has no ledger row to mark.";
    case "no_ledger":
      return "The session ledger is unavailable.";
    case "ledger_write_failed":
      return "The session ledger refused the write.";
    default:
      return "The session ledger did not accept the change.";
  }
}
