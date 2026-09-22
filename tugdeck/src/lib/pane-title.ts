/**
 * pane-title.ts — the one place a pane's title-bar string is produced.
 *
 * A pane's title is not any single stored field. It is composed from three
 * sources, and every surface that names a pane has to compose them the same
 * way or it will name the same pane differently:
 *
 *   1. the **registry title** of the pane's active card (`CardMeta.title`) —
 *      the static label baked in at card-type definition time ("File",
 *      "Diff", "Chain Actions"), which is what a card of that type is called
 *      before it has a name of its own;
 *   2. the **pane title** (`TugPaneState.title`), the group name a multi-tab
 *      pane carries, which prefixes whatever the card is called;
 *   3. the **live override** a card publishes on {@link cardTitleStore} once
 *      its identity resolves — a Text card's filename, a Session card's bound
 *      project path — which REPLACES the registry title rather than extending
 *      it, because a card with a name of its own no longer needs to be
 *      announced by its type.
 *
 * A card that is not standing publishes nothing, so a fourth source stands
 * behind the third: the DURABLE half of {@link cardIdentity} ([B05]). The
 * override store is a mounted-card channel by design, and a surface that read
 * it alone could only ever name a card some deck happens to be holding up.
 * Where the store is silent and the resolver answers from the durable record,
 * that answer takes the override's place.
 *
 * Before this module existed the composition lived inside `CardTitleBar`'s
 * render and a *different*, simpler rule (`CardState.title` with a fallback
 * chain) lived in the menu-state projection. They disagreed exactly where it
 * was most visible: a Session card's title bar read `test-repo/petit-thaw`
 * while every list naming that same pane read `Untitled`, because only the
 * title bar consulted the override store.
 *
 * So the rule lives here once, in two layers:
 *
 *   - {@link composePaneTitleBarText} is the rule itself, pure, over the
 *     three parts. `CardTitleBar` calls this, because it already holds all
 *     three (it resolves its own meta and subscribes to its own override).
 *   - {@link paneTitleBarTextFor} is the same rule for callers *outside* the
 *     pane, which hold a `TugPaneState` and the deck's cards rather than
 *     resolved parts. It does the registry lookup and the override read, then
 *     delegates.
 *
 * **Laws:** the override read makes {@link paneTitleBarTextFor} a function of
 * store state as well as its arguments, so a React caller must subscribe to
 * `cardTitleStore` for its rows to repaint when an override lands — the
 * store's `version()` exists for exactly that, and reading it through
 * `useSyncExternalStore` is what keeps [L02] intact. A non-React caller (the
 * menu-state projection) re-projects from its own subscription instead. The
 * durable half carries the same obligation and a second input: the bindings
 * ledger cache a parked Session card resolves through, which lands on a frame
 * rather than on a deck mutation.
 *
 * @module lib/pane-title
 */

import type { CardState, TugPaneState } from "../layout-tree";
import { getRegistration } from "../card-registry";
import { cardIdentity } from "./card-identity";
import { cardTitleStore } from "./card-title-store";

/** Shown when a pane resolves to no name at all. */
const UNTITLED = "Untitled";

/**
 * The name to compose with: the live override a standing card published, or —
 * where there is none — what the card holds according to the durable record
 * ([B05]).
 *
 * **The store wins wherever it speaks, and a live resolver never overrules
 * it.** A mounted card publishing an override is the live truth, and a mounted
 * card publishing NOTHING is saying it would rather be called by its type: the
 * Diff card is the worked example, naming the file on its masthead while its
 * string channel stays the registry's "Diff", because an override replaces the
 * registry title and a tab wants to keep saying "Diff". So only the DURABLE
 * half of the resolution is promoted here — `source === "parked"`, which is
 * reached exactly when nothing of the card is up to answer.
 *
 * What that buys is the guarantee rather than a repair. Every workspace the
 * canvas mounts mounts its cards ([B06] — a hidden one is `display: none`,
 * not unmounted), so the surfaces composing through this module name standing
 * cards today and the durable answer is unreachable from them. It is what
 * makes a surface that names a card in an UNMOUNTED workspace correct by
 * construction rather than by somebody remembering — the same argument [B02]
 * makes for declaring the resolvers on the registration at all.
 */
