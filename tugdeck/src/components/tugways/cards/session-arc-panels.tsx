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
 * Each row is as tall as the taller of its two panels needs, down to a floor
 * of a header and one line, so the grid is as tall as what it holds. Under a
 * host that caps its height the rows share the room: a row that needs little
 * keeps it, and the other's panels scroll inside themselves.
 *
 * The two columns are equal and nothing moves on a press, so a panel's text
 * wraps one way and the rows' heights hold still. The grid never shrinks
 * below its two rows' floors; in a host shorter than that the host scrolls.
 *
 * What each panel says is the caller's. Composes `TugProgressIndicator`,
 * which keeps its own tokens.
 *
 * Laws: [L06] the grid's sizing is CSS, never React state, [L16] pairings
 *       declared, [L19] component authoring guide, [L20] composed children
 *       keep their tokens
 */

import "./session-arc-panels.css";

import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import {
  ARC_PANEL_RUNGS,
  arcPanelDotState,
  arcPanelSeamStates,
  type ArcPanelRung,
  type ArcPanelSeamState,
  type ArcPanelState,
} from "@/lib/arc-panels";

/** The name each panel wears in its header. */
const RUNG_LABELS: Record<ArcPanelRung, string> = {
  idea: "Idea",
  sketch: "Sketch",
  brief: "Brief",
  arc: "Arc",
};

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
}

export function SessionArcPanels({ panels }: SessionArcPanelsProps): React.ReactElement {
  const states = {
    idea: panels.idea.state,
    sketch: panels.sketch.state,
    brief: panels.brief.state,
    arc: panels.arc.state,
  };
  const seams = arcPanelSeamStates(states);

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
    <div data-slot="session-arc-panels" className="session-arc-panels">
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
 * two drops stay over the middles of the panels.
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
