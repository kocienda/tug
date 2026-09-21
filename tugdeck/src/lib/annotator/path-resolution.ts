/**
 * Path resolution — does this path reference point at a file that exists?
 *
 * A path only becomes actionable once the answer is yes, because a link
 * that dead-ends is worse than plain text. The answer comes from the
 * filesystem, which means it is asynchronous, which means the annotator's
 * synchronous DOM pass cannot wait for it. This module is how those two
 * clocks are reconciled.
 *
 * **Why a store and not a fetch per call.** Streaming re-runs the pass on
 * every delta, and a pass over a long transcript sees the same paths over
 * and over. A probe per pass would issue the same question dozens of
 * times per second. Instead `lookup` is synchronous and answers from
 * cache: a path it has never seen is recorded as wanted and returns
 * `pending`, a short debounce later the accumulated wants go out as one
 * deduped batch, and the verdicts land in a cache that every subsequent
 * pass reads for free. Steady state does no network work at all.
 *
 * Verdict arrival bumps a version and notifies listeners, which is what
 * drives the re-annotation pass that turns a newly-confirmed path into a
 * link over already-rendered ink. Only a real answer notifies: a lost one
 * changes nothing painted, so it stays silent.
 *
 * **Honesty under failure.** A transport error records candidates as
 * `unknown`, never `confirmed` and never `missing`: an unreachable server
 * means we don't know. Recorded, not forgotten — a forgotten verdict is
 * re-asked by the very re-annotation its forgetting triggers, and that loop
 * never converges. The one thing this must never do is manufacture a link.
 *
 * **A "no" expires; a "yes" does not.** `missing` and `unknown` are answers
 * about a moment, and the moment passes: a Overview post narrates a plan file
 * minutes before it is written, a probe is lost while the server restarts.
 * Cached for the app's life, either one leaves a reference permanently dead
 * on a surface that is still open, and no amount of scrolling back can
 * revive it. So a non-affirmative verdict carries the time it was asked at,
 * and past {@link RETRY_AFTER_MS} it is asked again. It keeps serving the old
 * answer meanwhile — the re-ask is invisible unless it changes something, and
 * {@link PathResolutionStore.applyProbeResult} notifies only on change, so a
 * still-missing path costs one silent probe a minute. `confirmed` never
 * expires on the timer: re-asking it could only ever take a live link away,
 * and the open gesture finds out for real anyway. It IS re-asked when the
 * world says so — an event naming it, and a `resync` frame, which says the
 * server dropped events it cannot name and is the only way a deletion that
 * happened inside a lost window ever reaches a confirmed path.
 *
 * **The store fires that re-ask itself.** It used to be evaluated inside
 * `lookup`, which runs only inside an annotation pass — so the expiry could
 * only reach a path some pass happened to ask about again, and the ink that
 * most needed it was precisely the ink no pass was coming back to. The store
 * now holds a timer against the soonest verdict it is due to re-ask,
 * re-probes every expired key when it fires, and arms the next one; a lookup
 * that meets an expired verdict still re-asks on the spot, which is the cheap
 * path rather than the mechanism.
 *
 * **And the timer is a floor, not the mechanism.** A minute is far longer
 * than a reader waits, so nothing may depend on it to be correct: it exists
 * so that nothing is stuck forever, never so that something is right
 * eventually. What makes the verdict follow the world in a beat is the
 * filesystem's own word about the file.
 *
 * **The world drives the verdict.** The store subscribes to the `FILESYSTEM`
 * feed the deck already receives, and an event naming a path it holds a
 * verdict on re-probes that path at once — whatever the event's kind, since
 * the feed collapses a create and a remove on one path into a `Modified`.
 * A `Created`, `Removed` or `Renamed` naming a **directory** reaches the
 * paths beneath it too; a `Modified` does not, because macOS fires one on a
 * parent whenever anything inside changes. The re-probe changes nothing
 * painted until it answers, and it answers in a watcher debounce plus one
 * verdict batch, which is beneath what a reader notices. A path outside
 * every watched workspace hears nothing and falls to the timer, which is
 * what the timer is for.
 *
 * The endpoint rejects relative paths outright, so a relative candidate is
 * joined against the session cwd first. Until the cwd arrives — it is null
 * until the session handshake lands — a relative candidate is parked
 * rather than probed, and the pass that follows the cwd's arrival asks
 * again.
 *
 * @module lib/annotator/path-resolution
 */

