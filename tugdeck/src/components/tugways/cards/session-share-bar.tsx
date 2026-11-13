/**
 * `SessionShareBar` — the Session card's share mode controls.
 *
 * The bar takes the find bar's seat, between the transcript and Z2, while
 * share mode is on; the card hides the composer and the status strip under
 * `data-share-mode` so the bar is the bottom of the card. It shows how many
 * turns are marked, the Tool calls choice (Summaries, Full, None), the Format
 * choice, and the actions: Preview…, Copy, Save…, Share…, and Done, which leaves the
 * mode. Escape leaves it too: the bar is a responder for `cancelDialog`.
 *
 * The Format choice is PDF (the default), Image or Markdown. A PDF or an
 * image is rendered by the host from the card's own cells; while that runs
 * the bar says "Rendering…" beside a running indicator.
 *
 * Nothing leaves before it is seen. Copy, Save… and Share… are enabled
 * exactly while the held artifact is the preview of the current selection,
 * tool mode and format — the store's comparison, read here with
 * `useSyncExternalStore` ([L02]). Share… hands the host its own rect, which
 * the system picker is anchored to. Preview… is disabled while nothing is
 * marked and while a preview is being prepared.
 *
 * The choices are `TugChoiceGroup`s, which report through the chain; the bar
 * owns no state of its own and applies each report to the card's store
 * ([L11]). Its handlers read the store live, so they are registered once
 * ([L07]).
 *
 * Laws: [L02] store snapshot via `useSyncExternalStore`; [L03] responder
 * registration in a layout effect (`useResponder`); [L06] the enabled look is
 * the buttons' own; [L07] handlers read live; [L11] controls emit actions,
 * this bar responds; [L19] component authoring guide.
 *
 * @module components/tugways/cards/session-share-bar
 */

import "./session-share-bar.css";

import React, { useCallback, useId, useLayoutEffect, useRef } from "react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponder } from "@/components/tugways/use-responder";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
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

export interface SessionShareBarProps {
  store: ShareTurnsStore;
  onPreview: () => void;
  onCopy: () => void;
  onSave: () => void;
  /** Share… — the button's rect in this page's viewport, for the picker's anchor. */
  onShare: (anchor: ShareAnchor) => void;
  /** Leave share mode — Done and Escape. */
  onDone: () => void;
}

export function SessionShareBar({
  store,
  onPreview,
  onCopy,
  onSave,
  onShare,
  onDone,
}: SessionShareBarProps): React.ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const canSend = useSyncExternalStore(store.subscribe, () => store.canSend());
  const count = snapshot.selected.size;

  const toolSenderId = useId();
  const formatSenderId = useId();
  const barResponderId = useId();

  // Live refs for the handlers registered once ([L07]).
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const { ResponderScope, responderRef } = useResponder({
    id: barResponderId,
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const value = event.value;
        if (typeof value !== "string") return;
        if (event.sender === toolSenderId && isToolMode(value)) store.setToolMode(value);
        else if (event.sender === formatSenderId && isFormat(value)) store.setFormat(value);
      },
      [TUG_ACTIONS.CANCEL_DIALOG]: () => {
        onDoneRef.current();
      },
    },
  });

  // The keyboard moves to the bar as it opens, so Escape reaches it: the bar
  // takes DOM focus (it is focusable, not a Tab stop, so this holds even
  // while Preview… is disabled) and the chain's first responder.
  const manager = useResponderChain();
  const barRef = useRef<HTMLDivElement | null>(null);
  const setBarRef = useCallback(
    (el: HTMLDivElement | null) => {
      barRef.current = el;
      (responderRef as (el: HTMLDivElement | null) => void)(el);
    },
    [responderRef],
  );
  useLayoutEffect(() => {
    barRef.current?.focus({ preventScroll: true });
    manager?.makeFirstResponder(barResponderId);
  }, [manager, barResponderId]);

  // While the bar stands, the composer is hidden, and a hidden composer must
  // not hold the keyboard: it would take Escape and every keystroke for a
  // field nobody can see. A landing that closes as share mode opens hands
  // the keyboard back to the composer, so focus arriving there is moved to
  // the bar ([L03]: registered before any key can land; [L27]: released).
  useLayoutEffect(() => {
    const bar = barRef.current;
    const card = bar?.closest<HTMLElement>('[data-slot="session-card"]') ?? null;
    if (bar === null || card === null) return;
    const reclaim = (event: FocusEvent): void => {
      // Leaving the mode hands the keyboard to the composer before this bar
      // unmounts; that focus is the point of leaving and stays.
      if (!store.getSnapshot().active) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-slot="session-card-entry-region"]') === null) return;
      bar.focus({ preventScroll: true });
      manager?.makeFirstResponder(barResponderId);
    };
    card.addEventListener("focusin", reclaim, true);
    return () => card.removeEventListener("focusin", reclaim, true);
  }, [manager, barResponderId, store]);

  const preview = useCallback(() => onPreview(), [onPreview]);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const share = useCallback(() => {
    const rect = shareButtonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    onShare({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
  }, [onShare]);

  return (
    <ResponderScope>
      <div
        ref={setBarRef}
        className="session-share-bar"
        data-slot="session-share-bar"
        data-testid="session-share-bar"
        data-rendering={snapshot.rendering ? "true" : undefined}
        role="toolbar"
        aria-label="Share turns"
        tabIndex={-1}
      >
        <span className="session-share-bar__count" data-testid="session-share-count">
          {shareCountLabel(count)}
        </span>
        <span className="session-share-bar__field">
          <span className="session-share-bar__field-label">Tool calls</span>
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
        <span className="session-share-bar__field">
          <span className="session-share-bar__field-label">Format</span>
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
        <span className="session-share-bar__spacer" />
        {snapshot.rendering ? (
          <span className="session-share-bar__rendering" data-testid="session-share-rendering" role="status">
            <TugProgressIndicator variant="spinner" state="running" tone="inherit" size={12} />
            Rendering…
          </span>
        ) : null}
        <TugPushButton
          size="sm"
          emphasis="outlined"
          role="action"
          disabled={count === 0 || snapshot.rendering}
          onClick={preview}
          data-testid="session-share-preview"
        >
          Preview…
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="outlined"
          role="action"
          disabled={!canSend}
          onClick={onCopy}
          data-testid="session-share-copy"
        >
          Copy
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="outlined"
          role="action"
          disabled={!canSend}
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
          disabled={!canSend}
          onClick={share}
          data-testid="session-share-share"
        >
          Share…
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="filled"
          role="action"
          onClick={onDone}
          data-testid="session-share-done"
        >
          Done
        </TugPushButton>
      </div>
    </ResponderScope>
  );
}
