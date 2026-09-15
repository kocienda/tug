/**
 * SessionLedgerStore — tugdeck-side cache for the tugcast session ledger.
 *
 * Backs the picker's session list view. Cached by raw user-typed
 * `projectDir` — the server matches the request against the ledger's
 * `project_dir` column (no client-side canonicalization needed). Sources:
 *
 * 1. **Initial load** — first time `getSnapshot(projectDir)` is called for
 *    a path, the store dispatches a `list_sessions` CONTROL request and
 *    returns `{ status: "pending", rows: [] }`. The server's
 *    `list_sessions_ok` ack settles the entry to `{ status: "ready", rows }`.
 *
 * 2. **Live updates** — the supervisor broadcasts `session_updated` push
 *    frames after every successful ledger write. The store patches the
 *    matching row in place (or removes it on `removed: true`), re-sorts by
 *    `last_used_at DESC`, and emits a listener tick.
 *
 * 3. **Connection bounce** — `connectionDidReconnect` invalidates every
 *    cached entry back to `idle`; the next `getSnapshot` for each workspace
 *    re-issues `list_sessions`. This catches any push the server emitted
 *    while the wire was down.
 *
 * 4. **Picker-open refresh** — `refresh(projectDir)` re-issues
 *    `list_sessions` for an already-settled path without dropping the
 *    cached rows (stale-while-revalidate). Terminal sessions and other
 *    out-of-band JSONL writers never emit `session_updated`, so the
 *    picker re-validates every time it opens.
 *
 * **Laws:** [L02] Picker reads enter React via `useSyncExternalStore` only.
 * The hook `useSessionLedger(workspaceKey)` wraps that contract.
 *
 * @module lib/session-ledger-store
 */

import { useSyncExternalStore } from "react";
import type { TugConnection } from "../connection";
import type { SessionRow } from "../protocol";
import {
  encodeTrashSession,
  encodeListSessions,
} from "../protocol";
import {
  subscribeToTrashSessionErr,
  subscribeToTrashSessionOk,
  subscribeToListSessionsErr,
  subscribeToListSessionsOk,
  subscribeToListSessionsProgress,
  subscribeToSessionUpdated,
} from "./session-ledger-events";
import { getConnectionLifecycle } from "./connection-lifecycle";

/**
 * A session that holds nothing: no turns, no recorded user prompt, and no
 * title. Claude writes a transcript for every launch, so a session abandoned
 * before its first prompt has nothing to resume into. The host drops these
 * from `list_sessions`; this mirrors the rule for the `session_updated` push
 * path, which would otherwise insert a just-spawned empty row into the list.
 */
export function isEmptySessionRow(row: SessionRow): boolean {
  const blank = (s: string | null): boolean => (s ?? "").trim().length === 0;
  return (
    row.turn_count === 0 && blank(row.last_user_prompt) && blank(row.name)
  );
}

export type WorkspaceLoadStatus = "idle" | "pending" | "ready" | "error";

export interface WorkspaceSnapshot {
  status: WorkspaceLoadStatus;
  rows: readonly SessionRow[];
  error?: { reason: string };
  /**
   * Whether `projectDir` is an existing directory on the tugcast host,
   * from `list_sessions_ok.dir_exists`. `undefined` until the first
   * settle. The picker reads it to disable Open before a doomed
   * `spawn_session` is sent.
   */
  dirExists?: boolean;
  /**
   * `true` while the host is still scanning on-disk JSONLs for external
   * (terminal-created) sessions — the phase-1 `list_sessions_ok` carries
   * the ledger rows immediately with `scanning: true`, then a phase-2
   * emit replaces this snapshot with the full union and `scanning: false`.
   * The picker shows a "scanning terminal sessions…" indicator while
   * `true` so a large project dir's multi-second scan reads as progress,
   * never a freeze. `false` once settled.
   */
  scanning?: boolean;
  /**
   * Determinate scan progress: `parsed` of `total` JSONLs streamed so
   * far, from the host's throttled `list_sessions_progress` ticks.
   * Present only while `scanning` and only when the scan actually had
   * files to parse (a warm pure-hit scan emits no ticks); cleared by
   * the phase-2 settle.
   */
  scanProgress?: { parsed: number; total: number };
}