import { noteVerdictKey, pathVerdictKey, type VerdictKey } from "./verdict-keys";
import { getConnection } from "../connection-singleton";
import { frameRoot, parseFilesystemFrame } from "../filesystem-feed";
import { FeedId } from "../../protocol";

/** Cap on paths per request, matching the endpoint's own batch cap. */
const MAX_STAT_PATHS = 64;

/** How long wants accumulate before going out as one batch. */
const FLUSH_DELAY_MS = 16;

/**
 * The event kinds that can change whether *other* paths exist — the kinds
 * whose subject may be a directory the store holds verdicts under.
 *
 * `Modified` is not one, and that asymmetry is the whole rule: macOS fires a
 * modify on a parent directory whenever anything inside it changes, so
 * treating one as news about the directory's contents would re-probe a
 * transcript's worth of paths on every keystroke-save. An event naming a
 * path *exactly* is taken whatever its kind, because the feed's own
 * de-duplication collapses a create and a remove on one path into a single
 * `Modified` (`tugcast/src/feeds/file_watcher.rs`) — so kind is not a
 * reliable existence signal, and only the subject is.
 */
const CONTAINER_KINDS = new Set(["Created", "Removed", "Renamed"]);

/**
 * How long a `missing` or `unknown` verdict is trusted before the path is
 * asked about again. Long enough that a wall of unresolved refs costs one
 * batched probe a minute; short enough that a file created while its post is
 * on screen becomes a link about as fast as a reader could notice it didn't.
 */
export const RETRY_AFTER_MS = 60_000;

/** What is known about a path reference. */
export type PathVerdict =
  /** Never asked, or asked and the answer was lost. Not actionable. */
  | { state: "unknown" }
  /** A probe is in flight. Not actionable yet. */
  | { state: "pending" }
  /**
   * Something is there. Actionable, at the canonical path. `isDir` says
   * which gesture it earns — a folder is revealed, not opened in an
   * editor.
   */
  | { state: "confirmed"; canonical: string; isDir: boolean }
  /** Nothing is there. Never actionable. */
  | { state: "missing" };

const UNKNOWN: PathVerdict = { state: "unknown" };
const PENDING: PathVerdict = { state: "pending" };
const MISSING: PathVerdict = { state: "missing" };

/**
 * Join a relative path onto `cwd` and normalize away `.` and `..`
 * segments. Pure string work — the endpoint canonicalizes for real, and
 * its own guard rejects anything that escapes; this only needs to produce
 * a well-formed absolute path to ask about.
 */
