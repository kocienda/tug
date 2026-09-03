/**
 * GitDiffStore — single-shot git-diff request/response over the GIT_DIFF
 * feeds ([#step-10b]).
 *
 * A diff is a one-shot, not a continuous feed: a consumer (the Project Diff
 * card, a changes-list row's inline diff) asks once (and again on an explicit
 * refresh), and tugcast answers with a single
 * `GIT_DIFF` (0x21) frame. This store sends the `GIT_DIFF_QUERY` (0x22)
 * carrying the card's project dir as `root` (the same dir behind the Z4B
 * chip — tugcast resolves the matching workspace) plus a correlating
 * `requestId`, and resolves the response whose `request_id` matches the
 * in-flight request. Stale responses (a slow reply to a superseded request,
 * or a workspace-filtered replay) are ignored.
 *
 * The owning `FeedStore` is workspace-key-filtered (see `card-services-store`)
 * so a card only ever sees its own project's diff; `requestId` disambiguates
 * rapid refreshes within that card.
 *
 * Pure presentation helpers (`formatDiffStat`, `diffStatusLabel`,
 * `diffSummaryLine`, `fileStatLabel`) live here too so the accordion mapping
 * is unit-testable without React or a live connection.
 *
 * @module lib/git-diff-store
 */

import { statLineFrom } from "./commit-format";
import type { FeedStore } from "./feed-store";
import type { FeedIdValue } from "../protocol";
import { FeedId } from "../protocol";
import { getConnection } from "./connection-singleton";

// ── Wire types (mirror tugcast-core `GitDiffSnapshot`) ──────────────────────

/** How a file changed relative to `HEAD`. */
export type GitDiffFileStatus = "added" | "modified" | "deleted" | "renamed";

/** One changed file in a `git diff HEAD` payload. */
export interface GitDiffFile {
  /** Path relative to the repo root (the rename destination when renamed). */
  path: string;
  /** Original path for a rename; absent otherwise. */
  old_path?: string;
  status: GitDiffFileStatus;
  /** Count of added (`+`) body lines. */
  added: number;
  /** Count of removed (`-`) body lines. */
  removed: number;
  /** True when git reported a binary file (no textual hunks). */
  binary: boolean;
  /** The file's complete unified-diff chunk, verbatim from git. */
  unified: string;
  /**
   * Content-hash id per hunk of `unified`, in hunk order. Computed server-side
   * and never re-derived here, so a hunk election means the same thing to the
   * checkbox, the draft, and the landing engine. Absent for files whose hunks
   * cannot be elected — binary files, and created files (whose diff is
   * synthesized rather than read out of the index).
   */
  hunks?: string[];
}

/** A single-shot `git diff HEAD` payload from tugcast (GIT_DIFF feed). */
export interface GitDiffPayload {
  request_id: string;
  workspace_key: string;
  base: string;
  /** True when the project dir is not inside a git working tree. */
  no_repo: boolean;
  file_count: number;
  total_added: number;
  total_removed: number;
  files: GitDiffFile[];
}

/** Lifecycle of the current/last `/diff` request. */
export type GitDiffPhase = "idle" | "loading" | "ready" | "error";

/** Reactive snapshot the sheet renders via `useSyncExternalStore`. */
export interface GitDiffSnapshot {
  phase: GitDiffPhase;
  /** Correlation id of the in-flight (or last) request; `null` before any. */
  requestId: string | null;
  /** The last resolved payload — retained while a refetch is in flight, so a
   *  consumer can keep rendering what it has; `null` before the first one and
   *  after an error. */
  payload: GitDiffPayload | null;
  /** Human-readable error when `phase === "error"`. */
  error: string | null;
}

const EMPTY_SNAPSHOT: GitDiffSnapshot = {
  phase: "idle",
  requestId: null,
  payload: null,
  error: null,
};

// ── Pure presentation helpers (unit-tested) ─────────────────────────────────

const STATUS_LABELS: Record<GitDiffFileStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

/** Human label for a file's change status. */
export function diffStatusLabel(status: GitDiffFileStatus): string {
  return STATUS_LABELS[status];
}

const STATUS_LETTERS: Record<GitDiffFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

/** Single-letter status badge (git-porcelain style: A / M / D / R). */
export function diffStatusLetter(status: GitDiffFileStatus): string {
  return STATUS_LETTERS[status];
}

/**
 * Format an added/removed pair as `+10 −2`, using a true minus sign
 * (U+2212) to match the `/rewind` diff-stat presentation.
 */
export function formatDiffStat(added: number, removed: number): string {
  return `+${added} −${removed}`;
}

/**
 * Stat label for a file's accordion trigger: `binary` for binary files
 * (which carry no line counts), else `+N −M`.
 */
