/**
 * body-make-ahead — pages for parked workspaces' cards, made while nothing
 * else is loading, so a switch onto one lands at once and its skeletons are
 * seldom seen.
 *
 * Once every page the shell has asked for has painted and a moment has
 * passed with nothing moving, the shell takes the next parked workspace —
 * the most recently shown first, then those never shown this run in the
 * list's order — and makes it ahead: mounted unshown, so its panes render in
 * their hidden layer; then, at the next quiet moment, its cards are handed
 * off as the shell hands off the shown deck's, and their pages are asked
 * for at once. The host makes them hidden, through its lane,
 * behind any card the user can see, and declares each dormant as it paints.
 * One workspace at a time, so a pass never queues more than one
 * workspace's pages in front of the user's next gesture.
 *
 * A parked card whose page the host's clock evicted (`hidden`) is made again
 * the same way. One that memory pressure took is not: pressure is the
 * governor, and a machine short of memory gets the skeletons.
 *
 * A pending workspace — one New Workspace has built while the naming modal
 * asks for its name — is not in the list's order and waits for no quiet
 * moment. It is mounted unshown from the start, and its cards are handed off
 * and their pages asked for the moment it appears, beside whatever else is
 * loading, so they have painted, or nearly, by the time the name is
 * committed and the deck cuts to it.
 *
 * A bound Session card is not made ahead. Its page is made by the session
 * restore pass when its workspace is first shown, which decides whether it
 * resumes or spawns, and a page made ahead of that pass would be handed the
 * pass's decision afterwards and spawn a second session. It shows its
 * skeleton on its workspace's first visit, as before.
 *
 * Laws: [L02] the stores are read by subscription; [L33] nothing waits on
 * a page made ahead, and a pass that finds nothing to do does nothing.
 *
 * @module lib/body-make-ahead
 */

import { bodyCardsStore, type BodyCardState } from "./body-cards-store";
import type { IDeckManagerStore } from "../deck-manager-store";

/** How long nothing must move before a pass makes anything ahead, ms. */
export const MAKE_AHEAD_QUIET_MS = 1_000;

/** What a pass reads. */
export interface AheadFacts {
  readonly activeSpaceId: string;
  /** Every space, in the list's order. */
  readonly spaceOrder: readonly string[];
  /** Spaces shown this run, the most recent first. */
  readonly recency: readonly string[];
  /** The spaces React holds mounted. */
  readonly mounted: ReadonlySet<string>;
  /** Every body card: its space, its state, and whether the host's clock evicted it. */
  readonly cards: readonly { cardId: string; spaceId: string | null; state: BodyCardState | null; timeEvicted: boolean }[];
  /** Parked cards not yet body cards that the shell may hand off itself: a mount kind, or an unbound Session card. */
  readonly unhanded: readonly { cardId: string; spaceId: string }[];
}

/** What a pass does: mount a space ahead, ask for its cards' pages, or nothing. */
export type AheadAct = { kind: "mount"; spaceId: string } | { kind: "make"; spaceId: string; cardIds: string[] } | null;

/** The parked spaces in the order they are made ahead. */
export function aheadOrder(f: Pick<AheadFacts, "activeSpaceId" | "spaceOrder" | "recency">): string[] {
  const known = new Set(f.spaceOrder);
  const recent = f.recency.filter((id) => known.has(id));
  const rest = f.spaceOrder.filter((id) => !recent.includes(id));
  return [...recent, ...rest].filter((id) => id !== f.activeSpaceId);
}

/** The next thing to make ahead, or null while a page is loading or nothing is left. */
export function nextAhead(f: AheadFacts): AheadAct {
  if (f.cards.some((c) => c.state === "creating" || c.state === "ready")) return null;
  for (const spaceId of aheadOrder(f)) {
    if (!f.mounted.has(spaceId)) return { kind: "mount", spaceId };
    const cardIds = cardsToMake(f, spaceId);
    if (cardIds.length > 0) return { kind: "make", spaceId, cardIds };
  }
  return null;
}

/**
 * What to make for the pending workspace, at once: every card of it not yet
 * asked for, whatever else is loading. Null with none pending, or with
 * nothing of it left to ask for.
 */
export function pendingAhead(f: AheadFacts, pendingSpaceId: string | undefined): AheadAct {
  if (pendingSpaceId === undefined || !f.mounted.has(pendingSpaceId)) return null;
  const cardIds = cardsToMake(f, pendingSpaceId);
  return cardIds.length > 0 ? { kind: "make", spaceId: pendingSpaceId, cardIds } : null;
}

