/**
 * `pendingAskStore` — routes questions raised from outside the turn stream.
 *
 * A command-line tool that is about to do something the developer will feel can
 * `POST /api/ask` to tugcast and block. Tugcast broadcasts an `ask` CONTROL
 * frame; this store parks it on the target session's `CodeSessionStore` as
 * `pendingAsk`, the Session card renders a dialog, and the answer goes back the
 * way it came.
 *
 * Routing is by `sessionId`. A frame with no `sessionId` lands on the active
 * session — a terminal one directory over has no way to know which card the
 * developer is looking at.
 *
 * The blocked caller is the reason for three behaviors that would otherwise
 * look over-careful:
 *
 *  - **A question that cannot be routed is answered immediately**, with its
 *    fallback choice, rather than dropped. Silence would leave the caller
 *    hanging until its own timeout.
 *  - **A session torn down under a live question answers on its way out**, for
 *    the same reason.
 *  - **A second question for a session already showing one is answered at
 *    once**, rather than replacing the dialog and orphaning the first caller.
 *
 * The fallback is the caller's `unattendedChoice` when it named one and the
 * declining option otherwise — see {@link fallbackChoice}. Both readings say
 * the same thing: this is the answer for a question no human ever saw.
 *
 * Everything outside the store — the wire, the focused session, the session
 * registry — arrives through {@link PendingAskContext}. Nothing is imported as a
 * singleton, so every path above is reachable from a unit test.
 *
 * **Laws:** [L02] — the store exposes `subscribe` + `getSnapshot`, and publishes
 * a new snapshot on every change; the dialog reads it through
 * `useSyncExternalStore`, never through component state.
 *
 * @module lib/pending-ask-store
 */

import type { PendingAsk, PendingAskOption } from "./code-session-store/types";

/**
 * The frame tugcast broadcasts for a question. Every field is `unknown`: this
 * arrives off the wire and is validated on the way in.
 */
type AskFrame = Record<string, unknown>;

/**
 * The slice of a session's card services this store touches: somewhere to park
 * the question so the card renders it. Narrow on purpose — the store has no
 * business with the rest of `CardServices`.
 */
export interface PendingAskSession {
  tugSessionId: string;
  setPendingAsk: (ask: PendingAsk | null) => void;
}

/**
 * What the store needs from the app to do its job: a wire to answer on, the card
 * the developer is looking at when a question names no session, and a way to
 * look up (and notice the disappearance of) a session by id. Injected at
 * dispatch-init rather than imported, so the store has no opinion about how any
 * of it is obtained — and so its whole behavior is reachable from a test.
 */
export interface PendingAskContext {
  sendControlFrame: (action: string, payload: Record<string, unknown>) => void;
  /** The focused session's `tugSessionId`, or `null` if none is focused. */
  focusedTugSessionId: () => string | null;
  /** Resolve a session by `tugSessionId`, or `null` if no card holds it. */
  sessionFor: (tugSessionId: string) => PendingAskSession | null;
  /** Observe session comings and goings; returns its unregister ([L27]). */
  observeSessions: (listener: () => void) => () => void;
}

/**
 * The option a question falls back to when nobody can answer it.
 *
 * `unattendedChoice` is that answer when the caller named one: it is precisely
 * "what to do when no human weighs in", and a question that could not be shown
 * at all is the purest case of that. Otherwise it is the last option, which
 * callers reserve for declining — matching the dialog's own ordering.
 */
function fallbackChoice(ask: {
  options: ReadonlyArray<PendingAskOption>;
  unattendedChoice: string | null;
}): string | null {
  if (ask.unattendedChoice !== null) return ask.unattendedChoice;
  const { options } = ask;
  return options.length > 0 ? options[options.length - 1].value : null;
}

function parseOptions(raw: unknown): PendingAskOption[] {
  if (!Array.isArray(raw)) return [];
  const parsed: PendingAskOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { value, label, description } = entry as Record<string, unknown>;
    if (typeof value !== "string" || typeof label !== "string") continue;
    parsed.push({
      value,
      label,
      ...(typeof description === "string" && description.length > 0
        ? { description }
        : {}),
    });
  }
  return parsed;
}

