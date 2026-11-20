/**
 * SessionArcPanels — the arc shade's body as four fixed panels in a 2×2 grid:
 * Idea top-left, Sketch top-right, Brief bottom-left, Arc bottom-right.
 *
 * The order is said three ways: by position, by the number each panel wears,
 * and by the seams, an arrow across each row and a return from the second
 * panel down to the third. A seam is solid where there is something on both
 * sides of it and dotted where there is not. The seams are grid tracks of
 * their own, so no mark ever sits over a panel.
 *
 * A panel is three bands: a header with its progress dot, number and name on
 * one line; a body that scrolls inside the panel; and an optional floor under
 * the body and outside its scrolling, which is where a panel's buttons go.
 * The panel clips to its box. A panel marked full gives its body the whole
 * panel under the header, for content that is a surface in its own right and
 * brings its own scroller and footer.
 *
 * One panel holds the larger share of the grid: its column and its row take
 * three parts to the other's two. At rest that is the rung the work is at.
 * Pressing a panel, or moving keyboard focus into it, gives it the share
 * instead. Which panel holds it is the `data-focus` attribute on the grid,
 * written straight to the DOM and read by the sheet, so a press renders
 * nothing. It is not saved, and it returns to the resting panel each time
 * `raised` becomes true. A press that lands on a control inside a panel moves
 * the share only once the press has been delivered, so the control does not
 * move out from under the pointer.
 *
 * The grid keeps a minimum height. In a host shorter than that the host
 * scrolls, and the panel given the larger share is brought into its view.
 *
 * While the Arc panel does not hold the larger share, the sheet hides every
 * verb in it but the lead one.
 *
 * What each panel says is the caller's. Composes `TugProgressIndicator`,
 * which keeps its own tokens.
 *
 * Laws: [L06] the pressed panel is a DOM attribute and CSS, never React
 *       state, [L16] pairings declared, [L19] component authoring guide,
 *       [L20] composed children keep their tokens, [L23] the host's scroll
 *       moves only as far as it takes to show the panel
 */

import "./session-arc-panels.css";

