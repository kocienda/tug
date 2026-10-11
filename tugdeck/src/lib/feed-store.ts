/**
 * FeedStore — external subscribable store for WebSocket feed data.
 *
 * Subscribes to one or more feed IDs via `TugConnection.onFrame()`, decodes
 * each payload, and exposes a `useSyncExternalStore`-compatible API so feed
 * data enters React as external state (L02 compliance).
 *
 * ## Optional session filter
 *
 * The 4th constructor argument is an optional `filter(feedId, decoded) =>
 * boolean` predicate. If present, each decoded payload is passed through
 * the filter before the internal map is updated; a `false` result drops
 * the frame silently (no snapshot mutation, no listener notification).
 *
 * The filter is applied **inside** the frame handler registered with
 * `TugConnection.onFrame`, which means it runs on both code paths for
 * free:
 *
 * 1. **Live frames** — `TugConnection.dispatch` invokes every registered
 *    callback with the payload bytes. Our handler decodes and filters.
 * 2. **Replay on subscribe** — `TugConnection.onFrame` synchronously
 *    replays the cached `lastPayload` for the feed id (if any) into the
 *    newly registered callback. That replay flows through the same
 *    handler, so the filter runs against cached payloads too.
 *
 * This is the `[D11]` filter scope: tugdeck-side per-card filters enforce
 * multi-session isolation on the shared CODE_OUTPUT replay buffer and on
 * the SESSION_STATE / SESSION_SIDEBAND broadcasts. Without this the
 * shared replay would leak frames from one session into another card's
 * store.
 *
 * **Laws:** [L02] External state enters React through useSyncExternalStore only.
 *
 * @module lib/feed-store
 */

import type { TugConnection } from "../connection";
import type { FeedIdValue } from "../protocol";

/**
 * Shared decode cache. `TugConnection.dispatch` hands the SAME payload
 * object to every registered callback, and shared feeds (CODE_OUTPUT /
 * SESSION_STATE / CONTROL) have one FeedStore per open card — without
 * the cache, every frame from any session is JSON-parsed once per card
 * and then dropped by all but the owning card's filter. WeakMap keying
 * means nothing is pinned: the entry dies with the payload buffer.
 *
 * The decoded value is shared by all consumers, so wire frames stay
 * what they already were by contract: immutable.
 */
const decodeCache = new WeakMap<Uint8Array, unknown>();

const utf8 = new TextDecoder();

/**
 * Dev/test builds enforce the immutability contract: decoded frames are
 * deep-frozen, so any consumer that mutates its "own" frame in place —
 * which would silently poison every sibling card and future replay
 * sharing the cached object — throws at the mutation site instead.
 * Production skips the freeze walk (contract enforcement, not a
 * per-frame cost the product pays).
 */
const FREEZE_SHARED_DECODES: boolean =
  import.meta.env?.DEV === true || import.meta.env?.NODE_ENV === "test";

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}

/** Default decoder: UTF-8 bytes → JSON.parse, one parse per frame. */
export function defaultDecode(payload: Uint8Array): unknown {
  const hit = decodeCache.get(payload);
  if (hit !== undefined) return hit;
  const decoded = JSON.parse(utf8.decode(payload));
  if (FREEZE_SHARED_DECODES) deepFreeze(decoded);
  decodeCache.set(payload, decoded);
  return decoded;
}

/**
 * Optional per-frame filter predicate. Receives the feed id and the
 * decoded payload and returns `true` to keep the frame or `false` to
 * drop it. See the module JSDoc for replay-path semantics.
 */
export type FeedStoreFilter = (feedId: FeedIdValue, decoded: unknown) => boolean;

/**
 * FeedStore holds decoded feed payloads in a `Map<number, unknown>`.
 *
 * Lifecycle:
 * - Constructed with a connection, a list of feed IDs, an optional
 *   decoder, and an optional filter.
 * - Subscribes to each feed ID via `connection.onFrame()`, capturing the
 *   returned unsubscribe.
 * - On each frame: decodes the payload, runs the optional filter, and
 *   (if accepted) replaces the internal map (new reference) so
 *   `useSyncExternalStore` detects the change.
 * - Disposed when the card unmounts — `dispose()` unregisters every feed
 *   callback from the (long-lived) connection, so a closed card leaves
 *   nothing behind. The connection outlives the store; without the
 *   unregister the callback closure would pin this store forever.
 */
export class FeedStore {
  private _data: Map<number, unknown> = new Map();
  private _listeners: Array<() => void> = [];
  private _disposed = false;
  private _filter?: FeedStoreFilter;
  /** Unregisters the feed callbacks; called by `dispose()`. */
  private _frameUnsubs: Array<() => void> = [];

  constructor(
    connection: TugConnection,
    feedIds: readonly FeedIdValue[],
    decode: (payload: Uint8Array) => unknown = defaultDecode,
    filter?: FeedStoreFilter,
  ) {
    this._filter = filter;
    for (const feedId of feedIds) {
      const unsub = connection.onFrame(feedId, (payload: Uint8Array) => {
        if (this._disposed) return;
        const feedHex = `0x${feedId.toString(16)}`;
        // Decode and filter are the frame's admission: a failure in
        // either is a decode failure for the feed, and the frame is
        // dropped before the snapshot moves.
        let decoded: unknown;
        try {
          decoded = decode(payload);
          // Session-scoped filter, per [D11]. Runs on both live frames
          // and the replay-on-subscribe path (see module JSDoc) because
          // `TugConnection.onFrame` replays the cached `lastPayload`
          // through this same handler. A `false` result drops the frame
          // silently — no snapshot mutation, no listener notify.
          if (this._filter && !this._filter(feedId, decoded)) {
            return;
          }
        } catch (err) {
          console.error(`[FeedStore] failed to decode payload for feed ${feedHex}:`, err);
          return;
        }
        // Create a new Map reference so useSyncExternalStore detects the change.
        const next = new Map(this._data);
        next.set(feedId, decoded);
        this._data = next;
        // Each listener is isolated: one that throws is reported as its
        // own exception, never as a decode failure, and the rest still run.
        // Iterate a copy so a listener that unsubscribes mid-notify does
        // not shift the ones after it.
        const listeners = this._listeners.slice();
        for (let i = 0; i < listeners.length; i++) {
          const listener = listeners[i];
          try {
            listener();
          } catch (err) {
            const name = listener.name || `#${i}`;
            console.error(`[FeedStore] listener ${name} threw for feed ${feedHex}:`, err);
          }
        }
      });
      this._frameUnsubs.push(unsub);
    }
  }

  /** Subscribe to store updates. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  /** Return the current feed data snapshot. */
  getSnapshot = (): Map<number, unknown> => {
    return this._data;
  };

  /**
   * Replace the current filter. Used by consumers whose filter predicate
   * depends on reactive state (e.g., `TugPane` when its `workspaceKey`
   * binding arrives asynchronously). Only affects future frames; cached
   * payloads already in the snapshot are left in place.
   */
  setFilter(filter?: FeedStoreFilter): void {
    this._filter = filter;
  }

  /** Dispose the store: unregister feed callbacks and drop listeners. */
  dispose(): void {
    this._disposed = true;
    for (const unsub of this._frameUnsubs) unsub();
    this._frameUnsubs = [];
    this._listeners = [];
  }
}
