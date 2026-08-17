/**
 * landing-notice — what a landing surface should be saying right now ([L31]).
 *
 * The decision is separated from the controller that applies it because the
 * controller is a React component with no substrate to test against, while the
 * decision is the part that can be wrong: which of two competing conditions
 * speaks, whether a repeat press re-posts, when a notice comes down. Keeping it
 * a pure function over (what is posted, what the mode published) makes those
 * answerable without a DOM, and leaves the component with nothing to decide.
 *
 * @module lib/landing-notice
 */

import type { LandingKind, LandingSnapshot } from "@/lib/landing-mode";

/** What is currently on screen for a landing mode — the caller's own record. */
export interface LandingNoticeState {
  /** The land-error detail last posted, or null. */
  error: string | null;
  /** The refusal `seq` last posted, or null when no refusal is up. */
  refusalSeq: number | null;
}

/** Nothing posted yet — the state a fresh notice controller starts from. */
export const NO_LANDING_NOTICE: LandingNoticeState = Object.freeze({
  error: null,
  refusalSeq: null,
});

/** One thing to do to the bulletin channel. */
export type LandingNoticeAction =
  | {
      kind: "post";
      id: string;
      /** `danger` persists until dismissed; `caution` fades on its own. */
      tone: "danger" | "caution";
      title: string;
      description: string;
    }
  | { kind: "dismiss"; id: string };

/** The notice ids a landing kind owns — stable, so a repeat replaces in place. */
export function landingNoticeIds(kind: LandingKind): { error: string; refusal: string } {
  return { error: `${kind}-error`, refusal: `${kind}-refusal` };
}

/**
 * What the bulletin channel should be told, given what is already up and what
 * the mode now publishes.
 *
 * Two independent channels, because they answer different questions and can be
 * true at once: `landError` is the server refusing a landing that went out (it
 * persists until it clears), and `landRefusal` is this deck refusing to send
 * one (it is about the press the user just made). A gate refusal fades, because
 * the user can see the condition and clear it; a fault is sticky, because a
 * broken dependency needs reading and there is a remediation in the sentence.
 *
 * Refusals are keyed on `seq`, never on the sentence: pressing a refusing
 * button twice usually produces the identical words, and a surface that
 * compared text would go silent exactly when the user asked a second time.
 */
export function landingNoticeDecision(
  kind: LandingKind,
  prev: LandingNoticeState,
  snapshot: LandingSnapshot,
): { actions: LandingNoticeAction[]; next: LandingNoticeState } {
  const ids = landingNoticeIds(kind);
  const noun = kind === "commit" ? "Commit" : "Join";
  const actions: LandingNoticeAction[] = [];

  const error = snapshot.landError;
  if (error !== prev.error) {
    if (error === null) actions.push({ kind: "dismiss", id: ids.error });
    else {
      actions.push({
        kind: "post",
        id: ids.error,
        tone: "danger",
        title: `${noun} failed`,
        description: error,
      });
    }
  }

  const refusal = snapshot.landRefusal;
  const seq = refusal?.seq ?? null;
  if (seq !== prev.refusalSeq) {
    if (refusal === null) actions.push({ kind: "dismiss", id: ids.refusal });
    else {
      actions.push({
        kind: "post",
        id: ids.refusal,
        tone: refusal.kind === "fault" ? "danger" : "caution",
        title: refusal.kind === "fault" ? `${noun} cannot run` : `${noun} not sent`,
        description: refusal.sentence,
      });
    }
  }

  return { actions, next: { error, refusalSeq: seq } };
}
