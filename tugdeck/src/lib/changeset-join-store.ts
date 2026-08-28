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
 * **The client stops guessing at liveness.** There was once a silence clock
 * here — twelve seconds without a frame declared a run lost — and it was
 * removed rather than tuned. Its premise was per-chunk streaming, which is true
 * of the scribe rung and false of every other: the algorithmic rungs are git
 * work, and the resolver rung reports four discrete beats with minutes of
 * legitimate quiet between them. So the clock measured nothing and declared
 * healthy work dead, in a sentence nobody could act on. Liveness for a run is
 * the **server's** to bound — a per-turn silence bound, a tier-0 timeout, an
 * overall deadline, each landing in the durable stuck fact naming which one
 * fired.
 *
 * What survives is the one liveness fact this client can honestly see: **the
 * wire dropping**, which `connectionDidClose` observes the instant it happens
 * and turns into a stated failure. A state left in `resolving` forever would be
 * a dash with a spinner and no way back, so that arm stays.
 *
 * **The join narrates itself too** ([P03]). `changeset_join_land_delta` frames
 * arrive as the join moves through squash → teardown → release → record, and
 * this store holds the latest beat per dash beside the resolve progress. Same
 * rule applies: a beat is a liveness hint, the feed recompute is the truth, and
 * losing every beat costs the progress line and nothing else.
 *
 * Attached once at boot with {@link attachChangesetJoinStore}; consumed via
 * {@link useChangesetJoinResolve} and {@link useChangesetJoinLand}.
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