/** One question in flight, and the session whose card is showing it. */
interface LiveAsk {
  tugSessionId: string;
  requestId: string;
  /** The answer to send if nobody ever gets to choose. Captured on arrival. */
  fallback: string;
}

class PendingAskStore {
  /**
   * Sessions currently holding a question, so teardown can answer for them.
   *
   * Replaced wholesale on every mutation rather than mutated in place: this map
   * *is* the [L02] snapshot, and `useSyncExternalStore` compares snapshots by
   * identity. An in-place `set` / `delete` would leave the identity unchanged
   * and every subscriber would sit through the change without re-rendering.
   */
  private _live: ReadonlyMap<string, LiveAsk> = new Map();

  private _listeners: Array<() => void> = [];

  private _context: PendingAskContext | null = null;

  private _servicesUnsub: (() => void) | null = null;

  /** Wire the store to the app. Called once from `initActionDispatch`. */
  init = (context: PendingAskContext): (() => void) => {
    this._context = context;
    // A card can go away while its question is up — the pane closes, the
    // binding clears, the deck destroys the card. `cardServicesStore` notifies
    // on every reconcile, which is where a vanished session becomes visible.
    // Reacting here rather than being called from `_dispose` keeps the
    // dependency one-way: this store knows about card services, not the
    // reverse.
    this._servicesUnsub = context.observeSessions(() => {
      this._reapVanishedSessions();
    });
    return () => {
      this._servicesUnsub?.();
      this._servicesUnsub = null;
      this._context = null;
    };
  };

