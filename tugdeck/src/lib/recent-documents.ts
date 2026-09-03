/**
 * recent-documents.ts — the deck's Open Recent list.
 *
 * A most-recently-used list of absolute file paths, persisted in tugbank
 * (`dev.tugapp.text-card` / `recent-documents`) so it survives across
 * launches, and mirrored to the Swift host for the File ▸ Open Recent
 * submenu. The deck owns ordering and de-duplication; the host filters
 * the list to files that still exist and shows the top
 * {@link RECENT_DOCUMENTS_MENU_LIMIT} when the menu opens (so a deleted
 * file drops off without the deck having to stat anything).
 *
 * Every real file-open flows through {@link openFileInCard}, which calls
 * {@link noteRecentDocument} — one chokepoint, so the menu, drops, and
 * Open Quickly all feed the same list.
 *
 * @module lib/recent-documents
 */

import { getTugbankClient } from "./tugbank-singleton";
import { TEXT_CARD_DEFAULTS_DOMAIN } from "./text-card-settings";
import { publishRecentDocuments } from "./host-menu-state";

/** tugbank key under {@link TEXT_CARD_DEFAULTS_DOMAIN} for the MRU list. */
export const RECENT_DOCUMENTS_KEY = "recent-documents";

/**
 * tugbank key for the per-path last-opened timestamps (epoch ms), kept
 * alongside the MRU so the Cards card Text Files section can show "Last opened …"
 * on a recent (not-open) file. A parallel map rather than a shape change to
 * {@link RECENT_DOCUMENTS_KEY} — the host menu + the existing coercion consume
 * the plain `string[]` unchanged.
 */
export const RECENT_DOCUMENTS_OPENED_AT_KEY = "recent-documents-opened-at";

/**
 * How many paths the deck retains. The host shows at most 10 that still
 * exist; keeping a few more in the store means a run of just-deleted
 * files doesn't starve the visible menu.
 */
export const RECENT_DOCUMENTS_STORE_LIMIT = 20;

/**
 * Hard byte ceiling on the persisted list. This value rides the boot
 * DEFAULTS frame (it's a tugbank default), so — belt-and-suspenders on top
 * of the count cap — the serialized list is never allowed past a few KB no
 * matter how long individual paths are. Well under tugbank's per-entry
 * write limit; a pathological run of very long paths trims to fit rather
 * than growing the boot frame.
 */
export const RECENT_DOCUMENTS_MAX_BYTES = 16 * 1024;

/** In-memory MRU, newest first. The tugbank value is the durable copy. */
let recents: string[] = [];

/**
 * Per-path last-opened timestamp (epoch ms), keyed by the same path form as
 * {@link recents}. Written on every {@link noteRecentDocument} and pruned to the
 * live MRU on persist. The tugbank value under
 * {@link RECENT_DOCUMENTS_OPENED_AT_KEY} is the durable copy.
 */
let openedAt: Record<string, number> = {};

/**
 * Paths the last `/api/fs/stat` probe reported as gone (deleted, moved,
 * or unreadable). Kept OUT of `recents` filtering at the storage level —
 * a restored file reappears on the next probe — and applied only to the
 * reachable projection below.
 */
let unreachable: ReadonlySet<string> = new Set();

/** The reachable projection of `recents` — the list UI surfaces show. */
let reachableRecents: string[] = [];

/** Change listeners — notified whenever the in-memory MRU mutates. */
const listeners = new Set<() => void>();

/**
 * Subscribe to MRU changes (seed / note / clear). Returns an unsubscribe.
 * A data source consumes this to re-window when the recent-documents list
 * changes, the same way it consumes any [L02] store's `subscribe`.
 */
export function subscribeRecentDocuments(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyRecentDocuments(): void {
  for (const listener of listeners) listener();
}

/** Recompute the reachable projection. Reference-stable when unchanged. */
function recomputeReachable(): void {
  const next = recents.filter((p) => !unreachable.has(p));
  if (
    next.length === reachableRecents.length &&
    next.every((p, i) => p === reachableRecents[i])
  ) {
    return;
  }
  reachableRecents = next;
}

/**
 * Trim `paths` (already de-duped, newest first) to both the count cap and
 * the byte cap — whichever binds first — keeping the newest entries.
 */
function capRecentDocuments(paths: string[]): string[] {
  const out: string[] = [];
  let bytes = 2; // the enclosing "[]"
  for (const path of paths) {
    if (out.length >= RECENT_DOCUMENTS_STORE_LIMIT) break;
    // JSON-encoded size of this element, plus a comma separator.
    const encoded = JSON.stringify(path).length + 1;
    if (bytes + encoded > RECENT_DOCUMENTS_MAX_BYTES) break;
    out.push(path);
    bytes += encoded;
  }
  return out;
}

/** Coerce a stored tugbank value into a clean, capped string[] (defensive). */
export function coerceRecentDocuments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item === "" || seen.has(item)) continue;
    seen.add(item);
    cleaned.push(item);
  }
  return capRecentDocuments(cleaned);
}

