/**
 * Filename resolution — which file does a bare `tug-button.css` mean?
 *
 * `fs/stat` can answer a path, because a path says where to look. A bare
 * filename says only what to look for, and it is the shape transcript
 * prose uses most: Claude writes the name of the file it just edited, not
 * a route to it. Answering that needs a search over the project, which is
 * exactly what Open Quickly already does — this module asks the same
 * question of the same index (FILETREE), so a name resolves here if and
 * only if typing it into Open Quickly and pressing Return would open it.
 *
 * **The match rule.** A result counts when the written text is the whole
 * tail of an indexed path — `tug-button.css` matches
 * `tugdeck/styles/tug-button.css` but not `old-tug-button.css`, and a
 * written `styles/tug-button.css` matches only a path ending in that whole
 * run. Among several such matches the best-scoring one wins, which is the
 * row Open Quickly would have put first. Fuzzy near-misses are discarded:
 * the index's scorer is built to rank candidates for a human who is about
 * to choose, and nobody is choosing here.
 *
 * **Why a queue.** The FILETREE feed is single-slot — one query
 * outstanding, and each response replaces the last snapshot — so a pass
 * that meets forty filenames cannot ask forty questions at once. Wants go
 * into a FIFO and drain one at a time. That is slow in the way a
 * background index is allowed to be slow: nothing blocks on it, verdicts
 * cache for the app's life, and a name already answered costs nothing on
 * every later pass.
 *
 * **Honesty under failure.** The feed is shared with Open Quickly, so a
 * query the user fires mid-flight can land on top of ours. An answer that
 * does not match the question is ignored. A question that goes unanswered
 * past a deadline is retried a bounded number of times — silently, from
 * inside the queue, with the verdict still `pending` — and then recorded
 * as `unknown`, never `missing`. Recorded matters: an unanswered question
 * must not forget its verdict, because a forgotten verdict is re-asked by
 * the very re-annotation its forgetting triggers, and that loop never
 * converges. The one thing this must never do is manufacture a link.
 *
 * **A "no" expires.** A name the index does not carry today may be a file
 * tomorrow — narration routinely names a file just before it is written —
 * so `missing` and `unknown` age out after {@link RETRY_AFTER_MS} and are
 * asked again, on the same terms as a path's ({@link
 * lib/annotator/path-resolution}). The old answer keeps being served
 * meanwhile, and only a changed one notifies, so an unresolvable name costs
 * one queued query a minute rather than a permanently dead reference.
 *
 * @module lib/annotator/file-name-resolution
 */

import { FeedStore } from "../feed-store";
import { FeedId } from "../../protocol";
import {
  FileTreeStore,
  resolveAgainstRoot,
  workspaceFeedFilter,
  type ScoredResult,
} from "../filetree-store";
import { getConnection } from "../connection-singleton";
import type { TugConnection } from "../../connection";
import { RETRY_AFTER_MS, type PathVerdict } from "./path-resolution";
import { nameVerdictKey, noteVerdictKey, type VerdictKey } from "./verdict-keys";

/** How long one query may go unanswered before it is re-queued. */
const QUERY_TIMEOUT_MS = 4000;

/**
 * How many times one name is asked before its verdict is recorded as a
 * terminal `unknown`. Retries exist because the feed is shared — a user's
 * Open Quickly query can land on top of ours and eat the slot — not
 * because asking harder makes an index answer differently.
 */
const MAX_QUERY_ATTEMPTS = 3;

const UNKNOWN: PathVerdict = { state: "unknown" };
const PENDING: PathVerdict = { state: "pending" };
const MISSING: PathVerdict = { state: "missing" };

/**
 * Whether `result` is the file `query` names: the written text must be the
 * whole tail of the indexed path, at a segment boundary.
 */
export function indexResultMatches(resultPath: string, query: string): boolean {
  if (resultPath === query) return true;
  return resultPath.endsWith(`/${query}`);
}

/**
 * The best result for `query`, or `null` when the index found nothing that
 * actually bears the name. A directory counts: it is a real thing the
 * reference can be pointing at, and the verdict says which it is so the
 * right gesture follows.
 */
export function bestIndexMatch(
  results: readonly ScoredResult[],
  query: string,
): ScoredResult | null {
  let best: ScoredResult | null = null;
  for (const result of results) {
    // The index spells a directory with a trailing separator; the query
    // may or may not carry one, and they mean the same place.
    const indexed = result.is_dir === true ? trimTrailingSlash(result.path) : result.path;
    if (!indexResultMatches(indexed, trimTrailingSlash(query))) continue;
    if (best === null || result.score > best.score) best = result;
  }
  return best;
}

/** Whether two verdicts say the same thing about the same file. */
function sameVerdict(a: PathVerdict, b: PathVerdict): boolean {
  if (a.state !== b.state) return false;
  if (a.state === "confirmed" && b.state === "confirmed") {
    return a.canonical === b.canonical && a.isDir === b.isDir;
  }
  return true;
}

/** Drop a trailing separator, so the two spellings of a folder agree. */
function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? path : trimmed;
}

/**
 * One project's filename verdict cache, backed by that project's FILETREE
 * index.
 */
export class FileNameResolutionStore {
  private readonly verdicts = new Map<string, PathVerdict>();
  private readonly attempts = new Map<string, number>();
  /** When each name was last asked about — the clock a re-ask runs on. */
  private readonly askedAt = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<(keys: readonly VerdictKey[]) => void>();
  private readonly feedStore: FeedStore;
  private readonly fileTree: FileTreeStore;
  private readonly unsubscribeTree: () => void;
  private inFlight: string | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private currentVersion = 0;

