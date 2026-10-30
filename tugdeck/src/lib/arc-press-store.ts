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
 * **One store for the whole deck, and the shell holds it** (`arc.presses`).
 * A press is made on whichever page holds the button — a stop receipt's
 * Resume in its Session card's body, the Arcs card's row in the Arcs card's,
 * the shade and the popover in theirs — and the refusal is spoken on another
 * page as often as not: the Arcs card presses as the card it follows. A store
 * per page left each half talking to itself. The answers arrive at the shell
 * only, so a body's press never settled, and its horizon spoke "no answer"
 * over an arc that had resumed; and a refusal parked on the Arcs card's page
 * named a card whose page never read it. So the shell owns the presses, the
 * refusals, the horizons and the answers, and every body reads the replica
 * and proposes to it ({@link shareArcPresses}).
 *
 * **The shell sends the frame.** A body proposes the whole press, frame
 * included, and the shell records the press and only then sends it. A body
 * that sent its own frame and proposed only the press would race its answer
 * to the shell — a fast server's `_ok` arriving before the proposal settles
 * nothing, and the press that lands after it waits out its horizon. The
 * replica shows the press at once, so the button greys on the click.
 *
 * **A refusal stands until it is seen or superseded.** The shell holds it
 * past any one page's life, so the bulletin that speaks it clears it when it
 * goes ({@link ArcPressStore.clearRefusal} with its sequence) — or a card
 * that reloads, or wakes, would speak an old refusal again. A later press
 * that lands clears it too.
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

import type { ControlAction } from "@tugproto/control";

import {
  arcPresses,
  arcPressKey as pressKey,
  type ArcPressActor,
  type ArcPressPatch,
  type ArcPressRefusal,
  type ArcPressState,
  type ArcRefusedVerb,
  type ArcTransportVerb,
} from "../bus/declarations/relays";
import { pageBus, type PageBus } from "../bus/page-bus";
import type { StoreView } from "../bus/shared-store";
import { getConnection } from "./connection-singleton";
import { Subscribable } from "./subscribable";

export type {
  ArcPressActor,
  ArcPressPatch,
  ArcPressRefusal,
  ArcPressState,
  ArcRefusedVerb,
  ArcTransportVerb,
};

/** The CONTROL action each transport verb sends. */
export const ACTION_FOR: Record<ArcTransportVerb, ControlAction> = {
  start: "arc_run",
  resume: "arc_resume",
  stop: "arc_stop",
};

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

/**
 * Where a press's frame goes: the page's connection, or null when it has
 * none. Injectable beside the clock, so a test reads the frames a shell sent
 * without reaching for the connection singleton other suites mock.
 */
export interface PressFrameSink {
  sendControlFrame: (action: ControlAction, payload: Record<string, unknown>) => void;
}

export class ArcPressStore extends Subscribable {
  private _pending = new Set<string>();
  private _refusals = new Map<string, ArcPressRefusal>();
  private _seq = 0;
  private _timers = new Map<string, unknown>();
  private _voices = new Map<string, string>();
  private _clock: PressTimerSource = DEFAULT_TIMERS;
  private _sink: () => PressFrameSink | null = getConnection;
  /** A body: the shell's store, which this page reads and proposes to. */
  private _replica: StoreView<ArcPressState, ArcPressPatch> | null = null;
  /** The shell: where every change is published. */
  private _publish: ((state: ArcPressState) => void) | null = null;

  /** Whether a `verb` press on `arc` is still waiting for its answer. */
  isPending = (arc: string, verb: ArcTransportVerb): boolean => {
    const key = pressKey(arc, verb);
    if (this._replica !== null) return this._replica.getSnapshot().pending.includes(key);
    return this._pending.has(key);
  };

  /**
   * Press `verb` on `arc` as `actor`: hold the button and send the frame.
   *
   * The press is raised only once the frame is actually going out. A held
   * button waits for an answer, and a frame nobody sent is answered by
   * nothing — so with no connection the press is not made, and the button
   * stays pressable so a reconnect makes the same press work ([L31]). Returns
   * whether the press was made.
   *
   * In a body the press is the shell's to make ({@link ArcPressStore}'s header
   * says why): it is proposed whole, and the replica shows it at once.
   */
  send = (arc: string, verb: ArcTransportVerb, actor: ArcPressActor): boolean => {
    if (this.isPending(arc, verb)) return false;
    if (this._replica !== null) {
      this._replica.propose({ op: "press", arc, verb, actor });
      return true;
    }
    const connection = this._sink();
    if (connection === null) {
      console.warn(`arc ${verb} not sent: no connection`, { arc });
      return false;
    }
    this.press(arc, verb, actor.tugSessionId);
    connection.sendControlFrame(ACTION_FOR[verb], {
      tug_session_id: actor.tugSessionId,
      project_dir: actor.projectDir,
      arc,
    });
    return true;
  };

