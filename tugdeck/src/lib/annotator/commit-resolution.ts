/**
 * Commit resolution — is this run of hex a commit in this repository?
 *
 * The repository is the only thing that can answer, and its answer doubles
 * as the payload: `GIT_COMMIT_FILES_QUERY` returns the files a commit
 * touched, which is both the existence check (a sha git cannot show comes
 * back with no files) and the `paths` a diff descriptor wants. So one
 * question serves verification and the gesture together.
 *
 * The shape mirrors the other resolvers: `lookup` is synchronous and
 * answers from cache, an unseen sha is queued and reported `pending`, and
 * the answer notifies so the waiting ink re-marks. Commits are immutable,
 * so a verdict is cached for the app's life and a repeat pass costs
 * nothing.
 *
 * Queries drain one at a time. The response feed is shared and single-slot
 * — every client sees every answer — so correlation is by `requestId`, and
 * a frame that answers someone else's question is ignored rather than
 * mistaken for ours. An unanswered question is retried a bounded number of
 * times (silently, verdict still `pending`) and then recorded as a
 * terminal `unknown`, never `missing`: an unreachable tugcast means we
 * don't know. Terminal, because a forgotten verdict is re-asked by the
 * very re-annotation its forgetting triggers, and that loop never
 * converges.
 *
 * @module lib/annotator/commit-resolution
 */

import { FeedStore } from "../feed-store";
import { FeedId } from "../../protocol";
import { getConnection } from "../connection-singleton";
import type { TugConnection } from "../../connection";
import {
  parseGitCommitFilesPayload,
  type GitCommitFile,
} from "../git-commit-files-store";
import {
  commitVerdictKey,
  noteVerdictKey,
  type VerdictKey,
} from "./verdict-keys";

/** How long one query may go unanswered before it is re-queued. */
const QUERY_TIMEOUT_MS = 8000;

/**
 * How many times one sha is asked before its verdict is recorded as a
 * terminal `unknown` — the shared response feed can drop an answer, but
 * an unreachable tugcast will not become reachable by asking harder.
 */
const MAX_QUERY_ATTEMPTS = 3;

/** What a confirmed commit turned out to be — the hover's whole substance. */
export interface CommitFacts {
  /** The subject line. Empty on a payload older than the field. */
  subject: string;
  /** Author name; empty for the same reason. */
  author: string;
  /** Author date, `YYYY-MM-DD`. */
  date: string;
  /** Every file the commit touched, with its status and ± counts. */
  files: GitCommitFile[];
}

/** What is known about a commit-sha candidate. */
export type CommitVerdict =
  /** Never asked, or asked and the answer was lost. Not actionable. */
  | { state: "unknown" }
  /** A query is in flight. Not actionable yet. */
  | { state: "pending" }
  /**
   * A real commit. Actionable: `paths` scopes the diff a click opens, and
   * `facts` is what a hover says this sha IS — a bare hash names nothing on
   * its own, so the answer that verifies it also has to describe it.
   */
  | { state: "confirmed"; paths: string[]; facts: CommitFacts }
  /** Not a commit in this repository. Never actionable. */
  | { state: "missing" };

const UNKNOWN: CommitVerdict = { state: "unknown" };
const PENDING: CommitVerdict = { state: "pending" };
const MISSING: CommitVerdict = { state: "missing" };

/** One project's commit-verdict cache. */
export class CommitResolutionStore {
  private readonly verdicts = new Map<string, CommitVerdict>();
  private readonly attempts = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<(keys: readonly VerdictKey[]) => void>();
  private readonly feedStore: FeedStore;
  private readonly unsubscribeFeed: () => void;
  private lastPayloadRef: unknown = undefined;
  private inFlight: { sha: string; requestId: string } | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private currentVersion = 0;
  private sequence = 0;

  constructor(
    private readonly projectDir: string,
    private readonly storeKey: string,
    connection: TugConnection,
  ) {
    this.feedStore = new FeedStore(connection, [FeedId.GIT_COMMIT_FILES]);
    this.unsubscribeFeed = this.feedStore.subscribe(() => {
      this.onFeedUpdate();
    });
  }

  /**
   * What is known about `sha` right now. Synchronous by contract — the
   * annotator's DOM pass calls this for every hex run it meets.
   */
  lookup = (sha: string): CommitVerdict => {
    // Every answer this serves is a dependency of the ink it is served to,
    // whatever it says — see `verdict-keys.ts`.
    noteVerdictKey(this.verdictKey(sha));
    const known = this.verdicts.get(sha);
    if (known !== undefined) return known;
    this.verdicts.set(sha, PENDING);
    this.queue.push(sha);
    this.pump();
    return PENDING;
  };

