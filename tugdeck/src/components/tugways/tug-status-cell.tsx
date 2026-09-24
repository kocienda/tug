/**
 * TugStatusCell — one cell of the session card's Z2 telemetry status row.
 *
 * An instrument-readout cell: an IBM-1620-style endcap-rule legend
 * (`label`) above a centered value (`children`). Activation fires
 * `onActivate`, which the Z2 status row uses to toggle the shared
 * `TugPlacard` open on this cell's detail surface. The cell is
 * **button-rooted** — the activatable element is a real `<button>`, not a
 * `<span>` — so keyboard activation and the focus ring come for free when
 * the row is later authored into a focus cycle. The placard's auto-dismiss
 * watcher is handed the one cell a placard was opened from and exempts that
 * node alone, so this component carries no trigger marker: the exemption is a
 * node the row names rather than a class of nodes every card matches.
 *
 * The button is `tabIndex={-1}` and focus-refusing
 * (`data-tug-focus="refuse"`): the cell is not a *native* Tab stop and
 * does not promote the responder chain on click. When a surrounding
 * surface authors it into a focus group (`focusGroup`), it registers as
 * a **leaf** cycle stop ([P10] revised): the engine drives DOM focus to
 * the cell button during the cycle walk (a `<button>` is programmatically
 * focusable even at `tabIndex={-1}`) and the cell wears the leaf focus
 * ring; Space/Enter fire `onActivate` on the native `<button>`. Absent a
 * group, the cell is reached only by pointer, exactly as the old `<span>`
 * trigger was.
 *
 * Faithful to the bespoke markup it replaces — the root keeps the
 * `session-telemetry-status-cell` / `session-telemetry-status-anchor` classes
 * and the `data-priority` width key; the value keeps the
 * `session-telemetry-status-value-wrap` wrapper. The per-priority width
 * (`--tugx-session-status-cell-width`), the hover affordance, and the
 * endcap apparatus all live in this component's own CSS [L20].
 *
 * Laws: [L06] appearance via CSS/DOM, never React state (hover, width,
 *       and container-collapse are all CSS);
 *       [L19] component-authoring file pair (`.tsx` + `.css`, `data-slot`);
 *       [L20] token sovereignty — the cell owns its width / anchor /
 *       endcap / value scope; the row keeps only its flex layout.
 *
 * @module components/tugways/tug-status-cell
 */

import "./tug-status-cell.css";

import React from "react";

import { useFocusable } from "./use-focusable";
import type { FocusPolicy } from "./focus-manager";

/**
 * IBM-1620-style endcap-rule label apparatus — a letterspaced uppercase
 * label inset into a horizontal rule terminated by short perpendicular
 * ticks at each end. The label visually divides the legend from the
 * value below without an explicit divider; the ticks point toward the
 * value (down when the label is above, up when below).
 *
 * Private to the cell — it has no other consumer and is meaningless on
 * its own. The apparatus fills whatever width its cell provides (via
 * `--tugx-session-status-cell-width`).
 */
function TugStatusCellLabel({
  label,
  ticksDirection,
}: {
  label: string;
  ticksDirection: "down" | "up";
}): React.ReactElement {
  return (
    <span
      className="session-telemetry-endcap-rule"
      data-ticks={ticksDirection}
      aria-hidden="true"
    >
      <span className="session-telemetry-endcap-tick session-telemetry-endcap-tick-left" />
      <span className="session-telemetry-endcap-rule-fill" />
      <span className="session-telemetry-endcap-label">{label}</span>
      <span className="session-telemetry-endcap-rule-fill" />
      <span className="session-telemetry-endcap-tick session-telemetry-endcap-tick-right" />
    </span>
  );
}

/** TugStatusCell props. */
export interface TugStatusCellProps {
  /**
   * Priority key — sets `data-priority`, which selects the cell's static
   * `--tugx-session-status-cell-width` and drives the container-query
   * collapse order. One of the row's cell ids (`state` / `time` /
   * `tokens` / `context` / `tasks` / `jobs`).
   */
  priority: string;
  /** Letterspaced uppercase legend rendered in the endcap-rule apparatus. */
  label: string;
  /**
   * Direction the endcap ticks extend (toward the value).
   * @default "down"
   */
  ticksDirection?: "down" | "up";
  /**
   * Activation handler — fired on click / Space / Enter. The Z2 status row
   * uses it to toggle the shared {@link TugPlacard} open on this cell's
   * detail surface.
   */
  onActivate?: () => void;
  /**
   * Marks the value as empty (`data-empty="true"` on the value wrap) so
   * the cell can read as a quiet placeholder. The TASKS cell uses this
   * when no tasks exist.
   */
  valueEmpty?: boolean;
  /** Accessible name for the cell button. */
  "aria-label"?: string;
  /** Native title tooltip for the cell button. */
  title?: string;
  /**
   * Author the cell into a focus group ([P10] revised) — when set, the
   * cell registers as a **leaf** cycle stop (its own Tab stop, like the
   * Z4B chips; no arrow-roving). Supplied by the surface that owns the
   * Tab order; omitted elsewhere.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
  /** Walk policy when registered (`accept` default; `skip` = a11y-only). */
  focusPolicy?: FocusPolicy;
  /** The centered value content (rendered inside the value wrap). */
  children: React.ReactNode;
}

/**
 * One Z2 status-row cell — an instrument readout that toggles the shared
 * placard on activation. See the module docstring for the focus /
 * faithfulness contract.
 */
export function TugStatusCell({
  priority,
  label,
  ticksDirection = "down",
  onActivate,
  valueEmpty,
  "aria-label": ariaLabel,
  title,
  focusGroup,
  focusOrder,
  focusPolicy,
  children,
}: TugStatusCellProps): React.ReactElement {
  // Leaf cycle-stop registration ([P10] revised). The registration is
  // keyed by `id` independent of the DOM ref, so we stamp
  // `data-tug-focusable` straight onto the button below. The engine
  // resolves the cell by that attribute, moves DOM focus to the
  // `<button>` during the cycle walk, and paints the leaf ring via the
  // global `[data-key-view-kbd]` rule.
  const cellFocusableId = React.useId();
  const registered = focusGroup !== undefined;
  useFocusable({
    id: cellFocusableId,
    group: focusGroup ?? "",
    order: focusOrder ?? 0,
    policy: focusPolicy,
    register: registered,
  });
  return (
    <button
      type="button"
      data-slot="tug-status-cell"
      className="session-telemetry-status-cell session-telemetry-status-anchor"
      data-priority={priority}
      // Not a *native* Tab stop and never steals the responder chain
      // on click; the engine drives DOM focus here during the cycle
      // walk (a `<button>` is programmatically focusable at -1). [L06]
      tabIndex={-1}
      data-tug-focus="refuse"
      // A status cell is a pure activation trigger — clicking it must not pull
      // card focus to the editor (the pane-focus-controller's activate →
      // apply-focus path). Without this, a click while focus-cycling would
      // flash the editor caret for the duration of the press, before the
      // surface opens. The opened surface itself owns focus while open.
      data-no-activate=""
      data-tug-focusable={registered ? cellFocusableId : undefined}
      onClick={onActivate}
      aria-label={ariaLabel}
      title={title}
    >
      <TugStatusCellLabel label={label} ticksDirection={ticksDirection} />
      <span
        className="session-telemetry-status-value-wrap"
        data-empty={valueEmpty ? "true" : undefined}
      >
        {children}
      </span>
    </button>
  );
}