/** One beat of a join in flight ([P03], Spec S02). */
export interface LandProgress {
  /** `squash` | `teardown` | `release` | `record`, or `joined` / `failed`. */
  beat: string;
  /** `start` | `done` | `error`. */
  status: string;
  /**
   * The run is over — this is its last word rather than a beat inside it.
   *
   * The terminal frame **settles** the narration instead of erasing it, and
   * that is the difference between a progress line and a progress line nobody
   * can ever see. Frames arrive in batches: on a fast join every beat and the
   * terminal reply land in one, so a store that deleted on terminal would
   * leave the renderer nothing to paint but the state before the press. The
   * join would narrate itself perfectly and silently.
   *
   * Settling also matches the vocabulary the register already borrowed — a
   * `BlockHeader` lifecycle dot pulses through the work and *rests* green or
   * red, it does not vanish at the end.
   */
  terminal?: boolean;
  /**
   * What the terminal beat was about — the landed summary on success, the
   * stated reason on failure. Only ever set alongside `terminal`.
   *
   * A settled beat that reads only `joined` tells the reader the run ended
   * without telling them what it did, which on the sheet's landing phase is
   * the whole content of the last frame they see.
   */
  detail?: string;
}

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
  /**
   * The latest beat of a join in flight, per dash ([P03]).
   *
   * Held as stored objects rather than composed on read, so
   * `useSyncExternalStore` sees a stable snapshot identity between beats.
   */
  private readonly _land = new Map<string, LandProgress>();

  constructor(connection: TugConnection) {
    this._connection = connection;
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
    // A join in flight loses its narrator with the wire; its beats would
    // otherwise rest on whichever one arrived last, forever.
    let landCleared = false;
    for (const [k, progress] of [...this._land]) {
      // A settled join is a result, not a run — it survives the wire the same
      // way the terminal resolve states below it do.
      if (progress.terminal === true) continue;
      this._land.delete(k);
      landCleared = true;
    }
    for (const [k, state] of [...this._states]) {
      if (state.phase !== "resolving") continue;
      this._fail(
        k,
        "The connection dropped — the run continues on the server.",
      );
      landCleared = false;
    }
    if (landCleared) this._emit();
  }

  /** End a run with a reason. */
  private _fail(k: string, reason: string): void {
    const prev = this._states.get(k) ?? IDLE;
    this._set(k, { ...prev, phase: "error", error: reason });
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
      action !== "changeset_join_resolve_base_ok" &&
      action !== "changeset_join_resolve_err" &&
      action !== "changeset_join_question_answer_err" &&
      action !== "changeset_join_land_delta" &&
      action !== "changeset_join_ok" &&
      action !== "changeset_join_err"
    ) {
      return;
    }
    // The server echoes `project_dir` back exactly as it was sent, and every
    // send on this path carries the workspace key — so the reply correlates to
    // the same cell the request opened, with no spelling to reconcile ([L29]).
    const workspaceKey =
      typeof body.project_dir === "string" ? body.project_dir : null;
    const dash = typeof body.dash === "string" ? body.dash : null;
    if (workspaceKey === null || dash === null) return;
    const k = key(workspaceKey, dash);
    const prev = this._states.get(k) ?? IDLE;

    // The join's own narration ([P03]). A hint and nothing more: the feed
    // recompute stays the carrier of truth, so a beat that never arrives costs
    // the progress line and nothing else.
    if (action === "changeset_join_land_delta") {
      const beat = typeof body.beat === "string" ? body.beat : "";
      const status = typeof body.status === "string" ? body.status : "";
      if (beat === "") return;
      this._land.set(k, { beat, status });
      this._emit();
      return;
    }
    // The join is over, one way or the other — and that is the one beat the
    // reader most needs to see, so it settles rather than clearing. See
    // {@link LandProgress.terminal}: erasing here made the whole narration
    // unobservable on any join fast enough to arrive in one frame batch.
    if (action === "changeset_join_ok" || action === "changeset_join_err") {
      const ok = action === "changeset_join_ok";
      // What the ending was about, carried on the same beat that reports it.
      // Success formats its own summary server-side; a preview or a no-op
      // join has none, and falls back to the sha it produced.
      const text = (value: unknown): string | null =>
        typeof value === "string" && value !== "" ? value : null;
      const detail = ok
        ? (text(body.summary) ?? text(body.commit_hash))
        : text(body.detail);
      this._land.set(k, {
        beat: ok ? "joined" : "failed",
        status: ok ? "done" : "error",
        terminal: true,
        ...(detail === null ? {} : { detail }),
      });
      this._emit();
      return;
    }

    // A press that changed nothing has to say so. This is a refusal of a
    // *side* act — the run it belongs to, if there is one, is unharmed — so it
    // lands as a stated reason and leaves the phase where it was.
    if (action === "changeset_join_question_answer_err") {
      const detail = typeof body.detail === "string" ? body.detail : null;
      this._note(k, detail ?? "That answer was not delivered");
      return;
    }
    if (action === "changeset_join_resolve_delta") {
      const path = typeof body.path === "string" ? body.path : "";
      const rung = typeof body.rung === "string" ? body.rung : "";
      const status = typeof body.status === "string" ? body.status : "";
      const text = typeof body.text === "string" ? body.text : "";
      const candidate =
        typeof body.candidate === "string" ? body.candidate : undefined;
      const progress = prev.progress.filter((p) => p.path !== path);
      this._set(k, {
        ...prev,
        phase: "resolving",
        progress: [
          ...progress,
          {
            path,
            rung,
            status,
            text,
            ...(candidate !== undefined ? { candidate } : {}),
          },
        ],
        error: null,
      });
      return;
    }

    if (action === "changeset_join_resolve_base_ok") {
      // Everything it did is already in git, and the blockers are never
      // cached — so the recompute this triggered is the whole of the update,
      // and the overlay's job is to get out of the way.
      this._set(k, IDLE);
      return;
    }

    if (action === "changeset_join_resolve_ok") {
      // A late answer still counts. Nothing here ever cancelled anything — the
      // ladder ran to completion server-side whatever this client believed —
      // so a result that turns up after a dropped wire is true, and takes the
      // face back off the error it was showing.
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
    const detail =
      typeof body.detail === "string" ? body.detail : "resolve failed";
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
    this._emit();
  }

  private _emit(): void {
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
    this._set(k, { phase: "resolving", progress: [], error: null });
    this._connection.sendControlFrame("changeset_join_resolve", {
      project_dir: workspaceKey,
      dash,
    });
  }

  /**
   * Send `changeset_join_resolve_base`: clear the uncommitted base work that
   * is refusing this dash's join.
   *
   * A different act from {@link resolve}, which reconciles a conflicted merge
   * — this clears what is refusing the merge in the first place. They share
   * the resolving phase and the error frame, because the card shows one
   * register and a second vocabulary for "a resolve is running" would be a
   * second thing to keep in step.
   *
   * It clears the block and stops. Landing stays the user's own gesture.
   */
  resolveBase(workspaceKey: string, dash: string): void {
    const k = key(workspaceKey, dash);
    this._set(k, { phase: "resolving", progress: [], error: null });
    this._connection.sendControlFrame("changeset_join_resolve_base", {
      project_dir: workspaceKey,
      dash,
    });
  }

  state(workspaceKey: string, dash: string): ResolveState {
    return this._states.get(key(workspaceKey, dash)) ?? IDLE;
  }

  /** The beat a join in flight last reported, or null when none is ([P03]). */
  landProgress(workspaceKey: string, dash: string): LandProgress | null {
    return this._land.get(key(workspaceKey, dash)) ?? null;
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

  /**
   * Clear a dash's resolve state (cancel / after landing).
   *
   * Deliberately **not** the join's narration: this is called the instant a
   * join reports done, which is exactly when the settled beat is the newest
   * thing the reader has been told. Clearing both from one verb is how the
   * last word of the arc came to be deleted by the arrival of that word.
   * {@link clearLand} is the other half, and its caller is a new press.
   */
  clear(workspaceKey: string, dash: string): void {
    this._set(key(workspaceKey, dash), IDLE);
  }

  /**
   * Open a dash's join narration at the press ([P01], Spec S02).
   *
   * The first beat is written by the client, before the request leaves it, so
   * that no frame between the press and the server's first word can fall
   * through to the standing-candidate arm and rest on "Ready to join" over a
   * running join. It is a placeholder and nothing more: every server frame for
   * the dash overwrites it, and a wire drop deletes it like any other
   * non-terminal beat.
   *
   * This is also what a *new* press does to the last one — seeding the new
   * narration and retiring the previous run's settled word in one write. See
   * {@link clearLand}, which stays the retraction verb for a press that was
   * refused after it was accepted.
   */
  beginLand(workspaceKey: string, dash: string): void {
    this._land.set(key(workspaceKey, dash), {
      beat: "requested",
      status: "start",
    });
    this._emit();
  }

  /**
   * Forget a dash's join narration — what retracts an accepted press.
   *
   * A settled beat rests until something replaces it, so the press that starts
   * the next join is what retires the previous one's last word ({@link
   * beginLand} does that, in the same write that seeds its own). Nothing else
   * should: a settled state that vanished on its own would be a progress line
   * that erases its own result. What remains for this verb is the press that
   * announced itself and was then refused — a register saying "Joining" about
   * a join nobody is running is the same lie in the other direction.
   */
  clearLand(workspaceKey: string, dash: string): void {
    if (this._land.delete(key(workspaceKey, dash))) this._emit();
  }

  dispose(): void {
    this._unsubscribe();
    this._unobserveClose();
    this._land.clear();
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
): ChangesetJoinStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new ChangesetJoinStore(conn);
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
  (_activeStore as unknown as { _onControl(p: Uint8Array): void })._onControl(
    bytes,
  );
}

/**
 * React hook: the live resolve state for one dash plus its triggers. Returns
 * idle + no-op triggers when no store is attached (gallery / fixtures).
 */
export function useChangesetJoinResolve(
  workspaceKey: string,
  dash: string,
): ResolveState & {
  resolve: () => void;
  clear: () => void;
  review: (candidate: string) => void;
} {
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

/**
 * React hook: the beat a join in flight last reported, or null ([L02]).
 *
 * The stored object is returned as-is rather than composed on read, so the
 * snapshot's identity is stable between beats and `useSyncExternalStore` does
 * not re-render on every unrelated frame.
 */
export function useChangesetJoinLand(
  workspaceKey: string,
  dash: string,
): LandProgress | null {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.landProgress(workspaceKey, dash) ?? null,
    () => null,
  );
}
