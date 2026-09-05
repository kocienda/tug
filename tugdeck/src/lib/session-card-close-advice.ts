/**
 * session-card-close-advice.ts — what a Session card says when the pane
 * asks whether closing it needs a confirm, and what that confirm should
 * say.
 *
 * The Session card's registration carries `confirmClose: true` because a
 * transcript cannot be recovered once the card is gone. That is the right
 * default and the wrong answer for an empty card: one still sitting on the
 * project picker, or attached to a session it has never sent a message to,
 * has no transcript, and "Close Card?" over it is a guard with nothing
 * behind it.
 *
 * The exception is the composer. Text typed and not yet sent lives only in
 * the editor — nothing has persisted it — so closing over it is data loss
 * even on a card that is otherwise empty. That case does not waive; it
 * confirms, and the confirm says what it is about rather than asking a
 * generic question about a card the user thinks is blank ([L31]).
 *
 * The rule is {@link sessionCloseAdviceFor}, a pure function over what the
 * card is holding. {@link readSessionCardCloseAdvice} is the thin reader
 * that gathers that state from the live stores — called from the pane's
 * close handler at close time, never from render ([L02]).
 *
 * @module lib/session-card-close-advice
 */

import type { CardCloseAdvice } from "./card-close-advice";
import { cardServicesStore } from "./card-services-store";
import type { CodeSessionPhase } from "./code-session-store";
import { restorePassGate, sessionRestoreRegistry } from "./session-restore";
import type { TugPromptEntryDelegate } from "@/components/tugways/tug-prompt-entry";

/**
 * The confirm popover's copy when the only thing a close would take is a
 * message the user typed and never sent.
 */
export const UNSENT_DRAFT_CLOSE_MESSAGE =
  "Close Card? The message you haven't sent goes with it.";

/** What an attached card's session is holding. */
export interface SessionCardSessionState {
  transcriptLength: number;
  hasActiveTurn: boolean;
  queuedSendCount: number;
  phase: CodeSessionPhase;
}

/** Everything the rule reads. */
export interface SessionCardCloseState {
  /** The composer holds text or atoms the user has not sent. */
  holdsDraft: boolean;
  /** The card's session, or null when it has never attached. */
  session: SessionCardSessionState | null;
  /**
   * Has the startup restore pass settled? Read only for an unattached
   * card: before it settles, an apparently-blank card may be one whose
   * session is still on its way back.
   */
  restorePassSettled: boolean;
  /** A restore is registered for this card — its transcript is inbound. */
  restorePending: boolean;
}

/**
 * The rule. A draft always confirms and names itself; an empty card
 * waives; anything else confirms in the pane's own words.
 */
export function sessionCloseAdviceFor(
  state: SessionCardCloseState,
): CardCloseAdvice {
  if (state.holdsDraft) {
    return { waive: false, message: UNSENT_DRAFT_CLOSE_MESSAGE };
  }
  if (state.session === null) {
    return { waive: state.restorePassSettled && !state.restorePending };
  }
  const { transcriptLength, hasActiveTurn, queuedSendCount, phase } =
    state.session;
  return {
    waive:
      transcriptLength === 0 &&
      !hasActiveTurn &&
      queuedSendCount === 0 &&
      phase === "idle",
  };
}

/**
 * Gather the card's live state and apply {@link sessionCloseAdviceFor}.
 *
 * `entryDelegate` is the composer's handle, or null when no composer is
 * mounted (the picker) — its `isEmpty()` reads the live editor doc, so an
 * atom chip counts as content exactly as typed text does.
 */
export function readSessionCardCloseAdvice(
  cardId: string,
  entryDelegate: TugPromptEntryDelegate | null,
): CardCloseAdvice {
  const services = cardServicesStore.getServices(cardId);
  const snap = services?.codeSessionStore.getSnapshot() ?? null;
  return sessionCloseAdviceFor({
    holdsDraft: entryDelegate !== null && !entryDelegate.isEmpty(),
    session:
      snap === null
        ? null
        : {
            transcriptLength: snap.transcript.length,
            hasActiveTurn: snap.activeTurn !== null,
            queuedSendCount: snap.queuedSends.length,
            phase: snap.phase,
          },
    restorePassSettled: restorePassGate.getSnapshot(),
    restorePending: sessionRestoreRegistry.getSnapshot().get(cardId) !== undefined,
  });
}
