/**
 * SessionArcShadeContent — what the arc shade's body shows of the card's
 * cycle and its arc.
 *
 * It is the cycle body, `SessionCycleShade`, for any cycle: the cycle that
 * holds this session's arc, the cycle this session wrote when it has no arc,
 * or, for a bound arc no cycle holds yet, the cycle of one that arc is about
 * to be, composed from the arc's own facts. This session's arc is an entry
 * there, and opening it shows the arc's own reading and its verbs, as the
 * cell's popup shows them: the binding line, the track and its phase word,
 * the ledger, and Stop, Changes, Unbind, Replay, Discard, Join and Resume on
 * one row.
 *
 * With no cycle and no arc the body is the short form's hint, which says so
 * in the one word the ARC cell says. It offers no control that starts an arc
 * or binds one.
 *
 * Composes `ArcPopoverContent`, `TugEmptyLine` and `SessionCycleShade` as
 * they are and adds no styling of its own.
 *
 * The verbs and the confirm Discard arms are hosted here. The confirm hangs
 * off the arc's verb row in its entry. It is rendered beside the cycle body
 * rather than inside it, and the body stays mounted while the shade is
 * lowered, so the confirm survives whatever its answer does to the shade.
 *
 * A file atom in the body, as an open entry's brief is, opens its file: the
 * shade mounts the delegated annotation layer over its own root.
 *
 * Laws: [L02] the session's fields and the arc fact enter through
 *       `useSyncExternalStore`, [L03] the click layer is live before any
 *       click it services, [L11] the verbs are dispatched and the
 *       stores own the state, [L20] the composed content keeps its own
 *       tokens
 */

import React, { useCallback, useContext, useMemo, useRef } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import { useAnnotationClicks } from "@/components/tugways/use-annotation-clicks";
import type { ArcShadeController } from "@/lib/arc-shade-controller";
import { useArcForSession } from "@/lib/arc-session-index";
import { CardIdContext } from "@/lib/card-id-context";
import type { CodeSessionStore } from "@/lib/code-session-store";
import { useSessionFields } from "@/lib/code-session-store/hooks/use-session-fields";
import { useTaskListState } from "@/lib/code-session-store/hooks/use-task-list-state";

import { ArcPopoverContent, useArcPopoverVerbs } from "./session-card-telemetry-popovers";
import { SessionCycleShade } from "./session-cycle-shade";
import { cycleShadeForm } from "./session-cycle-shade-model";
import { useShadeCycle } from "./use-session-cycle";

/** The session fields the arc's reading and its verbs draw on. */
const ARC_CONTENT_FIELDS = ["tugSessionId", "phase", "canSubmit"] as const;

export interface SessionArcShadeContentProps {
  /** The card's session store: its session id, its phase and its task list. */
  codeSessionStore: CodeSessionStore;
  /** The card's arc shade store, which the cycle body's lowering control lowers. */
  controller: ArcShadeController;
}

export function SessionArcShadeContent({
  codeSessionStore,
  controller,
}: SessionArcShadeContentProps): React.ReactElement {
  const snap = useSessionFields(codeSessionStore, ARC_CONTENT_FIELDS);
  const fact = useArcForSession(snap.tugSessionId);
  const taskListState = useTaskListState(codeSessionStore);
  const idle = snap.phase === "idle";
  const cardId = useContext(CardIdContext);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The shade stands outside the transcript, whose delegated layer services
  // a file atom's press, so it mounts the same layer over its own root: the
  // brief's atom in an open entry opens the brief.
  useAnnotationClicks(rootRef, {});
  // Where Discard's confirm hangs: the arc's verb row in its entry. Read when
  // the confirm opens, since the entry may have re-mounted it since this
  // component last rendered.
  const confirmAnchor = useMemo<React.RefObject<HTMLElement | null>>(
    () => ({
      get current(): HTMLElement | null {
        return rootRef.current?.querySelector<HTMLElement>('[data-slot="arc-verb-row"]') ?? rootRef.current;
      },
    }),
    [],
  );

  // "Changes" raises this card's Changes shade, a verb whose handler lives on
  // the card's own content responder. Raising it lowers the arc shade, which
  // the card keeps exclusive with its other shades.
  const chain = useResponderChain();
  const revealChanges = useCallback(() => {
    const target = `${cardId}-card-content`;
    if (chain === null || !chain.hasResponder(target)) return;
    chain.sendToTarget(target, {
      action: TUG_ACTIONS.REVEAL_CHANGES,
      phase: "discrete",
    });
  }, [chain, cardId]);

  const arcVerbs = useArcPopoverVerbs({
    fact,
    idle,
    cardKey: cardId ?? snap.tugSessionId,
    onShowInChanges: revealChanges,
    anchor: confirmAnchor,
  });

  // The cycle this card shows, the stand-in for a bound arc included, and
  // which of the two bodies that makes.
  const cycle = useShadeCycle(snap.tugSessionId, fact);
  const form = cycleShadeForm(cycle);
  const lower = useCallback(() => controller.lower(), [controller]);
  // This session's own arc, as its entry in the cycle body holds it: the
  // arc's steps and verbs, so nothing about stopping or landing an arc is
  // lost by drawing it as an entry.
  const hereBody =
    fact !== null && arcVerbs.verbs !== null ? (
      <ArcPopoverContent
        fact={fact}
        tasks={taskListState.tasks}
        idle={idle}
        verbs={arcVerbs.verbs}
        onVerb={arcVerbs.onVerb}
        verbLabels="lead-only"
        layout="inline"
      />
    ) : undefined;
  return (
    <div ref={rootRef} data-slot="session-arc-shade-content" data-form={form}>
      {form === "several" && cycle !== null ? (
        // Keyed by the cycle, so a card that comes to show another cycle
        // starts with nothing selected. The stand-in's key is its arc's, so
        // the attach that puts the arc on its real cycle starts it afresh.
        <SessionCycleShade
          key={cycle.id}
          cycle={cycle}
          sessionId={snap.tugSessionId}
          boundOwnerId={fact?.ownerId ?? null}
          onLower={lower}
          hereBody={hereBody}
        />
      ) : (
        <TugEmptyLine data-slot="session-arc-shade-none">None</TugEmptyLine>
      )}
      {arcVerbs.confirm}
    </div>
  );
}
