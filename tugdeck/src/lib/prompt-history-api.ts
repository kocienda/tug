/**
 * prompt-history-api — the deck's half of the append-only prompt ledger.
 *
 * Three jobs, and the ordering rule that ties them together:
 *
 * 1. `appendPromptHistory` POSTs a submitted prompt to `/api/prompt-history`
 *    and resolves the ledger row id. A failed POST is queued and retried, not
 *    dropped — the whole point of the ledger is that a submitted prompt is
 *    never lost, so there is no path here that gives up on one.
 * 2. `fetchPromptHistoryPage` reads a keyset page back.
 * 3. `flushPromptHistorySync` drains whatever is still queued with synchronous
 *    XHR, from the quit/unload path where a promise would never settle.
 *
 * **Appends are strictly serialized per session.** Recall order is ledger `id`
 * order, so `id` order has to equal submit order. A queued append therefore
 * blocks every later append *for that same session* until it lands; different
 * sessions drain independently. Without that, a failing prompt A retrying while
 * prompt B succeeds would give B the lower id and recall would show them
 * inverted.
 *
 * **Nothing here trims.** The outbox has no length cap and the retry ladder
 * never terminates in a drop: after the fast rungs it settles into a per-minute
 * retry and keeps going. What it does do is stop being quiet about it — once
 * the fast rungs are spent, the failure is published to `subscribeAppendFailures`
 * so the card can say which prompt has not persisted yet ([L31]).
 *
 * **Laws:** [L23] durable state — a submitted prompt reaches the ledger or the
 *           user is told it hasn't.
 *           [L31] a gesture produces the act or a visible reason, never silence.
 *
 * @module lib/prompt-history-api
 */

import type { HistoryEntry, SerializedAtom } from "./prompt-history-store";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

// ── Wire shapes ───────────────────────────────────────────────────────────────

/** A ledger row as `/api/prompt-history` serializes it (snake_case). */
interface PromptRowWire {
  id: number;
  session_id: string;
  route: string;
  text: string;
  atoms: SerializedAtom[];
  project_path: string;
  submitted_at_ms: number;
  client_entry_id: string;
}

interface PageResponseWire {
  entries: PromptRowWire[];
  has_more: boolean;
  before: number | null;
}

/** One page of history, oldest-first, as the store consumes it. */
export interface PromptHistoryPage {
  entries: HistoryEntry[];
  hasMore: boolean;
  before: number | null;
}

const APPEND_URL = "/api/prompt-history";
const ATOM_PATH_URL = "/api/prompt-history/atom-path";

/**
 * Retry delays for a failed append, in ms. Once these are spent the append
 * keeps retrying at {@link SUSTAINED_RETRY_MS} — the ladder never ends in a
 * drop, it only stops being fast about it.
 */
const FAST_RETRY_MS = [1_000, 5_000, 30_000];
const SUSTAINED_RETRY_MS = 60_000;

/**
 * The live ladder. Only the retry *timing* is adjustable, and only so tests
 * can exercise the retry path without sleeping through it — the rung count,
 * the ordering guarantee, and the never-give-up shape are fixed.
 */
let fastRetryMs: readonly number[] = FAST_RETRY_MS;
let sustainedRetryMs = SUSTAINED_RETRY_MS;

// ── Conversion ────────────────────────────────────────────────────────────────

function entryToWireBody(entry: HistoryEntry): string {
  return JSON.stringify({
    session_id: entry.sessionId,
    route: entry.route,
    text: entry.text,
    atoms: entry.atoms,
    project_path: entry.projectPath,
    submitted_at_ms: entry.timestamp,
    client_entry_id: entry.id,
  });
}

function wireRowToEntry(row: PromptRowWire): HistoryEntry {
  return {
    id: row.client_entry_id,
    ledgerId: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    route: row.route,
    text: row.text,
    atoms: Array.isArray(row.atoms) ? row.atoms : [],
    timestamp: row.submitted_at_ms,
  };
}

