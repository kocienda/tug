/**
 * GitCommitFilesStore — single-shot changed-files request/response for one
 * commit sha, over the GIT_COMMIT_FILES feeds.
 *
 * A History row expands into the list of files a commit touched. That list is
 * a one-shot, not a continuous feed: the row asks once (on first expand), and
 * tugcast answers with a single `GIT_COMMIT_FILES` (0x28) frame carrying the
 * name-status + ± counts for the sha — the light list, no unified diff text.
 * Each file's hunks are then fetched lazily per-row through the existing
 * commit-flavor GIT_DIFF path (see `CommitChangesList`).
 *
 * Correlation is entirely client-side: the response is a broadcast every store
 * sees, so the store-unique `gcf-<storeId>-<seq>` requestId is what keeps
 * concurrent stores (several commits expanded at once) from crossing wires.
 * One shared, unfiltered `FeedStore(conn, [GIT_COMMIT_FILES])` backs every
 * store; each subscribes and accepts only its own correlated response.
 *
 * Commits are immutable, so a re-expand of a resolved store reuses the ready
 * snapshot. Each expanded row owns its store for the lifetime of the expanded
 * body (created on mount, `dispose()`d on collapse/unmount).
 *
 * Laws: [L02] consumers read the store via `useSyncExternalStore`.
 *
 * @module lib/git-commit-files-store
 */

import { FeedStore } from "./feed-store";
import { FeedId } from "../protocol";
import { getConnection } from "./connection-singleton";

// ── Wire types (mirror tugcast-core `GitCommitFilesSnapshot`) ───────────────

/** One changed file in a commit's file list. */
export interface GitCommitFile {
  /** Path relative to the repo root (rename destination when renamed). */
  path: string;
  /** Name-status word: `created` | `modified` | `deleted` | `renamed`. */
  status: string;
  /** Added (`+`) line count; `0` for a binary file. */
  added: number;
  /** Removed (`−`) line count; `0` for a binary file. */
  removed: number;
}

/** A single-shot commit-files payload from tugcast (GIT_COMMIT_FILES feed). */
export interface GitCommitFilesPayload {
  request_id: string;
  workspace_key: string;
  sha: string;
  /** True when the project dir is not inside a git working tree. */
  no_repo: boolean;
  /** The commit's subject line; empty when the sha resolved to nothing. */
  subject: string;
  /**
   * The commit message body — everything after the subject, verbatim, with
   * trailing whitespace trimmed. Empty for a subject-only commit.
   */
  body: string;
  /** Author name; empty for the same reason. */
  author: string;
  /** Author email, shown beside the author name. */
  author_email: string;
  /** Author date, `YYYY-MM-DD`. */
  date: string;
  /**
   * Author date, strict ISO 8601 — the complete timestamp, carrying the time
   * `date` drops.
   */
  author_date: string;
  files: GitCommitFile[];
}

/** Lifecycle of the current/last commit-files request. */
export type GitCommitFilesPhase = "idle" | "loading" | "ready" | "error";

/** Reactive snapshot the expanded row renders via `useSyncExternalStore`. */
export interface GitCommitFilesStoreSnapshot {
  phase: GitCommitFilesPhase;
  /** Correlation id of the in-flight (or last) request; `null` before any. */
  requestId: string | null;
  /** The resolved payload when `phase === "ready"`. */
  payload: GitCommitFilesPayload | null;
  /** Human-readable error when `phase === "error"`. */
  error: string | null;
}

export const EMPTY_COMMIT_FILES_SNAPSHOT: GitCommitFilesStoreSnapshot = {
  phase: "idle",
  requestId: null,
  payload: null,
  error: null,
};

