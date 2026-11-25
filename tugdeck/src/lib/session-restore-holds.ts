/**
 * The per-card holds a session restore keeps across the destruction of a
 * card's services bag — stranded queued sends, the opening command, and the
 * retry bookkeeping — alone in a module that imports neither side.
 *
 * `card-services-store` drains and clears these as it constructs and disposes
 * a card's services; `session-restore` writes them and reads the card's
 * services when a binding lands. Held in either of the two, each would import
 * the other. `session-restore` re-exports every symbol here for its callers.
 *
 * @module lib/session-restore-holds
 */

import { logSessionLifecycle } from "./session-lifecycle-log";
import type { CodeSessionState } from "./code-session-store/reducer";

// ---------------------------------------------------------------------------
// Stranded queued sends — the one thing that must outlive the dispose
// ---------------------------------------------------------------------------

/**
 * Sends the user queued at a card, held across the destruction of that
 * card's services bag.
 *
 * A reconnect calls `cardSessionBindingStore.clearAll()` *before* any
 * restore is attempted, which disposes every card's `CodeSessionStore`
 * — and with it any messages the user typed and asked to deliver while
 * a turn was running. Preserving the queue inside the store is
 * therefore not enough on its own: the store dies milliseconds later.
 * The queue has to live somewhere the dispose cannot reach, which is
 * what this map is. Losing those messages is [L23] — an internal
 * implementation operation destroying user-visible state — and unlike
 * the transcript there is nothing on screen to mark that it happened.
 *
 * Keyed by `cardId`, not `tugSessionId`: the user queued the message
 * *at a card*, and a card that comes back on a different session
 * should still carry it.
 *
 * Lifecycle: written by `CardServicesStore._dispose` when it tears
 * down a store with a non-empty queue; drained (and cleared) by
 * `_construct` when the replacement store is wired up; cleared
 * outright when the user closes the card, so a queued message cannot
 * resurface on an unrelated later session. Module scope means it is
 * bounded by the app session — nothing here is persisted, and a
 * message cannot survive a reload.
 */
type StrandedSends = CodeSessionState["queuedSends"];

const strandedQueuedSends = new Map<string, StrandedSends>();

/** Hold a disposing card's queued sends for its replacement store. */
export function stashQueuedSends(cardId: string, sends: StrandedSends): void {
  if (sends.length === 0) return;
  strandedQueuedSends.set(cardId, sends);
  logSessionLifecycle("queued_sends.stashed", {
    card_id: cardId,
    count: sends.length,
  });
}

/**
 * Take back this card's stranded sends, if any, clearing the entry.
 * Draining is destructive by design — a stash that could be read twice
 * would double-send.
 */
export function drainQueuedSends(cardId: string): StrandedSends | undefined {
  const sends = strandedQueuedSends.get(cardId);
  if (sends === undefined) return undefined;
  strandedQueuedSends.delete(cardId);
  logSessionLifecycle("queued_sends.drained", {
    card_id: cardId,
    count: sends.length,
  });
  return sends;
}

/** Discard a card's stranded sends without delivering them. */
export function clearQueuedSends(cardId: string): void {
  strandedQueuedSends.delete(cardId);
}

// ---------------------------------------------------------------------------
// The opening command — a first turn for a card whose session is not yet bound
// ---------------------------------------------------------------------------

/**
 * A slash command a card is to run as its FIRST turn, held from the moment
 * the card is added until its session binds.
 *
 * The menu's Run in New Session adds a card and fires the spawn in one
 * gesture, and the command has nowhere to live in between: the card has no
 * store yet, and the wire's opening-prompt field belongs to the wheel's
 * rotations and is documented as absent on every deck-originated command.
 * Widening the wire for this would blur that line for a fact the deck can
 * simply keep, which is what this map is — the same shape and the same
 * lifetime as the stranded sends above, keyed by `cardId` because the card
 * is what the gesture named and the session id is what is still missing.
 *
 * Deliberately NOT a queued send. A queued send carries wire content blocks
 * built at submit time, and injecting one here would post the command to
 * claude around the composer — past the slash classification a typed
 * command goes through. So what is held is the command itself, and the
 * delivery is `runCommandDraft`: the card's own composer seeds it and sends
 * it, which is the same path and the same bytes a typed one takes.
 *
 * Lifecycle: written when the card is added, drained (and cleared) by
 * `CardServicesStore._construct` when the card's store is wired up, cleared
 * outright when the card closes so a command cannot resurface on an
 * unrelated later session. Module scope, so nothing survives a reload.
 */
const openingCommands = new Map<string, { name: string; args: string }>();

/** Hold a command for a card to run as its first turn, once it binds. */
export function stashOpeningCommand(
  cardId: string,
  command: { name: string; args: string },
): void {
  openingCommands.set(cardId, command);
  logSessionLifecycle("opening_command.stashed", {
    card_id: cardId,
    name: command.name,
  });
}

/**
 * Take back this card's opening command, if any, clearing the entry.
 * Destructive by design, like the queued-send drain: a stash that could be
 * read twice would run the command twice.
 */
export function drainOpeningCommand(
  cardId: string,
): { name: string; args: string } | undefined {
  const command = openingCommands.get(cardId);
  if (command === undefined) return undefined;
  openingCommands.delete(cardId);
  logSessionLifecycle("opening_command.drained", {
    card_id: cardId,
    name: command.name,
  });
  return command;
}

/** Discard a card's opening command without running it. */
export function clearOpeningCommand(cardId: string): void {
  openingCommands.delete(cardId);
}

// ---------------------------------------------------------------------------
// Automatic restore retry — the bookkeeping
// ---------------------------------------------------------------------------


/**
 * Retries already spent on the current restore of each card.
 *
 * Cleared when the card's binding lands (the same place the registry
 * hold clears on success), when the user cancels, and when the budget
 * is exhausted. Module scope for the same reason as `session-restore`'s
 * `restoreStartedAt` — it must outlive the component tree that comes and
 * goes across the restore — and in memory only: never React state, never
 * browser storage.
 */
const restoreAttempts = new Map<string, number>();

/** Armed retry timers, so every one of them has a release ([L27]). */
const restoreRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Cancel any pending retry for a card and forget its attempt count.
 *
 * Called when the binding lands (the restore succeeded, possibly on an
 * attempt we had already given up waiting for), when the user cancels,
 * when the server rejects terminally, and when the card closes.
 */
export function cancelRestoreRetry(cardId: string): void {
  const timer = restoreRetryTimers.get(cardId);
  if (timer !== undefined) {
    clearTimeout(timer);
    restoreRetryTimers.delete(cardId);
  }
  restoreAttempts.delete(cardId);
}


/** Retries already spent on the current restore of `cardId`. */
export function restoreAttemptsSpent(cardId: string): number {
  return restoreAttempts.get(cardId) ?? 0;
}

/**
 * Record that `cardId` has now spent `attempts` retries and arm the timer that
 * runs the next one after `delayMs`. The timer forgets itself as it fires, so
 * {@link cancelRestoreRetry} only ever clears one that is still pending.
 */
export function armRestoreRetry(
  cardId: string,
  attempts: number,
  delayMs: number,
  fire: () => void,
): void {
  restoreAttempts.set(cardId, attempts);
  const timer = setTimeout(() => {
    restoreRetryTimers.delete(cardId);
    fire();
  }, delayMs);
  restoreRetryTimers.set(cardId, timer);
}
