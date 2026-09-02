/**
 * dash-replay-outcome-store.ts — the last replay outcome, per session.
 *
 * Three of a replay's five outcomes leave the dash row's facts exactly as they
 * were: `current` had nothing to do, `deferred` failed a precondition, and
 * `conflicted` stopped at a round without touching anything. Only `replayed`
 * and `recorded` move something a row can show. So a press whose outcome is one
 * of the first three has no visible consequence anywhere, and the verb reads as
 * a dead button.
 *
 * The outcome is parked here, keyed by the tug session id the press named, and
 * the card's {@link ArcReplayNoticeController} turns it into a pane bulletin —
 * the same shape {@link arcBindErrorStore} uses, for the same reason ([L22]: a
 * bulletin is a direct DOM update and must not round-trip through render).
 *
 * @module lib/arc-replay-outcome-store
 */

/** The outcome words the server's `changeset_replay_ok` can carry, plus the refusal. */
export type ArcReplayOutcomeWord =
  | "current"
  | "replayed"
  | "recorded"
  | "deferred"
  | "conflicted"
  | "error";

/** One replay's answer, as the notice needs to read it. */
export interface ArcReplayOutcome {
  readonly dash: string;
  readonly outcome: ArcReplayOutcomeWord;
  /** `deferred`'s detail, or the `_err` frame's message. Null otherwise. */
  readonly detail: string | null;
  /** `conflicted`'s stopping round, by subject. */
  readonly roundSubject: string | null;
  /** `conflicted`'s conflicting paths. */
  readonly paths: readonly string[];
  /** Bumped on every outcome so two identical answers in a row still notify. */
  readonly seq: number;
}

class ArcReplayOutcomeStore {
  private _outcomes = new Map<string, ArcReplayOutcome>();
  private _listeners: Array<() => void> = [];
  private _seq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  };

  /** The last outcome for `sessionId`, or null. */
  outcomeFor = (sessionId: string): ArcReplayOutcome | null =>
    this._outcomes.get(sessionId) ?? null;

  /** Record an outcome and wake the readers. */
  report = (
    sessionId: string,
    outcome: Omit<ArcReplayOutcome, "seq">,
  ): void => {
    this._seq += 1;
    this._outcomes.set(sessionId, { ...outcome, seq: this._seq });
    this._notify();
  };

  /** Forget a session's outcome. */
  clear = (sessionId: string): void => {
    if (this._outcomes.delete(sessionId)) this._notify();
  };

  private _notify(): void {
    for (const listener of [...this._listeners]) listener();
  }
}

export const arcReplayOutcomeStore = new ArcReplayOutcomeStore();