  /**
   * The button was pressed — the press alone, with no frame. {@link send} is
   * the door a surface uses; this is the half of it the horizon hangs on.
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
    this._changed();
  };

  /**
   * The press was answered — either way. A refusal calls this too, through
   * {@link refuse}: the button stops waiting whatever the answer was, and a
   * button still greyed over a refusal the bulletin already spoke is a
   * control the user cannot retry. The answers are the shell's, so a body
   * settles nothing.
   */
  settle = (arc: string, verb: ArcTransportVerb): void => {
    if (this._replica !== null) return;
    const key = pressKey(arc, verb);
    this._forget(key);
    if (this._pending.delete(key)) this._changed();
  };

  /** The last refusal for `sessionId`, or null. */
  refusalFor = (sessionId: string): ArcPressRefusal | null => {
    if (this._replica !== null) return this._replica.getSnapshot().refusals[sessionId] ?? null;
    return this._refusals.get(sessionId) ?? null;
  };

  /**
   * Record a refusal, release the button, and wake the readers.
   *
   * A null `sessionId` falls back to the card the press was made from, which
   * is the whole reason {@link press} carries one. Two answers arrive that
   * way: the horizon's own, which has no frame at all, and a refusal frame
   * naming a session no card holds — what a segment-addressed refusal is on
   * any rotated arc. Neither is worth dropping on the floor, and with neither
   * id nor press there is nowhere to speak and the button is released alone.
   *
   * In a body only a named refusal is proposed — a surface's own, refused
   * before any frame went out — since a null one is an answer, and the
   * answers are the shell's.
   */
  refuse = (
    sessionId: string | null,
    arc: string,
    verb: ArcRefusedVerb,
    reason: string,
  ): void => {
    if (this._replica !== null) {
      if (sessionId !== null) {
        this._replica.propose({ op: "refuse", voice: sessionId, arc, verb, reason });
      }
      return;
    }
    const key = pressKey(arc, verb);
    const voice = sessionId ?? this._voices.get(key) ?? null;
    this._forget(key);
    this._pending.delete(key);
    if (voice === null) {
      this._changed();
      return;
    }
    this._seq += 1;
    this._refusals.set(voice, { arc, verb, reason, seq: this._seq });
    this._changed();
  };

  /**
   * Forget a session's refusal — a later success is not still a failure, and
   * a refusal the bulletin has spoken and let go is not still news. `seq`
   * names the refusal being let go, so a bulletin that closes does not take a
   * newer refusal down with it; omit it to forget whatever stands.
   */
  clearRefusal = (sessionId: string, seq: number | null = null): void => {
    if (this._replica !== null) {
      if (this.refusalFor(sessionId) !== null) {
        this._replica.propose({ op: "clear", sessionId, seq });
      }
      return;
    }
    const refusal = this._refusals.get(sessionId);
    if (refusal === undefined || (seq !== null && refusal.seq !== seq)) return;
    this._refusals.delete(sessionId);
    this._changed();
  };

  /** Everything the store holds, as the shell publishes it. */
  state = (): ArcPressState => {
    if (this._replica !== null) return this._replica.getSnapshot();
    return {
      pending: [...this._pending],
      refusals: Object.fromEntries(this._refusals),
    };
  };

  /** @internal The horizon's clock, replaced by the store's own tests. */
  _setTimersForTests = (clock: PressTimerSource): void => {
    this._clock = clock;
  };

  /** @internal The frame sink, replaced by the store's own tests. */
  _setFrameSinkForTests = (sink: () => PressFrameSink | null): void => {
    this._sink = sink;
  };

  /** @internal {@link shareArcPresses}: this page reads the shell's store. */
  _attachReplica(replica: StoreView<ArcPressState, ArcPressPatch>): () => void {
    this._replica = replica;
    const release = replica.subscribe(() => this.notify());
    this.notify();
    return () => {
      release();
      if (this._replica === replica) this._replica = null;
      this.notify();
    };
  }

  /** @internal {@link shareArcPresses}: this page is the shell, and publishes. */
  _attachPublisher(publish: (state: ArcPressState) => void): () => void {
    this._publish = publish;
    publish(this.state());
    return () => {
      if (this._publish === publish) this._publish = null;
    };
  }

  private _changed(): void {
    this._publish?.(this.state());
    this.notify();
  }

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
}

export const arcPressStore = new ArcPressStore();

/**
 * Hold the deck's presses with the shell (`arc.presses`).
 *
 * In the shell, `store` is the one store: every change is published, and a
 * body's proposal is the same call the shell's own surfaces make — a press
 * made and its frame sent, a surface's refusal recorded, a seen refusal let
 * go. In a body, `store` becomes the replica's reader and proposer. Returns
 * the release.
 */
export function shareArcPresses(
  bus: PageBus = pageBus(),
  store: ArcPressStore = arcPressStore,
): () => void {
  const shared = arcPresses.on(bus);
  if (bus.page.role !== "shell") return store._attachReplica(shared);
  const releases = [
    store._attachPublisher((state) => shared.set(state)),
    shared.onProposal((patch) => {
      switch (patch.op) {
        case "press":
          store.send(patch.arc, patch.verb, patch.actor);
          return;
        case "refuse":
          store.refuse(patch.voice, patch.arc, patch.verb, patch.reason);
          return;
        case "clear":
          store.clearRefusal(patch.sessionId, patch.seq);
          return;
      }
    }),
  ];
  return () => {
    for (const release of releases.splice(0)) release();
  };
}
