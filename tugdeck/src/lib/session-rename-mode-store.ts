/**
 * `sessionRenameModeStore` — which Session cards have their masthead's name
 * open for editing in place.
 *
 * Rename has several doors — the masthead's right-click item, the pencil
 * beside the name, bare `/rename`, Session › Rename Session… — and one editor,
 * in the masthead's title line. Every door sets this one flag and the masthead
 * reads it, so the doors cannot drift into behaviours of their own.
 *
 * The flag is structure, not appearance: it decides whether an input exists
 * where the name stands, and the slash command and the menu bar set it from
 * outside the masthead. So it is a store the masthead subscribes to ([L02],
 * [L24]) rather than state the masthead keeps.
 *
 * Module-level singleton, matching the other card-scoped helper stores. Every
 * writer and the one reader live in the card's own page.
 *
 * @module lib/session-rename-mode-store
 */

import { useCallback } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { Subscribable } from "./subscribable";

const NONE: ReadonlySet<string> = new Set();

/**
 * What a commit of `draft` over the current `name` should do: nothing when the
 * trimmed draft is the name already (or both are empty), otherwise rename to
 * the trimmed draft — which is a clear when it is blank. A click-away from an
 * untouched field is not a rename.
 */
export function sessionRenameCommit(
  name: string | null,
  draft: string,
): { rename: false } | { rename: true; name: string } {
  const next = draft.trim();
  if (next === (name ?? "").trim()) return { rename: false };
  return { rename: true, name: next };
}

class SessionRenameModeStore extends Subscribable {
  private state: ReadonlySet<string> = NONE;
  private committers = new Map<string, (name: string) => void>();

  /** Whether this card's masthead is in rename mode. */
  isRenaming = (cardId: string | undefined | null): boolean =>
    cardId !== undefined && cardId !== null && this.state.has(cardId);

  /** Open the editor on `cardId`'s masthead. A no-op when it is already open. */
  begin(cardId: string): void {
    if (this.state.has(cardId)) return;
    const next = new Set(this.state);
    next.add(cardId);
    this.state = next;
    this.notify();
  }

  /** Close it — on commit and on cancel alike. A no-op when it is not open. */
  end(cardId: string): void {
    if (!this.state.has(cardId)) return;
    const next = new Set(this.state);
    next.delete(cardId);
    this.state = next;
    this.notify();
  }

  /**
   * Say how `cardId` commits a name. The Session card registers its own
   * commit here because the outcome is reported in the card's bulletin, which
   * the masthead — chrome above the card host — cannot reach. Returns the
   * release ([L27]), keyed on the function it was handed out for, so a stale
   * release cannot drop a committer a later mount has since registered.
   */
  registerCommitter(cardId: string, commit: (name: string) => void): () => void {
    this.committers.set(cardId, commit);
    return () => {
      if (this.committers.get(cardId) === commit) this.committers.delete(cardId);
    };
  }

  /**
   * Commit `name` through the card's registered committer. `false` when the
   * card registered none, so the caller can commit another way rather than
   * drop the gesture ([L31]).
   */
  commit(cardId: string, name: string): boolean {
    const commit = this.committers.get(cardId);
    if (commit === undefined) return false;
    commit(name);
    return true;
  }
}

export const sessionRenameModeStore = new SessionRenameModeStore();

/** Stable no-op subscribe for a surface with no card to rename. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** Stable `false` for the same. */
const NEVER_RENAMING = (): boolean => false;

/**
 * Whether THIS card's masthead is in rename mode. The snapshot is the card's
 * own boolean, so another card entering or leaving the mode re-renders nothing
 * here, and a surface with no card id registers no listener at all.
 */
export function useSessionRenameMode(
  cardId: string | undefined | null,
): boolean {
  return useSyncExternalStore(
    cardId === undefined || cardId === null
      ? NOOP_SUBSCRIBE
      : sessionRenameModeStore.subscribe,
    useCallback(() => sessionRenameModeStore.isRenaming(cardId), [cardId]),
    NEVER_RENAMING,
  );
}
