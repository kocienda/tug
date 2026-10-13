/**
 * Pub/sub bus for dev session-ledger CONTROL traffic.
 *
 * Tugcast's supervisor broadcasts:
 *   - `session_updated { session_id, fields | removed }` push frames after
 *     each successful ledger write.
 *   - `list_sessions_ok { workspace_key, sessions }` ack frames in response
 *     to a `list_sessions` CONTROL request.
 *   - `list_sessions_progress { project_dir, parsed, total }` throttled
 *     ticks while the phase-2 JSONL scan parses cache misses.
 *   - `trash_session_ok { session_id }` / `trash_session_err { reason }`
 *     ack frames in response to a `trash_session` request.
 *   - `trash_workspace_sessions_ok { workspace_key, count }` /
 *     `trash_workspace_sessions_err { reason }` ack frames.
 *   - `list_session_state_changes_ok { tug_session_id, rows }` /
 *     `list_session_state_changes_err { tug_session_id, reason }`
 *     ack frames in response to a `list_session_state_changes` request.
 *
 * `action-dispatch.ts` decodes those frames and forwards them through this
 * module's `publish*` functions; the `SessionLedgerStore` (step 4)
 * subscribes via `subscribeTo*` to populate its cache and resolve pending
 * promises.
 *
 * The bus is process-global. Multiple subscribers are allowed; new
 * subscribers receive subsequent events only — no replay buffer. The store
 * is the single intended subscriber in production; tests register their
 * own listeners.
 */

import type {
  CardBinding,
  ListSessionStateChangesErr,
  ListSessionStateChangesOk,
  SessionRow,
  SessionUpdatedPush,
} from "../protocol.ts";

type Listener<T> = (payload: T) => void;

function makeBus<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(payload: T): void {
      // Snapshot to allow unsubscription during dispatch without skipping
      // siblings. Listeners are expected to be fast and side-effect-free
      // (the store's listener writes to its in-memory cache + emits a tick).
      for (const listener of [...listeners]) {
        listener(payload);
      }
    },
    /** Test-only: remove every subscriber. */
    reset(): void {
      listeners.clear();
    },
  };
}

const sessionUpdatedBus = makeBus<SessionUpdatedPush>();
const listSessionsOkBus = makeBus<{
  project_dir: string;
  sessions: SessionRow[];
  dir_exists: boolean;
  /**
   * `true` for the cheap phase-1 emit (ledger rows only; the external
   * JSONL scan is still running on the host), `false` for the settled
   * phase-2 emit carrying the full union. Drives the picker's "scanning
   * terminal sessions…" indicator. Optional — absent is treated as
   * `false` (a single-shot response is already the settled union).
   */
  scanning?: boolean;
}>();
const listSessionsErrBus = makeBus<{ project_dir: string; reason: string }>();
/**
 * Throttled scan-progress ticks while the host's phase-2 JSONL scan
 * parses cache misses: `parsed` of `total` files done. Emitted only
 * when there are misses to parse — a warm pure-hit scan is silent.
 */
const listSessionsProgressBus = makeBus<{
  project_dir: string;
  parsed: number;
  total: number;
}>();
const listCardBindingsOkBus = makeBus<{ bindings: CardBinding[] }>();
const listCardBindingsErrBus = makeBus<{ reason: string }>();
const trashSessionOkBus = makeBus<{ session_id: string }>();
const trashSessionErrBus = makeBus<{ session_id: string; reason: string }>();
const listSessionStateChangesOkBus = makeBus<ListSessionStateChangesOk>();
const listSessionStateChangesErrBus = makeBus<ListSessionStateChangesErr>();

export const subscribeToSessionUpdated = sessionUpdatedBus.subscribe;
export const publishSessionUpdated = sessionUpdatedBus.publish;

export const subscribeToListSessionsOk = listSessionsOkBus.subscribe;
export const publishListSessionsOk = listSessionsOkBus.publish;

export const subscribeToListSessionsErr = listSessionsErrBus.subscribe;
export const publishListSessionsErr = listSessionsErrBus.publish;

export const subscribeToListSessionsProgress = listSessionsProgressBus.subscribe;
export const publishListSessionsProgress = listSessionsProgressBus.publish;

export const subscribeToListCardBindingsOk = listCardBindingsOkBus.subscribe;
export const publishListCardBindingsOk = listCardBindingsOkBus.publish;

export const subscribeToListCardBindingsErr = listCardBindingsErrBus.subscribe;
export const publishListCardBindingsErr = listCardBindingsErrBus.publish;

export const subscribeToTrashSessionOk = trashSessionOkBus.subscribe;
export const publishTrashSessionOk = trashSessionOkBus.publish;

export const subscribeToTrashSessionErr = trashSessionErrBus.subscribe;
export const publishTrashSessionErr = trashSessionErrBus.publish;

export const subscribeToListSessionStateChangesOk = listSessionStateChangesOkBus.subscribe;
export const publishListSessionStateChangesOk = listSessionStateChangesOkBus.publish;

export const subscribeToListSessionStateChangesErr = listSessionStateChangesErrBus.subscribe;
export const publishListSessionStateChangesErr = listSessionStateChangesErrBus.publish;

export function _resetSessionLedgerEventsForTest(): void {
  sessionUpdatedBus.reset();
  listSessionsOkBus.reset();
  listSessionsErrBus.reset();
  listSessionsProgressBus.reset();
  listCardBindingsOkBus.reset();
  listCardBindingsErrBus.reset();
  trashSessionOkBus.reset();
  trashSessionErrBus.reset();
  listSessionStateChangesOkBus.reset();
  listSessionStateChangesErrBus.reset();
}