  /** Subscribe to verdict arrivals. Returns the unsubscribe. */
  subscribe = (
    listener: (keys: readonly VerdictKey[]) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Bumped whenever verdicts change, so waiting ink re-marks. */
  version = (): number => this.currentVersion;

  /** The root every descriptor this store confirms belongs to. */
  root = (): string => this.projectDir;

  /** This store's key for `sha` — scoped by repository, since one sha can
   * be a commit in one checkout and nothing in another. */
  private verdictKey(sha: string): VerdictKey {
    return commitVerdictKey(this.projectDir, sha);
  }

  /** Send the next queued query, if the slot is free. */
  private pump(): void {
    if (this.inFlight !== null) return;
    const sha = this.queue.shift();
    if (sha === undefined) return;
    const connection = getConnection();
    if (connection === null) {
      // No transport: a terminal don't-know, silently — `pending` and
      // `unknown` paint identically, and a deleted verdict would be
      // re-asked by the next pass forever. Keep draining the queue; every
      // entry meets the same answer.
      this.verdicts.set(sha, UNKNOWN);
      this.pump();
      return;
    }
    this.sequence += 1;
    const requestId = `annotator-${this.storeKey}-${this.sequence}`;
    this.inFlight = { sha, requestId };
    this.timeoutHandle = setTimeout(() => {
      // Unanswered: re-queue a bounded number of times, then record a
      // terminal `unknown`. Never delete and never notify — see the
      // module doc on convergence.
      this.timeoutHandle = null;
      this.inFlight = null;
      const tried = (this.attempts.get(sha) ?? 0) + 1;
      if (tried < MAX_QUERY_ATTEMPTS) {
        this.attempts.set(sha, tried);
        this.queue.push(sha);
      } else {
        this.attempts.delete(sha);
        this.verdicts.set(sha, UNKNOWN);
      }
      this.pump();
    }, QUERY_TIMEOUT_MS);
    const query = { root: this.projectDir, requestId, sha };
    connection.send(
      FeedId.GIT_COMMIT_FILES_QUERY,
      new TextEncoder().encode(JSON.stringify(query)),
    );
  }

  /** Take delivery of a response, if it answers the question in flight. */
  private onFeedUpdate(): void {
    const pending = this.inFlight;
    if (pending === null) return;
    const payload = this.feedStore.getSnapshot().get(FeedId.GIT_COMMIT_FILES);
    if (payload === this.lastPayloadRef) return;
    this.lastPayloadRef = payload;
    const parsed = parseGitCommitFilesPayload(payload);
    if (parsed === null || parsed.request_id !== pending.requestId) return;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.inFlight = null;
    this.attempts.delete(pending.sha);
    // No repo means the question was unanswerable, not answered "no" — a
    // terminal don't-know, and silent: nothing painted changes.
    if (parsed.no_repo) this.verdicts.set(pending.sha, UNKNOWN);
    else {
      // `git show` on a sha that does not resolve produces nothing, so an
      // empty file list is how "not a commit here" arrives.
      this.verdicts.set(
        pending.sha,
        parsed.files.length === 0
          ? MISSING
          : {
              state: "confirmed",
              paths: parsed.files.map((f) => f.path),
              facts: {
                subject: parsed.subject,
                author: parsed.author,
                date: parsed.date,
                files: parsed.files,
              },
            },
      );
      this.notify([this.verdictKey(pending.sha)]);
    }
    this.pump();
  }

  private notify(keys: readonly VerdictKey[]): void {
    this.currentVersion += 1;
    for (const listener of this.listeners) listener(keys);
  }

  /** Release the feed subscription. */
  dispose(): void {
    if (this.timeoutHandle !== null) clearTimeout(this.timeoutHandle);
    this.unsubscribeFeed();
    this.feedStore.dispose();
    this.listeners.clear();
  }
}

/**
 * One resolver per project, created on first use and kept for the app's
 * life — commits are immutable, so the cache never goes stale.
 */
const stores = new Map<string, CommitResolutionStore>();

/**
 * The commit resolver for a project, or `null` when there is no project to
 * ask about or no connection to ask over.
 */
export function commitResolverFor(
  projectDir: string | null,
  workspaceKey: string | null,
): CommitResolutionStore | null {
  if (projectDir === null || workspaceKey === null) return null;
  const existing = stores.get(workspaceKey);
  if (existing !== undefined) return existing;
  const connection = getConnection();
  if (connection === null) return null;
  const store = new CommitResolutionStore(projectDir, workspaceKey, connection);
  stores.set(workspaceKey, store);
  return store;
}

/** The verdict a context with no resolver reports: nothing is known. */
export const NO_COMMIT_VERDICT = UNKNOWN;
