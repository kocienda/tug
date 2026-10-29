/**
 * Changeset arc-join overlay store — the live layer over the join's own
 * CONTROL frames: the base fold that clears a join's base-dirt blocker, its
 * undo, and the join's narration.
 *
 * A ready arc's join is a squash and a land: its audit verified the fit of
 * exactly the tree the join lands, so there is nothing to resolve at the join
 * and no resolve run for this store to follow. What it keys by
 * `(workspace_key, arc)` and exposes via `useSyncExternalStore` ([L02]) is a
 * fold in flight and the join's latest beat.
 *
 * **It holds the run, never the result.** What a fold committed is in git and
 * comes back on the arc's feed entry, so this state can be lost to a dropped
 * socket, a reload or a relaunch without costing anything. The one liveness
 * fact this client can honestly see is **the wire dropping**, which
 * `connectionDidClose` observes the instant it happens and turns into a stated
 * failure, so a fold is never left showing a spinner with no way back.
 *
 * **A press, though, is bounded** ([P03]). Every press arms one timer of
 * {@link PRESS_ACKNOWLEDGEMENT_MS}, cleared by the first frame naming the cell
 * or the first feed snapshot whose `join.run` names the act. It measures
 * whether the *press was heard*, not whether the run is alive — the server
 * takes its occupancy hold before any git work, so acknowledgement arrives
 * seconds after the press however long the act itself runs. A press nothing
 * ever answered has no other ending than the spinner this surface may never
 * show.
 *
 * **And the ending comes from the feed** ([P02]). {@link
 * ChangesetJoinStore.observeFeed} settles a run from the arc's own entry, so
 * an outcome frame that never arrives costs the detail and not the outcome.
 *
 * **The join narrates itself too** ([P03]). `changeset_join_land_delta` frames
 * arrive as the join moves through squash → teardown → release → record, and
 * this store holds the latest beat per arc beside the fold's progress. Same
 * rule applies: a beat is a liveness hint, the feed recompute is the truth, and
 * losing every beat costs the progress line and nothing else.
 *
 * Attached once at boot with {@link attachChangesetJoinStore}; consumed via
 * {@link useChangesetJoinResolve} (the base fold's overlay) and
 * {@link useChangesetJoinLand}.
 *
 * @module lib/changeset-join-store
 */

import { Subscribable } from "@/lib/subscribable";
import { useSyncExternalStore } from "@/lib/gesture-scope";


import type { TugConnection } from "../connection";
import type { WorkspacesChangesetSnapshot } from "./changeset-types";
import { FeedId } from "../protocol";
import { getConnectionLifecycle } from "./connection-lifecycle";

export type ResolvePhase = "idle" | "resolving" | "error";

/**
 * The live fold state for one arc — an overlay, and only an overlay: a fold
 * is in flight, and — when one stopped — why.
 */
export interface ResolveState {
  phase: ResolvePhase;
  /**
   * Why the last thing the user asked for did not happen.
   *
   * Set with `phase === "error"` when a fold itself failed, and *without*
   * touching the phase when a side press was refused — an undo, or a second
   * press on an arc a run already holds. Those refusals arrive while a run may
   * still be perfectly healthy, so routing them through the phase would paint
   * live work as a failure. What they may never do is vanish ([L31]).
   */
  error: string | null;
  /**
   * Which press opened this run ([P02], Spec S05) — absent when none is open.
   * A `resolve-base` is over when the base-dirt blocker is gone.
   */
  act?: "resolve-base";
}

const IDLE: ResolveState = Object.freeze({
  phase: "idle",
  error: null,
});

/**
 * How long a press may go unacknowledged before it becomes a sentence ([P03]).
 *
 * **It bounds acknowledgement, not the run.** The server takes its occupancy
 * hold before any git work, so `join.run` names the act on the recompute that
 * follows the press — seconds later, whatever the act itself goes on to cost.
 * That is why this is not the silence clock the docblock above says was
 * removed and stays removed: a fold may take its time, and nothing here will
 * call it dead for doing so. What this catches is the press nothing ever
 * heard, whose only other ending is a spinner forever.
 */
export const PRESS_ACKNOWLEDGEMENT_MS = 60_000;

let _pressAcknowledgementMs: number = PRESS_ACKNOWLEDGEMENT_MS;

/** Shorten the deadline so a test can reach it (the `settle(ms)` idiom). */
export function _setPressAcknowledgementMsForTest(ms: number): void {
  _pressAcknowledgementMs = ms;
}

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

