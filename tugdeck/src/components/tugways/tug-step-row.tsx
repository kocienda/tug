/**
 * TugStepRow — one step of a wizard-like checklist: a pulsing dot, a label, an
 * optional detail line or body, a trailing slot for whatever the host hangs on
 * the right, and an `edge` strip along the bottom of the plinth.
 *
 * The shape is ConfigureTug's, lifted whole so there is one row rather than a
 * copy per surface: a fixed-height rounded plinth on the transcript's block
 * surface ([D106]), the dot riding the label's baseline, the detail line
 * indented clear of the dot, and a pending row dimmed. The status→dot mapping
 * is the row's own ([D02]/[D106]) — `active` is the user's turn and does not
 * breathe, only `busy` does — so every checklist in the app says "waiting",
 * "working", "failed" and "done" the same way.
 *
 * `edge` is where a progress indicator goes, and the reason it exists is that a
 * signal about work in flight may cost no layout metric ([B01]): the strip is
 * absolutely positioned chrome on the plinth, so a row that gains one is the
 * same height as a row that has not. `body` is the other thing — a stacking
 * slot under the detail line, which ConfigureTug's file-chooser row uses and
 * answers for the height it costs by raising `--tugx-step-row-h` on that row.
 *
 * What the row does NOT decide is what rides in the trailing slot. ConfigureTug
 * puts a CTA there, or a green check on a settled step; the update surface puts
 * a smaller check and nothing else. That is a host's concern, so it arrives as
 * `action` and the row only gives it a place to stand.
 *
 * Laws: [L19] `.tsx`/`.css` pair, `data-slot`; [L20] owns `--tugx-step-row-*`,
 * including the row height, which a host scopes per row where one step carries
 * a control rather than a line of prose.
 *
 * @module components/tugways/tug-step-row
 */

import "./tug-step-row.css";

import type { ReactElement, ReactNode } from "react";

import {
  TugProgressIndicator,
  type TugProgressIndicatorRole,
  type TugProgressIndicatorState,
} from "./tug-progress-indicator";

/**
 * A step's lifecycle status, encoded by the left-hand pulsing dot ([D106]):
 * `pending` (dimmed), `active` (the user's turn — a CTA shows), `busy` (an
 * async action in flight), `error` (failed — a retry CTA shows), `done`.
 */
export type TugStepRowStatus =
  | "pending"
  | "active"
  | "busy"
  | "paused"
  | "error"
  | "done";

/** Dot diameter, mirrored by `--tugx-step-row-dot` in the stylesheet. */
export const TUG_STEP_ROW_DOT_SIZE = 14;

/** Map a step status onto the dot's role + state ([D02]/[D106]). */
export function tugStepRowDotVisual(status: TugStepRowStatus): {
  role: TugProgressIndicatorRole;
  state: TugProgressIndicatorState;
} {
  switch (status) {
    case "pending":
      return { role: "inherit", state: "stopped" };
    case "active":
      // The user's turn is not activity: a full, still blue dot. Only `busy`
      // breathes.
      return { role: "action", state: "paused" };
    case "busy":
      return { role: "agent", state: "running" };
    case "paused":
      // A held thing, and the indicator's own default for one: amber rather
      // than blue, because a step that stopped because the user said so is
      // not the step the flow is waiting on the user to start.
      return { role: "caution", state: "paused" };
    case "error":
      return { role: "danger", state: "aborted" };
    case "done":
      return { role: "success", state: "completed" };
  }
}

export function TugStepRow({
  stepKey,
  status,
  label,
  detail,
  body,
  action,
  edge,
  className,
}: {
  /** Written to `data-step`, so a host or a test can address one row. */
  stepKey?: string;
  status: TugStepRowStatus;
  label: string;
  /**
   * The line under the label. A node rather than a string so a host whose
   * detail changes faster than a render can paint it — a download's progress,
   * written onto a span from a store subscription ([L06]) — can put that span
   * here instead of waking React on every tick.
   */
  detail?: ReactNode;
  /** Content in the detail line's slot — a control rather than prose. */
  body?: ReactNode;
  /** The trailing slot: a CTA cluster, a check, or nothing. */
  action?: ReactNode;
  /**
   * A strip along the bottom of the plinth — a progress bar, typically. It is
   * chrome rather than content: absolutely positioned, out of the content
   * column, so filling it never changes the row's height ([B01]/[B02]).
   */
  edge?: ReactNode;
  className?: string;
}): ReactElement {
  const { role, state } = tugStepRowDotVisual(status);
  return (
    <li
      className={className ? `tug-step-row ${className}` : "tug-step-row"}
      data-slot="tug-step-row"
      data-step={stepKey}
      data-status={status}
    >
      <div className="tug-step-row-main">
        <div className="tug-step-row-headline">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={TUG_STEP_ROW_DOT_SIZE}
            role={role}
            state={state}
            className="tug-step-row-dot"
            aria-hidden
          />
          <span className="tug-step-row-label">{label}</span>
        </div>
        {detail && <span className="tug-step-row-detail">{detail}</span>}
        {body && <div className="tug-step-row-body">{body}</div>}
      </div>
      {action ? <div className="tug-step-row-action">{action}</div> : null}
      {edge ? <div className="tug-step-row-edge">{edge}</div> : null}
    </li>
  );
}