// ── Append-failure notice channel ─────────────────────────────────────────────

/** What a card needs to tell the user which prompt hasn't persisted. */
export interface AppendFailureNotice {
  sessionId: string;
  text: string;
  attempts: number;
}

const failureListeners = new Set<(notice: AppendFailureNotice) => void>();

/**
 * Subscribe to appends that have outlived the fast retry rungs. This is module
 * state a card reads through a callback, not store state React renders from —
 * the notice is a one-shot message, and the retry that produced it is still
 * running.
 */
export function subscribeAppendFailures(
  listener: (notice: AppendFailureNotice) => void,
): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

function publishAppendFailure(notice: AppendFailureNotice): void {
  for (const listener of failureListeners) {
    try {
      listener(notice);
    } catch (err) {
      tugDevLogStore.warn("prompt-history", "append-failure listener threw", {
        error: String(err),
      });
    }
  }
}

// ── The per-session outbox ────────────────────────────────────────────────────

interface QueuedAppend {
  entry: HistoryEntry;
  resolve: (id: number | null) => void;
  attempts: number;
  /** Set once the fast rungs are spent, so the notice publishes once. */
  noticed: boolean;
}

const queues = new Map<string, QueuedAppend[]>();
const draining = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function queueFor(sessionId: string): QueuedAppend[] {
  let q = queues.get(sessionId);
  if (q === undefined) {
    q = [];
    queues.set(sessionId, q);
  }
  return q;
}

/**
 * POST one queued append. Resolves the row id, or `null` when the request
 * failed and the entry should stay at the head of its queue.
 */
async function postAppend(entry: HistoryEntry): Promise<number | null> {
  const response = await fetch(APPEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: entryToWireBody(entry),
  });
  if (!response.ok) {
    throw new Error(`append rejected with ${String(response.status)}`);
  }
  const body = (await response.json()) as { id?: number };
  return typeof body.id === "number" ? body.id : null;
}

function retryDelayFor(attempts: number): number {
  return attempts <= fastRetryMs.length
    ? fastRetryMs[attempts - 1]
    : sustainedRetryMs;
}

/**
 * Drain a session's queue head-first. Returns when the queue empties or the
 * head fails — a failure arms a timer and leaves the head in place, which is
 * what holds later appends for the same session behind it.
 */
async function drain(sessionId: string): Promise<void> {
  if (draining.has(sessionId)) return;
  draining.add(sessionId);
  try {
    for (;;) {
      const q = queues.get(sessionId);
      const head = q?.[0];
      if (q === undefined || head === undefined) return;
      try {
        const id = await postAppend(head.entry);
        q.shift();
        head.resolve(id);
      } catch (err) {
        head.attempts += 1;
        const delay = retryDelayFor(head.attempts);
        tugDevLogStore.warn("prompt-history", "append failed, will retry", {
          session_id: sessionId,
          client_entry_id: head.entry.id,
          attempts: head.attempts,
          retry_in_ms: delay,
          error: String(err),
        });
        if (!head.noticed && head.attempts >= fastRetryMs.length) {
          head.noticed = true;
          publishAppendFailure({
            sessionId,
            text: head.entry.text,
            attempts: head.attempts,
          });
        }
        const existing = retryTimers.get(sessionId);
        if (existing !== undefined) clearTimeout(existing);
        retryTimers.set(
          sessionId,
          setTimeout(() => {
            retryTimers.delete(sessionId);
            void drain(sessionId);
          }, delay),
        );
        return;
      }
    }
  } finally {
    draining.delete(sessionId);
  }
}

/**
 * Append a submitted prompt to the ledger, resolving its row id.
 *
 * Resolves `null` only when the ledger accepted the row but answered without
 * an id — never as a "gave up" signal, because this function does not give up.
 */
export function appendPromptHistory(entry: HistoryEntry): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    queueFor(entry.sessionId).push({ entry, resolve, attempts: 0, noticed: false });
    void drain(entry.sessionId);
  });
}

