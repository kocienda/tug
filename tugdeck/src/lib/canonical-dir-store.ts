/**
 * canonical-dir-store — the server's canonical spelling of each directory a
 * surface has asked about, cached for the life of the page.
 *
 * One directory has many spellings (a symlink and its target, `/tmp` and
 * `/private/tmp`, a firmlink), and only the server can say two of them are one
 * place ([L29]): the frontend never mints a canonical form of its own. So a
 * surface that COMPARES paths — "is this recent project the workspace's?" —
 * compares the server's answers, read here, never the spellings it was handed.
 *
 * The answers come from `/api/fs/stat` ({@link probeDirs}), batched: every path
 * first read in one task goes out in one round trip, and the store notifies
 * once the answers land. A path the server gives no canonical form for — one
 * it refuses, or a failed round trip — answers ITSELF, so a surface degrades
 * to comparing spellings rather than losing the path; that answer is cached
 * too, since re-asking on every render of a broken connection would be a loop
 * of requests.
 *
 * Laws: [L02] read through {@link useCanonicalDirs} (`useSyncExternalStore`);
 * [L29] the server is the only source of a canonical spelling.
 *
 * @module lib/canonical-dir-store
 */

import { useCallback } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { Subscribable } from "@/lib/subscribable";

import { probeDirs } from "./dir-existence";

class CanonicalDirStore extends Subscribable {
  private readonly answers = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private queued: Set<string> | null = null;
  private version = 0;

  /**
   * The canonical spelling of `path`, or `undefined` while the server has not
   * answered. The first read of a path asks for it.
   */
  canonicalOf(path: string): string | undefined {
    if (path === "") return "";
    const known = this.answers.get(path);
    if (known !== undefined) return known;
    if (!this.inFlight.has(path)) this.enqueue(path);
    return undefined;
  }

  /** Whether every path in `paths` has its answer. */
  allResolved(paths: readonly string[]): boolean {
    let resolved = true;
    for (const path of paths) {
      if (this.canonicalOf(path) === undefined) resolved = false;
    }
    return resolved;
  }

  getVersion = (): number => this.version;

  private enqueue(path: string): void {
    this.inFlight.add(path);
    if (this.queued !== null) {
      this.queued.add(path);
      return;
    }
    this.queued = new Set([path]);
    queueMicrotask(() => {
      const batch = [...(this.queued ?? [])];
      this.queued = null;
      void probeDirs(batch).then(({ canonical }) => {
        for (const path of batch) {
          this.answers.set(path, canonical[path] ?? path);
          this.inFlight.delete(path);
        }
        this.version += 1;
        this.notify();
      });
    });
  }

  /** For tests: forget every answer. */
  _resetForTest(): void {
    this.answers.clear();
    this.inFlight.clear();
    this.queued = null;
    this.version += 1;
  }

  /** For tests: answer `path` without a round trip. */
  _setForTest(path: string, canonical: string): void {
    this.answers.set(path, canonical);
    this.version += 1;
    this.notify();
  }
}

/** The page's one canonical-directory cache. */
export const canonicalDirStore = new CanonicalDirStore();

/**
 * A path's identity for comparison: the server's canonical spelling, or the
 * path itself while that is not yet known.
 */
export type CanonicalOf = (path: string) => string;

/**
 * React hook: a {@link CanonicalOf} that re-renders its reader when answers
 * land ([L02]). The function is a new reference whenever the store has moved,
 * so a `useMemo` keyed on it recomputes then and only then.
 */
export function useCanonicalDirs(): CanonicalOf {
  const version = useSyncExternalStore(
    canonicalDirStore.subscribe,
    canonicalDirStore.getVersion,
    canonicalDirStore.getVersion,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the store's change signal: the function reads the store, which moved
  return useCallback((path: string) => canonicalDirStore.canonicalOf(path) ?? path, [version]);
}

/** {@link CanonicalOf} as the store stands, for a reader outside a render. */
export function readCanonicalOf(path: string): string {
  return canonicalDirStore.canonicalOf(path) ?? path;
}
