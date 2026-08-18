/**
 * Changeset dash-join resolve overlay store — the `/btw`-style progress layer
 * over the resolution ladder's CONTROL frames (Spec S12, [P31]/[P32]).
 *
 * When the card asks tugcast to resolve a conflicted join, the ladder streams
 * `changeset_join_resolve_delta` frames (per file / rung, with the AI rung's
 * accumulated text) and finishes with `changeset_join_resolve_ok`
 * (resolved/unresolved/candidate/shape) or `_err`. This store keys that live
 * state by `(project_dir, dash)` and exposes it via `useSyncExternalStore`
 * ([L02]); the card renders a mini-transcript overlay while resolving, then a
 * reviewable result. The candidate is landed separately (a `changeset_join`
 * with the candidate) once the user confirms — this store never lands.
 *
 * **A run in flight always ends.** The ladder answers exactly once, over a
 * CONTROL frame that nothing replays — CONTROL is registered `LagPolicy::Warn`,
 * so a client that falls behind has frames dropped outright, and a socket that
 * dies mid-run takes the answer with it. A state left in `resolving` is a dash
 * whose Resolve button has vanished with nothing in its place and no way back,
 * for the life of the page. Two things close that, and neither needs to know
 * what went wrong:
 *
 * 1. **The wire dropping**, which is detectable the instant it happens:
 *    `connectionDidClose` fails every run in flight on the spot.
 * 2. **{@link RESOLVE_IDLE_DEADLINE_MS} of silence**, which covers everything
 *    else — a lagged stream, a server that died mid-ladder, a frame lost
 *    somewhere nobody has thought of.
 *
 * The deadline counts SILENCE, not elapsed time: every frame for a dash
 * restarts its clock. The AI rung emits a delta when it starts and one per
 * accumulated chunk thereafter, so a scribe grinding for minutes is never quiet
 * and never trips it; the only genuinely silent stretches are the algorithmic
 * rungs (git work) and the wait for a first token.
 *
 * **And the deadline is impatience, not cancellation** — which is what makes it
 * safe to keep short. Nothing here can stop tugcast's ladder, so an answer that
 * arrives late is still true and still applies, flipping the face from the
 * error to the result. A deadline that fires early costs a stale error for a
 * few seconds, never a lost resolution.
 *
 * Attached once at boot with {@link attachChangesetJoinStore}; consumed via
 * {@link useChangesetJoinResolve}.
 *
 * @module lib/changeset-join-store
 */

import { useSyncExternalStore } from "react";

import type { TugConnection } from "../connection";
import { FeedId } from "../protocol";
import { getConnectionLifecycle } from "./connection-lifecycle";

export type ResolvePhase = "idle" | "resolving" | "resolved" | "partial" | "error";

/** One conflicted file's live resolution progress (from the deltas). */
export interface FileProgress {
  path: string;
  rung: string;
  status: string;
  /** The AI rung's accumulated text, when streaming. */
  text: string;
}

/** One file's terminal resolution (from the ok frame). */
export interface ResolvedFile {
  path: string;
  resolvedBy: string;
  /**
   * What this resolution would land on the base — the server's unified diff for
   * this path. `null` when the ladder built no candidate, so there is nothing to
   * review. This is the artifact the review gate exists to put on screen.
   */
  diff: string | null;
  /**
   * Lines added and removed, as git counted them over the whole resolution —
   * not over `diff`, which the server caps. `null` for a binary path, and for
   * any resolution carrying no diff.
   */
  added: number | null;
  removed: number | null;
}

/** The live resolve state for one dash. */
export interface ResolveState {
  phase: ResolvePhase;
  /** Per-file streaming progress while `phase === "resolving"`. */
  progress: readonly FileProgress[];
  /** Files the ladder resolved (terminal). */
  resolved: readonly ResolvedFile[];
  /** Files still conflicting (terminal; non-empty ⇒ `partial`). */
  unresolved: readonly string[];
  /** The pre-built candidate commit to land, when fully resolved. */
  candidateCommit: string | null;
  /** `"squash"` | `"replay"` (terminal). */
  shape: string | null;
  /** Error detail when `phase === "error"`. */
  error: string | null;
  /**
   * Whether the user has acknowledged what the ladder decided. Every rung above
   * the replay probe resolves files by machine — rerere replays a cached
   * resolution that may be stale, the driver and the AI rung guess — so a
   * candidate built that way stays unlandable until this is true ([P31]).
   *
   * It lives here, keyed by dash, rather than in the landing face, because both
   * landing routes have to honour it: the lane's Join button and the composer's
   * `/join <name>`. A review held in a component would gate one and not the
   * other. Every fresh ladder run resets it — a new resolution is a new decision.
   */
  reviewed: boolean;
}

const IDLE: ResolveState = Object.freeze({
  phase: "idle",
  progress: Object.freeze([]) as readonly FileProgress[],
  resolved: Object.freeze([]) as readonly ResolvedFile[],
  unresolved: Object.freeze([]) as readonly string[],
  candidateCommit: null,
  shape: null,
  error: null,
  reviewed: false,
});

