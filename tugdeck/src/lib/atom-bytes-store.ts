/**
 * `atom-bytes-store` — per-session-card side-table of base64 bytes for
 * inline image atoms (drop / paste).
 *
 * ## What lives here, and why a separate store
 *
 * The substrate's `AtomSegment` carries display data only — `kind`,
 * `type`, `label`, `value`, and (post-Step 2) an optional `id`. It
 * does *not* carry the underlying image bytes. Storing 5 MB of base64
 * on `AtomSegment.value` would balloon every state-preservation
 * snapshot, every CASE-A interrupt restore, every undo history entry.
 *
 * This module is the side-table. Keyed by atom id (a UUID minted at
 * drop / paste time), it holds the post-downsample base64 bytes + the
 * effective media type. Atoms remain lightweight; the bytes-store is
 * the single source of truth for image-attachment payload bytes
 * between insert and turn-commit, and between turn-commit and
 * card-unmount (the JSON-serializable snapshot rides
 * `useCardStatePreservation`).
 *
 * ## Lifetimes
 *
 * One instance per `CodeSessionStore` (per-session-card scope). The
 * store is created in the `CodeSessionStore` constructor and disposed
 * when the store is disposed. Entries live from `put()` until
 * `delete()` or store disposal; state preservation (`snapshot()` →
 * `restore()`) round-trips the map across HMR / pane restore / cold
 * boot.
 *
 * Why per-card and not per-session: a single Tug session can host
 * multiple cards (the session card surface is the primary one but
 * future cards may attach the same session). Each card has its own
 * editor and drop / paste affordances, so each card's bytes are
 * scoped to its own store. This keeps cross-card paste of identities
 * a clean separate question (currently out of scope per the
 * non-goals).
 *
 * ## Why a class, not a Map directly
 *
 * Three reasons. First, [Spec S02] mandates a contract (`put`, `get`,
 * `delete`, `snapshot`, `restore`); the class gives us a stable
 * shape for that contract. Second, `restore` is not just `Object.assign`
 * — we want to be explicit about merge semantics (additive on existing
 * keys, see below). Third, the consumer surface (drop extension,
 * paste handler, reducer commit path, state preservation) is wider
 * than just "stick a Map somewhere"; a named factory clarifies the
 * intent at the call site.
 *
 * ## Pure-logic, no DOM
 *
 * This file has no DOM, no React, no canvas, no async. It is data
 * plumbing. Tested as a pure module in `__tests__/atom-bytes-store.test.ts`.
 *
 * Laws:
 *  - [L02] external state — this store IS external state from React's
 *    perspective. Consumers do not subscribe to it through
 *    `useSyncExternalStore` because no rendering depends on its
 *    contents (the substrate's atom array drives rendering;
 *    bytes-store reads happen at submit / commit time only, off the
 *    render path).
 *  - [L19] file structure / docstring discipline.
 *  - [L23] state preservation — the `snapshot` / `restore` methods
 *    are the bytes-store's contribution to the [A9] protocol so user
 *    state survives cold boot / pane restore / HMR.
 *
 * References:
 *  - [Spec S02] AtomBytesStore interface — `arc/dev-atoms.md#s02-atom-bytes-store`
 *  - [D03] per-card bytes-store keyed by UUID — `arc/dev-atoms.md#d03-atom-bytes-store`
 *  - [D04] no raw bytes on the React snapshot — `arc/dev-atoms.md#d04-no-bytes-on-snapshot`
 *  - [Table T02] persistence tiers — `arc/dev-atoms.md#t02-persistence-tiers`
 */

// ---------------------------------------------------------------------------
// Public types — mirror [Spec S02] verbatim.
// ---------------------------------------------------------------------------

/**
 * One entry in the bytes-store. `content` is base64 of the
 * downsampled bytes; `mediaType` is the effective output MIME after
 * the downsample pipeline (may differ from the source — e.g., PNG
 * sources that hit the JPEG quality ladder come back as `image/jpeg`).
 *
 * Plain values only — no Blobs, no ArrayBuffers, no functions — so
 * the snapshot is JSON-serializable.
 */
