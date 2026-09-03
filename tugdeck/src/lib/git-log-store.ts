/**
 * GitLogStore — a single shared, request-correlated store for the Git History
 * rail section, over the GIT_LOG feeds.
 *
 * Git History shows one project at a time (the followed session card's), so unlike
 * the per-entry `GitDiffStore` fan-out this is one module-level store over one
 * shared `FeedStore(conn, [GIT_LOG])`. `requestLog(projectDir)` sends a
 * `GIT_LOG_QUERY` (0x26) carrying the project dir as `root` plus a correlating
 * `requestId`; tugcast answers with a single `GIT_LOG` (0x25) frame. The
 * response is a broadcast every client sees, so correlation is entirely
 * client-side: the `gl-<storeId>-<seq>` id is what keeps stores from crossing
 * wires, and only the response whose `request_id` matches the in-flight request
 * is accepted.
 *
 * A requested-key guard makes `requestLog` idempotent — re-renders and collapse
 * toggles can call it freely; a fresh query fires only when the project changes
 * or the last request errored. `refresh()` re-requests the current root
 * unconditionally (mount-time request + future affordances).
 *
 * ## Paging
 *
 * The log is read one page at a time. `requestLog` asks for the newest
 * {@link GIT_LOG_PAGE_SIZE} commits; {@link GitLogStore.loadMore} asks for the
 * next page, skipping everything already held, and APPENDS it — the snapshot's
 * `payload.commits` is the accumulated walk, not the last page. `has_more`
 * comes from the server (which measures it by walking one commit past the
 * page), so the client never guesses whether history has run out.
 *
 * A page past the first is loaded WITHOUT dropping what is on screen:
 * `loadingMore` goes true while `phase` stays `ready` and the payload stands.
 * The list only ever grows at the bottom, so the scroller's offset stays
 * meaningful and the reader's place does not move under them.
 *
 * A `refresh()` (a `GIT_HEAD` move, a reconnect) re-reads the WHOLE loaded span
 * in one request rather than resetting to page one, so a reader who has
 * scrolled deep does not get yanked back to HEAD by someone else's commit. It
 * also keeps the current payload visible while the re-read is in flight —
 * only a change of ROOT blanks the list, because only then is what is on
 * screen about the wrong project.
 *
 * `formatGitLog` (the section's text presentation) lives here too so it is
 * unit-testable without React or a live connection.
 *
 * Laws: [L02] consumers read the store via `useSyncExternalStore`.
 *
 * @module lib/git-log-store
 */

import { FeedStore } from "./feed-store";
import { FeedId } from "../protocol";
import { getConnection } from "./connection-singleton";

// ── Wire types (mirror tugcast-core `GitLogSnapshot`) ───────────────────────

/** One commit in a `git log` payload. */
export interface GitLogCommit {
  /** Full 40-char commit hash. Shortened for display. */
  sha: string;
  /** The commit subject line (`%s`). */
  subject: string;
  /** The commit message body (`%b`) — everything after the subject, trailing
   *  whitespace trimmed. Empty for a subject-only commit. Revealed on expand. */
  body?: string;
  /** Author name (`%an`) — the compact identity on the collapsed row. */
  author: string;
  /** Author date, `--date=short` (`YYYY-MM-DD`) — the compact row date. */
  date: string;
  /** Committer name (`%cn`) — the full identity revealed on expand. */
  committer?: string;
  /** Committer email (`%ce`) — shown beside the committer name on expand. */
  committer_email?: string;
  /** Committer date, strict ISO 8601 (`%cI`) — the complete timestamp the
   *  expanded row formats for display. */
  committer_date?: string;
  /** The `Tug-Arc:` trailer value when the commit landed as an arc join —
   *  drives the History join badge ([P09]). */
  tug_arc?: string;
  /** The `Tug-Session:` trailer value — the human citation, raw ([P10]).
   *  New-form commits carry `<tag> (<shortid8>)`; legacy commits carry
   *  `<display> (<full-uuid>)`, and both must render, since legacy commits
   *  live in history forever. Never appears in `body` — tugcast strips every
   *  Tug trailer line before the body ships. */
  tug_session?: string;
  /** The `Tug-Session-Id:` trailer value — the full tug session uuid, the
   *  exact ledger join. Machine-only; never displayed. Absent on every legacy
   *  commit, which resolve through `tug_session`'s parenthesized token. */
  tug_session_id?: string;
  /** The commit's changed paths (`--name-only`), repo-relative — paths only.
   *  They ride the log so the History filter can match a commit by the files
   *  it touched; the statuses and line counts an expanded row shows still come
   *  from its own `GIT_COMMIT_FILES` request. Empty for a merge or an empty
   *  commit. */
  files?: string[];
}

