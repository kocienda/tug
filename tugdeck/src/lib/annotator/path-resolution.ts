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
 * and a lookup past {@link RETRY_AFTER_MS} asks again. It keeps serving the
 * old answer meanwhile — the re-ask is invisible unless it changes
 * something, and {@link PathResolutionStore.applyProbeResult} notifies only
 * on change, so a still-missing path costs one silent probe a minute and a
 * newly-arrived one lights up on the next pass. `confirmed` never expires:
 * re-asking it could only ever take a live link away, and the open gesture
 * finds out for real anyway.
 *
 * The endpoint rejects relative paths outright, so a relative candidate is
 * joined against the session cwd first. Until the cwd arrives — it is null
 * until the session handshake lands — a relative candidate is parked
 * rather than probed, and the pass that follows the cwd's arrival asks
 * again.
 *
 * @module lib/annotator/path-resolution
 */

/** Cap on paths per request, matching the endpoint's own batch cap. */
const MAX_STAT_PATHS = 64;

/** How long wants accumulate before going out as one batch. */
const FLUSH_DELAY_MS = 16;

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
  private readonly listeners = new Set<() => void>();
  /** When each path was last asked about — the clock a re-ask runs on. */
  private readonly askedAt = new Map<string, number>();
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  private currentVersion = 0;

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
  subscribe = (listener: () => void): (() => void) => {
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
    let changed = false;
    for (const path of paths) {
      const next = verdictFor(path, result);
      const prev = this.verdicts.get(path);
      if (next === null) {
        this.verdicts.set(path, UNKNOWN);
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
        changed = true;
      }
    }
    if (changed) this.notify();
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

  private notify(): void {
    this.currentVersion += 1;
    for (const listener of this.listeners) listener();
  }
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
