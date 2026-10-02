/**
 * text-card-status-bar.tsx — the thin status strip at the bottom of a
 * Text card's editor, in the spirit of BBEdit's document status bar.
 *
 * Two clusters on the right: the **settable** pair (line-ending and
 * syntax/file type, each a popup menu) and the **number** pair (caret
 * line/column and the line / word / character counts), separated by a
 * divider. The save state used to sit alone on the left; it says the same
 * thing on the card's document masthead now, where the name and the path
 * it belongs to already are.
 *
 * Live counts + caret ride the per-card `EditorStatsStore`
 * (`useSyncExternalStore`), so keystroke-rate updates repaint only this
 * strip; the line-ending comes from the `TextCardStore` snapshot the card
 * already subscribes to. The two popups dispatch through this panel's
 * `useResponderForm` responder.
 *
 * Laws: layout-only CSS in text-card.css [L06]; stats enter through
 * `useSyncExternalStore` [L02]; the popups emit actions to this panel's
 * responder ([L11]); composes real Tug components [use-tug-components].
 *
 * @module components/tugways/cards/text-card-status-bar
 */

import React, { useId } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { TugPopupButton, type TugPopupButtonItem } from "../tug-popup-button";
import { useResponderForm } from "../use-responder-form";
import { TUG_ACTIONS } from "../action-vocabulary";
import type { EditorStatsStore } from "@/lib/editor-stats-store";
import type { LineEnding } from "@/lib/text-card-store";
import { SELECTABLE_LANGUAGES } from "@/lib/language-registry";

const LINE_ENDING_LABEL: Record<LineEnding, string> = {
  LF: "Unix (LF)",
  CRLF: "Windows (CRLF)",
  CR: "Classic Mac (CR)",
};

const LINE_ENDING_ITEMS: TugPopupButtonItem<string>[] = (
  ["LF", "CRLF", "CR"] as const
).map((ending) => ({
  action: TUG_ACTIONS.SET_VALUE,
  value: ending,
  label: LINE_ENDING_LABEL[ending],
}));

const LANGUAGE_ITEMS: TugPopupButtonItem<string>[] = SELECTABLE_LANGUAGES.map(
  (lang) => ({ action: TUG_ACTIONS.SET_VALUE, value: lang.id, label: lang.label }),
);

export interface TextCardStatusBarProps {
  statsStore: EditorStatsStore;
  lineEnding: LineEnding;
  /** Change the buffer's line-ending style. */
  onSetLineEnding: (ending: LineEnding) => void;
  /** Current selectable-language id (see `SELECTABLE_LANGUAGES`). */
  languageId: string;
  /** Override the card's syntax highlighting / file type. */
  onSetLanguage: (id: string) => void;
  /**
   * Register the two popups as focus-engine stops in this group. The Text
   * card passes its cycle group, which is what puts the line-ending and
   * file-type menus on the Tab tour ([P09]/[P10]); omit and the strip is
   * mouse-only.
   */
  focusGroup?: string;
  /** Order of the line-ending popup; the file-type popup takes the next slot. */
  focusOrder?: number;
}

export function TextCardStatusBar({
  statsStore,
  lineEnding,
  onSetLineEnding,
  languageId,
  onSetLanguage,
  focusGroup,
  focusOrder = 0,
}: TextCardStatusBarProps) {
  const stats = useSyncExternalStore(statsStore.subscribe, statsStore.getSnapshot);

  const lineEndingSenderId = useId();
  const languageSenderId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueString: {
      [lineEndingSenderId]: (v: string) => onSetLineEnding(v as LineEnding),
      [languageSenderId]: (v: string) => onSetLanguage(v),
    },
  });

  const languageLabel =
    SELECTABLE_LANGUAGES.find((l) => l.id === languageId)?.label ?? "Plain Text";

  return (
    <ResponderScope>
      <div
        className="text-card-status-bar"
        data-slot="text-card-status-bar"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* Settable pair, pushed to the right edge. */}
        <div className="text-card-status-group text-card-status-group--settable">
          <TugPopupButton
            size="xs"
            label={LINE_ENDING_LABEL[lineEnding]}
            items={LINE_ENDING_ITEMS}
            senderId={lineEndingSenderId}
            focusGroup={focusGroup}
            focusOrder={focusOrder}
          />
          <TugPopupButton
            size="xs"
            label={languageLabel}
            items={LANGUAGE_ITEMS}
            senderId={languageSenderId}
            focusGroup={focusGroup}
            focusOrder={focusOrder + 1}
          />
        </div>

        {/* Number pair, divided from the settable pair. */}
        <div className="text-card-status-group text-card-status-group--numbers">
          <span
            className="text-card-status-cell text-card-status-caret"
            data-testid="text-card-status-caret"
          >
            {`L: ${stats.caretLine}  C: ${stats.caretCol}`}
          </span>
          <span
            className="text-card-status-cell text-card-status-counts"
            data-testid="text-card-status-counts"
            title="lines / words / characters"
          >
            {`${stats.lines.toLocaleString()} / ${stats.words.toLocaleString()} / ${stats.chars.toLocaleString()}`}
          </span>
        </div>
      </div>
    </ResponderScope>
  );
}
