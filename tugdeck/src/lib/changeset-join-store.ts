/**
 * Changeset dash-join resolve overlay store — the `/btw`-style progress layer
 * over the resolution ladder's CONTROL frames (Spec S12, [P31]/[P32]).
 *
 * When the card asks tugcast to resolve a conflicted join, the ladder streams
 * `changeset_join_resolve_delta` frames (per file / rung, with the AI rung's
 * accumulated text) and finishes with `changeset_join_resolve_ok` or `_err`.
 * This store keys that live state by `(workspace_key, dash)` and exposes it via
 * `useSyncExternalStore` ([L02]); the card renders a mini-transcript overlay
 * while resolving.
 *
 * **It holds the run, never the result.** The candidate the ladder builds, what
 * it decided per file and by which rung, and whether anybody has read that, are
 * written into git and reported on the dash's feed entry — so an `_ok` frame is
 * an *end-of-run* signal here and nothing more. That split is what makes the
 * whole overlay disposable: this state can be lost to a dropped socket, a
 * reload, or a relaunch without costing a resolution, because the resolution
 * was never in it.
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
 * safe to keep short. Nothing here can stop tugcast's ladder, so a run this
 * client gave up on still finishes, still writes its candidate, and still bumps
 * the feed: the row flips to the resolved face on its own, over the top of the
 * error. That is why the error says the result will appear rather than telling
 * the user to press Resolve again.
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

export type ResolvePhase = "idle" | "resolving" | "error";

/** One conflicted file's live resolution progress (from the deltas). */
export interface FileProgress {
  path: string;
  rung: string;
  status: string;
  /** The AI rung's accumulated text, when streaming. */
  text: string;
  /**
   * The candidate the resolver rung is working on, when it has one ([P08]).
   *
   * Its own field because the resolver has no path: it works over the whole
   * tree, and its progress is about a commit. The sha used to arrive in `path`,
   * which put a hash in the face's filename column and made each status of one
   * run key as a separate file.
   */
  candidate?: string;
}

/**
 * The live resolve state for one dash — an overlay, and only an overlay.
 *
 * What the ladder *built* is not here. The candidate, the per-file resolutions
 * and their rungs, and whether anybody has read them all live on the dash's
 * feed entry, written into git by the server before it bumps the feed. So this
 * holds the three things that are genuinely ephemeral: a run is in flight, what
 * it has said so far, and — when it stopped talking — why the client gave up
 * waiting.
 */
export interface ResolveState {
  phase: ResolvePhase;
  /** Per-file streaming progress while `phase === "resolving"`. */
  progress: readonly FileProgress[];
  /**
   * Why the last thing the user asked for did not happen.
   *
   * Set with `phase === "error"` when a run itself failed, and *without*
   * touching the phase when a side press was refused — answering a question
   * nobody is waiting on, or overriding a candidate that no longer stands.
   * Those refusals arrive while a run may still be perfectly healthy, so
   * routing them through the phase would paint live work as a failure, which
   * is the false-error class this round exists to remove. What they may never
   * do is vanish ([L31]).
   */
  error: string | null;
}

