/**
 * PromptHistoryStore — session-scoped prompt history over the append-only ledger.
 *
 * The store holds a **contiguous newest-suffix window** of each session's
 * corpus, not the corpus itself. The ledger keeps every prompt the user has
 * ever submitted, forever; the window is however much of the newest end has
 * been paged in so far. `hasMore` says whether older entries exist behind it,
 * and `extendOlder` pages backward when a provider walks off the top edge.
 *
 * Nothing in this module discards an entry. There is no entry cap, no byte
 * budget, and no truncation — those all existed because history used to be
 * re-serialized into the boot DEFAULTS frame, and it isn't any more.
 *
 * **Laws:** [L02] subscribe/getSnapshot store; external state enters React
 *           through `useSyncExternalStore` only.
 *           [L23] Persists to the ledger — a submitted prompt survives quit,
 *           and a failed append is retried and reported, never dropped.
 *
 * @module lib/prompt-history-store
 */

import type { HistoryProvider, TugTextEditingState } from "./tug-text-types";
import {
  appendPromptHistory,
  fetchPromptHistoryPage,
  patchPromptAtomPath,
} from "./prompt-history-api";
import { logSessionLifecycle } from "./session-lifecycle-log";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A serialized atom captures the subset of atom fields needed for persistence.
 * Used to restore file references and other inline atoms when navigating history.
 *
 * **References, never pixels.** An image atom persists its bytes-store id and
 * the absolute path of the original tugcast stored at drop time — never the
 * baked thumbnail. The preview a recalled prompt shows is re-derived from that
 * original by `rehydrateDraftAttachments`, which is also what makes the recall
 * resubmittable rather than merely legible.
 */
export interface SerializedAtom {
  position: number;
  type: string;
  label: string;
  value: string;
  /**
   * Bytes-store key for image atoms — the link back to the per-card
   * `AtomBytesStore` entry holding the image payload + thumbnail.
   * Without it a recalled image atom is severed from its bytes and
   * renders as inert placeholder text. Optional: non-image atoms
   * (file mentions, etc.) carry no id.
   */
  id?: string;
  /**
   * Absolute path of the original file tugcast stored at drop time. What
   * makes a recalled prompt *resubmittable* rather than merely legible: the
   * bytes are read back from here, so the recalled prompt ships a real image
   * block instead of a mention marker.
   *
   * Absent when the upload had not landed at submit time. That case is not
   * permanent — the bytes-store backfill completes the stored row through
   * `patchAtomPath` once the upload arrives.
   */
  path?: string;
}

/**
 * A single prompt history entry. Stores everything needed to restore the prompt
 * state when the user navigates Up/Down (or Opt-Up/Down) through history.
 */
export interface HistoryEntry {
  /** Client-generated stable id; the ledger's `client_entry_id`, and what makes an append idempotent. */
  id: string;
  /**
   * Ledger row id, present once the append has landed. Recall order is this
   * field's order; it is also the keyset cursor `extendOlder` pages behind and
   * the handle the atom-path backfill needs.
   */
  ledgerId?: number;
  sessionId: string;
  projectPath: string;
  route: string;
  text: string;
  atoms: SerializedAtom[];
  timestamp: number;
}

/**
 * Lightweight snapshot of PromptHistoryStore state for useSyncExternalStore.
 *
 * Only `totalEntries` is exposed. An earlier shape included `sessionEntries`
 * (count for `_lastActiveSessionId`), but that field's semantic meaning could
 * change without bumping `_version` (because `createRouteProvider` /
 * `createProvider` mutated `_lastActiveSessionId` without bumping). Snapshot
 * reference must change when observed state changes; keeping the field
 * created a stale-snapshot footgun. The `_lastActiveSessionId` field still
 * exists internally for non-snapshot paths.
 */
export interface PromptHistorySnapshot {
  totalEntries: number;
}

// ── SessionHistoryProvider ────────────────────────────────────────────────────

/**
 * Session-scoped HistoryProvider returned by PromptHistoryStore.createProvider().
 *
 * Manages cursor and draft state, same pattern as GalleryHistoryProvider.
 * Returns null from back() when the window can't advance — including the
 * window-edge case, where it first asks the store to page older entries in so
 * the next press can land.
 */
