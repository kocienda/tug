/**
 * Test-only doubles for tugcast frame I/O.
 *
 * `TestFrameChannel` is a pure frame I/O test seam: it mirrors the
 * subset of `TugConnection` that `CodeSessionStore` reaches through
 * (`send`, `onFrame`) and adds two test helpers:
 *
 * - `dispatchFrame(feedId, payload)` fires all registered `onFrame`
 *   callbacks synchronously with raw payload bytes.
 * - `dispatchDecoded(feedId, decoded)` JSON-encodes a decoded event and
 *   delegates to `dispatchFrame` — used by integration tests that hand
 *   the store parsed golden events.
 *
 * Every `send` call is recorded on `recordedFrames`; CODE_INPUT
 * payloads are decoded back to `InboundMessage` via
 * `decodeCodeInputPayload` so tests can assert on structured JSON
 * rather than chasing bytes.
 *
 * Connection lifecycle (open/close/reconnect) is owned by
 * `ConnectionLifecycle` — tests that need to drive transport events
 * construct a real lifecycle and call `lifecycle.notifyConnectionDidClose()`
 * etc. directly. This channel intentionally does not emit lifecycle
 * events, so the type system enforces that lifecycle and frame I/O
 * remain separate concerns.
 *
 * `MockFeedStore` is a self-contained `FeedStore` double that tests can
 * drive directly via `replay` / `replayRange` without constructing a
 * real connection.
 */

import {
  decodeCodeInputPayload,
  FeedId,
  type FeedIdValue,
} from "@/protocol";
import type { FeedStoreFilter } from "@/lib/feed-store";

function isStateChangeFrame(frame: {
  feedId: number;
  decoded: unknown;
}): boolean {
  if (frame.feedId !== FeedId.CONTROL) return false;
  const decoded = frame.decoded;
  if (!(decoded instanceof Uint8Array)) return false;
  try {
    const json = new TextDecoder().decode(decoded);
    const parsed = JSON.parse(json) as { action?: string };
    return parsed.action === "record_session_state_change";
  } catch {
    return false;
  }
}

/** A frame shape used by `MockFeedStore.replay` — already decoded. */
export interface MockFrame {
  feedId: FeedIdValue;
  decoded: unknown;
}

/**
 * Test double for the frame I/O surface of `TugConnection`. Records
 * outbound frames and replays incoming frames through registered
 * `onFrame` callbacks. Lifecycle events (open/close/reconnect) are
 * *not* part of this surface — drive those via `ConnectionLifecycle`
 * directly.
 */
export class TestFrameChannel {
  readonly recordedFrames: Array<{ feedId: number; decoded: unknown }> = [];

  private frameCallbacks: Map<number, Array<(payload: Uint8Array) => void>> =
    new Map();

  send(feedId: FeedIdValue, payload: Uint8Array, _flags?: number): void {
    if (feedId === FeedId.CODE_INPUT) {
      this.recordedFrames.push({
        feedId,
        decoded: decodeCodeInputPayload(payload),
      });
    } else {
      this.recordedFrames.push({ feedId, decoded: payload });
    }
  }

  /**
   * Recorded frames with `record_session_state_change` CONTROL
   * frames filtered out. The per-card `CodeSessionStore.dispatch`
   * wrapper fires one such CONTROL frame on every indicator-tone
   * triple change as a fire-and-forget persist — orthogonal to the
   * frames any user action emits. Tests that count or index frames
   * by user-driven semantics should read this list instead of the
   * raw `recordedFrames`. Tests that pin the state-change emission
   * itself read `recordedFrames` directly.
   */
  get recordedFramesExcludingStateChange(): Array<{
    feedId: number;
    decoded: unknown;
  }> {
    return this.recordedFrames.filter((f) => !isStateChangeFrame(f));
  }

  onFrame(feedId: number, callback: (payload: Uint8Array) => void): () => void {
    if (!this.frameCallbacks.has(feedId)) {
      this.frameCallbacks.set(feedId, []);
    }
    const list = this.frameCallbacks.get(feedId)!;
    list.push(callback);
    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  /**
   * Fire all registered `onFrame` callbacks for the given feedId with
   * raw payload bytes. Test-only.
   */
  dispatchFrame(feedId: FeedIdValue, payload: Uint8Array): void {
    const cbs = this.frameCallbacks.get(feedId);
    if (!cbs) return;
    for (const cb of cbs.slice()) {
      cb(payload);
    }
  }

  /**
   * JSON-encode a decoded event and dispatch it as a frame on the
   * given feedId. Test-only — bridges golden-probe events (already
   * decoded) into the real `FeedStore`'s onFrame pathway.
   */
  dispatchDecoded(feedId: FeedIdValue, decoded: unknown): void {
    const payload = new TextEncoder().encode(JSON.stringify(decoded));
    this.dispatchFrame(feedId, payload);
  }
}

/**
 * In-memory `FeedStore` double. Constructor signature mirrors the real
 * `FeedStore` (`conn`, `feedIds`, `decode?`, `filter?`) so the shape of
 * tests that target FeedStore semantics in isolation matches production
 * wiring. `replay` / `replayRange` feed pre-decoded frames through the
 * filter and notify subscribers — they are the only way state changes.
 */
export class MockFeedStore {
  private _data: Map<number, unknown> = new Map();
  private _listeners: Array<() => void> = [];
  private _disposed = false;
  private readonly _feedIds: ReadonlyArray<FeedIdValue>;
  private readonly _filter?: FeedStoreFilter;

  constructor(
    _conn: TestFrameChannel,
    feedIds: ReadonlyArray<FeedIdValue>,
    _decode?: (payload: Uint8Array) => unknown,
    filter?: FeedStoreFilter,
  ) {
    this._feedIds = feedIds;
    this._filter = filter;
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): Map<number, unknown> => {
    return this._data;
  };

  /** Replay an entire frame list through the filter + listener pipeline. */
  replay(frames: ReadonlyArray<MockFrame>): void {
    this.replayRange(frames, 0, frames.length);
  }

  /**
   * Replay a half-open `[start, end)` range of frames. Tests use this
   * to interleave store actions with fixture events (e.g. the Step 7
   * interrupt-mid-stream coverage).
   */
  replayRange(
    frames: ReadonlyArray<MockFrame>,
    start: number,
    end: number,
  ): void {
    if (this._disposed) return;
    for (let i = start; i < end; i++) {
      const frame = frames[i];
      if (!this._feedIds.includes(frame.feedId)) continue;
      if (this._filter && !this._filter(frame.feedId, frame.decoded)) continue;
      const next = new Map(this._data);
      next.set(frame.feedId, frame.decoded);
      this._data = next;
      for (const listener of this._listeners.slice()) {
        listener();
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    this._listeners = [];
  }
}