const EMPTY_ROWS: readonly SessionRow[] = Object.freeze([]);
const IDLE_SNAPSHOT: WorkspaceSnapshot = Object.freeze({
  status: "idle",
  rows: EMPTY_ROWS,
});

/** Stable no-op subscribe for a ledger read whose answer cannot change. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};
const PENDING_SNAPSHOT: WorkspaceSnapshot = Object.freeze({
  status: "pending",
  rows: EMPTY_ROWS,
});

type TrashSessionResult = { ok: true } | { error: { reason: string } };

/**
 * How long {@link SessionLedgerStore.ensureListed} waits for a listing before
 * it resolves with whatever the snapshot then holds. Liveness, not a height
 * guess: a card must not be held off the deck by a server that never answers,
 * and nothing is measured until the wait ends one way or the other.
 */
const LISTING_WAIT_BOUND_MS = 2_000;

/**
 * Per-session-id index entry. Tracks which `projectDir` cache currently
 * holds the row so a `session_updated` push can locate the cached entry
 * without scanning every workspace. Used during patch + remove paths.
 */
interface RowLocation {
  projectDir: string;
}

export class SessionLedgerStore {
  private readonly conn: TugConnection;
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();
  /** Reverse index from session_id → workspace, kept in lockstep with snapshots. */
  private readonly rowLocations = new Map<string, RowLocation>();
  /**
   * Rows the LIST deliberately does not carry — a just-spawned session's
   * ({@link isEmptySessionRow}).
   *
   * Dropping them from the list is the picker's rule and it stays: nobody
   * should be offered an abandoned empty session to resume into. But the
   * drop threw away the only record the deck ever gets of WHEN a fresh
   * session was made — the spawn-time `session_updated` push carries the
   * full row, `created_at` and all, and the card's other source (the
   * replay anchor) reads the first turn's timestamp out of a JSONL that a
   * zero-turn session has not written. So the row is kept here instead of
   * discarded, and a surface that holds a session id and asks about THAT
   * session ({@link findRow}) is answered. A browse still sees nothing.
   */
  private readonly detachedRows = new Map<string, SessionRow>();
  private readonly listeners = new Set<() => void>();

  /** Resolves attached to in-flight `trash_session` calls, keyed by id. */
  private readonly pendingTrash = new Map<string, (r: TrashSessionResult) => void>();

  private readonly disposers: Array<() => void> = [];

  /**
   * Callers waiting for a listing to LAND for a path — {@link ensureListed}'s
   * resolvers, keyed by project dir and settled by the next `list_sessions_ok`
   * that answers the path, or by its `list_sessions_err`.
   */
  private readonly listingWaiters = new Map<string, Array<() => void>>();

  constructor(conn: TugConnection) {
    this.conn = conn;
    this.installSubscriptions();
  }

  /**
   * Free every subscription this store holds. Tests call this to keep the
   * pub/sub bus clean between cases; production discards the store at
   * process shutdown so this is rarely exercised.
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
   * Return the cached snapshot for `projectDir`. The first call for a
   * path triggers a CONTROL `list_sessions` request and returns
   * `{ status: "pending", rows: [] }`; the `list_sessions_ok` push settles
   * the entry to `{ status: "ready", rows }`.
   *
   * Per `useSyncExternalStore`'s contract this method is referentially
   * stable when state hasn't changed — pending callers see the same frozen
   * snapshot until a settle happens.
   */
  getSnapshot = (projectDir: string): WorkspaceSnapshot => {
    const cached = this.snapshots.get(projectDir);
    if (cached !== undefined) return cached;
    // First observation: kick the request and seed pending.
    this.snapshots.set(projectDir, PENDING_SNAPSHOT);
    this.requestList(projectDir);
    return PENDING_SNAPSHOT;
  };

