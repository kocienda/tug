/**
 * The shell's hand-off of a card to a body.
 *
 * **Capability.** The host says whether it can make bodies before any of the
 * shell's script runs (`window.__tugHostCapabilities`, a document-start user
 * script); it is read once here. Absent — a browser on the Vite port, a body
 * page, the harness unless a test asks — means every card mounts in the shell
 * exactly as before.
 *
 * **Which cards.** A card whose kind's registration says `body: true`
 * ({@link isBodyKind}). A kind whose registration also says
 * `bodyHandOff: "spawn"` — the Session card — is handed off by its spawn
 * funnels; every other body kind by the shell's deck scan, with a `mount`
 * intent, as soon as the deck holds the card (`lib/body-shell.ts`).
 *
 * **Hand-off.** The spawn funnels (`fireRestore`, `fireFreshSpawn`,
 * `fireNewSpawn`) ask {@link handOffToBody} first. A Session card the deck
 * holds becomes a body card: the shell marks it and asks the host for its
 * body with the intent the funnel would have acted on, and the funnel sends
 * nothing — the body spawns or resumes on its own connection. A card that is
 * already a body card answers true and nothing is posted, which is what the
 * shell's reconnect pass needs: the body reconnects and re-spawns on its own.
 *
 * What the shell does with a body card afterwards is `lib/body-shell.ts`;
 * this module is the funnels' one import, so it stays light.
 *
 * Laws: [L02] (membership is read through `useSyncExternalStore`), [L33]
 * (the capability is a constant nothing waits on).
 *
 * @module lib/body-handoff
 */

import type { BodyIntent } from "../body/body-intent";
import { getRegistration } from "../card-registry";
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

/** Cards whose body failed: they stay in the shell for the rest of the run. */
const suppressed = new Set<string>();

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

/** Keep `cardId` in the shell from now on. */
export function suppressHandOff(cardId: string): void {
  suppressed.add(cardId);
}

/** Whether `cardId`'s body failed, so it stays in the shell. */
export function isHandOffSuppressed(cardId: string): boolean {
  return suppressed.has(cardId);
}

/** Whether a card of `componentId` lives in a body on this host. */
export function isBodyKind(componentId: string): boolean {
  return capabilities.bodyViews && getRegistration(componentId)?.body === true;
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
  suppressed.clear();
  intents.clear();
  bodyCardsStore._reset();
  bodyFactsStore._reset();
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
 * Hand `cardId` to a body, if it is one the shell hands off. Returns true
 * when the funnel must send nothing: the card is now a body card, or already
 * was one. `intent` is called only when a body is actually asked for, so a
 * funnel can drain a one-shot hold into it without losing it on a false.
 */
export function handOffToBody(cardId: string, intent: () => BodyIntent): boolean {
  if (!capabilities.bodyViews) return false;
  if (bodyCardsStore.has(cardId)) return true;
  if (suppressed.has(cardId)) return false;
  const deck = getDeckStore();
  if (deck === null) return false;
  const card = deck.getSnapshot().cards.find((c) => c.id === cardId);
  if (card === undefined || !isBodyKind(card.componentId)) return false;
  bodyCardsStore.mark(cardId);
  const made = intent();
  intents.set(cardId, made);
  postToHost("bodyCreate", { cardId, componentId: card.componentId, intent: made });
  return true;
}

