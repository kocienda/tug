/**
 * What a body reads of the deck beyond its own card, and the deck verbs it
 * may ask of the shell.
 *
 * Every body reads other cards' titles, sessions and phases through
 * `deck.cards` (`declarations/deck.ts`). A card that lists or moves the
 * whole deck (`bodyDeck: "arrangement"`, the Cards and Layout cards) reads
 * the shell's arrangement as well, split by how often each part moves: the
 * live deck and its band (`arrangement.deck`, every commit) and the
 * workspaces (`arrangement.spaces`). The Cards card also reads the
 * server's card bindings (`cards.ledgerBindings`) and holds the layout
 * selection with the shell (`layout.selection`, which it proposes to). A
 * following card (`bodyFollows`) reads the card it follows (`card.followed`),
 * and the About card the app's identity (`app.info`).
 *
 * The deck verbs an arrangement card makes are the `deck.*` actions, and no
 * others: a workspace delete must walk the close guards, so it is a command
 * the shell answers, never a deck call. A workspace verb the shell's menu
 * asked the Cards card to answer is `cards.spaceVerb`, sent to the shown
 * workspace's Cards card.
 *
 * Three deck verbs any card makes: a card added (its id minted by the page
 * that asks, so the asker holds it before the card lands), a singleton
 * shown, and the live sessions interrupted, a request the update wizard
 * waits on.
 *
 * @module bus/declarations/arrangement
 */

import { getRegistration } from "../../card-registry";
import type { DeckState } from "../../layout-tree";
import type { AppInfo } from "../../lib/app-info-store";
import type { CardBinding } from "../../protocol";
import { CARDS_CARD_ID } from "../../lib/cards-card-id";
import { arr, bool, empty, literal, nullable, num, obj, opaque, optional, rec, str } from "../codec";
import { defineRequest } from "../request";
import { defineAction } from "../routed-action";
import { defineSharedStore } from "../shared-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a card of `componentId` lists or moves the whole deck. */
export function isArrangementKind(componentId: string): boolean {
  return getRegistration(componentId)?.bodyDeck === "arrangement";
}

const deckState = opaque(
  (v: unknown): v is DeckState => isRecord(v) && Array.isArray(v.cards) && Array.isArray(v.panes),
  { cards: [], panes: [], imposition: { sidebars: {} }, hasFocus: true } as DeckState,
);

// ---- A card that lists or moves the whole deck ----

/** The live deck and its band, as an arrangement card reads them. */
export interface ArrangementDeckValue {
  deck: DeckState;
  bandWidth: number | null;
  columnRunHeight: number | null;
  railRunHeight: number | null;
}

export const arrangementDeck = defineSharedStore<ArrangementDeckValue | null>({
  key: "arrangement.deck",
  owner: "shell",
  scope: { kinds: isArrangementKind },
  codec: nullable(
    obj({ deck: deckState, bandWidth: nullable(num), columnRunHeight: nullable(num), railRunHeight: nullable(num) }),
  ),
  initial: null,
});

/** Every workspace, as an arrangement card lists them. */
export interface ArrangementSpaces {
  activeSpaceId: string;
  spaces: Array<{ id: string; name: string; theme?: string }>;
  mountedSpaceIds: string[];
  /** Every workspace's deck but the active one's, which is `arrangement.deck`'s. */
  decks: Record<string, DeckState>;
  /** `spaceHoldsLiveSessions`, per workspace. */
  liveSessions: Record<string, number>;
  /** `spaceCardCount`, per workspace. */
  cardCounts: Record<string, number>;
}

export const NO_ARRANGEMENT_SPACES: ArrangementSpaces = {
  activeSpaceId: "",
  spaces: [],
  mountedSpaceIds: [],
  decks: {},
  liveSessions: {},
  cardCounts: {},
};

export const arrangementSpaces = defineSharedStore<ArrangementSpaces>({
  key: "arrangement.spaces",
  owner: "shell",
  scope: { kinds: isArrangementKind },
  codec: obj({
    activeSpaceId: str,
    spaces: arr(obj({ id: str, name: str, theme: optional(str) })),
    mountedSpaceIds: arr(str),
    decks: rec(deckState),
    liveSessions: rec(num),
    cardCounts: rec(num),
  }),
  initial: NO_ARRANGEMENT_SPACES,
});

// ---- The Cards card ----

const isCardsCard = (componentId: string): boolean => componentId === CARDS_CARD_ID;

/**
 * The shell's cache of the server's card bindings (`spaceBindingsLedgerStore`):
 * the Cards card lists every card's session, a parked workspace's included,
 * and its page may come up after the frame that filled the cache. Null until
 * the shell's cache has loaded.
 */
export const cardsLedgerBindings = defineSharedStore<CardBinding[] | null>({
  key: "cards.ledgerBindings",
  owner: "shell",
  scope: { kinds: isCardsCard },
  codec: nullable(
    arr(
      opaque((v: unknown): v is CardBinding => isRecord(v) && typeof v.card_id === "string", {
        card_id: "",
        session_id: "",
        project_dir: "",
        state: "live",
        turn_count: 0,
      } as CardBinding),
    ),
  ),
  initial: null,
});

