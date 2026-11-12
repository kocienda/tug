/**
 * WorkspaceNameDialog — the app-modal that asks for a workspace's name
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
 * ## The zoom in
 *
 * A question raised from a place on screen — the Workspaces card's `+`, a
 * header row's `···` menu — carries that place's rect as `from`, in window
 * points, and the panel zooms in from it on classic zoom rectangles
 * (`chrome/zoom-rects.ts`), held hidden for the run's length by CSS keyed on
 * `data-zoom`. The update wizard's pattern — mark, then measure, then run —
 * with one difference: the run is planted two frames after the mount, not in
 * it. The panel's first frame lays out and paints the scrim and the panel
 * and is long, and a run planted before it would paint its first rectangles
 * only after, already partway to the panel. So the panel is marked `hold`
 * (hidden, measured at its real size) at the mount and `run` when the
 * rectangles plant, which starts its delayed fade. Reduced motion or a zero
 * timing scale marks nothing, so the panel is up on its first frame as
 * before, and a question with no `from` (the Window menu, a chord) gets no
 * run and no mark.
 *
 * ## The zoom out
 *
 * A committed question closes with `to` when the asker learned where its
 * workspace's row landed, and the panel zooms out to that row as the scrim
 * fades. The panel is measured as the closed snapshot arrives, in the store's
 * own notification, which runs before React re-renders and Radix takes the
 * content down, so the box read is the panel still standing. A close with no
 * `to` fades as it always has.
 *
 * A cancel — the Cancel button, Escape, ⌘. — zooms back the way it came,
 * from the panel to the question's `from`, as a window closes back into its
 * icon. The page closes the panel itself on a cancel, before the shell's
 * closed snapshot returns, so the run is taken in the cancel with the panel
 * still standing. A question with no `from` cancels with the fade alone.
 *
 * Laws: [L02] the question enters React through `useSyncExternalStore`;
 * [L06] the panel's look is the alert's CSS, keyed on Radix's `data-state`,
 * and the zoom's hold is CSS keyed on a `data-zoom` the ref callback sets on
 * the DOM, never React state; [L19] `data-slot` names the parts; [L25]
 * mounted into the canvas overlay.
 *
 * @module components/chrome/workspace-name-dialog
 */

import * as Dialog from "@radix-ui/react-dialog";
import React, { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

import { runZoomRects } from "@/components/chrome/zoom-rects";
import { getTugTiming, isTugMotionEnabled } from "@/lib/scale-timing";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useGateDeck } from "@/lib/gate-deck";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import {
  getWorkspaceNameRequest,
  subscribeWorkspaceNameRequest,
  type WorkspaceNameRequest,
} from "@/lib/workspace-name-request";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { suppressButtonFocusShift } from "@/components/tugways/tug-alert";
import { isCancelChordEvent } from "@/components/tugways/keymap-registry";
import { TugInput } from "@/components/tugways/tug-input";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import "@/components/tugways/tug-alert.css";
import "./workspace-name-dialog.css";

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

export function WorkspaceNameDialog(): React.ReactElement {
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
  // Read by the content's ref callback, which runs in the commit this render
  // produces: a ref set here is current there, and an effect would be late.
  const openRef = useRef(open);
  openRef.current = open;

  const answer = useCallback(
    (name: string | null) => {
      if (!open || request.waiting) return;
      if (name !== null && name.trim() === "") return;
      // A cancel closes here at once, and zooms back to where the question
      // came from, measured now while the panel stands; a commit waits for
      // the shell, and zooms out to its row when the shell says where.
      if (name === null) {
        const from = shownRef.current.from;
        const node = contentRef.current;
        if (from !== null && node !== null) {
          const box = node.getBoundingClientRect();
          runZoomRects({ top: box.top, left: box.left, width: box.width, height: box.height }, from, "sheet");
        }
        setAnswered(request.seq);
      }
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

  // The zoom in, from the place that raised the question to this panel. A ref
  // callback, not an effect on `open`: Radix's Presence mounts the content a
  // commit after the flag flips, and the callback is the first moment there
  // is a panel to measure, before it has painted a frame. Radix re-attaches
  // the node on the closing commit too, which the open guard turns away, and
  // a question already zoomed for is not zoomed for again.
  const zoomedSeqRef = useRef(0);
  // The panel as it stands: what the zoom out measures.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const attachContent = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      responderRef(node);
      if (node === null || !openRef.current) return;
      const question = shownRef.current;
      if (question.seq === zoomedSeqRef.current) return;
      zoomedSeqRef.current = question.seq;
      const from = question.from;
      if (from === null) return;
      // A run that would plant nothing — reduced motion, a zero timing
      // scale — marks nothing, so the panel is up on its first frame.
      if (!isTugMotionEnabled() || getTugTiming() === 0) return;
      // Mark first, measure second: the alert's entrance opens at
      // `scale(0.96)`, and the hold replaces it with no animation at all, so
      // the box read is the panel at its real size.
      node.dataset.zoom = "hold";
      const box = node.getBoundingClientRect();
      const to = { top: box.top, left: box.left, width: box.width, height: box.height };
      // The run waits out the panel's first frame. That frame lays out and
      // paints the scrim and the panel, and it is long; a run planted in this
      // commit starts its clock before it and paints its first rectangles
      // only after, so the run is seen starting partway to the panel. Two
      // frames on, the panel is drawn (hidden) and the run's frames are cheap.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (node.dataset.zoom !== "hold") return;
          if (!node.isConnected || !openRef.current || shownRef.current.seq !== question.seq) {
            delete node.dataset.zoom;
            return;
          }
          node.dataset.zoom = "run";
          if (!runZoomRects(from, to, "sheet")) delete node.dataset.zoom;
        }),
      );
    },
    [responderRef],
  );

  // The zoom out, from this panel to the row the committed name landed on.
  // A store listener rather than an effect on the closed render: by that
  // render's commit Radix may already have taken the content down, and the
  // listener runs as the snapshot changes, with the panel still in the DOM.
  useLayoutEffect(() => {
    let last = getWorkspaceNameRequest();
    return subscribeWorkspaceNameRequest(() => {
      const previous = last;
      const next = getWorkspaceNameRequest();
      last = next;
      if (!previous.open || next.open || next.seq !== previous.seq || next.to === null) return;
      const node = contentRef.current;
      if (node === null) return;
      const box = node.getBoundingClientRect();
      runZoomRects({ top: box.top, left: box.left, width: box.width, height: box.height }, next.to, "sheet");
    });
  }, []);

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
          ref={attachContent}
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
