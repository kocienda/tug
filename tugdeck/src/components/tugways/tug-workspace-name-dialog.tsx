/**
 * TugWorkspaceNameDialog — the app-modal that asks for a workspace's name
 * before New Workspace or Duplicate Workspace makes anything.
 *
 * One component with two callers. The shell asks the question
 * (`lib/workspace-name-request.ts`): its snapshot names the verb and the
 * proposed name, `Workspace N` for New and `Duplicate of <source name>` for
 * Duplicate. The modal is a scrim over the whole window and a small panel on
 * the TugAlert chrome holding one text field, with the proposed name filled
 * in and selected, a Cancel button and a commit button. Return commits and
 * Escape (and ⌘.) cancels. A name that is empty after trimming does not
 * commit: the commit button is disabled and Return does nothing. The answer
 * goes back through the page's gate deck ({@link useGateDeck}). That is
 * `workspace-name-request.ts` directly in the shell, and the bus in the
 * overlay, which is where the modal is drawn wherever the host keeps one, so
 * the scrim covers the card pages too.
 *
 * ## Modality and focus
 *
 * A plain Radix `Dialog` portalled into the canvas overlay root ([L25]),
 * with the `alertdialog` role, so the overlay claims the whole window and the
 * host makes its view the key one (`overlay/overlay-claim.ts`). The trap is
 * typing-first (`kbf: false`): the engine seeds the field as the key view —
 * from the per-question panel, since a seed is once per mount — and
 * grants it real DOM focus, and the field selects its whole text the first
 * time it takes focus, so typing replaces the proposed name. Escape is the
 * engine's Escape ladder's, through the trap's `onEscapeDismiss`.
 *
 * ## Open and close
 *
 * `open` is the question being open and not yet answered from this page.
 * Answering closes the panel here at once, before the shell's closed
 * snapshot comes back across the bus, and Radix keeps the content mounted
 * through the CSS close animation the alert chrome already carries. Each
 * question remounts the panel's state by its number, so a second question
 * never inherits the first one's typing.
 *
 * A cancel closes the panel here at once. A commit does not: the asker may
 * have work to do under the scrim before the question closes (New
 * Workspace's cut), so the panel stays until the shell's snapshot says
 * `waiting` or closed. While it waits the panel shows the deck's progress
 * wave where its buttons were, in the same box, so the panel keeps its size,
 * and nothing the user does answers it again.
 *
 * Laws: [L02] the question enters React through `useSyncExternalStore`;
 * [L06] the panel's look is the alert's CSS, keyed on Radix's `data-state`;
 * [L19] `data-slot` names the parts; [L25] mounted into the canvas overlay.
 *
 * @module components/tugways/tug-workspace-name-dialog
 */

import * as Dialog from "@radix-ui/react-dialog";
import React, { useCallback, useId, useRef, useState } from "react";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useGateDeck } from "@/lib/gate-deck";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import {
  getWorkspaceNameRequest,
  subscribeWorkspaceNameRequest,
  type WorkspaceNameRequest,
} from "@/lib/workspace-name-request";
import { TUG_ACTIONS } from "./action-vocabulary";
import { suppressButtonFocusShift } from "./internal/safari-focus-shift";
import { isCancelChordEvent } from "./keymap-registry";
import { TugInput } from "./tug-input";
import { TugProgressIndicator } from "./tug-progress-indicator";
import { TugPushButton } from "./tug-push-button";
import { useFocusTrap } from "./use-focus-trap";
import { useSeedKeyView } from "./use-focusable";
import { useOptionalResponder } from "./use-responder";
import "./tug-alert.css";
import "./tug-workspace-name-dialog.css";

/** The focus group the dialog's stops are authored into. */
const FOCUS_GROUP = "tug-workspace-name-dialog";
const FIELD_ORDER = 0;
const CANCEL_ORDER = 1;
const COMMIT_ORDER = 2;

const TITLES: Record<WorkspaceNameRequest["verb"], string> = {
  new: "New Workspace",
  duplicate: "Duplicate Workspace",
};
const COMMIT_LABELS: Record<WorkspaceNameRequest["verb"], string> = {
  new: "Create",
  duplicate: "Duplicate",
};

