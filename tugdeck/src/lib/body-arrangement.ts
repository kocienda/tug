/**
 * The shell's arrangement, as a body that lists or moves the whole deck
 * reads it.
 *
 * A card whose registration says `bodyDeck: "arrangement"` — the Cards card,
 * the Layout card — reads more than its own card: every pane, every
 * workspace, the band's width, and the session identity and title of every
 * card it lists. In the shell those are the deck's and the app stores'; in a
 * body they are not there at all. So the shell projects them into the card's
 * own `card-context` ({@link projectArrangement}), and the body's deck bridge
 * answers the card's reads from it ({@link arrangementSnapshot} and the
 * spaces fields).
 *
 * What such a card asks of the deck goes back as `deck-call` advice, which
 * the shell runs only for a method in {@link BODY_DECK_CALLS}. Deleting a
 * workspace is not one of them: a raw delete would skip the close-guard
 * walk, so it is a registered command the shell answers instead.
 *
 * Everything here is plain JSON over plain data.
 *
 * @module lib/body-arrangement
 */

import type { DeckState } from "../layout-tree";
import type { CardIdentityFacts } from "../card-registry";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { CardSessionBinding } from "./card-session-binding-store";
import type { CardMastheadPayload } from "./card-title-store";
import type { CardBinding } from "../protocol";

/** A card's title override and masthead, as the shell's title store holds them. */
export interface ArrangementTitle {
  title: string | null;
  masthead: CardMastheadPayload | null;
}

/** Every workspace, as an arrangement card lists them. */
export interface ArrangementSpaces {
  activeSpaceId: string;
  spaces: Array<{ id: string; name: string; theme?: string }>;
  mountedSpaceIds: string[];
  /** Every workspace's deck but the active one's, which is `deck`. */
  decks: Record<string, DeckState>;
  /** `spaceHoldsLiveSessions`, per workspace. */
  liveSessions: Record<string, number>;
  /** `spaceCardCount`, per workspace. */
  cardCounts: Record<string, number>;
}

/** The `card-context` field an arrangement body reads the deck from. */
export interface BodyArrangement {
  deck: DeckState;
  spaces: ArrangementSpaces;
  bandWidth: number | null;
  columnRunHeight: number | null;
  railRunHeight: number | null;
  /** The shell's session binding for each card the arrangement holds. */
  bindings: Record<string, CardSessionBinding>;
  /** The shell's title and masthead for each card the arrangement holds. */
  titles: Record<string, ArrangementTitle>;
  /**
   * What each card the arrangement holds is, as the shell resolves it live —
   * its own open registries for a card it draws, a body's published facts for
   * a body card — for each card that resolves live at all.
   */
  identities: Record<string, CardIdentityFacts>;
  /**
   * The session phase key each card's body last reported to the shell
   * (`card-facts` `activity`), for each card whose body has reported one.
   * The page reading this builds no session store for any card but its own,
   * so this is where the Layout and Workspaces bodies read the live dot for
   * every other card from ([B06]).
   */
  activities: Record<string, string>;
  /**
   * A workspace verb the shell's menu or a chord asked the Cards card to
   * answer (`cardsSpaceVerbRequest` in the shell), until a Cards body has been
   * sent it. Its `token` tells a fresh request from one already answered.
   */
  spaceVerb?: { verb: "rename" | "delete"; spaceId: string; token: number } | null;
  /**
   * The shell's layout selection, for the Cards card, whose list builds it in
   * its own page while the deck's verbs read the shell's
   * (`lib/cards-selection-mirror.ts`).
   */
  selection?: { ids: string[]; anchorId: string | null };
  /**
   * The shell's cache of the server's card bindings (`spaceBindingsLedgerStore`),
   * for the Cards card, which lists every card's session — a parked
   * workspace's included — and whose page may have come up after the frame
   * that filled it. Null until the shell's cache has loaded.
   */
  ledgerBindings?: CardBinding[] | null;
}

/**
 * The deck methods an arrangement body may call, and no others. The shell
 * drops a `deck-call` naming anything else.
 */
export const BODY_DECK_CALLS = [
  "activateCard",
  "setFlowOffset",
  "previewFlowOffset",
  "activateSpace",
  "renameSpace",
  "chooseSpaceTheme",
  "moveCardToSpace",
  "reorderSpaces",
] as const;

export type BodyDeckCall = (typeof BODY_DECK_CALLS)[number];

/** Whether `method` is one a body may call. */
export function isBodyDeckCall(method: string): method is BodyDeckCall {
  return (BODY_DECK_CALLS as readonly string[]).includes(method);
}

/** What {@link projectArrangement} reads from the shell's deck. */
export type ArrangementDeck = Pick<
  IDeckManagerStore,
  | "getSnapshot"
  | "getSpacesSnapshot"
  | "getSpaceDeck"
  | "spaceHoldsLiveSessions"
  | "spaceCardCount"
  | "getBandWidth"
  | "getColumnRunHeight"
  | "getRailRunHeight"
>;

