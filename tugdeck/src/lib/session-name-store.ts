/**
 * session-name-store.ts — per-**line** name cache for the Z4B chip.
 *
 * The session name lives authoritatively in tugcast's ledger and rides the
 * `SessionRow` shape on `list_sessions_ok` rows and `session_updated` pushes.
 * The chooser reads names straight off those rows, but the Z4B chip needs the
 * name for *its bound session* by id — so this tiny store indexes
 * `lineId → name` and the chip subscribes by id ([L02]).
 *
 * **The key is the line, not the segment** ([P12]). The name is the
 * conversation's title, and a card rotates through a session id per stage, per
 * rewind, per respawn; keyed by segment, a rename would go blank the next time
 * the id changed. `sessionLineStore` is where a session id becomes the key
 * this store holds.
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
 * so an unreconciled optimistic name is permanent. A line is seated on exactly
 * one card, so the line id addresses the waiter as precisely as a card id would.
 *
 * A name another line already wears is NOT a refusal: the newest `/rename`
 * takes it ([P11]), and the ack lists the lines it was taken from so the
 * bulletin can say so. The displaced lines' own entries are cleared from the
 * ack, and tugcast's `session_updated` push for each of them says the same
 * thing authoritatively a moment later.
 *
 * @module lib/session-name-store
 */

/** How a `/rename` came back from the ledger. */
export interface NameSettle {
  /** Whether the ledger wrote the name. */
  ok: boolean;
  /** Wire reason from `rename_session_err` — absent when `ok`. */
  reason?: string;
  /**
   * The lines this rename took the name away from, present only when it took
   * one ([P11]). A user-set name is unique at the write and the newest
   * gesture wins, so a rename onto a name somebody wears succeeds and reports
   * whom it took it from — the bulletin says so rather than letting a name
   * vanish off another card unannounced.
   */
  displaced?: DisplacedLine[];
}

/** A line that lost its user-set name to somebody else's `/rename`. */
export interface DisplacedLine {
  lineId: string;
  /** The callsign its chip falls back to. */
  tag: string;
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

  /** The name for `lineId`, or `null` when unnamed. */
  getName = (lineId: string): string | null =>
    this.names.get(lineId) ?? null;

  /**
   * Set (trimmed) or clear (`null` / blank) the name for `lineId`. No-op
   * + no notify when unchanged, so a redundant wire echo doesn't churn React.
   */
  setName(lineId: string, name: string | null): void {
    const trimmed = name?.trim() ?? "";
    const current = this.names.get(lineId) ?? null;
    if (trimmed.length === 0) {
      if (current === null) return;
      this.names.delete(lineId);
    } else {
      if (current === trimmed) return;
      this.names.set(lineId, trimmed);
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
  seedName(lineId: string, name: string | null): void {
    if ((name?.trim() ?? "").length === 0) return;
    this.setName(lineId, name);
  }

  /**
   * Arm a one-shot waiter for the rename just sent on `lineId`, to be
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
    lineId: string,
    requested: string | null,
    previous: string | null,
    notify?: (settle: NameSettle) => void,
  ): void {
    this.waiters.set(lineId, { requested, previous, notify });
  }

  /**
   * Resolve the pending waiter for `lineId` if it asked for `requested`.
   * A refusal restores the remembered previous name before notifying — the
   * rollback lives here because this is the only place that value survives.
   */
  settle(
    lineId: string,
    requested: string | null,
    settle: NameSettle,
  ): void {
    const waiter = this.waiters.get(lineId);
    if (waiter === undefined) return;
    const asked = requested?.trim() ?? "";
    if ((waiter.requested?.trim() ?? "") !== asked) return;
    this.waiters.delete(lineId);
    if (!settle.ok) this.setName(lineId, waiter.previous);
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
      return "This session has no line to name.";
    case "no_ledger":
      return "The session ledger is unavailable.";
    case "ledger_write_failed":
      return "The session ledger refused the write.";
    default:
      return "The session ledger did not accept the change.";
  }
}
