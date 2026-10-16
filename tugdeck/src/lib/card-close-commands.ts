/**
 * card-close-commands.ts — closing a card, a pane or a workspace from a list
 * of them, run by the shell.
 *
 * The Cards card's row ×, its pane row's × and its workspace delete each
 * destroy cards that are not the Cards card's own, and each has to consult
 * those cards' close guards and reach those cards' responders. Both live in
 * the shell's document: the close guards are a per-page registry, and a
 * card's responder is in the chain of the page that draws it — for a body
 * card, its placeholder in the shell. So the three gestures are commands the
 * shell's chain answers (`close-card`, `close-pane-by-id`,
 * `delete-space-confirmed`), and the
 * Cards card dispatches them from whichever page it is in; a body forwards an
 * unanswered command to the shell.
 *
 * Laws: [L30] (a command is answered by its registered handler, in the page
 * that holds what it acts on), [L33] (a close waits on the guard's answer).
 *
 * @module lib/card-close-commands
 */

import { getResponderChainManager } from "../action-registry";
import { dispatchCommand } from "../command-dispatch";
import { TUG_ACTIONS } from "./action-vocabulary";
import { getCardCloseGuard } from "./card-close-guard";
import { closeGuardWalk } from "./close-guard-walk";
import { getDeckStore } from "./deck-store-registry";

/**
 * Whether closing this card will stop and ask rather than just close — the
 * card's own close guard has unsaved work to raise a Save / Don't Save sheet
 * over. It is asked BEFORE the close is sent, because the answer decides
 * whether the card is fronted first: only a close that puts a question on
 * screen needs the user looking at the card it appears on.
 *
 * The pane's `close-tab` handler consults exactly this guard and nothing else,
 * so the reading here and the behaviour there cannot disagree.
 */
function askedBeforeClosing(cardId: string): boolean {
  return getCardCloseGuard(cardId)?.needsDecision() === true;
}

/**
 * How long a just-activated workspace is given to finish arriving before its
 * cards are asked whether they hold unsaved work. Generous, because the cost
 * of being early is silence where a sheet was owed; a workspace whose cards
 * are all clean spends the whole of it and then deletes. That is a real pause,
 * which is why it is only ever spent on a workspace that was not already
 * mounted — see the delete's own gate.
 */
const ARRIVAL_SETTLE_MS = 2_000;

/**
 * Wait until one of `cardIds` holds unsaved work, or until the budget runs
 * out.
 *
 * Watching the guards rather than counting frames, because what is being
 * waited for is not a render: a card restores its buffer from the bag the
 * park left behind, and that read is asynchronous. A fixed number of frames
 * is a guess about how long a disk read takes, and the first guess was wrong
 * in the direction that loses work.
 *
 * Returning on the FIRST dirty card is not a race the walk can lose. The walk
 * re-resolves every guard as it reaches it, and the cards after the first one
 * are not reached until the user has answered a sheet — which is orders of
 * magnitude longer than the restore this is waiting on.
 */
function awaitArrival(cardIds: readonly string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = performance.now() + ARRIVAL_SETTLE_MS;
    const poll = (): void => {
      const dirty = cardIds.some((id) => askedBeforeClosing(id));
      if (dirty || performance.now() >= deadline) {
        resolve();
        return;
      }
      window.requestAnimationFrame(poll);
    };
    poll();
  });
}

/**
 * Which cards and panes have a stand-up-and-close walk in flight. A second ×
 * on the same row while one is running would activate the workspace twice and
 * send two closes at the card.
 */
const closeWalks = new Set<string>();

/**
 * Close `cardId`, which stands in workspace `spaceId`: `close-tab` carrying the
 * card's own id, walked from that card up to its host pane — the tab ×'s
 * event, so a background tab closes itself rather than its pane's front card,
 * and the close guard stays attached to the card it concerns.
 */
export function closeCard(cardId: string, spaceId: string): void {
  const chain = getResponderChainManager();
  if (chain === null) return;
  const send = (): void => {
    // A card with unsaved work answers this × with a sheet, and the sheet
    // comes up on the card — which may be behind another pane, or be a
    // background tab nobody can see. So front it first, exactly as a plain
    // click on its row would, flash and all. A close that simply happens gets
    // no announcement; the row vanishing is the whole answer.
    if (askedBeforeClosing(cardId)) dispatchCommand("focus-session-card", { cardId });
    chain.sendToTarget(cardId, { action: TUG_ACTIONS.CLOSE_TAB, value: cardId, phase: "discrete" });
  };
  const store = getDeckStore();
  const elsewhere = store !== null && store.getSpacesSnapshot().activeSpaceId !== spaceId;

  // The card is STANDING — in the workspace on screen, or in one left mounted
  // behind it. Its close guard is registered either way, so a close with
  // nothing to ask just happens, wherever the card is. Only a close that puts
  // a QUESTION on screen has to go to the workspace holding it first — a sheet
  // over a hidden layer is a sheet nobody can answer.
  if (chain.hasResponder(cardId)) {
    if (elsewhere && askedBeforeClosing(cardId)) store?.activateSpace(spaceId);
    send();
    return;
  }

  // Nothing is standing. A row can outlive its card by a frame, and in the
  // workspace on screen that is the whole explanation.
  if (!elsewhere || store === null) return;

  // A card in a workspace nobody has stood up this run cannot be ASKED without
  // being stood up: its close guard is registered by the card at mount. So
  // activate, wait for the cards to arrive, then let the pane's own close-tab
  // flow read the guard it now has — a restored buffer with unsaved edits
  // still gets to raise its sheet instead of being taken silently.
  if (closeWalks.has(cardId)) return;
  closeWalks.add(cardId);
  void (async () => {
    try {
      store.activateSpace(spaceId);
      await awaitArrival([cardId]);
      if (!chain.hasResponder(cardId)) return;
      send();
    } finally {
      closeWalks.delete(cardId);
    }
  })();
}