function titleOverrideFor(cardId: string | null): string | null {
  const published = cardTitleStore.get(cardId);
  if (published !== null) return published;
  if (cardId === null) return null;
  const identity = cardIdentity(cardId);
  return identity.source === "parked" ? identity.title : null;
}

/**
 * The exact string a pane's title bar renders, from its three parts.
 *
 * **An override REPLACES the registry title; it does not extend it.** A card
 * publishes an override precisely when it has a name of its own, and that name
 * says what the static one said and more: `changes-rework.md` is already
 * evidently a file, and the row draws the card's `FileText` icon beside it
 * besides. Prefixing it produced `File : changes-rework.md`, where the first
 * word carried nothing the rest of the row did not. The registry title is the
 * FALLBACK — what a Text card with no file open is called — not a category
 * stamped on every name.
 *
 * A group name still prefixes, because it is not redundant with anything: it
 * is the name the user gave a multi-tab pane, and nothing else on the title
 * bar says it.
 *
 * - `metaTitle` alone when nothing else is present.
 * - `"<paneTitle> : <metaTitle>"` when the pane carries a group name.
 * - the override alone once one is published, or `"<paneTitle> : <override>"`
 *   inside a named multi-tab pane.
 */
export function composePaneTitleBarText(args: {
  /** The active card's registry title. May be empty. */
  metaTitle: string;
  /** The pane's own group name — multi-tab panes only. May be empty. */
  paneTitle?: string | undefined;
  /** The active card's live title override, when it has published one. */
  titleOverride?: string | null | undefined;
}): string {
  const { metaTitle, paneTitle, titleOverride } = args;
  const name = titleOverride ? titleOverride : metaTitle;
  return paneTitle && name ? `${paneTitle} : ${name}` : paneTitle || name;
}

/**
 * One **card's** label, by the same rule — for a caller naming a card rather
 * than a pane.
 *
 * The tab strip is the caller this exists for, and the distinction matters:
 * {@link paneTitleBarTextFor} resolves the pane's *active* card, while a tab
 * label is per-tab, so a stacked Session card behind another tab would read
 * the frontmost card's name. It also carries no pane group name — a group name
 * prefixes the pane, and repeating it on every tab in that pane would say it
 * once per tab.
 *
 * There is no card-type gate here, and that is the point. The tab strip used
 * to consult the override only for `componentId === "text"`, so a stacked
 * Session card's tab read the literal registry title "Session" while its own
 * title bar read `tugtool/stocky-pixie`. Every card that publishes an override
 * has a name of its own; the composition rule is what decides whether it wins,
 * and it lives here rather than at each caller.
 */
export function cardTitleTextFor(
  cardId: string,
  registryTitle: string,
): string {
  return composePaneTitleBarText({
    metaTitle: registryTitle,
    titleOverride: titleOverrideFor(cardId),
  });
}

/**
 * The same string, resolved for a caller that holds deck state rather than
 * the composed parts — the deck canvas building a slot-stack picker, or the
 * host menu-state projection naming panes for the Window menu.
 *
 * Falls back to `"Untitled"` only when the composition yields nothing at all,
 * which is a pane whose active card has neither a registry title nor an
 * override. A title bar in that state renders empty; a *list* cannot, because
 * a nameless row is unpickable.
 */
export function paneTitleBarTextFor(
  pane: TugPaneState,
  cardsById: ReadonlyMap<string, CardState>,
): string {
  const activeCard = cardsById.get(pane.activeCardId);
  const registration = activeCard
    ? getRegistration(activeCard.componentId)
    : undefined;
  return (
    composePaneTitleBarText({
      metaTitle: registration?.defaultMeta.title ?? "",
      // Only a multi-tab pane's group name prefixes the title, matching
      // what `CardTitleBar` is handed.
      paneTitle: pane.cardIds.length > 1 ? pane.title : undefined,
      titleOverride: titleOverrideFor(pane.activeCardId),
    }) || UNTITLED
  );
}
