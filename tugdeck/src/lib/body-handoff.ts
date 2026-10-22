/**
 * The shell's hand-off of a card to a body.
 *
 * **Capability.** The host says whether it can make bodies before any of the
 * shell's script runs (`window.__tugHostCapabilities`, a document-start user
 * script); it is read once here. Tug.app installs it in the shell's page
 * alone, so it answers which page this is: present in the shell, whose every
 * card is a body, and absent in a body page, which mounts its one card itself
 * and hands nothing off. There is no setting that turns bodies off.
 *
 * **Which cards.** Every card of a registered kind ({@link isBodyKind}).
 * There is no flag that keeps a kind in the shell: the shell's document has
 * no card hosts, so a kind it would not hand off would stand as an empty
 * placeholder forever. A kind whose registration says
 * `bodyHandOff: "spawn"` — the Session card — is handed off by its spawn
 * funnels when the shell has a session to start for it, and by the shell's
 * deck scan, with a `restore` intent, once it has none; every other body kind
 * by the deck scan, with a `mount` intent, as soon as the deck holds the card
 * (`lib/body-shell.ts`).
 *
 * **Hand-off.** The spawn funnels (`fireRestore`, `fireFreshSpawn`,
 * `fireNewSpawn`) ask {@link handOffToBody} first. A Session card the deck
 * holds becomes a body card: the shell marks it and asks the host for its
 * body with the intent the funnel would have acted on, and the funnel sends
 * nothing — the body spawns or resumes on its own connection. A card that is
 * already a body card answers true too, and the intent the shell has just
 * decided for it is sent to its body, which replays it. The one caller with
 * nothing to send is the shell's reconnect pass, which passes over every
 * body card ({@link isBodyCard}): the body reconnects and re-asserts its card
 * on its own.
 *
 * What the shell does with a body card afterwards is `lib/body-shell.ts`;
 * this module is the funnels' one import, so it stays light.
 *
 * **Not shown, not made.** A card handed off while the deck does not want
 * it shown — an inactive tab, at launch or after — is a body card from the
 * hand-off, but no page is asked for: it stands `unmade`, its intent kept,
 * until the deck first wants it shown, when the shell's eviction funnel asks
 * for it with that intent ({@link releaseDeferredBody}). A page made for a
 * card nobody can see goes dormant within seconds, and while the deck loads
 * it competes with the cards the user is waiting for. A kind that may veto
 * its own close (`guardsClose`) is made at once all the same: only its page
 * can say whether a close of it would ask. So is a card whose page is already
 * attached — a body the host kept across a shell reload, which said hello to
 * this shell before it was handed off: the host answers with the page it
 * kept, which goes on reporting its state, and a card stood `unmade` over a
 * live page would read bodiless and be shown by a stand-in.
 *
 * **Failure.** A body that fails stays a body card: the shell has no other
 * place for its card. The shell asks the host for it again
 * ({@link askForBodyAgain}), and a card whose body fails again stands as a
 * placard with a Reload, which asks once more ({@link reloadBody}).
 *
 * Laws: [L02] (membership is read through `useSyncExternalStore`), [L33]
 * (the capability is a constant nothing waits on).
 *
 * @module lib/body-handoff
 */

import type { BodyIntent } from "../body/body-intent";
import { getRegistration } from "../card-registry";
import type { DeckState } from "../layout-tree";
import { bodyCardsStore } from "./body-cards-store";
import { getShellDeck } from "./deck-store-registry";
import { installedPageBus } from "../bus/page-bus";
import { sessionIntent } from "../bus/declarations/verbs";
import { postToHost } from "../host/channel";
import { bodyCreateToHost } from "../host/declarations/lifecycle";

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

export interface HostCapabilities {
  readonly bodyViews: boolean;
}

function readHostCapabilities(): HostCapabilities {
  const raw = (globalThis as { __tugHostCapabilities?: { bodyViews?: unknown } })
    .__tugHostCapabilities;
  return Object.freeze({ bodyViews: raw?.bodyViews === true });
}