  /**
   * Stale-while-revalidate re-fetch for an already-settled path. The
   * session list has out-of-band writers — terminal sessions append to
   * their JSONLs, new sessions appear on disk — that emit no
   * `session_updated` push, so a snapshot fetched once per connection
   * drifts stale. The picker calls this when it opens: the cached rows
   * stay on screen (status stays `ready`), `scanning` flips on for the
   * indicator, and the server's two-phase response refreshes the
   * snapshot in place (phase-1 ledger rows MERGE with the cached rows —
   * see `installSubscriptions` — so the list never flickers down to the
   * ledger-only subset while the JSONL scan runs).
   *
   * No-ops while a fetch is already in flight (pending or scanning);
   * unseen paths fall through to the normal `getSnapshot` request path.
   */
  refresh = (projectDir: string): void => {
    if (projectDir.length === 0) return;
    const cached = this.snapshots.get(projectDir);
    if (cached === undefined) {
      this.getSnapshot(projectDir);
      return;
    }
    if (cached.status !== "ready" || cached.scanning === true) return;
    this.snapshots.set(projectDir, { ...cached, scanning: true });
    this.tick();
    this.requestList(projectDir);
  };

  /**
   * Resolve once a listing for `projectDir` has LANDED after this call — the
   * first fetch when the path is unseen, the stale-while-revalidate refresh
   * when it is settled, or the request already in flight when one is.
   *
   * This is what lets the deck measure the Session picker BEFORE it commits
   * the card that shows it. The picker's height is its rows, and its rows are
   * this store's answer for the path it opens on: a measure taken over a
   * pending snapshot is a measure of the `checking…` placeholder, and the rows
   * that land a few frames later re-divide the column the card just arrived
   * in — the second motion the measure exists to remove.
   *
   * Which frame answers is the ledger's to say. The server lists in two
   * phases: the ledger's rows at once, then the union with the on-disk JSONL
   * scan, which on a large project takes seconds. When phase one carries
   * rows, it is the answer — those rows are what Tug knows about the path,
   * they settle the list's height, and the scan only ever adds. When phase
   * one carries NONE, the ledger knows nothing about this path and the scan
   * is the only source there is, so the wait runs to the settled frame; a
   * project of terminal-made sessions is listed by its scan or not at all,
   * and a picker measured over an empty list would be measured over nothing.
   *
   * `null` when there is nothing to wait for — an empty path, or a listing in
   * an error state the picker will show as it stands — so a caller with no
   * wait ahead of it can go on synchronously.
   *
   * The wait is bounded by {@link LISTING_WAIT_BOUND_MS}, past which it
   * resolves with whatever the snapshot then holds.
   */
  ensureListed(projectDir: string): Promise<void> | null {
    if (projectDir.length === 0) return null;
    const cached = this.snapshots.get(projectDir);
    if (cached === undefined) {
      this.getSnapshot(projectDir);
    } else if (cached.status === "error") {
      return null;
    } else if (cached.status === "ready" && cached.scanning !== true) {
      this.refresh(projectDir);
    }
    // Otherwise pending or scanning: the request already in flight answers
    // this call too.
    return new Promise<void>((resolve) => {
      let waiters = this.listingWaiters.get(projectDir);
      if (waiters === undefined) {
        waiters = [];
        this.listingWaiters.set(projectDir, waiters);
      }
      const settle = (): void => {
        clearTimeout(bound);
        resolve();
      };
      const bound = setTimeout(settle, LISTING_WAIT_BOUND_MS);
      waiters.push(settle);
    });
  }

  /**
   * A listing landed for `projectDir`: answer every {@link ensureListed}
   * caller it answers. A phase-one frame with no rows answers nobody — the
   * scan behind it is the only source for the path, and the waiters hold for
   * the settled frame — while every other frame, and an error, answers all.
   */
  private settleListingWaiters(projectDir: string, landed: WorkspaceSnapshot): void {
    const waiters = this.listingWaiters.get(projectDir);
    if (waiters === undefined) return;
    if (
      landed.status === "ready" &&
      landed.scanning === true &&
      landed.rows.length === 0
    ) {
      return;
    }
    this.listingWaiters.delete(projectDir);
    for (const settle of waiters) settle();
  }

  trashSession(sessionId: string, projectDir?: string): Promise<TrashSessionResult> {
    return new Promise((resolve) => {
      this.pendingTrash.set(sessionId, resolve);
      const frame = encodeTrashSession(sessionId, projectDir);
      this.conn.send(frame.feedId, frame.payload);
    });
  }

