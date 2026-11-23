/**
 * open-docket-in-card.ts — the one implementation behind "show this docket in
 * its card".
 *
 * The shape of `open-commit-in-card.ts`: a card already showing the docket is
 * activated (through `transferFocusForActivation`, so the activation is every
 * other route's) and re-pointed, which is how a named thread gets marked in a
 * card that was already open; otherwise a fresh Docket card is created seeded
 * through `addCard`'s initial content, placed beside the card the gesture was
 * made in. Either way the card that answers flashes ({@link flashCardPane}).
 *
 * Callers: the `open-docket` registry handler in `action-dispatch.ts`.
 *
 * @module lib/open-docket-in-card
 */

import { mayDeferCommitInView, transferFocusForActivation } from "@/focus-transfer";
import type { CardDeck } from "@/card-deck";
import {
  findDocketCardByTarget,
  sameDocketTarget,
  type DocketCardTarget,
} from "./docket-card-open-registry";
import { flashCardPane } from "./flash-pane-border";
import { docketMarkThread } from "../bus/declarations/verbs";
import { page } from "../bus/page";

/** The Docket card's component id. */
export const DOCKET_CARD_COMPONENT_ID = "docket";

/**
 * The Docket card's seed — its restore bag content. An unseeded card (from
 * the type picker) has neither field and asks for a project and a docket;
 * `thread` rides the seed of one open and is never written back.
 */
export interface DocketCardSeed {
  projectDir?: string;
  docketId?: string;
  thread?: string;
}

/**
 * What the card writes back to its bag. Never `thread`: a thread is marked
 * once, by the open that named it, and a reload marks nothing.
 */
export interface DocketCardBag {
  projectDir?: string;
  docketId?: string;
  showRetired?: boolean;
}

/** Narrow an unknown restore bag into the card's seed. */
export function coerceDocketSeed(value: unknown): (DocketCardSeed & DocketCardBag) | null {
  if (typeof value !== "object" || value === null) return null;
  const { projectDir, docketId, thread, showRetired } = value as Record<string, unknown>;
  const seed: DocketCardSeed & DocketCardBag = {};
  if (typeof projectDir === "string" && projectDir.length > 0) seed.projectDir = projectDir;
  if (typeof docketId === "string" && docketId.length > 0) seed.docketId = docketId;
  if (typeof thread === "string" && thread.length > 0) seed.thread = thread;
  if (showRetired === true) seed.showRetired = true;
  return seed;
}

/**
 * What each body Docket card says it shows, by card id, as its page reports
 * it (`docket.shown`). A body card's bag is written by its own page, so the
 * shell's copy is its seed and goes stale the moment the card picks another
 * docket; this record is the shell's live answer, and the bag is read only
 * for a card that has not yet reported.
 */
const shownDockets = new Map<string, { projectDir: string; docketId: string } | null>();

/** Record what a body Docket card shows; null when it shows no docket. */
export function recordShownDocket(
  cardId: string,
  target: { projectDir: string; docketId: string } | null,
): void {
  shownDockets.set(cardId, target);
}

/** Test-only: forget every report. */
export function _resetShownDocketsForTest(): void {
  shownDockets.clear();
}

/**
 * The deck's Docket card already on `target`, found by what its page last
 * reported it shows, or by its bag before it has reported — which covers a
 * card mounted in its own page, where the open registry of this page cannot
 * see it.
 */
export function findDocketCardInDeck(
  store: Pick<CardDeck, "getSnapshot" | "getCardState">,
  target: DocketCardTarget,
): string | null {
  for (const card of store.getSnapshot().cards) {
    if (card.componentId !== DOCKET_CARD_COMPONENT_ID) continue;
    const shown = shownDockets.get(card.id);
    if (shown !== undefined) {
      if (shown !== null && sameDocketTarget(shown, target)) return card.id;
      continue;
    }
    const content = store.getCardState(card.id)?.content;
    if (typeof content !== "object" || content === null) continue;
    const { projectDir, docketId } = content as DocketCardSeed;
    if (typeof projectDir !== "string" || typeof docketId !== "string") continue;
    if (sameDocketTarget({ projectDir, docketId }, target)) return card.id;
  }
  return null;
}

export function openDocketInCard(
  store: CardDeck,
  target: DocketCardTarget,
  originCardId: string | null = null,
): void {
  const existing = findDocketCardByTarget(target);
  const existingId = existing?.cardId ?? findDocketCardInDeck(store, target);
  if (existingId !== null) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existingId,
      store,
      commitMutation: () => store.activateCard(existingId),
      deferCommit: mayDeferCommitInView(existingId),
    });
    if (existing !== null) {
      existing.entry.setTarget(target);
    } else if (target.thread !== undefined && page.isShell) {
      // The card is in its own page, which marks the thread. The bus holds
      // the verb until that page has said hello.
      docketMarkThread.dispatch(
        { projectDir: target.projectDir, docketId: target.docketId, thread: target.thread },
        { card: existingId },
      );
    }
    flashCardPane(store, existingId);
    return;
  }
  const seed: DocketCardSeed = {
    projectDir: target.projectDir,
    docketId: target.docketId,
    ...(target.thread !== undefined ? { thread: target.thread } : {}),
  };
  // Save-before-activation ([L23]): `addCard` activates the fresh card, so
  // the card the gesture was made in banks its focus bag first.
  const outgoing = store.getFirstResponderCardId();
  if (outgoing !== null) store.invokeSaveCallback(outgoing);
  const cardId = store.addCard(DOCKET_CARD_COMPONENT_ID, seed, {
    origin: originCardId ?? outgoing,
  });
  if (cardId !== null) flashCardPane(store, cardId);
}
