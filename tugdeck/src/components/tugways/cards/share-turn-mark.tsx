/**
 * `ShareTurnMark` — the per-turn check a Session card shows in share mode.
 *
 * In share mode each selectable turn's first row carries a check in place of
 * its participant glyph. A plain click toggles the turn and makes it the
 * anchor; a shift-click marks every selectable turn from the anchor to this
 * one; a ⌘-click toggles, as a plain click does. The modifiers are read from
 * the gesture record at pointerdown, as the list view reads them, because the
 * record is cleared before the click lands; a click with no pointer gesture
 * behind it (Space on a focused check) toggles.
 *
 * The cells reach the card's store through {@link ShareTurnsContext}, which
 * the transcript host provides, so their renderer lambdas never change
 * identity when share mode comes and goes ([L26]). Whether share mode is on
 * and whether this turn is marked are read per cell with
 * `useSyncExternalStore` ([L02]); the checked look is `aria-checked` and
 * `data-checked`, painted by CSS ([L06]).
 *
 * @module components/tugways/cards/share-turn-mark
 */

import "./share-turn-mark.css";

import React from "react";
import { Check } from "lucide-react";

import { currentGesture } from "@/gesture-interpreter";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { TugEditorContextMenuEntry } from "@/components/tugways/tug-editor-context-menu";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import type { CodeSessionStore, TurnEntry } from "@/lib/code-session-store";
import type { SessionRowDescriptor } from "@/lib/session-transcript-data-source";
import { isSelectableTurn, selectableTurnKeys } from "@/lib/share-turns";
import type { ShareTurnsStore } from "@/lib/share-turns-store";

/** What a cell needs to draw and drive a mark. */
export interface ShareTurnsContextValue {
  store: ShareTurnsStore;
  codeSessionStore: CodeSessionStore;
}

/** The card's share store, provided once by the transcript host; `null` elsewhere. */
export const ShareTurnsContext = React.createContext<ShareTurnsContextValue | null>(null);

/**
 * Whether `row` is the first row of a selectable committed turn — the row
 * that carries the turn's mark. That is the turn's opening `user` row, or,
 * for a turn that opens with no user message, its first `assistant` row.
 * `ordinal` is the row's within-turn ordinal among rows of its kind.
 */
export function isShareLeadRow(row: SessionRowDescriptor, ordinal: number): boolean {
  const turn = row.turn;
  if (turn === undefined || !isSelectableTurn(turn)) return false;
  const opensWithUser = turn.messages[0]?.kind === "user_message";
  if (row.kind === "user") return opensWithUser && ordinal === 0;
  if (row.kind === "assistant") return !opensWithUser && row.messageStart === 0;
  return false;
}

/**
 * The mark for a cell's row: a {@link ShareTurnMark} while share mode is on
 * and `lead` says the row is its turn's first, otherwise `undefined` (the
 * glyph draws).
 */
export function useShareTurnMark(turn: TurnEntry | undefined, lead: boolean): React.ReactNode {
  const context = React.useContext(ShareTurnsContext);
  const active = useSyncExternalStore(
    context?.store.subscribe ?? noopSubscribe,
    () => context?.store.getSnapshot().active ?? false,
  );
  if (context === null || !active || !lead || turn === undefined) return undefined;
  return <ShareTurnMark turnKey={turn.turnKey} context={context} />;
}

/**
 * The cell menu's turn items for a row of `turn`: Share from Here…, which
 * dispatches {@link TUG_ACTIONS.SHARE_FROM_TURN} with the turn's key for the
 * card's responder to answer. Offered on every row of a selectable committed
 * turn, and only where the card provides a share store.
 */
export function useShareFromHereEntries(
  turn: TurnEntry | undefined,
): () => TugEditorContextMenuEntry[] {
  const context = React.useContext(ShareTurnsContext);
  const turnRef = React.useRef(turn);
  turnRef.current = turn;
  return React.useCallback(() => {
    const live = turnRef.current;
    if (context === null || live === undefined || !isSelectableTurn(live)) return [];
    return [
      { action: TUG_ACTIONS.SHARE_FROM_TURN, value: live.turnKey, label: "Share from Here…" },
    ];
  }, [context]);
}

function noopSubscribe(): () => void {
  return () => {};
}

interface ShareTurnMarkProps {
  turnKey: string;
  context: ShareTurnsContextValue;
}

function ShareTurnMark({ turnKey, context }: ShareTurnMarkProps): React.ReactElement {
  const { store, codeSessionStore } = context;
  const checked = useSyncExternalStore(store.subscribe, () => store.isSelected(turnKey));
  // The pointerdown's modifiers, held for the click that follows it.
  const extendRef = React.useRef(false);
  const onPointerDown = React.useCallback(() => {
    extendRef.current = currentGesture()?.shiftKey === true;
  }, []);
  const onClick = React.useCallback(() => {
    const extend = extendRef.current;
    extendRef.current = false;
    if (extend) {
      store.extendTo(turnKey, selectableTurnKeys(codeSessionStore.getSnapshot().transcript));
    } else {
      store.toggle(turnKey);
    }
  }, [store, codeSessionStore, turnKey]);
  return (
    <button
      type="button"
      role="checkbox"
      className="share-turn-mark"
      data-slot="share-turn-mark"
      data-testid="share-turn-mark"
      data-turn-key={turnKey}
      data-checked={checked ? "true" : "false"}
      aria-checked={checked}
      aria-label="Share this turn"
      // The keyboard stays where it is — the share bar's controls — so
      // Escape still leaves the mode after a run of clicks.
      data-tug-focus="refuse"
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <Check className="share-turn-mark__check" aria-hidden="true" />
    </button>
  );
}