export function fileStatLabel(file: GitDiffFile): string {
  return file.binary ? "binary" : formatDiffStat(file.added, file.removed);
}

/**
 * The summary line for the sheet header: `N files changed, +X −Y`.
 *
 * The sentence is {@link statLineFrom}'s — the same words a commit hover and
 * a receipt state, because a reader comparing the header above a diff with
 * the tip over the sha that landed it should not have to notice they are
 * spelled differently. What is local is the empty case: a sheet with nothing
 * in it says so, where a commit with no files simply has no line.
 */
export function diffSummaryLine(
  fileCount: number,
  totalAdded: number,
  totalRemoved: number,
): string {
  if (fileCount === 0) return "No uncommitted changes";
  return statLineFrom(fileCount, totalAdded, totalRemoved);
}

/** Parse a GIT_DIFF feed payload into a `GitDiffPayload`, or `null`. */
export function parseGitDiffPayload(payload: unknown): GitDiffPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.request_id !== "string") return null;
  if (!Array.isArray(p.files)) return null;
  return {
    request_id: p.request_id,
    workspace_key: typeof p.workspace_key === "string" ? p.workspace_key : "",
    base: typeof p.base === "string" ? p.base : "HEAD",
    no_repo: p.no_repo === true,
    file_count: typeof p.file_count === "number" ? p.file_count : p.files.length,
    total_added: typeof p.total_added === "number" ? p.total_added : 0,
    total_removed: typeof p.total_removed === "number" ? p.total_removed : 0,
    files: p.files as GitDiffFile[],
  };
}

// ── GitDiffStore ────────────────────────────────────────────────────────────

/**
 * Scope for a diff request. `paths` narrows the diff to a repo-relative
 * pathspec (`git diff HEAD -- <paths…>`); `root` overrides the store's
 * construction-time project dir (the changeset card serves many projects
 * through one store). Both absent = the whole-tree diff.
 */
export interface GitDiffScope {
  paths?: string[];
  root?: string;
}

/**
 * A discriminated diff request ([P19], Spec S08). Three flavors:
 *
 * - `head` — `git diff HEAD [-- <paths…>]` in the project at `root`
 *   (sessions / unattributed / the session card's `/diff`), untracked files
 *   included as synthesized new-file diffs. Equivalent to the legacy
 *   {@link GitDiffScope}.
 * - `range` — the arc view: committed rounds past `base` **plus** worktree
 *   dirt, resolved as `merge-base(base, branch)` diffed against the worktree
 *   working tree (see `feeds/git.rs::fetch_arc_diff`).
 * - `commit` — one commit against its first parent (`git diff-tree --root`),
 *   the `/commit` receipt's expandable file rows ([P08]).
 */
export type DiffDescriptor =
  | { kind: "head"; root?: string; paths?: string[] }
  | { kind: "range"; root?: string; worktree: string; base: string; branch: string }
  | { kind: "commit"; root?: string; sha: string; paths?: string[] };

/**
 * Stable identity key for a descriptor — the reuse key for `OPEN_DIFF`'s
 * descriptor-keyed Text-card reuse ([P20]). Two descriptors that resolve to
 * the same diff share a key.
 */
export function diffDescriptorKey(descriptor: DiffDescriptor): string {
  if (descriptor.kind === "range") {
    return `range:${descriptor.root ?? ""}:${descriptor.worktree}:${descriptor.base}:${descriptor.branch}`;
  }
  const paths = [...(descriptor.paths ?? [])].sort().join("\n");
  if (descriptor.kind === "commit") {
    return `commit:${descriptor.root ?? ""}:${descriptor.sha}:${paths}`;
  }
  return `head:${descriptor.root ?? ""}:${paths}`;
}

/** A `GitDiffScope` (legacy head form) or a `DiffDescriptor` (either flavor). */
export type DiffRequest = GitDiffScope | DiffDescriptor;

/** Runtime guard for an unknown value being a {@link DiffDescriptor}. */
export function isDiffDescriptor(value: unknown): value is DiffDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "head") return true;
  if (kind === "commit") {
    return typeof (value as { sha?: unknown }).sha === "string";
  }
  if (kind === "range") {
    const v = value as { worktree?: unknown; base?: unknown; branch?: unknown };
    return (
      typeof v.worktree === "string" &&
      typeof v.base === "string" &&
      typeof v.branch === "string"
    );
  }
  return false;
}

/** True when a request is the arc range flavor. */
function isRangeDescriptor(
  request: DiffRequest,
): request is Extract<DiffDescriptor, { kind: "range" }> {
  return (request as { kind?: string }).kind === "range";
}

/** True when a request is the commit flavor. */
function isCommitDescriptor(
  request: DiffRequest,
): request is Extract<DiffDescriptor, { kind: "commit" }> {
  return (request as { kind?: string }).kind === "commit";
}