  /**
   * Flip every cached entry's status back to `idle` and discard rows. The
   * next `getSnapshot` for each workspace re-issues `list_sessions`.
   *
   * Called on `connectionDidReconnect` so a wire-bounce gap during which
   * the supervisor emitted unobserved `session_updated` pushes doesn't
   * leave the store advertising a stale view.
   */
  invalidateAll(): void {
    if (this.snapshots.size === 0 && this.detachedRows.size === 0) return;
    this.snapshots.clear();
    this.rowLocations.clear();
    this.detachedRows.clear();
    this.tick();
  }

  /**
   * The ledger's row for ONE session, wherever it is held: the workspace
   * listing if it is in one, else the detached spawn-time row the listing
   * deliberately omits ({@link detachedRows}).
   *
   * The question a card asks about its own session, which is not the
   * question the picker asks. Referentially stable while the row is
   * unchanged, so a `useSyncExternalStore` selector may return it directly.
   */
  findRow = (sessionId: string): SessionRow | null => {
    if (sessionId.length === 0) return null;
    const located = this.rowLocations.get(sessionId);
    if (located !== undefined) {
      const cached = this.snapshots.get(located.projectDir);
      const listed =
        cached?.rows.find((r) => r.session_id === sessionId) ?? null;
      if (listed !== null) return listed;
    }
    return this.detachedRows.get(sessionId) ?? null;
  };

  // ── internals ───────────────────────────────────────────────────────────

  private requestList(projectDir: string): void {
    const frame = encodeListSessions(projectDir);
    this.conn.send(frame.feedId, frame.payload);
  }

