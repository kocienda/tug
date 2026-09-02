/**
 * CardSessionBindingStore — per-card session binding for workspace filter routing.
 *
 * Maps `cardId → { tugSessionId, workspaceKey, projectDir }`. The binding is
 * populated from the `spawn_session_ok` CONTROL ack (where tugcast echoes the
 * canonical `workspace_key`) and consumed by `useCardWorkspaceKey`, which
 * `TugPane` uses to build its `FeedStore` workspace-value filter.
 *
 * **Laws:** [L02] External state enters React through `useSyncExternalStore`
 * only — this store exposes `subscribe + getSnapshot` and is read via
 * `useCardWorkspaceKey`, never through component state.
 *
 * @module lib/card-session-binding-store
 */

import { useCallback, useSyncExternalStore } from "react";

import { sessionLineStore } from "./session-line-store";

/**
 * User's choice of session mode when the card was opened. Populated from
 * the `spawn_session_ok` CONTROL ack, which echoes the value tugdeck sent
 * on `spawn_session`. "new" matches the fresh-by-default behavior of
 * the fresh-by-default behavior; "resume" carries the explicit
 * resume intent.
 */
export type CardSessionMode = "new" | "resume";

/** The dash a session is working on, as the server names it. */
export interface CardDashBinding {
  /** The dash's owner key — opaque identity, never a git ref. */
  readonly id: string;
  /** The dash's short name, for display. */
  readonly name: string;
}

export interface CardSessionBinding {
  readonly tugSessionId: string;
  /**
   * The line of work this card is seated on ([P01]). `tugSessionId` beside it
   * is whichever segment is live right now and changes on every rotation,
   * rewind, and respawn; this does not. Every identity-shaped store the card
   * reads — name, callsign, synopsis, staged context, `/btw` history — is
   * keyed by it.
   */
  readonly lineId: string;
  readonly workspaceKey: string;
  /**
   * The segment the card is seated on **right now**, when the server has said
   * it moved. Absent until it does, which is every card before its first
   * rotation.
   *
   * Beside {@link CardSessionBinding.tugSessionId} rather than replacing it,
   * and the distinction is load-bearing. `tugSessionId` is the card's
   * **address**: every frame the card sends is stamped with it, and
   * `CardServicesStore` keys its whole services bag on it — moving it would
   * tear that bag down mid-stage and rebuild it around an id the supervisor
   * does not answer to. The seat is what *identity* resolves through: the dash
   * a live card is on is recorded against whichever segment holds the binding
   * now, which a rotation moves.
   *
   * Written only by `session_line_seated`, which the bridge sends when the
   * card's claude id changes on a line it already had. Never derived: a
   * rotation leaves the retired segment's row `live` as well, so "the newest
   * live row on this line" is a race rather than an answer ([P01]).
   */
  readonly seatedSessionId?: string;
  readonly projectDir: string;
  readonly sessionMode: CardSessionMode;
  /** The dash this card's session is mated to, or absent when unbound. */
  readonly dash?: CardDashBinding;
}

