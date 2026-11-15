/**
 * text-card-status-bar.tsx — the thin status strip at the bottom of a
 * Text card's editor, in the spirit of BBEdit's document status bar.
 *
 * Two clusters: the **number** pair on the left (caret line/column, then
 * after a gap the line / word / character counts — the selection's when a
 * range is selected, else the document's), and the **settable** cluster on
 * the right: the Preview toggle, then the syntax/file type and line-ending
 * popups. The toggle is there only while the file type is Markdown, and it
 * sits beside the file type because that popup decides whether it exists;
 * the cluster is anchored to the trailing edge, so the toggle coming or
 * going moves nothing else. The numbers change at keystroke rate, so they
 * hold the leading edge and grow
 * into the open space between the clusters; nothing in the strip moves
 * when they do. The save state rides the card's document masthead, where
 * the name and the path it belongs to already are.
 *
 * Live counts + caret ride the per-card `EditorStatsStore`
 * (`useSyncExternalStore`), so keystroke-rate updates repaint only this
 * strip; the line-ending comes from the `TextCardStore` snapshot the card
 * already subscribes to. The two popups dispatch through this panel's
 * `useResponderForm` responder. The preview flag is the card's: the toggle
 * is told whether it is on and reports a press.
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
import { TugPushButton } from "../tug-push-button";
import { useResponderForm } from "../use-responder-form";
import { TUG_ACTIONS } from "../action-vocabulary";
import type { EditorStatsStore } from "@/lib/editor-stats-store";
import type { LineEnding } from "@/lib/text-card-store";
import {
  MARKDOWN_LANGUAGE_ID,
  SELECTABLE_LANGUAGES,
} from "@/lib/language-registry";

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
   * Whether the card is showing the rendered Markdown preview. Lights the
   * Preview toggle, which renders only while `languageId` is Markdown. A
   * preview has no caret and takes no edits, so the caret cell is hidden
   * (it keeps its width; the counts hold still) and the line-ending popup,
   * whose every choice is an edit, is disabled. The file-type popup stays
   * live: it is the way back out for a file set to Markdown by hand.
   */
  previewing: boolean;
  /**
   * The responder that answers the Preview toggle's command: the card's
   * card-content responder, which also answers its menu row and its chord.
   * Named because a button asks its dispatch target directly, and the
   * strip's own form responder between them does not handle the action.
   */
  previewTarget: string;
  /**
   * Register the strip's controls as focus-engine stops in this group. The
   * Text card passes its cycle group, which is what puts the Preview toggle
   * and the file-type and line-ending menus on the Tab tour ([P09]/[P10]);
   * omit and the strip is mouse-only.
   */
  focusGroup?: string;
  /**
   * Order of the Preview toggle; the file-type and line-ending popups take
   * the next two slots, the order the cluster reads in.
   */
  focusOrder?: number;
}

export function TextCardStatusBar({
  statsStore,
  lineEnding,
  onSetLineEnding,
  languageId,
  onSetLanguage,
  previewing,
  previewTarget,
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
        data-previewing={previewing ? "true" : undefined}
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* Number pair, on the leading edge. */}
        <div className="text-card-status-group text-card-status-group--numbers">
          <span
            className="text-card-status-cell text-card-status-caret"
            data-testid="text-card-status-caret"
            aria-hidden={previewing ? true : undefined}
          >
            {`L: ${stats.caretLine}  C: ${stats.caretCol}`}
          </span>
          <span
            className="text-card-status-cell text-card-status-counts"
            data-testid="text-card-status-counts"
            data-of-selection={stats.ofSelection ? "true" : undefined}
            title={
              stats.ofSelection
                ? "lines / words / characters in the selection"
                : "lines / words / characters"
            }
          >
            {`${stats.lines.toLocaleString()} / ${stats.words.toLocaleString()} / ${stats.chars.toLocaleString()}`}
          </span>
        </div>

        {/* Settable cluster, pushed to the trailing edge. */}
        <div className="text-card-status-group text-card-status-group--settable">
          {languageId === MARKDOWN_LANGUAGE_ID ? (
            <TugPushButton
              className="text-card-status-preview"
              data-testid="text-card-status-preview"
              size="xs"
              emphasis="outlined"
              role="option"
              pressed={previewing}
              action={TUG_ACTIONS.TOGGLE_MARKDOWN_PREVIEW}
              target={previewTarget}
              focusGroup={focusGroup}
              focusOrder={focusOrder}
            >
              Preview
            </TugPushButton>
          ) : null}
          <TugPopupButton
            size="xs"
            label={languageLabel}
            items={LANGUAGE_ITEMS}
            senderId={languageSenderId}
            focusGroup={focusGroup}
            focusOrder={focusOrder + 1}
          />
          <TugPopupButton
            size="xs"
            label={LINE_ENDING_LABEL[lineEnding]}
            items={LINE_ENDING_ITEMS}
            senderId={lineEndingSenderId}
            disabled={previewing}
            focusGroup={focusGroup}
            focusOrder={focusOrder + 2}
          />
        </div>
      </div>
    </ResponderScope>
  );
}
