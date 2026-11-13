/**
 * `SessionShareView` — the Session card's Share shade content.
 *
 * Share mode is a shade, like Changes and History: it rises from the bottom of
 * the card's view slot, resting on the Z2 status bar, while the composer and
 * Z2 stay where they are. Unlike them it is modeless — the transcript above it
 * stays live, because that is where the turns are marked: each selectable
 * turn's first row shows a check at the right of its header, after the turn
 * address; a click toggles it and a
 * shift-click extends from the anchor. The shade itself
 * (`TugSheetContent presentation="shade" shadeModeless`) is mounted by the
 * Session card around this view; this is what sits inside it:
 *
 *  - a header strip naming the shade and how many turns are marked;
 *  - the Tool calls choice (Summaries, Full, None) and the Format choice
 *    (PDF, Image, Markdown);
 *  - one line saying how marks are made;
 *  - the actions: Preview…, Copy, Save…, Share…, and Done, which leaves the
 *    mode. Escape leaves it too.
 *
 * **Every action acts.** Each is enabled whenever a turn is marked and no
 * preview is being prepared. Nothing leaves the machine unseen, so Copy, Save…
 * and Share… on a selection that has not been previewed show the preview
 * first, with a confirm button named for the action, and act on the user's
 * confirm (`share-actions.ts`). Preview… shows it with only Done.
 *
 * The choices are `TugChoiceGroup`s, which report through the chain; the view
 * owns no state of its own and applies each report to the card's store
 * ([L11]). It reads the store with `useSyncExternalStore` ([L02]).
 *
 * Laws: [L02] store snapshot via `useSyncExternalStore`; [L03] responder
 * registration in a layout effect (`useResponder`); [L06] the enabled look is
 * the buttons' own; [L07] handlers read live; [L11] controls emit actions,
 * this view responds; [L19] component authoring guide.
 *
 * @module components/tugways/cards/session-share-view
 */

import "./session-share-view.css";

import React, { useCallback, useId, useRef } from "react";
import { Share } from "lucide-react";

import { BlockStrip } from "@/components/tugways/blocks/block-strip";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponder } from "@/components/tugways/use-responder";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import type { ShareTurnsStore } from "@/lib/share-turns-store";
import type { ShareAnchor } from "@/lib/os-share";
import type { ShareFormat, ShareToolMode } from "@/lib/share-turns";

const TOOL_MODE_ITEMS: TugChoiceItem[] = [
  { value: "summaries", label: "Summaries" },
  { value: "full", label: "Full" },
  { value: "none", label: "None" },
];

const FORMAT_ITEMS: TugChoiceItem[] = [
  { value: "pdf", label: "PDF" },
  { value: "png", label: "Image" },
  { value: "markdown", label: "Markdown" },
];

function isToolMode(value: string): value is ShareToolMode {
  return value === "summaries" || value === "full" || value === "none";
}

function isFormat(value: string): value is ShareFormat {
  return value === "markdown" || value === "pdf" || value === "png";
}

/** "1 turn", "3 turns", or "No turns marked". */
export function shareCountLabel(count: number): string {
  if (count === 0) return "No turns marked";
  return count === 1 ? "1 turn" : `${count} turns`;
}

export interface SessionShareViewProps {
  store: ShareTurnsStore;
  onPreview: () => void;
  onCopy: () => void;
  onSave: () => void;
  /**
   * Share… — handed a reader of the button's rect in this page's viewport,
   * read when the picker is about to show (after any preview), for its anchor.
   */
  onShare: (anchor: () => ShareAnchor | null) => void;
  /** Leave share mode — Done and Escape. */
  onDone: () => void;
  /** Mark every selectable turn — the card knows which those are. */
  onMarkAll: () => void;
}