  constructor(
    private readonly projectDir: string,
    workspaceKey: string,
    connection: TugConnection,
    /** Injected so a test can age a verdict without waiting on a minute. */
    private readonly now: () => number = Date.now,
  ) {
    this.feedStore = new FeedStore(
      connection,
      [FeedId.FILETREE],
      undefined,
      workspaceFeedFilter(workspaceKey),
    );
    this.fileTree = new FileTreeStore(
      this.feedStore,
      FeedId.FILETREE,
      projectDir,
    );
    this.unsubscribeTree = this.fileTree.subscribe(() => {
      this.onSnapshot();
    });
  }

  /**
   * What is known about `name` right now. Synchronous by contract — the
   * annotator's DOM pass calls this for every filename candidate it meets.
   * A name never asked about is queued and reported `pending` — the state
   * that marks its container as awaiting; the answer's batch re-marks it.
   */
  lookup = (name: string): PathVerdict => {
    // Every answer this serves is a dependency of the ink it is served to,
    // whatever it says — see `verdict-keys.ts`.
    noteVerdictKey(this.verdictKey(name));
    const known = this.verdicts.get(name);
    if (known !== undefined) {
      // Stale "no": ask the index again, and go on serving the old answer
      // while it does. Nothing painted should flicker back to `pending`.
      if (this.expired(name, known)) this.enqueue(name);
      return known;
    }
    this.verdicts.set(name, PENDING);
    this.enqueue(name);
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

  /** This store's key for `name` — scoped by project, since two projects
   * can hold different files under one name. */
  private verdictKey(name: string): VerdictKey {
    return nameVerdictKey(this.projectDir, name);
  }

  /**
   * Whether `verdict` is a "no" old enough to ask about again. A confirmed
   * name never expires; a pending one is already in the queue.
   */
  private expired(name: string, verdict: PathVerdict): boolean {
    if (verdict.state !== "missing" && verdict.state !== "unknown") {
      return false;
    }
    const asked = this.askedAt.get(name);
    return asked === undefined || this.now() - asked >= RETRY_AFTER_MS;
  }

  /** Queue `name` for the index, unless it is already waiting or in flight. */
  private enqueue(name: string): void {
    this.askedAt.set(name, this.now());
    if (this.inFlight === name || this.queue.includes(name)) return;
    this.queue.push(name);
    this.pump();
  }

  /** Send the next queued query, if the single slot is free. */
  private pump(): void {
    if (this.inFlight !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.inFlight = next;
    this.timeoutHandle = setTimeout(() => {
      // Unanswered: the shared feed may have carried someone else's
      // answer over ours. Re-queue a bounded number of times, then record
      // `unknown`. Never delete the verdict and never notify — `pending`
      // and `unknown` paint identically, so there is nothing to re-mark,
      // and a deleted entry would be re-asked by the next pass forever.
      // The recorded `unknown` is still asked again once it ages out, which
      // is the retry that survives a server that was down for a while.
      this.timeoutHandle = null;
      this.inFlight = null;
      const tried = (this.attempts.get(next) ?? 0) + 1;
      if (tried < MAX_QUERY_ATTEMPTS) {
        this.attempts.set(next, tried);
        this.queue.push(next);
      } else {
        this.attempts.delete(next);
        this.verdicts.set(next, UNKNOWN);
      }
      this.pump();
    }, QUERY_TIMEOUT_MS);
    this.fileTree.sendQuery(next, this.projectDir);
  }

  /** Take delivery of a response, if it answers the question in flight. */
  private onSnapshot(): void {
    const pendingQuery = this.inFlight;
    if (pendingQuery === null) return;
    const snapshot = this.fileTree.getSnapshot();
    if (snapshot.query !== pendingQuery) return;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.inFlight = null;
    this.attempts.delete(pendingQuery);
    const match = bestIndexMatch(snapshot.results, pendingQuery);
    const next: PathVerdict =
      match === null
        ? MISSING
        : {
            state: "confirmed",
            canonical: resolveAgainstRoot(
              this.projectDir,
              trimTrailingSlash(match.path),
            ),
            isDir: match.is_dir === true,
          };
    const prev = this.verdicts.get(pendingQuery);
    this.verdicts.set(pendingQuery, next);
    // Only a changed answer re-marks. A re-ask that comes back still missing
    // paints nothing different, and notifying anyway would run the whole
    // annotation pass once a minute for every name the index does not have.
    if (prev === undefined || !sameVerdict(prev, next)) {
      this.notify([this.verdictKey(pendingQuery)]);
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
    this.unsubscribeTree();
    this.fileTree.dispose();
    this.feedStore.dispose();
    this.listeners.clear();
  }
}

/**
 * The resolver for one workspace, created on first use and kept for the
 * app's life. Filenames churn slowly and a reload rebuilds the world, so a
 * long-lived cache per project is the cheap shape; several cards on one
 * project share it and share its answers.
 */
const stores = new Map<string, FileNameResolutionStore>();

/**
 * The filename resolver for a project, or `null` when there is nothing to
 * search — no binding, or no connection to ask over.
 */
export function fileNameResolverFor(
  projectDir: string | null,
  workspaceKey: string | null,
): FileNameResolutionStore | null {
  if (projectDir === null || workspaceKey === null) return null;
  const existing = stores.get(workspaceKey);
  if (existing !== undefined) return existing;
  const connection = getConnection();
  if (connection === null) return null;
  const store = new FileNameResolutionStore(
    projectDir,
    workspaceKey,
    connection,
  );
  stores.set(workspaceKey, store);
  return store;
}

/** The verdict a context with no resolver reports: nothing is known. */
export const NO_NAME_VERDICT = UNKNOWN;