/**
 * How long a run may say NOTHING before it is declared lost.
 *
 * Silence, not duration: every frame for a dash restarts its clock, and the AI
 * rung streams continuously, so this is never the ceiling on a run that is
 * working — it is the ceiling on one that has stopped talking. Twelve seconds
 * clears the two stretches that are legitimately quiet (the algorithmic rungs,
 * and the wait for a first token from a model that may be loading) with room
 * over, and is short enough that nobody is left watching a dead spinner.
 *
 * It can afford to be tight because firing early is nearly free: the run is not
 * cancelled, and its answer still applies if it turns up.
 */
export const RESOLVE_IDLE_DEADLINE_MS = 12_000;

function key(projectDir: string, dash: string): string {
  return `${projectDir}|${dash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export class ChangesetJoinStore {
  private readonly _connection: TugConnection;
  private readonly _unsubscribe: () => void;
  private readonly _unobserveClose: () => void;
  private readonly _listeners = new Set<() => void>();
  private _states = new Map<string, ResolveState>();
  private readonly _decoder = new TextDecoder();
  /** One live idle timer per dash with a run in flight. */
  private readonly _deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _deadlineMs: number;

  constructor(connection: TugConnection, deadlineMs = RESOLVE_IDLE_DEADLINE_MS) {
    this._connection = connection;
    this._deadlineMs = deadlineMs;
    this._unsubscribe = connection.onFrame(FeedId.CONTROL, (payload) =>
      this._onControl(payload),
    );
    // A ladder run is a request whose only answer is a frame. If the wire drops
    // between the request and that frame, the answer is gone for good — the
    // server broadcast it to a socket that was already closed, and the
    // post-reconnect handshake replays feeds, not a CONTROL reply that has
    // already been sent. Without this the dash sits in `resolving` for the life
    // of the page: Resolve gone, no progress, no error, no way back.
    //
    // Same channel `code-session-store` uses to fail a turn in flight, for the
    // same reason.
    this._unobserveClose =
      getConnectionLifecycle()?.observeConnectionDidClose(() =>
        this._failInFlight(),
      ) ?? ((): void => {});
  }

  /**
   * Turn every run still in flight into a stated failure. Terminal states are
   * left alone — a result that already arrived survives the wire dropping.
   */
  private _failInFlight(): void {
    for (const [k, state] of [...this._states]) {
      if (state.phase !== "resolving") continue;
      this._fail(
        k,
        "The connection dropped while the ladder was running — its result is gone. Press Resolve again.",
      );
    }
  }

  /** End a run with a reason, and stop its clock. */
  private _fail(k: string, reason: string): void {
    const prev = this._states.get(k) ?? IDLE;
    this._clearDeadline(k);
    this._set(k, { ...prev, phase: "error", error: reason });
  }

  /**
   * (Re)start a dash's silence clock. Called on the request and on every frame
   * that follows it, so the deadline measures the gap between frames rather
   * than the length of the run.
   */
  private _armDeadline(k: string): void {
    this._clearDeadline(k);
    this._deadlines.set(
      k,
      setTimeout(() => {
        this._deadlines.delete(k);
        // Guard the phase: a terminal frame clears its own timer, but arriving
        // in the same tick as one that already fired must not resurrect an
        // error over a result.
        if (this._states.get(k)?.phase !== "resolving") return;
        this._fail(
          k,
          `No answer from the resolution ladder in ${Math.round(
            this._deadlineMs / 1000,
          )} seconds — the result was lost on the way back. Press Resolve again.`,
        );
      }, this._deadlineMs),
    );
  }

  private _clearDeadline(k: string): void {
    const timer = this._deadlines.get(k);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._deadlines.delete(k);
  }

  private _onControl(payload: Uint8Array): void {
    let body: unknown;
    try {
      body = JSON.parse(this._decoder.decode(payload));
    } catch {
      return;
    }
    if (!isRecord(body) || typeof body.action !== "string") return;
    const action = body.action;
    if (
      action !== "changeset_join_resolve_delta" &&
      action !== "changeset_join_resolve_ok" &&
      action !== "changeset_join_resolve_err"
    ) {
      return;
    }
    const projectDir = typeof body.project_dir === "string" ? body.project_dir : null;
    const dash = typeof body.dash === "string" ? body.dash : null;
    if (projectDir === null || dash === null) return;
    const k = key(projectDir, dash);
    const prev = this._states.get(k) ?? IDLE;

    if (action === "changeset_join_resolve_delta") {
      const path = typeof body.path === "string" ? body.path : "";
      const rung = typeof body.rung === "string" ? body.rung : "";
      const status = typeof body.status === "string" ? body.status : "";
      const text = typeof body.text === "string" ? body.text : "";
      const progress = prev.progress.filter((p) => p.path !== path);
      // The run is talking, so the silence clock goes back to zero. This is
      // what lets a scribe stream for minutes under a twelve-second deadline.
      this._armDeadline(k);
      this._set(k, {
        ...prev,
        phase: "resolving",
        progress: [...progress, { path, rung, status, text }],
        error: null,
      });
      return;
    }

    if (action === "changeset_join_resolve_ok") {
      const resolvedRaw = Array.isArray(body.resolved) ? body.resolved : [];
      const resolved: ResolvedFile[] = resolvedRaw
        .filter(isRecord)
        .map((r) => ({
          path: typeof r.path === "string" ? r.path : "",
          resolvedBy: typeof r.resolved_by === "string" ? r.resolved_by : "",
          diff: typeof r.diff === "string" ? r.diff : null,
          added: typeof r.added === "number" ? r.added : null,
          removed: typeof r.removed === "number" ? r.removed : null,
        }));
      const unresolved = readStringArray(body.unresolved);
      const candidateCommit =
        typeof body.candidate_commit === "string" ? body.candidate_commit : null;
      const shape = typeof body.shape === "string" ? body.shape : null;
      // A late answer still counts. The deadline never cancelled anything —
      // the ladder ran to completion server-side whatever this client believed
      // — so a result that turns up after the run was given up on is true, and
      // takes the face back off the error it was showing.
      this._clearDeadline(k);
      this._set(k, {
        ...prev,
        phase: unresolved.length > 0 ? "partial" : "resolved",
        resolved,
        unresolved,
        candidateCommit,
        shape,
        error: null,
        // A terminal frame is a new decision, whatever the last one was.
        reviewed: false,
      });
      return;
    }

    // changeset_join_resolve_err — the ladder's own refusal, which is a better
    // answer than any this store could invent, late or not.
    const detail = typeof body.detail === "string" ? body.detail : "resolve failed";
    this._fail(k, detail);
  }

  private _set(k: string, state: ResolveState): void {
    if (state.phase === "idle") {
      this._states.delete(k);
    } else {
      this._states.set(k, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_join_resolve` and mark the dash resolving (fresh state),
   * on a clock. Pressing again over a run that was given up on is deliberately
   * legal: the ladder builds its candidate off to the side and touches no
   * checkout, so a second run costs time and nothing else.
   */
  resolve(projectDir: string, dash: string): void {
    const k = key(projectDir, dash);
    this._armDeadline(k);
    this._set(k, {
      phase: "resolving",
      progress: [],
      resolved: [],
      unresolved: [],
      candidateCommit: null,
      shape: null,
      error: null,
      reviewed: false,
    });
    this._connection.sendControlFrame("changeset_join_resolve", {
      project_dir: projectDir,
      dash,
    });
  }

  state(projectDir: string, dash: string): ResolveState {
    return this._states.get(key(projectDir, dash)) ?? IDLE;
  }

  /**
   * Record that the user has read what the ladder decided — the second beat of
   * the review that {@link ResolveState.reviewed} gates. A no-op on a dash with
   * no terminal state: there is nothing to have reviewed.
   */
  markReviewed(projectDir: string, dash: string): void {
    const k = key(projectDir, dash);
    const prev = this._states.get(k);
    if (prev === undefined || prev.reviewed) return;
    this._set(k, { ...prev, reviewed: true });
  }

  /** Clear a dash's resolve state (cancel / after landing). */
  clear(projectDir: string, dash: string): void {
    const k = key(projectDir, dash);
    this._clearDeadline(k);
    this._set(k, IDLE);
  }

  dispose(): void {
    this._unsubscribe();
    this._unobserveClose();
    for (const timer of this._deadlines.values()) clearTimeout(timer);
    this._deadlines.clear();
    this._listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };
}