/** Parse a GIT_COMMIT_FILES feed payload into a `GitCommitFilesPayload`, or `null`. */
export function parseGitCommitFilesPayload(
  payload: unknown,
): GitCommitFilesPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.request_id !== "string") return null;
  if (!Array.isArray(p.files)) return null;
  return {
    request_id: p.request_id,
    workspace_key: typeof p.workspace_key === "string" ? p.workspace_key : "",
    sha: typeof p.sha === "string" ? p.sha : "",
    no_repo: p.no_repo === true,
    subject: typeof p.subject === "string" ? p.subject : "",
    body: typeof p.body === "string" ? p.body : "",
    author: typeof p.author === "string" ? p.author : "",
    author_email: typeof p.author_email === "string" ? p.author_email : "",
    date: typeof p.date === "string" ? p.date : "",
    author_date: typeof p.author_date === "string" ? p.author_date : "",
    files: p.files as GitCommitFile[],
  };
}

// ── GitCommitFilesStore ─────────────────────────────────────────────────────

/**
 * Store-instance counter baked into every `requestId` so concurrent requests
 * from different stores can never correlate to each other's responses — the
 * GIT_COMMIT_FILES response is a broadcast every client sees.
 */
let nextStoreId = 0;

export class GitCommitFilesStore {
  private _snapshot: GitCommitFilesStoreSnapshot = EMPTY_COMMIT_FILES_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private readonly _feedStore: FeedStore;
  private readonly _storeId: number;
  private _seq = 0;

  constructor(feedStore: FeedStore) {
    this._feedStore = feedStore;
    this._storeId = ++nextStoreId;
    this._unsubscribeFeed = feedStore.subscribe(() => this._onFeedUpdate());
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(FeedId.GIT_COMMIT_FILES);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;

    const parsed = parseGitCommitFilesPayload(payload);
    if (parsed === null) return;
    // Accept only the response correlated to the in-flight request.
    if (parsed.request_id !== this._snapshot.requestId) return;

    this._set({
      phase: "ready",
      requestId: parsed.request_id,
      payload: parsed,
      error: null,
    });
  }

  /**
   * Request the changed files for `sha` in `root`. Idempotent once fired: a
   * no-op while `loading` or `ready` (commits are immutable), so a re-expand
   * reuses the snapshot.
   */
  requestFiles(root: string, sha: string): void {
    const s = this._snapshot;
    if (s.phase === "loading" || s.phase === "ready") return;
    const conn = getConnection();
    if (!conn) {
      this._set({
        phase: "error",
        requestId: null,
        payload: null,
        error: "Lost the connection to tugcast.",
      });
      return;
    }
    this._seq += 1;
    const requestId = `gcf-${this._storeId}-${this._seq}`;
    this._set({ phase: "loading", requestId, payload: null, error: null });
    const query = { root, requestId, sha };
    const bytes = new TextEncoder().encode(JSON.stringify(query));
    conn.send(FeedId.GIT_COMMIT_FILES_QUERY, bytes);
  }

  private _set(next: GitCommitFilesStoreSnapshot): void {
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): GitCommitFilesStoreSnapshot => this._snapshot;

  dispose(): void {
    if (this._unsubscribeFeed) {
      this._unsubscribeFeed();
      this._unsubscribeFeed = null;
    }
    this._listeners.clear();
  }
}

// ── Shared feed store + factory ──────────────────────────────────────────────

/** The single unfiltered GIT_COMMIT_FILES feed store shared by every store. */
let _feedStore: FeedStore | null = null;

function sharedFeedStore(): FeedStore | null {
  if (_feedStore !== null) return _feedStore;
  const conn = getConnection();
  if (!conn) return null;
  _feedStore = new FeedStore(conn, [FeedId.GIT_COMMIT_FILES]);
  return _feedStore;
}

/**
 * A commit-files store with its own `requestId` space, for one expanded
 * History row. The caller owns it and calls `dispose()` on collapse/unmount.
 * Returns `null` with no connection (gallery / fixtures).
 */
export function createCommitFilesStore(): GitCommitFilesStore | null {
  const feedStore = sharedFeedStore();
  if (feedStore === null) return null;
  return new GitCommitFilesStore(feedStore);
}
