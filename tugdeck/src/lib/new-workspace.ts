/**
 * new-workspace.ts — New Workspace, asked through the naming modal.
 *
 * The gesture opens the modal and builds the workspace at once, pending
 * (`DeckManager.beginPendingSpace`): mounted unshown, out of the list and
 * every save, its rail cards' pages asked for hidden while the user reads and
 * types. Nothing on screen changes under the scrim.
 *
 * Cancel and Escape discard it, and it leaves no trace. A committed name is
 * one cut, under the scrim, onto the pages made meanwhile: at once when they
 * have all painted, and otherwise after the modal shows the deck's progress
 * wave in place of its buttons until they have, or until
 * {@link PENDING_PAINT_BOUND_MS}, the reveal set's horizon, at which it cuts
 * regardless. The wait is spent on the old, still picture. Then the question
 * closes, the scrim fades, and the keyboard lands on the new workspace's row
 * in its Workspaces card, at the top of the list.
 *
 * Laws: [L02] the pages' states are read from `bodyCardsStore` by
 * subscription; [L33] the wait is bounded, and a page that never paints
 * delays the cut by the bound and no more.
 *
 * @module lib/new-workspace
 */

import { bodyCardsStore } from "./body-cards-store";
import { cardsSpaceVerbRequest } from "./cards-space-verb-request";
import { askWorkspaceName } from "./workspace-name-request";
import type { IDeckManagerStore } from "../deck-manager-store";
import { nextSpaceName } from "../spaces";

/** How long a committed name waits for the pending pages before it cuts regardless, ms. */
export const PENDING_PAINT_BOUND_MS = 2_000;

/** How a wait for the pending pages ended: painted already, painted during it, or at the bound. */
export type PaintWaitEnding = "painted" | "painted-during-wait" | "bound";

/** What a wait reads. */
export interface PaintWaitDeps {
  /** Whether `cardId`'s page needs no more waiting for. */
  readonly settled: (cardId: string) => boolean;
  /** Hear any page's state change. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Run `fn` after `ms`. Returns the cancel. */
  readonly after: (fn: () => void, ms: number) => () => void;
}

/**
 * Wait for every one of `cardIds` to settle, bounded by `boundMs`.
 *
 * `already` says so synchronously, so a caller whose pages have all painted
 * cuts in the same task and shows no wave; `done` resolves with the ending
 * either way.
 */
export function waitForPaint(
  cardIds: readonly string[],
  deps: PaintWaitDeps,
  boundMs: number = PENDING_PAINT_BOUND_MS,
): { already: boolean; done: Promise<PaintWaitEnding> } {
  const allSettled = (): boolean => cardIds.every(deps.settled);
  if (allSettled()) return { already: true, done: Promise.resolve("painted") };
  const done = new Promise<PaintWaitEnding>((resolve) => {
    let finished = false;
    const finish = (ending: PaintWaitEnding): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      cancel();
      resolve(ending);
    };
    const unsubscribe = deps.subscribe(() => {
      if (allSettled()) finish("painted-during-wait");
    });
    const cancel = deps.after(() => finish("bound"), boundMs);
  });
  return { already: false, done };
}

/**
 * A pending card's page needs no more waiting for once it has painted, or
 * failed — a failed page is not going to paint. A card that is no body card
 * has no page to wait for: the shell draws it.
 */
function pageSettled(cardId: string): boolean {
  if (!bodyCardsStore.has(cardId)) return true;
  const state = bodyCardsStore.stateOf(cardId);
  return state === "painted" || state === "failed";
}

const LIVE_WAIT: PaintWaitDeps = {
  settled: pageSettled,
  subscribe: (listener) => bodyCardsStore.subscribe(listener),
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * New Workspace: build it pending, ask its name, and cut to it when the name
 * is committed, or discard it when it is not. Resolves with the new
 * workspace's id, or `null` when nothing was made.
 *
 * A deck that holds no pending workspace (a page's deck view) asks the name
 * and creates the workspace when it is committed, with nothing made ahead.
 *
 * `pages` is how the wait reads the pending pages: the body cards' store,
 * unless a test hands its own.
 */
export async function newWorkspaceThroughModal(
  store: IDeckManagerStore,
  pages: PaintWaitDeps = LIVE_WAIT,
): Promise<string | null> {
  const begin = store.beginPendingSpace;
  const adopt = store.adoptPendingSpace;
  if (begin === undefined || adopt === undefined) {
    const proposed = nextSpaceName(store.getSpacesSnapshot().spaces.map((s) => s.name));
    const name = await askWorkspaceName("new", proposed);
    return name === null ? null : store.createSpace(name);
  }
  const { id, name: proposed } = begin();
  // Written by the settle, which runs inside the ask.
  const landed: { id: string | null } = { id: null };
  const committed = await askWorkspaceName("new", proposed, (name) => {
    const cardIds = store.getSpaceDeck(id)?.cards.map((c) => c.id) ?? [];
    const wait = waitForPaint(cardIds, pages);
    const cut = (): void => {
      // A New Workspace fired while this one waited on its pages has
      // replaced the pending workspace with its own, under its own question;
      // that one is not this name's to adopt.
      if (store.getSpacesSnapshot().pendingSpaceId !== id) return;
      landed.id = adopt(name);
    };
    if (wait.already) {
      cut();
      return;
    }
    return wait.done.then(cut);
  });
  const adopted = landed.id;
  if (committed === null || adopted === null) {
    // Cancelled, or another question took the modal over. A later New
    // Workspace has already replaced this one's pending workspace with its
    // own, which is not this gesture's to discard.
    if (store.getSpacesSnapshot().pendingSpaceId === id) store.discardPendingSpace?.();
    return null;
  }
  cardsSpaceVerbRequest.request("focus", adopted);
  return adopted;
}