  private installSubscriptions(): void {
    this.disposers.push(
      subscribeToListSessionsOk(({ project_dir, sessions, dir_exists, scanning }) => {
        // Phase-1 frames (scanning: true) carry ledger rows only. When a
        // previous settle is on screen — the refresh-on-open path — keep
        // its rows for any session the phase-1 set doesn't cover, so the
        // list never collapses to the ledger subset while the JSONL scan
        // runs; and backfill content holes in the incoming rows from the
        // previous settle (same semantics as the host's union merge — a
        // sparser row never beats a richer one, so a zero-turn ledger
        // row can't transiently hide a session the last settle showed).
        // The phase-2 frame (scanning: false) is authoritative and
        // replaces wholesale.
        let merged: readonly SessionRow[] = sessions;
        const prev = this.snapshots.get(project_dir);
        if (
          scanning === true &&
          prev !== undefined &&
          prev.status === "ready" &&
          prev.rows.length > 0
        ) {
          const prevById = new Map(prev.rows.map((r) => [r.session_id, r]));
          const backfilled = sessions.map((row) => {
            const old = prevById.get(row.session_id);
            if (old === undefined) return row;
            prevById.delete(row.session_id);
            // `turn_count` is server-authoritative — the ledger value the
            // bridge reconciles to tugcode's `totalTurns` ([P02]/[P08]).
            // The old client `Math.max(incoming, old)` is dropped: it
            // pinned a stale-HIGH count over a correct downward reconcile
            // while a scan was in flight, so a session that legitimately
            // dropped from 10 → 5 stayed at 10 until phase-2. Now a
            // non-zero incoming count is taken AS-IS, reflecting the
            // reconcile immediately. The one exception is a *sparse* phase-1
            // ledger row that carries `0` (the count for this session lives
            // in the scan cache and lands at phase-2): a real reconcile
            // never yields 0 for a content-bearing session (totalTurns ≥ 1),
            // so a literal 0 is a hole, and we keep the prior settle's count
            // to avoid a "0 turns" flicker on refresh-on-open. Content holes
            // (prompt/name) are backfilled the same way.
            const turn_count =
              row.turn_count === 0 ? old.turn_count : row.turn_count;
            if (
              turn_count === row.turn_count &&
              row.last_user_prompt !== null &&
              row.name !== null
            ) {
              return row;
            }
            return {
              ...row,
              turn_count,
              last_user_prompt: row.last_user_prompt ?? old.last_user_prompt,
              name: row.name ?? old.name,
            };
          });
          merged = [...backfilled, ...prevById.values()];
        }
        const sorted = [...merged].sort(
          (a, b) => b.last_used_at - a.last_used_at,
        );
        // Refresh the reverse index for this projectDir: drop any stale ids
        // that previously pointed here, then re-index the current rows.
        for (const [sid, loc] of this.rowLocations) {
          if (loc.projectDir === project_dir) this.rowLocations.delete(sid);
        }
        for (const row of sorted) {
          this.rowLocations.set(row.session_id, { projectDir: project_dir });
          // The listing is authoritative for everything it carries, so a row
          // held detached while this path had no listing is now a second,
          // staler answer to the same question.
          this.detachedRows.delete(row.session_id);
        }
        // Status settles to "ready" on the phase-1 emit already — the
        // ledger rows are usable immediately, so the picker is interactive
        // (pick "New session", resume a recent) while `scanning` is still
        // true and external rows are en route. Progress ticks survive the
        // phase-1 frame (they may have started arriving first) and clear
        // on the settled phase-2 frame.
        const settled: WorkspaceSnapshot = {
          status: "ready",
          rows: Object.freeze(sorted),
          dirExists: dir_exists,
          scanning,
          ...(scanning === true && prev?.scanProgress !== undefined
            ? { scanProgress: prev.scanProgress }
            : {}),
        };
        this.snapshots.set(project_dir, settled);
        this.tick();
        this.settleListingWaiters(project_dir, settled);
      }),
      subscribeToListSessionsErr(({ project_dir, reason }) => {
        const failed: WorkspaceSnapshot = {
          status: "error",
          rows: EMPTY_ROWS,
          error: { reason },
        };
        this.snapshots.set(project_dir, failed);
        this.tick();
        this.settleListingWaiters(project_dir, failed);
      }),
      subscribeToListSessionsProgress(({ project_dir, parsed, total }) => {
        const cached = this.snapshots.get(project_dir);
        // Ticks only decorate an in-flight scan: pending (first fetch,
        // phase-1 not yet seen) or ready+scanning (refresh). A settled
        // snapshot ignores stragglers.
        if (cached === undefined) return;
        if (cached.status === "ready" && cached.scanning !== true) return;
        if (cached.status !== "ready" && cached.status !== "pending") return;
        this.snapshots.set(project_dir, {
          ...cached,
          scanProgress: { parsed, total },
        });
        this.tick();
      }),
      subscribeToSessionUpdated((push) => {
        if (push.removed) {
          this.removeRow(push.session_id);
          return;
        }
        if (push.fields !== undefined) {
          this.patchRow(push.session_id, push.fields);
        }
      }),
      subscribeToTrashSessionOk(({ session_id }) => {
        const resolve = this.pendingTrash.get(session_id);
        if (resolve === undefined) return;
        this.pendingTrash.delete(session_id);
        resolve({ ok: true });
      }),
      subscribeToTrashSessionErr(({ session_id, reason }) => {
        const resolve = this.pendingTrash.get(session_id);
        if (resolve === undefined) return;
        this.pendingTrash.delete(session_id);
        resolve({ error: { reason } });
      }),
    );
    // Connection-restore re-fetch hook: every reconnect (not the first
    // open) flips the cache back to idle so subsequent picker mounts
    // re-issue list_sessions and pick up any push frames missed during
    // the wire bounce. The lifecycle singleton may not be registered
    // yet (e.g., tests that mock the connection); skip the hook gracefully.
    const lifecycle = getConnectionLifecycle();
    if (lifecycle !== null) {
      this.disposers.push(
        lifecycle.observeConnectionDidReconnect(() => this.invalidateAll()),
      );
    }
  }

