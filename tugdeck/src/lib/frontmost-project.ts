/**
 * frontmost-project.ts — the project Open Quickly should search.
 *
 * A "project" is a bound session-card session, whose binding carries the
 * `projectDir` (the absolute workspace root — FILETREE indexes paths
 * relative to it) and the `workspaceKey` (which scopes the FILETREE feed).
 * Open Quickly picks the **most-frontmost** such project: walking the deck
 * front-to-back (topmost pane's active card first), it returns the first
 * card that has a binding — so as long as any session card has a project open,
 * that's very likely the one the user means, and Open Quickly stays live.
 * When no card is bound, the result is `null` and Open Quickly is disabled.
 *
 * The same walk, deduplicated over `projectDir`, is the **workspace's project
 * set** ({@link workspaceProjectDirs}): every project a bound card in this deck
 * has open, frontmost first. The Choose Session sheet opens on those groups,
 * so a new session lands in the project the workspace is for.
 *
 * A body page cannot walk the deck: its deck holds its own card and its
 * binding store that card's binding alone. The shell sends both answers in its
 * deck facts, and a body answers with those ({@link relayFrontmostProjectBinding},
 * {@link relayWorkspaceProjectDirs}).
 *
 * @module lib/frontmost-project
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { createSubscribable } from "@/lib/subscribable";

import { getCardDeck } from "./deck-store-registry";
import { canonicalDirStore, readCanonicalOf } from "./canonical-dir-store";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "./card-session-binding-store";

/**
 * The shell's answer, on a body page that has heard it; `undefined` on the
 * shell's page, which walks its own deck.
 */
let relayed: CardSessionBinding | null | undefined;
const relayedChanged = createSubscribable();

/**
 * Take the shell's frontmost binding on a body page. An equal one keeps the
 * held reference, so a reader's snapshot does not churn.
 */
export function relayFrontmostProjectBinding(binding: CardSessionBinding | null): void {
  if (relayed !== undefined && JSON.stringify(relayed) === JSON.stringify(binding)) return;
  relayed = binding;
  relayedChanged.notify();
}

/** The shell's workspace project set, on a body page that has heard it. */
let relayedDirs: readonly string[] | undefined;

/**
 * Take the shell's workspace project set on a body page. An equal list keeps
 * the held reference, so a reader's snapshot does not churn.
 */
export function relayWorkspaceProjectDirs(dirs: readonly string[]): void {
  if (relayedDirs !== undefined && sameDirs(relayedDirs, dirs)) return;
  relayedDirs = dirs;
  relayedChanged.notify();
}

/** For tests: back to a page that has heard nothing. */
export function _resetRelayedFrontmostProjectForTest(): void {
  relayed = undefined;
  relayedDirs = undefined;
  lastDirs = NO_DIRS;
}

function sameDirs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((dir, i) => dir === b[i]);
}

/**
 * The binding of the most-frontmost bound card, or `null` when no card is
 * bound to a project. Panes are back-to-front, so the last is topmost;
 * within a pane the active (visible) card is checked before its background
 * tabs.
 */
export function frontmostProjectBinding(): CardSessionBinding | null {
  if (relayed !== undefined) return relayed;
  const store = getCardDeck();
  if (store === null) return null;
  const { panes } = store.getSnapshot();
  for (let i = panes.length - 1; i >= 0; i--) {
    const pane = panes[i];
    const active = cardSessionBindingStore.getBinding(pane.activeCardId);
    if (active !== undefined) return active;
    for (const cardId of pane.cardIds) {
      const binding = cardSessionBindingStore.getBinding(cardId);
      if (binding !== undefined) return binding;
    }
  }
  return null;
}

const NO_DIRS: readonly string[] = Object.freeze([]);
/** The last answer, so an unchanged set is the same reference. */
let lastDirs: readonly string[] = NO_DIRS;

/**
 * The workspace's project set: the directory of every bound card in the deck,
 * one entry per DIRECTORY, in the order {@link frontmostProjectBinding} walks
 * them (topmost pane first, its active card before its background tabs).
 * Empty when no card is bound. Referentially stable while the set is
 * unchanged, so a `useSyncExternalStore` snapshot may return it directly.
 *
 * Two cards bound under two spellings of one directory are one project, and
 * only the server can say so ([L29]): each binding's `projectDir` is
 * identified by the server's canonical spelling (`canonical-dir-store`), and
 * that spelling is what the set holds. Until the server has answered, a path
 * stands for itself; the answer landing re-reads the set.
 */
export function workspaceProjectDirs(): readonly string[] {
  if (relayedDirs !== undefined) return relayedDirs;
  const store = getCardDeck();
  if (store === null) return NO_DIRS;
  const { panes } = store.getSnapshot();
  const dirs: string[] = [];
  const take = (cardId: string): void => {
    const raw = cardSessionBindingStore.getBinding(cardId)?.projectDir;
    if (raw === undefined || raw === "") return;
    const dir = readCanonicalOf(raw);
    if (!dirs.includes(dir)) dirs.push(dir);
  };
  for (let i = panes.length - 1; i >= 0; i--) {
    const pane = panes[i];
    take(pane.activeCardId);
    for (const cardId of pane.cardIds) take(cardId);
  }
  if (!sameDirs(lastDirs, dirs)) lastDirs = dirs.length === 0 ? NO_DIRS : dirs;
  return lastDirs;
}

/**
 * Subscribe to everything the two walks read — the canonical answers too,
 * since they decide which bindings are one project.
 */
function subscribeToProjects(onChange: () => void): () => void {
  const deck = getCardDeck();
  const unDeck = deck ? deck.subscribe(onChange) : () => {};
  const unBind = cardSessionBindingStore.subscribe(onChange);
  const unRelay = relayedChanged.subscribe(onChange);
  const unCanonical = canonicalDirStore.subscribe(onChange);
  return () => {
    unDeck();
    unBind();
    unRelay();
    unCanonical();
  };
}

/** Reactive {@link workspaceProjectDirs} ([L02]). */
export function useWorkspaceProjectDirs(): readonly string[] {
  return useSyncExternalStore(
    subscribeToProjects,
    workspaceProjectDirs,
    workspaceProjectDirs,
  );
}

/**
 * Reactive {@link frontmostProjectBinding}: re-reads whenever the deck reorders
 * or a binding lands/clears, so a consumer tracks the topmost bound project
 * live. Returns the same binding reference while unchanged, so it does not churn
 * `useSyncExternalStore`. `null` when no card is bound.
 */
export function useFrontmostProjectBinding(): CardSessionBinding | null {
  return useSyncExternalStore(
    subscribeToProjects,
    frontmostProjectBinding,
    frontmostProjectBinding,
  );
}
