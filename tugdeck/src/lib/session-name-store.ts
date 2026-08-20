/**
 * session-name-store.ts — per-session name cache for the Z4B chip ([#step-13d]).
 *
 * The session name lives authoritatively in tugcast's ledger and rides the
 * `SessionRow` shape on `list_sessions_ok` rows and `session_updated` pushes.
 * The chooser reads names straight off those rows, but the Z4B chip needs the
 * name for *its bound session* by id — so this tiny store indexes
 * `tugSessionId → name` and the chip subscribes by id ([L02]).
 *
 * Populated from three sources (see `action-dispatch.ts`): the `/rename` surface
 * sets it **optimistically** so the chip updates instantly; `session_updated`
 * pushes and `list_sessions_ok` rows make it **authoritative** (a rename from
 * anywhere, or opening the chooser, fills it in). A blank name clears the entry.
 *
 * The optimistic write is only safe because the refusal is caught: the rename
 * surface arms a one-shot {@link SessionNameStore.awaitSettle} waiter before it
 * sends, holding the name being replaced, and a `rename_session_err` puts that
 * name back. Nothing else would — a failed write broadcasts no `session_updated`,
 * so an unreconciled optimistic name is permanent. A session is bound to exactly
 * one card (`card_id` is 1:1 on the ledger row), so the session id addresses the
 * waiter as precisely as a card id would.
 *
 * @module lib/session-name-store
 */

/** How a `/rename` came back from the ledger. */
export interface NameSettle {
  /** Whether the ledger wrote the name. */
  ok: boolean;
  /** Wire reason from `rename_session_err` — absent when `ok`. */
  reason?: string;
}

class SessionNameStore {
  private names = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly waiters = new Map<
    string,
    {
      requested: string | null;
      previous: string | null;
      notify?: (settle: NameSettle) => void;
    }
  >();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * A monotonic token that bumps on every change — the whole-store
   * `useSyncExternalStore` snapshot, for a consumer that derives something from
   * MANY names at once (the Lens Sessions list filters on its rows' labels) and
   * so cannot subscribe by a single id.
   */
  getVersion = (): number => this.version;

  /** The name for `tugSessionId`, or `null` when unnamed. */
  getName = (tugSessionId: string): string | null =>
    this.names.get(tugSessionId) ?? null;

  /**
   * Whether this session's custom name is also some other session's.
   *
   * The collision test behind the title rule: a custom name REMOVES the
   * callsign from the title, and the callsign returns only when two sessions
   * share one name and the reader needs the final disambiguation. An unnamed
   * session never collides. A linear scan — the map holds one entry per named
   * session this client has seen, a small set by construction.
   */
  isNameShared = (tugSessionId: string): boolean => {
    const name = this.names.get(tugSessionId);
    if (name === undefined) return false;
    for (const [id, other] of this.names) {
      if (id !== tugSessionId && other === name) return true;
    }
    return false;
  };

  /**
   * Set (trimmed) or clear (`null` / blank) the name for `tugSessionId`. No-op
   * + no notify when unchanged, so a redundant wire echo doesn't churn React.
   */
  setName(tugSessionId: string, name: string | null): void {
    const trimmed = name?.trim() ?? "";
    const current = this.names.get(tugSessionId) ?? null;
    if (trimmed.length === 0) {
      if (current === null) return;
      this.names.delete(tugSessionId);
    } else {
      if (current === trimmed) return;
      this.names.set(tugSessionId, trimmed);
    }
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /**
   * Non-clobbering populate for the seed paths (`list_sessions_ok`, card-binding
   * rows, the spawn ack). These fire whenever a card binds or a listing lands —
   * they must fill in a known user name, but a seed carrying no name (a row that
   * is unnamed, or read before the name landed) must NOT wipe a good cached name
   * back to the id-hash. Only a real value writes; a blank is a no-op. The
   * authoritative `session_updated` push keeps using `setName`, whose
   * `name_user_set=false`→clear is by design (an auto title never fronts the
   * chip).
   */
  seedName(tugSessionId: string, name: string | null): void {
    if ((name?.trim() ?? "").length === 0) return;
    this.setName(tugSessionId, name);
  }

  /**
   * Arm a one-shot waiter for the rename just sent on `tugSessionId`, to be
   * resolved by the ack for `requested`.
   *
   * `previous` is the name being replaced — a string cannot be recovered from
   * the refusal the way a toggled boolean can, so the value to put back is
   * remembered here at the moment it is still known. One waiter per session,
   * superseded by a newer rename, and matched on the name that was asked for,
   * so a rapid second rename's ack doesn't resolve the first's waiter.
   *
   * No timeout, for the reason the privacy store gives: an ack that never
   * arrives means the transport is down, which the deck already says globally.
   */
  awaitSettle(
    tugSessionId: string,
    requested: string | null,
    previous: string | null,
    notify?: (settle: NameSettle) => void,
  ): void {
    this.waiters.set(tugSessionId, { requested, previous, notify });
  }

  /**
   * Resolve the pending waiter for `tugSessionId` if it asked for `requested`.
   * A refusal restores the remembered previous name before notifying — the
   * rollback lives here because this is the only place that value survives.
   */
  settle(
    tugSessionId: string,
    requested: string | null,
    settle: NameSettle,
  ): void {
    const waiter = this.waiters.get(tugSessionId);
    if (waiter === undefined) return;
    const asked = requested?.trim() ?? "";
    if ((waiter.requested?.trim() ?? "") !== asked) return;
    this.waiters.delete(tugSessionId);
    if (!settle.ok) this.setName(tugSessionId, waiter.previous);
    waiter.notify?.(settle);
  }
}

/** Module-scope singleton — mirrors the other per-card stores' usage shape. */
export const sessionNameStore = new SessionNameStore();

/**
 * Human copy for a `rename_session_err` reason, for the refusal bulletin's
 * description. An unknown code falls through to a legible line rather than a
 * raw token — mirrors `spawnErrorMessage` and `privateRefusalDetail`.
 */
export function renameRefusalDetail(reason: string | undefined): string {
  switch (reason) {
    case "not_found":
      return "This session has no ledger row to name.";
    case "no_ledger":
      return "The session ledger is unavailable.";
    case "ledger_write_failed":
      return "The session ledger refused the write.";
    default:
      return "The session ledger did not accept the change.";
  }
}
