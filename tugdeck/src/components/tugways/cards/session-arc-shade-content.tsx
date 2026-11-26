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
 * says what an arc is and how to start one, and links to the guide.
 * Under it are the project's unbound arcs, the ones no session is working,
 * each with Bind, which sends the same `bind_arc` frame the Changes shade's
 * lane and the Arcs card send. Nothing moves until `bind_arc_ok` arrives, and
 * then the shade shows the bound arc's panels.
 *
 * A session in a cycle of several entries is shown the cycle instead: the
 * body is `SessionCycleShade`. A cycle of one entry reads as its arc does:
 * the three panels above when the arc is this session's, and when it is not,
 * three panels built from the entry: its sketch, its brief, and one line for
 * where the arc stands, with no verbs, since the arc is not this session's
 * to act on.
 *
 * Composes `SessionArcPanels`, `ArcBriefDetail`, `ArcBriefHeadings`,
 * `ArcPopoverContent`, `SessionArcShadeHint` and `SessionCycleShade` as they
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
import { compareArcEntries } from "@/lib/arc-order";
import { useArcForSession } from "@/lib/arc-session-index";
import { CardIdContext } from "@/lib/card-id-context";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { useChangesetAll } from "@/lib/changeset-all-store";
import type { ArcChangesetEntry } from "@/lib/changeset-types";
import type { CodeSessionStore } from "@/lib/code-session-store";
import { useSessionFields } from "@/lib/code-session-store/hooks/use-session-fields";
import { useTaskListState } from "@/lib/code-session-store/hooks/use-task-list-state";
import { getConnection } from "@/lib/connection-singleton";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { ArcBriefDetail, ArcBriefHeadings } from "./session-arc-brief";
import { SessionArcPanels, type SessionArcPanel } from "./session-arc-panels";
import { NOT_RECORDED, recordPanel } from "./session-arc-record-panel";
import { SessionArcShadeHint } from "./session-arc-shade-hint";
import { ArcPopoverContent, useArcPopoverVerbs } from "./session-card-telemetry-popovers";
import { SessionCycleShade } from "./session-cycle-shade";
import {
  arcRowsByOwner,
  cycleEntrySketchText,
  cycleEntryStanding,
  cycleShadeEntries,
  cycleShadeForm,
} from "./session-cycle-shade-model";
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

  // The project's unbound arcs, in the one order arcs are listed in. Read
  // only for a session with no arc, which is the only time they are shown.
  const projectDir = useSyncExternalStore(cardSessionBindingStore.subscribe, () =>
    cardId === null ? null : (cardSessionBindingStore.getBinding(cardId)?.projectDir ?? null),
  );
  const aggregate = useChangesetAll();
  const unboundArcs = useMemo<readonly ArcChangesetEntry[]>(() => {
    if (fact !== null || projectDir === null) return [];
    const project = aggregate.projects.find((p) => p.project_dir === projectDir);
    const arcs: ArcChangesetEntry[] = [];
    for (const entry of project?.changesets ?? []) {
      if (entry.kind === "arc" && entry.bound_session === undefined) arcs.push(entry);
    }
    return arcs.sort(compareArcEntries);
  }, [aggregate, projectDir, fact]);
  const bindArc = useCallback(
    (entry: ArcChangesetEntry) => {
      if (snap.tugSessionId === null || projectDir === null) return;
      // The name comes from the aggregate, never free text: `bind_arc` mints
      // an arc for a name it does not know.
      getConnection()?.sendControlFrame("bind_arc", {
        tug_session_id: snap.tugSessionId,
        project_dir: projectDir,
        arc: entry.display_name,
      });
    },
    [snap.tugSessionId, projectDir],
  );

  const arcVerbs = useArcPopoverVerbs({
    fact,
    idle,
    cardKey: cardId ?? snap.tugSessionId,
    onShowInChanges: revealChanges,
    anchor: confirmAnchor,
  });

  // The cycle this card shows, and which of the three bodies that makes.
  const cycle = useSessionCycle(snap.tugSessionId, fact?.ownerId ?? null);
  const form = cycleShadeForm(cycle, fact !== null);
  const lower = useCallback(() => controller.lower(), [controller]);
  // A cycle of one whose arc is not this session's: the panels are built
  // from the entry.
  const entryPanels = useMemo<Record<"sketch" | "brief" | "arc", SessionArcPanel> | null>(() => {
    if (form !== "one" || fact !== null || cycle === null) return null;
    const [read] = cycleShadeEntries(cycle, {
      sessionId: snap.tugSessionId,
      boundOwnerId: null,
      arcRows: arcRowsByOwner(aggregate),
    });
    if (read === undefined) return null;
    const { entry } = read;
    const standing = cycleEntryStanding(read);
    return {
      sketch: recordPanel(cycleEntrySketchText(cycle, entry) ?? undefined),
      brief:
        entry.brief_path !== undefined
          ? {
              state: "done",
              title: entry.brief_title ?? "brief.md",
              detail: <ArcBriefDetail path={entry.brief_path} projectDir={cycle.project_dir} />,
              body: <ArcBriefHeadings path={entry.brief_path} />,
            }
          : { state: "pending", title: entry.brief },
      arc: {
        state: standing.state,
        title: standing.title,
        ...(standing.detail !== null ? { detail: standing.detail } : {}),
      },
    };
  }, [form, fact, cycle, snap.tugSessionId, aggregate]);

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
        />
      ) : entryPanels !== null ? (
        <SessionArcPanels raised={raised} panels={entryPanels} />
      ) : fact === null || arcVerbs.verbs === null ? (
        <SessionArcShadeHint canStart={snap.canSubmit && fact === null} unboundArcs={unboundArcs} onBind={bindArc} />
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
