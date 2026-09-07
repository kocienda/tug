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

/**
 * The workspace a FILETREE frame answered for — the canonical absolute path
 * tugcast splices into every response as `workspace_key`.
 */
function readWorkspaceKey(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const key = (payload as { workspace_key?: unknown }).workspace_key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

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

  /**
   * The last query this store put on the wire, or `null` before it has sent
   * one. Read only to decide which response frame is this store's own — the
   * FILETREE feed is a shared broadcast, so a frame arriving here may be
   * another workspace answering another card.
   */
  private _lastSentQuery: string | null = null;

  /**
   * The workspace root the answers to this store's queries came from — the
   * canonical absolute path tugcast keys the workspace by, spliced into every
   * FILETREE frame. It is how an unrooted store learns where its results were
   * counted from: a query with no `root` falls through to the bootstrap
   * workspace, and only the answer says which directory that is.
   */
  private _answeredRoot: string | null = null;

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

    // Latch the root from the frame that answers what THIS store asked, and
    // only then. The gate is what keeps another card's answer from renaming
    // this store's root — and the query text alone is not enough of one
    // before a query exists: every workspace's filetree feed opens by
    // broadcasting an empty initial snapshot whose query is `""`, so a store
    // that had not yet asked anything would latch whichever workspace opened
    // last, which for an unrooted store is exactly the wrong directory. Until
    // this store has asked, it does not know, and `null` says so. A different
    // workspace answering the same query text is the one ambiguity left, and
    // it is the same one the results below already carry.
    if (this._lastSentQuery !== null && parsed.query === this._lastSentQuery) {
      const key = readWorkspaceKey(payload);
      if (key !== null) this._answeredRoot = key;
    }

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

  /**
   * The absolute directory this store's results are relative to, or `null`
   * when no answer has arrived yet.
   *
   * A store constructed with a `projectDir` already knows: that is the root
   * it routes its queries to. One without — the app-wide case, whose queries
   * fall through to tugcast's bootstrap workspace — learns it from the
   * answers, because the frontend is never told the bootstrap's path any
   * other way.
   *
   * The caller for this is a composer that has to hand a chip's gestures an
   * absolute address: an `@` mention's value is root-relative, so a field
   * completing against this store resolves against this root, and the two
   * agree by construction rather than by a second guess at the same path.
   */
  answeredRoot(): string | null {
    return this._projectDir ?? this._answeredRoot;
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
    this._lastSentQuery = query;
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
