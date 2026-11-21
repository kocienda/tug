/**
 * SessionArcShadeContent — what the arc shade's body shows of the card's arc.
 *
 * With an arc it is the arc's four panels: Idea, Sketch, Brief and Arc, in
 * that order. The Arc panel is the arc's own reading and its verbs, as the
 * cell's popup shows them: the binding line, the track and its phase word,
 * the ledger, and the footer's Stop, Changes, Unbind, Replay, Discard, Join
 * and Resume, on one row: the next move keeps its word and the rest are
 * icons that open under the pointer or keyboard focus. Its dot holds its
 * pose while the arc is stopped. The Brief panel shows the arc's brief when
 * it has one: its title, its path, which opens it, and the findings
 * and decisions it marks. The Idea and Sketch panels show the arc's records
 * of the prompt the work began as and of how the conversation took it to
 * the brief, as written; an arc with no record says None.
 * With no arc there are no panels: the body is
 * the short form's hint, which says so in the one word the ARC cell says,
 * says what an arc is and how to start one, and links to the guide.
 *
 * Composes `SessionArcPanels`, `ArcBriefDetail`, `ArcBriefHeadings`,
 * `ArcPopoverContent` and `SessionArcShadeHint` as they are and adds no
 * styling of its own.
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
import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import type { ArcShadeController } from "@/lib/arc-shade-controller";
import { parseArcRecord } from "@/lib/arc-record-text";
import { useArcForSession } from "@/lib/arc-session-index";
import { CardIdContext } from "@/lib/card-id-context";
import type { CodeSessionStore } from "@/lib/code-session-store";
import { useSessionFields } from "@/lib/code-session-store/hooks/use-session-fields";
import { useTaskListState } from "@/lib/code-session-store/hooks/use-task-list-state";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { ArcBriefDetail, ArcBriefHeadings } from "./session-arc-brief";
import { SessionArcPanels, type SessionArcPanel } from "./session-arc-panels";
import { SessionArcShadeHint } from "./session-arc-shade-hint";
import { ArcPopoverContent, useArcPopoverVerbs } from "./session-card-telemetry-popovers";

/** The session fields the arc's reading and its verbs draw on. */
const ARC_CONTENT_FIELDS = ["tugSessionId", "phase", "canSubmit"] as const;

/**
 * A rung nothing records yet: an empty seat, which says so as every empty
 * list in the app does, with the one centred word.
 */
export const NOT_RECORDED: SessionArcPanel = {
  state: "pending",
  body: <TugEmptyLine>None</TugEmptyLine>,
};

/**
 * The Idea or Sketch panel for an arc's record: its sentences and the list
 * under them, or the empty seat when the arc has none, as an arc opened
 * before records were kept has none.
 */
export function recordPanel(text: string | undefined): SessionArcPanel {
  if (text === undefined || text.trim() === "") return NOT_RECORDED;
  return {
    state: "done",
    body: (
      <div className="session-arc-panel-text" data-slot="session-arc-panel-text">
        {parseArcRecord(text).map((block, index) =>
          block.kind === "paragraph" ? (
            <p key={index}>{block.text}</p>
          ) : (
            <ul key={index}>
              {block.items.map((item, at) => (
                <li key={at}>{item}</li>
              ))}
            </ul>
          ),
        )}
      </div>
    ),
  };
}

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
        const panel = rootRef.current?.querySelector<HTMLElement>(ARC_PANEL_SELECTOR) ?? null;
        return panel?.querySelector<HTMLElement>('[data-slot="arc-verb-row"]') ?? panel;
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

  return (
    <div ref={rootRef} data-slot="session-arc-shade-content">
      {fact === null || arcVerbs.verbs === null ? (
        <SessionArcShadeHint canStart={snap.canSubmit && fact === null} />
      ) : (
        <SessionArcPanels
          raised={raised}
          // The seams follow from the panels: the arc is cut from its brief,
          // so Brief to Arc is joined whenever there is one.
          panels={{
            idea: recordPanel(fact.documents?.idea_text),
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