export class CardSessionBindingStore {
  private _bindings: Map<string, CardSessionBinding> = new Map();
  private _listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): Map<string, CardSessionBinding> => this._bindings;

  getBinding = (cardId: string): CardSessionBinding | undefined =>
    this._bindings.get(cardId);

  setBinding = (cardId: string, binding: CardSessionBinding): void => {
    const next = new Map(this._bindings);
    next.set(cardId, binding);
    this._bindings = next;
    for (const listener of this._listeners) listener();
  };

  /**
   * Set or clear only the dash half of a card's binding, **merging** into the
   * existing record.
   *
   * A merge and not a `setBinding`: a bind can arrive mid-session (a skill
   * running `tugtool arc bind`, or a `bind_dash_ok` broadcast), and replacing
   * the whole record there would clobber the `workspaceKey` the spawn ack
   * established — the value `useCardWorkspaceKey` builds the pane's feed
   * filter from.
   *
   * A no-op for a card with no binding: there is nothing to merge into, and
   * the spawn ack stays the only thing allowed to *create* a record. It is no
   * longer the only thing allowed to write one — `bind_dash_ok` moves the dash
   * half, which is what carries a rotation's binding onto the fresh segment.
   */
  setDashBinding = (cardId: string, dash: CardDashBinding | null): void => {
    const existing = this._bindings.get(cardId);
    if (!existing) return;
    const next = new Map(this._bindings);
    next.set(cardId, { ...existing, dash: dash ?? undefined });
    this._bindings = next;
    for (const listener of this._listeners) listener();
  };

  /**
   * Re-seat a card's binding on a **new line** ([P03]) — the `/clear` case,
   * where a plain `/new` births a line rather than joining the card's. A merge
   * like {@link CardSessionBindingStore.setDashBinding}: the spawn ack
   * established the `workspaceKey` the pane's feed filter is built from, and
   * replacing the record here would clobber it.
   *
   * A no-op for a card with no binding, for the same reason: the spawn ack is
   * the only thing allowed to create a record.
   */
  setLineBinding = (cardId: string, tugSessionId: string, lineId: string): void => {
    const existing = this._bindings.get(cardId);
    if (!existing) return;
    if (existing.tugSessionId === tugSessionId && existing.lineId === lineId) return;
    const next = new Map(this._bindings);
    next.set(cardId, { ...existing, tugSessionId, lineId });
    this._bindings = next;
    for (const listener of this._listeners) listener();
  };

  /**
   * Move a card's **seat** onto a fresh segment of the line it already has —
   * the rotation case, and a merge for the same reason the two above are.
   *
   * The card's address is untouched, deliberately: `CardServicesStore` keys the
   * whole services bag on `tugSessionId`, so writing it here would tear that
   * bag down and rebuild it mid-stage around an id the supervisor does not
   * answer to. What moves is the identity every live read resolves through.
   *
   * The line comes with it because the server knows it and the ack may not
   * have: a resume of a row the ledger had not yet birthed a line for is acked
   * with none, and the binding has been carrying a line of one ever since.
   *
   * A no-op for a card with no binding, and for a seat that has not moved.
   */
  setSeatedSegment = (cardId: string, tugSessionId: string, lineId: string): void => {
    const existing = this._bindings.get(cardId);
    if (!existing) return;
    if (existing.seatedSessionId === tugSessionId && existing.lineId === lineId) return;
    const next = new Map(this._bindings);
    next.set(cardId, { ...existing, seatedSessionId: tugSessionId, lineId });
    this._bindings = next;
    for (const listener of this._listeners) listener();
  };

  clearBinding = (cardId: string): void => {
    if (!this._bindings.has(cardId)) return;
    const next = new Map(this._bindings);
    next.delete(cardId);
    this._bindings = next;
    for (const listener of this._listeners) listener();
  };

  /**
   * Drop every binding in a single notify. Used by the reconnect handler
   * after a WebSocket re-open: bindings without a live server peer are
   * worse than no bindings, so the new resume frames go out against an
   * empty store. Per [D04] in
   * `dash/tugplan-session-connection-health.md`, the clear-then-restore
   * order is part of the contract. A no-op when the store is already
   * empty so the first reconnect after a fresh boot does not emit a
   * spurious notify.
   */
  clearAll = (): void => {
    if (this._bindings.size === 0) return;
    this._bindings = new Map();
    for (const listener of this._listeners) listener();
  };
}

/** Module-scope singleton — mirrors FeedStore's usage shape. */
export const cardSessionBindingStore = new CardSessionBindingStore();

/**
 * The card currently bound to `sessionId`, or `null` when none is open — the
 * reverse of {@link CardSessionBindingStore.getBinding}, and the one place that
 * walk lives.
 *
 * **Matched by line first.** A reference names a segment — a citation chip, an
 * Overview ref, a push about a row — and the card holding that conversation may
 * well have rotated to a newer id since. Resolving the segment to its line and
 * comparing lines is what keeps "go to that session" landing on the card the
 * user is actually working in; the direct id match remains for a segment whose
 * line no frame has named this run.
 *
 * The store is keyed by card because that is the direction the feed plumbing
 * reads it; a session reference needs the other direction, and the walk is
 * cheap (a deck holds a handful of cards). Every "go to that session" gesture
 * in the app — a Overview ref, a citation chip — asks this, so it answers once
 * rather than in each caller.
 */
