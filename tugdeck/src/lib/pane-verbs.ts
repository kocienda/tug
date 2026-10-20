/**
 * pane-verbs — what a pane's chrome asks of the deck, as plain functions.
 *
 * The title bar and the tab bar act on the arrangement: a tab selected or
 * closed, the pane closed, a width preset, Fill Height, bullseye, a column
 * split or stacked, the active card moved to another workspace, a pane of
 * the place raised. `TugPane` and `DeckCanvas` call these for a pane the
 * shell draws, and `body-shell.ts` calls the same ones for the chrome a
 * card's page draws, so the two cannot answer one gesture differently.
 *
 * The pane-addressed acts go out as registered commands rather than as store
 * calls ([L30]): the command names the pane, so it is right however the
 * press reached here.
 *
 * @module lib/pane-verbs
 */

import { TUG_ACTIONS } from "../components/tugways/action-vocabulary";
import { dispatchCommand } from "../command-dispatch";
import type { IDeckManagerStore } from "../deck-manager-store";
import { mayDeferCommit, transferFocusForActivation } from "../focus-transfer";
import type { DeckState } from "../layout-tree";
import { panePlaceFactsOf } from "../components/chrome/pane-place-facts";
import { getCardCloseGuard } from "./card-close-guard";
import { refuseCardModalHold } from "./card-modal-hold-store";
import { resolvePlacement, type ContentWidth } from "./layout-imposer";

/**
 * The pane a chrome verb from `sender`'s page acts on: the pane holding
 * `sender`, or null when no pane does or when `target` — a card the verb
 * names — is not one of that pane's. A page draws its own pane's chrome, so
 * it never names a card of another.
 */
export function paneVerbAddress(state: DeckState, sender: string, target?: string): string | null {
  const pane = state.panes.find((p) => p.cardIds.includes(sender));
  if (pane === undefined) return null;
  if (target !== undefined && !pane.cardIds.includes(target)) return null;
  return pane.id;
}

/** The card to raise for the picker row naming `entryPaneId` in `paneId`'s place, or null when the place holds no such row. */
export function stackEntryCardOf(state: DeckState, paneId: string, entryPaneId: string): string | null {
  return panePlaceFactsOf(state, paneId).slotStack.find((e) => e.paneId === entryPaneId)?.cardId ?? null;
}

/** Set `paneId` to a width preset. */
export function setPaneWidth(paneId: string, preset: ContentWidth): void {
  dispatchCommand(TUG_ACTIONS.SET_CARD_WIDTH, { paneId, preset });
}

/** Make `paneId` fill its slot's height again. */
export function fillPaneHeight(paneId: string): void {
  dispatchCommand(TUG_ACTIONS.FILL_CARD_HEIGHT, { paneId });
}

/**
 * Put `paneId` in bullseye, or take it out. The press lands after the title
 * bar's own activation, so by the time the command runs the pane is the
 * selection and the derived accessor can read the posture back.
 */
export function togglePaneBullseye(paneId: string): void {
  dispatchCommand(TUG_ACTIONS.SET_BULLSEYE, { paneId });
}

/** Split, stack or equalize the column at `slot`. */
export function arrangePlace(slot: number, verb: "split" | "stack" | "equalize"): void {
  if (verb === "equalize") {
    dispatchCommand(TUG_ACTIONS.EQUALIZE_COLUMN, { slot });
    return;
  }
  dispatchCommand(TUG_ACTIONS.SET_COLUMN_MODE, { slot, mode: verb });
}

/** The slot `paneId` stands in, as the imposer clamps it, or null for a pane in none. */
export function placeSlotOf(state: DeckState, paneId: string): number | null {
  const kind = state.imposition.kind;
  const slot = state.panes.find((p) => p.id === paneId)?.slot;
  if (kind === undefined || slot === undefined) return null;
  return resolvePlacement(kind, slot).slot;
}

/**
 * Move `paneId`'s active card — the one its title bar names — to the
 * workspace `spaceId`. The move does not follow the card, so the active
 * workspace stays where it is.
 */
export function moveActiveCardToSpace(deck: IDeckManagerStore, paneId: string, spaceId: string): void {
  const pane = deck.getSnapshot().panes.find((p) => p.id === paneId);
  if (pane === undefined) return;
  deck.moveCardToSpace(pane.activeCardId, spaceId);
}

/**
 * Raise the pane whose active card is `cardId`: a row of the place badge's
 * picker. A bare `activateCard` would flip the first responder and skip the
 * focus transfer, so the outgoing card would never save its focus bag and
 * the incoming one never receive its claim.
 */
export function revealStackEntry(deck: IDeckManagerStore, cardId: string): void {
  transferFocusForActivation({
    outgoingCardId: deck.getFirstResponderCardId(),
    incomingCardId: cardId,
    store: deck,
    commitMutation: () => deck.activateCard(cardId),
    deferCommit: mayDeferCommit(deck, cardId),
  });
}

/**
 * Make `cardId` the active tab of `paneId`, through the focus transfer: the
 * outgoing tab saves its focus bag, and the incoming one's claim lands after
 * the switch has committed.
 */
export function selectTab(deck: IDeckManagerStore, paneId: string, cardId: string): void {
  transferFocusForActivation({
    outgoingCardId: deck.getSnapshot().panes.find((p) => p.id === paneId)?.activeCardId ?? null,
    incomingCardId: cardId,
    store: deck,
    commitMutation: () => deck.setActiveCardInPane(paneId, cardId),
  });
}

/** The panes whose tab close guard is running, so a double-click on a × does not stack two sheets. */
const closeTabGuardRunning = new Set<string>();

/**
 * Close the tab of `cardId` in `paneId`. A card held by a modal run stays,
 * and its holder speaks the refusal. A card with a close guard is asked; a
 * dirty background tab is visited first, so the decision is made looking at
 * the buffer it concerns. A card with none closes at once.
 */
export function closeTab(deck: IDeckManagerStore, paneId: string, cardId: string): void {
  if (refuseCardModalHold(cardId)) return;
  const guard = getCardCloseGuard(cardId);
  if (!guard) {
    deck.removeCard(paneId, cardId);
    return;
  }
  if (closeTabGuardRunning.has(paneId)) return;
  closeTabGuardRunning.add(paneId);
  const activeCardId = deck.getSnapshot().panes.find((p) => p.id === paneId)?.activeCardId;
  if (guard.needsDecision() && activeCardId !== cardId) selectTab(deck, paneId, cardId);
  void guard.run().then((decision) => {
    closeTabGuardRunning.delete(paneId);
    if (decision === "close") deck.removeCard(paneId, cardId);
  });
}

/** Close the whole of `paneId`: the title bar's ×, its confirm already answered. */
export function closePane(deck: IDeckManagerStore, paneId: string): void {
  deck.handlePaneClosed(paneId);
}
