/**
 * SessionArcShadeContent — what the arc shade's body shows of the card's arc.
 *
 * With an arc it is the arc's three panels: Sketch, Brief and Arc, in that
 * order. The Arc panel is the arc's own reading and its verbs, as the
 * cell's popup shows them: the binding line, the track and its phase word,
 * the ledger, and the footer's Stop, Changes, Unbind, Replay, Discard, Join
 * and Resume, on one row: the next move keeps its word and the rest are
 * icons that open under the pointer or keyboard focus. Its dot holds its
 * pose while the arc is stopped. The Brief panel shows the arc's brief when
 * it has one: its title, its path, which opens it, and the findings
 * and decisions it marks. The Sketch panel shows the arc's record of where
 * the work came from, as written: what is wanted, then the shape the work
 * will take; an arc with no record says None.
 * With no arc and no cycle there are no panels: the body is
 * the short form's hint, which says so in the one word the ARC cell says,
 * says what an arc is and how to start one, and links to the guide. It
 * offers no control that starts an arc or binds one.
 *
 * A session in a cycle of several entries is shown the cycle instead: the
 * body is `SessionCycleShade`. A cycle of one entry reads as its arc does:
 * the three panels above when the arc is this session's, and when it is not,
 * three panels built from the entry: its sketch, its brief, and one line for
 * where the arc stands, with no verbs, since the arc is not this session's
 * to act on.
 *
 * Composes `SessionArcPanels`, `ArcBriefDetail`, `ArcBriefHeadings`,
 * `ArcPopoverContent`, `TugEmptyLine` and `SessionCycleShade` as they
 * are and adds no styling of its own.
 *
 * The verbs and the confirm Discard arms are hosted here. The confirm hangs
 * off the Arc panel, over the verb row that armed it. It is rendered beside
 * the panels rather than inside one, and the panels stay mounted while the
 * shade is lowered, so the confirm survives whatever its answer does to the
 * shade.
 *
 * Laws: [L02] the session's fields and the arc fact enter through
 *       `useSyncExternalStore`, [L11] the verbs are dispatched and the
 *       stores own the state, [L20] the composed content keeps its own
 *       tokens
 */

import React, { useCallback, useContext, useMemo, useRef } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import type { ArcShadeController } from "@/lib/arc-shade-controller";
import { useArcForSession } from "@/lib/arc-session-index";
import { CardIdContext } from "@/lib/card-id-context";
import type { CodeSessionStore } from "@/lib/code-session-store";
import { useSessionFields } from "@/lib/code-session-store/hooks/use-session-fields";
import { useTaskListState } from "@/lib/code-session-store/hooks/use-task-list-state";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { ArcBriefDetail, ArcBriefHeadings } from "./session-arc-brief";
import { SessionArcPanels } from "./session-arc-panels";
import { NOT_RECORDED, recordPanel } from "./session-arc-record-panel";
import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import { ArcPopoverContent, useArcPopoverVerbs } from "./session-card-telemetry-popovers";
import { SessionCycleShade } from "./session-cycle-shade";
import { cycleShadeForm } from "./session-cycle-shade-model";
import { useSessionCycle } from "./use-session-cycle";

// The Sketch panel's helpers live in their own module; these names stay
// importable from here.
export { NOT_RECORDED, recordPanel };

/** The session fields the arc's reading and its verbs draw on. */
const ARC_CONTENT_FIELDS = ["tugSessionId", "phase", "canSubmit"] as const;

/** The Arc panel, within this component's root. */
const ARC_PANEL_SELECTOR = '[data-slot="session-arc-panel"][data-rung="arc"]';

export interface SessionArcShadeContentProps {
  /** The card's session store: its session id, its phase and its task list. */
  codeSessionStore: CodeSessionStore;
  /**
   * The card's arc shade store. Each time the shade is raised, no panel is
   * expanded.
   */
  controller: ArcShadeController;
}

export function SessionArcShadeContent({
  codeSessionStore,
  controller,
}: SessionArcShadeContentProps): React.ReactElement {
  const raised = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const snap = useSessionFields(codeSessionStore, ARC_CONTENT_FIELDS);
  const fact = useArcForSession(snap.tugSessionId);
  const taskListState = useTaskListState(codeSessionStore);
  const idle = snap.phase === "idle";
  const cardId = useContext(CardIdContext);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Where Discard's confirm hangs: the Arc panel's verb row, or the panel
  // itself. Read when the confirm opens, since the panels own the panel's
  // element and may have re-mounted it since this component last rendered.
  const confirmAnchor = useMemo<React.RefObject<HTMLElement | null>>(
    () => ({
      get current(): HTMLElement | null {
        const root = rootRef.current;
        const panel = root?.querySelector<HTMLElement>(ARC_PANEL_SELECTOR) ?? null;
        // In the cycle body the verbs are in the arc's entry, not in a panel.
        return (panel ?? root)?.querySelector<HTMLElement>('[data-slot="arc-verb-row"]') ?? panel;
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

  // The cycle this card shows, and which of the three bodies that makes:
  // the cycle body for any cycle, the three panels for an arc no cycle
  // holds, and the hint for neither.
  const cycle = useSessionCycle(snap.tugSessionId, fact?.ownerId ?? null);
  const form = cycleShadeForm(cycle, fact !== null);
  const lower = useCallback(() => controller.lower(), [controller]);
  // This session's own arc, as its entry in the cycle body holds it: the
  // arc's steps and verbs, and its brief by its headings. The verbs are the
  // same ones the Arc panel carries, so nothing about stopping or landing an
  // arc is lost by drawing it as an entry.
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
  const hereBrief =
    fact?.documents?.brief !== undefined ? <ArcBriefHeadings path={fact.documents.brief} /> : undefined;

  return (
    <div ref={rootRef} data-slot="session-arc-shade-content" data-form={form}>
      {form === "several" && cycle !== null ? (
        // Keyed by the cycle, so a card that comes to show another cycle
        // starts with nothing selected.
        <SessionCycleShade
          key={cycle.id}
          cycle={cycle}
          sessionId={snap.tugSessionId}
          boundOwnerId={fact?.ownerId ?? null}
          onLower={lower}
          hereBody={hereBody}
          hereBrief={hereBrief}
        />
      ) : fact === null || arcVerbs.verbs === null ? (
        <TugEmptyLine data-slot="session-arc-shade-none">None</TugEmptyLine>
      ) : (
        <SessionArcPanels
          raised={raised}
          // The seams follow from the panels: the arc is cut from its brief,
          // so Brief to Arc is joined whenever there is one.
          panels={{
            sketch: recordPanel(fact.documents?.sketch_text),
            brief:
              fact.documents?.brief !== undefined
                ? {
                    state: "done",
                    title: fact.documents.brief_title ?? "brief.md",
                    detail: <ArcBriefDetail path={fact.documents.brief} projectDir={fact.projectDir} />,
                    body: <ArcBriefHeadings path={fact.documents.brief} />,
                  }
                : { state: "pending", title: "No brief" },
            arc: {
              state: fact.arc?.done === true ? "done" : "active",
              paused: fact.arc?.stopped !== undefined,
              full: true,
              body: (
                <ArcPopoverContent
                  fact={fact}
                  tasks={taskListState.tasks}
                  idle={idle}
                  verbs={arcVerbs.verbs}
                  onVerb={arcVerbs.onVerb}
                  verbLabels="lead-only"
                />
              ),
            },
          }}
        />
      )}
      {arcVerbs.confirm}
    </div>
  );
}