/** How many appends are still waiting to land. Exposed for tests and diagnostics. */
export function pendingAppendCount(): number {
  let total = 0;
  for (const q of queues.values()) total += q.length;
  return total;
}

/**
 * Drain every queued append with synchronous XHR, in per-session submit order.
 *
 * Called from the deck's teardown save: the page is about to go away, so a
 * `fetch` promise would never settle. Order still matters here — each session's
 * entries go out oldest-first, one blocking request at a time.
 */
export function flushPromptHistorySync(): void {
  for (const [sessionId, q] of queues) {
    while (q.length > 0) {
      const head = q[0];
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", APPEND_URL, false);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(entryToWireBody(head.entry));
        if (xhr.status < 200 || xhr.status >= 300) {
          tugDevLogStore.warn("prompt-history", "sync append rejected", {
            session_id: sessionId,
            client_entry_id: head.entry.id,
            status: xhr.status,
          });
          break;
        }
        q.shift();
        let id: number | null = null;
        try {
          const body = JSON.parse(xhr.responseText) as { id?: number };
          if (typeof body.id === "number") id = body.id;
        } catch {
          // A 2xx with an unreadable body still means the row landed; the id
          // is only needed by the atom-path backfill, which is best-effort.
        }
        head.resolve(id);
      } catch (err) {
        tugDevLogStore.warn("prompt-history", "sync append failed", {
          session_id: sessionId,
          client_entry_id: head.entry.id,
          error: String(err),
        });
        break;
      }
    }
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Fetch one keyset page of a session's history, oldest-first.
 *
 * `before` is a ledger row id: the page returned holds the newest entries
 * *older* than it. Omit it for the newest page.
 */
export async function fetchPromptHistoryPage(
  sessionId: string,
  before?: number,
  limit?: number,
): Promise<PromptHistoryPage> {
  const params = new URLSearchParams({ session: sessionId });
  if (before !== undefined) params.set("before", String(before));
  if (limit !== undefined) params.set("limit", String(limit));
  // `cache: "no-store"` defeats the browser HTTP cache: another card in
  // another process may have appended to this session since the last read on
  // the same URL, and a reused response would show a stale corpus.
  const response = await fetch(`${APPEND_URL}?${params.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`page request failed with ${String(response.status)}`);
  }
  const body = (await response.json()) as PageResponseWire;
  return {
    entries: (body.entries ?? []).map(wireRowToEntry),
    hasMore: body.has_more === true,
    before: body.before ?? null,
  };
}

/**
 * Complete a stored atom's `path` after the fact.
 *
 * The upload can land after the prompt was submitted, so the appended row can
 * carry a pathless image atom. Best-effort by design: the route answers 200
 * with `{ok: false}` when the entry or atom is gone, and a transport failure is
 * logged rather than retried — the next submit of that attachment carries the
 * path, and a recalled prompt without one still shows what was attached.
 */
export async function patchPromptAtomPath(
  clientEntryId: string,
  atomId: string,
  path: string,
): Promise<boolean> {
  try {
    const response = await fetch(ATOM_PATH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_entry_id: clientEntryId,
        atom_id: atomId,
        path,
      }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch (err) {
    tugDevLogStore.warn("prompt-history", "atom-path patch failed", {
      client_entry_id: clientEntryId,
      atom_id: atomId,
      error: String(err),
    });
    return false;
  }
}

/** Test-only: forget every queued append and pending retry, and restore the ladder. */
export function __resetPromptHistoryOutbox(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  queues.clear();
  draining.clear();
  failureListeners.clear();
  fastRetryMs = FAST_RETRY_MS;
  sustainedRetryMs = SUSTAINED_RETRY_MS;
}

/** Test-only: shorten the retry ladder so its behavior can be observed in-test. */
export function __setRetryLadderForTest(fast: readonly number[], sustained: number): void {
  fastRetryMs = fast;
  sustainedRetryMs = sustained;
}
