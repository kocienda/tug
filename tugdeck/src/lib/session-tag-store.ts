/**
 * session-tag-store.ts — per-session mnemonic-tag cache for the Z4B chip.
 *
 * The tag lives authoritatively in tugcast's ledger and rides the `SessionRow`
 * shape on `list_sessions_ok` rows and `session_updated` pushes. The chooser
 * reads tags straight off those rows, but the Z4B chip needs the tag for *its
 * bound session* by id — so this tiny store indexes `lineId → tag` and the
 * chip subscribes by id ([L02]).
 *
 * Populated from three sources (see `action-dispatch.ts`): a client spawn sets
 * it **optimistically** to the provisional tag so the chip shows one instantly
 * "from the drop"; `session_updated` pushes and `list_sessions_ok` / card-binding
 * rows make it **authoritative** (the callsign the ledger claimed). A blank
 * tag clears the entry.
 *
 * **The authoritative answer can differ from the optimistic one, and this store
 * is where the swap lands.** A tag any session ever minted is spent forever (the
 * ledger's append-only `minted_tags` arbiter), so a collision does not get a
 * numeric suffix — the ledger rerolls a complete fresh pair. A callsign shown
 * "from the drop" may therefore change **once**, seconds after spawn, when
 * {@link SessionTagStore.seedTag} takes the ledger's word; after that it is
 * immutable for the life of the **line**. See `session-tag.ts`'s header.
 *
 * A faithful clone of `session-name-store.ts`, plus the reverse `tag →
 * line_id` index its header once deferred: {@link SessionTagStore.lineWearing}
 * is what makes `/resume <tag>` possible, and it is exact-match only ([P12]).
 *
 * @module lib/session-tag-store
 */

class SessionTagStore {
  private tags = new Map<string, string>();
  /**
   * The reverse index, `tag → lineId` — what makes the callsign
   * ADDRESSABLE ([P12]): `/resume stocky-pixie` and any other command that
   * takes a callsign resolve through here.
   *
   * Maintained in `setTag` beside the forward map rather than derived on
   * demand, because the one case a scan would get wrong is the case that
   * actually happens: the ledger rerolls a collided mint, so a session's tag
   * CHANGES once, seconds after spawn, and the tag it wore for those seconds
   * must stop resolving. Dropping the old key here is what does that.
   */
  private byTag = new Map<string, string>();
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
   * MANY tags at once (the Cards card Sessions list filters on its rows' labels) and
   * so cannot subscribe by a single id.
   */
  getVersion = (): number => this.version;

  /** The tag for `lineId`, or `null` when untagged. */
  getTag = (lineId: string): string | null =>
    this.tags.get(lineId) ?? null;

  /** Every tag currently known — the re-roll exclusion set for minting. */
  knownTags = (): ReadonlySet<string> => new Set(this.tags.values());

  /**
   * The **line** wearing `tag` right now, or `null` — the callsign resolved
   * back to an id ([P12]). A caller that needs a session id to act on asks
   * `sessionLineStore.seatOf` for the line's seated segment.
   *
   * **Exact match, deliberately.** A callsign is a name, not a query: `/resume
   * stocky-pix` is a typo, and answering it with `stocky-pixie` would resume a
   * session the user did not name. Lineage callsigns need no special case —
   * `stocky-pixie-A1` is a tag like any other and matches as itself, never as
   * its root.
   *
   * The answer is only as complete as this cache: a session no listing, push,
   * or binding has mentioned in this run is unknown here even though the ledger
   * holds it. That is the honest failure — the caller says so rather than
   * guessing.
   */
  lineWearing = (tag: string): string | null =>
    this.byTag.get(tag.trim()) ?? null;

  /**
   * Set (trimmed) or clear (`null` / blank) the tag for `lineId`. No-op
   * + no notify when unchanged, so a redundant wire echo doesn't churn React.
   */
  setTag(lineId: string, tag: string | null): void {
    const trimmed = tag?.trim() ?? "";
    const current = this.tags.get(lineId) ?? null;
    // The reverse index is deleted only when this session still owns the
    // entry: during a reroll the spent callsign may already have been
    // re-seeded onto the session that legitimately wears it, and an
    // unconditional delete would knock out that session's mapping — an
    // un-repairable loss, since its own later re-seed short-circuits on
    // "unchanged".
    const ownsReverse = (key: string): boolean =>
      this.byTag.get(key) === lineId;
    if (trimmed.length === 0) {
      if (current === null) return;
      this.tags.delete(lineId);
      if (ownsReverse(current)) this.byTag.delete(current);
    } else {
      if (current === trimmed && ownsReverse(trimmed)) return;
      this.tags.set(lineId, trimmed);
      // The reroll case: the callsign this session wore a moment ago names
      // nothing now, so it must stop resolving.
      if (current !== null && current !== trimmed && ownsReverse(current)) {
        this.byTag.delete(current);
      }
      this.byTag.set(trimmed, lineId);
    }
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /**
   * Non-clobbering populate for the broadcast/seed paths (`session_updated`,
   * `list_sessions_ok`, card-binding rows, the spawn ack). A tag is monotonic —
   * once minted it never legitimately becomes blank — so a `null`/blank push
   * (a row read before the tag landed, or a stale echo) must NOT wipe a good
   * cached tag back to the id-hash fallback. Only a real value writes; a blank
   * is a no-op. A different real value still overwrites — that is the ledger
   * rerolling a collided mint, and adopting it here is what keeps the optimistic
   * tag from outliving its one chance to be wrong. Explicit clears go through
   * `setTag`.
   */
  seedTag(lineId: string, tag: string | null): void {
    if ((tag?.trim() ?? "").length === 0) return;
    this.setTag(lineId, tag);
  }
}

/** Module-scope singleton — mirrors the other per-card stores' usage shape. */
export const sessionTagStore = new SessionTagStore();
