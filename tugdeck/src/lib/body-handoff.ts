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
import type { CardStateBag, DeckState } from "../layout-tree";
import { bodyCardsStore } from "./body-cards-store";
import { bodyFactsStore } from "./body-facts-store";
import { getDeckStore } from "./deck-store-registry";

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
  forwarder = null;
  reloader = null;
  bodyCardsStore._reset();
  bodyFactsStore._reset();
}

/** How an intent reaches a card's body: the shell's bus, once it is installed. */
let forwarder: ((cardId: string, intent: BodyIntent) => void) | null = null;

/** The shell sends a body card's later intents through `send`; null to stop. */
export function setBodyIntentForwarder(send: ((cardId: string, intent: BodyIntent) => void) | null): void {
  forwarder = send;
}

/**
 * `cardId`'s card, read from its own workspace's deck: a warm workspace's
 * card has its body while parked, and is asked for again there.
 */
function cardInItsSpace(cardId: string): DeckState["cards"][number] | undefined {
  const deck = getDeckStore();
  if (deck === null) return undefined;
  const spaceId = deck.spaceOf(cardId);
  const own = spaceId === null ? deck.getSnapshot() : (deck.getSpaceDeck(spaceId) ?? deck.getSnapshot());
  return own.cards.find((c) => c.id === cardId);
}

/** Post `body` to the host's `name` handler; nothing without a host. */
export function postToHost(name: string, body: unknown): void {
  const handlers = (
    globalThis as {
      webkit?: { messageHandlers?: Record<string, { postMessage: (v: unknown) => void } | undefined> };
    }
  ).webkit?.messageHandlers;
  handlers?.[name]?.postMessage(body);
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
  postToHost("bodyCreate", { cardId, componentId: card.componentId, intent });
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

/** Each kind's seed for a card's first body, when the deck holds no state for the card. */
const firstBagSeeds = new Map<string, () => CardStateBag | undefined>();

/**
 * Seed the first body of every `componentId` card the deck holds no state
 * for with what `seed` returns at the hand-off — app-scoped state a kind
 * keeps in the shell across its cards, which a fresh card id cannot find in
 * the deck's cache (the Overview's draft across a rail hidden and shown).
 * Returns the release.
 */
export function setFirstBodyBagSeed(componentId: string, seed: () => CardStateBag | undefined): () => void {
  firstBagSeeds.set(componentId, seed);
  return () => {
    if (firstBagSeeds.get(componentId) === seed) firstBagSeeds.delete(componentId);
  };
}

/**
 * Hand `cardId` to a body, if it is one the shell hands off. Returns true
 * when the funnel must send nothing: the card is now a body card, or already
 * was one. `intent` is called only when a body is actually asked for, so a
 * funnel can drain a one-shot hold into it without losing it on a false.
 *
 * A card that already was one is sent `intent` through the forwarder the
 * shell installed, since the funnel has just decided it and the body is the
 * only page that can act on it ([L31]: a decision is never dropped unsaid).
 */
export function handOffToBody(cardId: string, intent: () => BodyIntent): boolean {
  if (!capabilities.bodyViews) return false;
  if (bodyCardsStore.has(cardId)) {
    if (forwarder === null) return true;
    const made = intent();
    intents.set(cardId, made);
    forwarder(cardId, made);
    return true;
  }
  const deck = getDeckStore();
  if (deck === null) return false;
  const card = cardInItsSpace(cardId);
  if (card === undefined || !isBodyKind(card.componentId)) return false;
  bodyCardsStore.mark(cardId);
  // The card's first body: it takes the state the shell holds for it, or,
  // for a card the deck holds none for, what its kind's seed holds.
  const asked = intent();
  const bag = asked.bag ?? deck.getCardState(cardId) ?? firstBagSeeds.get(card.componentId)?.();
  const made = bag === undefined ? asked : { ...asked, bag };
  intents.set(cardId, made);
  postToHost("bodyCreate", { cardId, componentId: card.componentId, intent: made });
  return true;
}