/**
 * Close pane `paneId`, whose front card is `activeCardId`, in workspace
 * `spaceId`: the pane's own X, aimed from a list. `close-pane` goes to the
 * pane's responder, which runs the title bar's close flow whole — save guards,
 * then the confirm. A multi-tab pane always confirms, so this always fronts
 * the pane: the popover it opens is anchored to that pane's X.
 */
export function closePane(paneId: string, activeCardId: string, spaceId: string): void {
  const chain = getResponderChainManager();
  if (chain === null) return;
  const store = getDeckStore();
  const send = (): void => {
    if (!chain.hasResponder(paneId)) return;
    dispatchCommand("focus-session-card", { cardId: activeCardId });
    chain.sendToTarget(paneId, { action: TUG_ACTIONS.CLOSE_PANE, phase: "discrete" });
  };
  // A stack in a workspace that is not on screen is reached by going there
  // first, whether its panes are merely hidden or have never stood up at all.
  if (store !== null && store.getSpacesSnapshot().activeSpaceId !== spaceId) {
    if (closeWalks.has(paneId)) return;
    closeWalks.add(paneId);
    void (async () => {
      try {
        store.activateSpace(spaceId);
        await awaitArrival([activeCardId]);
        send();
      } finally {
        closeWalks.delete(paneId);
      }
    })();
    return;
  }
  send();
}

/**
 * The guard walk a confirmed delete runs is asynchronous — each dirty card
 * gets its own sheet — and a second delete while one stands would put two
 * walks over the same cards.
 */
let deleteWalkRunning = false;

/**
 * Delete workspace `spaceId`, after its cards' close guards are asked.
 *
 * Activate the workspace FIRST, and not as a courtesy: a workspace nobody has
 * visited this run has no mounted cards, so their close guards are not
 * registered and a walk over them would find nothing to ask about and take the
 * unsaved work silently. Activation is also what puts each sheet over its own
 * content.
 *
 * The card ids are read AFTER the activation: `getSpaceDeck` answers with the
 * live deck for the active workspace and with the parked record for any other,
 * and activation is what moves the deck between the two.
 *
 * A `null` walk means no card had anything to ask — the confirm the user
 * already answered was the whole of the decision. A `"cancel"` from any card
 * abandons the delete entirely, and the workspace stays put AND stays active:
 * the user is looking at the card they just declined to discard.
 */
export async function deleteSpace(spaceId: string): Promise<void> {
  if (deleteWalkRunning) return;
  const store = getDeckStore();
  if (store === null) return;
  deleteWalkRunning = true;
  try {
    const arriving = store.getSpacesSnapshot().activeSpaceId !== spaceId;
    // Whether the workspace's cards are ALREADY standing: a visited workspace
    // stays mounted while the canvas hides it, so its guards are registered
    // and there is nothing to wait for. Read before the activation, which is
    // what would otherwise make every workspace look mounted.
    const wasMounted = store.getSpacesSnapshot().mountedSpaceIds.includes(spaceId);
    if (arriving) store.activateSpace(spaceId);
    const cardIds = (store.getSpaceDeck(spaceId)?.cards ?? []).map((card) => card.id);
    // `activateSpace` commits the deck synchronously, but a card mounts on the
    // next render and restores its buffer after that — so a walk run in this
    // same tick asks a registry that has not heard of these cards. Only a
    // workspace being stood up for the first time this run is waited on.
    if (arriving && !wasMounted) await awaitArrival(cardIds);
    const decision = closeGuardWalk(
      cardIds,
      (id) => dispatchCommand("focus-session-card", { cardId: id }),
      // Nothing here tracks which card is front, so every dirty card is
      // fronted before its sheet; fronting the front card is a no-op.
      () => false,
    );
    if (decision !== null && (await decision()) === "cancel") return;
    store.deleteSpace(spaceId);
  } finally {
    deleteWalkRunning = false;
  }
}