  /**
   * Patch a single row by id. The push carries the post-write row state;
   * we drop into the matching `projectDir` snapshot, replace or insert by
   * id, re-sort, and emit. A path with no settled listing has no list to
   * patch, so the row is held detached instead of dropped — see the branch's
   * own note, and {@link detachedRows}.
   */
  private patchRow(sessionId: string, row: SessionRow): void {
    // A content-empty row never enters the list — see `isEmptySessionRow`.
    // Spawn-time pushes carry exactly this shape, and the host already
    // filters them out of `list_sessions`. It is KEPT rather than dropped
    // (see `detachedRows`): the list must not carry it, and the card whose
    // session it is still has to be able to ask when it was made.
    if (isEmptySessionRow(row)) {
      this.detachedRows.set(sessionId, row);
      this.rowLocations.set(sessionId, {
        projectDir: this.rowLocations.get(sessionId)?.projectDir ?? row.project_dir,
      });
      this.tick();
      return;
    }
    // Locate the cache slot via the reverse index, falling back to the
    // payload's `project_dir` if the index doesn't yet know about this
    // session (the row was created on the server before the picker ever
    // fetched the path).
    const located = this.rowLocations.get(sessionId);
    const projectDir = located?.projectDir ?? row.project_dir;
    const cached = this.snapshots.get(projectDir);
    if (cached === undefined || cached.status !== "ready") {
      // No listing to patch into — but the push carried the whole row, and a
      // card bound to this session is asking about THIS session, not browsing
      // the workspace. Held detached ({@link detachedRows}) so `findRow`
      // answers it: dropping it left every masthead in an unlisted project
      // with no turn count, no size, and no last-used stamp, which is the
      // entire rest form of the activity line. The browse still sees nothing
      // until a real listing settles, and that settle takes the row over.
      this.detachedRows.set(sessionId, row);
      this.rowLocations.set(sessionId, { projectDir });
      this.tick();
      return;
    }
    // The listing is its home now, so the detached copy would only be a
    // second, staler answer to the same question.
    this.detachedRows.delete(sessionId);
    const existingIdx = cached.rows.findIndex((r) => r.session_id === sessionId);
    let nextRows: SessionRow[];
    if (existingIdx >= 0) {
      nextRows = cached.rows.slice();
      nextRows[existingIdx] = row;
    } else {
      nextRows = [...cached.rows, row];
    }
    nextRows.sort((a, b) => b.last_used_at - a.last_used_at);
    this.rowLocations.set(sessionId, { projectDir });
    this.snapshots.set(projectDir, {
      status: "ready",
      rows: Object.freeze(nextRows),
      dirExists: cached.dirExists,
      scanning: cached.scanning,
      scanProgress: cached.scanProgress,
    });
    this.tick();
  }

  private removeRow(sessionId: string): void {
    this.detachedRows.delete(sessionId);
    const located = this.rowLocations.get(sessionId);
    if (located === undefined) return;
    this.rowLocations.delete(sessionId);
    const cached = this.snapshots.get(located.projectDir);
    if (cached === undefined || cached.status !== "ready") return;
    const nextRows = cached.rows.filter((r) => r.session_id !== sessionId);
    if (nextRows.length === cached.rows.length) return;
    this.snapshots.set(located.projectDir, {
      status: "ready",
      rows: Object.freeze(nextRows),
      dirExists: cached.dirExists,
      scanning: cached.scanning,
      scanProgress: cached.scanProgress,
    });
    this.tick();
  }