function key(workspaceKey: string, arc: string): string {
  return `${workspaceKey}|${arc}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ChangesetJoinStore extends Subscribable {
  private readonly _connection: TugConnection;
  private readonly _unsubscribe: () => void;
  private readonly _unobserveClose: () => void;
  private _states = new Map<string, ResolveState>();
  private readonly _decoder = new TextDecoder();
  /**
   * The latest beat of a join in flight, per arc ([P03]).
   *
   * Held as stored objects rather than composed on read, so
   * `useSyncExternalStore` sees a stable snapshot identity between beats.
   */
  private readonly _land = new Map<string, LandProgress>();
  /**
   * The last `Set` {@link ChangesetJoinStore.landingArcs} answered per
   * workspace, held so an unchanged answer keeps its identity — which is what
   * a `useSyncExternalStore` reader needs of a derived snapshot.
   */
  private readonly _landingArcs = new Map<string, ReadonlySet<string>>();
  /**
   * The unacknowledged-press timer per cell ([P03]), armed at the press and
   * cleared by the first thing that proves somebody heard it.
   */
  private readonly _deadlines = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(connection: TugConnection) {
    super();
    this._connection = connection;
    this._unsubscribe = connection.onFrame(FeedId.CONTROL, (payload) =>
      this._onControl(payload),
    );
    // A fold is a request whose only answer is a frame. If the wire drops
    // between the request and that frame, the answer is gone for good — the
    // server broadcast it to a socket that was already closed, and the
    // post-reconnect handshake replays feeds, not a CONTROL reply that has
    // already been sent. Without this the arc sits in `resolving` for the life
    // of the page: no progress, no error, no way back.
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
    if (landCleared) this.notify();
  }

  /** End a run with a reason. */
  private _fail(k: string, reason: string): void {
    const prev = this._states.get(k) ?? IDLE;
    this._set(k, { ...prev, phase: "error", error: reason });
  }

  private _clearDeadline(k: string): void {
    const timer = this._deadlines.get(k);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._deadlines.delete(k);
  }

  /** Arm the acknowledgement deadline for a press just sent. */
  private _armDeadline(k: string): void {
    this._clearDeadline(k);
    this._deadlines.set(
      k,
      setTimeout(() => {
        this._deadlines.delete(k);
        if ((this._states.get(k) ?? IDLE).phase !== "resolving") return;
        this._fail(
          k,
          "Resolve got no answer in 60 seconds — the fold may still have run; this row updates when the feed does.",
        );
      }, _pressAcknowledgementMs),
    );
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
      action !== "changeset_join_resolve_base_ok" &&
      action !== "changeset_join_resolve_base_undo_ok" &&
      action !== "changeset_join_resolve_base_undo_err" &&
      action !== "changeset_join_resolve_err" &&
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
    const arc = typeof body.arc === "string" ? body.arc : null;
    if (workspaceKey === null || arc === null) return;
    const k = key(workspaceKey, arc);
    // Any frame naming this cell is proof the press was heard ([P03]) — a
    // beat, an error, or the result itself. What it says is the next
    // paragraphs' business; that it exists is this one's.
    this._clearDeadline(k);

    // The join's own narration ([P03]). A hint and nothing more: the feed
    // recompute stays the carrier of truth, so a beat that never arrives costs
    // the progress line and nothing else.
    if (action === "changeset_join_land_delta") {
      const beat = typeof body.beat === "string" ? body.beat : "";
      const status = typeof body.status === "string" ? body.status : "";
      if (beat === "") return;
      this._land.set(k, { beat, status });
      this.notify();
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
      this.notify();
      return;
    }

    if (action === "changeset_join_resolve_base_ok") {
      // Everything it did is already in git, and the blockers are never
      // cached — so the recompute this triggered is the whole of the update,
      // and the overlay's job is to get out of the way.
      this._set(k, IDLE);
      return;
    }

    // The undo's two endings. Neither touches the phase: an undo is a press
    // beside a receipt, not a run, and whatever the cell is doing — usually
    // nothing — is unharmed either way. The receipt it retires is read off
    // the arc's entry, so the recompute the server bumped is what takes it
    // down; there is nothing here for the overlay to clear.
    if (action === "changeset_join_resolve_base_undo_ok") {
      this._note(k, null);
      return;
    }
    if (action === "changeset_join_resolve_base_undo_err") {
      const detail =
        typeof body.detail === "string" ? body.detail : "undo failed";
      this._note(k, detail);
      return;
    }

    // changeset_join_resolve_err — the fold's own refusal, which is a better
    // answer than any this store could invent, late or not.
    const detail =
      typeof body.detail === "string" ? body.detail : "resolve failed";
    // Unless nothing was refused *but the press*. An admission refusal means a
    // run already holds this arc — so it arrives on the cell that run is
    // streaming into, and failing the cell would report the healthy run as dead
    // on the strength of somebody having asked for a second one.
    if (body.admission === true) {
      this._note(k, detail);
      return;
    }
    this._fail(k, detail);
  }

  /**
   * State a reason on an arc without claiming its run failed (`null` clears).
   *
   * The phase is untouched: a refused press says something about the press,
   * not about the run, and a fold that is still working must keep rendering
   * as work.
   */
  private _note(k: string, reason: string | null): void {
    const prev = this._states.get(k) ?? IDLE;
    this._set(k, { ...prev, error: reason });
  }

  private _set(k: string, state: ResolveState): void {
    let next = state;
    // Leaving `resolving` ends the run, whichever way it ended: the deadline
    // has nothing left to catch and the acknowledgement belonged to the run
    // rather than to the cell. Doing it here rather than at each of the six
    // exits is what keeps a settle nobody thought of from leaving a timer
    // running under an idle row.
    //
    // The act goes with it, for the same reason and with more force. `act`
    // says *which* act is in flight, and the register and the report face
    // both read it beside the phase rather than under it — so left standing
    // on a cell that failed, it painted `Committing base work` over a stated
    // error: the two-voices defect this round exists to remove, arriving
    // through the other door.
    if (next.phase !== "resolving") {
      this._clearDeadline(k);
      if (next.act !== undefined) {
        next = { phase: next.phase, error: next.error };
      }
    }
    // Idle is the absence of a run, but a stated reason is not absence: a
    // refusal recorded on an arc with nothing running is exactly the case
    // where dropping the cell would swallow the sentence.
    if (next.phase === "idle" && next.error === null) {
      this._states.delete(k);
    } else {
      this._states.set(k, next);
    }
    this.notify();
  }

  /**
   * Send `changeset_join_resolve_base`: clear the uncommitted base work that
   * is refusing this arc's join.
   *
   * It clears the block and stops. Landing stays the user's own gesture.
   */
  resolveBase(workspaceKey: string, arc: string): void {
    const k = key(workspaceKey, arc);
    this._set(k, {
      phase: "resolving",
      error: null,
      act: "resolve-base",
    });
    this._armDeadline(k);
    this._connection.sendControlFrame("changeset_join_resolve_base", {
      project_dir: workspaceKey,
      arc: arc,
    });
  }

  /**
   * Send `changeset_join_resolve_base_undo`: put back the uncommitted base
   * work a fold committed.
   *
   * **It does not touch the phase, and arms no deadline.** A fold is a run —
   * it streams, it has a face, and the overlay is how the card says it is
   * working. An undo is a press beside a durable receipt: what it reverses is
   * in git, what retires the receipt is the recompute, and there is no run
   * here for a face to show. So the only thing it can say back is a refusal,
   * which lands as a stated reason on a cell that carries on as it was.
   */
  undoResolveBase(workspaceKey: string, arc: string): void {
    this._connection.sendControlFrame("changeset_join_resolve_base_undo", {
      project_dir: workspaceKey,
      arc: arc,
    });
  }

  /**
   * Read the aggregate feed and settle any run it says is over ([P02]).
   *
   * **The feed is the terminal fact; a frame only hurries it.** Everything
   * either act does lands in git and comes back on the arc's entry, and the
   * blockers are never cached server-side — so the recompute that follows the
   * work is the whole truth, and the reply frame's only job is to deliver
   * detail sooner. That ordering is what makes a dropped frame cost nothing:
   * the overlay comes down on the next recompute either way, which is the rule
   * `changeset_join_land_delta` already follows.
   *
   * A `resolve-base` is over when no `base-dirt` blocker remains and no fold
   * still holds the arc — the blocker's absence *is* the outcome.
   *
   * Wired from `main.tsx` on every `ChangesetAllStore` notification and once at
   * attach, mirroring that store's own initial drain.
   */
  observeFeed(snapshot: WorkspacesChangesetSnapshot): void {
    if (this._states.size === 0) return;
    for (const project of snapshot.projects) {
      for (const entry of project.changesets) {
        if (entry.kind !== "arc") continue;
        const k = key(project.workspace_key, entry.display_name);
        const state = this._states.get(k);
        if (state === undefined || state.phase !== "resolving") continue;
        const act = state.act;
        if (act === undefined) continue;

        const join = entry.join;
        if (join?.run === act) {
          this._clearDeadline(k);
          continue;
        }

        const blocked = (join?.blockers ?? []).some(
          (blocker) => blocker.kind === "base-dirt",
        );
        if (!blocked) this._set(k, IDLE);
      }
    }
  }

  state(workspaceKey: string, arc: string): ResolveState {
    return this._states.get(key(workspaceKey, arc)) ?? IDLE;
  }

  /** The beat a join in flight last reported, or null when none is ([P03]). */
  landProgress(workspaceKey: string, arc: string): LandProgress | null {
    return this._land.get(key(workspaceKey, arc)) ?? null;
  }

  /**
   * The arcs in `workspaceKey` whose join is **running** — a beat has been
   * written and none of them was terminal.
   *
   * The Changes room reads this to stop offering an arc it is already joining.
   * Answered as a `Set` of display names, and rebuilt only when the contents
   * change, so a `useSyncExternalStore` reader does not re-render on every
   * unrelated frame the store forwards.
   */
  landingArcs(workspaceKey: string): ReadonlySet<string> {
    const prefix = `${workspaceKey}|`;
    const next = new Set<string>();
    for (const [k, progress] of this._land) {
      if (!k.startsWith(prefix) || progress.terminal === true) continue;
      next.add(k.slice(prefix.length));
    }
    const held = this._landingArcs.get(workspaceKey);
    if (held !== undefined && held.size === next.size) {
      let same = true;
      for (const arc of next) {
        if (!held.has(arc)) {
          same = false;
          break;
        }
      }
      if (same) return held;
    }
    this._landingArcs.set(workspaceKey, next);
    return next;
  }

  /**
   * Clear an arc's resolve state (cancel / after landing).
   *
   * Deliberately **not** the join's narration: this is called the instant a
   * join reports done, which is exactly when the settled beat is the newest
   * thing the reader has been told. Clearing both from one verb is how the
   * last word of the arc came to be deleted by the arrival of that word.
   * {@link clearLand} is the other half, and its caller is a new press.
   */
  clear(workspaceKey: string, arc: string): void {
    this._set(key(workspaceKey, arc), IDLE);
  }

  /**
   * Open an arc's join narration at the press ([P01], Spec S02).
   *
   * The first beat is written by the client, before the request leaves it, so
   * that no frame between the press and the server's first word can fall
   * through to the offer arm and rest on "Ready to join" over a running join. It is a placeholder and nothing more: every server frame for
   * the arc overwrites it, and a wire drop deletes it like any other
   * non-terminal beat.
   *
   * This is also what a *new* press does to the last one — seeding the new
   * narration and retiring the previous run's settled word in one write. See
   * {@link clearLand}, which stays the retraction verb for a press that was
   * refused after it was accepted.
   */
  beginLand(workspaceKey: string, arc: string): void {
    this._land.set(key(workspaceKey, arc), {
      beat: "requested",
      status: "start",
    });
    this.notify();
  }

  /**
   * Forget an arc's join narration — what retracts an accepted press.
   *
   * A settled beat rests until something replaces it, so the press that starts
   * the next join is what retires the previous one's last word ({@link
   * beginLand} does that, in the same write that seeds its own). Nothing else
   * should: a settled state that vanished on its own would be a progress line
   * that erases its own result. What remains for this verb is the press that
   * announced itself and was then refused — a register saying "Joining" about
   * a join nobody is running is the same lie in the other direction.
   */
  clearLand(workspaceKey: string, arc: string): void {
    if (this._land.delete(key(workspaceKey, arc))) this.notify();
  }

  dispose(): void {
    this._unsubscribe();
    this._unobserveClose();
    for (const timer of this._deadlines.values()) clearTimeout(timer);
    this._deadlines.clear();
    this._land.clear();
    this.clearListeners();
  }
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
 * React hook: the live fold state for one arc plus its clear. Returns idle and
 * a no-op when no store is attached (gallery / fixtures).
 */
export function useChangesetJoinResolve(
  workspaceKey: string,
  arc: string,
): ResolveState & {
  clear: () => void;
} {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.state(workspaceKey, arc) ?? IDLE,
    () => IDLE,
  );
  const clear = (): void => {
    _activeStore?.clear(workspaceKey, arc);
  };
  return { ...state, clear };
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
  arc: string,
): LandProgress | null {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.landProgress(workspaceKey, arc) ?? null,
    () => null,
  );
}

/** No store attached, or nothing joining — one frozen empty set for both. */
const NO_LANDING_ARCS: ReadonlySet<string> = new Set<string>();

/**
 * React hook: which arcs in this workspace have a join running ([L02]).
 *
 * The Changes room stops offering an arc the moment its join is pressed — the
 * acts the room held for it are spent, and an arc still on offer while it is
 * being joined invites the second press that can only be refused. It comes
 * back if the join fails, because a failure is the one outcome that still
 * wants somebody.
 */
export function useChangesetLandingArcs(workspaceKey: string): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.landingArcs(workspaceKey) ?? NO_LANDING_ARCS,
    () => NO_LANDING_ARCS,
  );
}
