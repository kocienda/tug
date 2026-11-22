/**
 * The card's record of the turns it can place against tugcast's turn latch,
 * and the rule that uses it.
 *
 * tugcast's latch names the turn it last opened by an id (the submission id
 * of a prompt, or one the merger mints for a live wake), and the card learns
 * each of its cycles' ids in-band from the frame that opens it. To tell a
 * reading that names a turn the card missed from one that names a turn it
 * already finished, the card keeps the last {@link KNOWN_TURN_IDS_CAP} ids it
 * can place: every cycle it closed, every replayed turn it committed, and
 * every idle reading it took while idle. Membership is the only test there
 * is, since the ids carry no order.
 *
 * At an edge, a card that believes a turn is running yields to a latch that
 * says the turn has ended ({@link reconcileTurn}).
 *
 * Pure: no IO, no store. The reducer calls it.
 */

import type { Effect, TurnReconciledEffect } from "./effects";
import { phaseCanInterrupt } from "./lifecycle-state";
import type { CodeSessionState, PendingTurn } from "./reducer";

/** The move that runs the rule: a new latch reading, a catch-up's close, or the wire coming back. */
export type ReconcileEdge = TurnReconciledEffect["edge"];

/** How many turn ids the card remembers; the oldest is dropped first. */
export const KNOWN_TURN_IDS_CAP = 32;

/** The log source of the one line a reconcile writes. */
export const TURN_RECONCILE_LOG_SOURCE = "turn-reconcile";

/**
 * `known` with each of `ids` remembered: an id already held stays where it
 * is, a new one is appended, and past {@link KNOWN_TURN_IDS_CAP} the oldest
 * are dropped. Returns `known` itself when nothing was added, so a caller
 * can keep its state reference.
 */
export function rememberTurnIds(
  known: readonly string[],
  ids: Iterable<string | null | undefined>,
): readonly string[] {
  let next: string[] | null = null;
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) continue;
    const held: readonly string[] = next ?? known;
    if (held.includes(id)) continue;
    next = [...held, id];
  }
  if (next === null) return known;
  return next.length > KNOWN_TURN_IDS_CAP
    ? next.slice(next.length - KNOWN_TURN_IDS_CAP)
    : next;
}

/**
 * Every id a closing cycle can be placed by: its own, and each server id it
 * absorbed while open.
 */
export function cycleTurnIds(turn: PendingTurn | null): string[] {
  if (turn === null) return [];
  return [
    ...(turn.turnId !== undefined ? [turn.turnId] : []),
    ...(turn.heardTurnIds ?? []),
  ];
}

/**
 * Which rule a card's state fires, or null when none does.
 *
 * The card must hold a cycle it believes is running, outside any bracket,
 * shadow or standing catch-up, awake, on a live wire; and tugcast's newest
 * reading must say no turn is running and name the turn it last ran — a
 * turn the card has not already ended on this rule. Then:
 *
 * - `same-turn`: the reading names the cycle's own turn, so tugcast says
 *   the very turn the card is running has ended.
 * - `later-turn`: the reading names a turn the card never heard of (not the
 *   cycle's, not one it absorbed, not one it finished), so tugcast ran a
 *   turn past the one the card holds. A card still `submitting` refuses
 *   this: its own turn may not have reached the latch yet.
 *
 * Anything else is a stale reading, or one naming a turn the card is past.
 */
export function reconcileRule(state: CodeSessionState): TurnReconciledEffect["rule"] | null {
  const cycle = state.pendingTurn;
  const latch = state.serverTurn;
  if (cycle === null || !phaseCanInterrupt(state.phase)) return null;
  if (state.phase === "replaying" || state.replayShadowActive) return null;
  if (state.catchUp.stage !== "none" || state.catchUp.asleep) return null;
  if (state.transportState !== "online") return null;
  if (latch === null || latch.active || latch.turnId === null) return null;
  if (latch.turnId === state.lastReconciledTurnId) return null;
  if (cycle.turnId !== undefined && latch.turnId === cycle.turnId) return "same-turn";
  if (
    state.phase !== "submitting" &&
    !(cycle.heardTurnIds ?? []).includes(latch.turnId) &&
    !state.knownTurnIds.includes(latch.turnId)
  ) {
    return "later-turn";
  }
  return null;
}

/**
 * Run the rule at `edge`, or return null when it does not fire.
 *
 * At the `latch` and `transport` edges a fire asks and changes nothing: the
 * row and the card's frames travel apart, so a healthy turn whose row lands
 * first reads like a lost one, and the catch-up the effect asks is a fence
 * a `turn_complete` already on its way is held behind. At the `catch-up`
 * edge a fire ends the cycle: the fence closed with the cycle still
 * standing, so the turn is one the card lost. The cycle is dropped rather
 * than committed, the ids it can be placed by are remembered, and the turn
 * the reading names is marked so the rule ends it only once.
 *
 * The drop itself is the reducer's (`endTurnAsReconciled`), passed in as
 * `endTurn` so this module reads the reducer's types and nothing else of it.
 * The `turn-reconciled` effect is last in the list either way.
 */
export function reconcileTurn(
  state: CodeSessionState,
  edge: ReconcileEdge,
  endTurn: (state: CodeSessionState) => { state: CodeSessionState; effects: Effect[] },
): { state: CodeSessionState; effects: Effect[] } | null {
  const rule = reconcileRule(state);
  if (rule === null) return null;
  const cycle = state.pendingTurn as PendingTurn;
  const latch = state.serverTurn as { active: boolean; turnId: string };
  const action = edge === "catch-up" ? "ended" : "asked";
  const effect: TurnReconciledEffect = {
    kind: "turn-reconciled",
    edge,
    rule,
    action,
    before: {
      phase: state.phase,
      canInterrupt: phaseCanInterrupt(state.phase),
      turnId: cycle.turnId ?? null,
      origin: cycle.origin,
    },
    latch: { active: latch.active, turnId: latch.turnId },
  };
  if (action === "asked") return { state, effects: [effect] };
  const ended = endTurn(state);
  return {
    state: {
      ...ended.state,
      knownTurnIds: rememberTurnIds(state.knownTurnIds, [...cycleTurnIds(cycle), latch.turnId]),
      lastReconciledTurnId: latch.turnId,
    },
    effects: [...ended.effects, effect],
  };
}