export interface AtomBytesEntry {
  /** Base64-encoded image bytes (no `data:` prefix). */
  content: string;
  /**
   * RFC 6838 media type — `image/png`, `image/jpeg`, `image/gif`,
   * `image/webp`, `image/heic`, `image/heif`, `image/avif`. The set
   * the downsample pipeline produces; not enforced here (the store
   * trusts its producers).
   */
  mediaType: string;
  /**
   * Inline thumbnail data URL — `data:image/<mime>;base64,<bytes>` —
   * baked at `THUMBNAIL_MAX_EDGE_PX` max edge by the downsample
   * pipeline (drop / paste) or by the synthesizer's thumbnail-bake on
   * the replay path.
   *
   * Optional because:
   *  - the drop / paste pipeline lands a `DownsampleResult` synchronously
   *    with the thumbnail in hand; the synthesizer's replay path bakes
   *    asynchronously and fills this in when the worker returns;
   *  - the bake can fail silently on the replay path (corrupt bytes,
   *    exotic format that round-tripped through JSONL but the canvas
   *    can't redecode) — the thumbnail strip can render a fallback tile.
   *
   * The synthesizer treats an entry that already carries a thumbnail
   * as fully populated and does not re-bake — this preserves the
   * drop-time bake across the submit boundary.
   *
   * Per [Step 5c](arc/dev-atoms.md#step-5c) and the
   * thumbnail-at-synthesis design.
   */
  thumbnailDataUrl?: string;
  /**
   * Absolute path of the **original** dropped file, as tugcast rested it.
   *
   * This is the durable half of the entry. `content` is the downsampled copy
   * and is far too large to persist; the path is tens of bytes, so a card
   * state that would have thrown its attachments away can carry a reference
   * to them instead and read the bytes back on restore.
   *
   * Optional because it arrives late and may never arrive: the upload runs in
   * the background after the chip is already on screen, and a refused media
   * type or an unreachable server simply leaves it absent. An entry with no
   * path behaves exactly as every entry did before there were paths.
   *
   * Note that the path names the original, while `mediaType` describes
   * `content` — the downsample output. They can disagree (a PNG that hit the
   * JPEG ladder), which is why the upload sends the `File`'s own type.
   */
  path?: string;
  /**
   * The name the file had when it was dropped.
   *
   * `path` names a file tugcast rested under a UUID, because a draft
   * attachment lives in a flat per-instance folder where two `photo.png`
   * would collide. The name the user knows it by is thrown away at that
   * point unless it is kept here — and it is what a destination writing this
   * attachment into a document's `assets/` should name the file and label the
   * link. Without it, copying a chip out of the prompt entry and pasting it
   * into a Text card leaves a UUID sitting in the user's own directory.
   *
   * Absent for a pasted screenshot, which genuinely has no name; the
   * destination mints one where the write happens.
   */
  name?: string;
}

/**
 * The store contract. See module docstring for lifetime + scoping.
 */
export interface AtomBytesStore {
  /**
   * Stash bytes for an atom or attachment, keyed by id. Idempotent —
   * a second `put` with the same id replaces the previous entry.
   * Producers (drop / paste, reducer commit path) call this with the
   * UUID that lives on the corresponding `AtomSegment.id` /
   * `AttachmentRecord.id`.
   */
  put(id: string, entry: AtomBytesEntry): void;

  /**
   * Look up bytes by id. Returns `null` if the id is unknown — which
   * is the explicit signal `buildWirePayload` uses to skip an image
   * atom whose bytes have been evicted (e.g., the user dropped an
   * image, then deleted the chip from the prompt before submit).
   */
  get(id: string): AtomBytesEntry | null;

  /**
   * Remove bytes by id. Idempotent on unknown ids — deleting a
   * never-stored id is a no-op rather than a throw, so consumers don't
   * have to track which ids they previously put.
   *
   * Currently called when an atom is removed from the editor before
   * submit (the bytes would otherwise leak across the card's
   * lifetime). The reducer commit path does NOT delete on commit —
   * the bytes still need to survive until the user navigates away
   * (click-to-enlarge from the transcript may want them).
   */
  delete(id: string): void;

  /**
   * Number of entries currently in the store. Exposed for diagnostics
   * (heap profile, [Q01] resolution) and for the rare consumer that
   * wants a cheap is-empty check without iterating `snapshot()`.
   */
  size(): number;

  /**
   * JSON-serializable snapshot for state preservation. Returns a
   * fresh plain object — callers can stash it on a `CardStateBag`
   * slot, send it through `JSON.stringify`, and round-trip it back
   * via `restore` after a cold boot.
   *
   * Producing a fresh object each call (rather than the store's
   * internal map) keeps the snapshot decoupled from later mutations.
   */
  snapshot(): Record<string, AtomBytesEntry>;

  /**
   * Restore from a snapshot. Additive on existing keys: entries
   * already in the store are kept; entries in the snapshot are added
   * or replace overlapping ids. Useful when a `useCardStatePreservation`
   * cycle delivers a snapshot for the in-flight prompt-entry atoms
   * while the live store has already accumulated unrelated entries
   * from drops that happened after the snapshot was taken (rare in
   * practice, but the semantics are unambiguous).
   *
   * Pass an empty object `{}` to no-op the call.
   */
  restore(snap: Record<string, AtomBytesEntry>): void;

  /**
   * Drop all entries. Used at card unmount / store disposal to
   * release any retained bytes. Idempotent.
   */
  clear(): void;

