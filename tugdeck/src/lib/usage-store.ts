/**
 * UsageStore — single-shot `/usage` request/response over the USAGE feeds.
 *
 * The `/usage` sheet asks tugcast for the subscription usage panel; tugcast runs
 * `claude -p "/usage"` and answers with a single `UsageSnapshot` on the USAGE
 * feed (0x90). This store sends the `USAGE_QUERY` (0x91) with a correlating
 * `requestId`, and resolves the response whose `request_id` matches. The panel
 * is account-global (not workspace-scoped), so a single app-level store serves
 * every card, reached through {@link UsageContext}.
 *
 * The raw panel text is parsed into {@link UsageData} by {@link parseUsageText}
 * so the reactive snapshot the sheet reads is already graphical-ready. A short
 * freshness window lets a re-open reuse the last result instead of re-shelling
 * `claude` each time.
 *
 * **Laws:** [L02] external state enters React through `useSyncExternalStore`.
 *
 * @module lib/usage-store
 */

import { FeedStore } from "./feed-store";
import { FeedId } from "../protocol";
import type { TugConnection } from "../connection";
import { parseUsageText, type UsageData } from "./usage-parse";

/** Lifecycle of the current/last `/usage` request. */
export type UsagePhase = "idle" | "loading" | "ready" | "error";

/** Reactive snapshot the sheet renders via `useSyncExternalStore`. */
export interface UsageStoreSnapshot {
  phase: UsagePhase;
  /** Correlation id of the in-flight (or last) request; `null` before any. */
  requestId: string | null;
  /** Parsed panel when `phase === "ready"`. */
  data: UsageData | null;
  /** Raw `claude -p "/usage"` text when ready (for diagnostics / fallback). */
  rawText: string | null;
  /** Human-readable error when `phase === "error"`. */
  error: string | null;
  /**
   * The account the last answered fetch ran as — whose usage `data` is. Kept
   * across a reload, like `data`, so the line doesn't blink out on Refresh.
   */
  account: UsageAccount | null;
}

/** The Claude account a usage fetch ran as (from `claude auth status`). */
export interface UsageAccount {
  email: string | null;
  subscriptionType: string | null;
}

const IDLE_SNAPSHOT: UsageStoreSnapshot = Object.freeze({
  phase: "idle",
  requestId: null,
  data: null,
  rawText: null,
  error: null,
  account: null,
});

/** Wire shape of a `UsageSnapshot` frame (mirrors tugcast-core). */
interface UsageWireFrame {
  request_id: string;
  ok: boolean;
  text: string;
  error?: string;
  account: UsageAccount | null;
}

function parseWire(payload: unknown): UsageWireFrame | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.request_id !== "string") return null;
  return {
    request_id: p.request_id,
    ok: p.ok === true,
    text: typeof p.text === "string" ? p.text : "",
    error: typeof p.error === "string" ? p.error : undefined,
    account: parseAccount(p.account),
  };
}

function parseAccount(raw: unknown): UsageAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const email = typeof a.email === "string" && a.email.length > 0 ? a.email : null;
  const subscriptionType =
    typeof a.subscription_type === "string" && a.subscription_type.length > 0
      ? a.subscription_type
      : null;
  if (email === null && subscriptionType === null) return null;
  return { email, subscriptionType };
}

/** Re-fetch only when the last successful result is older than this. */
const FRESHNESS_MS = 30_000;

export class UsageStore {
  private _snapshot: UsageStoreSnapshot = IDLE_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private readonly _connection: TugConnection;
  private readonly _feedStore: FeedStore;
  private readonly _unsubscribeFeed: () => void;
  private _lastPayloadRef: unknown = undefined;
  private _seq = 0;
  private _lastReadyAt = 0;
  private _nowMs: () => number;

  constructor(connection: TugConnection, nowMs: () => number = () => Date.now()) {
    this._connection = connection;
    this._nowMs = nowMs;
    // USAGE carries no workspace_key — account-global, intentionally unfiltered.
    this._feedStore = new FeedStore(connection, [FeedId.USAGE]);
    this._unsubscribeFeed = this._feedStore.subscribe(() => this._onFeedUpdate());
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(FeedId.USAGE);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;

    const wire = parseWire(payload);
    if (wire === null) return;
    // Only accept the response correlated to the in-flight request.
    if (wire.request_id !== this._snapshot.requestId) return;

    if (!wire.ok) {
      this._set({
        phase: "error",
        requestId: wire.request_id,
        data: null,
        rawText: wire.text.length > 0 ? wire.text : null,
        error: wire.error ?? "Couldn't load usage.",
        account: wire.account,
      });
      return;
    }
    this._lastReadyAt = this._nowMs();
    this._set({
      phase: "ready",
      requestId: wire.request_id,
      data: parseUsageText(wire.text),
      rawText: wire.text,
      error: null,
      account: wire.account,
    });
  }

  /**
   * Request the usage panel. Reuses a recent successful result within
   * {@link FRESHNESS_MS} (a re-open shouldn't re-shell `claude`); `force`
   * overrides that for an explicit refresh.
   */
  requestUsage(force = false): void {
    if (
      !force &&
      this._snapshot.phase === "ready" &&
      this._nowMs() - this._lastReadyAt < FRESHNESS_MS
    ) {
      return;
    }
    this._seq += 1;
    const requestId = `usage-${this._seq}`;
    this._set({
      phase: "loading",
      requestId,
      data: this._snapshot.data,
      rawText: this._snapshot.rawText,
      error: null,
      account: this._snapshot.account,
    });
    const bytes = new TextEncoder().encode(JSON.stringify({ requestId }));
    this._connection.send(FeedId.USAGE_QUERY, bytes);
  }

  private _set(next: UsageStoreSnapshot): void {
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): UsageStoreSnapshot => this._snapshot;

  /**
   * Test seam — apply a `UsageSnapshot` as if it had landed on the feed,
   * bypassing the connection and the request_id gate. Mirrors
   * `GitDiffStore._ingestForTest`.
   * @internal
   */
  _ingestForTest(payload: unknown): void {
    const wire = parseWire(payload);
    if (wire === null) throw new Error("UsageStore._ingestForTest: malformed payload");
    if (!wire.ok) {
      this._set({
        phase: "error",
        requestId: wire.request_id,
        data: null,
        rawText: wire.text.length > 0 ? wire.text : null,
        error: wire.error ?? "Couldn't load usage.",
        account: wire.account,
      });
      return;
    }
    this._lastReadyAt = this._nowMs();
    this._set({
      phase: "ready",
      requestId: wire.request_id,
      data: parseUsageText(wire.text),
      rawText: wire.text,
      error: null,
      account: wire.account,
    });
  }

  dispose(): void {
    this._unsubscribeFeed();
    this._feedStore.dispose();
    this._listeners.clear();
  }
}
