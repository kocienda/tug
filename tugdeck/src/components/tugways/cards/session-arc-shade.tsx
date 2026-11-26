/**
 * SessionArcShade — the shade that rises from the bottom of the Session card's
 * transcript and shows the card's cycle, or its arc when it has no cycle.
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
 * arc it shows from the session's binding. While raised and not covered by
 * another shade it holds a focus mode of its own: the key view moves into the
 * shade, Escape lowers it, and lowering restores the key view that was
 * current when it rose and puts the keyboard back on it, ring or caret; with
 * none to return to, the card is asked to take the keyboard. The composer
 * below stays live.
 *
 * It reads `Cycle` when the session has a cycle and `Arc` when it has none.
 * The control that lowers it is in the header in every form. For an arc, or a
 * cycle of one entry, the header, the footer and the frame are this
 * component's and the body is its children: the footer carries Done at its
 * trailing edge, as the History shade's does, and the key view lands there.
 * For a cycle of several entries the body brings its own header and its own
 * two-line footer, which stand where this component's would; the body's
 * lowering control takes the focus seat this component hands down through
 * `ArcShadeLowerContext`, and the key view lands on it.
 *
 * A Changes or History shade stands over a raised shade without lowering it
 * (`covered`). Covered, the shade is inert and gives up its focus mode, and
 * takes both back when the other shade leaves.
 * Composes `TugPushButton`, `TugTooltip` and `ArcSigil`, which keep their own
 * tokens.
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

import React, { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef } from "react";

import { ChevronDown } from "lucide-react";

import { ArcSigil } from "@/components/tugways/arc-sigil";
import { FocusManagerContext } from "@/components/tugways/focus-manager";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import type { ArcShadeController } from "@/lib/arc-shade-controller";
import { useArcForSession } from "@/lib/arc-session-index";
import { CardIdContext } from "@/lib/card-id-context";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { cycleShadeForm } from "./session-cycle-shade-model";
import { useSessionCycle } from "./use-session-cycle";

/** Focus order of the header's lowering control, first in the shade's walk. */
const LOWER_FOCUS_ORDER = 0;
/** Focus order of the footer's Done button, where the key view lands when there is one. */
const DONE_FOCUS_ORDER = 1;

/**
 * The focus seat of the shade's lowering control. A body that draws its own
 * header, as a cycle of several entries does, gives its lowering control this
 * seat, so the key view the frame places on a raise lands on it.
 */
export interface ArcShadeLowerSeat {
  focusGroup: string;
  focusOrder: number;
}

export const ArcShadeLowerContext = createContext<ArcShadeLowerSeat | null>(null);

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
   * Whether another shade stands over this one. A covered shade stays raised
   * and is inert, and holds no focus mode until the other shade leaves.
   */
  covered?: boolean;
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
  covered = false,
  onReturnKeyboard,
  children,
}: SessionArcShadeProps): React.ReactElement {
  const raised = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const lower = useCallback(() => controller.lower(), [controller]);
  const arc = useArcForSession(tugSessionId);
  const arcName = arc?.name ?? null;
  // Which body the shade holds: a cycle of several entries keeps one height,
  // so its map holds still while the list under it changes.
  const cycle = useSessionCycle(tugSessionId, arc?.ownerId ?? null);
  const form = cycleShadeForm(cycle, arc !== null);
  const several = form === "several";
  const noun = cycle !== null ? "Cycle" : "Arc";
  const lowerLabel = cycle !== null ? "Lower the cycle" : "Lower the arc";
  // The shade is in use while it is raised and nothing stands over it.
  const live = raised && !covered;

  // The shade's own focus mode. Pushed before the seed below runs, so the key
  // view the mode restores on pop is the one that was current before the rise.
  const { FocusModeScope } = useFocusTrap({ active: live, onEscapeDismiss: lower });

  const focusGroup = useId();
  const lowerSeat = useMemo<ArcShadeLowerSeat>(
    () => ({ focusGroup, focusOrder: LOWER_FOCUS_ORDER }),
    [focusGroup],
  );
  // Where the key view lands: Done when the frame carries it, and the body's
  // lowering control when the body's two-line footer stands in Done's place.
  const landingOrder = several ? LOWER_FOCUS_ORDER : DONE_FOCUS_ORDER;
  const manager = useContext(FocusManagerContext);
  const cardId = useContext(CardIdContext);
  const rootRef = useRef<HTMLElement | null>(null);
  // Read through a ref so a fresh closure from the card never re-runs the
  // effect that raises and lowers ([L07]).
  const onReturnKeyboardRef = useRef(onReturnKeyboard);
  onReturnKeyboardRef.current = onReturnKeyboard;
  useLayoutEffect(() => {
    if (!live || manager === null) return;
    const root = rootRef.current;
    manager.place(
      cardId,
      { kind: "focus-key", focusKey: `${focusGroup}:${landingOrder}` },
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
    // and a shade raised again in the meantime keeps what it took. A shade
    // that is still raised was only covered: the shade over it has the
    // keyboard now, and there is nothing to hand back.
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
  }, [live, manager, cardId, focusGroup, landingOrder, controller]);

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
      data-form={form}
      data-covered={raised && covered ? "true" : undefined}
      aria-label={noun}
      aria-hidden={!live}
      inert={!live}
    >
      <FocusModeScope>
        {several ? null : (
          <header className="session-arc-shade-head" data-slot="session-arc-shade-head">
            <span className="session-arc-shade-label" data-slot="session-arc-shade-label">
              {noun}
            </span>
            {arcName !== null ? (
              <span className="session-arc-shade-name">
                <ArcSigil name={arcName} slot="session-arc-shade-name" />
              </span>
            ) : null}
            <span className="session-arc-shade-lower" data-slot="session-arc-shade-lower">
              <TugTooltip content={lowerLabel}>
                <TugPushButton
                  size="xs"
                  subtype="icon"
                  emphasis="ghost"
                  icon={<ChevronDown size={16} />}
                  aria-label={lowerLabel}
                  focusGroup={focusGroup}
                  focusOrder={LOWER_FOCUS_ORDER}
                  onClick={lower}
                />
              </TugTooltip>
            </span>
          </header>
        )}
        <div className="session-arc-shade-body" data-slot="session-arc-shade-body">
          <ArcShadeLowerContext.Provider value={lowerSeat}>{children}</ArcShadeLowerContext.Provider>
        </div>
        {several ? null : (
          <footer className="session-arc-shade-foot" data-slot="session-arc-shade-foot">
            <TugPushButton
              size="sm"
              emphasis="primary"
              role="action"
              focusGroup={focusGroup}
              focusOrder={DONE_FOCUS_ORDER}
              persistentDefaultRing
              onClick={lower}
            >
              Done
            </TugPushButton>
          </footer>
        )}
      </FocusModeScope>
    </section>
  );
}
