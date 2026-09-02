/**
 * text-card-open-registry.ts — live index of mounted Text cards, keyed
 * by card id, exposing each card's bound path and a reveal hook.
 *
 * The `open-file` action uses this for path-keyed reuse: opening a
 * path that is already bound to a Text card activates that card and
 * jumps to the requested line instead of spawning a duplicate — two
 * cards live-editing the same file would fight through the
 * filesystem watcher.
 *
 * Entries are registered by `TextCardContent` in a layout effect and
 * removed on unmount. Callbacks read live state at call time ([L07]).
 *
 * @module lib/text-card-open-registry
 */

export interface TextCardOpenEntry {
  /** The card's canonically-bound path, or null before binding. */
  getPath(): string | null;
  /**
   * The card's display name — the bound file's basename, or the buffer's
   * untitled name (`"Untitled"`, `"Untitled-2"`, …) before it binds a path.
   * Null before the buffer names itself. The Cards card Text Files list titles an
   * unbound (path-less) row from this.
   */
  getDisplayName(): string | null;
  /**
   * True when the card has unsaved in-memory edits (manual mode). The
   * `"reuse"` open target never rebinds a dirty card — rebinding tears
   * down the buffer.
   */
  isDirty(): boolean;
  /**
   * True when the card wears its unsaved-changes mark — manual mode with a
   * dirty buffer. Narrower than {@link isDirty}, which counts the transient
   * non-clean states an automatic-save buffer passes through. The Cards card Text
   * Files row paints the same dot the card header does.
   */
  hasUnsavedMark(): boolean;
  /**
   * Reveal line(s) and momentarily flash them in the theme accent —
   * caret at `line` (1-based), a fading accent wash over `line`..`endLine`
   * (or just `line`). No persistent selection. A `columns` pair narrows the
   * wash to a character range within `line` — 0-based and half-open, the
   * shape a search ref's match span arrives in.
   */
  revealLine(
    line: number,
    endLine?: number,
    columns?: readonly [number, number],
  ): void;
  /**
   * Rebind this card to a different file (the "reuse frontmost card"
   * open target). Flushes any pending edits to the current file first,
   * then reads `path` and reveals `line`..`endLine` (1-based) if given,
   * narrowed to `columns` within `line` when the reference names a span.
   */
  openFile(
    path: string,
    line?: number,
    endLine?: number,
    columns?: readonly [number, number],
  ): void;
}

const entries = new Map<string, TextCardOpenEntry>();

/** Observers notified when the set of open cards — or a card's bound path —
 *  changes, or its unsaved mark sets or clears. A card binds its path
 *  asynchronously (mount → file read), so a consumer that projects open cards
 *  (the Cards card Text Files list) must re-read when the binding lands, not just
 *  when the card mounts. */
const listeners = new Set<() => void>();
let version = 0;

/** Subscribe to registry changes (register / unregister / path-bind /
 *  unsaved-mark flip). */
export function subscribeOpenTextCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A monotonic token that bumps on every registry change — a
 *  `useSyncExternalStore` snapshot paired with {@link subscribeOpenTextCards}. */
export function getOpenTextCardsVersion(): number {
  return version;
}

/** Notify observers that a card's binding changed (its path resolved, say),
 *  even though the entry object is the same. Called by a Text card when its
 *  bound path changes. */
export function notifyOpenTextCardsChanged(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function registerOpenTextCard(
  cardId: string,
  entry: TextCardOpenEntry,
): void {
  entries.set(cardId, entry);
  notifyOpenTextCardsChanged();
}

export function unregisterOpenTextCard(cardId: string): void {
  if (entries.delete(cardId)) notifyOpenTextCardsChanged();
}

/** The open-file entry for `cardId`, or null when not a mounted Text card. */
export function getOpenTextCard(cardId: string): TextCardOpenEntry | null {
  return entries.get(cardId) ?? null;
}

/**
 * Find the card currently bound to `path` (exact canonical-string
 * match). Returns the card id and entry, or null.
 */
export function findTextCardByPath(
  path: string,
): { cardId: string; entry: TextCardOpenEntry } | null {
  for (const [cardId, entry] of entries) {
    if (entry.getPath() === path) return { cardId, entry };
  }
  return null;
}
