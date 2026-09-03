/**
 * arc-bind-error-store.ts — the last refused arc binding, per session.
 *
 * `bind_arc` is a broadcast verb: the deck sends a CONTROL frame and the
 * answer comes back through `action-dispatch`, nowhere near the card that
 * asked. Success needs no channel — `bind_arc_ok` moves the binding store and
 * the chip and the lane follow. A refusal has nothing to move, so without this
 * it lands in silence and a `/arc <name>` that did nothing is
 * indistinguishable from one that was never typed.
 *
 * So the failure is parked here, keyed by session, and the card's
 * {@link ArcBindErrorNoticeController} turns it into a pane bulletin — the
 * same shape `ChangesetVerbStore` + `ClaimErrorNoticeController` use, for the
 * same reason ([L22]: a bulletin is a direct DOM update and must not
 * round-trip through render).
 *
 * @module lib/arc-bind-error-store
 */

/** A refused binding: the reason the server gave, and when it was refused. */
export interface ArcBindError {
  readonly reason: string;
  /** Bumped on every refusal so two identical reasons in a row still notify. */
  readonly seq: number;
}

class ArcBindErrorStore {
  private _errors = new Map<string, ArcBindError>();
  private _listeners: Array<() => void> = [];
  private _seq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  };

  /** The last refusal for `sessionId`, or null. */
  errorFor = (sessionId: string): ArcBindError | null =>
    this._errors.get(sessionId) ?? null;

  /** Record a refusal and wake the readers. */
  fail = (sessionId: string, reason: string): void => {
    this._seq += 1;
    this._errors.set(sessionId, { reason, seq: this._seq });
    this._notify();
  };

  /** Forget a session's refusal — a later success is not still a failure. */
  clear = (sessionId: string): void => {
    if (this._errors.delete(sessionId)) this._notify();
  };

  private _notify(): void {
    for (const listener of [...this._listeners]) listener();
  }
}

export const arcBindErrorStore = new ArcBindErrorStore();