export function cardIdForSession(sessionId: string): string | null {
  const lineId = sessionLineStore.lineOf(sessionId);
  for (const [cardId, binding] of cardSessionBindingStore.getSnapshot()) {
    if (binding.tugSessionId === sessionId) return cardId;
    if (lineId !== null && binding.lineId === lineId) return cardId;
  }
  return null;
}

/**
 * The card seated on `lineId`, or `null` when no open card wears it.
 *
 * The direct half of {@link cardIdForSession}, for a frame that already names
 * the line rather than leaving it to be derived. The rotation seat's
 * `bind_dash_ok` does: it announces a segment minted in the same breath, which
 * the segment → line walk cannot resolve because no frame has yet said whose
 * line that segment is.
 */
export function cardIdForLine(lineId: string): string | null {
  for (const [cardId, binding] of cardSessionBindingStore.getSnapshot()) {
    if (binding.lineId === lineId) return cardId;
  }
  return null;
}

/**
 * The subscribed form, for a component deciding whether to *offer* the gesture
 * ([L02]). A chip that reads this unsubscribed would keep offering a click into
 * a card that has since closed, or withhold one from a card that has since
 * opened.
 */
export function useCardIdForSession(sessionId: string): string | null {
  return useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(() => cardIdForSession(sessionId), [sessionId]),
  );
}

/**
 * The line `cardId` is working on, as the **server** last said — falling back
 * to the one its bind ack settled.
 *
 * Not simply `binding.lineId`, and the difference is what the postmortem cost.
 * `lineId` on the binding is whatever the *spawn ack* carried, and a resume of
 * a session the ledger has no row for yet carries none — so it falls back to
 * the session's own id ([`identityKeyForSession`]), a line of one. The ledger
 * then births the real line and every `session_updated` push names it, which
 * the line store records and the binding, written once, never hears. Left
 * there the card holds a line nothing else in the system uses: its seat cannot
 * move, its name cannot resolve, and its dash cannot be found.
 *
 * So the binding's value is the *seed* and the line store is the authority,
 * which is the same rule every other identity read follows ([P02]).
 */
export function cardLine(cardId: string): string | null {
  const binding = cardSessionBindingStore.getBinding(cardId);
  if (binding === undefined) return null;
  return sessionLineStore.lineOf(binding.tugSessionId) ?? binding.lineId;
}

/**
 * The segment `cardId` is seated on **right now**, or `null` when no card of
 * that name holds a binding.
 *
 * The announced seat when the server has moved it, the card's address
 * otherwise — the two being the same string for every card before its first
 * rotation, which is why five workstreams of tests could not tell them apart.
 *
 * **Read, not derived**, and the first version of this was derived. It composed
 * card → line → the line store's seat, which is "whichever frame seated that
 * line last" — and a rotation leaves *two* live rows on the line, since the
 * retired segment's row stays `live` until the card closes, so a later push
 * about the older one moved the answer backwards. `at0503` is where that
 * showed: a card bound directly to its stage read back as the root. A card's
 * seat is now announced (`session_line_seated`) and a line's is left inferred,
 * because only the server holds all three of card, segment, and line at once.
 */
export function cardSeatedSegment(cardId: string): string | null {
  const binding = cardSessionBindingStore.getBinding(cardId);
  if (binding === undefined) return null;
  return binding.seatedSessionId ?? binding.tugSessionId;
}

/**
 * The segment `sessionId`'s conversation is seated on right now — `sessionId`
 * itself when no card holds it, or when no seat has moved.
 *
 * The same answer as {@link cardSeatedSegment} for a caller holding a session
 * id rather than a card: a citation chip, an Overview ref, a telemetry row
 * reading `CodeSessionSnapshot.tugSessionId` — which is the card's address, and
 * so is exactly the id a rotation leaves behind. Routed through
 * {@link cardIdForSession} rather than through the line store's seat, for the
 * reason given above: a card's own seat is announced, a line's is inferred.
 */
export function seatedSegmentForSession(sessionId: string): string {
  const cardId = cardIdForSession(sessionId);
  if (cardId === null) return sessionId;
  return cardSeatedSegment(cardId) ?? sessionId;
}