  /**
   * Subscribe to store mutations. The listener fires once per call
   * to `put`, `delete`, `restore`, or `clear` — coalesced (no
   * per-key info passed); subscribers re-query whatever ids they
   * care about.
   *
   * Returns an unsubscribe function. Idempotent — calling
   * unsubscribe twice is a no-op.
   *
   * Used by the drop / paste pipeline's pending-atom sync: an atom
   * inserted synchronously with an `id` but no bytes-store entry
   * renders in a "pending" appearance; when the matching byte
   * payload eventually lands via `put`, subscribers fire and the
   * pending-sync `ViewPlugin` mutates `data-pending` off the
   * widget's DOM element ([L06] — appearance via DOM, no widget
   * rebuild).
   */
  subscribe(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a fresh, empty `AtomBytesStore`. The returned object is
 * the only handle the caller needs — there is no shared global state.
 *
 * Implementation note: the backing is a plain `Map<string, AtomBytesEntry>`.
 * Identity-equality on the entries is not required; consumers compare
 * by id only. Snapshot output cloning is shallow — `AtomBytesEntry`
 * fields are primitives, so a structured clone is unnecessary.
 *
 * @example
 * ```ts
 * const store = createAtomBytesStore();
 * store.put("abc-123", { content: "iVBORw0KGgo…", mediaType: "image/png" });
 * store.get("abc-123"); // → { content, mediaType }
 * const snap = store.snapshot();
 * // JSON.stringify(snap) round-trips through state preservation;
 * // store2.restore(snap) on the receiving side re-populates.
 * ```
 */
export function createAtomBytesStore(): AtomBytesStore {
  const map = new Map<string, AtomBytesEntry>();
  // Listener set — array rather than Set for cheap iteration and
  // because listener identities don't need to be unique (a consumer
  // re-subscribing returns a fresh unsubscribe).
  const listeners: Array<() => void> = [];

  /**
   * Fire every registered listener. Errors in one listener don't
   * block siblings — wrapped in try/catch so a buggy subscriber
   * can't corrupt the store's notification cycle. We log via
   * `console.error` rather than re-throwing so the producer (the
   * code that called `put` / `delete` / etc.) sees its operation
   * succeed; subscriber bugs surface in the dev console.
   */
  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[atom-bytes-store] subscriber threw:", err);
      }
    }
  }

  return {
    put(id, entry) {
      map.set(id, entry);
      notify();
    },
    get(id) {
      const entry = map.get(id);
      return entry === undefined ? null : entry;
    },
    delete(id) {
      const had = map.delete(id);
      if (had) notify();
    },
    size() {
      return map.size;
    },
    snapshot() {
      const out: Record<string, AtomBytesEntry> = {};
      for (const [id, entry] of map) {
        const e: AtomBytesEntry = {
          content: entry.content,
          mediaType: entry.mediaType,
        };
        if (entry.thumbnailDataUrl !== undefined) {
          e.thumbnailDataUrl = entry.thumbnailDataUrl;
        }
        if (entry.path !== undefined) {
          e.path = entry.path;
        }
        if (entry.name !== undefined) {
          e.name = entry.name;
        }
        out[id] = e;
      }
      return out;
    },
    restore(snap) {
      let added = 0;
      for (const [id, entry] of Object.entries(snap)) {
        // Defensive: filter to entries that look like AtomBytesEntry.
        // A malformed snapshot (corrupt persistence, schema drift)
        // skips bad keys rather than crashing the restore. The
        // good-key entries still land.
        if (
          entry === null ||
          typeof entry !== "object" ||
          typeof (entry as AtomBytesEntry).content !== "string" ||
          typeof (entry as AtomBytesEntry).mediaType !== "string"
        ) {
          continue;
        }
        const e = entry as AtomBytesEntry;
        const next: AtomBytesEntry = { content: e.content, mediaType: e.mediaType };
        if (typeof e.thumbnailDataUrl === "string") {
          next.thumbnailDataUrl = e.thumbnailDataUrl;
        }
        // The durable reference. A restored entry whose `content` is the
        // empty string is the normal shape here — the bytes were left on
        // disk rather than persisted, and this path is how they come back.
        if (typeof e.path === "string") {
          next.path = e.path;
        }
        if (typeof e.name === "string") {
          next.name = e.name;
        }
        map.set(id, next);
        added += 1;
      }
      // Single notification per restore call, fired only when the
      // snapshot actually contributed entries. Subscribers re-query
      // whatever ids they care about.
      if (added > 0) notify();
    },
    clear() {
      const wasEmpty = map.size === 0;
      map.clear();
      if (!wasEmpty) notify();
    },
    subscribe(listener) {
      listeners.push(listener);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}