class SessionHistoryProvider implements HistoryProvider {
  /** Entry id the cursor rests on; null = at the draft. */
  private _cursorId: string | null = null;
  private _draft: TugTextEditingState = { text: "", atoms: [], selection: null };

  constructor(
    private readonly _sessionId: string,
    private readonly _store: PromptHistoryStore
  ) {}

  back(current: TugTextEditingState): TugTextEditingState | null {
    const entries = this._store._getSessionEntries(this._sessionId);
    const step = stepBack(entries, this._cursorId);
    if (step === null) {
      // Either the window is empty or the cursor sits on its oldest entry.
      // Both mean the same thing: page backward, so the next press has
      // somewhere to go.
      this._store._kickExtendOlder(this._sessionId);
      return null;
    }
    if (this._cursorId === null) this._draft = current;
    this._cursorId = step.id;
    return entryToEditingState(step);
  }

  forward(): TugTextEditingState | null {
    if (this._cursorId === null) return null;
    const entries = this._store._getSessionEntries(this._sessionId);
    const step = stepForward(entries, this._cursorId);
    if (step === null) {
      this._cursorId = null;
      return this._draft;
    }
    this._cursorId = step.id;
    return entryToEditingState(step);
  }

  resetToDraft(draft: TugTextEditingState): void {
    this._cursorId = null;
    this._draft = draft;
  }
}

/**
 * The entry one step older than `cursorId`, or the newest when the cursor is
 * at the draft. `null` when there is nowhere older to go inside this list.
 *
 * The cursor is an entry id rather than an index because the window grows at
 * both ends: paging prepends older entries and a submit appends a newer one,
 * and either would silently slide an index onto the wrong entry.
 */
function stepBack(
  entries: readonly HistoryEntry[],
  cursorId: string | null,
): HistoryEntry | null {
  if (entries.length === 0) return null;
  if (cursorId === null) return entries[entries.length - 1];
  const index = entries.findIndex((e) => e.id === cursorId);
  if (index <= 0) return null;
  return entries[index - 1];
}

/** The entry one step newer than `cursorId`, or `null` at the newest end. */
function stepForward(
  entries: readonly HistoryEntry[],
  cursorId: string,
): HistoryEntry | null {
  const index = entries.findIndex((e) => e.id === cursorId);
  if (index < 0 || index >= entries.length - 1) return null;
  return entries[index + 1];
}

/**
 * Route-scoped HistoryProvider returned by `PromptHistoryStore.createRouteProvider()`.
 *
 * Same shape as `SessionHistoryProvider` but with an extra filter: only
 * entries whose `route` field matches the configured route are
 * surfaced. Each route within a session therefore gets an independent
 * history timeline, matching the per-route-drafts semantics of
 * TugPromptEntry's TugPane state preservation payload.
 *
 * The route filter is why a window edge matters more here than for the session
 * provider: a route can have zero entries in the loaded window while the ledger
 * holds plenty behind it, so "no entries for this route" has to page backward
 * rather than resolve to a permanent dead end.
 *
 * Cursor and `_draft` are in-memory and per-provider. Callers that
 * create one provider per route and retain the reference across route
 * switches preserve their browsing position for each route.
 */
class RouteHistoryProvider implements HistoryProvider {
  private _cursorId: string | null = null;
  private _draft: TugTextEditingState = { text: "", atoms: [], selection: null };

  constructor(
    private readonly _sessionId: string,
    private readonly _store: PromptHistoryStore,
    private readonly _route: string,
  ) {}

  private _entries(): HistoryEntry[] {
    return this._store
      ._getSessionEntries(this._sessionId)
      .filter((e) => e.route === this._route);
  }

  back(current: TugTextEditingState): TugTextEditingState | null {
    const entries = this._entries();
    const allForSession = this._store._getSessionEntries(this._sessionId);
    logSessionLifecycle("history.provider_back", {
      session_id: this._sessionId,
      route: this._route,
      entries_for_session: allForSession.length,
      entries_for_route: entries.length,
      cursor_in: this._cursorId,
    });

    const step = stepBack(entries, this._cursorId);
    if (step === null) {
      // Zero entries for this route in the window is not a dead end either:
      // the window is a suffix of the whole corpus, and this route's entries
      // may all sit behind its top edge.
      this._store._kickExtendOlder(this._sessionId);
      return null;
    }
    if (this._cursorId === null) this._draft = current;
    this._cursorId = step.id;
    return entryToEditingState(step);
  }

