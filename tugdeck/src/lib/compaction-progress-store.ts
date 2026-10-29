/**
 * `compactionProgressStore` — drives the `/compact` progress sheet.
 *
 * Native `/compact` dispatches as a stream-json user message and compacts in
 * place (same session, same JSONL). It is an opaque run — minutes on a full
 * context — with no streamed volume to meter, so the sheet is pane-modal and
 * **indeterminate**: the run is either in flight or settled. This singleton is
 * the seam between the session-card handler that opens the run (`begin`) and
 * drives it off `codeSessionStore` snapshots (`succeed` / `cancel` / `fail`),
 * and the sheet that renders off the same store. The card watches the terminal
 * `outcome` to raise the closing bulletin and `clear`.
 *
 * Every mutator is keyed by `cardId`, and the snapshot is a map of the runs
 * currently open. Each card owns its own `codeSessionStore`, so any number of
 * cards can be compacting at once; a per-card key is what keeps a second
 * `/compact` from overwriting the first's run, and keeps one card's `clear`
 * from dropping another card's sheet.
 *
 * The run's lifetime is this store's, NOT the sheet's: the card's watcher is
 * subscribed here, so a sheet dismissed early (Escape, a host unmount) leaves
 * the compaction running and still settling into the transcript.
 *
 * The card's modal HOLD is taken here too, for the same reason and on the same
 * span ([B01]): the cover sheet used to take it, which made the card's
 * modality a property of the panel rather than of the run, so a folded run —
 * which has no panel — refused nothing. `begin` takes the hold and `clear`
 * releases it, and the hold names the one door it admits, the fold.
 *
 * The run's own CANCEL is kept here too, beside the run it belongs to, because
 * the sheet is not the only surface that offers one: a folded card shows the
 * run in its Z2 row — no cover rises — and offers Cancel there. Both presses
 * perform the one closure the run registered, so there is one interrupt, one
 * latch, and one set of bulletins however the user reached it.
 *
 * And the run's REFUSAL is routed from here for the same reason ([B08]): the
 * run has two faces, the cover panel and the folded Z2 row, and the hold that
 * refuses every other door on the card cannot know which of them is up. Each
 * face registers its own flash while it is mounted and {@link
 * CompactionProgressStore.refuse} speaks through whichever answers.
 *
 * No entry for a card = idle (no compaction, no sheet). An entry with
 * `outcome === null` is a run in flight; an entry with a terminal `outcome` is
 * a just-settled run awaiting that card's bulletin + `clear`.
 *
 * Both manual `/compact` and native auto-compaction stream a `compact_boundary`,
 * but only a manual `/compact` opens this run — the progress sheet and closing
 * bulletin are scoped to the explicit command.
 *
 * Module-level singleton, matching the other per-session helper stores
 * ([L02] external state reaches React through `useSyncExternalStore`).
 */

import { Subscribable } from "./subscribable";
import type { CodeSessionSnapshot, TurnEntry } from "./code-session-store";
import { isCompactionSubmission } from "./code-session-store/compaction";
import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import {
  type CardModalHold,
  cardModalHoldStore,
} from "./card-modal-hold-store";

/** How a compaction run settled. */
export type CompactionOutcome = "succeeded" | "canceled" | "failed";

export interface CompactionProgress {
  /**
   * The compact turn this run was opened for — the key the run's whole
   * outcome is asked of ([B02]). The wheel's run reads it off the turn it
   * found open; the typed run takes the one its own submission opened.
   */
  readonly turnKey: string;
  /**
   * The `msgId` of the last turn the transcript had committed when the run
   * began, or `null` over an empty transcript. A turn a replay rebuilds is
   * minted a fresh key, and a wheel-sent turn's opener carries tugcast's id
   * rather than the deck's, so a catch-up can hand the run its turn back with
   * neither key on it; what it keeps is its place, the first `/compact` turn
   * after this one.
   */
  readonly afterMsgId: string | null;
  /** Terminal outcome, or `null` while the run is still in flight. */
  readonly outcome: CompactionOutcome | null;
  /** Human-readable reason when `outcome === "failed"`, else `null`. */
  readonly failureReason: string | null;
}

/** Every open run, keyed by the card that started it. */
export type CompactionRuns = ReadonlyMap<string, CompactionProgress>;

/** The turn a run is opened over: its key, and the turn committed before it. */
export type CompactionTurn = Pick<CompactionProgress, "turnKey" | "afterMsgId">;

const NO_RUNS: CompactionRuns = new Map();

