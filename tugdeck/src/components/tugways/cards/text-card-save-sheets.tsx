/**
 * text-card-save-sheets.tsx — the pane-modal sheets a manual-mode File
 * card presents: close-with-unsaved-changes, external-change
 * conflict, missing-file, revert, reload, and the open-time aside
 * conflict.
 *
 * `useFileSaveSheets(showSheet)` returns one presenter per sheet, each
 * resolving to the user's decision. The two-button sheets ride
 * `presentAlertSheet`; the three/four-button ones render a small
 * `FileSaveSheetView` that reuses TugAlert's `.tug-alert-*` visual so
 * every sheet looks like the rest of the app ([use-tug-components]).
 *
 * Classic button order: destructive-alternative left, Cancel, default
 * right; Return = default, except a destructive default hands Return to
 * Cancel so Enter can't fire it; Escape / ⌘. = Cancel.
 *
 * Laws: [L06] appearance via CSS (the sheet is layout over TugAlert's
 * visual); [L11] the buttons are controls that emit the card's decision;
 * [L19] authoring guide; [L20] composed TugPushButton keeps its own tokens.
 *
 * @module components/tugways/cards/text-card-save-sheets
 */

import "../tug-alert.css";
import "./text-card-save-sheets.css";

import React, { useCallback, useMemo } from "react";
import { TriangleAlert } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import type { TugButtonRole } from "@/components/tugways/tug-push-button";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { useSpatialOrder } from "@/components/tugways/use-spatial-order";
import type { SpatialOrder } from "@/components/tugways/spatial-order";
import { presentAlertSheet } from "@/components/tugways/tug-alert-sheet";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";

type ShowSheet = (options: ShowSheetOptions) => Promise<string | undefined>;

/** One button in a multi-choice save sheet. */
interface SheetButton {
  label: string;
  /** The string `close(result)` resolves to when this button is chosen. */
  result: string;
  role?: TugButtonRole;
  /** The default (Return) button — seeded as the live key view. */
  isDefault?: boolean;
}

/**
 * A multi-button save sheet: TugAlert icon + text, then an action row with
 * `cancel` alone on the left and the remaining choices grouped on the
 * right, default last (the classic layout the user asked for).
 */
function FileSaveSheetView({
  title,
  message,
  buttons,
  close,
}: {
  title: string;
  message?: string;
  buttons: SheetButton[];
  close: (result?: string) => void;
}): React.ReactElement {
  const focusGroup = React.useId();
  const nominalDefaultIndex = buttons.findIndex((b) => b.isDefault);
  const cancelIndex = buttons.findIndex((b) => b.result === "cancel");
  // Danger confirmations keep Return safe: when the nominal default is a
  // destructive choice, the resting key view — and its filled emphasis —
  // move to Cancel so Enter can't fire it, matching TugAlert's danger
  // handling ([focus-language]). Positions are unchanged.
  const defaultIndex =
    buttons[nominalDefaultIndex]?.role === "danger" && cancelIndex !== -1
      ? cancelIndex
      : nominalDefaultIndex === -1
        ? 0
        : nominalDefaultIndex;
  useSeedKeyView(`${focusGroup}:${defaultIndex}`);

  // Arrow-plane ring over the button row in VISUAL order (Cancel on the
  // left, then the right-hand cluster) so Left/Right and Up/Down walk the
  // 3–4 choices — the doctrine's dialog-row navigation ([focus-language]).
  // This view renders inside the sheet's FocusModeScope, so the ring binds
  // to the sheet's trapped focus mode. [L03]
  const spatialOrder = React.useMemo<SpatialOrder>(() => {
    const cancelIdx = buttons.findIndex((b) => b.result === "cancel");
    const visual = [
      ...(cancelIdx !== -1 ? [cancelIdx] : []),
      ...buttons.map((_, i) => i).filter((i) => buttons[i].result !== "cancel"),
    ];
    const nodes = visual.map((i) => `${focusGroup}:${i}`);
    return {
      rings: [
        { axis: "horizontal", nodes, closed: true },
        { axis: "vertical", nodes, closed: true },
      ],
    };
  }, [focusGroup, buttons]);
  useSpatialOrder(spatialOrder);

  const cancel = buttons.find((b) => b.result === "cancel");
  const rest = buttons.filter((b) => b.result !== "cancel");
  const renderButton = (button: SheetButton) => {
    const isDefault = buttons.indexOf(button) === defaultIndex;
    return (
      <TugPushButton
        size="sm"
        key={button.result}
        emphasis={
          isDefault
            ? button.role && button.role !== "action"
              ? "filled"
              : "primary"
            : "outlined"
        }
        role={button.role ?? "action"}
        onClick={() => close(button.result)}
        data-testid={`file-save-sheet-${button.result}`}
        focusGroup={focusGroup}
        focusOrder={buttons.indexOf(button)}
      >
        {button.label}
      </TugPushButton>
    );
  };

  return (
    <div className="tug-alert-sheet" data-slot="file-save-sheet">
      <div
        className="tug-alert-body"
        data-scale="alert"
        data-has-message={message ? "true" : undefined}
      >
        <div className="tug-alert-icon" aria-hidden="true">
          <TriangleAlert />
        </div>
        <div className="tug-alert-text">
          <h2 className="tug-alert-title">{title}</h2>
          {message ? <p className="tug-alert-message">{message}</p> : null}
        </div>
      </div>
      <div className="file-save-sheet-actions">
        <div>{cancel ? renderButton(cancel) : null}</div>
        <div className="file-save-sheet-actions-right">{rest.map(renderButton)}</div>
      </div>
    </div>
  );
}

