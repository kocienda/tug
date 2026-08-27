/**
 * session-synopsis-store.ts — per-session synopsis cache.
 *
 * The synopsis is the session's rolling generated description: a standing
 * sentence about what the session is doing now, composed on tugcast's
 * Summarize lane and persisted on the ledger row. It rides `SessionRow` on
 * `list_sessions_ok` rows and `session_updated` pushes, exactly like `name`
 * and `tag`, so this store indexes `lineId → synopsis` and identity
 * surfaces subscribe by id ([L02]).
 *
 * It is the second half of a session's description line: a user `/rename`
 * name wins and freezes the line, and the synopsis fills it otherwise. The
 * precedence lives in `session-identity.ts`, which is the only reader.
 *
 * A faithful clone of `session-name-store.ts` — same by-id getter, same
 * monotonic version token, same seed/set split — because the resolver hook
 * and the Lens's whole-list projection need exactly the shapes that store
 * already publishes.
 *
 * @module lib/session-synopsis-store
 */

class SessionSynopsisStore {
  private synopses = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * A monotonic token that bumps on every change — the whole-store
   * `useSyncExternalStore` snapshot, for a consumer that derives something from
   * MANY synopses at once (the Lens Sessions list filters on its rows' labels)
   * and so cannot subscribe by a single id.
   */
  getVersion = (): number => this.version;

  /** The synopsis for `lineId`, or `null` when none has been written. */
  getSynopsis = (lineId: string): string | null =>
    this.synopses.get(lineId) ?? null;

  /**
   * Set (trimmed) or clear (`null` / blank) the synopsis for `lineId`.
   * No-op + no notify when unchanged, so a redundant wire echo doesn't churn
   * React.
   */
  setSynopsis(lineId: string, synopsis: string | null): void {
    const trimmed = synopsis?.trim() ?? "";
    const current = this.synopses.get(lineId) ?? null;
    if (trimmed.length === 0) {
      if (current === null) return;
      this.synopses.delete(lineId);
    } else {
      if (current === trimmed) return;
      this.synopses.set(lineId, trimmed);
    }
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /**
   * Non-clobbering populate for the seed paths (`list_sessions_ok`, card-binding
   * rows, the spawn ack). These fire whenever a card binds or a listing lands,
   * and a row read before the synopsis landed must not wipe a good cached one
   * back to an empty description line. Only a real value writes; a blank is a
   * no-op. Explicit clears go through `setSynopsis`.
   */
  seedSynopsis(lineId: string, synopsis: string | null): void {
    if ((synopsis?.trim() ?? "").length === 0) return;
    this.setSynopsis(lineId, synopsis);
  }
}

/** Module-scope singleton — mirrors the other per-session stores' usage shape. */
export const sessionSynopsisStore = new SessionSynopsisStore();
