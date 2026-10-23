/**
 * The shell's half of a body card's close decision.
 *
 * A body card's close guard runs in its body, where its sheet comes up in
 * the card it concerns; the shell's close gesture asks it as the
 * `card.closeDecision` request and waits. A guard that said it would ask
 * waits on the person at its sheet, with no deadline ([L33]'s person-exit:
 * the sheet is the exit, and a deadline would be on the person). One that
 * said it would not answers at once, so a body silent past the deadline is
 * not answering: the close is cancelled, and the card's pane says so
 * (`close-refusal-store.ts`) beside the dev-log line, rather than the close
 * silently not happening. A body that goes away cancels it, and the pane
 * says that too, with its reason; a newer ask of the same card cancels it
 * silently, being the answer to it.
 *
 * @module lib/close-decision
 */

import { CLOSE_DECISION_EXIT, CLOSE_DECISION_MS, cardCloseDecision } from "../bus/declarations/verbs";
import { closeRefusalStore } from "./close-refusal-store";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/** The decision standing for each card, by its request id. */
const asked = new Map<string, string>();

/**
 * Ask `cardId`'s body whether its close goes ahead. `asks` is what the body
 * last said of its guard (`card.holds`' `closeGuardAsks`).
 */
export async function askCloseDecision(
  cardId: string,
  asks: boolean,
  deadlineMs: number = CLOSE_DECISION_MS,
): Promise<"close" | "cancel"> {
  withdrawCloseDecision(cardId);
  // Asking again is the answer to a refusal that stood.
  closeRefusalStore.clear(cardId);
  const pending = cardCloseDecision.ask(
    {},
    { card: cardId, horizon: asks ? { person: CLOSE_DECISION_EXIT } : { ms: deadlineMs } },
  );
  asked.set(cardId, pending.requestId);
  const result = await pending;
  if (asked.get(cardId) === pending.requestId) asked.delete(cardId);
  if (result.ok) return result.value.answer;
  if (result.reason === "timeout") {
    tugDevLogStore.error("body", "a body did not answer its close decision; the close is cancelled", { cardId });
    closeRefusalStore.refuse(cardId);
  } else if (result.reason === "detached") {
    tugDevLogStore.warn("body", "a body's page went away while it was asked its close decision; the close is cancelled", { cardId });
    closeRefusalStore.refuse(cardId, "gone");
  }
  return "cancel";
}

/** Take back the decision standing for `cardId`, if one is; its close is cancelled. */
export function withdrawCloseDecision(cardId: string): void {
  const requestId = asked.get(cardId);
  if (requestId === undefined) return;
  asked.delete(cardId);
  cardCloseDecision.withdraw(requestId);
}