/** Decision from the close-with-unsaved-changes sheet. */
export type CloseSheetChoice = "save" | "dont-save" | "cancel";
/** Decision from the external-change conflict sheet. */
export type ConflictSheetChoice = "save-anyway" | "reload" | "save-as" | "cancel";
/** Decision from the missing-file sheet. */
export type MissingSheetChoice = "save" | "save-as" | "dont-save" | "cancel";
/** Decision from the open-time aside-conflict sheet. */
export type OpenConflictChoice = "keep" | "disk";

/** The card-hosted save-sheet presenters. */
export interface FileSaveSheets {
  presentCloseSheet(fileName: string): Promise<CloseSheetChoice>;
  /**
   * `defaultChoice` overrides which button Return fires. The plain
   * external-edit conflict keeps "Save Anyway"; the sheet raised as the
   * follow-up to a missing-file Save passes `"reload"`, because there the
   * destructive branch would overwrite a file that just came back.
   */
  presentConflictSheet(
    fileName: string,
    opts?: { defaultChoice?: ConflictSheetChoice },
  ): Promise<ConflictSheetChoice>;
  presentMissingSheet(fileName: string): Promise<MissingSheetChoice>;
  presentRevertSheet(fileName: string): Promise<boolean>;
  presentReloadSheet(fileName: string): Promise<boolean>;
  presentOpenConflictSheet(fileName: string): Promise<OpenConflictChoice>;
}