/**
 * Every card the arrangement holds — every workspace's — in a stable order.
 */
export function arrangementCardIds(deck: ArrangementDeck): string[] {
  const spacesSnapshot = deck.getSpacesSnapshot();
  const states: DeckState[] = [deck.getSnapshot()];
  for (const space of spacesSnapshot.spaces) {
    if (space.id === spacesSnapshot.activeSpaceId) continue;
    const parked = deck.getSpaceDeck(space.id);
    if (parked !== null) states.push(parked);
  }
  const cardIds = new Set<string>();
  for (const state of states) for (const card of state.cards) cardIds.add(card.id);
  return [...cardIds];
}

/**
 * The reported phase of every card the arrangement holds that has one —
 * what {@link projectArrangement} fills `activities` with, and what the
 * shell compares to resend a body's context only when some card's phase
 * moved, rather than on every telemetry tick a body publishes.
 */
export function projectActivities(
  deck: ArrangementDeck,
  activities: (cardId: string) => string | null,
): Record<string, string> {
  const reported: Record<string, string> = {};
  for (const cardId of arrangementCardIds(deck)) {
    const key = activities(cardId);
    if (key !== null) reported[cardId] = key;
  }
  return reported;
}

/**
 * The shell's arrangement now. `bindings`, `titles`, `identities` and
 * `activities` are read for the cards the arrangement holds — every
 * workspace's — and nothing else.
 */
export function projectArrangement(
  deck: ArrangementDeck,
  bindings: (cardId: string) => CardSessionBinding | undefined,
  titles: (cardId: string) => ArrangementTitle | null,
  identities: (cardId: string) => CardIdentityFacts | null,
  activities: (cardId: string) => string | null,
): BodyArrangement {
  const live = deck.getSnapshot();
  const spacesSnapshot = deck.getSpacesSnapshot();
  const decks: Record<string, DeckState> = {};
  const liveSessions: Record<string, number> = {};
  const cardCounts: Record<string, number> = {};
  for (const space of spacesSnapshot.spaces) {
    liveSessions[space.id] = deck.spaceHoldsLiveSessions(space.id);
    cardCounts[space.id] = deck.spaceCardCount(space.id);
    if (space.id === spacesSnapshot.activeSpaceId) continue;
    const parked = deck.getSpaceDeck(space.id);
    if (parked !== null) decks[space.id] = parked;
  }
  const cardIds = arrangementCardIds(deck);
  const boundCards: Record<string, CardSessionBinding> = {};
  const titledCards: Record<string, ArrangementTitle> = {};
  const knownCards: Record<string, CardIdentityFacts> = {};
  const reportedCards: Record<string, string> = {};
  for (const cardId of cardIds) {
    const binding = bindings(cardId);
    if (binding !== undefined) boundCards[cardId] = binding;
    const title = titles(cardId);
    if (title !== null) titledCards[cardId] = title;
    const identity = identities(cardId);
    if (identity !== null) knownCards[cardId] = identity;
    const activity = activities(cardId);
    if (activity !== null) reportedCards[cardId] = activity;
  }
  return {
    deck: live,
    spaces: {
      activeSpaceId: spacesSnapshot.activeSpaceId,
      spaces: spacesSnapshot.spaces.map((s) => ({
        id: s.id,
        name: s.name,
        ...(s.theme !== undefined ? { theme: s.theme } : {}),
      })),
      mountedSpaceIds: [...spacesSnapshot.mountedSpaceIds],
      decks,
      liveSessions,
      cardCounts,
    },
    bandWidth: deck.getBandWidth(),
    columnRunHeight: deck.getColumnRunHeight(),
    railRunHeight: deck.getRailRunHeight(),
    bindings: boundCards,
    titles: titledCards,
    identities: knownCards,
    activities: reportedCards,
  };
}

/**
 * The arrangement's deck as the body holding `cardId` sees it: the shell's,
 * with the pane holding the card re-keyed to the body's own pane id, which is
 * the id the body's card host registers its elements under.
 * The pane-keyed marks that name it — the active pane, the bullseye, the
 * arrival — follow it.
 */
export function arrangementSnapshot(
  arrangement: BodyArrangement,
  cardId: string,
  bodyPaneId: string,
): DeckState {
  const deck = arrangement.deck;
  const own = deck.panes.find((p) => p.cardIds.includes(cardId))?.id;
  if (own === undefined) return deck;
  const rekey = (id: string): string => (id === own ? bodyPaneId : id);
  return {
    ...deck,
    panes: deck.panes.map((p) => (p.id === own ? { ...p, id: bodyPaneId } : p)),
    ...(deck.activePaneId !== undefined ? { activePaneId: rekey(deck.activePaneId) } : {}),
    ...(deck.bullseyePaneId !== undefined ? { bullseyePaneId: rekey(deck.bullseyePaneId) } : {}),
    ...(deck.arriving !== undefined
      ? { arriving: Object.fromEntries(Object.keys(deck.arriving).map((id) => [rekey(id), true as const])) }
      : {}),
  };
}
