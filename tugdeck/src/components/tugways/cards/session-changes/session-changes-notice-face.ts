/**
 * session-changes-notice-face — which of the shade band's tenants speaks.
 *
 * The Changes shade's notice band has several possible tenants at once: a
 * standing commit error, a gate refusal of the press that followed it, a
 * refused claim, a refused Auto-Message, a replay outcome. One band renders
 * exactly one notice ([P05]), so something has to choose, and the choosing is
 * the part that can be wrong — a race between two live tenants is not
 * something a reader can check by looking at the band.
 *
 * So the choice is a pure function over the candidates, out here where it can
 * be tested without a DOM, and the component is left with nothing to decide.
 * The order is List L01: the landing outranks everything, because a landing is
 * the gesture the shade exists for; within the landing the error outranks the
 * refusal, for the reason the seam strip already recorded — the server refusing
 * a landing that went out is a thing that failed, and this deck refusing to
 * send one is a press that never happened.
 *
 * Nothing here imports React or a store. What a notice *says* is its source's
 * to decide ({@link landingNoticeFace} for the landing, the verb store's own
 * error text for the rest); this module decides only which one is on.
 *
 * @module components/tugways/cards/session-changes/session-changes-notice-face
 */

/**
 * List L01, as numbers: lower speaks first. Named rather than inlined so a
 * later tenant is seated by reading the list rather than by counting.
 */
export const SHADE_NOTICE_RANK = {
  /** A landing the server refused, and which stands until it is retried. */
  landingError: 0,
  /** This deck refusing to send a landing — the gate's own sentence. */
  landingRefusal: 1,
  /** Claim, disclaim, discard, Auto-Message — the shade's own verbs. */
  verbError: 2,
  /** An arc replay's outcome, when the press that made it was the shade's. */
  replayOutcome: 3,
} as const;

/** The band's live region and icon tint, in the vocabulary both read from. */
export type ShadeNoticeTone = "danger" | "caution" | "success" | "default";

/** What act the notice carries *beyond* the Dismiss every tenant has. */
export type ShadeNoticeAct = "retry" | "none";

/**
 * One notice the band could render — the words, the identity, and the rank.
 *
 * `seq` breaks a tie inside one rank: higher is more recent, which is what
 * "the verb refusals, most recently changed first" means. A candidate that
 * supplies none keeps its position in the caller's list.
 */
export interface ShadeNoticeCandidate {
  /** List L01 position; see {@link SHADE_NOTICE_RANK}. */
  rank: number;
  /**
   * Identity for local dismissal and for the fade timer — the detail string
   * for an error, the refusal's `seq`, the verb's own error text. Never the
   * title: two presses of a refusing button produce identical titles, and a
   * band that compared those would go silent exactly when the user asked
   * again.
   */
  key: string;
  /**
   * Which dismissal slot this notice belongs to. Dismissal is per channel
   * because the channels are independent: dismissing a standing server error
   * must not silence the refusal of the press that follows it.
   */
  channel: string;
  tone: ShadeNoticeTone;
  /** Title line — the cause, in the user's frame. */
  title: string;
  /** The remedy sentence, or null when the title is the whole of it. */
  description: string | null;
  /** Verbatim evidence to fold, or null when there is nothing beyond the title. */
  detail: string | null;
  act: ShadeNoticeAct;
  /** Recency inside one rank; higher speaks first. */
  seq?: number;
}

/** The one notice the band renders this pass. */
export type ShadeNoticeFace = ShadeNoticeCandidate;

/**
 * The single notice to render, or null when nothing is live.
 *
 * Ties inside a rank go to the higher `seq`, and candidates carrying no `seq`
 * keep the caller's order — so a source that has no recency to publish gets
 * the order it wrote its candidates in rather than an arbitrary one.
 */
export function rankShadeNotices(
  candidates: readonly ShadeNoticeCandidate[],
): ShadeNoticeFace | null {
  let winner: ShadeNoticeCandidate | null = null;
  for (const candidate of candidates) {
    if (winner === null) {
      winner = candidate;
      continue;
    }
    if (candidate.rank < winner.rank) {
      winner = candidate;
      continue;
    }
    if (candidate.rank === winner.rank && (candidate.seq ?? 0) > (winner.seq ?? 0)) {
      winner = candidate;
    }
  }
  return winner;
}

/**
 * The replay outcome this shade may speak for, or null.
 *
 * `arcReplayOutcomeStore` holds **one** outcome per tug session, and both the
 * shade's band and the card's corner bulletin lane read that one slot. So the
 * division has to be on something the press carried, and it is: the `entryKey`
 * the outcome is stamped with (Spec S03). An outcome stamped `"arcs-card"` is
 * the Arcs card's press and is not this shade's to claim, even though the shade
 * may well be presented when the answer lands — which is exactly the mistake
 * keying on presented state would make ([P01]).
 *
 * Out here, and generic over the stamp, because it is the part that can be
 * silently wrong: a band that claimed a foreign press would say the right words
 * about somebody else's gesture, and no reader could tell by looking.
 */
export function shadeOriginReplay<T extends { readonly entryKey: string }>(
  outcome: T | null,
  shadeEntryKey: string,
): T | null {
  if (outcome === null) return null;
  return outcome.entryKey === shadeEntryKey ? outcome : null;
}
