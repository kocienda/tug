/**
 * arc-press-store.ts — one pressed transport control, from the press to the
 * answer.
 *
 * **Start**, **Resume** and **Stop** are one gesture wearing three verbs: each
 * sends a broadcast CONTROL frame whose answer comes back through
 * `action-dispatch`, nowhere near the row that asked. Two things need it.
 *
 * The **press** has to hold the button until something answers, or a slow
 * server reads as a dead button and the user presses again. That is parked
 * here by `verb:arc` rather than by session, because the arc is what the row
 * knows — a card can show more than one arc, and a press on one must not grey
 * the other. The verb rides the key beside it for the same reason at a
 * smaller scale: the Arcs card's row and a stop receipt below it can be about
 * one arc at once, and a pending Stop must not grey a Start.
 *
 * The **refusal** has nothing to move on success's behalf: an `_ok` seats the
 * arc and the chip and the lane follow it, but a refusal would land in
 * silence. So it is parked by session for the card's
 * {@link ArcPressNoticeController} to speak through a pane bulletin — the
 * same shape {@link arcBindErrorStore} uses, for the same reason ([L22]: a
 * bulletin is a direct DOM update and must not round-trip through render).
 *
 * **This store says nothing about whether an arc is still stopped**, and it
 * must not grow a field that does. A receipt is a frozen record of a past
 * moment, and a renderer that read live arc state into one would stop being a
 * record ([F05]). What lives here is the block's own press — the present tense
 * of a gesture the user just made, which is the one live thing a receipt row
 * is entitled to know. The transport control on a live row reads its face
 * from the entry it is handed, which is a different fact from this one and
 * arrives by a different road.
 *
 * @module lib/arc-press-store
 */

/**
 * The three transport verbs, which are the three acts a press can be.
 *
 * They are not three states of one thing: `start` opens an arc that may never
 * have run, `resume` clears a stop, and `stop` ends what is running. One
 * store holds all three because the *press* is the same shape in each case —
 * one button, one frame, one answer — not because the acts are.
 */
export type ArcTransportVerb = "start" | "resume" | "stop";

/** A refused press: the arc, the verb, the reason the server gave, and when. */
export interface ArcPressRefusal {
  readonly arc: string;
  readonly verb: ArcTransportVerb;
  readonly reason: string;
  /** Bumped on every refusal so two identical reasons in a row still notify. */
  readonly seq: number;
}

/** One pending press, keyed so two verbs on one arc are two presses. */
function pressKey(arc: string, verb: ArcTransportVerb): string {
  return `${verb}:${arc}`;
}

class ArcPressStore {
  private _pending = new Set<string>();
  private _refusals = new Map<string, ArcPressRefusal>();
  private _listeners: Array<() => void> = [];
  private _seq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  };

  /** Whether a `verb` press on `arc` is still waiting for its answer. */
  isPending = (arc: string, verb: ArcTransportVerb): boolean =>
    this._pending.has(pressKey(arc, verb));

  /** The button was pressed. */
  press = (arc: string, verb: ArcTransportVerb): void => {
    const key = pressKey(arc, verb);
    if (this._pending.has(key)) return;
    this._pending.add(key);
    this._notify();
  };

  /**
   * The press was answered — either way. A refusal calls this too, through
   * {@link refuse}: the button stops waiting whatever the answer was, and a
   * button still greyed over a refusal the bulletin already spoke is a
   * control the user cannot retry.
   */
  settle = (arc: string, verb: ArcTransportVerb): void => {
    if (this._pending.delete(pressKey(arc, verb))) this._notify();
  };

  /** The last refusal for `sessionId`, or null. */
  refusalFor = (sessionId: string): ArcPressRefusal | null =>
    this._refusals.get(sessionId) ?? null;

  /** Record a refusal, release the button, and wake the readers. */
  refuse = (
    sessionId: string,
    arc: string,
    verb: ArcTransportVerb,
    reason: string,
  ): void => {
    this._seq += 1;
    this._refusals.set(sessionId, { arc, verb, reason, seq: this._seq });
    this._pending.delete(pressKey(arc, verb));
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

export const arcPressStore = new ArcPressStore();
