/**
 * SessionArcShade — the shade that rises from the bottom of the Session card's
 * transcript and shows the card's arc.
 *
 * Stays mounted for the life of the card and is raised and lowered by one data
 * attribute, which a CSS transform reads, so a raise builds nothing and the
 * first frame of the rise costs only the transform. Raised, it stands over the
 * bottom of the transcript slot, as tall as what it holds and never taller
 * than four fifths of the slot; the transcript left showing above it is made
 * inert for as long as the shade is up. Lowered, the shade itself is inert and
 * translated out of its clipping pane.
 *
 * Whether it is raised is read from the card's `ArcShadeController`, and the
 * arc it shows from the session's binding. While raised it holds a focus
 * mode of its own: the key view moves to the header's
 * Transcript button, Escape lowers the shade, and lowering restores the key
 * view that was current when it rose and puts the keyboard back on it, ring
 * or caret; with none to return to, the card is asked to take the keyboard.
 * The composer below stays live.
 *
 * The header and the frame are this component's; the body is its children.
 * Composes `TugPushButton` and `ArcSigil`, which keep their own tokens.
 *
 * Laws: [L02] the raised state enters through `useSyncExternalStore`,
 *       [L03] the focus mode and the transcript's inertness are set in layout
 *       effects, [L06] the rise and fall are CSS on a data attribute,
 *       [L11] the header's buttons emit and the card's store owns the state,
 *       [L13] the motion is a declarative transition, [L16] pairings declared,
 *       [L19] component authoring guide, [L20] composed children keep their
 *       tokens, [L22] the transcript's `inert` is a direct DOM write
 */

import "./session-arc-shade.css";

import React, { useCallback, useContext, useId, useLayoutEffect, useRef } from "react";

import { ArcSigil } from "@/components/tugways/arc-sigil";
import { FocusManagerContext } from "@/components/tugways/focus-manager";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import type { ArcShadeController } from "@/lib/arc-shade-controller";
import { useArcForSession } from "@/lib/arc-session-index";
import { CardIdContext } from "@/lib/card-id-context";
import { useSyncExternalStore } from "@/lib/gesture-scope";

/** Focus order of the header's Transcript button, where the key view lands on a raise. */
const TRANSCRIPT_FOCUS_ORDER = 0;

export interface SessionArcShadeProps {
  /** The card's arc shade store; the shade is raised while its snapshot is true. */
  controller: ArcShadeController;
  /**
   * The card's session, or null while it has none. The arc that session is
   * bound to is named in the header.
   */
  tugSessionId: string | null;
  /**
   * The transcript pane this shade stands over. Made `inert` while the shade
   * is raised.
   */
  transcriptPaneRef: React.RefObject<HTMLElement | null>;
  /**
   * Take the keyboard back. Called when the shade lowers and there is no key
   * view to return to, so the caret goes home to where the card keeps it.
   */
  onReturnKeyboard?: () => void;
  /** The shade's body, beneath the header. */
  children?: React.ReactNode;
}

export function SessionArcShade({
  controller,
  tugSessionId,
  transcriptPaneRef,
  onReturnKeyboard,
  children,
}: SessionArcShadeProps): React.ReactElement {
  const raised = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const lower = useCallback(() => controller.lower(), [controller]);
  const arcName = useArcForSession(tugSessionId)?.name ?? null;

  // The shade's own focus mode. Pushed before the seed below runs, so the key
  // view the mode restores on pop is the one that was current before the rise.
  const { FocusModeScope } = useFocusTrap({ active: raised, onEscapeDismiss: lower });

  const focusGroup = useId();
  const manager = useContext(FocusManagerContext);
  const cardId = useContext(CardIdContext);
  const rootRef = useRef<HTMLElement | null>(null);
  // Read through a ref so a fresh closure from the card never re-runs the
  // effect that raises and lowers ([L07]).
  const onReturnKeyboardRef = useRef(onReturnKeyboard);
  onReturnKeyboardRef.current = onReturnKeyboard;
  useLayoutEffect(() => {
    if (!raised || manager === null) return;
    const root = rootRef.current;
    manager.place(
      cardId,
      { kind: "focus-key", focusKey: `${focusGroup}:${TRANSCRIPT_FOCUS_ORDER}` },
      { modality: "keyboard" },
    );
    // The shade took the keyboard when it rose, so it owes it back when it
    // lowers. The trap's pop, which runs before this cleanup, restores the key
    // view and grants it. But the shade is most often lowered from inside one
    // of the engine's own gestures, Escape or a press on a stop, and the
    // engine ends such a gesture by parking the keyboard on its sink, after
    // the pop and over the grant it made. So the hand-back is made a
    // microtask later, when that gesture has finished: the restored key view
    // is projected through the engine, ring or caret, and with no key view to
    // return to the card is asked to take the keyboard. A caret that has
    // already gone somewhere of its own, a field the user clicked into or one
    // a surface rising in the shade's place has claimed, is left where it is,
    // and a shade raised again in the meantime keeps what it took.
    return () => {
      queueMicrotask(() => {
        if (controller.getSnapshot()) return;
        const active = document.activeElement;
        const inAField =
          active instanceof HTMLElement &&
          root?.contains(active) !== true &&
          (active.isContentEditable || active.matches("input, textarea"));
        if (inAField) return;
        if (manager.keyView() !== null) manager.focusKeyView();
        else onReturnKeyboardRef.current?.();
      });
    };
  }, [raised, manager, cardId, focusGroup, controller]);

  // The strip of transcript left showing is seen and not operated.
  useLayoutEffect(() => {
    const pane = transcriptPaneRef.current;
    if (!raised || pane === null) return;
    pane.inert = true;
    return () => {
      pane.inert = false;
    };
  }, [raised, transcriptPaneRef]);

  return (
    <section
      ref={rootRef}
      data-slot="session-arc-shade"
      className="session-arc-shade"
      data-raised={raised ? "true" : "false"}
      aria-label="Arc"
      aria-hidden={!raised}
      inert={!raised}
    >
      <FocusModeScope>
        <header className="session-arc-shade-head" data-slot="session-arc-shade-head">
          <span className="session-arc-shade-label">Arc</span>
          {arcName !== null ? (
            <span className="session-arc-shade-name">
              <ArcSigil name={arcName} slot="session-arc-shade-name" />
            </span>
          ) : null}
          <span className="session-arc-shade-spacer" />
          <TugPushButton
            size="xs"
            emphasis="ghost"
            role="action"
            focusGroup={focusGroup}
            focusOrder={TRANSCRIPT_FOCUS_ORDER}
            onClick={lower}
          >
            Transcript
          </TugPushButton>
        </header>
        <div className="session-arc-shade-body" data-slot="session-arc-shade-body">
          {children}
        </div>
      </FocusModeScope>
    </section>
  );
}
