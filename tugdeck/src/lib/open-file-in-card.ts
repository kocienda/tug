/**
 * open-file-in-card.ts — the one implementation behind every
 * "open this path" entry point.
 *
 * The path's kind decides the card family: text goes to a Text card, and
 * everything `file-kinds.ts` classifies as viewable (images, PDFs) goes to a
 * read-only `file-view` card. Branching here means every producer — ⌘O, Open
 * Recent, Open Quickly, Finder, transcript links, context menus — inherits the
 * routing without knowing it exists. Both families share the reuse and
 * open-target semantics below; a viewer just has no lines to reveal and is
 * never dirty.
 *
 * Path-keyed reuse: a Text card already bound to `path` is activated
 * (raised + focus-claimed via `transferFocusForActivation`, so the
 * keystroke/click taxonomy matches every other activation route) and
 * jumped to `line`. Otherwise the file gets a fresh card of its own,
 * seeded through `addCard`'s initial-content channel — it mounts
 * directly onto the file via the same restore path a reloaded card
 * takes. Under a multi-slot arrangement the deck places that fresh card from
 * the card the open came from (`addCard`'s `origin`): `originCardId` when the
 * door names its host card — a menu row, a link, a list — and the first
 * responder when it does not.
 *
 * Either way the card that answers the open flashes its border
 * ({@link flashCardPane}): a card arriving beside the passage being read is a
 * change the eye has to find, and a reused card that was already on screen
 * gives no sign at all that the click did anything.
 *
 * Callers: the `open-file` registry handler (Control frames +
 * `dispatchCommand` from transcript links) and DeckCanvas's
 * `TUG_ACTIONS.OPEN_FILE` chain handler (context-menu items).
 *
 * @module lib/open-file-in-card
 */

import { mayDeferCommit, transferFocusForActivation } from "@/focus-transfer";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { getTugbankClient } from "./tugbank-singleton";
import {
  TEXT_CARD_DEFAULTS_DOMAIN,
  TEXT_CARD_SAVE_MODE_KEY,
  parseSaveMode,
} from "./text-card-settings";
import type { SaveMode } from "./text-card-store";
import { findTextCardByPath } from "./text-card-open-registry";
import { findFileViewCardByPath } from "./file-view-open-registry";
import { isViewableFile } from "./file-kinds";
import { noteRecentDocument } from "./recent-documents";
import { flashCardPane } from "./flash-pane-border";
import { cardIdentityElsewhere } from "./card-identity";

/**
 * A card of `componentId` bound to `path` whose content is mounted in another
 * page — a body card — found among the active deck's cards by the path its
 * page published. The open registries are per page and hold none of these.
 */
function bodyCardByPath(store: IDeckManagerStore, componentId: string, path: string): string | null {
  for (const card of store.getSnapshot().cards) {
    if (card.componentId === componentId && cardIdentityElsewhere.get(card.id)?.path === path) return card.id;
  }
  return null;
}

/** Reveals a line in a body Text card, in the body's own page. */
export type BodyLineRevealer = (
  cardId: string,
  line: number,
  endLine?: number,
  columns?: readonly [number, number],
) => void;

let bodyLineRevealer: BodyLineRevealer | null = null;

/** Install the revealer for a body Text card's lines. Returns the uninstall. */
export function setBodyLineRevealer(revealer: BodyLineRevealer): () => void {
  bodyLineRevealer = revealer;
  return () => {
    if (bodyLineRevealer === revealer) bodyLineRevealer = null;
  };
}

/**
 * Read the deck-wide save-mode default straight from the tugbank cache
 * — the mode a newly mounted Text card adopts. Missing → the
 * shipping default ({@link parseSaveMode}). No settings UI exposes it.
 */
export function readSaveMode(): SaveMode {
  const client = getTugbankClient();
  return parseSaveMode(
    client?.get(TEXT_CARD_DEFAULTS_DOMAIN, TEXT_CARD_SAVE_MODE_KEY),
  );
}

/**
 * Open a viewable file (image, PDF) in a read-only `file-view` card. Mirrors
 * the Text path: activate the card already bound to `path`, else a fresh
 * card. `line` has no meaning for a viewer, so the reveal channel is absent.
 */
function openFileInViewerCard(
  store: IDeckManagerStore,
  path: string,
  originCardId: string | null,
): void {
  const existingId = findFileViewCardByPath(path)?.cardId ?? bodyCardByPath(store, "file-view", path);
  if (existingId !== null) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existingId,
      store,
      commitMutation: () => store.activateCard(existingId),
      deferCommit: mayDeferCommit(store, existingId),
    });
    flashCardPane(store, existingId);
    return;
  }

  // Same save-before-activation discipline as the Text fall-through: the
  // surface that dispatched this open — the Cards card Files list, say — must save
  // its focus bag before `addCard` activates the new card ([L23]).
  const outgoing = store.getFirstResponderCardId();
  if (outgoing !== null) store.invokeSaveCallback(outgoing);
  const cardId = store.addCard("file-view", { path }, {
    origin: originCardId ?? outgoing,
  });
  if (cardId !== null) flashCardPane(store, cardId);
}

export function openFileInCard(
  store: IDeckManagerStore,
  path: string,
  line?: number,
  endLine?: number,
  columns?: readonly [number, number],
  originCardId: string | null = null,
): void {
  // Every real open flows through here — record it for Open Recent
  // before the card work, so drops / Open Quickly / menu all feed it.
  // Viewed files belong in Open Recent too, so this runs for every kind.
  noteRecentDocument(path);

  // The one place a path's kind decides which card family it lands in.
  if (isViewableFile(path)) {
    openFileInViewerCard(store, path, originCardId);
    return;
  }

  const local = findTextCardByPath(path);
  const existingId = local?.cardId ?? bodyCardByPath(store, "text", path);
  if (existingId !== null) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existingId,
      store,
      commitMutation: () => store.activateCard(existingId),
      deferCommit: mayDeferCommit(store, existingId),
    });
    if (line !== undefined) {
      if (local !== null) local.entry.revealLine(line, endLine, columns);
      else bodyLineRevealer?.(existingId, line, endLine, columns);
    }
    flashCardPane(store, existingId);
    return;
  }

  // No card holds this exact path, so it gets one of its own. A `line`
  // seeds a one-time reveal + flash of the touched passage once the fresh
  // card binds the file.
  const seed = {
    path,
    revealOnOpen: line === undefined ? undefined : { line, endLine, columns },
    scrollTop: 0,
  };

  // Save the outgoing card's focus bag before the new card claims focus.
  // `addCard` activates the fresh card directly (no `transferFocusForActivation`
  // to run the outgoing save the reuse / newTab / existing paths get), so
  // without this the previously-focused surface — e.g. the Cards card Text Files list
  // that dispatched this open — loses its saved keyboard key view, and a later
  // Cmd-L back into it falls to default-focus (wrong section, no ring) instead
  // of restoring the row the user was on ([L23] save-before-activation).
  const outgoing = store.getFirstResponderCardId();
  if (outgoing !== null) store.invokeSaveCallback(outgoing);
  const cardId = store.addCard("text", seed, {
    origin: originCardId ?? outgoing,
  });
  if (cardId !== null) flashCardPane(store, cardId);
}