/**
 * The layout selection — which cards the deck's layout verbs act on — and the
 * card the Cards list's cursor stands on. The list builds both in the Cards
 * card's page and the shell's verbs read them, so the shell owns them and the
 * Cards body proposes each change: a patch naming what moved.
 */
export interface LayoutSelectionValue {
  ids: string[];
  anchorId: string | null;
  cursor: string | null;
}

export type LayoutSelectionPatch = Partial<LayoutSelectionValue>;

export const layoutSelection = defineSharedStore<LayoutSelectionValue, LayoutSelectionPatch>({
  key: "layout.selection",
  owner: "shell",
  scope: { kinds: isCardsCard },
  codec: obj({ ids: arr(str), anchorId: nullable(str), cursor: nullable(str) }),
  initial: { ids: [], anchorId: null, cursor: null },
  proposals: obj({ ids: optional(arr(str)), anchorId: optional(nullable(str)), cursor: optional(nullable(str)) }),
  applyProposal: (prev, patch) => ({ ...prev, ...patch }),
});

// ---- A following card, and the About card ----

/**
 * The card a following card follows — the last key card that is not it —
 * which only the shell's focus manager knows. Null until it follows one.
 */
export const cardFollowed = defineSharedStore<{ cardId: string } | null>({
  key: "card.followed",
  owner: "shell",
  scope: { card: true },
  codec: nullable(obj({ cardId: str })),
  initial: null,
});

/** The app's identity the host sent the shell with its `show-card`, which only the shell hears. */
export const appInfo = defineSharedStore<AppInfo | null>({
  key: "app.info",
  owner: "shell",
  scope: { kinds: (componentId) => componentId === "about" },
  codec: nullable(
    obj({
      name: optional(str),
      version: optional(str),
      build: optional(str),
      commit: optional(str),
      branch: optional(str),
      profile: optional(str),
      copyright: optional(str),
      icon: optional(str),
    }),
  ),
  initial: null,
});

// ---- The deck verbs an arrangement card makes ----

export const deckActivateCard = defineAction({
  id: "deck.activateCard",
  owner: "shell",
  codec: obj({ cardId: str, reveal: optional(bool) }),
});

export const deckSetFlowOffset = defineAction({
  id: "deck.setFlowOffset",
  owner: "shell",
  codec: obj({ offset: num, landing: optional(literal("cross", "cut")) }),
});

export const deckPreviewFlowOffset = defineAction({
  id: "deck.previewFlowOffset",
  owner: "shell",
  codec: obj({ offset: num }),
});

export const deckActivateSpace = defineAction({
  id: "deck.activateSpace",
  owner: "shell",
  codec: obj({ spaceId: str }),
});

export const deckRenameSpace = defineAction({
  id: "deck.renameSpace",
  owner: "shell",
  codec: obj({ spaceId: str, name: str }),
});

export const deckChooseSpaceTheme = defineAction({
  id: "deck.chooseSpaceTheme",
  owner: "shell",
  codec: obj({ spaceId: str, theme: str }),
});

export const deckMoveCardToSpace = defineAction({
  id: "deck.moveCardToSpace",
  owner: "shell",
  codec: obj({ cardId: str, spaceId: str }),
});

export const deckReorderSpaces = defineAction({
  id: "deck.reorderSpaces",
  owner: "shell",
  codec: obj({ order: arr(str) }),
});

// ---- The deck verbs any card makes ----

/** What a card hands a new card to open on (`addCard`'s `initialContent`), as the new card's bag will hold it. */
const initialContent = opaque((_v: unknown): _v is unknown => true, { path: "/tmp/sample.txt" } as unknown);

/** Add a card of `componentId` under the id `cardId` the asking page minted. */
export const deckAddCard = defineAction({
  id: "deck.addCard",
  owner: "shell",
  codec: obj({
    cardId: str,
    componentId: str,
    initialContent: optional(initialContent),
    origin: optional(nullable(str)),
    opening: optional(literal("bound")),
  }),
});

/** Show the card of `componentId` as a singleton: raise the one the deck holds, or add it. */
export const deckShowSingletonCard = defineAction({
  id: "deck.showSingletonCard",
  owner: "shell",
  codec: obj({ componentId: str }),
});

/** Interrupt every session with a turn in flight, and say which acknowledged. */
export const deckInterruptLiveSessions = defineRequest({
  id: "deck.interruptLiveSessions",
  owner: "shell",
  codec: empty,
  replyCodec: obj({ interrupted: arr(str), unacknowledged: arr(str) }),
  onDetach: "fail",
});

/** A workspace verb the shell's menu or a chord asked the Cards card to answer, in its page. */
export const cardsSpaceVerb = defineAction({
  id: "cards.spaceVerb",
  owner: "card",
  codec: obj({ verb: literal("rename", "delete"), spaceId: str }),
});
