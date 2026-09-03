/**
 * Changeset arc-join resolve overlay store — the `/btw`-style progress layer
 * over the resolution ladder's CONTROL frames (Spec S12, [P31]/[P32]).
 *
 * When the card asks tugcast to resolve a conflicted join, the ladder streams
 * `changeset_join_resolve_delta` frames (per file / rung, with the AI rung's
 * accumulated text) and finishes with `changeset_join_resolve_ok` or `_err`.
 * This store keys that live state by `(workspace_key, arc)` and exposes it via
 * `useSyncExternalStore` ([L02]); the card renders a mini-transcript overlay
 * while resolving.
 *
 * **It holds the run, never the result.** The candidate the ladder builds, what
 * it decided per file and by which rung, and whether anybody has read that, are
 * written into git and reported on the arc's feed entry — so an `_ok` frame is
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
 * an arc with a spinner and no way back, so that arm stays.
 *
 * **A press, though, is bounded** ([P03]). Every press arms one timer of
 * {@link PRESS_ACKNOWLEDGEMENT_MS}, cleared by the first frame naming the cell
 * or the first feed snapshot whose `join.run` names the act. It measures
 * whether the *press was heard*, not whether the run is alive — the server
 * takes its occupancy hold before any git work, so acknowledgement arrives
 * seconds after the press however long the act itself runs. That is the whole
 * of the difference from the clock above, and the reason this one may exist
 * while that one may not: a resolve that goes quiet for ten minutes is still
 * working and is left alone, while a press nothing ever answered has no other
 * ending than the spinner this surface may never show.
 *
 * **And the ending comes from the feed** ([P02]). {@link
 * ChangesetJoinStore.observeFeed} settles a run from the arc's own entry, so
 * an outcome frame that never arrives costs the detail and not the outcome.
 *
 * **The join narrates itself too** ([P03]). `changeset_join_land_delta` frames
 * arrive as the join moves through squash → teardown → release → record, and
 * this store holds the latest beat per arc beside the resolve progress. Same
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
import type { WorkspacesChangesetSnapshot } from "./changeset-types";
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
 * The live resolve state for one arc — an overlay, and only an overlay.
 *
 * What the ladder *built* is not here. The candidate, the per-file resolutions
 * and their rungs, and whether anybody has read them all live on the arc's
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
  /**
   * Which press opened this run ([P02], Spec S05) — absent when none is open.
   *
   * The two acts share the resolving phase because the card shows one
   * register, but they do not share a terminal condition: a `resolve-base` is
   * over when the base-dirt blocker is gone, a `resolve` when the run the feed
   * was showing is no longer there. {@link ChangesetJoinStore.observeFeed}
   * needs to know which of the two it is watching for, and this is the only
   * place that fact exists.
   */
  act?: "resolve" | "resolve-base";
}

const IDLE: ResolveState = Object.freeze({
  phase: "idle",
  progress: Object.freeze([]) as readonly FileProgress[],
  error: null,
});