export function joinPath(cwd: string, relative: string): string {
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const segments: string[] = [];
  for (const segment of `${base}/${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * The absolute path a candidate should be probed at, or `null` when it
 * cannot be resolved yet — a relative path with no cwd to resolve
 * against. Absolute candidates are normalized so two spellings of one
 * path share a cache entry.
 */
export function resolveCandidate(
  rawPath: string,
  cwd: string | null,
): string | null {
  if (rawPath.startsWith("/")) return joinPath("/", rawPath);
  if (cwd === null) return null;
  return joinPath(cwd, rawPath);
}

/** Split `paths` into batches the endpoint will accept whole. */
export function chunkPaths(
  paths: readonly string[],
  size: number = MAX_STAT_PATHS,
): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += size) {
    chunks.push(paths.slice(i, i + size));
  }
  return chunks;
}

/** The endpoint's answer for one batch. */
export interface ProbeResult {
  exists: Record<string, boolean>;
  canonical: Record<string, string>;
  /** Reachable paths that are directories; absent means file-like. */
  isDir: Record<string, boolean>;
}

/** Ask the filesystem about a batch of absolute paths. */
async function probePaths(paths: readonly string[]): Promise<ProbeResult | null> {
  try {
    const res = await fetch("/api/fs/stat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `any` is the loose question: a reference in ink can name a
      // directory, a symlink, a device node — all real things worth
      // pointing at. Asking only for regular files would leave true
      // references inert.
      body: JSON.stringify({ paths, kind: "any" }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      exists?: unknown;
      canonical?: unknown;
      isDir?: unknown;
    };
    if (body.exists === null || typeof body.exists !== "object") return null;
    const exists: Record<string, boolean> = {};
    for (const [path, value] of Object.entries(
      body.exists as Record<string, unknown>,
    )) {
      exists[path] = value === true;
    }
    const canonical: Record<string, string> = {};
    if (body.canonical !== null && typeof body.canonical === "object") {
      for (const [path, value] of Object.entries(
        body.canonical as Record<string, unknown>,
      )) {
        if (typeof value === "string") canonical[path] = value;
      }
    }
    const isDir: Record<string, boolean> = {};
    if (body.isDir !== null && typeof body.isDir === "object") {
      for (const [path, value] of Object.entries(
        body.isDir as Record<string, unknown>,
      )) {
        isDir[path] = value === true;
      }
    }
    return { exists, canonical, isDir };
  } catch {
    return null;
  }
}

/**
 * The app's path-verdict cache. One per app: paths churn slowly, and a
 * reload rebuilds the world anyway.
 */
export class PathResolutionStore {
  private readonly verdicts = new Map<string, PathVerdict>();
  private readonly wanted = new Set<string>();
  private readonly listeners = new Set<(keys: readonly VerdictKey[]) => void>();
  /** When each path was last asked about — the clock a re-ask runs on. */
  private readonly askedAt = new Map<string, number>();
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  /** The timer armed against {@link retryDueAt}, if one is. */
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  /** When the soonest held non-affirmative verdict comes due for a re-ask. */
  private retryDueAt: number | null = null;
  private currentVersion = 0;
  /** Unregisters the `FILESYSTEM` callback; null while unattached. */
  private unsubscribeFilesystem: (() => void) | null = null;
  private filesystemAttached = false;

  /**
   * The clock is injected so a test can age a verdict without waiting out a
   * minute, and the probe so it can read which paths the store decided to
   * ask about — the decision the expiry rule exists to make. Production
   * passes neither.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly probe: (
      paths: readonly string[],
    ) => Promise<ProbeResult | null> = probePaths,
  ) {}

  /**
   * What is known about `rawPath` right now, resolving it against `cwd`
   * first. Synchronous by contract — the annotator's DOM pass calls this
   * for every path candidate it meets. A path this has never seen is
   * recorded as wanted and reported `pending` — the state that marks its
   * container as awaiting an answer; the probe's answer bumps the version
   * and re-marks the waiting ink.
   */
  lookup(rawPath: string, cwd: string | null): PathVerdict {
    const resolved = resolveCandidate(rawPath, cwd);
    // A relative candidate with no cwd yet: parked, not asked. The cwd's
    // arrival changes the annotation context, which re-runs the pass with
    // something to resolve against.
    if (resolved === null) return UNKNOWN;
    // Attached on first use rather than at construction: this is a module
    // singleton, evaluated before `main.tsx` has a connection to hand it. By
    // the first lookup the wire exists, and a run with no wire at all (the
    // gallery, a test) simply keeps asking and keeps getting null.
    this.ensureFilesystemWatch();
    // The answer about to be returned rests on this key, whatever it says.
    // A pass records every key it consulted, so the `missing` this may serve
    // is as much a dependency as a `confirmed` one — see `verdict-keys.ts`.
    noteVerdictKey(pathVerdictKey(resolved));
    const known = this.verdicts.get(resolved);
    if (known !== undefined) {
      // A stale "no" is asked again, and the old answer is what this call
      // returns: nothing painted should flicker back to `pending` over a
      // question the reader never asked. Stamping the ask inside `want`
      // is what keeps the in-flight window from re-asking every pass.
      if (this.expired(resolved, known)) this.want(resolved);
      return known;
    }
    this.verdicts.set(resolved, PENDING);
    this.want(resolved);
    return PENDING;
  }

  /** Subscribe to verdict arrivals. Returns the unsubscribe. */
  subscribe = (
    listener: (keys: readonly VerdictKey[]) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Bumped whenever verdicts change. The annotation inputs read this, so
   * a probe's answer re-marks the ink that was waiting on it.
   */
  version = (): number => this.currentVersion;

  /**
   * Record a probe's answer. A path the response did not mention (past
   * the endpoint's cap, or dropped) is recorded as a terminal `unknown` —
   * silently, since nothing painted changes — rather than forgotten, so
   * the next pass does not re-ask a question the transport already failed
   * to answer.
   */
  applyProbeResult(paths: readonly string[], result: ProbeResult | null): void {
    const changed: VerdictKey[] = [];
    for (const path of paths) {
      const next = verdictFor(path, result);
      const prev = this.verdicts.get(path);
      if (next === null) {
        this.verdicts.set(path, UNKNOWN);
        this.noteRetryDue(path);
        continue;
      }
      if (
        prev === undefined ||
        prev.state !== next.state ||
        (prev.state === "confirmed" &&
          next.state === "confirmed" &&
          prev.canonical !== next.canonical)
      ) {
        this.verdicts.set(path, next);
        changed.push(pathVerdictKey(path));
      }
      // Whatever it settled as, a "no" comes due for a re-ask a minute out,
      // and nothing but this store's own timer is going to ask.
      if (this.verdicts.get(path)?.state !== "confirmed") {
        this.noteRetryDue(path);
      }
    }
    if (changed.length > 0) this.notify(changed);
  }

  /**
   * Whether `verdict` is a "no" old enough to be worth asking again. A
   * confirmed path never expires; a pending one is already in flight.
   */
  private expired(resolved: string, verdict: PathVerdict): boolean {
    if (verdict.state !== "missing" && verdict.state !== "unknown") {
      return false;
    }
    const asked = this.askedAt.get(resolved);
    // A verdict recorded without ever being asked here — `applyProbeResult`
    // called directly — is stale by construction, and asking is the answer.
    return asked === undefined || this.now() - asked >= RETRY_AFTER_MS;
  }

  /** Record that `resolved` is wanted, and schedule the batch. */
  private want(resolved: string): void {
    this.askedAt.set(resolved, this.now());
    if (this.wanted.has(resolved)) return;
    this.wanted.add(resolved);
    if (this.flushHandle !== null) return;
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  /**
   * Send every accumulated want, in batches the endpoint accepts. The
   * wants are already `pending` (set at lookup), so nothing is notified
   * here — only answers are.
   */
  private async flush(): Promise<void> {
    const paths = Array.from(this.wanted);
    this.wanted.clear();
    if (paths.length === 0) return;
    for (const chunk of chunkPaths(paths)) {
      this.applyProbeResult(chunk, await this.probe(chunk));
    }
  }

  private notify(keys: readonly VerdictKey[]): void {
    this.currentVersion += 1;
    for (const listener of this.listeners) listener(keys);
  }

  /**
   * Listen to the `FILESYSTEM` feed, once, if there is a connection to
   * listen over. `onFrame` handles the wire-level subscription itself and
   * replays the last frame to a late subscriber, which at worst costs one
   * re-probe of the paths an old batch named.
   */
  private ensureFilesystemWatch(): void {
    if (this.filesystemAttached) return;
    const connection = getConnection();
    if (connection === null) return;
    this.filesystemAttached = true;
    this.unsubscribeFilesystem = connection.onFrame(
      FeedId.FILESYSTEM,
      (payload: Uint8Array) => this.applyFilesystemFrame(payload),
    );
  }

  /**
   * The world's word about a batch of paths: re-probe every verdict it
   * contradicts, or might.
   *
   * A held path is re-asked when the batch names it, or names any directory
   * it lives under — removing a directory tree is reported as the directory
   * going away rather than as an event per file inside it, and creating one
   * is reported the same way, so the ancestor walk is what reaches the files
   * either way. Only {@link CONTAINER_KINDS} get that walk. The walk goes up
   * from each held path through the batch's names rather than comparing
   * every name against every path, so a large batch costs one hash lookup
   * per ancestor rather than a product.
   *
   * Nothing is dropped and nothing is set back to `pending`: the old answer
   * keeps being served until the probe replaces it, which is what keeps a
   * path that lights late from flashing on its way ([D04]).
   *
   * A `resync` frame is the other door: the server is saying it dropped
   * events rather than naming any, so EVERY held verdict under its root is
   * re-asked — including a `confirmed` one, which an ordinary batch only
   * re-probes when something names it. A confirmed path whose deletion
   * arrived in the lost window would otherwise stay lit forever.
   *
   * Public for the same reason {@link applyProbeResult} is: it is the door
   * an answer from outside comes in through, and a test that hands it a
   * frame is exercising the real handler rather than a cast into a private.
   */
  applyFilesystemFrame(payload: Uint8Array): void {
    const frame = parseFilesystemFrame(payload);
    if (frame === null) return;
    const root = frameRoot(frame);
    if (frame.resync) {
      // An empty key names no root, so it names all of them — the router's
      // own lag frame, where the client cannot know which project it lost.
      for (const resolved of this.verdicts.keys()) {
        if (root === "" || resolved.startsWith(`${root}/`)) this.want(resolved);
      }
      return;
    }
    const named = new Set<string>();
    const containers = new Set<string>();
    for (const event of frame.events) {
      const reachesUnder = CONTAINER_KINDS.has(event.kind);
      for (const relative of [event.path, event.from, event.to]) {
        if (relative === undefined) continue;
        const absolute = `${root}/${relative}`;
        named.add(absolute);
        if (reachesUnder) containers.add(absolute);
      }
    }
    if (named.size === 0) return;
    for (const resolved of this.verdicts.keys()) {
      if (named.has(resolved) || namesOrContains(containers, resolved)) {
        this.want(resolved);
      }
    }
  }

  /**
   * Record that `resolved` is due for a re-ask, and bring the timer forward
   * if it is due sooner than whatever the timer is already waiting on. A
   * verdict recorded without ever being asked here is due immediately, which
   * is the same reading {@link expired} takes of it.
   */
  private noteRetryDue(resolved: string): void {
    const due = this.dueAt(resolved);
    if (this.retryDueAt !== null && this.retryDueAt <= due) return;
    this.retryDueAt = due;
    this.armRetry();
  }

  /** When the verdict held for `resolved` should be asked about again. */
  private dueAt(resolved: string): number {
    const asked = this.askedAt.get(resolved);
    return asked === undefined ? this.now() : asked + RETRY_AFTER_MS;
  }

  /** Point the one timer at {@link retryDueAt}, replacing any earlier one. */
  private armRetry(): void {
    if (this.retryHandle !== null) {
      clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
    if (this.retryDueAt === null) return;
    const delay = Math.max(0, this.retryDueAt - this.now());
    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      this.sweepExpired();
    }, delay);
  }

  /**
   * Re-ask every held verdict that has aged out, and arm the timer against
   * whichever is due next.
   *
   * This is the arm that runs with nobody watching. The probe it schedules
   * answers into {@link applyProbeResult}, which notifies on a change, and
   * the ink painted under the old answer re-marks by key — so a reference
   * nothing is going to walk past again still stops being wrong.
   */
  private sweepExpired(): void {
    for (const [resolved, verdict] of this.verdicts) {
      if (this.expired(resolved, verdict)) this.want(resolved);
    }
    let soonest: number | null = null;
    for (const [resolved, verdict] of this.verdicts) {
      if (verdict.state === "confirmed") continue;
      const due = this.dueAt(resolved);
      if (soonest === null || due < soonest) soonest = due;
    }
    this.retryDueAt = soonest;
    this.armRetry();
  }

  /**
   * Drop the timers and the listeners. The app's singleton never does this —
   * paths churn slowly and a reload rebuilds the world — but a store a test
   * stood up should not outlive the test that made it.
   */
  dispose(): void {
    if (this.flushHandle !== null) clearTimeout(this.flushHandle);
    if (this.retryHandle !== null) clearTimeout(this.retryHandle);
    this.unsubscribeFilesystem?.();
    this.unsubscribeFilesystem = null;
    this.filesystemAttached = false;
    this.flushHandle = null;
    this.retryHandle = null;
    this.retryDueAt = null;
    this.listeners.clear();
  }
}

/**
 * Whether `named` holds any directory `path` lives under.
 *
 * Exported for the unit test, which is the only place the ancestor rule can
 * be stated as a claim rather than watched for.
 */
export function namesOrContains(
  named: ReadonlySet<string>,
  path: string,
): boolean {
  for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
    if (named.has(path.slice(0, cut))) return true;
  }
  return false;
}

/**
 * The verdict a probe result implies for one path, or `null` when the
 * result says nothing about it (a lost answer is not a "no").
 */
function verdictFor(
  path: string,
  result: ProbeResult | null,
): PathVerdict | null {
  if (result === null) return null;
  const exists = result.exists[path];
  if (exists === undefined) return null;
  if (!exists) return MISSING;
  const canonical = result.canonical[path] ?? path;
  return { state: "confirmed", canonical, isDir: result.isDir[path] === true };
}

/** The app's single store. */
export const pathResolutionStore = new PathResolutionStore();
