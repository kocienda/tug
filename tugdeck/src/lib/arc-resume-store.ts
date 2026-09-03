/**
 * arc-resume-store.ts — one pressed Resume, from the press to the answer.
 *
 * The **Resume** button lives in a stop receipt's own block, and the frame it
 * sends is a broadcast verb: the answer comes back through `action-dispatch`,
 * nowhere near the row that asked. Two things need it.
 *
 * The **press** has to hold the button until something answers, or a slow
 * server reads as a dead button and the user presses again. That is parked
 * here by arc name rather than by session, because the arc is what the row
 * knows — a card can hold stop receipts for more than one arc, and a press on
 * one must not grey the other.
 *
 * The **refusal** has nothing to move on success's behalf: `arc_resume_ok`
 * seats the arc and the chip and the lane follow it, but a refusal would land
 * in silence. So it is parked by session for the card's
 * {@link ArcResumeNoticeController} to speak through a pane bulletin — the
 * same shape {@link arcBindErrorStore} uses, for the same reason ([L22]: a
 * bulletin is a direct DOM update and must not round-trip through render).
 *
 * **This store says nothing about whether an arc is still stopped**, and it
 * must not grow a field that does. A receipt is a frozen record of a past
 * moment, and a renderer that read live arc state into one would stop being a
 * record ([F05]). What lives here is the block's own press — the present tense
 * of a gesture the user just made, which is the one live thing a receipt row
 * is entitled to know.
 *
 * @module lib/arc-resume-store
 */

/** A refused resume: the arc, the reason the server gave, and when. */
export interface ArcResumeRefusal {
  readonly arc: string;
  readonly reason: string;
  /** Bumped on every refusal so two identical reasons in a row still notify. */
  readonly seq: number;
}

class ArcResumeStore {
  private _pending = new Set<string>();
  private _refusals = new Map<string, ArcResumeRefusal>();
  private _listeners: Array<() => void> = [];
  private _seq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  };

  /** Whether a press on `arc` is still waiting for its answer. */
  isPending = (arc: string): boolean => this._pending.has(arc);

  /** The button was pressed. */
  press = (arc: string): void => {
    if (this._pending.has(arc)) return;
    this._pending.add(arc);
    this._notify();
  };

  /**
   * The press was answered — either way. A refusal calls this too, through
   * {@link refuse}: the button stops waiting whatever the answer was, and a
   * button still greyed over a refusal the bulletin already spoke is a
   * control the user cannot retry.
   */
  settle = (arc: string): void => {
    if (this._pending.delete(arc)) this._notify();
  };

  /** The last refusal for `sessionId`, or null. */
  refusalFor = (sessionId: string): ArcResumeRefusal | null =>
    this._refusals.get(sessionId) ?? null;

  /** Record a refusal, release the button, and wake the readers. */
  refuse = (sessionId: string, arc: string, reason: string): void => {
    this._seq += 1;
    this._refusals.set(sessionId, { arc, reason, seq: this._seq });
    this._pending.delete(arc);
    this._notify();
  };

  /** Forget a session's refusal — a later success is not still a failure. */
  clearRefusal = (sessionId: string): void => {
    if (this._refusals.delete(sessionId)) this._notify();
  };

  private _notify(): void {
    for (const listener of [...this._listeners]) listener();
  }
}

export const arcResumeStore = new ArcResumeStore();