/**
 * What every beat surface says for the length of a `/compact` run — the
 * card's `session-masthead` and the Cards card **Sessions** row read the same
 * string, so a compacting session says one thing wherever it is shown.
 */
export const COMPACTING_BEAT_TEXT = "Compacting context…";

/** Whether `runs` holds a still-in-flight run for `cardId`. */
export function isCompactingCard(
  runs: CompactionRuns,
  cardId: string | undefined,
): boolean {
  if (cardId === undefined) return false;
  const run = runs.get(cardId);
  return run !== undefined && run.outcome === null;
}

/** What the transcript says a run's compact turn came to. */
export interface CompactionVerdict {
  readonly outcome: CompactionOutcome;
  /** The closing bulletin's reason when `outcome === "failed"`, else `null`. */
  readonly failureReason: string | null;
}

/** The failure reason when the turn ended with no compaction and no error said why. */
export const COMPACTION_DID_NOT_RUN = "Compaction didn't run — session left intact";

/** The parts of a session snapshot a run's outcome is read from. */
export type CompactionOutcomeSnapshot = Pick<
  CodeSessionSnapshot,
  "phase" | "catchingUp" | "activeTurn" | "queuedSends" | "transcript" | "lastError"
>;

/**
 * Whether a turn's messages say it was opened by the submission `turnKey`.
 *
 * A turn the card streamed commits under the key it was sent with, but a turn
 * a replay rebuilt — a catch-up after the body slept, an evicted body brought
 * back — is minted a fresh key, and what it keeps of the submission is its
 * opener's `submissionId`, which tugcode handed claude as the input's `uuid`
 * and claude wrote back as the record's. Either one names the run's turn.
 */
function openedBy(
  turn: { readonly turnKey: string; readonly messages: TurnEntry["messages"] },
  turnKey: string,
): boolean {
  if (turn.turnKey === turnKey) return true;
  return turn.messages.some(
    (m) => m.kind === "user_message" && m.submissionId === turnKey,
  );
}

/** Whether a turn, open or committed, was opened by a `/compact` submission. */
function isCompactTurn(turn: { readonly messages: TurnEntry["messages"] }): boolean {
  const opener = turn.messages.find((m) => m.kind === "user_message");
  return (
    opener !== undefined &&
    opener.kind === "user_message" &&
    isCompactionSubmission(opener.text, opener.attachments)
  );
}

/**
 * The run's turn, committed — found by either of its keys, or failing that by
 * its place: the first `/compact` turn after the one the run began behind.
 * `undefined` when the transcript holds neither.
 */
function committedTurnOf(
  run: CompactionTurn,
  transcript: CompactionOutcomeSnapshot["transcript"],
): TurnEntry | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (openedBy(transcript[i], run.turnKey)) return transcript[i];
  }
  let from = 0;
  if (run.afterMsgId !== null) {
    const before = transcript.findIndex((t) => t.msgId === run.afterMsgId);
    if (before < 0) return undefined;
    from = before + 1;
  }
  for (let i = from; i < transcript.length; i++) {
    if (isCompactTurn(transcript[i])) return transcript[i];
  }
  return undefined;
}

/**
 * What a `/compact` run's turn came to, read off the snapshot as it is now
 * ([B01], [B04]) — `null` while the answer is not yet in the snapshot.
 *
 * A derivation rather than an edge a listener has to witness: a card that
 * slept through the turn's end, or one batch that carried the turn's commit
 * and the next turn's opener together, shows a listener only the last state,
 * and the last state is enough. So the run settles the first time anyone
 * looks, however late.
 *
 * - `null` while a replay bracket is open or a catch-up is outstanding (the
 *   turn is in neither slot mid-bracket, which is not an answer), while the
 *   run's submission is still queued, and while its turn is the active one.
 * - `succeeded` when its committed entry carries the compaction mark — even
 *   one that ended interrupted, since the compaction is then real anyway.
 * - `canceled` when it ended interrupted with no compaction.
 * - `failed` when it ended any other way with no compaction, or when it is
 *   nowhere at all, with the session's last error as the reason when it has
 *   one.
 *
 * Pure: it reads the run's key and the snapshot, and nothing a closure kept.
 */