let capabilities = readHostCapabilities();

/** What the host can do, read once at module load. */
export const hostCapabilitiesStore = {
  get: (): HostCapabilities => capabilities,
};

/** For tests: answer as a host with these capabilities would. */
export function _setHostCapabilitiesForTest(next: HostCapabilities): void {
  capabilities = Object.freeze({ ...next });
}

// ---------------------------------------------------------------------------
// Hand-off
// ---------------------------------------------------------------------------

/** The intent each body card was handed off with, for a fallback that must re-run it. */
const intents = new Map<string, BodyIntent>();

/** What `cardId` was handed to its body to do, while it is a body card. */
export function bodyIntentOf(cardId: string): BodyIntent | null {
  return intents.get(cardId) ?? null;
}

/** The card is no longer a body card: forget what it was handed. */
export function forgetBodyIntent(cardId: string): void {
  intents.delete(cardId);
}

/** Whether `cardId` is a body card on this page: its body, not this page, acts for it. */
export function isBodyCard(cardId: string): boolean {
  return capabilities.bodyViews && bodyCardsStore.has(cardId);
}

/** Whether a card of `componentId` lives in a body on this page: in the shell, any registered kind. */
export function isBodyKind(componentId: string): boolean {
  return capabilities.bodyViews && getRegistration(componentId) !== undefined;
}

/**
 * Whether a card of `componentId` is a body kind the shell hands off itself,
 * at once and with a `mount` intent, rather than at a spawn funnel.
 */
export function isMountBodyKind(componentId: string): boolean {
  return isBodyKind(componentId) && getRegistration(componentId)?.bodyHandOff !== "spawn";
}

/** For tests. */
export function _resetHandOffForTest(): void {
  intents.clear();
  deferral = null;
  reloader = null;
  bodyCardsStore._reset();
}

/**
 * `cardId`'s card, read from its own workspace's deck: a visited workspace's
 * card keeps its body while parked, and is asked for again there.
 */
function cardInItsSpace(cardId: string): DeckState["cards"][number] | undefined {
  const deck = getShellDeck();
  if (deck === null) return undefined;
  const spaceId = deck.spaceOf(cardId);
  const own = spaceId === null ? deck.getSnapshot() : (deck.getSpaceDeck(spaceId) ?? deck.getSnapshot());
  return own.cards.find((c) => c.id === cardId);
}

/**
 * Ask the host for a page of `componentId` for `cardId`. A kind that may veto
 * its close says so, since only its page can answer that guard: the host
 * keeps such a page through the clock and a warning, and lets critical
 * pressure alone take it.
 */
function askHostForBody(cardId: string, componentId: string, intent: BodyIntent): void {
  const guardsClose = getRegistration(componentId)?.guardsClose === true;
  postToHost(bodyCreateToHost, guardsClose ? { cardId, componentId, intent, guardsClose } : { cardId, componentId, intent });
}

/**
 * What a card's next body is to do when the shell asks for it again, from
 * what its gone body was handed (`handed`, without its bag: the gone body
 * wrote the card's state as it went, so the new one reads it back). A kind
 * the shell hands off itself mounts. The harness's fake bind is handed
 * again, since no ledger holds it. A Session card the shell holds a binding
 * for (`bound`) restores it: the gone body's spawn was acknowledged, so
 * re-running a `new` or `fresh` would start a second session. Any other
 * card re-runs what it was handed, or restores when it was handed nothing.
 */
export function intentToAskAgain(handed: BodyIntent | null, mountKind: boolean, bound: boolean): BodyIntent {
  if (mountKind) return { kind: "mount" };
  if (handed?.kind === "bind") return handed;
  if (bound) return { kind: "restore" };
  return handed ?? { kind: "restore" };
}

/**
 * Ask the host again for the body of `cardId`, a body card whose body
 * failed: the card is `creating` again and the host makes it a new body,
 * which acts on `intent`. Nothing when the deck no longer holds the card.
 */
