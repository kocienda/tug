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
 * **The press's horizon is not such a field either.** A pending press holds a
 * one-shot timer and the id of the card that made it, and both are the press's
 * own present tense rather than a reading of the arc: the timer observes
 * nothing and fires once, and it is cleared the moment an answer lands. The
 * ban above is on a field that says whether the *arc* is stopped, which is a
 * fact this store must always have to ask somebody else for. Read it no
 * wider than that, or the next reader deletes the one thing keeping a
 * permanently greyed button from being the answer to a frame nobody sent.
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

/**
 * How long a press waits for an answer before it releases itself.
 *
 * Set from the server's own ceiling plus margin — a stop waits up to
 * `arc_stop_ceiling_secs` (30s by default) for the stage to go quiet before it
 * answers at all — so a healthy slow stop is never called dead. It is a
 * one-shot per press, not a clock anybody reads: it observes nothing and fires
 * once.
 */
export const PRESS_HORIZON_MS = 45_000;

/**
 * The horizon's clock, injectable so a test can reach the far side of
 * forty-five seconds without waiting through them. Production is `globalThis`.
 */
export interface PressTimerSource {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: PressTimerSource = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

class ArcPressStore {
  private _pending = new Set<string>();
  private _refusals = new Map<string, ArcPressRefusal>();
  private _listeners: Array<() => void> = [];
  private _seq = 0;
  private _timers = new Map<string, unknown>();
  private _voices = new Map<string, string>();
  private _clock: PressTimerSource = DEFAULT_TIMERS;

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

  /**
   * The button was pressed.
   *
   * `sessionId` is the card the press acts as — the followed card on the Arcs
   * surface, the card itself in a popover. The store cannot work it out and
   * the refusal needs it twice over: the horizon below has no frame to read a
   * session off, and a refusal frame naming a session no card holds has
   * nowhere else to be spoken. Pass null only where there is genuinely no
   * card, in which case a refusal on this press is silent.
   */
  press = (
    arc: string,
    verb: ArcTransportVerb,
    sessionId: string | null,
  ): void => {
    const key = pressKey(arc, verb);
    if (this._pending.has(key)) return;
    this._pending.add(key);
    if (sessionId !== null) this._voices.set(key, sessionId);
    this._timers.set(
      key,
      this._clock.setTimeout(() => {
        this._timers.delete(key);
        this.refuse(null, arc, verb, "no answer");
      }, PRESS_HORIZON_MS),
    );
    this._notify();
  };

  /**
   * The press was answered — either way. A refusal calls this too, through
   * {@link refuse}: the button stops waiting whatever the answer was, and a
   * button still greyed over a refusal the bulletin already spoke is a
   * control the user cannot retry.
   */
  settle = (arc: string, verb: ArcTransportVerb): void => {
    const key = pressKey(arc, verb);
    this._forget(key);
    if (this._pending.delete(key)) this._notify();
  };

  /** The last refusal for `sessionId`, or null. */
  refusalFor = (sessionId: string): ArcPressRefusal | null =>
    this._refusals.get(sessionId) ?? null;

  /**
   * Record a refusal, release the button, and wake the readers.
   *
   * A null `sessionId` falls back to the card the press was made from, which
   * is the whole reason {@link press} carries one. Two answers arrive that
   * way: the horizon's own, which has no frame at all, and a refusal frame
   * naming a session no card holds — what a segment-addressed refusal is on
   * any rotated arc. Neither is worth dropping on the floor, and with neither
   * id nor press there is nowhere to speak and the button is released alone.
   */
  refuse = (
    sessionId: string | null,
    arc: string,
    verb: ArcTransportVerb,
    reason: string,
  ): void => {
    const key = pressKey(arc, verb);
    const voice = sessionId ?? this._voices.get(key) ?? null;
    this._forget(key);
    this._pending.delete(key);
    if (voice === null) {
      this._notify();
      return;
    }
    this._seq += 1;
    this._refusals.set(voice, { arc, verb, reason, seq: this._seq });
    this._notify();
  };

  /** Forget a session's refusal — a later success is not still a failure. */
  clearRefusal = (sessionId: string): void => {
    if (this._refusals.delete(sessionId)) this._notify();
  };

  /** @internal The horizon's clock, replaced by the store's own tests. */
  _setTimersForTests = (clock: PressTimerSource): void => {
    this._clock = clock;
  };

  /**
   * Retire a press's horizon and its voice. Called on every exit, because a
   * settled press whose timer still stands fires a phantom refusal at the
   * horizon over an arc that answered long ago.
   */
  private _forget(key: string): void {
    const timer = this._timers.get(key);
    if (timer !== undefined) {
      this._clock.clearTimeout(timer);
      this._timers.delete(key);
    }
    this._voices.delete(key);
  }

  private _notify(): void {
    for (const listener of [...this._listeners]) listener();
  }
}

export const arcPressStore = new ArcPressStore();
