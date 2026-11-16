/**
 * `session-open` — what a press on a cited session does, decided once.
 *
 * Three surfaces send a reader to a session they cite: the `SessionCitation`
 * chip in prose, its right-click menu, and a chart mark whose ref names a
 * session. The chip decides its press from hooks, because it has to repaint
 * when the answer moves; a chart mark has no React tree and reads the live
 * stores at press time. Both read {@link sessionOpenAct}, so the words the
 * bubble says over a mark and the act the press performs cannot drift, and
 * the chip performs its act through {@link performSessionOpenAct}, so the
 * chip and the mark cannot drift either.
 *
 * The act is one of three:
 *
 *  - `raise`: a deck card holds the session; front it.
 *  - `resume`: no card holds it, and the ledger's answer says it can be
 *    seated; seat it.
 *  - none: nothing to do here. The bubble over the mark already says
 *    `Session not open here`, which is the visible reason [L31] asks for.
 *
 * The answer is read by full id through the citation store's
 * `foundAnswerFor`, because the store keys answers by the spelling that was
 * asked, and a mark's ref was asked by its short id.
 *
 * @module lib/session-open
 */

import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/lib/action-vocabulary";
import { cardIdForSession } from "@/lib/card-session-binding-store";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { isSessionResumable } from "@/lib/session-resume";

/** The act a press on a cited session performs. */
export type SessionOpenAct =
  | { kind: "raise"; cardId: string }
  | { kind: "resume"; sessionId: string; projectDir: string };

/**
 * The act for `sessionId` now: `raise` when a card holds it, otherwise
 * `resume` when the ledger's `found` answer is resumable, otherwise `null`.
 */
export function sessionOpenAct(sessionId: string): SessionOpenAct | null {
  const cardId = cardIdForSession(sessionId);
  if (cardId !== null) return { kind: "raise", cardId };
  const found = sessionCitationStore.foundAnswerFor(sessionId);
  if (found === null) return null;
  const resumable = isSessionResumable({
    state: found.state,
    background: found.background,
    projectDir: found.projectDir,
  });
  return resumable ? { kind: "resume", sessionId: found.sessionId, projectDir: found.projectDir } : null;
}

/**
 * Perform `act`. The raise rides the registry's own `focus-session-card`,
 * the funnel every "go to that card" gesture dispatches through ([L30]); the
 * resume is the shell's command, because the deck work lives in
 * `action-dispatch.ts`.
 */
export function performSessionOpenAct(act: SessionOpenAct): void {
  if (act.kind === "raise") {
    dispatchCommand("focus-session-card", { cardId: act.cardId });
    return;
  }
  dispatchCommand(TUG_ACTIONS.RESUME_SESSION, { sessionId: act.sessionId, projectDir: act.projectDir });
}

/** Front or seat the session `sessionId` names, or do nothing when neither is possible. */
export function openCitedSession(sessionId: string): void {
  const act = sessionOpenAct(sessionId);
  if (act !== null) performSessionOpenAct(act);
}
