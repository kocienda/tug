/**
 * `SessionShareView` — the Session card's Share shade content.
 *
 * Share mode is a shade, like Changes and History: it rises from the bottom of
 * the card's view slot, resting on the Z2 status bar, while the composer and
 * Z2 stay where they are. Unlike them it is modeless — the transcript above it
 * stays live, because that is where the turns are marked: each selectable
 * turn's first row shows a check at the right of its header, after the turn
 * address; a click toggles it and a shift-click extends from the anchor. The
 * shade itself (`TugSheetContent presentation="shade" shadeModeless`) is
 * mounted by the Session card around this view; this is what sits inside it,
 * top to bottom:
 *
 *  - **The header**, in the modal header convention every sheet and alert
 *    wears (`styles/tugx-header.css`, the two-line case): the Share icon, the
 *    title, and the instruction as its description. The title is the largest
 *    type on the shade; the instruction is a description, never a style of
 *    its own.
 *  - **Mark All and Clear All**, at the right of the title row, which is
 *    as tall as they are, with the count of marked turns before them: the
 *    buttons sit flush right, so they hold still as the count changes.
 *  - **The form**: Tools (how tool calls appear in the turns) and Format on
 *    one line, Tools' label in the header icon's column so its choices start
 *    on the left edge of the title and the description.
 *    When the shade is too narrow for one line, Format goes under Tools, its
 *    label in the same column, so the two choices still share a left edge
 *    ({@link useShareFormFit}).
 *  - **The bottom row**: Action at its left — a popup menu of what the shade
 *    can do with the marked turns: Preview…, Copy, Save…, Share… — and two
 *    buttons at its right: Cancel, which leaves the mode (Escape does too),
 *    and the action button, which wears the chosen action's name and
 *    performs it.
 *
 * The action button is enabled whenever a turn is marked and no preview is
 * being prepared. Nothing leaves the machine unseen: Copy, Save… and Share…
 * on a selection that has not been previewed show the preview first, with a
 * confirm button named for the action, and act on the user's confirm
 * (`share-actions.ts`). Preview… shows it with only Done.
 *
 * The choices and the menu report through the chain; the view owns no state
 * of its own and applies each report to the card's store ([L11]). It reads
 * the store with `useSyncExternalStore` ([L02]).
 *
 * Laws: [L02] store snapshot via `useSyncExternalStore`; [L03] responder
 * registration in a layout effect (`useResponder`); [L06] the enabled look is
 * the buttons' own; [L07] handlers read live; [L11] controls emit actions,
 * this view responds; [L19] component authoring guide; [L20] the header is
 * the sheet's own classes, not a re-drawing.
 *
 * @module components/tugways/cards/session-share-view
 */

import "./session-share-view.css";

import React, { useCallback, useId, useLayoutEffect, useRef } from "react";
import { Share } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugPopupButton, type TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponder } from "@/components/tugways/use-responder";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import type { ShareAction, ShareTurnsStore } from "@/lib/share-turns-store";
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

/** The shade's actions, in menu order, each with the name its button wears. */
export const SHARE_ACTIONS: ReadonlyArray<{ value: ShareAction; label: string }> = [
  { value: "preview", label: "Preview…" },
  { value: "copy", label: "Copy" },
  { value: "save", label: "Save…" },
  { value: "share", label: "Share…" },
];

const ACTION_ITEMS: TugPopupButtonItem<string>[] = SHARE_ACTIONS.map((action) => ({
  action: TUG_ACTIONS.SELECT_VALUE,
  value: action.value,
  label: action.label,
}));

function isToolMode(value: string): value is ShareToolMode {
  return value === "summaries" || value === "full" || value === "none";
}

function isFormat(value: string): value is ShareFormat {
  return value === "markdown" || value === "pdf" || value === "png";
}

function isAction(value: string): value is ShareAction {
  return SHARE_ACTIONS.some((action) => action.value === value);
}

/** The name the action button and the menu's trigger wear for `action`. */
export function shareActionLabel(action: ShareAction): string {
  return SHARE_ACTIONS.find((entry) => entry.value === action)?.label ?? "";
}

/**
 * Lay the share form's Tools and Format on one line when they fit and stack
 * them when they do not, by writing `data-layout="line"` or `"stack"` on the
 * form ([L06]: a DOM attribute, never React state). The line's width is read
 * while it is laid out as a line — its `scrollWidth`, which overflows when it
 * does not fit — and remembered, so a stacked form goes back to a line only
 * once the form is that wide again and never flips back and forth.
 */
export function useShareFormFit(formRef: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const form = formRef.current;
    if (form === null) return;
    let lineWidth = 0;
    const fit = (): void => {
      // A shade not laid out (closed, or not yet risen) measures nothing.
      if (form.clientWidth === 0) return;
      if (form.dataset.layout !== "stack") {
        lineWidth = form.scrollWidth;
        if (lineWidth > form.clientWidth + 0.5) form.dataset.layout = "stack";
      } else if (lineWidth > 0 && form.clientWidth >= lineWidth) {
        form.dataset.layout = "line";
        // Re-read on the line itself, in case its parts changed width.
        if (form.scrollWidth > form.clientWidth + 0.5) form.dataset.layout = "stack";
      }
    };
    form.dataset.layout = "line";
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(form);
    return () => observer.disconnect();
  }, [formRef]);
}