  forward(): TugTextEditingState | null {
    if (this._cursorId === null) return null;
    const step = stepForward(this._entries(), this._cursorId);
    if (step === null) {
      this._cursorId = null;
      return this._draft;
    }
    this._cursorId = step.id;
    return entryToEditingState(step);
  }

  resetToDraft(draft: TugTextEditingState): void {
    this._cursorId = null;
    this._draft = draft;
  }
}

/** Convert a HistoryEntry into a TugTextEditingState for engine restore. */
function entryToEditingState(entry: HistoryEntry): TugTextEditingState {
  return {
    text: entry.text,
    atoms: entry.atoms.map((a) => ({
      position: a.position,
      type: a.type,
      label: a.label,
      value: a.value,
      id: a.id,
    })),
    selection: null,
  };
}

// ── PromptHistoryStore ────────────────────────────────────────────────────────

/**
 * PromptHistoryStore — L02-compliant store over the prompt ledger.
 *
 * - In-memory map of sessionId → the newest-suffix window of that session's
 *   entries, ascending.
 * - `push()` appends locally and hands the entry to the ledger outbox; the
 *   resolved row id is patched back onto the entry.
 * - `loadSession()` fetches the newest page on first access per session.
 * - `extendOlder()` pages backward from the window's top edge, single-flight.
 * - `patchAtomPath()` completes a stored atom's path after a late upload.
 * - createProvider()/createRouteProvider() return HistoryProviders. [L02]
 *
 * **Capacity:** none. The corpus is unbounded by design; the window is what's
 * bounded, and only by what has been asked for.
 */
export class PromptHistoryStore {
  private _sessions: Map<string, HistoryEntry[]> = new Map();
  private _loadedSessions: Set<string> = new Set();
  /** Whether older entries exist behind the window's top edge, per session. */
  private _hasMore: Map<string, boolean> = new Map();
  /**
   * Pending in-flight first-page load per session id. Lets concurrent
   * `loadSession(id)` callers share one fetch.
   */
  private _loadPromises: Map<string, Promise<void>> = new Map();
  /** Single-flight guard for backward paging, per session. */
  private _extendPromises: Map<string, Promise<void>> = new Map();
  private _listeners: Set<() => void> = new Set();
  private _lastActiveSessionId: string | null = null;
  private _version = 0;
  private _cachedSnapshot: PromptHistorySnapshot | null = null;
  private _cachedSnapshotVersion = -1;

  // ── L02: subscribe/getSnapshot ────────────────────────────────────────────

  /** Subscribe to store updates. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /**
   * Return the current snapshot. Lightweight — counts only.
   * Reference-stable across calls until `_version` changes; required
   * by `useSyncExternalStore` consumers (otherwise React detects a
   * "new" snapshot every render and loops infinitely).
   */
  getSnapshot = (): PromptHistorySnapshot => {
    if (
      this._cachedSnapshot !== null &&
      this._cachedSnapshotVersion === this._version
    ) {
      return this._cachedSnapshot;
    }
    let total = 0;
    for (const entries of this._sessions.values()) {
      total += entries.length;
    }
    const snap: PromptHistorySnapshot = { totalEntries: total };
    this._cachedSnapshot = snap;
    this._cachedSnapshotVersion = this._version;
    return snap;
  };

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Push a newly submitted entry onto the session's window and append it to
   * the ledger.
   *
   * The append is queued, ordered per session, and retried until it lands —
   * see `prompt-history-api`. The resolved row id is written back onto the
   * entry object the window holds, which is what later lets the atom-path
   * backfill name the row it wants to complete.
   */
  push(entry: HistoryEntry): void {
    const { sessionId } = entry;
    this._lastActiveSessionId = sessionId;

    let entries = this._sessions.get(sessionId);
    if (!entries) {
      entries = [];
      this._sessions.set(sessionId, entries);
    }

    entries.push(entry);

    void appendPromptHistory(entry).then((id) => {
      if (id !== null) entry.ledgerId = id;
    });

    this._version++;
    this._notifyListeners();
  }

