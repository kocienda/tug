/**
 * `SessionStateChangesStore` — per-`tugSessionId` snapshot cache for
 * the popover's state-change log.
 *
 * Hydrates from the persisted ledger on first observation (via
 * `loadSessionStateChanges` over the supervisor's CONTROL bridge),
 * then appends rows live as they are published by the per-card
 * `CodeSessionStore.dispatch` hook on every triple transition.
 *
 * **Laws.** [L02] — reads enter React through `useSyncExternalStore`
 * only via the `useSessionStateChanges` hook. The `getSnapshot`
 * method returns a referentially-stable array per `tugSessionId` so
 * pending callers don't render different array references between
 * ticks.
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { TugConnection } from "@/connection";
import {
  loadSessionStateChanges,
  type SessionStateChangeRow,
} from "@/lib/session-state-changes-reader";
import {
  subscribeToLocalSessionStateChange,
  type LocalSessionStateChange,
} from "@/lib/session-state-changes-local-events";

export type SessionStateChangesLoadStatus =
  | "idle"
  | "pending"
  | "ready"
  | "error";

export interface SessionStateChangesSnapshot {
  status: SessionStateChangesLoadStatus;
  rows: readonly SessionStateChangeRow[];
  error?: { reason: string };
}

const EMPTY_ROWS: readonly SessionStateChangeRow[] = Object.freeze([]);
const IDLE_SNAPSHOT: SessionStateChangesSnapshot = Object.freeze({
  status: "idle",
  rows: EMPTY_ROWS,
});
const PENDING_SNAPSHOT: SessionStateChangesSnapshot = Object.freeze({
  status: "pending",
  rows: EMPTY_ROWS,
});

export class SessionStateChangesStore {
  private readonly conn: TugConnection;
  private readonly snapshots = new Map<string, SessionStateChangesSnapshot>();
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];

  constructor(conn: TugConnection) {
    this.conn = conn;
    this.disposers.push(
      subscribeToLocalSessionStateChange((event) => this.onLocalChange(event)),
    );
  }

  /**
   * Free every subscription this store holds. Tests call this to
   * keep the bus clean between cases; production typically discards
   * the store at process shutdown so this is rarely exercised.
   */
  dispose(): void {
    for (const fn of this.disposers) fn();
    this.disposers.length = 0;
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Return the cached snapshot for `tugSessionId`. The first call
   * for a session triggers a `list_session_state_changes` CONTROL
   * request and returns `{ status: "pending", rows: [] }`; the
   * supervisor's response settles the entry to `ready`.
   *
   * Referentially stable per `tugSessionId` until a new row appends
   * or the load settles — same `useSyncExternalStore` contract the
   * rest of session-* stores follow.
   */
  getSnapshot = (tugSessionId: string): SessionStateChangesSnapshot => {
    const cached = this.snapshots.get(tugSessionId);
    if (cached !== undefined) return cached;
    this.snapshots.set(tugSessionId, PENDING_SNAPSHOT);
    void this.kickLoad(tugSessionId);
    return PENDING_SNAPSHOT;
  };

  /**
   * Drop the cached snapshot for `tugSessionId` so the next
   * `getSnapshot` re-issues a `list_session_state_changes` request.
   * Used on wire reconnect — the supervisor may have appended rows
   * during the wire-down window that the local pub/sub never saw
   * (the per-card store may have been disposed and re-constructed
   * by the deck's restore path).
   */
  invalidate(tugSessionId: string): void {
    if (!this.snapshots.has(tugSessionId)) return;
    this.snapshots.delete(tugSessionId);
    this.tick();
  }

  private async kickLoad(tugSessionId: string): Promise<void> {
    const result = await loadSessionStateChanges(this.conn, tugSessionId);
    if (!result.ok) {
      this.snapshots.set(tugSessionId, {
        status: "error",
        rows: EMPTY_ROWS,
        error: { reason: result.reason },
      });
      this.tick();
      return;
    }
    // The cache may already contain locally-published rows that
    // arrived while the load was in flight. Merge: server rows
    // first (history), then any local rows added after the load
    // kicked. Dedupe on `(atMs, phase, transportState,
    // interruptInFlight)` — the local publish and the server load
    // carry identical triples at identical timestamps.
    //
    // Every cached row counts as an addition, INCLUDING those
    // appended while the snapshot was still `pending`: a replay
    // burst right after a reload publishes a run of transitions
    // before the load settles, and `onLocalChange` keeps the
    // snapshot `pending` while appending them. The prior
    // `status === "pending" ? []` branch discarded exactly those
    // replay-published rows. A freshly-minted pending snapshot has
    // `rows: []`, so this stays a no-op when nothing was appended.
    const existing = this.snapshots.get(tugSessionId);
    const additions = existing?.rows ?? [];
    const merged = mergeRows(result.rows, additions);
    this.snapshots.set(tugSessionId, {
      status: "ready",
      rows: Object.freeze(merged),
    });
    this.tick();
  }

  private onLocalChange(event: LocalSessionStateChange): void {
    const cached = this.snapshots.get(event.tugSessionId);
    if (cached === undefined) {
      // Nobody is observing this session yet — drop the event. The
      // next `getSnapshot` will load the full history (which
      // includes this row) from the supervisor.
      return;
    }
    const newRow: SessionStateChangeRow = {
      atMs: event.atMs,
      phase: event.phase,
      transportState: event.transportState,
      interruptInFlight: event.interruptInFlight,
    };
    const nextRows = [...cached.rows, newRow];
    this.snapshots.set(event.tugSessionId, {
      status: cached.status === "pending" ? "pending" : "ready",
      rows: Object.freeze(nextRows),
    });
    this.tick();
  }

  private tick(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function mergeRows(
  loaded: readonly SessionStateChangeRow[],
  local: readonly SessionStateChangeRow[],
): SessionStateChangeRow[] {
  if (local.length === 0) return [...loaded];
  // Loaded rows come oldest-first by ledger insertion order. Build a
  // signature set of loaded rows, then append local rows whose
  // signature isn't already represented. O(n+m).
  const seen = new Set<string>();
  for (const r of loaded) seen.add(signature(r));
  const merged: SessionStateChangeRow[] = [...loaded];
  for (const r of local) {
    if (seen.has(signature(r))) continue;
    seen.add(signature(r));
    merged.push(r);
  }
  return merged;
}

function signature(r: SessionStateChangeRow): string {
  return `${r.atMs}|${r.phase}|${r.transportState}|${r.interruptInFlight ? 1 : 0}`;
}

/**
 * Module-level reference to the singleton store. Wired by the
 * connection boot path. `null` before wire-up; tests construct their
 * own instances.
 */
let _activeStore: SessionStateChangesStore | null = null;

export function attachSessionStateChangesStore(
  conn: TugConnection,
): SessionStateChangesStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new SessionStateChangesStore(conn);
  return _activeStore;
}

export function getSessionStateChangesStore(): SessionStateChangesStore | null {
  return _activeStore;
}

/**
 * Test-only: detach the singleton so each test can attach a fresh
 * instance with its own mock connection.
 */
export function _resetSessionStateChangesStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/**
 * React hook: subscribe to the state-changes store and return the
 * snapshot for `tugSessionId`. Returns the idle snapshot when no
 * store is attached (gallery / Storybook fixtures) or no session is
 * targeted. Empty string short-circuits — the hook caller hasn't
 * picked a card yet.
 */
export function useSessionStateChanges(
  tugSessionId: string,
): SessionStateChangesSnapshot {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => {
      if (tugSessionId.length === 0) return IDLE_SNAPSHOT;
      const store = _activeStore;
      if (store === null) return IDLE_SNAPSHOT;
      return store.getSnapshot(tugSessionId);
    },
    () => IDLE_SNAPSHOT,
  );
}