/** Coerce a stored tugbank value into a clean `path → epoch-ms` map (defensive). */
export function coerceOpenedAt(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (path !== "" && typeof value === "number" && Number.isFinite(value)) {
      out[path] = value;
    }
  }
  return out;
}

/**
 * The last-opened timestamp (epoch ms) recorded for `path`, or `null` if none
 * was captured (a file opened before timestamps were tracked, until reopened).
 */
export function getRecentOpenedAt(path: string): number | null {
  return openedAt[path] ?? null;
}

/**
 * Seed the list from tugbank and push it to the host. Called once at
 * boot, after the tugbank client is set and its first DEFAULTS frame has
 * populated the cache.
 */
export function initRecentDocuments(): void {
  let raw: unknown;
  let rawOpenedAt: unknown;
  try {
    raw = getTugbankClient()?.getValue(TEXT_CARD_DEFAULTS_DOMAIN, RECENT_DOCUMENTS_KEY);
    rawOpenedAt = getTugbankClient()?.getValue(
      TEXT_CARD_DEFAULTS_DOMAIN,
      RECENT_DOCUMENTS_OPENED_AT_KEY,
    );
  } catch (err) {
    console.warn("[recent-documents] read failed:", err);
  }
  recents = coerceRecentDocuments(raw);
  openedAt = coerceOpenedAt(rawOpenedAt);
  recomputeReachable();
  publishRecentDocuments(recents);
  notifyRecentDocuments();
  probeRecentDocuments();
}

/** The current MRU snapshot (newest first). */
export function getRecentDocuments(): string[] {
  return recents.slice();
}

/**
 * The live MRU array reference — stable between mutations (each mutation
 * reassigns `recents`), so it is a valid `useSyncExternalStore` snapshot paired
 * with {@link subscribeRecentDocuments}. Read-only: callers must not mutate it.
 */
export function getRecentDocumentsSnapshot(): readonly string[] {
  return recents;
}

/**
 * The reachable MRU — `recents` minus the paths the last existence probe
 * reported gone. The list surfaces (the Cards card Text Files section) read
 * this, so a deleted or moved file is never offered as openable. Same
 * stable-reference contract as {@link getRecentDocumentsSnapshot}.
 */
export function getReachableRecentDocumentsSnapshot(): readonly string[] {
  return reachableRecents;
}

let probeSeq = 0;

/**
 * Probe the MRU against disk via `POST /api/fs/stat` (batched, one round
 * trip) and fold the result into the reachable projection. Fired from
 * boot / mutation chokepoints and by surfaces when they (re)appear.
 * Best-effort: a transport failure leaves the current projection alone.
 * Stale responses (a newer probe started meanwhile) are discarded.
 */