let _activeStore: ChangesetJoinStore | null = null;

export function attachChangesetJoinStore(
  conn: TugConnection,
  /** Overridable so a test can drive the real timer instead of faking a clock. */
  deadlineMs?: number,
): ChangesetJoinStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new ChangesetJoinStore(conn, deadlineMs);
  return _activeStore;
}

/**
 * The attached store, or null outside the app (gallery / fixtures) — the same
 * accessor shape `changeset-verb-store` publishes, for non-React readers like
 * the join mode controller.
 */
export function getChangesetJoinStore(): ChangesetJoinStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetChangesetJoinStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/** Test-only: feed a CONTROL frame body as if it arrived over the wire. */
export function _ingestJoinFrameForTest(body: unknown): void {
  if (_activeStore === null) return;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  (_activeStore as unknown as { _onControl(p: Uint8Array): void })._onControl(bytes);
}

/**
 * React hook: the live resolve state for one dash plus its triggers. Returns
 * idle + no-op triggers when no store is attached (gallery / fixtures).
 */
export function useChangesetJoinResolve(
  projectDir: string,
  dash: string,
): ResolveState & { resolve: () => void; clear: () => void; markReviewed: () => void } {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.state(projectDir, dash) ?? IDLE,
    () => IDLE,
  );
  const resolve = (): void => {
    _activeStore?.resolve(projectDir, dash);
  };
  const clear = (): void => {
    _activeStore?.clear(projectDir, dash);
  };
  const markReviewed = (): void => {
    _activeStore?.markReviewed(projectDir, dash);
  };
  return { ...state, resolve, clear, markReviewed };
}
