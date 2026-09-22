/**
 * card-identity.ts — what a card holds, for any card in any workspace.
 *
 * A card's identity has been readable only while the card was mounted: every
 * surface that names a card read a live map keyed by mounted cards, so a card
 * in a workspace nobody has activated drew as its registration's generic
 * default. The product invariant this module carries is one sentence ([B01]):
 * a card's row says what the card holds, in every workspace, from the first
 * frame after boot, whether or not anything of that card is standing.
 * Mounting is an implementation detail of the active workspace and is not an
 * input to what a card is called.
 *
 * ## The whole public surface is one total function
 *
 * {@link cardIdentity} answers for **any** card id ([B03]). It resolves in
 * three steps, first hit wins, and reports which one answered:
 *
 *   1. the registration's `identity.live` — the open registries, the binding
 *      store, whatever knows about a MOUNTED card
 *   2. the registration's `identity.parked` — the durable record behind it
 *      ([P08]): the persisted bag, the bindings ledger cache
 *   3. the card's own `title`, then the registration's `defaultMeta.title`
 *
 * The three are never merged field-by-field: whichever source answers,
 * answers wholly, because a half-live identity is a state nobody can reason
 * about. The final fallback is what makes coverage total by construction
 * ([B02]) — the same shape `resolveCardsGroup` already wears, where a card
 * type cannot be registered without resolving somewhere.
 *
 * Consumers do not learn which registries exist, and none of them is
 * permitted to reach past this function into `cardSessionBindingStore`, the
 * open registries, or the bag.
 *
 * ## Why the resolvers live on the registration
 *
 * Because a per-kind branch inside a consumer means every new card type is
 * born broken and is fixed only when somebody notices — which is exactly how
 * the Text and file-view cards came to have hand-rolled fallbacks in the
 * Cards card while Commit and Diff had none ([F04], [B02]). A registration
 * declares its own identity the same way it declares its own Cards card
 * group.
 *
 * @module lib/card-identity
 */

import {
  getRegistration,
  type CardIdentityFacts,
  type CardIdentityResolution,
} from "@/card-registry";
import { getDeckStore } from "@/lib/deck-store-registry";
import type { CardState } from "@/layout-tree";

export type { CardIdentityFacts, CardIdentityResolution };

/** Which of the three sources answered for a card. */
export type CardIdentitySource = "live" | "parked" | "default";

/**
 * What a card holds, resolved.
 *
 * Every field is present and settled — there is no `undefined` here for a
 * caller to interpret, because the point of the resolution is that the answer
 * is complete whichever source produced it.
 */
export interface ResolvedCardIdentity {
  readonly cardId: string;
  /** The card's type, or `null` when no deck knows the card at all. */
  readonly componentId: string | null;
  /** Which source answered ([B03]). */
  readonly source: CardIdentitySource;
  readonly title: string;
  readonly secondary: string | null;
  readonly path: string | null;
  readonly tugSessionId: string | null;
  readonly projectDir: string | null;
  readonly icon: string | null;
  readonly unsaved: boolean;
}

/**
 * The card's record in whichever workspace holds it — active or parked.
 *
 * `spaceOf` + `getSpaceDeck` is the one pair of reads that reaches a card
 * nobody is looking at, which is the whole reason this function can be total.
 * `null` when no deck store is registered (a test that bootstrapped only a
 * subset of the deck) or when no workspace holds the id.
 */
function cardStateOf(cardId: string): CardState | null {
  const store = getDeckStore();
  if (store === null) return null;
  const spaceId = store.spaceOf(cardId);
  if (spaceId === null) return null;
  const deck = store.getSpaceDeck(spaceId);
  if (deck === null) return null;
  return deck.cards.find((card) => card.id === cardId) ?? null;
}

/**
 * The PERSISTED bag a parked card left behind — the durable door every
 * `identity.parked` resolver reads through ([P08]).
 *
 * `moveCardToSpace` captures every moving card before React takes its pane
 * down ([L23]), and a workspace switch does the same, so by the time anything
 * has to draw an unmounted card the bag holds what that card's
 * `useCardStatePreservation.onSave` wrote. `null` when no bag was ever
 * written or when it is not an object.
 */
export function parkedCardBag(cardId: string): Record<string, unknown> | null {
  const content = getDeckStore()?.getCardState(cardId)?.content;
  if (typeof content !== "object" || content === null) return null;
  return content as Record<string, unknown>;
}

/** The `path` a parked card's bag remembers, or `null` when it holds none. */
export function parkedBagPath(cardId: string): string | null {
  const path = parkedCardBag(cardId)?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** Fill a resolver's answer out into a settled identity. */
function settle(
  cardId: string,
  componentId: string | null,
  source: CardIdentitySource,
  facts: CardIdentityFacts,
  fallbackIcon: string | null,
): ResolvedCardIdentity {
  return {
    cardId,
    componentId,
    source,
    title: facts.title,
    secondary: facts.secondary ?? null,
    path: facts.path ?? null,
    tugSessionId: facts.tugSessionId ?? null,
    projectDir: facts.projectDir ?? null,
    icon: facts.icon ?? fallbackIcon,
    unsaved: facts.unsaved ?? false,
  };
}

/**
 * What the card holds — live if it is standing, durable if it is not, and the
 * registration's own default if neither source knows anything ([B03]).
 *
 * Total over any card id: an id no workspace holds and no registration claims
 * still resolves, to the id's own `componentId` where one is known and to the
 * id itself where none is. Callers never have to handle a `null`.
 */
export function cardIdentity(cardId: string): ResolvedCardIdentity {
  const card = cardStateOf(cardId);
  const componentId = card?.componentId ?? null;
  const reg = componentId === null ? undefined : getRegistration(componentId);
  const fallbackIcon = card?.icon ?? reg?.defaultMeta.icon ?? null;

  const live = reg?.identity?.live?.(cardId) ?? null;
  if (live !== null) {
    return settle(cardId, componentId, "live", live, fallbackIcon);
  }

  const parked = reg?.identity?.parked?.(cardId) ?? null;
  if (parked !== null) {
    return settle(cardId, componentId, "parked", parked, fallbackIcon);
  }

  return settle(
    cardId,
    componentId,
    "default",
    {
      title:
        (card?.title ?? "") || reg?.defaultMeta.title || componentId || cardId,
    },
    fallbackIcon,
  );
}