export function probeRecentDocuments(): void {
  const paths = recents.slice();
  if (paths.length === 0) {
    if (unreachable.size > 0) unreachable = new Set();
    recomputeReachable();
    return;
  }
  const seq = ++probeSeq;
  void fetch("/api/fs/stat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((body: unknown) => {
      if (seq !== probeSeq || body === null || typeof body !== "object") return;
      const exists = (body as { exists?: unknown }).exists;
      if (exists === null || typeof exists !== "object") return;
      const canonical = (body as { canonical?: unknown }).canonical;
      const canonicalMap =
        canonical !== null && typeof canonical === "object"
          ? (canonical as Record<string, unknown>)
          : {};

      // Canonicalize the MRU to the resolver's form (the same form a Text card
      // binds on open), so a just-opened file dedupes out of RECENT instead of
      // stranding an orphan when the stored path and the card's bound path
      // differ only by symlink resolution (e.g. `/var` vs `/private/var`).
      let canonicalized = false;
      const rewritten: string[] = [];
      const remappedOpenedAt: Record<string, number> = {};
      const seen = new Set<string>();
      for (const path of recents) {
        const c = canonicalMap[path];
        const next = typeof c === "string" && c.length > 0 ? c : path;
        if (next !== path) canonicalized = true;
        // Carry the timestamp onto the canonical key (keep the newer on collision).
        const t = openedAt[path];
        if (t !== undefined) {
          remappedOpenedAt[next] = Math.max(remappedOpenedAt[next] ?? 0, t);
        }
        if (!seen.has(next)) {
          seen.add(next);
          rewritten.push(next);
        }
      }
      if (canonicalized) {
        recents = rewritten;
        openedAt = remappedOpenedAt;
        persist();
        publishRecentDocuments(recents);
      }

      const gone = new Set<string>();
      for (const path of paths) {
        if ((exists as Record<string, unknown>)[path] === false) {
          // Track the missing path under its canonical form so it matches the
          // (now-canonicalized) MRU entries.
          const c = canonicalMap[path];
          gone.add(typeof c === "string" && c.length > 0 ? c : path);
        }
      }
      const changed =
        canonicalized ||
        gone.size !== unreachable.size ||
        [...gone].some((p) => !unreachable.has(p));
      if (!changed) return;
      unreachable = gone;
      recomputeReachable();
      notifyRecentDocuments();
    })
    .catch(() => {
      // Best-effort — keep the current projection on transport failure.
    });
}

/**
 * Record `path` as the most-recent document: move it to the front,
 * de-dupe, cap, persist, and re-publish to the host.
 */
export function noteRecentDocument(path: string): void {
  if (path === "") return;
  // Stamp the open time — even when the MRU order doesn't move, "Last opened"
  // must advance. `persist()` prunes the map to the live MRU.
  openedAt[path] = Date.now();
  const next = capRecentDocuments([path, ...recents.filter((p) => p !== path)]);
  // A just-noted path was just opened — it is reachable by definition.
  const wasUnreachable = unreachable.has(path);
  if (wasUnreachable) {
    const cleared = new Set(unreachable);
    cleared.delete(path);
    unreachable = cleared;
  }
  if (next.length === recents.length && next.every((p, i) => p === recents[i])) {
    // The MRU order is unchanged, but the timestamp (and maybe reachability) moved.
    persist();
    if (wasUnreachable) recomputeReachable();
    notifyRecentDocuments();
    return;
  }
  recents = next;
  recomputeReachable();
  persist();
  publishRecentDocuments(recents);
  notifyRecentDocuments();
}

/** Empty the list (File ▸ Open Recent ▸ Clear Menu). */
export function clearRecentDocuments(): void {
  if (recents.length === 0) return;
  recents = [];
  openedAt = {};
  unreachable = new Set();
  recomputeReachable();
  persist();
  publishRecentDocuments(recents);
  notifyRecentDocuments();
}

/**
 * Write the list through tugbank (optimistic cache + durable PUT).
 * Defensive: persistence is best-effort, and the in-memory list already
 * drives the live menu — a cache/transport failure must never propagate
 * into the open flow that triggered it.
 */
function persist(): void {
  // Prune the timestamp map to the live MRU so it can't grow past the list.
  const prunedOpenedAt: Record<string, number> = {};
  for (const p of recents) {
    const t = openedAt[p];
    if (t !== undefined) prunedOpenedAt[p] = t;
  }
  openedAt = prunedOpenedAt;
  try {
    const client = getTugbankClient();
    client?.setLocalValue(TEXT_CARD_DEFAULTS_DOMAIN, RECENT_DOCUMENTS_KEY, {
      kind: "json",
      value: recents,
    });
    client?.setLocalValue(TEXT_CARD_DEFAULTS_DOMAIN, RECENT_DOCUMENTS_OPENED_AT_KEY, {
      kind: "json",
      value: openedAt,
    });
    void putDefault(RECENT_DOCUMENTS_KEY, recents);
    void putDefault(RECENT_DOCUMENTS_OPENED_AT_KEY, openedAt);
  } catch (err) {
    console.warn("[recent-documents] persist failed:", err);
  }
}

/** Durable PUT of one tugbank default (best-effort). */
function putDefault(key: string, value: unknown): Promise<void> {
  return fetch(`/api/defaults/${TEXT_CARD_DEFAULTS_DOMAIN}/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value }),
  })
    .then(() => undefined)
    .catch((err) => {
      console.warn("[recent-documents] PUT failed:", err);
    });
}