export function compactionOutcome(
  run: CompactionTurn,
  snapshot: CompactionOutcomeSnapshot,
): CompactionVerdict | null {
  if (snapshot.phase === "replaying" || snapshot.catchingUp) return null;
  const key = run.turnKey;
  if (snapshot.queuedSends.some((q) => q.turnKey === key)) return null;
  const active = snapshot.activeTurn;
  if (active !== null && openedBy(active, key)) return null;
  const entry = committedTurnOf(run, snapshot.transcript);
  // Not committed by any name, and a turn is open: when it is a `/compact`
  // it is this run's, rebuilt by a replay under a fresh key — still running.
  if (entry === undefined && active !== null && isCompactTurn(active)) return null;
  if (entry?.compacted === true) return { outcome: "succeeded", failureReason: null };
  if (entry?.turnEndReason === "interrupted") return { outcome: "canceled", failureReason: null };
  return {
    outcome: "failed",
    failureReason: snapshot.lastError?.message ?? COMPACTION_DID_NOT_RUN,
  };
}

class CompactionProgressStore extends Subscribable {
  private state: CompactionRuns = NO_RUNS;
  /**
   * Each open run's own cancel, keyed by card — the closure
   * `session-compaction-run` builds when it opens the run, which interrupts
   * the turn and settles the store. Deliberately NOT in the snapshot: a
   * function in there would change the map's identity for nothing and is not
   * state any surface renders. It lives here so a surface that is not the
   * sheet can take the same cancel rather than reconstructing it — the folded
   * card's Z2 row is the first such surface, and a second implementation of
   * "cancel" would be a second set of bulletins to keep in step.
   */
  private readonly cancels = new Map<string, () => void>();
  /**
   * Each open run's release for the modal hold it took on its card. The hold is
   * the RUN's, not its cover sheet's ([B01]): a `/compact` refuses every other
   * door for as long as it is in flight, and the run is the only thing that
   * knows that span — the cover comes and goes with the fold, and a card whose
   * cover is down is still a card with a run on it. Deliberately not in the
   * snapshot, for the same reason {@link cancels} is not: a release is not
   * state any surface renders.
   */
  private readonly holdReleases = new Map<string, () => void>();
  /**
   * Each mounted FACE of a run, and how it flashes the run's refusal — the
   * answer to "where does the hold's `refuse` go when the run has two faces"
   * ([B08]). It goes here, on the store that already holds per-card run state,
   * because the hold does not know which face is up and should not have to:
   * the sheet mounts and unmounts with the fold, the Z2 row mounts and unmounts
   * against it, and the run outlives both.
   *
   * A SET rather than one slot, because there is an instant during the fold
   * where both faces exist — the cover standing down while the row arrives. A
   * refusal in that window flashes whichever of them the user can actually see,
   * and a face that is already gone was unregistered by its own teardown.
   *
   * Deliberately not in the snapshot, for the same reason {@link cancels} is
   * not: these are callbacks a mounted surface files, not state anything
   * renders, and each face writes its own flash through a DOM attribute ([L06])
   * rather than through React.
   */
  private readonly refusalNudges = new Map<string, Set<() => void>>();

  /** Stable between notifications — safe for `useSyncExternalStore`. */
  getSnapshot = (): CompactionRuns => this.state;

  /**
   * This card's run, or `null` when it has none. Stable between notifications
   * (entries are replaced, never mutated), so it is safe to read directly as a
   * `useSyncExternalStore` snapshot.
   */
  getFor = (cardId: string): CompactionProgress | null =>
    this.state.get(cardId) ?? null;

  /** Open an in-flight run for `cardId`, over the compact turn `turn`. */
  begin(
    cardId: string,
    turn: CompactionTurn,
    onCancel?: () => void,
    hold?: CardModalHold,
  ): void {
    if (onCancel !== undefined) this.cancels.set(cardId, onCancel);
    // Held for the run's life rather than the cover's, which is what makes the
    // fold a question the holder answers rather than a hole in the sheet's
    // guard: fold the card and the cover stands down, and the card is still
    // held — a `/usage` or a ⌘W still meets the run's own voice.
    if (hold !== undefined) {
      this.releaseHold(cardId);
      this.holdReleases.set(cardId, cardModalHoldStore.hold(cardId, hold));
    }
    this.write(cardId, {
      turnKey: turn.turnKey,
      afterMsgId: turn.afterMsgId,
      outcome: null,
      failureReason: null,
    });
  }

  /**
   * Perform this card's run's own cancel, if it has one and is still in
   * flight. Returns whether anything was asked to stop — a settled run, or a
   * run opened without a cancel, answers `false` and nothing happens.
   */
  requestCancel(cardId: string): boolean {
    if (!isCompactingCard(this.state, cardId)) return false;
    const cancel = this.cancels.get(cardId);
    if (cancel === undefined) return false;
    cancel();
    return true;
  }

