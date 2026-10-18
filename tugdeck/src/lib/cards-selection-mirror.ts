/**
 * cards-selection-mirror.ts — one layout selection across the shell and the
 * Cards card's body.
 *
 * The Cards list builds the selection and moves its cursor in the Cards
 * card's body; `resolveLayoutSelection`, the menu's facts, Escape's shrink and
 * the deck verbs read them in the shell, and the slot picker reads the
 * selection in the body. Each page holds its own `cardsSelectionStore` and
 * cursor, so the two are kept one:
 *
 * - **The body says what it changed.** A change the body's list makes goes to
 *   the shell as `deck-call` advice naming {@link SELECTION_CALLS} — the whole
 *   snapshot, so a call is idempotent — and the shell takes it
 *   ({@link applySelectionCall}). The cursor goes the same way; only the body
 *   ever moves it.
 * - **The shell says what stands.** The shell's selection rides the Cards
 *   card's arrangement (`BodyArrangement.selection`), and the body takes it
 *   without saying it back ({@link mirrorSelectionInBody}). That is how a
 *   prune, a collapse on activation, the deck root's Escape and a test's
 *   write reach the list.
 *
 * Both directions send whole snapshots, so the pages converge on the last
 * write the shell took: a body write the shell has not yet heard is
 * overwritten by the shell's older word for one round trip, then restored
 * when the shell echoes the write it took.
 *
 * @module lib/cards-selection-mirror
 */

import {
  cardsSelectionStore,
  setLayoutCursorCard,
  subscribeLayoutCursorCard,
  getLayoutCursorCard,
  type CardsSelectionStore,
  type LensSelectionSnapshot,
} from "./cards-selection-store";

/** The selection calls a Cards body may send as `deck-call` advice. */
export const SELECTION_CALLS = ["setLayoutSelection", "setLayoutCursorCard"] as const;

export type SelectionCall = (typeof SELECTION_CALLS)[number];

/** Whether `method` is one of {@link SELECTION_CALLS}. */
export function isSelectionCall(method: string): method is SelectionCall {
  return (SELECTION_CALLS as readonly string[]).includes(method);
}

/** `value` as a selection snapshot, or null when it is not one. */
export function parseSelectionSnapshot(value: unknown): LensSelectionSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const { ids, anchorId } = value as { ids?: unknown; anchorId?: unknown };
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return null;
  if (anchorId !== null && typeof anchorId !== "string") return null;
  return { ids: ids as string[], anchorId };
}

/**
 * Run a selection call a Cards body sent, in the shell. Returns whether it
 * was well formed; a malformed one changes nothing.
 */
export function applySelectionCall(
  method: SelectionCall,
  args: readonly unknown[],
  selection: CardsSelectionStore = cardsSelectionStore,
  setCursor: (cardId: string | null) => void = setLayoutCursorCard,
): boolean {
  if (method === "setLayoutCursorCard") {
    const cardId = args[0];
    if (cardId !== null && typeof cardId !== "string") return false;
    setCursor(cardId);
    return true;
  }
  const snapshot = parseSelectionSnapshot(args[0]);
  if (snapshot === null) return false;
  selection.replace(snapshot);
  return true;
}

/** The body's half: what it sends, and the door the shell's word comes in by. */
export interface BodySelectionMirror {
  /** Take the shell's selection (an arrangement's `selection`), without sending it back. */
  applyShell(value: unknown): void;
  release(): void;
}

/**
 * Keep a Cards body's selection and cursor one with the shell's: every change
 * this page makes goes out through `send`, and {@link BodySelectionMirror.applyShell}
 * takes the shell's without echoing it.
 */
export function mirrorSelectionInBody(
  send: (method: SelectionCall, args: unknown[]) => void,
  selection: CardsSelectionStore = cardsSelectionStore,
  cursor: {
    get: () => string | null;
    subscribe: (listener: () => void) => () => void;
  } = { get: getLayoutCursorCard, subscribe: subscribeLayoutCursorCard },
): BodySelectionMirror {
  let applying = false;
  const releaseSelection = selection.subscribe(() => {
    if (applying) return;
    const { ids, anchorId } = selection.getSnapshot();
    send("setLayoutSelection", [{ ids: [...ids], anchorId }]);
  });
  const releaseCursor = cursor.subscribe(() => send("setLayoutCursorCard", [cursor.get()]));
  return {
    applyShell(value) {
      const snapshot = parseSelectionSnapshot(value);
      if (snapshot === null) return;
      applying = true;
      try {
        selection.replace(snapshot);
      } finally {
        applying = false;
      }
    },
    release() {
      releaseSelection();
      releaseCursor();
    },
  };
}
