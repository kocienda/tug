/**
 * cards-cell-context.tsx — the verbs the Workspaces card's body hands its
 * module-level cell renderers.
 *
 * Its own module rather than a export from `cards-card.tsx` because the
 * workspace header cell lives in its own file now ([P09], Spec S05) and both
 * files need the channel: a context declared beside one of its consumers would
 * make the two import each other.
 *
 * Everything here is a callback into the card body or a fact it holds. Nothing
 * on it is state a cell owns — a cell is recycled as the list scrolls, so the
 * rename in flight and the workspace count are the body's ([L24]).
 *
 * @module components/cards/cards-cell-context
 */

import React from "react";

import type { CardsGroup } from "./cards-groups";

/**
 * Where the inline rename field registers as a focus stop.
 *
 * It has to be one. The card engages keyboard-focus mode at rest, and in that
 * mode the keyboard is **engine-routed**: a keystroke is delivered to the key
 * view rather than to whatever holds DOM focus. A field that merely called
 * `.focus()` on itself would stand there with a caret and receive nothing. So
 * the field registers here and the card places the key view on it ([L22] — the
 * FocusManager moves the keyboard, never a raw focus write), which is what
 * routes the keys to the DOM and gives the field its caret.
 *
 * One order ahead of the filter field's, and the two never coexist in the walk
 * for long: exactly one rename can be open at a time.
 */
export const CARDS_RENAME_FOCUS_ORDER = -2;

/** Row verbs the section body hands the module-level cells. */
export interface CardsCellContextValue {
  onRowPointerDown: (orderKey: string, event: React.PointerEvent) => void;
  onClose: (cardId: string) => void;
  onClosePane: (paneId: string, activeCardId: string) => void;
  onGroupPointerDown: (
    spaceId: string,
    group: CardsGroup,
    event: React.PointerEvent,
  ) => void;
  onToggleGroup: (group: CardsGroup) => void;
  /** A workspace header is its run's drag handle ([P10]). */
  onSpacePointerDown: (spaceId: string, event: React.PointerEvent) => void;
  /** The fold cue on an inactive workspace's header ([P09]). */
  onToggleSpace: (spaceId: string) => void;
  /** The workspace whose header is showing its rename field, if any. */
  renamingSpaceId: string | null;
  /** Enter, or a blur that was not an Escape: rename and leave the field. */
  onCommitRename: (spaceId: string, name: string) => void;
  /** Escape: leave the field with the name it had. */
  onCancelRename: () => void;
  /** The card's focus group — where the rename field registers. */
  focusGroup: string;
  /** Put the keyboard on the rename field that just mounted ([L22]). */
  focusRenameField: () => void;
  /** How many workspaces there are — what disables Delete on the last one. */
  spaceCount: number;
  filterQuery: string;
}

export const CardsCellContext =
  React.createContext<CardsCellContextValue | null>(null);

export function useCellContext(): CardsCellContextValue {
  const ctx = React.useContext(CardsCellContext);
  if (ctx === null) throw new Error("Cards cell rendered outside its section");
  return ctx;
}
