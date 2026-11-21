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
 * At rest the two columns are equal. A press on a panel expands it: its
 * column takes two parts to the other's one, and its body's cap of lines
 * doubles. A second press on the expanded panel, anywhere but on one of its
 * controls, puts the grid back at rest. Which panel is expanded is the
 * `data-expanded` attribute on the grid, written straight to the DOM and
 * read by the sheet, so a press renders nothing. It is not saved, and each
 * time `raised` becomes true the grid is at rest again. Keyboard focus moves
 * nothing. The grid never shrinks below its two rows' floors; in a host
 * shorter than that the host scrolls.
 *
 * The change is a motion, never a cut. A press reads the grid's tracks as
 * they stand, applies the new state, reads the tracks it settles at, and
 * moves the columns and the rows from the one to the other on one curve, so
 * the column edge, both rows and the host's height arrive together and the
 * text rewraps as its panel's edge passes. While it runs the grid wears
 * `data-moving`, and the panel that was expanded is named by `data-leaving`
 * and keeps its wider cap until it has arrived. A press mid-motion starts
 * from where the tracks are. With motion off the change is a cut.
 *
 * What each panel says is the caller's. Composes `TugProgressIndicator`,
 * which keeps its own tokens.
 *
 * Laws: [L06] the expanded panel is a DOM attribute and CSS, never React
 *       state, [L13] the motion is the animator's, scaled by the timing
 *       scale and still under motion off, [L16] pairings declared, [L19]
 *       component authoring guide, [L20] composed children keep their tokens
 */

import "./session-arc-panels.css";

import React, { useLayoutEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { animate, type TugAnimation } from "@/components/tugways/tug-animator";
import {
  ARC_PANEL_RUNGS,
  arcPanelDotState,
  arcPanelSeamStates,
  type ArcPanelRung,
  type ArcPanelSeamState,
  type ArcPanelState,
} from "@/lib/arc-panels";
import { isTugMotionEnabled } from "@/lib/scale-timing";

/** The name each panel wears in its header. */
const RUNG_LABELS: Record<ArcPanelRung, string> = {
  idea: "Idea",
  sketch: "Sketch",
  brief: "Brief",
  arc: "Arc",
};

/** A panel's element, from anything inside it. */
const PANEL_SELECTOR = '[data-slot="session-arc-panel"]';

/** A panel's own controls: a press on one in the expanded panel is the control's alone. */
const CONTROL_SELECTOR = 'button, input, textarea, a, [role="button"], [contenteditable="true"]';

/** How long a panel takes to expand or go back, in ms before the timing scale. */
const EXPAND_MS = 300;

/** The grid's tracks as they stand, in px: what the motion runs between. */
interface GridTracks {
  columns: string;
  rows: string;
}

function tracksOf(grid: HTMLElement): GridTracks {
  const style = getComputedStyle(grid);
  return { columns: style.gridTemplateColumns, rows: style.gridTemplateRows };
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
   * true, no panel is expanded.
   * @default true
   */
  raised?: boolean;
}

export function SessionArcPanels({ panels, raised = true }: SessionArcPanelsProps): React.ReactElement {
  const gridRef = useRef<HTMLDivElement | null>(null);
  /** The motion under way, if any. */
  const motionRef = useRef<TugAnimation | null>(null);

  /** Ends the motion under way where it stands and hands the tracks back to the sheet. */
  const stopMotion = (grid: HTMLElement): void => {
    const motion = motionRef.current;
    motionRef.current = null;
    // The effect is removed outright: a motion ended through the animator
    // would hold or commit its tracks, and the next reading would be of
    // those rather than of what the sheet gives.
    motion?.raw.cancel();
    grid.style.gridTemplateColumns = "";
    grid.style.gridTemplateRows = "";
    delete grid.dataset.moving;
    delete grid.dataset.leaving;
  };

  /**
   * Puts `rung` in the expanded seat, or nothing, and moves the grid there
   * from where it stands.
   */
  const expand = (grid: HTMLElement, rung: string | undefined): void => {
    const before = grid.dataset.expanded;
    const from = tracksOf(grid);
    stopMotion(grid);
    if (rung === undefined) delete grid.dataset.expanded;
    else grid.dataset.expanded = rung;
    if (!isTugMotionEnabled()) return;
    const to = tracksOf(grid);
    if (from.columns === to.columns && from.rows === to.rows) return;
    grid.dataset.moving = "true";
    // The panel going back keeps its wider cap until it has arrived, so its
    // body is not cut short in a row still on its way down.
    if (before !== undefined && before !== rung) grid.dataset.leaving = before;
    const motion = animate(
      grid,
      [
        { gridTemplateColumns: from.columns, gridTemplateRows: from.rows },
        { gridTemplateColumns: to.columns, gridTemplateRows: to.rows },
      ],
      { duration: EXPAND_MS, easing: "ease-in-out" },
    );
    motionRef.current = motion;
    // The animator leaves the tracks it arrived at on the element; they go
    // back to the sheet, which sizes them by content again. A motion that a
    // later press replaced is no longer this one's to end.
    const arrived = (): void => {
      if (motionRef.current === motion) stopMotion(grid);
    };
    motion.finished.then(arrived, arrived);
  };

  // The expanded panel is forgotten when the surface is put away, without a
  // motion: the grid is at rest by the time it shows.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!raised || grid === null) return;
    stopMotion(grid);
    delete grid.dataset.expanded;
  }, [raised]);

  // Nothing is left running on a grid that is gone.
  useLayoutEffect(
    () => () => {
      motionRef.current?.raw.cancel();
      motionRef.current = null;
    },
    [],
  );

  /**
   * A press expands the panel it lands in. On the panel already expanded it
   * puts the grid back at rest, unless it landed on one of the panel's
   * controls, which is a press on the control and nothing more.
   */
  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const grid = gridRef.current;
    if (grid === null || !(event.target instanceof Element)) return;
    const rung = event.target.closest<HTMLElement>(PANEL_SELECTOR)?.dataset.rung;
    if (rung === undefined) return;
    if (grid.dataset.expanded !== rung) expand(grid, rung);
    else if (event.target.closest(CONTROL_SELECTOR) === null) expand(grid, undefined);
  };

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
    <div ref={gridRef} data-slot="session-arc-panels" className="session-arc-panels" onClick={onClick}>
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