/** "1 turn selected", "3 turns selected", or "No turns selected". */
export function shareCountLabel(count: number): string {
  if (count === 0) return "No turns selected";
  return count === 1 ? "1 turn selected" : `${count} turns selected`;
}

export interface SessionShareViewProps {
  store: ShareTurnsStore;
  onPreview: () => void;
  onCopy: () => void;
  onSave: () => void;
  /**
   * Share… — handed a reader of the action button's rect in this page's
   * viewport, read when the picker is about to show (after any preview), for
   * its anchor.
   */
  onShare: (anchor: () => ShareAnchor | null) => void;
  /** Leave share mode — Cancel and Escape. */
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
  const actionSenderId = useId();
  const viewResponderId = useId();

  const { ResponderScope, responderRef } = useResponder({
    id: viewResponderId,
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const value = event.value;
        if (typeof value !== "string") return;
        if (event.sender === toolSenderId && isToolMode(value)) store.setToolMode(value);
        else if (event.sender === formatSenderId && isFormat(value)) store.setFormat(value);
        else if (event.sender === actionSenderId && isAction(value)) store.setAction(value);
      },
    },
  });

  // The action button performs whatever the Action menu names, read live at
  // the press ([L07]). Share… anchors the system picker at this button.
  const goButtonRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  useShareFormFit(formRef);
  const go = useCallback(() => {
    switch (store.getSnapshot().action) {
      case "preview":
        onPreview();
        return;
      case "copy":
        onCopy();
        return;
      case "save":
        onSave();
        return;
      case "share":
        onShare(() => {
          const rect = goButtonRef.current?.getBoundingClientRect();
          return rect === undefined ? null : { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
        });
        return;
    }
  }, [store, onPreview, onCopy, onSave, onShare]);

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
        {/* The modal header convention, two-line case: the sheet's own
            classes, so the shade's title and instruction are the type every
            sheet and alert already wears. */}
        <div
          className="session-share-view__header tug-sheet-header"
          data-has-description="true"
          data-icon-tone="active"
        >
          <div className="tug-sheet-icon" aria-hidden="true">
            <Share />
          </div>
          <div className="tug-sheet-heading">
            {/* The title row, tall enough for the buttons: the title at its
                left; the count, Mark All and Clear All at its right. The
                buttons sit flush right and the count grows leftward from
                them, so nothing moves as the count changes. */}
            <div className="session-share-view__title-row">
              <div className="tug-sheet-title">Share Turns</div>
              <div className="session-share-view__marks" data-testid="session-share-marks">
                <span className="session-share-view__count" data-testid="session-share-count">
                  {shareCountLabel(count)}
                </span>
                <TugPushButton
                  size="sm"
                  emphasis="outlined"
                  role="action"
                  onClick={onMarkAll}
                  data-testid="session-share-mark-all"
                >
                  Select All
                </TugPushButton>
                <TugPushButton
                  size="sm"
                  emphasis="outlined"
                  role="action"
                  disabled={count === 0}
                  onClick={() => store.clearMarks()}
                  data-testid="session-share-clear"
                >
                  Clear All
                </TugPushButton>
              </div>
            </div>
            <p className="tug-sheet-description" data-testid="session-share-instruction">
              Check the box at the right of each turn you want to share. Shift-click a box to select
              every turn between it and the last one you clicked, or use the buttons above to
              select turns.
            </p>
          </div>
        </div>
        {/* Tools and Format on one line when they fit, stacked when not;
            Tools' label in the icon column either way. */}
        <div className="session-share-view__form" ref={formRef} data-testid="session-share-form">
          <span className="session-share-view__label session-share-view__label--lead">Tools</span>
          <span className="session-share-view__control">
            <TugChoiceGroup
              items={TOOL_MODE_ITEMS}
              value={snapshot.toolMode}
              senderId={toolSenderId}
              size="sm"
              commit="live"
              aria-label="Tools"
              data-testid="session-share-tool-mode"
            />
          </span>
          <span className="session-share-view__label session-share-view__label--format">Format</span>
          <span className="session-share-view__control session-share-view__control--format">
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
        {/* The bottom row: Action at the left, the two buttons at the right. */}
        <div className="session-share-view__actions tug-sheet-actions">
          <span className="session-share-view__label">Action</span>
          <span className="session-share-view__control" data-testid="session-share-action">
            <TugPopupButton
              label={shareActionLabel(snapshot.action)}
              items={ACTION_ITEMS}
              senderId={actionSenderId}
              size="sm"
              aria-label="Action"
              data-testid="session-share-action-menu"
            />
          </span>
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
            onClick={onDone}
            data-testid="session-share-cancel"
          >
            Cancel
          </TugPushButton>
          <TugPushButton
            ref={goButtonRef}
            size="sm"
            emphasis="primary"
            role="action"
            disabled={!canAct}
            onClick={go}
            data-testid="session-share-go"
            data-share-action={snapshot.action}
            // The shade's default action: it wears the double ring the whole
            // time it can act, wherever the keyboard rests, as a sheet's
            // default button does.
            persistentDefaultRing
          >
            {shareActionLabel(snapshot.action)}
          </TugPushButton>
        </div>
      </div>
    </ResponderScope>
  );
}