  /** Send an answer back to the blocked caller. */
  private respondOnWire(requestId: string, choice: string): void {
    this._context?.sendControlFrame("ask-response", { requestId, choice });
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  /**
   * The request ids currently awaiting an answer. The dialog reads its content
   * from the owning `CodeSessionStore`, not from here — this snapshot exists so
   * consumers that care only about "is anything pending" have an [L02] handle.
   * The returned map is never mutated; each change publishes a new one.
   */
  getSnapshot = (): ReadonlyMap<string, LiveAsk> => this._live;

  /** Publish a new `_live` map built by `mutate`, preserving snapshot identity rules. */
  private _commit(mutate: (next: Map<string, LiveAsk>) => void): void {
    const next = new Map(this._live);
    mutate(next);
    this._live = next;
  }

  /** Handle an inbound `ask` CONTROL frame. */
  receive = (frame: AskFrame): void => {
    const { requestId, title } = frame;
    if (typeof requestId !== "string" || requestId.length === 0) return;

    const options = parseOptions(frame.options);
    if (typeof title !== "string" || title.length === 0 || options.length === 0) {
      // Malformed past the point of rendering. The caller is still blocked, so
      // decline rather than drop — but there is no option list to decline with.
      this.respondOnWire(requestId, "");
      return;
    }

    // Both halves of a countdown or neither: a duration with no answer to
    // commit, or an answer with no duration to reach it, is not a countdown.
    const unattendedRaw =
      typeof frame.unattendedChoice === "string" &&
      options.some((o) => o.value === frame.unattendedChoice)
        ? frame.unattendedChoice
        : null;
    const countdownRaw =
      typeof frame.countdownSecs === "number" && frame.countdownSecs > 0
        ? Math.floor(frame.countdownSecs)
        : null;
    const counts = unattendedRaw !== null && countdownRaw !== null;

    const ask: PendingAsk = {
      requestId,
      title,
      description:
        typeof frame.description === "string" && frame.description.length > 0
          ? frame.description
          : null,
      options,
      unattendedChoice: counts ? unattendedRaw : null,
      countdownSecs: counts ? countdownRaw : null,
    };

    const targetSessionId =
      typeof frame.sessionId === "string" && frame.sessionId.length > 0
        ? frame.sessionId
        : this._context?.focusedTugSessionId() ?? null;
    const session =
      targetSessionId === null
        ? null
        : this._context?.sessionFor(targetSessionId) ?? null;

    const fallback = fallbackChoice(ask) ?? "";

    if (session === null) {
      // No card to show it on. Answering beats leaving the caller to time out.
      this.respondOnWire(requestId, fallback);
      return;
    }

    // One dialog per session. A second question arriving while the developer is
    // mid-decision would swap the dialog out from under them and orphan the
    // first caller, so the newcomer gets its fallback instead. Its caller learns the
    // answer immediately rather than blocking behind a question it cannot see.
    const occupied = [...this._live.values()].some(
      (live) => live.tugSessionId === session.tugSessionId,
    );
    if (occupied) {
      this.respondOnWire(requestId, fallback);
      return;
    }

    this._commit((next) =>
      next.set(requestId, {
        tugSessionId: session.tugSessionId,
        requestId,
        fallback,
      }),
    );
    session.setPendingAsk(ask);
    this._notify();
  };

  /**
   * Answer a question and release the caller. Clearing the session's
   * `pendingAsk` is what unmounts the dialog.
   *
   * Returns whether the store still tracked the question. `false` means the
   * request was already answered on its way out (a reap during a transient
   * services miss can answer the wire while the session's own `pendingAsk`
   * survives) — the caller still holds the session and must clear the parked
   * question itself, or the dialog stands forever and every press on it is a
   * silent no-op.
   */
  respond = (requestId: string, choice: string): boolean => {
    const live = this._live.get(requestId);
    if (live === undefined) return false;
    this._commit((next) => next.delete(requestId));
    this._context?.sessionFor(live.tugSessionId)?.setPendingAsk(null);
    this.respondOnWire(requestId, choice);
    this._notify();
    return true;
  };

  /**
   * The server no longer waits for this question's answer — it timed out and
   * was resolved there. Take the dialog down without answering the wire: the
   * caller has already been told, and an `ask-response` for a dead request
   * would say nothing to nobody. Without this, an expired question stands
   * forever and the session reads Awaiting until reload.
   */
  rescind = (requestId: string): void => {
    const live = this._live.get(requestId);
    if (live === undefined) return;
    this._commit((next) => next.delete(requestId));
    this._context?.sessionFor(live.tugSessionId)?.setPendingAsk(null);
    this._notify();
  };

  /**
   * A session is going away. Anything it was being asked gets its fallback
   * answer, because the dialog is about to stop existing.
   *
   * The fallback is the one captured when the question arrived, not one
   * re-read from the session — by the time this runs the store it lived on may
   * already be disposed, and an empty answer is no answer.
   */
  sessionClosed = (tugSessionId: string): void => {
    const doomed = [...this._live.values()].filter(
      (live) => live.tugSessionId === tugSessionId,
    );
    if (doomed.length === 0) return;
    this._commit((next) => {
      for (const live of doomed) next.delete(live.requestId);
    });
    for (const live of doomed) this.respondOnWire(live.requestId, live.fallback);
    // Best-effort: when the session can still be reached, take its parked
    // question down with the answer. On the reap path the lookup misses by
    // definition — there, the card's own respond fallback is the backstop.
    this._context?.sessionFor(tugSessionId)?.setPendingAsk(null);
    this._notify();
  };

  /**
   * Answer for every question whose session no longer has a card. Runs off
   * `cardServicesStore`'s reconcile notification, which is the one moment a
   * disposed session becomes observable from here.
   */
  private _reapVanishedSessions(): void {
    const gone = new Set<string>();
    for (const live of this._live.values()) {
      if ((this._context?.sessionFor(live.tugSessionId) ?? null) === null) {
        gone.add(live.tugSessionId);
      }
    }
    for (const tugSessionId of gone) this.sessionClosed(tugSessionId);
  }

  private _notify(): void {
    for (const listener of this._listeners.slice()) listener();
  }
}

export const pendingAskStore = new PendingAskStore();