  private tick(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Module-level reference to the singleton store. Wired by the connection
 * boot path (similar to `cardServicesStore.attachDeckManager`). `null`
 * before wire-up; tests construct their own instances.
 */
let _activeStore: SessionLedgerStore | null = null;

/**
 * Hook subscriptions, held at MODULE level rather than on the store.
 *
 * A card's masthead mounts before the connection is up, so its first
 * `useSyncExternalStore` subscribe runs while {@link _activeStore} is still
 * null. A subscribe that resolved the store at call time had nothing to
 * subscribe to and returned a no-op teardown — and since React only re-subscribes
 * when the subscribe function's identity changes, that reader stayed deaf for the
 * life of the mount: it never re-read, so it never reached the `getSnapshot` that
 * kicks `list_sessions`, so a card bound without the picker never listed its own
 * workspace and the activity line had no turn count, size, or last-used stamp to
 * report. The bus outlives the store; {@link attachSessionLedgerStore} forwards
 * the store's ticks into it and wakes everyone already waiting.
 */
const hookListeners = new Set<() => void>();

function subscribeToLedger(listener: () => void): () => void {
  hookListeners.add(listener);
  return () => {
    hookListeners.delete(listener);
  };
}

function notifyLedgerHooks(): void {
  for (const listener of [...hookListeners]) listener();
}

export function attachSessionLedgerStore(conn: TugConnection): SessionLedgerStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new SessionLedgerStore(conn);
  _activeStore.subscribe(notifyLedgerHooks);
  // The wake that lets a pre-connection reader re-read — and on that read,
  // kick the list it could not ask for before.
  notifyLedgerHooks();
  return _activeStore;
}

export function getSessionLedgerStore(): SessionLedgerStore | null {
  return _activeStore;
}

/**
 * Test-only: detach the singleton so each test can attach a fresh one
 * with its own mock connection.
 */
export function _resetSessionLedgerStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/**
 * React hook: subscribe to the ledger store and return the snapshot for
 * `projectDir` (the user-typed path). Returns the idle snapshot when no
 * store is attached (e.g., in a Storybook fixture or a minimal test
 * renderer). Empty string short-circuits to the idle snapshot — the
 * picker doesn't issue a request until the user has typed something.
 */
/**
 * React hook: the ledger's row for ONE session — the question every session
 * surface asks (its turn count, its size, when it was made, when it last
 * moved), as against the picker's browse of a whole workspace.
 *
 * It reads through {@link useSessionLedger} rather than beside it, so the
 * workspace listing is still kicked and subscribed exactly as before; what it
 * adds is the fallback to {@link SessionLedgerStore.findRow}, which also sees
 * the spawn-time row a fresh session's listing deliberately leaves out.
 *
 * @param held A row the CALLER already holds, when it does — the picker browses
 *   a whole workspace and has every row in hand before it mounts a single one.
 *   Given, it is the answer, and this hook registers no listener and issues no
 *   lookup: a surface that is already holding the row does not need to be woken
 *   to be told about it. That is the difference between a picker row costing two
 *   ledger subscriptions and costing none, times however many sessions the
 *   workspace has.
 */
export function useSessionLedgerRow(
  sessionId: string,
  projectDir: string,
  held?: SessionRow | null,
): SessionRow | null {
  const haveHeld = held !== undefined && held !== null;
  // The workspace listing: read for the rows it holds, and — the reason it is
  // read even when the answer comes from elsewhere — to kick and subscribe the
  // listing for `projectDir` exactly as before. A caller holding its own row
  // wants neither, and the empty path is how this hook says so.
  const snapshot = useSessionLedger(haveHeld ? "" : projectDir);
  // The row as its OWN subscription, not a read taken beside the one above.
  // `useSyncExternalStore` re-renders on a changed SNAPSHOT, and a row held
  // detached ({@link SessionLedgerStore.detachedRows}) never enters the
  // workspace snapshot — so a push that moved only the detached row left the
  // workspace read referentially identical, React bailed out of the render, and
  // the surface kept showing the facts from before the turn. `findRow` is
  // referentially stable while the row is unchanged, which is the contract this
  // needs.
  const found = useSyncExternalStore(
    haveHeld ? NOOP_SUBSCRIBE : subscribeToLedger,
    () =>
      haveHeld || sessionId.length === 0
        ? null
        : (_activeStore?.findRow(sessionId) ?? null),
    () => null,
  );
  if (haveHeld) return held;
  const listed =
    sessionId.length === 0
      ? null
      : (snapshot.rows.find((r) => r.session_id === sessionId) ?? null);
  return listed ?? found;
}

export function useSessionLedger(projectDir: string): WorkspaceSnapshot {
  return useSyncExternalStore(
    // The module bus, not `_activeStore.subscribe` — see {@link hookListeners}
    // for why resolving the store at subscribe time left early readers deaf.
    //
    // The empty path registers nothing. Its snapshot is the idle constant
    // whatever the store holds, so a listener on it could only ever wake a
    // reader to hand it the same object back — and the empty path is what every
    // caller with no workspace to ask about passes, which on a picker row is
    // one dead listener per session in the list.
    projectDir.length === 0 ? NOOP_SUBSCRIBE : subscribeToLedger,
    () => {
      if (projectDir.length === 0) return IDLE_SNAPSHOT;
      const store = _activeStore;
      if (store === null) return IDLE_SNAPSHOT;
      return store.getSnapshot(projectDir);
    },
    () => IDLE_SNAPSHOT,
  );
}
