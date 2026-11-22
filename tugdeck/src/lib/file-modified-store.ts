/**
 * file-modified-store.ts — when each file was last written on disk, by path.
 *
 * The Workspaces card's Activity view orders files by their modification time
 * on disk, newest first. The in-app save time cannot answer that: it lives in
 * memory, is gone after a relaunch, and never sees a save made outside Tug. A
 * file's mtime survives both, and it is the same clock whoever wrote the file.
 *
 * Two things feed it, so a time is known wherever the deck has one:
 *
 *  - every read and write through `lib/file-io.ts` records the `mtimeMs` it
 *    came back with, so a Text card loading, reloading or saving on this page
 *    moves its file's time the moment the bytes land;
 *  - {@link FileModifiedStore.request} stats a batch of paths through
 *    `POST /api/fs/stat`, for a file whose card has no buffer on this page —
 *    one in a workspace nobody has stood up, or mounted in another page.
 *
 * A path with no known time reads `null`, which the caller sorts last.
 *
 * Laws: [L02] `subscribe` + `getVersion` for `useSyncExternalStore`.
 *
 * @module lib/file-modified-store
 */

import { createSubscribable } from "./subscribable";

/** `POST /api/fs/stat` answers for at most this many paths per request. */
const STAT_BATCH = 64;

export class FileModifiedStore {
  private readonly times = new Map<string, number>();
  private readonly listeners = createSubscribable();
  private version = 0;

  subscribe = (listener: () => void): (() => void) =>
    this.listeners.subscribe(listener);

  /** Bumps whenever any path's time moves. */
  getVersion = (): number => this.version;

  /** The file's last modification time in ms since the epoch, or `null`. */
  get(path: string): number | null {
    return this.times.get(path) ?? null;
  }

  /**
   * Record a time a disk read or write reported. A zero is the wire's
   * "unknown" and records nothing; a time equal to the one held changes
   * nothing and notifies nobody.
   */
  record(path: string, mtimeMs: number): void {
    if (!(mtimeMs > 0) || this.times.get(path) === mtimeMs) return;
    this.times.set(path, mtimeMs);
    this.bump();
  }

  /** Forget a path whose file is gone. */
  forget(path: string): void {
    if (this.times.delete(path)) this.bump();
  }

  /**
   * Stat `paths` and record each one's time. Re-asks for paths already known,
   * because a file can be written by something this page never hears from.
   * Never throws: a failed or refused probe leaves what is held as it was.
   */
  async request(paths: readonly string[]): Promise<void> {
    const unique = [...new Set(paths)].filter((p) => p.length > 0);
    for (let i = 0; i < unique.length; i += STAT_BATCH) {
      await this.statBatch(unique.slice(i, i + STAT_BATCH));
    }
  }

  private async statBatch(paths: readonly string[]): Promise<void> {
    let body: unknown;
    try {
      const res = await fetch("/api/fs/stat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, kind: "file" }),
      });
      if (!res.ok) return;
      body = await res.json();
    } catch {
      return;
    }
    const answers = readStatTimes(body);
    if (answers === null) return;
    let moved = false;
    for (const path of paths) {
      const exists = answers.exists[path];
      const mtime = answers.mtimeMs[path];
      if (exists === false) {
        moved = this.times.delete(path) || moved;
      } else if (typeof mtime === "number" && mtime > 0 && this.times.get(path) !== mtime) {
        this.times.set(path, mtime);
        moved = true;
      }
    }
    if (moved) this.bump();
  }

  private bump(): void {
    this.version += 1;
    this.listeners.notifyCatching((err) => {
      console.warn("[FileModifiedStore] listener error:", err);
    });
  }

  /** @internal Test seam. */
  _resetForTest(): void {
    this.times.clear();
    this.listeners.clearListeners();
    this.version = 0;
  }
}

/**
 * The two maps of a stat answer this store reads, or `null` when the body is
 * not shaped like one. An answer from an older tugcast has no `mtimeMs` and
 * reads as one that knows no times.
 */
export function readStatTimes(body: unknown): {
  exists: Record<string, unknown>;
  mtimeMs: Record<string, unknown>;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const asMap = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  return { exists: asMap(record.exists), mtimeMs: asMap(record.mtimeMs) };
}

export const fileModifiedStore = new FileModifiedStore();