const IDLE: ResolveState = Object.freeze({
  phase: "idle",
  progress: Object.freeze([]) as readonly FileProgress[],
  error: null,
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

function key(workspaceKey: string, dash: string): string {
  return `${workspaceKey}|${dash}`;
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
        "The connection dropped while the ladder was running — its result will appear on this row if it finished.",
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
          )} seconds — its result will appear on this row if it finished.`,
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
      action !== "changeset_join_resolve_err" &&
      action !== "changeset_join_override_ok" &&
      action !== "changeset_join_override_err" &&
      action !== "changeset_join_question_answer_err"
    ) {
      return;
    }
    // The server echoes `project_dir` back exactly as it was sent, and every
    // send on this path carries the workspace key — so the reply correlates to
    // the same cell the request opened, with no spelling to reconcile ([L29]).
    const workspaceKey = typeof body.project_dir === "string" ? body.project_dir : null;
    const dash = typeof body.dash === "string" ? body.dash : null;
    if (workspaceKey === null || dash === null) return;
    const k = key(workspaceKey, dash);
    const prev = this._states.get(k) ?? IDLE;

    // A press that changed nothing has to say so. Both of these are refusals
    // of a *side* act — the run they belong to, if there is one, is unharmed —
    // so they land as a stated reason and leave the phase where it was.
    if (
      action === "changeset_join_override_err" ||
      action === "changeset_join_question_answer_err"
    ) {
      const detail = typeof body.detail === "string" ? body.detail : null;
      this._note(
        k,
        detail ??
          (action === "changeset_join_override_err"
            ? "Join anyway was refused"
            : "That answer was not delivered"),
      );
      return;
    }
    if (action === "changeset_join_override_ok") {
      // The override itself comes back on the dash's feed entry, as
      // `override_for`. All this clears is a refusal from an earlier press.
      if (prev.error !== null) this._note(k, null);
      return;
    }

    if (action === "changeset_join_resolve_delta") {
      const path = typeof body.path === "string" ? body.path : "";
      const rung = typeof body.rung === "string" ? body.rung : "";
      const status = typeof body.status === "string" ? body.status : "";
      const text = typeof body.text === "string" ? body.text : "";
      const candidate = typeof body.candidate === "string" ? body.candidate : undefined;
      const progress = prev.progress.filter((p) => p.path !== path);
      // The resolver rung is silent by nature, at every status and not only
      // while it waits on a person ([P02]). It reports four discrete beats —
      // working, asking, verifying, iterating — with minutes of legitimate
      // quiet between them: a model composing a reconciliation, a build, a
      // test selection. The deadline's premise is per-chunk streaming, which is
      // true of the scribe and false here, so on this rung it measured nothing
      // and declared healthy work dead.
      //
      // Liveness for the resolver is the server's ([P02]): a per-turn silence
      // bound, a tier-0 timeout, and an overall deadline, each landing in the
      // durable stuck fact with a sentence naming which one fired. The client
      // keeps the one failure it can genuinely see — a dropped wire — and
      // stops guessing at the rest.
      if (rung === "resolver") {
        this._clearDeadline(k);
      } else {
        // The run is talking, so the silence clock goes back to zero. This is
        // what lets a scribe stream for minutes under a twelve-second deadline.
        this._armDeadline(k);
      }
      this._set(k, {
        ...prev,
        phase: "resolving",
        progress: [
          ...progress,
          { path, rung, status, text, ...(candidate !== undefined ? { candidate } : {}) },
        ],
        error: null,
      });
      return;
    }

    if (action === "changeset_join_resolve_ok") {
      // A late answer still counts. The deadline never cancelled anything —
      // the ladder ran to completion server-side whatever this client believed
      // — so a result that turns up after the run was given up on is true, and
      // takes the face back off the error it was showing.
      this._clearDeadline(k);
      const unresolved = readStringArray(body.unresolved);
      if (unresolved.length > 0) {
        // The ladder's honest dead end, and the one terminal fact the feed
        // cannot state: the dash's conflicts will still be there, but nothing
        // on the entry says a run just tried them and stopped. Re-running
        // decides nothing new, so the sentence names the files instead.
        this._set(k, {
          phase: "error",
          progress: prev.progress,
          error: `Still conflicting — resolve by hand: ${unresolved.join(", ")}`,
        });
        return;
      }
      // Everything else the run produced — the candidate, each file's rung and
      // diff — is already in git and already on its way back as feed state, so
      // the overlay's whole job is to get out of the way.
      this._set(k, IDLE);
      return;
    }

    // changeset_join_resolve_err — the ladder's own refusal, which is a better
    // answer than any this store could invent, late or not.
    const detail = typeof body.detail === "string" ? body.detail : "resolve failed";
    // Unless nothing was refused *but the press*. An admission refusal means a
    // run already holds this dash — so it arrives on the cell that run is
    // streaming into, and failing the cell would report the healthy run as dead
    // on the strength of somebody having asked for a second one.
    if (body.admission === true) {
      this._note(k, detail);
      return;
    }
    this._fail(k, detail);
  }

  /**
   * State a reason on a dash without claiming its run failed (`null` clears).
   *
   * The phase is untouched: a refused answer or a refused override says
   * something about the press, not about the ladder, and a resolve that is
   * still working must keep rendering as work.
   */
  private _note(k: string, reason: string | null): void {
    const prev = this._states.get(k) ?? IDLE;
    this._set(k, { ...prev, error: reason });
  }

  private _set(k: string, state: ResolveState): void {
    // Idle is the absence of a run, but a stated reason is not absence: a
    // refusal recorded on a dash with nothing running is exactly the case
    // where dropping the cell would swallow the sentence.
    if (state.phase === "idle" && state.error === null) {
      this._states.delete(k);
    } else {
      this._states.set(k, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_join_resolve` and mark the dash resolving (fresh state),
   * on a clock.
   *
   * Pressing again while a run is live is **refused by the server**, by name.
   * That used to be free — the ladder built its candidate off to the side and
   * touched no checkout — but a resolve now owns a workshop worktree that a
   * second run would `reset --hard` under the first one's live resolver. One
   * dash admits one run; the refusal arrives as a `changeset_join_resolve_err`
   * naming what holds it.
   */
  resolve(workspaceKey: string, dash: string): void {
    const k = key(workspaceKey, dash);
    this._armDeadline(k);
    this._set(k, { phase: "resolving", progress: [], error: null });
    this._connection.sendControlFrame("changeset_join_resolve", {
      project_dir: workspaceKey,
      dash,
    });
  }

  state(workspaceKey: string, dash: string): ResolveState {
    return this._states.get(key(workspaceKey, dash)) ?? IDLE;
  }

  /**
   * Record that the user has read what the ladder decided — the second beat of
   * the review the land gate holds for.
   *
   * The acknowledgment is pinned to `candidate`'s sha server-side, so it cannot
   * outlive the artifact it answered: a candidate rebuilt after the base moved
   * demands a fresh reading. The mark comes back on the dash's feed entry; this
   * send only asks for it.
   */
  review(workspaceKey: string, dash: string, candidate: string): void {
    this._connection.sendControlFrame("changeset_join_review", {
      project_dir: workspaceKey,
      dash,
      candidate,
    });
  }

  /**
   * Record that the user has looked at a red verdict and chosen to join past
   * it ([P04]).
   *
   * Scoped to `candidate`, so a resolution built after this decision has to be
   * decided about on its own terms.
   *
   * Sent, not held. The override used to be client-local on the reasoning that
   * nothing durable should record a red being waved through — but the gate it
   * defeats now lives in `join_in`, where the CLI and every other deck meet it
   * too, so a local flag defeated nothing. Worse, it was written into a state
   * the store immediately dropped: a settled post-resolve dash is idle, idle
   * was deleted, and the one press this control existed for did nothing at
   * all. The decision goes where the gate is, anchored to the sha it was made
   * about, and comes back as `override_for` on the dash's feed entry.
   */
  overrideRed(workspaceKey: string, dash: string, candidate: string): void {
    this._connection.sendControlFrame("changeset_join_override", {
      project_dir: workspaceKey,
      dash,
      candidate,
    });
  }

  /**
   * Answer the escalation a blocked resolve raised ([P06]).
   *
   * `requestId` is what makes the answer safe: the resolver may have expired,
   * or a later resolve may have asked something else, and an answer must never
   * resolve a question it was not written for. `answer` is an option label or
   * the user's own words, and reaches the resolver verbatim either way.
   *
   * The reply says whether anybody was still waiting — a question that expired
   * refuses rather than absorbing the press.
   */
  answerQuestion(
    workspaceKey: string,
    dash: string,
    requestId: string,
    answer: string,
  ): void {
    this._connection.sendControlFrame("changeset_join_question_answer", {
      project_dir: workspaceKey,
      dash,
      request_id: requestId,
      answer,
    });
  }

  /** Clear a dash's resolve state (cancel / after landing). */
  clear(workspaceKey: string, dash: string): void {
    const k = key(workspaceKey, dash);
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
  workspaceKey: string,
  dash: string,
): ResolveState & { resolve: () => void; clear: () => void; review: (candidate: string) => void } {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.state(workspaceKey, dash) ?? IDLE,
    () => IDLE,
  );
  const resolve = (): void => {
    _activeStore?.resolve(workspaceKey, dash);
  };
  const clear = (): void => {
    _activeStore?.clear(workspaceKey, dash);
  };
  const review = (candidate: string): void => {
    _activeStore?.review(workspaceKey, dash, candidate);
  };
  return { ...state, resolve, clear, review };
}