export function SessionShareView({
  store,
  onPreview,
  onCopy,
  onSave,
  onShare,
  onDone,
  onMarkAll,
}: SessionShareViewProps): React.ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const count = snapshot.selected.size;
  const canAct = count > 0 && !snapshot.rendering;

  const toolSenderId = useId();
  const formatSenderId = useId();
  const viewResponderId = useId();

  const { ResponderScope, responderRef } = useResponder({
    id: viewResponderId,
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const value = event.value;
        if (typeof value !== "string") return;
        if (event.sender === toolSenderId && isToolMode(value)) store.setToolMode(value);
        else if (event.sender === formatSenderId && isFormat(value)) store.setFormat(value);
      },
    },
  });

  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const share = useCallback(() => {
    onShare(() => {
      const rect = shareButtonRef.current?.getBoundingClientRect();
      return rect === undefined ? null : { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    });
  }, [onShare]);

  return (
    <ResponderScope>
      <div
        ref={responderRef as (el: HTMLDivElement | null) => void}
        className="session-share-view"
        data-slot="session-share-view"
        data-testid="session-share-view"
        data-rendering={snapshot.rendering ? "true" : undefined}
        role="group"
        aria-label="Share turns"
      >
        <div className="tug-sheet-shade-header">
          <BlockStrip
            altitude="section"
            className="tool-call-header"
            dataTestid="session-share-header"
            leading={
              <span className="tool-call-header-leading tug-line-box" aria-hidden="true">
                <Share size={14} />
              </span>
            }
            name="Share Turns"
            detail={<span data-testid="session-share-count">{shareCountLabel(count)}</span>}
            actions={
              <>
                <TugPushButton
                  size="sm"
                  emphasis="ghost"
                  role="action"
                  onClick={onMarkAll}
                  data-testid="session-share-mark-all"
                >
                  Mark All
                </TugPushButton>
                <TugPushButton
                  size="sm"
                  emphasis="ghost"
                  role="action"
                  disabled={count === 0}
                  onClick={() => store.clearMarks()}
                  data-testid="session-share-clear"
                >
                  Clear
                </TugPushButton>
              </>
            }
          />
        </div>
        {/* The one thing to do first, said first and said plainly: the
            checks are in the transcript, at the right of each turn. */}
        <div className="session-share-view__instruction" data-testid="session-share-instruction">
          <strong className="session-share-view__instruction-lead">
            Check the box at the right of each turn you want to share.
          </strong>
          <span className="session-share-view__instruction-more">
            Shift-click a box to mark every turn between it and the last one you clicked.
          </span>
        </div>
        <div className="session-share-view__fields">
          <span className="session-share-view__field">
            <span className="session-share-view__field-label">Tool calls</span>
            <TugChoiceGroup
              items={TOOL_MODE_ITEMS}
              value={snapshot.toolMode}
              senderId={toolSenderId}
              size="sm"
              commit="live"
              aria-label="Tool calls"
              data-testid="session-share-tool-mode"
            />
          </span>
          <span className="session-share-view__field">
            <span className="session-share-view__field-label">Format</span>
            <TugChoiceGroup
              items={FORMAT_ITEMS}
              value={snapshot.format}
              senderId={formatSenderId}
              size="sm"
              commit="live"
              aria-label="Format"
              data-testid="session-share-format"
            />
          </span>
        </div>
        <div className="session-share-view__actions tug-sheet-actions">
          {snapshot.rendering ? (
            <span className="session-share-view__rendering" data-testid="session-share-rendering" role="status">
              <TugProgressIndicator variant="spinner" state="running" tone="inherit" size={12} />
              Rendering…
            </span>
          ) : null}
          <span className="session-share-view__spacer" />
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            disabled={!canAct}
            onClick={onPreview}
            data-testid="session-share-preview"
          >
            Preview…
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            disabled={!canAct}
            onClick={onCopy}
            data-testid="session-share-copy"
          >
            Copy
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            disabled={!canAct}
            onClick={onSave}
            data-testid="session-share-save"
          >
            Save…
          </TugPushButton>
          <TugPushButton
            ref={shareButtonRef}
            size="sm"
            emphasis="outlined"
            role="action"
            disabled={!canAct}
            onClick={share}
            data-testid="session-share-share"
          >
            Share…
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="primary"
            role="action"
            onClick={onDone}
            data-testid="session-share-done"
          >
            Done
          </TugPushButton>
        </div>
      </div>
    </ResponderScope>
  );
}
