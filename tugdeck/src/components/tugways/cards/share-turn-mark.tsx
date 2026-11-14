/**
 * `ShareTurnMark` — the per-entry check a Session card shows in share mode.
 *
 * In share mode every entry of a committed turn — the user's prompt, the
 * wheel's, Claude's answer, a shell exchange, a refs run — carries a check at
 * the right of its header, just after its address; the participant glyph
 * keeps its seat. The entry is the unit: a check selects its own entry and
 * nothing else, so a prompt and its answer are checked apart. A plain click
 * toggles the entry and makes it the anchor; a shift-click selects every
 * entry from the anchor to this one; a ⌘-click toggles, as a plain click
 * does. Shift is read from the gesture record at pointerdown, as the list
 * view reads it, because the record is cleared before the click lands — and
 * from the click itself, because an answer's row does not always hand its
 * pointerdown to the mark, and a shift-click there must extend as it does on
 * a prompt's. A click with no pointer gesture behind it (Space on a focused
 * check) toggles.
 *
 * The cells reach the card's store through {@link ShareTurnsContext}, which
 * the transcript host provides, so their renderer lambdas never change
 * identity when share mode comes and goes ([L26]). Whether share mode is on
 * and whether this entry is selected are read per cell with
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
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { SessionRowDescriptor } from "@/lib/session-transcript-data-source";
import { selectableEntryKeys, shareEntryKey } from "@/lib/share-turns";
import type { ShareTurnsStore } from "@/lib/share-turns-store";

/** What a cell needs to draw and drive a mark. */
export interface ShareTurnsContextValue {
  store: ShareTurnsStore;
  codeSessionStore: CodeSessionStore;
}

/** The card's share store, provided once by the transcript host; `null` elsewhere. */
export const ShareTurnsContext = React.createContext<ShareTurnsContextValue | null>(null);

/**
 * Whether `row` carries a mark: any entry row — `user`,
 * `assistant`, `shell` or `refs` — of a committed turn. An in-flight turn has
 * no `TurnEntry` yet and carries none.
 */
export function isShareMarkRow(row: SessionRowDescriptor): boolean {
  if (row.turn === undefined) return false;
  return row.kind === "user" || row.kind === "assistant" || row.kind === "shell" || row.kind === "refs";
}

/**
 * The key of the entry `row` draws ({@link shareEntryKey}), or `null` for a
 * row that carries no mark: its turn's key and the index of its first
 * message — a prompt's own, an answer's `messageStart`, 0 for an ink turn.
 */
export function shareEntryKeyForRow(row: SessionRowDescriptor): string | null {
  if (!isShareMarkRow(row) || row.turn === undefined) return null;
  if (row.kind === "user") {
    const at = row.userMessage === undefined ? -1 : row.turn.messages.indexOf(row.userMessage);
    return at === -1 ? null : shareEntryKey(row.turn.turnKey, at);
  }
  if (row.kind === "assistant") return shareEntryKey(row.turn.turnKey, row.messageStart ?? 0);
  return shareEntryKey(row.turn.turnKey, 0);
}

/**
 * The mark for a cell's row: a {@link ShareTurnMark} while share mode is on
 * and the row has an entry key ({@link shareEntryKeyForRow}), otherwise
 * `undefined` (the row draws no check).
 */
export function useShareTurnMark(row: SessionRowDescriptor): React.ReactNode {
  const context = React.useContext(ShareTurnsContext);
  const active = useSyncExternalStore(
    context?.store.subscribe ?? noopSubscribe,
    () => context?.store.getSnapshot().active ?? false,
  );
  const entryKey = shareEntryKeyForRow(row);
  if (context === null || !active || entryKey === null || row.turn === undefined) return undefined;
  return <ShareTurnMark entryKey={entryKey} turnKey={row.turn.turnKey} context={context} />;
}

/**
 * The cell menu's share items for `row`: Share from Here…, which dispatches
 * {@link TUG_ACTIONS.SHARE_FROM_TURN} with the row's entry key for the card's
 * responder to answer. Offered on every entry row of a committed turn, and
 * only where the card provides a share store.
 */
export function useShareFromHereEntries(
  row: SessionRowDescriptor,
): () => TugEditorContextMenuEntry[] {
  const context = React.useContext(ShareTurnsContext);
  const rowRef = React.useRef(row);
  rowRef.current = row;
  return React.useCallback(() => {
    const entryKey = shareEntryKeyForRow(rowRef.current);
    if (context === null || entryKey === null) return [];
    return [
      { action: TUG_ACTIONS.SHARE_FROM_TURN, value: entryKey, label: "Share from Here…" },
    ];
  }, [context]);
}

function noopSubscribe(): () => void {
  return () => {};
}

interface ShareTurnMarkProps {
  entryKey: string;
  turnKey: string;
  context: ShareTurnsContextValue;
}

function ShareTurnMark({ entryKey, turnKey, context }: ShareTurnMarkProps): React.ReactElement {
  const { store, codeSessionStore } = context;
  const checked = useSyncExternalStore(store.subscribe, () => store.isSelected(entryKey));
  // The pointerdown's modifiers, held for the click that follows it.
  const extendRef = React.useRef(false);
  const onPointerDown = React.useCallback(() => {
    extendRef.current = currentGesture()?.shiftKey === true;
  }, []);
  const onClick = React.useCallback((event: React.MouseEvent) => {
    const extend = extendRef.current || event.shiftKey;
    extendRef.current = false;
    if (extend) {
      store.extendTo(entryKey, selectableEntryKeys(codeSessionStore.getSnapshot().transcript));
    } else {
      store.toggle(entryKey);
    }
  }, [store, codeSessionStore, entryKey]);
  return (
    <button
      type="button"
      role="checkbox"
      className="share-turn-mark"
      data-slot="share-turn-mark"
      data-testid="share-turn-mark"
      data-turn-key={turnKey}
      data-entry-key={entryKey}
      data-checked={checked ? "true" : "false"}
      aria-checked={checked}
      aria-label="Share this entry"
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