/** A mounted space's cards whose pages are still to be asked for. */
function cardsToMake(f: AheadFacts, spaceId: string): string[] {
  return [
    ...f.unhanded.filter((c) => c.spaceId === spaceId).map((c) => c.cardId),
    ...f.cards
      .filter((c) => c.spaceId === spaceId && (c.state === "unmade" || (c.state === "evicted" && c.timeEvicted)))
      .map((c) => c.cardId),
  ];
}

/** What the shell hands the pass. */
export interface MakeAheadDeps {
  readonly deck: IDeckManagerStore;
  /** Whether the shell hands `cardId` off itself, and with what: a mount kind or an unbound Session card. */
  readonly handable: (cardId: string, componentId: string) => boolean;
  /** Hand `cardId` off; it stands `unmade` until {@link release}. */
  readonly handOff: (cardId: string, componentId: string) => void;
  /** Ask for an unmade card's page with the intent it was handed. */
  readonly release: (cardId: string) => void;
  /** Ask for an evicted card's page again. */
  readonly askAgain: (cardId: string) => void;
  /** Cards the host's clock evicted while hidden; the pass removes those it asks for. */
  readonly timeEvicted: Set<string>;
}

/** Make parked workspaces ahead from here on. Returns the uninstall. */
export function installMakeAhead(deps: MakeAheadDeps): () => void {
  const { deck } = deps;
  const mountAhead = deck.mountSpaceAhead;
  if (mountAhead === undefined) return () => {};
  const recency: string[] = [deck.getSpacesSnapshot().activeSpaceId];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const facts = (): AheadFacts => {
    const spaces = deck.getSpacesSnapshot();
    const unhanded: { cardId: string; spaceId: string }[] = [];
    for (const spaceId of spaces.mountedSpaceIds) {
      if (spaceId === spaces.activeSpaceId) continue;
      for (const card of deck.getSpaceDeck(spaceId)?.cards ?? []) {
        if (!bodyCardsStore.has(card.id) && deps.handable(card.id, card.componentId)) unhanded.push({ cardId: card.id, spaceId });
      }
    }
    return {
      activeSpaceId: spaces.activeSpaceId,
      spaceOrder: spaces.spaces.map((s) => s.id),
      recency,
      mounted: new Set(spaces.mountedSpaceIds),
      cards: bodyCardsStore.cardIds().map((cardId) => ({
        cardId,
        spaceId: deck.spaceOf(cardId),
        state: bodyCardsStore.stateOf(cardId),
        timeEvicted: deps.timeEvicted.has(cardId),
      })),
      unhanded,
    };
  };

  const make = (act: { spaceId: string; cardIds: string[] }): void => {
    const kinds = new Map((deck.getSpaceDeck(act.spaceId)?.cards ?? []).map((c) => [c.id, c.componentId]));
    for (const cardId of act.cardIds) {
      if (!bodyCardsStore.has(cardId)) {
        const componentId = kinds.get(cardId);
        if (componentId === undefined) continue;
        deps.handOff(cardId, componentId);
      }
      if (bodyCardsStore.stateOf(cardId) === "unmade") {
        deps.release(cardId);
      } else if (bodyCardsStore.stateOf(cardId) === "evicted") {
        deps.timeEvicted.delete(cardId);
        deps.askAgain(cardId);
      }
    }
  };

  const pass = (): void => {
    timer = null;
    // A card that is no longer evicted has no eviction to answer.
    for (const cardId of deps.timeEvicted) {
      if (bodyCardsStore.stateOf(cardId) !== "evicted") deps.timeEvicted.delete(cardId);
    }
    const act = nextAhead(facts());
    if (act === null) return;
    if (act.kind === "mount") {
      mountAhead(act.spaceId);
      return;
    }
    make(act);
  };

  /** Anything moved: the pass waits for a quiet moment again. */
  const moved = (): void => {
    const spaces = deck.getSpacesSnapshot();
    const active = spaces.activeSpaceId;
    if (recency[0] !== active) {
      const at = recency.indexOf(active);
      if (at >= 0) recency.splice(at, 1);
      recency.unshift(active);
    }
    // The pending workspace is made now, not at the next quiet moment.
    if (spaces.pendingSpaceId !== undefined) {
      const act = pendingAhead(facts(), spaces.pendingSpaceId);
      if (act !== null && act.kind === "make") make(act);
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(pass, MAKE_AHEAD_QUIET_MS);
  };

  const unsubscribes = [bodyCardsStore.subscribe(moved), deck.subscribeSpaces(moved)];
  moved();
  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