/**
 * How long a press may go unacknowledged before it becomes a sentence ([P03]).
 *
 * **It bounds acknowledgement, not the run.** The server takes its occupancy
 * hold before any git work, so `join.run` names the act on the recompute that
 * follows the press — seconds later, whatever the act itself goes on to cost.
 * That is why this is not the silence clock the docblock above says was
 * removed and stays removed: a resolve is allowed to take minutes in silence,
 * and nothing here will call it dead for doing so. What this catches is the
 * press nothing ever heard, whose only other ending is a spinner forever.
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
  /**
   * The cells whose run the feed has actually shown, which the ladder's settle
   * rule needs ([P02]): `join.run` absent on the first snapshot after a press
   * is the server not having recomputed yet, and reading it as "the run ended"
   * would put the overlay away before the run began.
   *
   * **Only the feed writes here.** A CONTROL frame is proof the press was
   * heard, which is a different fact and stands the deadline down on its own;
   * it is *not* proof the server has published the hold. Counting a delta as
   * the seen half would let a recompute that was already in flight when the
   * press went out — one that predates the hold, so `run` is absent on it —
   * read as "seen, then gone" and put the overlay away over a ladder with
   * minutes left to run.
   */
  private readonly _runSeenOnFeed = new Set<string>();

  constructor(connection: TugConnection) {
    this._connection = connection;
    this._unsubscribe = connection.onFrame(FeedId.CONTROL, (payload) =>
      this._onControl(payload),
    );
    // A ladder run is a request whose only answer is a frame. If the wire drops
    // between the request and that frame, the answer is gone for good — the
    // server broadcast it to a socket that was already closed, and the
    // post-reconnect handshake replays feeds, not a CONTROL reply that has
    // already been sent. Without this the arc sits in `resolving` for the life
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

  /**
   * The feed named this cell's act as running: stand the deadline down, and
   * remember that the run was *seen*.
   *
   * Both facts at once, and only from the feed. A CONTROL frame acknowledges
   * the press too — it calls {@link ChangesetJoinStore._clearDeadline}
   * directly — but it says nothing about whether the server has published the
   * hold, which is what the ladder's settle rule reads.
   */
  private _sawRunOnFeed(k: string): void {
    this._clearDeadline(k);
    this._runSeenOnFeed.add(k);
  }

  private _clearDeadline(k: string): void {
    const timer = this._deadlines.get(k);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._deadlines.delete(k);
  }

  /** Arm the acknowledgement deadline for a press just sent. */
  private _armDeadline(k: string, act: "resolve" | "resolve-base"): void {
    this._clearDeadline(k);
    this._deadlines.set(
      k,
      setTimeout(() => {
        this._deadlines.delete(k);
        if ((this._states.get(k) ?? IDLE).phase !== "resolving") return;
        this._fail(
          k,
          act === "resolve-base"
            ? "Resolve got no answer in 60 seconds — the fold may still have run; this row updates when the feed does."
            : "The resolve got no answer in 60 seconds — it may still be running; this row updates when the feed does.",
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
      action !== "changeset_join_resolve_delta" &&
      action !== "changeset_join_resolve_ok" &&
      action !== "changeset_join_resolve_base_ok" &&
      action !== "changeset_join_resolve_base_undo_ok" &&
      action !== "changeset_join_resolve_base_undo_err" &&
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
    const arc = typeof body.arc === "string" ? body.arc : null;
    if (workspaceKey === null || arc === null) return;
    const k = key(workspaceKey, arc);
    const prev = this._states.get(k) ?? IDLE;
    // Any frame naming this cell is proof the press was heard ([P03]) — a
    // delta, an error, or the result itself. What it says is the next
    // paragraphs' business; that it exists is this one's. It stands the
    // deadline down and stops there: whether the *run* has been seen is the
    // feed's word alone ({@link ChangesetJoinStore._runSeenOnFeed}).
    this._clearDeadline(k);

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

    if (action === "changeset_join_resolve_ok") {
      // A late answer still counts. Nothing here ever cancelled anything — the
      // ladder ran to completion server-side whatever this client believed —
      // so a result that turns up after a dropped wire is true, and takes the
      // face back off the error it was showing.
      const unresolved = readStringArray(body.unresolved);
      if (unresolved.length > 0) {
        // The ladder's honest dead end, and the one terminal fact the feed
        // cannot state: the arc's conflicts will still be there, but nothing
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
   * The phase is untouched: a refused answer or a refused override says
   * something about the press, not about the ladder, and a resolve that is
   * still working must keep rendering as work.
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
      this._runSeenOnFeed.delete(k);
      if (next.act !== undefined) {
        next = {
          phase: next.phase,
          progress: next.progress,
          error: next.error,
        };
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
    this._emit();
  }

  private _emit(): void {
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_join_resolve` and mark the arc resolving (fresh state),
   * on a clock.
   *
   * Pressing again while a run is live is **refused by the server**, by name.
   * That used to be free — the ladder built its candidate off to the side and
   * touched no checkout — but a resolve now owns a workshop worktree that a
   * second run would `reset --hard` under the first one's live resolver. One
   * arc admits one run; the refusal arrives as a `changeset_join_resolve_err`
   * naming what holds it.
   */
  resolve(workspaceKey: string, arc: string): void {
    const k = key(workspaceKey, arc);
    this._set(k, {
      phase: "resolving",
      progress: [],
      error: null,
      act: "resolve",
    });
    this._armDeadline(k, "resolve");
    this._connection.sendControlFrame("changeset_join_resolve", {
      project_dir: workspaceKey,
      arc: arc,
    });
  }

  /**
   * Send `changeset_join_resolve_base`: clear the uncommitted base work that
   * is refusing this arc's join.
   *
   * A different act from {@link resolve}, which reconciles a conflicted merge
   * — this clears what is refusing the merge in the first place. They share
   * the resolving phase and the error frame, because the card shows one
   * register and a second vocabulary for "a resolve is running" would be a
   * second thing to keep in step.
   *
   * It clears the block and stops. Landing stays the user's own gesture.
   */
  resolveBase(workspaceKey: string, arc: string): void {
    const k = key(workspaceKey, arc);
    this._set(k, {
      phase: "resolving",
      progress: [],
      error: null,
      act: "resolve-base",
    });
    this._armDeadline(k, "resolve-base");
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
   * Each act has its own ending, which is why the cell records which one it is.
   * A `resolve-base` is over when no `base-dirt` blocker remains and no fold
   * still holds the arc — the blocker's absence *is* the outcome. A `resolve`
   * has no such fact to read, so it ends when the run the feed was showing is
   * no longer showing: seen, then gone. The seen half is not optional, because
   * the snapshot in hand at the moment of a press predates the server's hold,
   * and `run` absent on it means "not yet" rather than "finished".
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
          this._sawRunOnFeed(k);
          continue;
        }

        // A run the server declares stuck has said why, durably, on the entry
        // the face renders. The overlay has nothing to add and every reason to
        // get out of the way of a sentence better than any it could invent.
        if (typeof join?.stuck === "string" && join.stuck !== "") {
          this._set(k, IDLE);
          continue;
        }

        if (act === "resolve-base") {
          const blocked = (join?.blockers ?? []).some(
            (blocker) => blocker.kind === "base-dirt",
          );
          if (!blocked) this._set(k, IDLE);
          continue;
        }

        if (this._runSeenOnFeed.has(k)) this._set(k, IDLE);
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
   * Record that the user has read what the ladder decided — the second beat of
   * the review the land gate holds for.
   *
   * The acknowledgment is pinned to `candidate`'s sha server-side, so it cannot
   * outlive the artifact it answered: a candidate rebuilt after the base moved
   * demands a fresh reading. The mark comes back on the arc's feed entry; this
   * send only asks for it.
   */
  review(workspaceKey: string, arc: string, candidate: string): void {
    this._connection.sendControlFrame("changeset_join_review", {
      project_dir: workspaceKey,
      arc: arc,
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
    arc: string,
    requestId: string,
    answer: string,
  ): void {
    this._connection.sendControlFrame("changeset_join_question_answer", {
      project_dir: workspaceKey,
      arc: arc,
      request_id: requestId,
      answer,
    });
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
   * through to the standing-candidate arm and rest on "Ready to join" over a
   * running join. It is a placeholder and nothing more: every server frame for
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
    this._emit();
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
    if (this._land.delete(key(workspaceKey, arc))) this._emit();
  }

  dispose(): void {
    this._unsubscribe();
    this._unobserveClose();
    for (const timer of this._deadlines.values()) clearTimeout(timer);
    this._deadlines.clear();
    this._runSeenOnFeed.clear();
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
 * React hook: the live resolve state for one arc plus its triggers. Returns
 * idle + no-op triggers when no store is attached (gallery / fixtures).
 */
export function useChangesetJoinResolve(
  workspaceKey: string,
  arc: string,
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
    () => _activeStore?.state(workspaceKey, arc) ?? IDLE,
    () => IDLE,
  );
  const resolve = (): void => {
    _activeStore?.resolve(workspaceKey, arc);
  };
  const clear = (): void => {
    _activeStore?.clear(workspaceKey, arc);
  };
  const review = (candidate: string): void => {
    _activeStore?.review(workspaceKey, arc, candidate);
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