export function useFileSaveSheets(showSheet: ShowSheet): FileSaveSheets {
  const presentCloseSheet = useCallback(
    (fileName: string): Promise<CloseSheetChoice> =>
      showSheet({
        title: "Unsaved Changes",
        displayWidth: "sm",
        hideHeader: true,
        content: (close) => (
          <FileSaveSheetView
            title={`Save changes to “${fileName}” before closing?`}
            buttons={[
              { label: "Don’t Save", result: "dont-save", role: "danger" },
              { label: "Cancel", result: "cancel" },
              { label: "Save", result: "save", isDefault: true },
            ]}
            close={close}
          />
        ),
      }).then((result) => (result as CloseSheetChoice) ?? "cancel"),
    [showSheet],
  );

  const presentConflictSheet = useCallback(
    (
      fileName: string,
      opts?: { defaultChoice?: ConflictSheetChoice },
    ): Promise<ConflictSheetChoice> => {
      const defaultChoice = opts?.defaultChoice ?? "save-anyway";
      return showSheet({
        title: "Document Changed",
        // Four buttons in one row — `sm`'s content box cannot hold them.
        displayWidth: "md",
        hideHeader: true,
        content: (close) => (
          <FileSaveSheetView
            title={`“${fileName}” was changed by another application.`}
            message="Your unsaved changes conflict with the version on disk."
            buttons={[
              {
                label: "Reload from Disk",
                result: "reload",
                isDefault: defaultChoice === "reload",
              },
              {
                label: "Save As…",
                result: "save-as",
                isDefault: defaultChoice === "save-as",
              },
              { label: "Cancel", result: "cancel" },
              {
                label: "Save Anyway",
                result: "save-anyway",
                isDefault: defaultChoice === "save-anyway",
                role: "danger",
              },
            ]}
            close={close}
          />
        ),
      }).then((result) => (result as ConflictSheetChoice) ?? "cancel");
    },
    [showSheet],
  );

  const presentMissingSheet = useCallback(
    (fileName: string): Promise<MissingSheetChoice> =>
      showSheet({
        title: "File Deleted",
        // Four buttons, same as the conflict sheet — the same width holds them.
        displayWidth: "md",
        hideHeader: true,
        content: (close) => (
          <FileSaveSheetView
            title={`“${fileName}” was deleted by another application.`}
            message="Save to recreate it, or discard your changes."
            buttons={[
              { label: "Don’t Save", result: "dont-save", role: "danger" },
              { label: "Save As…", result: "save-as" },
              { label: "Cancel", result: "cancel" },
              { label: "Save", result: "save", isDefault: true },
            ]}
            close={close}
          />
        ),
      }).then((result) => (result as MissingSheetChoice) ?? "cancel"),
    [showSheet],
  );

  const presentRevertSheet = useCallback(
    (fileName: string): Promise<boolean> =>
      presentAlertSheet(showSheet, {
        title: `Revert “${fileName}” to the last saved version?`,
        message: "Your changes will be lost.",
        confirmLabel: "Revert",
        confirmRole: "danger",
        cancelLabel: "Cancel",
        icon: null,
      }),
    [showSheet],
  );

  const presentReloadSheet = useCallback(
    (fileName: string): Promise<boolean> =>
      presentAlertSheet(showSheet, {
        title: `Reload “${fileName}” from disk?`,
        message: "Your changes will be lost.",
        confirmLabel: "Reload",
        confirmRole: "danger",
        cancelLabel: "Cancel",
        icon: null,
      }),
    [showSheet],
  );

  const presentOpenConflictSheet = useCallback(
    (fileName: string): Promise<OpenConflictChoice> =>
      // Keep My Changes is the default (confirm); Use Disk Version is the
      // alternative (cancel / Escape).
      presentAlertSheet(showSheet, {
        title: `“${fileName}” has unsaved changes from a previous session, but the file has changed on disk.`,
        message: "Keep your unsaved changes, or use the version on disk?",
        confirmLabel: "Keep My Changes",
        confirmRole: "action",
        cancelLabel: "Use Disk Version",
        icon: null,
      }).then((keep) => (keep ? "keep" : "disk")),
    [showSheet],
  );

  // Stable identity: the presenters are each `useCallback`-stable, so the
  // returned object must be too — the card's close-guard registration
  // effect depends on it and would otherwise re-run every render.
  return useMemo(
    () => ({
      presentCloseSheet,
      presentConflictSheet,
      presentMissingSheet,
      presentRevertSheet,
      presentReloadSheet,
      presentOpenConflictSheet,
    }),
    [
      presentCloseSheet,
      presentConflictSheet,
      presentMissingSheet,
      presentRevertSheet,
      presentReloadSheet,
      presentOpenConflictSheet,
    ],
  );
}
