/**
 * `RoutedFrameStore` — one session's frames of one CODE_OUTPUT type, as the
 * ingest host routed them ([P14]).
 *
 * The host decodes every CODE_OUTPUT frame once and sends the few types a
 * narrow per-session store folds — `/skills`, `/hooks`, `/btw` answers — to
 * that session's mirror as `routed-frame` patches, so the page neither
 * receives nor decodes the feed. The mirror hands each one to the store for
 * its type, which exposes it in a `FeedStore`'s shape: the last value per
 * feed id, in a new map on every frame, and a notify.
 *
 * **Laws:** [L02] External state enters React through useSyncExternalStore only.
 */

import type { FeedSnapshotSource } from "@/lib/feed-store";
import { Subscribable } from "@/lib/subscribable";

export class RoutedFrameStore extends Subscribable implements FeedSnapshotSource {
  private _data: Map<number, unknown> = new Map();
  private _disposed = false;

  constructor(readonly type: string) {
    super();
  }

  getSnapshot = (): Map<number, unknown> => this._data;

  /** Take one routed frame; every listener hears it, whichever of them throws. */
  accept(feedId: number, decoded: unknown): void {
    if (this._disposed) return;
    const next = new Map(this._data);
    next.set(feedId, decoded);
    this._data = next;
    this.notifyCatching((err, listener, i) => {
      const name = listener.name || `#${i}`;
      console.error(`[RoutedFrameStore] listener ${name} threw for '${this.type}':`, err);
    });
  }

  dispose(): void {
    this._disposed = true;
    this.clearListeners();
  }
}