export function TugWorkspaceNameDialog(): React.ReactElement {
  const request = useSyncExternalStore(subscribeWorkspaceNameRequest, getWorkspaceNameRequest);
  const deck = useGateDeck();
  const overlayRoot = useCanvasOverlay();
  // The question this page has answered: closed here before the shell's
  // closed snapshot returns. Structure, not appearance — it decides whether
  // the dialog is open at all.
  const [answered, setAnswered] = useState(0);
  const open = request.open && request.seq !== answered;
  // The panel's last question, held through the close animation so the
  // panel does not repaint as a different verb on its way out.
  const shownRef = useRef<WorkspaceNameRequest>(request);
  if (request.open) shownRef.current = request;
  const shown = shownRef.current;

  const answer = useCallback(
    (name: string | null) => {
      if (!open || request.waiting) return;
      if (name !== null && name.trim() === "") return;
      // A cancel closes here at once; a commit waits for the shell.
      if (name === null) setAnswered(request.seq);
      deck.answerWorkspaceName(request.seq, name);
    },
    [open, request.waiting, request.seq, deck],
  );
  const cancel = useCallback(() => answer(null), [answer]);

  const { FocusModeScope, onCloseAutoFocus } = useFocusTrap({
    active: open,
    deferDomFocusToTeardown: true,
    onEscapeDismiss: cancel,
    kbf: false,
  });

  // ⌘. is a capture-phase global binding dispatched to the first responder,
  // and the walk from the field reaches this panel: Cancel answers it.
  const responderId = useId();
  const { responderRef } = useOptionalResponder({
    id: responderId,
    actions: { [TUG_ACTIONS.CANCEL_DIALOG]: () => cancel() },
  });

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <Dialog.Portal container={overlayRoot}>
        <Dialog.Overlay className="tug-alert-overlay" data-slot="tug-workspace-name-scrim" />
        <Dialog.Content
          ref={responderRef as (node: HTMLDivElement | null) => void}
          className="tug-alert-content tug-workspace-name-dialog"
          data-slot="tug-workspace-name-dialog"
          data-verb={shown.verb}
          role="alertdialog"
          aria-describedby={undefined}
          onMouseDown={suppressButtonFocusShift}
          // The engine seeds the field; stop Radix's own first-focusable walk.
          onOpenAutoFocus={(e) => e.preventDefault()}
          // The engine's Escape ladder owns Escape, through the trap.
          onEscapeKeyDown={(e) => e.preventDefault()}
          onCloseAutoFocus={onCloseAutoFocus}
          // The user must answer: nothing outside the panel dismisses it.
          onInteractOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (isCancelChordEvent(e)) {
              e.preventDefault();
              cancel();
            }
          }}
        >
          <FocusModeScope>
            {/* The dialog's own key sink ([P13]): the engine's park lands inside the jail. */}
            <div data-tug-key-sink="" tabIndex={-1} className="tug-key-sink" aria-label="Keyboard" />
            <NamePanel key={shown.seq} request={shown} waiting={open && request.waiting} onCommit={answer} onCancel={cancel} />
          </FocusModeScope>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface NamePanelProps {
  request: WorkspaceNameRequest;
  /** A committed name's settle is running: the wave stands where the buttons were. */
  waiting: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/** One question's panel: its title, its field and its buttons. Remounted for each question. */
function NamePanel({ request, waiting, onCommit, onCancel }: NamePanelProps): React.ReactElement {
  const [name, setName] = useState(request.proposed);
  // Seeded from the panel, which each question remounts: the seed is once per
  // mount, and the dialog itself stays mounted across questions.
  useSeedKeyView(`${FOCUS_GROUP}:${FIELD_ORDER}`);
  // The proposed name is selected the first time the field takes focus,
  // so typing replaces it; later focus leaves the user's caret alone.
  const selectedOnceRef = useRef(false);
  const committable = name.trim() !== "";
  const commit = (): void => {
    if (committable) onCommit(name);
  };
  return (
    <>
      <div className="tug-alert-body" data-scale="alert">
        <div className="tug-alert-text">
          <Dialog.Title className="tug-alert-title">{TITLES[request.verb]}</Dialog.Title>
        </div>
      </div>
      <TugInput
        className="tug-workspace-name-field"
        data-slot="tug-workspace-name-field"
        type="text"
        spellCheck={false}
        autoComplete="off"
        aria-label="Workspace name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => {
          if (selectedOnceRef.current) return;
          selectedOnceRef.current = true;
          e.currentTarget.select();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        focusGroup={FOCUS_GROUP}
        focusOrder={FIELD_ORDER}
      />
      <div className="tug-alert-actions tug-workspace-name-actions" data-waiting={waiting ? "" : undefined}>
        <TugPushButton
          size="sm"
          emphasis="outlined"
          onClick={onCancel}
          focusGroup={FOCUS_GROUP}
          focusOrder={CANCEL_ORDER}
          data-slot="tug-workspace-name-cancel"
        >
          Cancel
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="primary"
          role="action"
          persistentDefaultRing
          disabled={!committable}
          onClick={commit}
          focusGroup={FOCUS_GROUP}
          focusOrder={COMMIT_ORDER}
          data-slot="tug-workspace-name-commit"
        >
          {COMMIT_LABELS[request.verb]}
        </TugPushButton>
        {waiting ? (
          <div className="tug-workspace-name-wave" data-slot="tug-workspace-name-wave" role="status" aria-label="Opening">
            <TugProgressIndicator variant="wave" size={20} aria-hidden />
          </div>
        ) : null}
      </div>
    </>
  );
}