/** A single-shot recent-commits payload from tugcast (GIT_LOG feed). */
export interface GitLogPayload {
  request_id: string;
  workspace_key: string;
  /** Current branch, `"(detached)"` when detached, `""` when `no_repo`. */
  branch: string;
  /** True when the project dir is not inside a git working tree. */
  no_repo: boolean;
  /** How many commits the page skipped. On the ACCUMULATED payload the store
   *  publishes this is always `0` — the walk it holds starts at HEAD. */
  offset: number;
  /** True when history continues past what is held — what `loadMore` reads to
   *  decide whether there is another page to ask for. */
  has_more: boolean;
  /** Most-recent-first commits. */
  commits: GitLogCommit[];
}

/** Lifecycle of the current/last log request. */
export type GitLogPhase = "idle" | "loading" | "ready" | "error";

/** Reactive snapshot the section renders via `useSyncExternalStore`. */
export interface GitLogStoreSnapshot {
  phase: GitLogPhase;
  /** Correlation id of the in-flight (or last) request; `null` before any. */
  requestId: string | null;
  /** Project dir of the in-flight (or last) request; `null` before any. */
  requestedRoot: string | null;
  /** The resolved payload when `phase === "ready"`, its `commits` accumulated
   *  across every page loaded so far. Held across a `refresh()` of the same
   *  root so the list never blinks; dropped only when the root changes. */
  payload: GitLogPayload | null;
  /** True while a page PAST the first is in flight — `phase` stays `ready` and
   *  the payload stands, so the list keeps its content and its scroll offset
   *  while the next page lands. */
  loadingMore: boolean;
  /** Human-readable error when `phase === "error"`. */
  error: string | null;
}

const EMPTY_SNAPSHOT: GitLogStoreSnapshot = {
  phase: "idle",
  requestId: null,
  requestedRoot: null,
  payload: null,
  loadingMore: false,
  error: null,
};

/**
 * Commits per page. Enough to overflow the shade at any height it can be
 * dragged to, so the first page always leaves something to scroll toward.
 */
export const GIT_LOG_PAGE_SIZE = 40;

/** Parse a GIT_LOG feed payload into a `GitLogPayload`, or `null`. */
export function parseGitLogPayload(payload: unknown): GitLogPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.request_id !== "string") return null;
  if (!Array.isArray(p.commits)) return null;
  return {
    request_id: p.request_id,
    workspace_key: typeof p.workspace_key === "string" ? p.workspace_key : "",
    branch: typeof p.branch === "string" ? p.branch : "",
    no_repo: p.no_repo === true,
    offset: typeof p.offset === "number" ? p.offset : 0,
    has_more: p.has_more === true,
    commits: p.commits as GitLogCommit[],
  };
}

/** A HEAD-moved signal from the GIT_HEAD feed (mirrors `GitHeadSignal`). */
export interface GitHeadSignal {
  workspace_key: string;
  head: string;
}

/** Parse a GIT_HEAD feed payload into a `GitHeadSignal`, or `null`. */
export function parseGitHeadSignal(payload: unknown): GitHeadSignal | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.workspace_key !== "string") return null;
  return {
    workspace_key: p.workspace_key,
    head: typeof p.head === "string" ? p.head : "",
  };
}

// ── Pure presentation helper (unit-tested) ──────────────────────────────────

/**
 * Format a log payload into the section's text blob, one line per commit in
 * wire order: `<sha9>  <date>  <author> — <subject>` (two-space column gaps, an
 * em-arc before the subject). No trailing newline; `""` for zero commits.
 */
export function formatGitLog(payload: GitLogPayload): string {
  return payload.commits
    .map((c) => `${c.sha.slice(0, 9)}  ${c.date}  ${c.author} — ${c.subject}`)
    .join("\n");
}

// ── GitLogStore ─────────────────────────────────────────────────────────────

/**
 * Store-instance counter baked into every `requestId` so concurrent requests
 * from different stores can never correlate to each other's responses — the
 * GIT_LOG response is a broadcast every client sees.
 */
