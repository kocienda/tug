/**
 * card-fold-glyph.tsx — the fold's door on every card that does not own its
 * folded form: a pane-owned glyph on the title bar.
 *
 * The title bar is the one chrome every content card has, so this is one
 * implementation for every card type rather than a seat authored per card
 * ([B06] of the every-card-folds brief). Open, the verb stands in the rollup
 * with the pane's other verbs (`ChevronsDownUp`). Folded, it is pinned visible
 * OUTSIDE the rollup (`ChevronsUpDown`), because a hover-revealed door is no
 * door on a card whose only gesture is to open. Both press the same
 * `toggle-card-fold` command View ▸ Fold Card and ⌃⌘Y reach ([L11]).
 *
 * While folded the card's body is `inert` (`lib/folded-body.ts`), so the
 * pinned glyph is the one live stop the card offers, and it takes the role
 * [D185] gave the Session card's control: the card's key view and its
 * Return-home ([B07]). It registers in the CARD's focus context — the pane
 * renders it under the active card's `CardIdContext` — so the card's Tab walk
 * reaches it, its default ring is the card's, and a placement by focus key
 * lands on it. {@link useCardFoldFocus} moves the keyboard across the two
 * transitions; the unfold hands it back to the card's own content.
 *
 * The Session card is not given either face: its Z2 seat is its door ([B08]).
 *
 * @module components/chrome/card-fold-glyph
 */

import React, { useLayoutEffect, useRef } from "react";
import { ChevronsUpDown } from "lucide-react";

import { isEngineManagedCard } from "@/card-registry";
import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useFocusManager } from "@/components/tugways/use-focusable";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { CardIdContext } from "@/lib/card-id-context";
import { takeBiddenUnfold } from "@/lib/card-fold";

/** The glyph's focus group — its own, so it sorts after every group a card names. */
export const CARD_FOLD_FOCUS_GROUP = "card-fold";
/** The glyph's order within {@link CARD_FOLD_FOCUS_GROUP}. */
export const CARD_FOLD_FOCUS_ORDER = 0;
/** The stable `group:order` key a placement lands the keyboard on the glyph by. */
export const CARD_FOLD_FOCUS_KEY = `${CARD_FOLD_FOCUS_GROUP}:${CARD_FOLD_FOCUS_ORDER}`;

export interface CardFoldGlyphProps {
  /** The pane's active card — the card whose focus context the glyph joins. */
  cardId: string;
}

/** The pinned glyph a folded card wears on its title bar. */
export function CardFoldGlyph({ cardId }: CardFoldGlyphProps): React.ReactElement {
  return (
    <CardIdContext value={cardId}>
      <span
        className="tug-pane-title-bar-fold-glyph"
        data-slot="tug-pane-title-bar-fold-glyph"
      >
        <TugActionTooltip action={TUG_ACTIONS.TOGGLE_CARD_FOLD} content="Unfold">
          <TugPushButton
            subtype="icon"
            emphasis="ghost"
            role="action"
            size="sm"
            aria-label="Unfold"
            persistentDefaultRing
            focusGroup={CARD_FOLD_FOCUS_GROUP}
            focusOrder={CARD_FOLD_FOCUS_ORDER}
            icon={<ChevronsUpDown size={14} aria-hidden="true" />}
            data-testid="tug-pane-title-bar-fold-glyph"
            onClick={() => dispatchCommand(TUG_ACTIONS.TOGGLE_CARD_FOLD)}
          />
        </TugActionTooltip>
      </span>
    </CardIdContext>
  );
}

/**
 * Move the keyboard across a fold of `cardId`'s pane: onto the glyph when the
 * card folds, back to the card's content when it opens ([B07]).
 *
 * Keyed on the flag's own transition, never on mount, so a deck restored
 * folded seats nobody's keyboard; and gated on the card holding first
 * responder, so a background card folding in a wall moves no keyboard. The
 * unfold hands an engine-managed card (a Text card's editor) its surface
 * through the engine hook, and any other card back to its retained key view.
 *
 * The fold moves the KEYBOARD, not the chain. The glyph lives in the pane's
 * title bar, so a placement on it settles first responder on the pane — and
 * the card's own verbs (⌘F, ⌘S, Revert…) answer from its content, below the
 * pane, where a walk from the pane never reaches. So the responder that held
 * first responder inside the card before the fold is put back, and a bidden
 * verb still finds the card that opens itself to answer it ([B09]).
 */
export function useCardFoldFocus(
  cardId: string | null,
  componentId: string | null,
  folded: boolean,
  enabled: boolean,
  firstResponderCardId: () => string | null,
): void {
  const focusManager = useFocusManager();
  const chain = useResponderChain();
  const lastFoldRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    if (lastFoldRef.current === folded) return;
    const firstRun = lastFoldRef.current === null;
    lastFoldRef.current = folded;
    // Taken on every unfold, before any gate, so a mark can never outlive the
    // unfold it was made for and silence a later, ordinary one.
    const bidden = !folded && cardId !== null && takeBiddenUnfold(cardId);
    if (firstRun || !enabled || cardId === null || focusManager === null) return;
    if (firstResponderCardId() !== cardId) return;
    if (folded) {
      const held = chain?.getFirstResponder() ?? null;
      focusManager.place(
        cardId,
        { kind: "focus-key", focusKey: CARD_FOLD_FOCUS_KEY },
        { modality: "keyboard" },
      );
      if (chain !== null && held !== null && chain.nodeIsWithin(held, cardId)) {
        chain.makeFirstResponder(held);
      }
      return;
    }
    // Opened for a surface the user asked for — find, a save sheet — which
    // takes the keyboard itself ([B09]).
    if (bidden) return;
    focusManager.contextFor(cardId).setKeyView(null);
    // The body's `inert` comes off in `lib/folded-body.ts`'s observer, whose
    // microtask was queued by this commit's own `data-folded` write and so runs
    // ahead of one queued here. A placement made now would hand focus to a
    // surface the browser still refuses.
    queueMicrotask(() => {
      if (firstResponderCardId() !== cardId) return;
      if (componentId !== null && isEngineManagedCard(componentId)) {
        focusManager.place(cardId, { kind: "engine" }, { modality: "pointer" });
      } else {
        focusManager.adoptKeyCard(cardId);
      }
    });
  }, [chain, cardId, componentId, enabled, firstResponderCardId, focusManager, folded]);
}