/**
 * Store-instance counter baked into every `requestId` so concurrent
 * requests from different stores (a session card's `/diff` and the changeset
 * card's scoped diff) can never correlate to each other's responses —
 * the GIT_DIFF response is a broadcast every client sees.
 */
let nextStoreId = 0;

export class GitDiffStore {
  private _snapshot: GitDiffSnapshot = EMPTY_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private readonly _feedStore: FeedStore;
  private readonly _feedId: FeedIdValue;
  private readonly _projectDir: string | undefined;
  private readonly _storeId: number;
  private _scope: DiffRequest = {};
  private _seq = 0;

  constructor(feedStore: FeedStore, feedId: FeedIdValue, projectDir?: string) {
    this._feedStore = feedStore;
    this._feedId = feedId;
    this._projectDir = projectDir;
    this._storeId = ++nextStoreId;
    this._unsubscribeFeed = feedStore.subscribe(() => this._onFeedUpdate());
    // No initial check: a `/diff` response only matters once we've sent a
    // request (`requestId` is null until then, so nothing would match).
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(this._feedId);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;

    const parsed = parseGitDiffPayload(payload);
    if (parsed === null) return;
    // Accept only the response correlated to the in-flight request. A null
    // requestId (no request sent) or a mismatch (superseded request, or a
    // replayed cached frame) never matches.
    if (parsed.request_id !== this._snapshot.requestId) return;

    this._set({
      phase: "ready",
      requestId: parsed.request_id,
      payload: parsed,
      error: null,
    });
  }

  /**
   * Fire a fresh diff request. Moves the store to `loading` under a new
   * `requestId`; the matching `GIT_DIFF` response resolves it to `ready`.
   * Passing a `request` adopts it — a legacy {@link GitDiffScope} (head
   * flavor), `{}` for the whole tree, or a {@link DiffDescriptor} of either
   * flavor (the arc range flavor names `worktree`/`base`/`branch`, [P19]).
   * Omitting it repeats the last request — the in-sheet Refresh re-runs
   * whatever is showing.
   */
  requestDiff(request?: DiffRequest): void {
    if (request !== undefined) this._scope = request;
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
    const requestId = `gd-${this._storeId}-${this._seq}`;
    const query: Record<string, unknown> = { requestId };
    if (isRangeDescriptor(this._scope)) {
      // Arc range flavor: `root` still resolves the workspace; the arc
      // fields select `<base>...<branch>` + worktree dirt server-side.
      const root = this._scope.root ?? this._projectDir;
      if (root !== undefined && root.length > 0) query.root = root;
      query.worktree = this._scope.worktree;
      query.base = this._scope.base;
      query.branch = this._scope.branch;
    } else if (isCommitDescriptor(this._scope)) {
      // Commit flavor: one commit vs. its first parent, optionally scoped.
      const root = this._scope.root ?? this._projectDir;
      if (root !== undefined && root.length > 0) query.root = root;
      query.sha = this._scope.sha;
      if (this._scope.paths !== undefined && this._scope.paths.length > 0) {
        query.paths = this._scope.paths;
      }
    } else {
      // Head flavor (legacy scope or `{kind:"head"}`): whole tree or pathspec.
      const root = this._scope.root ?? this._projectDir;
      if (root !== undefined && root.length > 0) query.root = root;
      if (this._scope.paths !== undefined && this._scope.paths.length > 0) {
        query.paths = this._scope.paths;
      }
    }
    // The last resolved payload rides through the refetch. A consumer that
    // wants a spinner branches on `phase` first (the sheet and the diff card
    // do); one rendering an already-open diff keeps rendering it until the new
    // payload lands, so a refresh never tears the diff down and takes its
    // collapsed bands, view mode, and scroll with it ([L23], [L26]).
    this._set({
      phase: "loading",
      requestId,
      payload: this._snapshot.payload,
      error: null,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(query));
    conn.send(FeedId.GIT_DIFF_QUERY, bytes);
  }

  private _set(next: GitDiffSnapshot): void {
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): GitDiffSnapshot => this._snapshot;

  /**
   * Test seam — set the store to `ready` with `payload` directly, as if a
   * matching `GIT_DIFF` response had landed, bypassing the connection and the
   * request_id gate. Mirrors `SessionMetadataStore._ingestForTest`; lets an
   * app-test render a diff surface deterministically without a live git
   * round-trip (which 10.A's subprocess test already proves). @internal
   */
  _ingestForTest(payload: unknown): void {
    const parsed = parseGitDiffPayload(payload);
    if (parsed === null) {
      throw new Error("GitDiffStore._ingestForTest: malformed payload");
    }
    this._set({
      phase: "ready",
      requestId: parsed.request_id,
      payload: parsed,
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
