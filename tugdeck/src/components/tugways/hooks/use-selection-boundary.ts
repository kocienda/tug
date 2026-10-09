/**
 * useSelectionBoundary -- Register a card's root div as a SelectionGuard boundary.
 *
 * Card authors never call this hook directly — it is called internally by
 * `CardHost` to register the card-host div (`[data-card-host][data-card-id]`)
 * with the SelectionGuard singleton. One boundary entry per card, even when
 * multiple cards share the same pane's content area (tab-group panes).
 *
 * ## How it fits
 *
 * SelectionGuard is a module-level singleton that clips selection at runtime
 * when a drag or keyboard extension escapes a card's boundary. It needs to
 * know which `HTMLElement` corresponds to each card's content area so it can:
 *   - Start tracking when `pointerdown` lands inside the element
 *   - Clamp selection focus to the element's bounding rect during drag
 *   - Clip keyboard-driven selection extension via `selectionchange`
 *   - Identify the "owning" card for a given DOM anchor
 *
 * This hook is an appearance-zone hook: it produces no React state, no
 * re-renders, and registers/unregisters purely as a side effect.
 *
 * @module hooks/use-selection-boundary
 */

import { useLayoutEffect } from "react";
import { selectionGuard } from "../selection-guard";

/**
 * Register a card's root element as a selection boundary with SelectionGuard.
 *
 * Calls `selectionGuard.registerBoundary(cardId, element)` when the ref
 * attaches, and `selectionGuard.unregisterBoundary(cardId)` on cleanup
 * (component unmount or cardId change).
 *
 * Safe against null refs: if `cardRootRef.current` is null when the effect
 * runs, the hook is a no-op for that render cycle.
 *
 * The `cardId` is included in the dependency array so re-registration fires
 * automatically if the card's id changes (uncommon but possible).
 *
 * @param cardId      - The card's unique identifier
 * @param cardRootRef - React ref to the card-host div
 */
export function useSelectionBoundary(
  cardId: string,
  cardRootRef: React.RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    const el = cardRootRef.current;
    if (!el) return;
    selectionGuard.registerBoundary(cardId, el);
    return () => {
      selectionGuard.unregisterBoundary(cardId);
    };
  }, [cardId, cardRootRef]);
}
