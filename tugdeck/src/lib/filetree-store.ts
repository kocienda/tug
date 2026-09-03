/**
 * FileTreeStore — sends file completion queries and receives scored results.
 *
 * Subscribes to FILETREE (0x11) for scored responses. Sends queries on
 * FILETREE_QUERY (0x12) via the connection singleton.
 *
 * **Laws:** [L22] Text engine observes store directly for DOM-driven typeahead
 * updates — no React round-trip. [L07] Provider is a stable closure.
 *
 * @module lib/filetree-store
 */

import type { FeedStore, FeedStoreFilter } from "./feed-store";
import type { FeedIdValue } from "../protocol";
import { FeedId } from "../protocol";
import type { CompletionProvider, CompletionItem } from "./tug-text-types";
import { getConnection } from "./connection-singleton";

/**
 * Join the project root with a FILETREE result. FILETREE indexes
 * project-relative POSIX paths, so an absolute path — what opening a file
 * needs — is `root` + `/` + the result.
 */
export function resolveAgainstRoot(root: string, relative: string): string {
  const base = root.replace(/\/+$/, "");
  const rel = relative.replace(/^\/+/, "");
  return `${base}/${rel}`;
}

/**
 * FILETREE feed filter scoping frames to one workspace. Tugcast tags every
 * response with the `workspace_key` it answered for, and the feed is
 * shared, so a consumer that searches one project must drop frames that
 * answered another's query.
 */
export function workspaceFeedFilter(workspaceKey: string): FeedStoreFilter {
  return (_feedId, decoded) =>
    typeof decoded === "object" &&
    decoded !== null &&
    "workspace_key" in decoded &&
    (decoded as { workspace_key: unknown }).workspace_key === workspaceKey;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single scored result from tugcast's fuzzy matcher. */
export interface ScoredResult {
  path: string;
  score: number;
  matches: [number, number][];
  /** True for a directory entry (path also carries a trailing `/`). */
  is_dir?: boolean;
}

/** Snapshot of the current file tree query response. */
export interface FileTreeResultSnapshot {
  query: string;
  results: ScoredResult[];
  truncated: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const EMPTY_SNAPSHOT: FileTreeResultSnapshot = {
  query: "",
  results: [],
  truncated: false,
};

/** Parse a FILETREE response payload into a snapshot. Returns null if invalid. */
function parseResponsePayload(payload: unknown): FileTreeResultSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.query !== "string") return null;
  if (!Array.isArray(p.results)) return null;
  return {
    query: p.query,
    results: p.results as ScoredResult[],
    truncated: !!p.truncated,
  };
}

// ── FileTreeStore ─────────────────────────────────────────────────────────────

/**
 * FileTreeStore — query/response store for file completion.
 *
 * Sends queries to tugcast via FILETREE_QUERY, receives scored results on
 * FILETREE. Exposes a subscribable CompletionProvider for the @ trigger.
 */
export class FileTreeStore {
  private _snapshot: FileTreeResultSnapshot = { ...EMPTY_SNAPSHOT };
  private _responded = false;
  private _listeners: Set<() => void> = new Set();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private _feedId: FeedIdValue;
  /**
   * Absolute path of the card's project directory. Tugcast's
   * `FILETREE_QUERY` adapter uses this as the routing key into its
   * per-workspace registry. When set, every query carries `root` and
   * lands at the card's own filetree feed (with its `.tugattachignore`
   * and built-in secret filter applied). When undefined, queries fall
   * through to the bootstrap workspace (the tugtool repo, legacy
   * behavior). Per `arc/dev-atoms.md#step-pre-4`.
   */
  private _projectDir: string | undefined;

  constructor(feedStore: FeedStore, feedId: FeedIdValue, projectDir?: string) {
    this._feedId = feedId;
    this._projectDir = projectDir;
    this._unsubscribeFeed = feedStore.subscribe(() => {
      this._onFeedUpdate(feedStore);
    });
    // Initial check in case data is already available.
    this._onFeedUpdate(feedStore);
  }

  private _onFeedUpdate(feedStore: FeedStore): void {
    const map = feedStore.getSnapshot();
    const payload = map.get(this._feedId);

    // Reference comparison: only process if the payload reference changed.
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;

    const parsed = parseResponsePayload(payload);
    if (!parsed) return;

    this._snapshot = parsed;
    this._responded = true;
    for (const listener of this._listeners) {
      listener();
    }
  }

  /**
   * Whether any FILETREE response has landed for this workspace yet.
   *
   * The initial snapshot is indistinguishable from a real empty answer — both
   * are `{query: "", results: []}` — so a caller that wants to say "this
   * directory has no files" rather than leave a blank panel has to know the
   * backend actually answered. Flips once and stays true for the store's life;
   * a store is per-workspace, so a root change builds a fresh one.
   */
  hasResponded(): boolean {
    return this._responded;
  }

  /** Subscribe to store updates. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /** Return the current file tree result snapshot. */
  getSnapshot = (): FileTreeResultSnapshot => {
    return this._snapshot;
  };

  /**
   * Send a query to tugcast via FILETREE_QUERY.
   * Builds `{ query, root? }` JSON payload and sends as a binary frame.
   */
  sendQuery(query: string, root?: string): void {
    const conn = getConnection();
    if (!conn) return;
    const payload: Record<string, string> = { query };
    if (root !== undefined) payload.root = root;
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    conn.send(FeedId.FILETREE_QUERY, bytes);
  }

  /**
   * Returns a CompletionProvider for the @ trigger.
   *
   * The provider is a stable closure (L07) with an attached `subscribe`
   * method for L22 async result notification. Two invariants:
   *
   * 1. **Deduplication**: only sends FILETREE_QUERY when the query changes.
   * 2. **Staleness**: returns [] if snapshot.query doesn't match the request.
   */
  getFileCompletionProvider(): CompletionProvider {
    let lastSentQuery: string | null = null;
    let lastValidResults: CompletionItem[] = [];

    const provider = ((query: string): CompletionItem[] => {
      // Deduplication: only send when query changes.
      if (query !== lastSentQuery) {
        lastSentQuery = query;
        // Always include the card's projectDir (when known) as the
        // `root` field so tugcast routes to the per-card workspace
        // rather than the bootstrap (tugtool repo). When the field is
        // undefined, the adapter falls back to the bootstrap.
        this.sendQuery(query, this._projectDir);
      }

      // If the snapshot matches the current query, map fresh results.
      // Directory entries become `directory` atoms (folder glyph,
      // trailing-slash value) and gate the popup's Tab-descend.
      if (this._snapshot.query === query) {
        lastValidResults = this._snapshot.results.map((r) => ({
          label: r.path,
          atom: {
            kind: "atom" as const,
            type: r.is_dir ? "directory" : "file",
            label: r.path,
            value: r.path,
          },
          matches: r.matches,
        }));
      }

      // Return the last valid results — either fresh (snapshot matched) or
      // carried over from the previous query. Avoids the popup flash that
      // occurs when returning [] during the 2-5ms between query send and
      // response arrival.
      return lastValidResults;
    }) as CompletionProvider;

    provider.subscribe = (listener: () => void) => this.subscribe(listener);

    return provider;
  }

  /** Unsubscribe from FeedStore and clear listeners. */
  dispose(): void {
    if (this._unsubscribeFeed) {
      this._unsubscribeFeed();
      this._unsubscribeFeed = null;
    }
    this._listeners.clear();
  }
}
