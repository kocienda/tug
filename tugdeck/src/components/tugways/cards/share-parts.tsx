/**
 * share-parts.tsx — the parts every share surface is made of.
 *
 * Sharing turns and sharing a figure are one family of UI: the Share icon
 * and a title in the modal header, a Format choice, and a bottom row with
 * Done at its left and, at its right, an Action menu beside the button that
 * wears the chosen action's name and performs it. This file holds what the
 * two have in common, so neither can drift from the other: the action names
 * ({@link SHARE_ACTION_LABELS}), the label that keeps a button's width still
 * as its name changes ({@link StableLabel}), and the bottom row itself
 * ({@link ShareActionRow}).
 *
 * The Share Turns shade (`session-share-view.tsx`) and a figure's share
 * sheet (`figure-share-sheet.tsx`) compose them.
 *
 * Laws: [L06] the enabled look is the buttons' own; [L11] the menu reports
 * its choice through the chain, to the responder the surface registers;
 * [L19] component authoring guide; [L20] composed children keep their
 * tokens.
 *
 * @module components/tugways/cards/share-parts
 */

import "./share-parts.css";

import React from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugPopupButton, type TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import type { ShareAction } from "@/lib/share-turns-store";

/** The name each share action wears, on its button and in the Action menu. */
export const SHARE_ACTION_LABELS: Readonly<Record<ShareAction, string>> = {
  preview: "Preview…",
  copy: "Copy",
  save: "Save…",
  share: "Share…",
};

/**
 * A name, in a box as wide as the widest of `labels`: the name itself, over
 * one hidden sizer per label in the same grid cell. A sizer draws its name
 * from `data-label` through CSS, so the element's text is the one name it
 * shows. An action button and its menu's trigger both wear it, so neither
 * changes width as the action does.
 */
export function StableLabel({ label, labels }: { label: string; labels: ReadonlyArray<string> }): React.ReactElement {
  return (
    <span className="share-parts__stable-label">
      <span>{label}</span>
      {labels.map((entry) => (
        <span key={entry} className="share-parts__stable-sizer" data-label={entry} aria-hidden="true" />
      ))}
    </span>
  );
}

export interface ShareActionRowProps {
  /** The actions the surface offers, in menu order. */
  actions: ReadonlyArray<ShareAction>;
  /** The action chosen now: the name the button wears. */
  action: ShareAction;
  /** The sender the Action menu reports its `SELECT_VALUE` under. */
  actionSenderId: string;
  /** Whether the action button can be pressed. */
  canAct: boolean;
  /** An artifact is being made: "Rendering…" stands beside Done. */
  rendering: boolean;
  onDone: () => void;
  /** Perform the chosen action. */
  onGo: () => void;
  /** The action button, for the system share picker's anchor. */
  goRef?: React.Ref<HTMLButtonElement>;
  focusGroup: string;
  /** Where Done, the menu and the button sit in the surface's Tab order. */
  focusOrder: { done: number; action: number; go: number };
  /** The prefix of the row's test ids: `<prefix>-done`, `-action-menu`, `-go`… */
  testId: string;
}

/**
 * The bottom row of a share surface: Done at the left; Action and its
 * button together at the right. The button is the surface's default, and
 * wears the double ring the whole time it can act.
 */
export function ShareActionRow({
  actions,
  action,
  actionSenderId,
  canAct,
  rendering,
  onDone,
  onGo,
  goRef,
  focusGroup,
  focusOrder,
  testId,
}: ShareActionRowProps): React.ReactElement {
  const labels = actions.map((entry) => SHARE_ACTION_LABELS[entry]);
  const items: TugPopupButtonItem<string>[] = actions.map((entry) => ({
    action: TUG_ACTIONS.SELECT_VALUE,
    value: entry,
    label: SHARE_ACTION_LABELS[entry],
  }));
  const label = <StableLabel label={SHARE_ACTION_LABELS[action]} labels={labels} />;
  return (
    <div className="share-parts__actions tug-sheet-actions">
      <TugPushButton
        size="sm"
        emphasis="outlined"
        role="action"
        onClick={onDone}
        focusGroup={focusGroup}
        focusOrder={focusOrder.done}
        data-testid={`${testId}-done`}
      >
        Done
      </TugPushButton>
      {rendering ? (
        <span className="share-parts__rendering" data-testid={`${testId}-rendering`} role="status">
          <TugProgressIndicator variant="spinner" state="running" tone="inherit" size={12} />
          Rendering…
        </span>
      ) : null}
      <span className="share-parts__spacer" />
      <span className="share-parts__label">Action</span>
      <span className="share-parts__control" data-testid={`${testId}-action`}>
        <TugPopupButton
          label={label}
          items={items}
          senderId={actionSenderId}
          size="sm"
          focusGroup={focusGroup}
          focusOrder={focusOrder.action}
          aria-label="Action"
          data-testid={`${testId}-action-menu`}
        />
      </span>
      <TugPushButton
        ref={goRef}
        size="sm"
        emphasis="primary"
        role="action"
        disabled={!canAct}
        onClick={onGo}
        focusGroup={focusGroup}
        focusOrder={focusOrder.go}
        data-testid={`${testId}-go`}
        data-share-action={action}
        persistentDefaultRing
      >
        {label}
      </TugPushButton>
    </div>
  );
}