  /**
   * Register a mounted face's refusal flash, returning its unregister. Called
   * by the cover sheet and by the folded card's Z2 row, each for as long as it
   * is mounted.
   */
  registerRefusalNudge(cardId: string, nudge: () => void): () => void {
    let faces = this.refusalNudges.get(cardId);
    if (faces === undefined) {
      faces = new Set();
      this.refusalNudges.set(cardId, faces);
    }
    faces.add(nudge);
    return () => {
      faces.delete(nudge);
      if (faces.size === 0) this.refusalNudges.delete(cardId);
    };
  }

  /**
   * Speak this card's run's refusal on whichever of its faces are mounted —
   * the callback the run files on its modal hold, so every refused door on the
   * card reaches the surface the user is actually looking at ([L31], [B08]).
   *
   * Silent when no face is mounted, which is the honest answer: a run whose
   * card is in another pane's stack, or mid-crossing between its two faces for
   * a frame, has nowhere to flash and nothing to say.
   */
  refuse(cardId: string): void {
    const faces = this.refusalNudges.get(cardId);
    if (faces === undefined) return;
    for (const nudge of faces) nudge();
  }

  /** Mark the card's run succeeded (compaction ink observed in place). */
  succeed(cardId: string): void {
    this.settle(cardId, "succeeded", null);
  }

  /** Mark the card's run canceled (user interrupted the compaction). */
  cancel(cardId: string): void {
    this.settle(cardId, "canceled", null);
  }

  /** Mark the card's run failed, carrying a reason for the closing bulletin. */
  fail(cardId: string, reason: string): void {
    this.settle(cardId, "failed", reason);
  }

  /**
   * Settle this card's run with what the transcript says its turn came to
   * ({@link compactionOutcome}). Only the run over `turnKey`, and only while it
   * is in flight: a verdict read for a run already settled, or for a run since
   * replaced by another on the same card, changes nothing.
   */
  settleFrom(cardId: string, turnKey: string, verdict: CompactionVerdict): void {
    if (this.state.get(cardId)?.turnKey !== turnKey) return;
    this.settle(cardId, verdict.outcome, verdict.failureReason);
  }

  /** Drop this card's run — dismisses its sheet and ends the run. */
  clear(cardId: string): void {
    this.cancels.delete(cardId);
    this.releaseHold(cardId);
    if (!this.state.has(cardId)) return;
    const next = new Map(this.state);
    next.delete(cardId);
    this.state = next;
    this.notify();
  }

  private settle(
    cardId: string,
    outcome: CompactionOutcome,
    failureReason: string | null,
  ): void {
    // Settle only an in-flight run; a second terminal call is a no-op so
    // racing paths (Cancel button vs. the turn settling) can't double-fire.
    const run = this.state.get(cardId);
    if (run === undefined || run.outcome !== null) return;
    this.write(cardId, { ...run, outcome, failureReason });
  }

  private write(cardId: string, run: CompactionProgress): void {
    const next = new Map(this.state);
    next.set(cardId, run);
    this.state = next;
    this.notify();
  }

  /** Drop this card's hold, if it took one. Idempotent. */
  private releaseHold(cardId: string): void {
    const release = this.holdReleases.get(cardId);
    if (release === undefined) return;
    this.holdReleases.delete(cardId);
    release();
  }
}

export const compactionProgressStore = new CompactionProgressStore();

/** Stable no-op subscribe for a row that has no card to be compacting. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** Stable `false` for the same. */
const NEVER_COMPACTING = (): boolean => false;

/**
 * Whether THIS card has a compaction in flight — the card-scoped door onto the
 * store, and the one every rendering surface should use.
 *
 * Two things it does that reading {@link CompactionProgressStore.getSnapshot}
 * directly does not, both of which matter because the caller is a session row
 * and session rows come by the listful:
 *
 *  - **The snapshot is this card's boolean, not the whole runs map.** A map read
 *    changes identity on every write to any card, so one card compacting
 *    re-rendered every session row in the app — the masthead, all of the Cards card's
 *    monitor rows, and every row in an open picker. A boolean compares equal
 *    across an unrelated card's run and React bails out.
 *  - **No `cardId`, no subscription.** A row for a session no card holds can
 *    never be compacting ({@link isCompactingCard} answers `false` for
 *    `undefined` before it reads anything), so it registers no listener at all
 *    rather than one that wakes it to compute `false` again.
 */
export function useIsCompactingCard(cardId: string | undefined): boolean {
  return useSyncExternalStore(
    cardId === undefined ? NOOP_SUBSCRIBE : compactionProgressStore.subscribe,
    useCallback(
      () =>
        cardId === undefined
          ? false
          : isCompactingCard(compactionProgressStore.getSnapshot(), cardId),
      [cardId],
    ),
    NEVER_COMPACTING,
  );
}