import React, { useLayoutEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import {
  ARC_PANEL_RUNGS,
  arcPanelDotState,
  arcPanelRestingFocus,
  arcPanelSeamStates,
  type ArcPanelRung,
  type ArcPanelSeamState,
  type ArcPanelState,
} from "@/lib/arc-panels";
import { layoutRectOf } from "@/lib/page-zoom-store";

/** The name each panel wears in its header. */
const RUNG_LABELS: Record<ArcPanelRung, string> = {
  idea: "Idea",
  sketch: "Sketch",
  brief: "Brief",
  arc: "Arc",
};

/** A panel's element, from anything inside it. */
const PANEL_SELECTOR = '[data-slot="session-arc-panel"]';

/** What a press must reach before the grid moves under it: a panel's own controls. */
const CONTROL_SELECTOR = 'button, input, textarea, a, [role="button"], [contenteditable="true"]';

/**
 * Bring a panel into the view of the nearest ancestor that scrolls down the
 * page, moving that ancestor's own `scrollTop` and no further than it takes.
 * A panel taller than the view shows its lower edge, where its floor and its
 * verbs are. With no such ancestor, or the panel already in view, nothing
 * moves.
 */
function revealPanel(panel: HTMLElement): void {
  for (let host = panel.parentElement; host !== null; host = host.parentElement) {
    if (host.scrollHeight <= host.clientHeight) continue;
    const overflowY = getComputedStyle(host).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    // Layout px, which is what `scrollTop` is in.
    const view = layoutRectOf(host);
    const box = layoutRectOf(panel);
    if (box.bottom > view.bottom) host.scrollTop += box.bottom - view.bottom;
    else if (box.top < view.top) host.scrollTop -= view.top - box.top;
    return;
  }
}

/** What one panel says. */
export interface SessionArcPanel {
  /**
   * Where the rung is: `done` is settled, `active` is where the work is, and
   * `pending` is a seat nothing fills yet.
   * @selector [data-state="done"] | [data-state="active"] | [data-state="pending"]
   */
  state: ArcPanelState;
  /**
   * The work at this rung is stopped: an active panel's dot holds its pose
   * rather than pulsing.
   * @default false
   */
  paused?: boolean;
  /** The panel's heading, at the top of its body. */
  title?: string;
  /** What the panel says under its title. */
  detail?: React.ReactNode;
  /** The rest of the panel's body. It scrolls with the title and detail. */
  body?: React.ReactNode;
  /**
   * The body is a whole surface of its own: it fills the panel edge to edge
   * under the header, brings its own scroller, and the panel wears no title
   * or detail.
   * @selector [data-full="true"]
   * @default false
   */
  full?: boolean;
  /** The panel's floor, under the body. It never scrolls. */
  foot?: React.ReactNode;
}

export interface SessionArcPanelsProps {
  /** The four panels' content. */
  panels: Readonly<Record<ArcPanelRung, SessionArcPanel>>;
  /**
   * Whether the surface holding the panels is showing. Each time it becomes
   * true, the larger share returns to the resting panel.
   * @default true
   */
  raised?: boolean;
}

export function SessionArcPanels({ panels, raised = true }: SessionArcPanelsProps): React.ReactElement {
  const gridRef = useRef<HTMLDivElement | null>(null);
  // A press is down on a control inside a panel. The share waits for the
  // click, so the control is still under the pointer when the press ends.
  const pressOnControl = useRef(false);

  const states = {
    idea: panels.idea.state,
    sketch: panels.sketch.state,
    brief: panels.brief.state,
    arc: panels.arc.state,
  };
  const resting = arcPanelRestingFocus(states);
  const seams = arcPanelSeamStates(states);

  // The pressed panel is forgotten when the surface is put away: raised
  // again, the resting panel holds the share.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!raised || grid === null) return;
    grid.dataset.focus = resting;
    const panel = grid.querySelector<HTMLElement>(`${PANEL_SELECTOR}[data-rung="${resting}"]`);
    if (panel !== null) revealPanel(panel);
  }, [raised, resting]);

  /** Give the panel holding `target` the larger share. */
  const focusPanelOf = (target: EventTarget): void => {
    const grid = gridRef.current;
    if (grid === null || !(target instanceof Element)) return;
    const panel = target.closest<HTMLElement>(PANEL_SELECTOR);
    const rung = panel?.dataset.rung;
    if (panel === null || rung === undefined || grid.dataset.focus === rung) return;
    grid.dataset.focus = rung;
    revealPanel(panel);
  };

  const endPress = (): void => {
    pressOnControl.current = false;
  };

  const panel = (rung: ArcPanelRung): React.ReactElement => {
    const { state, paused, title, detail, body, full, foot } = panels[rung];
    return (
      <section
        data-slot="session-arc-panel"
        className="session-arc-panel"
        data-rung={rung}
        data-state={state}
        data-full={full === true ? "true" : undefined}
        aria-label={RUNG_LABELS[rung]}
      >
        <header className="session-arc-panel-head">
          <span className="session-arc-panel-dot" data-slot="session-arc-panel-dot">
            <TugProgressIndicator
              variant="pulsing-dot"
              size={12}
              state={arcPanelDotState(state, paused === true)}
              aria-hidden
            />
          </span>
          <span className="session-arc-panel-name">
            <span className="session-arc-panel-number">{ARC_PANEL_RUNGS.indexOf(rung) + 1}</span>
            {RUNG_LABELS[rung]}
          </span>
        </header>
        <div className="session-arc-panel-body" data-slot="session-arc-panel-body">
          {full !== true && title !== undefined ? <h3 className="session-arc-panel-title">{title}</h3> : null}
          {full !== true && detail !== undefined ? <div className="session-arc-panel-detail">{detail}</div> : null}
          {body}
        </div>
        {foot !== undefined ? (
          <footer className="session-arc-panel-foot" data-slot="session-arc-panel-foot">
            {foot}
          </footer>
        ) : null}
      </section>
    );
  };

  return (
    <div
      ref={gridRef}
      data-slot="session-arc-panels"
      className="session-arc-panels"
      data-focus={resting}
      onPointerDown={(event) => {
        pressOnControl.current =
          event.target instanceof Element && event.target.closest(CONTROL_SELECTOR) !== null;
        if (!pressOnControl.current) focusPanelOf(event.target);
      }}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerLeave={endPress}
      onClick={(event) => focusPanelOf(event.target)}
      onFocus={(event) => {
        if (!pressOnControl.current) focusPanelOf(event.target);
      }}
    >
      {panel("idea")}
      <RowSeam from="idea" state={seams[0]} />
      {panel("sketch")}
      <ReturnSeam state={seams[1]} />
      {panel("brief")}
      <RowSeam from="brief" state={seams[2]} />
      {panel("arc")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

/** The arrow across a row's seam: this panel leads to the one on its right. */
function RowSeam({ from, state }: { from: ArcPanelRung; state: ArcPanelSeamState }): React.ReactElement {
  return (
    <div
      className="session-arc-panel-seam session-arc-panel-seam-row"
      data-slot="session-arc-panel-seam"
      data-from={from}
      data-state={state}
      aria-hidden="true"
    >
      <span className="session-arc-panel-seam-line" />
      <ChevronRight className="session-arc-panel-seam-head" size={14} />
    </div>
  );
}

/**
 * The return across the middle: down out of the second panel, back along the
 * seam, and down into the third. It is laid on the grid's own columns, so its
 * two drops stay over the middles of the panels however the room is shared.
 */
function ReturnSeam({ state }: { state: ArcPanelSeamState }): React.ReactElement {
  return (
    <div
      className="session-arc-panel-seam session-arc-panel-seam-return"
      data-slot="session-arc-panel-seam"
      data-from="sketch"
      data-state={state}
      aria-hidden="true"
    >
      <span className="session-arc-panel-return" data-part="into">
        <ChevronDown className="session-arc-panel-seam-head" size={14} />
      </span>
      <span className="session-arc-panel-return" data-part="across" />
      <span className="session-arc-panel-return" data-part="out" />
    </div>
  );
}