let nextStoreId = 0;

export class GitLogStore {
  private _snapshot: GitLogStoreSnapshot = EMPTY_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private _lastHeadRef: unknown = undefined;
  private readonly _feedStore: FeedStore;
  private readonly _storeId: number;
  private _seq = 0;

  constructor(feedStore: FeedStore) {
    this._feedStore = feedStore;
    this._storeId = ++nextStoreId;
    this._unsubscribeFeed = feedStore.subscribe(() => {
      this._onLogUpdate();
      this._onHeadSignal();
    });
  }

  private _onLogUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(FeedId.GIT_LOG);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;

    const parsed = parseGitLogPayload(payload);
    if (parsed === null) return;
    // Accept only the response correlated to the in-flight request. A null
    // requestId (no request sent) or a mismatch (superseded request, or a
    // replayed cached frame) never matches.
    if (parsed.request_id !== this._snapshot.requestId) return;

    this._set({
      phase: "ready",
      requestId: parsed.request_id,
      requestedRoot: this._snapshot.requestedRoot,
      payload: this._merge(parsed),
      loadingMore: false,
      error: null,
    });
  }

  /**
   * Fold a landed page into the walk the store holds.
   *
   * A page at offset `0` IS the walk — a first load or a refresh that re-read
   * the whole loaded span, so it replaces outright. A later page appends, and
   * the accumulated payload keeps `offset: 0` because the walk it describes
   * starts at HEAD however many requests built it.
   *
   * Append dedups by sha. The offset the page asked for was measured against
   * the walk as it stood when the request went out; a commit landing in
   * between shifts every later commit one position deeper, which would hand
   * back a commit already held. Dropping the repeat keeps the list's React
   * keys unique and its order honest — the newly-arrived commit shows up on
   * the next `GIT_HEAD` refresh, at the top where it belongs.
   */
  private _merge(page: GitLogPayload): GitLogPayload {
    const held = this._snapshot.payload;
    if (page.offset === 0 || held === null) {
      return { ...page, offset: 0 };
    }
    const seen = new Set(held.commits.map((c) => c.sha));
    const fresh = page.commits.filter((c) => !seen.has(c.sha));
    return {
      ...page,
      offset: 0,
      commits: held.commits.concat(fresh),
    };
  }

  /**
   * A GIT_HEAD signal reports that some workspace's HEAD moved (a commit /
   * checkout / reset from ANY source, detected server-side by an FSEvents git
   * watch). If it names the workspace this store is currently showing, and its
   * HEAD is past the commit we have on top, re-request the log — keeping the
   * section live without polling.
   */
  private _onHeadSignal(): void {
    const frame = this._feedStore.getSnapshot().get(FeedId.GIT_HEAD);
    if (frame === this._lastHeadRef) return;
    this._lastHeadRef = frame;

    const signal = parseGitHeadSignal(frame);
    if (signal === null) return;
    const payload = this._snapshot.payload;
    if (payload === null || signal.workspace_key !== payload.workspace_key) return;
    // Already showing this HEAD? Nothing to do (dedups redundant signals).
    if (payload.commits[0]?.sha === signal.head) return;
    this.refresh();
  }

  /**
   * Request the recent log for `projectDir`. Idempotent by the requested-key
   * guard: a no-op when `projectDir` is already the requested root, WHATEVER
   * the phase, so re-renders and collapse toggles can call it freely.
   *
   * `error` is inside the guard, not an exception to it ([L28]). A failed send
   * publishes `phase: "error"` synchronously (no connection takes that path),
   * so a caller that retried on error would be re-deriving the source's retry
   * policy from the source's own output: request → error → request, with no
   * await in between. A React effect wired that way loops until the render
   * depth limit trips. Retry is the store's to schedule — {@link refresh},
   * driven by a reconnect, a `GIT_HEAD` signal, or an explicit gesture.
   */
  requestLog(projectDir: string, limit = GIT_LOG_PAGE_SIZE): void {
    if (projectDir === this._snapshot.requestedRoot) return;
    this._send(projectDir, 0, limit);
  }

  /**
   * Re-request the current root unconditionally (mount, reconnect, `GIT_HEAD`).
   *
   * Re-reads the WHOLE span already loaded, not just the first page: a reader
   * scrolled forty commits deep should not be pulled back to HEAD because
   * someone committed. The current payload stays visible while the re-read is
   * in flight, so the list holds still.
   */
  refresh(): void {
    const root = this._snapshot.requestedRoot;
    if (root === null) return;
    const loaded = this._snapshot.payload?.commits.length ?? 0;
    this._send(root, 0, Math.max(GIT_LOG_PAGE_SIZE, loaded));
  }

  /**
   * Load the next page and append it — the load-on-scroll gesture.
   *
   * A no-op unless there is a resolved walk with more history behind it and
   * nothing already in flight, so a scroller may call it on every intersection
   * without debouncing.
   */
  loadMore(pageSize = GIT_LOG_PAGE_SIZE): void {
    const { requestedRoot, payload, phase, loadingMore } = this._snapshot;
    if (requestedRoot === null || payload === null) return;
    if (phase !== "ready" || loadingMore) return;
    if (!payload.has_more) return;
    this._send(requestedRoot, payload.commits.length, pageSize);
  }

  /**
   * A repo was just initialized under `root` (a `git init` with no commit yet).
   * An unborn HEAD moves no HEAD, so no GIT_HEAD signal arrives — the cached
   * `no_repo` snapshot would stick. If this store is currently showing that
   * root, re-request so History flips from "Not a git repository" to the
   * now-correct empty-repo "No commits yet".
   */
  onRepoInitialized(root: string): void {
    if (this._snapshot.requestedRoot !== root) return;
    this.refresh();
  }

  private _send(projectDir: string, offset: number, limit: number): void {
    // What is on screen survives anything but a change of project: a page
    // request and a refresh are both re-reads of THIS root's history, so the
    // list keeps its rows (and therefore its scroll offset) until the answer
    // lands. A different root makes the held walk simply wrong, so it goes.
    const sameRoot = projectDir === this._snapshot.requestedRoot;
    const held = sameRoot ? this._snapshot.payload : null;
    const conn = getConnection();
    if (!conn) {
      this._set({
        phase: "error",
        requestId: null,
        requestedRoot: projectDir,
        payload: held,
        loadingMore: false,
        error: "Lost the connection to tugcast.",
      });
      return;
    }
    this._seq += 1;
    const requestId = `gl-${this._storeId}-${this._seq}`;
    // A page request leaves the walk `ready` — the list is not reloading, it is
    // growing, and blanking it under the reader's scroll would be a lie.
    const paging = offset > 0 && held !== null;
    this._set({
      phase: paging ? "ready" : "loading",
      requestId,
      requestedRoot: projectDir,
      payload: held,
      loadingMore: paging,
      error: null,
    });
    const query = { root: projectDir, requestId, offset, limit };
    const bytes = new TextEncoder().encode(JSON.stringify(query));
    conn.send(FeedId.GIT_LOG_QUERY, bytes);
  }

  private _set(next: GitLogStoreSnapshot): void {
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): GitLogStoreSnapshot => this._snapshot;

  /**
   * Test seam — set the store to `ready` with `payload` directly, as if a
   * matching `GIT_LOG` response had landed, bypassing the connection and the
   * request_id gate. Mirrors `GitDiffStore._ingestForTest`. @internal
   */
  _ingestForTest(payload: unknown): void {
    const parsed = parseGitLogPayload(payload);
    if (parsed === null) {
      throw new Error("GitLogStore._ingestForTest: malformed payload");
    }
    this._set({
      phase: "ready",
      requestId: parsed.request_id,
      requestedRoot: this._snapshot.requestedRoot,
      payload: this._merge(parsed),
      loadingMore: false,
      error: null,
    });
  }

  dispose(): void {
    if (this._unsubscribeFeed) {
      this._unsubscribeFeed();
      this._unsubscribeFeed = null;
    }
    this._listeners.clear();
  }
}

// ── Shared singleton ─────────────────────────────────────────────────────────

let _feedStore: FeedStore | null = null;
let _store: GitLogStore | null = null;

/**
 * The one shared Git History store, lazily created over a shared
 * `FeedStore(conn, [GIT_LOG])`. Returns `null` when no connection is up
 * (gallery / fixtures) — callers render the empty state.
 */
export function gitLogStore(): GitLogStore | null {
  if (_store !== null) return _store;
  const conn = getConnection();
  if (!conn) return null;
  _feedStore = new FeedStore(conn, [FeedId.GIT_LOG, FeedId.GIT_HEAD]);
  _store = new GitLogStore(_feedStore);
  return _store;
}
