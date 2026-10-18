/**
 * When the shell lets go of its copy of a body card's session binding.
 *
 * A body Session card binds, resumes and rebinds in its own page. The shell
 * keeps a binding for it all the same — set from the spawn acks it hears and
 * the harness's bind — and reads it for the Cards card's rows, the identity a
 * copy from the shell writes (`boundProjectDirFor`), `cardLineFacts`, and the
 * followed card a devtools or Arcs body is sent. It let the binding go when the
 * body stopped reporting a masthead: a card that let its session go.
 *
 * A rebind takes the masthead down too, for the beat its stores are rebuilt,
 * while the card's binding — and so its published identity — already names
 * the new session. So a resume onto another segment cleared the shell's copy
 * after the ack had set it, and nothing set it again: the shell read a bound
 * card as unbound for the rest of its life.
 *
 * The card holds a session while its body reports a masthead *or* an identity
 * naming one; the shell lets the binding go only when it has seen the card
 * hold one and the body now reports neither.
 *
 * @module lib/body-binding-mirror
 */

import type { CardFacts } from "@tugproto/bus";

/** Whether `facts` say the body's card holds a session. */
export function bodyHoldsSession(facts: Pick<CardFacts, "masthead" | "identity">): boolean {
  if (facts.masthead !== null) return true;
  const id = facts.identity?.tugSessionId;
  return typeof id === "string" && id.length > 0;
}

/**
 * Track whether each body card holds a session, and answer whether a facts
 * update is the one where it let it go — the moment the shell's binding goes.
 */
export class BodySessionHolds {
  private readonly holding = new Set<string>();

  /** Take `cardId`'s facts. True exactly when the card held a session and now does not. */
  letGo(cardId: string, facts: Pick<CardFacts, "masthead" | "identity">): boolean {
    if (bodyHoldsSession(facts)) {
      this.holding.add(cardId);
      return false;
    }
    return this.holding.delete(cardId);
  }

  /** Forget `cardId`, as its body goes. */
  forget(cardId: string): void {
    this.holding.delete(cardId);
  }
}