export function askForBodyAgain(cardId: string, intent: BodyIntent): void {
  const card = cardInItsSpace(cardId);
  if (card === undefined || !bodyCardsStore.has(cardId)) return;
  intents.set(cardId, intent);
  bodyCardsStore.setState(cardId, "creating");
  askHostForBody(cardId, card.componentId, intent);
}

/** How a failed card's Reload asks for its body: the shell's, once it is installed. */
let reloader: ((cardId: string) => void) | null = null;

/** The shell answers a failed card's Reload through `reload`; null to stop. */
export function setBodyReloader(reload: ((cardId: string) => void) | null): void {
  reloader = reload;
}

/** A failed card's Reload: ask for its body once more. */
export function reloadBody(cardId: string): void {
  reloader?.(cardId);
}

/** Whether a card handed off now is not to have its page made yet: the shell's, once it is installed. */
let deferral: ((cardId: string) => boolean) | null = null;

/** The shell says which cards' pages wait until they are shown; null to make every one at once. */
export function setBodyDeferral(defer: ((cardId: string) => boolean) | null): void {
  deferral = defer;
}

/** Whether `cardId` is a body card whose page has never been asked for. */
export function isDeferredBody(cardId: string): boolean {
  return bodyCardsStore.stateOf(cardId) === "unmade";
}

/**
 * Ask the host for the page of `cardId`, a card handed off while it was not
 * shown, with the intent it was handed — its bag with it, since no page has
 * read the card's state yet. False, asking nothing, for any other card.
 */
export function releaseDeferredBody(cardId: string): boolean {
  if (!isDeferredBody(cardId)) return false;
  const card = cardInItsSpace(cardId);
  const intent = intents.get(cardId);
  if (card === undefined || intent === undefined) return true;
  bodyCardsStore.setState(cardId, "creating");
  askHostForBody(cardId, card.componentId, intent);
  return true;
}

/**
 * Hand `cardId` to a body, if it is one the shell hands off. Returns true
 * when the funnel must send nothing: the card is now a body card, or already
 * was one. `intent` is called only when a body is actually asked for, so a
 * funnel can drain a one-shot hold into it without losing it on a false.
 *
 * A card that already was one is sent `intent` (`session.intent`), since the
 * funnel has just decided it and the body is the only page that can act on it
 * ([L31]: a decision is never dropped unsaid). A body whose page has not said
 * hello is sent it when it does.
 */
export function handOffToBody(cardId: string, intent: () => BodyIntent): boolean {
  if (!capabilities.bodyViews) return false;
  if (bodyCardsStore.has(cardId)) {
    // A card whose page waits to be shown is handed that page's intent when
    // it is: the one just decided, carrying the state it was first handed.
    if (isDeferredBody(cardId)) {
      const made = intent();
      const bag = made.bag ?? intents.get(cardId)?.bag;
      intents.set(cardId, bag === undefined ? made : { ...made, bag });
      return true;
    }
    if (installedPageBus() === null) return true;
    const made = intent();
    intents.set(cardId, made);
    sessionIntent.dispatch(made as unknown as Record<string, unknown> & { kind: string }, { card: cardId });
    return true;
  }
  const deck = getShellDeck();
  if (deck === null) return false;
  const card = cardInItsSpace(cardId);
  if (card === undefined || !isBodyKind(card.componentId)) return false;
  // The card's first body: it takes the state the shell holds for it.
  const asked = intent();
  const bag = asked.bag ?? deck.getCardState(cardId);
  const made = bag === undefined ? asked : { ...asked, bag };
  intents.set(cardId, made);
  // A kind that may veto its close needs its page to answer whether it
  // would, and a page already attached is the card's whatever is shown.
  if (
    getRegistration(card.componentId)?.guardsClose !== true &&
    installedPageBus()?.isAttached({ card: cardId }) !== true &&
    deferral?.(cardId) === true
  ) {
    bodyCardsStore.mark(cardId, "unmade");
    return true;
  }
  bodyCardsStore.mark(cardId);
  askHostForBody(cardId, card.componentId, made);
  return true;
}