  /**
   * Load the newest page of a session's history from the ledger.
   *
   * - Idempotent: returns the cached promise for any concurrent caller
   *   on the same `sessionId`; no-op if the session is already loaded.
   * - Marks `_loadedSessions` only on a successful fetch. A network error
   *   leaves the session unmarked so the next `createProvider` call retries.
   * - Dedups by client entry id, so entries pushed during the load window
   *   can't double up against the same rows coming back from the ledger.
   */
  async loadSession(sessionId: string): Promise<void> {
    if (this._loadedSessions.has(sessionId)) {
      logSessionLifecycle("history.load_skipped_already_loaded", {
        session_id: sessionId,
        in_memory_count: (this._sessions.get(sessionId) ?? []).length,
      });
      return;
    }
    const inFlight = this._loadPromises.get(sessionId);
    if (inFlight) {
      logSessionLifecycle("history.load_skipped_in_flight", {
        session_id: sessionId,
      });
      return inFlight;
    }
    logSessionLifecycle("history.load_start", { session_id: sessionId });

    const promise = (async () => {
      try {
        const page = await fetchPromptHistoryPage(sessionId);
        const existing = this._sessions.get(sessionId) ?? [];
        // Ledger rows first (older), then anything pushed while the fetch was
        // in flight. Dedup by client entry id.
        const seen = new Set<string>();
        const merged: HistoryEntry[] = [];
        for (const e of [...page.entries, ...existing]) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          merged.push(e);
        }
        if (merged.length > 0 || existing.length > 0) {
          this._sessions.set(sessionId, merged);
        }
        this._hasMore.set(sessionId, page.hasMore);
        this._loadedSessions.add(sessionId);
        logSessionLifecycle("history.load_complete", {
          session_id: sessionId,
          fetched_count: page.entries.length,
          merged_count: merged.length,
          has_more: page.hasMore,
          in_memory_after: (this._sessions.get(sessionId) ?? []).length,
        });
        // Bump on every successful load completion so observers can
        // see "loaded but empty" as a real transition, not a no-op.
        this._version++;
        this._notifyListeners();
      } catch (err) {
        logSessionLifecycle("history.load_error", {
          session_id: sessionId,
          error: String(err),
        });
        // Don't mark loaded on error — a future createProvider call
        // will try again. The in-memory state survives.
      } finally {
        this._loadPromises.delete(sessionId);
      }
    })();
    this._loadPromises.set(sessionId, promise);
    return promise;
  }

  /**
   * Page backward from the window's top edge, prepending what comes back.
   *
   * Single-flight per session, and a no-op when the window already reaches the
   * start of the corpus. The cursor is the oldest *ledger* id in the window;
   * a window holding only not-yet-landed local pushes has no cursor to page
   * behind, so it waits for the append to resolve rather than re-fetching the
   * newest page and duplicating itself.
   */
  async extendOlder(sessionId: string): Promise<void> {
    if (this._hasMore.get(sessionId) !== true) return;
    const inFlight = this._extendPromises.get(sessionId);
    if (inFlight) return inFlight;

    const entries = this._sessions.get(sessionId) ?? [];
    const oldest = entries.find((e) => e.ledgerId !== undefined)?.ledgerId;
    if (oldest === undefined) return;

    const promise = (async () => {
      try {
        const page = await fetchPromptHistoryPage(sessionId, oldest);
        const current = this._sessions.get(sessionId) ?? [];
        const seen = new Set(current.map((e) => e.id));
        const older = page.entries.filter((e) => !seen.has(e.id));
        this._sessions.set(sessionId, [...older, ...current]);
        this._hasMore.set(sessionId, page.hasMore);
        logSessionLifecycle("history.extend_older", {
          session_id: sessionId,
          before: oldest,
          fetched_count: page.entries.length,
          prepended_count: older.length,
          has_more: page.hasMore,
        });
        this._version++;
        this._notifyListeners();
      } catch (err) {
        logSessionLifecycle("history.extend_error", {
          session_id: sessionId,
          before: oldest,
          error: String(err),
        });
      } finally {
        this._extendPromises.delete(sessionId);
      }
    })();
    this._extendPromises.set(sessionId, promise);
    return promise;
  }

  /** Whether older entries exist behind this session's window. */
  hasMore(sessionId: string): boolean {
    return this._hasMore.get(sessionId) === true;
  }

  /**
   * Complete a stored atom's `path` — in the window and in the ledger row.
   *
   * Called when an upload lands after its prompt was already submitted, so the
   * appended row carries a pathless image atom. Best-effort: an entry the
   * window no longer holds is skipped, and the route itself answers a
   * no-longer-present row without error.
   */
  patchAtomPath(clientEntryId: string, atomId: string, path: string): void {
    let touched = false;
    for (const entries of this._sessions.values()) {
      const entry = entries.find((e) => e.id === clientEntryId);
      if (entry === undefined) continue;
      for (const atom of entry.atoms) {
        if (atom.id !== atomId || atom.path !== undefined) continue;
        atom.path = path;
        touched = true;
      }
    }
    void patchPromptAtomPath(clientEntryId, atomId, path);
    if (touched) {
      this._version++;
      this._notifyListeners();
    }
  }

  /**
   * Create a HistoryProvider scoped to a session.
   *
   * Kicks off loadSession() if not already loaded — the provider returns null
   * from back() until loading completes (matches HistoryProvider null contract).
   */
  createProvider(sessionId: string): HistoryProvider {
    this._lastActiveSessionId = sessionId;

    // Kick off background load if not already loaded.
    if (!this._loadedSessions.has(sessionId)) {
      void this.loadSession(sessionId);
    }

    return new SessionHistoryProvider(sessionId, this);
  }

  /**
   * Create a route-scoped HistoryProvider for the given session + route.
   *
   * Same semantics as `createProvider`, plus a `route` filter: only
   * entries whose `route` field matches are visible via `back()` /
   * `forward()`. Intended for compound inputs that present a per-route
   * history timeline (e.g. `TugPromptEntry`). Each provider instance
   * owns its own cursor + in-memory draft, so callers that cache one
   * provider per route keep their browsing position for that route
   * across route switches.
   */
  createRouteProvider(sessionId: string, route: string): HistoryProvider {
    this._lastActiveSessionId = sessionId;

    if (!this._loadedSessions.has(sessionId)) {
      void this.loadSession(sessionId);
    }

    return new RouteHistoryProvider(sessionId, this, route);
  }

  /**
   * Read the loaded entries for a session. Used by the prompt entry to
   * re-seed the per-card bytes store from stored attachment paths so
   * recalled prompts show their previews after a cold launch. Returns
   * the live array (do not mutate) or an empty array if not yet loaded.
   */
  getSessionEntries(sessionId: string): readonly HistoryEntry[] {
    return this._sessions.get(sessionId) ?? [];
  }

  // ── Internal helpers (used by the providers) ──────────────────────────────

  /** @internal — used by the providers to read the window. */
  _getSessionEntries(sessionId: string): HistoryEntry[] {
    return this._sessions.get(sessionId) ?? [];
  }

  /**
   * @internal — a provider walked off the window's top edge. Page backward so
   * the next press has somewhere to go. Fire-and-forget: `back()` answers null
   * now, and the arriving page notifies subscribers.
   */
  _kickExtendOlder(sessionId: string): void {
    void this.extendOlder(sessionId);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _notifyListeners(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}

// ── The shared instance ───────────────────────────────────────────────────────

let _sharedStore: PromptHistoryStore | null = null;

/**
 * The one prompt-history store the app runs on.
 *
 * The store is keyed by session id internally, every `push` appends to the
 * machine-global prompt ledger, and each session's entries page back in on
 * first access — so one instance serves every composer that has a corpus,
 * whatever surface it sits on. It lived as a module-private singleton in
 * `use-session-card-services.ts` while the Session cards were the only
 * clients; the Overview composer is the second, and a second instance would
 * mean two windows over one ledger with no way to notice they had diverged.
 */
export function sharedPromptHistoryStore(): PromptHistoryStore {
  _sharedStore ??= new PromptHistoryStore();
  return _sharedStore;
}
