/**
 * `useSessionPromptInsertTarget` — the Session card's {@link PromptInsertTarget},
 * built where the deck and the card id are in scope.
 *
 * The adapter itself is pure (`sessionPromptInsertTarget`); what needs React
 * is `raise`, which activates the annotation's own card. Read from context
 * rather than props: every surface that shows annotations already renders
 * inside a card host, and threading the deck down through a cell tree would be
 * ceremony. Read optionally, because a gallery fixture mounts these surfaces
 * outside a deck and an entity menu is not the thing that should refuse to
 * exist there.
 *
 * Returns `undefined` for a surface with no live session, which is how the
 * menu knows not to offer `Insert into Prompt` at all rather than to offer it
 * dead.
 *
 * @module components/tugways/use-prompt-insert-target
 */

import { useContext, useMemo } from "react";

import { DeckManagerContext } from "@/deck-manager-context";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import type { CodeSessionStore } from "@/lib/code-session-store";
import {
  sessionPromptInsertTarget,
  type PromptInsertTarget,
} from "@/lib/prompt-insert-target";

export function useSessionPromptInsertTarget(
  codeSessionStore: CodeSessionStore,
): PromptInsertTarget;
export function useSessionPromptInsertTarget(
  codeSessionStore?: CodeSessionStore,
): PromptInsertTarget | undefined;
export function useSessionPromptInsertTarget(
  codeSessionStore?: CodeSessionStore,
): PromptInsertTarget | undefined {
  const deck = useContext(DeckManagerContext);
  const cardId = useCardId();
  return useMemo(() => {
    if (codeSessionStore === undefined) return undefined;
    return sessionPromptInsertTarget(codeSessionStore, () => {
      if (cardId !== null && deck !== null) deck.activateCard(cardId);
    });
  }, [codeSessionStore, cardId, deck]);
}
